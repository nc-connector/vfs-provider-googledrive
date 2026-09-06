/**
 * Diagnostic logger tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderLogger,
  sanitizeLogDetails
} from "../src/core/logger.mjs";

function createConsoleRecorder() {
  const calls = [];
  return {
    calls,
    consoleApi: Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [
      level,
      (...args) => calls.push({ level, args })
    ]))
  };
}

test("keeps only operation-safe diagnostic fields", () => {
  const details = sanitizeLogDetails({
    operation: "write_file",
    phase: "uploading",
    bytes: 2048,
    percent: 25,
    connections: 2,
    accessToken: "secret-token",
    authorization: "Bearer secret-token",
    path: "/private/report.pdf",
    emailAddress: "ada@example.invalid",
    url: "https://example.invalid/private"
  });

  assert.deepEqual(details, {
    operation: "write_file",
    phase: "uploading",
    bytes: 2048,
    percent: 25,
    connections: 2
  });
});

test("redacts free text placed in an otherwise safe field", () => {
  const details = sanitizeLogDetails({
    status: "failed for /private/report.pdf",
    errorCode: "E:AUTH"
  });

  assert.deepEqual(details, {
    status: "[redacted]",
    errorCode: "E:AUTH"
  });
});

test("logs error shape without logging the error message", () => {
  const { calls, consoleApi } = createConsoleRecorder();
  const logger = new ProviderLogger({ consoleApi });
  const error = new Error("Request failed for ada@example.invalid with token-secret");
  error.name = "DriveApiError";
  error.code = "E:PROVIDER";
  error.status = 503;

  logger.error("drive.request.failed", { error, attempt: 3 });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    level: "error",
    args: ["[GDRVFS]", "drive.request.failed", {
      errorName: "DriveApiError",
      errorCode: "E:PROVIDER",
      httpStatus: 503,
      attempt: 3
    }]
  });
  assert.equal(JSON.stringify(calls).includes("ada@example.invalid"), false);
  assert.equal(JSON.stringify(calls).includes("token-secret"), false);
});

test("emits debug entries only after debug logging is enabled", () => {
  const { calls, consoleApi } = createConsoleRecorder();
  const logger = new ProviderLogger({ consoleApi });

  logger.debug("drive.request.start", { operation: "list" });
  logger.setDebugEnabled(true);
  logger.debug("drive.request.start", { operation: "list" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].level, "debug");
});
