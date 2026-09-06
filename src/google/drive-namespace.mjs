/**
 * Google Drive hierarchy exposed as VFS paths.
 */

"use strict";

import {
  createDriveSegments,
  joinVfsPath,
  splitVfsPath
} from "../core/vfs-paths.mjs";
import {
  getWorkspaceExport,
  isGoogleWorkspaceFile
} from "./workspace-export.mjs";

export const GOOGLE_FOLDER_MIME_TYPE =
  "application/vnd.google-apps.folder";
export const GOOGLE_SHORTCUT_MIME_TYPE =
  "application/vnd.google-apps.shortcut";

const GOOGLE_MIME_PREFIX = "application/vnd.google-apps.";
const ROOT_KEYS = Object.freeze({
  myDrive: "myDrive",
  sharedWithMe: "sharedWithMe",
  sharedDrives: "sharedDrives"
});

function requireApiClient(value) {
  const methods = [
    "getFile",
    "getStorageQuota",
    "listDrives",
    "listFiles",
    "downloadBlob",
    "exportFile"
  ];
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError("apiClient");
  }
  return value;
}

function normalizeRootLabels(labels) {
  const roots = {};
  const seen = new Set();
  for (const key of Object.values(ROOT_KEYS)) {
    const label = labels?.[key];
    if (typeof label !== "string" || !label.trim()) {
      throw new TypeError(`rootLabels.${key}`);
    }
    const normalized = label.trim();
    joinVfsPath(normalized);
    if (seen.has(normalized)) {
      throw new RangeError("Root labels must be unique");
    }
    seen.add(normalized);
    roots[key] = normalized;
  }
  return Object.freeze(roots);
}

function requireDriveItem(item) {
  if (!item || typeof item !== "object" ||
      typeof item.id !== "string" || !item.id ||
      typeof item.name !== "string" || !item.name ||
      typeof item.mimeType !== "string" || !item.mimeType) {
    throw new GoogleDriveNamespaceError("drive_item_invalid");
  }
  return item;
}

