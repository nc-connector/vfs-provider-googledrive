/**
 * VFS Toolkit adapter for account-bound Google Drive storage.
 */

"use strict";

import { RequestAbortRegistry } from "../core/request-aborts.mjs";
import { GoogleDriveApiClient } from "../google/drive-api-client.mjs";
import { GoogleDriveNamespace } from "../google/drive-namespace.mjs";
import { GoogleOAuthError } from "../google/oauth-client.mjs";
import {
  VfsProviderImplementation
} from "../vendor/vfs-toolkit/vfs-provider.mjs";

export const READ_ONLY_CAPABILITIES = Object.freeze({
  file: Object.freeze({
    read: true,
    add: false,
    modify: false,
    delete: false
  }),
  folder: Object.freeze({
    read: true,
    add: false,
    modify: false,
    delete: false
  })
});

const FALLBACK_MESSAGES = Object.freeze({
  vfsErrorAuthenticationTitle: "Google Drive sign-in required",
  vfsErrorAuthenticationDescription:
    "Open the provider settings and sign in to this Google account again.",
  vfsErrorRateLimitTitle: "Google Drive is busy",
  vfsErrorRateLimitDescription:
    "Google Drive asked the provider to wait. Try again later.",
  vfsErrorNetworkTitle: "Google Drive is unreachable",
  vfsErrorNetworkDescription:
    "Check the network connection and try again.",
  vfsErrorAccessTitle: "Google Drive access denied",
  vfsErrorAccessDescription:
    "The selected item cannot be read with this Google account.",
  vfsErrorUnavailableTitle: "Google Drive item unavailable",
  vfsErrorUnavailableDescription:
    "The selected item no longer exists or cannot be opened."
});

const AUTH_ERROR_CODES = new Set([
  "oauth_not_configured",
  "oauth_client_id_invalid",
  "oauth_reauthorization_required",
  "oauth_refresh_token_missing",
  "oauth_token_refresh_failed"
]);

function requireMethod(value, method, label) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(label);
  }
  return value;
}

function authError() {
  return Object.assign(new Error("Unauthorized storage connection"), {
    code: "E:AUTH"
  });
}

function localizedMessage(getMessage, key) {
  const message = getMessage(key);
  return typeof message === "string" && message
    ? message
    : FALLBACK_MESSAGES[key];
}

