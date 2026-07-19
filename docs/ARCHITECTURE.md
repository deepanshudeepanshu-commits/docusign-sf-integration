# Engineering Architecture Document
## DocuSign – SAP SuccessFactors Integration

| | |
|---|---|
| **Application ID** | `docusign-sf-integration` |
| **Version** | 1.0.0 |
| **Platform** | SAP Business Technology Platform (BTP), Cloud Foundry runtime |
| **Framework** | SAP Cloud Application Programming Model (CAP), Node.js |
| **Last Updated** | July 16, 2026 |

---

## 1. Purpose & Overview

This application acts as an **integration bridge between SAP SuccessFactors and DocuSign**. Its primary goal is to trigger a **DocuSign Maestro (Agreement Orchestration) workflow** automatically when an employee lifecycle event (e.g. a "hire") occurs in SuccessFactors.

The application solves two problems:

1. **Authentication & Authorization** — It provides a self-service UI where an administrator connects the app to a DocuSign account. Instead of shipping hardcoded secrets, the admin generates their own **Client ID / Client Secret** in the DocuSign OAuth registry, pastes them into the app, and completes an **OAuth 2.0 Authorization Code Grant** login. The resulting access/refresh tokens are stored server-side.

2. **Event-driven workflow triggering** — It exposes a **public, unauthenticated webhook** (`triggerMaestroWorkflow`) that SAP SuccessFactors **Integration Center** calls on any event. On every call the webhook **refreshes the DocuSign access token** (using the stored refresh token) and then triggers the correct Maestro workflow for the given account.

---

## 2. High-Level Architecture

```
                        ┌──────────────────────────────────────────────────────────┐
                        │                    SAP BTP – Cloud Foundry                 │
                        │                                                            │
  ┌──────────┐   HTTPS  │   ┌───────────────────┐        ┌──────────────────────┐   │
  │  Admin    │────────▶│   │  App Router        │  /api  │  CAP Node.js Service │   │
  │ (Browser) │  UI/API │   │ (approuter.nodejs) │───────▶│  (docusign-sf-       │   │
  └──────────┘         │   │                    │        │   integration-srv)   │   │
                        │   │  - /index.html     │        │                      │   │
                        │   │  - /callback.html  │  /web- │  IntegrationService  │   │
                        │   │  - /configure.html │  hook  │  (protected /api)    │   │
  ┌──────────────┐      │   │  - /home.html      │───────▶│  WebhookService      │   │
  │ SAP Success- │ POST │   │                    │        │  (public /webhook)   │   │
  │  Factors     │──────┼──▶│  /webhook (none)   │        │                      │   │
  │ Integration  │      │   └─────────┬──────────┘        │  In-memory SQLite DB │   │
  │  Center      │      │             │ xsuaa auth        └──────────┬───────────┘   │
  └──────────────┘      │             ▼                              │               │
                        │      ┌──────────────┐                      │               │
                        │      │  XSUAA (IAS) │                      │               │
                        │      └──────────────┘                      │               │
                        └────────────────────────────────────────────┼──────────────┘
                                                                      │ HTTPS
                                                                      ▼
                                                        ┌──────────────────────────┐
                                                        │        DocuSign          │
                                                        │  - OAuth Registry (apps) │
                                                        │  - Auth Server (account) │
                                                        │  - Maestro / partner-    │
                                                        │    integrations API      │
                                                        └──────────────────────────┘
```

---

## 3. Component Breakdown

### 3.1 App Router (`docusign-sf-integration-approuter`)
- Type: `approuter.nodejs`, path `app/router`.
- Serves the static admin UI (`index.html`, `callback.html`, `configure.html`, `home.html`) from `resources/`.
- Route configuration (`xs-app.json`):

| Route | Auth | Purpose |
|---|---|---|
| `^/webhook/(.*)$` | **none** | Public endpoint for SuccessFactors → `WebhookService`. CSRF disabled. |
| `^/api/(.*)$` | **xsuaa** | Protected OData/actions → `IntegrationService`. Auth token forwarded to backend. |
| `^/(.*)$` | **xsuaa** | Static UI assets. |

- `forwardAuthToken: true` on the `srv-api` destination ensures the user's JWT reaches the backend for protected routes.

### 3.2 CAP Backend (`docusign-sf-integration-srv`)
- Type: `nodejs`, path `gen/srv` (built from `srv/`).
- Hosts two CAP services and the persistence layer.

#### `IntegrationService` — protected, `@(path: '/api')`
Requires an authenticated user (XSUAA). Handles all admin/setup operations.

