import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { requestPayout, payoutRails } from './payout-transfers.js';
import { TransferError } from './refund-transfers.js';

/**
 * Owner payout automation (v1.26.0). Once an owner statement is finalised, the worker requests the payout of the
 * owner's share through the operator's payout rail (Xendit payouts or Duitku Disbursement), as a person would from
 * Finance → Refunds & shares due. The request is never sent by itself: it waits for the approvals as any other (two people, or a
 * Finance Manager above the approvals matrix's threshold), so automation only saves the first step.
 *
 *   settings      finance_org_settings.owner_payouts: enabled, the days to wait after finalising (0–60: time for
 *                 the owner to raise a query), the minimum amount
 *   per owner     owner_payout_rule: automatic on or off (else the default), its own minimum, a hold with a reason
 *
 * A statement is skipped, with the reason shown in the preview, while:
 *   - its owner is held, off, or below the minimum;
 *   - the owner has a query open on it (Owner queries) or a bank change waiting for approval;
 *   - the owner's bank details are missing, or their name check did not match;
 *   - a payout for it is already open, or it has been paid;
 *   - fewer days than the wait have passed since it was finalised.
 */

export class AutomationError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATES = ['awaiting_approval', 'sending', 'sent'];

export interface AutoSettings { enabled: boolean; delayDays: number; minAmount: number }

export async function settings(orgId: string): Promise<AutoSettings> {
  const r = await outsideRequestScope(() => one<{ owner_payouts: any }>(`SELECT owner_payouts FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const v = r?.owner_payouts ?? {};
  return { enabled: v.enabled === true, delayDays: Number(v.delayDays ?? 3), minAmount: Number(v.minAmount ?? 0) };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null): Promise<AutoSettings> {
  const cur = await settings(orgId);
  const delayDays = b.delayDays === undefined || b.delayDays === '' ? cur.delayDays : Number(b.delayDays);
  if (!Number.isInteger(delayDays) || delayDays < 0 || delayDays > 60) throw new AutomationError(422, 'Wait 0 to 60 days after a statement is finalised.');
  const minAmount = b.minAmount === undefined || b.minAmount === '' ? cur.minAmount : Number(b.minAmount);
  if (!Number.isInteger(minAmount) || minAmount < 0) throw new AutomationError(422, 'The minimum is a whole amount, 0 or more (minor units).');
  const enabled = b.enabled === undefined ? cur.enabled : b.enabled === true;
  const v = { enabled, delayDays, minAmount };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, owner_payouts, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET owner_payouts = EXCLUDED.owner_payouts, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

export async function saveRule(orgId: string, ownerId: string, b: Record<string, unknown>, userId: string | null) {
  if (!UUID_RE.test(ownerId)) throw new AutomationError(404, 'No such site owner.');
  const o = await outsideRequestScope(() => one(`SELECT 1 FROM site_owner WHERE id = $1 AND org_id = $2`, [ownerId, orgId]));
  if (!o) throw new AutomationError(404, 'No such site owner.');
  const automatic = b.automatic === undefined || b.automatic === null || b.automatic === 'default' ? null : b.automatic === true;
  const min = b.minAmount === undefined || b.minAmount === null || b.minAmount === '' ? null : Number(b.minAmount);
  if (min !== null && (!Number.isInteger(min) || min < 0)) throw new AutomationError(422, 'The minimum is a whole amount, 0 or more (minor units).');
  const hold = b.hold === true;
  const reason = hold ? String(b.holdReason ?? '').trim().slice(0, 300) : '';
  if (hold && !reason) throw new AutomationError(422, 'Say why this owner\'s payouts are held.');
  await outsideRequestScope(() => query(
    `INSERT INTO owner_payout_rule (owner_id, org_id, automatic, min_amount_minor, hold, hold_reason, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (owner_id) DO UPDATE SET automatic = EXCLUDED.automatic, min_amount_minor = EXCLUDED.min_amount_minor, hold = EXCLUDED.hold, hold_reason = EXCLUDED.hold_reason,
       updated_by = EXCLUDED.updated_by, updated_at = now()`, [ownerId, orgId, automatic, min, hold, hold ? reason : null, userId]));
  return { ownerId, automatic, minAmount: min, hold, holdReason: hold ? reason : null };
}

export interface Candidate {
  statementId: string; number: string; ownerId: string; owner: string; currency: string; due: number; paid: number; outstanding: number;
  finalisedOn: string; daysSince: number; ready: boolean; reason: string | null;
}

/** Every finalised owner statement with something left to pay, and whether the worker would request it now. */
export async function preview(orgId: string, now = new Date()): Promise<{ settings: AutoSettings; rails: string[]; candidates: Candidate[]; rules: any[] }> {
  const st = await settings(orgId);
  const z = config.billing.timeZone;
  const [rows, rules] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT s.id, s.number, s.owner_id, COALESCE(w.legal_name, w.name) AS owner, s.currency, s.owner_share_minor AS due,
              to_char(s.finalised_at AT TIME ZONE $2, 'YYYY-MM-DD') AS fin, extract(epoch FROM ($3::timestamptz - s.finalised_at)) / 86400 AS days,
              COALESCE((SELECT sum(amount_minor) FROM statement_payment p WHERE p.statement_id = s.id AND p.voided_at IS NULL), 0)::bigint AS paid,
              EXISTS (SELECT 1 FROM payout_transfer t WHERE t.statement_id = s.id AND t.state = ANY($4::text[])) AS open_payout,
              EXISTS (SELECT 1 FROM owner_statement_dispute d WHERE d.statement_id = s.id AND d.state = 'open') AS open_query,
              EXISTS (SELECT 1 FROM owner_bank_change_request c WHERE c.owner_id = s.owner_id AND c.state = 'pending') AS bank_change,
              a.owner_id IS NOT NULL AS has_bank, a.bank_code, a.name_check_status,
              r.automatic, r.min_amount_minor, r.hold, r.hold_reason
         FROM commission_statement s JOIN site_owner w ON w.id = s.owner_id
         LEFT JOIN owner_bank_account a ON a.owner_id = s.owner_id
         LEFT JOIN owner_payout_rule r ON r.owner_id = s.owner_id
        WHERE s.org_id = $1 AND s.owner_id IS NOT NULL AND s.finalised_at IS NOT NULL AND s.owner_share_minor > 0
        ORDER BY s.finalised_at DESC LIMIT 500`, [orgId, z, now.toISOString(), OPEN_STATES])),
    outsideRequestScope(() => many<any>(
      `SELECT w.id, COALESCE(w.legal_name, w.name) AS owner, r.automatic, r.min_amount_minor, r.hold, r.hold_reason, r.updated_at
         FROM site_owner w LEFT JOIN owner_payout_rule r ON r.owner_id = w.id WHERE w.org_id = $1 ORDER BY 2`, [orgId])),
  ]);
  const candidates: Candidate[] = [];
  for (const r of rows) {
    const due = Number(r.due), paid = Number(r.paid), outstanding = Math.max(0, due - paid);
    if (outstanding <= 0) continue;
    const min = r.min_amount_minor != null ? Number(r.min_amount_minor) : st.minAmount;
    const on = r.automatic ?? st.enabled;
    const days = Math.floor(Number(r.days));
    const reason = r.hold ? `Held: ${r.hold_reason}`
      : !on ? (r.automatic === false ? 'Automatic payouts are off for this owner.' : 'Automatic payouts are off.')
        : r.open_payout ? 'A payout is already open.'
          : r.open_query ? 'The owner has a query open on this statement.'
            : r.bank_change ? 'A change of the owner\'s bank details is waiting for approval.'
              : !r.has_bank || !r.bank_code ? 'The owner\'s bank details (with the bank code) are missing.'
                : r.name_check_status === 'mismatch' ? 'The account holder\'s name did not match at the bank.'
                  : outstanding < min ? `Below the minimum (${min}).`
                    : days < st.delayDays ? `Waiting ${st.delayDays - days} more day(s) after finalising.`
                      : null;
    candidates.push({
      statementId: r.id, number: r.number, ownerId: r.owner_id, owner: r.owner, currency: r.currency, due, paid, outstanding,
      finalisedOn: r.fin, daysSince: days, ready: reason === null, reason,
    });
  }
  return {
    settings: st, rails: await payoutRails(orgId, false).catch(() => []), candidates,
    rules: rules.map((x) => ({ ownerId: x.id, owner: x.owner, automatic: x.automatic, minAmount: x.min_amount_minor != null ? Number(x.min_amount_minor) : null, hold: x.hold === true, holdReason: x.hold_reason ?? null })),
  };
}

