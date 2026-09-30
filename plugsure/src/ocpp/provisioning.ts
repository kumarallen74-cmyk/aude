import { logger } from '../logger.js';
import { config } from '../config.js';
import { many } from '../db/pool.js';
import * as registry from './registry.js';
import { recordFinding } from './quirks.js';
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

export async function provisionChargePoint(identity: string, ctx: AdapterContext) {
  const conn = registry.get(identity);
  if (!conn) return;

  let current: Record<string, string> = {};
  let unknownKeys: string[] = [];
  try {
    const res = await conn.rpc.call<{ configurationKey?: any[]; unknownKey?: string[] }>('GetConfiguration', {}, 1);
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
    try {
      const r = await conn.rpc.call<{ status: string }>('ChangeConfiguration', { key, value }, 1);
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

  // Learn which charging rate unit the hardware will actually accept.
  const allowedUnit = current['ChargingScheduleAllowedChargingRateUnit'];
  const maxLocalList = current['LocalAuthListMaxLength'];

  if (ctx.quirkProfileId && ctx.vendor && ctx.model) {
    await recordFinding(
      ctx.quirkProfileId,
      {
        rejectedConfigKeys: [...rejected, ...unknownKeys],
        acceptedConfigKeys: accepted,
        ...(allowedUnit
          ? { chargingRateUnit: allowedUnit.toUpperCase().includes('W') && !allowedUnit.toUpperCase().includes('A') ? 'W' : 'A' }
          : {}),
        ...(maxLocalList ? { maxLocalAuthListEntries: Number(maxLocalList) } : {}),
      },
      { vendor: ctx.vendor, model: ctx.model, firmware: ctx.firmware },
    );
  }

  // Establish initial connector state. TriggerMessage is the recovery tool for
  // stuck or silent chargers; wire it early.
  const connectorCount = Number(current['NumberOfConnectors'] ?? 1);
  for (let i = 1; i <= connectorCount; i++) {
    try {
      await conn.rpc.call('TriggerMessage', { requestedMessage: 'StatusNotification', connectorId: i }, 1);
    } catch {
      /* optional feature profile; ignore */
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
    const cur = await conn.rpc.call<{ listVersion: number }>('GetLocalListVersion', {}, 1);
    const current = cur?.listVersion ?? 0;
    if (current < 0) {
      // -1 is the spec's "local authorisation list is not supported".
      logger.info({ cp: identity }, 'charger reports no local auth list support — skipping sync');
      return;
    }
    const nextVersion = Math.max(current, 0) + 1;
    const r = await conn.rpc.call<{ status: string }>('SendLocalList', {
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
    }, 1);
    logger.info({ cp: identity, count: tokens.length, status: r?.status }, 'local auth list synced');
  } catch (e) {
    logger.info({ cp: identity, err: (e as Error).message }, 'local auth list sync unsupported or failed');
  }
}
