import { randomUUID } from 'node:crypto';

/**
 * OCPP 2.0.1 / 2.1 for the virtual charger.
 *
 * VirtualChargePoint was written in the OCPP 1.6 vocabulary (Start / Meter /
 * Stop, RemoteStartTransaction, connectorId). Rather than a second simulator,
 * this layer translates at its message boundary, both ways — the mirror of what
 * the CSMS does for its own commands (ocpp/translate201.ts). Everything that
 * makes the simulator useful stays shared: the power and energy model, store-
 * and-forward replay, fault injection, the clock.
 *
 *   out(action16, payload16)  → the 2.x CALL to send, and how to map its answer back
 *   in(action2x, payload2x)   → the 1.6 call the charger model understands, and how
 *                                to map its answer to the 2.x result; or a direct answer
 *                                for what only 2.x has (device model variables, reports,
 *                                allowed energy transfer)
 *
 * Transactions: a 2.x station names its own transaction ids. The model keeps
 * numeric ids (1.6 style); this layer hands it a number per transaction and
 * keeps the string it put on the wire, with the sequence number 2.x requires.
 */

export type Protocol2 = 'ocpp2.0.1' | 'ocpp2.1';
const PNC_VENDOR = 'org.openchargealliance.iso15118pnc';
const PNC_NATIVE = new Set(['Authorize', 'Get15118EVCertificate', 'GetCertificateStatus', 'SignCertificate']);

export interface OutCall { action: string; payload: unknown; map: (r: any) => any; skip?: boolean }
export interface InCall { action?: string; payload?: unknown; map?: (r: any) => any; direct?: () => any | Promise<any> }

/** What the layer needs to know about the charger model at the moment it translates. */
export interface ModelState {
  identity: string;
  vendor: string;
  model: string;
  firmware: string;
  /** Giving energy back right now (OCPP 2.1 only). */
  discharging(): boolean;
  /** Send a CALL the model knows nothing about (NotifyReport after GetBaseReport). */
  send(action: string, payload: unknown): Promise<any>;
  /** The driver's car may not use bidirectional transfer (NotifyAllowedEnergyTransfer). */
  setBidirectionalAllowed(allowed: boolean): void;
  /** A variable changed (e.g. SignReadings). */
  onVariable?(component: string, variable: string, value: string): void;
}

const STATUS_2X: Record<string, string> = {
  Available: 'Available', Preparing: 'Occupied', Charging: 'Occupied', SuspendedEV: 'Occupied', SuspendedEVSE: 'Occupied',
  Finishing: 'Occupied', Reserved: 'Reserved', Unavailable: 'Unavailable', Faulted: 'Faulted',
};
const STOP_REASON: Record<string, [trigger: string, reason: string]> = {
  Local: ['StopAuthorized', 'Local'], Remote: ['RemoteStop', 'Remote'], EVDisconnected: ['EVDeparted', 'EVDisconnected'],
  EmergencyStop: ['AbnormalCondition', 'EmergencyStop'], PowerLoss: ['AbnormalCondition', 'PowerLoss'], Reboot: ['ResetCommand', 'Reboot'],
  HardReset: ['ResetCommand', 'ImmediateReset'], SoftReset: ['ResetCommand', 'ImmediateReset'],
};
const LOG_STATUS: Record<string, string> = { Idle: 'Idle', Uploading: 'Uploading', Uploaded: 'Uploaded', UploadFailed: 'UploadFailure' };

