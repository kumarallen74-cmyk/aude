import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { LEGACY_CURRENCY } from '../domain/money.js';
import { xlsx } from './xlsx.js';

/**
 * PPN (Indonesian VAT) for a tax period — the working papers of the monthly return, SPT Masa PPN (v1.26.0).
 * Amounts are rupiah, from the records with the Indonesian tax scheme; other currencies have no PPN here.
 *
 *   output tax (PPN keluaran)
 *     retail charging      charge records issued in the month, sessions not billed on a fleet invoice
 *     fleet invoices       issued in the month (not void), with their e-Faktur numbers; less credit notes issued
 *     subscriptions        membership and pass charges paid in the month (not billed on a fleet invoice)
 *   input tax (PPN masukan)
 *     input invoices       faktur pajak masukan recorded for the period, creditable ones counted
 *     suggestions          VAT on gateway fees and on PlugSure's fee statement for the month: shown with what to
 *                          record, counted only once recorded (with the supplier's faktur number)
 *
 *   net = output − input − overpayment brought forward (the last filed period's carried forward)
 *   net > 0: payable (kurang bayar, due by the end of the next month); net < 0: carried forward (lebih bayar)
 *
 * Filing records the figures as filed with the NTPN of the payment; a filed period can be amended while no later
 * period is filed. An organisation that is not a PKP charges no PPN: the papers say so.
 */

