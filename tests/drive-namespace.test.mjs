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

function createNamespace(overrides = {}, namespaceOptions = {}) {
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
    async createFileMetadata(metadata, options) {
      calls.push({ method: "createFileMetadata", metadata, options });
      throw new Error("Unexpected createFileMetadata call");
    },
    async updateFileMetadata(fileId, metadata, options) {
      calls.push({ method: "updateFileMetadata", fileId, metadata, options });
      throw new Error("Unexpected updateFileMetadata call");
    },
    ...overrides
  };
  return {
    calls,
    namespace: new GoogleDriveNamespace({
      apiClient,
      exportFormats: EXPORT_FORMATS,
      rootLabels: ROOT_LABELS,
      fileFactory: fakeFileFactory,
      ...namespaceOptions
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

test("writes a new file under the path name and forwards request state", async () => {
  const uploadCalls = [];
  const signal = new AbortController().signal;
  const onProgress = () => {};
  const source = new Blob(["content"], { type: "text/plain" });
  Object.defineProperty(source, "name", { value: "source-name.txt" });
  const { namespace } = createNamespace({
    async listFiles() {
      return { files: [], incompleteSearch: false };
    },
    async getFile(fileId, options) {
      assert.equal(fileId, "root");
      assert.equal(options.signal, signal);
      return file({
        id: "root",
        name: "My Drive",
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        capabilities: { canAddChildren: true }
      });
    }
  }, {
    uploader: {
      async upload(options) {
        uploadCalls.push(options);
        return { id: "created-file" };
      }
    }
  });

  assert.deepEqual(await namespace.writeFile(
    "/My Drive/target-name.txt",
    source,
    { signal, onProgress }
  ), { id: "created-file" });
  assert.equal(uploadCalls.length, 1);
  assert.equal(uploadCalls[0].file, source);
  assert.equal(uploadCalls[0].signal, signal);
  assert.equal(uploadCalls[0].onProgress, onProgress);
  assert.equal(uploadCalls[0].existingFileId, null);
  assert.equal(uploadCalls[0].resourceKeys, undefined);
  assert.deepEqual(uploadCalls[0].metadata, {
    name: "target-name.txt",
    mimeType: "text/plain",
    parents: ["root"]
  });
});

test("creates missing parent folders before uploading a file", async () => {
  const folders = [];
  const uploads = [];
  const signal = new AbortController().signal;
  const { namespace } = createNamespace({
    async listFiles() {
      return { files: [], incompleteSearch: false };
    },
    async getFile(fileId) {
      assert.equal(fileId, "root");
      return file({
        id: "root",
        name: "My Drive",
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        capabilities: { canAddChildren: true }
      });
    },
    async createFileMetadata(metadata, options) {
      folders.push({ metadata, options });
      const id = `folder-${folders.length}`;
      return file({
        id,
        name: metadata.name,
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        capabilities: { canAddChildren: true }
      });
    }
  }, {
    uploader: {
      async upload(options) {
        uploads.push(options);
        return { id: "uploaded-file" };
      }
    }
  });

  await namespace.writeFile(
    "/My Drive/First/Second/report.bin",
    new Blob(["data"]),
    { signal }
  );

  assert.deepEqual(folders.map(({ metadata }) => metadata), [
    {
      name: "First",
      mimeType: GOOGLE_FOLDER_MIME_TYPE,
      parents: ["root"]
    },
    {
      name: "Second",
      mimeType: GOOGLE_FOLDER_MIME_TYPE,
      parents: ["folder-1"]
    }
  ]);
  assert.equal(folders.every(({ options }) => options.signal === signal), true);
  assert.deepEqual(uploads[0].metadata, {
    name: "report.bin",
    mimeType: "application/octet-stream",
    parents: ["folder-2"]
  });
});

test("replaces an existing binary by ID only when overwrite is allowed", async () => {
  const uploads = [];
  const existing = file({
    id: "existing-id",
    name: "report.bin",
    mimeType: "application/octet-stream",
    resourceKey: "file-key",
    capabilities: { canDownload: true, canModifyContent: true }
  });
  const { namespace } = createNamespace({
    async listFiles() {
      return { files: [existing], incompleteSearch: false };
    }
  }, {
    uploader: {
      async upload(options) {
        uploads.push(options);
        return { id: existing.id };
      }
    }
  });
  const replacement = new Blob(["new"], { type: "text/plain" });

  await assert.rejects(
    namespace.writeFile("/My Drive/report.bin", replacement),
    (error) => error.code === "E:EXIST"
  );
  await namespace.writeFile("/My Drive/report.bin", replacement, {
    overwrite: true
  });

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].existingFileId, "existing-id");
  assert.deepEqual(uploads[0].resourceKeys, [{
    fileId: "existing-id",
    resourceKey: "file-key"
  }]);
  assert.deepEqual(uploads[0].metadata, {
    name: "report.bin",
    mimeType: "text/plain"
  });
  assert.equal(Object.hasOwn(uploads[0].metadata, "parents"), false);
});

test("uses ID-suffixed paths to replace the selected duplicate", async () => {
  const uploads = [];
  const duplicates = ["one", "two"].map((id) => file({
    id,
    name: "same.txt",
    mimeType: "text/plain",
    capabilities: { canDownload: true, canModifyContent: true }
  }));
  const { namespace } = createNamespace({
    async listFiles() {
      return { files: duplicates, incompleteSearch: false };
    }
  }, {
    uploader: {
      async upload(options) {
        uploads.push(options);
      }
    }
  });
  const content = new Blob(["new"]);

  await assert.rejects(
    namespace.writeFile("/My Drive/same.txt", content, { overwrite: true }),
    (error) => error.code === "E:EXIST"
  );
  await namespace.writeFile("/My Drive/same.txt~two", content, {
    overwrite: true
  });

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].existingFileId, "two");
});

