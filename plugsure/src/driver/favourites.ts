import { one, many, query } from '../db/pool.js';
import { roamingEligibility } from './roaming.js';
import type { DriverPrincipal } from './identity.js';

/**
 * Favourite stations. Kept per phone, and for a driver signed in with a phone
 * number also per account, so they follow the driver to a new phone. A
 * favourite is either one of PlugSure's sites or a partner network location.
 */

export interface Favourite {
  id: string;
  siteId: string | null;
  partnerId: string | null;
  countryCode: string | null;
  partyId: string | null;
  locationId: string | null;
}

const MAX = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listFavourites(p: DriverPrincipal): Promise<Favourite[]> {
  const rows = await many<any>(
    `SELECT DISTINCT ON (COALESCE(site_id::text, partner_id::text || country_code || party_id || location_id))
            id, site_id, partner_id, country_code, party_id, location_id, created_at
       FROM driver_favourite
      WHERE device_id = $1 OR ($2::uuid IS NOT NULL AND app_driver_id = $2)
      ORDER BY COALESCE(site_id::text, partner_id::text || country_code || party_id || location_id), created_at`,
    [p.deviceId, p.appDriverId],
  );
  return rows.map((r) => ({ id: r.id, siteId: r.site_id, partnerId: r.partner_id, countryCode: r.country_code, partyId: r.party_id, locationId: r.location_id }));
}

export async function addFavourite(p: DriverPrincipal, b: any): Promise<{ ok: boolean; error?: string; favourite?: Favourite }> {
  const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM driver_favourite WHERE device_id = $1 OR ($2::uuid IS NOT NULL AND app_driver_id = $2)`, [p.deviceId, p.appDriverId]);
  if ((n?.n ?? 0) >= MAX) return { ok: false, error: `Maksimal ${MAX} favorit.` };
  const existing = (await listFavourites(p)).find((f) =>
    (b?.siteId && f.siteId === b.siteId) ||
    (b?.locationId && f.partnerId === b.partnerId && f.countryCode === b.countryCode && f.partyId === b.partyId && f.locationId === b.locationId));
  if (existing) return { ok: true, favourite: existing };

  if (typeof b?.siteId === 'string') {
    if (!UUID_RE.test(b.siteId)) return { ok: false, error: 'Stasiun tidak ditemukan.' };
    const s = await one(`SELECT 1 FROM site WHERE id = $1 AND archived_at IS NULL`, [b.siteId]);
    if (!s) return { ok: false, error: 'Stasiun tidak ditemukan.' };
    const r = await one<any>(
      `INSERT INTO driver_favourite (device_id, app_driver_id, site_id) VALUES ($1,$2,$3) RETURNING id, site_id`,
      [p.deviceId, p.appDriverId, b.siteId],
    );
    return { ok: true, favourite: { id: r.id, siteId: r.site_id, partnerId: null, countryCode: null, partyId: null, locationId: null } };
  }
  // A partner network location: only for a driver who can use the partner network.
  const el = await roamingEligibility(p);
  if (!el.enabled) return { ok: false, error: el.reason };
  if (typeof b?.partnerId !== 'string' || !UUID_RE.test(b.partnerId) || typeof b?.locationId !== 'string') return { ok: false, error: 'Stasiun tidak ditemukan.' };
  const loc = await one(
    `SELECT 1 FROM ocpi_remote_location WHERE org_id = $1 AND partner_id = $2 AND country_code = $3 AND party_id = $4 AND location_id = $5`,
    [el.orgId, b.partnerId, String(b.countryCode ?? ''), String(b.partyId ?? ''), b.locationId],
  );
  if (!loc) return { ok: false, error: 'Stasiun tidak ditemukan.' };
  const r = await one<any>(
    `INSERT INTO driver_favourite (device_id, app_driver_id, partner_id, country_code, party_id, location_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [p.deviceId, p.appDriverId, b.partnerId, b.countryCode, b.partyId, b.locationId],
  );
  return { ok: true, favourite: { id: r.id, siteId: null, partnerId: b.partnerId, countryCode: b.countryCode, partyId: b.partyId, locationId: b.locationId } };
}

/** Remove a favourite (every copy of it, on this phone and on the account). */
export async function removeFavourite(p: DriverPrincipal, id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const f = await one<any>(`SELECT * FROM driver_favourite WHERE id = $1 AND (device_id = $2 OR ($3::uuid IS NOT NULL AND app_driver_id = $3))`, [id, p.deviceId, p.appDriverId]);
  if (!f) return false;
  await query(
    `DELETE FROM driver_favourite
      WHERE (device_id = $1 OR ($2::uuid IS NOT NULL AND app_driver_id = $2))
        AND (($3::uuid IS NOT NULL AND site_id = $3)
          OR ($3::uuid IS NULL AND partner_id = $4 AND country_code = $5 AND party_id = $6 AND location_id = $7))`,
    [p.deviceId, p.appDriverId, f.site_id, f.partner_id, f.country_code, f.party_id, f.location_id],
  );
  return true;
}
