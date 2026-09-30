/**
 * SPKLU identity number handling.
 *
 * Ditjen Gatrik issues a structured identity number per charging location, e.g.
 *
 *      01.POSO.20.3275.010
 *      │  │    │  │    └── location sequence at that entity
 *      │  │    │  └─────── kabupaten/kota code (BPS) — 3275 = Kota Bekasi
 *      │  │    └────────── year / registration block
 *      │  └─────────────── operating scheme
 *      └────────────────── business entity code
 *
 * This is a first-class field, not a text note:
 *  - the municipality code resolves the per-kabupaten/kota PBJT rate (§ tariff engine)
 *  - the operating scheme tells you who owns the asset vs who operates it vs who
 *    holds the licence — which is exactly the three-way split the permission model needs
 */

/** Provider schemes: the party holds the electricity relationship directly. */
export const PROVIDER_SCHEMES = ['POSO', 'POPO', 'PLPO', 'PLSO'] as const;
/** Retailer schemes: the party buys from a TWU licence holder and resells. */
export const RETAILER_SCHEMES = ['ROSO', 'ROPO', 'RLPO', 'RLSO', 'RPOO'] as const;

export type ProviderScheme = (typeof PROVIDER_SCHEMES)[number];
export type RetailerScheme = (typeof RETAILER_SCHEMES)[number];
export type SpkluScheme = ProviderScheme | RetailerScheme;

export const ALL_SCHEMES: readonly SpkluScheme[] = [...PROVIDER_SCHEMES, ...RETAILER_SCHEMES];

export interface ParsedSpkluId {
  raw: string;
  entityCode: string;
  scheme: SpkluScheme;
  schemeFamily: 'provider' | 'retailer';
  /** Decoded scheme letters: ownership and operation. */
  ownsAsset: boolean;
  selfOperated: boolean;
  block: string;
  kabupatenKotaCode: string;
  sequence: string;
}

const RE = /^(\d{2})\.([A-Z]{4})\.(\d{2})\.(\d{4})\.(\d{3})$/;

export function parseSpkluId(raw: string): ParsedSpkluId | null {
  const m = RE.exec(raw.trim().toUpperCase());
  if (!m) return null;
  const [, entityCode, scheme, block, kabupatenKotaCode, sequence] = m as unknown as string[];
  if (!ALL_SCHEMES.includes(scheme as SpkluScheme)) return null;

  const s = scheme as SpkluScheme;
  //  position 0: P provider / R retailer
  //  position 1: O owner    / L lease
  //  positions 2-3: SO self-operated / PO privately operated / OO (RPOO variant)
  const family: 'provider' | 'retailer' = s.startsWith('P') ? 'provider' : 'retailer';
  const ownsAsset = s[1] === 'O';
  const selfOperated = s.endsWith('SO');

  return {
    raw,
    entityCode: entityCode!,
    scheme: s,
    schemeFamily: family,
    ownsAsset,
    selfOperated,
    block: block!,
    kabupatenKotaCode: kabupatenKotaCode!,
    sequence: sequence!,
  };
}

export function isValidSpkluId(raw: string): boolean {
  return parseSpkluId(raw) !== null;
}

/**
 * Charging class per Permen ESDM 1/2023. Drives which regulatory service-fee
 * ceiling applies to a session.
 */
export type ChargingClass = 'slow' | 'medium' | 'fast' | 'ultrafast';

export function chargingClassForPowerW(maxPowerW: number): ChargingClass {
  const kw = maxPowerW / 1000;
  if (kw <= 7) return 'slow';
  if (kw <= 22) return 'medium';
  if (kw <= 50) return 'fast';
  return 'ultrafast';
}
