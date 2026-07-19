# Engineering Architecture Document
## DocuSign – SAP SuccessFactors Integration

| | |
|---|---|
| **Application ID** | `docusign-sf-integration` |
| **Version** | 1.0.0 |
| **Platform** | SAP Business Technology Platform (BTP), Cloud Foundry runtime |
| **Framework** | SAP Cloud Application Programming Model (CAP), Node.js |
| **Delivery model** | Multitenant SaaS — customers subscribe from their own BTP subaccounts |
| **Last Updated** | July 19, 2026 |

---

## 1. Purpose & Overview (What & Why)

This application is a **multitenant SaaS bridge between SAP SuccessFactors and DocuSign**. It lets an HR/administrator connect their DocuSign account once, and then trigger a **DocuSign Maestro (Agreement Orchestration) workflow** automatically whenever an event happens in SuccessFactors (e.g. a new hire) — without writing any code.

### The two goals we set out to achieve

1. **Login & store an access token (self-service connect).**
   Each customer connects the app to their own DocuSign account through a guided UI. Instead of shipping hardcoded secrets, the admin brings their **own Client ID / Client Secret** from the DocuSign OAuth registry and completes an **OAuth 2.0 Authorization Code Grant** login. The app stores the resulting **access + refresh tokens** securely, per customer.

2. **Provide a ready-to-use Maestro trigger URL for Integration Center.**
   The app gives each customer a **unique webhook URL** (shown in the UI, copy-ready). The customer pastes it into **SuccessFactors Integration Center** as an outbound REST call. When SuccessFactors fires an event, it calls that URL, and the app triggers the correct Maestro workflow **using that customer's own DocuSign token**.

### Who uses it (personas)

| Persona | What they do |
|---|---|
| **Provider (us)** | Build, deploy, and operate the single SaaS app on BTP. |
| **Customer admin** | Subscribes to the app, connects DocuSign, copies the trigger URL. |
| **SuccessFactors (system)** | Calls the trigger URL automatically on HR events. |

### Why SaaS / multitenant

The app is deployed **once** by us (the provider). Many SuccessFactors customers **subscribe** from their own BTP subaccounts. Each subscriber is an **isolated tenant** with its **own database container** — so one customer never sees another's DocuSign tokens or configuration.

---

## 2. High-Level Architecture (How it fits together)

We deploy **one** SaaS app. Each customer **subscribes** from their own subaccount and gets an isolated database container. All UI/API traffic flows through the App Router; SuccessFactors calls the public tenant-specific webhook.

```
   CUSTOMER A subaccount          CUSTOMER B subaccount        (each subscribes once)
          │  subscribe                    │  subscribe
          ▼                               ▼
 ┌───────────────────────────────────────────────────────────────────────────┐
 │                     SAP BTP – Cloud Foundry  (Provider)                     │
 │                                                                            │
 │   ┌──────────────────┐        ┌───────────────────────┐                    │
 │   │   App Router      │  /api  │  CAP Backend (srv)    │                    │
 │   │ (approuter.nodejs)│───────▶│  IntegrationService   │   per-tenant       │
 │   │  - UI (*.html)    │        │   (protected /api)    │   data access      │
 │   │  - /api  (xsuaa)  │  /web- │  Webhook route        │──────┐             │
 │   │  - /webhook (none)│  hook  │  (tenant-aware)       │      │             │
 │   └───────┬──────────┘        └───────────────────────┘      ▼             │
 │           │ xsuaa (shared)                              ┌───────────────┐   │
 │           ▼                    ┌───────────────────┐    │  SAP HANA     │   │
 │   ┌──────────────┐             │  MTX Sidecar      │    │  Cloud        │   │
 │   │    XSUAA     │             │ (onboards tenants,│───▶│  ┌─────────┐  │   │
 │   └──────────────┘             │  provisions HDI)  │    │  │ HDI: A  │  │   │
 │           ▲                    └─────────┬─────────┘    │  ├─────────┤  │   │
 │           │                              │              │  │ HDI: B  │  │   │
 │   ┌───────┴────────┐            ┌─────────▼────────┐    │  └─────────┘  │   │
 │   │ SaaS Registry  │◀──────────▶│  Service Manager │    └───────────────┘   │
 │   │ (marketplace)  │            │ (creates HDI/    │     one isolated       │
 │   └────────────────┘            │  tenant)         │     container/tenant   │
 │                                 └──────────────────┘                        │
 └───────────────────────────────────────────────┬───────────────────────────┘
                                                  │ HTTPS (per-tenant token)
   ┌──────────────┐  POST /webhook/tenant/<id>/…  ▼
   │ SAP Success- │───────────────────────────▶ (App Router → Backend)   ┌──────────┐
   │  Factors     │   (configured in                                     │ DocuSign │
   │ Integration  │    Integration Center)                               │ (OAuth + │
   │  Center      │                                                      │  Maestro)│
   └──────────────┘                                                      └──────────┘
```

