#!/usr/bin/env node
// Captures the README's pictures of the Herdr app's panel (mods/herdr-github), from
// this repo's own open issues, read live with `gh`: on a Mac with Herdr installed, run
//   node scripts/capture-app-screenshots.mjs
// The app draws each picture itself (`herdr-app shot`), and the script crops the
// panel out of it. Nothing is edited by hand.
//
// It runs a second Herdr app in a world of its own: its own HOME, app home and
// herdr-core, in a temporary folder. Your window, spaces, terminals and profiles are
// never touched, and it shows example profiles, never yours. No agent can start in
// it: the programs the profiles start are stand-ins there that refuse to run, first
// on the PATH of a login shell too.
//
// An app window that's off screen draws only for its first few seconds, so each
// picture is one fresh launch: set the state, launch, wait for the panel to settle,
// send the view's command, shoot, quit. Ctrl+C stops it: nothing more launches, the
// app and its herdr-core are stopped, the folder is deleted and no picture is written.
import { execFile as execFileCb, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// The programs agent profiles start, from the profiles module (its CommonJS copy).
const { HARNESSES } = createRequire(import.meta.url)("../profiles.cjs");

const execFile = promisify(execFileCb);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The panel's width, and how far it sits from the window's corner, in points. The
// inset is there because sips ignores a crop offset of 0 and crops the middle.
export const WIDTH = 420;
export const INSET = 8;
// The window, in points. With bounds much smaller the app opens full screen.
export const WINDOW = { w: 1280, h: 820 };
// How often to look at the app's frame, how long a frame must stay the same to count
// as settled, and how long the panel may take to settle or a command to show. While
// the issues load, the header's spinner turns, so a loading panel never settles. A
// launch that doesn't settle, or whose frames stop too soon, is tried again, up to
// TRIES times.
const POLL_MS = 200;
const SETTLED_MS = 600;
const WAIT_MS = 4000;
const TRIES = 3;

// The pictures: where each goes, the panel's height in points, the list it shows,
// and the panel command that opens the view. The profiles view is cut just below
// the prompts, above the profiles file's path.
export const SHOTS = [
  { file: "docs/screenshots/app-issues.png", height: 300, view: "issues" },
  { file: "docs/screenshots/app-resolve.png", height: 420, view: "issues", command: "resolve" },
  { file: "docs/screenshots/app-profiles.png", height: 716, view: "issues", command: "settings" },
];
// The command that shows the app was still drawing when the panel settled, so the
// settled frame wasn't a frozen one: it's sent once the panel is focused, and the
// Resolve menu opens only on a row. For a picture with no command, it runs after
// the shot.
export const probeFor = (shot) => shot.command ?? "resolve";

// The example profiles the Resolve menu and the profiles view show, as in
// capture-screenshots.mjs.
export const EXAMPLE_STORE = {
  version: 1,
  profiles: [
    { id: "claude-opus", name: "Claude Opus", harness: "claude", model: "opus", thinking: "high" },
    { id: "codex", name: "Codex", harness: "codex", thinking: "medium" },
    { id: "opencode", name: "OpenCode", harness: "opencode" },
  ],
  assign: { resolve: "claude-opus", review: "codex" },
};

// The programs the isolated world may run, as links to yours.
export const TOOLS = ["git", "gh", "hc", "herdr-core", "herdr-app"];

// A stand-in for an agent's program: first on the isolated PATH, so even an agent
// started by mistake runs this, which refuses.
export const agentStub = (cmd) => `#!/bin/sh\necho "${cmd} doesn't run while the screenshots are taken" >&2\nexit 1\n`;

// The isolated home's ~/.zprofile. herdr-core starts programs from a login zsh, whose
// /etc/zprofile runs path_helper: that puts /etc/paths and /etc/paths.d (Homebrew,
// /usr/local) ahead of the PATH it was given. ~/.zprofile runs after it, and puts the
// stand-ins first again.
const shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
export const zprofile = (dirs) => `export PATH=${shellQuote(dirs.bin)}:"$PATH"\n`;

const WORLD_DIRS = ["home", "app", "state", "config", "data", "run", "tmp", "bin", "out"];

// The isolated world's folders in `world`: the tools as links to yours (`tools` maps
// each name to its path), a stand-in for every agent's program, and the ~/.zprofile
// that keeps them first.
export function buildWorld(world, tools) {
  const dirs = Object.fromEntries(WORLD_DIRS.map((d) => [d, join(world, d)]));
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const [t, path] of Object.entries(tools)) symlinkSync(path, join(dirs.bin, t));
  for (const h of HARNESSES) writeFileSync(join(dirs.bin, h), agentStub(h), { mode: 0o755 });
  writeFileSync(join(dirs.home, ".zprofile"), zprofile(dirs));
  return dirs;
}

