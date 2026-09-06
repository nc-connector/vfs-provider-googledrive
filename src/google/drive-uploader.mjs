/**
 * Multipart and resumable Google Drive uploads.
 */

"use strict";

import { GoogleDriveRequestError } from "./drive-transport.mjs";

export const DIRECT_UPLOAD_LIMIT_BYTES = 5_000_000;
export const RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;

const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded"
]);

function abortError(signal) {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException("drive_upload_aborted", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortError(signal);
  }
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

function requireMethod(value, method) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError("apiClient");
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(name);
  }
  return value;
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(name);
  }
  return value;
}

function requirePositiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(name);
  }
  return value;
}

function normalizedFileId(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !value) {
    throw new TypeError("existingFileId");
  }
  return value;
}

function isAbortError(error, signal) {
  return Boolean(signal?.aborted) || error?.name === "AbortError";
}

function isRateLimitError(error) {
  return error.status === 429 ||
    (error.status === 403 && error.reasons.some((reason) =>
      RATE_LIMIT_REASONS.has(reason)));
}

function sessionMustRestart(error) {
  return error instanceof GoogleDriveRequestError &&
    error.status >= 400 && error.status <= 499 && error.status !== 401 &&
    !isRateLimitError(error);
}

function isRecoverableUploadError(error) {
  if (!(error instanceof GoogleDriveRequestError)) {
    return false;
  }
  if (error.code === "drive_network_error" ||
      error.code === "drive_upload_response_invalid") {
    return true;
  }
  if (error.status === 429 ||
      (error.status >= 500 && error.status <= 599)) {
    return true;
  }
  return isRateLimitError(error);
}

function recoveryError(cause) {
  return new GoogleDriveRequestError("drive_upload_recovery_exhausted", {
    status: cause?.status || 0,
    reasons: cause?.reasons || [],
    retryable: true,
    cause
  });
}

function unavailableSessionError(cause) {
  return new GoogleDriveRequestError("drive_upload_session_unavailable", {
    status: cause?.status || 404,
    reasons: cause?.reasons || [],
    cause
  });
}

export class GoogleDriveUploader {
  #apiClient;
  #logger;
  #sleep;
  #random;
  #directUploadLimitBytes;
  #chunkBytes;
  #maxRecoveryAttempts;
  #maxSessionRestarts;
  #baseDelayMs;
  #maxDelayMs;

