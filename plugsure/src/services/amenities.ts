import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { persistAlert } from './alerts.js';

/**
 * Accessibility and site amenities (v1.49.0), Operate → Sites → Amenities & access. What a site offers while the car
 * charges, and how accessible it is:
 *
 *   amenities      toilets, a prayer room (musholla), food, a shop, Wi-Fi, a roof or shade, lighting at night,
 *                  security, a lounge, free parking; opening hours (or 24 hours)
 *   accessibility  accessible bays (wider, near the charger, marked), a step-free route, the bay width, how far the
 *                  cable reaches and how high the screen is. Five checks (an accessible bay; step-free; a bay at least
 *                  3.6 m wide; a cable of at least 3 m; the screen and payment at most 120 cm high) make the score;
 *                  a site with an accessible bay and a step-free route is shown as accessible
 *   in the app     each station shows its amenities and whether it is accessible, and drivers filter on them. Drivers
 *                  report what is wrong (a blocked bay, no step-free route, a cable too short, a screen too high, an
 *                  amenity that is not there); the reports come here, and access.report is raised for each
 */

export class AmenityError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const REPORT_ALERT = 'access.report';
export const AMENITIES = ['toilet', 'prayer_room', 'food', 'shop', 'wifi', 'covered', 'lit', 'security', 'lounge', 'free_parking'] as const;
export const REPORT_KINDS = ['blocked_bay', 'no_step_free', 'cable_short', 'screen_high', 'amenity_wrong', 'other'] as const;
const S = <T>(fn: () => T) => outsideRequestScope(fn);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
const str = (v: unknown, max: number) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };

export interface Access { accessibleBays: number; stepFree: boolean | null; bayWidthM: number | null; cableReachM: number | null; maxScreenHeightCm: number | null }

/** The five accessibility checks that pass (0 to 5), and whether the site counts as accessible. */
export function accessScore(a: Access): { score: number; accessible: boolean; checks: Record<string, boolean | null> } {
  const checks = {
    accessibleBay: a.accessibleBays > 0,
    stepFree: a.stepFree,
    wideBay: a.bayWidthM == null ? null : a.bayWidthM >= 3.6,
    cableReach: a.cableReachM == null ? null : a.cableReachM >= 3,
    screenHeight: a.maxScreenHeightCm == null ? null : a.maxScreenHeightCm <= 120,
  };
  return { score: Object.values(checks).filter((v) => v === true).length, accessible: a.accessibleBays > 0 && a.stepFree === true, checks };
}

const of = (r: any) => {
  const a: Access = { accessibleBays: Number(r?.accessible_bays ?? 0), stepFree: r?.step_free ?? null, bayWidthM: num(r?.bay_width_m), cableReachM: num(r?.cable_reach_m), maxScreenHeightCm: r?.max_screen_height_cm ?? null };
  return { amenities: (r?.amenities ?? []) as string[], ...a, open24h: r?.open_24h ?? null, hours: r?.hours ?? null, notes: r?.notes ?? null,
    verifiedOn: r?.verified_at instanceof Date ? `${r.verified_at.getFullYear()}-${String(r.verified_at.getMonth() + 1).padStart(2, '0')}-${String(r.verified_at.getDate()).padStart(2, '0')}` : r?.verified_at ? String(r.verified_at).slice(0, 10) : null, ...accessScore(a) };
};

async function siteOf(orgId: string, siteId: string) {
  const s = UUID_RE.test(siteId) ? await S(() => one<any>(`SELECT id, name FROM site WHERE id = $1 AND org_id = $2`, [siteId, orgId])) : null;
  if (!s) throw new AmenityError(404, 'No such site.');
  return s;
}

