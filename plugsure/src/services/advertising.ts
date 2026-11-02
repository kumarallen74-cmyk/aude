import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { many, one, outsideRequestScope, query, tx } from '../db/pool.js';
import { saveBuffer } from './storage.js';
import { xlsx } from './xlsx.js';
import * as credit from './driver-credit.js';

/**
 * Advertising on charger and kiosk screens (v1.51.0), Commercial → Advertising:
 *
 *   screens      a charger's screen or a kiosk at a site. Its player fetches its playlist with the screen's key, plays
 *                the creatives in rotation and reports what it played (proof of play)
 *   advertisers  who buys the campaigns
 *   campaigns    an advertiser's dates, sites (or every site with a screen) and price: per thousand plays (CPM, with
 *                an optional budget that stops it once spent) or a flat fee per month (prorated by the days it runs in
 *                a month). A campaign plays once it is active and has an approved creative
 *   creatives    JPEG, PNG or WebP images, or MP4 videos, up to 30 MB, each reviewed (approved or rejected with why)
 *                before it plays
 *   audience     plays reported by the screens, and the charging sessions at the campaign's screens while it ran
 *                (drivers in front of the screen)
 *   invoices     each month per advertiser: its campaigns' plays or days, the amount, the tax, the total. Drafted for
 *                last month automatically; issued (a number) and marked paid
 */

export class AdError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const S = <T>(fn: () => T) => outsideRequestScope(fn);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_FILE = 30 * 1024 * 1024;
const str = (v: unknown, max: number) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
/** A DATE column as YYYY-MM-DD: node-postgres parses DATE as local midnight, so read the local parts (toISOString would shift it a day east of UTC). */
const d10 = (v: any) => (v == null ? null : typeof v === 'string' ? v.slice(0, 10) : v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10));
/** Today in the billing time zone (the day plays are counted on). */
export const localDay = (at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: config.billing.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const lastMonth = () => { const t = new Date(); t.setUTCDate(1); t.setUTCMonth(t.getUTCMonth() - 1); return t.toISOString().slice(0, 7); };
const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/** The price of plays at a CPM (per thousand), rounded. */
export const cpmAmount = (plays: number, rateMinor: number) => Math.round((plays * rateMinor) / 1000);
/** A flat monthly fee for the days a campaign runs within the month. */
export function flatAmount(rateMinor: number, month: string, startsOn: string, endsOn: string): { days: number; amount: number } {
  const first = `${month}-01`, last = `${month}-${String(daysIn(month)).padStart(2, '0')}`;
  const from = startsOn > first ? startsOn : first, to = endsOn < last ? endsOn : last;
  if (to < from) return { days: 0, amount: 0 };
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  return { days, amount: Math.round((rateMinor * days) / daysIn(month)) };
}

const MIMES: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b.subarray(0, 3).toString('hex') === 'ffd8ff',
  'image/png': (b) => b.subarray(0, 4).toString('hex') === '89504e47',
  'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  'video/mp4': (b) => b.subarray(4, 8).toString() === 'ftyp',
};

// ------------------------------------------------------------------ settings

export async function settings(orgId: string) {
  const r = await S(() => one<any>(`SELECT * FROM ad_settings WHERE org_id = $1`, [orgId]));
  return { enabled: !!r?.enabled, currency: r?.currency ?? (await credit.settings(orgId)).currency, taxBps: Number(r?.tax_bps ?? 0), slotSeconds: Number(r?.slot_seconds ?? 15) };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>) {
  const c = await settings(orgId);
  const tax = b.taxBps === undefined ? c.taxBps : Number(b.taxBps);
  if (!Number.isInteger(tax) || tax < 0 || tax > 5000) throw new AdError(422, 'taxBps is 0 to 5000.');
  const slot = b.slotSeconds === undefined ? c.slotSeconds : Number(b.slotSeconds);
  if (!Number.isInteger(slot) || slot < 5 || slot > 120) throw new AdError(422, 'slotSeconds is 5 to 120.');
  const en = b.enabled === undefined ? c.enabled : b.enabled === true;
  await S(() => query(`INSERT INTO ad_settings (org_id, enabled, currency, tax_bps, slot_seconds) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (org_id) DO UPDATE SET enabled = $2, tax_bps = $4, slot_seconds = $5, updated_at = now()`, [orgId, en, c.currency, tax, slot]));
  return settings(orgId);
}

// ------------------------------------------------------------------ advertisers

const advOf = (r: any) => ({ id: String(r.id), name: r.name, contactName: r.contact_name ?? null, email: r.email ?? null, phone: r.phone ?? null, taxId: r.tax_id ?? null,
  address: r.address ?? null, archived: !!r.archived_at, campaigns: Number(r.campaigns ?? 0), active: Number(r.active ?? 0) });

