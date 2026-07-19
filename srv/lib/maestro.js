'use strict';

const axios = require('axios');
const store = require('./store');
const { resolveEnv } = require('./environments');

/**
 * Small helper to create an Error carrying an HTTP status code so callers
 * (OData action handler or the raw Express webhook route) can translate it
 * into the right response.
 */
function httpError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

/**
 * Uses the stored refresh token to obtain a fresh DocuSign access token via the
 * OAuth `refresh_token` grant, persists the (possibly rotated) token set back
 * into the Destination Service, and returns the fresh access token.
 *
 * DocuSign rotates refresh tokens, so we always persist the newest one.
 */
async function refreshAccessToken(config) {
    if (!config.refreshToken) {
        throw new Error('No refresh token stored. Please log in again.');
    }
    if (!config.clientId || !config.clientSecret) {
        throw new Error('Missing client credentials. Please complete UI setup.');
    }

    const env = resolveEnv(config.environment);
    const tokenUrl = `${env.authServer}/oauth/token`;
    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

    console.log('=== REFRESHING DOCUSIGN ACCESS TOKEN ===');
    const tokenResponse = await axios.post(
        tokenUrl,
        `grant_type=refresh_token&refresh_token=${encodeURIComponent(config.refreshToken)}`,
        {
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }
    );

    const accessToken = tokenResponse.data.access_token;
    // DocuSign may return a rotated refresh token; keep the new one if present.
    const refreshToken = tokenResponse.data.refresh_token || config.refreshToken;
    const expiresIn = tokenResponse.data.expires_in;
    const expiresAt = expiresIn
        ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString()
        : '';

    await store.write({ accessToken, refreshToken, expiresAt });

    console.log('Access token refreshed. New expiry:', expiresAt);
    return accessToken;
}

/**
 * Core business logic: triggers a DocuSign Maestro workflow using the tokens
 * and configuration stored for this (single-tenant) deployment.
 *
 * `payload` must contain `workflowId`; any other properties are forwarded to
 * the Maestro workflow as input variables.
 */
async function triggerMaestro(payload) {
    const { workflowId, ...inputData } = payload || {};

    if (!workflowId) {
        throw httpError(400, 'Missing workflowId in the payload.');
    }

    const config = await store.read();

    if (!config || !config.refreshToken) {
        throw httpError(400, 'App not authenticated. Please connect DocuSign in the UI.');
    }

    if (!config.accountId) {
        throw httpError(400, 'App not configured. Missing selected DocuSign Account ID. Please complete UI setup.');
    }

    // Always exchange the refresh token for a fresh access token before
    // triggering, so we never rely on a possibly-expired stored token.
    let accessToken;
    try {
        accessToken = await refreshAccessToken(config);
    } catch (refreshErr) {
        console.error('Token refresh failed:', refreshErr.response?.data || refreshErr.message);
        throw httpError(401, 'DocuSign session expired and could not be refreshed. Please log in again.');
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
        instanceName: `SuccessFactors Triggered Workflow - ${new Date().toISOString()}`,
        inputVariables
    };

    const env = resolveEnv(config.environment);
    const docusignUrl = `${env.partnerHost}/partner-integrations/v1.0/accounts/${config.accountId}/maestro-workflows/trigger/${workflowId}`;

    try {
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
        throw httpError(500, `Failed to trigger Maestro workflow: ${details}`);
    }
}

module.exports = { triggerMaestro, refreshAccessToken, httpError };
