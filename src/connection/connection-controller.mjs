/**
 * DOM-independent controller for VFS connection setup and configuration.
 */

"use strict";

const MESSAGE_TYPES = Object.freeze({
  listAccounts: "googleDrive:accounts:list",
  authorizeAccount: "googleDrive:account:authorize",
  getConnection: "googleDrive:vfs:connection:get",
  createConnection: "googleDrive:vfs:connection:create",
  updateConnection: "googleDrive:vfs:connection:update"
});

const ERROR_MESSAGE_KEYS = Object.freeze({
  connection_request_invalid: "vfsConnectionErrorInvalidRequest",
  connection_not_found: "vfsConnectionErrorNotFound",
  connection_account_unavailable: "vfsConnectionErrorAccountUnavailable",
  connection_create_failed: "vfsConnectionErrorUnexpected",
  oauth_cancelled: "optionsErrorOAuthCancelled",
  oauth_denied: "optionsErrorOAuthCancelled",
  oauth_account_mismatch: "optionsErrorOAuthAccountMismatch",
  oauth_flow_failed: "optionsErrorOAuthGeneric",
  oauth_request_timeout: "vfsErrorNetworkDescription",
  oauth_reauthorization_required: "optionsErrorOAuthReauthorizationRequired",
  oauth_token_refresh_failed: "optionsErrorOAuthReauthorizationRequired",
  oauth_refresh_token_missing: "optionsErrorOAuthReauthorizationRequired",
  unexpected_error: "vfsConnectionErrorUnexpected"
});

export class ConnectionControllerError extends Error {
  constructor(code) {
    super(code);
    this.name = "ConnectionControllerError";
    this.code = code;
  }
}

export function parseConnectionContext(search, mode) {
  if (mode !== "setup" && mode !== "config") {
    throw new ConnectionControllerError("connection_request_invalid");
  }
  const params = new URLSearchParams(search);
  const addonId = params.get("addonId")?.trim();
  const addonName = params.get("addonName")?.trim() || addonId;
  const setupToken = params.get("setupToken")?.trim();
  const storageId = params.get("storageId")?.trim();
  if (!addonId || (mode === "setup" && !setupToken) ||
      (mode === "config" && !storageId)) {
    throw new ConnectionControllerError("connection_request_invalid");
  }
  return { mode, addonId, addonName, setupToken, storageId };
}

export function connectionAccountViewModels(accounts, getMessage) {
  if (!Array.isArray(accounts)) {
    return [];
  }
  return accounts.map((account) => {
    const primary = account.displayName || account.emailAddress ||
      getMessage("optionsAccountFallback");
    const secondary = account.emailAddress && account.emailAddress !== primary
      ? account.emailAddress
      : "";
    return {
      id: account.id,
      label: secondary ? `${primary} — ${secondary}` : primary,
      connectionLabel: account.emailAddress || primary,
      connected: account.status === "connected"
    };
  });
}

export function connectionErrorMessageKey(errorCode) {
  return ERROR_MESSAGE_KEYS[errorCode] || "vfsConnectionErrorUnexpected";
}

export function createConnectionController({
  context,
  sendMessage,
  getMessage,
  view,
  closeWindow
}) {
  if (!context || typeof sendMessage !== "function" ||
      typeof getMessage !== "function" || typeof closeWindow !== "function") {
    throw new TypeError("connectionControllerDependencies");
  }

  async function request(type, payload = {}) {
    const response = await sendMessage({ type, ...payload });
    if (!response?.ok) {
      throw new ConnectionControllerError(
        response?.errorCode || "unexpected_error"
      );
    }
    return response.value;
  }

  function showError(error) {
    const key = error instanceof ConnectionControllerError
      ? connectionErrorMessageKey(error.code)
      : "vfsConnectionErrorUnexpected";
    view.setFeedback({ kind: "error", text: getMessage(key) });
  }

  function defaultName(account) {
    const label = account?.connectionLabel ||
      getMessage("optionsAccountFallback");
    return getMessage("vfsConnectionDefaultName", [label]);
  }

  async function refresh(preferredAccountId) {
    view.setBusy(true);
    try {
      const [accounts, connection] = await Promise.all([
        request(MESSAGE_TYPES.listAccounts),
        context.mode === "config"
          ? request(MESSAGE_TYPES.getConnection, {
              addonId: context.addonId,
              storageId: context.storageId
            })
          : null
      ]);
      const accountViews = connectionAccountViewModels(accounts, getMessage);
      const selectedAccountId = accountViews.some((entry) =>
        entry.id === preferredAccountId)
        ? preferredAccountId
        : connection?.accountId ||
          accountViews.find((entry) => entry.connected)?.id ||
          accountViews[0]?.id || "";
      const selectedAccount = accountViews.find((entry) =>
        entry.id === selectedAccountId);
      const addonName = connection?.addonName || context.addonName ||
        context.addonId;
      const model = {
        addonLabel: addonName === context.addonId
          ? context.addonId
          : `${addonName} (${context.addonId})`,
        accounts: accountViews,
        selectedAccountId,
        name: connection?.name || defaultName(selectedAccount)
      };
      view.clearFeedback?.();
      view.render(model);
      return model;
    } catch (error) {
      showError(error);
      return null;
    } finally {
      view.setBusy(false);
    }
  }

  async function authorize(accountId) {
    view.setBusy(true);
    try {
      const account = await request(MESSAGE_TYPES.authorizeAccount,
        accountId ? { accountId } : {});
      return await refresh(account.id);
    } catch (error) {
      showError(error);
      return null;
    } finally {
      view.setBusy(false);
    }
  }

  async function submit({ accountId, name }) {
    view.setBusy(true);
    try {
      const common = {
        addonId: context.addonId,
        accountId,
        name
      };
      const result = context.mode === "setup"
        ? await request(MESSAGE_TYPES.createConnection, {
            ...common,
            addonName: context.addonName,
            setupToken: context.setupToken
          })
        : await request(MESSAGE_TYPES.updateConnection, {
            ...common,
            storageId: context.storageId
          });
      closeWindow();
      return result;
    } catch (error) {
      showError(error);
      return null;
    } finally {
      view.setBusy(false);
    }
  }

  return {
    authorize,
    defaultName,
    refresh,
    submit
  };
}
