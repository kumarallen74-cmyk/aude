import { createHash, randomUUID } from 'node:crypto';
import { one, many, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { bus } from '../services/events.js';
import { countryOfCurrency } from '../domain/country.js';
import { CURRENCY_CODES, isCurrency, toMinor, moneyText, type CurrencyCode } from '../domain/money.js';
import { getParty } from '../ocpi/store.js';
import { contractIdFor } from '../ocpi/emsp.js';
import {
  paymentsFor, startPayment, cardOptions, MethodUnavailable, PaymentsUnavailable, logPaymentCreated, type PreparedPayment, type StartedPayment,
} from '../services/payments/registry.js';
import { settleHold } from '../services/payments/holds.js';
import { listCards } from '../services/payments/cards.js';

/**
 * Roaming for signed-in app drivers (docs/MULTI-COUNTRY-DESIGN.md §D7).
 *
 * A fleet card is billed afterwards on the fleet's invoice. An app driver has no
 * invoice, so their charge on a partner network is GUARANTEED BY A CARD HOLD in the
 * partner location's currency, through the eMSP operator's acquirer for that
 * currency's country, placed BEFORE START_SESSION is sent:
 *
 *   hold authorised ─ START_SESSION (authorization_reference = the payment intent)
 *     ├ start refused / timed out / never started ............ release at once
 *     ├ partner CDR accepted, same currency .................. capture min(total, hold), the rest released;
 *     │                                                         above the hold: shortfall recorded + alert
 *     ├ partner CDR in another currency ...................... no capture (no FX), release, alert
 *     └ no CDR 4 days after the authorisation ................ capture the partner session's last total_cost
 *                                                               (same currency), else release + alert
 *
 * The hold is captured at most once: driver_roaming_charge.settled_at is claimed
 * before anything is sent to the acquirer, and the capture itself goes through the
 * card-hold machine (services/payments/holds.ts) with its retries and idempotency keys.
 *
 * Who is the eMSP for an app driver: the operator whose white-label app the driver
 * uses (its brand), or — in PlugSure's own app — the one operator that offers partner
 * networks to app drivers. The operator switches this on (organisation.roaming_settings
 * .appDrivers) and sets the hold per currency (defaults: domain/country.ts).
 */

/** Visa merchant-initiated window is about 4 d 18 h: settle before an authorisation lapses. */
export const HOLD_SETTLE_WITHIN_MS = 4 * 24 * 3600_000;
/** A hold that has not started a charge within this long is released. */
export const HOLD_START_WITHIN_MS = 15 * 60_000;

export interface RoamingSettings {
  /** Signed-in app drivers may charge on partner networks (guaranteed by a card hold). */
  appDrivers: boolean;
  /** Hold per currency, minor units; absent = the country default. */
  holdMinor: Partial<Record<CurrencyCode, number>>;
}

export function parseRoamingSettings(j: unknown): RoamingSettings {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, any>;
  const holdMinor: Partial<Record<CurrencyCode, number>> = {};
  for (const c of CURRENCY_CODES) {
    const v = Number(o.holdMinor?.[c]);
    if (Number.isSafeInteger(v) && v > 0) holdMinor[c] = v;
  }
  return { appDrivers: o.appDrivers === true, holdMinor };
}

/**
 * The smallest hold an operator may set per currency (review fix 9): at least the acquirer's minimum charge (Stripe
 * RM 2.00 / S$0.50) and a floor that still guarantees a short partner charge — defaults Rp 50,000, RM 20.00, S$15.00,
 * overridable per deployment with ROAMING_HOLD_MIN_IDR / _MYR / _SGD (minor units).
 */
const HOLD_FLOOR_DEFAULT: Record<CurrencyCode, number> = { IDR: 50_000, MYR: 2_000, SGD: 1_500 };
const ACQUIRER_MIN: Partial<Record<CurrencyCode, number>> = { MYR: 200, SGD: 50 };
export function roamingHoldMinMinor(cur: CurrencyCode, env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env[`ROAMING_HOLD_MIN_${cur}`]);
  const floor = Number.isSafeInteger(set) && set > 0 ? set : HOLD_FLOOR_DEFAULT[cur];
  return Math.max(floor, ACQUIRER_MIN[cur] ?? 1);
}

