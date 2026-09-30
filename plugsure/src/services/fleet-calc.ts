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
  subtotalIdr: number;
  pbjtIdr: number;
  ppnDppIdr: number;
  ppnRateBps: number;
  ppnIdr: number;
  totalIdr: number;
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
  feeIdr: number;
  /** Price subject to PPN: the fee, or 0 when the seller is not PKP. */
  taxBaseIdr: number;
  dppIdr: number;
  ppnIdr: number;
  totalIdr: number;
  periodStart: string;
  periodEnd: string;
  /** Part of a month: the days in force, of the days in the month (the fee is prorated). */
  monthlyFeeIdr?: number;
  days?: number;
  daysInPeriod?: number;
}

export interface SiteLine {
  siteId: string;
  siteName: string;
  sessions: number;
  energyWh: number;
  subtotalIdr: number;
  pbjtIdr: number;
  /** Harga jual subject to PPN (the e-Faktur TaxBase). 0 when the sessions carry no PPN. */
  taxBaseIdr: number;
  dppIdr: number;
  ppnIdr: number;
  totalIdr: number;
  /** Sessions here without PPN (a tariff with PPN off). */
  untaxedSessions: number;
}

export interface FleetStatementCalc {
  sites: SiteLine[];
  cards: Array<{ uid: string; holder: string | null; sessions: number; energyWh: number; totalIdr: number; roamingIdr: number }>;
  sessions: Array<FleetSession & { taxBaseIdr: number }>;
  roaming: Array<FleetRoaming & { amountIdr: number }>;
  fees: FeeLine[];
  totals: {
    sessions: number;
    energyWh: number;
    subtotalIdr: number;
    pbjtIdr: number;
    taxBaseIdr: number;
    dppIdr: number;
    ppnIdr: number;
    ownTotalIdr: number;
    roamingSessions: number;
    roamingIdr: number;
    /** Membership fees, including their PPN. */
    feesIdr: number;
    totalIdr: number;
    /** Sum of the per-session receipts, and how far the invoice differs from it (rounding). */
    receiptsTotalIdr: number;
    roundingIdr: number;
  };
  warnings: string[];
}

const r = Math.round;

export const dppOf = (taxBase: number, cfg: TaxCfg) => r((taxBase * cfg.dppNum) / cfg.dppDen);
export const ppnOf = (dpp: number, cfg: TaxCfg) => r((dpp * cfg.ppnRateBps) / 10_000);

/**
 * The price a session's PPN was levied on. The charge record keeps the DPP, not
 * the price, and whether PBJT-TL sat inside the PPN base is a setting that may
 * have changed since; so try both and keep the one that reproduces the DPP.
 */
export function taxBaseOf(s: Pick<FleetSession, 'subtotalIdr' | 'pbjtIdr' | 'ppnDppIdr' | 'ppnRateBps'>, cfg: TaxCfg): { base: number; exact: boolean } {
  if (!s.ppnRateBps || !s.ppnDppIdr) return { base: 0, exact: true };
  for (const base of [s.subtotalIdr + s.pbjtIdr, s.subtotalIdr]) {
    if (dppOf(base, cfg) === s.ppnDppIdr) return { base, exact: true };
  }
  return { base: r((s.ppnDppIdr * cfg.dppDen) / cfg.dppNum), exact: false };
}

