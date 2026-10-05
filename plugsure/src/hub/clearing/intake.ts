import { createHash } from 'node:crypto';
import type pg from 'pg';
import { one, tx } from '../../db/pool.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { COUNTRIES } from '../../domain/country.js';
import { isCurrency, toMinor, type CurrencyCode } from '../../domain/money.js';
import { cdrPlausibilityProblem } from '../../ocpi/emsp.js';
import type { CdrRoutedEvent, ForwardOutcome } from '../ledger-tap.js';
import { HubError } from '../errors.js';
import { feesFor, creditFees } from './fees.js';
import { alert, audit } from './notify.js';

/**
 * Intake of routed CDRs into the clearing ledger (docs/HUB-DESIGN.md §8.2, D9). Wired to the router through
 * `setCdrLedger` (ledger-tap.ts) by src/hub/clearing/index.ts when HUB_ENABLED.
 *
 *   admit()       push only, before forwarding: refuses (OCPI 2001, not forwarded) a malformed CDR, a CDR between
 *                 two parties of the same member (self-roaming), and a CDR id the ledger already holds with
 *                 different content (a CDR cannot change: send a credit CDR and a new CDR).
 *   tapCdr()      after routing (push) or for every CDR in a page an eMSP pulled: records it EXACTLY ONCE per
 *                 (CPO party, CDR id) — pushed and pulled, any number of times — validates it and links credits.
 *
 * Hard checks put the CDR on `held` (not settled until a platform admin releases or voids it); the CDR is still
 * forwarded ([OWNER] 14.1-5). Soft checks only flag it (shown to both sides; the eMSP may dispute).
 */

export const HARD_FLAGS = [
  'no_agreement', 'unsupported_currency', 'currency_country_mismatch', 'implausible',
  'credit_unknown_reference', 'credit_amount_mismatch', 'credit_already_applied', 'credit_original_not_payable',
  'cdr_duplicate_conflict', 'not_delivered',
] as const;
export const SOFT_FLAGS = [
  'no_session_seen', 'no_authorization_seen', 'whitelist_token_unknown', 'late_cdr', 'overlap', 'duplicate_session', 'no_incl_vat',
] as const;
export type HardFlag = (typeof HARD_FLAGS)[number];
export type SoftFlag = (typeof SOFT_FLAGS)[number];
export type Flag = HardFlag | SoftFlag | 'released';
export const isHard = (f: string): f is HardFlag => (HARD_FLAGS as readonly string[]).includes(f);

export interface ParsedCdr {
  cdrId: string;
  currency: string;
  supported: boolean;
  credit: boolean;
  creditReferenceId: string | null;
  exclRaw: number;
  inclRaw: number | null;
  exclMinor: number;
  inclMinor: number | null;
  energyKwh: number;
  start: Date;
  end: Date;
  sessionId: string | null;
  locationCountry: string | null;
  locationId: string | null;
  evseUid: string | null;
  authMethod: string | null;
  authorizationReference: string | null;
  tokenType: string | null;
  tokenUid: string | null;
  tokenUidHash: string | null;
  contractId: string | null;
}

const str = (v: unknown, max = 255): string | null => (typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : null);
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Minor units of an amount as received. Supported currencies use domain/money's exponent (IDR 0, MYR/SGD 2),
 * half-up on the first dropped digit; an unsupported currency (held anyway) is kept at 2 decimals.
 */
export function minorOf(v: number, cur: string): number {
  if (isCurrency(cur)) return toMinor(v, cur);
  return toMinor(v, 'SGD' as CurrencyCode);
}

/**
 * Field checks (pure). A malformed CDR is refused on push and skipped (logged) on pull. Credit CDRs are
 * normalised to NEGATIVE totals and energy, whatever sign the CPO sent (OCPI 2.2.1 credit CDRs carry the
 * negative of the original; some platforms send the magnitude with credit = true).
 */
