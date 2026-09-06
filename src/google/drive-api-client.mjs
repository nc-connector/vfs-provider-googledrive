/**
 * Read-only Google Drive API v3 operations used by the provider.
 */

"use strict";

import { GoogleDriveRequestError } from "./drive-transport.mjs";

export const DRIVE_ABOUT_FIELDS = [
  "exportFormats",
  "importFormats",
  "maxImportSizes",
  "maxUploadSize",
  "storageQuota(limit,usage,usageInDrive,usageInDriveTrash)",
  "user(displayName,emailAddress,permissionId)"
].join(",");

export const DRIVE_FILE_FIELDS = [
  "capabilities(canAddChildren,canCopy,canDelete,canDeleteChildren,canDownload,canEdit,canListChildren,canModifyContent,canMoveChildrenOutOfDrive,canMoveChildrenWithinDrive,canMoveItemOutOfDrive,canMoveItemWithinDrive,canRemoveChildren,canRename,canShare,canTrash,canTrashChildren,canUntrash)",
  "createdTime",
  "driveId",
  "explicitlyTrashed",
  "id",
  "md5Checksum",
  "mimeType",
  "modifiedTime",
  "name",
  "parents",
  "resourceKey",
  "shortcutDetails(targetId,targetMimeType,targetResourceKey)",
  "size",
  "trashed",
  "version"
].join(",");

export const DRIVE_FIELDS = [
  "capabilities(canAddChildren,canComment,canCopy,canDeleteChildren,canDownload,canEdit,canListChildren,canManageMembers,canReadRevisions,canRename,canShare,canTrashChildren)",
  "colorRgb",
  "createdTime",
  "hidden",
  "id",
  "name",
  "orgUnitId",
  "restrictions(adminManagedRestrictions,copyRequiresWriterPermission,domainUsersOnly,driveMembersOnly,sharingFoldersRequiresOrganizerPermission)"
].join(",");

const STORAGE_QUOTA_FIELDS =
  "storageQuota(limit,usage,usageInDrive,usageInDriveTrash)";

function requireText(value, name) {
  if (typeof value !== "string" || !value) {
    throw new TypeError(name);
  }
  return value;
}

function requirePageSize(value, maximum, name) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(name);
  }
  return value;
}

function listProjection(collection, itemFields, extraFields = []) {
  requireText(itemFields, `${collection}Fields`);
  return ["nextPageToken", ...extraFields, `${collection}(${itemFields})`]
    .join(",");
}

function resourceKeyHeaders(resourceKeys = []) {
  if (!Array.isArray(resourceKeys)) {
    throw new TypeError("resourceKeys");
  }
  const values = Array.from(resourceKeys, ({ fileId, resourceKey } = {}) => {
    requireText(fileId, "resourceKeyFileId");
    requireText(resourceKey, "resourceKey");
    if (/[\s,/]/u.test(fileId) || /[\s,/]/u.test(resourceKey)) {
      throw new TypeError("resourceKeys");
    }
    return `${fileId}/${resourceKey}`;
  });
  return values.length > 0
    ? { "X-Goog-Drive-Resource-Keys": values.join(",") }
    : {};
}

function singleResourceKeyHeaders(fileId, resourceKey) {
  return resourceKeyHeaders(resourceKey === undefined
    ? []
    : [{ fileId, resourceKey }]);
}

export class GoogleDriveApiClient {
  #transport;
  #accountId;

  constructor({ transport, accountId }) {
    if (!transport || typeof transport.request !== "function") {
      throw new TypeError("transport");
    }
    this.#transport = transport;
    this.#accountId = requireText(accountId, "accountId");
  }

