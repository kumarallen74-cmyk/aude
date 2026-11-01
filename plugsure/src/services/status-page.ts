import { createHash, randomBytes } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';
import * as registry from '../ocpp/registry.js';
import { sendEmail } from './notify-transports.js';
import { unseal } from './secrets.js';

/**
 * The public status page (v1.43.0): per operator, a page anyone can open — each site's live availability, current
 * incidents and planned maintenance, the last two weeks' history — and e-mail updates for those who subscribe.
 *
 *   address  /status/<slug> on the shared console, and /status on the operator's own approved console address
 *   data     GET /v1/status/<slug> (public, cached 30 s); nothing private: site names and counts, what the operator
 *            wrote in its incidents. Off until the operator switches it on (Governance → Status page).
 *   e-mail   subscribing sends a confirmation link (nothing else is sent until it is followed); every message carries
 *            a one-click unsubscribe link. Sent through the operator's e-mail channel (Governance → Alert routing).
 *
 * A site's state: operational (every connector online and not faulted), degraded (some out of service), outage (none
 * usable), maintenance (a planned window is on). "Out of service": offline, faulted, unavailable or held for
 * maintenance; a connector in use counts as working.
 */

export class StatusError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export const MAINTENANCE_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'] as const;
const CLOSED = new Set(['resolved', 'completed', 'cancelled']);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// ------------------------------------------------------------------ settings

export async function page(orgId: string) {
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM status_page WHERE org_id = $1`, [orgId]));
  const subs = await outsideRequestScope(() => one<any>(`SELECT count(*) FILTER (WHERE confirmed_at IS NOT NULL)::int AS confirmed, count(*)::int AS total FROM status_subscriber WHERE org_id = $1`, [orgId]));
  if (!r) {
    const o = await outsideRequestScope(() => one<any>(`SELECT name, slug FROM organisation WHERE id = $1`, [orgId]));
    return { enabled: false, slug: String(o?.slug ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50), title: `${o?.name ?? 'Charging'} status`, intro: null, siteIds: null, showCounts: true, subscribers: subs?.confirmed ?? 0, saved: false };
  }
  return { enabled: r.enabled, slug: r.slug, title: r.title, intro: r.intro ?? null, siteIds: r.site_ids ?? null, showCounts: r.show_counts, subscribers: subs?.confirmed ?? 0, saved: true };
}

export async function savePage(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cur = await page(orgId);
  const pick = <T>(k: string, d: T): T => (b[k] === undefined ? d : (b[k] as T));
  const slug = String(pick('slug', cur.slug)).trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw new StatusError(422, 'slug: 3 to 50 lower-case letters, digits and dashes (the page\'s address: /status/<slug>).');
  const title = String(pick('title', cur.title)).trim().slice(0, 120);
  if (title.length < 2) throw new StatusError(422, 'title is 2 to 120 characters.');
  const introRaw = pick<unknown>('intro', cur.intro);
  const intro = introRaw ? String(introRaw).trim().slice(0, 1000) || null : null;
  const rawSites = pick<unknown>('siteIds', cur.siteIds);
  let siteIds: string[] | null = null;
  if (Array.isArray(rawSites) && rawSites.length) {
    siteIds = [...new Set(rawSites.map(String))];
    if (siteIds.some((s) => !UUID_RE.test(s))) throw new StatusError(422, 'siteIds: your sites (empty for all).');
    const n = await outsideRequestScope(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM site WHERE id = ANY($1::uuid[]) AND org_id = $2`, [siteIds, orgId]));
    if (n?.n !== siteIds.length) throw new StatusError(422, 'siteIds: a site is not one of yours.');
  }
  const taken = await outsideRequestScope(() => one(`SELECT 1 FROM status_page WHERE slug = $1 AND org_id <> $2`, [slug, orgId]));
  if (taken) throw new StatusError(409, 'This address is taken: choose another slug.');
  await outsideRequestScope(() => query(
    `INSERT INTO status_page (org_id, enabled, slug, title, intro, site_ids, show_counts, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, slug = EXCLUDED.slug, title = EXCLUDED.title, intro = EXCLUDED.intro,
       site_ids = EXCLUDED.site_ids, show_counts = EXCLUDED.show_counts, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, pick('enabled', cur.enabled) === true, slug, title, intro, siteIds, pick('showCounts', cur.showCounts) !== false, userId]));
  return page(orgId);
}

// ------------------------------------------------------------------ incidents and maintenance

const incidentOf = (r: any, names: Map<string, string>) => ({
  id: String(r.id), kind: r.kind, title: r.title, impact: r.impact, status: r.status, open: !CLOSED.has(r.status),
  sites: (r.site_ids ?? []).map((id: string) => ({ id, name: names.get(id) ?? '' })),
  startedAt: new Date(r.started_at).toISOString(), scheduledFrom: r.scheduled_from ? new Date(r.scheduled_from).toISOString() : null,
  scheduledTo: r.scheduled_to ? new Date(r.scheduled_to).toISOString() : null, resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
  updates: (r.updates ?? []) as Array<{ at: string; status: string; message: string }>,
});

const siteNames = async (orgId: string) => new Map((await outsideRequestScope(() => many<any>(`SELECT id, name FROM site WHERE org_id = $1`, [orgId]))).map((s) => [s.id, s.name] as [string, string]));

export async function incidents(orgId: string, q: { days?: unknown } = {}) {
  const days = Math.min(365, Math.max(1, Number(q.days) || 60));
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT * FROM status_incident WHERE org_id = $1 AND (status NOT IN ('resolved', 'completed', 'cancelled') OR updated_at > now() - make_interval(days => $2))
      ORDER BY (status IN ('resolved', 'completed', 'cancelled')), COALESCE(scheduled_from, started_at) DESC LIMIT 300`, [orgId, days]));
  const names = await siteNames(orgId);
  return { incidents: rows.map((r) => incidentOf(r, names)) };
}