function providerError(getMessage, id, titleKey, descriptionKey, cause) {
  const error = Object.assign(new Error(id), {
    code: "E:PROVIDER",
    details: {
      id,
      title: localizedMessage(getMessage, titleKey),
      description: localizedMessage(getMessage, descriptionKey)
    }
  });
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

export function mapVfsProviderError(error, getMessage) {
  if (error?.name === "AbortError" ||
      error?.code === "E:AUTH" || error?.code === "E:PROVIDER") {
    return error;
  }
  if (error instanceof GoogleOAuthError ||
      AUTH_ERROR_CODES.has(error?.code) || error?.status === 401) {
    return providerError(
      getMessage,
      "google-drive-authentication",
      "vfsErrorAuthenticationTitle",
      "vfsErrorAuthenticationDescription",
      error
    );
  }
  if (error?.code === "drive_network_error") {
    return providerError(
      getMessage,
      "google-drive-network",
      "vfsErrorNetworkTitle",
      "vfsErrorNetworkDescription",
      error
    );
  }
  if (error?.code === "drive_retry_deferred" ||
      error?.status === 429 || error?.retryable === true) {
    return providerError(
      getMessage,
      "google-drive-rate-limit",
      "vfsErrorRateLimitTitle",
      "vfsErrorRateLimitDescription",
      error
    );
  }
  if (error?.status === 403 || error?.code === "drive_download_forbidden") {
    return providerError(
      getMessage,
      "google-drive-access",
      "vfsErrorAccessTitle",
      "vfsErrorAccessDescription",
      error
    );
  }
  return providerError(
    getMessage,
    "google-drive-unavailable",
    "vfsErrorUnavailableTitle",
    "vfsErrorUnavailableDescription",
    error
  );
}

export class GoogleDriveVfsProvider extends VfsProviderImplementation {
  #readiness;
  #accountRepository;
  #preferencesRepository;
  #transport;
  #rootLabels;
  #getMessage;
  #logger;
  #abortRegistry;
  #apiClientFactory;
  #namespaceFactory;

  constructor({
    name,
    readiness,
    accountRepository,
    preferencesRepository,
    transport,
    rootLabels,
    getMessage,
    logger,
    abortRegistry = new RequestAbortRegistry(),
    apiClientFactory = ({ transport: requestTransport, accountId }) =>
      new GoogleDriveApiClient({ transport: requestTransport, accountId }),
    namespaceFactory = (options) => new GoogleDriveNamespace(options),
    ...providerOptions
  }) {
    super({ name, ...providerOptions });
    this.#readiness = Promise.resolve(readiness);
    this.#accountRepository = requireMethod(
      accountRepository,
      "getConnectionBinding",
      "accountRepository"
    );
    requireMethod(accountRepository, "getAccount", "accountRepository");
    this.#preferencesRepository = requireMethod(
      preferencesRepository,
      "get",
      "preferencesRepository"
    );
    this.#transport = requireMethod(transport, "request", "transport");
    if (!rootLabels || typeof rootLabels !== "object") {
      throw new TypeError("rootLabels");
    }
    if (typeof getMessage !== "function" ||
        typeof apiClientFactory !== "function" ||
        typeof namespaceFactory !== "function") {
      throw new TypeError("providerDependencies");
    }
    requireMethod(abortRegistry, "run", "abortRegistry");
    requireMethod(abortRegistry, "cancel", "abortRegistry");
    this.#rootLabels = { ...rootLabels };
    this.#getMessage = getMessage;
    this.#logger = logger;
    this.#abortRegistry = abortRegistry;
    this.#apiClientFactory = apiClientFactory;
    this.#namespaceFactory = namespaceFactory;
  }

  async onCancel(canceledRequestId) {
    this.#abortRegistry.cancel(canceledRequestId);
  }

  async onStorageUsage(storageId) {
    return this.#run("storage_usage", storageId, async (namespace) =>
      namespace.getStorageUsage());
  }

  async onList(requestId, storageId, path) {
    return this.#abortRegistry.run(requestId, (signal) =>
      this.#run("list", storageId, (namespace) =>
        namespace.list(path, { signal })));
  }

  async onReadFile(requestId, storageId, path) {
    return this.#abortRegistry.run(requestId, (signal) =>
      this.#run("read_file", storageId, (namespace) =>
        namespace.readFile(path, { signal })));
  }

  async #run(operation, storageId, callback) {
    this.#logger?.debug?.("vfs.operation.start", { operation });
    try {
      const namespace = await this.#namespaceForStorage(storageId);
      const result = await callback(namespace);
      this.#logger?.debug?.("vfs.operation.complete", { operation });
      return result;
    } catch (error) {
      const mapped = mapVfsProviderError(error, this.#getMessage);
      if (mapped?.name !== "AbortError") {
        this.#logger?.warn?.("vfs.operation.failed", {
          operation,
          error: mapped
        });
      }
      throw mapped;
    }
  }

  async #namespaceForStorage(storageId) {
    await this.#readiness;
    if (typeof storageId !== "string" ||
        !storageId || storageId.trim() !== storageId) {
      throw authError();
    }
    const binding = await this.#accountRepository.getConnectionBinding(storageId);
    if (!binding) {
      throw authError();
    }
    const account = await this.#accountRepository.getAccount(binding.accountId);
    if (!account) {
      throw authError();
    }
    if (account.status !== "connected") {
      throw new GoogleOAuthError("oauth_reauthorization_required", 401);
    }
    const preferences = await this.#preferencesRepository.get();
    const apiClient = this.#apiClientFactory({
      transport: this.#transport,
      accountId: account.id
    });
    return this.#namespaceFactory({
      apiClient,
      exportFormats: preferences.exportFormats,
      rootLabels: this.#rootLabels
    });
  }
}