test("keeps visible paths stable when hidden Drive items share their name", async () => {
  const uploads = [];
  const visible = file({
    id: "visible",
    name: "same.txt",
    mimeType: "text/plain",
    capabilities: { canDownload: true, canModifyContent: true }
  });
  const hidden = file({
    id: "hidden",
    name: "same.txt",
    mimeType: "application/vnd.google-apps.form",
    capabilities: { canDownload: false, canModifyContent: true }
  });
  const { namespace } = createNamespace({
    async listFiles() {
      return { files: [visible, hidden], incompleteSearch: false };
    }
  }, {
    uploader: {
      async upload(options) {
        uploads.push(options);
      }
    }
  });

  assert.deepEqual((await namespace.list("/My Drive")).map(({ name }) => name), [
    "same.txt"
  ]);
  await namespace.writeFile(
    "/My Drive/same.txt",
    new Blob(["new"]),
    { overwrite: true }
  );

  assert.equal(uploads[0].existingFileId, "visible");
});

test("does not treat a Workspace raw name as its exported VFS name", async () => {
  const uploads = [];
  const document = file({
    id: "document",
    name: "Budget",
    mimeType: GOOGLE_WORKSPACE_MIME_TYPES.document,
    capabilities: { canDownload: true, canModifyContent: true }
  });
  const { namespace } = createNamespace({
    async listFiles() {
      return { files: [document], incompleteSearch: false };
    },
    async getFile() {
      return file({
        id: "root",
        name: "My Drive",
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        capabilities: { canAddChildren: true }
      });
    }
  }, {
    uploader: {
      async upload(options) {
        uploads.push(options);
      }
    }
  });

  await namespace.writeFile("/My Drive/Budget", new Blob(["binary"]));
  await assert.rejects(
    namespace.writeFile(
      "/My Drive/Budget.docx",
      new Blob(["binary"]),
      { overwrite: true }
    ),
    (error) => error.code === "drive_overwrite_unsupported"
  );

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].metadata.name, "Budget");
});

