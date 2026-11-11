// scripts/ansi-svg.mjs, which turns the panel's frames into the README's pictures:
// fixed escape sequences in, SVG out. No gh, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { CELL, PAD_X, THEME, parseLine, screenLines, toSvg } from "../scripts/ansi-svg.mjs";

const { width } = createRequire(import.meta.url)("../panel.js");
const E = "\x1b[";
const texts = (svg) => [...svg.matchAll(/<text x="([\d.]+)" y="(\d+)" ([^>]*)>([^<]*)<\/text>/g)].slice(1)
  .map(([, x, y, attrs, text]) => ({ x: Number(x), y: Number(y), attrs, text }));
const round = (n) => Math.round(n * 10) / 10;
const at = (col) => round(PAD_X + col * CELL);

test("screenLines: each row of a painted frame, unpainted rows empty", () => {
  const frame = `${E}?2026h${E}1;1H${E}1mrepo${E}0m${E}0m${E}K${E}3;1Hthird${E}0m${E}K${E}9;1Hoff screen${E}0m${E}K${E}J${E}?2026l`;
  assert.deepEqual(screenLines(frame, 4), [`${E}1mrepo${E}0m`, "", "third", ""]);
});

test("parseLine: colors, bold, faint and 24-bit colors, each run at its cell", () => {
  const runs = parseLine(`${E}36m▌${E}0m ${E}1mTitle${E}0m ${E}2mbody${E}0m ${E}38;2;0;117;202m●${E}0m ${E}90mx${E}0m`, width);
  assert.deepEqual(runs.map((r) => [r.col, r.text, r.style.fg, r.style.bold, r.style.faint]), [
    [0, "▌", THEME.colors[36], false, false],
    [1, " ", null, false, false],
    [2, "Title", null, true, false],
    [7, " ", null, false, false],
    [8, "body", null, false, true],
    [12, " ", null, false, false],
    [13, "●", "#0075ca", false, false],
    [14, " ", null, false, false],
    [15, "x", THEME.colors[90], false, false],
  ]);
});

test("parseLine: OSC 8 links take no cells and leave only their text", () => {
  const runs = parseLine(`a \x1b]8;;https://github.com/o/p/issues/1\x1b\\${E}1mlinked${E}0m\x1b]8;;\x1b\\ b`, width);
  assert.equal(runs.map((r) => r.text).join(""), "a linked b");
  assert.deepEqual(runs.find((r) => r.text === "linked")?.col, 2);
  assert.ok(!runs.some((r) => r.text.includes("\x1b") || r.text.includes("https")));
});

test("parseLine: a wide character takes two cells, in a run of its own", () => {
  const runs = parseLine("a漢b😀c", width);
  assert.deepEqual(runs.map((r) => [r.col, r.cells, r.text]), [[0, 1, "a"], [1, 2, "漢"], [3, 1, "b"], [4, 2, "😀"], [6, 1, "c"]]);
});

test("toSvg: an inverse run is a box in the text's color, its text in the background's", () => {
  const svg = toSvg([`ab${E}7m${E}1m Issues 1 ${E}0m${E}0m`], { cols: 20, rows: 1, width });
  assert.match(svg, new RegExp(`<rect x="${at(2).toFixed(1)}" y="44" width="${round(10 * CELL).toFixed(1)}" height="20" fill="${THEME.fg}"/>`));
  const issues = texts(svg).find((t) => t.text === " Issues 1 ");
  assert.ok(issues, svg);
  assert.equal(issues.x, at(2));
  assert.match(issues.attrs, new RegExp(`fill="${THEME.bg}" font-weight="bold"`));
});

test("toSvg: text is escaped for XML, and characters XML can't hold are dropped", () => {
  const svg = toSvg([`<a & "b">\x01`], { cols: 20, rows: 1, width, title: "t & <u>", label: `"x"` });
  assert.ok(svg.includes(">&lt;a &amp; &quot;b&quot;&gt;</text>"), svg);
  assert.ok(svg.includes(`aria-label="&quot;x&quot;"`) && svg.includes("<title>&quot;x&quot;</title>"));
  assert.ok(svg.includes(">t &amp; &lt;u&gt;</text>"));
  assert.ok(!svg.includes("\x01") && !svg.includes("<a "));
});

test("toSvg: faint text is see-through, spaces around text draw nothing, and the window fits the pane", () => {
  const svg = toSvg(["", `   ${E}2m  faint ${E}0m   `], { cols: 64, rows: 2, width });
  assert.match(svg, /^<svg [^>]*width="576" height="100" viewBox="0 0 576 100"/);
  const [faint] = texts(svg);
  assert.deepEqual([faint.text, faint.x, faint.y], ["faint", at(5), 40 + 20 + 19]);
  assert.match(faint.attrs, /fill-opacity="0.6"/);
  assert.match(faint.attrs, new RegExp(`textLength="${round(5 * CELL).toFixed(1)}"`));
});
