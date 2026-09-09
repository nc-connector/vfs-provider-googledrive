/**
 * OAuth session repository tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { OAuthSessionRepository } from "../src/google/oauth-session.mjs";
import { FakeStorageArea } from "./helpers/fake-storage.mjs";

test("keeps a valid access token across a background repository restart", async () => {
  let now = 1_000;
  const storageArea = new FakeStorageArea();
  const first = new OAuthSessionRepository({ storageArea, now: () => now });
  await first.setAccessToken("account-1", "access-secret", 121_000);

  const restarted = new OAuthSessionRepository({ storageArea, now: () => now });

  assert.equal(await restarted.getAccessToken("account-1"), "access-secret");
  now = 61_001;
  assert.equal(await restarted.getAccessToken("account-1"), null);
});

test("removes only expired authorization transactions", async () => {
  let now = 20_000;
  const repository = new OAuthSessionRepository({
    storageArea: new FakeStorageArea(),
    now: () => now
  });
  await repository.storeTransaction({
    state: "old-state",
    codeVerifier: "old-verifier",
    clientId: "old.apps.googleusercontent.com",
    createdAt: 1_000
  });
  await repository.storeTransaction({
    state: "new-state",
    codeVerifier: "new-verifier",
    clientId: "new.apps.googleusercontent.com",
    createdAt: 19_000
  });

  const removed = await repository.removeExpiredTransactions(10_000);

  assert.deepEqual(removed, ["old-state"]);
  assert.equal(await repository.getTransaction("old-state"), null);
  assert.equal((await repository.getTransaction("new-state")).codeVerifier, "new-verifier");
});

test("clears every cached access token after an OAuth client change", async () => {
  const repository = new OAuthSessionRepository({
    storageArea: new FakeStorageArea(),
    now: () => 1_000
  });
  await repository.setAccessToken("account-1", "access-one", 121_000);
  await repository.setAccessToken("account-2", "access-two", 121_000);

  await repository.clearAccessTokens();

  assert.equal(await repository.getAccessToken("account-1"), null);
  assert.equal(await repository.getAccessToken("account-2"), null);
});
