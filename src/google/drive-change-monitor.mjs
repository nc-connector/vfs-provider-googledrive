/**
 * Google Drive change polling for account-bound VFS connections.
 */

"use strict";

import { GoogleDriveApiClient } from "./drive-api-client.mjs";

const ROOT_INVALIDATION = Object.freeze({
  kind: "directory",
  action: "modified",
  target: Object.freeze({ path: "/" })
});

function requireMethod(value, method, label) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(label);
  }
  return value;
}

function requireText(value, label) {
  if (typeof value !== "string" || !value) {
    throw new TypeError(label);
  }
  return value;
}

function rootInvalidation() {
  return [{
    ...ROOT_INVALIDATION,
    target: { ...ROOT_INVALIDATION.target }
  }];
}

function groupBindings(bindings) {
  if (!Array.isArray(bindings)) {
    throw new TypeError("bindings");
  }
  const accounts = new Map();
  for (const binding of bindings) {
    const accountId = requireText(binding?.accountId, "bindingAccountId");
    const storageId = requireText(binding?.storageId, "bindingStorageId");
    if (!accounts.has(accountId)) {
      accounts.set(accountId, new Set());
    }
    accounts.get(accountId).add(storageId);
  }
  return accounts;
}

function cursorMap(cursors) {
  if (!Array.isArray(cursors)) {
    throw new TypeError("changeCursors");
  }
  const mapped = new Map();
  for (const cursor of cursors) {
    const driveId = cursor?.driveId === null
      ? null
      : requireText(cursor?.driveId, "cursorDriveId");
    const pageToken = requireText(cursor?.pageToken, "cursorPageToken");
    if (mapped.has(driveId)) {
      throw new Error("Duplicate change cursor");
    }
    mapped.set(driveId, pageToken);
  }
  return mapped;
}

function sharedDriveIds(result) {
  if (!result || !Array.isArray(result.drives)) {
    throw new TypeError("sharedDrives");
  }
  const ids = new Set();
  for (const drive of result.drives) {
    ids.add(requireText(drive?.id, "sharedDriveId"));
  }
  return [...ids].sort();
}

function sharedDriveSet(cursors) {
  return new Set([...cursors.keys()].filter((driveId) => driveId !== null));
}

function setsDiffer(first, second) {
  return first.size !== second.size ||
    [...first].some((value) => !second.has(value));
}

function changeResult(result) {
  if (!result || !Array.isArray(result.changes)) {
    throw new TypeError("changeResult");
  }
  return {
    changed: result.changes.length > 0,
    pageToken: requireText(result.newStartPageToken, "newStartPageToken")
  };
}

export class GoogleDriveChangeMonitor {
  #accountRepository;
  #connectionService;
  #transport;
  #reportStorageChange;
  #apiClientFactory;
  #logger;
  #activePoll = null;
  #rerunRequested = false;

  constructor({
    accountRepository,
    connectionService,
    transport,
    reportStorageChange,
    logger,
    apiClientFactory = ({ transport: requestTransport, accountId }) =>
      new GoogleDriveApiClient({ transport: requestTransport, accountId })
  }) {
    for (const method of [
      "getAccount",
      "listChangeCursors",
      "replaceChangeCursors"
    ]) {
      requireMethod(accountRepository, method, "accountRepository");
    }
    requireMethod(connectionService, "listAuthorizedBindings", "connectionService");
    requireMethod(transport, "request", "transport");
    if (typeof reportStorageChange !== "function" ||
        typeof apiClientFactory !== "function") {
      throw new TypeError("changeMonitorDependencies");
    }
    this.#accountRepository = accountRepository;
    this.#connectionService = connectionService;
    this.#transport = transport;
    this.#reportStorageChange = reportStorageChange;
    this.#apiClientFactory = apiClientFactory;
    this.#logger = logger;
  }

  poll() {
    this.#rerunRequested = true;
    if (!this.#activePoll) {
      this.#activePoll = this.#drainPolls().finally(() => {
        this.#activePoll = null;
      });
    }
    return this.#activePoll;
  }

  async #drainPolls() {
    let result;
    do {
      this.#rerunRequested = false;
      result = await this.#pollOnce();
    } while (this.#rerunRequested);
    return result;
  }

  async #pollOnce() {
    const bindings = await this.#connectionService.listAuthorizedBindings();
    const accounts = groupBindings(bindings);
    let polled = 0;
    let failed = 0;
    this.#logger?.debug?.("drive.changes.poll.start", {
      connections: bindings.length
    });

    for (const [accountId, storageIds] of accounts) {
      try {
        const account = await this.#accountRepository.getAccount(accountId);
        if (!account || account.status !== "connected") {
          continue;
        }
        await this.#pollAccount(account.id, [...storageIds].sort());
        polled += 1;
      } catch (error) {
        failed += 1;
        this.#logger?.warn?.("drive.changes.account.failed", {
          error,
          phase: "poll"
        });
      }
    }

    const result = {
      connections: bindings.length,
      accounts: polled,
      failed
    };
    this.#logger?.debug?.("drive.changes.poll.complete", {
      connections: result.connections,
      status: failed ? "partial" : "complete"
    });
    return result;
  }

  async #pollAccount(accountId, storageIds) {
    const apiClient = this.#apiClientFactory({
      transport: this.#transport,
      accountId
    });
    for (const method of ["getStartPageToken", "listChanges", "listDrives"]) {
      requireMethod(apiClient, method, "apiClient");
    }

    const previous = cursorMap(
      await this.#accountRepository.listChangeCursors(accountId)
    );
    const initialBaseline = previous.size === 0;
    const driveIds = sharedDriveIds(await apiClient.listDrives({
      q: "hidden = false"
    }));
    const currentSharedDrives = new Set(driveIds);
    let changed = !initialBaseline && setsDiffer(
      sharedDriveSet(previous),
      currentSharedDrives
    );
    const replacements = [];

    const userResult = await this.#readScope(apiClient, previous, null);
    changed ||= userResult.changed;
    replacements.push({
      driveId: null,
      pageToken: userResult.pageToken
    });

    for (const driveId of driveIds) {
      const result = await this.#readScope(apiClient, previous, driveId);
      changed ||= result.changed;
      replacements.push({
        driveId,
        pageToken: result.pageToken
      });
    }

    if (!initialBaseline && changed) {
      for (const storageId of storageIds) {
        await this.#reportStorageChange(storageId, rootInvalidation());
      }
    }
    await this.#accountRepository.replaceChangeCursors(
      accountId,
      replacements
    );
  }

  async #readScope(apiClient, previous, driveId) {
    if (!previous.has(driveId)) {
      return {
        changed: false,
        pageToken: await apiClient.getStartPageToken(
          driveId === null ? {} : { driveId }
        )
      };
    }
    return changeResult(await apiClient.listChanges({
      pageToken: previous.get(driveId),
      ...(driveId === null ? {
        includeCorpusRemovals: true,
        restrictToMyDrive: false
      } : {
        driveId,
        includeCorpusRemovals: true
      })
    }));
  }
}
