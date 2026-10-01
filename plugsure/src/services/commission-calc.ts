/**
 * Platform commission and fee statement — the arithmetic.
 *
 * Implements the published commercial model (plugsure.com/pricing):
 *
 *   PUBLIC sites (drivers pay)
 *     base        = session subtotal: energy + service + admin + idle fees,
 *                   EXCLUDING PBJT-TL and PPN (taxes collected for the state)
 *     tier        = by the SITE's gross transaction value for the month
 *                   Standard up to Rp 150M → 8%, Volume over 150M up to 500M → 6.5%,
 *                   Network over Rp 500M → 5%
 *                   A tier's upper bound belongs to it (≤): exactly Rp 500M is
 *                   Volume, as the published band "Volume Rp 150–500M" reads, and
 *                   exactly Rp 150M is Standard (the commission on it is Rp 12M
 *                   either way, see 'whole' below).
 *                   'whole'    the whole month at the tier reached (default), with
 *                              no cliff: never less than the most the lower
 *                              tiers charge (their upper bound at their rate)
 *                   'marginal' each band at its own rate, like tax brackets
 *     minimum     = per charger per month (AC Rp 150,000, DC Rp 350,000), credited against that
 *                   charger's commission: only a quiet charger pays the top-up
 *   PRIVATE sites (no driver payment)
 *     fee         = flat per charger per month: AC Rp 250,000, DC Rp 450,000
 *   Both minimum and flat fee are pro-rated by the days a charger was in service.
 *   Payment processing (QRIS MDR) is covered by the commission by default, so
 *   the estimated MDR is credited back; plans can move it to the site owner.
 *   PPN is added to the platform's fee (DPP nilai lain 11/12 × 12%).
 *
 * No I/O: the database loader lives in commission.ts. Unit-tested in
 * commission-calc.test.ts.
 */

export interface Tier { name: string; upToIdr: number | null; rateBps: number }

export interface Plan {
  tiers: Tier[];
  tierMode: 'whole' | 'marginal';
  minPerChargerAcIdr: number;
  minPerChargerDcIdr: number;
  privateFeeAcIdr: number;
  privateFeeDcIdr: number;
  /** Who bears the payment gateway's MDR: the platform (credited back, per the pricing page) or the site owner. */
  mdrBorneBy: 'platform' | 'site_owner';
  prorate: boolean;
}

export const DEFAULT_PLAN: Plan = {
  tiers: [
    { name: 'Standard', upToIdr: 150_000_000, rateBps: 800 },
    { name: 'Volume', upToIdr: 500_000_000, rateBps: 650 },
    { name: 'Network', upToIdr: null, rateBps: 500 },
  ],
  tierMode: 'whole',
  // AC is lower: at Rp 350,000 almost every public AC charger paid the minimum
  // (commission only passes it above ~37% utilisation on 7 kW).
  minPerChargerAcIdr: 150_000,
  minPerChargerDcIdr: 350_000,
  privateFeeAcIdr: 250_000,
  privateFeeDcIdr: 450_000,
  mdrBorneBy: 'platform',
  prorate: true,
};

const money = (v: unknown) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1e13;