function escapeQueryValue(value) {
  if (typeof value !== "string" || !value) {
    throw new TypeError("Drive query value");
  }
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function numberOrUndefined(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function timeOrUndefined(value) {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function effectiveItem(item) {
  if (item.mimeType !== GOOGLE_SHORTCUT_MIME_TYPE) {
    return {
      id: item.id,
      mimeType: item.mimeType,
      resourceKey: item.resourceKey
    };
  }
  const details = item.shortcutDetails;
  if (!details || typeof details.targetId !== "string" || !details.targetId ||
      typeof details.targetMimeType !== "string" ||
      !details.targetMimeType) {
    throw new GoogleDriveNamespaceError("drive_shortcut_invalid");
  }
  return {
    id: details.targetId,
    mimeType: details.targetMimeType,
    resourceKey: details.targetResourceKey
  };
}

function isFolder(item) {
  return effectiveItem(item).mimeType === GOOGLE_FOLDER_MIME_TYPE;
}

function exportForItem(item, exportFormats) {
  const effective = effectiveItem(item);
  return getWorkspaceExport({
    name: item.name,
    mimeType: effective.mimeType
  }, exportFormats);
}

function canPresent(item, exportFormats) {
  const effective = effectiveItem(item);
  if (effective.mimeType === GOOGLE_FOLDER_MIME_TYPE) {
    return item.mimeType === GOOGLE_SHORTCUT_MIME_TYPE ||
      item.capabilities?.canListChildren !== false;
  }
  if (item.mimeType !== GOOGLE_SHORTCUT_MIME_TYPE &&
      item.capabilities?.canDownload === false) {
    return false;
  }
  if (isGoogleWorkspaceFile(effective.mimeType)) {
    return Boolean(exportForItem(item, exportFormats));
  }
  if (effective.mimeType.startsWith(GOOGLE_MIME_PREFIX)) {
    return false;
  }
  return item.mimeType === GOOGLE_SHORTCUT_MIME_TYPE ||
    item.capabilities?.canDownload !== false;
}

function displayName(item, exportFormats) {
  return exportForItem(item, exportFormats)?.name || item.name;
}

function comparePresented(left, right) {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }
  return left.displayName.localeCompare(right.displayName, undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function asFile(blob, name, mimeType, lastModified, fileFactory) {
  const options = {
    type: blob.type || mimeType || "application/octet-stream"
  };
  if (lastModified !== undefined) {
    options.lastModified = lastModified;
  }
  return fileFactory([blob], name, options);
}

function defaultFileFactory(parts, name, options) {
  return new File(parts, name, options);
}

export class GoogleDriveNamespaceError extends Error {
  constructor(code) {
    super(code);
    this.name = "GoogleDriveNamespaceError";
    this.code = code;
  }
}

export class GoogleDriveNamespace {
  #apiClient;
  #exportFormats;
  #fileFactory;
  #roots;

  constructor({
    apiClient,
    exportFormats,
    rootLabels,
    fileFactory = defaultFileFactory
  }) {
    this.#apiClient = requireApiClient(apiClient);
    if (!exportFormats || typeof exportFormats !== "object") {
      throw new TypeError("exportFormats");
    }
    if (typeof fileFactory !== "function") {
      throw new TypeError("fileFactory");
    }
    this.#exportFormats = structuredClone(exportFormats);
    this.#fileFactory = fileFactory;
    this.#roots = normalizeRootLabels(rootLabels);
  }

  async getStorageUsage({ signal } = {}) {
    const quota = await this.#apiClient.getStorageQuota({ signal });
    return {
      usage: numberOrUndefined(quota?.usage) ?? null,
      quota: numberOrUndefined(quota?.limit) ?? null
    };
  }

  async list(path, { signal } = {}) {
    const resolved = await this.#resolve(path, signal);
    if (resolved.type === "root") {
      return Object.values(ROOT_KEYS).map((key) => ({
        name: this.#roots[key],
        path: joinVfsPath(this.#roots[key]),
        kind: "directory"
      }));
    }
    if (resolved.type === "drive-list") {
      return this.#listSharedDrives(path, signal);
    }

    const context = resolved.type === "context"
      ? resolved.context
      : await this.#folderContext(resolved.presented, signal);
    return this.#listContext(context, path, signal);
  }

  async readFile(path, { signal } = {}) {
    const resolved = await this.#resolve(path, signal);
    if (resolved.type !== "item" || resolved.presented.kind !== "file") {
      throw new GoogleDriveNamespaceError("drive_file_not_found");
    }

    const { item } = resolved.presented;
    const effective = effectiveItem(item);
    const metadata = item.mimeType === GOOGLE_SHORTCUT_MIME_TYPE
      ? await this.#apiClient.getFile(effective.id, {
        resourceKey: effective.resourceKey,
        signal
      })
      : item;
    requireDriveItem(metadata);
    if (metadata.capabilities?.canDownload === false) {
      throw new GoogleDriveNamespaceError("drive_download_forbidden");
    }

    const currentMimeType = metadata.mimeType;
    const accessResourceKey = effective.resourceKey || metadata.resourceKey;
    const exportTarget = getWorkspaceExport({
      name: item.name,
      mimeType: currentMimeType
    }, this.#exportFormats);
    let blob;
    let name;
    if (exportTarget) {
      blob = await this.#apiClient.exportFile(
        metadata.id,
        exportTarget.mimeType,
        { resourceKey: accessResourceKey, signal }
      );
      name = exportTarget.name;
    } else {
      if (currentMimeType.startsWith(GOOGLE_MIME_PREFIX)) {
        throw new GoogleDriveNamespaceError("drive_file_unsupported");
      }
      blob = await this.#apiClient.downloadBlob(metadata.id, {
        resourceKey: accessResourceKey,
        signal
      });
      name = item.name;
    }

    if (!(blob instanceof Blob)) {
      throw new GoogleDriveNamespaceError("drive_response_invalid");
    }
    return asFile(
      blob,
      name,
      exportTarget?.mimeType || currentMimeType,
      timeOrUndefined(metadata.modifiedTime || item.modifiedTime),
      this.#fileFactory
    );
  }

  async #resolve(path, signal) {
    const segments = splitVfsPath(path);
    if (segments.length === 0) {
      return { type: "root" };
    }

    const [rootSegment, ...childSegments] = segments;
    let context;
    let currentPath = joinVfsPath(rootSegment);
    if (rootSegment === this.#roots.myDrive) {
      context = { type: "folder", parentId: "root", driveId: null };
    } else if (rootSegment === this.#roots.sharedWithMe) {
      context = { type: "shared-with-me" };
    } else if (rootSegment === this.#roots.sharedDrives) {
      if (childSegments.length === 0) {
        return { type: "drive-list" };
      }
      const drives = await this.#presentSharedDrives(
        joinVfsPath(rootSegment),
        signal
      );
      const drive = drives.find((entry) => entry.segment === childSegments[0]);
      if (!drive) {
        throw new GoogleDriveNamespaceError("drive_path_not_found");
      }
      context = {
        type: "folder",
        parentId: drive.drive.id,
        driveId: drive.drive.id
      };
      childSegments.shift();
      currentPath = joinVfsPath(rootSegment, drive.segment);
      if (childSegments.length === 0) {
        return { type: "context", context };
      }
    } else {
      throw new GoogleDriveNamespaceError("drive_path_not_found");
    }

    if (childSegments.length === 0) {
      return { type: "context", context };
    }

    for (let index = 0; index < childSegments.length; index += 1) {
      const entries = await this.#presentContext(context, currentPath, signal);
      const presented = entries.find((entry) =>
        entry.segment === childSegments[index]);
      if (!presented) {
        throw new GoogleDriveNamespaceError("drive_path_not_found");
      }
      currentPath = joinVfsPath(...splitVfsPath(currentPath), presented.segment);
      if (index === childSegments.length - 1) {
        return { type: "item", presented };
      }
      context = await this.#folderContext(presented, signal);
    }
    throw new GoogleDriveNamespaceError("drive_path_not_found");
  }

  async #folderContext(presented, signal) {
    if (presented.kind !== "directory") {
      throw new GoogleDriveNamespaceError("drive_not_a_folder");
    }
    const effective = effectiveItem(presented.item);
    if (presented.item.mimeType !== GOOGLE_SHORTCUT_MIME_TYPE) {
      return {
        type: "folder",
        parentId: effective.id,
        resourceKey: effective.resourceKey,
        driveId: presented.item.driveId || presented.contextDriveId || null
      };
    }

    const target = requireDriveItem(await this.#apiClient.getFile(effective.id, {
      resourceKey: effective.resourceKey,
      signal
    }));
    if (target.mimeType !== GOOGLE_FOLDER_MIME_TYPE) {
      throw new GoogleDriveNamespaceError("drive_not_a_folder");
    }
    return {
      type: "folder",
      parentId: target.id,
      resourceKey: effective.resourceKey || target.resourceKey,
      driveId: target.driveId || null
    };
  }

  async #listContext(context, path, signal) {
    const presented = await this.#presentContext(context, path, signal);
    return presented.map(({ entry }) => entry);
  }

  async #presentContext(context, path, signal) {
    const sharedWithMe = context.type === "shared-with-me";
    const query = sharedWithMe
      ? "sharedWithMe and trashed = false"
      : `'${escapeQueryValue(context.parentId)}' in parents and trashed = false`;
    const { files, incompleteSearch } = await this.#apiClient.listFiles({
      q: query,
      spaces: "drive",
      corpora: context.driveId ? "drive" : "user",
      driveId: context.driveId || undefined,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      orderBy: "name_natural",
      resourceKeys: context.resourceKey
        ? [{ fileId: context.parentId, resourceKey: context.resourceKey }]
        : undefined,
      signal
    });
    if (incompleteSearch) {
      throw new GoogleDriveNamespaceError("drive_search_incomplete");
    }
    return this.#presentFiles(files, path, context.driveId || null);
  }

  #presentFiles(files, path, contextDriveId) {
    if (!Array.isArray(files)) {
      throw new GoogleDriveNamespaceError("drive_response_invalid");
    }
    const candidates = files
      .map(requireDriveItem)
      .filter((item) => item.trashed !== true)
      .filter((item) => canPresent(item, this.#exportFormats))
      .map((item) => ({
        id: item.id,
        name: displayName(item, this.#exportFormats),
        item,
        effective: effectiveItem(item)
      }));

    return createDriveSegments(candidates).map((candidate) => {
      const kind = candidate.effective.mimeType === GOOGLE_FOLDER_MIME_TYPE
        ? "directory"
        : "file";
      const entry = {
        name: candidate.segment,
        path: joinVfsPath(...splitVfsPath(path), candidate.segment),
        kind
      };
      if (kind === "file" && !isGoogleWorkspaceFile(candidate.effective.mimeType)) {
        const size = numberOrUndefined(candidate.item.size);
        if (size !== undefined) {
          entry.size = size;
        }
      }
      if (kind === "file") {
        const lastModified = timeOrUndefined(candidate.item.modifiedTime);
        if (lastModified !== undefined) {
          entry.lastModified = lastModified;
        }
      }
      return {
        ...candidate,
        displayName: candidate.name,
        kind,
        entry,
        contextDriveId
      };
    }).sort(comparePresented);
  }

  async #listSharedDrives(path, signal) {
    const presented = await this.#presentSharedDrives(path, signal);
    return presented.map(({ entry }) => entry);
  }

  async #presentSharedDrives(path, signal) {
    const { drives } = await this.#apiClient.listDrives({
      q: "hidden = false",
      signal
    });
    if (!Array.isArray(drives)) {
      throw new GoogleDriveNamespaceError("drive_response_invalid");
    }
    const candidates = drives.map((drive) => {
      if (!drive || typeof drive.id !== "string" || !drive.id ||
          typeof drive.name !== "string" || !drive.name) {
        throw new GoogleDriveNamespaceError("drive_item_invalid");
      }
      return { id: drive.id, name: drive.name, drive };
    });
    return createDriveSegments(candidates).map((candidate) => ({
      ...candidate,
      displayName: candidate.name,
      kind: "directory",
      entry: {
        name: candidate.segment,
        path: joinVfsPath(...splitVfsPath(path), candidate.segment),
        kind: "directory"
      }
    })).sort(comparePresented);
  }
}
