import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { xlsx } from './xlsx.js';

/**
 * Withholding on supplier bills and the slips (bukti potong) for e-Bupot (v1.32.0). What a bill withholds follows
 * the supplier's tax kind:
 *
 *   company      PPh 23   the supplier's rate (whtPct) × the subtotal (2% for most services)
 *   individual   PPh 21   not an employee (bukan pegawai, PMK 168/2023): the Pasal 17 rates on 50% of the gross, per
 *                         payment — 5% to 60 million, 15% to 250 million, 25% to 500 million, 30% to 5 billion, 35%
 *                         above; 20% more when the payee has neither an NPWP nor a NIK
 *   foreign      PPh 26   the treaty rate when one is recorded (with the payee's certificate of domicile), else 20% of
 *                         the gross
 *
 * The amount can still be typed on the bill. A month's slips are drafted from its approved bills (one per payee and
 * kind), issued with a number and a date, or voided with a reason; an issued slip is not changed by bills recorded
 * later (the draft says so). The month's slips export to an Excel workbook laid out for the e-Bupot (Coretax) import,
 * one sheet for PPh 21/26 and one for PPh 23. The tax calendar's PPh 21 obligations take their amounts from the slips.
 */

export class WithholdingError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const TAX_KINDS = ['company', 'individual', 'foreign'] as const;
export const SLIP_KINDS = ['pph21', 'pph23', 'pph26'] as const;
export type SlipKind = typeof SLIP_KINDS[number];
export const KIND_OF: Record<string, SlipKind> = { company: 'pph23', individual: 'pph21', foreign: 'pph26' };
export const LABEL: Record<SlipKind, string> = { pph21: 'PPh 21', pph23: 'PPh 23', pph26: 'PPh 26' };

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);

/** The Pasal 17 bands (UU HPP): up to the amount, the rate. */
export const PASAL17: Array<[number, number]> = [[60_000_000, 5], [250_000_000, 15], [500_000_000, 25], [5_000_000_000, 30], [Infinity, 35]];

/** Pasal 17 tax on a base (whole rupiah). */
export function pasal17(base: number): number {
  let tax = 0, lower = 0;
  for (const [upper, rate] of PASAL17) {
    if (base <= lower) break;
    tax += ((Math.min(base, upper) - lower) * rate) / 100;
    lower = upper;
  }
  return Math.round(tax);
}

/** PPh 21 on a payment to an individual who is not an employee: Pasal 17 on 50% of the gross; +20% without an NPWP or NIK. */
export function pph21(gross: number, hasTaxId: boolean): { dpp: number; tax: number; ratePct: number } {
  const dpp = Math.round(gross / 2);
  const tax = Math.round(pasal17(dpp) * (hasTaxId ? 1 : 1.2));
  return { dpp, tax, ratePct: gross ? Math.round((tax / gross) * 100_000) / 1000 : 0 };
}

/** What a bill of `subtotal` to this supplier withholds by default. */
export function withholdingFor(sup: { tax_kind?: string | null; wht_pct?: unknown; tax_id?: string | null; id_number?: string | null; treaty_rate_pct?: unknown }, subtotal: number) {
  const kind = KIND_OF[sup.tax_kind ?? 'company'] ?? 'pph23';
  if (kind === 'pph21') {
    const p = pph21(subtotal, Boolean(sup.tax_id || sup.id_number));
    return { kind, label: LABEL[kind], ...p };
  }
  const rate = kind === 'pph26' ? (sup.treaty_rate_pct == null ? 20 : Number(sup.treaty_rate_pct)) : Number(sup.wht_pct ?? 0);
  return { kind, label: LABEL[kind], dpp: subtotal, tax: Math.round((subtotal * rate) / 100), ratePct: rate };
}

// ─────────────────────────────────────────── slips

const slipView = (r: any) => ({
  id: String(r.id), month: r.month, kind: r.kind as SlipKind, label: LABEL[r.kind as SlipKind], supplierId: String(r.supplier_id), supplier: r.supplier_name,
  taxId: r.tax_id ?? null, idNumber: r.id_number ?? null, country: r.country ?? null, currency: r.currency,
  gross: Number(r.gross_minor), dpp: Number(r.dpp_minor), ratePct: Number(r.rate_pct), tax: Number(r.tax_minor),
  billIds: (r.bill_ids ?? []).map(String), status: r.status, number: r.number ?? null, issuedOn: r.issued_on_s ?? null, issuedBy: r.issued_by_name ?? null, voidReason: r.void_reason ?? null,
});
const SLIP_SELECT = `SELECT t.*, to_char(t.issued_on, 'YYYY-MM-DD') AS issued_on_s, s.name AS supplier_name, s.tax_id, s.id_number, s.country, u.name AS issued_by_name
  FROM tax_slip t JOIN supplier s ON s.id = t.supplier_id LEFT JOIN app_user u ON u.id = t.issued_by`;

