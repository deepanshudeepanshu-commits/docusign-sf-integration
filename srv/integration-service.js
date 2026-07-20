const cds = require('@sap/cds');
const axios = require('axios');
const store = require('./lib/store');
const { resolveEnv } = require('./lib/environments');

module.exports = cds.service.impl(async function () {

    this.on('saveAppConfig', async (req) => {
        const { accountId, accountName, environment, clientId, clientSecret } = req.data;

        // Only persist fields that were actually provided, so a partial update
        // (e.g. only the account) doesn't wipe existing values.
        const patch = {};
        if (accountId !== undefined) patch.accountId = accountId;
        if (accountName !== undefined) patch.accountName = accountName;
        if (environment !== undefined) {
            patch.environment = environment;
            // Keep the destination URL meaningful for the chosen environment.
            patch.URL = resolveEnv(environment).partnerHost;
        }
        if (clientId !== undefined) patch.clientId = clientId;
        if (clientSecret !== undefined) patch.clientSecret = clientSecret;

        try {
            await store.write(patch);
            return 'App configuration saved successfully!';
        } catch (error) {
            console.error('Error saving app configuration:', error.response?.data || error.message);
            return req.reject(500, 'Failed to save app configuration.');
        }
    });

    this.on('exchangeToken', async (req) => {
        console.log('=== EXCHANGING DOCUSIGN AUTH CODE ===');
        const authCode = req.data.code;

        const config = await store.read();
        if (!config || !config.clientId || !config.clientSecret) {
            return req.reject(400, 'Missing DocuSign client credentials. Please save your Client ID and Secret first.');
        }

        const env = resolveEnv(config.environment);

        try {
            const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

            const fwdHost = req.http?.req?.headers['x-forwarded-host'] || req.http?.req?.headers['host'];
            const fwdProto = req.http?.req?.headers['x-forwarded-proto'] || 'https';
            const redirectUri = `${fwdProto}://${fwdHost}/callback.html`;

            const tokenResponse = await axios.post(
                `${env.authServer}/oauth/token`,
                `grant_type=authorization_code&code=${encodeURIComponent(authCode)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
                {
                    headers: {
                        'Authorization': `Basic ${credentials}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            const accessToken = tokenResponse.data.access_token;
            const refreshToken = tokenResponse.data.refresh_token;
            const expiresIn = tokenResponse.data.expires_in;
            const expiresAt = expiresIn
                ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString()
                : '';

            await store.write({ accessToken, refreshToken, expiresAt });

            // Fetch the user profile + available accounts LIVE from DocuSign
            // (no UserInfo table needed) and return it to the UI.
            const userInfoResponse = await axios.get(`${env.authServer}/oauth/userinfo`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });

            const userInfo = userInfoResponse.data;
            await store.write({
                userName: userInfo.name || '',
                userEmail: userInfo.email || ''
            });

            return JSON.stringify(userInfo);
        } catch (error) {
            console.error('Token Exchange Error:', error.response?.data || error.message);
            return req.reject(500, 'Failed to exchange token or fetch user info.');
        }
    });

    this.on('getState', async () => {
        const config = (await store.read()) || {};
        const state = {
            configured: !!(config.clientId && config.clientSecret),
            authenticated: !!config.refreshToken,
            accountSelected: !!config.accountId,
            environment: config.environment || '',
            accountId: config.accountId || '',
            accountName: config.accountName || '',
            userName: config.userName || '',
            userEmail: config.userEmail || '',
            // clientId is safe to expose (needed by the UI to build the login
            // URL); the client secret and tokens are intentionally NOT returned.
            clientId: config.clientId || ''
        };
        return JSON.stringify(state);
    });

    this.on('logout', async (req) => {
        try {
            await store.remove();
            return 'Logged out successfully!';
        } catch (error) {
            console.error('Error during logout:', error.response?.data || error.message);
            return req.reject(500, 'Failed to log out.');
        }
    });
});
