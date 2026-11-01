import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert } from './alerts.js';
import { xlsx } from './xlsx.js';

/**
 * Revenue assurance (v1.34.0): every session of a month checked against what was billed.
 *
 *   unbilled          ended (more than two hours ago) with energy and no charge record
 *   roaming_no_cdr    the same, for a partner's driver (roaming): no charge record to settle with the partner
 *   zero_amount       billed at zero for 0.1 kWh or more, with no discount line explaining it
 *   energy_mismatch   the energy billed differs from the session's by more than 2% (and 0.1 kWh)
 *   meter_mismatch    the session's energy differs from its meter values (the register's last minus first) by more
 *                     than 2% (and 0.1 kWh)
 *   signed_invalid    the charger's signed meter values did not verify
 *   price_outlier     billed per kWh at less than half the site's median for the month (10 or more sessions)
 *
 * The amount expected is the energy at the site's median price per kWh (the month's billed sessions), or the billed
 * amount scaled by the energy, as the check allows. A finding is reviewed: recovered (with the amount), written off, or
 * dismissed with a note; a finding found again keeps its review. Checked daily for this month and the last; a summary
 * of the leakage (expected less billed, open), what was recovered and written off.
 */

export class AssuranceError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const KINDS = ['unbilled', 'roaming_no_cdr', 'zero_amount', 'energy_mismatch', 'meter_mismatch', 'signed_invalid', 'price_outlier'] as const;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const zone = () => config.billing.timeZone;
const thisMonth = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now).slice(0, 7);
const prevMonth = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };

export function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const off = (a: number, b: number, pct = 2, abs = 100) => Math.abs(a - b) > abs && Math.abs(a - b) > (Math.max(Math.abs(a), Math.abs(b)) * pct) / 100;

interface Found { kind: typeof KINDS[number]; sessionId: string; siteId: string | null; currency: string; energyWh: number; billed: number; expected: number; detail: Record<string, unknown> }

