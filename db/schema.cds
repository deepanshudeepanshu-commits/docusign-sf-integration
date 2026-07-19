namespace my.docusign.integration;

// ---------------------------------------------------------------------------
// NO DATABASE.
//
// This app is a single-tenant deployment and stores its (tiny) state in the
// SAP BTP Destination Service instead of a database — see srv/lib/store.js.
// There are therefore no persistent CDS entities.
//
// The logical model kept in the single `docusign` destination is:
//
//   DocuSignSecrets   clientId, clientSecret          (destination credentials)
//   DocuSignTokens    accessToken, refreshToken, expiresAt
//   AppConfig         accountId, environment
//
// The `environment` value (stage | demo | production) is an enum whose
// auth-server and API hosts are derived in srv/lib/environments.js, so the
// auth server is never stored separately.
//
// The user profile (name/email/accounts) is NOT stored: it is fetched live
// from DocuSign's /oauth/userinfo endpoint using the access token.
// ---------------------------------------------------------------------------
