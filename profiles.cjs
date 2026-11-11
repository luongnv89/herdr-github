// GENERATED from mods/herdr-github/profiles.js by scripts/sync-profiles.mjs. Do not edit: edit that
// file and run `node scripts/sync-profiles.mjs`.
"use strict";

// Agent profiles for the Resolve and Review actions: which harness starts, with
// which model and thinking level. Shared by the Herdr app mod (main.js) and the
// terminal panel (panel.js, through the generated ../../profiles.cjs). Plain
// JavaScript with no imports, so both load it, and `node --test` does too.
//
// Edit this file only, then run `node scripts/sync-profiles.mjs` to regenerate
// profiles.cjs; CI fails when the two differ.

// The harnesses a profile can start. "mcc" is Claude Code started by `mcc run`,
// which picks the Claude Code account (profile) set for the project.
const HARNESSES = ["mcc", "claude", "codex", "pi", "opencode"];
const HARNESS_NAMES = {
  mcc: "Claude Code via mcc run",
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  opencode: "OpenCode",
};

// The thinking levels each harness accepts. OpenCode has no flag for one when it
// starts interactively, so it takes none.
const THINKING = {
  mcc: ["low", "medium", "high", "xhigh", "max"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  opencode: [],
};

// The two actions a profile can be assigned to.
const ACTION_KEYS = ["resolve", "review"];

// What an action starts when no profile is assigned to it, or its profile is gone.
const DEFAULT_PROFILE = Object.freeze({ id: "default", name: "Claude Code via mcc run", harness: "mcc" });

// The newest store version this reads and writes. A store without custom prompts
// is still written as version 1, so an older panel can keep using it.
const STORE_VERSION = 2;
const READS = [1, 2];

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NAME = /^[^\x00-\x1f\x7f-\x9f\u2028\u2029]{1,40}$/;
// A model name or alias: no spaces, quotes or shell metacharacters, and no leading
// "-" that a harness would read as a flag. Aliases such as opus[1m] don't fit.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
// What a prompt can't hold: control, format (bidi, zero-width), private-use,
// unassigned and surrogate characters, line and paragraph separators, and the
// backslash, which some shells read inside quotes. Any other text is sent as is:
// it is one argument, never read by a shell (see shellQuote).
const PROMPT_BAD = /[\p{C}\u2028\u2029\\]/u;
// How long a prompt can be, with the number filled in.
const PROMPT_MAX = 500;
// Where a custom prompt takes the issue's or pull request's number.
const PROMPT_TOKEN = "{number}";
// A custom prompt's field, as the views name it and its reasons start ("Resolve prompt: …").
const PROMPT_LABELS = { resolve: "Resolve prompt", review: "Review prompt" };
const ALL_LEVELS = [...new Set(Object.values(THINKING).flat())];

const blank = (v) => v === undefined || v === null || v === "";

// Why a profile can't be used, as a list of messages; empty when it can.
function validateProfile(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["A profile must be an object"];
  const errors = [];
  if (typeof p.id !== "string" || !ID.test(p.id)) errors.push("Id: 1-32 lowercase letters, digits or -, not starting with -");
  if (typeof p.name !== "string" || !NAME.test(p.name) || !p.name.trim()) errors.push("Name: 1-40 printable characters");
  if (!HARNESSES.includes(p.harness)) errors.push(`Harness: one of ${HARNESSES.join(", ")}`);
  if (!blank(p.model) && (typeof p.model !== "string" || !MODEL.test(p.model))) {
    errors.push("Model: letters, digits and . _ : / @ + - only, starting with a letter or digit");
  }
  if (!blank(p.thinking)) {
    // OpenCode ignores the level, so any level of another harness is kept as is.
    const allowed = p.harness === "opencode" ? ALL_LEVELS : THINKING[p.harness] ?? [];
    if (typeof p.thinking !== "string" || !allowed.includes(p.thinking)) {
      errors.push(allowed.length ? `Thinking: one of ${allowed.join(", ")}` : "Thinking: not available for this harness");
    }
  }
  return errors;
}

// The profile's own fields, with an empty model or thinking level left out.
function normalizeProfile(p) {
  const out = { id: p.id, name: p.name, harness: p.harness };
  if (!blank(p.model)) out.model = p.model;
  if (!blank(p.thinking)) out.thinking = p.thinking;
  return out;
}

// ── Prompts ─────────────────────────────────────────────────────────────────
// Resolve and Review send the IDD skill's prompt, unless the store holds a custom
// one for the action: a template whose {number} becomes the row's number. Nothing
// else from the row (its title, its description) ever goes into a prompt.

// Why `text` can't be sent to an agent as its prompt, as a list of reasons; empty
// when it can. It is checked as sent, with the number filled in: the whole text,
// so nothing at either end that trimming would hide gets through.
function validatePrompt(text) {
  if (typeof text !== "string") return ["must be text"];
  const t = text.trim(), errors = [];
  if (!t) return ["can't be empty"];
  if (PROMPT_BAD.test(text)) errors.push("no control, invisible or private-use characters, line breaks or backslashes");
  else if (t !== text) errors.push("no spaces at either end");
  if (/^[-!#]/.test(t)) errors.push("can't start with -, ! or #");
  if ([...t].length > PROMPT_MAX) errors.push(`at most ${PROMPT_MAX} characters, with the number filled in`);
  return errors;
}

// Why a custom prompt can't be saved: it needs {number}, and must still be a valid
// prompt with the longest number filled in. Empty when it can.
function validatePromptTemplate(template) {
  if (typeof template !== "string") return ["must be text"];
  const errors = template.includes(PROMPT_TOKEN) ? [] : [`must contain ${PROMPT_TOKEN}, where the number goes`];
  return [...errors, ...validatePrompt(expandPrompt(template, Number.MAX_SAFE_INTEGER))];
}

// The prompt for one issue or pull request: each {number} in `template` becomes
// `number`, which must be a positive integer.
function expandPrompt(template, number) {
  if (typeof template !== "string") throw new Error("No prompt");
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("not a number");
  return template.replaceAll(PROMPT_TOKEN, String(number));
}

// How to start a profile's agent with `prompt`. Checks its input again, so an
// unchecked profile never reaches a command line:
//   { mode: "agent", kind, extraArgs, warnings } — herdr starts `kind` itself,
//     with extraArgs after `--`, and the prompt is sent once it is ready;
//   { mode: "command", argv, warnings } — the command to run, prompt last.
// An empty model or thinking level adds no flag: the harness's own default holds.
function buildLaunch(profile, prompt) {
  const errors = validateProfile(profile);
  if (errors.length) throw new Error(`Invalid profile: ${errors.join("; ")}`);
  const bad = validatePrompt(prompt);
  if (bad.length) throw new Error(`Invalid prompt: ${bad.join("; ")}`);
  const { harness } = profile, model = profile.model || "", thinking = profile.thinking || "";
  const flags = [], warnings = [];
  if (harness === "mcc" || harness === "claude") {
    if (model) flags.push("--model", model);
    if (thinking) flags.push("--effort", thinking);
  } else if (harness === "codex") {
    if (model) flags.push("-m", model);
    if (thinking) flags.push("-c", `model_reasoning_effort="${thinking}"`);
  } else if (harness === "pi") {
    if (model) flags.push("--model", model);
    if (thinking) flags.push("--thinking", thinking);
  } else if (harness === "opencode" && (model || thinking)) {
    // The consequence first: a notice cut short in a narrow pane still says it.
    warnings.push("OpenCode ignores this profile's model and thinking level: it has no flag for them when it starts");
  }
  if (harness === "mcc") return { mode: "command", argv: ["mcc", "run", "--", ...flags, prompt], warnings };
  return { mode: "agent", kind: harness, extraArgs: flags, warnings };
}

// ── The store: one JSON file shared by the terminal panel and the app ───────
//   { "version": 1, "profiles": [profile, …], "assign": { "resolve": id | null, "review": id | null } }
// With a custom prompt for either action, it is version 2, and also holds
//   "prompts": { "resolve": template | null, "review": template | null }
// A panel from before version 2 shows such a file read only, so never loses them.

// The same file on both surfaces, on the machine where herdr or the app runs.
function storePath(home) {
  if (typeof home !== "string" || !home) throw new Error("No home folder");
  return `${home.replace(/\/+$/, "")}/.config/herdr/plugins/config/herdr-github/profiles.json`;
}

function emptyStore() {
  return { version: STORE_VERSION, profiles: [], assign: { resolve: null, review: null }, prompts: { resolve: null, review: null } };
}

// The store in a file's text, read leniently: a bad profile or prompt is skipped
// with a warning. A file that isn't valid JSON, is from another version, or holds
// a profile or prompt that was skipped is read-only: saving would overwrite what
// it holds.
// No file (null or "") is an empty store.
function parseStore(text) {
  const warnings = [];
  if (text === null || text === undefined || String(text).trim() === "") return { store: emptyStore(), warnings, readOnly: false };
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    warnings.push("The profiles file isn't valid JSON. Fix or delete it to save profiles; until then the defaults apply");
    return { store: emptyStore(), warnings, readOnly: true };
  }
  let readOnly = false;
  if (!READS.includes(data.version)) {
    warnings.push(`The profiles file is version ${JSON.stringify(data.version ?? null)}, not ${READS.join(" or ")}: it is read only here`);
    readOnly = true;
  }
  const store = emptyStore();
  let skipped = data.profiles !== undefined && !Array.isArray(data.profiles);
  if (skipped) warnings.push("The profiles file's profiles aren't a list");
  (Array.isArray(data.profiles) ? data.profiles : []).forEach((raw, i) => {
    const label = typeof raw?.id === "string" && ID.test(raw.id) ? `"${raw.id}"` : `#${i + 1}`;
    const skip = (why) => { skipped = true; warnings.push(`Skipped profile ${label}: ${why}`); };
    const p = raw && typeof raw === "object" ? normalizeProfile(raw) : raw;
    const errors = validateProfile(p);
    if (errors.length) return skip(errors[0]);
    if (p.id === DEFAULT_PROFILE.id) return skip('the id "default" is reserved');
    if (store.profiles.some((q) => q.id === p.id)) return skip("its id is used twice");
    store.profiles.push(p);
  });
  for (const action of ACTION_KEYS) {
    const id = data.assign?.[action];
    if (id === null || id === undefined) continue;
    if (typeof id === "string" && store.profiles.some((p) => p.id === id)) store.assign[action] = id;
    else warnings.push(`The ${action} action's profile isn't there, so it uses the default`);
  }
  // A prompt that can't be used is skipped: its action sends the default prompt.
  let badPrompt = data.prompts !== undefined && data.prompts !== null && (typeof data.prompts !== "object" || Array.isArray(data.prompts));
  if (badPrompt) warnings.push("The profiles file's prompts aren't an object");
  else for (const action of ACTION_KEYS) {
    const raw = data.prompts?.[action];
    if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) continue;
    const why = typeof raw === "string" ? validatePromptTemplate(raw.trim()) : ["must be text"];
    if (!why.length) store.prompts[action] = raw.trim();
    else { badPrompt = true; warnings.push(`Skipped the ${PROMPT_LABELS[action]}: ${why[0]}`); }
  }
  // Saving would drop what was skipped, and the actions assigned to it: first say why
  // nothing is saved, as "Not saved: …" shows this first warning.
  if ((skipped || badPrompt) && !readOnly) {
    warnings.unshift(skipped
      ? "Some profiles in the file can't be used (see below), so it is read only here: fix or remove them to save"
      : "A prompt in the file can't be used (see below), so it is read only here: fix or remove it to save");
    readOnly = true;
  }
  return { store, warnings, readOnly };
}

// Version 1, as before custom prompts, unless the store holds one: then version 2,
// with its prompts.
function serializeStore(store) {
  const profiles = (store?.profiles ?? []).map(normalizeProfile);
  const assign = {}, prompts = {};
  for (const action of ACTION_KEYS) {
    assign[action] = store?.assign?.[action] ?? null;
    prompts[action] = resolvePrompt(store, action);
  }
  const data = ACTION_KEYS.some((a) => prompts[a] !== null) ? { version: 2, profiles, assign, prompts } : { version: 1, profiles, assign };
  return `${JSON.stringify(data, null, 2)}\n`;
}

// Adds a profile, or replaces the one with id `previousId` (keeping its
// assignments under a new id). Returns a new store; throws when it can't.
function upsertProfile(store, profile, previousId = null) {
  const p = normalizeProfile(profile ?? {});
  const errors = validateProfile(p);
  if (errors.length) throw new Error(errors.join("; "));
  if (p.id === DEFAULT_PROFILE.id) throw new Error('Id: "default" is reserved');
  const profiles = store.profiles.slice(), at = previousId === null ? -1 : profiles.findIndex((q) => q.id === previousId);
  if (profiles.some((q, i) => q.id === p.id && i !== at)) throw new Error(`Id: a profile "${p.id}" already exists`);
  const assign = { ...store.assign };
  if (at >= 0) {
    profiles[at] = p;
    for (const action of ACTION_KEYS) if (assign[action] === previousId) assign[action] = p.id;
  } else profiles.push(p);
  return { ...store, profiles, assign };
}

// Removes a profile; an action it was assigned to goes back to the default.
function removeProfile(store, id) {
  const assign = { ...store.assign };
  for (const action of ACTION_KEYS) if (assign[action] === id) assign[action] = null;
  return { ...store, profiles: store.profiles.filter((p) => p.id !== id), assign };
}

// Assigns a profile (null or "default" for the default) to "resolve" or "review".
function assignProfile(store, action, id) {
  if (!ACTION_KEYS.includes(action)) throw new Error(`No action ${action}`);
  const value = id === null || id === undefined || id === DEFAULT_PROFILE.id ? null : id;
  if (value !== null && !store.profiles.some((p) => p.id === value)) throw new Error(`No profile ${value}`);
  return { ...store, assign: { ...store.assign, [action]: value } };
}

// The profile an action starts: its assigned one, else the default.
function resolveProfile(store, action) {
  const id = store?.assign?.[action];
  return (id && store.profiles?.find((p) => p.id === id)) || DEFAULT_PROFILE;
}

// What Resolve or Review can start, for you to choose from: the default first, then
// your profiles in the store's order. `sel` is where the action's own profile is in
// that list, so it is the one a choice starts from; with none assigned, or its
// profile gone, that is the default (0). One entry means there is nothing to choose.
function profileChoices(store, action) {
  const entries = [DEFAULT_PROFILE, ...(store?.profiles ?? [])];
  const id = resolveProfile(store, action).id;
  return { entries, sel: Math.max(0, entries.findIndex((p) => p.id === id)) };
}

// The profile with id `id` in the store as it is now: the default for "default",
// else one of yours; null when there is none, as when it was deleted after the
// choice was offered.
function findChoice(store, id) {
  if (id === DEFAULT_PROFILE.id) return DEFAULT_PROFILE;
  return store?.profiles?.find((p) => p.id === id) ?? null;
}

// Sets the custom prompt of "resolve" or "review", trimmed; empty text or null
// goes back to the default (the IDD skill). Returns a new store; throws, with the
// field's name first ("Resolve prompt: …"), when the prompt can't be used.
function setPrompt(store, action, text) {
  if (!ACTION_KEYS.includes(action)) throw new Error(`No action ${action}`);
  const t = typeof text === "string" ? text.trim() : text;
  let value = null;
  if (t !== null && t !== undefined && t !== "") {
    const errors = validatePromptTemplate(t);
    if (errors.length) throw new Error(errors.map((e) => `${PROMPT_LABELS[action]}: ${e}`).join("; "));
    value = t;
  }
  return { ...store, prompts: { resolve: null, review: null, ...store.prompts, [action]: value } };
}

// An action's custom prompt template, or null when it sends the default.
function resolvePrompt(store, action) {
  const v = store?.prompts?.[action];
  return typeof v === "string" && v ? v : null;
}

// ── Shell text ──────────────────────────────────────────────────────────────

// One word for a POSIX shell, whatever it holds: single-quoted, ' as '\''.
function shellQuote(word) {
  return `'${String(word).replace(/'/g, "'\\''")}'`;
}

// A command line for a POSIX shell, every word quoted.
function shellJoin(argv) {
  return argv.map(shellQuote).join(" ");
}

// The Claude Code config folder that `mcc run` would use, from the output of
// `mcc env -q --shell bash` run in the project: `export CLAUDE_CONFIG_DIR='<dir>'`,
// or `unset CLAUDE_CONFIG_DIR` for the default profile (~/.claude). Null otherwise.
function parseMccEnv(text, home) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const l = line.trim();
    const m = /^export CLAUDE_CONFIG_DIR='((?:[^']|'\\'')*)';?$/.exec(l);
    if (m) {
      const dir = m[1].replace(/'\\''/g, "'");
      return dir.startsWith("/") && !/[\x00-\x1f\x7f]/.test(dir) ? dir : null;
    }
    if (/^unset CLAUDE_CONFIG_DIR;?$/.test(l)) return typeof home === "string" && home ? `${home.replace(/\/+$/, "")}/.claude` : null;
  }
  return null;
}

