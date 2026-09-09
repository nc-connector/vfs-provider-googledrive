/**
 * Effective Google OAuth configuration from local settings or enterprise policy.
 */

"use strict";

export const OAUTH_CONFIGURATION_KEY = "google-drive-oauth-configuration";
export const OAUTH_CONFIGURATION_VERSION = 1;
export const OAUTH_MODE_BUILTIN = "builtin";
export const OAUTH_MODE_CUSTOM = "custom";
export const MANAGED_OAUTH_KEYS = Object.freeze([
  "OAuthMode",
  "OAuthClientId",
  "OAuthClientSecret"
]);

const OAUTH_MODES = new Set([
  OAUTH_MODE_BUILTIN,
  OAUTH_MODE_CUSTOM
]);
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/;
const MANAGED_STORAGE_MISSING = "managed storage manifest not found";
const INVALID_CREDENTIAL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function clone(value) {
  return structuredClone(value);
}

function configurationError(code, cause) {
  const error = new OAuthConfigurationError(code);
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function optionalText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requireMode(value, code = "oauth_configuration_invalid") {
  const mode = optionalText(value);
  if (!OAUTH_MODES.has(mode)) {
    throw configurationError(code);
  }
  return mode;
}

function requireClientId(value, code = "oauth_client_id_invalid") {
  const clientId = optionalText(value);
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    throw configurationError(code);
  }
  return clientId;
}

function requireClientSecret(value, code = "oauth_client_secret_required") {
  const clientSecret = optionalText(value);
  if (!clientSecret || INVALID_CREDENTIAL_CHARACTER.test(clientSecret)) {
    throw configurationError(code);
  }
  return clientSecret;
}

function createDefaultLocalConfiguration() {
  return {
    version: OAUTH_CONFIGURATION_VERSION,
    mode: OAUTH_MODE_BUILTIN,
    customClientId: "",
    customClientSecret: ""
  };
}

function normalizeLocalConfiguration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.version !== OAUTH_CONFIGURATION_VERSION) {
    throw configurationError("oauth_configuration_invalid");
  }
  const mode = requireMode(value.mode);
  const customClientId = optionalText(value.customClientId);
  const customClientSecret = optionalText(value.customClientSecret);
  const hasCustomValue = Boolean(customClientId || customClientSecret);
  if (mode === OAUTH_MODE_CUSTOM || hasCustomValue) {
    requireClientId(customClientId);
    requireClientSecret(customClientSecret);
  }
  return {
    version: OAUTH_CONFIGURATION_VERSION,
    mode,
    customClientId,
    customClientSecret
  };
}

function hasManagedOAuthValue(value) {
  return MANAGED_OAUTH_KEYS.some((key) => Object.hasOwn(value, key));
}

function hasUnknownManagedOAuthValue(value) {
  return Object.keys(value).some((key) => !MANAGED_OAUTH_KEYS.includes(key));
}

function normalizeManagedConfiguration(value, builtIn) {
  if (value === undefined) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configurationError("oauth_managed_policy_invalid");
  }
  if (Object.keys(value).length === 0) {
    return null;
  }
  if (!hasManagedOAuthValue(value) || hasUnknownManagedOAuthValue(value)) {
    throw configurationError("oauth_managed_policy_invalid");
  }
  const mode = requireMode(value.OAuthMode, "oauth_managed_policy_invalid");
  if (mode === OAUTH_MODE_BUILTIN) {
    return {
      mode,
      source: "managed",
      locked: true,
      clientId: requireClientId(builtIn.clientId, "oauth_not_configured"),
      clientSecret: requireClientSecret(
        builtIn.clientSecret,
        "oauth_not_configured"
      )
    };
  }
  return {
    mode,
    source: "managed",
    locked: true,
    clientId: requireClientId(
      value.OAuthClientId,
      "oauth_managed_policy_invalid"
    ),
    clientSecret: requireClientSecret(
      value.OAuthClientSecret,
      "oauth_managed_policy_invalid"
    )
  };
}

function publicConfiguration(configuration, local) {
  const customClientId = configuration.mode === OAUTH_MODE_CUSTOM
    ? configuration.clientId
    : local?.customClientId || "";
  return {
    mode: configuration.mode,
    source: configuration.source,
    locked: configuration.locked,
    clientId: configuration.clientId,
    hasClientSecret: Boolean(configuration.clientSecret),
    customClientId,
    hasCustomClientSecret: configuration.mode === OAUTH_MODE_CUSTOM
      ? Boolean(configuration.clientSecret)
      : Boolean(local?.customClientSecret)
  };
}

