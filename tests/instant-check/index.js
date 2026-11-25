// Entry point for `node --test tests/instant-check/`.
//
// Node 22 resolves a directory argument to --test as a module (this file), not
// as a glob, so this imports every *.test.mjs beside it. Each test file also
// runs on its own: node --test tests/instant-check/budget.test.mjs

const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  const files = readdirSync(__dirname).filter((f) => f.endsWith(".test.mjs")).sort();
  for (const file of files) await import(pathToFileURL(join(__dirname, file)).href);
})().catch((error) => {
  process.exitCode = 1;
  throw error;
});