export class PpnError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const zone = () => config.billing.timeZone;
const localDay = (t: Date | number = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(new Date(t));
const IDR = LEGACY_CURRENCY;
const SCHEME = 'ID_PPN_PBJT';
const npwpDigits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

export function lastMonth(now = new Date()): string {
  let [y, m] = localDay(now).slice(0, 7).split('-').map(Number) as [number, number];
  m--; if (m === 0) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
function monthOf(raw: unknown): string {
  const m = raw == null || raw === '' ? lastMonth() : String(raw);
  if (!MONTH_RE.test(m)) throw new PpnError(422, 'month is YYYY-MM.');
  return m;
}
const nextMonth = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
const lastDayOf = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };

async function outputOf(orgId: string, month: string) {
  const z = zone();
  const [retail, fleet, notes, subs] = await Promise.all([
    outsideRequestScope(() => one<any>(
      `SELECT count(*)::int AS n, COALESCE(sum(d.tax_base_minor), 0)::bigint AS dpp, COALESCE(sum(d.tax_minor), 0)::bigint AS ppn
         FROM cdr d WHERE d.org_id = $1 AND d.currency = $3 AND d.tax_scheme = $4 AND NOT COALESCE(d.test_mode, false)
          AND to_char(d.issued_at AT TIME ZONE $5, 'YYYY-MM') = $2
          AND NOT EXISTS (SELECT 1 FROM fleet_invoice_item it JOIN fleet_invoice i ON i.id = it.invoice_id
                           WHERE it.kind = 'session' AND it.ref_id = d.session_id AND i.status IN ('issued', 'paid'))`, [orgId, month, IDR, SCHEME, z])),
    outsideRequestScope(() => many<any>(
      `SELECT i.number, i.efaktur_number, to_char(i.issued_at AT TIME ZONE $4, 'YYYY-MM-DD') AS d, i.tax_base_minor, i.tax_minor, a.name, a.tax_id
         FROM fleet_invoice i JOIN fleet_account a ON a.id = i.fleet_account_id
        WHERE i.org_id = $1 AND i.currency = $3 AND i.status IN ('issued', 'paid') AND to_char(i.issued_at AT TIME ZONE $4, 'YYYY-MM') = $2 ORDER BY i.issued_at`, [orgId, month, IDR, z])),
    outsideRequestScope(() => many<any>(
      `SELECT c.number, to_char(c.issued_at AT TIME ZONE $4, 'YYYY-MM-DD') AS d, c.tax_base_minor, c.tax_minor, i.number AS invoice, i.efaktur_number
         FROM fleet_credit_note c LEFT JOIN fleet_invoice i ON i.id = c.invoice_id
        WHERE c.org_id = $1 AND c.currency = $3 AND c.status = 'issued' AND to_char(c.issued_at AT TIME ZONE $4, 'YYYY-MM') = $2 ORDER BY c.issued_at`, [orgId, month, IDR, z])),
    outsideRequestScope(() => one<any>(
      `SELECT count(*)::int AS n, COALESCE(sum(tax_base_minor), 0)::bigint AS dpp, COALESCE(sum(tax_minor), 0)::bigint AS ppn
         FROM subscription_charge WHERE org_id = $1 AND currency = $3 AND state = 'paid' AND fleet_invoice_id IS NULL AND NOT COALESCE(test_mode, false)
          AND to_char(paid_at AT TIME ZONE $4, 'YYYY-MM') = $2`, [orgId, month, IDR, z])),
  ]);
  const fleetDpp = fleet.reduce((a, r) => a + Number(r.tax_base_minor), 0), fleetPpn = fleet.reduce((a, r) => a + Number(r.tax_minor), 0);
  const cnDpp = notes.reduce((a, r) => a + Number(r.tax_base_minor), 0), cnPpn = notes.reduce((a, r) => a + Number(r.tax_minor), 0);
  const lines = [
    { key: 'retail', label: 'Retail charging (charge records)', count: retail.n, dpp: Number(retail.dpp), ppn: Number(retail.ppn) },
    { key: 'fleet', label: 'Fleet invoices', count: fleet.length, dpp: fleetDpp, ppn: fleetPpn },
    { key: 'credit_notes', label: 'Fleet credit notes', count: notes.length, dpp: -cnDpp, ppn: -cnPpn },
    { key: 'subscriptions', label: 'Memberships and passes', count: subs.n, dpp: Number(subs.dpp), ppn: Number(subs.ppn) },
  ];
  return {
    lines, dpp: lines.reduce((a, l) => a + l.dpp, 0), ppn: lines.reduce((a, l) => a + l.ppn, 0),
    invoices: fleet.map((r) => ({ number: r.number, efaktur: r.efaktur_number ?? null, date: r.d, buyer: r.name, buyerNpwp: r.tax_id ?? null, dpp: Number(r.tax_base_minor), ppn: Number(r.tax_minor) })),
    creditNotes: notes.map((r) => ({ number: r.number, date: r.d, invoice: r.invoice ?? null, efaktur: r.efaktur_number ?? null, dpp: Number(r.tax_base_minor), ppn: Number(r.tax_minor) })),
  };
}

async function inputOf(orgId: string, month: string) {
  const z = zone();
  const [rows, gw, fee] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT p.*, to_char(p.faktur_date, 'YYYY-MM-DD') AS d, u.name AS by_name FROM ppn_input_invoice p LEFT JOIN app_user u ON u.id = p.recorded_by
        WHERE p.org_id = $1 AND p.month = $2 AND p.voided_at IS NULL ORDER BY p.faktur_date, p.id`, [orgId, month])),
    outsideRequestScope(() => one<any>(
      `SELECT COALESCE(round(sum(g.vat)), 0)::bigint AS vat, COALESCE(round(sum(g.fee)), 0)::bigint AS fee, count(*)::int AS n
         FROM gateway_transaction g WHERE g.org_id = $1 AND g.currency = $3 AND g.status = 'success' AND g.vat > 0
          AND to_char(g.gateway_created_at AT TIME ZONE $4, 'YYYY-MM') = $2`, [orgId, month, IDR, z])),
    outsideRequestScope(() => many<any>(
      `SELECT number, net_minor, tax_minor FROM commission_statement WHERE org_id = $1 AND owner_id IS NULL AND finalised_at IS NOT NULL AND currency = $3
          AND to_char(period, 'YYYY-MM') = $2 AND tax_minor > 0`, [orgId, month, IDR])),
  ]);
  const invoices = rows.map((r) => ({
    id: String(r.id), supplier: r.supplier, supplierNpwp: r.supplier_npwp ?? null, faktur: r.faktur_number, date: r.d, dpp: Number(r.dpp_minor), ppn: Number(r.ppn_minor),
    description: r.description ?? null, creditable: r.creditable, recordedBy: r.by_name ?? null,
  }));
  const recorded = new Set(invoices.map((i) => i.description ?? ''));
  const suggestions = [
    ...(Number(gw.vat) > 0 ? [{ key: `gateway:${month}`, supplier: 'Payment gateway (Xendit / Duitku)', description: `VAT on gateway fees ${month}`, dpp: Number(gw.fee), ppn: Number(gw.vat), note: `${gw.n} payments. Record it with the gateway's monthly faktur pajak.` }] : []),
    ...fee.map((s) => ({ key: `plugsure:${s.number}`, supplier: 'PlugSure', description: `PlugSure fees ${month} (${s.number})`, dpp: Number(s.net_minor), ppn: Number(s.tax_minor), note: 'Record it with PlugSure\'s faktur pajak for the statement.' })),
  ].filter((x) => !recorded.has(x.description));
  const creditable = invoices.filter((i) => i.creditable);
  return { invoices, suggestions, dpp: creditable.reduce((a, i) => a + i.dpp, 0), ppn: creditable.reduce((a, i) => a + i.ppn, 0) };
}

