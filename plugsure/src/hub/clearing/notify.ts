import { one, outsideRequestScope } from '../../db/pool.js';
import { logger } from '../../logger.js';
import { bus } from '../../services/events.js';
import { writeAudit } from '../../services/audit.js';
import { hubAudit } from '../lifecycle.js';

/**
 * Alerts and audit for clearing (existing mechanisms: `alert.raised` → the alert table, alert routing and the
 * `alert.raised` webhook; services/audit.ts hash chains). Alert kinds (all `hub.*`):
 *
 *   hub.cdr_held               platform            a routed CDR failed a hard check (held until released or voided)
 *   hub.cdr_conflict           platform            the same CDR id seen again with different content
 *   hub.dispute_opened         CPO member          an eMSP disputed one of its CDRs
 *   hub.dispute_updated        the other side      accepted / rejected / escalated / withdrawn / credited / expired / resolved
 *   hub.dispute_escalated      platform            a dispute needs a platform decision
 *   hub.settlement_ready       platform            a draft run can be finalised
 *   hub.statement_issued       each member         a run was finalised: statement (and fee invoice) available
 *   hub.payment_recorded       the other side      a payment was recorded on a position
 *   hub.payment_overdue        payer + platform    a position is past due (day 1, 7 and 14)
 *   hub.fee_invoice_overdue    member + platform   a hub fee invoice is past due
 *
 * Emitted outside any request scope: the alert row belongs to another organisation than the caller's.
 */

export type Severity = 'info' | 'warning' | 'critical';

/**
 * A platform alert (orgId null) cannot be stored under NIL_ORG: alert.org_id references organisation, and there is no
 * platform organisation, so such alerts were dropped ("failed to persist alert"). It is stored in the organisation of
 * the member the target belongs to (the CDR's CPO, the dispute's CPO, the position's payer, the invoice's member);
 * platform administrators see every hub.* alert on the Hub overview whatever its organisation. A run has no member:
 * `hub.settlement_ready` is only logged (the Clearing overview shows runs ready to finalise).
 */
const PLATFORM_ALERT_ORG: Record<string, string> = {
  hub_cdr: `SELECT cpo_org_id AS org FROM hub_cdr WHERE id::text = $1`,
  hub_dispute: `SELECT cpo_org_id AS org FROM hub_dispute WHERE id::text = $1`,
  hub_settlement_position: `SELECT m.org_id AS org FROM hub_settlement_position p JOIN hub_member m ON m.id = p.payer_member_id WHERE p.id::text = $1`,
  hub_fee_invoice: `SELECT org_id AS org FROM hub_fee_invoice WHERE id::text = $1`,
};

export function alert(orgId: string | null, kind: string, message: string, target: { type: string; id: string }, severity: Severity = 'warning'): void {
  const emit = (org: string) => bus.emit('alert.raised', { orgId: org, kind, severity, message: message.slice(0, 900), targetType: target.type, targetId: target.id });
  if (orgId) { outsideRequestScope(() => emit(orgId)); return; }
  void outsideRequestScope(async () => {
    const sql = PLATFORM_ALERT_ORG[target.type];
    const org = sql ? (await one<{ org: string | null }>(sql, [target.id]).catch(() => null))?.org : null;
    if (org) emit(org);
    else logger.warn({ kind, target }, message.slice(0, 300));
  });
}

/** Audit on the platform chain and, for each member org given, on that member's chain. */
export async function audit(action: string, targetType: string, targetId: string, o: { actorId?: string | null; orgIds?: Array<string | null | undefined>; after?: Record<string, unknown> | null; before?: Record<string, unknown> | null; ip?: string | null } = {}): Promise<void> {
  const orgs = [...new Set((o.orgIds ?? []).filter((x): x is string => !!x))];
  await outsideRequestScope(async () => {
    await hubAudit({ action, targetType, targetId, actorId: o.actorId ?? null, after: o.after ?? null, before: o.before ?? null, ip: o.ip ?? null, orgId: orgs[0] ?? null });
    // hubAudit writes the platform chain + one member chain; further members (two-sided events) get their own entry.
    for (const org of orgs.slice(1)) {
      await writeAudit({ orgId: org, actorType: o.actorId ? 'user' : 'system', actorId: o.actorId ?? null, action, targetType, targetId, before: o.before ?? null, after: o.after ?? null, ip: o.ip ?? null }).catch(() => null);
    }
  });
}
