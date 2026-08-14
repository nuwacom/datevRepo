// lib/datevAuth.ts
// DATEV OAuth token lifecycle: Redis-persisted token store, PKCE state store,
// and getAccessToken() with automatic refresh guarded by a small Redis lock.
//
// SERVERLESS NOTE (Vercel):
// Unlike the UiPath edition, DATEV's business APIs only support the OAuth 2.0
// Authorization Code + PKCE flow — a human grants consent once in a browser and
// this server must then keep the token pair alive. A module-level cache alone is
// NOT enough: refresh tokens must survive cold starts, so Upstash Redis is the
// source of truth and the in-memory cache is only a warm-invocation shortcut.
//
// DATEV token lifetimes (observed): access tokens ~15 min (expires_in=900),
// refresh tokens ~11 h (non-standard refresh_token_expires_in field). That means
// a human must repeat the /api/datev/connect browser step roughly daily.
// Refresh-token rotation is unconfirmed — we always persist a newly returned
// refresh_token and treat the old one as dead.

import { randomBytes } from "crypto";
import { safeRedis } from "@/lib/redis";
import { oauthConfig, optional, tokenUrl } from "@/lib/datevEnv";

// ---- Redis keys & timing ----

const TOKENS_KEY = "datev:tokens";
const PKCE_PREFIX = "datev:pkce:"; // + state
const LOCK_KEY = "datev:refresh:lock";

export const SKEW_MS = 60_000; // refresh this long before actual expiry
const PKCE_TTL_S = 600; // connect → callback must complete within 10 min
const LOCK_TTL_MS = 10_000;
const LOCK_WAIT_BUDGET_MS = 10_000;
const LOCK_POLL_MS = 800;
const TOKEN_FETCH_TIMEOUT_MS = 8_000; // must finish inside the lock TTL

// How the client authenticates at the token endpoint. DATEV's discovery document
// does not state it; the OIDC default and integrator evidence say HTTP Basic.
// Flip to "post" (client_secret in the form body) if DATEV rejects Basic.
const CLIENT_AUTH_STYLE: "basic" | "post" = "basic";

// ---- types ----

export interface TokenRecord {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scopes: string;
  expiresAt: number; // epoch ms
  refreshTokenExpiresAt: number | null; // epoch ms; null = not reported by DATEV
  obtainedAt: number; // epoch ms of the token response that produced this record
}

export interface PkceRecord {
  codeVerifier: string;
  nonce: string;
  createdAt: number;
}

// ---- warm cache (per lambda instance; strictly subordinate to Redis) ----

let warm: TokenRecord | null = null;

function accessValid(rec: TokenRecord, now: number): boolean {
  return rec.expiresAt - now > SKEW_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function notConnectedError(): Error {
  return new Error(
    "DATEV not connected – open /api/datev/connect in a browser to grant access."
  );
}

// ---- token store ----

export async function readTokens(): Promise<TokenRecord | null> {
  return await safeRedis((r) => r.get<TokenRecord>(TOKENS_KEY));
}

// Maps a DATEV token-endpoint response to a TokenRecord and persists it.
// `prev` carries forward the refresh token/expiry when the response omits them.
export async function storeTokensFromResponse(
  json: any,
  prev?: TokenRecord | null
): Promise<TokenRecord> {
  if (!json?.access_token) {
    throw new Error("DATEV token response contained no access_token.");
  }
  const refreshToken: string | undefined = json.refresh_token ?? prev?.refreshToken;
  if (!refreshToken) {
    throw new Error(
      "DATEV token response contained no refresh_token — check that DATEV_SCOPES matches the scopes granted to your app."
    );
  }
  const now = Date.now();
  let refreshTokenExpiresAt: number | null;
  if (json.refresh_token_expires_in) {
    refreshTokenExpiresAt = now + Number(json.refresh_token_expires_in) * 1000;
  } else if (json.refresh_token) {
    refreshTokenExpiresAt = null; // new refresh token, lifetime not reported
  } else {
    refreshTokenExpiresAt = prev?.refreshTokenExpiresAt ?? null;
  }
  const rec: TokenRecord = {
    accessToken: json.access_token,
    refreshToken,
    tokenType: json.token_type || "Bearer",
    scopes:
      (typeof json.scope === "string" && json.scope) ||
      prev?.scopes ||
      optional("DATEV_SCOPES"),
    expiresAt: now + (Number(json.expires_in) || 900) * 1000,
    refreshTokenExpiresAt,
    obtainedAt: now,
  };
  await safeRedis((r) => r.set(TOKENS_KEY, rec));
  warm = rec;
  return rec;
}

// ---- PKCE state store (one record per in-flight browser login) ----

export async function savePkce(state: string, rec: PkceRecord): Promise<void> {
  await safeRedis((r) => r.set(`${PKCE_PREFIX}${state}`, rec, { ex: PKCE_TTL_S }));
}

// One-shot: atomically read and delete, so an authorization code can never be
// replayed against this server.
export async function consumePkce(state: string): Promise<PkceRecord | null> {
  return await safeRedis((r) => r.getdel<PkceRecord>(`${PKCE_PREFIX}${state}`));
}

// ---- token endpoint ----

// Shared by the authorization_code exchange (callback route) and the
// refresh_token grant below.
export async function exchangeToken(params: Record<string, string>): Promise<any> {
  const { clientId, clientSecret } = oauthConfig();
  const body = new URLSearchParams({ ...params, client_id: clientId });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (CLIENT_AUTH_STYLE === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_secret", clientSecret);
  }
  const res = await fetch(tokenUrl(), {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(
      `DATEV token endpoint returned HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`
    );
  }
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`DATEV token endpoint returned non-JSON: ${text.slice(0, 300)}`);
  }
  return json;
}

