import { createHash, randomInt } from 'node:crypto';
import type pg from 'pg';
import { many, one, outsideRequestScope, query, tx } from '../db/pool.js';
import { logger } from '../logger.js';
import { CURRENCIES, isCurrency } from '../domain/money.js';

/**
 * Driver credit (v1.45.0): gift cards, vouchers and referral rewards a driver can pay for charging with.
 *
 *   gift cards    sold by the operator in batches (to a company for its staff, a shop as presents): each code is worth
 *                 its value in credit once redeemed in the app. Paid for, so the credit is a liability until used
 *                 (2260), and income only when it pays for charging; what expires unused is breakage.
 *   vouchers      the same codes given away (a campaign, a goodwill gesture): promotional credit, a marketing cost when
 *                 it is used.
 *   referrals     a driver shares their code; a new driver who enters it and then pays for a first session of at
 *                 least the minimum energy earns both of them the rewards set here (promotional credit). Refused: one's
 *                 own code, a driver who has charged with the operator before, a code entered on a device the referrer
 *                 used, and past the referrer's monthly cap.
 *   paying        at checkout the driver chooses to use credit: it is held (promotional first, then paid-for, the
 *                 soonest to expire first) and only the rest is paid through the payment gateway (never less than
 *                 the operator's minimum). Credit is a means of payment, not a discount: the charge record and its
 *                 taxes are on the full price. When the session settles, what it did not use comes back as credit —
 *                 money paid through the gateway is used first, so credit is never refunded as cash.
 *   expiry        each credit expires `expiry_months` after it was received (a gift card batch can end sooner).
 *
 * The ledger (driver_credit_entry) is append-only apart from `remaining_minor` on credits.
 */

export class CreditError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** No 0/O, 1/I/L: a code read out or typed from a card. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const S = <T>(fn: () => T) => outsideRequestScope(fn);

