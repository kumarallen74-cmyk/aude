import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { unseal } from './secrets.js';
import { sendEmail } from './notify-transports.js';
import { xlsx } from './xlsx.js';
import { duePeriod } from './report-schedules.js';

/**
 * The custom report builder (v1.42.0).
 *
 * People choose a dataset, its columns, filters, grouping (with date buckets), sort and a chart; a report can be saved,
 * run, downloaded in Excel and e-mailed daily, weekly or monthly.
 *
 * Safety: nobody writes SQL. Every dataset and field is defined here; the spec names them by key and is validated
 * against this catalogue; each filter's value is a query parameter, cast to the field's type; every dataset's base is
 * restricted to the organisation (its own org_id column — the query runs unscoped, so the worker can send it, and the
 * filter is what keeps tenants apart); results are capped (MAX_ROWS). A dataset needs its permission to be run.
 */

export class ReportBuilderError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const MAX_ROWS = 5000;
const zone = () => config.billing.timeZone;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FieldType = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'bool';
export interface Field { key: string; label: string; type: FieldType; sql: string }
export interface Dataset { key: string; label: string; permission: string; from: string; org: string; fields: Field[]; description: string }

const f = (key: string, label: string, type: FieldType, sql: string): Field => ({ key, label, type, sql });

export const DATASETS: Dataset[] = [
  {
    key: 'sessions', label: 'Charging sessions', permission: 'session:read', description: 'Every charging session, with its site, charger and receipt.',
    from: `charging_session cs JOIN site s ON s.id = cs.site_id LEFT JOIN charge_point cp ON cp.id = cs.charge_point_id LEFT JOIN cdr d ON d.session_id = cs.id`, org: 'cs.org_id',
    fields: [
      f('started_at', 'Started', 'datetime', 'cs.started_at'), f('ended_at', 'Ended', 'datetime', 'cs.ended_at'),
      f('site', 'Site', 'text', 's.name'), f('charger', 'Charger', 'text', 'COALESCE(cp.display_name, cp.ocpp_identity)'),
      f('state', 'State', 'text', 'cs.state'), f('stop_reason', 'Stop reason', 'text', 'cs.stop_reason'), f('payment_mode', 'Payment', 'text', 'cs.payment_mode'),
      f('energy_kwh', 'Energy (kWh)', 'number', 'COALESCE(cs.energy_wh, 0) / 1000.0'), f('duration_min', 'Duration (min)', 'number', 'COALESCE(cs.duration_s, 0) / 60.0'),
      f('idle_min', 'Idle (min)', 'number', 'COALESCE(cs.idle_minutes, 0)'),
      f('subtotal', 'Amount before tax', 'money', 'd.subtotal_minor'), f('tax', 'Tax', 'money', 'COALESCE(d.tax_minor, 0) + COALESCE(d.local_tax_minor, 0)'), f('total', 'Total', 'money', 'd.total_minor'),
      f('currency', 'Currency', 'text', 'COALESCE(d.currency, cs.currency)'), f('fleet', 'Fleet session', 'bool', 'cs.fleet_account_id IS NOT NULL'),
    ],
  },
  {
    key: 'chargers', label: 'Chargers', permission: 'charge_point:read', description: 'Each charger with its hardware, status and latest health score.',
    from: `charge_point cp JOIN site s ON s.id = cp.site_id
           LEFT JOIN LATERAL (SELECT h.score, h.risk FROM charger_health h WHERE h.charge_point_id = cp.id ORDER BY h.day DESC LIMIT 1) h ON true`, org: 's.org_id',
    fields: [
      f('charger', 'Charger', 'text', 'COALESCE(cp.display_name, cp.ocpp_identity)'), f('identity', 'OCPP identity', 'text', 'cp.ocpp_identity'), f('site', 'Site', 'text', 's.name'),
      f('vendor', 'Vendor', 'text', 'cp.vendor'), f('model', 'Model', 'text', 'cp.model'), f('firmware', 'Firmware', 'text', 'cp.firmware'), f('ocpp_version', 'OCPP version', 'text', 'cp.ocpp_version'),
      f('status', 'Status', 'text', 'cp.status'), f('last_seen_at', 'Last seen', 'datetime', 'cp.last_seen_at'), f('commissioned_at', 'Commissioned', 'datetime', 'cp.commissioned_at'),
      f('boots', 'Boots', 'number', 'COALESCE(cp.boot_count, 0)'), f('health', 'Health score', 'number', 'h.score'), f('risk', 'Health risk', 'text', 'h.risk'),
      f('decommissioned', 'Decommissioned', 'bool', 'cp.decommissioned_at IS NOT NULL'),
    ],
  },
  {
    key: 'outages', label: 'Charger outages', permission: 'charge_point:read', description: 'Each time a charger went offline, and for how long.',
    from: `charge_point_outage o JOIN charge_point cp ON cp.id = o.charge_point_id JOIN site s ON s.id = cp.site_id`, org: 'o.org_id',
    fields: [
      f('went_offline_at', 'Went offline', 'datetime', 'o.went_offline_at'), f('came_online_at', 'Came back', 'datetime', 'o.came_online_at'),
      f('hours', 'Hours offline', 'number', 'EXTRACT(EPOCH FROM (COALESCE(o.came_online_at, now()) - o.went_offline_at)) / 3600.0'),
      f('charger', 'Charger', 'text', 'COALESCE(cp.display_name, cp.ocpp_identity)'), f('site', 'Site', 'text', 's.name'), f('open', 'Still offline', 'bool', 'o.came_online_at IS NULL'),
    ],
  },
  {
    key: 'work_orders', label: 'Work orders', permission: 'payment:read', description: 'Maintenance work orders with their labour and contractor estimate.',
    from: `work_order w LEFT JOIN site s ON s.id = w.site_id LEFT JOIN charge_point cp ON cp.id = w.charge_point_id`, org: 'w.org_id',
    fields: [
      f('number', 'Number', 'text', 'w.number'), f('title', 'Title', 'text', 'w.title'), f('kind', 'Kind', 'text', 'w.kind'), f('status', 'Status', 'text', 'w.status'),
      f('opened_on', 'Opened', 'date', 'w.opened_on'), f('done_on', 'Done', 'date', 'w.done_on'), f('site', 'Site', 'text', 's.name'),
      f('charger', 'Charger', 'text', 'COALESCE(cp.display_name, cp.ocpp_identity)'), f('labour_hours', 'Labour hours', 'number', 'w.labour_hours'),
      f('labour_cost', 'Labour cost', 'money', 'round(w.labour_hours * w.labour_rate_minor)'), f('contractor_estimate', 'Contractor estimate', 'money', 'w.contractor_estimate_minor'),
      f('currency', 'Currency', 'text', 'w.currency'),
    ],
  },
  {
    key: 'ledger', label: 'Ledger lines', permission: 'payment:read', description: 'Posted general-ledger lines: account, debit, credit, source.',
    from: `gl_line l JOIN gl_entry e ON e.id = l.entry_id LEFT JOIN gl_account a ON a.org_id = l.org_id AND a.code = l.account_code`, org: `l.org_id`,
    fields: [
      f('entry_date', 'Date', 'date', 'e.entry_date'), f('month', 'Month', 'text', 'e.month'), f('number', 'Entry', 'text', 'e.number'), f('source', 'Source', 'text', 'e.source'),
      f('account', 'Account', 'text', 'l.account_code'), f('account_name', 'Account name', 'text', 'a.name'), f('memo', 'Memo', 'text', 'e.memo'),
      f('debit', 'Debit', 'money', 'l.debit'), f('credit', 'Credit', 'money', 'l.credit'), f('net', 'Debit − credit', 'money', 'l.debit - l.credit'), f('currency', 'Currency', 'text', 'e.currency'),
    ],
  },
];
// Only posted entries are ledger figures.
const EXTRA_WHERE: Record<string, string> = { ledger: `e.status = 'posted'` };

