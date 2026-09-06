/**
 * Read-only Google Drive API client tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  DRIVE_ABOUT_FIELDS,
  DRIVE_FIELDS,
  DRIVE_FILE_FIELDS,
  GoogleDriveApiClient
} from "../src/google/drive-api-client.mjs";
import { GoogleDriveRequestError } from "../src/google/drive-transport.mjs";

function createClient(handler) {
  const calls = [];
  const transport = {
    async request(accountId, options) {
      calls.push({ accountId, options });
      return handler(options, calls.length);
    }
  };
  return {
    calls,
    client: new GoogleDriveApiClient({
      transport,
      accountId: "account-1"
    })
  };
}

test("gets About data and the storage quota projection", async () => {
  const { calls, client } = createClient((options) => ({
    storageQuota: { usage: options.query.fields }
  }));

  const about = await client.getAbout();
  const quota = await client.getStorageQuota();

  assert.equal(about.storageQuota.usage, DRIVE_ABOUT_FIELDS);
  assert.deepEqual(quota, {
    usage: "storageQuota(limit,usage,usageInDrive,usageInDriveTrash)"
  });
  assert.equal(calls[0].options.resourcePath, "about");
  assert.equal(calls[0].options.operation, "about.get");
  assert.equal(calls[1].options.query.fields.includes("storageQuota"), true);
});

test("collects every files.list page without dropping an empty page", async () => {
  const { calls, client } = createClient((options) => {
    if (!options.query.pageToken) {
      return { files: [{ id: "file-1" }], nextPageToken: "page-2" };
    }
    if (options.query.pageToken === "page-2") {
      return { nextPageToken: "page-3", incompleteSearch: true };
    }
    return { files: [{ id: "file-2" }] };
  });

  const result = await client.listFiles({
    q: "'folder-id' in parents and trashed = false",
    corpora: "drive",
    driveId: "shared-drive-id",
    spaces: ["drive"],
    orderBy: "name_natural",
    resourceKeys: [
      { fileId: "folder-id", resourceKey: "resource-key" },
      { fileId: "target-id", resourceKey: "target-key" }
    ]
  });

  assert.deepEqual(result, {
    files: [{ id: "file-1" }, { id: "file-2" }],
    incompleteSearch: true
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.options.query.pageToken), [
    undefined,
    "page-2",
    "page-3"
  ]);
  assert.equal(calls[0].options.query.corpora, "drive");
  assert.equal(calls[0].options.query.driveId, "shared-drive-id");
  assert.equal(calls[0].options.query.includeItemsFromAllDrives, true);
  assert.equal(calls[0].options.query.supportsAllDrives, true);
  assert.equal(calls[0].options.query.spaces, "drive");
  assert.equal(calls[0].options.query.fields.includes("nextPageToken"), true);
  assert.equal(calls[0].options.query.fields.includes(`files(${DRIVE_FILE_FIELDS})`), true);
  assert.deepEqual(calls.map((call) => call.options.headers), [
    { "X-Goog-Drive-Resource-Keys": "folder-id/resource-key,target-id/target-key" },
    { "X-Goog-Drive-Resource-Keys": "folder-id/resource-key,target-id/target-key" },
    { "X-Goog-Drive-Resource-Keys": "folder-id/resource-key,target-id/target-key" }
  ]);
});

test("collects every drives.list page", async () => {
  const { calls, client } = createClient((options) =>
    options.query.pageToken
      ? { drives: [{ id: "drive-2" }] }
      : { drives: [{ id: "drive-1" }], nextPageToken: "next" });

  const result = await client.listDrives({
    q: "hidden = false",
    useDomainAdminAccess: true
  });

  assert.deepEqual(result, {
    drives: [{ id: "drive-1" }, { id: "drive-2" }]
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.query.pageSize, 100);
  assert.equal(calls[0].options.query.useDomainAdminAccess, true);
  assert.equal(calls[0].options.query.fields.includes(`drives(${DRIVE_FIELDS})`), true);
});

test("gets metadata with shared-drive support and an encoded file ID", async () => {
  const signal = new AbortController().signal;
  const { calls, client } = createClient(() => ({ id: "file/id" }));

  assert.deepEqual(await client.getFile("file/id", { signal }), {
    id: "file/id"
  });
  assert.equal(calls[0].options.resourcePath, "files/file%2Fid");
  assert.equal(calls[0].options.query.fields, DRIVE_FILE_FIELDS);
  assert.equal(calls[0].options.query.supportsAllDrives, true);
  assert.deepEqual(calls[0].options.headers, {});
  assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.operation, "files.get");
});

test("downloads stored content as a blob with optional range and abuse acknowledgement", async () => {
  const expected = new Blob(["content"]);
  const { calls, client } = createClient(() => expected);

  const result = await client.downloadBlob("file-1", {
    range: "bytes=10-19",
    acknowledgeAbuse: true,
    resourceKey: "key-1"
  });

  assert.equal(result, expected);
  assert.equal(calls[0].options.resourcePath, "files/file-1");
  assert.deepEqual(calls[0].options.query, {
    alt: "media",
    acknowledgeAbuse: true,
    supportsAllDrives: true
  });
  assert.deepEqual(calls[0].options.headers, {
    "X-Goog-Drive-Resource-Keys": "file-1/key-1",
    Range: "bytes=10-19"
  });
  assert.equal(calls[0].options.responseType, "blob");
  assert.equal(calls[0].options.operation, "files.download");
});

test("exports a Workspace file with an encoded file ID", async () => {
  const expected = new Blob(["export"]);
  const { calls, client } = createClient(() => expected);

  const result = await client.exportFile("workspace/file", "application/pdf");

  assert.equal(result, expected);
  assert.equal(calls[0].options.resourcePath, "files/workspace%2Ffile/export");
  assert.deepEqual(calls[0].options.query, { mimeType: "application/pdf" });
  assert.deepEqual(calls[0].options.headers, {});
  assert.equal(calls[0].options.responseType, "blob");
  assert.equal(calls[0].options.operation, "files.export");
});

test("exports a link-shared Workspace file with its resource key", async () => {
  const expected = new Blob(["export"]);
  const { calls, client } = createClient(() => expected);

  const result = await client.exportFile(
    "workspace-file",
    "application/pdf",
    { resourceKey: "key-1" }
  );

  assert.equal(result, expected);
  assert.deepEqual(calls[0].options.headers, {
    "X-Goog-Drive-Resource-Keys": "workspace-file/key-1"
  });
  assert.equal(calls[0].options.responseType, "blob");
  assert.equal(calls[0].options.operation, "files.export");
});

test("rejects a repeated page token instead of looping forever", async () => {
  const { client } = createClient(() => ({
    files: [],
    nextPageToken: "repeated"
  }));

  await assert.rejects(
    client.listFiles(),
    (error) => error instanceof GoogleDriveRequestError &&
      error.code === "drive_pagination_invalid"
  );
});

test("rejects page sizes beyond the Drive API limits", async () => {
  const { client } = createClient(() => ({ files: [] }));

  await assert.rejects(client.listFiles({ pageSize: 1001 }), /pageSize/);
  await assert.rejects(client.listDrives({ pageSize: 101 }), /pageSize/);
});

test("rejects malformed resource-key header values", async () => {
  const { client } = createClient(() => ({ files: [] }));

  await assert.rejects(client.listFiles({
    resourceKeys: [{ fileId: "folder-id", resourceKey: "line\nbreak" }]
  }), /resourceKeys/);
  await assert.rejects(client.getFile("file-1", {
    resourceKey: "comma,key"
  }), /resourceKeys/);
  await assert.rejects(client.getFile("file-1", {
    resourceKey: ""
  }), /resourceKey/);
  await assert.rejects(client.listFiles({
    resourceKeys: new Array(1)
  }), /resourceKeyFileId/);
});
