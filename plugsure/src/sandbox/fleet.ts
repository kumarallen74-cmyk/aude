import { logger } from '../logger.js';
import { createECDH, createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { many, one, query } from '../db/pool.js';
import { attachVirtualCharger } from '../ocpp/server.js';
import { VirtualChargePoint } from './virtual-charge-point.js';

/**
 * The sandbox's virtual chargers, run by the gateway (the process that owns
 * charger connections). Each is the QA simulator's charge point, speaking the
 * protocol it is registered with (OCPP 1.6, 2.0.1 or 2.1), with a signing meter,
 * attached through an in-memory socket instead of the network. Time runs 30×
 * faster than the wall clock for energy, so a session delivers kWh in seconds.
 *
 * `simulate()` is how a developer acts out what happens at a real charger: a
 * cable plugged in, a card tapped, a fault, the 4G link dropping.
 */

const running = new Map<string, { vcp: VirtualChargePoint; chargePointId: string }>();
/** Taken offline on purpose: not reconnected by the sync until brought back. */
const offline = new Set<string>();

interface Row { id: string; ocpp_identity: string; vendor: string | null; model: string | null; firmware: string | null; evses: number; dc: boolean; max_w: number | null; ocpp_version: string | null }

export async function syncVirtualFleet(): Promise<{ started: number; stopped: number }> {
  const rows = await many<Row>(
    `SELECT cp.id, cp.ocpp_identity, cp.vendor, cp.model, cp.firmware, cp.ocpp_version,
            (SELECT count(*)::int FROM evse e WHERE e.charge_point_id = cp.id) AS evses,
            EXISTS (SELECT 1 FROM evse e JOIN connector c ON c.evse_uuid = e.id WHERE e.charge_point_id = cp.id AND c.current_type = 'DC') AS dc,
            (SELECT max(e.max_power_w)::int FROM evse e WHERE e.charge_point_id = cp.id) AS max_w
       FROM charge_point cp JOIN site s ON s.id = cp.site_id JOIN organisation o ON o.id = s.org_id
      WHERE cp.virtual AND cp.status <> 'decommissioned' AND s.archived_at IS NULL
        AND o.sandbox_of_org_id IS NOT NULL AND o.archived_at IS NULL`,
  );
  const want = new Set(rows.map((r) => r.ocpp_identity));
  let started = 0;
  let stopped = 0;
  for (const [identity, r] of running) {
    if (want.has(identity)) continue;
    running.delete(identity);
    offline.delete(identity);
    await r.vcp.stop().catch(() => {});
    stopped++;
  }
  // A charger switched to another protocol reconnects speaking it.
  for (const r of rows) {
    const cur = running.get(r.ocpp_identity);
    if (cur && cur.vcp.opts.protocol !== protocolOf(r.ocpp_version) && !cur.vcp.charging) {
      running.delete(r.ocpp_identity);
      await cur.vcp.stop().catch(() => {});
      stopped++;
    }
  }
  for (const r of rows) {
    if (running.has(r.ocpp_identity) || offline.has(r.ocpp_identity)) continue;
    await registerMeter(r).catch((e) => logger.warn({ cp: r.ocpp_identity, err: (e as Error).message }, 'sandbox meter key not registered'));
    const vcp = makeCharger(r);
    running.set(r.ocpp_identity, { vcp, chargePointId: r.id });
    void vcp.start().catch((e) => logger.warn({ cp: r.ocpp_identity, err: (e as Error).message }, 'sandbox charger did not start'));
    started++;
  }
  if (started || stopped) logger.info({ started, stopped, running: running.size }, 'sandbox virtual fleet synced');
  return { started, stopped };
}

const protocolOf = (v: string | null) => (v === 'ocpp2.0.1' || v === 'ocpp2.1' ? v : 'ocpp1.6');

/**
 * Each virtual charger has a signing meter (OCMF), like a calibration-law one. Its key is
 * derived from the charger's identity and this installation's secret, so it survives
 * restarts; the public key and the meter serial are registered on the charger's
 * connectors, so the CSMS can verify what the sandbox meter signs.
 */
function meterKeyFor(identity: string) {
  const d = createHash('sha256').update(`plugsure-sandbox-meter|${process.env.SECRETS_KEY ?? ''}|${identity}`).digest();
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  const b64u = (b: Buffer) => b.toString('base64url');
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
  const privateKey = createPrivateKey({ key: { ...jwk, d: b64u(d) }, format: 'jwk' });
  const publicKeyHex = (createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'der' }) as Buffer).toString('hex');
  return { privateKey, publicKeyHex };
}

