import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { LEGACY_CURRENCY } from '../domain/money.js';
import { efakturXml, fakturDate, normaliseNpwp, nitkuFor, buyerProblem, type EfakturInvoice, type EfakturSettings } from './efaktur.js';

/**
 * Withholding tax and platform e-Faktur (v1.18.0), Indonesia:
 *
 *   PPh 23   an operator that is a tax withholder withholds 2% income tax on services it pays for, and gives the payee
 *            a bukti potong:
 *              gateway_fee    on the payment gateway's fees (Xendit's or Duitku's): the base is the month's fees,
 *                             excluding VAT, from Finance's ledger of the operator's own gateway accounts;
 *              platform_fee   on PlugSure's platform fee: the base is the statement's fee before tax (net_minor).
 *            Finance suggests each month's base and 2%; the operator records what it withheld, with the bukti potong's
 *            number and date once issued (or voids a mistaken record). Platform administrators see the withholdings
 *            operators recorded on PlugSure's fee (the bukti potong PlugSure should receive).
 *   e-Faktur PlugSure's platform-fee statements to operators (commission_statement with no owner) as Coretax's import
 *            XML, like fleet invoices (services/efaktur.ts): PlugSure (BILLING_ISSUER_NPWP) the seller, the operator
 *            the buyer, PPN on DPP nilai lain. For platform administrators.
 *
 * The tax treatment is the operator's and its adviser's: Finance prepares the figures, it files nothing.
 */

export class WithholdingError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const DEFAULT_RATE_BPS = 200;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const ymd = (d: Date | string | null) => (d ? (typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)) : null);

/** A year's PPh 23: per month and kind, the suggested base and 2%, and what was recorded. */
export async function pph23(orgId: string, platformAdmin: boolean, year: number) {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new WithholdingError(400, 'year is YYYY.');
  const zone = config.billing.timeZone;
  const [fees, stmts, recorded, received] = await outsideRequestScope(() => Promise.all([
    // The gateway's fees on the operator's own accounts (excluding VAT), by month and account.
    many<any>(
      `SELECT to_char((g.gateway_created_at AT TIME ZONE $3), 'YYYY-MM') AS period, g.integration_id, i.provider, round(sum(g.fee))::bigint AS base
         FROM gateway_transaction g JOIN integration i ON i.id = g.integration_id
        WHERE g.org_id = $1 AND g.status = 'success' AND g.currency = $4
          AND (g.gateway_created_at AT TIME ZONE $3) >= make_date($2, 1, 1) AND (g.gateway_created_at AT TIME ZONE $3) < make_date($2 + 1, 1, 1)
        GROUP BY 1, 2, 3 HAVING sum(g.fee) > 0 ORDER BY 1`, [orgId, year, zone, LEGACY_CURRENCY]),
    // PlugSure's statements to the operator (no owner), by month.
    many<any>(
      `SELECT to_char(period, 'YYYY-MM') AS period, id, number, net_minor FROM commission_statement
        WHERE org_id = $1 AND owner_id IS NULL AND finalised_at IS NOT NULL AND currency = $3 AND extract(year FROM period) = $2 AND net_minor > 0 ORDER BY period`,
      [orgId, year, LEGACY_CURRENCY]),
    many<any>(`SELECT w.*, u.name AS recorded_by_name FROM tax_withholding w LEFT JOIN app_user u ON u.id = w.recorded_by
                WHERE w.org_id = $1 AND w.period LIKE $2 || '-%' ORDER BY w.period, w.id`, [orgId, String(year)]),
    platformAdmin ? many<any>(`SELECT w.*, o.name AS operator FROM tax_withholding w JOIN organisation o ON o.id = w.org_id
                                WHERE w.kind = 'platform_fee' AND w.voided_at IS NULL AND w.period LIKE $1 || '-%' ORDER BY w.period, o.name`, [String(year)]) : Promise.resolve([]),
  ]));
  const view = (w: any) => ({
    id: String(w.id), kind: w.kind, period: w.period, counterparty: w.counterparty, counterpartyNpwp: w.counterparty_npwp, integrationId: w.integration_id, statementId: w.statement_id,
    base: Number(w.base_minor), rateBps: w.rate_bps, amount: Number(w.amount_minor), buktiNumber: w.bukti_number, buktiDate: ymd(w.bukti_date), note: w.note,
    recordedBy: w.recorded_by_name ?? null, recordedAt: iso(w.created_at), voided: Boolean(w.voided_at), voidReason: w.void_reason,
  });
  const live = recorded.filter((w) => !w.voided_at);
  const suggestions = [
    ...fees.map((f) => ({ kind: 'gateway_fee' as const, period: f.period, counterparty: f.provider === 'xendit' ? 'PT Sinar Digital Terdepan (Xendit)' : f.provider === 'duitku' ? 'PT Duitku Teknologi Indonesia' : f.provider,
      integrationId: f.integration_id, statementId: null as string | null, number: null as string | null, base: Number(f.base) })),
    ...stmts.map((s) => ({ kind: 'platform_fee' as const, period: s.period, counterparty: config.billing.issuerName, integrationId: null as string | null, statementId: s.id as string, number: s.number as string, base: Number(s.net_minor) })),
  ].map((s) => {
    const rec = live.filter((w) => w.kind === s.kind && w.period === s.period && (s.statementId ? w.statement_id === s.statementId : w.integration_id === s.integrationId));
    const withheld = rec.reduce((a, w) => a + Number(w.amount_minor), 0);
    return { ...s, rateBps: DEFAULT_RATE_BPS, suggested: Math.round((s.base * DEFAULT_RATE_BPS) / 10_000), withheld, recorded: rec.length, buktiMissing: rec.some((w) => !w.bukti_number) };
  });
  return { year, suggestions, recorded: recorded.map(view), received: received.map((w) => ({ ...view(w), operator: w.operator })) };
}

