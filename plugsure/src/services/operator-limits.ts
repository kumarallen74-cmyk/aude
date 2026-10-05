import { one, many, query } from '../db/pool.js';
import { taxContextForSite } from './tax/index.js';
import { currencyOr, moneyText, LEGACY_CURRENCY } from '../domain/money.js';
import { countryOf } from '../domain/country.js';
import { defaultTimezone } from '../domain/timezone.js';
import { logger } from '../logger.js';
import { bus } from './events.js';
import * as registry from '../ocpp/registry.js';
import { remoteStopTransaction } from '../ocpp/commands.js';
import { loadTariffForConnector } from './tariff-store.js';
import { energyAllowanceWh } from './tariff.js';

/**
 * Remote Start presets (SPEC Module 2.1): Full charge, an energy limit (kWh), a
 * duration (minutes) or an amount (IDR).
 *
 * OCPP 1.6 RemoteStartTransaction has no "stop after N kWh" field, so the limit
 * is held here: the request is recorded when the operator presses Start, bound
 * to the session when StartTransaction arrives for that connector and idTag, and
 * enforced by issuing RemoteStopTransaction when it is reached. An amount is
 * converted to energy with the connector's own tariff at request time, the same
 * inverse-rating the QRIS pre-purchase uses.
 *
 * Runs in the process that owns the sessions' events — the gateway in the split
 * deployment, the single process otherwise.
 */

export type LimitType = 'none' | 'energy' | 'duration' | 'amount';

export async function recordRemoteStartRequest(args: {
  orgId: string;
  chargePointId: string;
  connectorNo: number;
  connectorUuid: string | null;
  idTag: string;
  limitType: LimitType;
  limitValue: number | null;
  requestedBy: string;
}): Promise<{ energyLimitWh: number | null; durationLimitS: number | null; error?: string }> {
  let energyLimitWh: number | null = null;
  let durationLimitS: number | null = null;
  const v = args.limitValue;

  if (args.limitType === 'energy') {
    if (v == null || !(v > 0) || v > 1000) return { energyLimitWh, durationLimitS, error: 'Energy limit must be 0.1–1000 kWh' };
    energyLimitWh = Math.round(v * 1000);
  } else if (args.limitType === 'duration') {
    if (v == null || !(v >= 1) || v > 24 * 60) return { energyLimitWh, durationLimitS, error: 'Duration must be 1–1440 minutes' };
    durationLimitS = Math.round(v * 60);
  } else if (args.limitType === 'amount') {
    if (!args.connectorUuid) return { energyLimitWh, durationLimitS, error: 'Unknown connector' };
    // The amount is in the connector's site currency (minor units): rupiah 1,000 – 10,000,000 as before; elsewhere 1.00 up to the country's largest pre-purchase.
    const cc = await one<{ country_code: string }>(
      `SELECT s.country_code FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id WHERE c.id = $1`,
      [args.connectorUuid]);
    const country = countryOf(cc?.country_code);
    const lo = country.currency === LEGACY_CURRENCY ? 1_000 : 100;
    const hi = country.currency === LEGACY_CURRENCY ? 10_000_000 : country.maxPrepaidMinor;
    if (v == null || !(v >= lo) || v > hi) return { energyLimitWh, durationLimitS, error: `Amount must be ${moneyText(lo, country.currency, 'en')} – ${moneyText(hi, country.currency, 'en')}` };
    const c = await one<{ max_power_w: number; local_tax_rate_bps: number; timezone: string; country_code: string; tax_overrides: any; currency: string }>(
      `SELECT c.max_power_w, s.local_tax_rate_bps, s.timezone, s.country_code, s.tax_overrides,
              (SELECT co.currency FROM country co WHERE co.code = s.country_code) AS currency
         FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id
         JOIN site s ON s.id = cp.site_id WHERE c.id = $1`,
      [args.connectorUuid],
    );
    const now = new Date();
    const { tariff } = await loadTariffForConnector(args.connectorUuid, args.orgId, now);
    energyLimitWh = energyAllowanceWh(tariff, v, {
      startedAt: now,
      endedAt: new Date(now.getTime() + 45 * 60_000),
      connectorMaxPowerW: c?.max_power_w ?? 22_000,
      localTaxRateBps: c?.local_tax_rate_bps ?? 0,
      timezone: c?.timezone ?? defaultTimezone(c?.country_code ?? 'ID'),
      currency: currencyOr(c?.currency),
      tax: await taxContextForSite(args.orgId, c ?? {}, now),
    });
    if (energyLimitWh <= 0) {
      return { energyLimitWh: null, durationLimitS, error: `${moneyText(v, country.currency, 'plain')} does not cover this connector's fixed fees` };
    }
  }

  await query(
    `INSERT INTO remote_start_request (org_id, charge_point_id, connector_no, id_tag, limit_type, limit_value,
                                       energy_limit_wh, duration_limit_s, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [args.orgId, args.chargePointId, args.connectorNo, args.idTag, args.limitType, v, energyLimitWh, durationLimitS, args.requestedBy],
  );
  return { energyLimitWh, durationLimitS };
}

async function bindToSession(sessionId: string) {
  const s = await one<{ charge_point_id: string; evse_id: number; uid: string | null; started_at: Date }>(
    `SELECT cs.charge_point_id, e.evse_id, t.uid, cs.started_at
       FROM charging_session cs JOIN connector c ON c.id = cs.connector_uuid JOIN evse e ON e.id = c.evse_uuid
       LEFT JOIN token t ON t.id = cs.token_id
      WHERE cs.id = $1`,
    [sessionId],
  );
  if (!s?.uid) return;
  const req = await one<{ id: string; energy_limit_wh: number | null; duration_limit_s: number | null }>(
    `SELECT id, energy_limit_wh, duration_limit_s FROM remote_start_request
      WHERE charge_point_id = $1 AND connector_no = $2 AND id_tag = $3 AND session_id IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [s.charge_point_id, s.evse_id, s.uid],
  );
  if (!req) return;
  await query(`UPDATE remote_start_request SET session_id = $2 WHERE id = $1`, [req.id, sessionId]);
  if (req.energy_limit_wh == null && req.duration_limit_s == null) return;
  await query(
    `UPDATE charging_session
        SET operator_limit_wh = $2,
            operator_limit_until = CASE WHEN $3::int IS NULL THEN NULL ELSE started_at + ($3::int || ' seconds')::interval END
      WHERE id = $1`,
    [sessionId, req.energy_limit_wh, req.duration_limit_s],
  );
  logger.info({ sessionId, energyLimitWh: req.energy_limit_wh, durationLimitS: req.duration_limit_s }, 'operator session limit bound');
}

