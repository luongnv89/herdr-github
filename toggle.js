#!/usr/bin/env node
// Opens the pull request and issue panel as a right split beside the focused pane, or closes it
// when the focused pane's tab already has one. Panels register their pane id under
// the plugin's state dir, because Herdr's pane list doesn't say which plugin owns a pane.
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const PLUGIN = process.env.HERDR_PLUGIN_ID || "herdr-github";
const REGISTRY = path.join(process.env.HERDR_PLUGIN_STATE_DIR || path.join(os.tmpdir(), "herdr-github"), "panes");
// The panel's share of the tab's width, like the app's 368 px side panel.
const WIDTH = 0.33;
const MIN = 44;

const herdr = (args) => JSON.parse(execFileSync(HERDR, args, { encoding: "utf8" })).result;

const snap = herdr(["api", "snapshot"]).snapshot;
const byId = new Map(snap.panes.map((p) => [p.pane_id, p]));
const here = byId.get(process.env.HERDR_PANE_ID) || byId.get(snap.focused_pane_id);

const panels = [];
for (const file of fs.existsSync(REGISTRY) ? fs.readdirSync(REGISTRY) : []) {
  const id = fs.readFileSync(path.join(REGISTRY, file), "utf8").trim();
  if (byId.has(id)) panels.push(byId.get(id));
  else fs.rmSync(path.join(REGISTRY, file), { force: true });
}

const before = here && snap.layouts.find((l) => l.tab_id === here.tab_id)?.panes.find((p) => p.pane_id === here.pane_id)?.rect;

const open = here ? panels.filter((p) => p.tab_id === here.tab_id) : [];
if (open.length) {
  for (const p of open) herdr(["plugin", "pane", "close", p.pane_id]);
  process.exit(0);
}

const args = ["plugin", "pane", "open", "--plugin", PLUGIN, "--entrypoint", "panel",
  "--placement", "split", "--direction", "right", "--focus"];
// Not --cwd: the pane's command is resolved from its working directory, which must stay the plugin root.
if (here) args.push("--target-pane", here.pane_id, "--env", `HERDR_GITHUB_PANE=${here.pane_id}`, "--env", `HERDR_GITHUB_CWD=${here.cwd}`);
const opened = herdr(args);

// A split takes half the target; give the rest back. The resize amount is a share
// of the split, which spans the target pane's old width.
const pane = opened?.plugin_pane?.pane?.pane_id;
const layout = pane && herdr(["api", "snapshot"]).snapshot.layouts.find((l) => l.tab_id === here?.tab_id);
const rect = layout?.panes.find((p) => p.pane_id === pane)?.rect;
const split = before?.width;
if (rect && split) {
  const extra = rect.width - Math.max(MIN, Math.round(layout.area.width * WIDTH));
  if (extra > 0) {
    try { execFileSync(HERDR, ["pane", "resize", "--pane", pane, "--direction", "right", "--amount", (extra / split).toFixed(4)], { stdio: "ignore" }); } catch {}
  }
}
