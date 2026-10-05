import { randomBytes } from 'node:crypto';
import { one, many, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sendCommand, EmspError } from '../ocpi/emsp.js';
import { fleetTokenProblem } from './charge.js';
import { locationCurrency, onPartnerDataChanged } from '../ocpi/emsp.js';
import { isCurrency, toMinor, unitOf, type CurrencyCode } from '../domain/money.js';
import { emspOrgForApp, roamingPaymentFor, placeRoamingHold, startAfterHold, releaseRoamingHold, holdOf, roamingSettingsOf, holdAmount } from './roaming-pay.js';
import type { DriverPrincipal } from './identity.js';

/**
 * Roaming in the driver app: a fleet driver whose card may roam charges at a
 * partner operator's charger (PlugSure as the eMSP, OCPI 2.2.1).
 *
 * Only fleet drivers: a roaming charge is billed afterwards (the operator sends
 * a charge record, the fleet is invoiced), and only a fleet card has someone to
 * bill. Guest and QRIS drivers pay upfront at PlugSure chargers only.
 *
 * Everything here reads what the partner operators reported (their network,
 * our driver's session, their charge record); PlugSure does not meter these
 * sessions itself, so the app says "per the operator" where it shows numbers.
 */

export const LABEL: Record<string, string> = {
  IEC_62196_T2: 'Type 2', IEC_62196_T2_COMBO: 'CCS2', CHADEMO: 'CHAdeMO', GBT_AC: 'GB/T', GBT_DC: 'GB/T',
  IEC_62196_T1: 'Type 1', IEC_62196_T1_COMBO: 'CCS1', TESLA_S: 'Tesla', TESLA_R: 'Tesla',
};

/** OCPI EVSE status -> the app's own status words (same as PlugSure chargers). */
export const STATUS: Record<string, string> = {
  AVAILABLE: 'Available', CHARGING: 'Charging', RESERVED: 'Occupied', BLOCKED: 'Occupied',
  OUTOFORDER: 'Faulted', INOPERATIVE: 'Maintenance', UNKNOWN: 'Offline', PLANNED: 'Unavailable',
};

export interface Eligibility {
  enabled: boolean; reason?: string; tokenId?: string; orgId?: string;
  /** fleet: billed on the fleet's invoice; app: a signed-in driver, guaranteed by a card hold (roaming-pay.ts). */
  mode?: 'fleet' | 'app';
  /** fleet: the card's spending-limit currency when it has a limit (charges in another currency are refused). */
  limitCurrency?: string | null;
}

/**
 * May this driver roam? A fleet card that the fleet operator shared for roaming; or a
 * signed-in app driver, when the operator offers partner networks to app drivers
 * (docs/MULTI-COUNTRY-DESIGN.md §D7) — each charge then needs a card hold.
 */
export async function roamingEligibility(p: DriverPrincipal, brandOrgId: string | null = null): Promise<Eligibility> {
  if (!p.fleet) {
    const org = p.appDriverId ? await emspOrgForApp(brandOrgId) : null;
    if (org) return { enabled: true, orgId: org, mode: 'app' };
    if (!p.appDriverId && (await emspOrgForApp(brandOrgId))) return { enabled: false, reason: 'Masuk untuk mengisi di jaringan mitra.' };
    return { enabled: false, reason: 'Jaringan mitra tersedia untuk pengemudi armada dengan kartu roaming.' };
  }
  const t = await one<{ roaming_shared: boolean; contract_id: string | null; spend_limit_minor: number | null; spend_limit_currency: string }>(
    `SELECT roaming_shared, contract_id, spend_limit_minor, spend_limit_currency FROM token WHERE id = $1`, [p.fleet.tokenId],
  );
  if (!t?.roaming_shared || !t.contract_id) return { enabled: false, reason: 'Kartu Anda belum diaktifkan untuk jaringan mitra. Hubungi admin armada Anda.' };
  return { enabled: true, tokenId: p.fleet.tokenId, orgId: p.fleet.orgId, mode: 'fleet', limitCurrency: t.spend_limit_minor != null ? t.spend_limit_currency : null };
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)) * 10) / 10;
}

export interface RoamingStation {
  partnerId: string; countryCode: string; partyId: string; locationId: string;
  name: string; address: string | null; city: string | null; operator: string;
  lat: number | null; lon: number | null; distanceKm: number | null;
  evses: Array<{ uid: string; evseId: string; status: string; available: boolean;
    connectors: Array<{ id: string; typeLabel: string; current: 'AC' | 'DC'; maxPowerKw: number | null }> }>;
  availableCount: number; totalCount: number; fastest: string | null;
  /** The operator's energy price per kWh, before tax, when it publishes one: in `priceCurrency` (major units in priceFromMajor; minor, rounded, in priceFromMinor). */
  priceFromMinor: number | null;
  priceFromMajor: number | null;
  priceCurrency: string | null;
  vatPercent: number | null;
  /** The currency the charge is paid in (the location's country). null: one PlugSure does not support. */
  currency: string | null;
  /** Whether this driver can start here, and why not. */
  startable: boolean;
  reason: string | null;
  reasonCode: RoamingReasonCode;
  /** App drivers: the card hold placed before the charge starts, in `currency`. */
  holdMinor: number | null;
  savedCards: Array<{ id: string; brand: string | null; last4: string | null }>;
}

export interface RoamingListOptions {
  /**
   * Leave out partner locations of an operator hosted on this platform (it also joined the hub, so its chargers
   * came back through it): the app shows those directly, where guests can charge too (G5). For lists that also
   * show every hosted operator (the PlugSure app, the unbranded web app); never for an operator's own app.
   */
  dedupe?: boolean;
  /** Only locations inside this viewport [w, s, e, n] (the map): the rest are not built at all. */
  bbox?: readonly [number, number, number, number];
  /** Nearest-first ordering of the answer (default true); the map orders its own merged list. */
  sort?: boolean;
}

type RemoteRow = { partner_id: string; partner_name: string; country_code: string; party_id: string; location_id: string; data: any; lat: number; lon: number };
type TariffRow = { partner_id: string; country_code: string; party_id: string; tariff_id: string; data: any };

/**
 * The partner locations and tariffs an eMSP organisation received, kept in memory per (organisation, dedupe) — the
 * map asks for them on every pan. Each use checks a cheap version (row counts and the newest row version of the
 * organisation's locations, tariffs and partners, `xmin`), so an OCPI push, a pull, a partner closed — in this
 * process or another — is seen at once; receivers also drop the entry (`forgetPartnerLocations`). A TTL bounds the
 * dedupe part (another operator's sites), which the version does not cover.
 */