export function parseCdr(e: Pick<CdrRoutedEvent, 'cdr' | 'cdr_id' | 'credit' | 'credit_reference_id' | 'currency' | 'totals' | 'start_date_time' | 'end_date_time' | 'session_id'>): { ok: true; cdr: ParsedCdr } | { ok: false; problem: string } {
  const c = e.cdr as Record<string, any>;
  const id = e.cdr_id;
  if (!id || id.length > 39) return { ok: false, problem: 'a CDR needs an id of at most 39 characters' };
  if (!e.currency || typeof e.currency !== 'string' || !/^[A-Z]{3}$/.test(e.currency)) return { ok: false, problem: 'currency must be an ISO 4217 code' };
  const excl = e.totals.cost_excl_vat;
  const incl = e.totals.cost_incl_vat;
  const kwh = e.totals.energy_kwh;
  if (excl == null) return { ok: false, problem: 'total_cost.excl_vat is required' };
  if (kwh == null) return { ok: false, problem: 'total_energy is required' };
  const start = new Date(String(e.start_date_time ?? ''));
  const end = new Date(String(e.end_date_time ?? ''));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return { ok: false, problem: 'start_date_time and end_date_time are required' };
  if (end < start) return { ok: false, problem: 'end_date_time is before start_date_time' };
  if (!c?.cdr_token || typeof c.cdr_token !== 'object' || !str(c.cdr_token.uid)) return { ok: false, problem: 'cdr_token with a uid is required' };
  if (!c?.cdr_location || typeof c.cdr_location !== 'object') return { ok: false, problem: 'cdr_location is required' };
  if (e.credit && !str(e.credit_reference_id, 39)) return { ok: false, problem: 'a credit CDR needs credit_reference_id (the id of the CDR it credits)' };
  if (!e.credit && (excl < 0 || kwh < 0 || (incl != null && incl < 0))) return { ok: false, problem: 'totals must be zero or more (send a credit CDR to refund)' };
  if (e.credit && Math.abs(excl) === 0 && (incl == null || Math.abs(incl) === 0)) return { ok: false, problem: 'a credit CDR credits a non-zero amount' };
  const sign = e.credit ? -1 : 1;
  const exclRaw = sign * Math.abs(excl);
  const inclRaw = incl == null ? null : sign * Math.abs(incl);
  const uid = str(c.cdr_token.uid, 64);
  return {
    ok: true,
    cdr: {
      cdrId: id, currency: e.currency, supported: isCurrency(e.currency), credit: e.credit, creditReferenceId: e.credit ? str(e.credit_reference_id, 39) : null,
      exclRaw, inclRaw, exclMinor: minorOf(exclRaw, e.currency), inclMinor: inclRaw == null ? null : minorOf(inclRaw, e.currency),
      energyKwh: sign * Math.abs(kwh), start, end,
      sessionId: str(e.session_id, 36), locationCountry: str(c.cdr_location?.country, 3), locationId: str(c.cdr_location?.id, 36),
      evseUid: str(c.cdr_location?.evse_uid, 36), authMethod: str(c.auth_method, 20), authorizationReference: str(c.authorization_reference, 36),
      tokenType: str(c.cdr_token?.type, 20), tokenUid: uid, tokenUidHash: uid ? sha256(uid) : null, contractId: str(c.cdr_token?.contract_id, 36),
    },
  };
}

/** What the database knows about a CDR's context (loaded by `contextOf`; plain values so the flags are pure). */
export interface IntakeContext {
  receivedAt: Date;
  /** The agreement in force at start_at, or mutual open roaming. */
  agreementOk: boolean;
  /** The CPO reports sessions through the hub (the route index has session entries for it). */
  cpoUsesSessions: boolean;
  sessionSeen: boolean;
  authorizationSeen: boolean;
  whitelistTokenKnown: boolean;
  overlap: boolean;
  duplicateSession: boolean;
  /** Credit CDRs: the original (same CPO party, id = credit_reference_id), if any. */
  original: { id: string; status: string; credit: boolean; currency: string; emsp_party_id: string; total_excl_minor: number; total_incl_minor: number | null; credited_by_cdr_id: string | null } | null;
  emspPartyId: string;
}

