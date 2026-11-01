import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { LEGACY_CURRENCY } from '../domain/money.js';
import { assertOpen } from './finance-periods.js';
import { balances } from './general-ledger.js';
import { xlsx } from './xlsx.js';

/**
 * Corporate income tax and deferred tax (v1.39.0): the year's PPh Badan from the books, for the SPT Tahunan.
 *
 *   commercial result   the ledger's result before tax for the year (statutory P&L, without 9100/9110)
 *   fiscal corrections  automatic: depreciation (book against fiscal, straight line over the tax groups' lives:
 *                       IT 4 years, chargers, installation, equipment and vehicles 8, grid connections 16, from the
 *                       month in service), leases (PSAK 73 depreciation and interest added back, the rent paid
 *                       deducted), the bad-debt allowance's increase, the loyalty liability's increase; plus those
 *                       recorded (positive: not deductible; negative: income taxed finally or not taxable)
 *   tax                 fiscal profit × the rate (22%); with Article 31E (turnover up to Rp 50 billion; rupiah only),
 *                       the share of the profit for Rp 4.8 billion of turnover at half the rate. A loss: none.
 *   credits             PPh 22 and 23 withheld by others, PPh 25 instalments paid; PPh 29 = tax − credits (or
 *                       overpaid); next year's PPh 25 = (tax − PPh 22 − PPh 23) ÷ 12
 *   deferred tax        temporary differences at the year end × the rate: fixed assets (book − fiscal net value,
 *                       taxable), leases (right-of-use asset − lease liability), the bad-debt allowance and the
 *                       loyalty liability (deductible later). Net taxable: a liability (2710); net deductible: an
 *                       asset (1470).
 *   final               a Finance Manager finalises the year; the ledger's tax journal (source tax) then books, in
 *                       December: Dr 9100 current tax / Cr 2700 tax payable; Dr 2700 / Cr 1460 PPh 25 paid and
 *                       Cr 1465 tax withheld by others; the deferred tax's change against 9110. Each PPh 25 or 29
 *                       paid from an account posts in its month (Dr 1460 or 2700 / Cr bank).
 */

export class CorporateTaxError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const ERR = (s: number, m: string) => new CorporateTaxError(s, m);
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DEFAULT_RATE_PCT = 22;
/** Article 31E: turnover limit and the turnover whose share of the profit gets half the rate (rupiah). */
export const FACILITY_TURNOVER = 50_000_000_000;
export const FACILITY_PORTION = 4_800_000_000;
/** Fiscal lives (months) per asset category: the PPh Article 11 groups, straight line. */
export const FISCAL_LIFE: Record<string, number> = { it: 48, chargers: 96, installation: 96, equipment: 96, vehicles: 96, grid: 192, other: 96 };
export const CATEGORIES = ['entertainment', 'donations', 'fines', 'benefits_in_kind', 'final_income', 'non_taxable', 'loss_carried_forward', 'other'] as const;
export const KINDS = ['pph25', 'pph29', 'pph22', 'pph23'] as const;

const monthsBetween = (a: string, b: string) => { const [ya, ma] = a.split('-').map(Number) as [number, number]; const [yb, mb] = b.split('-').map(Number) as [number, number]; return (yb - ya) * 12 + (mb - ma); };
const r = Math.round;

/** The tax on a fiscal profit. Pure. */
export function taxOn(fiscal: number, turnover: number, ratePct: number, facility: boolean): { tax: number; facilityShare: number } {
  if (fiscal <= 0) return { tax: 0, facilityShare: 0 };
  const share = facility && turnover > 0 && turnover <= FACILITY_TURNOVER ? Math.min(1, FACILITY_PORTION / turnover) : 0;
  return { tax: r(fiscal * share * ratePct / 200 + fiscal * (1 - share) * ratePct / 100), facilityShare: Math.round(share * 10000) / 100 };
}

