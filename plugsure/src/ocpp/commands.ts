import { query, one } from '../db/pool.js';
import { logger } from '../logger.js';
import * as registry from './registry.js';
import { writeAudit } from '../services/audit.js';
import { bridgeCall, bridgeEnabledOnApi } from './bridge.js';
import { translate201, type WireCall } from './translate201.js';

/**
 * Outbound command surface.
 *
 * In production these publish to `cmd:{nodeId}` over Redis and await the
 * correlated result; here the registry holds the socket directly. Either way the
 * API never touches a WebSocket, and EVERY command is written to the audit log
 * with the actor who issued it. When a driver calls to ask why their session
 * stopped, support must be able to answer in one query.
 */

export interface Actor {
  type: 'user' | 'api_client' | 'system';
  id?: string;
  orgId?: string;
  ip?: string;
}

async function send<T = any>(
  ocppIdentity: string,
  action: string,
  payload: unknown,
  actor: Actor,
  priority: 0 | 1 = 0,
): Promise<T> {
  const conn = registry.get(ocppIdentity);
  // In the split deployment the socket lives in the gateway process; the bridge
  // relays the call there. Without a local socket AND without the bridge there is
  // nothing to send on.
  if (!conn && !bridgeEnabledOnApi()) throw new Error(`charge point ${ocppIdentity} is not connected`);

  // One command vocabulary above this line; the wire format is chosen by the
  // version the charger actually negotiated.
  const version = conn?.version ?? (await wireVersion(ocppIdentity));
  const wire: WireCall =
    version === 'ocpp2.0.1' || version === 'ocpp2.1'
      ? translate201(action, payload)
      : { action, payload: strip16(action, payload), mapResult: (r: any) => r };

  await writeAudit({
    orgId: actor.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: `ocpp.${action}`,
    targetType: 'charge_point',
    targetId: ocppIdentity,
    after: payload as Record<string, unknown>,
    ip: actor.ip,
  });

  logger.info(
    {
      cp: ocppIdentity,
      action,
      wireAction: wire.action,
      via: conn ? 'local' : 'bridge',
      actor: actor.id ?? actor.type,
      queueDepth: conn?.rpc.queueDepth,
    },
    'issuing remote command',
  );
  // Operator commands run at priority 0. Provisioning runs at 1, so a
  // RemoteStopTransaction can never queue behind sixteen configuration writes —
  // which previously meant a live session could not be stopped for ~8 minutes.
  if (wire.localOnly) return wire.mapResult(undefined) as T;
  const raw = conn
    ? await conn.rpc.call<T>(wire.action, wire.payload, priority)
    : await bridgeCall<T>(ocppIdentity, wire.action, wire.payload, priority);
  return wire.mapResult(raw) as T;
}

/**
 * The protocol a charger speaks: the negotiated version on its connection, else what the
 * gateway reported over the bridge, else the version it is registered with. Without the last,
 * a command to a 2.0.1 station the bridge had not reported yet went out in 1.6 form
 * (ChangeConfiguration instead of SetVariables) and was answered as if it had worked.
 */
export async function wireVersion(id: string): Promise<string | undefined> {
  return registry.get(id)?.version ?? registry.versionOf(id)
    ?? (await one<{ v: string | null }>(`SELECT ocpp_version AS v FROM charge_point WHERE ocpp_identity = $1`, [id]))?.v ?? undefined;
}

/**
 * Fields the 1.6 schema does not define must not reach a 1.6 charger — strict
 * firmware answers FormationViolation. `requestId` exists only to correlate a
 * 2.0.1 UpdateFirmware / GetLog with its status notifications.
 */
function strip16(action: string, payload: unknown): unknown {
  if ((action === 'UpdateFirmware' || action === 'GetDiagnostics') && payload && typeof payload === 'object') {
    const { requestId: _drop, ...rest } = payload as Record<string, unknown>;
    return rest;
  }
  return payload;
}

