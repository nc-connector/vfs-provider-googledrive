/**
 * Background entry point for the Google Drive VFS provider.
 *
 * Provider listeners are added with the account and storage implementation.
 */

"use strict";

import { VfsProviderImplementation } from "./vendor/vfs-toolkit/vfs-provider.mjs";

export class GoogleDriveVfsProvider extends VfsProviderImplementation {}

browser.runtime.onStartup.addListener(() => {});
