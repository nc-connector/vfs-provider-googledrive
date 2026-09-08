/**
 * Google Drive hierarchy exposed as VFS paths.
 */

"use strict";

import {
  createDriveSegments,
  joinVfsPath,
  splitVfsPath
} from "../core/vfs-paths.mjs";
import { GoogleDriveUploader } from "./drive-uploader.mjs";
import {
  getWorkspaceExport,
  isGoogleWorkspaceFile
} from "./workspace-export.mjs";

export const GOOGLE_FOLDER_MIME_TYPE =
  "application/vnd.google-apps.folder";
export const GOOGLE_SHORTCUT_MIME_TYPE =
  "application/vnd.google-apps.shortcut";

const GOOGLE_MIME_PREFIX = "application/vnd.google-apps.";
const DEFAULT_MEDIA_TYPE = "application/octet-stream";
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
    "exportFile",
    "copyFile",
    "updateFileMetadata"
  ];
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError("apiClient");
  }
  return value;
}

function requireUploader(value) {
  if (!value || typeof value.upload !== "function") {
    throw new TypeError("uploader");
  }
  return value;
}

function targetExistsError() {
  return Object.assign(new Error("Target already exists"), {
    code: "E:EXIST"
  });
}

function collectResourceKeys(entries) {
  const resourceKeys = [];
  const seen = new Map();
  for (const { fileId, resourceKey } of entries) {
    if (resourceKey === undefined || resourceKey === null ||
        resourceKey === "") {
      continue;
    }
    if (typeof fileId !== "string" || !fileId ||
        typeof resourceKey !== "string") {
      throw new GoogleDriveNamespaceError("drive_item_invalid");
    }
    if (seen.has(fileId)) {
      if (seen.get(fileId) !== resourceKey) {
        throw new GoogleDriveNamespaceError("drive_item_invalid");
      }
      continue;
    }
    seen.set(fileId, resourceKey);
    resourceKeys.push({ fileId, resourceKey });
  }
  return resourceKeys.length > 0 ? resourceKeys : undefined;
}