test("rejects folders, shortcuts, native files, and read-only binaries as overwrite targets", async () => {
  const cases = [
    {
      item: file({
        id: "folder",
        name: "Folder",
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        capabilities: { canListChildren: true, canAddChildren: true }
      }),
      path: "/My Drive/Folder",
      code: "E:EXIST"
    },
    {
      item: file({
        id: "shortcut",
        name: "Link.bin",
        mimeType: GOOGLE_SHORTCUT_MIME_TYPE,
        shortcutDetails: {
          targetId: "target",
          targetMimeType: "application/octet-stream"
        }
      }),
      path: "/My Drive/Link.bin",
      code: "drive_overwrite_unsupported"
    },
    {
      item: file({
        id: "workspace",
        name: "Notes",
        mimeType: GOOGLE_WORKSPACE_MIME_TYPES.document
      }),
      path: "/My Drive/Notes.docx",
      code: "drive_overwrite_unsupported"
    },
    {
      item: file({
        id: "read-only",
        name: "locked.bin",
        capabilities: { canDownload: true, canModifyContent: false }
      }),
      path: "/My Drive/locked.bin",
      code: "drive_write_forbidden"
    }
  ];

  for (const entry of cases) {
    let uploaded = false;
    const { namespace } = createNamespace({
      async listFiles() {
        return { files: [entry.item], incompleteSearch: false };
      }
    }, {
      uploader: {
        async upload() {
          uploaded = true;
        }
      }
    });
    await assert.rejects(
      namespace.writeFile(entry.path, new Blob(["new"]), {
        overwrite: true
      }),
      (error) => error.code === entry.code
    );
    assert.equal(uploaded, false);
  }
});

test("creates nested folders and rejects occupied folder targets", async () => {
  const created = [];
  const progress = [];
  const { namespace } = createNamespace({
    async listFiles(options) {
      if (options.q.includes("'root'")) {
        return { files: [], incompleteSearch: false };
      }
      return { files: [], incompleteSearch: false };
    },
    async getFile() {
      return file({
        id: "root",
        name: "My Drive",
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        capabilities: { canAddChildren: true }
      });
    },
    async createFileMetadata(metadata, options) {
      created.push({ metadata, options });
      return file({
        id: `new-folder-${created.length}`,
        name: metadata.name,
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        capabilities: { canAddChildren: true }
      });
    }
  });

  await namespace.addFolder("/My Drive/Parent/Child", {
    onProgress: (percent) => progress.push(percent)
  });

  assert.deepEqual(created.map(({ metadata }) => metadata.parents), [
    ["root"],
    ["new-folder-1"]
  ]);
  assert.deepEqual(progress, [50, 100]);

  for (const occupied of [
    file({
      id: "occupied-folder",
      name: "Taken",
      mimeType: GOOGLE_FOLDER_MIME_TYPE,
      capabilities: { canListChildren: true }
    }),
    file({ id: "occupied-file", name: "Taken" })
  ]) {
    const blocked = createNamespace({
      async listFiles() {
        return { files: [occupied], incompleteSearch: false };
      }
    }).namespace;
    await assert.rejects(
      blocked.addFolder("/My Drive/Taken"),
      (error) => error.code === "E:EXIST"
    );
  }
});

test("rejects a file used as an intermediate folder", async () => {
  const binary = file({ id: "binary", name: "file.bin" });
  const { namespace } = createNamespace({
    async listFiles() {
      return { files: [binary], incompleteSearch: false };
    }
  });

  await assert.rejects(
    namespace.addFolder("/My Drive/file.bin/child"),
    (error) => error.code === "drive_not_a_folder"
  );
});

test("accepts literal percent and tilde characters from VFS clients", async () => {
  const uploadedNames = [];
  const createdNames = [];
  const { namespace } = createNamespace({
    async listFiles() {
      return { files: [], incompleteSearch: false };
    },
    async getFile() {
      return file({
        id: "root",
        name: "My Drive",
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        capabilities: { canAddChildren: true }
      });
    },
    async createFileMetadata(metadata) {
      createdNames.push(metadata.name);
      return file({
        id: `folder-${createdNames.length}`,
        name: metadata.name,
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        capabilities: { canAddChildren: true }
      });
    }
  }, {
    uploader: {
      async upload({ metadata }) {
        uploadedNames.push(metadata.name);
      }
    }
  });
  const names = ["100% ready.txt", "literal%2F.txt", "notes~draft.txt"];

  for (const name of names) {
    await namespace.writeFile(`/My Drive/${name}`, new Blob(["data"]));
  }
  for (const name of names) {
    await namespace.addFolder(`/My Drive/${name}`);
  }

  assert.deepEqual(uploadedNames, names);
  assert.deepEqual(createdNames, names);
});

