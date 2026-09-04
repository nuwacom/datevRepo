// lib/datevEnv.ts
// Single source of truth for every DATEV endpoint this server talks to.
// DATEV_ENV=sandbox|production switches login endpoints AND API base paths here,
// so no other file needs to know about environment differences.
//
// Endpoint confidence:
//   - OAuth endpoints are CONFIRMED from DATEV's official OIDC discovery documents:
//       https://login.datev.de/openid/.well-known/openid-configuration
//       https://login.datev.de/openidsandbox/.well-known/openid-configuration
//   - Business-API hosts/paths carry per-constant confidence tags below. Anything
//     marked TODO must be verified against the OpenAPI spec on developer.datev.de
//     (downloadable from each product page once you have portal access).

// ---- env helpers (house pattern: throw lazily so /healthz can catch) ----

export function required(name: string): string {
  const v = (process.env[name] || "").trim();
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

export function optional(name: string, fallback = ""): string {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}

// ---- OAuth endpoints (CONFIRMED — official OIDC discovery documents) ----

const OAUTH = {
  sandbox: {
    authorize: "https://login.datev.de/openidsandbox/authorize",
    token: "https://sandbox-api.datev.de/token",
    revoke: "https://sandbox-api.datev.de/revoke",
    userinfo: "https://sandbox-api.datev.de/userinfo",
  },
  production: {
    authorize: "https://login.datev.de/openid/authorize",
    token: "https://api.datev.de/token",
    revoke: "https://api.datev.de/revoke",
    userinfo: "https://api.datev.de/userinfo",
  },
} as const;

// ---- Business API services ----
// DATEV hosts each API product on its own subdomain (NOT one shared api base):
//   https://{service}.api.datev.de/platform/v{N}          (production)
//   https://{service}.api.datev.de/platform-sandbox/v{N}  (sandbox)

// CONFIRMED: "accounting:documents" 2.0 (Belegbilderservice Rechnungswesen)
// https://developer.datev.de/en/product-detail/accounting-documents/2.0/reference
const ACCOUNTING_DOCUMENTS_SERVICE = "accounting-documents";
const ACCOUNTING_DOCUMENTS_VERSION = "v2";

// TODO: verify host + version against the "accounting:clients" 2.0 product page:
// https://developer.datev.de/en/product-detail/accounting-clients/2.0/reference
const ACCOUNTING_CLIENTS_SERVICE = "accounting-clients";
const ACCOUNTING_CLIENTS_VERSION = "v2";

// ---- Resource paths ----
// TODO: verify against the OpenAPI specs on developer.datev.de:
//   GET  {clientsBase}/clients                          — accounting:clients 2.0
//   GET  {clientsBase}/clients/{clientId}               — accounting:clients 2.0
//   GET  {docsBase}/clients/{clientId}/document-types   — accounting:documents 2.0
//   PUT  {docsBase}/clients/{clientId}/documents/{guid} — accounting:documents 2.0 (CONFIRMED)
const CLIENTS_LIST_PATH = "/clients";

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

// ---- environment switching ----

export function datevEnvName(): "sandbox" | "production" {
  const env = optional("DATEV_ENV", "sandbox").toLowerCase();
  if (env !== "sandbox" && env !== "production") {
    throw new Error(`DATEV_ENV must be "sandbox" or "production", got "${env}".`);
  }
  return env;
}

export function isSandbox(): boolean {
  return datevEnvName() === "sandbox";
}

export function authorizeUrl(): string {
  return OAUTH[datevEnvName()].authorize;
}

export function tokenUrl(): string {
  return OAUTH[datevEnvName()].token;
}

export function revokeUrl(): string {
  return OAUTH[datevEnvName()].revoke;
}

export function userinfoUrl(): string {
  return OAUTH[datevEnvName()].userinfo;
}

export function serviceBase(service: string, version: string): string {
  const stage = isSandbox() ? "platform-sandbox" : "platform";
  return `https://${service}.api.datev.de/${stage}/${version}`;
}

export function docsBase(): string {
  return serviceBase(ACCOUNTING_DOCUMENTS_SERVICE, ACCOUNTING_DOCUMENTS_VERSION);
}

export function clientsBase(): string {
  return serviceBase(ACCOUNTING_CLIENTS_SERVICE, ACCOUNTING_CLIENTS_VERSION);
}

// ---- path fillers (lib/datev.ts never string-builds paths itself) ----

export function clientsListPath(): string {
  return CLIENTS_LIST_PATH;
}

export function clientPath(clientId: string): string {
  return `${CLIENTS_LIST_PATH}/${enc(clientId)}`;
}

export function documentTypesPath(clientId: string): string {
  return `/clients/${enc(clientId)}/document-types`;
}

export function uploadDocumentPath(clientId: string, documentId: string): string {
  return `/clients/${enc(clientId)}/documents/${enc(documentId)}`;
}

// ---- OAuth app config ----

export function oauthConfig(): {
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
} {
  return {
    clientId: required("DATEV_CLIENT_ID"),
    clientSecret: required("DATEV_CLIENT_SECRET"),
    scopes: required("DATEV_SCOPES"),
    redirectUri: required("DATEV_REDIRECT_URI"),
  };
}

export function defaultClientId(): string {
  return optional("DATEV_DEFAULT_CLIENT_ID");
}

// ---- config check for /healthz ----

export function checkConfig(): { ok: boolean; error?: string } {
  try {
    datevEnvName();
    oauthConfig();
    required("REDIS_URL");
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
