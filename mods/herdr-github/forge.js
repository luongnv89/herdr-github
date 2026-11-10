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

// Why a program didn't start, in a few words.
export function cantRun(cli, e) {
  const text = String(e?.message ?? e ?? "");
  return /ENOENT|not found|No such file/i.test(text) ? `${cli} isn't installed` : `Can't run ${cli}: ${text}`;
}

// ── Agent actions ───────────────────────────────────────────────────────────
// The selected issue can be handed to the issue-resolver skill, the selected pull
// request to issue-pr-review: a new tab runs the same kind of agent as yours,
// prompted with the skill and the bare number, nothing else from the row.

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

// Built from the skill name and an integer only: never from a title or body.
export function promptFor(kind, skill, action) {
  if (!isNumber(action.number)) throw new Error("not a number");
  return kind === "claude" ? `/${skill} ${action.number}` : `Use the ${skill} skill on ${action.noun} #${action.number}.`;
}

const safeName = (n) => typeof n === "string" && /^[\w.-]+$/.test(n) ? n : null;
const join = (...parts) => parts.join("/").replace(/\/+/g, "/");

// How to call `skill` for an agent of `kind` working in `root`: its name, or
// "plugin:name" when Claude has it only from a plugin; null when it isn't found.
// Folders are checked for every kind, since a wrong "not installed" is the worse mistake.
// `io` reads the agent's machine: { home, read(path) → text | null, dirs(path) → [subfolder paths] }.
export async function findSkill(kind, skill, root, io) {
  const { home } = io;
  const read = (p) => Promise.resolve(io.read(p)).catch(() => null);
  const json = async (p) => { try { const t = await read(p); return t == null ? null : JSON.parse(t); } catch { return null; } };
  const has = async (dir) => (await read(join(dir, "SKILL.md"))) != null;

  const folders = [".claude", ".agents", ".codex", `.${kind}`].flatMap((d) => [join(home, d, "skills"), ...(root ? [join(root, d, "skills")] : [])]);
  if ((await Promise.all(folders.map((f) => has(join(f, skill))))).some(Boolean)) return skill;
  if (kind !== "claude") return null;

  // Claude plugins: the installed ones (installed_plugins.json) that settings.json
  // doesn't disable, each with <installPath>/skills/<skill>, and synced ones, laid
  // out as plugins/synced/<account>/<plugin>/<skill>. A cached copy alone doesn't count.
  const plugins = join(home, ".claude", "plugins");
  const enabled = { ...(await json(join(home, ".claude", "settings.json")))?.enabledPlugins };
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
