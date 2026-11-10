// The open pull requests and issues of the repo you're in, read with `gh` (GitHub)
// or `glab` (GitLab) on that space's machine: the Herdr app twin of the terminal
// panel (panel.js). It follows the focused pane. Click a row, or select it and
// press enter, to open it in your browser. The rules for rows, forges and agent
// actions live in ./forge.js, shared with the tests.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { spaces, panes, focused, agents, exec, theme, layout, window, run, home, readTextFile, knownAgents, nextCommand } from "herdr";
import { LIMIT, STALE, IDD, ago, firstLine, FORGES, pickHost, forgesFor, load, actionFor, isKind, promptFor, findSkill, pathTo, shown } from "./forge.js";

const MOD = "herdr-github";
const icon = (name) => `mods/${MOD}/${name}.svg`;

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

const TITLE_LH = 18, BODY_LH = 16, META_H = 16, PAD = 7, GAP = 4;

export default class GitHub extends View {
  init(_props, cx) {
    Object.assign(this, { prs: [], issues: [], errors: {}, repo: null, forge: null, root: null, error: null, loading: false, fetched: false, fetchedAt: 0, context: null });
    this.view = localStorage.getItem("view") === "issues" ? "issues" : "prs";
    this.sel = { prs: 0, issues: 0 };
    this.notice = null;
    this.acting = false;
    this.forges = new Map();
    this.loc = locate(null);
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    cx.timer.every(STALE, (cx) => { if (this.visible()) this.refresh(cx); });
    // keys.json can send "herdr-github:<command>": focus, refresh, resolve.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        else if (c === "refresh") this.refresh(cx);
        else if (c === "resolve" || c === "review" || c === "act") this.act(cx);
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

  refresh(cx) {
    if (this.loading) return;
    const loc = this.loc, context = keyOf(loc);
    if (context !== this.context) {
      Object.assign(this, { context, prs: [], issues: [], errors: {}, repo: null, root: null, forge: null, error: null, fetched: false, sel: { prs: 0, issues: 0 } });
    }
    this.fetchedAt = Date.now();
    if (!loc?.cwd) { this.error = "No folder"; cx.notify(); return; }
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
    cx.notify();
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
    this.scroll.scroll_to_item(this.sel[view]);
    cx.notify();
  }

  move(by, cx) {
    const items = this.items();
    if (!items.length) return;
    this.sel[this.view] = Math.max(0, Math.min(items.length - 1, this.sel[this.view] + by));
    this.scroll.scroll_to_item(this.sel[this.view]);
    cx.notify();
  }

  // The Resolve or Review button and the a key: a new tab in your agent's space runs
  // the same kind of agent in the repo's folder, with the skill and the number as its
  // first message. One launch at a time.
  act(cx) {
    const action = this.action();
    if (!action || this.acting) return;
    this.acting = true;
    cx.spawn(async (cx) => {
      try { await this.launch(action, cx); }
      catch (e) { this.say("error", `Can't start an agent: ${e?.message ?? e}`); }
      finally { this.acting = false; cx.notify(); }
    });
  }

  async launch(action, cx) {
    const what = `${action.noun} #${action.number}`, loc = this.loc, root = this.root, on = loc?.on ?? null;
    if (!root) return this.say("error", "No repository to work in");
    this.say("info", `Finding your agent to ${action.key} ${what}…`); cx.notify();
    // Your agent: the one in the focused pane, else the focused one in its tab, else any there.
    const list = agents().filter((a) => a.tab === loc?.tab);
    const agent = list.find((a) => a.pane === loc?.pane) ?? list.find((a) => a.focused) ?? list[0];
    if (!agent) return this.say("error", `No agent in this tab. Start yours (claude, codex, …) in a pane here, then ${action.label} again.`);
    const kind = agent.program?.key;
    if (!isKind(kind) || kind === "agent" || kind === "program") return this.say("error", "Herdr doesn't say which agent runs in this tab");

    let base = home();
    if (on) {
      const r = await exec("printenv", ["HOME"], { on }).catch(() => null);
      base = r?.code === 0 ? r.stdout.trim() : null;
      if (!base) return this.say("error", `Can't find your home folder on ${on}`);
    }
    const io = {
      home: base,
      read: (p) => readTextFile(p, { on }),
      dirs: async (p) => {
        const r = await exec("ls", ["-1", "-p", p], { on });
        return r.code === 0 ? r.stdout.split("\n").filter((l) => l.endsWith("/")).map((l) => `${p}/${l.slice(0, -1)}`) : [];
      },
    };
    const skill = await findSkill(kind, action.skill, root, io);
    if (!skill) return this.say("error", `The ${action.skill} skill isn't installed for ${kind}. Install the skills from:`, IDD);
    const text = promptFor(kind, skill, action);

    const known = await knownAgents({ on }).catch(() => []);
    const argv = known.find((k) => k.key === kind)?.run;
    if (!Array.isArray(argv) || !argv.length) return this.say("error", `Herdr doesn't know how to start ${kind}. Add it to programs.json with a "run".`);
    this.say("info", `Starting ${kind} to ${action.key} ${what}…`); cx.notify();
    run("tab.new", { space: agent.space, folder: root, argv, task: text, name: `${action.key}-${action.number}` });
    this.say("ok", `Started ${agent.program?.name ?? kind} in a new tab: ${text}`);
  }

  onKey(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    if (m.control || m.alt || m.platform || m.function) return;
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
    else if (k === "a") this.act(cx);
    else if (k === "r") this.refresh(cx);
    else if (k === "escape" || k === "q") {
      const id = this.block()?.at(-1)?.id;
      if (id) run("layout.hide", { id }); else run("pane.go", { direction: "left" });
    } else { cx.notify(); return; }
    cx.stop_propagation();
    cx.notify();
  }

  iconButton(t, id, name, tip, action) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action).tooltip(tip).child(svg(icon(name)).size(14));
  }

  segment(t, view, label, count) {
    const on = this.view === view;
    return h_flex().id(`hg-${view}`).flex_1().h(28).gap(6).items_center().justify_center().rounded(7).cursor_pointer().text_size(12)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pick(view, cx))
      .child(svg(icon(view === "prs" ? "pr" : "issue")).size(13))
      .child(label)
      .when(this.fetched && !this.errors[view], (el) => el.child(div().px(5).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child(String(count))));
  }

  // Title up to 2 lines, description up to 3, then the meta line. 46 px of the panel's
  // width go to its border, the list's and row's padding, and the icon column.
  layoutRow(item) {
    const width = (this.width ?? 368) - 46;
    const title = clamp(item.title || "", 2, width, 13);
    const body = item.body ? clamp(item.body, 3, width, 11.5) : { text: "No description", lines: 1 };
    return { title, body, height: PAD * 2 + title.lines * TITLE_LH + GAP + body.lines * BODY_LH + GAP + META_H + 2 };
  }

  row(t, index, item, rowIcon, iconColor, meta, trailing) {
    const { title, body, height } = this.layoutRow(item), on = index === this.sel[this.view];
    return v_flex().id(`${this.view}-${item.number}`).h(height).flex_none().px(8).py(PAD).gap(GAP).rounded(7).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.sel[this.view] = index; this.openUrl(item.url, cx); })
      .tooltip(item.url || "Open in browser")
      .child(h_flex().gap(7).items_start()
        .child(svg(icon(rowIcon)).size(13).flex_none().mt(2).text_color(iconColor))
        .child(div().flex_1().min_w(0).line_height(`${TITLE_LH}px`).max_h(TITLE_LH * 2).overflow_hidden().font_medium().child(title.text)))
      .child(div().pl(20).line_height(`${BODY_LH}px`).max_h(BODY_LH * 3).overflow_hidden().text_size(11.5).text_color(item.body ? t.muted : t.dim).child(body.text))
      .child(h_flex().h(META_H).pl(20).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(meta))
        .children(trailing));
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

  render(cx) {
    const loc = locate(this.loc);
    if (keyOf(loc) !== keyOf(this.loc) || loc?.tab !== this.loc?.tab || loc?.pane !== this.loc?.pane) this.loc = loc;
    if (this.visible() && (keyOf(this.loc) !== this.context || Date.now() - this.fetchedAt > STALE)) this.refresh(cx);
    const t = theme(), view = this.view, items = this.items(), action = this.action(), focused = this.handle.is_focused();
    const failed = this.error || this.errors[view];
    const empty = failed || (this.loading && !this.fetched ? "Loading…" : view === "prs" ? `No open ${this.forge?.pr ?? "pull request"}s` : "No open issues");
    const sizes = items.map((x) => this.layoutRow(x).height + 1);
    const tones = { info: t.blocked, ok: t.ansi2, error: t.ansi1 };
    const hints = `↑↓ select · ⏎ open · ${action ? `a ${action.key} · ` : ""}⇥ switch · r refresh · o repo · esc close`;

    return v_flex().id("herdr-github").track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
      .size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(focused ? t.accent : t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().pl(14).pr(8).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(this.repo?.name ?? this.forge?.name ?? "Pull requests and issues"))
        .when(this.loading, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(Boolean(action), (el) => el.child(div().id("hg-act").h(24).px(8).flex_none().flex().items_center().rounded(6).cursor_pointer().text_size(11.5)
          .bg(this.acting ? t.raised : t.solid).text_color(this.acting ? t.dim : t.solid_foreground)
          .tooltip(`Start your agent in a new tab with the ${action.skill} skill`)
          .on_click((_e, cx) => this.act(cx)).child(`${action.label} #${action.number}`)))
        .child(this.iconButton(t, "hg-refresh", "refresh", "Refresh", (_e, cx) => this.refresh(cx)))
        .when(Boolean(this.repo?.url), (el) => el.child(this.iconButton(t, "hg-open", "external", `Open the repo on ${this.forge?.name ?? "the web"}`, (_e, cx) => this.openUrl(this.repo.url, cx)))))
      .child(h_flex().flex_none().p(6).gap(4).border_b(1).border_color(t.border)
        .child(this.segment(t, "prs", this.forge?.prs ?? "Pull requests", this.prs.length))
        .child(this.segment(t, "issues", "Issues", this.issues.length)))
      .child(div().flex_1().min_h(0).relative()
        .when(items.length > 0, (el) => el
          .child(v_virtual_list(`hg-list-${view}`, items.length, sizes, (i) => `${view}-${items[i]?.number ?? i}`,
            (range) => items.slice(range.start, range.end).map((x, k) => {
              const i = range.start + k;
              return div().pb(1).px(6).child(view === "prs" ? this.prRow(t, x, i) : this.issueRow(t, x, i));
            })).track_scroll(this.scroll).size_full().pt(6))
          .child(Scrollbar.vertical(`hg-list-${view}`).viewport_from_layout().absolute().inset_0()))
        .when(!items.length, (el) => el.child(div().p(14).text_color(failed ? t.ansi1 : t.dim).child(empty))))
      .when(items.length >= LIMIT, (el) => el.child(div().flex_none().px(14).py(4).text_size(11).text_color(t.dim).child(`Showing the ${LIMIT} most recent`)))
      .when(Boolean(this.notice), (el) => el.child(v_flex().flex_none().px(14).py(8).gap(4).border_t(1).border_color(t.border).text_size(12)
        .child(div().text_color(tones[this.notice.tone] ?? t.foreground).child(this.notice.text))
        .when(Boolean(this.notice.url), (el) => el.child(div().id("hg-notice-url").text_color(t.accent).cursor_pointer().truncate()
          .on_click((_e, cx) => this.openUrl(this.notice.url, cx)).child(this.notice.url)))))
      .child(div().flex_none().h(24).px(14).flex().items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(focused ? t.muted : t.dim).truncate()
        .child(focused ? hints : "Click here for keys"));
  }
}
