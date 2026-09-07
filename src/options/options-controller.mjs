/**
 * DOM-independent controller for Google Drive provider options.
 */

"use strict";

const MESSAGE_TYPES = Object.freeze({
  listAccounts: "googleDrive:accounts:list",
  authorizeAccount: "googleDrive:account:authorize",
  disconnectAccount: "googleDrive:account:disconnect",
  getPreferences: "googleDrive:preferences:get",
  updatePreferences: "googleDrive:preferences:update"
});

const ERROR_MESSAGE_KEYS = Object.freeze({
  oauth_not_configured: "optionsErrorOAuthNotConfigured",
  oauth_client_id_invalid: "optionsErrorOAuthClientIdInvalid",
  oauth_cancelled: "optionsErrorOAuthCancelled",
  oauth_denied: "optionsErrorOAuthCancelled",
  oauth_account_mismatch: "optionsErrorOAuthAccountMismatch",
  oauth_flow_failed: "optionsErrorOAuthGeneric",
  oauth_request_timeout: "vfsErrorNetworkDescription",
  oauth_reauthorization_required: "optionsErrorOAuthReauthorizationRequired",
  oauth_token_refresh_failed: "optionsErrorOAuthReauthorizationRequired",
  oauth_refresh_token_missing: "optionsErrorOAuthReauthorizationRequired",
  account_has_connections: "optionsErrorAccountHasConnections",
  unexpected_error: "optionsErrorUnexpected"
});

export class OptionsControllerError extends Error {
  constructor(code) {
    super(code);
    this.name = "OptionsControllerError";
    this.code = code;
  }
}

export function normalizePreferenceChanges({
  oauthClientId,
  debugLogging,
  exportFormats
}) {
  return {
    oauthClientId: typeof oauthClientId === "string" ? oauthClientId.trim() : "",
    debugLogging: Boolean(debugLogging),
    exportFormats: { ...exportFormats }
  };
}

export function accountViewModels(accounts, getMessage) {
  if (!Array.isArray(accounts)) {
    return [];
  }
  return accounts.map((account) => ({
    id: account.id,
    displayName: account.displayName || account.emailAddress || "",
    emailAddress: account.emailAddress || "",
    status: account.status,
    statusText: account.status === "reauthorization_required"
      ? getMessage("optionsAccountReauthorizationRequired")
      : getMessage("optionsAccountConnected"),
    canReauthorize: account.status === "reauthorization_required"
  }));
}

export function errorMessageKey(errorCode) {
  return ERROR_MESSAGE_KEYS[errorCode] || "optionsErrorOAuthGeneric";
}

export function createOptionsController({ sendMessage, view, getMessage }) {
  async function request(type, payload = {}) {
    const response = await sendMessage({ type, ...payload });
    if (!response?.ok) {
      throw new OptionsControllerError(response?.errorCode || "unexpected_error");
    }
    return response.value;
  }

  function showError(error) {
    const key = error instanceof OptionsControllerError
      ? errorMessageKey(error.code)
      : "optionsErrorUnexpected";
    view.setFeedback({ kind: "error", text: getMessage(key) });
  }

  async function refresh() {
    const [preferences, accounts] = await Promise.all([
      request(MESSAGE_TYPES.getPreferences),
      request(MESSAGE_TYPES.listAccounts)
    ]);
    view.setPreferences(preferences);
    view.renderAccounts(accountViewModels(accounts, getMessage));
    return { preferences, accounts };
  }

  async function finishMutation({ kind = "success", messageKey }) {
    try {
      await refresh();
      view.setFeedback({ kind, text: getMessage(messageKey) });
    } catch (error) {
      showError(error);
    }
    return true;
  }

  async function savePreferences(changes, { notify = true } = {}) {
    view.setBusy(true);
    try {
      const preferences = await request(
        MESSAGE_TYPES.updatePreferences,
        { changes: normalizePreferenceChanges(changes) }
      );
      view.setPreferences(preferences);
      if (notify) {
        view.setFeedback({ kind: "success", text: getMessage("optionsPreferencesSaved") });
      }
      return preferences;
    } catch (error) {
      showError(error);
      return null;
    } finally {
      view.setBusy(false);
    }
  }

  async function authorize() {
    view.setBusy(true);
    try {
      await request(MESSAGE_TYPES.authorizeAccount);
      return await finishMutation({ messageKey: "optionsAccountAdded" });
    } catch (error) {
      showError(error);
      return false;
    } finally {
      view.setBusy(false);
    }
  }

  async function reauthorize(accountId) {
    view.setBusy(true);
    try {
      await request(MESSAGE_TYPES.authorizeAccount, { accountId });
      return await finishMutation({
        messageKey: "optionsAccountReauthorized"
      });
    } catch (error) {
      showError(error);
      return false;
    } finally {
      view.setBusy(false);
    }
  }

  async function disconnect(accountId) {
    view.setBusy(true);
    try {
      const result = await request(MESSAGE_TYPES.disconnectAccount, { accountId });
      return await finishMutation(result?.revoked === false
        ? {
            kind: "warning",
            messageKey: "optionsAccountDisconnectedWithoutRevocation"
          }
        : { messageKey: "optionsAccountDisconnected" });
    } catch (error) {
      showError(error);
      return false;
    } finally {
      view.setBusy(false);
    }
  }

  return {
    authorize,
    disconnect,
    reauthorize,
    refresh,
    savePreferences
  };
}
