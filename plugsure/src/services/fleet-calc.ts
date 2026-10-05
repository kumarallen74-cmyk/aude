/**
 * Fleet invoice arithmetic, with no database: one fleet account's month.
 *
 * Own network: every session's charge record already carries its subtotal
 * (energy and fees), PBJT-TL and PPN. On a B2B tax invoice PPN is stated per
 * invoice line, not per session, so for each site the invoice:
 *   - adds up the harga jual subject to PPN (the session prices),
 *   - takes DPP nilai lain = 11/12 of that sum, and
 *   - PPN = 12% of the DPP.
 * That is exactly what the e-Faktur line carries (TaxBase, OtherTaxBase, VAT),
 * so the invoice and the faktur pajak agree to the rupiah. The per-session
 * receipts round each session separately; the (small) difference is shown.
 *
 * Partner networks: the charge records other operators sent for the fleet's
 * cards are re-billed at cost, as a separate section. They are not on the
 * operator's faktur pajak: the partner operator is the seller of that energy.
 */

import { LEGACY_CURRENCY, toMinor, type CurrencyCode } from '../domain/money.js';

export interface TaxCfg {
  ppnRateBps: number;
  dppNum: number;
  dppDen: number;
}

export interface FleetSession {
  id: string;
  startedAt: string;
  endedAt: string | null;
  siteId: string;
  siteName: string;
  ocppIdentity: string;
  cardUid: string;
  holder: string | null;
  energyWh: number;
  subtotalMinor: number;
  localTaxMinor: number;
  taxBaseMinor: number;
  ppnRateBps: number;
  taxMinor: number;
  totalMinor: number;
}

export interface FleetRoaming {
  id: string;
  operator: string;
  location: string | null;
  cardUid: string;
  startedAt: string;
  endedAt: string;
  energyKwh: number;
  exclVat: number;
  inclVat: number | null;
  currency: string;
}

/**
 * A fee on the fleet invoice: a membership fee for the month (a plan billed on the
 * invoice), or — kind 'reservation' — the fee for one connector reservation made with
 * a fleet card in the driver app (planName = the site, subscriber = the card).
 */
export interface FeeLine {
  kind?: 'membership' | 'reservation';
  /** kind 'reservation': the reservation, and when the connector was held. */
  reservationId?: string;
  subscriptionId: string;
  planName: string;
  subscriber: string;
  feeMinor: number;
  /** Price subject to PPN: the fee, or 0 when the seller is not PKP. */
  taxableMinor: number;
  taxBaseMinor: number;
  taxMinor: number;
  totalMinor: number;
  periodStart: string;
  periodEnd: string;
  /** Part of a month: the days in force, of the days in the month (the fee is prorated). */
  monthlyFeeMinor?: number;
  days?: number;
  daysInPeriod?: number;
}

export interface SiteLine {
  siteId: string;
  siteName: string;
  sessions: number;
  energyWh: number;
  subtotalMinor: number;
  localTaxMinor: number;
  /** Harga jual subject to PPN (the e-Faktur TaxBase). 0 when the sessions carry no PPN. */
  taxableMinor: number;
  taxBaseMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** Sessions here without PPN (a tariff with PPN off). */
  untaxedSessions: number;
}

export interface FleetStatementCalc {
  sites: SiteLine[];
  cards: Array<{ uid: string; holder: string | null; sessions: number; energyWh: number; totalMinor: number; roamingMinor: number }>;
  sessions: Array<FleetSession & { taxableMinor: number }>;
  roaming: Array<FleetRoaming & { amountMinor: number; /** The partner sent no total incl. VAT: billed excl. VAT. */ vatMissing?: boolean }>;
  fees: FeeLine[];
  totals: {
    sessions: number;
    energyWh: number;
    subtotalMinor: number;
    localTaxMinor: number;
    taxableMinor: number;
    taxBaseMinor: number;
    taxMinor: number;
    ownTotalMinor: number;
    roamingSessions: number;
    roamingMinor: number;
    /** Membership fees, including their PPN. */
    feesMinor: number;
    totalMinor: number;
    /** Sum of the per-session receipts, and how far the invoice differs from it (rounding). */
    receiptsTotalMinor: number;
    roundingMinor: number;
  };
  warnings: string[];
  /** Every amount above is in this currency. */
  currency: CurrencyCode;
}

const r = Math.round;

export const dppOf = (taxBase: number, cfg: TaxCfg) => r((taxBase * cfg.dppNum) / cfg.dppDen);
export const ppnOf = (dpp: number, cfg: TaxCfg) => r((dpp * cfg.ppnRateBps) / 10_000);

