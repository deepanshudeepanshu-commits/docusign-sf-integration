const cds = require('@sap/cds');
const { triggerMaestro } = require('./lib/maestro');

/**
 * OData-style entry point kept for backwards compatibility and same-tenant
 * (authenticated) callers. It runs in the caller's ambient tenant context.
 *
 * For inbound SuccessFactors Integration Center webhooks (which are
 * unauthenticated and therefore carry no tenant), use the tenant-aware route
 * defined in srv/server.js:  POST /webhook/tenant/<tenantId>/trigger
 */
module.exports = cds.service.impl(async function () {

    this.on('triggerMaestroWorkflow', async (req) => {
        console.log('=== SUCCESSFACTORS EVENT RECEIVED (OData action) ===');
        try {
            return await triggerMaestro(req.data?.data || {});
        } catch (err) {
            return req.reject(err.code || 500, err.message);
        }
    });
});