  constructor({
    apiClient,
    logger,
    sleep = defaultSleep,
    random = () => Math.random(),
    directUploadLimitBytes = DIRECT_UPLOAD_LIMIT_BYTES,
    chunkBytes = RESUMABLE_CHUNK_BYTES,
    maxRecoveryAttempts = 4,
    maxSessionRestarts = 1,
    baseDelayMs = 1000,
    maxDelayMs = 32_000
  }) {
    for (const method of [
      "uploadMultipart",
      "startResumableUpload",
      "sendResumableChunk",
      "queryResumableUpload"
    ]) {
      requireMethod(apiClient, method);
    }
    if (typeof sleep !== "function" || typeof random !== "function") {
      throw new TypeError("uploadDependencies");
    }
    this.#apiClient = apiClient;
    this.#logger = logger;
    this.#sleep = sleep;
    this.#random = random;
    this.#directUploadLimitBytes = requirePositiveInteger(
      directUploadLimitBytes,
      "directUploadLimitBytes"
    );
    this.#chunkBytes = requirePositiveInteger(chunkBytes, "chunkBytes");
    if (this.#chunkBytes % (256 * 1024) !== 0) {
      throw new RangeError("chunkBytes");
    }
    this.#maxRecoveryAttempts = requirePositiveInteger(
      maxRecoveryAttempts,
      "maxRecoveryAttempts"
    );
    this.#maxSessionRestarts = requireNonNegativeInteger(
      maxSessionRestarts,
      "maxSessionRestarts"
    );
    this.#baseDelayMs = requirePositiveNumber(baseDelayMs, "baseDelayMs");
    this.#maxDelayMs = requirePositiveNumber(maxDelayMs, "maxDelayMs");
  }

  async upload({
    file,
    metadata,
    existingFileId,
    resourceKeys,
    signal,
    onProgress = () => {}
  }) {
    if (!(file instanceof Blob)) {
      throw new TypeError("file");
    }
    if (!metadata || typeof metadata !== "object" ||
        Array.isArray(metadata)) {
      throw new TypeError("metadata");
    }
    const fileId = normalizedFileId(existingFileId);
    if (typeof onProgress !== "function") {
      throw new TypeError("onProgress");
    }
    throwIfAborted(signal);

    const uploadType = file.size <= this.#directUploadLimitBytes
      ? "multipart"
      : "resumable";
    const operation = fileId === null ? "create" : "update";
    const reportProgress = this.#progressReporter(file.size, onProgress);
    reportProgress(0);
    this.#logger?.debug?.("drive.upload.start", {
      bytes: file.size,
      operation,
      phase: uploadType
    });

    const result = uploadType === "multipart"
      ? await this.#uploadMultipart({
          file,
          metadata,
          fileId,
          resourceKeys,
          signal
        })
      : await this.#uploadResumable({
          file,
          metadata,
          fileId,
          resourceKeys,
          signal,
          reportProgress
        });

    reportProgress(file.size, true);
    this.#logger?.debug?.("drive.upload.complete", {
      bytes: file.size,
      operation,
      phase: uploadType
    });
    return result;
  }

  async #uploadMultipart({
    file,
    metadata,
    fileId,
    resourceKeys,
    signal
  }) {
    return this.#apiClient.uploadMultipart({
      fileId,
      metadata,
      media: file,
      resourceKeys,
      signal
    });
  }

  async #uploadResumable({
    file,
    metadata,
    fileId,
    resourceKeys,
    signal,
    reportProgress
  }) {
    let sessionUrl = await this.#startSession({
      file,
      metadata,
      fileId,
      resourceKeys,
      signal
    });
    let offset = 0;
    let recoveryAttempts = 0;
    let sessionRestarts = 0;

    while (true) {
      throwIfAborted(signal);
      if (offset >= file.size) {
        const recovered = await this.#recoverSession({
          sessionUrl,
          total: file.size,
          signal,
          firstAttempt: recoveryAttempts + 1,
          cause: new GoogleDriveRequestError("drive_upload_response_invalid")
        });
        if (recovered.restart) {
          ({ sessionUrl, sessionRestarts } = await this.#restartSession({
            file,
            metadata,
            fileId,
            resourceKeys,
            signal,
            sessionRestarts,
            cause: recovered.cause
          }));
          offset = 0;
          recoveryAttempts = 0;
          continue;
        }
        if (recovered.result.complete) {
          return recovered.result.file;
        }
        offset = recovered.result.nextOffset;
        recoveryAttempts = recovered.attempts;
        reportProgress(offset);
        continue;
      }

      const endOffset = Math.min(offset + this.#chunkBytes, file.size);
      const chunk = file.slice(offset, endOffset, file.type);
      let result;
      try {
        result = await this.#apiClient.sendResumableChunk(sessionUrl, {
          chunk,
          start: offset,
          total: file.size,
          signal
        });
      } catch (error) {
        if (isAbortError(error, signal)) {
          throw error;
        }
        if (sessionMustRestart(error)) {
          ({ sessionUrl, sessionRestarts } = await this.#restartSession({
            file,
            metadata,
            fileId,
            resourceKeys,
            signal,
            sessionRestarts,
            cause: error
          }));
          offset = 0;
          recoveryAttempts = 0;
          continue;
        }
        if (!isRecoverableUploadError(error)) {
          throw error;
        }
        const previousOffset = offset;
        const recovered = await this.#recoverSession({
          sessionUrl,
          total: file.size,
          signal,
          firstAttempt: recoveryAttempts + 1,
          cause: error
        });
        if (recovered.restart) {
          ({ sessionUrl, sessionRestarts } = await this.#restartSession({
            file,
            metadata,
            fileId,
            resourceKeys,
            signal,
            sessionRestarts,
            cause: recovered.cause
          }));
          offset = 0;
          recoveryAttempts = 0;
          continue;
        }
        if (recovered.result.complete) {
          return recovered.result.file;
        }
        offset = recovered.result.nextOffset;
        recoveryAttempts = offset > previousOffset ? 0 : recovered.attempts;
        reportProgress(offset);
        continue;
      }

      if (result.complete) {
        return result.file;
      }
      if (result.nextOffset <= offset) {
        const recovered = await this.#recoverSession({
          sessionUrl,
          total: file.size,
          signal,
          firstAttempt: recoveryAttempts + 1,
          cause: new GoogleDriveRequestError("drive_upload_no_progress", {
            status: 308,
            retryable: true
          })
        });
        if (recovered.restart) {
          ({ sessionUrl, sessionRestarts } = await this.#restartSession({
            file,
            metadata,
            fileId,
            resourceKeys,
            signal,
            sessionRestarts,
            cause: recovered.cause
          }));
          offset = 0;
          recoveryAttempts = 0;
          continue;
        }
        if (recovered.result.complete) {
          return recovered.result.file;
        }
        offset = recovered.result.nextOffset;
        recoveryAttempts = recovered.attempts;
        reportProgress(offset);
        continue;
      }

      offset = result.nextOffset;
      recoveryAttempts = 0;
      reportProgress(offset);
    }
  }

  async #startSession({
    file,
    metadata,
    fileId,
    resourceKeys,
    signal
  }) {
    return this.#apiClient.startResumableUpload({
      fileId,
      metadata,
      media: file,
      resourceKeys,
      signal
    });
  }

  async #restartSession({
    file,
    metadata,
    fileId,
    resourceKeys,
    signal,
    sessionRestarts,
    cause
  }) {
    if (sessionRestarts >= this.#maxSessionRestarts) {
      throw unavailableSessionError(cause);
    }
    const nextRestarts = sessionRestarts + 1;
    this.#logger?.warn?.("drive.upload.session.restart", {
      attempt: nextRestarts
    });
    return {
      sessionUrl: await this.#startSession({
        file,
        metadata,
        fileId,
        resourceKeys,
        signal
      }),
      sessionRestarts: nextRestarts
    };
  }

  async #recoverSession({
    sessionUrl,
    total,
    signal,
    firstAttempt,
    cause
  }) {
    let attempt = firstAttempt;
    let lastError = cause;
    while (attempt <= this.#maxRecoveryAttempts) {
      const delayMs = this.#recoveryDelay(attempt, lastError);
      this.#logger?.warn?.("drive.upload.recover", {
        attempt,
        httpStatus: lastError?.status || 0,
        retryDelayMs: delayMs
      });
      await this.#wait(delayMs, signal);
      try {
        return {
          attempts: attempt,
          restart: false,
          result: await this.#apiClient.queryResumableUpload(sessionUrl, {
            total,
            signal
          })
        };
      } catch (error) {
        if (isAbortError(error, signal)) {
          throw error;
        }
        if (sessionMustRestart(error)) {
          return {
            attempts: attempt,
            cause: error,
            restart: true,
            result: null
          };
        }
        if (!isRecoverableUploadError(error)) {
          throw error;
        }
        lastError = error;
        attempt++;
      }
    }
    throw recoveryError(lastError);
  }

  #backoffDelay(attempt) {
    const exponential = this.#baseDelayMs * (2 ** (attempt - 1));
    const randomValue = this.#random();
    const jitterRatio = Number.isFinite(randomValue)
      ? Math.max(0, Math.min(1, randomValue))
      : 0;
    const jitter = jitterRatio * this.#baseDelayMs;
    return Math.round(Math.min(this.#maxDelayMs, exponential + jitter));
  }

  #recoveryDelay(attempt, error) {
    const retryAfterMs = error?.retryAfterMs;
    if (Number.isFinite(retryAfterMs) && retryAfterMs > this.#maxDelayMs) {
      throw new GoogleDriveRequestError("drive_retry_deferred", {
        status: error.status,
        reasons: error.reasons,
        retryable: true,
        retryAfterMs,
        cause: error
      });
    }
    const backoffDelayMs = this.#backoffDelay(attempt);
    return Number.isFinite(retryAfterMs)
      ? Math.max(retryAfterMs, backoffDelayMs)
      : backoffDelayMs;
  }

  async #wait(delayMs, signal) {
    throwIfAborted(signal);
    await this.#sleep(delayMs, signal);
    throwIfAborted(signal);
  }

  #progressReporter(total, onProgress) {
    let reported = -1;
    return (confirmedBytes, complete = false) => {
      const percent = complete
        ? 100
        : total === 0
          ? 0
          : Math.min(99, Math.floor((confirmedBytes / total) * 100));
      if (percent > reported) {
        reported = percent;
        onProgress(percent);
      }
    };
  }
}
