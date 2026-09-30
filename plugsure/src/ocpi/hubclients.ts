import { many, one, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { unseal } from '../services/secrets.js';
import { parseClientInfo, clientInfoOut, type ClientInfoIn } from './mapping.js';
import { getParty, endpointUrl, type PartnerRow } from './store.js';
import { ocpiCall } from './client.js';

/**
 * HubClientInfo (OCPI 2.2.1 § 16): which parties sit behind a roaming hub, and
 * whether each is connected. The hub pushes changes to us (we are the
 * RECEIVER) and we pull the whole list from it after registering and every few
 * hours (when it offers a SENDER endpoint).
 *
 * What it changes: a hub that has told us who is behind it may only act for
 * those parties (tokens, commands, locations), and not for one it reports as
 * SUSPENDED or merely PLANNED. A hub that has told us nothing is trusted for
 * anyone, as before.
 */

export class HubClientError extends Error {
  constructor(public http: number, public ocpi: number, message: string) { super(message); }
}

interface Row extends ClientInfoIn { received_at: Date }

async function upsert(partner: PartnerRow, c: ClientInfoIn): Promise<void> {
  // An older update than the one we hold is ignored (pushes and pulls can cross).
  await query(
    `INSERT INTO ocpi_hub_client (org_id, partner_id, country_code, party_id, role, status, last_updated)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (partner_id, country_code, party_id, role) DO UPDATE
       SET status = EXCLUDED.status, last_updated = EXCLUDED.last_updated, received_at = now()
     WHERE ocpi_hub_client.last_updated <= EXCLUDED.last_updated`,
    [partner.org_id, partner.id, c.country_code, c.party_id, c.role, c.status, c.last_updated],
  );
}

/** PUT {country_code}/{party_id} from the hub. */
export async function receiveClientInfo(partner: PartnerRow, cc: string, pid: string, body: unknown): Promise<void> {
  if (partner.kind !== 'hub') throw new HubClientError(403, 2000, 'only a hub sends client info');
  const c = parseClientInfo(body, { country_code: cc, party_id: pid });
  if (typeof c === 'string') throw new HubClientError(400, 2001, c);
  await upsert(partner, c);
}

/** GET {country_code}/{party_id}: what the hub last told us about that party. */
export async function getClientInfo(partner: PartnerRow, cc: string, pid: string) {
  const r = await one<Row>(
    `SELECT country_code, party_id, role, status, last_updated FROM ocpi_hub_client
      WHERE partner_id = $1 AND country_code = $2 AND party_id = $3 ORDER BY last_updated DESC LIMIT 1`,
    [partner.id, cc, pid],
  );
  return r ? clientInfoOut(r) : null;
}

export async function listClients(orgId: string, partnerId: string) {
  return many<Row>(
    `SELECT country_code, party_id, role, status, last_updated, received_at FROM ocpi_hub_client
      WHERE org_id = $1 AND partner_id = $2 ORDER BY country_code, party_id, role`,
    [orgId, partnerId],
  );
}

/**
 * Pull the hub's full list (paged, following the Link header). A complete pull
 * is the truth: parties the hub no longer lists are forgotten.
 */
export async function pullHubClients(partner: PartnerRow): Promise<{ clients: number } | null> {
  if (partner.kind !== 'hub' || partner.state !== 'connected' || !partner.token_out) return null;
  let url = endpointUrl(partner, 'hubclientinfo', 'SENDER');
  if (!url) return null;
  const party = await getParty(partner.org_id);
  if (!party) return null;
  const token = unseal(partner.token_out);
  const seen: ClientInfoIn[] = [];
  let pages = 0;
  while (url) {
    if (pages++ >= 50) return null;
    const r = await ocpiCall({ orgId: partner.org_id, partnerId: partner.id, method: 'GET', url, token, from: party, to: { country_code: partner.country_code, party_id: partner.party_id } });
    if (!r.ok || !Array.isArray(r.data)) return null;
    for (const o of r.data) {
      const c = parseClientInfo(o);
      if (typeof c === 'string') { logger.warn({ partner: partner.name, err: c }, 'skipped a hub client entry'); continue; }
      seen.push(c);
    }
    const link = String(r.headers.link ?? '');
    url = /<([^>]+)>;\s*rel="?next"?/.exec(link)?.[1] ?? null;
  }
  for (const c of seen) await upsert(partner, c);
  await query(
    `DELETE FROM ocpi_hub_client WHERE partner_id = $1
       AND NOT (country_code || '*' || party_id || '*' || role = ANY($2::text[]))`,
    [partner.id, seen.map((c) => `${c.country_code}*${c.party_id}*${c.role}`)],
  );
  return { clients: seen.length };
}

export async function pullAllHubClients(): Promise<void> {
  const hubs = await many<PartnerRow>(
    `SELECT * FROM ocpi_partner WHERE state = 'connected' AND kind = 'hub' AND endpoints @> '[{"identifier":"hubclientinfo","role":"SENDER"}]'::jsonb`,
  );
  for (const h of hubs) await pullHubClients(h).catch((e) => logger.warn({ partner: h.name, err: (e as Error).message }, 'hub client pull failed'));
}
