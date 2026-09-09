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
import { ProviderStateRepository } from "../src/state/provider-state.mjs";
import { FakeStorageArea } from "./helpers/fake-storage.mjs";

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret";
const LEGACY_CLIENT_ID = "legacy-client.apps.googleusercontent.com";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function createHarness({
  fetchApi,
  requestTimeoutMs,
  useSourceCredentials = false,
  logger = {
    debug() {},
    info() {},
    warn() {}
  }
} = {}) {
  const localArea = new FakeStorageArea();
  const sessionArea = new FakeStorageArea();
  const accountRepository = new ProviderStateRepository({
    storageArea: localArea,
    now: () => 1_000,
    randomUUID: () => "account-1"
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
  const clientOptions = {
    identityApi,
    sessionRepository,
    accountRepository,
    fetchApi,
    logger,
    now: () => 1_000,
    requestTimeoutMs
  };
  if (!useSourceCredentials) {
    clientOptions.clientId = CLIENT_ID;
    clientOptions.clientSecret = CLIENT_SECRET;
  }
  const client = new GoogleOAuthClient(clientOptions);
  return {
    accountRepository,
    client,
    identityApi,
    localArea,
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

test("fails closed before OAuth when build credentials are not injected", async () => {
  const harness = createHarness({ useSourceCredentials: true });
  await assert.rejects(
    harness.client.authorize(),
    (error) => error instanceof GoogleOAuthError &&
      error.code === "oauth_not_configured"
  );
});

test("calls the native fetch function through its global receiver", async () => {
  const originalFetch = globalThis.fetch;
  const receivers = [];
  globalThis.fetch = function (url) {
    receivers.push(this);
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      return Promise.resolve(jsonResponse({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        expires_in: 3600
      }));
    }
    return Promise.resolve(jsonResponse({
      user: {
        permissionId: "google-user-1",
        displayName: "Ada Example",
        emailAddress: "ada@example.invalid"
      }
    }));
  };

  try {
    const harness = createHarness();
    await harness.client.authorize();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(receivers, [globalThis, globalThis]);
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

test("authorizes a Drive account with the packaged client credentials and PKCE", async () => {
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
  const account = await harness.client.authorize();

  assert.equal(account.id, "account-1");
  assert.equal(account.emailAddress, "ada@example.invalid");
  const tokenBody = new URLSearchParams(requests[0].options.body);
  assert.equal(tokenBody.get("client_id"), CLIENT_ID);
  assert.equal(tokenBody.get("client_secret"), CLIENT_SECRET);
  assert.equal(tokenBody.get("grant_type"), "authorization_code");
  assert.equal(tokenBody.has("code_verifier"), true);
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

test("rejects an empty identity callback as an invalid redirect", async () => {
  const harness = createHarness();
  harness.identityApi.launchWebAuthFlow = async () => undefined;

  await assert.rejects(
    harness.client.authorize(),
    (error) => error instanceof GoogleOAuthError &&
      error.code === "oauth_redirect_invalid"
  );
  assert.deepEqual(
    harness.sessionArea.snapshot()["google-drive-oauth-session"].transactions,
    {}
  );
});

test("reports the safe authorization phase for unexpected token errors", async () => {
  const warnings = [];
  const sourceError = new TypeError("network failure");
  const harness = createHarness({
    fetchApi: async () => {
      throw sourceError;
    },
    logger: {
      debug() {},
      info() {},
      warn(event, details) {
        warnings.push({ event, details });
      }
    }
  });

  await assert.rejects(
    harness.client.authorize(),
    (error) => error instanceof GoogleOAuthError &&
      error.code === "oauth_token_exchange_failed" &&
      error.cause === sourceError
  );
  const requestWarning = warnings.find(({ event }) =>
    event === "oauth.request.failed");
  assert.equal(requestWarning.details.phase, "fetch");
  assert.equal(requestWarning.details.error, sourceError);
  const authorizationWarning = warnings.find(({ event }) =>
    event === "oauth.authorization.failed");
  assert.equal(authorizationWarning.details.phase, "token_exchange");
  assert.equal(authorizationWarning.details.error, sourceError);
});

test("preserves a rejected Google token response without logging its description", async () => {
  const warnings = [];
  const harness = createHarness({
    fetchApi: async () => jsonResponse({
      error: "invalid_request",
      error_description: "credential details must remain private"
    }, 400),
    logger: {
      debug() {},
      info() {},
      warn(event, details) {
        warnings.push({ event, details });
      }
    }
  });

  await assert.rejects(
    harness.client.authorize(),
    (error) => error instanceof GoogleOAuthError &&
      error.code === "oauth_token_request_failed" &&
      error.status === 400
  );
  const rejection = warnings.find(({ event }) =>
    event === "oauth.token.exchange.rejected");
  assert.deepEqual(rejection.details, {
    errorCode: "invalid_request",
    httpStatus: 400
  });
  assert.equal(JSON.stringify(warnings).includes("credential details"), false);
});

test("reauthorizes the selected account with the packaged OAuth client", async () => {
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
  const account = await harness.accountRepository.upsertAccount({
    googleUserId: "google-user-1",
    displayName: "Ada Example",
    emailAddress: "ada@example.invalid",
    oauthClientId: LEGACY_CLIENT_ID,
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
  let requestBody;
  const harness = createHarness({
    fetchApi: async (_url, options) => {
      refreshRequests++;
      requestBody = new URLSearchParams(options.body);
      return jsonResponse({ access_token: "new-access", expires_in: 3600 });
    }
  });
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
  assert.equal(requestBody.get("client_id"), CLIENT_ID);
  assert.equal(requestBody.get("client_secret"), CLIENT_SECRET);
});

test("requires reauthorization for a grant from another OAuth client", async () => {
  let refreshRequests = 0;
  const harness = createHarness({
    fetchApi: async () => {
      refreshRequests++;
      return jsonResponse({ access_token: "new-access", expires_in: 3600 });
    }
  });
  await harness.accountRepository.upsertAccount({
    googleUserId: "google-user-1",
    oauthClientId: LEGACY_CLIENT_ID,
    refreshToken: "refresh-secret"
  });

  await assert.rejects(
    harness.client.getAccessToken("account-1"),
    (error) => error instanceof GoogleOAuthError &&
      error.code === "oauth_reauthorization_required" &&
      error.status === 401
  );

  assert.equal(refreshRequests, 0);
  assert.equal(
    (await harness.accountRepository.getAccount("account-1")).status,
    "reauthorization_required"
  );
});

test("marks an account for reauthorization after invalid_grant", async () => {
  const harness = createHarness({
    fetchApi: async () => jsonResponse({ error: "invalid_grant" }, 400)
  });
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
