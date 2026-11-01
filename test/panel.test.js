"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
// Record what the panel would open instead of starting a browser. panel.js reads
// spawn when it loads, so this has to come before the require below.
const opened = [];
require("node:child_process").spawn = (cmd, args) => { opened.push(args[0]); return { on() { return this; }, unref() {} }; };
const { width, fit, wrap, ago, checks, clean, plain, prRow, issueRow, FORGES, remoteHost, pickHost, forgesFor, firstLine, ui, draw, click, onInput } = require("../panel.js");

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
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
  assert.deepEqual(p, { ref: "#3", title: "Fix", body: "Because", author: "ann", branch: "fix", draft: true, review: "changes", checks: "pending", updatedAt: "2026-01-01T00:00:00Z", url: "u" });
  const i = github.toIssue({ number: 4, title: "Bug", body: "", author: { login: "ann" }, labels: [{ name: "bug", color: "d73a4a" }], updatedAt: "t", url: "u" });
  assert.deepEqual(i.labels, [{ name: "bug", color: "d73a4a" }]);
  assert.equal(i.ref, "#4");
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
    ref: "!4270", title: "fix(release): keep notes", body: "Keeps the notes .", author: "amegahed12", branch: "8703-keep",
    draft: false, review: "changes", checks: null, updatedAt: mr.updated_at, url: mr.web_url,
  });
  assert.equal(gitlab.toPr({ ...mr, detailed_merge_status: "mergeable" }).review, null);
  assert.equal(gitlab.toPr({ ...mr, draft: undefined, work_in_progress: true }).draft, true);
  const issue = { iid: 9, title: "Crash", description: null, author: { username: "bob" }, labels: ["bug", "type::feature"], updated_at: "t", web_url: "u" };
  const i = gitlab.toIssue(issue, { bug: "#d9534f" });
  assert.deepEqual(i, { ref: "#9", title: "Crash", body: "", author: "bob", labels: [{ name: "bug", color: "d9534f" }, { name: "type::feature", color: "" }], updatedAt: "t", url: "u" });
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
  const { write } = process.stdout, cols = process.stdout.columns, rows = process.stdout.rows;
  let frame = "";
  process.stdout.write = (s) => { frame = s; return true; };
  process.stdout.columns = 60; process.stdout.rows = 24;
  try { fn(); } finally { Object.assign(process.stdout, { write, columns: cols, rows }); }
  const lines = [];
  for (const m of frame.matchAll(/\x1b\[(\d+);1H(.*?)\x1b\[0m\x1b\[K/g)) lines[m[1] - 1] = strip(m[2]);
  return lines;
}

const items = (kind) => Array.from({ length: 10 }, (_, i) => ({
  ref: `#${i}`, title: `Title ${i}`, body: `Body ${i}`, author: "a", labels: [], updatedAt: iso(60), url: `https://x/${kind}/${i}`,
}));

function setup(view) {
  Object.assign(ui, {
    view, prs: items("pull"), issues: items("issues"), errors: {}, error: null, repo: { name: "o/p", url: "https://x/o/p" },
    loading: false, fetched: true, follow: false, sel: { prs: 0, issues: 0 }, top: { prs: 0, issues: 0 },
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