export async function advertisers(orgId: string) {
  return (await S(() => many<any>(`SELECT a.*, (SELECT count(*) FROM ad_campaign c WHERE c.advertiser_id = a.id) AS campaigns,
      (SELECT count(*) FROM ad_campaign c WHERE c.advertiser_id = a.id AND c.status = 'active') AS active
    FROM ad_advertiser a WHERE a.org_id = $1 ORDER BY a.archived_at NULLS FIRST, a.name`, [orgId]))).map(advOf);
}

export async function saveAdvertiser(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await S(() => one<any>(`SELECT * FROM ad_advertiser WHERE id = $1 AND org_id = $2`, [Number(id) || 0, orgId])) : null;
  if (id && !cur) throw new AdError(404, 'No such advertiser.');
  if (cur && b.archive === true) { await S(() => query(`UPDATE ad_advertiser SET archived_at = now() WHERE id = $1`, [cur.id])); return { id: String(cur.id), archived: true }; }
  const v = (k: string, col: string, max: number) => (b[k] === undefined ? cur?.[col] ?? null : str(b[k], max));
  const name = v('name', 'name', 120);
  if (!name) throw new AdError(422, 'A name is required.');
  const email = v('email', 'email', 200);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AdError(422, 'Not an e-mail address.');
  const vals = [name, v('contactName', 'contact_name', 120), email, v('phone', 'phone', 30), v('taxId', 'tax_id', 40), v('address', 'address', 300)];
  const r = cur
    ? await S(() => one<any>(`UPDATE ad_advertiser SET name = $2, contact_name = $3, email = $4, phone = $5, tax_id = $6, address = $7 WHERE id = $1 RETURNING *`, [cur.id, ...vals]))
    : await S(() => one<any>(`INSERT INTO ad_advertiser (org_id, name, contact_name, email, phone, tax_id, address) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [orgId, ...vals]));
  return advOf(r);
}

// ------------------------------------------------------------------ screens

const scrOf = (r: any) => ({
  id: String(r.id), name: r.name, kind: r.kind, orientation: r.orientation, siteId: r.site_id, site: r.site_name ?? null,
  chargePointId: r.charge_point_id ?? null, charger: r.cp_name ?? null, status: r.status, keyPrefix: r.key_prefix ?? null,
  lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
  online: !!r.last_seen_at && Date.now() - new Date(r.last_seen_at).getTime() < 30 * 60_000, plays7d: Number(r.plays7 ?? 0),
});

export async function screens(orgId: string) {
  return (await S(() => many<any>(`SELECT sc.*, s.name AS site_name, COALESCE(cp.display_name, cp.ocpp_identity) AS cp_name,
      (SELECT COALESCE(sum(p.plays), 0) FROM ad_play p WHERE p.screen_id = sc.id AND p.day > current_date - 7) AS plays7
    FROM ad_screen sc JOIN site s ON s.id = sc.site_id LEFT JOIN charge_point cp ON cp.id = sc.charge_point_id
    WHERE sc.org_id = $1 AND sc.status <> 'archived' ORDER BY s.name, sc.name`, [orgId]))).map(scrOf);
}

export async function saveScreen(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await S(() => one<any>(`SELECT * FROM ad_screen WHERE id = $1 AND org_id = $2`, [Number(id) || 0, orgId])) : null;
  if (id && !cur) throw new AdError(404, 'No such screen.');
  if (cur && b.archive === true) { await S(() => query(`UPDATE ad_screen SET status = 'archived', key_hash = NULL WHERE id = $1`, [cur.id])); return { id: String(cur.id), archived: true }; }
  const siteId = String(b.siteId ?? cur?.site_id ?? '');
  if (!UUID_RE.test(siteId) || !(await S(() => one(`SELECT 1 FROM site WHERE id = $1 AND org_id = $2`, [siteId, orgId])))) throw new AdError(422, 'Choose the site.');
  const cp = b.chargePointId === undefined ? cur?.charge_point_id ?? null : b.chargePointId ? String(b.chargePointId) : null;
  if (cp && !(UUID_RE.test(cp) && await S(() => one(`SELECT 1 FROM charge_point WHERE id = $1 AND site_id = $2`, [cp, siteId])))) throw new AdError(422, 'That charger is not at this site.');
  const name = str(b.name ?? cur?.name, 120);
  if (!name) throw new AdError(422, 'A name is required.');
  const kind = String(b.kind ?? cur?.kind ?? (cp ? 'charger' : 'kiosk'));
  if (!['charger', 'kiosk'].includes(kind)) throw new AdError(422, 'kind is charger or kiosk.');
  const orientation = String(b.orientation ?? cur?.orientation ?? 'landscape');
  if (!['landscape', 'portrait'].includes(orientation)) throw new AdError(422, 'orientation is landscape or portrait.');
  const status = String(b.status ?? cur?.status ?? 'active');
  if (!['active', 'off'].includes(status)) throw new AdError(422, 'status is active or off.');
  const vals = [siteId, cp, name, kind, orientation, status];
  const r = cur
    ? await S(() => one<any>(`UPDATE ad_screen SET site_id = $2, charge_point_id = $3, name = $4, kind = $5, orientation = $6, status = $7 WHERE id = $1 RETURNING *`, [cur.id, ...vals]))
    : await S(() => one<any>(`INSERT INTO ad_screen (org_id, site_id, charge_point_id, name, kind, orientation, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [orgId, ...vals]));
  let key: string | undefined;
  if (!r.key_hash || b.rotateKey === true) {
    key = `scr_${randomBytes(24).toString('base64url')}`;
    await S(() => query(`UPDATE ad_screen SET key_hash = $2, key_prefix = $3 WHERE id = $1`, [r.id, sha(key!), key!.slice(0, 8)]));
  }
  return { id: String(r.id), name: r.name, ...(key ? { key } : {}) };
}

// ------------------------------------------------------------------ campaigns

const campOf = (r: any) => ({
  id: String(r.id), advertiserId: String(r.advertiser_id), advertiser: r.advertiser_name ?? null, name: r.name, startsOn: d10(r.starts_on), endsOn: d10(r.ends_on),
  siteIds: r.site_ids ?? null, pricing: r.pricing, rateMinor: Number(r.rate_minor), budgetMinor: r.budget_minor == null ? null : Number(r.budget_minor), weight: r.weight,
  status: r.status, pausedReason: r.paused_reason ?? null, currency: r.currency, plays: Number(r.plays ?? 0), creatives: Number(r.creatives ?? 0), approved: Number(r.approved ?? 0),
  pendingReview: Number(r.pending ?? 0), spentMinor: r.pricing === 'cpm' ? cpmAmount(Number(r.plays ?? 0), Number(r.rate_minor)) : null,
});
const C_SELECT = `SELECT c.*, a.name AS advertiser_name,
    (SELECT COALESCE(sum(p.plays), 0) FROM ad_play p WHERE p.campaign_id = c.id) AS plays,
    (SELECT count(*) FROM ad_creative k WHERE k.campaign_id = c.id AND k.removed_at IS NULL) AS creatives,
    (SELECT count(*) FROM ad_creative k WHERE k.campaign_id = c.id AND k.removed_at IS NULL AND k.review = 'approved') AS approved,
    (SELECT count(*) FROM ad_creative k WHERE k.campaign_id = c.id AND k.removed_at IS NULL AND k.review = 'pending') AS pending
  FROM ad_campaign c JOIN ad_advertiser a ON a.id = c.advertiser_id`;

export async function campaigns(orgId: string, q: Record<string, unknown> = {}) {
  const all = q.status === 'all';
  return (await S(() => many<any>(`${C_SELECT} WHERE c.org_id = $1 AND ($2 OR c.status <> 'ended' OR c.ends_on > current_date - 60) ORDER BY c.status = 'active' DESC, c.starts_on DESC`, [orgId, all]))).map(campOf);
}

async function cRow(orgId: string, id: string) {
  const r = await S(() => one<any>(`${C_SELECT} WHERE c.id = $1 AND c.org_id = $2`, [Number(id) || 0, orgId]));
  if (!r) throw new AdError(404, 'No such campaign.');
  return r;
}

/** The campaign with its creatives, its plays by day and by site, and the charging sessions at its screens. */
export async function campaign(orgId: string, id: string) {
  const r = await cRow(orgId, id);
  const creatives = (await S(() => many<any>(`SELECT k.*, (SELECT COALESCE(sum(plays), 0) FROM ad_play p WHERE p.creative_id = k.id) AS plays FROM ad_creative k
    WHERE k.campaign_id = $1 AND k.removed_at IS NULL ORDER BY k.id`, [r.id]))).map((k) => ({
    id: String(k.id), name: k.name, mime: k.mime, bytes: k.bytes, seconds: k.seconds, orientation: k.orientation, review: k.review, reviewNote: k.review_note ?? null, plays: Number(k.plays),
  }));
  const byDay = (await S(() => many<any>(`SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(plays) AS plays FROM ad_play WHERE campaign_id = $1 GROUP BY day ORDER BY day`, [r.id])))
    .map((x) => ({ day: x.day, plays: Number(x.plays) }));
  const bySite = (await S(() => many<any>(`SELECT s.name AS site, count(DISTINCT p.screen_id) AS screens, sum(p.plays) AS plays FROM ad_play p JOIN ad_screen sc ON sc.id = p.screen_id JOIN site s ON s.id = sc.site_id
    WHERE p.campaign_id = $1 GROUP BY s.name ORDER BY sum(p.plays) DESC`, [r.id]))).map((x) => ({ site: x.site, screens: Number(x.screens), plays: Number(x.plays) }));
  const aud = await S(() => one<any>(`SELECT count(DISTINCT cs.id) AS sessions FROM charging_session cs
    WHERE cs.charge_point_id IN (SELECT sc.charge_point_id FROM ad_screen sc WHERE sc.org_id = $1 AND sc.charge_point_id IS NOT NULL AND ($2::uuid[] IS NULL OR sc.site_id = ANY($2)))
      AND cs.started_at >= $3::date AND cs.started_at < $4::date + 1`, [orgId, r.site_ids, d10(r.starts_on), d10(r.ends_on)]));
  return { ...campOf(r), creatives, byDay, bySite, sessionsAtScreens: Number(aud?.sessions ?? 0) };
}

export async function saveCampaign(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await cRow(orgId, id) : null;
  if (cur?.status === 'ended') throw new AdError(409, 'An ended campaign cannot be changed.');
  const adv = String(b.advertiserId ?? cur?.advertiser_id ?? '');
  if (!(await S(() => one(`SELECT 1 FROM ad_advertiser WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [Number(adv) || 0, orgId])))) throw new AdError(422, 'Choose the advertiser.');
  const name = str(b.name ?? cur?.name, 120);
  if (!name) throw new AdError(422, 'A name is required.');
  const starts = String(b.startsOn ?? d10(cur?.starts_on) ?? ''), ends = String(b.endsOn ?? d10(cur?.ends_on) ?? '');
  if (!DATE_RE.test(starts) || !DATE_RE.test(ends) || ends < starts) throw new AdError(422, 'startsOn and endsOn are dates, the end not before the start.');
  const sites = b.siteIds === undefined ? cur?.site_ids ?? null : Array.isArray(b.siteIds) && b.siteIds.length ? b.siteIds.map(String) : null;
  if (sites) {
    if (sites.some((s: string) => !UUID_RE.test(s))) throw new AdError(422, 'siteIds are site ids.');
    const n = await S(() => one<any>(`SELECT count(*) AS n FROM site WHERE id = ANY($1::uuid[]) AND org_id = $2`, [sites, orgId]));
    if (Number(n.n) !== new Set(sites).size) throw new AdError(422, 'No such site.');
  }
  const pricing = String(b.pricing ?? cur?.pricing ?? 'cpm');
  if (!['cpm', 'flat'].includes(pricing)) throw new AdError(422, 'pricing is cpm or flat.');
  const rate = Number(b.rateMinor ?? cur?.rate_minor);
  if (!Number.isSafeInteger(rate) || rate < 0) throw new AdError(422, 'rateMinor is a whole amount, 0 or more.');
  const budget = b.budgetMinor === undefined ? cur?.budget_minor ?? null : b.budgetMinor === null || b.budgetMinor === '' ? null : Number(b.budgetMinor);
  if (budget != null && !(Number.isSafeInteger(Number(budget)) && Number(budget) > 0)) throw new AdError(422, 'budgetMinor is a whole amount above 0, or empty.');
  const weight = Number(b.weight ?? cur?.weight ?? 1);
  if (!Number.isInteger(weight) || weight < 1 || weight > 10) throw new AdError(422, 'weight is 1 to 10.');
  const vals = [Number(adv), name, starts, ends, sites, pricing, rate, pricing === 'cpm' ? budget : null, weight];
  if (cur) {
    await S(() => query(`UPDATE ad_campaign SET advertiser_id = $2, name = $3, starts_on = $4, ends_on = $5, site_ids = $6, pricing = $7, rate_minor = $8, budget_minor = $9, weight = $10 WHERE id = $1`, [cur.id, ...vals]));
    return campaign(orgId, String(cur.id));
  }
  const { currency } = await settings(orgId);
  const r = await S(() => one<any>(`INSERT INTO ad_campaign (org_id, advertiser_id, name, starts_on, ends_on, site_ids, pricing, rate_minor, budget_minor, weight, currency)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [orgId, ...vals, currency]));
  return campaign(orgId, String(r.id));
}

/** activate (needs an approved creative, not past its end, under its budget), pause, end. */
export async function setStatus(orgId: string, id: string, b: Record<string, unknown>) {
  const c = await cRow(orgId, id);
  const to = String(b.status ?? '');
  if (c.status === 'ended') throw new AdError(409, 'The campaign has ended.');
  if (to === 'active') {
    if (Number(c.approved) === 0) throw new AdError(409, 'Approve a creative first.');
    if (d10(c.ends_on)! < localDay()) throw new AdError(409, 'The campaign\'s end date has passed.');
    if (c.pricing === 'cpm' && c.budget_minor != null && cpmAmount(Number(c.plays), Number(c.rate_minor)) >= Number(c.budget_minor)) throw new AdError(409, 'The budget is spent: raise it first.');
    await S(() => query(`UPDATE ad_campaign SET status = 'active', paused_reason = NULL WHERE id = $1`, [c.id]));
  } else if (to === 'paused') {
    await S(() => query(`UPDATE ad_campaign SET status = 'paused', paused_reason = $2 WHERE id = $1`, [c.id, str(b.reason, 200) ?? 'Paused']));
  } else if (to === 'ended') {
    await S(() => query(`UPDATE ad_campaign SET status = 'ended' WHERE id = $1`, [c.id]));
  } else throw new AdError(422, 'status is active, paused or ended.');
  return campaign(orgId, id);
}

// ------------------------------------------------------------------ creatives

export async function addCreative(orgId: string, campaignId: string, b: Record<string, unknown>) {
  const c = await cRow(orgId, campaignId);
  if (c.status === 'ended') throw new AdError(409, 'The campaign has ended.');
  const m = /^data:([\w./+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl ?? ''));
  if (!m) throw new AdError(422, 'dataUrl: the file as a data URL.');
  const mime = m[1]!;
  if (!MIMES[mime]) throw new AdError(422, 'A JPEG, PNG or WebP image, or an MP4 video.');
  const data = Buffer.from(m[2]!, 'base64');
  if (data.length > MAX_FILE) throw new AdError(413, 'At most 30 MB a file.');
  if (data.length < 12 || !MIMES[mime]!(data)) throw new AdError(422, 'The file is not the type it says it is.');
  const { slotSeconds } = await settings(orgId);
  const seconds = b.seconds == null || b.seconds === '' ? slotSeconds : Number(b.seconds);
  if (!Number.isInteger(seconds) || seconds < 3 || seconds > 120) throw new AdError(422, 'seconds is 3 to 120.');
  const orientation = String(b.orientation ?? 'landscape');
  if (!['landscape', 'portrait'].includes(orientation)) throw new AdError(422, 'orientation is landscape or portrait.');
  const name = String(b.name ?? 'creative').replace(/[\\/]/g, '_').trim().slice(0, 160) || 'creative';
  const f = await saveBuffer('ads', `c${c.id}-${name}`, data);
  const r = await S(() => one<any>(`INSERT INTO ad_creative (org_id, campaign_id, name, mime, path, bytes, sha256, seconds, orientation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [orgId, c.id, name, mime, f.path, f.size, f.sha256, seconds, orientation]));
  return { id: String(r.id), name, review: 'pending' };
}

export async function reviewCreative(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  const review = String(b.review ?? '');
  if (!['approved', 'rejected'].includes(review)) throw new AdError(422, 'review is approved or rejected.');
  const note = str(b.note, 300);
  if (review === 'rejected' && !note) throw new AdError(422, 'Say why it is rejected (note).');
  const r = await S(() => one<any>(`UPDATE ad_creative SET review = $3, review_note = $4, reviewed_by = $5 WHERE id = $1 AND org_id = $2 AND removed_at IS NULL RETURNING id, campaign_id`,
    [Number(id) || 0, orgId, review, note, userId]));
  if (!r) throw new AdError(404, 'No such creative.');
  return { id: String(r.id), campaignId: String(r.campaign_id), review };
}

export async function removeCreative(orgId: string, id: string) {
  const r = await S(() => one<any>(`UPDATE ad_creative SET removed_at = now() WHERE id = $1 AND org_id = $2 AND removed_at IS NULL RETURNING id`, [Number(id) || 0, orgId]));
  if (!r) throw new AdError(404, 'No such creative.');
  return { id: String(r.id), removed: true };
}

export async function creativeFile(orgId: string, id: string) {
  const k = await S(() => one<any>(`SELECT * FROM ad_creative WHERE id = $1 AND org_id = $2 AND removed_at IS NULL`, [Number(id) || 0, orgId]));
  if (!k) throw new AdError(404, 'No such creative.');
  return { mime: k.mime as string, name: k.name as string, data: await readFile(k.path) };
}

// ------------------------------------------------------------------ the screen's player

async function screenByKey(key: string) {
  const s = key.startsWith('scr_') ? await S(() => one<any>(`SELECT * FROM ad_screen WHERE key_hash = $1 AND status <> 'archived'`, [sha(key)])) : null;
  if (!s) throw new AdError(401, 'Unknown screen key.');
  return s;
}

/** What a screen plays now: approved creatives of active campaigns for its site, today, under budget. */
async function playable(screen: any) {
  const st = await settings(screen.org_id);
  if (!st.enabled || screen.status !== 'active') return [];
  const today = localDay();
  const rows = await S(() => many<any>(`SELECT k.id, k.mime, k.seconds, k.orientation, k.sha256, c.id AS campaign_id, c.weight, c.pricing, c.rate_minor, c.budget_minor,
      (SELECT COALESCE(sum(p.plays), 0) FROM ad_play p WHERE p.campaign_id = c.id) AS plays
    FROM ad_creative k JOIN ad_campaign c ON c.id = k.campaign_id
    WHERE c.org_id = $1 AND c.status = 'active' AND k.review = 'approved' AND k.removed_at IS NULL
      AND c.starts_on <= $2::date AND c.ends_on >= $2::date AND (c.site_ids IS NULL OR $3 = ANY(c.site_ids))
    ORDER BY c.id, k.id`, [screen.org_id, today, screen.site_id]));
  const under = rows.filter((r) => !(r.pricing === 'cpm' && r.budget_minor != null && cpmAmount(Number(r.plays), Number(r.rate_minor)) >= Number(r.budget_minor)));
  const fit = under.filter((r) => r.orientation === screen.orientation);
  return fit.length ? fit : under;
}

export async function player(key: string) {
  const s = await screenByKey(key);
  await S(() => query(`UPDATE ad_screen SET last_seen_at = now() WHERE id = $1`, [s.id]));
  const items = await playable(s);
  return {
    screen: s.name, orientation: s.orientation, refreshSeconds: 300,
    playlist: items.map((r) => ({ creativeId: String(r.id), campaignId: String(r.campaign_id), mime: r.mime, seconds: r.seconds, weight: r.weight, sha256: r.sha256,
      url: `/v1/ad-player/${key}/creatives/${r.id}` })),
  };
}

export async function playerFile(key: string, creativeId: string) {
  const s = await screenByKey(key);
  const k = await S(() => one<any>(`SELECT k.* FROM ad_creative k WHERE k.id = $1 AND k.org_id = $2 AND k.review = 'approved' AND k.removed_at IS NULL`, [Number(creativeId) || 0, s.org_id]));
  if (!k) throw new AdError(404, 'No such creative.');
  return { mime: k.mime as string, data: await readFile(k.path) };
}

/** The player reports plays: {plays: [{creativeId, count, day?}]}, day today or yesterday (local). */
export async function reportPlays(key: string, b: Record<string, unknown>) {
  const s = await screenByKey(key);
  const list = Array.isArray(b.plays) ? b.plays.slice(0, 200) as Array<Record<string, unknown>> : [];
  if (!list.length) throw new AdError(422, 'plays: [{creativeId, count}].');
  const today = localDay(), yesterday = localDay(new Date(Date.now() - 86_400_000));
  let counted = 0;
  await S(() => tx(async (c) => {
    for (const p of list) {
      const n = Number(p.count ?? 1);
      if (!Number.isInteger(n) || n < 1 || n > 2000) throw new AdError(422, 'count is 1 to 2000.');
      const day = p.day ? String(p.day) : today;
      if (day !== today && day !== yesterday) throw new AdError(422, 'day is today or yesterday.');
      const k = (await c.query(`SELECT id, campaign_id FROM ad_creative WHERE id = $1 AND org_id = $2 AND review = 'approved'`, [Number(p.creativeId) || 0, s.org_id])).rows[0];
      if (!k) continue;
      await c.query(`INSERT INTO ad_play (org_id, day, screen_id, creative_id, campaign_id, plays) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (day, screen_id, creative_id) DO UPDATE SET plays = ad_play.plays + EXCLUDED.plays, updated_at = now()`, [s.org_id, day, s.id, k.id, k.campaign_id, n]);
      counted += n;
    }
    await c.query(`UPDATE ad_screen SET last_seen_at = now() WHERE id = $1`, [s.id]);
  }));
  return { counted };
}

// ------------------------------------------------------------------ proof of play and invoices

export async function proofXlsx(orgId: string, campaignId: string) {
  const c = await campaign(orgId, campaignId);
  const rows = await S(() => many<any>(`SELECT to_char(p.day, 'YYYY-MM-DD') AS day, s.name AS site, sc.name AS screen, k.name AS creative, p.plays FROM ad_play p
    JOIN ad_screen sc ON sc.id = p.screen_id JOIN site s ON s.id = sc.site_id JOIN ad_creative k ON k.id = p.creative_id WHERE p.campaign_id = $1 ORDER BY p.day, s.name, sc.name`, [c.id]));
  return { name: `proof-of-play-${c.id}.xlsx`, data: xlsx([{ name: 'Proof of play', rows: [
    [`${c.advertiser} · ${c.name} · ${c.startsOn} to ${c.endsOn}`], [`Plays: ${c.plays} · charging sessions at its screens: ${c.sessionsAtScreens}`], [],
    ['Day', 'Site', 'Screen', 'Creative', 'Plays'], ...rows.map((r) => [r.day, r.site, r.screen, r.creative, Number(r.plays)]),
  ] }]) };
}

const invOf = (r: any) => ({
  id: String(r.id), advertiserId: String(r.advertiser_id), advertiser: r.advertiser_name ?? null, month: r.month, number: r.number ?? null, currency: r.currency, lines: r.lines ?? [],
  subtotalMinor: Number(r.subtotal_minor), taxBps: r.tax_bps, taxMinor: Number(r.tax_minor), totalMinor: Number(r.total_minor), status: r.status, reference: r.reference ?? null,
  issuedAt: r.issued_at ? new Date(r.issued_at).toISOString() : null, paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
});

/** The month's lines for an advertiser: CPM campaigns by their plays, flat ones by the days they ran. */
export async function linesFor(orgId: string, advertiserId: string, month: string) {
  if (!MONTH_RE.test(month)) throw new AdError(422, 'month is YYYY-MM.');
  const cs = await S(() => many<any>(`SELECT c.*, (SELECT COALESCE(sum(p.plays), 0) FROM ad_play p WHERE p.campaign_id = c.id AND to_char(p.day, 'YYYY-MM') = $3) AS plays
    FROM ad_campaign c WHERE c.org_id = $1 AND c.advertiser_id = $2 AND c.status <> 'draft' AND to_char(c.starts_on, 'YYYY-MM') <= $3 AND to_char(c.ends_on, 'YYYY-MM') >= $3 ORDER BY c.id`,
  [orgId, Number(advertiserId) || 0, month]));
  return cs.map((c) => {
    if (c.pricing === 'cpm') return { campaignId: String(c.id), campaign: c.name, pricing: 'cpm', plays: Number(c.plays), rateMinor: Number(c.rate_minor), amountMinor: cpmAmount(Number(c.plays), Number(c.rate_minor)) };
    const f = flatAmount(Number(c.rate_minor), month, d10(c.starts_on)!, d10(c.ends_on)!);
    return { campaignId: String(c.id), campaign: c.name, pricing: 'flat', plays: Number(c.plays), days: f.days, rateMinor: Number(c.rate_minor), amountMinor: f.amount };
  }).filter((l) => l.amountMinor > 0 || l.plays > 0);
}

export async function draftInvoice(orgId: string, advertiserId: string, month: string) {
  const lines = await linesFor(orgId, advertiserId, month);
  const st = await settings(orgId);
  const sub = lines.reduce((a, l) => a + l.amountMinor, 0);
  const tax = Math.round((sub * st.taxBps) / 10_000);
  const r = await S(() => one<any>(`INSERT INTO ad_invoice (org_id, advertiser_id, month, currency, lines, subtotal_minor, tax_bps, tax_minor, total_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (advertiser_id, month) DO UPDATE SET lines = $5, subtotal_minor = $6, tax_bps = $7, tax_minor = $8, total_minor = $9 WHERE ad_invoice.status = 'draft' RETURNING *`,
  [orgId, Number(advertiserId), month, st.currency, JSON.stringify(lines), sub, st.taxBps, tax, sub + tax]));
  return invOf(r ?? await S(() => one<any>(`SELECT * FROM ad_invoice WHERE advertiser_id = $1 AND month = $2`, [Number(advertiserId), month])));
}

export async function invoices(orgId: string) {
  return (await S(() => many<any>(`SELECT i.*, a.name AS advertiser_name FROM ad_invoice i JOIN ad_advertiser a ON a.id = i.advertiser_id WHERE i.org_id = $1 ORDER BY i.month DESC, a.name LIMIT 500`, [orgId]))).map(invOf);
}

/** issue (a draft, refreshed; gets its number), paid (an issued one, with a reference), void (not paid). */
export async function invoiceAct(orgId: string, id: string, b: Record<string, unknown>) {
  const r = await S(() => one<any>(`SELECT * FROM ad_invoice WHERE id = $1 AND org_id = $2`, [Number(id) || 0, orgId]));
  if (!r) throw new AdError(404, 'No such invoice.');
  const a = String(b.action ?? '');
  if (a === 'issue') {
    if (r.status !== 'draft') throw new AdError(409, 'Only a draft can be issued.');
    if (r.month >= localDay().slice(0, 7)) throw new AdError(409, 'A month is invoiced once it is over.');
    const d = await draftInvoice(orgId, String(r.advertiser_id), r.month);
    if (d.totalMinor <= 0) throw new AdError(409, 'Nothing to invoice for this month.');
    await S(() => tx(async (c) => {
      const n = (await c.query(`SELECT count(*) + 1 AS n FROM ad_invoice WHERE org_id = $1 AND number IS NOT NULL AND month = $2`, [orgId, r.month])).rows[0].n;
      await c.query(`UPDATE ad_invoice SET status = 'issued', issued_at = now(), number = $2 WHERE id = $1`, [r.id, `ADV-${r.month.replace('-', '')}-${String(n).padStart(3, '0')}`]);
    }));
  } else if (a === 'paid') {
    if (r.status !== 'issued') throw new AdError(409, 'Only an issued invoice can be marked paid.');
    const ref = str(b.reference, 80);
    if (!ref) throw new AdError(422, 'The payment\'s reference is required.');
    await S(() => query(`UPDATE ad_invoice SET status = 'paid', paid_at = now(), reference = $2 WHERE id = $1`, [r.id, ref]));
  } else if (a === 'void') {
    if (r.status === 'paid') throw new AdError(409, 'A paid invoice cannot be voided.');
    await S(() => query(`UPDATE ad_invoice SET status = 'void', reference = $2 WHERE id = $1`, [r.id, str(b.reference, 80)]));
  } else throw new AdError(422, 'action is issue, paid or void.');
  return invOf(await S(() => one<any>(`SELECT i.*, a.name AS advertiser_name FROM ad_invoice i JOIN ad_advertiser a ON a.id = i.advertiser_id WHERE i.id = $1`, [r.id])));
}

export async function invoiceXlsx(orgId: string, id: string) {
  const r = await S(() => one<any>(`SELECT i.*, a.name AS advertiser_name, a.tax_id, a.address FROM ad_invoice i JOIN ad_advertiser a ON a.id = i.advertiser_id WHERE i.id = $1 AND i.org_id = $2`, [Number(id) || 0, orgId]));
  if (!r) throw new AdError(404, 'No such invoice.');
  const i = invOf(r);
  return { name: `${i.number ?? `ad-invoice-${i.id}`}.xlsx`, data: xlsx([{ name: 'Invoice', rows: [
    [`${i.number ?? 'Draft'} · ${i.advertiser} · ${i.month}`], [r.tax_id ? `Tax id ${r.tax_id}` : ''], [r.address ?? ''], [],
    ['Campaign', 'Pricing', 'Plays', 'Days', `Rate (${i.currency})`, `Amount (${i.currency})`],
    ...i.lines.map((l: any) => [l.campaign, l.pricing === 'cpm' ? 'per 1,000 plays' : 'flat per month', l.plays, l.days ?? '', l.rateMinor, l.amountMinor]),
    [], ['Subtotal', '', '', '', '', i.subtotalMinor], [`Tax ${(i.taxBps / 100).toFixed(2)} %`, '', '', '', '', i.taxMinor], ['Total', '', '', '', '', i.totalMinor],
  ] }]) };
}

// ------------------------------------------------------------------ the worker

/** End campaigns past their dates; pause CPM campaigns whose budget is spent; draft last month's invoices. */
export async function sweep(): Promise<{ ended: number; paused: number; drafted: number }> {
  const today = localDay();
  const ended = await S(() => many<any>(`UPDATE ad_campaign SET status = 'ended' WHERE status IN ('active', 'paused') AND ends_on < $1::date RETURNING id`, [today]));
  const over = await S(() => many<any>(`SELECT c.id, c.rate_minor, c.budget_minor, (SELECT COALESCE(sum(p.plays), 0) FROM ad_play p WHERE p.campaign_id = c.id) AS plays
    FROM ad_campaign c WHERE c.status = 'active' AND c.pricing = 'cpm' AND c.budget_minor IS NOT NULL`));
  let paused = 0;
  for (const c of over) {
    if (cpmAmount(Number(c.plays), Number(c.rate_minor)) >= Number(c.budget_minor)) {
      await S(() => query(`UPDATE ad_campaign SET status = 'paused', paused_reason = 'Budget spent' WHERE id = $1 AND status = 'active'`, [c.id]));
      paused++;
    }
  }
  const m = lastMonth();
  const advs = await S(() => many<any>(`SELECT DISTINCT c.org_id, c.advertiser_id FROM ad_campaign c WHERE c.status <> 'draft' AND to_char(c.starts_on, 'YYYY-MM') <= $1 AND to_char(c.ends_on, 'YYYY-MM') >= $1
    AND NOT EXISTS (SELECT 1 FROM ad_invoice i WHERE i.advertiser_id = c.advertiser_id AND i.month = $1 AND i.status <> 'draft')`, [m]));
  for (const a of advs) await draftInvoice(a.org_id, String(a.advertiser_id), m).catch(() => null);
  return { ended: ended.length, paused, drafted: advs.length };
}
