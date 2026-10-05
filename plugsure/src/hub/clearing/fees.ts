import { one } from '../../db/pool.js';

/**
 * The hub commission (docs/HUB-DESIGN.md §8.4). TODO(commercial): every rate is a placeholder until the owner
 * sets it — the seeded default plans are 0 % and 0 per session in every currency ([OWNER] 14.1-2).
 *
 * Who pays what is a fee PLAN per currency, with a CPO part and an eMSP part:
 *
 *   fee_cpo  = clamp(round_half_up(excl × cpo_bps / 10 000)  + cpo_fixed,  cpo_min,  cpo_max)
 *   fee_emsp = clamp(round_half_up(excl × emsp_bps / 10 000) + emsp_fixed, emsp_min, emsp_max)
 *
 * on the CDR's total EXCLUDING tax in minor units (the hub's fee is not a share of the tax). Fees are frozen
 * on the CDR when it becomes payable (accepted, or offset by a credit). A credit CDR reverses its original's
 * frozen fees exactly (pro rata for a partial credit): the minimum is not applied twice.
 *
 * Plan precedence for each side: the agreement's plan for that currency (hub_fee_assignment), else that side's
 * member's plan, else the currency's default plan effective at the CDR's start date.
 */

export interface FeePlan {
  id: string;
  name: string;
  currency: string;
  cpo_bps: number;
  cpo_fixed_minor: number | string;
  cpo_min_minor: number | string;
  cpo_max_minor: number | string | null;
  emsp_bps: number;
  emsp_fixed_minor: number | string;
  emsp_min_minor: number | string;
  emsp_max_minor: number | string | null;
  is_default: boolean;
  effective_from: string | Date;
}

export interface SideFee { bps: number; fixedMinor: number; minMinor: number; maxMinor: number | null }

export const sideOf = (p: FeePlan, side: 'cpo' | 'emsp'): SideFee => ({
  bps: Number(p[`${side}_bps`]),
  fixedMinor: Number(p[`${side}_fixed_minor`]),
  minMinor: Number(p[`${side}_min_minor`]),
  maxMinor: p[`${side}_max_minor`] == null ? null : Number(p[`${side}_max_minor`]),
});

/** round(amount × bps / 10 000), half away from zero, in exact integer arithmetic. */
export function bpsOf(amountMinor: number, bps: number): number {
  if (!Number.isInteger(amountMinor) || !Number.isInteger(bps)) throw new Error('bpsOf: integers only');
  const num = BigInt(Math.abs(amountMinor)) * BigInt(bps);
  const q = (num * 2n + 10_000n) / 20_000n; // floor(num / 10000 + 1/2)
  return Number(amountMinor < 0 ? -q : q);
}

/** One side's fee on a (non-negative) excl.-tax amount. */
export function sideFee(exclMinor: number, f: SideFee): number {
  if (exclMinor < 0) throw new Error('sideFee: a credit CDR reverses its original\'s fee (creditFees)');
  let fee = bpsOf(exclMinor, f.bps) + f.fixedMinor;
  if (fee < f.minMinor) fee = f.minMinor;
  if (f.maxMinor != null && fee > f.maxMinor) fee = f.maxMinor;
  return fee;
}

export function computeFees(exclMinor: number, cpo: SideFee, emsp: SideFee): { cpo: number; emsp: number } {
  return { cpo: sideFee(exclMinor, cpo), emsp: sideFee(exclMinor, emsp) };
}

/**
 * A credit CDR's fees: minus the original's frozen fees, pro rata to the credited share of the original
 * (a full credit reverses them exactly; |credit| above the original never reverses more than the original).
 */
export function creditFees(original: { exclMinor: number; feeCpo: number; feeEmsp: number }, creditExclMinor: number): { cpo: number; emsp: number } {
  const orig = Math.abs(original.exclMinor);
  const cred = Math.min(Math.abs(creditExclMinor), orig);
  if (orig === 0 || cred === orig) return { cpo: -original.feeCpo || 0, emsp: -original.feeEmsp || 0 };
  const share = (fee: number) => {
    const q = (BigInt(fee) * BigInt(cred) * 2n + BigInt(orig)) / (BigInt(orig) * 2n);
    return -Number(q) || 0;
  };
  return { cpo: share(original.feeCpo), emsp: share(original.feeEmsp) };
}

