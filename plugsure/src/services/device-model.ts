import { one, many, query, tx, outsideRequestScope } from '../db/pool.js';
import { logger } from '../logger.js';

/**
 * The OCPP 2.0.1 device model: what a station says about itself, component by
 * component (EVSE 1, Connector 2, PowerModule 3, OCPPCommCtrlr, SampledDataCtrlr…),
 * each with variables whose attributes (Actual, Target, MinSet, MaxSet) carry a
 * value and a mutability, and characteristics (data type, unit, limits, allowed
 * values). Stations report it in parts (NotifyReport) after GetBaseReport; the
 * console reads it from here, and sets values with SetVariables.
 *
 * Monitors (thresholds, deltas, periodic readings) raise NotifyEvent; the console
 * lists them (NotifyMonitoringReport), adds and clears them.
 */

export interface ComponentRef { name: string; instance?: string; evse?: { id: number; connectorId?: number } }
export interface VariableRef { name: string; instance?: string }
export interface Attribute { type: string; value: string | null; mutability: string | null; persistent: boolean | null; constant: boolean | null }
export interface Characteristics { dataType: string; unit: string | null; minLimit: number | null; maxLimit: number | null; valuesList: string[] | null; supportsMonitoring: boolean }
export interface DeviceVariable {
  component: string; componentInstance: string; evseId: number; connectorId: number;
  variable: string; variableInstance: string; attributes: Attribute[]; characteristics: Characteristics | null;
}
export interface DeviceMonitor {
  monitorId: number; component: string; componentInstance: string; evseId: number; connectorId: number;
  variable: string; variableInstance: string; type: string; value: number; severity: number; transaction: boolean; kind: string | null;
}

export const ATTRIBUTE_TYPES = ['Actual', 'Target', 'MinSet', 'MaxSet'] as const;
export const MONITOR_TYPES = ['UpperThreshold', 'LowerThreshold', 'Delta', 'Periodic', 'PeriodicClockAligned'] as const;
export const REPORT_BASES = ['FullInventory', 'ConfigurationInventory', 'SummaryInventory'] as const;

const s = (v: unknown, max: number) => (v == null ? '' : String(v).slice(0, max));
const intOr0 = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Where a component/variable sits: its key fields. */
export function keyOf(c: ComponentRef | undefined, v: VariableRef | undefined) {
  return {
    component: s(c?.name, 50), componentInstance: s(c?.instance, 50),
    evseId: intOr0(c?.evse?.id), connectorId: intOr0(c?.evse?.connectorId),
    variable: s(v?.name, 50), variableInstance: s(v?.instance, 50),
  };
}
/** The wire form of a key (what GetVariables / SetVariables expect). */
export function refsOf(k: { component: string; componentInstance?: string; evseId?: number; connectorId?: number; variable: string; variableInstance?: string }): { component: ComponentRef; variable: VariableRef } {
  const component: ComponentRef = { name: k.component };
  if (k.componentInstance) component.instance = k.componentInstance;
  if (k.evseId) component.evse = k.connectorId ? { id: k.evseId, connectorId: k.connectorId } : { id: k.evseId };
  const variable: VariableRef = { name: k.variable };
  if (k.variableInstance) variable.instance = k.variableInstance;
  return { component, variable };
}
export const label = (k: { component: string; componentInstance?: string; evseId?: number; connectorId?: number; variable: string; variableInstance?: string }) =>
  `${k.component}${k.componentInstance ? `(${k.componentInstance})` : ''}${k.evseId ? `[EVSE ${k.evseId}${k.connectorId ? `/${k.connectorId}` : ''}]` : ''}.${k.variable}${k.variableInstance ? `(${k.variableInstance})` : ''}`;