export async function period(orgId: string, monthRaw?: unknown) {
  const month = monthOf(monthRaw);
  const [org, out, inp, filed, prev, later] = await Promise.all([
    outsideRequestScope(() => one<any>(`SELECT name, npwp, pkp FROM organisation WHERE id = $1`, [orgId])),
    outputOf(orgId, month), inputOf(orgId, month),
    outsideRequestScope(() => one<any>(`SELECT f.*, u.name AS by_name FROM ppn_period f LEFT JOIN app_user u ON u.id = f.filed_by WHERE f.org_id = $1 AND f.month = $2`, [orgId, month])),
    outsideRequestScope(() => one<any>(`SELECT month, carried_forward_minor FROM ppn_period WHERE org_id = $1 AND month < $2 ORDER BY month DESC LIMIT 1`, [orgId, month])),
    outsideRequestScope(() => one<any>(`SELECT month FROM ppn_period WHERE org_id = $1 AND month > $2 ORDER BY month LIMIT 1`, [orgId, month])),
  ]);
  const broughtForward = Number(prev?.carried_forward_minor ?? 0);
  const net = out.ppn - inp.ppn - broughtForward;
  const due = lastDayOf(nextMonth(month));
  return {
    month, ended: month < localDay().slice(0, 7), pkp: org?.pkp === true, npwp: org?.npwp ?? null, organisation: org?.name ?? null,
    output: out, input: inp, broughtForward, broughtFrom: prev?.month ?? null,
    net, payable: Math.max(0, net), carriedForward: Math.max(0, -net), paymentDue: due, filingDue: due,
    missingEfaktur: out.invoices.filter((i) => !i.efaktur && i.ppn > 0).length,
    filed: filed ? {
      at: new Date(filed.filed_at).toISOString(), by: filed.by_name ?? null, ntpn: filed.ntpn ?? null, reference: filed.reference ?? null,
      output: Number(filed.output_minor), input: Number(filed.input_minor), payable: Number(filed.payable_minor), carriedForward: Number(filed.carried_forward_minor),
      differs: Number(filed.output_minor) !== out.ppn || Number(filed.input_minor) !== inp.ppn,
    } : null,
    laterFiled: later?.month ?? null,
  };
}