export const normaliseCode = (code: unknown) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const hashCode = (code: string) => createHash('sha256').update(`plugsure-gift:${normaliseCode(code)}`).digest('hex');
export function newCode(groups = 3, size = 4): string {
  return Array.from({ length: groups }, () => Array.from({ length: size }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')).join('-');
}

// ------------------------------------------------------------------ settings

export interface CreditSettings {
  enabled: boolean; currency: string; expiryMonths: number; minGatewayMinor: number;
  referralEnabled: boolean; referrerRewardMinor: number; refereeRewardMinor: number; referralMinKwh: number; referralMonthlyCap: number;
}

async function orgCurrency(orgId: string): Promise<string> {
  const r = await S(() => one<{ currency: string }>(
    `SELECT co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.org_id = $1 AND s.archived_at IS NULL GROUP BY co.currency ORDER BY count(*) DESC LIMIT 1`, [orgId]));
  return r?.currency ?? Object.keys(CURRENCIES)[0]!;
}

export async function settings(orgId: string): Promise<CreditSettings> {
  const r = await S(() => one<any>(`SELECT * FROM credit_settings WHERE org_id = $1`, [orgId]));
  return {
    enabled: r?.enabled ?? false, currency: r?.currency ?? await orgCurrency(orgId), expiryMonths: r?.expiry_months ?? 12, minGatewayMinor: Number(r?.min_gateway_minor ?? 0),
    referralEnabled: r?.referral_enabled ?? false, referrerRewardMinor: Number(r?.referrer_reward_minor ?? 0), refereeRewardMinor: Number(r?.referee_reward_minor ?? 0),
    referralMinKwh: Number(r?.referral_min_kwh ?? 5), referralMonthlyCap: r?.referral_monthly_cap ?? 10,
  };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null): Promise<CreditSettings> {
  const cur = await settings(orgId);
  const v = <K extends keyof CreditSettings>(k: K): CreditSettings[K] => (b[k] === undefined ? cur[k] : b[k] as CreditSettings[K]);
  const currency = String(v('currency'));
  if (!isCurrency(currency)) throw new CreditError(422, 'currency is one PlugSure supports.');
  const int = (k: keyof CreditSettings, lo: number, hi: number, what: string) => {
    const n = Number(v(k));
    if (!Number.isInteger(n) || n < lo || n > hi) throw new CreditError(422, `${what} is a whole number from ${lo} to ${hi}.`);
    return n;
  };
  const expiry = int('expiryMonths', 1, 60, 'expiryMonths');
  const minGw = int('minGatewayMinor', 0, 1e12, 'minGatewayMinor');
  const rr = int('referrerRewardMinor', 0, 1e12, 'referrerRewardMinor');
  const re = int('refereeRewardMinor', 0, 1e12, 'refereeRewardMinor');
  const cap = int('referralMonthlyCap', 0, 1000, 'referralMonthlyCap');
  const minKwh = Number(v('referralMinKwh'));
  if (!(minKwh >= 0 && minKwh <= 500)) throw new CreditError(422, 'referralMinKwh is 0 to 500.');
  const referral = v('referralEnabled') === true;
  if (referral && rr + re <= 0) throw new CreditError(422, 'Set a reward for the referrer, the new driver, or both.');
  await S(() => query(
    `INSERT INTO credit_settings (org_id, enabled, currency, expiry_months, min_gateway_minor, referral_enabled, referrer_reward_minor, referee_reward_minor, referral_min_kwh, referral_monthly_cap, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, currency = EXCLUDED.currency, expiry_months = EXCLUDED.expiry_months, min_gateway_minor = EXCLUDED.min_gateway_minor,
       referral_enabled = EXCLUDED.referral_enabled, referrer_reward_minor = EXCLUDED.referrer_reward_minor, referee_reward_minor = EXCLUDED.referee_reward_minor,
       referral_min_kwh = EXCLUDED.referral_min_kwh, referral_monthly_cap = EXCLUDED.referral_monthly_cap, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, v('enabled') === true, currency, expiry, minGw, referral, rr, re, minKwh, cap, userId]));
  return settings(orgId);
}

// ------------------------------------------------------------------ gift cards and vouchers

const batchOf = (r: any) => ({
  id: String(r.id), name: r.name, kind: r.kind, currency: r.currency, valueMinor: Number(r.value_minor), quantity: r.quantity, priceMinor: Number(r.price_minor),
  buyer: r.buyer ?? null, soldOn: r.sold_on ? String(r.sold_on instanceof Date ? r.sold_on.toISOString().slice(0, 10) : r.sold_on).slice(0, 10) : null,
  expiresOn: r.expires_on ? String(r.expires_on instanceof Date ? r.expires_on.toISOString().slice(0, 10) : r.expires_on).slice(0, 10) : null,
  redeemed: Number(r.redeemed ?? 0), voided: !!r.voided_at, createdAt: new Date(r.created_at).toISOString(),
});

/** A batch of codes. The codes are returned once, here, and never again (only their hash is kept). */
export async function createBatch(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const s = await settings(orgId);
  const name = String(b.name ?? '').trim().slice(0, 120);
  if (!name) throw new CreditError(422, 'name is required.');
  const kind = b.kind === 'voucher' ? 'voucher' : b.kind === 'gift' ? 'gift' : null;
  if (!kind) throw new CreditError(422, 'kind is gift (sold) or voucher (given away).');
  const currency = String(b.currency ?? s.currency);
  if (!isCurrency(currency)) throw new CreditError(422, 'currency is one PlugSure supports.');
  const value = Number(b.valueMinor), qty = Number(b.quantity);
  if (!Number.isSafeInteger(value) || value <= 0) throw new CreditError(422, 'valueMinor is a whole amount above 0 (minor units).');
  if (!Number.isInteger(qty) || qty < 1 || qty > 10_000) throw new CreditError(422, 'quantity is 1 to 10,000.');
  const price = kind === 'voucher' ? 0 : Number(b.priceMinor ?? value);
  if (!Number.isSafeInteger(price) || price < 0 || price > value) throw new CreditError(422, 'priceMinor is what the buyer paid per card: a whole amount, at most its value.');
  const soldOn = kind === 'gift' ? String(b.soldOn ?? '') : '';
  if (kind === 'gift' && !DATE_RE.test(soldOn)) throw new CreditError(422, 'soldOn (YYYY-MM-DD) is required for gift cards: the day they were paid for.');
  const expiresOn = b.expiresOn ? String(b.expiresOn) : null;
  if (expiresOn && (!DATE_RE.test(expiresOn) || expiresOn <= new Date().toISOString().slice(0, 10))) throw new CreditError(422, 'expiresOn is a date in the future.');
  const cash = b.cashAccountId ? String(b.cashAccountId) : null;
  if (cash && !UUID_RE.test(cash)) throw new CreditError(422, 'No such cash account.');
  const codes: string[] = [];
  const batch = await S(() => tx(async (c) => {
    const r = (await c.query(
      `INSERT INTO gift_card_batch (org_id, name, kind, currency, value_minor, quantity, price_minor, buyer, sold_on, cash_account_id, expires_on, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [orgId, name, kind, currency, value, qty, price, b.buyer ? String(b.buyer).slice(0, 160) : null, soldOn || null, cash, expiresOn, userId])).rows[0];
    for (let i = 0; i < qty; i++) {
      for (let attempt = 0; ; attempt++) {
        const code = newCode();
        const ins = await c.query(`INSERT INTO gift_card (org_id, batch_id, code_hash, code_last4) VALUES ($1,$2,$3,$4) ON CONFLICT (code_hash) DO NOTHING RETURNING id`,
          [orgId, r.id, hashCode(code), code.slice(-4)]);
        if (ins.rowCount) { codes.push(code); break; }
        if (attempt > 5) throw new Error('could not draw a unique gift card code');
      }
    }
    return r;
  }));
  return { batch: batchOf(batch), codes };
}

export async function batches(orgId: string) {
  const rows = await S(() => many<any>(
    `SELECT b.*, (SELECT count(*) FROM gift_card g WHERE g.batch_id = b.id AND g.redeemed_at IS NOT NULL) AS redeemed
       FROM gift_card_batch b WHERE b.org_id = $1 ORDER BY b.created_at DESC LIMIT 200`, [orgId]));
  return rows.map(batchOf);
}

/** Voids the batch's codes not redeemed yet. Credit already redeemed stays the drivers'. */
export async function voidBatch(orgId: string, id: string) {
  const r = await S(() => one<any>(`UPDATE gift_card_batch SET voided_at = COALESCE(voided_at, now()) WHERE id = $1 AND org_id = $2 RETURNING *`, [Number(id) || 0, orgId]));
  if (!r) throw new CreditError(404, 'No such batch.');
  const v = await S(() => query(`UPDATE gift_card SET voided_at = now() WHERE batch_id = $1 AND redeemed_at IS NULL AND voided_at IS NULL`, [r.id]));
  return { id: String(r.id), voidedCards: v.rowCount ?? 0 };
}

