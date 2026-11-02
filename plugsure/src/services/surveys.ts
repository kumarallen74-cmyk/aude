import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';

/**
 * Driver surveys and NPS (v1.47.0), Operate → Surveys. After a charge the app asks one question, "How likely are you
 * to recommend …?" (0–10), with optional tags and a comment:
 *
 *   who is asked   app drivers on a receipt, when the operator has surveys on; a share of charges (sample_pct) and not
 *                  more often than every min_gap_days per driver; once per charge
 *   NPS            % promoters (9–10) − % detractors (0–6), overall, per site and per charger, by week
 *   low scores     a detractor's comment opens a support case (when the support desk is on and case_on_low is set),
 *                  linked to the session
 */

export class SurveyError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const S = <T>(fn: () => T) => outsideRequestScope(fn);
export const TAGS = ['speed', 'price', 'availability', 'payment', 'app', 'location', 'cleanliness', 'broken'] as const;
const DEFAULT_QUESTION = 'Seberapa besar kemungkinan Anda merekomendasikan kami kepada teman?';

const settingsOf = (r: any) => ({
  enabled: !!r?.enabled, question: r?.question ?? null, samplePct: r?.sample_pct ?? 100, minGapDays: r?.min_gap_days ?? 14, caseOnLow: r?.case_on_low ?? true,
});

export async function settings(orgId: string) {
  return settingsOf(await S(() => one<any>(`SELECT * FROM survey_settings WHERE org_id = $1`, [orgId])));
}

export async function saveSettings(orgId: string, b: Record<string, unknown>) {
  const cur = await settings(orgId);
  const pct = b.samplePct === undefined ? cur.samplePct : Number(b.samplePct);
  if (!(Number.isInteger(pct) && pct >= 1 && pct <= 100)) throw new SurveyError(422, 'samplePct is 1 to 100.');
  const gap = b.minGapDays === undefined ? cur.minGapDays : Number(b.minGapDays);
  if (!(Number.isInteger(gap) && gap >= 0 && gap <= 365)) throw new SurveyError(422, 'minGapDays is 0 to 365.');
  const q = b.question === undefined ? cur.question : (b.question ? String(b.question).trim().slice(0, 200) : null);
  await S(() => query(
    `INSERT INTO survey_settings (org_id, enabled, question, sample_pct, min_gap_days, case_on_low, updated_at) VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, question = EXCLUDED.question, sample_pct = EXCLUDED.sample_pct, min_gap_days = EXCLUDED.min_gap_days,
       case_on_low = EXCLUDED.case_on_low, updated_at = now()`,
    [orgId, b.enabled === undefined ? cur.enabled : b.enabled === true, q, pct, gap, b.caseOnLow === undefined ? cur.caseOnLow : b.caseOnLow === true]));
  return settings(orgId);
}

/** Whether a charge falls in the sample: a stable hash of its id, so asking twice gives the same answer. Pure. */
export function sampled(chargeId: string, pct: number): boolean {
  if (pct >= 100) return true;
  let h = 0;
  for (const ch of chargeId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 100 < pct;
}

/** NPS from scores: % promoters (9–10) − % detractors (0–6), rounded. Null without scores. Pure. */
export function nps(scores: number[]) {
  if (!scores.length) return { nps: null as number | null, responses: 0, promoters: 0, passives: 0, detractors: 0 };
  const p = scores.filter((s) => s >= 9).length, d = scores.filter((s) => s <= 6).length;
  return { nps: Math.round(((p - d) / scores.length) * 100), responses: scores.length, promoters: p, passives: scores.length - p - d, detractors: d };
}

// ------------------------------------------------------------------ the driver app

async function chargeFor(appDriverId: string, chargeId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(chargeId)) throw new SurveyError(404, 'Transaksi tidak ditemukan.');
  const dc = await S(() => one<any>(
    `SELECT dc.id, dc.org_id, dc.device_id, dc.session_id, cs.site_id, cs.charge_point_id, cs.state, o.name AS operator
       FROM driver_charge dc LEFT JOIN charging_session cs ON cs.id = dc.session_id JOIN organisation o ON o.id = dc.org_id
      WHERE dc.id = $1 AND dc.app_driver_id = $2`, [chargeId, appDriverId]));
  if (!dc) throw new SurveyError(404, 'Transaksi tidak ditemukan.');
  return dc;
}

