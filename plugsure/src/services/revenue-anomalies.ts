import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { moneyText, currencyOr } from '../domain/money.js';

/**
 * Revenue drop alerts (v1.22.0). With them on (Finance → Settings → Revenue alerts), each morning the worker compares
 * every site's revenue yesterday with its baseline — the average of the same weekday in the 4 weeks before — and,
 * when it fell by the threshold (default 50%) or more, records the day and raises a warning alert
 * (finance.revenue_drop, on the site): a charger down, a payment method failing, a tariff typed wrong. The alert
 * clears on the first day the site is back above the threshold.
 *
 * A site is only compared when at least 3 of the 4 weeks had revenue that weekday and the baseline is at least the
 * minimum set (in the currency's minor unit), so a new or quiet site does not raise alerts.
 */

export class AnomalyError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const KIND = 'finance.revenue_drop';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const zone = () => config.billing.timeZone;
const localDay = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const r1 = (n: number) => Math.round(n * 10) / 10;

export interface AlertSettings { enabled: boolean; dropPct: number; minBaseline: number }

export async function settings(orgId: string): Promise<AlertSettings> {
  const r = await outsideRequestScope(() => one<{ revenue_alerts: any }>(`SELECT revenue_alerts FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const v = r?.revenue_alerts ?? {};
  return { enabled: v.enabled === true, dropPct: Number(v.dropPct ?? 50), minBaseline: Number(v.minBaseline ?? 0) };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null): Promise<AlertSettings> {
  const enabled = b.enabled === true;
  const dropPct = b.dropPct == null || b.dropPct === '' ? 50 : Number(b.dropPct);
  if (!Number.isInteger(dropPct) || dropPct < 10 || dropPct > 100) throw new AnomalyError(422, 'The drop threshold is 10 to 100 (%).');
  const minBaseline = b.minBaseline == null || b.minBaseline === '' ? 0 : Number(b.minBaseline);
  if (!Number.isInteger(minBaseline) || minBaseline < 0) throw new AnomalyError(422, 'The minimum baseline is a whole number of the currency\'s minor unit, 0 or more.');
  const v = { enabled, dropPct, minBaseline };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, revenue_alerts, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET revenue_alerts = EXCLUDED.revenue_alerts, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

/** Revenue per site, currency and day for a set of days. */
async function dayRevenue(orgId: string, days: string[]) {
  return outsideRequestScope(() => many<{ site_id: string; currency: string; day: string; revenue: string; sessions: number }>(
    `SELECT cs.site_id, d.currency, to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day, COALESCE(sum(d.subtotal_minor), 0)::bigint AS revenue, count(*)::int AS sessions
       FROM cdr d JOIN charging_session cs ON cs.id = d.session_id
      WHERE d.org_id = $1 AND NOT COALESCE(d.test_mode, false) AND cs.site_id IS NOT NULL
        AND to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM-DD') = ANY($2::text[])
      GROUP BY 1, 2, 3`, [orgId, days, zone()]));
}

/** Compare every site's revenue on a day with its baseline; record and alert the drops, clear the recovered. */
export async function detect(orgId: string, dayRaw: unknown, s?: AlertSettings) {
  const day = String(dayRaw ?? '');
  if (!DATE_RE.test(day)) throw new AnomalyError(422, 'day is YYYY-MM-DD.');
  const st = s ?? await settings(orgId);
  const weeks = [7, 14, 21, 28].map((n) => addDays(day, -n));
  const [rows, sites] = await Promise.all([
    dayRevenue(orgId, [day, ...weeks]),
    outsideRequestScope(() => many<{ id: string; name: string; currency: string }>(
      `SELECT s.id, s.name, co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.org_id = $1 AND s.archived_at IS NULL`, [orgId])),
  ]);
  const found: Array<{ siteId: string; site: string; currency: string; revenue: number; baseline: number; dropPct: number }> = [];
  for (const site of sites) {
    const mine = rows.filter((r) => r.site_id === site.id && r.currency === site.currency);
    const past = weeks.map((w) => Number(mine.find((r) => r.day === w)?.revenue ?? 0));
    if (past.filter((x) => x > 0).length < 3) continue;
    const baseline = Math.round(past.reduce((a, x) => a + x, 0) / past.length);
    if (baseline <= 0 || baseline < st.minBaseline) continue;
    const today = mine.find((r) => r.day === day);
    const revenue = Number(today?.revenue ?? 0);
    const drop = r1(((baseline - revenue) / baseline) * 100);
    if (drop >= st.dropPct) {
      found.push({ siteId: site.id, site: site.name, currency: site.currency, revenue, baseline, dropPct: drop });
      const ins = await outsideRequestScope(() => one(
        `INSERT INTO revenue_anomaly (org_id, site_id, day, currency, revenue_minor, baseline_minor, drop_pct, sessions) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (org_id, site_id, day, currency) DO NOTHING RETURNING id`, [orgId, site.id, day, site.currency, revenue, baseline, drop, today?.sessions ?? 0]));
      if (ins) {
        await outsideRequestScope(() => persistAlert({ orgId, kind: KIND, severity: 'warning', targetType: 'site', targetId: site.id,
          message: `${site.name}: revenue on ${day} was ${drop}% below the usual for that weekday (${moneyText(revenue, currencyOr(site.currency))} against ${moneyText(baseline, currencyOr(site.currency))}). Check the chargers and payments. Finance → Margin.` })).catch((e) => logger.warn({ err: (e as Error).message }, 'revenue drop alert failed'));
      }
    } else {
      await outsideRequestScope(() => resolveAlertsFor(orgId, KIND, 'site', site.id)).catch(() => 0);
    }
  }
  return { day, found };
}

/** The worker: yesterday, for every organisation with the alerts on. */
export async function sweep(now = new Date()): Promise<number> {
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(`SELECT org_id FROM finance_org_settings WHERE (revenue_alerts->>'enabled')::boolean IS TRUE`));
  const yesterday = addDays(localDay(now), -1);
  let n = 0;
  for (const o of orgs) {
    try { n += (await detect(o.org_id, yesterday)).found.length; } catch (e) { logger.warn({ org: o.org_id, err: (e as Error).message }, 'revenue anomaly sweep failed'); }
  }
  return n;
}

/** The settings and the drops found in the last 90 days. */
export async function list(orgId: string, now = new Date()) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT a.*, to_char(a.day, 'YYYY-MM-DD') AS d, s.name AS site_name FROM revenue_anomaly a JOIN site s ON s.id = a.site_id
      WHERE a.org_id = $1 AND a.day >= $2::date ORDER BY a.day DESC, s.name LIMIT 500`, [orgId, addDays(localDay(now), -90)]));
  return {
    settings: await settings(orgId),
    anomalies: rows.map((r) => ({ day: r.d, siteId: r.site_id, site: r.site_name, currency: r.currency, revenue: Number(r.revenue_minor), baseline: Number(r.baseline_minor), dropPct: Number(r.drop_pct), sessions: Number(r.sessions) })),
  };
}
