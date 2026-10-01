import type { PoolClient } from 'pg';
import { one, many, query } from '../db/pool.js';
import { config } from '../config.js';
import type { PriceAdjustment, CdrLine } from './tariff.js';
import { adjustmentTotals } from './tariff.js';

/**
 * Memberships (subscription plans) and promotions: who gets which price.
 *
 * At rating (and when a prepaid top-up is quoted) `benefitsFor` finds the
 * customer's live membership and the promotions they qualify for; the caller
 * rates the session under each allowed combination and keeps the cheapest for
 * the customer (`adjustmentOptions`). One promotion per session, on top of the
 * membership unless the promotion says it does not stack.
 *
 * Everything is judged at the moment the session STARTED, like the tariff:
 * a happy hour that ends mid-session still applies to that session.
 */

export class BenefitsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mustId = (id: string, what: string) => { if (!UUID_RE.test(String(id))) throw new BenefitsError(404, `${what} not found`); };
const str = (v: unknown, max = 300) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
const ids = (v: unknown): string[] | null => {
  if (v == null || (Array.isArray(v) && !v.length)) return null;
  if (!Array.isArray(v) || !v.every((x) => UUID_RE.test(String(x)))) throw new BenefitsError(422, 'Lists of sites, plans or accounts must be ids.');
  return v.map(String);
};

// ─────────────────────────────────────────── plans

export const PLAN_COLS = `p.id, p.name, p.description, p.monthly_fee_idr, p.energy_discount_bps, p.member_rate_idr::float8 AS member_rate_idr,
  p.included_kwh::float8 AS included_kwh, p.waive_session_fees, p.current_type, p.site_ids, p.offered_in_app, p.active, p.created_at, p.updated_at`;

export async function listPlans(orgId: string) {
  return many(
    `SELECT ${PLAN_COLS},
            (SELECT count(*)::int FROM subscription s WHERE s.plan_id = p.id AND s.status = 'active') AS members
       FROM subscription_plan p WHERE p.org_id = $1 ORDER BY p.active DESC, p.name`,
    [orgId],
  );
}

function planInput(b: any, creating: boolean) {
  const v: Record<string, unknown> = {};
  if (creating || b.name !== undefined) {
    const name = str(b.name, 120);
    if (!name) throw new BenefitsError(422, 'Give the plan a name.');
    v.name = name;
  }
  if (b.description !== undefined) v.description = str(b.description, 1000);
  if (creating || b.monthlyFeeIdr !== undefined) {
    const f = Number(b.monthlyFeeIdr ?? 0);
    if (!Number.isInteger(f) || f < 0 || f > 100_000_000) throw new BenefitsError(422, 'The monthly fee is a whole rupiah amount, 0 or more.');
    v.monthly_fee_idr = f;
  }
  if (b.energyDiscountPercent !== undefined) {
    const p = Number(b.energyDiscountPercent ?? 0);
    if (!(p >= 0 && p <= 100)) throw new BenefitsError(422, 'The energy discount is 0–100%.');
    v.energy_discount_bps = Math.round(p * 100);
  }
  if (b.memberRateIdr !== undefined) {
    const r = num(b.memberRateIdr);
    if (r != null && !(r >= 0 && r <= 100_000)) throw new BenefitsError(422, 'The member price per kWh must be a rupiah amount.');
    v.member_rate_idr = r;
  }
  if (b.includedKwh !== undefined) {
    const k = Number(b.includedKwh ?? 0);
    if (!(k >= 0 && k <= 100_000)) throw new BenefitsError(422, 'Included kWh is 0 or more.');
    v.included_kwh = k;
  }
  if (b.waiveSessionFees !== undefined) v.waive_session_fees = Boolean(b.waiveSessionFees);
  if (b.currentType !== undefined) {
    if (b.currentType && !['AC', 'DC'].includes(b.currentType)) throw new BenefitsError(422, 'Current type is AC, DC or empty (both).');
    v.current_type = b.currentType || null;
  }
  if (b.siteIds !== undefined) v.site_ids = ids(b.siteIds);
  if (b.offeredInApp !== undefined) v.offered_in_app = Boolean(b.offeredInApp);
  if (b.active !== undefined) v.active = Boolean(b.active);
  return v;
}

