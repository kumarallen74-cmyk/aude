import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { assertOpen } from './finance-periods.js';
import { xlsx } from './xlsx.js';

/**
 * Insurance and claims (v1.35.0).
 *
 *   policies   per site, charger or the organisation: insurer, number, kind (property, equipment, liability, business
 *              interruption, vehicle, other), cover, premium, excess, term; the premium paid (date, account). A policy
 *              ending within 30 days raises finance.insurance_renewal (resolved when renewed or cancelled); renewing
 *              copies it to the next term.
 *   premium    prepaid and spread over the term by days: paid Dr 1450 prepaid insurance / Cr bank; each month's share
 *              Dr 6600 insurance / Cr 1450
 *   claims     under a policy, numbered CL-00001…: kind, incident date, the loss (linked to a work order when there is one);
 *              reported → submitted → accepted or rejected → paid (the settlement, at most the loss less the excess) →
 *              closed. Paid Dr bank / Cr 6605 insurance recoveries. The recovery rate: settled ÷ loss.
 */

export class InsuranceError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const KINDS = ['property', 'equipment', 'liability', 'business_interruption', 'vehicle', 'other'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RENEWAL = 'finance.insurance_renewal';
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const ERR = (s: number, m: string) => new InsuranceError(s, m);
const lastDay = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };

