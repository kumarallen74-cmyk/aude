import { many, one, outsideRequestScope, query, tx } from '../db/pool.js';
import { persistAlert } from './alerts.js';
import * as credit from './driver-credit.js';

/**
 * Warranty and RMA (v1.49.0), Assets & energy → Warranty & RMA. What each charger's manufacturer covers, and the parts
 * sent back to them:
 *
 *   warranties  per charger: the supplier, from and to, what it covers (parts, labour, shipping, on-site), the
 *               manufacturer's reference; an extension is another row. A charger shows covered, expiring (within 60
 *               days), expired or none. warranty.expiring is raised once per warranty, 60 days before it ends
 *   RMA cases   a faulty charger or part returned: open → requested (from the manufacturer) → approved → shipped (the
 *               faulty part, with its tracking) → replaced (the replacement received, its serial) → closed; or
 *               rejected. Whether it is in warranty is worked out from the charger's warranty on the day it is
 *               opened; out of warranty, the manufacturer's charge is recorded. Linked to its work order, where the
 *               money recovered is claimed (Finance → Maintenance costs, warranty claims). rma.stale when a case
 *               waits on the manufacturer (requested, approved or shipped) 14 days, then weekly
 */

export class WarrantyError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const EXPIRING_ALERT = 'warranty.expiring';
export const STALE_ALERT = 'rma.stale';
export const COVERS = ['parts', 'labour', 'shipping', 'on_site'] as const;
export const RMA_FLOW: Record<string, string[]> = {
  open: ['requested', 'rejected'], requested: ['approved', 'rejected'], approved: ['shipped', 'rejected'], shipped: ['replaced', 'rejected'], replaced: ['closed'],
};
const WAITING = ['requested', 'approved', 'shipped'];
const S = <T>(fn: () => T) => outsideRequestScope(fn);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, max: number) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
/** A DATE column as YYYY-MM-DD: node-postgres parses DATE as local midnight, so read the local parts (toISOString would shift it a day east of UTC). */
const d = (v: any) => (v == null ? null : typeof v === 'string' ? v.slice(0, 10) : v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);
const daysTo = (iso: string) => Math.round((new Date(`${iso}T00:00:00Z`).getTime() - new Date(`${today()}T00:00:00Z`).getTime()) / 86_400_000);

/** covered (more than 60 days left), expiring (60 days or less), expired, none. */
export function coverageState(endsOn: string | null): 'covered' | 'expiring' | 'expired' | 'none' {
  if (!endsOn) return 'none';
  const n = daysTo(endsOn);
  return n < 0 ? 'expired' : n <= 60 ? 'expiring' : 'covered';
}

// ------------------------------------------------------------------ warranties

const wOf = (w: any) => ({
  id: String(w.id), chargePointId: w.charge_point_id, supplierId: w.supplier_id == null ? null : String(w.supplier_id), supplier: w.supplier_name ?? null,
  startsOn: d(w.starts_on), endsOn: d(w.ends_on), covers: w.covers ?? [], terms: w.terms ?? null, reference: w.reference ?? null, extended: !!w.extended,
  state: coverageState(d(w.ends_on)), daysLeft: daysTo(d(w.ends_on)!),
});

