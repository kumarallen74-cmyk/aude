import { logger } from '../logger.js';

/**
 * The clearing ledger's hook into the router (design D9, §8.2). H1 calls it; H2 implements it
 * (`setCdrLedger(...)` at start-up, from src/hub/clearing/intake.ts). Until then it is a no-op.
 *
 * Where it is called
 *   - push:  a CPO POSTs a CDR to receiver/cdrs and the hub routes it to the eMSP (direct or open routing).
 *            `admit` runs BEFORE forwarding (H2 may refuse a malformed CDR: the CPO gets 2001 and nothing is
 *            forwarded); `onCdrRouted` runs AFTER the forward attempt, with its outcome. A duplicate POST
 *            already delivered (same CPO party + CDR id) is answered from the hub's state and does NOT call
 *            the hook again.
 *   - pull:  an eMSP GETs sender/cdrs through the hub (direct or GET All): `onCdrRouted` runs once per CDR in
 *            the page the eMSP receives (after the response filter), with `forward = null`. The same CDR
 *            pulled twice is reported twice: H2 inserts ON CONFLICT (cpo_party_id, cdr_id) DO NOTHING.
 *
 * Contract
 *   - Called outside any request transaction; the hook's failures are logged and never change the routing
 *     answer (except `admit`'s explicit refusal). It must be idempotent per (cpo.party_id, cdr_id).
 *   - Amounts are passed through exactly as received (OCPI 4-dp decimals); H2 converts to minor units.
 *   - `cdr` is the raw object as forwarded (the hub never alters a CDR: no rewrite, last_updated untouched).
 */

export interface CdrPartyRef {
  /** hub_party.id */
  id: string;
  country_code: string;
  party_id: string;
  role: string;
  member_id: string;
  org_id: string;
}

export interface CdrRoutedEvent {
  source: 'push' | 'pull';
  cpo: CdrPartyRef;
  emsp: CdrPartyRef;
  /** hub_agreement.id in force between the two at routing time; null under mutual open roaming. */
  agreement_id: string | null;
  cdr_id: string;
  session_id: string | null;
  credit: boolean;
  credit_reference_id: string | null;
  /** ISO 4217 as in the CDR (IDR, MYR, SGD — others are H2's to hold). */
  currency: string;
  totals: {
    cost_excl_vat: number | null;
    cost_incl_vat: number | null;
    energy_kwh: number | null;
    time_hours: number | null;
    parking_time_hours: number | null;
  };
  start_date_time: string | null;
  end_date_time: string | null;
  last_updated: string | null;
  /** The CDR exactly as routed. */
  cdr: Record<string, unknown>;
  routing: {
    correlation_id: string;
    request_id_in: string | null;
    request_id_out: string | null;
    route: 'direct' | 'open' | 'get_all';
    from_connection_id: string;
    to_connection_id: string | null;
    /** The hub Location handed to the CPO (push), e.g. https://hub…/hub/ocpi/2.2.1/receiver/cdrs/{id}. */
    hub_location: string | null;
  };
  at: string;
}

export interface ForwardOutcome {
  delivered: boolean;
  http_status: number | null;
  ocpi_status: number | null;
  error: string | null;
  /** The eMSP's own Location header, when it gave one. */
  emsp_location: string | null;
}

export interface CdrLedger {
  /** Optional pre-forward check on pushed CDRs. Return a message to refuse (2001) and not forward. */
  admit?(e: CdrRoutedEvent): Promise<string | null>;
  onCdrRouted(e: CdrRoutedEvent, forward: ForwardOutcome | null): Promise<void>;
}

const noop: CdrLedger = { async onCdrRouted() { /* H2 */ } };
let ledger: CdrLedger = noop;

export function setCdrLedger(l: CdrLedger | null): void { ledger = l ?? noop; }

export async function admitCdr(e: CdrRoutedEvent): Promise<string | null> {
  if (!ledger.admit) return null;
  try { return await ledger.admit(e); } catch (err) {
    logger.error({ err: (err as Error).message, cdr: e.cdr_id }, 'hub ledger admit failed; forwarding anyway');
    return null;
  }
}

export async function onCdrRouted(e: CdrRoutedEvent, forward: ForwardOutcome | null): Promise<void> {
  try { await ledger.onCdrRouted(e, forward); } catch (err) {
    logger.error({ err: (err as Error).message, cdr: e.cdr_id }, 'hub ledger tap failed');
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Build the event from a CDR body (pure; unit-tested). */
export function cdrEvent(cdr: any, cpo: CdrPartyRef, emsp: CdrPartyRef, routing: CdrRoutedEvent['routing'], source: 'push' | 'pull', agreementId: string | null): CdrRoutedEvent {
  return {
    source, cpo, emsp, agreement_id: agreementId,
    cdr_id: String(cdr?.id ?? ''),
    session_id: typeof cdr?.session_id === 'string' ? cdr.session_id : null,
    credit: cdr?.credit === true,
    credit_reference_id: typeof cdr?.credit_reference_id === 'string' ? cdr.credit_reference_id : null,
    currency: String(cdr?.currency ?? ''),
    totals: {
      cost_excl_vat: num(cdr?.total_cost?.excl_vat),
      cost_incl_vat: num(cdr?.total_cost?.incl_vat),
      energy_kwh: num(cdr?.total_energy),
      time_hours: num(cdr?.total_time),
      parking_time_hours: num(cdr?.total_parking_time),
    },
    start_date_time: typeof cdr?.start_date_time === 'string' ? cdr.start_date_time : null,
    end_date_time: typeof cdr?.end_date_time === 'string' ? cdr.end_date_time : null,
    last_updated: typeof cdr?.last_updated === 'string' ? cdr.last_updated : null,
    cdr: cdr && typeof cdr === 'object' ? cdr : {},
    routing,
    at: new Date().toISOString(),
  };
}
