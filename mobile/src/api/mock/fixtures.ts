import type { ConnectorStatus, ConnectorView, CurrencyCode, CountryCode, RoamingStation, StationView } from '../types';

/**
 * Demo data for the built-in mock backend (API_BASE_URL=mock): fictional operators and sites in Jakarta,
 * Kuala Lumpur, Johor Bahru and Singapore, shaped exactly like the real driver API's answers.
 */
type C = [type: 'cCCS2' | 'sType2' | 'cChaDeMo', current: 'AC' | 'DC', kw: number, status: ConnectorStatus];

const LABEL: Record<string, string> = { cCCS2: 'CCS2', sType2: 'Type 2', cChaDeMo: 'CHAdeMO' };

let seq = 0;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function connectors(identity: string, cs: C[]): ConnectorView[] {
  return cs.map(([type, current, kw, status], i) => {
    seq += 1;
    const available = status === 'Available';
    return {
      connectorId: uuid(1000 + seq),
      ocppIdentity: identity,
      chargerName: identity,
      connectorNo: i + 1,
      type,
      typeLabel: LABEL[type] ?? type,
      current,
      maxPowerW: kw * 1000,
      maxPowerKw: kw,
      chargingClass: current === 'DC' ? (kw >= 100 ? 'ultra_fast' : 'fast') : 'standard',
      status,
      available,
      blockedReason: available ? null : status === 'Charging' ? 'In use.' : status === 'Faulted' ? 'The charger has a problem.' : status === 'Offline' ? 'The charger is offline.' : 'Not available.',
      reliability: null,
    };
  });
}

interface SiteSeed {
  id: number;
  name: string;
  address: string;
  lat: number;
  lon: number;
  operator: string;
  country: CountryCode;
  rate: number;
  identity: string;
  cs: C[];
  spklu?: string;
  reliability?: StationView['reliability'];
}

const CUR: Record<CountryCode, CurrencyCode> = { ID: 'IDR', MY: 'MYR', SG: 'SGD' };

const SITES: SiteSeed[] = [
  { id: 1, name: 'Senayan Hub — B1', address: 'Jl. Asia Afrika No. 8, Jakarta Pusat', lat: -6.2246, lon: 106.8019, operator: 'Arus Kota', country: 'ID', rate: 2466.78, identity: 'AK-SNY-01', spklu: '01.JKT.20.3171.001',
    cs: [['cCCS2', 'DC', 120, 'Available'], ['cCCS2', 'DC', 120, 'Charging'], ['sType2', 'AC', 22, 'Available']],
    reliability: { score: 97, label: 'reliable', basis: '30d', lastSuccessAt: new Date(Date.now() - 42 * 60_000).toISOString() } },
  { id: 2, name: 'Kuningan Central P2', address: 'Jl. HR Rasuna Said Kav. 1, Jakarta Selatan', lat: -6.2297, lon: 106.8318, operator: 'VoltNusa', country: 'ID', rate: 2575, identity: 'VN-KNC-02',
    cs: [['cCCS2', 'DC', 60, 'Charging'], ['cChaDeMo', 'DC', 50, 'Charging']],
    reliability: { score: 81, label: 'mixed', basis: '30d', lastSuccessAt: new Date(Date.now() - 3 * 3600_000).toISOString() } },
  { id: 3, name: 'Menteng Park', address: 'Jl. Cikini Raya 79, Jakarta Pusat', lat: -6.1949, lon: 106.8389, operator: 'Arus Kota', country: 'ID', rate: 2466.78, identity: 'AK-MTP-01',
    cs: [['sType2', 'AC', 7, 'Available'], ['sType2', 'AC', 7, 'Available'], ['sType2', 'AC', 22, 'Faulted']],
    reliability: { score: null, label: 'issue', basis: '30d', lastSuccessAt: new Date(Date.now() - 26 * 3600_000).toISOString(), lastIssueAt: new Date(Date.now() - 2 * 3600_000).toISOString() } },
  { id: 4, name: 'Sudirman Tower', address: 'Jl. Jend. Sudirman Kav. 52, Jakarta Selatan', lat: -6.2215, lon: 106.8106, operator: 'Charge Nusantara', country: 'ID', rate: 2300, identity: 'CN-SDT-01',
    cs: [['cCCS2', 'DC', 180, 'Available'], ['cCCS2', 'DC', 180, 'Available'], ['cCCS2', 'DC', 180, 'Charging'], ['cCCS2', 'DC', 180, 'Available']],
    reliability: { score: 99, label: 'reliable', basis: '30d', lastSuccessAt: new Date(Date.now() - 9 * 60_000).toISOString() } },
  { id: 5, name: 'Kemang Square', address: 'Jl. Kemang Raya 12, Jakarta Selatan', lat: -6.2607, lon: 106.8133, operator: 'VoltNusa', country: 'ID', rate: 2575, identity: 'VN-KMS-01',
    cs: [['sType2', 'AC', 22, 'Offline'], ['sType2', 'AC', 22, 'Offline']], reliability: { score: null, label: 'new', basis: '30d', lastSuccessAt: null } },
  { id: 6, name: 'Kelapa Gading Mall Lt. P1', address: 'Jl. Boulevard Kelapa Gading, Jakarta Utara', lat: -6.1575, lon: 106.9087, operator: 'Charge Nusantara', country: 'ID', rate: 2300, identity: 'CN-KGM-01',
    cs: [['cCCS2', 'DC', 60, 'Available'], ['sType2', 'AC', 22, 'Charging']], reliability: { score: 92, label: 'reliable', basis: '30d', lastSuccessAt: new Date(Date.now() - 80 * 60_000).toISOString() } },
  { id: 7, name: 'Bangsar South Plaza', address: 'Jalan Kerinchi, 59200 Kuala Lumpur', lat: 3.1106, lon: 101.6655, operator: 'KilatCharge', country: 'MY', rate: 1.2, identity: 'KC-BSP-01',
    cs: [['cCCS2', 'DC', 90, 'Available'], ['sType2', 'AC', 22, 'Available']], reliability: { score: 95, label: 'reliable', basis: '30d', lastSuccessAt: new Date(Date.now() - 30 * 60_000).toISOString() } },
  { id: 8, name: 'Marina Link Carpark', address: '8 Raffles Ave, Singapore 039802', lat: 1.2915, lon: 103.8572, operator: 'Lion City EV', country: 'SG', rate: 0.65, identity: 'LC-MLC-01',
    cs: [['cCCS2', 'DC', 150, 'Available'], ['sType2', 'AC', 22, 'Charging']], reliability: { score: 98, label: 'reliable', basis: '30d', lastSuccessAt: new Date(Date.now() - 12 * 60_000).toISOString() } },
];

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)) * 10) / 10;
}