/** The 2.x device model the virtual station reports and lets the CSMS change. */
function defaultVariables(state: ModelState, dc: boolean): Map<string, { value: string; dataType: string; readonly: boolean }> {
  const v = new Map<string, { value: string; dataType: string; readonly: boolean }>();
  const put = (k: string, value: string, dataType = 'string', readonly = false) => v.set(k, { value, dataType, readonly });
  put('OCPPCommCtrlr.HeartbeatInterval', '300', 'integer');
  put('OCPPCommCtrlr.PublicKeyWithSignedMeterValue', 'OncePerTransaction', 'OptionList');
  put('SampledDataCtrlr.SignReadings', 'true', 'boolean');
  put('SampledDataCtrlr.TxUpdatedInterval', '60', 'integer');
  put('SampledDataCtrlr.TxUpdatedMeasurands', 'Energy.Active.Import.Register,Power.Active.Import,SoC', 'MemberList');
  put('AlignedDataCtrlr.SignReadings', 'true', 'boolean');
  put('AuthCtrlr.AuthorizeRemoteStart', 'false', 'boolean');
  put('ChargingStation.Model', state.model, 'string', true);
  put('ChargingStation.VendorName', state.vendor, 'string', true);
  put('SmartChargingCtrlr.RateUnit', dc ? 'W' : 'A,W', 'MemberList', true);
  put('ISO15118Ctrlr.PnCEnabled', 'false', 'boolean');
  return v;
}

export class Ocpp2Shim {
  private seq = new Map<number, { id: string; seqNo: number; evseId: number }>();
  private nextHandle = 1;
  private pendingRemoteStartId: number | null = null;
  private emaids = new Set<string>();
  private requestIds = { log: 0, firmware: 0 };
  readonly variables: Map<string, { value: string; dataType: string; readonly: boolean }>;

  constructor(readonly protocol: Protocol2, private m: ModelState, dc: boolean) {
    this.variables = defaultVariables(m, dc);
  }

  variable(key: string): string | undefined { return this.variables.get(key)?.value; }

  /** The wire transaction id for a model's numeric one. */
  txString(handle: number | null | undefined): string | null {
    return handle == null ? null : this.seq.get(handle)?.id ?? null;
  }

  // ─────────────────────────────────────────────── charger → CSMS