const meterSerialFor = (identity: string) => `SBX-MTR-${identity}`.slice(0, 60);

async function registerMeter(r: Row) {
  const { publicKeyHex } = meterKeyFor(r.ocpp_identity);
  await query(
    `UPDATE connector c SET meter_public_key = COALESCE(c.meter_public_key, $2), meter_serial = COALESCE(c.meter_serial, $3)
       FROM evse e WHERE e.id = c.evse_uuid AND e.charge_point_id = $1`,
    [r.id, publicKeyHex, meterSerialFor(r.ocpp_identity)],
  );
}

function makeCharger(r: Row): VirtualChargePoint {
  const protocol = protocolOf(r.ocpp_version);
  const vcp = new VirtualChargePoint({
    id: r.ocpp_identity,
    protocol,
    meterKey: meterKeyFor(r.ocpp_identity),
    meterSerial: meterSerialFor(r.ocpp_identity),
    // On OCPP 2.1 the sandbox's car can give energy back (ISO 15118-20), so bidirectional charging can be tried.
    bidirectional: protocol === 'ocpp2.1',
    connectors: Math.max(1, r.evses || 1),
    dc: r.dc,
    vendor: r.vendor ?? 'PlugSure',
    model: r.model ?? (r.dc ? 'Sandbox DC' : 'Sandbox AC'),
    firmware: r.firmware ?? '1.0.0',
    maxPowerW: r.max_w ?? (r.dc ? 60_000 : 22_000),
    idTag: 'SANDBOX-0001',
    speed: 30,
    meterIntervalS: 60,
    targetKwh: 40,
    reconnect: true,
    backoffBaseMs: 2_000,
    backoffMaxMs: 15_000,
    backoffJitter: 0.2,
    reservations: true,
    diagnostics: true,
    transport: () => attachVirtualCharger(r.ocpp_identity, protocol) as never,
    // The campaign's target version is what the unit boots on after "installing".
    firmwareVersionFor: async () =>
      (await one<{ version: string }>(
        `SELECT i.version FROM firmware_job j JOIN firmware_campaign c ON c.id = j.campaign_id JOIN firmware_image i ON i.id = c.image_id
          WHERE j.charge_point_id = $1 ORDER BY j.dispatched_at DESC NULLS LAST LIMIT 1`,
        [r.id],
      ))?.version ?? null,
  });
  vcp.on('error', (e: Error) => logger.debug({ cp: r.ocpp_identity, err: e.message }, 'sandbox charger'));
  return vcp;
}

export function isRunningHere(identity: string): boolean {
  return running.has(identity) || offline.has(identity);
}

import type { SimulateEvent } from './events.js';
export { SIMULATE_EVENTS, type SimulateEvent } from './events.js';

