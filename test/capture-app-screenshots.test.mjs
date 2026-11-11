// scripts/capture-app-screenshots.mjs, which takes the README's pictures of the Herdr
// app's panel: what it sets up, offline. Taking the pictures needs Herdr and gh.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSET, SHOTS, TOOLS, WIDTH, agentStub, cropArgs, isolatedEnv, layoutFor, probeFor } from "../scripts/capture-app-screenshots.mjs";

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