test("writes into link-shared folders with their resource keys", async () => {
  const uploads = [];
  const folders = [];
  const shortcut = file({
    id: "shortcut",
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
      return options.q.includes("'root'")
        ? { files: [shortcut], incompleteSearch: false }
        : { files: [], incompleteSearch: false };
    },
    async getFile(fileId, options) {
      assert.equal(fileId, "target-folder");
      assert.equal(options.resourceKey, "target-key");
      return file({
        id: "target-folder",
        name: "Target",
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        resourceKey: "target-key",
        capabilities: { canAddChildren: true }
      });
    },
    async createFileMetadata(metadata, options) {
      folders.push({ metadata, options });
      return file({
        id: "new-folder",
        name: metadata.name,
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        capabilities: { canAddChildren: true }
      });
    }
  }, {
    uploader: {
      async upload(options) {
        uploads.push(options);
      }
    }
  });

  await namespace.writeFile(
    "/My Drive/Linked folder/new.bin",
    new Blob(["data"])
  );
  await namespace.addFolder("/My Drive/Linked folder/New folder");

  assert.deepEqual(uploads[0].metadata.parents, ["target-folder"]);
  assert.deepEqual(uploads[0].resourceKeys, [{
    fileId: "target-folder",
    resourceKey: "target-key"
  }]);
  assert.deepEqual(folders[0].options.resourceKeys, [{
    fileId: "target-folder",
    resourceKey: "target-key"
  }]);
});

test("writes below a concrete writable folder shared with the account", async () => {
  const uploads = [];
  const sharedFolder = file({
    id: "shared-folder",
    name: "Incoming",
    mimeType: GOOGLE_FOLDER_MIME_TYPE,
    resourceKey: "shared-key",
    capabilities: { canListChildren: true, canAddChildren: true }
  });
  const { namespace } = createNamespace({
    async listFiles(options) {
      return options.q.startsWith("sharedWithMe")
        ? { files: [sharedFolder], incompleteSearch: false }
        : { files: [], incompleteSearch: false };
    }
  }, {
    uploader: {
      async upload(options) {
        uploads.push(options);
      }
    }
  });

  await namespace.writeFile(
    "/Shared with me/Incoming/new.bin",
    new Blob(["data"])
  );

  assert.deepEqual(uploads[0].metadata.parents, ["shared-folder"]);
  assert.deepEqual(uploads[0].resourceKeys, [{
    fileId: "shared-folder",
    resourceKey: "shared-key"
  }]);
});

test("enforces Shared Drive and shared-with-me write boundaries", async () => {
  const created = [];
  const { namespace } = createNamespace({
    async listDrives() {
      return {
        drives: [{
          id: "team-drive",
          name: "Team",
          capabilities: { canAddChildren: true }
        }]
      };
    },
    async listFiles() {
      return { files: [], incompleteSearch: false };
    },
    async createFileMetadata(metadata, options) {
      created.push({ metadata, options });
      return file({
        id: "folder-id",
        name: metadata.name,
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        driveId: "team-drive",
        capabilities: { canAddChildren: true }
      });
    }
  });

  await assert.rejects(
    namespace.addFolder("/Shared drives/New"),
    (error) => error.code === "drive_write_forbidden"
  );
  await assert.rejects(
    namespace.addFolder("/Shared with me/New"),
    (error) => error.code === "drive_write_forbidden"
  );
  await namespace.addFolder("/Shared drives/Team/New");

  assert.deepEqual(created[0].metadata.parents, ["team-drive"]);
  assert.equal(created[0].options.supportsAllDrives, true);
});