/** NotifyReport.reportData → rows. Items without a component or variable name are dropped. */
export function parseReportData(items: unknown): DeviceVariable[] {
  if (!Array.isArray(items)) return [];
  const out: DeviceVariable[] = [];
  for (const it of items as any[]) {
    const k = keyOf(it?.component, it?.variable);
    if (!k.component || !k.variable) continue;
    const attrs: Attribute[] = (Array.isArray(it.variableAttribute) ? it.variableAttribute : []).slice(0, 4).map((a: any) => ({
      type: ATTRIBUTE_TYPES.includes(a?.type) ? a.type : 'Actual',
      value: a?.value == null ? null : s(a.value, 2500),
      mutability: ['ReadOnly', 'WriteOnly', 'ReadWrite'].includes(a?.mutability) ? a.mutability : 'ReadWrite',
      persistent: typeof a?.persistent === 'boolean' ? a.persistent : null,
      constant: typeof a?.constant === 'boolean' ? a.constant : null,
    }));
    const ch = it.variableCharacteristics;
    out.push({
      ...k,
      attributes: attrs,
      characteristics: ch && typeof ch === 'object' ? {
        dataType: s(ch.dataType, 20) || 'string', unit: ch.unit ? s(ch.unit, 16) : null,
        minLimit: num(ch.minLimit), maxLimit: num(ch.maxLimit),
        valuesList: ch.valuesList ? String(ch.valuesList).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200) : null,
        supportsMonitoring: ch.supportsMonitoring === true,
      } : null,
    });
  }
  return out;
}

/** NotifyMonitoringReport.monitor → monitors. */
export function parseMonitoringData(items: unknown): DeviceMonitor[] {
  if (!Array.isArray(items)) return [];
  const out: DeviceMonitor[] = [];
  for (const it of items as any[]) {
    const k = keyOf(it?.component, it?.variable);
    if (!k.component || !k.variable) continue;
    for (const m of Array.isArray(it.variableMonitoring) ? it.variableMonitoring : []) {
      if (!Number.isInteger(m?.id) || !MONITOR_TYPES.includes(m?.type) || !Number.isFinite(Number(m?.value))) continue;
      out.push({ ...k, monitorId: m.id, type: m.type, value: Number(m.value), severity: Math.min(9, Math.max(0, intOr0(m.severity))), transaction: m.transaction === true, kind: m.eventNotificationType ? s(m.eventNotificationType, 30) : null });
    }
  }
  return out;
}

/**
 * Variables the console must not change: security and network settings, which have
 * their own safe flows (Security tab, Onboarding) — a wrong value here strands the
 * station off the network.
 */
export function protectedVariable(component: string, variable: string): string | null {
  if (component === 'SecurityCtrlr') return `${component}.${variable} is changed from the Security tab, which enforces the safe order of operations.`;
  if (component === 'OCPPCommCtrlr' && /^NetworkConfigurationPriority$|^NetworkProfileConnectionAttempts$/.test(variable)) return `${component}.${variable} decides how the station reaches this CSMS; change it through Onboarding.`;
  if (component === 'NetworkConfiguration') return `${component}.${variable} is part of the station's connection profile; change it through Onboarding.`;
  if (/Password|PrivateKey|AuthorizationKey|BasicAuth/i.test(variable)) return `${component}.${variable} is a credential and is not set from the device model.`;
  return null;
}

/**
 * Is `value` acceptable for a variable with these characteristics? A null answer
 * means yes. Without characteristics (never reported) anything up to 1000 characters
 * goes and the station decides.
 */
