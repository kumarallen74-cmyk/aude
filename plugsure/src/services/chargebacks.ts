import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { assertOpen } from './finance-periods.js';
import { PdfDoc, Flow } from './pdf.js';
import { xlsx } from './xlsx.js';

/**
 * Chargebacks and fraud (v1.36.0).
 *
 *   cases      a card or e-wallet chargeback on a payment: the provider's case, the reason (and its code), the amount
 *              (at most what was captured), the fee, when it came and the date to respond by: the date on the gateway's
 *              notice when given, else 7 calendar days (Xendit's window from the first notice; others run 5 to 10).
 *              open → evidence submitted → won or lost; or accepted (not contested). The deadline raises
 *              finance.chargeback_due from 3 days ahead (critical once past) until answered.
 *   evidence   a PDF from the payment and its charging session: when and where it was authorised and captured, the
 *              charger, the connector, the energy delivered with the meter readings, the charge record's lines, the
 *              token (masked), the driver's contact (masked) and any refund — what the provider asks for.
 *   ledger     received: Dr 1190 disputed funds / Cr 1130 gateway balance, and the fee Dr 6110 / Cr 1130; won: Dr 1130 /
 *              Cr 1190; lost or accepted: Dr 6520 chargeback losses / Cr 1190.
 *   fraud      over the last 90 days: tokens and drivers with two or more chargebacks; payments refunded and also
 *              charged back (paid back twice); bursts of failed or expired payments at one connector in a day (card
 *              testing); the chargeback rate per payment method (warning from 0.9%, the card schemes' threshold, as
 *              finance.chargeback_rate). A token can be blocked from here.
 */

export class ChargebackError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const REASONS = ['fraud', 'not_received', 'not_as_described', 'duplicate', 'amount', 'cancelled', 'other'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DUE = 'finance.chargeback_due';
const RATE = 'finance.chargeback_rate';
/** The response window when the notice gives none: Xendit's 7 calendar days from the first dispute notice. */
export const DEFAULT_RESPOND_DAYS = 7;
export const RATE_THRESHOLD_PCT = 0.9;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const ERR = (s: number, m: string) => new ChargebackError(s, m);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Mask all but the last four characters. Pure. */
export function mask(s: string | null | undefined): string {
  if (!s) return '';
  const t = String(s);
  return t.length <= 4 ? '••••' : `${'•'.repeat(Math.min(8, t.length - 4))}${t.slice(-4)}`;
}

const C_SELECT = `SELECT c.*, to_char(c.received_on, 'YYYY-MM-DD') AS rec_s, to_char(c.respond_by, 'YYYY-MM-DD') AS by_s, to_char(c.evidence_sent_on, 'YYYY-MM-DD') AS ev_s, to_char(c.outcome_on, 'YYYY-MM-DD') AS out_s,
    p.provider_ref, p.method, p.amount_captured_minor, p.refunded_minor, p.session_id, cs.token_id, cs.driver_id, t.uid AS token_uid, t.status AS token_status, s.name AS site_name
  FROM chargeback c LEFT JOIN payment_intent p ON p.id = c.payment_intent_id LEFT JOIN charging_session cs ON cs.id = p.session_id LEFT JOIN token t ON t.id = cs.token_id LEFT JOIN site s ON s.id = cs.site_id`;

const view = (c: any, t = today()) => ({
  id: String(c.id), paymentId: c.payment_intent_id ?? null, paymentRef: c.provider_ref ?? null, method: c.method ?? null, provider: c.provider, caseRef: c.case_ref, reason: c.reason, reasonCode: c.reason_code ?? null,
  currency: c.currency, amount: Number(c.amount_minor), fee: Number(c.fee_minor), receivedOn: c.rec_s, respondBy: c.by_s, status: c.status, evidenceSentOn: c.ev_s ?? null, outcomeOn: c.out_s ?? null, note: c.note ?? null,
  sessionId: c.session_id ?? null, site: c.site_name ?? null, tokenId: c.token_id ?? null, token: c.token_uid ? mask(c.token_uid) : null, tokenBlocked: c.token_status === 'Blocked', driverId: c.driver_id ?? null,
  refunded: Number(c.refunded_minor ?? 0), alsoRefunded: Number(c.refunded_minor ?? 0) > 0,
  daysLeft: c.status === 'open' ? days(t, c.by_s) : null, overdue: c.status === 'open' && c.by_s < t,
});

export async function list(orgId: string, q: { status?: unknown } = {}) {
  const st = q.status ? String(q.status) : null;
  const rows = (await outsideRequestScope(() => many<any>(`${C_SELECT} WHERE c.org_id = $1 AND ($2::text IS NULL OR c.status = $2::text) ORDER BY (c.status = 'open') DESC, c.respond_by, c.id DESC LIMIT 500`, [orgId, st]))).map((c) => view(c));
  const totals: Record<string, { open: number; openAmount: number; won: number; lost: number; lostAmount: number; fees: number }> = {};
  for (const c of rows) {
    const x = (totals[c.currency] ??= { open: 0, openAmount: 0, won: 0, lost: 0, lostAmount: 0, fees: 0 });
    x.fees += c.fee;
    if (c.status === 'open' || c.status === 'evidence_submitted') { x.open++; x.openAmount += c.amount; }
    if (c.status === 'won') x.won++;
    if (c.status === 'lost' || c.status === 'accepted') { x.lost++; x.lostAmount += c.amount; }
  }
  const decided = rows.filter((c) => ['won', 'lost'].includes(c.status));
  return { chargebacks: rows, totals, winRatePct: decided.length ? Math.round((decided.filter((c) => c.status === 'won').length / decided.length) * 1000) / 10 : null };
}

async function cRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new ChargebackError(404, 'No such chargeback.');
  const r = await outsideRequestScope(() => one<any>(`${C_SELECT} WHERE c.id = $1 AND c.org_id = $2`, [id, orgId]));
  if (!r) throw new ChargebackError(404, 'No such chargeback.');
  return r;
}
export async function get(orgId: string, id: string) { return view(await cRow(orgId, id)); }

