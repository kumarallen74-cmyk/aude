import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { group, settle } from './intercompany.js';
import { xlsx } from './xlsx.js';

/**
 * Intercompany netting and transfer pricing (v1.40.0), on top of the recharges (v1.31.0), across the whole group.
 *
 *   netting           every issued, unsettled recharge between any two entities of the group, per currency: the
 *                     bilateral net per pair, and each entity's multilateral net position. The proposal: with the
 *                     parent as the netting centre, each entity with a net payable pays the centre once and the centre
 *                     pays each net receivable once (the transfers saved against paying every pair are shown).
 *                     Settling (the parent only) settles every pair's recharges as the bilateral settlement does.
 *   transfer pricing  the group's policy per kind of recharge (management fee, shared services, IT services, energy
 *                     resale, equipment rental, other): the method (cost plus, pass-through at cost, comparable
 *                     uncontrolled price) and the arm's-length mark-up range. Each recharge gets its kind and the cost
 *                     underneath; the check shows its mark-up against the range (below, above, no cost, unclassified).
 *                     The workpaper (Excel) is the year's transactions per counterparty and kind with the method and
 *                     the mark-up, for the transfer-pricing documentation (Local File).
 */

export class NettingError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const ERR = (s: number, m: string) => new NettingError(s, m);
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
export const TP_KINDS = ['management_fee', 'shared_services', 'it_services', 'energy_resale', 'equipment_rental', 'other'] as const;
export const METHODS = ['cost_plus', 'pass_through', 'cup'] as const;

type Pos = { orgId: string; name: string; net: number };

/** Transfers through a netting centre: each payer pays the centre, the centre pays each receiver. Pure. */
export function viaCentre(positions: Pos[], centreId: string): Array<{ from: string; to: string; amount: number }> {
  const out: Array<{ from: string; to: string; amount: number }> = [];
  for (const p of positions) {
    if (p.orgId === centreId || !p.net) continue;
    if (p.net < 0) out.push({ from: p.orgId, to: centreId, amount: -p.net });
    else out.push({ from: centreId, to: p.orgId, amount: p.net });
  }
  return out;
}

/** A recharge's transfer-pricing check against the policy. Pure. */
export function tpStatus(amount: number, cost: number | null, policy: { method: string; minPct: number; maxPct: number } | null): { markupPct: number | null; status: 'ok' | 'below' | 'above' | 'no_cost' | 'unclassified' } {
  if (!policy) return { markupPct: cost ? Math.round(((amount - cost) / cost) * 10000) / 100 : null, status: 'unclassified' };
  if (cost == null || cost === 0) return { markupPct: null, status: policy.method === 'cup' ? 'ok' : 'no_cost' };
  const m = Math.round(((amount - cost) / cost) * 10000) / 100;
  if (policy.method === 'cup') return { markupPct: m, status: 'ok' };
  return { markupPct: m, status: m < policy.minPct ? 'below' : m > policy.maxPct ? 'above' : 'ok' };
}

async function parentOf(orgId: string) {
  const g = await group(orgId);
  return { g, parent: g.find((x) => x.parent)!, isParent: g.find((x) => x.me)?.parent === true };
}

