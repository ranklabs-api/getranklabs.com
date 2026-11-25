// package.json is "type": "commonjs" but Pages Functions are ESM, and the
// instant-check modules import each other by relative path, so a data: URL
// (the stripe-webhook test's trick) can't load them. Instead, copy functions/
// into a temp dir whose package.json says "type": "module" and import from
// there. One copy per test process; removed on exit.

import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FUNCTIONS_DIR = fileURLToPath(new URL("../../../functions/", import.meta.url));

let root = null;

function ensureCopy() {
  if (root) return root;
  root = mkdtempSync(join(tmpdir(), "instant-check-test-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  cpSync(FUNCTIONS_DIR, join(root, "functions"), { recursive: true });
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  return root;
}

// load("api/_shared/instant-check/budget.js") → the module namespace.
export function load(relativePath) {
  return import(pathToFileURL(join(ensureCopy(), "functions", relativePath)).href);
}

export function loadInstantCheck(name) {
  return load(`api/_shared/instant-check/${name}`);
}
