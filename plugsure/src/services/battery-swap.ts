import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { many, one, outsideRequestScope, query, tx } from '../db/pool.js';
import { persistAlert } from './alerts.js';
import * as credit from './driver-credit.js';

/**
 * Two-wheeler battery swap (v1.49.0), Assets & energy → Battery swap. Electric motorbike riders swap a flat pack for a
 * charged one at a cabinet:
 *
 *   cabinets   at a site, with its slots; the cabinet's controller posts to its own address with its key: the slots'
 *              status (each pack's serial, charge, health, temperature, fault), an authorisation before it opens a
 *              door, and each swap done (idempotent by the cabinet's reference)
 *   packs      every battery pack: in a cabinet (charging or ready), with a rider, in maintenance or retired; its
 *              charge, health and cycles. Packs below the retirement health are flagged
 *   riders     subscribe in the app to a plan (a monthly fee with swaps included, or unlimited; a plan of 0 with none
 *              included is pay per swap). The app shows the rider's code as a QR code; the cabinet reads it
 *   paying     a swap within the plan is included; beyond it, or without one, it costs the price per swap, paid from
 *              the rider's credit (Commercial → Driver credit). Not enough credit: the swap is refused. The monthly
 *              fee is paid from credit too, at subscribing and at each renewal (a lapsed plan stops swaps)
 *   alerts     swap.cabinet_offline (no word from an active cabinet for 15 minutes); swap.battery_attention (a pack
 *              reporting a fault, or below the retirement health)
 */

export class SwapError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const OFFLINE_ALERT = 'swap.cabinet_offline';
export const PACK_ALERT = 'swap.battery_attention';
const S = <T>(fn: () => T) => outsideRequestScope(fn);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
const pct = (v: unknown) => { const n = num(v); return n != null && Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 10) / 10 : null; };
const str = (v: unknown, max: number) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
/** A DATE column as YYYY-MM-DD: node-postgres parses DATE as local midnight, so read the local parts (toISOString would shift it a day east of UTC). */
const ymd = (v: any) => (v == null ? null : typeof v === 'string' ? v.slice(0, 10) : v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10)) as string;
const today = () => new Date().toISOString().slice(0, 10);
const addMonth = (d: string) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); return x.toISOString().slice(0, 10); };

// ------------------------------------------------------------------ settings

export async function settings(orgId: string) {
  const r = await S(() => one<any>(`SELECT * FROM swap_settings WHERE org_id = $1`, [orgId]));
  const currency = r?.currency ?? (await credit.settings(orgId)).currency;
  return { enabled: !!r?.enabled, currency, pricePerSwapMinor: Number(r?.price_per_swap_minor ?? 0), minSocOut: Number(r?.min_soc_out ?? 90), retireSoh: Number(r?.retire_soh ?? 70) };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>) {
  const cur = await settings(orgId);
  const price = b.pricePerSwapMinor === undefined ? cur.pricePerSwapMinor : Number(b.pricePerSwapMinor);
  if (!Number.isSafeInteger(price) || price < 0) throw new SwapError(422, 'pricePerSwapMinor is a whole amount, 0 or more.');
  const minSoc = b.minSocOut === undefined ? cur.minSocOut : Number(b.minSocOut);
  if (!Number.isInteger(minSoc) || minSoc < 50 || minSoc > 100) throw new SwapError(422, 'minSocOut is 50 to 100.');
  const retire = b.retireSoh === undefined ? cur.retireSoh : Number(b.retireSoh);
  if (!Number.isInteger(retire) || retire < 40 || retire > 95) throw new SwapError(422, 'retireSoh is 40 to 95.');
  const enabled = b.enabled === undefined ? cur.enabled : b.enabled === true;
  await S(() => query(`INSERT INTO swap_settings (org_id, enabled, currency, price_per_swap_minor, min_soc_out, retire_soh) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (org_id) DO UPDATE SET enabled = $2, price_per_swap_minor = $4, min_soc_out = $5, retire_soh = $6, updated_at = now()`, [orgId, enabled, cur.currency, price, minSoc, retire]));
  return settings(orgId);
}

// ------------------------------------------------------------------ cabinets

