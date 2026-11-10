// The Herdr app mod's shared rules (mods/herdr-github/forge.js), loaded as the app
// loads them: an ES module with no imports.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../mods/herdr-github/forge.js", import.meta.url));
const F = await import(`data:text/javascript;base64,${source.toString("base64")}`);

test("forge.js imports cleanly and clean() drops line separators and zero-width characters", () => {
  assert.equal(typeof F.findSkill, "function");
  assert.equal(F.clean("a b c​d﻿e\x07f"), "a b c d e f");
  assert.equal(F.clean("a &amp; b"), "a & b");
});

test("promptFor: Claude Code, directly or through mcc, takes the skill as a slash command", () => {
  const action = { noun: "issue", number: 7 };
  assert.equal(F.promptFor("mcc", "idd:issue-resolver", action), "/idd:issue-resolver 7");
  assert.equal(F.promptFor("claude", "issue-resolver", action), "/issue-resolver 7");
  assert.equal(F.promptFor("codex", "issue-resolver", action), "Use the issue-resolver skill on issue #7.");
  assert.throws(() => F.promptFor("mcc", "issue-resolver", { number: "7; id" }));
});

// An io over a map of files: path → text. dirs lists the folders right under a path.
function fakeIo(files, extra = {}) {
  return {
    home: "/h",
    read: (p) => (p in files ? files[p] : null),
    dirs: (p) => [...new Set(Object.keys(files).filter((f) => f.startsWith(`${p}/`)).map((f) => `${p}/${f.slice(p.length + 1).split("/")[0]}`))]
      .filter((d) => !(d in files)),
    ...extra,
  };
}

test("findSkill for mcc looks in the mcc profile's folder: skills, then its plugins", async () => {
  const work = "/h/.mcc/profiles/work";
  // A skill in the profile's own skills folder.
  let io = fakeIo({ [`${work}/skills/issue-resolver/SKILL.md`]: "x" }, { claudeDir: work });
  assert.equal(await F.findSkill("mcc", "issue-resolver", "/repo", io), "issue-resolver");
  // Not there for plain Claude Code (~/.claude), nor without the folder.
  assert.equal(await F.findSkill("claude", "issue-resolver", "/repo", fakeIo({ [`${work}/skills/issue-resolver/SKILL.md`]: "x" })), null);
  // From a plugin installed and enabled in that profile: under the plugin's name.
  const cache = `${work}/plugins/cache/market/idd/1.0.0`;
  const files = {
    [`${cache}/skills/issue-pr-review/SKILL.md`]: "x",
    [`${cache}/.claude-plugin/plugin.json`]: JSON.stringify({ name: "idd" }),
    [`${work}/plugins/installed_plugins.json`]: JSON.stringify({ plugins: { "idd@market": [{ scope: "user", installPath: cache }] } }),
    [`${work}/settings.json`]: JSON.stringify({ enabledPlugins: { "idd@market": true } }),
  };
  io = fakeIo(files, { claudeDir: work });
  assert.equal(await F.findSkill("mcc", "issue-pr-review", "/repo", io), "idd:issue-pr-review");
  // Disabled in that profile's settings: missing.
  io = fakeIo({ ...files, [`${work}/settings.json`]: JSON.stringify({ enabledPlugins: { "idd@market": false } }) }, { claudeDir: work });
  assert.equal(await F.findSkill("mcc", "issue-pr-review", "/repo", io), null);
  // ~/.claude's plugins are not the mcc profile's.
  const home = Object.fromEntries(Object.entries(files).map(([k, v]) => [k.replace(work, "/h/.claude"), v.replaceAll(work, "/h/.claude")]));
  assert.equal(await F.findSkill("mcc", "issue-pr-review", "/repo", fakeIo(home, { claudeDir: work })), null);
  assert.equal(await F.findSkill("claude", "issue-pr-review", "/repo", fakeIo(home)), "idd:issue-pr-review");
  // Plugins are Claude's only.
  assert.equal(await F.findSkill("codex", "issue-pr-review", "/repo", io), null);
});

// The app mod's launch path, built from a real plan: profiles.js buildLaunch.
const profilesSource = readFileSync(new URL("../mods/herdr-github/profiles.js", import.meta.url));
const P = await import(`data:text/javascript;base64,${profilesSource.toString("base64")}`);

test("tabStart: an agent starts with its programs.json run, the profile's flags, and the prompt as its first message", () => {
  const plan = P.buildLaunch({ id: "c", name: "C", harness: "codex", model: "gpt-5", thinking: "high" }, "Use the issue-resolver skill on issue #7.");
  assert.deepEqual(F.tabStart(plan, ["codex", "--no-daemon"], "Use the issue-resolver skill on issue #7."), {
    argv: ["codex", "--no-daemon", "-m", "gpt-5", "-c", 'model_reasoning_effort="high"'],
    task: "Use the issue-resolver skill on issue #7.",
  });
  // An empty model and thinking level add nothing: the harness's own defaults hold.
  const bare = P.buildLaunch({ id: "c", name: "C", harness: "claude" }, "/issue-resolver 7");
  assert.deepEqual(F.tabStart(bare, ["claude"], "/issue-resolver 7"), { argv: ["claude"], task: "/issue-resolver 7" });
  // The run is copied, not changed.
  const run = ["pi"];
  F.tabStart(P.buildLaunch({ id: "p", name: "P", harness: "pi", thinking: "low" }, "x"), run, "x");
  assert.deepEqual(run, ["pi"]);
});

test("tabStart: mcc runs its own command line, prompt last, with no first message to send", () => {
  const plan = P.buildLaunch({ id: "m", name: "M", harness: "mcc", model: "opus", thinking: "max" }, "/idd:issue-resolver 7");
  const start = F.tabStart(plan, ["claude"], "/idd:issue-resolver 7");
  assert.deepEqual(start, { argv: ["mcc", "run", "--", "--model", "opus", "--effort", "max", "/idd:issue-resolver 7"], task: null });
  // The default profile, with nothing assigned.
  assert.deepEqual(F.tabStart(P.buildLaunch(P.DEFAULT_PROFILE, "/issue-pr-review 3"), undefined, "/issue-pr-review 3"),
    { argv: ["mcc", "run", "--", "/issue-pr-review 3"], task: null });
});

test("tabStart: an agent herdr has no run for is refused", () => {
  const plan = P.buildLaunch({ id: "o", name: "O", harness: "opencode" }, "x");
  for (const run of [undefined, null, [], [""], [3], "opencode"]) {
    assert.throws(() => F.tabStart(plan, run, "x"), /doesn't know how to start opencode/, JSON.stringify(run));
  }
});

test("main.js imports only what forge.js and profiles.js export", () => {
  const main = readFileSync(new URL("../mods/herdr-github/main.js", import.meta.url), "utf8");
  for (const [file, mod] of [["./forge.js", F], ["./profiles.js", P]]) {
    const m = new RegExp(`import \\{([^}]*)\\} from "${file.replace(".", "\\.")}"`).exec(main);
    assert.ok(m, `main.js imports ${file}`);
    const names = m[1].split(",").map((n) => n.trim()).filter(Boolean);
    assert.ok(names.length);
    for (const n of names) assert.ok(n in mod, `${file} exports ${n}`);
  }
});
