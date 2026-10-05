import { createHash } from 'node:crypto';
import { currencyOr, moneyText } from '../domain/money.js';
import { assertCountry, currencyOfCountry, countryOfCurrency } from '../domain/country.js';
import { defaultTimezone } from '../domain/timezone.js';
import { resolveTaxContext } from './tax/index.js';
import { upgradeLegacyKeys } from '../domain/money.js';
import type { PoolClient } from 'pg';
import { one, many, query, tx } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { bus } from './events.js';
import { getConnector, type ConnectorRow } from './assets.js';
import { rateSession, adjustmentTotals, type Tariff, type PriceAdjustment, type RatingResult } from './tariff.js';
import { redemptionFor, pointsToRedeem, pointsAdjustment, discountable, recordLoyalty, lockedBalance } from './loyalty.js';
import { benefitsFor, adjustmentOptions, pickCheapest, recordBenefits, reservePromotion, type Who, type Benefits } from './benefits.js';
import { loadTariffForConnector } from './tariff-store.js';
import type { CanonicalMeterValue, TransactionEvent } from '../domain/canonical.js';
import { energyWhFrom, energySeriesFrom, powerWFrom } from '../domain/canonical.js';
import { markRefundDue } from './refunds.js';
import { linkRoamingSession } from '../ocpi/authorize.js';
import { normaliseEmaid } from '../pnc/emaid.js';
import { attachNeeds, applyFleetConsent, trackMeter, creditMinor } from './v2x.js';
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
  prepaid_amount_minor: number | null;
  prepaid_energy_wh: number | null;
  payment_mode: string | null;
  flags: unknown[];
  token_id?: string | null;
  ocpi_token_id?: string | null;
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
  /** UNAUTHORISED_TOKEN: the token that was refused (the session binds none). */
  idToken?: string;
}

/**
 * A transaction the charger reports as ALREADY RUNNING although its token (or
 * the station itself) was not authorised: an offline start with a card that has
 * since been blocked, a 2.0.1 `offline: true` upload, a start replayed long after
 * the fact. The energy was delivered whatever the CSMS answers now, so refusing
 * to record it loses it — and in 1.6 every refused transaction used to share
 * transactionId 0, so its MeterValues and StopTransaction went nowhere.
 *
 * Such a start is RECORDED, never billed: no payer (no token bound, no prepaid
 * intent claimed — someone else's payment must never cover it, and no roaming
 * partner is told about a session it never approved), and parked with a
 * violation flag so no CDR is issued until an operator has looked at it.
 */
export interface UnauthorisedStart {
  /** Flag / review code: UNAUTHORISED_TOKEN, or STATION_NOT_IN_SERVICE for a suspended unit. */
  code: string;
  /** What the authoriser said (Blocked, Invalid, Expired, ConcurrentTx, …). */
  status: string;
  /** The operator-facing explanation. */
  message: string;
}

export interface TransactionEventOptions {
  /** Started only: record the start as unauthorised (see UnauthorisedStart). */
  unauthorised?: UnauthorisedStart;
  /**
   * Ended only, OCPP 2.0.1/2.1: an Ended event for a transaction the CSMS never
   * saw start is recorded from what the event carries, parked for review
   * (recordUnknownEnd). 1.6 never sets it: a 1.6 StopTransaction for an unknown
   * id is most often the stop of a live start we refused, and stays log-only.
   */
  reconstructUnknownEnd?: boolean;
}

export async function handleTransactionEvent(
  ev: TransactionEvent,
  chargePointId: string,
  opts: TransactionEventOptions = {},
): Promise<SessionRow | null> {
  const connector = await getConnector(chargePointId, ev.evse.evseId);
  if (!connector) {
    logger.warn({ cp: ev.evse.ocppIdentity, evseId: ev.evse.evseId }, 'transaction for unknown connector');
    return null;
  }

  switch (ev.eventType) {
    case 'Started':
      return startSession(ev, connector, opts.unauthorised ?? null);
    case 'Updated':
      return updateSession(ev, connector);
    case 'Ended':
      return endSession(ev, connector, opts.reconstructUnknownEnd === true);
  }
}

// ------------------------------------------------------------------ start

/**
 * A start the CSMS will not record. Thrown by handleTransactionEvent(Started);
 * the adapters answer it the way they answer a token the authoriser refused
 * (1.6: transactionId 0 with idTagInfo.status; 2.0.1: idTokenInfo.status), so
 * the charger stops instead of charging against a session that does not exist.
 */
export class SessionStartRefused extends Error {
  constructor(public status: 'Invalid' | 'ConcurrentTx', message: string) {
    super(message);
    this.name = 'SessionStartRefused';
  }
}

