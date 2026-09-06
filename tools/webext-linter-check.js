"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const VERIFY_SCRIPT = path.join(
  ROOT,
  "node_modules",
  "@thunderbirdops",
  "webext-linter",
  "verify.js"
);

if (!fs.existsSync(VERIFY_SCRIPT)) {
  console.error("[webext-linter] Current main package is missing. Run npm run webext-linter:update first.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [
  VERIFY_SCRIPT,
  path.join(ROOT, "src"),
  "--report-format",
  "text"
], {
  cwd: ROOT,
  stdio: "inherit"
});

if (result.error) {
  console.error(`[webext-linter] Could not start the verifier: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
