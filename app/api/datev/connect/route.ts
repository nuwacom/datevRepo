// app/api/datev/connect/route.ts
// Starts the DATEV OAuth 2.0 Authorization Code + PKCE flow. Open this route in
// a browser; it redirects to the DATEV login (SmartLogin/SmartCard consent).
// The PKCE verifier + state are parked in Redis for the callback to consume.

import { createHash, randomBytes } from "crypto";
import { authorizeUrl, oauthConfig, optional } from "@/lib/datevEnv";
import { savePkce } from "@/lib/datevAuth";
import { escapeHtml, htmlPage } from "@/lib/html";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    // Optional guard: if DATEV_CONNECT_KEY is set, require ?key=<value> so
    // strangers who find the URL can't re-bind the server to their own account.
    const guard = optional("DATEV_CONNECT_KEY");
    if (guard) {
      const key = new URL(req.url).searchParams.get("key") ?? "";
      if (key !== guard) {
        return htmlPage(
          "Not authorized",
          "<p>This connect link requires a key: open <code>/api/datev/connect?key=&lt;DATEV_CONNECT_KEY&gt;</code>.</p>",
          403
        );
      }
    }

    const { clientId, scopes, redirectUri } = oauthConfig();

    const codeVerifier = randomBytes(32).toString("base64url"); // 43 chars, RFC 7636
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const state = randomBytes(16).toString("hex");
    const nonce = randomBytes(16).toString("hex");

    await savePkce(state, { codeVerifier, nonce, createdAt: Date.now() });

    const url = new URL(authorizeUrl());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scopes); // verbatim from DATEV_SCOPES
    url.searchParams.set("state", state);
    // Nonce is sent and stored, but the id_token is not validated — this server
    // only needs the access/refresh token pair, not the OIDC identity claims.
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256"); // DATEV offers S256 only

    return Response.redirect(url.toString(), 302);
  } catch (err: any) {
    return htmlPage(
      "DATEV connect failed",
      `<p>${escapeHtml(err?.message ?? String(err))}</p>`,
      500
    );
  }
}