/** Should the app ask about this charge? */
export async function pending(appDriverId: string, chargeId: string) {
  const dc = await chargeFor(appDriverId, chargeId);
  const s = await settings(dc.org_id);
  const no = { ask: false as const };
  if (!s.enabled || !dc.session_id || dc.state === 'active') return no;
  if (await S(() => one(`SELECT 1 FROM survey_response WHERE driver_charge_id = $1`, [dc.id]))) return no;
  if (!sampled(dc.id, s.samplePct)) return no;
  const last = await S(() => one<any>(`SELECT max(created_at) AS at FROM survey_response WHERE app_driver_id = $1 AND org_id = $2`, [appDriverId, dc.org_id]));
  if (last?.at && Date.now() - new Date(last.at).getTime() < s.minGapDays * 86_400_000) return no;
  return { ask: true as const, question: s.question ?? DEFAULT_QUESTION, operator: dc.operator, tags: TAGS };
}

export async function respond(appDriverId: string, b: Record<string, unknown>) {
  const dc = await chargeFor(appDriverId, String(b.chargeId ?? ''));
  const s = await settings(dc.org_id);
  if (!s.enabled) throw new SurveyError(409, 'Survei tidak aktif.');
  const score = Number(b.score);
  if (!(Number.isInteger(score) && score >= 0 && score <= 10)) throw new SurveyError(422, 'Nilai 0 sampai 10.');
  const tags = (Array.isArray(b.tags) ? b.tags : []).map(String).filter((t) => (TAGS as readonly string[]).includes(t)).slice(0, 8);
  const comment = b.comment ? String(b.comment).trim().slice(0, 2000) || null : null;
  const r = await S(() => one<any>(
    `INSERT INTO survey_response (org_id, driver_charge_id, app_driver_id, device_id, site_id, charge_point_id, score, tags, comment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (driver_charge_id) DO NOTHING RETURNING id`,
    [dc.org_id, dc.id, appDriverId, dc.device_id ?? null, dc.site_id ?? null, dc.charge_point_id ?? null, score, tags, comment]));
  if (!r) throw new SurveyError(409, 'Anda sudah menilai pengisian ini.');
  // A detractor's comment goes to the support desk, linked to the session.
  let caseRef: string | null = null;
  if (score <= 6 && comment && s.caseOnLow) {
    const desk = await import('./support-desk.js');
    if ((await desk.settings(dc.org_id)).enabled) {
      const d = await S(() => one<any>(`SELECT name, email, phone FROM app_driver WHERE id = $1`, [appDriverId]));
      const c = await desk.create(dc.org_id, {
        subject: `Survey: ${score}/10${tags.length ? ` (${tags.join(', ')})` : ''}`, body: comment, channel: 'app', category: tags.includes('payment') ? 'payment' : tags.includes('broken') ? 'charger_fault' : 'charging',
        appDriverId, customerName: d?.name ?? null, customerPhoneMasked: d?.phone ? `${d.phone.slice(0, 4)}…${d.phone.slice(-3)}` : null, sessionId: dc.session_id,
      }).catch(() => null);
      if (c) { await S(() => query(`UPDATE survey_response SET case_id = $2 WHERE id = $1`, [r.id, Number(c.id)])); caseRef = c.ref; }
    }
  }
  return { ok: true, caseRef };
}

// ------------------------------------------------------------------ the console