  out(action: string, p: any): OutCall {
    const id = (r: any) => r;
    switch (action) {
      case 'BootNotification':
        return {
          action,
          payload: { reason: 'PowerUp', chargingStation: { model: String(p.chargePointModel).slice(0, 20), vendorName: String(p.chargePointVendor).slice(0, 50), serialNumber: String(p.chargePointSerialNumber ?? '').slice(0, 25), firmwareVersion: String(p.firmwareVersion ?? '').slice(0, 50) } },
          map: id,
        };
      case 'StatusNotification':
        return {
          action,
          payload: { timestamp: p.timestamp, connectorStatus: STATUS_2X[p.status] ?? 'Unavailable', evseId: Number(p.connectorId ?? 0), connectorId: Number(p.connectorId ?? 0) > 0 ? 1 : 0 },
          map: id,
        };
      case 'Authorize':
        return { action, payload: { idToken: { idToken: String(p.idTag), type: 'ISO14443' } }, map: (r) => ({ idTagInfo: r?.idTokenInfo }) };
      case 'StartTransaction': {
        const handle = this.nextHandle++;
        const tx = { id: `${this.m.identity}-${handle}-${randomUUID().slice(0, 8)}`, seqNo: 0, evseId: Number(p.connectorId ?? 1) };
        this.seq.set(handle, tx);
        const remote = this.pendingRemoteStartId;
        this.pendingRemoteStartId = null;
        const emaid = this.emaids.has(String(p.idTag));
        const begin = [{ value: Number(p.meterStart), measurand: 'Energy.Active.Import.Register', context: 'Transaction.Begin', unitOfMeasure: { unit: 'Wh' } }];
        if (p._signedBegin) begin.push(this.signedSample(p._signedBegin) as any);
        return {
          action: 'TransactionEvent',
          payload: {
            eventType: 'Started', timestamp: p.timestamp, triggerReason: remote != null ? 'RemoteStart' : 'Authorized', seqNo: tx.seqNo++,
            transactionInfo: { transactionId: tx.id, chargingState: 'Charging', ...(remote != null ? { remoteStartId: remote } : {}) },
            evse: { id: tx.evseId, connectorId: 1 },
            idToken: { idToken: String(p.idTag), type: emaid ? 'eMAID' : remote != null ? 'Central' : 'ISO14443' },
            meterValue: [{ timestamp: p.timestamp, sampledValue: begin }],
          },
          map: (r) => ({ transactionId: handle, idTagInfo: { status: r?.idTokenInfo?.status ?? 'Accepted' } }),
        };
      }
      case 'MeterValues': {
        const tx = p.transactionId != null ? this.seq.get(Number(p.transactionId)) : undefined;
        const meterValue = this.meterValues(p.meterValue);
        if (!tx) return { action: 'MeterValues', payload: { evseId: Number(p.connectorId ?? 0), meterValue }, map: () => ({}) };
        return {
          action: 'TransactionEvent',
          payload: {
            eventType: 'Updated', timestamp: p.meterValue?.[0]?.timestamp ?? new Date().toISOString(),
            triggerReason: p.meterValue?.[0]?.sampledValue?.[0]?.context === 'Trigger' ? 'Trigger' : 'MeterValuePeriodic', seqNo: tx.seqNo++,
            transactionInfo: { transactionId: tx.id, chargingState: 'Charging', ...this.opMode() },
            evse: { id: tx.evseId, connectorId: 1 }, meterValue,
          },
          map: () => ({}),
        };
      }
      case 'StopTransaction': {
        const handle = Number(p.transactionId);
        const tx = this.seq.get(handle) ?? { id: `${this.m.identity}-orphan-${handle}`, seqNo: 1, evseId: 1 };
        const [trigger, reason] = STOP_REASON[String(p.reason ?? 'Local')] ?? ['StopAuthorized', 'Local'];
        const meterValue = this.meterValues(p.transactionData ?? []);
        if (typeof p.meterStop === 'number' && !meterValue.some((m: any) => m.sampledValue.some((s: any) => s.measurand === 'Energy.Active.Import.Register' && s.context === 'Transaction.End' && !s.signedMeterValue))) {
          meterValue.push({ timestamp: p.timestamp, sampledValue: [{ value: p.meterStop, measurand: 'Energy.Active.Import.Register', context: 'Transaction.End', unitOfMeasure: { unit: 'Wh' } }] });
        }
        this.seq.delete(handle);
        return {
          action: 'TransactionEvent',
          payload: {
            eventType: 'Ended', timestamp: p.timestamp, triggerReason: trigger, seqNo: tx.seqNo++,
            transactionInfo: { transactionId: tx.id, chargingState: 'Idle', stoppedReason: reason },
            evse: { id: tx.evseId, connectorId: 1 },
            ...(p.idTag ? { idToken: { idToken: String(p.idTag), type: this.emaids.has(String(p.idTag)) ? 'eMAID' : 'ISO14443' } } : {}),
            meterValue,
          },
          map: () => ({ idTagInfo: { status: 'Accepted' } }),
        };
      }
      case 'FirmwareStatusNotification':
        return { action, payload: { status: p.status, ...(this.requestIds.firmware ? { requestId: this.requestIds.firmware } : {}) }, map: id };
      case 'DiagnosticsStatusNotification':
        return { action: 'LogStatusNotification', payload: { status: LOG_STATUS[p.status] ?? 'Idle', ...(this.requestIds.log ? { requestId: this.requestIds.log } : {}) }, map: id };
      case 'DataTransfer':
        // Plug & Charge: 2.x has the messages natively; the model wraps them as the 1.6 application note does.
        if (p?.vendorId === PNC_VENDOR && PNC_NATIVE.has(String(p.messageId))) {
          const native = typeof p.data === 'string' ? JSON.parse(p.data) : p.data ?? {};
          if (p.messageId === 'Authorize' && native?.idToken?.type === 'eMAID') this.emaids.add(String(native.idToken.idToken));
          return { action: String(p.messageId), payload: native, map: (r) => ({ status: 'Accepted', data: JSON.stringify(r ?? {}) }) };
        }
        return { action, payload: p, map: id };
      default:
        // Heartbeat, and 2.x messages the model sends as they are (NotifyEVChargingNeeds, NotifyReport…).
        return { action, payload: p, map: id };
    }
  }

