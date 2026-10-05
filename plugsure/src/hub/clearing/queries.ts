import { many, one, outsideRequestScope } from '../../db/pool.js';
import { HubError } from '../errors.js';

/**
 * Read models of the clearing API, shared by the platform routes (/v1/hub/clearing/*, unscoped) and the member
 * routes (/v1/roaming/hub/clearing/*, which run INSIDE the member's request scope: row-level security admits
 * only the member's own rows, and every query also filters by the member explicitly — defence in depth).
 *
 * Amounts: integers in minor units of the row's `currency`. Dates (DATE columns) as 'YYYY-MM-DD'; instants ISO.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOr = (v: unknown) => (typeof v === 'string' && UUID_RE.test(v) ? v : null);

/** Labels come from the CDR itself (the counterparty's hub_party row is not visible to a member). */
export const CDR_COLS = `c.id, c.cdr_id, c.session_id, c.credit, c.credit_reference_id, c.credits_cdr_id, c.credited_by_cdr_id, c.currency,
  c.total_excl_minor, c.total_incl_minor, c.energy_kwh::float8 AS energy_kwh, c.start_at, c.end_at, c.location_country, c.location_id, c.evse_uid,
  c.auth_method, c.authorization_reference, c.token_type, c.contract_id, c.flags, c.status, c.dispute_deadline, c.accepted_at, c.forward_state,
  c.fee_cpo_minor, c.fee_emsp_minor, c.settlement_run_id, c.hold_note, c.source, c.received_at, c.updated_at, c.agreement_id,
  c.cpo_party_id, c.emsp_party_id, c.cpo_member_id, c.emsp_member_id, c.cpo_org_id, c.emsp_org_id,
  (c.body->>'country_code') || '*' || (c.body->>'party_id') AS cpo,
  (c.body->'cdr_token'->>'country_code') || '*' || (c.body->'cdr_token'->>'party_id') AS emsp,
  (SELECT d.id FROM hub_dispute d WHERE d.hub_cdr_id = c.id ORDER BY d.created_at DESC LIMIT 1) AS dispute_id`;

export interface CdrFilter {
  status?: string; flag?: string; currency?: string; cpoMember?: string; emspMember?: string; member?: string; agreement?: string; run?: string;
  from?: string; to?: string; q?: string; side?: 'cpo' | 'emsp' | null; cursor?: string; limit?: number; unsettled?: boolean;
}

export function cdrFilterFrom(q: Record<string, unknown>): CdrFilter {
  const s = (k: string) => (typeof q[k] === 'string' && (q[k] as string) !== '' ? String(q[k]).slice(0, 100) : undefined);
  return {
    status: s('status'), flag: s('flag'), currency: s('currency'), cpoMember: uuidOr(q.cpo_member) ?? undefined, emspMember: uuidOr(q.emsp_member) ?? undefined,
    member: uuidOr(q.member) ?? undefined, agreement: uuidOr(q.agreement) ?? undefined, run: uuidOr(q.run) ?? undefined, from: s('from'), to: s('to'), q: s('q'),
    side: q.side === 'cpo' || q.side === 'emsp' ? q.side : null, cursor: s('cursor'), limit: Math.min(500, Math.max(1, Number(q.limit ?? 100) || 100)),
    unsettled: q.unsettled === 'true' || q.unsettled === true,
  };
}

const encCursor = (r: { received_at: Date | string; id: string }) => Buffer.from(`${new Date(r.received_at).toISOString()}|${r.id}`).toString('base64url');
function decCursor(c: string | undefined): { at: string; id: string } | null {
  if (!c) return null;
  const [at, id] = Buffer.from(c, 'base64url').toString().split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !UUID_RE.test(id)) throw new HubError(400, 2001, 'malformed cursor');
  return { at, id };
}
const isoOr = (v: string | undefined, what: string) => {
  if (v == null) return null;
  if (Number.isNaN(Date.parse(v))) throw new HubError(400, 2001, `${what}: an ISO date or date-time`);
  return v;
};