export const AGGS = ['count', 'sum', 'avg', 'min', 'max', 'count_distinct'] as const;
export const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'between', 'last_days', 'empty', 'not_empty', 'is_true', 'is_false'] as const;
export const BUCKETS = ['day', 'week', 'month', 'quarter', 'year'] as const;

export interface Column { field: string; agg?: (typeof AGGS)[number] | null; bucket?: (typeof BUCKETS)[number] | null }
export interface Filter { field: string; op: (typeof OPS)[number]; value?: unknown; value2?: unknown }
export interface Spec { columns: Column[]; filters: Filter[]; groupBy: Column[]; sort: { index: number; dir: 'asc' | 'desc' } | null; limit: number; chart: { type: 'none' | 'bar' | 'line'; x: number; y: number } | null }

const datasetOf = (key: unknown) => {
  const d = DATASETS.find((x) => x.key === key);
  if (!d) throw new ReportBuilderError(422, `dataset is one of ${DATASETS.map((x) => x.key).join(', ')}.`);
  return d;
};
const fieldOf = (d: Dataset, key: unknown) => {
  const x = d.fields.find((y) => y.key === key);
  if (!x) throw new ReportBuilderError(422, `${String(key).slice(0, 40)} is not a field of ${d.label}.`);
  return x;
};

