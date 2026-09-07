/**
 * Google Drive API v3 operations used by the provider.
 */

"use strict";

import {
  GoogleDriveRequestError,
  validateDriveUploadSessionUrl
} from "./drive-transport.mjs";

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
const DEFAULT_MEDIA_TYPE = "application/octet-stream";

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

function requireBlob(value, name) {
  if (!(value instanceof Blob)) {
    throw new TypeError(name);
  }
  return value;
}

function requireMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("metadata");
  }
  return value;
}

function optionalFileId(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return requireText(value, "fileId");
}

function optionalText(value, name) {
  return value === undefined || value === null
    ? undefined
    : requireText(value, name);
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(name);
  }
  return value;
}

function mediaType(media) {
  return media.type || DEFAULT_MEDIA_TYPE;
}

function uploadResource(fileId) {
  return fileId === null
    ? "files"
    : `files/${encodeURIComponent(fileId)}`;
}

function uploadMethod(fileId) {
  return fileId === null ? "POST" : "PATCH";
}

function uploadOperation(fileId, type) {
  return `files.upload.${type}.${fileId === null ? "create" : "update"}`;
}

function serializeMetadata(metadata) {
  try {
    return JSON.stringify(requireMetadata(metadata));
  } catch (error) {
    if (error instanceof TypeError && error.message === "metadata") {
      throw error;
    }
    throw new TypeError("metadata", { cause: error });
  }
}

function createMultipartBody(metadata, media) {
  const boundary = `googledrive_${crypto.randomUUID().replaceAll("-", "")}`;
  const contentType = `multipart/related; boundary=${boundary}`;
  const body = new Blob([
    `--${boundary}\r\n`,
    "Content-Type: application/json; charset=UTF-8\r\n\r\n",
    serializeMetadata(metadata),
    `\r\n--${boundary}\r\n`,
    `Content-Type: ${mediaType(media)}\r\n\r\n`,
    media,
    `\r\n--${boundary}--\r\n`
  ], { type: contentType });
  return { body, contentType };
}

async function readUploadMetadata(response, signal) {
  if (response.status !== 200 && response.status !== 201) {
    throw new GoogleDriveRequestError("drive_upload_response_invalid", {
      status: response.status
    });
  }
  let result;
  try {
    result = await response.json();
  } catch (cause) {
    if (signal?.aborted || cause?.name === "AbortError") {
      throw cause;
    }
    throw new GoogleDriveRequestError("drive_upload_response_invalid", {
      status: response.status,
      cause
    });
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new GoogleDriveRequestError("drive_upload_response_invalid", {
      status: response.status
    });
  }
  return result;
}

function confirmedOffset(response, total, maximumOffset) {
  const range = response.headers.get("Range");
  if (range === null) {
    return 0;
  }
  const match = /^bytes=0-(\d+)$/iu.exec(range.trim());
  const lastByte = match ? Number(match[1]) : Number.NaN;
  const nextOffset = lastByte + 1;
  if (!Number.isSafeInteger(lastByte) || lastByte < 0 ||
      nextOffset > total || nextOffset > maximumOffset) {
    throw new GoogleDriveRequestError("drive_upload_range_invalid", {
      status: response.status
    });
  }
  return nextOffset;
}