/** Wrong codes per driver: at most 10 an hour (an in-process guard; codes are 60 bits). */
const misses = new Map<string, number[]>();
function tooManyMisses(driver: string): boolean {
  const now = Date.now();
  const list = (misses.get(driver) ?? []).filter((t) => now - t < 3_600_000);
  misses.set(driver, list);
  return list.length >= 10;
}

const endOfDay = (d: string) => new Date(`${d}T23:59:59Z`);
const expiryFrom = (months: number, cap: Date | null, now = new Date()) => {
  const t = new Date(now); t.setUTCMonth(t.getUTCMonth() + months);
  return cap && cap < t ? cap : t;
};

/** The driver redeems a gift card or voucher code: credit with the operator that issued it. */
export async function redeem(appDriverId: string, codeRaw: unknown) {
  if (tooManyMisses(appDriverId)) throw new CreditError(429, 'Terlalu banyak kode yang salah. Coba lagi nanti.');
  const code = normaliseCode(codeRaw);
  const miss = () => { misses.set(appDriverId, [...(misses.get(appDriverId) ?? []), Date.now()]); return new CreditError(404, 'Kode tidak ditemukan atau sudah dipakai.'); };
  if (code.length < 8 || code.length > 32) throw miss();
  return S(() => tx(async (c) => {
    const g = (await c.query(
      `SELECT g.*, b.kind, b.currency, b.value_minor, b.expires_on, b.voided_at AS batch_voided FROM gift_card g JOIN gift_card_batch b ON b.id = g.batch_id
        WHERE g.code_hash = $1 FOR UPDATE OF g`, [hashCode(code)])).rows[0];
    if (!g || g.voided_at || g.batch_voided || g.redeemed_at) throw miss();
    const s = await settings(g.org_id);
    if (!s.enabled) throw new CreditError(409, 'Operator ini belum menerima kredit.');
    if (g.expires_on && endOfDay(String(g.expires_on instanceof Date ? g.expires_on.toISOString().slice(0, 10) : g.expires_on).slice(0, 10)) < new Date()) throw new CreditError(410, 'Kode ini sudah kedaluwarsa.');
    const expires = expiryFrom(s.expiryMonths, g.expires_on ? endOfDay(String(g.expires_on instanceof Date ? g.expires_on.toISOString().slice(0, 10) : g.expires_on).slice(0, 10)) : null);
    await c.query(`UPDATE gift_card SET redeemed_by = $2, redeemed_at = now() WHERE id = $1`, [g.id, appDriverId]);
    await c.query(
      `INSERT INTO driver_credit_entry (org_id, app_driver_id, currency, kind, funded, amount_minor, remaining_minor, expires_at, gift_card_id, note)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9)`,
      [g.org_id, appDriverId, g.currency, g.kind === 'gift' ? 'gift_card' : 'voucher', g.kind === 'gift', Number(g.value_minor), expires, g.id, `Code …${g.code_last4}`]);
    return { orgId: g.org_id as string, currency: g.currency as string, amountMinor: Number(g.value_minor), expiresAt: expires.toISOString() };
  }));
}

// ------------------------------------------------------------------ the ledger

export async function balance(orgId: string, appDriverId: string, currency: string, c?: Pick<pg.PoolClient, 'query'>): Promise<{ totalMinor: number; fundedMinor: number }> {
  const sql = `SELECT COALESCE(sum(remaining_minor), 0) AS t, COALESCE(sum(remaining_minor) FILTER (WHERE funded), 0) AS f FROM driver_credit_entry
                WHERE org_id = $1 AND app_driver_id = $2 AND currency = $3 AND remaining_minor > 0 AND (expires_at IS NULL OR expires_at > now())`;
  const r = c ? (await c.query(sql, [orgId, appDriverId, currency])).rows[0] : await S(() => one<any>(sql, [orgId, appDriverId, currency]));
  return { totalMinor: Number(r?.t ?? 0), fundedMinor: Number(r?.f ?? 0) };
}

/**
 * Hold up to `wantMinor` of the driver's credit for a prepaid charge (promotional first, soonest to expire first).
 * Idempotent per charge. Returns what was held.
 */
export async function hold(orgId: string, appDriverId: string, currency: string, wantMinor: number, driverChargeId: string): Promise<{ heldMinor: number; fundedMinor: number }> {
  if (!(wantMinor > 0)) return { heldMinor: 0, fundedMinor: 0 };
  return S(() => tx(async (c) => {
    const done = (await c.query(`SELECT -amount_minor AS held, funded_minor FROM driver_credit_entry WHERE driver_charge_id = $1 AND kind = 'hold'`, [driverChargeId])).rows[0];
    if (done) return { heldMinor: Number(done.held), fundedMinor: Number(done.funded_minor) };
    const lots = (await c.query(
      `SELECT id, remaining_minor, funded, expires_at FROM driver_credit_entry
        WHERE org_id = $1 AND app_driver_id = $2 AND currency = $3 AND remaining_minor > 0 AND (expires_at IS NULL OR expires_at > now())
        ORDER BY funded, expires_at NULLS LAST, id FOR UPDATE`, [orgId, appDriverId, currency])).rows;
    let left = Math.floor(wantMinor), funded = 0, held = 0;
    let soonest: Date | null = null;
    for (const l of lots) {
      if (left <= 0) break;
      const take = Math.min(left, Number(l.remaining_minor));
      await c.query(`UPDATE driver_credit_entry SET remaining_minor = remaining_minor - $2 WHERE id = $1`, [l.id, take]);
      left -= take; held += take;
      if (l.funded) funded += take;
      if (l.expires_at && (!soonest || l.expires_at < soonest)) soonest = l.expires_at;
    }
    if (held > 0) {
      await c.query(
        `INSERT INTO driver_credit_entry (org_id, app_driver_id, currency, kind, funded, amount_minor, funded_minor, expires_at, driver_charge_id, note)
         VALUES ($1,$2,$3,'hold',false,$4,$5,$6,$7,'Charging')`, [orgId, appDriverId, currency, -held, funded, soonest, driverChargeId]);
    }
    return { heldMinor: held, fundedMinor: funded };
  }));
}