/** Validate settings from the console: a hold is a whole number of minor units, from the floor above to 50× the default. */
export function validateRoamingSettings(input: unknown): { settings: RoamingSettings } | { error: string } {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const holdMinor: Partial<Record<CurrencyCode, number>> = {};
  for (const [k, v] of Object.entries(o.holdMinor ?? {})) {
    if (!isCurrency(k)) return { error: `unsupported currency ${k}` };
    if (v == null || v === '') continue;
    const n = Number(v);
    const max = countryOfCurrency(k)!.roamingHoldDefaultMinor * 50;
    const min = roamingHoldMinMinor(k);
    if (!Number.isSafeInteger(n) || n < min || n > max) return { error: `the ${k} hold must be a whole amount between ${min} and ${max} (minor units)` };
    holdMinor[k] = n;
  }
  return { settings: { appDrivers: o.appDrivers === true, holdMinor } };
}

export async function roamingSettingsOf(orgId: string): Promise<RoamingSettings> {
  const r = await one<{ roaming_settings: unknown }>(`SELECT roaming_settings FROM organisation WHERE id = $1`, [orgId]);
  return parseRoamingSettings(r?.roaming_settings);
}

/** The hold for a charge in `cur`: the operator's setting, else the country default. */
export function holdAmount(s: RoamingSettings, cur: CurrencyCode): number {
  return s.holdMinor[cur] ?? countryOfCurrency(cur)!.roamingHoldDefaultMinor;
}

/**
 * The eMSP operator for an app driver: the brand's operator (an operator's own app, or the PlugSure app's PlugSure
 * Mobility organisation for the network brand), else — an unbranded request, as before v1.9 — the single operator
 * that offers roaming to app drivers. The network brand's organisation is not counted there: setting up the PlugSure
 * app does not change what the unbranded web app does.
 */
export async function emspOrgForApp(brandOrgId: string | null): Promise<string | null> {
  if (brandOrgId) return (await roamingSettingsOf(brandOrgId)).appDrivers ? brandOrgId : null;
  const rows = await many<{ id: string }>(
    `SELECT id FROM organisation o WHERE (roaming_settings->>'appDrivers')::boolean IS TRUE
        AND NOT EXISTS (SELECT 1 FROM driver_app_brand b WHERE b.org_id = o.id AND b.scope = 'network')
      ORDER BY created_at LIMIT 2`);
  return rows.length === 1 ? rows[0]!.id : null;
}

/** The driver's virtual eMSP token at this operator: stable, 20 characters (fits an OCPP idTag and an OCPI uid). */
export function appTokenUid(orgId: string, appDriverId: string): string {
  return 'APP' + createHash('sha256').update(`${orgId}:${appDriverId}`).digest('hex').slice(0, 17).toUpperCase();
}

/** One virtual token per (eMSP operator, app driver): kind 'app', OCPI APP_USER, contract id from the home party. */
export async function ensureRoamingToken(orgId: string, appDriverId: string): Promise<{ id: string; uid: string; contractId: string }> {
  const party = await getParty(orgId);
  if (!party) throw new Error('the operator has no roaming identity');
  const uid = appTokenUid(orgId, appDriverId);
  const t = await one<{ id: string; contract_id: string | null }>(
    `INSERT INTO token (org_id, kind, uid, status, roaming_shared, offline_allowed) VALUES ($1, 'app', $2, 'Accepted', true, false)
     ON CONFLICT (org_id, uid) DO UPDATE SET roaming_shared = true RETURNING id, contract_id`,
    [orgId, uid],
  );
  let contractId = t!.contract_id;
  if (!contractId) {
    contractId = contractIdFor(party, t!.id);
    await query(`UPDATE token SET contract_id = $2, updated_at = now() WHERE id = $1 AND contract_id IS NULL`, [t!.id, contractId]);
  }
  return { id: t!.id, uid, contractId };
}

/** What an app driver needs to start at a partner station in `cur`, or why it is not possible. */
export async function roamingPaymentFor(orgId: string, cur: CurrencyCode | null, appDriverId: string | null) {
  const no = (reason: string) => ({ startable: false as const, reason, holdMinor: null, savedCards: [] as Array<{ id: string; brand: string | null; last4: string | null }> });
  if (!cur) return no('Belum tersedia dengan metode pembayaran Anda.');
  const country = countryOfCurrency(cur)!.code;
  let acq: Awaited<ReturnType<typeof paymentsFor>>;
  try { acq = await paymentsFor(orgId, country); } catch { return no('Belum tersedia dengan metode pembayaran Anda.'); }
  if (!cardOptions(acq.resolved, acq.provider).holds) return no('Belum tersedia dengan metode pembayaran Anda.');
  const settings = await roamingSettingsOf(orgId);
  const mine = appDriverId ? await listCards(appDriverId, { provider: acq.resolved.provider, integrationId: acq.resolved.integrationId }) : [];
  return {
    startable: true as const, reason: null, holdMinor: holdAmount(settings, cur),
    savedCards: cardOptions(acq.resolved, acq.provider).saveCards
      ? mine.filter((k) => k.kind === 'card' && !k.expired).map((k) => ({ id: k.id, brand: k.brand, last4: k.last4 }))
      : [],
  };
}