const insertOrUpdate = async (table: string, orgId: string, id: string | null, v: Record<string, unknown>) => {
  const cols = Object.keys(v);
  try {
    if (!id) {
      const r = await one<{ id: string }>(
        `INSERT INTO ${table} (org_id${cols.length ? ', ' + cols.join(', ') : ''}) VALUES ($1${cols.map((_, i) => `, $${i + 2}`).join('')}) RETURNING id`,
        [orgId, ...cols.map((c) => v[c])],
      );
      return r!.id;
    }
    if (cols.length) {
      const r = await query(`UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId, ...cols.map((c) => v[c])]);
      if (!r.rowCount) throw new BenefitsError(404, 'not found');
    }
    return id;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new BenefitsError(409, 'That name or code is already used.');
    throw e;
  }
};

export async function getPlan(orgId: string, id: string) {
  mustId(id, 'plan');
  const p = await one(`SELECT ${PLAN_COLS} FROM subscription_plan p WHERE p.id = $1 AND p.org_id = $2`, [id, orgId]);
  if (!p) throw new BenefitsError(404, 'plan not found');
  return p;
}
export async function createPlan(orgId: string, b: any) { return getPlan(orgId, await insertOrUpdate('subscription_plan', orgId, null, planInput(b, true))); }
export async function updatePlan(orgId: string, id: string, b: any) { mustId(id, 'plan'); return getPlan(orgId, await insertOrUpdate('subscription_plan', orgId, id, planInput(b, false))); }

// ─────────────────────────────────────────── subscriptions

const SUB_COLS = `s.id, s.plan_id, p.name AS plan_name, s.subscriber_kind, s.fleet_account_id, fa.name AS fleet_account_name,
  s.token_id, t.uid AS card_uid, s.app_driver_id, ad.phone AS driver_phone, s.billing, s.status, s.started_at,
  s.current_period_start, s.current_period_end, s.cancelled_at, s.notes, s.created_at, s.auto_renew, s.renew_error, s.renew_next_at`;
const SUB_FROM = `FROM subscription s JOIN subscription_plan p ON p.id = s.plan_id
  LEFT JOIN fleet_account fa ON fa.id = s.fleet_account_id LEFT JOIN token t ON t.id = s.token_id LEFT JOIN app_driver ad ON ad.id = s.app_driver_id`;

export async function listSubscriptions(orgId: string, f: { planId?: string; status?: string } = {}) {
  return many(
    `SELECT ${SUB_COLS} ${SUB_FROM}
      WHERE s.org_id = $1 AND ($2::uuid IS NULL OR s.plan_id = $2) AND ($3::text IS NULL OR s.status = $3)
      ORDER BY s.created_at DESC LIMIT 1000`,
    [orgId, f.planId && UUID_RE.test(f.planId) ? f.planId : null, f.status || null],
  );
}

export async function getSubscription(orgId: string, id: string) {
  mustId(id, 'subscription');
  const s = await one(`SELECT ${SUB_COLS} ${SUB_FROM} WHERE s.id = $1 AND s.org_id = $2`, [id, orgId]);
  if (!s) throw new BenefitsError(404, 'subscription not found');
  return s;
}

/** Enrol a fleet account or a card (the console). App drivers buy passes in the app. */
export async function createSubscription(orgId: string, b: any, actor: string) {
  const plan = await getPlan(orgId, String(b.planId ?? ''));
  if (!(plan as any).active) throw new BenefitsError(409, 'The plan is not active.');
  const kind = b.subscriberKind;
  const billing = b.billing ?? 'invoice';
  if (!['invoice', 'complimentary'].includes(billing)) throw new BenefitsError(422, 'Billing is invoice (on the fleet invoice) or complimentary.');
  let fleetAccountId: string | null = null;
  let tokenId: string | null = null;
  if (kind === 'fleet_account') {
    mustId(b.fleetAccountId, 'fleet account');
    const a = await one(`SELECT id FROM fleet_account WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [b.fleetAccountId, orgId]);
    if (!a) throw new BenefitsError(404, 'fleet account not found');
    fleetAccountId = b.fleetAccountId;
  } else if (kind === 'card') {
    const t = await one<{ id: string; fleet_account_id: string | null }>(`SELECT id, fleet_account_id FROM token WHERE org_id = $1 AND uid = $2 AND kind = 'rfid'`, [orgId, String(b.cardUid ?? '').trim()]);
    if (!t) throw new BenefitsError(404, 'card not found');
    if (billing === 'invoice' && !t.fleet_account_id) throw new BenefitsError(422, 'Only a card on a fleet account can be billed on an invoice; use complimentary, or put the card on an account.');
    tokenId = t.id;
  } else {
    throw new BenefitsError(422, 'Subscriber is a fleet account or a card (app drivers subscribe in the app).');
  }
  try {
    const r = await one<{ id: string }>(
      `INSERT INTO subscription (org_id, plan_id, subscriber_kind, fleet_account_id, token_id, billing, status, created_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8) RETURNING id`,
      [orgId, plan.id, kind, fleetAccountId, tokenId, billing, actor, str(b.notes, 500)],
    );
    return getSubscription(orgId, r!.id);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new BenefitsError(409, 'This subscriber already has a live membership; cancel it first.');
    throw e;
  }
}

export async function cancelSubscription(orgId: string, id: string) {
  const s = await getSubscription(orgId, id) as any;
  if (s.status === 'cancelled' || s.status === 'expired') throw new BenefitsError(409, `Already ${s.status}.`);
  await query(`UPDATE subscription SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return getSubscription(orgId, id);
}

// ─────────────────────────────────────────── promotions

const PROMO_COLS = `pr.id, pr.name, pr.description, pr.kind, pr.value::float8 AS value, pr.audience, pr.code, pr.fleet_account_ids, pr.plan_ids,
  pr.site_ids, pr.current_type, pr.starts_at, pr.ends_at, pr.days_mask, to_char(pr.time_from, 'HH24:MI') AS time_from, to_char(pr.time_to, 'HH24:MI') AS time_to,
  pr.min_kwh::float8 AS min_kwh, pr.max_redemptions, pr.max_per_customer, pr.budget_idr, pr.stacks_with_membership, pr.active, pr.created_at, pr.updated_at`;
const PROMO_STATS = `(SELECT count(*)::int FROM promotion_redemption r WHERE r.promotion_id = pr.id) AS redemptions,
  (SELECT COALESCE(sum(r.discount_idr), 0)::bigint FROM promotion_redemption r WHERE r.promotion_id = pr.id) AS discount_idr,
  (SELECT count(DISTINCT r.customer_key)::int FROM promotion_redemption r WHERE r.promotion_id = pr.id) AS customers`;

export async function listPromotions(orgId: string) {
  return many(`SELECT ${PROMO_COLS}, ${PROMO_STATS} FROM promotion pr WHERE pr.org_id = $1 ORDER BY pr.active DESC, pr.starts_at DESC`, [orgId]);
}
export async function getPromotion(orgId: string, id: string) {
  mustId(id, 'promotion');
  const p = await one(`SELECT ${PROMO_COLS}, ${PROMO_STATS} FROM promotion pr WHERE pr.id = $1 AND pr.org_id = $2`, [id, orgId]);
  if (!p) throw new BenefitsError(404, 'promotion not found');
  return p;
}

function promoInput(b: any, creating: boolean) {
  const v: Record<string, unknown> = {};
  if (creating || b.name !== undefined) {
    const n = str(b.name, 120);
    if (!n) throw new BenefitsError(422, 'Give the promotion a name.');
    v.name = n;
  }
  if (b.description !== undefined) v.description = str(b.description, 1000);
  if (creating || b.kind !== undefined) {
    if (!['energy_percent', 'energy_rate', 'amount_off', 'free_kwh', 'waive_fees'].includes(b.kind)) throw new BenefitsError(422, 'Kind is energy_percent, energy_rate, amount_off, free_kwh or waive_fees.');
    v.kind = b.kind;
  }
  if (creating || b.value !== undefined) {
    const val = Number(b.value ?? 0);
    const kind = (v.kind ?? b.kind) as string | undefined;
    if (!(val >= 0)) throw new BenefitsError(422, 'The value must be 0 or more.');
    if (kind === 'energy_percent' && val > 100) throw new BenefitsError(422, 'A percentage is at most 100.');
    if (kind && kind !== 'waive_fees' && val <= 0) throw new BenefitsError(422, 'Enter the discount value.');
    v.value = val;
  }
  if (creating || b.audience !== undefined) {
    const a = b.audience ?? 'everyone';
    if (!['everyone', 'new_drivers', 'fleet_accounts', 'plan_members', 'code'].includes(a)) throw new BenefitsError(422, 'Audience is everyone, new_drivers, fleet_accounts, plan_members or code.');
    v.audience = a;
  }
  if (b.code !== undefined) {
    const c = str(b.code, 30)?.toUpperCase() ?? null;
    if (c && !/^[A-Z0-9-]{3,30}$/.test(c)) throw new BenefitsError(422, 'A promo code is 3–30 letters, digits or dashes.');
    v.code = c;
  }
  if ((v.audience ?? b.audience) === 'code' && creating && !v.code) throw new BenefitsError(422, 'A code-only promotion needs a code.');
  if (b.fleetAccountIds !== undefined) v.fleet_account_ids = ids(b.fleetAccountIds);
  if (b.planIds !== undefined) v.plan_ids = ids(b.planIds);
  if (b.siteIds !== undefined) v.site_ids = ids(b.siteIds);
  if (b.currentType !== undefined) {
    if (b.currentType && !['AC', 'DC'].includes(b.currentType)) throw new BenefitsError(422, 'Current type is AC, DC or empty (both).');
    v.current_type = b.currentType || null;
  }
  const date = (x: unknown, what: string) => {
    if (x == null || x === '') return null;
    const d = new Date(String(x));
    if (Number.isNaN(d.getTime())) throw new BenefitsError(422, `${what} must be a date and time.`);
    return d;
  };
  if (b.startsAt !== undefined) v.starts_at = date(b.startsAt, 'Start') ?? new Date();
  if (b.endsAt !== undefined) v.ends_at = date(b.endsAt, 'End');
  if (v.starts_at && v.ends_at && (v.ends_at as Date) <= (v.starts_at as Date)) throw new BenefitsError(422, 'The end is after the start.');
  if (b.daysMask !== undefined) {
    const m = Number(b.daysMask);
    if (!Number.isInteger(m) || m < 1 || m > 127) throw new BenefitsError(422, 'Choose at least one day.');
    v.days_mask = m;
  }
  const time = (x: unknown) => {
    if (x == null || x === '') return null;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(x))) throw new BenefitsError(422, 'Times are HH:MM.');
    return String(x);
  };
  if (b.timeFrom !== undefined) v.time_from = time(b.timeFrom);
  if (b.timeTo !== undefined) v.time_to = time(b.timeTo);
  if (b.minKwh !== undefined) v.min_kwh = Math.max(0, Number(b.minKwh ?? 0) || 0);
  for (const [k, c] of [['maxRedemptions', 'max_redemptions'], ['maxPerCustomer', 'max_per_customer'], ['budgetIdr', 'budget_idr']] as const) {
    if (b[k] === undefined) continue;
    const n = num(b[k]);
    if (n != null && (!Number.isInteger(n) || n < 1)) throw new BenefitsError(422, `${k} is a whole number of at least 1, or empty for no limit.`);
    v[c] = n;
  }
  if (b.stacksWithMembership !== undefined) v.stacks_with_membership = Boolean(b.stacksWithMembership);
  if (b.active !== undefined) v.active = Boolean(b.active);
  return v;
}
export async function createPromotion(orgId: string, b: any) { return getPromotion(orgId, await insertOrUpdate('promotion', orgId, null, promoInput(b, true))); }
export async function updatePromotion(orgId: string, id: string, b: any) { mustId(id, 'promotion'); return getPromotion(orgId, await insertOrUpdate('promotion', orgId, id, promoInput(b, false))); }

// ─────────────────────────────────────────── who gets what

export interface Who {
  tokenId?: string | null;
  fleetAccountId?: string | null;
  appDriverId?: string | null;
  deviceId?: string | null;
  promoCode?: string | null;
  /** The session being rated (excluded from limits and "new driver" checks). */
  sessionId?: string | null;
}
export interface Where { siteId: string; currentType: 'AC' | 'DC' | string }

export interface Membership {
  subscriptionId: string;
  planId: string;
  planName: string;
  periodStart: Date;
  remainingKwh: number;
  adjustment: PriceAdjustment;
}
export interface EligiblePromotion { id: string; name: string; stacks: boolean; adjustment: PriceAdjustment }
export interface Benefits { customerKey: string | null; membership: Membership | null; promotions: EligiblePromotion[]; codeProblem: string | null }

const localParts = (at: Date, tz: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit' })
    .formatToParts(at).map((x) => [x.type, x.value]));
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday!);
  return { dow, hhmm: `${p.hour}:${p.minute}`, month: `${p.year}-${p.month}` };
};

/** Start of the calendar month containing `at`, in the billing time zone. */
async function monthStart(at: Date): Promise<Date> {
  const r = await one<{ d: Date }>(`SELECT (date_trunc('month', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2) AS d`, [at, config.billing.timeZone]);
  return r!.d;
}

export function customerKeyOf(w: Who): string | null {
  if (w.appDriverId) return `driver:${w.appDriverId}`;
  if (w.tokenId) return `card:${w.tokenId}`;
  if (w.deviceId) return `device:${w.deviceId}`;
  return null;
}

/**
 * Whether a customer key names a CUSTOMER — an app account or a card — rather
 * than an install of the app.
 *
 * A guest (no account, paying by QRIS with a minted one-off token) is known
 * only by `device:<id>`, and the device id is whatever the app generated at
 * install: reinstalling, clearing app data or a second phone gives a new one.
 * Keyed on that, "one per customer" reset on every reinstall and every guest
 * was a "new driver" forever. So promotions that limit per customer, and those
 * for new drivers, are not given to device-only identities at all — the
 * conservative choice: the promotion is for people we can count, and a guest
 * who signs in (or uses a card) qualifies normally. Everything else (open
 * promotions, codes, happy hours) still applies to guests.
 */
export const isStableCustomer = (key: string | null | undefined): boolean =>
  !!key && (key.startsWith('driver:') || key.startsWith('card:'));

export async function benefitsFor(orgId: string, who: Who, where: Where, at: Date, tz = 'Asia/Jakarta'): Promise<Benefits> {
  const customerKey = customerKeyOf(who);
  const stable = isStableCustomer(customerKey);
  let fleetAccountId = who.fleetAccountId ?? null;
  if (!fleetAccountId && who.tokenId) {
    fleetAccountId = (await one<{ f: string | null }>(`SELECT fleet_account_id AS f FROM token WHERE id = $1`, [who.tokenId]))?.f ?? null;
  }

  // --- membership: card, then fleet account, then app account
  const subs = await many<any>(
    `SELECT s.id, s.billing, s.status, s.started_at, s.cancelled_at, s.current_period_start, s.current_period_end, s.subscriber_kind,
            p.id AS plan_id, p.name, p.energy_discount_bps, p.member_rate_idr::float8 AS member_rate, p.included_kwh::float8 AS included_kwh,
            p.waive_session_fees, p.current_type, p.site_ids
       FROM subscription s JOIN subscription_plan p ON p.id = s.plan_id
      WHERE s.org_id = $1 AND s.status IN ('active', 'cancelled', 'expired')
        AND ((s.token_id IS NOT NULL AND s.token_id = $2) OR (s.fleet_account_id IS NOT NULL AND s.fleet_account_id = $3)
             OR (s.app_driver_id IS NOT NULL AND s.app_driver_id = $4))
      ORDER BY CASE s.subscriber_kind WHEN 'card' THEN 0 WHEN 'fleet_account' THEN 1 ELSE 2 END, s.created_at DESC`,
    [orgId, who.tokenId ?? null, fleetAccountId, who.appDriverId ?? null],
  );
  let membership: Membership | null = null;
  for (const s of subs) {
    const inForce = s.billing === 'qris'
      ? s.current_period_start && s.current_period_end && new Date(s.current_period_start) <= at && at < new Date(s.current_period_end)
      : new Date(s.started_at) <= at && (s.status === 'active' || (s.cancelled_at && at < new Date(s.cancelled_at)));
    if (!inForce) continue;
    if (s.current_type && s.current_type !== where.currentType) continue;
    if (s.site_ids?.length && !s.site_ids.includes(where.siteId)) continue;
    const periodStart = s.billing === 'qris' ? new Date(s.current_period_start) : await monthStart(at);
    let remainingKwh = 0;
    if (s.included_kwh > 0) {
      const used = await one<{ used: number }>(
        `SELECT COALESCE((SELECT used_kwh::float8 FROM subscription_usage WHERE subscription_id = $1 AND period_start = $2), 0)
              - COALESCE((SELECT included_kwh::float8 FROM subscription_session WHERE session_id = $3 AND subscription_id = $1 AND period_start = $2), 0) AS used`,
        [s.id, periodStart, who.sessionId ?? null],
      );
      remainingKwh = Math.max(0, s.included_kwh - (used?.used ?? 0));
    }
    membership = {
      subscriptionId: s.id, planId: s.plan_id, planName: s.name, periodStart, remainingKwh,
      adjustment: {
        source: 'subscription', id: s.id, name: s.name,
        energyRateIdr: s.member_rate ?? null,
        freeKwh: remainingKwh || null,
        energyPercentOffBps: s.energy_discount_bps || null,
        waiveSessionFees: s.waive_session_fees,
      },
    };
    break;
  }

  // --- promotions
  const code = who.promoCode ? String(who.promoCode).trim().toUpperCase() : null;
  const promos = await many<any>(
    `SELECT pr.*, pr.value::float8 AS v, to_char(pr.time_from, 'HH24:MI') AS tf, to_char(pr.time_to, 'HH24:MI') AS tt,
            (SELECT count(*)::int FROM promotion_redemption r WHERE r.promotion_id = pr.id AND r.session_id IS DISTINCT FROM $3) AS used,
            (SELECT count(*)::int FROM promotion_redemption r WHERE r.promotion_id = pr.id AND r.customer_key = $4 AND r.session_id IS DISTINCT FROM $3) AS used_by_me,
            (SELECT COALESCE(sum(r.discount_idr), 0)::bigint FROM promotion_redemption r WHERE r.promotion_id = pr.id AND r.session_id IS DISTINCT FROM $3) AS spent
       FROM promotion pr
      WHERE pr.org_id = $1 AND pr.active AND pr.starts_at <= $2 AND (pr.ends_at IS NULL OR $2 < pr.ends_at)`,
    [orgId, at, who.sessionId ?? null, customerKey ?? ''],
  );
  const { dow, hhmm } = localParts(at, tz);
  let isNew: boolean | null = null;
  const newDriver = async () => {
    if (isNew != null) return isNew;
    // An app account by its own history, a card by the card's. A device-only
    // guest is never "new" (isStableCustomer): a fresh install would make it so.
    const prior = who.appDriverId
      ? await one<{ n: number }>(`SELECT count(*)::int AS n FROM driver_charge dc JOIN cdr d ON d.session_id = dc.session_id WHERE dc.app_driver_id = $1 AND dc.session_id IS DISTINCT FROM $2`, [who.appDriverId, who.sessionId ?? null])
      : who.tokenId
        ? await one<{ n: number }>(`SELECT count(*)::int AS n FROM charging_session cs JOIN cdr d ON d.session_id = cs.id WHERE cs.token_id = $1 AND cs.id IS DISTINCT FROM $2`, [who.tokenId, who.sessionId ?? null])
        : { n: 1 };
    isNew = (prior?.n ?? 1) === 0;
    return isNew;
  };
  const eligible: EligiblePromotion[] = [];
  let codeMatched = false;
  for (const p of promos) {
    if (p.code && code && p.code.toUpperCase() === code) codeMatched = true;
    if (!((p.days_mask >> dow) & 1)) continue;
    if (p.tf && p.tt && !(p.tf <= p.tt ? hhmm >= p.tf && hhmm < p.tt : hhmm >= p.tf || hhmm < p.tt)) continue;
    if (p.current_type && p.current_type !== where.currentType) continue;
    if (p.site_ids?.length && !p.site_ids.includes(where.siteId)) continue;
    // A quick screen only: the limits are enforced when the session is billed,
    // under the promotion's lock (reservePromotion).
    if (p.max_redemptions != null && p.used >= p.max_redemptions) continue;
    // Per-customer limits need a customer to count against (isStableCustomer).
    if (p.max_per_customer != null && (!stable || p.used_by_me >= p.max_per_customer)) continue;
    if (p.budget_idr != null && Number(p.spent) >= Number(p.budget_idr)) continue;
    if (p.audience === 'code' && !(code && p.code && p.code.toUpperCase() === code)) continue;
    if (p.audience === 'fleet_accounts' && !(fleetAccountId && p.fleet_account_ids?.includes(fleetAccountId))) continue;
    if (p.audience === 'plan_members' && !(membership && p.plan_ids?.includes(membership.planId))) continue;
    if (p.audience === 'new_drivers' && !(stable && (await newDriver()))) continue;
    const adj: PriceAdjustment = { source: 'promotion', id: p.id, name: p.name };
    if (p.kind === 'energy_percent') adj.energyPercentOffBps = Math.round(p.v * 100);
    else if (p.kind === 'energy_rate') adj.energyRateIdr = p.v;
    else if (p.kind === 'amount_off') adj.amountOffIdr = p.v;
    else if (p.kind === 'free_kwh') adj.freeKwh = p.v;
    else adj.waiveSessionFees = true;
    (adj as any).minKwh = Number(p.min_kwh) || 0;
    eligible.push({ id: p.id, name: p.name, stacks: p.stacks_with_membership, adjustment: adj });
  }
  const codeProblem = code && !eligible.some((e) => promos.find((p) => p.id === e.id)?.code?.toUpperCase() === code)
    ? (codeMatched ? 'Kode promo tidak berlaku untuk pengisian ini.' : 'Kode promo tidak dikenal.')
    : null;
  return { customerKey, membership, promotions: eligible, codeProblem };
}

/**
 * Every allowed combination: nothing, the membership alone, and each
 * promotion (with the membership when it stacks). A promotion's minimum kWh
 * is judged by the caller against the energy delivered.
 */
export function adjustmentOptions(b: Benefits, energyKwh: number | null): PriceAdjustment[][] {
  const m = b.membership ? [b.membership.adjustment] : [];
  const out: PriceAdjustment[][] = [m];
  for (const p of b.promotions) {
    const min = (p.adjustment as any).minKwh ?? 0;
    if (energyKwh != null && energyKwh < min) continue;
    const adj = { ...p.adjustment };
    delete (adj as any).minKwh;
    out.push(p.stacks ? [...m, adj] : [adj]);
  }
  return out;
}

/** The cheapest option for the customer (fewest adjustments on a tie). */
export function pickCheapest<T>(options: PriceAdjustment[][], price: (o: PriceAdjustment[]) => T & { total: number }): { option: PriceAdjustment[]; result: T & { total: number } } {
  let best: { option: PriceAdjustment[]; result: T & { total: number } } | null = null;
  for (const o of options) {
    const r = price(o);
    if (!best || r.total < best.result.total || (r.total === best.result.total && o.length < best.option.length)) best = { option: o, result: r };
  }
  return best!;
}

/**
 * Claim a promotion's use for a session, or say it is no longer available.
 *
 * `max_redemptions`, `max_per_customer` and `budget_idr` were checked when the
 * session was priced (benefitsFor) and the redemption written afterwards, with
 * no lock in between, so sessions rated together all saw the last free slot —
 * or the last of the budget — and all took it. The limits are now re-checked
 * here, under a transaction-scoped lock on the promotion, and the redemption
 * written in the same breath, on the CDR's own transaction (`c`): the next
 * session to rate waits, then counts this one.
 *
 * The budget is never overshot: the discount must FIT what is left of it
 * (benefitsFor's screen only asks whether anything is left). A promotion that
 * no longer fits returns false and the caller re-prices the session without it.
 */
export async function reservePromotion(
  c: Pick<PoolClient, 'query'>,
  orgId: string,
  sessionId: string,
  promotionId: string,
  customerKey: string | null,
  discountIdr: number,
): Promise<boolean> {
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('promotion:' || $1::text, 0))`, [promotionId]);
  const r = await c.query<{ max_redemptions: number | null; max_per_customer: number | null; budget_idr: number | null; used: number; used_by_me: number; spent: number }>(
    `SELECT pr.max_redemptions, pr.max_per_customer, pr.budget_idr,
            (SELECT count(*)::int FROM promotion_redemption r WHERE r.promotion_id = pr.id AND r.session_id <> $2) AS used,
            (SELECT count(*)::int FROM promotion_redemption r WHERE r.promotion_id = pr.id AND r.customer_key = $3 AND r.session_id <> $2) AS used_by_me,
            (SELECT COALESCE(sum(r.discount_idr), 0)::bigint FROM promotion_redemption r WHERE r.promotion_id = pr.id AND r.session_id <> $2) AS spent
       FROM promotion pr WHERE pr.id = $1 AND pr.org_id = $4`,
    [promotionId, sessionId, customerKey ?? '', orgId],
  );
  const p = r.rows[0];
  if (!p) return false;
  if (p.max_redemptions != null && p.used + 1 > p.max_redemptions) return false;
  if (p.max_per_customer != null && (!isStableCustomer(customerKey) || p.used_by_me + 1 > p.max_per_customer)) return false;
  if (p.budget_idr != null && Number(p.spent) + discountIdr > Number(p.budget_idr)) return false;
  await c.query(
    `INSERT INTO promotion_redemption (session_id, promotion_id, org_id, customer_key, discount_idr) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (session_id) DO UPDATE SET promotion_id = EXCLUDED.promotion_id, discount_idr = EXCLUDED.discount_idr`,
    [sessionId, promotionId, orgId, customerKey ?? `session:${sessionId}`, discountIdr],
  );
  return true;
}

/**
 * With a CDR: remember which membership priced it (its included kWh used this
 * period). Promotions are recorded by reservePromotion, which also enforces
 * their limits. Runs on the CDR's transaction.
 */
export async function recordBenefits(orgId: string, sessionId: string, lines: CdrLine[], b: Benefits, energyKwh: number, c: Pick<PoolClient, 'query'>) {
  const totals = adjustmentTotals(lines);
  for (const [id, t] of totals) {
    if (t.source === 'subscription' && b.membership && b.membership.subscriptionId === id) {
      const m = b.membership;
      const includedUsed = m.adjustment.freeKwh ? Math.min(m.adjustment.freeKwh, energyKwh) : 0;
      const prev = (await c.query<{ k: number }>(`SELECT included_kwh::float8 AS k FROM subscription_session WHERE session_id = $1`, [sessionId])).rows[0];
      await c.query(
        `INSERT INTO subscription_session (session_id, subscription_id, org_id, period_start, included_kwh, discount_idr) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (session_id) DO UPDATE SET included_kwh = EXCLUDED.included_kwh, discount_idr = EXCLUDED.discount_idr`,
        [sessionId, id, orgId, m.periodStart, includedUsed, t.discountIdr],
      );
      const delta = includedUsed - (prev?.k ?? 0);
      if (delta) {
        await c.query(
          `INSERT INTO subscription_usage (subscription_id, org_id, period_start, used_kwh) VALUES ($1,$2,$3,$4)
           ON CONFLICT (subscription_id, period_start) DO UPDATE SET used_kwh = subscription_usage.used_kwh + EXCLUDED.used_kwh`,
          [id, orgId, m.periodStart, delta],
        );
      }
    }
  }
}

// ─────────────────────────────────────────── membership fees

const PKP_TAX = (fee: number, pkp: boolean) => {
  if (!pkp) return { dpp: 0, ppn: 0, total: fee };
  const dpp = Math.round((fee * config.tax.ppnDppNumerator) / config.tax.ppnDppDenominator);
  const ppn = Math.round((dpp * config.tax.ppnRateBps) / 10_000);
  return { dpp, ppn, total: fee + ppn };
};
export const feeTax = PKP_TAX;

/**
 * A monthly fee for the part of the month a membership was in force: the whole fee
 * for a whole month, else the fee × days in force / days in the month (rounded).
 * Days count in whole days, rounded up, so a membership started at noon pays that day.
 */
export function proratedFee(monthlyFeeIdr: number, from: Date, to: Date, startedAt: Date, endedAt: Date | null): { feeIdr: number; days: number; daysInPeriod: number } {
  const DAY = 86_400_000;
  const daysInPeriod = Math.round((to.getTime() - from.getTime()) / DAY);
  const a = Math.max(from.getTime(), startedAt.getTime());
  const b = Math.min(to.getTime(), endedAt ? endedAt.getTime() : to.getTime());
  const days = Math.max(0, Math.min(daysInPeriod, Math.ceil((b - a) / DAY)));
  if (days >= daysInPeriod) return { feeIdr: monthlyFeeIdr, days: daysInPeriod, daysInPeriod };
  return { feeIdr: Math.round((monthlyFeeIdr * days) / daysInPeriod), days, daysInPeriod };
}

/**
 * Invoice-billed memberships of a fleet account (its own, and its cards')
 * that were in force during the month and are not billed yet, each for the
 * days it was in force.
 */
export async function membershipFeesFor(orgId: string, accountId: string, from: Date, to: Date) {
  const pkp = (await one<{ pkp: boolean }>(`SELECT pkp FROM organisation WHERE id = $1`, [orgId]))?.pkp ?? false;
  const rows = await many<any>(
    `SELECT s.id, s.subscriber_kind, s.started_at, s.cancelled_at, p.name AS plan_name, p.monthly_fee_idr, t.uid AS card_uid
       FROM subscription s JOIN subscription_plan p ON p.id = s.plan_id LEFT JOIN token t ON t.id = s.token_id
      WHERE s.org_id = $1 AND s.billing = 'invoice'
        AND (s.fleet_account_id = $2 OR t.fleet_account_id = $2)
        AND s.started_at < $4 AND (s.cancelled_at IS NULL OR s.cancelled_at >= $3)
        AND NOT EXISTS (SELECT 1 FROM subscription_charge c WHERE c.subscription_id = s.id AND c.period_start = $3 AND c.state <> 'void')
      ORDER BY p.name, t.uid NULLS FIRST`,
    [orgId, accountId, from, to],
  );
  return rows.filter((r) => r.monthly_fee_idr > 0).map((r) => {
    const pr = proratedFee(r.monthly_fee_idr, from, to, new Date(r.started_at), r.cancelled_at ? new Date(r.cancelled_at) : null);
    const tax = PKP_TAX(pr.feeIdr, pkp);
    const part = pr.days < pr.daysInPeriod ? `, ${pr.days} of ${pr.daysInPeriod} days` : '';
    return {
      subscriptionId: r.id as string, planName: r.plan_name as string,
      subscriber: `${r.subscriber_kind === 'card' ? `card ${r.card_uid}` : 'fleet account'}${part}`,
      feeIdr: pr.feeIdr, taxBaseIdr: pkp ? pr.feeIdr : 0, dppIdr: tax.dpp, ppnIdr: tax.ppn, totalIdr: tax.total,
      monthlyFeeIdr: r.monthly_fee_idr as number, days: pr.days, daysInPeriod: pr.daysInPeriod,
      periodStart: from.toISOString(), periodEnd: to.toISOString(),
    };
  }).filter((f) => f.feeIdr > 0);
}