const cabOf = (c: any, minSoc: number) => ({
  id: String(c.id), code: c.code, name: c.name, siteId: c.site_id, site: c.site_name ?? null, slots: c.slots, status: c.status,
  keyPrefix: c.key_prefix ?? null, lastSeenAt: c.last_seen_at ? new Date(c.last_seen_at).toISOString() : null,
  online: !!c.last_seen_at && Date.now() - new Date(c.last_seen_at).getTime() < 15 * 60_000,
  packs: Number(c.packs ?? 0), ready: Number(c.ready ?? 0), charging: Math.max(0, Number(c.packs ?? 0) - Number(c.ready ?? 0)), minSocOut: minSoc,
  swaps24h: Number(c.swaps24h ?? 0),
});
const CAB_SELECT = (minSocParam: string) => `SELECT c.*, s.name AS site_name,
    (SELECT count(*) FROM swap_battery b WHERE b.cabinet_id = c.id AND b.status = 'in_cabinet') AS packs,
    (SELECT count(*) FROM swap_battery b WHERE b.cabinet_id = c.id AND b.status = 'in_cabinet' AND b.fault IS NULL AND b.soc >= ${minSocParam}) AS ready,
    (SELECT count(*) FROM swap_event e WHERE e.cabinet_id = c.id AND e.outcome <> 'refused' AND e.at > now() - interval '24 hours') AS swaps24h
  FROM swap_cabinet c JOIN site s ON s.id = c.site_id`;

export async function cabinets(orgId: string) {
  const st = await settings(orgId);
  return (await S(() => many<any>(`${CAB_SELECT('$2')} WHERE c.org_id = $1 AND c.status <> 'archived' ORDER BY s.name, c.code`, [orgId, st.minSocOut]))).map((c) => cabOf(c, st.minSocOut));
}

