/**
 * OAuth configuration and enterprise-policy tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  OAUTH_CONFIGURATION_KEY,
  OAUTH_CONFIGURATION_VERSION,
  OAuthConfigurationError,
  OAuthConfigurationRepository
} from "../src/state/oauth-configuration.mjs";
import { FakeStorageArea } from "./helpers/fake-storage.mjs";

const BUILTIN_CLIENT_ID = "builtin.apps.googleusercontent.com";
const BUILTIN_CLIENT_SECRET = "builtin-secret";
const CUSTOM_CLIENT_ID = "custom.apps.googleusercontent.com";
const CUSTOM_CLIENT_SECRET = "custom-secret";

function createRepository({
  localArea = new FakeStorageArea(),
  managedArea = new FakeStorageArea(),
  builtInClientId = BUILTIN_CLIENT_ID,
  builtInClientSecret = BUILTIN_CLIENT_SECRET
} = {}) {
  return {
    localArea,
    managedArea,
    repository: new OAuthConfigurationRepository({
      localStorageArea: localArea,
      managedStorageArea: managedArea,
      builtInClientId,
      builtInClientSecret
    })
  };
}

function hasCode(code) {
  return (error) => error instanceof OAuthConfigurationError &&
    error.code === code;
}

test("uses and persists the built-in OAuth client by default", async () => {
  const { localArea, repository } = createRepository();

  assert.deepEqual(await repository.initialize(), {
    mode: "builtin",
    source: "local",
    locked: false,
    clientId: BUILTIN_CLIENT_ID,
    hasClientSecret: true,
    customClientId: "",
    hasCustomClientSecret: false
  });
  assert.deepEqual(localArea.snapshot()[OAUTH_CONFIGURATION_KEY], {
    version: OAUTH_CONFIGURATION_VERSION,
    mode: "builtin",
    customClientId: "",
    customClientSecret: ""
  });
  assert.deepEqual(repository.getEffective(), {
    mode: "builtin",
    source: "local",
    locked: false,
    clientId: BUILTIN_CLIENT_ID,
    clientSecret: BUILTIN_CLIENT_SECRET
  });
});

test("stores a local custom client without returning its secret", async () => {
  const { localArea, repository } = createRepository();
  await repository.initialize();

  const publicConfiguration = await repository.updateLocal({
    mode: "custom",
    clientId: CUSTOM_CLIENT_ID,
    clientSecret: CUSTOM_CLIENT_SECRET
  });

  assert.deepEqual(publicConfiguration, {
    mode: "custom",
    source: "local",
    locked: false,
    clientId: CUSTOM_CLIENT_ID,
    hasClientSecret: true,
    customClientId: CUSTOM_CLIENT_ID,
    hasCustomClientSecret: true
  });
  assert.equal(
    JSON.stringify(publicConfiguration).includes(CUSTOM_CLIENT_SECRET),
    false
  );
  assert.equal(
    localArea.snapshot()[OAUTH_CONFIGURATION_KEY].customClientSecret,
    CUSTOM_CLIENT_SECRET
  );
});

test("restores a local custom client after repository reconstruction", async () => {
  const localArea = new FakeStorageArea();
  const first = createRepository({ localArea }).repository;
  await first.initialize();
  await first.updateLocal({
    mode: "custom",
    clientId: CUSTOM_CLIENT_ID,
    clientSecret: CUSTOM_CLIENT_SECRET
  });

  const restarted = createRepository({ localArea }).repository;
  await restarted.initialize();

  assert.deepEqual(restarted.getEffective(), {
    mode: "custom",
    source: "local",
    locked: false,
    clientId: CUSTOM_CLIENT_ID,
    clientSecret: CUSTOM_CLIENT_SECRET
  });
});

test("blank secret retains only the matching stored custom client", async () => {
  const { localArea, repository } = createRepository();
  await repository.initialize();
  await repository.updateLocal({
    mode: "custom",
    clientId: CUSTOM_CLIENT_ID,
    clientSecret: CUSTOM_CLIENT_SECRET
  });

  await repository.updateLocal({
    mode: "builtin"
  });
  await repository.updateLocal({
    mode: "custom",
    clientId: CUSTOM_CLIENT_ID,
    clientSecret: ""
  });

  assert.equal(
    localArea.snapshot()[OAUTH_CONFIGURATION_KEY].customClientSecret,
    CUSTOM_CLIENT_SECRET
  );
  await assert.rejects(repository.updateLocal({
    mode: "custom",
    clientId: "different.apps.googleusercontent.com",
    clientSecret: ""
  }), hasCode("oauth_client_secret_required"));
  assert.equal(repository.getEffective().clientId, CUSTOM_CLIENT_ID);
});

test("serializes blank-secret updates behind the credential write", async () => {
  const { repository } = createRepository();
  await repository.initialize();

  const first = repository.updateLocal({
    mode: "custom",
    clientId: CUSTOM_CLIENT_ID,
    clientSecret: CUSTOM_CLIENT_SECRET
  });
  const second = repository.updateLocal({
    mode: "custom",
    clientId: CUSTOM_CLIENT_ID,
    clientSecret: ""
  });

  await Promise.all([first, second]);
  assert.equal(repository.getEffective().clientSecret, CUSTOM_CLIENT_SECRET);
});

test("a managed custom client is authoritative and locally immutable", async () => {
  const managedArea = new FakeStorageArea({
    OAuthMode: "custom",
    OAuthClientId: CUSTOM_CLIENT_ID,
    OAuthClientSecret: CUSTOM_CLIENT_SECRET
  });
  const { localArea, repository } = createRepository({ managedArea });

  const publicConfiguration = await repository.initialize();

  assert.equal(publicConfiguration.mode, "custom");
  assert.equal(publicConfiguration.source, "managed");
  assert.equal(publicConfiguration.locked, true);
  assert.equal(publicConfiguration.clientId, CUSTOM_CLIENT_ID);
  assert.equal(JSON.stringify(publicConfiguration).includes(CUSTOM_CLIENT_SECRET), false);
  assert.deepEqual(localArea.snapshot(), {});
  await assert.rejects(repository.updateLocal({
    mode: "builtin"
  }), hasCode("oauth_configuration_managed"));
});

test("a managed custom client does not require usable built-in markers", async () => {
  const { repository } = createRepository({
    managedArea: new FakeStorageArea({
      OAuthMode: "custom",
      OAuthClientId: CUSTOM_CLIENT_ID,
      OAuthClientSecret: CUSTOM_CLIENT_SECRET
    }),
    builtInClientId: "__GDRVFS_OAUTH_CLIENT_ID__",
    builtInClientSecret: "__GDRVFS_OAUTH_CLIENT_SECRET__"
  });

  await repository.initialize();
  assert.equal(repository.getEffective().clientId, CUSTOM_CLIENT_ID);
});

test("a managed built-in mode ignores stray managed custom fields", async () => {
  const { repository } = createRepository({
    managedArea: new FakeStorageArea({
      OAuthMode: "builtin",
      OAuthClientId: "invalid",
      OAuthClientSecret: "ignored"
    })
  });

  const result = await repository.initialize();

  assert.equal(result.mode, "builtin");
  assert.equal(result.source, "managed");
  assert.equal(result.locked, true);
  assert.equal(result.clientId, BUILTIN_CLIENT_ID);
});

test("partial or malformed managed configuration fails closed", async () => {
  for (const values of [
    { OAuthmode: "builtin" },
    { OAuthClientId: CUSTOM_CLIENT_ID },
    { OAuthMode: "custom", OAuthClientId: CUSTOM_CLIENT_ID },
    {
      OAuthMode: "custom",
      OAuthClientId: CUSTOM_CLIENT_ID,
      OAuthClientSecret: "bad\u0007secret"
    },
    { OAuthMode: "unsupported" }
  ]) {
    const { repository } = createRepository({
      managedArea: new FakeStorageArea(values)
    });
    await assert.rejects(
      repository.initialize(),
      hasCode("oauth_managed_policy_invalid")
    );
  }
});

test("only the exact missing-manifest error means no managed policy", async () => {
  const missing = {
    async get() {
      throw new Error("Managed storage manifest not found.");
    }
  };
  const { repository } = createRepository({ managedArea: missing });
  assert.equal((await repository.initialize()).mode, "builtin");

  const unreadable = {
    async get() {
      throw new Error("Managed storage manifest not found while access failed");
    }
  };
  const second = createRepository({ managedArea: unreadable }).repository;
  await assert.rejects(
    second.initialize(),
    hasCode("oauth_managed_policy_read_failed")
  );
});

test("invalid stored local configuration fails closed without replacement", async () => {
  const localArea = new FakeStorageArea({
    [OAUTH_CONFIGURATION_KEY]: {
      version: OAUTH_CONFIGURATION_VERSION,
      mode: "custom",
      customClientId: CUSTOM_CLIENT_ID,
      customClientSecret: ""
    }
  });
  const { repository } = createRepository({ localArea });

  await assert.rejects(
    repository.initialize(),
    hasCode("oauth_client_secret_required")
  );
  assert.equal(
    localArea.snapshot()[OAUTH_CONFIGURATION_KEY].customClientSecret,
    ""
  );
});

test("an unknown local configuration version is rejected without replacement", async () => {
  const localArea = new FakeStorageArea({
    [OAUTH_CONFIGURATION_KEY]: {
      version: 999,
      mode: "builtin",
      customClientId: "",
      customClientSecret: ""
    }
  });
  const { repository } = createRepository({ localArea });

  await assert.rejects(
    repository.initialize(),
    hasCode("oauth_configuration_invalid")
  );
  assert.equal(
    localArea.snapshot()[OAUTH_CONFIGURATION_KEY].version,
    999
  );
});

test("account compatibility follows client ID but not secret rotation", async () => {
  const { repository } = createRepository();
  await repository.initialize();
  const account = {
    status: "connected",
    oauthClientId: BUILTIN_CLIENT_ID
  };
  assert.equal(repository.accountStatus(account), "connected");

  await repository.updateLocal({
    mode: "custom",
    clientId: BUILTIN_CLIENT_ID,
    clientSecret: "rotated-secret"
  });
  assert.equal(repository.accountStatus(account), "connected");

  await repository.updateLocal({
    mode: "custom",
    clientId: CUSTOM_CLIENT_ID,
    clientSecret: CUSTOM_CLIENT_SECRET
  });
  assert.equal(repository.accountStatus(account), "reauthorization_required");
});
