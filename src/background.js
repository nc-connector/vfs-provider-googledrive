/**
 * Background entry point for the Google Drive VFS provider.
 *
 * Provider listeners are added with the account and storage implementation.
 */

"use strict";

import { ProviderLogger } from "./core/logger.mjs";
import {
  GoogleDriveChangeMonitor
} from "./google/drive-change-monitor.mjs";
import { GoogleDriveTransport } from "./google/drive-transport.mjs";
import { GoogleOAuthClient } from "./google/oauth-client.mjs";
import { OAuthSessionRepository } from "./google/oauth-session.mjs";
import {
  GoogleDriveVfsProvider
} from "./provider/google-drive-vfs-provider.mjs";
import {
  VFS_TOOLKIT_CONNECTIONS_KEY,
  VfsConnectionService
} from "./provider/vfs-connection-service.mjs";
import { ChangePollScheduler } from "./runtime/change-poll-scheduler.mjs";
import { createRuntimeMessageHandler } from "./runtime/message-handler.mjs";
import {
  PROVIDER_PREFERENCES_KEY,
  ProviderPreferencesRepository
} from "./state/provider-preferences.mjs";
import { ProviderStateRepository } from "./state/provider-state.mjs";

export { GoogleDriveVfsProvider };

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
const driveTransport = new GoogleDriveTransport({
  oauthClient,
  logger
});
const connectionService = new VfsConnectionService({
  storageArea: browser.storage.local,
  accountRepository,
  logger
});

const readiness = Promise.all([
  accountRepository.initialize(),
  preferencesRepository.initialize(),
  oauthSessionRepository.initialize()
]).then(async ([, preferences]) => {
  logger.setDebugEnabled(preferences.debugLogging);
  await connectionService.initialize();
});
readiness.catch((error) => {
  logger.error("runtime.initialization.failed", { error });
});

const getMessage = (key) => browser.i18n.getMessage(key);
const provider = new GoogleDriveVfsProvider({
  name: getMessage("extensionName"),
  setupPath: "/connection/setup.html",
  setupWidth: 600,
  setupHeight: 560,
  configPath: "/connection/config.html",
  configWidth: 600,
  configHeight: 560,
  readiness,
  connectionService,
  accountRepository,
  preferencesRepository,
  transport: driveTransport,
  rootLabels: {
    myDrive: getMessage("vfsRootMyDrive"),
    sharedWithMe: getMessage("vfsRootSharedWithMe"),
    sharedDrives: getMessage("vfsRootSharedDrives")
  },
  getMessage,
  logger
});
provider.init();

const changeMonitor = new GoogleDriveChangeMonitor({
  accountRepository,
  connectionService,
  transport: driveTransport,
  reportStorageChange: (storageId, entries) =>
    provider.reportStorageChange(storageId, entries),
  logger
});
const changePollScheduler = new ChangePollScheduler({
  alarmsApi: browser.alarms,
  poll: () => readiness.then(() => changeMonitor.poll()),
  logger
});

async function startChangePolling() {
  try {
    await readiness;
    const created = await changePollScheduler.reconcileSchedule();
    if (created) {
      await changePollScheduler.pollNow();
    }
  } catch (error) {
    logger.warn("drive.changes.schedule.failed", {
      error,
      phase: "schedule"
    });
  }
}

void startChangePolling();

browser.runtime.onMessage.addListener(createRuntimeMessageHandler({
  extensionId: browser.runtime.id,
  readiness,
  accountRepository,
  preferencesRepository,
  oauthClient,
  connectionService,
  logger
}));

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  if (changes[PROVIDER_PREFERENCES_KEY]?.newValue) {
    logger.setDebugEnabled(
      changes[PROVIDER_PREFERENCES_KEY].newValue.debugLogging
    );
  }
  if (Object.hasOwn(changes, VFS_TOOLKIT_CONNECTIONS_KEY)) {
    void readiness.then(async () => {
      try {
        await connectionService.reconcileToolkitConnections();
      } catch (error) {
        logger.warn("vfs.connection.reconcile.failed", { error });
        return;
      }
      try {
        await changeMonitor.poll();
      } catch (error) {
        logger.warn("drive.changes.poll.failed", {
          error,
          phase: "connection_change"
        });
      }
    }).catch((error) => {
      logger.warn("vfs.connection.reconcile.failed", { error });
    });
  }
});

browser.runtime.onStartup.addListener(() => {
  void startChangePolling();
});