  private opMode() {
    if (this.protocol !== 'ocpp2.1') return {};
    return { operationMode: this.m.discharging() ? 'CentralSetpoint' : 'ChargingOnly' };
  }

  /** 1.6 sampled values → 2.x (numbers, unitOfMeasure; a signed sample becomes a signedMeterValue). */
  private meterValues(mv: any[]): any[] {
    return (Array.isArray(mv) ? mv : []).map((m) => ({
      timestamp: m.timestamp,
      sampledValue: (m.sampledValue ?? []).map((s: any) => (s.format === 'SignedData' ? this.signedSample(s) : {
        value: Number(s.value),
        ...(s.measurand ? { measurand: s.measurand } : {}),
        ...(s.context ? { context: s.context } : {}),
        ...(s.phase ? { phase: s.phase } : {}),
        ...(s.location ? { location: s.location } : {}),
        ...(s.unit ? { unitOfMeasure: { unit: s.unit } } : {}),
      })),
    }));
  }

  /** A signed reading as OCPP 2.x carries it: the value, and the OCMF data base64-encoded beside it. */
  private signedSample(s: { value: string; context?: string; _wh: number; _publicKeyHex?: string; measurand?: string }) {
    const withKey = this.variable('OCPPCommCtrlr.PublicKeyWithSignedMeterValue') !== 'Never';
    return {
      value: s._wh,
      measurand: s.measurand ?? 'Energy.Active.Import.Register',
      ...(s.context ? { context: s.context } : {}),
      unitOfMeasure: { unit: 'Wh' },
      signedMeterValue: {
        signedMeterData: Buffer.from(String(s.value), 'utf8').toString('base64'),
        signingMethod: '',
        encodingMethod: 'OCMF',
        publicKey: withKey && s._publicKeyHex ? Buffer.from(s._publicKeyHex, 'utf8').toString('base64') : '',
      },
    };
  }

  // ─────────────────────────────────────────────── CSMS → charger