export async function list(orgId: string) {
  const rows = await S(() => many<any>(`SELECT s.id, s.name, s.address, a.*, (SELECT count(*) FROM accessibility_report r WHERE r.site_id = s.id AND r.status = 'open') AS reports
    FROM site s LEFT JOIN site_amenity a ON a.site_id = s.id WHERE s.org_id = $1 AND s.archived_at IS NULL ORDER BY s.name`, [orgId]));
  const sites = rows.map((r) => ({ siteId: r.id, name: r.name, address: r.address ?? null, filled: !!r.site_id, openReports: Number(r.reports), ...of(r) }));
  return {
    sites, amenities: AMENITIES,
    summary: { sites: sites.length, filled: sites.filter((s) => s.filled).length, accessible: sites.filter((s) => s.accessible).length, openReports: sites.reduce((a, s) => a + s.openReports, 0) },
  };
}

export async function get(orgId: string, siteId: string) {
  const s = await siteOf(orgId, siteId);
  const r = await S(() => one<any>(`SELECT * FROM site_amenity WHERE site_id = $1`, [s.id]));
  return { siteId: s.id, name: s.name, ...of(r) };
}

export async function save(orgId: string, siteId: string, b: Record<string, unknown>) {
  const s = await siteOf(orgId, siteId);
  const cur = await S(() => one<any>(`SELECT * FROM site_amenity WHERE site_id = $1`, [s.id]));
  const am = b.amenities === undefined ? cur?.amenities ?? [] : Array.isArray(b.amenities) ? [...new Set(b.amenities.map(String))] : null;
  if (!am || am.some((x: string) => !(AMENITIES as readonly string[]).includes(x))) throw new AmenityError(422, `amenities are some of ${AMENITIES.join(', ')}.`);
  const pick = <T>(k: string, col: string, f: (v: unknown) => T) => (b[k] === undefined ? cur?.[col] ?? null : f(b[k]));
  const bays = Number(pick('accessibleBays', 'accessible_bays', (v) => v ?? 0) ?? 0);
  if (!Number.isInteger(bays) || bays < 0 || bays > 50) throw new AmenityError(422, 'accessibleBays is 0 to 50.');
  const bool = (v: unknown) => (v === null || v === '' ? null : v === true);
  const width = pick('bayWidthM', 'bay_width_m', num), reach = pick('cableReachM', 'cable_reach_m', num), screen = pick('maxScreenHeightCm', 'max_screen_height_cm', num);
  if (width != null && !(Number(width) >= 1.5 && Number(width) <= 10)) throw new AmenityError(422, 'bayWidthM is 1.5 to 10 metres.');
  if (reach != null && !(Number(reach) >= 0.5 && Number(reach) <= 15)) throw new AmenityError(422, 'cableReachM is 0.5 to 15 metres.');
  if (screen != null && !(Number.isInteger(Number(screen)) && Number(screen) >= 50 && Number(screen) <= 250)) throw new AmenityError(422, 'maxScreenHeightCm is 50 to 250.');
  const verified = b.verified === true ? new Date().toISOString().slice(0, 10) : cur?.verified_at ?? null;
  await S(() => query(`INSERT INTO site_amenity (site_id, org_id, amenities, accessible_bays, step_free, bay_width_m, cable_reach_m, max_screen_height_cm, open_24h, hours, notes, verified_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (site_id) DO UPDATE SET amenities = $3, accessible_bays = $4, step_free = $5, bay_width_m = $6, cable_reach_m = $7, max_screen_height_cm = $8, open_24h = $9,
      hours = $10, notes = $11, verified_at = $12, updated_at = now()`,
  [s.id, orgId, am, bays, pick('stepFree', 'step_free', bool), width, reach, screen, pick('open24h', 'open_24h', bool), pick('hours', 'hours', (v) => str(v, 120)), pick('notes', 'notes', (v) => str(v, 500)), verified]));
  return get(orgId, siteId);
}

/** For the app: each site's amenities and accessibility (sites without any are left out). */
export async function forSites(siteIds: string[]): Promise<Map<string, { amenities: string[]; accessible: boolean; accessScore: number; open24h: boolean | null }>> {
  const ids = siteIds.filter((x) => UUID_RE.test(x));
  if (!ids.length) return new Map();
  const rows = await S(() => many<any>(`SELECT * FROM site_amenity WHERE site_id = ANY($1::uuid[])`, [ids]));
  return new Map(rows.map((r) => { const o = of(r); return [r.site_id, { amenities: o.amenities, accessible: o.accessible, accessScore: o.score, open24h: o.open24h }]; }));
}