/** Background traffic: provisioning, local auth list sync, reconciliation. */
export async function sendBackground<T = any>(
  ocppIdentity: string,
  action: string,
  payload: unknown,
  actor: Actor = { type: 'system' },
): Promise<T> {
  return send<T>(ocppIdentity, action, payload, actor, 1);
}

export const remoteStartTransaction = (id: string, connectorId: number, idTag: string, actor: Actor) =>
  send<{ status: string }>(id, 'RemoteStartTransaction', { connectorId, idTag }, actor);

/**
 * 1.6 transaction ids are CSMS-assigned integers; 2.0.1 ids are the station's own
 * strings. Accept either here and let the wire translation decide.
 */
export const remoteStopTransaction = (id: string, transactionId: number | string, actor: Actor) =>
  send<{ status: string }>(id, 'RemoteStopTransaction', { transactionId }, actor);

export const reset = (id: string, type: 'Soft' | 'Hard', actor: Actor) =>
  send<{ status: string }>(id, 'Reset', { type }, actor);

export const unlockConnector = (id: string, connectorId: number, actor: Actor) =>
  send<{ status: string }>(id, 'UnlockConnector', { connectorId }, actor);

export const changeAvailability = (
  id: string,
  connectorId: number,
  type: 'Operative' | 'Inoperative',
  actor: Actor,
) => send<{ status: string }>(id, 'ChangeAvailability', { connectorId, type }, actor);

export const triggerMessage = (id: string, requestedMessage: string, connectorId: number | undefined, actor: Actor) =>
  send<{ status: string }>(
    id,
    'TriggerMessage',
    connectorId ? { requestedMessage, connectorId } : { requestedMessage },
    actor,
  );

export const getConfiguration = (id: string, keys: string[] | undefined, actor: Actor) =>
  send<{ configurationKey?: any[]; unknownKey?: string[] }>(
    id,
    'GetConfiguration',
    keys?.length ? { key: keys } : {},
    actor,
  );

export const changeConfiguration = (id: string, key: string, value: string, actor: Actor) =>
  send<{ status: string }>(id, 'ChangeConfiguration', { key, value }, actor);

export const clearCache = (id: string, actor: Actor) =>
  send<{ status: string }>(id, 'ClearCache', {}, actor);

export const getCompositeSchedule = (
  id: string,
  connectorId: number,
  durationS: number,
  chargingRateUnit: 'A' | 'W' | undefined,
  actor: Actor,
) =>
  send<{ status: string; connectorId?: number; scheduleStart?: string; chargingSchedule?: unknown }>(
    id,
    'GetCompositeSchedule',
    { connectorId, duration: durationS, ...(chargingRateUnit ? { chargingRateUnit } : {}) },
    actor,
  );

export const dataTransfer = (
  id: string,
  vendorId: string,
  messageId: string | undefined,
  data: unknown,
  actor: Actor,
) =>
  send<{ status: string; data?: unknown }>(
    id,
    'DataTransfer',
    { vendorId, ...(messageId ? { messageId } : {}), ...(data !== undefined ? { data } : {}) },
    actor,
  );

export const getDiagnostics = (
  id: string,
  location: string,
  actor: Actor,
  opts: { startTime?: string; stopTime?: string; retries?: number; retryInterval?: number; requestId?: number } = {},
) =>
  send<{ fileName?: string; status?: string }>(
    id,
    'GetDiagnostics',
    {
      location,
      ...(opts.startTime ? { startTime: opts.startTime } : {}),
      ...(opts.stopTime ? { stopTime: opts.stopTime } : {}),
      ...(opts.retries != null ? { retries: opts.retries } : {}),
      ...(opts.retryInterval != null ? { retryInterval: opts.retryInterval } : {}),
      // requestId is 2.0.1-only; translate201 consumes it and 1.6 never sees it.
      ...(opts.requestId != null ? { requestId: opts.requestId } : {}),
    },
    actor,
  );