/** Run the checks for a month; store new findings (a finding found again keeps its review). */
export async function run(orgId: string, monthRaw: unknown, now = new Date()) {
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month)) throw new AssuranceError(422, 'month is YYYY-MM.');
  const sessions = await outsideRequestScope(() => many<any>(
    `SELECT cs.id, cs.site_id, cs.state, cs.energy_wh, cs.ended_at, cs.ocpi_partner_id, cs.signed_status, cs.currency AS s_currency, co.currency AS site_currency,
            d.id AS cdr_id, d.total_minor, d.currency AS cdr_currency, d.lines, COALESCE(d.test_mode, false) AS test_mode
       FROM charging_session cs JOIN site s ON s.id = cs.site_id JOIN country co ON co.code = s.country_code LEFT JOIN cdr d ON d.session_id = cs.id
      WHERE s.org_id = $1 AND to_char(cs.started_at AT TIME ZONE $3, 'YYYY-MM') = $2 AND cs.state IN ('ended', 'rated')`, [orgId, month, zone()]));
  const live = sessions.filter((s) => !s.test_mode);
  // The site's median price per kWh this month, from billed sessions with energy.
  const perSite = new Map<string, number[]>();
  for (const s of live) if (s.cdr_id && Number(s.energy_wh) >= 100 && Number(s.total_minor) > 0) (perSite.get(s.site_id) ?? perSite.set(s.site_id, []).get(s.site_id)!).push(Number(s.total_minor) / (Number(s.energy_wh) / 1000));
  const med = new Map([...perSite].map(([k, v]) => [k, { median: median(v)!, n: v.length }]));
  const expectedAt = (siteId: string, wh: number) => { const m = med.get(siteId); return m ? Math.round((m.median * wh) / 1000) : 0; };
  // Meter registers per session (Wh).
  const ids = live.map((s) => s.id);
  const meters = ids.length ? await outsideRequestScope(() => many<{ session_id: string; lo: number; hi: number; unit: string | null; n: number }>(
    `SELECT session_id, min(value) AS lo, max(value) AS hi, max(unit) AS unit, count(*)::int AS n FROM meter_value
      WHERE session_id = ANY($1::uuid[]) AND measurand = 'Energy.Active.Import.Register' AND (phase IS NULL OR phase = '') GROUP BY 1`, [ids])) : [];
  const meterWh = new Map(meters.filter((m) => m.n >= 2).map((m) => [m.session_id, (Number(m.hi) - Number(m.lo)) * (String(m.unit ?? 'Wh').toLowerCase() === 'kwh' ? 1000 : 1)]));
  const found: Found[] = [];
  const cutoff = now.getTime() - 2 * 3600_000;
  for (const s of live) {
    const wh = Number(s.energy_wh ?? 0);
    const cur = s.cdr_currency ?? s.s_currency ?? s.site_currency;
    const base = { sessionId: s.id, siteId: s.site_id, currency: cur, energyWh: wh };
    if (!s.cdr_id) {
      if (wh > 0 && s.ended_at && new Date(s.ended_at).getTime() < cutoff) found.push({ ...base, kind: s.ocpi_partner_id ? 'roaming_no_cdr' : 'unbilled', billed: 0, expected: expectedAt(s.site_id, wh), detail: { state: s.state } });
    } else {
      const billed = Number(s.total_minor);
      const lines = Array.isArray(s.lines) ? s.lines : [];
      const discounted = lines.some((l: any) => l?.adjustment);
      if (billed === 0 && wh >= 100 && !discounted) found.push({ ...base, kind: 'zero_amount', billed, expected: expectedAt(s.site_id, wh), detail: {} });
      const billedKwh = lines.filter((l: any) => l?.kind === 'energy' && String(l?.unit ?? '').toLowerCase() === 'kwh').reduce((a: number, l: any) => a + Number(l.quantity ?? 0), 0);
      if (billedKwh > 0 && off(billedKwh * 1000, wh)) found.push({ ...base, kind: 'energy_mismatch', billed, expected: Math.round((billed * wh) / (billedKwh * 1000)), detail: { billedWh: Math.round(billedKwh * 1000) } });
      const m = med.get(s.site_id);
      if (m && m.n >= 10 && billed > 0 && wh >= 1000 && billed / (wh / 1000) < m.median / 2 && !discounted) found.push({ ...base, kind: 'price_outlier', billed, expected: expectedAt(s.site_id, wh), detail: { perKwh: Math.round(billed / (wh / 1000)), siteMedian: Math.round(m.median) } });
    }
    const mw = meterWh.get(s.id);
    if (mw != null && off(mw, wh)) found.push({ ...base, kind: 'meter_mismatch', billed: Number(s.total_minor ?? 0), expected: s.cdr_id && wh > 0 ? Math.round((Number(s.total_minor) * mw) / wh) : expectedAt(s.site_id, mw), detail: { meterWh: Math.round(mw) } });
    if (['invalid', 'failed'].includes(String(s.signed_status ?? ''))) found.push({ ...base, kind: 'signed_invalid', billed: Number(s.total_minor ?? 0), expected: Number(s.total_minor ?? 0), detail: { signedStatus: s.signed_status } });
  }
  let added = 0;
  for (const f of found) {
    const r = await outsideRequestScope(() => one<{ inserted: boolean }>(
      `INSERT INTO revenue_finding (org_id, month, kind, session_id, site_id, currency, energy_wh, billed_minor, expected_minor, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (org_id, kind, session_id) DO UPDATE SET billed_minor = EXCLUDED.billed_minor, expected_minor = EXCLUDED.expected_minor, detail = EXCLUDED.detail, energy_wh = EXCLUDED.energy_wh
       RETURNING (xmax = 0) AS inserted`, [orgId, month, f.kind, f.sessionId, f.siteId, f.currency, f.energyWh, f.billed, f.expected, JSON.stringify(f.detail)]));
    if (r?.inserted) added++;
  }
  // A finding no longer found (billed since, corrected) and still open is dismissed as resolved.
  const keys = new Set(found.map((f) => `${f.kind}|${f.sessionId}`));
  let cleared = 0;
  for (const o of await outsideRequestScope(() => many<any>(`SELECT id, kind, session_id FROM revenue_finding WHERE org_id = $1 AND month = $2 AND status = 'open'`, [orgId, month]))) {
    if (!keys.has(`${o.kind}|${o.session_id}`)) { await outsideRequestScope(() => query(`UPDATE revenue_finding SET status = 'dismissed', note = 'No longer found (corrected or billed since)', reviewed_at = now() WHERE id = $1`, [o.id])); cleared++; }
  }
  return { month, sessions: live.length, found: found.length, added, cleared };
}

const view = (r: any) => ({
  id: String(r.id), month: r.month, kind: r.kind, sessionId: r.session_id, siteId: r.site_id ?? null, site: r.site_name ?? null, currency: r.currency, energyWh: r.energy_wh == null ? null : Number(r.energy_wh),
  billed: Number(r.billed_minor), expected: Number(r.expected_minor), gap: Number(r.expected_minor) - Number(r.billed_minor), detail: r.detail, status: r.status,
  recovered: r.recovered_minor == null ? null : Number(r.recovered_minor), note: r.note ?? null, reviewedBy: r.reviewed_by_name ?? null, foundAt: new Date(r.found_at).toISOString(),
});