/** NPS overall, per site, per charger and by week, over `days` (default 90). */
export async function overview(orgId: string, q: Record<string, unknown> = {}) {
  const days = Math.min(730, Math.max(7, Number(q.days) || 90));
  const rows = await S(() => many<any>(
    `SELECT r.score, r.tags, r.created_at, r.site_id, s.name AS site, r.charge_point_id, COALESCE(cp.display_name, cp.ocpp_identity) AS charger
       FROM survey_response r LEFT JOIN site s ON s.id = r.site_id LEFT JOIN charge_point cp ON cp.id = r.charge_point_id
      WHERE r.org_id = $1 AND r.created_at > now() - make_interval(days => $2)`, [orgId, days]));
  const group = <K extends string>(key: (r: any) => K | null, label: (r: any) => string) => {
    const m = new Map<K, { label: string; scores: number[] }>();
    for (const r of rows) { const k = key(r); if (k == null) continue; const g = m.get(k) ?? { label: label(r), scores: [] }; g.scores.push(r.score); m.set(k, g); }
    return [...m.entries()].map(([id, g]) => ({ id, name: g.label, ...nps(g.scores) })).sort((a, b) => (a.nps ?? 0) - (b.nps ?? 0));
  };
  const tz = config.billing.timeZone;
  const weekOf = (d: Date) => {
    const local = new Date(new Date(d).toLocaleString('en-US', { timeZone: tz }));
    local.setDate(local.getDate() - ((local.getDay() + 6) % 7));
    return local.toISOString().slice(0, 10);
  };
  const weeks = group((r) => weekOf(r.created_at), (r) => weekOf(r.created_at)).sort((a, b) => a.id.localeCompare(b.id));
  const tagCounts: Record<string, { all: number; detractors: number }> = {};
  for (const r of rows) for (const t of r.tags ?? []) { const c = tagCounts[t] ?? { all: 0, detractors: 0 }; c.all++; if (r.score <= 6) c.detractors++; tagCounts[t] = c; }
  return {
    days, ...nps(rows.map((r) => r.score)),
    bySite: group((r) => r.site_id, (r) => r.site ?? '—'), byCharger: group((r) => r.charge_point_id, (r) => r.charger ?? '—'), byWeek: weeks,
    tags: Object.entries(tagCounts).map(([tag, c]) => ({ tag, ...c })).sort((a, b) => b.all - a.all),
    distribution: Array.from({ length: 11 }, (_, i) => rows.filter((r) => r.score === i).length),
  };
}

export async function responses(orgId: string, q: Record<string, unknown> = {}) {
  const band = String(q.band ?? '');
  const rows = await S(() => many<any>(
    `SELECT r.*, s.name AS site, COALESCE(cp.display_name, cp.ocpp_identity) AS charger, c.number AS case_number, c.status AS case_status
       FROM survey_response r LEFT JOIN site s ON s.id = r.site_id LEFT JOIN charge_point cp ON cp.id = r.charge_point_id LEFT JOIN support_case c ON c.id = r.case_id
      WHERE r.org_id = $1 AND ($2 = '' OR ($2 = 'detractor' AND r.score <= 6) OR ($2 = 'passive' AND r.score BETWEEN 7 AND 8) OR ($2 = 'promoter' AND r.score >= 9))
        AND ($3::boolean IS NOT TRUE OR r.comment IS NOT NULL) AND ($4::uuid IS NULL OR r.site_id = $4)
      ORDER BY r.created_at DESC LIMIT 300`,
    [orgId, ['detractor', 'passive', 'promoter'].includes(band) ? band : '', q.withComment === 'true' || q.withComment === true, /^[0-9a-f-]{36}$/i.test(String(q.siteId ?? '')) ? q.siteId : null]));
  return rows.map((r) => ({
    id: String(r.id), score: r.score, tags: r.tags ?? [], comment: r.comment ?? null, site: r.site ?? null, charger: r.charger ?? null, sessionId: undefined,
    caseId: r.case_id == null ? null : String(r.case_id), caseRef: r.case_number ? `PS-${r.case_number}` : null, caseStatus: r.case_status ?? null, createdAt: new Date(r.created_at).toISOString(),
  }));
}
