/**
 * Active request cancellation tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { RequestAbortRegistry } from "../src/core/request-aborts.mjs";

test("keeps a controller only while its operation is running", async () => {
  const registry = new RequestAbortRegistry();
  let release;
  const operation = registry.run("request-1", async () => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return "done";
  });

  assert.equal(registry.has("request-1"), true);
  release();
  assert.equal(await operation, "done");
  assert.equal(registry.has("request-1"), false);
});

test("aborts the signal for a running request", async () => {
  const registry = new RequestAbortRegistry();
  const operation = registry.run("request-1", (signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));

  assert.equal(registry.cancel("request-1"), true);
  await assert.rejects(operation, (error) => error?.name === "AbortError");
  assert.equal(registry.has("request-1"), false);
  assert.equal(registry.cancel("request-1"), false);
});

test("removes a request after an operation fails", async () => {
  const registry = new RequestAbortRegistry();

  await assert.rejects(
    registry.run("request-1", async () => {
      throw new Error("failed");
    }),
    /failed/
  );

  assert.equal(registry.has("request-1"), false);
});

test("rejects duplicate active request IDs", async () => {
  const registry = new RequestAbortRegistry();
  let release;
  const first = registry.run("request-1", () => new Promise((resolve) => {
    release = resolve;
  }));

  await assert.rejects(
    registry.run("request-1", async () => {}),
    /already running/
  );
  release();
  await first;
});
