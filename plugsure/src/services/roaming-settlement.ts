import { many, one, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { LEGACY_CURRENCY } from '../domain/money.js';

/**
 * Roaming settlement finance (v1.25.0). With each roaming partner (a peer over OCPI: an eMSP whose drivers charge
 * at our chargers, a CPO whose chargers our drivers use; not a hub or an authority), for a month and a currency:
 *
 *   receivable   what the partner owes us: our charge records (cdr.total_minor) of sessions its drivers started
 *                (charging_session.ocpi_partner_id), by the session's end in the billing zone
 *   payable      what we owe it: its charge records of our drivers (ocpi_remote_cdr, accepted), total incl. VAT,
 *                converted from its major units (currency_unit.exponent), by the record's end
 *   net          receivable − payable: positive, the partner pays us; negative, we pay it
 *
 * Finalising freezes the month's figures with a number (RS-…) as the settlement statement both sides agree.
 * Payments received from or paid to the partner are recorded against it (never deleted: voided with a reason),
 * and appear in bank reconciliation as 'roaming_payment'. Amounts are never added across currencies.
 */

export class RoamingSettlementError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const localDay = (t: Date | number = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(new Date(t));
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
export const PEER_KINDS = ['emsp', 'cpo'];

export function lastMonth(now = new Date()): string {
  let [y, m] = localDay(now).slice(0, 7).split('-').map(Number) as [number, number];
  m--; if (m === 0) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
function monthOf(raw: unknown): string {
  const m = raw == null || raw === '' ? lastMonth() : String(raw);
  if (!MONTH_RE.test(m)) throw new RoamingSettlementError(422, 'month is YYYY-MM.');
  return m;
}

interface Figure { partnerId: string; currency: string; receivable: number; payable: number; receivableCdrs: number; payableCdrs: number }

/** The live figures of a month, per partner and currency. */
async function figures(orgId: string, month: string, partnerId: string | null = null): Promise<Figure[]> {
  const [rec, pay] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT cs.ocpi_partner_id AS partner_id, d.currency, sum(d.total_minor)::bigint AS minor, count(*)::int AS n
         FROM charging_session cs JOIN cdr d ON d.session_id = cs.id JOIN ocpi_partner p ON p.id = cs.ocpi_partner_id
        WHERE cs.org_id = $1 AND p.kind = ANY($4::text[]) AND ($3::uuid IS NULL OR cs.ocpi_partner_id = $3::uuid) AND d.test_mode IS NOT TRUE
          AND to_char(COALESCE(cs.ended_at, d.issued_at) AT TIME ZONE $5, 'YYYY-MM') = $2
        GROUP BY 1, 2`, [orgId, month, partnerId, PEER_KINDS, zone()])),
    outsideRequestScope(() => many<any>(
      `SELECT r.partner_id, r.currency, round(sum(COALESCE(r.total_incl_vat, r.total_excl_vat) * power(10, COALESCE(cu.exponent, 0))))::bigint AS minor, count(*)::int AS n
         FROM ocpi_remote_cdr r JOIN ocpi_partner p ON p.id = r.partner_id LEFT JOIN currency_unit cu ON cu.code = r.currency
        WHERE r.org_id = $1 AND r.status = 'accepted' AND p.kind = ANY($4::text[]) AND ($3::uuid IS NULL OR r.partner_id = $3::uuid)
          AND to_char(r.end_date_time AT TIME ZONE $5, 'YYYY-MM') = $2
        GROUP BY 1, 2`, [orgId, month, partnerId, PEER_KINDS, zone()])),
  ]);
  const map = new Map<string, Figure>();
  const at = (p: string, c: string) => {
    const k = `${p}|${c}`;
    if (!map.has(k)) map.set(k, { partnerId: p, currency: c, receivable: 0, payable: 0, receivableCdrs: 0, payableCdrs: 0 });
    return map.get(k)!;
  };
  for (const r of rec) { const f = at(r.partner_id, r.currency); f.receivable = Number(r.minor); f.receivableCdrs = r.n; }
  for (const r of pay) { const f = at(r.partner_id, r.currency); f.payable = Number(r.minor); f.payableCdrs = r.n; }
  return [...map.values()];
}

async function settled(orgId: string, ids: string[]) {
  if (!ids.length) return new Map<string, { received: number; paid: number }>();
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT settlement_id, COALESCE(sum(amount_minor) FILTER (WHERE direction = 'received'), 0)::bigint AS rec, COALESCE(sum(amount_minor) FILTER (WHERE direction = 'paid'), 0)::bigint AS paid
       FROM roaming_settlement_payment WHERE org_id = $1 AND settlement_id = ANY($2::bigint[]) AND voided_at IS NULL GROUP BY 1`, [orgId, ids]));
  return new Map(rows.map((r) => [String(r.settlement_id), { received: Number(r.rec), paid: Number(r.paid) }]));
}

/** What is left to settle on a finalised settlement, in its direction. */
function balance(net: number, received: number, paid: number) {
  // Net > 0: the partner owes us |net|; what it paid in, less anything we paid back, settles it. Net < 0: the reverse.
  const settledAmount = net >= 0 ? received - paid : paid - received;
  const outstanding = Math.max(0, Math.abs(net) - settledAmount);
  return { direction: net > 0 ? 'receive' : net < 0 ? 'pay' : 'none', settled: settledAmount, outstanding, status: net === 0 ? 'nil' : outstanding === 0 ? 'settled' : settledAmount > 0 ? 'partial' : 'open' };
}

const settlementView = (s: any, pay?: { received: number; paid: number }) => {
  const p = pay ?? { received: 0, paid: 0 };
  return {
    id: String(s.id), number: s.number, month: s.month, currency: s.currency, receivable: Number(s.receivable_minor), payable: Number(s.payable_minor), net: Number(s.net_minor),
    receivableCdrs: s.receivable_cdrs, payableCdrs: s.payable_cdrs, finalisedAt: iso(s.finalised_at), finalisedBy: s.by_name ?? null,
    received: p.received, paid: p.paid, ...balance(Number(s.net_minor), p.received, p.paid),
  };
};

/** Every peer partner for a month (default last month): the live figures, and the settlement if finalised. */
export async function overview(orgId: string, monthRaw?: unknown) {
  const month = monthOf(monthRaw);
  const [partners, figs, fin] = await Promise.all([
    outsideRequestScope(() => many<any>(`SELECT id, name, kind, country_code, party_id, state FROM ocpi_partner WHERE org_id = $1 AND kind = ANY($2::text[]) ORDER BY name`, [orgId, PEER_KINDS])),
    figures(orgId, month),
    outsideRequestScope(() => many<any>(`SELECT s.*, u.name AS by_name FROM roaming_settlement s LEFT JOIN app_user u ON u.id = s.finalised_by WHERE s.org_id = $1 AND s.month = $2`, [orgId, month])),
  ]);
  const pays = await settled(orgId, fin.map((s) => String(s.id)));
  const rows: any[] = [];
  for (const p of partners) {
    const curs = new Set([...figs.filter((f) => f.partnerId === p.id).map((f) => f.currency), ...fin.filter((s) => s.partner_id === p.id).map((s) => s.currency)]);
    for (const c of [...curs].sort()) {
      const f = figs.find((x) => x.partnerId === p.id && x.currency === c) ?? { receivable: 0, payable: 0, receivableCdrs: 0, payableCdrs: 0 };
      const s = fin.find((x) => x.partner_id === p.id && x.currency === c);
      const live = { receivable: f.receivable, payable: f.payable, net: f.receivable - f.payable, receivableCdrs: f.receivableCdrs, payableCdrs: f.payableCdrs };
      const sv = s ? settlementView(s, pays.get(String(s.id))) : null;
      rows.push({
        partner: { id: p.id, name: p.name, kind: p.kind, party: p.country_code && p.party_id ? `${p.country_code}*${p.party_id}` : null },
        currency: c, live, settlement: sv,
        // Late records: the partner's (or ours) arrived after finalising, so the frozen figures differ from today's.
        drift: sv ? live.net - sv.net : 0,
      });
    }
  }
  const totals: Record<string, { receivable: number; payable: number; net: number; outstandingIn: number; outstandingOut: number }> = {};
  for (const r of rows) {
    const t = (totals[r.currency] ??= { receivable: 0, payable: 0, net: 0, outstandingIn: 0, outstandingOut: 0 });
    const src = r.settlement ?? r.live;
    t.receivable += src.receivable; t.payable += src.payable; t.net += src.net;
    if (r.settlement?.direction === 'receive') t.outstandingIn += r.settlement.outstanding;
    if (r.settlement?.direction === 'pay') t.outstandingOut += r.settlement.outstanding;
  }
  return { month, ended: month < localDay().slice(0, 7), rows, totals };
}

/** One partner's month: the figures with the charge records behind them (up to 2,000 each side). */
export async function detail(orgId: string, partnerId: string, monthRaw: unknown, currencyRaw: unknown) {
  const month = monthOf(monthRaw);
  if (!UUID_RE.test(partnerId)) throw new RoamingSettlementError(404, 'No such roaming partner.');
  const p = await outsideRequestScope(() => one<any>(`SELECT id, name, kind FROM ocpi_partner WHERE id = $1 AND org_id = $2 AND kind = ANY($3::text[])`, [partnerId, orgId, PEER_KINDS]));
  if (!p) throw new RoamingSettlementError(404, 'No such roaming partner.');
  const currency = currencyRaw ? String(currencyRaw).toUpperCase().slice(0, 3)
    : ((await figures(orgId, month, partnerId)).map((f) => f.currency).sort()[0] ?? LEGACY_CURRENCY);
  const [ours, theirs, s] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT d.id, cs.id AS session_id, to_char(COALESCE(cs.ended_at, d.issued_at) AT TIME ZONE $5, 'YYYY-MM-DD HH24:MI') AS ended, d.total_minor, d.currency, cs.energy_wh, cs.ocpi_authorization_reference AS auth_ref
         FROM charging_session cs JOIN cdr d ON d.session_id = cs.id
        WHERE cs.org_id = $1 AND cs.ocpi_partner_id = $2 AND d.currency = $3 AND d.test_mode IS NOT TRUE AND to_char(COALESCE(cs.ended_at, d.issued_at) AT TIME ZONE $5, 'YYYY-MM') = $4
        ORDER BY 3 LIMIT 2000`, [orgId, partnerId, currency, month, zone()])),
    outsideRequestScope(() => many<any>(
      `SELECT r.cdr_id, to_char(r.end_date_time AT TIME ZONE $5, 'YYYY-MM-DD HH24:MI') AS ended, round(COALESCE(r.total_incl_vat, r.total_excl_vat) * power(10, COALESCE(cu.exponent, 0)))::bigint AS minor, r.total_energy
         FROM ocpi_remote_cdr r LEFT JOIN currency_unit cu ON cu.code = r.currency
        WHERE r.org_id = $1 AND r.partner_id = $2 AND r.currency = $3 AND r.status = 'accepted' AND to_char(r.end_date_time AT TIME ZONE $5, 'YYYY-MM') = $4
        ORDER BY 2 LIMIT 2000`, [orgId, partnerId, currency, month, zone()])),
    outsideRequestScope(() => one<any>(`SELECT s.*, u.name AS by_name FROM roaming_settlement s LEFT JOIN app_user u ON u.id = s.finalised_by WHERE s.org_id = $1 AND s.partner_id = $2 AND s.month = $3 AND s.currency = $4`, [orgId, partnerId, month, currency])),
  ]);
  const pays = s ? await payments(orgId, String(s.id)) : [];
  const live = { receivable: ours.reduce((a, r) => a + Number(r.total_minor), 0), payable: theirs.reduce((a, r) => a + Number(r.minor), 0) };
  return {
    partner: { id: p.id, name: p.name, kind: p.kind }, month, currency,
    live: { ...live, net: live.receivable - live.payable, receivableCdrs: ours.length, payableCdrs: theirs.length },
    settlement: s ? settlementView(s, (await settled(orgId, [String(s.id)])).get(String(s.id))) : null,
    receivable: ours.map((r) => ({ cdrId: r.id, sessionId: r.session_id, ended: r.ended, amount: Number(r.total_minor), kwh: Number(r.energy_wh ?? 0) / 1000, authRef: r.auth_ref ?? null })),
    payable: theirs.map((r) => ({ cdrId: r.cdr_id, ended: r.ended, amount: Number(r.minor), kwh: Number(r.total_energy) })),
    payments: pays,
  };
}

/** Freeze an ended month's figures with a partner in a currency as its settlement statement. */
export async function finalise(orgId: string, partnerId: string, b: { month?: unknown; currency?: unknown }, userId: string | null) {
  const month = String(b.month ?? '');
  if (!MONTH_RE.test(month)) throw new RoamingSettlementError(422, 'month is YYYY-MM.');
  if (month >= localDay().slice(0, 7)) throw new RoamingSettlementError(409, 'Only an ended month can be settled.');
  if (!UUID_RE.test(partnerId)) throw new RoamingSettlementError(404, 'No such roaming partner.');
  const currency = String(b.currency ?? '');
  const p = await outsideRequestScope(() => one<any>(`SELECT id, name, party_id FROM ocpi_partner WHERE id = $1 AND org_id = $2 AND kind = ANY($3::text[])`, [partnerId, orgId, PEER_KINDS]));
  if (!p) throw new RoamingSettlementError(404, 'No such roaming partner.');
  const f = (await figures(orgId, month, partnerId)).find((x) => x.currency === currency);
  if (!f) throw new RoamingSettlementError(422, `No charge records with ${p.name} in ${currency || 'that currency'} for ${month}.`);
  const tag = String(p.party_id ?? p.name).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 6) || 'P';
  const number = `RS-${month.replace('-', '')}-${tag}-${currency}-${String(partnerId).slice(0, 4).toUpperCase()}`;
  try {
    const r = await outsideRequestScope(() => one<any>(
      `INSERT INTO roaming_settlement (org_id, partner_id, month, currency, number, receivable_minor, payable_minor, net_minor, receivable_cdrs, payable_cdrs, data, finalised_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [orgId, partnerId, month, currency, number, f.receivable, f.payable, f.receivable - f.payable, f.receivableCdrs, f.payableCdrs,
        JSON.stringify({ partner: p.name, frozenAt: new Date().toISOString() }), userId]));
    return settlementView(r);
  } catch (e) {
    if ((e as any).code === '23505') throw new RoamingSettlementError(409, `${month} with ${p.name} in ${currency} is already settled.`);
    throw e;
  }
}