/** Hard and soft flags of a parsed CDR (pure; every flag has a unit test). */
export function classifyFlags(p: ParsedCdr, ctx: IntakeContext): { flags: Flag[]; holdNote: string | null } {
  const flags: Flag[] = [];
  const notes: string[] = [];
  if (!ctx.agreementOk) { flags.push('no_agreement'); notes.push('no roaming agreement in force between the two parties at the session start'); }
  if (!p.supported) { flags.push('unsupported_currency'); notes.push(`currency ${p.currency} is not settled by the hub (IDR, MYR, SGD)`); }
  else {
    const country = Object.values(COUNTRIES).find((c) => c.alpha3 === p.locationCountry);
    if (!country || country.currency !== p.currency) {
      flags.push('currency_country_mismatch');
      notes.push(`currency ${p.currency} is not the currency of the location's country (${p.locationCountry ?? 'none'})`);
    }
    const problem = cdrPlausibilityProblem({
      currency: p.currency, excl: Math.abs(p.exclRaw), incl: p.inclRaw == null ? null : Math.abs(p.inclRaw), energyKwh: Math.abs(p.energyKwh), start: p.start, end: p.end,
    });
    if (problem) { flags.push('implausible'); notes.push(problem); }
  }
  if (p.credit) {
    const o = ctx.original;
    if (!o || o.credit || o.emsp_party_id !== ctx.emspPartyId || o.currency !== p.currency) { flags.push('credit_unknown_reference'); notes.push(`no CDR ${p.creditReferenceId} of this CPO for this eMSP in ${p.currency} to credit`); }
    else if (o.credited_by_cdr_id) { flags.push('credit_already_applied'); notes.push(`CDR ${p.creditReferenceId} was already credited`); }
    else if (['held', 'void', 'written_off'].includes(o.status)) { flags.push('credit_original_not_payable'); notes.push(`CDR ${p.creditReferenceId} is ${o.status}: there is nothing to credit`); }
    // The amount that moves is incl. tax when present, else excl. (netting.settlementAmount): a credit that omits
    // (or adds) incl_vat would leave the tax (or more) owed on a fully credited CDR, so it must mirror the original.
    else if (-p.exclMinor !== Number(o.total_excl_minor) || (p.inclMinor == null) !== (o.total_incl_minor == null)
      || (p.inclMinor != null && o.total_incl_minor != null && -p.inclMinor !== Number(o.total_incl_minor))) {
      flags.push('credit_amount_mismatch'); notes.push('a credit CDR must be the exact negative of its original (send credit + new CDR for a correction)');
    }
  } else {
    if (p.sessionId && ctx.cpoUsesSessions && !ctx.sessionSeen) flags.push('no_session_seen');
    if ((p.authMethod === 'AUTH_REQUEST' || p.authMethod === 'COMMAND') && !ctx.authorizationSeen) flags.push('no_authorization_seen');
    if (p.authMethod === 'WHITELIST' && !ctx.whitelistTokenKnown) flags.push('whitelist_token_unknown');
    if (ctx.receivedAt.getTime() - p.end.getTime() > config.hub.lateCdrDays * 86_400_000) flags.push('late_cdr');
    if (ctx.overlap) flags.push('overlap');
    if (ctx.duplicateSession) flags.push('duplicate_session');
  }
  if (p.inclMinor == null) flags.push('no_incl_vat');
  return { flags, holdNote: notes.length ? notes.join('; ').slice(0, 1000) : null };
}

const PARSED_TOTALS = (x: { exclMinor: number; inclMinor: number | null; energyKwh: number; currency: string; credit: boolean }) =>
  JSON.stringify([x.currency, x.exclMinor, x.inclMinor, Math.round(x.energyKwh * 1000), x.credit]);
const ROW_TOTALS = (r: { total_excl_minor: string | number; total_incl_minor: string | number | null; energy_kwh: string | number; currency: string; credit: boolean }) =>
  JSON.stringify([r.currency, Number(r.total_excl_minor), r.total_incl_minor == null ? null : Number(r.total_incl_minor), Math.round(Number(r.energy_kwh) * 1000), r.credit]);

