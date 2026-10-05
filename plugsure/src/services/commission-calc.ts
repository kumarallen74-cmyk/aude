import { upgradeLegacyKeys, moneyText, LEGACY_CURRENCY, type CurrencyCode } from '../domain/money.js';
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

export interface Tier { name: string; upToMinor: number | null; rateBps: number }

export interface Plan {
  tiers: Tier[];
  tierMode: 'whole' | 'marginal';
  minPerChargerAcMinor: number;
  minPerChargerDcMinor: number;
  privateFeeAcMinor: number;
  privateFeeDcMinor: number;
  /** Who bears the payment gateway's MDR: the platform (credited back, per the pricing page) or the site owner. */
  mdrBorneBy: 'platform' | 'site_owner';
  prorate: boolean;
}

export const DEFAULT_PLAN: Plan = {
  tiers: [
    { name: 'Standard', upToMinor: 150_000_000, rateBps: 800 },
    { name: 'Volume', upToMinor: 500_000_000, rateBps: 650 },
    { name: 'Network', upToMinor: null, rateBps: 500 },
  ],
  tierMode: 'whole',
  // AC is lower: at Rp 350,000 almost every public AC charger paid the minimum
  // (commission only passes it above ~37% utilisation on 7 kW).
  minPerChargerAcMinor: 150_000,
  minPerChargerDcMinor: 350_000,
  privateFeeAcMinor: 250_000,
  privateFeeDcMinor: 450_000,
  mdrBorneBy: 'platform',
  prorate: true,
};

/**
 * The published plan per currency (§D9). Tier bounds, minimums and private-site fees are
 * amounts in the currency's minor units (sen / cents). The MYR and SGD figures are
 * PLACEHOLDERS scaled from the rupiah plan: TODO(commercial) — the ringgit and
 * Singapore-dollar prices are a commercial decision, not set here.
 */
export const DEFAULT_PLANS: Readonly<Record<CurrencyCode, Plan>> = Object.freeze({
  IDR: DEFAULT_PLAN,
  // TODO(commercial): placeholder ringgit plan (≈ Rp 3,500 per RM).
  MYR: {
    ...DEFAULT_PLAN,
    tiers: [
      { name: 'Standard', upToMinor: 4_300_000, rateBps: 800 },
      { name: 'Volume', upToMinor: 14_300_000, rateBps: 650 },
      { name: 'Network', upToMinor: null, rateBps: 500 },
    ],
    minPerChargerAcMinor: 4_300, minPerChargerDcMinor: 10_000, privateFeeAcMinor: 7_100, privateFeeDcMinor: 12_900,
  },
  // TODO(commercial): placeholder Singapore-dollar plan (≈ Rp 12,000 per S$).
  SGD: {
    ...DEFAULT_PLAN,
    tiers: [
      { name: 'Standard', upToMinor: 1_250_000, rateBps: 800 },
      { name: 'Volume', upToMinor: 4_200_000, rateBps: 650 },
      { name: 'Network', upToMinor: null, rateBps: 500 },
    ],
    minPerChargerAcMinor: 1_250, minPerChargerDcMinor: 2_900, privateFeeAcMinor: 2_100, privateFeeDcMinor: 3_750,
  },
});

const money = (v: unknown) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1e13;

/** Validate a plan coming from the platform console. Returns the clean plan or an error. */
export function normalisePlan(raw: any, currency: CurrencyCode = LEGACY_CURRENCY): { plan: Plan } | { error: string } {
  // A plan frozen before 1.7 (or a legacy API body) names its amounts *Idr.
  const p = { ...DEFAULT_PLANS[currency], ...upgradeLegacyKeys(raw ?? {}) };
  if (!Array.isArray(p.tiers) || p.tiers.length < 1 || p.tiers.length > 10) return { error: 'Give between 1 and 10 tiers.' };
  const tiers: Tier[] = [];
  let prev = 0;
  for (const [i, t] of p.tiers.entries()) {
    const last = i === p.tiers.length - 1;
    const upTo = t?.upToMinor === null || t?.upToMinor === undefined || t?.upToMinor === '' ? null : Number(t.upToMinor);
    if (!last && (upTo === null || !money(upTo) || upTo <= prev)) return { error: 'Each tier but the last needs an upper bound above the previous one.' };
    if (last && upTo !== null) return { error: 'The last tier has no upper bound.' };
    const rate = Number(t?.rateBps);
    if (!Number.isInteger(rate) || rate < 0 || rate > 5000) return { error: 'Commission rates are 0–50% (in basis points, 800 = 8%).' };
    tiers.push({ name: String(t?.name ?? `Tier ${i + 1}`).slice(0, 40) || `Tier ${i + 1}`, upToMinor: upTo, rateBps: rate });
    if (upTo !== null) prev = upTo;
  }
  if (!['whole', 'marginal'].includes(p.tierMode)) return { error: 'Tier mode is whole or marginal.' };
  if (!['platform', 'site_owner'].includes(p.mdrBorneBy)) return { error: 'MDR is borne by the platform or the site owner.' };
  for (const k of ['minPerChargerAcMinor', 'minPerChargerDcMinor', 'privateFeeAcMinor', 'privateFeeDcMinor'] as const) {
    if (!money(p[k])) return { error: currency === LEGACY_CURRENCY ? `${k} must be a rupiah amount.` : `${k} must be an amount in ${currency} minor units.` };
  }
  return {
    plan: {
      tiers, tierMode: p.tierMode, mdrBorneBy: p.mdrBorneBy, prorate: p.prorate !== false,
      minPerChargerAcMinor: Math.round(Number(p.minPerChargerAcMinor)), minPerChargerDcMinor: Math.round(Number(p.minPerChargerDcMinor)),
      privateFeeAcMinor: Math.round(Number(p.privateFeeAcMinor)), privateFeeDcMinor: Math.round(Number(p.privateFeeDcMinor)),
    },
  };
}