/** Record a withholding (validated; the amount defaults to the base × rate). */
export async function record(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const kind = String(b.kind ?? '');
  if (!['gateway_fee', 'platform_fee'].includes(kind)) throw new WithholdingError(422, 'kind is gateway_fee or platform_fee.');
  const period = String(b.period ?? '');
  if (!PERIOD_RE.test(period)) throw new WithholdingError(422, 'period is YYYY-MM.');
  const counterparty = String(b.counterparty ?? '').trim();
  if (!counterparty || counterparty.length > 160) throw new WithholdingError(422, 'The counterparty (the payee) is 1 to 160 characters.');
  const npwp = b.counterpartyNpwp == null || b.counterpartyNpwp === '' ? null : normaliseNpwp(String(b.counterpartyNpwp));
  if (b.counterpartyNpwp && !npwp) throw new WithholdingError(422, 'The counterparty\'s NPWP is 15 or 16 digits.');
  const base = Number(b.base), rate = b.rateBps == null ? DEFAULT_RATE_BPS : Number(b.rateBps);
  if (!Number.isInteger(base) || base < 0) throw new WithholdingError(422, 'The base is a whole number of rupiah, zero or more.');
  if (!Number.isInteger(rate) || rate < 0 || rate > 10_000) throw new WithholdingError(422, 'The rate is in basis points (200 = 2%).');
  const amount = b.amount == null ? Math.round((base * rate) / 10_000) : Number(b.amount);
  if (!Number.isInteger(amount) || amount < 0) throw new WithholdingError(422, 'The amount withheld is a whole number of rupiah.');
  const bukti = b.buktiNumber == null ? null : String(b.buktiNumber).trim().slice(0, 60) || null;
  const buktiDate = b.buktiDate == null || b.buktiDate === '' ? null : String(b.buktiDate);
  if (buktiDate && !/^\d{4}-\d{2}-\d{2}$/.test(buktiDate)) throw new WithholdingError(422, 'The bukti potong date is YYYY-MM-DD.');
  let integrationId: string | null = null, statementId: string | null = null;
  if (kind === 'gateway_fee' && b.integrationId) {
    const i = await outsideRequestScope(() => one<{ id: string }>(`SELECT id FROM integration WHERE id = $1 AND org_id = $2`, [String(b.integrationId), orgId]).catch(() => null));
    if (!i) throw new WithholdingError(422, 'That gateway account is not your organisation\'s.');
    integrationId = i.id;
  }
  if (kind === 'platform_fee' && b.statementId) {
    const s = await outsideRequestScope(() => one<{ id: string }>(`SELECT id FROM commission_statement WHERE id = $1 AND org_id = $2 AND owner_id IS NULL`, [String(b.statementId), orgId]).catch(() => null));
    if (!s) throw new WithholdingError(422, 'That statement is not one of PlugSure\'s statements to your organisation.');
    statementId = s.id;
  }
  const r = await one<{ id: string }>(
    `INSERT INTO tax_withholding (org_id, kind, period, counterparty, counterparty_npwp, integration_id, statement_id, base_minor, rate_bps, amount_minor, bukti_number, bukti_date, note, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [orgId, kind, period, counterparty, npwp, integrationId, statementId, base, rate, amount, bukti, buktiDate, b.note == null ? null : String(b.note).slice(0, 300), userId]);
  return { id: String(r!.id), amount };
}

/** Add the bukti potong to a record, once issued. */
export async function setBukti(orgId: string, id: string, b: Record<string, unknown>) {
  if (!/^\d{1,18}$/.test(id)) throw new WithholdingError(404, 'No such record.');
  const n = String(b.buktiNumber ?? '').trim();
  const d = String(b.buktiDate ?? '');
  if (!n || n.length > 60) throw new WithholdingError(422, 'The bukti potong number is 1 to 60 characters.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new WithholdingError(422, 'The bukti potong date is YYYY-MM-DD.');
  const r = await one(`UPDATE tax_withholding SET bukti_number = $3, bukti_date = $4 WHERE id = $1 AND org_id = $2 AND voided_at IS NULL RETURNING id`, [id, orgId, n, d]);
  if (!r) throw new WithholdingError(404, 'No such record.');
  return { ok: true };
}

export async function voidRecord(orgId: string, id: string, reasonRaw: unknown, userId: string | null) {
  if (!/^\d{1,18}$/.test(id)) throw new WithholdingError(404, 'No such record.');
  const reason = String(reasonRaw ?? '').trim();
  if (!reason || reason.length > 300) throw new WithholdingError(422, 'Say why the record is voided (up to 300 characters).');
  const r = await one(`UPDATE tax_withholding SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE id = $1 AND org_id = $2 AND voided_at IS NULL RETURNING id`, [id, orgId, userId, reason]);
  if (!r) throw new WithholdingError(404, 'No such record, or already voided.');
  return { ok: true };
}

/** PPh 23 as CSV (the year's records), for the operator's tax adviser. */
export function pph23Csv(y: Awaited<ReturnType<typeof pph23>>): string {
  const cell = (v: unknown) => { const s = v == null ? '' : String(v); const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s; return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
  const head = ['Period', 'Kind', 'Counterparty', 'NPWP', 'Base', 'Rate %', 'Withheld', 'Bukti potong', 'Bukti date', 'Status', 'Note'];
  const rows = y.recorded.map((w) => [w.period, w.kind === 'gateway_fee' ? 'Gateway fees' : 'PlugSure platform fee', w.counterparty, w.counterpartyNpwp ?? '', w.base, w.rateBps / 100, w.amount, w.buktiNumber ?? '', w.buktiDate ?? '', w.voided ? `voided: ${w.voidReason}` : 'recorded', w.note ?? '']);
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** (Platform administrators) PlugSure's platform-fee statements of a month as Coretax's e-Faktur import XML. */
export async function platformEfaktur(period: string, s: Partial<EfakturSettings>) {
  if (!PERIOD_RE.test(period)) throw new WithholdingError(422, 'period is YYYY-MM.');
  const npwp = normaliseNpwp(config.billing.issuerNpwp);
  if (!npwp) throw new WithholdingError(409, 'Set BILLING_ISSUER_NPWP (PlugSure\'s 16-digit NPWP) on the API first.');
  if (s.itemOpt !== 'A' && s.itemOpt !== 'B') throw new WithholdingError(422, 'itemOpt is A (goods) or B (services).');
  if (!/^\d{6}$/.test(String(s.itemCode ?? ''))) throw new WithholdingError(422, 'itemCode is the 6-digit e-Faktur goods/service code.');
  if (!/^UM\.\d{4}$/.test(String(s.unitCode ?? ''))) throw new WithholdingError(422, 'unitCode is the Coretax unit-of-measure code (UM.nnnn).');
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT s.number, s.net_minor, s.tax_minor, s.data, o.name, o.npwp, o.pkp FROM commission_statement s JOIN organisation o ON o.id = s.org_id
      WHERE s.owner_id IS NULL AND s.finalised_at IS NOT NULL AND s.currency = $2 AND s.period = ($1 || '-01')::date AND s.tax_minor > 0 ORDER BY s.number`, [period, LEGACY_CURRENCY]));
  const invoices: EfakturInvoice[] = [];
  const skipped: Array<{ number: string; reason: string }> = [];
  for (const r of rows) {
    const t = r.data?.totals ?? {};
    const buyerNpwp = normaliseNpwp(r.npwp);
    const buyer = { taxId: buyerNpwp, kind: 'TIN' as const, nitku: nitkuFor(buyerNpwp, null), name: r.name, address: null, email: null };
    const bp = buyerProblem(buyer);
    if (bp) { skipped.push({ number: r.number, reason: `${r.name} has ${bp}` }); continue; }
    invoices.push({
      number: r.number, date: fakturDate(period), buyer,
      lines: [{ name: `Biaya platform PlugSure — ${period}`, taxableMinor: Number(r.net_minor), taxBaseMinor: Number(t.taxBaseMinor ?? Math.round((Number(r.net_minor) * config.tax.id.ppnDppNumerator) / config.tax.id.ppnDppDenominator)), taxMinor: Number(r.tax_minor) }],
    });
  }
  if (!invoices.length) throw new WithholdingError(409, skipped.length ? `No statement can carry a faktur: ${skipped.map((x) => `${x.number} (${x.reason})`).join('; ')}` : 'No finalised platform statements with PPN for this month.');
  const xml = efakturXml({ npwp, nitku: null }, invoices, { itemOpt: s.itemOpt, itemCode: String(s.itemCode), unitCode: String(s.unitCode) }, config.tax.id.ppnRateBps / 100);
  return { xml, included: invoices.map((i) => i.number), skipped };
}