/** The premium's share for a month: days of the term in the month ÷ days of the term (end exclusive). Pure. */
export function monthShare(premium: number, start: string, end: string, month: string) {
  const total = days(start, end);
  if (total <= 0) return 0;
  const a = `${month}-01` > start ? `${month}-01` : start;
  const nextMonth = new Date(Date.parse(`${lastDay(month)}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const b = nextMonth < end ? nextMonth : end;
  const d = days(a, b);
  return d > 0 ? Math.round((premium * d) / total) : 0;
}

const P_SELECT = `SELECT p.*, to_char(p.start_on, 'YYYY-MM-DD') AS start_s, to_char(p.end_on, 'YYYY-MM-DD') AS end_s, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_s, s.name AS site_name,
    COALESCE(cp.display_name, cp.ocpp_identity) AS cp_name,
    (SELECT count(*) FROM insurance_claim c WHERE c.policy_id = p.id)::int AS claims,
    (SELECT COALESCE(sum(c.settled_minor), 0) FROM insurance_claim c WHERE c.policy_id = p.id AND c.status IN ('paid', 'closed'))::bigint AS recovered
  FROM insurance_policy p LEFT JOIN site s ON s.id = p.site_id LEFT JOIN charge_point cp ON cp.id = p.charge_point_id`;

const pView = (p: any, t = today()) => ({
  id: String(p.id), insurer: p.insurer, policyNo: p.policy_no, kind: p.kind, siteId: p.site_id ?? null, site: p.site_name ?? null, chargePointId: p.charge_point_id ?? null, chargePoint: p.cp_name ?? null,
  currency: p.currency, cover: Number(p.cover_minor), premium: Number(p.premium_minor), excess: Number(p.excess_minor), startOn: p.start_s, endOn: p.end_s, paidOn: p.paid_s ?? null,
  status: p.status, renewed: !!p.renewed_by, claims: p.claims, recovered: Number(p.recovered),
  inForce: p.status === 'active' && p.start_s <= t && p.end_s > t, daysLeft: days(t, p.end_s),
  prepaidLeft: p.paid_s ? Math.round((Number(p.premium_minor) * Math.max(0, Math.min(days(p.start_s, p.end_s), days(t > p.start_s ? t : p.start_s, p.end_s)))) / days(p.start_s, p.end_s)) : 0,
});

export async function overview(orgId: string) {
  const ps = (await outsideRequestScope(() => many<any>(`${P_SELECT} WHERE p.org_id = $1 ORDER BY (p.status = 'active') DESC, p.end_on`, [orgId]))).map((p) => pView(p));
  const claims = await outsideRequestScope(() => many<any>(
    `SELECT c.*, to_char(c.incident_on, 'YYYY-MM-DD') AS inc_s, to_char(c.paid_on, 'YYYY-MM-DD') AS paid_s, p.insurer, p.policy_no, p.currency, p.excess_minor, w.number AS wo_number
       FROM insurance_claim c JOIN insurance_policy p ON p.id = c.policy_id LEFT JOIN work_order w ON w.id = c.work_order_id WHERE c.org_id = $1 ORDER BY c.incident_on DESC, c.id DESC LIMIT 300`, [orgId]));
  const cv = claims.map((c) => ({ id: String(c.id), number: c.number, policyId: String(c.policy_id), policy: `${c.insurer} ${c.policy_no}`, kind: c.kind, incidentOn: c.inc_s, description: c.description,
    workOrder: c.wo_number ?? null, currency: c.currency, loss: Number(c.loss_minor), excess: Number(c.excess_minor), status: c.status, settled: c.settled_minor == null ? null : Number(c.settled_minor), paidOn: c.paid_s ?? null, insurerRef: c.insurer_ref ?? null }));
  const totals: Record<string, { premium: number; cover: number; prepaid: number; loss: number; settled: number }> = {};
  for (const p of ps.filter((x) => x.inForce)) { const t = (totals[p.currency] ??= { premium: 0, cover: 0, prepaid: 0, loss: 0, settled: 0 }); t.premium += p.premium; t.cover += p.cover; t.prepaid += p.prepaidLeft; }
  for (const c of cv) { const t = (totals[c.currency] ??= { premium: 0, cover: 0, prepaid: 0, loss: 0, settled: 0 }); t.loss += c.loss; t.settled += c.settled ?? 0; }
  return { policies: ps, claims: cv, totals: Object.fromEntries(Object.entries(totals).map(([k, t]) => [k, { ...t, recoveryPct: t.loss ? Math.round((t.settled / t.loss) * 1000) / 10 : null }])), renewing: ps.filter((p) => p.status === 'active' && !p.renewed && p.daysLeft <= 30 && p.daysLeft >= -30) };
}

async function pRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new InsuranceError(404, 'No such policy.');
  const r = await outsideRequestScope(() => one<any>(`${P_SELECT} WHERE p.id = $1 AND p.org_id = $2`, [id, orgId]));
  if (!r) throw new InsuranceError(404, 'No such policy.');
  return r;
}

export async function savePolicy(orgId: string, id: string | null, b: Record<string, unknown>, userId: string | null) {
  const cur = id ? await pRow(orgId, id) : null;
  const v = (k: string, col: string) => (b[k] === undefined && cur ? cur[col] : b[k]);
  const insurer = String(v('insurer', 'insurer') ?? '').trim(), policyNo = String(v('policyNo', 'policy_no') ?? '').trim();
  if (insurer.length < 2 || policyNo.length < 1) throw new InsuranceError(422, 'insurer and policyNo are needed.');
  const kind = String(v('kind', 'kind') ?? '');
  if (!(KINDS as readonly string[]).includes(kind)) throw new InsuranceError(422, `kind is one of ${KINDS.join(', ')}.`);
  const site = v('siteId', 'site_id') == null || v('siteId', 'site_id') === '' ? null : String(v('siteId', 'site_id'));
  const cp = v('chargePointId', 'charge_point_id') == null || v('chargePointId', 'charge_point_id') === '' ? null : String(v('chargePointId', 'charge_point_id'));
  if (site && (!UUID_RE.test(site) || !(await outsideRequestScope(() => one(`SELECT 1 FROM site WHERE id = $1 AND org_id = $2`, [site, orgId]))))) throw new InsuranceError(422, 'No such site.');
  if (cp && (!UUID_RE.test(cp) || !(await outsideRequestScope(() => one(`SELECT 1 FROM charge_point c JOIN site s ON s.id = c.site_id WHERE c.id = $1 AND s.org_id = $2`, [cp, orgId]))))) throw new InsuranceError(422, 'No such charge point.');
  const currency = String(v('currency', 'currency') ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new InsuranceError(422, 'currency is an ISO code.');
  const n = (k: string, col: string, min: number) => { const x = Number(v(k, col) ?? 0); if (!Number.isInteger(x) || x < min) throw new InsuranceError(422, `${k} is a whole amount, ${min} or more.`); return x; };
  const cover = n('cover', 'cover_minor', 1), premium = n('premium', 'premium_minor', 0), excess = n('excess', 'excess_minor', 0);
  const start = String(v('startOn', 'start_s') ?? ''), end = String(v('endOn', 'end_s') ?? '');
  if (!DATE_RE.test(start) || !DATE_RE.test(end) || end <= start) throw new InsuranceError(422, 'startOn and endOn are YYYY-MM-DD, the end after the start.');
  const paid = v('paidOn', 'paid_s') == null || v('paidOn', 'paid_s') === '' ? null : String(v('paidOn', 'paid_s'));
  if (paid) { if (!DATE_RE.test(paid)) throw new InsuranceError(422, 'paidOn is YYYY-MM-DD.'); if (!cur?.paid_s || cur.paid_s !== paid) await assertOpen(orgId, paid.slice(0, 7), 'A premium payment', ERR); }
  const acct = v('cashAccountId', 'cash_account_id') == null || v('cashAccountId', 'cash_account_id') === '' ? null : String(v('cashAccountId', 'cash_account_id'));
  const status = String(v('status', 'status') ?? 'active');
  if (!['active', 'cancelled'].includes(status)) throw new InsuranceError(422, 'status is active or cancelled.');
  const p = [orgId, insurer.slice(0, 120), policyNo.slice(0, 60), kind, site, cp, currency, cover, premium, excess, start, end, paid, acct, status, v('note', 'note') ? String(v('note', 'note')).slice(0, 500) : null];
  try {
    const r = cur
      ? await outsideRequestScope(() => one<any>(`UPDATE insurance_policy SET insurer = $2, policy_no = $3, kind = $4, site_id = $5, charge_point_id = $6, currency = $7, cover_minor = $8, premium_minor = $9, excess_minor = $10,
          start_on = $11, end_on = $12, paid_on = $13, cash_account_id = $14, status = $15, note = $16 WHERE org_id = $1 AND id = $17 RETURNING id`, [...p, cur.id]))
      : await outsideRequestScope(() => one<any>(`INSERT INTO insurance_policy (org_id, insurer, policy_no, kind, site_id, charge_point_id, currency, cover_minor, premium_minor, excess_minor, start_on, end_on, paid_on, cash_account_id, status, note, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`, [...p, userId]));
    if (status === 'cancelled') await outsideRequestScope(() => resolveAlertsFor(orgId, RENEWAL, 'insurance_policy', String(r.id))).catch(() => 0);
    return pView(await pRow(orgId, String(r.id)));
  } catch (e) {
    if ((e as any).code === '23505') throw new InsuranceError(409, `${insurer} policy ${policyNo} is already recorded.`);
    throw e;
  }
}

/** Renew: the same cover for the next term (from the old end), the new premium and number. */
export async function renew(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  const p = pView(await pRow(orgId, id));
  if (p.status !== 'active' || p.renewed) throw new InsuranceError(409, 'Only an active policy not yet renewed is renewed.');
  const termDays = days(p.startOn, p.endOn);
  const end = b.endOn ? String(b.endOn) : new Date(Date.parse(`${p.endOn}T00:00:00Z`) + termDays * 86_400_000).toISOString().slice(0, 10);
  const n = await savePolicy(orgId, null, { insurer: p.insurer, policyNo: b.policyNo ?? `${p.policyNo}-R`, kind: p.kind, siteId: p.siteId, chargePointId: p.chargePointId, currency: p.currency,
    cover: b.cover ?? p.cover, premium: b.premium ?? p.premium, excess: b.excess ?? p.excess, startOn: p.endOn, endOn: end, paidOn: b.paidOn, cashAccountId: b.cashAccountId }, userId);
  await outsideRequestScope(() => query(`UPDATE insurance_policy SET renewed_by = $2 WHERE id = $1`, [p.id, n.id]));
  await outsideRequestScope(() => resolveAlertsFor(orgId, RENEWAL, 'insurance_policy', p.id)).catch(() => 0);
  return n;
}

export async function claim(orgId: string, policyId: string, b: Record<string, unknown>, userId: string | null) {
  const p = pView(await pRow(orgId, policyId));
  const kind = String(b.kind ?? '');
  if (!['damage', 'theft', 'liability', 'interruption', 'other'].includes(kind)) throw new InsuranceError(422, 'kind is damage, theft, liability, interruption or other.');
  const inc = String(b.incidentOn ?? '');
  if (!DATE_RE.test(inc)) throw new InsuranceError(422, 'incidentOn is YYYY-MM-DD.');
  if (inc < p.startOn || inc >= p.endOn) throw new InsuranceError(422, `The policy covers ${p.startOn} to ${p.endOn}.`);
  const desc = String(b.description ?? '').trim();
  if (desc.length < 5) throw new InsuranceError(422, 'Describe what happened (at least 5 characters).');
  const loss = Number(b.loss);
  if (!Number.isInteger(loss) || loss < 0) throw new InsuranceError(422, 'loss is a whole amount, 0 or more.');
  const wo = b.workOrderId == null || b.workOrderId === '' ? null : String(b.workOrderId);
  if (wo && !(await outsideRequestScope(() => one(`SELECT 1 FROM work_order WHERE id = $1 AND org_id = $2`, [wo, orgId])))) throw new InsuranceError(422, 'No such work order.');
  for (let k = 0; k < 5; k++) {
    const n = await outsideRequestScope(() => one<{ n: string }>(`SELECT count(*) AS n FROM insurance_claim WHERE org_id = $1`, [orgId]));
    try {
      const r = await outsideRequestScope(() => one<{ id: string }>(
        `INSERT INTO insurance_claim (org_id, policy_id, number, kind, incident_on, description, work_order_id, loss_minor, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [orgId, p.id, `CL-${String(Number(n?.n ?? 0) + 1 + k).padStart(5, '0')}`, kind, inc, desc.slice(0, 1000), wo, loss, userId]));
      return (await overview(orgId)).claims.find((c) => c.id === String(r!.id))!;
    } catch (e) { if ((e as any).code !== '23505') throw e; }
  }
  throw new InsuranceError(409, 'Could not number the claim. Try again.');
}