/** The spec, checked against the catalogue (unknown keys, operators and aggregations are refused). */
export function validate(datasetKey: unknown, raw: unknown): { dataset: Dataset; spec: Spec } {
  const d = datasetOf(datasetKey);
  const s = (raw ?? {}) as Record<string, any>;
  const col = (c: any, where: string): Column => {
    const x = fieldOf(d, c?.field);
    const agg = c?.agg == null || c.agg === '' ? null : c.agg;
    if (agg !== null && !AGGS.includes(agg)) throw new ReportBuilderError(422, `${where}: agg is one of ${AGGS.join(', ')}.`);
    if (agg && ['sum', 'avg'].includes(agg) && !['number', 'money'].includes(x.type)) throw new ReportBuilderError(422, `${where}: ${agg} needs a number field (${x.label} is ${x.type}).`);
    const bucket = c?.bucket == null || c.bucket === '' ? null : c.bucket;
    if (bucket !== null && (!BUCKETS.includes(bucket) || !['date', 'datetime'].includes(x.type))) throw new ReportBuilderError(422, `${where}: a bucket (${BUCKETS.join(', ')}) is for a date field.`);
    return { field: x.key, agg, bucket };
  };
  const groupBy = (Array.isArray(s.groupBy) ? s.groupBy : []).slice(0, 4).map((c: any, i: number) => ({ ...col(c, `groupBy[${i}]`), agg: null }));
  let columns = (Array.isArray(s.columns) ? s.columns : []).slice(0, 30).map((c: any, i: number) => col(c, `columns[${i}]`));
  if (groupBy.length) {
    const bad = columns.find((c: Column) => !c.agg);
    if (bad) throw new ReportBuilderError(422, `With grouping, every column needs an aggregation (${fieldOf(d, bad.field).label} has none): the grouped fields come first by themselves.`);
  } else if (columns.some((c: Column) => c.agg) && columns.some((c: Column) => !c.agg)) {
    throw new ReportBuilderError(422, 'Mix of aggregated and plain columns: group by the plain ones, or aggregate them all.');
  }
  if (!groupBy.length && !columns.length) columns = d.fields.slice(0, 6).map((x) => ({ field: x.key, agg: null, bucket: null }));
  const filters = (Array.isArray(s.filters) ? s.filters : []).slice(0, 20).map((x: any, i: number): Filter => {
    const fld = fieldOf(d, x?.field);
    if (!OPS.includes(x?.op)) throw new ReportBuilderError(422, `filters[${i}]: op is one of ${OPS.join(', ')}.`);
    const op = x.op as Filter['op'];
    if (['contains'].includes(op) && fld.type !== 'text') throw new ReportBuilderError(422, `filters[${i}]: contains is for text.`);
    if (op === 'last_days' && !['date', 'datetime'].includes(fld.type)) throw new ReportBuilderError(422, `filters[${i}]: last_days is for a date.`);
    if (['is_true', 'is_false'].includes(op) && fld.type !== 'bool') throw new ReportBuilderError(422, `filters[${i}]: ${op} is for a yes/no field.`);
    if (!['empty', 'not_empty', 'is_true', 'is_false'].includes(op) && (x.value === undefined || x.value === null || x.value === '')) throw new ReportBuilderError(422, `filters[${i}]: a value is needed.`);
    if (op === 'between' && (x.value2 === undefined || x.value2 === '')) throw new ReportBuilderError(422, `filters[${i}]: between needs value and value2.`);
    if (op === 'in' && (!Array.isArray(x.value) || !x.value.length || x.value.length > 100)) throw new ReportBuilderError(422, `filters[${i}]: in takes a list of 1 to 100 values.`);
    return { field: fld.key, op, value: x.value, value2: x.value2 };
  });
  const width = groupBy.length + columns.length;
  const sort = s.sort && Number.isInteger(s.sort.index) && s.sort.index >= 0 && s.sort.index < width ? { index: s.sort.index, dir: s.sort.dir === 'asc' ? 'asc' as const : 'desc' as const } : null;
  const limit = Math.min(MAX_ROWS, Math.max(1, Number(s.limit) || 1000));
  const chart = s.chart && ['bar', 'line'].includes(s.chart.type) && Number.isInteger(s.chart.x) && Number.isInteger(s.chart.y) && s.chart.x < width && s.chart.y < width
    ? { type: s.chart.type, x: s.chart.x, y: s.chart.y } : null;
  return { dataset: d, spec: { columns, filters, groupBy, sort, limit, chart } };
}

