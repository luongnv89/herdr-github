// The open pull requests and issues of the repo you're in, read with `gh` (GitHub)
// or `glab` (GitLab) on that space's machine: the Herdr app twin of the terminal
// panel (panel.js). It follows the focused pane. Click a row, or select it and
// press enter, to open it in your browser. On GitHub, each row's Resolve or Review
// button starts an agent on it, as the action's agent profile says (the ⚙ view).
// The rules for rows, forges and agent actions live in ./forge.js, the profiles in
// ./profiles.js (shared with the terminal panel); both are shared with the tests.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, theme, layout, window, run, home, readTextFile, writeTextFile, knownAgents, nextCommand } from "herdr";
import { LIMIT, STALE, IDD, ago, firstLine, FORGES, ACTIONS, pickHost, forgesFor, load, actionFor, promptFor, findSkill, cantRun, tabStart, pathTo, shown } from "./forge.js";
import {
  HARNESSES, HARNESS_NAMES, THINKING, ACTION_KEYS, DEFAULT_PROFILE, validateProfile, buildLaunch, storePath, emptyStore,
  parseStore, serializeStore, upsertProfile, removeProfile, assignProfile, parseMccEnv,
  PROMPT_TOKEN, PROMPT_LABELS, validatePrompt, expandPrompt, setPrompt, resolvePrompt, profileChoices, findChoice,
} from "./profiles.js";

const MOD = "herdr-github";
const icon = (name) => `mods/${MOD}/${name}.svg`;

const ACTION_LABELS = { resolve: "Resolve", review: "Review" };
// What OpenCode does with a model or thinking level, in the profiles module's words.
const OPENCODE_NOTE = buildLaunch({ id: "x", name: "x", harness: "opencode", model: "m" }, "x").warnings[0];
const describe = (p) => [HARNESS_NAMES[p.harness], p.model, p.thinking && `thinking ${p.thinking}`].filter(Boolean).join(" · ");
const parent = (file) => file.slice(0, file.lastIndexOf("/"));
// The profile form's fields, in the order ↑ and ↓ move through them; the others are
// choices, which ← and → step through.
const FORM_FIELDS = ["name", "id", "harness", "model", "thinking"];
const TEXT_FIELDS = ["name", "id", "model"];
// What an action sends with no custom prompt, as Claude Code takes it.
const DEFAULT_PROMPTS = Object.fromEntries(Object.values(ACTIONS).map((a) => [a.key, `/${a.skill} ${PROMPT_TOKEN}`]));
const PROMPT_TIP = `A custom prompt replaces the IDD skill: it is sent as written to every harness, with ${PROMPT_TOKEN} as the number. Empty sends the default.`;

// Where the panel looks: the focused terminal's folder and machine. While the
// panel itself (or another mod pane) has the keyboard, it keeps the last one.
function locate(last) {
  const f = focused();
  if (!f) return last;
  const space = spaces().find((s) => s.id === f.space) ?? spaces().find((s) => s.active);
  const pane = f.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane?.mod || (!f.pane && !f.terminal)) return last ?? (space ? { cwd: space.folder, on: space.machine ?? null, space: space.id, tab: f.tab, pane: null } : null);
  const on = !f.pane && f.terminal?.includes("/") ? f.terminal.split("/")[0] : space?.machine ?? null;
  return { cwd: pane?.cwd || f.cwd || space?.folder || null, on, space: space?.id ?? f.space, tab: pane?.tab ?? f.tab, pane: pane?.pane ?? null };
}
const keyOf = (loc) => JSON.stringify([loc?.cwd ?? null, loc?.on ?? null]);

// Herdr's GPUI has no line clamp: cut the text to about `lines` lines of `width` px
// at `size` px, ending in "…". Returns the text and how many lines it takes.
function clamp(text, lines, width, size) {
  const per = Math.max(10, Math.floor(width / (size * 0.58)) - 3), max = per * lines;
  let out = text;
  if (text.length > max) {
    const cut = text.slice(0, max - 1), space = cut.lastIndexOf(" ");
    out = (space > max * 0.7 ? cut.slice(0, space) : cut).trimEnd() + "…";
  }
  return { text: out, lines: Math.max(1, Math.min(lines, Math.ceil(out.length / per))) };
}

const TITLE_LH = 18, BODY_LH = 16, META_H = 16, PAD = 7, GAP = 4, ACT_H = 24;
// The profile menu: its title line, and a 24 px line per profile, 2 px apart, in a
// box with 4 px of padding and a 1 px border.
const MENU_TITLE_H = 16, MENU_ITEM_H = 24;
const menuHeight = (n) => 2 + 8 + MENU_TITLE_H + n * (MENU_ITEM_H + 2);

