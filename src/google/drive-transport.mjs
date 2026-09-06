/**
 * Authenticated Google Drive API transport with bounded retries.
 */

"use strict";

const DRIVE_ENDPOINT_ROOTS = Object.freeze({
  api: "https://www.googleapis.com/drive/v3/",
  upload: "https://www.googleapis.com/upload/drive/v3/"
});
const DRIVE_UPLOAD_PATH_PREFIX = "/upload/drive/v3/";
const RETRYABLE_FORBIDDEN_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded"
]);
const RESPONSE_TYPES = new Set(["blob", "json", "response"]);
const RETRY_MODES = new Set(["safe", "always", "never"]);
const SAFE_RETRY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const EXTRA_SUCCESS_STATUSES = new Set([308]);

function abortError(signal) {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException("drive_request_aborted", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function isAbortError(error, signal) {
  return Boolean(signal?.aborted) || error?.name === "AbortError";
}

function defaultSleep(delayMs, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(name);
  }
  return value;
}

function requirePositiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(name);
  }
  return value;
}

function appendQuery(url, query) {
  const entries = query instanceof URLSearchParams
    ? query.entries()
    : Object.entries(query || {});
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

function buildRequestUrl({
  resourcePath,
  query,
  endpoint,
  uploadSessionUrl
}) {
  if (uploadSessionUrl !== undefined) {
    if (resourcePath !== undefined || typeof uploadSessionUrl !== "string" ||
        !uploadSessionUrl) {
      throw new TypeError("uploadSessionUrl");
    }
    const sessionUrl = new URL(uploadSessionUrl);
    if (sessionUrl.origin !== "https://www.googleapis.com" ||
        !sessionUrl.pathname.startsWith(DRIVE_UPLOAD_PATH_PREFIX) ||
        sessionUrl.username || sessionUrl.password || sessionUrl.hash) {
      throw new TypeError("uploadSessionUrl");
    }
    appendQuery(sessionUrl, query);
    return sessionUrl.toString();
  }

  if (typeof resourcePath !== "string" || !resourcePath) {
    throw new TypeError("resourcePath");
  }
  const root = DRIVE_ENDPOINT_ROOTS[endpoint];
  if (!root) {
    throw new TypeError("endpoint");
  }
  const url = new URL(resourcePath, root);
  const expectedPath = new URL(root).pathname;
  if (url.origin !== "https://www.googleapis.com" ||
      !url.pathname.startsWith(expectedPath) || url.username || url.password ||
      url.hash) {
    throw new TypeError("resourcePath");
  }
  appendQuery(url, query);
  return url.toString();
}

function acceptedStatusSet(values) {
  if (!Array.isArray(values) || values.some((status) =>
    !EXTRA_SUCCESS_STATUSES.has(status))) {
    throw new TypeError("acceptedStatuses");
  }
  return new Set(values);
}

async function readErrorPayload(response, signal) {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    return {};
  }
}

function errorReasons(payload) {
  const errors = Array.isArray(payload?.error?.errors)
    ? payload.error.errors
    : [];
  return [...new Set(errors
    .map((item) => item?.reason)
    .filter((reason) => typeof reason === "string"))];
}

function parseRetryAfter(value, now) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const delayMs = Number(trimmed) * 1000;
    return Number.isFinite(delayMs) ? delayMs : null;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return Math.max(0, timestamp - now);
}

function isRetryableStatus(status, reasons) {
  if (status === 429 || (status >= 500 && status <= 599)) {
    return true;
  }
  return status === 403 && reasons.some((reason) =>
    RETRYABLE_FORBIDDEN_REASONS.has(reason));
}

export class GoogleDriveRequestError extends Error {
  constructor(code, {
    status = 0,
    reasons = [],
    retryable = false,
    retryAfterMs = null,
    cause
  } = {}) {
    super(code);
    this.name = "GoogleDriveRequestError";
    this.code = code;
    this.status = status;
    this.reasons = [...reasons];
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export class GoogleDriveTransport {
  #oauthClient;
  #fetch;
  #logger;
  #sleep;
  #now;
  #random;
  #maxRetries;
  #baseDelayMs;
  #maxDelayMs;

  constructor({
    oauthClient,
    fetchApi = fetch,
    logger,
    sleep = defaultSleep,
    now = () => Date.now(),
    random = () => Math.random(),
    maxRetries = 4,
    baseDelayMs = 1000,
    maxDelayMs = 32_000
  }) {
    if (!oauthClient || typeof oauthClient.getAccessToken !== "function") {
      throw new TypeError("oauthClient");
    }
    if (typeof fetchApi !== "function" || typeof sleep !== "function" ||
        typeof now !== "function" || typeof random !== "function") {
      throw new TypeError("transportDependencies");
    }
    this.#oauthClient = oauthClient;
    this.#fetch = fetchApi;
    this.#logger = logger;
    this.#sleep = sleep;
    this.#now = now;
    this.#random = random;
    this.#maxRetries = requireNonNegativeInteger(maxRetries, "maxRetries");
    this.#baseDelayMs = requirePositiveNumber(baseDelayMs, "baseDelayMs");
    this.#maxDelayMs = requirePositiveNumber(maxDelayMs, "maxDelayMs");
  }

  async request(accountId, {
    resourcePath,
    endpoint = "api",
    uploadSessionUrl,
    query,
    method = "GET",
    headers,
    body,
    responseType = "json",
    signal,
    operation = "request",
    retryMode = "safe",
    acceptedStatuses = []
  }) {
    if (typeof accountId !== "string" || !accountId) {
      throw new TypeError("accountId");
    }
    if (!RESPONSE_TYPES.has(responseType)) {
      throw new TypeError("responseType");
    }
    if (typeof method !== "string" || !method.trim()) {
      throw new TypeError("method");
    }
    if (!RETRY_MODES.has(retryMode)) {
      throw new TypeError("retryMode");
    }

    const accepted = acceptedStatusSet(acceptedStatuses);
    const url = buildRequestUrl({
      resourcePath,
      query,
      endpoint,
      uploadSessionUrl
    });
    const normalizedMethod = method.trim().toUpperCase();
    const canRetry = retryMode === "always" ||
      (retryMode === "safe" && SAFE_RETRY_METHODS.has(normalizedMethod));
    throwIfAborted(signal);
    let accessToken = await this.#oauthClient.getAccessToken(accountId);
    let refreshed = false;
    let retries = 0;

    while (true) {
      throwIfAborted(signal);
      const requestHeaders = new Headers(headers);
      requestHeaders.set("Authorization", `Bearer ${accessToken}`);

      let response;
      try {
        response = await this.#fetch(url, {
          method: normalizedMethod,
          headers: requestHeaders,
          body,
          signal
        });
      } catch (error) {
        if (isAbortError(error, signal)) {
          throw error;
        }
        retries = await this.#handleNetworkFailure(error, {
          canRetry,
          operation,
          retries,
          signal
        });
        continue;
      }

