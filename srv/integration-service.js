const cds = require('@sap/cds');
const axios = require('axios');

module.exports = cds.service.impl(async function () {
    this.on('exchangeToken', async (req) => {        console.log('=== EXCHANGING DOCUSIGN AUTH CODE ===');
        const authCode = req.data.code;
        const { Tokens, Users, Config } = this.entities;

        const config = await SELECT.one.from(Config).where({ ID: '1' });

        if (!config || !config.clientId || !config.clientSecret) {
            return req.reject(400, 'Missing DocuSign client credentials. Please save your Client ID and Secret first.');
        }

        const authServer = config.authServer || 'https://account-d.docusign.com';

        try {
            const tokenUrl = `${authServer}/oauth/token`;
            const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

            const tokenResponse = await axios.post(tokenUrl, `grant_type=authorization_code&code=${authCode}`, {
                headers: {
                    'Authorization': `Basic ${credentials}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            const accessToken = tokenResponse.data.access_token;
            const refreshToken = tokenResponse.data.refresh_token;
            const expiresIn = tokenResponse.data.expires_in;
            const expiresAt = expiresIn
                ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString()
                : null;

            // Keep only the freshest token set.
            await DELETE.from(Tokens);
            await INSERT.into(Tokens).entries({
                ID: cds.utils.uuid(),
                accessToken: accessToken,
                refreshToken: refreshToken,
                expiresAt: expiresAt
            });

            // Fetch the user profile + available accounts.
            const userInfoResponse = await axios.get(`${authServer}/oauth/userinfo`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });

            const userInfo = userInfoResponse.data;

            await DELETE.from(Users);
            await INSERT.into(Users).entries({
                ID: cds.utils.uuid(),
                sub: userInfo.sub,
                name: userInfo.name,
                email: userInfo.email,
                accounts: JSON.stringify(userInfo.accounts)
            });

            return JSON.stringify(userInfo);

        } catch (error) {
            console.error("Token Exchange Error:", error.response?.data || error.message);
            return req.reject(500, "Failed to exchange token or fetch user info.");
        }
    });

    this.on('saveAppConfig', async (req) => {
        const { accountId, environment, authServer, clientId, clientSecret } = req.data;
        const { Config } = this.entities;

        try {
            // Only include fields that were actually provided, so a partial
            // update (e.g. only credentials) doesn't wipe existing values.
            const changes = {};
            if (accountId !== undefined) changes.accountId = accountId;
            if (environment !== undefined) changes.environment = environment;
            if (authServer !== undefined) changes.authServer = authServer;
            if (clientId !== undefined) changes.clientId = clientId;
            if (clientSecret !== undefined) changes.clientSecret = clientSecret;

            const existing = await SELECT.one.from(Config).where({ ID: '1' });
            if (existing) {
                await UPDATE(Config).set(changes).where({ ID: '1' });
            } else {
                await INSERT.into(Config).entries({ ID: '1', ...changes });
            }
            return "App configuration saved successfully!";
        } catch (error) {
            console.error("Error saving app configuration:", error);
            return req.reject(500, "Failed to save app configuration.");
        }
    });

    this.on('getTenantId', async (req) => {
        // In an authenticated /api request, req.tenant is the subscriber's
        // (subaccount) tenant id. The UI uses it to build the tenant-specific
        // SuccessFactors webhook URL.
        return req.tenant || (cds.context && cds.context.tenant) || '';
    });

    this.on('logout', async (req) => {
        const { Tokens, Users, Config } = this.entities;
        try {
            // Wipe all stored state so a fresh login flow can begin.
            await DELETE.from(Tokens);
            await DELETE.from(Users);
            await DELETE.from(Config);
            return "Logged out successfully!";
        } catch (error) {
            console.error("Error during logout:", error);
            return req.reject(500, "Failed to log out.");
        }
    });
});