import { randomInt } from 'node:crypto';
import { to201Variable, from201Variable, default201Keys } from './config-catalog.js';

/**
 * Outbound command translation, OCPP 1.6 vocabulary -> OCPP 2.0.1 wire format.
 *
 * The command surface (ocpp/commands.ts) speaks 1.6: RemoteStartTransaction,
 * GetConfiguration, UnlockConnector {connectorId}. v1.1 added 2.0.1 INBOUND
 * support, but every CSMS-initiated command was still put on the wire with the
 * 1.6 action name and payload — which a 2.0.1 station answers with
 * NotImplemented or FormationViolation. On a dual-stack fleet that meant no
 * remote start, stop, unlock, reset or configuration for any 2.0.1 unit.
 *
 * This keeps ONE command vocabulary above the adapter boundary (exactly as the
 * inbound side keeps one canonical event shape) and translates at the edge.
 * Pure functions: no I/O, fully unit-testable (translate201.test.ts).
 *
 * The result mapper converts the 2.0.1 CALLRESULT back into the 1.6 shape the
 * callers already understand, so no caller gains a version branch.
 */

export interface WireCall {
  action: string;
  payload: unknown;
  /** Maps the charger's CALLRESULT back to the 1.6-shaped result callers expect. */
  mapResult: (r: any) => any;
  /**
   * Nothing to put on the wire (e.g. GetVariables/SetVariables with no mappable
   * key — both require at least one entry). The caller answers with
   * mapResult(undefined) instead of sending a frame the station must reject.
   */
  localOnly?: boolean;
}

const identity = (r: any) => r;

const PURPOSE_201: Record<string, string> = {
  ChargePointMaxProfile: 'ChargingStationMaxProfile',
  TxDefaultProfile: 'TxDefaultProfile',
  TxProfile: 'TxProfile',
};

const TRIGGER_201: Record<string, string> = {
  DiagnosticsStatusNotification: 'LogStatusNotification',
  BootNotification: 'BootNotification',
  FirmwareStatusNotification: 'FirmwareStatusNotification',
  Heartbeat: 'Heartbeat',
  MeterValues: 'MeterValues',
  StatusNotification: 'StatusNotification',
};

const AUTH_STATUS_201 = new Set(['Accepted', 'Blocked', 'ConcurrentTx', 'Expired', 'Invalid']);

/** A fresh positive int32 for 2.0.1 request ids when the caller did not supply one. */
export function newRequestId(): number {
  return randomInt(1, 2_147_483_647);
}