export const updateFirmware = (
  id: string,
  location: string,
  retrieveDate: string,
  actor: Actor,
  opts: { retries?: number; retryInterval?: number; requestId?: number } = {},
) =>
  send<{ status?: string }>(
    id,
    'UpdateFirmware',
    {
      location,
      retrieveDate,
      ...(opts.retries != null ? { retries: opts.retries } : {}),
      ...(opts.retryInterval != null ? { retryInterval: opts.retryInterval } : {}),
      ...(opts.requestId != null ? { requestId: opts.requestId } : {}),
    },
    actor,
  );

export const sendLocalList = (
  id: string,
  listVersion: number,
  entries: Array<{ idTag: string; idTagInfo?: { status: string; expiryDate?: string } }>,
  actor: Actor,
  updateType: 'Full' | 'Differential' = 'Full',
) =>
  send<{ status: string }>(
    id,
    'SendLocalList',
    { listVersion, updateType, localAuthorizationList: entries },
    actor,
    1,
  );

export const reserveNow = (
  id: string,
  args: { connectorId: number; expiryDate: string; idTag: string; reservationId: number },
  actor: Actor,
) => send<{ status: string }>(id, 'ReserveNow', args, actor);

export const cancelReservation = (id: string, reservationId: number, actor: Actor) =>
  send<{ status: string }>(id, 'CancelReservation', { reservationId }, actor);

/**
 * OCPP 2.1: the energy transfer modes the car may use in this transaction. Sent when
 * the driver's consent changes, so a car whose driver said no is not offered
 * bidirectional transfer (DC_BPT / AC_BPT) at all.
 */
export const notifyAllowedEnergyTransfer = (id: string, transactionId: string, modes: string[], actor: Actor) =>
  send<{ status: string }>(id, 'NotifyAllowedEnergyTransfer', { transactionId, allowedEnergyTransfer: modes }, actor);

export const getLocalListVersion = (id: string, actor: Actor) =>
  send<{ listVersion: number }>(id, 'GetLocalListVersion', {}, actor, 1);

// ── OCPP 2.0.1 device model (native 2.0.1 actions; translate201 passes them through).

type ComponentVariable = {
  component: { name: string; instance?: string; evse?: { id: number; connectorId?: number } };
  variable: { name: string; instance?: string };
};

export const getBaseReport = (id: string, requestId: number, reportBase: string, actor: Actor) =>
  send<{ status: string }>(id, 'GetBaseReport', { requestId, reportBase }, actor);

export const getVariables = (id: string, items: Array<ComponentVariable & { attributeType?: string }>, actor: Actor) =>
  send<{ getVariableResult: Array<ComponentVariable & { attributeStatus: string; attributeType?: string; attributeValue?: string }> }>(
    id, 'GetVariables', { getVariableData: items }, actor);

export const setVariables = (id: string, items: Array<ComponentVariable & { attributeType?: string; attributeValue: string }>, actor: Actor) =>
  send<{ setVariableResult: Array<ComponentVariable & { attributeStatus: string; attributeType?: string; attributeStatusInfo?: { reasonCode?: string; additionalInfo?: string } }> }>(
    id, 'SetVariables', { setVariableData: items }, actor);

export const getMonitoringReport = (id: string, requestId: number, actor: Actor) =>
  send<{ status: string }>(id, 'GetMonitoringReport', { requestId }, actor);

export const setVariableMonitoring = (
  id: string,
  items: Array<ComponentVariable & { id?: number; type: string; value: number; severity: number; transaction?: boolean }>,
  actor: Actor,
) =>
  send<{ setMonitoringResult: Array<ComponentVariable & { id?: number; status: string; type: string; severity: number; statusInfo?: { reasonCode?: string; additionalInfo?: string } }> }>(
    id, 'SetVariableMonitoring', { setMonitoringData: items }, actor);

