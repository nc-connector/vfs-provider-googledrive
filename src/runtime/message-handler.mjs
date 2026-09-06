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
  oauthClient
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
        operation = () => oauthClient.disconnectAccount(message.accountId);
        break;
      case "googleDrive:preferences:get":
        operation = () => preferencesRepository.get();
        break;
      case "googleDrive:preferences:update":
        operation = () => preferencesRepository.update(message.changes);
        break;
      default:
        return undefined;
    }

    return Promise.resolve(readiness)
      .then(operation)
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, errorCode: errorCode(error) })
      );
  };
}
