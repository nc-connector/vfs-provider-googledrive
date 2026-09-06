/**
 * Persistent provider preferences and Google Workspace export choices.
 */

"use strict";

export const PROVIDER_PREFERENCES_KEY = "google-drive-provider-preferences";
export const PROVIDER_PREFERENCES_VERSION = 1;

export const EXPORT_FORMATS = Object.freeze({
  document: Object.freeze(["docx", "pdf"]),
  spreadsheet: Object.freeze(["xlsx", "pdf"]),
  presentation: Object.freeze(["pptx", "pdf"]),
  drawing: Object.freeze(["pdf"])
});

export const DEFAULT_PROVIDER_PREFERENCES = Object.freeze({
  version: PROVIDER_PREFERENCES_VERSION,
  oauthClientId: "",
  debugLogging: false,
  exportFormats: Object.freeze({
    document: "docx",
    spreadsheet: "xlsx",
    presentation: "pptx",
    drawing: "pdf"
  })
});

function clone(value) {
  return structuredClone(value);
}

function normalizeClientId(value) {
  if (typeof value !== "string") {
    throw new TypeError("oauthClientId must be a string");
  }
  return value.trim();
}

function normalizeExportFormats(value, fallback) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("exportFormats must be an object");
  }
  const result = {};
  for (const [kind, allowed] of Object.entries(EXPORT_FORMATS)) {
    const format = value[kind] ?? fallback[kind];
    if (!allowed.includes(format)) {
      throw new TypeError(`Unsupported ${kind} export format: ${format}`);
    }
    result[kind] = format;
  }
  return result;
}

function normalizePreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored provider preferences are invalid");
  }
  if (value.version !== PROVIDER_PREFERENCES_VERSION) {
    throw new Error(`Unsupported provider preferences version: ${value.version}`);
  }
  if (typeof value.debugLogging !== "boolean") {
    throw new Error("Stored debug preference is invalid");
  }
  return {
    version: PROVIDER_PREFERENCES_VERSION,
    oauthClientId: normalizeClientId(value.oauthClientId),
    debugLogging: value.debugLogging,
    exportFormats: normalizeExportFormats(
      value.exportFormats,
      DEFAULT_PROVIDER_PREFERENCES.exportFormats
    )
  };
}

export class ProviderPreferencesRepository {
  #storageArea;
  #writeQueue = Promise.resolve();

  constructor({ storageArea }) {
    if (!storageArea?.get || !storageArea?.set) {
      throw new TypeError("A WebExtension storage area is required");
    }
    this.#storageArea = storageArea;
  }

  async initialize() {
    const stored = await this.#storageArea.get(PROVIDER_PREFERENCES_KEY);
    if (!Object.hasOwn(stored, PROVIDER_PREFERENCES_KEY)) {
      const preferences = clone(DEFAULT_PROVIDER_PREFERENCES);
      await this.#storageArea.set({
        [PROVIDER_PREFERENCES_KEY]: preferences
      });
      return preferences;
    }
    return normalizePreferences(stored[PROVIDER_PREFERENCES_KEY]);
  }

  async get() {
    const stored = await this.#storageArea.get(PROVIDER_PREFERENCES_KEY);
    if (!Object.hasOwn(stored, PROVIDER_PREFERENCES_KEY)) {
      return this.initialize();
    }
    return normalizePreferences(stored[PROVIDER_PREFERENCES_KEY]);
  }

  async update(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new TypeError("Preference changes must be an object");
    }
    const operation = this.#writeQueue.then(async () => {
      const current = await this.get();
      const next = normalizePreferences({
        ...current,
        ...patch,
        exportFormats: {
          ...current.exportFormats,
          ...(patch.exportFormats || {})
        }
      });
      await this.#storageArea.set({
        [PROVIDER_PREFERENCES_KEY]: next
      });
      return clone(next);
    });
    this.#writeQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }
}