/** Open an incident or schedule maintenance (with its first update). */
export async function createIncident(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const kind = b.kind === 'maintenance' ? 'maintenance' : 'incident';
  const title = String(b.title ?? '').trim().slice(0, 200);
  if (title.length < 3) throw new StatusError(422, 'title is 3 to 200 characters.');
  const impact = String(b.impact ?? 'minor');
  if (!['minor', 'major', 'critical'].includes(impact)) throw new StatusError(422, 'impact is minor, major or critical.');
  const status = String(b.status ?? (kind === 'maintenance' ? 'scheduled' : 'investigating'));
  if (!(kind === 'incident' ? (INCIDENT_STATUSES as readonly string[]) : (MAINTENANCE_STATUSES as readonly string[])).includes(status)) throw new StatusError(422, `status is one of ${(kind === 'incident' ? INCIDENT_STATUSES : MAINTENANCE_STATUSES).join(', ')}.`);
  const siteIds = Array.isArray(b.siteIds) ? [...new Set(b.siteIds.map(String))] : [];
  if (siteIds.some((s) => !UUID_RE.test(s))) throw new StatusError(422, 'siteIds: your sites.');
  if (siteIds.length) {
    const n = await outsideRequestScope(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM site WHERE id = ANY($1::uuid[]) AND org_id = $2`, [siteIds, orgId]));
    if (n?.n !== siteIds.length) throw new StatusError(422, 'siteIds: a site is not one of yours.');
  }
  let from: Date | null = null, to: Date | null = null;
  if (kind === 'maintenance') {
    from = new Date(String(b.scheduledFrom ?? '')); to = new Date(String(b.scheduledTo ?? ''));
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) throw new StatusError(422, 'Maintenance needs scheduledFrom and scheduledTo (to after from).');
  }
  const message = String(b.message ?? '').trim().slice(0, 2000);
  if (!message) throw new StatusError(422, 'message: what people should know (it is public).');
  const upd = [{ at: new Date().toISOString(), status, message }];
  const r = await outsideRequestScope(() => one<any>(
    `INSERT INTO status_incident (org_id, kind, title, impact, status, site_ids, scheduled_from, scheduled_to, resolved_at, updates, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [orgId, kind, title, impact, status, siteIds, from, to, CLOSED.has(status) ? new Date() : null, JSON.stringify(upd), userId]));
  const view = incidentOf(r, await siteNames(orgId));
  if (b.notify !== false) void notifySubscribers(orgId, view, upd[0]!).catch((e) => logger.warn({ orgId, err: (e as Error).message }, 'status e-mails failed'));
  return view;
}

/** Post an update (a new status and a message), or edit the title / impact / sites. */
export async function updateIncident(orgId: string, id: string, b: Record<string, unknown>) {
  const cur = await outsideRequestScope(() => one<any>(`SELECT * FROM status_incident WHERE id = $1 AND org_id = $2`, [Number(id) || 0, orgId]));
  if (!cur) throw new StatusError(404, 'No such incident.');
  const status = b.status === undefined ? cur.status : String(b.status);
  if (!(cur.kind === 'incident' ? (INCIDENT_STATUSES as readonly string[]) : (MAINTENANCE_STATUSES as readonly string[])).includes(status)) throw new StatusError(422, 'Not a status for this kind.');
  const message = String(b.message ?? '').trim().slice(0, 2000);
  const updates = [...(cur.updates ?? [])];
  let added: { at: string; status: string; message: string } | null = null;
  if (message || status !== cur.status) {
    if (!message) throw new StatusError(422, 'message: say what changed (it is public).');
    added = { at: new Date().toISOString(), status, message };
    updates.push(added);
  }
  const title = b.title === undefined ? cur.title : String(b.title).trim().slice(0, 200);
  if (title.length < 3) throw new StatusError(422, 'title is 3 to 200 characters.');
  const impact = b.impact === undefined ? cur.impact : String(b.impact);
  if (!['minor', 'major', 'critical'].includes(impact)) throw new StatusError(422, 'impact is minor, major or critical.');
  const r = await outsideRequestScope(() => one<any>(
    `UPDATE status_incident SET status = $2, title = $3, impact = $4, updates = $5, updated_at = now(),
            resolved_at = CASE WHEN $6 THEN COALESCE(resolved_at, now()) ELSE NULL END
      WHERE id = $1 RETURNING *`, [cur.id, status, title, impact, JSON.stringify(updates.slice(-100)), CLOSED.has(status)]));
  const view = incidentOf(r, await siteNames(orgId));
  if (added && b.notify !== false) void notifySubscribers(orgId, view, added).catch((e) => logger.warn({ orgId, err: (e as Error).message }, 'status e-mails failed'));
  return view;
}

// ------------------------------------------------------------------ the public page

/** Each site's state from its connectors (and an open maintenance window). */
export function siteState(c: { total: number; working: number; inUse: number }, maintenance: boolean): 'operational' | 'degraded' | 'outage' | 'maintenance' {
  if (maintenance) return 'maintenance';
  if (c.total === 0 || c.working === c.total) return 'operational';
  return c.working === 0 ? 'outage' : 'degraded';
}

async function orgForPage(slug: string | null, host: string | null): Promise<string | null> {
  if (slug) {
    if (!SLUG_RE.test(slug)) return null;
    return (await outsideRequestScope(() => one<{ org_id: string }>(`SELECT org_id FROM status_page WHERE slug = $1 AND enabled`, [slug])))?.org_id ?? null;
  }
  if (host) {
    const { consoleBrandForHost } = await import('./console-brand.js');
    const b = await consoleBrandForHost(host).catch(() => null);
    if (!b) return null;
    return (await outsideRequestScope(() => one<{ org_id: string }>(`SELECT org_id FROM status_page WHERE org_id = $1 AND enabled`, [b.orgId])))?.org_id ?? null;
  }
  return null;
}

/** The public page's data, or null when there is no such (enabled) page. */
export async function publicStatus(slug: string | null, host: string | null = null, now = new Date()) {
  const orgId = await orgForPage(slug, host);
  if (!orgId) return null;
  const p = await page(orgId);
  const sites = await outsideRequestScope(() => many<any>(
    `SELECT s.id, s.name, s.address, cp.ocpp_identity, cn.status, cn.maintenance_since
       FROM site s JOIN charge_point cp ON cp.site_id = s.id AND cp.decommissioned_at IS NULL
       JOIN evse e ON e.charge_point_id = cp.id JOIN connector cn ON cn.evse_uuid = e.id
      WHERE s.org_id = $1 AND s.archived_at IS NULL AND ($2::uuid[] IS NULL OR s.id = ANY($2::uuid[]))
      ORDER BY s.name`, [orgId, p.siteIds]));
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT * FROM status_incident WHERE org_id = $1
        AND (status NOT IN ('resolved', 'completed', 'cancelled') OR COALESCE(resolved_at, updated_at) > $2::timestamptz - interval '14 days')
      ORDER BY COALESCE(scheduled_from, started_at) DESC LIMIT 100`, [orgId, now]));
  const names = await siteNames(orgId);
  const items = rows.map((r) => incidentOf(r, names));
  const maintenanceNow = items.filter((i) => i.kind === 'maintenance' && i.open && i.status !== 'cancelled' && new Date(i.scheduledFrom!) <= now && new Date(i.scheduledTo!) > now);
  const bySite = new Map<string, { id: string; name: string; address: string | null; total: number; working: number; inUse: number }>();
  const BUSY = new Set(['Charging', 'Preparing', 'SuspendedEV', 'SuspendedEVSE', 'Finishing', 'Occupied']);
  for (const r of sites) {
    const g = bySite.get(r.id) ?? { id: r.id, name: r.name, address: r.address ?? null, total: 0, working: 0, inUse: 0 };
    g.total++;
    const online = registry.isOnline(r.ocpp_identity);
    const out = !online || r.maintenance_since || ['Faulted', 'Unavailable'].includes(r.status);
    if (!out) g.working++;
    if (!out && BUSY.has(r.status)) g.inUse++;
    bySite.set(r.id, g);
  }
  const siteViews = [...bySite.values()].map((s) => {
    const maint = maintenanceNow.some((m) => !m.sites.length || m.sites.some((x: { id: string }) => x.id === s.id));
    const state = siteState(s, maint);
    return { id: s.id, name: s.name, address: s.address, state, ...(p.showCounts ? { connectors: s.total, working: s.working, available: s.working - s.inUse } : {}) };
  });
  const open = items.filter((i) => i.open && i.kind === 'incident');
  // A major outage: every listed site out of service, or a critical incident. One site out among working ones is partial.
  const worst = (siteViews.length > 0 && siteViews.every((s) => s.state === 'outage')) || open.some((i) => i.impact === 'critical') ? 'major_outage'
    : siteViews.some((s) => s.state !== 'operational') || open.length ? 'partial' : 'operational';
  const brand = await outsideRequestScope(() => one<any>(`SELECT product_name, brand_color, logo_sha256 FROM console_brand WHERE org_id = $1`, [orgId])).catch(() => null);
  const pub = (i: ReturnType<typeof incidentOf>) => ({ ...i, sites: i.sites.map((s: { name: string }) => s.name) });
  return {
    title: p.title, intro: p.intro, slug: p.slug, overall: worst, updatedAt: now.toISOString(),
    brand: brand ? { name: brand.product_name, color: brand.brand_color, logo: brand.logo_sha256 ? `/console-brand/${brand.logo_sha256}.png` : null } : null,
    sites: siteViews,
    incidents: open.map(pub),
    maintenance: items.filter((i) => i.kind === 'maintenance' && i.open && i.status !== 'cancelled').map(pub),
    history: items.filter((i) => !i.open).map(pub),
  };
}

// ------------------------------------------------------------------ subscribers

/** Subscribe: a pending subscriber and the confirmation e-mail. The same answer whether the address was new or not. */
export async function subscribe(slug: string, email: unknown, base: string): Promise<void> {
  const orgId = await orgForPage(slug, null);
  if (!orgId) throw new StatusError(404, 'No such status page.');
  const e = String(email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 200) throw new StatusError(422, 'Enter an e-mail address.');
  const confirm = randomBytes(24).toString('base64url'), unsub = randomBytes(24).toString('base64url');
  const r = await outsideRequestScope(() => one<any>(
    `INSERT INTO status_subscriber (org_id, email, confirm_hash, unsubscribe_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, lower(email)) DO UPDATE SET confirm_hash = CASE WHEN status_subscriber.confirmed_at IS NULL THEN EXCLUDED.confirm_hash ELSE status_subscriber.confirm_hash END
     RETURNING confirmed_at, (xmax = 0) AS created`, [orgId, e, sha(confirm), sha(unsub)]));
  if (r?.confirmed_at) return; // already subscribed: nothing to send (and nothing said)
  const p = await page(orgId);
  const link = `${base}/v1/status/${encodeURIComponent(slug)}/confirm?t=${confirm}`;
  const text = `Someone (we hope you) asked for e-mail updates from ${p.title}.\n\nConfirm here: ${link}\n\nIf it was not you, ignore this message: nothing will be sent.`;
  await sendFor(orgId, e, `Confirm updates from ${p.title}`, text, `<p>Someone (we hope you) asked for e-mail updates from <b>${esc(p.title)}</b>.</p><p><a href="${esc(link)}">Confirm</a></p><p>If it was not you, ignore this message: nothing will be sent.</p>`);
}

export async function confirm(slug: string, token: unknown): Promise<boolean> {
  const orgId = await orgForPage(slug, null);
  if (!orgId || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) return false;
  const r = await outsideRequestScope(() => query(`UPDATE status_subscriber SET confirmed_at = now(), confirm_hash = NULL WHERE org_id = $1 AND confirm_hash = $2`, [orgId, sha(token)]));
  return (r.rowCount ?? 0) > 0;
}

export async function unsubscribe(slug: string, token: unknown): Promise<boolean> {
  const orgId = await orgForPage(slug, null) ?? (await outsideRequestScope(() => one<{ org_id: string }>(`SELECT org_id FROM status_page WHERE slug = $1`, [slug])))?.org_id ?? null;
  if (!orgId || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) return false;
  const r = await outsideRequestScope(() => query(`DELETE FROM status_subscriber WHERE org_id = $1 AND unsubscribe_hash = $2`, [orgId, sha(token)]));
  return (r.rowCount ?? 0) > 0;
}

async function sendFor(orgId: string, to: string, subject: string, text: string, html: string) {
  const ch = await outsideRequestScope(() => one<{ enabled: boolean; config: any; secret: string | null }>(`SELECT enabled, config, secret FROM notification_channel WHERE org_id = $1 AND kind = 'email' ORDER BY created_at LIMIT 1`, [orgId]));
  if (!ch?.enabled || !ch.config?.host) throw new StatusError(503, 'E-mail updates are not available right now.');
  let secret: string | null = null;
  try { secret = ch.secret ? unseal(ch.secret) : null; } catch { secret = null; }
  const out = await sendEmail(ch.config, secret, to, { subject, text, html, kind: 'status-page' });
  if (!out.ok) throw new StatusError(502, 'The e-mail could not be sent.');
}

/**
 * E-mail an incident or maintenance update to every confirmed subscriber (one message each, with its own unsubscribe
 * link; at most 2,000). A new unsubscribe token is issued per message, so an old link stays valid only until the next.
 */
export async function notifySubscribers(orgId: string, i: { kind: string; title: string; status: string; sites: Array<{ name: string }>; scheduledFrom: string | null; scheduledTo: string | null }, u: { message: string }, base?: string): Promise<number> {
  const p = await page(orgId);
  if (!p.enabled) return 0;
  const subs = await outsideRequestScope(() => many<{ id: string; email: string }>(`SELECT id, email FROM status_subscriber WHERE org_id = $1 AND confirmed_at IS NOT NULL ORDER BY id LIMIT 2000`, [orgId]));
  if (!subs.length) return 0;
  const { config } = await import('../config.js');
  const root = base ?? (config.alerts.consoleUrl || config.console.publicBaseUrl || '');
  const where = i.sites.length ? ` (${i.sites.map((s) => s.name).join(', ')})` : '';
  const when = i.kind === 'maintenance' && i.scheduledFrom ? `\nWhen: ${i.scheduledFrom.slice(0, 16).replace('T', ' ')} to ${i.scheduledTo!.slice(0, 16).replace('T', ' ')} UTC` : '';
  const subject = `[${p.title}] ${i.title}: ${i.status.replace('_', ' ')}`;
  let n = 0;
  for (const s of subs) {
    const unsub = randomBytes(24).toString('base64url');
    await outsideRequestScope(() => query(`UPDATE status_subscriber SET unsubscribe_hash = $2 WHERE id = $1`, [s.id, sha(unsub)]));
    const page_ = `${root}/status/${p.slug}`, off = `${root}/v1/status/${p.slug}/unsubscribe?t=${unsub}`;
    const text = `${i.title}${where}: ${i.status.replace('_', ' ')}${when}\n\n${u.message}\n\nStatus page: ${page_}\nUnsubscribe: ${off}`;
    const html = `<p><b>${esc(i.title)}</b>${esc(where)}: ${esc(i.status.replace('_', ' '))}${when ? `<br>${esc(when.trim())}` : ''}</p><p>${esc(u.message).replace(/\n/g, '<br>')}</p><p><a href="${esc(page_)}">Status page</a> · <a href="${esc(off)}">Unsubscribe</a></p>`;
    try { await sendFor(orgId, s.email, subject, text, html); n++; } catch (e) { logger.warn({ orgId, err: (e as Error).message }, 'status e-mail not sent'); break; }
  }
  return n;
}
