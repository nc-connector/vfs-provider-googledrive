/**
 * Internal runtime message boundary for provider settings and accounts.
 */

"use strict";

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "unexpected_error";
}

export function createRuntimeMessageHandler({
  extensionId,
  readiness,
  accountRepository,
  preferencesRepository,
  oauthClient,
  connectionService,
  logger
}) {
  return function handleRuntimeMessage(message, sender) {
    if (sender?.id !== extensionId || typeof message?.type !== "string") {
      return undefined;
    }

    let operation;
    switch (message.type) {
      case "googleDrive:accounts:list":
        operation = () => accountRepository.listAccounts();
        break;
      case "googleDrive:account:authorize":
        operation = () => oauthClient.authorize({
          accountId: message.accountId,
          interactive: true
        });
        break;
      case "googleDrive:account:disconnect":
        operation = () => connectionService.disconnectAccount(
          message.accountId,
          () => oauthClient.disconnectAccount(message.accountId)
        );
        break;
      case "googleDrive:preferences:get":
        operation = () => preferencesRepository.get();
        break;
      case "googleDrive:preferences:update":
        operation = () => preferencesRepository.update(message.changes);
        break;
      case "googleDrive:vfs:connection:get":
        operation = () => connectionService.getConnection({
          addonId: message.addonId,
          storageId: message.storageId
        });
        break;
      case "googleDrive:vfs:connection:create":
        operation = () => connectionService.createConnection({
          addonId: message.addonId,
          addonName: message.addonName,
          accountId: message.accountId,
          name: message.name,
          setupToken: message.setupToken
        });
        break;
      case "googleDrive:vfs:connection:update":
        operation = () => connectionService.updateConnection({
          addonId: message.addonId,
          storageId: message.storageId,
          accountId: message.accountId,
          name: message.name
        });
        break;
      default:
        return undefined;
    }

    return Promise.resolve(readiness)
      .then(operation)
      .then(
        (value) => ({ ok: true, value }),
        (error) => {
          logger?.warn?.("runtime.operation.failed", {
            operation: message.type,
            error
          });
          return { ok: false, errorCode: errorCode(error) };
        }
      );
  };
}