/**
 * Settle a charge's credit: `usedMinor` paid for the session, the rest comes back (paid-for credit first). Idempotent:
 * a second call returns what the first settled.
 */
export async function settle(driverChargeId: string, usedMinor: number): Promise<{ usedMinor: number; releasedMinor: number }> {
  return S(() => tx(async (c) => {
    const h = (await c.query(`SELECT * FROM driver_credit_entry WHERE driver_charge_id = $1 AND kind = 'hold' FOR UPDATE`, [driverChargeId])).rows[0];
    if (!h) return { usedMinor: 0, releasedMinor: 0 };
    const prior = (await c.query(`SELECT COALESCE(sum(amount_minor), 0) AS r FROM driver_credit_entry WHERE driver_charge_id = $1 AND kind = 'release'`, [driverChargeId])).rows[0];
    const settledBefore = (await c.query(`SELECT 1 FROM driver_credit_entry WHERE driver_charge_id = $1 AND kind = 'release' LIMIT 1`, [driverChargeId])).rows[0];
    const held = -Number(h.amount_minor);
    if (settledBefore) return { usedMinor: held - Number(prior.r), releasedMinor: Number(prior.r) };
    const used = Math.max(0, Math.min(held, Math.floor(usedMinor)));
    const back = held - used;
    const backFunded = Math.min(Number(h.funded_minor), back), backPromo = back - backFunded;
    for (const [funded, amt] of [[true, backFunded], [false, backPromo]] as const) {
      await c.query(
        `INSERT INTO driver_credit_entry (org_id, app_driver_id, currency, kind, funded, amount_minor, remaining_minor, expires_at, driver_charge_id, note)
         VALUES ($1,$2,$3,'release',$4,$5,$5,$6,$7,'Not used by the session') ON CONFLICT DO NOTHING`,
        [h.org_id, h.app_driver_id, h.currency, funded, amt, h.expires_at, driverChargeId]);
    }
    await c.query(`UPDATE driver_charge SET credit_used_minor = $2, credit_settled_at = now() WHERE id = $1`, [driverChargeId, used]);
    return { usedMinor: used, releasedMinor: back };
  }));
}

/**
 * What a prepaid charge's credit pays when its session settles, given the gateway's part. Card holds and post-pay
 * capture only what is left after credit; a pre-purchase uses the money already paid first, then credit.
 */
export function creditShare(mode: string, heldMinor: number, invoicedMinor: number, capturedMinor: number): number {
  if (heldMinor <= 0 || invoicedMinor <= 0) return 0;
  if (mode === 'preauth' || mode === 'postpay') return Math.min(heldMinor, invoicedMinor);
  return Math.min(heldMinor, Math.max(0, invoicedMinor - capturedMinor));
}

/** The credit held by the prepaid charge paid with this payment, if any. */
export async function heldFor(paymentIntentId: string): Promise<{ driverChargeId: string; heldMinor: number; settled: boolean; usedMinor: number | null } | null> {
  const r = await S(() => one<any>(`SELECT id, credit_hold_minor, credit_settled_at, credit_used_minor FROM driver_charge WHERE payment_intent_id = $1 AND credit_hold_minor > 0`, [paymentIntentId]));
  return r ? { driverChargeId: r.id, heldMinor: Number(r.credit_hold_minor), settled: !!r.credit_settled_at, usedMinor: r.credit_used_minor == null ? null : Number(r.credit_used_minor) } : null;
}

/**
 * Worker: give back credit held by charges that never ran — the payment failed or expired, or nothing started within
 * two hours — and expire credit past its date.
 */
export async function sweep(): Promise<{ released: number; expired: number }> {
  const stale = await S(() => many<{ id: string }>(
    `SELECT dc.id FROM driver_charge dc LEFT JOIN payment_intent pi ON pi.id = dc.payment_intent_id
      WHERE dc.credit_hold_minor > 0 AND dc.credit_settled_at IS NULL
        AND (pi.state IN ('failed', 'expired', 'cancelled') OR (dc.session_id IS NULL AND dc.created_at < now() - interval '2 hours'))
      UNION
     SELECT h.driver_charge_id AS id FROM driver_credit_entry h
      WHERE h.kind = 'hold' AND h.created_at < now() - interval '2 hours' AND NOT EXISTS (SELECT 1 FROM driver_charge dc WHERE dc.id = h.driver_charge_id)
        AND NOT EXISTS (SELECT 1 FROM driver_credit_entry r WHERE r.driver_charge_id = h.driver_charge_id AND r.kind = 'release')
      LIMIT 500`));
  let released = 0;
  for (const s of stale) {
    try { await settle(s.id, 0); released++; } catch (e) { logger.warn({ driverCharge: s.id, err: (e as Error).message }, 'credit release failed'); }
  }
  return { released, expired: await expireCredits() };
}

