import { logger } from '../logger.js';
import { config } from '../config.js';
import { many } from '../db/pool.js';
import * as registry from './registry.js';
import { recordFinding, parseRateUnits, recordChargerRateUnits } from './quirks.js';
import { translate201 } from './translate201.js';
import { to201Variable } from './config-catalog.js';
import type { AdapterContext } from './adapter16.js';

/**
 * Provisioning routine, run after every accepted BootNotification.
 *
 *   GetConfiguration (no keys = dump all)
 *     -> diff against desired state
 *     -> ChangeConfiguration per differing key
 *     -> RECORD every Rejected / NotSupported as a capability finding AND CONTINUE
 *     -> TriggerMessage(StatusNotification) per connector
 *     -> sync the local auth list
 *
 * A 2.0.1 / 2.1 station gets the same steps in its own wire form (translate201:
 * GetVariables / SetVariables, one station-wide TriggerMessage, GetLocalListVersion
 * / SendLocalList with versionNumber); keys with no device-model equivalent are
 * skipped, not recorded as rejected.
 *
 * The critical rule: a Rejected metering key is NOT a fatal provisioning error.
 * Autel units are documented to reject MeterValuesSampledData. Treating that as
 * fatal would strand the fleet. Degrade gracefully and record what happened.
 */

export const DESIRED_CONFIG: Record<string, string> = {
  HeartbeatInterval: String(config.gateway.heartbeatIntervalS),
  MeterValueSampleInterval: '60',
  MeterValuesSampledData:
    'Energy.Active.Import.Register,Power.Active.Import,Current.Import,Voltage,SoC',
  StopTxnSampledData: 'Energy.Active.Import.Register',
  ClockAlignedDataInterval: '900',
  WebSocketPingInterval: '60',
  // Non-negotiable in Indonesia: 4G backhaul drops and sessions must survive it.
  LocalAuthListEnabled: 'true',
  LocalAuthorizeOffline: 'true',
  AllowOfflineTxForUnknownId: 'false',
  StopTransactionOnInvalidId: 'true',
  TransactionMessageAttempts: '10',
  TransactionMessageRetryInterval: '30',
  ConnectionTimeOut: '120',
};

/** Highest connector / EVSE id we accept from a charger (the adapters' own bound). */
const MAX_CONNECTOR_ID = 128;

const is2x = (v: string | undefined) => v === 'ocpp2.0.1' || v === 'ocpp2.1';

/**
 * One provisioning call in the wire form the charger negotiated.
 *
 * Provisioning used to put 1.6 frames (GetConfiguration, ChangeConfiguration,
 * GetLocalListVersion, SendLocalList) on every connection, 2.0.1 stations
 * included — they answer NotImplemented or FormationViolation, and every
 * "Rejected" was then recorded against the model as a capability fact. The
 * command layer's translation (translate201: GetVariables / SetVariables /
 * versionNumber …) is applied here at priority 1 and WITHOUT an audit row per
 * key: provisioning is the platform's own background traffic, as before.
 */
async function call<T>(conn: registry.Registered, action: string, payload: unknown): Promise<T> {
  if (!is2x(conn.version)) return conn.rpc.call<T>(action, payload, 1);
  const wire = translate201(action, payload);
  if (wire.localOnly) return wire.mapResult(undefined) as T;
  return wire.mapResult(await conn.rpc.call(wire.action, wire.payload, 1)) as T;
}