/** Validate a plan coming from the platform console. Returns the clean plan or an error. */
export function normalisePlan(raw: any): { plan: Plan } | { error: string } {
  const p = { ...DEFAULT_PLAN, ...(raw ?? {}) };
  if (!Array.isArray(p.tiers) || p.tiers.length < 1 || p.tiers.length > 10) return { error: 'Give between 1 and 10 tiers.' };
  const tiers: Tier[] = [];
  let prev = 0;
  for (const [i, t] of p.tiers.entries()) {
    const last = i === p.tiers.length - 1;
    const upTo = t?.upToIdr === null || t?.upToIdr === undefined || t?.upToIdr === '' ? null : Number(t.upToIdr);
    if (!last && (upTo === null || !money(upTo) || upTo <= prev)) return { error: 'Each tier but the last needs an upper bound above the previous one.' };
    if (last && upTo !== null) return { error: 'The last tier has no upper bound.' };
    const rate = Number(t?.rateBps);
    if (!Number.isInteger(rate) || rate < 0 || rate > 5000) return { error: 'Commission rates are 0–50% (in basis points, 800 = 8%).' };
    tiers.push({ name: String(t?.name ?? `Tier ${i + 1}`).slice(0, 40) || `Tier ${i + 1}`, upToIdr: upTo, rateBps: rate });
    if (upTo !== null) prev = upTo;
  }
  if (!['whole', 'marginal'].includes(p.tierMode)) return { error: 'Tier mode is whole or marginal.' };
  if (!['platform', 'site_owner'].includes(p.mdrBorneBy)) return { error: 'MDR is borne by the platform or the site owner.' };
  for (const k of ['minPerChargerAcIdr', 'minPerChargerDcIdr', 'privateFeeAcIdr', 'privateFeeDcIdr'] as const) {
    if (!money(p[k])) return { error: `${k} must be a rupiah amount.` };
  }
  return {
    plan: {
      tiers, tierMode: p.tierMode, mdrBorneBy: p.mdrBorneBy, prorate: p.prorate !== false,
      minPerChargerAcIdr: Math.round(Number(p.minPerChargerAcIdr)), minPerChargerDcIdr: Math.round(Number(p.minPerChargerDcIdr)),
      privateFeeAcIdr: Math.round(Number(p.privateFeeAcIdr)), privateFeeDcIdr: Math.round(Number(p.privateFeeDcIdr)),
    },
  };
}

/**
 * The tier a month's gross transaction value falls in. A tier's upper bound is
 * INCLUSIVE: "Volume Rp 150–500M" includes Rp 500,000,000, which used to fall
 * into Network (5%) because the bound was exclusive.
 */
export function tierFor(plan: Plan, gtv: number): Tier {
  return plan.tiers.find((t) => t.upToIdr === null || gtv <= t.upToIdr) ?? plan.tiers[plan.tiers.length - 1]!;
}

/**
 * Commission on a site's month, before rounding to chargers.
 *
 * 'whole' mode charges the whole month at the tier reached, and the rates fall
 * as the tiers rise, so crossing a bound used to LOWER the commission: Rp 12.0M
 * at Rp 150M (8%), then Rp 9.75M at Rp 150M + 1 (6.5%) — a site owner was paid
 * to sell less, and the platform lost Rp 2.25M on the last rupiah. The no-cliff
 * rule (as in marginal relief): the commission is never less than the most a
 * lower tier charges, i.e. each lower tier's upper bound at that tier's rate.
 * So from Rp 150M the commission stays at Rp 12.0M until 6.5% of the month
 * passes it (about Rp 184.6M), and from Rp 500M it stays at Rp 32.5M until 5%
 * passes it (Rp 650M). The commission never falls as the month grows.
 *
 * 'marginal' (each band at its own rate) has no cliff by construction; it is a
 * plan setting, not the default, because it charges more than 'whole' on every
 * month above Rp 150M (a different commercial offer, not a fix).
 */
export function commissionFor(plan: Plan, gtv: number): number {
  if (gtv <= 0) return 0;
  if (plan.tierMode === 'whole') {
    let out = (gtv * tierFor(plan, gtv).rateBps) / 10_000;
    for (const t of plan.tiers) {
      if (t.upToIdr === null || t.upToIdr >= gtv) break;
      out = Math.max(out, (t.upToIdr * t.rateBps) / 10_000);
    }
    return out;
  }
  let rest = gtv, floor = 0, out = 0;
  for (const t of plan.tiers) {
    const band = t.upToIdr === null ? rest : Math.min(rest, t.upToIdr - floor);
    if (band <= 0) break;
    out += (band * t.rateBps) / 10_000;
    rest -= band;
    if (t.upToIdr !== null) floor = t.upToIdr;
    if (rest <= 0) break;
  }
  return out;
}

