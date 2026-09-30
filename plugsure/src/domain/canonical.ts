/**
 * The canonical domain model is OCPP 2.0.1-shaped. The 1.6 adapter maps UP into
 * it; a future 2.0.1 adapter maps across almost 1:1. Every downstream consumer —
 * rating, smart charging, the console, webhooks, OCPI — sees ONE shape and
 * contains no `if (version === '1.6')` branch.
 *
 * This is the single highest-leverage decision in the platform design.
 */

export type OcppVersion = 'ocpp1.6' | 'ocpp2.0.1' | 'ocpp2.1';

/** OCPP 1.6 StatusNotification connector statuses (2.0.1 uses the same vocabulary). */
export type ConnectorStatus =
  | 'Available'
  | 'Preparing'
  | 'Charging'
  | 'SuspendedEVSE'
  | 'SuspendedEV'
  | 'Finishing'
  | 'Reserved'
  | 'Unavailable'
  | 'Faulted';

/**
 * NOTE: 1.6 chargers routinely report `SuspendedEV` during a normal end-of-charge
 * taper. It is not a fault and must not raise an alert.
 */
export const NON_FAULT_STATUSES: ConnectorStatus[] = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
  'Reserved',
];

export interface EvseRef {
  chargePointId: string; // internal UUID
  ocppIdentity: string;
  /** 0 addresses the station itself. */
  evseId: number;
  connectorId: number;
}

export type TransactionEventType = 'Started' | 'Updated' | 'Ended';

export type TriggerReason =
  | 'Authorized'
  | 'CablePluggedIn'
  | 'ChargingStateChanged'
  | 'MeterValuePeriodic'
  | 'MeterValueClock'
  | 'EVCommunicationLost'
  | 'RemoteStart'
  | 'RemoteStop'
  | 'StopAuthorized'
  | 'EVDisconnected'
  | 'PowerLoss'
  | 'Reset'
  | 'Deauthorized'
  | 'Other';

export interface SampledValue {
  measurand: string;
  value: number;
  unit?: string;
  phase?: string;
  context?: string;
  location?: string;
  /**
   * Signed meter data (OCMF): an OCPP 1.6 "SignedData" sample (whose value is then NaN:
   * the reading is inside the signed data) or an OCPP 2.0.1 signedMeterValue.
   */
  signed?: { data: string; encoding?: string; method?: string; publicKey?: string };
}

export interface CanonicalMeterValue {
  timestamp: string; // ISO. ALWAYS the charger's timestamp, never receipt time.
  sampledValue: SampledValue[];
}

export interface TransactionEvent {
  eventType: TransactionEventType;
  triggerReason: TriggerReason;
  timestamp: string;
  seqNo: number;
  /** Always a string. 1.6 integers are stringified at the adapter boundary. */
  transactionId: string;
  evse: EvseRef;
  idToken?: { type: string; idToken: string };
  meterValue: CanonicalMeterValue[];
  chargingState?: 'Charging' | 'EVConnected' | 'SuspendedEV' | 'SuspendedEVSE' | 'Idle';
  stoppedReason?: string;
  /**
   * Idempotency key. Chargers replay queued transaction messages after an outage,
   * out of order and with stale timestamps. Key on charger-supplied facts ONLY —
   * never on a value the CSMS mints, or a retry cannot collide with the original.
   */
  idemKey: string;
  /** Ended events only: the charger sent neither meterStop nor transactionData. */
  meterStopAbsent?: boolean;
  /** Ended events only: |transactionData − meterStop|, for review flagging. */
  divergenceWh?: number;
  /** OCPP 2.1: the charger's operation mode (ChargingOnly, CentralSetpoint when discharging…). */
  operationMode?: string;
}

export interface StatusEvent {
  evse: EvseRef;
  status: ConnectorStatus;
  errorCode?: string;
  vendorErrorCode?: string;
  timestamp: string;
}

export interface BootEvent {
  ocppIdentity: string;
  vendor: string;
  model: string;
  serialNumber?: string;
  firmwareVersion?: string;
  ocppVersion: OcppVersion;
}

export type CanonicalEvent =
  | { kind: 'boot'; payload: BootEvent }
  | { kind: 'status'; payload: StatusEvent }
  | { kind: 'transaction'; payload: TransactionEvent }
  | { kind: 'connection'; payload: { ocppIdentity: string; connected: boolean; version?: OcppVersion } }
  | { kind: 'authorize'; payload: { ocppIdentity: string; idTag: string } }
  | { kind: 'datatransfer'; payload: { ocppIdentity: string; vendorId: string; messageId?: string; data?: unknown } };