const CAST: Record<FieldType, string> = { text: 'text', number: 'numeric', money: 'numeric', date: 'date', datetime: 'timestamptz', bool: 'boolean' };

/** The SQL and its parameters for a validated spec (exported for the tests: it never contains a user's text). */
export function compile(d: Dataset, spec: Spec, orgId: string): { sql: string; params: unknown[]; headers: Array<{ label: string; type: FieldType }> } {
  const params: unknown[] = [orgId];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  let tzP: string | null = null;
  const tz = () => (tzP ??= p(zone()));
  const expr = (c: Column) => {
    const x = fieldOf(d, c.field);
    let e = x.sql;
    if (c.bucket) e = `date_trunc('${c.bucket}', (${e}) AT TIME ZONE ${tz()})::date`;
    if (!c.agg) return e;
    return c.agg === 'count_distinct' ? `count(DISTINCT ${e})` : c.agg === 'count' ? `count(${e})` : `${c.agg}(${e})`;
  };
  const where = [`${d.org} = $1`];
  if (EXTRA_WHERE[d.key]) where.push(EXTRA_WHERE[d.key]!);
  for (const fl of spec.filters) {
    const x = fieldOf(d, fl.field), c = CAST[x.type], e = `(${x.sql})`;
    switch (fl.op) {
      case 'eq': where.push(`${e} = ${p(String(fl.value))}::${c}`); break;
      case 'ne': where.push(`${e} IS DISTINCT FROM ${p(String(fl.value))}::${c}`); break;
      case 'gt': where.push(`${e} > ${p(String(fl.value))}::${c}`); break;
      case 'gte': where.push(`${e} >= ${p(String(fl.value))}::${c}`); break;
      case 'lt': where.push(`${e} < ${p(String(fl.value))}::${c}`); break;
      case 'lte': where.push(`${e} <= ${p(String(fl.value))}::${c}`); break;
      case 'between': where.push(`${e} BETWEEN ${p(String(fl.value))}::${c} AND ${p(String(fl.value2))}::${c}`); break;
      case 'contains': where.push(`${e} ILIKE ${p(`%${String(fl.value).replace(/[\\%_]/g, (m) => `\\${m}`)}%`)}`); break;
      case 'in': where.push(`${e} = ANY(${p((fl.value as unknown[]).map(String))}::${c}[])`); break;
      case 'last_days': where.push(`${e} >= now() - make_interval(days => ${p(Math.min(3660, Math.max(1, Math.floor(Number(fl.value)) || 1)))})`); break;
      case 'empty': where.push(`${e} IS NULL`); break;
      case 'not_empty': where.push(`${e} IS NOT NULL`); break;
      case 'is_true': where.push(`${e} IS TRUE`); break;
      case 'is_false': where.push(`${e} IS NOT TRUE`); break;
    }
  }
  const all = [...spec.groupBy, ...spec.columns];
  const select = all.map((c, i) => `${expr(c)} AS c${i}`).join(', ');
  const group = spec.groupBy.length ? ` GROUP BY ${spec.groupBy.map((_, i) => i + 1).join(', ')}` : '';
  const order = spec.sort ? ` ORDER BY ${spec.sort.index + 1} ${spec.sort.dir.toUpperCase()} NULLS LAST` : spec.groupBy.length ? ` ORDER BY ${spec.groupBy.map((_, i) => i + 1).join(', ')}` : '';
  const sql = `SELECT ${select} FROM ${d.from} WHERE ${where.join(' AND ')}${group}${order} LIMIT ${p(spec.limit + 1)}`;
  const headers = all.map((c) => {
    const x = fieldOf(d, c.field);
    const label = c.agg ? `${c.agg === 'count_distinct' ? 'distinct' : c.agg} of ${x.label}` : c.bucket ? `${x.label} (${c.bucket})` : x.label;
    const type: FieldType = c.agg === 'count' || c.agg === 'count_distinct' ? 'number' : c.bucket ? 'date' : x.type;
    return { label, type };
  });
  return { sql, params, headers };
}

