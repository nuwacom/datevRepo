// app/api/datev/callback/route.ts
// Finishes the DATEV OAuth flow: validates the one-shot state, exchanges the
// authorization code (+ PKCE verifier) for tokens, and persists them in Redis.
// Renders a human-readable result page — token values are never displayed.

import { datevEnvName, oauthConfig } from "@/lib/datevEnv";
import { consumePkce, exchangeToken, storeTokensFromResponse } from "@/lib/datevAuth";
import { escapeHtml, htmlPage } from "@/lib/html";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  try {
    const oauthError = params.get("error");
    if (oauthError) {
      const desc = params.get("error_description");
      return htmlPage(
        "DATEV login failed",
        `<p>DATEV returned <code>${escapeHtml(oauthError)}</code>${desc ? `: ${escapeHtml(desc)}` : ""}.</p>` +
          `<p><a href="/api/datev/connect">Try again</a></p>`,
        400
      );
    }

    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      return htmlPage(
        "DATEV login failed",
        `<p>Missing <code>code</code> or <code>state</code> in the callback URL.</p>` +
          `<p><a href="/api/datev/connect">Restart the login</a></p>`,
        400
      );
    }

    const pkce = await consumePkce(state);
    if (!pkce) {
      return htmlPage(
        "Login link expired",
        `<p>This login link expired or was already used (state not found). It is valid for 10 minutes and single-use.</p>` +
          `<p><a href="/api/datev/connect">Restart at /api/datev/connect</a></p>`,
        400
      );
    }

    const { redirectUri } = oauthConfig();
    const json = await exchangeToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: pkce.codeVerifier,
    });
    const rec = await storeTokensFromResponse(json);

    const refreshNote = rec.refreshTokenExpiresAt
      ? `Refresh token valid until ${new Date(rec.refreshTokenExpiresAt).toISOString()} — ` +
        "DATEV refresh tokens live ~11 hours, so this connect step must be repeated roughly daily."
      : "Refresh token lifetime was not reported by DATEV.";

    return htmlPage(
      "DATEV connected",
      `<p>The MCP server is now connected to DATEV <strong>${escapeHtml(datevEnvName())}</strong>.</p>` +
        `<p class="muted">Granted scopes: <code>${escapeHtml(rec.scopes)}</code></p>` +
        `<p class="muted">Access token valid until ${new Date(rec.expiresAt).toISOString()} (auto-refreshed).<br/>` +
        `${escapeHtml(refreshNote)}</p>` +
        `<p>You can close this tab.</p>`
    );
  } catch (err: any) {
    return htmlPage(
      "DATEV connect failed",
      `<p>${escapeHtml(err?.message ?? String(err))}</p>` +
        `<p><a href="/api/datev/connect">Try again</a></p>`,
      500
    );
  }
}
