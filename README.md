# DATEV MCP Server — Vercel Edition

An [MCP](https://modelcontextprotocol.io) server that exposes **DATEV** accounting APIs
(clients/Mandanten and document upload to **Belege online**) as tools for **nuwacom**
agents. Built with Next.js and [`mcp-handler`](https://www.npmjs.com/package/mcp-handler),
deployed on **Vercel**. The sibling of the UiPath Orchestrator MCP server, adapted for
DATEV's user-consent OAuth world.

```
nuwacom agent ──Bearer MCP_AUTH_TOKEN──►  /api/mcp (Vercel)  ──OAuth Bearer──►  {service}.api.datev.de
                                               │
                                               └──── tokens ────► Upstash Redis
human (≈daily) ──browser──► /api/datev/connect ──► login.datev.de ──► /api/datev/callback
```

Works against the DATEV **sandbox** and **production** environments — controlled by
environment variables.

---

## What's different from the UiPath edition

- **No client-credentials flow.** DATEV's business APIs require OAuth 2.0
  **Authorization Code + PKCE (OIDC)**: a human DATEV user (SmartLogin/SmartCard)
  grants consent once in a browser via `/api/datev/connect`.
- **Tokens persist in Upstash Redis.** Access tokens live ~15 minutes and are refreshed
  automatically (guarded by a small Redis lock). Refresh tokens live **~11 hours**, so the
  browser connect step must be repeated roughly daily. A module-level cache alone would
  lose the refresh token on every cold start.
- **Per-service API hosts.** DATEV serves each API product from its own subdomain
  (`https://{service}.api.datev.de/platform{-sandbox}/v{N}`) — all endpoint construction
  lives in `lib/datevEnv.ts`.
- Every API call sends `Authorization: Bearer …` **and** `X-DATEV-Client-Id: <client id>`
  (the OAuth consumer id from the developer portal — not the Mandant id).

> **Serverless upload note:** Vercel rejects request bodies over **~4.5 MB**, so document
> uploads are practically capped at **~3 MB of file content** (base64 inflates by ~33%).
> DATEV's own 20 MB limit is unreachable through this server.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_connection_status` | Is DATEV connected? Environment, granted scopes, token expiry times. |
| `list_clients` | List accessible clients (Mandanten) with their ids. |
| `get_client_info` | Details for one client, by id or name. |
| `list_document_types` | Document types configured for a client — required input for uploads. |
| `upload_document` | Upload a document (base64 + filename + document type) to Belege online. |

Tools accept human client **names** and resolve them to Mandant ids automatically
(exact match first, then unique substring). Document *reading/listing* is deliberately
not included: the `accounting:documents` v2 API (Belegbilderservice) is upload-only.

## Token lifetime: two modes

DATEV access tokens always last 15 minutes and are refreshed automatically. How long
the *refresh* token lasts — i.e. how often a human has to reconnect — depends on the
scopes you request, and the trade-off is worth understanding before you choose.

| | **A — Session mode** (default) | **B — Offline mode** (`offline_access`) |
| --- | --- | --- |
| Refresh token lifetime | max 11 hours | 2 years, renewed on every refresh |
| Human reconnect | ~once per working day | effectively never |
| Mandanten reachable | all the connection can see | **exactly one**, fixed at login |
| `list_clients` | works | **does not work** |
| Extra scope needed | — | `offline_access` + `datev:iam:client:<consultant>-<client>` |

Mode B sounds strictly better but carries a real restriction: the token is bound to a
single Mandant and only works on endpoints that carry the client id in the URL path.
`GET /clients` has no client id in its path, so `list_clients` returns an error — you
pin the Mandant via `DATEV_DEFAULT_CLIENT_ID` instead. DATEV also requires that you
verify the Mandant is reachable before requesting the offline token, implement token
revocation, and prominently link users to
[apps.datev.de/tokrevui](https://apps.datev.de/tokrevui) so they can disconnect.

Start with mode A while you are getting the integration working; move to mode B if
unattended operation for a single Mandant matters more than multi-client discovery.

> **Refresh tokens are single-use.** Every refresh invalidates the previous refresh
> *and* access token. Replaying one invalidates the whole session and forces a fresh
> login — which is why [lib/datevAuth.ts](lib/datevAuth.ts) serialises refreshes behind
> a Redis lock rather than letting concurrent invocations race.

---

## 1. Create an app in the DATEV Developer Portal

1. Register at [developer.datev.de](https://developer.datev.de) and create (or join) an
   **Organisation** — apps and API subscriptions belong to organisations, not personal accounts.
2. Under **Products**, subscribe to the API products you need — at minimum
   **accounting:documents** (Belegbilderservice) and **accounting:clients** — and accept
   the DATEV interface agreement. DATEV reviews the subscription request.
3. Create an app (**App erstellen**). Copy the **client id** and **client secret**.
4. Set the **client type to Confidential** (this server holds a client secret in a
   backend and needs long-lived tokens — DATEV's Backend-for-Frontend case) and the
   flow to **OpenID Connect Authorization Code Flow**, not the deprecated Hybrid Flow.
5. Register your **redirect URI** — the portal validates it strictly
   ([requirements](https://developer.datev.de/de/guides/authentication#anforderungen-an-redirecturls-in-der-produktivumgebung)):
   - **"DATEV" may not appear in the domain, only in the path.** `https://datev-mcp.example.com/…`
     is rejected; `https://mcp.example.com/api/datev/callback` is fine. This server's
     `/api/datev/` path is deliberately chosen to stay on the legal side of that line —
     just keep the word out of your hostname.
   - HTTPS URLs allow **no wildcards**; register each full URL exactly, path included.
   - For http, only literally `http://localhost` may be registered. It then acts as a
     placeholder for any port and path, so you register `http://localhost` but may use
     `http://localhost:3000/api/datev/callback` at runtime.
   - `localhost`, custom schemes and other local/internal/development-like URIs are
     **sandbox only**. Production requires a uniquely resolvable, production-usable domain.
6. Copy the **scope strings verbatim** from the portal into `DATEV_SCOPES` — DATEV's
   scope naming is inconsistent across public docs (`accounting:documents` vs
   `datev:accounting:documents`), and only the portal shows the strings your app actually has.
   Then decide between the two token modes described under
   [Token lifetime: two modes](#token-lifetime-two-modes) below.
6. New subscriptions start **sandbox-only** (with demo Mandanten like `455148-1`). Production
   access is requested from the app's detail page and reviewed by DATEV
   (Beratung Ökosystem) against their interface requirements — plan for weeks, not days.
   A production app cannot be downgraded back to sandbox.

---

## 2. Deploy to Vercel

**Option A — Dashboard (simplest):**

1. Push this repo to GitHub and import it in [vercel.com](https://vercel.com) (framework
   preset: Next.js — no extra config needed).
2. Add the environment variables from the table below.
3. Create a free Redis database at [console.upstash.com](https://console.upstash.com) and
   copy its REST URL + token into the env vars.
4. **Settings → Functions → Fluid Compute → On** — better for MCP's bursty traffic and
   warm token reuse.
5. Deploy, then continue with **Verify** below.

**Option B — CLI:**

```bash
npm i -g vercel
vercel                  # link + first deploy
vercel env add DATEV_CLIENT_ID        # repeat for every variable below
vercel --prod
```

Remember: environment variable changes require a redeploy.

---

## 3. Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DATEV_ENV` | no (default: `sandbox`) | `sandbox` or `production`. Switches login endpoints and API base paths — set it explicitly in production. |
| `DATEV_CLIENT_ID` | yes | From the developer portal app. Also sent as `X-DATEV-Client-Id`. |
| `DATEV_CLIENT_SECRET` | yes | From the developer portal app. |
| `DATEV_SCOPES` | yes | Space-separated, **verbatim from the portal**. |
| `DATEV_REDIRECT_URI` | yes | Must exactly match a URI registered on the app. |
| `MCP_AUTH_TOKEN` | strongly recommended | Shared secret nuwacom sends as `Authorization: Bearer …`. Unset = open endpoint (dev only). |
| `UPSTASH_REDIS_REST_URL` | yes | From console.upstash.com → your database → REST API. |
| `UPSTASH_REDIS_REST_TOKEN` | yes | Same page. |
| `DATEV_DEFAULT_CLIENT_ID` | optional | Default Mandant (`{consultant}-{client}`, e.g. `455148-1`) when tools get no client. |
| `DATEV_CONNECT_KEY` | optional | If set, `/api/datev/connect` requires `?key=<value>`. |

---

## 4. Verify

```bash
curl https://<your-app>.vercel.app/healthz
# { "ok": true, "configOk": true, "authEnabled": true, "datev": { "connected": false }, "tools": [ ... ] }
```

**Connect DATEV (one-time browser step, repeat ~daily):** open

```
https://<your-app>.vercel.app/api/datev/connect
```

in a browser, log in with your DATEV sandbox/production user and grant consent. The
success page confirms the environment and token expiry; `/healthz` now shows
`"datev": { "connected": true, ... }`.

Then point [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at:

```
https://<your-app>.vercel.app/api/mcp
```

with header `Authorization: Bearer <MCP_AUTH_TOKEN>` — `tools/list` should show the five
tools, and `get_connection_status` should return `"connected": true`.

---

## 5. Register in nuwacom

1. In nuwacom go to **Workspace Settings → Connectors → Manage connectors** (admin).
2. Add a **custom MCP server**:
   - **URL**: `https://<your-app>.vercel.app/api/mcp`
   - **Header**: `Authorization: Bearer <MCP_AUTH_TOKEN>`
3. Save and enable it for the workspace.

(If you don't see the custom-MCP option, contact your nuwacom admin / support@nuwacom.ai —
it's an admin/advanced feature.)

---

## 6. Add the tools to an agent

> You can work with DATEV accounting. Call `get_connection_status` first; if DATEV is not
> connected, ask the user to open `/api/datev/connect` in a browser. Use `list_clients` to
> find the right Mandant when the user names one. Before uploading a document, fetch the
> valid types with `list_document_types` — then call `upload_document` with the file as
> base64. Report the returned `documentId`.

A prompt like *"upload this invoice PDF to Mandant Musterfirma as Rechnungseingang"* then
works in one shot: the client name and document type are resolved automatically.

---

## Local development

```bash
npm install
cp .env.example .env.local   # fill in DATEV + Upstash credentials
npm run dev                  # http://localhost:3000
```

Local OAuth needs `http://localhost:3000/api/datev/callback` registered as a redirect URI
on the DATEV app, and `DATEV_REDIRECT_URI` set accordingly in `.env.local`.

## Security notes

- **Set `MCP_AUTH_TOKEN`** (32+ random chars). Without it the MCP endpoint is open —
  acceptable only for short-lived local testing.
- **Least-privilege scopes:** request only the API products this server actually uses in
  `DATEV_SCOPES`.
- Tokens live **only in Upstash Redis** (encrypted at rest on Upstash's side; use their
  EU region for GDPR-friendly hosting). They are never logged, never returned by tools,
  and never rendered on the OAuth result pages.
- `/api/datev/connect` and `/api/datev/callback` are deliberately reachable without the
  bearer token (a browser can't send it). The callback is protected by a single-use,
  10-minute `state` stored server-side, so authorization codes can't be injected or
  replayed. The residual risk is someone re-binding the server to *their own* DATEV
  account — mitigate with `DATEV_CONNECT_KEY` if the URL is guessable.

## Notes & limits

- **Upload size:** ~4.5 MB Vercel body limit → ~3 MB practical file cap (base64 overhead).
  DATEV's 20 MB limit is unreachable through this server.
- **Token lifetimes:** access ~15 min (auto-refreshed), refresh ~11 h → a human must
  repeat `/api/datev/connect` roughly daily. `get_connection_status` shows both expiries.
- **Unverified endpoint details:** some paths (clients list, document types) come from
  integrator documentation, not the official OpenAPI specs — they are isolated as
  TODO-flagged constants in `lib/datevEnv.ts` for easy correction once you have portal
  access. Document list/read tools were left out entirely: Belegbilderservice v2 is
  upload-only.
- **`document_type` is per client** — always take it from `list_document_types`, or DATEV
  rejects the upload (`#DCO01010`).
- DATEV publishes no rate limits; on `429` the error surfaces `Retry-After` and the
  agent should simply retry later.
