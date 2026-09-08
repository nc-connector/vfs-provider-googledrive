/**
 * Google OAuth 2.0 Authorization Code flow with PKCE.
 */

"use strict";

import {
  RequestDeadline,
  RequestTimeoutError
} from "../core/request-deadline.mjs";

export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
export const GOOGLE_OAUTH_CLIENT_ID =
  "97829492793-hupuhndvki6esrb3hpgbuhgr5ci3mc6m.apps.googleusercontent.com";
const GOOGLE_OAUTH_CLIENT_SECRET =
  "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";
export const OAUTH_REQUEST_TIMEOUT_MS = 30 * 1000;

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const ABOUT_ENDPOINT = "https://www.googleapis.com/drive/v3/about";
const TRANSACTION_MAX_AGE_MS = 10 * 60 * 1000;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/;

function defaultFetch(input, init) {
  return globalThis.fetch(input, init);
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function requireClientId(value) {
  const clientId = typeof value === "string" ? value.trim() : "";
  if (!clientId) {
    throw new GoogleOAuthError("oauth_not_configured");
  }
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    throw new GoogleOAuthError("oauth_client_id_invalid");
  }
  return clientId;
}

function requireClientSecret(value) {
  const clientSecret = typeof value === "string" ? value.trim() : "";
  if (!clientSecret) {
    throw new GoogleOAuthError("oauth_not_configured");
  }
  return clientSecret;
}

async function readJson(response, signal) {
  try {
    return await response.json();
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : error;
    }
    return {};
  }
}

function requirePositiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(name);
  }
  return value;
}

function tokenExpiry(now, expiresIn) {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new GoogleOAuthError("oauth_token_response_invalid");
  }
  return now + seconds * 1000;
}

export class GoogleOAuthError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.name = "GoogleOAuthError";
    this.code = code;
    this.status = status;
  }
}

function authorizationFailure(error, phase) {
  if (error instanceof GoogleOAuthError) {
    return error;
  }
  const failure = new GoogleOAuthError(`oauth_${phase}_failed`);
  failure.cause = error;
  return failure;
}

export async function createGoogleRedirectUri(identityApi) {
  const generated = new URL(await identityApi.getRedirectURL());
  const extensionHash = generated.hostname.split(".")[0];
  if (!extensionHash) {
    throw new GoogleOAuthError("oauth_redirect_invalid");
  }
  return `http://127.0.0.1/mozoauth2/${extensionHash}`;
}

export async function createPkceValues(cryptoApi = crypto) {
  const verifierBytes = new Uint8Array(32);
  const stateBytes = new Uint8Array(32);
  cryptoApi.getRandomValues(verifierBytes);
  cryptoApi.getRandomValues(stateBytes);
  const codeVerifier = encodeBase64Url(verifierBytes);
  const digest = await cryptoApi.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier)
  );
  return {
    codeVerifier,
    codeChallenge: encodeBase64Url(new Uint8Array(digest)),
    state: encodeBase64Url(stateBytes)
  };
}

export class GoogleOAuthClient {
  #identityApi;
  #sessionRepository;
  #accountRepository;
  #fetch;
  #logger;
  #crypto;
  #now;
  #requestTimeoutMs;
  #refreshPromises = new Map();

