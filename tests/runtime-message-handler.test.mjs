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
    connectionService: {
      disconnectAccount: async (_accountId, disconnect) => disconnect(),
      getConnection: async (request) => request,
      createConnection: async (request) => request,
      updateConnection: async (request) => request
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

test("checks VFS bindings before disconnecting an account", async () => {
  const calls = [];
  const handler = createHandler({
    oauthClient: {
      disconnectAccount: async (accountId) => {
        calls.push(["oauth", accountId]);
        return { revoked: true };
      }
    },
    connectionService: {
      disconnectAccount: async (accountId, disconnect) => {
        calls.push(["connections", accountId]);
        return disconnect();
      }
    }
  });

  const response = await handler({
    type: "googleDrive:account:disconnect",
    accountId: "account-1"
  }, { id: "provider@example.invalid" });

  assert.deepEqual(calls, [
    ["connections", "account-1"],
    ["oauth", "account-1"]
  ]);
  assert.deepEqual(response, { ok: true, value: { revoked: true } });
});

test("routes VFS connection messages without passing extra fields", async () => {
  const calls = [];
  const connectionService = {
    async getConnection(request) {
      calls.push(["get", request]);
      return request;
    },
    async createConnection(request) {
      calls.push(["create", request]);
      return request;
    },
    async updateConnection(request) {
      calls.push(["update", request]);
      return request;
    }
  };
  const handler = createHandler({ connectionService });
  const sender = { id: "provider@example.invalid" };

  await handler({
    type: "googleDrive:vfs:connection:get",
    addonId: "consumer@example.invalid",
    storageId: "storage-1",
    ignored: "value"
  }, sender);
  await handler({
    type: "googleDrive:vfs:connection:create",
    addonId: "consumer@example.invalid",
    addonName: "Consumer",
    accountId: "account-1",
    name: "Work Drive",
    setupToken: "setup-token",
    ignored: "value"
  }, sender);
  await handler({
    type: "googleDrive:vfs:connection:update",
    addonId: "consumer@example.invalid",
    storageId: "storage-1",
    accountId: "account-2",
    name: "Personal Drive",
    ignored: "value"
  }, sender);

  assert.deepEqual(calls, [
    ["get", {
      addonId: "consumer@example.invalid",
      storageId: "storage-1"
    }],
    ["create", {
      addonId: "consumer@example.invalid",
      addonName: "Consumer",
      accountId: "account-1",
      name: "Work Drive",
      setupToken: "setup-token"
    }],
    ["update", {
      addonId: "consumer@example.invalid",
      storageId: "storage-1",
      accountId: "account-2",
      name: "Personal Drive"
    }]
  ]);
});
