import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { one, many, query, tx } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { bus } from './events.js';
import { getConnector, type ConnectorRow } from './assets.js';
import { rateSession, adjustmentTotals, type Tariff, type PriceAdjustment, type RatingResult } from './tariff.js';
import { redemptionFor, pointsToRedeem, pointsAdjustment, discountable, recordLoyalty } from './loyalty.js';
import { benefitsFor, adjustmentOptions, pickCheapest, recordBenefits, type Who, type Benefits } from './benefits.js';
import { loadTariffForConnector } from './tariff-store.js';
import type { CanonicalMeterValue, TransactionEvent } from '../domain/canonical.js';
import { energyWhFrom, energySeriesFrom, powerWFrom } from '../domain/canonical.js';
import { markRefundDue } from './refunds.js';
import { linkRoamingSession } from '../ocpi/authorize.js';
import { normaliseEmaid } from '../pnc/emaid.js';
import { attachNeeds, applyFleetConsent, trackMeter, creditIdr } from './v2x.js';
import { storeSigned, assessSession } from './signed-metering.js';

/**
 * Session lifecycle.
 *
 * Three properties matter more than anything else here, and all three were
 * broken:
 *
 *  1. IDEMPOTENCY ON CHARGER-SUPPLIED FACTS. A charger that never receives
 *     StartTransaction.conf retries the identical request. The key must be
 *     derivable from that request alone.
 *  2. MONOTONIC ENERGY UNDER A LOCK. Replayed samples arrive out of order and
 *     concurrently; energy may only ever move forward, and the read-modify-write
 *     must be serialised on the session row.
 *  3. NOTHING BILLS SILENTLY WHEN IT LOOKS WRONG. A regulatory violation, a
 *     register rollover, an inverted timestamp or an implausible clock parks the
 *     session for review instead of issuing an invoice nobody checked.
 */

/**
 * Idempotency key — charger-supplied facts ONLY.
 *
 * The previous implementation hashed a CSMS-minted transaction id from a
 * sequence, fresh on every call, so a protocol-legal retry produced a second
 * session and a second CDR: Rp 91,317 billed twice for one delivery.
 */
export function sessionIdemKey(
  ocppIdentity: string,
  connectorNo: number,
  idTag: string,
  meterStartWh: number,
  startedAtIso: string,
): string {
  return createHash('sha256')
    .update(`${ocppIdentity}|${connectorNo}|${idTag}|${meterStartWh}|${startedAtIso}`)
    .digest('hex')
    .slice(0, 40);
}

export interface SessionRow {
  id: string;
  org_id: string;
  site_id: string;
  connector_uuid: string;
  charge_point_id: string;
  ocpp_transaction_id: string | null;
  state: string;
  started_at: Date;
  ended_at: Date | null;
  meter_start_wh: number;
  /** True while the start register has not been observed (migration 043). */
  meter_start_unknown: boolean;
  meter_stop_wh: number | null;
  energy_wh: number;
  idle_minutes: number;
  needs_review: boolean;
  prepaid_amount_idr: number | null;
  prepaid_energy_wh: number | null;
  payment_mode: string | null;
  flags: unknown[];
}

/**
 * Thresholds above which a divergence between the charger's own registers stops
 * being rounding noise and becomes a reason not to bill.
 */
const DIVERGENCE_MATERIAL_WH = 500;
const DIVERGENCE_MATERIAL_SHARE = 0.02;

export interface SessionFlag {
  code: string;
  severity: 'info' | 'warning' | 'violation';
  message: string;
}

export async function handleTransactionEvent(
  ev: TransactionEvent,
  chargePointId: string,
): Promise<SessionRow | null> {
  const connector = await getConnector(chargePointId, ev.evse.evseId);
  if (!connector) {
    logger.warn({ cp: ev.evse.ocppIdentity, evseId: ev.evse.evseId }, 'transaction for unknown connector');
    return null;
  }

  switch (ev.eventType) {
    case 'Started':
      return startSession(ev, connector);
    case 'Updated':
      return updateSession(ev, connector);
    case 'Ended':
      return endSession(ev, connector);
  }
}

// ------------------------------------------------------------------ start