export interface HoldStart {
  orgId: string; appDriverId: string; deviceId: string; currency: CurrencyCode;
  partnerId: string; countryCode: string; partyId: string; locationId: string; evseUid: string; connectorId: string | null;
  savedCardId?: string | null; saveCard?: boolean; returnUrl: string; description: string;
}

/**
 * Place the hold for a roaming charge: a driver_roaming_charge (not yet started) and its
 * payment intent (mode preauth, currency, roaming_charge_id). A saved card is authorised
 * at once; a new card goes through the acquirer's checkout first.
 */
export async function placeRoamingHold(h: HoldStart): Promise<{ ok: true; chargeId: string; payment: StartedPayment; holdMinor: number } | { ok: false; error: string; code?: string }> {
  // An unpaid partner charge (a shortfall) first: no new guarantee while one is owed (review fix 2).
  if ((await roamingOwed(h.appDriverId)).length) return { ok: false, error: ROAMING_UNPAID, code: 'roaming_unpaid' };
  const country = countryOfCurrency(h.currency)!.code;
  let acq: Awaited<ReturnType<typeof paymentsFor>>;
  try { acq = await paymentsFor(h.orgId, country); } catch (e) {
    if (e instanceof PaymentsUnavailable) return { ok: false, error: 'Belum tersedia dengan metode pembayaran Anda.', code: 'no_acquirer' };
    throw e;
  }
  if (!cardOptions(acq.resolved, acq.provider).holds) return { ok: false, error: 'Belum tersedia dengan metode pembayaran Anda.', code: 'no_card_holds' };
  const holdMinor = holdAmount(await roamingSettingsOf(h.orgId), h.currency);
  const token = await ensureRoamingToken(h.orgId, h.appDriverId);
  const chargeId = randomUUID();
  const intentId = randomUUID();
  await query(
    `INSERT INTO driver_roaming_charge (id, org_id, device_id, token_id, partner_id, country_code, party_id, location_id, evse_uid, connector_id,
                                        app_driver_id, payment_intent_id, currency, hold_minor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12,$13)`,
    [chargeId, h.orgId, h.deviceId, token.id, h.partnerId, h.countryCode, h.partyId, h.locationId, h.evseUid, h.connectorId, h.appDriverId, h.currency, holdMinor],
  );
  await query(
    `INSERT INTO payment_intent (id, org_id, provider, method, mode, state, amount_authorised_minor, expires_at, integration_id, channel, currency, roaming_charge_id)
     VALUES ($1, $2, $3, 'card', 'preauth', 'pending', $4, now() + interval '30 minutes', $5, 'CARD', $6, $7)`,
    [intentId, h.orgId, acq.provider.name, holdMinor, acq.resolved.integrationId, h.currency, chargeId],
  );
  await query(`UPDATE driver_roaming_charge SET payment_intent_id = $2 WHERE id = $1`, [chargeId, intentId]);
  const prepare = (p: PreparedPayment) => query(
    `UPDATE payment_intent SET provider_ref = COALESCE($2, provider_ref), idem_key = COALESCE($2, idem_key), mode = $3, method = $4, channel = $5,
            driver_card_id = $6, save_card = $7, updated_at = now() WHERE id = $1`,
    [intentId, p.providerRef, p.mode, p.method, p.channel, p.savedCardId, p.saveCard],
  ).then(() => undefined);
  let pay: StartedPayment;
  try {
    pay = await startPayment(acq, {
      channel: 'CARD', referenceId: `roaming:${intentId}`, amountMinor: holdMinor, currency: h.currency, returnUrl: h.returnUrl,
      appDriverId: h.appDriverId, savedCardId: h.savedCardId ?? null, saveCard: h.saveCard === true, allowHold: true,
      description: h.description, prepare,
    });
  } catch (e) {
    await query(`UPDATE payment_intent SET state = 'failed', updated_at = now() WHERE id = $1 AND state = 'pending'`, [intentId]);
    await query(`UPDATE driver_roaming_charge SET settled_at = now(), settle_outcome = 'not_started' WHERE id = $1`, [chargeId]);
    if (e instanceof MethodUnavailable) return { ok: false, error: e.message, ...(e.code ? { code: e.code } : {}) };
    throw e;
  }
  if (pay.mode !== 'preauth') {
    // Never take a sale as a roaming guarantee: the acquirer would charge the whole hold.
    await query(`UPDATE payment_intent SET state = 'failed', updated_at = now() WHERE id = $1 AND state = 'pending'`, [intentId]);
    await query(`UPDATE driver_roaming_charge SET settled_at = now(), settle_outcome = 'not_started' WHERE id = $1`, [chargeId]);
    return { ok: false, error: 'Belum tersedia dengan metode pembayaran Anda.', code: 'no_card_holds' };
  }
  await query(
    `UPDATE payment_intent
        SET provider_ref = $2, idem_key = $2, checkout_url = $3, provider_payment_id = COALESCE(provider_payment_id, $4), save_card = $5,
            driver_card_id = COALESCE($6, driver_card_id),
            state = CASE WHEN state <> 'pending' THEN state WHEN $7::text = 'authorised' THEN 'authorised' ELSE 'pending' END,
            authorised_at = CASE WHEN $7::text = 'authorised' THEN COALESCE(authorised_at, now()) ELSE authorised_at END,
            hold_state = CASE WHEN $7::text = 'authorised' THEN COALESCE(hold_state, 'held') ELSE hold_state END,
            updated_at = now()
      WHERE id = $1`,
    [intentId, pay.providerRef, pay.checkoutUrl, pay.providerPaymentId, pay.saveCard, pay.savedCardId, pay.immediate],
  );
  await logPaymentCreated(acq.resolved, h.orgId, pay.providerRef, holdMinor, 'roaming hold', pay.channel);
  logger.info({ chargeId, intentId, currency: h.currency, holdMinor }, 'roaming hold placed');
  return { ok: true, chargeId, payment: pay, holdMinor };
}

