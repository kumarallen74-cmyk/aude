import { many, one, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { pnl } from './shared-costs.js';
import { reportingCurrency } from './fx.js';

/**
 * Multi-entity consolidation (v1.28.0). A group is a parent organisation and its subsidiaries
 * (organisation.parent_org_id = the parent). The parent's finance users see, for a month:
 *
 *   per entity    revenue (before tax), energy cost, shared costs, depreciation and contribution (the site P&L,
 *                 services/shared-costs.ts), owners' shares and PlugSure's fees on the month's finalised statements,
 *                 and the operating result; per currency
 *   group         the entities added up per currency, less intercompany eliminations; and in the parent's reporting
 *                 currency at the parent's monthly rates (Finance → Settings → Currency), with the currencies missing a
 *                 rate named
 *   eliminations  recorded by the parent (revenue or cost, an amount, a reason), voided with a reason; suggested:
 *                 fleet invoices one group entity issued to a fleet account whose NPWP is another entity's
 *   KPIs          sessions, kWh, sites and chargers per entity
 */

export class GroupError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const zone = () => config.billing.timeZone;
const npwpDigits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const lastMonth = () => {
  let [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(new Date()).slice(0, 7).split('-').map(Number) as [number, number];
  m--; if (m === 0) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
};

/** The group the caller's organisation heads (itself first), or 404 when it has no subsidiaries. */
export async function entities(parentId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT id, name, npwp, parent_org_id FROM organisation WHERE (id = $1 OR parent_org_id = $1) AND archived_at IS NULL AND sandbox_of_org_id IS NULL ORDER BY (id = $1) DESC, name`, [parentId]));
  if (rows.length < 2) throw new GroupError(404, 'Your organisation has no subsidiaries: a group is a parent organisation and the organisations under it.');
  return rows.map((r) => ({ id: r.id as string, name: r.name as string, npwp: r.npwp as string | null, parent: r.id === parentId }));
}

type Money = Record<string, number>;
const add = (a: Money, cur: string, v: number) => { a[cur] = (a[cur] ?? 0) + v; };

export async function consolidated(parentId: string, monthRaw?: unknown) {
  const month = monthRaw == null || monthRaw === '' ? lastMonth() : String(monthRaw);
  if (!MONTH_RE.test(month)) throw new GroupError(422, 'month is YYYY-MM.');
  const ents = await entities(parentId);
  const ids = ents.map((e) => e.id);
  const [statements, kpis, elims] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT org_id, currency, COALESCE(sum(owner_share_minor) FILTER (WHERE owner_id IS NOT NULL), 0)::bigint AS owners,
              COALESCE(sum(net_minor) FILTER (WHERE owner_id IS NULL), 0)::bigint AS fees
         FROM commission_statement WHERE org_id = ANY($1::uuid[]) AND finalised_at IS NOT NULL AND to_char(period, 'YYYY-MM') = $2 GROUP BY 1, 2`, [ids, month])),
    outsideRequestScope(() => many<any>(
      `SELECT o.id AS org_id,
              (SELECT count(*) FROM site s WHERE s.org_id = o.id AND s.archived_at IS NULL)::int AS sites,
              (SELECT count(*) FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE s.org_id = o.id)::int AS chargers,
              (SELECT count(*) FROM cdr d WHERE d.org_id = o.id AND NOT COALESCE(d.test_mode, false) AND to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM') = $2)::int AS sessions,
              (SELECT COALESCE(sum(cs.energy_wh), 0) FROM cdr d JOIN charging_session cs ON cs.id = d.session_id WHERE d.org_id = o.id AND NOT COALESCE(d.test_mode, false) AND to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM') = $2)::bigint AS wh
         FROM organisation o WHERE o.id = ANY($1::uuid[])`, [ids, month, zone()])),
    eliminations(parentId, month),
  ]);
  const perEntity = [];
  const group = { revenue: {} as Money, energyCost: {} as Money, shared: {} as Money, depreciation: {} as Money, contribution: {} as Money, ownerShares: {} as Money, platformFees: {} as Money, operating: {} as Money };
  for (const e of ents) {
    const p = await pnl(e.id, month);
    const lines: Record<string, any> = {};
    for (const [cur, t] of Object.entries(p.totals)) {
      lines[cur] = { revenue: t.revenue, energyCost: t.energyCost, shared: t.shared, depreciation: t.depreciation, contribution: t.contribution, ownerShares: 0, platformFees: 0 };
    }
    for (const s of statements.filter((x) => x.org_id === e.id)) {
      const l = (lines[s.currency] ??= { revenue: 0, energyCost: 0, shared: 0, depreciation: 0, contribution: 0, ownerShares: 0, platformFees: 0 });
      l.ownerShares += Number(s.owners); l.platformFees += Number(s.fees);
    }
    for (const [cur, l] of Object.entries(lines)) {
      l.operating = l.contribution - l.ownerShares - l.platformFees;
      for (const k of Object.keys(group) as Array<keyof typeof group>) add(group[k], cur, l[k] ?? 0);
    }
    const k = kpis.find((x) => x.org_id === e.id);
    perEntity.push({ ...e, currencies: lines, sessions: k?.sessions ?? 0, kwh: Math.round(Number(k?.wh ?? 0) / 100) / 10, sites: k?.sites ?? 0, chargers: k?.chargers ?? 0 });
  }
  // Eliminations: intercompany revenue and cost come out of the group's figures.
  const elimRev: Money = {}, elimCost: Money = {};
  for (const x of elims.recorded) add(x.kind === 'revenue' ? elimRev : elimCost, x.currency, x.amount);
  const net: Record<string, { revenue: number; operating: number }> = {};
  for (const cur of new Set([...Object.keys(group.revenue), ...Object.keys(elimRev), ...Object.keys(elimCost)])) {
    // Revenue eliminated reduces revenue and the result; the matching cost eliminated adds it back.
    net[cur] = { revenue: (group.revenue[cur] ?? 0) - (elimRev[cur] ?? 0), operating: (group.operating[cur] ?? 0) - (elimRev[cur] ?? 0) + (elimCost[cur] ?? 0) };
  }
  // In the parent's reporting currency.
  const reporting = await reportingCurrency(parentId);
  let inReporting: any = null;
  if (reporting) {
    const rs = await outsideRequestScope(() => many<{ currency: string; rate: string }>(`SELECT currency, rate FROM fx_rate WHERE org_id = $1 AND month = $2 AND reporting = $3`, [parentId, month, reporting]));
    const rate = new Map(rs.map((r) => [r.currency, Number(r.rate)]));
    const conv = (m: Record<string, number>) => {
      let v = 0; const missing: string[] = [];
      for (const [c, n] of Object.entries(m)) { if (!n) continue; if (c === reporting) v += n; else if (rate.has(c)) v += n * rate.get(c)!; else missing.push(c); }
      return { amount: Math.round(v), missing };
    };
    const rev = conv(Object.fromEntries(Object.entries(net).map(([c, x]) => [c, x.revenue])));
    const op = conv(Object.fromEntries(Object.entries(net).map(([c, x]) => [c, x.operating])));
    inReporting = { currency: reporting, revenue: rev.amount, operating: op.amount, missing: [...new Set([...rev.missing, ...op.missing])] };
  }
  return { month, entities: perEntity, group, eliminations: elims, eliminated: { revenue: elimRev, cost: elimCost }, net, reporting: inReporting };
}