export interface ChargerInput {
  chargePointId: string;
  ocppIdentity: string;
  displayName: string | null;
  siteId: string;
  kind: 'AC' | 'DC';
  /** Fraction of the month in service (commissioned → decommissioned), 0..1. */
  activeFraction: number;
  sessions: number;
  energyWh: number;
  /** Commission base: CDR subtotals (energy, service, admin, idle), excl. PBJT and PPN. */
  gtvIdr: number;
  pbjtIdr: number;
  ppnIdr: number;
  grossIdr: number;
  mdrIdr: number;
  inReview: number;
}

export interface SiteInput { siteId: string; name: string; model: 'public' | 'private' }

export interface ChargerLine extends ChargerInput {
  activeDays: number;
  commissionIdr: number;
  minimumIdr: number;
  topUpIdr: number;
  privateFeeIdr: number;
  feeIdr: number;
}

export interface SiteLine {
  siteId: string;
  name: string;
  model: 'public' | 'private';
  tier: string | null;
  rateBps: number | null;
  sessions: number;
  energyKwh: number;
  gtvIdr: number;
  pbjtIdr: number;
  ppnIdr: number;
  grossIdr: number;
  commissionIdr: number;
  minimumTopUpIdr: number;
  privateFeeIdr: number;
  feeIdr: number;
  mdrIdr: number;
  /** MDR credited back against this site's fee (platform bears MDR), capped at the fee. */
  mdrCreditIdr: number;
  /** The platform's share: fee less MDR credit, before PPN. */
  platformShareIdr: number;
  /** The owner's share: commission base less the platform's share and the MDR the gateway takes. */
  ownerShareIdr: number;
  warnings: string[];
  chargers: ChargerLine[];
}

export interface Statement {
  period: string;
  daysInMonth: number;
  plan: Plan;
  sites: SiteLine[];
  totals: {
    sessions: number;
    energyKwh: number;
    gtvIdr: number;
    pbjtIdr: number;
    ppnCollectedIdr: number;
    grossCollectedIdr: number;
    commissionIdr: number;
    minimumTopUpIdr: number;
    privateFeeIdr: number;
    feesIdr: number;
    mdrEstimateIdr: number;
    mdrCreditIdr: number;
    netIdr: number;
    dppIdr: number;
    ppnIdr: number;
    totalIdr: number;
    /** PPh 23 (2%) the customer may withhold on the service fee, if it is a withholding agent. */
    pph23Idr: number;
    /** The platform's share before PPN (= netIdr). */
    platformShareIdr: number;
    /** The owner's share: commission base less the platform's share and MDR. */
    ownerShareIdr: number;
  };
  warnings: string[];
}

export interface TaxRates { ppnRateBps: number; dppNum: number; dppDen: number }

const r = Math.round;
const idr = (n: number) => `Rp ${r(n).toLocaleString('id-ID')}`;

