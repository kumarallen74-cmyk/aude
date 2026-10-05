import { createHash, randomUUID } from 'node:crypto';
import { one, many, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config, isRelaxedEnv } from '../config.js';
import { bus } from '../services/events.js';
import { unseal } from '../services/secrets.js';
import { ocpiDateTime, STATUS, type Party } from './mapping.js';
import { getParty, endpointUrl, partnerActsFor, isActing, type ActingParty, type PartnerRow } from './store.js';
import { ocpiCall } from './client.js';
import { COUNTRIES, isCountry, currencyOfCountry, cdrMaxPricePerKwh } from '../domain/country.js';
import { isCurrency as isCurrencyCode, toMinor, LEGACY_CURRENCY, type CurrencyCode } from '../domain/money.js';

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
  spend_limit_minor: number | null;
  spend_limit_currency?: string | null;
  roaming_shared: boolean;
  contract_id: string | null;
  updated_at: Date;
  /** 'rfid' (a fleet / company card) or 'app' (the virtual token of a signed-in app driver, OCPI APP_USER). */
  kind?: string;
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
  const limited = c.energy_limit_wh != null || c.spend_limit_minor != null;
  const app = c.kind === 'app';
  return {
    country_code: party.country_code,
    party_id: party.party_id,
    uid: c.uid,
    type: app ? 'APP_USER' : 'RFID',
    contract_id: c.contract_id ?? '',
    ...(app ? {} : { visual_number: c.uid }),
    issuer: party.business_name,
    ...(c.fleet_name ? { group_id: c.fleet_name.replace(/[^A-Za-z0-9-]/g, '').slice(0, 36) || undefined } : {}),
    valid: c.roaming_shared && c.status === 'Accepted' && !expired,
    whitelist: limited ? 'NEVER' : 'ALLOWED',
    language: 'id',
    last_updated: ocpiDateTime(c.updated_at),
  };
}

const CARD_COLS = `id, org_id, uid, status, valid_to, holder_name, fleet_name, energy_limit_wh, spend_limit_minor, spend_limit_currency,
                   roaming_shared, contract_id, updated_at, kind`;

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

/**
 * Energy and money a card has used, at our chargers and on roaming networks.
 * Only accepted partner charge records count: one held for review (or rejected)
 * cannot push a card over its limit, or the card could be blocked by any partner.
 *
 * Money is counted in ONE currency (docs/MULTI-COUNTRY-DESIGN.md §D7): our CDRs by
 * cdr.currency, partner CDRs by their currency, converted from the partner's
 * major units to PlugSure minor units. Amounts in other currencies are never added
 * (no FX); energy counts everywhere.
 */
export async function cardUsage(tokenId: string, currency: string = LEGACY_CURRENCY): Promise<{ wh: number; minor: number; currency: string }> {
  const u = await one<{ wh: string; minor: string }>(
    `SELECT (COALESCE((SELECT sum(cs.energy_wh) FROM charging_session cs WHERE cs.token_id = $1), 0)
           + COALESCE((SELECT sum(r.total_energy * 1000) FROM ocpi_remote_cdr r WHERE r.token_id = $1 AND r.status = 'accepted'), 0))::bigint AS wh,
            (COALESCE((SELECT sum(d.total_minor) FROM charging_session cs JOIN cdr d ON d.session_id = cs.id WHERE cs.token_id = $1 AND d.currency = $2), 0)
           + COALESCE((SELECT sum(COALESCE(r.total_incl_vat, r.total_excl_vat) * power(10, cu.exponent)) FROM ocpi_remote_cdr r
                         JOIN currency_unit cu ON cu.code = r.currency
                        WHERE r.token_id = $1 AND r.currency = $2 AND r.status = 'accepted'), 0))::bigint AS minor`,
    [tokenId, currency],
  );
  return { wh: Number(u?.wh ?? 0), minor: Number(u?.minor ?? 0), currency };
}

export type LimitCard = Pick<CardRow, 'id' | 'energy_limit_wh' | 'spend_limit_minor'> & { spend_limit_currency?: string | null };

/**
 * Why a card may not charge in `currency` (null = it may): over its energy limit,
 * over its spending limit, or — fail closed — a spending limit in another currency
 * (a limit in rupiah says nothing about ringgit). `currency` null = unknown: a card
 * with a spending limit is refused, one without may charge.
 */
