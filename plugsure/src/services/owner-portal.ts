import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';
import type { Principal } from './authz.js';
import { seal, unseal } from './secrets.js';
import { bankAccount, saveBankAccount } from './payouts.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { gate, ApprovalError } from './finance-approvals.js';

/**
 * The Site Owner portal's money (v1.19.0). A Site Owner user (role site_owner, scope 'owner') already sees its sites,
 * sessions and monthly statements read-only; it now also sees, for its own owner only:
 *
 *   payouts        each finalised statement's share, what the operator recorded as paid against it (date, amount,
 *                  reference) and what is still due
 *   bank details   the account on file (masked), and a request to change it: kept sealed until the operator approves
 *                  it in Finance → Refunds & shares due (it then replaces the account on file) or rejects it with a reason; one
 *                  pending request at a time; the owner may withdraw it. The operator is alerted
 *                  (finance.owner_bank_change_requested).
 *
 * Nothing here moves money, and an owner never changes the account the operator pays by itself.
 */

export class OwnerPortalError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const BANK_CHANGE_ALERT = 'finance.owner_bank_change_requested';
const AAD = (id: string) => `owner_bank_change_request:${id}`;
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const ymd = (d: Date | string | null) => (d ? (typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)) : null);

/** The owner the portal user is, or 404 (never 403: other owners do not exist for it). */
export function portalOwner(p: Principal): string {
  const id = p.ownerIds?.[0];
  if (!id) throw new OwnerPortalError(404, 'Not a site owner portal user.');
  return id;
}

/** Finalised statements with the owner's share, the payments recorded against each, and what is still due. */
export async function payouts(orgId: string, ownerId: string) {
  const [stmts, pays] = await outsideRequestScope(() => Promise.all([
    many<any>(
      `SELECT id, number, to_char(period, 'YYYY-MM') AS period, owner_share_minor, currency, finalised_at FROM commission_statement
        WHERE org_id = $1 AND owner_id = $2 AND finalised_at IS NOT NULL ORDER BY period DESC LIMIT 36`, [orgId, ownerId]),
    many<any>(
      `SELECT p.statement_id, p.amount_minor, p.currency, p.paid_on, p.reference FROM statement_payment p JOIN commission_statement s ON s.id = p.statement_id
        WHERE s.org_id = $1 AND s.owner_id = $2 AND p.kind = 'owner_payout' AND p.voided_at IS NULL ORDER BY p.paid_on DESC`, [orgId, ownerId]),
  ]));
  const statements = stmts.map((s) => {
    const mine = pays.filter((p) => p.statement_id === s.id);
    const share = Number(s.owner_share_minor), paid = mine.reduce((a, p) => a + Number(p.amount_minor), 0);
    return {
      statementId: s.id, number: s.number, period: s.period, currency: s.currency, share, paid, outstanding: Math.max(0, share - paid),
      status: share <= 0 ? 'nothing' : paid <= 0 ? 'due' : paid >= share ? 'paid' : 'partial', finalisedAt: iso(s.finalised_at),
      payments: mine.map((p) => ({ paidOn: ymd(p.paid_on), amount: Number(p.amount_minor), currency: p.currency, reference: p.reference })),
    };
  });
  const totals: Record<string, { share: number; paid: number; outstanding: number }> = {};
  for (const s of statements) {
    const t = totals[s.currency] ?? { share: 0, paid: 0, outstanding: 0 };
    t.share += s.share; t.paid += s.paid; t.outstanding += s.outstanding;
    totals[s.currency] = t;
  }
  return { statements, totals };
}

const reqView = (r: any) => r && ({
  id: String(r.id), bankName: r.bank_name, bankCode: r.bank_code, holderName: r.holder_name, accountMasked: `••••${r.account_last4}`, note: r.note,
  state: r.state, firstApprovedBy: r.first_approved_by ?? null, requestedAt: iso(r.requested_at), requestedBy: r.requested_by_name ?? null, decidedAt: iso(r.decided_at), decidedBy: r.decided_by_name ?? null, decisionNote: r.decision_note,
  owner: r.owner_name ?? undefined, ownerId: r.owner_id,
});

/** The account on file (masked) and the latest change request. */
export async function bank(orgId: string, ownerId: string) {
  const [onFile, last] = await Promise.all([
    bankAccount(orgId, ownerId),
    outsideRequestScope(() => one<any>(
      `SELECT r.*, d.name AS decided_by_name FROM owner_bank_change_request r LEFT JOIN app_user d ON d.id = r.decided_by
        WHERE r.org_id = $1 AND r.owner_id = $2 ORDER BY r.requested_at DESC LIMIT 1`, [orgId, ownerId])),
  ]);
  return {
    onFile: onFile ? { bankName: onFile.bankName, bankCode: onFile.bankCode, holderName: onFile.holderName, accountMasked: onFile.accountMasked, updatedAt: onFile.updatedAt } : null,
    request: reqView(last),
  };
}

