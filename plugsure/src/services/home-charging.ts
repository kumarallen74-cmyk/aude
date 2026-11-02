import { createHash, randomBytes } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { xlsx } from './xlsx.js';

/**
 * Home charging reimbursement (v1.47.0), Finance → Home charging. Employees who charge a company car at home are
 * paid back for the electricity, each month:
 *
 *   home charger  an employee's charger: either an OCPP charger the operator manages (its sessions count, or only the
 *                 employee's card's), or a meter the employee reads (readings: the kWh counter on a date)
 *   rate          the employee's home electricity price per kWh (minor units), with an optional monthly cap
 *   month         ocpp: the kWh of the sessions that started in the month (UTC); readings: the last reading in the
 *                 month minus the last one before it (both needed)
 *   reimbursement drafted per month, approved (finance:approve), then marked paid; the payroll export lists the
 *                 approved ones (payroll number, name, kWh, amount)
 *   employee page a secret link (/home-charging/<token>): the employee sees their months and adds a meter reading
 *
 * A home charger managed over OCPP is not on the public map and is not sold in the driver app.
 */

export class HomeError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const S = <T>(fn: () => T) => outsideRequestScope(fn);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const q3 = (n: number) => Math.round(n * 1000) / 1000;

const chargerOf = (r: any) => ({
  id: String(r.id), employeeName: r.employee_name, employeeEmail: r.employee_email ?? null, employeeRef: r.employee_ref ?? null, address: r.address ?? null,
  mode: r.mode, chargePointId: r.charge_point_id ?? null, charger: r.cp_name ?? null, tokenId: r.token_id ?? null, card: r.token_uid ?? null,
  rateMinorPerKwh: Number(r.rate_minor_per_kwh), monthlyCapMinor: r.monthly_cap_minor == null ? null : Number(r.monthly_cap_minor), currency: r.currency,
  portalLinked: !!r.portal_token_hash, archived: !!r.archived_at,
  lastReading: r.last_read_on ? { readOn: r.last_read_on, kwhTotal: Number(r.last_kwh) } : null,
});

const SELECT = `SELECT h.*, COALESCE(cp.display_name, cp.ocpp_identity) AS cp_name, t.uid AS token_uid,
    (SELECT to_char(read_on, 'YYYY-MM-DD') FROM home_meter_reading r WHERE r.home_charger_id = h.id ORDER BY read_on DESC LIMIT 1) AS last_read_on,
    (SELECT kwh_total FROM home_meter_reading r WHERE r.home_charger_id = h.id ORDER BY read_on DESC LIMIT 1) AS last_kwh
  FROM home_charger h LEFT JOIN charge_point cp ON cp.id = h.charge_point_id LEFT JOIN token t ON t.id = h.token_id`;

async function row(orgId: string, id: string) {
  const r = await S(() => one<any>(`${SELECT} WHERE h.id = $1 AND h.org_id = $2`, [Number(id) || 0, orgId]));
  if (!r) throw new HomeError(404, 'No such home charger.');
  return r;
}

export async function chargers(orgId: string) {
  return (await S(() => many<any>(`${SELECT} WHERE h.org_id = $1 ORDER BY h.archived_at NULLS FIRST, h.employee_name`, [orgId]))).map(chargerOf);
}

