import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';
import * as commands from '../ocpp/commands.js';

/**
 * The diagnostics bot (v1.44.0): a first-line troubleshooter for a charger. It reads what the charger has been saying,
 * asks it a few safe questions, may try a soft reset, and writes a plain summary — into a work order when someone has to
 * go there.
 *
 * Steps (each recorded with what it found):
 *   connection     online now; the last heartbeat; reboots and refused calls in the last 24 hours
 *   errors         the error codes its connectors reported in the last 7 days (OCPP StatusNotification), and now
 *   refresh        (online) ask for a fresh StatusNotification and a Heartbeat
 *   configuration  (online) read the keys that most often cause trouble and compare them with sensible ranges
 *   reset          only when allowed, a connector is Faulted and nothing is charging on the charger: a SOFT reset, then
 *                  up to 90 s for it to come back and report again
 * The verdict: healthy, fixed (the reset cleared the fault), needs_attention (configuration, frequent reboots, errors
 * that are not hardware), needs_visit (a hardware error code, or a fault the reset did not clear), unreachable.
 *
 * It never sends a hard reset, never changes configuration, never unlocks or stops anything. Every command it sends is
 * audited like any other (ocpp/commands.ts), as the person who started the run.
 */

export class DiagError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type Verdict = 'healthy' | 'fixed' | 'needs_visit' | 'needs_attention' | 'unreachable';
export interface Step { step: string; at: string; ok: boolean; detail: string; data?: unknown }
export interface Finding { kind: 'error_code' | 'config' | 'reboots' | 'offline' | 'call_errors' | 'fault_now'; severity: 'info' | 'warning' | 'critical'; text: string; visit: boolean }

/** What an OCPP 1.6 error code usually means, and whether it needs someone on site. */
export const ERROR_CODES: Record<string, { meaning: string; action: string; visit: boolean }> = {
  ConnectorLockFailure: { meaning: 'the connector lock did not engage or release', action: 'Check the lock actuator and the cable latch; clean the socket.', visit: true },
  EVCommunicationError: { meaning: 'the car and the charger could not talk (PWM / PLC)', action: 'Usually the car or the cable; repeated with many cars, check the charger\'s control board and cable.', visit: false },
  GroundFailure: { meaning: 'an earth leakage / RCD trip', action: 'Electrician: check the RCD, earthing and cable insulation. Do not keep resetting.', visit: true },
  HighTemperature: { meaning: 'the charger got too hot', action: 'Check the fans, filters and ventilation; shade in direct sun; derate if it repeats.', visit: true },
  InternalError: { meaning: 'an internal fault in the charger', action: 'A soft reset may clear it; if it repeats, the vendor\'s logs (Diagnostics) and a firmware check.', visit: false },
  LocalListConflict: { meaning: 'the local authorisation list is inconsistent', action: 'Re-send the local list (RFID & Access).', visit: false },
  OtherError: { meaning: 'a vendor-specific error', action: 'See the vendor error code in the vendor\'s manual.', visit: false },
  OverCurrentFailure: { meaning: 'over-current protection tripped', action: 'Electrician: check the breaker, wiring and the car\'s draw; check the load manager\'s limits.', visit: true },
  OverVoltage: { meaning: 'the supply voltage was too high', action: 'Check the supply with PLN or the site electrician.', visit: true },
  PowerMeterFailure: { meaning: 'the energy meter failed', action: 'Replace or recalibrate the meter (and re-verify metrology / tera).', visit: true },
  PowerSwitchFailure: { meaning: 'the contactor / relay failed', action: 'Replace the contactor.', visit: true },
  ReaderFailure: { meaning: 'the RFID reader failed', action: 'Check the reader\'s cable and module; app and QR charging still work.', visit: true },
  ResetFailure: { meaning: 'a reset did not complete', action: 'Power-cycle on site.', visit: true },
  UnderVoltage: { meaning: 'the supply voltage was too low', action: 'Check the supply with PLN or the site electrician; check for overload.', visit: true },
  WeakSignal: { meaning: 'a weak mobile / network signal', action: 'Check the antenna and SIM; consider an external antenna or wired network.', visit: true },
};