async function settlementOf(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new RoamingSettlementError(404, 'No such settlement.');
  const s = await outsideRequestScope(() => one<any>(`SELECT s.*, p.name AS partner_name FROM roaming_settlement s JOIN ocpi_partner p ON p.id = s.partner_id WHERE s.id = $1 AND s.org_id = $2`, [id, orgId]));
  if (!s) throw new RoamingSettlementError(404, 'No such settlement.');
  return s;
}

export async function payments(orgId: string, settlementId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT p.*, to_char(p.paid_on, 'YYYY-MM-DD') AS d, u.name AS by_name, v.name AS voided_by_name FROM roaming_settlement_payment p
       LEFT JOIN app_user u ON u.id = p.recorded_by LEFT JOIN app_user v ON v.id = p.voided_by
      WHERE p.org_id = $1 AND p.settlement_id = $2 ORDER BY p.paid_on DESC, p.id DESC`, [orgId, settlementId]));
  return rows.map((r) => ({
    id: String(r.id), direction: r.direction, amount: Number(r.amount_minor), currency: r.currency, paidOn: r.d, reference: r.reference, note: r.note,
    recordedBy: r.by_name ?? null, recordedAt: iso(r.created_at), voided: Boolean(r.voided_at), voidedBy: r.voided_by_name ?? null, voidReason: r.void_reason ?? null,
  }));
}

/** Record money received from (net > 0) or paid to (net < 0) the partner. More than is outstanding is refused. */
export async function recordPayment(orgId: string, settlementId: string, b: { amount?: unknown; paidOn?: unknown; reference?: unknown; note?: unknown }, userId: string | null) {
  const s = await settlementOf(orgId, settlementId);
  const net = Number(s.net_minor);
  if (net === 0) throw new RoamingSettlementError(409, `${s.number} nets to zero: nothing to settle.`);
  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new RoamingSettlementError(422, 'The amount is a whole number above zero, in minor units.');
  const paidOn = String(b.paidOn ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || Number.isNaN(Date.parse(`${paidOn}T00:00:00Z`))) throw new RoamingSettlementError(422, 'The payment date is YYYY-MM-DD.');
  if (paidOn > localDay(Date.now() + 86_400_000)) throw new RoamingSettlementError(422, 'The payment date is in the future.');
  const reference = String(b.reference ?? '').trim();
  if (!reference || reference.length > 120) throw new RoamingSettlementError(422, 'The bank reference of the transfer is required (up to 120 characters).');
  const note = b.note == null ? null : String(b.note).trim().slice(0, 500) || null;
  const pay = (await settled(orgId, [String(s.id)])).get(String(s.id)) ?? { received: 0, paid: 0 };
  const bal = balance(net, pay.received, pay.paid);
  if (amount > bal.outstanding) throw new RoamingSettlementError(422, `That is more than is outstanding on ${s.number} (${bal.outstanding} ${s.currency} in minor units).`);
  const direction = net > 0 ? 'received' : 'paid';
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO roaming_settlement_payment (org_id, settlement_id, direction, amount_minor, currency, paid_on, reference, note, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`, [orgId, s.id, direction, amount, s.currency, paidOn, reference, note, userId]));
  return { paymentId: String(r!.id), recorded: direction, number: s.number, ...balance(net, pay.received + (direction === 'received' ? amount : 0), pay.paid + (direction === 'paid' ? amount : 0)) };
}

