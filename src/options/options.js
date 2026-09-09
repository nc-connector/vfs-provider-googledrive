/**
 * Options page entry point.
 */

"use strict";

import { localizeDocument } from "../vendor/i18n/i18n.mjs";
import {
  createOptionsController,
  errorMessageKey,
  shouldRefreshForStorageChange
} from "./options-controller.mjs";

localizeDocument();
document.documentElement.lang = browser.i18n.getMessage("optionsDocumentLanguage") || "de";

const preferencesForm = document.getElementById("preferences-form");
const oauthForm = document.getElementById("oauth-form");
const feedback = document.getElementById("feedback");
const accountList = document.getElementById("account-list");
const noAccounts = document.getElementById("no-accounts");
const connectionList = document.getElementById("connection-list");
const noConnections = document.getElementById("no-connections");
const addAccountButton = document.getElementById("add-account");
const debugLogging = document.getElementById("debug-logging");
const exportDocument = document.getElementById("export-document");
const exportSpreadsheet = document.getElementById("export-spreadsheet");
const exportPresentation = document.getElementById("export-presentation");
const exportDrawing = document.getElementById("export-drawing");
const oauthMode = document.getElementById("oauth-mode");
const oauthModeHelp = document.getElementById("oauth-mode-help");
const oauthSource = document.getElementById("oauth-source");
const oauthEffectiveClientId = document.getElementById(
  "oauth-effective-client-id"
);
const oauthCustomFields = document.getElementById("oauth-custom-fields");
const oauthClientId = document.getElementById("oauth-client-id");
const oauthClientSecret = document.getElementById("oauth-client-secret");
const oauthClientSecretHelp = document.getElementById(
  "oauth-client-secret-help"
);
const oauthManagedNotice = document.getElementById("oauth-managed-notice");
const saveOAuth = document.getElementById("save-oauth");

let busy = false;
let oauthLocked = false;
let oauthHasCustomClientSecret = false;
let oauthStoredCustomClientId = "";

function getMessage(key) {
  return browser.i18n.getMessage(key) || key;
}

function readPreferences() {
  return {
    debugLogging: debugLogging.checked,
    exportFormats: {
      document: exportDocument.value,
      spreadsheet: exportSpreadsheet.value,
      presentation: exportPresentation.value,
      drawing: exportDrawing.value
    }
  };
}

function readOAuthConfiguration() {
  return {
    mode: oauthMode.value,
    clientId: oauthClientId.value,
    clientSecret: oauthClientSecret.value
  };
}

function setPreferences(preferences) {
  debugLogging.checked = preferences.debugLogging;
  exportDocument.value = preferences.exportFormats.document;
  exportSpreadsheet.value = preferences.exportFormats.spreadsheet;
  exportPresentation.value = preferences.exportFormats.presentation;
  exportDrawing.value = preferences.exportFormats.drawing;
}

function updateOAuthControls() {
  const custom = oauthMode.value === "custom";
  oauthCustomFields.hidden = !custom;
  oauthModeHelp.textContent = getMessage(custom
    ? "optionsOAuthModeCustomHelp"
    : "optionsOAuthModeBuiltinHelp");
  const canRetainStoredSecret = oauthHasCustomClientSecret &&
    oauthClientId.value.trim() === oauthStoredCustomClientId &&
    !oauthClientSecret.value;
  oauthClientSecretHelp.textContent = getMessage(
    canRetainStoredSecret
      ? "optionsOAuthClientSecretConfigured"
      : "optionsOAuthClientSecretHelp"
  );
  oauthMode.disabled = busy || oauthLocked;
  oauthClientId.disabled = busy || oauthLocked || !custom;
  oauthClientSecret.disabled = busy || oauthLocked || !custom;
  saveOAuth.disabled = busy || oauthLocked;
  oauthManagedNotice.hidden = !oauthLocked;
}

function setOAuthConfiguration(configuration) {
  oauthLocked = Boolean(configuration.locked);
  oauthHasCustomClientSecret = Boolean(
    configuration.hasCustomClientSecret
  );
  oauthStoredCustomClientId = configuration.customClientId || "";
  oauthMode.value = configuration.mode;
  oauthSource.textContent = getMessage(configuration.source === "managed"
    ? "optionsOAuthSourceManaged"
    : "optionsOAuthSourceLocal");
  oauthEffectiveClientId.textContent = configuration.clientId;
  oauthClientId.value = oauthStoredCustomClientId;
  oauthClientSecret.value = "";
  updateOAuthControls();
}

function setFeedback({ kind, text }) {
  feedback.className = `feedback ${kind}`;
  feedback.textContent = text;
  feedback.hidden = false;
}

function setBusy(isBusy) {
  busy = isBusy;
  for (const control of document.querySelectorAll("button, input, select")) {
    control.disabled = isBusy;
  }
  updateOAuthControls();
}

function setUnavailable() {
  busy = true;
  for (const control of document.querySelectorAll("button, input, select")) {
    control.disabled = true;
  }
  updateOAuthControls();
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
    setOAuthConfiguration,
    setPreferences
  }
});

preferencesForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void controller.savePreferences(readPreferences());
});

oauthForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void controller.saveOAuthConfiguration(readOAuthConfiguration());
});

oauthMode.addEventListener("change", updateOAuthControls);
oauthClientId.addEventListener("input", updateOAuthControls);
oauthClientSecret.addEventListener("input", updateOAuthControls);

addAccountButton.addEventListener("click", () => {
  void (async () => {
    if (!oauthLocked) {
      const configuration = await controller.saveOAuthConfiguration(
        readOAuthConfiguration(),
        { notify: false }
      );
      if (!configuration) {
        return;
      }
    }
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
  .then(() => setBusy(false))
  .catch((error) => {
    setFeedback({
      kind: "error",
      text: getMessage(errorMessageKey(error?.code))
    });
    setUnavailable();
  });
