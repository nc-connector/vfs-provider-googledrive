/**
 * Google Drive change monitor tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  GoogleDriveChangeMonitor
} from "../src/google/drive-change-monitor.mjs";

function clone(value) {
  return structuredClone(value);
}

function createFixture({
  accounts = [{ id: "account-1", status: "connected" }],
  bindings = [{ storageId: "storage-1", accountId: "account-1" }],
  cursors = {},
  drives = {},
  changes = {},
  reportStorageChange,
  listAuthorizedBindings
} = {}) {
  const accountMap = new Map(accounts.map((account) => [account.id, account]));
  const cursorMap = new Map(Object.entries(cursors).map(([accountId, value]) =>
    [accountId, clone(value)]));
  const calls = {
    listBindings: 0,
    clients: [],
    listDrives: [],
    getStartPageToken: [],
    listChanges: [],
    replacements: [],
    reports: []
  };
  const accountRepository = {
    async getAccount(accountId) {
      return clone(accountMap.get(accountId) || null);
    },
    async listChangeCursors(accountId) {
      return clone(cursorMap.get(accountId) || []);
    },
    async replaceChangeCursors(accountId, replacements) {
      calls.replacements.push({ accountId, replacements: clone(replacements) });
      cursorMap.set(accountId, clone(replacements));
      return clone(replacements);
    }
  };
  const connectionService = {
    async listAuthorizedBindings() {
      calls.listBindings += 1;
      return listAuthorizedBindings
        ? listAuthorizedBindings(calls.listBindings)
        : clone(bindings);
    }
  };
  const apiClientFactory = ({ accountId }) => {
    calls.clients.push(accountId);
    return {
      async listDrives(options) {
        calls.listDrives.push({ accountId, options: clone(options) });
        return {
          drives: (drives[accountId] || []).map((id) => ({ id }))
        };
      },
      async getStartPageToken(options = {}) {
        const driveId = options.driveId ?? null;
        calls.getStartPageToken.push({
          accountId,
          driveId,
          options: clone(options)
        });
        return `start:${accountId}:${driveId ?? "user"}`;
      },
      async listChanges(options) {
        const driveId = options.driveId ?? null;
        calls.listChanges.push({
          accountId,
          driveId,
          options: clone(options)
        });
        const key = `${accountId}:${driveId ?? "user"}`;
        const result = changes[key];
        if (result instanceof Error) {
          throw result;
        }
        return clone(result || {
          changes: [],
          newStartPageToken: `next:${key}`
        });
      }
    };
  };
  const monitor = new GoogleDriveChangeMonitor({
    accountRepository,
    connectionService,
    transport: { request() {} },
    apiClientFactory,
    reportStorageChange: reportStorageChange || (async (storageId, entries) => {
      calls.reports.push({ storageId, entries: clone(entries) });
    })
  });
  return { calls, cursorMap, monitor };
}

function storedCursor(driveId, pageToken) {
  return {
    accountId: "account-1",
    driveId,
    pageToken,
    updatedAt: 1
  };
}

test("creates an account baseline without reporting old Drive changes", async () => {
  const { calls, monitor } = createFixture({
    bindings: [
      { storageId: "storage-2", accountId: "account-1" },
      { storageId: "storage-1", accountId: "account-1" }
    ],
    drives: { "account-1": ["drive-2", "drive-1"] }
  });

  assert.deepEqual(await monitor.poll(), {
    connections: 2,
    accounts: 1,
    failed: 0
  });
  assert.deepEqual(calls.clients, ["account-1"]);
  assert.deepEqual(calls.getStartPageToken.map(({ driveId }) => driveId), [
    null,
    "drive-1",
    "drive-2"
  ]);
  assert.deepEqual(calls.listChanges, []);
  assert.deepEqual(calls.reports, []);
  assert.deepEqual(calls.replacements, [{
    accountId: "account-1",
    replacements: [
      { driveId: null, pageToken: "start:account-1:user" },
      { driveId: "drive-1", pageToken: "start:account-1:drive-1" },
      { driveId: "drive-2", pageToken: "start:account-1:drive-2" }
    ]
  }]);
});

test("coalesces user and Shared Drive changes for every account connection", async () => {
  const { calls, monitor } = createFixture({
    bindings: [
      { storageId: "storage-2", accountId: "account-1" },
      { storageId: "storage-1", accountId: "account-1" }
    ],
    cursors: {
      "account-1": [
        storedCursor(null, "user-old"),
        storedCursor("drive-1", "drive-old")
      ]
    },
    drives: { "account-1": ["drive-1"] },
    changes: {
      "account-1:user": {
        changes: [{ fileId: "file-1" }],
        newStartPageToken: "user-new"
      },
      "account-1:drive-1": {
        changes: [{ removed: true, fileId: "file-2" }],
        newStartPageToken: "drive-new"
      }
    }
  });

  await monitor.poll();

  assert.deepEqual(calls.listChanges.map(({ driveId, options }) => ({
    driveId,
    includeCorpusRemovals: options.includeCorpusRemovals,
    restrictToMyDrive: options.restrictToMyDrive
  })), [
    { driveId: null, includeCorpusRemovals: true, restrictToMyDrive: false },
    { driveId: "drive-1", includeCorpusRemovals: true, restrictToMyDrive: undefined }
  ]);
  assert.deepEqual(calls.reports, ["storage-1", "storage-2"].map((storageId) => ({
    storageId,
    entries: [{
      kind: "directory",
      action: "modified",
      target: { path: "/" }
    }]
  })));
  assert.deepEqual(calls.replacements.at(-1), {
    accountId: "account-1",
    replacements: [
      { driveId: null, pageToken: "user-new" },
      { driveId: "drive-1", pageToken: "drive-new" }
    ]
  });
});

test("reports Shared Drive membership changes and replaces retired cursors", async () => {
  const { calls, monitor } = createFixture({
    cursors: {
      "account-1": [
        storedCursor(null, "user-old"),
        storedCursor("drive-old", "old-drive-token")
      ]
    },
    drives: { "account-1": ["drive-new"] },
    changes: {
      "account-1:user": {
        changes: [],
        newStartPageToken: "user-new"
      }
    }
  });

  await monitor.poll();

  assert.equal(calls.reports.length, 1);
  assert.deepEqual(calls.getStartPageToken.map(({ driveId }) => driveId), [
    "drive-new"
  ]);
  assert.deepEqual(calls.replacements.at(-1).replacements, [
    { driveId: null, pageToken: "user-new" },
    { driveId: "drive-new", pageToken: "start:account-1:drive-new" }
  ]);
});

test("keeps cursors when reporting fails and continues with another account", async () => {
  const reports = [];
  let fixture;
  fixture = createFixture({
    accounts: [
      { id: "account-1", status: "connected" },
      { id: "account-2", status: "connected" }
    ],
    bindings: [
      { storageId: "storage-1", accountId: "account-1" },
      { storageId: "storage-2", accountId: "account-2" }
    ],
    cursors: {
      "account-1": [storedCursor(null, "one-old")],
      "account-2": [{
        accountId: "account-2",
        driveId: null,
        pageToken: "two-old",
        updatedAt: 1
      }]
    },
    changes: {
      "account-1:user": {
        changes: [{ fileId: "file-1" }],
        newStartPageToken: "one-new"
      },
      "account-2:user": {
        changes: [{ fileId: "file-2" }],
        newStartPageToken: "two-new"
      }
    },
    reportStorageChange: async (storageId, entries) => {
      reports.push({ storageId, entries: clone(entries) });
      if (storageId === "storage-1") {
        throw new Error("consumer unavailable");
      }
      fixture.calls.reports.push({ storageId, entries: clone(entries) });
    }
  });

  assert.deepEqual(await fixture.monitor.poll(), {
    connections: 2,
    accounts: 1,
    failed: 1
  });
  assert.deepEqual(reports.map(({ storageId }) => storageId), [
    "storage-1",
    "storage-2"
  ]);
  assert.deepEqual(fixture.calls.replacements, [{
    accountId: "account-2",
    replacements: [{ driveId: null, pageToken: "two-new" }]
  }]);
  assert.deepEqual(fixture.cursorMap.get("account-1"), [
    storedCursor(null, "one-old")
  ]);
});

test("skips unbound and signed-out accounts", async () => {
  const { calls, monitor } = createFixture({
    accounts: [
      { id: "account-1", status: "reauthorization_required" },
      { id: "account-2", status: "connected" }
    ],
    bindings: [
      { storageId: "storage-1", accountId: "account-1" }
    ]
  });

  assert.deepEqual(await monitor.poll(), {
    connections: 1,
    accounts: 0,
    failed: 0
  });
  assert.deepEqual(calls.clients, []);
  assert.deepEqual(calls.replacements, []);
});

test("queues one follow-up instead of overlapping change polls", async () => {
  let releaseFirst;
  const firstBindings = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let active = 0;
  let maximumActive = 0;
  const { calls, monitor } = createFixture({
    bindings: [],
    listAuthorizedBindings: async (call) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (call === 1) {
          await firstBindings;
        }
        return [];
      } finally {
        active -= 1;
      }
    }
  });

  const first = monitor.poll();
  const second = monitor.poll();
  assert.equal(second, first);
  releaseFirst();
  await first;

  assert.equal(calls.listBindings, 2);
  assert.equal(maximumActive, 1);
});
