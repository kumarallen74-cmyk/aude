import {
  REQUEST_SCHEMAS_201, RESPONSE_SCHEMAS_201,
  TRIGGER_REASON_201, REASON_STOPPED, MEASURAND_201, LOCATION_201, ID_TOKEN_TYPE,
} from './schemas201.js';

/**
 * OCPP 2.1 schemas: the 2.0.1 set with 2.1's wider enumerations.
 *
 * 2.1 is a compatible extension of 2.0.1 for everything this CSMS handles:
 * the messages keep their shape and gain optional fields (which the request
 * schemas already let through), but several enumerations gain values, and a
 * 2.1 station sending one of them must not be refused as malformed:
 *   - trigger and stop reasons for cost, tariff, SoC and operation-mode events
 *     (e.g. OperationModeChanged when a car switches to discharging);
 *   - measurands for ISO 15118-20 (display SoC values, setpoints);
 *   - the Upstream measurement location and the new id token types.
 *
 * Built by widening the 2.0.1 schemas, so the two sets cannot drift apart.
 */

export const TRIGGER_REASON_21 = [
  ...TRIGGER_REASON_201,
  'CostLimitReached', 'LimitSet', 'OperationModeChanged', 'RunningCost', 'SoCLimitReached',
  'TariffChanged', 'TariffNotAccepted', 'TxResumed',
] as const;

export const REASON_STOPPED_21 = [
  ...REASON_STOPPED,
  'CostLimitReached', 'LimitSet', 'OperationModeChanged', 'ReqEnergyTransferRejected', 'TariffNotAccepted',
] as const;

export const MEASURAND_21 = [
  ...MEASURAND_201,
  'Display.PresentSOC', 'Display.MinimumSOC', 'Display.TargetSOC', 'Display.MaximumSOC',
  'Display.RemainingTimeToMinimumSOC', 'Display.RemainingTimeToTargetSOC', 'Display.RemainingTimeToMaximumSOC',
  'Display.ChargingComplete', 'Display.BatteryEnergyCapacity', 'Display.InletHot',
  'Energy.Active.Setpoint.Interval', 'Energy.Active.Import.CableLoss', 'Energy.Active.Import.LocalGeneration.Register',
  'Power.Active.Setpoint', 'Power.Reactive.Setpoint',
] as const;

export const LOCATION_21 = [...LOCATION_201, 'Upstream'] as const;
export const ID_TOKEN_TYPE_21 = [...ID_TOKEN_TYPE, 'DirectPayment', 'EVCCID', 'VIN'] as const;

const WIDEN: Array<[readonly string[], readonly string[]]> = [
  [TRIGGER_REASON_201, TRIGGER_REASON_21],
  [REASON_STOPPED, REASON_STOPPED_21],
  [MEASURAND_201, MEASURAND_21],
  [LOCATION_201, LOCATION_21],
  [ID_TOKEN_TYPE, ID_TOKEN_TYPE_21],
];

/** A deep copy in which every enum equal to a 2.0.1 list is replaced by its 2.1 superset. */
export function widen<T>(schema: T): T {
  const key = (a: readonly unknown[]) => JSON.stringify(a);
  const map = new Map(WIDEN.map(([from, to]) => [key(from), [...to]]));
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = k === 'enum' && Array.isArray(x) && map.has(key(x)) ? map.get(key(x)) : walk(x);
    }
    return out;
  };
  return walk(schema) as T;
}

export const REQUEST_SCHEMAS_21: Readonly<Record<string, object>> = Object.freeze(widen(REQUEST_SCHEMAS_201) as Record<string, object>);
export const RESPONSE_SCHEMAS_21: Readonly<Record<string, object>> = Object.freeze(widen(RESPONSE_SCHEMAS_201) as Record<string, object>);