/** Every charger with its warranty now (the one ending last), and its open RMA cases. */
export async function chargers(orgId: string, q: Record<string, unknown> = {}) {
  const rows = await S(() => many<any>(`SELECT cp.id, COALESCE(cp.display_name, cp.ocpp_identity) AS name, cp.vendor, cp.model, cp.serial, s.name AS site,
      w.id AS w_id, w.ends_on, w.starts_on, w.covers, w.extended, sp.name AS supplier_name,
      (SELECT count(*) FROM rma_case r WHERE r.charge_point_id = cp.id AND r.status NOT IN ('closed', 'rejected')) AS rma_open
    FROM charge_point cp JOIN site s ON s.id = cp.site_id
    LEFT JOIN LATERAL (SELECT * FROM charger_warranty w WHERE w.charge_point_id = cp.id AND w.removed_at IS NULL ORDER BY w.ends_on DESC LIMIT 1) w ON true
    LEFT JOIN supplier sp ON sp.id = w.supplier_id
    WHERE s.org_id = $1 AND cp.status <> 'decommissioned' ORDER BY w.ends_on NULLS FIRST, s.name, name LIMIT 5000`, [orgId]));
  const list = rows.map((r) => ({
    id: r.id, name: r.name, site: r.site ?? null, vendor: r.vendor ?? null, model: r.model ?? null, serial: r.serial ?? null,
    warrantyId: r.w_id == null ? null : String(r.w_id), supplier: r.supplier_name ?? null, startsOn: d(r.starts_on), endsOn: d(r.ends_on), covers: r.covers ?? [], extended: !!r.extended,
    state: coverageState(d(r.ends_on)), daysLeft: r.ends_on ? daysTo(d(r.ends_on)!) : null, rmaOpen: Number(r.rma_open),
  }));
  const state = q.state ? String(q.state) : null;
  const counts = { covered: 0, expiring: 0, expired: 0, none: 0 } as Record<string, number>;
  for (const c of list) counts[c.state]!++;
  return { chargers: state ? list.filter((c) => c.state === state) : list, counts };
}

export async function chargerWarranties(orgId: string, chargePointId: string) {
  if (!UUID_RE.test(chargePointId)) throw new WarrantyError(404, 'No such charger.');
  const rows = await S(() => many<any>(`SELECT w.*, sp.name AS supplier_name FROM charger_warranty w LEFT JOIN supplier sp ON sp.id = w.supplier_id
    WHERE w.org_id = $1 AND w.charge_point_id = $2 AND w.removed_at IS NULL ORDER BY w.ends_on DESC`, [orgId, chargePointId]));
  return rows.map(wOf);
}