/** Fiscal straight-line depreciation of an asset in a year and its fiscal net value at the year end. Pure. */
export function fiscalDepreciation(cost: number, inService: string, lifeMonths: number, year: number, disposedMonth?: string | null) {
  const monthly = cost / lifeMonths;
  const used = (to: string) => Math.max(0, Math.min(lifeMonths, monthsBetween(inService, to) + 1));
  const stop = (m: string) => (disposedMonth && disposedMonth <= m ? disposedMonth : m);
  const before = inService > `${year - 1}-12` ? 0 : used(stop(`${year - 1}-12`));
  const after = inService > `${year}-12` ? 0 : used(stop(`${year}-12`));
  const gone = !!disposedMonth && disposedMonth <= `${year}-12`;
  return { depreciation: r(monthly * (after - before)), netValue: gone ? 0 : r(cost - Math.min(cost, monthly * after)) };
}

export async function settings(orgId: string) {
  const s = await outsideRequestScope(() => one<{ corporate_tax: any }>(`SELECT corporate_tax FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const c = s?.corporate_tax ?? {};
  return { ratePct: typeof c.ratePct === 'number' ? c.ratePct : DEFAULT_RATE_PCT, facility31e: c.facility31e !== false };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cur = await settings(orgId);
  const ratePct = b.ratePct == null || b.ratePct === '' ? cur.ratePct : Number(b.ratePct);
  if (!Number.isFinite(ratePct) || ratePct <= 0 || ratePct > 50) throw ERR(422, 'ratePct is the corporate tax rate, more than 0 and up to 50.');
  const v = { ratePct, facility31e: b.facility31e === undefined ? cur.facility31e : b.facility31e === true || b.facility31e === 'true' };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, corporate_tax, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET corporate_tax = EXCLUDED.corporate_tax, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

const yearOk = (raw: unknown, now: Date) => {
  const y = Number(raw);
  if (!Number.isInteger(y) || y < 2000 || y > Number(today(now).slice(0, 4))) throw ERR(422, 'year is a past or the current year.');
  return y;
};

/** The automatic corrections and the temporary differences at a year's end. */
async function bookFigures(orgId: string, year: number, currency: string) {
  const [fa, ls] = await Promise.all([import('./fixed-assets.js'), import('./leases.js')]);
  const reg = await fa.register(orgId, { month: `${year}-12` });
  const assets = reg.assets.filter((a) => a.status !== 'voided' && a.currency === currency && a.inService <= `${year}-12`);
  let bookDep = 0, fiscalDep = 0, bookNbv = 0, fiscalNbv = 0;
  for (const a of assets) {
    const months = Array.from({ length: 12 }, (_, k) => `${year}-${String(k + 1).padStart(2, '0')}`);
    const disposed = a.disposal?.on?.slice(0, 7) ?? null;
    const basis = { cost: a.cost, residual: a.residual, inService: a.inService, lifeMonths: a.lifeMonths, method: a.method, ratePct: a.ratePct, disposedOn: a.disposal?.on ?? null } as any;
    bookDep += months.filter((m) => !disposed || m < disposed).reduce((s, m) => s + fa.depreciationIn(basis, m), 0);
    const f = fiscalDepreciation(a.cost, a.inService, FISCAL_LIFE[a.category] ?? 96, year, disposed);
    fiscalDep += f.depreciation;
    if (a.status !== 'disposed') { bookNbv += a.netBookValue; fiscalNbv += f.netValue; }
  }
  const leases = (await ls.list(orgId, { month: `${year}-12` })).leases.filter((l: any) => l.status !== 'voided' && l.currency === currency && !l.exempt);
  let leaseCost = 0, leasePaid = 0, rou = 0, liability = 0;
  for (const l of leases) {
    const sch = ls.schedule({ payment: l.payment, frequency: l.frequency, timing: l.timing, termMonths: l.termMonths, ratePct: l.ratePct, directCosts: l.directCosts, startMonth: l.startMonth, endedMonth: l.endedMonth, exempt: l.exempt } as any);
    for (const row of sch.rows.filter((x) => x.month.startsWith(`${year}-`) && (!l.endedMonth || x.month < l.endedMonth))) { leaseCost += row.depreciation + row.interest; leasePaid += row.payment; }
    rou += l.position.rouNbv; liability += l.position.liability;
  }
  const [close, open] = await Promise.all([balances(orgId, currency, null, `${year}-12`), balances(orgId, currency, null, `${year - 1}-12`)]);
  const credit = (rows: Array<{ code: string; balance: number }>, c: string) => -(rows.find((x) => x.code === c)?.balance ?? 0);
  return {
    depreciation: { book: r(bookDep), fiscal: r(fiscalDep), bookNbv: r(bookNbv), fiscalNbv: r(fiscalNbv) },
    leases: { cost: r(leaseCost), paid: r(leasePaid), rou: r(rou), liability: r(liability) },
    allowance: { open: r(-credit(open, '1290')), close: r(-credit(close, '1290')) },
    loyalty: { open: r(credit(open, '2250')), close: r(credit(close, '2250')) },
  };
}

/** The year's computation (live, or as finalised). */
export async function computation(orgId: string, yearRaw: unknown, currencyRaw?: unknown, now = new Date()) {
  const year = yearRaw == null || yearRaw === '' ? Number(today(now).slice(0, 4)) - 1 : yearOk(yearRaw, now);
  const currency = currencyRaw == null || currencyRaw === '' ? LEGACY_CURRENCY : String(currencyRaw).toUpperCase();
  const row = await outsideRequestScope(() => one<any>(`SELECT y.*, u.name AS by_name FROM corporate_tax_year y LEFT JOIN app_user u ON u.id = y.finalised_by WHERE y.org_id = $1 AND y.year = $2 AND y.currency = $3`, [orgId, year, currency]));
  const live = await compute(orgId, year, currency);
  const prior = await outsideRequestScope(() => one<any>(`SELECT figures FROM corporate_tax_year WHERE org_id = $1 AND year = $2 AND currency = $3 AND status = 'final'`, [orgId, year - 1, currency]));
  const figures = row?.status === 'final' ? row.figures : live;
  return {
    ...figures, status: row?.status ?? 'draft', finalisedBy: row?.by_name ?? null, finalisedAt: row?.finalised_at ? new Date(row.finalised_at).toISOString() : null,
    changedSinceFinal: row?.status === 'final' ? live.tax !== row.figures.tax || live.deferred.net !== row.figures.deferred.net : false,
    priorDeferred: prior?.figures?.deferred ?? null, ended: year < Number(today(now).slice(0, 4)),
  };
}

async function compute(orgId: string, year: number, currency: string) {
  const s = await settings(orgId);
  const pl = (await balances(orgId, currency, `${year}-01`, `${year}-12`)).filter((b) => ['revenue', 'expense', 'other'].includes(b.type) || b.code.startsWith('91'));
  const beforeTax = r(-pl.filter((b) => !b.code.startsWith('91')).reduce((a, b) => a + b.balance, 0));
  const turnover = r(-pl.filter((b) => b.type === 'revenue').reduce((a, b) => a + b.balance, 0));
  const bf = await bookFigures(orgId, year, currency);
  const [manual, pays] = await outsideRequestScope(() => Promise.all([
    many<any>(`SELECT id::text AS id, direction, category, description, amount_minor FROM tax_fiscal_correction WHERE org_id = $1 AND year = $2 AND currency = $3 AND voided_at IS NULL ORDER BY id`, [orgId, year, currency]),
    many<any>(`SELECT id::text AS id, kind, month, amount_minor, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, reference FROM tax_payment WHERE org_id = $1 AND year = $2 AND currency = $3 AND voided_at IS NULL ORDER BY paid_on, id`, [orgId, year, currency]),
  ]));
  const auto = [
    { category: 'depreciation', description: `Book depreciation ${bf.depreciation.book.toLocaleString('en-US')} against fiscal ${bf.depreciation.fiscal.toLocaleString('en-US')}`, amount: bf.depreciation.book - bf.depreciation.fiscal },
    { category: 'leases', description: `Right-of-use depreciation and lease interest ${bf.leases.cost.toLocaleString('en-US')} against rent paid ${bf.leases.paid.toLocaleString('en-US')}`, amount: bf.leases.cost - bf.leases.paid },
    { category: 'bad_debt_allowance', description: 'Increase in the bad-debt allowance (deductible when written off)', amount: bf.allowance.close - bf.allowance.open },
    { category: 'loyalty_liability', description: 'Increase in the loyalty points liability', amount: bf.loyalty.close - bf.loyalty.open },
  ].filter((a) => a.amount).map((a) => ({ ...a, direction: a.amount > 0 ? 'positive' : 'negative', amount: Math.abs(a.amount), automatic: true, id: null as string | null }));
  const recorded = manual.map((m) => ({ id: m.id, category: m.category, description: m.description, direction: m.direction, amount: Number(m.amount_minor), automatic: false }));
  const corrections = [...auto, ...recorded];
  const positive = corrections.filter((c) => c.direction === 'positive').reduce((a, c) => a + c.amount, 0);
  const negative = corrections.filter((c) => c.direction === 'negative').reduce((a, c) => a + c.amount, 0);
  const fiscal = beforeTax + positive - negative;
  const { tax, facilityShare } = taxOn(fiscal, turnover, s.ratePct, s.facility31e && currency === LEGACY_CURRENCY);
  const sumKind = (k: string) => pays.filter((p) => p.kind === k).reduce((a, p) => a + Number(p.amount_minor), 0);
  const credits = { pph22: sumKind('pph22'), pph23: sumKind('pph23'), pph25: sumKind('pph25') };
  const totalCredits = credits.pph22 + credits.pph23 + credits.pph25;
  const items = [
    { item: 'fixed_assets', label: 'Fixed assets: book less fiscal net value', amount: bf.depreciation.bookNbv - bf.depreciation.fiscalNbv },
    { item: 'leases', label: 'Leases: right-of-use assets less lease liabilities', amount: bf.leases.rou - bf.leases.liability },
    { item: 'allowance', label: 'Bad-debt allowance', amount: -bf.allowance.close },
    { item: 'loyalty', label: 'Loyalty points liability', amount: -bf.loyalty.close },
  ].map((i) => ({ ...i, tax: r(i.amount * s.ratePct / 100) }));
  const net = items.reduce((a, i) => a + i.tax, 0);
  return {
    year, currency, ratePct: s.ratePct, facility31e: s.facility31e && currency === LEGACY_CURRENCY,
    turnover, resultBeforeTax: beforeTax, corrections, positive, negative, fiscalProfit: fiscal, facilitySharePct: facilityShare, tax,
    credits, totalCredits, pph29: tax - totalCredits, pph29Paid: sumKind('pph29'), nextPph25: Math.max(0, r((tax - credits.pph22 - credits.pph23) / 12)),
    payments: pays.map((p) => ({ id: p.id, kind: p.kind, month: p.month ?? null, amount: Number(p.amount_minor), paidOn: p.paid_on, reference: p.reference ?? null })),
    deferred: { items, net, liability: Math.max(0, net), asset: Math.max(0, -net) },
    effectiveRatePct: beforeTax > 0 ? Math.round(((tax) / beforeTax) * 1000) / 10 : null,
    bookFigures: bf,
  };
}

export async function addCorrection(orgId: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const year = yearOk(b.year, now);
  const currency = b.currency == null || b.currency === '' ? LEGACY_CURRENCY : String(b.currency).toUpperCase();
  const direction = String(b.direction ?? ''), category = String(b.category ?? ''), description = String(b.description ?? '').trim(), amount = Number(b.amount);
  if (!['positive', 'negative'].includes(direction)) throw ERR(422, 'direction is positive (not deductible) or negative (not taxable, or taxed finally).');
  if (!(CATEGORIES as readonly string[]).includes(category)) throw ERR(422, `category is one of ${CATEGORIES.join(', ')}.`);
  if (!description || description.length > 300) throw ERR(422, 'description is required (up to 300 characters).');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw ERR(422, 'amount is a positive amount in minor units.');
  await notFinal(orgId, year, currency);
  const r0 = await outsideRequestScope(() => one<{ id: string }>(`INSERT INTO tax_fiscal_correction (org_id, year, currency, direction, category, description, amount_minor, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [orgId, year, currency, direction, category, description, amount, userId]));
  return { id: String(r0!.id), year, currency, direction, category, description, amount };
}

export async function voidCorrection(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw ERR(404, 'No such correction.');
  const c = await outsideRequestScope(() => one<any>(`SELECT year, currency FROM tax_fiscal_correction WHERE id = $1 AND org_id = $2 AND voided_at IS NULL`, [id, orgId]));
  if (!c) throw ERR(404, 'No such correction.');
  await notFinal(orgId, c.year, c.currency);
  await outsideRequestScope(() => query(`UPDATE tax_fiscal_correction SET voided_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId]));
  return { id, voided: true };
}

async function notFinal(orgId: string, year: number, currency: string) {
  const f = await outsideRequestScope(() => one(`SELECT 1 FROM corporate_tax_year WHERE org_id = $1 AND year = $2 AND currency = $3 AND status = 'final'`, [orgId, year, currency]));
  if (f) throw ERR(409, `${year} is final: reopen it first.`);
}

export async function addPayment(orgId: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const year = yearOk(b.year, now);
  const currency = b.currency == null || b.currency === '' ? LEGACY_CURRENCY : String(b.currency).toUpperCase();
  const kind = String(b.kind ?? ''), amount = Number(b.amount), paidOn = String(b.paidOn ?? '');
  if (!(KINDS as readonly string[]).includes(kind)) throw ERR(422, `kind is one of ${KINDS.join(', ')}.`);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw ERR(422, 'amount is a positive amount in minor units.');
  if (!DATE_RE.test(paidOn) || paidOn > today(now)) throw ERR(422, 'paidOn is a day (YYYY-MM-DD), not in the future.');
  const month = b.month == null || b.month === '' ? null : String(b.month);
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw ERR(422, 'month is YYYY-MM (the instalment\'s tax month).');
  let acct: string | null = null;
  if (b.cashAccountId != null && b.cashAccountId !== '') {
    if (kind === 'pph22' || kind === 'pph23') throw ERR(422, 'PPh 22 and 23 are withheld by others: no account pays them.');
    acct = String(b.cashAccountId);
    const a = /^\d{1,18}$/.test(acct) ? await outsideRequestScope(() => one<{ currency: string }>(`SELECT currency FROM cash_account WHERE id = $1 AND org_id = $2`, [acct, orgId])) : null;
    if (!a) throw ERR(422, 'cashAccountId is not one of your cash accounts.');
    if (a.currency !== currency) throw ERR(422, `The account is in ${a.currency}.`);
    await assertOpen(orgId, paidOn.slice(0, 7), 'A tax payment', ERR);
  }
  const r0 = await outsideRequestScope(() => one<{ id: string }>(`INSERT INTO tax_payment (org_id, year, kind, month, currency, amount_minor, paid_on, reference, cash_account_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [orgId, year, kind, month, currency, amount, paidOn, b.reference == null || b.reference === '' ? null : String(b.reference).slice(0, 80), acct, userId]));
  return { id: String(r0!.id), year, kind, month, currency, amount, paidOn, cashAccountId: acct };
}

export async function voidPayment(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw ERR(404, 'No such payment.');
  const p = await outsideRequestScope(() => one<any>(`SELECT to_char(paid_on, 'YYYY-MM') AS m, cash_account_id FROM tax_payment WHERE id = $1 AND org_id = $2 AND voided_at IS NULL`, [id, orgId]));
  if (!p) throw ERR(404, 'No such payment.');
  if (p.cash_account_id) await assertOpen(orgId, p.m, 'A tax payment', ERR);
  await outsideRequestScope(() => query(`UPDATE tax_payment SET voided_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId]));
  return { id, voided: true };
}

/** Finalise (a Finance Manager, an ended year) or reopen. */
export async function decide(orgId: string, yearRaw: unknown, b: Record<string, unknown>, who: { userId: string | null; canApprove: boolean }, now = new Date()) {
  if (!who.canApprove) throw ERR(403, 'A Finance Manager (finance:approve) finalises or reopens the year\'s tax.');
  const year = yearOk(yearRaw, now);
  const currency = b.currency == null || b.currency === '' ? LEGACY_CURRENCY : String(b.currency).toUpperCase();
  await assertOpen(orgId, `${year}-12`, 'The year\'s tax', ERR);
  if (b.action === 'reopen') {
    await outsideRequestScope(() => query(`UPDATE corporate_tax_year SET status = 'draft', finalised_by = NULL, finalised_at = NULL, updated_at = now() WHERE org_id = $1 AND year = $2 AND currency = $3`, [orgId, year, currency]));
  } else if (b.action === 'finalise') {
    if (year >= Number(today(now).slice(0, 4))) throw ERR(422, 'A year is finalised once it has ended.');
    const f = await compute(orgId, year, currency);
    await outsideRequestScope(() => query(
      `INSERT INTO corporate_tax_year (org_id, year, currency, status, figures, finalised_by, finalised_at) VALUES ($1, $2, $3, 'final', $4, $5, now())
       ON CONFLICT (org_id, year, currency) DO UPDATE SET status = 'final', figures = EXCLUDED.figures, finalised_by = EXCLUDED.finalised_by, finalised_at = now(), updated_at = now()`,
      [orgId, year, currency, JSON.stringify(f), who.userId]));
  } else throw ERR(422, 'action is finalise or reopen.');
  return computation(orgId, year, currency, now);
}

/** The ledger's tax journal for a month. */
export async function journal(orgId: string, month: string) {
  const out: Record<string, Array<{ account: string; debit: number; credit: number; description: string }>> = {};
  const accts = await outsideRequestScope(() => many<any>(`SELECT id::text AS id, kind FROM cash_account WHERE org_id = $1`, [orgId]));
  const bank = (id: unknown) => (accts.find((a) => a.id === String(id ?? ''))?.kind === 'cash' ? '1050' : '1100');
  const pays = await outsideRequestScope(() => many<any>(`SELECT * FROM tax_payment WHERE org_id = $1 AND voided_at IS NULL AND cash_account_id IS NOT NULL AND to_char(paid_on, 'YYYY-MM') = $2 AND kind IN ('pph25', 'pph29')`, [orgId, month]));
  for (const p of pays) {
    const L = (out[p.currency] ??= []), a = Number(p.amount_minor), d = `${p.kind === 'pph25' ? 'PPh 25' : 'PPh 29'} ${p.month ?? p.year}${p.reference ? ` ${p.reference}` : ''}`;
    L.push({ account: p.kind === 'pph25' ? '1460' : '2700', debit: a, credit: 0, description: d }, { account: bank(p.cash_account_id), debit: 0, credit: a, description: d });
  }
  if (month.endsWith('-12')) {
    const year = Number(month.slice(0, 4));
    const finals = await outsideRequestScope(() => many<any>(`SELECT currency, figures FROM corporate_tax_year WHERE org_id = $1 AND year = $2 AND status = 'final'`, [orgId, year]));
    for (const f of finals) {
      const L = (out[f.currency] ??= []), x = f.figures;
      const d = `Corporate income tax ${year}`;
      if (x.tax) L.push({ account: '9100', debit: x.tax, credit: 0, description: d }, { account: '2700', debit: 0, credit: x.tax, description: d });
      if (x.credits.pph25) L.push({ account: '2700', debit: x.credits.pph25, credit: 0, description: `${d}: PPh 25 credited` }, { account: '1460', debit: 0, credit: x.credits.pph25, description: `${d}: PPh 25 credited` });
      const w = x.credits.pph22 + x.credits.pph23;
      if (w) L.push({ account: '2700', debit: w, credit: 0, description: `${d}: PPh 22/23 credited` }, { account: '1465', debit: 0, credit: w, description: `${d}: PPh 22/23 credited` });
      const prior = await outsideRequestScope(() => one<any>(`SELECT figures FROM corporate_tax_year WHERE org_id = $1 AND year = $2 AND currency = $3 AND status = 'final'`, [orgId, year - 1, f.currency]));
      const pa = Number(prior?.figures?.deferred?.asset ?? 0), pl = Number(prior?.figures?.deferred?.liability ?? 0);
      const dA = x.deferred.asset - pa, dL = x.deferred.liability - pl, dd = `Deferred tax ${year}`;
      if (dA > 0) L.push({ account: '1470', debit: dA, credit: 0, description: dd }, { account: '9110', debit: 0, credit: dA, description: dd });
      if (dA < 0) L.push({ account: '9110', debit: -dA, credit: 0, description: dd }, { account: '1470', debit: 0, credit: -dA, description: dd });
      if (dL > 0) L.push({ account: '9110', debit: dL, credit: 0, description: dd }, { account: '2710', debit: 0, credit: dL, description: dd });
      if (dL < 0) L.push({ account: '2710', debit: -dL, credit: 0, description: dd }, { account: '9110', debit: 0, credit: -dL, description: dd });
    }
  }
  return out;
}

/** Tax paid from an account, for the cash position. */
export async function cashMoves(orgId: string, upTo: string) {
  const rows = await outsideRequestScope(() => many<any>(`SELECT cash_account_id::text AS a, to_char(paid_on, 'YYYY-MM-DD') AS d, amount_minor FROM tax_payment WHERE org_id = $1 AND voided_at IS NULL AND cash_account_id IS NOT NULL AND paid_on <= $2::date`, [orgId, upTo]));
  return rows.map((x) => ({ account_id: x.a as string, d: x.d as string, amount: -Number(x.amount_minor) }));
}

/** The SPT Tahunan workpaper. */
export async function workpaper(orgId: string, yearRaw: unknown, currency?: unknown): Promise<Buffer> {
  const c = await computation(orgId, yearRaw, currency);
  return xlsx([
    { name: 'Computation', rows: [['', c.currency], ['Turnover', c.turnover], ['Commercial result before tax', c.resultBeforeTax], ['Positive corrections', c.positive], ['Negative corrections', -c.negative], ['Fiscal profit', c.fiscalProfit],
      ['Rate %', c.ratePct], ['Article 31E share %', c.facilitySharePct], ['Corporate income tax', c.tax], ['PPh 22 credited', c.credits.pph22], ['PPh 23 credited', c.credits.pph23], ['PPh 25 paid', c.credits.pph25], ['PPh 29 (− overpaid)', c.pph29], ['PPh 29 paid', c.pph29Paid], ['Next year\'s PPh 25 a month', c.nextPph25], ['Status', c.status]],
      widths: [36, 20], formats: [null, 'money'] },
    { name: 'Fiscal corrections', rows: [['Direction', 'Category', 'Description', 'Amount', 'Automatic'], ...c.corrections.map((x: any) => [x.direction, x.category, x.description, x.amount, x.automatic ? 'yes' : ''])], widths: [10, 20, 60, 16, 10], formats: [null, null, null, 'money', null] },
    { name: 'Tax paid and credits', rows: [['Kind', 'Month', 'Paid on', 'Amount', 'Reference'], ...c.payments.map((p: any) => [p.kind, p.month ?? '', p.paidOn, p.amount, p.reference ?? ''])], widths: [8, 9, 11, 16, 24], formats: [null, null, null, 'money', null] },
    { name: 'Deferred tax', rows: [['Temporary difference', 'Amount', 'Tax'], ...c.deferred.items.map((i: any) => [i.label, i.amount, i.tax]), ['Net (positive: liability)', '', c.deferred.net]], widths: [50, 18, 18], formats: [null, 'money', 'money'] },
  ]);
}
