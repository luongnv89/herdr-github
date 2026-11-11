#!/usr/bin/env node
// The open pull requests and issues of the repo you're in, read with `gh` (GitHub)
// or `glab` (GitLab): the terminal twin of Whole Herdr's GitHub panel. It follows
// the last focused pane of its own tab. Enter or a click opens a row in the browser.
"use strict";
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// Agent profiles, shared with the Herdr app mod: generated from mods/herdr-github/profiles.js.
const P = require(path.join(__dirname, "profiles.cjs"));

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const SELF = process.env.HERDR_PANE_ID || null;
// Outside herdr (node panel.js) there is no state dir; never write into the plugin root.
const STATE = process.env.HERDR_PLUGIN_STATE_DIR || path.join(os.tmpdir(), "herdr-github");
const STALE = 120000;
const LIMIT = 50;
const POLL = 2000;

// ── Terminal ────────────────────────────────────────────────────────────────

const ESC = "\x1b[";
const sgr = (code) => (text) => `${ESC}${code}m${text}${ESC}0m`;
const bold = sgr("1"), muted = sgr("2"), dim = sgr("90"), green = sgr("32"), red = sgr("31"), yellow = sgr("33"), accent = sgr("36"), invert = sgr("7");
const rgb = (hex) => {
  const n = parseInt(hex, 16);
  return /^[0-9a-f]{6}$/i.test(hex) ? sgr(`38;2;${n >> 16};${(n >> 8) & 255};${n & 255}`) : dim;
};
// An OSC 8 hyperlink: the terminal opens it on the machine you're sitting at, so
// Ctrl-click (or Cmd-click) works even when the panel runs on a remote host. Only a
// plain http(s) URL becomes a link; added after fit and wrap, it takes no cells.
const linkable = (u) => typeof u === "string" && /^https?:\/\//i.test(u) && !/[\x00-\x1f\x7f-\x9f]/.test(u);
const link = (u, text) => linkable(u) ? `\x1b]8;;${u}\x1b\\${text}\x1b]8;;\x1b\\` : text;

// Display width of one code point: 0 for combining marks, 2 for wide CJK and emoji.
function cellWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}
const width = (text) => { let w = 0; for (const ch of text) w += cellWidth(ch.codePointAt(0)); return w; };

// Cut to `max` cells, ending in "…" when something was dropped.
function fit(text, max) {
  if (max <= 0) return "";
  if (width(text) <= max) return text;
  let out = "", w = 0;
  for (const ch of text) {
    const cw = cellWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    out += ch; w += cw;
  }
  return out + "…";
}

// Word-wrap to at most `lines` lines of `max` cells; the last kept line ends in "…".
function wrap(text, max, lines) {
  max = Math.max(2, max);
  const out = [];
  let line = "";
  const push = () => { out.push(line); line = ""; };
  for (let word of text.split(" ").filter(Boolean)) {
    if (out.length > lines) break;
    if (line && width(line) + 1 + width(word) <= max) { line += " " + word; continue; }
    if (line) push();
    while (width(word) > max) {
      let head = "";
      for (const ch of word) { if (width(head + ch) > max) break; head += ch; }
      out.push(head); word = word.slice(head.length);
    }
    line = word;
  }
  if (line) push();
  if (out.length <= lines) return out;
  const kept = out.slice(0, lines);
  kept[lines - 1] = fit(kept[lines - 1] + "…", max);
  return kept;
}

// ── Row data (the same rules as the app panel) ──────────────────────────────

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
}

// A PR's checks in one word: a failure beats pending beats pass.
const BAD = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];
function checks(rollup) {
  if (!rollup?.length) return null;
  if (rollup.some((c) => BAD.includes(c.conclusion) || BAD.includes(c.state))) return "fail";
  if (rollup.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED")) return "pending";
  return "pass";
}

// The first line of a CLI's error, past glab's boxed "ERROR" heading.
const firstLine = (text) => (text || "").split("\n").map((l) => l.trim()).find((l) => l && l !== "ERROR") ?? "";
// Terminal text must not carry control characters from a title or body.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const clean = (text) => (text || "")
  .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  })
  .replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\ufeff]+/g, " ");

// A PR or issue body as one line of prose: no template comments, headings,
// code blocks, images, link targets, list or emphasis marks.
function plain(md) {
  return clean((md || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?(details|summary|br|hr|img|picture|source|video|p|div|span|a|b|i|em|strong|sub|sup|code|pre|kbd|blockquote|center|table|thead|tbody|tr|td|th|ul|ol|li|h[1-6])\b[^>]*>/gi, " ")
    .replace(/^\s{0,3}#{1,6}\s.*$/gm, " ")
    .replace(/^\s*[-=|: ]{3,}\s*$/gm, " ")
    .replace(/^\s*(>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/\*+|__|~~|`|\|/g, ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

// ── Forges: GitHub through `gh`, GitLab through `glab` ──────────────────────
// Each turns its CLI's JSON into one shape the rows draw from:
//   repo  { name, url }
//   pr    { ref, number, title, body, author, branch, draft, review, checks, updatedAt, url }
//   issue { ref, number, title, body, author, labels: [{ name, color }], updatedAt, url }
// `number` is the bare number an agent is handed; `ref` is only for display.

const hex = (color) => (color || "").replace(/^#/, "");
const REVIEW = { APPROVED: "approved", CHANGES_REQUESTED: "changes", REVIEW_REQUIRED: "review" };
// GitLab's merge status says when changes are requested or approval is missing,
// but not when a merge request is approved; its pipeline isn't in the list output.
const MERGE_REVIEW = { requested_changes: "changes", not_approved: "review" };

const FORGES = {
  github: {
    name: "GitHub", cli: "gh", prs: "Pull requests", pr: "pull request",
    repoArgs: ["repo", "view", "--json", "nameWithOwner,url"],
    prArgs: ["pr", "list", "--limit", String(LIMIT), "--json", "number,title,body,author,isDraft,headRefName,updatedAt,url,reviewDecision,statusCheckRollup"],
    issueArgs: ["issue", "list", "--limit", String(LIMIT), "--json", "number,title,body,author,labels,updatedAt,url"],
    repo: (r) => ({ name: r.nameWithOwner, url: r.url }),
    toPr: (p) => ({
      ref: `#${p.number}`, number: p.number, title: clean(p.title), body: plain(p.body), author: p.author?.login, branch: p.headRefName,
      draft: Boolean(p.isDraft), review: REVIEW[p.reviewDecision] ?? null, checks: checks(p.statusCheckRollup),
      updatedAt: p.updatedAt, url: p.url,
    }),
    toIssue: (i) => ({
      ref: `#${i.number}`, number: i.number, title: clean(i.title), body: plain(i.body), author: i.author?.login,
      labels: (i.labels ?? []).map((l) => ({ name: l.name, color: hex(l.color) })), updatedAt: i.updatedAt, url: i.url,
    }),
  },
  gitlab: {
    name: "GitLab", cli: "glab", prs: "Merge requests", pr: "merge request",
    repoArgs: ["repo", "view", "--output", "json"],
    prArgs: ["mr", "list", "--per-page", String(LIMIT), "--order", "updated_at", "--output", "json"],
    issueArgs: ["issue", "list", "--per-page", String(LIMIT), "--order", "updated_at", "--output", "json"],
    // The lists carry label names only; the colors come from the project's labels.
    labelArgs: ["label", "list", "--per-page", "100", "--output", "json"],
    repo: (r) => ({ name: r.path_with_namespace, url: r.web_url }),
    toPr: (m) => ({
      ref: `!${m.iid}`, number: m.iid, title: clean(m.title), body: plain(m.description), author: m.author?.username, branch: m.source_branch,
      draft: Boolean(m.draft ?? m.work_in_progress), review: MERGE_REVIEW[m.detailed_merge_status] ?? null, checks: null,
      updatedAt: m.updated_at, url: m.web_url,
    }),
    toIssue: (i, colors = {}) => ({
      ref: `#${i.iid}`, number: i.iid, title: clean(i.title), body: plain(i.description), author: i.author?.username,
      labels: (i.labels ?? []).map((l) => (typeof l === "string" ? { name: l, color: hex(colors[l]) } : { name: l.name, color: hex(l.color) })),
      updatedAt: i.updated_at, url: i.web_url,
    }),
  },
};

// The host of a remote URL: https://host/x, ssh://git@host:22/x or git@host:x.
function remoteHost(url) {
  const m = /^[a-z][\w+.-]*:\/\/(?:[^@/]*@)?([^:/]+)/i.exec(url) || /^(?:[^@/]*@)?([^:/]+):/.exec(url);
  return m ? m[1].toLowerCase() : null;
}

// `git remote -v` → the host of origin, else of the first remote.
function pickHost(remotes) {
  const urls = new Map();
  for (const line of remotes.split("\n")) {
    const [name, url] = line.split(/\s+/);
    if (name && url && !urls.has(name)) urls.set(name, url);
  }
  const url = urls.get("origin") ?? urls.values().next().value;
  return url ? remoteHost(url) : null;
}

// The forges to try for a host, most likely first; a self-hosted name says neither.
function forgesFor(host) {
  if (host.includes("github")) return ["github"];
  if (host.includes("gitlab")) return ["gitlab"];
  return ["github", "gitlab"];
}

// Resolves for any exit code; rejects only when the program can't start or times out.
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 << 20, timeout: 60000, ...opts }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") reject(err);
      else resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

// ── State ───────────────────────────────────────────────────────────────────

const ui = {
  view: "prs", prs: [], issues: [], errors: {}, repo: null, forge: null, error: null,
  loading: false, fetched: false, fetchedAt: 0, context: null,
  sel: { prs: 0, issues: 0 }, top: { prs: 0, issues: 0 }, frame: 0,
  rows: [], buttons: [], visible: true, notice: null,
  root: null, tab: null, acting: null, settings: null,
  // The profile menu of a Resolve or Review press, while it's open: { view, number,
  // key, entries, sel, top, anchor }, anchor being "row" (under that row's button)
  // or "header" (under the header's).
  menu: null,
};
let cwd = process.env.HERDR_GITHUB_CWD || process.cwd();
let target = process.env.HERDR_GITHUB_PANE || null;