interface ChargeRow {
  id: string; org_id: string; token_id: string; partner_id: string; country_code: string; party_id: string; location_id: string;
  evse_uid: string; connector_id: string | null; start_command_id: string | null; payment_intent_id: string | null; currency: string | null;
  hold_minor: number | null; settled_at: Date | null; created_at: Date; remote_session_id: string | null;
}

/** The hold's state for a roaming charge (null: not an app driver's charge). */
export async function holdOf(chargeId: string) {
  return one<{ id: string; state: string; hold_state: string | null; amount_authorised_minor: number; amount_captured_minor: number | null;
    hold_capture_minor: number | null; currency: string; checkout_url: string | null; authorised_at: Date | null }>(
    `SELECT pi.id, pi.state, pi.hold_state, pi.amount_authorised_minor, pi.amount_captured_minor, pi.hold_capture_minor, pi.currency, pi.checkout_url, pi.authorised_at
       FROM payment_intent pi WHERE pi.roaming_charge_id = $1`, [chargeId]);
}

/** OCPI base for command response URLs, outside a request (workers). */
export function ocpiBaseForWorker(): string | null {
  return config.ocpi.publicUrl || null;
}

/**
 * Send START_SESSION once the hold is authorised (called from the app's status poll and
 * the worker). Claimed by setting start_command_id, so it is sent once.
 */
export async function startAfterHold(chargeId: string, base: string | null): Promise<'started' | 'waiting' | 'refused' | 'nothing'> {
  const r = await one<ChargeRow>(`SELECT * FROM driver_roaming_charge WHERE id = $1`, [chargeId]);
  if (!r || !r.payment_intent_id || r.start_command_id || r.settled_at) return 'nothing';
  const h = await holdOf(r.id);
  if (!h || h.state === 'pending') return 'waiting';
  if (!(h.state === 'authorised' && h.hold_state === 'held')) {
    await query(`UPDATE driver_roaming_charge SET settled_at = now(), settle_outcome = 'not_started' WHERE id = $1 AND settled_at IS NULL`, [r.id]);
    return 'refused';
  }
  if (!base) return 'waiting';
  // Claim: one sender only.
  const claimed = await one(`UPDATE driver_roaming_charge SET start_requested_at = now() WHERE id = $1 AND start_requested_at IS NULL AND settled_at IS NULL RETURNING id`, [r.id]);
  if (!claimed) return 'nothing';
  const { sendCommand, EmspError } = await import('../ocpi/emsp.js');
  try {
    const c = await sendCommand({
      orgId: r.org_id, partnerId: r.partner_id, command: 'START_SESSION', base, tokenId: r.token_id,
      locationId: r.location_id, evseUid: r.evse_uid, connectorId: r.connector_id ?? undefined,
      locationParty: { country_code: r.country_code, party_id: r.party_id }, authorizationReference: h.id,
    });
    await query(`UPDATE driver_roaming_charge SET start_command_id = $2 WHERE id = $1`, [r.id, c.id]);
    if (c.response !== 'ACCEPTED') { await releaseRoamingHold(r.id, 'not_started'); return 'refused'; }
    return 'started';
  } catch (e) {
    if (e instanceof EmspError) { await releaseRoamingHold(r.id, 'not_started'); return 'refused'; }
    throw e;
  }
}

