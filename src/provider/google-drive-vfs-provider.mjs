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

export const GOOGLE_DRIVE_CAPABILITIES = Object.freeze({
  file: Object.freeze({
    read: true,
    add: true,
    modify: true,
    delete: true
  }),
  folder: Object.freeze({
    read: true,
    add: true,
    modify: true,
    delete: true
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
    "The selected item cannot be accessed with this Google account.",
  vfsErrorTrashTitle: "Cannot move item to trash",
  vfsErrorTrashDescription:
    "This Google account cannot move the selected item to the Google Drive trash.",
  vfsErrorMoveTitle: "Cannot move item",
  vfsErrorMoveDescription:
    "The selected item cannot be moved to this destination. Check the Google Drive permissions and restrictions.",
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
      error?.code === "E:AUTH" || error?.code === "E:EXIST" ||
      error?.code === "E:PROVIDER") {
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
  if (error?.status === 403 || error?.code === "drive_download_forbidden" ||
      error?.code === "drive_write_forbidden") {
    return providerError(
      getMessage,
      "google-drive-access",
      "vfsErrorAccessTitle",
      "vfsErrorAccessDescription",
      error
    );
  }
  if (error?.code === "drive_delete_forbidden") {
    return providerError(
      getMessage,
      "google-drive-trash-forbidden",
      "vfsErrorTrashTitle",
      "vfsErrorTrashDescription",
      error
    );
  }
  if (error?.code === "drive_move_forbidden" ||
      error?.code === "drive_move_unsupported") {
    return providerError(
      getMessage,
      "google-drive-move-forbidden",
      "vfsErrorMoveTitle",
      "vfsErrorMoveDescription",
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
  #connectionService;
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
    connectionService,
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
    this.#connectionService = requireMethod(
      connectionService,
      "getAuthorizedBinding",
      "connectionService"
    );
    this.#accountRepository = requireMethod(
      accountRepository,
      "getAccount",
      "accountRepository"
    );
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
    return this.#run("storage_usage", storageId, null, async (namespace) =>
      namespace.getStorageUsage());
  }

  async onList(requestId, storageId, path) {
    return this.#abortRegistry.run(requestId, (signal) =>
      this.#run("list", storageId, "folder.read", (namespace) =>
        namespace.list(path, { signal })));
  }

  async onReadFile(requestId, storageId, path) {
    return this.#abortRegistry.run(requestId, (signal) =>
      this.#run("read_file", storageId, "file.read", (namespace) =>
        namespace.readFile(path, { signal })));
  }

  async onWriteFile(requestId, storageId, path, file, overwrite) {
    const capability = overwrite ? "file.modify" : "file.add";
    return this.#abortRegistry.run(requestId, (signal) =>
      this.#run("write_file", storageId, capability, (namespace) =>
        namespace.writeFile(path, file, {
          overwrite,
          signal,
          onProgress: (percent) => this.reportProgress(requestId, percent)
        })));
  }

  async onAddFolder(requestId, storageId, path) {
    return this.#abortRegistry.run(requestId, (signal) =>
      this.#run("add_folder", storageId, "folder.add", (namespace) =>
        namespace.addFolder(path, {
          signal,
          onProgress: (percent) => this.reportProgress(requestId, percent)
        })));
  }

  async onMoveFile(requestId, storageId, oldPath, newPath, overwrite) {
    return this.#abortRegistry.run(requestId, (signal) =>
      this.#run("move_file", storageId, "file.modify", (namespace) =>
        namespace.moveFile(oldPath, newPath, {
          overwrite,
          signal,
          onProgress: (percent) => this.reportProgress(requestId, percent),
          onPartialChanges: (entries) =>
            this.reportStorageChange(storageId, entries)
        })));
  }

  async onMoveFolder(requestId, storageId, oldPath, newPath, merge) {
    return this.#abortRegistry.run(requestId, (signal) =>
      this.#run("move_folder", storageId, "folder.modify", (namespace) =>
        namespace.moveFolder(oldPath, newPath, {
          merge,
          signal,
          onProgress: (percent) => this.reportProgress(requestId, percent),
          onPartialChanges: (entries) =>
            this.reportStorageChange(storageId, entries)
        })));
  }

  async onDeleteFile(requestId, storageId, path) {
    return this.#abortRegistry.run(requestId, (signal) =>
      this.#run("delete_file", storageId, "file.delete", (namespace) =>
        namespace.deleteFile(path, {
          signal,
          onProgress: (percent) => this.reportProgress(requestId, percent)
        })));
  }

  async onDeleteFolder(requestId, storageId, path) {
    return this.#abortRegistry.run(requestId, (signal) =>
      this.#run("delete_folder", storageId, "folder.delete", (namespace) =>
        namespace.deleteFolder(path, {
          signal,
          onProgress: (percent) => this.reportProgress(requestId, percent)
        })));
  }

  async #run(operation, storageId, capability, callback) {
    this.#logger?.debug?.("vfs.operation.start", { operation });
    try {
      const namespace = await this.#namespaceForStorage(storageId, capability);
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

  async #namespaceForStorage(storageId, capability) {
    await this.#readiness;
    const binding = await this.#connectionService
      .getAuthorizedBinding(storageId, capability);
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
      rootLabels: this.#rootLabels,
      logger: this.#logger
    });
  }
}
