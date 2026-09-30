import { createHash, randomUUID } from 'node:crypto';
import { one, many, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { unseal } from '../services/secrets.js';
import { ocpiDateTime, STATUS, type Party } from './mapping.js';
import { getParty, endpointUrl, partnerActsFor, type PartnerRow } from './store.js';
import { ocpiCall } from './client.js';

/**
 * PlugSure as the e-mobility service provider (eMSP): the operator's own cards
 * charge on other operators' networks.
 *
 *   tokens     we are the SENDER: CPOs pull (or are pushed) the shared cards and
 *              ask us in real time whether a card may charge
 *   locations, tariffs, sessions, cdrs
 *              we are the RECEIVER: CPOs push their network, our drivers'
 *              sessions and the charge records we pay
 *   commands   we are the SENDER: start / stop / unlock at a CPO's charger,
 *              with the outcome posted back to us
 *
 * Only RFID cards (fleet and company accounts, billed afterwards) can roam: a
 * driver-app user pays upfront by QRIS and has nothing to bill a roaming
 * session to.
 */

// ─────────────────────────────────────────────── our cards as OCPI tokens

export interface CardRow {
  id: string;
  org_id: string;
  uid: string;
  status: string;
  valid_to: Date | null;
  holder_name: string | null;
  fleet_name: string | null;
  energy_limit_wh: number | null;
  spend_limit_idr: number | null;
  roaming_shared: boolean;
  contract_id: string | null;
  updated_at: Date;
}

/** eMAID-style contract id: ID-PLS-C1A2B3C4D (country, provider, instance). */
export function contractIdFor(party: Pick<Party, 'country_code' | 'party_id'>, tokenId: string): string {
  const inst = createHash('sha256').update(tokenId).digest('hex').slice(0, 8).toUpperCase();
  return `${party.country_code}-${party.party_id}-C${inst}`;
}

/**
 * A shared card as an OCPI Token. A card with an energy or spending limit is
 * `NEVER` whitelisted, so the CPO must ask us before every session and the limit
 * holds on their network too; any other card may be accepted by the CPO locally.
 */
export function cardToken(party: Party, c: CardRow) {
  const expired = !!c.valid_to && new Date(c.valid_to) < new Date();
  const limited = c.energy_limit_wh != null || c.spend_limit_idr != null;
  return {
    country_code: party.country_code,
    party_id: party.party_id,
    uid: c.uid,
    type: 'RFID',
    contract_id: c.contract_id ?? '',
    visual_number: c.uid,
    issuer: party.business_name,
    ...(c.fleet_name ? { group_id: c.fleet_name.replace(/[^A-Za-z0-9-]/g, '').slice(0, 36) || undefined } : {}),
    valid: c.roaming_shared && c.status === 'Accepted' && !expired,
    whitelist: limited ? 'NEVER' : 'ALLOWED',
    language: 'id',
    last_updated: ocpiDateTime(c.updated_at),
  };
}

const CARD_COLS = `id, org_id, uid, status, valid_to, holder_name, fleet_name, energy_limit_wh, spend_limit_idr,
                   roaming_shared, contract_id, updated_at`;

/** Cards CPOs should know about: shared now, or shared before (sent as valid=false). */
export async function roamingCards(orgId: string, opts: { onlyShared?: boolean } = {}) {
  return many<CardRow>(
    `SELECT ${CARD_COLS} FROM token
      WHERE org_id = $1 AND kind = 'rfid' AND contract_id IS NOT NULL
        AND ($2::boolean IS NOT TRUE OR roaming_shared)
      ORDER BY updated_at, id`,
    [orgId, opts.onlyShared ?? false],
  );
}

/** Share or stop sharing cards. The first share gives a card its contract id. */
export async function setShared(orgId: string, tokenIds: string[] | 'all-active', shared: boolean): Promise<number> {
  const party = await getParty(orgId);
  if (!party) throw new Error('set the roaming identity first');
  const rows = await many<{ id: string; contract_id: string | null }>(
    tokenIds === 'all-active'
      ? `SELECT id, contract_id FROM token WHERE org_id = $1 AND kind = 'rfid' AND status = 'Accepted' AND roaming_shared <> $2`
      : `SELECT id, contract_id FROM token WHERE org_id = $1 AND kind = 'rfid' AND id = ANY($2::uuid[])`,
    tokenIds === 'all-active' ? [orgId, shared] : [orgId, tokenIds],
  );
  for (const r of rows) {
    await query(
      `UPDATE token SET roaming_shared = $2, contract_id = COALESCE(contract_id, $3), updated_at = now() WHERE id = $1`,
      [r.id, shared, contractIdFor(party, r.id)],
    );
  }
  return rows.length;
}

/** Energy and money a card has used, at our chargers and on roaming networks. */
export async function cardUsage(tokenId: string): Promise<{ wh: number; idr: number }> {
  const u = await one<{ wh: string; idr: string }>(
    `SELECT (COALESCE((SELECT sum(cs.energy_wh) FROM charging_session cs WHERE cs.token_id = $1), 0)
           + COALESCE((SELECT sum(r.total_energy * 1000) FROM ocpi_remote_cdr r WHERE r.token_id = $1), 0))::bigint AS wh,
            (COALESCE((SELECT sum(d.total_idr) FROM charging_session cs JOIN cdr d ON d.session_id = cs.id WHERE cs.token_id = $1), 0)
           + COALESCE((SELECT sum(COALESCE(r.total_incl_vat, r.total_excl_vat)) FROM ocpi_remote_cdr r
                        WHERE r.token_id = $1 AND r.currency = 'IDR'), 0))::bigint AS idr`,
    [tokenId],
  );
  return { wh: Number(u?.wh ?? 0), idr: Number(u?.idr ?? 0) };
}

/** Is a card over its operator-set energy or spending limit? */
export async function overLimit(c: Pick<CardRow, 'id' | 'energy_limit_wh' | 'spend_limit_idr'>): Promise<boolean> {
  if (c.energy_limit_wh == null && c.spend_limit_idr == null) return false;
  const u = await cardUsage(c.id);
  return (c.energy_limit_wh != null && u.wh >= Number(c.energy_limit_wh)) || (c.spend_limit_idr != null && u.idr >= Number(c.spend_limit_idr));
}

/**
 * A CPO asks whether our card may charge now (POST tokens/{uid}/authorize).
 * Returns null for a card we do not share (the caller answers 2004).
 */
export async function authorizeForCpo(partner: PartnerRow, party: Party, uid: string, type: string, body: any) {
  if (type !== 'RFID') return null;
  const c = await one<CardRow>(`SELECT ${CARD_COLS} FROM token WHERE org_id = $1 AND kind = 'rfid' AND uid = $2 AND contract_id IS NOT NULL`, [partner.org_id, uid]);
  if (!c) return null;
  const token = cardToken(party, c);
  let allowed: 'ALLOWED' | 'BLOCKED' | 'EXPIRED' | 'NO_CREDIT' | 'NOT_ALLOWED' = 'ALLOWED';
  if (!c.roaming_shared) allowed = 'NOT_ALLOWED';
  else if (c.status === 'Blocked') allowed = 'BLOCKED';
  else if (c.status === 'Expired' || (c.valid_to && new Date(c.valid_to) < new Date())) allowed = 'EXPIRED';
  else if (c.status !== 'Accepted') allowed = 'BLOCKED';
  else if (await overLimit(c)) allowed = 'NO_CREDIT';
  logger.info({ partner: partner.name, uid, allowed }, 'roaming card checked by a CPO');
  return {
    allowed,
    token,
    ...(allowed === 'ALLOWED' ? { authorization_reference: randomUUID().replace(/-/g, '').slice(0, 20) } : {}),
    ...(body?.location_id ? { location: body } : {}),
    ...(allowed !== 'ALLOWED' ? { info: { language: 'en', text: `Card ${allowed.toLowerCase().replace('_', ' ')}` } } : {}),
  };
}

// ─────────────────────────────────────────────── what CPOs send us

export class EmspError extends Error {
  constructor(public http: number, public ocpi: number, message: string) { super(message); }
}

async function mustActFor(partner: PartnerRow, cc: string, pid: string) {
  if (!(await partnerActsFor(partner, cc, pid))) throw new EmspError(403, STATUS.CLIENT_ERROR, `this connection may not publish for ${cc}*${pid}`);
}

function lastUpdatedOf(b: any): Date {
  const d = new Date(b?.last_updated);
  if (!b?.last_updated || Number.isNaN(d.getTime())) throw new EmspError(400, STATUS.INVALID_PARAMS, 'last_updated is required');
  return d;
}

const merge = (base: any, patch: any) => ({ ...base, ...patch });

/** PUT or PATCH of a location, an EVSE or a connector (OCPI Locations receiver). */
export async function receiveLocation(partner: PartnerRow, method: 'PUT' | 'PATCH', p: { cc: string; pid: string; loc: string; evse?: string; conn?: string }, body: any) {
  await mustActFor(partner, p.cc, p.pid);
  if (!body || typeof body !== 'object') throw new EmspError(400, STATUS.INVALID_PARAMS, 'a JSON body is required');
  const lu = lastUpdatedOf(body);
  const cur = await one<{ data: any }>(
    `SELECT data FROM ocpi_remote_location WHERE partner_id = $1 AND country_code = $2 AND party_id = $3 AND location_id = $4`,
    [partner.id, p.cc, p.pid, p.loc],
  );
  let data: any;
  if (!p.evse) {
    if (method === 'PUT') {
      if (body.id !== undefined && body.id !== p.loc) throw new EmspError(400, STATUS.INVALID_PARAMS, 'id must match the URL');
      if (!body.coordinates || !body.name && !body.address) throw new EmspError(400, STATUS.INVALID_PARAMS, 'a location needs coordinates and a name or address');
      data = { ...body, id: p.loc, country_code: p.cc, party_id: p.pid };
    } else {
      if (!cur) throw new EmspError(404, STATUS.UNKNOWN_LOCATION, 'unknown location: PUT it first');
      data = merge(cur.data, body);
    }
  } else {
    if (!cur) throw new EmspError(404, STATUS.UNKNOWN_LOCATION, 'unknown location: PUT it first');
    data = { ...cur.data, evses: [...(cur.data.evses ?? [])] };
    const i = data.evses.findIndex((e: any) => e.uid === p.evse);
    if (!p.conn) {
      if (method === 'PUT') { const e = { ...body, uid: p.evse }; i >= 0 ? (data.evses[i] = e) : data.evses.push(e); }
      else { if (i < 0) throw new EmspError(404, STATUS.UNKNOWN_LOCATION, 'unknown EVSE'); data.evses[i] = merge(data.evses[i], body); }
    } else {
      if (i < 0) throw new EmspError(404, STATUS.UNKNOWN_LOCATION, 'unknown EVSE');
      const e = { ...data.evses[i], connectors: [...(data.evses[i].connectors ?? [])] };
      const j = e.connectors.findIndex((c: any) => c.id === p.conn);
      if (method === 'PUT') { const c = { ...body, id: p.conn }; j >= 0 ? (e.connectors[j] = c) : e.connectors.push(c); }
      else { if (j < 0) throw new EmspError(404, STATUS.UNKNOWN_LOCATION, 'unknown connector'); e.connectors[j] = merge(e.connectors[j], body); }
      data.evses[i] = { ...e, last_updated: body.last_updated };
    }
    data.last_updated = body.last_updated;
  }
  await query(
    `INSERT INTO ocpi_remote_location (org_id, partner_id, country_code, party_id, location_id, data, last_updated)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (partner_id, country_code, party_id, location_id) DO UPDATE
       SET data = EXCLUDED.data, last_updated = EXCLUDED.last_updated, received_at = now()`,
    [partner.org_id, partner.id, p.cc, p.pid, p.loc, JSON.stringify(data), lu],
  );
}

export async function getRemoteLocation(partner: PartnerRow, cc: string, pid: string, loc: string) {
  const r = await one<{ data: any }>(
    `SELECT data FROM ocpi_remote_location WHERE partner_id = $1 AND country_code = $2 AND party_id = $3 AND location_id = $4`,
    [partner.id, cc, pid, loc],
  );
  return r?.data ?? null;
}

export async function receiveTariff(partner: PartnerRow, method: 'PUT' | 'DELETE', p: { cc: string; pid: string; id: string }, body: any) {
  await mustActFor(partner, p.cc, p.pid);
  if (method === 'DELETE') {
    await query(`DELETE FROM ocpi_remote_tariff WHERE partner_id = $1 AND country_code = $2 AND party_id = $3 AND tariff_id = $4`, [partner.id, p.cc, p.pid, p.id]);
    return;
  }
  const lu = lastUpdatedOf(body);
  if (!Array.isArray(body?.elements) || !body?.currency) throw new EmspError(400, STATUS.INVALID_PARAMS, 'a tariff needs currency and elements');
  await query(
    `INSERT INTO ocpi_remote_tariff (org_id, partner_id, country_code, party_id, tariff_id, data, last_updated)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (partner_id, country_code, party_id, tariff_id) DO UPDATE
       SET data = EXCLUDED.data, last_updated = EXCLUDED.last_updated, received_at = now()`,
    [partner.org_id, partner.id, p.cc, p.pid, p.id, JSON.stringify({ ...body, id: p.id }), lu],
  );
}

export async function getRemoteTariff(partner: PartnerRow, cc: string, pid: string, id: string) {
  const r = await one<{ data: any }>(`SELECT data FROM ocpi_remote_tariff WHERE partner_id = $1 AND country_code = $2 AND party_id = $3 AND tariff_id = $4`, [partner.id, cc, pid, id]);
  return r?.data ?? null;
}

/** Which of our cards a session or CDR is about (its cdr_token must be ours). */
async function ourCard(orgId: string, party: Party, t: any): Promise<string> {
  if (!t || t.country_code !== party.country_code || t.party_id !== party.party_id) {
    throw new EmspError(400, STATUS.UNKNOWN_TOKEN, `cdr_token is not a token of ${party.country_code}*${party.party_id}`);
  }
  const c = await one<{ id: string }>(`SELECT id FROM token WHERE org_id = $1 AND kind = 'rfid' AND uid = $2 AND contract_id IS NOT NULL`, [orgId, t.uid]);
  if (!c) throw new EmspError(404, STATUS.UNKNOWN_TOKEN, `unknown token ${t.uid}`);
  return c.id;
}

export async function receiveSession(partner: PartnerRow, party: Party, method: 'PUT' | 'PATCH', p: { cc: string; pid: string; id: string }, body: any) {
  await mustActFor(partner, p.cc, p.pid);
  const lu = lastUpdatedOf(body);
  const cur = await one<{ data: any; token_id: string | null }>(
    `SELECT data, token_id FROM ocpi_remote_session WHERE partner_id = $1 AND country_code = $2 AND party_id = $3 AND session_id = $4`,
    [partner.id, p.cc, p.pid, p.id],
  );
  let data: any;
  let tokenId: string | null;
  if (method === 'PUT') {
    tokenId = await ourCard(partner.org_id, party, body?.cdr_token);
    data = { ...body, id: p.id, country_code: p.cc, party_id: p.pid };
  } else {
    if (!cur) throw new EmspError(404, STATUS.CLIENT_ERROR, 'unknown session: PUT it first');
    data = merge(cur.data, body);
    tokenId = cur.token_id;
  }
  await query(
    `INSERT INTO ocpi_remote_session (org_id, partner_id, country_code, party_id, session_id, token_id, data, status, kwh, last_updated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (partner_id, country_code, party_id, session_id) DO UPDATE
       SET data = EXCLUDED.data, status = EXCLUDED.status, kwh = EXCLUDED.kwh, last_updated = EXCLUDED.last_updated, received_at = now()`,
    [partner.org_id, partner.id, p.cc, p.pid, p.id, tokenId, JSON.stringify(data), data.status ?? null,
      Number.isFinite(Number(data.kwh)) ? Number(data.kwh) : null, lu],
  );
}

export async function getRemoteSession(partner: PartnerRow, cc: string, pid: string, id: string) {
  const r = await one<{ data: any }>(`SELECT data FROM ocpi_remote_session WHERE partner_id = $1 AND country_code = $2 AND party_id = $3 AND session_id = $4`, [partner.id, cc, pid, id]);
  return r?.data ?? null;
}

/**
 * A CPO posts a charge record (OCPI CDRs receiver). Returns our id for the
 * Location header. A CDR cannot change once sent: the same CDR posted again is
 * acknowledged with the same id, a different one under the same id is refused.
 */
export async function receiveCdr(partner: PartnerRow, party: Party, b: any): Promise<string> {
  const cc = String(b?.country_code ?? '');
  const pid = String(b?.party_id ?? '');
  const id = typeof b?.id === 'string' && b.id ? b.id.slice(0, 39) : '';
  if (!id || !cc || !pid) throw new EmspError(400, STATUS.INVALID_PARAMS, 'id, country_code and party_id are required');
  await mustActFor(partner, cc, pid);
  const excl = Number(b?.total_cost?.excl_vat);
  const energy = Number(b?.total_energy);
  const start = new Date(b?.start_date_time);
  const end = new Date(b?.end_date_time);
  if (!Number.isFinite(excl) || !Number.isFinite(energy) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || typeof b?.currency !== 'string') {
    throw new EmspError(400, STATUS.INVALID_PARAMS, 'a CDR needs start/end_date_time, currency, total_cost and total_energy');
  }
  const tokenId = await ourCard(partner.org_id, party, b?.cdr_token);
  const existing = await one<{ id: string; data: any }>(
    `SELECT id, data FROM ocpi_remote_cdr WHERE partner_id = $1 AND country_code = $2 AND party_id = $3 AND cdr_id = $4`,
    [partner.id, cc, pid, id],
  );
  if (existing) {
    if (JSON.stringify(existing.data.total_cost) !== JSON.stringify(b.total_cost) || Number(existing.data.total_energy) !== energy) {
      throw new EmspError(409, STATUS.INVALID_PARAMS, 'a CDR with this id was already received with different totals; CDRs cannot be changed (send a credit CDR)');
    }
    return existing.id;
  }
  const incl = Number(b?.total_cost?.incl_vat);
  const row = await one<{ id: string }>(
    `INSERT INTO ocpi_remote_cdr (org_id, partner_id, country_code, party_id, cdr_id, session_id, token_id, data, currency,
                                  total_excl_vat, total_incl_vat, total_energy, start_date_time, end_date_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [partner.org_id, partner.id, cc, pid, id, typeof b.session_id === 'string' ? b.session_id : null, tokenId, JSON.stringify(b),
      b.currency, excl, Number.isFinite(incl) ? incl : null, energy, start, end],
  );
  logger.info({ partner: partner.name, cdr: id, excl, energy }, 'roaming CDR received for one of our cards');
  // Tell the driver's phone(s) the receipt is ready. Never fails the CPO's request.
  if (tokenId) {
    const site = typeof b?.cdr_location?.name === 'string' ? b.cdr_location.name : partner.name;
    const total = Number.isFinite(incl) ? incl : excl;
    void import('../driver/notify.js')
      .then((n) => n.notifyRoamingCdr(tokenId, row!.id, site, b.currency === 'IDR' ? Math.round(total) : null))
      .catch((e) => logger.warn({ err: (e as Error).message }, 'roaming CDR push failed'));
  }
  return row!.id;
}

export async function getRemoteCdr(partner: PartnerRow, ourId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(ourId)) return null;
  const r = await one<{ data: any }>(`SELECT data FROM ocpi_remote_cdr WHERE id = $1 AND partner_id = $2`, [ourId, partner.id]);
  return r?.data ?? null;
}

// ─────────────────────────────────────────────── importing a CPO's network

/** Pull a CPO partner's locations and tariffs (paged, following the Link header). */
export async function importFromCpo(partner: PartnerRow): Promise<{ locations: number; tariffs: number }> {
  const party = await getParty(partner.org_id);
  if (!party || !partner.token_out || partner.state !== 'connected') return { locations: 0, tariffs: 0 };
  const token = unseal(partner.token_out);
  const counts = { locations: 0, tariffs: 0 };
  for (const [module, kind] of [['locations', 'locations'], ['tariffs', 'tariffs']] as const) {
    let url = endpointUrl(partner, module, 'SENDER');
    let pages = 0;
    while (url && pages++ < 50) {
      const r = await ocpiCall({ orgId: partner.org_id, partnerId: partner.id, method: 'GET', url, token, from: party, to: { country_code: partner.country_code, party_id: partner.party_id } });
      if (!r.ok || !Array.isArray(r.data)) break;
      for (const o of r.data) {
        try {
          if (kind === 'locations') {
            await receiveLocation(partner, 'PUT', { cc: String(o.country_code), pid: String(o.party_id), loc: String(o.id) }, o);
            counts.locations++;
          } else {
            await receiveTariff(partner, 'PUT', { cc: String(o.country_code), pid: String(o.party_id), id: String(o.id) }, o);
            counts.tariffs++;
          }
        } catch (e) {
          logger.warn({ partner: partner.name, module, id: o?.id, err: (e as Error).message }, 'skipped an object from a CPO');
        }
      }
      const link = String(r.headers.link ?? '');
      url = /<([^>]+)>;\s*rel="?next"?/.exec(link)?.[1] ?? null;
    }
  }
  return counts;
}

export async function importAll(): Promise<void> {
  const ps = await many<PartnerRow>(
    `SELECT * FROM ocpi_partner WHERE state = 'connected' AND endpoints @> '[{"identifier":"locations","role":"SENDER"}]'::jsonb`,
  );
  for (const p of ps) await importFromCpo(p).catch((e) => logger.warn({ partner: p.name, err: (e as Error).message }, 'roaming import failed'));
}

// ─────────────────────────────────────────────── commands we send

export type OurCommand = 'START_SESSION' | 'STOP_SESSION' | 'UNLOCK_CONNECTOR' | 'RESERVE_NOW' | 'CANCEL_RESERVATION';

export async function sendCommand(o: {
  orgId: string; partnerId: string; command: OurCommand; base: string; userId?: string;
  tokenId?: string; locationId?: string; evseUid?: string; connectorId?: string; sessionId?: string;
  /** RESERVE_NOW / CANCEL_RESERVATION: our id for the reservation, and (RESERVE_NOW) until when. */
  reservationId?: string; expiryDate?: Date;
  locationParty?: { country_code: string; party_id: string };
}) {
  const party = await getParty(o.orgId);
  const p = await one<PartnerRow>(`SELECT * FROM ocpi_partner WHERE id = $1 AND org_id = $2 AND state = 'connected'`, [o.partnerId, o.orgId]);
  if (!party || !p || !p.token_out) throw new EmspError(409, STATUS.CLIENT_ERROR, 'the partner is not connected');
  const url = endpointUrl(p, 'commands', 'RECEIVER');
  if (!url) throw new EmspError(409, STATUS.CLIENT_ERROR, 'this partner does not accept commands');
  const id = randomUUID();
  const responseUrl = `${o.base}/ocpi/2.2.1/emsp/commands/${o.command}/${id}`;
  let body: Record<string, unknown>;
  if (o.command === 'START_SESSION' || o.command === 'RESERVE_NOW') {
    const c = await one<CardRow>(`SELECT ${CARD_COLS} FROM token WHERE id = $1 AND org_id = $2 AND kind = 'rfid'`, [o.tokenId, o.orgId]);
    if (!c?.roaming_shared || !c.contract_id) throw new EmspError(422, STATUS.INVALID_PARAMS, 'choose a card that is shared for roaming');
    if (!o.locationId) throw new EmspError(422, STATUS.INVALID_PARAMS, 'choose a location');
    body = {
      response_url: responseUrl, token: cardToken(party, c), location_id: o.locationId,
      ...(o.evseUid ? { evse_uid: o.evseUid } : {}),
      ...(o.command === 'START_SESSION' && o.connectorId ? { connector_id: o.connectorId } : {}),
      authorization_reference: id.replace(/-/g, '').slice(0, 20),
    };
    if (o.command === 'RESERVE_NOW') {
      if (!o.reservationId || !o.expiryDate) throw new EmspError(422, STATUS.INVALID_PARAMS, 'a reservation needs an id and an expiry');
      body.reservation_id = o.reservationId.slice(0, 36);
      body.expiry_date = o.expiryDate.toISOString();
    }
  } else if (o.command === 'CANCEL_RESERVATION') {
    if (!o.reservationId) throw new EmspError(422, STATUS.INVALID_PARAMS, 'choose a reservation');
    body = { response_url: responseUrl, reservation_id: o.reservationId.slice(0, 36) };
  } else if (o.command === 'STOP_SESSION') {
    if (!o.sessionId) throw new EmspError(422, STATUS.INVALID_PARAMS, 'choose a session');
    body = { response_url: responseUrl, session_id: o.sessionId };
  } else {
    if (!o.locationId || !o.evseUid || !o.connectorId) throw new EmspError(422, STATUS.INVALID_PARAMS, 'choose the location, EVSE and connector');
    body = { response_url: responseUrl, location_id: o.locationId, evse_uid: o.evseUid, connector_id: o.connectorId };
  }
  await query(
    `INSERT INTO ocpi_command (id, org_id, partner_id, command, token_id, request, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, o.orgId, p.id, o.command, o.tokenId ?? null, JSON.stringify(body), o.userId ?? null],
  );
  const r = await ocpiCall({
    orgId: o.orgId, partnerId: p.id, method: 'POST', url: `${url}/${o.command}`, token: unseal(p.token_out), body, from: party,
    to: o.locationParty ?? { country_code: p.country_code, party_id: p.party_id },
  });
  const answer = r.ok ? String(r.data?.result ?? 'ACCEPTED') : 'FAILED';
  const message = r.ok ? (r.data?.message?.[0]?.text ?? null) : r.error;
  await query(`UPDATE ocpi_command SET response = $2, message = $3, responded_at = now() WHERE id = $1`, [id, answer, message]);
  return { id, response: answer, message };
}

/** The CPO posts the charger's outcome to the response_url we gave it. */
export async function receiveCommandResult(partner: PartnerRow, command: string, id: string, b: any): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const result = typeof b?.result === 'string' ? b.result.slice(0, 40) : null;
  if (!result) throw new EmspError(400, STATUS.INVALID_PARAMS, 'result is required');
  const r = await query(
    `UPDATE ocpi_command SET result = $4, message = COALESCE($5, message), result_at = now()
      WHERE id = $1 AND partner_id = $2 AND command = $3`,
    [id, partner.id, command, result, b?.message?.[0]?.text ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}