export async function recordInput(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const month = String(b.month ?? '');
  if (!MONTH_RE.test(month)) throw new PpnError(422, 'month (the tax period) is YYYY-MM.');
  const supplier = String(b.supplier ?? '').trim();
  if (!supplier || supplier.length > 160) throw new PpnError(422, 'The supplier is required.');
  const npwp = b.supplierNpwp == null || b.supplierNpwp === '' ? null : npwpDigits(b.supplierNpwp);
  if (npwp !== null && npwp.length !== 15 && npwp.length !== 16) throw new PpnError(422, 'The supplier\'s NPWP has 15 or 16 digits.');
  const faktur = String(b.faktur ?? '').trim();
  if (!/^[\w.\-/]{6,40}$/.test(faktur)) throw new PpnError(422, 'The faktur pajak number is required (as printed).');
  const date = String(b.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new PpnError(422, 'The faktur date is YYYY-MM-DD.');
  if (date.slice(0, 7) > month) throw new PpnError(422, 'A faktur dated after the period cannot be credited in it.');
  const dpp = Number(b.dpp), ppn = Number(b.ppn);
  if (!Number.isInteger(dpp) || dpp < 0 || !Number.isInteger(ppn) || ppn < 0) throw new PpnError(422, 'DPP and PPN are whole rupiah, 0 or more.');
  if (dpp > 0 && ppn > Math.ceil(dpp * 0.12) + 1) throw new PpnError(422, 'The PPN is more than 12% of the DPP: check the amounts.');
  const filed = await outsideRequestScope(() => one(`SELECT 1 FROM ppn_period WHERE org_id = $1 AND month = $2`, [orgId, month]));
  if (filed && b.amend !== true) throw new PpnError(409, `${month} is filed: record it with amend (and file the correction, pembetulan).`);
  const description = b.description == null ? null : String(b.description).trim().slice(0, 200) || null;
  try {
    const r = await outsideRequestScope(() => one<{ id: string }>(
      `INSERT INTO ppn_input_invoice (org_id, month, supplier, supplier_npwp, faktur_number, faktur_date, dpp_minor, ppn_minor, description, creditable, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [orgId, month, supplier, npwp, faktur, date, dpp, ppn, description, b.creditable !== false, userId]));
    return { id: String(r!.id), month, faktur, dpp, ppn };
  } catch (e) {
    if ((e as any).code === '23505') throw new PpnError(409, `Faktur ${faktur} is already recorded.`);
    throw e;
  }
}

export async function voidInput(orgId: string, id: string, reasonRaw: unknown, userId: string | null) {
  const reason = String(reasonRaw ?? '').trim();
  if (!reason || reason.length > 300) throw new PpnError(422, 'Say why it is voided.');
  if (!/^\d{1,18}$/.test(id)) throw new PpnError(404, 'No such input invoice.');
  const r = await outsideRequestScope(() => one<{ month: string }>(
    `UPDATE ppn_input_invoice SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE id = $1 AND org_id = $2 AND voided_at IS NULL RETURNING month`, [id, orgId, userId, reason]));
  if (!r) throw new PpnError(404, 'No such input invoice.');
  return { ok: true, month: r.month };
}

/** Record the period as filed (or amend it while no later period is filed). */
export async function file(orgId: string, monthRaw: unknown, b: Record<string, unknown>, userId: string | null) {
  const p = await period(orgId, monthRaw);
  if (!p.ended) throw new PpnError(409, 'Only an ended tax period can be filed.');
  if (!p.pkp) throw new PpnError(409, 'Your organisation is not a PKP: no PPN return.');
  if (p.laterFiled) throw new PpnError(409, `${p.laterFiled} is already filed: amend that first.`);
  if (p.filed && b.amend !== true) throw new PpnError(409, `${p.month} is already filed: amend it to replace the figures.`);
  const ntpn = b.ntpn == null || b.ntpn === '' ? null : String(b.ntpn).trim().toUpperCase();
  if (ntpn !== null && !/^[0-9A-Z]{16}$/.test(ntpn)) throw new PpnError(422, 'The NTPN has 16 letters and digits.');
  if (p.payable > 0 && !ntpn && b.unpaid !== true) throw new PpnError(422, `${p.payable} rupiah is payable: give the NTPN of the payment (or file it as not yet paid).`);
  const reference = b.reference == null ? null : String(b.reference).trim().slice(0, 80) || null;
  const data = { output: p.output.lines, input: { recorded: p.input.invoices.length, ppn: p.input.ppn }, broughtFrom: p.broughtFrom, amended: Boolean(p.filed) };
  await outsideRequestScope(() => query(
    `INSERT INTO ppn_period (org_id, month, output_minor, input_minor, brought_forward_minor, payable_minor, carried_forward_minor, data, ntpn, reference, filed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (org_id, month) DO UPDATE SET output_minor = EXCLUDED.output_minor, input_minor = EXCLUDED.input_minor, brought_forward_minor = EXCLUDED.brought_forward_minor,
       payable_minor = EXCLUDED.payable_minor, carried_forward_minor = EXCLUDED.carried_forward_minor, data = EXCLUDED.data, ntpn = EXCLUDED.ntpn, reference = EXCLUDED.reference,
       filed_by = EXCLUDED.filed_by, filed_at = now()`,
    [orgId, p.month, p.output.ppn, p.input.ppn, p.broughtForward, p.payable, p.carriedForward, JSON.stringify(data), ntpn, reference, userId]));
  return { month: p.month, output: p.output.ppn, input: p.input.ppn, broughtForward: p.broughtForward, payable: p.payable, carriedForward: p.carriedForward, ntpn, amended: Boolean(p.filed) };
}

export async function periods(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT f.*, u.name AS by_name FROM ppn_period f LEFT JOIN app_user u ON u.id = f.filed_by WHERE f.org_id = $1 ORDER BY f.month DESC LIMIT 36`, [orgId]));
  return rows.map((f) => ({ month: f.month, output: Number(f.output_minor), input: Number(f.input_minor), broughtForward: Number(f.brought_forward_minor), payable: Number(f.payable_minor),
    carriedForward: Number(f.carried_forward_minor), ntpn: f.ntpn ?? null, filedAt: new Date(f.filed_at).toISOString(), filedBy: f.by_name ?? null }));
}

const cell = (v: unknown) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };

/** Input invoices as CSV in the columns of a faktur masukan list (for Coretax). */
export function inputCsv(p: Awaited<ReturnType<typeof period>>): string {
  const [y, m] = p.month.split('-');
  const rows: unknown[][] = [['NPWP Penjual', 'Nama Penjual', 'Nomor Faktur', 'Tanggal Faktur', 'Masa Pajak', 'Tahun Pajak', 'DPP', 'PPN', 'Dikreditkan', 'Keterangan']];
  for (const i of p.input.invoices) rows.push([i.supplierNpwp ?? '', i.supplier, i.faktur, i.date, Number(m), y, i.dpp, i.ppn, i.creditable ? 'Ya' : 'Tidak', i.description ?? '']);
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Output (fleet invoices and credit notes) as CSV, for checking against Coretax's faktur keluaran. */
export function outputCsv(p: Awaited<ReturnType<typeof period>>): string {
  const rows: unknown[][] = [['Jenis', 'Nomor', 'Nomor Faktur', 'Tanggal', 'Pembeli', 'NPWP Pembeli', 'DPP', 'PPN']];
  for (const i of p.output.invoices) rows.push(['Faktur', i.number, i.efaktur ?? '', i.date, i.buyer, i.buyerNpwp ?? '', i.dpp, i.ppn]);
  for (const c of p.output.creditNotes) rows.push(['Nota retur', c.number, c.efaktur ?? '', c.date, c.invoice ?? '', '', -c.dpp, -c.ppn]);
  for (const l of p.output.lines.filter((x) => x.key === 'retail' || x.key === 'subscriptions')) rows.push(['Digunggung', l.label, '', p.month, 'Konsumen akhir', '', l.dpp, l.ppn]);
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function workingPapers(p: Awaited<ReturnType<typeof period>>): Buffer {
  return xlsx([
    { name: 'SPT Masa PPN', rows: [
      ['Masa pajak', p.month], ['Organisation', p.organisation ?? ''], ['NPWP', p.npwp ?? ''], ['PKP', p.pkp ? 'yes' : 'no'],
      [], ['', 'DPP', 'PPN'],
      ...p.output.lines.map((l) => [`Output: ${l.label}`, l.dpp, l.ppn]),
      ['Output total (PPN keluaran)', p.output.dpp, p.output.ppn],
      ['Input credited (PPN masukan)', p.input.dpp, p.input.ppn],
      [`Overpayment brought forward${p.broughtFrom ? ` (${p.broughtFrom})` : ''}`, '', p.broughtForward],
      ['Payable (kurang bayar)', '', p.payable], ['Carried forward (lebih bayar)', '', p.carriedForward],
      ['Payment and filing due', p.paymentDue, ''],
      ...(p.filed ? [['Filed', p.filed.at, p.filed.ntpn ?? '']] : []),
    ], widths: [44, 18, 18], formats: [null, 'int', 'int'] },
    { name: 'Faktur keluaran', rows: [['Number', 'e-Faktur', 'Date', 'Buyer', 'NPWP', 'DPP', 'PPN'], ...p.output.invoices.map((i) => [i.number, i.efaktur ?? '', i.date, i.buyer, i.buyerNpwp ?? '', i.dpp, i.ppn]),
      ...p.output.creditNotes.map((c) => [c.number, c.efaktur ?? '', c.date, `Credit note on ${c.invoice ?? ''}`, '', -c.dpp, -c.ppn])], widths: [22, 22, 12, 30, 20, 16, 16], formats: [null, null, null, null, null, 'int', 'int'] },
    { name: 'Faktur masukan', rows: [['Supplier', 'NPWP', 'Faktur', 'Date', 'DPP', 'PPN', 'Creditable', 'Description'], ...p.input.invoices.map((i) => [i.supplier, i.supplierNpwp ?? '', i.faktur, i.date, i.dpp, i.ppn, i.creditable ? 'yes' : 'no', i.description ?? ''])],
      widths: [30, 20, 24, 12, 16, 16, 10, 40], formats: [null, null, null, null, 'int', 'int', null, null] },
  ]);
}
