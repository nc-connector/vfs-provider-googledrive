/**
 * Cross-service MV3 background restart boundary tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { RequestAbortRegistry } from "../src/core/request-aborts.mjs";
import {
  GOOGLE_OAUTH_CLIENT_ID,
  GoogleOAuthClient
} from "../src/google/oauth-client.mjs";
import { OAuthSessionRepository } from "../src/google/oauth-session.mjs";
import { GOOGLE_DRIVE_CAPABILITIES } from "../src/provider/google-drive-vfs-provider.mjs";
import {
  VFS_TOOLKIT_CONNECTIONS_KEY,
  VfsConnectionService
} from "../src/provider/vfs-connection-service.mjs";
import { ProviderStateRepository } from "../src/state/provider-state.mjs";
import { FakeStorageArea } from "./helpers/fake-storage.mjs";

const CLIENT_ID = GOOGLE_OAUTH_CLIENT_ID;

function tokenResponse(accessToken) {
  return new Response(JSON.stringify({
    access_token: accessToken,
    expires_in: 3600
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

async function addAccount(repository) {
  return repository.upsertAccount({
    id: "account-1",
    googleUserId: "google-user-1",
    displayName: "Ada Example",
    emailAddress: "ada@example.invalid",
    oauthClientId: CLIENT_ID,
    refreshToken: "refresh-secret"
  });
}

test("refreshes from stored account state after background reconstruction", async () => {
  let now = 1_000;
  const localArea = new FakeStorageArea();
  const sessionArea = new FakeStorageArea();
  const initialAccounts = new ProviderStateRepository({
    storageArea: localArea,
    now: () => now
  });
  const initialSession = new OAuthSessionRepository({
    storageArea: sessionArea,
    now: () => now
  });
  await Promise.all([
    initialAccounts.initialize(),
    initialSession.initialize()
  ]);
  await addAccount(initialAccounts);
  await initialSession.setAccessToken("account-1", "old-access", 121_000);

  now = 70_000;
  const restartedAccounts = new ProviderStateRepository({
    storageArea: localArea,
    now: () => now
  });
  const restartedSession = new OAuthSessionRepository({
    storageArea: sessionArea,
    now: () => now
  });
  await Promise.all([
    restartedAccounts.initialize(),
    restartedSession.initialize()
  ]);
  let refreshRequests = 0;
  const restartedClient = new GoogleOAuthClient({
    identityApi: {},
    sessionRepository: restartedSession,
    accountRepository: restartedAccounts,
    fetchApi: async () => {
      refreshRequests++;
      return tokenResponse("new-access");
    },
    logger: { debug() {} },
    now: () => now
  });

  const tokens = await Promise.all([
    restartedClient.getAccessToken("account-1"),
    restartedClient.getAccessToken("account-1")
  ]);

  assert.deepEqual(tokens, ["new-access", "new-access"]);
  assert.equal(refreshRequests, 1);
  const nextSession = new OAuthSessionRepository({
    storageArea: sessionArea,
    now: () => now
  });
  assert.equal(await nextSession.getAccessToken("account-1"), "new-access");
});

test("reconciles interrupted and completed connection setup after restart", async () => {
  const localArea = new FakeStorageArea({
    [VFS_TOOLKIT_CONNECTIONS_KEY]: []
  });
  const initialAccounts = new ProviderStateRepository({
    storageArea: localArea
  });
  await initialAccounts.initialize();
  await addAccount(initialAccounts);
  await initialAccounts.bindConnection({
    storageId: "storage-interrupted",
    accountId: "account-1"
  });

  const interruptedAccounts = new ProviderStateRepository({
    storageArea: localArea
  });
  const interruptedService = new VfsConnectionService({
    storageArea: localArea,
    accountRepository: interruptedAccounts,
    reportConnection: async () => undefined
  });
  assert.deepEqual(await interruptedService.initialize(), [
    "storage-interrupted"
  ]);
  assert.equal(
    await interruptedAccounts.getConnectionBinding("storage-interrupted"),
    null
  );

  await interruptedAccounts.bindConnection({
    storageId: "storage-complete",
    accountId: "account-1"
  });
  await localArea.set({
    [VFS_TOOLKIT_CONNECTIONS_KEY]: [{
      addonId: "consumer@example.invalid",
      addonName: "Example consumer",
      storageId: "storage-complete",
      name: "Google Drive",
      capabilities: GOOGLE_DRIVE_CAPABILITIES
    }]
  });

  const completedAccounts = new ProviderStateRepository({
    storageArea: localArea
  });
  const completedService = new VfsConnectionService({
    storageArea: localArea,
    accountRepository: completedAccounts,
    reportConnection: async () => undefined
  });
  assert.deepEqual(await completedService.initialize(), []);
  assert.equal(
    (await completedService.getAuthorizedBinding(
      "storage-complete",
      "file.read"
    )).accountId,
    "account-1"
  );
});

test("does not carry active request controllers into a restarted background", async () => {
  const initialRegistry = new RequestAbortRegistry();
  let finishInitial;
  const initialRequest = initialRegistry.run(
    "transfer-1",
    async () => new Promise((resolve) => {
      finishInitial = resolve;
    })
  );
  assert.equal(initialRegistry.has("transfer-1"), true);

  const restartedRegistry = new RequestAbortRegistry();
  assert.equal(restartedRegistry.has("transfer-1"), false);
  assert.equal(restartedRegistry.cancel("transfer-1"), false);
  assert.equal(
    await restartedRegistry.run("transfer-1", async () => "new-request"),
    "new-request"
  );

  finishInitial("old-request-finished");
  assert.equal(await initialRequest, "old-request-finished");
});