export class OAuthConfigurationError extends Error {
  constructor(code) {
    super(code);
    this.name = "OAuthConfigurationError";
    this.code = code;
  }
}

export class OAuthConfigurationRepository {
  #localStorageArea;
  #managedStorageArea;
  #builtIn;
  #local = null;
  #managed = undefined;
  #writeQueue = Promise.resolve();

  constructor({
    localStorageArea,
    managedStorageArea,
    builtInClientId,
    builtInClientSecret
  }) {
    if (!localStorageArea?.get || !localStorageArea?.set ||
        !managedStorageArea?.get) {
      throw new TypeError("OAuth configuration storage areas are required");
    }
    this.#localStorageArea = localStorageArea;
    this.#managedStorageArea = managedStorageArea;
    this.#builtIn = {
      clientId: builtInClientId,
      clientSecret: builtInClientSecret
    };
  }

  async initialize() {
    this.#managed = await this.#readManaged();
    if (!this.#managed) {
      this.#local = await this.#readLocal();
    }
    return this.getPublic();
  }

  getEffective() {
    const configuration = this.#effectiveConfiguration();
    return clone(configuration);
  }

  getPublic() {
    return publicConfiguration(
      this.#effectiveConfiguration(),
      this.#managed ? null : this.#local
    );
  }

  isAccountCompatible(account) {
    if (!account || account.status !== "connected") {
      return false;
    }
    return optionalText(account.oauthClientId) ===
      this.#effectiveConfiguration().clientId;
  }

  accountStatus(account) {
    return this.isAccountCompatible(account)
      ? "connected"
      : "reauthorization_required";
  }

  async updateLocal({ mode, clientId, clientSecret } = {}) {
    if (this.#managed) {
      throw configurationError("oauth_configuration_managed");
    }
    const operation = this.#writeQueue.then(async () => {
      const requestedMode = requireMode(mode);
      const current = this.#requireLocal();
      let customClientId = current.customClientId;
      let customClientSecret = current.customClientSecret;

      if (requestedMode === OAUTH_MODE_CUSTOM) {
        customClientId = requireClientId(clientId);
        const suppliedSecret = optionalText(clientSecret);
        if (suppliedSecret) {
          customClientSecret = suppliedSecret;
        } else if (customClientId !== current.customClientId ||
            !current.customClientSecret) {
          throw configurationError("oauth_client_secret_required");
        }
      }

      const next = normalizeLocalConfiguration({
        version: OAUTH_CONFIGURATION_VERSION,
        mode: requestedMode,
        customClientId,
        customClientSecret
      });
      await this.#localStorageArea.set({
        [OAUTH_CONFIGURATION_KEY]: next
      });
      this.#local = next;
      return this.getPublic();
    });
    this.#writeQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  #effectiveConfiguration() {
    if (this.#managed === undefined) {
      throw configurationError("oauth_configuration_uninitialized");
    }
    if (this.#managed) {
      return this.#managed;
    }
    const local = this.#requireLocal();
    if (local.mode === OAUTH_MODE_CUSTOM) {
      return {
        mode: OAUTH_MODE_CUSTOM,
        source: "local",
        locked: false,
        clientId: local.customClientId,
        clientSecret: local.customClientSecret
      };
    }
    return {
      mode: OAUTH_MODE_BUILTIN,
      source: "local",
      locked: false,
      clientId: requireClientId(
        this.#builtIn.clientId,
        "oauth_not_configured"
      ),
      clientSecret: requireClientSecret(
        this.#builtIn.clientSecret,
        "oauth_not_configured"
      )
    };
  }

  #requireLocal() {
    if (!this.#local) {
      throw configurationError("oauth_configuration_uninitialized");
    }
    return this.#local;
  }

  async #readLocal() {
    const stored = await this.#localStorageArea.get(OAUTH_CONFIGURATION_KEY);
    if (!Object.hasOwn(stored, OAUTH_CONFIGURATION_KEY)) {
      const initial = createDefaultLocalConfiguration();
      await this.#localStorageArea.set({
        [OAUTH_CONFIGURATION_KEY]: initial
      });
      return initial;
    }
    return normalizeLocalConfiguration(stored[OAUTH_CONFIGURATION_KEY]);
  }

  async #readManaged() {
    let stored;
    try {
      stored = await this.#managedStorageArea.get();
    } catch (error) {
      const message = String(error?.message || "")
        .trim()
        .replace(/[.!]+$/u, "")
        .toLowerCase();
      if (message === MANAGED_STORAGE_MISSING) {
        return null;
      }
      throw configurationError("oauth_managed_policy_read_failed", error);
    }
    return normalizeManagedConfiguration(stored, this.#builtIn);
  }
}