/** The month's bills that withheld something, by payee and kind. */
async function billsOf(orgId: string, month: string) {
  return outsideRequestScope(() => many<any>(
    `SELECT b.id, b.supplier_id, b.wht_kind, b.currency, b.subtotal_minor, b.wht_minor FROM supplier_bill b
      WHERE b.org_id = $1 AND b.status IN ('approved', 'paid') AND b.wht_minor > 0 AND to_char(b.bill_date, 'YYYY-MM') = $2 ORDER BY b.id`, [orgId, month]));
}

function group(bills: any[]) {
  const by = new Map<string, { supplierId: string; kind: SlipKind; currency: string; gross: number; tax: number; billIds: string[] }>();
  for (const b of bills) {
    const k = `${b.supplier_id}|${b.wht_kind}|${b.currency}`;
    const g = by.get(k) ?? { supplierId: String(b.supplier_id), kind: b.wht_kind as SlipKind, currency: b.currency, gross: 0, tax: 0, billIds: [] as string[] };
    g.gross += Number(b.subtotal_minor); g.tax += Number(b.wht_minor); g.billIds.push(String(b.id));
    by.set(k, g);
  }
  return [...by.values()];
}
const dppOf = (kind: SlipKind, gross: number) => (kind === 'pph21' ? Math.round(gross / 2) : gross);
const rateOf = (tax: number, base: number) => (base ? Math.round((tax / base) * 100_000) / 1000 : 0);

export async function slips(orgId: string, monthRaw: unknown) {
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month)) throw new WithholdingError(422, 'month is YYYY-MM.');
  const rows = await outsideRequestScope(() => many<any>(`${SLIP_SELECT} WHERE t.org_id = $1 AND t.month = $2 ORDER BY t.kind, lower(s.name), t.id`, [orgId, month]));
  const live = rows.filter((r) => r.status !== 'void');
  // Bills not on a live slip (recorded after it was issued, or not drafted yet).
  const onSlip = new Set(live.flatMap((r) => (r.bill_ids ?? []).map(String)));
  const pending = (await billsOf(orgId, month)).filter((b) => !onSlip.has(String(b.id)));
  const totals: Record<string, { count: number; gross: number; tax: number }> = {};
  for (const r of live) {
    const t = (totals[r.kind] ??= { count: 0, gross: 0, tax: 0 });
    t.count++; t.gross += Number(r.gross_minor); t.tax += Number(r.tax_minor);
  }
  return { month, slips: rows.map(slipView), totals, billsNotOnSlip: pending.length };
}

/** Draft (or refresh) the month's slips from its bills: drafts follow the bills; issued slips stay as issued. */
export async function draft(orgId: string, monthRaw: unknown) {
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month)) throw new WithholdingError(422, 'month is YYYY-MM.');
  const groups = group(await billsOf(orgId, month));
  const existing = await outsideRequestScope(() => many<any>(`SELECT * FROM tax_slip WHERE org_id = $1 AND month = $2 AND status <> 'void'`, [orgId, month]));
  let created = 0, updated = 0, issuedChanged = 0;
  const seen = new Set<string>();
  for (const g of groups) {
    const ex = existing.find((e) => String(e.supplier_id) === g.supplierId && e.kind === g.kind);
    const dpp = dppOf(g.kind, g.gross);
    if (ex) {
      seen.add(String(ex.id));
      const same = Number(ex.gross_minor) === g.gross && Number(ex.tax_minor) === g.tax;
      if (ex.status === 'issued') { if (!same) issuedChanged++; continue; }
      if (same && (ex.bill_ids ?? []).length === g.billIds.length) continue;
      await outsideRequestScope(() => query(`UPDATE tax_slip SET gross_minor = $2, dpp_minor = $3, tax_minor = $4, rate_pct = $5, bill_ids = $6::bigint[], currency = $7 WHERE id = $1`,
        [ex.id, g.gross, dpp, g.tax, rateOf(g.tax, dpp), g.billIds, g.currency]));
      updated++;
      continue;
    }
    await outsideRequestScope(() => query(
      `INSERT INTO tax_slip (org_id, month, kind, supplier_id, currency, gross_minor, dpp_minor, rate_pct, tax_minor, bill_ids) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint[])`,
      [orgId, month, g.kind, g.supplierId, g.currency, g.gross, dpp, rateOf(g.tax, dpp), g.tax, g.billIds]));
    created++;
  }
  // A draft whose bills are gone (voided, or moved to another month) is voided.
  let dropped = 0;
  for (const e of existing) if (!seen.has(String(e.id)) && e.status === 'draft') {
    await outsideRequestScope(() => query(`UPDATE tax_slip SET status = 'void', void_reason = 'No bill withholds for it any more' WHERE id = $1`, [e.id]));
    dropped++;
  }
  return { ...(await slips(orgId, month)), created, updated, dropped, issuedChanged };
}

