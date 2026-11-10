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

test("tabStart: a custom prompt, its {number}s filled in, is the first message, or mcc's last word", () => {
  const template = "Fix issue #{number} on a branch, then open a PR that closes #{number}; don't merge it";
  const text = P.expandPrompt(template, 7);
  assert.equal(text, "Fix issue #7 on a branch, then open a PR that closes #7; don't merge it");
  // An agent: the same start as with the skill, the prompt as the tab's task.
  const codex = P.buildLaunch({ id: "c", name: "C", harness: "codex", model: "gpt-5" }, text);
  assert.deepEqual(F.tabStart(codex, ["codex"], text), { argv: ["codex", "-m", "gpt-5"], task: text });
  // mcc: one argv word, the last, as typed; no first message to send.
  const mcc = P.buildLaunch(P.DEFAULT_PROFILE, P.expandPrompt("Review #{number}: $(id) `id` it's é", 3));
  assert.deepEqual(F.tabStart(mcc, undefined, "x"), { argv: ["mcc", "run", "--", "Review #3: $(id) `id` it's é"], task: null });
  // The number is an integer or nothing is built; a prompt that can't be sent isn't started.
  assert.throws(() => P.expandPrompt(template, "7; id"), /not a number/);
  assert.throws(() => P.buildLaunch(P.DEFAULT_PROFILE, P.expandPrompt("-{number}", 7)), /Invalid prompt/);
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

// ── Opening the agent in a split of the current tab (#26) ──────────────────

const pane = (id, tab, extra = {}) => ({ pane: id, tab, terminal: `t-${id}`, ...extra });

test("chooseAnchor: the pane the panel follows, else a terminal pane in its tab, never a mod pane", () => {
  const list = [pane("p1", "tab1"), pane("p2", "tab1"), pane("p9", "tab2"), { pane: "m1", tab: "tab1", terminal: null, mod: "herdr-github" }];
  // The followed pane.
  assert.equal(F.chooseAnchor({ tab: "tab1", pane: "p2" }, list), list[1]);
  // A mod pane is skipped for the first terminal pane in its tab.
  assert.equal(F.chooseAnchor({ tab: "tab1", pane: "m1" }, list), list[0]);
  // No pane followed, or it closed: the first terminal pane in the tab, not another tab's.
  assert.equal(F.chooseAnchor({ tab: "tab2", pane: null }, list), list[2]);
  assert.equal(F.chooseAnchor({ tab: "tab2", pane: "gone" }, list), list[2]);
  // Nothing to split.
  assert.equal(F.chooseAnchor({ tab: "tab3", pane: null }, list), null);
  assert.equal(F.chooseAnchor({ tab: "tab1", pane: null }, [list[3]]), null);
  assert.equal(F.chooseAnchor(null, list), null);
  assert.equal(F.chooseAnchor({ tab: "tab1", pane: "p1" }, undefined), null);
});

test("localId: a remote id loses its machine/ prefix, a local one stays", () => {
  assert.equal(F.localId("tab7"), "tab7");
  assert.equal(F.localId("omachi/tab7"), "tab7");
  assert.equal(F.localId(null), null);
});

test("pickNewTerminal: the one new terminal labelled with the tab, on its machine, or null", () => {
  const t = (address, tab) => ({ address, labels: { "herdr.space": "s1", "herdr.tab": tab } });
  const before = ["t1", "t2"];
  const old = [t("t1", "tab1"), t("t2", "tab1")];
  // One new terminal in the tab.
  assert.equal(F.pickNewTerminal(before, [...old, t("t3", "tab1")], "tab1").address, "t3");
  // None new.
  assert.equal(F.pickNewTerminal(before, old, "tab1"), null);
  // Two new: never a guess.
  assert.equal(F.pickNewTerminal(before, [...old, t("t3", "tab1"), t("t4", "tab1")], "tab1"), null);
  // A new terminal in another tab doesn't count.
  assert.equal(F.pickNewTerminal(before, [...old, t("t3", "tab2")], "tab1"), null);
  assert.equal(F.pickNewTerminal(before, [...old, t("t3", "tab2"), t("t4", "tab1")], "tab1").address, "t4");
  // A remote tab: its id has the machine/ prefix, the labels don't, the address does.
  assert.equal(F.pickNewTerminal(["omachi/t1"], [t("omachi/t1", "tab1"), t("omachi/t5", "tab1")], "omachi/tab1").address, "omachi/t5");
  // The same local tab id on another machine isn't the tab.
  assert.equal(F.pickNewTerminal(before, [...old, t("t3", "tab1")], "omachi/tab1"), null);
  assert.equal(F.pickNewTerminal([], [t("omachi/t5", "tab1")], "tab1"), null);
  // No tab, no labels.
  assert.equal(F.pickNewTerminal(before, [...old, t("t3", "tab1")], null), null);
  assert.equal(F.pickNewTerminal(before, [...old, { address: "t3" }], "tab1"), null);
});

test("isReadyToSend: only an idle agent takes its first message", () => {
  assert.equal(F.isReadyToSend("idle"), true);
  for (const status of ["working", "blocked", "done", null, undefined]) assert.equal(F.isReadyToSend(status), false, String(status));
});

test("main.js splits the current tab below the anchor pane, and opens no tab", () => {
  const main = readFileSync(new URL("../mods/herdr-github/main.js", import.meta.url), "utf8");
  assert.doesNotMatch(main, /run\("tab\.new"/);
  assert.match(main, /run\("pane\.focus", \{ pane: anchor\.pane \}\);\s*run\("terminal\.open", \{ argv: start\.argv, folder: root, place: "down" \}\)/);
  // The prompt is sent only to an idle agent.
  assert.match(main, /hc\(\["send", "--if", "idle", address, task\]\)/);
});
