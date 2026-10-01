import { randomBytes } from 'node:crypto';
import { one, many, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sendCommand, EmspError } from '../ocpi/emsp.js';
import { fleetTokenProblem } from './charge.js';
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

const LABEL: Record<string, string> = {
  IEC_62196_T2: 'Type 2', IEC_62196_T2_COMBO: 'CCS2', CHADEMO: 'CHAdeMO', GBT_AC: 'GB/T', GBT_DC: 'GB/T',
  IEC_62196_T1: 'Type 1', IEC_62196_T1_COMBO: 'CCS1', TESLA_S: 'Tesla', TESLA_R: 'Tesla',
};

/** OCPI EVSE status -> the app's own status words (same as PlugSure chargers). */
const STATUS: Record<string, string> = {
  AVAILABLE: 'Available', CHARGING: 'Charging', RESERVED: 'Occupied', BLOCKED: 'Occupied',
  OUTOFORDER: 'Faulted', INOPERATIVE: 'Maintenance', UNKNOWN: 'Offline', PLANNED: 'Unavailable',
};

export interface Eligibility { enabled: boolean; reason?: string; tokenId?: string; orgId?: string }

/** May this driver roam? A fleet card that the fleet operator shared for roaming. */
export async function roamingEligibility(p: DriverPrincipal): Promise<Eligibility> {
  if (!p.fleet) return { enabled: false, reason: 'Jaringan mitra tersedia untuk pengemudi armada dengan kartu roaming.' };
  const t = await one<{ roaming_shared: boolean; contract_id: string | null }>(
    `SELECT roaming_shared, contract_id FROM token WHERE id = $1`, [p.fleet.tokenId],
  );
  if (!t?.roaming_shared || !t.contract_id) return { enabled: false, reason: 'Kartu Anda belum diaktifkan untuk jaringan mitra. Hubungi admin armada Anda.' };
  return { enabled: true, tokenId: p.fleet.tokenId, orgId: p.fleet.orgId };
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
  /** The operator's energy price per kWh, before tax, when it publishes one. */
  priceFromIdr: number | null;
  vatPercent: number | null;
}

