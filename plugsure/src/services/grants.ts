import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { assertOpen } from './finance-periods.js';
import { xlsx } from './xlsx.js';

/**
 * Grants and incentives (v1.36.0): government, utility or development-bank money for charging infrastructure.
 *
 *   kinds       capital: towards assets (a site build, chargers); what is received is deferred (2600) and released to
 *               grant income (4400) straight-line over the release period (months, e.g. the assets' life), from the
 *               month it is received. revenue: towards running costs; per_kwh: a rate per kWh charged (at the grant's
 *               site, or all sites) — both are income (4400) when the claim is approved (Dr 1350 grant receivable),
 *               and the receivable is cleared when paid.
 *   conditions  what the grantor requires (chargers live by a date, uptime, reports) with a due date; pending ones
 *               raise finance.grant_condition_due from 14 days ahead (critical once past). Met, breached or waived.
 *   claims      GC-00001…: the period, the kWh (per_kwh: the amount follows), the amount (in all at most what was
 *               awarded); draft → submitted → approved or rejected → paid (what was received, to which account).
 *   clawbacks   an amount taken back (usually a condition breached): from the deferred balance first (capital), the
 *               rest an expense (6700), owed to the grantor (2610) until repaid. A capital grant stops releasing after
 *               a clawback.
 */

