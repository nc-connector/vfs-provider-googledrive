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
  GOOGLE_DRIVE_CAPABILITIES,
  GoogleDriveVfsProvider,
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
  logger,
  supportedCapabilities = new Set([
    "file.add",
    "file.delete",
    "file.read",
    "folder.add",
    "folder.delete",
    "folder.read"
  ])
} = {}) {
  const namespaceCalls = [];
  const apiCalls = [];
  const authorizationCalls = [];
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
    },
    async writeFile(path, file, options) {
      namespaceCalls.push({ method: "writeFile", path, file, options });
    },
    async addFolder(path, options) {
      namespaceCalls.push({ method: "addFolder", path, options });
    },
    async deleteFile(path, options) {
      namespaceCalls.push({ method: "deleteFile", path, options });
    },
    async deleteFolder(path, options) {
      namespaceCalls.push({ method: "deleteFolder", path, options });
    }
  };
  const provider = new GoogleDriveVfsProvider({
    name: "Google Drive",
    readiness,
    connectionService: {
      async getAuthorizedBinding(storageId, capability) {
        authorizationCalls.push({ storageId, capability });
        if (typeof storageId !== "string" ||
            storageId !== binding?.storageId ||
            (capability && !supportedCapabilities.has(capability))) {
          throw Object.assign(new Error("Unauthorized storage connection"), {
            code: "E:AUTH"
          });
        }
        return binding;
      }
    },
    accountRepository: {
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
  return { apiCalls, authorizationCalls, namespaceCalls, provider };
}

test("advertises only implemented VFS operations", () => {
  assert.deepEqual(GOOGLE_DRIVE_CAPABILITIES, {
    file: { read: true, add: true, modify: false, delete: true },
    folder: { read: true, add: true, modify: false, delete: true }
  });
  assert.equal(Object.isFrozen(GOOGLE_DRIVE_CAPABILITIES.file), true);
  assert.equal(Object.isFrozen(GOOGLE_DRIVE_CAPABILITIES.folder), true);
});

test("binds list, read, and quota requests to the selected Google account", async () => {
  const {
    apiCalls,
    authorizationCalls,
    namespaceCalls,
    provider
  } = createProvider();

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
  assert.deepEqual(authorizationCalls, [
    { storageId: "storage-1", capability: null },
    { storageId: "storage-1", capability: "folder.read" },
    { storageId: "storage-1", capability: "file.read" }
  ]);
  const creations = namespaceCalls.filter((call) => call.method === "create");
  assert.equal(creations.length, 3);
  assert.deepEqual(creations[0].options.exportFormats, EXPORT_FORMATS);
  assert.deepEqual(creations[0].options.rootLabels, ROOT_LABELS);
  const listCall = namespaceCalls.find((call) => call.method === "list");
  const readCall = namespaceCalls.find((call) => call.method === "readFile");
  assert.equal(listCall.options.signal instanceof AbortSignal, true);
  assert.equal(readCall.options.signal instanceof AbortSignal, true);
});

test("creates files through file.add and forwards upload progress", async () => {
  let writeCall;
  const progressCalls = [];
  const file = new Blob(["content"], { type: "text/plain" });
  const namespace = {
    async writeFile(path, writtenFile, options) {
      writeCall = { path, file: writtenFile, options };
      options.onProgress(45);
    }
  };
  const { authorizationCalls, provider } = createProvider({ namespace });
  provider.reportProgress = (...args) => progressCalls.push(args);

  await provider.onWriteFile(
    "request-write",
    "storage-1",
    "/My Drive/file.txt",
    file,
    false
  );

  assert.deepEqual(authorizationCalls, [
    { storageId: "storage-1", capability: "file.add" }
  ]);
  assert.equal(writeCall.path, "/My Drive/file.txt");
  assert.equal(writeCall.file, file);
  assert.equal(writeCall.options.overwrite, false);
  assert.equal(writeCall.options.signal instanceof AbortSignal, true);
  assert.deepEqual(progressCalls, [["request-write", 45]]);
});

test("does not expose file replacement through writeFile", async () => {
  let namespaceCalled = false;
  const namespace = {
    async writeFile() {
      namespaceCalled = true;
    }
  };
  const { authorizationCalls, provider } = createProvider({ namespace });

  await assert.rejects(
    provider.onWriteFile(
      "request-overwrite",
      "storage-1",
      "/My Drive/file.txt",
      new Blob(["replacement"]),
      true
    ),
    (error) => error.code === "E:AUTH" && !error.details
  );

  assert.deepEqual(authorizationCalls, [
    { storageId: "storage-1", capability: "file.modify" }
  ]);
  assert.equal(namespaceCalled, false);
});

test("creates folders through folder.add and forwards progress", async () => {
  let addFolderCall;
  const progressCalls = [];
  const namespace = {
    async addFolder(path, options) {
      addFolderCall = { path, options };
      options.onProgress(100);
    }
  };
  const { authorizationCalls, provider } = createProvider({ namespace });
  provider.reportProgress = (...args) => progressCalls.push(args);

  await provider.onAddFolder(
    "request-folder",
    "storage-1",
    "/My Drive/Folder"
  );

  assert.deepEqual(authorizationCalls, [
    { storageId: "storage-1", capability: "folder.add" }
  ]);
  assert.equal(addFolderCall.path, "/My Drive/Folder");
  assert.equal(addFolderCall.options.signal instanceof AbortSignal, true);
  assert.deepEqual(progressCalls, [["request-folder", 100]]);
});

test("moves VFS file and folder deletions to trash", async () => {
  const deleteCalls = [];
  const progressCalls = [];
  const namespace = {
    async deleteFile(path, options) {
      deleteCalls.push({ method: "deleteFile", path, options });
      options.onProgress(50);
    },
    async deleteFolder(path, options) {
      deleteCalls.push({ method: "deleteFolder", path, options });
      options.onProgress(100);
    }
  };
  const { authorizationCalls, provider } = createProvider({ namespace });
  provider.reportProgress = (...args) => progressCalls.push(args);

  await provider.onDeleteFile(
    "request-delete-file",
    "storage-1",
    "/My Drive/file.txt"
  );
  await provider.onDeleteFolder(
    "request-delete-folder",
    "storage-1",
    "/My Drive/Folder"
  );

  assert.deepEqual(authorizationCalls, [
    { storageId: "storage-1", capability: "file.delete" },
    { storageId: "storage-1", capability: "folder.delete" }
  ]);
  assert.deepEqual(deleteCalls.map(({ method, path }) => ({ method, path })), [
    { method: "deleteFile", path: "/My Drive/file.txt" },
    { method: "deleteFolder", path: "/My Drive/Folder" }
  ]);
  assert.equal(
    deleteCalls.every(({ options }) => options.signal instanceof AbortSignal),
    true
  );
  assert.deepEqual(progressCalls, [
    ["request-delete-file", 50],
    ["request-delete-folder", 100]
  ]);
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

test("cancels active file and folder mutation requests", async () => {
  const cases = [
    {
      handler: "onWriteFile",
      namespaceMethod: "writeFile",
      args: ["/My Drive/file.txt", new Blob(["content"]), false]
    },
    {
      handler: "onAddFolder",
      namespaceMethod: "addFolder",
      args: ["/My Drive/Folder"]
    },
    {
      handler: "onDeleteFile",
      namespaceMethod: "deleteFile",
      args: ["/My Drive/file.txt"]
    },
    {
      handler: "onDeleteFolder",
      namespaceMethod: "deleteFolder",
      args: ["/My Drive/Folder"]
    }
  ];

  for (const { handler, namespaceMethod, args } of cases) {
    let operationSignal;
    const namespace = {
      async [namespaceMethod](...methodArgs) {
        const options = methodArgs.at(-1);
        operationSignal = options.signal;
        return new Promise((resolve, reject) => {
          operationSignal.addEventListener(
            "abort",
            () => reject(operationSignal.reason),
            { once: true }
          );
        });
      }
    };
    const { provider } = createProvider({ namespace });
    const operation = provider[handler](
      `request-${namespaceMethod}`,
      "storage-1",
      ...args
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await provider.onCancel(`request-${namespaceMethod}`);

    await assert.rejects(operation, (error) => error.name === "AbortError");
    assert.equal(operationSignal.aborted, true);
  }
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
      new GoogleDriveNamespaceError("drive_write_forbidden"),
      "google-drive-access",
      "vfsErrorAccessTitle"
    ],
    [
      new GoogleDriveNamespaceError("drive_delete_forbidden"),
      "google-drive-trash-forbidden",
      "vfsErrorTrashTitle"
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

test("preserves VFS conflict errors", () => {
  const source = Object.assign(new Error("Target already exists"), {
    code: "E:EXIST"
  });

  assert.equal(mapVfsProviderError(source, getMessage), source);
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
  const { namespaceCalls, provider } = createProvider({ logger });

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
  const creation = namespaceCalls.find((call) => call.method === "create");
  assert.equal(creation.options.logger, logger);
});
