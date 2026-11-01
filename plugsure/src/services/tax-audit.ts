import { createHash } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { period as ppnPeriod } from './ppn-return.js';
import { xlsx, zip } from './xlsx.js';
import { LEGACY_CURRENCY } from '../domain/money.js';

/**
 * Tax audit readiness (v1.37.0): being ready when the tax office (DJP) asks — an SP2DK (a request for clarification)
 * or an audit (pemeriksaan) of a year.
 *
 *   equalisation  per month of the year (rupiah, the Indonesian tax scheme): the PPN return as filed against the
 *                 figures recomputed today (a difference means an amendment, pembetulan); for a PKP, PPN output's DPP
 *                 against the charging revenue of the charge records (fleet invoices, credit notes and memberships are
 *                 shown beside); the input PPN on approved supplier bills not covered by the faktur masukan recorded
 *                 (which also hold VAT without a bill: gateway and PlugSure fees); the PPh 21/23/26 withheld on bills against the slips (bukti potong) issued
 *   gaps          per transaction: bills that withheld tax without an issued slip, fleet invoices with PPN but no
 *                 e-Faktur number, months not filed, months whose filing differs from today's figures
 *   readiness     the share of ended months with nothing open
 *   cases         the tax office's letters: kind, number, year, taxes, received and respond-by dates, status (open →
 *                 responded → closed with no change, or assessed → objected or paid), the amount assessed. An open
 *                 letter raises finance.tax_audit_due from 7 days before its respond-by date (critical once past).
 *   pack          one ZIP for the consultant or the auditor: the workbook, the gaps as CSV, a README and a manifest
 *                 with each file's SHA-256
 */

export class TaxAuditError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DUE = 'finance.tax_audit_due';
const KINDS = ['sp2dk', 'office_audit', 'field_audit', 'other'] as const;
const TAXES = ['ppn', 'pph21', 'pph23', 'pph26', 'pph4_2', 'pph25', 'pph29', 'pbjt', 'other'] as const;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
/** A difference that matters: more than Rp 1 000 and more than 0.5% of the larger. Pure. */
export const material = (a: number, b: number) => Math.abs(a - b) > 1000 && Math.abs(a - b) > Math.max(Math.abs(a), Math.abs(b)) * 0.005;

