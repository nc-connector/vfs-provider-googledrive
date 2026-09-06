/**
 * Abort controllers for VFS operations that are currently running.
 */

"use strict";

function requireRequestId(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("requestId must be a non-empty string");
  }
  return value.trim();
}

export class RequestAbortRegistry {
  #controllers = new Map();

  async run(requestId, operation) {
    const normalizedRequestId = requireRequestId(requestId);
    if (typeof operation !== "function") {
      throw new TypeError("operation must be a function");
    }
    if (this.#controllers.has(normalizedRequestId)) {
      throw new Error("A request with this ID is already running");
    }

    const controller = new AbortController();
    this.#controllers.set(normalizedRequestId, controller);
    try {
      return await operation(controller.signal);
    } finally {
      this.#controllers.delete(normalizedRequestId);
    }
  }

  cancel(requestId) {
    const normalizedRequestId = requireRequestId(requestId);
    const controller = this.#controllers.get(normalizedRequestId);
    if (!controller) {
      return false;
    }
    controller.abort(new DOMException("Cancelled", "AbortError"));
    return true;
  }

  has(requestId) {
    return this.#controllers.has(requireRequestId(requestId));
  }
}
