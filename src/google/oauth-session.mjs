/**
 * Session-scoped OAuth transactions and access tokens.
 */

"use strict";

export const OAUTH_SESSION_KEY = "google-drive-oauth-session";
export const OAUTH_SESSION_VERSION = 1;

function clone(value) {
  return structuredClone(value);
}

function createEmptySession() {
  return {
    version: OAUTH_SESSION_VERSION,
    accessTokens: {},
    transactions: {}
  };
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored OAuth session is invalid");
  }
  if (value.version !== OAUTH_SESSION_VERSION) {
    throw new Error(`Unsupported OAuth session version: ${value.version}`);
  }
  if (!value.accessTokens || typeof value.accessTokens !== "object" ||
      Array.isArray(value.accessTokens) || !value.transactions ||
      typeof value.transactions !== "object" || Array.isArray(value.transactions)) {
    throw new Error("Stored OAuth session collections are invalid");
  }
  return clone(value);
}

export class OAuthSessionRepository {
  #storageArea;
  #now;
  #writeQueue = Promise.resolve();

  constructor({ storageArea, now = () => Date.now() }) {
    if (!storageArea?.get || !storageArea?.set) {
      throw new TypeError("A WebExtension session storage area is required");
    }
    this.#storageArea = storageArea;
    this.#now = now;
  }

  async initialize() {
    const stored = await this.#storageArea.get(OAUTH_SESSION_KEY);
    if (!Object.hasOwn(stored, OAUTH_SESSION_KEY)) {
      const session = createEmptySession();
      await this.#storageArea.set({ [OAUTH_SESSION_KEY]: session });
      return clone(session);
    }
    return normalizeSession(stored[OAUTH_SESSION_KEY]);
  }

  async getAccessToken(accountId, minimumValidityMs = 60_000) {
    const normalizedAccountId = requireNonEmptyString(accountId, "accountId");
    const session = await this.#read();
    const entry = session.accessTokens[normalizedAccountId];
    if (!entry || typeof entry.accessToken !== "string" ||
        !Number.isFinite(entry.expiresAt) ||
        entry.expiresAt <= this.#now() + minimumValidityMs) {
      return null;
    }
    return entry.accessToken;
  }

  async setAccessToken(accountId, accessToken, expiresAt) {
    const normalizedAccountId = requireNonEmptyString(accountId, "accountId");
    const normalizedToken = requireNonEmptyString(accessToken, "accessToken");
    if (!Number.isFinite(expiresAt) || expiresAt <= this.#now()) {
      throw new TypeError("expiresAt must be a future timestamp");
    }
    await this.#mutate((session) => {
      session.accessTokens[normalizedAccountId] = {
        accessToken: normalizedToken,
        expiresAt
      };
    });
  }

  async clearAccessToken(accountId) {
    const normalizedAccountId = requireNonEmptyString(accountId, "accountId");
    await this.#mutate((session) => {
      delete session.accessTokens[normalizedAccountId];
    });
  }

  async storeTransaction({ state, codeVerifier, clientId, createdAt = this.#now() }) {
    const normalizedState = requireNonEmptyString(state, "state");
    const transaction = {
      state: normalizedState,
      codeVerifier: requireNonEmptyString(codeVerifier, "codeVerifier"),
      clientId: requireNonEmptyString(clientId, "clientId"),
      createdAt
    };
    await this.#mutate((session) => {
      session.transactions[normalizedState] = transaction;
    });
    return clone(transaction);
  }

  async getTransaction(state) {
    const normalizedState = requireNonEmptyString(state, "state");
    const session = await this.#read();
    const transaction = session.transactions[normalizedState];
    return transaction ? clone(transaction) : null;
  }

  async deleteTransaction(state) {
    const normalizedState = requireNonEmptyString(state, "state");
    await this.#mutate((session) => {
      delete session.transactions[normalizedState];
    });
  }

  async removeExpiredTransactions(maxAgeMs) {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      throw new TypeError("maxAgeMs must be positive");
    }
    const cutoff = this.#now() - maxAgeMs;
    return this.#mutate((session) => {
      const removed = [];
      for (const [state, transaction] of Object.entries(session.transactions)) {
        if (!Number.isFinite(transaction.createdAt) || transaction.createdAt < cutoff) {
          delete session.transactions[state];
          removed.push(state);
        }
      }
      return removed;
    });
  }

  async #read() {
    const stored = await this.#storageArea.get(OAUTH_SESSION_KEY);
    if (!Object.hasOwn(stored, OAUTH_SESSION_KEY)) {
      return this.initialize();
    }
    return normalizeSession(stored[OAUTH_SESSION_KEY]);
  }

  async #mutate(mutator) {
    const operation = this.#writeQueue.then(async () => {
      const session = await this.#read();
      const result = mutator(session);
      await this.#storageArea.set({ [OAUTH_SESSION_KEY]: session });
      return clone(result);
    });
    this.#writeQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }
}