function isSameOrChildPath(path, parentPath) {
  const segments = splitVfsPath(path);
  const parentSegments = splitVfsPath(parentPath);
  return segments.length >= parentSegments.length &&
    parentSegments.every((segment, index) => segment === segments[index]);
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
  #logger;
  #roots;
  #uploader;

  constructor({
    apiClient,
    exportFormats,
    rootLabels,
    fileFactory = defaultFileFactory,
    logger,
    uploader = null
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
    this.#logger = logger;
    this.#roots = normalizeRootLabels(rootLabels);
    this.#uploader = uploader === null ? null : requireUploader(uploader);
  }

  async getStorageUsage({ signal } = {}) {
    const quota = await this.#apiClient.getStorageQuota({ signal });
    return {
      usage: numberOrUndefined(quota?.usage) ?? null,
      quota: numberOrUndefined(quota?.limit) ?? null
    };
  }

  async list(path, { signal } = {}) {
    if (path === "/") {
      const entries = await this.#listContext(
        this.#myDriveRootContext(),
        path,
        signal
      );
      return [
        {
          name: this.#roots.sharedWithMe,
          path: joinVfsPath(this.#roots.sharedWithMe),
          kind: "directory"
        },
        {
          name: this.#roots.sharedDrives,
          path: joinVfsPath(this.#roots.sharedDrives),
          kind: "directory"
        },
        ...entries
      ];
    }
    const resolved = await this.#resolve(path, signal);
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

  async writeFile(path, file, {
    overwrite = false,
    signal,
    onProgress = () => {}
  } = {}) {
    if (!(file instanceof Blob)) {
      throw new TypeError("file");
    }
    if (typeof overwrite !== "boolean") {
      throw new TypeError("overwrite");
    }
    if (typeof onProgress !== "function") {
      throw new TypeError("onProgress");
    }

    const target = await this.#resolveMutationTarget(path, signal);
    let existingFileId = null;
    let resourceKeys;
    let metadata;
    if (target.existing) {
      if (target.existing.kind !== "file" || !overwrite) {
        throw targetExistsError();
      }
      const item = target.existing.item;
      if (item.mimeType.startsWith(GOOGLE_MIME_PREFIX)) {
        throw new GoogleDriveNamespaceError("drive_overwrite_unsupported");
      }
      if (item.capabilities?.canModifyContent !== true) {
        throw new GoogleDriveNamespaceError("drive_write_forbidden");
      }
      existingFileId = item.id;
      resourceKeys = item.resourceKey
        ? [{ fileId: item.id, resourceKey: item.resourceKey }]
        : undefined;
      metadata = {
        name: item.name,
        mimeType: file.type || item.mimeType || DEFAULT_MEDIA_TYPE
      };
    } else {
      await this.#requireWritableParent(target.context, signal);
      metadata = {
        name: target.name,
        mimeType: file.type || DEFAULT_MEDIA_TYPE,
        parents: [target.context.parentId]
      };
      resourceKeys = target.context.resourceKey
        ? [{
            fileId: target.context.parentId,
            resourceKey: target.context.resourceKey
          }]
        : undefined;
    }

    const uploader = this.#uploader || new GoogleDriveUploader({
      apiClient: this.#apiClient,
      logger: this.#logger
    });
    return uploader.upload({
      file,
      metadata,
      existingFileId,
      resourceKeys,
      signal,
      onProgress
    });
  }

  async addFolder(path, { signal, onProgress = () => {} } = {}) {
    if (typeof onProgress !== "function") {
      throw new TypeError("onProgress");
    }
    const segments = splitVfsPath(path);
    const rootSegments = segments[0] === this.#roots.sharedDrives
      ? 2
      : (segments[0] === this.#roots.myDrive ||
          segments[0] === this.#roots.sharedWithMe ? 1 : 0);
    const targetDepth = segments.length - rootSegments;
    const reportCreatedFolder = (depth) => onProgress(
      Math.round((depth / Math.max(1, targetDepth)) * 100)
    );
    const target = await this.#resolveMutationTarget(
      path,
      signal,
      reportCreatedFolder
    );
    if (target.existing) {
      throw targetExistsError();
    }
    await this.#createFolder(target.context, target.name, signal);
    reportCreatedFolder(targetDepth);
  }

  async moveFile(oldPath, newPath, {
    overwrite = false,
    signal,
    onProgress = () => {},
    onPartialChanges = () => {}
  } = {}) {
    if (typeof overwrite !== "boolean") {
      throw new TypeError("overwrite");
    }
    return this.#moveEntry(oldPath, newPath, "file", overwrite, {
      signal,
      onProgress,
      onPartialChanges
    });
  }

  async moveFolder(oldPath, newPath, {
    merge = false,
    signal,
    onProgress = () => {},
    onPartialChanges = () => {}
  } = {}) {
    if (typeof merge !== "boolean") {
      throw new TypeError("merge");
    }
    if (isSameOrChildPath(
      joinVfsPath(...splitVfsPath(newPath).slice(0, -1)),
      oldPath
    )) {
      throw new GoogleDriveNamespaceError("drive_move_forbidden");
    }
    return this.#moveEntry(oldPath, newPath, "directory", merge, {
      signal,
      onProgress,
      onPartialChanges
    });
  }

  async copyFile(oldPath, newPath, {
    overwrite = false,
    signal,
    onProgress = () => {},
    onPartialChanges = () => {}
  } = {}) {
    if (typeof overwrite !== "boolean") {
      throw new TypeError("overwrite");
    }
    return this.#copyEntry(oldPath, newPath, "file", overwrite, {
      signal,
      onProgress,
      onPartialChanges
    });
  }

  async copyFolder(oldPath, newPath, {
    merge = false,
    signal,
    onProgress = () => {},
    onPartialChanges = () => {}
  } = {}) {
    if (typeof merge !== "boolean") {
      throw new TypeError("merge");
    }
    if (isSameOrChildPath(newPath, oldPath)) {
      throw new GoogleDriveNamespaceError("drive_copy_forbidden");
    }
    return this.#copyEntry(oldPath, newPath, "directory", merge, {
      signal,
      onProgress,
      onPartialChanges
    });
  }

  async deleteFile(path, { signal, onProgress = () => {} } = {}) {
    return this.#trash(path, "file", signal, onProgress);
  }

  async deleteFolder(path, { signal, onProgress = () => {} } = {}) {
    return this.#trash(path, "directory", signal, onProgress);
  }

  async #trash(path, expectedKind, signal, onProgress) {
    if (typeof onProgress !== "function") {
      throw new TypeError("onProgress");
    }
    const resolved = await this.#resolve(path, signal);
    if (resolved.type !== "item" ||
        resolved.presented.kind !== expectedKind) {
      const code = expectedKind === "file"
        ? "drive_file_not_found"
        : "drive_path_not_found";
      throw new GoogleDriveNamespaceError(code);
    }

    const action = this.#trashAction(
      resolved.presented,
      path,
      expectedKind,
      "drive_delete_forbidden"
    );
    await this.#executeMutationPlan(
      [action],
      signal,
      onProgress,
      () => {}
    );
  }

  async #copyEntry(oldPath, newPath, expectedKind, replace, {
    signal,
    onProgress,
    onPartialChanges
  }) {
    if (typeof onProgress !== "function") {
      throw new TypeError("onProgress");
    }
    if (typeof onPartialChanges !== "function") {
      throw new TypeError("onPartialChanges");
    }
    const oldSegments = splitVfsPath(oldPath);
    if (oldSegments.length < 2) {
      throw new GoogleDriveNamespaceError("drive_path_not_found");
    }
    const source = await this.#resolve(oldPath, signal);
    if (source.type !== "item" || source.presented.kind !== expectedKind) {
      const code = expectedKind === "file"
        ? "drive_file_not_found"
        : "drive_path_not_found";
      throw new GoogleDriveNamespaceError(code);
    }
    const sourceParentPath = joinVfsPath(...oldSegments.slice(0, -1));
    const target = await this.#resolveExistingMutationTarget(
      newPath,
      signal,
      sourceParentPath,
      "drive_copy_forbidden"
    );
    if (target.existing?.item.id === source.presented.item.id) {
      throw targetExistsError();
    }
    // Copied IDs can change duplicate-name suffixes; the existing parent remains addressable.
    const reportCopyParentChange = () => onPartialChanges([{
      kind: "directory",
      action: "modified",
      target: { path: target.parentPath }
    }]);

    const plan = [];
    if (expectedKind === "file") {
      if (target.existing) {
        if (target.existing.kind !== "file" || !replace) {
          throw targetExistsError();
        }
        plan.push(this.#trashAction(
          target.existing,
          newPath,
          "file",
          "drive_copy_forbidden"
        ));
      }
      plan.push(await this.#copyAction({
        presented: source.presented,
        targetContext: target.context,
        destinationName: this.#moveDestinationName(source.presented, target),
        oldPath,
        newPath,
        signal
      }));
    } else {
      if (target.existing &&
          (target.existing.kind !== "directory" || !replace)) {
        throw targetExistsError();
      }
      const sourceContext = await this.#folderContext(
        source.presented,
        signal
      );
      let targetContext = target.existing
        ? await this.#folderContext(target.existing, signal)
        : null;
      if (!targetContext) {
        const createRoot = await this.#createFolderAction({
          targetContext: target.context,
          name: this.#moveDestinationName(source.presented, target),
          targetPath: newPath,
          signal
        });
        plan.push(createRoot);
        targetContext = createRoot;
      }
      await this.#buildFolderCopyPlan({
        sourceContext,
        sourcePath: oldPath,
        targetContext,
        targetPath: newPath,
        signal,
        plan,
        ancestorSourceIds: new Set([sourceContext.parentId])
      });
    }

    await this.#executeMutationPlan(
      plan,
      signal,
      onProgress,
      reportCopyParentChange
    );
  }

  async #moveEntry(oldPath, newPath, expectedKind, replace, {
    signal,
    onProgress,
    onPartialChanges
  }) {
    if (typeof onProgress !== "function") {
      throw new TypeError("onProgress");
    }
    if (typeof onPartialChanges !== "function") {
      throw new TypeError("onPartialChanges");
    }
    const oldSegments = splitVfsPath(oldPath);
    if (oldSegments.length < 2) {
      throw new GoogleDriveNamespaceError("drive_path_not_found");
    }
    const source = await this.#resolve(oldPath, signal);
    if (source.type !== "item" || source.presented.kind !== expectedKind) {
      const code = expectedKind === "file"
        ? "drive_file_not_found"
        : "drive_path_not_found";
      throw new GoogleDriveNamespaceError(code);
    }
    const sourceParentPath = joinVfsPath(...oldSegments.slice(0, -1));
    const target = await this.#resolveExistingMutationTarget(
      newPath,
      signal,
      sourceParentPath
    );
    if (target.existing?.item.id === source.presented.item.id) {
      onProgress(0);
      onProgress(100);
      return;
    }

    const plan = [];
    if (expectedKind === "file") {
      if (target.existing) {
        if (target.existing.kind !== "file" || !replace) {
          throw targetExistsError();
        }
        plan.push(this.#trashAction(
          target.existing,
          newPath,
          "file",
          "drive_move_forbidden"
        ));
      }
      const action = await this.#moveAction({
        presented: source.presented,
        sourceContext: source.context,
        sourceParentPath,
        targetContext: target.context,
        targetParentPath: target.parentPath,
        destinationName: this.#moveDestinationName(source.presented, target),
        oldPath,
        newPath,
        signal
      });
      if (action) {
        plan.push(action);
      }
    } else if (!target.existing) {
      const action = await this.#moveAction({
        presented: source.presented,
        sourceContext: source.context,
        sourceParentPath,
        targetContext: target.context,
        targetParentPath: target.parentPath,
        destinationName: this.#moveDestinationName(source.presented, target),
        oldPath,
        newPath,
        signal
      });
      if (action) {
        plan.push(action);
      }
    } else {
      if (target.existing.kind !== "directory" || !replace) {
        throw targetExistsError();
      }
      if (source.presented.item.mimeType === GOOGLE_SHORTCUT_MIME_TYPE) {
        throw new GoogleDriveNamespaceError("drive_move_unsupported");
      }
      const sourceContext = await this.#folderContext(
        source.presented,
        signal
      );
      const targetContext = await this.#folderContext(
        target.existing,
        signal
      );
      if (targetContext.parentId === source.presented.item.id) {
        throw new GoogleDriveNamespaceError("drive_move_forbidden");
      }
      const sourceTrash = this.#trashAction(
        source.presented,
        oldPath,
        "directory",
        "drive_move_forbidden"
      );
      await this.#buildFolderMergePlan({
        sourceContext,
        sourcePath: oldPath,
        targetContext,
        targetPath: newPath,
        signal,
        plan
      });
      plan.push(sourceTrash);
    }

    await this.#executeMutationPlan(
      plan,
      signal,
      onProgress,
      onPartialChanges
    );
  }

  #moveDestinationName(source, target) {
    if (target.segment === source.segment) {
      return source.item.name;
    }
    return target.existing?.displayName || target.name;
  }

  async #moveAction({
    presented,
    sourceContext,
    sourceParentPath,
    targetContext,
    targetParentPath,
    destinationName,
    oldPath,
    newPath,
    signal
  }) {
    const { item } = presented;
    const sameParent = sourceParentPath === targetParentPath ||
      (sourceContext.type === "folder" && targetContext.type === "folder" &&
       sourceContext.parentId === targetContext.parentId);
    const rename = item.name !== destinationName;
    if (rename && item.capabilities?.canRename !== true) {
      throw new GoogleDriveNamespaceError("drive_move_forbidden");
    }
    if (sameParent && !rename) {
      return null;
    }

    let addParents;
    let removeParents;
    if (!sameParent) {
      if (sourceContext.type !== "folder" || targetContext.type !== "folder") {
        throw new GoogleDriveNamespaceError("drive_move_forbidden");
      }
      const sourceDriveId = item.driveId || sourceContext.driveId || null;
      const targetDriveId = targetContext.driveId || null;
      if (sourceDriveId === targetDriveId) {
        if (item.capabilities?.canMoveItemWithinDrive !== true) {
          throw new GoogleDriveNamespaceError("drive_move_forbidden");
        }
      } else {
        if (item.capabilities?.canMoveItemOutOfDrive !== true ||
            (item.mimeType === GOOGLE_FOLDER_MIME_TYPE &&
             sourceDriveId === null && targetDriveId !== null)) {
          throw new GoogleDriveNamespaceError("drive_move_forbidden");
        }
      }
      await this.#requireWritableParent(targetContext, signal);
      addParents = targetContext.parentId;
      const parentIds = Array.isArray(item.parents)
        ? item.parents.filter((id) => typeof id === "string" && id)
        : [];
      removeParents = (parentIds.length > 0
        ? parentIds
        : [sourceContext.parentId]).join(",");
    }

    return {
      type: "move",
      fileId: item.id,
      metadata: rename ? { name: destinationName } : {},
      options: {
        addParents,
        removeParents,
        supportsAllDrives: true,
        resourceKeys: collectResourceKeys([
          { fileId: item.id, resourceKey: item.resourceKey },
          {
            fileId: sourceContext.parentId,
            resourceKey: sourceContext.resourceKey
          },
          {
            fileId: targetContext.parentId,
            resourceKey: targetContext.resourceKey
          }
        ])
      },
      change: {
        kind: presented.kind,
        action: "moved",
        target: { path: newPath },
        source: { path: oldPath }
      }
    };
  }

  #trashAction(presented, path, kind, forbiddenCode) {
    const { item } = presented;
    if (item.capabilities?.canTrash !== true) {
      throw new GoogleDriveNamespaceError(forbiddenCode);
    }
    return {
      type: "trash",
      fileId: item.id,
      metadata: { trashed: true },
      options: {
        supportsAllDrives: true,
        resourceKeys: collectResourceKeys([{
          fileId: item.id,
          resourceKey: item.resourceKey
        }])
      },
      change: {
        kind,
        action: "deleted",
        target: { path }
      }
    };
  }

  async #copyAction({
    presented,
    targetContext,
    destinationName,
    oldPath,
    newPath,
    signal
  }) {
    if (presented.kind !== "file" ||
        presented.item.capabilities?.canCopy !== true) {
      throw new GoogleDriveNamespaceError("drive_copy_forbidden");
    }
    if (targetContext.type !== "create-folder") {
      await this.#requireWritableParent(targetContext, signal);
    }
    return {
      type: "copy",
      source: presented.item,
      targetContext,
      destinationName,
      change: {
        kind: "file",
        action: "copied",
        target: { path: newPath },
        source: { path: oldPath }
      }
    };
  }

  async #createFolderAction({
    targetContext,
    name,
    targetPath,
    signal
  }) {
    if (targetContext.type !== "create-folder") {
      await this.#requireWritableParent(targetContext, signal);
    }
    return {
      type: "create-folder",
      targetContext,
      name,
      createdContext: null,
      change: {
        kind: "directory",
        action: "created",
        target: { path: targetPath }
      }
    };
  }

  async #buildFolderCopyPlan({
    sourceContext,
    sourcePath,
    targetContext,
    targetPath,
    signal,
    plan,
    ancestorSourceIds
  }) {
    const sourceEntries = await this.#presentContext(
      sourceContext,
      sourcePath,
      signal
    );
    const targetEntries = targetContext.type === "create-folder"
      ? []
      : await this.#presentContext(targetContext, targetPath, signal);
    const targetsBySegment = new Map(
      targetEntries.map((entry) => [entry.segment, entry])
    );

    for (const source of sourceEntries) {
      const oldPath = source.entry.path;
      const newPath = joinVfsPath(
        ...splitVfsPath(targetPath),
        source.segment
      );
      const target = targetsBySegment.get(source.segment);
      if (source.kind === "file") {
        if (target?.item.id === source.item.id) {
          continue;
        }
        if (target && target.kind !== "file") {
          throw targetExistsError();
        }
        if (target) {
          plan.push(this.#trashAction(
            target,
            newPath,
            "file",
            "drive_copy_forbidden"
          ));
        }
        plan.push(await this.#copyAction({
          presented: source,
          targetContext,
          destinationName: target?.displayName || source.item.name,
          oldPath,
          newPath,
          signal
        }));
        continue;
      }

      if (target && target.kind !== "directory") {
        throw targetExistsError();
      }
      const nestedSourceContext = await this.#folderContext(source, signal);
      if (ancestorSourceIds.has(nestedSourceContext.parentId)) {
        throw new GoogleDriveNamespaceError("drive_copy_unsupported");
      }
      const nestedAncestors = new Set(ancestorSourceIds);
      nestedAncestors.add(nestedSourceContext.parentId);
      let nestedTargetContext;
      if (target) {
        nestedTargetContext = await this.#folderContext(target, signal);
        if (nestedTargetContext.parentId === nestedSourceContext.parentId) {
          throw new GoogleDriveNamespaceError("drive_copy_forbidden");
        }
      } else {
        const createFolder = await this.#createFolderAction({
          targetContext,
          name: source.item.name,
          targetPath: newPath,
          signal
        });
        plan.push(createFolder);
        nestedTargetContext = createFolder;
      }
      await this.#buildFolderCopyPlan({
        sourceContext: nestedSourceContext,
        sourcePath: oldPath,
        targetContext: nestedTargetContext,
        targetPath: newPath,
        signal,
        plan,
        ancestorSourceIds: nestedAncestors
      });
    }
  }

  async #buildFolderMergePlan({
    sourceContext,
    sourcePath,
    targetContext,
    targetPath,
    signal,
    plan
  }) {
    const sourceEntries = await this.#presentContext(
      sourceContext,
      sourcePath,
      signal
    );
    const targetEntries = await this.#presentContext(
      targetContext,
      targetPath,
      signal
    );
    const targetsBySegment = new Map(
      targetEntries.map((entry) => [entry.segment, entry])
    );

    for (const source of sourceEntries) {
      const oldPath = source.entry.path;
      const newPath = joinVfsPath(
        ...splitVfsPath(targetPath),
        source.segment
      );
      const target = targetsBySegment.get(source.segment);
      if (!target) {
        const action = await this.#moveAction({
          presented: source,
          sourceContext,
          sourceParentPath: sourcePath,
          targetContext,
          targetParentPath: targetPath,
          destinationName: source.item.name,
          oldPath,
          newPath,
          signal
        });
        if (action) {
          plan.push(action);
        }
        continue;
      }
      if (source.kind !== target.kind) {
        throw targetExistsError();
      }
      if (source.kind === "file") {
        plan.push(this.#trashAction(
          target,
          newPath,
          "file",
          "drive_move_forbidden"
        ));
        const action = await this.#moveAction({
          presented: source,
          sourceContext,
          sourceParentPath: sourcePath,
          targetContext,
          targetParentPath: targetPath,
          destinationName: source.item.name,
          oldPath,
          newPath,
          signal
        });
        if (action) {
          plan.push(action);
        }
        continue;
      }
      if (source.item.mimeType === GOOGLE_SHORTCUT_MIME_TYPE) {
        throw new GoogleDriveNamespaceError("drive_move_unsupported");
      }
      const nestedSourceContext = await this.#folderContext(source, signal);
      const nestedTargetContext = await this.#folderContext(target, signal);
      if (nestedTargetContext.parentId === source.item.id) {
        throw new GoogleDriveNamespaceError("drive_move_forbidden");
      }
      const sourceTrash = this.#trashAction(
        source,
        oldPath,
        "directory",
        "drive_move_forbidden"
      );
      await this.#buildFolderMergePlan({
        sourceContext: nestedSourceContext,
        sourcePath: oldPath,
        targetContext: nestedTargetContext,
        targetPath: newPath,
        signal,
        plan
      });
      plan.push(sourceTrash);
    }
  }

  async #executeMutationPlan(plan, signal, onProgress, onPartialChanges) {
    const completed = [];
    onProgress(0);
    try {
      for (const [index, action] of plan.entries()) {
        await this.#executeMutationAction(action, signal);
        completed.push(action.change);
        onProgress(Math.round(((index + 1) / Math.max(1, plan.length)) * 100));
      }
      if (plan.length === 0) {
        onProgress(100);
      }
    } catch (error) {
      if (completed.length > 0) {
        await onPartialChanges(completed);
        if (error?.name === "AbortError") {
          return;
        }
      }
      throw error;
    }
  }

  async #executeMutationAction(action, signal) {
    if (action.type === "create-folder") {
      const targetContext = this.#mutationContext(action.targetContext);
      action.createdContext = await this.#createFolder(
        targetContext,
        action.name,
        signal
      );
      return;
    }
    if (action.type === "copy") {
      const targetContext = this.#mutationContext(action.targetContext);
      await this.#requireWritableParent(targetContext, signal);
      const copied = requireDriveItem(await this.#apiClient.copyFile(
        action.source.id,
        {
          name: action.destinationName,
          parents: [targetContext.parentId]
        },
        {
          supportsAllDrives: true,
          resourceKeys: collectResourceKeys([
            {
              fileId: action.source.id,
              resourceKey: action.source.resourceKey
            },
            {
              fileId: targetContext.parentId,
              resourceKey: targetContext.resourceKey
            }
          ]),
          signal
        }
      ));
      if (isFolder(copied)) {
        throw new GoogleDriveNamespaceError("drive_response_invalid");
      }
      return;
    }
    await this.#apiClient.updateFileMetadata(
      action.fileId,
      action.metadata,
      { ...action.options, signal }
    );
  }

  #mutationContext(context) {
    if (context.type !== "create-folder") {
      return context;
    }
    if (!context.createdContext) {
      throw new GoogleDriveNamespaceError("drive_response_invalid");
    }
    return context.createdContext;
  }

  #myDriveRootContext() {
    return {
      type: "folder",
      parentId: "root",
      driveId: null,
      canAddChildren: undefined
    };
  }

  #reservedRootSegments(path) {
    return path === "/" ? Object.values(this.#roots) : [];
  }

  async #resolve(path, signal) {
    const segments = splitVfsPath(path);
    if (segments.length === 0) {
      return { type: "context", context: this.#myDriveRootContext() };
    }

    const rootSegment = segments[0];
    let childSegments = segments.slice(1);
    let context;
    let currentPath = joinVfsPath(rootSegment);
    if (rootSegment === this.#roots.myDrive) {
      context = this.#myDriveRootContext();
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
        driveId: drive.drive.id,
        canAddChildren: drive.drive.capabilities?.canAddChildren
      };
      childSegments.shift();
      currentPath = joinVfsPath(rootSegment, drive.segment);
      if (childSegments.length === 0) {
        return { type: "context", context };
      }
    } else {
      context = this.#myDriveRootContext();
      childSegments = segments;
      currentPath = "/";
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
        return { type: "item", presented, context };
      }
      context = await this.#folderContext(presented, signal);
    }
    throw new GoogleDriveNamespaceError("drive_path_not_found");
  }

  async #resolveMutationTarget(path, signal, onFolderCreated) {
    const segments = splitVfsPath(path);
    if (segments.length < 1) {
      throw new GoogleDriveNamespaceError("drive_path_not_found");
    }
    const targetSegment = segments.pop();
    const { context, path: parentPath } =
      await this.#resolveMutationParent(segments, signal, onFolderCreated);
    const target = await this.#lookupMutationEntry(
      context,
      parentPath,
      targetSegment,
      signal
    );
    return { context, ...target };
  }

  async #resolveExistingMutationTarget(
    path,
    signal,
    sourceParentPath,
    forbiddenCode = "drive_move_forbidden"
  ) {
    const segments = splitVfsPath(path);
    if (segments.length < 1) {
      throw new GoogleDriveNamespaceError("drive_path_not_found");
    }
    const segment = segments.pop();
    const parentPath = joinVfsPath(...segments);
    const resolved = await this.#resolve(parentPath, signal);
    let context;
    if (resolved.type === "context") {
      context = resolved.context;
    } else if (resolved.type === "item") {
      context = await this.#folderContext(resolved.presented, signal);
    } else {
      throw new GoogleDriveNamespaceError(forbiddenCode);
    }
    if (context.type === "shared-with-me" &&
        parentPath !== sourceParentPath) {
      throw new GoogleDriveNamespaceError(forbiddenCode);
    }
    const target = await this.#lookupMutationEntry(
      context,
      parentPath,
      segment,
      signal
    );
    return { context, parentPath, segment, ...target };
  }

  async #resolveMutationParent(segments, signal, onFolderCreated) {
    const remainingSegments = [...segments];
    const rootSegment = remainingSegments[0];
    let context = this.#myDriveRootContext();
    let currentPath = "/";
    if (rootSegment === this.#roots.myDrive) {
      remainingSegments.shift();
      currentPath = joinVfsPath(rootSegment);
    } else if (rootSegment === this.#roots.sharedWithMe) {
      remainingSegments.shift();
      context = { type: "shared-with-me" };
      currentPath = joinVfsPath(rootSegment);
    } else if (rootSegment === this.#roots.sharedDrives) {
      remainingSegments.shift();
      currentPath = joinVfsPath(rootSegment);
      if (remainingSegments.length === 0) {
        throw new GoogleDriveNamespaceError("drive_write_forbidden");
      }
      const drives = await this.#presentSharedDrives(currentPath, signal);
      const drive = drives.find((entry) =>
        entry.segment === remainingSegments[0]);
      if (!drive) {
        throw new GoogleDriveNamespaceError("drive_path_not_found");
      }
      context = {
        type: "folder",
        parentId: drive.drive.id,
        driveId: drive.drive.id,
        canAddChildren: drive.drive.capabilities?.canAddChildren
      };
      remainingSegments.shift();
      currentPath = joinVfsPath(rootSegment, drive.segment);
    }

    for (let index = 0; index < remainingSegments.length; index += 1) {
      const segment = remainingSegments[index];
      const resolved = await this.#lookupMutationEntry(
        context,
        currentPath,
        segment,
        signal
      );
      if (resolved.existing) {
        context = await this.#folderContext(resolved.existing, signal);
      } else {
        context = await this.#createFolder(
          context,
          resolved.name,
          signal
        );
        onFolderCreated?.(index + 1);
      }
      currentPath = joinVfsPath(
        ...splitVfsPath(currentPath),
        segment
      );
    }
    return { context, path: currentPath };
  }

  async #lookupMutationEntry(context, path, segment, signal) {
    const files = await this.#contextFiles(context, signal);
    const reservedSegments = this.#reservedRootSegments(path);
    const entries = this.#presentFiles(
      files,
      path,
      context.driveId || null,
      reservedSegments
    );
    const existing = entries.find((entry) => entry.segment === segment);
    if (existing) {
      return { existing, name: null };
    }

    if (reservedSegments.includes(segment)) {
      throw targetExistsError();
    }

    const collides = files
      .map(requireDriveItem)
      .filter((item) => item.trashed !== true)
      .some((item) =>
        displayName(item, this.#exportFormats) === segment);
    if (collides) {
      throw targetExistsError();
    }
    return { existing: null, name: segment };
  }

  async #createFolder(context, name, signal) {
    await this.#requireWritableParent(context, signal);
    if (typeof this.#apiClient.createFileMetadata !== "function") {
      throw new TypeError("apiClient");
    }
    const item = requireDriveItem(await this.#apiClient.createFileMetadata({
      name,
      mimeType: GOOGLE_FOLDER_MIME_TYPE,
      parents: [context.parentId]
    }, {
      supportsAllDrives: true,
      resourceKeys: context.resourceKey
        ? [{ fileId: context.parentId, resourceKey: context.resourceKey }]
        : undefined,
      signal
    }));
    if (item.mimeType !== GOOGLE_FOLDER_MIME_TYPE) {
      throw new GoogleDriveNamespaceError("drive_response_invalid");
    }
    return {
      type: "folder",
      parentId: item.id,
      resourceKey: item.resourceKey,
      driveId: item.driveId || context.driveId || null,
      canAddChildren: item.capabilities?.canAddChildren
    };
  }

  async #requireWritableParent(context, signal) {
    if (context.type !== "folder" || context.canAddChildren === false) {
      throw new GoogleDriveNamespaceError("drive_write_forbidden");
    }
    if (context.canAddChildren === true) {
      return;
    }
    const parent = requireDriveItem(await this.#apiClient.getFile(
      context.parentId,
      { resourceKey: context.resourceKey, signal }
    ));
    if (parent.mimeType !== GOOGLE_FOLDER_MIME_TYPE ||
        parent.capabilities?.canAddChildren !== true) {
      throw new GoogleDriveNamespaceError("drive_write_forbidden");
    }
    context.canAddChildren = true;
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
        driveId: presented.item.driveId || presented.contextDriveId || null,
        canAddChildren: presented.item.capabilities?.canAddChildren
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
      driveId: target.driveId || null,
      canAddChildren: target.capabilities?.canAddChildren
    };
  }

  async #listContext(context, path, signal) {
    const presented = await this.#presentContext(context, path, signal);
    return presented.map(({ entry }) => entry);
  }

  async #presentContext(context, path, signal) {
    const files = await this.#contextFiles(context, signal);
    return this.#presentFiles(
      files,
      path,
      context.driveId || null,
      this.#reservedRootSegments(path)
    );
  }

  async #contextFiles(context, signal) {
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
    return files;
  }

  #presentFiles(files, path, contextDriveId, reservedSegments = []) {
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

    return createDriveSegments(candidates, { reservedSegments })
      .map((candidate) => {
        const kind = candidate.effective.mimeType === GOOGLE_FOLDER_MIME_TYPE
          ? "directory"
          : "file";
        const entry = {
          name: candidate.segment,
          path: joinVfsPath(...splitVfsPath(path), candidate.segment),
          kind
        };
        if (kind === "file" &&
            !isGoogleWorkspaceFile(candidate.effective.mimeType)) {
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
