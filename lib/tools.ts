// lib/tools.ts
// MCP tool definitions for the DATEV server, in discovery → action order.
// Each tool accepts human-friendly identifiers where possible (client names are
// resolved to Mandant ids automatically) and returns compact JSON.

import { z } from "zod";
import { request, uploadDocumentMultipart } from "@/lib/datev";
import { readTokens, SKEW_MS } from "@/lib/datevAuth";
import {
  clientPath,
  clientsBase,
  clientsListPath,
  datevEnvName,
  docsBase,
  documentTypesPath,
  optional,
} from "@/lib/datevEnv";

type Json = any;

export interface ToolDef {
  name: string;
  description: string;
  // zod raw shape passed to mcp-handler / the MCP SDK
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (args: Json) => Promise<Json>;
}

// ---- shared zod fragments ----

const clientIdField = z
  .string()
  .optional()
  .describe(
    'DATEV client (Mandant) id in "{consultant_number}-{client_number}" format, e.g. "455148-1". ' +
      "Optional if clientName is given or DATEV_DEFAULT_CLIENT_ID is set. Get ids from list_clients."
  );

const clientNameField = z
  .string()
  .optional()
  .describe(
    "Human client (Mandant) name as shown in DATEV. Resolved via list_clients: " +
      "exact match first, else a unique case-insensitive substring match."
  );

// ---- helpers ----

async function fetchClients(): Promise<Json[]> {
  const data = await request({
    base: clientsBase(),
    method: "GET",
    path: clientsListPath(),
  });
  // Expected: an array of {id, name, client_number, consultant_number}.
  // Shape is unverified against the portal spec — unwrap defensively.
  if (Array.isArray(data)) return data;
  return data?.clients ?? data?.value ?? [];
}

function mapClient(c: Json) {
  return {
    id: c?.id,
    name: c?.name,
    clientNumber: c?.client_number,
    consultantNumber: c?.consultant_number,
  };
}

async function resolveClientId(args: {
  clientId?: string;
  clientName?: string;
}): Promise<string> {
  // Trim first: whitespace-only values must fall through to the default/throw
  // branch instead of matching every client via an empty substring.
  const clientId = args.clientId?.trim();
  const clientName = args.clientName?.trim();
  if (clientId) return clientId;
  if (clientName) {
    const clients = await fetchClients();
    const needle = clientName.toLowerCase();
    const exact = clients.filter((c) => String(c?.name ?? "").toLowerCase() === needle);
    if (exact.length === 1) return String(exact[0].id);
    const partial = clients.filter((c) =>
      String(c?.name ?? "").toLowerCase().includes(needle)
    );
    if (partial.length === 1) return String(partial[0].id);
    if (partial.length > 1) {
      throw new Error(
        `Client name "${args.clientName}" is ambiguous — matches: ` +
          partial
            .slice(0, 10)
            .map((c) => `${c?.name} (${c?.id})`)
            .join(", ") +
          ". Pass clientId instead."
      );
    }
    throw new Error(
      `No client named "${args.clientName}" found. Call list_clients to see available clients.`
    );
  }
  const dflt = optional("DATEV_DEFAULT_CLIENT_ID");
  if (dflt) return dflt;
  throw new Error(
    "Provide clientId or clientName (call list_clients to discover them), or set DATEV_DEFAULT_CLIENT_ID."
  );
}

// 1. get_connection_status
const get_connection_status: ToolDef = {
  name: "get_connection_status",
  description:
    "Check whether this server is connected to DATEV. Returns the environment (sandbox/production), " +
    "granted scopes, and access/refresh token expiry times. Call this first when DATEV calls fail. " +
    "Purely a status read — it never triggers a token refresh itself.",
  inputSchema: {},
  async handler() {
    const rec = await readTokens();
    const env = datevEnvName();
    if (!rec) {
      return {
        connected: false,
        env,
        hint: "Open /api/datev/connect in a browser to connect DATEV.",
      };
    }
    const now = Date.now();
    // Same 60s skew as getAccessToken, so this status never claims "valid" for a
    // token that every actual call would already refuse to use.
    const accessTokenValid = rec.expiresAt - now > SKEW_MS;
    const refreshTokenValid =
      rec.refreshTokenExpiresAt === null
        ? null
        : rec.refreshTokenExpiresAt - now > SKEW_MS;
    return {
      // Connected = we can still get an access token (directly or via refresh).
      connected: accessTokenValid || refreshTokenValid !== false,
      env,
      scopes: rec.scopes,
      accessTokenValid,
      accessTokenExpiresAt: new Date(rec.expiresAt).toISOString(),
      accessTokenExpiresInSeconds: Math.max(0, Math.round((rec.expiresAt - now) / 1000)),
      refreshTokenValid,
      refreshTokenExpiresAt: rec.refreshTokenExpiresAt
        ? new Date(rec.refreshTokenExpiresAt).toISOString()
        : null,
      refreshTokenExpiresInSeconds: rec.refreshTokenExpiresAt
        ? Math.max(0, Math.round((rec.refreshTokenExpiresAt - now) / 1000))
        : null,
      obtainedAt: new Date(rec.obtainedAt).toISOString(),
      note: "DATEV refresh tokens live ~11 hours — a human must reconnect at /api/datev/connect roughly daily.",
    };
  },
};