test("checks parent write capability before creating content", async () => {
  let uploaded = false;
  const { namespace } = createNamespace({
    async listFiles() {
      return { files: [], incompleteSearch: false };
    },
    async getFile() {
      return file({
        id: "root",
        name: "My Drive",
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        capabilities: { canAddChildren: false }
      });
    }
  }, {
    uploader: {
      async upload() {
        uploaded = true;
      }
    }
  });

  await assert.rejects(
    namespace.writeFile("/My Drive/new.bin", new Blob(["data"])),
    (error) => error.code === "drive_write_forbidden"
  );
  assert.equal(uploaded, false);
});

test("validates write arguments before contacting Drive", async () => {
  let requests = 0;
  const { namespace } = createNamespace({
    async listFiles() {
      requests++;
      return { files: [] };
    }
  });

  await assert.rejects(namespace.writeFile("/My Drive/file", {}), /file/u);
  await assert.rejects(
    namespace.writeFile("/My Drive/file", new Blob(), { overwrite: "yes" }),
    /overwrite/u
  );
  await assert.rejects(
    namespace.writeFile("/My Drive/file", new Blob(), { onProgress: true }),
    /onProgress/u
  );
  await assert.rejects(
    namespace.addFolder("/My Drive/folder", { onProgress: true }),
    /onProgress/u
  );
  assert.equal(requests, 0);
});

test("does not inherit a Shared Drive ID through a folder shortcut", async () => {
  const listCalls = [];
  const shortcut = file({
    id: "shortcut",
    name: "My Drive target",
    mimeType: GOOGLE_SHORTCUT_MIME_TYPE,
    driveId: "team-drive",
    shortcutDetails: {
      targetId: "target-folder",
      targetMimeType: GOOGLE_FOLDER_MIME_TYPE
    }
  });
  const { namespace } = createNamespace({
    async listDrives() {
      return { drives: [{ id: "team-drive", name: "Team" }] };
    },
    async listFiles(options) {
      listCalls.push(options);
      return options.q.includes("'team-drive'")
        ? { files: [shortcut], incompleteSearch: false }
        : { files: [], incompleteSearch: false };
    },
    async getFile() {
      return file({
        id: "target-folder",
        name: "Target",
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        capabilities: { canListChildren: true, canAddChildren: true }
      });
    }
  });

  await namespace.list(
    "/Shared drives/Team/My Drive target"
  );

  assert.equal(listCalls.at(-1).corpora, "user");
  assert.equal(listCalls.at(-1).driveId, undefined);
});

test("moves files and folders to the Drive trash", async () => {
  const signal = new AbortController().signal;
  const progress = [];
  const trashed = [];
  const items = [
    file({
      id: "file-id",
      name: "Report.pdf",
      resourceKey: "file-key",
      capabilities: { canDownload: true, canTrash: true }
    }),
    file({
      id: "folder-id",
      name: "Archive",
      mimeType: GOOGLE_FOLDER_MIME_TYPE,
      resourceKey: "folder-key",
      capabilities: {
        canListChildren: true,
        canTrash: true
      }
    })
  ];
  const { namespace } = createNamespace({
    async listFiles() {
      return { files: items, incompleteSearch: false };
    },
    async updateFileMetadata(fileId, metadata, options) {
      trashed.push({ fileId, metadata, options });
    }
  });

  await namespace.deleteFile("/My Drive/Report.pdf", {
    signal,
    onProgress: (percent) => progress.push(percent)
  });
  await namespace.deleteFolder("/My Drive/Archive", {
    signal,
    onProgress: (percent) => progress.push(percent)
  });

  assert.deepEqual(trashed, [
    {
      fileId: "file-id",
      metadata: { trashed: true },
      options: {
        supportsAllDrives: true,
        resourceKeys: [{ fileId: "file-id", resourceKey: "file-key" }],
        signal
      }
    },
    {
      fileId: "folder-id",
      metadata: { trashed: true },
      options: {
        supportsAllDrives: true,
        resourceKeys: [{ fileId: "folder-id", resourceKey: "folder-key" }],
        signal
      }
    }
  ]);
  assert.deepEqual(progress, [0, 100, 0, 100]);
});

