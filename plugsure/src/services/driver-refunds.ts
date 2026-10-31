import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { markRefundDue } from './refunds.js';
import { moneyText, currencyOr } from '../domain/money.js';

/**
 * Driver refund requests (v1.24.0). From a charge's receipt in the app, a driver asks for money back:
 *
 *   unused_balance    paid more than the session used (a prepurchase) and nothing came back yet
 *   charging_failed   paid and the charge never started or stopped at once
 *   overcharged       the amount looks wrong
 *   other             anything else (always reviewed)
 *
 * The amount is at most what is refundable on the payment: captured − what the session's charge record took −
 * what was already refunded. The operator's policy (Finance → Settings → Driver refunds) approves a request
 * automatically when it is unused_balance or charging_failed, within the refundable amount and up to the amount set;
 * every other request waits in Refunds → Driver requests, alerted (finance.driver_refund_request). An approved
 * request marks the payment's refund due (services/refunds.ts): the existing refund queue pays it (gateway, bank
 * transfer or disbursement, with its approvals). One open request per payment; the driver sees its state on the receipt.
 * The driver's messages are Indonesian, with their English in driver/i18n.ts (the app's language decides).
 */

export class DriverRefundError extends Error {
  constructor(public statusCode: number, message: string, public code?: string) { super(message); }
}

export const REASONS = ['unused_balance', 'charging_failed', 'overcharged', 'other'] as const;
const KIND = 'finance.driver_refund_request';
const AUTO_REASONS = new Set(['unused_balance', 'charging_failed']);

export interface Policy { enabled: boolean; autoApproveUpTo: number; windowDays: number }