  async getAbout({ fields = DRIVE_ABOUT_FIELDS, signal } = {}) {
    return this.#transport.request(this.#accountId, {
      resourcePath: "about",
      query: { fields: requireText(fields, "fields") },
      signal,
      operation: "about.get"
    });
  }

  async getStorageQuota({ signal } = {}) {
    const about = await this.getAbout({
      fields: STORAGE_QUOTA_FIELDS,
      signal
    });
    return about?.storageQuota || null;
  }

  async listFiles({
    q,
    spaces,
    corpora,
    driveId,
    includeItemsFromAllDrives = true,
    supportsAllDrives = true,
    orderBy,
    resourceKeys,
    pageSize = 1000,
    fileFields = DRIVE_FILE_FIELDS,
    signal
  } = {}) {
    const query = {
      q,
      spaces: Array.isArray(spaces) ? spaces.join(",") : spaces,
      corpora,
      driveId,
      includeItemsFromAllDrives,
      supportsAllDrives,
      orderBy,
      pageSize: requirePageSize(pageSize, 1000, "pageSize"),
      fields: listProjection("files", fileFields, ["incompleteSearch"])
    };
    const result = await this.#collectPages({
      resourcePath: "files",
      query,
      headers: resourceKeyHeaders(resourceKeys),
      collection: "files",
      operation: "files.list",
      signal
    });
    return {
      files: result.items,
      incompleteSearch: result.pages.some((page) => page.incompleteSearch === true)
    };
  }

  async getFile(fileId, {
    fields = DRIVE_FILE_FIELDS,
    supportsAllDrives = true,
    resourceKey,
    signal
  } = {}) {
    const normalizedFileId = requireText(fileId, "fileId");
    return this.#transport.request(this.#accountId, {
      resourcePath: `files/${encodeURIComponent(normalizedFileId)}`,
      query: {
        fields: requireText(fields, "fields"),
        supportsAllDrives
      },
      headers: singleResourceKeyHeaders(normalizedFileId, resourceKey),
      signal,
      operation: "files.get"
    });
  }

  async listDrives({
    q,
    pageSize = 100,
    useDomainAdminAccess = false,
    driveFields = DRIVE_FIELDS,
    signal
  } = {}) {
    const result = await this.#collectPages({
      resourcePath: "drives",
      query: {
        q,
        pageSize: requirePageSize(pageSize, 100, "pageSize"),
        useDomainAdminAccess,
        fields: listProjection("drives", driveFields)
      },
      collection: "drives",
      operation: "drives.list",
      signal
    });
    return { drives: result.items };
  }

  async downloadBlob(fileId, {
    acknowledgeAbuse,
    supportsAllDrives = true,
    range,
    resourceKey,
    signal
  } = {}) {
    const normalizedFileId = requireText(fileId, "fileId");
    const headers = singleResourceKeyHeaders(normalizedFileId, resourceKey);
    if (range !== undefined) {
      headers.Range = requireText(range, "range");
    }
    return this.#transport.request(this.#accountId, {
      resourcePath: `files/${encodeURIComponent(normalizedFileId)}`,
      query: {
        alt: "media",
        acknowledgeAbuse,
        supportsAllDrives
      },
      headers,
      responseType: "blob",
      signal,
      operation: "files.download"
    });
  }

  async exportFile(fileId, mimeType, { resourceKey, signal } = {}) {
    const normalizedFileId = requireText(fileId, "fileId");
    return this.#transport.request(this.#accountId, {
      resourcePath: `files/${encodeURIComponent(normalizedFileId)}/export`,
      query: { mimeType: requireText(mimeType, "mimeType") },
      headers: singleResourceKeyHeaders(normalizedFileId, resourceKey),
      responseType: "blob",
      signal,
      operation: "files.export"
    });
  }

  async #collectPages({
    resourcePath,
    query,
    headers,
    collection,
    operation,
    signal
  }) {
    const items = [];
    const pages = [];
    const seenTokens = new Set();
    let pageToken;

    do {
      const page = await this.#transport.request(this.#accountId, {
        resourcePath,
        query: { ...query, pageToken },
        headers,
        signal,
        operation
      });
      if (!page || typeof page !== "object" ||
          (page[collection] !== undefined &&
           !Array.isArray(page[collection]))) {
        throw new GoogleDriveRequestError("drive_response_invalid");
      }
      pages.push(page);
      items.push(...(page[collection] || []));

      const nextPageToken = typeof page.nextPageToken === "string" &&
        page.nextPageToken
        ? page.nextPageToken
        : undefined;
      if (nextPageToken && seenTokens.has(nextPageToken)) {
        throw new GoogleDriveRequestError("drive_pagination_invalid");
      }
      if (nextPageToken) {
        seenTokens.add(nextPageToken);
      }
      pageToken = nextPageToken;
    } while (pageToken);

    return { items, pages };
  }
}