/** Request the payouts that are ready for one organisation. Returns what was requested and what failed. */
export async function run(orgId: string, now = new Date()) {
  const p = await preview(orgId, now);
  const requested: Array<{ statementId: string; number: string; transferId: string; amount: number }> = [];
  const failed: Array<{ statementId: string; number: string; error: string }> = [];
  for (const c of p.candidates.filter((x) => x.ready)) {
    try {
      const t = await outsideRequestScope(() => requestPayout(orgId, false, c.statementId, { amount: c.outstanding, note: 'Requested automatically after the statement was finalised.' }, null));
      await outsideRequestScope(() => query(`UPDATE payout_transfer SET automatic = true WHERE id = $1`, [t.id]));
      requested.push({ statementId: c.statementId, number: c.number, transferId: t.id, amount: c.outstanding });
    } catch (e) {
      failed.push({ statementId: c.statementId, number: c.number, error: (e as Error).message });
      // No rail on the account: the same for every statement.
      if (e instanceof TransferError && e.statusCode === 409 && /set up|need/.test(e.message)) break;
    }
  }
  return { requested, failed };
}

/** The worker: every organisation with automatic payouts on, or an owner switched on by rule. */
export async function sweep(now = new Date()): Promise<number> {
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(
    `SELECT org_id FROM finance_org_settings WHERE (owner_payouts->>'enabled')::boolean IS TRUE
     UNION SELECT DISTINCT org_id FROM owner_payout_rule WHERE automatic IS TRUE`));
  let n = 0;
  for (const o of orgs) {
    try {
      const r = await run(o.org_id, now);
      n += r.requested.length;
      for (const f of r.failed) logger.warn({ org: o.org_id, statement: f.statementId, err: f.error }, 'automatic owner payout not requested');
    } catch (e) {
      logger.warn({ org: o.org_id, err: (e as Error).message }, 'automatic owner payouts failed');
    }
  }
  return n;
}