/**
 * The price a session's PPN was levied on. The charge record keeps the DPP, not
 * the price, and whether PBJT-TL sat inside the PPN base is a setting that may
 * have changed since; so try both and keep the one that reproduces the DPP.
 */
export function taxBaseOf(s: Pick<FleetSession, 'subtotalMinor' | 'localTaxMinor' | 'taxBaseMinor' | 'ppnRateBps'>, cfg: TaxCfg): { base: number; exact: boolean } {
  if (!s.ppnRateBps || !s.taxBaseMinor) return { base: 0, exact: true };
  for (const base of [s.subtotalMinor + s.localTaxMinor, s.subtotalMinor]) {
    if (dppOf(base, cfg) === s.taxBaseMinor) return { base, exact: true };
  }
  return { base: r((s.taxBaseMinor * cfg.dppDen) / cfg.dppNum), exact: false };
}

/**
 * Tax on an invoice in a currency other than rupiah (docs/MULTI-COUNTRY-DESIGN.md §D3): the
 * engine's invoiceTotals on the sum of the taxed lines (SG GST 9 %, MY service tax when
 * registered), one rounding per invoice line. Absent = the Indonesian PPN/DPP arithmetic above.
 */
export type InvoiceTax = (taxableMinor: number, taxedGrossMinor: number) => { taxBaseMinor: number; taxMinor: number };

/**
 * Outside Indonesia (review fix 8): the tax of an invoice line is EXTRACTED from the sum of what the driver receipts
 * charged for the taxed sessions (their gross, GST/SST included): tax = round(gross × rate / (10000 + rate)), base =
 * gross − tax. The line total is then exactly the receipts' total, so the fleet is never charged more than the
 * prices it was shown (taxing the summed net again, as before, could add a cent per line), and the tax is one rounding
 * per line on the same base the receipts used. Exclusive tariffs are handled the same way (their receipts' gross already
 * includes the tax).
 */
export const extractInclusiveTax = (rateBps: number): InvoiceTax => (_taxable, gross) => {
  const tax = rateBps > 0 ? Math.round((gross * rateBps) / (10_000 + rateBps)) : 0;
  return { taxBaseMinor: gross - tax, taxMinor: tax };
};

