import { logger } from '../logger.js';
import { instrumentWorker, startHealthMonitor } from './worker-health.js';
import { many, query } from '../db/pool.js';
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

export function startWorkers(): () => void {
  const intervals: Record<string, number> = {};
  const guard = (name: string, fn: () => Promise<unknown>) => {
    let wrapped: (() => void) | null = null;
    return () => {
      wrapped ??= instrumentWorker(name, intervals[name] ?? 60_000, fn);
      wrapped();
    };
  };

  const compliance = guard('compliance', async () => {
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
  const reconcile = guard('reconcile', () => reconcileStuckSessions());
  const fota = guard('fota', () => firmwareTick());
  // Paid-but-never-started prepaid payments → refund queue (and their tokens retired).
  const refunds = guard('refunds', () => sweepUnusedPayments());
  // Card holds: release unused ones, retry captures and releases that failed.
  const holds = guard('card-holds', () => sweepHolds());
  // Offline-too-long alerts, outages the gateway could not see (restart), self-heal.
  const outages = guard('outages', () => sweepOutages());
  // Webhook outbox: send what is due; trim old rows.
  let sending = false;
  const webhooks = guard('webhooks', async () => {
    if (sending) return;
    sending = true;
    try { while ((await deliverDue()) === 50); } finally { sending = false; }
  });
  const prune = guard('webhook-prune', () => pruneDeliveries());
  // Alert notifications (e-mail, WhatsApp): route new/resolved/escalated alerts, send what is due.
  let routing = false;
  const alertRouting = guard('alert-routing', async () => {
    if (routing) return;
    routing = true;
    try { await runAlertRouting(); } finally { routing = false; }
  });

  // Roaming (OCPI): send the outbox; re-publish changed locations and tariffs.
  let roamingSending = false;
  const roaming = guard('roaming', async () => {
    if (roamingSending) return;
    roamingSending = true;
    try { while ((await deliverRoaming()) === 50); } finally { roamingSending = false; }
  });
  const roamingSync = guard('roaming-sync', () => syncAllRoaming());
  const roamingPrune = guard('roaming-prune', () => pruneRoaming());
  // eMSP role: refresh CPO partners' networks (they also push changes as they happen).
  // Hubs: who is behind them (they also push changes as they happen).
  const roamingImport = guard('roaming-import', async () => {
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
  const reservations = guard('reservations', async () => {
    await sweepReservations();
    await sweepRoamingReservations();
    await sweepQueues();
  });
  const pushPrune = guard('push-prune', () => prunePush());
  // iOS Live Activities: a charge under way on the lock screen (starts, updates within Apple's budget, ends).
  let liveBusy = false;
  const live = guard('live-activities', async () => {
    if (liveBusy) return;
    liveBusy = true;
    try { await liveActivityPass(); } finally { liveBusy = false; }
  });
  // Unpaid sessions payable in the app: reminders 15 min, 1 day and 3 days after the session.
  const unpaid = guard('unpaid-reminders', () => remindUnpaidSessions());
  // Membership passes bought in the app: reminder three days before they end.
  const passes = guard('membership-passes', () => remindEndingPasses());
  const renewals = guard('pass-renewals', () => renewPasses());
  const pointsExpiry = guard('loyalty-expiry', () => expirePoints());
  // Plug & Charge: renew chargers' V2G certificates before they expire.
  const pncRenewal = guard('pnc-renewal', () => renewExpiringCertificates());
  // Chargers' own client certificates (Security Profile 3) from PlugSure's CA.
  const stationCertRenewal = guard('station-cert-renewal', () => renewStationCertificates());

  // Developer sandbox: keep each sandbox tenant's virtual chargers running here.
  setSandboxHandler((identity, event, args) =>
    identity === '*' && event === 'sync' ? syncVirtualFleet() : simulate(identity, event as SimulateEvent, args),
  );
  const sandboxFleet = guard('sandbox-fleet', () => syncVirtualFleet());

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
  ];
  compliance();
  reconcile();
  refunds();
  holds();
  sandboxFleet();
  logger.info('background workers started: load management, compliance, reconciliation, FOTA, refunds, outages, webhooks, alert notifications, roaming, sandbox fleet');
  return () => {
    timers.forEach((t) => clearInterval(t));
    stopHealth();
    void stopVirtualFleet();
  };
}