export function valueProblem(ch: Characteristics | null, value: string): string | null {
  if (value.length > 1000) return 'At most 1000 characters.';
  if (!ch) return null;
  const inLimits = (n: number) =>
    ch.minLimit != null && n < ch.minLimit ? `At least ${ch.minLimit}.` : ch.maxLimit != null && n > ch.maxLimit ? `At most ${ch.maxLimit}.` : null;
  switch (ch.dataType) {
    case 'integer': return /^-?\d+$/.test(value) ? inLimits(Number(value)) : 'A whole number.';
    case 'decimal': return /^-?\d+(\.\d+)?$/.test(value) ? inLimits(Number(value)) : 'A number (use a dot for decimals).';
    case 'boolean': return /^(true|false)$/.test(value) ? null : 'true or false.';
    case 'dateTime': return Number.isNaN(Date.parse(value)) || !/^\d{4}-\d{2}-\d{2}T/.test(value) ? 'A date and time, e.g. 2026-10-01T00:00:00Z.' : null;
    case 'OptionList': return ch.valuesList && !ch.valuesList.includes(value) ? `One of: ${ch.valuesList.join(', ')}.` : null;
    case 'MemberList':
    case 'SequenceList': {
      const parts = value.split(',').map((x) => x.trim()).filter(Boolean);
      const bad = ch.valuesList ? parts.filter((p) => !ch.valuesList!.includes(p)) : [];
      if (ch.dataType === 'MemberList' && new Set(parts).size !== parts.length) return 'Each value once.';
      return bad.length ? `Not allowed: ${bad.join(', ')} (choose from ${ch.valuesList!.join(', ')}).` : null;
    }
    default: {
      const n = ch.maxLimit != null ? ch.maxLimit : null;
      return n != null && value.length > n ? `At most ${n} characters.` : null;
    }
  }
}

/** A new monitor from the console: type, value and severity checked. */
export function monitorProblem(m: { type?: unknown; value?: unknown; severity?: unknown }): string | null {
  if (!MONITOR_TYPES.includes(m.type as any)) return `The monitor type is one of ${MONITOR_TYPES.join(', ')}.`;
  if (!Number.isFinite(Number(m.value))) return 'The value is a number (a threshold, a change, or seconds between readings).';
  if ((m.type === 'Periodic' || m.type === 'PeriodicClockAligned') && Number(m.value) <= 0) return 'The interval is a number of seconds above 0.';
  const sev = Number(m.severity);
  if (!Number.isInteger(sev) || sev < 0 || sev > 9) return 'Severity is 0 (danger) to 9 (debug).';
  return null;
}

// ─────────────────────────────────────────── storage (gateway: reports from the station)

export const newRequestId = () => 1 + Math.floor(Math.random() * 2_000_000_000);

/** One part of a NotifyReport: store its variables, and move the report on. */
export async function storeReport(cpId: string, orgId: string, p: { requestId?: unknown; seqNo?: unknown; tbc?: unknown; reportData?: unknown }) {
  const rows = parseReportData(p.reportData);
  const requestId = Number(p.requestId);
  await tx(async (c) => {
    for (const r of rows) {
      await c.query(
        `INSERT INTO device_variable (org_id, charge_point_id, component, component_instance, evse_id, connector_id, variable, variable_instance, attributes, characteristics, reported_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (charge_point_id, component, component_instance, evse_id, connector_id, variable, variable_instance)
         DO UPDATE SET attributes = EXCLUDED.attributes, characteristics = COALESCE(EXCLUDED.characteristics, device_variable.characteristics), reported_at = now()`,
        [orgId, cpId, r.component, r.componentInstance, r.evseId, r.connectorId, r.variable, r.variableInstance, JSON.stringify(r.attributes), r.characteristics ? JSON.stringify(r.characteristics) : null]);
    }
    if (Number.isInteger(requestId)) {
      await c.query(
        `UPDATE device_report SET items = items + $3, status = CASE WHEN $4 THEN 'receiving' ELSE 'complete' END,
                completed_at = CASE WHEN $4 THEN NULL ELSE now() END
          WHERE charge_point_id = $1 AND request_id = $2 AND kind = 'base'`,
        [cpId, requestId, rows.length, p.tbc === true]);
    }
  });
  return rows.length;
}