export const clearVariableMonitoring = (id: string, ids: number[], actor: Actor) =>
  send<{ clearMonitoringResult: Array<{ id: number; status: string }> }>(id, 'ClearVariableMonitoring', { id: ids }, actor);

/** ISO 15118 Plug & Charge over OCPP 1.6 (OCA application note): 2.0.1 messages inside DataTransfer. */
export const PNC_VENDOR_ID = 'org.openchargealliance.iso15118pnc';

/**
 * A Plug & Charge message to a charger: CertificateSigned, InstallCertificate,
 * GetInstalledCertificateIds, DeleteCertificate, TriggerMessage(SignV2GCertificate).
 * A 2.0.1 station gets the message itself; a 1.6 charger gets it wrapped in
 * DataTransfer (messageId = the action, data = the JSON payload as a string),
 * and its answer is unwrapped the same way, so callers see the 2.0.1 result.
 */
export async function pncCommand<T = any>(id: string, action: string, payload: unknown, actor: Actor, priority: 0 | 1 = 0): Promise<T> {
  const version = await wireVersion(id);
  if (version === 'ocpp2.0.1' || version === 'ocpp2.1') return send<T>(id, action, payload, actor, priority);
  const r = await send<{ status?: string; data?: unknown }>(id, 'DataTransfer', { vendorId: PNC_VENDOR_ID, messageId: action, data: JSON.stringify(payload) }, actor, priority);
  if (r?.status !== 'Accepted') return { status: 'Rejected', dataTransferStatus: r?.status } as T;
  if (typeof r.data === 'string' && r.data) {
    try { return JSON.parse(r.data) as T; } catch { return { status: 'Rejected', detail: 'the charger answered with data that is not JSON' } as T; }
  }
  return { status: 'Accepted' } as T;
}

/** Is this charger reachable from THIS process — locally or through the bridge? */
export function reachable(id: string): boolean {
  return registry.isOnline(id);
}

export const clearChargingProfile = (
  id: string,
  filter: { id?: number; connectorId?: number; chargingProfilePurpose?: string; stackLevel?: number },
  actor: Actor,
) => {
  // Sending ClearChargingProfile with NO fields clears everything on the station.
  // Always scope it.
  if (Object.keys(filter).length === 0) {
    throw new Error('refusing to clear all charging profiles — scope the request');
  }
  return send<{ status: string }>(id, 'ClearChargingProfile', filter, actor);
};

export interface SetProfileArgs {
  connectorId: number;
  purpose: 'ChargePointMaxProfile' | 'TxDefaultProfile' | 'TxProfile';
  stackLevel: number;
  ocppProfileId: number;
  limit: number;
  unit: 'A' | 'W';
  numberPhases?: number;
  /** ALWAYS set on transient profiles, or the charger never falls back. */
  durationS?: number;
  /** In wire form — use registry.wireTransactionId() (1.6 integer, 2.0.1 string). */
  transactionId?: number | string;
  validFromIso?: string;
  validToIso?: string;
  /**
   * OCPP 2.1 bidirectional charging: ask the car to give this many watts back
   * (operation mode CentralSetpoint, a negative setpoint). limit is then ignored.
   * dynamic for a car in ISO 15118-20 dynamic control mode.
   */
  discharge?: { watts: number; dynamic?: boolean };
}

