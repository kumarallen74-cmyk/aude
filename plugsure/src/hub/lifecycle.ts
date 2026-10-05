import { many, one, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { writeAudit } from '../services/audit.js';
import { syncOrg } from '../ocpi/push.js';
import { importFromCpo } from '../ocpi/emsp.js';
import { pullHubClients } from '../ocpi/hubclients.js';
import type { PartnerRow } from '../ocpi/store.js';
import { pushAgreementChange, pushClientInfoAbout, pushClientInfoTo, resyncAllClientInfo } from './clientinfo.js';
import { closeConnection } from './credentials.js';
import { HubError } from './errors.js';
import { getConnection, getMember, getParty, joinInternal, partiesOfConnection, partiesOfMember, setPartyStatus } from './registry.js';
import type { HubAgreement, HubConnection, HubMember } from './types.js';

/**
 * Lifecycle operations that change who may route (design §4.5): each changes statuses, then tells the
 * counterparties (ClientInfo) and, for agreements, starts the "welcome sync". Every one is audited on the
 * platform chain (and the member's own chain when it concerns one member).
 */

export async function hubAudit(e: { action: string; targetType: string; targetId: string; actorId?: string | null; orgId?: string | null; after?: Record<string, unknown> | null; before?: Record<string, unknown> | null; ip?: string | null }) {
  const entry = { actorType: e.actorId ? 'user' as const : 'system' as const, actorId: e.actorId ?? null, action: e.action, targetType: e.targetType, targetId: e.targetId, before: e.before ?? null, after: e.after ?? null, ip: e.ip ?? null };
  await writeAudit({ ...entry, orgId: null }).catch((err) => logger.error({ err: (err as Error).message, action: e.action }, 'hub audit failed'));
  if (e.orgId) await writeAudit({ ...entry, orgId: e.orgId }).catch((err) => logger.error({ err: (err as Error).message, action: e.action }, 'hub audit (member chain) failed'));
}

const connectedConnections = (memberId: string) =>
  many<HubConnection>(`SELECT * FROM hub_connection WHERE member_id = $1 AND state = 'connected'`, [memberId]);

/** onboarding → active: its parties on connected connections go PLANNED → CONNECTED and become visible. */
export async function activateMember(memberId: string): Promise<HubMember> {
  const m = await one<HubMember>(`UPDATE hub_member SET status = 'active', updated_at = now() WHERE id = $1 AND status IN ('onboarding','active') RETURNING *`, [memberId]);
  if (!m) throw new HubError(409, 2000, 'only an onboarding member can be activated (a suspended one is resumed)');
  const changed: string[] = [];
  for (const c of await connectedConnections(memberId)) {
    const ids = (await partiesOfConnection(c.id)).filter((p) => p.status === 'PLANNED').map((p) => p.id);
    changed.push(...await setPartyStatus(ids, 'CONNECTED'));
  }
  await pushClientInfoAbout(changed);
  for (const c of await connectedConnections(memberId)) await pushClientInfoTo(c.id);
  return m;
}

export async function suspendMember(memberId: string): Promise<HubMember> {
  const m = await one<HubMember>(`UPDATE hub_member SET status = 'suspended', updated_at = now() WHERE id = $1 AND status IN ('onboarding','active') RETURNING *`, [memberId]);
  if (!m) throw new HubError(409, 2000, 'the member is not active');
  const ids = (await partiesOfMember(memberId)).map((p) => p.id);
  await pushClientInfoAbout(await setPartyStatus(ids, 'SUSPENDED', { admin: true }));
  return m;
}

export async function resumeMember(memberId: string): Promise<HubMember> {
  const m = await one<HubMember>(`UPDATE hub_member SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'suspended' RETURNING *`, [memberId]);
  if (!m) throw new HubError(409, 2000, 'the member is not suspended');
  const changed: string[] = [];
  for (const c of await connectedConnections(memberId)) {
    changed.push(...await setPartyStatus((await partiesOfConnection(c.id)).map((p) => p.id), 'CONNECTED', { adminResume: true }));
  }
  await pushClientInfoAbout(changed);
  return m;
}

export async function terminateMember(memberId: string): Promise<HubMember> {
  const m = await getMember(memberId);
  if (!m) throw new HubError(404, 2000, 'member not found');
  const changed: string[] = [];
  for (const c of await many<HubConnection>(`SELECT * FROM hub_connection WHERE member_id = $1 AND state <> 'closed'`, [memberId])) {
    changed.push(...await closeConnection(c, true));
  }
  await query(`UPDATE hub_agreement SET status = 'ended', updated_at = now() WHERE status <> 'ended' AND (cpo_party_id IN (SELECT id FROM hub_party WHERE member_id = $1) OR emsp_party_id IN (SELECT id FROM hub_party WHERE member_id = $1))`, [memberId]);
  const row = await one<HubMember>(`UPDATE hub_member SET status = 'terminated', updated_at = now() WHERE id = $1 RETURNING *`, [memberId]);
  await pushClientInfoAbout(changed);
  return row!;
}

export async function setOpenRoaming(memberId: string, open: boolean): Promise<HubMember> {
  const m = await one<HubMember>(`UPDATE hub_member SET open_roaming = $2, updated_at = now() WHERE id = $1 RETURNING *`, [memberId, open]);
  if (!m) throw new HubError(404, 2000, 'member not found');
  // Visibility may change for many pairs at once: a full resync is the simple, correct answer.
  void resyncAllClientInfo().catch(() => null);
  return m;
}

export async function suspendConnection(connId: string): Promise<HubConnection> {
  const c = await one<HubConnection>(`UPDATE hub_connection SET state = 'suspended', updated_at = now() WHERE id = $1 AND state = 'connected' RETURNING *`, [connId]);
  if (!c) throw new HubError(409, 2000, 'the connection is not connected');
  await pushClientInfoAbout(await setPartyStatus((await partiesOfConnection(connId)).map((p) => p.id), 'SUSPENDED', { admin: true }));
  return c;
}

export async function resumeConnection(connId: string): Promise<HubConnection> {
  const c = await one<HubConnection>(`UPDATE hub_connection SET state = 'connected', updated_at = now() WHERE id = $1 AND state = 'suspended' RETURNING *`, [connId]);
  if (!c) throw new HubError(409, 2000, 'the connection is not suspended');
  const m = await getMember(c.member_id);
  await pushClientInfoAbout(await setPartyStatus((await partiesOfConnection(connId)).map((p) => p.id), m?.status === 'active' ? 'CONNECTED' : 'PLANNED', { adminResume: true }));
  return c;
}

export async function closeConnectionAndNotify(connId: string, notifyMember: boolean): Promise<void> {
  const c = await getConnection(connId);
  if (!c || c.state === 'closed') throw new HubError(404, 2000, 'connection not found (or closed)');
  await pushClientInfoAbout(await closeConnection(c, notifyMember));
}

export async function setPartyAdmin(partyId: string, suspend: boolean): Promise<void> {
  const p = await getParty(partyId);
  if (!p) throw new HubError(404, 2000, 'party not found');
  if (suspend) {
    await pushClientInfoAbout(await setPartyStatus([p.id], 'SUSPENDED', { admin: true }));
    return;
  }
  const c = p.connection_id ? await getConnection(p.connection_id) : null;
  const m = await getMember(p.member_id);
  const status = c?.state === 'connected' && m?.status === 'active' ? 'CONNECTED' : 'PLANNED';
  await pushClientInfoAbout(await setPartyStatus([p.id], status, { adminResume: true }));
}

/** Join a tenant (zero-config, §4.4), then share its network and pull what it may see. */
export async function joinTenant(orgId: string, actorId: string | null) {
  const r = await joinInternal(orgId, actorId);
  if (r.created) {
    setImmediate(() => void (async () => {
      await pushClientInfoAbout((await partiesOfConnection(r.connection.id)).map((p) => p.id));
      await pushClientInfoTo(r.connection.id);
      await welcomeInternal(r.connection.id);
    })().catch((e) => logger.warn({ err: (e as Error).message }, 'hub join follow-up failed')));
  }
  return r;
}

export async function leaveTenant(orgId: string): Promise<boolean> {
  const c = await one<HubConnection>(
    `SELECT hc.* FROM hub_connection hc JOIN hub_member m ON m.id = hc.member_id WHERE m.org_id = $1 AND hc.kind = 'internal' AND hc.state <> 'closed'`, [orgId]);
  if (!c) return false;
  await pushClientInfoAbout(await closeConnection(c, false));
  return true;
}

/** An internal member's tenant side: publish its network to the hub and pull its counterparties' (welcome sync). */
async function welcomeInternal(connectionId: string): Promise<void> {
  const c = await getConnection(connectionId);
  if (!c || c.kind !== 'internal' || c.state !== 'connected' || !c.peer_org_id || !c.peer_partner_id) return;
  const partner = await one<PartnerRow>(`SELECT * FROM ocpi_partner WHERE id = $1`, [c.peer_partner_id]);
  if (!partner || partner.state !== 'connected') return;
  await pullHubClients(partner).catch(() => null);
  await syncOrg(c.peer_org_id, { forceAll: true, partnerId: partner.id });
  await importFromCpo(partner);
}

/** After an agreement transition: ClientInfo to both sides; on activation, the welcome sync (§5.9). */
export async function onAgreementChanged(before: HubAgreement | null, after: HubAgreement): Promise<void> {
  const wasLive = before?.status === 'active';
  const isLive = after.status === 'active';
  if (wasLive === isLive) return;
  await pushAgreementChange(after.cpo_party_id, after.emsp_party_id, isLive);
  if (!isLive) return;
  setImmediate(() => void (async () => {
    // Let the ClientInfo reach the tenant first: it accepts a party's data only once it knows the party.
    const { deliverHubDue } = await import('./outbox.js');
    await deliverHubDue(100).catch(() => 0);
    for (const id of [after.cpo_party_id, after.emsp_party_id]) {
      const p = await getParty(id);
      if (p?.connection_id) await welcomeInternal(p.connection_id);
    }
  })().catch((e) => logger.warn({ err: (e as Error).message }, 'hub welcome sync failed')));
}
