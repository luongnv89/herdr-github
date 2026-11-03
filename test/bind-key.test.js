"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const b = require("../bind-key.js");

const SCRIPT = path.join(__dirname, "..", "bind-key.js");
const CONFIG = `[keys]
new_tab = "prefix+c"

[[keys.command]]
key = "prefix+u"
type = "plugin_action"
command = "mcc-usage.toggle"
description = "mcc usage panel"

[ui]
sidebar_width = 30
`;

test("boundKey finds the key of an action's binding", () => {
  assert.equal(b.boundKey(CONFIG, "mcc-usage.toggle"), "prefix+u");
  assert.equal(b.boundKey(CONFIG, "herdr-github.toggle"), null);
  assert.equal(b.boundKey("", "x.toggle"), null);
});

test("usedKeys reads bindings, defaults when commented, and digit ranges", () => {
  const used = b.usedKeys(CONFIG);
  assert.ok(used.has("prefix+c") && used.has("prefix+u"));
  assert.ok(!used.has("prefix+i"));
  const defaults = b.usedKeys('# new_tab = "prefix+c"\n# switch_tab = "prefix+1..9"\n# clear_pane = ""   # e.g. "prefix+ctrl+k"\n', true);
  assert.ok(defaults.has("prefix+c") && defaults.has("prefix+1") && defaults.has("prefix+9"));
  assert.ok(!defaults.has("prefix+ctrl+k"), "a key in a trailing comment is only an example");
  assert.ok(!b.usedKeys('# new_tab = "prefix+c"\n').has("prefix+c"), "a commented line in your config binds nothing");
});

test("boundKey and usedKeys read a CRLF config like the same config with LF endings", () => {
  const crlf = CONFIG.replace(/\n/g, "\r\n");
  assert.equal(b.boundKey(crlf, "mcc-usage.toggle"), "prefix+u");
  assert.equal(b.boundKey(crlf, "herdr-github.toggle"), null);
  const used = b.usedKeys(crlf);
  assert.ok(used.has("prefix+c") && used.has("prefix+u"), [...used].join(", "));
  assert.deepEqual([...used].sort(), [...b.usedKeys(CONFIG)].sort());
  assert.ok(b.usedKeys('# switch_tab = "prefix+1..9"\r\n', true).has("prefix+9"));
});

test("configPath prefers HERDR_CONFIG_PATH, then XDG_CONFIG_HOME, then ~/.config", () => {
  assert.equal(b.configPath({ HERDR_CONFIG_PATH: "/x/herdr.toml", XDG_CONFIG_HOME: "/xdg" }), "/x/herdr.toml");
  assert.equal(b.configPath({ HERDR_CONFIG_PATH: "", XDG_CONFIG_HOME: "/xdg" }), path.join("/xdg", "herdr", "config.toml"));
  assert.equal(b.configPath({ XDG_CONFIG_HOME: "/xdg" }), path.join("/xdg", "herdr", "config.toml"));
  assert.equal(b.configPath({}), path.join(os.homedir(), ".config", "herdr", "config.toml"));
});

test("firstIssue quotes the first problem herdr config check reported", () => {
  assert.equal(b.firstIssue("config: issues found\nconfig parse error: TOML parse error at line 1\n  |\n"), "config parse error: TOML parse error at line 1");
  assert.equal(b.firstIssue("config: issues found\r\nunknown config key keys.foo; ignoring key\r\n"), "unknown config key keys.foo; ignoring key");
});

test("pickKey takes the preferred key when free, else the next free one", () => {
  assert.equal(b.pickKey(new Set(), "prefix+i"), "prefix+i");
  assert.equal(b.pickKey(new Set(["prefix+i", "prefix+a"]), "prefix+i"), "prefix+b");
});

