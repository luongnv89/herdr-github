#!/usr/bin/env node
// Captures the README's pictures of the terminal panel, from this repo's own open
// issues and pull requests, read live with `gh`: run it from anywhere with
//   node scripts/capture-screenshots.mjs
// It loads panel.js, reads the repo the way the panel does, draws each view at a
// fixed size and writes it as an SVG (see ansi-svg.mjs). Nothing is edited by hand.
//
// It runs only git and gh (or glab): never herdr, mcc or an agent, and never a
// browser. The Resolve menu and the profiles view read example profiles from a
// temporary HOME, never yours.
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { screenLines, toSvg } from "./ansi-svg.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// The example profiles the Resolve menu and the profiles view show.
const EXAMPLE_STORE = {
  version: 1,
  profiles: [
    { id: "claude-opus", name: "Claude Opus", harness: "claude", model: "opus", thinking: "high" },
    { id: "codex", name: "Codex", harness: "codex", thinking: "medium" },
    { id: "opencode", name: "OpenCode", harness: "opencode" },
  ],
  assign: { resolve: "claude-opus", review: "codex" },
};

const COLS = 64;
// The pictures: where each goes, its height in rows, what it shows, and how to get there.
// The picture at the top of the README is the issues list.
const SHOTS = [
  { file: "docs/preview.svg", rows: 22, label: "The panel's issues list for this repo, the selected issue with its Resolve button", view: "issues" },
  { file: "docs/screenshots/pull-requests.svg", rows: 20, label: "The panel's pull requests list for this repo", view: "prs" },
  { file: "docs/screenshots/resolve.svg", rows: 20, label: "The profile menu a Resolve click opens, to choose the agent that starts", view: "action", profiles: true },
  { file: "docs/screenshots/profiles.svg", rows: 24, label: "The agent profiles view, opened with s", view: "settings", profiles: true },
];

const fail = (message) => { console.error(`capture-screenshots: ${message}`); process.exitCode = 1; };

const tmp = mkdtempSync(join(tmpdir(), "herdr-github-shots-"));
const realHome = process.env.HOME;
try {
  await main();
} catch (e) {
  fail(e?.message ?? String(e));
} finally {
  process.env.HOME = realHome;
  rmSync(tmp, { recursive: true, force: true });
}

async function main() {
  // What panel.js reads when it loads: this repo, not followed from any herdr pane,
  // and a state folder of its own, so your panel's remembered list is left alone.
  process.env.HERDR_GITHUB_CWD = root;
  process.env.HERDR_PLUGIN_STATE_DIR = join(tmp, "state");
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_GITHUB_PANE;

  // Only git and the forge's CLI may run: panel.js takes execFile and spawn when
  // it loads, so they are replaced before it does.
  const cp = require("node:child_process");
  const { execFile } = cp;
  cp.execFile = (cmd, args, opts, cb) => {
    if (["git", "gh", "glab"].includes(basename(cmd))) return execFile(cmd, args, opts, cb);
    process.nextTick(cb, new Error(`${cmd} doesn't run while capturing`), "", "");
  };
  cp.spawn = (cmd) => { throw new Error(`${cmd} doesn't run while capturing`); };

  const panel = require(join(root, "panel.js"));
  const P = require(join(root, "profiles.cjs"));
  const { ui } = panel;

  // One frame of the panel at COLS × rows, as the lines it paints.
  const frame = async (rows, fn) => {
    const { stdout } = process, saved = { write: stdout.write, columns: stdout.columns, rows: stdout.rows };
    let last = "";
    stdout.write = (s) => { last = String(s); return true; };
    Object.assign(stdout, { columns: COLS, rows });
    try { await fn(); } finally { Object.assign(stdout, saved); }
    return screenLines(last, rows);
  };

  await frame(20, () => panel.refresh());
  if (ui.error) throw new Error(`can't read the repo: ${ui.error}`);
  for (const view of ["prs", "issues"]) if (ui.errors[view]) throw new Error(`can't read the ${view === "prs" ? "pull requests" : "issues"}: ${ui.errors[view]}`);
  if (ui.forge !== panel.FORGES.github) throw new Error("the repo isn't on GitHub, so it has no Resolve or Review buttons to show");
  // The Resolve (or Review) menu needs a row to open on.
  const actionView = ui.issues.length ? "issues" : ui.prs.length ? "prs" : null;
  if (!actionView) throw new Error(`${ui.repo?.name ?? "the repo"} has no open issue or pull request to open the Resolve or Review menu on`);

  const home = join(tmp, "home");
  const store = join(home, ".config/herdr/plugins/config/herdr-github/profiles.json");
  mkdirSync(dirname(store), { recursive: true });
  writeFileSync(store, JSON.stringify(EXAMPLE_STORE, null, 2));

  const pictures = [];
  for (const shot of SHOTS) {
    // gh read the repo with your HOME; the profiles come from the example one.
    process.env.HOME = shot.profiles ? home : realHome;
    Object.assign(ui, { menu: null, settings: null, notice: null, sel: { prs: 0, issues: 0 }, top: { prs: 0, issues: 0 } });
    const lines = await frame(shot.rows, () => {
      if (shot.view === "settings") {
        panel.onInput("s");
        if (!ui.settings) throw new Error("the profiles view didn't open");
        return panel.draw();
      }
      if (shot.view === "action") {
        ui.view = actionView;
        // With profiles of your own, act opens the menu and starts nothing. Make
        // sure that's so before pressing it: it must never start an agent here.
        const key = actionView === "issues" ? "resolve" : "review";
        if (P.profileChoices(panel.readStore().store, key).entries.length < 2) throw new Error("the example profiles weren't read");
        panel.act(actionView, 0, "row");
        if (!ui.menu || ui.acting) throw new Error("the Resolve or Review menu didn't open");
        return panel.draw();
      }
      ui.view = shot.view;
      return panel.draw();
    });
    Object.assign(ui, { menu: null, settings: null });
    const file = join(root, shot.file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, toSvg(lines, { cols: COLS, rows: shot.rows, width: panel.width, label: shot.label }));
    pictures.push(relative(root, file));
  }
  process.env.HOME = realHome;
  console.log(`${ui.repo.name}: ${ui.prs.length} open pull requests, ${ui.issues.length} open issues`);
  for (const p of pictures) console.log(`wrote ${p}`);
}