const NEXT: Record<string, string[]> = { reported: ['submitted', 'closed'], submitted: ['accepted', 'rejected'], accepted: ['paid'], rejected: ['closed', 'submitted'], paid: ['closed'], closed: [] };

export async function updateClaim(orgId: string, id: string, b: Record<string, unknown>) {
  if (!/^\d{1,18}$/.test(id)) throw new InsuranceError(404, 'No such claim.');
  const c = await outsideRequestScope(() => one<any>(`SELECT c.*, p.excess_minor FROM insurance_claim c JOIN insurance_policy p ON p.id = c.policy_id WHERE c.id = $1 AND c.org_id = $2`, [id, orgId]));
  if (!c) throw new InsuranceError(404, 'No such claim.');
  const status = String(b.status ?? '');
  if (!NEXT[c.status]!.includes(status)) throw new InsuranceError(409, `A ${c.status} claim moves to ${NEXT[c.status]!.join(' or ') || 'nothing'}.`);
  let settled: number | null = null, paidOn: string | null = null;
  if (status === 'paid') {
    const max = Math.max(0, Number(c.loss_minor) - Number(c.excess_minor));
    settled = b.settled == null || b.settled === '' ? max : Number(b.settled);
    if (!Number.isInteger(settled) || settled < 0 || settled > max) throw new InsuranceError(422, `settled is 0 to ${max} (the loss less the excess).`);
    paidOn = String(b.paidOn ?? today());
    if (!DATE_RE.test(paidOn)) throw new InsuranceError(422, 'paidOn is YYYY-MM-DD.');
    await assertOpen(orgId, paidOn.slice(0, 7), 'A claim payment', ERR);
  }
  await outsideRequestScope(() => query(`UPDATE insurance_claim SET status = $2, settled_minor = COALESCE($3, settled_minor), paid_on = COALESCE($4::date, paid_on), insurer_ref = COALESCE($5, insurer_ref), note = COALESCE($6, note) WHERE id = $1`,
    [c.id, status, settled, paidOn, b.insurerRef ? String(b.insurerRef).slice(0, 80) : null, b.note ? String(b.note).slice(0, 500) : null]));
  return (await overview(orgId)).claims.find((x) => x.id === String(c.id))!;
}