// Frames from `frame()` until one stays the same for `settled` ms, or, with
// `changed`, until it holds for one: that frame. null when neither happens within
// `wait` ms, as when the panel is still loading.
export async function watchFrames(frame, { changed = null, poll = POLL_MS, settled = SETTLED_MS, wait = WAIT_MS, nap = sleep, now = Date.now } = {}) {
  let last = await frame(), since = now();
  for (const start = now(); now() - start < wait;) {
    await nap(poll);
    const next = await frame();
    if (changed) {
      if (changed(next)) return next;
    } else if (!next.bytes.equals(last.bytes)) {
      last = next;
      since = now();
    } else if (now() - since >= settled) {
      return last;
    }
  }
  return null;
}

// Thrown to unwind the run once Ctrl+C (or SIGTERM) has stopped it.
class Stopped extends Error {}

// The layout: the panel alone, near the top left of the window, at the shot's height.
export function layoutFor(shot) {
  return {
    id: "root", type: "column", titlebar: "none", children: [
      { id: "above", type: "row", size: { px: INSET }, children: [] },
      { id: "top", type: "row", size: { px: shot.height }, children: [
        { id: "left", type: "row", size: { px: INSET }, children: [] },
        { id: "github", type: "block", size: { px: WIDTH }, content: { mod: "herdr-github" } },
        { id: "right", type: "row", children: [] }] },
      { id: "bottom", type: "row", children: [] }],
  };
}

// sips' arguments to cut the panel out of a frame drawn at `scale` pixels per point.
export function cropArgs(shot, scale) {
  const px = (pt) => String(Math.round(pt * scale));
  return ["--cropOffset", px(INSET), px(INSET), "-c", px(shot.height), px(WIDTH)];
}

