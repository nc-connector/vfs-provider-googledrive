/**
 * Provider preference repository tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROVIDER_PREFERENCES,
  PROVIDER_PREFERENCES_KEY,
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
    oauthClientId: "  client.apps.googleusercontent.com  ",
    debugLogging: true,
    exportFormats: { document: "pdf" }
  });

  assert.equal(preferences.oauthClientId, "client.apps.googleusercontent.com");
  assert.equal(preferences.debugLogging, true);
  assert.deepEqual(preferences.exportFormats, {
    document: "pdf",
    spreadsheet: "xlsx",
    presentation: "pptx",
    drawing: "pdf"
  });
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