async function startSession(ev: TransactionEvent, c: ConnectorRow): Promise<SessionRow | null> {
  /**
   * An ABSENT start register is not a zero one. OCPP 2.0.1 makes meterValue on
   * TransactionEvent(Started) optional, and `?? 0` here made the first Updated
   * sample — the charger's lifetime register, 8,450,000 Wh in the reproduction —
   * the session's energy. The start is recorded as unknown instead and taken
   * from the first register the session observes (updateSession / endSession).
   */
  const observedStartWh = energyWhFrom(ev.meterValue);
  const startWh = observedStartWh ?? 0;
  const tokenId = ev.idToken ? await resolveTokenId(c.org_id, ev.idToken.idToken) : null;
  const flags: SessionFlag[] = [];

  const skewFlag = clockSkewFlag(ev.timestamp);
  if (skewFlag) flags.push(skewFlag);

  /**
   * START IS ATOMIC PER CONNECTOR.
   *
   * A retried StartTransaction (or TransactionEvent Started) arriving alongside
   * the original — across a reconnect, typically — used to pass the "existing
   * session" check in both requests; the second then closed the session the
   * first had just created as "superseded", and its own INSERT hit ON CONFLICT
   * and handed back that CLOSED row. The charger went on charging against a
   * session that was already ended and parked.
   *
   * Everything that decides what a start means — is this the same start again,
   * is another session still open here, which prepaid intent does it claim —
   * now runs under one transaction-scoped advisory lock on (charge point,
   * connector). A duplicate waits, then finds the original by its idempotency
   * key and changes nothing; only a genuinely new start closes an orphan, and
   * never the row carrying its own key.
   */
  const started = await tx(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('session-start:' || $1::text || ':' || $2::text, 0))`,
      [c.charge_point_id, ev.evse.evseId],
    );

    const same = await client.query<SessionRow>(
      `UPDATE charging_session
          SET ocpp_transaction_id = COALESCE(ocpp_transaction_id, $2)
        WHERE idem_key = $1
        RETURNING *`,
      [ev.idemKey, ev.transactionId],
    );
    if (same.rows[0]) return { row: same.rows[0], created: false, prepaid: null, orphans: [] as Orphan[] };

    // A new transaction on a connector we still believe is busy means we missed
    // a stop. Close the stale one for review rather than losing either session.
    const orphans = await closeOrphansLocked(client, c.charge_point_id, ev.evse.evseId, ev.idemKey, 'superseded by a new transaction');

    // A prepaid intent parked on this connector claims the session it starts —
    // but only the intent whose PAYER is the token starting it. Claimed under
    // the lock, so a duplicate start cannot claim a second intent.
    const prepaid = await claimPrepaidIntent(c.id, ev.idToken?.idToken ?? null, client);

    const ins = await client.query<SessionRow & { inserted: boolean }>(
      `INSERT INTO charging_session
          (org_id, site_id, connector_uuid, charge_point_id, idem_key, ocpp_transaction_id,
           token_id, state, started_at, meter_start_wh, meter_start_unknown, energy_wh, payment_mode,
           prepaid_amount_idr, prepaid_energy_wh, payment_intent_id, flags, needs_review)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,0,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (idem_key) DO UPDATE
          SET ocpp_transaction_id = COALESCE(charging_session.ocpp_transaction_id, EXCLUDED.ocpp_transaction_id)
       RETURNING *, (xmax = 0) AS inserted`,
      [
        c.org_id,
        c.site_id,
        c.id,
        c.charge_point_id,
        ev.idemKey,
        ev.transactionId,
        tokenId,
        ev.timestamp,
        startWh,
        observedStartWh === null,
        prepaid ? 'prepurchase' : 'postpaid',
        prepaid?.amount_authorised_idr ?? null,
        prepaid?.allowance_wh ?? null,
        prepaid?.id ?? null,
        JSON.stringify(flags),
        flags.some((f) => f.severity === 'violation'),
      ],
    );
    const { inserted, ...row } = ins.rows[0]!;
    // Bound inside the lock too: an intent claimed but not yet pointed at its
    // session is still claimable by the next start on this connector.
    if (prepaid && inserted) {
      await client.query(`UPDATE payment_intent SET session_id = $2 WHERE id = $1`, [prepaid.id, row.id]);
    }
    return { row: row as SessionRow, created: inserted, prepaid, orphans };
  });

  for (const o of started.orphans) announceOrphan(o, 'superseded by a new transaction');
  // A repeat of a start already recorded: the original row, with none of the
  // start's side effects (meter values, prepaid binding, session.started) run twice.
  if (!started.created) return started.row;
  const { row, prepaid } = started;

  if (row) {
    await insertMeterValues(row.id, ev.meterValue);
    // ISO 15118 needs that arrived before the transaction, a fleet's standing consent to
    // discharge, and the SoC / export registers at the start (services/v2x.ts).
    await attachNeeds(row.id, c.charge_point_id, ev.evse.evseId).catch((e) => logger.warn({ sessionId: row.id, err: String(e) }, 'charging needs not attached'));
    await applyFleetConsent(row.id).catch(() => false);
    await trackMeter(row.id, ev.meterValue, ev.operationMode).catch(() => null);
    if (prepaid) {
      if (prepaid.claim_id_tag == null) {
        await addFlag(row.id, {
          code: 'PREPAID_UNBOUND_INTENT',
          severity: 'warning',
          message:
            'This pre-purchase carries no payer token (it predates payer binding), so it was ' +
            'claimed by whichever token started the session. Verify before settling.',
        });
      }
      logger.info(
        { sessionId: row.id, intent: prepaid.id, allowanceWh: prepaid.allowance_wh },
        'session bound to a prepaid intent',
      );
    }
    // Not one of the operator's own cards: a roaming partner's driver is linked
    // here, before session.started, so the partner is told about the session.
    if (!tokenId && ev.idToken) await linkRoamingSession(row.id, c.org_id, ev.idToken.idToken);
    bus.emit('session.started', {
      orgId: row.org_id,
      sessionId: row.id,
      ocppIdentity: ev.evse.ocppIdentity,
      connectorId: ev.evse.evseId,
    });
    logger.info({ sessionId: row.id, cp: ev.evse.ocppIdentity, tx: ev.transactionId }, 'session started');
  }
  return row;
}

// ------------------------------------------------------------------ update

async function updateSession(ev: TransactionEvent, c: ConnectorRow): Promise<SessionRow | null> {
  const observedWh = energyWhFrom(ev.meterValue);
  let replan: string | null = null;

  const out = await tx(async (client) => {
    // Serialise the read-modify-write. Twenty concurrent meter values previously
    // lost updates: 13,000 Wh stored where 20,000 was delivered.
    const cur = await client.query<SessionRow>(
      `SELECT * FROM charging_session
        WHERE charge_point_id = $1 AND ocpp_transaction_id = $2
        ORDER BY started_at DESC LIMIT 1
        FOR UPDATE`,
      [c.charge_point_id, ev.transactionId],
    );
    const row = cur.rows[0];
    if (!row) return null;

    await insertMeterValues(row.id, ev.meterValue, client);
    // Energy given back and the battery level; a discharging car that reached its floor re-plans the site at once.
    replan = (await trackMeter(row.id, ev.meterValue, ev.operationMode, client)).replanSiteId;

    if (observedWh === null) return row;

    // The start register was never reported (a 2.0.1 Started without meterValue).
    // The FIRST register observed is the start: energy 0 at that point, not the
    // charger's lifetime total. The lowest register in the batch, so a batch of
    // several samples still counts what flowed between them.
    if (row.meter_start_unknown) {
      if (row.state !== 'active') return row; // closed with no start: nothing to measure from
      const startWh = Math.min(...energySeriesFrom(ev.meterValue));
      await client.query(
        `UPDATE charging_session
            SET meter_start_wh = $2, meter_start_unknown = false, last_meter_at = $3,
                flags = flags || $4::jsonb
          WHERE id = $1 AND meter_start_unknown`,
        [row.id, startWh, ev.timestamp, JSON.stringify([startInferredFlag(startWh, ev.timestamp)])],
      );
      row.meter_start_wh = startWh;
      row.meter_start_unknown = false;
    }

    const candidate = observedWh - row.meter_start_wh;

    // A session already rated is closed for business. Record the sample, never
    // move the number the invoice was built from.
    if (row.state !== 'active') {
      if (candidate > row.energy_wh) {
        logger.warn(
          { sessionId: row.id, state: row.state, storedWh: row.energy_wh, observedWh: candidate },
          'meter value arrived after the session closed — recorded, not billed',
        );
        await addFlag(row.id, {
          code: 'LATE_METER_VALUE',
          severity: 'warning',
          message: `A meter value implying ${candidate} Wh arrived after the session was ${row.state}.`,
        }, client);
      }
      return row;
    }

    // Energy only ever moves forward. Taking the last sample let a stale replay
    // regress a session from 13,000 Wh to 4,000 Wh.
    if (candidate <= row.energy_wh) {
      logger.debug(
        { sessionId: row.id, storedWh: row.energy_wh, candidate },
        'ignoring non-advancing meter value (replay or duplicate)',
      );
      return row;
    }

    const powerW = powerWFrom(ev.meterValue);
    await client.query(
      `UPDATE charging_session
          SET energy_wh = $2, last_meter_at = $3
        WHERE id = $1 AND state = 'active' AND energy_wh < $2`,
      [row.id, candidate, ev.timestamp],
    );
    row.energy_wh = candidate;
    bus.emit('session.updated', { orgId: row.org_id, sessionId: row.id, energyWh: candidate, ...(powerW ? { powerW } : {}) });

    // Prepaid enforcement runs on every sample; see payments/prepaid.ts.
    if (row.prepaid_energy_wh != null && candidate >= row.prepaid_energy_wh) {
      bus.emit('prepaid.exhausted', {
        orgId: row.org_id,
        sessionId: row.id,
        chargePointId: c.charge_point_id,
        connectorNo: ev.evse.evseId,
        transactionId: ev.transactionId,
        allowanceWh: Number(row.prepaid_energy_wh),
        deliveredWh: candidate,
      });
    }
    return row;
  });
  if (replan) replanSite(replan);
  return out;
}

// ------------------------------------------------------------------ end

async function endSession(ev: TransactionEvent, c: ConnectorRow): Promise<SessionRow | null> {
  const result = await tx(async (client) => {
    const cur = await client.query<SessionRow>(
      `SELECT * FROM charging_session
        WHERE charge_point_id = $1 AND ocpp_transaction_id = $2
        ORDER BY started_at DESC LIMIT 1
        FOR UPDATE`,
      [c.charge_point_id, ev.transactionId],
    );
    const row = cur.rows[0];
    if (!row) {
      logger.warn({ tx: ev.transactionId }, 'stop for unknown transaction — replay of a lost start?');
      return null;
    }
    if (row.state !== 'active') return row; // idempotent: a replayed stop is a no-op

    await insertMeterValues(row.id, ev.meterValue, client);
    await trackMeter(row.id, ev.meterValue, ev.operationMode, client);

    const flags: SessionFlag[] = [];
    const observedWh = energyWhFrom(ev.meterValue);
    let stopWh: number | null;
    let energy: number;

    // No start register was ever reported. If this stop carries one it is the
    // first observation and the start (updateSession explains why); if it does
    // not, nothing was ever measured and nothing is billed — a start of "0"
    // would bill the lifetime register.
    const startUnknown = row.meter_start_unknown && observedWh === null;
    if (row.meter_start_unknown && observedWh !== null) {
      row.meter_start_wh = Math.min(...energySeriesFrom(ev.meterValue));
      flags.push(startInferredFlag(row.meter_start_wh, ev.timestamp));
    }

    if (startUnknown) {
      stopWh = null;
      energy = 0;
      flags.push({
        code: 'METER_REGISTER_ABSENT',
        severity: 'warning',
        message: 'The charger reported no energy register at any point in the session; billed 0 Wh.',
      });
    } else if (ev.meterStopAbsent || observedWh === null) {
      // Fall back to the running total rather than billing zero. The previous
      // `?? 0` made this path unreachable and lost a fully metered 45 kWh session.
      stopWh = row.meter_start_wh + row.energy_wh;
      energy = row.energy_wh;
      flags.push({
        code: 'METER_STOP_ABSENT',
        severity: 'warning',
        message: 'StopTransaction carried no final register; billed from the running total.',
      });
    } else if (observedWh < row.meter_start_wh) {
      // Register rollover. Clamping to zero silently discarded real deliveries.
      const wrap = detectRollover(row.meter_start_wh, observedWh);
      if (wrap) {
        stopWh = observedWh;
        energy = wrap.energyWh;
        flags.push({
          code: 'METER_ROLLOVER',
          severity: 'warning',
          message: `Register wrapped at ${wrap.width}; billed ${wrap.energyWh} Wh across the wrap.`,
        });
      } else {
        stopWh = observedWh;
        energy = row.energy_wh;
        flags.push({
          code: 'METER_WENT_BACKWARDS',
          severity: 'violation',
          message:
            `Final register ${observedWh} Wh is below the start register ${row.meter_start_wh} Wh ` +
            `and is not an explicable wrap. Parked for review.`,
        });
      }
    } else {
      stopWh = observedWh;
      energy = observedWh - row.meter_start_wh;
    }

    // The monotonic guard has to apply to the closing register too, not only to
    // mid-session MeterValues. A final register that is lower than the running
    // total the charger already reported means one of the two is wrong; billing
    // the smaller of them silently gives the energy away. Bill the larger and
    // park the session so a human decides which register to trust.
    if (energy < row.energy_wh) {
      const lostWh = row.energy_wh - energy;
      flags.push({
        code: 'FINAL_REGISTER_BELOW_RUNNING_TOTAL',
        severity: 'warning',
        message:
          `StopTransaction implies ${energy} Wh but MeterValues had already reported ` +
          `${row.energy_wh} Wh. Billed the running total; ${lostWh} Wh discrepancy.`,
      });
      energy = row.energy_wh;
      // Do not touch stopWh across a wrap: the stored register must stay the
      // register the charger actually reported.
      if (observedWh != null && observedWh >= row.meter_start_wh) {
        stopWh = row.meter_start_wh + row.energy_wh;
      }
    }

    /**
     * Divergence between the charger's two accounts of the same delivery.
     *
     * Severity has to scale with the magnitude. A flat `warning` meant a 3 kWh
     * disagreement on a 6 kWh session — the invoice 50% above what was
     * physically delivered — was rated and sent with `needs_review = false`,
     * because only a `violation` parks a session. A few watt-hours of rounding
     * is noise; a material divergence means one of the charger's two registers
     * is wrong and a human has to decide which before anyone is billed.
     */
    const divergence = ev.divergenceWh ?? 0;
    if (divergence > 1) {
      const share = energy > 0 ? divergence / energy : 1;
      const material = divergence > DIVERGENCE_MATERIAL_WH || share > DIVERGENCE_MATERIAL_SHARE;
      flags.push({
        code: 'METER_SOURCES_DIVERGE',
        severity: material ? 'violation' : 'warning',
        message:
          `transactionData and meterStop differ by ${divergence} Wh ` +
          `(${(share * 100).toFixed(1)}% of the billed energy); billed transactionData.` +
          (material ? ' Parked for review — one of the charger\'s registers is wrong.' : ''),
      });
    }

    const startedAt = new Date(row.started_at);
    const endedAt = new Date(ev.timestamp);

    const skew = clockSkewFlag(ev.timestamp);
    if (skew) flags.push(skew);

    let durationS = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
    if (durationS < 0) {
      flags.push({
        code: 'INVERTED_TIMESTAMPS',
        severity: 'violation',
        message: `Stop timestamp ${ev.timestamp} precedes start ${startedAt.toISOString()}.`,
      });
      durationS = 0;
    }
    const maxS = config.limits.maxSessionHours * 3600;
    if (durationS > maxS) {
      flags.push({
        code: 'IMPLAUSIBLE_DURATION',
        severity: 'violation',
        message: `Session ran ${Math.round(durationS / 3600)} h, beyond the ${config.limits.maxSessionHours} h sanity bound.`,
      });
    }

    // Signed meter data (OCMF): the signed start and end readings against the energy billed.
    // Under a site's "require" policy anything short of verified parks the session.
    const signed = await assessSession(row.id, energy, client).catch((e) => {
      logger.warn({ sessionId: row.id, err: String(e) }, 'signed meter data not assessed');
      return null;
    });
    if (signed?.flag) flags.push(signed.flag);

    // Idle time: plugged in but no longer drawing. Without this the idle fee that
    // tariffs are allowed to define could never actually be charged.
    const idleMinutes = await computeIdleMinutes(client, row.id, endedAt);

    // More energy than the connector could physically have delivered in the
    // time: a wrong start register, a unit mix-up or a meter fault. Parked.
    const implausible = implausibleEnergyFlag(energy, durationS, c.max_power_w);
    if (implausible) flags.push(implausible);

    const violation = flags.some((f) => f.severity === 'violation');

    const upd = await client.query<SessionRow>(
      `UPDATE charging_session
          SET state = 'ended', ended_at = $2, meter_stop_wh = $3, energy_wh = $4,
              meter_start_wh = $14, meter_start_unknown = $15,
              duration_s = $5, stop_reason = $6, idle_minutes = $7, v2x_discharging = false,
              flags = flags || $8::jsonb, needs_review = needs_review OR $9,
              review_reason = COALESCE(review_reason, $10),
              signed_status = $11, signed_energy_wh = $12, signed_detail = $13
        WHERE id = $1 AND state = 'active'
        RETURNING *`,
      [
        row.id,
        ev.timestamp,
        stopWh,
        energy,
        durationS,
        ev.stoppedReason ?? null,
        idleMinutes,
        JSON.stringify(flags),
        violation,
        violation ? flags.find((f) => f.severity === 'violation')!.code : null,
        signed?.status ?? null,
        signed?.signedWh ?? null,
        signed?.detail ?? null,
        row.meter_start_wh,
        startUnknown,
      ],
    );
    return upd.rows[0] ?? row;
  });

  if (!result || result.state !== 'ended') return result;

  bus.emit('session.ended', {
    orgId: result.org_id,
    sessionId: result.id,
    energyWh: result.energy_wh,
    durationS: Math.max(0, Math.round((new Date(result.ended_at!).getTime() - new Date(result.started_at).getTime()) / 1000)),
    stopReason: ev.stoppedReason,
  });
  logger.info(
    { sessionId: result.id, energyWh: result.energy_wh, reason: ev.stoppedReason, review: result.needs_review },
    'session ended',
  );

  await rateAndCreateCdr(result.id);
  return result;
}

// ------------------------------------------------------------------ bidirectional

/**
 * Run a site's load-management pass now instead of on the next 30-second tick:
 * a car's needs just arrived, or a discharging car reached its battery floor.
 * After the caller's transaction has committed; failures are only logged.
 */
export function replanSite(siteId: string): void {
  setImmediate(() => void import('./smartcharging.js')
    .then((m) => m.runControlLoop(siteId))
    .catch((e) => logger.warn({ siteId, err: String(e) }, 'site re-plan failed')));
}

export function replanSoon(sessionId: string): void {
  void one<{ site_id: string }>(`SELECT site_id FROM charging_session WHERE id = $1`, [sessionId])
    .then((s) => { if (s) replanSite(s.site_id); })
    .catch(() => undefined);
}

// ------------------------------------------------------------------ rating

/**
 * Who a session is for, for memberships and promotions: the card, and — when
 * the charge was started in the driver app — the app account, phone and promo
 * code entered at checkout.
 */
async function whoForSession(s: { id: string; token_id: string | null; connector_uuid: string; started_at: Date }): Promise<Who> {
  if (!s.token_id) return { sessionId: s.id };
  const dc = await one<{ app_driver_id: string | null; device_id: string; promo_code: string | null }>(
    `SELECT app_driver_id, device_id, promo_code FROM driver_charge
      WHERE token_id = $1 AND connector_uuid = $2 AND created_at >= $3::timestamptz - interval '2 hours'
      ORDER BY created_at DESC LIMIT 1`,
    [s.token_id, s.connector_uuid, s.started_at],
  );
  const t = await one<{ kind: string }>(`SELECT kind FROM token WHERE id = $1`, [s.token_id]);
  return {
    sessionId: s.id,
    // A prepaid claim token is a one-off: the customer is the app account / phone behind it.
    tokenId: t?.kind === 'prepaid' ? null : s.token_id,
    appDriverId: dc?.app_driver_id ?? null,
    deviceId: dc?.device_id ?? null,
    promoCode: dc?.promo_code ?? null,
  };
}

/** The session columns pricing needs (rateAndCreateCdr's and runningCost's SELECT). */
const PRICING_SELECT = `SELECT cs.*, c.max_power_w, c.current_type, si.pbjt_rate_bps, si.timezone
       FROM charging_session cs
       JOIN connector c ON c.id = cs.connector_uuid
       JOIN site si ON si.id = cs.site_id
      WHERE cs.id = $1`;

interface Priced {
  result: RatingResult;
  chosen: PriceAdjustment[];
  spent: { points: number; amountIdr: number } | null;
  benefits: Benefits | null;
  who: Who;
  fallback: boolean;
}

/**
 * Price a session: the ONE pricing path, shared by the final charge record and the
 * running cost a driver sees during the charge. Reads only; writes nothing.
 *
 * Keeping it one function is the point: a running cost computed differently from the
 * bill would show the driver one number and charge another.
 */
async function priceSession(s: any, at: { endedAt: Date; energyWh: number; idleMinutes: number }): Promise<Priced> {
  /**
   * TARIFF AS OF SESSION START — never "the current one".
   *
   * This argument was omitted, so `loadTariffForConnector` defaulted to now() and
   * a mid-day price change retroactively re-priced sessions: Rp 91,317 became
   * Rp 337,995 in the audit's reproduction.
   */
  const startedAt = new Date(s.started_at);
  const { tariff, fallback } = await loadTariffForConnector(s.connector_uuid, s.org_id, startedAt);

  const baseCtx = {
    startedAt,
    endedAt: at.endedAt,
    energyWh: at.energyWh,
    connectorMaxPowerW: Number(s.max_power_w),
    pbjtRateBps: Number(s.pbjt_rate_bps),
    idleMinutes: at.idleMinutes,
    timezone: s.timezone,
  };
  // Energy the car gave back (bidirectional charging): credited before PBJT-TL and PPN, at the
  // rate fixed when the driver or fleet agreed, and never below zero (applyAdjustments).
  const exportWh = Number(s.energy_export_wh ?? 0);
  const v2xCredit = creditIdr(exportWh, s.v2x_credit_idr_per_kwh);
  const v2xAdj: PriceAdjustment[] = v2xCredit > 0
    ? [{ source: 'v2x', id: s.id, name: `Energy given back (${(exportWh / 1000).toFixed(2)} kWh)`, amountOffIdr: v2xCredit }]
    : [];
  // Memberships and promotions: every allowed combination is rated and the
  // cheapest for the customer is billed.
  const who = await whoForSession(s);
  const benefits = await benefitsFor(s.org_id, who, { siteId: s.site_id, currentType: s.current_type }, startedAt, s.timezone ?? 'Asia/Jakarta')
    .catch((e) => { logger.warn({ sessionId: s.id, err: (e as Error).message }, 'benefits lookup failed — rated without them'); return null; });
  let chosen: PriceAdjustment[] = [];
  let result = benefits
    ? (() => {
        const p = pickCheapest(adjustmentOptions(benefits, baseCtx.energyWh / 1000), (adjustments) => {
          const r = rateSession(tariff, { ...baseCtx, adjustments: [...adjustments, ...v2xAdj] });
          return { ...r, total: r.tax.totalIdr };
        });
        chosen = p.option;
        return p.result;
      })()
    : rateSession(tariff, { ...baseCtx, adjustments: v2xAdj });
  // Loyalty points, for a driver who chose to use them: on top of the cheapest combination, before PBJT-TL and PPN.
  let spent: { points: number; amountIdr: number } | null = null;
  const points = await redemptionFor(s.org_id, who.appDriverId)
    .catch((e) => { logger.warn({ sessionId: s.id, err: (e as Error).message }, 'loyalty lookup failed — rated without points'); return null; });
  if (points) {
    const r = pointsToRedeem(points.balance, discountable(result.lines), points.program);
    if (r.points > 0) {
      result = rateSession(tariff, { ...baseCtx, adjustments: [...chosen, ...v2xAdj, pointsAdjustment(r.points, r.amountIdr)] });
      spent = r;
    }
  }
  return { result, chosen, spent, benefits, who, fallback };
}

/** Rating is idempotent — a CDR is created at most once per session. */
export async function rateAndCreateCdr(sessionId: string, opts: { force?: boolean } = {}) {
  const s = await one<any>(PRICING_SELECT, [sessionId]);
  if (!s) return null;

  const existing = await one(`SELECT id FROM cdr WHERE session_id = $1`, [sessionId]);
  if (existing && !opts.force) return existing;

  if (s.needs_review && !opts.force) {
    logger.warn(
      { sessionId, reason: s.review_reason },
      'session parked for review — refusing to issue a CDR until an operator clears it',
    );
    bus.emit('alert.raised', {
      orgId: s.org_id,
      kind: 'session.needs_review',
      severity: 'warning',
      message: `Session ${sessionId} was not billed: ${s.review_reason}.`,
    });
    return null;
  }

  const energyWh = Number(s.energy_wh);
  const { result, spent, benefits, who, fallback } = await priceSession(s, {
    endedAt: new Date(s.ended_at ?? s.started_at),
    energyWh,
    idleMinutes: Number(s.idle_minutes ?? 0),
  });

  const flags = [...result.flags];
  // Checked again here, not only at the stop: every path to a CDR comes through
  // this function, including sessions closed by reconciliation.
  const implausible = implausibleEnergyFlag(
    energyWh,
    Math.round((new Date(s.ended_at ?? s.started_at).getTime() - new Date(s.started_at).getTime()) / 1000),
    s.max_power_w,
  );
  if (implausible) flags.push(implausible);
  if (fallback) {
    // Silently dropping to the built-in default lost the service and admin fees.
    flags.push({
      code: 'TARIFF_FALLBACK',
      severity: 'warning',
      message:
        'No tariff was assigned and effective at session start; billed with the regulated default. ' +
        'Fees defined by the operator tariff were not applied.',
    });
  }

  const violation = flags.some((f) => f.severity === 'violation');
  if (violation && !opts.force) {
    await query(
      `UPDATE charging_session
          SET needs_review = true, review_reason = COALESCE(review_reason, $2), flags = flags || $3::jsonb
        WHERE id = $1`,
      [sessionId, flags.find((f) => f.severity === 'violation')!.code, JSON.stringify(flags)],
    );
    logger.error(
      { sessionId, flags: flags.filter((f) => f.severity === 'violation') },
      'rating produced a regulatory violation — session parked, no CDR issued',
    );
    for (const f of flags.filter((f) => f.severity === 'violation')) {
      bus.emit('alert.raised', {
        orgId: s.org_id,
        kind: `regulatory.${f.code}`,
        severity: 'critical',
        message: f.message,
      });
    }
    return null;
  }

  const cdr = await one<{ id: string }>(
    `INSERT INTO cdr (session_id, org_id, lines, subtotal_idr, pbjt_rate_bps, pbjt_idr,
                      ppn_dpp_idr, ppn_rate_bps, ppn_idr, total_idr, tariff_snapshot, regulatory_flags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (session_id) DO NOTHING
     RETURNING id`,
    [
      sessionId,
      s.org_id,
      JSON.stringify(result.lines),
      result.tax.subtotalIdr,
      result.tax.pbjtRateBps,
      result.tax.pbjtIdr,
      result.tax.ppnDppIdr,
      result.tax.ppnRateBps,
      result.tax.ppnIdr,
      result.tax.totalIdr,
      JSON.stringify(result.tariffSnapshot),
      JSON.stringify(flags),
    ],
  );

  if (cdr) {
    if (benefits) {
      await recordBenefits(s.org_id, sessionId, result.lines, benefits, energyWh / 1000)
        .catch((e) => logger.warn({ sessionId, err: (e as Error).message }, 'could not record membership / promotion use'));
    }
    // Points spent on this session, and earned on what it cost.
    await recordLoyalty(s.org_id, sessionId, who.appDriverId, result.tax.totalIdr, spent)
      .catch((e) => logger.warn({ sessionId, err: (e as Error).message }, 'could not record loyalty points'));
    await query(`UPDATE charging_session SET state = 'rated', rated_at = now() WHERE id = $1`, [sessionId]);
    bus.emit('cdr.created', { orgId: s.org_id, cdrId: cdr.id, sessionId, totalIdr: result.tax.totalIdr });
    logger.info({ sessionId, cdrId: cdr.id, totalIdr: result.tax.totalIdr }, 'CDR created');
    await settlePrepaid(sessionId, s.org_id, result.tax.totalIdr);
  }
  return cdr;
}

/**
 * Reconcile a pre-purchase against the invoice it produced.
 *
 * Nothing did this. The allowance is quoted at checkout against a GUESS — a
 * 45-minute session, no idle time, the tariff in force at that moment — and the
 * real session then diverges: the car sits for an hour and accrues an idle fee,
 * or the session crosses into the WBP peak block, or it ends early. Measured
 * deltas ran from +Rp 26,869 (money kept for energy never delivered) to
 * −Rp 58,552 (energy given away to a walk-up guest with no card on file). Every
 * one of those was recorded as `state = rated, needs_review = false`.
 *
 * There is no refund rail in this build, and pretending otherwise would be
 * worse than saying so: the delta is recorded and raised as an alert for the
 * operator, and the session is parked when the customer is owed money.
 */
const SETTLEMENT_TOLERANCE_IDR = 1_000;

async function settlePrepaid(sessionId: string, orgId: string, invoicedIdr: number): Promise<void> {
  const intent = await one<{ id: string; captured: number | null; minted: boolean; mode: string }>(
    `SELECT id, amount_captured_idr AS captured, claim_token_minted AS minted, mode
       FROM payment_intent
      WHERE session_id = $1 AND mode IN ('prepurchase', 'preauth', 'postpay') AND settled_at IS NULL`,
    [sessionId],
  );
  if (!intent) return;

  // A card hold: capture what the session cost (up to the hold); the rest is released, nothing to refund.
  let captured = Number(intent.captured ?? 0);
  if (intent.mode === 'preauth' || intent.mode === 'postpay') {
    const { settleHold } = await import('./payments/holds.js');
    captured = (await settleHold(intent.id, invoicedIdr)).captureIdr;
  }
  const delta = invoicedIdr - captured;

  await query(
    `UPDATE payment_intent SET settlement_delta_idr = $2, settled_at = now(), updated_at = now()
      WHERE id = $1`,
    [intent.id, delta],
  );

  // Retire a minted single-use token so the same payment screen cannot be reused.
  if (intent.minted) {
    await query(
      `UPDATE token SET status = 'Expired'
        WHERE org_id = $1 AND kind = 'prepaid'
          AND uid = (SELECT claim_id_tag FROM payment_intent WHERE id = $2)`,
      [orgId, intent.id],
    );
  }

  if (Math.abs(delta) <= SETTLEMENT_TOLERANCE_IDR) return;

  if (delta > 0) {
    bus.emit('alert.raised', {
      orgId,
      kind: 'prepaid.under_collected',
      severity: 'warning',
      message:
        `Session ${sessionId} invoiced Rp ${delta.toLocaleString('id-ID')} more than was collected ` +
        `(Rp ${invoicedIdr.toLocaleString('id-ID')} vs Rp ${captured.toLocaleString('id-ID')}). ` +
        `A prepaid driver has no card on file, so this is unrecoverable unless they return.`,
    });
    await addFlag(sessionId, {
      code: 'PREPAID_UNDER_COLLECTED',
      severity: 'warning',
      message: `Invoiced Rp ${invoicedIdr} against Rp ${captured} collected; Rp ${delta} short.`,
    });
    return;
  }

  // Money held for energy that was never delivered. This one owes the customer.
  // The session's billing is correct; what needs action is the payment, so it
  // goes to the refund queue (services/refunds.ts) instead of parking the session.
  const owed = -delta;
  await markRefundDue(intent.id, owed, 'Unused prepaid balance');
  bus.emit('alert.raised', {
    orgId,
    kind: 'prepaid.refund_due',
    severity: 'warning',
    message:
      `Session ${sessionId} collected Rp ${owed.toLocaleString('id-ID')} more than it delivered. ` +
      `A refund is due to the payer — process it under Refunds.`,
    targetType: 'payment_intent',
    targetId: intent.id,
  });
  await addFlag(sessionId, {
    code: 'PREPAID_REFUND_DUE',
    severity: 'info',
    message: `Collected Rp ${captured} for an invoice of Rp ${invoicedIdr}; Rp ${owed} is owed back (refund queued).`,
  });
}

// ------------------------------------------------------------------ recovery

/**
 * Close a session left active on a connector that has started a new transaction.
 * Without this the unique index would reject the new session outright, and the
 * revenue from both would be lost.
 *
 * Session start does this itself, under its per-connector lock (startSession):
 * closing from OUTSIDE that lock is what let a duplicate StartTransaction close
 * the session its twin had just opened. This entry point takes the same lock.
 */
export async function closeOrphanedSession(chargePointId: string, connectorNo: number, reason: string) {
  const orphans = await tx(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('session-start:' || $1::text || ':' || $2::text, 0))`,
      [chargePointId, connectorNo],
    );
    return closeOrphansLocked(client, chargePointId, connectorNo, null, reason);
  });
  for (const o of orphans) announceOrphan(o, reason);
}

