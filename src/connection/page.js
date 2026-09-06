/**
 * Setup and configuration page entry point.
 */

"use strict";

import { localizeDocument } from "../vendor/i18n/i18n.mjs";
import {
  ConnectionControllerError,
  connectionErrorMessageKey,
  createConnectionController,
  parseConnectionContext
} from "./connection-controller.mjs";

localizeDocument();
document.documentElement.lang = browser.i18n.getMessage(
  "optionsDocumentLanguage"
) || "de";

const mode = document.body.dataset.mode;
const feedback = document.getElementById("feedback");
const requestText = document.getElementById("request-text");
const form = document.getElementById("connection-form");
const accountSelect = document.getElementById("connection-account");
const nameInput = document.getElementById("connection-name");
const noAccounts = document.getElementById("no-accounts");
const addAccount = document.getElementById("add-account");
const reauthorize = document.getElementById("reauthorize-account");
const submitButton = document.getElementById("submit-connection");
const cancelButton = document.getElementById("cancel");

let busy = false;
let currentAccounts = [];
let nameEdited = false;
let rendered = false;
let controller;

function getMessage(key, substitutions) {
  return browser.i18n.getMessage(key, substitutions) || key;
}

function setFeedback({ kind, text }) {
  feedback.className = `feedback ${kind}`;
  feedback.textContent = text;
  feedback.hidden = false;
}

function clearFeedback() {
  feedback.className = "feedback";
  feedback.textContent = "";
  feedback.hidden = true;
}

function selectedAccount() {
  return currentAccounts.find((entry) => entry.id === accountSelect.value);
}

function updateControls() {
  const account = selectedAccount();
  noAccounts.hidden = currentAccounts.length > 0;
  reauthorize.hidden = !account || account.connected;
  submitButton.disabled = busy || !account?.connected || !nameInput.value.trim();
}

function setBusy(isBusy) {
  busy = isBusy;
  for (const control of document.querySelectorAll("button, input, select")) {
    control.disabled = isBusy;
  }
  cancelButton.disabled = false;
  updateControls();
}

function render(model) {
  currentAccounts = model.accounts;
  accountSelect.replaceChildren();
  for (const account of currentAccounts) {
    const option = document.createElement("option");
    option.value = account.id;
    option.textContent = account.connected
      ? account.label
      : `${account.label} — ${getMessage("optionsAccountReauthorizationRequired")}`;
    accountSelect.append(option);
  }
  accountSelect.value = model.selectedAccountId;
  if (!rendered || !nameEdited) {
    nameInput.value = model.name;
  }
  if (!rendered) {
    nameEdited = mode === "config";
  }
  rendered = true;
  requestText.textContent = getMessage(
    mode === "setup" ? "vfsSetupRequestText" : "vfsConfigText",
    [model.addonLabel]
  );
  updateControls();
}

let context;
try {
  context = parseConnectionContext(location.search, mode);
} catch (error) {
  const key = error instanceof ConnectionControllerError
    ? connectionErrorMessageKey(error.code)
    : "vfsConnectionErrorUnexpected";
  setFeedback({ kind: "error", text: getMessage(key) });
  for (const control of form.querySelectorAll("button, input, select")) {
    control.disabled = true;
  }
  cancelButton.disabled = false;
  submitButton.hidden = true;
}

if (context) {
  controller = createConnectionController({
    context,
    sendMessage: (message) => browser.runtime.sendMessage(message),
    getMessage,
    view: { clearFeedback, render, setBusy, setFeedback },
    closeWindow: () => window.close()
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void controller.submit({
      accountId: accountSelect.value,
      name: nameInput.value
    });
  });

  accountSelect.addEventListener("change", () => {
    if (mode === "setup" && !nameEdited) {
      nameInput.value = controller.defaultName(selectedAccount());
    }
    updateControls();
  });

  nameInput.addEventListener("input", () => {
    nameEdited = true;
    updateControls();
  });

  addAccount.addEventListener("click", () => {
    void controller.authorize();
  });

  reauthorize.addEventListener("click", () => {
    if (accountSelect.value) {
      void controller.authorize(accountSelect.value);
    }
  });

  void controller.refresh();
}

cancelButton.addEventListener("click", () => window.close());