export async function saveWarranty(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await S(() => one<any>(`SELECT * FROM charger_warranty WHERE id = $1 AND org_id = $2 AND removed_at IS NULL`, [Number(id) || 0, orgId])) : null;
  if (id && !cur) throw new WarrantyError(404, 'No such warranty.');
  if (cur && b.remove === true) { await S(() => query(`UPDATE charger_warranty SET removed_at = now() WHERE id = $1`, [cur.id])); return { id: String(cur.id), removed: true }; }
  const cp = String(b.chargePointId ?? cur?.charge_point_id ?? '');
  if (!UUID_RE.test(cp) || !(await S(() => one(`SELECT 1 FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE cp.id = $1 AND s.org_id = $2`, [cp, orgId])))) throw new WarrantyError(422, 'Choose the charger.');
  const sup = b.supplierId === undefined ? cur?.supplier_id ?? null : b.supplierId ? Number(b.supplierId) : null;
  if (sup && !(await S(() => one(`SELECT 1 FROM supplier WHERE id = $1 AND org_id = $2`, [sup, orgId])))) throw new WarrantyError(422, 'No such supplier.');
  const starts = String(b.startsOn ?? d(cur?.starts_on) ?? ''), ends = String(b.endsOn ?? d(cur?.ends_on) ?? '');
  if (!DATE_RE.test(starts) || !DATE_RE.test(ends)) throw new WarrantyError(422, 'startsOn and endsOn are dates (YYYY-MM-DD).');
  if (ends < starts) throw new WarrantyError(422, 'The warranty ends before it starts.');
  const covers = b.covers === undefined ? cur?.covers ?? ['parts'] : Array.isArray(b.covers) ? [...new Set(b.covers.map(String))] : [];
  if (!covers.length || covers.some((c: string) => !(COVERS as readonly string[]).includes(c))) throw new WarrantyError(422, `covers is one or more of ${COVERS.join(', ')}.`);
  const vals = [cp, sup, starts, ends, covers, b.terms === undefined ? cur?.terms ?? null : str(b.terms, 1000), b.reference === undefined ? cur?.reference ?? null : str(b.reference, 80), b.extended === undefined ? !!cur?.extended : b.extended === true];
  const r = cur
    ? await S(() => one<any>(`UPDATE charger_warranty SET charge_point_id = $2, supplier_id = $3, starts_on = $4, ends_on = $5, covers = $6, terms = $7, reference = $8, extended = $9,
        expiry_alerted_at = CASE WHEN ends_on <> $5::date THEN NULL ELSE expiry_alerted_at END WHERE id = $1 RETURNING *`, [cur.id, ...vals]))
    : await S(() => one<any>(`INSERT INTO charger_warranty (org_id, charge_point_id, supplier_id, starts_on, ends_on, covers, terms, reference, extended) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [orgId, ...vals]));
  return wOf(r);
}

/** The warranty covering this charger on that day, if any. */
export async function coverOn(orgId: string, chargePointId: string, on: string) {
  return S(() => one<any>(`SELECT * FROM charger_warranty WHERE org_id = $1 AND charge_point_id = $2 AND removed_at IS NULL AND starts_on <= $3::date AND ends_on >= $3::date
    ORDER BY ends_on DESC LIMIT 1`, [orgId, chargePointId, on]));
}

// ------------------------------------------------------------------ RMA cases

const rOf = (r: any) => ({
  id: String(r.id), number: r.number, chargePointId: r.charge_point_id, charger: r.cp_name ?? null, site: r.site_name ?? null,
  supplierId: r.supplier_id == null ? null : String(r.supplier_id), supplier: r.supplier_name ?? null, warrantyId: r.warranty_id == null ? null : String(r.warranty_id),
  workOrderId: r.work_order_id == null ? null : String(r.work_order_id), workOrder: r.wo_number ?? null,
  part: r.part, partSerial: r.part_serial ?? null, fault: r.fault, status: r.status, inWarranty: r.in_warranty, vendorRef: r.vendor_ref ?? null,
  trackingOut: r.tracking_out ?? null, trackingBack: r.tracking_back ?? null, replacementSerial: r.replacement_serial ?? null,
  costMinor: r.cost_minor == null ? null : Number(r.cost_minor), currency: r.currency, outcome: r.outcome ?? null, history: r.history ?? [],
  statusSince: new Date(r.status_since).toISOString(), daysInStatus: Math.floor((Date.now() - new Date(r.status_since).getTime()) / 86_400_000),
  createdAt: new Date(r.created_at).toISOString(),
});
const R_SELECT = `SELECT r.*, COALESCE(cp.display_name, cp.ocpp_identity) AS cp_name, s.name AS site_name, sp.name AS supplier_name, wo.number AS wo_number
  FROM rma_case r JOIN charge_point cp ON cp.id = r.charge_point_id LEFT JOIN site s ON s.id = cp.site_id LEFT JOIN supplier sp ON sp.id = r.supplier_id
  LEFT JOIN work_order wo ON wo.id = r.work_order_id`;

export async function rmas(orgId: string, q: Record<string, unknown> = {}) {
  const all = q.status === 'all';
  const rows = (await S(() => many<any>(`${R_SELECT} WHERE r.org_id = $1 AND ($2 OR r.status NOT IN ('closed', 'rejected') OR r.status_since > now() - interval '60 days')
    AND ($3::uuid IS NULL OR r.charge_point_id = $3) ORDER BY r.created_at DESC LIMIT 1000`, [orgId, all, q.chargePointId && UUID_RE.test(String(q.chargePointId)) ? String(q.chargePointId) : null]))).map(rOf);
  const k = await S(() => one<any>(`SELECT count(*) FILTER (WHERE status NOT IN ('closed', 'rejected')) AS open,
      count(*) FILTER (WHERE status IN ('requested', 'approved', 'shipped')) AS waiting,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ((history->-1->>'at')::timestamptz - created_at)) / 86400) FILTER (WHERE status = 'closed' AND created_at > now() - interval '365 days') AS turnaround,
      count(*) FILTER (WHERE status = 'rejected' AND created_at > now() - interval '365 days') AS rejected,
      COALESCE(sum(cost_minor) FILTER (WHERE created_at > now() - interval '365 days'), 0) AS cost
    FROM rma_case WHERE org_id = $1`, [orgId]));
  return { cases: rows, kpis: { open: Number(k?.open ?? 0), waitingOnManufacturer: Number(k?.waiting ?? 0), medianTurnaroundDays: k?.turnaround == null ? null : Math.round(Number(k.turnaround)),
    rejected12m: Number(k?.rejected ?? 0), outOfWarrantyCost12mMinor: Number(k?.cost ?? 0) } };
}

async function rRow(orgId: string, id: string) {
  const r = await S(() => one<any>(`${R_SELECT} WHERE r.id = $1 AND r.org_id = $2`, [Number(id) || 0, orgId]));
  if (!r) throw new WarrantyError(404, 'No such RMA case.');
  return r;
}
export const getRma = async (orgId: string, id: string) => rOf(await rRow(orgId, id));

export async function openRma(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cp = String(b.chargePointId ?? '');
  if (!UUID_RE.test(cp) || !(await S(() => one(`SELECT 1 FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE cp.id = $1 AND s.org_id = $2`, [cp, orgId])))) throw new WarrantyError(422, 'Choose the charger.');
  const part = str(b.part, 120), fault = str(b.fault, 2000);
  if (!part) throw new WarrantyError(422, 'Say what is returned (the charger, a power module, a cable …).');
  if (!fault) throw new WarrantyError(422, 'Describe the fault.');
  const w = await coverOn(orgId, cp, today());
  const sup = b.supplierId ? Number(b.supplierId) : w?.supplier_id ?? null;
  if (sup && !(await S(() => one(`SELECT 1 FROM supplier WHERE id = $1 AND org_id = $2`, [sup, orgId])))) throw new WarrantyError(422, 'No such supplier.');
  const wo = b.workOrderId ? Number(b.workOrderId) : null;
  if (wo && !(await S(() => one(`SELECT 1 FROM work_order WHERE id = $1 AND org_id = $2`, [wo, orgId])))) throw new WarrantyError(422, 'No such work order.');
  const { currency } = await credit.settings(orgId);
  const created = await S(() => tx(async (c) => {
    const n = (await c.query(`SELECT count(*) + 1 AS n FROM rma_case WHERE org_id = $1`, [orgId])).rows[0].n;
    const r = (await c.query(`INSERT INTO rma_case (org_id, number, charge_point_id, supplier_id, warranty_id, work_order_id, part, part_serial, fault, in_warranty, currency, history, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [orgId, `RMA-${String(n).padStart(4, '0')}`, cp, sup, w?.id ?? null, wo, part, str(b.partSerial, 80), fault, !!w, currency,
      JSON.stringify([{ at: new Date().toISOString(), status: 'open', by: userId, note: w ? `In warranty until ${d(w.ends_on)}.` : 'Out of warranty.' }]), userId])).rows[0];
    return String(r.id);
  }));
  return getRma(orgId, created);
}

