"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = path.join(ROOT, "src");
const OAUTH_SOURCE_PATH = "google/oauth-client.mjs";
const OAUTH_CLIENT_ID_MARKER = "__GDRVFS_OAUTH_CLIENT_ID__";
const OAUTH_CLIENT_SECRET_MARKER = "__GDRVFS_OAUTH_CLIENT_SECRET__";
const OAUTH_CREDENTIALS_ENV = "GDRVFS_OAUTH_CREDENTIALS_FILE";
const TEST_OAUTH_CREDENTIALS = Object.freeze({
  clientId: "test-build-client.apps.googleusercontent.com",
  clientSecret: "test-build-client-secret"
});
const PACKAGE_FILES = [
  "CHANGELOG.md",
  "LICENSE",
  "PRIVACY.md",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "Translations.md",
  "VENDOR.md",
  "docs/ADMIN.md",
  "docs/DEVELOPMENT.md",
  "docs/assets/google-drive-logo.png"
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

function parseArguments() {
  const argumentsList = process.argv.slice(2);
  const useTestCredentials = argumentsList.includes("--test-credentials");
  const positional = argumentsList.filter((argument) => argument !== "--test-credentials");
  if (positional.length > 1) {
    throw new Error("Usage: node tools/build.js [output] [--test-credentials]");
  }
  return {
    requestedOutput: positional[0],
    useTestCredentials
  };
}

function requireCredential(value, name) {
  const credential = typeof value === "string" ? value.trim() : "";
  if (!credential || /[\u0000-\u001f\u007f]/u.test(credential)) {
    throw new Error(`The OAuth credential file has an invalid ${name}`);
  }
  return credential;
}

function loadOAuthCredentials(useTestCredentials) {
  if (useTestCredentials) {
    return TEST_OAUTH_CREDENTIALS;
  }

  const configuredPath = process.env[OAUTH_CREDENTIALS_ENV];
  if (!configuredPath) {
    throw new Error(
      `${OAUTH_CREDENTIALS_ENV} must point to the external Google Desktop credential JSON`
    );
  }
  const credentialPath = path.resolve(configuredPath);
  const relativePath = path.relative(ROOT, credentialPath);
  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    throw new Error("The Google OAuth credential file must stay outside the project folder");
  }

  let document;
  try {
    document = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
  } catch {
    throw new Error("The external Google OAuth credential file cannot be read");
  }
  if (!document?.installed || document.web) {
    throw new Error("The Google OAuth credential file must describe a Desktop app client");
  }
  const clientId = requireCredential(document.installed.client_id, "client ID");
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u.test(clientId)) {
    throw new Error("The Google OAuth credential file has an invalid client ID");
  }
  return {
    clientId,
    clientSecret: requireCredential(
      document.installed.client_secret,
      "client secret"
    )
  };
}

function replaceCredentialMarker(source, marker, value) {
  const quotedMarker = JSON.stringify(marker);
  const firstIndex = source.indexOf(quotedMarker);
  if (firstIndex < 0 || source.indexOf(quotedMarker, firstIndex + 1) >= 0) {
    throw new Error(`OAuth build marker must occur exactly once: ${marker}`);
  }
  return source.replace(quotedMarker, JSON.stringify(value));
}

function injectOAuthCredentials(entries, credentials) {
  return entries.map((entry) => {
    if (entry.archivePath !== OAUTH_SOURCE_PATH) {
      return entry;
    }
    let source = fs.readFileSync(entry.sourcePath, "utf8");
    source = replaceCredentialMarker(
      source,
      OAUTH_CLIENT_ID_MARKER,
      credentials.clientId
    );
    source = replaceCredentialMarker(
      source,
      OAUTH_CLIENT_SECRET_MARKER,
      credentials.clientSecret
    );
    if (source.includes(OAUTH_CLIENT_ID_MARKER) ||
        source.includes(OAUTH_CLIENT_SECRET_MARKER)) {
      throw new Error("OAuth build markers remain in the packaged source");
    }
    return {
      ...entry,
      data: Buffer.from(source, "utf8")
    };
  });
}

function createZip(entries, outputPath) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const data = entry.data || fs.readFileSync(entry.sourcePath);
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

function resolveOutputPath(version, requestedOutput, useTestCredentials) {
  const defaultName = `vfs-provider-googledrive_${version.replaceAll(".", "_")}.xpi`;
  const requested = requestedOutput || path.join("dist", defaultName);
  const outputPath = path.resolve(ROOT, requested);
  const relative = path.relative(ROOT, outputPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The build output must stay inside the project folder");
  }
  if (useTestCredentials && relative.split(path.sep)[0] !== ".tmp") {
    throw new Error("A test-credential build must be written below .tmp");
  }
  return outputPath;
}

function run() {
  const { requestedOutput, useTestCredentials } = parseArguments();
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, "manifest.json"), "utf8"));
  if (packageJson.version !== manifest.version) {
    throw new Error("package.json and src/manifest.json versions differ");
  }

  const outputPath = resolveOutputPath(
    packageJson.version,
    requestedOutput,
    useTestCredentials
  );
  const credentials = loadOAuthCredentials(useTestCredentials);
  const entries = injectOAuthCredentials(
    collectPackageEntries(),
    credentials
  );
  createZip(entries, outputPath);
  console.log(`[build] Created ${path.relative(ROOT, outputPath)} with ${entries.length} files`);
}

run();