export async function setChargingProfile(id: string, a: SetProfileArgs, actor: Actor) {
  // Guards for the two 1.6 rules that most implementations violate.
  if (a.purpose === 'ChargePointMaxProfile' && a.connectorId !== 0) {
    throw new Error('ChargePointMaxProfile is only valid on connectorId 0');
  }
  if (a.purpose === 'TxProfile') {
    if (a.connectorId === 0) throw new Error('TxProfile is invalid on connectorId 0');
    if (a.transactionId == null) throw new Error('TxProfile requires a transactionId');
  }
  if (a.discharge) {
    if (a.purpose !== 'TxProfile') throw new Error('a discharge setpoint belongs in a TxProfile');
    if (!(a.discharge.watts > 0)) throw new Error('discharge watts must be positive');
    if ((await wireVersion(id)) !== 'ocpp2.1') throw new Error('discharging needs OCPP 2.1');
  }
  // A discharge period: the car follows the (negative) setpoint, never beyond the discharge limit.
  const period = a.discharge
    ? { startPeriod: 0, operationMode: 'CentralSetpoint', setpoint: -Math.round(a.discharge.watts), dischargeLimit: -Math.round(a.discharge.watts) }
    : {
        startPeriod: 0,
        limit: a.unit === 'A' ? round1(a.limit) : Math.round(a.limit),
        ...(a.numberPhases ? { numberPhases: a.numberPhases } : {}),
      };

  const csChargingProfiles: Record<string, unknown> = {
    chargingProfileId: a.ocppProfileId,
    stackLevel: a.stackLevel,
    chargingProfilePurpose: a.purpose,
    // ABSOLUTE, anchored to wall clock — not Relative.
    //
    // A Relative schedule anchors to the START OF THE TRANSACTION. Re-sending one
    // with a fixed 900 s duration every 30 s to a session already running 40
    // minutes produced a schedule that expired 25 minutes ago, so the limit the
    // optimiser believed it had applied was not in force at all.
    chargingProfileKind: a.discharge?.dynamic ? 'Dynamic' : 'Absolute',
    // ISO 15118-20 dynamic control: the station expects a fresh setpoint at least this often (s).
    ...(a.discharge?.dynamic ? { dynUpdateInterval: 60 } : {}),
    ...(a.validFromIso ? { validFrom: a.validFromIso } : {}),
    ...(a.validToIso ? { validTo: a.validToIso } : {}),
    chargingSchedule: {
      ...(a.durationS ? { duration: a.durationS } : {}),
      startSchedule: new Date().toISOString(),
      chargingRateUnit: a.discharge ? 'W' : a.unit,
      chargingSchedulePeriod: [period],
    },
    ...(a.transactionId != null ? { transactionId: a.transactionId } : {}),
  };

  const res = await send<{ status: string }>(
    id,
    'SetChargingProfile',
    { connectorId: a.connectorId, csChargingProfiles },
    actor,
  );

  const cp = await one<{ id: string }>(`SELECT id FROM charge_point WHERE ocpp_identity = $1`, [id]);
  if (cp) {
    await query(
      `INSERT INTO charging_profile
         (charge_point_id, connector_no, purpose, stack_level, ocpp_profile_id,
          transaction_id, limit_w, duration_s, state, unit, limit_value, valid_to, last_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        cp.id,
        a.connectorId,
        a.purpose,
        a.stackLevel,
        a.ocppProfileId,
        a.transactionId != null ? String(a.transactionId) : null,
        // Always persist the limit in WATTS so the stored history is comparable
        // across AC and DC hardware; the wire unit is kept alongside it. A discharge is negative.
        a.discharge ? -Math.round(a.discharge.watts) : a.unit === 'W' ? Math.round(a.limit) : Math.round(a.limit * (a.numberPhases ?? 3) * 230),
        a.durationS ?? null,
        res?.status === 'Accepted' ? 'accepted' : 'rejected',
        a.discharge ? 'W' : a.unit,
        a.discharge ? -Math.round(a.discharge.watts) : a.limit,
        a.durationS ? new Date(Date.now() + a.durationS * 1000) : null,
        res?.status === 'Accepted' ? null : (res?.status ?? 'no response'),
      ],
    );

    if (res?.status !== 'Accepted') {
      // Rejections were previously recorded and forgotten: no retry, no alert,
      // and nothing ever reconciled what the charger actually held.
      logger.warn(
        { cp: id, connector: a.connectorId, purpose: a.purpose, status: res?.status },
        'charger did not accept the charging profile',
      );
    }
  }
  return res;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
