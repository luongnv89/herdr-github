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
    // A prompt has spaces, but no shell text.
    if (bad !== "a b") assert.throws(() => P.buildLaunch(P.DEFAULT_PROFILE, `/issue-resolver ${bad}`), /Invalid prompt/);
  }
  assert.throws(() => P.buildLaunch(null, PROMPT), /Invalid profile/);
  assert.throws(() => P.buildLaunch(P.DEFAULT_PROFILE, ""), /Invalid prompt/);
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
  const newer = P.parseStore(JSON.stringify({ version: 2, profiles: [ok({ harness: "pi" })], assign: { resolve: "p" } }));
  assert.equal(newer.readOnly, true);
  assert.match(newer.warnings[0], /version 2/);
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
  // Another version says so first, and only once.
  const both = P.parseStore(JSON.stringify({ version: 2, profiles: ["x"] }));
  assert.match(both.warnings[0], /version 2/);
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
  assert.equal(P.shellQuote("it's"), "'it'\\''s'");
  assert.equal(P.shellJoin(P.buildLaunch(P.DEFAULT_PROFILE, PROMPT).argv), "'mcc' 'run' '--' '/issue-resolver 12'");
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
  assert.equal(E.parseMccEnv("unset CLAUDE_CONFIG_DIR", "/h"), P.parseMccEnv("unset CLAUDE_CONFIG_DIR", "/h"));
});

test("profiles.cjs is up to date with the app mod's profiles.js", () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "sync-profiles.mjs"), "--check"], { encoding: "utf8" });
  assert.match(out, /profiles\.cjs matches/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "profiles.cjs"), "utf8"), /^\/\/ GENERATED from mods\/herdr-github\/profiles\.js/);
});
