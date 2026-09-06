/**
 * Google Drive VFS Toolkit adapter tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { GoogleDriveNamespaceError } from "../src/google/drive-namespace.mjs";
import { GoogleDriveRequestError } from "../src/google/drive-transport.mjs";
import { GoogleOAuthError } from "../src/google/oauth-client.mjs";
import {
  GoogleDriveVfsProvider,
  READ_ONLY_CAPABILITIES,
  mapVfsProviderError
} from "../src/provider/google-drive-vfs-provider.mjs";

const ROOT_LABELS = Object.freeze({
  myDrive: "My Drive",
  sharedWithMe: "Shared with me",
  sharedDrives: "Shared drives"
});

const EXPORT_FORMATS = Object.freeze({
  document: "docx",
  spreadsheet: "xlsx",
  presentation: "pptx",
  drawing: "pdf"
});

function getMessage(key) {
  return `translated:${key}`;
}

function createProvider({
  binding = { storageId: "storage-1", accountId: "account-1" },
  account = { id: "account-1", status: "connected" },
  namespace,
  readiness = Promise.resolve(),
  logger
} = {}) {
  const namespaceCalls = [];
  const apiCalls = [];
  const activeNamespace = namespace || {
    async getStorageUsage() {
      namespaceCalls.push({ method: "getStorageUsage" });
      return { usage: 10, quota: 100 };
    },
    async list(path, options) {
      namespaceCalls.push({ method: "list", path, options });
      return [{ name: "file.txt", path: `${path}/file.txt`, kind: "file" }];
    },
    async readFile(path, options) {
      namespaceCalls.push({ method: "readFile", path, options });
      return { name: "file.txt" };
    }
  };
  const provider = new GoogleDriveVfsProvider({
    name: "Google Drive",
    readiness,
    accountRepository: {
      async getConnectionBinding(storageId) {
        return storageId === binding?.storageId ? binding : null;
      },
      async getAccount(accountId) {
        return accountId === account?.id ? account : null;
      }
    },
    preferencesRepository: {
      async get() {
        return { exportFormats: EXPORT_FORMATS };
      }
    },
    transport: {
      async request(...args) {
        apiCalls.push(args);
      }
    },
    rootLabels: ROOT_LABELS,
    getMessage,
    logger,
    apiClientFactory(options) {
      apiCalls.push(options);
      return { accountId: options.accountId };
    },
    namespaceFactory(options) {
      namespaceCalls.push({ method: "create", options });
      return activeNamespace;
    }
  });
  return { apiCalls, namespaceCalls, provider };
}

test("advertises only implemented read operations", () => {
  assert.deepEqual(READ_ONLY_CAPABILITIES, {
    file: { read: true, add: false, modify: false, delete: false },
    folder: { read: true, add: false, modify: false, delete: false }
  });
  assert.equal(Object.isFrozen(READ_ONLY_CAPABILITIES.file), true);
  assert.equal(Object.isFrozen(READ_ONLY_CAPABILITIES.folder), true);
});

test("binds list, read, and quota requests to the selected Google account", async () => {
  const { apiCalls, namespaceCalls, provider } = createProvider();

  assert.deepEqual(await provider.onStorageUsage("storage-1"), {
    usage: 10,
    quota: 100
  });
  assert.equal((await provider.onList("request-1", "storage-1", "/"))[0].name, "file.txt");
  assert.equal((await provider.onReadFile(
    "request-2",
    "storage-1",
    "/file.txt"
  )).name, "file.txt");

  assert.equal(apiCalls.every((call) => call.accountId === "account-1"), true);
  const creations = namespaceCalls.filter((call) => call.method === "create");
  assert.equal(creations.length, 3);
  assert.deepEqual(creations[0].options.exportFormats, EXPORT_FORMATS);
  assert.deepEqual(creations[0].options.rootLabels, ROOT_LABELS);
  const listCall = namespaceCalls.find((call) => call.method === "list");
  const readCall = namespaceCalls.find((call) => call.method === "readFile");
  assert.equal(listCall.options.signal instanceof AbortSignal, true);
  assert.equal(readCall.options.signal instanceof AbortSignal, true);
});

test("rejects storage IDs that have no account binding", async () => {
  const { provider } = createProvider({ binding: null });

  await assert.rejects(
    provider.onList("request-1", "unknown", "/"),
    (error) => error.code === "E:AUTH" && !error.details
  );
});

test("rejects malformed storage IDs as unauthorized", async () => {
  const { provider } = createProvider();

  for (const storageId of [undefined, null, "", " ", " storage-1", 42]) {
    await assert.rejects(
      provider.onStorageUsage(storageId),
      (error) => error.code === "E:AUTH" && !error.details
    );
  }
});

test("requires the bound account to be signed in", async () => {
  const { provider } = createProvider({
    account: { id: "account-1", status: "reauthorization_required" }
  });

  await assert.rejects(
    provider.onStorageUsage("storage-1"),
    (error) => error.code === "E:PROVIDER" &&
      error.details.id === "google-drive-authentication"
  );
});

test("cancels the active Drive request by its Toolkit request ID", async () => {
  let operationSignal;
  const namespace = {
    async list(_path, { signal }) {
      operationSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true
        });
      });
    },
    async readFile() {},
    async getStorageUsage() {}
  };
  const { provider } = createProvider({ namespace });

  const operation = provider.onList("request-1", "storage-1", "/");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await provider.onCancel("request-1");

  await assert.rejects(operation, (error) => error.name === "AbortError");
  assert.equal(operationSignal.aborted, true);
});

test("maps user-actionable Drive failures to localized provider details", () => {
  const cases = [
    [
      new GoogleOAuthError("oauth_reauthorization_required", 401),
      "google-drive-authentication",
      "vfsErrorAuthenticationTitle"
    ],
    [
      new GoogleDriveRequestError("drive_network_error"),
      "google-drive-network",
      "vfsErrorNetworkTitle"
    ],
    [
      new GoogleDriveRequestError("drive_retry_deferred", {
        status: 429,
        retryable: true
      }),
      "google-drive-rate-limit",
      "vfsErrorRateLimitTitle"
    ],
    [
      new GoogleDriveNamespaceError("drive_download_forbidden"),
      "google-drive-access",
      "vfsErrorAccessTitle"
    ],
    [
      new GoogleDriveNamespaceError("drive_path_not_found"),
      "google-drive-unavailable",
      "vfsErrorUnavailableTitle"
    ]
  ];

  for (const [source, id, titleKey] of cases) {
    const mapped = mapVfsProviderError(source, getMessage);
    assert.equal(mapped.code, "E:PROVIDER");
    assert.equal(mapped.details.id, id);
    assert.equal(mapped.details.title, `translated:${titleKey}`);
    assert.equal(mapped.cause, source);
  }
});

test("logs operation phases without storage IDs or paths", async () => {
  const events = [];
  const logger = {
    debug(event, details) {
      events.push({ level: "debug", event, details });
    },
    warn(event, details) {
      events.push({ level: "warn", event, details });
    }
  };
  const { provider } = createProvider({ logger });

  await provider.onList("request-1", "storage-1", "/private/path");

  assert.deepEqual(events, [
    {
      level: "debug",
      event: "vfs.operation.start",
      details: { operation: "list" }
    },
    {
      level: "debug",
      event: "vfs.operation.complete",
      details: { operation: "list" }
    }
  ]);
});
