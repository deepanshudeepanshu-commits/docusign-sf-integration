const cds = require('@sap/cds');
const express = require('express');
const { triggerMaestro } = require('./lib/maestro');

/**
 * Single-tenant deployment: all state lives in the SAP BTP Destination Service
 * (see srv/lib/store.js), so there is no database.
 *
 * WEBHOOK
 * -------
 * SuccessFactors Integration Center calls one unauthenticated endpoint:
 *
 *     POST /webhook/trigger
 *     Body: { "workflowId": "<id>", ...any other input variables }
 *
 * The customer copies this URL from the app's Home page and configures it in
 * Integration Center. The handler triggers the DocuSign Maestro workflow using
 * this deployment's stored DocuSign access token.
 */
cds.on('bootstrap', (app) => {
    app.post('/webhook/trigger', express.json(), async (req, res) => {
        // Accept either a wrapped `{ data: {...} }` payload or a flat object,
        // so Integration Center can post the simplest possible body.
        const payload = (req.body && (req.body.data || req.body)) || {};

        console.log('=== SUCCESSFACTORS WEBHOOK received ===');

        try {
            const result = await triggerMaestro(payload);
            return res.status(200).type('text/plain').send(result);
        } catch (err) {
            const code = Number.isInteger(err.code) ? err.code : 500;
            console.error('Webhook failed:', err.message);
            return res.status(code).type('text/plain').send(err.message || 'Internal error');
        }
    });
});

module.exports = cds.server;
