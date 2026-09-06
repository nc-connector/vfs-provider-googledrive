/**
 * Persistent Google account and VFS connection state.
 */

"use strict";

export const PROVIDER_STATE_KEY = "google-drive-provider-state";
export const PROVIDER_STATE_VERSION = 1;

const ACCOUNT_STATUSES = new Set([
  "connected",
  "reauthorization_required"
]);

function clone(value) {
  return structuredClone(value);
}

function createEmptyState() {
  return {
    version: PROVIDER_STATE_VERSION,
    accounts: [],
    connectionBindings: []
  };
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOptionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function publicAccount(account) {
  const {
    refreshToken: _refreshToken,
    ...metadata
  } = account;
  return clone(metadata);
}

function validateStoredState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored provider state is invalid");
  }
  if (value.version !== PROVIDER_STATE_VERSION) {
    throw new Error(`Unsupported provider state version: ${value.version}`);
  }
  if (!Array.isArray(value.accounts) || !Array.isArray(value.connectionBindings)) {
    throw new Error("Stored provider state collections are invalid");
  }
  return clone(value);
}

export class ProviderStateRepository {
  #storageArea;
  #now;
  #randomUUID;
  #writeQueue = Promise.resolve();

  constructor({
    storageArea,
    now = () => Date.now(),
    randomUUID = () => crypto.randomUUID()
  }) {
    if (!storageArea?.get || !storageArea?.set) {
      throw new TypeError("A WebExtension storage area is required");
    }
    this.#storageArea = storageArea;
    this.#now = now;
    this.#randomUUID = randomUUID;
  }

  async initialize() {
    const stored = await this.#storageArea.get(PROVIDER_STATE_KEY);
    if (!Object.hasOwn(stored, PROVIDER_STATE_KEY)) {
      const state = createEmptyState();
      await this.#storageArea.set({ [PROVIDER_STATE_KEY]: state });
      return clone(state);
    }
    return validateStoredState(stored[PROVIDER_STATE_KEY]);
  }

  async listAccounts() {
    const state = await this.#read();
    return state.accounts.map(publicAccount);
  }

  async getAccount(accountId) {
    const normalizedId = requireNonEmptyString(accountId, "accountId");
    const state = await this.#read();
    const account = state.accounts.find((entry) => entry.id === normalizedId);
    return account ? publicAccount(account) : null;
  }

  async getAccountAuthorization(accountId) {
    const normalizedId = requireNonEmptyString(accountId, "accountId");
    const state = await this.#read();
    const account = state.accounts.find((entry) => entry.id === normalizedId);
    if (!account) {
      return null;
    }
    return {
      accountId: account.id,
      refreshToken: account.refreshToken,
      status: account.status
    };
  }