let registry = null;

// Follow the focused pane of our own tab; when we have focus, keep the last one.
async function locate() {
  if (!SELF) return;
  try {
    const r = await run(HERDR, ["api", "snapshot"], { timeout: 5000 });
    if (r.code !== 0) return;
    const snap = JSON.parse(r.stdout).result.snapshot;
    const me = snap.panes.find((p) => p.pane_id === SELF);
    if (!me) return;
    ui.tab = me.tab_id;
    const focused = snap.panes.find((p) => p.pane_id === snap.focused_pane_id);
    if (focused && focused.pane_id !== SELF && focused.tab_id === me.tab_id) target = focused.pane_id;
    const pane = snap.panes.find((p) => p.pane_id === target && p.tab_id === me.tab_id);
    if (pane?.cwd) cwd = pane.cwd;
    const ws = snap.workspaces.find((w) => w.workspace_id === me.workspace_id);
    ui.visible = Boolean(ws?.focused && ws.active_tab_id === me.tab_id);
  } catch {}
}

// How long a refresh may run before the panel stops waiting for it (#42): git
// rev-parse, git remote, then each forge's calls for an unknown host, four steps of at
// most run()'s 60 s timeout. Only a refresh that will never end runs longer. graceMs:
// how long a running refresh is left alone by the refresh button and r (#45), so
// pressing them again, or holding r, starts at most one refresh per grace instead of
// one per press. Tests shorten both. The app's mod has the same rule, in forge.js.
const REFRESH = { hungMs: 300000, graceMs: 3000 };

// Which refresh is the panel's own. begin() numbers a new refresh, or returns null
// while one is running that it mustn't replace:
//   - moved (a new folder): always replaces it; its answer isn't wanted any more.
//   - press (the refresh button, r, the refresh command): replaces it once it has run
//     graceMs, so a refresh that never ends is still replaced by the next press (#42).
//   - neither (the timer): replaces it only once it has hung.
// With none running, any of them starts one at once. Only the latest number is
// current, and only its end() says the spinner can stop, so a refresh that ends after
// another replaced it changes nothing.
function refreshGate() {
  let latest = 0, since = 0, running = false;
  return {
    begin(now, { press = false, moved = false } = {}, hungMs = REFRESH.hungMs, graceMs = REFRESH.graceMs) {
      if (running && !moved && now - since < (press ? graceMs : hungMs)) return null;
      running = true;
      since = now;
      return ++latest;
    },
    current: (n) => n === latest,
    end(n) {
      if (n !== latest) return false;
      running = false;
      return true;
    },
    get running() { return running; },
  };
}
const gate = refreshGate();

// force: the refresh button or r, which replace a running refresh once it has had
// its grace (#42, #45). A new folder replaces it at once: the old one's answer isn't
// wanted any more.
async function refresh(force = false) {
  const context = cwd, moved = context !== ui.context;
  // A refresh that never ends would otherwise keep the spinner on and stop every
  // later one, for good.
  const n = gate.begin(Date.now(), { press: force, moved });
  if (n === null) return;
  if (moved) {
    Object.assign(ui, { context, prs: [], issues: [], errors: {}, repo: null, root: null, forge: null, error: null, fetched: false, sel: { prs: 0, issues: 0 }, top: { prs: 0, issues: 0 } });
  }
  ui.fetchedAt = Date.now();
  if (!fs.existsSync(context)) {
    gate.end(n);
    Object.assign(ui, { loading: false, error: "Folder not found" });
    draw();
    return;
  }
  const live = () => gate.current(n) && cwd === context;
  ui.loading = true;
  draw();
  try {
    const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: context });
    if (!live()) return;
    if (top.code !== 0) { ui.repo = null; ui.error = "Not a git repository"; return; }
    const root = top.stdout.trim();
    ui.root = root;
    const host = pickHost((await run("git", ["remote", "-v"], { cwd: root })).stdout);
    if (!live()) return;
    if (!host) { Object.assign(ui, { repo: null, forge: null, prs: [], issues: [], error: "No GitHub or GitLab remote" }); return; }
    const errors = [];
    for (const id of forgeCache.has(host) ? [forgeCache.get(host)] : forgesFor(host)) {
      const result = await load(FORGES[id], root);
      if (!live()) return;
      if (result.error) { errors.push(result.error); continue; }
      forgeCache.set(host, id);
      Object.assign(ui, result, { forge: FORGES[id], error: null, fetched: true });
      for (const v of ["prs", "issues"]) ui.sel[v] = Math.min(ui.sel[v], Math.max(0, ui[v].length - 1));
      return;
    }
    Object.assign(ui, { repo: null, forge: null, errors: {}, prs: [], issues: [], error: errors.join(" · ") });
  } catch (e) {
    if (live()) ui.error = `Can't read the repository: ${e.message}`;
  } finally {
    // Only the latest refresh stops the spinner.
    if (gate.end(n)) ui.loading = false;
    draw();
  }
}

// Which forge answered for a host, so a self-hosted one isn't probed on every refresh.
const forgeCache = new Map();

// One forge's repo, pull requests and issues; { error } when its CLI can't read the repo.
async function load(forge, root) {
  const sh = (args) => run(forge.cli, args, { cwd: root }).catch((e) =>
    ({ code: -1, stderr: e.code === "ENOENT" ? `${forge.cli} isn't installed` : `Can't run ${forge.cli}: ${e.message}` }));
  const [repo, prs, issues, labels] = await Promise.all([
    sh(forge.repoArgs), sh(forge.prArgs), sh(forge.issueArgs), forge.labelArgs ? sh(forge.labelArgs) : null,
  ]);
  if (repo.code !== 0) return { error: firstLine(repo.stderr) || `Not a ${forge.name} repository` };
  const colors = {};
  // Label colors are a nicety: without them the dots are grey.
  try { if (labels?.code === 0) for (const l of JSON.parse(labels.stdout)) colors[l.name] = l.color; } catch {}
  const result = { repo: forge.repo(JSON.parse(repo.stdout)), errors: {}, prs: [], issues: [] };
  if (prs.code === 0) result.prs = JSON.parse(prs.stdout).map(forge.toPr); else result.errors.prs = firstLine(prs.stderr);
  if (issues.code === 0) result.issues = JSON.parse(issues.stdout).map((i) => forge.toIssue(i, colors)); else result.errors.issues = firstLine(issues.stderr);
  return result;
}

// A failed open shows the URL, so a panel without a browser (on a remote machine,
// say) never just does nothing. A success draws nothing.
let opens = 0;
function openUrl(url) {
  if (!url) return;
  if (ui.notice) { ui.notice = null; draw(); }
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  const seq = ++opens;
  let done = false;
  const fail = (reason) => {
    if (done || seq !== opens) return;
    done = true;
    ui.notice = { url, reason: clean(reason) };
    // Keep the selected row, and the URL under it, in view above the notice.
    ui.follow = true;
    draw();
  };
  try {
    spawn(cmd, [url], { stdio: "ignore" })
      .on("error", (e) => fail(e.code === "ENOENT" ? `${cmd} not found` : e.message))
      .on("exit", (code, signal) => { if (code !== 0) fail(code == null ? `${cmd} stopped by ${signal}` : `${cmd} exited ${code}`); })
      .unref();
  } catch (e) { fail(e.message); }
}

// ── Agent actions ───────────────────────────────────────────────────────────
// An issue can be handed to the issue-resolver skill, a pull request to
// issue-pr-review: a new pane below your agent (or the pane the panel follows)
// runs the agent of the action's profile, prompted with the skill and the bare
// number, nothing else from the row. With no profile assigned, Claude Code
// starts through `mcc run`.

const IDD = "https://luongnv.com/idd";
const ACTIONS = {
  issues: { label: "Resolve", key: "resolve", skill: "issue-resolver", noun: "issue" },
  prs: { label: "Review", key: "review", skill: "issue-pr-review", noun: "pull request" },
};
const isNumber = (n) => Number.isSafeInteger(n) && n > 0;

// Both skills drive `gh`, so the action is offered on GitHub only.
function actionFor(view, index = ui.sel[view]) {
  if (ui.forge !== FORGES.github) return null;
  const item = ui[view]?.[index];
  return item && isNumber(item.number) ? { ...ACTIONS[view], number: item.number } : null;
}

const readable = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const dirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)); } catch { return []; } };
const json = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const safeName = (n) => typeof n === "string" && /^[\w.-]+$/.test(n) ? n : null;
const pluginName = (dir) => safeName(json(path.join(dir, ".claude-plugin", "plugin.json"))?.name);
// Claude Code, started directly or by `mcc run`, takes a skill as a slash command.
const claudeStyle = (kind) => kind === "claude" || kind === "mcc";