const PARTNER_TTL_MS = 60_000;
const partnerCache = new Map<string, { version: string; at: number; rows: RemoteRow[]; tariffs: Map<string, TariffRow> }>();
export const partnerCacheStats = { hits: 0, loads: 0 };

onPartnerDataChanged((orgId) => forgetPartnerLocations(orgId));

export function forgetPartnerLocations(orgId?: string): void {
  if (!orgId) { partnerCache.clear(); return; }
  for (const k of partnerCache.keys()) if (k.startsWith(`${orgId}:`)) partnerCache.delete(k);
}

async function partnerData(orgId: string, dedupe: boolean): Promise<{ rows: RemoteRow[]; tariffs: Map<string, TariffRow> }> {
  const v = (await one<{ v: string }>(
    `SELECT concat_ws('|',
       (SELECT count(*) || ':' || COALESCE(max(xmin::text::bigint), 0) FROM ocpi_remote_location WHERE org_id = $1),
       (SELECT count(*) || ':' || COALESCE(max(xmin::text::bigint), 0) FROM ocpi_remote_tariff WHERE org_id = $1),
       (SELECT count(*) || ':' || COALESCE(max(xmin::text::bigint), 0) FROM ocpi_partner WHERE org_id = $1)) AS v`, [orgId]))?.v ?? '';
  const key = `${orgId}:${dedupe ? 1 : 0}`;
  const hit = partnerCache.get(key);
  if (hit && hit.version === v && Date.now() - hit.at < PARTNER_TTL_MS) { partnerCacheStats.hits++; return hit; }
  partnerCacheStats.loads++;
  const raw = await many<Omit<RemoteRow, 'lat' | 'lon'>>(
    `SELECT l.partner_id, p.name AS partner_name, l.country_code, l.party_id, l.location_id, l.data
       FROM ocpi_remote_location l JOIN ocpi_partner p ON p.id = l.partner_id
      WHERE l.org_id = $1 AND p.state = 'connected' AND COALESCE((l.data->>'publish')::boolean, true)
        AND (NOT $2::boolean OR NOT EXISTS (
              SELECT 1 FROM ocpi_party op JOIN organisation o ON o.id = op.org_id
               WHERE op.country_code = l.country_code AND op.party_id = l.party_id
                 AND o.hub_only IS NOT TRUE AND o.sandbox_of_org_id IS NULL AND o.archived_at IS NULL
                 AND EXISTS (SELECT 1 FROM site s WHERE s.org_id = o.id AND s.archived_at IS NULL)))`,
    [orgId, dedupe],
  );
  const rows = raw.map((r) => ({ ...r, lat: Number(r.data?.coordinates?.latitude), lon: Number(r.data?.coordinates?.longitude) }));
  const tariffs = new Map<string, TariffRow>();
  for (const t of await many<TariffRow>(
    `SELECT t.partner_id, t.country_code, t.party_id, t.tariff_id, t.data
       FROM ocpi_remote_tariff t JOIN ocpi_partner p ON p.id = t.partner_id
      WHERE t.org_id = $1 AND p.state = 'connected'`,
    [orgId],
  )) tariffs.set(`${t.partner_id}|${t.country_code}|${t.party_id}|${t.tariff_id}`, t);
  const entry = { version: v, at: Date.now(), rows, tariffs };
  partnerCache.set(key, entry);
  return entry;
}

const inBbox = (lat: number, lon: number, b: readonly [number, number, number, number]) =>
  Number.isFinite(lat) && Number.isFinite(lon) && lat >= b[1] && lat <= b[3] && (b[0] <= b[2] ? lon >= b[0] && lon <= b[2] : lon >= b[0] || lon <= b[2]);

/** Why a partner station cannot be started from the app, as a code the native app can switch on. */
export type RoamingReasonCode = 'sign_in' | 'payment' | 'fleet_limit' | null;

/** Partner operators' stations this driver's card can use, nearest first when a location is given. */
export async function listRoamingStations(p: DriverPrincipal, loc?: { lat: number; lon: number }, brandOrgId: string | null = null, opts: RoamingListOptions = {}) {
  const el = await roamingEligibility(p, brandOrgId);
  if (!el.enabled) return { enabled: false, reason: el.reason, stations: [] as RoamingStation[] };
  const stations = await roamingStationsOf(el.orgId!, { mode: el.mode!, limitCurrency: el.limitCurrency ?? null, appDriverId: p.appDriverId }, loc, opts);
  // fleet: billed to the company; app: a hold on the driver's card in the partner's currency.
  return { enabled: true, mode: el.mode, stations };
}

/**
 * The partner stations an eMSP organisation receives (from the hub or bilateral OCPI), for one kind of driver:
 * fleet card, signed-in app driver, or a guest (visible on the map, not startable: sign in first).
 */
