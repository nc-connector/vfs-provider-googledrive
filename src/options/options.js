/**
 * Options page entry point.
 */

"use strict";

import { localizeDocument } from "../vendor/i18n/i18n.mjs";
import {
  createOptionsController,
  shouldRefreshForStorageChange
} from "./options-controller.mjs";

localizeDocument();
document.documentElement.lang = browser.i18n.getMessage("optionsDocumentLanguage") || "de";

const form = document.getElementById("preferences-form");
const feedback = document.getElementById("feedback");
const accountList = document.getElementById("account-list");
const noAccounts = document.getElementById("no-accounts");
const connectionList = document.getElementById("connection-list");
const noConnections = document.getElementById("no-connections");
const addAccountButton = document.getElementById("add-account");
const oauthClientId = document.getElementById("oauth-client-id");
const debugLogging = document.getElementById("debug-logging");
const exportDocument = document.getElementById("export-document");
const exportSpreadsheet = document.getElementById("export-spreadsheet");
const exportPresentation = document.getElementById("export-presentation");
const exportDrawing = document.getElementById("export-drawing");

function getMessage(key) {
  return browser.i18n.getMessage(key) || key;
}

function readPreferences() {
  return {
    oauthClientId: oauthClientId.value,
    debugLogging: debugLogging.checked,
    exportFormats: {
      document: exportDocument.value,
      spreadsheet: exportSpreadsheet.value,
      presentation: exportPresentation.value,
      drawing: exportDrawing.value
    }
  };
}

function setPreferences(preferences) {
  oauthClientId.value = preferences.oauthClientId;
  debugLogging.checked = preferences.debugLogging;
  exportDocument.value = preferences.exportFormats.document;
  exportSpreadsheet.value = preferences.exportFormats.spreadsheet;
  exportPresentation.value = preferences.exportFormats.presentation;
  exportDrawing.value = preferences.exportFormats.drawing;
}

function setFeedback({ kind, text }) {
  feedback.className = `feedback ${kind}`;
  feedback.textContent = text;
  feedback.hidden = false;
}

function setBusy(isBusy) {
  for (const control of document.querySelectorAll("button, input, select")) {
    control.disabled = isBusy;
  }
}

function createActionButton(text, className, callback) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.addEventListener("click", () => {
    void callback();
  });
  return button;
}

let controller;

function renderAccounts(accounts) {
  accountList.replaceChildren();
  noAccounts.hidden = accounts.length > 0;

  for (const account of accounts) {
    const item = document.createElement("li");
    item.className = "account-card";

    const details = document.createElement("div");
    const name = document.createElement("p");
    name.className = "account-name";
    name.textContent = account.displayName || getMessage("optionsAccountFallback");
    details.append(name);

    if (account.emailAddress && account.emailAddress !== account.displayName) {
      const email = document.createElement("p");
      email.className = "account-email";
      email.textContent = account.emailAddress;
      details.append(email);
    }

    const status = document.createElement("p");
    status.className = account.canReauthorize
      ? "account-status reauthorization-required"
      : "account-status";
    status.textContent = account.statusText;
    details.append(status);

    const actions = document.createElement("div");
    actions.className = "account-actions";
    if (account.canReauthorize) {
      actions.append(createActionButton(
        getMessage("optionsReauthorizeAccount"),
        "secondary-action",
        () => controller.reauthorize(account.id)
      ));
    }
    actions.append(createActionButton(
      getMessage("optionsDisconnectAccount"),
      "danger-action",
      () => {
        if (window.confirm(getMessage("optionsConfirmDisconnect"))) {
          return controller.disconnect(account.id);
        }
        return false;
      }
    ));

    item.append(details, actions);
    accountList.append(item);
  }
}

function appendConnectionDetail(parent, labelKey, value) {
  const detail = document.createElement("p");
  detail.className = "connection-detail";
  const label = document.createElement("span");
  label.className = "connection-detail-label";
  label.textContent = getMessage(labelKey);
  const content = document.createElement("span");
  content.textContent = value;
  detail.append(label, content);
  parent.append(detail);
}

function renderConnections(connections) {
  connectionList.replaceChildren();
  noConnections.hidden = connections.length > 0;

  for (const connection of connections) {
    const item = document.createElement("li");
    item.className = "connection-card";

    const details = document.createElement("div");
    const name = document.createElement("p");
    name.className = "connection-name";
    name.textContent = connection.name;
    details.append(name);
    appendConnectionDetail(
      details,
      "vfsConnectionAccountLabel",
      connection.accountLabel
    );
    appendConnectionDetail(
      details,
      "optionsConnectionAddonLabel",
      connection.addonLabel
    );

    const actions = document.createElement("div");
    actions.className = "connection-actions";
    actions.append(createActionButton(
      getMessage("optionsRevokeConnection"),
      "danger-action",
      () => {
        if (window.confirm(getMessage("optionsConfirmRevokeConnection"))) {
          return controller.revokeConnection(
            connection.addonId,
            connection.storageId
          );
        }
        return false;
      }
    ));

    item.append(details, actions);
    connectionList.append(item);
  }
}

controller = createOptionsController({
  sendMessage: (message) => browser.runtime.sendMessage(message),
  getMessage,
  view: {
    renderAccounts,
    renderConnections,
    setBusy,
    setFeedback,
    setPreferences
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void controller.savePreferences(readPreferences());
});

addAccountButton.addEventListener("click", () => {
  void (async () => {
    const preferences = await controller.savePreferences(readPreferences(), {
      notify: false
    });
    if (preferences) {
      await controller.authorize();
    }
  })();
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (!shouldRefreshForStorageChange(changes, areaName)) {
    return;
  }
  void controller.refreshConnections().catch(() => {
    setFeedback({ kind: "error", text: getMessage("optionsErrorUnexpected") });
  });
});

setBusy(true);
void controller.refresh()
  .catch(() => {
    setFeedback({ kind: "error", text: getMessage("optionsErrorUnexpected") });
  })
  .finally(() => setBusy(false));
