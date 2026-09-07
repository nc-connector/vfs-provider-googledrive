/**
 * Account bindings and Toolkit-owned VFS connection records.
 */

"use strict";

import { GOOGLE_DRIVE_CAPABILITIES } from "./google-drive-vfs-provider.mjs";
import {
  reportNewConnection
} from "../vendor/vfs-toolkit/vfs-provider.mjs";

export const VFS_TOOLKIT_CONNECTIONS_KEY = "vfs-toolkit-connections";

const MAX_CONNECTION_NAME_LENGTH = 120;

function clone(value) {
  return structuredClone(value);
}

function connectionError(code) {
  return new VfsConnectionError(code);
}

function unauthorizedStorageError() {
  return Object.assign(new Error("Unauthorized storage connection"), {
    code: "E:AUTH"
  });
}

function requiredString(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw connectionError("connection_request_invalid");
  }
  return value.trim();
}

function connectionName(value) {
  const normalized = requiredString(value);
  if (normalized.length > MAX_CONNECTION_NAME_LENGTH) {
    throw connectionError("connection_request_invalid");
  }
  return normalized;
}

function optionalLabel(value, fallback) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  return value.trim().slice(0, MAX_CONNECTION_NAME_LENGTH);
}

function isStoredConnection(value) {
  return value && typeof value === "object" &&
    typeof value.storageId === "string" && value.storageId.trim() &&
    typeof value.addonId === "string" && value.addonId.trim();
}

function supportsCapability(connection, capability) {
  if (!capability) {
    return true;
  }
  const [kind, action, extra] = capability.split(".");
  return !extra && (kind === "file" || kind === "folder") &&
    typeof action === "string" &&
    connection.capabilities?.[kind]?.[action] === true;
}

function hasCurrentCapabilities(connection) {
  return ["file", "folder"].every((kind) =>
    ["read", "add", "modify", "delete"].every((action) =>
      connection.capabilities?.[kind]?.[action] ===
        GOOGLE_DRIVE_CAPABILITIES[kind][action]));
}

export class VfsConnectionError extends Error {
  constructor(code) {
    super(code);
    this.name = "VfsConnectionError";
    this.code = code;
  }
}

export class VfsConnectionService {
  #storageArea;
  #accountRepository;
  #reportConnection;
  #randomUUID;
  #logger;
  #operationQueue = Promise.resolve();

  constructor({
    storageArea,
    accountRepository,
    reportConnection = reportNewConnection,
    randomUUID = () => crypto.randomUUID(),
    logger
  }) {
    if (!storageArea?.get) {
      throw new TypeError("storageArea");
    }
    for (const method of [
      "bindConnection",
      "getAccount",
      "getConnectionBinding",
      "listConnectionBindings",
      "reconcileConnectionBindings",
      "removeConnectionBinding"
    ]) {
      if (typeof accountRepository?.[method] !== "function") {
        throw new TypeError("accountRepository");
      }
    }
    if (typeof reportConnection !== "function" ||
        typeof randomUUID !== "function") {
      throw new TypeError("connectionDependencies");
    }
    this.#storageArea = storageArea;
    this.#accountRepository = accountRepository;
    this.#reportConnection = reportConnection;
    this.#randomUUID = randomUUID;
    this.#logger = logger;
  }

  async initialize() {
    return this.reconcileToolkitConnections();
  }