  in(action: string, p: any): InCall {
    const pnc = (messageId: string, data: unknown): InCall => ({
      action: 'DataTransfer',
      payload: { vendorId: PNC_VENDOR, messageId, data: JSON.stringify(data) },
      map: (r) => (r?.status === 'Accepted' && typeof r.data === 'string' ? JSON.parse(r.data) : { status: 'Rejected' }),
    });
    const status = (r: any) => ({ status: r?.status ?? 'Rejected' });
    switch (action) {
      case 'RequestStartTransaction':
        this.pendingRemoteStartId = Number.isInteger(p.remoteStartId) ? p.remoteStartId : null;
        return { action: 'RemoteStartTransaction', payload: { idTag: String(p.idToken?.idToken ?? ''), ...(p.evseId ? { connectorId: Number(p.evseId) } : {}) }, map: status };
      case 'RequestStopTransaction': {
        const handle = [...this.seq].find(([, t]) => t.id === String(p.transactionId))?.[0];
        return { action: 'RemoteStopTransaction', payload: { transactionId: handle ?? -1 }, map: status };
      }
      case 'SetChargingProfile': {
        const cp = p.chargingProfile ?? {};
        const sched = Array.isArray(cp.chargingSchedule) ? cp.chargingSchedule[0] : cp.chargingSchedule;
        return {
          action: 'SetChargingProfile',
          payload: { connectorId: Number(p.evseId ?? 0), csChargingProfiles: { chargingProfileId: cp.id, stackLevel: cp.stackLevel, chargingProfilePurpose: cp.chargingProfilePurpose, chargingProfileKind: cp.chargingProfileKind, chargingSchedule: sched } },
          map: status,
        };
      }
      case 'ClearChargingProfile':
        return { action: 'ClearChargingProfile', payload: { ...(p.chargingProfileId != null ? { id: p.chargingProfileId } : {}), ...(p.chargingProfileCriteria?.evseId != null ? { connectorId: p.chargingProfileCriteria.evseId } : {}) }, map: (r) => ({ status: r?.status === 'Accepted' ? 'Accepted' : 'Unknown' }) };
      case 'GetCompositeSchedule':
        return {
          action: 'GetCompositeSchedule',
          payload: { connectorId: Number(p.evseId ?? 0), duration: Number(p.duration ?? 600), ...(p.chargingRateUnit ? { chargingRateUnit: p.chargingRateUnit } : {}) },
          map: (r) => (r?.status === 'Accepted'
            ? { status: 'Accepted', schedule: { evseId: Number(p.evseId ?? 0), duration: r.chargingSchedule?.duration ?? Number(p.duration ?? 600), scheduleStart: r.scheduleStart, chargingRateUnit: r.chargingSchedule?.chargingRateUnit ?? 'W', chargingSchedulePeriod: r.chargingSchedule?.chargingSchedulePeriod ?? [] } }
            : { status: 'Rejected' }),
        };
      case 'Reset':
        return { action: 'Reset', payload: { type: p.type === 'OnIdle' ? 'Soft' : 'Hard' }, map: status };
      case 'UnlockConnector':
        return { action: 'UnlockConnector', payload: { connectorId: Number(p.evseId ?? 1) }, map: (r) => ({ status: r?.status === 'Unlocked' ? 'Unlocked' : 'UnlockFailed' }) };
      case 'ChangeAvailability':
        return { action: 'ChangeAvailability', payload: { connectorId: Number(p.evse?.id ?? 0), type: p.operationalStatus === 'Inoperative' ? 'Inoperative' : 'Operative' }, map: status };
      case 'TriggerMessage':
        if (p.requestedMessage === 'SignV2GCertificate') return pnc('TriggerMessage', { requestedMessage: 'SignV2GCertificate' });
        return {
          action: 'TriggerMessage',
          payload: { requestedMessage: p.requestedMessage === 'LogStatusNotification' ? 'DiagnosticsStatusNotification' : p.requestedMessage, ...(p.evse?.id ? { connectorId: Number(p.evse.id) } : {}) },
          map: status,
        };
      case 'ReserveNow':
        return { action: 'ReserveNow', payload: { reservationId: p.id, expiryDate: p.expiryDateTime, idTag: String(p.idToken?.idToken ?? ''), connectorId: Number(p.evseId ?? 1) }, map: status };
      case 'CancelReservation':
        return { action: 'CancelReservation', payload: { reservationId: p.reservationId }, map: status };
      case 'GetLog':
        this.requestIds.log = Number(p.requestId) || 0;
        return { action: 'GetDiagnostics', payload: { location: String(p.log?.remoteLocation ?? '') }, map: (r) => (r?.fileName ? { status: 'Accepted', filename: r.fileName } : { status: 'Rejected' }) };
      case 'UpdateFirmware':
        this.requestIds.firmware = Number(p.requestId) || 0;
        return { action: 'UpdateFirmware', payload: { location: String(p.firmware?.location ?? ''), retrieveDate: p.firmware?.retrieveDateTime }, map: () => ({ status: 'Accepted' }) };
      case 'GetLocalListVersion':
        return { action, payload: {}, map: (r) => ({ versionNumber: r?.listVersion ?? 0 }) };
      case 'SendLocalList':
        return {
          action,
          payload: { listVersion: p.versionNumber, updateType: p.updateType, localAuthorizationList: (p.localAuthorizationList ?? []).map((e: any) => ({ idTag: e.idToken?.idToken, ...(e.idTokenInfo ? { idTagInfo: e.idTokenInfo } : {}) })) },
          map: status,
        };
      case 'CertificateSigned':
      case 'InstallCertificate':
      case 'GetInstalledCertificateIds':
      case 'DeleteCertificate':
        return pnc(action, p);
      case 'GetVariables':
        return { direct: () => ({ getVariableResult: (p.getVariableData ?? []).map((g: any) => this.getVariable(g)) }) };
      case 'SetVariables':
        return { direct: () => ({ setVariableResult: (p.setVariableData ?? []).map((s: any) => this.setVariable(s)) }) };
      case 'GetBaseReport':
        setTimeout(() => void this.m.send('NotifyReport', this.report(Number(p.requestId))).catch(() => {}), 100);
        return { direct: () => ({ status: 'Accepted' }) };
      case 'NotifyAllowedEnergyTransfer': {
        // OCPP 2.1: which transfer modes the car may use; without a *_BPT one it must not discharge.
        const modes: string[] = Array.isArray(p.allowedEnergyTransfer) ? p.allowedEnergyTransfer.map(String) : [];
        this.m.setBidirectionalAllowed(modes.some((x) => /BPT/.test(x)));
        return { direct: () => ({ status: 'Accepted' }) };
      }
      default:
        // ClearCache, DataTransfer and the rest are the same in both versions.
        return { action, payload: p, map: (r) => r };
    }
  }