export async function equalisation(orgId: string, yearRaw: unknown, now = new Date()) {
  const year = Number(yearRaw ?? Number(today(now).slice(0, 4)) - 1);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new TaxAuditError(422, 'year is 2000 to 2100.');
  const cur = today(now).slice(0, 7);
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`).filter((m) => m < cur);
  const [revenue, bills, slips, inputs] = await Promise.all([
    outsideRequestScope(() => many<any>(`SELECT to_char(issued_at AT TIME ZONE $3, 'YYYY-MM') AS m, sum(subtotal_minor)::bigint AS rev FROM cdr WHERE org_id = $1 AND currency = $4 AND NOT COALESCE(test_mode, false)
      AND to_char(issued_at AT TIME ZONE $3, 'YYYY') = $2 GROUP BY 1`, [orgId, String(year), zone(), LEGACY_CURRENCY])),
    outsideRequestScope(() => many<any>(`SELECT b.id, b.number, s.name AS supplier, to_char(b.bill_date, 'YYYY-MM') AS m, to_char(b.bill_date, 'YYYY-MM-DD') AS d, b.vat_minor, b.wht_minor, b.wht_kind, b.subtotal_minor
      FROM supplier_bill b JOIN supplier s ON s.id = b.supplier_id WHERE b.org_id = $1 AND b.currency = $3 AND b.status IN ('approved', 'paid') AND to_char(b.bill_date, 'YYYY') = $2`, [orgId, String(year), LEGACY_CURRENCY])),
    outsideRequestScope(() => many<any>(`SELECT month, kind, tax_minor, bill_ids, number FROM tax_slip WHERE org_id = $1 AND status = 'issued' AND month LIKE $2`, [orgId, `${year}-%`])),
    outsideRequestScope(() => many<any>(`SELECT month, sum(ppn_minor)::bigint AS ppn, count(*)::int AS n FROM ppn_input_invoice WHERE org_id = $1 AND voided_at IS NULL AND month LIKE $2 GROUP BY 1`, [orgId, `${year}-%`])),
  ]);
  const slipped = new Set(slips.flatMap((s) => (s.bill_ids ?? []).map(String)));
  const rows = [];
  const gaps: Array<{ month: string; kind: string; reference: string; detail: string; amount: number | null }> = [];
  let pkp = false;
  for (const m of months) {
    const p = await ppnPeriod(orgId, m);
    pkp = pkp || p.pkp;
    const rev = Number(revenue.find((r) => r.m === m)?.rev ?? 0);
    const retail = p.output.lines.find((l) => l.key === 'retail');
    const mb = bills.filter((b) => b.m === m);
    const billVat = mb.reduce((a, b) => a + Number(b.vat_minor), 0), billWht = mb.reduce((a, b) => a + Number(b.wht_minor), 0);
    const slipWht = slips.filter((s) => s.month === m).reduce((a, s) => a + Number(s.tax_minor), 0);
    const inp = inputs.find((i) => i.month === m);
    const r = {
      month: m, revenue: rev, outputDpp: p.output.dpp, outputPpn: p.output.ppn, retailDpp: retail?.dpp ?? 0, otherDpp: p.output.dpp - (retail?.dpp ?? 0),
      inputPpn: p.input.ppn, billVat, inputRecorded: Number(inp?.ppn ?? 0), withheld: billWht, slips: slipWht,
      filed: p.filed ? { output: p.filed.output, input: p.filed.input, at: p.filed.at, ntpn: p.filed.ntpn } : null,
      revenueDiff: rev - (retail?.dpp ?? 0), filedDiffers: !!p.filed?.differs, missingEfaktur: p.missingEfaktur, issues: 0,
    };
    if (p.pkp && !p.filed && (p.output.ppn || p.input.ppn)) gaps.push({ month: m, kind: 'not_filed', reference: `PPN ${m}`, detail: 'The PPN return is not recorded as filed.', amount: p.payable });
    if (p.filed?.differs) gaps.push({ month: m, kind: 'filed_differs', reference: `PPN ${m}`, detail: `Filed output ${p.filed.output}, input ${p.filed.input}; today ${p.output.ppn} and ${p.input.ppn}: an amendment (pembetulan) may be needed.`, amount: p.output.ppn - p.input.ppn - (p.filed.output - p.filed.input) });
    if (p.pkp && material(rev, retail?.dpp ?? 0)) gaps.push({ month: m, kind: 'revenue_vs_dpp', reference: `Revenue ${m}`, detail: `Charging revenue ${rev} against retail DPP ${retail?.dpp ?? 0}.`, amount: rev - (retail?.dpp ?? 0) });
    // Faktur masukan also cover VAT without a bill (gateway and PlugSure fees): only PPN on bills not covered is open.
    if (billVat > r.inputRecorded && material(billVat, r.inputRecorded)) gaps.push({ month: m, kind: 'input_vat', reference: `Input PPN ${m}`, detail: `PPN on approved bills ${billVat}; faktur masukan recorded ${r.inputRecorded}.`, amount: billVat - r.inputRecorded });
    for (const b of mb.filter((x) => Number(x.wht_minor) > 0 && !slipped.has(String(x.id)))) gaps.push({ month: m, kind: 'no_slip', reference: `${b.supplier} ${b.number}`, detail: `${String(b.wht_kind ?? 'pph23').toUpperCase()} withheld on ${b.d} without an issued slip (bukti potong).`, amount: Number(b.wht_minor) });
    for (const i of p.output.invoices.filter((x) => !x.efaktur && x.ppn > 0)) gaps.push({ month: m, kind: 'no_efaktur', reference: `Fleet invoice ${i.number}`, detail: `PPN ${i.ppn} to ${i.buyer} without an e-Faktur number.`, amount: i.ppn });
    r.issues = gaps.filter((g) => g.month === m).length;
    rows.push(r);
  }
  const clean = rows.filter((r) => !r.issues).length;
  const counts: Record<string, number> = {};
  for (const g of gaps) counts[g.kind] = (counts[g.kind] ?? 0) + 1;
  return { year, pkp, months: rows, gaps, counts, readinessPct: rows.length ? Math.round((clean / rows.length) * 100) : null,
    totals: { revenue: rows.reduce((a, r) => a + r.revenue, 0), outputPpn: rows.reduce((a, r) => a + r.outputPpn, 0), inputPpn: rows.reduce((a, r) => a + r.inputPpn, 0), withheld: rows.reduce((a, r) => a + r.withheld, 0), slips: rows.reduce((a, r) => a + r.slips, 0) } };
}

// ------------------------------------------------------------------------------------------------ cases

const C_SELECT = `SELECT c.*, to_char(c.received_on, 'YYYY-MM-DD') AS rec_s, to_char(c.respond_by, 'YYYY-MM-DD') AS by_s, to_char(c.responded_on, 'YYYY-MM-DD') AS resp_s, to_char(c.closed_on, 'YYYY-MM-DD') AS closed_s FROM tax_audit_case c`;
const cView = (c: any, t = today()) => ({
  id: String(c.id), kind: c.kind, letterNo: c.letter_no, taxYear: c.tax_year, taxes: c.taxes ?? [], receivedOn: c.rec_s, respondBy: c.by_s ?? null, status: c.status,
  assessed: c.assessed_minor == null ? null : Number(c.assessed_minor), currency: c.currency, respondedOn: c.resp_s ?? null, closedOn: c.closed_s ?? null, note: c.note ?? null,
  daysLeft: c.status === 'open' && c.by_s ? days(t, c.by_s) : null, overdue: c.status === 'open' && !!c.by_s && c.by_s < t,
});

export async function cases(orgId: string) {
  return (await outsideRequestScope(() => many<any>(`${C_SELECT} WHERE c.org_id = $1 ORDER BY (c.status = 'open') DESC, c.received_on DESC LIMIT 200`, [orgId]))).map((c) => cView(c));
}

const NEXT: Record<string, string[]> = { open: ['responded', 'closed_no_change', 'assessed'], responded: ['closed_no_change', 'assessed'], assessed: ['objected', 'paid'], objected: ['paid', 'closed_no_change'], closed_no_change: [], paid: [] };

export async function saveCase(orgId: string, id: string | null, b: Record<string, unknown>, userId: string | null) {
  const cur = id ? await outsideRequestScope(() => one<any>(`${C_SELECT} WHERE c.id = $1 AND c.org_id = $2`, [/^\d{1,18}$/.test(id) ? id : '0', orgId])) : null;
  if (id && !cur) throw new TaxAuditError(404, 'No such case.');
  if (cur) {
    const status = String(b.status ?? cur.status);
    if (status !== cur.status && !NEXT[cur.status]!.includes(status)) throw new TaxAuditError(409, `A ${cur.status.replace(/_/g, ' ')} case moves to ${NEXT[cur.status]!.join(', ').replace(/_/g, ' ') || 'nothing'}.`);
    const assessed = b.assessed == null || b.assessed === '' ? (cur.assessed_minor == null ? null : Number(cur.assessed_minor)) : Number(b.assessed);
    if (status === 'assessed' && (assessed == null || !Number.isInteger(assessed) || assessed < 0)) throw new TaxAuditError(422, 'An assessed case has the amount assessed (assessed, the SKP).');
    const on = String(b.on ?? today());
    if (!DATE_RE.test(on)) throw new TaxAuditError(422, 'on is YYYY-MM-DD.');
    await outsideRequestScope(() => query(`UPDATE tax_audit_case SET status = $2, assessed_minor = $3, responded_on = CASE WHEN $2 = 'responded' AND responded_on IS NULL THEN $4::date ELSE responded_on END,
        closed_on = CASE WHEN $2 IN ('closed_no_change', 'paid') THEN $4::date ELSE closed_on END, respond_by = COALESCE($5::date, respond_by), note = COALESCE($6, note) WHERE id = $1`,
      [cur.id, status, assessed, on, b.respondBy ? String(b.respondBy) : null, b.note ? String(b.note).slice(0, 2000) : null]));
    if (status !== 'open') await outsideRequestScope(() => resolveAlertsFor(orgId, DUE, 'tax_audit_case', String(cur.id))).catch(() => 0);
    return cView(await outsideRequestScope(() => one<any>(`${C_SELECT} WHERE c.id = $1`, [cur.id])));
  }
  const kind = String(b.kind ?? '');
  if (!(KINDS as readonly string[]).includes(kind)) throw new TaxAuditError(422, 'kind is sp2dk, office_audit, field_audit or other.');
  const letter = String(b.letterNo ?? '').trim();
  if (letter.length < 3) throw new TaxAuditError(422, 'letterNo is the letter\'s number.');
  const year = Number(b.taxYear);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new TaxAuditError(422, 'taxYear is the year audited.');
  const taxes = Array.isArray(b.taxes) ? b.taxes.map(String) : String(b.taxes ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (taxes.some((t) => !(TAXES as readonly string[]).includes(t))) throw new TaxAuditError(422, `taxes are among ${TAXES.join(', ')}.`);
  const rec = String(b.receivedOn ?? today()), by = b.respondBy ? String(b.respondBy) : kind === 'sp2dk' ? new Date(Date.parse(`${rec}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10) : null;
  if (!DATE_RE.test(rec) || (by && (!DATE_RE.test(by) || by < rec))) throw new TaxAuditError(422, 'receivedOn and respondBy are YYYY-MM-DD, respondBy on or after receivedOn.');
  try {
    const r = await outsideRequestScope(() => one<any>(`INSERT INTO tax_audit_case (org_id, kind, letter_no, tax_year, taxes, received_on, respond_by, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [orgId, kind, letter.slice(0, 80), year, taxes, rec, by, b.note ? String(b.note).slice(0, 2000) : null, userId]));
    return cView(await outsideRequestScope(() => one<any>(`${C_SELECT} WHERE c.id = $1`, [r.id])));
  } catch (e) {
    if ((e as any).code === '23505') throw new TaxAuditError(409, `Letter ${letter} is already recorded.`);
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------ files

export async function workbook(orgId: string, yearRaw: unknown): Promise<Buffer> {
  const e = await equalisation(orgId, yearRaw);
  const cs = (await cases(orgId)).filter((c) => c.taxYear === e.year);
  return xlsx([
    { name: 'Equalisation', rows: [['Month', 'Charging revenue', 'Retail DPP', 'Difference', 'Other DPP (fleet, notes, memberships)', 'Output PPN', 'Input PPN', 'Filed output', 'Filed input', 'Filed differs', 'PPN on bills', 'Faktur masukan', 'PPh withheld', 'Slips issued', 'Issues'],
      ...e.months.map((m) => [m.month, m.revenue, m.retailDpp, m.revenueDiff, m.otherDpp, m.outputPpn, m.inputPpn, m.filed?.output ?? null, m.filed?.input ?? null, m.filedDiffers ? 'yes' : '', m.billVat, m.inputRecorded, m.withheld, m.slips, m.issues]),
      ['Total', e.totals.revenue, null, null, null, e.totals.outputPpn, e.totals.inputPpn, null, null, null, null, null, e.totals.withheld, e.totals.slips, e.gaps.length]],
      widths: [9, 16, 16, 14, 18, 14, 14, 14, 14, 8, 14, 14, 14, 14, 7], formats: [null, 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money', null, 'money', 'money', 'money', 'money', null] },
    { name: 'Gaps', rows: [['Month', 'Kind', 'Reference', 'Detail', 'Amount'], ...e.gaps.map((g) => [g.month, g.kind, g.reference, g.detail, g.amount])], widths: [9, 14, 30, 80, 14], formats: [null, null, null, null, 'money'] },
    { name: 'Letters', rows: [['Kind', 'Letter', 'Year', 'Taxes', 'Received', 'Respond by', 'Status', 'Assessed'], ...cs.map((c) => [c.kind, c.letterNo, c.taxYear, c.taxes.join(', '), c.receivedOn, c.respondBy ?? '', c.status, c.assessed])],
      widths: [12, 26, 6, 20, 11, 11, 16, 16], formats: [null, null, null, null, null, null, null, 'money'] },
  ]);
}

const csvCell = (v: unknown) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };

export async function pack(orgId: string, yearRaw: unknown) {
  const e = await equalisation(orgId, yearRaw);
  const org = await outsideRequestScope(() => one<{ name: string; npwp: string | null }>(`SELECT name, npwp FROM organisation WHERE id = $1`, [orgId]));
  const wb = await workbook(orgId, e.year);
  const gaps = Buffer.from([['month', 'kind', 'reference', 'detail', 'amount'], ...e.gaps.map((g) => [g.month, g.kind, g.reference, g.detail, g.amount])].map((r) => r.map(csvCell).join(',')).join('\r\n'));
  const readme = Buffer.from([`Tax audit readiness pack ${e.year}: ${org?.name ?? ''}${org?.npwp ? ` (NPWP ${org.npwp})` : ''}`, '',
    `equalisation-${e.year}.xlsx  per month: charging revenue against PPN output (DPP), the return as filed against today's figures, input PPN on bills against faktur masukan, PPh withheld against bukti potong issued; the gaps; the tax office's letters`,
    `gaps-${e.year}.csv  each open item with its reference and amount`, 'manifest.json  each file with its SHA-256', '',
    `Readiness: ${e.readinessPct ?? '-'}% of the year's ended months have nothing open (${e.gaps.length} item(s)).`, `Prepared ${new Date().toISOString()} by PlugSure CSMS.`].join('\r\n'));
  const files = [{ name: `equalisation-${e.year}.xlsx`, data: wb }, { name: `gaps-${e.year}.csv`, data: gaps }, { name: 'README.txt', data: readme }];
  const manifest = Buffer.from(JSON.stringify({ year: e.year, organisation: org?.name ?? null, files: files.map((f) => ({ name: f.name, bytes: f.data.length, sha256: createHash('sha256').update(f.data).digest('hex') })) }, null, 2));
  return { year: e.year, body: zip([...files, { name: 'manifest.json', data: manifest }]), manifestSha256: createHash('sha256').update(manifest).digest('hex') };
}

/** Daily: open letters from 7 days before the respond-by date (critical once past). */
export async function sweep(now = new Date()): Promise<number> {
  const t = today(now);
  const rows = await outsideRequestScope(() => many<any>(`SELECT id, org_id, kind, letter_no, tax_year, to_char(respond_by, 'YYYY-MM-DD') AS by_s FROM tax_audit_case WHERE status = 'open' AND respond_by IS NOT NULL AND respond_by <= $1::date + 7`, [t]));
  let n = 0;
  for (const r of rows) {
    try {
      const left = days(t, r.by_s);
      await outsideRequestScope(() => persistAlert({ orgId: r.org_id, kind: DUE, severity: left < 0 ? 'critical' : 'warning', targetType: 'tax_audit_case', targetId: String(r.id),
        message: `${r.kind === 'sp2dk' ? 'SP2DK' : 'Tax audit letter'} ${r.letter_no} (${r.tax_year}): ${left < 0 ? `the reply was due on ${r.by_s}` : `reply by ${r.by_s} (${left} days)`}. Finance → Tax audit.` }));
      n++;
    } catch (e) { logger.warn({ case: r.id, err: (e as Error).message }, 'tax audit sweep failed'); }
  }
  return n;
}