/** One part of a NotifyMonitoringReport. The first part of a report we asked for replaces what was known. */
export async function storeMonitoringReport(cpId: string, orgId: string, p: { requestId?: unknown; seqNo?: unknown; tbc?: unknown; monitor?: unknown }) {
  const mons = parseMonitoringData(p.monitor);
  const requestId = Number(p.requestId);
  await tx(async (c) => {
    const ours = Number.isInteger(requestId)
      ? (await c.query(`SELECT 1 FROM device_report WHERE charge_point_id = $1 AND request_id = $2 AND kind = 'monitoring'`, [cpId, requestId])).rows[0]
      : null;
    if (ours && Number(p.seqNo) === 0) await c.query(`DELETE FROM device_monitor WHERE charge_point_id = $1`, [cpId]);
    for (const m of mons) {
      await upsertMonitor(cpId, orgId, m, c);
    }
    if (ours) {
      await c.query(
        `UPDATE device_report SET items = items + $3, status = CASE WHEN $4 THEN 'receiving' ELSE 'complete' END, completed_at = CASE WHEN $4 THEN NULL ELSE now() END
          WHERE charge_point_id = $1 AND request_id = $2 AND kind = 'monitoring'`,
        [cpId, requestId, mons.length, p.tbc === true]);
    }
  });
  return mons.length;
}

async function upsertMonitor(cpId: string, orgId: string, m: DeviceMonitor, c?: { query: (t: string, p: unknown[]) => Promise<unknown> }) {
  await (c ? c.query.bind(c) : query)(
    `INSERT INTO device_monitor (org_id, charge_point_id, monitor_id, component, component_instance, evse_id, connector_id, variable, variable_instance, type, value, severity, in_transaction, kind, reported_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
     ON CONFLICT (charge_point_id, monitor_id) DO UPDATE SET component = EXCLUDED.component, component_instance = EXCLUDED.component_instance,
       evse_id = EXCLUDED.evse_id, connector_id = EXCLUDED.connector_id, variable = EXCLUDED.variable, variable_instance = EXCLUDED.variable_instance,
       type = EXCLUDED.type, value = EXCLUDED.value, severity = EXCLUDED.severity, in_transaction = EXCLUDED.in_transaction, kind = COALESCE(EXCLUDED.kind, device_monitor.kind), reported_at = now()`,
    [orgId, cpId, m.monitorId, m.component, m.componentInstance, m.evseId, m.connectorId, m.variable, m.variableInstance, m.type, m.value, m.severity, m.transaction, m.kind]);
}

// ─────────────────────────────────────────── the console

export async function deviceModel(cpId: string) {
  // Reports first: a report read as complete has all its parts committed, so the
  // variables read after it include them (reading them first could miss the last part).
  const reports = await many<any>(`SELECT request_id, kind, report_base, status, items, requested_by, requested_at, completed_at, note FROM device_report WHERE charge_point_id = $1 ORDER BY requested_at DESC LIMIT 10`, [cpId]);
  const vars = await many<any>(`SELECT * FROM device_variable WHERE charge_point_id = $1 ORDER BY component, component_instance, evse_id, connector_id, variable, variable_instance`, [cpId]);
  const mons = await many<any>(`SELECT * FROM device_monitor WHERE charge_point_id = $1 ORDER BY component, variable, monitor_id`, [cpId]);
  // Grouped by component (name, instance, EVSE, connector), variables inside.
  const comps = new Map<string, any>();
  for (const v of vars) {
    const key = `${v.component}|${v.component_instance}|${v.evse_id}|${v.connector_id}`;
    if (!comps.has(key)) comps.set(key, { name: v.component, instance: v.component_instance || null, evseId: v.evse_id || null, connectorId: v.connector_id || null, variables: [] });
    comps.get(key).variables.push({
      name: v.variable, instance: v.variable_instance || null, attributes: v.attributes, characteristics: v.characteristics, reportedAt: v.reported_at,
      protected: !!protectedVariable(v.component, v.variable),
    });
  }
  return {
    components: [...comps.values()],
    variables: vars.length,
    monitors: mons.map((m) => ({
      id: m.monitor_id, component: m.component, componentInstance: m.component_instance || null, evseId: m.evse_id || null, connectorId: m.connector_id || null,
      variable: m.variable, variableInstance: m.variable_instance || null, type: m.type, value: Number(m.value), severity: m.severity, transaction: m.in_transaction, kind: m.kind, reportedAt: m.reported_at,
    })),
    reports: reports.map((r) => ({ requestId: r.request_id, kind: r.kind, reportBase: r.report_base, status: r.status, items: r.items, requestedBy: r.requested_by, requestedAt: r.requested_at, completedAt: r.completed_at, note: r.note })),
  };
}