// ---- getAccessToken ----

export async function getAccessToken(
  opts: { forceRefresh?: boolean; failedAccessToken?: string } = {}
): Promise<string> {
  const force = opts.forceRefresh === true;
  const failed = opts.failedAccessToken;

  // A stored record can serve the caller if its access token is valid and — when
  // a refresh was forced because a specific token got a 401 — it is not that same
  // rejected token. (Another instance, or a fresh /api/datev/connect, may already
  // have stored a newer token; refreshing again would pointlessly rotate it.)
  const usable = (rec: TokenRecord): boolean =>
    accessValid(rec, Date.now()) &&
    (!force || (failed !== undefined && rec.accessToken !== failed));

  if (warm && usable(warm)) {
    return warm.accessToken;
  }

  const rec = await readTokens();
  if (!rec) {
    warm = null;
    throw notConnectedError();
  }

  if (usable(rec)) {
    warm = rec;
    return rec.accessToken;
  }

  // Access token expired (or a refresh was forced). Is the refresh token viable?
  if (
    rec.refreshTokenExpiresAt !== null &&
    Date.now() > rec.refreshTokenExpiresAt - SKEW_MS
  ) {
    throw new Error(
      `DATEV refresh token expired at ${new Date(rec.refreshTokenExpiresAt).toISOString()}. ` +
        "DATEV refresh tokens live ~11 hours, so a human must re-consent roughly daily. " +
        "Reconnect at /api/datev/connect."
    );
  }

  return refreshWithLock(rec, usable);
}

// Serializes refresh across concurrent invocations. Whoever wins the lock
// refreshes; everyone else waits briefly and re-reads the refreshed record.
async function refreshWithLock(
  prev: TokenRecord,
  usable: (rec: TokenRecord) => boolean
): Promise<string> {
  const lockToken = randomBytes(16).toString("hex");
  const deadline = Date.now() + LOCK_WAIT_BUDGET_MS;

  for (;;) {
    const res = await safeRedis((r) =>
      r.set(LOCK_KEY, lockToken, { nx: true, px: LOCK_TTL_MS })
    );
    if (res === "OK") break;
    await sleep(LOCK_POLL_MS);
    const rec = await readTokens();
    if (rec && usable(rec)) {
      warm = rec;
      return rec.accessToken;
    }
    if (Date.now() > deadline) {
      throw new Error(
        "A DATEV token refresh is already in progress in another request and did not finish in time — retry the tool call in a few seconds."
      );
    }
  }

  try {
    // Double-check under the lock: the previous holder may have refreshed.
    const rec = await readTokens();
    if (rec && usable(rec)) {
      warm = rec;
      return rec.accessToken;
    }
    const source = rec ?? prev;
    let json: any;
    try {
      json = await exchangeToken({
        grant_type: "refresh_token",
        refresh_token: source.refreshToken,
      });
    } catch (err: any) {
      // Keep the stored record so get_connection_status can still explain the
      // state (when it was obtained, when it expired).
      throw new Error(
        `DATEV token refresh failed: ${err?.message ?? String(err)} — reconnect at /api/datev/connect.`
      );
    }
    const updated = await storeTokensFromResponse(json, source);
    return updated.accessToken;
  } finally {
    // Compare-and-delete so we never delete a successor's lock; a failed
    // release is harmless (the PX TTL self-heals).
    try {
      await safeRedis((r) =>
        r.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          [LOCK_KEY],
          [lockToken]
        )
      );
    } catch {
      // ignore — lock expires on its own
    }
  }
}