/** Worker: expire what is left of credits past their date (one 'expire' entry per credit). */
export async function expireCredits(): Promise<number> {
  return S(() => tx(async (c) => {
    const rows = (await c.query(
      `SELECT id, org_id, app_driver_id, currency, funded, remaining_minor FROM driver_credit_entry WHERE remaining_minor > 0 AND expires_at <= now() ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED`)).rows;
    for (const r of rows) {
      await c.query(`UPDATE driver_credit_entry SET remaining_minor = 0 WHERE id = $1`, [r.id]);
      await c.query(
        `INSERT INTO driver_credit_entry (org_id, app_driver_id, currency, kind, funded, amount_minor, note) VALUES ($1,$2,$3,'expire',$4,$5,$6)`,
        [r.org_id, r.app_driver_id, r.currency, r.funded, -Number(r.remaining_minor), `Expired (credit #${r.id})`]);
    }
    return rows.length;
  }));
}

/** An operator's goodwill credit or correction (promotional; a negative adjustment takes from what is left). */
export async function adjust(orgId: string, appDriverId: string, b: Record<string, unknown>, userId: string | null) {
  if (!UUID_RE.test(appDriverId)) throw new CreditError(404, 'No such driver.');
  const s = await settings(orgId);
  const amount = Number(b.amountMinor);
  if (!Number.isSafeInteger(amount) || amount === 0) throw new CreditError(422, 'amountMinor is a whole amount, not 0.');
  const note = String(b.note ?? '').trim().slice(0, 200);
  if (!note) throw new CreditError(422, 'A note is required (why).');
  if (!(await S(() => one(`SELECT 1 FROM app_driver WHERE id = $1`, [appDriverId])))) throw new CreditError(404, 'No such driver.');
  return S(() => tx(async (c) => {
    if (amount > 0) {
      const r = (await c.query(
        `INSERT INTO driver_credit_entry (org_id, app_driver_id, currency, kind, funded, amount_minor, remaining_minor, expires_at, note, created_by)
         VALUES ($1,$2,$3,'adjust',false,$4,$4,$5,$6,$7) RETURNING id`, [orgId, appDriverId, s.currency, amount, expiryFrom(s.expiryMonths, null), note, userId])).rows[0];
      return { id: String(r.id), amountMinor: amount };
    }
    const lots = (await c.query(
      `SELECT id, remaining_minor FROM driver_credit_entry WHERE org_id = $1 AND app_driver_id = $2 AND currency = $3 AND remaining_minor > 0 AND NOT funded ORDER BY expires_at NULLS LAST, id FOR UPDATE`,
      [orgId, appDriverId, s.currency])).rows;
    const have = lots.reduce((a: number, l: any) => a + Number(l.remaining_minor), 0);
    if (have < -amount) throw new CreditError(409, `Only ${have} of promotional credit is left to take back (paid-for credit is never taken back).`);
    let left = -amount;
    for (const l of lots) {
      if (left <= 0) break;
      const take = Math.min(left, Number(l.remaining_minor));
      await c.query(`UPDATE driver_credit_entry SET remaining_minor = remaining_minor - $2 WHERE id = $1`, [l.id, take]);
      left -= take;
    }
    const r = (await c.query(
      `INSERT INTO driver_credit_entry (org_id, app_driver_id, currency, kind, funded, amount_minor, note, created_by) VALUES ($1,$2,$3,'adjust',false,$4,$5,$6) RETURNING id`,
      [orgId, appDriverId, s.currency, amount, note, userId])).rows[0];
    return { id: String(r.id), amountMinor: amount };
  }));
}

// ------------------------------------------------------------------ referrals

export async function referralCode(orgId: string, appDriverId: string): Promise<string> {
  const have = await S(() => one<{ code: string }>(`SELECT code FROM referral_code WHERE org_id = $1 AND app_driver_id = $2`, [orgId, appDriverId]));
  if (have) return have.code;
  for (let i = 0; i < 8; i++) {
    const code = newCode(1, 7);
    const r = await S(() => one<{ code: string }>(
      `INSERT INTO referral_code (org_id, app_driver_id, code) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING code`, [orgId, appDriverId, code]));
    if (r) return r.code;
    const again = await S(() => one<{ code: string }>(`SELECT code FROM referral_code WHERE org_id = $1 AND app_driver_id = $2`, [orgId, appDriverId]));
    if (again) return again.code;
  }
  throw new Error('could not draw a referral code');
}