  private getVariable(g: any) {
    const key = `${g.component?.name}.${g.variable?.name}`;
    const v = this.variables.get(key);
    const base = { component: { name: g.component?.name }, variable: { name: g.variable?.name } };
    if (!v) return { ...base, attributeStatus: this.componentKnown(g.component?.name) ? 'UnknownVariable' : 'UnknownComponent' };
    return { ...base, attributeStatus: 'Accepted', attributeType: g.attributeType ?? 'Actual', attributeValue: v.value };
  }

  private setVariable(s: any) {
    const key = `${s.component?.name}.${s.variable?.name}`;
    const v = this.variables.get(key);
    const base = { component: { name: s.component?.name }, variable: { name: s.variable?.name }, attributeType: s.attributeType ?? 'Actual' };
    if (!v) return { ...base, attributeStatus: this.componentKnown(s.component?.name) ? 'UnknownVariable' : 'UnknownComponent' };
    if (v.readonly) return { ...base, attributeStatus: 'Rejected', attributeStatusInfo: { reasonCode: 'ReadOnly' } };
    const value = String(s.attributeValue ?? '');
    if (v.dataType === 'boolean' && !['true', 'false'].includes(value)) return { ...base, attributeStatus: 'Rejected', attributeStatusInfo: { reasonCode: 'InvalidValue' } };
    if (v.dataType === 'integer' && !/^-?\d+$/.test(value)) return { ...base, attributeStatus: 'Rejected', attributeStatusInfo: { reasonCode: 'InvalidValue' } };
    v.value = value;
    this.m.onVariable?.(s.component?.name, s.variable?.name, value);
    return { ...base, attributeStatus: 'Accepted' };
  }

  private componentKnown(name: string) {
    return [...this.variables.keys()].some((k) => k.startsWith(`${name}.`));
  }

  private report(requestId: number) {
    return {
      requestId, generatedAt: new Date().toISOString(), seqNo: 0, tbc: false,
      reportData: [...this.variables].map(([k, v]) => {
        const [component, variable] = k.split('.') as [string, string];
        return {
          component: { name: component }, variable: { name: variable },
          variableAttribute: [{ type: 'Actual', value: v.value, mutability: v.readonly ? 'ReadOnly' : 'ReadWrite' }],
          variableCharacteristics: { dataType: v.dataType, supportsMonitoring: false },
        };
      }),
    };
  }
}
