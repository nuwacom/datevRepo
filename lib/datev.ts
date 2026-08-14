// lib/datev.ts
// Authenticated request layer for DATEV's business APIs (the analogue of
// lib/orchestrator.ts in the UiPath edition). Every call sends the OAuth bearer
// from lib/datevAuth.ts plus the X-DATEV-Client-Id header, against the
// per-service base URLs built in lib/datevEnv.ts.

import {
  datevEnvName,
  clientsBase,
  docsBase,
  oauthConfig,
  optional,
  uploadDocumentPath,
} from "@/lib/datevEnv";
import { getAccessToken } from "@/lib/datevAuth";

type Json = any;
type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOpts {
  base: string; // clientsBase() | docsBase()
  method: string;
  path: string; // already template-filled by lib/datevEnv.ts helpers
  query?: Query;
  body?: Json | FormData;
  retryOn401?: boolean; // default true: one forced token refresh + single retry
}

// Known DATEV accounting:documents fault codes (surfaced in error hints).
const DCO_MEANINGS: Record<string, string> = {
  "#DCO01010": "document_type does not exist for this client — call list_document_types",
  "#DCO01015": "unsupported file type",
  "#DCO01016": "file exceeds the 20 MB limit",
  "#DCO01253": "a file with the same name and document type already exists in Belege online",
};

export async function request(opts: RequestOpts): Promise<Json> {
  const retryOn401 = opts.retryOn401 !== false;
  const token = await getAccessToken();

  const url = new URL(`${opts.base}${opts.path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    // The OAuth consumer id from the developer portal — NOT the Mandant id.
    "X-DATEV-Client-Id": oauthConfig().clientId,
    Accept: "application/json",
  };

  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    // No Content-Type here: undici must generate the multipart boundary itself.
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, { method: opts.method, headers, body });

  if (res.status === 401 && retryOn401) {
    // 15-minute access tokens make mid-flight expiry routine: force one refresh
    // and retry once. Passing the rejected token lets getAccessToken skip the
    // refresh when Redis already holds a newer valid token. If the refresh
    // itself fails, getAccessToken throws the "reconnect at /api/datev/connect"
    // error.
    await getAccessToken({ forceRefresh: true, failedAccessToken: token });
    return request({ ...opts, retryOn401: false });
  }

  const raw = await res.text();
  let parsed: Json = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }

  if (!res.ok) {
    throw new Error(buildErrorMessage(opts.method, opts.path, res, raw, parsed));
  }
  return parsed;
}

function buildErrorMessage(
  method: string,
  path: string,
  res: Response,
  raw: string,
  parsed: Json
): string {
  const status = res.status;
  const dco = /#DCO\d+/.exec(raw || "");
  let hint = "";
  if (status === 401) {
    // Only reachable on the retry after a successful forced refresh — a failed
    // refresh throws from getAccessToken before this branch can run.
    hint =
      " (unauthorized even with a freshly refreshed token — check that the API product is activated for your app and this consultant/Mandant in the DATEV portal, that DATEV_SCOPES covers it, and that the endpoint path is correct; reconnecting at /api/datev/connect will not help if this persists)";
  } else if (dco) {
    hint = ` (DATEV fault ${dco[0]}${DCO_MEANINGS[dco[0]] ? `: ${DCO_MEANINGS[dco[0]]}` : ""})`;
  } else if (status === 400) {
    hint =
      " (bad request — check parameters/metadata; common DATEV faults: #DCO01010 unknown document_type, #DCO01015 unsupported file type, #DCO01016 file over 20 MB, #DCO01253 duplicate file)";
  } else if (status === 403) {
    hint =
      " (forbidden — a scope is missing from DATEV_SCOPES, or this consultant/Mandant is not activated for the API product in the DATEV portal)";
  } else if (status === 404) {
    hint =
      " (not found — wrong client id, or the endpoint path needs verification; see the TODO constants in lib/datevEnv.ts)";
  } else if (status === 429) {
    hint = ` (rate limited — Retry-After: ${res.headers.get("retry-after") ?? "not provided"}; wait and retry; no automatic retry is performed)`;
  } else if (status >= 500) {
    hint = " (DATEV server error — usually transient, retry later)";
  }
  const detail =
    parsed && typeof parsed === "object"
      ? JSON.stringify(parsed).slice(0, 600)
      : String(raw || "").slice(0, 600);
  return `DATEV API ${method} ${path} failed: ${status} ${res.statusText}.${hint} ${detail}`;
}

// ---- document upload (multipart) ----

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // DATEV's own limit (#DCO01016)

function guessMime(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    tif: "image/tiff",
    tiff: "image/tiff",
    xml: "application/xml",
  };
  return map[ext] ?? "application/octet-stream";
}

export async function uploadDocumentMultipart(args: {
  clientId: string;
  fileBase64: string;
  filename: string;
  documentType: string;
  note?: string;
  category?: string;
  folder?: string;
  register?: string;
}): Promise<{ documentId: string; sizeBytes: number }> {
  // Node's base64 decoder silently skips invalid characters, which would turn a
  // data: URL prefix or mangled input into a corrupted-but-"successful" upload.
  // Tolerate the common data-URL mistake by stripping the prefix, then insist
  // the remainder is strictly valid base64.
  let b64 = args.fileBase64.trim();
  const dataUrlPrefix = /^data:[^,]*,/.exec(b64);
  if (dataUrlPrefix) b64 = b64.slice(dataUrlPrefix[0].length);
  b64 = b64.replace(/\s/g, "");
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new Error(
      "fileBase64 is not valid base64 — check for truncation, interior padding, a wrong encoding, or a malformed data: URL prefix."
    );
  }
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0) {
    throw new Error("fileBase64 decoded to 0 bytes — check the base64 content.");
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File is ${(bytes.length / 1024 / 1024).toFixed(1)} MB — DATEV rejects uploads over 20 MB (#DCO01016). ` +
        "Note that Vercel already caps request bodies at ~4.5 MB, so files this large cannot reach the deployed server anyway."
    );
  }

  // category/folder/register form one 3-level Belege online filing path.
  const filing = [args.category, args.folder, args.register];
  const setCount = filing.filter((x) => x !== undefined && x !== "").length;
  if (setCount > 0 && setCount < 3) {
    throw new Error(
      "category, folder and register form one 3-level Belege online filing path — set all three or none."
    );
  }

  const metadata: Record<string, string> = { document_type: args.documentType };
  if (args.note) metadata.note = args.note;
  if (setCount === 3) {
    metadata.category = args.category!;
    metadata.folder = args.folder!;
    metadata.register = args.register!;
  }

  const fd = new FormData();
  fd.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: guessMime(args.filename) }),
    args.filename
  );
  fd.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));

  // PUT with a caller-generated RFC 4122 GUID is DATEV's preferred upload path
  // and makes the request idempotent (safe against agent retries / #DCO01253).
  const documentId = crypto.randomUUID();
  await request({
    base: docsBase(),
    method: "PUT",
    path: uploadDocumentPath(args.clientId, documentId),
    body: fd,
  });
  return { documentId, sizeBytes: bytes.length };
}

// ---- house-style export ----

export const datev = {
  request,
  uploadDocumentMultipart,
  get config() {
    return {
      env: datevEnvName(),
      clientsBase: clientsBase(),
      docsBase: docsBase(),
      defaultClientId: optional("DATEV_DEFAULT_CLIENT_ID") || null,
    };
  },
};