/** The ledger, newest first, keyset-paged. `memberId` set = a member's own view (both sides, or one side). */
export async function listCdrs(f: CdrFilter, memberId: string | null = null) {
  const cur = decCursor(f.cursor);
  const p: unknown[] = [];
  const w: string[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); w.push(sql.replace(/\$\?/g, `$${p.length}`)); };
  if (memberId) {
    if (f.side === 'cpo') add('c.cpo_member_id = $?', memberId);
    else if (f.side === 'emsp') add('c.emsp_member_id = $?', memberId);
    else add('(c.cpo_member_id = $? OR c.emsp_member_id = $?)', memberId);
  }
  if (f.status) add('c.status = ANY(string_to_array($?, \',\'))', f.status);
  if (f.flag) add('$? = ANY(c.flags)', f.flag);
  if (f.currency) add('c.currency = $?', f.currency);
  if (f.cpoMember) add('c.cpo_member_id = $?', f.cpoMember);
  if (f.emspMember) add('c.emsp_member_id = $?', f.emspMember);
  if (f.member) add('(c.cpo_member_id = $? OR c.emsp_member_id = $?)', f.member);
  if (f.agreement) add('c.agreement_id = $?', f.agreement);
  if (f.run) add('c.settlement_run_id = $?', f.run);
  if (f.unsettled) w.push('c.settlement_run_id IS NULL');
  const from = isoOr(f.from, 'from'), to = isoOr(f.to, 'to');
  if (from) add('c.received_at >= $?::timestamptz', from);
  if (to) add('c.received_at < $?::timestamptz', to);
  if (f.q) add('(c.cdr_id ILIKE $? OR c.session_id ILIKE $?)', `%${f.q.replace(/[%_\\]/g, (x) => `\\${x}`)}%`);
  if (cur) { p.push(cur.at, cur.id); w.push(`(c.received_at, c.id) < ($${p.length - 1}::timestamptz, $${p.length}::uuid)`); }
  p.push(f.limit ?? 100);
  const rows = await many(`SELECT ${CDR_COLS} FROM hub_cdr c ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY c.received_at DESC, c.id DESC LIMIT $${p.length}`, p);
  return { cdrs: rows, next_cursor: rows.length === (f.limit ?? 100) ? encCursor(rows[rows.length - 1]!) : null };
}

export async function getCdr(id: string, memberId: string | null = null) {
  if (!UUID_RE.test(id)) return null;
  const c = await one(`SELECT ${CDR_COLS}, c.body, c.routing FROM hub_cdr c WHERE c.id = $1 ${memberId ? 'AND (c.cpo_member_id = $2 OR c.emsp_member_id = $2)' : ''}`, memberId ? [id, memberId] : [id]);
  if (!c) return null;
  const disputes = await many(`SELECT ${DISPUTE_COLS} FROM hub_dispute d WHERE d.hub_cdr_id = $1 ORDER BY d.created_at`, [id]);
  const related = await many(`SELECT id, cdr_id, credit, status, total_excl_minor, total_incl_minor FROM hub_cdr WHERE id = ANY($1::uuid[])`,
    [[c.credits_cdr_id, c.credited_by_cdr_id].filter(Boolean)]);
  return { cdr: c, disputes, related };
}

export const DISPUTE_COLS = `d.id, d.hub_cdr_id, d.cpo_member_id, d.emsp_member_id, d.cpo_org_id, d.emsp_org_id, d.raised_by, d.reason, d.currency, d.claimed_minor,
  d.message, d.status, d.resolution, d.respond_by, d.credit_due_by, d.escalate_by, d.credit_cdr_id, d.created_at, d.updated_at, d.resolved_at,
  (SELECT cdr_id FROM hub_cdr x WHERE x.id = d.hub_cdr_id) AS cdr_id`;

