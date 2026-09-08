/**
 * Abort signal for one network request with a removable deadline.
 */

"use strict";

function requirePositiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(name);
  }
  return value;
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException("request_aborted", "AbortError");
}

function defaultScheduleTimeout(callback, timeoutMs) {
  return globalThis.setTimeout(callback, timeoutMs);
}

function defaultCancelTimeout(timerId) {
  globalThis.clearTimeout(timerId);
}

export class RequestTimeoutError extends Error {
  constructor(timeoutMs) {
    super("request_timeout");
    this.name = "RequestTimeoutError";
    this.code = "request_timeout";
    this.timeoutMs = timeoutMs;
  }
}

export class RequestDeadline {
  #sourceSignal;
  #timeoutController = new AbortController();
  #timeoutError = null;
  #timerId;
  #cancelTimeout;
  #timeoutActive = true;

  constructor({
    signal,
    timeoutMs,
    scheduleTimeout = defaultScheduleTimeout,
    cancelTimeout = defaultCancelTimeout
  }) {
    if (signal !== undefined &&
        (typeof signal !== "object" || typeof signal.aborted !== "boolean")) {
      throw new TypeError("signal");
    }
    if (typeof scheduleTimeout !== "function" ||
        typeof cancelTimeout !== "function") {
      throw new TypeError("timerDependencies");
    }
    const normalizedTimeoutMs = requirePositiveNumber(timeoutMs, "timeoutMs");
    this.#sourceSignal = signal;
    this.#cancelTimeout = cancelTimeout;
    this.signal = signal
      ? AbortSignal.any([signal, this.#timeoutController.signal])
      : this.#timeoutController.signal;
    this.#timerId = scheduleTimeout(() => {
      if (!this.#timeoutActive || this.signal.aborted) {
        return;
      }
      this.#timeoutActive = false;
      this.#timeoutError = new RequestTimeoutError(normalizedTimeoutMs);
      this.#timeoutController.abort(this.#timeoutError);
    }, normalizedTimeoutMs);
  }

  stopTimeout() {
    this.#timeoutActive = false;
    if (this.#timerId !== undefined) {
      this.#cancelTimeout(this.#timerId);
      this.#timerId = undefined;
    }
  }

  throwIfTimedOut() {
    if (this.#timeoutError) {
      throw this.#timeoutError;
    }
  }

  normalizeError(error) {
    if (this.#timeoutError) {
      return this.#timeoutError;
    }
    if (this.#sourceSignal?.aborted) {
      return abortReason(this.#sourceSignal);
    }
    return error;
  }
}