**In one line:** the App Router serves the UI and forwards traffic; the CAP backend holds the business logic; the MTX sidecar + Service Manager give each subscriber its own HANA HDI container; the SaaS Registry makes the app subscribable; XSUAA secures it.

---

## 3. Component Breakdown

### 3.1 App Router (`docusign-sf-integration-approuter`)
- Type: `approuter.nodejs`, path `app/router`.
- Serves the static admin UI (`index.html`, `callback.html`, `configure.html`, `home.html`) from `resources/`.
- Uses a **short custom host** (`dsf-b67584fctrial`) so per-tenant subscription URLs stay within the DNS 63-character limit.
- Route configuration (`xs-app.json`):

| Route | Auth | Purpose |
|---|---|---|
| `^/-/cds/.*` | **none** | MTX sidecar endpoints (tenant onboarding callbacks). |
| `^/webhook/(.*)$` | **none** | Public endpoint for SuccessFactors → tenant-aware webhook. CSRF disabled. |
| `^/api/(.*)$` | **xsuaa** | Protected OData/actions → `IntegrationService`. Auth token forwarded to backend. |
| `^/(.*)$` | **xsuaa** | Static UI assets. |

- `TENANT_HOST_PATTERN` lets the App Router identify the calling tenant from the subscription subdomain.
- `forwardAuthToken: true` on the `srv-api` destination ensures the user's JWT (with tenant info) reaches the backend for protected routes.

### 3.2 CAP Backend (`docusign-sf-integration-srv`)
- Type: `nodejs`, path `gen/srv` (built from `srv/`).
- Hosts two CAP services and the persistence layer.

#### `IntegrationService` — protected, `@(path: '/api')`
Requires an authenticated user (XSUAA). Handles all admin/setup operations.

| Operation | Type | Description |
|---|---|---|
| `Tokens`, `Users`, `Config` | Entities (projections) | Read access to stored state. |
| `exchangeToken(code)` | Function | Exchanges the OAuth authorization code for DocuSign tokens (auth-code grant), stores tokens + user profile. |
| `getTenantId()` | Function | Returns the caller's tenant (subscriber) ID so the UI can build the tenant-specific webhook URL. |
| `saveAppConfig(...)` | Action | Persists environment, auth server, Client ID, Client Secret, and selected Account ID. |
| `logout()` | Action | Wipes all tokens, user info, and config. |

#### `WebhookService` + tenant-aware webhook route — public, unauthenticated
SuccessFactors Integration Center calls an **unauthenticated** endpoint, so it carries no login/tenant token. To still target the right subscriber, the app exposes a **tenant-aware webhook** whose URL contains the tenant ID:

```
POST /webhook/tenant/<tenantId>/trigger
```

The handler runs the trigger logic inside that tenant's context (`cds.tx({ tenant })`), so it reads **that customer's** DocuSign token/config from **their** HDI container and triggers Maestro on their behalf.

| Operation | Type | Description |
|---|---|---|
| `POST /webhook/tenant/<id>/trigger` | HTTP route | Tenant-scoped trigger used by Integration Center. `workflowId` required; other properties forwarded as Maestro input variables. |
| `triggerMaestroWorkflow(data)` | OData action (`/webhook`) | Same logic for authenticated/same-tenant callers; retained for compatibility. |

The shared trigger logic lives in `srv/lib/maestro.js` and is reused by both entry points.