/** Change a case's details, or move it on (status, with the fields that step records and a note). */
export async function updateRma(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  const r = await rRow(orgId, id);
  const to = b.status === undefined || b.status === r.status ? null : String(b.status);
  if (to && !(RMA_FLOW[r.status] ?? []).includes(to)) throw new WarrantyError(409, `A case that is ${r.status} cannot move to ${to}.`);
  const f = (k: string, col: string, max: number) => (b[k] === undefined ? r[col] : str(b[k], max));
  const vendorRef = f('vendorRef', 'vendor_ref', 80), trackingOut = f('trackingOut', 'tracking_out', 80), trackingBack = f('trackingBack', 'tracking_back', 80);
  const replacement = f('replacementSerial', 'replacement_serial', 80), outcome = f('outcome', 'outcome', 500);
  const cost = b.costMinor === undefined ? r.cost_minor : b.costMinor === null || b.costMinor === '' ? null : Number(b.costMinor);
  if (cost != null && !(Number.isSafeInteger(Number(cost)) && Number(cost) >= 0)) throw new WarrantyError(422, 'costMinor is a whole amount.');
  if (to === 'approved' && !vendorRef) throw new WarrantyError(422, 'Record the manufacturer\'s RMA number (vendorRef).');
  if (to === 'shipped' && !trackingOut) throw new WarrantyError(422, 'Record the shipment\'s tracking number (trackingOut).');
  if (to === 'replaced' && !replacement) throw new WarrantyError(422, 'Record the replacement\'s serial number.');
  if (to === 'rejected' && !outcome) throw new WarrantyError(422, 'Say why it was rejected (outcome).');
  const note = str(b.note, 500);
  const history = to || note ? [...(r.history ?? []), { at: new Date().toISOString(), status: to ?? r.status, by: userId, note }] : r.history;
  await S(() => query(`UPDATE rma_case SET status = $2, vendor_ref = $3, tracking_out = $4, tracking_back = $5, replacement_serial = $6, cost_minor = $7, outcome = $8, history = $9,
      status_since = CASE WHEN $2 <> status THEN now() ELSE status_since END, stale_alerted_at = CASE WHEN $2 <> status THEN NULL ELSE stale_alerted_at END WHERE id = $1`,
  [r.id, to ?? r.status, vendorRef, trackingOut, trackingBack, replacement, cost, outcome, JSON.stringify(history)]));
  if (to === 'replaced' && b.updateChargerSerial === true && r.part.toLowerCase().includes('charger')) {
    await S(() => query(`UPDATE charge_point SET serial = $2 WHERE id = $1`, [r.charge_point_id, replacement]));
  }
  // A new step is progress: the stale alert is resolved (raised again if it waits 14 days at the new step).
  if (to) {
    await S(() => query(`UPDATE alert SET resolved_at = now() WHERE org_id = $1 AND kind = $2 AND target_type = 'rma_case' AND target_id = $3 AND resolved_at IS NULL`, [orgId, STALE_ALERT, String(r.id)]));
  }
  return getRma(orgId, id);
}