async function resumableResult(response, total, maximumOffset, signal) {
  if (response.status === 308) {
    return {
      complete: false,
      nextOffset: confirmedOffset(response, total, maximumOffset),
      file: null
    };
  }
  return {
    complete: true,
    nextOffset: total,
    file: await readUploadMetadata(response, signal)
  };
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

  async createFileMetadata(metadata, {
    supportsAllDrives = true,
    resourceKeys,
    signal
  } = {}) {
    return this.#transport.request(this.#accountId, {
      resourcePath: "files",
      query: {
        supportsAllDrives,
        fields: DRIVE_FILE_FIELDS
      },
      method: "POST",
      headers: {
        ...resourceKeyHeaders(resourceKeys),
        "Content-Type": "application/json; charset=UTF-8"
      },
      body: serializeMetadata(metadata),
      signal,
      operation: "files.create.metadata",
      retryMode: "rate-limit"
    });
  }

  async updateFileMetadata(fileId, metadata, {
    addParents,
    removeParents,
    supportsAllDrives = true,
    resourceKey,
    signal
  } = {}) {
    const normalizedFileId = requireText(fileId, "fileId");
    return this.#transport.request(this.#accountId, {
      resourcePath: `files/${encodeURIComponent(normalizedFileId)}`,
      query: {
        addParents: optionalText(addParents, "addParents"),
        removeParents: optionalText(removeParents, "removeParents"),
        supportsAllDrives,
        fields: DRIVE_FILE_FIELDS
      },
      method: "PATCH",
      headers: {
        ...singleResourceKeyHeaders(normalizedFileId, resourceKey),
        "Content-Type": "application/json; charset=UTF-8"
      },
      body: serializeMetadata(metadata),
      signal,
      operation: "files.update.metadata",
      retryMode: "rate-limit"
    });
  }

  async uploadMultipart({
    fileId,
    metadata,
    media,
    resourceKeys,
    signal
  }) {
    const normalizedFileId = optionalFileId(fileId);
    const normalizedMedia = requireBlob(media, "media");
    const { body, contentType } = createMultipartBody(
      metadata,
      normalizedMedia
    );
    return this.#transport.request(this.#accountId, {
      resourcePath: uploadResource(normalizedFileId),
      endpoint: "upload",
      query: {
        uploadType: "multipart",
        supportsAllDrives: true,
        fields: DRIVE_FILE_FIELDS
      },
      method: uploadMethod(normalizedFileId),
      headers: {
        ...resourceKeyHeaders(resourceKeys),
        "Content-Type": contentType
      },
      body,
      signal,
      operation: uploadOperation(normalizedFileId, "multipart"),
      retryMode: "rate-limit"
    });
  }

  async startResumableUpload({
    fileId,
    metadata,
    media,
    resourceKeys,
    signal
  }) {
    const normalizedFileId = optionalFileId(fileId);
    const normalizedMedia = requireBlob(media, "media");
    const response = await this.#transport.request(this.#accountId, {
      resourcePath: uploadResource(normalizedFileId),
      endpoint: "upload",
      query: {
        uploadType: "resumable",
        supportsAllDrives: true,
        fields: DRIVE_FILE_FIELDS
      },
      method: uploadMethod(normalizedFileId),
      headers: {
        ...resourceKeyHeaders(resourceKeys),
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mediaType(normalizedMedia),
        "X-Upload-Content-Length": String(normalizedMedia.size)
      },
      body: serializeMetadata(metadata),
      responseType: "response",
      signal,
      operation: uploadOperation(normalizedFileId, "resumable.start"),
      retryMode: "rate-limit"
    });
    const location = response.headers.get("Location");
    try {
      return validateDriveUploadSessionUrl(location);
    } catch (cause) {
      throw new GoogleDriveRequestError("drive_upload_session_invalid", {
        status: response.status,
        cause
      });
    }
  }

  async sendResumableChunk(uploadSessionUrl, {
    chunk,
    start,
    total,
    signal
  }) {
    const normalizedChunk = requireBlob(chunk, "chunk");
    const normalizedStart = requireNonNegativeInteger(start, "start");
    const normalizedTotal = requireNonNegativeInteger(total, "total");
    const endOffset = normalizedStart + normalizedChunk.size;
    if (normalizedChunk.size === 0 || endOffset > normalizedTotal ||
        endOffset > Number.MAX_SAFE_INTEGER) {
      throw new RangeError("chunk");
    }
    const response = await this.#transport.request(this.#accountId, {
      uploadSessionUrl: validateDriveUploadSessionUrl(uploadSessionUrl),
      method: "PUT",
      headers: {
        "Content-Type": mediaType(normalizedChunk),
        "Content-Range": `bytes ${normalizedStart}-${endOffset - 1}/${normalizedTotal}`
      },
      body: normalizedChunk,
      responseType: "response",
      signal,
      operation: "files.upload.resumable.chunk",
      retryMode: "never",
      acceptedStatuses: [308]
    });
    return resumableResult(response, normalizedTotal, endOffset, signal);
  }

  async queryResumableUpload(uploadSessionUrl, { total, signal }) {
    const normalizedTotal = requireNonNegativeInteger(total, "total");
    const response = await this.#transport.request(this.#accountId, {
      uploadSessionUrl: validateDriveUploadSessionUrl(uploadSessionUrl),
      method: "PUT",
      headers: { "Content-Range": `bytes */${normalizedTotal}` },
      responseType: "response",
      signal,
      operation: "files.upload.resumable.status",
      retryMode: "always",
      acceptedStatuses: [308]
    });
    return resumableResult(response, normalizedTotal, normalizedTotal, signal);
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