interface Orphan { id: string; org_id: string }

/**
 * The close itself. The caller holds the connector's session-start lock.
 * `keepIdemKey` is the start being recorded: its own row is never an orphan,
 * whatever state a concurrent retry left it in.
 */
async function closeOrphansLocked(
  client: Pick<PoolClient, 'query'>,
  chargePointId: string,
  connectorNo: number,
  keepIdemKey: string | null,
  reason: string,
): Promise<Orphan[]> {
  const r = await client.query<Orphan>(
    `UPDATE charging_session
        SET state = 'ended', ended_at = now(), stop_reason = 'Other',
            needs_review = true, review_reason = 'ORPHANED_SESSION',
            flags = flags || $4::jsonb
      WHERE id IN (
              SELECT cs.id
                FROM charging_session cs
                JOIN connector c ON c.id = cs.connector_uuid
                JOIN evse e ON e.id = c.evse_uuid
               WHERE e.charge_point_id = $1 AND e.evse_id = $2 AND cs.state = 'active'
                 AND ($3::text IS NULL OR cs.idem_key <> $3)
            )
        AND state = 'active'
      RETURNING id, org_id`,
    [
      chargePointId,
      connectorNo,
      keepIdemKey,
      JSON.stringify([
        { code: 'ORPHANED_SESSION', severity: 'violation', message: `Closed without a StopTransaction: ${reason}.` },
      ]),
    ],
  );
  return r.rows;
}

