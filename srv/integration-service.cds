using { my.docusign.integration as my } from '../db/schema';

service IntegrationService @(path: '/api') {
    entity Tokens as projection on my.DocuSignTokens;
    entity Users as projection on my.UserInfo;
    entity Config as projection on my.AppConfig;

    @readonly
    function exchangeToken(code: String) returns LargeString;

    // Returns the current tenant (subscriber subaccount) ID, so the UI can
    // build the tenant-specific SuccessFactors webhook URL.
    function getTenantId() returns String;

    action saveAppConfig(
        accountId: String,
        environment: String,
        authServer: String,
        clientId: String,
        clientSecret: String
    ) returns String;

    action logout() returns String;
}