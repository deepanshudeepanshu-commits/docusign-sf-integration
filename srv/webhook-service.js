const cds = require('@sap/cds');
const axios = require('axios');

const TOKENS = 'my.docusign.integration.DocuSignTokens';
const CONFIG = 'my.docusign.integration.AppConfig';

/**
 * Uses the stored refresh token to obtain a fresh DocuSign access token via the
 * OAuth `refresh_token` grant, persists the new token set, and returns the
 * fresh access token.
 *
 * Throws if credentials/refresh token are missing or DocuSign rejects the call.
 */
async function refreshAccessToken(tokenRecord, configRecord) {
    if (!tokenRecord.refreshToken) {
        throw new Error('No refresh token stored. Please log in again.');
    }
    if (!configRecord.clientId || !configRecord.clientSecret) {
        throw new Error('Missing client credentials. Please complete UI setup.');
    }

    const authServer = configRecord.authServer || 'https://account-d.docusign.com';
    const tokenUrl = `${authServer}/oauth/token`;
    const credentials = Buffer.from(`${configRecord.clientId}:${configRecord.clientSecret}`).toString('base64');

    console.log('=== REFRESHING DOCUSIGN ACCESS TOKEN ===');
    const tokenResponse = await axios.post(
        tokenUrl,
        `grant_type=refresh_token&refresh_token=${encodeURIComponent(tokenRecord.refreshToken)}`,
        {
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }
    );

    const accessToken = tokenResponse.data.access_token;
    // DocuSign may return a rotated refresh token; keep the new one if present.
    const refreshToken = tokenResponse.data.refresh_token || tokenRecord.refreshToken;
    const expiresIn = tokenResponse.data.expires_in;
    const expiresAt = expiresIn
        ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString()
        : null;

    await UPDATE(TOKENS)
        .set({ accessToken, refreshToken, expiresAt })
        .where({ ID: tokenRecord.ID });

    console.log('Access token refreshed. New expiry:', expiresAt);
    return accessToken;
}

module.exports = cds.service.impl(async function () {

    this.on('triggerMaestroWorkflow', async (req) => {
        console.log('=== SUCCESSFACTORS EVENT RECEIVED ===');
        const payload = req.data?.data || {};
        const { workflowId, ...inputData } = payload;

        if (!workflowId) {
            return req.reject(400, 'Missing workflowId in the payload.');
        }

        const tokenRecord = await SELECT.one.from(TOKENS);
        const configRecord = await SELECT.one.from(CONFIG).where({ ID: '1' });

        if (!tokenRecord) {
            return req.reject(400, 'App not authenticated. Missing DocuSign tokens.');
        }

        if (!configRecord || !configRecord.accountId) {
            return req.reject(400, 'App not configured. Missing selected DocuSign Account ID. Please complete UI setup.');
        }

        try {
            // Always exchange the refresh token for a fresh access token before
            // triggering, so we never rely on a possibly-expired stored token.
            let accessToken;
            try {
                accessToken = await refreshAccessToken(tokenRecord, configRecord);
            } catch (refreshErr) {
                console.error('Token refresh failed:', refreshErr.response?.data || refreshErr.message);
                return req.reject(401, 'DocuSign session expired and could not be refreshed. Please log in again.');
            }

            const inputVariables = Object.entries(inputData)
                .filter(([, value]) => value !== undefined && value !== null)
                .map(([propertyName, value]) => {
                    let type = 'string';
                    let normalized = value;
                    if (typeof value === 'number') {
                        type = 'number';
                    } else if (typeof value === 'boolean') {
                        type = 'boolean';
                    } else if (typeof value === 'object') {
                        normalized = JSON.stringify(value);
                    }
                    return { propertyName, type, value: normalized };
                });

            const maestroPayload = {
                instanceName: `BAS Triggered Workflow - ${new Date().toISOString()}`,
                inputVariables
            };

            const partnerHosts = {
                stage: 'https://services.stage.docusign.net',
                demo: 'https://services.demo.docusign.net',
                production: 'https://services.docusign.net'
            };
            const partnerHost = partnerHosts[configRecord.environment] || partnerHosts.demo;

            const docusignUrl = `${partnerHost}/partner-integrations/v1.0/accounts/${configRecord.accountId}/maestro-workflows/trigger/${workflowId}`;

            const response = await axios.post(docusignUrl, maestroPayload, {
                headers: {
                    'Accept': 'text/plain',
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            console.log('Maestro Triggered Successfully:', response.data);
            return 'Workflow triggered successfully';

        } catch (error) {
            console.error('Maestro Trigger Error:', error.response?.data || error.message);
            const details = error.response?.data
                ? (typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data))
                : error.message;
            return req.reject(500, `Failed to trigger Maestro workflow: ${details}`);
        }
    });
});
