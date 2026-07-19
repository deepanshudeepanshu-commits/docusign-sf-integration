const cds = require('@sap/cds');

/**
 * In-memory SQLite is auto-deployed only in the "development" profile
 * (e.g. via `cds watch`). When the app runs with the "production" profile on
 * Cloud Foundry, the in-memory database starts EMPTY, which leads to
 * "no such table: ..." errors on the first query.
 *
 * To keep this POC simple (no external database service), we deploy the CDS
 * model — creating all tables (and loading any CSV seed data) — into the
 * in-memory database once, right after the services have been served.
 *
 * NOTE: Because the store is in-memory, its contents (DocuSign tokens, selected
 * account, etc.) are lost whenever the app restarts or is redeployed. Re-run the
 * DocuSign login after a restart. For durable storage, switch `db` to SAP HANA.
 */
cds.once('served', async () => {
    const dbConfig = cds.env.requires && cds.env.requires.db;
    const url = dbConfig && dbConfig.credentials && dbConfig.credentials.url;

    if (dbConfig && dbConfig.kind === 'sqlite' && url === ':memory:') {
        try {
            await cds.deploy(cds.model).to(cds.db);
            console.log('[bootstrap] In-memory SQLite schema deployed successfully.');
        } catch (err) {
            console.error('[bootstrap] Failed to deploy in-memory schema:', err);
        }
    }
});

module.exports = cds.server;