  async upsertAccount({
    id,
    googleUserId,
    displayName,
    emailAddress,
    refreshToken,
    status = "connected"
  }) {
    const normalizedGoogleUserId = requireNonEmptyString(googleUserId, "googleUserId");
    if (!ACCOUNT_STATUSES.has(status)) {
      throw new TypeError(`Unsupported account status: ${status}`);
    }

    return this.#mutate((state) => {
      const requestedId = normalizeOptionalString(id);
      const index = state.accounts.findIndex((entry) =>
        entry.googleUserId === normalizedGoogleUserId ||
        (requestedId && entry.id === requestedId)
      );
      const existing = index >= 0 ? state.accounts[index] : null;
      const normalizedRefreshToken = normalizeOptionalString(refreshToken) || existing?.refreshToken;
      if (!normalizedRefreshToken) {
        throw new TypeError("refreshToken is required for a new account");
      }

      const timestamp = this.#now();
      const account = {
        id: existing?.id || requestedId || this.#randomUUID(),
        googleUserId: normalizedGoogleUserId,
        displayName: normalizeOptionalString(displayName),
        emailAddress: normalizeOptionalString(emailAddress),
        refreshToken: normalizedRefreshToken,
        status,
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp
      };

      if (index >= 0) {
        state.accounts[index] = account;
      } else {
        state.accounts.push(account);
      }
      return publicAccount(account);
    });
  }

  async setAccountStatus(accountId, status) {
    const normalizedId = requireNonEmptyString(accountId, "accountId");
    if (!ACCOUNT_STATUSES.has(status)) {
      throw new TypeError(`Unsupported account status: ${status}`);
    }
    return this.#mutate((state) => {
      const account = state.accounts.find((entry) => entry.id === normalizedId);
      if (!account) {
        return null;
      }
      account.status = status;
      account.updatedAt = this.#now();
      return publicAccount(account);
    });
  }

  async removeAccount(accountId) {
    const normalizedId = requireNonEmptyString(accountId, "accountId");
    return this.#mutate((state) => {
      const accountIndex = state.accounts.findIndex((entry) => entry.id === normalizedId);
      if (accountIndex < 0) {
        return null;
      }
      const [account] = state.accounts.splice(accountIndex, 1);
      const removedStorageIds = state.connectionBindings
        .filter((binding) => binding.accountId === normalizedId)
        .map((binding) => binding.storageId);
      state.connectionBindings = state.connectionBindings
        .filter((binding) => binding.accountId !== normalizedId);
      return {
        account: publicAccount(account),
        removedStorageIds
      };
    });
  }

  async listConnectionBindings() {
    const state = await this.#read();
    return clone(state.connectionBindings);
  }

  async getConnectionBinding(storageId) {
    const normalizedStorageId = requireNonEmptyString(storageId, "storageId");
    const state = await this.#read();
    const binding = state.connectionBindings
      .find((entry) => entry.storageId === normalizedStorageId);
    return binding ? clone(binding) : null;
  }

  async bindConnection({ storageId, accountId }) {
    const normalizedStorageId = requireNonEmptyString(storageId, "storageId");
    const normalizedAccountId = requireNonEmptyString(accountId, "accountId");
    return this.#mutate((state) => {
      if (!state.accounts.some((account) => account.id === normalizedAccountId)) {
        throw new Error(`Unknown account: ${normalizedAccountId}`);
      }

      const timestamp = this.#now();
      const index = state.connectionBindings
        .findIndex((entry) => entry.storageId === normalizedStorageId);
      const existing = index >= 0 ? state.connectionBindings[index] : null;
      const binding = {
        storageId: normalizedStorageId,
        accountId: normalizedAccountId,
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp
      };
      if (index >= 0) {
        state.connectionBindings[index] = binding;
      } else {
        state.connectionBindings.push(binding);
      }
      return clone(binding);
    });
  }

  async removeConnectionBinding(storageId) {
    const normalizedStorageId = requireNonEmptyString(storageId, "storageId");
    return this.#mutate((state) => {
      const index = state.connectionBindings
        .findIndex((entry) => entry.storageId === normalizedStorageId);
      if (index < 0) {
        return null;
      }
      const [binding] = state.connectionBindings.splice(index, 1);
      return clone(binding);
    });
  }

  async reconcileConnectionBindings(validStorageIds) {
    const valid = new Set(validStorageIds.map((storageId) =>
      requireNonEmptyString(storageId, "storageId")
    ));
    return this.#mutate((state) => {
      const removedStorageIds = state.connectionBindings
        .filter((binding) => !valid.has(binding.storageId))
        .map((binding) => binding.storageId);
      state.connectionBindings = state.connectionBindings
        .filter((binding) => valid.has(binding.storageId));
      return removedStorageIds;
    });
  }

  async #read() {
    const stored = await this.#storageArea.get(PROVIDER_STATE_KEY);
    if (!Object.hasOwn(stored, PROVIDER_STATE_KEY)) {
      return this.initialize();
    }
    return validateStoredState(stored[PROVIDER_STATE_KEY]);
  }

  async #mutate(mutator) {
    const operation = this.#writeQueue.then(async () => {
      const state = await this.#read();
      const result = mutator(state);
      await this.#storageArea.set({ [PROVIDER_STATE_KEY]: state });
      return clone(result);
    });
    this.#writeQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }
}
