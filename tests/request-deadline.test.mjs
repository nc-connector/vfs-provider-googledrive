/**
 * Request deadline tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  RequestDeadline,
  RequestTimeoutError
} from "../src/core/request-deadline.mjs";

function createHarness({ signal } = {}) {
  let callback;
  const cancelled = [];
  const deadline = new RequestDeadline({
    signal,
    timeoutMs: 30_000,
    scheduleTimeout(next) {
      callback = next;
      return "timer-1";
    },
    cancelTimeout(timerId) {
      cancelled.push(timerId);
    }
  });
  return { callback, cancelled, deadline };
}

test("aborts one request with a typed timeout error", () => {
  const { callback, deadline } = createHarness();

  callback();

  assert.equal(deadline.signal.aborted, true);
  assert.ok(deadline.signal.reason instanceof RequestTimeoutError);
  assert.equal(deadline.signal.reason.timeoutMs, 30_000);
  assert.throws(
    () => deadline.throwIfTimedOut(),
    (error) => error === deadline.signal.reason
  );
  assert.equal(
    deadline.normalizeError(new DOMException("aborted", "AbortError")),
    deadline.signal.reason
  );
});

test("keeps caller cancellation active after removing the deadline", () => {
  const controller = new AbortController();
  const reason = new DOMException("consumer_cancelled", "AbortError");
  const { callback, cancelled, deadline } = createHarness({
    signal: controller.signal
  });

  deadline.stopTimeout();
  callback();
  assert.equal(deadline.signal.aborted, false);
  controller.abort(reason);

  assert.deepEqual(cancelled, ["timer-1"]);
  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.normalizeError(new Error("fetch failed")), reason);
  assert.doesNotThrow(() => deadline.throwIfTimedOut());
});

test("rejects invalid deadline inputs", () => {
  assert.throws(() => new RequestDeadline({ timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => new RequestDeadline({
    timeoutMs: 1,
    signal: {}
  }), /signal/);
  assert.throws(() => new RequestDeadline({
    timeoutMs: 1,
    scheduleTimeout: null
  }), /timerDependencies/);
});
