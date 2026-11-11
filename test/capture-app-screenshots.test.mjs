// scripts/capture-app-screenshots.mjs, which takes the README's pictures of the Herdr
// app's panel: what it sets up, offline. Taking the pictures needs Herdr and gh.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSET, SHOTS, TOOLS, WIDTH, agentStub, buildWorld, cropArgs, isolatedEnv, layoutFor, probeFor, watchFrames } from "../scripts/capture-app-screenshots.mjs";

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