export async function save(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await row(orgId, id) : null;
  if (cur && b.archive === true) {
    await S(() => query(`UPDATE home_charger SET archived_at = now(), portal_token_hash = NULL WHERE id = $1`, [cur.id]));
    return { id: String(cur.id), archived: true };
  }
  const v = (k: string, col: string) => (b[k] !== undefined ? b[k] : cur?.[col]);
  const name = String(v('employeeName', 'employee_name') ?? '').trim().slice(0, 120);
  if (!name) throw new HomeError(422, 'employeeName is required.');
  const email = v('employeeEmail', 'employee_email') ? String(v('employeeEmail', 'employee_email')).trim().toLowerCase().slice(0, 200) : null;
  if (email && !EMAIL_RE.test(email)) throw new HomeError(422, 'employeeEmail is not an e-mail address.');
  const ref = v('employeeRef', 'employee_ref') ? String(v('employeeRef', 'employee_ref')).trim().slice(0, 40) : null;
  const address = v('address', 'address') ? String(v('address', 'address')).trim().slice(0, 300) : null;
  const mode = String(v('mode', 'mode') ?? '');
  if (!['ocpp', 'readings'].includes(mode)) throw new HomeError(422, 'mode is ocpp (a charger PlugSure manages) or readings (the employee reads a meter).');
  let cpId: string | null = null, tokenId: string | null = null;
  if (mode === 'ocpp') {
    cpId = String(v('chargePointId', 'charge_point_id') ?? '');
    if (!UUID_RE.test(cpId) || !(await S(() => one(`SELECT 1 FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE cp.id = $1 AND s.org_id = $2`, [cpId, orgId])))) {
      throw new HomeError(422, 'chargePointId: one of the operator\'s chargers.');
    }
    const t = v('tokenId', 'token_id');
    if (t) {
      if (!(await S(() => one(`SELECT 1 FROM token WHERE id = $1 AND org_id = $2`, [String(t), orgId])))) throw new HomeError(422, 'No such card.');
      tokenId = String(t);
    }
  }
  const rate = Number(v('rateMinorPerKwh', 'rate_minor_per_kwh'));
  if (!(Number.isFinite(rate) && rate >= 0 && rate < 1e9)) throw new HomeError(422, 'rateMinorPerKwh is the home electricity price per kWh (minor units).');
  const capRaw = v('monthlyCapMinor', 'monthly_cap_minor');
  const cap = capRaw == null || capRaw === '' ? null : Number(capRaw);
  if (cap != null && !(Number.isSafeInteger(cap) && cap >= 0)) throw new HomeError(422, 'monthlyCapMinor is a whole amount.');
  const currency = String(v('currency', 'currency') ?? '').toUpperCase();
  if (!(await S(() => one(`SELECT 1 FROM currency_unit WHERE code = $1`, [currency])))) throw new HomeError(422, 'currency is a supported currency code.');
  const vals = [orgId, name, email, ref, address, mode, cpId, tokenId, rate, cap, currency];
  try {
    const r = cur
      ? await S(() => one<any>(`UPDATE home_charger SET employee_name = $2, employee_email = $3, employee_ref = $4, address = $5, mode = $6, charge_point_id = $7, token_id = $8,
          rate_minor_per_kwh = $9, monthly_cap_minor = $10, currency = $11 WHERE id = $12 AND org_id = $1 RETURNING id`, [...vals, cur.id]))
      : await S(() => one<any>(`INSERT INTO home_charger (org_id, employee_name, employee_email, employee_ref, address, mode, charge_point_id, token_id, rate_minor_per_kwh, monthly_cap_minor, currency)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, vals));
    return chargerOf(await row(orgId, String(r.id)));
  } catch (e: any) {
    if (e?.code === '23505') throw new HomeError(409, 'That charger is already an employee\'s home charger.');
    throw e;
  }
}

// ------------------------------------------------------------------ readings

export async function addReading(orgId: string, id: string, b: Record<string, unknown>, source: 'console' | 'employee') {
  const h = await row(orgId, id);
  if (h.archived_at) throw new HomeError(409, 'This home charger is archived.');
  if (h.mode !== 'readings') throw new HomeError(409, 'This home charger is read over OCPP.');
  const on = String(b.readOn ?? new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || on > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) throw new HomeError(422, 'readOn is a date (YYYY-MM-DD), not in the future.');
  const kwh = Number(b.kwhTotal);
  if (!(Number.isFinite(kwh) && kwh >= 0 && kwh < 1e9)) throw new HomeError(422, 'kwhTotal is the meter\'s kWh counter.');
  // The counter only goes up: a reading below an earlier one (or above a later one) is a typing error.
  const before = await S(() => one<any>(`SELECT kwh_total FROM home_meter_reading WHERE home_charger_id = $1 AND read_on < $2 ORDER BY read_on DESC LIMIT 1`, [h.id, on]));
  const after = await S(() => one<any>(`SELECT kwh_total FROM home_meter_reading WHERE home_charger_id = $1 AND read_on > $2 ORDER BY read_on LIMIT 1`, [h.id, on]));
  if (before && kwh < Number(before.kwh_total)) throw new HomeError(422, `The meter showed ${Number(before.kwh_total)} kWh earlier: a reading cannot be lower.`);
  if (after && kwh > Number(after.kwh_total)) throw new HomeError(422, `The meter showed ${Number(after.kwh_total)} kWh later: a reading cannot be higher.`);
  await S(() => query(
    `INSERT INTO home_meter_reading (org_id, home_charger_id, read_on, kwh_total, source, note) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (home_charger_id, read_on) DO UPDATE SET kwh_total = EXCLUDED.kwh_total, source = EXCLUDED.source, note = EXCLUDED.note`,
    [orgId, h.id, on, kwh, source, b.note ? String(b.note).slice(0, 300) : null]));
  return readings(orgId, id);
}

export async function readings(orgId: string, id: string) {
  const h = await row(orgId, id);
  return (await S(() => many<any>(`SELECT to_char(read_on, 'YYYY-MM-DD') AS d, kwh_total, source, note FROM home_meter_reading WHERE home_charger_id = $1 ORDER BY read_on DESC LIMIT 60`, [h.id])))
    .map((r) => ({ readOn: r.d, kwhTotal: Number(r.kwh_total), source: r.source, note: r.note ?? null }));
}

// ------------------------------------------------------------------ the month

/** The kWh to pay back for a month, and how it was measured. */
export async function usage(h: any, month: string): Promise<{ kwh: number | null; sessions: number | null; basis: string }> {
  const start = `${month}-01`;
  if (h.mode === 'ocpp') {
    const r = await S(() => one<any>(
      `SELECT count(*) AS n, COALESCE(sum(energy_wh), 0) AS wh FROM charging_session
        WHERE charge_point_id = $1 AND ($2::uuid IS NULL OR token_id = $2) AND state IN ('ended', 'rated', 'active')
          AND started_at >= ($3::date)::timestamp AT TIME ZONE 'UTC' AND started_at < (($3::date + interval '1 month'))::timestamp AT TIME ZONE 'UTC'`,
      [h.charge_point_id, h.token_id, start]));
    return { kwh: q3(Number(r?.wh ?? 0) / 1000), sessions: Number(r?.n ?? 0), basis: h.token_id ? 'sessions with the employee\'s card' : 'all sessions on the charger' };
  }
  const end = await S(() => one<any>(`SELECT kwh_total, read_on FROM home_meter_reading WHERE home_charger_id = $1 AND read_on >= $2::date AND read_on < $2::date + interval '1 month' ORDER BY read_on DESC LIMIT 1`, [h.id, start]));
  const prev = await S(() => one<any>(`SELECT kwh_total, read_on FROM home_meter_reading WHERE home_charger_id = $1 AND read_on < $2::date ORDER BY read_on DESC LIMIT 1`, [h.id, start]));
  if (!end || !prev) return { kwh: null, sessions: null, basis: !end ? 'no reading in the month' : 'no reading before the month' };
  return { kwh: q3(Number(end.kwh_total) - Number(prev.kwh_total)), sessions: null, basis: 'meter readings' };
}

/** The amount for kWh at the rate, under the cap. Pure. */
export function amountFor(kwh: number, rateMinorPerKwh: number, capMinor: number | null) {
  const raw = Math.round(kwh * rateMinorPerKwh);
  return capMinor != null && raw > capMinor ? { amountMinor: capMinor, capped: true } : { amountMinor: raw, capped: false };
}

const reimbOf = (r: any) => ({
  id: String(r.id), homeChargerId: String(r.home_charger_id), employeeName: r.employee_name ?? null, employeeRef: r.employee_ref ?? null, month: r.month,
  kwh: Number(r.kwh), sessions: r.sessions, rateMinorPerKwh: Number(r.rate_minor_per_kwh), amountMinor: Number(r.amount_minor), capped: r.capped, currency: r.currency, status: r.status,
  approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null, paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
});

/** Draft (or redraft) every active home charger's reimbursement for a month. Approved and paid ones stay. */
export async function draft(orgId: string, monthRaw: unknown) {
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month)) throw new HomeError(422, 'month is YYYY-MM.');
  if (month > new Date().toISOString().slice(0, 7)) throw new HomeError(422, 'That month has not started.');
  const hs = await S(() => many<any>(`SELECT * FROM home_charger WHERE org_id = $1 AND archived_at IS NULL`, [orgId]));
  let drafted = 0;
  const missing: Array<{ homeChargerId: string; employeeName: string; why: string }> = [];
  for (const h of hs) {
    const u = await usage(h, month);
    if (u.kwh == null) { missing.push({ homeChargerId: String(h.id), employeeName: h.employee_name, why: u.basis }); continue; }
    const a = amountFor(u.kwh, Number(h.rate_minor_per_kwh), h.monthly_cap_minor == null ? null : Number(h.monthly_cap_minor));
    const r = await S(() => query(
      `INSERT INTO home_reimbursement (org_id, home_charger_id, month, kwh, sessions, rate_minor_per_kwh, amount_minor, capped, currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (home_charger_id, month) DO UPDATE SET kwh = EXCLUDED.kwh, sessions = EXCLUDED.sessions, rate_minor_per_kwh = EXCLUDED.rate_minor_per_kwh,
         amount_minor = EXCLUDED.amount_minor, capped = EXCLUDED.capped, currency = EXCLUDED.currency WHERE home_reimbursement.status = 'draft'`,
      [orgId, h.id, month, u.kwh, u.sessions, h.rate_minor_per_kwh, a.amountMinor, a.capped, h.currency]));
    drafted += r.rowCount ?? 0;
  }
  return { month, drafted, missing, reimbursements: await reimbursements(orgId, month) };
}

export async function reimbursements(orgId: string, month?: string | null, homeChargerId?: string | null) {
  return (await S(() => many<any>(
    `SELECT r.*, h.employee_name, h.employee_ref FROM home_reimbursement r JOIN home_charger h ON h.id = r.home_charger_id
      WHERE r.org_id = $1 AND ($2::text IS NULL OR r.month = $2) AND ($3::bigint IS NULL OR r.home_charger_id = $3) ORDER BY r.month DESC, h.employee_name LIMIT 1000`,
    [orgId, month && MONTH_RE.test(month) ? month : null, homeChargerId ? Number(homeChargerId) || 0 : null]))).map(reimbOf);
}

/** approve (finance:approve, checked by the route) | paid | void. */
export async function setStatus(orgId: string, id: string, action: unknown, userId: string | null) {
  const r = await S(() => one<any>(`SELECT * FROM home_reimbursement WHERE id = $1 AND org_id = $2`, [Number(id) || 0, orgId]));
  if (!r) throw new HomeError(404, 'No such reimbursement.');
  const a = String(action ?? '');
  const from: Record<string, string[]> = { approve: ['draft'], paid: ['approved'], void: ['draft', 'approved'] };
  if (!from[a]) throw new HomeError(422, 'action is approve, paid or void.');
  if (!from[a]!.includes(r.status)) throw new HomeError(409, `A ${r.status} reimbursement cannot be ${a === 'paid' ? 'marked paid' : a === 'approve' ? 'approved' : 'voided'}.`);
  const set = a === 'approve' ? `status = 'approved', approved_at = now(), approved_by = $2` : a === 'paid' ? `status = 'paid', paid_at = now()` : `status = 'void'`;
  const u = await S(() => one<any>(`UPDATE home_reimbursement SET ${set} WHERE id = $1 RETURNING *`, a === 'approve' ? [r.id, userId] : [r.id]));
  const h = await S(() => one<any>(`SELECT employee_name, employee_ref FROM home_charger WHERE id = $1`, [r.home_charger_id]));
  return reimbOf({ ...u, ...h });
}

/** The payroll export: the month's approved (and paid) reimbursements. */
export async function payrollCsv(orgId: string, month: string) {
  const rows = (await reimbursements(orgId, month)).filter((r) => r.status === 'approved' || r.status === 'paid');
  const cell = (v: unknown) => { const s = String(v ?? ''); return /[",\n;]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; };
  return ['employee_ref,employee_name,month,kwh,amount_minor,currency,status',
    ...rows.map((r) => [r.employeeRef ?? '', r.employeeName ?? '', r.month, r.kwh, r.amountMinor, r.currency, r.status].map(cell).join(','))].join('\n') + '\n';
}

export async function xlsxFor(orgId: string, month: string) {
  const rows = await reimbursements(orgId, month);
  return xlsx([{ name: 'Home charging', rows: [
    [`Home charging reimbursements · ${month}`], [],
    ['Payroll no.', 'Employee', 'kWh', 'Sessions', 'Rate (minor/kWh)', 'Amount (minor)', 'Capped', 'Currency', 'Status'],
    ...rows.map((r) => [r.employeeRef ?? '', r.employeeName ?? '', r.kwh, r.sessions ?? '', r.rateMinorPerKwh, r.amountMinor, r.capped ? 'yes' : '', r.currency, r.status]),
  ] }]);
}

// ------------------------------------------------------------------ the employee's page

export async function rotatePortal(orgId: string, id: string) {
  const h = await row(orgId, id);
  if (h.archived_at) throw new HomeError(409, 'This home charger is archived.');
  const token = `hcr_${randomBytes(24).toString('base64url')}`;
  await S(() => query(`UPDATE home_charger SET portal_token_hash = $2, portal_token_prefix = $3 WHERE id = $1`, [h.id, sha(token), token.slice(0, 8)]));
  return { token, path: `/home-charging/${token}` };
}

async function byToken(token: string) {
  if (!/^hcr_[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HomeError(404, 'This link is not valid (any more).');
  const h = await S(() => one<any>(`SELECT * FROM home_charger WHERE portal_token_hash = $1 AND archived_at IS NULL`, [sha(token)]));
  if (!h) throw new HomeError(404, 'This link is not valid (any more).');
  return h;
}

export async function portalView(token: string) {
  const h = await byToken(token);
  const org = await S(() => one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [h.org_id]));
  const thisMonth = new Date().toISOString().slice(0, 7);
  const now = await usage(h, thisMonth);
  return {
    operator: org?.name ?? null, employeeName: h.employee_name, mode: h.mode, currency: h.currency, rateMinorPerKwh: Number(h.rate_minor_per_kwh),
    monthlyCapMinor: h.monthly_cap_minor == null ? null : Number(h.monthly_cap_minor),
    thisMonth: { month: thisMonth, kwh: now.kwh, sessions: now.sessions, basis: now.basis },
    readings: h.mode === 'readings' ? (await readings(h.org_id, String(h.id))).slice(0, 12) : [],
    reimbursements: (await reimbursements(h.org_id, null, String(h.id))).filter((r) => r.status !== 'void').slice(0, 24)
      .map((r) => ({ month: r.month, kwh: r.kwh, amountMinor: r.amountMinor, capped: r.capped, currency: r.currency, status: r.status })),
  };
}

export async function portalReading(token: string, b: Record<string, unknown>) {
  const h = await byToken(token);
  const recent = await S(() => one<{ n: string }>(`SELECT count(*) AS n FROM home_meter_reading WHERE home_charger_id = $1 AND source = 'employee' AND created_at > now() - interval '1 hour'`, [h.id]));
  if (Number(recent?.n ?? 0) >= 10) throw new HomeError(429, 'Too many readings. Try again later.');
  await addReading(h.org_id, String(h.id), { readOn: b.readOn, kwhTotal: b.kwhTotal, note: b.note }, 'employee');
  return portalView(token);
}