const built = SITES.map((s) => ({ seed: s, connectors: connectors(s.identity, s.cs) }));

export function stations(near?: { lat: number; lon: number }): StationView[] {
  const out = built.map(({ seed: s, connectors: cs }) => {
    const cur = CUR[s.country];
    const fastest = cs.reduce((a, b) => (b.maxPowerW > a.maxPowerW ? b : a), cs[0]!);
    return {
      siteId: uuid(s.id),
      name: s.name,
      address: s.address,
      lat: s.lat,
      lon: s.lon,
      spkluId: s.spklu ?? null,
      operator: s.operator,
      distanceKm: near ? haversineKm(near.lat, near.lon, s.lat, s.lon) : null,
      connectors: cs,
      availableCount: cs.filter((c) => c.available).length,
      totalCount: cs.length,
      maxPowerKw: Math.max(...cs.map((c) => c.maxPowerKw)),
      fastest: `${fastest.maxPowerKw} kW ${fastest.current}`,
      priceFromMinor: cur === 'IDR' ? s.rate : s.rate * 100,
      priceFromMajor: s.rate,
      currency: cur,
      countryCode: s.country,
      timezone: s.country === 'ID' ? 'Asia/Jakarta' : s.country === 'MY' ? 'Asia/Kuala_Lumpur' : 'Asia/Singapore',
      pricesIncludeTax: s.country !== 'ID',
      reliability: s.reliability ?? null,
    } satisfies StationView;
  });
  if (near) out.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
  return out;
}

export function findConnector(id: string) {
  for (const b of built) {
    const c = b.connectors.find((x) => x.connectorId === id);
    if (c) return { site: b.seed, connector: c, station: stations().find((s) => s.siteId === uuid(b.seed.id))! };
  }
  return null;
}

export function resolveCode(code: string) {
  const m = code.match(/^(.+?)[:/](\d{1,3})$/);
  const identity = (m ? m[1]! : code).toLowerCase();
  const no = m ? Number(m[2]) : null;
  for (const b of built) {
    const byId = b.connectors.find((c) => c.connectorId === code);
    if (byId) return byId;
    if (b.seed.identity.toLowerCase() === identity) return no ? b.connectors.find((c) => c.connectorNo === no) ?? null : b.connectors[0]!;
    if (b.seed.spklu === code) return b.connectors.find((c) => c.available) ?? b.connectors[0]!;
  }
  return null;
}