/** Release the whole hold (nothing owed) and close the charge. Safe to repeat. */
export async function releaseRoamingHold(chargeId: string, outcome: 'not_started' | 'currency_mismatch' | 'released_no_cdr'): Promise<boolean> {
  const r = await one<{ payment_intent_id: string | null }>(
    `UPDATE driver_roaming_charge SET settled_at = now(), settle_outcome = $2 WHERE id = $1 AND settled_at IS NULL RETURNING payment_intent_id`,
    [chargeId, outcome],
  );
  if (!r?.payment_intent_id) return false;
  const pi = await one<{ hold_state: string | null; state: string }>(`SELECT hold_state, state FROM payment_intent WHERE id = $1`, [r.payment_intent_id]);
  if (pi?.hold_state === 'held') await settleHold(r.payment_intent_id, 0);
  else if (pi?.state === 'pending') await query(`UPDATE payment_intent SET state = 'expired', updated_at = now() WHERE id = $1 AND state = 'pending'`, [r.payment_intent_id]);
  logger.info({ chargeId, outcome }, 'roaming hold released');
  return true;
}

/**
 * An accepted partner CDR: settle the app driver's hold it belongs to (matched by the
 * authorization_reference we sent, else the partner session of the charge). Once only.
 */
export async function settleRoamingHold(remoteCdrId: string): Promise<{ outcome: string; captureMinor?: number; shortMinor?: number } | null> {
  const c = await one<{ id: string; token_id: string | null; partner_id: string; session_id: string | null; currency: string;
    total_excl_vat: string; total_incl_vat: string | null; data: any; org_id: string }>(
    `SELECT id, token_id, partner_id, session_id, currency, total_excl_vat, total_incl_vat, data, org_id FROM ocpi_remote_cdr WHERE id = $1 AND status = 'accepted'`,
    [remoteCdrId]);
  if (!c?.token_id) return null;
  const ref = typeof c.data?.authorization_reference === 'string' ? c.data.authorization_reference.slice(0, 36) : null;
  const r = await one<ChargeRow>(
    `SELECT rc.* FROM driver_roaming_charge rc
       LEFT JOIN ocpi_remote_session s ON s.id = rc.remote_session_id
      WHERE rc.token_id = $1 AND rc.payment_intent_id IS NOT NULL
        AND (rc.payment_intent_id::text = $2 OR (s.session_id IS NOT NULL AND s.session_id = $3 AND s.partner_id = $4))
      ORDER BY rc.created_at DESC LIMIT 1`,
    [c.token_id, ref ?? '', c.session_id ?? '', c.partner_id],
  ) ?? (c.session_id ? await one<ChargeRow>(
    // The partner session may not be linked yet (the app never polled): find the charge it started.
    `SELECT rc.* FROM driver_roaming_charge rc JOIN ocpi_remote_session s
         ON s.partner_id = rc.partner_id AND s.token_id = rc.token_id AND s.session_id = $2 AND s.data->>'location_id' = rc.location_id
      WHERE rc.token_id = $1 AND rc.payment_intent_id IS NOT NULL AND rc.settled_at IS NULL ORDER BY rc.created_at DESC LIMIT 1`,
    [c.token_id, c.session_id]) : null);
  if (!r) return unmatchedAppCdr(c);
  const claimed = await one<{ id: string }>(
    `UPDATE driver_roaming_charge SET settled_at = now(), remote_cdr_id = $2 WHERE id = $1 AND settled_at IS NULL RETURNING id`, [r.id, c.id]);
  if (!claimed) return lateCdr(r.id, c);
  const pi = await one<{ id: string; currency: string; amount_authorised_minor: number; hold_state: string | null }>(
    `SELECT id, currency, amount_authorised_minor, hold_state FROM payment_intent WHERE id = $1`, [r.payment_intent_id]);
  if (!pi) return null;
  if (pi.currency !== c.currency || !isCurrency(c.currency)) {
    // No FX, ever: the hold is released and the operator collects the charge another way.
    await query(`UPDATE driver_roaming_charge SET settle_outcome = 'currency_mismatch' WHERE id = $1`, [r.id]);
    if (pi.hold_state === 'held') await settleHold(pi.id, 0);
    bus.emit('alert.raised', {
      orgId: r.org_id, kind: 'roaming.currency_mismatch', severity: 'warning',
      message: `A partner charge record (${String(c.data?.id ?? c.id)}) is in ${c.currency}, but the driver's card hold was in ${pi.currency}. PlugSure does not convert currencies: the hold was released and nothing was captured. Collect the charge another way.`,
      targetType: 'ocpi_remote_cdr', targetId: c.id,
    });
    return { outcome: 'currency_mismatch' };
  }
  const cur = c.currency as CurrencyCode;
  const flaggedExcl = c.total_incl_vat == null;
  const totalMinor = toMinor(String(c.total_incl_vat ?? c.total_excl_vat), cur);
  const s = pi.hold_state === 'held' ? await settleHold(pi.id, totalMinor) : { captureMinor: 0, shortMinor: totalMinor };
  const outcome = s.shortMinor > 0 ? 'shortfall' : 'captured';
  await query(`UPDATE driver_roaming_charge SET settle_outcome = $2, shortfall_minor = $3 WHERE id = $1`, [r.id, outcome, s.shortMinor || null]);
  if (s.shortMinor > 0) {
    bus.emit('alert.raised', {
      orgId: r.org_id, kind: 'roaming.hold_shortfall', severity: 'warning',
      message: `A partner charge (${String(c.data?.id ?? c.id)}) came to ${moneyText(totalMinor, cur, 'en')}, more than the driver's card hold of ${moneyText(Number(pi.amount_authorised_minor), cur, 'en')}: ${moneyText(s.captureMinor, cur, 'en')} was captured and ${moneyText(s.shortMinor, cur, 'en')} is owed by the driver, who is asked to pay it in the app (no new partner charge until it is paid). Consider raising the roaming hold for ${cur} (Roaming → settings).`,
      targetType: 'payment_intent', targetId: pi.id,
    });
  }
  logger.info({ chargeId: r.id, cdr: c.id, totalMinor, ...s, flaggedExcl }, 'roaming hold settled');
  return { outcome, ...s };
}

