import { one, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { bus } from '../services/events.js';
import * as assets from '../services/assets.js';
import { handleTransactionEvent, sessionIdemKey, closeOrphanedSession, PREPAID_CLAIM_WINDOW_MIN } from '../services/sessions.js';
import { recordFinding } from './quirks.js';
import { OcppCallError } from './rpc.js';
import { onFirmwareStatus, onBootFirmware, logFirmwareHookError } from '../services/firmware.js';
import { onDiagnosticsStatus } from '../services/diagnostics.js';
import { resolveAlertsFor } from '../services/alerts.js';
import { authorizeRoaming } from '../ocpi/authorize.js';
import { overLimit } from '../ocpi/emsp.js';
import { normaliseEmaid } from '../pnc/emaid.js';
import { handlePncCall, PNC_INBOUND } from '../pnc/service.js';
import { PNC_VENDOR_ID } from './commands.js';
import { validateCallDetailed } from './validate.js';
import { afterBoot, onStationCsr } from '../services/charger-ca.js';
import type {
  CanonicalMeterValue,
  ConnectorStatus,
  SampledValue,
  TransactionEvent,
  TriggerReason,
} from '../domain/canonical.js';
import { energyWhFrom } from '../domain/canonical.js';

/**
 * OCPP 1.6J -> canonical adapter.
 *
 * Synthesises the 2.0.1 TransactionEvent shape so the rating engine, the live
 * console, the webhook emitter and any future OCPI adapter see exactly one shape
 * and contain no version branches.
 *
 *   StartTransaction                    -> TransactionEvent(Started)
 *   MeterValues (with transactionId)    -> TransactionEvent(Updated)
 *   StatusNotification during a tx      -> TransactionEvent(Updated)
 *   StopTransaction                     -> TransactionEvent(Ended)
 *
 * Payloads reaching these handlers have already been schema-validated in rpc.ts,
 * so they are structurally sound. Semantic checks still belong here.
 */

export interface AdapterContext {
  ocppIdentity: string;
  chargePointId: string;
  /**
   * Owning tenant. Required, not optional: every event this adapter emits is
   * fanned out to the operator console's SSE stream, and an event without an
   * orgId used to be delivered to every logged-in tenant on the platform.
   */
  orgId: string;
  /** The protocol negotiated on this connection. */
  version?: import('../domain/canonical.js').OcppVersion;
  quirkProfileId?: string | null;
  /**
   * Measurand fingerprint already written for this connection, so the quirk
   * registry is not locked on every metering frame.
   */
  seenMeasurands?: string;
  vendor?: string | null;
  model?: string | null;
  firmware?: string | null;
}

const MAX_CONNECTOR_ID = 128;

const STOP_REASON_TO_TRIGGER: Record<string, TriggerReason> = {
  EmergencyStop: 'Other',
  EVDisconnected: 'EVDisconnected',
  HardReset: 'Reset',
  Local: 'StopAuthorized',
  Other: 'Other',
  PowerLoss: 'PowerLoss',
  Reboot: 'Reset',
  Remote: 'RemoteStop',
  SoftReset: 'Reset',
  UnlockCommand: 'StopAuthorized',
  DeAuthorized: 'Deauthorized',
};

export async function handle16Call(ctx: AdapterContext, action: string, payload: any): Promise<any> {
  switch (action) {
    case 'BootNotification':
      return onBoot(ctx, payload);
    case 'Heartbeat':
      return onHeartbeat(ctx);
    case 'StatusNotification':
      return onStatusNotification(ctx, payload);
    case 'Authorize':
      return onAuthorize(ctx, payload);
    case 'StartTransaction':
      return onStartTransaction(ctx, payload);
    case 'MeterValues':
      return onMeterValues(ctx, payload);
    case 'StopTransaction':
      return onStopTransaction(ctx, payload);
    case 'DataTransfer':
      return onDataTransfer(ctx, payload);
    case 'FirmwareStatusNotification':
      logger.info({ cp: ctx.ocppIdentity, action, status: payload?.status }, 'status notification');
      // Drives the FOTA campaign state machine. Bookkeeping must never fail the reply.
      await onFirmwareStatus(ctx.chargePointId, ctx.ocppIdentity, ctx.orgId, String(payload?.status ?? '')).catch(
        logFirmwareHookError,
      );
      return {};
    case 'DiagnosticsStatusNotification':
      logger.info({ cp: ctx.ocppIdentity, action, status: payload?.status }, 'status notification');
      await onDiagnosticsStatus(ctx.chargePointId, ctx.ocppIdentity, ctx.orgId, String(payload?.status ?? '')).catch(
        logFirmwareHookError,
      );
      return {};
    case 'SecurityEventNotification':
      logger.warn({ cp: ctx.ocppIdentity, type: payload?.type }, 'security event');
      return {};
    case 'SignCertificate': {
      // 1.6 Security Whitepaper: the charge point's own client certificate (services/charger-ca.ts).
      const r = await onStationCsr(ctx, String(payload?.csr ?? ''));
      return { status: r.status };
    }
    default:
      // rpc.ts screens unknown actions before we get here, so reaching this means
      // the schema registry and this switch have drifted apart.
      throw new OcppCallError('NotImplemented', `Unsupported action: ${action.slice(0, 64)}`);
  }
}

// ------------------------------------------------------------------ handlers

async function onBoot(ctx: AdapterContext, p: any) {
  await assets.recordBoot(ctx.chargePointId, {
    vendor: p.chargePointVendor,
    model: p.chargePointModel,
    serial: p.chargePointSerialNumber ?? p.chargeBoxSerialNumber,
    firmware: p.firmwareVersion,
    ocppVersion: 'ocpp1.6',
  });
  // A post-install reboot reports the new version here; that is what verifies a FOTA job.
  await onBootFirmware(ctx.chargePointId, p.firmwareVersion).catch(logFirmwareHookError);
  bus.emit('charge_point.booted', {
    orgId: ctx.orgId,
    ocppIdentity: ctx.ocppIdentity,
    vendor: p.chargePointVendor,
    model: p.chargePointModel,
    firmware: p.firmwareVersion,
  });

  const cp = await one<{ status: string }>(`SELECT status FROM charge_point WHERE id = $1`, [ctx.chargePointId]);

  // Pending means an operator has not yet accepted this unit into a site. The
  // spec's answer for "known but not yet permitted" is Pending, and `interval`
  // then means retry-after rather than heartbeat period.
  if (cp?.status === 'pending_adoption') {
    logger.info({ cp: ctx.ocppIdentity }, 'BootNotification from a charge point awaiting adoption');
    return { status: 'Pending', currentTime: new Date().toISOString(), interval: 60 };
  }

  logger.info(
    { cp: ctx.ocppIdentity, vendor: p.chargePointVendor, model: p.chargePointModel, fw: p.firmwareVersion },
    'BootNotification',
  );
  // Zero-touch certificates: a charger commissioned for them is asked for its CSR.
  void afterBoot(ctx).catch(() => {});
  return {
    status: 'Accepted',
    currentTime: new Date().toISOString(),
    interval: config.gateway.heartbeatIntervalS,
  };
}

/**
 * Heartbeat.conf MUST return currentTime. Chargers set their clock from it, and
 * skipping it silently corrupts every billing timestamp downstream.
 */
async function onHeartbeat(ctx: AdapterContext) {
  await assets.touchSeen(ctx.chargePointId, true);
  return { currentTime: new Date().toISOString() };
}

async function onStatusNotification(ctx: AdapterContext, p: any) {
  const connectorNo: number = p.connectorId ?? 0;
  const status = p.status as ConnectorStatus;
  const errorCode: string | undefined = p.errorCode && p.errorCode !== 'NoError' ? p.errorCode : undefined;
  // Bill and record on the charger's clock, not on receipt time.
  const observedAt: string = typeof p.timestamp === 'string' ? p.timestamp : new Date().toISOString();

  if (connectorNo === 0) {
    /**
     * connectorId 0 addresses the charge point itself, not a connector.
     *
     * These two writes were the last unguarded path to `charge_point.status`,
     * and a charger could walk itself out of `pending_adoption` through them: a
     * station-level Faulted set the status to 'faulted', and the recovery to
     * 'online' then completed the escape. The next BootNotification answered
     * Accepted and the unit — which no operator had ever approved — started
     * producing billable sessions. Same route out of 'suspended' and
     * 'decommissioned'.
     *
     * Administrative state is the operator's; a fault is recorded against the
     * unit's connectors and as an alert, never by overwriting it.
     */
    logger.info({ cp: ctx.ocppIdentity, status, err: p.errorCode }, 'station-level status');
    if (status === 'Faulted') {
      await query(
        `UPDATE charge_point SET status = 'faulted'
          WHERE id = $1 AND status <> ALL($2::text[])`,
        [ctx.chargePointId, assets.ADMINISTRATIVE_STATES],
      );
    } else if (status === 'Available' || status === 'Charging' || status === 'Preparing') {
      // Recover. Previously a station-level fault marked the unit offline forever
      // while its socket stayed open, leaving two sources of truth disagreeing.
      await query(
        `UPDATE charge_point SET status = 'online'
          WHERE id = $1 AND status = 'faulted' AND status <> ALL($2::text[])`,
        [ctx.chargePointId, assets.ADMINISTRATIVE_STATES],
      );
    }
    return {};
  }

  if (connectorNo > MAX_CONNECTOR_ID) {
    throw new OcppCallError('PropertyConstraintViolation', `connectorId must be <= ${MAX_CONNECTOR_ID}`, {
      connectorId: connectorNo,
    });
  }

  const c = await assets.ensureConnector(ctx.chargePointId, connectorNo);
  if (c) {
    await query(
      `UPDATE connector
          SET status = $2, error_code = $3, status_updated_at = $4,
              vendor_error_code = $5, status_info = $6
        WHERE id = $1`,
      [c.id, status, errorCode ?? null, observedAt, p.vendorErrorCode ?? null, p.info ?? null],
    );
  }

  bus.emit('connector.status_changed', {
    orgId: ctx.orgId,
    ocppIdentity: ctx.ocppIdentity,
    evseId: connectorNo,
    connectorId: 1,
    status,
    errorCode,
  });

  // NOTE: SuspendedEV is a normal end-of-charge taper on 1.6 hardware. Not a fault.
  if (status === 'Faulted' && c) {
    bus.emit('alert.raised', {
      orgId: c.org_id,
      kind: 'connector.faulted',
      severity: 'critical',
      message:
        `${ctx.ocppIdentity} connector ${connectorNo} reported Faulted ` +
        `(${p.errorCode ?? 'no code'}${p.vendorErrorCode ? `/${p.vendorErrorCode}` : ''}${p.info ? `: ${p.info}` : ''}).`,
      targetType: 'connector',
      targetId: `${ctx.chargePointId}:${connectorNo}`,
    });
  } else if (c) {
    // The fault cleared: close its alert (and let routing send "resolved").
    await resolveAlertsFor(c.org_id, 'connector.faulted', 'connector', `${ctx.chargePointId}:${connectorNo}`).catch(() => 0);
  }
  return {};
}

async function onAuthorize(ctx: AdapterContext, p: any) {
  const info = await authorizeIdTag(ctx.chargePointId, p.idTag);
  logger.info({ cp: ctx.ocppIdentity, idTag: p.idTag, status: info.status }, 'Authorize');
  return { idTagInfo: info };
}

async function onStartTransaction(ctx: AdapterContext, p: any) {
  const connectorNo: number = p.connectorId;
  const idTag: string = p.idTag;
  const meterStart: number = p.meterStart ?? 0;
  const timestamp: string = p.timestamp ?? new Date().toISOString();

  if (connectorNo < 1 || connectorNo > MAX_CONNECTOR_ID) {
    // Arbitrary values previously created phantom EVSE rows, including -1 and 99.
    throw new OcppCallError('PropertyConstraintViolation', `connectorId must be 1..${MAX_CONNECTOR_ID}`, {
      connectorId: connectorNo,
    });
  }

  const info = await authorizeIdTag(ctx.chargePointId, idTag);
  if (info.status !== 'Accepted') {
    return { transactionId: 0, idTagInfo: info };
  }

  await assets.ensureConnector(ctx.chargePointId, connectorNo);

  /**
   * IDEMPOTENCY — the fix for the duplicate-billing defect.
   *
   * A charger that never receives StartTransaction.conf retries the IDENTICAL
   * request; it has no transaction id yet. The key must therefore be built only
   * from facts the CHARGER supplies and repeats. It previously included a
   * CSMS-minted id from a sequence, which was fresh on every call, so the
   * ON CONFLICT guard could never fire and one plug-in produced two invoices.
   */
  const idemKey = sessionIdemKey(ctx.ocppIdentity, connectorNo, idTag, meterStart, timestamp);

  const existing = await one<{ ocpp_transaction_id: string | null; state: string }>(
    `SELECT ocpp_transaction_id, state FROM charging_session WHERE idem_key = $1`,
    [idemKey],
  );
  if (existing?.ocpp_transaction_id) {
    logger.info(
      { cp: ctx.ocppIdentity, tx: existing.ocpp_transaction_id },
      'duplicate StartTransaction — returning the original transactionId',
    );
    return { transactionId: Number(existing.ocpp_transaction_id), idTagInfo: info };
  }

  // A new transaction on a connector we still believe is busy means we missed a
  // stop. Close the stale one for review rather than losing either session.
  await closeOrphanedSession(ctx.chargePointId, connectorNo, 'superseded by a new transaction');

  const seq = await one<{ id: number }>(`SELECT nextval('ocpp_tx_seq')::int AS id`);
  const transactionId = seq?.id ?? Math.floor(Date.now() / 1000);

  const ev: TransactionEvent = {
    eventType: 'Started',
    triggerReason: 'Authorized',
    timestamp,
    seqNo: 0,
    transactionId: String(transactionId),
    evse: {
      chargePointId: ctx.chargePointId,
      ocppIdentity: ctx.ocppIdentity,
      evseId: connectorNo,
      connectorId: 1,
    },
    idToken: { type: 'ISO14443', idToken: idTag },
    meterValue: [
      {
        timestamp,
        sampledValue: [
          { measurand: 'Energy.Active.Import.Register', value: meterStart, unit: 'Wh', context: 'Transaction.Begin' },
        ],
      },
    ],
    chargingState: 'Charging',
    idemKey,
  };

  const session = await handleTransactionEvent(ev, ctx.chargePointId);
  if (!session) {
    throw new OcppCallError('InternalError', 'Could not open a charging session');
  }
  return { transactionId: Number(session.ocpp_transaction_id ?? transactionId), idTagInfo: info };
}

async function onMeterValues(ctx: AdapterContext, p: any) {
  const connectorNo: number = p.connectorId;
  const txId = p.transactionId != null ? String(p.transactionId) : null;
  const mv = toCanonicalMeterValues(p.meterValue ?? []);

  /**
   * Record the measurand set — ONCE per connection, not per frame.
   *
   * `recordFinding` opens a transaction and takes `SELECT ... FOR UPDATE` on the
   * quirk profile row. Every unit of a model shares one row, so running it on
   * every MeterValues serialised the whole fleet's metering hot path on a single
   * lock while holding one of twenty pool connections. The measurand set is a
   * property of the firmware and does not change mid-session, so a per-connection
   * memo removes the write entirely for all but the first frame.
   */
  if (ctx.quirkProfileId && ctx.vendor && ctx.model) {
    const measurands = Array.from(new Set(mv.flatMap((m) => m.sampledValue.map((s) => s.measurand)))).sort();
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

  if (!txId) {
    logger.debug({ cp: ctx.ocppIdentity, connectorNo }, 'non-transactional MeterValues');
    return {};
  }

  const ev: TransactionEvent = {
    eventType: 'Updated',
    triggerReason: 'MeterValuePeriodic',
    timestamp: mv.at(-1)?.timestamp ?? new Date().toISOString(),
    seqNo: 0,
    transactionId: txId,
    evse: {
      chargePointId: ctx.chargePointId,
      ocppIdentity: ctx.ocppIdentity,
      evseId: connectorNo,
      connectorId: 1,
    },
    meterValue: mv,
    chargingState: 'Charging',
    idemKey: '',
  };
  await handleTransactionEvent(ev, ctx.chargePointId);
  return {};
}

async function onStopTransaction(ctx: AdapterContext, p: any) {
  const txId = String(p.transactionId);
  const timestamp: string = p.timestamp ?? new Date().toISOString();
  const reason: string = p.reason ?? 'Local';

  /**
   * METER AUTHORITY.
   *
   * transactionData carries the sampled register series and, on Eichrecht-class
   * hardware, the signed values. It is preferred over the scalar meterStop, which
   * is what the code always used despite a comment claiming the opposite —
   * 50 kWh went unbilled in the audit's reproduction.
   *
   * meterStop is distinguished from ABSENT rather than coerced to 0. A `?? 0`
   * made the running-total fallback unreachable and billed a fully metered
   * session at zero.
   */
  const txData = toCanonicalMeterValues(p.transactionData ?? []);
  const txDataWh = energyWhFrom(txData);
  const meterStopWh = typeof p.meterStop === 'number' ? Math.round(p.meterStop) : null;

  const mv = [...txData];
  const authoritative = txDataWh ?? meterStopWh;
  if (authoritative !== null) {
    mv.push({
      timestamp,
      sampledValue: [
        {
          measurand: 'Energy.Active.Import.Register',
          value: authoritative,
          unit: 'Wh',
          context: 'Transaction.End',
        },
      ],
    });
  }

  const divergenceWh =
    txDataWh !== null && meterStopWh !== null ? Math.abs(txDataWh - meterStopWh) : 0;
  if (divergenceWh > 1) {
    logger.warn(
      { cp: ctx.ocppIdentity, tx: txId, txDataWh, meterStopWh, divergenceWh },
      'transactionData and meterStop disagree — billing transactionData and flagging for review',
    );
  }

  const session = await one<{ connector_no: number }>(
    `SELECT e.evse_id AS connector_no
       FROM charging_session cs
       JOIN connector c ON c.id = cs.connector_uuid
       JOIN evse e ON e.id = c.evse_uuid
      WHERE cs.charge_point_id = $1 AND cs.ocpp_transaction_id = $2
      ORDER BY cs.started_at DESC LIMIT 1`,
    [ctx.chargePointId, txId],
  );

  const ev: TransactionEvent = {
    eventType: 'Ended',
    triggerReason: STOP_REASON_TO_TRIGGER[reason] ?? 'Other',
    timestamp,
    seqNo: 0,
    transactionId: txId,
    evse: {
      chargePointId: ctx.chargePointId,
      ocppIdentity: ctx.ocppIdentity,
      evseId: session?.connector_no ?? 1,
      connectorId: 1,
    },
    meterValue: mv,
    stoppedReason: reason,
    chargingState: 'Idle',
    idemKey: '',
    meterStopAbsent: meterStopWh === null && txDataWh === null,
    divergenceWh,
  };

  await handleTransactionEvent(ev, ctx.chargePointId);
  return { idTagInfo: { status: 'Accepted' } };
}

/**
 * NEVER reject an unknown DataTransfer. Respond UnknownVendorId / UnknownMessageId,
 * log the frame, and mine the logs — that is how undocumented vendor extensions
 * get discovered. Erroring the connection instead loses the charger.
 */
async function onDataTransfer(ctx: AdapterContext, p: any) {
  const vendorId: string = p.vendorId ?? '';
  logger.info({ cp: ctx.ocppIdentity, vendorId, messageId: p.messageId }, 'DataTransfer');

  if (ctx.quirkProfileId && ctx.vendor && ctx.model) {
    await recordFinding(
      ctx.quirkProfileId,
      { observedDataTransferVendorIds: [vendorId] },
      { vendor: ctx.vendor, model: ctx.model, firmware: ctx.firmware },
    );
  }

  // ISO 15118 Plug & Charge over 1.6 (OCA application note): the 2.0.1 message
  // name in messageId, its JSON payload as a string in data, the 2.0.1 answer
  // returned the same way.
  if (vendorId === PNC_VENDOR_ID) {
    const messageId = String(p.messageId ?? '');
    if (!PNC_INBOUND.has(messageId)) return { status: 'UnknownMessageId' };
    let inner: any;
    try { inner = typeof p.data === 'string' ? JSON.parse(p.data) : p.data; } catch { return { status: 'Rejected', data: JSON.stringify({ error: 'data is not JSON' }) }; }
    const { failure } = validateCallDetailed(messageId, inner, 'ocpp2.0.1');
    if (failure) return { status: 'Rejected', data: JSON.stringify({ error: failure.message }) };
    const result = await handlePncCall(ctx, messageId, inner);
    return { status: 'Accepted', data: JSON.stringify(result) };
  }
  return { status: 'UnknownVendorId' };
}

// ------------------------------------------------------------------ helpers

export interface IdTagInfo {
  status: 'Accepted' | 'Blocked' | 'Expired' | 'Invalid' | 'ConcurrentTx';
  expiryDate?: string;
  parentIdTag?: string;
}

/**
 * Authorisation, scoped to the charge point's own organisation.
 *
 * `expiryDate` is returned when the token has one, so the charger's local cache
 * can expire the entry by itself while offline — without it, an offline charger
 * honours a revoked token indefinitely.
 */
export async function authorizeIdTag(chargePointId: string, idTag: string): Promise<IdTagInfo> {
  const row = await one<{
    id: string;
    kind: string;
    status: string;
    valid_to: Date | null;
    energy_limit_wh: number | null;
    spend_limit_idr: number | null;
    pnc_on: boolean;
  }>(
    // A Plug & Charge contract (kind 'emaid') is stored without separators; a
    // charger may present the eMAID with them (ID-PLS-C12345678).
    `SELECT t.id, t.kind, t.status, t.valid_to, t.energy_limit_wh, t.spend_limit_idr,
            (o.pnc_settings->>'enabled')::boolean IS TRUE AS pnc_on
       FROM token t
       JOIN site s ON s.org_id = t.org_id
       JOIN charge_point cp ON cp.site_id = s.id
       JOIN organisation o ON o.id = t.org_id
      WHERE cp.id = $1 AND (t.uid = $2 OR (t.kind = 'emaid' AND t.uid = $3))
      ORDER BY (t.uid = $2) DESC
      LIMIT 1`,
    [chargePointId, idTag, normaliseEmaid(idTag)],
  );
  // Not one of the operator's own cards: it may be a roaming partner's driver (OCPI).
  if (!row) return (await authorizeRoaming(chargePointId, idTag)) ?? { status: 'Invalid' };
  // Contracts work only while the operator has Plug & Charge switched on.
  if (row.kind === 'emaid' && !row.pnc_on) return { status: 'Invalid' };
  if (row.valid_to && new Date(row.valid_to) < new Date()) return { status: 'Expired' };

  /**
   * A prepaid claim token is only a key to ITS payment.
   *
   * It stayed 'Accepted' forever, while the payment it unlocks can only be
   * claimed within the checkout window. Presented after that window, the token
   * started a session with no prepaid limit and no payer — unlimited energy
   * billed to nobody — and left the driver's payment unclaimed. It is now valid
   * only while its payment is claimable, or while its own session is running
   * (so a retried StartTransaction / reconnect keeps working).
   */
  if (row.kind === 'prepaid') {
    const usable = await one<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM payment_intent pi
          WHERE pi.claim_id_tag = $1 AND pi.mode IN ('prepurchase', 'preauth', 'postpay')
            AND pi.state IN ('captured', 'authorised')
            AND (pi.mode NOT IN ('preauth', 'postpay') OR pi.hold_state IN ('held', 'capturing', 'captured', 'capture_failed'))
            AND (
              (pi.session_id IS NULL AND pi.refund_state IS NULL
                 AND pi.created_at > now() - make_interval(mins => $2::int))
              OR pi.session_id IN (SELECT id FROM charging_session WHERE state = 'active')
            )
       ) AS ok`,
      [idTag, PREPAID_CLAIM_WINDOW_MIN],
    );
    if (!usable?.ok) return { status: 'Expired' };
  }

  const allowed: IdTagInfo['status'][] = ['Accepted', 'Blocked', 'Expired', 'Invalid', 'ConcurrentTx'];
  let status = allowed.includes(row.status as IdTagInfo['status'])
    ? (row.status as IdTagInfo['status'])
    : 'Invalid';

  /**
   * Operator-set cumulative limits (RFID centre, migration 009). A card that has
   * drawn its energy allowance or spent its budget is refused like a blocked
   * card. Only queried when a limit is actually set, so the hot path for the
   * ordinary card is unchanged.
   */
  // Usage includes the card's roaming charges on other networks (OCPI CDRs).
  if (status === 'Accepted' && (await overLimit(row))) status = 'Blocked';

  return {
    status,
    ...(row.valid_to ? { expiryDate: new Date(row.valid_to).toISOString() } : {}),
  };
}

export function toCanonicalMeterValues(raw: any[]): CanonicalMeterValue[] {
  return (Array.isArray(raw) ? raw : []).map((m) => ({
    timestamp: m?.timestamp ?? new Date().toISOString(),
    sampledValue: (Array.isArray(m?.sampledValue) ? m.sampledValue : []).map(
      (s: any): SampledValue => ({
        measurand: s?.measurand ?? 'Energy.Active.Import.Register',
        // A SignedData sample's value is the signed blob (OCMF), not a number: keep it as
        // signed data and make sure it can never be read as a register (NaN is skipped).
        value: s?.format === 'SignedData' ? NaN : Number(s?.value),
        unit: s?.unit,
        phase: s?.phase,
        context: s?.context,
        location: s?.location,
        ...(s?.format === 'SignedData' && typeof s?.value === 'string' ? { signed: { data: s.value } } : {}),
      }),
    ),
  }));
}

/**
 * Confirm the transaction-id sequence exists.
 *
 * This used to be `CREATE SEQUENCE IF NOT EXISTS` on the gateway's boot path,
 * which is DDL executed by the least-privileged role in the system. Postgres
 * checks the schema ACL BEFORE `IF NOT EXISTS` short-circuits, so running as
 * `plugsure_app` failed with "permission denied for schema public" on every
 * start — for a sequence that already existed. The sequence now belongs to
 * migration 006; this only checks, and says something useful if it is missing.
 */
export async function ensureTxSequence() {
  const ok = await one<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class WHERE relname = 'ocpp_tx_seq'`);
  if (!ok?.n) {
    throw new Error(
      'The sequence ocpp_tx_seq does not exist. Run the migrations (npm run migrate) before ' +
        'starting the gateway — it is created by db/migrations/006_runtime_role.sql.',
    );
  }
}