const PLAN_COLS = `p.id, p.name, p.currency, p.cpo_bps, p.cpo_fixed_minor, p.cpo_min_minor, p.cpo_max_minor, p.emsp_bps, p.emsp_fixed_minor,
  p.emsp_min_minor, p.emsp_max_minor, p.is_default, to_char(p.effective_from, 'YYYY-MM-DD') AS effective_from`;

/** The plan for one side of a CDR (precedence above); null only when no default plan exists for the currency. */
export async function planFor(side: 'cpo' | 'emsp', c: { agreement_id: string | null; cpo_member_id: string; emsp_member_id: string; currency: string; start_at: Date | string }): Promise<FeePlan | null> {
  if (c.agreement_id) {
    const a = await one<FeePlan>(`SELECT ${PLAN_COLS} FROM hub_fee_assignment f JOIN hub_fee_plan p ON p.id = f.fee_plan_id
                                   WHERE f.agreement_id = $1 AND f.currency = $2 AND p.currency = $2`, [c.agreement_id, c.currency]);
    if (a) return a;
  }
  const memberId = side === 'cpo' ? c.cpo_member_id : c.emsp_member_id;
  const m = await one<FeePlan>(`SELECT ${PLAN_COLS} FROM hub_fee_assignment f JOIN hub_fee_plan p ON p.id = f.fee_plan_id
                                 WHERE f.member_id = $1 AND f.currency = $2 AND p.currency = $2`, [memberId, c.currency]);
  if (m) return m;
  const d = await one<FeePlan>(`SELECT ${PLAN_COLS} FROM hub_fee_plan p
                                 WHERE p.is_default AND p.currency = $1 AND p.effective_from <= ($2::timestamptz)::date
                                 ORDER BY p.effective_from DESC LIMIT 1`, [c.currency, c.start_at]);
  return d ?? one<FeePlan>(`SELECT ${PLAN_COLS} FROM hub_fee_plan p WHERE p.is_default AND p.currency = $1 ORDER BY p.effective_from LIMIT 1`, [c.currency]);
}

/** Fees of a CDR with its plans (both sides). */
export async function feesFor(c: { agreement_id: string | null; cpo_member_id: string; emsp_member_id: string; currency: string; start_at: Date | string; total_excl_minor: number | string }) {
  const cpoPlan = await planFor('cpo', c);
  const emspPlan = await planFor('emsp', c);
  const excl = Number(c.total_excl_minor);
  const zero: SideFee = { bps: 0, fixedMinor: 0, minMinor: 0, maxMinor: null };
  return {
    cpoPlanId: cpoPlan?.id ?? null,
    emspPlanId: emspPlan?.id ?? null,
    cpo: sideFee(Math.max(0, excl), cpoPlan ? sideOf(cpoPlan, 'cpo') : zero),
    emsp: sideFee(Math.max(0, excl), emspPlan ? sideOf(emspPlan, 'emsp') : zero),
  };
}

/** Validate a fee plan body from the API (amounts in minor units of the plan's currency). */
export function feePlanProblem(b: Record<string, unknown>): string | null {
  const ints = ['cpo_fixed_minor', 'cpo_min_minor', 'emsp_fixed_minor', 'emsp_min_minor'];
  for (const k of ['cpo_bps', 'emsp_bps']) {
    if (b[k] != null && (!Number.isInteger(b[k]) || (b[k] as number) < 0 || (b[k] as number) > 5000)) return `${k}: whole basis points, 0 to 5000 (50 %)`;
  }
  for (const k of ints) if (b[k] != null && (!Number.isInteger(b[k]) || (b[k] as number) < 0)) return `${k}: a whole, non-negative amount in minor units`;
  for (const k of ['cpo_max_minor', 'emsp_max_minor']) if (b[k] != null && (!Number.isInteger(b[k]) || (b[k] as number) < 0)) return `${k}: null or a whole amount in minor units`;
  if (b.cpo_max_minor != null && Number(b.cpo_max_minor) < Number(b.cpo_min_minor ?? 0)) return 'cpo_max_minor is below cpo_min_minor';
  if (b.emsp_max_minor != null && Number(b.emsp_max_minor) < Number(b.emsp_min_minor ?? 0)) return 'emsp_max_minor is below emsp_min_minor';
  return null;
}