export async function provisionChargePoint(identity: string, ctx: AdapterContext) {
  const conn = registry.get(identity);
  if (!conn) return;
  const v201 = is2x(conn.version);

  let current: Record<string, string> = {};
  let unknownKeys: string[] = [];
  try {
    // 2.0.1: GetVariables for every catalog key that has a device-model mapping.
    const res = await call<{ configurationKey?: any[]; unknownKey?: string[] }>(conn, 'GetConfiguration', {});
    for (const k of res.configurationKey ?? []) current[k.key] = String(k.value ?? '');
    unknownKeys = res.unknownKey ?? [];
  } catch (e) {
    logger.warn({ cp: identity, err: (e as Error).message }, 'GetConfiguration failed — continuing with blind writes');
  }

  const rejected: string[] = [];  // the charger genuinely said no
  const accepted: string[] = [];  // the charger genuinely said yes
  const errored: string[] = [];   // we never got an answer — NOT a capability fact
  for (const [key, value] of Object.entries(DESIRED_CONFIG)) {
    if (current[key] === value) {
      accepted.push(key);
      continue;
    }
    // A key with no 2.0.1 device-model equivalent is not asked for at all on a
    // 2.0.1 station — "we had nothing to send" is not the station rejecting it.
    if (v201 && !to201Variable(key)) continue;
    try {
      const r = await call<{ status: string }>(conn, 'ChangeConfiguration', { key, value });
      if (r.status === 'Rejected' || r.status === 'NotSupported') {
        rejected.push(key);
        logger.info({ cp: identity, key, status: r.status }, 'config key not accepted — degrading gracefully');
      } else {
        accepted.push(key);
        if (r.status === 'RebootRequired') logger.info({ cp: identity, key }, 'config change requires reboot');
      }
    } catch (e) {
      // A disconnect mid-provisioning is NOT evidence that the hardware rejects
      // the key. Recording it as one permanently mislabelled every key for the
      // whole model fleet, and the registry never retracted.
      errored.push(key);
      logger.warn({ cp: identity, key, err: (e as Error).message }, 'ChangeConfiguration errored — no capability recorded');
      if ((e as Error).message.includes('closed')) break; // socket gone; stop here
    }
  }

  // Learn which charging rate unit the hardware will actually accept — for THIS
  // charger. It used to be written to the model-wide quirk profile, where any
  // one unit's answer decided the unit for every tenant's chargers of the model
  // (see quirks.ts recordChargerRateUnits).
  const allowedUnits = parseRateUnits(current['ChargingScheduleAllowedChargingRateUnit']);
  const maxLocalList = current['LocalAuthListMaxLength'];

  if (allowedUnits) {
    await recordChargerRateUnits(ctx.chargePointId, ctx.quirkProfileId, allowedUnits, {
      vendor: ctx.vendor ?? 'unknown',
      model: ctx.model ?? 'unknown',
      firmware: ctx.firmware,
    }).catch((e) => logger.warn({ cp: identity, err: (e as Error).message }, 'could not record the charging rate unit'));
  }

  if (ctx.quirkProfileId && ctx.vendor && ctx.model) {
    await recordFinding(
      ctx.quirkProfileId,
      {
        rejectedConfigKeys: [...rejected, ...unknownKeys],
        acceptedConfigKeys: accepted,
        ...(maxLocalList ? { maxLocalAuthListEntries: Number(maxLocalList) } : {}),
      },
      { vendor: ctx.vendor, model: ctx.model, firmware: ctx.firmware },
    );
  }

  // Establish initial connector state. TriggerMessage is the recovery tool for
  // stuck or silent chargers; wire it early.
  //
  // NumberOfConnectors is whatever the charger says. It drove this loop
  // unbounded: a charger reporting 2^31 kept its provisioning task (and the
  // priority-1 queue behind it) busy indefinitely. Capped at the id bound the
  // adapters enforce on inbound connector ids. A 2.0.1 station gets ONE
  // station-wide TriggerMessage (no evse = every connector), so no count is needed.
  const reported = Math.floor(Number(current['NumberOfConnectors'] ?? 1));
  const connectorCount = v201 ? 1 : Number.isFinite(reported) ? Math.min(Math.max(reported, 1), MAX_CONNECTOR_ID) : 1;
  if (!v201 && reported > MAX_CONNECTOR_ID) {
    logger.warn({ cp: identity, reported }, `NumberOfConnectors above ${MAX_CONNECTOR_ID} — status triggers capped`);
  }
  for (let i = 1; i <= connectorCount; i++) {
    try {
      await call(conn, 'TriggerMessage', v201 ? { requestedMessage: 'StatusNotification' } : { requestedMessage: 'StatusNotification', connectorId: i });
    } catch (e) {
      /* optional feature profile; ignore — but a closed socket ends the loop */
      if ((e as Error).message?.includes('closed')) break;
    }
  }

  await syncLocalAuthList(identity, ctx.chargePointId);

  logger.info(
    { cp: identity, accepted: accepted.length, rejected: rejected.length, errored: errored.length, connectors: connectorCount },
    'provisioning complete',
  );
}

/**
 * Local auth list sync. Essential where connectivity is unreliable — an offline
 * charger with a current list still serves its regulars.
 */
export async function syncLocalAuthList(identity: string, chargePointId: string) {
  const conn = registry.get(identity);
  if (!conn) return;

  const tokens = await many<{ uid: string; status: string; valid_to: Date | null }>(
    `SELECT t.uid, t.status, t.valid_to
       FROM token t
       JOIN site s ON s.org_id = t.org_id
       JOIN charge_point cp ON cp.site_id = s.id
      WHERE cp.id = $1 AND t.offline_allowed = true
      LIMIT 1000`,
    [chargePointId],
  );
  if (tokens.length === 0) return;

  try {
    // Both calls in the charger's own wire form (2.0.1: versionNumber, idToken).
    const cur = await call<{ listVersion: number }>(conn, 'GetLocalListVersion', {});
    const current = cur?.listVersion ?? 0;
    if (current < 0) {
      // -1 is the spec's "local authorisation list is not supported".
      logger.info({ cp: identity }, 'charger reports no local auth list support — skipping sync');
      return;
    }
    const nextVersion = Math.max(current, 0) + 1;
    const r = await call<{ status: string }>(conn, 'SendLocalList', {
      listVersion: nextVersion,
      updateType: 'Full',
      localAuthorizationList: tokens.map((t) => ({
        idTag: t.uid,
        idTagInfo: {
          status: t.status,
          // Without an expiry the charger's offline cache honours a revoked
          // token indefinitely.
          ...(t.valid_to ? { expiryDate: new Date(t.valid_to).toISOString() } : {}),
        },
      })),
    });
    logger.info({ cp: identity, count: tokens.length, status: r?.status }, 'local auth list synced');
  } catch (e) {
    logger.info({ cp: identity, err: (e as Error).message }, 'local auth list sync unsupported or failed');
  }
}
