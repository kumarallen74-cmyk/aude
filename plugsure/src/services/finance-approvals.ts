import { one, outsideRequestScope, query } from '../db/pool.js';

/**
 * The approvals matrix (v1.21.0). Every refund, owner payout, write-off and owner bank-detail change already needs a
 * second person (not the requester), and (v1.29.0) so does every supplier bill and (v1.30.0) every purchase order. An organisation can require more, per kind (Finance → Settings → Approvals):
 *
 *   above     the amount (minor unit) from which the rule applies; for bank_change the rule applies to every change
 *   rule      'finance_approver'  the approver holds finance:approve (the Finance Manager role, owners, super admins)
 *             'two_approvers'     two different people approve, neither the requester; the first approval is recorded
 *                                 and the item keeps waiting; the second sends it
 *
 * Only someone holding finance:approve may change the matrix (otherwise a payment:write user could lower it).
 */

export class ApprovalError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const KINDS = ['refund', 'payout', 'write_off', 'bank_change', 'supplier_bill', 'purchase_order'] as const;
export type Kind = typeof KINDS[number];
export type Rule = 'finance_approver' | 'two_approvers';
export interface KindRule { above: number; rule: Rule }
export type Rules = Partial<Record<Kind, KindRule>>;

const TABLE: Record<Kind, string> = { refund: 'refund_transfer', payout: 'payout_transfer', write_off: 'receivable_write_off', bank_change: 'owner_bank_change_request', supplier_bill: 'supplier_bill', purchase_order: 'purchase_order' };
const LABEL: Record<Kind, string> = { refund: 'refund', payout: 'owner payout', write_off: 'write-off', bank_change: 'bank detail change', supplier_bill: 'supplier bill', purchase_order: 'purchase order' };

export async function rules(orgId: string): Promise<Rules> {
  const r = await outsideRequestScope(() => one<{ approval_rules: Rules }>(`SELECT approval_rules FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  return r?.approval_rules ?? {};
}

export async function saveRules(orgId: string, raw: unknown, canApprove: boolean, userId: string | null): Promise<Rules> {
  if (!canApprove) throw new ApprovalError(403, 'Changing the approvals matrix needs the finance:approve permission (Finance Manager).');
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new ApprovalError(422, 'rules is an object by kind: refund, payout, write_off, bank_change, supplier_bill, purchase_order.');
  const out: Rules = {};
  for (const [k, v] of Object.entries(raw as Record<string, any>)) {
    if (!KINDS.includes(k as Kind)) throw new ApprovalError(422, `Unknown kind "${k}" (refund, payout, write_off, bank_change, supplier_bill, purchase_order).`);
    if (v == null) continue;
    const rule = String(v.rule ?? '');
    if (rule !== 'finance_approver' && rule !== 'two_approvers') throw new ApprovalError(422, `${k}: rule is finance_approver or two_approvers.`);
    const above = k === 'bank_change' ? 0 : Number(v.above ?? 0);
    if (!Number.isInteger(above) || above < 0) throw new ApprovalError(422, `${k}: above is a whole amount, 0 or more.`);
    out[k as Kind] = { above, rule };
  }
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, approval_rules, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET approval_rules = EXCLUDED.approval_rules, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, JSON.stringify(out), userId]));
  return out;
}

export interface Approver { userId: string | null; canApprove: boolean }

/**
 * Check an approval against the matrix. Returns 'proceed' (this approval completes it) or 'first' (the first of two
 * approvals was recorded: the caller leaves the item waiting). Throws 403 when this person may not approve it.
 * `row` carries the item's id, amount (null for bank_change), requester and first approver.
 */
export async function gate(kind: Kind, orgId: string, row: { id: string | number; amount: number | null; requested_by: string | null; first_approved_by?: string | null }, who: Approver): Promise<'proceed' | 'first'> {
  if (!who.userId || row.requested_by === who.userId) throw new ApprovalError(403, `A ${LABEL[kind]} is approved by a second person: not the one who requested it.`);
  const r = (await rules(orgId))[kind];
  const applies = r && (kind === 'bank_change' || (row.amount ?? 0) > r.above);
  if (!applies) return 'proceed';
  if (r!.rule === 'finance_approver') {
    if (!who.canApprove) throw new ApprovalError(403, `Above ${r!.above} this ${LABEL[kind]} needs a Finance Manager's approval (finance:approve).`);
    return 'proceed';
  }
  // two_approvers
  if (!row.first_approved_by) {
    const won = await outsideRequestScope(() => one(
      `UPDATE ${TABLE[kind]} SET first_approved_by = $3, first_approved_at = now() WHERE id = $1 AND org_id = $2 AND first_approved_by IS NULL RETURNING id`, [row.id, orgId, who.userId]));
    if (!won) throw new ApprovalError(409, 'Someone approved it at the same time. Reload.');
    return 'first';
  }
  if (row.first_approved_by === who.userId) throw new ApprovalError(403, `This ${LABEL[kind]} needs a second approver: you gave the first approval.`);
  return 'proceed';
}
