/**
 * Google Drive transport tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  GoogleDriveRequestError,
  GoogleDriveTransport
} from "../src/google/drive-transport.mjs";

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}

function brokenBodyResponse(error, contentType = "application/json") {
  return new Response(new ReadableStream({
    start(controller) {
      controller.error(error);
    }
  }), {
    status: 200,
    headers: { "Content-Type": contentType }
  });
}

function createHarness({
  fetchApi = async () => jsonResponse({ ok: true }),
  maxRetries = 4,
  now = () => 1_000,
  random = () => 0
} = {}) {
  const tokenCalls = [];
  const oauthClient = {
    async getAccessToken(accountId, options) {
      tokenCalls.push({ accountId, options });
      return options?.forceRefresh ? "refreshed-token" : "cached-token";
    }
  };
  const delays = [];
  const logCalls = [];
  const logger = Object.fromEntries(["debug", "warn"].map((level) => [
    level,
    (event, details) => logCalls.push({ level, event, details })
  ]));
  const transport = new GoogleDriveTransport({
    oauthClient,
    fetchApi,
    logger,
    sleep: async (delayMs) => delays.push(delayMs),
    now,
    random,
    maxRetries,
    baseDelayMs: 100,
    maxDelayMs: 10_000
  });
  return { delays, logCalls, oauthClient, tokenCalls, transport };
}

test("sends an authenticated Drive v3 request and returns JSON", async () => {
  const requests = [];
  const harness = createHarness({
    fetchApi: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ id: "result-id" });
    }
  });

  const result = await harness.transport.request("account-1", {
    resourcePath: "files/file%2Fid",
    query: { fields: "id,name", supportsAllDrives: true },
    operation: "files.get"
  });

  assert.deepEqual(result, { id: "result-id" });
  const requestUrl = new URL(requests[0].url);
  assert.equal(requestUrl.origin, "https://www.googleapis.com");
  assert.equal(requestUrl.pathname, "/drive/v3/files/file%2Fid");
  assert.equal(requestUrl.searchParams.get("fields"), "id,name");
  assert.equal(requestUrl.searchParams.get("supportsAllDrives"), "true");
  assert.equal(
    requests[0].options.headers.get("Authorization"),
    "Bearer cached-token"
  );
});

test("returns upload initiation headers from the trusted upload endpoint", async () => {
  const requests = [];
  const sessionUrl = "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1";
  const harness = createHarness({
    fetchApi: async (url, options) => {
      requests.push({ url, options });
      return new Response(null, {
        status: 200,
        headers: { Location: sessionUrl }
      });
    }
  });

  const response = await harness.transport.request("account-1", {
    resourcePath: "files",
    endpoint: "upload",
    query: { uploadType: "resumable" },
    method: "POST",
    body: new Blob(["metadata"]),
    responseType: "response"
  });

  assert.equal(response.headers.get("Location"), sessionUrl);
  const requestUrl = new URL(requests[0].url);
  assert.equal(requestUrl.pathname, "/upload/drive/v3/files");
  assert.equal(requestUrl.searchParams.get("uploadType"), "resumable");
});

test("returns resumable-upload progress from a trusted session URL", async () => {
  const harness = createHarness({
    fetchApi: async () => new Response(null, {
      status: 308,
      headers: { Range: "bytes=0-262143" }
    })
  });

  const response = await harness.transport.request("account-1", {
    uploadSessionUrl: "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1",
    method: "PUT",
    responseType: "response",
    acceptedStatuses: [308]
  });

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("Range"), "bytes=0-262143");
});

test("rejects resumable-upload session URLs outside the Drive upload path", async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.transport.request("account-1", {
      uploadSessionUrl: "https://example.invalid/upload/drive/v3/files?upload_id=session-1",
      method: "PUT",
      responseType: "response"
    }),
    /uploadSessionUrl/
  );
  await assert.rejects(
    harness.transport.request("account-1", {
      uploadSessionUrl: "https://www.googleapis.com/drive/v3/files/file-1",
      method: "PUT",
      responseType: "response"
    }),
    /uploadSessionUrl/
  );
  await assert.rejects(
    harness.transport.request("account-1", {
      resourcePath: "files/file-1",
      responseType: "response",
      acceptedStatuses: [401]
    }),
    /acceptedStatuses/
  );
  assert.equal(harness.tokenCalls.length, 0);
});

test("returns binary responses as Blob objects", async () => {
  const harness = createHarness({
    fetchApi: async () => new Response("file contents", {
      headers: { "Content-Type": "text/plain" }
    })
  });

  const result = await harness.transport.request("account-1", {
    resourcePath: "files/file-1",
    query: { alt: "media" },
    responseType: "blob"
  });

  assert.ok(result instanceof Blob);
  assert.equal(await result.text(), "file contents");
});

test("retries a safe request when reading its JSON body loses the network", async () => {
  let requests = 0;
  const harness = createHarness({
    fetchApi: async () => {
      requests++;
      return requests === 1
        ? brokenBodyResponse(new TypeError("connection reset"))
        : jsonResponse({ id: "file-1" });
    }
  });

  assert.deepEqual(await harness.transport.request("account-1", {
    resourcePath: "files/file-1"
  }), { id: "file-1" });
  assert.equal(requests, 2);
  assert.deepEqual(harness.delays, [100]);
});

test("retries a safe request when reading its binary body loses the network", async () => {
  let requests = 0;
  const harness = createHarness({
    fetchApi: async () => {
      requests++;
      return requests === 1
        ? brokenBodyResponse(new TypeError("connection reset"), "application/octet-stream")
        : new Response("file contents");
    }
  });

  const blob = await harness.transport.request("account-1", {
    resourcePath: "files/file-1",
    responseType: "blob"
  });
  assert.equal(await blob.text(), "file contents");
  assert.equal(requests, 2);
  assert.deepEqual(harness.delays, [100]);
});

test("keeps an abort raised during response reading as an abort", async () => {
  let requests = 0;
  const harness = createHarness({
    fetchApi: async () => {
      requests++;
      return brokenBodyResponse(new DOMException(
        "drive_request_aborted",
        "AbortError"
      ));
    }
  });

  await assert.rejects(
    harness.transport.request("account-1", {
      resourcePath: "files/file-1"
    }),
    (error) => error?.name === "AbortError"
  );
  assert.equal(requests, 1);
  assert.deepEqual(harness.delays, []);
});

test("refreshes the access token once after a 401 response", async () => {
  const authorizationHeaders = [];
  const harness = createHarness({
    fetchApi: async (_url, options) => {
      authorizationHeaders.push(options.headers.get("Authorization"));
      return authorizationHeaders.length === 1
        ? jsonResponse({ error: {} }, 401)
        : jsonResponse({ id: "file-1" });
    }
  });

  const result = await harness.transport.request("account-1", {
    resourcePath: "files/file-1",
    operation: "files.get"
  });

  assert.deepEqual(result, { id: "file-1" });
  assert.deepEqual(authorizationHeaders, [
    "Bearer cached-token",
    "Bearer refreshed-token"
  ]);
  assert.equal(harness.tokenCalls.length, 2);
  assert.deepEqual(harness.tokenCalls[1], {
    accountId: "account-1",
    options: { forceRefresh: true }
  });
});

test("does not refresh repeatedly after a second 401 response", async () => {
  let requests = 0;
  const harness = createHarness({
    fetchApi: async () => {
      requests++;
      return jsonResponse({ error: {} }, 401);
    }
  });

  await assert.rejects(
    harness.transport.request("account-1", { resourcePath: "files/file-1" }),
    (error) => error instanceof GoogleDriveRequestError &&
      error.status === 401 && error.retryable === false
  );
  assert.equal(requests, 2);
  assert.equal(harness.tokenCalls.length, 2);
});

test("retries network failures, quota 403 responses, and 5xx responses", async () => {
  let requests = 0;
  const harness = createHarness({
    maxRetries: 3,
    fetchApi: async () => {
      requests++;
      if (requests === 1) {
        throw new TypeError("network unavailable");
      }
      if (requests === 2) {
        return jsonResponse({
          error: { errors: [{ reason: "userRateLimitExceeded" }] }
        }, 403);
      }
      if (requests === 3) {
        return jsonResponse({ error: {} }, 503);
      }
      return jsonResponse({ ok: true });
    }
  });

  assert.deepEqual(
    await harness.transport.request("account-1", {
      resourcePath: "files",
      operation: "files.list"
    }),
    { ok: true }
  );
  assert.equal(requests, 4);
  assert.deepEqual(harness.delays, [100, 200, 400]);
});

test("honors Retry-After and does not expose the request URL in logs", async () => {
  let requests = 0;
  const harness = createHarness({
    fetchApi: async () => {
      requests++;
      return requests === 1
        ? jsonResponse({ error: {} }, 429, { "Retry-After": "5" })
        : jsonResponse({ files: [] });
    }
  });

  await harness.transport.request("private-account-id", {
    resourcePath: "files/private-file-id",
    query: { q: "name = 'private-name'" },
    operation: "files.list"
  });

  assert.deepEqual(harness.delays, [5000]);
  const serializedLogs = JSON.stringify(harness.logCalls);
  assert.equal(serializedLogs.includes("private-account-id"), false);
  assert.equal(serializedLogs.includes("private-file-id"), false);
  assert.equal(serializedLogs.includes("private-name"), false);
});

test("defers a retry rather than shortening a long Retry-After value", async () => {
  let requests = 0;
  const harness = createHarness({
    fetchApi: async () => {
      requests++;
      return requests === 1
        ? jsonResponse({ error: {} }, 429, { "Retry-After": "3600" })
        : jsonResponse({ files: [] });
    }
  });

  await assert.rejects(
    harness.transport.request("account-1", { resourcePath: "files" }),
    (error) => error instanceof GoogleDriveRequestError &&
      error.code === "drive_retry_deferred" &&
      error.status === 429 &&
      error.retryable === true &&
      error.retryAfterMs === 3_600_000
  );

  assert.equal(requests, 1);
  assert.deepEqual(harness.delays, []);
});

test("retries explicit rate-limit responses for mutating requests", async () => {
  let requests = 0;
  const harness = createHarness({
    fetchApi: async () => {
      requests++;
      if (requests === 1) {
        return jsonResponse({ error: {} }, 429);
      }
      if (requests === 2) {
        return jsonResponse({
          error: { errors: [{ reason: "userRateLimitExceeded" }] }
        }, 403);
      }
      return jsonResponse({ id: "created" });
    }
  });

  assert.deepEqual(await harness.transport.request("account-1", {
    resourcePath: "files",
    method: "POST",
    retryMode: "rate-limit"
  }), { id: "created" });
  assert.equal(requests, 3);
  assert.deepEqual(harness.delays, [100, 200]);
});

test("does not replay mutating requests after uncertain failures", async () => {
  const cases = [
    {
      fetchApi: async () => {
        throw new TypeError("network unavailable");
      },
      code: "drive_network_error",
      status: 0
    },
    {
      fetchApi: async () => jsonResponse({ error: {} }, 503),
      code: "drive_request_failed",
      status: 503
    },
    {
      fetchApi: async () => jsonResponse({
        error: { errors: [{ reason: "insufficientFilePermissions" }] }
      }, 403),
      code: "drive_request_failed",
      status: 403
    }
  ];

  for (const expected of cases) {
    let requests = 0;
    const harness = createHarness({
      fetchApi: async (...args) => {
        requests++;
        return expected.fetchApi(...args);
      }
    });
    await assert.rejects(
      harness.transport.request("account-1", {
        resourcePath: "files",
        method: "POST",
        retryMode: "rate-limit"
      }),
      (error) => error instanceof GoogleDriveRequestError &&
        error.code === expected.code &&
        error.status === expected.status &&
        error.retryable === false
    );
    assert.equal(requests, 1);
    assert.deepEqual(harness.delays, []);
  }
});

test("does not replay a mutation after an invalid success body", async () => {
  let requests = 0;
  const harness = createHarness({
    fetchApi: async () => {
      requests++;
      return new Response("not json", { status: 200 });
    }
  });

  await assert.rejects(
    harness.transport.request("account-1", {
      resourcePath: "files",
      method: "POST",
      retryMode: "rate-limit"
    }),
    (error) => error instanceof GoogleDriveRequestError &&
      error.code === "drive_response_invalid" &&
      error.status === 200
  );
  assert.equal(requests, 1);
  assert.deepEqual(harness.delays, []);
});

test("does not replay a mutation when reading its success body fails", async () => {
  let requests = 0;
  const harness = createHarness({
    fetchApi: async () => {
      requests++;
      return brokenBodyResponse(new TypeError("connection reset"));
    }
  });

  await assert.rejects(
    harness.transport.request("account-1", {
      resourcePath: "files",
      method: "POST",
      retryMode: "rate-limit"
    }),
    (error) => error instanceof GoogleDriveRequestError &&
      error.code === "drive_network_error" &&
      error.retryable === false
  );
  assert.equal(requests, 1);
  assert.deepEqual(harness.delays, []);
});

test("stops after a rate-limit retry ends in an uncertain failure", async () => {
  const finalResponses = [
    async () => {
      throw new TypeError("network unavailable");
    },
    async () => jsonResponse({ error: {} }, 503)
  ];

  for (const finalResponse of finalResponses) {
    let requests = 0;
    const harness = createHarness({
      fetchApi: async () => {
        requests++;
        return requests === 1
          ? jsonResponse({ error: {} }, 429)
          : finalResponse();
      }
    });
    await assert.rejects(
      harness.transport.request("account-1", {
        resourcePath: "files",
        method: "POST",
        retryMode: "rate-limit"
      }),
      (error) => error instanceof GoogleDriveRequestError &&
        error.retryable === false
    );
    assert.equal(requests, 2);
    assert.deepEqual(harness.delays, [100]);
  }
});

test("requires a readable rate-limit reason before repeating a 403 mutation", async () => {
  let requests = 0;
  const harness = createHarness({
    fetchApi: async () => {
      requests++;
      return new Response(new ReadableStream({
        start(controller) {
          controller.error(new TypeError("connection reset"));
        }
      }), { status: 403 });
    }
  });

  await assert.rejects(
    harness.transport.request("account-1", {
      resourcePath: "files",
      method: "POST",
      retryMode: "rate-limit"
    }),
    (error) => error instanceof GoogleDriveRequestError &&
      error.status === 403 && error.retryable === false
  );
  assert.equal(requests, 1);
  assert.deepEqual(harness.delays, []);
});

test("refreshes authorization once for a rejected mutation", async () => {
  const authorizationHeaders = [];
  const harness = createHarness({
    fetchApi: async (_url, options) => {
      authorizationHeaders.push(options.headers.get("Authorization"));
      return authorizationHeaders.length === 1
        ? jsonResponse({ error: {} }, 401)
        : jsonResponse({ id: "created" });
    }
  });

  assert.deepEqual(await harness.transport.request("account-1", {
    resourcePath: "files",
    method: "POST",
    retryMode: "rate-limit"
  }), { id: "created" });
  assert.deepEqual(authorizationHeaders, [
    "Bearer cached-token",
    "Bearer refreshed-token"
  ]);
  assert.deepEqual(harness.delays, []);
});

test("does not retry an unsafe request after an unknown network outcome", async () => {
  let requests = 0;
  const harness = createHarness({
    fetchApi: async () => {
      requests++;
      throw new TypeError("network unavailable");
    }
  });

  await assert.rejects(
    harness.transport.request("account-1", {
      resourcePath: "files",
      method: "POST"
    }),
    (error) => error instanceof GoogleDriveRequestError &&
      error.code === "drive_network_error" && error.retryable === false
  );
  assert.equal(requests, 1);
  assert.deepEqual(harness.delays, []);
});

test("does not retry a 403 without an allowed rate-limit reason", async () => {
  let requests = 0;
  const harness = createHarness({
    fetchApi: async () => {
      requests++;
      return jsonResponse({
        error: { errors: [{ reason: "insufficientFilePermissions" }] }
      }, 403);
    }
  });

  await assert.rejects(
    harness.transport.request("account-1", { resourcePath: "files/file-1" }),
    (error) => error instanceof GoogleDriveRequestError &&
      error.status === 403 &&
      error.retryable === false &&
      error.reasons[0] === "insufficientFilePermissions"
  );
  assert.equal(requests, 1);
  assert.deepEqual(harness.delays, []);
});

test("stops retrying after the configured retry budget", async () => {
  let requests = 0;
  const harness = createHarness({
    maxRetries: 2,
    fetchApi: async () => {
      requests++;
      return jsonResponse({ error: {} }, 500);
    }
  });

  await assert.rejects(
    harness.transport.request("account-1", { resourcePath: "files" }),
    (error) => error instanceof GoogleDriveRequestError &&
      error.status === 500 && error.retryable === true
  );
  assert.equal(requests, 3);
  assert.deepEqual(harness.delays, [100, 200]);
});

test("stops during backoff when the request is aborted", async () => {
  const controller = new AbortController();
  let requests = 0;
  const harness = createHarness({
    fetchApi: async () => {
      requests++;
      return jsonResponse({ error: {} }, 503);
    }
  });
  harness.transport = new GoogleDriveTransport({
    oauthClient: harness.oauthClient,
    fetchApi: async () => {
      requests++;
      return jsonResponse({ error: {} }, 503);
    },
    sleep: async () => controller.abort(),
    random: () => 0
  });

  await assert.rejects(
    harness.transport.request("account-1", {
      resourcePath: "files",
      signal: controller.signal
    }),
    (error) => error?.name === "AbortError"
  );
  assert.equal(requests, 1);
});

test("reports malformed successful JSON as a transport error", async () => {
  const harness = createHarness({
    fetchApi: async () => new Response("not json", { status: 200 })
  });

  await assert.rejects(
    harness.transport.request("account-1", { resourcePath: "about" }),
    (error) => error instanceof GoogleDriveRequestError &&
      error.code === "drive_response_invalid" && error.status === 200
  );
});
