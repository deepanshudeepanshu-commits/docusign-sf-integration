const cds = require('@sap/cds');
const express = require('express');
const { triggerMaestro } = require('./lib/maestro');

/**
 * The application uses SAP HANA (HDI containers) for persistence in all
 * profiles. Production provisions one isolated HDI container per subscribed
 * tenant via the MTX sidecar; local/hybrid development binds to a dedicated
 * HDI container.
 *
 * TENANT-AWARE WEBHOOK
 * --------------------
 * SuccessFactors Integration Center calls an unauthenticated HTTP endpoint,
 * so no JWT (and therefore no tenant claim) is available. In a multitenant
 * app that means CAP cannot infer which subscriber's data to use.
 *
 * To solve this, we expose a webhook whose URL CARRIES THE TENANT ID:
 *
 *     POST /webhook/tenant/<tenantId>/trigger
 *     Body: { "workflowId": "<id>", ...any other input variables }
 *
 * Each subscriber copies their own tenant-specific URL from the app's Home
 * page (see app/home.html) and configures it in Integration Center. The
 * handler then runs the trigger logic inside `cds.tx({ tenant })`, so all
 * database access targets that subscriber's isolated HDI container and the
 * workflow is triggered using THAT tenant's DocuSign access token.
 */
cds.on('bootstrap', (app) => {
    app.post('/webhook/tenant/:tenant/trigger', express.json(), async (req, res) => {
        const { tenant } = req.params;
        // Accept either a wrapped `{ data: {...} }` payload or a flat object,
        // so Integration Center can post the simplest possible body.
        const payload = (req.body && (req.body.data || req.body)) || {};

        console.log(`=== SUCCESSFACTORS WEBHOOK for tenant ${tenant} ===`);

        if (!tenant) {
            return res.status(400).type('text/plain').send('Missing tenant in URL.');
        }

        try {
            const result = await cds.tx({ tenant }, () => triggerMaestro(payload));
            return res.status(200).type('text/plain').send(result);
        } catch (err) {
            const code = Number.isInteger(err.code) ? err.code : 500;
            console.error(`Webhook failed for tenant ${tenant}:`, err.message);
            return res.status(code).type('text/plain').send(err.message || 'Internal error');
        }
    });
});

module.exports = cds.server;

