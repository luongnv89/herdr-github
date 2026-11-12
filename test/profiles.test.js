"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const P = require("../profiles.cjs");

const SOURCE = path.join(__dirname, "..", "mods", "herdr-github", "profiles.js");
// The app mod's ES module itself, loaded the way it has no imports to resolve.
const esm = () => import(`data:text/javascript;base64,${fs.readFileSync(SOURCE).toString("base64")}`);

const ok = (p) => ({ id: "p", name: "Profile", ...p });
const PROMPT = "/issue-resolver 12";

test("a valid profile for each harness passes; empty model and thinking are fine", () => {
  for (const harness of P.HARNESSES) {
    assert.deepEqual(P.validateProfile(ok({ harness })), [], harness);
    assert.deepEqual(P.validateProfile(ok({ harness, model: "", thinking: null })), [], harness);
  }
  assert.deepEqual(P.validateProfile(ok({ harness: "pi", model: "anthropic/claude-sonnet-4.5", thinking: "minimal" })), []);
  assert.deepEqual(P.validateProfile(ok({ harness: "codex", model: "gpt-5.1-codex@latest+x:y_z" })), []);
  assert.deepEqual(P.validateProfile(P.DEFAULT_PROFILE), []);
});

test("ids, names, harnesses, models and thinking levels outside their rules are refused", () => {
  for (const id of ["", "-x", "A", "a b", "a_b", "x".repeat(33), 5, undefined]) assert.ok(P.validateProfile(ok({ id, harness: "claude" })).some((e) => e.startsWith("Id")), String(id));
  for (const name of ["", "   ", "x".repeat(41), "a\nb", "a\x1b[2Jb", undefined]) assert.ok(P.validateProfile(ok({ name, harness: "claude" })).some((e) => e.startsWith("Name")), JSON.stringify(name));
  for (const harness of ["gemini", "", undefined, "Claude"]) assert.ok(P.validateProfile(ok({ harness })).some((e) => e.startsWith("Harness")), String(harness));
  // Shell text never fits a model or a thinking level.
  const shell = ["$(id)", "a;id", "a`id`", "a'b", "a\nb", "a b", "-x", "opus[1m]", 'a"b', "a|b", "a&b", "a>b", "~x", "a\\b"];
  for (const harness of P.HARNESSES) {
    for (const v of shell) {
      assert.ok(P.validateProfile(ok({ harness, model: v })).some((e) => e.startsWith("Model")), `${harness} model ${JSON.stringify(v)}`);
      assert.ok(P.validateProfile(ok({ harness, thinking: v })).some((e) => e.startsWith("Thinking")), `${harness} thinking ${JSON.stringify(v)}`);
    }
  }
  // Each harness takes its own levels only.
  assert.ok(P.validateProfile(ok({ harness: "codex", thinking: "max" })).length);
  assert.ok(P.validateProfile(ok({ harness: "claude", thinking: "minimal" })).length);
  assert.deepEqual(P.validateProfile(ok({ harness: "pi", thinking: "off" })), []);
  assert.deepEqual(P.validateProfile(ok({ harness: "opencode", thinking: "high" })), [], "OpenCode ignores the level, so it is kept");
  assert.deepEqual(P.validateProfile(null), ["A profile must be an object"]);
});

test("each harness's launch: flags after --, or mcc run with the prompt last", () => {
  const launch = (p) => P.buildLaunch(ok(p), PROMPT);
  assert.deepEqual(launch({ harness: "claude", model: "sonnet", thinking: "high" }), { mode: "agent", kind: "claude", extraArgs: ["--model", "sonnet", "--effort", "high"], warnings: [] });
  assert.deepEqual(launch({ harness: "codex", model: "gpt-5", thinking: "xhigh" }).extraArgs, ["-m", "gpt-5", "-c", 'model_reasoning_effort="xhigh"']);
  assert.deepEqual(launch({ harness: "pi", model: "m", thinking: "off" }).extraArgs, ["--model", "m", "--thinking", "off"]);
  assert.deepEqual(launch({ harness: "mcc", model: "opus", thinking: "max" }), { mode: "command", argv: ["mcc", "run", "--", "--model", "opus", "--effort", "max", PROMPT], warnings: [] });
  // Empty model and thinking: no flags, so the harness's own defaults hold.
  for (const harness of ["claude", "codex", "pi", "opencode"]) assert.deepEqual(launch({ harness, model: "", thinking: "" }).extraArgs, [], harness);
  assert.deepEqual(launch({ harness: "mcc" }).argv, ["mcc", "run", "--", PROMPT]);
  assert.deepEqual(launch({ harness: "claude", model: "sonnet" }).extraArgs, ["--model", "sonnet"]);
  assert.deepEqual(launch({ harness: "codex", thinking: "low" }).extraArgs, ["-c", 'model_reasoning_effort="low"']);
});

test("OpenCode starts without flags, and says its model and thinking level are ignored", () => {
  const l = P.buildLaunch(ok({ harness: "opencode", model: "x", thinking: "high" }), PROMPT);
  assert.deepEqual([l.mode, l.kind, l.extraArgs], ["agent", "opencode", []]);
  assert.equal(l.warnings.length, 1);
  assert.equal(l.warnings[0], "OpenCode ignores this profile's model and thinking level: it has no flag for them when it starts");
  assert.deepEqual(P.buildLaunch(ok({ harness: "opencode" }), PROMPT).warnings, []);
});

