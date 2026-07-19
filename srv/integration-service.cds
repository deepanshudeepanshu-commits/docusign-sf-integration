@open
service IntegrationService @(path: '/api') {

    // Exchanges the DocuSign authorization code for tokens (auth-code grant),
    // stores them in the Destination Service, and returns the live user profile
    // (fetched from DocuSign's /oauth/userinfo) so the UI can display it.
    @readonly
    function exchangeToken(code: String) returns LargeString;

    // Returns a small JSON status object used by the UI to decide routing and
    // to prefill the setup form. Never returns the client secret or tokens.
    @readonly
    function getState() returns LargeString;

    // Saves any subset of the configuration (environment, credentials, account)
    // into the Destination Service.
    action saveAppConfig(
        accountId: String,
        environment: String,
        clientId: String,
        clientSecret: String
    ) returns String;

    // Clears all stored state (deletes the destination).
    action logout() returns String;
}