/** A new driver enters a referral code. */
export async function applyReferral(appDriverId: string, deviceId: string | null, codeRaw: unknown) {
  const code = normaliseCode(codeRaw);
  if (code.length < 5 || code.length > 12) throw new CreditError(404, 'Kode referal tidak ditemukan.');
  const rc = await S(() => one<{ org_id: string; app_driver_id: string }>(`SELECT org_id, app_driver_id FROM referral_code WHERE upper(code) = $1`, [code]));
  if (!rc) throw new CreditError(404, 'Kode referal tidak ditemukan.');
  const s = await settings(rc.org_id);
  if (!s.enabled || !s.referralEnabled) throw new CreditError(409, 'Program referal tidak aktif.');
  if (rc.app_driver_id === appDriverId) throw new CreditError(422, 'Tidak bisa memakai kode sendiri.');
  const charged = await S(() => one(`SELECT 1 FROM driver_charge WHERE app_driver_id = $1 AND org_id = $2 AND session_id IS NOT NULL LIMIT 1`, [appDriverId, rc.org_id]));
  if (charged) throw new CreditError(409, 'Kode referal hanya untuk pengemudi baru.');
  if (await S(() => one(`SELECT 1 FROM referral WHERE org_id = $1 AND referee_id = $2`, [rc.org_id, appDriverId]))) throw new CreditError(409, 'Anda sudah memakai kode referal.');
  // A device the referrer has charged from: the same person with a second number.
  if (deviceId && await S(() => one(`SELECT 1 FROM driver_charge WHERE device_id = $1 AND app_driver_id = $2 LIMIT 1`, [deviceId, rc.app_driver_id]))) {
    await S(() => query(`INSERT INTO referral (org_id, referrer_id, referee_id, status, reason) VALUES ($1,$2,$3,'rejected','same device as the referrer') ON CONFLICT DO NOTHING`, [rc.org_id, rc.app_driver_id, appDriverId]));
    throw new CreditError(409, 'Kode referal tidak bisa dipakai dari perangkat ini.');
  }
  const r = await S(() => one<any>(
    `INSERT INTO referral (org_id, referrer_id, referee_id) VALUES ($1,$2,$3) ON CONFLICT (org_id, referee_id) DO NOTHING RETURNING id`, [rc.org_id, rc.app_driver_id, appDriverId]));
  if (!r) throw new CreditError(409, 'Anda sudah memakai kode referal.');
  return { orgId: rc.org_id, refereeRewardMinor: s.refereeRewardMinor, currency: s.currency, minKwh: s.referralMinKwh };
}

/**
 * Worker: a pending referral whose new driver has paid for a session of at least the minimum energy with the operator
 * is rewarded (both sides), within the referrer's monthly cap; past the cap it is rejected.
 */