export async function list(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const month = q.month ? String(q.month) : prevMonth(thisMonth(now));
  if (!MONTH_RE.test(month)) throw new AssuranceError(422, 'month is YYYY-MM.');
  const status = q.status ? String(q.status) : null;
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT f.*, s.name AS site_name, u.name AS reviewed_by_name FROM revenue_finding f LEFT JOIN site s ON s.id = f.site_id LEFT JOIN app_user u ON u.id = f.reviewed_by
      WHERE f.org_id = $1 AND f.month = $2 AND ($3::text IS NULL OR f.status = $3) ORDER BY (f.status = 'open') DESC, (f.expected_minor - f.billed_minor) DESC, f.id LIMIT 1000`, [orgId, month, status]));
  const findings = rows.map(view);
  const summary: Record<string, { open: number; leakage: number; recovered: number; writtenOff: number }> = {};
  for (const f of findings) {
    const s = (summary[f.currency] ??= { open: 0, leakage: 0, recovered: 0, writtenOff: 0 });
    if (f.status === 'open') { s.open++; s.leakage += Math.max(0, f.gap); }
    if (f.status === 'recovered') s.recovered += f.recovered ?? 0;
    if (f.status === 'written_off') s.writtenOff += Math.max(0, f.gap);
  }
  const byKind = KINDS.map((k) => ({ kind: k, open: findings.filter((f) => f.kind === k && f.status === 'open').length, total: findings.filter((f) => f.kind === k).length }));
  return { month, findings, summary, byKind };
}

export async function review(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  if (!/^\d{1,18}$/.test(id)) throw new AssuranceError(404, 'No such finding.');
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM revenue_finding WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!r) throw new AssuranceError(404, 'No such finding.');
  const status = String(b.status ?? '');
  if (!['recovered', 'written_off', 'dismissed', 'open'].includes(status)) throw new AssuranceError(422, 'status is recovered, written_off, dismissed or open.');
  const note = b.note == null ? null : String(b.note).trim().slice(0, 500) || null;
  if ((status === 'written_off' || status === 'dismissed') && !note) throw new AssuranceError(422, 'Say why (the note).');
  let recovered: number | null = null;
  if (status === 'recovered') {
    recovered = b.recovered == null || b.recovered === '' ? Math.max(0, Number(r.expected_minor) - Number(r.billed_minor)) : Number(b.recovered);
    if (!Number.isInteger(recovered) || recovered < 0) throw new AssuranceError(422, 'recovered is a whole amount, 0 or more.');
  }
  await outsideRequestScope(() => query(`UPDATE revenue_finding SET status = $2, recovered_minor = $3, note = $4, reviewed_by = $5, reviewed_at = now() WHERE id = $1`, [r.id, status, recovered, note, userId]));
  const v = await outsideRequestScope(() => one<any>(`SELECT f.*, u.name AS reviewed_by_name FROM revenue_finding f LEFT JOIN app_user u ON u.id = f.reviewed_by WHERE f.id = $1`, [r.id]));
  return view(v);
}

export async function listXlsx(orgId: string, q: Record<string, unknown>): Promise<Buffer> {
  const l = await list(orgId, q);
  return xlsx([{ name: `Assurance ${l.month}`, rows: [['Kind', 'Session', 'Site', 'Currency', 'kWh', 'Billed', 'Expected', 'Gap', 'Status', 'Recovered', 'Note'],
    ...l.findings.map((f) => [f.kind, f.sessionId, f.site ?? '', f.currency, f.energyWh == null ? null : Math.round(f.energyWh / 10) / 100, f.billed, f.expected, f.gap, f.status, f.recovered, f.note ?? ''])],
    widths: [16, 38, 22, 8, 8, 14, 14, 14, 12, 14, 40], formats: [null, null, null, null, null, 'money', 'money', 'money', null, 'money', null] }]);
}

/** Daily: this month and the last, for every organisation with sessions; an alert when new findings appear. */
export async function sweep(now = new Date()): Promise<number> {
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(`SELECT DISTINCT s.org_id FROM site s WHERE EXISTS (SELECT 1 FROM charging_session cs WHERE cs.site_id = s.id AND cs.started_at > now() - interval '62 days')`));
  let n = 0;
  for (const { org_id } of orgs) {
    for (const m of [prevMonth(thisMonth(now)), thisMonth(now)]) {
      try {
        const r = await run(org_id, m, now);
        if (r.added) await outsideRequestScope(() => persistAlert({ orgId: org_id, kind: 'finance.revenue_findings', severity: 'warning', targetType: 'organisation', targetId: `${org_id}:${m}`,
          message: `Revenue assurance ${m}: ${r.added} new finding(s) (sessions not billed, billed at zero or out of line). Finance → Revenue assurance.` })).catch(() => null);
        n += r.added;
      } catch (e) { logger.warn({ org: org_id, err: (e as Error).message }, 'revenue assurance sweep failed'); }
    }
  }
  return n;
}
