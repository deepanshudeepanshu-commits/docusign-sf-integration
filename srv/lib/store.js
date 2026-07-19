'use strict';

/**
 * Persistence layer — SAP BTP Destination Service.
 *
 * All application state (DocuSign credentials, tokens, and config) is stored in
 * a single instance-level destination named "docusign". This module provides a
 * simple read / write / remove abstraction over the Destination Configuration
 * REST API.
 *
 * The Destination Service must be bound to the CAP backend (see mta.yaml,
 * resource `docusign-sf-integration-destination`).
 */

const axios = require('axios');

const DEST_NAME = 'docusign';

let _credentials = null;

/**
 * Reads the Destination Service binding credentials from VCAP_SERVICES.
 */
function getCredentials() {
    if (_credentials) return _credentials;

    const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
    const destInstances = vcap.destination || [];
    if (destInstances.length === 0) {
        throw new Error(
            'Destination service not bound. Ensure docusign-sf-integration-destination is bound in mta.yaml.'
        );
    }
    _credentials = destInstances[0].credentials;
    return _credentials;
}

/**
 * Obtains an OAuth2 client-credentials token for the Destination Service API.
 */
async function getServiceToken() {
    const creds = getCredentials();
    const tokenUrl = `${creds.url}/oauth/token`;

    const response = await axios.post(
        tokenUrl,
        'grant_type=client_credentials',
        {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            auth: { username: creds.clientid, password: creds.clientsecret }
        }
    );
    return response.data.access_token;
}

/**
 * Reads the `docusign` destination. Returns the destination properties as a
 * flat object, or `null` if the destination does not yet exist.
 */
async function read() {
    const creds = getCredentials();
    const token = await getServiceToken();
    const url = `${creds.uri}/destination-configuration/v1/instanceDestinations/${DEST_NAME}`;

    try {
        const response = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return response.data;
    } catch (err) {
        if (err.response && err.response.status === 404) {
            return null;
        }
        throw err;
    }
}

/**
 * Creates or updates the `docusign` destination with the given properties.
 * Only the keys present in `patch` are changed; existing keys are preserved.
 */
async function write(patch) {
    const creds = getCredentials();
    const token = await getServiceToken();
    const baseUrl = `${creds.uri}/destination-configuration/v1/instanceDestinations`;

    const existing = await read();

    const dest = {
        Name: DEST_NAME,
        Type: 'HTTP',
        URL: 'https://services.demo.docusign.net',
        Authentication: 'NoAuthentication',
        ProxyType: 'Internet',
        ...(existing || {}),
        ...patch
    };

    // Ensure mandatory destination fields are always set correctly.
    dest.Name = DEST_NAME;
    dest.Type = 'HTTP';
    dest.Authentication = 'NoAuthentication';
    dest.ProxyType = 'Internet';

    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
    };

    if (existing) {
        await axios.put(`${baseUrl}/${DEST_NAME}`, dest, { headers });
    } else {
        await axios.post(baseUrl, dest, { headers });
    }
}

/**
 * Deletes the `docusign` destination (full reset).
 */
async function remove() {
    const creds = getCredentials();
    const token = await getServiceToken();
    const url = `${creds.uri}/destination-configuration/v1/instanceDestinations/${DEST_NAME}`;

    try {
        await axios.delete(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
    } catch (err) {
        if (err.response && err.response.status === 404) {
            return; // Already gone — nothing to do.
        }
        throw err;
    }
}

module.exports = { read, write, remove };