export default class GitHub extends View {
  init(_props, cx) {
    Object.assign(this, { prs: [], issues: [], errors: {}, repo: null, forge: null, root: null, error: null, loading: false, fetched: false, fetchedAt: 0, context: null });
    this.view = localStorage.getItem("view") === "issues" ? "issues" : "prs";
    this.sel = { prs: 0, issues: 0 };
    this.notice = null;
    this.acting = false;
    // The profile menu of a Resolve or Review press, while it's open: { view, number,
    // key, entries, sel, anchor }, anchor being "row" (under that row's button) or
    // "header" (under the header).
    this.menu = null;
    // The profiles view (⚙): null while the rows show.
    this.settings = null;
    // Each action's custom prompt as last read, for the buttons' tooltips.
    this.prompts = { resolve: null, review: null };
    this.forges = new Map();
    this.loc = locate(null);
    this.handle = cx.focus_handle();
    // The profile form's text fields, made once and refilled for each profile.
    this.inputFocus = null;
    this.inputs = {};
    for (const [key, placeholder] of [["name", "My profile"], ["id", "my-profile"], ["model", "harness default"]]) {
      const input = InputState.new({ placeholder });
      input.on("change", (_e, cx) => { if (this.settings?.form) { this.settings.form[key] = input.value(); this.settings.error = null; } cx.notify(); });
      input.on("submit", (_e, cx) => this.saveForm(cx));
      input.on("focus", (_e, cx) => {
        this.inputFocus = key;
        if (this.settings?.form) this.settings.field = FORM_FIELDS.indexOf(key);
        cx.notify();
      });
      input.on("blur", (_e, cx) => { if (this.inputFocus === key) this.inputFocus = null; cx.notify(); });
      this.inputs[key] = input;
    }
    // Each action's prompt, in the profiles view: made once, filled from the store
    // whenever the view reads it. Focused, it is "prompt-resolve" or "prompt-review".
    this.promptInputs = {};
    for (const action of ACTION_KEYS) {
      const input = InputState.new({ placeholder: `default: ${DEFAULT_PROMPTS[action]}` });
      input.on("change", (_e, cx) => { if (this.settings?.promptErrors) this.settings.promptErrors[action] = null; cx.notify(); });
      input.on("submit", (_e, cx) => this.savePrompt(action, cx));
      input.on("focus", (_e, cx) => { this.inputFocus = `prompt-${action}`; cx.notify(); });
      input.on("blur", (_e, cx) => { if (this.inputFocus === `prompt-${action}`) this.inputFocus = null; cx.notify(); });
      this.promptInputs[action] = input;
    }
    cx.spawn(async (cx) => { await this.readStore(); cx.notify(); });
    cx.timer.every(STALE, (cx) => { if (this.visible()) this.refresh(cx); });
    // keys.json can send "herdr-github:<command>": focus, refresh, resolve, settings.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        else if (c === "refresh") this.refresh(cx);
        else if (c === "resolve" || c === "review" || c === "act") { this.handle.focus(); this.act(cx, this.view, this.sel[this.view], "header"); }
        else if (c === "settings") { if (this.settings) this.closeSettings(cx); else { this.handle.focus(); this.openSettings(cx); } }
        cx.notify();
      }
    });
  }

  // This copy's block in the shown layout; null when it's a pane or an overlay.
  block() { return pathTo(layout(), MOD); }
  // Fetch only while the panel is on screen: a hidden copy keeps running.
  visible() { return shown(this.block()); }

  items(view = this.view) { return view === "prs" ? this.prs : this.issues; }
  selected() { return this.items()[this.sel[this.view]] ?? null; }
  action() { return actionFor(this.forge, this.view, this.selected()); }

  // From render, cx.notify() isn't allowed: render reads the new state right after.
  refresh(cx, fromRender = false) {
    if (this.loading) return;
    const loc = this.loc, context = keyOf(loc);
    if (context !== this.context) {
      Object.assign(this, { context, prs: [], issues: [], errors: {}, repo: null, root: null, forge: null, error: null, fetched: false, sel: { prs: 0, issues: 0 } });
    }
    this.fetchedAt = Date.now();
    if (!loc?.cwd) { this.error = "No folder"; if (!fromRender) cx.notify(); return; }
    const { cwd, on } = loc;
    const current = () => keyOf(this.loc) === context;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (!current()) return;
        if (top.code !== 0) { Object.assign(this, { repo: null, forge: null, root: null, prs: [], issues: [], error: "Not a git repository" }); return; }
        const root = top.stdout.trim();
        this.root = root;
        const host = pickHost((await exec("git", ["remote", "-v"], { cwd: root, on })).stdout);
        if (!current()) return;
        if (!host) { Object.assign(this, { repo: null, forge: null, prs: [], issues: [], error: "No GitHub or GitLab remote" }); return; }
        const cacheKey = `${on ?? ""}|${host}`, errors = [];
        for (const id of this.forges.has(cacheKey) ? [this.forges.get(cacheKey)] : forgesFor(host)) {
          const result = await load(FORGES[id], (cli, args) => exec(cli, args, { cwd: root, on }));
          if (!current()) return;
          if (result.error) { errors.push(result.error); continue; }
          this.forges.set(cacheKey, id);
          Object.assign(this, result, { forge: FORGES[id], error: null, fetched: true });
          for (const v of ["prs", "issues"]) this.sel[v] = Math.min(this.sel[v], Math.max(0, this[v].length - 1));
          return;
        }
        Object.assign(this, { repo: null, forge: null, errors: {}, prs: [], issues: [], error: errors.join(" · ") });
      } catch (e) {
        // exec rejects when git can't start there, or the machine can't be reached.
        if (current()) this.error = on ? `Can't reach ${on}: ${e?.message ?? e}` : `Can't read the repository: ${e?.message ?? e}`;
      } finally { this.loading = false; cx.notify(); }
    });
    if (!fromRender) cx.notify();
  }

  // Runs on this computer, so the browser is yours even for a space on another machine.
  openUrl(url, cx) {
    if (!url) return;
    this.notice = null;
    const p = window()?.platform;
    const [cmd, args] = p === "windows" ? ["cmd", ["/c", "start", "", url]] : [p === "macos" ? "open" : "xdg-open", [url]];
    cx.spawn(async (cx) => {
      let reason = null;
      try { const r = await exec(cmd, args); if (r.code !== 0) reason = firstLine(r.stderr) || `${cmd} exited ${r.code}`; }
      catch (e) { reason = `${cmd} not found: ${e?.message ?? e}`; }
      if (reason) { this.say("error", `Can't open it: ${reason}`, url); cx.notify(); }
    });
    cx.notify();
  }

  say(tone, text, url = null) { this.notice = { tone, text, url }; }

  pick(view, cx) {
    this.view = view;
    localStorage.setItem("view", view);
    cx.notify();
  }

  move(by, cx) {
    const items = this.items();
    if (!items.length) return;
    this.sel[this.view] = Math.max(0, Math.min(items.length - 1, this.sel[this.view] + by));
    cx.notify();
  }

  // A Resolve or Review button, the header's or a row's, and the a key: a new tab in
  // the space you're in runs the agent of the action's profile in the repo's folder,
  // with the skill and the number as its first message. With only the default
  // profile it starts at once; with more, a menu of them opens under the button
  // pressed (`anchor`: "row" or "header"), and the one you choose starts. One
  // launch, or one menu, at a time.
  act(cx, view = this.view, index = this.sel[view], anchor = "row") {
    const action = actionFor(this.forge, view, this.items(view)[index]);
    if (!action || this.acting || this.menu) return;
    this.sel[view] = index;
    // Busy while the store is read, so a second press opens no second menu.
    this.acting = true;
    cx.spawn(async (cx) => {
      try {
        // The store is read on every press: the terminal panel may have changed it.
        const { store } = await this.readStore();
        const { entries, sel } = profileChoices(store, action.key);
        if (entries.length === 1) return await this.launch(action, entries[0], resolvePrompt(store, action.key), cx);
        this.menu = { view, number: action.number, key: action.key, entries, sel, anchor };
      } catch (e) { this.say("error", `Can't start an agent: ${e?.message ?? e}`); }
      finally { this.acting = false; cx.notify(); }
    });
    cx.notify();
  }

  // The menu's entry `i`, chosen: the store is read again, so a profile deleted since
  // the menu opened, or a row gone in a refresh, starts nothing and says why. The
  // action's custom prompt goes with whichever profile it is.
  startChoice(i, cx) {
    const m = this.menu;
    if (!m || this.acting) return;
    this.menu = null;
    this.acting = true;
    cx.spawn(async (cx) => {
      try {
        const { store } = await this.readStore();
        const chosen = m.entries[i], profile = chosen ? findChoice(store, chosen.id) : null;
        const action = actionFor(this.forge, m.view, this.items(m.view).find((x) => x.number === m.number));
        if (!action) return this.say("error", `The ${ACTIONS[m.view].noun} #${m.number} isn't in the list any more, so nothing started.`);
        if (!profile) return this.say("error", `The profile ${chosen?.name ?? ""} isn't there any more, so nothing started: press a or ${action.label} to choose another.`);
        await this.launch(action, profile, resolvePrompt(store, m.key), cx);
      } catch (e) { this.say("error", `Can't start an agent: ${e?.message ?? e}`); }
      finally { this.acting = false; cx.notify(); }
    });
    cx.notify();
  }

  // Closes the menu, when it's open: true then. A click anywhere but on one of its
  // profiles does only this.
  closeMenu(cx) {
    if (!this.menu) return false;
    this.menu = null;
    cx.notify();
    return true;
  }

  // Keys while the menu is open: ↑↓ (or k and j) move, stopping at either end; enter
  // starts the one chosen; esc or q closes it. It takes every other key too, so esc
  // never reaches the rows' keys, which hide the panel.
  menuKey(k, cx) {
    const m = this.menu;
    if (k === "up" || k === "k") m.sel = Math.max(0, m.sel - 1);
    else if (k === "down" || k === "j") m.sel = Math.min(m.entries.length - 1, m.sel + 1);
    else if (k === "enter") this.startChoice(m.sel, cx);
    else if (k === "escape" || k === "q") this.menu = null;
    cx.notify();
  }

  // `profile` and `template` are what the store held when the action was chosen:
  // the profile to start, and its custom prompt, or null for the IDD skill's.
  async launch(action, profile, template, cx) {
    const what = `${action.noun} #${action.number}`, loc = this.loc, root = this.root, on = loc?.on ?? null;
    if (!root) return this.say("error", "No repository to work in");
    if (!loc?.space) return this.say("error", `No space to open a tab in. Click a pane, then ${action.label} again.`);
    // Checked before anything runs: an unchecked profile never reaches a command line.
    const invalid = validateProfile(profile);
    if (invalid.length) throw new Error(`Invalid profile: ${invalid.join("; ")}`);
    const harness = profile.harness, name = HARNESS_NAMES[harness];
    // So is a custom prompt, with the number in it. It is sent as written, so it
    // needs no skill: nothing looks for one.
    const custom = template === null ? null : expandPrompt(template, action.number);
    const bad = custom === null ? [] : validatePrompt(custom);
    if (bad.length) throw new Error(`Invalid prompt: ${bad.join("; ")}`);
    this.say("info", `Getting ${name} ready to ${action.key} ${what}…`); cx.notify();

    // Where the skills are: only the IDD skill's prompt needs them.
    let base = home(), io = null;
    if (custom === null) {
      if (on) {
        const r = await exec("printenv", ["HOME"], { on }).catch(() => null);
        base = r?.code === 0 ? r.stdout.trim() : null;
        if (!base) return this.say("error", `Can't find your home folder on ${on}`);
      }
      io = {
        home: base,
        read: (p) => readTextFile(p, { on }),
        dirs: async (p) => {
          const r = await exec("ls", ["-1", "-p", p], { on });
          return r.code === 0 ? r.stdout.split("\n").filter((l) => l.endsWith("/")).map((l) => `${p}/${l.slice(0, -1)}`) : [];
        },
      };
    }
    if (harness === "mcc") {
      // The Claude Code profile `mcc run` would start in this repo, and its folder:
      // its skills and plugins are the ones that count. With a custom prompt it is
      // run only to find out that mcc is there.
      let env;
      try { env = await exec("mcc", ["env", "-q", "--shell", "bash"], { cwd: root, on, timeout: 10000 }); }
      catch (e) {
        const why = cantRun("mcc", e);
        if (why !== "mcc isn't installed") return this.say("error", why);
        return this.say("error", `mcc isn't on your PATH${on ? ` on ${on}` : ""}: click ⚙ to pick another profile for ${action.label}, or install mcc.`);
      }
      if (io) {
        io.claudeDir = env.code === 0 ? parseMccEnv(env.stdout, base) : null;
        if (!io.claudeDir) {
          const why = env.code === 0 ? "mcc env didn't name a Claude Code folder" : `mcc env failed: ${firstLine(env.stderr) || `exit ${env.code}`}`;
          return this.say("error", `The ${action.skill} skill isn't found for mcc (${why}). Install the skills from:`, IDD);
        }
      }
    }
    let text = custom;
    if (text === null) {
      const skill = await findSkill(harness, action.skill, root, io);
      if (!skill) return this.say("error", `The ${action.skill} skill isn't installed for ${name}. Install the skills from:`, IDD);
      text = promptFor(harness, skill, action);
    }
    const plan = buildLaunch(profile, text);
    const note = plan.warnings.length ? ` (${plan.warnings.join("; ")})` : "";

    // mcc runs as its own command; any other agent as programs.json says to start it.
    let known = null;
    if (plan.mode === "agent") {
      known = (await knownAgents({ on }).catch(() => [])).find((k) => k.key === plan.kind) ?? null;
      if (known?.installed === false) return this.say("error", `${known.name ?? name} isn't installed${on ? ` on ${on}` : ""}: click ⚙ to pick another profile for ${action.label}, or install it.`);
    }
    const start = tabStart(plan, known?.run, text);
    this.say("info", `Starting ${name} to ${action.key} ${what}…`); cx.notify();
    run("tab.new", { space: loc.space, folder: root, argv: start.argv, ...(start.task ? { task: start.task } : {}), name: `${action.key}-${action.number}` });
    // The app doesn't say when mcc is ready: it may first ask about a usage limit.
    if (plan.mode === "command") {
      return this.say("info", `Opened mcc in a new tab to ${action.key} ${what}. If mcc asks something first, such as about a usage limit, answer it there; Claude Code then works on: ${text}`);
    }
    this.say("ok", `Started ${known?.name ?? name} in a new tab: ${text}${note}`);
  }

  // The profile store, read again on every use: the terminal panel may have changed
  // it. A file that can't be read is read only, so it's never overwritten.
  async readStore() {
    const file = storePath(home());
    let text = null, failed = null;
    try { text = await readTextFile(file); } catch (e) { failed = e?.message ?? String(e); }
    const parsed = parseStore(text);
    if (failed) { parsed.warnings.unshift(`Can't read ${file}: ${failed}`); parsed.readOnly = true; }
    this.prompts = { ...parsed.store.prompts };
    return { file, text: text ?? null, ...parsed };
  }

  // A Resolve or Review button's tooltip: what it sends, and where that is set.
  actTip(action) {
    return this.prompts[action.key]
      ? `Start an agent in a new tab with your ${PROMPT_LABELS[action.key]}, in place of the ${action.skill} skill (profile and prompt: ⚙)`
      : `Start an agent in a new tab with the ${action.skill} skill (its profile: ⚙)`;
  }

  // ── Profiles ──────────────────────────────────────────────────────────────
  // ⚙ (or s): the agent profiles, which one Resolve and Review start, and a form
  // to add or change one. The store is read when the view opens, and written only
  // while the file still holds what was read.

  openSettings(cx) {
    this.menu = null;
    const st = { mode: "list", sel: 0, field: 0, confirm: null, form: null, error: null, info: null, promptErrors: {}, saving: false, loading: true, file: null, text: null, store: emptyStore(), warnings: [], readOnly: true };
    this.settings = st;
    cx.spawn(async (cx) => {
      Object.assign(st, await this.readStore(), { loading: false });
      if (this.settings === st) this.seedPrompts();
      cx.notify();
    });
    cx.notify();
  }

  closeSettings(cx) {
    this.settings = null;
    this.handle.focus();
    cx.notify();
  }

  // Esc and Cancel: from the form (or a delete question) back to the list, from the
  // list back to the rows.
  settingsBack(cx) {
    const st = this.settings;
    if (!st) return;
    if (st.mode === "list" && !st.confirm) return this.closeSettings(cx);
    Object.assign(st, { mode: "list", form: null, confirm: null, error: null });
    this.handle.focus();
    cx.notify();
  }

  // Runs a change to the store and saves it. writeTextFile writes only while the file
  // holds what was read: a change made meanwhile, in the terminal panel say, isn't
  // overwritten, and the view reads the file again.
  change(fn, info, cx, after = null) {
    const st = this.settings;
    if (!st || st.saving || st.loading) return;
    let next;
    try {
      if (st.readOnly) throw new Error(`Not saved: ${st.warnings[0] ?? "the profiles file is read only"}`);
      next = fn(st.store);
    } catch (e) { Object.assign(st, { error: e?.message ?? String(e), info: null }); return cx.notify(); }
    const text = serializeStore(next);
    st.saving = true;
    cx.spawn(async (cx) => {
      try {
        if (st.text === null) await exec("mkdir", ["-p", parent(st.file)]).catch(() => null);
        await writeTextFile(st.file, text, st.text);
        Object.assign(st, { store: next, text, error: null, info });
        // The buttons' tooltips say what is sent now.
        this.prompts = { ...next.prompts };
        if (after) after();
      } catch (e) {
        const now = await this.readStore();
        if (now.text !== st.text) {
          Object.assign(st, now, { error: "The profiles changed elsewhere and were read again: make your change again", info: null });
          if (this.settings === st) this.seedPrompts();
        }
        else Object.assign(st, { error: `Can't save ${st.file}: ${e?.message ?? e}`, info: null });
      } finally { st.saving = false; cx.notify(); }
    });
    cx.notify();
  }

  editProfile(p, cx) {
    const st = this.settings;
    st.form = { prev: p?.id ?? null, name: p?.name ?? "", id: p?.id ?? "", harness: p?.harness ?? "mcc", model: p?.model ?? "", thinking: p?.thinking ?? "" };
    const values = { ...st.form };
    for (const key of ["name", "id", "model"]) this.inputs[key].set_value(values[key]);
    Object.assign(st.form, { name: values.name, id: values.id, model: values.model });
    Object.assign(st, { mode: "edit", field: 0, confirm: null, error: null, info: null });
    // The field exists only once the form is drawn: focus it again after that, as
    // Herdr's own mods do, unless you've clicked into a field meanwhile.
    this.inputs.name.focus();
    const form = st.form;
    cx.timer.after(600, () => { if (form && this.settings?.form === form && this.inputFocus === null) this.inputs.name.focus(); });
    cx.notify();
  }

  saveForm(cx) {
    const st = this.settings, f = st?.form;
    if (!f) return;
    const profile = { id: f.id.trim(), name: f.name.trim(), harness: f.harness, model: f.model.trim(), thinking: f.thinking };
    this.change((store) => upsertProfile(store, profile, f.prev), `Saved ${profile.name}`, cx, () => {
      if (st.form !== f) return;
      Object.assign(st, { mode: "list", form: null });
      this.handle.focus();
    });
  }

  // A harness or thinking level: only the values the profile can take.
  pickChoice(key, value, cx) {
    const st = this.settings, f = st?.form;
    if (!f) return;
    f[key] = value;
    st.field = FORM_FIELDS.indexOf(key);
    if (!["", ...THINKING[f.harness]].includes(f.thinking)) f.thinking = "";
    st.error = null;
    cx.notify();
  }

  // The profiles in the list, the default first, with the selection kept inside
  // it: a delete, or the file read again, can leave it past the end.
  entries() {
    const st = this.settings, list = [DEFAULT_PROFILE, ...st.store.profiles];
    st.sel = Math.max(0, Math.min(st.sel ?? 0, list.length - 1));
    return list;
  }

  deleteProfile(p, cx) {
    const st = this.settings;
    this.change((s) => removeProfile(s, p.id), `Deleted ${p.name}`, cx, () => { st.confirm = null; if (this.settings === st) this.entries(); });
  }

  // The prompt boxes, filled with what the store holds: empty for the default.
  seedPrompts() {
    const st = this.settings;
    for (const action of ACTION_KEYS) this.promptInputs[action].set_value(resolvePrompt(st.store, action) ?? "");
    st.promptErrors = {};
  }

  // A prompt box's enter or Save: its text, trimmed, becomes the action's prompt;
  // empty goes back to the default. Why it can't be used shows under the box.
  savePrompt(action, cx) {
    const st = this.settings;
    if (!st || st.mode !== "list" || st.loading) return;
    const text = this.promptInputs[action].value().trim(), label = ACTION_LABELS[action];
    try { setPrompt(st.store, action, text); }
    catch (e) { st.promptErrors = { ...st.promptErrors, [action]: e?.message ?? String(e) }; st.info = null; return cx.notify(); }
    st.promptErrors = { ...st.promptErrors, [action]: null };
    this.change((s) => setPrompt(s, action, text), text ? `${label} now sends: ${text}` : `${label} now sends the default: ${DEFAULT_PROMPTS[action]}`, cx, () => {
      if (this.settings === st) this.promptInputs[action].set_value(resolvePrompt(st.store, action) ?? "");
    });
  }

  assignTo(action, p, cx) {
    const st = this.settings;
    if ((st.store.assign[action] ?? DEFAULT_PROFILE.id) === p.id) { Object.assign(st, { error: null, info: `${ACTION_LABELS[action]} already starts ${p.name}` }); return cx.notify(); }
    this.change((s) => assignProfile(s, action, p.id), `${ACTION_LABELS[action]} now starts ${p.name}`, cx);
  }

  // ↑ and ↓ in the form: the next field, its text box focused, or a choice.
  moveField(by, cx) {
    const st = this.settings;
    st.field = (st.field + by + FORM_FIELDS.length) % FORM_FIELDS.length;
    const key = FORM_FIELDS[st.field];
    if (TEXT_FIELDS.includes(key)) this.inputs[key].focus(); else this.handle.focus();
    cx.notify();
  }

  // ← and → (or space) on a choice: the previous or next value it can take.
  stepChoice(by, cx) {
    const f = this.settings.form, key = FORM_FIELDS[this.settings.field];
    if (TEXT_FIELDS.includes(key)) return false;
    const values = key === "harness" ? HARNESSES : ["", ...THINKING[f.harness]];
    if (values.length < 2) return true;
    const at = Math.max(0, values.indexOf(f[key]));
    this.pickChoice(key, values[(at + by + values.length) % values.length], cx);
    return true;
  }

  // Keys in the profiles view, as in the terminal panel; true when one was used.
  // What you type into a text box stays there: q or j in a model name doesn't
  // close or move anything. Esc goes back, from the form (or a delete question)
  // to the list, from the list to the rows.
  settingsKey(k, m, cx) {
    const st = this.settings;
    // Esc in a prompt box leaves the box; the next one goes back to the rows.
    if (k === "escape" && st.mode === "list" && this.inputFocus?.startsWith("prompt-")) {
      this.inputFocus = null;
      this.handle.focus();
      cx.notify();
      return true;
    }
    if (k === "escape") { this.settingsBack(cx); return true; }
    if (st.mode === "edit") {
      if (k === "up" || k === "down") { this.moveField(k === "up" ? -1 : 1, cx); return true; }
      if (this.inputFocus !== null) return false;
      if (k === "left" || k === "right" || k === "space") return this.stepChoice(k === "left" ? -1 : 1, cx);
      if (k === "enter") { this.saveForm(cx); return true; }
      return false;
    }
    if (st.loading) return false;
    // ↑ and ↓ go from the last profile on to the prompt boxes, and back, as in the
    // terminal panel. Arrows only: j and k are text in a box.
    const box = this.inputFocus?.startsWith("prompt-") ? this.inputFocus.slice("prompt-".length) : null;
    if (!st.confirm && (k === "up" || k === "down") && (box || (k === "down" && st.sel === this.entries().length - 1))) {
      const next = ACTION_KEYS[(box ? ACTION_KEYS.indexOf(box) : -1) + (k === "up" ? -1 : 1)];
      if (next) this.promptInputs[next].focus();
      else if (k === "up") { this.inputFocus = null; this.handle.focus(); }
      cx.notify();
      return true;
    }
    // What you type into a prompt box stays there, enter included: it saves the box.
    if (box) return false;
    const list = this.entries(), p = list[st.sel], fixed = p.id === DEFAULT_PROFILE.id;
    // A delete question: y deletes, any other key keeps the profile.
    if (st.confirm) {
      const q = list.find((x) => x.id === st.confirm);
      if (k === "y" && q) this.deleteProfile(q, cx);
      else { st.confirm = null; cx.notify(); }
      return true;
    }
    const upper = (c) => k === c || (k === c.toLowerCase() && m.shift);
    if (k === "up" || k === "k") st.sel = Math.max(0, st.sel - 1);
    else if (k === "down" || k === "j") st.sel = Math.min(list.length - 1, st.sel + 1);
    else if (k === "n" && !m.shift) this.editProfile(null, cx);
    else if ((k === "e" && !m.shift) || k === "enter") {
      if (fixed) Object.assign(st, { error: "The default profile can't be changed: add your own with n", info: null });
      else this.editProfile(p, cx);
    } else if (k === "d" && !m.shift) {
      if (fixed) Object.assign(st, { error: "The default profile can't be deleted", info: null });
      else Object.assign(st, { confirm: p.id, error: null, info: null });
    } else if (upper("R")) this.assignTo("resolve", p, cx);
    else if (upper("V")) this.assignTo("review", p, cx);
    else return false;
    cx.notify();
    return true;
  }

  onKey(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    if (m.control || m.alt || m.platform || m.function) return;
    // The profiles view takes the keys while it's open, never the rows behind it.
    if (this.settings) {
      if (this.settingsKey(k, m, cx)) cx.stop_propagation();
      return;
    }
    // So does the profile menu.
    if (this.menu) {
      this.menuKey(k, cx);
      cx.stop_propagation();
      return;
    }
    // Any key clears a notice, except the progress of a launch still under way.
    if (this.notice && !(this.acting && this.notice.tone === "info")) this.notice = null;
    if (k === "up" || k === "k") this.move(-1, cx);
    else if (k === "down" || k === "j") this.move(1, cx);
    else if (k === "pageup") this.move(-5, cx);
    else if (k === "pagedown") this.move(5, cx);
    else if (k === "home" || (k === "g" && !m.shift)) this.move(-Infinity, cx);
    else if (k === "end" || k === "G" || (k === "g" && m.shift)) this.move(Infinity, cx);
    else if (k === "tab" || k === "left" || k === "right" || k === "h" || k === "l") this.pick(this.view === "prs" ? "issues" : "prs", cx);
    else if (k === "1") this.pick("prs", cx);
    else if (k === "2") this.pick("issues", cx);
    else if (k === "enter") this.openUrl(this.selected()?.url, cx);
    else if (k === "o") this.openUrl(this.repo?.url, cx);
    else if (k === "a") this.act(cx, this.view, this.sel[this.view], "header");
    else if (k === "s") this.openSettings(cx);
    else if (k === "r") this.refresh(cx);
    else if (k === "escape" || k === "q") {
      const id = this.block()?.at(-1)?.id;
      if (id) run("layout.hide", { id }); else run("pane.go", { direction: "left" });
    } else { cx.notify(); return; }
    cx.stop_propagation();
    cx.notify();
  }

  iconButton(t, id, name, tip, action, on = false) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(on ? t.foreground : t.dim)
      .when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((e, cx) => { if (!this.closeMenu(cx)) action(e, cx); }).tooltip(tip).child(svg(icon(name)).size(14));
  }

  // A small button: a choice (on when chosen), or an action (primary when it's the main one).
  chip(t, id, label, on, action, primary = false) {
    return div().id(id).h(24).px(8).flex_none().flex().items_center().rounded(6).cursor_pointer().text_size(11.5).border_1()
      .border_color(primary ? t.solid : on ? t.accent : t.border).bg(primary ? t.solid : on ? t.selected : t.background)
      .text_color(primary ? t.solid_foreground : on ? t.foreground : t.muted).hover((s) => (primary ? s.opacity(0.88) : s.bg(t.hover)))
      .on_click(action).child(label);
  }

  segment(t, view, label, count) {
    const on = this.view === view;
    return h_flex().id(`hg-${view}`).flex_1().h(28).gap(6).items_center().justify_center().rounded(7).cursor_pointer().text_size(12)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { if (!this.closeMenu(cx)) this.pick(view, cx); })
      .child(svg(icon(view === "prs" ? "pr" : "issue")).size(13))
      .child(label)
      .when(this.fetched && !this.errors[view], (el) => el.child(div().px(5).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child(String(count))));
  }

  // Title up to 2 lines, description up to 3, then the meta line, and on GitHub the
  // row's Resolve or Review button. 46 px of the panel's width go to its border, the
  // list's and row's padding, and the icon column.
  // With the profile menu open under its button, the row is that much taller.
  layoutRow(item, action = null, menu = null) {
    const width = (this.width ?? 368) - 46;
    const title = clamp(item.title || "", 2, width, 13);
    const body = item.body ? clamp(item.body, 3, width, 11.5) : { text: "No description", lines: 1 };
    return {
      title, body,
      height: PAD * 2 + title.lines * TITLE_LH + GAP + body.lines * BODY_LH + GAP + META_H + (action ? GAP + ACT_H : 0) + (menu ? GAP + menuHeight(menu.entries.length) : 0) + 2,
    };
  }

  // The profile menu: each profile, the action's own highlighted, and what it starts.
  // A press or click on one stops there, so the row's click doesn't run as well;
  // nor does one on the box around them.
  menuList(t) {
    const m = this.menu, label = ACTIONS[m.view].label;
    const hint = (p) => {
      const h = p.id === DEFAULT_PROFILE.id ? "default" : describe(p);
      return h && h !== p.name ? `${p.name} · ${h}` : p.name;
    };
    return v_flex().id("hg-menu").flex_none().gap(2).p(4).rounded(8).border_1().border_color(t.border).bg(t.raised)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => cx.stop_propagation())
      .child(div().h(MENU_TITLE_H).px(4).flex().items_center().text_size(11).text_color(t.dim).child(`${label} #${m.number} with`))
      .children(m.entries.map((p, i) => this.chip(t, `hg-menu-${i}`, hint(p), i === m.sel, (_e, cx) => {
        cx.stop_propagation();
        this.handle.focus();
        this.startChoice(i, cx);
      }).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).tooltip(describe(p))));
  }

  row(t, index, item, rowIcon, iconColor, meta, trailing) {
    const view = this.view, action = actionFor(this.forge, view, item);
    const menu = action && this.menu?.anchor === "row" && this.menu.view === view && this.menu.number === item.number ? this.menu : null;
    const { title, body, height } = this.layoutRow(item, action, menu), on = index === this.sel[view];
    return v_flex().id(`${view}-${item.number}`).h(height).flex_none().px(8).py(PAD).gap(GAP).rounded(7).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { if (this.closeMenu(cx)) return; this.sel[this.view] = index; this.openUrl(item.url, cx); })
      .tooltip(item.url || "Open in browser")
      .child(h_flex().gap(7).items_start()
        .child(svg(icon(rowIcon)).size(13).flex_none().mt(2).text_color(iconColor))
        .child(div().flex_1().min_w(0).line_height(`${TITLE_LH}px`).max_h(TITLE_LH * 2).overflow_hidden().font_medium().child(title.text)))
      .child(div().pl(20).line_height(`${BODY_LH}px`).max_h(BODY_LH * 3).overflow_hidden().text_size(11.5).text_color(item.body ? t.muted : t.dim).child(body.text))
      .child(h_flex().h(META_H).pl(20).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(meta))
        .children(trailing))
      // The row's own button acts on this row; its press and click stop here, so the
      // row's open-in-the-browser click doesn't run as well.
      .when(Boolean(action), (el) => el.child(h_flex().h(ACT_H).pl(20).items_center()
        .child(div().id(`hg-${view}-act-${item.number}`).h(ACT_H).px(8).flex_none().flex().items_center().rounded(6).cursor_pointer().text_size(11.5)
          .border_1().border_color(t.border).bg(this.acting ? t.raised : t.background).text_color(this.acting ? t.dim : t.foreground)
          .hover((s) => s.bg(t.hover))
          .tooltip(this.actTip(action))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.handle.focus(); if (!this.closeMenu(cx)) this.act(cx, view, index, "row"); })
          .child(`${action.label} #${action.number}`))))
      // Its profile menu, under its button.
      .when(Boolean(menu), (el) => el.child(div().pl(20).flex_none().child(this.menuList(t))));
  }

  prRow(t, p, i) {
    const review = { approved: ["Approved", t.ansi2], changes: ["Changes requested", t.ansi1], review: ["Review", t.muted] }[p.review];
    const trailing = [];
    if (p.draft) trailing.push(div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10).child("Draft"));
    if (review) trailing.push(div().flex_none().text_color(review[1]).child(review[0]));
    if (p.checks) trailing.push(div().flex_none().text_color(p.checks === "fail" ? t.ansi1 : p.checks === "pending" ? t.blocked : t.ansi2).child(p.checks === "fail" ? "✗" : p.checks === "pending" ? "●" : "✓"));
    trailing.push(div().flex_none().child(ago(p.updatedAt)));
    return this.row(t, i, p, "pr", p.draft ? t.dim : t.ansi2, [p.ref, p.author ?? "?", p.branch].filter(Boolean).join(" · "), trailing);
  }

  issueRow(t, x, i) {
    const trailing = (x.labels ?? []).slice(0, 3).map((l) => h_flex().flex_none().gap(4).items_center().max_w(90)
      .child(div().size(7).flex_none().rounded(4).bg(/^[0-9a-f]{6}$/i.test(l.color) ? `#${l.color}` : t.dim)).child(div().truncate().child(l.name)));
    trailing.push(div().flex_none().child(ago(x.updatedAt)));
    return this.row(t, i, x, "issue", t.ansi2, `${x.ref} · ${x.author ?? "?"}`, trailing);
  }

  // ── The profiles view ─────────────────────────────────────────────────────

  // A text field of the profile form. Its press stops here, so the panel doesn't
  // take the keyboard back from it.
  field(t, key, label) {
    return v_flex().gap(4)
      .child(div().text_size(11.5).text_color(t.dim).child(label))
      .child(div().id(`hg-field-${key}`).h(30).px(8).flex().items_center().rounded(6).border_1().cursor_text()
        .border_color(this.inputFocus === key ? t.accent : t.input).bg(t.background)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.inputs[key]).w_full().text_size(12.5).text_color(t.foreground)));
  }

  // A row of choices: only the values the profile can take.
  // The one the keys are on shows it: its label in the accent color, and a frame.
  choices(t, label, key, values, shownAs) {
    const f = this.settings.form, on = this.choiceFocused(key);
    return v_flex().gap(4)
      .child(div().text_size(11.5).text_color(on ? t.accent : t.dim).child(on ? `${label}  ·  ← → to change` : label))
      .child(h_flex().flex_wrap().gap(4).p(3).rounded(8).border_1().border_color(on ? t.accent : t.background)
        .children(values.map((v) => this.chip(t, `hg-${key}-${v || "default"}`, shownAs(v), f[key] === v, (_e, cx) => this.pickChoice(key, v, cx)))));
  }

  choiceFocused(key) {
    return this.settings?.form && FORM_FIELDS[this.settings.field] === key && this.inputFocus === null && this.handle.is_focused();
  }

  profileForm(t) {
    const st = this.settings, f = st.form;
    const levels = ["", ...THINKING[f.harness]];
    return v_flex().id("hg-profile-form").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(12)
      .child(this.field(t, "name", "Name"))
      .child(this.field(t, "id", "Id: lowercase letters, digits and -"))
      .child(this.choices(t, "Harness", "harness", HARNESSES, (h) => HARNESS_NAMES[h]))
      .child(this.field(t, "model", "Model (optional)"))
      .child(levels.length > 1
        ? this.choices(t, "Thinking (optional)", "thinking", levels, (v) => v || "harness default")
        : v_flex().gap(4).child(div().text_size(11.5).text_color(this.choiceFocused("thinking") ? t.accent : t.dim).child("Thinking"))
          .child(div().text_size(12).text_color(t.muted).child(`${HARNESS_NAMES[f.harness]} takes no thinking level`)))
      .when(f.harness === "opencode" && Boolean(f.model.trim() || f.thinking), (el) => el.child(div().text_size(12).text_color(t.blocked).child(OPENCODE_NOTE)))
      .when(Boolean(st.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(st.error)))
      .child(h_flex().gap(6)
        .child(this.chip(t, "hg-form-save", st.saving ? "Saving…" : "Save", false, (_e, cx) => this.saveForm(cx), true))
        .child(this.chip(t, "hg-form-cancel", "Cancel", false, (_e, cx) => this.settingsBack(cx))));
  }

  profileCard(t, p, index) {
    const st = this.settings, fixed = p.id === DEFAULT_PROFILE.id, on = index === st.sel;
    const using = ACTION_KEYS.filter((a) => (st.store.assign[a] ?? DEFAULT_PROFILE.id) === p.id);
    const buttons = st.confirm === p.id
      ? [
        div().text_size(12).text_color(t.blocked).child(`Delete ${p.name}?`),
        this.chip(t, `hg-del-yes-${p.id}`, "Delete", false, (_e, cx) => this.deleteProfile(p, cx), true),
        this.chip(t, `hg-del-no-${p.id}`, "Keep", false, (_e, cx) => { st.confirm = null; cx.notify(); }),
      ]
      : [
        ...ACTION_KEYS.map((a) => this.chip(t, `hg-use-${a}-${p.id}`, using.includes(a) ? `${ACTION_LABELS[a]} ✓` : `Use for ${ACTION_LABELS[a]}`, using.includes(a), (_e, cx) => {
          if (!using.includes(a)) this.assignTo(a, p, cx);
        })),
        ...(fixed ? [] : [
          this.chip(t, `hg-edit-${p.id}`, "Edit", false, (_e, cx) => this.editProfile(p, cx)),
          this.chip(t, `hg-del-${p.id}`, "Delete", false, (_e, cx) => { Object.assign(st, { confirm: p.id, error: null, info: null }); cx.notify(); }),
        ]),
      ];
    // A click anywhere on it selects it, for the keys.
    return v_flex().id(`hg-card-${p.id}`).flex_none().gap(6).px(10).py(8).rounded(7).border_1().border_color(using.length ? t.accent : t.border)
      .when(on, (el) => el.bg(t.selected)).on_click((_e, cx) => { st.sel = index; cx.notify(); })
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().font_medium().child(p.name))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(fixed ? "default" : p.id)))
      .child(div().text_size(11.5).text_color(t.muted).child(describe(p)))
      .child(h_flex().flex_wrap().gap(4).items_center().children(buttons));
  }

  // An action's prompt: a text box, empty for the default, its Save, and why it
  // can't be used under it. Its press stops here, so the panel doesn't take the
  // keyboard back from it.
  promptField(t, action) {
    const st = this.settings, why = st.promptErrors?.[action], key = `prompt-${action}`;
    return v_flex().gap(4)
      .child(div().text_size(11.5).text_color(this.inputFocus === key ? t.accent : t.dim).child(`${PROMPT_LABELS[action]} (optional)`))
      .child(h_flex().gap(6).items_center()
        .child(div().id(`hg-${key}`).flex_1().min_w(0).h(30).px(8).flex().items_center().rounded(6).border_1().cursor_text()
          .border_color(why ? t.ansi1 : this.inputFocus === key ? t.accent : t.input).bg(t.background)
          .tooltip(PROMPT_TIP)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.promptInputs[action]).w_full().text_size(12.5).text_color(t.foreground)))
        .child(this.chip(t, `hg-${key}-save`, "Save", false, (_e, cx) => this.savePrompt(action, cx))))
      .when(Boolean(why), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(why)));
  }

  profileList(t) {
    const st = this.settings;
    if (st.loading) return div().flex_1().p(14).text_color(t.dim).child("Reading the profiles…");
    return v_flex().id("hg-profile-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(6)
      .child(div().px(2).text_size(11.5).text_color(t.muted)
        .child("Resolve and Review each start the profile they use. Without one, Claude Code starts through mcc run."))
      .children(this.entries().map((p, i) => this.profileCard(t, p, i)))
      // What each action sends: the IDD skill, unless you write your own prompt.
      .child(v_flex().id("hg-prompts").flex_none().gap(8).px(10).py(8).rounded(7).border_1().border_color(t.border)
        .child(div().text_size(11.5).text_color(t.muted)
          .child(`Resolve and Review send the IDD skill with the number, unless you write your own prompt: ${PROMPT_TOKEN} becomes the issue's or pull request's number, and it is sent as written, to every harness, instead of the skill.`))
        .children(ACTION_KEYS.map((a) => this.promptField(t, a))))
      .child(h_flex().gap(6).items_center()
        .child(this.chip(t, "hg-new", "New profile", false, (_e, cx) => this.editProfile(null, cx)))
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(st.file ?? "")));
  }

  render(cx) {
    const loc = locate(this.loc);
    if (keyOf(loc) !== keyOf(this.loc) || loc?.tab !== this.loc?.tab || loc?.pane !== this.loc?.pane) this.loc = loc;
    if (this.visible() && (keyOf(this.loc) !== this.context || Date.now() - this.fetchedAt > STALE)) this.refresh(cx, true);
    const t = theme(), view = this.view, items = this.items(), focused = this.handle.is_focused() || this.inputFocus !== null;
    // A menu whose row left the list, in a refresh, or of the other list, is closed:
    // nothing would show it, and it would keep the keys.
    if (this.menu && (this.menu.view !== view || !items.some((x) => x.number === this.menu.number))) this.menu = null;
    const st = this.settings, action = st ? null : this.action();
    const failed = this.error || this.errors[view];
    const empty = failed || (this.loading && !this.fetched ? "Loading…" : view === "prs" ? `No open ${this.forge?.pr ?? "pull request"}s` : "No open issues");
    const tones = { info: t.blocked, ok: t.ansi2, error: t.ansi1 };
    const title = !st ? this.repo?.name ?? this.forge?.name ?? "Pull requests and issues"
      : st.mode === "edit" ? (st.form.prev ? `Edit profile ${st.form.prev}` : "New profile") : "Agent profiles";
    const hints = this.menu && !st ? "↑↓ choose · ⏎ start · esc cancel"
      : !st ? `↑↓ select · ⏎ open · ${action ? `a ${action.key} · ` : ""}⇥ switch · s profiles · r refresh · o repo · esc close`
      : st.mode === "edit" ? `↑↓ field · ${this.inputFocus === null ? "←→ choose" : "type to edit"} · ⏎ save · esc back`
        : this.inputFocus?.startsWith("prompt-") ? "↑↓ prompts and profiles · type to edit · ⏎ save · esc back"
        : st.confirm ? "y delete · any other key keeps it"
          : "↑↓ select, then the prompts · n new · e edit · d delete · R/V assign · esc back";
    const status = st && st.mode === "list" ? [
      ...st.warnings.map((w) => [w, t.blocked]),
      ...(st.error ? [[st.error, t.ansi1]] : []),
      ...(st.info ? [[st.info, t.ansi2]] : []),
    ] : st ? st.warnings.map((w) => [w, t.blocked]) : [];

    return v_flex().id("herdr-github").track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
      .size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(focused ? t.accent : t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().pl(14).pr(8).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(title))
        .when(this.loading && !st, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(Boolean(action), (el) => el.child(div().id("hg-act").h(24).px(8).flex_none().flex().items_center().rounded(6).cursor_pointer().text_size(11.5)
          .bg(this.acting ? t.raised : t.solid).text_color(this.acting ? t.dim : t.solid_foreground)
          .tooltip(this.actTip(action))
          .on_click((_e, cx) => { cx.stop_propagation(); if (!this.closeMenu(cx)) this.act(cx, view, this.sel[view], "header"); }).child(`${action.label} #${action.number}`)))
        .child(this.iconButton(t, "hg-profiles", "gear", st ? "Back to the list" : "Agent profiles", (_e, cx) => (st ? this.closeSettings(cx) : this.openSettings(cx)), Boolean(st)))
        .when(!st, (el) => el.child(this.iconButton(t, "hg-refresh", "refresh", "Refresh", (_e, cx) => this.refresh(cx))))
        .when(!st && Boolean(this.repo?.url), (el) => el.child(this.iconButton(t, "hg-open", "external", `Open the repo on ${this.forge?.name ?? "the web"}`, (_e, cx) => this.openUrl(this.repo.url, cx)))))
      // The profile menu of the header's button (or the a key), under the header.
      .when(!st && this.menu?.anchor === "header", (el) => el.child(h_flex().flex_none().px(8).py(6).justify_end().border_b(1).border_color(t.border)
        .child(this.menuList(t))))
      .when(Boolean(st), (el) => el.child(st.mode === "edit" ? this.profileForm(t) : this.profileList(t))
        .when(status.length > 0, (el) => el.child(v_flex().flex_none().px(14).py(8).gap(4).border_t(1).border_color(t.border).text_size(12)
          .children(status.map(([text, color]) => div().text_color(color).child(text))))))
      .when(!st, (el) => el
        .child(h_flex().flex_none().p(6).gap(4).border_b(1).border_color(t.border)
          .child(this.segment(t, "prs", this.forge?.prs ?? "Pull requests", this.prs.length))
          .child(this.segment(t, "issues", "Issues", this.issues.length)))
        .child(div().flex_1().min_h(0).relative()
          .when(items.length > 0, (el) => el
            // A plain scroll area, not a virtual list: a virtual list's rows can't have
            // their own click handlers, and each row has two (open, and its button).
            // At most LIMIT rows, so drawing them all is cheap.
            .child(v_flex().id(`hg-list-${view}`).size_full().overflow_y_scroll().pt(6)
              .children(items.map((x, i) => div().pb(1).px(6).child(view === "prs" ? this.prRow(t, x, i) : this.issueRow(t, x, i)))))
            .child(Scrollbar.vertical(`hg-list-${view}`).viewport_from_layout().absolute().inset_0()))
          .when(!items.length, (el) => el.child(div().p(14).text_color(failed ? t.ansi1 : t.dim).child(empty))))
        .when(items.length >= LIMIT, (el) => el.child(div().flex_none().px(14).py(4).text_size(11).text_color(t.dim).child(`Showing the ${LIMIT} most recent`)))
        .when(Boolean(this.notice), (el) => el.child(v_flex().flex_none().px(14).py(8).gap(4).border_t(1).border_color(t.border).text_size(12)
          .child(div().text_color(tones[this.notice.tone] ?? t.foreground).child(this.notice.text))
          .when(Boolean(this.notice.url), (el) => el.child(div().id("hg-notice-url").text_color(t.accent).cursor_pointer().truncate()
            .on_click((_e, cx) => { if (!this.closeMenu(cx)) this.openUrl(this.notice.url, cx); }).child(this.notice.url))))))
      // The profiles view's keys wrap onto a second line rather than being cut.
      .child(div().flex_none().min_h(24).px(14).flex().items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(focused ? t.muted : t.dim)
        .when(!st, (el) => el.h(24).truncate()).when(Boolean(st), (el) => el.py(4))
        .child(focused ? hints : "Click here for keys"));
  }
}