export function computeStatement(plan: Plan, period: string, daysInMonth: number, sites: SiteInput[], chargers: ChargerInput[], tax: TaxRates): Statement {
  const out: SiteLine[] = [];
  for (const s of sites) {
    const cs = chargers.filter((c) => c.siteId === s.siteId);
    if (!cs.length) continue;
    const sum = (k: keyof ChargerInput) => cs.reduce((a, c) => a + Number(c[k]), 0);
    const gtv = sum('gtvIdr');
    const warnings: string[] = [];
    let tier: Tier | null = null, siteCommission = 0;
    if (s.model === 'public') {
      tier = tierFor(plan, gtv);
      siteCommission = commissionFor(plan, gtv);
    } else if (gtv > 0) {
      warnings.push(`Private site took ${sum('sessions')} priced sessions (${idr(gtv)} before taxes). Private sites pay a flat fee and no commission — if drivers pay here, it should be public.`);
    }
    const lines: ChargerLine[] = cs.map((c) => {
      const frac = plan.prorate ? Math.min(1, Math.max(0, c.activeFraction)) : c.activeFraction > 0 ? 1 : 0;
      // A charger's share of the site's commission, in proportion to its turnover.
      const commission = s.model === 'public' && gtv > 0 ? r((siteCommission * c.gtvIdr) / gtv) : 0;
      const minimum = s.model === 'public' ? r((c.kind === 'DC' ? plan.minPerChargerDcIdr : plan.minPerChargerAcIdr) * frac) : 0;
      const privateFee = s.model === 'private' ? r((c.kind === 'DC' ? plan.privateFeeDcIdr : plan.privateFeeAcIdr) * frac) : 0;
      const topUp = Math.max(0, minimum - commission);
      return { ...c, activeDays: r(frac * daysInMonth), commissionIdr: commission, minimumIdr: minimum, topUpIdr: topUp, privateFeeIdr: privateFee, feeIdr: commission + topUp + privateFee };
    });
    const lineSum = (k: keyof ChargerLine) => lines.reduce((a, l) => a + Number(l[k]), 0);
    const inReview = sum('inReview');
    if (inReview) warnings.push(`${inReview} session${inReview === 1 ? '' : 's'} awaiting operator review ${inReview === 1 ? 'is' : 'are'} included at the current rating.`);
    const fee = lineSum('feeIdr');
    const mdr = s.model === 'public' ? sum('mdrIdr') : 0;
    // The credit can only reduce what the platform charges, never create a payout.
    const credit = plan.mdrBorneBy === 'platform' ? Math.min(mdr, fee) : 0;
    const platformShare = fee - credit;
    out.push({
      siteId: s.siteId, name: s.name, model: s.model,
      tier: tier?.name ?? null,
      rateBps: s.model === 'public' ? (gtv > 0 ? r((lineSum('commissionIdr') / gtv) * 10_000) : tier!.rateBps) : null,
      sessions: sum('sessions'), energyKwh: Math.round(sum('energyWh') / 10) / 100,
      gtvIdr: gtv, pbjtIdr: sum('pbjtIdr'), ppnIdr: sum('ppnIdr'), grossIdr: sum('grossIdr'),
      commissionIdr: lineSum('commissionIdr'), minimumTopUpIdr: lineSum('topUpIdr'), privateFeeIdr: lineSum('privateFeeIdr'),
      feeIdr: fee, mdrIdr: mdr, mdrCreditIdr: credit, platformShareIdr: platformShare,
      // base = owner + platform + gateway (MDR); negative for a private site that sold nothing.
      ownerShareIdr: gtv - platformShare - mdr,
      warnings, chargers: lines,
    });
  }
  const T = (k: keyof SiteLine) => out.reduce((a, s) => a + Number(s[k]), 0);
  const fees = T('feeIdr');
  const mdrEstimate = T('mdrIdr');
  const mdrCredit = T('mdrCreditIdr');
  const net = fees - mdrCredit;
  const dpp = r((net * tax.dppNum) / tax.dppDen);
  const ppn = r((dpp * tax.ppnRateBps) / 10_000);
  return {
    period, daysInMonth, plan, sites: out,
    totals: {
      sessions: T('sessions'), energyKwh: Math.round(T('energyKwh') * 100) / 100,
      gtvIdr: T('gtvIdr'), pbjtIdr: T('pbjtIdr'), ppnCollectedIdr: T('ppnIdr'), grossCollectedIdr: T('grossIdr'),
      commissionIdr: T('commissionIdr'), minimumTopUpIdr: T('minimumTopUpIdr'), privateFeeIdr: T('privateFeeIdr'),
      feesIdr: fees, mdrEstimateIdr: mdrEstimate, mdrCreditIdr: mdrCredit, netIdr: net, dppIdr: dpp, ppnIdr: ppn, totalIdr: net + ppn,
      pph23Idr: r(net * 0.02),
      platformShareIdr: net,
      ownerShareIdr: T('ownerShareIdr'),
    },
    warnings: out.flatMap((s) => s.warnings.map((w) => `${s.name}: ${w}`)),
  };
}