export async function saveCabinet(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await S(() => one<any>(`SELECT * FROM swap_cabinet WHERE id = $1 AND org_id = $2`, [Number(id) || 0, orgId])) : null;
  if (id && !cur) throw new SwapError(404, 'No such cabinet.');
  if (cur && b.archive === true) {
    await S(() => query(`UPDATE swap_cabinet SET status = 'archived', key_hash = NULL WHERE id = $1`, [cur.id]));
    return { id: String(cur.id), archived: true };
  }
  const siteId = String(b.siteId ?? cur?.site_id ?? '');
  if (!UUID_RE.test(siteId) || !(await S(() => one(`SELECT 1 FROM site WHERE id = $1 AND org_id = $2`, [siteId, orgId])))) throw new SwapError(422, 'Choose the site.');
  const code = str(b.code ?? cur?.code, 30)?.toUpperCase();
  if (!code || !/^[A-Z0-9-]{2,30}$/.test(code)) throw new SwapError(422, 'The code is 2 to 30 letters, digits or dashes.');
  const name = str(b.name ?? cur?.name, 120);
  if (!name) throw new SwapError(422, 'A name is required.');
  const slots = Number(b.slots ?? cur?.slots);
  if (!Number.isInteger(slots) || slots < 1 || slots > 60) throw new SwapError(422, 'Slots is 1 to 60.');
  const status = b.status === undefined ? (cur?.status ?? 'active') : String(b.status);
  if (!['active', 'maintenance'].includes(status)) throw new SwapError(422, 'status is active or maintenance.');
  let r: any;
  try {
    r = cur
      ? await S(() => one<any>(`UPDATE swap_cabinet SET site_id = $2, code = $3, name = $4, slots = $5, status = $6 WHERE id = $1 RETURNING *`, [cur.id, siteId, code, name, slots, status]))
      : await S(() => one<any>(`INSERT INTO swap_cabinet (org_id, site_id, code, name, slots, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [orgId, siteId, code, name, slots, status]));
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new SwapError(409, `There is already a cabinet ${code}.`);
    throw e;
  }
  let key: string | undefined;
  if (!r.key_hash || b.rotateKey === true) {
    key = `swk_${randomBytes(24).toString('base64url')}`;
    await S(() => query(`UPDATE swap_cabinet SET key_hash = $2, key_prefix = $3 WHERE id = $1`, [r.id, sha(key!), key!.slice(0, 8)]));
  }
  return { id: String(r.id), code: r.code, ...(key ? { key } : {}) };
}

// ------------------------------------------------------------------ packs

const packOf = (b: any, retire: number) => ({
  id: String(b.id), serial: b.serial, model: b.model ?? null, capacityWh: b.capacity_wh ?? null, status: b.status,
  cabinetId: b.cabinet_id == null ? null : String(b.cabinet_id), cabinet: b.cabinet_code ?? null, slot: b.slot ?? null,
  rider: b.rider_phone ? `…${String(b.rider_phone).slice(-4)}` : null,
  soc: num(b.soc), soh: num(b.soh), tempC: num(b.temp_c), cycles: b.cycles, fault: b.fault ?? null,
  attention: !!b.fault || (b.soh != null && Number(b.soh) < retire), updatedAt: new Date(b.updated_at).toISOString(),
});

export async function batteries(orgId: string, q: Record<string, unknown> = {}) {
  const st = await settings(orgId);
  const status = q.status ? String(q.status) : null;
  const rows = await S(() => many<any>(`SELECT b.*, c.code AS cabinet_code, d.phone AS rider_phone FROM swap_battery b
      LEFT JOIN swap_cabinet c ON c.id = b.cabinet_id LEFT JOIN app_driver d ON d.id = b.rider_id
     WHERE b.org_id = $1 AND ($2::text IS NULL OR b.status = $2) AND ($3 OR b.status <> 'retired')
     ORDER BY (b.fault IS NOT NULL) DESC, b.soh NULLS LAST, b.serial LIMIT 2000`, [orgId, status, status === 'retired']));
  const packs = rows.map((b) => packOf(b, st.retireSoh));
  const byStatus = (await S(() => many<any>(`SELECT status, count(*) AS n FROM swap_battery WHERE org_id = $1 GROUP BY status`, [orgId])))
    .reduce((a: Record<string, number>, r) => ({ ...a, [r.status]: Number(r.n) }), { in_cabinet: 0, with_rider: 0, maintenance: 0, retired: 0 });
  return { packs, byStatus, retireSoh: st.retireSoh };
}

export async function saveBattery(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await S(() => one<any>(`SELECT * FROM swap_battery WHERE id = $1 AND org_id = $2`, [Number(id) || 0, orgId])) : null;
  if (id && !cur) throw new SwapError(404, 'No such battery pack.');
  if (cur) {
    const status = b.status === undefined ? cur.status : String(b.status);
    if (!['in_cabinet', 'with_rider', 'maintenance', 'retired'].includes(status)) throw new SwapError(422, 'Unknown status.');
    if (status !== cur.status && !['maintenance', 'retired'].includes(status) && !(cur.status === 'maintenance' && status === 'in_cabinet')) {
      throw new SwapError(409, 'A pack goes into a cabinet or to a rider by being swapped; here it can only go to maintenance, be retired, or come back from maintenance.');
    }
    const r = await S(() => one<any>(`UPDATE swap_battery SET status = $2, model = $3, capacity_wh = $4, fault = $5,
        cabinet_id = CASE WHEN $2 IN ('maintenance', 'retired') THEN NULL ELSE cabinet_id END, slot = CASE WHEN $2 IN ('maintenance', 'retired') THEN NULL ELSE slot END,
        rider_id = CASE WHEN $2 IN ('maintenance', 'retired') THEN NULL ELSE rider_id END, updated_at = now() WHERE id = $1 RETURNING *`,
      [cur.id, status, b.model === undefined ? cur.model : str(b.model, 60), b.capacityWh === undefined ? cur.capacity_wh : num(b.capacityWh), b.fault === undefined ? (status === 'retired' ? null : cur.fault) : str(b.fault, 200)]));
    return packOf(r, (await settings(orgId)).retireSoh);
  }
  const serial = str(b.serial, 60);
  if (!serial) throw new SwapError(422, 'The serial number is required.');
  const cap = num(b.capacityWh);
  if (cap != null && !(Number.isInteger(cap) && cap > 0 && cap < 20_000)) throw new SwapError(422, 'capacityWh is a whole number of watt-hours.');
  try {
    const r = await S(() => one<any>(`INSERT INTO swap_battery (org_id, serial, model, capacity_wh, status) VALUES ($1,$2,$3,$4,'maintenance') RETURNING *`, [orgId, serial, str(b.model, 60), cap]));
    return packOf(r, (await settings(orgId)).retireSoh);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new SwapError(409, `Pack ${serial} is already registered.`);
    throw e;
  }
}

// ------------------------------------------------------------------ plans and riders

const planOf = (p: any) => ({ id: String(p.id), name: p.name, monthlyMinor: Number(p.monthly_minor), swapsIncluded: p.swaps_included ?? null, currency: p.currency,
  archived: !!p.archived_at, subscribers: Number(p.subscribers ?? 0) });

export async function plans(orgId: string, all = true) {
  return (await S(() => many<any>(`SELECT p.*, (SELECT count(*) FROM swap_subscription s WHERE s.plan_id = p.id AND s.status = 'active') AS subscribers
      FROM swap_plan p WHERE p.org_id = $1 AND ($2 OR p.archived_at IS NULL) ORDER BY p.archived_at NULLS FIRST, p.monthly_minor`, [orgId, all]))).map(planOf);
}

export async function savePlan(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await S(() => one<any>(`SELECT * FROM swap_plan WHERE id = $1 AND org_id = $2`, [Number(id) || 0, orgId])) : null;
  if (id && !cur) throw new SwapError(404, 'No such plan.');
  if (cur && b.archive === true) { await S(() => query(`UPDATE swap_plan SET archived_at = now() WHERE id = $1`, [cur.id])); return { id: String(cur.id), archived: true }; }
  const name = str(b.name ?? cur?.name, 80);
  if (!name) throw new SwapError(422, 'A name is required.');
  const monthly = Number(b.monthlyMinor ?? cur?.monthly_minor);
  if (!Number.isSafeInteger(monthly) || monthly < 0) throw new SwapError(422, 'monthlyMinor is a whole amount, 0 or more.');
  const inc = b.swapsIncluded === undefined ? (cur ? cur.swaps_included : null) : b.swapsIncluded === null || b.swapsIncluded === '' ? null : Number(b.swapsIncluded);
  if (inc != null && !(Number.isInteger(inc) && inc >= 0 && inc <= 10_000)) throw new SwapError(422, 'swapsIncluded is a whole number, or empty for unlimited.');
  const { currency } = await settings(orgId);
  const r = cur
    ? await S(() => one<any>(`UPDATE swap_plan SET name = $2, monthly_minor = $3, swaps_included = $4 WHERE id = $1 RETURNING *`, [cur.id, name, monthly, inc]))
    : await S(() => one<any>(`INSERT INTO swap_plan (org_id, name, monthly_minor, swaps_included, currency) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [orgId, name, monthly, inc, currency]));
  return planOf(r);
}

async function usedThisPeriod(subId: string | number, from: string): Promise<number> {
  const r = await S(() => one<any>(`SELECT count(*) AS n FROM swap_event WHERE subscription_id = $1 AND outcome = 'included' AND at >= $2::date`, [subId, from]));
  return Number(r?.n ?? 0);
}

export async function riders(orgId: string) {
  const rows = await S(() => many<any>(`SELECT s.*, p.name AS plan_name, p.swaps_included, d.phone, d.name AS display_name,
      (SELECT count(*) FROM swap_event e WHERE e.subscription_id = s.id AND e.outcome <> 'refused' AND e.at >= s.period_start) AS swaps,
      (SELECT b.serial FROM swap_battery b WHERE b.rider_id = s.app_driver_id AND b.status = 'with_rider' LIMIT 1) AS pack
    FROM swap_subscription s JOIN swap_plan p ON p.id = s.plan_id JOIN app_driver d ON d.id = s.app_driver_id
    WHERE s.org_id = $1 AND (s.status = 'active' OR s.created_at > now() - interval '90 days') ORDER BY s.status, s.created_at DESC LIMIT 1000`, [orgId]));
  return rows.map((s) => ({
    id: String(s.id), rider: s.display_name ?? null, phone: s.phone ? `…${String(s.phone).slice(-4)}` : null, plan: s.plan_name, status: s.status,
    periodStart: ymd(s.period_start), periodEnd: ymd(s.period_end),
    swaps: Number(s.swaps), swapsIncluded: s.swaps_included ?? null, pack: s.pack ?? null,
  }));
}

/** Pay `amountMinor` in full from the driver's credit, or nothing. */
async function payFromCredit(orgId: string, appDriverId: string, currency: string, amountMinor: number): Promise<boolean> {
  if (amountMinor <= 0) return true;
  const bal = await credit.balance(orgId, appDriverId, currency);
  if (bal.totalMinor < amountMinor) return false;
  const ref = randomUUID();
  const h = await credit.hold(orgId, appDriverId, currency, amountMinor, ref);
  if (h.heldMinor < amountMinor) { await credit.settle(ref, 0); return false; }
  await credit.settle(ref, amountMinor);
  return true;
}

// ------------------------------------------------------------------ the cabinet's API

async function cabinetByKey(key: string) {
  const c = key.startsWith('swk_') ? await S(() => one<any>(`SELECT * FROM swap_cabinet WHERE key_hash = $1 AND status <> 'archived'`, [sha(key)])) : null;
  if (!c) throw new SwapError(401, 'Unknown cabinet key.');
  await S(() => query(`UPDATE swap_cabinet SET last_seen_at = now() WHERE id = $1`, [c.id]));
  return c;
}

async function riderFor(orgId: string, code: unknown) {
  const rc = String(code ?? '').trim().toUpperCase();
  if (!/^SWP-[A-Z0-9]{6,20}$/.test(rc)) return null;
  return S(() => one<any>(`SELECT s.*, p.swaps_included, p.name AS plan_name FROM swap_subscription s JOIN swap_plan p ON p.id = s.plan_id
    WHERE s.rider_code = $1 AND s.org_id = $2`, [rc, orgId]));
}

/** What a swap by this rider would cost now: included, a price from credit, or refused (with why). */
async function decide(orgId: string, sub: any | null) {
  const st = await settings(orgId);
  if (!st.enabled) return { outcome: 'refused' as const, amountMinor: 0, reason: 'Battery swap is not enabled.' };
  if (!sub) return { outcome: 'refused' as const, amountMinor: 0, reason: 'Unknown rider code.' };
  if (sub.status !== 'active' || ymd(sub.period_end) < today()) return { outcome: 'refused' as const, amountMinor: 0, reason: 'The rider\'s plan is not active.' };
  const from = ymd(sub.period_start);
  if (sub.swaps_included == null || (await usedThisPeriod(sub.id, from)) < Number(sub.swaps_included)) return { outcome: 'included' as const, amountMinor: 0, reason: null };
  const bal = await credit.balance(orgId, sub.app_driver_id, st.currency);
  if (bal.totalMinor < st.pricePerSwapMinor) return { outcome: 'refused' as const, amountMinor: st.pricePerSwapMinor, reason: 'Not enough credit for a swap.' };
  return { outcome: 'paid' as const, amountMinor: st.pricePerSwapMinor, reason: null };
}

async function packAt(c: any, orgId: string, slot: Record<string, unknown>) {
  const serial = str(slot.serial, 60);
  if (!serial) return null;
  return S(() => one<any>(`INSERT INTO swap_battery (org_id, serial, status, cabinet_id, slot) VALUES ($1,$2,'in_cabinet',$3,$4)
    ON CONFLICT (org_id, serial) DO UPDATE SET serial = EXCLUDED.serial RETURNING *`, [orgId, serial, c.id, num(slot.slot)]));
}

/**
 * POST /v1/swap/cabinets/:key — the cabinet's controller:
 *   {type: "status", slots: [{slot, serial, soc, soh, tempC, fault}]}   the packs in its slots (empty slots omitted)
 *   {type: "authorize", riderCode}                                      before opening a door: may this rider swap?
 *   {type: "swap", reference, riderCode, batteryIn: {serial, soc}, batteryOut: {serial, soc, slot}}   a swap done
 */
export async function cabinetEvent(key: string, b: Record<string, unknown>) {
  const c = await cabinetByKey(key);
  const orgId = c.org_id as string;
  const st = await settings(orgId);
  if (b.type === 'status') {
    const slots = Array.isArray(b.slots) ? b.slots.slice(0, c.slots) as Array<Record<string, unknown>> : [];
    const seen: string[] = [];
    for (const s of slots) {
      const p = await packAt(c, orgId, s);
      if (!p || p.status === 'retired') continue;
      seen.push(String(p.id));
      const fault = str(s.fault, 200);
      await S(() => query(`UPDATE swap_battery SET status = CASE WHEN status = 'maintenance' THEN status ELSE 'in_cabinet' END, cabinet_id = $2, slot = $3, rider_id = NULL,
          soc = COALESCE($4, soc), soh = COALESCE($5, soh), temp_c = $6, fault = $7, updated_at = now() WHERE id = $1`, [p.id, c.id, num(s.slot), pct(s.soc), pct(s.soh), num(s.tempC), fault]));
      if (fault || (pct(s.soh) != null && pct(s.soh)! < st.retireSoh)) {
        await S(() => persistAlert({ orgId, kind: PACK_ALERT, severity: 'warning', targetType: 'swap_battery', targetId: String(p.id),
          message: fault ? `Pack ${p.serial} in cabinet ${c.code} reports a fault: ${fault}.` : `Pack ${p.serial} is at ${pct(s.soh)} % health, below ${st.retireSoh} %: retire it.` } as any)).catch(() => null);
      }
    }
    // Packs the cabinet no longer reports were taken out by hand.
    await S(() => query(`UPDATE swap_battery SET status = 'maintenance', cabinet_id = NULL, slot = NULL, updated_at = now()
      WHERE cabinet_id = $1 AND status = 'in_cabinet' AND NOT (id::text = ANY($2::text[]))`, [c.id, seen]));
    await S(() => query(`UPDATE alert SET resolved_at = now() WHERE org_id = $1 AND kind = $2 AND target_type = 'swap_cabinet' AND target_id = $3 AND resolved_at IS NULL`, [orgId, OFFLINE_ALERT, String(c.id)]));
    return { ok: true, packs: seen.length };
  }
  if (b.type === 'authorize') {
    const sub = await riderFor(orgId, b.riderCode);
    const d = await decide(orgId, sub);
    const ready = await S(() => one<any>(`SELECT count(*) AS n FROM swap_battery WHERE cabinet_id = $1 AND status = 'in_cabinet' AND fault IS NULL AND soc >= $2`, [c.id, st.minSocOut]));
    const allowed = d.outcome !== 'refused' && Number(ready?.n ?? 0) > 0;
    return { allowed, outcome: allowed ? d.outcome : 'refused', amountMinor: d.amountMinor, currency: st.currency, reason: allowed ? null : d.reason ?? 'No charged pack is ready.', readyPacks: Number(ready?.n ?? 0) };
  }
  if (b.type === 'swap') {
    const reference = str(b.reference, 80);
    if (!reference) throw new SwapError(422, 'reference is required (the cabinet\'s own id for the swap).');
    const again = await S(() => one<any>(`SELECT * FROM swap_event WHERE cabinet_id = $1 AND reference = $2`, [c.id, reference]));
    if (again) return { id: String(again.id), outcome: again.outcome, amountMinor: Number(again.amount_minor), reason: again.reason, repeated: true };
    const sub = await riderFor(orgId, b.riderCode);
    const d = await decide(orgId, sub);
    let outcome = d.outcome, reason = d.reason;
    if (outcome === 'paid' && !(await payFromCredit(orgId, sub.app_driver_id, st.currency, d.amountMinor))) { outcome = 'refused'; reason = 'Not enough credit for a swap.'; }
    const bi = (b.batteryIn ?? {}) as Record<string, unknown>, bo = (b.batteryOut ?? {}) as Record<string, unknown>;
    return S(() => tx(async (x) => {
      const pin = str(bi.serial, 60) ? (await x.query(`INSERT INTO swap_battery (org_id, serial, status) VALUES ($1,$2,'in_cabinet') ON CONFLICT (org_id, serial) DO UPDATE SET serial = EXCLUDED.serial RETURNING *`, [orgId, str(bi.serial, 60)])).rows[0] : null;
      const pout = str(bo.serial, 60) ? (await x.query(`INSERT INTO swap_battery (org_id, serial, status) VALUES ($1,$2,'in_cabinet') ON CONFLICT (org_id, serial) DO UPDATE SET serial = EXCLUDED.serial RETURNING *`, [orgId, str(bo.serial, 60)])).rows[0] : null;
      const socIn = pct(bi.soc), socOut = pct(bo.soc);
      const capWh = pout?.capacity_wh ?? pin?.capacity_wh ?? null;
      const kwh = outcome !== 'refused' && socIn != null && socOut != null && capWh ? Math.max(0, Math.round(((socOut - socIn) / 100) * (capWh / 1000) * 1000) / 1000) : null;
      const ev = (await x.query(`INSERT INTO swap_event (org_id, cabinet_id, app_driver_id, subscription_id, reference, battery_in_id, battery_out_id, soc_in, soc_out, kwh, outcome, amount_minor, currency, reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [orgId, c.id, sub?.app_driver_id ?? null, sub?.id ?? null, reference, pin?.id ?? null, pout?.id ?? null, socIn, socOut, kwh, outcome,
        outcome === 'paid' ? d.amountMinor : 0, st.currency, reason])).rows[0];
      if (outcome !== 'refused') {
        if (pin) await x.query(`UPDATE swap_battery SET status = 'in_cabinet', cabinet_id = $2, slot = $3, rider_id = NULL, soc = COALESCE($4, soc), cycles = cycles + 1, updated_at = now() WHERE id = $1`, [pin.id, c.id, num(bi.slot), socIn]);
        if (pout) await x.query(`UPDATE swap_battery SET status = 'with_rider', cabinet_id = NULL, slot = NULL, rider_id = $2, soc = COALESCE($3, soc), updated_at = now() WHERE id = $1`, [pout.id, sub.app_driver_id, socOut]);
      }
      return { id: String(ev.id), outcome, amountMinor: outcome === 'paid' ? d.amountMinor : 0, currency: st.currency, reason, kwh };
    }));
  }
  throw new SwapError(422, 'type is status, authorize or swap.');
}

// ------------------------------------------------------------------ overview and the log

export async function overview(orgId: string) {
  const st = await settings(orgId);
  const k = await S(() => one<any>(`SELECT
      count(*) FILTER (WHERE outcome <> 'refused' AND at > now() - interval '24 hours') AS d1,
      count(*) FILTER (WHERE outcome <> 'refused' AND at > now() - interval '30 days') AS d30,
      count(*) FILTER (WHERE outcome = 'refused' AND at > now() - interval '30 days') AS refused30,
      COALESCE(sum(amount_minor) FILTER (WHERE at > now() - interval '30 days'), 0) AS paid30,
      COALESCE(sum(kwh) FILTER (WHERE at > now() - interval '30 days'), 0) AS kwh30
    FROM swap_event WHERE org_id = $1`, [orgId]));
  const subs = await S(() => one<any>(`SELECT count(*) AS n, COALESCE(sum(p.monthly_minor), 0) AS mrr FROM swap_subscription s JOIN swap_plan p ON p.id = s.plan_id WHERE s.org_id = $1 AND s.status = 'active'`, [orgId]));
  const packs = await batteries(orgId);
  return {
    settings: st, cabinets: await cabinets(orgId),
    kpis: { swaps24h: Number(k?.d1 ?? 0), swaps30d: Number(k?.d30 ?? 0), refused30d: Number(k?.refused30 ?? 0), paid30dMinor: Number(k?.paid30 ?? 0), kwh30d: Number(k?.kwh30 ?? 0),
      riders: Number(subs?.n ?? 0), monthlyFeesMinor: Number(subs?.mrr ?? 0), packs: packs.byStatus, attention: packs.packs.filter((p) => p.attention).length },
  };
}

export async function events(orgId: string, q: Record<string, unknown> = {}) {
  const rows = await S(() => many<any>(`SELECT e.*, c.code AS cabinet_code, bi.serial AS in_serial, bo.serial AS out_serial, d.phone FROM swap_event e
      JOIN swap_cabinet c ON c.id = e.cabinet_id LEFT JOIN swap_battery bi ON bi.id = e.battery_in_id LEFT JOIN swap_battery bo ON bo.id = e.battery_out_id
      LEFT JOIN app_driver d ON d.id = e.app_driver_id
     WHERE e.org_id = $1 AND ($2::bigint IS NULL OR e.cabinet_id = $2) ORDER BY e.at DESC LIMIT 500`, [orgId, q.cabinetId ? Number(q.cabinetId) || 0 : null]));
  return rows.map((e) => ({
    id: String(e.id), at: new Date(e.at).toISOString(), cabinet: e.cabinet_code, rider: e.phone ? `…${String(e.phone).slice(-4)}` : null,
    packIn: e.in_serial ?? null, packOut: e.out_serial ?? null, socIn: num(e.soc_in), socOut: num(e.soc_out), kwh: num(e.kwh),
    outcome: e.outcome, amountMinor: Number(e.amount_minor), currency: e.currency, reason: e.reason ?? null,
  }));
}

// ------------------------------------------------------------------ the rider (driver app)

/** The org whose swap network the app offers: the brand's, else the one operator with swap enabled. */
export async function orgForApp(brandOrg: string | null): Promise<string | null> {
  if (brandOrg) return brandOrg;
  const r = await S(() => many<any>(`SELECT org_id FROM swap_settings WHERE enabled LIMIT 2`));
  return r.length === 1 ? r[0].org_id : null;
}

export async function driverSwap(appDriverId: string, brandOrg: string | null) {
  const orgId = await orgForApp(brandOrg);
  if (!orgId || !(await settings(orgId)).enabled) return { enabled: false };
  const st = await settings(orgId);
  const sub = await S(() => one<any>(`SELECT s.*, p.name AS plan_name, p.swaps_included, p.monthly_minor FROM swap_subscription s JOIN swap_plan p ON p.id = s.plan_id
    WHERE s.org_id = $1 AND s.app_driver_id = $2 AND s.status = 'active'`, [orgId, appDriverId]));
  const from = sub ? ymd(sub.period_start) : null;
  const pack = await S(() => one<any>(`SELECT serial, soc FROM swap_battery WHERE org_id = $1 AND rider_id = $2 AND status = 'with_rider' LIMIT 1`, [orgId, appDriverId]));
  const cabs = (await cabinets(orgId)).filter((c) => c.status === 'active').map((c) => ({ id: c.id, name: c.name, site: c.site, ready: c.ready, online: c.online }));
  const recent = (await S(() => many<any>(`SELECT e.at, e.outcome, e.amount_minor, c.name AS cab FROM swap_event e JOIN swap_cabinet c ON c.id = e.cabinet_id
    WHERE e.org_id = $1 AND e.app_driver_id = $2 ORDER BY e.at DESC LIMIT 10`, [orgId, appDriverId]))).map((e) => ({ at: new Date(e.at).toISOString(), cabinet: e.cab, outcome: e.outcome, amountMinor: Number(e.amount_minor) }));
  return {
    enabled: true, currency: st.currency, pricePerSwapMinor: st.pricePerSwapMinor,
    plans: (await plans(orgId, false)).map((p) => ({ id: p.id, name: p.name, monthlyMinor: p.monthlyMinor, swapsIncluded: p.swapsIncluded })),
    subscription: sub ? { id: String(sub.id), plan: sub.plan_name, riderCode: sub.rider_code, periodEnd: ymd(sub.period_end),
      swapsIncluded: sub.swaps_included ?? null, swapsUsed: await usedThisPeriod(sub.id, from!) } : null,
    pack: pack ? { serial: pack.serial, soc: num(pack.soc) } : null,
    balanceMinor: (await credit.balance(orgId, appDriverId, st.currency)).totalMinor, cabinets: cabs, recent,
  };
}

export async function subscribe(appDriverId: string, brandOrg: string | null, b: Record<string, unknown>) {
  const orgId = await orgForApp(brandOrg);
  if (!orgId || !(await settings(orgId)).enabled) throw new SwapError(404, 'Tukar baterai tidak tersedia.');
  if (b.cancel === true) {
    await S(() => query(`UPDATE swap_subscription SET status = 'cancelled' WHERE org_id = $1 AND app_driver_id = $2 AND status = 'active'`, [orgId, appDriverId]));
    return driverSwap(appDriverId, brandOrg);
  }
  const plan = await S(() => one<any>(`SELECT * FROM swap_plan WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [Number(b.planId) || 0, orgId]));
  if (!plan) throw new SwapError(422, 'Paket tidak ditemukan.');
  if (await S(() => one(`SELECT 1 FROM swap_subscription WHERE org_id = $1 AND app_driver_id = $2 AND status = 'active'`, [orgId, appDriverId]))) throw new SwapError(409, 'Anda sudah berlangganan. Batalkan dulu untuk ganti paket.');
  if (!(await payFromCredit(orgId, appDriverId, plan.currency, Number(plan.monthly_minor)))) throw new SwapError(402, 'Saldo kredit tidak cukup untuk biaya bulanan paket ini.');
  const code = `SWP-${randomBytes(6).toString('hex').toUpperCase()}`;
  await S(() => query(`INSERT INTO swap_subscription (org_id, app_driver_id, plan_id, rider_code, period_start, period_end, paid_minor) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [orgId, appDriverId, plan.id, code, today(), addMonth(today()), Number(plan.monthly_minor)]));
  return driverSwap(appDriverId, brandOrg);
}

// ------------------------------------------------------------------ the worker

/** Renew plans whose month is over (from credit, else lapsed); raise swap.cabinet_offline. */
export async function sweep(): Promise<{ renewed: number; lapsed: number; offline: number }> {
  let renewed = 0, lapsed = 0;
  const due = await S(() => many<any>(`SELECT s.*, p.monthly_minor, p.currency, p.archived_at FROM swap_subscription s JOIN swap_plan p ON p.id = s.plan_id
    WHERE s.status = 'active' AND s.period_end <= current_date LIMIT 500`));
  for (const s of due) {
    const end = ymd(s.period_end);
    if (!s.archived_at && await payFromCredit(s.org_id, s.app_driver_id, s.currency, Number(s.monthly_minor))) {
      await S(() => query(`UPDATE swap_subscription SET period_start = $2, period_end = $3, paid_minor = paid_minor + $4 WHERE id = $1`, [s.id, end, addMonth(end), Number(s.monthly_minor)]));
      renewed++;
    } else {
      await S(() => query(`UPDATE swap_subscription SET status = 'lapsed' WHERE id = $1`, [s.id]));
      lapsed++;
    }
  }
  const off = await S(() => many<any>(`SELECT c.* FROM swap_cabinet c JOIN swap_settings st ON st.org_id = c.org_id AND st.enabled
    WHERE c.status = 'active' AND c.key_hash IS NOT NULL AND (c.last_seen_at IS NULL OR c.last_seen_at < now() - interval '15 minutes') AND c.created_at < now() - interval '15 minutes'`));
  for (const c of off) {
    await S(() => persistAlert({ orgId: c.org_id, kind: OFFLINE_ALERT, severity: 'warning', targetType: 'swap_cabinet', targetId: String(c.id),
      message: `Swap cabinet ${c.code} (${c.name}) has not reported ${c.last_seen_at ? `since ${new Date(c.last_seen_at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'yet'}.` } as any)).catch(() => null);
  }
  return { renewed, lapsed, offline: off.length };
}