/**
 * Worker: start charges whose hold was just authorised (the app may be closed), release
 * holds that never started a charge, and apply the 4-day rule to holds with no CDR.
 */
export async function sweepRoamingHolds(now = new Date()): Promise<number> {
  let n = 0;
  const base = ocpiBaseForWorker();
  const waiting = await many<{ id: string; created_at: Date }>(
    `SELECT rc.id, rc.created_at FROM driver_roaming_charge rc JOIN payment_intent pi ON pi.id = rc.payment_intent_id
      WHERE rc.settled_at IS NULL AND rc.start_requested_at IS NULL LIMIT 100`);
  for (const w of waiting) {
    if (now.getTime() - new Date(w.created_at).getTime() > HOLD_START_WITHIN_MS) { if (await releaseRoamingHold(w.id, 'not_started')) n++; continue; }
    if ((await startAfterHold(w.id, base)) !== 'waiting') n++;
  }
  // Started, but the charger refused or never answered: nothing to pay.
  const refused = await many<{ id: string }>(
    `SELECT rc.id FROM driver_roaming_charge rc JOIN ocpi_command c ON c.id = rc.start_command_id
      WHERE rc.settled_at IS NULL AND rc.payment_intent_id IS NOT NULL AND rc.remote_session_id IS NULL
        AND ((c.result IS NOT NULL AND c.result <> 'ACCEPTED') OR (c.response IS NOT NULL AND c.response <> 'ACCEPTED'))
        AND NOT EXISTS (SELECT 1 FROM ocpi_remote_session s WHERE s.partner_id = rc.partner_id AND s.token_id = rc.token_id
                         AND s.data->>'location_id' = rc.location_id AND s.received_at >= rc.created_at - interval '1 minute')`);
  for (const r of refused) if (await releaseRoamingHold(r.id, 'not_started')) n++;
  // The 4-day rule: authorised long ago, no CDR.
  const old = await many<{ id: string; org_id: string; payment_intent_id: string; currency: string; partner_id: string; token_id: string; location_id: string; created_at: Date }>(
    `SELECT rc.id, rc.org_id, rc.payment_intent_id, pi.currency, rc.partner_id, rc.token_id, rc.location_id, rc.created_at
       FROM driver_roaming_charge rc JOIN payment_intent pi ON pi.id = rc.payment_intent_id
      WHERE rc.settled_at IS NULL AND pi.hold_state = 'held' AND pi.authorised_at < $1::timestamptz`,
    [new Date(now.getTime() - HOLD_SETTLE_WITHIN_MS)]);
  for (const o of old) {
    const s = await one<{ data: any }>(
      `SELECT data FROM ocpi_remote_session WHERE partner_id = $1 AND token_id = $2 AND data->>'location_id' = $3 AND received_at >= $4::timestamptz - interval '1 minute'
        ORDER BY received_at DESC LIMIT 1`, [o.partner_id, o.token_id, o.location_id, o.created_at]);
    const tc = s?.data?.total_cost;
    const total = tc ? Number(tc.incl_vat ?? tc.excl_vat) : NaN;
    const claimed = await one(`UPDATE driver_roaming_charge SET settled_at = now() WHERE id = $1 AND settled_at IS NULL RETURNING id`, [o.id]);
    if (!claimed) continue;
    n++;
    if (Number.isFinite(total) && total > 0 && s?.data?.currency === o.currency && isCurrency(o.currency)) {
      const r = await settleHold(o.payment_intent_id, toMinor(String(total), o.currency));
      await query(`UPDATE driver_roaming_charge SET settle_outcome = 'captured_session_total', shortfall_minor = $2 WHERE id = $1`, [o.id, r.shortMinor || null]);
      logger.warn({ chargeId: o.id, ...r }, 'roaming hold captured from the partner session total (no CDR within 4 days)');
    } else {
      await query(`UPDATE driver_roaming_charge SET settle_outcome = 'released_no_cdr' WHERE id = $1`, [o.id]);
      await settleHold(o.payment_intent_id, 0);
      bus.emit('alert.raised', {
        orgId: o.org_id, kind: 'roaming.hold_unsettled', severity: 'warning',
        message: 'A roaming partner sent no charge record (and no session total) within 4 days of an app driver\'s card hold: the hold was released before it lapsed, and nothing was captured. Check the partner\'s CDRs under Roaming.',
        targetType: 'payment_intent', targetId: o.payment_intent_id,
      });
    }
  }
  return n;
}