/** Measurand names we care about, in preference order for energy totals. */
export const ENERGY_MEASURAND = 'Energy.Active.Import.Register';
export const POWER_MEASURAND = 'Power.Active.Import';
/** Energy the car gave back (bidirectional charging). */
export const EXPORT_MEASURAND = 'Energy.Active.Export.Register';

/** Per-phase identifiers a 3-phase AC charger uses for its energy registers. */
const PHASE_KEYS = new Set(['L1', 'L2', 'L3', 'L1-N', 'L2-N', 'L3-N']);

function toWh(sv: SampledValue): number {
  const unit = (sv.unit ?? 'Wh').toLowerCase();
  return unit === 'kwh' ? sv.value * 1000 : sv.value;
}

/**
 * Extract the energy register from one MeterValue entry.
 *
 * Two things this must get right, both of which were wrong:
 *
 *  1. PER-PHASE REGISTERS. A 3-phase AC charger commonly reports
 *     Energy.Active.Import.Register once per phase. Taking the first match read
 *     one phase as the whole session and under-billed by 3x. When phase-tagged
 *     samples are present they are SUMMED; an untagged total, if also present,
 *     wins outright because it is already the aggregate.
 *  2. Energy.Active.Import.Interval is a delta, not a register, and must never
 *     be mistaken for one — a charger configured for interval-only metering
 *     previously produced zero billed energy.
 */
function registerFromEntry(entry: CanonicalMeterValue, measurand: string = ENERGY_MEASURAND): number | null {
  let total: number | null = null;
  let phaseSum = 0;
  let phaseCount = 0;

  for (const sv of entry.sampledValue) {
    // A signed sample carries its reading inside the signed data, not in value: never a register here.
    if (sv.measurand !== measurand || !Number.isFinite(sv.value)) continue;
    if (sv.phase && PHASE_KEYS.has(sv.phase)) {
      phaseSum += toWh(sv);
      phaseCount++;
    } else if (!sv.phase) {
      total = toWh(sv);
    }
  }
  if (total !== null) return Math.round(total);
  if (phaseCount > 0) return Math.round(phaseSum);
  return null;
}

/**
 * The register reading for a batch of meter values.
 *
 * Returns the MAXIMUM across entries rather than the last. Offline chargers
 * replay queued samples out of order, and taking the last one let a stale sample
 * regress a session's billed energy — a defect in the exact scenario the platform
 * advertises as solved.
 *
 * Returns null when no register is present. Callers must distinguish "absent"
 * from "zero": a `?? 0` here made the documented running-total fallback
 * unreachable and billed a fully metered session at zero.
 */
export function energyWhFrom(mv: CanonicalMeterValue[], measurand: string = ENERGY_MEASURAND): number | null {
  let best: number | null = null;
  for (const entry of mv) {
    const v = registerFromEntry(entry, measurand);
    if (v === null) continue;
    if (best === null || v > best) best = v;
  }
  return best;
}

/** Energy registers in occurrence order, for diagnostics and rollover detection. */
export function energySeriesFrom(mv: CanonicalMeterValue[]): number[] {
  return mv.map((e) => registerFromEntry(e)).filter((v): v is number => v !== null);
}

/** The car's state of charge (%) in the latest sample that carries one, or null. */
export function socFrom(mv: CanonicalMeterValue[]): number | null {
  for (let i = mv.length - 1; i >= 0; i--) {
    for (const sv of mv[i]!.sampledValue) {
      if ((sv.measurand === 'SoC' || sv.measurand === 'Display.PresentSOC') && Number.isFinite(sv.value) && sv.value >= 0 && sv.value <= 100) return sv.value;
    }
  }
  return null;
}

/** The most recent instantaneous power reading, in watts. */
export function powerWFrom(mv: CanonicalMeterValue[]): number | null {
  for (let i = mv.length - 1; i >= 0; i--) {
    for (const sv of mv[i]!.sampledValue) {
      if (sv.measurand !== POWER_MEASURAND || !Number.isFinite(sv.value)) continue;
      const unit = (sv.unit ?? 'W').toLowerCase();
      return Math.round(unit === 'kw' ? sv.value * 1000 : sv.value);
    }
  }
  return null;
}