const cell = (v: unknown, t: FieldType) => {
  if (v == null) return null;
  if (t === 'number' || t === 'money') return Math.round(Number(v) * 100) / 100;
  if (t === 'date') return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  if (t === 'datetime') return new Date(v as string).toISOString();
  if (t === 'bool') return v === true ? 'yes' : 'no';
  return String(v);
};

/** Run a spec: its rows (at most limit) and whether more were cut off. */
export async function run(orgId: string, datasetKey: unknown, rawSpec: unknown, can: (perm: string) => boolean) {
  const { dataset, spec } = validate(datasetKey, rawSpec);
  if (!can(dataset.permission)) throw new ReportBuilderError(403, `${dataset.label} needs ${dataset.permission}.`);
  const { sql, params, headers } = compile(dataset, spec, orgId);
  const t0 = Date.now();
  let raw: any[];
  try { raw = await outsideRequestScope(() => many<any>(sql, params)); }
  catch (e) {
    // A value that does not cast (a date filter given "abc") is the user's to fix, not a server error.
    if (/invalid input syntax|out of range|date\/time field/i.test((e as Error).message)) throw new ReportBuilderError(422, 'A filter value does not fit its field (a number, a date YYYY-MM-DD, yes/no).');
    throw e;
  }
  const truncated = raw.length > spec.limit;
  const rows = raw.slice(0, spec.limit).map((r) => headers.map((h, i) => cell(r[`c${i}`], h.type)));
  return { dataset: { key: dataset.key, label: dataset.label }, spec, headers, rows, truncated, ms: Date.now() - t0 };
}

export function catalogue(can: (perm: string) => boolean) {
  return {
    datasets: DATASETS.filter((d) => can(d.permission)).map((d) => ({ key: d.key, label: d.label, description: d.description, permission: d.permission, fields: d.fields.map((x) => ({ key: x.key, label: x.label, type: x.type })) })),
    aggregations: AGGS, operators: OPS, buckets: BUCKETS, maxRows: MAX_ROWS,
  };
}

// ------------------------------------------------------------------ saved reports

const viewOf = (r: any) => ({
  id: String(r.id), name: r.name, dataset: r.dataset, spec: r.spec, frequency: r.frequency ?? null, weekday: r.weekday ?? null, recipients: r.recipients ?? [],
  lastPeriod: r.last_period ?? null, lastSentAt: r.last_sent_at ? new Date(r.last_sent_at).toISOString() : null, updatedAt: new Date(r.updated_at).toISOString(),
});

export async function list(orgId: string, can: (perm: string) => boolean) {
  const rows = await outsideRequestScope(() => many<any>(`SELECT * FROM report_definition WHERE org_id = $1 AND archived_at IS NULL ORDER BY lower(name), id`, [orgId]));
  const ok = new Set(DATASETS.filter((d) => can(d.permission)).map((d) => d.key));
  return { reports: rows.filter((r) => ok.has(r.dataset)).map(viewOf) };
}

