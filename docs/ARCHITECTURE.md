# Architecture & Product Design
## DocuSign – SAP SuccessFactors Integration

| | |
|---|---|
| **Version** | 1.0.0 |
| **Platform** | SAP Business Technology Platform (BTP), Cloud Foundry |
| **Framework** | SAP Cloud Application Programming Model (CAP), Node.js |
| **Delivery** | Single-tenant — deployed per customer in their BTP subaccount |
| **Last Updated** | July 2026 |

---

## 1. What This Application Does

This application is a **connector between SAP SuccessFactors and DocuSign Maestro**. It allows an HR administrator to:

1. **Connect their DocuSign account** through a self-service guided UI (no developer involvement needed after deployment).
2. **Get a ready-to-use webhook URL** that they paste into SuccessFactors Integration Center.
3. **Automatically trigger DocuSign Maestro workflows** whenever an HR event fires in SuccessFactors (e.g. new hire, promotion, termination).

The end result: an employee lifecycle event in SuccessFactors automatically kicks off a document workflow in DocuSign — offer letters, NDAs, benefits enrollment — without manual intervention.

---

## 2. The Problem We Solve

Today, connecting SuccessFactors to DocuSign requires either:
- Custom middleware development (expensive, per-customer effort), or
- Manual document sending (slow, error-prone, doesn't scale).

This app eliminates both by providing a **zero-code bridge**. The admin connects DocuSign once, pastes a URL into Integration Center, and the system handles authentication, token refresh, and workflow triggering automatically from that point forward.

---

## 3. How Customers Use the Application

### Personas

| Persona | Role |
|---|---|
| **Customer Admin** | SuccessFactors / BTP administrator who sets up the integration once. |
| **SuccessFactors (system)** | Fires HR events that trigger the webhook automatically. |
| **DocuSign Maestro** | Executes the document workflow (e-signatures, approvals, routing). |

### User Journey (one-time setup, ~10 minutes)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     ADMIN SETUP (one time)                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Step 1: Generate Credentials                                       │
│  ─────────────────────────────                                      │
│  Admin selects their DocuSign environment (Demo / Production).      │
│  Clicks "Open OAuth Registry" → DocuSign opens in a new tab.       │
│  Admin creates an integration → gets a Client ID and Secret.        │
│                                                                     │
│  Step 2: Save Credentials                                           │
│  ────────────────────────                                           │
│  Admin pastes Client ID and Secret into the app.                    │
│  Clicks "Save" → credentials are stored securely on BTP.            │
│                                                                     │
│  Step 3: Login with DocuSign                                        │
│  ───────────────────────────                                        │
│  Admin clicks "Login" → redirected to DocuSign consent screen.      │
│  Grants access → redirected back → app stores OAuth tokens.         │
│  Admin selects which DocuSign account to use.                       │
│                                                                     │
│  Step 4: Configure SuccessFactors                                   │
│  ────────────────────────────────                                   │
│  App displays a webhook URL and sample JSON body.                   │
│  Admin copies these into Integration Center as an outbound REST     │
│  destination. Done.                                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### After Setup (fully automatic)

```
SuccessFactors Event (e.g. "New Hire")
         │
         ▼
Integration Center fires POST to webhook URL
         │
         ▼
App receives the call → refreshes DocuSign token → triggers Maestro
         │
         ▼
DocuSign Maestro executes the workflow (send offer letter, collect signature, etc.)
```

No human action required after the initial setup. The app handles token refresh transparently.

---

## 4. How We Deliver This Application

### Delivery Model: Per-Customer Deployment

The app is deployed **into the customer's own BTP subaccount**. This means:

- Each customer has their **own isolated instance** — no shared infrastructure between customers.
- Credentials and tokens live only in that customer's BTP space.
- The customer (or we on their behalf) controls the deployment lifecycle.

### Deployment Options

| Option | Who deploys | Best for |
|---|---|---|
| **Customer self-service** | Customer's BTP admin runs `cf deploy` | Customers with BTP expertise |
| **Partner-assisted** | We deploy into customer's subaccount (with access) | Most customers |
| **Managed service** | We host and operate on our own BTP account per customer | Enterprise customers wanting hands-off |

### What Gets Deployed

A single Multi-Target Application (MTA) archive containing:

| Component | Purpose |
|---|---|
| **App Router** | Serves the admin UI and routes API traffic |
| **CAP Backend** | Business logic: OAuth flow, token management, webhook handling |
| **Destination Service** (BTP managed) | Secure storage for credentials and tokens |
| **XSUAA** (BTP managed) | Keeps the CDS runtime happy on Cloud Foundry |

No database required. No HANA. The Destination Service acts as a lightweight key-value store for the small amount of state this app needs (credentials, tokens, selected account).

---

## 5. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│              Customer's BTP Subaccount (Cloud Foundry)           │
│                                                                 │
│  ┌──────────────┐         ┌──────────────────────┐              │
│  │  App Router  │  /api   │    CAP Backend       │              │
│  │              │────────▶│                      │              │
│  │  Serves UI   │         │  • OAuth flow        │              │
│  │  Routes /api │         │  • Token management  │              │
│  │  Routes /web-│  /web-  │  • Webhook handler   │              │
│  │    hook      │──hook──▶│  • Maestro trigger   │              │
│  └──────────────┘         └──────────┬───────────┘              │
│                                      │                          │
│                            ┌─────────▼──────────┐               │
│                            │ Destination Service │               │
│                            │ (credential store)  │               │
│                            └────────────────────┘               │
│                                                                 │
└───────────────────────────┬─────────────────┬───────────────────┘
                            │                 │
              ┌─────────────▼──┐       ┌──────▼──────────┐
              │ DocuSign       │       │ SAP             │
              │ • OAuth Server │       │ SuccessFactors  │
              │ • Maestro API  │       │ Integration     │
              │                │       │ Center          │
              └────────────────┘       └─────────────────┘
```

### Data Flow Summary

1. **Setup flow (admin → DocuSign):** Admin authenticates with DocuSign through the UI. OAuth tokens are stored in the Destination Service.

2. **Trigger flow (SuccessFactors → DocuSign):** Integration Center POSTs to the webhook. The app reads the stored token, refreshes it, and calls DocuSign Maestro API to trigger the workflow.

---

## 6. OAuth 2.0 Authentication Design

The app uses **Authorization Code Grant** — the standard OAuth flow for acting on behalf of a real user with their explicit consent.

### Why this grant type
- The app triggers workflows **as a specific DocuSign user** (the admin who logged in).
- The user explicitly consents to the scopes (`signature`, `aow_manage`).
- Refresh tokens allow long-lived access without re-authentication.

### Why user-supplied credentials
- The admin creates their **own** OAuth app in DocuSign's registry.
- No DocuSign secrets are hardcoded in our application.
- Each customer's credentials are isolated — revoking one doesn't affect others.
- The redirect URI is automatically set to the customer's deployed app URL.

### Token lifecycle

```
Initial Login:
  Auth Code → Access Token (short-lived) + Refresh Token (long-lived)
  Both stored in Destination Service.

On every webhook trigger:
  Refresh Token → New Access Token + New Refresh Token
  Old tokens replaced. If refresh fails → admin must re-login.
```

This "refresh on every call" strategy means the app never has stale tokens — at the cost of one extra HTTP call per trigger (negligible given Maestro API latency).

---

## 7. Webhook & Maestro Trigger Design

### The webhook endpoint

```
POST /webhook/trigger
Content-Type: application/json

{
  "workflowId": "abc123-def456",
  "employeeName": "Jane Smith",
  "email": "jane.smith@company.com",
  ...any other fields...
}
```

- **Public, unauthenticated** — SuccessFactors Integration Center doesn't support OAuth for outbound calls. The endpoint must be callable without a token.
- **`workflowId` is required** — tells the app which Maestro workflow to kick off.
- **All other fields are forwarded** as input variables to the Maestro workflow. The customer maps SuccessFactors fields in Integration Center; the app passes them through.

### What happens on trigger

1. Read stored credentials + tokens from the Destination Service.
2. Refresh the access token (exchange refresh token for new access + refresh).
3. Build the Maestro trigger payload with the provided input variables.
4. Call DocuSign's partner-integrations API to trigger the workflow.
5. Return success/failure to SuccessFactors.

### Environment resolution

The app supports three DocuSign environments. All URLs (OAuth and API) are derived from the environment the admin selected during setup:

| Environment | Auth Server | API Host |
|---|---|---|
| Stage | `account-s.docusign.com` | `services.stage.docusign.net` |
| Demo | `account-d.docusign.com` | `services.demo.docusign.net` |
| Production | `account.docusign.com` | `services.docusign.net` |

---

## 8. Persistence Strategy

### Why Destination Service (not a database)

The app stores very little state:
- Client ID, Client Secret
- Access Token, Refresh Token, Expiration
- Selected Environment, Account ID

This is a handful of string values — not relational data. Using the BTP Destination Service as a key-value store:
- Eliminates the need for HANA Cloud (cost savings).
- No schema migrations, no database provisioning.
- Data is encrypted at rest by the platform.
- Simplifies deployment (fewer BTP services to provision).

### How it works

All state is stored as properties of a single "destination" entry named `docusign` in the Destination Service. The app's persistence layer reads/writes this entry through the Destination Configuration REST API using a service-to-service OAuth token (client credentials grant against the Destination Service binding).

---

## 9. Integration Center Configuration (Customer Side)

Once the app is set up, the customer configures SuccessFactors Integration Center:

1. **Create an outbound integration** (type: REST / More Object Types).
2. **Set the URL** to the webhook URL shown in the app's home page.
3. **Set the method** to POST and Content-Type to `application/json`.
4. **Map the body** — include the `workflowId` (fixed) and any employee fields the Maestro workflow needs.
5. **Configure the trigger** — choose which HR event fires the integration (new hire, termination, etc.).

No authentication headers needed. No certificates. Just a URL and a JSON body.

---

## 10. Security Design

| Concern | How it's handled |
|---|---|
| **Credential isolation** | Each customer's credentials live only in their own BTP space. No shared storage. |
| **No hardcoded secrets** | Customer brings their own Client ID/Secret from DocuSign's registry. |
| **Token storage** | Stored in BTP Destination Service (platform-managed, encrypted at rest). |
| **Admin UI access** | Currently unprotected (accessible to anyone with the URL). XSUAA is bound only because the CDS runtime on Cloud Foundry requires it to start — it does not enforce authentication on any route. See "Future security enhancements" below. |
| **Webhook (public)** | Unauthenticated by design (Integration Center limitation). Mitigated by: the webhook only triggers workflows — it can't read or exfiltrate data. |
| **Least-privilege scopes** | Only `signature` and `aow_manage` are requested — minimum needed for Maestro triggers. |
| **Token refresh** | Tokens are rotated on every use. A compromised access token expires within minutes. |

### Future security enhancements (not yet implemented)
- HMAC signature verification on webhook calls (shared secret between SF and app).
- IP allowlisting for SuccessFactors outbound IPs.
- Admin role-based access (restrict who can reconfigure credentials).

---

## 11. Key Design Decisions

| Decision | Rationale |
|---|---|
| **Single-tenant (not SaaS)** | Simpler to deploy, no multitenancy overhead, stronger isolation. Each customer gets their own app instance. |
| **Destination Service as storage** | The app stores ~6 string values. A full database (HANA) is overkill and expensive. |
| **User-supplied OAuth credentials** | Makes the app distributable without embedding secrets. Each customer controls their own DocuSign integration. |
| **Authorization Code Grant** | Acts on behalf of a real user with consent. Supports refresh tokens for long-lived access. |
| **Refresh on every trigger** | Avoids expired-token failures without complex scheduling. One extra HTTP call per trigger is negligible. |
| **Public webhook** | SuccessFactors Integration Center doesn't support outbound OAuth. The webhook must be callable without auth headers. |
| **Environment-aware URL resolution** | Auth server and API host are derived from the selected environment, preventing cross-environment token mismatches. |
| **No MTX / no HANA / no SaaS Registry** | Removed complexity that wasn't needed for the single-tenant model. Fewer BTP services = lower cost + simpler operations. |

---

## 12. Distribution & Customer Setup

### How We Deliver the Application

We distribute the app as a **pre-built MTA archive** (`.mtar` file). The customer deploys it into their own BTP subaccount. No source code access required.

```
┌──────────────────┐          ┌─────────────────────────────────────────┐
│   We (provider)  │          │       Customer's BTP Subaccount         │
│                  │  .mtar   │                                         │
│  Build the app   │─────────▶│  Deploy with cf deploy                  │
│  Deliver .mtar   │          │  App is running in their own space      │
│                  │          │  Open the app URL → guided setup wizard │
└──────────────────┘          └─────────────────────────────────────────┘
```

### Distribution Channels

| Channel | How it works | When to use |
|---|---|---|
| **Direct handoff** | We send the `.mtar` file + a one-page setup guide to the customer. | Known customers, pilot phase. |
| **Partner portal / download site** | Customer downloads the latest `.mtar` from a private portal. | Scaling to more customers without one-to-one handoff. |
| **SAP BTP Marketplace (future)** | Requires converting to multitenant SaaS + SAP PartnerEdge certification. Customers subscribe with one click. | Mass market, self-service onboarding at scale. |

### What the Customer Needs (Prerequisites)

Before deploying, the customer must have:

1. **SAP BTP account** with Cloud Foundry environment enabled.
2. **Cloud Foundry space** with at least ~512 MB memory quota available.
3. **Cloud Foundry CLI** (`cf`) installed with the MultiApps plugin.
4. **A DocuSign account** (Demo or Production) where they can create an OAuth integration.
5. **SAP SuccessFactors** with Integration Center access (for the webhook setup — not needed for initial deployment).

### Customer Deployment Steps

```
Step 1: Deploy the app (BTP admin, ~5 minutes)
──────────────────────────────────────────────
  $ cf login -a <api-endpoint>
  $ cf deploy docusign-sf-integration_1.0.0.mtar

  → BTP provisions the Destination Service and XSUAA automatically.
  → App Router and Backend start running.
  → The admin gets a URL like:
    https://<org>-<space>-docusign-sf-integration-approuter.cfapps.<region>.hana.ondemand.com


Step 2: Connect DocuSign (HR admin, ~5 minutes)
───────────────────────────────────────────────
  Open the app URL in a browser → guided 3-step wizard:
    1. Select environment (Demo/Production) → Open DocuSign Registry → create integration → get Client ID/Secret.
    2. Paste Client ID + Secret → Save.
    3. Click Login → authorize on DocuSign → select account.

  → App is now connected. The home page shows a webhook URL.


Step 3: Configure SuccessFactors (HR admin, ~10 minutes)
────────────────────────────────────────────────────────
  In SuccessFactors → Admin Center → Integration Center:
    1. Create a new outbound REST integration.
    2. Paste the webhook URL from the app's home page.
    3. Set method to POST, Content-Type: application/json.
    4. Map the body: include workflowId + any employee fields.
    5. Set the trigger event (e.g. New Hire).
    6. Activate.

  → Done. HR events now automatically trigger DocuSign Maestro workflows.
```

### After Deployment — What the Customer Manages

| Task | Frequency | How |
|---|---|---|
| **Nothing (day-to-day)** | — | Token refresh is automatic. No manual intervention needed. |
| **Re-login** | Rare (only if DocuSign revokes the refresh token) | Open app URL → Login again. |
| **App updates** | When we release a new version | We provide new `.mtar` → customer runs `cf deploy` again. State persists. |
| **Uninstall** | If no longer needed | `cf undeploy docusign-sf-integration --delete-services` |

### Future: SAP Store Distribution (Multitenant SaaS)

To list on the SAP BTP marketplace for one-click customer subscriptions, the app would need to be converted to multitenant SaaS:

- Add SAP HANA Cloud (per-tenant HDI containers for data isolation).
- Add MTX sidecar (tenant provisioning on subscribe).
- Add SaaS Registry (makes the app subscribable from other subaccounts).
- Add Service Manager (creates per-tenant database containers).
- Change XSUAA to `tenant-mode: shared`.
- Join SAP PartnerEdge program and pass certification.

This is a significant evolution but follows a well-documented SAP pattern. The current single-tenant architecture is the right starting point — it validates the product before investing in SaaS infrastructure.

---

## 13. Operational Model

### Build & Deploy (our side)
```
npm ci → mbt build → delivers docusign-sf-integration_1.0.0.mtar
```

### Monitoring (customer side)
- Application logs via `cf logs <app-name> --recent`
- All errors include the operation context (which step failed)
- Token refresh failures are logged — indicates the admin needs to re-login

### Maintenance
- **Token rotation is automatic** — no scheduled jobs needed.
- **App updates** — we provide new `.mtar`; customer redeploys. State in Destination Service persists across deploys.
- **Re-authentication** — only needed if the refresh token is revoked (admin changed DocuSign password, or DocuSign invalidated the token).