/** Before forwarding a pushed CDR: a message refuses it (2001, not forwarded); null forwards it. */
export async function admitCdr(e: CdrRoutedEvent): Promise<string | null> {
  if (e.cpo.member_id === e.emsp.member_id) return 'the CPO and the eMSP are the same hub member: its own drivers on its own chargers are not roaming';
  const p = parseCdr(e);
  if (!p.ok) return p.problem;
  const existing = await one<{ total_excl_minor: string; total_incl_minor: string | null; energy_kwh: string; currency: string; credit: boolean; forward_state: string }>(
    `SELECT total_excl_minor, total_incl_minor, energy_kwh, currency, credit, forward_state FROM hub_cdr WHERE cpo_party_id = $1 AND cdr_id = $2`, [e.cpo.id, p.cdr.cdrId]);
  if (existing && existing.forward_state !== 'failed' && ROW_TOTALS(existing) !== PARSED_TOTALS(p.cdr)) {
    return 'this CDR id was already used with different content: a CDR cannot change (send a credit CDR and a new CDR)';
  }
  return null;
}

async function contextOf(c: pg.PoolClient, e: CdrRoutedEvent, p: ParsedCdr, receivedAt: Date): Promise<IntakeContext> {
  const q1 = async <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => (await c.query<T>(sql, params)).rows[0] ?? null;
  let agreementOk: boolean;
  if (e.agreement_id) {
    agreementOk = !!(await q1(`SELECT 1 FROM hub_agreement WHERE id = $1 AND cpo_party_id = $2 AND emsp_party_id = $3
                                 AND (valid_from IS NULL OR valid_from <= $4) AND (valid_to IS NULL OR valid_to > $4)`, [e.agreement_id, e.cpo.id, e.emsp.id, p.start]));
  } else {
    const open = await q1<{ n: number }>(`SELECT count(*)::int AS n FROM hub_member WHERE id = ANY($1::uuid[]) AND open_roaming`, [[e.cpo.member_id, e.emsp.member_id]]);
    agreementOk = open?.n === 2;
  }
  const exists = async (sql: string, params: unknown[]) => !!(await q1(sql, params));
  return {
    receivedAt, agreementOk, emspPartyId: e.emsp.id,
    cpoUsesSessions: await exists(`SELECT 1 FROM hub_route_index WHERE kind = 'session' AND owner_party_id = $1 LIMIT 1`, [e.cpo.id]),
    sessionSeen: !!p.sessionId && await exists(`SELECT 1 FROM hub_route_index WHERE kind = 'session' AND key = $1 AND owner_party_id = $2`, [p.sessionId, e.cpo.id]),
    authorizationSeen: !!p.authorizationReference && await exists(
      `SELECT 1 FROM hub_route_index WHERE kind = 'authorization' AND key = $1 AND owner_party_id = $2 AND (counter_party_id IS NULL OR counter_party_id = $3)`,
      [p.authorizationReference, e.emsp.id, e.cpo.id]),
    whitelistTokenKnown: !!p.tokenUid && await exists(`SELECT 1 FROM hub_route_index WHERE kind = 'token' AND key = $1 AND owner_party_id = $2`, [`${p.tokenUid}:${p.tokenType ?? 'RFID'}`, e.emsp.id]),
    overlap: !!p.tokenUidHash && await exists(
      `SELECT 1 FROM hub_cdr WHERE token_uid_hash = $1 AND NOT credit AND status <> 'void' AND cdr_id <> $2
          AND start_at < $4 AND end_at > $3 AND (cpo_party_id <> $5 OR evse_uid IS DISTINCT FROM $6) LIMIT 1`,
      [p.tokenUidHash, p.cdrId, p.start, p.end, e.cpo.id, p.evseUid]),
    duplicateSession: !!p.sessionId && await exists(
      `SELECT 1 FROM hub_cdr WHERE cpo_party_id = $1 AND session_id = $2 AND NOT credit AND cdr_id <> $3 AND status <> 'void' LIMIT 1`, [e.cpo.id, p.sessionId, p.cdrId]),
    original: p.credit && p.creditReferenceId
      ? await q1(`SELECT id, status, credit, currency, emsp_party_id, total_excl_minor::bigint AS total_excl_minor, total_incl_minor, credited_by_cdr_id
                    FROM hub_cdr WHERE cpo_party_id = $1 AND cdr_id = $2 FOR UPDATE`, [e.cpo.id, p.creditReferenceId])
      : null,
  };
}