export async function roamingStationsOf(
  emspOrgId: string,
  who: { mode: 'fleet' | 'app' | 'guest'; limitCurrency?: string | null; appDriverId?: string | null },
  loc?: { lat: number; lon: number },
  opts: RoamingListOptions = {},
): Promise<RoamingStation[]> {
  const el = { orgId: emspOrgId, mode: who.mode, limitCurrency: who.limitCurrency ?? null };
  const p = { appDriverId: who.appDriverId ?? null };
  const settings = who.mode === 'guest' ? await roamingSettingsOf(emspOrgId) : null;
  // App drivers: what each currency's acquirer allows (looked up once per currency).
  const payFor = new Map<string, Awaited<ReturnType<typeof roamingPaymentFor>>>();
  const payment = async (cur: CurrencyCode | null) => {
    const k = cur ?? '-';
    if (!payFor.has(k)) payFor.set(k, await roamingPaymentFor(el.orgId!, cur, p.appDriverId));
    return payFor.get(k)!;
  };
  const cached = await partnerData(el.orgId!, opts.dedupe === true);
  const rows = opts.bbox ? cached.rows.filter((r) => inBbox(r.lat, r.lon, opts.bbox!)) : cached.rows;
  const tariffOf = (r: { partner_id: string; country_code: string; party_id: string }, id: string) =>
    cached.tariffs.get(`${r.partner_id}|${r.country_code}|${r.party_id}|${id}`);

  const out: RoamingStation[] = [];
  for (const r of rows) {
    const d = r.data ?? {};
    const { lat, lon } = r;
    const currency = locationCurrency(d, r.country_code);
    let price: number | null = null;
    let priceCur: string | null = null;
    let vat: number | null = null;
    const evses = (d.evses ?? []).filter((e: any) => e.status !== 'REMOVED').map((e: any) => {
      const status = STATUS[e.status] ?? 'Unavailable';
      const connectors = (e.connectors ?? []).map((c: any) => {
        for (const tid of c.tariff_ids ?? []) {
          const t = tariffOf(r, tid);
          // Prices in the charge's currency only (a tariff in another currency would be compared across currencies).
          if (!t || !isCurrency(t.data?.currency) || (currency && t.data.currency !== currency)) continue;
          for (const el of t.data.elements ?? []) {
            for (const pc of el.price_components ?? []) {
              if (pc.type === 'ENERGY' && Number.isFinite(Number(pc.price)) && (price == null || Number(pc.price) < price)) {
                price = Number(pc.price);
                priceCur = t.data.currency;
                vat = pc.vat != null ? Number(pc.vat) : null;
              }
            }
          }
        }
        return {
          id: String(c.id),
          typeLabel: LABEL[c.standard] ?? String(c.standard ?? '—'),
          current: (c.power_type === 'DC' ? 'DC' : 'AC') as 'AC' | 'DC',
          maxPowerKw: c.max_electric_power != null ? Math.round(Number(c.max_electric_power) / 100) / 10 : null,
        };
      });
      return { uid: String(e.uid), evseId: String(e.evse_id ?? e.uid), status, available: status === 'Available', connectors };
    });
    const all = evses.flatMap((e: any) => e.connectors) as Array<{ current: string; maxPowerKw: number | null }>;
    const fastest = all.reduce<{ current: string; maxPowerKw: number | null } | null>((a, c) => ((c.maxPowerKw ?? 0) > (a?.maxPowerKw ?? -1) ? c : a), null);
    let startable = true;
    let reason: string | null = null;
    let reasonCode: RoamingReasonCode = null;
    let holdMinor: number | null = null;
    let savedCards: Array<{ id: string; brand: string | null; last4: string | null }> = [];
    if (el.mode === 'app') {
      const pay = await payment(currency);
      startable = pay.startable;
      reason = pay.reason;
      reasonCode = pay.startable ? null : 'payment';
      holdMinor = pay.holdMinor;
      savedCards = pay.savedCards;
    } else if (el.mode === 'guest') {
      startable = false;
      reason = 'Masuk untuk mengisi di jaringan mitra.';
      reasonCode = 'sign_in';
      holdMinor = currency && isCurrency(currency) ? holdAmount(settings!, currency as CurrencyCode) : null;
    } else if (el.limitCurrency && currency !== el.limitCurrency) {
      startable = false;
      reason = `Batas biaya kartu armada Anda dalam ${el.limitCurrency}; jaringan ini menagih dalam ${currency ?? 'mata uang lain'}.`;
      reasonCode = 'fleet_limit';
    }
    out.push({
      partnerId: r.partner_id, countryCode: r.country_code, partyId: r.party_id, locationId: r.location_id,
      name: String(d.name ?? d.address ?? r.location_id), address: [d.address, d.city].filter(Boolean).join(', ') || null, city: d.city ?? null,
      operator: d.operator?.name ?? r.partner_name,
      lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null,
      distanceKm: loc && Number.isFinite(lat) && Number.isFinite(lon) ? haversineKm(loc.lat, loc.lon, lat, lon) : null,
      evses,
      availableCount: evses.filter((e: any) => e.available).length,
      totalCount: evses.length,
      fastest: fastest?.maxPowerKw != null ? `${fastest.maxPowerKw} kW ${fastest.current}` : null,
      // IDR (exponent 0): the rupiah rate itself, as before; other currencies rounded to the sen/cent (priceFromMajor is exact).
      priceFromMinor: price != null && priceCur ? (unitOf(priceCur).exponent === 0 ? price : toMinor(price, priceCur as CurrencyCode)) : null,
      priceFromMajor: price,
      priceCurrency: priceCur,
      vatPercent: vat,
      currency,
      startable,
      reason,
      reasonCode,
      holdMinor,
      // App drivers: the cards saved with this currency's acquirer (the hold can go on one without a checkout).
      savedCards,
    });
  }
  if (opts.sort !== false) {
    out.sort((a, b) =>
      a.distanceKm != null && b.distanceKm != null ? a.distanceKm - b.distanceKm
        : (b.availableCount > 0 ? 1 : 0) - (a.availableCount > 0 ? 1 : 0) || a.name.localeCompare(b.name));
  }
  return out;
}

// ─────────────────────────────────────────────── charging

export interface RoamingStart { partnerId: string; countryCode: string; partyId: string; locationId: string; evseUid: string; connectorId?: string }
/** App drivers: how the hold is paid (a saved card, or a new card through the acquirer's checkout). */
export interface RoamingPay { savedCardId?: string | null; saveCard?: boolean; returnUrl?: string }