async function rowOf(orgId: string, id: string) {
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM report_definition WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [Number(id) || 0, orgId]));
  if (!r) throw new ReportBuilderError(404, 'No such report.');
  return r;
}

export async function get(orgId: string, id: string, can: (perm: string) => boolean) {
  const r = await rowOf(orgId, id);
  if (!can(datasetOf(r.dataset).permission)) throw new ReportBuilderError(404, 'No such report.');
  return viewOf(r);
}

export async function save(orgId: string, id: string | null, b: Record<string, unknown>, userId: string | null, can: (perm: string) => boolean) {
  const cur = id ? await rowOf(orgId, id) : null;
  if (cur && b.archive === true) {
    if (!can(datasetOf(cur.dataset).permission)) throw new ReportBuilderError(404, 'No such report.');
    await outsideRequestScope(() => query(`UPDATE report_definition SET archived_at = now(), updated_at = now() WHERE id = $1`, [cur.id]));
    return { id: String(cur.id), archived: true };
  }
  const name = String(b.name ?? cur?.name ?? '').trim().slice(0, 120);
  if (name.length < 2) throw new ReportBuilderError(422, 'name is 2 to 120 characters.');
  const { dataset, spec } = validate(b.dataset ?? cur?.dataset, b.spec ?? cur?.spec);
  if (!can(dataset.permission)) throw new ReportBuilderError(403, `${dataset.label} needs ${dataset.permission}.`);
  const frequency = b.frequency === undefined ? cur?.frequency ?? null : b.frequency === null || b.frequency === '' ? null : String(b.frequency);
  if (frequency && !['daily', 'weekly', 'monthly'].includes(frequency)) throw new ReportBuilderError(422, 'frequency is daily, weekly or monthly (or none).');
  const weekday = frequency === 'weekly' ? Number(b.weekday ?? cur?.weekday ?? 1) : null;
  if (weekday !== null && !(Number.isInteger(weekday) && weekday >= 1 && weekday <= 7)) throw new ReportBuilderError(422, 'weekday is 1 (Monday) to 7.');
  const rawR = b.recipients ?? cur?.recipients ?? [];
  const recipients = [...new Set((Array.isArray(rawR) ? rawR : String(rawR).split(/[,;\s]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  if (frequency && (!recipients.length || recipients.length > 10)) throw new ReportBuilderError(422, 'A schedule needs 1 to 10 recipients.');
  const bad = recipients.find((x) => !EMAIL_RE.test(x));
  if (bad) throw new ReportBuilderError(422, `Not an e-mail address: ${bad.slice(0, 80)}`);
  const vals = [orgId, name, dataset.key, JSON.stringify(spec), frequency, weekday, recipients];
  const r = cur
    ? await outsideRequestScope(() => one<any>(`UPDATE report_definition SET name = $2, dataset = $3, spec = $4, frequency = $5, weekday = $6, recipients = $7, updated_at = now() WHERE id = $8 AND org_id = $1 RETURNING *`, [...vals, cur.id]))
    : await outsideRequestScope(() => one<any>(`INSERT INTO report_definition (org_id, name, dataset, spec, frequency, weekday, recipients, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [...vals, userId]));
  return viewOf(r);
}

export async function workbook(orgId: string, id: string, can: (perm: string) => boolean): Promise<{ file: Buffer; name: string }> {
  const r = await rowOf(orgId, id);
  const res = await run(orgId, r.dataset, r.spec, can);
  return { file: xlsxOf(r.name, res), name: r.name };
}

export function xlsxOf(name: string, res: { headers: Array<{ label: string; type: FieldType }>; rows: unknown[][]; truncated: boolean }): Buffer {
  const rows: Array<Array<string | number | null>> = [res.headers.map((h) => h.label), ...(res.rows as Array<Array<string | number | null>>)];
  if (res.truncated) rows.push([`Cut at ${res.rows.length} rows.`]);
  return xlsx([{ name: name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report', rows, widths: res.headers.map((h) => Math.min(40, Math.max(10, h.label.length + 2))),
    formats: res.headers.map((h) => (h.type === 'money' ? 'money' : h.type === 'number' ? 'money' : null)) }]);
}

/** A daily schedule is due once a day from 07:00; weekly and monthly as the finance report schedules. */
export function duePeriodOf(s: { frequency: string; weekday: number | null; last_period: string | null }, now = new Date()): string | null {
  if (s.frequency !== 'daily') return duePeriod(s, now);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]));
  if (Number(p.hour) < 7) return null;
  const period = `${p.year}-${p.month}-${p.day}`;
  return s.last_period === period ? null : period;
}

/** E-mail a saved report now (Excel attached), through the organisation's e-mail channel. */
export async function send(orgId: string, id: string, can: (perm: string) => boolean, period?: string) {
  const r = await rowOf(orgId, id);
  if (!r.recipients?.length) throw new ReportBuilderError(422, 'The report has no recipients.');
  const ch = await outsideRequestScope(() => one<{ enabled: boolean; config: any; secret: string | null }>(`SELECT enabled, config, secret FROM notification_channel WHERE org_id = $1 AND kind = 'email' ORDER BY created_at LIMIT 1`, [orgId]));
  if (!ch?.enabled || !ch.config?.host) throw new ReportBuilderError(409, 'Set up the e-mail channel first (Governance → Alert routing → Channels).');
  let secret: string | null = null;
  try { secret = ch.secret ? unseal(ch.secret) : null; } catch { secret = null; }
  const res = await run(orgId, r.dataset, r.spec, can);
  const label = period ?? new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(new Date());
  const text = `${r.name} (${label}): ${res.rows.length} row${res.rows.length === 1 ? '' : 's'}${res.truncated ? ' (cut off)' : ''}. The report is attached in Excel.\n\nSent by PlugSure; change it in Operate → Report builder.`;
  const out = await sendEmail(ch.config, secret, r.recipients.join(', '), {
    subject: `${r.name} — ${label}`, text, html: `<p>${text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)).replace(/\n\n/g, '</p><p>')}</p>`, kind: 'custom-report',
    attachments: [{ filename: `${r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report'}-${label}.xlsx`, content: xlsxOf(r.name, res), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
  });
  if (!out.ok) throw new ReportBuilderError(502, `The e-mail was not sent: ${out.error ?? 'failed'}`);
  await outsideRequestScope(() => query(`UPDATE report_definition SET last_sent_at = now(), last_period = COALESCE($2, last_period) WHERE id = $1`, [r.id, period ?? null]));
  return { ok: true, to: r.recipients as string[], rows: res.rows.length };
}

/**
 * The worker (hourly): each scheduled report that is due. It runs with the permissions of the person who saved it
 * (their current organisation-wide grants: a site-limited role sees only its sites, and a report covers the whole
 * organisation): a report on a dataset they can no longer read is not sent.
 */
export async function sendDue(now = new Date()): Promise<number> {
  const rows = await outsideRequestScope(() => many<any>(`SELECT * FROM report_definition WHERE frequency IS NOT NULL AND archived_at IS NULL`));
  let sent = 0;
  for (const r of rows) {
    const period = duePeriodOf(r, now);
    if (!period) continue;
    try {
      const perms = await outsideRequestScope(() => many<{ p: string }>(
        `SELECT DISTINCT unnest(ro.permissions) AS p FROM user_role ur JOIN role ro ON ro.id = ur.role_id JOIN app_user u ON u.id = ur.user_id
          WHERE ur.user_id = $1 AND u.org_id = $2 AND u.status = 'active' AND ur.scope_type = 'org'`, [r.created_by, r.org_id]));
      const held = new Set(perms.map((x) => x.p));
      const can = (p: string) => held.has(p) || held.has('platform:admin');
      await send(r.org_id, String(r.id), can, period);
      sent++;
    } catch (e) {
      logger.warn({ report: r.id, err: (e as Error).message }, 'scheduled report failed');
      // Mark the period so a failing report is tried again tomorrow, not every hour.
      await outsideRequestScope(() => query(`UPDATE report_definition SET last_period = $2 WHERE id = $1`, [r.id, period])).catch(() => {});
    }
  }
  return sent;
}
