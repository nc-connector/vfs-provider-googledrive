/**
 * Google OAuth client tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  GoogleOAuthClient,
  GoogleOAuthError,
  OAUTH_REQUEST_TIMEOUT_MS,
  createGoogleRedirectUri,
  createPkceValues
} from "../src/google/oauth-client.mjs";
import { OAuthSessionRepository } from "../src/google/oauth-session.mjs";
import { ProviderPreferencesRepository } from "../src/state/provider-preferences.mjs";
import { ProviderStateRepository } from "../src/state/provider-state.mjs";
import { FakeStorageArea } from "./helpers/fake-storage.mjs";

const CLIENT_ID = "123456.apps.googleusercontent.com";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function createHarness({ fetchApi, requestTimeoutMs } = {}) {
  const localArea = new FakeStorageArea();
  const sessionArea = new FakeStorageArea();
  const accountRepository = new ProviderStateRepository({
    storageArea: localArea,
    now: () => 1_000,
    randomUUID: () => "account-1"
  });
  const preferencesRepository = new ProviderPreferencesRepository({
    storageArea: localArea
  });
  const sessionRepository = new OAuthSessionRepository({
    storageArea: sessionArea,
    now: () => 1_000
  });
  const identityApi = {
    getRedirectURL: () => "https://extensionhash.extensions.allizom.org/",
    launchWebAuthFlow: async ({ url }) => {
      const authorization = new URL(url);
      const redirectUri = authorization.searchParams.get("redirect_uri");
      const state = authorization.searchParams.get("state");
      return `${redirectUri}?code=authorization-code&state=${state}`;
    }
  };
  const logger = {
    debug() {},
    info() {},
    warn() {}
  };
  const client = new GoogleOAuthClient({
    identityApi,
    sessionRepository,
    accountRepository,
    preferencesRepository,
    fetchApi,
    logger,
    now: () => 1_000,
    requestTimeoutMs
  });
  return {
    accountRepository,
    client,
    identityApi,
    localArea,
    preferencesRepository,
    sessionArea,
    sessionRepository
  };
}

function rejectWhenAborted(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true
    });
  });
}

test("uses the documented Google account request deadline", () => {
  assert.equal(OAUTH_REQUEST_TIMEOUT_MS, 30 * 1000);
});

test("builds the Google-compatible Mozilla loopback redirect", async () => {
  const redirectUri = await createGoogleRedirectUri({
    getRedirectURL: async () => "https://stablehash.extensions.allizom.org/callback"
  });

  assert.equal(redirectUri, "http://127.0.0.1/mozoauth2/stablehash");
});

test("creates PKCE values with the required URL-safe shape", async () => {
  const values = await createPkceValues();

  assert.match(values.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(values.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(values.state, /^[A-Za-z0-9_-]{43}$/);
});

test("authorizes a Drive account without sending a client secret", async () => {
  const requests = [];
  const harness = createHarness({
    fetchApi: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
        return jsonResponse({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          expires_in: 3600
        });
      }
      return jsonResponse({
        user: {
          permissionId: "google-user-1",
          displayName: "Ada Example",
          emailAddress: "ada@example.invalid"
        }
      });
    }
  });
  await harness.preferencesRepository.update({ oauthClientId: CLIENT_ID });

  const account = await harness.client.authorize();

  assert.equal(account.id, "account-1");
  assert.equal(account.emailAddress, "ada@example.invalid");
  const tokenBody = new URLSearchParams(requests[0].options.body);
  assert.equal(tokenBody.get("client_id"), CLIENT_ID);
  assert.equal(tokenBody.get("client_secret"), null);
  assert.equal(tokenBody.get("grant_type"), "authorization_code");
  assert.equal(
    await harness.sessionRepository.getAccessToken("account-1"),
    "access-secret"
  );
  assert.deepEqual(
    harness.sessionArea.snapshot()["google-drive-oauth-session"].transactions,
    {}
  );
});

test("rejects a mismatched state and clears the PKCE transaction", async () => {
  const harness = createHarness({
    fetchApi: async () => {
      throw new Error("Token exchange must not start");
    }
  });
  await harness.preferencesRepository.update({ oauthClientId: CLIENT_ID });
  harness.identityApi.launchWebAuthFlow = async ({ url }) => {
    const authorization = new URL(url);
    return `${authorization.searchParams.get("redirect_uri")}?code=x&state=wrong`;
  };

  await assert.rejects(
    harness.client.authorize(),
    (error) => error instanceof GoogleOAuthError &&
      error.code === "oauth_state_mismatch"
  );
  assert.deepEqual(
    harness.sessionArea.snapshot()["google-drive-oauth-session"].transactions,
    {}
  );
});

test("times out token exchange and clears the PKCE transaction", async () => {
  const harness = createHarness({
    requestTimeoutMs: 5,
    fetchApi: async (_url, { signal }) => rejectWhenAborted(signal)
  });
  await harness.preferencesRepository.update({ oauthClientId: CLIENT_ID });

  await assert.rejects(
    harness.client.authorize(),
    (error) => error instanceof GoogleOAuthError &&
      error.code === "oauth_request_timeout"
  );
  assert.deepEqual(
    harness.sessionArea.snapshot()["google-drive-oauth-session"].transactions,
    {}
  );
});

test("keeps an identity API failure distinct from an authorization denial", async () => {
  const harness = createHarness();
  await harness.preferencesRepository.update({ oauthClientId: CLIENT_ID });
  harness.identityApi.launchWebAuthFlow = async () => {
    throw new Error("identity API failed");
  };

  await assert.rejects(
    harness.client.authorize(),
    (error) => error instanceof GoogleOAuthError &&
      error.code === "oauth_flow_failed"
  );
  assert.deepEqual(
    harness.sessionArea.snapshot()["google-drive-oauth-session"].transactions,
    {}
  );
});

test("keeps reauthorization on the selected Google account", async () => {
  const requests = [];
  const harness = createHarness({
    fetchApi: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).includes("/token")) {
        return jsonResponse({
          access_token: "other-access",
          refresh_token: "other-refresh",
          expires_in: 3600
        });
      }
      if (String(url).includes("/about")) {
        return jsonResponse({
          user: {
            permissionId: "other-google-user",
            displayName: "Other user",
            emailAddress: "other@example.invalid"
          }
        });
      }
      return new Response(null, { status: 200 });
    }
  });
  await harness.preferencesRepository.update({
    oauthClientId: "new-client.apps.googleusercontent.com"
  });
  const account = await harness.accountRepository.upsertAccount({
    googleUserId: "google-user-1",
    displayName: "Ada Example",
    emailAddress: "ada@example.invalid",
    oauthClientId: CLIENT_ID,
    refreshToken: "refresh-secret"
  });
  let authorizationUrl;
  const launch = harness.identityApi.launchWebAuthFlow;
  harness.identityApi.launchWebAuthFlow = async (options) => {
    authorizationUrl = new URL(options.url);
    return launch(options);
  };

  await assert.rejects(
    harness.client.authorize({ accountId: account.id }),
    (error) => error instanceof GoogleOAuthError &&
      error.code === "oauth_account_mismatch"
  );

  assert.equal(authorizationUrl.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(
    authorizationUrl.searchParams.get("login_hint"),
    "ada@example.invalid"
  );
  assert.equal(requests.at(-1).url, "https://oauth2.googleapis.com/revoke");
  assert.deepEqual(
    (await harness.accountRepository.listAccounts()).map(({ googleUserId }) => googleUserId),
    ["google-user-1"]
  );
});

test("refreshes one token for concurrent callers", async () => {
  let refreshRequests = 0;
  const harness = createHarness({
    fetchApi: async () => {
      refreshRequests++;
      return jsonResponse({ access_token: "new-access", expires_in: 3600 });
    }
  });
  await harness.preferencesRepository.update({ oauthClientId: CLIENT_ID });
  await harness.accountRepository.upsertAccount({
    googleUserId: "google-user-1",
    oauthClientId: CLIENT_ID,
    refreshToken: "refresh-secret"
  });

  const tokens = await Promise.all([
    harness.client.getAccessToken("account-1"),
    harness.client.getAccessToken("account-1")
  ]);

  assert.deepEqual(tokens, ["new-access", "new-access"]);
  assert.equal(refreshRequests, 1);
});

test("refreshes an account with the OAuth client that created its grant", async () => {
  let requestBody;
  const harness = createHarness({
    fetchApi: async (_url, options) => {
      requestBody = new URLSearchParams(options.body);
      return jsonResponse({ access_token: "new-access", expires_in: 3600 });
    }
  });
  await harness.preferencesRepository.update({
    oauthClientId: "new-client.apps.googleusercontent.com"
  });
  await harness.accountRepository.upsertAccount({
    googleUserId: "google-user-1",
    oauthClientId: CLIENT_ID,
    refreshToken: "refresh-secret"
  });

  await harness.client.getAccessToken("account-1");

  assert.equal(requestBody.get("client_id"), CLIENT_ID);
});

test("marks an account for reauthorization after invalid_grant", async () => {
  const harness = createHarness({
    fetchApi: async () => jsonResponse({ error: "invalid_grant" }, 400)
  });
  await harness.preferencesRepository.update({ oauthClientId: CLIENT_ID });
  await harness.accountRepository.upsertAccount({
    googleUserId: "google-user-1",
    oauthClientId: CLIENT_ID,
    refreshToken: "expired-refresh"
  });

  await assert.rejects(
    harness.client.getAccessToken("account-1"),
    (error) => error.code === "oauth_reauthorization_required"
  );
  assert.equal(
    (await harness.accountRepository.getAccount("account-1")).status,
    "reauthorization_required"
  );
});

test("keeps an account connected after a token refresh timeout", async () => {
  const harness = createHarness({
    requestTimeoutMs: 5,
    fetchApi: async (_url, { signal }) => rejectWhenAborted(signal)
  });
  await harness.preferencesRepository.update({ oauthClientId: CLIENT_ID });
  await harness.accountRepository.upsertAccount({
    googleUserId: "google-user-1",
    oauthClientId: CLIENT_ID,
    refreshToken: "refresh-secret"
  });

  await assert.rejects(
    harness.client.getAccessToken("account-1"),
    (error) => error instanceof GoogleOAuthError &&
      error.code === "oauth_request_timeout"
  );
  assert.equal(
    (await harness.accountRepository.getAccount("account-1")).status,
    "connected"
  );
});

test("removes local credentials even when Google revocation fails", async () => {
  const harness = createHarness({
    fetchApi: async () => jsonResponse({}, 503)
  });
  await harness.accountRepository.upsertAccount({
    googleUserId: "google-user-1",
    oauthClientId: CLIENT_ID,
    refreshToken: "refresh-secret"
  });
  await harness.sessionRepository.setAccessToken(
    "account-1",
    "access-secret",
    3_601_000
  );

  const result = await harness.client.disconnectAccount("account-1");

  assert.equal(result.revoked, false);
  assert.deepEqual(await harness.accountRepository.listAccounts(), []);
  assert.equal(await harness.sessionRepository.getAccessToken("account-1"), null);
});
