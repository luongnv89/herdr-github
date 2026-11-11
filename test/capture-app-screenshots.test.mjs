// scripts/capture-app-screenshots.mjs, which takes the README's pictures of the Herdr
// app's panel: what it sets up, and how a run stops and checks the panel, offline,
// with a fake app, clock and signals. Taking the pictures needs Herdr and gh.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSET, SHOTS, Stopped, TOOLS, WIDTH, agentStub, buildWorld, captureAll, createAttempt, createStopper, cropArgs, isolatedEnv, layoutFor, probeFor, watchFrames } from "../scripts/capture-app-screenshots.mjs";

const { HARNESSES } = createRequire(import.meta.url)("../profiles.cjs");
const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const dirs = Object.fromEntries(["home", "app", "state", "config", "data", "run", "tmp", "bin"].map((d) => [d, `/tmp/hgs.x/${d}`]));

test("layoutFor: the panel alone, inset from the top left, at the picture's size", () => {
  const shot = { height: 300 };
  const layout = layoutFor(shot);
  assert.equal(layout.titlebar, "none");
  const [above, top] = layout.children;
  assert.deepEqual(above.size, { px: INSET });
  assert.deepEqual(top.size, { px: 300 });
  const [left, panel] = top.children;
  assert.deepEqual(left.size, { px: INSET });
  assert.deepEqual(panel.content, { mod: "herdr-github" });
  assert.deepEqual(panel.size, { px: WIDTH });
  const blocks = JSON.stringify(layout).match(/"type":"block"/g);
  assert.equal(blocks.length, 1, "nothing but the panel is drawn");
});

test("cropArgs: the panel's rectangle in pixels, never at offset 0", () => {
  assert.deepEqual(cropArgs({ height: 300 }, 2), ["--cropOffset", String(INSET * 2), String(INSET * 2), "-c", "600", String(WIDTH * 2)]);
  assert.deepEqual(cropArgs({ height: 300 }, 1), ["--cropOffset", String(INSET), String(INSET), "-c", "300", String(WIDTH)]);
  assert.ok(INSET > 0, "sips crops the middle at offset 0");
});

test("isolatedEnv: built from nothing, so your app, core and agents are out of reach", () => {
  const env = isolatedEnv(dirs, { user: "me", ghConfigDir: "/Users/me/.config/gh" });
  assert.equal(env.HOME, dirs.home);
  assert.equal(env.HERDR_APP_HOME, dirs.app);
  assert.equal(env.XDG_RUNTIME_DIR, dirs.run, "herdr-core's socket is the isolated one");
  assert.equal(env.XDG_STATE_HOME, dirs.state);
  assert.equal(env.GH_CONFIG_DIR, "/Users/me/.config/gh");
  assert.equal(env.HERDR_TELEMETRY, "0");
  assert.ok(env.PATH.startsWith(`${dirs.bin}:`), "the stand-ins come first");
  for (const p of env.PATH.split(":")) assert.ok(!/\.local|homebrew|\/usr\/local/.test(p), `${p} isn't on the PATH`);
  for (const k of Object.keys(env)) assert.ok(!k.startsWith("HC_"), `${k} would reach your herdr-core`);
});

