import { one, many } from '../db/pool.js';
import { HubError } from './errors.js';
import type { HubAgreement, HubParty } from './types.js';
import { isCpoRole, isEmspSide, label } from './types.js';

/**
 * Roaming agreements (design D7, §5.9): a CPO party and an eMSP-side party exchange functional messages only
 * under an ACTIVE agreement (inside its validity window), or when both members opted into open roaming.
 * The router asks here at every routing point: broadcast recipients, GET All sources, direct and open routes,
 * the open-routing index, and ClientInfo visibility.
 */

const LIVE = `a.status = 'active' AND (a.valid_from IS NULL OR a.valid_from <= now()) AND (a.valid_to IS NULL OR a.valid_to > now())`;

export type ModuleFlag = 'realtime' | 'commands' | 'chargingprofiles' | null;

export interface RouteVerdict {
  ok: boolean;
  /** OCPI status to answer when refused: 4901 (no agreement / flag off) or 2001 (no CPO⇄eMSP pair). */
  code?: number;
  reason?: string;
  agreement?: HubAgreement | null;
  open?: boolean;
}

/** The CPO and the eMSP-side party of a pair, or null when the pair is not CPO ⇄ eMSP. */
export function cpoEmspPair(a: HubParty, b: HubParty): { cpo: HubParty; emsp: HubParty } | null {
  if (isCpoRole(a.role) && isEmspSide(b.role)) return { cpo: a, emsp: b };
  if (isCpoRole(b.role) && isEmspSide(a.role)) return { cpo: b, emsp: a };
  return null;
}

export async function activeAgreement(cpoPartyId: string, emspPartyId: string): Promise<HubAgreement | null> {
  return one<HubAgreement>(`SELECT a.* FROM hub_agreement a WHERE a.cpo_party_id = $1 AND a.emsp_party_id = $2 AND ${LIVE}`, [cpoPartyId, emspPartyId]);
}

async function bothOpen(a: HubParty, b: HubParty): Promise<boolean> {
  const r = await one<{ ok: boolean }>(
    `SELECT bool_and(open_roaming AND status = 'active') AS ok FROM hub_member WHERE id = ANY($1::uuid[])`, [[a.member_id, b.member_id]]);
  return !!r?.ok;
}

/** May `from` and `to` exchange a message of this kind (direct and open routes)? */
export async function mayRoute(from: HubParty, to: HubParty, flag: ModuleFlag = null): Promise<RouteVerdict> {
  const pair = cpoEmspPair(from, to);
  if (!pair) {
    return { ok: false, code: 2001, reason: `${label(from)} (${from.role}) and ${label(to)} (${to.role}) are not a CPO and an eMSP: no such route through the hub` };
  }
  if (from.member_id === to.member_id) {
    return { ok: false, code: 4901, reason: `${label(from)} and ${label(to)} belong to the same member: their own traffic does not roam through the hub` };
  }
  const agreement = await activeAgreement(pair.cpo.id, pair.emsp.id);
  if (!agreement) {
    if (await bothOpen(from, to)) return { ok: true, open: true, agreement: null };
    return { ok: false, code: 4901, reason: `no active roaming agreement between ${label(pair.cpo)} and ${label(pair.emsp)}` };
  }
  const off = flag === 'realtime' ? !agreement.allow_realtime_auth : flag === 'commands' ? !agreement.allow_commands
    : flag === 'chargingprofiles' ? !agreement.allow_charging_profiles : false;
  if (off) return { ok: false, code: 4901, reason: `the roaming agreement between ${label(pair.cpo)} and ${label(pair.emsp)} does not allow ${flag === 'realtime' ? 'real-time authorisation' : flag === 'commands' ? 'commands' : 'charging profiles'}`, agreement };
  return { ok: true, agreement };
}

/**
 * The counterparties of `party` it may exchange messages with: the opposite role, another member, and an
 * active agreement or mutual open roaming. `onlyConnected`: status CONNECTED (broadcast recipients).
 */
export async function agreedCounterparties(party: HubParty, opts: { statuses?: string[] } = {}): Promise<HubParty[]> {
  const cpo = isCpoRole(party.role);
  const statuses = opts.statuses ?? ['CONNECTED', 'OFFLINE'];
  return many<HubParty>(
    `SELECT q.* FROM hub_party q
       JOIN hub_member qm ON qm.id = q.member_id
       JOIN hub_member pm ON pm.id = $2
      WHERE q.member_id <> $2
        AND q.status = ANY($3::text[])
        AND ${cpo ? `q.role IN ('EMSP','OTHER','NSP','SCSP')` : `q.role = 'CPO'`}
        AND (
          EXISTS (SELECT 1 FROM hub_agreement a
                   WHERE ${cpo ? 'a.cpo_party_id = $1 AND a.emsp_party_id = q.id' : 'a.emsp_party_id = $1 AND a.cpo_party_id = q.id'}
                     AND ${LIVE})
          OR (pm.open_roaming AND qm.open_roaming AND pm.status = 'active' AND qm.status = 'active'))
      ORDER BY q.country_code, q.party_id, q.role`,
    [party.id, party.member_id, statuses],
  );
}

// ─────────────────────────────────────────────── platform workflow