/** After the closing transaction has committed: log and alert. */
function announceOrphan(orphan: Orphan, reason: string) {
  logger.warn({ sessionId: orphan.id, reason }, 'closed an orphaned session');
  bus.emit('alert.raised', {
    orgId: orphan.org_id,
    kind: 'session.orphaned',
    severity: 'warning',
    message: `Session ${orphan.id} was closed without a StopTransaction (${reason}) and needs review.`,
  });
}

/**
 * Sweep for sessions the protocol never closed. Previously a session whose stop
 * was replayed against a stale transaction id stayed `active` forever, never
 * billed, with no operator visibility and no repair path.
 */
/**
 * Close sessions the protocol never closed, and rate sessions that ended without
 * a CDR.
 *
 * `orgId` scopes the sweep to one tenant. The background worker passes nothing
 * and sweeps everything, which is correct for a platform job; the HTTP endpoint
 * MUST pass the caller's organisation. It did not, so any tenant with
 * `session:write` could force-close and bill every other tenant's live sessions
 * — a cross-tenant write, triggered by a single unauthenticated-looking POST.
 */
export async function reconcileStuckSessions(
  orgId?: string,
  maxHours = config.limits.maxSessionHours,
) {
  const stuck = await many<{ id: string; org_id: string; started_at: Date }>(
    `SELECT id, org_id, started_at FROM charging_session
      WHERE state = 'active' AND started_at < now() - ($1 || ' hours')::interval
        AND ($2::uuid IS NULL OR org_id = $2)`,
    [maxHours, orgId ?? null],
  );
  for (const s of stuck) {
    await query(
      `UPDATE charging_session
          SET state = 'ended', ended_at = COALESCE(last_meter_at, now()),
              needs_review = true, review_reason = 'STUCK_SESSION',
              flags = flags || $2::jsonb
        WHERE id = $1 AND state = 'active'`,
      [
        s.id,
        JSON.stringify([
          {
            code: 'STUCK_SESSION',
            severity: 'violation',
            message: `Active for more than ${maxHours} h with no StopTransaction; closed by reconciliation.`,
          },
        ]),
      ],
    );
    bus.emit('alert.raised', {
      orgId: s.org_id,
      kind: 'session.stuck',
      severity: 'warning',
      message: `Session ${s.id} was still active after ${maxHours} h and has been closed for review.`,
    });
  }

  // Sessions that ended but never produced a CDR — a crash mid-rating, or a
  // review that has since been cleared.
  const unrated = await many<{ id: string }>(
    `SELECT cs.id FROM charging_session cs
      LEFT JOIN cdr d ON d.session_id = cs.id
     WHERE cs.state = 'ended' AND d.id IS NULL AND cs.needs_review = false
       AND cs.ended_at < now() - interval '5 minutes'
       AND ($1::uuid IS NULL OR cs.org_id = $1)
     LIMIT 200`,
    [orgId ?? null],
  );
  for (const u of unrated) await rateAndCreateCdr(u.id).catch(() => null);

  if (stuck.length || unrated.length) {
    logger.info({ stuck: stuck.length, rerated: unrated.length }, 'session reconciliation pass');
  }
  return { stuck: stuck.length, rerated: unrated.length };
}