async function disputeDays(c: pg.PoolClient, agreementId: string | null): Promise<number> {
  if (!agreementId) return config.hub.disputeDays;
  const r = (await c.query<{ d: number | null }>(`SELECT dispute_days AS d FROM hub_agreement WHERE id = $1`, [agreementId])).rows[0];
  return r?.d ?? config.hub.disputeDays;
}

export interface TapResult { id: string; created: boolean; status: string; flags: string[] }

/**
 * Record a routed CDR (idempotent per CPO party + CDR id). Never throws into the router (ledger-tap.ts logs).
 */
export async function tapCdr(e: CdrRoutedEvent, forward: ForwardOutcome | null, now: Date = new Date()): Promise<TapResult | null> {
  if (e.cpo.member_id === e.emsp.member_id) {
    logger.warn({ cdr: e.cdr_id, member: e.cpo.member_id }, 'hub ledger: self-roaming CDR not recorded');
    return null;
  }
  const parsed = parseCdr(e);
  if (!parsed.ok) {
    logger.warn({ cdr: e.cdr_id, source: e.source, problem: parsed.problem }, 'hub ledger: malformed CDR not recorded');
    return null;
  }
  const p = parsed.cdr;
  const forwardState = e.source === 'pull' ? 'not_needed' : forward?.delivered ? 'delivered' : 'failed';
  const after: Array<() => void> = [];
  const result = await tx(async (c) => {
    // Serialise every tap of this (CPO party, CDR id): pushes and pulls may arrive together.
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('hub_cdr:' || $1 || ':' || $2, 0))`, [e.cpo.id, p.cdrId]);
    const existing = (await c.query(`SELECT * FROM hub_cdr WHERE cpo_party_id = $1 AND cdr_id = $2 FOR UPDATE`, [e.cpo.id, p.cdrId])).rows[0];
    if (existing) return seenAgain(c, existing, e, p, forwardState, now, after);
    const ctx = await contextOf(c, e, p, now);
    const { flags, holdNote } = classifyFlags(p, ctx);
    if (forwardState === 'failed') flags.push('not_delivered');
    const days = await disputeDays(c, e.agreement_id);
    const hard = flags.filter(isHard);
    const status = hard.length ? 'held' : p.credit ? 'accepted' : 'pending';
    const row = (await c.query(
      `INSERT INTO hub_cdr (cpo_party_id, emsp_party_id, cpo_member_id, emsp_member_id, cpo_org_id, emsp_org_id, agreement_id, cdr_id, session_id,
                            credit, credit_reference_id, currency, total_excl_minor, total_incl_minor, total_excl_raw, total_incl_raw, energy_kwh,
                            start_at, end_at, location_country, location_id, evse_uid, auth_method, authorization_reference, token_type, token_uid_hash,
                            contract_id, body, source, routing, flags, status, dispute_deadline, forward_state, hold_note, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,
               $33::timestamptz + make_interval(days => $34), $35, $36, $33)
       ON CONFLICT (cpo_party_id, cdr_id) DO NOTHING RETURNING *`,
      [e.cpo.id, e.emsp.id, e.cpo.member_id, e.emsp.member_id, e.cpo.org_id, e.emsp.org_id, e.agreement_id, p.cdrId, p.sessionId,
        p.credit, p.creditReferenceId, p.currency, p.exclMinor, p.inclMinor, p.exclRaw, p.inclRaw, p.energyKwh,
        p.start, p.end, p.locationCountry, p.locationId, p.evseUid, p.authMethod, p.authorizationReference, p.tokenType, p.tokenUidHash,
        p.contractId, JSON.stringify(e.cdr), e.source, JSON.stringify({ ...e.routing, at: e.at }), flags, status, now, days, forwardState, holdNote],
    )).rows[0];
    if (!row) return null;
    if (status === 'accepted' && p.credit && ctx.original) await applyCredit(c, row, ctx.original.id, now, after);
    if (hard.length) {
      after.push(() => alert(null, 'hub.cdr_held', `Hub CDR ${p.cdrId} (${e.cpo.country_code}*${e.cpo.party_id} → ${e.emsp.country_code}*${e.emsp.party_id}) is held: ${hard.join(', ')}. ${holdNote ?? ''}`,
        { type: 'hub_cdr', id: row.id }));
    }
    return { id: row.id as string, created: true, status, flags };
  });
  for (const f of after) f();
  return result;
}

/** The same (CPO party, CDR id) again: same content → only delivery state; different → conflict (or a replaced undelivered push). */
async function seenAgain(c: pg.PoolClient, row: any, e: CdrRoutedEvent, p: ParsedCdr, forwardState: string, now: Date, after: Array<() => void>): Promise<TapResult> {
  const same = ROW_TOTALS(row) === PARSED_TOTALS(p);
  const reached = forwardState !== 'failed';
  if (same) {
    if (reached && row.forward_state === 'failed') {
      // An undelivered push that got through (a retry, or the eMSP pulled it): no longer on hold for that.
      const flags = (row.flags as string[]).filter((f) => f !== 'not_delivered');
      const stillHard = flags.some(isHard);
      const status = row.status === 'held' && !stillHard ? 'pending' : row.status;
      await c.query(`UPDATE hub_cdr SET forward_state = $2, flags = $3, status = $4, updated_at = now(),
                            dispute_deadline = CASE WHEN $4 = 'pending' AND status = 'held' THEN $5::timestamptz + make_interval(days => $6) ELSE dispute_deadline END
                      WHERE id = $1`, [row.id, forwardState, flags, status, now, await disputeDays(c, row.agreement_id)]);
      return { id: row.id, created: false, status, flags };
    }
    return { id: row.id, created: false, status: row.status, flags: row.flags };
  }
  const replaceable = row.forward_state === 'failed' && !row.settlement_run_id && !row.credited_by_cdr_id && ['held', 'pending'].includes(row.status)
    && !(await c.query(`SELECT 1 FROM hub_dispute WHERE hub_cdr_id = $1 LIMIT 1`, [row.id])).rowCount;
  if (replaceable) {
    // The eMSP never received the earlier version: the CPO may correct it under the same id. Re-validate.
    await c.query(`DELETE FROM hub_cdr WHERE id = $1`, [row.id]);
    const ctx = await contextOf(c, e, p, now);
    const { flags, holdNote } = classifyFlags(p, ctx);
    if (!reached) flags.push('not_delivered');
    const hard = flags.filter(isHard);
    const status = hard.length ? 'held' : p.credit ? 'accepted' : 'pending';
    const days = await disputeDays(c, e.agreement_id);
    const nrow = (await c.query(
      `INSERT INTO hub_cdr (id, cpo_party_id, emsp_party_id, cpo_member_id, emsp_member_id, cpo_org_id, emsp_org_id, agreement_id, cdr_id, session_id,
                            credit, credit_reference_id, currency, total_excl_minor, total_incl_minor, total_excl_raw, total_incl_raw, energy_kwh,
                            start_at, end_at, location_country, location_id, evse_uid, auth_method, authorization_reference, token_type, token_uid_hash,
                            contract_id, body, source, routing, flags, status, dispute_deadline, forward_state, hold_note, received_at)
       VALUES ($37,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,
               $33::timestamptz + make_interval(days => $34), $35, $36, $33) RETURNING *`,
      [e.cpo.id, e.emsp.id, e.cpo.member_id, e.emsp.member_id, e.cpo.org_id, e.emsp.org_id, e.agreement_id, p.cdrId, p.sessionId,
        p.credit, p.creditReferenceId, p.currency, p.exclMinor, p.inclMinor, p.exclRaw, p.inclRaw, p.energyKwh,
        p.start, p.end, p.locationCountry, p.locationId, p.evseUid, p.authMethod, p.authorizationReference, p.tokenType, p.tokenUidHash,
        p.contractId, JSON.stringify(e.cdr), e.source, JSON.stringify({ ...e.routing, at: e.at, replaced_undelivered: true }), flags, status, now, days, forwardState, holdNote, row.id],
    )).rows[0];
    if (status === 'accepted' && p.credit && ctx.original) await applyCredit(c, nrow, ctx.original.id, now, after);
    return { id: row.id, created: false, status, flags };
  }
  if (!(row.flags as string[]).includes('cdr_duplicate_conflict')) {
    await c.query(`UPDATE hub_cdr SET flags = array_append(flags, 'cdr_duplicate_conflict'), updated_at = now() WHERE id = $1`, [row.id]);
    after.push(() => alert(null, 'hub.cdr_conflict', `Hub CDR ${p.cdrId} of ${e.cpo.country_code}*${e.cpo.party_id} was seen again (${e.source}) with different totals; the ledger keeps the first version.`,
      { type: 'hub_cdr', id: row.id }));
  }
  return { id: row.id, created: false, status: row.status, flags: [...row.flags, 'cdr_duplicate_conflict'] };
}

/**
 * Link a credit CDR to its original and make both payable: the original's fees are frozen (now, if it had none
 * yet), the credit's are their reversal; an open dispute on the original is resolved `credited`.
 * Both settle in the next run that takes them (net zero when neither was settled; an offset when the
 * original was settled earlier).
 */
export async function applyCredit(c: pg.PoolClient, credit: any, originalId: string, now: Date, after: Array<() => void>): Promise<void> {
  const o = (await c.query(`SELECT * FROM hub_cdr WHERE id = $1 FOR UPDATE`, [originalId])).rows[0];
  if (!o) return;
  let feeCpo = o.fee_cpo_minor == null ? null : Number(o.fee_cpo_minor);
  let feeEmsp = o.fee_emsp_minor == null ? null : Number(o.fee_emsp_minor);
  if (feeCpo == null || feeEmsp == null) {
    const f = await feesFor(o);
    feeCpo = f.cpo; feeEmsp = f.emsp;
    await c.query(`UPDATE hub_cdr SET fee_cpo_minor = $2, fee_emsp_minor = $3, fee_cpo_plan_id = $4, fee_emsp_plan_id = $5 WHERE id = $1`, [o.id, feeCpo, feeEmsp, f.cpoPlanId, f.emspPlanId]);
  }
  const cf = creditFees({ exclMinor: Number(o.total_excl_minor), feeCpo, feeEmsp }, Number(credit.total_excl_minor));
  await c.query(`UPDATE hub_cdr SET status = 'credited', credited_by_cdr_id = $2, accepted_at = COALESCE(accepted_at, $3), updated_at = now() WHERE id = $1`, [o.id, credit.id, now]);
  await c.query(`UPDATE hub_cdr SET status = 'accepted', credits_cdr_id = $2, accepted_at = $3, fee_cpo_minor = $4, fee_emsp_minor = $5,
                        fee_cpo_plan_id = $6, fee_emsp_plan_id = $7, updated_at = now() WHERE id = $1`,
  [credit.id, o.id, now, cf.cpo, cf.emsp, o.fee_cpo_plan_id, o.fee_emsp_plan_id]);
  const d = (await c.query(`UPDATE hub_dispute SET status = 'credited', resolution = 'credited', credit_cdr_id = $2, resolved_at = $3, updated_at = now()
                             WHERE hub_cdr_id = $1 AND status IN ('open','accepted','rejected','escalated') RETURNING *`, [o.id, credit.id, now])).rows[0];
  if (d) {
    await c.query(`INSERT INTO hub_dispute_note (dispute_id, cpo_org_id, emsp_org_id, side, kind, body) VALUES ($1,$2,$3,'system','credited',$4)`,
      [d.id, d.cpo_org_id, d.emsp_org_id, `Credit CDR ${credit.cdr_id} received from the CPO: the disputed CDR is credited.`]);
    after.push(() => {
      alert(d.emsp_org_id, 'hub.dispute_updated', `Your dispute on hub CDR ${o.cdr_id} is resolved: the CPO sent credit CDR ${credit.cdr_id}.`, { type: 'hub_dispute', id: d.id }, 'info');
      void audit('hub.dispute_credited', 'hub_dispute', d.id, { orgIds: [d.cpo_org_id, d.emsp_org_id], after: { credit_cdr: credit.cdr_id } });
    });
  }
}

// ───────────────────────────────────────────────────────────── platform decisions on held CDRs

/**
 * A platform admin releases a held CDR: a normal CDR becomes `pending` with a fresh dispute window (its flags
 * stay, plus `released`); a held credit CDR is paired with its original even when the amounts differ (a
 * partial credit: fees reversed pro rata) and becomes `accepted`.
 */
export async function releaseCdr(id: string, actorId: string | null, noteText: string, now: Date = new Date()) {
  const after: Array<() => void> = [];
  const out = await tx(async (c) => {
    const r = (await c.query(`SELECT * FROM hub_cdr WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!r) throw new HubError(404, 2000, 'CDR not found');
    if (r.status !== 'held') throw new HubError(409, 2000, `only a held CDR can be released (this one is ${r.status})`);
    const note = `${r.hold_note ? `${r.hold_note}; ` : ''}released: ${noteText}`.slice(0, 2000);
    if (r.credit) {
      const o = (await c.query(`SELECT id, status, credited_by_cdr_id FROM hub_cdr WHERE cpo_party_id = $1 AND cdr_id = $2 AND NOT credit FOR UPDATE`, [r.cpo_party_id, r.credit_reference_id])).rows[0];
      if (!o || o.credited_by_cdr_id || ['held', 'void', 'written_off'].includes(o.status)) {
        throw new HubError(409, 2000, 'this credit CDR has no payable original to offset: void it (or release the original first)');
      }
      await c.query(`UPDATE hub_cdr SET flags = array_append(flags, 'released'), hold_note = $2, updated_at = now() WHERE id = $1`, [id, note]);
      await applyCredit(c, r, o.id, now, after);
    } else {
      await c.query(`UPDATE hub_cdr SET status = 'pending', flags = array_append(flags, 'released'), hold_note = $2, updated_at = now(),
                            dispute_deadline = $3::timestamptz + make_interval(days => $4) WHERE id = $1`, [id, note, now, await disputeDays(c, r.agreement_id)]);
    }
    after.push(() => void audit('hub.cdr_released', 'hub_cdr', id, { actorId, orgIds: [r.cpo_org_id, r.emsp_org_id], after: { cdr: r.cdr_id, flags: r.flags, note: noteText } }));
    return (await c.query(`SELECT id, status, flags, dispute_deadline FROM hub_cdr WHERE id = $1`, [id])).rows[0];
  });
  for (const f of after) f();
  return out;
}

/** A platform admin voids a held or pending CDR (never settled; e.g. a test or garbage CDR). */
export async function voidCdr(id: string, actorId: string | null, noteText: string) {
  const r = await one(`UPDATE hub_cdr SET status = 'void', hold_note = left(COALESCE(hold_note || '; ', '') || 'void: ' || $2, 2000), updated_at = now()
                        WHERE id = $1 AND status IN ('held','pending') AND settlement_run_id IS NULL RETURNING id, cdr_id, status, cpo_org_id, emsp_org_id`, [id, noteText]);
  if (!r) throw new HubError(409, 2000, 'only a held or pending CDR can be voided');
  await audit('hub.cdr_void', 'hub_cdr', id, { actorId, orgIds: [r.cpo_org_id, r.emsp_org_id], after: { cdr: r.cdr_id, note: noteText } });
  return r;
}
