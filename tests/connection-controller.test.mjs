/**
 * VFS connection page controller tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectionControllerError,
  connectionAccountViewModels,
  connectionErrorMessageKey,
  createConnectionController,
  parseConnectionContext
} from "../src/connection/connection-controller.mjs";

function createHarness({ context, responses = {} }) {
  const calls = [];
  const messages = [];
  let closeCount = 0;
  const controller = createConnectionController({
    context,
    sendMessage: async (message) => {
      messages.push(message);
      const response = responses[message.type];
      return typeof response === "function" ? response(message) : response;
    },
    getMessage: (key, substitutions = []) =>
      `translated:${key}:${substitutions.join("|")}`,
    view: {
      clearFeedback: () => calls.push(["feedback", "clear"]),
      render: (value) => calls.push(["render", value]),
      setBusy: (value) => calls.push(["busy", value]),
      setFeedback: (value) => calls.push(["feedback", value])
    },
    closeWindow: () => {
      closeCount += 1;
    }
  });
  return {
    calls,
    controller,
    get closeCount() {
      return closeCount;
    },
    messages
  };
}

const setupContext = Object.freeze({
  mode: "setup",
  addonId: "consumer@example.invalid",
  addonName: "Example consumer",
  setupToken: "setup-token",
  storageId: undefined
});

const configContext = Object.freeze({
  mode: "config",
  addonId: "consumer@example.invalid",
  addonName: "consumer@example.invalid",
  setupToken: undefined,
  storageId: "storage-1"
});

test("parses setup and configuration requests from Toolkit popup URLs", () => {
  assert.deepEqual(parseConnectionContext(
    "?addonId=consumer%40example.invalid&addonName=Example+consumer&setupToken=token",
    "setup"
  ), {
    mode: "setup",
    addonId: "consumer@example.invalid",
    addonName: "Example consumer",
    setupToken: "token",
    storageId: undefined
  });
  assert.deepEqual(parseConnectionContext(
    "?addonId=consumer%40example.invalid&storageId=storage-1",
    "config"
  ), configContext);

  for (const [search, mode] of [
    ["?setupToken=token", "setup"],
    ["?addonId=consumer%40example.invalid", "setup"],
    ["?addonId=consumer%40example.invalid", "config"],
    ["?addonId=consumer%40example.invalid&storageId=storage-1", "other"]
  ]) {
    assert.throws(
      () => parseConnectionContext(search, mode),
      (error) => error instanceof ConnectionControllerError &&
        error.code === "connection_request_invalid"
    );
  }
});

test("builds connection account choices without authorization data", () => {
  const accounts = connectionAccountViewModels([
    {
      id: "account-1",
      displayName: "Ada Example",
      emailAddress: "ada@example.invalid",
      status: "connected",
      refreshToken: "must-not-pass"
    },
    {
      id: "account-2",
      emailAddress: "reauth@example.invalid",
      status: "reauthorization_required"
    }
  ], (key) => `translated:${key}`);

  assert.deepEqual(accounts, [
    {
      id: "account-1",
      label: "Ada Example — ada@example.invalid",
      connectionLabel: "ada@example.invalid",
      connected: true
    },
    {
      id: "account-2",
      label: "reauth@example.invalid",
      connectionLabel: "reauth@example.invalid",
      connected: false
    }
  ]);
  assert.equal(JSON.stringify(accounts).includes("must-not-pass"), false);
});

test("loads accounts and proposes a name for a new connection", async () => {
  const harness = createHarness({
    context: setupContext,
    responses: {
      "googleDrive:accounts:list": {
        ok: true,
        value: [
          {
            id: "account-1",
            displayName: "Ada Example",
            emailAddress: "ada@example.invalid",
            status: "connected"
          }
        ]
      }
    }
  });

  const model = await harness.controller.refresh();

  assert.deepEqual(harness.messages, [{ type: "googleDrive:accounts:list" }]);
  assert.equal(model.selectedAccountId, "account-1");
  assert.equal(
    model.name,
    "translated:vfsConnectionDefaultName:ada@example.invalid"
  );
  assert.equal(
    model.addonLabel,
    "Example consumer (consumer@example.invalid)"
  );
  assert.deepEqual(harness.calls.at(-1), ["busy", false]);
});

test("loads the stored account and name when configuring a connection", async () => {
  const harness = createHarness({
    context: configContext,
    responses: {
      "googleDrive:accounts:list": {
        ok: true,
        value: [
          { id: "account-1", status: "connected" },
          { id: "account-2", status: "connected" }
        ]
      },
      "googleDrive:vfs:connection:get": {
        ok: true,
        value: {
          accountId: "account-2",
          addonName: "Example consumer",
          name: "Project Drive"
        }
      }
    }
  });

  const model = await harness.controller.refresh();

  assert.equal(model.selectedAccountId, "account-2");
  assert.equal(
    model.addonLabel,
    "Example consumer (consumer@example.invalid)"
  );
  assert.equal(model.name, "Project Drive");
  assert.deepEqual(harness.messages.map(({ type }) => type).sort(), [
    "googleDrive:accounts:list",
    "googleDrive:vfs:connection:get"
  ]);
  assert.deepEqual(harness.messages.find(({ type }) =>
    type === "googleDrive:vfs:connection:get"), {
    type: "googleDrive:vfs:connection:get",
    addonId: "consumer@example.invalid",
    storageId: "storage-1"
  });
});

test("adds a setup connection and closes only after it is reported", async () => {
  const created = {
    storageId: "storage-2",
    accountId: "account-1",
    name: "Work Drive"
  };
  const harness = createHarness({
    context: setupContext,
    responses: {
      "googleDrive:vfs:connection:create": { ok: true, value: created }
    }
  });

  assert.deepEqual(await harness.controller.submit({
    accountId: "account-1",
    name: "Work Drive"
  }), created);
  assert.deepEqual(harness.messages, [{
    type: "googleDrive:vfs:connection:create",
    addonId: "consumer@example.invalid",
    addonName: "Example consumer",
    accountId: "account-1",
    name: "Work Drive",
    setupToken: "setup-token"
  }]);
  assert.equal(harness.closeCount, 1);
});

test("updates a configured connection without setup-only fields", async () => {
  const harness = createHarness({
    context: configContext,
    responses: {
      "googleDrive:vfs:connection:update": {
        ok: true,
        value: { storageId: "storage-1" }
      }
    }
  });

  await harness.controller.submit({
    accountId: "account-2",
    name: "Personal Drive"
  });

  assert.deepEqual(harness.messages, [{
    type: "googleDrive:vfs:connection:update",
    addonId: "consumer@example.invalid",
    accountId: "account-2",
    name: "Personal Drive",
    storageId: "storage-1"
  }]);
  assert.equal(harness.closeCount, 1);
});

test("keeps the popup open and shows connection failures", async () => {
  assert.equal(
    connectionErrorMessageKey("connection_account_unavailable"),
    "vfsConnectionErrorAccountUnavailable"
  );
  assert.equal(
    connectionErrorMessageKey("oauth_request_timeout"),
    "vfsErrorNetworkDescription"
  );
  assert.equal(
    connectionErrorMessageKey("oauth_managed_policy_invalid"),
    "optionsErrorOAuthPolicyInvalid"
  );
  assert.equal(
    connectionErrorMessageKey("unknown"),
    "vfsConnectionErrorUnexpected"
  );
  const harness = createHarness({
    context: setupContext,
    responses: {
      "googleDrive:vfs:connection:create": {
        ok: false,
        errorCode: "connection_account_unavailable"
      }
    }
  });

  assert.equal(await harness.controller.submit({
    accountId: "account-1",
    name: "Work Drive"
  }), null);
  assert.equal(harness.closeCount, 0);
  assert.deepEqual(harness.calls.at(-2), [
    "feedback",
    {
      kind: "error",
      text: "translated:vfsConnectionErrorAccountUnavailable:"
    }
  ]);
  assert.deepEqual(harness.calls.at(-1), ["busy", false]);
});

test("signs in an account and selects it on refresh", async () => {
  let accountList = [];
  const harness = createHarness({
    context: setupContext,
    responses: {
      "googleDrive:account:authorize": {
        ok: true,
        value: { id: "account-3" }
      },
      "googleDrive:accounts:list": () => ({
        ok: true,
        value: accountList
      })
    }
  });
  accountList = [{
    id: "account-3",
    emailAddress: "new@example.invalid",
    status: "connected"
  }];

  const model = await harness.controller.authorize();

  assert.equal(model.selectedAccountId, "account-3");
  assert.deepEqual(harness.messages.map(({ type }) => type), [
    "googleDrive:account:authorize",
    "googleDrive:accounts:list"
  ]);
});
