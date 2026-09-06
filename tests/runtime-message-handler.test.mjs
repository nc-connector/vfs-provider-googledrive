/**
 * Internal runtime message handler tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeMessageHandler } from "../src/runtime/message-handler.mjs";

function createHandler(overrides = {}) {
  return createRuntimeMessageHandler({
    extensionId: "provider@example.invalid",
    readiness: Promise.resolve(),
    accountRepository: {
      listAccounts: async () => [{ id: "account-1" }]
    },
    preferencesRepository: {
      get: async () => ({ debugLogging: false }),
      update: async (changes) => changes
    },
    oauthClient: {
      authorize: async () => ({ id: "account-1" }),
      disconnectAccount: async () => ({ revoked: true })
    },
    ...overrides
  });
}

test("ignores unrelated and foreign runtime messages", () => {
  const handler = createHandler();

  assert.equal(handler({ type: "other" }, { id: "provider@example.invalid" }), undefined);
  assert.equal(
    handler({ type: "googleDrive:accounts:list" }, { id: "foreign@example.invalid" }),
    undefined
  );
});

test("returns a promise only for a handled internal message", async () => {
  const handler = createHandler();
  const response = handler(
    { type: "googleDrive:accounts:list" },
    { id: "provider@example.invalid" }
  );

  assert.equal(typeof response?.then, "function");
  assert.deepEqual(await response, {
    ok: true,
    value: [{ id: "account-1" }]
  });
});

test("returns a stable error code without an error message", async () => {
  const handler = createRuntimeMessageHandler({
    extensionId: "provider@example.invalid",
    readiness: Promise.resolve(),
    accountRepository: {
      listAccounts: async () => {
        const error = new Error("private details");
        error.code = "oauth_reauthorization_required";
        throw error;
      }
    },
    preferencesRepository: {},
    oauthClient: {}
  });

  const response = await handler(
    { type: "googleDrive:accounts:list" },
    { id: "provider@example.invalid" }
  );

  assert.deepEqual(response, {
    ok: false,
    errorCode: "oauth_reauthorization_required"
  });
});

test("passes the selected account to a reauthorization request", async () => {
  let authorizationOptions;
  const handler = createHandler({
    oauthClient: {
      authorize: async (options) => {
        authorizationOptions = options;
        return { id: options.accountId };
      }
    }
  });

  const response = await handler(
    {
      type: "googleDrive:account:authorize",
      accountId: "account-2"
    },
    { id: "provider@example.invalid" }
  );

  assert.deepEqual(authorizationOptions, {
    accountId: "account-2",
    interactive: true
  });
  assert.deepEqual(response, {
    ok: true,
    value: { id: "account-2" }
  });
});
