import { one, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { bus } from '../services/events.js';
import * as assets from '../services/assets.js';
import { handleTransactionEvent, sessionIdemKey } from '../services/sessions.js';
import { recordFinding } from './quirks.js';
import { OcppCallError } from './rpc.js';
import { authorizeIdTag, type AdapterContext, type IdTagInfo } from './adapter16.js';
import { onFirmwareStatus, onBootFirmware, logFirmwareHookError } from '../services/firmware.js';
import { onDiagnosticsStatus } from '../services/diagnostics.js';
import { resolveAlertsFor } from '../services/alerts.js';
import { handlePncCall, contractIdTag } from '../pnc/service.js';
import { afterBoot } from '../services/charger-ca.js';
import * as deviceModel from '../services/device-model.js';
import * as v2x from '../services/v2x.js';
import { replanSoon } from '../services/sessions.js';
import type {
  CanonicalMeterValue,
  ConnectorStatus,
  SampledValue,
  TransactionEvent,
  TriggerReason,
} from '../domain/canonical.js';
import { energyWhFrom } from '../domain/canonical.js';

/**
 * OCPP 2.0.1 -> canonical adapter (CORE SESSION SUBSET).
 *
 * The canonical domain model is ALREADY 2.0.1-shaped (see domain/canonical.ts),
 * so this adapter is close to a 1:1 pass-through — the opposite of adapter16.ts,
 * which has to synthesise the 2.0.1 shape from 1.6's flatter messages. Every
 * event emitted here is the SAME canonical shape the 1.6 adapter emits, so the
 * rating engine, the live console, the webhook emitter and the DB do not gain a
 * single version branch.
 *
 *   BootNotification            -> boot bookkeeping + Accepted/Pending
 *   Heartbeat                   -> currentTime
 *   StatusNotification (2.0.1)  -> connector availability (fine state comes from
 *                                  the transaction, not from here)
 *   Authorize                   -> idTokenInfo.status
 *   TransactionEvent Started    -> TransactionEvent(Started)  [+ authorises idToken]
 *   TransactionEvent Updated    -> TransactionEvent(Updated)
 *   TransactionEvent Ended      -> TransactionEvent(Ended)
 *
 * Payloads reaching these handlers have already been schema-validated against the
 * 2.0.1 schemas in rpc.ts (version-scoped), so they are structurally sound.
 *
 * COVERAGE: this is the subset needed to boot a unit and run a billable session.
 * Device-model reports (NotifyReport, NotifyMonitoringReport) are stored for the
 * console's Device model tab (services/device-model.ts).
 */

const MAX_CONNECTOR_ID = 128;

/** 2.0.1 TriggerReason -> canonical TriggerReason. Unknown reasons degrade to 'Other'. */
export const TRIGGER_MAP_201: Record<string, TriggerReason> = {
  Authorized: 'Authorized',
  CablePluggedIn: 'CablePluggedIn',
  ChargingStateChanged: 'ChargingStateChanged',
  Deauthorized: 'Deauthorized',
  EVCommunicationLost: 'EVCommunicationLost',
  MeterValueClock: 'MeterValueClock',
  MeterValuePeriodic: 'MeterValuePeriodic',
  RemoteStart: 'RemoteStart',
  RemoteStop: 'RemoteStop',
  StopAuthorized: 'StopAuthorized',
  EVDeparted: 'EVDisconnected',
  ResetCommand: 'Reset',
};

/**
 * 2.0.1 ConnectorStatus is coarser than the 1.6 vocabulary the connector table
 * stores. Map onto the canonical set for DISPLAY only; the fine-grained charging
 * state (SuspendedEV taper etc.) is carried by TransactionEvent.chargingState and
 * is what billing and alerts key on — never this.
 */
export const STATUS_MAP_201: Record<string, ConnectorStatus> = {
  Available: 'Available',
  Occupied: 'Charging',
  Reserved: 'Reserved',
  Unavailable: 'Unavailable',
  Faulted: 'Faulted',
};

export async function handle201Call(ctx: AdapterContext, action: string, payload: any): Promise<any> {
  switch (action) {
    case 'BootNotification':
      return onBoot(ctx, payload);
    case 'Heartbeat':
      return onHeartbeat(ctx);
    case 'StatusNotification':
      return onStatusNotification(ctx, payload);
    case 'Authorize':
      return onAuthorize(ctx, payload);
    case 'TransactionEvent':
      return onTransactionEvent(ctx, payload);
    case 'DataTransfer':
      return onDataTransfer(ctx, payload);
    case 'SecurityEventNotification':
      logger.warn({ cp: ctx.ocppIdentity, type: payload?.type }, 'security event');
      return {};
    case 'FirmwareStatusNotification':
      logger.info({ cp: ctx.ocppIdentity, status: payload?.status }, 'firmware status');
      await onFirmwareStatus(ctx.chargePointId, ctx.ocppIdentity, ctx.orgId, String(payload?.status ?? '')).catch(
        logFirmwareHookError,
      );
      return {};
    case 'LogStatusNotification':
      // 2.0.1's name for DiagnosticsStatusNotification (answer to GetLog).
      logger.info({ cp: ctx.ocppIdentity, status: payload?.status }, 'log status');
      await onDiagnosticsStatus(ctx.chargePointId, ctx.ocppIdentity, ctx.orgId, String(payload?.status ?? '')).catch(
        logFirmwareHookError,
      );
      return {};
    case 'ReservationStatusUpdate':
      // The reservation lapsed or was removed on the station; it is free again
      // (its StatusNotification follows). Acknowledge so the station stops retrying.
      logger.info({ cp: ctx.ocppIdentity, reservationId: payload?.reservationId, status: payload?.reservationUpdateStatus }, 'reservation ended');
      return {};
    case 'NotifyEvent':
      await onNotifyEvent(ctx, payload);
      return {};
    case 'NotifyReport': {
      // A part of the device model (after GetBaseReport). Stored so the console can
      // show and edit it; a storage failure must not make the station resend.
      const n = await deviceModel.storeReport(ctx.chargePointId, ctx.orgId, payload).catch((e) => {
        logger.warn({ cp: ctx.ocppIdentity, err: String(e) }, 'device model report not stored');
        return 0;
      });
      logger.info({ cp: ctx.ocppIdentity, requestId: payload?.requestId, seqNo: payload?.seqNo, tbc: payload?.tbc === true, items: n }, 'device model report part');
      return {};
    }
    case 'NotifyMonitoringReport': {
      const n = await deviceModel.storeMonitoringReport(ctx.chargePointId, ctx.orgId, payload).catch((e) => {
        logger.warn({ cp: ctx.ocppIdentity, err: String(e) }, 'monitoring report not stored');
        return 0;
      });
      logger.info({ cp: ctx.ocppIdentity, requestId: payload?.requestId, seqNo: payload?.seqNo, monitors: n }, 'monitoring report part');
      return {};
    }
    case 'Get15118EVCertificate':
    case 'GetCertificateStatus':
    case 'SignCertificate':
      // ISO 15118 Plug & Charge (pnc/service.ts).
      return handlePncCall(ctx, action, payload);
    case 'NotifyEVChargingNeeds': {
      // ISO 15118: what the car can do and wants (services/v2x.ts). A storage
      // failure is answered Rejected rather than an error, so the station goes on
      // charging on its default profile.
      try {
        const r = await v2x.recordChargingNeeds(ctx, payload);
        logger.info({ cp: ctx.ocppIdentity, evseId: payload?.evseId, mode: r.needs.requestedTransfer, bidirectional: r.needs.bidirectional, session: r.sessionId }, 'EV charging needs');
        // Load management decides the profile; its next pass takes the needs into account now.
        if (r.sessionId) replanSoon(r.sessionId);
        return { status: 'Accepted' };
      } catch (e) {
        logger.warn({ cp: ctx.ocppIdentity, err: String(e) }, 'EV charging needs not stored');
        return { status: 'Rejected' };
      }
    }
    case 'NotifyEVChargingSchedule':
      await v2x.recordEvSchedule(ctx, payload).catch((e) => logger.warn({ cp: ctx.ocppIdentity, err: String(e) }, 'EV schedule not stored'));
      return { status: 'Accepted' };
    case 'NotifyChargingLimit':
      logger.info({ cp: ctx.ocppIdentity, source: payload?.chargingLimit?.chargingLimitSource, gridCritical: payload?.chargingLimit?.isGridCritical === true }, 'external charging limit');
      await v2x.recordExternalLimit(ctx.chargePointId, { evseId: payload?.evseId ?? null, ...payload.chargingLimit, chargingSchedule: payload?.chargingSchedule ?? null })
        .catch((e) => logger.warn({ cp: ctx.ocppIdentity, err: String(e) }, 'external limit not stored'));
      return {};
    case 'ClearedChargingLimit':
      await v2x.recordExternalLimit(ctx.chargePointId, null).catch(() => undefined);
      return {};
    case 'ReportChargingProfiles':
      // Answer to GetChargingProfiles; PlugSure keeps its own record of what it sent (charging_profile).
      logger.info({ cp: ctx.ocppIdentity, requestId: payload?.requestId, source: payload?.chargingLimitSource, profiles: payload?.chargingProfile?.length ?? 0 }, 'charging profiles reported');
      return {};
    case 'MeterValues':
      // Readings outside a transaction (station main meter, idle consumption). Not
      // billable; transaction energy arrives in TransactionEvent.
      logger.debug({ cp: ctx.ocppIdentity, evseId: payload?.evseId }, 'non-transaction meter values');
      return {};
    default:
      // rpc.ts screens unknown actions against the 2.0.1 schema registry before
      // we get here, so reaching this means the registry and this switch drifted.
      throw new OcppCallError('NotImplemented', `Unsupported 2.0.1 action: ${action.slice(0, 64)}`);
  }
}

// ------------------------------------------------------------------ handlers

/**
 * Device-model events. A monitor crossing its threshold ('Alerting', not
 * cleared) is a hardware problem worth an operator's attention — over-
 * temperature, RCD trip, tamper — so it becomes an alert; routine deltas and
 * periodic reports are only logged.
 */
async function onNotifyEvent(ctx: AdapterContext, p: any) {
  const events: any[] = Array.isArray(p?.eventData) ? p.eventData : [];
  const targetOf = (e: any) =>
    `${ctx.chargePointId}:${String(e.component?.name ?? '?').slice(0, 50)}${e.component?.instance ? `(${String(e.component.instance).slice(0, 50)})` : ''}.${String(e.variable?.name ?? '?').slice(0, 50)}`;
  // The monitor is back inside its limit: the alert it raised is over.
  for (const e of events.filter((x) => x?.cleared === true).slice(0, 20)) {
    await resolveAlertsFor(ctx.orgId, 'charge_point.device_event', 'device_component', targetOf(e)).catch((err) =>
      logger.warn({ cp: ctx.ocppIdentity, err: String(err) }, 'device alert not resolved'));
  }
  const alerting = events.filter((e) => e?.trigger === 'Alerting' && !e?.cleared).slice(0, 5);
  for (const e of alerting) {
    const what = `${e.component?.name ?? '?'}${e.component?.instance ? `(${e.component.instance})` : ''}.${e.variable?.name ?? '?'}`;
    bus.emit('alert.raised', {
      orgId: ctx.orgId,
      kind: 'charge_point.device_event',
      severity: 'warning',
      message: `${ctx.ocppIdentity}: ${what} = ${String(e.actualValue ?? '').slice(0, 80)}${e.techCode ? ` [${String(e.techCode).slice(0, 50)}]` : ''}${e.techInfo ? ` — ${String(e.techInfo).slice(0, 200)}` : ''}`,
      // One open alert per component/variable: a second, different problem on the
      // same station is its own alert (and its own notification).
      targetType: 'device_component',
      targetId: targetOf(e),
    });
  }
  logger.info({ cp: ctx.ocppIdentity, events: events.length, alerting: alerting.length }, 'device events');
}

async function onBoot(ctx: AdapterContext, p: any) {
  const cs = p.chargingStation ?? {};
  await assets.recordBoot(ctx.chargePointId, {
    vendor: cs.vendorName,
    model: cs.model,
    serial: cs.serialNumber,
    firmware: cs.firmwareVersion,
    // The protocol actually negotiated: a 2.1 station is recorded as 2.1 (bidirectional charging needs it).
    ocppVersion: ctx.version === 'ocpp2.1' ? 'ocpp2.1' : 'ocpp2.0.1',
  });
  await onBootFirmware(ctx.chargePointId, cs.firmwareVersion).catch(logFirmwareHookError);
  bus.emit('charge_point.booted', {
    orgId: ctx.orgId,
    ocppIdentity: ctx.ocppIdentity,
    vendor: cs.vendorName,
    model: cs.model,
    firmware: cs.firmwareVersion,
  });

  const cp = await one<{ status: string }>(`SELECT status FROM charge_point WHERE id = $1`, [ctx.chargePointId]);

  // Same adoption gate as 1.6: a unit no operator has accepted answers Pending,
  // and `interval` is then a retry-after rather than a heartbeat period.
  if (cp?.status === 'pending_adoption') {
    logger.info({ cp: ctx.ocppIdentity }, 'BootNotification (2.0.1) from a charge point awaiting adoption');
    return { status: 'Pending', currentTime: new Date().toISOString(), interval: 60 };
  }

  logger.info(
    { cp: ctx.ocppIdentity, vendor: cs.vendorName, model: cs.model, fw: cs.firmwareVersion, reason: p.reason },
    'BootNotification (2.0.1)',
  );
  // Zero-touch certificates: a station commissioned for them is asked for its CSR.
  void afterBoot(ctx).catch(() => {});
  return {
    status: 'Accepted',
    currentTime: new Date().toISOString(),
    interval: config.gateway.heartbeatIntervalS,
  };
}

async function onHeartbeat(ctx: AdapterContext) {
  await assets.touchSeen(ctx.chargePointId, true);
  return { currentTime: new Date().toISOString() };
}

async function onStatusNotification(ctx: AdapterContext, p: any) {
  // In 2.0.1 the connector is addressed by (evseId, connectorId). We key the
  // connector table on the connector number as the 1.6 path does; evseId 0 still
  // addresses the station itself.
  const evseId: number = p.evseId ?? 0;
  const connectorNo: number = p.connectorId ?? 0;
  const raw = String(p.connectorStatus ?? '');
  const status: ConnectorStatus = STATUS_MAP_201[raw] ?? 'Unavailable';
  const observedAt: string = typeof p.timestamp === 'string' ? p.timestamp : new Date().toISOString();

  if (evseId === 0 || connectorNo === 0) {
    logger.info({ cp: ctx.ocppIdentity, status: raw }, 'station-level status (2.0.1)');
    if (status === 'Faulted') {
      await query(
        `UPDATE charge_point SET status = 'faulted'
          WHERE id = $1 AND status <> ALL($2::text[])`,
        [ctx.chargePointId, assets.ADMINISTRATIVE_STATES],
      );
    } else if (status === 'Available' || status === 'Charging') {
      await query(
        `UPDATE charge_point SET status = 'online'
          WHERE id = $1 AND status = 'faulted' AND status <> ALL($2::text[])`,
        [ctx.chargePointId, assets.ADMINISTRATIVE_STATES],
      );
    }
    return {};
  }

  if (evseId > MAX_CONNECTOR_ID) {
    throw new OcppCallError('PropertyConstraintViolation', `evseId must be <= ${MAX_CONNECTOR_ID}`, {
      evseId,
    });
  }

  // The connector table's evse_id is the 1.6 connectorId, i.e. the 2.0.1 EVSE —
  // the same key TransactionEvent uses (evse.id). Keying on the 2.0.1 connectorId
  // (almost always 1) wrote every EVSE's status onto EVSE 1.
  const c = await assets.ensureConnector(ctx.chargePointId, evseId);
  if (c) {
    await query(
      `UPDATE connector
          SET status = $2, error_code = $3, status_updated_at = $4, vendor_error_code = $5, status_info = $6
        WHERE id = $1`,
      [c.id, status, null, observedAt, null, null],
    );
  }

  bus.emit('connector.status_changed', {
    orgId: ctx.orgId,
    ocppIdentity: ctx.ocppIdentity,
    evseId,
    connectorId: connectorNo,
    status,
  });

  if (status === 'Faulted' && c) {
    bus.emit('alert.raised', {
      orgId: c.org_id,
      kind: 'connector.faulted',
      severity: 'critical',
      message: `${ctx.ocppIdentity} evse ${evseId} connector ${connectorNo} reported Faulted.`,
      targetType: 'connector',
      targetId: `${ctx.chargePointId}:${evseId}`,
    });
  } else if (c) {
    await resolveAlertsFor(c.org_id, 'connector.faulted', 'connector', `${ctx.chargePointId}:${evseId}`).catch(() => 0);
  }
  return {};
}

async function onAuthorize(ctx: AdapterContext, p: any) {
  // Plug & Charge: an eMAID, or a contract certificate / its hash data, is checked as a contract.
  if (p.idToken?.type === 'eMAID' || p.certificate || Array.isArray(p.iso15118CertificateHashData)) return handlePncCall(ctx, 'Authorize', p);
  const idToken: string = p.idToken?.idToken ?? '';
  const info = await authorizeIdTag(ctx.chargePointId, idToken);
  logger.info({ cp: ctx.ocppIdentity, idToken, status: info.status }, 'Authorize (2.0.1)');
  return { idTokenInfo: { status: to201Status(info.status) } };
}

/**
 * TransactionEvent — the heart of 2.0.1 billing.
 *
 * One message type carries Started / Updated / Ended, each with its own
 * meterValue batch and trigger reason. Because canonical is 2.0.1-shaped, the
 * mapping is direct: eventType and chargingState pass straight through, and the
 * meter values map field-for-field (the only reshaping is unitOfMeasure.unit ->
 * flat unit, done in toCanonicalMeterValues201).
 */
/**
 * Pure mapping: a 2.0.1 TransactionEventRequest -> the canonical TransactionEvent.
 *
 * No I/O — no DB, no authorisation, no side effects — so it is unit-testable in
 * isolation (see adapter201.test.ts). Everything the mapping needs comes from the
 * payload plus the connection context. `idemKey` is a pure hash of charger-supplied
 * facts (Started only), so a retried Started produces the SAME key and cannot
 * double-bill; Updated/Ended carry no key, matching the 1.6 adapter.
 */
export function toCanonicalTransactionEvent201(ctx: AdapterContext, p: any): TransactionEvent {
  const eventType: 'Started' | 'Updated' | 'Ended' = p.eventType;
  const txInfo = p.transactionInfo ?? {};
  const transactionId: string = String(txInfo.transactionId);
  const timestamp: string = p.timestamp ?? new Date().toISOString();
  const evseId: number = p.evse?.id ?? 1;
  const idTokenValue: string | undefined = p.idToken?.idToken;
  const idTokenType: string | undefined = p.idToken?.type;
  const mv = toCanonicalMeterValues201(p.meterValue ?? []);
  // For the idempotency key ONLY. meterValue on Started is optional in 2.0.1; an
  // absent register keys as 0 (the same on every retry), but is never billed as a
  // start of 0 — startSession records it as unknown and takes the first register
  // the session observes, or the lifetime total would become session energy.
  const meterStartWh = energyWhFrom(mv) ?? 0;

  return {
    eventType,
    triggerReason: TRIGGER_MAP_201[String(p.triggerReason)] ?? 'Other',
    timestamp,
    seqNo: typeof p.seqNo === 'number' ? p.seqNo : 0,
    transactionId,
    evse: {
      chargePointId: ctx.chargePointId,
      ocppIdentity: ctx.ocppIdentity,
      evseId,
      connectorId: p.evse?.connectorId ?? 1,
    },
    ...(idTokenValue ? { idToken: { type: idTokenType ?? 'ISO14443', idToken: idTokenValue } } : {}),
    meterValue: mv,
    ...(txInfo.chargingState ? { chargingState: txInfo.chargingState } : {}),
    ...(txInfo.stoppedReason ? { stoppedReason: String(txInfo.stoppedReason) } : {}),
    ...(txInfo.operationMode ? { operationMode: String(txInfo.operationMode) } : {}),
    idemKey:
      eventType === 'Started'
        ? sessionIdemKey(ctx.ocppIdentity, evseId, idTokenValue ?? transactionId, meterStartWh, timestamp)
        : '',
    ...(eventType === 'Ended' ? { meterStopAbsent: energyWhFrom(mv) === null } : {}),
  };
}

async function onTransactionEvent(ctx: AdapterContext, p: any) {
  // Plug & Charge: bill the eMAID to its contract (own token, or a roaming partner's), whatever separators it came with.
  if (p.idToken?.type === 'eMAID' && p.idToken.idToken) {
    const tag = await contractIdTag(ctx.chargePointId, String(p.idToken.idToken));
    if (tag) p = { ...p, idToken: { ...p.idToken, idToken: tag } };
  }
  const eventType: 'Started' | 'Updated' | 'Ended' = p.eventType;
  const idTokenValue: string | undefined = p.idToken?.idToken;
  const ev = toCanonicalTransactionEvent201(ctx, p);

  // Record the emitted measurand set once per connection (fleet-safe), exactly as
  // the 1.6 adapter does — the metering hot path must not lock the quirk row.
  if (ctx.quirkProfileId && ctx.vendor && ctx.model) {
    const measurands = Array.from(new Set(ev.meterValue.flatMap((m) => m.sampledValue.map((s) => s.measurand)))).sort();
    const fingerprint = measurands.join(',');
    if (measurands.length && ctx.seenMeasurands !== fingerprint) {
      ctx.seenMeasurands = fingerprint;
      await recordFinding(
        ctx.quirkProfileId,
        { emittedMeasurands: measurands },
        { vendor: ctx.vendor, model: ctx.model, firmware: ctx.firmware },
      );
    }
  }

  // On Started, authorise the token BEFORE opening the session. If it is not
  // accepted, tell the charger via idTokenInfo and do not start.
  let authStatus: IdTagInfo['status'] = 'Accepted';
  if (eventType === 'Started' && idTokenValue) {
    const info = await authorizeIdTag(ctx.chargePointId, idTokenValue);
    authStatus = info.status;
    if (info.status !== 'Accepted') {
      logger.info({ cp: ctx.ocppIdentity, tx: ev.transactionId, status: info.status }, 'TransactionEvent Started rejected');
      return { idTokenInfo: { status: to201Status(info.status) } };
    }
  }

  const session = await handleTransactionEvent(ev, ctx.chargePointId);
  if (eventType === 'Started' && !session) {
    throw new OcppCallError('InternalError', 'Could not open a charging session');
  }

  // Started echoes the authorisation back; Updated/Ended acknowledge with {}.
  return eventType === 'Started' ? { idTokenInfo: { status: to201Status(authStatus) } } : {};
}

/**
 * NEVER reject an unknown DataTransfer — respond UnknownVendorId/UnknownMessageId,
 * log it, and mine the logs. Erroring the connection instead loses the charger.
 * (ISO 15118 Plug & Charge has its own messages in 2.0.1; this vendorId is the 1.6 wrapping.)
 */
async function onDataTransfer(ctx: AdapterContext, p: any) {
  const vendorId: string = p.vendorId ?? '';
  logger.info({ cp: ctx.ocppIdentity, vendorId, messageId: p.messageId }, 'DataTransfer (2.0.1)');
  if (ctx.quirkProfileId && ctx.vendor && ctx.model) {
    await recordFinding(
      ctx.quirkProfileId,
      { observedDataTransferVendorIds: [vendorId] },
      { vendor: ctx.vendor, model: ctx.model, firmware: ctx.firmware },
    );
  }
  if (vendorId === 'org.openchargealliance.iso15118pnc') {
    return { status: 'UnknownMessageId' };
  }
  return { status: 'UnknownVendorId' };
}

// ------------------------------------------------------------------ helpers

/**
 * Map the 1.6 authoriser's status onto the 2.0.1 AuthorizationStatus enum. The
 * five values the 1.6 path returns (Accepted/Blocked/Expired/Invalid/ConcurrentTx)
 * are all valid 2.0.1 values, so this is an identity today — it exists so a future
 * change to the authoriser cannot silently emit a status 2.0.1 does not define.
 */
function to201Status(status: IdTagInfo['status']): string {
  return status;
}

/** 2.0.1 MeterValue -> canonical. The only reshaping is unitOfMeasure.unit -> unit. */
export function toCanonicalMeterValues201(raw: any[]): CanonicalMeterValue[] {
  return (Array.isArray(raw) ? raw : []).map((m) => ({
    timestamp: m?.timestamp ?? new Date().toISOString(),
    sampledValue: (Array.isArray(m?.sampledValue) ? m.sampledValue : []).map(
      (s: any): SampledValue => ({
        measurand: s?.measurand ?? 'Energy.Active.Import.Register',
        // 2.0.1 UnitOfMeasure carries a power-of-ten multiplier (default 0).
        value: Number(s?.value) * 10 ** (Number.isInteger(s?.unitOfMeasure?.multiplier) ? s.unitOfMeasure.multiplier : 0),
        unit: s?.unitOfMeasure?.unit,
        phase: s?.phase,
        context: s?.context,
        location: s?.location,
        // Signed meter data (OCMF, base64) travels beside the reading it signs.
        ...(s?.signedMeterValue?.signedMeterData
          ? { signed: {
              data: String(s.signedMeterValue.signedMeterData),
              encoding: s.signedMeterValue.encodingMethod ? String(s.signedMeterValue.encodingMethod) : undefined,
              method: s.signedMeterValue.signingMethod ? String(s.signedMeterValue.signingMethod) : undefined,
              publicKey: s.signedMeterValue.publicKey ? String(s.signedMeterValue.publicKey) : undefined,
            } }
          : {}),
      }),
    ),
  }));
}