  constructor({
    identityApi,
    sessionRepository,
    accountRepository,
    fetchApi = defaultFetch,
    logger,
    cryptoApi = crypto,
    now = () => Date.now(),
    requestTimeoutMs = OAUTH_REQUEST_TIMEOUT_MS
  }) {
    this.#identityApi = identityApi;
    this.#sessionRepository = sessionRepository;
    this.#accountRepository = accountRepository;
    this.#fetch = fetchApi;
    this.#logger = logger;
    this.#crypto = cryptoApi;
    this.#now = now;
    this.#requestTimeoutMs = requirePositiveNumber(
      requestTimeoutMs,
      "requestTimeoutMs"
    );
  }

  async authorize({ accountId, interactive = true } = {}) {
    const expectedAccount = accountId
      ? await this.#accountRepository.getAccount(accountId)
      : null;
    if (accountId && !expectedAccount) {
      throw new GoogleOAuthError("oauth_reauthorization_required", 401);
    }
    const normalizedClientId = requireClientId(GOOGLE_OAUTH_CLIENT_ID);
    const normalizedClientSecret = requireClientSecret(
      GOOGLE_OAUTH_CLIENT_SECRET
    );
    const redirectUri = await createGoogleRedirectUri(this.#identityApi);
    const pkce = await createPkceValues(this.#crypto);
    await this.#sessionRepository.removeExpiredTransactions(TRANSACTION_MAX_AGE_MS);
    await this.#sessionRepository.storeTransaction({
      state: pkce.state,
      codeVerifier: pkce.codeVerifier,
      clientId: normalizedClientId
    });

    const authorizationUrl = new URL(AUTHORIZATION_ENDPOINT);
    const authorizationParameters = new URLSearchParams({
      client_id: normalizedClientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_DRIVE_SCOPE,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "true",
      state: pkce.state
    });
    if (expectedAccount?.emailAddress) {
      authorizationParameters.set("login_hint", expectedAccount.emailAddress);
    }
    authorizationUrl.search = authorizationParameters.toString();

    this.#logger.info("oauth.authorization.start", { phase: "interactive" });
    let phase = "redirect_wait";
    try {
      let responseUrl;
      try {
        responseUrl = await this.#identityApi.launchWebAuthFlow({
          url: authorizationUrl.toString(),
          interactive
        });
      } catch {
        throw new GoogleOAuthError("oauth_flow_failed");
      }

      phase = "redirect_parse";
      if (typeof responseUrl !== "string" || !responseUrl.trim()) {
        throw new GoogleOAuthError("oauth_redirect_invalid");
      }
      let response;
      try {
        response = new URL(responseUrl);
      } catch {
        throw new GoogleOAuthError("oauth_redirect_invalid");
      }
      this.#logger.debug("oauth.authorization.redirect.received", { phase });
      const expected = new URL(redirectUri);
      if (response.origin !== expected.origin || response.pathname !== expected.pathname) {
        throw new GoogleOAuthError("oauth_redirect_mismatch");
      }
      const returnedState = response.searchParams.get("state");
      if (returnedState !== pkce.state) {
        throw new GoogleOAuthError("oauth_state_mismatch");
      }
      const transaction = await this.#sessionRepository.getTransaction(returnedState);
      if (!transaction || transaction.clientId !== normalizedClientId) {
        throw new GoogleOAuthError("oauth_state_mismatch");
      }
      if (response.searchParams.has("error")) {
        throw new GoogleOAuthError("oauth_denied");
      }
      const authorizationCode = response.searchParams.get("code");
      if (!authorizationCode) {
        throw new GoogleOAuthError("oauth_code_missing");
      }

      phase = "token_exchange";
      this.#logger.debug("oauth.authorization.token.start", { phase });
      const token = await this.#exchangeAuthorizationCode({
        authorizationCode,
        codeVerifier: transaction.codeVerifier,
        clientId: transaction.clientId,
        clientSecret: normalizedClientSecret,
        redirectUri
      });
      this.#logger.debug("oauth.authorization.token.complete", { phase });
      phase = "profile_request";
      this.#logger.debug("oauth.authorization.profile.start", { phase });
      const profile = await this.#loadDriveProfile(token.accessToken);
      this.#logger.debug("oauth.authorization.profile.complete", { phase });
      if (expectedAccount &&
          profile.permissionId !== expectedAccount.googleUserId) {
        try {
          await this.#revokeToken(token.refreshToken || token.accessToken);
        } catch {
          // The mismatched account is never stored locally.
        }
        throw new GoogleOAuthError("oauth_account_mismatch");
      }
      let account;
      phase = "account_store";
      try {
        account = await this.#accountRepository.upsertAccount({
          id: expectedAccount?.id,
          googleUserId: profile.permissionId,
          displayName: profile.displayName,
          emailAddress: profile.emailAddress,
          oauthClientId: normalizedClientId,
          refreshToken: token.refreshToken,
          status: "connected"
        });
      } catch (error) {
        if (error instanceof TypeError && !token.refreshToken) {
          throw new GoogleOAuthError("oauth_refresh_token_missing");
        }
        throw error;
      }
      phase = "access_token_cache";
      await this.#sessionRepository.setAccessToken(
        account.id,
        token.accessToken,
        token.expiresAt
      );
      this.#logger.info("oauth.authorization.complete", { status: "connected" });
      return account;
    } catch (error) {
      this.#logger.warn("oauth.authorization.failed", { error, phase });
      throw authorizationFailure(error, phase);
    } finally {
      try {
        await this.#sessionRepository.deleteTransaction(pkce.state);
      } catch (error) {
        this.#logger.warn("oauth.authorization.cleanup.failed", {
          error,
          phase: "cleanup"
        });
      }
    }
  }

  async getAccessToken(accountId, { forceRefresh = false } = {}) {
    const authorization = await this.#accountRepository.getAccountAuthorization(accountId);
    if (!authorization || authorization.status !== "connected") {
      throw new GoogleOAuthError("oauth_reauthorization_required", 401);
    }

    if (!forceRefresh) {
      const cached = await this.#sessionRepository.getAccessToken(accountId);
      if (cached) {
        return cached;
      }
    } else {
      await this.#sessionRepository.clearAccessToken(accountId);
    }

    if (!this.#refreshPromises.has(accountId)) {
      const refresh = this.#refreshAccessToken(accountId, authorization)
        .finally(() => this.#refreshPromises.delete(accountId));
      this.#refreshPromises.set(accountId, refresh);
    }
    return this.#refreshPromises.get(accountId);
  }

  async disconnectAccount(accountId) {
    const authorization = await this.#accountRepository.getAccountAuthorization(accountId);
    if (!authorization) {
      return null;
    }

    let revoked = false;
    try {
      revoked = await this.#revokeToken(authorization.refreshToken, true);
    } catch (error) {
      this.#logger.warn("oauth.revocation.failed", { error });
    } finally {
      await this.#sessionRepository.clearAccessToken(accountId);
    }

    const removed = await this.#accountRepository.removeAccount(accountId);
    this.#logger.info("oauth.account.disconnected", {
      status: revoked ? "revoked" : "removed_locally"
    });
    return {
      ...removed,
      revoked
    };
  }

  async #exchangeAuthorizationCode({
    authorizationCode,
    codeVerifier,
    clientId,
    clientSecret,
    redirectUri
  }) {
    const { response, payload } = await this.#request(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: authorizationCode,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri
      }).toString()
    }, { readBody: true });
    if (!response.ok || typeof payload?.access_token !== "string") {
      this.#logger.warn("oauth.token.exchange.rejected", {
        errorCode: typeof payload?.error === "string"
          ? payload.error
          : "unknown",
        httpStatus: response.status
      });
      throw new GoogleOAuthError("oauth_token_request_failed", response.status);
    }
    return {
      accessToken: payload.access_token,
      refreshToken: typeof payload.refresh_token === "string"
        ? payload.refresh_token
        : "",
      expiresAt: tokenExpiry(this.#now(), payload.expires_in)
    };
  }

  async #revokeToken(token, logFailure = false) {
    if (!token) {
      return false;
    }
    const { response } = await this.#request(REVOCATION_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ token }).toString()
    });
    if (!response.ok && logFailure) {
      this.#logger.warn("oauth.revocation.failed", { httpStatus: response.status });
    }
    return response.ok;
  }

  async #loadDriveProfile(accessToken) {
    const url = new URL(ABOUT_ENDPOINT);
    url.searchParams.set(
      "fields",
      "user(displayName,emailAddress,permissionId)"
    );
    const { response, payload } = await this.#request(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }, { readBody: true });
    if (!response.ok || !payload.user?.permissionId) {
      throw new GoogleOAuthError("oauth_profile_request_failed", response.status);
    }
    return {
      permissionId: payload.user.permissionId,
      displayName: payload.user.displayName || "",
      emailAddress: payload.user.emailAddress || ""
    };
  }

  async #refreshAccessToken(accountId, authorization) {
    const clientId = requireClientId(authorization.oauthClientId);
    if (clientId !== GOOGLE_OAUTH_CLIENT_ID) {
      await this.#accountRepository.setAccountStatus(
        accountId,
        "reauthorization_required"
      );
      await this.#sessionRepository.clearAccessToken(accountId);
      throw new GoogleOAuthError("oauth_reauthorization_required", 401);
    }
    const clientSecret = requireClientSecret(GOOGLE_OAUTH_CLIENT_SECRET);
    this.#logger.debug("oauth.token.refresh.start", { phase: "refresh" });
    const { response, payload } = await this.#request(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: authorization.refreshToken,
        grant_type: "refresh_token"
      }).toString()
    }, { readBody: true });
    if (!response.ok || typeof payload.access_token !== "string") {
      if (payload.error === "invalid_grant") {
        await this.#accountRepository.setAccountStatus(
          accountId,
          "reauthorization_required"
        );
        await this.#sessionRepository.clearAccessToken(accountId);
        throw new GoogleOAuthError("oauth_reauthorization_required", response.status);
      }
      throw new GoogleOAuthError("oauth_token_refresh_failed", response.status);
    }

    const expiresAt = tokenExpiry(this.#now(), payload.expires_in);
    if (typeof payload.refresh_token === "string" && payload.refresh_token) {
      const account = await this.#accountRepository.getAccount(accountId);
      if (!account) {
        throw new GoogleOAuthError("oauth_reauthorization_required", 401);
      }
      await this.#accountRepository.upsertAccount({
        ...account,
        oauthClientId: authorization.oauthClientId,
        refreshToken: payload.refresh_token,
        status: "connected"
      });
    }
    await this.#sessionRepository.setAccessToken(
      accountId,
      payload.access_token,
      expiresAt
    );
    this.#logger.debug("oauth.token.refresh.complete", { status: "connected" });
    return payload.access_token;
  }

  async #request(url, options, { readBody = false } = {}) {
    let deadline;
    let phase = "deadline";
    try {
      deadline = new RequestDeadline({
        timeoutMs: this.#requestTimeoutMs
      });
      phase = "fetch";
      const response = await this.#fetch(url, {
        ...options,
        signal: deadline.signal
      });
      phase = "response_body";
      const payload = readBody
        ? await readJson(response, deadline.signal)
        : null;
      deadline.throwIfTimedOut();
      return { response, payload };
    } catch (error) {
      const failure = deadline?.normalizeError(error) || error;
      this.#logger.warn("oauth.request.failed", { error: failure, phase });
      if (failure instanceof RequestTimeoutError) {
        throw new GoogleOAuthError("oauth_request_timeout");
      }
      throw failure;
    } finally {
      deadline?.stopTimeout();
    }
  }
}