export async function stored(cpId: string, k: ReturnType<typeof keyOf>) {
  return one<any>(
    `SELECT * FROM device_variable WHERE charge_point_id = $1 AND component = $2 AND component_instance = $3 AND evse_id = $4 AND connector_id = $5 AND variable = $6 AND variable_instance = $7`,
    [cpId, k.component, k.componentInstance, k.evseId, k.connectorId, k.variable, k.variableInstance]);
}

/** Record what the station answered for GetVariables / an accepted SetVariables: the attribute's new value. */
export async function recordValue(cpId: string, orgId: string, k: ReturnType<typeof keyOf>, attributeType: string, value: string | null) {
  const cur = await stored(cpId, k);
  const attrs: Attribute[] = Array.isArray(cur?.attributes) ? cur.attributes : [];
  const i = attrs.findIndex((a) => a.type === attributeType);
  if (i >= 0) attrs[i] = { ...attrs[i]!, value };
  else attrs.push({ type: attributeType, value, mutability: null, persistent: null, constant: null });
  await query(
    `INSERT INTO device_variable (org_id, charge_point_id, component, component_instance, evse_id, connector_id, variable, variable_instance, attributes, reported_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (charge_point_id, component, component_instance, evse_id, connector_id, variable, variable_instance) DO UPDATE SET attributes = EXCLUDED.attributes, reported_at = now()`,
    [orgId, cpId, k.component, k.componentInstance, k.evseId, k.connectorId, k.variable, k.variableInstance, JSON.stringify(attrs)]);
}

/**
 * Recorded BEFORE the request goes out: a quick station sends its first NotifyReport
 * before it has even answered GetBaseReport, and that part must find its report. Committed on its
 * own (outside the request's transaction), or the gateway could not see it yet.
 */
export async function startReportRequest(cpId: string, orgId: string, requestId: number, kind: 'base' | 'monitoring', reportBase: string | null, by: string) {
  await outsideRequestScope(() => query(
    `INSERT INTO device_report (org_id, charge_point_id, request_id, kind, report_base, status, requested_by) VALUES ($1,$2,$3,$4,$5,'requested',$6)`,
    [orgId, cpId, requestId, kind, reportBase, by]));
}
/** The station's answer (or its silence: status null) to the request. Returns where the report stands. */
export async function answerReportRequest(cpId: string, requestId: number, status: string | null) {
  const st = status === 'Accepted' ? null : status === 'EmptyResultSet' ? 'empty' : 'rejected';
  if (st) {
    await outsideRequestScope(() => query(
      `UPDATE device_report SET status = $3, note = $4, completed_at = now() WHERE charge_point_id = $1 AND request_id = $2 AND status = 'requested'`,
      [cpId, requestId, st, st === 'rejected' ? (status ? `The station answered ${status}.` : 'The station did not answer.') : null]));
  }
  const r = await outsideRequestScope(() => one<{ status: string }>(`SELECT status FROM device_report WHERE charge_point_id = $1 AND request_id = $2`, [cpId, requestId]));
  return r?.status ?? st ?? 'requested';
}

export async function saveMonitor(cpId: string, orgId: string, m: DeviceMonitor) { await upsertMonitor(cpId, orgId, m); }
export async function dropMonitor(cpId: string, monitorId: number) { await query(`DELETE FROM device_monitor WHERE charge_point_id = $1 AND monitor_id = $2`, [cpId, monitorId]); }

export function logReport(identity: string, what: string, n: number) { logger.info({ cp: identity, items: n }, what); }