export async function netting(orgId: string, q: Record<string, unknown> = {}) {
  const { g, parent } = await parentOf(orgId);
  const ids = g.map((x) => x.id), name = new Map(g.map((x) => [x.id, x.name]));
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT org_id, to_org_id, currency, sum(amount_minor)::bigint AS amt, count(*)::int AS n FROM intercompany_recharge
      WHERE status = 'issued' AND org_id = ANY($1::uuid[]) AND to_org_id = ANY($1::uuid[]) AND ($2::text IS NULL OR currency = $2) GROUP BY 1, 2, 3`, [ids, q.currency ? String(q.currency).toUpperCase() : null]));
  const currencies = [...new Set(rows.map((r) => r.currency as string))].sort();
  return {
    group: g, parentId: parent.id, parent: parent.name,
    currencies: currencies.map((currency) => {
      const rs = rows.filter((r) => r.currency === currency);
      const pairs = new Map<string, { a: string; b: string; aToB: number; bToA: number; recharges: number }>();
      for (const r of rs) {
        const [a, b] = [r.org_id, r.to_org_id].sort() as [string, string];
        const p = pairs.get(`${a}|${b}`) ?? { a, b, aToB: 0, bToA: 0, recharges: 0 };
        // aToB: what b owes a (a charged b).
        if (r.org_id === a) p.aToB += Number(r.amt); else p.bToA += Number(r.amt);
        p.recharges += r.n; pairs.set(`${a}|${b}`, p);
      }
      const bilateral = [...pairs.values()].map((p) => {
        const net = p.aToB - p.bToA;
        return { orgA: p.a, a: name.get(p.a), orgB: p.b, b: name.get(p.b), aCharged: p.aToB, bCharged: p.bToA, recharges: p.recharges, net: Math.abs(net), payer: net > 0 ? name.get(p.b) : net < 0 ? name.get(p.a) : null, payee: net > 0 ? name.get(p.a) : net < 0 ? name.get(p.b) : null };
      });
      const pos = new Map<string, number>(ids.map((i) => [i, 0]));
      for (const r of rs) { pos.set(r.org_id, (pos.get(r.org_id) ?? 0) + Number(r.amt)); pos.set(r.to_org_id, (pos.get(r.to_org_id) ?? 0) - Number(r.amt)); }
      const positions = ids.map((i) => ({ orgId: i, name: name.get(i)!, net: pos.get(i) ?? 0 }));
      const transfers = viaCentre(positions, parent.id).map((t) => ({ ...t, fromName: name.get(t.from), toName: name.get(t.to) }));
      const gross = rs.reduce((a, r) => a + Number(r.amt), 0);
      return { currency, gross, positions, bilateral, bilateralTransfers: bilateral.filter((b) => b.net).length, transfers, settledByNetting: gross - transfers.reduce((a, t) => a + t.amount, 0) };
    }),
  };
}

/** Settle every pair's open recharges in a currency (the group's parent). */
export async function settleAll(orgId: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const { isParent } = await parentOf(orgId);
  if (!isParent) throw ERR(403, 'The group\'s parent organisation runs the netting.');
  const currency = String(b.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw ERR(422, 'currency is an ISO code.');
  const n = await netting(orgId, { currency });
  const c = n.currencies[0];
  if (!c || !c.bilateral.length) throw ERR(422, `Nothing issued and open in the group in ${currency}.`);
  const settled = [];
  for (const p of c.bilateral) settled.push(await settle(p.orgA, { otherOrgId: p.orgB, currency, settledOn: b.settledOn ?? today(now), reference: b.reference ?? `Netting ${today(now)}` }, userId, now));
  return { currency, settlements: settled, transfers: c.transfers };
}

// ─────────────────────────────────────────── transfer pricing

export async function policies(orgId: string) {
  const { parent, isParent } = await parentOf(orgId);
  const rows = await outsideRequestScope(() => many<any>(`SELECT * FROM tp_policy WHERE org_id = $1 ORDER BY kind`, [parent.id]));
  return { canEdit: isParent, policies: rows.map((r) => ({ kind: r.kind, method: r.method, markupPct: Number(r.markup_pct), minPct: Number(r.min_pct), maxPct: Number(r.max_pct), note: r.note ?? null })) };
}

export async function savePolicy(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const { isParent } = await parentOf(orgId);
  if (!isParent) throw ERR(403, 'The group\'s parent organisation sets the transfer-pricing policy.');
  const kind = String(b.kind ?? ''), method = String(b.method ?? '');
  if (!(TP_KINDS as readonly string[]).includes(kind)) throw ERR(422, `kind is one of ${TP_KINDS.join(', ')}.`);
  if (!(METHODS as readonly string[]).includes(method)) throw ERR(422, `method is one of ${METHODS.join(', ')}.`);
  const num = (k: string, d: number) => { const v = b[k] == null || b[k] === '' ? d : Number(b[k]); if (!Number.isFinite(v) || v < -100 || v > 1000) throw ERR(422, `${k} is a percentage.`); return v; };
  const markup = method === 'pass_through' ? 0 : num('markupPct', 5);
  const min = method === 'pass_through' ? 0 : num('minPct', markup), max = method === 'pass_through' ? 0 : num('maxPct', markup);
  if (min > max) throw ERR(422, 'minPct is at most maxPct.');
  await outsideRequestScope(() => query(
    `INSERT INTO tp_policy (org_id, kind, method, markup_pct, min_pct, max_pct, note, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (org_id, kind) DO UPDATE SET method = EXCLUDED.method, markup_pct = EXCLUDED.markup_pct, min_pct = EXCLUDED.min_pct, max_pct = EXCLUDED.max_pct, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, kind, method, markup, min, max, b.note == null || b.note === '' ? null : String(b.note).slice(0, 500), userId]));
  return policies(orgId);
}

