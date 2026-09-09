"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = path.join(ROOT, "src");
const EXPECTED_LOCALES = [
  "cs",
  "de",
  "en",
  "es",
  "fr",
  "hu",
  "it",
  "ja",
  "nl",
  "pl",
  "pt_BR",
  "pt_PT",
  "ru",
  "zh_CN",
  "zh_TW"
];
const EXPECTED_VENDOR_HASHES = new Map([
  ["vendor/i18n/i18n.mjs", "efc9e290349356d47283414d35951df829bcc4135e472be239faab2e9a7582ea"],
  ["vendor/vfs-toolkit/vfs-provider.mjs", "cdf9bed9683af96505c2aae8f3798cc3bd0d835388a8c9f908b17bf67596329d"]
]);
const EXPECTED_DOCUMENTATION_ASSET_HASHES = new Map([
  ["docs/assets/google-drive-logo.png", "39e2c15449e7fa75ebe3a29f3f99e2e9ee11b5ef36aebf4dda3d30e484635495"]
]);
const SKIP_FOLDERS = new Set([
  ".git",
  ".lib-cdn-lookup-cache",
  ".lib-mozilla-hash-db-cache",
  ".schema-cache",
  ".tmp",
  "dist",
  "node_modules"
]);
const TEXT_FILE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".svg",
  ".txt"
]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readPngSize(filePath) {
  const buffer = fs.readFileSync(filePath);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert(buffer.length >= 24 && buffer.subarray(0, 8).equals(signature), `Invalid PNG file: ${path.relative(ROOT, filePath)}`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function listProjectFiles(directory = ROOT) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_FOLDERS.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...listProjectFiles(entryPath));
    } else if (entry.isFile()) {
      result.push(entryPath);
    }
  }
  return result;
}

function checkManifest() {
  const manifest = readJson(path.join(SOURCE_DIR, "manifest.json"));
  const packageJson = readJson(path.join(ROOT, "package.json"));
  assert(manifest.manifest_version === 3, "The extension must use Manifest V3");
  assert(!Object.hasOwn(manifest, "applications"), "Use browser_specific_settings instead of applications");
  assert(manifest.browser_specific_settings?.gecko?.id === "{90c66d9f-a142-43a8-8ffb-707a48d8eb7a}", "Unexpected extension ID");
  assert(manifest.browser_specific_settings?.gecko?.strict_min_version === "140.0", "Unexpected minimum Thunderbird version");
  assert(manifest.background?.type === "module", "The background must be an ES module");
  assert(JSON.stringify(manifest.background?.scripts) === JSON.stringify(["background.js"]), "Unexpected background entry point");
  assert(manifest.icons?.["16"] === "assets/icon-16.png", "The 16 px extension icon is missing");
  assert(manifest.icons?.["32"] === "assets/icon-32.png", "The 32 px extension icon is missing");
  assert(manifest.icons?.["64"] === "assets/icon-64.png", "The 64 px extension icon is missing");
  assert(manifest.icons?.["128"] === "assets/icon-128.png", "The 128 px extension icon is missing");
  assert(manifest.default_locale === "de", "German must remain the default locale");
  assert(manifest.version === packageJson.version, "Package and manifest versions differ");
  assert(!manifest.experiment_apis, "The provider must not include an Experiment API");
  assert(JSON.stringify(manifest.permissions) === JSON.stringify(["alarms", "identity", "storage"]), "Unexpected extension permissions");
  assert(JSON.stringify(manifest.host_permissions) === JSON.stringify([
    "https://oauth2.googleapis.com/*",
    "https://www.googleapis.com/*"
  ]), "Unexpected extension host permissions");
}

function checkOAuthConfiguration() {
  const oauthSource = fs.readFileSync(
    path.join(SOURCE_DIR, "google", "oauth-client.mjs"),
    "utf8"
  );
  const clientIdMarker = "__GDRVFS_OAUTH_CLIENT_ID__";
  const clientSecretMarker = "__GDRVFS_OAUTH_CLIENT_SECRET__";
  assert(
    oauthSource.split(clientIdMarker).length === 2,
    "The OAuth client ID build marker must occur exactly once"
  );
  assert(
    oauthSource.split(clientSecretMarker).length === 2,
    "The OAuth client secret build marker must occur exactly once"
  );
  assert(
    !/[A-Za-z0-9._-]+\.apps\.googleusercontent\.com/u.test(oauthSource),
    "The OAuth source must not contain a real Google client ID"
  );
  assert(
    !/GOCSPX-[A-Za-z0-9_-]+/u.test(oauthSource),
    "The OAuth source must not contain a Google client secret"
  );
  assert(
    oauthSource.includes("client_secret: clientSecret"),
    "OAuth token requests must include the packaged client secret"
  );
}

