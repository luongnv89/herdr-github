// Agent profiles for the Resolve and Review actions: which harness starts, with
// which model and thinking level. Shared by the Herdr app mod (main.js) and the
// terminal panel (panel.js, through the generated ../../profiles.cjs). Plain
// JavaScript with no imports, so both load it, and `node --test` does too.
//
// Edit this file only, then run `node scripts/sync-profiles.mjs` to regenerate
// profiles.cjs; CI fails when the two differ.

// The harnesses a profile can start. "mcc" is Claude Code started by `mcc run`,
// which picks the Claude Code account (profile) set for the project.
export const HARNESSES = ["mcc", "claude", "codex", "pi", "opencode"];
export const HARNESS_NAMES = {
  mcc: "Claude Code via mcc run",
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  opencode: "OpenCode",
};

// The thinking levels each harness accepts. OpenCode has no flag for one when it
// starts interactively, so it takes none.
export const THINKING = {
  mcc: ["low", "medium", "high", "xhigh", "max"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  opencode: [],
};

// The two actions a profile can be assigned to.
export const ACTION_KEYS = ["resolve", "review"];

// What an action starts when no profile is assigned to it, or its profile is gone.
export const DEFAULT_PROFILE = Object.freeze({ id: "default", name: "Claude Code via mcc run", harness: "mcc" });

export const STORE_VERSION = 1;

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NAME = /^[^\x00-\x1f\x7f-\x9f\u2028\u2029]{1,40}$/;
// A model name or alias: no spaces, quotes or shell metacharacters, and no leading
// "-" that a harness would read as a flag. Aliases such as opus[1m] don't fit.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
// A prompt is built from a skill name and an integer: nothing else gets through.
const PROMPT = /^[A-Za-z0-9 _.:/#-]{1,200}$/;
const ALL_LEVELS = [...new Set(Object.values(THINKING).flat())];

const blank = (v) => v === undefined || v === null || v === "";

// Why a profile can't be used, as a list of messages; empty when it can.
export function validateProfile(p) {
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
export function normalizeProfile(p) {
  const out = { id: p.id, name: p.name, harness: p.harness };
  if (!blank(p.model)) out.model = p.model;
  if (!blank(p.thinking)) out.thinking = p.thinking;
  return out;
}

// How to start a profile's agent with `prompt`. Checks its input again, so an
// unchecked profile never reaches a command line:
//   { mode: "agent", kind, extraArgs, warnings } — herdr starts `kind` itself,
//     with extraArgs after `--`, and the prompt is sent once it is ready;
//   { mode: "command", argv, warnings } — the command to run, prompt last.
// An empty model or thinking level adds no flag: the harness's own default holds.
export function buildLaunch(profile, prompt) {
  const errors = validateProfile(profile);
  if (errors.length) throw new Error(`Invalid profile: ${errors.join("; ")}`);
  if (typeof prompt !== "string" || !PROMPT.test(prompt)) throw new Error("Invalid prompt");
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
    warnings.push("OpenCode has no model or thinking flag when it starts, so this profile's model and thinking level are ignored");
  }
  if (harness === "mcc") return { mode: "command", argv: ["mcc", "run", "--", ...flags, prompt], warnings };
  return { mode: "agent", kind: harness, extraArgs: flags, warnings };
}

// ── The store: one JSON file shared by the terminal panel and the app ───────
//   { "version": 1, "profiles": [profile, …], "assign": { "resolve": id | null, "review": id | null } }

// The same file on both surfaces, on the machine where herdr or the app runs.
export function storePath(home) {
  if (typeof home !== "string" || !home) throw new Error("No home folder");
  return `${home.replace(/\/+$/, "")}/.config/herdr/plugins/config/herdr-github/profiles.json`;
}

export function emptyStore() {
  return { version: STORE_VERSION, profiles: [], assign: { resolve: null, review: null } };
}

// The store in a file's text, read leniently: a bad profile is skipped with a
// warning. A file that isn't valid JSON, or is from another version, is read-only:
// saving would overwrite what it holds. No file (null or "") is an empty store.
export function parseStore(text) {
  const warnings = [];
  if (text === null || text === undefined || String(text).trim() === "") return { store: emptyStore(), warnings, readOnly: false };
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    warnings.push("The profiles file isn't valid JSON. Fix or delete it to save profiles; until then the defaults apply");
    return { store: emptyStore(), warnings, readOnly: true };
  }
  let readOnly = false;
  if (data.version !== STORE_VERSION) {
    warnings.push(`The profiles file is version ${JSON.stringify(data.version ?? null)}, not ${STORE_VERSION}: it is read only here`);
    readOnly = true;
  }
  const store = emptyStore();
  if (data.profiles !== undefined && !Array.isArray(data.profiles)) warnings.push("The profiles file's profiles aren't a list");
  (Array.isArray(data.profiles) ? data.profiles : []).forEach((raw, i) => {
    const label = typeof raw?.id === "string" && ID.test(raw.id) ? `"${raw.id}"` : `#${i + 1}`;
    const p = raw && typeof raw === "object" ? normalizeProfile(raw) : raw;
    const errors = validateProfile(p);
    if (errors.length) return warnings.push(`Skipped profile ${label}: ${errors[0]}`);
    if (p.id === DEFAULT_PROFILE.id) return warnings.push(`Skipped profile ${label}: the id "default" is reserved`);
    if (store.profiles.some((q) => q.id === p.id)) return warnings.push(`Skipped profile ${label}: its id is used twice`);
    store.profiles.push(p);
  });
  for (const action of ACTION_KEYS) {
    const id = data.assign?.[action];
    if (id === null || id === undefined) continue;
    if (typeof id === "string" && store.profiles.some((p) => p.id === id)) store.assign[action] = id;
    else warnings.push(`The ${action} action's profile isn't there, so it uses the default`);
  }
  return { store, warnings, readOnly };
}

export function serializeStore(store) {
  const profiles = (store?.profiles ?? []).map(normalizeProfile);
  const assign = {};
  for (const action of ACTION_KEYS) assign[action] = store?.assign?.[action] ?? null;
  return `${JSON.stringify({ version: STORE_VERSION, profiles, assign }, null, 2)}\n`;
}

// Adds a profile, or replaces the one with id `previousId` (keeping its
// assignments under a new id). Returns a new store; throws when it can't.
export function upsertProfile(store, profile, previousId = null) {
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
export function removeProfile(store, id) {
  const assign = { ...store.assign };
  for (const action of ACTION_KEYS) if (assign[action] === id) assign[action] = null;
  return { ...store, profiles: store.profiles.filter((p) => p.id !== id), assign };
}

// Assigns a profile (null or "default" for the default) to "resolve" or "review".
export function assignProfile(store, action, id) {
  if (!ACTION_KEYS.includes(action)) throw new Error(`No action ${action}`);
  const value = id === null || id === undefined || id === DEFAULT_PROFILE.id ? null : id;
  if (value !== null && !store.profiles.some((p) => p.id === value)) throw new Error(`No profile ${value}`);
  return { ...store, assign: { ...store.assign, [action]: value } };
}

// The profile an action starts: its assigned one, else the default.
export function resolveProfile(store, action) {
  const id = store?.assign?.[action];
  return (id && store.profiles?.find((p) => p.id === id)) || DEFAULT_PROFILE;
}

// ── Shell text ──────────────────────────────────────────────────────────────

// One word for a POSIX shell, whatever it holds: single-quoted, ' as '\''.
export function shellQuote(word) {
  return `'${String(word).replace(/'/g, "'\\''")}'`;
}

// A command line for a POSIX shell, every word quoted.
export function shellJoin(argv) {
  return argv.map(shellQuote).join(" ");
}

// The Claude Code config folder that `mcc run` would use, from the output of
// `mcc env -q --shell bash` run in the project: `export CLAUDE_CONFIG_DIR='<dir>'`,
// or `unset CLAUDE_CONFIG_DIR` for the default profile (~/.claude). Null otherwise.
export function parseMccEnv(text, home) {
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