// End to end, against a throwaway config dir; the running server is left alone.
// HERDR_CONFIG_PATH is cleared so a developer's own setting never points a test at
// their real config; `runWith` sets it to a throwaway file instead.
function run(xdg, ...args) { return runWith({}, xdg, ...args); }
function runWith(extra, xdg, ...args) {
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HERDR_BIND_KEY_NO_RELOAD: "1", HERDR_PLUGIN_ID: "herdr-github" };
  delete env.HERDR_ENV;
  delete env.HERDR_CONFIG_PATH;
  Object.assign(env, extra);
  try { return { code: 0, out: execFileSync("node", [SCRIPT, ...args], { env, encoding: "utf8" }) }; }
  catch (e) { return { code: e.status, out: e.stdout }; }
}
const haveHerdr = (() => { try { execFileSync(process.env.HERDR_BIN_PATH || "herdr", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

// A stand-in for herdr on HERDR_BIN_PATH, so the paths below run without herdr (CI has
// none). Its `config check` reads the file bind-key names in HERDR_CONFIG_PATH and
// fails when that file contains `rejects`, a fixed string; without one it passes.
// `--default-config` lists one default key, prefix+c. `calls()` lists each run as
// "<args> <HERDR_CONFIG_PATH>", so a test can tell the stub ran: bind-key treats a
// herdr it can't start as a passing check.
function stubHerdr(t, rejects = "") {
  const dir = tmpDir(t, "bind-key-herdr-");
  const bin = path.join(dir, "herdr");
  const log = path.join(dir, "calls.log");
  const check = rejects
    ? `if grep -qF '${rejects}' "$HERDR_CONFIG_PATH" 2>/dev/null; then printf 'config: issues found\\nstub: rejected\\n'; exit 1; fi`
    : ":";
  fs.writeFileSync(bin, `#!/bin/sh
printf '%s %s\\n' "$*" "$HERDR_CONFIG_PATH" >> '${log}'
case "$1" in
  --version) echo "herdr stub" ;;
  --default-config) echo '# new_tab = "prefix+c"' ;;
  config) ${check}; echo "config: ok" ;;
esac
`, { mode: 0o755 });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  return { bin, calls };
}
function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// A throwaway XDG_CONFIG_HOME, with `config` as herdr/config.toml when given.
function xdgWith(t, config) {
  const xdg = tmpDir(t, "bind-key-");
  const file = path.join(xdg, "herdr", "config.toml");
  if (config != null) { fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, config); }
  return { xdg, file };
}

test("binds prefix+i once, keeps a backup, and leaves the rest of the config alone", { skip: !haveHerdr && "herdr not installed" }, () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "bind-key-"));
  const file = path.join(xdg, "herdr", "config.toml");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, CONFIG);

  const first = run(xdg);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /on prefix\+i/);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.startsWith(CONFIG));
  assert.equal(b.boundKey(text, "herdr-github.toggle"), "prefix+i");
  assert.equal(fs.readFileSync(`${file}.bak-herdr-github`, "utf8"), CONFIG);

  const again = run(xdg);
  assert.match(again.out, /already on prefix\+i/);
  assert.equal(fs.readFileSync(file, "utf8"), text);
});

test("refuses a key that's taken", { skip: !haveHerdr && "herdr not installed" }, () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "bind-key-"));
  const file = path.join(xdg, "herdr", "config.toml");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, CONFIG);
  const r = run(xdg, "prefix+u");
  assert.equal(r.code, 1);
  assert.match(r.out, /prefix\+u is taken/);
  assert.equal(fs.readFileSync(file, "utf8"), CONFIG);
});

test("creates the config when there is none", { skip: !haveHerdr && "herdr not installed" }, () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "bind-key-"));
  const r = run(xdg);
  assert.equal(r.code, 0, r.out);
  assert.equal(b.boundKey(fs.readFileSync(path.join(xdg, "herdr", "config.toml"), "utf8"), "herdr-github.toggle"), "prefix+i");
});

test("writes to HERDR_CONFIG_PATH, with the backup beside it, when it is set", { skip: !haveHerdr && "herdr not installed" }, () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "bind-key-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-key-path-"));
  const file = path.join(dir, "my-herdr.toml");
  fs.writeFileSync(file, CONFIG);
  const r = runWith({ HERDR_CONFIG_PATH: file }, xdg);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(file), r.out);
  assert.equal(b.boundKey(fs.readFileSync(file, "utf8"), "herdr-github.toggle"), "prefix+i");
  assert.equal(fs.readFileSync(`${file}.bak-herdr-github`, "utf8"), CONFIG);
  assert.ok(!fs.existsSync(path.join(xdg, "herdr")), "the XDG config is left alone");
});

test("changes nothing when the config already fails herdr config check", { skip: !haveHerdr && "herdr not installed" }, () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "bind-key-"));
  const file = path.join(xdg, "herdr", "config.toml");
  fs.mkdirSync(path.dirname(file));
  const broken = "this is [ not toml\n";
  fs.writeFileSync(file, broken);
  const r = run(xdg);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /not bound: .* already has problems: config parse error: TOML parse error/);
  assert.equal(fs.readFileSync(file, "utf8"), broken);
  assert.ok(!fs.existsSync(`${file}.bak-herdr-github`), "no backup when nothing changed");
});