async function slipRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new WithholdingError(404, 'No such slip.');
  const r = await outsideRequestScope(() => one<any>(`${SLIP_SELECT} WHERE t.id = $1 AND t.org_id = $2`, [id, orgId]));
  if (!r) throw new WithholdingError(404, 'No such slip.');
  return r;
}

/** Issue a slip: its number (BP-<kind>-YYYYMM-NNNN unless the one from Coretax is given) and date. */
export async function issue(orgId: string, id: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const r = await slipRow(orgId, id);
  if (r.status !== 'draft') throw new WithholdingError(409, `The slip is ${r.status}.`);
  const issuedOn = b.issuedOn == null || b.issuedOn === '' ? today(now) : String(b.issuedOn);
  if (!DATE_RE.test(issuedOn) || issuedOn.slice(0, 7) < r.month) throw new WithholdingError(422, 'issuedOn is YYYY-MM-DD, not before the slip\'s month.');
  let number = b.number == null || b.number === '' ? null : String(b.number).trim().slice(0, 40);
  if (!number) {
    const n = await outsideRequestScope(() => one<{ n: string }>(`SELECT count(*) AS n FROM tax_slip WHERE org_id = $1 AND month = $2 AND kind = $3 AND number IS NOT NULL`, [orgId, r.month, r.kind]));
    number = `BP-${r.kind.toUpperCase()}-${r.month.replace('-', '')}-${String(Number(n?.n ?? 0) + 1).padStart(4, '0')}`;
  }
  const won = await outsideRequestScope(() => one(`UPDATE tax_slip SET status = 'issued', number = $3, issued_on = $4, issued_by = $5 WHERE id = $1 AND org_id = $2 AND status = 'draft' RETURNING id`,
    [id, orgId, number, issuedOn, userId]));
  if (!won) throw new WithholdingError(409, 'Someone changed the slip at the same time. Reload.');
  return slipView(await slipRow(orgId, id));
}

export async function voidSlip(orgId: string, id: string, reasonRaw: unknown) {
  const r = await slipRow(orgId, id);
  if (r.status === 'void') throw new WithholdingError(409, 'The slip is already void.');
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3) throw new WithholdingError(422, 'Give a reason (at least 3 characters).');
  await outsideRequestScope(() => query(`UPDATE tax_slip SET status = 'void', void_reason = $3 WHERE id = $1 AND org_id = $2`, [id, orgId, reason.slice(0, 300)]));
  return slipView(await slipRow(orgId, id));
}

/** The month's live slips for the e-Bupot import: PPh 21/26 on one sheet, PPh 23 on the other. */
export async function ebupotXlsx(orgId: string, monthRaw: unknown): Promise<Buffer> {
  const s = await slips(orgId, monthRaw);
  const live = s.slips.filter((x) => x.status !== 'void');
  const [y, m] = s.month.split('-');
  const head = ['Masa pajak', 'Tahun pajak', 'Status', 'Nomor bukti potong', 'Tanggal', 'Jenis', 'NPWP', 'NIK', 'Nama', 'Negara', 'Kode objek pajak', 'Penghasilan bruto', 'DPP', 'Tarif %', 'PPh dipotong'];
  const row = (x: typeof live[number]) => [Number(m), Number(y), x.status === 'issued' ? 'Issued' : 'Draft', x.number, x.issuedOn, x.label, x.taxId, x.idNumber, x.supplier, x.country ?? 'ID', '', x.gross, x.dpp, x.ratePct, x.tax];
  const widths = [8, 8, 8, 22, 12, 8, 22, 18, 30, 8, 14, 16, 16, 8, 16];
  const formats = [null, null, null, null, null, null, null, null, null, null, null, 'money', 'money', null, 'money'] as Array<'money' | null>;
  return xlsx([
    { name: 'PPh 21 dan 26', rows: [head, ...live.filter((x) => x.kind !== 'pph23').map(row)], widths, formats },
    { name: 'PPh 23', rows: [head, ...live.filter((x) => x.kind === 'pph23').map(row)], widths, formats },
  ]);
}

/** For the tax calendar: each period's PPh 21 and 26 on live slips (amount, count). */
export async function periodTotals(orgId: string, periods: string[]) {
  const rows = await outsideRequestScope(() => many<{ month: string; kind: string; amount: string; n: number; drafts: number }>(
    `SELECT month, kind, COALESCE(sum(tax_minor), 0)::bigint AS amount, count(*)::int AS n, count(*) FILTER (WHERE status = 'draft')::int AS drafts
       FROM tax_slip WHERE org_id = $1 AND status <> 'void' AND month = ANY($2::text[]) GROUP BY 1, 2`, [orgId, periods]));
  return rows.map((r) => ({ month: r.month, kind: r.kind as SlipKind, amount: Number(r.amount), count: r.n, drafts: r.drafts }));
}
