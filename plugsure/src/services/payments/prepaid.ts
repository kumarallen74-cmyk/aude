import { one, query } from '../../db/pool.js';
import { logger } from '../../logger.js';
import { bus } from '../events.js';
import * as registry from '../../ocpp/registry.js';
import { remoteStopTransaction, setChargingProfile } from '../../ocpp/commands.js';
import { PREPAID_STACK } from '../smartcharging.js';

/**
 * Prepaid (QRIS pre-purchase) enforcement.
 *
 * QRIS has no pre-authorisation, so the flow is inverted: the driver buys a fixed
 * rupiah amount and the charger delivers exactly that much energy and stops.
 *
 * The allowance used to be computed at checkout and then thrown away — nothing
 * wrote it to the session, nothing linked the payment, and nothing stopped the
 * charger. A Rp 100,000 purchase delivered Rp 378,904 of electricity, all of it
 * uncollectable from a walk-up guest with no card on file. This module is the
 * missing enforcement.
 *
 * Two layers, because either alone is insufficient:
 *   1. A charging profile that ramps the connector down as the allowance nears,
 *      so an unreachable CSMS cannot overrun by much.
 *   2. A RemoteStopTransaction the moment the allowance is met, with retries.
 */

/** Below this fraction remaining, throttle so a lost connection cannot overrun far. */
const THROTTLE_AT = 0.9;
const THROTTLE_W = 3_000;
const STOP_RETRIES = 3;

const stopping = new Set<string>();

export function registerPrepaidEnforcement() {
  bus.on('prepaid.exhausted', (e) => {
    void enforceStop(e).catch((err) =>
      logger.error({ err, sessionId: e.sessionId }, 'prepaid stop enforcement failed'),
    );
  });

  bus.on('session.updated', (e) => {
    void maybeThrottle(e.sessionId).catch(() => {});
  });
}

async function enforceStop(e: {
  sessionId: string;
  chargePointId: string;
  connectorNo: number;
  transactionId: string;
  allowanceWh: number;
  deliveredWh: number;
}) {
  if (stopping.has(e.sessionId)) return;
  stopping.add(e.sessionId);

  const cp = await one<{ ocpp_identity: string }>(`SELECT ocpp_identity FROM charge_point WHERE id = $1`, [
    e.chargePointId,
  ]);
  if (!cp) return;

  logger.info(
    { sessionId: e.sessionId, allowanceWh: e.allowanceWh, deliveredWh: e.deliveredWh },
    'prepaid allowance reached — stopping the session',
  );

  // Idempotent: a second meter value past the allowance must not re-flag.
  await query(
    `UPDATE charging_session
        SET flags = flags || $2::jsonb
      WHERE id = $1 AND NOT (flags @> '[{"code":"PREPAID_ALLOWANCE_REACHED"}]'::jsonb)`,
    [
      e.sessionId,
      JSON.stringify([
        {
          code: 'PREPAID_ALLOWANCE_REACHED',
          severity: 'info',
          message: `Delivered ${e.deliveredWh} Wh against a ${e.allowanceWh} Wh prepaid allowance; stop issued.`,
        },
      ]),
    ],
  );

  for (let attempt = 1; attempt <= STOP_RETRIES; attempt++) {
    if (!registry.isOnline(cp.ocpp_identity)) {
      await sleep(2_000 * attempt);
      continue;
    }
    try {
      const res = await remoteStopTransaction(cp.ocpp_identity, registry.wireTransactionId(cp.ocpp_identity, e.transactionId), { type: 'system' });
      if (res?.status === 'Accepted') {
        stopping.delete(e.sessionId);
        return;
      }
      logger.warn({ cp: cp.ocpp_identity, attempt, status: res?.status }, 'charger rejected the prepaid stop');
    } catch (err) {
      logger.warn({ cp: cp.ocpp_identity, attempt, err: (err as Error).message }, 'prepaid stop attempt failed');
    }
    await sleep(2_000 * attempt);
  }

  stopping.delete(e.sessionId);

  // The charger would not or could not stop. That is an operational incident and
  // an unrecoverable-revenue risk, so say so loudly rather than silently overrun.
  const s = await one<{ org_id: string }>(`SELECT org_id FROM charging_session WHERE id = $1`, [e.sessionId]);
  if (s) {
    bus.emit('alert.raised', {
      orgId: s.org_id,
      kind: 'prepaid.stop_failed',
      severity: 'critical',
      message:
        `Session ${e.sessionId} exceeded its prepaid allowance and the charger did not stop after ` +
        `${STOP_RETRIES} attempts. Energy is being delivered without payment.`,
    });
  }
  await query(
    `UPDATE charging_session SET needs_review = true, review_reason = COALESCE(review_reason, 'PREPAID_OVERRUN') WHERE id = $1`,
    [e.sessionId],
  );
}

/** Ramp the connector down as the allowance nears, so an outage cannot overrun far. */
async function maybeThrottle(sessionId: string) {
  const s = await one<{
    prepaid_energy_wh: number | null;
    energy_wh: number;
    ocpp_identity: string;
    connector_no: number;
    ocpp_transaction_id: string | null;
    throttled: boolean;
  }>(
    `SELECT cs.prepaid_energy_wh, cs.energy_wh, cp.ocpp_identity, e.evse_id AS connector_no,
            cs.ocpp_transaction_id,
            (cs.flags @> '[{"code":"PREPAID_THROTTLED"}]'::jsonb) AS throttled
       FROM charging_session cs
       JOIN charge_point cp ON cp.id = cs.charge_point_id
       JOIN connector c ON c.id = cs.connector_uuid
       JOIN evse e ON e.id = c.evse_uuid
      WHERE cs.id = $1 AND cs.state = 'active'`,
    [sessionId],
  );
  if (!s?.prepaid_energy_wh || s.throttled || !s.ocpp_transaction_id) return;
  if (s.energy_wh < Number(s.prepaid_energy_wh) * THROTTLE_AT) return;
  if (!registry.isOnline(s.ocpp_identity)) return;

  try {
    await setChargingProfile(
      s.ocpp_identity,
      {
        connectorId: s.connector_no,
        purpose: 'TxProfile',
        stackLevel: PREPAID_STACK, // above load management: a paid allowance wins
        ocppProfileId: 9_000 + s.connector_no,
        limit: THROTTLE_W,
        unit: 'W',
        durationS: 3_600,
        transactionId: registry.wireTransactionId(s.ocpp_identity, s.ocpp_transaction_id),
      },
      { type: 'system' },
    );
    await query(
      `UPDATE charging_session SET flags = flags || $2::jsonb WHERE id = $1`,
      [
        sessionId,
        JSON.stringify([
          {
            code: 'PREPAID_THROTTLED',
            severity: 'info',
            message: `Throttled to ${THROTTLE_W} W at ${Math.round(THROTTLE_AT * 100)}% of the prepaid allowance.`,
          },
        ]),
      ],
    );
    logger.info({ sessionId, limitW: THROTTLE_W }, 'prepaid session throttled near its allowance');
  } catch (e) {
    logger.warn({ sessionId, err: (e as Error).message }, 'could not throttle prepaid session');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