export class GrantError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const KINDS = ['capital', 'revenue', 'per_kwh'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DUE = 'finance.grant_condition_due';
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const ERR = (s: number, m: string) => new GrantError(s, m);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const addMonths = (m: string, k: number) => { const [y, mo] = m.split('-').map(Number) as [number, number]; const t = y * 12 + mo - 1 + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const monthsBetween = (a: string, b: string) => { const [ya, ma] = a.split('-').map(Number) as [number, number]; const [yb, mb] = b.split('-').map(Number) as [number, number]; return (yb - ya) * 12 + (mb - ma); };

/**
 * A capital grant's release in a month: each receipt spread evenly over releaseMonths from the month received (the last
 * month takes the rounding), nothing from the month after stopAfter (a clawback). Pure.
 */
export function releaseIn(receipts: Array<{ month: string; amount: number }>, releaseMonths: number, month: string, stopAfter?: string | null): number {
  if (stopAfter && month > stopAfter) return 0;
  let out = 0;
  for (const r of receipts) {
    const k = monthsBetween(r.month, month);
    if (k < 0 || k >= releaseMonths) continue;
    const each = Math.floor(r.amount / releaseMonths);
    out += k === releaseMonths - 1 ? r.amount - each * (releaseMonths - 1) : each;
  }
  return out;
}

/** Released up to and including a month. Pure. */
export function releasedTo(receipts: Array<{ month: string; amount: number }>, releaseMonths: number, month: string, stopAfter?: string | null): number {
  let t = 0;
  const first = receipts.map((r) => r.month).sort()[0];
  if (!first) return 0;
  for (let m = first; m <= month; m = addMonths(m, 1)) t += releaseIn(receipts, releaseMonths, m, stopAfter);
  return t;
}

const G_SELECT = `SELECT g.*, to_char(g.period_from, 'YYYY-MM-DD') AS pf, to_char(g.period_to, 'YYYY-MM-DD') AS pt, to_char(g.awarded_on, 'YYYY-MM-DD') AS aw, s.name AS site_name, p.name AS project_name
  FROM grant_programme g LEFT JOIN site s ON s.id = g.site_id LEFT JOIN capex_project p ON p.id = g.capex_project_id`;

async function gRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new GrantError(404, 'No such grant.');
  const r = await outsideRequestScope(() => one<any>(`${G_SELECT} WHERE g.id = $1 AND g.org_id = $2`, [id, orgId]));
  if (!r) throw new GrantError(404, 'No such grant.');
  return r;
}

async function parts(orgId: string, ids: string[]) {
  if (!ids.length) return { conds: [], claims: [], claws: [] };
  const [conds, claims, claws] = await Promise.all([
    outsideRequestScope(() => many<any>(`SELECT *, to_char(due_on, 'YYYY-MM-DD') AS due_s, to_char(met_on, 'YYYY-MM-DD') AS met_s FROM grant_condition WHERE org_id = $1 AND grant_id = ANY($2::bigint[]) ORDER BY due_on NULLS LAST, id`, [orgId, ids])),
    outsideRequestScope(() => many<any>(`SELECT *, to_char(period_from, 'YYYY-MM-DD') AS pf, to_char(period_to, 'YYYY-MM-DD') AS pt, to_char(submitted_on, 'YYYY-MM-DD') AS sub_s, to_char(approved_on, 'YYYY-MM-DD') AS app_s, to_char(paid_on, 'YYYY-MM-DD') AS paid_s
      FROM grant_claim WHERE org_id = $1 AND grant_id = ANY($2::bigint[]) ORDER BY id`, [orgId, ids])),
    outsideRequestScope(() => many<any>(`SELECT *, to_char(on_date, 'YYYY-MM-DD') AS on_s, to_char(repaid_on, 'YYYY-MM-DD') AS rep_s FROM grant_clawback WHERE org_id = $1 AND grant_id = ANY($2::bigint[]) ORDER BY on_date, id`, [orgId, ids])),
  ]);
  return { conds, claims, claws };
}

/** The money of a grant up to a month: received, released, deferred, clawed back. */
export function position(g: any, claims: any[], claws: any[], month: string) {
  const paid = claims.filter((c) => c.status === 'paid' && c.paid_s && c.paid_s.slice(0, 7) <= month);
  const received = paid.reduce((a, c) => a + Number(c.paid_minor ?? c.amount_minor), 0);
  const cw = claws.filter((c) => c.on_s.slice(0, 7) <= month);
  const clawedBack = cw.reduce((a, c) => a + Number(c.amount_minor), 0);
  if (g.kind !== 'capital') return { received, released: 0, deferred: 0, clawedBack, clawedFromDeferred: 0 };
  const stop = claws.length ? claws.map((c) => c.on_s.slice(0, 7)).sort()[0]! : null;
  const receipts = paid.map((c) => ({ month: c.paid_s.slice(0, 7), amount: Number(c.paid_minor ?? c.amount_minor) }));
  const released = releasedTo(receipts, g.release_months ?? 96, month, stop);
  // Each clawback takes from what is still deferred at its month first.
  let deferred = received - released, fromDeferred = 0;
  for (const c of cw) { const take = Math.min(Math.max(0, deferred), Number(c.amount_minor)); fromDeferred += take; deferred -= take; }
  return { received, released, deferred: Math.max(0, deferred), clawedBack, clawedFromDeferred: fromDeferred };
}

const view = (g: any, conds: any[], claims: any[], claws: any[], t = today()) => {
  const mine = (xs: any[]) => xs.filter((x) => String(x.grant_id) === String(g.id));
  const cs = mine(conds), cl = mine(claims), cw = mine(claws);
  const pos = position(g, cl, cw, t.slice(0, 7));
  const claimed = cl.filter((c) => c.status !== 'rejected').reduce((a, c) => a + Number(c.amount_minor), 0);
  const next = cs.find((c) => c.status === 'pending' && c.due_s);
  return {
    id: String(g.id), grantor: g.grantor, programme: g.programme, reference: g.reference ?? null, kind: g.kind, currency: g.currency, awarded: Number(g.awarded_minor),
    ratePerKwh: g.rate_per_kwh == null ? null : Number(g.rate_per_kwh), periodFrom: g.pf ?? null, periodTo: g.pt ?? null, releaseMonths: g.release_months ?? null,
    siteId: g.site_id ?? null, site: g.site_name ?? null, capexProjectId: g.capex_project_id ? String(g.capex_project_id) : null, project: g.project_name ?? null,
    status: g.status, awardedOn: g.aw ?? null, note: g.note ?? null,
    claimed, toClaim: Math.max(0, Number(g.awarded_minor) - claimed), ...pos,
    conditions: cs.map((c) => ({ id: String(c.id), description: c.description, dueOn: c.due_s ?? null, status: c.status, metOn: c.met_s ?? null, note: c.note ?? null,
      overdue: c.status === 'pending' && !!c.due_s && c.due_s < t, daysLeft: c.due_s ? days(t, c.due_s) : null })),
    nextCondition: next ? { description: next.description, dueOn: next.due_s } : null,
    breached: cs.filter((c) => c.status === 'breached').length,
    claims: cl.map((c) => ({ id: String(c.id), number: c.number, periodFrom: c.pf ?? null, periodTo: c.pt ?? null, kwh: c.kwh == null ? null : Number(c.kwh), amount: Number(c.amount_minor), status: c.status,
      submittedOn: c.sub_s ?? null, approvedOn: c.app_s ?? null, paidOn: c.paid_s ?? null, paid: c.paid_minor == null ? null : Number(c.paid_minor), reference: c.reference ?? null })),
    clawbacks: cw.map((c) => ({ id: String(c.id), amount: Number(c.amount_minor), onDate: c.on_s, repaidOn: c.rep_s ?? null, note: c.note, conditionId: c.condition_id ? String(c.condition_id) : null })),
  };
};

export async function overview(orgId: string) {
  const gs = await outsideRequestScope(() => many<any>(`${G_SELECT} WHERE g.org_id = $1 ORDER BY (g.status IN ('completed', 'rejected')), g.awarded_on DESC NULLS LAST, g.id DESC`, [orgId]));
  const p = await parts(orgId, gs.map((g) => String(g.id)));
  const grants = gs.map((g) => view(g, p.conds, p.claims, p.claws));
  const totals: Record<string, { awarded: number; received: number; deferred: number; toClaim: number; repayable: number }> = {};
  for (const g of grants.filter((x) => x.status !== 'rejected')) {
    const t = (totals[g.currency] ??= { awarded: 0, received: 0, deferred: 0, toClaim: 0, repayable: 0 });
    t.awarded += g.awarded; t.received += g.received; t.deferred += g.deferred; t.toClaim += g.toClaim;
    t.repayable += g.clawbacks.filter((c) => !c.repaidOn).reduce((a, c) => a + c.amount, 0);
  }
  const due = grants.flatMap((g) => g.conditions.filter((c) => c.status === 'pending' && c.daysLeft != null && c.daysLeft <= 30).map((c) => ({ ...c, grant: `${g.grantor} · ${g.programme}`, grantId: g.id })));
  return { grants, totals, conditionsDue: due.sort((a, b) => (a.dueOn ?? '').localeCompare(b.dueOn ?? '')) };
}

export async function get(orgId: string, id: string) {
  const g = await gRow(orgId, id);
  const p = await parts(orgId, [String(g.id)]);
  return view(g, p.conds, p.claims, p.claws);
}

export async function save(orgId: string, id: string | null, b: Record<string, unknown>, userId: string | null) {
  const cur = id ? await gRow(orgId, id) : null;
  const v = (k: string, col: string) => (b[k] === undefined && cur ? cur[col] : b[k]);
  const grantor = String(v('grantor', 'grantor') ?? '').trim(), programme = String(v('programme', 'programme') ?? '').trim();
  if (grantor.length < 2 || programme.length < 2) throw new GrantError(422, 'grantor and programme are needed.');
  const kind = String(v('kind', 'kind') ?? '');
  if (!(KINDS as readonly string[]).includes(kind)) throw new GrantError(422, 'kind is capital, revenue or per_kwh.');
  if (cur && kind !== cur.kind && (await outsideRequestScope(() => one(`SELECT 1 FROM grant_claim WHERE grant_id = $1 AND status = 'paid'`, [cur.id])))) throw new GrantError(409, 'The kind cannot change once a claim is paid.');
  const currency = String(v('currency', 'currency') ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new GrantError(422, 'currency is an ISO code.');
  const awarded = Number(v('awarded', 'awarded_minor') ?? 0);
  if (!Number.isInteger(awarded) || awarded < 0) throw new GrantError(422, 'awarded is a whole amount, 0 or more.');
  const rate = v('ratePerKwh', 'rate_per_kwh') == null || v('ratePerKwh', 'rate_per_kwh') === '' ? null : Number(v('ratePerKwh', 'rate_per_kwh'));
  if (kind === 'per_kwh' && (rate == null || !Number.isFinite(rate) || rate <= 0)) throw new GrantError(422, 'A per-kWh grant has its ratePerKwh.');
  const rel = v('releaseMonths', 'release_months') == null || v('releaseMonths', 'release_months') === '' ? null : Number(v('releaseMonths', 'release_months'));
  if (kind === 'capital' && (rel == null || !Number.isInteger(rel) || rel < 1 || rel > 480)) throw new GrantError(422, 'A capital grant is released over releaseMonths (1 to 480), usually the assets\' life.');
  const d = (k: string, col: string) => { const x = v(k, col); if (x == null || x === '') return null; if (!DATE_RE.test(String(x))) throw new GrantError(422, `${k} is YYYY-MM-DD.`); return String(x); };
  const pf = d('periodFrom', 'pf'), pt = d('periodTo', 'pt'), aw = d('awardedOn', 'aw');
  if (pf && pt && pt < pf) throw new GrantError(422, 'periodTo is on or after periodFrom.');
  const site = v('siteId', 'site_id') == null || v('siteId', 'site_id') === '' ? null : String(v('siteId', 'site_id'));
  if (site && (!UUID_RE.test(site) || !(await outsideRequestScope(() => one(`SELECT 1 FROM site WHERE id = $1 AND org_id = $2`, [site, orgId]))))) throw new GrantError(422, 'No such site.');
  const proj = v('capexProjectId', 'capex_project_id') == null || v('capexProjectId', 'capex_project_id') === '' ? null : String(v('capexProjectId', 'capex_project_id'));
  if (proj && (!/^\d{1,18}$/.test(proj) || !(await outsideRequestScope(() => one(`SELECT 1 FROM capex_project WHERE id = $1 AND org_id = $2`, [proj, orgId]))))) throw new GrantError(422, 'No such capex project.');
  const status = String(v('status', 'status') ?? 'awarded');
  if (!['applied', 'awarded', 'active', 'completed', 'rejected', 'clawed_back'].includes(status)) throw new GrantError(422, 'status is applied, awarded, active, completed, rejected or clawed_back.');
  const p = [orgId, grantor.slice(0, 120), programme.slice(0, 160), v('reference', 'reference') ? String(v('reference', 'reference')).slice(0, 80) : null, kind, currency, awarded, kind === 'per_kwh' ? rate : null,
    pf, pt, kind === 'capital' ? rel : null, site, proj, status, aw, v('note', 'note') ? String(v('note', 'note')).slice(0, 1000) : null];
  const r = cur
    ? await outsideRequestScope(() => one<any>(`UPDATE grant_programme SET grantor = $2, programme = $3, reference = $4, kind = $5, currency = $6, awarded_minor = $7, rate_per_kwh = $8, period_from = $9, period_to = $10,
        release_months = $11, site_id = $12, capex_project_id = $13, status = $14, awarded_on = $15, note = $16 WHERE org_id = $1 AND id = $17 RETURNING id`, [...p, cur.id]))
    : await outsideRequestScope(() => one<any>(`INSERT INTO grant_programme (org_id, grantor, programme, reference, kind, currency, awarded_minor, rate_per_kwh, period_from, period_to, release_months, site_id, capex_project_id, status, awarded_on, note, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`, [...p, userId]));
  return get(orgId, String(r.id));
}

export async function addCondition(orgId: string, grantId: string, b: Record<string, unknown>) {
  const g = await gRow(orgId, grantId);
  const desc = String(b.description ?? '').trim();
  if (desc.length < 3) throw new GrantError(422, 'Describe the condition (at least 3 characters).');
  const due = b.dueOn ? String(b.dueOn) : null;
  if (due && !DATE_RE.test(due)) throw new GrantError(422, 'dueOn is YYYY-MM-DD.');
  await outsideRequestScope(() => query(`INSERT INTO grant_condition (org_id, grant_id, description, due_on) VALUES ($1, $2, $3, $4)`, [orgId, g.id, desc.slice(0, 500), due]));
  return get(orgId, String(g.id));
}

export async function setCondition(orgId: string, id: string, b: Record<string, unknown>) {
  if (!/^\d{1,18}$/.test(id)) throw new GrantError(404, 'No such condition.');
  const c = await outsideRequestScope(() => one<any>(`SELECT * FROM grant_condition WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!c) throw new GrantError(404, 'No such condition.');
  const status = String(b.status ?? '');
  if (!['pending', 'met', 'breached', 'waived'].includes(status)) throw new GrantError(422, 'status is pending, met, breached or waived.');
  const note = b.note ? String(b.note).slice(0, 500) : null;
  if ((status === 'breached' || status === 'waived') && !note && !c.note) throw new GrantError(422, `Say why the condition is ${status} (note).`);
  const met = status === 'met' ? String(b.metOn ?? today()) : null;
  if (met && !DATE_RE.test(met)) throw new GrantError(422, 'metOn is YYYY-MM-DD.');
  await outsideRequestScope(() => query(`UPDATE grant_condition SET status = $2, met_on = $3, note = COALESCE($4, note) WHERE id = $1`, [c.id, status, met, note]));
  if (status !== 'pending') await outsideRequestScope(() => resolveAlertsFor(orgId, DUE, 'grant_condition', String(c.id))).catch(() => 0);
  return get(orgId, String(c.grant_id));
}

/** kWh charged in a period at the grant's site (or every site), from the sessions. */
export async function kwhFor(orgId: string, siteId: string | null, from: string, to: string) {
  const r = await outsideRequestScope(() => one<{ wh: string }>(
    `SELECT COALESCE(sum(cs.energy_wh), 0)::bigint AS wh FROM charging_session cs WHERE cs.org_id = $1 AND cs.state IN ('ended', 'rated', 'settled') AND ($2::uuid IS NULL OR cs.site_id = $2::uuid)
        AND (cs.started_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date`, [orgId, siteId, from, to, zone()]));
  return Math.round(Number(r?.wh ?? 0)) / 1000;
}

export async function claim(orgId: string, grantId: string, b: Record<string, unknown>, userId: string | null) {
  const g = await get(orgId, grantId);
  if (['rejected', 'completed', 'clawed_back', 'applied'].includes(g.status)) throw new GrantError(409, `The grant is ${g.status.replace('_', ' ')}.`);
  const pf = b.periodFrom ? String(b.periodFrom) : null, pt = b.periodTo ? String(b.periodTo) : null;
  if ((pf && !DATE_RE.test(pf)) || (pt && !DATE_RE.test(pt)) || (pf && pt && pt < pf)) throw new GrantError(422, 'periodFrom and periodTo are YYYY-MM-DD, to on or after from.');
  let kwh: number | null = null, amount = b.amount == null || b.amount === '' ? null : Number(b.amount);
  if (g.kind === 'per_kwh') {
    if (!pf || !pt) throw new GrantError(422, 'A per-kWh claim has its period (periodFrom, periodTo).');
    kwh = b.kwh == null || b.kwh === '' ? await kwhFor(orgId, g.siteId, pf, pt) : Number(b.kwh);
    if (!Number.isFinite(kwh) || kwh < 0) throw new GrantError(422, 'kwh is 0 or more.');
    if (amount == null) amount = Math.round(kwh * (g.ratePerKwh ?? 0));
  }
  if (amount == null || !Number.isInteger(amount) || amount <= 0) throw new GrantError(422, 'amount is a whole amount above 0.');
  if (g.awarded > 0 && amount > g.toClaim) throw new GrantError(422, `At most ${g.toClaim} is left to claim of the ${g.awarded} awarded.`);
  const submit = b.submit === true || b.submit === 'true';
  for (let k = 0; k < 5; k++) {
    const n = await outsideRequestScope(() => one<{ n: string }>(`SELECT count(*) AS n FROM grant_claim WHERE org_id = $1`, [orgId]));
    try {
      await outsideRequestScope(() => query(`INSERT INTO grant_claim (org_id, grant_id, number, period_from, period_to, kwh, amount_minor, status, submitted_on, reference, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [orgId, g.id, `GC-${String(Number(n?.n ?? 0) + 1 + k).padStart(5, '0')}`, pf, pt, kwh, amount, submit ? 'submitted' : 'draft', submit ? today() : null, b.reference ? String(b.reference).slice(0, 80) : null, b.note ? String(b.note).slice(0, 500) : null, userId]));
      return get(orgId, g.id);
    } catch (e) { if ((e as any).code !== '23505') throw e; }
  }
  throw new GrantError(409, 'Could not number the claim. Try again.');
}

const CLAIM_NEXT: Record<string, string[]> = { draft: ['submitted'], submitted: ['approved', 'rejected', 'paid'], approved: ['paid'], rejected: [], paid: [] };

export async function updateClaim(orgId: string, id: string, b: Record<string, unknown>) {
  if (!/^\d{1,18}$/.test(id)) throw new GrantError(404, 'No such claim.');
  const c = await outsideRequestScope(() => one<any>(`SELECT * FROM grant_claim WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!c) throw new GrantError(404, 'No such claim.');
  const status = String(b.status ?? '');
  if (!CLAIM_NEXT[c.status]!.includes(status)) throw new GrantError(409, `A ${c.status} claim moves to ${CLAIM_NEXT[c.status]!.join(' or ') || 'nothing'}.`);
  const on = String(b.on ?? today());
  if (!DATE_RE.test(on)) throw new GrantError(422, 'on is YYYY-MM-DD.');
  let paid: number | null = null;
  if (status === 'approved' || status === 'paid') await assertOpen(orgId, on.slice(0, 7), status === 'paid' ? 'A grant payment' : 'A grant approval', ERR);
  if (status === 'paid') {
    paid = b.paid == null || b.paid === '' ? Number(c.amount_minor) : Number(b.paid);
    if (!Number.isInteger(paid) || paid < 0 || paid > Number(c.amount_minor)) throw new GrantError(422, `paid is 0 to the claim's ${c.amount_minor}.`);
  }
  await outsideRequestScope(() => query(
    `UPDATE grant_claim SET status = $2, submitted_on = CASE WHEN $2 = 'submitted' THEN $3::date ELSE submitted_on END, approved_on = CASE WHEN $2 = 'approved' THEN $3::date WHEN $2 = 'paid' THEN COALESCE(approved_on, $3::date) ELSE approved_on END,
       paid_on = CASE WHEN $2 = 'paid' THEN $3::date ELSE paid_on END, paid_minor = COALESCE($4, paid_minor), cash_account_id = COALESCE($5, cash_account_id), reference = COALESCE($6, reference), note = COALESCE($7, note) WHERE id = $1`,
    [c.id, status, on, paid, b.cashAccountId ? String(b.cashAccountId) : null, b.reference ? String(b.reference).slice(0, 80) : null, b.note ? String(b.note).slice(0, 500) : null]));
  if (status === 'paid') await outsideRequestScope(() => query(`UPDATE grant_programme SET status = 'active' WHERE id = $1 AND status = 'awarded'`, [c.grant_id]));
  return get(orgId, String(c.grant_id));
}

export async function clawback(orgId: string, grantId: string, b: Record<string, unknown>, userId: string | null) {
  const g = await get(orgId, grantId);
  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > g.received) throw new GrantError(422, `amount is above 0 and at most the ${g.received} received.`);
  const on = String(b.onDate ?? today());
  if (!DATE_RE.test(on)) throw new GrantError(422, 'onDate is YYYY-MM-DD.');
  await assertOpen(orgId, on.slice(0, 7), 'A clawback', ERR);
  const note = String(b.note ?? '').trim();
  if (note.length < 3) throw new GrantError(422, 'Say why the grant is clawed back (note).');
  const cond = b.conditionId ? String(b.conditionId) : null;
  if (cond && !g.conditions.some((c) => c.id === cond)) throw new GrantError(422, 'No such condition on this grant.');
  await outsideRequestScope(() => query(`INSERT INTO grant_clawback (org_id, grant_id, condition_id, amount_minor, on_date, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [orgId, g.id, cond, amount, on, note.slice(0, 500), userId]));
  if (amount >= g.received) await outsideRequestScope(() => query(`UPDATE grant_programme SET status = 'clawed_back' WHERE id = $1`, [g.id]));
  return get(orgId, g.id);
}

export async function repayClawback(orgId: string, id: string, b: Record<string, unknown>) {
  if (!/^\d{1,18}$/.test(id)) throw new GrantError(404, 'No such clawback.');
  const c = await outsideRequestScope(() => one<any>(`SELECT * FROM grant_clawback WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!c) throw new GrantError(404, 'No such clawback.');
  if (c.repaid_on) throw new GrantError(409, 'Already repaid.');
  const on = String(b.repaidOn ?? today());
  if (!DATE_RE.test(on)) throw new GrantError(422, 'repaidOn is YYYY-MM-DD.');
  await assertOpen(orgId, on.slice(0, 7), 'A clawback repayment', ERR);
  await outsideRequestScope(() => query(`UPDATE grant_clawback SET repaid_on = $2, cash_account_id = $3 WHERE id = $1`, [c.id, on, b.cashAccountId ? String(b.cashAccountId) : null]));
  return get(orgId, String(c.grant_id));
}

/** The month's journal lines per currency (the ledger's 'grants' source). */
export async function journal(orgId: string, month: string) {
  const gs = await outsideRequestScope(() => many<any>(`${G_SELECT} WHERE g.org_id = $1`, [orgId]));
  const p = await parts(orgId, gs.map((g) => String(g.id)));
  const accts = await outsideRequestScope(() => many<any>(`SELECT id::text AS id, kind FROM cash_account WHERE org_id = $1`, [orgId]));
  const bank = (id: unknown) => (accts.find((a) => a.id === String(id ?? ''))?.kind === 'cash' ? '1050' : '1100');
  const out: Record<string, Array<{ account: string; debit: number; credit: number; description: string }>> = {};
  for (const g of gs) {
    const L = (out[g.currency] ??= []), name = `${g.grantor} ${g.programme}`.slice(0, 80);
    const cl = p.claims.filter((c) => String(c.grant_id) === String(g.id)), cw = p.claws.filter((c) => String(c.grant_id) === String(g.id));
    for (const c of cl) {
      const amt = Number(c.amount_minor), paid = Number(c.paid_minor ?? amt);
      if (g.kind === 'capital') {
        if (c.status === 'paid' && c.paid_s?.slice(0, 7) === month && paid) L.push({ account: bank(c.cash_account_id), debit: paid, credit: 0, description: `${c.number} received` }, { account: '2600', debit: 0, credit: paid, description: `${c.number} received` });
      } else {
        if ((c.status === 'approved' || c.status === 'paid') && c.app_s?.slice(0, 7) === month) L.push({ account: '1350', debit: amt, credit: 0, description: `${c.number} approved` }, { account: '4400', debit: 0, credit: amt, description: `${c.number} approved` });
        if (c.status === 'paid' && c.paid_s?.slice(0, 7) === month) {
          if (paid) L.push({ account: bank(c.cash_account_id), debit: paid, credit: 0, description: `${c.number} received` }, { account: '1350', debit: 0, credit: paid, description: `${c.number} received` });
          if (amt > paid) L.push({ account: '4400', debit: amt - paid, credit: 0, description: `${c.number} paid short` }, { account: '1350', debit: 0, credit: amt - paid, description: `${c.number} paid short` });
        }
      }
    }
    if (g.kind === 'capital') {
      const stop = cw.length ? cw.map((c) => c.on_s.slice(0, 7)).sort()[0]! : null;
      const receipts = cl.filter((c) => c.status === 'paid' && c.paid_s).map((c) => ({ month: c.paid_s.slice(0, 7), amount: Number(c.paid_minor ?? c.amount_minor) }));
      const rel = releaseIn(receipts, g.release_months ?? 96, month, stop);
      if (rel) L.push({ account: '2600', debit: rel, credit: 0, description: `${name} released` }, { account: '4400', debit: 0, credit: rel, description: `${name} released` });
    }
    // Clawbacks: from what is deferred at the month's end (before the clawback), the rest an expense.
    for (const c of cw.filter((x) => x.on_s.slice(0, 7) === month)) {
      const amt = Number(c.amount_minor);
      let fromDeferred = 0;
      if (g.kind === 'capital') {
        const before = position(g, cl, cw.filter((x) => x.on_s < c.on_s || (x.on_s === c.on_s && Number(x.id) < Number(c.id))), month);
        fromDeferred = Math.min(before.deferred, amt);
      }
      if (fromDeferred) L.push({ account: '2600', debit: fromDeferred, credit: 0, description: `Clawback ${name}` });
      if (amt - fromDeferred) L.push({ account: '6700', debit: amt - fromDeferred, credit: 0, description: `Clawback ${name}` });
      L.push({ account: '2610', debit: 0, credit: amt, description: `Clawback ${name}` });
    }
    for (const c of cw.filter((x) => x.rep_s?.slice(0, 7) === month)) L.push({ account: '2610', debit: Number(c.amount_minor), credit: 0, description: `Clawback repaid ${name}` }, { account: bank(c.cash_account_id), debit: 0, credit: Number(c.amount_minor), description: `Clawback repaid ${name}` });
  }
  return out;
}

/** For the cash position: claims received and clawbacks repaid through a cash account. */
export async function cashMoves(orgId: string, upTo: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT cash_account_id::text AS a, to_char(paid_on, 'YYYY-MM-DD') AS d, COALESCE(paid_minor, amount_minor) AS amt FROM grant_claim WHERE org_id = $1 AND status = 'paid' AND cash_account_id IS NOT NULL AND paid_on <= $2::date
     UNION ALL SELECT cash_account_id::text, to_char(repaid_on, 'YYYY-MM-DD'), -amount_minor FROM grant_clawback WHERE org_id = $1 AND repaid_on IS NOT NULL AND cash_account_id IS NOT NULL AND repaid_on <= $2::date`, [orgId, upTo]));
  return rows.map((r) => ({ account_id: r.a as string, d: r.d as string, amount: Number(r.amt) }));
}

export async function registerXlsx(orgId: string): Promise<Buffer> {
  const o = await overview(orgId);
  return xlsx([
    { name: 'Grants', rows: [['Grantor', 'Programme', 'Reference', 'Kind', 'Currency', 'Awarded', 'Claimed', 'Received', 'Released', 'Deferred', 'Clawed back', 'Status', 'Next condition'],
      ...o.grants.map((g) => [g.grantor, g.programme, g.reference ?? '', g.kind, g.currency, g.awarded, g.claimed, g.received, g.released, g.deferred, g.clawedBack, g.status, g.nextCondition ? `${g.nextCondition.dueOn ?? ''} ${g.nextCondition.description}` : ''])],
      widths: [22, 30, 14, 9, 8, 16, 16, 16, 16, 16, 14, 11, 40], formats: [null, null, null, null, null, 'money', 'money', 'money', 'money', 'money', 'money', null, null] },
    { name: 'Claims', rows: [['Grant', 'Number', 'From', 'To', 'kWh', 'Amount', 'Status', 'Submitted', 'Approved', 'Paid on', 'Paid'],
      ...o.grants.flatMap((g) => g.claims.map((c) => [`${g.grantor} ${g.programme}`, c.number, c.periodFrom ?? '', c.periodTo ?? '', c.kwh, c.amount, c.status, c.submittedOn ?? '', c.approvedOn ?? '', c.paidOn ?? '', c.paid]))],
      widths: [30, 10, 11, 11, 10, 16, 10, 11, 11, 11, 16], formats: [null, null, null, null, null, 'money', null, null, null, null, 'money'] },
    { name: 'Conditions', rows: [['Grant', 'Condition', 'Due', 'Status', 'Met on', 'Note'], ...o.grants.flatMap((g) => g.conditions.map((c) => [`${g.grantor} ${g.programme}`, c.description, c.dueOn ?? '', c.status, c.metOn ?? '', c.note ?? '']))],
      widths: [30, 50, 11, 10, 11, 40] },
  ]);
}

/** Daily: pending conditions due within 14 days (warning) or past due (critical). */
export async function sweep(now = new Date()): Promise<number> {
  const t = today(now);
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT c.id, c.org_id, c.description, to_char(c.due_on, 'YYYY-MM-DD') AS due_s, g.grantor, g.programme FROM grant_condition c JOIN grant_programme g ON g.id = c.grant_id
      WHERE c.status = 'pending' AND c.due_on IS NOT NULL AND c.due_on <= $1::date + 14 AND g.status NOT IN ('rejected', 'completed', 'clawed_back')`, [t]));
  let n = 0;
  for (const r of rows) {
    try {
      const left = days(t, r.due_s);
      await outsideRequestScope(() => persistAlert({ orgId: r.org_id, kind: DUE, severity: left < 0 ? 'critical' : 'warning', targetType: 'grant_condition', targetId: String(r.id),
        message: `${r.grantor} ${r.programme}: "${r.description}" ${left < 0 ? `was due on ${r.due_s}` : `is due on ${r.due_s} (${left} days)`}. A breach can mean a clawback. Finance → Grants.` }));
      n++;
    } catch (e) { logger.warn({ condition: r.id, err: (e as Error).message }, 'grant condition sweep failed'); }
  }
  return n;
}
