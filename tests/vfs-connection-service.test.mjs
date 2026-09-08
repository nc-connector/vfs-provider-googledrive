/**
 * VFS connection lifecycle tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import { GOOGLE_DRIVE_CAPABILITIES } from "../src/provider/google-drive-vfs-provider.mjs";
import {
  createToolkitConnectionReporter,
  VFS_TOOLKIT_CONNECTIONS_KEY,
  VfsConnectionService
} from "../src/provider/vfs-connection-service.mjs";
import { ProviderStateRepository } from "../src/state/provider-state.mjs";
import { FakeStorageArea } from "./helpers/fake-storage.mjs";

const CLIENT_ID = "123456.apps.googleusercontent.com";
const PREVIOUS_CAPABILITIES = Object.freeze({
  file: Object.freeze({
    read: true,
    add: true,
    modify: false,
    delete: false
  }),
  folder: Object.freeze({
    read: true,
    add: true,
    modify: false,
    delete: false
  })
});

function toolkitConnection({
  addonId = "consumer@example.invalid",
  addonName = "Example consumer",
  storageId = "storage-1",
  name = "Drive account",
  capabilities = GOOGLE_DRIVE_CAPABILITIES
} = {}) {
  return { addonId, addonName, storageId, name, capabilities };
}

async function createFixture({
  connections = [],
  reportConnection,
  sendMessage,
  randomUUID,
  logger
} = {}) {
  const storageArea = new FakeStorageArea({
    [VFS_TOOLKIT_CONNECTIONS_KEY]: connections
  });
  const accountRepository = new ProviderStateRepository({ storageArea });
  await accountRepository.initialize();
  const service = new VfsConnectionService({
    storageArea,
    accountRepository,
    reportConnection: reportConnection || (async () => undefined),
    sendMessage: sendMessage || (async () => undefined),
    randomUUID: randomUUID || (() => "storage-new"),
    logger
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

test("completes setup directly through the active Toolkit provider", async () => {
  const calls = [];
  const provider = {
    completeSetup: async (...args) => {
      calls.push(["completeSetup", ...args]);
      return { addonId: "consumer@example.invalid", storageId: args[1] };
    }
  };
  const reporter = createToolkitConnectionReporter({
    getProvider: () => provider,
    reportConnection: async (...args) => calls.push([
      "reportConnection",
      ...args
    ])
  });
  const capabilities = { file: { read: true } };

  assert.deepEqual(await reporter(
    "consumer@example.invalid",
    "Example consumer",
    "storage-1",
    "Work Drive",
    capabilities,
    "setup-token"
  ), {
    addonId: "consumer@example.invalid",
    storageId: "storage-1"
  });
  assert.deepEqual(calls, [[
    "completeSetup",
    "setup-token",
    "storage-1",
    "Work Drive",
    capabilities
  ]]);
});

test("uses the Toolkit reporter when no setup request is pending", async () => {
  const calls = [];
  const reporter = createToolkitConnectionReporter({
    getProvider: () => ({
      completeSetup: async (...args) => calls.push(["completeSetup", ...args])
    }),
    reportConnection: async (...args) => calls.push([
      "reportConnection",
      ...args
    ])
  });
  const capabilities = { file: { read: true } };

  await reporter(
    "consumer@example.invalid",
    "Example consumer",
    "storage-1",
    "Work Drive",
    capabilities
  );
  assert.deepEqual(calls, [[
    "reportConnection",
    "consumer@example.invalid",
    "Example consumer",
    "storage-1",
    "Work Drive",
    capabilities
  ]]);
});

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

test("updates capabilities only for unique account-bound connections", async () => {
  const oldConnection = toolkitConnection({
    capabilities: PREVIOUS_CAPABILITIES
  });
  const currentConnection = toolkitConnection({ storageId: "storage-2" });
  const duplicateConnection = toolkitConnection({
    addonId: "duplicate-one@example.invalid",
    storageId: "storage-3",
    capabilities: PREVIOUS_CAPABILITIES
  });
  const unboundConnection = toolkitConnection({
    storageId: "storage-4",
    capabilities: PREVIOUS_CAPABILITIES
  });
  const reports = [];
  let fixture;
  fixture = await createFixture({
    connections: [
      oldConnection,
      currentConnection,
      duplicateConnection,
      {
        ...duplicateConnection,
        addonId: "duplicate-two@example.invalid"
      },
      unboundConnection
    ],
    reportConnection: async (...args) => {
      reports.push(args);
      const stored = await fixture.storageArea.get({
        [VFS_TOOLKIT_CONNECTIONS_KEY]: []
      });
      const connections = stored[VFS_TOOLKIT_CONNECTIONS_KEY].map((entry) =>
        entry.addonId === args[0] && entry.storageId === args[2]
          ? {
              addonId: args[0],
              addonName: args[1],
              storageId: args[2],
              name: args[3],
              capabilities: args[4]
            }
          : entry);
      await fixture.storageArea.set({
        [VFS_TOOLKIT_CONNECTIONS_KEY]: connections
      });
    }
  });
  await addAccount(fixture.accountRepository);
  for (const storageId of ["storage-1", "storage-2", "storage-3"]) {
    await fixture.accountRepository.bindConnection({
      storageId,
      accountId: "account-1"
    });
  }

  assert.deepEqual(await fixture.service.initialize(), []);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].slice(0, 4), [
    oldConnection.addonId,
    oldConnection.addonName,
    oldConnection.storageId,
    oldConnection.name
  ]);
  assert.deepEqual(reports[0][4], GOOGLE_DRIVE_CAPABILITIES);
  assert.equal(reports[0][5], undefined);
  assert.equal(
    (await fixture.accountRepository.getConnectionBinding("storage-1"))
      .accountId,
    "account-1"
  );

  await fixture.service.initialize();
  assert.equal(reports.length, 1);
});

test("keeps an existing binding when its capability update fails", async () => {
  let reports = 0;
  const connection = toolkitConnection({
    capabilities: PREVIOUS_CAPABILITIES
  });
  const { accountRepository, service } = await createFixture({
    connections: [connection],
    reportConnection: async () => {
      reports += 1;
      throw new Error("storage unavailable");
    }
  });
  await addAccount(accountRepository);
  await accountRepository.bindConnection({
    storageId: connection.storageId,
    accountId: "account-1"
  });

  assert.deepEqual(await service.initialize(), []);
  assert.equal(reports, 1);
  assert.equal(
    (await accountRepository.getConnectionBinding(connection.storageId))
      .accountId,
    "account-1"
  );
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
  assert.equal(
    (await service.getAuthorizedBinding("storage-1", "file.add")).accountId,
    "account-1"
  );
  assert.equal(
    (await service.getAuthorizedBinding("storage-1", "folder.add")).accountId,
    "account-1"
  );
  assert.equal(
    (await service.getAuthorizedBinding("storage-1", "file.delete")).accountId,
    "account-1"
  );
  assert.equal(
    (await service.getAuthorizedBinding("storage-1", "folder.delete")).accountId,
    "account-1"
  );
  assert.equal(
    (await service.getAuthorizedBinding("storage-1", "file.modify")).accountId,
    "account-1"
  );
  assert.equal(
    (await service.getAuthorizedBinding("storage-1", "folder.modify")).accountId,
    "account-1"
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

test("lists only current unambiguous account bindings", async () => {
  const duplicate = toolkitConnection({
    addonId: "duplicate-one@example.invalid",
    storageId: "storage-2"
  });
  const { accountRepository, service } = await createFixture({
    connections: [
      toolkitConnection({ storageId: "storage-1" }),
      duplicate,
      { ...duplicate, addonId: "duplicate-two@example.invalid" }
    ]
  });
  await addAccount(accountRepository, "account-1");
  await addAccount(accountRepository, "account-2");
  await accountRepository.bindConnection({
    storageId: "storage-1",
    accountId: "account-1"
  });
  await accountRepository.bindConnection({
    storageId: "storage-2",
    accountId: "account-2"
  });
  await accountRepository.bindConnection({
    storageId: "storage-stale",
    accountId: "account-2"
  });

  const bindings = await service.listAuthorizedBindings();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].storageId, "storage-1");
  assert.equal(bindings[0].accountId, "account-1");
  assert.equal(typeof bindings[0].createdAt, "number");
  assert.equal(typeof bindings[0].updatedAt, "number");
  assert.equal(
    await accountRepository.getConnectionBinding("storage-stale"),
    null
  );
});

test("lists Toolkit connections with their account bindings", async () => {
  const first = toolkitConnection();
  const second = toolkitConnection({
    addonId: "second@example.invalid",
    addonName: "Second consumer",
    storageId: "storage-2",
    name: "Shared Drive"
  });
  const { accountRepository, service } = await createFixture({
    connections: [first, second, toolkitConnection({
      storageId: "storage-unbound"
    })]
  });
  await addAccount(accountRepository, "account-1");
  await addAccount(accountRepository, "account-2");
  await accountRepository.bindConnection({
    storageId: first.storageId,
    accountId: "account-1"
  });
  await accountRepository.bindConnection({
    storageId: second.storageId,
    accountId: "account-2"
  });

  assert.deepEqual(await service.listConnections(), [{
    addonId: first.addonId,
    addonName: first.addonName,
    storageId: first.storageId,
    name: first.name,
    accountId: "account-1"
  }, {
    addonId: second.addonId,
    addonName: second.addonName,
    storageId: second.storageId,
    name: second.name,
    accountId: "account-2"
  }]);
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
  assert.deepEqual(reported[4], GOOGLE_DRIVE_CAPABILITIES);
  assert.equal(reported[5], "setup-token");
});

test("reconciliation reads Toolkit connections after queued setup completes", async () => {
  let releaseSetup;
  const setupMayFinish = new Promise((resolve) => {
    releaseSetup = resolve;
  });
  let reportStarted;
  const reportHasStarted = new Promise((resolve) => {
    reportStarted = resolve;
  });
  let fixture;
  fixture = await createFixture({
    reportConnection: async () => {
      reportStarted();
      await setupMayFinish;
      await fixture.storageArea.set({
        [VFS_TOOLKIT_CONNECTIONS_KEY]: [toolkitConnection({
          storageId: "storage-new"
        })]
      });
    }
  });
  await addAccount(fixture.accountRepository);

  const create = fixture.service.createConnection({
    addonId: "consumer@example.invalid",
    accountId: "account-1",
    name: "Work Drive",
    setupToken: "setup-token"
  });
  await reportHasStarted;
  const reconcile = fixture.service.reconcileToolkitConnections();
  releaseSetup();

  await Promise.all([create, reconcile]);
  assert.equal(
    (await fixture.accountRepository.getConnectionBinding("storage-new"))
      .accountId,
    "account-1"
  );
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
  assert.deepEqual(reports[0][4], GOOGLE_DRIVE_CAPABILITIES);
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

test("revokes one consumer connection and notifies that add-on", async () => {
  const removed = toolkitConnection();
  const retained = toolkitConnection({
    addonId: "second@example.invalid",
    storageId: "storage-2"
  });
  const notifications = [];
  const malformedRecord = { storageId: 42, privateData: "preserve" };
  const { accountRepository, service, storageArea } = await createFixture({
    connections: [removed, retained, malformedRecord],
    sendMessage: async (...args) => notifications.push(args)
  });
  await addAccount(accountRepository);
  await accountRepository.bindConnection({
    storageId: removed.storageId,
    accountId: "account-1"
  });
  await accountRepository.bindConnection({
    storageId: retained.storageId,
    accountId: "account-1"
  });

  assert.deepEqual(await service.revokeConnection({
    addonId: removed.addonId,
    storageId: removed.storageId
  }), {
    addonId: removed.addonId,
    storageId: removed.storageId
  });
  assert.deepEqual(
    storageArea.snapshot()[VFS_TOOLKIT_CONNECTIONS_KEY],
    [retained, malformedRecord]
  );
  assert.equal(
    await accountRepository.getConnectionBinding(removed.storageId),
    null
  );
  assert.equal(
    (await accountRepository.getConnectionBinding(retained.storageId))
      .accountId,
    "account-1"
  );
  assert.deepEqual(notifications, [[removed.addonId, {
    type: "vfs-toolkit-remove-connection",
    storageId: removed.storageId
  }]]);
});

test("keeps a shared storage binding until its last connection is revoked", async () => {
  const first = toolkitConnection();
  const second = toolkitConnection({
    addonId: "second@example.invalid"
  });
  const { accountRepository, service } = await createFixture({
    connections: [first, second]
  });
  await addAccount(accountRepository);
  await accountRepository.bindConnection({
    storageId: first.storageId,
    accountId: "account-1"
  });

  await service.revokeConnection({
    addonId: first.addonId,
    storageId: first.storageId
  });

  assert.equal(
    (await accountRepository.getConnectionBinding(first.storageId)).accountId,
    "account-1"
  );
  assert.deepEqual((await service.listConnections()).map(({ addonId }) =>
    addonId), [second.addonId]);
});

test("keeps a completed revocation when the consumer is unavailable", async () => {
  const connection = toolkitConnection();
  const { accountRepository, service, storageArea } = await createFixture({
    connections: [connection],
    sendMessage: async () => {
      throw new Error("Receiving end does not exist");
    }
  });
  await addAccount(accountRepository);
  await accountRepository.bindConnection({
    storageId: connection.storageId,
    accountId: "account-1"
  });

  await service.revokeConnection({
    addonId: connection.addonId,
    storageId: connection.storageId
  });

  assert.deepEqual(
    storageArea.snapshot()[VFS_TOOLKIT_CONNECTIONS_KEY],
    []
  );
  assert.equal(
    await accountRepository.getConnectionBinding(connection.storageId),
    null
  );
});

test("does not wait for a consumer that stops responding", async () => {
  const connection = toolkitConnection();
  const { accountRepository, service } = await createFixture({
    connections: [connection],
    sendMessage: () => new Promise(() => {})
  });
  await addAccount(accountRepository);
  await accountRepository.bindConnection({
    storageId: connection.storageId,
    accountId: "account-1"
  });

  assert.deepEqual(await service.revokeConnection({
    addonId: connection.addonId,
    storageId: connection.storageId
  }), {
    addonId: connection.addonId,
    storageId: connection.storageId
  });
});

test("rejects revocation for a connection that no longer exists", async () => {
  const { service } = await createFixture();

  await assert.rejects(service.revokeConnection({
    addonId: "consumer@example.invalid",
    storageId: "storage-1"
  }), (error) => error.code === "connection_not_found");
});

test("keeps a provisional account change hidden from provider requests", async () => {
  const existing = toolkitConnection();
  let finishReport;
  const reportMayFinish = new Promise((resolve, reject) => {
    finishReport = () => reject(new Error("update failed"));
  });
  let reportStarted;
  const reportHasStarted = new Promise((resolve) => {
    reportStarted = resolve;
  });
  const { accountRepository, service } = await createFixture({
    connections: [existing],
    reportConnection: async () => {
      reportStarted();
      return reportMayFinish;
    }
  });
  await addAccount(accountRepository, "account-1");
  await addAccount(accountRepository, "account-2");
  await accountRepository.bindConnection({
    storageId: "storage-1",
    accountId: "account-1"
  });

  const update = service.updateConnection({
    addonId: existing.addonId,
    storageId: existing.storageId,
    accountId: "account-2",
    name: "Personal Drive"
  });
  await reportHasStarted;
  const authorized = service.getAuthorizedBinding(
    "storage-1",
    "file.read"
  );
  finishReport();

  await assert.rejects(update, /update failed/);
  assert.equal((await authorized).accountId, "account-1");
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

test("reports connection lifecycle phases without product identifiers", async () => {
  const calls = [];
  const logger = Object.fromEntries(["debug", "info", "warn"].map((level) => [
    level,
    (event, details) => calls.push({ level, event, details })
  ]));
  const { accountRepository, service } = await createFixture({ logger });
  await addAccount(accountRepository);

  await service.initialize();
  await service.createConnection({
    addonId: "consumer@example.invalid",
    accountId: "account-1",
    name: "Private Drive name",
    setupToken: "private-setup-token"
  });

  assert.deepEqual(calls, [
    {
      level: "debug",
      event: "vfs.connection.reconciled",
      details: { connections: 0, status: "current" }
    },
    {
      level: "info",
      event: "vfs.connection.created",
      details: { status: "connected" }
    }
  ]);
  const output = JSON.stringify(calls);
  assert.equal(output.includes("consumer@example.invalid"), false);
  assert.equal(output.includes("Private Drive name"), false);
  assert.equal(output.includes("private-setup-token"), false);
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