/** Operator action: clear the review flag and bill. */
export async function clearReviewAndRate(sessionId: string, orgId?: string, force = false) {
  // Scoped: clearing another tenant's review flag and billing their session is a
  // cross-tenant write, and the endpoint is reachable by any session:write holder.
  const r = await query(
    `UPDATE charging_session SET needs_review = false
      WHERE id = $1 AND ($2::uuid IS NULL OR org_id = $2)`,
    [sessionId, orgId ?? null],
  );
  if ((r.rowCount ?? 0) === 0) return null;
  return rateAndCreateCdr(sessionId, { force });
}

// ------------------------------------------------------------------ helpers

/** The session's start register was taken from its first observation, not the start event. */
function startInferredFlag(startWh: number, at: string): SessionFlag {
  return {
    code: 'METER_START_INFERRED',
    severity: 'info',
    message:
      `The start event carried no energy register; the first register observed ` +
      `(${startWh} Wh at ${at}) was taken as the start.`,
  };
}

/**
 * Energy the connector could not physically have delivered in the time.
 *
 * Nameplate power × duration, with 25 % headroom for a nameplate that
 * understates the hardware and 1 kWh for clock granularity and registers that
 * tick in whole kWh. Above that the number is suspect and the session says so
 * (a warning on the receipt and in the explorer). It is PARKED (a violation)
 * only when the excess is gross, over IMPLAUSIBLE_PARK_EXCESS_WH: a lifetime
 * register taken as a start of zero (8,450 kWh in a 40-minute session) or a
 * kWh/Wh mix-up is thousands of kWh out, while a charger clock that stepped
 * mid-session (an NTP correction) can shorten the reported duration by a few
 * minutes, and parking every such session would make the review queue noise.
 * Only asserted when both the nameplate and the duration are known; neither is
 * ever guessed.
 */