/** Filter the app's stations: every amenity asked for, and `accessible` when asked. */
export function matches(info: { amenities: string[]; accessible: boolean } | undefined, want: string[]): boolean {
  if (!want.length) return true;
  if (!info) return false;
  return want.every((w) => (w === 'accessible' ? info.accessible : info.amenities.includes(w)));
}

// ------------------------------------------------------------------ reports

export async function reports(orgId: string, q: Record<string, unknown> = {}) {
  const all = q.status === 'all';
  const rows = await S(() => many<any>(`SELECT r.*, s.name AS site_name, d.phone FROM accessibility_report r JOIN site s ON s.id = r.site_id LEFT JOIN app_driver d ON d.id = r.app_driver_id
    WHERE r.org_id = $1 AND ($2 OR r.status = 'open') ORDER BY r.status = 'open' DESC, r.created_at DESC LIMIT 500`, [orgId, all]));
  return rows.map((r) => ({ id: String(r.id), siteId: r.site_id, site: r.site_name, kind: r.kind, details: r.details ?? null, status: r.status, resolution: r.resolution ?? null,
    from: r.phone ? `…${String(r.phone).slice(-4)}` : null, createdAt: new Date(r.created_at).toISOString(), resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null }));
}

export async function resolveReport(orgId: string, id: string, b: Record<string, unknown>) {
  const status = String(b.status ?? 'resolved');
  if (!['resolved', 'dismissed'].includes(status)) throw new AmenityError(422, 'status is resolved or dismissed.');
  const resolution = str(b.resolution, 500);
  if (!resolution) throw new AmenityError(422, 'Say what was done (resolution).');
  const r = await S(() => one<any>(`UPDATE accessibility_report SET status = $3, resolution = $4, resolved_at = now() WHERE id = $1 AND org_id = $2 AND status = 'open' RETURNING *`, [Number(id) || 0, orgId, status, resolution]));
  if (!r) throw new AmenityError(404, 'No such open report.');
  await S(() => query(`UPDATE alert SET resolved_at = now() WHERE org_id = $1 AND kind = $2 AND target_type = 'accessibility_report' AND target_id = $3 AND resolved_at IS NULL`, [orgId, REPORT_ALERT, String(r.id)]));
  return { id: String(r.id), status };
}

/** A driver's report from the app (signed in or not). */
export async function driverReport(appDriverId: string | null, siteId: string, brandOrg: string | null, b: Record<string, unknown>) {
  const s = UUID_RE.test(siteId) ? await S(() => one<any>(`SELECT id, org_id, name FROM site WHERE id = $1 AND archived_at IS NULL AND ($2::uuid IS NULL OR org_id = $2)`, [siteId, brandOrg])) : null;
  if (!s) throw new AmenityError(404, 'Stasiun tidak ditemukan.');
  const kind = String(b.kind ?? '');
  if (!(REPORT_KINDS as readonly string[]).includes(kind)) throw new AmenityError(422, 'Pilih jenis masalah.');
  const details = str(b.details, 1000);
  if (appDriverId && await S(() => one(`SELECT 1 FROM accessibility_report WHERE app_driver_id = $1 AND site_id = $2 AND created_at > now() - interval '1 hour'`, [appDriverId, s.id]))) {
    throw new AmenityError(429, 'Laporan Anda untuk stasiun ini sudah kami terima.');
  }
  const r = await S(() => one<any>(`INSERT INTO accessibility_report (org_id, site_id, app_driver_id, kind, details) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [s.org_id, s.id, appDriverId, kind, details]));
  await S(() => persistAlert({ orgId: s.org_id, kind: REPORT_ALERT, severity: kind === 'blocked_bay' ? 'warning' : 'info', targetType: 'accessibility_report', targetId: String(r.id),
    message: `A driver reports at ${s.name}: ${kind.replace(/_/g, ' ')}${details ? ` (${details.slice(0, 120)})` : ''}.` } as any)).catch(() => null);
  return { id: String(r.id), received: true };
}