/** Configuration keys checked, with the range that works well. */
export const CONFIG_RULES: Array<{ key: string; min?: number; max?: number; why: string }> = [
  { key: 'HeartbeatInterval', min: 30, max: 900, why: 'too long and an outage is noticed late; too short wastes mobile data' },
  { key: 'MeterValueSampleInterval', min: 10, max: 300, why: 'too long and drivers see stale progress; prepaid energy limits react late' },
  { key: 'WebSocketPingInterval', min: 1, max: 300, why: '0 or very long and a dead mobile connection goes unnoticed' },
  { key: 'ConnectionTimeOut', min: 30, max: 300, why: 'too short and drivers time out while plugging in' },
];

// ------------------------------------------------------------------ pure

export interface Facts {
  online: boolean; lastHeartbeatAt: string | null; reboots24h: number; callErrors24h: number;
  codes7d: Record<string, number>; vendorCodes: string[]; faultedNow: Array<{ connectorNo: number; errorCode: string | null }>;
  config: Record<string, string> | null; resetTried: boolean; faultedAfterReset: boolean | null;
}

/** The findings and the verdict from what the steps found. */
export function analyse(f: Facts): { findings: Finding[]; verdict: Verdict; summary: string } {
  const findings: Finding[] = [];
  if (!f.online) findings.push({ kind: 'offline', severity: 'critical', visit: true, text: `Offline${f.lastHeartbeatAt ? ` since its last heartbeat at ${f.lastHeartbeatAt.slice(0, 16).replace('T', ' ')} UTC` : ''}: check its power and its network (SIM, router) on site.` });
  for (const [code, n] of Object.entries(f.codes7d).sort((a, b) => b[1] - a[1])) {
    const k = ERROR_CODES[code];
    findings.push({ kind: 'error_code', severity: k?.visit ? 'critical' : 'warning', visit: !!k?.visit && n >= 2,
      text: `${code} reported ${n}× in 7 days${k ? `: ${k.meaning}. ${k.action}` : '. Not a standard OCPP 1.6 code: see the vendor\'s manual.'}` });
  }
  if (f.vendorCodes.length) findings.push({ kind: 'error_code', severity: 'info', visit: false, text: `Vendor error codes seen: ${f.vendorCodes.slice(0, 8).join(', ')}.` });
  if (f.reboots24h >= 3) findings.push({ kind: 'reboots', severity: 'warning', visit: f.reboots24h >= 6, text: `${f.reboots24h} reboots in 24 hours: an unstable supply, overheating or a firmware fault. Compare with the vendor's release notes.` });
  if (f.callErrors24h >= 5) findings.push({ kind: 'call_errors', severity: 'warning', visit: false, text: `${f.callErrors24h} refused or failed OCPP calls in 24 hours: a firmware or configuration mismatch; check the vendor's OCPP compatibility notes.` });
  if (f.config) {
    for (const r of CONFIG_RULES) {
      const v = f.config[r.key];
      if (v == null) continue;
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      if ((r.min != null && n < r.min) || (r.max != null && n > r.max)) findings.push({ kind: 'config', severity: 'warning', visit: false, text: `${r.key} is ${v} (works best ${r.min ?? 0}–${r.max ?? '∞'}): ${r.why}. Change it in Charge points → Configuration.` });
    }
  }
  const stillFaulted = f.resetTried ? f.faultedAfterReset === true : f.faultedNow.length > 0;
  if (stillFaulted) findings.push({ kind: 'fault_now', severity: 'critical', visit: f.resetTried || f.faultedNow.some((c) => !!c.errorCode && !!ERROR_CODES[c.errorCode]?.visit),
    text: `${f.faultedNow.map((c) => `Connector ${c.connectorNo}${c.errorCode ? ` (${c.errorCode})` : ''}`).join(', ') || 'A connector'} is Faulted${f.resetTried ? ' and the soft reset did not clear it' : ''}.` });

  const verdict: Verdict = !f.online ? 'unreachable'
    : f.resetTried && f.faultedAfterReset === false && f.faultedNow.length > 0 ? 'fixed'
      : findings.some((x) => x.visit) ? 'needs_visit'
        : findings.some((x) => x.severity !== 'info') ? 'needs_attention' : 'healthy';
  const head = {
    healthy: 'No problem found: it is online, reports no errors and its configuration is in range.',
    fixed: 'A connector was faulted; a soft reset cleared it. Watch it: if the fault comes back, it needs a visit.',
    needs_attention: 'It works, but needs attention remotely (see below).',
    needs_visit: 'Someone needs to go to the charger (see below).',
    unreachable: 'The charger is not connected, so nothing could be checked remotely.',
  }[verdict];
  const summary = [head, ...findings.filter((x) => x.severity !== 'info' || verdict === 'healthy').map((x) => `• ${x.text}`)].join('\n').slice(0, 1900);
  return { findings, verdict, summary };
}