export const IMPLAUSIBLE_PARK_EXCESS_WH = 20_000;

export function implausibleEnergyFlag(energyWh: number, durationS: number, maxPowerW: number | null | undefined): SessionFlag | null {
  const w = Number(maxPowerW);
  if (!Number.isFinite(w) || w <= 0 || !(durationS > 0)) return null;
  const limitWh = w * (durationS / 3600) * 1.25 + 1000;
  if (!(energyWh > limitWh)) return null;
  const gross = energyWh - limitWh > IMPLAUSIBLE_PARK_EXCESS_WH;
  return {
    code: 'IMPLAUSIBLE_ENERGY',
    severity: gross ? 'violation' : 'warning',
    message:
      `${energyWh} Wh in ${Math.round(durationS / 60)} min exceeds what a ${w} W connector can ` +
      `deliver (${Math.round(limitWh)} Wh with headroom).${gross ? ' Parked for review.' : ' Check the meter and the charger clock.'}`,
  };
}

function clockSkewFlag(timestamp: string): SessionFlag | null {
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t)) {
    return { code: 'UNPARSEABLE_TIMESTAMP', severity: 'violation', message: `Timestamp ${timestamp} is not a date.` };
  }
  const skewH = Math.abs(t - Date.now()) / 3_600_000;
  if (skewH > config.limits.maxClockSkewHours) {
    // A charger booting with a 1970 clock previously produced a rating loop that
    // blocked the event loop for an estimated 84 minutes, taking the gateway
    // down for every other charger on it.
    return {
      code: 'IMPLAUSIBLE_CLOCK',
      severity: 'violation',
      message: `Charger clock is ${Math.round(skewH)} h from server time (${timestamp}). Session parked.`,
    };
  }
  return null;
}

/**
 * Detect a plausible register wrap.
 *
 * Binary widths cover firmware counters; DECIMAL widths cover the 6- and 7-digit
 * kWh registers that mechanical and legal-for-trade meters actually roll over on,
 * and which a binary-only detector misses — leaving a real delivery parked as a
 * "meter went backwards" violation.
 *
 * THE TEST IS THE SHAPE OF A WRAP, NOT THE SIZE OF THE RESULT.
 *
 * The previous version accepted any candidate whose implied delivery was
 * "session-sized" (< 500 kWh). That is not a test at all for the small widths:
 * for any `startWh` below 65,536 the 16-bit candidate yields
 * `65536 - startWh + stopWh`, which is ALWAYS under 500 kWh — so every backwards
 * reading on a charger whose lifetime register had not yet passed 65.5 kWh was
 * classified as a wrap and billed. That is every newly commissioned unit, every
 * board or meter replacement, and every Wh/kWh unit-mismatch quirk. A charger
 * that started at 45,000 Wh and reported 0 at the end billed 20,536 Wh of
 * energy that was never delivered — from a UTTP-certified meter that registered
 * none of it.
 *
 * A genuine wrap has a signature: the start register was near the TOP of its
 * width and the stop register has just restarted near ZERO. Both halves must
 * hold. A meter that went from 60,000 to 55,000 satisfies neither and is a
 * fault or a tamper, which must be parked, never billed.
 *
 * `knownWidth` comes from the vendor quirk registry when the model's register
 * width has actually been observed; supplying it removes the guesswork entirely.
 */