test("buildLaunch checks its own input and throws on a bad profile or prompt", () => {
  for (const bad of ["$(id)", "a;id", "a`id`", "a'b", "a\nb", "a b"]) {
    for (const harness of P.HARNESSES) {
      assert.throws(() => P.buildLaunch({ id: "x", name: "X", harness, model: bad }, PROMPT), /Invalid profile/);
      assert.throws(() => P.buildLaunch({ id: "x", name: "X", harness, thinking: bad }, PROMPT), /Invalid profile/);
    }
  }
  // A prompt is one argument that no shell reads, so shell text in it is just text
  // (#20: custom prompts); it goes last, as is.
  for (const text of ["$(id)", "a;id", "a`id`", "a'b", "a b", 'say "hi" & | > < ~ * ? é 日本']) {
    const prompt = `/issue-resolver ${text}`;
    assert.deepEqual(P.buildLaunch(P.DEFAULT_PROFILE, prompt).argv, ["mcc", "run", "--", prompt], text);
    assert.equal(P.buildLaunch({ id: "c", name: "C", harness: "claude" }, prompt).mode, "agent", text);
  }
  // What a pane's shell, the agent's input box or a flag parser would take for more
  // than text never gets through: line breaks, control, invisible and bidi
  // characters, a backslash, a leading - ! or #, nothing at all, or too much.
  const refused = {
    "a\nb": /no control/, "a\rb": /no control/, "a\tb": /no control/, "a\x1b[2Jb": /no control/, "a\x7fb": /no control/,
    "a\u2028b": /no control/, "a\u2029b": /no control/, "a\u200bb": /no control/, "a\u202eb": /no control/, "a\ufeffb": /no control/,
    "a\u2066b": /no control/, "a\ue000b": /no control/, "a\ud800b": /no control/, "a\\b": /backslashes/,
    "-x 12": /can't start with/, "!id": /can't start with/, "# 12": /can't start with/, "  -x": /can't start with/,
    "": /can't be empty/, "   ": /can't be empty/, ["x".repeat(501)]: /at most 500/,
    // At either end too: the text is sent as is, not trimmed.
    "a\n": /no control/, "\tx": /no control/, "x\t": /no control/, "\ufeffx": /no control/, "x\u2028": /no control/,
    "\rx": /no control/, "x\v": /no control/, "\fx": /no control/, "\u2029x": /no control/,
    "x ": /no spaces at either end/, " x": /no spaces at either end/, "x\u00a0": /no spaces at either end/, "\u3000x": /no spaces at either end/,
  };
  for (const [prompt, why] of Object.entries(refused)) {
    assert.throws(() => P.buildLaunch(P.DEFAULT_PROFILE, prompt), (e) => /^Invalid prompt: /.test(e.message) && why.test(e.message), JSON.stringify(prompt));
    assert.ok(P.validatePrompt(prompt).some((r) => why.test(r)), JSON.stringify(prompt));
  }
  assert.deepEqual(P.validatePrompt("x".repeat(500)), []);
  assert.deepEqual(P.validatePrompt("\u{1d538}".repeat(500)), [], "characters, not UTF-16 units");
  for (const v of [null, undefined, 12, ["a"]]) assert.throws(() => P.buildLaunch(P.DEFAULT_PROFILE, v), /Invalid prompt: must be text/);
  assert.throws(() => P.buildLaunch(null, PROMPT), /Invalid profile/);
  // The IDD skills' own prompts, for every harness, still pass.
  for (const prompt of [PROMPT, "/idd:issue-pr-review 4", "Use the idd:issue-pr-review skill on pull request #4.", "Use the issue-resolver skill on issue #9007199254740991."]) {
    assert.deepEqual(P.validatePrompt(prompt), [], prompt);
  }
  assert.equal(P.buildLaunch(P.DEFAULT_PROFILE, "Use the idd:issue-pr-review skill on pull request #4.").mode, "command");
});

test("an action with no profile, or a missing one, gets Claude Code via mcc run", () => {
  assert.deepEqual({ ...P.DEFAULT_PROFILE }, { id: "default", name: "Claude Code via mcc run", harness: "mcc" });
  assert.equal(P.resolveProfile(P.emptyStore(), "resolve"), P.DEFAULT_PROFILE);
  assert.equal(P.resolveProfile(undefined, "review"), P.DEFAULT_PROFILE);
  const mine = ok({ id: "mine", harness: "pi" });
  const store = { ...P.emptyStore(), profiles: [mine], assign: { resolve: "mine", review: "gone" } };
  assert.equal(P.resolveProfile(store, "resolve"), mine);
  assert.equal(P.resolveProfile(store, "review"), P.DEFAULT_PROFILE);
});

test("profileChoices: the default alone with no profiles; the default first, then every profile", () => {
  // Nothing to choose: one entry, the default.
  assert.deepEqual(P.profileChoices(P.emptyStore(), "resolve"), { entries: [P.DEFAULT_PROFILE], sel: 0 });
  assert.deepEqual(P.profileChoices(undefined, "review"), { entries: [P.DEFAULT_PROFILE], sel: 0 });
  const a = ok({ id: "a", name: "A", harness: "pi" }), b = ok({ id: "b", name: "B", harness: "codex" });
  const store = { ...P.emptyStore(), profiles: [a, b], assign: { resolve: "b", review: null } };
  const { entries } = P.profileChoices(store, "resolve");
  assert.deepEqual(entries.map((p) => p.id), ["default", "a", "b"]);
  assert.equal(entries[0], P.DEFAULT_PROFILE);
});

