import { one, many, query, tx } from '../db/pool.js';
import type { PriceAdjustment, CdrLine } from './tariff.js';

/**
 * Loyalty points (Commercial → Promotions & plans → Loyalty), per operator.
 *
 *   Earning     a driver signed in to the app earns points on what each session
 *               costs them: `earn_per_1000_idr` points per Rp 1,000 of the receipt
 *               total (after any discount), rounded down.
 *   Spending    a driver who chose "use my points" has them taken off their next
 *               sessions automatically: at most `max_redeem_bps` of the energy and
 *               fees, in whole points worth `point_value_idr` each. Like a promotion,
 *               the discount comes before PBJT-TL and PPN.
 *   Expiry      each earning expires `expiry_months` after it was earned; points are
 *               spent oldest first.
 *
 * The ledger (loyalty_entry) is append-only apart from `remaining` on earnings.
 * A session earns and spends at most once (re-rating cannot double either).
 */

export class LoyaltyError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface LoyaltyProgram {
  enabled: boolean;
  earnPer1000Idr: number;
  pointValueIdr: number;
  maxRedeemBps: number;
  expiryMonths: number;
}

const DEFAULTS: LoyaltyProgram = { enabled: false, earnPer1000Idr: 1, pointValueIdr: 10, maxRedeemBps: 5000, expiryMonths: 12 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────── arithmetic (pure)

/** Points earned on a session that cost the driver `totalIdr`. */
export function pointsEarned(totalIdr: number, p: Pick<LoyaltyProgram, 'earnPer1000Idr'>): number {
  if (totalIdr <= 0 || p.earnPer1000Idr <= 0) return 0;
  return Math.floor((totalIdr * p.earnPer1000Idr) / 1000);
}

/**
 * What points may pay on a session: whole points, worth at most `maxRedeemBps` of
 * the energy and fees that can be discounted (`discountableIdr`).
 */
export function pointsToRedeem(balance: number, discountableIdr: number, p: Pick<LoyaltyProgram, 'pointValueIdr' | 'maxRedeemBps'>): { points: number; amountIdr: number } {
  if (balance <= 0 || discountableIdr <= 0 || p.pointValueIdr <= 0 || p.maxRedeemBps <= 0) return { points: 0, amountIdr: 0 };
  const cap = Math.floor((discountableIdr * p.maxRedeemBps) / 10_000);
  const points = Math.min(balance, Math.floor(cap / p.pointValueIdr));
  return { points, amountIdr: points * p.pointValueIdr };
}

/** The energy and fees a price adjustment can take off (what applyAdjustments may discount). */
export const discountable = (lines: CdrLine[]) => lines.filter((l) => ['energy', 'session', 'admin'].includes(l.kind)).reduce((a, l) => a + l.amountIdr, 0);

// ─────────────────────────────────────────── program (console)

export async function getProgram(orgId: string): Promise<LoyaltyProgram> {
  const r = await one<any>(`SELECT * FROM loyalty_program WHERE org_id = $1`, [orgId]);
  return r
    ? { enabled: r.enabled, earnPer1000Idr: r.earn_per_1000_idr, pointValueIdr: r.point_value_idr, maxRedeemBps: r.max_redeem_bps, expiryMonths: r.expiry_months }
    : { ...DEFAULTS };
}

export async function saveProgram(orgId: string, b: any, actor: string): Promise<LoyaltyProgram> {
  const cur = await getProgram(orgId);
  const int = (v: unknown, name: string, lo: number, hi: number, def: number) => {
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new LoyaltyError(422, `${name} is a whole number from ${lo} to ${hi}.`);
    return n;
  };
  const next: LoyaltyProgram = {
    enabled: b.enabled === undefined ? cur.enabled : b.enabled === true,
    earnPer1000Idr: int(b.earnPer1000Idr, 'Points per Rp 1,000', 0, 1000, cur.earnPer1000Idr),
    pointValueIdr: int(b.pointValueIdr, 'The value of a point (Rp)', 1, 100_000, cur.pointValueIdr),
    maxRedeemBps: int(b.maxRedeemBps, 'The most points may pay (basis points)', 0, 10_000, cur.maxRedeemBps),
    expiryMonths: int(b.expiryMonths, 'Months before points expire', 1, 60, cur.expiryMonths),
  };
  await query(
    `INSERT INTO loyalty_program (org_id, enabled, earn_per_1000_idr, point_value_idr, max_redeem_bps, expiry_months, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (org_id) DO UPDATE SET enabled = $2, earn_per_1000_idr = $3, point_value_idr = $4, max_redeem_bps = $5, expiry_months = $6, updated_by = $7, updated_at = now()`,
    [orgId, next.enabled, next.earnPer1000Idr, next.pointValueIdr, next.maxRedeemBps, next.expiryMonths, actor],
  );
  return next;
}

/** Points outstanding and what they are worth (a liability), and this month's movement. */
export async function programStats(orgId: string) {
  const p = await getProgram(orgId);
  const o = await one<any>(
    `SELECT COALESCE(sum(remaining) FILTER (WHERE kind IN ('earn', 'adjust') AND (expires_at IS NULL OR expires_at > now())), 0)::bigint AS outstanding,
            count(DISTINCT app_driver_id) FILTER (WHERE remaining > 0 AND (expires_at IS NULL OR expires_at > now()))::int AS members,
            COALESCE(sum(points) FILTER (WHERE kind = 'earn' AND created_at >= date_trunc('month', now())), 0)::bigint AS earned_month,
            COALESCE(-sum(points) FILTER (WHERE kind = 'redeem' AND created_at >= date_trunc('month', now())), 0)::bigint AS redeemed_month,
            COALESCE(-sum(value_idr) FILTER (WHERE kind = 'redeem' AND created_at >= date_trunc('month', now())), 0)::bigint AS discount_month,
            COALESCE(-sum(points) FILTER (WHERE kind = 'expire' AND created_at >= date_trunc('month', now())), 0)::bigint AS expired_month
       FROM loyalty_entry WHERE org_id = $1`,
    [orgId],
  );
  const outstanding = Number(o?.outstanding ?? 0);
  return {
    program: p,
    outstandingPoints: outstanding, liabilityIdr: outstanding * p.pointValueIdr, members: o?.members ?? 0,
    thisMonth: { earned: Number(o?.earned_month ?? 0), redeemed: Number(o?.redeemed_month ?? 0), discountIdr: Number(o?.discount_month ?? 0), expired: Number(o?.expired_month ?? 0) },
  };
}

const maskPhone = (ph: string | null) => (ph ? `${ph.slice(0, 6)}••••${ph.slice(-3)}` : '—');

/** Drivers with the most points (phone numbers masked). */
export async function topMembers(orgId: string, limit = 25) {
  const rows = await many<any>(
    `SELECT e.app_driver_id, d.phone, d.name, sum(e.remaining)::int AS balance, max(e.created_at) AS last_activity,
            COALESCE(m.auto_redeem, false) AS auto_redeem
       FROM loyalty_entry e JOIN app_driver d ON d.id = e.app_driver_id
       LEFT JOIN loyalty_member m ON m.org_id = e.org_id AND m.app_driver_id = e.app_driver_id
      WHERE e.org_id = $1 AND e.remaining > 0 AND (e.expires_at IS NULL OR e.expires_at > now())
      GROUP BY e.app_driver_id, d.phone, d.name, m.auto_redeem
      ORDER BY balance DESC LIMIT $2`,
    [orgId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({ appDriverId: r.app_driver_id, phone: maskPhone(r.phone), name: r.name, balance: r.balance, autoRedeem: r.auto_redeem, lastActivity: r.last_activity }));
}

/** A goodwill (or corrective) change to a driver's points by the operator. */
export async function adjustPoints(orgId: string, appDriverId: string, points: unknown, note: unknown, actor: string) {
  if (!UUID_RE.test(String(appDriverId))) throw new LoyaltyError(404, 'driver not found');
  const n = Number(points);
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 1_000_000) throw new LoyaltyError(422, 'Points are a whole number, not 0 (negative takes points away).');
  const why = String(note ?? '').trim().slice(0, 200);
  if (why.length < 3) throw new LoyaltyError(422, 'Say why (it shows in the driver\'s history).');
  const d = await one(`SELECT id FROM app_driver WHERE id = $1`, [appDriverId]);
  if (!d) throw new LoyaltyError(404, 'driver not found');
  const p = await getProgram(orgId);
  return tx(async () => {
    await lockDriver(orgId, appDriverId);
    if (n > 0) {
      await query(
        `INSERT INTO loyalty_entry (org_id, app_driver_id, kind, points, remaining, note, created_by, expires_at)
         VALUES ($1,$2,'adjust',$3,$3,$4,$5, now() + make_interval(months => $6::int))`,
        [orgId, appDriverId, n, why, actor, p.expiryMonths]);
    } else {
      const bal = await balanceOf(orgId, appDriverId);
      if (bal < -n) throw new LoyaltyError(409, `The driver has only ${bal} points.`);
      await consume(orgId, appDriverId, -n);
      await query(`INSERT INTO loyalty_entry (org_id, app_driver_id, kind, points, note, created_by) VALUES ($1,$2,'adjust',$3,$4,$5)`, [orgId, appDriverId, n, why, actor]);
    }
    return { balance: await balanceOf(orgId, appDriverId) };
  });
}

// ─────────────────────────────────────────── ledger

const lockDriver = (orgId: string, appDriverId: string) =>
  query(`SELECT pg_advisory_xact_lock(hashtextextended('loyalty:' || $1::text || ':' || $2::text, 0))`, [orgId, appDriverId]);

export async function balanceOf(orgId: string, appDriverId: string): Promise<number> {
  const r = await one<{ b: number }>(
    `SELECT COALESCE(sum(remaining), 0)::int AS b FROM loyalty_entry
      WHERE org_id = $1 AND app_driver_id = $2 AND remaining > 0 AND (expires_at IS NULL OR expires_at > now())`,
    [orgId, appDriverId]);
  return r?.b ?? 0;
}

/** Take points from the oldest earnings first. The caller holds the driver's lock. */
async function consume(orgId: string, appDriverId: string, points: number) {
  let left = points;
  const open = await many<{ id: string; remaining: number }>(
    `SELECT id, remaining FROM loyalty_entry WHERE org_id = $1 AND app_driver_id = $2 AND remaining > 0 AND (expires_at IS NULL OR expires_at > now())
      ORDER BY expires_at NULLS LAST, created_at FOR UPDATE`,
    [orgId, appDriverId]);
  for (const e of open) {
    if (left <= 0) break;
    const take = Math.min(left, e.remaining);
    await query(`UPDATE loyalty_entry SET remaining = remaining - $2 WHERE id = $1`, [e.id, take]);
    left -= take;
  }
  if (left > 0) throw new LoyaltyError(409, 'not enough points');
}

// ─────────────────────────────────────────── rating

/**
 * The points a session may spend: the program is on, the driver chose to use
 * their points, and has some. Null otherwise (nothing to do).
 */
export async function redemptionFor(orgId: string, appDriverId: string | null | undefined): Promise<{ program: LoyaltyProgram; balance: number } | null> {
  if (!appDriverId) return null;
  const program = await getProgram(orgId);
  if (!program.enabled) return null;
  const m = await one<{ auto_redeem: boolean }>(`SELECT auto_redeem FROM loyalty_member WHERE org_id = $1 AND app_driver_id = $2`, [orgId, appDriverId]);
  if (!m?.auto_redeem) return null;
  const balance = await balanceOf(orgId, appDriverId);
  return balance > 0 ? { program, balance } : null;
}

/** The price adjustment for points worth `amountIdr` (taken off the energy, then the fees). */
export const pointsAdjustment = (points: number, amountIdr: number): PriceAdjustment =>
  ({ source: 'loyalty', id: 'loyalty', name: `${points.toLocaleString('id-ID')} points`, amountOffIdr: amountIdr });

/**
 * After a CDR: spend the points the session used (oldest first) and credit the points
 * it earned on its total. Idempotent per session.
 */
export async function recordLoyalty(orgId: string, sessionId: string, appDriverId: string | null | undefined, totalIdr: number, spent: { points: number; amountIdr: number } | null) {
  if (!appDriverId) return;
  const program = await getProgram(orgId);
  if (!program.enabled && !spent) return;
  await tx(async () => {
    await lockDriver(orgId, appDriverId);
    if (spent && spent.points > 0) {
      const done = await one(`SELECT 1 FROM loyalty_entry WHERE session_id = $1 AND kind = 'redeem'`, [sessionId]);
      if (!done) {
        await consume(orgId, appDriverId, spent.points);
        await query(
          `INSERT INTO loyalty_entry (org_id, app_driver_id, kind, points, value_idr, session_id, note) VALUES ($1,$2,'redeem',$3,$4,$5,'Charging session')`,
          [orgId, appDriverId, -spent.points, -spent.amountIdr, sessionId]);
      }
    }
    const earned = program.enabled ? pointsEarned(totalIdr, program) : 0;
    if (earned > 0) {
      await query(
        `INSERT INTO loyalty_entry (org_id, app_driver_id, kind, points, remaining, session_id, note, expires_at)
         VALUES ($1,$2,'earn',$3,$3,$4,'Charging session', now() + make_interval(months => $5::int))
         ON CONFLICT (session_id, kind) WHERE session_id IS NOT NULL DO NOTHING`,
        [orgId, appDriverId, earned, sessionId, program.expiryMonths]);
    }
  });
}

/** Worker: expire what is left of earnings past their date. */
export async function expirePoints(): Promise<number> {
  // What each earning had left is read before it is emptied; one 'expire' entry per driver and operator records it.
  const r = await one<{ n: number }>(
    `WITH due AS (
       SELECT id, org_id, app_driver_id, remaining FROM loyalty_entry
        WHERE remaining > 0 AND expires_at IS NOT NULL AND expires_at <= now()
        FOR UPDATE
     ), emptied AS (
       UPDATE loyalty_entry e SET remaining = 0 FROM due WHERE e.id = due.id
       RETURNING due.org_id, due.app_driver_id, due.remaining
     ), logged AS (
       INSERT INTO loyalty_entry (org_id, app_driver_id, kind, points, note)
       SELECT org_id, app_driver_id, 'expire', -sum(remaining)::int, 'Points expired' FROM emptied GROUP BY org_id, app_driver_id
       RETURNING points
     )
     SELECT COALESCE(-sum(points), 0)::int AS n FROM logged`,
  );
  return r?.n ?? 0;
}

// ─────────────────────────────────────────── driver app

/** A driver's points at every operator with loyalty on (or where they still have points). */
export async function driverLoyalty(appDriverId: string) {
  const orgs = await many<any>(
    `SELECT o.id, o.name, p.enabled, p.earn_per_1000_idr, p.point_value_idr, p.max_redeem_bps, p.expiry_months, COALESCE(m.auto_redeem, false) AS auto_redeem
       FROM organisation o LEFT JOIN loyalty_program p ON p.org_id = o.id
       LEFT JOIN loyalty_member m ON m.org_id = o.id AND m.app_driver_id = $1
      WHERE o.sandbox_of_org_id IS NULL AND o.archived_at IS NULL
        AND (p.enabled OR EXISTS (SELECT 1 FROM loyalty_entry e WHERE e.org_id = o.id AND e.app_driver_id = $1 AND e.remaining > 0))
      ORDER BY o.name`,
    [appDriverId],
  );
  const out = [];
  for (const o of orgs) {
    const balance = await balanceOf(o.id, appDriverId);
    const soon = await one<{ pts: number; at: Date | null }>(
      `SELECT COALESCE(sum(remaining), 0)::int AS pts, min(expires_at) AS at FROM loyalty_entry
        WHERE org_id = $1 AND app_driver_id = $2 AND remaining > 0 AND expires_at > now() AND expires_at <= now() + interval '30 days'`,
      [o.id, appDriverId]);
    const history = await many<any>(
      `SELECT kind, points, value_idr, note, created_at, session_id FROM loyalty_entry WHERE org_id = $1 AND app_driver_id = $2 ORDER BY created_at DESC LIMIT 10`,
      [o.id, appDriverId]);
    out.push({
      orgId: o.id, operator: o.name, enabled: !!o.enabled,
      earnPer1000Idr: o.earn_per_1000_idr ?? 0, pointValueIdr: o.point_value_idr ?? 0, maxRedeemPercent: (o.max_redeem_bps ?? 0) / 100, expiryMonths: o.expiry_months ?? 12,
      balance, valueIdr: balance * (o.point_value_idr ?? 0), autoRedeem: o.auto_redeem,
      expiringSoon: soon?.pts ? { points: soon.pts, at: soon.at } : null,
      history: history.map((h) => ({ kind: h.kind, points: h.points, valueIdr: -Number(h.value_idr), note: h.note, at: h.created_at, sessionId: h.session_id })),
    });
  }
  return { operators: out };
}

export async function setAutoRedeem(appDriverId: string, orgId: string, on: boolean) {
  if (!UUID_RE.test(String(orgId))) throw new LoyaltyError(404, 'Operator tidak ditemukan.');
  const p = await getProgram(orgId);
  if (on && !p.enabled) throw new LoyaltyError(409, 'Poin tidak aktif di operator ini.');
  await query(
    `INSERT INTO loyalty_member (org_id, app_driver_id, auto_redeem, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (org_id, app_driver_id) DO UPDATE SET auto_redeem = $3, updated_at = now()`,
    [orgId, appDriverId, on]);
  return { ok: true, autoRedeem: on };
}
