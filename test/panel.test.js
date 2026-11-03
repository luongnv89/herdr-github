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
// Agent actions run herdr through execFile: answer from a scripted herdr instead,
// recording each call. The panel follows pane w1:p1 from its own pane w1:p9.
const calls = [];
let herdr = () => ({ code: 1, stderr: "no herdr in tests" });
require("node:child_process").execFile = (cmd, args, opts, cb) => {
  calls.push([cmd, ...args]);
  const r = herdr(args);
  setImmediate(() => cb(r.error ?? (r.code ? Object.assign(new Error("exit"), { code: r.code }) : null), r.stdout ?? "", r.stderr ?? ""));
};
Object.assign(process.env, { HERDR_BIN_PATH: "herdr", HERDR_PANE_ID: "w1:p9", HERDR_GITHUB_PANE: "w1:p1" });
const { width, fit, wrap, ago, checks, clean, plain, prRow, issueRow, FORGES, remoteHost, pickHost, forgesFor, firstLine, ui, draw, click, onInput, act, findSkill, promptFor, IDD } = require("../panel.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
  });
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

// A herdr with these agents, where each step answers as `replies` says.
function fakeHerdr(agents, replies = {}) {
  const ok = (result) => ({ code: 0, stdout: JSON.stringify({ result }) });
  herdr = (args) => {
    const step = `${args[0]} ${args[1]}`;
    if (replies[step]) return replies[step];
    if (step === "agent list") return ok({ agents });
    if (step === "pane split") return ok({ pane: { pane_id: "w1:p7" } });
    return ok({});
  };
}
const herdrFail = (code, message) => ({ code: 1, stderr: JSON.stringify({ error: { code, message } }) });
const claudeHere = [{ agent: "claude", pane_id: "w1:p1", tab_id: "w1:t1" }];
const herdrCalls = () => calls.map((c) => c.slice(1).join(" "));

