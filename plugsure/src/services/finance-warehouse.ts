import { createHash, createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { seal, unseal } from './secrets.js';
import { guardedFetch } from './net-guard.js';
import { zip } from './xlsx.js';

/**
 * Finance data warehouse export (v1.24.0). Each night (and on demand), an organisation's finance data of the day
 * before is written as files for a BI tool or a warehouse to load (Finance → Settings → Data export):
 *
 *   by day      payments (the gateway ledger), charges (charge records with site and kWh), refunds,
 *               statement_payments, fleet_invoices, fleet_credit_notes        — the rows of that day (date=YYYY-MM-DD)
 *   snapshots   statements, shared_costs, site_investments, tax_withholdings, sites — all rows (snapshot_date=…)
 *
 * as gzipped CSV (header row, RFC 4180) or gzipped JSON Lines, to:
 *
 *   s3      any S3-compatible store (AWS S3, Cloudflare R2, MinIO, Wasabi, Google Cloud Storage's XML API), path-style
 *           PUT signed with AWS Signature V4; the secret key is kept sealed
 *   local   STORAGE_DIR/warehouse/<organisation> on the server (for a sync job, or tests)
 *
 * Keys: <prefix>/<dataset>/date=<day>/part-0.csv.gz. Each run is logged with every file's size and SHA-256. A day
 * can also be downloaded as one ZIP from the console, whatever the target.
 */

export class WarehouseError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const zone = () => config.billing.timeZone;
const localDay = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface WarehouseSettings {
  enabled: boolean; target: 'local' | 's3'; format: 'csv' | 'ndjson';
  endpoint: string | null; region: string; bucket: string | null; prefix: string; accessKeyId: string | null; secretSet: boolean;
}

async function raw(orgId: string) {
  const r = await outsideRequestScope(() => one<{ warehouse: any }>(`SELECT warehouse FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  return r?.warehouse ?? {};
}

export async function settings(orgId: string): Promise<WarehouseSettings> {
  const v = await raw(orgId);
  return {
    enabled: v.enabled === true, target: v.target === 's3' ? 's3' : 'local', format: v.format === 'ndjson' ? 'ndjson' : 'csv',
    endpoint: v.endpoint ?? null, region: v.region ?? 'us-east-1', bucket: v.bucket ?? null, prefix: v.prefix ?? 'plugsure', accessKeyId: v.accessKeyId ?? null, secretSet: !!v.secret,
  };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null): Promise<WarehouseSettings> {
  const cur = await raw(orgId);
  const target = b.target === 's3' ? 's3' : 'local';
  const format = b.format === 'ndjson' ? 'ndjson' : 'csv';
  const prefix = String(b.prefix ?? cur.prefix ?? 'plugsure').replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9._\-/]{1,120}$/.test(prefix)) throw new WarehouseError(422, 'The prefix is letters, digits, . _ - and / (up to 120).');
  const v: Record<string, unknown> = { enabled: b.enabled === true, target, format, prefix };
  if (target === 's3') {
    const endpoint = String(b.endpoint ?? cur.endpoint ?? '').replace(/\/+$/, '');
    let u: URL;
    try { u = new URL(endpoint); } catch { throw new WarehouseError(422, 'The endpoint is a URL, e.g. https://s3.ap-southeast-3.amazonaws.com.'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new WarehouseError(422, 'The endpoint is an http(s) URL.');
    const bucket = String(b.bucket ?? cur.bucket ?? '');
    if (!/^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/.test(bucket)) throw new WarehouseError(422, 'The bucket name is 3 to 63 lowercase letters, digits, dots and dashes.');
    const region = String(b.region ?? cur.region ?? 'us-east-1');
    if (!/^[a-z0-9-]{2,40}$/.test(region)) throw new WarehouseError(422, 'The region is like ap-southeast-3 (auto for R2).');
    const accessKeyId = String(b.accessKeyId ?? cur.accessKeyId ?? '').trim();
    if (accessKeyId.length < 4 || accessKeyId.length > 128) throw new WarehouseError(422, 'Give the access key id.');
    const secret = b.secretAccessKey == null || b.secretAccessKey === '' ? cur.secret : seal(String(b.secretAccessKey));
    if (!secret) throw new WarehouseError(422, 'Give the secret access key.');
    Object.assign(v, { endpoint, bucket, region, accessKeyId, secret });
  }
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, warehouse, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET warehouse = EXCLUDED.warehouse, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return settings(orgId);
}

// ─────────────────────────────────────────── AWS Signature V4 (S3)

const sha256hex = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
/** RFC 3986 encoding of a path segment (S3 keeps '/'). */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The Authorization header for a request (headers must include host, x-amz-date and x-amz-content-sha256). */
export function sigV4(p: { method: string; path: string; query?: string; headers: Record<string, string>; payloadHash: string; region: string; accessKeyId: string; secret: string; service?: string }): string {
  const service = p.service ?? 's3';
  const amzDate = p.headers['x-amz-date']!;
  const day = amzDate.slice(0, 8);
  const names = Object.keys(p.headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const canonical = [p.method, p.path, p.query ?? '', names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), p.payloadHash].join('\n');
  const scope = `${day}/${p.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${p.secret}`, day), p.region), service), 'aws4_request');
  return `AWS4-HMAC-SHA256 Credential=${p.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${createHmac('sha256', key).update(toSign).digest('hex')}`;
}

async function putS3(s: { endpoint: string; region: string; bucket: string; accessKeyId: string; secret: string }, key: string, body: Buffer, contentType: string) {
  const u = new URL(s.endpoint);
  const basePath = u.pathname.replace(/\/+$/, '');
  const path = `${basePath}/${enc(s.bucket)}/${key.split('/').map(enc).join('/')}`;
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const payloadHash = sha256hex(body);
  const headers: Record<string, string> = { host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, 'content-type': contentType };
  headers.authorization = sigV4({ method: 'PUT', path, headers: { host: headers.host!, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, 'content-type': contentType }, payloadHash, region: s.region, accessKeyId: s.accessKeyId, secret: s.secret });
  const r = await guardedFetch(`${u.protocol}//${u.host}${path}`, { method: 'PUT', headers, body, timeoutMs: 60_000, maxBytes: 64 * 1024 });
  if (r.status < 200 || r.status >= 300) {
    const code = /<Code>([^<]+)<\/Code>/.exec(r.text)?.[1];
    throw new Error(`the store answered ${r.status}${code ? ` (${code})` : ''} for ${key}`);
  }
}

// ─────────────────────────────────────────── datasets

const csvCell = (v: unknown) => {
  if (v == null) return '';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const DAILY = ['payments', 'charges', 'refunds', 'statement_payments', 'fleet_invoices', 'fleet_credit_notes'] as const;
export const SNAPSHOTS = ['statements', 'shared_costs', 'site_investments', 'tax_withholdings', 'sites'] as const;

/** The rows of every dataset for an organisation and a day (local billing day). */
export async function datasets(orgId: string, day: string): Promise<Array<{ name: string; partition: string; rows: Record<string, unknown>[] }>> {
  const z = zone();
  const onDay = (col: string) => `(${col} AT TIME ZONE '${z.replace(/'/g, '')}')::date = $2::date`;
  const q = (sql: string, p: unknown[] = [orgId, day]) => outsideRequestScope(() => many<Record<string, unknown>>(sql, p));
  const [payments, charges, refunds, stp, finv, fcn, stmts, costs, invs, wht, sites] = await Promise.all([
    q(`SELECT g.id, g.integration_id, g.provider, g.external_id, g.kind, g.status, g.cashflow, g.channel_category, g.channel_code, g.reference_id, g.currency,
              g.amount, g.fee, g.vat, g.withholding_tax, g.net_amount, g.settlement_status, g.estimated_settlement_at, g.gateway_created_at, g.payment_intent_id
         FROM gateway_transaction g WHERE g.org_id = $1 AND ${onDay('g.gateway_created_at')} ORDER BY g.gateway_created_at, g.id`),
    q(`SELECT d.id AS cdr_id, d.session_id, d.issued_at, cs.site_id, s.name AS site, cs.charge_point_id, cs.energy_wh, cs.duration_s, cs.payment_mode, cs.fleet_account_id,
              d.currency, d.subtotal_minor, d.local_tax_minor, d.tax_base_minor, d.tax_minor, d.total_minor
         FROM cdr d JOIN charging_session cs ON cs.id = d.session_id LEFT JOIN site s ON s.id = cs.site_id
        WHERE d.org_id = $1 AND NOT COALESCE(d.test_mode, false) AND ${onDay('d.issued_at')} ORDER BY d.issued_at, d.id`),
    q(`SELECT id AS payment_id, method, channel, currency, amount_captured_minor, refund_state, refund_due_minor, refunded_minor, refund_method, refund_ref, refund_reason, refund_requested_at, refunded_at
         FROM payment_intent WHERE org_id = $1 AND refund_state IS NOT NULL AND (${onDay('refunded_at')} OR ${onDay('refund_requested_at')}) ORDER BY refund_requested_at`),
    q(`SELECT p.id, p.statement_id, s.number AS statement, p.kind, p.owner_id, p.amount_minor, p.currency, p.paid_on, p.reference, p.voided_at
         FROM statement_payment p JOIN commission_statement s ON s.id = p.statement_id WHERE p.org_id = $1 AND p.paid_on = $2::date ORDER BY p.id`),
    q(`SELECT i.id, i.number, i.fleet_account_id, a.name AS account, to_char(i.period, 'YYYY-MM') AS period, i.status, i.issued_at, i.due_date, i.currency,
              i.sessions, i.energy_wh, i.subtotal_minor, i.tax_base_minor, i.tax_minor, i.total_minor, i.credited_minor, i.prior_credit_minor, i.paid_at
         FROM fleet_invoice i JOIN fleet_account a ON a.id = i.fleet_account_id WHERE i.org_id = $1 AND ${onDay('i.issued_at')} ORDER BY i.issued_at`),
    q(`SELECT c.id, c.number, c.invoice_id, c.fleet_account_id, c.status, c.settlement, c.reason, c.currency, c.tax_base_minor, c.tax_minor, c.total_minor, c.issued_at, c.refunded_at
         FROM fleet_credit_note c WHERE c.org_id = $1 AND ${onDay('c.issued_at')} ORDER BY c.issued_at`),
    q(`SELECT id, number, to_char(period, 'YYYY-MM') AS period, owner_id, currency, gtv_minor, commission_minor, net_minor, tax_minor, total_minor, owner_share_minor, finalised_at
         FROM commission_statement WHERE org_id = $1 AND finalised_at IS NOT NULL ORDER BY period, number`, [orgId]),
    q(`SELECT id, category, description, amount_minor, currency, basis, site_ids, month_from, month_to, voided_at FROM finance_shared_cost WHERE org_id = $1 ORDER BY id`, [orgId]),
    q(`SELECT id, site_id, category, description, amount_minor, currency, invested_on, life_months, voided_at FROM site_investment WHERE org_id = $1 ORDER BY id`, [orgId]),
    q(`SELECT id, kind, period, counterparty, counterparty_npwp, base_minor, rate_bps, amount_minor, bukti_number, bukti_date, voided_at FROM tax_withholding WHERE org_id = $1 ORDER BY period, id`, [orgId]),
    q(`SELECT s.id, s.name, s.country_code, co.currency, s.owner_id, s.archived_at FROM site s JOIN country co ON co.code = s.country_code WHERE s.org_id = $1 ORDER BY s.name`, [orgId]),
  ]);
  const daily = { payments, charges, refunds, statement_payments: stp, fleet_invoices: finv, fleet_credit_notes: fcn };
  const snaps = { statements: stmts, shared_costs: costs, site_investments: invs, tax_withholdings: wht, sites };
  return [
    ...Object.entries(daily).map(([name, rows]) => ({ name, partition: `date=${day}`, rows })),
    ...Object.entries(snaps).map(([name, rows]) => ({ name, partition: `snapshot_date=${day}`, rows })),
  ];
}

/** One dataset as a gzipped file body. */
export function encode(rows: Record<string, unknown>[], format: 'csv' | 'ndjson'): Buffer {
  if (format === 'ndjson') return gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8'));
  const cols = rows.length ? Object.keys(rows[0]!) : [];
  const text = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
  return gzipSync(Buffer.from(text, 'utf8'));
}

const EXT = { csv: 'csv.gz', ndjson: 'jsonl.gz' };

/** Build the day's files (key, body, rows, sha256). */
export async function files(orgId: string, day: string, format: 'csv' | 'ndjson', prefix: string) {
  if (!DATE_RE.test(day)) throw new WarehouseError(422, 'day is YYYY-MM-DD.');
  const ds = await datasets(orgId, day);
  return ds.map((d) => {
    const body = encode(d.rows, format);
    return { key: `${prefix ? `${prefix}/` : ''}${d.name}/${d.partition}/part-0.${EXT[format]}`, dataset: d.name, rows: d.rows.length, body, bytes: body.length, sha256: sha256hex(body) };
  });
}

/** Export a day to the organisation's target; logged. */
export async function run(orgId: string, dayRaw: unknown, o: { automatic?: boolean; userId?: string | null } = {}) {
  const day = String(dayRaw ?? '');
  if (!DATE_RE.test(day)) throw new WarehouseError(422, 'day is YYYY-MM-DD.');
  if (day >= localDay()) throw new WarehouseError(422, 'Only a day that has ended can be exported.');
  const v = await raw(orgId);
  const st = await settings(orgId);
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO finance_export_run (org_id, day, target, automatic, started_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [orgId, day, st.target, o.automatic === true, o.userId ?? null]));
  const runId = String(r!.id);
  try {
    const fs = await files(orgId, day, st.format, st.prefix);
    for (const f of fs) {
      if (st.target === 's3') {
        let secret: string;
        try { secret = unseal(v.secret); } catch { throw new Error('the secret access key cannot be read: enter it again'); }
        await putS3({ endpoint: v.endpoint, region: v.region, bucket: v.bucket, accessKeyId: v.accessKeyId, secret }, f.key, f.body, st.format === 'csv' ? 'text/csv' : 'application/x-ndjson');
      } else {
        const path = join(config.storage.dir, 'warehouse', orgId, f.key);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, f.body);
      }
    }
    const listed = fs.map(({ body: _b, ...x }) => x);
    await outsideRequestScope(() => query(`UPDATE finance_export_run SET files = $2, bytes = $3, finished_at = now() WHERE id = $1`,
      [runId, JSON.stringify(listed), fs.reduce((a, f) => a + f.bytes, 0)]));
    return { id: runId, day, target: st.target, files: listed };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await outsideRequestScope(() => query(`UPDATE finance_export_run SET error = $2, finished_at = now() WHERE id = $1`, [runId, msg]));
    throw new WarehouseError(502, `The export failed: ${msg}`);
  }
}

/** The day's files as one ZIP (for a download), with a manifest of SHA-256s. */
export async function zipDay(orgId: string, dayRaw: unknown) {
  const day = String(dayRaw ?? '');
  const st = await settings(orgId);
  const fs = await files(orgId, day, st.format, '');
  const manifest = { organisation: orgId, day, format: st.format, files: fs.map((f) => ({ name: f.key, rows: f.rows, bytes: f.bytes, sha256: f.sha256 })) };
  return zip([...fs.map((f) => ({ name: f.key, data: f.body })), { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) }]);
}

export async function runs(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT r.*, to_char(r.day, 'YYYY-MM-DD') AS d, u.name AS by_name FROM finance_export_run r LEFT JOIN app_user u ON u.id = r.started_by WHERE r.org_id = $1 ORDER BY r.started_at DESC LIMIT 60`, [orgId]));
  return rows.map((r) => ({ id: String(r.id), day: r.d, target: r.target, automatic: r.automatic, files: (r.files as any[]).length, rows: (r.files as any[]).reduce((a, f) => a + Number(f.rows ?? 0), 0), bytes: Number(r.bytes), error: r.error ?? null, by: r.by_name ?? null, at: new Date(r.started_at).toISOString(), finished: !!r.finished_at }));
}

/** The worker: yesterday, once, for every organisation with the export on (up to 3 failed tries a day). */
export async function sweep(now = new Date()): Promise<number> {
  const day = addDays(localDay(now), -1);
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(
    `SELECT s.org_id FROM finance_org_settings s WHERE (s.warehouse->>'enabled')::boolean IS TRUE
        AND NOT EXISTS (SELECT 1 FROM finance_export_run r WHERE r.org_id = s.org_id AND r.day = $1::date AND r.error IS NULL AND r.finished_at IS NOT NULL)
        AND (SELECT count(*) FROM finance_export_run r WHERE r.org_id = s.org_id AND r.day = $1::date AND r.automatic) < 3`, [day]));
  let n = 0;
  for (const o of orgs) {
    try { await run(o.org_id, day, { automatic: true }); n++; } catch (e) { logger.warn({ org: o.org_id, err: (e as Error).message }, 'finance export failed'); }
  }
  return n;
}
