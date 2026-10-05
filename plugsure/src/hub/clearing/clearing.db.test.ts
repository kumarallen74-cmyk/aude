import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { config } from '../../config.js';
import { many, one, query } from '../../db/pool.js';
import { databaseTestLock } from '../../db/test-lock.js';
import { HubError } from '../errors.js';
import { bus } from '../../services/events.js';
import { NIL_ORG } from '../../services/audit.js';

const raised: Array<{ orgId: string; kind: string; targetId?: string }> = [];
bus.on('alert.raised', (a) => { raised.push(a); });

/**
 * Clearing and settlement against the database (WP H2): exactly-once intake (push + pull), admission rules,
 * credit pairing, autoAccept and disputes, settlement runs (idempotent drafts, finalise once), netting of three
 * members in two currencies by hand, time-zone cut-off, statements, fee invoices, payments, overdue, and
 * row-level security (a member sees only its own ledger, statements and positions).
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/hub/clearing/clearing.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[clearing.db.test] SKIPPING (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const saved = { ...config.hub };
Object.assign(config.hub, { enabled: true, disputeDays: 14, disputeResponseDays: 10, disputeEscalateDays: 5, creditDueDays: 10, paymentTermsDays: 14, cycle: 'monthly' });

const { cdrEvent } = await import('../ledger-tap.js');
const { tapCdr, admitCdr, releaseCdr } = await import('./intake.js');
const { autoAccept } = await import('./accept.js');
const { raiseDispute, transition, escalateOverdue } = await import('./disputes.js');
const { buildRun, finaliseRun, recordPayment, confirmPayment, markOverdue } = await import('./settlement.js');
const { periodBounds } = await import('./period.js');
const { createExternalMember } = await import('../registry.js');
type CdrPartyRef = import('../ledger-tap.js').CdrPartyRef;

const TAG = randomBytes(3).toString('hex');
const PREFIX = 'Clearing DB Test';
const pidOf = (c: string) => `${c}${randomBytes(2).toString('hex').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 2).padEnd(2, '7')}`;
// A past month nobody else settles: picked at random, unused by any run.
const YEAR = 2001 + Math.floor(Math.random() * 18);
const MONTH = 1 + Math.floor(Math.random() * 11);
const PERIOD = `${YEAR}-${String(MONTH).padStart(2, '0')}`;
const NEXT = `${YEAR}-${String(MONTH + 1).padStart(2, '0')}`;

interface M { id: string; org_id: string; cc: string; pid: string; cpo: CdrPartyRef; emsp: CdrPartyRef }
const members: Record<'A' | 'B' | 'C', M> = {} as any;
const agreements = new Map<string, string>();
let planId = '';

async function cleanup() {
  const ms = (await many<{ id: string; org_id: string }>(`SELECT id, org_id FROM hub_member WHERE legal_name LIKE $1`, [`${PREFIX} %`]));
  const ids = ms.map((m) => m.id);
  if (ids.length) {
    const runs = (await many<{ id: string }>(`SELECT DISTINCT run_id AS id FROM hub_statement WHERE member_id = ANY($1::uuid[])
                                               UNION SELECT DISTINCT settlement_run_id FROM hub_cdr WHERE settlement_run_id IS NOT NULL AND (cpo_member_id = ANY($1::uuid[]) OR emsp_member_id = ANY($1::uuid[]))`, [ids])).map((r) => r.id);
    await query(`DELETE FROM hub_payment WHERE payer_member_id = ANY($1::uuid[]) OR payee_member_id = ANY($1::uuid[])`, [ids]);
    await query(`DELETE FROM hub_settlement_position WHERE member_a_id = ANY($1::uuid[]) OR member_b_id = ANY($1::uuid[])`, [ids]);
    await query(`DELETE FROM hub_statement WHERE member_id = ANY($1::uuid[])`, [ids]);
    await query(`DELETE FROM hub_fee_invoice WHERE member_id = ANY($1::uuid[])`, [ids]);
    const cdrs = (await many<{ id: string }>(`SELECT id FROM hub_cdr WHERE cpo_member_id = ANY($1::uuid[]) OR emsp_member_id = ANY($1::uuid[])`, [ids])).map((r) => r.id);
    await query(`DELETE FROM hub_dispute_note WHERE dispute_id IN (SELECT id FROM hub_dispute WHERE hub_cdr_id = ANY($1::uuid[]))`, [cdrs]);
    await query(`DELETE FROM hub_dispute WHERE hub_cdr_id = ANY($1::uuid[])`, [cdrs]);
    await query(`UPDATE hub_cdr SET credits_cdr_id = NULL, credited_by_cdr_id = NULL WHERE id = ANY($1::uuid[])`, [cdrs]);
    await query(`DELETE FROM hub_cdr WHERE id = ANY($1::uuid[])`, [cdrs]);
    await query(`DELETE FROM hub_settlement_run WHERE id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM hub_cdr WHERE settlement_run_id = hub_settlement_run.id)
                   AND NOT EXISTS (SELECT 1 FROM hub_statement WHERE run_id = hub_settlement_run.id)`, [runs]);
    await query(`DELETE FROM hub_fee_assignment WHERE member_id = ANY($1::uuid[])`, [ids]);
    const ps = (await many<{ id: string }>(`SELECT id FROM hub_party WHERE member_id = ANY($1::uuid[])`, [ids])).map((p) => p.id);
    await query(`DELETE FROM hub_fee_assignment WHERE agreement_id IN (SELECT id FROM hub_agreement WHERE cpo_party_id = ANY($1::uuid[]))`, [ps]);
    await query(`DELETE FROM hub_agreement WHERE cpo_party_id = ANY($1::uuid[]) OR emsp_party_id = ANY($1::uuid[])`, [ps]);
    await query(`DELETE FROM hub_party WHERE member_id = ANY($1::uuid[])`, [ids]);
    await query(`DELETE FROM hub_party_key WHERE member_id = ANY($1::uuid[])`, [ids]);
    await query(`DELETE FROM hub_member WHERE id = ANY($1::uuid[])`, [ids]);
    // The members' organisations stay: their audit chains are append-only (audit_log references them).
  }
  await query(`DELETE FROM hub_settlement_run r WHERE r.status = 'draft' AND r.period_start < '2020-01-01' AND NOT EXISTS (SELECT 1 FROM hub_statement s WHERE s.run_id = r.id)`);
  await query(`DELETE FROM hub_fee_plan p WHERE p.name LIKE $1 AND NOT EXISTS (SELECT 1 FROM hub_fee_assignment f WHERE f.fee_plan_id = p.id)
                 AND NOT EXISTS (SELECT 1 FROM hub_cdr c WHERE c.fee_cpo_plan_id = p.id OR c.fee_emsp_plan_id = p.id)`, [`${PREFIX} %`]);
}

async function mkMember(key: 'A' | 'B' | 'C', country: 'ID' | 'MY' | 'SG') {
  const m = await createExternalMember({ legal_name: `${PREFIX} ${key} ${TAG}`, country_code: country });
  await query(`UPDATE hub_member SET status = 'active' WHERE id = $1`, [m.id]);
  const pid = pidOf(key);
  await query(`INSERT INTO hub_party_key (country_code, party_id, member_id) VALUES ($1,$2,$3)`, [country, pid, m.id]);
  const ref = async (role: string): Promise<CdrPartyRef> => {
    const p = await one(`INSERT INTO hub_party (member_id, org_id, country_code, party_id, role, business_name, status) VALUES ($1,$2,$3,$4,$5,$6,'CONNECTED') RETURNING id`,
      [m.id, m.org_id, country, pid, role, `${key} ${role}`]);
    return { id: p.id, country_code: country, party_id: pid, role, member_id: m.id, org_id: m.org_id };
  };
  members[key] = { id: m.id, org_id: m.org_id, cc: country, pid, cpo: await ref('CPO'), emsp: await ref('EMSP') };
}

const routing = { correlation_id: 'corr', request_id_in: 'rin', request_id_out: 'rout', route: 'direct' as const, from_connection_id: '00000000-0000-4000-8000-000000000001', to_connection_id: null, hub_location: null };
const ALPHA3: Record<string, string> = { IDR: 'IDN', MYR: 'MYS', SGD: 'SGP' };
const pStart = () => periodBounds('MYR', PERIOD)!.start;
const day = (n: number, base = pStart()) => new Date(base.getTime() + n * 86_400_000);

function ev(cpo: 'A' | 'B' | 'C', emsp: 'A' | 'B' | 'C', id: string, o: { cur?: string; excl: number; incl?: number | null; kwh?: number; at: Date; credit?: string; source?: 'push' | 'pull'; agreement?: string | null }) {
  const cur = o.cur ?? 'MYR';
  const start = new Date(o.at.getTime() - 2 * 3600_000);
  const body: Record<string, unknown> = {
    country_code: members[cpo].cc, party_id: members[cpo].pid, id, start_date_time: start.toISOString(), end_date_time: new Date(start.getTime() + 3600_000).toISOString(),
    session_id: `S-${id}`, cdr_token: { country_code: members[emsp].cc, party_id: members[emsp].pid, uid: `U-${id}`, type: 'RFID', contract_id: `C-${id}` },
    cdr_location: { id: `L-${cpo}`, country: ALPHA3[cur] ?? 'XXX', evse_uid: `E-${id}` }, currency: cur,
    total_cost: o.incl === null ? { excl_vat: o.excl } : { excl_vat: o.excl, incl_vat: o.incl ?? o.excl }, total_energy: o.kwh ?? (o.credit ? -2 : 2), last_updated: o.at.toISOString(),
    ...(o.credit ? { credit: true, credit_reference_id: o.credit } : {}),
  };
  const agr = o.agreement === undefined ? agreements.get(`${cpo}${emsp}`) ?? null : o.agreement;
  return cdrEvent(body, members[cpo].cpo, members[emsp].emsp, routing, o.source ?? 'push', agr);
}
const delivered = { delivered: true, http_status: 200, ocpi_status: 1000, error: null, emsp_location: null };
const failed = { delivered: false, http_status: 503, ocpi_status: null, error: 'down', emsp_location: null };
const row = (cpo: 'A' | 'B' | 'C', id: string) => one(`SELECT * FROM hub_cdr WHERE cpo_party_id = $1 AND cdr_id = $2`, [members[cpo].cpo.id, id]);
const rejects = async (p: Promise<unknown>, status: number, re?: RegExp) => assert.rejects(p, (e: unknown) => e instanceof HubError && e.http === status && (!re || re.test(e.message)));

if (DB_OK) {
  before(async () => {
    await cleanup();
    await mkMember('A', 'MY'); await mkMember('B', 'SG'); await mkMember('C', 'ID');
    for (const [c, e] of [['A', 'B'], ['B', 'A'], ['A', 'C'], ['C', 'A'], ['B', 'C'], ['C', 'B']] as const) {
      const a = await one(`INSERT INTO hub_agreement (cpo_party_id, emsp_party_id, cpo_org_id, emsp_org_id, status, proposed_by) VALUES ($1,$2,$3,$4,'active','platform') RETURNING id`,
        [members[c].cpo.id, members[e].emsp.id, members[c].org_id, members[e].org_id]);
      agreements.set(`${c}${e}`, a.id);
    }
    // TODO(commercial) in production; here: A pays 3 % as CPO and 1.00 per CDR as eMSP, in MYR.
    planId = (await one(`INSERT INTO hub_fee_plan (name, currency, cpo_bps, emsp_fixed_minor) VALUES ($1, 'MYR', 300, 100) RETURNING id`, [`${PREFIX} plan ${TAG}`])).id;
    await query(`INSERT INTO hub_fee_assignment (member_id, currency, fee_plan_id) VALUES ($1, 'MYR', $2)`, [members.A.id, planId]);
  });
  after(async () => {
    await cleanup();
    Object.assign(config.hub, saved);
  });
}

dbDescribe('intake: exactly once, admission, credits', () => {
  test('the same CDR pushed, then pulled twice → one ledger row (dedupe on CPO party + CDR id)', async () => {
    const e = ev('A', 'B', `DUP-${TAG}`, { excl: 1, incl: 1.08, at: day(1) });
    const t1 = await tapCdr(e, delivered, day(1));
    const t2 = await tapCdr({ ...e, source: 'pull' }, null, day(2));
    const t3 = await tapCdr({ ...e, source: 'pull' }, null, day(3));
    assert.equal(t1!.created, true);
    assert.equal(t2!.created, false);
    assert.equal(t3!.id, t1!.id);
    assert.equal((await one(`SELECT count(*)::int AS n FROM hub_cdr WHERE cdr_id = $1`, [`DUP-${TAG}`]))!.n, 1);
    const r = await row('A', `DUP-${TAG}`);
    assert.deepEqual([r.status, r.forward_state, r.source, Number(r.total_excl_minor), Number(r.total_incl_minor)], ['pending', 'delivered', 'push', 100, 108]);
    assert.equal(new Date(r.dispute_deadline).getTime(), day(1).getTime() + 14 * 86_400_000, 'received + 14 days');
    assert.equal(r.routing.correlation_id, 'corr');
    await query(`UPDATE hub_cdr SET status = 'void' WHERE id = $1`, [r.id]);
  });

  test('concurrent push and pull of a new CDR still make one row', async () => {
    const e = ev('A', 'B', `RACE-${TAG}`, { excl: 1, at: day(1) });
    await Promise.all([tapCdr(e, delivered, day(1)), tapCdr({ ...e, source: 'pull' }, null, day(1)), tapCdr({ ...e, source: 'pull' }, null, day(1))]);
    assert.equal((await one(`SELECT count(*)::int AS n FROM hub_cdr WHERE cdr_id = $1`, [`RACE-${TAG}`]))!.n, 1);
    await query(`UPDATE hub_cdr SET status = 'void' WHERE cdr_id = $1`, [`RACE-${TAG}`]);
  });

  test('an undelivered push is held (not_delivered) until the eMSP gets it; a pull releases it', async () => {
    const e = ev('A', 'B', `UND-${TAG}`, { excl: 1, at: day(1) });
    await tapCdr(e, failed, day(1));
    assert.deepEqual([(await row('A', `UND-${TAG}`)).status, (await row('A', `UND-${TAG}`)).flags], ['held', ['not_delivered']]);
    // The CPO may correct an undelivered CDR under the same id: admitted.
    assert.equal(await admitCdr(ev('A', 'B', `UND-${TAG}`, { excl: 2, at: day(1) })), null);
    await tapCdr({ ...e, source: 'pull' }, null, day(2));
    const r = await row('A', `UND-${TAG}`);
    assert.deepEqual([r.status, r.flags, r.forward_state], ['pending', [], 'not_needed']);
    await query(`UPDATE hub_cdr SET status = 'void' WHERE id = $1`, [r.id]);
  });

  test('admit refuses malformed, self-roaming and changed CDRs (2001, not forwarded)', async () => {
    assert.match((await admitCdr(ev('A', 'A', `SELF-${TAG}`, { excl: 1, at: day(1) })))!, /same hub member/);
    const bad = ev('A', 'B', `BAD-${TAG}`, { excl: 1, at: day(1) });
    (bad.cdr as any).cdr_location = undefined;
    assert.match((await admitCdr(bad))!, /cdr_location/);
    const e = ev('A', 'B', `CHG-${TAG}`, { excl: 1, at: day(1) });
    assert.equal(await admitCdr(e), null);
    await tapCdr(e, delivered, day(1));
    assert.equal(await admitCdr(e), null, 'the same CDR again is fine (the router answers it from its state)');
    assert.match((await admitCdr(ev('A', 'B', `CHG-${TAG}`, { excl: 9, at: day(1) })))!, /cannot change/);
    // Seen differently in a pull: the first version stays, the row is flagged.
    await tapCdr({ ...ev('A', 'B', `CHG-${TAG}`, { excl: 9, at: day(1) }), source: 'pull' }, null, day(2));
    const r = await row('A', `CHG-${TAG}`);
    assert.equal(Number(r.total_excl_minor), 100);
    assert.ok(r.flags.includes('cdr_duplicate_conflict'));
    await query(`UPDATE hub_cdr SET status = 'void' WHERE id = $1`, [r.id]);
  });

  test('hard checks hold a CDR: no agreement in force; release gives it a fresh window', async () => {
    await tapCdr(ev('A', 'B', `NOAG-${TAG}`, { excl: 1, at: day(1), agreement: null }), delivered, day(1));
    const r = await row('A', `NOAG-${TAG}`);
    assert.deepEqual([r.status, r.flags], ['held', ['no_agreement']]);
    assert.match(r.hold_note, /no roaming agreement/);
    const rel = await releaseCdr(r.id, null, 'agreement signed late', day(3));
    assert.equal(rel.status, 'pending');
    assert.equal(new Date(rel.dispute_deadline).getTime(), day(3).getTime() + 14 * 86_400_000);
    await query(`UPDATE hub_cdr SET status = 'void' WHERE id = $1`, [r.id]);
  });

  test('a credit CDR with an unknown reference or the wrong amount is held', async () => {
    await tapCdr(ev('A', 'B', `CRX-${TAG}`, { excl: -1, at: day(1), credit: `NOPE-${TAG}` }), delivered, day(1));
    assert.deepEqual([(await row('A', `CRX-${TAG}`)).status, (await row('A', `CRX-${TAG}`)).flags], ['held', ['credit_unknown_reference']]);
    await tapCdr(ev('A', 'B', `ORIG2-${TAG}`, { excl: 3, at: day(1) }), delivered, day(1));
    await tapCdr(ev('A', 'B', `CRY-${TAG}`, { excl: -1, at: day(1), credit: `ORIG2-${TAG}` }), delivered, day(1));
    assert.deepEqual((await row('A', `CRY-${TAG}`)).flags, ['credit_amount_mismatch']);
    await query(`UPDATE hub_cdr SET status = 'void' WHERE cdr_id = ANY($1)`, [[`CRX-${TAG}`, `ORIG2-${TAG}`, `CRY-${TAG}`]]);
  });
});

dbDescribe('disputes (SGD CDRs of B to C)', () => {
  const S = (n: string) => `SG${n}-${TAG}`;
  const sgd = (id: string, n = 1) => ev('B', 'C', id, { cur: 'SGD', excl: 10 * n, incl: 10.9 * n, kwh: 5, at: day(1) });

  test('only the eMSP disputes, only a pending CDR, only within the window', async () => {
    await tapCdr(sgd(S('1')), delivered, day(1));
    const r = await row('B', S('1'));
    await rejects(raiseDispute(r.id, { side: 'emsp', memberId: members.B.id }, { reason: 'amount', message: 'x' }), 404);
    await rejects(raiseDispute(r.id, { side: 'emsp', memberId: members.C.id }, { reason: 'nonsense', message: 'x' }), 400);
    await rejects(raiseDispute(r.id, { side: 'emsp', memberId: members.C.id }, { reason: 'amount', message: 'late' }, day(16)), 409, /window closed/);
    const d = await raiseDispute(r.id, { side: 'emsp', memberId: members.C.id }, { reason: 'amount', message: 'tariff says 9.00', claimed_minor: 900 }, day(2));
    assert.equal(d.status, 'open');
    assert.equal((await row('B', S('1'))).status, 'disputed');
    await rejects(raiseDispute(r.id, { side: 'emsp', memberId: members.C.id }, { reason: 'amount', message: 'again' }, day(2)), 409);
    // autoAccept respects the dispute: the window passes, the CDR stays disputed.
    await autoAccept(day(20));
    assert.equal((await row('B', S('1'))).status, 'disputed');
    // The eMSP cannot answer for the CPO; the CPO accepts; the credit CDR arrives → credited.
    await rejects(transition(d.id, 'accept', { side: 'cpo', memberId: members.C.id }, {}, day(3)), 404);
    assert.equal((await transition(d.id, 'accept', { side: 'cpo', memberId: members.B.id }, { note: 'will credit' }, day(3))).status, 'accepted');
    await tapCdr(ev('B', 'C', S('1CR'), { cur: 'SGD', excl: -10, incl: -10.9, kwh: -5, at: day(4), credit: S('1') }), delivered, day(4));
    const after = await one(`SELECT status, resolution, credit_cdr_id FROM hub_dispute WHERE id = $1`, [d.id]);
    assert.deepEqual([after.status, after.resolution], ['credited', 'credited']);
    const o = await row('B', S('1')); const c = await row('B', S('1CR'));
    assert.deepEqual([o.status, o.credited_by_cdr_id, c.status, c.credits_cdr_id, after.credit_cdr_id], ['credited', c.id, 'accepted', o.id, c.id]);
    assert.deepEqual([Number(o.fee_cpo_minor), Number(c.fee_cpo_minor)], [0, 0], 'SGD default plan: placeholder 0');
    const notes = await many(`SELECT kind, side FROM hub_dispute_note WHERE dispute_id = $1 ORDER BY id`, [d.id]);
    assert.deepEqual(notes.map((n) => `${n.side}:${n.kind}`), ['emsp:raised', 'cpo:accepted', 'system:credited']);
  });

  test('rejected and not escalated → expired: the CDR stands (accepted)', async () => {
    await tapCdr(sgd(S('2')), delivered, day(1));
    const r = await row('B', S('2'));
    const d = await raiseDispute(r.id, { side: 'emsp', memberId: members.C.id }, { reason: 'energy', message: 'too much' }, day(2));
    await rejects(transition(d.id, 'reject', { side: 'cpo', memberId: members.B.id }, {}, day(3)), 400, /note/);
    await transition(d.id, 'reject', { side: 'cpo', memberId: members.B.id }, { note: 'meter data attached' }, day(3));
    assert.equal(await escalateOverdue(day(5)), 0, 'not yet');
    await escalateOverdue(day(9));
    const x = await one(`SELECT status, resolution FROM hub_dispute WHERE id = $1`, [d.id]);
    assert.deepEqual([x.status, x.resolution], ['expired', 'upheld']);
    assert.equal((await row('B', S('2'))).status, 'accepted');
  });

  test('no CPO answer → escalated; rejected → escalated by the eMSP → written off by the platform', async () => {
    await tapCdr(sgd(S('3')), delivered, day(1));
    await tapCdr(sgd(S('4')), delivered, day(1));
    const d3 = await raiseDispute((await row('B', S('3'))).id, { side: 'emsp', memberId: members.C.id }, { reason: 'not_authorized', message: 'never authorised' }, day(2));
    await escalateOverdue(day(13));
    assert.equal((await one(`SELECT status FROM hub_dispute WHERE id = $1`, [d3.id])).status, 'escalated');
    await transition(d3.id, 'resolve_upheld', { side: 'platform' }, { note: 'authorisation found in the hub log' }, day(14));
    assert.equal((await row('B', S('3'))).status, 'accepted');
    const d4 = await raiseDispute((await row('B', S('4'))).id, { side: 'emsp', memberId: members.C.id }, { reason: 'unknown_token', message: 'not our card' }, day(2));
    await transition(d4.id, 'reject', { side: 'cpo', memberId: members.B.id }, { note: 'it is' }, day(3));
    await transition(d4.id, 'escalate', { side: 'emsp', memberId: members.C.id }, { note: 'see evidence' }, day(4));
    await rejects(transition(d4.id, 'resolve_written_off', { side: 'emsp', memberId: members.C.id }, { note: 'x' }, day(5)), 403);
    await transition(d4.id, 'resolve_written_off', { side: 'platform' }, { note: 'token not issued by the eMSP' }, day(5));
    assert.equal((await row('B', S('4'))).status, 'written_off');
    await query(`UPDATE hub_cdr SET status = 'void' WHERE cdr_id LIKE $1 AND status IN ('pending','accepted','credited')`, [`SG%-${TAG}`]);
  });
});

dbDescribe('settlement: three members, two currencies (hand-computed), idempotent runs, payments', () => {
  const b = () => periodBounds('MYR', PERIOD)!;
  let runId = '';

  test('ledger for the period', async () => {
    const at = day(3);
    await tapCdr(ev('A', 'B', `M1-${TAG}`, { excl: 15, incl: 16.2, at }), delivered, at);       // B owes A 1620
    await tapCdr(ev('B', 'A', `M2-${TAG}`, { excl: 5, incl: 5.4, at }), delivered, at);         // A owes B 540
    await tapCdr(ev('C', 'A', `M3-${TAG}`, { excl: 10, incl: 10.8, at }), delivered, at);       // A owes C 1080
    await tapCdr(ev('A', 'C', `M4-${TAG}`, { excl: 3, incl: null, at }), delivered, at);        // C owes A 300 (no incl_vat)
    // Received one second before the end of the period in Kuala Lumpur → in this run; at the end → the next.
    await tapCdr(ev('B', 'C', `M5-${TAG}`, { excl: 7, incl: 7, at: new Date(b().end.getTime() - 1000) }), delivered, new Date(b().end.getTime() - 1000));
    await tapCdr(ev('B', 'C', `M5N-${TAG}`, { excl: 6, incl: 6, at: b().end }), delivered, b().end);
    await tapCdr(ev('A', 'B', `M6-${TAG}`, { excl: 1, incl: 1.08, at }), delivered, at);        // disputed: carried
    await tapCdr(ev('A', 'B', `M7-${TAG}`, { excl: 2, incl: 2.16, at }), delivered, at);        // credited in the same period
    await tapCdr(ev('A', 'B', `M7C-${TAG}`, { excl: -2, incl: -2.16, at: day(4), credit: `M7-${TAG}` }), delivered, day(4));
    await raiseDispute((await row('A', `M6-${TAG}`)).id, { side: 'emsp', memberId: members.B.id }, { reason: 'duplicate', message: 'dup' }, day(5));
    // IDR, the same members: C CPO → A eMSP 44 400; A CPO → C eMSP 22 200.
    await tapCdr(ev('C', 'A', `I1-${TAG}`, { cur: 'IDR', excl: 40000, incl: 44400, at }), delivered, at);
    await tapCdr(ev('A', 'C', `I2-${TAG}`, { cur: 'IDR', excl: 20000, incl: 22200, at }), delivered, at);
    assert.equal((await row('A', `M4-${TAG}`)).flags.includes('no_incl_vat'), true);
    assert.equal((await row('A', `M7-${TAG}`)).status, 'credited');
    const accepted = await autoAccept(new Date(b().end.getTime() + 15 * 86_400_000));
    assert.ok(accepted >= 8, String(accepted));
    assert.equal((await row('A', `M6-${TAG}`)).status, 'disputed');
    assert.deepEqual([Number((await row('A', `M1-${TAG}`)).fee_cpo_minor), Number((await row('B', `M2-${TAG}`)).fee_emsp_minor), Number((await row('B', `M2-${TAG}`)).fee_cpo_minor)], [45, 100, 0]);
  });

  test('a draft run is idempotent: refreshing changes nothing and stamps nothing', async () => {
    const now = new Date(b().end.getTime() + 16 * 86_400_000);
    const r1 = await buildRun('MYR', PERIOD, { now });
    const r2 = await buildRun('MYR', PERIOD, { now });
    assert.equal(r1.created, true);
    assert.equal(r2.created, false);
    assert.equal(r2.run.id, r1.run.id);
    const strip = (p: any) => ({ ...p, computedAt: null });
    assert.deepEqual(strip(r2.run.preview), strip(r1.run.preview));
    assert.equal(r1.run.preview.cdrCount, 7, 'M1 M2 M3 M4 M5 M7 M7C');
    assert.equal((await one(`SELECT count(*)::int AS n FROM hub_cdr WHERE settlement_run_id = $1`, [r1.run.id]))!.n, 0);
    runId = r1.run.id;
    await rejects(finaliseRun(runId, { now: new Date(b().end.getTime() - 1) }), 409, /period ends/);
    await rejects(finaliseRun(runId, { now: new Date(b().end.getTime() + 2 * 86_400_000) }), 409, /dispute window/);
  });

  test('finalise: positions, statements and fee invoices match the hand computation', async () => {
    const now = new Date(b().end.getTime() + 16 * 86_400_000);
    const f = await finaliseRun(runId, { now });
    assert.equal(f.already, false);
    assert.equal(f.run.status, 'finalised');
    const pos = await many(`SELECT * FROM hub_settlement_position WHERE run_id = $1`, [runId]);
    const pair = (x: M, y: M) => pos.find((p) => (p.member_a_id === x.id && p.member_b_id === y.id) || (p.member_a_id === y.id && p.member_b_id === x.id))!;
    const { A, B, C } = members;
    assert.deepEqual([Number(pair(A, B).net_minor), pair(A, B).payer_member_id, pair(A, B).payee_member_id], [1_080, B.id, A.id]);
    assert.deepEqual([Number(pair(A, C).net_minor), pair(A, C).payer_member_id, pair(A, C).payee_member_id], [780, A.id, C.id]);
    assert.deepEqual([Number(pair(B, C).net_minor), pair(B, C).payer_member_id], [700, C.id], 'M5 (received 1 s before the cut-off)');
    const st = async (m: M) => one(`SELECT * FROM hub_statement WHERE run_id = $1 AND member_id = $2`, [runId, m.id]);
    const sa = await st(A), sb = await st(B), sc = await st(C);
    assert.deepEqual([Number(sa.receivable_minor), Number(sa.payable_minor), Number(sa.net_minor), Number(sa.fee_net_minor)], [1_920, 1_620, 300, 254]);
    assert.deepEqual([Number(sb.receivable_minor), Number(sb.payable_minor), Number(sb.net_minor)], [1_240, 1_620, -380]);
    assert.deepEqual([Number(sc.receivable_minor), Number(sc.payable_minor), Number(sc.net_minor)], [1_080, 1_000, 80]);
    assert.equal(Number(sa.net_minor) + Number(sb.net_minor) + Number(sc.net_minor), 0);
    assert.match(sa.number, /^PSH-ST-\d{4}-MYR-\d{6}$/);
    assert.equal(sa.data.carried.count, 1, 'M6 (disputed) carried');
    assert.equal(sb.data.counterparties.length, 2);
    const inv = await many(`SELECT * FROM hub_fee_invoice WHERE run_id = $1`, [runId]);
    assert.equal(inv.length, 1, 'only A has a commission (B and C are on the 0 placeholder)');
    assert.deepEqual([inv[0].member_id, Number(inv[0].net_minor), inv[0].tax_scheme, Number(inv[0].total_minor), inv[0].entity_country], [A.id, 254, 'NONE', 254, 'MY']);
    assert.ok(inv[0].data.flags.includes('placeholder_entity'));
    assert.equal(sa.fee_invoice_id, inv[0].id);
    // Stamped: the run's CDRs, not the disputed one nor the next period's.
    const stamped = (await many(`SELECT cdr_id FROM hub_cdr WHERE settlement_run_id = $1 ORDER BY cdr_id`, [runId])).map((r) => r.cdr_id.replace(`-${TAG}`, ''));
    assert.deepEqual(stamped, ['M1', 'M2', 'M3', 'M4', 'M5', 'M7', 'M7C']);
  });

  test('finalising again or rebuilding returns the finalised run unchanged (immutable)', async () => {
    const now = new Date(b().end.getTime() + 20 * 86_400_000);
    const again = await finaliseRun(runId, { now });
    assert.equal(again.already, true);
    const rebuilt = await buildRun('MYR', PERIOD, { now });
    assert.deepEqual([rebuilt.run.id, rebuilt.run.status, rebuilt.created], [runId, 'finalised', false]);
    assert.equal((await one(`SELECT count(*)::int AS n FROM hub_statement WHERE run_id = $1`, [runId]))!.n, 3);
  });

  test('IDR is settled separately (no FX): its own run and positions', async () => {
    const now = new Date(periodBounds('IDR', PERIOD)!.end.getTime() + 16 * 86_400_000);
    const r = await buildRun('IDR', PERIOD, { now });
    const f = await finaliseRun(r.run.id, { now });
    const pos = await many(`SELECT * FROM hub_settlement_position WHERE run_id = $1`, [f.run.id]);
    assert.equal(pos.length, 1);
    assert.deepEqual([Number(pos[0].net_minor), pos[0].payer_member_id, pos[0].currency], [22_200, members.A.id, 'IDR']);
    assert.equal((await many(`SELECT 1 FROM hub_cdr WHERE settlement_run_id = $1 AND currency <> 'IDR'`, [f.run.id])).length, 0);
  });

  test('a credit for a settled CDR offsets it in the next run', async () => {
    const at = periodBounds('MYR', NEXT)!.start;
    await tapCdr(ev('A', 'B', `M1C-${TAG}`, { excl: -15, incl: -16.2, at: new Date(at.getTime() + 3600_000), credit: `M1-${TAG}` }), delivered, new Date(at.getTime() + 3600_000));
    const c = await row('A', `M1C-${TAG}`);
    assert.deepEqual([c.status, Number(c.fee_cpo_minor)], ['accepted', -45]);
    assert.equal((await row('A', `M1-${TAG}`)).settlement_run_id, runId);
    const r = await buildRun('MYR', NEXT, { now: new Date(at.getTime() + 2 * 86_400_000) });
    const ab = r.run.preview.positions.find((p: any) => [p.memberA, p.memberB].sort().join() === [members.A.id, members.B.id].sort().join());
    assert.deepEqual([ab.net, ab.payer], [1_620, members.A.id], 'the CPO refunds the eMSP');
  });

  test('payments: partial, outstanding, payee confirms, no overpaying; balances reach zero', async () => {
    const p = await one(`SELECT * FROM hub_settlement_position WHERE run_id = $1 AND payer_member_id = $2`, [runId, members.B.id]);
    const now = new Date(b().end.getTime() + 17 * 86_400_000);
    await rejects(recordPayment(p.id, { side: 'member', memberId: members.C.id }, { amount_minor: 1, paid_at: '2000-01-01', reference: 'x' }, now), 404);
    await rejects(recordPayment(p.id, { side: 'member', memberId: members.B.id }, { amount_minor: 1.5, paid_at: '2000-01-01', reference: 'x' }, now), 400);
    const r1 = await recordPayment(p.id, { side: 'member', memberId: members.B.id }, { amount_minor: 500, paid_at: '2000-01-01', reference: 'TRF-1' }, now);
    assert.deepEqual([r1.position.status, Number(r1.position.paid_minor), Number(r1.position.net_minor) - Number(r1.position.paid_minor)], ['partially_paid', 500, 580]);
    await rejects(confirmPayment(r1.payment.id, { side: 'member', memberId: members.B.id }, now), 403);
    await confirmPayment(r1.payment.id, { side: 'member', memberId: members.A.id }, now);
    await rejects(recordPayment(p.id, { side: 'member', memberId: members.B.id }, { amount_minor: 600, paid_at: '2000-01-02', reference: 'TRF-2' }, now), 409, /outstanding/);
    const r2 = await recordPayment(p.id, { side: 'member', memberId: members.B.id }, { amount_minor: 580, paid_at: '2000-01-02', reference: 'TRF-2' }, now);
    assert.equal(r2.position.status, 'paid');
    const r3 = await confirmPayment(r2.payment.id, { side: 'member', memberId: members.A.id }, now);
    assert.deepEqual([r3.position.status, Number(r3.position.net_minor) - Number(r3.position.paid_minor)], ['confirmed', 0]);
    // A payee recording the payment counts as confirmed at once.
    const ac = await one(`SELECT * FROM hub_settlement_position WHERE run_id = $1 AND payer_member_id = $2`, [runId, members.A.id]);
    const r4 = await recordPayment(ac.id, { side: 'member', memberId: members.C.id }, { amount_minor: 780, paid_at: '2000-01-03', reference: 'TRF-3' }, now);
    assert.equal(r4.position.status, 'confirmed');
  });

  test('overdue: past the due date with an outstanding balance, reminders on days 1, 7 and 14', async () => {
    const p = await one(`SELECT *, to_char(due_date, 'YYYY-MM-DD') AS due FROM hub_settlement_position WHERE run_id = $1 AND payer_member_id = $2`, [runId, members.C.id]);
    const due = new Date(`${p.due}T12:00:00+08:00`);
    await markOverdue(new Date(due.getTime() + 2 * 86_400_000));
    let q = await one(`SELECT status, reminders_sent, to_char(overdue_since, 'YYYY-MM-DD') AS since FROM hub_settlement_position WHERE id = $1`, [p.id]);
    assert.deepEqual([q.status, q.reminders_sent], ['overdue', 1]);
    await markOverdue(new Date(due.getTime() + 3 * 86_400_000));
    assert.equal((await one(`SELECT reminders_sent FROM hub_settlement_position WHERE id = $1`, [p.id])).reminders_sent, 1, 'no reminder between day 1 and 7');
    await markOverdue(new Date(due.getTime() + 15 * 86_400_000));
    q = await one(`SELECT status, reminders_sent FROM hub_settlement_position WHERE id = $1`, [p.id]);
    assert.deepEqual([q.status, q.reminders_sent], ['overdue', 3]);
    await new Promise((r) => setTimeout(r, 300)); // the platform copies resolve their organisation asynchronously
    const overdue = raised.filter((a) => a.kind === 'hub.payment_overdue' && a.targetId === p.id);
    assert.equal(overdue.length, 4, 'day 2: the first reminder; day 15: one catch-up reminder (not two) — each to the payer and to the platform');
    // The platform copy is stored in the payer's organisation (no organisation row for NIL_ORG: it was dropped).
    assert.ok(overdue.every((a) => a.orgId === members.C.org_id) && !overdue.some((a) => a.orgId === NIL_ORG));
    const paid = await recordPayment(p.id, { side: 'platform' }, { amount_minor: 700, paid_at: '2000-02-01', reference: 'LATE' }, new Date(due.getTime() + 16 * 86_400_000));
    assert.equal(paid.position.status, 'paid', 'paid late; awaiting the payee\'s confirmation');
  });
});

dbDescribe('row-level security: a member sees only its own clearing rows', () => {
  test('as plugsure_app inside member B\'s scope', async (t) => {
    const password = process.env.POSTGRES_APP_PASSWORD;
    if (!password) { t.skip('POSTGRES_APP_PASSWORD not set'); return; }
    const u = new URL(config.databaseUrl);
    u.username = 'plugsure_app';
    u.password = password;
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.rls_bypass', 'off', true), set_config('app.current_org_id', $1, true)`, [members.B.org_id]);
      const cdrs = (await c.query(`SELECT cpo_org_id, emsp_org_id, cdr_id FROM hub_cdr`)).rows;
      assert.ok(cdrs.length > 0);
      assert.ok(cdrs.every((r) => r.cpo_org_id === members.B.org_id || r.emsp_org_id === members.B.org_id));
      assert.ok(!cdrs.some((r) => r.cdr_id === `M3-${TAG}`), 'C→A is invisible to B');
      const st = (await c.query(`SELECT org_id FROM hub_statement`)).rows;
      assert.ok(st.length >= 1 && st.every((r) => r.org_id === members.B.org_id));
      const pos = (await c.query(`SELECT org_a_id, org_b_id FROM hub_settlement_position`)).rows;
      assert.ok(pos.length >= 1 && pos.every((r) => r.org_a_id === members.B.org_id || r.org_b_id === members.B.org_id));
      assert.ok((await c.query(`SELECT org_id FROM hub_fee_invoice`)).rows.every((r) => r.org_id === members.B.org_id));
      const pay = (await c.query(`SELECT payer_org_id, payee_org_id FROM hub_payment`)).rows;
      assert.ok(pay.every((r) => r.payer_org_id === members.B.org_id || r.payee_org_id === members.B.org_id));
      const d = (await c.query(`SELECT cpo_org_id, emsp_org_id FROM hub_dispute`)).rows;
      assert.ok(d.every((r) => r.cpo_org_id === members.B.org_id || r.emsp_org_id === members.B.org_id));
      for (const tname of ['hub_fee_plan', 'hub_fee_assignment', 'hub_settlement_run', 'hub_doc_seq']) {
        assert.equal((await c.query(`SELECT count(*)::int AS n FROM ${tname}`)).rows[0].n, 0, `${tname} is platform-only`);
      }
      await assert.rejects(c.query(`UPDATE hub_cdr SET status = 'void' WHERE cdr_id = $1 RETURNING id`, [`M3-${TAG}`]).then((r) => { if (!r.rowCount) throw new Error('row-level security: nothing visible'); }));
      await c.query('ROLLBACK');
      // Member C's scope does not see B's statement.
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.rls_bypass', 'off', true), set_config('app.current_org_id', $1, true)`, [members.C.org_id]);
      const theirs = (await c.query(`SELECT count(*)::int AS n FROM hub_statement WHERE member_id = $1`, [members.B.id])).rows[0].n;
      assert.equal(theirs, 0);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
});