// ------------------------------------------------------------------ running

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function chargerOf(orgId: string, chargePointId: string) {
  if (!UUID_RE.test(chargePointId)) throw new DiagError(404, 'No such charge point.');
  const cp = await outsideRequestScope(() => one<any>(
    `SELECT cp.id, cp.ocpp_identity, COALESCE(cp.display_name, cp.ocpp_identity) AS name, cp.last_heartbeat_at, cp.offline_since, s.org_id
       FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE cp.id = $1 AND s.org_id = $2 AND cp.decommissioned_at IS NULL`, [chargePointId, orgId]));
  if (!cp) throw new DiagError(404, 'No such charge point.');
  return cp;
}

async function faulted(cpId: string) {
  return outsideRequestScope(() => many<{ connectorNo: number; errorCode: string | null }>(
    `SELECT e.evse_id AS "connectorNo", NULLIF(c.error_code, 'NoError') AS "errorCode" FROM connector c JOIN evse e ON e.id = c.evse_uuid
      WHERE e.charge_point_id = $1 AND c.status = 'Faulted' ORDER BY e.evse_id`, [cpId]));
}

/** Start a run: recorded at once, carried out in the background (the console polls it). */
export async function start(orgId: string, chargePointId: string, opts: { userId: string | null; ip?: string; allowReset?: boolean; openWorkOrder?: boolean }) {
  const cp = await chargerOf(orgId, chargePointId);
  const busy = await outsideRequestScope(() => one(`SELECT 1 FROM diagnostic_run WHERE charge_point_id = $1 AND status = 'running' AND started_at > now() - interval '10 minutes'`, [cp.id]));
  if (busy) throw new DiagError(409, 'A diagnostics run is already going on this charger.');
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO diagnostic_run (org_id, charge_point_id, allow_reset, started_by) VALUES ($1, $2, $3, $4) RETURNING id`, [orgId, cp.id, opts.allowReset === true, opts.userId]));
  const id = String(r!.id);
  void execute(id, orgId, cp, opts).catch(async (e) => {
    logger.error({ runId: id, err: (e as Error).message }, 'diagnostics run failed');
    await outsideRequestScope(() => query(`UPDATE diagnostic_run SET status = 'failed', summary = $2, finished_at = now() WHERE id = $1`, [id, `The run failed: ${(e as Error).message}`.slice(0, 500)])).catch(() => {});
  });
  return { id };
}

/** The run itself. Exported for tests (which await it). */
export async function execute(id: string, orgId: string, cp: any, opts: { userId: string | null; ip?: string; allowReset?: boolean; openWorkOrder?: boolean }, waitMs = 90_000) {
  const steps: Step[] = [];
  const save = (status = 'running') => outsideRequestScope(() => query(`UPDATE diagnostic_run SET steps = $2, status = $3 WHERE id = $1`, [id, JSON.stringify(steps), status]));
  const step = async (name: string, ok: boolean, detail: string, data?: unknown) => { steps.push({ step: name, at: new Date().toISOString(), ok, detail, ...(data !== undefined ? { data } : {}) }); await save(); };
  const actor: commands.Actor = { type: 'user', id: opts.userId ?? undefined, orgId, ip: opts.ip };
  const ident: string = cp.ocpp_identity;

  // 1. connection
  const hb = cp.last_heartbeat_at ? new Date(cp.last_heartbeat_at) : null;
  const online = commands.reachable(ident) || (!cp.offline_since && !!hb && Date.now() - hb.getTime() < 10 * 60_000);
  const counts = await outsideRequestScope(() => one<any>(
    `SELECT count(*) FILTER (WHERE action = 'BootNotification' AND direction = 'in' AND message_type = 2)::int AS boots,
            count(*) FILTER (WHERE message_type = 4)::int AS errors
       FROM ocpp_frame WHERE ocpp_identity = $1 AND ts > now() - interval '24 hours'`, [ident]));
  await step('connection', online, online ? `Online. Last heartbeat ${hb ? hb.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'not recorded'}.` : 'Not connected.',
    { online, reboots24h: counts?.boots ?? 0, callErrors24h: counts?.errors ?? 0 });

  // 2. errors
  const frames = await outsideRequestScope(() => many<any>(
    `SELECT payload FROM ocpp_frame WHERE ocpp_identity = $1 AND action = 'StatusNotification' AND direction = 'in' AND message_type = 2 AND ts > now() - interval '7 days'`, [ident]));
  const codes: Record<string, number> = {};
  const vendor = new Set<string>();
  for (const f of frames) {
    const p = f.payload ?? {};
    // 1.6: errorCode; 2.0.1 reports only connectorStatus (its errors come as NotifyEvent): Faulted counts as such.
    const code: string | null = p.errorCode ?? (p.connectorStatus === 'Faulted' ? 'Faulted' : null);
    if (code && code !== 'NoError') codes[code] = (codes[code] ?? 0) + 1;
    if (p.vendorErrorCode) vendor.add(String(p.vendorErrorCode).slice(0, 40));
  }
  const faultedNow = await faulted(cp.id);
  await step('errors', !Object.keys(codes).length && !faultedNow.length,
    Object.keys(codes).length ? `Error codes in 7 days: ${Object.entries(codes).map(([k, n]) => `${k} ×${n}`).join(', ')}.` : 'No error codes in 7 days.', { codes, faultedNow });

  let config: Record<string, string> | null = null;
  let resetTried = false, faultedAfterReset: boolean | null = null;
  if (online) {
    // 3. refresh
    try {
      const a = await commands.triggerMessage(ident, 'StatusNotification', undefined, actor);
      const b = await commands.triggerMessage(ident, 'Heartbeat', undefined, actor);
      await step('refresh', a?.status === 'Accepted', `StatusNotification: ${a?.status ?? 'no answer'}; Heartbeat: ${b?.status ?? 'no answer'}.`);
    } catch (e) { await step('refresh', false, `Could not ask: ${(e as Error).message}`.slice(0, 200)); }
    // 4. configuration
    try {
      const r = await commands.getConfiguration(ident, CONFIG_RULES.map((x) => x.key), actor);
      config = Object.fromEntries((r?.configurationKey ?? []).map((k: any) => [String(k.key), String(k.value ?? '')]));
      await step('configuration', true, `Read ${Object.keys(config).length} of ${CONFIG_RULES.length} keys.`, config);
    } catch (e) { await step('configuration', false, `Could not read: ${(e as Error).message}`.slice(0, 200)); }
    // 5. a soft reset, only when allowed, faulted, and nothing charging
    if (opts.allowReset && faultedNow.length) {
      const charging = await outsideRequestScope(() => one(`SELECT 1 FROM charging_session WHERE charge_point_id = $1 AND state = 'active'`, [cp.id]));
      if (charging) await step('reset', false, 'Not reset: a session is charging on this charger.');
      else {
        try {
          const r = await commands.reset(ident, 'Soft', actor);
          resetTried = r?.status === 'Accepted';
          await step('reset', resetTried, `Soft reset: ${r?.status ?? 'no answer'}.`);
          if (resetTried) {
            const since = Date.now();
            let after = faultedNow;
            while (Date.now() - since < waitMs) {
              await sleep(Math.min(5_000, waitMs));
              after = await faulted(cp.id);
              const back = await outsideRequestScope(() => one(`SELECT 1 FROM ocpp_frame WHERE ocpp_identity = $1 AND action = 'BootNotification' AND ts > $2`, [ident, new Date(since)]));
              if (back && !after.length) break;
            }
            faultedAfterReset = after.length > 0;
            await step('after reset', !faultedAfterReset, faultedAfterReset ? 'Still faulted after the reset.' : 'No connector is faulted now.');
          }
        } catch (e) { await step('reset', false, `Could not reset: ${(e as Error).message}`.slice(0, 200)); }
      }
    }
  }

  const a = analyse({ online, lastHeartbeatAt: hb?.toISOString() ?? null, reboots24h: counts?.boots ?? 0, callErrors24h: counts?.errors ?? 0, codes7d: codes, vendorCodes: [...vendor], faultedNow, config, resetTried, faultedAfterReset });
  let workOrderId: string | null = null;
  if (opts.openWorkOrder && a.verdict !== 'healthy' && a.verdict !== 'fixed') workOrderId = (await workOrderFor(orgId, id, opts.userId, cp, a.verdict, a.summary)).id;
  await outsideRequestScope(() => query(
    `UPDATE diagnostic_run SET status = 'done', steps = $2, findings = $3, verdict = $4, summary = $5, work_order_id = $6, finished_at = now() WHERE id = $1`,
    [id, JSON.stringify(steps), JSON.stringify(a.findings), a.verdict, a.summary, workOrderId]));
  return { ...a, steps, workOrderId };
}

const VERDICT_TEXT: Record<Verdict, string> = { healthy: 'healthy', fixed: 'fixed by a reset', needs_attention: 'needs attention', needs_visit: 'needs a visit', unreachable: 'not connected' };

async function workOrderFor(orgId: string, runId: string, userId: string | null, cp: any, verdict: Verdict, summary: string) {
  const { save } = await import('./maintenance.js');
  const w = await outsideRequestScope(() => save(orgId, null, {
    kind: 'corrective', title: `Diagnostics: ${cp.name} — ${VERDICT_TEXT[verdict]}`.slice(0, 160), chargePointId: cp.id,
    description: `${summary}\n\n(From diagnostics run #${runId}.)`.slice(0, 2000),
  }, userId)) as any;
  return { id: String(w.id), number: w.number };
}