export async function limitProblem(c: LimitCard, currency: string | null): Promise<'energy' | 'spend' | 'currency' | null> {
  if (c.energy_limit_wh == null && c.spend_limit_minor == null) return null;
  const limitCur = c.spend_limit_currency ?? LEGACY_CURRENCY;
  if (c.spend_limit_minor != null && currency !== limitCur) return 'currency';
  const u = await cardUsage(c.id, limitCur);
  if (c.energy_limit_wh != null && u.wh >= Number(c.energy_limit_wh)) return 'energy';
  if (c.spend_limit_minor != null && u.minor >= Number(c.spend_limit_minor)) return 'spend';
  return null;
}

/** Is a card over its operator-set energy or spending limit (in `currency`, default its limit's own)? */
export async function overLimit(c: LimitCard, currency?: string | null): Promise<boolean> {
  return (await limitProblem(c, currency === undefined ? c.spend_limit_currency ?? LEGACY_CURRENCY : currency)) != null;
}

/**
 * The currency a partner location charges in: its country (OCPI alpha-3) → our
 * country table; else the party's country. null when it is not one we support.
 */
export function locationCurrency(loc: { country?: unknown } | null | undefined, partyCountry: string | null | undefined): CurrencyCode | null {
  const a3 = typeof loc?.country === 'string' ? loc.country.toUpperCase() : null;
  const byA3 = a3 ? Object.values(COUNTRIES).find((c) => c.alpha3 === a3) : undefined;
  if (byA3) return byA3.currency;
  if (a3) return null;
  return isCountry(partyCountry) ? currencyOfCountry(partyCountry) : null;
}

/**
 * A CPO asks whether our card may charge now (POST tokens/{uid}/authorize).
 * Returns null for a card we do not share (the caller answers 2004).
 */
export async function authorizeForCpo(partner: PartnerRow, party: Party, uid: string, type: string, body: any) {
  if (type !== 'RFID' && type !== 'APP_USER') return null;
  const kind = type === 'RFID' ? 'rfid' : 'app';
  const c = await one<CardRow>(`SELECT ${CARD_COLS} FROM token WHERE org_id = $1 AND kind = $3 AND uid = $2 AND contract_id IS NOT NULL`, [partner.org_id, uid, kind]);
  if (!c) return null;
  const token = cardToken(party, c);
  // The currency of the charge: the location's country (when the CPO names it), else the partner's.
  const locId = typeof body?.location_id === 'string' ? body.location_id : null;
  const loc = locId
    ? await one<{ data: any; country_code: string }>(`SELECT data, country_code FROM ocpi_remote_location WHERE partner_id = $1 AND location_id = $2 LIMIT 1`, [partner.id, locId])
    : null;
  const currency = locationCurrency(loc?.data, loc?.country_code ?? partner.country_code);
  let allowed: 'ALLOWED' | 'BLOCKED' | 'EXPIRED' | 'NO_CREDIT' | 'NOT_ALLOWED' = 'ALLOWED';
  let why: string | null = null;
  if (!c.roaming_shared) allowed = 'NOT_ALLOWED';
  else if (c.status === 'Blocked') allowed = 'BLOCKED';
  else if (c.status === 'Expired' || (c.valid_to && new Date(c.valid_to) < new Date())) allowed = 'EXPIRED';
  else if (c.status !== 'Accepted') allowed = 'BLOCKED';
  else if (kind === 'app' && !(await openRoamingHold(c.id, currency, partner.id, locId))) {
    // An app driver's charge is guaranteed by a card hold placed before START_SESSION; without one, nothing pays.
    allowed = 'NO_CREDIT';
    why = 'no open payment guarantee for this driver';
  } else {
    const lp = await limitProblem(c, currency);
    if (lp) {
      allowed = lp === 'currency' ? 'NOT_ALLOWED' : 'NO_CREDIT';
      why = lp === 'currency' ? `the card's spending limit is in ${c.spend_limit_currency ?? LEGACY_CURRENCY}, this charge would be in ${currency ?? 'an unsupported currency'}` : null;
    }
  }
  logger.info({ partner: partner.name, uid, allowed, currency, why }, 'roaming card checked by a CPO');
  // Remember the reference we gave: a charge record quoting it is one we approved.
  const ref = allowed === 'ALLOWED' ? randomUUID().replace(/-/g, '').slice(0, 20) : null;
  if (ref) {
    await query(
      `INSERT INTO ocpi_emsp_authorization (org_id, partner_id, token_id, authorization_reference) VALUES ($1,$2,$3,$4)`,
      [partner.org_id, partner.id, c.id, ref],
    );
  }
  return {
    allowed,
    token,
    ...(ref ? { authorization_reference: ref } : {}),
    ...(body?.location_id ? { location: body } : {}),
    ...(allowed !== 'ALLOWED' ? { info: { language: 'en', text: why ? `Card ${allowed.toLowerCase().replace('_', ' ')}: ${why}` : `Card ${allowed.toLowerCase().replace('_', ' ')}` } } : {}),
  };
}

