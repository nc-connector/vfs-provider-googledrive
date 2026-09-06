/**
 * Background entry point for the Google Drive VFS provider.
 *
 * Provider listeners are added with the account and storage implementation.
 */

"use strict";

import { ProviderLogger } from "./core/logger.mjs";
import { GoogleOAuthClient } from "./google/oauth-client.mjs";
import { OAuthSessionRepository } from "./google/oauth-session.mjs";
import { createRuntimeMessageHandler } from "./runtime/message-handler.mjs";
import {
  PROVIDER_PREFERENCES_KEY,
  ProviderPreferencesRepository
} from "./state/provider-preferences.mjs";
import { ProviderStateRepository } from "./state/provider-state.mjs";
export {
  GoogleDriveVfsProvider
} from "./provider/google-drive-vfs-provider.mjs";

const logger = new ProviderLogger();
const accountRepository = new ProviderStateRepository({
  storageArea: browser.storage.local
});
const preferencesRepository = new ProviderPreferencesRepository({
  storageArea: browser.storage.local
});
const oauthSessionRepository = new OAuthSessionRepository({
  storageArea: browser.storage.session
});
const oauthClient = new GoogleOAuthClient({
  identityApi: browser.identity,
  sessionRepository: oauthSessionRepository,
  accountRepository,
  preferencesRepository,
  logger
});

const readiness = Promise.all([
  accountRepository.initialize(),
  preferencesRepository.initialize(),
  oauthSessionRepository.initialize()
]).then(([, preferences]) => {
  logger.setDebugEnabled(preferences.debugLogging);
});
readiness.catch((error) => {
  logger.error("runtime.initialization.failed", { error });
});

browser.runtime.onMessage.addListener(createRuntimeMessageHandler({
  extensionId: browser.runtime.id,
  readiness,
  accountRepository,
  preferencesRepository,
  oauthClient
}));

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[PROVIDER_PREFERENCES_KEY]?.newValue) {
    logger.setDebugEnabled(
      changes[PROVIDER_PREFERENCES_KEY].newValue.debugLogging
    );
  }
});

browser.runtime.onStartup.addListener(() => {
  void readiness;
});