/** Recorded eliminations and suggestions (fleet invoices between group entities by NPWP). */
export async function eliminations(parentId: string, month: string) {
  const ents = await entities(parentId);
  const npwps = new Map(ents.filter((e) => npwpDigits(e.npwp).length >= 15).map((e) => [npwpDigits(e.npwp), e]));
  const [rows, invs] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT x.*, u.name AS by_name FROM consolidation_elimination x LEFT JOIN app_user u ON u.id = x.recorded_by WHERE x.org_id = $1 AND x.month = $2 ORDER BY x.created_at`, [parentId, month])),
    outsideRequestScope(() => many<any>(
      `SELECT i.org_id, i.number, i.tax_base_minor, i.currency, a.tax_id, a.name FROM fleet_invoice i JOIN fleet_account a ON a.id = i.fleet_account_id
        WHERE i.org_id = ANY($1::uuid[]) AND i.status IN ('issued', 'paid') AND to_char(i.period, 'YYYY-MM') = $2 AND a.tax_id IS NOT NULL`, [ents.map((e) => e.id), month])),
  ]);
  const recorded = rows.filter((r) => !r.voided_at).map((r) => ({ id: String(r.id), kind: r.kind, description: r.description, amount: Number(r.amount_minor), currency: r.currency, by: r.by_name ?? null, at: new Date(r.created_at).toISOString() }));
  const suggestions = invs.filter((i) => npwps.has(npwpDigits(i.tax_id)) && npwps.get(npwpDigits(i.tax_id))!.id !== i.org_id).map((i) => {
    const seller = ents.find((e) => e.id === i.org_id)!, buyer = npwps.get(npwpDigits(i.tax_id))!;
    const description = `Fleet invoice ${i.number}: ${seller.name} to ${buyer.name}`;
    return { kind: 'revenue', description, amount: Number(i.tax_base_minor), currency: i.currency, recorded: recorded.some((r) => r.description === description) };
  });
  return { recorded, voided: rows.filter((r) => r.voided_at).length, suggestions };
}

export async function recordElimination(parentId: string, b: Record<string, unknown>, userId: string | null) {
  await entities(parentId);
  const month = String(b.month ?? '');
  if (!MONTH_RE.test(month)) throw new GroupError(422, 'month is YYYY-MM.');
  const kind = String(b.kind ?? '');
  if (kind !== 'revenue' && kind !== 'cost') throw new GroupError(422, 'kind is revenue or cost.');
  const description = String(b.description ?? '').trim();
  if (!description || description.length > 300) throw new GroupError(422, 'Describe the intercompany amount (up to 300 characters).');
  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new GroupError(422, 'The amount is a whole number above zero (minor units).');
  const currency = String(b.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new GroupError(422, 'The currency is a three-letter code.');
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO consolidation_elimination (org_id, month, kind, description, amount_minor, currency, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [parentId, month, kind, description, amount, currency, userId]));
  return { id: String(r!.id), month, kind, description, amount, currency };
}

export async function voidElimination(parentId: string, id: string, reasonRaw: unknown, userId: string | null) {
  const reason = String(reasonRaw ?? '').trim();
  if (!reason) throw new GroupError(422, 'Say why it is voided.');
  if (!/^\d{1,18}$/.test(id)) throw new GroupError(404, 'No such elimination.');
  const r = await outsideRequestScope(() => one(`UPDATE consolidation_elimination SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE id = $1 AND org_id = $2 AND voided_at IS NULL RETURNING id`, [id, parentId, userId, reason.slice(0, 300)]));
  if (!r) throw new GroupError(404, 'No such elimination.');
  return { ok: true };
}

/** Twelve months of the group's net revenue and operating result per currency. */
export async function trend(parentId: string, monthRaw?: unknown) {
  const month = monthRaw == null || monthRaw === '' ? lastMonth() : String(monthRaw);
  if (!MONTH_RE.test(month)) throw new GroupError(422, 'month is YYYY-MM.');
  const months: string[] = [];
  let [y, m] = month.split('-').map(Number) as [number, number];
  for (let i = 0; i < 12; i++) { months.unshift(`${y}-${String(m).padStart(2, '0')}`); m--; if (m === 0) { m = 12; y--; } }
  const rows = [];
  for (const mo of months) {
    const c = await consolidated(parentId, mo);
    for (const [cur, v] of Object.entries(c.net)) rows.push({ month: mo, currency: cur, revenue: v.revenue, operating: v.operating });
  }
  return { months, rows };
}

