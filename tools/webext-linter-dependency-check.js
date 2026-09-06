"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const LINTER_PACKAGE = path.join(
  ROOT,
  "node_modules",
  "@thunderbirdops",
  "webext-linter",
  "package.json"
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readVersion(requireFromLinter, packageName) {
  const packagePath = requireFromLinter.resolve(`${packageName}/package.json`);
  return JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
}

assert(fs.existsSync(LINTER_PACKAGE), "Current Thunderbird webext-linter is not installed");
const requireFromLinter = createRequire(LINTER_PACKAGE);
const admZip = readVersion(requireFromLinter, "adm-zip");
const fastUri = readVersion(requireFromLinter, "fast-uri");
const obfuscationDetector = readVersion(requireFromLinter, "obfuscation-detector");

assert(admZip === "0.6.0", `Unexpected adm-zip version: ${admZip}`);
assert(fastUri === "3.1.4", `Unexpected fast-uri version: ${fastUri}`);
assert(obfuscationDetector === "3.0.1", `Unexpected obfuscation-detector version: ${obfuscationDetector}`);
console.log(`[OK] webext-linter dependencies: adm-zip ${admZip}, fast-uri ${fastUri}, obfuscation-detector ${obfuscationDetector}`);