export async function qualifyReferrals(): Promise<number> {
  const pend = await S(() => many<any>(
    `SELECT r.*, s.referrer_reward_minor, s.referee_reward_minor, s.referral_min_kwh, s.referral_monthly_cap, s.currency, s.expiry_months, s.enabled, s.referral_enabled,
            (SELECT cs.id FROM driver_charge dc JOIN charging_session cs ON cs.id = dc.session_id JOIN cdr d ON d.session_id = cs.id
              WHERE dc.app_driver_id = r.referee_id AND dc.org_id = r.org_id AND cs.state = 'rated' AND d.total_minor > 0 AND cs.energy_wh >= s.referral_min_kwh * 1000
                AND cs.started_at >= r.created_at ORDER BY cs.started_at LIMIT 1) AS session_id
       FROM referral r JOIN credit_settings s ON s.org_id = r.org_id WHERE r.status = 'pending' LIMIT 500`));
  let n = 0;
  for (const p of pend) {
    if (!p.session_id || !p.enabled || !p.referral_enabled) continue;
    await S(() => tx(async (c) => {
      const cur = (await c.query(`SELECT status FROM referral WHERE id = $1 FOR UPDATE`, [p.id])).rows[0];
      if (cur?.status !== 'pending') return;
      const month = (await c.query(
        `SELECT count(*) AS n FROM referral WHERE org_id = $1 AND referrer_id = $2 AND status = 'rewarded' AND rewarded_at >= date_trunc('month', now())`, [p.org_id, p.referrer_id])).rows[0];
      if (Number(month.n) >= p.referral_monthly_cap) {
        await c.query(`UPDATE referral SET status = 'rejected', reason = 'the referrer reached the monthly cap', qualifying_session_id = $2 WHERE id = $1`, [p.id, p.session_id]);
        return;
      }
      const exp = expiryFrom(p.expiry_months, null);
      for (const [who, amt, note] of [[p.referrer_id, Number(p.referrer_reward_minor), 'Referral: a friend joined'], [p.referee_id, Number(p.referee_reward_minor), 'Referral: welcome']] as const) {
        if (amt > 0) {
          await c.query(
            `INSERT INTO driver_credit_entry (org_id, app_driver_id, currency, kind, funded, amount_minor, remaining_minor, expires_at, referral_id, note)
             VALUES ($1,$2,$3,'referral',false,$4,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [p.org_id, who, p.currency, amt, exp, p.id, note]);
        }
      }
      await c.query(`UPDATE referral SET status = 'rewarded', rewarded_at = now(), qualifying_session_id = $2 WHERE id = $1`, [p.id, p.session_id]);
      n++;
    }));
  }
  return n;
}

// ------------------------------------------------------------------ views

const entryOf = (r: any) => ({
  id: String(r.id), kind: r.kind, funded: r.funded, amountMinor: Number(r.amount_minor), remainingMinor: Number(r.remaining_minor ?? 0), currency: r.currency,
  expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null, note: r.note ?? null, createdAt: new Date(r.created_at).toISOString(),
});

/** The driver's credit with every operator (the app's Kredit page). */
export async function driverCredit(appDriverId: string) {
  const orgs = await S(() => many<any>(
    `SELECT e.org_id, e.currency, o.name AS org_name,
            COALESCE(sum(e.remaining_minor) FILTER (WHERE e.remaining_minor > 0 AND (e.expires_at IS NULL OR e.expires_at > now())), 0) AS balance,
            min(e.expires_at) FILTER (WHERE e.remaining_minor > 0 AND e.expires_at > now()) AS next_expiry
       FROM driver_credit_entry e JOIN organisation o ON o.id = e.org_id WHERE e.app_driver_id = $1 GROUP BY 1, 2, 3 ORDER BY 3`, [appDriverId]));
  const recent = await S(() => many<any>(
    `SELECT e.*, o.name AS org_name FROM driver_credit_entry e JOIN organisation o ON o.id = e.org_id
      WHERE e.app_driver_id = $1 AND NOT (e.kind = 'release' AND e.amount_minor = 0) ORDER BY e.id DESC LIMIT 30`, [appDriverId]));
  const referrals = await S(() => many<any>(
    `SELECT s.org_id, o.name AS org_name, s.referrer_reward_minor, s.referee_reward_minor, s.currency, s.referral_min_kwh FROM credit_settings s JOIN organisation o ON o.id = s.org_id
      WHERE s.enabled AND s.referral_enabled AND EXISTS (SELECT 1 FROM driver_charge dc WHERE dc.app_driver_id = $1 AND dc.org_id = s.org_id AND dc.session_id IS NOT NULL)`, [appDriverId]));
  const codes = [];
  for (const r of referrals) {
    codes.push({ orgId: r.org_id, orgName: r.org_name, code: await referralCode(r.org_id, appDriverId), youGetMinor: Number(r.referrer_reward_minor), friendGetsMinor: Number(r.referee_reward_minor), currency: r.currency, minKwh: Number(r.referral_min_kwh) });
  }
  return {
    balances: orgs.map((o) => ({ orgId: o.org_id, orgName: o.org_name, currency: o.currency, balanceMinor: Number(o.balance), nextExpiry: o.next_expiry ? new Date(o.next_expiry).toISOString() : null })),
    entries: recent.map((r) => ({ ...entryOf(r), orgName: r.org_name })),
    referralCodes: codes,
  };
}

/** The operator's overview: outstanding credit, the month's movement, batches, referrals. */
export async function overview(orgId: string) {
  const s = await settings(orgId);
  const out = await S(() => one<any>(
    `SELECT COALESCE(sum(remaining_minor) FILTER (WHERE funded), 0) AS funded, COALESCE(sum(remaining_minor) FILTER (WHERE NOT funded), 0) AS promo,
            count(DISTINCT app_driver_id) FILTER (WHERE remaining_minor > 0) AS drivers
       FROM driver_credit_entry WHERE org_id = $1 AND currency = $2 AND remaining_minor > 0 AND (expires_at IS NULL OR expires_at > now())`, [orgId, s.currency]));
  const held = await S(() => one<any>(
    `SELECT COALESCE(sum(-h.amount_minor), 0) AS t FROM driver_credit_entry h WHERE h.org_id = $1 AND h.currency = $2 AND h.kind = 'hold'
        AND NOT EXISTS (SELECT 1 FROM driver_credit_entry r WHERE r.driver_charge_id = h.driver_charge_id AND r.kind = 'release')`, [orgId, s.currency]));
  const month = await movement(orgId, new Date().toISOString().slice(0, 7), s.currency);
  const refs = await S(() => many<any>(
    `SELECT r.*, a.phone AS referrer_phone, b.phone AS referee_phone FROM referral r JOIN app_driver a ON a.id = r.referrer_id JOIN app_driver b ON b.id = r.referee_id
      WHERE r.org_id = $1 ORDER BY r.created_at DESC LIMIT 50`, [orgId]));
  const mask = (p: string | null) => (p ? `${p.slice(0, 4)}…${p.slice(-3)}` : null);
  return {
    settings: s,
    outstanding: { fundedMinor: Number(out?.funded ?? 0), promotionalMinor: Number(out?.promo ?? 0), heldMinor: Number(held?.t ?? 0), drivers: Number(out?.drivers ?? 0) },
    month,
    batches: await batches(orgId),
    referrals: refs.map((r) => ({ id: String(r.id), referrer: mask(r.referrer_phone), referee: mask(r.referee_phone), status: r.status, reason: r.reason ?? null, createdAt: new Date(r.created_at).toISOString(), rewardedAt: r.rewarded_at ? new Date(r.rewarded_at).toISOString() : null })),
  };
}

/**
 * A month's movement in one currency, which the ledger posts ('driver_credit'):
 *   gift cards sold         Dr bank (or 1100) / Cr 2260 gift card liability (the price paid; any difference to their
 *                           value is a discount given when sold: Dr 6450)
 *   paid with credit        paid-for credit used: Dr 2260 / Cr 4110 charging paid with credit; promotional credit
 *                           used: Dr 6450 promotions (credit) / Cr 4110
 *   expired                 paid-for credit expired unused: Dr 2260 / Cr 4160 gift card breakage
 */
export async function movement(orgId: string, month: string, currency: string) {
  const sold = await S(() => one<any>(
    `SELECT COALESCE(sum(price_minor * quantity), 0) AS price, COALESCE(sum(value_minor * quantity), 0) AS value FROM gift_card_batch
      WHERE org_id = $1 AND currency = $2 AND kind = 'gift' AND voided_at IS NULL AND to_char(sold_on, 'YYYY-MM') = $3`, [orgId, currency, month]));
  // Used = held − released, per settled charge, dated by the release.
  const used = await S(() => one<any>(
    `SELECT COALESCE(sum(h.funded_minor - COALESCE(rf.amount_minor, 0)), 0) AS funded,
            COALESCE(sum((-h.amount_minor - h.funded_minor) - COALESCE(rp.amount_minor, 0)), 0) AS promo
       FROM driver_credit_entry h
       JOIN driver_credit_entry rf ON rf.driver_charge_id = h.driver_charge_id AND rf.kind = 'release' AND rf.funded
       JOIN driver_credit_entry rp ON rp.driver_charge_id = h.driver_charge_id AND rp.kind = 'release' AND NOT rp.funded
      WHERE h.org_id = $1 AND h.currency = $2 AND h.kind = 'hold' AND to_char(rf.created_at AT TIME ZONE 'UTC', 'YYYY-MM') = $3`, [orgId, currency, month]));
  const exp = await S(() => one<any>(
    `SELECT COALESCE(sum(-amount_minor) FILTER (WHERE funded), 0) AS funded, COALESCE(sum(-amount_minor) FILTER (WHERE NOT funded), 0) AS promo
       FROM driver_credit_entry WHERE org_id = $1 AND currency = $2 AND kind = 'expire' AND to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') = $3`, [orgId, currency, month]));
  const issued = await S(() => one<any>(
    `SELECT COALESCE(sum(amount_minor) FILTER (WHERE kind = 'voucher'), 0) AS vouchers, COALESCE(sum(amount_minor) FILTER (WHERE kind = 'referral'), 0) AS referrals,
            COALESCE(sum(amount_minor) FILTER (WHERE kind = 'gift_card'), 0) AS gift, COALESCE(sum(amount_minor) FILTER (WHERE kind = 'adjust'), 0) AS adjusted
       FROM driver_credit_entry WHERE org_id = $1 AND currency = $2 AND to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') = $3`, [orgId, currency, month]));
  return {
    month, currency,
    giftSoldPriceMinor: Number(sold?.price ?? 0), giftSoldValueMinor: Number(sold?.value ?? 0),
    redeemedGiftMinor: Number(issued?.gift ?? 0), issuedVouchersMinor: Number(issued?.vouchers ?? 0), issuedReferralsMinor: Number(issued?.referrals ?? 0), adjustedMinor: Number(issued?.adjusted ?? 0),
    usedFundedMinor: Number(used?.funded ?? 0), usedPromotionalMinor: Number(used?.promo ?? 0),
    expiredFundedMinor: Number(exp?.funded ?? 0), expiredPromotionalMinor: Number(exp?.promo ?? 0),
  };
}

/** The ledger lines for a month ('driver_credit' source), per currency. */
export async function journalLines(orgId: string, month: string): Promise<Array<{ currency: string; lines: Array<{ account: string; debit: number; credit: number; description: string }> }>> {
  const curs = await S(() => many<{ currency: string }>(
    `SELECT DISTINCT currency FROM driver_credit_entry WHERE org_id = $1 UNION SELECT DISTINCT currency FROM gift_card_batch WHERE org_id = $1`, [orgId]));
  const out = [];
  for (const { currency } of curs) {
    const m = await movement(orgId, month, currency);
    const L: Array<{ account: string; debit: number; credit: number; description: string }> = [];
    if (m.giftSoldPriceMinor || m.giftSoldValueMinor) {
      L.push({ account: '1100', debit: m.giftSoldPriceMinor, credit: 0, description: 'Gift cards sold' });
      if (m.giftSoldValueMinor > m.giftSoldPriceMinor) L.push({ account: '6450', debit: m.giftSoldValueMinor - m.giftSoldPriceMinor, credit: 0, description: 'Gift cards sold below their value' });
      L.push({ account: '2260', debit: 0, credit: m.giftSoldValueMinor, description: 'Gift cards sold' });
    }
    if (m.usedFundedMinor) L.push({ account: '2260', debit: m.usedFundedMinor, credit: 0, description: 'Charging paid with gift card credit' }, { account: '4110', debit: 0, credit: m.usedFundedMinor, description: 'Charging paid with gift card credit' });
    if (m.usedPromotionalMinor) L.push({ account: '6450', debit: m.usedPromotionalMinor, credit: 0, description: 'Charging paid with vouchers and referral credit' }, { account: '4110', debit: 0, credit: m.usedPromotionalMinor, description: 'Charging paid with vouchers and referral credit' });
    if (m.expiredFundedMinor) L.push({ account: '2260', debit: m.expiredFundedMinor, credit: 0, description: 'Gift card credit expired' }, { account: '4160', debit: 0, credit: m.expiredFundedMinor, description: 'Gift card credit expired' });
    const clean = L.filter((l) => l.debit || l.credit);
    if (clean.length) out.push({ currency, lines: clean });
  }
  return out;
}

/** The ledger module interface (general-ledger.ts drafts): lines per currency for a month. */
export async function journal(orgId: string, month: string): Promise<Record<string, Array<{ account: string; debit: number; credit: number; description: string }>>> {
  return Object.fromEntries((await journalLines(orgId, month)).map((j) => [j.currency, j.lines]));
}