test("trashes the selected shortcut instead of its target", async () => {
  const updates = [];
  let targetRequests = 0;
  const shortcut = file({
    id: "shortcut-id",
    name: "Linked folder",
    mimeType: GOOGLE_SHORTCUT_MIME_TYPE,
    resourceKey: "shortcut-key",
    capabilities: { canTrash: true },
    shortcutDetails: {
      targetId: "target-folder",
      targetMimeType: GOOGLE_FOLDER_MIME_TYPE,
      targetResourceKey: "target-key"
    }
  });
  const { namespace } = createNamespace({
    async listFiles() {
      return { files: [shortcut], incompleteSearch: false };
    },
    async getFile() {
      targetRequests++;
      throw new Error("Shortcut target must not be loaded");
    },
    async updateFileMetadata(fileId, metadata, options) {
      updates.push({ fileId, metadata, options });
    }
  });

  await namespace.deleteFolder("/My Drive/Linked folder");

  assert.equal(targetRequests, 0);
  assert.equal(updates[0].fileId, "shortcut-id");
  assert.deepEqual(updates[0].options.resourceKeys, [{
    fileId: "shortcut-id",
    resourceKey: "shortcut-key"
  }]);
});

test("trashes the selected Workspace item and duplicate Drive item by ID", async () => {
  const updates = [];
  const items = [
    file({
      id: "workspace-id",
      name: "Notes",
      mimeType: GOOGLE_WORKSPACE_MIME_TYPES.document,
      capabilities: { canDownload: true, canTrash: true }
    }),
    file({
      id: "duplicate-a",
      name: "Report.pdf",
      capabilities: { canDownload: true, canTrash: true }
    }),
    file({
      id: "duplicate-b",
      name: "Report.pdf",
      capabilities: { canDownload: true, canTrash: true }
    })
  ];
  const { namespace } = createNamespace({
    async listFiles() {
      return { files: items, incompleteSearch: false };
    },
    async updateFileMetadata(fileId) {
      updates.push(fileId);
    }
  });

  const listed = await namespace.list("/My Drive");
  const selectedDuplicate = listed.find((entry) =>
    entry.name.startsWith("Report.pdf~") && entry.name.includes("duplicate-b"));
  await namespace.deleteFile("/My Drive/Notes.docx");
  await namespace.deleteFile(selectedDuplicate.path);

  assert.deepEqual(updates, ["workspace-id", "duplicate-b"]);
});

test("rejects unavailable and non-trashable delete targets", async () => {
  let updates = 0;
  const lockedFile = file({
    id: "locked-file",
    name: "Locked.bin",
    capabilities: { canDownload: true, canTrash: false }
  });
  const folder = file({
    id: "folder-id",
    name: "Folder",
    mimeType: GOOGLE_FOLDER_MIME_TYPE,
    capabilities: { canListChildren: true, canTrash: true }
  });
  const { namespace } = createNamespace({
    async listFiles() {
      return { files: [lockedFile, folder], incompleteSearch: false };
    },
    async updateFileMetadata() {
      updates++;
    }
  });

  await assert.rejects(
    namespace.deleteFile("/My Drive/Locked.bin"),
    (error) => error.code === "drive_delete_forbidden"
  );
  await assert.rejects(
    namespace.deleteFile("/My Drive/Folder"),
    (error) => error.code === "drive_file_not_found"
  );
  await assert.rejects(
    namespace.deleteFolder("/My Drive/Locked.bin"),
    (error) => error.code === "drive_path_not_found"
  );
  await assert.rejects(
    namespace.deleteFolder("/My Drive"),
    (error) => error.code === "drive_path_not_found"
  );
  assert.equal(updates, 0);
});

test("validates delete progress before contacting Drive", async () => {
  let requests = 0;
  const { namespace } = createNamespace({
    async listFiles() {
      requests++;
      return { files: [], incompleteSearch: false };
    }
  });

  await assert.rejects(
    namespace.deleteFile("/My Drive/file", { onProgress: true }),
    /onProgress/u
  );
  await assert.rejects(
    namespace.deleteFolder("/My Drive/folder", { onProgress: true }),
    /onProgress/u
  );
  assert.equal(requests, 0);
});
