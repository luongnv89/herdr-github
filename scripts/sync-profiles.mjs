#!/usr/bin/env node
// Writes profiles.cjs, the terminal panel's CommonJS copy of the app mod's
// mods/herdr-github/profiles.js: the same code without `export`, plus
// module.exports. With --check, writes nothing and exits 1 when the copy differs.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "mods/herdr-github/profiles.js", TARGET = "profiles.cjs";

function generate(source) {
  const names = [...source.matchAll(/^export (?:async )?(?:function\*? |const |let |class )(\w+)/gm)].map((m) => m[1]);
  if (!names.length) throw new Error(`${SOURCE} exports nothing`);
  const body = source.replace(/^export (?=(?:async )?(?:function|const|let|class) )/gm, "");
  if (/^export\b/m.test(body)) throw new Error(`${SOURCE} has an export this script can't convert`);
  return `// GENERATED from ${SOURCE} by scripts/sync-profiles.mjs. Do not edit: edit that\n` +
    `// file and run \`node scripts/sync-profiles.mjs\`.\n"use strict";\n\n${body.trimEnd()}\n\nmodule.exports = { ${names.join(", ")} };\n`;
}

const out = generate(readFileSync(join(root, SOURCE), "utf8"));
if (process.argv.includes("--check")) {
  let current = null;
  try { current = readFileSync(join(root, TARGET), "utf8"); } catch {}
  if (current !== out) {
    console.error(`${TARGET} is out of date with ${SOURCE}: run node scripts/sync-profiles.mjs`);
    process.exit(1);
  }
  console.log(`${TARGET} matches ${SOURCE}`);
} else {
  writeFileSync(join(root, TARGET), out);
  console.log(`wrote ${TARGET}`);
}