export async function startRoaming(
  p: DriverPrincipal, s: RoamingStart, base: string, brandOrgId: string | null = null, pay: RoamingPay = {},
): Promise<{ ok: boolean; chargeId?: string; error?: string; code?: string; payment?: Record<string, unknown> }> {
  const el = await roamingEligibility(p, brandOrgId);
  if (!el.enabled) return { ok: false, error: el.reason };
  const { stations } = await listRoamingStations(p, undefined, brandOrgId);
  const st = stations.find((x) => x.partnerId === s.partnerId && x.countryCode === s.countryCode && x.partyId === s.partyId && x.locationId === s.locationId);
  const evse = st?.evses.find((e) => e.uid === s.evseUid);
  if (!st || !evse) return { ok: false, error: 'Charger mitra tidak ditemukan.' };
  if (el.mode === 'fleet') {
    const problem = await fleetTokenProblem(el.tokenId!, el.limitCurrency ? st.currency : null);
    if (problem) return { ok: false, error: problem };
  }
  if (!st.startable) return { ok: false, error: st.reason ?? 'Charger ini sedang tidak tersedia.', code: 'not_startable' };
  // The driver's own reservation shows as RESERVED at the operator: that one they may start.
  const mine = await one<{ id: string }>(
    `SELECT id FROM driver_roaming_reservation WHERE device_id = $1 AND partner_id = $2 AND location_id = $3 AND evse_uid = $4 AND state = 'active'`,
    [p.deviceId, s.partnerId, s.locationId, s.evseUid]);
  if (!evse.available && !mine) return { ok: false, error: 'Charger ini sedang tidak tersedia.' };
  const connectorId = s.connectorId ?? evse.connectors[0]?.id;
  if (el.mode === 'app') {
    // The guarantee first: a card hold in the location's currency; START_SESSION only once it is authorised.
    const h = await placeRoamingHold({
      orgId: el.orgId!, appDriverId: p.appDriverId!, deviceId: p.deviceId, currency: st.currency as CurrencyCode,
      partnerId: s.partnerId, countryCode: s.countryCode, partyId: s.partyId, locationId: s.locationId, evseUid: s.evseUid, connectorId: connectorId ?? null,
      savedCardId: pay.savedCardId ?? null, saveCard: pay.saveCard === true, returnUrl: pay.returnUrl ?? '/app/paid.html',
      description: `${st.operator} ${st.name}`.slice(0, 120),
    });
    if (!h.ok) return { ok: false, error: h.error, code: h.code };
    const payment = {
      hold: true, currency: st.currency, amountMinor: h.holdMinor, action: h.payment.action, checkoutUrl: h.payment.checkoutUrl,
      providerRef: h.payment.providerRef, expiresAt: h.payment.expiresAt, savedCardId: h.payment.savedCardId,
    };
    if (h.payment.immediate === 'authorised') {
      const started = await startAfterHold(h.chargeId, base);
      if (started === 'refused') return { ok: false, chargeId: h.chargeId, error: 'Operator menolak permintaan. Dana yang ditahan sudah dilepas.' };
    }
    await query(
      `UPDATE driver_roaming_reservation SET state = 'used', ended_at = now()
        WHERE device_id = $1 AND partner_id = $2 AND location_id = $3 AND evse_uid = $4 AND state IN ('requested','active')`,
      [p.deviceId, s.partnerId, s.locationId, s.evseUid],
    );
    return { ok: true, chargeId: h.chargeId, payment };
  }
  try {
    const r = await sendCommand({
      orgId: el.orgId!, partnerId: s.partnerId, command: 'START_SESSION', base, tokenId: el.tokenId,
      locationId: s.locationId, evseUid: s.evseUid, connectorId, locationParty: { country_code: s.countryCode, party_id: s.partyId },
    });
    if (r.response !== 'ACCEPTED') {
      return { ok: false, error: `Operator menolak permintaan (${r.response.toLowerCase()}). Coba tempelkan kartu Anda di charger.` };
    }
    const row = await one<{ id: string }>(
      `INSERT INTO driver_roaming_charge (org_id, device_id, token_id, partner_id, country_code, party_id, location_id, evse_uid, connector_id, start_command_id, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [el.orgId, p.deviceId, el.tokenId, s.partnerId, s.countryCode, s.partyId, s.locationId, s.evseUid, connectorId ?? null, r.id, st.currency],
    );
    // Charging where the driver held a reservation uses it up.
    await query(
      `UPDATE driver_roaming_reservation SET state = 'used', ended_at = now()
        WHERE device_id = $1 AND partner_id = $2 AND location_id = $3 AND evse_uid = $4 AND state IN ('requested','active')`,
      [p.deviceId, s.partnerId, s.locationId, s.evseUid],
    );
    return { ok: true, chargeId: row!.id };
  } catch (e) {
    if (e instanceof EmspError) return { ok: false, error: 'Operator mitra sedang tidak dapat dihubungi. Coba tempelkan kartu Anda di charger.' };
    throw e;
  }
}

interface RoamRow {
  id: string; org_id: string; device_id: string; token_id: string; partner_id: string; country_code: string; party_id: string;
  location_id: string; evse_uid: string; connector_id: string | null; start_command_id: string | null; stop_command_id: string | null;
  remote_session_id: string | null; created_at: Date;
  app_driver_id: string | null; payment_intent_id: string | null; currency: string | null; settled_at: Date | null; settle_outcome: string | null;
  start_requested_at: Date | null;
}

/** A roaming charge belongs to the phone that started it, to the fleet card it charged, or to the app driver who paid its hold. */
async function ownedRoaming(p: DriverPrincipal, id: string): Promise<RoamRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await one<RoamRow>(`SELECT * FROM driver_roaming_charge WHERE id = $1`, [id]);
  if (!r) return null;
  if (r.device_id === p.deviceId || (p.fleet && r.token_id === p.fleet.tokenId) || (p.appDriverId && r.app_driver_id === p.appDriverId)) return r;
  return null;
}

/** The operator's session for this charge, linked once it has been reported. */
async function sessionOf(r: RoamRow) {
  if (r.remote_session_id) return one<{ id: string; session_id: string; status: string | null; kwh: string | null; data: any }>(`SELECT id, session_id, status, kwh, data FROM ocpi_remote_session WHERE id = $1`, [r.remote_session_id]);
  const s = await one<{ id: string; session_id: string; status: string | null; kwh: string | null; data: any }>(
    `SELECT id, session_id, status, kwh, data FROM ocpi_remote_session
      WHERE partner_id = $1 AND token_id = $2 AND data->>'location_id' = $3 AND received_at >= $4::timestamptz - interval '1 minute'
      ORDER BY received_at DESC LIMIT 1`,
    [r.partner_id, r.token_id, r.location_id, r.created_at],
  );
  if (s) await query(`UPDATE driver_roaming_charge SET remote_session_id = $2 WHERE id = $1 AND remote_session_id IS NULL`, [r.id, s.id]);
  return s;
}

/**
 * A partner-network charge as the live session pass sees it (services/live-activity.ts, G3): what the operator has
 * reported so far, outside any driver request. Null when the charge does not exist or has no session yet.
 */
export async function roamingLiveSnapshot(chargeId: string): Promise<{
  active: boolean; kwh: number; startedAt: Date | null; endedAt: Date | null; currency: string | null;
  sessionTotal: string | null; cdrTotal: string | null; site: string; connector: string;
} | null> {
  const r = await one<RoamRow>(`SELECT * FROM driver_roaming_charge WHERE id = $1`, [chargeId]);
  if (!r) return null;
  const s = await sessionOf(r);
  if (!s) return null;
  const cdr = await one<{ total_incl_vat: string | null; total_excl_vat: string; currency: string }>(
    `SELECT total_incl_vat, total_excl_vat, currency FROM ocpi_remote_cdr WHERE partner_id = $1 AND session_id = $2 AND status = 'accepted' ORDER BY received_at DESC LIMIT 1`,
    [r.partner_id, s.session_id]);
  const loc = await one<{ data: any }>(
    `SELECT data FROM ocpi_remote_location WHERE partner_id = $1 AND country_code = $2 AND party_id = $3 AND location_id = $4`,
    [r.partner_id, r.country_code, r.party_id, r.location_id]);
  const evse = (loc?.data?.evses ?? []).find((e: any) => e.uid === r.evse_uid);
  const conn = (evse?.connectors ?? []).find((c: any) => c.id === r.connector_id) ?? evse?.connectors?.[0];
  const active = s.status === 'ACTIVE' || s.status === 'PENDING';
  const tc = s.data?.total_cost;
  return {
    active,
    kwh: s.kwh != null ? Number(s.kwh) : Number(s.data?.kwh ?? 0),
    startedAt: s.data?.start_date_time ? new Date(s.data.start_date_time) : null,
    endedAt: active ? null : s.data?.end_date_time ? new Date(s.data.end_date_time) : s.data?.last_updated ? new Date(s.data.last_updated) : null,
    currency: (cdr?.currency ?? s.data?.currency ?? r.currency ?? null) as string | null,
    sessionTotal: tc ? String(tc.incl_vat ?? tc.excl_vat) : null,
    cdrTotal: cdr ? String(cdr.total_incl_vat ?? cdr.total_excl_vat) : null,
    site: String(loc?.data?.name ?? r.location_id),
    connector: conn ? `${LABEL[conn.standard] ?? conn.standard ?? ''}${conn.max_electric_power ? ` ${Math.round(conn.max_electric_power / 1000)} kW` : ''}`.trim() : r.evse_uid,
  };
}

/** A roaming charge this device (or its account / fleet card) may follow. */
export async function roamingChargeOf(deviceId: string, chargeId: string): Promise<{ id: string; org_id: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(chargeId)) return null;
  return one<{ id: string; org_id: string }>(
    `SELECT rc.id, rc.org_id FROM driver_roaming_charge rc JOIN driver_device d ON d.id = $2
      WHERE rc.id::text = $1 AND (rc.device_id = d.id OR rc.token_id = d.fleet_token_id OR (rc.app_driver_id IS NOT NULL AND rc.app_driver_id = d.app_driver_id))`,
    [chargeId.toLowerCase(), deviceId]);
}

export async function roamingStatus(p: DriverPrincipal, id: string, base: string | null = null) {
  let r = await ownedRoaming(p, id);
  if (!r) return null;
  // An app driver's hold authorised after a card checkout: START_SESSION goes now (or by the worker).
  if (r.payment_intent_id && !r.start_requested_at && !r.settled_at && base) {
    await startAfterHold(r.id, base);
    r = (await ownedRoaming(p, id)) ?? r;
  }
  const hold = r.payment_intent_id ? await holdOf(r.id) : null;
  const loc = await one<{ data: any; partner_name: string }>(
    `SELECT l.data, pa.name AS partner_name FROM ocpi_partner pa
       LEFT JOIN ocpi_remote_location l ON l.partner_id = pa.id AND l.country_code = $2 AND l.party_id = $3 AND l.location_id = $4
      WHERE pa.id = $1`,
    [r.partner_id, r.country_code, r.party_id, r.location_id],
  );
  const cmd = r.start_command_id ? await one<{ response: string | null; result: string | null; message: string | null }>(`SELECT response, result, message FROM ocpi_command WHERE id = $1`, [r.start_command_id]) : null;
  const s = await sessionOf(r);
  // Only an ACCEPTED partner record is the driver's bill: a held one is still in the operator's review.
  const cdr = s ? await one<{ id: string; total_incl_vat: string | null; total_excl_vat: string; total_energy: string; currency: string }>(
    `SELECT id, total_incl_vat, total_excl_vat, total_energy, currency FROM ocpi_remote_cdr
      WHERE partner_id = $1 AND session_id = $2 AND status = 'accepted' ORDER BY received_at DESC LIMIT 1`, [r.partner_id, s.session_id]) : null;

  let state: 'paying' | 'starting' | 'rejected' | 'charging' | 'finishing' | 'billed';
  let problem: string | null = null;
  if (cdr) state = 'billed';
  else if (s) state = s.status === 'ACTIVE' || s.status === 'PENDING' ? 'charging' : 'finishing';
  else if (cmd?.result && cmd.result !== 'ACCEPTED') {
    state = 'rejected';
    problem = { EVSE_OCCUPIED: 'Charger sedang dipakai.', EVSE_INOPERATIVE: 'Charger sedang tidak berfungsi.', TIMEOUT: 'Charger tidak merespons.' }[cmd.result]
      ?? 'Charger tidak dapat dimulai.';
  } else if (r.payment_intent_id && r.settle_outcome === 'not_started') {
    state = 'rejected';
    problem = hold?.state === 'failed' || hold?.state === 'expired' ? 'Pembayaran tidak selesai. Tidak ada yang ditagih.' : 'Charger tidak dapat dimulai. Dana yang ditahan sudah dilepas.';
  } else if (r.payment_intent_id && hold?.state === 'pending') state = 'paying';
  else state = 'starting';
  // A start refused by the charger: the hold is released at once.
  if (state === 'rejected' && r.payment_intent_id && !r.settled_at) await releaseRoamingHold(r.id, 'not_started');

  const started = s?.data?.start_date_time ? new Date(s.data.start_date_time) : null;
  const ended = s?.data?.end_date_time ? new Date(s.data.end_date_time) : null;
  const evse = (loc?.data?.evses ?? []).find((e: any) => e.uid === r.evse_uid);
  const conn = (evse?.connectors ?? []).find((c: any) => c.id === r.connector_id) ?? evse?.connectors?.[0];
  const total = cdr ? Number(cdr.total_incl_vat ?? cdr.total_excl_vat) : s?.data?.total_cost ? Number(s.data.total_cost.incl_vat ?? s.data.total_cost.excl_vat) : null;
  return {
    chargeId: r.id,
    state,
    problem,
    energyKwh: cdr ? Number(cdr.total_energy) : s?.kwh != null ? Number(s.kwh) : 0,
    durationMin: started ? Math.max(0, Math.round(((ended ?? new Date()).getTime() - started.getTime()) / 60_000)) : 0,
    startedAt: started ? started.toISOString() : null,
    totalMinor: total != null && isCurrency(cdr?.currency ?? s?.data?.currency) ? toMinor(String(total), (cdr?.currency ?? s?.data?.currency) as CurrencyCode) : null,
    currency: (cdr?.currency ?? s?.data?.currency ?? r.currency ?? null) as string | null,
    /** App drivers: the card hold that guarantees this charge, and what was captured from it. */
    hold: hold ? {
      amountMinor: Number(hold.amount_authorised_minor), currency: hold.currency, state: hold.state, holdState: hold.hold_state,
      capturedMinor: hold.amount_captured_minor != null ? Number(hold.amount_captured_minor) : null, checkoutUrl: hold.state === 'pending' ? hold.checkout_url : null,
    } : null,
    cdrId: cdr?.id ?? null,
    siteName: loc?.data?.name ?? r.location_id,
    operator: loc?.data?.operator?.name ?? loc?.partner_name ?? '',
    connectorLabel: conn ? `${LABEL[conn.standard] ?? conn.standard ?? ''}${conn.max_electric_power ? ` · ${Math.round(conn.max_electric_power / 100) / 10} kW` : ''}` : r.evse_uid,
    canStop: state === 'charging',
  };
}

export async function stopRoaming(p: DriverPrincipal, id: string, base: string): Promise<{ ok: boolean; error?: string }> {
  const r = await ownedRoaming(p, id);
  if (!r) return { ok: false, error: 'Transaksi tidak ditemukan.' };
  const s = await sessionOf(r);
  if (!s || !(s.status === 'ACTIVE' || s.status === 'PENDING')) return { ok: false, error: 'Tidak ada sesi aktif untuk dihentikan.' };
  try {
    const c = await sendCommand({ orgId: r.org_id, partnerId: r.partner_id, command: 'STOP_SESSION', base, sessionId: s.session_id,
      locationParty: { country_code: r.country_code, party_id: r.party_id } });
    await query(`UPDATE driver_roaming_charge SET stop_command_id = $2 WHERE id = $1`, [r.id, c.id]);
    return c.response === 'ACCEPTED' ? { ok: true } : { ok: false, error: 'Operator menolak permintaan berhenti. Hentikan dari charger atau cabut konektor.' };
  } catch (e) {
    logger.warn({ id, err: (e as Error).message }, 'roaming stop failed');
    return { ok: false, error: 'Operator mitra sedang tidak dapat dihubungi. Hentikan dari charger.' };
  }
}

/** The operator's charge record, for this driver's card only. */
/** The driver's roaming tokens: the fleet card, and an app driver's virtual tokens (one per eMSP operator they roamed with). */
async function myRoamingTokens(p: DriverPrincipal): Promise<string[]> {
  const ids = p.fleet ? [p.fleet.tokenId] : [];
  if (p.appDriverId) {
    for (const r of await many<{ token_id: string }>(`SELECT DISTINCT token_id FROM driver_roaming_charge WHERE app_driver_id = $1`, [p.appDriverId])) ids.push(r.token_id);
  }
  return ids;
}

export async function roamingReceipt(p: DriverPrincipal, cdrId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(cdrId)) return null;
  const tokens = await myRoamingTokens(p);
  if (!tokens.length) return null;
  const c = await one<{ id: string; data: any; currency: string; total_excl_vat: string; total_incl_vat: string | null; total_energy: string;
    start_date_time: Date; end_date_time: Date; partner_name: string; country_code: string; party_id: string }>(
    `SELECT r.id, r.data, r.currency, r.total_excl_vat, r.total_incl_vat, r.total_energy, r.start_date_time, r.end_date_time,
            p.name AS partner_name, r.country_code, r.party_id
       FROM ocpi_remote_cdr r JOIN ocpi_partner p ON p.id = r.partner_id
      WHERE r.id = $1 AND r.token_id = ANY($2::uuid[]) AND r.status = 'accepted'`,
    [cdrId, tokens],
  );
  if (!c) return null;
  // An app driver's charge: what was held on the card and what was captured.
  const held = await one<{ amount_authorised_minor: number; amount_captured_minor: number | null; hold_capture_minor: number | null; hold_state: string | null; currency: string; settle_outcome: string | null; shortfall_minor: number | null }>(
    `SELECT pi.amount_authorised_minor, pi.amount_captured_minor, pi.hold_capture_minor, pi.hold_state, pi.currency, rc.settle_outcome, rc.shortfall_minor
       FROM driver_roaming_charge rc JOIN payment_intent pi ON pi.id = rc.payment_intent_id WHERE rc.remote_cdr_id = $1`, [c.id]);
  const minor = (x: unknown) => (isCurrency(c.currency) && x != null && Number.isFinite(Number(x)) ? toMinor(String(x), c.currency) : null);
  const d = c.data ?? {};
  const price = (x: any) => (x && Number.isFinite(Number(x.excl_vat)) ? Number(x.excl_vat) : null);
  const lines = [
    ['Energi', price(d.total_energy_cost)],
    ['Biaya tetap', price(d.total_fixed_cost)],
    ['Biaya waktu', price(d.total_time_cost)],
    ['Biaya parkir', price(d.total_parking_cost)],
    ['Biaya reservasi', price(d.total_reservation_cost)],
  ].filter(([, v]) => v != null && Number(v) !== 0).map(([label, v]) => ({ label, amount: Number(v) }));
  return {
    cdrId: c.id,
    reference: String(d.id ?? ''),
    operator: d.cdr_location?.operator?.name ?? c.partner_name,
    party: `${c.country_code}*${c.party_id}`,
    siteName: d.cdr_location?.name ?? d.cdr_location?.address ?? '',
    address: [d.cdr_location?.address, d.cdr_location?.city].filter(Boolean).join(', '),
    evseId: d.cdr_location?.evse_id ?? null,
    startedAt: c.start_date_time,
    endedAt: c.end_date_time,
    energyKwh: Number(c.total_energy),
    durationMin: Math.max(0, Math.round((new Date(c.end_date_time).getTime() - new Date(c.start_date_time).getTime()) / 60_000)),
    currency: c.currency,
    lines: lines.map((l) => ({ ...l, amountMinor: minor(l.amount) })),
    totalExclVat: Number(c.total_excl_vat),
    totalInclVat: c.total_incl_vat != null ? Number(c.total_incl_vat) : null,
    /** The same totals in PlugSure minor units of `currency` (null: a currency PlugSure does not support). */
    totalExclVatMinor: minor(c.total_excl_vat),
    totalInclVatMinor: minor(c.total_incl_vat),
    hold: held ? {
      amountMinor: Number(held.amount_authorised_minor), currency: held.currency, state: held.hold_state, outcome: held.settle_outcome,
      capturedMinor: held.hold_state === 'captured' ? Number(held.amount_captured_minor ?? held.hold_capture_minor ?? 0) : held.hold_capture_minor != null ? Number(held.hold_capture_minor) : null,
      shortfallMinor: held.shortfall_minor != null ? Number(held.shortfall_minor) : null,
    } : null,
  };
}

/**
 * Roaming entries for the history screen: charges started in the app, and
 * charge records for the driver's card from sessions started by tapping it.
 */
export async function roamingHistory(p: DriverPrincipal, limit = 40) {
  if (!p.fleet && !p.appDriverId) return [];
  const tokens = await myRoamingTokens(p);
  const started = await many<{ id: string; created_at: Date; location_id: string; partner_id: string; country_code: string; party_id: string; remote_session_id: string | null; app_driver_id: string | null }>(
    `SELECT id, created_at, location_id, partner_id, country_code, party_id, remote_session_id, app_driver_id FROM driver_roaming_charge
      WHERE device_id = $1 OR token_id = ANY($2::uuid[]) OR ($3::uuid IS NOT NULL AND app_driver_id = $3) ORDER BY created_at DESC LIMIT $4`,
    [p.deviceId, tokens, p.appDriverId, limit],
  );
  const out: any[] = [];
  const cdrsShown = new Set<string>();
  for (const r of started) {
    const st = await roamingStatus(p, r.id);
    if (!st) continue;
    if (st.cdrId) cdrsShown.add(st.cdrId);
    out.push({
      kind: 'roaming', chargeId: r.id, cdrId: st.cdrId, mode: r.app_driver_id ? 'app' : 'fleet', siteName: st.siteName, operator: st.operator,
      createdAt: r.created_at, state: st.state === 'billed' ? 'rated' : st.state === 'charging' ? 'active' : st.state === 'finishing' ? 'ended' : st.state === 'rejected' ? 'no_session' : 'starting',
      energyKwh: st.energyKwh || null, totalMinor: st.totalMinor, currency: st.currency,
    });
  }
  if (!tokens.length) return out;
  const cdrs = await many<{ id: string; data: any; end_date_time: Date; start_date_time: Date; total_energy: string; total_incl_vat: string | null; total_excl_vat: string; currency: string; partner_name: string }>(
    `SELECT r.id, r.data, r.start_date_time, r.end_date_time, r.total_energy, r.total_incl_vat, r.total_excl_vat, r.currency, p.name AS partner_name
       FROM ocpi_remote_cdr r JOIN ocpi_partner p ON p.id = r.partner_id
      WHERE r.token_id = ANY($1::uuid[]) AND r.status = 'accepted' ORDER BY r.end_date_time DESC LIMIT $2`,
    [tokens, limit],
  );
  for (const c of cdrs) {
    if (cdrsShown.has(c.id)) continue;
    out.push({
      kind: 'roaming', chargeId: null, cdrId: c.id, mode: p.fleet ? 'fleet' : 'app', siteName: c.data?.cdr_location?.name ?? 'Jaringan mitra',
      operator: c.data?.cdr_location?.operator?.name ?? c.partner_name, createdAt: c.start_date_time, state: 'rated',
      energyKwh: Number(c.total_energy),
      totalMinor: isCurrency(c.currency) ? toMinor(String(c.total_incl_vat ?? c.total_excl_vat), c.currency) : null, currency: c.currency,
    });
  }
  return out;
}

// ─────────────────────────────────────────────── reservations on a partner network

/**
 * A fleet driver reserves a partner operator's charger (OCPI RESERVE_NOW with their
 * roaming card), for the same DRIVER_RESERVATION_MINUTES as at PlugSure chargers.
 * The operator answers at once whether it will try, then posts the charger's answer
 * to our command endpoint: until then the reservation is "requested". One live
 * reservation per phone, across PlugSure chargers, partner chargers and queues.
 */
export interface RoamingReservationView {
  id: string; state: string; problem: string | null; expiresAt: string; minutesLeft: number;
  siteName: string; operator: string; evseId: string;
  partnerId: string; countryCode: string; partyId: string; locationId: string; evseUid: string;
}
interface ResRow {
  id: string; org_id: string; device_id: string; token_id: string; partner_id: string; country_code: string; party_id: string;
  location_id: string; evse_uid: string; reservation_id: string; reserve_command_id: string | null; state: string; problem: string | null;
  expires_at: Date; created_at: Date;
}

const RESULT_PROBLEM: Record<string, string> = {
  EVSE_OCCUPIED: 'Charger sedang dipakai.', EVSE_INOPERATIVE: 'Charger sedang tidak berfungsi.', TIMEOUT: 'Charger tidak merespons.',
  NOT_SUPPORTED: 'Operator ini tidak menerima reservasi.', REJECTED: 'Charger menolak reservasi.', FAILED: 'Charger menolak reservasi.',
};

/** Apply the charger's answer (posted by the operator) to a reservation still waiting for it. */
async function settle(r: ResRow): Promise<ResRow> {
  if (r.state === 'requested' && r.reserve_command_id) {
    const c = await one<{ result: string | null }>(`SELECT result FROM ocpi_command WHERE id = $1`, [r.reserve_command_id]);
    if (c?.result) {
      const ok = c.result === 'ACCEPTED';
      const problem = ok ? null : RESULT_PROBLEM[c.result] ?? 'Charger menolak reservasi.';
      await query(`UPDATE driver_roaming_reservation SET state = $2, problem = $3, ended_at = CASE WHEN $2 = 'rejected' THEN now() END WHERE id = $1 AND state = 'requested'`,
        [r.id, ok ? 'active' : 'rejected', problem]);
      return { ...r, state: ok ? 'active' : 'rejected', problem };
    }
  }
  return r;
}

async function viewOf(r: ResRow): Promise<RoamingReservationView> {
  const loc = await one<{ data: any; partner_name: string }>(
    `SELECT l.data, pa.name AS partner_name FROM ocpi_partner pa
       LEFT JOIN ocpi_remote_location l ON l.partner_id = pa.id AND l.country_code = $2 AND l.party_id = $3 AND l.location_id = $4
      WHERE pa.id = $1`,
    [r.partner_id, r.country_code, r.party_id, r.location_id]);
  const evse = (loc?.data?.evses ?? []).find((e: any) => e.uid === r.evse_uid);
  return {
    id: r.id, state: r.state, problem: r.problem, expiresAt: new Date(r.expires_at).toISOString(),
    minutesLeft: Math.max(0, Math.ceil((new Date(r.expires_at).getTime() - Date.now()) / 60_000)),
    siteName: loc?.data?.name ?? r.location_id, operator: loc?.data?.operator?.name ?? loc?.partner_name ?? '',
    evseId: String(evse?.evse_id ?? r.evse_uid),
    partnerId: r.partner_id, countryCode: r.country_code, partyId: r.party_id, locationId: r.location_id, evseUid: r.evse_uid,
  };
}

/** Does this phone hold a partner reservation right now? */
export async function hasRoamingReservation(deviceId: string): Promise<boolean> {
  return !!(await one(`SELECT 1 FROM driver_roaming_reservation WHERE device_id = $1 AND state IN ('requested','active') AND expires_at > now()`, [deviceId]));
}

/** The driver's live partner reservation, if any. */
export async function currentRoamingReservation(p: DriverPrincipal): Promise<RoamingReservationView | null> {
  const r = await one<ResRow>(
    `SELECT * FROM driver_roaming_reservation WHERE device_id = $1 AND state IN ('requested','active') AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
    [p.deviceId]);
  if (!r) return null;
  const s = await settle(r);
  return s.state === 'rejected' ? null : viewOf(s);
}

/** One reservation of this phone, whatever its state (the app follows a new one until the charger answers). */
export async function roamingReservation(p: DriverPrincipal, id: string): Promise<RoamingReservationView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await one<ResRow>(`SELECT * FROM driver_roaming_reservation WHERE id = $1 AND device_id = $2`, [id, p.deviceId]);
  return r ? viewOf(await settle(r)) : null;
}