function checkLocales() {
  const localeRoot = path.join(SOURCE_DIR, "_locales");
  const locales = fs.readdirSync(localeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert(JSON.stringify(locales) === JSON.stringify([...EXPECTED_LOCALES].sort()), "Locale folder set differs from Translations.md");

  const english = readJson(path.join(localeRoot, "en", "messages.json"));
  const expectedKeys = Object.keys(english).sort();
  for (const locale of locales) {
    const messages = readJson(path.join(localeRoot, locale, "messages.json"));
    assert(JSON.stringify(Object.keys(messages).sort()) === JSON.stringify(expectedKeys), `${locale} locale keys differ from English`);
    for (const key of expectedKeys) {
      const message = String(messages[key]?.message || "").trim();
      assert(message, `${locale}.${key} is empty`);
      assert(!/(TODO|TBD|TRANSLATE_ME|FIXME)/i.test(message), `${locale}.${key} contains a work marker`);
      if (locale !== "en" &&
          key !== "extensionName" &&
          key !== "vfsProviderName" &&
          key !== "optionsTitle") {
        assert(message !== english[key].message, `${locale}.${key} is still English`);
      }
    }
  }
}

function checkVendor() {
  const vendorNotes = fs.readFileSync(path.join(ROOT, "VENDOR.md"), "utf8").toLowerCase();
  const thirdPartyNotes = fs.readFileSync(
    path.join(ROOT, "THIRD_PARTY_NOTICES.md"),
    "utf8"
  ).toLowerCase();
  for (const [relativePath, expectedHash] of EXPECTED_VENDOR_HASHES) {
    const filePath = path.join(SOURCE_DIR, relativePath);
    const hash = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    assert(hash === expectedHash, `Vendored file changed: ${relativePath}`);
    assert(vendorNotes.includes(expectedHash), `VENDOR.md is missing the hash for ${relativePath}`);
    assert(thirdPartyNotes.includes(expectedHash), `THIRD_PARTY_NOTICES.md is missing the hash for ${relativePath}`);
  }
  assert(vendorNotes.includes("a82f2b767f4183f582ed33e81cd35a1c45639430"), "VENDOR.md is missing the VFS provider revision");
  assert(vendorNotes.includes("3476faa0870bb6dbe63c7c72fc3dab2b67731f4e"), "VENDOR.md is missing the i18n revision");
  assert(thirdPartyNotes.includes("a82f2b767f4183f582ed33e81cd35a1c45639430"), "THIRD_PARTY_NOTICES.md is missing the VFS provider revision");
  assert(thirdPartyNotes.includes("3476faa0870bb6dbe63c7c72fc3dab2b67731f4e"), "THIRD_PARTY_NOTICES.md is missing the i18n revision");
}

function checkAssets() {
  const thirdPartyNotes = fs.readFileSync(
    path.join(ROOT, "THIRD_PARTY_NOTICES.md"),
    "utf8"
  ).toLowerCase();
  for (const [relativePath, expectedHash] of EXPECTED_DOCUMENTATION_ASSET_HASHES) {
    const filePath = path.join(ROOT, relativePath);
    const hash = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    assert(hash === expectedHash, `Documentation asset changed: ${relativePath}`);
    assert(thirdPartyNotes.includes(expectedHash), `THIRD_PARTY_NOTICES.md is missing the hash for ${relativePath}`);
  }

  for (const size of [16, 32, 64, 128]) {
    const relativePath = `src/assets/icon-${size}.png`;
    const dimensions = readPngSize(path.join(ROOT, relativePath));
    assert(dimensions.width === size && dimensions.height === size, `Unexpected icon dimensions: ${relativePath}`);
  }
}

function checkFiles() {
  const required = [
    "CHANGELOG.md",
    "PRIVACY.md",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "Translations.md",
    "VENDOR.md",
    "docs/ADMIN.md",
    "docs/DEVELOPMENT.md",
    "docs/assets/google-drive-logo.png",
    "src/assets/icon-16.png",
    "src/assets/icon-32.png",
    "src/assets/icon-64.png",
    "src/assets/icon-128.png",
    "src/background.js",
    "src/connection/config.html",
    "src/connection/connection-controller.mjs",
    "src/connection/page.js",
    "src/connection/setup.html",
    "src/connection/styles.css",
    "src/options/options.html",
    "src/options/options.js"
  ];
  for (const relativePath of required) {
    assert(fs.existsSync(path.join(ROOT, relativePath)), `Required file is missing: ${relativePath}`);
  }

  for (const filePath of listProjectFiles()) {
    const buffer = fs.readFileSync(filePath);
    if (TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      assert(!(buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf), `UTF-8 BOM found: ${path.relative(ROOT, filePath)}`);
      const text = buffer.toString("utf8");
      assert(!text.includes("\r"), `CRLF found: ${path.relative(ROOT, filePath)}`);
      if (/\.(?:css|html|js|mjs)$/.test(filePath)) {
        assert(!text.includes("\t"), `Tab indentation found: ${path.relative(ROOT, filePath)}`);
      }
    }
  }

  const sourceText = listProjectFiles(SOURCE_DIR)
    .filter((filePath) => /\.(?:html|js|mjs)$/.test(filePath))
    .map((filePath) => fs.readFileSync(filePath, "utf8"))
    .join("\n");
  assert(!/<script[^>]+src=["']https?:/i.test(sourceText), "Remote script reference found");
  assert(!/\beval\s*\(|\bnew\s+Function\s*\(/.test(sourceText), "Dynamic code execution found");

  const reusableModules = listProjectFiles(SOURCE_DIR)
    .filter((filePath) => filePath.endsWith(".mjs"));
  for (const filePath of reusableModules) {
    const text = fs.readFileSync(filePath, "utf8");
    assert(!/\brequire\s*\(|\bmodule\.exports\b/.test(text), `CommonJS found in ESM module: ${path.relative(ROOT, filePath)}`);
  }

  const nodeTools = listProjectFiles(path.join(ROOT, "tools"))
    .filter((filePath) => filePath.endsWith(".js"));
  for (const filePath of nodeTools) {
    const text = fs.readFileSync(filePath, "utf8");
    assert(!/^\s*(?:import|export)\s/m.test(text), `ESM syntax found in CommonJS tool: ${path.relative(ROOT, filePath)}`);
  }
}

function run() {
  checkManifest();
  checkOAuthConfiguration();
  checkLocales();
  checkVendor();
  checkAssets();
  checkFiles();
  console.log("[OK] review-check passed");
}

run();
