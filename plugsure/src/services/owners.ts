import { one, many, query } from '../db/pool.js';

/**
 * Site owners — the businesses whose sites PlugSure operates (hotels, retail,
 * offices). An owner has its own console sign-in (the Site Owner role, scoped to
 * the owner) and a monthly statement of its charging units, amounts and share.
 *
 * Re-assigning a site that already has charging history from one owner to
 * ANOTHER is refused: the new owner would see the previous owner's sessions and
 * revenue at that site. Create a new site for the new owner and move the
 * chargers (their OCPP history does not follow them into the new owner's view).
 * Assigning an owner to a site that never had one, or removing it, is allowed;
 * a site removed from an owner remembers it (previous_owner_id), so it cannot
 * reach a different owner via "no owner" either.
 */

export interface OwnerInput {
  name?: string;
  legalName?: string | null;
  npwp?: string | null;
  pkp?: boolean;
  address?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  sellerOfRecord?: 'operator' | 'owner';
}

const str = (v: unknown, max = 200) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

function clean(input: OwnerInput, creating: boolean): { error: string } | Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (creating || input.name !== undefined) {
    const name = str(input.name, 120);
    if (!name) return { error: 'Enter the owner\'s name.' };
    out.name = name;
  }
  if (input.legalName !== undefined) out.legal_name = str(input.legalName, 200);
  if (input.npwp !== undefined) {
    const n = str(input.npwp, 30);
    // NPWP: 15 digits (old format, often dotted) or the 16-digit NIK-based NPWP.
    if (n && !/^\d{15,16}$/.test(n.replace(/[.\-\s]/g, ''))) return { error: 'NPWP has 15 or 16 digits.' };
    out.npwp = n;
  }
  if (input.pkp !== undefined) out.pkp = !!input.pkp;
  if (input.address !== undefined) out.address = str(input.address, 400);
  if (input.contactName !== undefined) out.contact_name = str(input.contactName, 120);
  if (input.contactEmail !== undefined) {
    const e = str(input.contactEmail, 254);
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { error: 'That contact e-mail is not valid.' };
    out.contact_email = e;
  }
  if (input.contactPhone !== undefined) out.contact_phone = str(input.contactPhone, 40);
  if (input.sellerOfRecord !== undefined) {
    if (!['operator', 'owner'].includes(input.sellerOfRecord)) return { error: 'Seller of record is the operator or the owner.' };
    out.seller_of_record = input.sellerOfRecord;
  }
  return out;
}

export async function listOwners(orgId: string) {
  return many(
    `SELECT o.id, o.name, o.legal_name, o.npwp, o.pkp, o.address, o.contact_name, o.contact_email, o.contact_phone,
            o.seller_of_record, o.archived_at, o.created_at,
            COALESCE((SELECT json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.name)
                        FROM site s WHERE s.owner_id = o.id AND s.archived_at IS NULL), '[]') AS sites,
            (SELECT count(*) FROM charge_point cp JOIN site s ON s.id = cp.site_id
              WHERE s.owner_id = o.id AND cp.status <> 'decommissioned')::int AS chargers,
            (SELECT count(*) FROM user_role ur WHERE ur.scope_type = 'owner' AND ur.scope_id = o.id)::int AS users
       FROM site_owner o
      WHERE o.org_id = $1
      ORDER BY o.archived_at NULLS FIRST, o.name`,
    [orgId],
  );
}

export async function createOwner(orgId: string, input: OwnerInput) {
  const c = clean(input, true);
  if ('error' in c) return c as { error: string };
  const cols = Object.keys(c);
  const row = await one<{ id: string }>(
    `INSERT INTO site_owner (org_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [orgId, ...Object.values(c)],
  );
  return { id: row!.id };
}

export async function updateOwner(orgId: string, id: string, input: OwnerInput & { archived?: boolean }) {
  const c = clean(input, false);
  if ('error' in c) return c as { error: string };
  const sets = Object.keys(c).map((k, i) => `${k} = $${i + 3}`);
  if (input.archived !== undefined) sets.push(input.archived ? 'archived_at = COALESCE(archived_at, now())' : 'archived_at = NULL');
  if (!sets.length) return { error: 'nothing to change' };
  const r = await query(`UPDATE site_owner SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId, ...Object.values(c)]);
  return r.rowCount ? { ok: true } : { error: 'not found' };
}

/**
 * Make exactly these sites the owner's. Sites currently owned by ANOTHER owner
 * with charging history are refused (see the module note).
 */
export async function setOwnerSites(orgId: string, ownerId: string, siteIds: string[]) {
  const owner = await one(`SELECT id FROM site_owner WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [ownerId, orgId]);
  if (!owner) return { error: 'not found' };
  const found = await many<{ id: string; name: string; owner_id: string | null; previous_owner_id: string | null; history: boolean }>(
    `SELECT s.id, s.name, s.owner_id, s.previous_owner_id,
            EXISTS (SELECT 1 FROM charging_session cs WHERE cs.site_id = s.id) AS history
       FROM site s WHERE s.org_id = $1 AND s.id = ANY($2::uuid[])`,
    [orgId, siteIds],
  );
  if (found.length !== new Set(siteIds).size) return { error: 'A chosen site does not exist.' };
  // The owner whose history the site carries: its current owner, or the one it was last removed from.
  const taken = found.filter((s) => {
    const holder = s.owner_id ?? s.previous_owner_id;
    return holder && holder !== ownerId && s.history;
  });
  if (taken.length) {
    return {
      error: `${taken.map((s) => s.name).join(', ')} already belong${taken.length === 1 ? 's' : ''} to another owner and ${taken.length === 1 ? 'has' : 'have'} charging history. ` +
        'Moving it would show that owner\'s sessions and revenue to the new owner. Create a new site for the new owner and move the chargers there.',
    };
  }
  await query(
    `UPDATE site SET owner_id = NULL, previous_owner_id = $2 WHERE org_id = $1 AND owner_id = $2 AND NOT (id = ANY($3::uuid[]))`,
    [orgId, ownerId, siteIds],
  );
  await query(`UPDATE site SET owner_id = $2, previous_owner_id = NULL WHERE org_id = $1 AND id = ANY($3::uuid[])`, [orgId, ownerId, siteIds]);
  return { ok: true };
}

export async function ownerOf(orgId: string, id: string) {
  return one<{ id: string; name: string; legal_name: string | null; npwp: string | null; pkp: boolean; address: string | null }>(
    `SELECT id, name, legal_name, npwp, pkp, address FROM site_owner WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );
}
