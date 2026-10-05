import { logger, installProcessGuards } from '../logger.js';
import { pool, endLockPool } from '../db/pool.js';
import { startGateway } from '../ocpp/server.js';
import { startApi } from '../api/server.js';
import { assertAuditKeyConfigured } from '../services/audit.js';
import { assertSecretsKeyConfigured } from '../services/secrets.js';
import { assertAuthConfigured } from '../services/auth.js';
import { assertRlsPosture } from '../db/pool.js';
import { config, assertNodeEnvSet } from '../config.js';
import { registerCoreListeners, startWorkers } from '../services/workers.js';

/**
 * Dev / single-VM entrypoint: gateway + API + workers in one process.
 *
 * In a larger production deployment the gateway is deployed SEPARATELY. Its
 * lifecycle differs — a deploy of the billing code must never drop 4,000
 * charger WebSockets — and it scales on connection count while the API scales
 * on request rate. See ocpp/bridge.ts for how the two then talk.
 */

async function main() {
  // First: an unset NODE_ENV used to mean development. Name the environment (config.ts).
  assertNodeEnvSet();
  // Fail loudly at boot rather than at the first audited action or first request.
  assertAuditKeyConfigured();
  assertSecretsKeyConfigured();
  assertAuthConfigured();
  // RLS is only a second line of defence if the connection role cannot bypass it.
  await assertRlsPosture();

  registerCoreListeners();

  const gateway = await startGateway();
  const api = await startApi();
  // Only now: a failure BEFORE this point is fatal and must exit, not be swallowed.
  installProcessGuards();

  // Workers. In production these are BullMQ jobs, not setIntervals.
  const stopWorkers = config.workers.enabled ? startWorkers() : () => {};

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down');
    stopWorkers();
    await gateway.close().catch(() => {});
    await api.close().catch(() => {});
    await pool.end().catch(() => {});
    await endLockPool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
