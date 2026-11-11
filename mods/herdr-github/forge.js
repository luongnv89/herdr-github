// The Herdr app mod's rules for rows, forges and agent actions: the same ones the
// terminal panel (panel.js) follows. Plain JavaScript with no imports, so the app
// loads it as a module and `node --test` loads it as one too.

export const LIMIT = 50;
export const STALE = 120000;
export const IDD = "https://luongnv.com/idd";

export function ago(iso, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
}

// A PR's checks in one word: a failure beats pending beats pass.
const BAD = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];
export function checks(rollup) {
  if (!rollup?.length) return null;
  if (rollup.some((c) => BAD.includes(c.conclusion) || BAD.includes(c.state))) return "fail";
  if (rollup.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED")) return "pending";
  return "pass";
}

// The first line of a CLI's error, past glab's boxed "ERROR" heading.
export const firstLine = (text) => (text || "").split("\n").map((l) => l.trim()).find((l) => l && l !== "ERROR") ?? "";

// HTML entities decoded, control characters gone.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const clean = (text) => (text || "")
  .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  })
  .replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\ufeff]+/g, " ");

// A PR or issue body as one line of prose: no template comments, headings,
// code blocks, images, link targets, list or emphasis marks.
export function plain(md) {
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

export const FORGES = {
  github: {
    id: "github", name: "GitHub", cli: "gh", prs: "Pull requests", pr: "pull request",
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
    id: "gitlab", name: "GitLab", cli: "glab", prs: "Merge requests", pr: "merge request",
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
export function remoteHost(url) {
  const m = /^[a-z][\w+.-]*:\/\/(?:[^@/]*@)?([^:/]+)/i.exec(url) || /^(?:[^@/]*@)?([^:/]+):/.exec(url);
  return m ? m[1].toLowerCase() : null;
}

// `git remote -v` → the host of origin, else of the first remote.
export function pickHost(remotes) {
  const urls = new Map();
  for (const line of (remotes || "").split("\n")) {
    const [name, url] = line.split(/\s+/);
    if (name && url && !urls.has(name)) urls.set(name, url);
  }
  const url = urls.get("origin") ?? urls.values().next().value;
  return url ? remoteHost(url) : null;
}

// The forges to try for a host, most likely first; a self-hosted name says neither.
export function forgesFor(host) {
  if (host.includes("github")) return ["github"];
  if (host.includes("gitlab")) return ["gitlab"];
  return ["github", "gitlab"];
}

// One forge's repo, pull requests and issues, from a runner that resolves to
// { code, stdout, stderr } for any exit and rejects only when the CLI can't start.
// Returns { error } when the CLI can't read the repo.
export async function load(forge, sh) {
  const call = (args) => sh(forge.cli, args).catch((e) => ({ code: -1, stdout: "", stderr: cantRun(forge.cli, e) }));
  const [repo, prs, issues, labels] = await Promise.all([
    call(forge.repoArgs), call(forge.prArgs), call(forge.issueArgs), forge.labelArgs ? call(forge.labelArgs) : null,
  ]);
  if (repo.code !== 0) return { error: firstLine(repo.stderr) || `Not a ${forge.name} repository` };
  const colors = {};
  // Label colors are a nicety: without them the dots are grey.
  try { if (labels?.code === 0) for (const l of JSON.parse(labels.stdout)) colors[l.name] = l.color; } catch {}
  const result = { repo: forge.repo(JSON.parse(repo.stdout)), errors: {}, prs: [], issues: [] };
  try {
    if (prs.code === 0) result.prs = JSON.parse(prs.stdout).map(forge.toPr); else result.errors.prs = firstLine(prs.stderr) || `${forge.cli} exited ${prs.code}`;
  } catch { result.errors.prs = `Can't read ${forge.cli}'s answer`; }
  try {
    if (issues.code === 0) result.issues = JSON.parse(issues.stdout).map((i) => forge.toIssue(i, colors)); else result.errors.issues = firstLine(issues.stderr) || `${forge.cli} exited ${issues.code}`;
  } catch { result.errors.issues = `Can't read ${forge.cli}'s answer`; }
  return result;
}

// How long a refresh may run before the panel stops waiting for it (#42). A real one
// runs git rev-parse, git remote, then each forge's calls for an unknown host: four
// steps of at most a 60 s timeout in the terminal panel, 30 s in the app. Only a
// refresh that will never end runs longer. Tests shorten it.
export const REFRESH = { hungMs: 300000 };

// Which refresh is the panel's own (#42). begin() numbers a new refresh, or returns
// null while one is running that hasn't hung; force starts one anyway. Only the latest
// number is current, and only its end() says the spinner can stop, so a refresh that
// ends after another replaced it changes nothing.
export function refreshGate() {
  let latest = 0, since = 0, running = false;
  return {
    begin(now, force = false, hungMs = REFRESH.hungMs) {
      if (running && !force && now - since < hungMs) return null;
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

// One refresh of a folder, as the panel's new fields: root, repo, forge, the lists and
// their errors, or an error. exec(cmd, args, { cwd }) runs a program there, and forges
// remembers which forge answered for a host. Null as soon as current() says the
// answer isn't wanted any more: the folder changed or a newer refresh began.
export async function readRepo({ cwd, on = null, exec, forges, current }) {
  try {
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
    if (!current()) return null;
    if (top.code !== 0) return { repo: null, forge: null, root: null, prs: [], issues: [], error: "Not a git repository" };
    const root = top.stdout.trim();
    const host = pickHost((await exec("git", ["remote", "-v"], { cwd: root })).stdout);
    if (!current()) return null;
    if (!host) return { root, repo: null, forge: null, prs: [], issues: [], error: "No GitHub or GitLab remote" };
    const key = `${on ?? ""}|${host}`, errors = [];
    for (const id of forges.has(key) ? [forges.get(key)] : forgesFor(host)) {
      const result = await load(FORGES[id], (cli, args) => exec(cli, args, { cwd: root }));
      if (!current()) return null;
      if (result.error) { errors.push(result.error); continue; }
      forges.set(key, id);
      return { root, ...result, forge: FORGES[id], error: null, fetched: true };
    }
    return { root, repo: null, forge: null, errors: {}, prs: [], issues: [], error: errors.join(" · ") };
  } catch (e) {
    // exec rejects when git can't start there, or the machine can't be reached.
    if (!current()) return null;
    return { error: on ? `Can't reach ${on}: ${e?.message ?? e}` : `Can't read the repository: ${e?.message ?? e}` };
  }
}

// Why a program didn't start, in a few words.
export function cantRun(cli, e) {
  const text = String(e?.message ?? e ?? "");
  return /ENOENT|not found|No such file/i.test(text) ? `${cli} isn't installed` : `Can't run ${cli}: ${text}`;
}

// ── Agent actions ───────────────────────────────────────────────────────────
// The selected issue can be handed to the issue-resolver skill, the selected pull
// request to issue-pr-review: a new pane runs the agent of the action's profile
// (profiles.js), prompted with the skill and the bare number, nothing else from the row.

export const ACTIONS = {
  issues: { label: "Resolve", key: "resolve", skill: "issue-resolver", noun: "issue" },
  prs: { label: "Review", key: "review", skill: "issue-pr-review", noun: "pull request" },
};
export const isNumber = (n) => Number.isSafeInteger(n) && n > 0;
export const isKind = (k) => typeof k === "string" && /^[a-z][\w-]*$/.test(k);

// Both skills drive `gh`, so the action is offered on GitHub only.
export function actionFor(forge, view, item) {
  if (forge?.id !== "github" || !item || !isNumber(item.number)) return null;
  return { ...ACTIONS[view], number: item.number };
}

// Claude Code, started directly or by `mcc run`, takes a skill as a slash command.
export const claudeStyle = (kind) => kind === "claude" || kind === "mcc";

// Built from the skill name and an integer only: never from a title or body.
export function promptFor(kind, skill, action) {
  if (!isNumber(action.number)) throw new Error("not a number");
  return claudeStyle(kind) ? `/${skill} ${action.number}` : `Use the ${skill} skill on ${action.noun} #${action.number}.`;
}

// What the app's new pane runs for a launch plan (profiles.js buildLaunch, which
// checked the profile): mcc's own command line, prompt last, with no first message
// to send; or an agent's programs.json `run` with the profile's flags after it,
// the prompt sent as the agent's first message. Throws when herdr has no `run` for it.
export function tabStart(plan, run, text) {
  if (plan.mode === "command") return { argv: plan.argv.slice(), task: null };
  if (!Array.isArray(run) || !run.length || !run.every((w) => typeof w === "string" && w)) {
    throw new Error(`Herdr doesn't know how to start ${plan.kind}. Add it to programs.json with a "run".`);
  }
  return { argv: [...run, ...plan.extraArgs], task: text };
}

// The pane the app splits for a new agent: the one the panel follows, else the
// first terminal pane in its tab. A mod pane (the panel itself) is never split.
// Returns that pane from panes(), or null.
export function chooseAnchor(loc, panes) {
  const ok = (p) => p && p.terminal != null && !p.mod;
  const list = Array.isArray(panes) ? panes : [];
  const own = loc?.pane ? list.find((p) => p.pane === loc.pane) : null;
  if (ok(own)) return own;
  return (loc?.tab && list.find((p) => ok(p) && p.tab === loc.tab)) || null;
}

// A space, tab or terminal id without its "machine/" prefix: labels on a machine
// use the ids local to it. machineOf gives that prefix, or null for this computer.
export const localId = (id) => (typeof id === "string" && id.includes("/") ? id.slice(id.indexOf("/") + 1) : id);
const machineOf = (id) => (typeof id === "string" && id.includes("/") ? id.slice(0, id.indexOf("/")) : null);

// The terminal a split just opened in tab `tabId`: the one in `after` (terminals())
// whose address isn't in `before`, on the tab's machine, labelled with the tab.
// Null when there is none or more than one: the prompt never goes to a guess.
export function pickNewTerminal(before, after, tabId) {
  if (!tabId) return null;
  const old = new Set(before ?? []), tab = localId(tabId), machine = machineOf(tabId);
  const found = (after ?? []).filter((t) => typeof t?.address === "string" && !old.has(t.address)
    && machineOf(t.address) === machine && t.labels?.["herdr.tab"] === tab);
  return found.length === 1 ? found[0] : null;
}

// What the app says when pickNewTerminal found no terminal for `who`'s new pane.
// No terminal new anywhere: terminal.open opened nothing, most often because
// herdr-core can't find the program on its PATH (Herdr says so in a toast).
// Something new but not exactly one in the tab: the pane may be open.
// Either way the notice keeps `text`, the prompt to send by hand.
export function unpickedNotice(who, text, before, after) {
  const old = new Set(before ?? []);
  const opened = (after ?? []).some((t) => typeof t?.address === "string" && !old.has(t.address));
  if (!opened) return `${who} didn't start in a new pane. Herdr may not find its program: check Herdr's message, or the profile's harness. When ${who} runs, send it: ${text}`;
  return `Started ${who} in a new pane, but can't tell which terminal it is. Send it yourself in the new pane: ${text}`;
}

// The panel's one notice, after `incoming`: { tone, text, url, from }, `from` being
// the launch that said it (null for anything else). An error stays until a newer
// error or a message from its own launch replaces it (a key or a new launch clears
// it), so another launch's progress never hides a prompt that wasn't sent.
export function nextNotice(current, incoming) {
  if (current?.tone === "error" && incoming.tone !== "error" && current.from !== incoming.from) return current;
  return incoming;
}

// Whether a key leaves the notice up: only the progress of a launch, or of a
// prompt still waiting to be sent.
export const keepsNotice = (notice, busy) => Boolean(notice && busy && notice.tone === "info");

// Whether an agent can take its first message: idle only. A blocked one is asking
// something, such as whether you trust the folder, and pasted text would answer it.
export const isReadyToSend = (status) => status === "idle";

const safeName = (n) => typeof n === "string" && /^[\w.-]+$/.test(n) ? n : null;
const join = (...parts) => parts.join("/").replace(/\/+/g, "/");

// How to call `skill` for an agent of `kind` working in `root`: its name, or
// "plugin:name" when Claude has it only from a plugin; null when it isn't found.
// Folders are checked for every kind, since a wrong "not installed" is the worse mistake.
// `io` reads the agent's machine: { home, read(path) → text | null, dirs(path) → [subfolder paths],
// claudeDir? }. claudeDir is the Claude Code config folder to look in (for mcc, the
// profile's folder that `mcc env` reports); ~/.claude when it isn't given.
export async function findSkill(kind, skill, root, io) {
  const { home } = io, claudeDir = io.claudeDir || join(home, ".claude");
  const read = (p) => Promise.resolve(io.read(p)).catch(() => null);
  const json = async (p) => { try { const t = await read(p); return t == null ? null : JSON.parse(t); } catch { return null; } };
  const has = async (dir) => (await read(join(dir, "SKILL.md"))) != null;

  const folders = [".claude", ".agents", ".codex", `.${kind}`].flatMap((d) => [join(home, d, "skills"), ...(root ? [join(root, d, "skills")] : [])]);
  if (claudeStyle(kind)) folders.push(join(claudeDir, "skills"));
  if ((await Promise.all(folders.map((f) => has(join(f, skill))))).some(Boolean)) return skill;
  if (!claudeStyle(kind)) return null;

  // Claude plugins: the installed ones (installed_plugins.json) that settings.json
  // doesn't disable, each with <installPath>/skills/<skill>, and synced ones, laid
  // out as plugins/synced/<account>/<plugin>/<skill>. A cached copy alone doesn't count.
  const plugins = join(claudeDir, "plugins");
  const enabled = { ...(await json(join(claudeDir, "settings.json")))?.enabledPlugins };
  if (root) for (const f of ["settings.json", "settings.local.json"]) Object.assign(enabled, (await json(join(root, ".claude", f)))?.enabledPlugins);
  const installed = Object.entries((await json(join(plugins, "installed_plugins.json")))?.plugins ?? {})
    .filter(([key, list]) => enabled[key] !== false && Array.isArray(list))
    .flatMap(([key, list]) => list
      .filter((i) => typeof i?.installPath === "string" && (i.scope !== "project" && i.scope !== "local" || i.projectPath === root))
      .map((i) => [i.installPath, safeName(key.split("@")[0])]));
  const dirs = async (p) => { try { return (await io.dirs(p)) ?? []; } catch { return []; } };
  const synced = (await Promise.all((await dirs(join(plugins, "synced"))).map(dirs))).flat().map((p) => [p, null]);
  for (const [dir, fallback] of [...installed, ...synced]) {
    if (!(await has(join(dir, "skills", skill))) && !(await has(join(dir, skill)))) continue;
    const name = safeName((await json(join(dir, ".claude-plugin", "plugin.json")))?.name) ?? fallback;
    return name ? `${name}:${skill}` : skill;
  }
  return null;
}

// ── Layout ──────────────────────────────────────────────────────────────────

// The path from the layout's root to the block showing `mod`, or null.
export function pathTo(node, mod, trail = []) {
  if (!node || typeof node !== "object") return null;
  const here = [...trail, node];
  if (node.content?.mod === mod) return here;
  for (const child of node.children ?? []) {
    const found = pathTo(child, mod, here);
    if (found) return found;
  }
  return null;
}

// Whether a block on that path is on screen: nothing above it hidden, and each
// stack on the way shows the child that leads to it.
export function shown(path) {
  if (!path) return true;
  return path.every((node, i) => !node.hidden && !(node.type === "stack" && node.active && path[i + 1] && node.active !== path[i + 1].id));
}