/** The owner asks for its bank details to change; the operator decides. */
export async function requestChange(orgId: string, ownerId: string, b: Record<string, unknown>, userId: string | null) {
  const bankName = String(b.bankName ?? '').trim(), holder = String(b.holderName ?? '').trim(), code = String(b.bankCode ?? '').trim();
  const number = String(b.accountNumber ?? '').replace(/[\s.-]/g, '');
  const note = b.note == null ? null : String(b.note).trim().slice(0, 300) || null;
  if (!bankName || bankName.length > 80) throw new OwnerPortalError(422, 'The bank name is 1 to 80 characters (e.g. BCA, Mandiri, BRI).');
  if (!holder || holder.length > 120) throw new OwnerPortalError(422, 'The account holder\'s name is 1 to 120 characters, as the bank has it.');
  if (code && !/^[A-Za-z0-9]{2,12}$/.test(code)) throw new OwnerPortalError(422, 'The bank code is 2 to 12 letters or digits (e.g. 014 for BCA).');
  if (!/^\d{5,20}$/.test(number)) throw new OwnerPortalError(422, 'The account number is 5 to 20 digits.');
  const owner = await outsideRequestScope(() => one<{ name: string }>(`SELECT COALESCE(legal_name, name) AS name FROM site_owner WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [ownerId, orgId]));
  if (!owner) throw new OwnerPortalError(404, 'No such site owner.');
  let id: string;
  try {
    // The id first, so the number is sealed under it in the one insert.
    id = String((await outsideRequestScope(() => one<{ id: string }>(`SELECT nextval('owner_bank_change_request_id_seq')::text AS id`)))!.id);
    await outsideRequestScope(() => query(
      `INSERT INTO owner_bank_change_request (id, org_id, owner_id, bank_name, bank_code, holder_name, account_number_sealed, account_last4, note, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, orgId, ownerId, bankName, code || null, holder, seal(number, AAD(id)), number.slice(-4), note, userId]));
  } catch (e) {
    if ((e as any).code === '23505') throw new OwnerPortalError(409, 'A change is already waiting for the operator. Withdraw it first to send another.');
    throw e;
  }
  await outsideRequestScope(() => persistAlert({
    orgId, kind: BANK_CHANGE_ALERT, severity: 'warning', targetType: 'owner_bank_change_request', targetId: id,
    message: `${owner.name} asked to change its bank details to ${bankName} ••••${number.slice(-4)} (${holder}). Check it with the owner before approving: Finance → Refunds & shares due → Bank detail changes.`,
  })).catch((e: unknown) => logger.warn({ err: (e as Error).message }, 'bank change alert failed'));
  return { id, state: 'pending' };
}

export async function withdraw(orgId: string, ownerId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new OwnerPortalError(404, 'No such request.');
  const r = await outsideRequestScope(() => one(`UPDATE owner_bank_change_request SET state = 'withdrawn', decided_at = now() WHERE id = $1 AND org_id = $2 AND owner_id = $3 AND state = 'pending' RETURNING id`, [id, orgId, ownerId]));
  if (!r) throw new OwnerPortalError(404, 'No pending request to withdraw.');
  await outsideRequestScope(() => resolveAlertsFor(orgId, BANK_CHANGE_ALERT, 'owner_bank_change_request', id)).catch(() => 0);
  return { ok: true };
}

// ─────────────────────────────────────────── the operator's side (Finance → Refunds & shares due)

export async function pendingRequests(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT r.*, u.name AS requested_by_name, COALESCE(o.legal_name, o.name) AS owner_name FROM owner_bank_change_request r
       JOIN site_owner o ON o.id = r.owner_id LEFT JOIN app_user u ON u.id = r.requested_by
      WHERE r.org_id = $1 AND r.state = 'pending' ORDER BY r.requested_at`, [orgId]));
  return Promise.all(rows.map(async (r) => ({ ...reqView(r), current: await bankAccount(orgId, r.owner_id).then((b) => b && { bankName: b.bankName, holderName: b.holderName, accountMasked: b.accountMasked }) })));
}

/** Approve: the requested account replaces the one on file (sealed as the owner's), or reject with a reason. */
export async function decide(orgId: string, id: string, approve: boolean, noteRaw: unknown, userId: string | null, canApprove = false) {
  if (!/^\d{1,18}$/.test(id)) throw new OwnerPortalError(404, 'No such request.');
  const note = noteRaw == null ? null : String(noteRaw).trim().slice(0, 300) || null;
  if (!approve && !note) throw new OwnerPortalError(422, 'Say why the change is rejected (the owner sees it).');
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM owner_bank_change_request WHERE id = $1 AND org_id = $2 AND state = 'pending'`, [id, orgId]));
  if (!r) throw new OwnerPortalError(404, 'No pending request.');
  if (r.requested_by && userId && r.requested_by === userId) throw new OwnerPortalError(403, 'The person who asked for a change cannot approve it.');
  if (approve) {
    // (v1.21.0) The approvals matrix (bank_change: every change when a rule is set).
    try {
      if (await gate('bank_change', orgId, { id: r.id, amount: null, requested_by: r.requested_by, first_approved_by: r.first_approved_by }, { userId, canApprove }) === 'first') {
        return { ok: true, state: 'pending', firstApproval: true, ownerId: r.owner_id as string };
      }
    } catch (e) {
      if (e instanceof ApprovalError) throw new OwnerPortalError(e.statusCode, e.message);
      throw e;
    }
    const number = unseal(r.account_number_sealed, AAD(id));
    await saveBankAccount(orgId, r.owner_id, { bankName: r.bank_name, bankCode: r.bank_code, holderName: r.holder_name, accountNumber: number }, userId);
  }
  const won = await outsideRequestScope(() => one(
    `UPDATE owner_bank_change_request SET state = $3, decided_by = $4, decided_at = now(), decision_note = $5 WHERE id = $1 AND org_id = $2 AND state = 'pending' RETURNING id`,
    [id, orgId, approve ? 'approved' : 'rejected', userId, note]));
  if (!won) throw new OwnerPortalError(409, 'Someone else decided it first.');
  await outsideRequestScope(() => resolveAlertsFor(orgId, BANK_CHANGE_ALERT, 'owner_bank_change_request', id)).catch(() => 0);
  return { ok: true, state: approve ? 'approved' : 'rejected', firstApproval: false, ownerId: r.owner_id as string };
}
