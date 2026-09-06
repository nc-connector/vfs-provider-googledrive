/**
 * Google Drive VFS hierarchy tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  GOOGLE_FOLDER_MIME_TYPE,
  GOOGLE_SHORTCUT_MIME_TYPE,
  GoogleDriveNamespace,
  GoogleDriveNamespaceError
} from "../src/google/drive-namespace.mjs";
import {
  GOOGLE_WORKSPACE_MIME_TYPES
} from "../src/google/workspace-export.mjs";

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

function fakeFileFactory(parts, name, options) {
  return { parts, name, ...options };
}

function createNamespace(overrides = {}) {
  const calls = [];
  const apiClient = {
    async getStorageQuota(options) {
      calls.push({ method: "getStorageQuota", options });
      return { usage: "100", limit: "1000" };
    },
    async listFiles(options) {
      calls.push({ method: "listFiles", options });
      return { files: [], incompleteSearch: false };
    },
    async listDrives(options) {
      calls.push({ method: "listDrives", options });
      return { drives: [] };
    },
    async getFile(fileId, options) {
      calls.push({ method: "getFile", fileId, options });
      throw new Error("Unexpected getFile call");
    },
    async downloadBlob(fileId, options) {
      calls.push({ method: "downloadBlob", fileId, options });
      return new Blob(["binary"], { type: "application/octet-stream" });
    },
    async exportFile(fileId, mimeType, options) {
      calls.push({ method: "exportFile", fileId, mimeType, options });
      return new Blob(["export"], { type: mimeType });
    },
    ...overrides
  };
  return {
    calls,
    namespace: new GoogleDriveNamespace({
      apiClient,
      exportFormats: EXPORT_FORMATS,
      rootLabels: ROOT_LABELS,
      fileFactory: fakeFileFactory
    })
  };
}

function file({
  id,
  name,
  mimeType = "application/octet-stream",
  driveId,
  resourceKey,
  size = "10",
  modifiedTime = "2026-09-06T08:00:00.000Z",
  capabilities = { canDownload: true },
  shortcutDetails
}) {
  return {
    id,
    name,
    mimeType,
    driveId,
    resourceKey,
    size,
    modifiedTime,
    capabilities,
    shortcutDetails,
    trashed: false
  };
}

test("exposes the three virtual Drive roots", async () => {
  const { namespace } = createNamespace();

  assert.deepEqual(await namespace.list("/"), [
    { name: "My Drive", path: "/My Drive", kind: "directory" },
    { name: "Shared with me", path: "/Shared with me", kind: "directory" },
    { name: "Shared drives", path: "/Shared drives", kind: "directory" }
  ]);
});

test("lists My Drive children and presents supported Workspace exports", async () => {
  const items = [
    file({ id: "folder", name: "Folder", mimeType: GOOGLE_FOLDER_MIME_TYPE }),
    file({ id: "binary", name: "Report.final.pdf", size: "42" }),
    file({
      id: "document",
      name: "Project plan",
      mimeType: GOOGLE_WORKSPACE_MIME_TYPES.document,
      size: undefined
    }),
    file({
      id: "blocked-document",
      name: "Private notes",
      mimeType: GOOGLE_WORKSPACE_MIME_TYPES.document,
      capabilities: { canDownload: false }
    }),
    file({
      id: "binary-shortcut",
      name: "Linked archive.zip",
      mimeType: GOOGLE_SHORTCUT_MIME_TYPE,
      capabilities: { canDownload: false },
      shortcutDetails: {
        targetId: "archive-id",
        targetMimeType: "application/zip"
      }
    }),
    file({
      id: "form",
      name: "Survey",
      mimeType: "application/vnd.google-apps.form"
    }),
    file({
      id: "blocked",
      name: "Blocked.bin",
      capabilities: { canDownload: false }
    })
  ];
  const { calls, namespace } = createNamespace({
    async listFiles(options) {
      calls.push({ method: "listFiles", options });
      return { files: items, incompleteSearch: false };
    }
  });

  const entries = await namespace.list("/My Drive");

  assert.deepEqual(entries.map(({ name, kind }) => ({ name, kind })), [
    { name: "Folder", kind: "directory" },
    { name: "Linked archive.zip", kind: "file" },
    { name: "Project plan.docx", kind: "file" },
    { name: "Report.final.pdf", kind: "file" }
  ]);
  assert.equal(entries[2].size, undefined);
  assert.equal(entries[3].size, 42);
  assert.equal(entries[3].lastModified, Date.parse("2026-09-06T08:00:00.000Z"));
  assert.equal(Object.hasOwn(entries[0], "lastModified"), false);
  assert.equal(calls[0].options.q, "'root' in parents and trashed = false");
  assert.equal(calls[0].options.corpora, "user");
  assert.equal(calls[0].options.spaces, "drive");
});

test("keeps unsafe and duplicate Drive names addressable", async () => {
  const { namespace } = createNamespace({
    async listFiles() {
      return {
        files: [
          file({ id: "one", name: "same/name.txt" }),
          file({ id: "two", name: "same/name.txt" })
        ],
        incompleteSearch: false
      };
    }
  });

  const entries = await namespace.list("/My Drive");

  assert.deepEqual(entries.map((entry) => entry.name), [
    "same%2Fname.txt~one",
    "same%2Fname.txt~two"
  ]);
  assert.equal(entries.every((entry) => !entry.name.includes("/")), true);
});

test("resolves nested folders again by their stable Drive IDs", async () => {
  const calls = [];
  const { namespace } = createNamespace({
    async listFiles(options) {
      calls.push(options);
      if (options.q.includes("'root'")) {
        return {
          files: [file({
            id: "folder-id",
            name: "Folder",
            mimeType: GOOGLE_FOLDER_MIME_TYPE,
            resourceKey: "folder-key"
          })],
          incompleteSearch: false
        };
      }
      return {
        files: [file({ id: "child-id", name: "child.txt" })],
        incompleteSearch: false
      };
    }
  });

  const entries = await namespace.list("/My Drive/Folder");

  assert.equal(entries[0].path, "/My Drive/Folder/child.txt");
  assert.equal(calls[1].q, "'folder-id' in parents and trashed = false");
  assert.deepEqual(calls[1].resourceKeys, [{
    fileId: "folder-id",
    resourceKey: "folder-key"
  }]);
});

test("uses the dedicated shared-with-me query", async () => {
  let received;
  const { namespace } = createNamespace({
    async listFiles(options) {
      received = options;
      return { files: [file({ id: "shared", name: "Shared.txt" })] };
    }
  });

  const entries = await namespace.list("/Shared with me");

  assert.equal(entries[0].name, "Shared.txt");
  assert.equal(received.q, "sharedWithMe and trashed = false");
  assert.equal(received.corpora, "user");
});

test("lists Shared Drives and scopes their children to one drive", async () => {
  const calls = [];
  const { namespace } = createNamespace({
    async listDrives(options) {
      calls.push({ method: "listDrives", options });
      return { drives: [{ id: "drive-id", name: "Team Drive" }] };
    },
    async listFiles(options) {
      calls.push({ method: "listFiles", options });
      return options.q.includes("'drive-id'")
        ? { files: [file({
          id: "team-folder",
          name: "Folder",
          mimeType: GOOGLE_FOLDER_MIME_TYPE,
          driveId: "drive-id"
        })] }
        : { files: [file({
          id: "team-file",
          name: "Team.txt",
          driveId: "drive-id"
        })] };
    }
  });

  assert.deepEqual(await namespace.list("/Shared drives"), [{
    name: "Team Drive",
    path: "/Shared drives/Team Drive",
    kind: "directory"
  }]);
  assert.equal(calls[0].options.q, "hidden = false");
  const entries = await namespace.list("/Shared drives/Team Drive");

  assert.equal(entries[0].name, "Folder");
  const listCall = calls.find((call) => call.method === "listFiles");
  assert.equal(listCall.options.q, "'drive-id' in parents and trashed = false");
  assert.equal(listCall.options.corpora, "drive");
  assert.equal(listCall.options.driveId, "drive-id");
  assert.equal(listCall.options.includeItemsFromAllDrives, true);
  assert.equal(listCall.options.supportsAllDrives, true);

  const nested = await namespace.list("/Shared drives/Team Drive/Folder");
  assert.equal(nested[0].path, "/Shared drives/Team Drive/Folder/Team.txt");
});

test("follows a folder shortcut with its target resource key", async () => {
  const calls = [];
  const shortcut = file({
    id: "shortcut-id",
    name: "Linked folder",
    mimeType: GOOGLE_SHORTCUT_MIME_TYPE,
    shortcutDetails: {
      targetId: "target-folder",
      targetMimeType: GOOGLE_FOLDER_MIME_TYPE,
      targetResourceKey: "target-key"
    }
  });
  const { namespace } = createNamespace({
    async listFiles(options) {
      calls.push({ method: "listFiles", options });
      return options.q.includes("'root'")
        ? { files: [shortcut] }
        : { files: [file({ id: "child", name: "Inside.txt", driveId: "drive-id" })] };
    },
    async getFile(fileId, options) {
      calls.push({ method: "getFile", fileId, options });
      return file({
        id: fileId,
        name: "Target folder",
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        driveId: "drive-id",
        resourceKey: "target-key"
      });
    }
  });

  const entries = await namespace.list("/My Drive/Linked folder");

  assert.equal(entries[0].name, "Inside.txt");
  const getCall = calls.find((call) => call.method === "getFile");
  assert.equal(getCall.fileId, "target-folder");
  assert.equal(getCall.options.resourceKey, "target-key");
  const childCall = calls.at(-1);
  assert.equal(childCall.options.corpora, "drive");
  assert.deepEqual(childCall.options.resourceKeys, [{
    fileId: "target-folder",
    resourceKey: "target-key"
  }]);
});

test("downloads a binary file without writing an intermediate file", async () => {
  const calls = [];
  const item = file({
    id: "binary-id",
    name: "archive.zip",
    resourceKey: "binary-key"
  });
  const { namespace } = createNamespace({
    async listFiles() {
      return { files: [item] };
    },
    async downloadBlob(fileId, options) {
      calls.push({ method: "downloadBlob", fileId, options });
      return new Blob(["content"], { type: "application/zip" });
    }
  });

  const result = await namespace.readFile("/My Drive/archive.zip");

  assert.equal(result.name, "archive.zip");
  assert.equal(result.type, "application/zip");
  assert.equal(result.parts[0] instanceof Blob, true);
  assert.deepEqual(calls[0], {
    method: "downloadBlob",
    fileId: "binary-id",
    options: { resourceKey: "binary-key", signal: undefined }
  });
});

test("exports a Workspace shortcut using the target ID and resource key", async () => {
  const calls = [];
  const shortcut = file({
    id: "shortcut-id",
    name: "Budget",
    mimeType: GOOGLE_SHORTCUT_MIME_TYPE,
    shortcutDetails: {
      targetId: "sheet-id",
      targetMimeType: GOOGLE_WORKSPACE_MIME_TYPES.spreadsheet
    }
  });
  const { namespace } = createNamespace({
    async listFiles() {
      return { files: [shortcut] };
    },
    async getFile(fileId, options) {
      calls.push({ method: "getFile", fileId, options });
      return file({
        id: fileId,
        name: "Original sheet",
        mimeType: GOOGLE_WORKSPACE_MIME_TYPES.spreadsheet,
        resourceKey: "sheet-key"
      });
    },
    async exportFile(fileId, mimeType, options) {
      calls.push({ method: "exportFile", fileId, mimeType, options });
      return new Blob(["sheet"]);
    }
  });

  const result = await namespace.readFile("/My Drive/Budget.xlsx");

  assert.equal(result.name, "Budget.xlsx");
  assert.equal(result.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(calls[0].method, "getFile");
  assert.equal(calls[0].options.resourceKey, undefined);
  assert.equal(calls[1].method, "exportFile");
  assert.equal(calls[1].fileId, "sheet-id");
  assert.equal(calls[1].options.resourceKey, "sheet-key");
});

test("maps absent storage limits to null instead of inventing a quota", async () => {
  const signal = new AbortController().signal;
  const { namespace } = createNamespace({
    async getStorageQuota(options) {
      assert.equal(options.signal, signal);
      return { usage: "2048" };
    }
  });

  assert.deepEqual(await namespace.getStorageUsage({ signal }), {
    usage: 2048,
    quota: null
  });
});

test("rejects missing paths, files used as folders, and incomplete searches", async () => {
  const binary = file({ id: "binary", name: "file.bin" });
  const { namespace } = createNamespace({
    async listFiles() {
      return { files: [binary], incompleteSearch: true };
    }
  });

  await assert.rejects(
    namespace.list("/Unknown"),
    (error) => error instanceof GoogleDriveNamespaceError &&
      error.code === "drive_path_not_found"
  );
  await assert.rejects(
    namespace.list("/My Drive"),
    (error) => error.code === "drive_search_incomplete"
  );
});