// The isolated world's environment, built from nothing: no HC_* or HERDR_* of yours,
// so neither your app nor your herdr-core is ever reached.
export function isolatedEnv(dirs, { user, ghConfigDir }) {
  return {
    HOME: dirs.home, USER: user, LOGNAME: user, SHELL: "/bin/zsh", TERM: "xterm-256color",
    PATH: `${dirs.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    XDG_STATE_HOME: dirs.state, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_RUNTIME_DIR: dirs.run, TMPDIR: dirs.tmp,
    HERDR_APP_HOME: dirs.app, HERDR_APP_NO_SOUND: "1", DO_NOT_TRACK: "1", HERDR_TELEMETRY: "0",
    // gh reads your login where it is; nothing is copied.
    GH_CONFIG_DIR: ghConfigDir,
  };
}

async function main() {
  if (process.platform !== "darwin") throw new Error("the Herdr app's pictures are taken on macOS");
  const which = async (cmd) => {
    try { return (await execFile("/bin/sh", ["-c", `command -v ${cmd}`])).stdout.trim(); } catch { return ""; }
  };
  const tools = Object.fromEntries(await Promise.all(TOOLS.map(async (t) => [t, await which(t)])));
  const missing = TOOLS.filter((t) => !tools[t]);
  if (missing.length) throw new Error(`${missing.join(", ")} not found: install Herdr (and gh) first`);

  // The Resolve menu needs an open issue, and gh must read the repo: check before
  // anything starts, and write nothing when it can't.
  let issues;
  try {
    issues = JSON.parse((await execFile(tools.gh, ["issue", "list", "--state", "open", "--limit", "1", "--json", "number"], { cwd: root })).stdout);
  } catch (e) {
    throw new Error(`gh can't read the repo's issues: ${(e.stderr || e.message).trim()}`);
  }
  if (!issues.length) throw new Error("the repo has no open issue to open the Resolve menu on");

  // A unix socket path is at most 103 bytes here, and herdr-core's socket goes under
  // XDG_RUNTIME_DIR, so the isolated world lives in a short folder under /tmp.
  const world = mkdtempSync("/tmp/hgs.");
  const dirs = buildWorld(world, tools);
  const env = isolatedEnv(dirs, { user: process.env.USER, ghConfigDir: process.env.GH_CONFIG_DIR ?? join(homedir(), ".config/gh") });
  const app = (...args) => execFile(join(dirs.bin, "herdr-app"), args, { env, cwd: world });
  const repo = realpathSync(root);

  // Ctrl+C or SIGTERM sets `stopping`: the run unwinds at its next check, so nothing
  // more launches or is written. Each check sits right before what it guards, with no
  // await between them.
  let stopping = false;
  const halt = () => { if (stopping) throw new Stopped(); };

  // Quitting and cleaning up each happen once: a second caller waits for the first.
  let child = null;
  let quitting = Promise.resolve();
  const quit = () => {
    if (child) {
      const { pid } = child;
      child = null;
      quitting = (async () => {
        try { await app("do", "app.quit"); } catch {}
        const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
        for (let i = 0; i < 30 && alive(); i++) await sleep(100);
        if (alive()) process.kill(pid, "SIGKILL");
      })();
    }
    return quitting;
  };
  let cleaning = null;
  const cleanup = () => (cleaning ??= (async () => {
    await quit();
    try { await execFile(join(dirs.bin, "hc"), ["server", "stop"], { env, cwd: world }); } catch {}
    rmSync(world, { recursive: true, force: true });
  })());
  // Kept for the whole run: a second Ctrl+C while cleaning up must not end the
  // process before the app is stopped.
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    cleanup().finally(() => process.exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // The app's last frame, saved to `file`, and its bytes.
  let n = 0;
  const frame = async () => {
    halt();
    const file = join(dirs.tmp, `frame-${n++}.png`);
    await app("shot", file);
    return { file, bytes: readFileSync(file) };
  };
  const watch = (changed = null) => watchFrames(frame, { changed });

  // One launch: the picture's frame, or null when the panel didn't settle or the app
  // stopped drawing too soon.
  const attempt = async (shot) => {
    halt();
    seed(dirs, shot);
    child = spawn(join(dirs.bin, "herdr-app"), [], { env, cwd: world, detached: true, stdio: "ignore" });
    child.unref();
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        halt();
        try { await app("status"); up = true; } catch { await sleep(100); }
      }
      if (!up) throw new Error("the Herdr app didn't start");
      const { spaces = [] } = JSON.parse((await app("ls")).stdout);
      if (!spaces.some((s) => s.folder === repo)) await app("do", "space.new", "--folder", repo);
      // The panel once its issues are in: a loading one doesn't settle.
      const loaded = await watch();
      if (!loaded) return null;
      // Focus redraws the panel's border, so focus first and let it settle: then the
      // probe's change is the probe's own, and proves the app was still drawing.
      await app("do", "herdr-github.focus");
      const focused = await watch();
      if (!focused) return null;
      await app("do", `herdr-github.${probeFor(shot)}`);
      if (!(await watch((f) => !f.bytes.equals(focused.bytes)))) return null;
      // A view a command opened is taken once it has settled, not mid-change.
      return shot.command ? await watch() : loaded;
    } finally {
      await quit();
    }
  };

  try {
    const written = [];
    for (const shot of SHOTS) {
      let picked = null;
      for (let i = 0; i < TRIES && !picked; i++) {
        picked = await attempt(shot);
        if (!picked && i < TRIES - 1) console.error(`${shot.file}: the panel didn't settle, or the app stopped drawing too soon: trying again`);
      }
      if (!picked) throw new Error(`${shot.file} couldn't be taken ${TRIES} times (the panel didn't settle, or the app stopped drawing too soon): run it again`);
      halt();
      const width = Number(/pixelWidth: (\d+)/.exec((await execFile("sips", ["-g", "pixelWidth", picked.file])).stdout)?.[1]);
      if (!width) throw new Error("couldn't read the app's picture");
      const picture = join(dirs.out, shot.file.replaceAll("/", "_"));
      halt();
      await execFile("sips", [...cropArgs(shot, width / WINDOW.w), picked.file, "--out", picture]);
      written.push([picture, join(root, shot.file)]);
    }
    // Only once every picture is taken do they replace the old ones.
    halt();
    for (const [from, to] of written) {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      console.log(`wrote ${relative(root, to)}`);
    }
  } finally {
    await cleanup();
    if (!stopping) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
}

// The app's state before a launch: the mod, the panel-only layout, no welcome, the
// list to show, a window of a known size, and the example profiles.
function seed(dirs, shot) {
  cpSync(join(root, "mods/herdr-github"), join(dirs.app, "mods/herdr-github"), { recursive: true });
  mkdirSync(join(dirs.app, "layouts"), { recursive: true });
  writeFileSync(join(dirs.app, "layouts/shot.json"), JSON.stringify(layoutFor(shot)));
  const sharedFile = join(dirs.app, "shared.json");
  const shared = existsSync(sharedFile) ? JSON.parse(readFileSync(sharedFile, "utf8")) : {};
  writeFileSync(sharedFile, JSON.stringify({ ...shared, layout: "shot", "frame.welcomed": "finished" }));
  writeFileSync(join(dirs.app, "window.json"), JSON.stringify({ state: "windowed", bounds: [200, 120, WINDOW.w, WINDOW.h] }));
  mkdirSync(join(dirs.app, "data/herdr-github"), { recursive: true });
  writeFileSync(join(dirs.app, "data/herdr-github/store.json"), JSON.stringify({ view: shot.view }));
  const store = join(dirs.home, ".config/herdr/plugins/config/herdr-github/profiles.json");
  mkdirSync(dirname(store), { recursive: true });
  writeFileSync(store, JSON.stringify(EXAMPLE_STORE));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    // Stopped by Ctrl+C: the signal handler exits 130 once it has cleaned up.
    if (e instanceof Stopped) return;
    console.error(`capture-app-screenshots: ${e?.message ?? e}`);
    process.exitCode = 1;
  });
}
