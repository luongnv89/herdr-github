"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { width, fit, wrap, ago, checks, clean, plain, prRow, issueRow } = require("../panel.js");

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
  number: 12, title: "Add a much longer title that needs to wrap across more than one line of the panel",
  body: "Body text", author: { login: "alice" }, headRefName: "feat/x", isDraft: false,
  updatedAt: iso(7200), reviewDecision: "APPROVED", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
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
  assert.match(prRow({ ...pr, isDraft: true }, false, 80).map(strip).at(-1), /\[Draft\]/);
});

test("issueRow shows up to 3 labels and an empty body", () => {
  const issue = {
    number: 7, title: "Crash", body: "", author: { login: "bob" }, updatedAt: iso(60),
    labels: ["bug", "p1", "ui", "extra"].map((name) => ({ name, color: "d73a4a" })),
  };
  const lines = issueRow(issue, false, 80).map(strip);
  assert.equal(lines[1].trim(), "No description");
  assert.match(lines.at(-1), /● bug ● p1 ● ui 1m$/);
  assert.doesNotMatch(lines.at(-1), /extra/);
});