export async function reserveRoaming(p: DriverPrincipal, s: RoamingStart, base: string): Promise<{ ok: boolean; reservation?: RoamingReservationView; error?: string }> {
  if (!config.driverApp.reservationsEnabled) return { ok: false, error: 'Reservasi tidak tersedia.' };
  const el = await roamingEligibility(p);
  if (!el.enabled) return { ok: false, error: el.reason };
  // A reservation on a partner network is billed to a fleet card; an app driver's charge needs its hold first.
  if (el.mode !== 'fleet') return { ok: false, error: 'Reservasi jaringan mitra tersedia untuk pengemudi armada.' };
  const problem = await fleetTokenProblem(el.tokenId!);
  if (problem) return { ok: false, error: problem };
  const [{ currentReservation }, queued] = await Promise.all([
    import('./reservations.js'),
    one(`SELECT 1 FROM driver_queue_entry WHERE device_id = $1 AND state IN ('waiting','offered')`, [p.deviceId]),
  ]);
  if ((await currentReservation(p)) || (await hasRoamingReservation(p.deviceId))) {
    return { ok: false, error: 'Anda sudah punya reservasi aktif. Batalkan dulu untuk memesan yang lain.' };
  }
  if (queued) return { ok: false, error: 'Anda sedang dalam antrean. Keluar antrean dulu untuk memesan.' };
  const { stations } = await listRoamingStations(p);
  const st = stations.find((x) => x.partnerId === s.partnerId && x.countryCode === s.countryCode && x.partyId === s.partyId && x.locationId === s.locationId);
  const evse = st?.evses.find((e) => e.uid === s.evseUid);
  if (!st || !evse) return { ok: false, error: 'Charger mitra tidak ditemukan.' };
  if (!evse.available) return { ok: false, error: 'Charger ini sedang tidak tersedia untuk dipesan.' };

  const expires = new Date(Date.now() + config.driverApp.reservationMinutes * 60_000);
  const reservationId = `PLS-${randomBytes(8).toString('hex').toUpperCase()}`;
  let row: ResRow | null;
  try {
    row = await one<ResRow>(
      `INSERT INTO driver_roaming_reservation (org_id, device_id, token_id, partner_id, country_code, party_id, location_id, evse_uid, reservation_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [el.orgId, p.deviceId, el.tokenId, s.partnerId, s.countryCode, s.partyId, s.locationId, s.evseUid, reservationId, expires]);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return { ok: false, error: 'Anda sudah punya reservasi aktif. Batalkan dulu untuk memesan yang lain.' };
    throw e;
  }
  try {
    const c = await sendCommand({
      orgId: el.orgId!, partnerId: s.partnerId, command: 'RESERVE_NOW', base, tokenId: el.tokenId,
      locationId: s.locationId, evseUid: s.evseUid, reservationId, expiryDate: expires,
      locationParty: { country_code: s.countryCode, party_id: s.partyId },
    });
    if (c.response !== 'ACCEPTED') {
      const why = RESULT_PROBLEM[c.response] ?? 'Operator menolak reservasi.';
      await query(`UPDATE driver_roaming_reservation SET state = 'rejected', problem = $2, reserve_command_id = $3, ended_at = now() WHERE id = $1`, [row!.id, why, c.id]);
      return { ok: false, error: why };
    }
    await query(`UPDATE driver_roaming_reservation SET reserve_command_id = $2 WHERE id = $1`, [row!.id, c.id]);
    return { ok: true, reservation: await viewOf({ ...row!, reserve_command_id: c.id }) };
  } catch (e) {
    await query(`UPDATE driver_roaming_reservation SET state = 'rejected', problem = 'operator unreachable', ended_at = now() WHERE id = $1`, [row!.id]);
    if (e instanceof EmspError) return { ok: false, error: 'Operator mitra sedang tidak dapat dihubungi. Coba lagi nanti.' };
    throw e;
  }
}

export async function cancelRoamingReservation(p: DriverPrincipal, id: string, base: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: 'Reservasi tidak ditemukan.' };
  const r = await one<ResRow>(`SELECT * FROM driver_roaming_reservation WHERE id = $1 AND device_id = $2 AND state IN ('requested','active')`, [id, p.deviceId]);
  if (!r) return { ok: false, error: 'Reservasi tidak ditemukan.' };
  // Ours to end now; the operator releases the charger when it gets the cancel (or at expiry).
  await query(`UPDATE driver_roaming_reservation SET state = 'cancelled', ended_at = now() WHERE id = $1`, [id]);
  try {
    const c = await sendCommand({ orgId: r.org_id, partnerId: r.partner_id, command: 'CANCEL_RESERVATION', base, reservationId: r.reservation_id,
      locationParty: { country_code: r.country_code, party_id: r.party_id } });
    await query(`UPDATE driver_roaming_reservation SET cancel_command_id = $2 WHERE id = $1`, [id, c.id]);
  } catch (e) {
    logger.warn({ id, err: (e as Error).message }, 'roaming CANCEL_RESERVATION not delivered');
  }
  return { ok: true };
}

/** Worker: remind 5 minutes before the end, end lapsed ones, and see a charge started by tapping the card. */
export async function sweepRoamingReservations(): Promise<void> {
  // A session the operator reports for this card at this location, since the reservation: used.
  await query(
    `UPDATE driver_roaming_reservation r SET state = 'used', ended_at = now()
      WHERE r.state IN ('requested','active') AND EXISTS (
        SELECT 1 FROM ocpi_remote_session s WHERE s.partner_id = r.partner_id AND s.token_id = r.token_id
           AND s.data->>'location_id' = r.location_id AND s.received_at >= r.created_at)`);
  const { notifyReservation } = await import('./notify.js');
  const soon = await many<ResRow>(
    `UPDATE driver_roaming_reservation SET reminded_at = now()
      WHERE state = 'active' AND reminded_at IS NULL AND expires_at <= now() + interval '5 minutes' AND expires_at > now() RETURNING *`);
  for (const r of soon) await notifyReservation(r.device_id, r.id, 'reminder', (await viewOf(r)).siteName, new Date(r.expires_at));
  const lapsed = await many<ResRow>(
    `UPDATE driver_roaming_reservation SET state = 'expired', ended_at = now() WHERE state IN ('requested','active') AND expires_at <= now() RETURNING *`);
  for (const r of lapsed) await notifyReservation(r.device_id, r.id, 'expired', (await viewOf(r)).siteName, new Date(r.expires_at));
}