export function translate201(action: string, p: any): WireCall {
  p = p ?? {};
  switch (action) {
    case 'RemoteStartTransaction':
      return {
        action: 'RequestStartTransaction',
        payload: {
          idToken: { idToken: String(p.idTag ?? ''), type: 'Central' },
          remoteStartId: Number.isInteger(p.remoteStartId) ? p.remoteStartId : newRequestId(),
          ...(p.connectorId ? { evseId: Number(p.connectorId) } : {}),
        },
        mapResult: (r) => ({ status: r?.status, transactionId: r?.transactionId }),
      };

    case 'RemoteStopTransaction':
      return {
        action: 'RequestStopTransaction',
        payload: { transactionId: String(p.transactionId) },
        mapResult: (r) => ({ status: r?.status }),
      };

    case 'Reset':
      return {
        action: 'Reset',
        payload: { type: p.type === 'Hard' ? 'Immediate' : 'OnIdle' },
        mapResult: (r) => ({ status: r?.status === 'Scheduled' ? 'Accepted' : r?.status }),
      };

    case 'UnlockConnector':
      return {
        action: 'UnlockConnector',
        payload: { evseId: Number(p.connectorId ?? 1), connectorId: 1 },
        // 2.0.1: Unlocked | UnlockFailed | OngoingAuthorizedTransaction | UnknownConnector
        mapResult: (r) => ({ status: r?.status, detail201: r?.status }),
      };

    case 'ChangeAvailability':
      return {
        action: 'ChangeAvailability',
        payload: {
          operationalStatus: p.type === 'Inoperative' ? 'Inoperative' : 'Operative',
          ...(Number(p.connectorId) > 0 ? { evse: { id: Number(p.connectorId) } } : {}),
        },
        mapResult: identity,
      };

    case 'TriggerMessage':
      return {
        action: 'TriggerMessage',
        payload: {
          requestedMessage: TRIGGER_201[p.requestedMessage] ?? p.requestedMessage,
          ...(p.connectorId ? { evse: { id: Number(p.connectorId) } } : {}),
        },
        mapResult: identity,
      };

    case 'ClearCache':
      return { action: 'ClearCache', payload: {}, mapResult: identity };

    case 'GetConfiguration': {
      const keys: string[] = Array.isArray(p.key) && p.key.length ? p.key : default201Keys();
      const mapped = keys
        .map((k) => ({ k, v: to201Variable(k) }))
        .filter((x): x is { k: string; v: { component: string; variable: string } } => x.v !== null);
      const unmapped = keys.filter((k) => !to201Variable(k));
      return {
        action: 'GetVariables',
        ...(mapped.length === 0 ? { localOnly: true } : {}),
        payload: {
          getVariableData: mapped.map(({ v }) => ({
            component: { name: v.component },
            variable: { name: v.variable },
          })),
        },
        mapResult: (r) => {
          const results: any[] = Array.isArray(r?.getVariableResult) ? r.getVariableResult : [];
          const configurationKey: Array<{ key: string; value?: string; readonly: boolean }> = [];
          const unknownKey: string[] = [...unmapped];
          for (const x of results) {
            const key = from201Variable(String(x?.component?.name ?? ''), String(x?.variable?.name ?? ''));
            if (x?.attributeStatus === 'Accepted') {
              configurationKey.push({ key, value: x.attributeValue, readonly: false });
            } else {
              unknownKey.push(key);
            }
          }
          return { configurationKey, unknownKey };
        },
      };
    }

    case 'ChangeConfiguration': {
      const v = to201Variable(String(p.key));
      return {
        action: 'SetVariables',
        ...(v ? {} : { localOnly: true }),
        payload: {
          setVariableData: v
            ? [{ attributeValue: String(p.value), component: { name: v.component }, variable: { name: v.variable } }]
            : [],
        },
        mapResult: (r) => {
          if (!v) return { status: 'NotSupported' };
          const s = r?.setVariableResult?.[0]?.attributeStatus;
          if (s === 'Accepted') return { status: 'Accepted' };
          if (s === 'RebootRequired') return { status: 'RebootRequired' };
          if (s === 'Rejected') return { status: 'Rejected' };
          return { status: 'NotSupported', detail201: s };
        },
      };
    }

    case 'UpdateFirmware':
      return {
        action: 'UpdateFirmware',
        payload: {
          requestId: Number.isInteger(p.requestId) ? p.requestId : newRequestId(),
          ...(p.retries != null ? { retries: Number(p.retries) } : {}),
          ...(p.retryInterval != null ? { retryInterval: Number(p.retryInterval) } : {}),
          firmware: {
            location: String(p.location),
            retrieveDateTime: String(p.retrieveDate ?? new Date().toISOString()),
          },
        },
        mapResult: (r) => ({ status: r?.status }),
      };

    case 'GetDiagnostics':
      return {
        action: 'GetLog',
        payload: {
          logType: 'DiagnosticsLog',
          requestId: Number.isInteger(p.requestId) ? p.requestId : newRequestId(),
          ...(p.retries != null ? { retries: Number(p.retries) } : {}),
          ...(p.retryInterval != null ? { retryInterval: Number(p.retryInterval) } : {}),
          log: {
            remoteLocation: String(p.location),
            ...(p.startTime ? { oldestTimestamp: p.startTime } : {}),
            ...(p.stopTime ? { latestTimestamp: p.stopTime } : {}),
          },
        },
        mapResult: (r) => ({ fileName: r?.filename, status: r?.status }),
      };

    case 'GetLocalListVersion':
      return {
        action: 'GetLocalListVersion',
        payload: {},
        mapResult: (r) => ({ listVersion: r?.versionNumber }),
      };

    case 'SendLocalList':
      return {
        action: 'SendLocalList',
        payload: {
          versionNumber: Number(p.listVersion),
          updateType: p.updateType === 'Differential' ? 'Differential' : 'Full',
          localAuthorizationList: (Array.isArray(p.localAuthorizationList) ? p.localAuthorizationList : []).map(
            (e: any) => ({
              idToken: { idToken: String(e.idTag), type: 'ISO14443' },
              ...(e.idTagInfo
                ? {
                    idTokenInfo: {
                      status: AUTH_STATUS_201.has(e.idTagInfo.status) ? e.idTagInfo.status : 'Invalid',
                      ...(e.idTagInfo.expiryDate ? { cacheExpiryDateTime: e.idTagInfo.expiryDate } : {}),
                    },
                  }
                : {}),
            }),
          ),
        },
        mapResult: identity,
      };

    case 'ReserveNow':
      return {
        action: 'ReserveNow',
        payload: {
          id: Number(p.reservationId),
          expiryDateTime: String(p.expiryDate),
          idToken: { idToken: String(p.idTag), type: 'Central' },
          ...(p.connectorId ? { evseId: Number(p.connectorId) } : {}),
        },
        mapResult: identity,
      };

    case 'CancelReservation':
      return { action: 'CancelReservation', payload: { reservationId: Number(p.reservationId) }, mapResult: identity };

    case 'SetChargingProfile': {
      const cp = p.csChargingProfiles ?? {};
      const sched = cp.chargingSchedule ?? {};
      return {
        action: 'SetChargingProfile',
        payload: {
          evseId: Number(p.connectorId ?? 0),
          chargingProfile: {
            id: Number(cp.chargingProfileId),
            stackLevel: Number(cp.stackLevel ?? 0),
            chargingProfilePurpose: PURPOSE_201[cp.chargingProfilePurpose] ?? cp.chargingProfilePurpose,
            chargingProfileKind: cp.chargingProfileKind ?? 'Absolute',
            ...(cp.validFrom ? { validFrom: cp.validFrom } : {}),
            ...(cp.validTo ? { validTo: cp.validTo } : {}),
            ...(cp.transactionId != null ? { transactionId: String(cp.transactionId) } : {}),
            chargingSchedule: [
              {
                id: 1,
                ...(sched.startSchedule ? { startSchedule: sched.startSchedule } : {}),
                ...(sched.duration ? { duration: sched.duration } : {}),
                chargingRateUnit: sched.chargingRateUnit ?? 'W',
                chargingSchedulePeriod: sched.chargingSchedulePeriod ?? [],
              },
            ],
          },
        },
        mapResult: identity,
      };
    }

    case 'ClearChargingProfile':
      return {
        action: 'ClearChargingProfile',
        payload: {
          ...(p.id != null ? { chargingProfileId: Number(p.id) } : {}),
          chargingProfileCriteria: {
            ...(p.connectorId != null ? { evseId: Number(p.connectorId) } : {}),
            ...(p.chargingProfilePurpose
              ? { chargingProfilePurpose: PURPOSE_201[p.chargingProfilePurpose] ?? p.chargingProfilePurpose }
              : {}),
            ...(p.stackLevel != null ? { stackLevel: Number(p.stackLevel) } : {}),
          },
        },
        mapResult: identity,
      };

    case 'GetCompositeSchedule':
      return {
        action: 'GetCompositeSchedule',
        payload: {
          evseId: Number(p.connectorId ?? 0),
          duration: Number(p.duration ?? 600),
          ...(p.chargingRateUnit ? { chargingRateUnit: p.chargingRateUnit } : {}),
        },
        mapResult: (r) => ({
          status: r?.status,
          connectorId: r?.schedule?.evseId,
          scheduleStart: r?.schedule?.scheduleStart,
          chargingSchedule: r?.schedule
            ? {
                chargingRateUnit: r.schedule.chargingRateUnit,
                chargingSchedulePeriod: r.schedule.chargingSchedulePeriod,
                duration: r.schedule.duration,
              }
            : undefined,
        }),
      };

    default:
      // DataTransfer and anything already 2.0.1-shaped pass through untouched.
      return { action, payload: p, mapResult: identity };
  }
}