| Operation | Type | Description |
|---|---|---|
| `Tokens`, `Users`, `Config` | Entities (projections) | Read access to stored state. |
| `exchangeToken(code)` | Function | Exchanges the OAuth authorization code for DocuSign tokens (auth-code grant), stores tokens + user profile. |
| `saveAppConfig(...)` | Action | Persists environment, auth server, Client ID, Client Secret, and selected Account ID. |
| `logout()` | Action | Wipes all tokens, user info, and config. |

#### `WebhookService` — public, `@path: '/webhook'`, `@requires: 'any'`
Intentionally unauthenticated. Kept as a **separate service** because CAP enforces `authenticated-user` at the service-router level; a per-action annotation inside a protected service is never reached. Only non-sensitive, event-driven operations live here.

| Operation | Type | Description |
|---|---|---|
| `triggerMaestroWorkflow(data)` | Action | Called by SuccessFactors on any event. `data` is an open object: `workflowId` is required, every other property is forwarded to the Maestro workflow as an input variable. Refreshes the access token, then triggers the workflow for the stored account. |

### 3.3 Persistence (In-memory SQLite)
Deployed via `srv/server.js` on the `served` event (see [§7 Data Persistence](#7-data-persistence-model)).

| Entity | Key fields | Purpose |
|---|---|---|
| `DocuSignTokens` | `accessToken`, `refreshToken`, `expiresAt` (LargeString) | Stores the OAuth tokens. `LargeString` avoids JWT truncation. |
| `UserInfo` | `sub`, `name`, `email`, `accounts` | DocuSign user profile + available accounts (JSON). |
| `AppConfig` | `clientId`, `clientSecret`, `environment`, `authServer`, `accountId` | App configuration + user-supplied client credentials. Singleton row `ID = '1'`. |

### 3.4 XSUAA (`docusign-sf-integration-auth`)
- Managed `xsuaa` service (plan `application`), bound to both apps.
- Secures the App Router and the `/api` routes of the backend.

---

## 4. Authentication & Token Generation Flow

The app uses the **OAuth 2.0 Authorization Code Grant** with **user-supplied client credentials** (no secrets hardcoded in the app). Setup is a guided 3-step wizard on `index.html`.

### Step 1 — Generate credentials (DocuSign OAuth Registry)
- The admin selects a **DocuSign environment**: `Stage`, `Demo`, or `Production`.
- Clicking **Open OAuth Registry** opens (in a new tab) the environment-specific registry URL with the app's callback pre-attached as `redirect_uri`:
  - Stage: `https://apps-s.docusign.com/oauth-registry?integrationType=sap`
  - Demo: `https://apps-d.docusign.com/oauth-registry?integrationType=sap`
  - Production: `https://apps.docusign.com/oauth-registry?integrationType=sap`
  - `&redirect_uri=<app-origin>/callback.html`
- In the registry the admin creates an integration and obtains a **Client ID (Integration Key)** and **Client Secret**.

### Step 2 — Save credentials
- The admin pastes the Client ID and Client Secret into the app.
- The frontend calls `POST /api/saveAppConfig` which persists `clientId`, `clientSecret`, `environment`, and the derived `authServer` into `AppConfig`.
- Auth servers per environment:
  - Stage: `https://account-s.docusign.com`
  - Demo: `https://account-d.docusign.com`
  - Production: `https://account.docusign.com`

### Step 3 — Login (Authorization Code Grant)
- The admin clicks **Login with DocuSign**. The browser is redirected to:
  ```
  {authServer}/oauth/auth?response_type=code
        &scope=signature%20aow_manage
        &client_id={clientId}
        &redirect_uri={app-origin}/callback.html
  ```
  Scopes requested (least-privilege):
  - `signature` — envelope / signing operations
  - `aow_manage` — trigger & manage Maestro (Agreement Orchestration) workflows
- After the admin authorizes, DocuSign redirects back to **`/callback.html?code=...`**.
- `callback.html` calls `GET /api/exchangeToken(code=...)`, which server-side:
  1. Reads `clientId`, `clientSecret`, `authServer` from `AppConfig`.
  2. `POST {authServer}/oauth/token` with `grant_type=authorization_code` and HTTP Basic auth (`base64(clientId:clientSecret)`).
  3. Stores `access_token`, `refresh_token`, and computed `expiresAt` in `DocuSignTokens`.
  4. Calls `GET {authServer}/oauth/userinfo` and stores the profile + accounts in `UserInfo`.
- The admin is then taken to `configure.html` to select the DocuSign **Account** (stored as `AppConfig.accountId`), and finally `home.html` shows the connected status (User, Email, Environment, Selected Account).

> **Login-page routing:** On load, `index.html` checks the backend for existing state (`Config` + `Tokens`). If tokens **and** client credentials **and** a selected account already exist, it redirects to `home.html`; if tokens + credentials exist but no account is selected, it resumes at `configure.html`; otherwise it stays on the login page and pre-fills any saved config.

### Sequence Diagram — Token Generation

```
Admin        Browser (SPA)        App Router        CAP Backend        DocuSign
  │                │                   │                 │                 │
  │ pick env       │                   │                 │                 │
  │ Open Registry ▶│  new tab ─────────┼─────────────────┼────────────────▶│ (registry)
  │                │                   │                 │   create app    │
  │ paste ID/secret│                   │                 │   copy creds    │
  │ Save ─────────▶│ POST /api/save    │────────────────▶│ store AppConfig │
  │                │  AppConfig        │                 │                 │
  │ Login ────────▶│ redirect /oauth/auth ───────────────┼────────────────▶│ (consent)
  │                │◀── redirect /callback.html?code=... ─┼─────────────────│
  │                │ GET /api/exchangeToken(code) ───────▶│ POST /oauth/token▶│
  │                │                   │                 │◀─ tokens ────────│
  │                │                   │                 │ GET /userinfo ──▶│
  │                │                   │                 │ store tokens+user│
  │                │◀── userInfo ──────┼─────────────────│                 │
  │ configure acct │ POST /api/saveAppConfig(accountId) ─▶│ store accountId │
  │ home (connected)│                  │                 │                 │
```

---

## 5. Webhook / Maestro Trigger Flow

Once the app is connected and an account is configured, SuccessFactors can trigger workflows.

### Endpoint
```
POST https://{approuter-host}/webhook/triggerMaestroWorkflow
Content-Type: application/json

{
  "data": {
    "workflowId": "<maestro-workflow-id>",
    "employeeName": "John Doe",
    "email": "john.doe@example.com"
  }
}
```
- `data` is a single **open object**: `workflowId` is the only required field; every other property (any name/value SuccessFactors sends) is forwarded to the Maestro workflow as an input variable.
- Public (auth `none`), CSRF disabled — suitable for configuration in **SAP SuccessFactors Integration Center** as an outbound REST/OData destination.

### Processing logic (`WebhookService.triggerMaestroWorkflow`)
1. Validate `workflowId` is present (else `400`).
2. Read the stored token (`DocuSignTokens`) and selected account (`AppConfig.accountId`).
   - If no token → `400` "App not authenticated".
   - If no account → `400` "App not configured".
3. **Refresh the access token on every call.** `POST {authServer}/oauth/token` with `grant_type=refresh_token` and HTTP Basic auth (`base64(clientId:clientSecret)`). The new `access_token`, (rotated) `refresh_token`, and recomputed `expiresAt` are persisted back to `DocuSignTokens`. If the refresh fails (missing/revoked refresh token or credentials) → `401` "DocuSign session expired".
4. Build the Maestro trigger payload: an auto-generated `instanceName` (`BAS Triggered Workflow - {timestamp}`) and `inputVariables` = every payload property other than `workflowId` (type inferred: string/number/boolean; nested objects are JSON-stringified).
5. Resolve the **partner-integrations host from the saved environment** (critical — must match the token's issuer environment, otherwise DocuSign returns `Jwt issuer is not configured`):
   - Stage: `https://services.stage.docusign.net`
   - Demo: `https://services.demo.docusign.net`
   - Production: `https://services.docusign.net`
6. `POST {host}/partner-integrations/v1.0/accounts/{accountId}/maestro-workflows/trigger/{workflowId}` with `Authorization: Bearer {accessToken}`.
7. On success → `"Workflow triggered successfully"`. On failure → `500` including the underlying DocuSign error message for easier diagnosis.

### Sequence Diagram — Workflow Trigger

```
SuccessFactors    App Router (/webhook, none)    CAP WebhookService    DocuSign
      │                    │                             │                    │
      │ POST trigger ─────▶│ ───────────────────────────▶│                    │
      │                    │                             │ read token+account │
      │                    │                             │ POST /oauth/token ─▶│ (refresh_token)
      │                    │                             │◀── new access token │
      │                    │                             │ resolve env host   │
      │                    │                             │ POST trigger ──────▶│ (Maestro)
      │                    │                             │◀── 200 / error ────│
      │◀── 200 "triggered" │◀────────────────────────────│                    │
```

---

## 6. Deployment Architecture (MTA)

Defined in `mta.yaml` (schema 3.3.0). Built with `mbt build`, deployed with `cf deploy`.

| Module | Type | Path | Notes |
|---|---|---|---|
| `docusign-sf-integration-srv` | nodejs | `gen/srv` | CAP backend. Provides `srv-api` (`srv-url`). |
| `docusign-sf-integration-approuter` | approuter.nodejs | `app/router` | Serves UI, routes to `srv-api`; build copies `*.html` into `resources/`. |
| `docusign-sf-integration-auth` | managed-service (xsuaa) | — | Security. Bound to both apps. |

Build pipeline: `npm ci` → `npx cds build --production` → package modules → generate `.mtar`.

**Live endpoints (dev space):**
- App Router: `https://b67584fctrial-dev-docusign-sf-integration-approuter.cfapps.ap21.hana.ondemand.com`
- Backend:    `https://b67584fctrial-dev-docusign-sf-integration-srv.cfapps.ap21.hana.ondemand.com`
- Redirect URI (registry + auth-code): `<app-router>/callback.html`

---

## 7. Data Persistence Model

- The `db` is configured as **in-memory SQLite** (`:memory:`).
- On startup, `srv/server.js` (on the `served` lifecycle event) deploys the CDS model into the in-memory DB when running the production profile, creating the tables.
- **Consequence:** all state (tokens, user info, config) is **lost on app restart or redeploy**. The admin must re-run the DocuSign login after each restart.
- **Recommendation for production:** switch the `db` binding to **SAP HANA Cloud** (persistent) so tokens and configuration survive restarts and can support refresh-token rotation.

---

## 8. Security Considerations

| Area | Current state | Recommendation |
|---|---|---|
| Client secrets | User-supplied, stored in `AppConfig` (no secrets in source). | Encrypt at rest / use SAP Credential Store; move to persistent secure storage. |
| Webhook endpoint | Public, unauthenticated, CSRF disabled. | Add a shared secret / HMAC signature header validated in `triggerMaestroWorkflow`; IP allow-listing for SuccessFactors. |
| Token storage | `LargeString` columns, in-memory. | Persist in HANA; consider encryption. Refresh-token exchange is performed on every webhook trigger; move token store to HANA so it survives restarts. |
| Scopes | Least-privilege (`signature`, `aow_manage`). | Keep minimal; review per use case. |
| UI/API access | XSUAA-protected. | Add role-based authorization for admin-only setup. |
| Multi-tenancy | Singleton `AppConfig` (`ID='1'`), single connection. | Introduce per-tenant/per-account keys if multiple accounts needed. |

---

## 9. Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js on Cloud Foundry (SAP BTP) |
| Application framework | SAP CAP (`@sap/cds` v9) |
| Security | XSUAA (`@sap/xssec`), App Router (`@sap/approuter`) |
| Persistence | SQLite in-memory (`@cap-js/sqlite`) — HANA recommended for prod |
| HTTP client | `axios` |
| Frontend | Static HTML/JS (vanilla), served by App Router |
| Packaging | Multi-Target Application (MTA), `mbt` + `cf deploy` |
| External APIs | DocuSign OAuth Registry, DocuSign Auth Server, DocuSign Maestro / partner-integrations API |

---

## 10. Key Design Decisions

1. **No hardcoded DocuSign secrets** — the admin brings their own Client ID/Secret via the OAuth registry, making the app distributable and environment-agnostic.
2. **Separate public `WebhookService`** — required because CAP applies `authenticated-user` at the service-router level; a truly public endpoint must live in its own `@requires: 'any'` service exposed via the App Router with auth `none`.
3. **Environment-aware hosts** — auth server and Maestro (partner-integrations) hosts are derived from the saved environment to prevent `Jwt issuer is not configured` errors caused by cross-environment token/API mismatches.
4. **`LargeString` token columns** — DocuSign JWT access tokens frequently exceed 2000 characters; smaller columns silently truncate them and break Bearer auth.
5. **Authorization Code Grant (interactive)** — chosen so the app acts on behalf of a real DocuSign user with consent, rather than a service-account/JWT-grant model.
6. **Refresh-on-every-trigger** — the webhook always exchanges the stored refresh token for a fresh access token before calling Maestro. This avoids `401`/expired-token failures without tracking `expiresAt` at call time, at the cost of one extra token request per trigger.