/**
 * The tier a month's gross transaction value falls in. A tier's upper bound is
 * INCLUSIVE: "Volume Rp 150–500M" includes Rp 500,000,000, which used to fall
 * into Network (5%) because the bound was exclusive.
 */
export function tierFor(plan: Plan, gtv: number): Tier {
  return plan.tiers.find((t) => t.upToMinor === null || gtv <= t.upToMinor) ?? plan.tiers[plan.tiers.length - 1]!;
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
      if (t.upToMinor === null || t.upToMinor >= gtv) break;
      out = Math.max(out, (t.upToMinor * t.rateBps) / 10_000);
    }
    return out;
  }
  let rest = gtv, floor = 0, out = 0;
  for (const t of plan.tiers) {
    const band = t.upToMinor === null ? rest : Math.min(rest, t.upToMinor - floor);
    if (band <= 0) break;
    out += (band * t.rateBps) / 10_000;
    rest -= band;
    if (t.upToMinor !== null) floor = t.upToMinor;
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
  gtvMinor: number;
  localTaxMinor: number;
  taxMinor: number;
  grossMinor: number;
  mdrMinor: number;
  inReview: number;
}

export interface SiteInput { siteId: string; name: string; model: 'public' | 'private' }

export interface ChargerLine extends ChargerInput {
  activeDays: number;
  commissionMinor: number;
  minimumMinor: number;
  topUpMinor: number;
  privateFeeMinor: number;
  feeMinor: number;
}

export interface SiteLine {
  siteId: string;
  name: string;
  model: 'public' | 'private';
  tier: string | null;
  rateBps: number | null;
  sessions: number;
  energyKwh: number;
  gtvMinor: number;
  localTaxMinor: number;
  taxMinor: number;
  grossMinor: number;
  commissionMinor: number;
  minimumTopUpMinor: number;
  privateFeeMinor: number;
  feeMinor: number;
  mdrMinor: number;
  /** MDR credited back against this site's fee (platform bears MDR), capped at the fee. */
  mdrCreditMinor: number;
  /** The platform's share: fee less MDR credit, before PPN. */
  platformShareMinor: number;
  /** The owner's share: commission base less the platform's share and the MDR the gateway takes. */
  ownerShareMinor: number;
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
    gtvMinor: number;
    localTaxMinor: number;
    ppnCollectedMinor: number;
    grossCollectedMinor: number;
    commissionMinor: number;
    minimumTopUpMinor: number;
    privateFeeMinor: number;
    feesMinor: number;
    mdrEstimateMinor: number;
    mdrCreditMinor: number;
    netMinor: number;
    taxBaseMinor: number;
    taxMinor: number;
    totalMinor: number;
    /** PPh 23 (2%) the customer may withhold on the service fee, if it is a withholding agent. */
    pph23Minor: number;
    /** The platform's share before PPN (= netMinor). */
    platformShareMinor: number;
    /** The owner's share: commission base less the platform's share and MDR. */
    ownerShareMinor: number;
  };
  warnings: string[];
  /** Every amount is in this currency (one statement per organisation, owner, month and currency). */
  currency: CurrencyCode;
  /** Why no tax is on the fee (MY/SG until the platform's tax on its fee is settled, V6); null = taxed. */
  taxNote: string | null;
}

export interface TaxRates { ppnRateBps: number; dppNum: number; dppDen: number }

const r = Math.round;

/**
 * `tax` null: the platform's fee is issued WITHOUT tax, and the statement says so (MY/SG:
 * which PlugSure entity bills, and the tax on that cross-border service, is open — V6).
 */
