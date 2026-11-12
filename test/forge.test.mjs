// The Herdr app mod's shared rules (mods/herdr-github/forge.js), loaded as the app
// loads them: an ES module with no imports.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

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

test("tabStart: OpenCode starts with its run alone and gets the prompt as a first message, never as an argument (#29)", () => {
  // A plain argument is OpenCode's start folder, so the prompt must never be one.
  const text = "Use the issue-resolver skill on issue #7.";
  const plan = P.buildLaunch({ id: "o", name: "O", harness: "opencode" }, text);
  const start = F.tabStart(plan, ["opencode"], text);
  assert.deepEqual(start, { argv: ["opencode"], task: text });
  assert.ok(!start.argv.includes(text));
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

test("unpickedNotice: no new terminal means the pane didn't open, never that the agent started (#31)", () => {
  const t = (address, tab) => ({ address, labels: { "herdr.space": "s1", "herdr.tab": tab } });
  const before = ["t1", "t2"];
  const old = [t("t1", "tab1"), t("t2", "tab1")];
  const prompt = "Use the issue-pr-review skill on pull request #30";
  // terminal.open failed (Herdr's toast), so no terminal is new anywhere.
  const none = F.unpickedNotice("OpenCode", prompt, before, old);
  assert.equal(none, `OpenCode didn't start in a new pane. Herdr may not find its program: check Herdr's message, or the profile's harness. When OpenCode runs, send it: ${prompt}`);
  assert.doesNotMatch(none, /Started|started in a new pane/);
  assert.doesNotMatch(none, /Send it yourself in the new pane/);
  assert.equal(F.unpickedNotice("OpenCode", prompt, before, undefined), none);
  // A terminal is new, but not exactly one in the tab: the pane may be open.
  const many = `Started OpenCode in a new pane, but can't tell which terminal it is. Send it yourself in the new pane: ${prompt}`;
  assert.equal(F.unpickedNotice("OpenCode", prompt, before, [...old, t("t3", "tab1"), t("t4", "tab1")]), many);
  assert.equal(F.unpickedNotice("OpenCode", prompt, before, [...old, t("t3", "tab2")]), many);
  assert.equal(F.unpickedNotice("OpenCode", prompt, before, [...old, { address: "t3" }]), many);
});

test("main.js says the pane didn't open through unpickedNotice when it finds no terminal (#31)", () => {
  const main = readFileSync(new URL("../mods/herdr-github/main.js", import.meta.url), "utf8");
  assert.match(main, /if \(!terminal\) return say\("error", unpickedNotice\(who, text, before, terminals\(\)\)\);/);
  assert.doesNotMatch(main, /return say\("error", `Started \$\{who\} in a new pane, but can't tell/);
});

test("isReadyToSend: only an idle agent takes its first message", () => {
  assert.equal(F.isReadyToSend("idle"), true);
  for (const status of ["working", "blocked", "done", null, undefined]) assert.equal(F.isReadyToSend(status), false, String(status));
});

test("main.js splits the current tab to the right of the anchor pane, and opens no tab", () => {
  const main = readFileSync(new URL("../mods/herdr-github/main.js", import.meta.url), "utf8");
  assert.doesNotMatch(main, /run\("tab\.new"/);
  assert.match(main, /run\("pane\.focus", \{ pane: anchor\.pane \}\);\s*run\("terminal\.open", \{ argv: start\.argv, folder: root, place: "right" \}\)/);
  // The prompt is sent only to an idle agent.
  assert.match(main, /hc\(\["send", "--if", "idle", address, task\]\)/);
});

test("nextNotice: another launch's progress never hides an error; an error or the same launch replaces it", () => {
  const n = (tone, from, text = tone) => ({ tone, text, url: null, from });
  const errA = n("error", 1, "Send it yourself in the new pane: /issue-resolver 12");
  // Nothing up yet.
  assert.equal(F.nextNotice(null, n("info", 1)).tone, "info");
  // Info or ok from launch 2 over launch 1's error: the error stays.
  assert.equal(F.nextNotice(errA, n("info", 2)), errA);
  assert.equal(F.nextNotice(errA, n("ok", 2)), errA);
  // So does an error not from a launch, such as "Can't start an agent".
  const errNone = n("error", null);
  assert.equal(F.nextNotice(errNone, n("info", 3)), errNone);
  // An error replaces info, and a newer error an older one.
  const errB = n("error", 2);
  assert.equal(F.nextNotice(n("info", 1), errB), errB);
  assert.equal(F.nextNotice(errA, errB), errB);
  // A launch's own later message replaces its own earlier one, even an error.
  const okA = n("ok", 1);
  assert.equal(F.nextNotice(n("info", 1), okA), okA);
  assert.equal(F.nextNotice(errA, okA), okA);
  // Info replaces info or ok, whoever said it.
  const infoB = n("info", 2);
  assert.equal(F.nextNotice(okA, infoB), infoB);
});

test("keepsNotice: a key leaves up only progress, while a launch or a prompt is still under way", () => {
  const info = { tone: "info", text: "Its prompt goes once it is ready: /issue-resolver 12" };
  assert.equal(F.keepsNotice(info, true), true);
  assert.equal(F.keepsNotice(info, false), false);
  assert.equal(F.keepsNotice({ tone: "error", text: "x" }, true), false);
  assert.equal(F.keepsNotice({ tone: "ok", text: "x" }, true), false);
  assert.equal(F.keepsNotice(null, true), false);
});

test("several launches in a row all split the same tab, and each picks only its own new terminal (#26)", () => {
  const t = (address, tab) => ({ address, labels: { "herdr.space": "s1", "herdr.tab": tab } });
  // Another tab's terminal pane comes first, so a split that ignored the tab would go there.
  const panesNow = [pane("q1", "tab2"), pane("p1", "tab1"), { pane: "m1", tab: "tab1", terminal: null, mod: "herdr-github" }];
  const termsNow = [t("t-q1", "tab2"), t("t-p1", "tab1")];
  // What terminal.open does: a new pane right of the anchor, in its tab, focused,
  // so the panel follows it.
  const open = (anchor, id) => {
    panesNow.push(pane(id, anchor.tab));
    termsNow.push(t(`t-${id}`, anchor.tab));
    return { tab: anchor.tab, pane: id };
  };
  // The panel has the keyboard: it follows no pane, only its tab.
  let loc = { tab: "tab1", pane: null };
  const picked = [];
  let firstBefore = null;
  for (const id of ["p2", "p3", "p4"]) {
    const anchor = F.chooseAnchor(loc, panesNow);
    assert.ok(anchor, `an anchor for ${id}`);
    assert.equal(anchor.tab, "tab1", `${id} splits tab1`);
    const before = termsNow.map((x) => x.address);
    firstBefore ??= before;
    loc = open(anchor, id);
    const terminal = F.pickNewTerminal(before, termsNow, anchor.tab);
    assert.equal(terminal?.address, `t-${id}`, `${id}'s own terminal`);
    picked.push(terminal.address);
    // The second launch follows the new pane; the third is pressed from the panel again.
    if (id === "p3") loc = { tab: "tab1", pane: "m1" };
  }
  assert.deepEqual(picked, ["t-p2", "t-p3", "t-p4"]);
  // Every new pane is in tab1, and no tab was added.
  assert.deepEqual(panesNow.filter((p) => p.tab === "tab1" && !p.mod).map((p) => p.pane), ["p1", "p2", "p3", "p4"]);
  assert.deepEqual([...new Set(panesNow.map((p) => p.tab))], ["tab2", "tab1"]);
  // Without a fresh snapshot per launch, the earlier launches' terminals look new too.
  assert.equal(F.pickNewTerminal(firstBefore, termsNow, "tab1"), null);
});

test("main.js keeps every notice through nextNotice, by launch, and counts prompts still to be sent", () => {
  const main = readFileSync(new URL("../mods/herdr-github/main.js", import.meta.url), "utf8");
  assert.match(main, /say\(tone, text, url = null, from = null\) \{ this\.notice = nextNotice\(this\.notice, \{ tone, text, url, from \}\); \}/);
  assert.match(main, /this\.delivering\+\+;\s*cx\.spawn\(/);
  assert.match(main, /finally \{ this\.delivering--; cx\.notify\(\); \}/);
  assert.match(main, /keepsNotice\(this\.notice, this\.acting \|\| this\.delivering > 0\)/);
  // A new launch clears the notice before its first word, so its progress shows.
  assert.match(main, /const id = \+\+this\.launches, say = [^\n]*\n(\s*\/\/[^\n]*\n)*\s*this\.notice = null;\n\s*if \(!root\) return say\(/);
  // Inside a launch, every notice carries the launch's id: this.say is called only by its say.
  const body = main.slice(main.indexOf("async launch("), main.indexOf("async readStore("));
  assert.deepEqual(body.match(/this\.say\([^)]*\)/g), ["this.say(tone, text, url, id)"]);
});

// ── Refresh (#42) ───────────────────────────────────────────────────────────

test("refreshGate: a running refresh blocks the timer's until it ends or hangs; a new folder replaces it at once", () => {
  const gate = F.refreshGate();
  const a = gate.begin(1000, {}, 300, 50);
  assert.equal(a, 1);
  assert.equal(gate.running, true);
  // Still running, not hung: the timer's refresh waits.
  assert.equal(gate.begin(1200, {}, 300, 50), null);
  // Hung (300 ms here): the next one starts.
  const b = gate.begin(1300, {}, 300, 50);
  assert.equal(b, 2);
  // A new folder: right away, even with the grace not over.
  const c = gate.begin(1301, { moved: true }, 300, 50);
  assert.equal(c, 3);
  assert.equal(gate.current(a), false);
  assert.equal(gate.current(c), true);
  // A replaced refresh ending changes nothing: the latest one is still running.
  assert.equal(gate.end(a), false);
  assert.equal(gate.end(b), false);
  assert.equal(gate.running, true);
  assert.equal(gate.begin(1302, {}, 300, 50), null);
  assert.equal(gate.end(c), true);
  assert.equal(gate.running, false);
  assert.equal(gate.begin(1303, {}, 300, 50), 4);
});

test("refreshGate: a press starts one at once when none runs, and replaces a running one only after the grace (#45)", () => {
  const gate = F.refreshGate();
  // None running: the press starts one right away.
  assert.equal(gate.begin(1000, { press: true }, 300, 50), 1);
  // Pressed again within the grace: nothing new starts, the running one goes on.
  assert.equal(gate.begin(1001, { press: true }, 300, 50), null);
  assert.equal(gate.begin(1049, { press: true }, 300, 50), null);
  assert.equal(gate.current(1), true);
  // Past the grace, a press replaces it: a refresh that never ends doesn't hold the panel (#42).
  assert.equal(gate.begin(1050, { press: true }, 300, 50), 2);
  assert.equal(gate.current(1), false);
  // The grace starts again from the new refresh.
  assert.equal(gate.begin(1060, { press: true }, 300, 50), null);
  // Ended: the next press starts one at once, grace or not.
  assert.equal(gate.end(2), true);
  assert.equal(gate.begin(1061, { press: true }, 300, 50), 3);
});

test("refreshGate: a burst of presses, as held r repeats, starts at most one refresh per grace (#45)", () => {
  const gate = F.refreshGate();
  // 30 presses a second for 10 s while the refresh never ends, with the default grace.
  let starts = 0;
  for (let t = 0; t <= 10000; t += 33) if (gate.begin(t, { press: true }) !== null) starts++;
  assert.ok(F.REFRESH.graceMs >= 1000, "a grace of at least a second");
  assert.ok(starts <= 1 + Math.floor(10000 / F.REFRESH.graceMs), `${starts} refreshes`);
  assert.ok(starts >= 2, "a hung refresh is still replaced");
  // The grace is far shorter than the hung limit: a press still recovers from a hung refresh long before the timer would.
  assert.ok(F.REFRESH.graceMs * 10 <= F.REFRESH.hungMs);
});

test("refreshGate: the limit is past the slowest real refresh, four steps of a 60 s timeout", () => {
  assert.ok(F.REFRESH.hungMs > 4 * 60000);
  const gate = F.refreshGate();
  gate.begin(0);
  assert.equal(gate.begin(4 * 60000), null);
  assert.equal(gate.begin(F.REFRESH.hungMs), 2);
});

// An exec over scripted answers: by program and first argument, or hold, which never answers.
function fakeExec(answers) {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push([cmd, ...args, opts.cwd]);
    const a = answers[`${cmd} ${args[0]}`] ?? answers[cmd];
    if (a === "hold") return new Promise(() => {});
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", ...a });
  };
  return { exec, calls };
}

const GH = {
  "git rev-parse": { stdout: "/r\n" },
  "git remote": { stdout: "origin\tgit@github.com:o/p.git (fetch)\n" },
  "gh repo": { stdout: JSON.stringify({ nameWithOwner: "o/p", url: "https://github.com/o/p" }) },
  "gh pr": { stdout: "[]" },
  "gh issue": { stdout: "[]" },
  "gh label": { stdout: "[]" },
};

test("readRepo: reads the repo, its lists and the forge, and remembers which forge answered", async () => {
  const { exec, calls } = fakeExec(GH);
  const forges = new Map();
  const found = await F.readRepo({ cwd: "/r/sub", exec, forges, current: () => true });
  assert.equal(found.root, "/r");
  assert.equal(found.forge, F.FORGES.github);
  assert.equal(found.fetched, true);
  assert.equal(found.error, null);
  assert.deepEqual([found.prs, found.issues], [[], []]);
  assert.equal(forges.get("|github.com"), "github");
  // git runs in the folder, then in the root; gh in the root.
  assert.equal(calls[0].at(-1), "/r/sub");
  assert.ok(calls.slice(1).every((c) => c.at(-1) === "/r"));
});

test("readRepo: says what's wrong with the folder, and why it couldn't be read", async () => {
  const no = await F.readRepo({ cwd: "/x", exec: fakeExec({ git: { code: 128 } }).exec, forges: new Map(), current: () => true });
  assert.equal(no.error, "Not a git repository");
  const local = await F.readRepo({ cwd: "/x", exec: fakeExec({ git: { stdout: "/x\n" } }).exec, forges: new Map(), current: () => true });
  assert.equal(local.error, "No GitHub or GitLab remote");
  assert.equal(local.root, "/x");
  const away = await F.readRepo({ cwd: "/x", on: "box", exec: fakeExec({ git: new Error("unreachable") }).exec, forges: new Map(), current: () => true });
  assert.deepEqual(away, { error: "Can't reach box: unreachable" });
});

test("readRepo: a refresh replaced while it ran answers nothing, whichever step it was on", async () => {
  for (const step of ["git rev-parse", "git remote", "gh repo"]) {
    let wanted = true;
    const { exec } = fakeExec(GH);
    // Replaced while this step runs.
    const slow = (cmd, args, opts) => { if (`${cmd} ${args[0]}` === step) wanted = false; return exec(cmd, args, opts); };
    const forges = new Map();
    assert.equal(await F.readRepo({ cwd: "/r", exec: slow, forges, current: () => wanted }), null, step);
    assert.equal(forges.size, 0, step);
  }
  // Nor an error from a step that failed after it was replaced.
  let wanted = true;
  const failing = () => { wanted = false; return Promise.reject(new Error("gone")); };
  assert.equal(await F.readRepo({ cwd: "/r", exec: failing, forges: new Map(), current: () => wanted }), null);
});

test("main.js refreshes through the gate: the buttons press, a new folder moves, and only the latest stops the spinner", () => {
  const main = readFileSync(new URL("../mods/herdr-github/main.js", import.meta.url), "utf8");
  const fn = main.slice(main.indexOf("refresh(cx, fromRender = false, force = false) {"));
  const refresh = fn.slice(0, fn.indexOf("\n  }\n") + 4);
  assert.doesNotMatch(refresh, /if \(this\.loading\) return/);
  // A press and a new folder stay apart: only the folder skips the grace (#45).
  assert.match(refresh, /const n = this\.gate\.begin\(Date\.now\(\), \{ press: force, moved \}\);\s*if \(n === null\) return;/);
  assert.match(refresh, /const current = \(\) => this\.gate\.current\(n\) && keyOf\(this\.loc\) === context;/);
  assert.match(refresh, /if \(!found \|\| !current\(\)\) return;/);
  assert.match(refresh, /finally \{\n(\s*\/\/[^\n]*\n)*\s*if \(this\.gate\.end\(n\)\) this\.loading = false;/);
  assert.doesNotMatch(refresh, /finally \{ this\.loading = false;/);
  // The refresh button, r and the refresh command force one; the timer doesn't.
  assert.match(main, /else if \(c === "refresh"\) this\.refresh\(cx, false, true\);/);
  assert.match(main, /else if \(k === "r"\) this\.refresh\(cx, false, true\);/);
  assert.match(main, /"Refresh", \(_e, cx\) => this\.refresh\(cx, false, true\)\)/);
  // The timer doesn't press: it never replaces a running refresh before it hangs.
  assert.match(main, /cx\.timer\.every\(TICK_MS, \(cx\) => \{ if \(this\.visible\(\) && refreshDue\(this\.every, this\.fetchedAt, Date\.now\(\)\)\) this\.refresh\(cx\); \}\);/);
});

// ── Refresh interval (#44) ──────────────────────────────────────────────────

test("main.js refreshes on its own only when the chosen interval says so, and never in manual (#44)", () => {
  const main = readFileSync(new URL("../mods/herdr-github/main.js", import.meta.url), "utf8");
  assert.doesNotMatch(main, /\bSTALE\b/);
  // Both timed paths, the timer and render's check, ask refreshDue; a new folder still loads at once.
  const tick = Number(/const TICK_MS = (\d+);/.exec(main)?.[1]);
  assert.ok(tick > 0 && tick <= 30000 / 3, `a tick of ${tick} ms against the 30 s interval`);
  assert.match(main, /cx\.timer\.every\(TICK_MS, \(cx\) => \{ if \(this\.visible\(\) && refreshDue\(this\.every, this\.fetchedAt, Date\.now\(\)\)\)/);
  assert.match(main, /if \(this\.visible\(\) && \(keyOf\(this\.loc\) !== this\.context \|\| refreshDue\(this\.every, this\.fetchedAt, Date\.now\(\)\)\)\) this\.refresh\(cx, true\);/);
  assert.equal(main.match(/refreshDue\(/g).length, 2);
});

test("main.js keeps the interval, and t, the header's interval button and the interval command step it (#44)", () => {
  const main = readFileSync(new URL("../mods/herdr-github/main.js", import.meta.url), "utf8");
  // Read back when the panel opens, as the view is; anything unknown is the default.
  assert.match(main, /this\.every = parseRefresh\(localStorage\.getItem\("refresh"\)\);/);
  const fn = main.slice(main.indexOf("  cycleRefresh(cx) {"));
  const cycle = fn.slice(0, fn.indexOf("\n  }\n") + 4);
  assert.match(cycle, /this\.every = nextRefresh\(this\.every\);\s*localStorage\.setItem\("refresh", this\.every\);/);
  assert.match(cycle, /this\.say\("ok", refreshNotice\(this\.every\)\);/);
  assert.match(main, /else if \(k === "t"\) this\.cycleRefresh\(cx\);/);
  assert.match(main, /else if \(c === "interval"\) this\.cycleRefresh\(cx\);/);
  assert.match(main, /this\.chip\(t, "hg-interval", this\.every === "manual" \? "Manual" : this\.every, false,\s*\(_e, cx\) => \{ if \(!this\.closeMenu\(cx\)\) this\.cycleRefresh\(cx\); \}\)/);
  // Named for a screen reader, and left out of a narrow header, where t still works.
  assert.match(main, /\.accessibility_label\(`Refresh interval: \$\{this\.every\}\. Activate to change it\.`\)/);
  assert.match(main, /\.when\(!st && \(this\.width \?\? 368\) >= INTERVAL_MIN_W, \(el\) => el\.child\(this\.chip\(t, "hg-interval"/);
  // Its key hints show the interval at any width, in room reckoned from the panel's (#47).
  assert.match(main, /: !st \? keyHints\(\{ action: action\?\.key \?\? null, every: this\.every, close: "esc close", room: hintRoom\(this\.width \?\? 368\) \}\)/);
  // The refresh button still presses, in manual too.
  assert.match(main, /"Refresh", \(_e, cx\) => this\.refresh\(cx, false, true\)\)/);
});

// ── The plugin's version and commit (#49) ──────────────────────────────────

test("main.js looks up its commit once, in its own folder on this computer, and shows it in the profiles view (#49)", () => {
  const main = readFileSync(new URL("../mods/herdr-github/main.js", import.meta.url), "utf8");
  assert.match(main, /import \{[^}]*\bappHome\b[^}]*\} from "herdr";/);
  // Once per load of the code, by the first copy's init: git on this computer (no
  // `on`), in the mod's folder under the app's; a failure is unknown.
  assert.match(main, /^let commitLookup = null;$/m);
  const fn = main.slice(main.indexOf("  init(_props, cx) {"));
  const init = fn.slice(0, fn.indexOf("\n  }\n") + 4);
  assert.match(init, /this\.commit = undefined;\s*commitLookup \?\?= exec\("git", COMMIT_ARGS, \{ cwd: `\$\{appHome\(\)\}\/mods\/\$\{MOD\}`, timeout: 5000 \}\)\.then\(\(r\) => parseCommit\(r, `mods\/\$\{MOD\}\/`\), \(\) => null\);/);
  assert.match(init, /cx\.spawn\(async \(cx\) => \{ this\.commit = await commitLookup; cx\.notify\(\); \}\);/);
  assert.equal(main.match(/COMMIT_ARGS/g).length, 2, "imported, and run once");
  assert.equal(main.match(/commitLookup = /g).length, 1, "set in one place only");
  assert.match(main, /const MOD = "herdr-github";/);
  // The profile list's last line: it keeps its height when the list overflows.
  const list = main.slice(main.indexOf("  profileList(t) {"));
  assert.match(list.slice(0, list.indexOf("\n  }\n")), /\.child\(div\(\)\.flex_none\(\)[^\n]*\.truncate\(\)[^\n]*\.child\(versionLine\(PLUGIN_VERSION, this\.commit\)\)\);$/);
});

// ── Merging a pull request (#51) ────────────────────────────────────────────

test("mergeStrategy: squash, else a merge commit, else rebase, as the repo allows; null when none is allowed or gh didn't say", () => {
  for (const squash of [true, false]) for (const merge of [true, false]) for (const rebase of [true, false]) {
    const want = squash ? "squash" : merge ? "merge" : rebase ? "rebase" : null;
    assert.equal(F.mergeStrategy({ merges: { squash, merge, rebase } }), want, JSON.stringify({ squash, merge, rebase }));
  }
  // Unknown is never allowed: no repo, no merges, or values that aren't true.
  for (const repo of [null, undefined, {}, { name: "o/p" }, { merges: null }, { merges: {} }, { merges: { squash: "true", merge: 1, rebase: undefined } }]) {
    assert.equal(F.mergeStrategy(repo), null, JSON.stringify(repo));
  }
  assert.deepEqual(F.MERGE_NAMES, { squash: "squash", merge: "merge commit", rebase: "rebase" });
});

test("mergeArgs: the number, the method's flag, and the head to match when it's a commit hash; nothing else", () => {
  const sha1 = "0123456789abcdef0123456789abcdef01234567", sha256 = "ab".repeat(32);
  assert.deepEqual(F.mergeArgs(12, "squash", sha1), ["pr", "merge", "12", "--squash", "--match-head-commit", sha1]);
  assert.deepEqual(F.mergeArgs(12, "merge", sha256), ["pr", "merge", "12", "--merge", "--match-head-commit", sha256]);
  assert.deepEqual(F.mergeArgs(12, "rebase", sha1), ["pr", "merge", "12", "--rebase", "--match-head-commit", sha1]);
  // No head, or one that isn't a lowercase hash, leaves the check out rather than pass it on.
  for (const head of [undefined, null, "", "abc123", sha1.toUpperCase().replace(/[0-9]/g, "A"), `${sha1} --admin`, `--admin`, sha1.slice(0, 39), 12]) {
    assert.deepEqual(F.mergeArgs(12, "squash", head), ["pr", "merge", "12", "--squash"], String(head));
  }
  // Integers only: never text from a title or body.
  for (const n of [0, -1, 1.5, "12", "12; rm -rf ~", NaN, Infinity, 2 ** 53, null, undefined]) {
    assert.throws(() => F.mergeArgs(n, "squash", sha1), /not a number/, String(n));
  }
  for (const s of ["SQUASH", "--squash", "auto", "admin", "", undefined, null, "squash; id", "toString", "__proto__", "constructor"]) {
    assert.throws(() => F.mergeArgs(12, s, sha1), /not a merge method/, String(s));
  }
  // Never the flags that touch your local branches or wait for checks.
  for (const s of ["squash", "merge", "rebase"]) {
    const args = F.mergeArgs(12, s, sha1);
    for (const flag of ["--delete-branch", "-d", "--auto", "--admin"]) assert.ok(!args.includes(flag), `${s} ${flag}`);
  }
});

test("mergeGuard: a refresh that began before a merge finished doesn't list it again; one that began after is gh's word on it", () => {
  const g = F.mergeGuard(), pr = (number) => ({ number });
  const list = [pr(10), pr(12), pr(13)];
  const stale = g.begin();
  g.add("/r", 12);
  // The refresh that was running when #12 was merged answers with it still open.
  assert.deepEqual(g.filter(list, "/r", stale).map((p) => p.number), [10, 13]);
  // Another repo's #12 is another pull request.
  assert.deepEqual(g.filter(list, "/other", stale).map((p) => p.number), [10, 12, 13]);
  // A refresh begun after the merge: gh's answer stands, and the merge is forgotten,
  // so an older answer can't bring it back later either way.
  const fresh = g.begin();
  assert.deepEqual(g.filter([pr(10), pr(13)], "/r", fresh).map((p) => p.number), [10, 13]);
  assert.deepEqual(g.filter(list, "/r", stale).map((p) => p.number), [10, 12, 13]);
  // Still listed after a merge (a merge queue, say): shown, not hidden for good.
  const g2 = F.mergeGuard();
  g2.add("/r", 12);
  assert.deepEqual(g2.filter(list, "/r", g2.begin()).map((p) => p.number), [10, 12, 13]);
  assert.deepEqual(g.filter(undefined, "/r", fresh), []);
});

test("readRepo: the repo's merge methods and each pull request's head commit come through", async () => {
  assert.match(F.FORGES.github.repoArgs.join(" "), /--json nameWithOwner,url,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed$/);
  assert.ok(F.FORGES.github.prArgs.at(-1).split(",").includes("headRefOid"));
  const head = "f".repeat(40);
  const { exec } = fakeExec({
    ...GH,
    "gh repo": { stdout: JSON.stringify({ nameWithOwner: "o/p", url: "https://github.com/o/p", squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: true }) },
    "gh pr": { stdout: JSON.stringify([{ number: 4, title: "t", headRefName: "b", headRefOid: head, url: "u" }]) },
  });
  const found = await F.readRepo({ cwd: "/r", exec, forges: new Map(), current: () => true });
  assert.deepEqual(found.repo, { name: "o/p", url: "https://github.com/o/p", merges: { squash: false, merge: false, rebase: true } });
  assert.equal(found.prs[0].head, head);
  assert.equal(F.mergeStrategy(found.repo), "rebase");
  assert.deepEqual(F.mergeArgs(found.prs[0].number, F.mergeStrategy(found.repo), found.prs[0].head), ["pr", "merge", "4", "--rebase", "--match-head-commit", head]);
  // GitLab's repo has none: no Merge button there.
  assert.equal(F.mergeStrategy(F.FORGES.gitlab.repo({ path_with_namespace: "g/p", web_url: "u" })), null);
});

test("panel.js's copy of the merge rules is forge.js's", () => {
  const panel = createRequire(import.meta.url)("../panel.js");
  assert.deepEqual(panel.FORGES.github.repoArgs, F.FORGES.github.repoArgs);
  assert.deepEqual(panel.FORGES.github.prArgs, F.FORGES.github.prArgs);
  const r = { nameWithOwner: "o/p", url: "u", squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true };
  assert.deepEqual(panel.FORGES.github.repo(r), F.FORGES.github.repo(r));
  for (const merges of [{ squash: true }, { merge: true }, { rebase: true }, {}, null]) {
    assert.equal(panel.mergeStrategy({ merges }), F.mergeStrategy({ merges }));
  }
  for (const [n, s, h] of [[3, "squash", "a".repeat(40)], [3, "merge", "x"], [3, "rebase", null]]) assert.deepEqual(panel.mergeArgs(n, s, h), F.mergeArgs(n, s, h));
  for (const [n, s] of [["3", "squash"], [3, "admin"]]) {
    assert.throws(() => panel.mergeArgs(n, s));
    assert.throws(() => F.mergeArgs(n, s));
  }
});

test("main.js has no Resolve or Review button in its header, and a Merge chip on each GitHub pull request row (#51)", () => {
  const main = readFileSync(new URL("../mods/herdr-github/main.js", import.meta.url), "utf8");
  // The header's button is gone: a and the commands press the selected row's action.
  assert.doesNotMatch(main, /id\("hg-act"\)/);
  assert.doesNotMatch(main, /this\.act\(cx, view, this\.sel\[view\], "header"\)/);
  assert.match(main, /else if \(k === "a"\) this\.act\(cx, this\.view, this\.sel\[this\.view\], "header"\);/);
  assert.match(main, /else if \(c === "resolve" \|\| c === "review" \|\| c === "act"\) \{ this\.handle\.focus\(\); this\.act\(cx, this\.view, this\.sel\[this\.view\], "header"\); \}/);
  // The rows' own Review and Resolve buttons, and beside a pull request's, its Merge chip.
  assert.match(main, /div\(\)\.id\(`hg-\$\{view\}-act-\$\{item\.number\}`\)/);
  assert.match(main, /\.when\(view === "prs", \(el\) => el\.child\(this\.mergeChip\(t, item\.number\)\)\)/);
  const fn = main.slice(main.indexOf("  mergeChip(t, number) {"));
  const chip = fn.slice(0, fn.indexOf("\n  }\n"));
  assert.match(chip, /div\(\)\.id\(`hg-prs-merge-\$\{number\}`\)/);
  // Its press and click stop there, so the row doesn't open in the browser as well.
  assert.match(chip, /\.on_mouse_down\("left", \(_e, cx\) => cx\.stop_propagation\(\)\)/);
  assert.match(chip, /\.on_click\(\(_e, cx\) => \{ cx\.stop_propagation\(\); this\.handle\.focus\(\); if \(!this\.closeMenu\(cx\)\) this\.pressMerge\(cx, number\); \}\)/);
  assert.match(chip, /armed \? `Confirm merge #\$\{number\}` : `Merge #\$\{number\}`/);
});

test("main.js merges through gh on the repo's machine, once a second press confirms, and keeps a merged pull request out of a stale refresh (#51)", () => {
  const main = readFileSync(new URL("../mods/herdr-github/main.js", import.meta.url), "utf8");
  const body = (head) => { const fn = main.slice(main.indexOf(head)); return fn.slice(0, fn.indexOf("\n  }\n")); };
  const press = body("  pressMerge(cx, number) {");
  assert.match(press, /if \(this\.acting \|\| this\.menu\) return;/);
  assert.match(press, /if \(this\.confirm\?\.number === number\) \{\s*this\.confirm = null;\s*return this\.merge\(cx, number\);\s*\}/);
  const merge = body("  merge(cx, number) {");
  assert.match(merge, /const args = mergeArgs\(number, strategy, pr\.head\);\s*this\.acting = true;/);
  assert.match(merge, /r = await exec\("gh", args, \{ cwd: root, on \}\);/);
  assert.match(merge, /catch \(e\) \{ return this\.say\("error", `Can't merge #\$\{number\}: \$\{cantRun\("gh", e\)\}`\); \}/);
  assert.match(merge, /this\.merges\.add\(root, number\);/);
  assert.match(merge, /this\.acting = false;\s*if \(merged\) this\.refresh\(cx, false, true\);/);
  // The refresh drops what was merged since it began, before the lists are taken.
  const refresh = body("  refresh(cx, fromRender = false, force = false) {");
  assert.match(refresh, /if \(n === null\) return;\n(\s*\/\/[^\n]*\n)*\s*const began = this\.merges\.begin\(\);/);
  assert.match(refresh, /if \(found\.fetched\) found\.prs = this\.merges\.filter\(found\.prs, found\.root, began\);\s*Object\.assign\(this, found\);/);
  // Any key, command or press elsewhere takes back a press that only asked.
  assert.match(main, /\.on_mouse_down\("left", \(_e, cx\) => \{ this\.handle\.focus\(\); this\.cancelMerge\(cx\); \}\)/);
  assert.match(body("  onKey(e, cx) {"), /this\.cancelMerge\(cx\);/);
  assert.match(main, /const c = await nextCommand\(\);\n(\s*\/\/[^\n]*\n)*\s*this\.cancelMerge\(cx\);/);
});