test("checks the XDG config it edits when HERDR_CONFIG_PATH is set but empty", { skip: !haveHerdr && "herdr not installed" }, () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "bind-key-"));
  const file = path.join(xdg, "herdr", "config.toml");
  fs.mkdirSync(path.dirname(file));
  const broken = "this is [ not toml\n";
  fs.writeFileSync(file, broken);
  const r = runWith({ HERDR_CONFIG_PATH: "" }, xdg);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /already has problems/);
  assert.equal(fs.readFileSync(file, "utf8"), broken);
});

test("skips keys a CRLF config already uses", { skip: !haveHerdr && "herdr not installed" }, () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "bind-key-"));
  const file = path.join(xdg, "herdr", "config.toml");
  fs.mkdirSync(path.dirname(file));
  const crlf = '[keys]\r\nnew_tab = "prefix+i"\r\n';
  fs.writeFileSync(file, crlf);
  const taken = run(xdg, "prefix+i");
  assert.equal(taken.code, 1, taken.out);
  assert.match(taken.out, /prefix\+i is taken/);
  assert.equal(fs.readFileSync(file, "utf8"), crlf);
  const r = run(xdg);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /on prefix\+i\b/);
});

test("block adds a binding boundKey and usedKeys read back", () => {
  const text = CONFIG + b.block("prefix+x", "herdr-github.toggle", "PR and issue panel");
  assert.equal(b.boundKey(text, "herdr-github.toggle"), "prefix+x");
  assert.equal(b.boundKey(text, "mcc-usage.toggle"), "prefix+u", "the other bindings still read the same");
  assert.ok(b.usedKeys(text).has("prefix+x"));
});

test("binds the key it's given (stub herdr)", (t) => {
  const { xdg, file } = xdgWith(t, CONFIG);
  const herdr = stubHerdr(t);
  const r = runWith({ HERDR_BIN_PATH: herdr.bin }, xdg, "prefix+x");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /on prefix\+x: added to /);
  assert.ok(r.out.includes(file), r.out);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.startsWith(CONFIG));
  assert.equal(b.boundKey(text, "herdr-github.toggle"), "prefix+x");
  assert.equal(fs.readFileSync(`${file}.bak-herdr-github`, "utf8"), CONFIG);
  // Checked before and after the edit, both times on the file it edits.
  assert.deepEqual(herdr.calls().filter((c) => c.startsWith("config check")), [`config check ${file}`, `config check ${file}`]);
});

test("refuses a key herdr's defaults use (stub herdr)", (t) => {
  const { xdg, file } = xdgWith(t);
  const r = runWith({ HERDR_BIN_PATH: stubHerdr(t).bin }, xdg, "prefix+c");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /prefix\+c is taken/);
  assert.ok(!fs.existsSync(file));
});

test("puts the config back when herdr config check rejects the binding (stub herdr)", (t) => {
  const { xdg, file } = xdgWith(t, CONFIG);
  const herdr = stubHerdr(t, "herdr-github.toggle");
  const r = runWith({ HERDR_BIN_PATH: herdr.bin }, xdg);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /not bound: Herdr rejected it: stub: rejected/);
  assert.equal(fs.readFileSync(file, "utf8"), CONFIG);
  assert.deepEqual(herdr.calls().filter((c) => c.startsWith("config check")), [`config check ${file}`, `config check ${file}`]);
});

test("removes the config it created when herdr config check rejects the binding (stub herdr)", (t) => {
  const { xdg, file } = xdgWith(t);
  const r = runWith({ HERDR_BIN_PATH: stubHerdr(t, "herdr-github.toggle").bin }, xdg, "prefix+x");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /not bound: Herdr rejected it: stub: rejected/);
  assert.ok(!fs.existsSync(file), "no config is left behind");
});

test("changes nothing when the config already fails herdr config check (stub herdr)", (t) => {
  const broken = "this is [ not toml\n";
  const { xdg, file } = xdgWith(t, broken);
  const r = runWith({ HERDR_BIN_PATH: stubHerdr(t, "not toml").bin }, xdg);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /not bound: .* already has problems: stub: rejected/);
  assert.equal(fs.readFileSync(file, "utf8"), broken);
  assert.ok(!fs.existsSync(`${file}.bak-herdr-github`), "no backup when nothing changed");
});
