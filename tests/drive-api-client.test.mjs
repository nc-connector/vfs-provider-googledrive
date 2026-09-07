/**
 * Google Drive API client tests.
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

test("creates metadata in My Drive and Shared Drive folders", async () => {
  const metadata = {
    name: "New folder",
    mimeType: "application/vnd.google-apps.folder",
    parents: ["parent-1"]
  };
  const { calls, client } = createClient(() => ({ id: "folder-1" }));

  assert.deepEqual(await client.createFileMetadata(metadata, {
    resourceKeys: [{ fileId: "parent-1", resourceKey: "resource-key" }]
  }), { id: "folder-1" });

  assert.equal(calls[0].options.resourcePath, "files");
  assert.deepEqual(calls[0].options.query, {
    supportsAllDrives: true,
    fields: DRIVE_FILE_FIELDS
  });
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(calls[0].options.headers, {
    "X-Goog-Drive-Resource-Keys": "parent-1/resource-key",
    "Content-Type": "application/json; charset=UTF-8"
  });
  assert.equal(calls[0].options.body, JSON.stringify(metadata));
  assert.equal(calls[0].options.operation, "files.create.metadata");
  assert.equal(calls[0].options.retryMode, "never");
});

test("creates a small file with metadata-first multipart upload", async () => {
  const media = new Blob(["file data"], { type: "text/plain" });
  const { calls, client } = createClient(() => ({ id: "created-file" }));

  assert.deepEqual(await client.uploadMultipart({
    metadata: { name: "report.txt", parents: ["folder-1"] },
    media,
    resourceKeys: [{ fileId: "folder-1", resourceKey: "folder-key" }]
  }), { id: "created-file" });

  const options = calls[0].options;
  assert.equal(options.resourcePath, "files");
  assert.equal(options.endpoint, "upload");
  assert.deepEqual(options.query, {
    uploadType: "multipart",
    supportsAllDrives: true,
    fields: DRIVE_FILE_FIELDS
  });
  assert.equal(options.method, "POST");
  assert.equal(options.retryMode, "never");
  assert.equal(options.body instanceof Blob, true);
  assert.equal(
    options.headers["Content-Type"],
    options.body.type
  );
  assert.equal(
    options.headers["X-Goog-Drive-Resource-Keys"],
    "folder-1/folder-key"
  );
  assert.equal(Object.hasOwn(options.headers, "Content-Length"), false);
  const body = await options.body.text();
  const metadataAt = body.indexOf(JSON.stringify({
    name: "report.txt",
    parents: ["folder-1"]
  }));
  const mediaAt = body.indexOf("file data");
  assert.equal(metadataAt > 0, true);
  assert.equal(mediaAt > metadataAt, true);
  assert.match(body, /Content-Type: application\/json; charset=UTF-8/u);
  assert.match(body, /Content-Type: text\/plain/u);
});

test("starts a resource-key resumable upload session", async () => {
  const sessionUrl =
    "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-key";
  const { calls, client } = createClient(() => new Response(null, {
    status: 200,
    headers: { Location: sessionUrl }
  }));

  await client.startResumableUpload({
    fileId: "file-id",
    metadata: { name: "existing.txt" },
    media: new Blob(["content"]),
    resourceKeys: [{ fileId: "file-id", resourceKey: "file-key" }]
  });

  assert.equal(
    calls[0].options.headers["X-Goog-Drive-Resource-Keys"],
    "file-id/file-key"
  );
});

test("updates a small file with an encoded multipart upload target", async () => {
  const { calls, client } = createClient(() => ({ id: "file/id" }));

  await client.uploadMultipart({
    fileId: "file/id",
    metadata: { name: "new.bin" },
    media: new Blob(["data"])
  });

  assert.equal(calls[0].options.resourcePath, "files/file%2Fid");
  assert.equal(calls[0].options.method, "PATCH");
  assert.match(
    await calls[0].options.body.text(),
    /Content-Type: application\/octet-stream/u
  );
  assert.equal(
    calls[0].options.operation,
    "files.upload.multipart.update"
  );
});

test("starts create and update resumable sessions without replaying initiation", async () => {
  const sessionUrl =
    "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1";
  const { calls, client } = createClient(() => new Response(null, {
    status: 200,
    headers: { Location: sessionUrl }
  }));
  const media = new Blob(["content"], { type: "text/plain" });

  assert.equal(await client.startResumableUpload({
    metadata: { name: "new.txt" },
    media
  }), sessionUrl);
  assert.equal(await client.startResumableUpload({
    fileId: "file/id",
    metadata: { name: "existing.txt" },
    media
  }), sessionUrl);

  assert.deepEqual(calls.map((call) => call.options.method), ["POST", "PATCH"]);
  assert.deepEqual(calls.map((call) => call.options.resourcePath), [
    "files",
    "files/file%2Fid"
  ]);
  for (const { options } of calls) {
    assert.equal(options.endpoint, "upload");
    assert.equal(options.query.uploadType, "resumable");
    assert.equal(options.query.supportsAllDrives, true);
    assert.equal(options.headers["X-Upload-Content-Type"], "text/plain");
    assert.equal(options.headers["X-Upload-Content-Length"], "7");
    assert.equal(Object.hasOwn(options.headers, "Content-Length"), false);
    assert.equal(options.responseType, "response");
    assert.equal(options.retryMode, "never");
  }
});

test("rejects a resumable session outside the Drive upload endpoint", async () => {
  const { client } = createClient(() => new Response(null, {
    status: 200,
    headers: { Location: "https://example.invalid/upload/session" }
  }));

  await assert.rejects(
    client.startResumableUpload({
      metadata: { name: "new.txt" },
      media: new Blob(["content"])
    }),
    (error) => error instanceof GoogleDriveRequestError &&
      error.code === "drive_upload_session_invalid"
  );
});

test("uses the server-confirmed range for resumable chunks", async () => {
  const { calls, client } = createClient(() => new Response(null, {
    status: 308,
    headers: { Range: "bytes=0-3" }
  }));
  const signal = new AbortController().signal;

  assert.deepEqual(await client.sendResumableChunk(
    "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1",
    {
      chunk: new Blob(["12345"], { type: "text/plain" }),
      start: 0,
      total: 10,
      signal
    }
  ), {
    complete: false,
    nextOffset: 4,
    file: null
  });

  const options = calls[0].options;
  assert.equal(options.method, "PUT");
  assert.equal(options.headers["Content-Type"], "text/plain");
  assert.equal(options.headers["Content-Range"], "bytes 0-4/10");
  assert.equal(Object.hasOwn(options.headers, "Content-Length"), false);
  assert.equal(options.retryMode, "never");
  assert.deepEqual(options.acceptedStatuses, [308]);
  assert.equal(options.signal, signal);
});

test("treats a missing resumable Range header as no confirmed bytes", async () => {
  const { client } = createClient(() => new Response(null, { status: 308 }));

  assert.deepEqual(await client.sendResumableChunk(
    "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1",
    { chunk: new Blob(["12345"]), start: 0, total: 10 }
  ), {
    complete: false,
    nextOffset: 0,
    file: null
  });
});

test("returns final metadata from a completed resumable chunk", async () => {
  const { client } = createClient(() => new Response(
    JSON.stringify({ id: "file-1", name: "done.bin" }),
    { status: 201, headers: { "Content-Type": "application/json" } }
  ));

  assert.deepEqual(await client.sendResumableChunk(
    "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1",
    { chunk: new Blob(["12345"]), start: 5, total: 10 }
  ), {
    complete: true,
    nextOffset: 10,
    file: { id: "file-1", name: "done.bin" }
  });
});

test("keeps an abort raised while reading final upload metadata", async () => {
  const controller = new AbortController();
  const abort = new DOMException("stopped", "AbortError");
  const { client } = createClient(() => ({
    status: 200,
    headers: new Headers(),
    async json() {
      controller.abort(abort);
      throw abort;
    }
  }));

  await assert.rejects(
    client.sendResumableChunk(
      "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1",
      {
        chunk: new Blob(["12345"]),
        start: 0,
        total: 5,
        signal: controller.signal
      }
    ),
    (error) => error === abort
  );
});

test("rejects impossible resumable server ranges", async () => {
  const { client } = createClient(() => new Response(null, {
    status: 308,
    headers: { Range: "bytes=0-99" }
  }));

  await assert.rejects(
    client.sendResumableChunk(
      "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1",
      { chunk: new Blob(["12345"]), start: 0, total: 10 }
    ),
    (error) => error instanceof GoogleDriveRequestError &&
      error.code === "drive_upload_range_invalid"
  );
});

test("queries resumable state with an idempotent empty upload request", async () => {
  const { calls, client } = createClient(() => new Response(null, {
    status: 308,
    headers: { Range: "bytes=0-6" }
  }));

  assert.deepEqual(await client.queryResumableUpload(
    "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1",
    { total: 10 }
  ), {
    complete: false,
    nextOffset: 7,
    file: null
  });

  assert.equal(calls[0].options.method, "PUT");
  assert.deepEqual(calls[0].options.headers, {
    "Content-Range": "bytes */10"
  });
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.retryMode, "always");
  assert.deepEqual(calls[0].options.acceptedStatuses, [308]);
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
