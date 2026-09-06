/**
 * Privacy-aware diagnostic logging for provider operations.
 */

"use strict";

const LOG_PREFIX = "[GDRVFS]";
const SAFE_DETAIL_KEYS = new Set([
  "attempt",
  "bytes",
  "chunk",
  "chunks",
  "connections",
  "currentFile",
  "driveType",
  "elapsedMs",
  "errorCode",
  "errorName",
  "files",
  "folders",
  "httpStatus",
  "operation",
  "origin",
  "percent",
  "phase",
  "retryDelayMs",
  "status",
  "totalFiles"
]);
const SAFE_TEXT = /^[A-Za-z0-9_.:-]{1,80}$/;

function safeText(value) {
  return typeof value === "string" && SAFE_TEXT.test(value)
    ? value
    : "[redacted]";
}

function safeValue(value) {
  if (typeof value === "string") {
    return safeText(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "boolean" || value === null) {
    return value;
  }
  return "[redacted]";
}

export function sanitizeLogDetails(details = {}) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }

  const safe = {};
  for (const [key, value] of Object.entries(details)) {
    if (key === "error" && value && typeof value === "object") {
      if (value.name) {
        safe.errorName = safeText(value.name);
      }
      if (value.code) {
        safe.errorCode = safeText(String(value.code));
      }
      if (Number.isFinite(value.status)) {
        safe.httpStatus = value.status;
      }
      continue;
    }
    if (SAFE_DETAIL_KEYS.has(key)) {
      safe[key] = safeValue(value);
    }
  }
  return safe;
}

export class ProviderLogger {
  #console;
  #debugEnabled;

  constructor({ consoleApi = console, debugEnabled = false } = {}) {
    this.#console = consoleApi;
    this.#debugEnabled = Boolean(debugEnabled);
  }

  setDebugEnabled(enabled) {
    this.#debugEnabled = Boolean(enabled);
  }

  debug(event, details) {
    if (this.#debugEnabled) {
      this.#write("debug", event, details);
    }
  }

  info(event, details) {
    this.#write("info", event, details);
  }

  warn(event, details) {
    this.#write("warn", event, details);
  }

  error(event, details) {
    this.#write("error", event, details);
  }

  #write(level, event, details) {
    const safeEvent = safeText(event);
    const safeDetails = sanitizeLogDetails(details);
    this.#console[level](LOG_PREFIX, safeEvent, safeDetails);
  }
}