async function startSession(ev: TransactionEvent, c: ConnectorRow, unauthorised: UnauthorisedStart | null): Promise<SessionRow | null> {
  /**
   * An ABSENT start register is not a zero one. OCPP 2.0.1 makes meterValue on
   * TransactionEvent(Started) optional, and `?? 0` here made the first Updated
   * sample — the charger's lifetime register, 8,450,000 Wh in the reproduction —
   * the session's energy. The start is recorded as unknown instead and taken
   * from the first register the session observes (updateSession / endSession).
   */
  const observedStartWh = energyWhFrom(ev.meterValue);
  const startWh = observedStartWh ?? 0;
  // An unauthorised start binds no token: the session has no payer until an
  // operator decides who (if anyone) it is billed to. The presented token is
  // kept in the flag for that review.
  const token = ev.idToken && !unauthorised ? await resolveToken(c.org_id, ev.idToken.idToken) : null;
  const tokenId = token?.id ?? null;
  const flags: SessionFlag[] = [];

  if (unauthorised) flags.push(unauthorisedFlag(unauthorised, ev.idToken?.idToken ?? null));

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
    if (same.rows[0]) return { row: same.rows[0], created: false, prepaid: null, orphans: [] as Orphan[], refused: null };

    // A prepaid intent parked on this connector claims the session it starts —
    // but only the intent whose PAYER is the token starting it. Claimed under
    // the lock, so a duplicate start cannot claim a second intent.
    // An unauthorised start claims nothing: a payment is never spent on energy
    // nobody authorised.
    const prepaidToken = token?.kind === 'prepaid';
    const prepaid = unauthorised ? null : await claimPrepaidIntent(c.id, ev.idToken?.idToken ?? null, client, prepaidToken);

    /**
     * A PREPAID CLAIM TOKEN STARTS ONLY THE SESSION IT PAID FOR.
     *
     * The token is nothing but a key to its payment, and the payment is for ONE
     * connector. Presented anywhere else — another connector, another charger
     * at the operator's sites, or while its own session is still running — the
     * claim above finds nothing, and the session used to start anyway as
     * `postpaid`: no allowance, and no payer (whoForSession drops a prepaid
     * token as a customer). The driver charged without limit, billed to nobody,
     * and the refund sweep then returned the untouched payment in full.
     *
     * The authoriser (adapter16.authorizeIdTag) already refuses these when it
     * knows the connector; this is the authoritative check, under the
     * connector's lock, so no path can turn a prepaid token into a postpaid
     * session. Refused BEFORE any orphan is closed: a refused start changes
     * nothing on the connector.
     */
    if (prepaidToken && !prepaid) {
      const status = await prepaidRefusalStatus(client, c.org_id, ev.idToken!.idToken);
      return { row: null, created: false, prepaid: null, orphans: [] as Orphan[], refused: status };
    }

    // A new transaction on a connector we still believe is busy means we missed
    // a stop. Close the stale one for review rather than losing either session.
    const orphans = await closeOrphansLocked(client, c.charge_point_id, ev.evse.evseId, ev.idemKey, 'superseded by a new transaction');

    const ins = await client.query<SessionRow & { inserted: boolean }>(
      `INSERT INTO charging_session
          (org_id, site_id, connector_uuid, charge_point_id, idem_key, ocpp_transaction_id,
           token_id, state, started_at, meter_start_wh, meter_start_unknown, energy_wh, payment_mode,
           prepaid_amount_minor, prepaid_energy_wh, payment_intent_id, flags, needs_review, review_reason, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,0,$11,$12,$13,$14,$15,$16,$17,
               -- Frozen here from the site's country, never re-derived (docs/MULTI-COUNTRY-DESIGN.md §5.5).
               (SELECT co.currency FROM site si JOIN country co ON co.code = si.country_code WHERE si.id = $2))
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
        prepaid?.amount_authorised_minor ?? null,
        prepaid?.allowance_wh ?? null,
        prepaid?.id ?? null,
        JSON.stringify(flags),
        flags.some((f) => f.severity === 'violation'),
        // The reason the review queue shows: the first violation, decided at the start.
        flags.find((f) => f.severity === 'violation')?.code ?? null,
      ],
    );
    const { inserted, ...row } = ins.rows[0]!;
    // Bound inside the lock too: an intent claimed but not yet pointed at its
    // session is still claimable by the next start on this connector.
    if (prepaid && inserted) {
      await client.query(`UPDATE payment_intent SET session_id = $2 WHERE id = $1`, [prepaid.id, row.id]);
    }
    return { row: row as SessionRow, created: inserted, prepaid, orphans, refused: null };
  });

  if (started.refused) {
    logger.warn(
      { cp: ev.evse.ocppIdentity, evseId: ev.evse.evseId, tx: ev.transactionId, status: started.refused },
      'prepaid claim token presented where it has no claimable payment — start refused',
    );
    throw new SessionStartRefused(started.refused, 'This prepaid token has no claimable payment on this connector.');
  }
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
    // Never for an unauthorised start: the partner did not approve it.
    if (!tokenId && ev.idToken && !unauthorised) await linkRoamingSession(row.id, c.org_id, ev.idToken.idToken);
    if (unauthorised) {
      logger.warn(
        { sessionId: row.id, cp: ev.evse.ocppIdentity, tx: ev.transactionId, status: unauthorised.status, code: unauthorised.code },
        'unauthorised transaction reported by the charger — recorded and parked for review, not billed',
      );
      bus.emit('alert.raised', {
        orgId: row.org_id,
        kind: 'session.unauthorised',
        severity: 'warning',
        message: `${ev.evse.ocppIdentity} reported a transaction that was not authorised (${unauthorised.status}). ` +
          `Session ${row.id} is recorded for review and will not be billed automatically.`,
      });
    }
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

// ------------------------------------------------------------------ late token

/**
 * The session for this transaction is still waiting for its token: running,
 * no own token and no roaming token bound, and this token not already refused
 * on it. Read-only: the adapter asks before authorising, so a station that
 * repeats the idToken on every Updated event is authorised once, not per frame.
 */
export async function sessionAwaitsToken(chargePointId: string, transactionId: string, idTag: string): Promise<boolean> {
  const r = await one<{ waiting: boolean }>(
    `SELECT (token_id IS NULL AND ocpi_token_id IS NULL
             AND NOT flags @> jsonb_build_array(jsonb_build_object('idToken', $3::text))) AS waiting
       FROM charging_session
      WHERE charge_point_id = $1 AND ocpp_transaction_id = $2 AND state = 'active'
      ORDER BY started_at DESC LIMIT 1`,
    [chargePointId, transactionId, idTag],
  );
  return r?.waiting === true;
}

/**
 * A token presented AFTER the transaction started (OCPP 2.0.1).
 *
 * With TxStartPoint=EVConnected (or PowerPathClosed) the station starts the
 * transaction at plug-in, before anyone has authorised, and the idToken arrives
 * on a later Updated event (triggerReason Authorized). It used to be ignored:
 * the session ran — and was billed — with no token, no payer, no prepaid
 * allowance and no roaming link, and the station was never told whether the
 * token was any good.
 *
 * Now the first token seen on a session that has none goes through what a token
 * at the start goes through. `auth` is the authoriser's verdict (adapter16.
 * authorizeIdTag, with the EVSE, so a prepaid claim token is checked against the
 * connector its payment is for). Under the connector's session-start lock — the
 * same lock that serialises prepaid claims at start, so one payment can never be
 * claimed by two sessions — the session row is locked and:
 *
 *   - Accepted: the token is bound; a prepaid claim token must claim ITS payment
 *     on this connector (or the verdict becomes the start-time refusal status);
 *     a token that is not one of the operator's own is linked to its roaming
 *     partner after the commit.
 *   - anything else: nothing is bound, and the session is flagged
 *     UNAUTHORISED_TOKEN and parked for review — the station is told the status
 *     and should stop, but what it already delivered is recorded, not billed.
 *
 * Returns the final status for the station's idTokenInfo, or null when there is
 * nothing to do (unknown transaction, session no longer running, or already
 * carrying a token).
 */
export async function attachLateToken(
  ev: TransactionEvent,
  chargePointId: string,
  auth: { status: string; code?: string; message?: string },
): Promise<{ status: string; sessionId: string } | null> {
  const idTag = ev.idToken?.idToken;
  if (!idTag) return null;
  const c = await getConnector(chargePointId, ev.evse.evseId);
  if (!c) return null;
  const token = await resolveToken(c.org_id, idTag);

  const out = await tx(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('session-start:' || $1::text || ':' || $2::text, 0))`,
      [c.charge_point_id, ev.evse.evseId],
    );
    const cur = await client.query<SessionRow>(
      `SELECT * FROM charging_session
        WHERE charge_point_id = $1 AND ocpp_transaction_id = $2
        ORDER BY started_at DESC LIMIT 1
        FOR UPDATE`,
      [c.charge_point_id, ev.transactionId],
    );
    const row = cur.rows[0];
    if (!row || row.state !== 'active' || row.token_id || row.ocpi_token_id) return null;

    let status = auth.status;
    let prepaid: Awaited<ReturnType<typeof claimPrepaidIntent>> = null;
    if (status === 'Accepted' && token?.kind === 'prepaid') {
      prepaid = await claimPrepaidIntent(c.id, idTag, client, true);
      if (!prepaid) status = await prepaidRefusalStatus(client, c.org_id, idTag);
    }

    if (status !== 'Accepted') {
      const flag = unauthorisedFlag(
        { code: auth.code ?? 'UNAUTHORISED_TOKEN', status, message: auth.message ?? `The token presented during the transaction was refused (${status}).` },
        idTag,
      );
      await client.query(
        `UPDATE charging_session
            SET flags = flags || $2::jsonb, needs_review = true, review_reason = COALESCE(review_reason, $3)
          WHERE id = $1`,
        [row.id, JSON.stringify([flag]), flag.code],
      );
      return { status, sessionId: row.id, orgId: row.org_id, refused: true, roaming: false };
    }

    await client.query(
      `UPDATE charging_session
          SET token_id = $2,
              payment_mode = CASE WHEN $3::uuid IS NOT NULL THEN 'prepurchase' ELSE payment_mode END,
              payment_intent_id = COALESCE($3, payment_intent_id),
              prepaid_amount_minor = COALESCE($4, prepaid_amount_minor),
              prepaid_energy_wh = COALESCE($5, prepaid_energy_wh)
        WHERE id = $1`,
      [row.id, token?.id ?? null, prepaid?.id ?? null, prepaid?.amount_authorised_minor ?? null, prepaid?.allowance_wh ?? null],
    );
    if (prepaid) await client.query(`UPDATE payment_intent SET session_id = $2 WHERE id = $1`, [prepaid.id, row.id]);
    return { status, sessionId: row.id, orgId: row.org_id, refused: false, roaming: !token };
  });
  if (!out) return null;

  if (out.refused) {
    logger.warn({ sessionId: out.sessionId, cp: ev.evse.ocppIdentity, tx: ev.transactionId, status: out.status }, 'token presented during the transaction was refused — session parked for review');
    bus.emit('alert.raised', {
      orgId: out.orgId,
      kind: 'session.unauthorised',
      severity: 'warning',
      message: `${ev.evse.ocppIdentity}: the token presented during session ${out.sessionId} was refused (${out.status}). ` +
        'The session is recorded for review and will not be billed automatically.',
    });
  } else {
    // A roaming partner's driver: linked now, as it would have been at the start.
    if (out.roaming) await linkRoamingSession(out.sessionId, out.orgId, idTag).catch((e) =>
      logger.warn({ sessionId: out.sessionId, err: String(e) }, 'roaming link for a late token failed'));
    logger.info({ sessionId: out.sessionId, cp: ev.evse.ocppIdentity, tx: ev.transactionId }, 'token bound to a running session');
  }
  return { status: out.status, sessionId: out.sessionId };
}

