// app/api/[transport]/route.ts
// The MCP server endpoint for Vercel, built with mcp-handler.
// Serves MCP over streamable HTTP at /api/mcp, gated by a shared-secret bearer
// token (MCP_AUTH_TOKEN) checked on every request. The legacy HTTP+SSE transport
// (/api/sse) is NOT supported: mcp-handler would need a node-redis REDIS_URL for
// its pub/sub bridge, which this project does not provision — point clients at
// /api/mcp only.

import { createMcpHandler } from "mcp-handler";
import { tools } from "@/lib/tools";
import { datev } from "@/lib/datev";

export const dynamic = "force-dynamic";

const handler = createMcpHandler(
  (server) => {
    for (const tool of tools) {
      server.tool(
        tool.name,
        tool.description,
        tool.inputSchema,
        async (args: any) => {
          try {
            const result = await tool.handler(args ?? {});
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
          } catch (err: any) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Error in ${tool.name}: ${err?.message ?? String(err)}`,
                },
              ],
            };
          }
        }
      );
    }
  },
  {
    // server capabilities/instructions
    capabilities: {
      tools: Object.fromEntries(
        tools.map((t) => [t.name, { description: t.description }])
      ),
    },
    instructions:
      "Tools to work with DATEV accounting: check the connection, discover clients (Mandanten), " +
      "list a client's document types, and upload documents (Belege) to DATEV. " +
      "Clients are identified as '{consultant_number}-{client_number}', e.g. 455148-1; when the user " +
      "names a client, pass that name directly — it is resolved to the right id automatically. " +
      "Before uploading, get the documentType from list_document_types for that client. " +
      "If a call fails because DATEV is not connected or the refresh token expired, tell the user to " +
      "open /api/datev/connect in a browser — a human must re-consent roughly daily.",
  },
  {
    // mcp-handler options
    basePath: "/api",
    maxDuration: 60,
    verboseLogs: true,
  }
);

// ---- bearer-token gate ----
function authorized(req: Request): boolean {
  const token = (process.env.MCP_AUTH_TOKEN || "").trim();
  if (!token) return true; // auth disabled (testing only)
  const header = req.headers.get("authorization") || "";
  const presented = header.replace(/^Bearer\s+/i, "").trim();
  return presented.length > 0 && presented === token;
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid bearer token." },
      id: null,
    }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );
}

async function guarded(req: Request): Promise<Response> {
  if (!authorized(req)) return unauthorized();
  return handler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };

// (datev imported so config errors surface at module load if misconfigured)
void datev;
