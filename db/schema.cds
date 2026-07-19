namespace my.docusign.integration;

entity DocuSignTokens {
    key ID : UUID;
    // DocuSign access/refresh tokens are JWTs that frequently exceed 2000
    // characters. Storing them in a too-small column silently TRUNCATES them,
    // and DocuSign then rejects the truncated Bearer token with
    // "Jwt payload is an invalid JSON". Use LargeString to avoid truncation.
    accessToken : LargeString;
    refreshToken : LargeString;
    expiresAt : DateTime;
}

// NEW: Stores the user profile and their available accounts
entity UserInfo {
    key ID : UUID;
    sub : String;
    name : String;
    email : String;
    accounts : LargeString; // We will store the accounts array as a JSON string for easy retrieval
}

// NEW: Stores the app's global configuration
entity AppConfig {
    key ID : String default '1';
    accountId : String;
    environment : String;
    authServer : String;
    // DocuSign integration (client) credentials the user copies from the
    // OAuth registry and pastes into the app. Used for the authorization-code
    // grant flow (token exchange), so no secrets are hardcoded in the app.
    clientId : String;
    clientSecret : String;
}