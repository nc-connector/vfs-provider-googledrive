/**
 * Google Drive upload orchestration tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { GoogleDriveRequestError } from "../src/google/drive-transport.mjs";
import {
  DIRECT_UPLOAD_LIMIT_BYTES,
  GoogleDriveUploader,
  RESUMABLE_CHUNK_BYTES
} from "../src/google/drive-uploader.mjs";

const SESSION_URL =
  "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1";
const TEST_CHUNK_BYTES = 256 * 1024;

function requestError(code, options) {
  return new GoogleDriveRequestError(code, options);
}

function createHarness({
  uploadMultipart,
  startResumableUpload,
  sendResumableChunk,
  queryResumableUpload,
  uploaderOptions = {}
} = {}) {
  const calls = [];
  const delays = [];
  const apiClient = {
    async uploadMultipart(options) {
      calls.push({ method: "uploadMultipart", options });
      return uploadMultipart
        ? uploadMultipart(options, calls)
        : { id: "multipart-file" };
    },
    async startResumableUpload(options) {
      calls.push({ method: "startResumableUpload", options });
      return startResumableUpload
        ? startResumableUpload(options, calls)
        : SESSION_URL;
    },
    async sendResumableChunk(sessionUrl, options) {
      calls.push({ method: "sendResumableChunk", sessionUrl, options });
      return sendResumableChunk
        ? sendResumableChunk(options, calls)
        : { complete: true, nextOffset: options.total, file: { id: "file-1" } };
    },
    async queryResumableUpload(sessionUrl, options) {
      calls.push({ method: "queryResumableUpload", sessionUrl, options });
      return queryResumableUpload
        ? queryResumableUpload(options, calls)
        : { complete: false, nextOffset: 0, file: null };
    }
  };
  const uploader = new GoogleDriveUploader({
    apiClient,
    chunkBytes: TEST_CHUNK_BYTES,
    sleep: async (delayMs, signal) => {
      delays.push(delayMs);
      if (uploaderOptions.onSleep) {
        await uploaderOptions.onSleep(delayMs, signal);
      }
    },
    random: () => 0,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    ...uploaderOptions
  });
  return { calls, delays, uploader };
}

test("uses the documented multipart and resumable upload constants", () => {
  assert.equal(DIRECT_UPLOAD_LIMIT_BYTES, 5_000_000);
  assert.equal(RESUMABLE_CHUNK_BYTES, 8 * 1024 * 1024);
  assert.equal(RESUMABLE_CHUNK_BYTES % (256 * 1024), 0);
});

test("uses multipart through the direct limit and reports empty files complete", async () => {
  const { calls, uploader } = createHarness({
    uploaderOptions: { directUploadLimitBytes: 5 }
  });
  const emptyProgress = [];
  const limitProgress = [];

  await uploader.upload({
    file: new Blob([]),
    metadata: { name: "empty.txt" },
    onProgress: (percent) => emptyProgress.push(percent)
  });
  await uploader.upload({
    file: new Blob(["12345"]),
    metadata: { name: "limit.txt" },
    onProgress: (percent) => limitProgress.push(percent)
  });

  assert.deepEqual(calls.map((call) => call.method), [
    "uploadMultipart",
    "uploadMultipart"
  ]);
  assert.deepEqual(emptyProgress, [0, 100]);
  assert.deepEqual(limitProgress, [0, 100]);
});

test("uses resumable upload above the direct limit", async () => {
  const progress = [];
  const { calls, uploader } = createHarness({
    uploaderOptions: { directUploadLimitBytes: 5 }
  });

  assert.deepEqual(await uploader.upload({
    file: new Blob(["123456"]),
    metadata: { name: "large.bin" },
    existingFileId: "existing-1",
    onProgress: (percent) => progress.push(percent)
  }), { id: "file-1" });

  assert.deepEqual(calls.map((call) => call.method), [
    "startResumableUpload",
    "sendResumableChunk"
  ]);
  assert.equal(calls[0].options.fileId, "existing-1");
  assert.equal(calls[1].options.start, 0);
  assert.equal(calls[1].options.total, 6);
  assert.deepEqual(progress, [0, 100]);
});

test("continues resumable uploads from server-confirmed byte offsets", async () => {
  const starts = [];
  const progress = [];
  const file = new Blob([new Uint8Array(600_000)]);
  const { uploader } = createHarness({
    sendResumableChunk(options) {
      starts.push(options.start);
      if (starts.length === 1) {
        return { complete: false, nextOffset: 131_072, file: null };
      }
      if (starts.length === 2) {
        return { complete: false, nextOffset: 393_216, file: null };
      }
      return { complete: true, nextOffset: file.size, file: { id: "done" } };
    },
    uploaderOptions: { directUploadLimitBytes: 1 }
  });

  assert.deepEqual(await uploader.upload({
    file,
    metadata: { name: "large.bin" },
    onProgress: (percent) => progress.push(percent)
  }), { id: "done" });

  assert.deepEqual(starts, [0, 131_072, 393_216]);
  assert.deepEqual(progress, [0, 21, 65, 100]);
});

test("queries resumable state after an unknown chunk outcome", async () => {
  const order = [];
  const starts = [];
  let sends = 0;
  const file = new Blob([new Uint8Array(400_000)]);
  const { delays, uploader } = createHarness({
    sendResumableChunk(options) {
      order.push("send");
      starts.push(options.start);
      sends++;
      if (sends === 1) {
        throw requestError("drive_network_error");
      }
      return { complete: true, nextOffset: file.size, file: { id: "done" } };
    },
    queryResumableUpload() {
      order.push("query");
      return { complete: false, nextOffset: 100_000, file: null };
    },
    uploaderOptions: { directUploadLimitBytes: 1 }
  });

  assert.deepEqual(await uploader.upload({
    file,
    metadata: { name: "large.bin" }
  }), { id: "done" });

  assert.deepEqual(order, ["send", "query", "send"]);
  assert.deepEqual(starts, [0, 100_000]);
  assert.deepEqual(delays, [100]);
});

test("accepts a completed status probe after a lost chunk response", async () => {
  const progress = [];
  const { calls, uploader } = createHarness({
    sendResumableChunk() {
      throw requestError("drive_network_error");
    },
    queryResumableUpload() {
      return {
        complete: true,
        nextOffset: 10,
        file: { id: "completed-by-server" }
      };
    },
    uploaderOptions: { directUploadLimitBytes: 1 }
  });

  assert.deepEqual(await uploader.upload({
    file: new Blob(["1234567890"]),
    metadata: { name: "large.bin" },
    onProgress: (percent) => progress.push(percent)
  }), { id: "completed-by-server" });
  assert.deepEqual(calls.map((call) => call.method), [
    "startResumableUpload",
    "sendResumableChunk",
    "queryResumableUpload"
  ]);
  assert.deepEqual(progress, [0, 100]);
});

test("restarts one rejected resumable session and does not restart twice", async () => {
  let sessionStarts = 0;
  let sends = 0;
  const { calls, uploader } = createHarness({
    startResumableUpload() {
      sessionStarts++;
      return `${SESSION_URL}-${sessionStarts}`;
    },
    sendResumableChunk() {
      sends++;
      if (sends <= 2) {
        throw requestError("drive_request_failed", { status: 410 });
      }
      return { complete: true, nextOffset: 10, file: { id: "done" } };
    },
    uploaderOptions: {
      directUploadLimitBytes: 1,
      maxSessionRestarts: 1
    }
  });

  await assert.rejects(
    uploader.upload({
      file: new Blob(["1234567890"]),
      metadata: { name: "large.bin" }
    }),
    (error) => error instanceof GoogleDriveRequestError &&
      error.code === "drive_upload_session_unavailable"
  );
  assert.equal(sessionStarts, 2);
  assert.deepEqual(calls.map((call) => call.method), [
    "startResumableUpload",
    "sendResumableChunk",
    "startResumableUpload",
    "sendResumableChunk"
  ]);
});

test("stops after the resumable recovery budget", async () => {
  const { calls, delays, uploader } = createHarness({
    sendResumableChunk() {
      throw requestError("drive_network_error");
    },
    queryResumableUpload() {
      throw requestError("drive_network_error");
    },
    uploaderOptions: {
      directUploadLimitBytes: 1,
      maxRecoveryAttempts: 2
    }
  });

  await assert.rejects(
    uploader.upload({
      file: new Blob(["1234567890"]),
      metadata: { name: "large.bin" }
    }),
    (error) => error instanceof GoogleDriveRequestError &&
      error.code === "drive_upload_recovery_exhausted"
  );
  assert.deepEqual(delays, [100, 200]);
  assert.equal(
    calls.filter((call) => call.method === "queryResumableUpload").length,
    2
  );
});

test("honors short Retry-After values and defers long waits", async () => {
  const retryError = requestError("drive_request_failed", {
    status: 429,
    retryable: false,
    retryAfterMs: 750
  });
  const short = createHarness({
    sendResumableChunk() {
      throw retryError;
    },
    queryResumableUpload() {
      return { complete: true, nextOffset: 10, file: { id: "done" } };
    },
    uploaderOptions: { directUploadLimitBytes: 1 }
  });

  await short.uploader.upload({
    file: new Blob(["1234567890"]),
    metadata: { name: "large.bin" }
  });
  assert.deepEqual(short.delays, [750]);

  const long = createHarness({
    sendResumableChunk() {
      throw requestError("drive_request_failed", {
        status: 429,
        retryAfterMs: 60_000
      });
    },
    uploaderOptions: { directUploadLimitBytes: 1 }
  });
  await assert.rejects(
    long.uploader.upload({
      file: new Blob(["1234567890"]),
      metadata: { name: "large.bin" }
    }),
    (error) => error instanceof GoogleDriveRequestError &&
      error.code === "drive_retry_deferred" &&
      error.retryAfterMs === 60_000
  );
  assert.deepEqual(long.delays, []);
});

test("aborts during resumable recovery backoff", async () => {
  const controller = new AbortController();
  const { calls, uploader } = createHarness({
    sendResumableChunk() {
      throw requestError("drive_network_error");
    },
    uploaderOptions: {
      directUploadLimitBytes: 1,
      onSleep() {
        controller.abort();
      }
    }
  });

  await assert.rejects(
    uploader.upload({
      file: new Blob(["1234567890"]),
      metadata: { name: "large.bin" },
      signal: controller.signal
    }),
    (error) => error?.name === "AbortError"
  );
  assert.equal(
    calls.some((call) => call.method === "queryResumableUpload"),
    false
  );
});

test("does not retry failed multipart uploads", async () => {
  let uploads = 0;
  const { uploader } = createHarness({
    uploadMultipart() {
      uploads++;
      throw requestError("drive_network_error");
    }
  });

  await assert.rejects(
    uploader.upload({
      file: new Blob(["small"]),
      metadata: { name: "small.txt" }
    }),
    (error) => error instanceof GoogleDriveRequestError &&
      error.code === "drive_network_error"
  );
  assert.equal(uploads, 1);
});