/** Classify a recharge the caller issued: its kind and the cost underneath. */
export async function setRechargeTp(orgId: string, id: string, b: Record<string, unknown>) {
  if (!/^\d{1,18}$/.test(id)) throw ERR(404, 'No such recharge.');
  const r = await outsideRequestScope(() => one<any>(`SELECT id, status FROM intercompany_recharge WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!r) throw ERR(404, 'No such recharge (the entity that charged it classifies it).');
  if (r.status === 'void') throw ERR(409, 'The recharge is void.');
  const kind = String(b.tpKind ?? '');
  if (!(TP_KINDS as readonly string[]).includes(kind)) throw ERR(422, `tpKind is one of ${TP_KINDS.join(', ')}.`);
  const cost = b.cost == null || b.cost === '' ? null : Number(b.cost);
  if (cost != null && (!Number.isSafeInteger(cost) || cost < 0)) throw ERR(422, 'cost is the cost underneath, in minor units.');
  await outsideRequestScope(() => query(`UPDATE intercompany_recharge SET tp_kind = $3, cost_minor = $4 WHERE id = $1 AND org_id = $2`, [id, orgId, kind, cost]));
  return { id, tpKind: kind, cost };
}

/** The group's recharges of a year against the policy. */
export async function tpCheck(orgId: string, yearRaw?: unknown, now = new Date()) {
  const year = yearRaw == null || yearRaw === '' ? Number(today(now).slice(0, 4)) : Number(yearRaw);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw ERR(400, 'year is YYYY.');
  const { g } = await parentOf(orgId);
  const ids = g.map((x) => x.id), name = new Map(g.map((x) => [x.id, x.name]));
  const pol = new Map((await policies(orgId)).policies.map((p) => [p.kind, p]));
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT id, org_id, to_org_id, number, month, description, amount_minor, currency, status, tp_kind, cost_minor FROM intercompany_recharge
      WHERE org_id = ANY($1::uuid[]) AND status IN ('issued', 'settled') AND month LIKE $2 ORDER BY month, number`, [ids, `${year}-%`]));
  const items = rows.map((r) => {
    const p = r.tp_kind ? pol.get(r.tp_kind) ?? null : null;
    const amount = Number(r.amount_minor), cost = r.cost_minor == null ? null : Number(r.cost_minor);
    const st = r.tp_kind ? tpStatus(amount, cost, p) : { markupPct: null, status: 'unclassified' as const };
    return { id: String(r.id), number: r.number, month: r.month, from: name.get(r.org_id), fromOrgId: r.org_id, to: name.get(r.to_org_id), description: r.description, currency: r.currency, amount, tpKind: r.tp_kind ?? null, method: p?.method ?? null, cost, range: p ? [p.minPct, p.maxPct] : null, ...st, mine: r.org_id === orgId };
  });
  const count = (s: string) => items.filter((i) => i.status === s).length;
  return { year, items, summary: { total: items.length, ok: count('ok'), below: count('below'), above: count('above'), noCost: count('no_cost'), unclassified: count('unclassified') } };
}

export async function workpaper(orgId: string, yearRaw?: unknown): Promise<Buffer> {
  const [c, p] = await Promise.all([tpCheck(orgId, yearRaw), policies(orgId)]);
  const per = new Map<string, { from: string; to: string; kind: string; currency: string; amount: number; cost: number; n: number }>();
  for (const i of c.items) { const k = `${i.from}|${i.to}|${i.tpKind ?? '-'}|${i.currency}`; const x = per.get(k) ?? { from: i.from!, to: i.to!, kind: i.tpKind ?? 'unclassified', currency: i.currency, amount: 0, cost: 0, n: 0 }; x.amount += i.amount; x.cost += i.cost ?? 0; x.n++; per.set(k, x); }
  return xlsx([
    { name: 'Policy', rows: [['Kind', 'Method', 'Mark-up %', 'Range from %', 'Range to %', 'Note'], ...p.policies.map((x) => [x.kind, x.method, x.markupPct, x.minPct, x.maxPct, x.note ?? ''])], widths: [18, 14, 10, 12, 12, 40] },
    { name: 'Summary', rows: [['From', 'To', 'Kind', 'Currency', 'Recharges', 'Amount', 'Cost', 'Mark-up %'], ...[...per.values()].map((x) => [x.from, x.to, x.kind, x.currency, x.n, x.amount, x.cost, x.cost ? Math.round(((x.amount - x.cost) / x.cost) * 10000) / 100 : ''])],
      widths: [24, 24, 18, 8, 10, 16, 16, 10], formats: [null, null, null, null, null, 'money', 'money', null] },
    { name: 'Transactions', rows: [['Recharge', 'Month', 'From', 'To', 'Description', 'Currency', 'Amount', 'Kind', 'Method', 'Cost', 'Mark-up %', 'Check'], ...c.items.map((i) => [i.number, i.month, i.from, i.to, i.description, i.currency, i.amount, i.tpKind ?? '', i.method ?? '', i.cost ?? '', i.markupPct ?? '', i.status])],
      widths: [10, 9, 22, 22, 30, 8, 14, 16, 12, 14, 10, 12], formats: [null, null, null, null, null, null, 'money', null, null, 'money', null, null] },
  ]);
}