/**
 * An authorised, not yet settled roaming hold for this app token, opened for THIS partner and THIS location
 * (review fix 9: a hold placed for one partner's charger never guarantees a charge elsewhere), not yet tied to a
 * partner session of its own, in `currency` when known. A CPO that names no location gets an answer only for a hold
 * opened with that CPO.
 */
export async function openRoamingHold(tokenId: string, currency: string | null, partnerId: string, locationId: string | null): Promise<boolean> {
  return !!(await one(
    `SELECT 1 FROM driver_roaming_charge rc JOIN payment_intent pi ON pi.id = rc.payment_intent_id
      WHERE rc.token_id = $1 AND rc.settled_at IS NULL AND pi.hold_state = 'held'
        AND rc.partner_id = $3 AND ($4::text IS NULL OR rc.location_id = $4) AND rc.remote_session_id IS NULL
        AND ($2::text IS NULL OR pi.currency = $2) LIMIT 1`,
    [tokenId, currency, partnerId, locationId],
  ));
}

// ─────────────────────────────────────────────── what CPOs send us

export class EmspError extends Error {
  constructor(public http: number, public ocpi: number, message: string) { super(message); }
}

/**
 * What a CPO publishes (locations, tariffs, sessions, CDRs) only comes from that CPO, or a hub relaying for it
 * — and through a hub only from that CPO itself (`acting`, its OCPI-from): one CPO behind a hub never writes
 * under another's party (v1.7.1, WP H0).
 */
async function mustActFor(partner: PartnerRow, cc: string, pid: string, acting: ActingParty | null = null) {
  if (!isActing(acting, cc, pid) || !(await partnerActsFor(partner, cc, pid, 'CPO'))) {
    throw new EmspError(403, STATUS.CLIENT_ERROR, `this connection may not publish for ${cc}*${pid}`);
  }
}

function lastUpdatedOf(b: any): Date {
  const d = new Date(b?.last_updated);
  if (!b?.last_updated || Number.isNaN(d.getTime())) throw new EmspError(400, STATUS.INVALID_PARAMS, 'last_updated is required');
  return d;
}

const merge = (base: any, patch: any) => ({ ...base, ...patch });

/** PUT or PATCH of a location, an EVSE or a connector (OCPI Locations receiver). */
export async function receiveLocation(partner: PartnerRow, method: 'PUT' | 'PATCH', p: { cc: string; pid: string; loc: string; evse?: string; conn?: string }, body: any, acting: ActingParty | null = null) {
  await mustActFor(partner, p.cc, p.pid, acting);
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
  forgetPartners(partner.org_id);
}

/** Drop the driver map's in-memory copy of an organisation's partner locations (driver/roaming.ts registers it). */
let partnerInvalidator: ((orgId: string) => void) | null = null;
export function onPartnerDataChanged(fn: (orgId: string) => void): void { partnerInvalidator = fn; }
const forgetPartners = (orgId: string) => { try { partnerInvalidator?.(orgId); } catch { /* best effort: the version check covers it */ } };

export async function getRemoteLocation(partner: PartnerRow, cc: string, pid: string, loc: string, acting: ActingParty | null = null) {
  if (!isActing(acting, cc, pid)) return null;
  const r = await one<{ data: any }>(
    `SELECT data FROM ocpi_remote_location WHERE partner_id = $1 AND country_code = $2 AND party_id = $3 AND location_id = $4`,
    [partner.id, cc, pid, loc],
  );
  return r?.data ?? null;
}