// 2. list_clients
const list_clients: ToolDef = {
  name: "list_clients",
  description:
    "List the DATEV clients (Mandanten) this connection can access, with their ids. " +
    "Returns each client's id (needed by the other tools), name, and consultant/client numbers. " +
    "Call this first when you don't know a client id.",
  inputSchema: {
    query: z
      .string()
      .optional()
      .describe("Optional case-insensitive substring to filter client names."),
  },
  async handler({ query }) {
    let clients = (await fetchClients()).map(mapClient);
    if (query) {
      const q = String(query).toLowerCase();
      clients = clients.filter((c) => String(c.name ?? "").toLowerCase().includes(q));
    }
    return { count: clients.length, clients };
  },
};

// 3. get_client_info
const get_client_info: ToolDef = {
  name: "get_client_info",
  description:
    "Get the details of one DATEV client (Mandant) by id or name. " +
    "Accepts a human client name (auto-resolved via list_clients) or the id directly.",
  inputSchema: {
    clientId: clientIdField,
    clientName: clientNameField,
  },
  async handler({ clientId, clientName }) {
    const id = await resolveClientId({ clientId, clientName });
    const data = await request({
      base: clientsBase(),
      method: "GET",
      path: clientPath(id),
    });
    return mapClient(data);
  },
};

// 4. list_document_types
const list_document_types: ToolDef = {
  name: "list_document_types",
  description:
    "List the document types configured for a DATEV client (Mandant). " +
    "Document types are configured PER CLIENT — upload_document's documentType MUST be one of " +
    "these values, otherwise DATEV rejects the upload (#DCO01010).",
  inputSchema: {
    clientId: clientIdField,
    clientName: clientNameField,
  },
  async handler({ clientId, clientName }) {
    const id = await resolveClientId({ clientId, clientName });
    const data = await request({
      base: docsBase(),
      method: "GET",
      path: documentTypesPath(id),
    });
    // Shape unverified against the portal spec — pass items through, wrapping
    // bare strings so the result is always a list of objects with a name.
    const items: Json[] = Array.isArray(data)
      ? data
      : data?.document_types ?? data?.value ?? [];
    const documentTypes = items.map((t) => (typeof t === "string" ? { name: t } : t));
    return { clientId: id, count: documentTypes.length, documentTypes };
  },
};

// 5. upload_document
const upload_document: ToolDef = {
  name: "upload_document",
  description:
    "Upload a document (Beleg, e.g. an invoice PDF) to DATEV Belege online for a client. " +
    "Returns the generated documentId. The documentType MUST come from list_document_types for that client. " +
    "Practical size cap is ~3 MB of file content — Vercel rejects request bodies over ~4.5 MB before the tool runs.",
  inputSchema: {
    fileBase64: z
      .string()
      .describe(
        "Base64-encoded file content (no data: URL prefix). Practical cap ~3 MB — " +
          "Vercel rejects request bodies over ~4.5 MB; DATEV's own limit is 20 MB."
      ),
    filename: z
      .string()
      .describe('Filename including extension, e.g. "invoice-123.pdf". PDF/JPG/TIFF are safe choices.'),
    documentType: z
      .string()
      .describe(
        "DATEV document type for this client — MUST be one of the values from list_document_types, " +
          "otherwise DATEV rejects the upload (#DCO01010)."
      ),
    clientId: clientIdField,
    clientName: clientNameField,
    note: z.string().optional().describe("Optional note stored with the document in Belege online."),
    category: z
      .string()
      .optional()
      .describe(
        "Belege online filing level 1 (category). If any of category/folder/register is set, all three must be set."
      ),
    folder: z.string().optional().describe("Belege online filing level 2 (folder)."),
    register: z.string().optional().describe("Belege online filing level 3 (register)."),
  },
  async handler({ fileBase64, filename, documentType, clientId, clientName, note, category, folder, register }) {
    const id = await resolveClientId({ clientId, clientName });
    const { documentId, sizeBytes } = await uploadDocumentMultipart({
      clientId: id,
      fileBase64,
      filename,
      documentType,
      note,
      category,
      folder,
      register,
    });
    return { ok: true, documentId, clientId: id, filename, sizeBytes };
  },
};

// Deliberate order: discovery -> action.
export const tools: ToolDef[] = [
  get_connection_status,
  list_clients,
  get_client_info,
  list_document_types,
  upload_document,
];
