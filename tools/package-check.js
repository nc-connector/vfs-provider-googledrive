"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ROOT_PACKAGE_FILES = [
  "CHANGELOG.md",
  "LICENSE",
  "PRIVACY.md",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "Translations.md",
  "VENDOR.md",
  "docs/ADMIN.md",
  "docs/DEVELOPMENT.md",
  "docs/RELEASE.md",
  "docs/TESTING.md"
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function listFiles(directory, prefix = "") {
  const result = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = [prefix, entry.name].filter(Boolean).join("/");
    if (entry.isDirectory()) {
      result.push(...listFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      result.push(relativePath);
    }
  }
  return result.sort();
}

function readCentralDirectoryNames(buffer) {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = buffer.lastIndexOf(signature);
  assert(endOffset >= 0, "ZIP end record is missing");

  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  const names = [];
  for (let index = 0; index < entryCount; index++) {
    assert(buffer.readUInt32LE(offset) === 0x02014b50, "ZIP central directory is invalid");
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names.sort();
}

function run() {
  const requestedPath = process.argv[2];
  assert(requestedPath, "Usage: node tools/package-check.js <xpi> [--remove]");
  const packagePath = path.resolve(ROOT, requestedPath);
  assert(fs.existsSync(packagePath), `Package not found: ${requestedPath}`);

  const expected = [
    ...listFiles(path.join(ROOT, "src")),
    ...ROOT_PACKAGE_FILES
  ].sort();
  const actual = readCentralDirectoryNames(fs.readFileSync(packagePath));
  assert(JSON.stringify(actual) === JSON.stringify(expected), "XPI file list differs from the source payload");
  assert(actual.includes("manifest.json"), "XPI manifest is missing");
  assert(!actual.some((name) => /(^|\/)(node_modules|dist|\.git|\.tmp)(\/|$)/.test(name)), "XPI contains a development directory");
  assert(!actual.some((name) => /todo/i.test(path.basename(name))), "XPI contains a work plan");

  console.log(`[OK] package-check passed (${actual.length} files)`);
  if (process.argv.includes("--remove")) {
    fs.rmSync(packagePath, { force: true });
    const parent = path.dirname(packagePath);
    if (parent !== ROOT && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
    }
  }
}

run();