/** The payment a chargeback is on: by id or by the provider's reference. */
async function findPayment(orgId: string, b: Record<string, unknown>) {
  const id = b.paymentId ? String(b.paymentId) : null, ref = b.paymentRef ? String(b.paymentRef).trim() : null;
  if (!id && !ref) return null;
  if (id && !UUID_RE.test(id)) throw new ChargebackError(422, 'No such payment.');
  const p = await outsideRequestScope(() => one<any>(`SELECT id, currency, amount_captured_minor, state FROM payment_intent WHERE org_id = $1 AND (($2::uuid IS NOT NULL AND id = $2::uuid) OR ($3::text IS NOT NULL AND (provider_ref = $3::text OR provider_payment_id = $3::text))) LIMIT 1`, [orgId, id, ref]));
  if (!p) throw new ChargebackError(422, 'No such payment (by id or the provider\'s reference).');
  return p;
}

export async function create(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const p = await findPayment(orgId, b);
  const provider = String(b.provider ?? '').trim().toLowerCase(), caseRef = String(b.caseRef ?? '').trim();
  if (provider.length < 2 || caseRef.length < 2) throw new ChargebackError(422, 'provider and caseRef (the provider\'s case number) are needed.');
  const reason = String(b.reason ?? '');
  if (!(REASONS as readonly string[]).includes(reason)) throw new ChargebackError(422, `reason is one of ${REASONS.join(', ')}.`);
  const currency = String(b.currency ?? p?.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new ChargebackError(422, 'currency is an ISO code.');
  if (p && p.currency && p.currency !== currency) throw new ChargebackError(422, `The payment is in ${p.currency}.`);
  const amount = b.amount == null || b.amount === '' ? Number(p?.amount_captured_minor ?? NaN) : Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new ChargebackError(422, 'amount is a whole amount above 0.');
  if (p && p.amount_captured_minor != null && amount > Number(p.amount_captured_minor)) throw new ChargebackError(422, `At most the ${p.amount_captured_minor} captured.`);
  const fee = Number(b.fee ?? 0);
  if (!Number.isInteger(fee) || fee < 0) throw new ChargebackError(422, 'fee is a whole amount, 0 or more.');
  const rec = String(b.receivedOn ?? today());
  if (!DATE_RE.test(rec)) throw new ChargebackError(422, 'receivedOn is YYYY-MM-DD.');
  const by = String(b.respondBy ?? addDays(rec, DEFAULT_RESPOND_DAYS));
  if (!DATE_RE.test(by) || by < rec) throw new ChargebackError(422, 'respondBy is YYYY-MM-DD, on or after receivedOn.');
  await assertOpen(orgId, rec.slice(0, 7), 'A chargeback', ERR);
  try {
    const r = await outsideRequestScope(() => one<{ id: string }>(
      `INSERT INTO chargeback (org_id, payment_intent_id, provider, case_ref, reason, reason_code, currency, amount_minor, fee_minor, received_on, respond_by, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [orgId, p?.id ?? null, provider.slice(0, 40), caseRef.slice(0, 80), reason, b.reasonCode ? String(b.reasonCode).slice(0, 20) : null, currency, amount, fee, rec, by, b.note ? String(b.note).slice(0, 1000) : null, userId]));
    return get(orgId, String(r!.id));
  } catch (e) {
    if ((e as any).code === '23505') throw new ChargebackError(409, `${provider} case ${caseRef} is already recorded.`);
    throw e;
  }
}

const NEXT: Record<string, string[]> = { open: ['evidence_submitted', 'accepted', 'lost'], evidence_submitted: ['won', 'lost'], won: [], lost: [], accepted: [] };

export async function update(orgId: string, id: string, b: Record<string, unknown>) {
  const c = await cRow(orgId, id);
  const status = String(b.status ?? '');
  if (!NEXT[c.status]!.includes(status)) throw new ChargebackError(409, `A ${c.status.replace('_', ' ')} chargeback moves to ${NEXT[c.status]!.join(' or ').replace(/_/g, ' ') || 'nothing'}.`);
  const on = String(b.on ?? today());
  if (!DATE_RE.test(on) || on < c.rec_s) throw new ChargebackError(422, 'on is YYYY-MM-DD, not before the chargeback came.');
  if (status !== 'evidence_submitted') await assertOpen(orgId, on.slice(0, 7), 'A chargeback outcome', ERR);
  await outsideRequestScope(() => query(`UPDATE chargeback SET status = $2, evidence_sent_on = CASE WHEN $2 = 'evidence_submitted' THEN $3::date ELSE evidence_sent_on END,
      outcome_on = CASE WHEN $2 IN ('won', 'lost', 'accepted') THEN $3::date ELSE outcome_on END, note = COALESCE($4, note) WHERE id = $1`, [c.id, status, on, b.note ? String(b.note).slice(0, 1000) : null]));
  await outsideRequestScope(() => resolveAlertsFor(orgId, DUE, 'chargeback', String(c.id))).catch(() => 0);
  return get(orgId, String(c.id));
}

/** Block the token behind a chargeback's session (or any token by id). */
export async function blockToken(orgId: string, tokenId: string) {
  if (!UUID_RE.test(tokenId)) throw new ChargebackError(404, 'No such token.');
  const t = await outsideRequestScope(() => one<any>(`SELECT id, uid, status FROM token WHERE id = $1 AND org_id = $2`, [tokenId, orgId]));
  if (!t) throw new ChargebackError(404, 'No such token.');
  if (t.status === 'Blocked') throw new ChargebackError(409, 'The token is already blocked.');
  await outsideRequestScope(() => query(`UPDATE token SET status = 'Blocked', updated_at = now() WHERE id = $1`, [t.id]));
  return { tokenId: String(t.id), token: mask(t.uid), status: 'Blocked' };
}

/** The evidence for the provider, from the payment and its session. */
export async function evidencePdf(orgId: string, id: string): Promise<Buffer> {
  const c = await cRow(orgId, id);
  const org = await outsideRequestScope(() => one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [orgId]));
  const p = c.payment_intent_id ? await outsideRequestScope(() => one<any>(`SELECT * FROM payment_intent WHERE id = $1`, [c.payment_intent_id])) : null;
  const s = p?.session_id ? await outsideRequestScope(() => one<any>(
    `SELECT cs.*, st.name AS site_name, st.address AS site_address, cp.ocpp_identity, COALESCE(cp.display_name, cp.ocpp_identity) AS cp_name, cn.connector_id AS conn_no, cn.connector_type, t.uid AS token_uid, t.kind AS token_kind,
            d.name AS driver_name, d.email AS driver_email, d.phone AS driver_phone
       FROM charging_session cs LEFT JOIN site st ON st.id = cs.site_id LEFT JOIN charge_point cp ON cp.id = cs.charge_point_id LEFT JOIN connector cn ON cn.id = cs.connector_uuid
       LEFT JOIN token t ON t.id = cs.token_id LEFT JOIN driver d ON d.id = cs.driver_id WHERE cs.id = $1`, [p.session_id])) : null;
  const cdr = s ? await outsideRequestScope(() => one<any>(`SELECT * FROM cdr WHERE session_id = $1`, [s.id])) : null;
  const mv = s ? await outsideRequestScope(() => many<any>(`SELECT ts, value, unit FROM meter_value WHERE session_id = $1 AND measurand = 'Energy.Active.Import.Register' ORDER BY ts`, [s.id])) : [];
  const ts = (x: unknown) => (x ? new Intl.DateTimeFormat('en-GB', { timeZone: zone(), dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(x as string)) : '—');
  const money = (n: unknown, cur = c.currency) => (n == null ? '—' : `${cur} ${Number(n).toLocaleString('en-US')}`);
  const doc = new PdfDoc({ title: `Chargeback ${c.case_ref}`, author: org?.name ?? 'PlugSure CSMS', subject: 'Chargeback evidence', created: new Date() });
  const f = new Flow(doc);
  f.para(`${org?.name ?? ''}: evidence for ${c.provider} case ${c.case_ref}`, { size: 15, bold: true });
  f.para(`Reason: ${c.reason.replace(/_/g, ' ')}${c.reason_code ? ` (${c.reason_code})` : ''} · disputed ${money(c.amount_minor)} · received ${c.rec_s} · respond by ${c.by_s}`, { size: 9.5, color: [0.36, 0.39, 0.44] });
  f.heading('The payment');
  if (p) {
    f.row('Payment reference', p.provider_ref ?? p.id); f.row('Method', `${p.method} (${p.mode})`); f.row('Authorised', money(p.amount_authorised_minor, p.currency));
    f.row('Captured', `${money(p.amount_captured_minor, p.currency)} · ${ts(p.captured_at ?? p.paid_at)}`); f.row('Created', ts(p.created_at));
    if (Number(p.refunded_minor ?? 0) > 0) f.row('Refunded', `${money(p.refunded_minor, p.currency)} · ${ts(p.refunded_at)} (${p.refund_reason ?? 'refund'})`, { bold: true });
  } else f.para('No payment is linked to this case.');
  if (s) {
    f.heading('The service: an EV charging session');
    f.row('Site', `${s.site_name ?? ''}${s.site_address ? `, ${s.site_address}` : ''}`); f.row('Charger and connector', `${s.cp_name ?? ''} · connector ${s.conn_no ?? ''}${s.connector_type ? ` (${s.connector_type})` : ''}`);
    f.row('Started', ts(s.started_at)); f.row('Ended', ts(s.ended_at)); f.row('Energy delivered', `${(Number(s.energy_wh) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })} kWh`, { bold: true });
    if (s.stop_reason) f.row('Stopped by', s.stop_reason);
    if (mv.length) f.row('Meter readings', `${Number(mv[0].value).toLocaleString('en-US')} → ${Number(mv.at(-1).value).toLocaleString('en-US')} ${mv[0].unit ?? 'Wh'} (${mv.length} readings, ${ts(mv[0].ts)} to ${ts(mv.at(-1).ts)})`);
    f.row('Authorised with', `${s.token_kind ?? 'token'} ${mask(s.token_uid)}`);
    if (s.driver_name || s.driver_email || s.driver_phone) f.row('Customer', `${s.driver_name ?? ''} ${s.driver_email ? `· ${mask(s.driver_email)}` : ''} ${s.driver_phone ? `· ${mask(s.driver_phone)}` : ''}`.trim());
  }
  if (cdr) {
    f.heading('The charge record (receipt)');
    const ls = Array.isArray(cdr.lines) ? cdr.lines : [];
    if (ls.length) f.table([{ label: 'Line', width: 3 }, { label: 'Quantity', width: 1.4, align: 'right' }, { label: 'Amount', width: 1.8, align: 'right' }],
      ls.map((l: any) => ({ cells: [String(l.description ?? l.kind ?? ''), l.quantity != null ? `${l.quantity} ${l.unit ?? ''}` : '', money(l.amountMinor, cdr.currency)] })), { size: 8.5 });
    f.row('Subtotal', money(cdr.subtotal_minor, cdr.currency)); f.row('Tax', money(cdr.tax_minor, cdr.currency)); f.row('Total', money(cdr.total_minor, cdr.currency), { bold: true }); f.row('Issued', ts(cdr.issued_at));
  }
  f.gap(10);
  f.para('The charger\'s meter readings are recorded as the charger reports them over OCPP; the charge record is issued from them under the tariff in force. Personal details are masked.', { size: 8.5, color: [0.36, 0.39, 0.44] });
  return doc.toBuffer();
}

/** Fraud signals over the last 90 days. */
export async function signals(orgId: string, now = new Date()) {
  const from = addDays(today(now), -90);
  const [repeat, both, bursts, rates] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT t.id AS token_id, t.uid, t.status, cs.driver_id, d.name AS driver_name, count(*)::int AS n, sum(c.amount_minor)::bigint AS amount, min(c.currency) AS currency
         FROM chargeback c JOIN payment_intent p ON p.id = c.payment_intent_id JOIN charging_session cs ON cs.id = p.session_id LEFT JOIN token t ON t.id = cs.token_id LEFT JOIN driver d ON d.id = cs.driver_id
        WHERE c.org_id = $1 AND c.received_on >= $2::date GROUP BY 1, 2, 3, 4, 5 HAVING count(*) >= 2 ORDER BY n DESC LIMIT 50`, [orgId, from])),
    outsideRequestScope(() => many<any>(
      `SELECT c.id, c.case_ref, c.provider, c.currency, c.amount_minor, p.refunded_minor, p.provider_ref FROM chargeback c JOIN payment_intent p ON p.id = c.payment_intent_id
        WHERE c.org_id = $1 AND c.received_on >= $2::date AND COALESCE(p.refunded_minor, 0) > 0 ORDER BY c.received_on DESC LIMIT 50`, [orgId, from])),
    outsideRequestScope(() => many<any>(
      `SELECT p.connector_uuid, COALESCE(cp.display_name, cp.ocpp_identity) AS charger, s.name AS site, (p.created_at AT TIME ZONE $3)::date::text AS day, count(*)::int AS n
         FROM payment_intent p LEFT JOIN connector cn ON cn.id = p.connector_uuid LEFT JOIN evse e ON e.id = cn.evse_uuid LEFT JOIN charge_point cp ON cp.id = e.charge_point_id LEFT JOIN site s ON s.id = cp.site_id
        WHERE p.org_id = $1 AND p.created_at >= $2::date AND p.state IN ('failed', 'expired') AND p.connector_uuid IS NOT NULL AND NOT COALESCE(p.test_mode, false)
        GROUP BY 1, 2, 3, 4 HAVING count(*) >= 5 ORDER BY n DESC LIMIT 50`, [orgId, from, zone()])),
    outsideRequestScope(() => many<any>(
      `SELECT p.method, count(DISTINCT p.id) FILTER (WHERE p.state = 'captured' OR p.captured_at IS NOT NULL)::int AS payments, count(DISTINCT c.id)::int AS chargebacks
         FROM payment_intent p LEFT JOIN chargeback c ON c.payment_intent_id = p.id
        WHERE p.org_id = $1 AND p.created_at >= $2::date AND NOT COALESCE(p.test_mode, false) GROUP BY 1 ORDER BY 1`, [orgId, from])),
  ]);
  return {
    from,
    repeat: repeat.map((r) => ({ tokenId: r.token_id ?? null, token: r.uid ? mask(r.uid) : null, tokenBlocked: r.status === 'Blocked', driverId: r.driver_id ?? null, driver: r.driver_name ?? null, chargebacks: r.n, amount: Number(r.amount), currency: r.currency })),
    refundedAndChargedBack: both.map((r) => ({ id: String(r.id), caseRef: r.case_ref, provider: r.provider, currency: r.currency, amount: Number(r.amount_minor), refunded: Number(r.refunded_minor), paymentRef: r.provider_ref })),
    failedBursts: bursts.map((r) => ({ connectorId: r.connector_uuid, charger: r.charger ?? null, site: r.site ?? null, day: r.day, failed: r.n })),
    rates: rates.filter((r) => r.payments > 0 || r.chargebacks > 0).map((r) => { const pct = r.payments ? Math.round((r.chargebacks / r.payments) * 10000) / 100 : null; return { method: r.method, payments: r.payments, chargebacks: r.chargebacks, ratePct: pct, overThreshold: pct != null && pct >= RATE_THRESHOLD_PCT && r.chargebacks >= 2 }; }),
    thresholdPct: RATE_THRESHOLD_PCT,
  };
}

