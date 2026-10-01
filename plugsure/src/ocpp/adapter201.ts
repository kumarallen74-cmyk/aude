import { one, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { bus } from '../services/events.js';
import * as assets from '../services/assets.js';
import { handleTransactionEvent, sessionIdemKey, SessionStartRefused, sessionAwaitsToken, attachLateToken, type UnauthorisedStart } from '../services/sessions.js';
import { recordFinding } from './quirks.js';
import { OcppCallError } from './rpc.js';
import { authorizeIdTag, stationRefusal, reportedAfterTheFact, type AdapterContext, type IdTagInfo } from './adapter16.js';
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
  // Suspended: Pending, decommissioned (socket opened before it was): Rejected —
  // the reasoning is in adapter16.onBoot. In 2.0.1 Pending too lets the station
  // deliver its queued TransactionEvents, which are accepted whatever the boot
  // status; new authorisations and starts are refused (stationRefusal).
  if (cp?.status === 'suspended') {
    logger.warn({ cp: ctx.ocppIdentity }, 'BootNotification (2.0.1) from a suspended charge point — Pending');
    return { status: 'Pending', currentTime: new Date().toISOString(), interval: 300 };
  }
  if (cp?.status === 'decommissioned') {
    logger.warn({ cp: ctx.ocppIdentity }, 'BootNotification (2.0.1) from a decommissioned charge point — Rejected');
    return { status: 'Rejected', currentTime: new Date().toISOString(), interval: 300 };
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
  // A station out of service (suspended, awaiting adoption) authorises nothing,
  // Plug & Charge included. NotAtThisLocation: the token is fine, the place is not.
  const refused = await stationRefusal(ctx.chargePointId);
  if (refused) {
    logger.info({ cp: ctx.ocppIdentity, station: refused.stationStatus }, 'Authorize (2.0.1) refused: station not in service');
    return { idTokenInfo: { status: 'NotAtThisLocation' } };
  }
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

  /**
   * AUTHORISATION ON TransactionEvent.
   *
   * Started with a token: authorised BEFORE the session opens. Started carries
   * the EVSE (Authorize does not), so a prepaid claim token is checked against
   * the connector its payment is for (adapter16.authorizeIdTag). A station out
   * of service authorises nothing (NotAtThisLocation).
   *
   * A refused Started that is LIVE opens nothing, as before: the station is
   * told the status and ends the transaction. One reported AFTER THE FACT —
   * `offline: true` (the station ran it while disconnected and is uploading it
   * now) or a timestamp well in the past — happened whatever we answer now:
   * it is recorded as an unauthorised session, parked for review and never
   * billed automatically, so its Updated and Ended events land and the energy
   * is not lost (services/sessions.ts UnauthorisedStart).
   */
  const afterTheFact = p.offline === true || (eventType === 'Started' && reportedAfterTheFact(ev.timestamp));
  let authStatus: string = 'Accepted';
  let unauthorised: UnauthorisedStart | undefined;
  if (eventType === 'Started' && idTokenValue) {
    const refused = await stationRefusal(ctx.chargePointId);
    const status = refused ? 'NotAtThisLocation' : to201Status((await authorizeIdTag(ctx.chargePointId, idTokenValue, ev.evse.evseId)).status);
    authStatus = status;
    if (status !== 'Accepted') {
      if (!afterTheFact) {
        logger.info({ cp: ctx.ocppIdentity, tx: ev.transactionId, status }, 'TransactionEvent Started rejected');
        return { idTokenInfo: { status } };
      }
      unauthorised = unauthorisedStart(status, refused?.stationStatus ?? null);
    }
  } else if (eventType === 'Started') {
    // No token yet (TxStartPoint EVConnected / PowerPathClosed): the transaction
    // is recorded and authorised when its token arrives. At a station out of
    // service it is still recorded — the cable is in, the energy may follow —
    // but parked, like any start that was not authorised.
    const refused = await stationRefusal(ctx.chargePointId);
    if (refused) unauthorised = unauthorisedStart('NotAtThisLocation', refused.stationStatus);
  }

  /**
   * A TOKEN PRESENTED AFTER THE START (TxStartPoint EVConnected and similar):
   * the idToken arrives on an Updated (triggerReason Authorized) or even only
   * on the Ended event of a session that has none. It used to be ignored —
   * the session ran with no token, no payer, no prepaid allowance and no
   * roaming link, and the station was never told whether the token was valid.
   * The first one is authorised exactly as at the start and bound to the
   * session BEFORE this event's meter values are recorded (an Ended event is
   * rated as it is processed). A refused token is answered with its status
   * (the station should stop) and the session is parked for review.
   */
  let lateAuth: string | null = null;
  if (eventType !== 'Started' && idTokenValue && (await sessionAwaitsToken(ctx.chargePointId, ev.transactionId, idTokenValue))) {
    const refused = await stationRefusal(ctx.chargePointId);
    const status = refused ? 'NotAtThisLocation' : to201Status((await authorizeIdTag(ctx.chargePointId, idTokenValue, ev.evse.evseId)).status);
    const r = await attachLateToken(ev, ctx.chargePointId, refused
      ? { status, code: 'STATION_NOT_IN_SERVICE', message: `A token was presented while the station was ${refused.stationStatus}.` }
      : { status });
    if (r) {
      lateAuth = r.status;
      logger.info({ cp: ctx.ocppIdentity, tx: ev.transactionId, status: r.status }, 'token presented during the transaction');
    }
  }

  let session;
  try {
    session = await handleTransactionEvent(ev, ctx.chargePointId, unauthorised ? { unauthorised } : {});
  } catch (e) {
    // Session start's own refusal, decided under the connector's lock (a prepaid
    // token with no claimable payment here): answered like a refused token. Live,
    // no session exists for the Ended the station will send; after the fact,
    // the transaction is recorded as unauthorised.
    if (e instanceof SessionStartRefused && eventType === 'Started') {
      logger.info({ cp: ctx.ocppIdentity, tx: ev.transactionId, status: e.status }, 'TransactionEvent Started refused');
      if (!afterTheFact) return { idTokenInfo: { status: to201Status(e.status) } };
      authStatus = to201Status(e.status);
      session = await handleTransactionEvent(ev, ctx.chargePointId, { unauthorised: unauthorisedStart(authStatus, null) });
    } else {
      throw e;
    }
  }
  if (eventType === 'Started' && !session) {
    throw new OcppCallError('InternalError', 'Could not open a charging session');
  }

  // Started echoes the authorisation back (when there was a token to
  // authorise); so does the event that carried a late token. Otherwise {}.
  if (eventType === 'Started' && idTokenValue) return { idTokenInfo: { status: authStatus } };
  if (lateAuth) return { idTokenInfo: { status: lateAuth } };
  return {};
}

/** The parked-session record of a start that was not authorised (sessions.UnauthorisedStart). */
function unauthorisedStart(status: string, stationStatus: string | null): UnauthorisedStart {
  return stationStatus
    ? { code: 'STATION_NOT_IN_SERVICE', status, message: `The station is ${stationStatus}; it reported a transaction it was not allowed to start.` }
    : { code: 'UNAUTHORISED_TOKEN', status, message: `The station reported a transaction started offline with a token that is not accepted (${status}).` };
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