test("profileChoices highlights the action's own profile; none, or a missing one, highlights the default", () => {
  const a = ok({ id: "a", name: "A", harness: "pi" }), b = ok({ id: "b", name: "B", harness: "codex" });
  const store = { ...P.emptyStore(), profiles: [a, b], assign: { resolve: "b", review: "a" } };
  assert.equal(P.profileChoices(store, "resolve").sel, 2);
  assert.equal(P.profileChoices(store, "review").sel, 1);
  assert.equal(P.profileChoices({ ...store, assign: { resolve: null, review: null } }, "resolve").sel, 0);
  assert.equal(P.profileChoices({ ...store, assign: { resolve: "gone", review: null } }, "resolve").sel, 0);
});

test("findChoice finds the default and your profiles by id, and nothing for an unknown one", () => {
  const a = ok({ id: "a", name: "A", harness: "pi" });
  const store = { ...P.emptyStore(), profiles: [a] };
  assert.equal(P.findChoice(store, "default"), P.DEFAULT_PROFILE);
  assert.equal(P.findChoice(P.emptyStore(), "default"), P.DEFAULT_PROFILE);
  assert.equal(P.findChoice(store, "a"), a);
  assert.equal(P.findChoice(store, "gone"), null);
  assert.equal(P.findChoice(P.emptyStore(), "a"), null);
  assert.equal(P.findChoice(undefined, "a"), null);
});

test("the store path is one fixed file under home, whatever the environment says", async () => {
  const E = await esm();
  for (const home of ["/home/me", "/home/me/", "/Users/a b"]) {
    const file = `${home.replace(/\/$/, "")}/.config/herdr/plugins/config/herdr-github/profiles.json`;
    assert.equal(P.storePath(home), file);
    assert.equal(E.storePath(home), file);
  }
  const before = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, HERDR_PLUGIN_CONFIG_DIR: process.env.HERDR_PLUGIN_CONFIG_DIR };
  Object.assign(process.env, { XDG_CONFIG_HOME: "/elsewhere", HERDR_PLUGIN_CONFIG_DIR: "/other" });
  try { assert.equal(P.storePath("/h"), "/h/.config/herdr/plugins/config/herdr-github/profiles.json"); }
  finally { for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  assert.throws(() => P.storePath(""));
});

