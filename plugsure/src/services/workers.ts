import { logger } from '../logger.js';
import { instrumentWorker, startHealthMonitor } from './worker-health.js';
import { many, query, pool } from '../db/pool.js';
import { bus } from './events.js';
import { runComplianceSweep, keyRotationSweep } from './compliance.js';
import { runControlLoop } from './smartcharging.js';
import { reconcileStuckSessions } from './sessions.js';
import { tick as firmwareTick } from './firmware.js';
import { registerPrepaidEnforcement } from './payments/prepaid.js';
import { registerOperatorLimits } from './operator-limits.js';
import { sweepUnusedPayments } from './refunds.js';
import { sweepHolds } from './payments/holds.js';
import { registerUptimeListeners, sweepOutages } from './uptime.js';
import { registerWebhookListeners, deliverDue, pruneDeliveries } from './webhooks.js';
import { persistAlert } from './alerts.js';
import { runAlertRouting } from './alert-routing.js';
import { registerRoamingListeners, deliverDue as deliverRoaming, syncAll as syncAllRoaming, pruneRoaming } from '../ocpi/push.js';
import { importAll as importCpoNetworks } from '../ocpi/emsp.js';
import { pullAllHubClients } from '../ocpi/hubclients.js';
import { registerDriverPushListeners, deliverPush, prunePush, remindUnpaidSessions } from '../driver/notify.js';
import { liveActivityPass } from './live-activity.js';
import { registerReservationListeners, sweepReservations } from '../driver/reservations.js';
import { registerQueueListeners, sweepQueues } from '../driver/queue.js';
import { sweepRoamingReservations } from '../driver/roaming.js';
import { remindEndingPasses, renewPasses } from '../driver/membership.js';
import { expirePoints } from './loyalty.js';
import { renewExpiringCertificates } from '../pnc/service.js';
import { renewStationCertificates } from './charger-ca.js';
import { setSandboxHandler } from '../ocpp/bridge.js';
import { syncVirtualFleet, simulate, stopVirtualFleet, type SimulateEvent } from '../sandbox/fleet.js';
import { runRetention } from './retention.js';

/**
 * Background work, in ONE place.
 *
 * v1.2.1 started these timers only in the all-in-one dev entrypoint. The
 * documented production topology runs `gateway.js` and `api.js` separately, and
 * neither started them — so in production there was no load-management control
 * loop, no compliance sweep (tera lapses never blocked anything), no stuck
 * session reconciliation, and alerts raised in the gateway were never stored.
 *
 * They now run in the process that owns the charger sockets: the gateway in the
 * split deployment, the single process otherwise. RUN_WORKERS=false turns them
 * off (e.g. on a second gateway replica).
 */

/** Listeners that must exist wherever events are RAISED. */
export function registerCoreListeners(): void {
  bus.on('alert.raised', (a) => {
    void persistAlert(a);
    logger.warn({ kind: a.kind, severity: a.severity }, a.message);
  });
  bus.on('quirk.discovered', (q) => {
    logger.info({ vendor: q.vendor, model: q.model }, `quirk discovered: ${q.finding}`);
  });
  // Prepaid sessions must be stopped when their purchased energy runs out, and
  // operator remote-start limits enforced — both react to session events.
  registerPrepaidEnforcement();
  registerOperatorLimits();
  // Outage history from connect/disconnect (raised in the socket-owning process).
  registerUptimeListeners();
  // Outbound webhooks: events are written to the outbox where they are raised.
  registerWebhookListeners();
  // Roaming (OCPI): EVSE status, sessions and CDRs go to the outbox where they are raised.
  registerRoamingListeners();
  // Driver app: push notifications about charges, and reservations used up by a session.
  registerDriverPushListeners();
  registerReservationListeners();
  // Site queues: a connector that becomes free is offered to the next driver waiting.
  registerQueueListeners();
}

/**
 * ONE RUNNER AT A TIME, platform-wide, for the workers that move money or send
 * something to a person.
 *
 * RUN_WORKERS defaults to true, so every gateway replica runs every worker,
 * and a pass that outlives its interval overlaps the next one in the same
 * process. None of these took a lock. Pass renewal captured a saved card
 * before inserting the row its unique index protects: two runners charged
 * the driver twice and the second charge was never recorded. Refunds, card
 * holds and reminders ran twice likewise. Each pass now takes a session-level
 * advisory lock named after the worker and skips if another runner has it.
 * Resolves true when this runner ran the pass, false when it skipped.
 *
 * (The outboxes — webhooks, push, roaming, alert routing — already lease rows
 * with FOR UPDATE SKIP LOCKED. Load management and FOTA command the chargers
 * connected to THIS gateway, so they stay per process.)
 */