export function computeFleetStatement(sessionsIn: FleetSession[], roamingIn: FleetRoaming[], opts: { includeRoaming: boolean; cfg: TaxCfg; fees?: FeeLine[] }): FleetStatementCalc {
  const { cfg } = opts;
  const warnings: string[] = [];
  let inexact = 0;
  const sessions = sessionsIn.map((s) => {
    const t = taxBaseOf(s, cfg);
    if (!t.exact) inexact++;
    return { ...s, taxBaseIdr: t.base };
  });
  if (inexact) warnings.push(`${inexact} session(s): the PPN price was reconstructed from the DPP (the tax settings changed since they were rated).`);

  const bySite = new Map<string, SiteLine>();
  for (const s of sessions) {
    const l = bySite.get(s.siteId) ?? {
      siteId: s.siteId, siteName: s.siteName, sessions: 0, energyWh: 0, subtotalIdr: 0, pbjtIdr: 0,
      taxBaseIdr: 0, dppIdr: 0, ppnIdr: 0, totalIdr: 0, untaxedSessions: 0,
    };
    l.sessions++;
    l.energyWh += s.energyWh;
    l.subtotalIdr += s.subtotalIdr;
    l.pbjtIdr += s.pbjtIdr;
    l.taxBaseIdr += s.taxBaseIdr;
    if (!s.ppnRateBps) l.untaxedSessions++;
    bySite.set(s.siteId, l);
  }
  const sites = [...bySite.values()].sort((a, b) => a.siteName.localeCompare(b.siteName));
  for (const l of sites) {
    l.dppIdr = dppOf(l.taxBaseIdr, cfg);
    l.ppnIdr = ppnOf(l.dppIdr, cfg);
    l.totalIdr = l.subtotalIdr + l.pbjtIdr + l.ppnIdr;
  }

  const roaming: Array<FleetRoaming & { amountIdr: number }> = [];
  if (opts.includeRoaming) {
    let foreign = 0;
    for (const x of roamingIn) {
      if (x.currency !== 'IDR') { foreign++; continue; }
      roaming.push({ ...x, amountIdr: r(x.inclVat ?? x.exclVat) });
    }
    if (foreign) warnings.push(`${foreign} partner network charge record(s) in another currency were left off; bill them separately.`);
  }

  const cardMap = new Map<string, { uid: string; holder: string | null; sessions: number; energyWh: number; totalIdr: number; roamingIdr: number }>();
  const card = (uid: string, holder: string | null) => {
    const c = cardMap.get(uid) ?? { uid, holder, sessions: 0, energyWh: 0, totalIdr: 0, roamingIdr: 0 };
    if (!c.holder && holder) c.holder = holder;
    cardMap.set(uid, c);
    return c;
  };
  for (const s of sessions) { const c = card(s.cardUid, s.holder); c.sessions++; c.energyWh += s.energyWh; c.totalIdr += s.totalIdr; }
  for (const x of roaming) { const c = card(x.cardUid, null); c.roamingIdr += x.amountIdr; c.energyWh += Math.round(x.energyKwh * 1000); }

  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
  const ownTotalIdr = sum(sites, (l) => l.totalIdr);
  const receiptsTotalIdr = sum(sessions, (s) => s.totalIdr);
  const roamingIdr = sum(roaming, (x) => x.amountIdr);
  const fees = opts.fees ?? [];
  const feesIdr = sum(fees, (f) => f.totalIdr);
  return {
    sites,
    cards: [...cardMap.values()].sort((a, b) => a.uid.localeCompare(b.uid)),
    sessions,
    roaming,
    fees,
    totals: {
      sessions: sessions.length,
      energyWh: sum(sessions, (s) => s.energyWh),
      subtotalIdr: sum(sites, (l) => l.subtotalIdr),
      pbjtIdr: sum(sites, (l) => l.pbjtIdr),
      // The PPN totals cover every line on the faktur: charging per site, and membership fees.
      taxBaseIdr: sum(sites, (l) => l.taxBaseIdr) + sum(fees, (f) => f.taxBaseIdr),
      dppIdr: sum(sites, (l) => l.dppIdr) + sum(fees, (f) => f.dppIdr),
      ppnIdr: sum(sites, (l) => l.ppnIdr) + sum(fees, (f) => f.ppnIdr),
      ownTotalIdr,
      roamingSessions: roaming.length,
      roamingIdr,
      feesIdr,
      totalIdr: ownTotalIdr + roamingIdr + feesIdr,
      receiptsTotalIdr,
      roundingIdr: ownTotalIdr - receiptsTotalIdr,
    },
    warnings,
  };
}

/** Fee lines by kind, with their totals: the documents show memberships and reservations apart. */
export function splitFees(fees: FeeLine[] = []) {
  const reservations = fees.filter((f) => f.kind === 'reservation');
  const memberships = fees.filter((f) => f.kind !== 'reservation');
  const total = (xs: FeeLine[]) => xs.reduce((a, f) => a + f.totalIdr, 0);
  return { memberships, reservations, membershipsIdr: total(memberships), reservationsIdr: total(reservations) };
}
