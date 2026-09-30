import { logger, installProcessGuards } from '../logger.js';
import { pool } from '../db/pool.js';
import { startApi } from '../api/server.js';
import { bus } from '../services/events.js';
import { query } from '../db/pool.js';
import { assertAuditKeyConfigured } from '../services/audit.js';
import { assertSecretsKeyConfigured } from '../services/secrets.js';
import { assertAuthConfigured } from '../services/auth.js';
import { assertRlsPosture } from '../db/pool.js';
import { startBridgeClient } from '../ocpp/bridge.js';
import { registerWebhookListeners } from '../services/webhooks.js';
import { registerRoamingListeners } from '../ocpi/push.js';
import { registerDriverPushListeners } from '../driver/notify.js';
import { persistAlert } from '../services/alerts.js';

/**
 * Standalone API + operator console. Deploy separately from the gateway.
 *
 * Background workers and session-event listeners (prepaid enforcement, operator
 * limits) run in the GATEWAY process, which owns the sockets and raises the
 * events. This process reaches chargers through the bridge (ocpp/bridge.ts).
 */
async function main() {
  assertAuditKeyConfigured();
  assertSecretsKeyConfigured();
  assertAuthConfigured();
  // RLS is only a second line of defence if the connection role cannot bypass it.
  await assertRlsPosture();

  // Alerts raised by work done IN this process (e.g. a console-triggered control
  // loop). Relayed gateway alerts are not re-delivered to named listeners, so
  // nothing is stored twice.
  bus.on('alert.raised', (a) => void persistAlert(a));
  // Events raised here (e.g. a refund recorded from the console) go to the webhook
  // outbox too; the gateway's worker sends them.
  registerWebhookListeners();
  // Same for roaming: e.g. a CDR issued when an operator clears a session's review.
  registerRoamingListeners();
  // Push notifications for events raised here (a refund paid by finance, a CDR after a review).
  registerDriverPushListeners();

  // Commands, liveness and live events through the gateway (GATEWAY_INTERNAL_URL + INTERNAL_API_TOKEN).
  const stopBridge = await startBridgeClient();

  const app = await startApi();
  // Only now: a failure BEFORE this point is fatal and must exit, not be swallowed.
  installProcessGuards();

  // The API previously had no SIGTERM handler at all, so every restart cut
  // in-flight HTTP requests.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('draining API');
    await app.close().catch(() => {});
    await stopBridge().catch(() => {});
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