async function stopSession(sessionId: string, why: string) {
  const s = await one<{ ocpp_identity: string; ocpp_transaction_id: string | null; org_id: string }>(
    `UPDATE charging_session cs SET operator_stop_sent_at = now()
       FROM charge_point cp
      WHERE cs.id = $1 AND cp.id = cs.charge_point_id AND cs.state = 'active' AND cs.operator_stop_sent_at IS NULL
      RETURNING cp.ocpp_identity, cs.ocpp_transaction_id, cs.org_id`,
    [sessionId],
  );
  if (!s?.ocpp_transaction_id) return;
  if (!registry.isOnline(s.ocpp_identity)) return;
  const txId = registry.wireTransactionId(s.ocpp_identity, s.ocpp_transaction_id);
  try {
    const r = await remoteStopTransaction(s.ocpp_identity, txId, { type: 'system', orgId: s.org_id });
    logger.info({ sessionId, why, status: r?.status }, 'operator limit reached — RemoteStop sent');
  } catch (e) {
    // Let the next pass try again.
    await query(`UPDATE charging_session SET operator_stop_sent_at = NULL WHERE id = $1`, [sessionId]);
    logger.warn({ sessionId, err: (e as Error).message }, 'operator limit RemoteStop failed');
  }
}

let timer: NodeJS.Timeout | null = null;

export function registerOperatorLimits(): () => void {
  bus.on('session.started', (e) => {
    void bindToSession(e.sessionId).catch((err) => logger.warn({ err: (err as Error).message }, 'could not bind operator limit'));
  });
  bus.on('session.updated', (e) => {
    void (async () => {
      const s = await one<{ operator_limit_wh: number | null; operator_stop_sent_at: Date | null }>(
        `SELECT operator_limit_wh, operator_stop_sent_at FROM charging_session WHERE id = $1`,
        [e.sessionId],
      );
      if (s?.operator_limit_wh != null && !s.operator_stop_sent_at && e.energyWh >= Number(s.operator_limit_wh)) {
        await stopSession(e.sessionId, 'energy limit');
      }
    })().catch(() => {});
  });
  timer = setInterval(() => {
    void (async () => {
      const due = await many<{ id: string }>(
        `SELECT id FROM charging_session
          WHERE state = 'active' AND operator_stop_sent_at IS NULL
            AND operator_limit_until IS NOT NULL AND operator_limit_until <= now()`,
      );
      for (const d of due) await stopSession(d.id, 'duration limit');
      // Re-arm stops that were sent but never took (charger ignored it) after 5 minutes.
      await query(
        `UPDATE charging_session SET operator_stop_sent_at = NULL
          WHERE state = 'active' AND operator_stop_sent_at < now() - interval '5 minutes'
            AND (operator_limit_wh IS NOT NULL OR operator_limit_until IS NOT NULL)`,
      );
    })().catch(() => {});
  }, 30_000);
  return () => {
    if (timer) clearInterval(timer);
  };
}
