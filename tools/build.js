"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = path.join(ROOT, "src");
const PACKAGE_FILES = [
  "LICENSE",
  "README.md",
  "Translations.md",
  "VENDOR.md",
  "docs/ADMIN.md",
  "docs/DEVELOPMENT.md"
];

const crcTable = new Uint32Array(256);
for (let value = 0; value < crcTable.length; value++) {
  let current = value;
  for (let bit = 0; bit < 8; bit++) {
    current = current & 1
      ? 0xedb88320 ^ (current >>> 1)
      : current >>> 1;
  }
  crcTable[value] = current >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function collectDirectory(directory, archivePrefix = "") {
  const entries = [];
  const names = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));

  for (const entry of names) {
    const sourcePath = path.join(directory, entry.name);
    const archivePath = [archivePrefix, entry.name].filter(Boolean).join("/");
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not packaged: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      entries.push(...collectDirectory(sourcePath, archivePath));
    } else if (entry.isFile()) {
      entries.push({ sourcePath, archivePath });
    }
  }
  return entries;
}

function collectPackageEntries() {
  const entries = collectDirectory(SOURCE_DIR);
  for (const relativePath of PACKAGE_FILES) {
    const sourcePath = path.join(ROOT, relativePath);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Required package file is missing: ${relativePath}`);
    }
    entries.push({
      sourcePath,
      archivePath: relativePath.replaceAll("\\", "/")
    });
  }
  return entries.sort((left, right) => left.archivePath.localeCompare(right.archivePath, "en"));
}

function createZip(entries, outputPath) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const data = fs.readFileSync(entry.sourcePath);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(data);
    const name = Buffer.from(entry.archivePath, "utf8");
    const flags = 0x0800;
    const dosDate = 33;

    const localHeader = Buffer.alloc(30 + name.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    name.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + name.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    name.copy(centralHeader, 46);

    localParts.push(localHeader, payload);
    centralParts.push(centralHeader);
    offset += localHeader.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.rmSync(outputPath, { force: true });
  fs.writeFileSync(outputPath, Buffer.concat([...localParts, centralDirectory, endRecord]));
}

function resolveOutputPath(version) {
  const defaultName = `vfs-provider-googledrive_${version.replaceAll(".", "_")}.xpi`;
  const requested = process.argv[2] || path.join("dist", defaultName);
  const outputPath = path.resolve(ROOT, requested);
  const relative = path.relative(ROOT, outputPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The build output must stay inside the project folder");
  }
  return outputPath;
}

function run() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, "manifest.json"), "utf8"));
  if (packageJson.version !== manifest.version) {
    throw new Error("package.json and src/manifest.json versions differ");
  }

  const outputPath = resolveOutputPath(packageJson.version);
  const entries = collectPackageEntries();
  createZip(entries, outputPath);
  console.log(`[build] Created ${path.relative(ROOT, outputPath)} with ${entries.length} files`);
}

run();