export async function voidPayment(orgId: string, paymentId: string, reasonRaw: unknown, userId: string | null) {
  const reason = String(reasonRaw ?? '').trim();
  if (!reason || reason.length > 300) throw new RoamingSettlementError(422, 'Say why the payment is voided (up to 300 characters).');
  if (!/^\d{1,18}$/.test(paymentId)) throw new RoamingSettlementError(404, 'No such payment.');
  const matched = await outsideRequestScope(() => one(`SELECT 1 FROM bank_statement_line WHERE org_id = $1 AND matched_kind = 'roaming_payment' AND matched_ref = $2`, [orgId, paymentId]));
  if (matched) throw new RoamingSettlementError(409, 'The payment is matched to a bank statement line: undo the match first.');
  const r = await outsideRequestScope(() => one(`UPDATE roaming_settlement_payment SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE id = $1 AND org_id = $2 AND voided_at IS NULL RETURNING id`, [paymentId, orgId, userId, reason]));
  if (!r) throw new RoamingSettlementError(404, 'No such payment, or it is already voided.');
  return { ok: true };
}

/** For bank reconciliation: roaming payments between two dates (received positive, paid negative). */
export async function bankCandidates(orgId: string, from: string, to: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT p.id::text AS ref, to_char(p.paid_on, 'YYYY-MM-DD') AS d, p.amount_minor, p.direction, p.reference, s.number, o.name
       FROM roaming_settlement_payment p JOIN roaming_settlement s ON s.id = p.settlement_id JOIN ocpi_partner o ON o.id = s.partner_id
      WHERE p.org_id = $1 AND p.voided_at IS NULL AND p.paid_on BETWEEN ($2::date - 5) AND ($3::date + 5)`, [orgId, from, to]));
  return rows.map((x) => ({
    kind: 'roaming_payment' as const, ref: x.ref, date: x.d, amount: x.direction === 'received' ? Number(x.amount_minor) : -Number(x.amount_minor),
    label: `Roaming ${x.direction === 'received' ? 'settlement from' : 'settlement to'} ${x.name} · ${x.number}`, reference: x.reference,
  }));
}

export function overviewCsv(o: Awaited<ReturnType<typeof overview>>): string {
  const cell = (v: unknown) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
  const rows = [['month', 'partner', 'kind', 'party', 'currency', 'receivable_minor', 'payable_minor', 'net_minor', 'receivable_cdrs', 'payable_cdrs', 'settlement', 'status', 'outstanding_minor', 'drift_minor']];
  for (const r of o.rows) {
    const src = r.settlement ?? r.live;
    rows.push([o.month, r.partner.name, r.partner.kind, r.partner.party ?? '', r.currency, String(src.receivable), String(src.payable), String(src.net), String(src.receivableCdrs), String(src.payableCdrs),
      r.settlement?.number ?? '', r.settlement?.status ?? 'not finalised', String(r.settlement?.outstanding ?? ''), String(r.drift)]);
  }
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Settlement statement as CSV (both sides' records), for the partner. */
export function detailCsv(d: Awaited<ReturnType<typeof detail>>): string {
  const cell = (v: unknown) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
  const rows = [['side', 'cdr_id', 'ended', 'kwh', 'amount_minor', 'currency']];
  for (const r of d.receivable) rows.push(['partner owes (our records)', r.cdrId, r.ended, String(r.kwh), String(r.amount), d.currency]);
  for (const r of d.payable) rows.push(['we owe (partner records)', r.cdrId, r.ended, String(r.kwh), String(r.amount), d.currency]);
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