export function computeStatement(plan: Plan, period: string, daysInMonth: number, sites: SiteInput[], chargers: ChargerInput[], tax: TaxRates | null, currency: CurrencyCode = LEGACY_CURRENCY): Statement {
  const idr = (n: number) => moneyText(r(n), currency, 'id');
  const out: SiteLine[] = [];
  for (const s of sites) {
    const cs = chargers.filter((c) => c.siteId === s.siteId);
    if (!cs.length) continue;
    const sum = (k: keyof ChargerInput) => cs.reduce((a, c) => a + Number(c[k]), 0);
    const gtv = sum('gtvMinor');
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
      const commission = s.model === 'public' && gtv > 0 ? r((siteCommission * c.gtvMinor) / gtv) : 0;
      const minimum = s.model === 'public' ? r((c.kind === 'DC' ? plan.minPerChargerDcMinor : plan.minPerChargerAcMinor) * frac) : 0;
      const privateFee = s.model === 'private' ? r((c.kind === 'DC' ? plan.privateFeeDcMinor : plan.privateFeeAcMinor) * frac) : 0;
      const topUp = Math.max(0, minimum - commission);
      return { ...c, activeDays: r(frac * daysInMonth), commissionMinor: commission, minimumMinor: minimum, topUpMinor: topUp, privateFeeMinor: privateFee, feeMinor: commission + topUp + privateFee };
    });
    const lineSum = (k: keyof ChargerLine) => lines.reduce((a, l) => a + Number(l[k]), 0);
    const inReview = sum('inReview');
    if (inReview) warnings.push(`${inReview} session${inReview === 1 ? '' : 's'} awaiting operator review ${inReview === 1 ? 'is' : 'are'} included at the current rating.`);
    const fee = lineSum('feeMinor');
    const mdr = s.model === 'public' ? sum('mdrMinor') : 0;
    // The credit can only reduce what the platform charges, never create a payout.
    const credit = plan.mdrBorneBy === 'platform' ? Math.min(mdr, fee) : 0;
    const platformShare = fee - credit;
    out.push({
      siteId: s.siteId, name: s.name, model: s.model,
      tier: tier?.name ?? null,
      rateBps: s.model === 'public' ? (gtv > 0 ? r((lineSum('commissionMinor') / gtv) * 10_000) : tier!.rateBps) : null,
      sessions: sum('sessions'), energyKwh: Math.round(sum('energyWh') / 10) / 100,
      gtvMinor: gtv, localTaxMinor: sum('localTaxMinor'), taxMinor: sum('taxMinor'), grossMinor: sum('grossMinor'),
      commissionMinor: lineSum('commissionMinor'), minimumTopUpMinor: lineSum('topUpMinor'), privateFeeMinor: lineSum('privateFeeMinor'),
      feeMinor: fee, mdrMinor: mdr, mdrCreditMinor: credit, platformShareMinor: platformShare,
      // base = owner + platform + gateway (MDR); negative for a private site that sold nothing.
      ownerShareMinor: gtv - platformShare - mdr,
      warnings, chargers: lines,
    });
  }
  const T = (k: keyof SiteLine) => out.reduce((a, s) => a + Number(s[k]), 0);
  const fees = T('feeMinor');
  const mdrEstimate = T('mdrMinor');
  const mdrCredit = T('mdrCreditMinor');
  const net = fees - mdrCredit;
  const dpp = tax ? r((net * tax.dppNum) / tax.dppDen) : 0;
  const ppn = tax ? r((dpp * tax.ppnRateBps) / 10_000) : 0;
  return {
    period, daysInMonth, plan, sites: out,
    totals: {
      sessions: T('sessions'), energyKwh: Math.round(T('energyKwh') * 100) / 100,
      gtvMinor: T('gtvMinor'), localTaxMinor: T('localTaxMinor'), ppnCollectedMinor: T('taxMinor'), grossCollectedMinor: T('grossMinor'),
      commissionMinor: T('commissionMinor'), minimumTopUpMinor: T('minimumTopUpMinor'), privateFeeMinor: T('privateFeeMinor'),
      feesMinor: fees, mdrEstimateMinor: mdrEstimate, mdrCreditMinor: mdrCredit, netMinor: net, taxBaseMinor: dpp, taxMinor: ppn, totalMinor: net + ppn,
      // PPh 23 is Indonesian withholding.
      pph23Minor: currency === LEGACY_CURRENCY ? r(net * 0.02) : 0,
      platformShareMinor: net,
      ownerShareMinor: T('ownerShareMinor'),
    },
    warnings: out.flatMap((s) => s.warnings.map((w) => `${s.name}: ${w}`)),
    currency,
    taxNote: tax ? null : 'Issued without tax: the tax on the platform fee for operators outside Indonesia is not settled yet (to be confirmed).',
  };
}
