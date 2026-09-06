/**
 * Options controller tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  accountViewModels,
  createOptionsController,
  errorMessageKey,
  normalizePreferenceChanges
} from "../src/options/options-controller.mjs";

function createHarness(responses = {}) {
  const messages = [];
  const calls = [];
  const view = {
    renderAccounts: (value) => calls.push(["accounts", value]),
    setBusy: (value) => calls.push(["busy", value]),
    setFeedback: (value) => calls.push(["feedback", value]),
    setPreferences: (value) => calls.push(["preferences", value])
  };
  const controller = createOptionsController({
    sendMessage: async (message) => {
      messages.push(message);
      const response = responses[message.type];
      return typeof response === "function" ? response(message) : response;
    },
    getMessage: (key) => `translated:${key}`,
    view
  });
  return { calls, controller, messages };
}

test("normalizes values before saving provider preferences", () => {
  assert.deepEqual(normalizePreferenceChanges({
    oauthClientId: "  client.apps.googleusercontent.com  ",
    debugLogging: 1,
    exportFormats: {
      document: "docx",
      spreadsheet: "xlsx",
      presentation: "pptx",
      drawing: "pdf"
    }
  }), {
    oauthClientId: "client.apps.googleusercontent.com",
    debugLogging: true,
    exportFormats: {
      document: "docx",
      spreadsheet: "xlsx",
      presentation: "pptx",
      drawing: "pdf"
    }
  });
});

test("builds account rows without exposing authorization data", () => {
  const rows = accountViewModels([
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
  ], (key) => key);

  assert.deepEqual(rows, [
    {
      id: "account-1",
      displayName: "Ada Example",
      emailAddress: "ada@example.invalid",
      status: "connected",
      statusText: "optionsAccountConnected",
      canReauthorize: false
    },
    {
      id: "account-2",
      displayName: "reauth@example.invalid",
      emailAddress: "reauth@example.invalid",
      status: "reauthorization_required",
      statusText: "optionsAccountReauthorizationRequired",
      canReauthorize: true
    }
  ]);
  assert.equal(JSON.stringify(rows).includes("must-not-pass"), false);
});

test("loads preferences and accounts together", async () => {
  const preferences = {
    oauthClientId: "client.apps.googleusercontent.com",
    debugLogging: false,
    exportFormats: {}
  };
  const harness = createHarness({
    "googleDrive:preferences:get": { ok: true, value: preferences },
    "googleDrive:accounts:list": {
      ok: true,
      value: [{ id: "account-1", status: "connected" }]
    }
  });

  const result = await harness.controller.refresh();

  assert.deepEqual(result.preferences, preferences);
  assert.deepEqual(harness.messages.map(({ type }) => type).sort(), [
    "googleDrive:accounts:list",
    "googleDrive:preferences:get"
  ]);
  assert.equal(harness.calls.some(([type]) => type === "preferences"), true);
  assert.equal(harness.calls.some(([type]) => type === "accounts"), true);
});

test("reauthorizes only the selected account", async () => {
  const harness = createHarness({
    "googleDrive:account:authorize": { ok: true, value: { id: "account-2" } },
    "googleDrive:preferences:get": { ok: true, value: { exportFormats: {} } },
    "googleDrive:accounts:list": { ok: true, value: [] }
  });

  assert.equal(await harness.controller.reauthorize("account-2"), true);

  assert.deepEqual(harness.messages[0], {
    type: "googleDrive:account:authorize",
    accountId: "account-2"
  });
  assert.deepEqual(harness.calls.at(-2), [
    "feedback",
    {
      kind: "success",
      text: "translated:optionsAccountReauthorized"
    }
  ]);
  assert.deepEqual(harness.calls.at(-1), ["busy", false]);
});

test("maps known and unknown OAuth errors to user-facing messages", async () => {
  assert.equal(
    errorMessageKey("oauth_account_mismatch"),
    "optionsErrorOAuthAccountMismatch"
  );
  assert.equal(errorMessageKey("unknown"), "optionsErrorOAuthGeneric");

  const harness = createHarness({
    "googleDrive:account:authorize": {
      ok: false,
      errorCode: "oauth_account_mismatch"
    }
  });
  assert.equal(await harness.controller.authorize(), false);
  assert.deepEqual(harness.calls.at(-2), [
    "feedback",
    {
      kind: "error",
      text: "translated:optionsErrorOAuthAccountMismatch"
    }
  ]);
});

test("warns when an account is removed locally without revoking Google access", async () => {
  const harness = createHarness({
    "googleDrive:account:disconnect": {
      ok: true,
      value: { accountId: "account-1", revoked: false }
    },
    "googleDrive:preferences:get": { ok: true, value: { exportFormats: {} } },
    "googleDrive:accounts:list": { ok: true, value: [] }
  });

  assert.equal(await harness.controller.disconnect("account-1"), true);
  assert.deepEqual(harness.calls.at(-2), [
    "feedback",
    {
      kind: "warning",
      text: "translated:optionsAccountDisconnectedWithoutRevocation"
    }
  ]);
});

test("keeps a completed account change distinct from a refresh failure", async () => {
  const harness = createHarness({
    "googleDrive:account:authorize": {
      ok: true,
      value: { id: "account-1" }
    },
    "googleDrive:preferences:get": {
      ok: false,
      errorCode: "unexpected_error"
    },
    "googleDrive:accounts:list": { ok: true, value: [] }
  });

  assert.equal(await harness.controller.authorize(), true);
  assert.deepEqual(harness.calls.at(-2), [
    "feedback",
    {
      kind: "error",
      text: "translated:optionsErrorUnexpected"
    }
  ]);
  assert.deepEqual(harness.calls.at(-1), ["busy", false]);
});