// ── Refresh interval ────────────────────────────────────────────────────────

// Not a profile, but a setting both panels share the rules of (#44): how often a
// panel refreshes on its own while it's on screen, or "manual", only when you ask (the
// refresh button, r, the refresh command). Either way a new folder is read at once,
// so the lists are never another repo's. Each panel keeps its own choice, as it keeps
// the list it shows; t steps through them.
const REFRESH_CHOICES = ["30s", "1m", "5m", "15m", "manual"];
const DEFAULT_REFRESH = "1m";
const REFRESH_MS = { "30s": 30000, "1m": 60000, "5m": 300000, "15m": 900000 };
const REFRESH_WORDS = { "30s": "every 30 seconds", "1m": "every minute", "5m": "every 5 minutes", "15m": "every 15 minutes" };

// A kept choice, as read back from a file or the app's storage: the default unless
// it's one of the choices.
function parseRefresh(value) {
  const v = typeof value === "string" ? value.trim() : "";
  return REFRESH_CHOICES.includes(v) ? v : DEFAULT_REFRESH;
}

// The choice after this one, back to the first after the last.
function nextRefresh(choice) {
  return REFRESH_CHOICES[(REFRESH_CHOICES.indexOf(parseRefresh(choice)) + 1) % REFRESH_CHOICES.length];
}