### 3.3 Persistence (SAP HANA — HDI containers)
Each subscribed tenant gets its own isolated HDI container, provisioned automatically by the MTX sidecar on subscription (see [§7 Data Persistence](#7-data-persistence-model)).

| Entity | Key fields | Purpose |
|---|---|---|
| `DocuSignTokens` | `accessToken`, `refreshToken`, `expiresAt` (LargeString) | Stores the OAuth tokens. `LargeString` avoids JWT truncation. |
| `UserInfo` | `sub`, `name`, `email`, `accounts` | DocuSign user profile + available accounts (JSON). |
| `AppConfig` | `clientId`, `clientSecret`, `environment`, `authServer`, `accountId` | App configuration + user-supplied client credentials. Singleton row `ID = '1'`. |

### 3.4 XSUAA (`docusign-sf-integration-auth`)
- Managed `xsuaa` service (plan `application`), **`tenant-mode: shared`** (required for SaaS subscriptions).
- Secures the App Router and the `/api` routes of the backend, and carries the tenant identity.

### 3.5 MTX Sidecar (`docusign-sf-integration-mtx`)
- Runs `@sap/cds-mtxs`. Handles **tenant lifecycle**: on subscribe it provisions a fresh **HANA HDI container** for that customer and deploys the schema; on unsubscribe it cleans up.
- Also runs schema **upgrades** across all tenants on redeploy.

### 3.6 SaaS Registry (`docusign-sf-integration-registry`)
- Registers the app in the BTP **marketplace** so other subaccounts can **subscribe** to it, and wires subscription callbacks to the MTX sidecar.

### 3.7 Service Manager (`docusign-sf-integration-db`)
- The `service-manager` instance the MTX sidecar uses to create the **per-tenant HDI containers** on the shared HANA Cloud database.

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

Once a customer has connected DocuSign and selected an account, SuccessFactors can trigger workflows using that customer's **own tenant-specific URL** (copied from the Home page).

### Endpoint (per tenant)
```
POST https://<tenant-subdomain>-dsf-b67584fctrial.cfapps.ap21.hana.ondemand.com/webhook/tenant/<tenantId>/trigger
Content-Type: application/json

{
  "workflowId": "<maestro-workflow-id>",
  "employeeName": "John Doe",
  "email": "john.doe@example.com"
}
```
- `workflowId` is the only required field; every other property (any name/value SuccessFactors sends) is forwarded to the Maestro workflow as an input variable.
- Public (auth `none`), CSRF disabled — suitable for configuration in **SAP SuccessFactors Integration Center** as an outbound REST destination.
- The `<tenantId>` in the URL is what tells the app **which customer's** DocuSign token to use.

### Processing logic (tenant-scoped)
1. Extract `<tenantId>` from the URL and run everything inside that tenant's context (`cds.tx({ tenant })`), so all reads/writes hit **that customer's** HDI container.
2. Validate `workflowId` is present (else `400`).
3. Read the stored token (`DocuSignTokens`) and selected account (`AppConfig.accountId`).
   - If no token → `400` "App not authenticated".
   - If no account → `400` "App not configured".
4. **Refresh the access token on every call.** `POST {authServer}/oauth/token` with `grant_type=refresh_token` and HTTP Basic auth (`base64(clientId:clientSecret)`). The new `access_token`, (rotated) `refresh_token`, and recomputed `expiresAt` are persisted back. If the refresh fails → `401` "DocuSign session expired".
5. Build the Maestro payload: an auto-generated `instanceName` and `inputVariables` = every payload property other than `workflowId` (type inferred; nested objects are JSON-stringified).
6. Resolve the **partner-integrations host from the saved environment** (must match the token's issuer environment, otherwise DocuSign returns `Jwt issuer is not configured`):
   - Stage: `https://services.stage.docusign.net`
   - Demo: `https://services.demo.docusign.net`
   - Production: `https://services.docusign.net`
7. `POST {host}/partner-integrations/v1.0/accounts/{accountId}/maestro-workflows/trigger/{workflowId}` with `Authorization: Bearer {accessToken}`.
8. On success → `"Workflow triggered successfully"`. On failure → `500` including the underlying DocuSign error message.

### Sequence Diagram — Workflow Trigger

```
SuccessFactors    App Router (/webhook, none)    CAP Backend (tenant tx)    DocuSign
      │                    │                             │                    │
      │ POST /webhook/tenant/<id>/trigger ──────────────▶│                    │
      │                    │                             │ switch to tenant   │
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

| Module / Resource | Type | Purpose |
|---|---|---|
| `docusign-sf-integration-srv` | nodejs | CAP backend (business logic + tenant-aware webhook). |
| `docusign-sf-integration-approuter` | approuter.nodejs | Serves UI, routes traffic; short custom host for tenant URLs. |
| `docusign-sf-integration-mtx` | nodejs | MTX sidecar — onboards tenants, provisions per-tenant HDI, runs upgrades. |
| `docusign-sf-integration-auth` | xsuaa (shared) | Security + tenant identity. |
| `docusign-sf-integration-registry` | saas-registry | Makes the app subscribable in the BTP marketplace. |
| `docusign-sf-integration-db` | service-manager | Creates the per-tenant HANA HDI containers. |
| `docusign-hana` | HANA Cloud | The shared database that holds all tenant containers. |

Build pipeline: `npm ci` → `npx cds build --production` → package modules → generate `.mtar`.

**Provider endpoints (dev space):**
- App Router (short host): `https://dsf-b67584fctrial.cfapps.ap21.hana.ondemand.com`
- Per-tenant URL pattern: `https://<subscriber-subdomain>-dsf-b67584fctrial.cfapps.ap21.hana.ondemand.com`
- Redirect URI (registry + auth-code): `<app-router>/callback.html`

> **Trial note:** on the shared trial domain, each new subscriber currently needs a one-time `cf map-route`. In production, a single **wildcard route on a custom domain** makes new subscriptions resolve automatically.

---

## 7. Data Persistence Model

- The `db` is configured as **SAP HANA** (`kind: hana`) in all profiles — there is no SQLite anymore.
- **Production:** the MTX sidecar provisions one **isolated HDI container per subscribed tenant**; schema is deployed automatically on subscription.
- **Local/hybrid development:** the runtime binds to a dedicated HDI container via `cds bind`, and the schema is deployed with `cds deploy --to hana --profile hybrid`. Run the app with `cds watch --profile hybrid`.
- **Consequence:** all state (tokens, user info, config) is **persistent** and survives app restarts and redeploys, and supports refresh-token rotation.
- No custom `srv/server.js` bootstrap is needed; CAP's default server is used.

---

## 8. Security Considerations

| Area | Current state | Recommendation |
|---|---|---|
| Client secrets | User-supplied, stored per-tenant in `AppConfig` (no secrets in source). | Encrypt at rest / use SAP Credential Store. |
| Webhook endpoint | Public, unauthenticated, tenant ID in URL. | Add a per-tenant shared secret / HMAC header; optional IP allow-listing for SuccessFactors. |
| Token storage | `LargeString` columns in each tenant's HANA container; refreshed on every trigger. | Consider column encryption. |
| Tenant isolation | Each subscriber has its **own** HDI container; webhook runs in `cds.tx({ tenant })`. | Keep; add automated isolation tests. |
| Scopes | Least-privilege (`signature`, `aow_manage`). | Keep minimal; review per use case. |
| UI/API access | XSUAA-protected (`tenant-mode: shared`). | Add role collections for admin-only setup. |

---

## 9. Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js on Cloud Foundry (SAP BTP) |
| Application framework | SAP CAP (`@sap/cds` v9) |
| Security | XSUAA (`@sap/xssec`), App Router (`@sap/approuter`) |
| Persistence | SAP HANA Cloud — one isolated HDI container per tenant (`@cap-js/hana`) |
| Multitenancy | `@sap/cds-mtxs` (MTX sidecar), SaaS Registry, Service Manager |
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
7. **Multitenant SaaS (single deployment, isolated tenants)** — one running app serves many customers; each subscriber gets its own HANA HDI container, so their DocuSign credentials, tokens and config never mix. This is cheaper and easier to operate than one deployment per customer.
8. **Tenant ID in the webhook URL** — because the webhook is unauthenticated, there is no logged-in user to derive the tenant from. Putting the tenant ID in the path (`/webhook/tenant/<id>/trigger`) and running the logic in `cds.tx({ tenant })` guarantees the call reads/writes the *right* customer's data.
9. **Shared trigger logic (`srv/lib/maestro.js`)** — the interactive service and the public webhook both need identical refresh-and-trigger behaviour, so it lives in one module reused by both.
10. **HANA everywhere (no SQLite)** — local/hybrid dev binds to a real HDI container so development matches production exactly, avoiding "works locally, breaks in HANA" surprises.
11. **Short App Router host (`dsf-...`)** — tenant URLs prepend the subscriber subdomain; a shorter base host keeps the full hostname under the 63-character DNS limit.