export async function listDisputes(q: Record<string, unknown>, memberId: string | null = null) {
  const p: unknown[] = [];
  const w: string[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); w.push(sql.replace(/\$\?/g, `$${p.length}`)); };
  if (memberId) {
    if (q.side === 'cpo') add('d.cpo_member_id = $?', memberId);
    else if (q.side === 'emsp') add('d.emsp_member_id = $?', memberId);
    else add('(d.cpo_member_id = $? OR d.emsp_member_id = $?)', memberId);
  }
  if (typeof q.status === 'string' && q.status) add('d.status = ANY(string_to_array($?, \',\'))', q.status);
  const mem = uuidOr(q.member);
  if (mem) add('(d.cpo_member_id = $? OR d.emsp_member_id = $?)', mem);
  const cdr = uuidOr(q.cdr);
  if (cdr) add('d.hub_cdr_id = $?', cdr);
  return many(`SELECT ${DISPUTE_COLS} FROM hub_dispute d ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY d.created_at DESC LIMIT 500`, p);
}

export async function getDispute(id: string, memberId: string | null = null) {
  if (!UUID_RE.test(id)) return null;
  const d = await one(`SELECT ${DISPUTE_COLS} FROM hub_dispute d WHERE d.id = $1 ${memberId ? 'AND (d.cpo_member_id = $2 OR d.emsp_member_id = $2)' : ''}`, memberId ? [id, memberId] : [id]);
  if (!d) return null;
  return { dispute: d, notes: await many(`SELECT id, side, kind, author_id, body, created_at FROM hub_dispute_note WHERE dispute_id = $1 ORDER BY id`, [id]) };
}

export const POSITION_COLS = `p.id, p.run_id, p.currency, p.member_a_id, p.member_b_id, p.org_a_id, p.org_b_id, p.a_owes_b_minor, p.b_owes_a_minor, p.net_minor,
  p.payer_member_id, p.payee_member_id, p.cdr_count, p.paid_minor, (p.net_minor - p.paid_minor) AS outstanding_minor, p.status,
  to_char(p.due_date, 'YYYY-MM-DD') AS due_date, to_char(p.overdue_since, 'YYYY-MM-DD') AS overdue_since, p.reminders_sent, p.created_at, p.updated_at,
  (SELECT s.period FROM hub_statement s WHERE s.run_id = p.run_id LIMIT 1) AS period`;

export async function listPositions(q: Record<string, unknown>, memberId: string | null = null) {
  const p: unknown[] = [];
  const w: string[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); w.push(sql.replace(/\$\?/g, `$${p.length}`)); };
  if (memberId) add('(p.member_a_id = $? OR p.member_b_id = $?)', memberId);
  const mem = uuidOr(q.member);
  if (mem) add('(p.member_a_id = $? OR p.member_b_id = $?)', mem);
  const run = uuidOr(q.run);
  if (run) add('p.run_id = $?', run);
  if (typeof q.status === 'string' && q.status) add('p.status = ANY(string_to_array($?, \',\'))', q.status);
  if (typeof q.currency === 'string' && q.currency) add('p.currency = $?', q.currency);
  return many(`SELECT ${POSITION_COLS} FROM hub_settlement_position p ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY p.created_at DESC, p.id LIMIT 500`, p);
}

export const PAYMENT_COLS = `y.id, y.position_id, y.payer_member_id, y.payee_member_id, y.currency, y.amount_minor, y.method, y.reference,
  to_char(y.paid_at, 'YYYY-MM-DD') AS paid_at, y.recorded_by, y.recorded_side, y.confirmed_by_payee_at, y.note, y.created_at`;

export async function listPayments(q: Record<string, unknown>, memberId: string | null = null) {
  const p: unknown[] = [];
  const w: string[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); w.push(sql.replace(/\$\?/g, `$${p.length}`)); };
  if (memberId) add('(y.payer_member_id = $? OR y.payee_member_id = $?)', memberId);
  const pos = uuidOr(q.position);
  if (pos) add('y.position_id = $?', pos);
  const mem = uuidOr(q.member);
  if (mem) add('(y.payer_member_id = $? OR y.payee_member_id = $?)', mem);
  return many(`SELECT ${PAYMENT_COLS} FROM hub_payment y ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY y.created_at DESC LIMIT 500`, p);
}