  async reconcileToolkitConnections() {
    return this.#enqueue(async () => {
      const current = await this.#readConnections();
      const removed = await this.#reconcile(current);
      const updated = await this.#updateCapabilities(current);
      this.#logger?.debug?.("vfs.connection.reconciled", {
        connections: current.length,
        status: removed.length
          ? "stale_removed"
          : updated ? "capabilities_updated" : "current"
      });
      return removed;
    });
  }

  async getAuthorizedBinding(storageId, capability) {
    if (typeof storageId !== "string" ||
        !storageId || storageId.trim() !== storageId) {
      throw unauthorizedStorageError();
    }
    return this.#enqueue(async () => {
      const connections = await this.#readConnections();
      const matches = connections.filter((entry) =>
        entry.storageId === storageId);
      if (matches.length !== 1 ||
          !supportsCapability(matches[0], capability)) {
        throw unauthorizedStorageError();
      }
      const binding = await this.#accountRepository
        .getConnectionBinding(storageId);
      if (!binding) {
        throw unauthorizedStorageError();
      }
      return binding;
    });
  }

  async getConnection({ addonId, storageId }) {
    const requestedAddonId = requiredString(addonId);
    const requestedStorageId = requiredString(storageId);
    return this.#enqueue(async () => {
      const connections = await this.#readConnections();
      const matches = connections.filter((entry) =>
        entry.storageId === requestedStorageId);
      if (matches.length !== 1 || matches[0].addonId !== requestedAddonId) {
        throw connectionError("connection_not_found");
      }
      const binding = await this.#accountRepository
        .getConnectionBinding(requestedStorageId);
      if (!binding) {
        throw connectionError("connection_not_found");
      }
      return {
        addonId: matches[0].addonId,
        addonName: optionalLabel(matches[0].addonName, matches[0].addonId),
        storageId: matches[0].storageId,
        name: optionalLabel(matches[0].name, "Google Drive"),
        accountId: binding.accountId
      };
    });
  }

  async createConnection({
    addonId,
    addonName,
    accountId,
    name,
    setupToken
  }) {
    const requestedAddonId = requiredString(addonId);
    const requestedAccountId = requiredString(accountId);
    const requestedSetupToken = requiredString(setupToken);
    const requestedName = connectionName(name);

    return this.#enqueue(async () => {
      const current = await this.#readConnections();
      await this.#reconcile(current);
      await this.#requireConnectedAccount(requestedAccountId);
      const storageId = await this.#newStorageId(current);
      await this.#accountRepository.bindConnection({
        storageId,
        accountId: requestedAccountId
      });
      try {
        await this.#reportConnection(
          requestedAddonId,
          optionalLabel(addonName, requestedAddonId),
          storageId,
          requestedName,
          clone(GOOGLE_DRIVE_CAPABILITIES),
          requestedSetupToken
        );
      } catch (error) {
        await this.#accountRepository.removeConnectionBinding(storageId);
        this.#logger?.warn?.("vfs.connection.create_failed", { error });
        throw error;
      }
      this.#logger?.info?.("vfs.connection.created", {
        status: "connected"
      });
      return {
        storageId,
        name: requestedName,
        accountId: requestedAccountId
      };
    });
  }

  async updateConnection({ addonId, storageId, accountId, name }) {
    const requestedAddonId = requiredString(addonId);
    const requestedStorageId = requiredString(storageId);
    const requestedAccountId = requiredString(accountId);
    const requestedName = connectionName(name);

    return this.#enqueue(async () => {
      const current = await this.#readConnections();
      const matches = current.filter((entry) =>
        entry.storageId === requestedStorageId);
      if (matches.length !== 1 || matches[0].addonId !== requestedAddonId) {
        throw connectionError("connection_not_found");
      }
      await this.#requireConnectedAccount(requestedAccountId);
      const previousBinding = await this.#accountRepository
        .getConnectionBinding(requestedStorageId);
      if (!previousBinding) {
        throw connectionError("connection_not_found");
      }
      await this.#accountRepository.bindConnection({
        storageId: requestedStorageId,
        accountId: requestedAccountId
      });
      try {
        await this.#reportConnection(
          matches[0].addonId,
          optionalLabel(matches[0].addonName, matches[0].addonId),
          requestedStorageId,
          requestedName,
          clone(GOOGLE_DRIVE_CAPABILITIES)
        );
      } catch (error) {
        await this.#accountRepository.bindConnection(previousBinding);
        this.#logger?.warn?.("vfs.connection.update_failed", { error });
        throw error;
      }
      this.#logger?.info?.("vfs.connection.updated", {
        status: "connected"
      });
      return {
        storageId: requestedStorageId,
        name: requestedName,
        accountId: requestedAccountId
      };
    });
  }

  async disconnectAccount(accountId, disconnect) {
    const requestedAccountId = requiredString(accountId);
    if (typeof disconnect !== "function") {
      throw new TypeError("disconnect");
    }
    return this.#enqueue(async () => {
      const current = await this.#readConnections();
      await this.#reconcile(current);
      const bindings = await this.#accountRepository.listConnectionBindings();
      if (bindings.some((binding) =>
        binding.accountId === requestedAccountId)) {
        this.#logger?.warn?.("vfs.account.disconnect_blocked", {
          status: "connections_present"
        });
        throw connectionError("account_has_connections");
      }
      return disconnect();
    });
  }

  async #readConnections() {
    const stored = await this.#storageArea.get({
      [VFS_TOOLKIT_CONNECTIONS_KEY]: []
    });
    return this.#normalizeConnections(stored[VFS_TOOLKIT_CONNECTIONS_KEY]);
  }

  #normalizeConnections(value) {
    return Array.isArray(value)
      ? clone(value.filter(isStoredConnection))
      : [];
  }

  async #reconcile(connections) {
    return this.#accountRepository.reconcileConnectionBindings(
      [...new Set(connections.map((entry) => entry.storageId))]
    );
  }

  async #updateCapabilities(connections) {
    const counts = new Map();
    for (const connection of connections) {
      counts.set(
        connection.storageId,
        (counts.get(connection.storageId) || 0) + 1
      );
    }
    const bindings = await this.#accountRepository.listConnectionBindings();
    const boundStorageIds = new Set(bindings.map((entry) => entry.storageId));
    let updated = 0;
    for (const connection of connections) {
      if (counts.get(connection.storageId) !== 1 ||
          !boundStorageIds.has(connection.storageId) ||
          hasCurrentCapabilities(connection)) {
        continue;
      }
      try {
        await this.#reportConnection(
          connection.addonId,
          optionalLabel(connection.addonName, connection.addonId),
          connection.storageId,
          optionalLabel(connection.name, "Google Drive"),
          clone(GOOGLE_DRIVE_CAPABILITIES)
        );
        updated += 1;
      } catch (error) {
        this.#logger?.warn?.("vfs.connection.capabilities_update_failed", {
          error,
          status: "update_failed"
        });
      }
    }
    return updated;
  }

  async #requireConnectedAccount(accountId) {
    const account = await this.#accountRepository.getAccount(accountId);
    if (!account || account.status !== "connected") {
      throw connectionError("connection_account_unavailable");
    }
    return account;
  }

  async #newStorageId(connections) {
    const bindings = await this.#accountRepository.listConnectionBindings();
    const used = new Set([
      ...connections.map((entry) => entry.storageId),
      ...bindings.map((entry) => entry.storageId)
    ]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const storageId = this.#randomUUID();
      if (typeof storageId === "string" && storageId.trim() === storageId &&
          storageId && !used.has(storageId)) {
        return storageId;
      }
    }
    throw connectionError("connection_create_failed");
  }

  #enqueue(operation) {
    const pending = this.#operationQueue.then(operation);
    this.#operationQueue = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }
}
