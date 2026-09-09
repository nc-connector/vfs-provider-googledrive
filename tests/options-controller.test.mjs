/**
 * Options controller tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  accountViewModels,
  connectionViewModels,
  createOptionsController,
  errorMessageKey,
  normalizeOAuthConfigurationChanges,
  normalizePreferenceChanges,
  shouldRefreshForStorageChange
} from "../src/options/options-controller.mjs";

function createHarness(responses = {}) {
  const messages = [];
  const calls = [];
  const view = {
    renderAccounts: (value) => calls.push(["accounts", value]),
    renderConnections: (value) => calls.push(["connections", value]),
    setBusy: (value) => calls.push(["busy", value]),
    setFeedback: (value) => calls.push(["feedback", value]),
    setOAuthConfiguration: (value) => calls.push(["oauth", value]),
    setPreferences: (value) => calls.push(["preferences", value])
  };
  const controller = createOptionsController({
    sendMessage: async (message) => {
      messages.push(message);
      const response = Object.hasOwn(responses, message.type)
        ? responses[message.type]
        : message.type === "googleDrive:vfs:connections:list"
          ? { ok: true, value: [] }
          : message.type === "googleDrive:oauth:configuration:get"
            ? {
                ok: true,
                value: {
                  mode: "builtin",
                  source: "local",
                  locked: false,
                  clientId: "test.apps.googleusercontent.com",
                  hasClientSecret: true,
                  customClientId: "",
                  hasCustomClientSecret: false
                }
              }
          : undefined;
      return typeof response === "function" ? response(message) : response;
    },
    getMessage: (key) => `translated:${key}`,
    view
  });
  return { calls, controller, messages };
}

test("normalizes values before saving provider preferences", () => {
  assert.deepEqual(normalizePreferenceChanges({
    debugLogging: 1,
    exportFormats: {
      document: "docx",
      spreadsheet: "xlsx",
      presentation: "pptx",
      drawing: "pdf"
    }
  }), {
    debugLogging: true,
    exportFormats: {
      document: "docx",
      spreadsheet: "xlsx",
      presentation: "pptx",
      drawing: "pdf"
    }
  });
});

test("normalizes editable OAuth configuration without exposing extra fields", () => {
  assert.deepEqual(normalizeOAuthConfigurationChanges({
    mode: " custom ",
    clientId: " custom.apps.googleusercontent.com ",
    clientSecret: " secret "
  }), {
    mode: "custom",
    clientId: "custom.apps.googleusercontent.com",
    clientSecret: "secret"
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

test("builds connection rows from public account and Toolkit metadata", () => {
  const rows = connectionViewModels([{
    addonId: "consumer@example.invalid",
    addonName: "Example consumer",
    storageId: "storage-1",
    name: "Work Drive",
    accountId: "account-1"
  }], [{
    id: "account-1",
    displayName: "Ada Example",
    emailAddress: "ada@example.invalid",
    refreshToken: "must-not-pass"
  }], (key) => `translated:${key}`);

  assert.deepEqual(rows, [{
    addonId: "consumer@example.invalid",
    addonLabel: "Example consumer (consumer@example.invalid)",
    storageId: "storage-1",
    name: "Work Drive",
    accountLabel: "Ada Example — ada@example.invalid"
  }]);
  assert.equal(JSON.stringify(rows).includes("must-not-pass"), false);
});

test("uses the short provider name when connection metadata has no name", () => {
  const [row] = connectionViewModels([{
    addonId: "consumer@example.invalid",
    storageId: "storage-1",
    name: "",
    accountId: "account-1"
  }], [], (key) => `translated:${key}`);

  assert.equal(row.name, "translated:vfsProviderName");
});

test("refreshes options only for relevant local storage changes", () => {
  assert.equal(shouldRefreshForStorageChange({
    "vfs-toolkit-connections": { oldValue: [], newValue: [] }
  }, "local"), true);
  assert.equal(shouldRefreshForStorageChange({
    "google-drive-provider-state": { oldValue: {}, newValue: {} }
  }, "local"), false);
  assert.equal(shouldRefreshForStorageChange({ unrelated: {} }, "local"), false);
  assert.equal(shouldRefreshForStorageChange({
    "vfs-toolkit-connections": {}
  }, "sync"), false);
});

test("loads preferences and accounts together", async () => {
  const preferences = {
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
    "googleDrive:oauth:configuration:get",
    "googleDrive:preferences:get",
    "googleDrive:vfs:connections:list"
  ]);
  assert.equal(harness.calls.some(([type]) => type === "preferences"), true);
  assert.equal(harness.calls.some(([type]) => type === "oauth"), true);
  assert.equal(harness.calls.some(([type]) => type === "accounts"), true);
});

test("saves an editable OAuth client and reloads derived account state", async () => {
  const configuration = {
    mode: "custom",
    source: "local",
    locked: false,
    clientId: "custom.apps.googleusercontent.com",
    hasClientSecret: true,
    customClientId: "custom.apps.googleusercontent.com",
    hasCustomClientSecret: true
  };
  const harness = createHarness({
    "googleDrive:oauth:configuration:update": {
      ok: true,
      value: configuration
    },
    "googleDrive:oauth:configuration:get": {
      ok: true,
      value: configuration
    },
    "googleDrive:preferences:get": {
      ok: true,
      value: { debugLogging: false, exportFormats: {} }
    },
    "googleDrive:accounts:list": { ok: true, value: [] }
  });

  assert.deepEqual(await harness.controller.saveOAuthConfiguration({
    mode: " custom ",
    clientId: " custom.apps.googleusercontent.com ",
    clientSecret: " secret "
  }), configuration);
  assert.deepEqual(harness.messages[0], {
    type: "googleDrive:oauth:configuration:update",
    changes: {
      mode: "custom",
      clientId: "custom.apps.googleusercontent.com",
      clientSecret: "secret"
    }
  });
  assert.deepEqual(harness.calls.at(-2), [
    "feedback",
    { kind: "success", text: "translated:optionsOAuthSaved" }
  ]);
});

test("refreshes connection rows without replacing unsaved preferences", async () => {
  const harness = createHarness({
    "googleDrive:accounts:list": {
      ok: true,
      value: [{ id: "account-1", emailAddress: "ada@example.invalid" }]
    },
    "googleDrive:vfs:connections:list": {
      ok: true,
      value: [{
        addonId: "consumer@example.invalid",
        storageId: "storage-1",
        accountId: "account-1"
      }]
    }
  });

  await harness.controller.refreshConnections();

  assert.deepEqual(harness.messages.map(({ type }) => type).sort(), [
    "googleDrive:accounts:list",
    "googleDrive:vfs:connections:list"
  ]);
  assert.equal(
    harness.calls.some(([type]) => type === "preferences"),
    false
  );
  assert.equal(
    harness.calls.some(([type]) => type === "connections"),
    true
  );
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
  assert.equal(
    errorMessageKey("account_has_connections"),
    "optionsErrorAccountHasConnections"
  );
  assert.equal(
    errorMessageKey("connection_not_found"),
    "vfsConnectionErrorNotFound"
  );
  assert.equal(
    errorMessageKey("oauth_request_timeout"),
    "vfsErrorNetworkDescription"
  );
  assert.equal(
    errorMessageKey("oauth_configuration_managed"),
    "optionsErrorOAuthConfigurationManaged"
  );
  assert.equal(
    errorMessageKey("oauth_managed_policy_read_failed"),
    "optionsErrorOAuthPolicyInvalid"
  );

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

test("revokes only the selected VFS connection", async () => {
  const harness = createHarness({
    "googleDrive:vfs:connection:revoke": {
      ok: true,
      value: {
        addonId: "consumer@example.invalid",
        storageId: "storage-1"
      }
    },
    "googleDrive:preferences:get": { ok: true, value: { exportFormats: {} } },
    "googleDrive:accounts:list": { ok: true, value: [] }
  });

  assert.equal(await harness.controller.revokeConnection(
    "consumer@example.invalid",
    "storage-1"
  ), true);
  assert.deepEqual(harness.messages[0], {
    type: "googleDrive:vfs:connection:revoke",
    addonId: "consumer@example.invalid",
    storageId: "storage-1"
  });
  assert.deepEqual(harness.calls.at(-2), [
    "feedback",
    {
      kind: "success",
      text: "translated:optionsConnectionRevoked"
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