export function computeFleetStatement(sessionsIn: FleetSession[], roamingIn: FleetRoaming[], opts: {
  includeRoaming: boolean; cfg: TaxCfg; fees?: FeeLine[];
  /** The invoice's currency: only sessions, records and fees in it are on it (absent = IDR, as before). */
  currency?: CurrencyCode;
  invoiceTax?: InvoiceTax;
}): FleetStatementCalc {
  const { cfg } = opts;
  const currency = opts.currency ?? LEGACY_CURRENCY;
  const warnings: string[] = [];
  let inexact = 0;
  const sessions = sessionsIn.map((s) => {
    // Outside Indonesia a session's tax base is its net price (no DPP fraction, no local tax).
    if (opts.invoiceTax) return { ...s, taxableMinor: s.ppnRateBps && s.taxMinor ? s.subtotalMinor : 0 };
    const t = taxBaseOf(s, cfg);
    if (!t.exact) inexact++;
    return { ...s, taxableMinor: t.base };
  });
  if (inexact) warnings.push(`${inexact} session(s): the PPN price was reconstructed from the DPP (the tax settings changed since they were rated).`);

  const bySite = new Map<string, SiteLine>();
  const taxedGross = new Map<string, number>();
  for (const s of sessions) {
    const l = bySite.get(s.siteId) ?? {
      siteId: s.siteId, siteName: s.siteName, sessions: 0, energyWh: 0, subtotalMinor: 0, localTaxMinor: 0,
      taxableMinor: 0, taxBaseMinor: 0, taxMinor: 0, totalMinor: 0, untaxedSessions: 0,
    };
    l.sessions++;
    l.energyWh += s.energyWh;
    l.subtotalMinor += s.subtotalMinor;
    l.localTaxMinor += s.localTaxMinor;
    l.taxableMinor += s.taxableMinor;
    if (!s.ppnRateBps) l.untaxedSessions++;
    if (s.taxableMinor > 0) taxedGross.set(s.siteId, (taxedGross.get(s.siteId) ?? 0) + s.totalMinor);
    bySite.set(s.siteId, l);
  }
  const sites = [...bySite.values()].sort((a, b) => a.siteName.localeCompare(b.siteName));
  for (const l of sites) {
    if (opts.invoiceTax) {
      const gross = taxedGross.get(l.siteId) ?? 0;
      const t = opts.invoiceTax(l.taxableMinor, gross);
      l.taxBaseMinor = t.taxBaseMinor;
      l.taxMinor = t.taxMinor;
      // Net of the line = the untaxed sessions' price + the taxed sessions' base, so that subtotal + tax = the receipts.
      l.subtotalMinor = l.subtotalMinor - l.taxableMinor + (gross > 0 ? t.taxBaseMinor : 0);
      l.taxableMinor = gross > 0 ? t.taxBaseMinor : 0;
    } else {
      l.taxBaseMinor = dppOf(l.taxableMinor, cfg);
      l.taxMinor = ppnOf(l.taxBaseMinor, cfg);
    }
    l.totalMinor = l.subtotalMinor + l.localTaxMinor + l.taxMinor;
  }

  const roaming: FleetStatementCalc['roaming'] = [];
  if (opts.includeRoaming) {
    let foreign = 0;
    let noVat = 0;
    for (const x of roamingIn) {
      // Records in another currency go on that currency's invoice (no FX); one PlugSure cannot bill is held, never here.
      if (x.currency !== currency) { foreign++; continue; }
      // A partner that sent no total incl. VAT is billed at its total excl. VAT
      // (as before), but said so: the invoice may be short of the partner's PPN.
      if (x.inclVat == null) noVat++;
      // Partner totals are major units: rupiah as before; sen / cents for ringgit and Singapore dollars.
      const major = x.inclVat ?? x.exclVat;
      roaming.push({ ...x, amountMinor: currency === LEGACY_CURRENCY ? r(major) : toMinor(String(major), currency), ...(x.inclVat == null ? { vatMissing: true } : {}) });
    }
    if (foreign) warnings.push(`${foreign} partner network charge record(s) in another currency are not on this ${currency} statement; they are on the statement in their own currency.`);
    if (noVat) warnings.push(`${noVat} partner network charge record(s) carry no total incl. VAT; they are billed at the partner's total excl. VAT. Check them with the partner.`);
  }

  const cardMap = new Map<string, { uid: string; holder: string | null; sessions: number; energyWh: number; totalMinor: number; roamingMinor: number }>();
  const card = (uid: string, holder: string | null) => {
    const c = cardMap.get(uid) ?? { uid, holder, sessions: 0, energyWh: 0, totalMinor: 0, roamingMinor: 0 };
    if (!c.holder && holder) c.holder = holder;
    cardMap.set(uid, c);
    return c;
  };
  for (const s of sessions) { const c = card(s.cardUid, s.holder); c.sessions++; c.energyWh += s.energyWh; c.totalMinor += s.totalMinor; }
  for (const x of roaming) { const c = card(x.cardUid, null); c.roamingMinor += x.amountMinor; c.energyWh += Math.round(x.energyKwh * 1000); }

  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
  const ownTotalMinor = sum(sites, (l) => l.totalMinor);
  const receiptsTotalMinor = sum(sessions, (s) => s.totalMinor);
  const roamingMinor = sum(roaming, (x) => x.amountMinor);
  const fees = opts.fees ?? [];
  const feesMinor = sum(fees, (f) => f.totalMinor);
  return {
    sites,
    cards: [...cardMap.values()].sort((a, b) => a.uid.localeCompare(b.uid)),
    sessions,
    roaming,
    fees,
    totals: {
      sessions: sessions.length,
      energyWh: sum(sessions, (s) => s.energyWh),
      subtotalMinor: sum(sites, (l) => l.subtotalMinor),
      localTaxMinor: sum(sites, (l) => l.localTaxMinor),
      // The PPN totals cover every line on the faktur: charging per site, and membership fees.
      taxableMinor: sum(sites, (l) => l.taxableMinor) + sum(fees, (f) => f.taxableMinor),
      taxBaseMinor: sum(sites, (l) => l.taxBaseMinor) + sum(fees, (f) => f.taxBaseMinor),
      taxMinor: sum(sites, (l) => l.taxMinor) + sum(fees, (f) => f.taxMinor),
      ownTotalMinor,
      roamingSessions: roaming.length,
      roamingMinor,
      feesMinor,
      totalMinor: ownTotalMinor + roamingMinor + feesMinor,
      receiptsTotalMinor,
      roundingMinor: ownTotalMinor - receiptsTotalMinor,
    },
    warnings,
    currency,
  };
}

/** Fee lines by kind, with their totals: the documents show memberships and reservations apart. */
export function splitFees(fees: FeeLine[] = []) {
  const reservations = fees.filter((f) => f.kind === 'reservation');
  const memberships = fees.filter((f) => f.kind !== 'reservation');
  const total = (xs: FeeLine[]) => xs.reduce((a, f) => a + f.totalMinor, 0);
  return { memberships, reservations, membershipsMinor: total(memberships), reservationsMinor: total(reservations) };
}