export async function exclusive(name: string, fn: () => Promise<unknown>): Promise<boolean> {
  const key = `plugsure.worker:${name}`;
  const client = await pool.connect();
  let healthy = true;
  try {
    const got = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [key]);
    if (!got.rows[0]?.ok) return false;
    try {
      await fn();
    } finally {
      // A lock left on a pooled connection would block this worker forever: if the
      // unlock fails, the connection is discarded, which releases it.
      await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [key]).catch(() => { healthy = false; });
    }
    return true;
  } finally {
    client.release(healthy ? undefined : true);
  }
}

export function startWorkers(): () => void {
  const intervals: Record<string, number> = {};
  const guard = (name: string, fn: () => Promise<unknown>) => {
    let wrapped: (() => void) | null = null;
    return () => {
      wrapped ??= instrumentWorker(name, intervals[name] ?? 60_000, fn);
      wrapped();
    };
  };

  const once = (name: string, fn: () => Promise<unknown>) => guard(name, () => exclusive(name, fn));

  /**
   * Outbox passes (webhooks, roaming). A single-flight flag used to let ONE pass
   * run at a time, and a pass waited for every call in its batch: one receiver
   * trickling its answer stalled every tenant's deliveries. Each call now has a
   * hard total deadline (webhooks.ts, ocpi/client.ts) and up to OUTBOX_PASSES
   * passes may run at once, so a batch waiting on a slow receiver does not stop
   * the next tick from sending what else is due. Overlap is safe: rows are
   * leased (FOR UPDATE SKIP LOCKED, next_attempt_at pushed 2 minutes out — longer
   * than any call's deadline), and roaming calls for one object stay in order
   * because a leased row still blocks the later rows of its object.
   */
  const OUTBOX_PASSES = 3;
  const outbox = (name: string, deliver: () => Promise<number>) => {
    let running = 0;
    return guard(name, async () => {
      if (running >= OUTBOX_PASSES) return;
      running++;
      try { while ((await deliver()) === 50); } finally { running--; }
    });
  };

  const compliance = once('compliance', async () => {
    await runComplianceSweep();
    await keyRotationSweep();
  });
  const control = guard('load-management', async () => {
    const sites = await many<{ id: string }>(`SELECT id FROM site WHERE archived_at IS NULL`);
    for (const s of sites) {
      const t0 = Date.now();
      await runControlLoop(s.id).catch(() => []);
      const ms = Date.now() - t0;
      if (ms > 5_000) logger.warn({ siteId: s.id, ms }, 'load management: a site took long');
    }
  });
  const reconcile = once('reconcile', () => reconcileStuckSessions());
  const fota = guard('fota', () => firmwareTick());
  // Paid-but-never-started prepaid payments → refund queue (and their tokens retired).
  const refunds = once('refunds', () => sweepUnusedPayments());
  // Card holds: release unused ones, retry captures and releases that failed.
  const holds = once('card-holds', () => sweepHolds());
  // Offline-too-long alerts, outages the gateway could not see (restart), self-heal.
  const outages = once('outages', () => sweepOutages());
  // Webhook outbox: send what is due; trim old rows.
  const webhooks = outbox('webhooks', () => deliverDue());
  const prune = once('webhook-prune', () => pruneDeliveries());
  // Alert notifications (e-mail, WhatsApp): route new/resolved/escalated alerts, send what is due.
  let routing = false;
  const alertRouting = guard('alert-routing', async () => {
    if (routing) return;
    routing = true;
    try { await runAlertRouting(); } finally { routing = false; }
  });

  // Roaming (OCPI): send the outbox; re-publish changed locations and tariffs.
  const roaming = outbox('roaming', () => deliverRoaming());
  const roamingSync = once('roaming-sync', () => syncAllRoaming());
  const roamingPrune = once('roaming-prune', () => pruneRoaming());
  // eMSP role: refresh CPO partners' networks (they also push changes as they happen).
  // Hubs: who is behind them (they also push changes as they happen).
  const roamingImport = once('roaming-import', async () => {
    await importCpoNetworks();
    await pullAllHubClients();
  });

  // Driver app: send push notifications; remind about and close reservations.
  let pushing = false;
  const push = guard('push', async () => {
    if (pushing) return;
    pushing = true;
    try { while ((await deliverPush()) === 50); } finally { pushing = false; }
  });
  // Reservations first: an offer that lapsed frees its connector for the next driver in the queue.
  const reservations = once('reservations', async () => {
    await sweepReservations();
    await sweepRoamingReservations();
    await sweepQueues();
  });
  const pushPrune = once('push-prune', () => prunePush());
  // iOS Live Activities: a charge under way on the lock screen (starts, updates within Apple's budget, ends).
  let liveBusy = false;
  const live = guard('live-activities', async () => {
    if (liveBusy) return;
    liveBusy = true;
    try { await liveActivityPass(); } finally { liveBusy = false; }
  });
  // Unpaid sessions payable in the app: reminders 15 min, 1 day and 3 days after the session.
  const unpaid = once('unpaid-reminders', () => remindUnpaidSessions());
  // Membership passes bought in the app: reminder three days before they end.
  const passes = once('membership-passes', () => remindEndingPasses());
  const renewals = once('pass-renewals', () => renewPasses());
  const pointsExpiry = once('loyalty-expiry', () => expirePoints());
  // Plug & Charge: renew chargers' V2G certificates before they expire.
  const pncRenewal = once('pnc-renewal', () => renewExpiringCertificates());
  // Chargers' own client certificates (Security Profile 3) from PlugSure's CA.
  const stationCertRenewal = once('station-cert-renewal', () => renewStationCertificates());

  // Developer sandbox: keep each sandbox tenant's virtual chargers running here.
  setSandboxHandler((identity, event, args) =>
    identity === '*' && event === 'sync' ? syncVirtualFleet() : simulate(identity, event as SimulateEvent, args),
  );
  const sandboxFleet = guard('sandbox-fleet', () => syncVirtualFleet());
  // Retention of ocpp_frame / connection_attempt (OCPP_FRAME_RETENTION_DAYS,
  // CONNECTION_ATTEMPT_RETENTION_DAYS). Exclusive: two gateways deleting the same
  // batches would only fight over row locks.
  const retention = once('retention', () => runRetention());

  const every = (fn: () => void, ms: number, name: string) => { intervals[name] = ms; return setInterval(fn, ms); };
  const stopHealth = startHealthMonitor();
  const timers = [
    every(sandboxFleet, 10_000, 'sandbox-fleet'),
    every(push, 3_000, 'push'),
    every(live, 5_000, 'live-activities'),
    every(reservations, 15_000, 'reservations'),
    every(pushPrune, 6 * 60 * 60_000, 'push-prune'),
    every(unpaid, 5 * 60_000, 'unpaid-reminders'),
    every(passes, 60 * 60_000, 'membership-passes'),
    every(renewals, 15 * 60_000, 'pass-renewals'),
    every(pointsExpiry, 6 * 60 * 60_000, 'loyalty-expiry'),
    every(pncRenewal, 60 * 60_000, 'pnc-renewal'),
    every(stationCertRenewal, 60 * 60_000, 'station-cert-renewal'),
    every(roaming, 3_000, 'roaming'),
    every(roamingSync, 60_000, 'roaming-sync'),
    every(roamingPrune, 6 * 60 * 60_000, 'roaming-prune'),
    every(roamingImport, 6 * 60 * 60_000, 'roaming-import'),
    every(alertRouting, 5_000, 'alert-routing'),
    every(webhooks, 3_000, 'webhooks'),
    every(prune, 6 * 60 * 60_000, 'webhook-prune'),
    every(outages, 60_000, 'outages'),
    every(compliance, 60 * 60_000, 'compliance'),
    every(control, 30_000, 'load-management'),
    every(reconcile, 15 * 60_000, 'reconcile'),
    every(fota, 30_000, 'fota'),
    every(refunds, 5 * 60_000, 'refunds'),
    every(holds, 60_000, 'card-holds'),
    every(retention, 60 * 60_000, 'retention'),
  ];
  compliance();
  reconcile();
  refunds();
  holds();
  sandboxFleet();
  // Retention's first pass a few minutes after boot (not during the reconnect
  // storm), so a gateway restarted more often than hourly still prunes.
  const retentionKick = setTimeout(retention, 5 * 60_000);
  retentionKick.unref();
  logger.info('background workers started: load management, compliance, reconciliation, FOTA, refunds, outages, webhooks, alert notifications, roaming, sandbox fleet');
  return () => {
    timers.forEach((t) => clearInterval(t));
    clearTimeout(retentionKick);
    stopHealth();
    void stopVirtualFleet();
  };
}
