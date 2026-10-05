import type { Endpoint } from '../ocpi/store.js';

/** Row shapes of migration 072 (H2 builds on these). */

export type HubRole = 'CPO' | 'EMSP' | 'NSP' | 'OTHER' | 'SCSP' | 'NAP';
export type PartyStatus = 'CONNECTED' | 'OFFLINE' | 'PLANNED' | 'SUSPENDED';

export interface HubMember {
  id: string;
  org_id: string;
  kind: 'internal' | 'external';
  legal_name: string;
  country_code: 'ID' | 'MY' | 'SG';
  tax_id: string | null;
  billing_email: string | null;
  status: 'onboarding' | 'active' | 'suspended' | 'terminated';
  open_roaming: boolean;
  fee_plan_id: string | null;
  contract_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface HubConnection {
  id: string;
  member_id: string;
  kind: 'external' | 'internal';
  state: 'pending' | 'connected' | 'suspended' | 'closed';
  token_in_hash: string | null;
  token_in: string | null;
  token_prev_hash: string | null;
  token_prev_until: Date | null;
  token_out: string | null;
  versions_url: string | null;
  version: string | null;
  endpoints: Endpoint[];
  peer_org_id: string | null;
  peer_partner_id: string | null;
  rate_limit_per_min: number;
  realtime_limit_per_min: number;
  capture_bodies_until: Date | null;
  last_inbound_at: Date | null;
  last_alive_ok_at: Date | null;
  alive_failures: number;
  last_error: string | null;
  registered_at: Date | null;
  created_at: Date;
}

export interface HubParty {
  id: string;
  member_id: string;
  org_id: string;
  connection_id: string | null;
  country_code: string;
  party_id: string;
  role: HubRole;
  business_name: string;
  website: string | null;
  status: PartyStatus;
  admin_suspended: boolean;
  status_changed_at: Date;
}

export interface HubAgreement {
  id: string;
  cpo_party_id: string;
  emsp_party_id: string;
  cpo_org_id: string;
  emsp_org_id: string;
  status: 'proposed' | 'active' | 'suspended' | 'ended';
  proposed_by: 'cpo' | 'emsp' | 'platform';
  cpo_accepted_at: Date | null;
  emsp_accepted_at: Date | null;
  valid_from: Date | null;
  valid_to: Date | null;
  allow_realtime_auth: boolean;
  allow_commands: boolean;
  allow_charging_profiles: boolean;
  fee_plan_id: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A party as `CC*PID`. */
export const label = (p: { country_code: string; party_id: string } | null | undefined) => (p ? `${p.country_code}*${p.party_id}` : '');

/** CPO side vs eMSP side (OCPI "opposite role"; OTHER, NSP and SCSP count as the eMSP type). */
export const isCpoRole = (r: string) => r === 'CPO';
export const isEmspSide = (r: string) => r === 'EMSP' || r === 'OTHER' || r === 'NSP' || r === 'SCSP';