// Whether the lists, read at fetchedAt, are due for a refresh at now. Never in manual.
function refreshDue(choice, fetchedAt, now) {
  const ms = REFRESH_MS[parseRefresh(choice)];
  return ms !== undefined && now - fetchedAt >= ms;
}

// The choice in a few characters, for the key hints and the app's header button.
function refreshLabel(choice) {
  const c = parseRefresh(choice);
  return c === "manual" ? "manual" : `every ${c}`;
}

// What the panel says when the choice changes.
function refreshNotice(choice) {
  const c = parseRefresh(choice);
  return c === "manual"
    ? "Refreshes only when you ask: r or the refresh button. A new folder still loads."
    : `Refreshes ${REFRESH_WORDS[c]} while on screen, and on r or the refresh button.`;
}

module.exports = { HARNESSES, HARNESS_NAMES, THINKING, ACTION_KEYS, DEFAULT_PROFILE, STORE_VERSION, PROMPT_MAX, PROMPT_TOKEN, PROMPT_LABELS, validateProfile, normalizeProfile, validatePrompt, validatePromptTemplate, expandPrompt, buildLaunch, storePath, emptyStore, parseStore, serializeStore, upsertProfile, removeProfile, assignProfile, resolveProfile, profileChoices, findChoice, setPrompt, resolvePrompt, shellQuote, shellJoin, parseMccEnv, REFRESH_CHOICES, DEFAULT_REFRESH, parseRefresh, nextRefresh, refreshDue, refreshLabel, refreshNotice };
