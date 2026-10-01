import { one, many } from '../db/pool.js';
import { signedDataFor } from './signed-metering.js';
import { config } from '../config.js';
import { estimateQrisMdrIdr } from './payments/provider.js';
import { effectivePpnRateBps } from './tax.js';

/**
 * Session explorer, CSV export and the tax receipt (SPEC Module 8).
 *
 * The financial breakdown is derived from the FROZEN CDR (cdr.lines + the tax
 * columns), never re-rated: an invoice must reproduce exactly as issued.
 */

export interface SessionFilter {
  from?: string;
  to?: string;
  siteId?: string;
  identity?: string;
  connectorType?: string; // a plug code (cCCS2…) or AC | DC
  paymentStatus?: string;
  state?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

const PAYMENT_STATUS_SQL = `
  CASE
    WHEN cs.needs_review THEN 'review'
    WHEN d.id IS NULL AND cs.state = 'active' THEN 'in_progress'
    WHEN d.id IS NULL THEN 'unbilled'
    WHEN pi.state IN ('captured', 'settled') THEN 'paid'
    WHEN pi.mode = 'postpay' AND pi.hold_state = 'capture_failed' THEN 'failed'
    WHEN pi.mode = 'postpay' AND pi.state = 'authorised' THEN 'pending'
    WHEN pi.mode = 'preauth' AND pi.state = 'authorised' THEN 'held'
    WHEN pi.mode IN ('preauth', 'postpay') AND pi.state = 'voided' THEN 'released'
    WHEN pi.state IS NOT NULL THEN pi.state
    WHEN cs.payment_mode = 'free' THEN 'free'
    ELSE 'invoiced'
  END`;

export const PAYMENT_STATUSES = ['paid', 'invoiced', 'pending', 'unbilled', 'review', 'in_progress', 'failed', 'refunded', 'free', 'held', 'released'];

/**
 * Driver data for SITE-SCOPED viewers (Site Owner portal, Site Host).
 *
 * An RFID idTag is not just an identifier: on UID-only cards it IS the
 * credential, so a third party who sees full idTags can clone a fleet customer's
 * card and charge on its account. Holder names are personal data (UU PDP) the
 * site's owner has no need for. Site-scoped viewers get the last 4 characters
 * of a card and no holder name; the operator (org-wide) sees everything.
 */
export function maskIdTag(uid: unknown): string | null {
  if (uid == null || uid === '') return null;
  const s = String(uid);
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
}

export function protectDriverData<T extends Record<string, any>>(row: T): T {
  const out: any = { ...row };
  if ('id_tag' in out) out.id_tag = maskIdTag(out.id_tag);
  if ('session_id_tag' in out) out.session_id_tag = maskIdTag(out.session_id_tag);
  if ('holder_name' in out) out.holder_name = null;
  return out;
}

function whereFor(orgId: string, f: SessionFilter, visible: string[] | null) {
  const where: string[] = ['cs.org_id = $1'];
  const params: unknown[] = [orgId];
  const add = (clause: string, v: unknown) => {
    params.push(v);
    where.push(clause.replaceAll('?', `$${params.length}`));
  };
  if (visible) add('cs.site_id = ANY(?::uuid[])', visible);
  if (f.from) add('cs.started_at >= ?', new Date(f.from));
  if (f.to) add('cs.started_at < ?', new Date(f.to));
  if (f.siteId) add('cs.site_id = ?', f.siteId);
  if (f.identity) add('cp.ocpp_identity = ?', f.identity);
  if (f.state) add('cs.state = ?', f.state);
  if (f.connectorType === 'AC' || f.connectorType === 'DC') add('c.current_type = ?', f.connectorType);
  else if (f.connectorType) add('c.connector_type = ?', f.connectorType);
  if (f.paymentStatus) add(`(${PAYMENT_STATUS_SQL}) = ?`, f.paymentStatus);
  // Site-scoped viewers: whole-value matches only. A substring match on the card
  // would let them rebuild a full idTag a character at a time from hit/miss.
  if (f.q) {
    if (visible) add(`(cs.id::text = ? OR t.uid = ? OR cs.ocpp_transaction_id = ?)`, f.q);
    else add(`(cs.id::text = ? OR t.uid ILIKE '%' || ? || '%' OR cs.ocpp_transaction_id = ?)`, f.q);
  }
  return { where: where.join(' AND '), params };
}

const SELECT = `
  SELECT cs.id, cs.started_at, cs.ended_at, cs.state, cs.energy_wh, cs.duration_s, cs.stop_reason,
         cs.meter_start_wh, cs.meter_stop_wh, cs.ocpp_transaction_id, cs.needs_review, cs.review_reason,
         cs.idle_minutes, cs.payment_mode, cs.prepaid_amount_idr,
         cp.ocpp_identity, cp.display_name, e.evse_id AS evse_no, c.connector_type, c.current_type,
         s.id AS site_id, s.name AS site_name, t.uid AS id_tag, t.holder_name,
         d.id AS cdr_id, d.lines, d.subtotal_idr, d.pbjt_idr, d.pbjt_rate_bps, d.ppn_dpp_idr, d.ppn_rate_bps,
         d.ppn_idr, d.total_idr, d.regulatory_flags, d.issued_at,
         pi.method AS payment_method, pi.state AS payment_state,
         ${PAYMENT_STATUS_SQL} AS payment_status
    FROM charging_session cs
    JOIN charge_point cp ON cp.id = cs.charge_point_id
    JOIN connector c ON c.id = cs.connector_uuid
    JOIN evse e ON e.id = c.evse_uuid
    JOIN site s ON s.id = cs.site_id
    LEFT JOIN token t ON t.id = cs.token_id
    LEFT JOIN cdr d ON d.session_id = cs.id
    LEFT JOIN payment_intent pi ON pi.id = cs.payment_intent_id`;

/**
 * The rounding (pembulatan) in a charge record's total: total − (subtotal + PBJT
 * + PPN). Read from the record rather than stored, so records rated before the
 * rounding line existed show it too. 0 with ROUNDING_UNIT_IDR = 1.
 */
export const roundingOf = (r: { subtotal_idr?: unknown; pbjt_idr?: unknown; ppn_idr?: unknown; total_idr?: unknown }) =>
  r.total_idr == null ? 0 : Number(r.total_idr) - Number(r.subtotal_idr ?? 0) - Number(r.pbjt_idr ?? 0) - Number(r.ppn_idr ?? 0);

/** Split the frozen CDR lines into the columns the explorer shows. */
export function breakdown(row: any) {
  const lines: any[] = Array.isArray(row.lines) ? row.lines : [];
  const sum = (kinds: string[]) => lines.filter((l) => kinds.includes(l.kind)).reduce((a, l) => a + Number(l.amountIdr ?? 0), 0);
  const total = row.total_idr != null ? Number(row.total_idr) : null;
  return {
    energySubtotalIdr: row.cdr_id ? sum(['energy']) : null,
    serviceFeeIdr: row.cdr_id ? sum(['session', 'admin']) : null,
    idleFeeIdr: row.cdr_id ? sum(['idle', 'time']) : null,
    pbjtIdr: row.pbjt_idr ?? null,
    dppIdr: row.ppn_dpp_idr ?? null,
    ppnIdr: row.ppn_idr ?? null,
    /**
     * The QRIS MDR is the CPO's cost, deducted at settlement — it is NOT charged
     * to the driver (Bank Indonesia prohibits surcharging it). Shown as an
     * estimate for reconciliation of net revenue.
     */
    mdrIdr: total != null && row.payment_method === 'qris' ? estimateQrisMdrIdr(total) : 0,
    /** Rounding to ROUNDING_UNIT_IDR (tax.ts): what the total adds beyond subtotal + PBJT + PPN. */
    roundingIdr: row.cdr_id ? roundingOf(row) : null,
    grossTotalIdr: total,
  };
}

export async function searchSessions(orgId: string, f: SessionFilter, visible: string[] | null) {
  const { where, params } = whereFor(orgId, f, visible);
  const limit = Math.min(Math.max(Number(f.limit ?? 100), 1), 500);
  const offset = Math.max(Number(f.offset ?? 0), 0);
  const rows = await many<any>(
    `${SELECT} WHERE ${where} ORDER BY cs.started_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const totals = await one<any>(
    `SELECT count(*)::int AS sessions, COALESCE(sum(cs.energy_wh),0)::bigint AS energy_wh,
            COALESCE(sum(d.total_idr),0)::bigint AS revenue_idr, COALESCE(sum(d.pbjt_idr),0)::bigint AS pbjt_idr,
            COALESCE(sum(d.ppn_idr),0)::bigint AS ppn_idr
       FROM charging_session cs
       JOIN charge_point cp ON cp.id = cs.charge_point_id
       JOIN connector c ON c.id = cs.connector_uuid
       LEFT JOIN token t ON t.id = cs.token_id
       LEFT JOIN cdr d ON d.session_id = cs.id
       LEFT JOIN payment_intent pi ON pi.id = cs.payment_intent_id
      WHERE ${where}`,
    params,
  );
  return {
    rows: rows.map((r) => {
      const row = { ...r, lines: undefined, breakdown: breakdown(r) };
      return visible ? protectDriverData(row) : row;
    }),
    totals,
    limit,
    offset,
  };
}

export const csvCell = (v: unknown) => {
  if (v == null) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Spreadsheet formula injection: a cell starting with = + - @ is executed by Excel.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function sessionsCsv(orgId: string, f: SessionFilter, visible: string[] | null): Promise<string> {
  const { where, params } = whereFor(orgId, f, visible);
  const rows = await many<any>(`${SELECT} WHERE ${where} ORDER BY cs.started_at DESC LIMIT 50000`, params);
  const head = [
    'session_id', 'transaction_id', 'site', 'charge_point', 'connector', 'connector_type', 'id_tag',
    'started_at', 'ended_at', 'duration_s', 'meter_start_kwh', 'meter_stop_kwh', 'energy_kwh', 'stop_reason',
    'state', 'payment_status', 'energy_subtotal_idr', 'service_fee_idr', 'idle_fee_idr', 'pbjt_rate_pct',
    'pbjt_idr', 'dpp_idr', 'ppn_idr', 'mdr_estimate_idr', 'gross_total_idr',
  ];
  const lines = [head.join(',')];
  for (const r of rows) {
    const b = breakdown(r);
    lines.push(
      [
        r.id, r.ocpp_transaction_id, r.site_name, r.ocpp_identity, r.evse_no, r.connector_type, visible ? maskIdTag(r.id_tag) : r.id_tag,
        r.started_at, r.ended_at, r.duration_s,
        r.meter_start_wh != null ? (Number(r.meter_start_wh) / 1000).toFixed(3) : '',
        r.meter_stop_wh != null ? (Number(r.meter_stop_wh) / 1000).toFixed(3) : '',
        (Number(r.energy_wh ?? 0) / 1000).toFixed(3), r.stop_reason, r.state, r.payment_status,
        b.energySubtotalIdr, b.serviceFeeIdr, b.idleFeeIdr,
        r.pbjt_rate_bps != null ? (Number(r.pbjt_rate_bps) / 100).toFixed(2) : '',
        b.pbjtIdr, b.dppIdr, b.ppnIdr, b.mdrIdr, b.grossTotalIdr,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);
const idr = (n: unknown) => (n == null ? '—' : 'Rp ' + new Intl.NumberFormat('id-ID').format(Math.round(Number(n))));
const when = (t: unknown, tz: string) =>
  t ? new Date(String(t)).toLocaleString('id-ID', { timeZone: tz, hour12: false, dateStyle: 'medium', timeStyle: 'short' }) : '—';

/**
 * A printable tax receipt. Shows the Indonesian stack explicitly — DPP nilai
 * lain, PPN at the statutory rate on DPP (11% effective), PBJT-TL at the
 * municipality's rate — because the acceptance criterion and a tax audit both
 * require those three figures to be visible, not folded into a total.
 */
const SIGNED_LABEL: Record<string, string> = {
  verified: 'terverifikasi / verified',
  unverified_key: 'cocok, kunci meter belum terdaftar / matches, meter key not registered',
  mismatch: 'TIDAK cocok dengan tagihan / does NOT match the bill',
  invalid: 'tanda tangan tidak sah / signature not valid',
  incomplete: 'tidak lengkap / incomplete',
  missing: 'tidak ada / missing',
};

/** The receipt's signed-data section: status, the readings, and the data to check with the Transparency Software. */
function signedReceiptBlock(d: NonNullable<Awaited<ReturnType<typeof signedDataFor>>>): string {
  const rows = d.values.flatMap((v) => (v.readings as any[]).filter((x) => x.register === 'import').map((x) =>
    `<tr><td>${esc(x.tx === 'B' ? 'Awal / Start' : x.tx === 'E' ? 'Akhir / End' : x.tx ?? '—')}</td><td>${esc(x.tm)}</td><td class="n">${x.wh != null ? (x.wh / 1000).toFixed(3) : '—'} kWh</td></tr>`)).join('');
  return `<div style="margin-top:18px"><b>Data meter bertanda tangan / Signed meter data (OCMF)</b>
<div class="muted">Status: ${esc(d.status ? SIGNED_LABEL[d.status] ?? d.status : 'belum diperiksa / not assessed')}${d.meterSerial ? ` · meter ${esc(d.meterSerial)}` : ''}</div>
${rows ? `<table><thead><tr><th>Bacaan / Reading</th><th>Waktu meter / Meter time</th><th class="n">Register</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
<div class="note">Periksa dengan S.A.F.E. Transparenzsoftware: salin data dan kunci publik meter di bawah. / Check with the S.A.F.E. Transparency Software: copy the data and the meter's public key below.</div>
${d.values.map((v) => `<pre style="white-space:pre-wrap;word-break:break-all;font-size:10.5px;background:#f6f7f9;padding:8px;border-radius:6px">${esc(v.ocmf)}</pre>`).join('')}
${d.meterPublicKey ? `<div class="muted">Kunci publik meter / Meter public key</div><pre style="white-space:pre-wrap;word-break:break-all;font-size:10.5px;background:#f6f7f9;padding:8px;border-radius:6px">${esc(d.meterPublicKey)}</pre>` : ''}</div>`;
}

export async function receiptHtml(sessionId: string, maskCard = false): Promise<string | null> {
  const r = await one<any>(
    `SELECT cs.id, cs.started_at, cs.ended_at, cs.energy_wh, cs.duration_s, cs.meter_start_wh, cs.meter_stop_wh,
            cs.stop_reason, cs.ocpp_transaction_id, cp.ocpp_identity, e.evse_id, c.connector_type, c.max_power_w,
            s.name AS site_name, s.address, s.spklu_id, s.timezone, s.pbjt_rate_bps AS site_pbjt,
            -- Seller of record: the site owner once payments settle to its own merchant
            -- account (site_owner.seller_of_record = 'owner'), otherwise the operator.
            CASE WHEN so.seller_of_record = 'owner' THEN COALESCE(so.legal_name, so.name) ELSE o.name END AS org_name,
            CASE WHEN so.seller_of_record = 'owner' THEN so.npwp ELSE o.npwp END AS npwp,
            CASE WHEN so.seller_of_record = 'owner' THEN so.pkp ELSE o.pkp END AS pkp,
            t.uid AS id_tag,
            d.id AS cdr_id, d.issued_at, d.lines, d.subtotal_idr, d.pbjt_idr, d.pbjt_rate_bps, d.ppn_dpp_idr,
            d.ppn_rate_bps, d.ppn_idr, d.total_idr, pi.method AS payment_method, pi.state AS payment_state,
            pi.mode AS payment_mode, pi.hold_state, pi.channel AS payment_channel,
            -- Paid in the app after the hold expired or the e-wallet charge failed: the method actually used.
            (SELECT s2.channel FROM payment_intent s2 WHERE s2.settles_intent_id = pi.id AND s2.mode = 'settlement' AND s2.state = 'captured'
              AND position(s2.id::text in COALESCE(pi.hold_error, '')) > 0 LIMIT 1) AS paid_in_app_channel
       FROM charging_session cs
       JOIN charge_point cp ON cp.id = cs.charge_point_id
       JOIN connector c ON c.id = cs.connector_uuid
       JOIN evse e ON e.id = c.evse_uuid
       JOIN site s ON s.id = cs.site_id
       JOIN organisation o ON o.id = cs.org_id
       LEFT JOIN site_owner so ON so.id = s.owner_id
       LEFT JOIN token t ON t.id = cs.token_id
       LEFT JOIN cdr d ON d.session_id = cs.id
       LEFT JOIN payment_intent pi ON pi.id = COALESCE(cs.payment_intent_id,
                 (SELECT p2.id FROM payment_intent p2 WHERE p2.session_id = cs.id AND p2.mode <> 'settlement' ORDER BY p2.created_at LIMIT 1))
      WHERE cs.id = $1`,
    [sessionId],
  );
  if (!r) return null;
  const tz = r.timezone ?? 'Asia/Jakarta';
  const lines: any[] = Array.isArray(r.lines) ? r.lines : [];
  const ppnPct = r.ppn_rate_bps != null ? (Number(r.ppn_rate_bps) / 100).toFixed(0) : String(config.tax.ppnRateBps / 100);
  const effPct = (effectivePpnRateBps() / 100).toFixed(0);
  const dppFrac = `${config.tax.ppnDppNumerator}/${config.tax.ppnDppDenominator}`;
  const pbjtPct = r.pbjt_rate_bps != null ? (Number(r.pbjt_rate_bps) / 100).toFixed(1) : '—';
  // Unpaid (a card hold or a post-pay e-wallet charge not yet taken: capturing, or failed): a nil transaction.
  // The usage is shown; every amount is zero. The receipt with the real figures is issued once it is paid.
  const nil = !!r.cdr_id && (r.payment_mode === 'preauth' || r.payment_mode === 'postpay') && (r.hold_state === 'capturing' || r.hold_state === 'capture_failed');
  const amt = (v: unknown) => (nil ? 0 : v);
  // The total rounded to ROUNDING_UNIT_IDR: shown as its own line, so the lines add up to the total.
  const rounding = nil || !r.cdr_id ? 0 : roundingOf(r);
  const receiptNo = `PS-${String(r.id).slice(0, 8).toUpperCase()}${nil ? '-NIL' : ''}`;
  // Signed meter data (OCMF): what the meter signed, so the driver can check the bill with the
  // S.A.F.E. Transparency Software and the meter's public key.
  const signed = await signedDataFor(String(r.id)).catch(() => null);
  const signedBlock = signed && signed.values.length ? signedReceiptBlock(signed) : '';

  const lineRows = lines
    .map(
      (l) => `<tr><td>${esc(l.description)}</td><td class="n">${esc(l.quantity)} ${esc(l.unit)}</td>
        <td class="n">${idr(l.unitRate)}</td><td class="n">${idr(amt(l.amountIdr))}</td></tr>`,
    )
    .join('');

  return `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Receipt ${esc(receiptNo)}</title>
<style>
  body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:0;background:#f4f5f7}
  .page{max-width:720px;margin:24px auto;background:#fff;padding:32px 36px;border:1px solid #e3e6ea;border-radius:10px}
  h1{font-size:20px;margin:0}.muted{color:#5b6470;font-size:12.5px}
  table{width:100%;border-collapse:collapse;margin-top:16px}
  th,td{padding:7px 6px;border-bottom:1px solid #eceef1;text-align:left;vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#5b6470}
  .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .tot td{border-bottom:0}.grand td{font-weight:700;font-size:16px;border-top:2px solid #111}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:2px 14px;margin-top:14px;font-size:13px}
  .kv dt{color:#5b6470}.kv dd{margin:0}
  .head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
  .note{margin-top:18px;font-size:11.5px;color:#5b6470}
  .warn{background:#fef3c7;color:#92400e;padding:8px 10px;border-radius:6px;margin-top:12px;font-size:12.5px}
  @media print{body{background:#fff}.page{border:0;margin:0;max-width:none}.noprint{display:none}}
</style></head><body><div class="page">
<div class="head"><div><h1>Tanda Terima Pengisian Daya / Charging Receipt${nil ? ' — NIHIL / NIL' : ''}</h1>
<div class="muted">${esc(r.org_name)}${r.npwp ? ` · NPWP ${esc(r.npwp)}` : ''}${r.pkp ? ' · PKP' : ''}</div></div>
<div class="muted" style="text-align:right">No. ${esc(receiptNo)}<br>${esc(when(r.issued_at ?? r.ended_at, tz))}</div></div>
<dl class="kv">
<dt>Lokasi / Site</dt><dd>${esc(r.site_name)}${r.address ? ` — ${esc(r.address)}` : ''}</dd>
<dt>ID SPKLU</dt><dd>${esc(r.spklu_id ?? '—')}</dd>
<dt>Charger</dt><dd>${esc(r.ocpp_identity)} · connector ${esc(r.evse_id)} (${esc(r.connector_type ?? '')})</dd>
<dt>Sesi / Session</dt><dd>${esc(r.id)}${r.ocpp_transaction_id ? ` · tx ${esc(r.ocpp_transaction_id)}` : ''}</dd>
<dt>Mulai / Start</dt><dd>${esc(when(r.started_at, tz))}</dd>
<dt>Selesai / End</dt><dd>${esc(when(r.ended_at, tz))}</dd>
<dt>Meter</dt><dd>${r.meter_start_wh != null ? (Number(r.meter_start_wh) / 1000).toFixed(3) : '—'} → ${
    r.meter_stop_wh != null ? (Number(r.meter_stop_wh) / 1000).toFixed(3) : '—'
  } kWh (terkirim / delivered <b>${(Number(r.energy_wh ?? 0) / 1000).toFixed(3)} kWh</b>)</dd>
<dt>Kartu / Card</dt><dd>${esc((maskCard ? maskIdTag(r.id_tag) : r.id_tag) ?? '—')}</dd>
</dl>
${r.cdr_id ? '' : '<div class="warn">This session has not been rated yet — no tax invoice can be issued until it is.</div>'}
${nil ? '<div class="warn"><b>Transaksi nihil / Nil transaction.</b> Sesi ini belum dibayar, jadi semua nilai adalah Rp 0. Tanda terima dengan nilai sebenarnya diterbitkan setelah pembayaran diterima. / This session has not been paid, so every amount is Rp 0. The receipt with the actual figures is issued once payment is received.</div>' : ''}
<table><thead><tr><th>Uraian / Item</th><th class="n">Qty</th><th class="n">Harga / Rate</th><th class="n">Jumlah</th></tr></thead>
<tbody>${lineRows}</tbody>
<tbody class="tot">
<tr><td colspan="3">Subtotal</td><td class="n">${idr(amt(r.subtotal_idr))}</td></tr>
<tr><td colspan="3">PBJT-TL (Pajak Barang dan Jasa Tertentu — Tenaga Listrik) ${esc(pbjtPct)}%</td><td class="n">${idr(amt(r.pbjt_idr))}</td></tr>
<tr><td colspan="3">DPP nilai lain (${esc(dppFrac)} × harga)</td><td class="n">${idr(amt(r.ppn_dpp_idr))}</td></tr>
<tr><td colspan="3">PPN ${esc(ppnPct)}% × DPP (efektif ${esc(effPct)}%, UU HPP)</td><td class="n">${idr(amt(r.ppn_idr))}</td></tr>
${rounding ? `<tr><td colspan="3">Pembulatan / Rounding</td><td class="n">${rounding < 0 ? '−' : ''}${idr(Math.abs(rounding))}</td></tr>` : ''}
<tr class="grand"><td colspan="3">Total dibayar / Total</td><td class="n">${idr(amt(r.total_idr))}</td></tr>
</tbody></table>
<div class="note">Harga energi tunduk pada batas tarif layanan khusus PLN; biaya layanan tunduk pada Kepmen ESDM 182.K/TL.04/MEM.S/2023.
${nil ? 'Belum dibayar / Unpaid.' : r.paid_in_app_channel ? `Dibayar di aplikasi via ${esc(String(r.paid_in_app_channel).toUpperCase())} (captured).` : r.payment_method ? `Dibayar via ${esc(String(r.payment_method).toUpperCase())} (${esc(r.payment_state ?? '')}).` : ''}
Dokumen ini dihasilkan oleh sistem dan sah tanpa tanda tangan.</div>
${signedBlock}
<p class="noprint" style="margin-top:18px"><button type="button" data-print>Print / Save as PDF</button></p>
<script src="/d/print.js" defer></script>
</div></body></html>`;
}