      if (response.status === 401 && !refreshed) {
        this.#logger?.debug?.("drive.request.refresh", {
          httpStatus: response.status,
          operation
        });
        accessToken = await this.#oauthClient.getAccessToken(accountId, {
          forceRefresh: true
        });
        refreshed = true;
        continue;
      }

      if (response.ok || accepted.has(response.status)) {
        try {
          return await this.#readSuccess(response, responseType);
        } catch (error) {
          if (isAbortError(error, signal) ||
              error instanceof GoogleDriveRequestError) {
            throw error;
          }
          retries = await this.#handleNetworkFailure(error, {
            canRetry,
            operation,
            retries,
            signal
          });
          continue;
        }
      }

      const payload = await readErrorPayload(response, signal);
      const reasons = errorReasons(payload);
      const retryable = isRetryableStatus(response.status, reasons);
      const retryAfterMs = parseRetryAfter(
        response.headers.get("Retry-After"),
        this.#now()
      );
      if (canRetry && retryable && retries < this.#maxRetries) {
        const nextRetries = retries + 1;
        const backoffDelayMs = this.#backoffDelay(nextRetries);
        if (retryAfterMs !== null && retryAfterMs > this.#maxDelayMs) {
          this.#logger?.warn?.("drive.request.deferred", {
            attempt: nextRetries + 1,
            httpStatus: response.status,
            operation,
            retryDelayMs: retryAfterMs
          });
          throw new GoogleDriveRequestError("drive_retry_deferred", {
            status: response.status,
            reasons,
            retryable: true,
            retryAfterMs
          });
        }
        retries = nextRetries;
        const delayMs = retryAfterMs === null
          ? backoffDelayMs
          : Math.max(retryAfterMs, backoffDelayMs);
        this.#logger?.warn?.("drive.request.retry", {
          attempt: retries + 1,
          httpStatus: response.status,
          operation,
          retryDelayMs: delayMs
        });
        await this.#wait(delayMs, signal);
        continue;
      }

      const requestError = new GoogleDriveRequestError(
        "drive_request_failed",
        {
          status: response.status,
          reasons,
          retryable: canRetry && retryable,
          retryAfterMs
        }
      );
      this.#logger?.warn?.("drive.request.failed", {
        attempt: retries + 1,
        httpStatus: response.status,
        operation,
        error: requestError
      });
      throw requestError;
    }
  }

  #backoffDelay(retryNumber) {
    const exponential = this.#baseDelayMs * (2 ** (retryNumber - 1));
    const randomValue = this.#random();
    const jitterRatio = Number.isFinite(randomValue)
      ? Math.max(0, Math.min(1, randomValue))
      : 0;
    const jitter = jitterRatio * this.#baseDelayMs;
    return Math.round(Math.min(this.#maxDelayMs, exponential + jitter));
  }

  async #wait(delayMs, signal) {
    throwIfAborted(signal);
    await this.#sleep(delayMs, signal);
    throwIfAborted(signal);
  }

  async #handleNetworkFailure(error, {
    canRetry,
    operation,
    retries,
    signal
  }) {
    if (!canRetry || retries >= this.#maxRetries) {
      const requestError = new GoogleDriveRequestError(
        "drive_network_error",
        { retryable: canRetry, cause: error }
      );
      this.#logger?.warn?.("drive.request.failed", {
        attempt: retries + 1,
        operation,
        error: requestError
      });
      throw requestError;
    }
    const nextRetries = retries + 1;
    const delayMs = this.#backoffDelay(nextRetries);
    this.#logger?.warn?.("drive.request.retry", {
      attempt: nextRetries + 1,
      operation,
      retryDelayMs: delayMs,
      error
    });
    await this.#wait(delayMs, signal);
    return nextRetries;
  }

  async #readSuccess(response, responseType) {
    if (responseType === "response") {
      return response;
    }
    if (responseType === "blob") {
      return await response.blob();
    }
    if (response.status === 204) {
      return null;
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new GoogleDriveRequestError(
        "drive_response_invalid",
        { status: response.status, cause }
      );
    }
  }
}