export async function receiveTariff(partner: PartnerRow, method: 'PUT' | 'DELETE', p: { cc: string; pid: string; id: string }, body: any, acting: ActingParty | null = null) {
  await mustActFor(partner, p.cc, p.pid, acting);
  if (method === 'DELETE') {
    await query(`DELETE FROM ocpi_remote_tariff WHERE partner_id = $1 AND country_code = $2 AND party_id = $3 AND tariff_id = $4`, [partner.id, p.cc, p.pid, p.id]);
    forgetPartners(partner.org_id);
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
  forgetPartners(partner.org_id);
}

export async function getRemoteTariff(partner: PartnerRow, cc: string, pid: string, id: string, acting: ActingParty | null = null) {
  if (!isActing(acting, cc, pid)) return null;
  const r = await one<{ data: any }>(`SELECT data FROM ocpi_remote_tariff WHERE partner_id = $1 AND country_code = $2 AND party_id = $3 AND tariff_id = $4`, [partner.id, cc, pid, id]);
  return r?.data ?? null;
}

/** Which of our cards a session or CDR is about (its cdr_token must be ours). */
async function ourCard(orgId: string, party: Party, t: any): Promise<string> {
  if (!t || t.country_code !== party.country_code || t.party_id !== party.party_id) {
    throw new EmspError(400, STATUS.UNKNOWN_TOKEN, `cdr_token is not a token of ${party.country_code}*${party.party_id}`);
  }
  const c = await one<{ id: string }>(
    `SELECT id FROM token WHERE org_id = $1 AND kind = $3 AND uid = $2 AND contract_id IS NOT NULL`,
    [orgId, t.uid, t.type === 'APP_USER' ? 'app' : 'rfid'],
  );
  if (!c) throw new EmspError(404, STATUS.UNKNOWN_TOKEN, `unknown token ${t.uid}`);
  return c.id;
}

export async function receiveSession(partner: PartnerRow, party: Party, method: 'PUT' | 'PATCH', p: { cc: string; pid: string; id: string }, body: any, acting: ActingParty | null = null) {
  await mustActFor(partner, p.cc, p.pid, acting);
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

export async function getRemoteSession(partner: PartnerRow, cc: string, pid: string, id: string, acting: ActingParty | null = null) {
  if (!isActing(acting, cc, pid)) return null;
  const r = await one<{ data: any }>(`SELECT data FROM ocpi_remote_session WHERE partner_id = $1 AND country_code = $2 AND party_id = $3 AND session_id = $4`, [partner.id, cc, pid, id]);
  return r?.data ?? null;
}

/**
 * Plausibility limits for a partner's charge record. A record beyond them is
 * not refused (the CPO may be right) but HELD for an operator to look at before
 * it reaches a fleet invoice or a card limit.
 *
 *   CDR_MAX_KWH            500 kWh: more than any car or bus battery takes in one
 *                          session (the largest truck packs are around 500 kWh).
 *   price per kWh          per currency (domain/country.ts cdrMaxPricePerKwhMajor),
 *                          a ceiling on total cost per kWh charged (at least one
 *                          kWh is assumed, so a session or parking fee on a
 *                          near-empty charge fits): IDR 25,000, MYR 10.00, SGD 5.00
 *                          — about five times the dearest public DC price in each
 *                          country (2026). A currency PlugSure does not support is
 *                          HELD (fail closed): it could never be checked, billed or
 *                          counted against a limit.
 */
export const CDR_MAX_KWH = 500;

/** Why a charge record's totals look wrong (it is then held), or null. */
export function cdrPlausibilityProblem(c: { currency: string; excl: number; incl: number | null; energyKwh: number; start: Date; end: Date }): string | null {
  if (c.energyKwh > CDR_MAX_KWH) return `total_energy ${c.energyKwh} kWh is above the ${CDR_MAX_KWH} kWh plausibility limit`;
  const cap = cdrMaxPricePerKwh(c.currency);
  if (cap == null) return `unsupported currency ${JSON.stringify(String(c.currency).slice(0, 8))}: it cannot be checked or billed`;
  const total = c.incl ?? c.excl;
  if (total > cap * Math.max(c.energyKwh, 1)) {
    return `total cost ${total} ${c.currency} for ${c.energyKwh} kWh is above ${cap} ${c.currency}/kWh`;
  }
  if (c.incl != null && c.incl < c.excl) return 'total_cost incl_vat is less than excl_vat';
  if (c.end.getTime() - c.start.getTime() > 7 * 24 * 3600_000) return 'the session lasted more than 7 days';
  return null;
}

/**
 * Is this charge record about a charge we know this partner had with our card:
 * a session it reported to us (same party, same card), or an approval we gave
 * it (a real-time authorisation, or a command we sent with that reference)?
 */
async function cdrLinkProblem(partner: PartnerRow, cc: string, pid: string, tokenId: string, b: any): Promise<string | null> {
  if (typeof b?.session_id === 'string' && b.session_id) {
    const s = await one(
      `SELECT 1 FROM ocpi_remote_session
        WHERE partner_id = $1 AND country_code = $2 AND party_id = $3 AND session_id = $4 AND token_id = $5`,
      [partner.id, cc, pid, b.session_id, tokenId],
    );
    if (s) return null;
  }
  const ref = typeof b?.authorization_reference === 'string' && b.authorization_reference ? b.authorization_reference.slice(0, 36) : null;
  if (ref) {
    const a = await one(
      `SELECT 1 FROM ocpi_emsp_authorization WHERE partner_id = $1 AND token_id = $2 AND authorization_reference = $3
       UNION ALL
       SELECT 1 FROM ocpi_command WHERE partner_id = $1 AND token_id = $2 AND request->>'authorization_reference' = $3
       LIMIT 1`,
      [partner.id, tokenId, ref],
    );
    if (a) return null;
  }
  return 'no session reported by this partner for this card, and no authorization of ours, matches the record';
}

/**
 * A CPO posts a charge record (OCPI CDRs receiver). Returns our id for the
 * Location header. A CDR cannot change once sent: the same CDR posted again is
 * acknowledged with the same id, a different one under the same id is refused.
 *
 * Totals that cannot be right (negative, not numbers) are refused. A record that
 * is not linked to a session or approval of ours, or whose totals are beyond the
 * plausibility limits, is stored but HELD: it stays off fleet invoices and card
 * limits until an operator accepts it (Roaming → held charge records).
 */
export async function receiveCdr(partner: PartnerRow, party: Party, b: any, acting: ActingParty | null = null): Promise<string> {
  const cc = String(b?.country_code ?? '');
  const pid = String(b?.party_id ?? '');
  const id = typeof b?.id === 'string' && b.id ? b.id.slice(0, 39) : '';
  if (!id || !cc || !pid) throw new EmspError(400, STATUS.INVALID_PARAMS, 'id, country_code and party_id are required');
  await mustActFor(partner, cc, pid, acting);
  const excl = Number(b?.total_cost?.excl_vat);
  const energy = Number(b?.total_energy);
  const start = new Date(b?.start_date_time);
  const end = new Date(b?.end_date_time);
  if (!Number.isFinite(excl) || !Number.isFinite(energy) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || typeof b?.currency !== 'string') {
    throw new EmspError(400, STATUS.INVALID_PARAMS, 'a CDR needs start/end_date_time, currency, total_cost and total_energy');
  }
  const inclRaw = b?.total_cost?.incl_vat;
  const incl = inclRaw == null ? null : Number(inclRaw);
  if (excl < 0 || energy < 0 || (incl != null && (!Number.isFinite(incl) || incl < 0))) {
    throw new EmspError(400, STATUS.INVALID_PARAMS, 'total_cost and total_energy must be zero or more (send a credit CDR for a refund)');
  }
  if (end < start) throw new EmspError(400, STATUS.INVALID_PARAMS, 'end_date_time is before start_date_time');
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
  const holdReason = cdrPlausibilityProblem({ currency: b.currency, excl, incl, energyKwh: energy, start, end })
    ?? (await cdrLinkProblem(partner, cc, pid, tokenId, b));
  const row = await one<{ id: string }>(
    `INSERT INTO ocpi_remote_cdr (org_id, partner_id, country_code, party_id, cdr_id, session_id, token_id, data, currency,
                                  total_excl_vat, total_incl_vat, total_energy, start_date_time, end_date_time, status, hold_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [partner.org_id, partner.id, cc, pid, id, typeof b.session_id === 'string' ? b.session_id : null, tokenId, JSON.stringify(b),
      b.currency, excl, incl, energy, start, end, holdReason ? 'held' : 'accepted', holdReason],
  );
  if (holdReason) {
    logger.warn({ partner: partner.name, cdr: id, excl, energy, reason: holdReason }, 'roaming CDR held for review');
    bus.emit('alert.raised', {
      orgId: partner.org_id,
      kind: 'roaming.cdr_held',
      severity: 'warning',
      message: `A charge record from roaming partner ${partner.name} (${id}) is held for review: ${holdReason}. It is not billed until you accept it under Roaming.`,
      targetType: 'ocpi_partner',
      targetId: partner.id,
    });
    return row!.id;
  }
  logger.info({ partner: partner.name, cdr: id, excl, energy }, 'roaming CDR received for one of our cards');
  await cdrAccepted(row!.id);
  return row!.id;
}

/**
 * An accepted charge record (on receipt, or when an operator accepts a held one):
 * settle an app driver's roaming hold, and tell the driver's phone(s) the receipt
 * is ready. Never fails the CPO's request.
 */
export async function cdrAccepted(cdrRowId: string): Promise<void> {
  const r = await one<{ id: string; token_id: string | null; currency: string; total_excl_vat: string; total_incl_vat: string | null; data: any; partner_name: string }>(
    `SELECT r.id, r.token_id, r.currency, r.total_excl_vat, r.total_incl_vat, r.data, p.name AS partner_name
       FROM ocpi_remote_cdr r JOIN ocpi_partner p ON p.id = r.partner_id WHERE r.id = $1 AND r.status = 'accepted'`, [cdrRowId]);
  if (!r) return;
  try {
    const { settleRoamingHold } = await import('../driver/roaming-pay.js');
    await settleRoamingHold(r.id);
  } catch (e) {
    logger.error({ cdr: r.id, err: (e as Error).message }, 'roaming hold settlement failed (the sweep retries)');
  }
  notifyCdr(r.token_id, r.id, typeof r.data?.cdr_location?.name === 'string' ? r.data.cdr_location.name : r.partner_name, r.currency, Number(r.total_incl_vat ?? r.total_excl_vat));
}

/** The driver's receipt push for an accepted charge record; `total` in the CDR's major units. */
export function notifyCdr(tokenId: string | null, cdrId: string, site: string, currency: string, total: number): void {
  if (!tokenId) return;
  let money: { totalMinor: number; currency: CurrencyCode } | null = null;
  try { money = isCurrencyCode(currency) ? { totalMinor: toMinor(total, currency), currency } : null; } catch { money = null; }
  void import('../driver/notify.js')
    .then((n) => n.notifyRoamingCdr(tokenId, cdrId, site, money))
    .catch((e) => logger.warn({ err: (e as Error).message }, 'roaming CDR push failed'));
}

/** A charge record we received, by our id (the Location we gave); behind a hub, only the CPO that posted it. */
export async function getRemoteCdr(partner: PartnerRow, ourId: string, acting: ActingParty | null = null) {
  if (!/^[0-9a-f-]{36}$/i.test(ourId)) return null;
  const r = await one<{ data: any }>(
    `SELECT data FROM ocpi_remote_cdr WHERE id = $1 AND partner_id = $2 AND ($3::text IS NULL OR (country_code = $3 AND party_id = $4))`,
    [ourId, partner.id, acting?.country_code ?? null, acting?.party_id ?? null]);
  return r?.data ?? null;
}

// ─────────────────────────────────────────────── importing a CPO's network

/** Pull a CPO partner's locations and tariffs (paged, following the Link header). */
export async function importFromCpo(partner: PartnerRow): Promise<{ locations: number; tariffs: number }> {
  const party = await getParty(partner.org_id);
  if (!party || !partner.token_out || partner.state !== 'connected') return { locations: 0, tariffs: 0 };
  // Only a charge point operator (or a hub relaying for them) has a network to import.
  if (partner.kind !== 'cpo' && partner.kind !== 'hub') return { locations: 0, tariffs: 0 };
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
  /** START_SESSION for an app driver: the payment intent of the hold that guarantees it (§D7). */
  authorizationReference?: string;
}) {
  const party = await getParty(o.orgId);
  const p = await one<PartnerRow>(`SELECT * FROM ocpi_partner WHERE id = $1 AND org_id = $2 AND state = 'connected'`, [o.partnerId, o.orgId]);
  if (!party || !p || !p.token_out) throw new EmspError(409, STATUS.CLIENT_ERROR, 'the partner is not connected');
  const url = endpointUrl(p, 'commands', 'RECEIVER');
  if (!url) throw new EmspError(409, STATUS.CLIENT_ERROR, 'this partner does not accept commands');
  // The CPO posts the outcome to this URL: it must be our configured public origin,
  // never one derived from a request header (only development/test fall back to it).
  const base = config.ocpi.publicUrl || (isRelaxedEnv() ? o.base : '');
  if (!base) throw new EmspError(503, STATUS.SERVER_ERROR, 'roaming is not configured: set OCPI_PUBLIC_URL (or PUBLIC_BASE_URL) before sending commands to partners');
  const id = randomUUID();
  const responseUrl = `${base}/ocpi/2.2.1/emsp/commands/${o.command}/${id}`;
  let body: Record<string, unknown>;
  if (o.command === 'START_SESSION' || o.command === 'RESERVE_NOW') {
    const c = await one<CardRow>(`SELECT ${CARD_COLS} FROM token WHERE id = $1 AND org_id = $2 AND kind IN ('rfid', 'app')`, [o.tokenId, o.orgId]);
    if (!c?.roaming_shared || !c.contract_id) throw new EmspError(422, STATUS.INVALID_PARAMS, 'choose a card that is shared for roaming');
    if (!o.locationId) throw new EmspError(422, STATUS.INVALID_PARAMS, 'choose a location');
    body = {
      response_url: responseUrl, token: cardToken(party, c), location_id: o.locationId,
      ...(o.evseUid ? { evse_uid: o.evseUid } : {}),
      ...(o.command === 'START_SESSION' && o.connectorId ? { connector_id: o.connectorId } : {}),
      authorization_reference: o.authorizationReference ? o.authorizationReference.slice(0, 36) : id.replace(/-/g, '').slice(0, 20),
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
  const to = o.locationParty ?? { country_code: p.country_code, party_id: p.party_id };
  // The party the command is addressed to is stored with it (not sent): through a hub only that party may
  // post the result (receiveCommandResult).
  await query(
    `INSERT INTO ocpi_command (id, org_id, partner_id, command, token_id, request, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, o.orgId, p.id, o.command, o.tokenId ?? null, JSON.stringify({ ...body, to }), o.userId ?? null],
  );
  const r = await ocpiCall({
    orgId: o.orgId, partnerId: p.id, method: 'POST', url: `${url}/${o.command}`, token: unseal(p.token_out), body, from: party, to,
  });
  const answer = r.ok ? String(r.data?.result ?? 'ACCEPTED') : 'FAILED';
  const message = r.ok ? (r.data?.message?.[0]?.text ?? null) : r.error;
  await query(`UPDATE ocpi_command SET response = $2, message = $3, responded_at = now() WHERE id = $1`, [id, answer, message]);
  return { id, response: answer, message };
}

/**
 * The CPO posts the charger's outcome to the response_url we gave it. Behind a hub (`acting` = the CPO in
 * OCPI-from), only the party the command was addressed to may answer it (v1.7.1, WP H0). A command addressed
 * to the hub itself (no CPO party known when it was sent), or stored before v1.7.1, names no CPO: any CPO
 * the hub announced may answer it, as before.
 */
export async function receiveCommandResult(partner: PartnerRow, command: string, id: string, b: any, acting: ActingParty | null = null): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const result = typeof b?.result === 'string' ? b.result.slice(0, 40) : null;
  if (!result) throw new EmspError(400, STATUS.INVALID_PARAMS, 'result is required');
  const r = await query(
    `UPDATE ocpi_command SET result = $4, message = COALESCE($5, message), result_at = now()
      WHERE id = $1 AND partner_id = $2 AND command = $3
        AND ($6::text IS NULL
             OR request->'to'->>'country_code' IS NULL
             OR (request->'to'->>'country_code' = $8 AND request->'to'->>'party_id' = $9)
             OR (request->'to'->>'country_code' = $6 AND request->'to'->>'party_id' = $7))`,
    [id, partner.id, command, result, b?.message?.[0]?.text ?? null, acting?.country_code ?? null, acting?.party_id ?? null,
      partner.country_code ?? '', partner.party_id ?? ''],
  );
  return (r.rowCount ?? 0) > 0;
}