// ─────────────────────────────────────────── review fix 2: shortfalls owed, late and unmatched charge records

type RemoteCdr = { id: string; token_id: string | null; partner_id: string; currency: string; total_excl_vat: string; total_incl_vat: string | null; data: any; org_id: string };

/**
 * A partner charge record that arrived AFTER the 4-day rule settled the hold (released it, or captured the partner's
 * session total): the record's total is what the charge cost. What was captured short of it is owed by the driver
 * (paid in the app, like any unpaid session); what was captured beyond it is refunded. Once per charge.
 */
async function lateCdr(chargeId: string, c: RemoteCdr): Promise<{ outcome: string; captureMinor?: number; shortMinor?: number }> {
  const r = await one<{ id: string; org_id: string; payment_intent_id: string; settle_outcome: string | null }>(
    `UPDATE driver_roaming_charge SET remote_cdr_id = $2
      WHERE id = $1 AND remote_cdr_id IS NULL AND settle_outcome IN ('released_no_cdr', 'captured_session_total')
      RETURNING id, org_id, payment_intent_id, settle_outcome`, [chargeId, c.id]);
  if (!r) return { outcome: 'already_settled' };
  const pi = await one<{ id: string; currency: string; amount_captured_minor: number | null; hold_capture_minor: number | null }>(
    `SELECT id, currency, amount_captured_minor, hold_capture_minor FROM payment_intent WHERE id = $1`, [r.payment_intent_id]);
  if (!pi) return { outcome: 'already_settled' };
  if (pi.currency !== c.currency || !isCurrency(c.currency)) {
    bus.emit('alert.raised', {
      orgId: r.org_id, kind: 'roaming.currency_mismatch', severity: 'warning',
      message: `A late partner charge record (${String(c.data?.id ?? c.id)}) is in ${c.currency}, but the driver's card hold was in ${pi.currency}. PlugSure does not convert currencies: nothing more was charged. Collect it another way.`,
      targetType: 'ocpi_remote_cdr', targetId: c.id,
    });
    return { outcome: 'currency_mismatch' };
  }
  const cur = c.currency as CurrencyCode;
  const totalMinor = toMinor(String(c.total_incl_vat ?? c.total_excl_vat), cur);
  const captured = r.settle_outcome === 'captured_session_total' ? Number(pi.amount_captured_minor ?? pi.hold_capture_minor ?? 0) : 0;
  const shortMinor = Math.max(0, totalMinor - captured);
  const refundMinor = Math.max(0, captured - totalMinor);
  await query(`UPDATE driver_roaming_charge SET settle_outcome = 'late_cdr', shortfall_minor = $2 WHERE id = $1`, [r.id, shortMinor || null]);
  if (refundMinor > 0) {
    const { markRefundDue } = await import('../services/refunds.js');
    await markRefundDue(pi.id, refundMinor, 'The partner\'s charge record (after the 4-day rule) came to less than the session total captured');
  }
  if (shortMinor > 0) {
    bus.emit('alert.raised', {
      orgId: r.org_id, kind: 'roaming.hold_shortfall', severity: 'warning',
      message: `A partner charge record (${String(c.data?.id ?? c.id)}) arrived after the 4-day rule had settled the driver's card hold: it came to ${moneyText(totalMinor, cur, 'en')} and ${moneyText(captured, cur, 'en')} was captured. The driver owes ${moneyText(shortMinor, cur, 'en')} and is asked to pay it in the app.`,
      targetType: 'payment_intent', targetId: pi.id,
    });
  }
  logger.info({ chargeId, cdr: c.id, totalMinor, captured, shortMinor, refundMinor }, 'late roaming CDR settled');
  return { outcome: 'late_cdr', captureMinor: captured, shortMinor };
}

