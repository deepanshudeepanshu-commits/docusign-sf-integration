'use strict';

/**
 * Environment enum for DocuSign.
 *
 * Only the environment NAME (stage | demo | production) is persisted; auth
 * server, partner-integrations host, and OAuth-registry URL are all derived
 * here. This guarantees the token's issuer environment always matches the API
 * host used (avoiding "Jwt issuer is not configured" errors).
 */

const ENVIRONMENTS = {
    stage: {
        authServer: 'https://account-s.docusign.com',
        partnerHost: 'https://services.stage.docusign.net',
        registryUrl: 'https://apps-s.docusign.com/oauth-registry?integrationType=sap'
    },
    demo: {
        authServer: 'https://account-d.docusign.com',
        partnerHost: 'https://services.demo.docusign.net',
        registryUrl: 'https://apps-d.docusign.com/oauth-registry?integrationType=sap'
    },
    production: {
        authServer: 'https://account.docusign.com',
        partnerHost: 'https://services.docusign.net',
        registryUrl: 'https://apps.docusign.com/oauth-registry?integrationType=sap'
    }
};

function resolveEnv(name) {
    return ENVIRONMENTS[name] || ENVIRONMENTS.demo;
}

module.exports = { resolveEnv, ENVIRONMENTS };
