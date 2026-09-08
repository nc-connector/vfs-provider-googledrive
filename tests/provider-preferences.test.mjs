/**
 * Provider preference repository tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROVIDER_PREFERENCES,
  PROVIDER_PREFERENCES_KEY,
  PROVIDER_PREFERENCES_VERSION,
  ProviderPreferencesRepository
} from "../src/state/provider-preferences.mjs";
import { FakeStorageArea } from "./helpers/fake-storage.mjs";

test("initializes the documented export defaults", async () => {
  const storageArea = new FakeStorageArea();
  const repository = new ProviderPreferencesRepository({ storageArea });

  const preferences = await repository.initialize();

  assert.deepEqual(preferences, DEFAULT_PROVIDER_PREFERENCES);
  assert.deepEqual(
    storageArea.snapshot()[PROVIDER_PREFERENCES_KEY],
    DEFAULT_PROVIDER_PREFERENCES
  );
});

test("updates one export choice without replacing the others", async () => {
  const repository = new ProviderPreferencesRepository({
    storageArea: new FakeStorageArea()
  });

  const preferences = await repository.update({
    debugLogging: true,
    exportFormats: { document: "pdf" }
  });

  assert.equal(preferences.debugLogging, true);
  assert.deepEqual(preferences.exportFormats, {
    document: "pdf",
    spreadsheet: "xlsx",
    presentation: "pptx",
    drawing: "pdf"
  });
});

test("removes the development OAuth setting from stored preferences", async () => {
  const storageArea = new FakeStorageArea({
    [PROVIDER_PREFERENCES_KEY]: {
      version: 1,
      oauthClientId: "legacy.apps.googleusercontent.com",
      debugLogging: true,
      exportFormats: {
        document: "pdf",
        spreadsheet: "xlsx",
        presentation: "pptx",
        drawing: "pdf"
      }
    }
  });
  const repository = new ProviderPreferencesRepository({ storageArea });

  const preferences = await repository.initialize();

  assert.equal(preferences.version, PROVIDER_PREFERENCES_VERSION);
  assert.equal(Object.hasOwn(preferences, "oauthClientId"), false);
  assert.deepEqual(
    storageArea.snapshot()[PROVIDER_PREFERENCES_KEY],
    preferences
  );
});

test("rejects export values that Drive cannot produce for the file type", async () => {
  const repository = new ProviderPreferencesRepository({
    storageArea: new FakeStorageArea()
  });

  await assert.rejects(
    repository.update({ exportFormats: { drawing: "docx" } }),
    /Unsupported drawing export format/
  );
});

test("loads saved choices after a repository restart", async () => {
  const storageArea = new FakeStorageArea();
  const first = new ProviderPreferencesRepository({ storageArea });
  await first.update({ exportFormats: { presentation: "pdf" } });

  const restarted = new ProviderPreferencesRepository({ storageArea });

  assert.equal((await restarted.get()).exportFormats.presentation, "pdf");
});
