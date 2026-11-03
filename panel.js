#!/usr/bin/env node
// The open pull requests and issues of the repo you're in, read with `gh` (GitHub)
// or `glab` (GitLab): the terminal twin of Whole Herdr's GitHub panel. It follows
// the last focused pane of its own tab. Enter or a click opens a row in the browser.
"use strict";
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
  root: null, tab: null, acting: null,
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

async function refresh() {
  if (ui.loading) return;
  const context = cwd;
  if (context !== ui.context) {
    Object.assign(ui, { context, prs: [], issues: [], errors: {}, repo: null, root: null, forge: null, error: null, fetched: false, sel: { prs: 0, issues: 0 }, top: { prs: 0, issues: 0 } });
  }
  ui.fetchedAt = Date.now();
  if (!fs.existsSync(context)) { ui.error = "Folder not found"; draw(); return; }
  ui.loading = true;
  draw();
  try {
    const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: context });
    if (cwd !== context) return;
    if (top.code !== 0) { ui.repo = null; ui.error = "Not a git repository"; return; }
    const root = top.stdout.trim();
    ui.root = root;
    const host = pickHost((await run("git", ["remote", "-v"], { cwd: root })).stdout);
    if (cwd !== context) return;
    if (!host) { Object.assign(ui, { repo: null, forge: null, prs: [], issues: [], error: "No GitHub or GitLab remote" }); return; }
    const errors = [];
    for (const id of forgeCache.has(host) ? [forgeCache.get(host)] : forgesFor(host)) {
      const result = await load(FORGES[id], root);
      if (cwd !== context) return;
      if (result.error) { errors.push(result.error); continue; }
      forgeCache.set(host, id);
      Object.assign(ui, result, { forge: FORGES[id], error: null, fetched: true });
      for (const v of ["prs", "issues"]) ui.sel[v] = Math.min(ui.sel[v], Math.max(0, ui[v].length - 1));
      return;
    }
    Object.assign(ui, { repo: null, forge: null, errors: {}, prs: [], issues: [], error: errors.join(" · ") });
  } catch (e) {
    if (cwd === context) ui.error = `Can't read the repository: ${e.message}`;
  } finally {
    ui.loading = false;
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
// The selected issue can be handed to the issue-resolver skill, the selected pull
// request to issue-pr-review: a new pane below your agent runs the same kind of
// agent, prompted with the skill and the bare number, nothing else from the row.

const IDD = "https://luongnv.com/idd";
const ACTIONS = {
  issues: { label: "Resolve", key: "resolve", skill: "issue-resolver", noun: "issue" },
  prs: { label: "Review", key: "review", skill: "issue-pr-review", noun: "pull request" },
};
const isNumber = (n) => Number.isSafeInteger(n) && n > 0;

// Both skills drive `gh`, so the action is offered on GitHub only.
function actionFor(view) {
  if (ui.forge !== FORGES.github) return null;
  const item = ui[view]?.[ui.sel[view]];
  return item && isNumber(item.number) ? { ...ACTIONS[view], number: item.number } : null;
}

const readable = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const dirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)); } catch { return []; } };
const pluginName = (dir) => {
  try { const n = JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8")).name; if (typeof n === "string" && /^[\w.-]+$/.test(n)) return n; } catch {}
  return null;
};

// How to call `skill` for an agent of `kind` working in `root`: its name, or
// "plugin:name" when Claude has it only from a plugin; null when it isn't found.
// Folders are checked for every kind, since a wrong "not installed" is the worse mistake.
function findSkill(kind, skill, root) {
  const home = os.homedir();
  const folders = [".claude", ".agents", ".codex", `.${kind}`].flatMap((d) => [path.join(home, d, "skills"), ...(root ? [path.join(root, d, "skills")] : [])]);
  if (folders.some((f) => readable(path.join(f, skill, "SKILL.md")))) return skill;
  if (kind !== "claude") return null;
  // Claude plugins: plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>
  // and plugins/synced/<account>/<plugin>/<skill>.
  const plugins = path.join(home, ".claude", "plugins");
  const roots = [
    ...dirs(path.join(plugins, "cache")).flatMap(dirs).flatMap((p) => dirs(p).map((v) => [v, path.basename(p)])),
    ...dirs(path.join(plugins, "synced")).flatMap(dirs).map((p) => [p, null]),
  ];
  for (const [dir, fallback] of roots) {
    if (![path.join(dir, "skills", skill), path.join(dir, skill)].some((d) => readable(path.join(d, "SKILL.md")))) continue;
    const name = pluginName(dir) ?? fallback;
    return name ? `${name}:${skill}` : skill;
  }
  return null;
}

// Built from the skill name and an integer only: never from a title or body.
function promptFor(kind, skill, action) {
  if (!isNumber(action.number)) throw new Error("not a number");
  return kind === "claude" ? `/${skill} ${action.number}` : `Use the ${skill} skill on ${action.noun} #${action.number}.`;
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

// The Resolve or Review button and the a key. One launch at a time.
function act() {
  const action = actionFor(ui.view);
  if (!action || ui.acting) return ui.acting;
  ui.acting = launch(action, ui.root || cwd)
    .catch((e) => say("error", `Can't start an agent: ${e.message}`))
    .finally(() => { ui.acting = null; });
  return ui.acting;
}

async function launch(action, root) {
  const what = `${action.noun} #${action.number}`;
  const herdr = (args, timeout) => run(HERDR, args, { timeout }).catch((e) =>
    ({ code: -1, stdout: "", stderr: e.code === "ENOENT" ? "herdr isn't installed" : e.message }));
  if (!target && !ui.tab) return say("error", `Open this panel in herdr to ${action.key} ${what} with your agent.`);
  say("info", `Finding your agent to ${action.key} ${what}…`);
  const list = await herdr(["agent", "list"], 10000);
  if (list.code !== 0) return say("error", `Can't list agents: ${herdrError(list, "herdr").message}`);
  let agents;
  try { agents = JSON.parse(list.stdout).result.agents ?? []; } catch { return say("error", "Can't read herdr's agent list"); }
  // Your agent: the one in the pane the panel follows, else one in the panel's tab.
  const agent = agents.find((a) => a.pane_id === target) ?? agents.find((a) => ui.tab && a.tab_id === ui.tab && a.pane_id !== SELF);
  if (!agent) return say("error", `No agent in this tab. Start yours (claude, codex, …) in a pane here, then ${action.label} again.`);
  const kind = agent.agent;
  if (typeof kind !== "string" || !/^[a-z][\w-]*$/.test(kind)) return say("error", "herdr doesn't say which agent runs in this tab");
  const skill = findSkill(kind, action.skill, root);
  if (!skill) return say("error", `The ${action.skill} skill isn't installed for ${kind}. Install the skills from:`, IDD);
  const text = promptFor(kind, skill, action);

  say("info", `Starting ${kind} to ${action.key} ${what}…`);
  const split = await herdr(["pane", "split", agent.pane_id, "--direction", "down", "--cwd", root, "--no-focus"], 10000);
  let pane = null;
  try { const r = JSON.parse(split.stdout).result; pane = r?.pane?.pane_id ?? r?.pane_id ?? null; } catch {}
  if (split.code !== 0 || !pane) return say("error", `Can't open a pane for ${kind}: ${herdrError(split, "herdr").message}`);
  const names = new Set(agents.map((a) => a.name).filter(Boolean));
  let name = `${action.key}-${action.number}`;
  for (let k = 2; names.has(name); k++) name = `${action.key}-${action.number}-${k}`;
  const start = await herdr(["agent", "start", name, "--kind", kind, "--pane", pane], 60000);
  if (start.code !== 0) {
    const e = herdrError(start, "herdr");
    // Not ready usually means the agent is asking you something: leave it open.
    if (e.code === "agent_not_ready") return say("error", `${kind} is waiting for you in the new pane. Then send it: ${text}`);
    await herdr(["pane", "close", pane], 5000);
    return say("error", `${kind} didn't start: ${e.message}`);
  }
  const sent = await herdr(["agent", "prompt", pane, text], 10000);
  if (sent.code !== 0) return say("error", `${kind} started, but the prompt failed (${herdrError(sent, "herdr").message}). Send it yourself: ${text}`);
  say("ok", `Started ${kind} in a new pane: ${text}`);
}

// ── Rendering ───────────────────────────────────────────────────────────────

// One row: the selection bar, a 1-cell icon, the title (2 lines), the description
// (3 lines) and the meta line, left text cut so the right-hand parts always fit.
function rowLines(item, selected, cols, icon, meta, trailing) {
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

function prRow(p, selected, cols) {
  const review = REVIEWS[p.review];
  const trailing = [];
  if (p.draft) trailing.push(part("[Draft]"));
  if (review) trailing.push(part(review[0], review[1]));
  if (p.checks) trailing.push(p.checks === "fail" ? part("✗", red) : p.checks === "pending" ? part("●", yellow) : part("✓", green));
  trailing.push(part(ago(p.updatedAt)));
  return rowLines(p, selected, cols, p.draft ? dim("◌") : green("●"),
    [p.ref, p.author ?? "?", p.branch].filter(Boolean).join(" · "), trailing);
}

function issueRow(i, selected, cols) {
  const trailing = (i.labels ?? []).slice(0, 3).map((l) => {
    const name = fit(clean(l.name), 14);
    return { w: width(name) + 2, s: `${rgb(l.color)("●")} ${dim(name)}` };
  });
  trailing.push(part(ago(i.updatedAt)));
  return rowLines(i, selected, cols, green("◉"), `${i.ref} · ${i.author ?? "?"}`, trailing);
}

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const HINT = "Ctrl- or Cmd-click the URL to open it on your machine";

const TONES = { info: yellow, ok: green, error: red };

// A failed open, at most `room` lines: why, what to do instead, and the whole URL.
// An agent action's notice is its message, in the tone's color, and maybe a URL.
function noticeLines(notice, cols, room) {
  const { url } = notice, lines = [dim("─".repeat(cols))];
  if (notice.tone) for (const l of wrap(notice.text, cols - 2, 3)) lines.push(" " + TONES[notice.tone](l));
  else lines.push(" " + red(fit(notice.reason, cols - 2)), " " + dim(fit(HINT, cols - 2)));
  if (url) for (const l of urlLines(url, cols - 2)) lines.push(" " + link(url, accent(l)));
  return lines.slice(0, Math.max(0, room));
}

function draw() {
  const cols = process.stdout.columns || 60, rows = process.stdout.rows || 24;
  const out = [];
  ui.buttons = [];

  // Header: repo, spinner, then the Resolve or Review button for the selected row,
  // and the refresh and open-on-the-forge buttons.
  const right = ui.repo?.url ? " ↻  ↗ " : " ↻ ";
  const action = actionFor(ui.view);
  const button = action ? ` ${action.label} #${action.number} ` : "";
  const spin = ui.loading ? yellow(SPIN[ui.frame % SPIN.length]) + " " : "";
  const title = fit(ui.repo?.name ?? ui.forge?.name ?? "Pull requests and issues", cols - width(right) - 3 - (button ? width(button) + 1 : 0) - (spin ? 2 : 0));
  const gap = " ".repeat(Math.max(0, cols - 1 - width(title) - (spin ? 2 : 0) - width(button) - width(right)));
  out.push(` ${link(ui.repo?.url, bold(title))}${gap}${spin}${button ? invert(button) : ""}${dim(right)}`);
  const at = cols - width(right);
  if (button) ui.buttons.push({ row: 0, from: at - width(button), to: at, action: () => act() });
  ui.buttons.push({ row: 0, from: at, to: at + 3, action: () => refresh() });
  if (ui.repo?.url) ui.buttons.push({ row: 0, from: at + 3, to: at + 6, action: () => openUrl(ui.repo.url) });
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
  const lines = [], owner = [];
  let selStart = 0, selEnd = 0;
  items.forEach((x, i) => {
    if (i) { lines.push(""); owner.push(-1); }
    if (i === ui.sel[view]) selStart = lines.length;
    for (const l of view === "prs" ? prRow(x, i === ui.sel[view], cols) : issueRow(x, i === ui.sel[view], cols)) { lines.push(l); owner.push(i); }
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
  }
  out.push(...notice);

  out.push(dim(fit(` ↑↓ select · ⏎ open · ${action ? `a ${action.key} · ` : ""}⇥ switch · r refresh · o repo · q close`, cols)));

  let frame = `${ESC}?2026h`;
  out.slice(0, rows).forEach((l, i) => { frame += `${ESC}${i + 1};1H${l}${ESC}0m${ESC}K`; });
  process.stdout.write(frame + `${ESC}J${ESC}?2026l`);
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
    if (m[1] != null) {
      const button = Number(m[1]), x = Number(m[2]) - 1, y = Number(m[3]) - 1;
      if (button === 64) { ui.top[ui.view] -= 3; draw(); }
      else if (button === 65) { ui.top[ui.view] += 3; draw(); }
      else if (button === 0 && m[4] === "M") click(x, y);
      continue;
    }
    if (k === "q" || k === "\x03" || (k === "\x1b" && data.length === 1)) return quit();
    if (ui.notice) { ui.notice = null; draw(); }
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
    else if (k === "a") act();
    else if (k === "r") refresh();
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
  locate().then(refresh);
}

if (require.main === module) main();
else module.exports = { width, fit, wrap, ago, checks, clean, plain, prRow, issueRow, FORGES, remoteHost, pickHost, forgesFor, firstLine, ui, draw, click, onInput, act, findSkill, promptFor, IDD };