export class SimulateError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Act out something happening at a virtual charger. */
export async function simulate(identity: string, event: SimulateEvent, args: Record<string, unknown> = {}) {
  const r = running.get(identity);
  if (!r) throw new SimulateError(409, `${identity} is not running in the sandbox yet; try again in a few seconds`);
  const { vcp } = r;
  const connectorId = Number(args.connectorId ?? 1);
  if (!Number.isInteger(connectorId) || connectorId < 1 || connectorId > vcp.opts.connectors) {
    throw new SimulateError(400, `connectorId must be 1..${vcp.opts.connectors}`);
  }
  const online = () => vcp.snapshot().online;
  switch (event) {
    case 'status':
      break;
    case 'plug-in':
      if (!online()) throw new SimulateError(409, 'the charger is offline');
      await vcp.reportStatus(connectorId, 'Preparing');
      break;
    case 'unplug':
      if (vcp.charging && vcp.activeConnectorId === connectorId) vcp.stopSession('EVDisconnected');
      else await vcp.reportStatus(connectorId, 'Available');
      break;
    case 'tap-card': {
      if (vcp.charging) throw new SimulateError(409, 'a session is already running on this charger');
      const idTag = String(args.idTag ?? '').trim();
      if (!idTag) throw new SimulateError(400, 'idTag is required: the RFID card tapped at the charger');
      const kwh = args.kwh == null ? undefined : Number(args.kwh);
      if (kwh != null && !(kwh > 0 && kwh <= 200)) throw new SimulateError(400, 'kwh must be between 0 and 200');
      const soc = args.soc == null ? undefined : Number(args.soc);
      if (soc != null && !(soc >= 0 && soc <= 100)) throw new SimulateError(400, 'soc must be between 0 and 100');
      const bidirectional = args.bidirectional == null ? undefined : args.bidirectional === true || args.bidirectional === 'true';
      void vcp.runSession({ connectorId, idTag, ...(kwh != null ? { kwh } : {}), ...(soc != null ? { soc } : {}), ...(bidirectional != null ? { bidirectional } : {}) }).catch(() => {});
      await new Promise((res) => setTimeout(res, 300));
      break;
    }
    case 'plug-and-charge': {
      // ISO 15118: the car sends its contract; the charger asks the CSMS (Authorize with the certificate hash data).
      if (vcp.charging) throw new SimulateError(409, 'a session is already running on this charger');
      const why = vcp.pncProblem();
      if (why) throw new SimulateError(409, why);
      const emaid = String(args.emaid ?? '');
      const hashData = Array.isArray(args.hashData) ? args.hashData : [];
      const kwh = args.kwh == null ? undefined : Number(args.kwh);
      if (kwh != null && !(kwh > 0 && kwh <= 200)) throw new SimulateError(400, 'kwh must be between 0 and 200');
      const auth = new Promise<any>((res) => { vcp.once('pnc-authorize', res); setTimeout(() => res(null), 15_000); });
      void vcp.runSession({ connectorId, contract: { emaid, hashData }, ...(kwh != null ? { kwh } : {}) }).catch(() => {});
      const a = await auth;
      return { identity, event, authorize: a ? { idTokenInfo: a.idTagInfo, certificateStatus: a.certificateStatus } : null, charger: vcp.snapshot() };
    }
    case 'stop':
      if (!vcp.stopSession('Local')) throw new SimulateError(409, 'no session is running');
      break;
    case 'fault':
      await vcp.setFault(connectorId, {
        errorCode: String(args.errorCode ?? 'GroundFailure'),
        ...(args.vendorErrorCode ? { vendorErrorCode: String(args.vendorErrorCode).slice(0, 50) } : {}),
        ...(args.info ? { info: String(args.info).slice(0, 50) } : {}),
      });
      break;
    case 'clear-fault':
      await vcp.setFault(connectorId, null);
      break;
    case 'go-offline':
      // Like a 4G drop: a running session carries on, and its messages are
      // stored and sent when the link comes back.
      offline.add(identity);
      vcp.opts.reconnect = false;
      vcp.dropConnection('sandbox: taken offline');
      break;
    case 'come-online':
      offline.delete(identity);
      vcp.opts.reconnect = true;
      if (!online()) await vcp.start();
      break;
    case 'reboot':
      vcp.stopSession('PowerLoss');
      setTimeout(() => vcp.dropConnection('sandbox: reboot'), 1_000);
      break;
  }
  return { identity, event, charger: vcp.snapshot() };
}

export async function stopVirtualFleet(): Promise<void> {
  for (const r of running.values()) await r.vcp.stop().catch(() => {});
  running.clear();
  offline.clear();
}