/** For the cash position: premiums paid and claims settled through a cash account (the policy's). */
export async function cashMoves(orgId: string, upTo: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT cash_account_id::text AS a, to_char(paid_on, 'YYYY-MM-DD') AS d, -premium_minor AS amt FROM insurance_policy WHERE org_id = $1 AND cash_account_id IS NOT NULL AND paid_on IS NOT NULL AND paid_on <= $2::date
     UNION ALL SELECT p.cash_account_id::text, to_char(c.paid_on, 'YYYY-MM-DD'), c.settled_minor FROM insurance_claim c JOIN insurance_policy p ON p.id = c.policy_id
      WHERE c.org_id = $1 AND p.cash_account_id IS NOT NULL AND c.status IN ('paid', 'closed') AND c.paid_on IS NOT NULL AND c.paid_on <= $2::date`, [orgId, upTo]));
  return rows.map((r) => ({ account_id: r.a as string, d: r.d as string, amount: Number(r.amt) }));
}

export async function registerXlsx(orgId: string): Promise<Buffer> {
  const o = await overview(orgId);
  return xlsx([
    { name: 'Policies', rows: [['Insurer', 'Policy', 'Kind', 'Site', 'Charger', 'Currency', 'Cover', 'Premium', 'Excess', 'Start', 'End', 'Paid', 'Status', 'Claims', 'Recovered'],
      ...o.policies.map((p) => [p.insurer, p.policyNo, p.kind, p.site ?? '', p.chargePoint ?? '', p.currency, p.cover, p.premium, p.excess, p.startOn, p.endOn, p.paidOn ?? '', p.status, p.claims, p.recovered])],
      widths: [24, 16, 14, 22, 16, 8, 16, 14, 12, 11, 11, 11, 10, 8, 14], formats: [null, null, null, null, null, null, 'money', 'money', 'money', null, null, null, null, null, 'money'] },
    { name: 'Claims', rows: [['Number', 'Policy', 'Kind', 'Incident', 'Description', 'Loss', 'Excess', 'Status', 'Settled', 'Paid'], ...o.claims.map((c) => [c.number, c.policy, c.kind, c.incidentOn, c.description, c.loss, c.excess, c.status, c.settled, c.paidOn ?? ''])],
      widths: [10, 26, 12, 11, 40, 14, 12, 10, 14, 11], formats: [null, null, null, null, null, 'money', 'money', null, 'money', null] },
  ]);
}

/** Daily: active policies ending within 30 days and not renewed raise the renewal alert. */
export async function sweep(now = new Date()): Promise<number> {
  const t = today(now);
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT id, org_id, insurer, policy_no, to_char(end_on, 'YYYY-MM-DD') AS end_s FROM insurance_policy WHERE status = 'active' AND renewed_by IS NULL AND end_on <= ($1::date + 30) AND end_on >= ($1::date - 30)`, [t]));
  let n = 0;
  for (const p of rows) {
    try {
      const left = days(t, p.end_s);
      await outsideRequestScope(() => persistAlert({ orgId: p.org_id, kind: RENEWAL, severity: left <= 0 ? 'critical' : 'warning', targetType: 'insurance_policy', targetId: String(p.id),
        message: `${p.insurer} policy ${p.policy_no} ${left <= 0 ? `ended on ${p.end_s}: renew it or record it as cancelled` : `ends on ${p.end_s} (${left} days)`}. Finance → Insurance.` }));
      n++;
    } catch (e) { logger.warn({ policy: p.id, err: (e as Error).message }, 'insurance renewal sweep failed'); }
  }
  return n;
}
