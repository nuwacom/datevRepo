// app/healthz/route.ts
// Health check. Always HTTP 200 — configuration and connection problems are
// reported in the body, not via status codes. Not bearer-protected.

import { tools } from "@/lib/tools";
import { checkConfig, datevEnvName } from "@/lib/datevEnv";
import { readTokens } from "@/lib/datevAuth";

export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = checkConfig();

  let datevStatus: any;
  try {
    const rec = await readTokens();
    const now = Date.now();
    datevStatus = rec
      ? {
          connected: true,
          env: datevEnvName(),
          accessTokenValid: rec.expiresAt > now,
          accessTokenExpiresAt: new Date(rec.expiresAt).toISOString(),
          refreshTokenExpiresAt: rec.refreshTokenExpiresAt
            ? new Date(rec.refreshTokenExpiresAt).toISOString()
            : null,
        }
      : { connected: false };
  } catch (err: any) {
    datevStatus = { connected: false, error: err?.message ?? String(err) };
  }

  return new Response(
    JSON.stringify({
      ok: true,
      server: "datev-mcp",
      version: "0.1.0",
      transport: "streamable-http (mcp-handler)",
      endpoint: "/api/mcp",
      authEnabled: Boolean((process.env.MCP_AUTH_TOKEN || "").trim()),
      configOk: cfg.ok,
      configError: cfg.error ?? null,
      datev: datevStatus,
      tools: tools.map((t) => t.name),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