const PARTNERS: Omit<RoamingStation, 'distanceKm' | 'availableCount' | 'totalCount' | 'startable' | 'reason' | 'holdMinor' | 'savedCards'>[] = [
  {
    partnerId: uuid(9001), countryCode: 'ID', partyId: 'GEN', locationId: 'LOC-JKT-7', name: 'Gentera Go — Pondok Indah', address: 'Jl. Metro Pondok Indah, Jakarta', city: 'Jakarta',
    operator: 'Gentera Go', lat: -6.2656, lon: 106.7837,
    evses: [
      { uid: 'EVSE-1', evseId: 'ID*GEN*E7001', status: 'Available', available: true, connectors: [{ id: '1', typeLabel: 'CCS2', current: 'DC', maxPowerKw: 100 }] },
      { uid: 'EVSE-2', evseId: 'ID*GEN*E7002', status: 'Charging', available: false, connectors: [{ id: '1', typeLabel: 'CCS2', current: 'DC', maxPowerKw: 100 }] },
    ],
    fastest: '100 kW DC', priceFromMinor: 2900, priceFromMajor: 2900, priceCurrency: 'IDR', vatPercent: 11, currency: 'IDR',
    reliability: { score: 88, label: 'reliable', basis: '30d', lastSuccessAt: new Date(Date.now() - 50 * 60_000).toISOString() },
  },
  {
    partnerId: uuid(9002), countryCode: 'MY', partyId: 'JMV', locationId: 'LOC-JB-2', name: 'JomVolt — Johor Bahru Sentral', address: 'Jalan Tun Abdul Razak, Johor Bahru', city: 'Johor Bahru',
    operator: 'JomVolt', lat: 1.4626, lon: 103.7649,
    evses: [{ uid: 'EVSE-1', evseId: 'MY*JMV*E2001', status: 'Available', available: true, connectors: [{ id: '1', typeLabel: 'CCS2', current: 'DC', maxPowerKw: 60 }] }],
    fastest: '60 kW DC', priceFromMinor: 130, priceFromMajor: 1.3, priceCurrency: 'MYR', vatPercent: 8, currency: 'MYR',
    reliability: { score: 74, label: 'mixed', basis: '30d', lastSuccessAt: new Date(Date.now() - 5 * 3600_000).toISOString() },
  },
  {
    partnerId: uuid(9003), countryCode: 'SG', partyId: 'LCE', locationId: 'LOC-SG-11', name: 'Woodlands Checkpoint EV Bay', address: '21 Woodlands Crossing, Singapore', city: 'Singapore',
    operator: 'Bay Charge SG', lat: 1.4456, lon: 103.7687,
    evses: [
      { uid: 'EVSE-1', evseId: 'SG*LCE*E1101', status: 'Available', available: true, connectors: [{ id: '1', typeLabel: 'CCS2', current: 'DC', maxPowerKw: 120 }] },
      { uid: 'EVSE-2', evseId: 'SG*LCE*E1102', status: 'Available', available: true, connectors: [{ id: '1', typeLabel: 'Type 2', current: 'AC', maxPowerKw: 22 }] },
    ],
    fastest: '120 kW DC', priceFromMinor: 72, priceFromMajor: 0.72, priceCurrency: 'SGD', vatPercent: 9, currency: 'SGD',
    reliability: { score: 96, label: 'reliable', basis: '30d', lastSuccessAt: new Date(Date.now() - 20 * 60_000).toISOString() },
  },
];

const HOLD: Record<string, number> = { IDR: 500_000, MYR: 20_000, SGD: 8_000 };

export function partnerStations(signedIn: boolean, near?: { lat: number; lon: number }): RoamingStation[] {
  return PARTNERS.map((p) => ({
    ...p,
    distanceKm: near && p.lat != null && p.lon != null ? haversineKm(near.lat, near.lon, p.lat, p.lon) : null,
    availableCount: p.evses.filter((e) => e.available).length,
    totalCount: p.evses.length,
    startable: signedIn,
    reason: signedIn ? null : 'Sign in to charge on partner networks.',
    holdMinor: HOLD[p.currency ?? 'IDR'] ?? null,
    savedCards: signedIn ? [{ id: uuid(7001), brand: 'visa', last4: '4242' }] : [],
  }));
}

export { uuid };