// ------------------------------------------------------------------ the worker

export async function sweep(): Promise<{ expiring: number; stale: number }> {
  const exp = await S(() => many<any>(`SELECT w.*, COALESCE(cp.display_name, cp.ocpp_identity) AS cp_name, to_char(w.ends_on, 'YYYY-MM-DD') AS ends FROM charger_warranty w
      JOIN charge_point cp ON cp.id = w.charge_point_id
    WHERE w.removed_at IS NULL AND w.expiry_alerted_at IS NULL AND w.ends_on BETWEEN current_date AND current_date + 60 AND cp.status <> 'decommissioned'
      AND NOT EXISTS (SELECT 1 FROM charger_warranty x WHERE x.charge_point_id = w.charge_point_id AND x.removed_at IS NULL AND x.ends_on > w.ends_on)`));
  for (const w of exp) {
    await S(() => persistAlert({ orgId: w.org_id, kind: EXPIRING_ALERT, severity: 'info', targetType: 'charge_point', targetId: w.charge_point_id,
      message: `The warranty of ${w.cp_name} ends on ${w.ends}: extend it or plan for repairs at cost.` } as any)).catch(() => null);
    await S(() => query(`UPDATE charger_warranty SET expiry_alerted_at = now() WHERE id = $1`, [w.id]));
  }
  const stale = await S(() => many<any>(`SELECT r.*, sp.name AS supplier_name FROM rma_case r LEFT JOIN supplier sp ON sp.id = r.supplier_id
    WHERE r.status = ANY($1) AND r.status_since < now() - interval '14 days' AND (r.stale_alerted_at IS NULL OR r.stale_alerted_at < now() - interval '7 days')`, [WAITING]));
  for (const r of stale) {
    await S(() => persistAlert({ orgId: r.org_id, kind: STALE_ALERT, severity: 'warning', targetType: 'rma_case', targetId: String(r.id),
      message: `${r.number} has been ${r.status} for ${Math.floor((Date.now() - new Date(r.status_since).getTime()) / 86_400_000)} days${r.supplier_name ? ` with ${r.supplier_name}` : ''}: chase the manufacturer.` } as any)).catch(() => null);
    await S(() => query(`UPDATE rma_case SET stale_alerted_at = now() WHERE id = $1`, [r.id]));
  }
  return { expiring: exp.length, stale: stale.length };
}