const NEAR_TOP = 0.9;
const NEAR_BOTTOM = 0.05;

export function detectRollover(
  startWh: number,
  stopWh: number,
  knownWidth?: number,
): { width: string; energyWh: number } | null {
  const candidates: Array<[string, number]> = knownWidth
    ? [[`declared ${knownWidth}`, knownWidth]]
    : [
        // 16-bit is deliberately absent: a 65.5 kWh lifetime register does not
        // exist on real hardware, and including it made every young meter's
        // backwards reading look like a wrap.
        ['6-digit Wh', 1_000_000],
        ['24-bit', 2 ** 24],
        ['7-digit Wh', 10_000_000],
        ['8-digit Wh', 100_000_000],
        ['32-bit', 2 ** 32],
        ['6-digit kWh', 1_000_000_000],
      ];

  for (const [width, max] of candidates) {
    if (startWh >= max) continue;
    if (startWh < max * NEAR_TOP) continue; // the register was nowhere near overflowing
    if (stopWh > max * NEAR_BOTTOM) continue; // and it has not restarted from zero
    const energy = max - startWh + stopWh;
    if (energy > 0 && energy < 500_000) return { width, energyWh: Math.round(energy) };
  }
  return null;
}

/**
 * Minutes at the end of the session during which no energy was delivered.
 *
 * "Last material increase", not "maximum value". `ORDER BY value DESC LIMIT 1`
 * was wrong in both directions:
 *
 *   - A car that finishes charging but keeps a small maintenance trickle makes
 *     the FINAL sample the maximum, so idle collapsed to zero and the occupancy
 *     fee — the whole point of which is to move the car — never fired.
 *   - After a genuine register wrap the maximum is a PRE-wrap sample, so idle
 *     inflated to nearly the whole session and the customer was charged an
 *     occupancy fee for time they spent charging.
 *
 * IDLE_THRESHOLD_WH is what separates "still charging slowly" from "parked":
 * below it, the vehicle is drawing maintenance current, not taking a charge.
 *
 * The comparison is in Wh OF THE REGISTER, and it was not: `value - prev` ran on
 * raw meter_value rows whatever their unit or phase. A charger reporting kWh
 * never moved 50 "units" between samples, so idle was the whole session; one
 * reporting per phase interleaved L1/L2/L3 rows at the same timestamp, so every
 * phase-to-phase step looked like a delivery (or a regression) and idle was
 * never. The register is rebuilt per timestamp exactly as canonical.ts reads
 * one (registerFromEntry): kWh normalised to Wh, the untagged total when there
 * is one, otherwise the sum of the per-phase registers. One row per timestamp
 * also makes the lag order total — meter_value has no id to break ts ties with,
 * and duplicate (replayed) rows collapse instead of reading as zero-deltas.
 */
const IDLE_THRESHOLD_WH = 50;

async function computeIdleMinutes(client: Pick<PoolClient, 'query'>, sessionId: string, endedAt: Date): Promise<number> {
  const r = await client.query<{ ts: Date }>(
    `WITH per_phase AS (
       SELECT ts, phase,
              max(CASE WHEN lower(COALESCE(unit, 'Wh')) = 'kwh' THEN value * 1000 ELSE value END) AS wh
         FROM meter_value
        WHERE session_id = $1 AND measurand = 'Energy.Active.Import.Register'
          AND (phase IS NULL OR phase IN ('L1', 'L2', 'L3', 'L1-N', 'L2-N', 'L3-N'))
        GROUP BY ts, phase
     ), register AS (
       SELECT ts,
              COALESCE(max(wh) FILTER (WHERE phase IS NULL), sum(wh) FILTER (WHERE phase IS NOT NULL)) AS wh
         FROM per_phase
        GROUP BY ts
     ), series AS (
       SELECT ts, wh, lag(wh) OVER (ORDER BY ts) AS prev
         FROM register
     )
     SELECT ts FROM series
      WHERE prev IS NULL OR wh - prev >= $2
      ORDER BY ts DESC
      LIMIT 1`,
    [sessionId, IDLE_THRESHOLD_WH],
  );
  const lastIncrease = r.rows[0]?.ts;
  if (!lastIncrease) return 0;
  const minutes = (endedAt.getTime() - new Date(lastIncrease).getTime()) / 60_000;
  return Math.max(0, Math.round(minutes));
}

// ------------------------------------------------------------ running cost

export interface RunningCost {
  /** What the driver pays if the charge stopped now, PBJT-TL and PPN included. */
  totalIdr: number;
  subtotalIdr: number;
  /** PBJT-TL plus PPN. */
  taxIdr: number;
  /** Memberships, promotions, loyalty points and energy given back, already taken off. */
  discountIdr: number;
  /** Idle fee so far (plugged in, no longer drawing). Included in the total. */
  idleFeeIdr: number;
  idleMinutes: number;
  energyWh: number;
  /** When it was worked out. */
  asOf: string;
  /** True once the charge record exists: the figures are the bill, not an estimate. */
  final: boolean;
}

/** The scoped `query` helper in the shape computeIdleMinutes takes (keeps row-level security). */
const scoped = { query: (text: string, params?: unknown[]) => query(text, params) } as unknown as Pick<PoolClient, 'query'>;

/**
 * Cache of estimates. Pricing reads the tariff, memberships, promotions and loyalty points, and the
 * driver app polls every few seconds while the gateway's Live Activity pass runs every 5 s; the
 * figures only change when energy, idle time or the minute changes, so that is the key.
 */
const costCache = new Map<string, { key: string; at: number; value: RunningCost }>();
const COST_CACHE_MAX = 5_000;
const COST_CACHE_TTL_MS = 5 * 60_000;

function remember(sessionId: string, key: string, value: RunningCost, now: number) {
  if (costCache.size >= COST_CACHE_MAX) {
    for (const [k, v] of costCache) if (now - v.at > COST_CACHE_TTL_MS) costCache.delete(k);
    if (costCache.size >= COST_CACHE_MAX) costCache.delete(costCache.keys().next().value!);
  }
  costCache.set(sessionId, { key, at: now, value });
}

function figures(lines: CdrLineLike[]) {
  let discountIdr = 0;
  for (const d of adjustmentTotals(lines as any).values()) discountIdr += d.discountIdr;
  const idleFeeIdr = lines.filter((l) => l.kind === 'idle' && !l.adjustment).reduce((a, l) => a + Number(l.amountIdr), 0);
  return { discountIdr, idleFeeIdr };
}
type CdrLineLike = { kind: string; amountIdr: number; adjustment?: unknown };

/**
 * The cost of a charge so far: priced exactly as the final charge record will be (same tariff as of
 * the start, the cheapest membership / promotion combination, energy given back, loyalty points,
 * PBJT-TL and PPN), as if the charge stopped now. Idle time is counted up to now, so a car left
 * plugged in after it is full shows the idle fee rising.
 *
 * Once the charge record exists, returns its figures with `final: true`. Reads only.
 */