/**
 * An accepted charge record for one of our APP_USER tokens that matches no app-driver roaming charge (no hold of
 * ours guarantees it): parked for review with an alert, never silently dropped. An operator who accepts it after
 * review collects it another way (it is not parked again).
 */
async function unmatchedAppCdr(c: RemoteCdr): Promise<{ outcome: string } | null> {
  const t = await one<{ kind: string }>(`SELECT kind FROM token WHERE id = $1`, [c.token_id]);
  if (t?.kind !== 'app') return null;
  const parked = await one<{ id: string }>(
    `UPDATE ocpi_remote_cdr SET status = 'held', hold_reason = $2 WHERE id = $1 AND status = 'accepted' AND reviewed_at IS NULL RETURNING id`,
    [c.id, 'an app driver\'s charge record that matches no roaming charge with a card hold of ours (no payment guarantees it)']);
  if (!parked) return { outcome: 'unmatched_reviewed' };
  bus.emit('alert.raised', {
    orgId: c.org_id, kind: 'roaming.cdr_unmatched', severity: 'warning',
    message: `A partner charge record (${String(c.data?.id ?? c.id)}, ${c.currency} ${c.total_incl_vat ?? c.total_excl_vat}) is for an app driver but matches no partner charge started with a card hold. It is held for review under Roaming; nothing was charged to the driver.`,
    targetType: 'ocpi_remote_cdr', targetId: c.id,
  });
  logger.warn({ cdr: c.id, token: c.token_id }, 'unmatched app-driver roaming CDR held for review');
  return { outcome: 'unmatched' };
}

/** What the driver still owes for partner charges (shortfalls not paid yet), per charge. */
export async function roamingOwed(appDriverId: string | null | undefined) {
  if (!appDriverId) return [];
  return many<{ id: string; org_id: string; payment_intent_id: string; shortfall_minor: number; currency: string; location_id: string; created_at: Date; site: string | null }>(
    `SELECT rc.id, rc.org_id, rc.payment_intent_id, rc.shortfall_minor, rc.currency, rc.location_id, rc.created_at,
            (SELECT l.data->>'name' FROM ocpi_remote_location l WHERE l.partner_id = rc.partner_id AND l.location_id = rc.location_id LIMIT 1) AS site
       FROM driver_roaming_charge rc
      WHERE rc.app_driver_id = $1 AND rc.shortfall_minor > 0 AND rc.shortfall_paid_at IS NULL
      ORDER BY rc.created_at DESC`, [appDriverId]);
}

/** The message refusing a new partner charge (or a new charge) while a partner charge is unpaid. */
export const ROAMING_UNPAID = 'Tagihan jaringan mitra Anda belum lunas. Bayar dulu dari Beranda, lalu coba lagi.';