// ------------------------------------------------------------------ end

async function endSession(ev: TransactionEvent, c: ConnectorRow, reconstructUnknown = false): Promise<SessionRow | null> {
  let unknown = false;
  // Set when the stop finds the session already closed: a replayed Ended /
  // StopTransaction (stations resend from their offline queue until they see a
  // response), or the replay of an Ended that recordUnknownEnd reconstructed.
  let replay = false;
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
      if (!reconstructUnknown) logger.warn({ tx: ev.transactionId }, 'stop for unknown transaction — replay of a lost start?');
      unknown = true;
      return null;
    }
    if (row.state !== 'active') {
      // Idempotent: a replayed stop is a no-op. Returning the row alone was not
      // enough — the caller then saw `state = 'ended'` and announced the end
      // again (session.ended to OCPI partners and the driver app) and re-ran
      // rating, which for a parked session re-raised the needs-review alert on
      // every replay. The `replay` flag makes the caller stop here too.
      replay = true;
      return row;
    }

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
    // The 1.6 adapter only reports a divergence that is a real disagreement
    // (adapter16.onStopTransaction): a Transaction.End register that differs
    // from meterStop, or a sampled register ABOVE meterStop. A last periodic
    // sample below meterStop is the normal lag of StopTxnSampledData and is not
    // one — reporting it parked nearly every DC session.
    const divergence = ev.divergenceWh ?? 0;
    if (divergence > 1) {
      const share = energy > 0 ? divergence / energy : 1;
      const material = divergence > DIVERGENCE_MATERIAL_WH || share > DIVERGENCE_MATERIAL_SHARE;
      flags.push({
        code: 'METER_SOURCES_DIVERGE',
        severity: material ? 'violation' : 'warning',
        message:
          `transactionData and meterStop differ by ${divergence} Wh ` +
          `(${(share * 100).toFixed(1)}% of the billed energy); billed the Transaction.End register, ` +
          `or the higher of the two when there is none.` +
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

  if (unknown && reconstructUnknown) return recordUnknownEnd(ev, c);
  // A replay changes nothing: no event, no alert, no rating. A session that
  // ended but whose rating crashed is not stranded by this — the reconciliation
  // pass (reconcileStuckSessions) re-rates ended sessions without a CDR.
  if (replay) return result;
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

// ------------------------------------------------------------------ end of an unknown transaction

/**
 * An OCPP 2.0.1 TransactionEvent(Ended) for a transaction the CSMS never saw
 * start: its Started was lost (sent while the WebSocket was half-open, dropped
 * by a station whose offline queue overflowed, or answered after the station had
 * given up), or it predates the station's adoption. It used to be logged and
 * dropped — and the energy with it.
 *
 * Unlike a 1.6 StopTransaction, an Ended event carries enough to record the
 * transaction: its transactionId, the EVSE, the end time, stoppedReason, usually
 * the token, and the meter values the station was configured to send at the end
 * (SampledDataTxEndedMeasurands — often Transaction.Begin AND Transaction.End).
 * It is recorded the way an after-the-fact unauthorised start is (startSession
 * with `unauthorised`): a session with NO payer — the token is kept in the flag
 * for the reviewer, never bound — no prepaid claim, no roaming link, parked with
 * a violation so no CDR is issued until an operator decides. Nothing is billed.
 *
 * It is written straight in its ended state rather than through startSession:
 * a start would close whatever session is running on the EVSE NOW as
 * "superseded", attach that session's charging needs, and announce a
 * session.started / session.ended (OCPI partners, the driver app) for a
 * transaction nobody approved. The idempotency key is derived from the
 * transactionId, so a replayed Ended finds the recorded row and changes nothing.
 *
 * Energy: the spread of the registers the event carries (lowest to highest).
 * With fewer than two registers the start is unknown and 0 Wh is recorded with
 * the end register kept for the reviewer — never the lifetime register.
 *
 * Not recorded: an Ended with stoppedReason DeAuthorized that shows no energy.
 * That is the station ending a start we refused live (it opened no session, by
 * design) — recording each one would bury the review queue in refused cards.
 */
async function recordUnknownEnd(ev: TransactionEvent, c: ConnectorRow): Promise<SessionRow | null> {
  const series = energySeriesFrom(ev.meterValue);
  const endWh = energyWhFrom(ev.meterValue);
  const startKnown = series.length >= 2 && endWh !== null;
  const startWh = startKnown ? Math.min(...series) : (endWh ?? 0);
  const energy = startKnown ? Math.max(0, endWh! - startWh) : 0;

  if (ev.stoppedReason === 'DeAuthorized' && energy <= 0) {
    logger.warn(
      { cp: ev.evse.ocppIdentity, tx: ev.transactionId, seqNo: ev.seqNo },
      'Ended (DeAuthorized, no energy) for an unknown transaction — the end of a start that was refused; not recorded',
    );
    return null;
  }

  // The start time is not known; the earliest time the event mentions stands in for it.
  const endMs = Date.parse(ev.timestamp);
  const times = ev.meterValue.map((m) => Date.parse(m.timestamp)).filter((t) => Number.isFinite(t));
  const startMs = Math.min(...times, Number.isFinite(endMs) ? endMs : Infinity);
  const startedAt = Number.isFinite(startMs) ? new Date(startMs).toISOString() : ev.timestamp;
  const endedAt = Number.isFinite(endMs) ? ev.timestamp : startedAt;
  const durationS = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000));

  const idTag = ev.idToken?.idToken ?? null;
  const missed = ev.seqNo > 0 ? ` TransactionEvents seqNo 0-${ev.seqNo - 1} were never received.` : '';
  const measured = startKnown
    ? `${energy} Wh between the registers it carries (${startWh} → ${endWh} Wh).`
    : endWh !== null
      ? `Only an end register (${endWh} Wh) was reported, so the energy is unknown; 0 Wh recorded.`
      : 'No energy register was reported; 0 Wh recorded.';
  const flags: SessionFlag[] = [{
    code: 'TRANSACTION_RECONSTRUCTED',
    severity: 'violation',
    message:
      `${ev.evse.ocppIdentity} ended transaction ${ev.transactionId} that was never seen to start; ` +
      `recorded from its end event: ${measured}${missed}` +
      `${idTag ? ` Token ${idTag} (not bound).` : ''} Start time is approximate. ` +
      'Recorded, not billed: parked until an operator decides who pays.',
    ...(idTag ? { idToken: idTag } : {}),
  }];
  const skew = clockSkewFlag(ev.timestamp);
  if (skew) flags.push(skew);

  const ins = await one<SessionRow>(
    `INSERT INTO charging_session
        (org_id, site_id, connector_uuid, charge_point_id, idem_key, ocpp_transaction_id,
         token_id, state, started_at, ended_at, meter_start_wh, meter_start_unknown, meter_stop_wh, energy_wh,
         duration_s, stop_reason, payment_mode, flags, needs_review, review_reason, ocpp_seq_no, currency)
     VALUES ($1,$2,$3,$4,$5,$6,NULL,'ended',$7,$8,$9,$10,$11,$12,$13,$14,'postpaid',$15,true,'TRANSACTION_RECONSTRUCTED',$16,
             (SELECT co.currency FROM site si JOIN country co ON co.code = si.country_code WHERE si.id = $2))
     ON CONFLICT (idem_key) DO NOTHING
     RETURNING *`,
    [
      c.org_id,
      c.site_id,
      c.id,
      c.charge_point_id,
      sessionIdemKey(ev.evse.ocppIdentity, ev.evse.evseId, `ended-unknown:${ev.transactionId}`, 0, ''),
      ev.transactionId,
      startedAt,
      endedAt,
      startWh,
      !startKnown,
      endWh,
      energy,
      durationS,
      ev.stoppedReason ?? null,
      JSON.stringify(flags),
      ev.seqNo,
    ],
  );
  if (!ins) {
    // A concurrent or replayed copy of this Ended recorded it first — or the station reused a
    // transactionId after a reset. Say so: the second case loses a session silently otherwise.
    logger.warn(
      { cp: ev.evse.ocppIdentity, tx: ev.transactionId, seqNo: ev.seqNo },
      'Ended for an unknown transaction already recorded under this transactionId — not recorded again (replay, or the station reused the id)',
    );
    return null;
  }

  await insertMeterValues(ins.id, ev.meterValue);
  logger.warn(
    { sessionId: ins.id, cp: ev.evse.ocppIdentity, tx: ev.transactionId, energyWh: energy, seqNo: ev.seqNo },
    'Ended for an unknown transaction — recorded from the end event and parked for review, not billed',
  );
  bus.emit('alert.raised', {
    orgId: ins.org_id,
    kind: 'session.needs_review',
    severity: 'warning',
    message: `${ev.evse.ocppIdentity} ended transaction ${ev.transactionId} that was never seen to start ` +
      `(${energy} Wh). Session ${ins.id} is recorded for review and will not be billed automatically.`,
  });
  return ins;
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
const PRICING_SELECT = `SELECT cs.*, c.max_power_w, c.current_type, si.local_tax_rate_bps, si.timezone, si.country_code, si.tax_overrides,
            pi.mode AS intent_mode
       FROM charging_session cs
       JOIN connector c ON c.id = cs.connector_uuid
       JOIN site si ON si.id = cs.site_id
       LEFT JOIN payment_intent pi ON pi.id = cs.payment_intent_id
      WHERE cs.id = $1`;

interface Priced {
  result: RatingResult;
  chosen: PriceAdjustment[];
  spent: { points: number; amountMinor: number } | null;
  benefits: Benefits | null;
  who: Who;
  fallback: boolean;
}

/**
 * What a re-price may no longer use: the points the driver turned out to have,
 * and promotions whose limits ran out (rateAndCreateCdr).
 */
interface PricingLimits {
  maxPoints?: number;
  excludePromotions?: Set<string>;
  /** No promotion at all (the last attempt). */
  noPromotions?: boolean;
}

/**
 * Loyalty points never pay for a PRE-PURCHASE (a QRIS / e-wallet payment taken
 * up front for a fixed allowance).
 *
 * The allowance is fixed at checkout from the amount paid. A points discount at
 * rating only lowered the invoice below what was collected, and settlePrepaid
 * then queued the difference as a cash refund: points turned into money, which
 * no loyalty program allows. A card hold (preauth / postpay) captures what the
 * session costs, so points lower what is taken and are kept there.
 */
function pointsAllowed(s: { intent_mode?: string | null; payment_mode?: string | null }): boolean {
  if (s.intent_mode) return s.intent_mode !== 'prepurchase';
  // No intent row: decide on the session's own mode (a legacy pre-purchase).
  return s.payment_mode !== 'prepurchase';
}

/**
 * Price a session: the ONE pricing path, shared by the final charge record and the
 * running cost a driver sees during the charge. Reads only; writes nothing.
 *
 * Keeping it one function is the point: a running cost computed differently from the
 * bill would show the driver one number and charge another.
 */
async function priceSession(s: any, at: { endedAt: Date; energyWh: number; idleMinutes: number }, limits: PricingLimits = {}): Promise<Priced> {
  /**
   * TARIFF AS OF SESSION START — never "the current one".
   *
   * This argument was omitted, so `loadTariffForConnector` defaulted to now() and
   * a mid-day price change retroactively re-priced sessions: Rp 91,317 became
   * Rp 337,995 in the audit's reproduction.
   */
  const startedAt = new Date(s.started_at);
  const { tariff, fallback } = await loadTariffForConnector(s.connector_uuid, s.org_id, startedAt);

  // The session's currency was frozen at StartTransaction from the site's country
  // (never re-derived); the tax context is resolved once, at the supply date.
  const country = assertCountry(s.country_code ?? 'ID');
  const currency = currencyOr(s.currency, currencyOfCountry(country));
  const timezone: string = s.timezone ?? defaultTimezone(country);
  const tax = await resolveTaxContext({ orgId: s.org_id, country, at: startedAt, timezone, overrides: s.tax_overrides });
  const baseCtx = {
    startedAt,
    endedAt: at.endedAt,
    energyWh: at.energyWh,
    connectorMaxPowerW: Number(s.max_power_w),
    localTaxRateBps: Number(s.local_tax_rate_bps),
    idleMinutes: at.idleMinutes,
    timezone,
    currency,
    tax,
  };
  // Energy the car gave back (bidirectional charging): credited before PBJT-TL and PPN, at the
  // rate fixed when the driver or fleet agreed, and never below zero (applyAdjustments).
  const exportWh = Number(s.energy_export_wh ?? 0);
  const v2xCredit = creditMinor(exportWh, s.v2x_credit_minor_per_kwh);
  const v2xAdj: PriceAdjustment[] = v2xCredit > 0
    ? [{ source: 'v2x', id: s.id, name: `Energy given back (${(exportWh / 1000).toFixed(2)} kWh)`, amountOffMinor: v2xCredit }]
    : [];
  // Memberships and promotions: every allowed combination is rated and the
  // cheapest for the customer is billed.
  const who = await whoForSession(s);
  const found = await benefitsFor(s.org_id, who, { siteId: s.site_id, currentType: s.current_type, currency }, startedAt, timezone)
    .catch((e) => { logger.warn({ sessionId: s.id, err: (e as Error).message }, 'benefits lookup failed — rated without them'); return null; });
  const excluded = limits.excludePromotions;
  const benefits = found && (limits.noPromotions || excluded?.size)
    ? { ...found, promotions: limits.noPromotions ? [] : found.promotions.filter((p) => !excluded!.has(p.id)) }
    : found;
  let chosen: PriceAdjustment[] = [];
  let result = benefits
    ? (() => {
        const p = pickCheapest(adjustmentOptions(benefits, baseCtx.energyWh / 1000), (adjustments) => {
          const r = rateSession(tariff, { ...baseCtx, adjustments: [...adjustments, ...v2xAdj] });
          return { ...r, total: r.tax.totalMinor };
        });
        chosen = p.option;
        return p.result;
      })()
    : rateSession(tariff, { ...baseCtx, adjustments: v2xAdj });
  // Loyalty points, for a driver who chose to use them: on top of the cheapest combination, before PBJT-TL and PPN.
  let spent: { points: number; amountMinor: number } | null = null;
  const points = pointsAllowed(s) && limits.maxPoints !== 0
    ? await redemptionFor(s.org_id, who.appDriverId, currency)
      .catch((e) => { logger.warn({ sessionId: s.id, err: (e as Error).message }, 'loyalty lookup failed — rated without points'); return null; })
    : null;
  if (points) {
    const balance = limits.maxPoints != null ? Math.min(points.balance, limits.maxPoints) : points.balance;
    const r = pointsToRedeem(balance, discountable(result.lines), points.program);
    if (r.points > 0) {
      result = rateSession(tariff, { ...baseCtx, adjustments: [...chosen, ...v2xAdj, pointsAdjustment(r.points, r.amountMinor)] });
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
  const at = {
    endedAt: new Date(s.ended_at ?? s.started_at),
    energyWh,
    idleMinutes: Number(s.idle_minutes ?? 0),
  };

  /**
   * PRICE, THEN CLAIM WHAT THE PRICE SPENT — IN THE CDR'S OWN TRANSACTION.
   *
   * Loyalty points and limited promotions are shared, finite things. They were
   * priced from an unlocked read and recorded after the CDR was committed, with
   * the recording's errors only logged: two sessions of one driver rated
   * together both spent the same points (the second CDR kept its discount
   * while the spend failed), and concurrent sessions ran a promotion past its
   * max_redemptions, max_per_customer and budget.
   *
   * Now the CDR is written in one transaction that first takes the session's
   * row lock, then the driver's points lock and the promotion's lock, re-checks
   * the balance and the promotion's limits there, and records the spend and the
   * redemption together with the CDR. When what was priced is no longer
   * available, nothing is written: the session is re-priced with the points the
   * driver actually has, or without the exhausted promotion, and claimed again.
   * Each retry only removes something, so it settles; the last attempt prices
   * with neither points nor promotions, which cannot fail.
   */
  const limits: PricingLimits & { excludePromotions: Set<string> } = { excludePromotions: new Set() };
  const MAX_ATTEMPTS = 5;
  let outcome: { cdr: { id: string } | null; priced: Priced } | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !outcome; attempt++) {
    if (attempt === MAX_ATTEMPTS) {
      limits.maxPoints = 0;
      limits.noPromotions = true;
    }
    const priced = await priceSession(s, at, limits);
    const { result, spent, benefits, who, fallback } = priced;

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

    const written = await tx(async (client) => {
      // One rating per session at a time; a second waits, then finds the CDR.
      await client.query(`SELECT id FROM charging_session WHERE id = $1 FOR UPDATE`, [sessionId]);
      if ((await client.query(`SELECT id FROM cdr WHERE session_id = $1`, [sessionId])).rows[0]) {
        return { done: true as const, cdr: null };
      }

      // The points: spend no more than the driver has, under their lock.
      if (spent && spent.points > 0 && who.appDriverId) {
        const have = await lockedBalance(s.org_id, who.appDriverId, client);
        if (have < spent.points) {
          logger.info({ sessionId, priced: spent.points, have }, 'loyalty points spent elsewhere meanwhile — re-pricing with what is left');
          limits.maxPoints = have;
          return { done: false as const, cdr: null };
        }
      }
      // The promotion: still within its limits, counted under its lock.
      for (const [id, t] of adjustmentTotals(result.lines)) {
        if (t.source !== 'promotion') continue;
        const ok = await reservePromotion(client, s.org_id, sessionId, id, benefits?.customerKey ?? null, t.discountMinor);
        if (!ok) {
          logger.info({ sessionId, promotion: id }, 'promotion limit reached meanwhile — re-pricing without it');
          limits.excludePromotions.add(id);
          return { done: false as const, cdr: null };
        }
      }

      const ins = await client.query<{ id: string }>(
        `INSERT INTO cdr (session_id, org_id, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor,
                          tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, regulatory_flags,
                          currency, tax_scheme, prices_include_tax, rounding_minor, tax_detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (session_id) DO NOTHING
         RETURNING id`,
        [
          sessionId,
          s.org_id,
          JSON.stringify(result.lines),
          result.tax.subtotalMinor,
          result.tax.localTaxRateBps,
          result.tax.localTaxMinor,
          result.tax.taxBaseMinor,
          result.tax.taxRateBps,
          result.tax.taxMinor,
          result.tax.totalMinor,
          JSON.stringify(result.tariffSnapshot),
          JSON.stringify(flags),
          currencyOr(s.currency),
          result.tax.scheme,
          result.tax.pricesIncludeTax,
          result.tax.roundingMinor,
          JSON.stringify(result.tax.detail ?? {}),
        ],
      );
      const cdr = ins.rows[0] ?? null;
      if (cdr) {
        if (benefits) await recordBenefits(s.org_id, sessionId, result.lines, benefits, energyWh / 1000, client);
        // Points spent on this session, and earned on what it cost. A failure here
        // rolls the CDR back with it: no CDR keeps a discount nobody paid for.
        await recordLoyalty(s.org_id, sessionId, who.appDriverId, result.tax.totalMinor, spent, client, currencyOr(s.currency));
        await client.query(`UPDATE charging_session SET state = 'rated', rated_at = now() WHERE id = $1`, [sessionId]);
      }
      return { done: true as const, cdr };
    });
    if (written.done) outcome = { cdr: written.cdr, priced };
  }
  if (!outcome) {
    // Unreachable in practice: the last attempt uses neither points nor promotions.
    logger.error({ sessionId }, 'could not settle a price for the session — left for reconciliation');
    return null;
  }

  const { cdr, priced } = outcome;
  if (cdr) {
    bus.emit('cdr.created', { orgId: s.org_id, cdrId: cdr.id, sessionId, totalMinor: priced.result.tax.totalMinor, currency: currencyOr(s.currency) });
    logger.info({ sessionId, cdrId: cdr.id, totalMinor: priced.result.tax.totalMinor }, 'CDR created');
    // The CDR has committed: a settlement that fails now must not fail the rating. It is left unsettled and
    // recoverUnsettledPayments (the worker) settles it after a grace period.
    await settlePrepaid(sessionId, s.org_id, priced.result.tax.totalMinor).catch((e) =>
      logger.error({ sessionId, err: (e as Error).message }, 'payment settlement failed after the CDR; left for the settlement recovery sweep'));
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
 * Now the delta is recorded on the payment (settlement_delta_minor) and acted on:
 * money held for energy never delivered is queued in the refund queue
 * (services/refunds.ts: paid back through the acquirer by the refunds worker,
 * or marked refunded by hand under Refunds) with a `prepaid.refund_due` alert;
 * an invoice above what was collected raises `prepaid.under_collected`. The
 * session itself is not parked for either — its billing is correct; what needs
 * action is the payment.
 */
async function settlePrepaid(sessionId: string, orgId: string, invoicedMinor: number): Promise<void> {
  const intent = await one<{ id: string; captured: number | null; minted: boolean; mode: string; hold_state: string | null; hold_capture: number | null; currency: string }>(
    `SELECT id, amount_captured_minor AS captured, claim_token_minted AS minted, mode, hold_state, hold_capture_minor AS hold_capture, currency
       FROM payment_intent
      WHERE session_id = $1 AND mode IN ('prepurchase', 'preauth', 'postpay') AND settled_at IS NULL
      ORDER BY created_at
      LIMIT 1`,
    [sessionId],
  );
  if (!intent) return;
  // Below this the invoice and what was collected are treated as equal (per currency: Rp 1,000 / RM 0.20 / S$ 0.10).
  const cur = currencyOr(intent.currency);
  const SETTLEMENT_TOLERANCE_MINOR = countryOfCurrency(cur)!.settlementToleranceMinor;
  // IDR messages exactly as v1.6 wrote them.
  const grouped = (m: number) => moneyText(m, cur, 'id');
  const plain = (m: number) => moneyText(m, cur, 'plain');

  /**
   * SAFE TO RUN AGAIN, AND SAFE TO STOP HALFWAY.
   *
   * This runs after the CDR has committed, outside its transaction. A crash or a
   * database error part-way used to leave the payment unsettled for good: the
   * CDR existed, so rating returned early, and no sweep looked at payments of
   * rated sessions. recoverUnsettledPayments() now finds those and calls this
   * again, so every step that MOVES MONEY comes first and is idempotent on its
   * own (the hold's state-guarded transition, the refund queue's
   * `refund_state IS NULL` guard, retiring the token), and only then is the
   * payment marked settled — by exactly one caller (`settled_at IS NULL`
   * guard). The alerts and flags below are sent by that caller alone, so a
   * repeat run does not raise them twice.
   */

  // A card hold: capture what the session cost (up to the hold); the rest is released, nothing to refund.
  let captured = Number(intent.captured ?? 0);
  if (intent.mode === 'preauth' || intent.mode === 'postpay') {
    if (intent.hold_state == null || intent.hold_state === 'held') {
      const { settleHold } = await import('./payments/holds.js');
      captured = (await settleHold(intent.id, invoicedMinor)).captureMinor;
    } else {
      // An earlier run already asked for the capture (and stopped before marking the payment settled). Asking
      // again would reset a failed or expired capture's retries and alerts: the hold worker owns it from here.
      captured = Number(intent.hold_capture ?? 0);
    }
  }
  const delta = invoicedMinor - captured;

  // Retire a minted single-use token so the same payment screen cannot be reused.
  if (intent.minted) {
    await query(
      `UPDATE token SET status = 'Expired'
        WHERE org_id = $1 AND kind = 'prepaid'
          AND uid = (SELECT claim_id_tag FROM payment_intent WHERE id = $2)`,
      [orgId, intent.id],
    );
  }

  // Money held for energy that was never delivered: queued for refund BEFORE the payment is marked settled, so a
  // crash in between leaves it to be found again (markRefundDue queues it once).
  const owed = -delta;
  if (delta < -SETTLEMENT_TOLERANCE_MINOR) await markRefundDue(intent.id, owed, 'Unused prepaid balance');

  const claimed = await one<{ id: string }>(
    `UPDATE payment_intent SET settlement_delta_minor = $2, settled_at = now(), updated_at = now()
      WHERE id = $1 AND settled_at IS NULL
      RETURNING id`,
    [intent.id, delta],
  );
  // Settled meanwhile by another run (the recovery sweep and a late inline settlement): it raised the alerts.
  if (!claimed) return;

  if (Math.abs(delta) <= SETTLEMENT_TOLERANCE_MINOR) return;

  if (delta > 0) {
    bus.emit('alert.raised', {
      orgId,
      kind: 'prepaid.under_collected',
      severity: 'warning',
      message:
        `Session ${sessionId} invoiced ${grouped(delta)} more than was collected ` +
        `(${grouped(invoicedMinor)} vs ${grouped(captured)}). ` +
        `A prepaid driver has no card on file, so this is unrecoverable unless they return.`,
    });
    await addFlag(sessionId, {
      code: 'PREPAID_UNDER_COLLECTED',
      severity: 'warning',
      message: `Invoiced ${plain(invoicedMinor)} against ${plain(captured)} collected; ${plain(delta)} short.`,
    });
    return;
  }

  // This one owes the customer. The session's billing is correct; what needs action is the payment, so it
  // went to the refund queue (services/refunds.ts, above) instead of parking the session.
  bus.emit('alert.raised', {
    orgId,
    kind: 'prepaid.refund_due',
    severity: 'warning',
    message:
      `Session ${sessionId} collected ${grouped(owed)} more than it delivered. ` +
      `A refund is due to the payer — process it under Refunds.`,
    targetType: 'payment_intent',
    targetId: intent.id,
  });
  await addFlag(sessionId, {
    code: 'PREPAID_REFUND_DUE',
    severity: 'info',
    message: `Collected ${plain(captured)} for an invoice of ${plain(invoicedMinor)}; ${plain(owed)} is owed back (refund queued).`,
  });
}

/** How long after its CDR a payment may stay unsettled before the recovery sweep settles it (the inline path's grace). */
const SETTLEMENT_RECOVERY_GRACE_MIN = 5;
/** How far back the recovery sweep looks; older ones are left to an operator (a hold has expired at the acquirer by then). */
const SETTLEMENT_RECOVERY_LOOKBACK_DAYS = 30;

/**
 * SETTLEMENT_RECOVERY_NOT_BEFORE (ISO timestamp, optional): the sweep ignores CDRs issued
 * before it. Set it to the upgrade time when 1.5.1 is first deployed, so the first pass
 * does not capture, charge or refund OLD payments that operations may already have
 * settled by hand at the acquirer (that would collect or refund twice). Review those old
 * ones with `npm run settlement:report`, settle what is genuinely open, then remove the
 * setting. An unparseable value is refused at start-up rather than silently ignored.
 */
export function settlementRecoveryNotBefore(env: Record<string, string | undefined> = process.env): Date | null {
  const raw = (env.SETTLEMENT_RECOVERY_NOT_BEFORE ?? '').trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`SETTLEMENT_RECOVERY_NOT_BEFORE is not a valid timestamp: ${raw}`);
  return d;
}

/** The unsettled-payment selection, shared by the sweep and the read-only report. */
export const UNSETTLED_PAYMENTS_SQL = `
  SELECT DISTINCT ON (pi.session_id) pi.session_id, d.org_id, d.total_minor, pi.id AS intent_id, pi.mode,
         pi.hold_state, d.issued_at
    FROM payment_intent pi
    JOIN cdr d ON d.session_id = pi.session_id
   WHERE pi.mode IN ('prepurchase', 'preauth', 'postpay') AND pi.settled_at IS NULL
     AND d.issued_at < now() - make_interval(mins => $1::int)
     AND d.issued_at > now() - make_interval(days => $2::int)
     AND ($3::uuid IS NULL OR pi.org_id = $3)
     AND ($4::timestamptz IS NULL OR d.issued_at >= $4)
   ORDER BY pi.session_id`;

export function unsettledPaymentsParams(orgId?: string, notBefore: Date | null = settlementRecoveryNotBefore()) {
  return [SETTLEMENT_RECOVERY_GRACE_MIN, SETTLEMENT_RECOVERY_LOOKBACK_DAYS, orgId ?? null, notBefore];
}

/**
 * Settle payments of sessions that were rated but never settled.
 *
 * rateAndCreateCdr settles the payment (captures the card hold, charges the
 * post-pay e-wallet, queues the refund of an unused pre-purchase) AFTER the CDR
 * has committed. A crash or a database error in between left the hold `held`
 * until it lapsed at the acquirer — the session delivered, nothing collected —
 * and the unused balance never reached the refund queue. Nothing looked again:
 * a retried rating returns early because the CDR exists, reconciliation only
 * rates sessions WITHOUT a CDR, and the hold sweep only releases holds that
 * never started a session.
 *
 * This finds those payments (unsettled, their session's CDR older than the
 * grace period, so the inline settlement is not raced) and runs the same
 * settlement with the CDR's total. Running it twice is harmless: settlePrepaid
 * moves money only through state-guarded updates and marks the payment
 * settled once. Runs in the worker (one runner platform-wide), which passes no
 * `orgId` and sweeps every tenant; `orgId` scopes it to one (tests).
 */
export async function recoverUnsettledPayments(orgId?: string): Promise<number> {
  const rows = await many<{ session_id: string; org_id: string; total_minor: number }>(
    `SELECT * FROM (${UNSETTLED_PAYMENTS_SQL}) u
      ORDER BY random()   -- not session order: 100 payments that keep failing must not starve the rest
      LIMIT 100`,
    unsettledPaymentsParams(orgId),
  );
  let n = 0;
  for (const r of rows) {
    try {
      await settlePrepaid(r.session_id, r.org_id, Number(r.total_minor));
      n++;
    } catch (e) {
      // One payment failing must not stop the others; it is found again on the next pass.
      logger.warn({ sessionId: r.session_id, err: (e as Error).message }, 'settlement recovery failed for a session; retried next pass');
    }
  }
  if (n) logger.warn({ settled: n }, 'settled payments of rated sessions that had been left unsettled (crash after rating?)');
  return n;
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

/**
 * The violation that parks an unauthorised session. It carries the refused token
 * (the session binds none), so the reviewer sees whose card it was and a station
 * repeating the same token is not re-authorised on every frame.
 */
function unauthorisedFlag(u: UnauthorisedStart, idTag: string | null): SessionFlag {
  return {
    code: u.code,
    severity: 'violation',
    message: `${u.message}${idTag ? ` Token ${idTag}.` : ''} Recorded, not billed: parked until an operator decides who pays.`,
    ...(idTag ? { idToken: idTag } : {}),
  };
}

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
  totalMinor: number;
  subtotalMinor: number;
  /** PBJT-TL plus PPN. */
  taxTotalMinor: number;
  /** Memberships, promotions, loyalty points and energy given back, already taken off. */
  discountMinor: number;
  /** Idle fee so far (plugged in, no longer drawing). Included in the total. */
  idleFeeMinor: number;
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
  let discountMinor = 0;
  for (const d of adjustmentTotals(lines as any).values()) discountMinor += d.discountMinor;
  const idleFeeMinor = lines.filter((l) => l.kind === 'idle' && !l.adjustment).reduce((a, l) => a + Number(l.amountMinor), 0);
  return { discountMinor, idleFeeMinor };
}
type CdrLineLike = { kind: string; amountMinor: number; adjustment?: unknown };

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

  const cdr = await one<{ lines: CdrLineLike[]; subtotal_minor: number; local_tax_minor: number; tax_minor: number; total_minor: number; issued_at: Date }>(
    `SELECT lines, subtotal_minor, local_tax_minor, tax_minor, total_minor, issued_at FROM cdr WHERE session_id = $1`, [sessionId]);
  if (cdr) {
    const f = figures(upgradeLegacyKeys(cdr.lines ?? []));
    return {
      totalMinor: Number(cdr.total_minor), subtotalMinor: Number(cdr.subtotal_minor), taxTotalMinor: Number(cdr.local_tax_minor) + Number(cdr.tax_minor),
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
    totalMinor: result.tax.totalMinor,
    subtotalMinor: result.tax.subtotalMinor,
    taxTotalMinor: result.tax.localTaxMinor + result.tax.taxMinor,
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
 * How long after PAYMENT a paid prepurchase can start a session. One constant,
 * shared by the claim below, the claim-token check in authorizeIdTag, the token
 * expiry at checkout and the unused-payment refund sweep — they must agree, or
 * a token outlives its payment (the unlimited-free-session defect).
 *
 * The window runs from the moment the money was authorised or captured
 * (`payment_intent.paid_at`, stamped by a trigger in migration 049), not from
 * checkout. It ran from `created_at`: a driver who took 25 minutes to finish a
 * QRIS or e-wallet payment had 5 minutes left to plug in, and one who paid
 * after 30 minutes had paid for a session that could never start.
 * `PREPAID_PAID_AT_SQL` is the expression every one of those checks uses.
 */
export const PREPAID_CLAIM_WINDOW_MIN = 30;

/**
 * When a payment intent became claimable. `created_at` only for a row that
 * somehow carries no paid_at (it is backfilled and trigger-maintained), so the
 * check never fails open on a NULL.
 */
export const PREPAID_PAID_AT_SQL = (alias = 'payment_intent') => `COALESCE(${alias}.paid_at, ${alias}.created_at)`;

async function claimPrepaidIntent(
  connectorUuid: string,
  idTag: string | null,
  client: Pick<PoolClient, 'query'>,
  /**
   * The presented token is a prepaid claim token: it may claim only the
   * payment it was minted for, never a legacy unbound intent that happens to
   * be parked on this connector (that would be someone else's money).
   */
  payerOnly = false,
) {
  const r = await client.query<{
    id: string;
    amount_authorised_minor: number;
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
           -- the claim window runs from payment, not from checkout
           AND ${PREPAID_PAID_AT_SQL()} > now() - make_interval(mins => ${PREPAID_CLAIM_WINDOW_MIN})
           AND (
             -- the payer is starting this session...
             ($2::text IS NOT NULL AND claim_id_tag = $2)
             -- ...or the intent predates payer binding entirely
             OR (claim_id_tag IS NULL AND NOT $3::boolean)
           )
         -- Prefer an exact payer match over a legacy unbound intent, and take
         -- the OLDEST match so a queue is served in the order it paid.
         ORDER BY (claim_id_tag IS NOT NULL) DESC, created_at ASC
         LIMIT 1
      )
      RETURNING id, amount_authorised_minor, allowance_wh, claim_id_tag`,
    [connectorUuid, idTag, payerOnly],
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

async function resolveToken(orgId: string, uid: string): Promise<{ id: string; kind: string } | null> {
  // A Plug & Charge contract may arrive as the eMAID with separators.
  return one<{ id: string; kind: string }>(
    `SELECT id, kind FROM token WHERE org_id = $1 AND (uid = $2 OR (kind = 'emaid' AND uid = $3)) ORDER BY (uid = $2) DESC LIMIT 1`,
    [orgId, uid, normaliseEmaid(uid)],
  );
}

/**
 * Why a prepaid claim token cannot start here: its payment is already running
 * a session (ConcurrentTx — one payment, one session at a time), or it has no
 * payment claimable on this connector (Invalid).
 */
async function prepaidRefusalStatus(client: Pick<PoolClient, 'query'>, orgId: string, idTag: string): Promise<'Invalid' | 'ConcurrentTx'> {
  const r = await client.query<{ busy: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM payment_intent pi JOIN charging_session cs ON cs.id = pi.session_id
        WHERE pi.org_id = $1 AND pi.claim_id_tag = $2 AND cs.state = 'active'
     ) AS busy`,
    [orgId, idTag],
  );
  return r.rows[0]?.busy ? 'ConcurrentTx' : 'Invalid';
}

export async function activeSessionOnConnector(connectorUuid: string) {
  return one<SessionRow>(
    `SELECT * FROM charging_session WHERE connector_uuid = $1 AND state = 'active' ORDER BY started_at DESC LIMIT 1`,
    [connectorUuid],
  );
}

export async function recentSessions(orgId: string, limit = 50, siteIds: string[] | null = null) {
  const rows = await many<any>(
    `SELECT cs.id, cs.started_at, cs.ended_at, cs.state, cs.energy_wh, cs.duration_s,
            cs.stop_reason, cs.needs_review, cs.review_reason, cs.flags, cs.idle_minutes,
            cs.payment_mode, cs.prepaid_amount_minor, cs.prepaid_energy_wh, cs.currency,
            cp.ocpp_identity, e.evse_id AS evse_no, s.name AS site_name,
            d.total_minor, d.subtotal_minor, d.local_tax_minor, d.tax_minor, d.tax_base_minor, d.lines,
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
  // CDR lines frozen before 1.7 say amountIdr.
  return rows.map((r) => (r.lines ? { ...r, lines: upgradeLegacyKeys(r.lines) } : r));
}