export const STATEMENT_COLS = `s.id, s.run_id, s.member_id, s.currency, s.period, s.period_start, s.period_end, s.number, s.receivable_minor, s.payable_minor,
  s.net_minor, s.fee_net_minor, s.fee_invoice_id, s.cdr_count, s.issued_at`;

export async function listStatements(q: Record<string, unknown>, memberId: string | null = null) {
  const p: unknown[] = [];
  const w: string[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); w.push(sql.replace(/\$\?/g, `$${p.length}`)); };
  if (memberId) add('s.member_id = $?', memberId);
  const mem = uuidOr(q.member);
  if (mem) add('s.member_id = $?', mem);
  const run = uuidOr(q.run);
  if (run) add('s.run_id = $?', run);
  if (typeof q.currency === 'string' && q.currency) add('s.currency = $?', q.currency);
  if (typeof q.period === 'string' && q.period) add('s.period = $?', q.period);
  return many(`SELECT ${STATEMENT_COLS} FROM hub_statement s ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY s.issued_at DESC, s.number DESC LIMIT 500`, p);
}

export async function getStatement(id: string, memberId: string | null = null) {
  if (!UUID_RE.test(id)) return null;
  return one(`SELECT ${STATEMENT_COLS}, s.data FROM hub_statement s WHERE s.id = $1 ${memberId ? 'AND s.member_id = $2' : ''}`, memberId ? [id, memberId] : [id]);
}

export const INVOICE_COLS = `i.id, i.member_id, i.entity_country, i.run_id, i.currency, i.number, i.net_minor, i.tax_scheme, i.tax_rate_bps, i.tax_base_minor,
  i.tax_minor, i.total_minor, i.wht_expected_minor, i.status, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.issued_at,
  to_char(i.paid_at, 'YYYY-MM-DD') AS paid_at, i.paid_reference`;

export async function listInvoices(q: Record<string, unknown>, memberId: string | null = null) {
  const p: unknown[] = [];
  const w: string[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); w.push(sql.replace(/\$\?/g, `$${p.length}`)); };
  if (memberId) add('i.member_id = $?', memberId);
  const mem = uuidOr(q.member);
  if (mem) add('i.member_id = $?', mem);
  const run = uuidOr(q.run);
  if (run) add('i.run_id = $?', run);
  if (typeof q.status === 'string' && q.status) add('i.status = $?', q.status);
  return many(`SELECT ${INVOICE_COLS} FROM hub_fee_invoice i ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY i.issued_at DESC, i.number DESC LIMIT 500`, p);
}

export async function getInvoice(id: string, memberId: string | null = null) {
  if (!UUID_RE.test(id)) return null;
  return one(`SELECT ${INVOICE_COLS}, i.data FROM hub_fee_invoice i WHERE i.id = $1 ${memberId ? 'AND i.member_id = $2' : ''}`, memberId ? [id, memberId] : [id]);
}

/** Names of members (the hub directory: legal name and country are shared with every member). Unscoped read. */
export async function memberDirectory(ids: Array<string | null | undefined>): Promise<Record<string, { name: string; country: string }>> {
  const list = [...new Set(ids.filter((x): x is string => !!x && UUID_RE.test(x)))];
  if (!list.length) return {};
  const rows = await outsideRequestScope(() => many<{ id: string; legal_name: string; country_code: string }>(`SELECT id, legal_name, country_code FROM hub_member WHERE id = ANY($1::uuid[])`, [list]));
  return Object.fromEntries(rows.map((r) => [r.id, { name: r.legal_name, country: r.country_code }]));
}

export const FEE_PLAN_COLS = `id, name, currency, cpo_bps, cpo_fixed_minor, cpo_min_minor, cpo_max_minor, emsp_bps, emsp_fixed_minor, emsp_min_minor, emsp_max_minor,
  is_default, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, notes, created_at, updated_at`;