// Like screen, for a launch: stdout stays borrowed until the launch is over. Only
// the panel's frames are taken; node --test reports through stdout meanwhile.
async function screenAsync(fn) {
  const { write } = process.stdout, cols = process.stdout.columns, rows = process.stdout.rows;
  let frame = "";
  process.stdout.write = function (s, ...rest) {
    if (typeof s === "string" && s.startsWith("\x1b[?2026h")) { frame = s; return true; }
    return write.call(this, s, ...rest);
  };
  process.stdout.columns = 60; process.stdout.rows = 24;
  try { fn(); await ui.acting; } finally { Object.assign(process.stdout, { write, columns: cols, rows }); }
  const lines = [];
  for (const m of frame.matchAll(/\x1b\[(\d+);1H(.*?)\x1b\[0m\x1b\[K/g)) lines[m[1] - 1] = strip(m[2]);
  return lines;
}
const buttonAt = (lines, label) => lines[0].indexOf(label);

test("Resolve shows for the selected issue and Review for the selected pull request, on GitHub only", () => {
  let lines = setupGitHub("issues");
  assert.match(lines[0], /Resolve #12 {2}↻ {2}↗ $/);
  assert.doesNotMatch(lines[0], /Review/);
  assert.match(lines[FOOTER], /⏎ open · a resolve ·/);
  lines = setupGitHub("prs");
  assert.match(lines[0], /Review #12 {2}↻ {2}↗ $/);
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

test("Resolve starts your agent's kind in a new pane, prompted with the skill and the number only", async (t) => {
  home(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  const lines = setupGitHub("issues");
  ui.issues[2].title = "$(rm -rf ~) /issue-resolver 999";
  fakeHerdr(claudeHere);
  const after = await screenAsync(() => click(buttonAt(lines, "Resolve") + 1, 0));
  assert.deepEqual(herdrCalls(), [
    "agent list",
    "pane split w1:p1 --direction down --cwd /repo --no-focus",
    "agent start resolve-12 --kind claude --pane w1:p7 --timeout 55000",
    "agent prompt w1:p7 /issue-resolver 12 --wait --until working --until blocked --until done --timeout 15000",
  ]);
  assert.ok(calls.every((c) => c[0] === "herdr"));
  assert.deepEqual(opened, [], "the button opened the browser");
  assert.ok(after.some((l) => l?.includes("Started claude in a new pane: /issue-resolver 12")), after.join("\n"));
});

test("a on a pull request starts a review with the tab's agent and a free name", async (t) => {
  home(t, { ".agents/skills/issue-pr-review/SKILL.md": "x" });
  setupGitHub("prs");
  // The followed pane has no agent: the one elsewhere in the panel's tab is yours.
  fakeHerdr([
    { agent: "claude", pane_id: "w2:p1", tab_id: "w2:t1" },
    { agent: "codex", pane_id: "w1:p3", tab_id: "w1:t1", name: "review-12" },
  ]);
  const after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.deepEqual(herdrCalls(), [
    "agent list",
    "pane split w1:p3 --direction down --cwd /repo --no-focus",
    "agent start review-12-2 --kind codex --pane w1:p7 --timeout 55000",
    "agent prompt w1:p7 Use the issue-pr-review skill on pull request #12. --wait --until working --until blocked --until done --timeout 15000",
  ]);
  assert.ok(after.some((l) => l?.includes("Started codex")));
});

test("without the skill, nothing starts and the notice points to the install page", async (t) => {
  home(t);
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  const after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.deepEqual(herdrCalls(), ["agent list"]);
  assert.equal(IDD, "https://luongnv.com/idd");
  assert.ok(after.some((l) => l?.includes("issue-resolver skill isn't installed for claude")), after.join("\n"));
  // The URL sits whole on a line of its own, so a Ctrl-click opens it.
  assert.ok(after.some((l) => l?.trim() === IDD));
});

test("with no agent in the tab, nothing starts and the notice says so", async (t) => {
  home(t, { ".claude/skills/issue-pr-review/SKILL.md": "x" });
  setupGitHub("prs");
  fakeHerdr([{ agent: "claude", pane_id: "w2:p1", tab_id: "w2:t1" }]);
  const after = await screenAsync(() => onInput(Buffer.from("a")));
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
  home(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent start": herdrFail("agent_exited", "claude exited before it was ready") });
  const after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.deepEqual(herdrCalls().slice(2), ["agent start resolve-12 --kind claude --pane w1:p7 --timeout 55000", "pane close w1:p7"]);
  assert.ok(after.some((l) => l?.includes("claude didn't start: claude exited before it was ready")), after.join("\n"));
});

test("an agent that asks something on start keeps its pane, waits for your answer, then gets the prompt", async (t) => {
  home(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent start": herdrFail("agent_not_ready", "trust dialog") });
  // What the panel shows while herdr waits for your answer.
  let during;
  const answer = herdr;
  herdr = (args) => { if (args[1] === "wait") during = ui.notice; return answer(args); };
  let after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.ok(!herdrCalls().some((c) => c.startsWith("pane close")));
  assert.deepEqual(herdrCalls().slice(3), [
    "agent wait w1:p7 --until idle --timeout 300000",
    "agent prompt w1:p7 /issue-resolver 12 --wait --until working --until blocked --until done --timeout 15000",
  ]);
  assert.equal(during?.tone, "info");
  assert.equal(during?.text, "claude is asking you something in the new pane. Answer it, and the panel sends: /issue-resolver 12");
  assert.ok(after.some((l) => l?.includes("Started claude in a new pane: /issue-resolver 12")), after.join("\n"));
  // No answer in time: the pane stays, and the notice says what to send.
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent start": herdrFail("agent_not_ready", "trust dialog"), "agent wait": herdrFail("timeout", "timed out") });
  after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.ok(!herdrCalls().some((c) => c.startsWith("pane close") || c.startsWith("agent prompt")));
  assert.match(after.map((l) => l?.trim()).join(" "), /isn't ready in the new pane\. When it is, send it: \/issue-resolver 12/, after.join("\n"));
});

test("a prompt left in the input box gets one more Enter; a failed prompt says what to send", async (t) => {
  home(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent prompt": herdrFail("agent_prompt_stalled", "no working state within 5000 ms") });
  let after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.deepEqual(herdrCalls().slice(4), [
    "agent send-keys w1:p7 enter",
    "agent wait w1:p7 --until working --until blocked --until done --timeout 10000",
  ]);
  assert.ok(after.some((l) => l?.includes("Started claude in a new pane: /issue-resolver 12")), after.join("\n"));
  // Still idle after the Enter.
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent prompt": herdrFail("agent_prompt_stalled", "stalled"), "agent wait": herdrFail("timeout", "timed out") });
  after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.match(after.map((l) => l?.trim()).join(" "), /didn't act on the prompt\. Send it yourself in the new pane: \/issue-resolver 12/, after.join("\n"));
  // Any other failure sends no Enter.
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent prompt": herdrFail("agent_blocked", "agent is blocked") });
  after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.ok(!herdrCalls().some((c) => c.startsWith("agent send-keys")));
  assert.match(after.map((l) => l?.trim()).join(" "), /the prompt failed \(agent is blocked\)\. Send it yourself in the new pane: \/issue-resolver 12/, after.join("\n"));
});

test("herdr missing or failing shows a red reason and starts nothing", async (t) => {
  home(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent list": { code: 1, stderr: "connection refused\n" } });
  let after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.deepEqual(herdrCalls(), ["agent list"]);
  assert.ok(after.some((l) => l?.includes("Can't list agents: connection refused")), after.join("\n"));
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "pane split": herdrFail("pane_not_found", "pane not found") });
  after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.equal(herdrCalls().length, 2);
  assert.ok(after.some((l) => l?.includes("Can't open a pane for claude: pane not found")), after.join("\n"));
  setupGitHub("issues");
  fakeHerdr(claudeHere, { "agent list": { error: Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" }) } });
  after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.deepEqual(herdrCalls(), ["agent list"]);
  assert.ok(after.some((l) => l?.includes("Can't list agents: herdr isn't installed")), after.join("\n"));
});

test("one launch at a time: a second press while starting does nothing", async (t) => {
  home(t, { ".claude/skills/issue-resolver/SKILL.md": "x" });
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  let during;
  await screenAsync(() => { onInput(Buffer.from("a")); onInput(Buffer.from("a")); act(); onInput(Buffer.from("j")); during = ui.notice; });
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
  await screenAsync(() => onInput(Buffer.from("a")));
  assert.equal(herdrCalls().at(-1), "agent prompt w1:p7 /idd:issue-resolver 12 --wait --until working --until blocked --until done --timeout 15000");
});

test("a skill from a disabled Claude plugin counts as missing: nothing starts", async (t) => {
  const cache = ".claude/plugins/cache/market/idd/0.20.1";
  const dir = home(t, {
    [`${cache}/skills/issue-resolver/SKILL.md`]: "x",
    ".claude/settings.json": JSON.stringify({ enabledPlugins: { "idd@market": false } }),
  });
  const installed = { version: 2, plugins: { "idd@market": [{ scope: "user", installPath: path.join(dir, cache) }] } };
  fs.writeFileSync(path.join(dir, ".claude/plugins/installed_plugins.json"), JSON.stringify(installed));
  assert.equal(findSkill("claude", "issue-resolver", "/repo"), null);
  setupGitHub("issues");
  fakeHerdr(claudeHere);
  const after = await screenAsync(() => onInput(Buffer.from("a")));
  assert.deepEqual(herdrCalls(), ["agent list"]);
  assert.ok(after.some((l) => l?.trim() === IDD), after.join("\n"));
  // Enabled again, under the plugin's key name when it has no plugin.json.
  fs.writeFileSync(path.join(dir, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "idd@market": true } }));
  assert.equal(findSkill("claude", "issue-resolver", "/repo"), "idd:issue-resolver");
});