// How to call `skill` for an agent of `kind` working in `root`: its name, or
// "plugin:name" when Claude has it only from a plugin; null when it isn't found.
// Folders are checked for every kind, since a wrong "not installed" is the worse mistake.
// `claudeDir` is the Claude Code config folder to look in: for mcc, the profile's
// folder that `mcc env` reports; ~/.claude when it isn't given.
function findSkill(kind, skill, root, claudeDir = null) {
  const home = os.homedir(), claude = claudeDir || path.join(home, ".claude");
  const folders = [".claude", ".agents", ".codex", `.${kind}`].flatMap((d) => [path.join(home, d, "skills"), ...(root ? [path.join(root, d, "skills")] : [])]);
  if (claudeStyle(kind)) folders.push(path.join(claude, "skills"));
  if (folders.some((f) => readable(path.join(f, skill, "SKILL.md")))) return skill;
  if (!claudeStyle(kind)) return null;
  // Claude plugins: the installed ones (installed_plugins.json) that settings.json
  // doesn't disable, each with <installPath>/skills/<skill>, and synced ones, laid
  // out as plugins/synced/<account>/<plugin>/<skill>. A cached copy alone doesn't count.
  const plugins = path.join(claude, "plugins");
  const enabled = { ...json(path.join(claude, "settings.json"))?.enabledPlugins };
  if (root) for (const f of ["settings.json", "settings.local.json"]) Object.assign(enabled, json(path.join(root, ".claude", f))?.enabledPlugins);
  const installed = Object.entries(json(path.join(plugins, "installed_plugins.json"))?.plugins ?? {})
    .filter(([key, list]) => enabled[key] !== false && Array.isArray(list))
    .flatMap(([key, list]) => list
      .filter((i) => typeof i?.installPath === "string" && (i.scope !== "project" && i.scope !== "local" || i.projectPath === root))
      .map((i) => [i.installPath, safeName(key.split("@")[0])]));
  const roots = [...installed, ...dirs(path.join(plugins, "synced")).flatMap(dirs).map((p) => [p, null])];
  for (const [dir, fallback] of roots) {
    if (![path.join(dir, "skills", skill), path.join(dir, skill)].some((d) => readable(path.join(d, "SKILL.md")))) continue;
    const name = pluginName(dir) ?? fallback;
    return name ? `${name}:${skill}` : skill;
  }
  return null;
}

// Built from the skill name and an integer only, or from your custom prompt
// (`template`) with its {number} filled in: never from a title or body.
function promptFor(kind, skill, action, template = null) {
  if (!isNumber(action.number)) throw new Error("not a number");
  if (template !== null) return P.expandPrompt(template, action.number);
  return claudeStyle(kind) ? `/${skill} ${action.number}` : `Use the ${skill} skill on ${action.noun} #${action.number}.`;
}

// herdr reports a failure as {"error":{"code","message"}}.
function herdrError(r, what) {
  for (const text of [r.stderr, r.stdout]) {
    try { const e = JSON.parse(text).error; if (e?.message) return { code: e.code, message: e.message }; } catch {}
  }
  return { code: null, message: firstLine(r.stderr) || firstLine(r.stdout) || `${what} exited ${r.code}` };
}

function say(tone, text, url = null) {
  ui.notice = { tone, text: clean(text), url };
  ui.follow = true;
  draw();
}

// An executable on PATH, found by looking at the folders: no shell runs.
function which(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    try { if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return file; } } catch {}
  }
  return null;
}

// The profile store, read again on every use: the app may have changed it.
function readStore() {
  const file = P.storePath(os.homedir());
  let text = null, failed = null;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") failed = e.message; }
  const parsed = P.parseStore(text);
  if (failed) { parsed.warnings.unshift(`Can't read ${file}: ${failed}`); parsed.readOnly = true; }
  return { file, text, ...parsed };
}

// A Resolve or Review button, the header's or a row's, and the a key. With only the
// default profile it starts at once; with more, it opens a menu of them under the
// button pressed (`anchor`: "row" or "header"), and the one you choose starts. One
// launch, or one menu, at a time.
function act(view = ui.view, index = ui.sel[view], anchor = "row") {
  const action = actionFor(view, index);
  if (!action || ui.acting || ui.menu) return ui.acting;
  const { store } = readStore();
  const { entries, sel } = P.profileChoices(store, action.key);
  if (entries.length === 1) return start(action, entries[0], P.resolvePrompt(store, action.key));
  ui.menu = { view, number: action.number, key: action.key, entries, sel, top: 0, anchor };
  ui.follow = true;
  draw();
  return ui.acting;
}

function start(action, profile, template) {
  ui.acting = launch(action, ui.root || cwd, profile, template)
    .catch((e) => say("error", `Can't start an agent: ${e.message}`))
    .finally(() => { ui.acting = null; });
  return ui.acting;
}

// The menu's entry `i`, chosen: the store is read again, so a profile deleted since
// the menu opened, or a row gone in a refresh, starts nothing and says why. The
// action's custom prompt goes with whichever profile it is.
function startChoice(i) {
  const m = ui.menu;
  if (!m || ui.acting) return ui.acting;
  ui.menu = null;
  const { store } = readStore();
  const chosen = m.entries[i], profile = chosen ? P.findChoice(store, chosen.id) : null;
  const index = ui[m.view].findIndex((x) => x.number === m.number);
  const action = index >= 0 ? actionFor(m.view, index) : null;
  if (!action) { gone(m); return null; }
  if (!profile) {
    say("error", `The profile ${chosen?.name ?? ""} isn't there any more, so nothing started: press a or ${action.label} to choose another.`);
    return null;
  }
  return start(action, profile, P.resolvePrompt(store, m.key));
}

// The menu's row left the list, in a refresh: nothing starts.
function gone(m) {
  const { noun } = ACTIONS[m.view];
  say("error", `The ${noun} #${m.number} isn't in the list any more, so nothing started.`);
}

function closeMenu() {
  ui.menu = null;
  draw();
}

// Keys and the mouse while the menu is open: ↑↓ (or k and j) move, stopping at either
// end; enter starts the one chosen; esc or q closes it, as does the wheel or a click
// anywhere but on a profile. Ctrl-C still closes the panel. Other keys do nothing.
function menuKey(m) {
  const k = m[0], menu = ui.menu;
  if (m[1] != null) {
    const button = Number(m[1]);
    if (button === 0 && m[4] === "M") click(Number(m[2]) - 1, Number(m[3]) - 1);
    else if (button === 64 || button === 65) closeMenu();
    return;
  }
  if (k === "\x03") return quit();
  if (UP.includes(k) || k === "k") menu.sel = Math.max(0, menu.sel - 1);
  else if (DOWN.includes(k) || k === "j") menu.sel = Math.min(menu.entries.length - 1, menu.sel + 1);
  else if (k === "\r" || k === "\n") return startChoice(menu.sel);
  else if (k === "\x1b" || k === "q") return closeMenu();
  else return;
  draw();
}