export async function getAgreement(id: string) {
  return one<HubAgreement>(`SELECT * FROM hub_agreement WHERE id = $1`, [id]);
}

export async function createAgreement(input: {
  cpo: HubParty; emsp: HubParty; by: 'cpo' | 'emsp' | 'platform'; activate: boolean;
  allow_realtime_auth?: boolean; allow_commands?: boolean; allow_charging_profiles?: boolean;
  valid_from?: Date | null; valid_to?: Date | null; notes?: string | null;
}): Promise<HubAgreement> {
  const { cpo, emsp } = input;
  if (!isCpoRole(cpo.role)) throw new HubError(400, 2001, `${label(cpo)} is registered as ${cpo.role}, not CPO`);
  if (!isEmspSide(emsp.role)) throw new HubError(400, 2001, `${label(emsp)} is registered as ${emsp.role}, not an eMSP-side role`);
  if (cpo.member_id === emsp.member_id) throw new HubError(400, 2001, 'a member does not roam with itself through the hub');
  if (input.valid_from && input.valid_to && input.valid_to <= input.valid_from) throw new HubError(400, 2001, 'valid_to must be after valid_from');
  const now = input.activate ? new Date() : null;
  const row = await one<HubAgreement>(
    `INSERT INTO hub_agreement (cpo_party_id, emsp_party_id, cpo_org_id, emsp_org_id, status, proposed_by, cpo_accepted_at, emsp_accepted_at,
                                valid_from, valid_to, allow_realtime_auth, allow_commands, allow_charging_profiles, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,COALESCE($10,true),COALESCE($11,true),COALESCE($12,true),$13)
     ON CONFLICT (cpo_party_id, emsp_party_id) WHERE status IN ('proposed','active','suspended') DO NOTHING
     RETURNING *`,
    [cpo.id, emsp.id, cpo.org_id, emsp.org_id, input.activate ? 'active' : 'proposed', input.by, now,
      input.valid_from ?? null, input.valid_to ?? null, input.allow_realtime_auth ?? null, input.allow_commands ?? null,
      input.allow_charging_profiles ?? null, input.notes ?? null],
  );
  if (!row) throw new HubError(409, 2000, `an agreement between ${label(cpo)} and ${label(emsp)} already exists`);
  return row;
}

export type AgreementAction = 'approve' | 'suspend' | 'resume' | 'end';

/** approve: proposed → active; suspend: active → suspended; resume: suspended → active; end: any live → ended. */
export async function transitionAgreement(id: string, action: AgreementAction, patch: {
  allow_realtime_auth?: boolean; allow_commands?: boolean; allow_charging_profiles?: boolean; notes?: string | null;
} = {}): Promise<{ before: HubAgreement; after: HubAgreement }> {
  const before = await getAgreement(id);
  if (!before) throw new HubError(404, 2000, 'agreement not found');
  const from: Record<AgreementAction, string[]> = { approve: ['proposed'], suspend: ['active'], resume: ['suspended'], end: ['proposed', 'active', 'suspended'] };
  const to: Record<AgreementAction, string> = { approve: 'active', suspend: 'suspended', resume: 'active', end: 'ended' };
  if (!from[action].includes(before.status)) throw new HubError(409, 2000, `cannot ${action} an agreement that is ${before.status}`);
  const after = await one<HubAgreement>(
    `UPDATE hub_agreement SET status = $2, updated_at = now(),
            cpo_accepted_at = CASE WHEN $2 = 'active' THEN COALESCE(cpo_accepted_at, now()) ELSE cpo_accepted_at END,
            emsp_accepted_at = CASE WHEN $2 = 'active' THEN COALESCE(emsp_accepted_at, now()) ELSE emsp_accepted_at END,
            allow_realtime_auth = COALESCE($4, allow_realtime_auth), allow_commands = COALESCE($5, allow_commands),
            allow_charging_profiles = COALESCE($6, allow_charging_profiles), notes = COALESCE($7, notes)
      WHERE id = $1 AND status = $3 RETURNING *`,
    [id, to[action], before.status, patch.allow_realtime_auth ?? null, patch.allow_commands ?? null, patch.allow_charging_profiles ?? null, patch.notes ?? null],
  );
  if (!after) throw new HubError(409, 2000, 'the agreement changed meanwhile: try again');
  return { before, after };
}

/** Change only the module flags of a live agreement (no status change). */
export async function updateAgreementFlags(id: string, patch: { allow_realtime_auth?: boolean; allow_commands?: boolean; allow_charging_profiles?: boolean; notes?: string | null }) {
  const row = await one<HubAgreement>(
    `UPDATE hub_agreement SET allow_realtime_auth = COALESCE($2, allow_realtime_auth), allow_commands = COALESCE($3, allow_commands),
            allow_charging_profiles = COALESCE($4, allow_charging_profiles), notes = COALESCE($5, notes), updated_at = now()
      WHERE id = $1 AND status <> 'ended' RETURNING *`,
    [id, patch.allow_realtime_auth ?? null, patch.allow_commands ?? null, patch.allow_charging_profiles ?? null, patch.notes ?? null]);
  if (!row) throw new HubError(404, 2000, 'agreement not found (or ended)');
  return row;
}