test("parseStore: no file is empty; bad JSON or another version is read only", () => {
  for (const text of [null, undefined, "", "  \n"]) assert.deepEqual(P.parseStore(text), { store: P.emptyStore(), warnings: [], readOnly: false });
  for (const text of ["{", "[]", "null", "42"]) {
    const r = P.parseStore(text);
    assert.equal(r.readOnly, true, text);
    assert.deepEqual(r.store, P.emptyStore());
    assert.match(r.warnings[0], /isn't valid JSON/);
  }
  // Version 2 holds custom prompts (#20) and is read; a newer one is read only.
  const newer = P.parseStore(JSON.stringify({ version: 3, profiles: [ok({ harness: "pi" })], assign: { resolve: "p" } }));
  assert.equal(newer.readOnly, true);
  assert.equal(newer.warnings[0], "The profiles file is version 3, not 1 or 2: it is read only here");
  assert.equal(P.resolveProfile(newer.store, "resolve").harness, "pi");
});

test("parseStore skips bad, duplicate and reserved profiles, drops a missing assignment, and is then read only", () => {
  const text = JSON.stringify({
    version: 1,
    profiles: [
      ok({ id: "a", harness: "codex", model: "gpt-5", extra: "dropped" }),
      ok({ id: "b", harness: "claude", model: "$(id)" }),
      ok({ id: "a", harness: "pi" }),
      ok({ id: "default", harness: "claude" }),
      "nonsense",
      ok({ id: "c", harness: "opencode", model: "" }),
    ],
    assign: { resolve: "b", review: "c" },
  });
  const { store, warnings, readOnly } = P.parseStore(text);
  // Saving would erase the skipped profiles and what they're assigned to.
  assert.equal(readOnly, true);
  assert.match(warnings[0], /read only here: fix or remove them to save/);
  assert.deepEqual(store.profiles, [{ id: "a", name: "Profile", harness: "codex", model: "gpt-5" }, { id: "c", name: "Profile", harness: "opencode" }]);
  assert.deepEqual(store.assign, { resolve: null, review: "c" });
  assert.equal(warnings.length, 6);
  assert.ok(warnings.some((w) => /"b".*Model/.test(w)));
  assert.ok(warnings.some((w) => /used twice/.test(w)));
  assert.ok(warnings.some((w) => /reserved/.test(w)));
  assert.ok(warnings.some((w) => /#5/.test(w)));
  assert.ok(warnings.some((w) => /resolve action's profile isn't there/.test(w)));
  // Only a missing assignment, or nothing wrong: still writable.
  const dangling = P.parseStore(JSON.stringify({ version: 1, profiles: [ok({ id: "a", harness: "pi" })], assign: { resolve: "gone" } }));
  assert.equal(dangling.readOnly, false);
  assert.equal(dangling.warnings.length, 1);
  // Profiles that aren't a list are read only too.
  const notList = P.parseStore(JSON.stringify({ version: 1, profiles: { a: 1 } }));
  assert.equal(notList.readOnly, true);
  assert.match(notList.warnings[0], /read only here/);
  // Another version says so first, and only once (version 2 is read since #20).
  const both = P.parseStore(JSON.stringify({ version: 3, profiles: ["x"] }));
  assert.match(both.warnings[0], /version 3/);
  assert.ok(!both.warnings.some((w) => /fix or remove them/.test(w)));
  // What it writes, it reads back the same.
  const again = P.parseStore(P.serializeStore(store));
  assert.deepEqual(again, { store, warnings: [], readOnly: false });
  assert.match(P.serializeStore(store), /^\{\n {2}"version": 1,/);
});

test("upsert, remove and assign keep the assignments consistent", () => {
  let s = P.upsertProfile(P.emptyStore(), ok({ id: "a", harness: "claude", model: "" }));
  assert.deepEqual(s.profiles, [{ id: "a", name: "Profile", harness: "claude" }]);
  s = P.assignProfile(P.assignProfile(s, "resolve", "a"), "review", "a");
  // Renaming the id carries its assignments.
  s = P.upsertProfile(s, ok({ id: "b", harness: "pi" }), "a");
  assert.deepEqual(s.profiles.map((p) => p.id), ["b"]);
  assert.deepEqual(s.assign, { resolve: "b", review: "b" });
  assert.throws(() => P.upsertProfile(s, ok({ id: "b", harness: "pi" })), /already exists/);
  assert.throws(() => P.upsertProfile(s, ok({ id: "default", harness: "pi" })), /reserved/);
  assert.throws(() => P.upsertProfile(s, ok({ id: "c", harness: "pi", model: "a b" })), /Model/);
  assert.throws(() => P.assignProfile(s, "resolve", "nope"), /No profile/);
  assert.throws(() => P.assignProfile(s, "merge", "b"), /No action/);
  assert.deepEqual(P.assignProfile(s, "review", "default").assign, { resolve: "b", review: null });
  const removed = P.removeProfile(s, "b");
  assert.deepEqual(removed, { ...P.emptyStore(), profiles: [], assign: { resolve: null, review: null } });
  assert.equal(s.profiles.length, 1, "the store passed in is left as it was");
});

test("a custom prompt fills in {number}, each time it appears, with an integer only", () => {
  assert.equal(P.expandPrompt("/issue-resolver {number}", 12), PROMPT);
  assert.equal(P.expandPrompt("Fix #{number}, then open a PR that closes #{number}.", 7), "Fix #7, then open a PR that closes #7.");
  assert.equal(P.expandPrompt("{number}{number}", 9007199254740991), "90071992547409919007199254740991");
  // Nothing else is a placeholder.
  assert.equal(P.expandPrompt("{title} {NUMBER} {number", 3), "{title} {NUMBER} {number");
  for (const n of [0, -1, 1.5, NaN, "12", "12; id", 2 ** 53, null]) assert.throws(() => P.expandPrompt("x {number}", n), /not a number/, String(n));
  assert.throws(() => P.expandPrompt(null, 1), /No prompt/);
});

test("setPrompt keeps a custom prompt per action, trimmed, and empty goes back to the default", () => {
  let s = P.setPrompt(P.emptyStore(), "resolve", "  Don't merge #{number}: $(id) `id` & é 日本  ");
  assert.deepEqual(s.prompts, { resolve: "Don't merge #{number}: $(id) `id` & é 日本", review: null });
  assert.equal(P.resolvePrompt(s, "resolve"), "Don't merge #{number}: $(id) `id` & é 日本");
  assert.equal(P.resolvePrompt(s, "review"), null);
  s = P.setPrompt(s, "review", "Review {number}");
  assert.deepEqual(s.prompts, { resolve: "Don't merge #{number}: $(id) `id` & é 日本", review: "Review {number}" });
  for (const empty of ["", "   ", null, undefined]) assert.equal(P.setPrompt(s, "review", empty).prompts.review, null, JSON.stringify(empty));
  assert.equal(P.resolvePrompt(undefined, "resolve"), null);
  assert.equal(P.resolvePrompt({ profiles: [], assign: {} }, "resolve"), null, "a store from before prompts");
  assert.throws(() => P.setPrompt(s, "merge", "x {number}"), /No action merge/);
  // Refused with the field's name first, so a view shows it under that field.
  const refused = {
    "Fix it": /^Resolve prompt: must contain \{number\}/,
    "a\nb {number}": /^Resolve prompt: no control/,
    "a\tb {number}": /^Resolve prompt: no control/,
    "a\u2028 {number}": /^Resolve prompt: no control/,
    "a\u200b {number}": /^Resolve prompt: no control/,
    "C:\\x {number}": /^Resolve prompt: no control.*backslashes/,
    "-p {number}": /^Resolve prompt: can't start with/,
    "!{number}": /^Resolve prompt: can't start with/,
    "#{number}": /^Resolve prompt: can't start with/,
    // 485 + a 16-digit number is 501: too long once filled in, though 493 as typed.
    [`${"x".repeat(485)}{number}`]: /^Resolve prompt: at most 500 characters, with the number filled in$/,
  };
  for (const [text, why] of Object.entries(refused)) assert.throws(() => P.setPrompt(s, "resolve", text), (e) => why.test(e.message), JSON.stringify(text));
  assert.equal(P.setPrompt(s, "resolve", `${"x".repeat(484)}{number}`).prompts.resolve.length, 492);
  // Two reasons, each named, as the profile form splits them.
  assert.throws(() => P.setPrompt(s, "review", "-x"), { message: "Review prompt: must contain {number}, where the number goes; Review prompt: can't start with -, ! or #" });
  assert.deepEqual(P.validatePromptTemplate("x {number}"), []);
  assert.deepEqual(P.validatePromptTemplate(5), ["must be text"]);
  assert.equal(s.prompts.review, "Review {number}", "the store passed in is left as it was");
});

test("prompts: version 1 without them, version 2 with them, and a bad one makes the file read only", () => {
  const base = P.upsertProfile(P.emptyStore(), ok({ id: "a", harness: "pi" }));
  // No prompt: version 1 as before, with no prompts key, so older panels still save.
  const v1 = P.serializeStore(base);
  assert.deepEqual(JSON.parse(v1), { version: 1, profiles: [{ id: "a", name: "Profile", harness: "pi" }], assign: { resolve: null, review: null } });
  assert.deepEqual(P.parseStore(v1), { store: base, warnings: [], readOnly: false });
  // A prompt: version 2, read back the same.
  const custom = P.setPrompt(base, "review", "Review PR #{number} without merging it");
  const v2 = P.serializeStore(custom);
  assert.deepEqual(JSON.parse(v2), { ...JSON.parse(v1), version: 2, prompts: { resolve: null, review: "Review PR #{number} without merging it" } });
  assert.deepEqual(P.parseStore(v2), { store: custom, warnings: [], readOnly: false });
  // Cleared again: back to version 1, the key gone.
  assert.equal(P.serializeStore(P.setPrompt(custom, "review", "")), v1);
  // Profiles, assignments and deletes keep the prompts.
  let s = P.assignProfile(custom, "resolve", "a");
  s = P.upsertProfile(P.upsertProfile(s, ok({ id: "b", harness: "codex" })), ok({ id: "a2", harness: "pi" }), "a");
  s = P.removeProfile(s, "b");
  assert.deepEqual(s.prompts, custom.prompts);
  assert.deepEqual(s.assign, { resolve: "a2", review: null });
  // A hand-edited prompt it can't use: skipped, its action sends the default, and the
  // file is read only so saving doesn't erase it. The other prompt still counts.
  const hand = (prompts, version = 2) => P.parseStore(JSON.stringify({ version, profiles: [], assign: {}, prompts }));
  let r = hand({ resolve: "No number here", review: "Review {number}" });
  assert.equal(r.readOnly, true);
  assert.deepEqual(r.warnings, [
    "A prompt in the file can't be used (see below), so it is read only here: fix or remove it to save",
    "Skipped the Resolve prompt: must contain {number}, where the number goes",
  ]);
  assert.deepEqual(r.store.prompts, { resolve: null, review: "Review {number}" });
  r = hand({ review: "a\u202e{number}" });
  assert.equal(r.readOnly, true);
  assert.match(r.warnings[1], /^Skipped the Review prompt: no control/);
  for (const prompts of [[], "x", 5]) {
    r = hand(prompts);
    assert.equal(r.readOnly, true, JSON.stringify(prompts));
    assert.equal(r.warnings[1], "The profiles file's prompts aren't an object");
  }
  r = hand({ resolve: 42 });
  assert.equal(r.readOnly, true);
  assert.equal(r.warnings[1], "Skipped the Resolve prompt: must be text");
  // Null, missing or empty is the default; a prompt is read from a version 1 file too.
  assert.deepEqual(hand({ resolve: null, review: "  " }), { store: P.emptyStore(), warnings: [], readOnly: false });
  assert.deepEqual(hand({ resolve: " Go {number} " }, 1).store.prompts, { resolve: "Go {number}", review: null });
  // A skipped profile says so first, and once.
  r = P.parseStore(JSON.stringify({ version: 2, profiles: ["x"], prompts: { resolve: "x" } }));
  assert.match(r.warnings[0], /Some profiles in the file can't be used/);
  assert.ok(!r.warnings.some((w) => /A prompt in the file/.test(w)));
  // A newer version is read only, with its prompts still read.
  r = hand({ resolve: "Go {number}" }, 3);
  assert.equal(r.readOnly, true);
  assert.equal(r.store.prompts.resolve, "Go {number}");
});

test("mcc env's output names the profile folder, ~/.claude for the default, else nothing", () => {
  // What `mcc env -q --shell bash` prints, as is.
  assert.equal(P.parseMccEnv("export CLAUDE_CONFIG_DIR='/Users/me/.mcc/profiles/work'\nunset MCC_PROFILE\n", "/Users/me"), "/Users/me/.mcc/profiles/work");
  assert.equal(P.parseMccEnv("unset CLAUDE_CONFIG_DIR\nunset MCC_PROFILE\n", "/Users/me"), "/Users/me/.claude");
  assert.equal(P.parseMccEnv("export CLAUDE_CONFIG_DIR='/x/it'\\''s here'\r\n", "/h"), "/x/it's here");
  for (const text of ["", "unset MCC_PROFILE\n", "garbage", "export CLAUDE_CONFIG_DIR=\"/x\"", "export CLAUDE_CONFIG_DIR='relative/dir'", "export CLAUDE_CONFIG_DIR='/x'; rm -rf ~", null]) {
    assert.equal(P.parseMccEnv(text, "/h"), null, JSON.stringify(text));
  }
});

// A POSIX shell's reading of single-quoted words: what `pane run` types is run so.
function splitShell(line) {
  const words = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === " ") { i++; continue; }
    let word = "";
    while (i < line.length && line[i] !== " ") {
      if (line[i] === "'") { const end = line.indexOf("'", i + 1); assert.ok(end > i, `unclosed quote in ${line}`); word += line.slice(i + 1, end); i = end + 1; }
      else if (line[i] === "\\") { word += line[i + 1]; i += 2; }
      else assert.fail(`unquoted ${JSON.stringify(line[i])} in ${line}`);
    }
    words.push(word);
  }
  return words;
}

test("shellJoin quotes every word so a shell reads back the same words", () => {
  const argv = ["/opt/my tools/mcc", "run", "--", "--model", "opus", "it's", "$(id)", "a`b`", "x;y", "new\nline", "", PROMPT];
  const line = P.shellJoin(argv);
  assert.deepEqual(splitShell(line), argv);
  // Each custom prompt buildLaunch takes reaches mcc as one word, as typed.
  for (const text of ["Don't merge #12: $(id); `id` & echo \"x\" > /tmp/y é 日本", "a'b", "''", "it's {12}", "* ? ~ | < > $HOME ${x}"]) {
    const plan = P.buildLaunch(P.DEFAULT_PROFILE, text);
    assert.deepEqual(splitShell(P.shellJoin(plan.argv)), ["mcc", "run", "--", text], text);
  }
  assert.equal(P.shellQuote("it's"), "'it'\\''s'");
  assert.equal(P.shellJoin(P.buildLaunch(P.DEFAULT_PROFILE, PROMPT).argv), "'mcc' 'run' '--' '/issue-resolver 12'");
});

// ── Refresh interval (#44) ──────────────────────────────────────────────────

test("refresh intervals: 30s, 1m, 5m, 15m or manual, 1m by default; anything else read back is the default", () => {
  assert.deepEqual(P.REFRESH_CHOICES, ["30s", "1m", "5m", "15m", "manual"]);
  assert.equal(P.DEFAULT_REFRESH, "1m");
  for (const c of P.REFRESH_CHOICES) assert.equal(P.parseRefresh(c), c);
  assert.equal(P.parseRefresh("5m\n"), "5m");
  for (const bad of [null, undefined, "", "2m", "MANUAL", "0", 30000, {}]) assert.equal(P.parseRefresh(bad), "1m", String(bad));
});

test("nextRefresh steps through every choice, back to the first after manual", () => {
  const seen = [];
  let c = "30s";
  for (let i = 0; i < P.REFRESH_CHOICES.length; i++) { seen.push(c); c = P.nextRefresh(c); }
  assert.deepEqual(seen, P.REFRESH_CHOICES);
  assert.equal(c, "30s");
  assert.equal(P.nextRefresh("junk"), "5m");
});

test("refreshDue: due once the chosen interval has passed since the last fetch, and never in manual", () => {
  const now = 10_000_000;
  for (const [c, ms] of [["30s", 30000], ["1m", 60000], ["5m", 300000], ["15m", 900000]]) {
    assert.equal(P.refreshDue(c, now - ms + 1, now), false, c);
    assert.equal(P.refreshDue(c, now - ms, now), true, c);
  }
  assert.equal(P.refreshDue("manual", 0, now), false);
  assert.equal(P.refreshDue("manual", -Infinity, now), false);
  // An unknown choice is the default's minute.
  assert.equal(P.refreshDue("junk", now - 60000, now), true);
});

test("the interval's label and notice say what it does", () => {
  assert.equal(P.refreshLabel("5m"), "interval: 5m");
  assert.equal(P.refreshLabel("manual"), "interval: manual");
  assert.equal(P.refreshLabel("junk"), "interval: 1m");
  assert.match(P.refreshNotice("30s"), /^Refreshes every 30 seconds while on screen, and on r/);
  assert.match(P.refreshNotice("1m"), /every minute/);
  assert.match(P.refreshNotice("manual"), /^Refreshes only when you ask: r or the refresh button\. A new folder still loads\.$/);
});

// The terminal panel's and the app's key hints (#47), and where t's hint ends in them.
const TERM = { close: "q close", lead: " " }, APP = { close: "esc close" };
const tEnd = (text, choice) => {
  const m = new RegExp(`t (?:interval: )?${choice}(?!\\w)`).exec(text);
  return m ? [...text.slice(0, m.index + m[0].length)].length : Infinity;
};
// What the terminal's fit and the app's truncate show of a line in `room` cells.
const cut = (text, room) => ([...text].length <= room ? text : [...text].slice(0, room - 1).join("") + "…");

test("the key hints are as they were when they fit: t and the interval after r refresh (#47)", async () => {
  for (const M of [P, await esm()]) {
    assert.equal(M.keyHints({ ...TERM, every: "1m", room: 120 }),
      " ↑↓ select · ⏎ open · ⇥ switch · s profiles · r refresh · t interval: 1m · o repo · q close");
    assert.equal(M.keyHints({ ...TERM, action: "resolve", every: "1m", room: 120 }),
      " ↑↓ select · ⏎ open · a resolve · ⇥ switch · s profiles · r refresh · t interval: 1m · o repo · q close");
    assert.equal(M.keyHints({ ...APP, action: "review", every: "manual", room: 120 }),
      "↑↓ select · ⏎ open · a review · ⇥ switch · s profiles · r refresh · t interval: manual · o repo · esc close");
    // With no room given, all of them.
    assert.equal(M.keyHints({ ...APP, every: "junk" }), "↑↓ select · ⏎ open · ⇥ switch · s profiles · r refresh · t interval: 1m · o repo · esc close");
  }
});

test("too narrow for that, t and the bare interval come after ⏎ open, then first, so they show whole at any width (#47)", async () => {
  for (const M of [P, await esm()]) {
    // The smallest room for each form, and one less: t's hint ends one cell before the "…".
    for (const [hints, room, form] of [
      [TERM, 73, " ↑↓ select · ⏎ open · ⇥ switch · s profiles · r refresh · t interval: 1m · o repo · q close"],
      [TERM, 72, " ↑↓ select · ⏎ open · t 1m · ⇥ switch · s profiles · r refresh · o repo · q close"],
      [TERM, 27, " ↑↓ select · ⏎ open · t 1m · ⇥ switch · s profiles · r refresh · o repo · q close"],
      [TERM, 26, " t 1m · ↑↓ select · ⏎ open · ⇥ switch · s profiles · r refresh · o repo · q close"],
      [{ ...TERM, action: "resolve" }, 85, " ↑↓ select · ⏎ open · a resolve · ⇥ switch · s profiles · r refresh · t interval: 1m · o repo · q close"],
      [{ ...TERM, action: "resolve" }, 84, " ↑↓ select · ⏎ open · a resolve · t 1m · ⇥ switch · s profiles · r refresh · o repo · q close"],
      [{ ...TERM, action: "resolve" }, 39, " ↑↓ select · ⏎ open · a resolve · t 1m · ⇥ switch · s profiles · r refresh · o repo · q close"],
      [{ ...TERM, action: "resolve" }, 38, " t 1m · ↑↓ select · ⏎ open · a resolve · ⇥ switch · s profiles · r refresh · o repo · q close"],
    ]) assert.equal(M.keyHints({ ...hints, every: "1m", room }), form, `${room}`);
    assert.equal(M.keyHints({ ...APP, action: "review", every: "manual", room: 3 }),
      "t manual · ↑↓ select · ⏎ open · a review · ⇥ switch · s profiles · r refresh · o repo · esc close");
    assert.equal(M.keyHints({ ...APP, every: "15m", room: 0 }), "t 15m · ↑↓ select · ⏎ open · ⇥ switch · s profiles · r refresh · o repo · esc close");
    // Whatever the room, what shows of the line has t and the interval whole.
    for (const choice of M.REFRESH_CHOICES) for (const action of [null, "resolve", "review"]) for (const hints of [TERM, APP]) {
      for (let room = 10; room <= 130; room++) {
        const shown = cut(M.keyHints({ ...hints, action, every: choice, room }), room);
        assert.ok(tEnd(shown, choice) <= room, `${choice} ${action} ${room}: ${shown}`);
      }
    }
  }
});

test("the app's key hints have room for t and the interval at 455, 340, 280 and 200 px, and all of them at 600 (#47)", async () => {
  for (const M of [P, await esm()]) {
    assert.deepEqual([600, 455, 368, 340, 280, 200, 28, 0].map(M.hintRoom), [93, 70, 55, 51, 41, 28, 0, 0]);
    for (const px of [455, 340, 280, 200]) for (const choice of M.REFRESH_CHOICES) for (const action of [null, "resolve"]) {
      const room = M.hintRoom(px), shown = cut(M.keyHints({ ...APP, action, every: choice, room }), room);
      assert.ok(tEnd(shown, choice) <= room, `${px} px ${choice} ${action}: ${shown}`);
    }
    assert.equal(M.keyHints({ ...APP, action: "resolve", every: "1m", room: M.hintRoom(600) }),
      "↑↓ select · ⏎ open · a resolve · ⇥ switch · s profiles · r refresh · t interval: 1m · o repo · esc close");
  }
});

// ── The plugin's version and commit (#49) ───────────────────────────────────

const H40 = "ff6822fe22be21f7436214d631e8226f2e848e69", B40 = "afcb452501d124458edbdb6c9043f293e11c43c6";
const answer = (stdout, code = 0) => ({ code, stdout, stderr: "" });
// Git's answer to COMMIT_ARGS asked in a folder at `prefix` in the repo.
const revParse = (prefix, hash = H40, blob = B40) => answer(`${prefix}\n${hash}\n${blob}\n`);

test("the version is the one herdr-plugin.toml releases", () => {
  const toml = fs.readFileSync(path.join(__dirname, "..", "herdr-plugin.toml"), "utf8");
  const version = /^version = "([^"]+)"$/m.exec(toml)?.[1];
  assert.ok(version, "herdr-plugin.toml has a version");
  assert.equal(P.PLUGIN_VERSION, version);
});

test("parseCommit: the short hash only when git answered for the plugin's own folder, in a repo with its manifest", () => {
  assert.deepEqual(P.COMMIT_ARGS, ["rev-parse", "--show-prefix", "HEAD", "HEAD:herdr-plugin.toml"]);
  assert.equal(P.parseCommit(revParse(""), ""), "ff6822f");
  assert.equal(P.parseCommit(revParse("mods/herdr-github/"), "mods/herdr-github/"), "ff6822f");
  // SHA-256 repos, and no final line break.
  assert.equal(P.parseCommit(revParse("", "a".repeat(64), "b".repeat(64)), ""), "aaaaaaa");
  assert.equal(P.parseCommit(answer(`\n${H40}\n${B40}`), ""), "ff6822f");
  // Another folder of the repo, or a repo around a copy with no .git: never its hash.
  assert.equal(P.parseCommit(revParse("mods/herdr-github/"), ""), null);
  assert.equal(P.parseCommit(revParse(""), "mods/herdr-github/"), null);
  assert.equal(P.parseCommit(revParse("herdr-app/mods/herdr-github/"), "mods/herdr-github/"), null);
  // No manifest at the repo's root: git exits non-zero, after printing the hash.
  assert.equal(P.parseCommit(answer(`\n${H40}\nHEAD:herdr-plugin.toml\n`, 128), ""), null);
  assert.equal(P.parseCommit(answer(`\n${H40}\nHEAD:herdr-plugin.toml\n`), ""), null);
  // Whatever it printed, git didn't succeed.
  assert.equal(P.parseCommit(answer(`\n${H40}\n${B40}\n`, 1), ""), null);
  // Not a repo, no git, or anything else.
  for (const r of [answer("", 128), answer(""), answer("\n"), answer(`\n${H40}\n`), answer(`\n${H40}\n${B40}\n${B40}\n`),
    revParse("", H40.toUpperCase()), revParse("", H40.slice(0, 39)), revParse("", `${H40}x`), revParse("", "not a hash"),
    { code: 0, stdout: null }, null, undefined]) {
    assert.equal(P.parseCommit(r, ""), null, JSON.stringify(r));
  }
});

test("versionLine: the version, then the commit, commit unknown, or nothing while it's looked up", () => {
  assert.equal(P.versionLine("0.6.0", "ff6822f"), "herdr-github v0.6.0 · ff6822f");
  assert.equal(P.versionLine("0.6.0", null), "herdr-github v0.6.0 · commit unknown");
  assert.equal(P.versionLine("0.6.0", undefined), "herdr-github v0.6.0");
});

test("the CommonJS copy behaves as the app mod's module", async () => {
  const E = await esm();
  assert.deepEqual(Object.keys(E).sort(), Object.keys(P).sort());
  for (const k of ["HARNESSES", "HARNESS_NAMES", "THINKING", "ACTION_KEYS", "DEFAULT_PROFILE", "STORE_VERSION"]) assert.deepEqual(E[k], P[k], k);
  const profiles = [ok({ harness: "codex", model: "gpt-5", thinking: "high" }), ok({ harness: "mcc", thinking: "max" }), ok({ harness: "opencode", model: "m" }), ok({ harness: "claude", model: "a b" })];
  for (const p of profiles) {
    assert.deepEqual(E.validateProfile(p), P.validateProfile(p));
    let a, b;
    try { a = E.buildLaunch(p, PROMPT); } catch (e) { a = e.message; }
    try { b = P.buildLaunch(p, PROMPT); } catch (e) { b = e.message; }
    assert.deepEqual(a, b);
  }
  const text = JSON.stringify({ version: 1, profiles, assign: { resolve: "p" } });
  assert.deepEqual(E.parseStore(text), P.parseStore(text));
  for (const k of ["PROMPT_MAX", "PROMPT_TOKEN", "PROMPT_LABELS"]) assert.deepEqual(E[k], P[k], k);
  const prompts = JSON.stringify({ version: 2, profiles: [], assign: {}, prompts: { resolve: "Go {number}", review: "bad" } });
  assert.deepEqual(E.parseStore(prompts), P.parseStore(prompts));
  for (const t of ["Go {number}", "-x", "a\u2028{number}", "a\\{number}", `${"x".repeat(485)}{number}`, 7]) {
    assert.deepEqual(E.validatePromptTemplate(t), P.validatePromptTemplate(t), JSON.stringify(t));
    assert.deepEqual(E.validatePrompt(t), P.validatePrompt(t), JSON.stringify(t));
    let a, b;
    try { a = E.serializeStore(E.setPrompt(E.emptyStore(), "resolve", t)); } catch (e) { a = e.message; }
    try { b = P.serializeStore(P.setPrompt(P.emptyStore(), "resolve", t)); } catch (e) { b = e.message; }
    assert.equal(a, b, JSON.stringify(t));
  }
  assert.equal(E.expandPrompt("#{number} {number}", 5), P.expandPrompt("#{number} {number}", 5));
  assert.equal(E.resolvePrompt(E.setPrompt(E.emptyStore(), "review", "R {number}"), "review"), P.resolvePrompt(P.setPrompt(P.emptyStore(), "review", "R {number}"), "review"));
  assert.equal(E.parseMccEnv("unset CLAUDE_CONFIG_DIR", "/h"), P.parseMccEnv("unset CLAUDE_CONFIG_DIR", "/h"));
  const store = { ...P.emptyStore(), profiles: [ok({ id: "a", harness: "pi" })], assign: { resolve: "a", review: null } };
  for (const action of ["resolve", "review"]) assert.deepEqual(E.profileChoices(store, action), P.profileChoices(store, action), action);
  for (const id of ["default", "a", "gone"]) assert.deepEqual(E.findChoice(store, id), P.findChoice(store, id), id);
  for (const k of ["PLUGIN_VERSION", "COMMIT_ARGS"]) assert.deepEqual(E[k], P[k], k);
  for (const [r, prefix] of [[revParse(""), ""], [revParse("mods/herdr-github/"), "mods/herdr-github/"], [revParse("x/"), ""], [answer("", 128), ""]]) {
    assert.equal(E.parseCommit(r, prefix), P.parseCommit(r, prefix), JSON.stringify(r));
  }
  for (const c of ["ff6822f", null, undefined]) assert.equal(E.versionLine(P.PLUGIN_VERSION, c), P.versionLine(P.PLUGIN_VERSION, c), String(c));
});

test("profiles.cjs is up to date with the app mod's profiles.js", () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "sync-profiles.mjs"), "--check"], { encoding: "utf8" });
  assert.match(out, /profiles\.cjs matches/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "profiles.cjs"), "utf8"), /^\/\/ GENERATED from mods\/herdr-github\/profiles\.js/);
});
