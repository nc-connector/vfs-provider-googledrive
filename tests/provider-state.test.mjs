/**
 * Provider state repository tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_STATE_KEY,
  ProviderStateRepository
} from "../src/state/provider-state.mjs";
import { FakeStorageArea } from "./helpers/fake-storage.mjs";

const CLIENT_ID = "123456.apps.googleusercontent.com";

function createRepository() {
  let timestamp = 1000;
  let identifier = 0;
  const storageArea = new FakeStorageArea();
  const repository = new ProviderStateRepository({
    storageArea,
    now: () => timestamp++,
    randomUUID: () => `account-${++identifier}`
  });
  return { repository, storageArea };
}

test("initializes versioned state without accounts or bindings", async () => {
  const { repository, storageArea } = createRepository();

  const state = await repository.initialize();

  assert.deepEqual(state, {
    version: 1,
    accounts: [],
    connectionBindings: []
  });
  assert.deepEqual(storageArea.snapshot()[PROVIDER_STATE_KEY], state);
});

test("keeps refresh material out of normal account results", async () => {
  const { repository, storageArea } = createRepository();

  const account = await repository.upsertAccount({
    googleUserId: "google-user-1",
    displayName: "Ada Example",
    emailAddress: "ada@example.invalid",
    oauthClientId: CLIENT_ID,
    refreshToken: "refresh-secret"
  });

  assert.equal(account.id, "account-1");
  assert.equal(Object.hasOwn(account, "refreshToken"), false);
  assert.equal(Object.hasOwn((await repository.listAccounts())[0], "refreshToken"), false);
  assert.deepEqual(await repository.getAccountAuthorization(account.id), {
    accountId: "account-1",
    oauthClientId: CLIENT_ID,
    refreshToken: "refresh-secret",
    status: "connected"
  });
  assert.equal(
    storageArea.snapshot()[PROVIDER_STATE_KEY].accounts[0].refreshToken,
    "refresh-secret"
  );
});

test("reuses an account record when Google returns the same user", async () => {
  const { repository } = createRepository();
  const original = await repository.upsertAccount({
    googleUserId: "google-user-1",
    displayName: "Old name",
    oauthClientId: CLIENT_ID,
    refreshToken: "refresh-one"
  });

  const updated = await repository.upsertAccount({
    googleUserId: "google-user-1",
    displayName: "New name",
    emailAddress: "new@example.invalid"
  });

  assert.equal(updated.id, original.id);
  assert.equal(updated.displayName, "New name");
  assert.equal((await repository.listAccounts()).length, 1);
  assert.equal(
    (await repository.getAccountAuthorization(original.id)).refreshToken,
    "refresh-one"
  );
});

test("stores only the account binding beside toolkit-owned connection data", async () => {
  const { repository, storageArea } = createRepository();
  const account = await repository.upsertAccount({
    googleUserId: "google-user-1",
    oauthClientId: CLIENT_ID,
    refreshToken: "refresh-one"
  });

  const binding = await repository.bindConnection({
    storageId: "storage-1",
    accountId: account.id
  });

  assert.deepEqual(Object.keys(binding).sort(), [
    "accountId",
    "createdAt",
    "storageId",
    "updatedAt"
  ]);
  assert.equal(
    Object.hasOwn(storageArea.snapshot()[PROVIDER_STATE_KEY], "vfs-toolkit-connections"),
    false
  );
});

test("removing an account returns and removes all dependent bindings", async () => {
  const { repository } = createRepository();
  const account = await repository.upsertAccount({
    googleUserId: "google-user-1",
    oauthClientId: CLIENT_ID,
    refreshToken: "refresh-one"
  });
  await repository.bindConnection({ storageId: "storage-1", accountId: account.id });
  await repository.bindConnection({ storageId: "storage-2", accountId: account.id });

  const result = await repository.removeAccount(account.id);

  assert.deepEqual(result.removedStorageIds, ["storage-1", "storage-2"]);
  assert.deepEqual(await repository.listAccounts(), []);
  assert.deepEqual(await repository.listConnectionBindings(), []);
});

test("removes stale bindings without changing valid ones", async () => {
  const { repository } = createRepository();
  const account = await repository.upsertAccount({
    googleUserId: "google-user-1",
    oauthClientId: CLIENT_ID,
    refreshToken: "refresh-one"
  });
  await repository.bindConnection({ storageId: "storage-1", accountId: account.id });
  await repository.bindConnection({ storageId: "storage-2", accountId: account.id });

  const removed = await repository.reconcileConnectionBindings(["storage-2"]);

  assert.deepEqual(removed, ["storage-1"]);
  assert.deepEqual(
    (await repository.listConnectionBindings()).map(({ storageId }) => storageId),
    ["storage-2"]
  );
});

test("serializes overlapping account writes", async () => {
  const { repository } = createRepository();

  await Promise.all([
    repository.upsertAccount({
      googleUserId: "google-user-1",
      oauthClientId: CLIENT_ID,
      refreshToken: "refresh-one"
    }),
    repository.upsertAccount({
      googleUserId: "google-user-2",
      oauthClientId: CLIENT_ID,
      refreshToken: "refresh-two"
    })
  ]);

  assert.deepEqual(
    (await repository.listAccounts()).map(({ googleUserId }) => googleUserId),
    ["google-user-1", "google-user-2"]
  );
});