// How long a launch through mcc waits: for Claude Code to show up in the new pane,
// polling herdr's agent list, then for it to settle. Tests shorten these.
const TIMING = { pollMs: 500, appearMs: 60000, waitMs: 30000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `template` is the action's custom prompt, or null for the IDD skill's. A custom
// prompt is sent as written, so it needs no skill: nothing looks for one.
async function launch(action, root, profile, template = null) {
  // The profile is checked before anything runs: an unchecked one never reaches a command line.
  const invalid = P.validateProfile(profile);
  if (invalid.length) throw new Error(`Invalid profile: ${invalid.join("; ")}`);
  const harness = profile.harness, shown = P.HARNESS_NAMES[harness];
  // So is a custom prompt, with the number in it.
  const custom = template === null ? null : promptFor(harness, null, action, template);
  const bad = custom === null ? [] : P.validatePrompt(custom);
  if (bad.length) throw new Error(`Invalid prompt: ${bad.join("; ")}`);
  const what = `${action.noun} #${action.number}`;
  const herdr = (args, timeout) => run(HERDR, args, { timeout }).catch((e) =>
    ({ code: -1, stdout: "", stderr: e.code === "ENOENT" ? "herdr isn't installed" : e.message }));
  if (!target && !ui.tab) return say("error", `Open this panel in herdr to ${action.key} ${what} with an agent.`);
  const mcc = harness === "mcc" ? which("mcc") : null;
  if (harness === "mcc" && !mcc) {
    return say("error", `mcc isn't on your PATH: press s to pick another profile for ${action.label}, or install mcc.`);
  }
  say("info", `Finding where to ${action.key} ${what}…`);
  const list = await herdr(["agent", "list"], 10000);
  if (list.code !== 0) return say("error", `Can't list agents: ${herdrError(list, "herdr").message}`);
  let agents;
  try { agents = JSON.parse(list.stdout).result.agents ?? []; } catch { return say("error", "Can't read herdr's agent list"); }
  // The new pane goes below your agent: the one in the pane the panel follows, else
  // one in the panel's tab; with no agent there, below the pane the panel follows.
  const agent = agents.find((a) => a.pane_id === target) ?? agents.find((a) => ui.tab && a.tab_id === ui.tab && a.pane_id !== SELF);
  const anchor = agent?.pane_id ?? target;
  if (!anchor) return say("error", `No agent in this tab and no pane to start one next to. Click a pane here, then ${action.label} again.`);

  let claudeDir = null;
  if (harness === "mcc" && custom === null) {
    // The Claude Code profile `mcc run` would start in this repo, and its folder.
    const env = await run(mcc, ["env", "-q", "--shell", "bash"], { cwd: root, timeout: 10000 })
      .catch((e) => ({ code: -1, stdout: "", stderr: e.message }));
    claudeDir = env.code === 0 ? P.parseMccEnv(env.stdout, os.homedir()) : null;
    if (!claudeDir) {
      const why = env.code === 0 ? "mcc env didn't name a Claude Code folder" : `mcc env failed: ${firstLine(env.stderr) || `exit ${env.code}`}`;
      return say("error", `The ${action.skill} skill isn't found for mcc (${why}). Install the skills from:`, IDD);
    }
  }
  const skill = custom === null ? findSkill(harness, action.skill, root, claudeDir) : null;
  if (custom === null && !skill) return say("error", `The ${action.skill} skill isn't installed for ${shown}. Install the skills from:`, IDD);
  const text = custom ?? promptFor(harness, skill, action);
  const plan = P.buildLaunch(profile, text);
  const note = plan.warnings.length ? ` (${plan.warnings.join("; ")})` : "";

  say("info", `Starting ${shown} to ${action.key} ${what}…`);
  const split = await herdr(["pane", "split", anchor, "--direction", "down", "--cwd", root, "--no-focus"], 10000);
  let pane = null;
  try { const r = JSON.parse(split.stdout).result; pane = r?.pane?.pane_id ?? r?.pane_id ?? null; } catch {}
  if (split.code !== 0 || !pane) return say("error", `Can't open a pane for ${shown}: ${herdrError(split, "herdr").message}`);
  if (plan.mode === "command") return runMcc(herdr, pane, [mcc, ...plan.argv.slice(1)], text);

  const kind = plan.kind;
  const names = new Set(agents.map((a) => a.name).filter(Boolean));
  let name = `${action.key}-${action.number}`;
  for (let k = 2; names.has(name); k++) name = `${action.key}-${action.number}-${k}`;
  // herdr's own timeout first, so a slow start reads as herdr's reason. The extra
  // arguments come from the checked profile only.
  const extra = plan.extraArgs.length ? ["--", ...plan.extraArgs] : [];
  const start = await herdr(["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", "55000", ...extra], 60000);
  if (start.code !== 0) {
    const e = herdrError(start, "herdr");
    if (e.code !== "agent_not_ready") {
      await herdr(["pane", "close", pane], 5000);
      return say("error", `${shown} didn't start: ${e.message}`);
    }
    // Not ready means the agent is asking you something, such as whether you
    // trust the folder: keep the pane, wait for your answer, then send the prompt.
    say("info", `${shown} is asking you something in the new pane. Answer it, and the panel sends: ${text}`);
    const ready = await herdr(["agent", "wait", pane, "--until", "idle", "--timeout", String(ANSWER_MS)], ANSWER_MS + 5000);
    if (ready.code !== 0) return say("error", `${shown} isn't ready in the new pane. When it is, send it: ${text}`);
  }
  const sent = await submit(herdr, pane, text);
  if (sent) return say("error", `${shown} started, but ${sent} Send it yourself in the new pane: ${text}`);
  say("ok", `Started ${shown} in a new pane: ${text}${note}`);
}

// `mcc run -- … <prompt>` in the new pane: herdr types it into the pane's shell as
// one line, every word quoted, and Claude Code takes the prompt as its first
// message. mcc may first ask what to do about a usage limit, so the launch counts
// as started only once herdr sees Claude Code there, idle or working.
async function runMcc(herdr, pane, argv, text) {
  const ran = await herdr(["pane", "run", pane, P.shellJoin(argv)], 10000);
  if (ran.code !== 0) {
    await herdr(["pane", "close", pane], 5000);
    return say("error", `Can't run mcc in the new pane: ${herdrError(ran, "herdr").message}`);
  }
  say("info", `Starting ${P.HARNESS_NAMES.mcc} in the new pane: ${text}`);
  const statusIn = async () => {
    const r = await herdr(["agent", "list"], 10000);
    if (r.code !== 0) return null;
    try { const a = (JSON.parse(r.stdout).result.agents ?? []).find((x) => x.pane_id === pane); return a ? String(a.agent_status ?? "unknown") : null; } catch { return null; }
  };
  const waiting = () => say("info", `Answer mcc in the new pane: it is waiting there, maybe asking about a usage limit. Claude Code then works on: ${text}`);
  const deadline = Date.now() + TIMING.appearMs;
  let found = await statusIn();
  while (found === null && Date.now() < deadline) {
    await sleep(TIMING.pollMs);
    found = await statusIn();
  }
  if (found === null) return waiting();
  const settled = await herdr(["agent", "wait", pane, "--until", "idle", "--until", "working", "--until", "blocked", "--timeout", String(TIMING.waitMs)], TIMING.waitMs + 5000);
  if (settled.code !== 0) return waiting();
  const status = await statusIn();
  if (status !== "idle" && status !== "working") return waiting();
  say("ok", `Started ${P.HARNESS_NAMES.mcc} in a new pane: ${text}`);
}

// How long the panel waits for you to answer an agent's startup question.
const ANSWER_MS = 300000;
const BUSY = ["--until", "working", "--until", "blocked", "--until", "done"];

// Types the prompt and checks that the agent took it. An agent can leave a typed
// prompt in its input box without acting on the Enter, most often right after a
// startup question; herdr then reports agent_prompt_stalled, and one more Enter
// sends it. Returns null once the agent is on it, else why not.
async function submit(herdr, pane, text) {
  const sent = await herdr(["agent", "prompt", pane, text, "--wait", ...BUSY, "--timeout", "15000"], 20000);
  if (sent.code === 0) return null;
  const e = herdrError(sent, "herdr");
  if (e.code !== "agent_prompt_stalled") return `the prompt failed (${e.message}).`;
  await herdr(["agent", "send-keys", pane, "enter"], 5000);
  const again = await herdr(["agent", "wait", pane, ...BUSY, "--timeout", "10000"], 15000);
  return again.code === 0 ? null : "it didn't act on the prompt.";
}

// ── Rendering ───────────────────────────────────────────────────────────────

// One row: the selection bar, a 1-cell icon, the title (2 lines), the description
// (3 lines) and the meta line, left text cut so the right-hand parts always fit.
// With an action, a Resolve or Review button follows on a line of its own; the
// lines then carry `hit`: { line, from, to }, where the button is.
function rowLines(item, selected, cols, icon, meta, trailing, action = null) {
  const inner = Math.max(10, cols - 5);
  const bar = selected ? accent("▌") : " ";
  const lines = [];
  wrap(item.title || "", inner, 2).forEach((t, i) => lines.push(`${bar} ${i ? " " : icon} ${link(item.url, selected ? bold(t) : t)}`));
  const body = item.body ? wrap(item.body, inner, 3).map(muted) : [dim("No description")];
  for (const b of body) lines.push(`${bar}   ${b}`);
  let parts = trailing.slice();
  const room = () => inner - parts.reduce((w, p) => w + p.w + 1, 0);
  while (parts.length > 1 && room() < 8) parts.splice(parts.length - 2, 1);
  const left = fit(meta, Math.max(0, room()));
  const pad = " ".repeat(Math.max(0, room() - width(left)));
  lines.push(`${bar}   ${dim(left)}${pad}${parts.map((p) => " " + p.s).join("")}`);
  if (action) {
    const label = ` ${fit(`${action.label} #${action.number}`, cols - 6)} `;
    lines.hit = { line: lines.length, from: 4, to: 4 + width(label) };
    lines.push(`${bar}   ${invert(label)}`);
  }
  // The selected row also shows its URL as plain text: herdr ignores OSC 8 links,
  // but Ctrl-click on a visible http(s) URL opens it on the machine you sit at.
  if (selected && linkable(item.url)) for (const l of urlLines(item.url, cols - 4)) lines.push(`${bar}   ${accent(l)}`);
  return lines;
}

// A URL as lines of at most `max` cells. herdr finds a plain URL only when it sits
// whole on one line, so a URL that has to wrap breaks right after its scheme: no
// line is then a cut-off URL that a Ctrl-click would open.
function urlLines(url, max) {
  const u = clean(url);
  if (width(u) <= max) return [u];
  const at = u.indexOf("://") + 3;
  return at > 2 && at <= max ? [u.slice(0, at), ...wrap(u.slice(at), max, Infinity)] : wrap(u, max, Infinity);
}

const part = (text, style = dim) => ({ w: width(text), s: style(text) });

const REVIEWS = { approved: ["Approved", green], changes: ["Changes requested", red], review: ["Review", muted] };

function prRow(p, selected, cols, action = null) {
  const review = REVIEWS[p.review];
  const trailing = [];
  if (p.draft) trailing.push(part("[Draft]"));
  if (review) trailing.push(part(review[0], review[1]));
  if (p.checks) trailing.push(p.checks === "fail" ? part("✗", red) : p.checks === "pending" ? part("●", yellow) : part("✓", green));
  trailing.push(part(ago(p.updatedAt)));
  return rowLines(p, selected, cols, p.draft ? dim("◌") : green("●"),
    [p.ref, p.author ?? "?", p.branch].filter(Boolean).join(" · "), trailing, action);
}

function issueRow(i, selected, cols, action = null) {
  const trailing = (i.labels ?? []).slice(0, 3).map((l) => {
    const name = fit(clean(l.name), 14);
    return { w: width(name) + 2, s: `${rgb(l.color)("●")} ${dim(name)}` };
  });
  trailing.push(part(ago(i.updatedAt)));
  return rowLines(i, selected, cols, green("◉"), `${i.ref} · ${i.author ?? "?"}`, trailing, action);
}

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const HINT = "Ctrl- or Cmd-click the URL to open it on your machine";

const TONES = { info: yellow, ok: green, error: red };

// A failed open, at most `room` lines: why, what to do instead, and the whole URL.
// An agent action's notice is its message, in the tone's color, and maybe a URL.
// The URL, what a Ctrl-click opens, gets its lines first, then the rule above the
// notice, then the message: whole when the room allows, cut ending in "…" when it
// doesn't, and left out when the room holds only the rule and the URL. Without a
// URL the message keeps at least a line.
function noticeLines(notice, cols, room) {
  room = Math.max(0, room);
  const { url } = notice, lines = [dim("─".repeat(cols))];
  const under = url ? urlLines(url, cols - 2).map((l) => " " + link(url, accent(l))) : [];
  if (under.length >= room) return under.slice(0, room);
  const most = url ? room - 1 - under.length : Math.max(1, room - 1);
  if (most > 0 && notice.tone) for (const l of wrap(notice.text, cols - 2, most)) lines.push(" " + TONES[notice.tone](l));
  else if (most > 0) {
    const why = wrap(notice.reason, cols - 2, most).map((l) => " " + red(l));
    const hint = most > why.length ? wrap(HINT, cols - 2, most - why.length) : [];
    lines.push(...why, ...hint.map((l) => " " + dim(l)));
  }
  lines.push(...under);
  return lines.slice(0, room);
}

// The profile menu as a box: its title on the top border, then one line per profile
// from `m.top`, `shown` of them, an arrow on a border when more are above or below.
// Each profile is its name, and what it starts when that fits beside it; the chosen
// one is marked ▸. At most `cols` cells wide. Returns { width, lines: [{ text, entry }] }.
function menuLines(m, cols, shown) {
  const title = `${ACTIONS[m.view].label} #${m.number} with`;
  const hint = (p) => {
    const h = p.id === P.DEFAULT_PROFILE.id ? "default" : describe(p);
    return h && h !== p.name ? h : "";
  };
  const full = (p) => width(p.name) + (hint(p) ? 3 + width(hint(p)) : 0), most = cols - 6;
  // As wide as the widest line it shows: a name without its hint when both don't fit.
  const tw = Math.max(1, Math.min(most, Math.max(width(title), ...m.entries.map((p) => full(p) <= most ? full(p) : width(p.name))))), w = tw + 6;
  const head = fit(title, w - 5);
  const lines = [{ text: dim(`┌ ${head} ${"─".repeat(Math.max(0, w - 5 - width(head)))}${m.top > 0 ? "↑" : "─"}┐`), entry: null }];
  for (let i = m.top; i < Math.min(m.entries.length, m.top + shown); i++) {
    const p = m.entries[i], on = i === m.sel, h = hint(p);
    const name = full(p) <= tw ? p.name : fit(p.name, tw);
    const text = (on ? bold(name) : name) + (full(p) <= tw && h ? dim(` · ${h}`) : "");
    const pad = " ".repeat(Math.max(0, tw - (full(p) <= tw ? full(p) : width(name))));
    lines.push({ text: `${dim("│")}${on ? accent(" ▸ ") : "   "}${text}${pad} ${dim("│")}`, entry: i });
  }
  lines.push({ text: dim(`└${"─".repeat(w - 3)}${m.top + shown < m.entries.length ? "↓" : "─"}┘`), entry: null });
  return { width: w, lines };
}

// The key hints while the menu is open: 33 cells, and 26 for a narrower pane.
const MENU_KEYS = " ↑↓ choose · ⏎ start · esc cancel", MENU_KEYS_SHORT = " ↑↓ · ⏎ start · esc cancel";

function draw() {
  const cols = process.stdout.columns || 60, rows = process.stdout.rows || 24;
  if (ui.settings) return paint(settingsLines(cols, rows), rows);
  const out = [];
  ui.buttons = [];

  // Header: repo, spinner, then the Resolve or Review button for the selected row,
  // and the profiles, refresh and open-on-the-forge buttons.
  const right = ui.repo?.url ? " ⚙  ↻  ↗ " : " ⚙  ↻ ";
  const action = actionFor(ui.view);
  const button = action ? ` ${action.label} #${action.number} ` : "";
  const spin = ui.loading ? yellow(SPIN[ui.frame % SPIN.length]) + " " : "";
  const title = fit(ui.repo?.name ?? ui.forge?.name ?? "Pull requests and issues", cols - width(right) - 3 - (button ? width(button) + 1 : 0) - (spin ? 2 : 0));
  const gap = " ".repeat(Math.max(0, cols - 1 - width(title) - (spin ? 2 : 0) - width(button) - width(right)));
  out.push(` ${link(ui.repo?.url, bold(title))}${gap}${spin}${button ? invert(button) : ""}${dim(right)}`);
  const at = cols - width(right);
  if (button) ui.buttons.push({ row: 0, from: at - width(button), to: at, action: () => act(ui.view, ui.sel[ui.view], "header") });
  ui.buttons.push({ row: 0, from: at, to: at + 3, action: () => openSettings() });
  ui.buttons.push({ row: 0, from: at + 3, to: at + 6, action: () => refresh(true) });
  if (ui.repo?.url) ui.buttons.push({ row: 0, from: at + 6, to: at + 9, action: () => openUrl(ui.repo.url) });
  out.push(dim("─".repeat(cols)));

  // The switch: Pull requests (or Merge requests) N / Issues N.
  const half = Math.floor(cols / 2);
  const segment = (view, label, count, w) => {
    const text = fit(ui.fetched && !ui.errors[view] ? `${label} ${count}` : label, w - 2);
    const padL = Math.floor((w - width(text)) / 2), padR = w - width(text) - padL;
    const cell = " ".repeat(padL) + text + " ".repeat(padR);
    return ui.view === view ? invert(bold(cell)) : muted(cell);
  };
  out.push(segment("prs", ui.forge?.prs ?? "Pull requests", ui.prs.length, half) + segment("issues", "Issues", ui.issues.length, cols - half));
  ui.buttons.push({ row: 2, from: 0, to: half, action: () => pick("prs") });
  ui.buttons.push({ row: 2, from: half, to: cols, action: () => pick("issues") });
  out.push(dim("─".repeat(cols)));

  // The list, scrolled so the selected row is in full view, above any notice.
  const notice = ui.notice ? noticeLines(ui.notice, cols, rows - out.length - 2) : [];
  const view = ui.view, items = ui[view], listTop = out.length, height = Math.max(1, rows - listTop - 1 - notice.length);
  const lines = [], owner = [], hits = [];
  let selStart = 0, selEnd = 0;
  items.forEach((x, i) => {
    if (i) { lines.push(""); owner.push(-1); }
    if (i === ui.sel[view]) selStart = lines.length;
    const a = actionFor(view, i), row = view === "prs" ? prRow(x, i === ui.sel[view], cols, a) : issueRow(x, i === ui.sel[view], cols, a);
    if (row.hit) hits[lines.length + row.hit.line] = { ...row.hit, index: i };
    for (const l of row) { lines.push(l); owner.push(i); }
    if (i === ui.sel[view]) selEnd = lines.length;
  });
  if (!items.length) {
    const msg = ui.error || ui.errors[view] || (ui.loading && !ui.fetched ? "Loading…" : view === "prs" ? `No open ${ui.forge?.pr ?? "pull request"}s` : "No open issues");
    for (const l of wrap(msg, cols - 2, height)) { lines.push(" " + (ui.error || ui.errors[view] ? red(l) : dim(l))); owner.push(-1); }
  } else if (items.length >= LIMIT) {
    lines.push("", " " + dim(`Showing the ${LIMIT} most recent`)); owner.push(-1, -1);
  }
  if (ui.follow) {
    if (selStart < ui.top[view]) ui.top[view] = selStart;
    if (selEnd > ui.top[view] + height) ui.top[view] = Math.min(selStart, selEnd - height);
    ui.follow = false;
  }
  ui.top[view] = Math.max(0, Math.min(ui.top[view], lines.length - height));
  ui.rows = [];
  for (let r = 0; r < height; r++) {
    out.push(lines[ui.top[view] + r] ?? "");
    ui.rows[listTop + r] = owner[ui.top[view] + r] ?? -1;
    // A row's own Resolve or Review button acts on that row.
    const hit = hits[ui.top[view] + r];
    if (hit) ui.buttons.push({ row: listTop + r, from: hit.from, to: hit.to, action: () => { ui.sel[view] = hit.index; draw(); return act(view, hit.index, "row"); } });
  }

  // The profile menu, over the list: under the button pressed, or above it when
  // there's more room there. Only its profiles take a click while it's open.
  if (ui.menu) {
    const m = ui.menu, index = ui[m.view].findIndex((x) => x.number === m.number);
    if (m.view !== view || index < 0) { ui.menu = null; return gone(m); }
    // A row's button where it's drawn; the header's when the row's is out of view.
    let y = 0, x = button ? at - width(button) : cols;
    if (m.anchor === "row") {
      for (let r = 0; r < height; r++) {
        const hit = hits[ui.top[view] + r];
        if (hit?.index === index) { y = listTop + r; x = hit.from; break; }
      }
    }
    const n = m.entries.length, limit = listTop + height, below = limit - y - 1, above = y - 1;
    const down = y === 0 || below >= n + 2 || (above < n + 2 && below >= above);
    const shown = Math.max(1, Math.min(n, (down ? below : above) - 2));
    m.top = Math.max(0, Math.min(m.top, m.sel, n - shown), m.sel - shown + 1);
    const box = menuLines(m, cols, shown), left = Math.max(0, Math.min(x, cols - box.width));
    const first = down ? y + 1 : y - box.lines.length;
    ui.buttons = [];
    box.lines.forEach((l, k) => {
      const row = first + k;
      // Never over the header, the notice or the key hints, however short the pane.
      if (row < 1 || row >= limit) return;
      out[row] = " ".repeat(left) + l.text;
      if (l.entry !== null) ui.buttons.push({ row, from: left, to: left + box.width, action: () => startChoice(l.entry) });
    });
  }
  out.push(...notice);

  // The menu's hints, shorter when the pane is too narrow for them, so esc stays in view.
  const menuKeys = width(MENU_KEYS) <= cols ? MENU_KEYS : MENU_KEYS_SHORT;
  const keys = ui.menu ? menuKeys : ` ↑↓ select · ⏎ open · ${action ? `a ${action.key} · ` : ""}⇥ switch · s profiles · r refresh · o repo · q close`;
  out.push(dim(fit(keys, cols)));
  paint(out, rows);
}

function paint(out, rows) {
  let frame = `${ESC}?2026h`;
  out.slice(0, rows).forEach((l, i) => { frame += `${ESC}${i + 1};1H${l}${ESC}0m${ESC}K`; });
  process.stdout.write(frame + `${ESC}J${ESC}?2026l`);
}

// ── Profiles ────────────────────────────────────────────────────────────────
// s or the header's ⚙: the agent profiles, which one Resolve and Review start, and
// a form to add or change one; under them, the prompt each action sends. The store
// is read when the view opens, and written only while the file still holds what
// was read.

// `word` is how the profiles module names the field in its reasons ("Model: …").
const FIELDS = [
  { key: "name", label: "Name", word: "Name", max: 40 },
  { key: "id", label: "Id", word: "Id", max: 32, hint: "a-z 0-9 -" },
  { key: "harness", label: "Harness", word: "Harness" },
  { key: "model", label: "Model", word: "Model", max: 128, hint: "harness default" },
  { key: "thinking", label: "Thinking", word: "Thinking" },
];
// The form's label column: "▌ ", the widest label, a space.
const LABEL_W = Math.max(...FIELDS.map((f) => f.label.length)), VALUE_AT = LABEL_W + 3;
// A choice in `max` cells: its name is cut before the closing ›.
const choiceText = (name, max) => width(`‹ ${name} ›`) <= max ? `‹ ${name} ›` : `‹ ${fit(name, max - 4)} ›`;
const choices = (form, key) => key === "harness" ? P.HARNESSES : ["", ...P.THINKING[form.harness]];
// What OpenCode does with a model or thinking level, in the profiles module's words.
const OPENCODE_NOTE = P.buildLaunch({ id: "x", name: "x", harness: "opencode", model: "m" }, "x").warnings[0];
const entries = () => [P.DEFAULT_PROFILE, ...ui.settings.store.profiles];
const describe = (p) => [P.HARNESS_NAMES[p.harness], p.model, p.thinking && `thinking ${p.thinking}`].filter(Boolean).join(" · ");
const ACTION_LABELS = { resolve: "Resolve", review: "Review" };
// What an action sends with no custom prompt, as Claude Code takes it.
const DEFAULT_PROMPTS = Object.fromEntries(Object.values(ACTIONS).map((a) => [a.key, `/${a.skill} ${P.PROMPT_TOKEN}`]));
// A prompt's reasons start with its field's name ("Resolve prompt: …").
const PROMPT_FIELDS = P.ACTION_KEYS.map((a) => ({ key: "prompt", word: P.PROMPT_LABELS[a] }));

// `promptSel` is the action whose prompt row is selected, under the profiles; null
// while a profile is. `prompt` is the prompt being edited: { action, text }.
// `scroll` is how far the wheel moved the form or the prompt from where it shows.
function openSettings() {
  ui.settings = { mode: "list", sel: 0, promptSel: null, form: null, prompt: null, field: 0, scroll: 0, error: null, fieldErrors: {}, info: null, ...readStore() };
  draw();
}

function closeSettings() {
  ui.settings = null;
  draw();
}

// The selected profile, with the selection kept inside the list: a delete, or the
// file read again, can leave it past the end.
function selectedEntry(st) {
  st.sel = Math.max(0, Math.min(st.sel, entries().length - 1));
  return entries()[st.sel];
}

// ✕ and Esc: from the form back to the list, from the list back to the rows.
function settingsBack() {
  const st = ui.settings;
  if (st.mode === "list") return closeSettings();
  Object.assign(st, { mode: "list", form: null, prompt: null, scroll: 0, error: null, fieldErrors: {} });
  draw();
}

// Writes the store through a temporary file, and only when the file still holds
// what was read: a change made meanwhile, in the app say, isn't overwritten.
function saveStore(next) {
  const st = ui.settings;
  if (st.readOnly) throw new Error(`Not saved: ${st.warnings[0] ?? "the profiles file is read only"}`);
  let now = null;
  try { now = fs.readFileSync(st.file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (now !== st.text) {
    Object.assign(st, readStore());
    selectedEntry(st);
    throw new Error("The profiles changed elsewhere and were read again: make your change again");
  }
  const text = P.serializeStore(next);
  fs.mkdirSync(path.dirname(st.file), { recursive: true });
  const tmp = `${st.file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, st.file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  Object.assign(st, { store: next, text });
}

// A reason from the profiles module, split by field: in the form, each field's
// own shows under that field, and only the rest in the status lines.
function splitErrors(message, inForm) {
  const fieldErrors = {}, rest = [];
  for (const part of inForm ? message.split("; ") : [message]) {
    const f = [...FIELDS, ...PROMPT_FIELDS].find((x) => part.startsWith(`${x.word}:`));
    if (f) fieldErrors[f.key] = fieldErrors[f.key] ? `${fieldErrors[f.key]}; ${part}` : part;
    else rest.push(part);
  }
  return { fieldErrors, error: rest.length ? rest.join("; ") : null };
}

// Runs a change to the store, then shows what happened.
function change(fn, info) {
  const st = ui.settings;
  // Back to where the form or the prompt shows what you type, and why it failed.
  try { fn(); Object.assign(st, { error: null, fieldErrors: {}, info, scroll: 0 }); }
  catch (e) { Object.assign(st, { info: null, scroll: 0 }, splitErrors(e.message, st.mode === "edit" || st.mode === "prompt")); }
  selectedEntry(st);
  draw();
}

function editProfile(p) {
  const st = ui.settings;
  st.form = { prev: p?.id ?? null, name: p?.name ?? "", id: p?.id ?? "", harness: p?.harness ?? "mcc", model: p?.model ?? "", thinking: p?.thinking ?? "" };
  Object.assign(st, { mode: "edit", field: 0, scroll: 0, error: null, fieldErrors: {}, info: null });
  draw();
}

function saveForm() {
  const st = ui.settings, f = st.form;
  const profile = { id: f.id, name: f.name.trim(), harness: f.harness, model: f.model, thinking: f.thinking };
  change(() => {
    saveStore(P.upsertProfile(st.store, profile, f.prev));
    Object.assign(st, { mode: "list", form: null, promptSel: null });
    st.sel = Math.max(0, entries().findIndex((p) => p.id === profile.id));
  }, `Saved ${profile.name}`);
}

// A prompt row's Edit, e or enter: its text, to change; empty sends the default.
function editPrompt(action) {
  const st = ui.settings;
  Object.assign(st, { mode: "prompt", promptSel: action, prompt: { action, text: P.resolvePrompt(st.store, action) ?? "" }, scroll: 0, error: null, fieldErrors: {}, info: null });
  draw();
}

function savePrompt(text = ui.settings.prompt.text) {
  const st = ui.settings, { action } = st.prompt, t = text.trim();
  change(() => {
    saveStore(P.setPrompt(st.store, action, t));
    Object.assign(st, { mode: "list", prompt: null });
  }, t ? `${ACTION_LABELS[action]} now sends: ${t}` : `${ACTION_LABELS[action]} now sends the default: ${DEFAULT_PROMPTS[action]}`);
}

// The selected profile's actions, from a key or its buttons.
function assignTo(action) {
  const st = ui.settings, p = selectedEntry(st);
  change(() => saveStore(P.assignProfile(st.store, action, p.id)), `${ACTION_LABELS[action]} now starts ${p.name}`);
}

function editSelected() {
  const st = ui.settings, p = selectedEntry(st);
  if (p.id !== P.DEFAULT_PROFILE.id) return editProfile(p);
  st.error = "The default profile can't be changed: add your own with n";
  draw();
}

function askDelete() {
  const st = ui.settings, p = selectedEntry(st);
  if (p.id !== P.DEFAULT_PROFILE.id) Object.assign(st, { mode: "confirm", error: null, info: null });
  else st.error = "The default profile can't be deleted";
  draw();
}

function confirmDelete(yes) {
  const st = ui.settings, p = selectedEntry(st);
  st.mode = "list";
  if (yes && p.id !== P.DEFAULT_PROFILE.id) return change(() => saveStore(P.removeProfile(st.store, p.id)), `Deleted ${p.name}`);
  draw();
}

const UP = ["\x1b[A", "\x1bOA"], DOWN = ["\x1b[B", "\x1bOB"];

// Keys in the profile views. In the form, keys are text: q or j is typed, not a
// command, and Esc goes back to the list. Ctrl-C still closes the panel.
function settingsKey(m) {
  const st = ui.settings, k = m[0];
  if (m[1] != null) {
    const button = Number(m[1]);
    if (button === 0 && m[4] === "M") click(Number(m[2]) - 1, Number(m[3]) - 1);
    else if (button === 64 || button === 65) wheel(st, button === 64 ? -1 : 1);
    return;
  }
  // A key brings the form or the prompt back to where it shows what you type.
  st.scroll = 0;
  if (k === "\x03") return quit();
  if (st.mode === "confirm") return confirmDelete(k === "y" || k === "Y");
  if (st.mode === "edit") return formKey(st, k);
  if (st.mode === "prompt") return promptKey(st, k);
  selectedEntry(st);
  if (k === "\x1b" || k === "q" || k === "s") return closeSettings();
  const at = P.ACTION_KEYS.indexOf(st.promptSel);
  if (UP.includes(k) || k === "k") step(st, -1);
  else if (DOWN.includes(k) || k === "j") step(st, 1);
  else if (k === "n") return editProfile(null);
  else if (k === "e" || k === "\r" || k === "\n") return at >= 0 ? editPrompt(st.promptSel) : editSelected();
  else if (at >= 0 && (k === "d" || k === "R" || k === "V")) {
    Object.assign(st, { error: `The ${P.PROMPT_LABELS[st.promptSel]} isn't a profile: e or enter edits it`, info: null });
  } else if (k === "d") return askDelete();
  else if (k === "R" || k === "V") return assignTo(k === "R" ? "resolve" : "review");
  else return;
  draw();
}

// ↑ and ↓ in the list, and the wheel: from the last profile on to the prompt rows,
// and back.
function step(st, by) {
  const at = P.ACTION_KEYS.indexOf(st.promptSel);
  if (by < 0) {
    if (at >= 0) st.promptSel = P.ACTION_KEYS[at - 1] ?? null;
    else st.sel = Math.max(0, st.sel - 1);
  } else if (at >= 0) st.promptSel = P.ACTION_KEYS[Math.min(at + 1, P.ACTION_KEYS.length - 1)];
  else if (st.sel === entries().length - 1) st.promptSel = P.ACTION_KEYS[0];
  else st.sel += 1;
}

// The wheel: in the list it moves the selection, so it reaches the prompt rows; in
// the form and the prompt it scrolls, so their buttons can be reached in a short
// pane. A delete question waits for its key.
function wheel(st, by) {
  if (st.mode === "confirm") return;
  if (st.mode === "list") {
    selectedEntry(st);
    step(st, by);
  } else st.scroll = (st.scroll || 0) + 3 * by;
  draw();
}

// Keys while a prompt is edited: text, as in the form; enter saves, esc goes back.
function promptKey(st, k) {
  const pr = st.prompt;
  if (k === "\x1b") return settingsBack();
  if (k === "\r" || k === "\n") return savePrompt();
  if (k === "\x7f" || k === "\b") pr.text = [...pr.text].slice(0, -1).join("");
  else if (!k.startsWith("\x1b") && !/[\x00-\x1f\x7f-\x9f]/.test(k) && pr.text.length < P.PROMPT_MAX) pr.text += k;
  else return;
  delete st.fieldErrors.prompt;
  draw();
}

function formKey(st, k) {
  const form = st.form, field = FIELDS[st.field];
  if (k === "\x1b") return settingsBack();
  if (k === "\r" || k === "\n") return saveForm();
  if (UP.includes(k) || DOWN.includes(k) || k === "\t" || k === "\x1b[Z") {
    const by = UP.includes(k) || k === "\x1b[Z" ? FIELDS.length - 1 : 1;
    Object.assign(st, { field: (st.field + by) % FIELDS.length, error: null });
    return draw();
  }
  if (!field.max) {
    // A choice: ← and → (or space) step through what the harness takes.
    if (k !== "\x1b[C" && k !== "\x1b[D" && k !== " ") return;
    const list = choices(form, field.key), at = Math.max(0, list.indexOf(form[field.key]));
    form[field.key] = list[(at + (k === "\x1b[D" ? list.length - 1 : 1)) % list.length];
    if (!choices(form, "thinking").includes(form.thinking)) form.thinking = "";
    delete st.fieldErrors[field.key];
    return draw();
  }
  if (k === "\x7f" || k === "\b") form[field.key] = [...form[field.key]].slice(0, -1).join("");
  else if (!k.startsWith("\x1b") && !/[\x00-\x1f\x7f-\x9f]/.test(k) && form[field.key].length < field.max) form[field.key] += k;
  else return;
  delete st.fieldErrors[field.key];
  draw();
}

// Buttons on a line after `prefix` (`at` cells wide), onto more lines when they
// don't fit: [{ text, hits: [{ from, to, action }] }].
function buttonLines(buttons, cols, prefix, at) {
  const out = [];
  let text = prefix, x = at, hits = [];
  for (const [label, action] of buttons) {
    const b = ` ${fit(label, cols - at - 2)} `, w = width(b);
    if (hits.length && x + 1 + w > cols) { out.push({ text, hits }); text = prefix; x = at; hits = []; }
    if (hits.length) { text += " "; x += 1; }
    hits.push({ from: x, to: x + w, action });
    text += invert(b); x += w;
  }
  out.push({ text, hits });
  return out;
}

// Key hints on one line, or more (up to three) when they don't fit, rather than
// cut off.
function hintLines(hints, cols) {
  const lines = [[]];
  for (const h of hints) {
    const line = lines[lines.length - 1];
    if (line.length && lines.length < 3 && width(` ${[...line, h].join(" · ")}`) > cols) lines.push([h]);
    else line.push(h);
  }
  return lines.map((l) => dim(fit(` ${l.join(" · ")}`, cols)));
}

// The profile views' lines; their own buttons replace the rows' and the header's.
function settingsLines(cols, rows) {
  const st = ui.settings, out = [];
  ui.rows = [];
  ui.buttons = [];
  const editing = st.mode === "edit" || st.mode === "prompt";
  const p = editing ? null : selectedEntry(st);
  // Header: the view's name, + New in the list, and ✕ (back) at the right edge.
  const tools = editing ? [] : [[" + New ", () => editProfile(null)]];
  tools.push([" ✕ ", () => settingsBack()]);
  const right = tools.reduce((w, [t]) => w + width(t), 0);
  const heading = fit(st.mode === "edit" ? (st.form.prev ? `Edit profile ${st.form.prev}` : "New profile")
    : st.mode === "prompt" ? P.PROMPT_LABELS[st.prompt.action] : "Agent profiles", cols - right - 2);
  out.push(` ${bold(heading)}${" ".repeat(Math.max(0, cols - 1 - width(heading) - right))}${dim(tools.map(([t]) => t).join(""))}`);
  let x = cols - right;
  for (const [t, action] of tools) { ui.buttons.push({ row: 0, from: x, to: x + width(t), action }); x += width(t); }
  out.push(dim("─".repeat(cols)));

  // What to know or do, most pressing first: the delete question, what a change did
  // or why it failed, then the store's warnings and the OpenCode note. The header,
  // the key hints and a line of the body come first; each message is whole while
  // the room left allows, and a status too long for it is cut there, ending in "…".
  const notes = [];
  if (st.mode === "confirm") notes.push([yellow, `Delete ${p.name}? y deletes it, any other key keeps it`]);
  if (st.error) notes.push([red, st.error]);
  if (st.info) notes.push([green, st.info]);
  for (const w of st.warnings) notes.push([yellow, w]);
  if (st.mode === "edit" && st.form.harness === "opencode" && (st.form.model || st.form.thinking)) notes.push([yellow, OPENCODE_NOTE]);
  const footer = hintLines(st.mode === "edit" ? ["↑↓ field", "←→ choose", "type to edit", "⏎ save", "esc back"]
    : st.mode === "prompt" ? ["type to edit", "⏎ save", "esc back"]
    : st.mode === "confirm" ? ["y delete", "any other key keeps it"]
      : ["↑↓ select", "n new", "e edit", "d delete", "R/V assign", "esc back"], cols);
  const room = Math.max(0, rows - out.length - footer.length - 1);
  const said = notes.flatMap(([tone, text]) => wrap(text, cols - 2, Infinity).map((l) => [tone, l]));
  if (said.length > room) {
    said.length = room;
    if (room) said[room - 1] = [said[room - 1][0], fit(said[room - 1][1] + "…", cols - 2)];
  }
  const status = said.map(([tone, l]) => " " + tone(l));
  const height = Math.max(1, rows - out.length - status.length - footer.length);

  // Each line's click: the whole line's, and its buttons' first.
  const body = [], owner = [], hits = [];
  let selStart = 0, selEnd = 0;
  const addButtons = (buttons, prefix, at, own) => {
    for (const l of buttonLines(buttons, cols, prefix, at)) { hits[body.length] = l.hits; body.push(l.text); owner.push(own); }
  };
  if (st.mode === "edit") {
    const valueW = cols - VALUE_AT;
    FIELDS.forEach((f, i) => {
      const on = i === st.field, value = st.form[f.key], pick = () => { Object.assign(st, { field: i, error: null }); draw(); };
      const bar = on ? accent("▌") : " ";
      // An empty field shows its hint, the id's rule even while you type in it.
      let shown, below = null;
      if (f.max && value) shown = fit(value, valueW - 1) + (on ? invert(" ") : "");
      else if (f.max && on) shown = invert(" ") + (f.key === "id" ? dim(fit(f.hint, valueW - 1)) : "");
      else if (f.max) shown = dim(fit(f.hint ?? "—", valueW));
      else {
        // A choice too wide for the value column goes on a line of its own.
        const name = f.key === "harness" ? P.HARNESS_NAMES[value] : value || "harness default";
        if (width(`‹ ${name} ›`) <= valueW) shown = `‹ ${name} ›`;
        else { shown = ""; below = `${bar}  ${choiceText(name, cols - 3)}`; }
      }
      if (on) selStart = body.length;
      body.push(`${bar} ${(on ? bold : muted)(f.label.padEnd(LABEL_W))} ${shown}`);
      owner.push(pick);
      if (below) { body.push(below); owner.push(pick); }
      // The field's own reason, whole, under it: the form scrolls.
      const why = st.fieldErrors[f.key];
      if (why) for (const l of wrap(why, cols - 4, Infinity)) { body.push("    " + red(l)); owner.push(pick); }
      if (on) selEnd = body.length;
    });
    body.push(""); owner.push(null);
    addButtons([["Save", () => saveForm()], ["Cancel", () => settingsBack()]], "  ", 2, null);
  } else if (st.mode === "prompt") {
    // The text, broken into lines of the pane's width, the cursor after it; empty,
    // what the action sends instead. Then its reason, what to know, and the buttons.
    const { action, text } = st.prompt, valueW = cols - 3, lines = [""];
    for (const ch of text) {
      if (width(lines[lines.length - 1] + ch) > valueW) lines.push("");
      lines[lines.length - 1] += ch;
    }
    if (!text) lines[0] = invert(" ") + dim(fit(`default: ${DEFAULT_PROMPTS[action]}`, valueW - 1));
    else if (width(lines[lines.length - 1]) < valueW) lines[lines.length - 1] += invert(" ");
    else lines.push(invert(" "));
    selStart = body.length;
    for (const l of lines) { body.push(`${accent("▌")} ${l}`); owner.push(null); }
    // Its reason under it: whole while the pane has room for it and the line you
    // type on, cut there otherwise, ending in "…".
    const why = st.fieldErrors.prompt;
    if (why) for (const l of wrap(why, cols - 4, Math.max(1, height - 1))) { body.push("    " + red(l)); owner.push(null); }
    selEnd = body.length;
    body.push(""); owner.push(null);
    const noun = Object.values(ACTIONS).find((a) => a.key === action).noun;
    for (const note of [
      `${P.PROMPT_TOKEN} becomes the ${noun}'s number; nothing else from it goes in.`,
      "Sent as written to every harness, instead of the IDD skill. Empty sends the default.",
    ]) for (const l of wrap(note, cols - 4, Infinity)) { body.push("  " + dim(l)); owner.push(null); }
    body.push(""); owner.push(null);
    const custom = P.resolvePrompt(st.store, action) !== null;
    addButtons([["Save", () => savePrompt()], ...(custom ? [["Use default", () => savePrompt("")]] : []), ["Cancel", () => settingsBack()]], "  ", 2, null);
  } else {
    const using = (id) => P.ACTION_KEYS.filter((a) => (st.store.assign[a] ?? P.DEFAULT_PROFILE.id) === id);
    entries().forEach((q, i) => {
      if (i) { body.push(""); owner.push(null); }
      const on = i === st.sel && !st.promptSel, bar = on ? accent("▌") : " ";
      const select = () => { Object.assign(st, { sel: i, promptSel: null, error: null, mode: "list" }); draw(); };
      // The name keeps at least 12 cells: the Resolve and Review tags move down to
      // the second line when they would squeeze it, and a long id is cut.
      const idTag = q.id === P.DEFAULT_PROFILE.id ? "default" : q.id, tags = using(q.id).map((a) => ACTION_LABELS[a]).join(" · ");
      const keep = Math.min(12, width(q.name)), together = [idTag, tags].filter(Boolean).join(" · ");
      const down = tags && cols - 5 - width(together) < keep;
      const tag = fit(down ? idTag : together, Math.max(1, cols - 5 - keep)), below = down ? fit(tags, cols - 4) : "";
      const name = fit(q.name, Math.max(4, cols - width(tag) - 5));
      if (on) selStart = body.length;
      body.push(`${bar} ${on ? bold(name) : name}${" ".repeat(Math.max(1, cols - 3 - width(name) - width(tag)))}${accent(tag)}`);
      body.push(`${bar}   ${below ? accent(below) + dim(fit(` · ${describe(q)}`, cols - 4 - width(below))) : dim(fit(describe(q), cols - 4))}`);
      owner.push(select, select);
      // The selected profile's buttons, on a line of their own.
      if (on) {
        const fixed = q.id === P.DEFAULT_PROFILE.id, used = using(q.id);
        const buttons = st.mode === "confirm"
          ? [["Delete", () => confirmDelete(true)], ["Keep", () => confirmDelete(false)]]
          : [
            ...P.ACTION_KEYS.map((a) => used.includes(a) ? [`${ACTION_LABELS[a]} ✓`, () => {}] : [`Use for ${ACTION_LABELS[a]}`, () => assignTo(a)]),
            ...(fixed ? [] : [["Edit", () => editSelected()], ["Delete", () => askDelete()]]),
          ];
        addButtons(buttons, `${bar}   `, 4, select);
        selEnd = body.length;
      }
    });
    // With the last profile selected, the prompt rows under it show too, as far as
    // they fit: the wheel or ↓ goes on to them.
    if (!st.promptSel && st.sel === entries().length - 1) selEnd = Infinity;
    // Each action's prompt, under the profiles: your own, or the default it sends
    // without one. The selected one's Edit sits at the right edge, so a click on the
    // row only selects it.
    for (const a of P.ACTION_KEYS) {
      body.push(""); owner.push(null);
      const on = st.promptSel === a && st.mode === "list", bar = on ? accent("▌") : " ", edit = " Edit ";
      const select = () => { Object.assign(st, { promptSel: a, error: null, mode: "list" }); draw(); };
      const custom = P.resolvePrompt(st.store, a), label = fit(P.PROMPT_LABELS[a], cols - 3 - (on ? width(edit) + 2 : 0));
      if (on) {
        selStart = body.length;
        const x = cols - 1 - width(edit);
        hits[body.length] = [{ from: x, to: x + width(edit), action: () => editPrompt(a) }];
        body.push(`${bar} ${bold(label)}${" ".repeat(Math.max(1, x - 2 - width(label)))}${invert(edit)}`);
      } else body.push(`${bar} ${label}`);
      body.push(`${bar}   ${custom ? fit(custom, cols - 4) : dim(fit(`default: ${DEFAULT_PROMPTS[a]}`, cols - 4))}`);
      owner.push(select, select);
      if (on) selEnd = body.length;
    }
  }
  // Keep the selected entry (or field) in view. A prompt keeps its end in view: the
  // line you type on, and its reason. The wheel scrolls the form and the prompt
  // from there.
  const most = Math.max(0, body.length - height);
  const shown = st.mode === "prompt" ? Math.max(selStart, selEnd - height) : Math.min(selStart, Math.max(0, Math.min(selEnd, body.length) - height));
  const top = editing ? Math.max(0, Math.min(most, shown + (st.scroll || 0))) : shown;
  if (editing) st.scroll = top - shown;
  for (let r = 0; r < height; r++) {
    out.push(body[top + r] ?? "");
    for (const h of hits[top + r] ?? []) ui.buttons.push({ row: out.length - 1, from: h.from, to: h.to, action: h.action });
    const action = owner[top + r];
    if (action) ui.buttons.push({ row: out.length - 1, from: 0, to: cols, action });
  }
  out.push(...status, ...footer);
  return out;
}

// ── Input ───────────────────────────────────────────────────────────────────

function pick(view) {
  ui.view = view;
  try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(path.join(STATE, "view"), view); } catch {}
  ui.follow = true;
  draw();
}

function move(by) {
  const items = ui[ui.view];
  if (!items.length) return;
  ui.sel[ui.view] = Math.max(0, Math.min(items.length - 1, ui.sel[ui.view] + by));
  ui.follow = true;
  draw();
}

function click(x, y) {
  const button = ui.buttons.find((b) => b.row === y && x >= b.from && x < b.to);
  if (button) return button.action();
  // Anywhere but on one of its profiles, a click closes the menu, and nothing else.
  if (ui.menu) return closeMenu();
  if (ui.settings) return;
  const i = ui.rows[y];
  if (i == null || i < 0) return;
  ui.sel[ui.view] = i;
  draw();
  openUrl(ui[ui.view][i]?.url);
}

function quit() {
  process.stdout.write(`${ESC}?1006l${ESC}?1000l${ESC}?25h${ESC}?1049l`);
  if (registry) fs.rmSync(registry, { force: true });
  process.exit(0);
}

const KEYS = /\x1b\[<(\d+);(\d+);(\d+)([mM])|\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/g;
function onInput(data) {
  for (const m of data.toString("utf8").matchAll(KEYS)) {
    const k = m[0];
    // The profile views take every key and click while they're open.
    if (ui.settings) { settingsKey(m); continue; }
    // So does the profile menu: esc and q close it, not the panel.
    if (ui.menu) { menuKey(m); continue; }
    if (m[1] != null) {
      const button = Number(m[1]), x = Number(m[2]) - 1, y = Number(m[3]) - 1;
      if (button === 64) { ui.top[ui.view] -= 3; draw(); }
      else if (button === 65) { ui.top[ui.view] += 3; draw(); }
      else if (button === 0 && m[4] === "M") click(x, y);
      continue;
    }
    if (k === "q" || k === "\x03" || (k === "\x1b" && data.length === 1)) return quit();
    // Any key clears a notice, except the progress of a launch still under way.
    if (ui.notice && !(ui.acting && ui.notice.tone === "info")) { ui.notice = null; draw(); }
    if (k === "\x1b[A" || k === "\x1bOA" || k === "k") move(-1);
    else if (k === "\x1b[B" || k === "\x1bOB" || k === "j") move(1);
    else if (k === "\x1b[5~") move(-5);
    else if (k === "\x1b[6~") move(5);
    else if (k === "g" || k === "\x1b[H" || k === "\x1bOH") move(-Infinity);
    else if (k === "G" || k === "\x1b[F" || k === "\x1bOF") move(Infinity);
    else if (k === "\t" || k === "\x1b[Z" || k === "\x1b[C" || k === "\x1b[D" || k === "h" || k === "l") pick(ui.view === "prs" ? "issues" : "prs");
    else if (k === "1") pick("prs");
    else if (k === "2") pick("issues");
    else if (k === "\r" || k === "\n") openUrl(ui[ui.view][ui.sel[ui.view]]?.url);
    else if (k === "o") openUrl(ui.repo?.url);
    else if (k === "a") act(ui.view, ui.sel[ui.view], "row");
    else if (k === "s") openSettings();
    else if (k === "r") refresh(true);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  try { if (fs.readFileSync(path.join(STATE, "view"), "utf8").trim() === "issues") ui.view = "issues"; } catch {}

  registry = SELF ? path.join(STATE, "panes", SELF.replace(/[^\w.-]/g, "_")) : null;
  if (registry) {
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, SELF);
  }

  process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h${ESC}2J`);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("data", onInput);
  process.stdout.on("resize", draw);
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, quit);
  // Keep a crash on screen: the pane closes as soon as the process exits.
  process.on("uncaughtException", (e) => {
    process.stdout.write(`${ESC}?1006l${ESC}?1000l${ESC}?25h${ESC}?1049l`);
    process.stderr.write(`herdr-github: ${e?.stack || e}\n\nPress any key to close.\n`);
    process.stdin.removeAllListeners("data");
    process.stdin.once("data", () => { if (registry) fs.rmSync(registry, { force: true }); process.exit(1); });
  });

  setInterval(() => { if (ui.loading) { ui.frame++; draw(); } }, 100);
  setInterval(async () => {
    await locate();
    // Fetch only while the panel's tab is on screen: a hidden panel keeps running.
    if (ui.visible && (cwd !== ui.context || Date.now() - ui.fetchedAt > STALE)) refresh();
  }, POLL);

  draw();
  locate().then(() => refresh());
}

if (require.main === module) main();
else {
  module.exports = {
    width, fit, wrap, ago, checks, clean, plain, prRow, issueRow, FORGES, remoteHost, pickHost, forgesFor, firstLine, ui, draw, click, onInput,
    act, startChoice, launch, findSkill, promptFor, readStore, IDD, TIMING,
    // scripts/capture-screenshots.mjs reads the repo once, as the panel does.
    refresh, REFRESH,
    // Tests point the panel at another followed pane, or none.
    follow: (pane) => { target = pane; },
  };
}
