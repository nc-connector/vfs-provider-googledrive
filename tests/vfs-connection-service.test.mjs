/**
 * VFS connection lifecycle tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { READ_ONLY_CAPABILITIES } from "../src/provider/google-drive-vfs-provider.mjs";
import {
  VFS_TOOLKIT_CONNECTIONS_KEY,
  VfsConnectionService
} from "../src/provider/vfs-connection-service.mjs";
import { ProviderStateRepository } from "../src/state/provider-state.mjs";
import { FakeStorageArea } from "./helpers/fake-storage.mjs";

const CLIENT_ID = "123456.apps.googleusercontent.com";

function toolkitConnection({
  addonId = "consumer@example.invalid",
  addonName = "Example consumer",
  storageId = "storage-1",
  name = "Drive account",
  capabilities = READ_ONLY_CAPABILITIES
} = {}) {
  return { addonId, addonName, storageId, name, capabilities };
}

async function createFixture({ connections = [], reportConnection, randomUUID } = {}) {
  const storageArea = new FakeStorageArea({
    [VFS_TOOLKIT_CONNECTIONS_KEY]: connections
  });
  const accountRepository = new ProviderStateRepository({ storageArea });
  await accountRepository.initialize();
  const service = new VfsConnectionService({
    storageArea,
    accountRepository,
    reportConnection: reportConnection || (async () => undefined),
    randomUUID: randomUUID || (() => "storage-new")
  });
  return { accountRepository, service, storageArea };
}

async function addAccount(accountRepository, id = "account-1", status = "connected") {
  return accountRepository.upsertAccount({
    id,
    googleUserId: `google-${id}`,
    displayName: `User ${id}`,
    emailAddress: `${id}@example.invalid`,
    oauthClientId: CLIENT_ID,
    refreshToken: `refresh-${id}`,
    status
  });
}

test("reconciles product bindings with Toolkit connection records", async () => {
  const { accountRepository, service } = await createFixture({
    connections: [toolkitConnection({ storageId: "storage-2" })]
  });
  await addAccount(accountRepository);
  await accountRepository.bindConnection({
    storageId: "storage-1",
    accountId: "account-1"
  });
  await accountRepository.bindConnection({
    storageId: "storage-2",
    accountId: "account-1"
  });

  assert.deepEqual(await service.initialize(), ["storage-1"]);
  const bindings = await accountRepository.listConnectionBindings();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].storageId, "storage-2");
  assert.equal(bindings[0].accountId, "account-1");
  assert.equal(typeof bindings[0].createdAt, "number");
  assert.equal(typeof bindings[0].updatedAt, "number");
});

test("authorizes only one current connection with the requested capability", async () => {
  const connection = toolkitConnection();
  const { accountRepository, service, storageArea } = await createFixture({
    connections: [connection]
  });
  await addAccount(accountRepository);
  await accountRepository.bindConnection({
    storageId: connection.storageId,
    accountId: "account-1"
  });

  assert.equal(
    (await service.getAuthorizedBinding("storage-1", "folder.read")).accountId,
    "account-1"
  );
  await assert.rejects(
    service.getAuthorizedBinding("storage-1", "file.add"),
    (error) => error.code === "E:AUTH"
  );
  await assert.rejects(
    service.getAuthorizedBinding("unknown", "file.read"),
    (error) => error.code === "E:AUTH"
  );

  await storageArea.set({
    [VFS_TOOLKIT_CONNECTIONS_KEY]: [connection, {
      ...connection,
      addonId: "second@example.invalid"
    }]
  });
  await assert.rejects(
    service.getAuthorizedBinding("storage-1", "file.read"),
    (error) => error.code === "E:AUTH"
  );
});

test("creates the product binding before completing Toolkit setup", async () => {
  let fixture;
  let reported;
  const reportConnection = async (...args) => {
    reported = args;
    assert.equal(
      (await fixture.accountRepository.getConnectionBinding("storage-new"))
        .accountId,
      "account-1"
    );
    return { addonId: args[0], storageId: args[2] };
  };
  fixture = await createFixture({ reportConnection });
  await addAccount(fixture.accountRepository);

  const result = await fixture.service.createConnection({
    addonId: "consumer@example.invalid",
    addonName: "Example consumer",
    accountId: "account-1",
    name: "Work Drive",
    setupToken: "setup-token"
  });

  assert.deepEqual(result, {
    storageId: "storage-new",
    name: "Work Drive",
    accountId: "account-1"
  });
  assert.deepEqual(reported.slice(0, 4), [
    "consumer@example.invalid",
    "Example consumer",
    "storage-new",
    "Work Drive"
  ]);
  assert.deepEqual(reported[4], READ_ONLY_CAPABILITIES);
  assert.equal(reported[5], "setup-token");
});

test("removes a new binding when Toolkit setup fails", async () => {
  const { accountRepository, service } = await createFixture({
    reportConnection: async () => {
      throw new Error("setup failed");
    }
  });
  await addAccount(accountRepository);

  await assert.rejects(service.createConnection({
    addonId: "consumer@example.invalid",
    accountId: "account-1",
    name: "Work Drive",
    setupToken: "setup-token"
  }), /setup failed/);
  assert.deepEqual(await accountRepository.listConnectionBindings(), []);
});

test("updates a connection name and account through the Toolkit helper", async () => {
  const existing = toolkitConnection();
  const reports = [];
  const { accountRepository, service } = await createFixture({
    connections: [existing],
    reportConnection: async (...args) => reports.push(args)
  });
  await addAccount(accountRepository, "account-1");
  await addAccount(accountRepository, "account-2");
  await accountRepository.bindConnection({
    storageId: "storage-1",
    accountId: "account-1"
  });

  assert.deepEqual(await service.updateConnection({
    addonId: existing.addonId,
    storageId: existing.storageId,
    accountId: "account-2",
    name: "Personal Drive"
  }), {
    storageId: "storage-1",
    name: "Personal Drive",
    accountId: "account-2"
  });
  assert.equal(
    (await accountRepository.getConnectionBinding("storage-1")).accountId,
    "account-2"
  );
  assert.deepEqual(reports[0].slice(0, 4), [
    existing.addonId,
    existing.addonName,
    existing.storageId,
    "Personal Drive"
  ]);
  assert.equal(reports[0][5], undefined);
});

test("restores the previous account binding when an update fails", async () => {
  const existing = toolkitConnection();
  const { accountRepository, service } = await createFixture({
    connections: [existing],
    reportConnection: async () => {
      throw new Error("update failed");
    }
  });
  await addAccount(accountRepository, "account-1");
  await addAccount(accountRepository, "account-2");
  await accountRepository.bindConnection({
    storageId: "storage-1",
    accountId: "account-1"
  });

  await assert.rejects(service.updateConnection({
    addonId: existing.addonId,
    storageId: existing.storageId,
    accountId: "account-2",
    name: "Personal Drive"
  }), /update failed/);
  assert.equal(
    (await accountRepository.getConnectionBinding("storage-1")).accountId,
    "account-1"
  );
});

test("blocks account removal until its Toolkit connections are gone", async () => {
  const existing = toolkitConnection();
  const { accountRepository, service, storageArea } = await createFixture({
    connections: [existing]
  });
  await addAccount(accountRepository);
  await accountRepository.bindConnection({
    storageId: existing.storageId,
    accountId: "account-1"
  });
  let calls = 0;
  const disconnect = async () => {
    calls += 1;
    return "disconnected";
  };

  await assert.rejects(
    service.disconnectAccount("account-1", disconnect),
    (error) => error.code === "account_has_connections"
  );
  assert.equal(calls, 0);

  await storageArea.set({ [VFS_TOOLKIT_CONNECTIONS_KEY]: [] });
  assert.equal(
    await service.disconnectAccount("account-1", disconnect),
    "disconnected"
  );
  assert.equal(calls, 1);
  assert.deepEqual(await accountRepository.listConnectionBindings(), []);
});

test("loads config only for the matching consumer and storage pair", async () => {
  const existing = toolkitConnection();
  const { accountRepository, service } = await createFixture({
    connections: [existing]
  });
  await addAccount(accountRepository);
  await accountRepository.bindConnection({
    storageId: existing.storageId,
    accountId: "account-1"
  });

  assert.deepEqual(await service.getConnection({
    addonId: existing.addonId,
    storageId: existing.storageId
  }), {
    addonId: existing.addonId,
    addonName: existing.addonName,
    storageId: existing.storageId,
    name: existing.name,
    accountId: "account-1"
  });
  await assert.rejects(service.getConnection({
    addonId: "other@example.invalid",
    storageId: existing.storageId
  }), (error) => error.code === "connection_not_found");
});