export async function policy(orgId: string): Promise<Policy> {
  const r = await outsideRequestScope(() => one<{ driver_refund_policy: any }>(`SELECT driver_refund_policy FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const v = r?.driver_refund_policy ?? {};
  return { enabled: v.enabled !== false, autoApproveUpTo: Number(v.autoApproveUpTo ?? 0), windowDays: Number(v.windowDays ?? 30) };
}

export async function savePolicy(orgId: string, b: Record<string, unknown>, userId: string | null): Promise<Policy> {
  const cur = await policy(orgId);
  const autoApproveUpTo = b.autoApproveUpTo == null || b.autoApproveUpTo === '' ? cur.autoApproveUpTo : Number(b.autoApproveUpTo);
  const windowDays = b.windowDays == null || b.windowDays === '' ? cur.windowDays : Number(b.windowDays);
  if (!Number.isInteger(autoApproveUpTo) || autoApproveUpTo < 0) throw new DriverRefundError(422, 'Approve automatically up to: a whole number of the minor unit, 0 or more (0: review every request).');
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) throw new DriverRefundError(422, 'Drivers can ask within 1 to 365 days of the payment.');
  const v = { enabled: b.enabled === undefined ? cur.enabled : b.enabled === true, autoApproveUpTo, windowDays };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, driver_refund_policy, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET driver_refund_policy = EXCLUDED.driver_refund_policy, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

/** What can still go back on a payment: captured − the session's charge − already refunded or due. */
export async function refundable(intentId: string) {
  const r = await outsideRequestScope(() => one<any>(
    `SELECT pi.id, pi.org_id, pi.state, pi.currency, pi.paid_at, pi.created_at, pi.refund_state,
            COALESCE(pi.amount_captured_minor, 0)::bigint AS captured, COALESCE(pi.refunded_minor, 0)::bigint AS refunded, COALESCE(pi.refund_due_minor, 0)::bigint AS due,
            (SELECT COALESCE(sum(d.total_minor), 0) FROM cdr d JOIN charging_session cs ON cs.id = d.session_id WHERE cs.payment_intent_id = pi.id)::bigint AS used,
            (SELECT COALESCE(max(cs.energy_wh), 0) FROM charging_session cs WHERE cs.payment_intent_id = pi.id)::bigint AS wh
       FROM payment_intent pi WHERE pi.id = $1`, [intentId]));
  if (!r) return null;
  const left = Math.max(0, Number(r.captured) - Number(r.used) - Math.max(Number(r.refunded), r.refund_state ? Number(r.due) : 0));
  return { ...r, captured: Number(r.captured), used: Number(r.used), wh: Number(r.wh), refundable: left };
}

const view = (r: any) => ({
  id: String(r.id), paymentId: r.payment_intent_id, reason: r.reason, message: r.message ?? null, amount: Number(r.amount_minor), currency: r.currency,
  state: r.state, auto: r.auto, decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null, decidedBy: r.decided_by_name ?? null, note: r.decision_note ?? null,
  createdAt: new Date(r.created_at).toISOString(), refundState: r.refund_state ?? null,
  site: r.site_name ?? undefined, paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : undefined, captured: r.captured == null ? undefined : Number(r.captured),
});

/** The latest request on a payment (the driver's receipt). */
export async function forPayment(intentId: string) {
  const r = await outsideRequestScope(() => one<any>(
    `SELECT q.*, pi.refund_state FROM driver_refund_request q JOIN payment_intent pi ON pi.id = q.payment_intent_id WHERE q.payment_intent_id = $1 ORDER BY q.id DESC LIMIT 1`, [intentId]));
  return r ? view(r) : null;
}

/** A driver's request on its own charge (ownership is checked by the caller: driver/charge.ts ownedCharge). */
export async function request(charge: { id: string; payment_intent_id: string | null; device_id: string | null; app_driver_id: string | null; mode: string },
  b: Record<string, unknown>, now = new Date()) {
  if (!charge.payment_intent_id || charge.mode === 'fleet') throw new DriverRefundError(409, 'Pengisian ini tidak dibayar di aplikasi: hubungi pengelola armada Anda.', 'not_paid_in_app');
  const reason = String(b.reason ?? '');
  if (!(REASONS as readonly string[]).includes(reason)) throw new DriverRefundError(422, 'Pilih alasan pengembalian dana.');
  const message = b.message == null || b.message === '' ? null : String(b.message).trim().slice(0, 1000);
  if ((reason === 'overcharged' || reason === 'other') && (!message || message.length < 10)) throw new DriverRefundError(422, 'Ceritakan apa yang salah (minimal 10 karakter).');
  const p = await refundable(charge.payment_intent_id);
  if (!p || p.state !== 'captured') throw new DriverRefundError(409, 'Pembayaran ini tidak ditagih: tidak ada yang perlu dikembalikan.', 'not_captured');
  const pol = await policy(p.org_id);
  if (!pol.enabled) throw new DriverRefundError(409, 'Permintaan pengembalian dana tidak diterima di aplikasi: hubungi operator.', 'disabled');
  const paidAt = new Date(p.paid_at ?? p.created_at);
  if (now.getTime() - paidAt.getTime() > pol.windowDays * 86_400_000) throw new DriverRefundError(409, `Permintaan diterima paling lambat ${pol.windowDays} hari setelah pembayaran.`, 'too_late');
  const open = await outsideRequestScope(() => one(`SELECT 1 FROM driver_refund_request WHERE payment_intent_id = $1 AND state IN ('pending', 'approved')`, [p.id]));
  if (open || p.refund_state) throw new DriverRefundError(409, 'Pengembalian dana untuk pembayaran ini sudah diproses.', 'already');
  const asked = b.amount == null || b.amount === '' ? p.refundable : Number(b.amount);
  if (!Number.isInteger(asked) || asked <= 0) throw new DriverRefundError(422, 'Jumlahnya harus bilangan bulat lebih dari 0.');
  // Overcharged: up to what was captured (the charge itself is questioned); otherwise up to what is left on the payment.
  const cap = reason === 'overcharged' || reason === 'other' ? p.captured - Math.max(0, Number(p.refunded)) : p.refundable;
  if (cap <= 0) throw new DriverRefundError(409, 'Tidak ada lagi yang bisa dikembalikan dari pembayaran ini.', 'nothing_left');
  if (asked > cap) throw new DriverRefundError(422, `Paling banyak ${moneyText(cap, currencyOr(p.currency))} yang bisa dikembalikan dari pembayaran ini.`);
  const auto = AUTO_REASONS.has(reason) && asked <= p.refundable && asked <= pol.autoApproveUpTo
    && (reason !== 'charging_failed' || p.wh < 100); // a failed start delivered (almost) nothing
  let row: any;
  try {
    row = await outsideRequestScope(() => one<any>(
      `INSERT INTO driver_refund_request (org_id, payment_intent_id, driver_charge_id, device_id, app_driver_id, reason, message, amount_minor, currency, state, auto, decided_at, decision_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $11 THEN now() END, CASE WHEN $11 THEN 'Approved automatically (operator policy)' END) RETURNING *`,
      [p.org_id, p.id, charge.id, charge.device_id, charge.app_driver_id, reason, message, asked, p.currency, auto ? 'approved' : 'pending', auto]));
  } catch (e) {
    if ((e as any).code === '23505') throw new DriverRefundError(409, 'Pengembalian dana untuk pembayaran ini sudah diproses.', 'already');
    throw e;
  }
  if (auto) {
    await outsideRequestScope(() => markRefundDue(p.id, asked, `Driver request (${reason}), approved automatically`));
  } else {
    await outsideRequestScope(() => persistAlert({ orgId: p.org_id, kind: KIND, severity: 'info', targetType: 'driver_refund_request', targetId: String(row.id),
      message: `A driver asks for ${moneyText(asked, currencyOr(p.currency))} back (${reason.replace('_', ' ')}). Refunds → Driver requests.` })).catch(() => null);
  }
  return view({ ...row, refund_state: auto ? 'due' : null });
}

export async function withdraw(intentId: string, id: string) {
  const r = await outsideRequestScope(() => one(`UPDATE driver_refund_request SET state = 'withdrawn' WHERE id = $1 AND payment_intent_id = $2 AND state = 'pending' RETURNING org_id`, [id, intentId]));
  if (!r) throw new DriverRefundError(409, 'Hanya permintaan yang masih menunggu yang bisa dibatalkan.');
  await outsideRequestScope(() => resolveAlertsFor((r as any).org_id, KIND, 'driver_refund_request', id)).catch(() => 0);
  return { ok: true };
}

/** Finance's queue: pending first, then the last 200 decided. */
export async function list(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT q.*, pi.refund_state, pi.paid_at, pi.amount_captured_minor AS captured, s.name AS site_name, u.name AS decided_by_name
       FROM driver_refund_request q JOIN payment_intent pi ON pi.id = q.payment_intent_id
       LEFT JOIN charging_session cs ON cs.payment_intent_id = pi.id LEFT JOIN site s ON s.id = cs.site_id
       LEFT JOIN app_user u ON u.id = q.decided_by
      WHERE q.org_id = $1 ORDER BY (q.state = 'pending') DESC, q.created_at DESC LIMIT 200`, [orgId]));
  return { requests: rows.map(view), pending: rows.filter((r) => r.state === 'pending').length, policy: await policy(orgId) };
}