test("agentStub: each harness's program refuses to run", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-stub-"));
  try {
    for (const h of HARNESSES) {
      assert.ok(!TOOLS.includes(h));
      const file = join(dir, h);
      writeFileSync(file, agentStub(h), { mode: 0o755 });
      const r = spawnSync(file, ["--anything"], { encoding: "utf8" });
      assert.equal(r.status, 1, h);
      assert.match(r.stderr, new RegExp(`^${h} doesn't run`));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SHOTS: each picture is checked by a panel command, and is in the README", () => {
  for (const shot of SHOTS) {
    assert.ok(["resolve", "settings"].includes(probeFor(shot)), shot.file);
    assert.match(shot.file, /^docs\/screenshots\/app-[a-z]+\.png$/);
    assert.match(README, new RegExp(`<img src="${shot.file}" width="${WIDTH}" alt="[^"]+">`), `${shot.file} isn't shown in the README, with alt text`);
  }
  assert.equal(probeFor({}), "resolve", "a list picture is checked with the Resolve menu, which opens only on a row");
});

// Where a login zsh finds `cmd`, under the isolated environment.
const zshWhich = (env, cmd) => spawnSync("zsh", ["-l", "-c", `command -v ${cmd}`], { env, encoding: "utf8" }).stdout.trim();
const hasZsh = spawnSync("zsh", ["-c", "true"]).status === 0;

test("buildWorld: in a login shell, every agent's program is its stand-in and the tools are yours", { skip: !hasZsh && "no zsh here" }, () => {
  // herdr-core starts programs from a login zsh, whose /etc/zprofile (path_helper on
  // macOS) puts Homebrew and /usr/local ahead of the PATH it was given.
  const world = mkdtempSync(join(tmpdir(), "hgs-test-"));
  try {
    const tools = Object.fromEntries(TOOLS.map((t) => [t, spawnSync("/bin/sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim()]).filter(([, p]) => p));
    const dirs = buildWorld(world, tools);
    const env = isolatedEnv(dirs, { user: "me", ghConfigDir: join(world, "gh") });
    for (const h of HARNESSES) assert.equal(zshWhich(env, h), join(dirs.bin, h), `${h} isn't its stand-in in a login shell`);
    for (const t of Object.keys(tools)) assert.equal(zshWhich(env, t), join(dirs.bin, t), `${t} isn't found`);
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
});

// A fake clock and a list of frames, so watchFrames runs without waiting.
function frames(list) {
  let t = 0, i = 0;
  const frame = async () => ({ bytes: Buffer.from(list(i++)) });
  return { frame, now: () => t, nap: async (ms) => { t += ms; } };
}
const opts = { poll: 200, settled: 600, wait: 4000 };

test("watchFrames: a panel that keeps changing, as while it loads, never counts as settled", async () => {
  const spinner = frames((i) => (i % 2 ? "spin-a" : "spin-b"));
  assert.equal(await watchFrames(spinner.frame, { ...opts, ...spinner }), null);
});

test("watchFrames: a panel that stops changing is taken once it has stayed the same", async () => {
  const loads = frames((i) => (i < 5 ? `loading-${i}` : "loaded"));
  const f = await watchFrames(loads.frame, { ...opts, ...loads });
  assert.equal(f.bytes.toString(), "loaded");
  assert.ok(loads.now() >= 5 * 200 + 600, "not before it stayed the same for the settle time");
});

test("watchFrames: with `changed`, the first frame it holds for, or null when none does", async () => {
  const menu = frames((i) => (i < 3 ? "list" : "menu"));
  const changed = (f) => f.bytes.toString() !== "list";
  assert.equal((await watchFrames(menu.frame, { ...opts, ...menu, changed })).bytes.toString(), "menu");
  const still = frames(() => "list");
  assert.equal(await watchFrames(still.frame, { ...opts, ...still, changed }), null);
});

// --- The run itself, offline: a fake app, a fake clock and fake signals. ---

// A clock that only moves when the code under test naps.
function fakeClock() {
  let t = 0;
  return { now: () => t, nap: async (ms) => { t += ms; } };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
// Node 20 has no Promise.withResolvers.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// What the panel draws at frame `t`, given what it was sent: three frames while its
// issues load, then the list; focus adds a border; a command's view takes three
// frames to open, then holds.
const panel = (s, t) => {
  if (t < 3) return `loading-${t}`;
  const parts = ["list", s.focused ? "focused" : ""];
  if (s.sent) parts.push(t - s.sentAt < 3 ? `${s.sent}-opening-${t - s.sentAt}` : s.sent);
  return parts.filter(Boolean).join("|");
};
// An app that stops drawing once focused: focus redraws the border, then nothing
// the probe does ever shows.
const frozen = (s, t) => (t < 3 ? `loading-${t}` : s.focused ? "list|focused" : "list");
// A panel whose header spinner never stops, as when its issues never load.
const spinning = (s, t) => `spin-${t % 2}`;

// A fake Herdr app drawing `draw`, each launch from frame 0. `on(cmd)` runs as each
// command arrives, before it takes effect.
function fakeApp(draw, on = () => {}) {
  const calls = [];
  let s, t;
  const app = async (...args) => {
    const cmd = args.join(" ");
    calls.push(cmd);
    await on(cmd);
    if (cmd === "ls") return { stdout: JSON.stringify({ spaces: [] }) };
    if (cmd === "do herdr-github.focus") s.focused = true;
    else if (cmd.startsWith("do herdr-github.")) { s.sent = cmd.slice("do herdr-github.".length); s.sentAt = t; }
    return { stdout: "" };
  };
  const reset = () => { s = { focused: false, sent: null, sentAt: 0 }; t = 0; };
  reset();
  const shots = { count: 0 };
  const shoot = async () => {
    shots.count++;
    const at = t++;
    return { file: `frame-${calls.length}-${at}.png`, bytes: Buffer.from(draw(s, at)) };
  };
  return { app, shoot, calls, reset, shots };
}

// The run wired as main() wires it, with everything outside replaced: the stopper,
// one launch, and the loop over the pictures.
function rig({ draw = panel, onApp, onSips, quitApp = async () => {}, stopCore = async () => {} } = {}) {
  const clock = fakeClock();
  const signals = new EventEmitter();
  const log = { launches: 0, seeds: 0, sips: [], placed: [], warned: [], exits: [], cleanups: { quitApp: 0, stopCore: 0, removeWorld: 0 } };
  const stopper = createStopper({
    quitApp: () => { log.cleanups.quitApp++; return quitApp(signals); },
    stopCore: () => { log.cleanups.stopCore++; return stopCore(); },
    removeWorld: () => { log.cleanups.removeWorld++; },
    signals, exit: (code) => log.exits.push(code), alive: () => false, kill: () => {}, nap: clock.nap,
  });
  const fake = fakeApp(draw, onApp ? (cmd) => onApp(cmd, signals) : undefined);
  const attempt = createAttempt({
    halt: stopper.halt,
    seed: () => { log.seeds++; },
    launch: () => { log.launches++; fake.reset(); stopper.launched(1000 + log.launches); },
    app: fake.app, shoot: fake.shoot, quit: stopper.quit, repo: "/repo", nap: clock.nap,
    watch: { ...opts, now: clock.now, nap: clock.nap },
  });
  const run = () => captureAll({
    shots: SHOTS, attempt, halt: stopper.halt,
    sips: async (args) => {
      log.sips.push(args);
      if (onSips) await onSips(args, signals);
      return { stdout: args[0] === "-g" ? "  pixelWidth: 2560\n" : "" };
    },
    out: (shot) => `/out/${shot.file}`,
    place: (from, to) => log.placed.push(to),
    warn: (m) => log.warned.push(m),
  });
  return { stopper, signals, log, fake, attempt, run, clock };
}

test("attempt: launches, waits for the panel, focuses it, lets that settle, then sends the view's command", async () => {
  const { attempt, fake, log } = rig();
  const shot = SHOTS.find((s) => !s.command);
  const f = await attempt(shot);
  assert.equal(f.bytes.toString(), "list", "a list picture is the loaded panel, before focus or the probe");
  assert.deepEqual(fake.calls, ["status", "ls", "do space.new --folder /repo", "do herdr-github.focus", "do herdr-github.resolve"]);
  assert.equal(log.launches, 1);
  assert.equal(log.cleanups.quitApp, 1, "the app is quit after each launch");
});

test("attempt: a change caused only by focusing the panel doesn't prove the command took effect", async () => {
  // Focus redraws the border, then the app stops drawing: the probe never shows.
  // Comparing the probe's frame with the loaded one would take the focus redraw for it.
  for (const shot of SHOTS) {
    const { attempt, fake } = rig({ draw: frozen });
    assert.equal(await attempt(shot), null, shot.file);
    assert.ok(fake.calls.includes(`do herdr-github.${probeFor(shot)}`), "the probe was sent, after focus");
  }
});

test("attempt: a command's view is taken once it has settled, not mid-change", async () => {
  for (const shot of SHOTS.filter((s) => s.command)) {
    const { attempt } = rig();
    const f = await attempt(shot);
    assert.equal(f.bytes.toString(), `list|focused|${shot.command}`, shot.file);
  }
});

test("attempt: a launch whose panel never settles, before or after focus, is null and still quit", async () => {
  const { attempt, fake, log } = rig({ draw: spinning });
  assert.equal(await attempt(SHOTS[0]), null);
  assert.ok(!fake.calls.includes("do herdr-github.focus"), "nothing is sent to a panel still loading");
  assert.equal(log.cleanups.quitApp, 1);

  // Settles while loading, but focusing starts a spinner that never stops.
  const restless = (s, t) => (t < 3 ? `loading-${t}` : s.focused ? `spin-${t % 2}` : "list");
  const r = rig({ draw: restless });
  assert.equal(await r.attempt(SHOTS[1]), null);
  assert.ok(!r.fake.calls.includes("do herdr-github.resolve"), "no probe on a panel that didn't settle after focus");
  assert.equal(r.log.cleanups.quitApp, 1);
});

test("captureAll: a picture whose launches never settle isn't taken, and nothing is put in place", async () => {
  const { run, log } = rig({ draw: spinning });
  await assert.rejects(run(), /couldn't be taken 3 times/);
  assert.equal(log.launches, 3);
  assert.equal(log.warned.length, 2, "trying again, twice");
  assert.deepEqual(log.placed, []);
});

test("captureAll: with nothing stopping it, every picture is cut out and only then put in place", async () => {
  const { run, log, stopper } = rig();
  await run();
  assert.equal(log.launches, SHOTS.length);
  assert.equal(log.placed.length, SHOTS.length);
  for (const shot of SHOTS) assert.ok(log.placed.some((p) => p.endsWith(shot.file)), shot.file);
  await stopper.finish();
  assert.deepEqual(log.exits, []);
});

// Where Ctrl+C lands, and what must not happen after it.
const stops = [
  ["while the app starts", { onApp: (cmd, sig) => { if (cmd === "status") sig.emit("SIGINT"); } }],
  ["mid-attempt, as the panel is focused", { onApp: (cmd, sig) => { if (cmd === "do herdr-github.focus") sig.emit("SIGTERM"); } }],
  ["as the app quits after a launch that didn't settle", { draw: spinning, quitApp: async (sig) => { sig.emit("SIGINT"); } }],
  ["as the first picture's size is read", { onSips: (args, sig) => { if (args[0] === "-g") sig.emit("SIGINT"); } }],
  ["as the last picture is cut out", { onSips: (args, sig) => { if (args.includes("--out") && args.at(-1).endsWith(SHOTS.at(-1).file)) sig.emit("SIGINT"); } }],
];
for (const [when, opts] of stops) {
  test(`Ctrl+C ${when}: nothing more launches or is put in place, cleanup runs once, and it exits 130`, async () => {
    const r = rig(opts);
    let launchesAtStop = null, sipsAtStop = null, framesAtStop = null;
    // What had happened when the first signal arrived.
    const atStop = () => { if (launchesAtStop !== null) return; launchesAtStop = r.log.launches; sipsAtStop = r.log.sips.length; framesAtStop = r.fake.shots.count; };
    r.signals.prependListener("SIGINT", atStop);
    r.signals.prependListener("SIGTERM", atStop);
    await assert.rejects(r.run(), Stopped);
    await r.stopper.finish();
    await settle();
    assert.ok(launchesAtStop !== null, "the signal arrived");
    assert.equal(r.log.launches, launchesAtStop, "no launch after the signal");
    assert.equal(r.log.sips.length, sipsAtStop, "no sips after the signal");
    assert.equal(r.fake.shots.count, framesAtStop, "no frame taken after the signal");
    assert.deepEqual(r.log.placed, [], "no picture put in place");
    assert.deepEqual(r.log.cleanups, { quitApp: r.log.cleanups.quitApp, stopCore: 1, removeWorld: 1 });
    assert.ok(r.log.cleanups.quitApp <= r.log.launches, "each launch quit at most once");
    assert.deepEqual(r.log.exits, [130]);
    assert.equal(r.signals.listenerCount("SIGINT"), 2, "still listening, so a second Ctrl+C can't end it early");
  });
}

test("Ctrl+C twice: cleanup runs once, and the run ends only once it has finished", async () => {
  const quitting = deferred();
  const r = rig({ quitApp: () => quitting.promise });
  r.stopper.launched(42);
  r.signals.emit("SIGINT");
  r.signals.emit("SIGINT");
  r.signals.emit("SIGTERM");
  await settle();
  assert.deepEqual(r.log.exits, [], "not before the app is stopped");
  assert.equal(r.log.cleanups.quitApp, 1);
  assert.equal(r.log.cleanups.removeWorld, 0);
  quitting.resolve();
  await settle();
  assert.deepEqual(r.log.cleanups, { quitApp: 1, stopCore: 1, removeWorld: 1 });
  assert.deepEqual(r.log.exits, [130]);
  // The run unwinds while stopping: finish waits on the same cleanup.
  await r.stopper.finish();
  assert.deepEqual(r.log.cleanups, { quitApp: 1, stopCore: 1, removeWorld: 1 });
  assert.equal(r.signals.listenerCount("SIGINT"), 1);
  assert.equal(r.signals.listenerCount("SIGTERM"), 1);
});

test("createStopper: halt throws only once stopping; quit and cleanup each run once", async () => {
  const quitting = deferred();
  const r = rig({ quitApp: () => quitting.promise });
  assert.doesNotThrow(() => r.stopper.halt());
  r.stopper.launched(7);
  const a = r.stopper.quit(), b = r.stopper.quit();
  assert.equal(a, b, "a second quit waits for the first");
  const c1 = r.stopper.cleanup(), c2 = r.stopper.cleanup();
  assert.equal(c1, c2);
  quitting.resolve();
  await c1;
  assert.deepEqual(r.log.cleanups, { quitApp: 1, stopCore: 1, removeWorld: 1 });
  assert.equal(r.stopper.stopping, false);
  r.signals.emit("SIGINT");
  assert.throws(() => r.stopper.halt(), Stopped);
});

test("createStopper: an app that won't quit is killed", async () => {
  const killed = [];
  const clock = fakeClock();
  const s = createStopper({ quitApp: async () => { throw new Error("no answer"); }, stopCore: async () => {}, removeWorld: () => {}, signals: new EventEmitter(), exit: () => {}, alive: () => true, kill: (pid) => killed.push(pid), nap: clock.nap });
  s.launched(9);
  await s.quit();
  assert.deepEqual(killed, [9]);
  assert.equal(clock.now(), 3000, "after waiting 3 s for it");
});

test("finish: with no signal, it cleans up and lets go of Ctrl+C", async () => {
  const r = rig();
  assert.equal(r.signals.listenerCount("SIGINT"), 1);
  await r.stopper.finish();
  assert.deepEqual(r.log.cleanups, { quitApp: 0, stopCore: 1, removeWorld: 1 });
  assert.equal(r.signals.listenerCount("SIGINT"), 0);
  assert.equal(r.signals.listenerCount("SIGTERM"), 0);
});

test("Ctrl+C during the final cleanup of a run that finished: the pictures are in, and it exits 130", async () => {
  // Pinned as it is: the pictures were already put in place when the signal lands.
  const stopping = deferred();
  const r = rig({ stopCore: () => stopping.promise });
  await r.run();
  const done = r.stopper.finish();
  await settle();
  r.signals.emit("SIGINT");
  stopping.resolve();
  await done;
  await settle();
  assert.equal(r.log.placed.length, SHOTS.length);
  assert.deepEqual(r.log.exits, [130]);
  assert.equal(r.log.cleanups.stopCore, 1);
});

test("Ctrl+C while waiting for the app to start: it stops asking, and nothing more is sent", async () => {
  let asked = 0;
  const r = rig({ onApp: (cmd, sig) => {
    if (cmd !== "status") return;
    if (++asked === 1) sig.emit("SIGINT");
    throw new Error("not up yet");
  } });
  await assert.rejects(r.run(), Stopped);
  await r.stopper.finish();
  await settle();
  assert.equal(asked, 1);
  assert.deepEqual(r.fake.calls, ["status"]);
  assert.equal(r.log.launches, 1);
  assert.deepEqual(r.log.exits, [130]);
});