/** Open a work order from a finished run (when it was not opened by the run). */
export async function openWorkOrder(orgId: string, runId: string, userId: string | null) {
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM diagnostic_run WHERE id = $1 AND org_id = $2`, [Number(runId) || 0, orgId]));
  if (!r) throw new DiagError(404, 'No such run.');
  if (r.status !== 'done') throw new DiagError(409, 'The run has not finished.');
  if (r.work_order_id) throw new DiagError(409, 'A work order was already opened from this run.');
  const cp = await chargerOf(orgId, r.charge_point_id);
  const w = await workOrderFor(orgId, String(r.id), userId, cp, r.verdict, r.summary ?? '');
  await outsideRequestScope(() => query(`UPDATE diagnostic_run SET work_order_id = $2 WHERE id = $1`, [r.id, w.id]));
  return w;
}

const runOf = (r: any) => ({
  id: String(r.id), chargePointId: r.charge_point_id, status: r.status, allowReset: r.allow_reset, verdict: r.verdict ?? null, summary: r.summary ?? null,
  steps: r.steps ?? [], findings: r.findings ?? [], workOrderId: r.work_order_id ? String(r.work_order_id) : null, workOrder: r.wo_number ?? null,
  startedAt: new Date(r.started_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
});

export async function get(orgId: string, id: string) {
  const r = await outsideRequestScope(() => one<any>(`SELECT d.*, w.number AS wo_number FROM diagnostic_run d LEFT JOIN work_order w ON w.id = d.work_order_id WHERE d.id = $1 AND d.org_id = $2`, [Number(id) || 0, orgId]));
  if (!r) throw new DiagError(404, 'No such run.');
  return runOf(r);
}

export async function list(orgId: string, chargePointId: string) {
  if (!UUID_RE.test(chargePointId)) throw new DiagError(404, 'No such charge point.');
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT d.*, w.number AS wo_number FROM diagnostic_run d LEFT JOIN work_order w ON w.id = d.work_order_id WHERE d.org_id = $1 AND d.charge_point_id = $2 ORDER BY d.started_at DESC LIMIT 20`, [orgId, chargePointId]));
  return { runs: rows.map(runOf) };
}