export async function runningCost(sessionId: string, now = new Date()): Promise<RunningCost | null> {
  const s = await one<any>(PRICING_SELECT, [sessionId]);
  if (!s) return null;

  const cdr = await one<{ lines: CdrLineLike[]; subtotal_idr: number; pbjt_idr: number; ppn_idr: number; total_idr: number; issued_at: Date }>(
    `SELECT lines, subtotal_idr, pbjt_idr, ppn_idr, total_idr, issued_at FROM cdr WHERE session_id = $1`, [sessionId]);
  if (cdr) {
    const f = figures(cdr.lines ?? []);
    return {
      totalIdr: Number(cdr.total_idr), subtotalIdr: Number(cdr.subtotal_idr), taxIdr: Number(cdr.pbjt_idr) + Number(cdr.ppn_idr),
      ...f, idleMinutes: Number(s.idle_minutes ?? 0), energyWh: Number(s.energy_wh),
      asOf: new Date(cdr.issued_at).toISOString(), final: true,
    };
  }

  const active = s.state === 'active';
  const endedAt = active || !s.ended_at ? now : new Date(s.ended_at);
  const idleMinutes = active ? await computeIdleMinutes(scoped, sessionId, now) : Number(s.idle_minutes ?? 0);
  const energyWh = Number(s.energy_wh ?? 0);
  const key = [s.state, energyWh, Number(s.energy_export_wh ?? 0), idleMinutes, Math.floor(endedAt.getTime() / 60_000)].join('|');
  const hit = costCache.get(sessionId);
  if (hit && hit.key === key && now.getTime() - hit.at < COST_CACHE_TTL_MS) return hit.value;

  const { result } = await priceSession(s, { endedAt, energyWh, idleMinutes });
  const value: RunningCost = {
    totalIdr: result.tax.totalIdr,
    subtotalIdr: result.tax.subtotalIdr,
    taxIdr: result.tax.pbjtIdr + result.tax.ppnIdr,
    ...figures(result.lines),
    idleMinutes,
    energyWh,
    asOf: now.toISOString(),
    final: false,
  };
  remember(sessionId, key, value, now.getTime());
  return value;
}

/** Test support: forget cached estimates. */
export function clearRunningCostCache(): void { costCache.clear(); }

async function addFlag(sessionId: string, flag: SessionFlag, client?: any) {
  const sql = `UPDATE charging_session SET flags = flags || $2::jsonb WHERE id = $1`;
  const params = [sessionId, JSON.stringify([flag])];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

/**
 * Bind a pre-purchase to the session that is entitled to it.
 *
 * The entitlement is the TOKEN, not the connector. This used to take the newest
 * unclaimed intent on the connector and hand it to whoever started the next
 * transaction, so a driver who scanned the QR and paid Rp 500,000 lost the whole
 * amount to anyone who plugged in first — with no refund path anywhere in the
 * system. It also silently orphaned the earlier of two queued payers.
 *
 * `idTag` is the token the charger presented. It must equal the `claim_id_tag`
 * recorded at checkout — either the driver's own token, or one PlugSure minted
 * and displayed on the payment screen for a walk-up.
 *
 * Intents written before migration 005 carry no claim token. They are still
 * honoured (refusing them would strand real money) but they are the legacy
 * shape and the caller flags the session so it is visible.
 */
/**
 * How long after checkout a paid prepurchase can start a session. One constant,
 * shared by the claim below, the claim-token check in authorizeIdTag, the token
 * expiry at checkout and the unused-payment refund sweep — they must agree, or
 * a token outlives its payment (the unlimited-free-session defect).
 */
export const PREPAID_CLAIM_WINDOW_MIN = 30;

async function claimPrepaidIntent(connectorUuid: string, idTag: string | null, client: Pick<PoolClient, 'query'>) {
  const r = await client.query<{
    id: string;
    amount_authorised_idr: number;
    allowance_wh: number;
    claim_id_tag: string | null;
  }>(
    `UPDATE payment_intent
        -- A card hold stays authorised: it is captured for what the session costs when it is rated.
        SET state = CASE WHEN mode IN ('preauth', 'postpay') THEN state ELSE 'captured' END,
            captured_at = CASE WHEN mode IN ('preauth', 'postpay') THEN captured_at ELSE COALESCE(captured_at, now()) END
      WHERE id = (
        SELECT id FROM payment_intent
         WHERE connector_uuid = $1 AND mode IN ('prepurchase', 'preauth', 'postpay')
           AND (mode NOT IN ('preauth', 'postpay') OR hold_state = 'held')
           AND state IN ('captured', 'authorised') AND session_id IS NULL
           AND refund_state IS NULL   -- a payment being refunded cannot also buy energy
           AND created_at > now() - make_interval(mins => ${PREPAID_CLAIM_WINDOW_MIN})
           AND (
             -- the payer is starting this session...
             ($2::text IS NOT NULL AND claim_id_tag = $2)
             -- ...or the intent predates payer binding entirely
             OR claim_id_tag IS NULL
           )
         -- Prefer an exact payer match over a legacy unbound intent, and take
         -- the OLDEST match so a queue is served in the order it paid.
         ORDER BY (claim_id_tag IS NOT NULL) DESC, created_at ASC
         LIMIT 1
      )
      RETURNING id, amount_authorised_idr, allowance_wh, claim_id_tag`,
    [connectorUuid, idTag],
  );
  return r.rows[0] ?? null;
}

async function insertMeterValues(sessionId: string, mv: CanonicalMeterValue[], client?: any) {
  const runner = client ?? { query };
  for (const m of mv) {
    for (const sv of m.sampledValue) {
      if (!Number.isFinite(sv.value)) continue;
      await runner.query(
        `INSERT INTO meter_value (session_id, ts, measurand, phase, value, unit)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sessionId, m.timestamp, sv.measurand, sv.phase ?? null, sv.value, sv.unit ?? null],
      );
    }
  }
  // Signed readings (OCMF) are kept as received, with their signature checked (signed-metering.ts).
  // Losing one must never lose the plain samples above.
  await storeSigned(sessionId, mv, runner).catch((e) => logger.warn({ sessionId, err: String(e) }, 'signed meter values not stored'));
}

async function resolveTokenId(orgId: string, uid: string): Promise<string | null> {
  // A Plug & Charge contract may arrive as the eMAID with separators.
  const t = await one<{ id: string }>(
    `SELECT id FROM token WHERE org_id = $1 AND (uid = $2 OR (kind = 'emaid' AND uid = $3)) ORDER BY (uid = $2) DESC LIMIT 1`,
    [orgId, uid, normaliseEmaid(uid)],
  );
  return t?.id ?? null;
}

export async function activeSessionOnConnector(connectorUuid: string) {
  return one<SessionRow>(
    `SELECT * FROM charging_session WHERE connector_uuid = $1 AND state = 'active' ORDER BY started_at DESC LIMIT 1`,
    [connectorUuid],
  );
}

export async function recentSessions(orgId: string, limit = 50, siteIds: string[] | null = null) {
  return many(
    `SELECT cs.id, cs.started_at, cs.ended_at, cs.state, cs.energy_wh, cs.duration_s,
            cs.stop_reason, cs.needs_review, cs.review_reason, cs.flags, cs.idle_minutes,
            cs.payment_mode, cs.prepaid_amount_idr, cs.prepaid_energy_wh,
            cp.ocpp_identity, e.evse_id AS evse_no, s.name AS site_name,
            d.total_idr, d.subtotal_idr, d.pbjt_idr, d.ppn_idr, d.ppn_dpp_idr, d.lines,
            d.regulatory_flags
       FROM charging_session cs
       JOIN charge_point cp ON cp.id = cs.charge_point_id
       JOIN connector c ON c.id = cs.connector_uuid
       JOIN evse e ON e.id = c.evse_uuid
       JOIN site s ON s.id = cs.site_id
       LEFT JOIN cdr d ON d.session_id = cs.id
      WHERE cs.org_id = $1
        AND ($3::uuid[] IS NULL OR cs.site_id = ANY($3))
      ORDER BY cs.started_at DESC
      LIMIT $2`,
    [orgId, limit, siteIds],
  );
}
