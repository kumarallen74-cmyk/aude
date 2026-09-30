import { logger, installProcessGuards } from '../logger.js';
import { startGateway } from '../ocpp/server.js';
import { pool, assertRlsPosture } from '../db/pool.js';
import { assertAuditKeyConfigured } from '../services/audit.js';
import { assertSecretsKeyConfigured } from '../services/secrets.js';
import { config } from '../config.js';
import { registerCoreListeners, startWorkers } from '../services/workers.js';
import { startEventRelay } from '../ocpp/bridge.js';

/** Standalone OCPP gateway. Deploy separately from the API. */
async function main() {
  // The gateway audits every remote command it relays, so it needs the same key
  // the API does. Failing here beats failing at the first operator action.
  assertAuditKeyConfigured();
  assertSecretsKeyConfigured();
  await assertRlsPosture();

  // Events are raised here (the sockets live here), so their listeners must live
  // here too — alert persistence, prepaid enforcement, operator session limits.
  registerCoreListeners();
  // Relay events to the API process for the console's live stream (EVENT_RELAY=true).
  const stopRelay = startEventRelay();

  const g = await startGateway();
  // Only now: a failure BEFORE this point is fatal and must exit, not be swallowed.
  installProcessGuards();

  const stopWorkers = config.workers.enabled ? startWorkers() : () => {};
  if (!config.bridge.token) {
    logger.warn(
      'INTERNAL_API_TOKEN is not set: the API process cannot reach this gateway, so console commands ' +
        'and live status will not work in a split deployment. See deploy/README.md §"API ↔ gateway bridge".',
    );
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopWorkers();
    stopRelay();
    await g.close().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