export async function decide(orgId: string, id: string, approve: boolean, b: Record<string, unknown>, userId: string | null) {
  if (!/^\d{1,18}$/.test(id)) throw new DriverRefundError(404, 'No such request.');
  const q = await outsideRequestScope(() => one<any>(`SELECT * FROM driver_refund_request WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!q) throw new DriverRefundError(404, 'No such request.');
  if (q.state !== 'pending') throw new DriverRefundError(409, `This request is ${q.state}.`);
  const note = b.note == null || b.note === '' ? null : String(b.note).trim().slice(0, 500);
  if (!approve && (!note || note.length < 3)) throw new DriverRefundError(422, 'Say why it is rejected (the driver sees it).');
  let amount = Number(q.amount_minor);
  if (approve && b.amount != null && b.amount !== '') {
    amount = Number(b.amount);
    if (!Number.isInteger(amount) || amount <= 0 || amount > Number(q.amount_minor)) throw new DriverRefundError(422, 'The amount approved is above 0 and at most what was asked.');
  }
  if (approve) {
    const p = await refundable(q.payment_intent_id);
    const cap = q.reason === 'overcharged' || q.reason === 'other' ? (p?.captured ?? 0) - Math.max(0, Number(p?.refunded ?? 0)) : (p?.refundable ?? 0);
    if (!p || p.refund_state) throw new DriverRefundError(409, 'This payment is already in the refund queue.');
    if (amount > cap) throw new DriverRefundError(409, `Only ${moneyText(cap, currencyOr(q.currency))} can still be refunded on this payment.`);
  }
  const upd = await outsideRequestScope(() => one(
    `UPDATE driver_refund_request SET state = $3, amount_minor = $4, decided_by = $5, decided_at = now(), decision_note = $6 WHERE id = $1 AND org_id = $2 AND state = 'pending' RETURNING id`,
    [id, orgId, approve ? 'approved' : 'rejected', amount, userId, note]));
  if (!upd) throw new DriverRefundError(409, 'This request was just decided.');
  if (approve) await outsideRequestScope(() => markRefundDue(q.payment_intent_id, amount, `Driver request (${q.reason})${note ? `: ${note}` : ''}`));
  await outsideRequestScope(() => resolveAlertsFor(orgId, KIND, 'driver_refund_request', id)).catch(() => 0);
  return { id, state: approve ? 'approved' : 'rejected', amount, paymentId: q.payment_intent_id };
}