/** The month's journal lines per currency (the ledger's 'chargebacks' source). */
export async function journal(orgId: string, month: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT c.*, to_char(c.received_on, 'YYYY-MM') AS rm, to_char(c.outcome_on, 'YYYY-MM') AS om FROM chargeback c WHERE c.org_id = $1 AND (to_char(c.received_on, 'YYYY-MM') = $2 OR to_char(c.outcome_on, 'YYYY-MM') = $2)`, [orgId, month]));
  const out: Record<string, Array<{ account: string; debit: number; credit: number; description: string }>> = {};
  for (const c of rows) {
    const L = (out[c.currency] ??= []), amt = Number(c.amount_minor), fee = Number(c.fee_minor), d = `Chargeback ${c.provider} ${c.case_ref}`;
    if (c.rm === month) {
      L.push({ account: '1190', debit: amt, credit: 0, description: d }, { account: '1130', debit: 0, credit: amt, description: d });
      if (fee) L.push({ account: '6110', debit: fee, credit: 0, description: `${d} fee` }, { account: '1130', debit: 0, credit: fee, description: `${d} fee` });
    }
    if (c.om === month && c.status === 'won') L.push({ account: '1130', debit: amt, credit: 0, description: `${d} won` }, { account: '1190', debit: 0, credit: amt, description: `${d} won` });
    if (c.om === month && (c.status === 'lost' || c.status === 'accepted')) L.push({ account: '6520', debit: amt, credit: 0, description: `${d} ${c.status}` }, { account: '1190', debit: 0, credit: amt, description: `${d} ${c.status}` });
  }
  return out;
}

export async function listXlsx(orgId: string): Promise<Buffer> {
  const [l, s] = await Promise.all([list(orgId), signals(orgId)]);
  return xlsx([
    { name: 'Chargebacks', rows: [['Provider', 'Case', 'Payment', 'Method', 'Reason', 'Code', 'Currency', 'Amount', 'Fee', 'Received', 'Respond by', 'Status', 'Evidence sent', 'Outcome on', 'Also refunded', 'Site', 'Token'],
      ...l.chargebacks.map((c) => [c.provider, c.caseRef, c.paymentRef ?? '', c.method ?? '', c.reason, c.reasonCode ?? '', c.currency, c.amount, c.fee, c.receivedOn, c.respondBy, c.status, c.evidenceSentOn ?? '', c.outcomeOn ?? '', c.alsoRefunded ? c.refunded : '', c.site ?? '', c.token ?? ''])],
      widths: [10, 16, 20, 10, 14, 8, 8, 14, 10, 11, 11, 16, 11, 11, 12, 20, 14], formats: [null, null, null, null, null, null, null, 'money', 'money', null, null, null, null, null, 'money', null, null] },
    { name: 'Rates', rows: [['Method', 'Payments', 'Chargebacks', 'Rate %'], ...s.rates.map((r) => [r.method, r.payments, r.chargebacks, r.ratePct])], widths: [14, 10, 12, 8] },
    { name: 'Repeat tokens', rows: [['Token', 'Driver', 'Chargebacks', 'Currency', 'Amount', 'Blocked'], ...s.repeat.map((r) => [r.token ?? '', r.driver ?? '', r.chargebacks, r.currency, r.amount, r.tokenBlocked ? 'yes' : ''])], widths: [16, 22, 12, 8, 14, 8] },
  ]);
}

/** Every 6 hours: deadlines (3 days ahead, critical once past) and the chargeback rate per method. */
export async function sweep(now = new Date()): Promise<number> {
  const t = today(now);
  const rows = await outsideRequestScope(() => many<any>(`SELECT id, org_id, provider, case_ref, currency, amount_minor, to_char(respond_by, 'YYYY-MM-DD') AS by_s FROM chargeback WHERE status = 'open' AND respond_by <= $1::date + 3`, [t]));
  let n = 0;
  for (const r of rows) {
    try {
      const left = days(t, r.by_s);
      await outsideRequestScope(() => persistAlert({ orgId: r.org_id, kind: DUE, severity: left < 0 ? 'critical' : 'warning', targetType: 'chargeback', targetId: String(r.id),
        message: `${r.provider} chargeback ${r.case_ref} (${r.currency} ${Number(r.amount_minor).toLocaleString('en-US')}): ${left < 0 ? `the deadline was ${r.by_s}` : `respond by ${r.by_s} (${left} days)`}. Finance → Chargebacks.` }));
      n++;
    } catch (e) { logger.warn({ chargeback: r.id, err: (e as Error).message }, 'chargeback deadline sweep failed'); }
  }
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(`SELECT DISTINCT org_id FROM chargeback WHERE received_on >= $1::date - 90`, [t]));
  for (const o of orgs) {
    try {
      const s = await signals(o.org_id, now);
      const over = s.rates.filter((r) => r.overThreshold);
      if (over.length) await outsideRequestScope(() => persistAlert({ orgId: o.org_id, kind: RATE, severity: 'warning', targetType: 'organisation', targetId: o.org_id,
        message: `Chargebacks are at ${over.map((r) => `${r.ratePct}% of ${r.method} payments`).join(', ')} over 90 days (the card schemes act from about ${RATE_THRESHOLD_PCT}%). Finance → Chargebacks → Fraud.` }));
      else await outsideRequestScope(() => resolveAlertsFor(o.org_id, RATE, 'organisation', o.org_id)).catch(() => 0);
    } catch (e) { logger.warn({ org: o.org_id, err: (e as Error).message }, 'chargeback rate sweep failed'); }
  }
  return n;
}