/** Partner operators' stations this driver's card can use, nearest first when a location is given. */
export async function listRoamingStations(p: DriverPrincipal, loc?: { lat: number; lon: number }) {
  const el = await roamingEligibility(p);
  if (!el.enabled) return { enabled: false, reason: el.reason, stations: [] as RoamingStation[] };
  const rows = await many<{ partner_id: string; partner_name: string; country_code: string; party_id: string; location_id: string; data: any }>(
    `SELECT l.partner_id, p.name AS partner_name, l.country_code, l.party_id, l.location_id, l.data
       FROM ocpi_remote_location l JOIN ocpi_partner p ON p.id = l.partner_id
      WHERE l.org_id = $1 AND p.state = 'connected' AND COALESCE((l.data->>'publish')::boolean, true)`,
    [el.orgId],
  );
  const tariffs = await many<{ partner_id: string; country_code: string; party_id: string; tariff_id: string; data: any }>(
    `SELECT t.partner_id, t.country_code, t.party_id, t.tariff_id, t.data
       FROM ocpi_remote_tariff t JOIN ocpi_partner p ON p.id = t.partner_id
      WHERE t.org_id = $1 AND p.state = 'connected'`,
    [el.orgId],
  );
  const tariffOf = (r: { partner_id: string; country_code: string; party_id: string }, id: string) =>
    tariffs.find((t) => t.partner_id === r.partner_id && t.country_code === r.country_code && t.party_id === r.party_id && t.tariff_id === id);

  const out: RoamingStation[] = rows.map((r) => {
    const d = r.data ?? {};
    const lat = Number(d.coordinates?.latitude);
    const lon = Number(d.coordinates?.longitude);
    let price: number | null = null;
    let vat: number | null = null;
    const evses = (d.evses ?? []).filter((e: any) => e.status !== 'REMOVED').map((e: any) => {
      const status = STATUS[e.status] ?? 'Unavailable';
      const connectors = (e.connectors ?? []).map((c: any) => {
        for (const tid of c.tariff_ids ?? []) {
          const t = tariffOf(r, tid);
          if (!t || t.data?.currency !== 'IDR') continue;
          for (const el of t.data.elements ?? []) {
            for (const pc of el.price_components ?? []) {
              if (pc.type === 'ENERGY' && Number.isFinite(Number(pc.price)) && (price == null || Number(pc.price) < price)) {
                price = Number(pc.price);
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
    return {
      partnerId: r.partner_id, countryCode: r.country_code, partyId: r.party_id, locationId: r.location_id,
      name: String(d.name ?? d.address ?? r.location_id), address: [d.address, d.city].filter(Boolean).join(', ') || null, city: d.city ?? null,
      operator: d.operator?.name ?? r.partner_name,
      lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null,
      distanceKm: loc && Number.isFinite(lat) && Number.isFinite(lon) ? haversineKm(loc.lat, loc.lon, lat, lon) : null,
      evses,
      availableCount: evses.filter((e: any) => e.available).length,
      totalCount: evses.length,
      fastest: fastest?.maxPowerKw != null ? `${fastest.maxPowerKw} kW ${fastest.current}` : null,
      priceFromIdr: price,
      vatPercent: vat,
    };
  });
  out.sort((a, b) =>
    a.distanceKm != null && b.distanceKm != null ? a.distanceKm - b.distanceKm
      : (b.availableCount > 0 ? 1 : 0) - (a.availableCount > 0 ? 1 : 0) || a.name.localeCompare(b.name));
  return { enabled: true, stations: out };
}

// ─────────────────────────────────────────────── charging

export interface RoamingStart { partnerId: string; countryCode: string; partyId: string; locationId: string; evseUid: string; connectorId?: string }

export async function startRoaming(p: DriverPrincipal, s: RoamingStart, base: string): Promise<{ ok: boolean; chargeId?: string; error?: string }> {
  const el = await roamingEligibility(p);
  if (!el.enabled) return { ok: false, error: el.reason };
  const problem = await fleetTokenProblem(el.tokenId!);
  if (problem) return { ok: false, error: problem };
  const { stations } = await listRoamingStations(p);
  const st = stations.find((x) => x.partnerId === s.partnerId && x.countryCode === s.countryCode && x.partyId === s.partyId && x.locationId === s.locationId);
  const evse = st?.evses.find((e) => e.uid === s.evseUid);
  if (!st || !evse) return { ok: false, error: 'Charger mitra tidak ditemukan.' };
  // The driver's own reservation shows as RESERVED at the operator: that one they may start.
  const mine = await one<{ id: string }>(
    `SELECT id FROM driver_roaming_reservation WHERE device_id = $1 AND partner_id = $2 AND location_id = $3 AND evse_uid = $4 AND state = 'active'`,
    [p.deviceId, s.partnerId, s.locationId, s.evseUid]);
  if (!evse.available && !mine) return { ok: false, error: 'Charger ini sedang tidak tersedia.' };
  const connectorId = s.connectorId ?? evse.connectors[0]?.id;
  try {
    const r = await sendCommand({
      orgId: el.orgId!, partnerId: s.partnerId, command: 'START_SESSION', base, tokenId: el.tokenId,
      locationId: s.locationId, evseUid: s.evseUid, connectorId, locationParty: { country_code: s.countryCode, party_id: s.partyId },
    });
    if (r.response !== 'ACCEPTED') {
      return { ok: false, error: `Operator menolak permintaan (${r.response.toLowerCase()}). Coba tempelkan kartu Anda di charger.` };
    }
    const row = await one<{ id: string }>(
      `INSERT INTO driver_roaming_charge (org_id, device_id, token_id, partner_id, country_code, party_id, location_id, evse_uid, connector_id, start_command_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [el.orgId, p.deviceId, el.tokenId, s.partnerId, s.countryCode, s.partyId, s.locationId, s.evseUid, connectorId ?? null, r.id],
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
}

/** A roaming charge belongs to the phone that started it, or to the fleet card it charged. */
async function ownedRoaming(p: DriverPrincipal, id: string): Promise<RoamRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await one<RoamRow>(`SELECT * FROM driver_roaming_charge WHERE id = $1`, [id]);
  if (!r) return null;
  if (r.device_id === p.deviceId || (p.fleet && r.token_id === p.fleet.tokenId)) return r;
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

export async function roamingStatus(p: DriverPrincipal, id: string) {
  const r = await ownedRoaming(p, id);
  if (!r) return null;
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

  let state: 'starting' | 'rejected' | 'charging' | 'finishing' | 'billed';
  let problem: string | null = null;
  if (cdr) state = 'billed';
  else if (s) state = s.status === 'ACTIVE' || s.status === 'PENDING' ? 'charging' : 'finishing';
  else if (cmd?.result && cmd.result !== 'ACCEPTED') {
    state = 'rejected';
    problem = { EVSE_OCCUPIED: 'Charger sedang dipakai.', EVSE_INOPERATIVE: 'Charger sedang tidak berfungsi.', TIMEOUT: 'Charger tidak merespons.' }[cmd.result]
      ?? 'Charger tidak dapat dimulai.';
  } else state = 'starting';

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
    totalIdr: total != null && (cdr?.currency ?? s?.data?.currency) === 'IDR' ? total : null,
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
export async function roamingReceipt(p: DriverPrincipal, cdrId: string) {
  if (!p.fleet || !/^[0-9a-f-]{36}$/i.test(cdrId)) return null;
  const c = await one<{ id: string; data: any; currency: string; total_excl_vat: string; total_incl_vat: string | null; total_energy: string;
    start_date_time: Date; end_date_time: Date; partner_name: string; country_code: string; party_id: string }>(
    `SELECT r.id, r.data, r.currency, r.total_excl_vat, r.total_incl_vat, r.total_energy, r.start_date_time, r.end_date_time,
            p.name AS partner_name, r.country_code, r.party_id
       FROM ocpi_remote_cdr r JOIN ocpi_partner p ON p.id = r.partner_id
      WHERE r.id = $1 AND r.token_id = $2 AND r.status = 'accepted'`,
    [cdrId, p.fleet.tokenId],
  );
  if (!c) return null;
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
    lines,
    totalExclVat: Number(c.total_excl_vat),
    totalInclVat: c.total_incl_vat != null ? Number(c.total_incl_vat) : null,
  };
}

/**
 * Roaming entries for the history screen: charges started in the app, and
 * charge records for the driver's card from sessions started by tapping it.
 */
export async function roamingHistory(p: DriverPrincipal, limit = 40) {
  if (!p.fleet) return [];
  const started = await many<{ id: string; created_at: Date; location_id: string; partner_id: string; country_code: string; party_id: string; remote_session_id: string | null }>(
    `SELECT id, created_at, location_id, partner_id, country_code, party_id, remote_session_id FROM driver_roaming_charge
      WHERE device_id = $1 OR token_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [p.deviceId, p.fleet.tokenId, limit],
  );
  const out: any[] = [];
  const cdrsShown = new Set<string>();
  for (const r of started) {
    const st = await roamingStatus(p, r.id);
    if (!st) continue;
    if (st.cdrId) cdrsShown.add(st.cdrId);
    out.push({
      kind: 'roaming', chargeId: r.id, cdrId: st.cdrId, mode: 'fleet', siteName: st.siteName, operator: st.operator,
      createdAt: r.created_at, state: st.state === 'billed' ? 'rated' : st.state === 'charging' ? 'active' : st.state === 'finishing' ? 'ended' : st.state === 'rejected' ? 'no_session' : 'starting',
      energyKwh: st.energyKwh || null, totalIdr: st.totalIdr,
    });
  }
  const cdrs = await many<{ id: string; data: any; end_date_time: Date; start_date_time: Date; total_energy: string; total_incl_vat: string | null; total_excl_vat: string; currency: string; partner_name: string }>(
    `SELECT r.id, r.data, r.start_date_time, r.end_date_time, r.total_energy, r.total_incl_vat, r.total_excl_vat, r.currency, p.name AS partner_name
       FROM ocpi_remote_cdr r JOIN ocpi_partner p ON p.id = r.partner_id
      WHERE r.token_id = $1 AND r.status = 'accepted' ORDER BY r.end_date_time DESC LIMIT $2`,
    [p.fleet.tokenId, limit],
  );
  for (const c of cdrs) {
    if (cdrsShown.has(c.id)) continue;
    out.push({
      kind: 'roaming', chargeId: null, cdrId: c.id, mode: 'fleet', siteName: c.data?.cdr_location?.name ?? 'Jaringan mitra',
      operator: c.data?.cdr_location?.operator?.name ?? c.partner_name, createdAt: c.start_date_time, state: 'rated',
      energyKwh: Number(c.total_energy), totalIdr: c.currency === 'IDR' ? Number(c.total_incl_vat ?? c.total_excl_vat) : null,
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