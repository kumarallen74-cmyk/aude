import type pg from 'pg';
import { many, one, tx } from '../../db/pool.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { CURRENCY_CODES, isCurrency, type CurrencyCode } from '../../domain/money.js';
import { unseal } from '../../services/secrets.js';
import { HubError } from '../errors.js';
import { net, positionFor, settlementAmount, type MemberTotals } from './netting.js';
import { addDays, daysBetween, finalisableAt, localDateString, periodBounds, previousPeriod, type Cycle } from './period.js';
import { issueFeeInvoice, nextNumber } from './invoices.js';
import { alert, audit } from './notify.js';

/**
 * Settlement runs, netting, statements and payments (docs/HUB-DESIGN.md §8.5). PlugSure holds no funds
 * (D10): a run computes what each member owes each other member in ONE currency over one period, the payer
 * transfers directly to the payee, and both sides record or confirm the transfer here.
 *
 *   draft ──refresh (any number of times: idempotent, nothing is stamped)──► draft
 *     │──finalise (once; after the period ended and, unless forced, its dispute window)──► finalised (immutable)
 *     └──void──► void (a new draft may then be created for the period)
 *
 * A run takes every CDR of its currency that is payable (accepted, or credited: an original and its credit both
 * count, so they offset), not yet settled, and received before period_end. Later corrections are credit CDRs,
 * settled by a later run.
 */

export interface RunRow {
  id: string; currency: string; cycle: Cycle; period: string; time_zone: string; period_start: Date; period_end: Date; finalisable_at: Date;
  status: 'draft' | 'finalised' | 'void'; preview: any; totals: any; created_at: Date; refreshed_at: Date; finalised_at: Date | null;
}

const PAYABLE = `status IN ('accepted','credited') AND settlement_run_id IS NULL`;

async function settleable(c: pg.PoolClient, currency: string, periodEnd: Date, lock: boolean) {
  return (await c.query(
    `SELECT id, cdr_id, session_id, cpo_member_id, emsp_member_id, cpo_org_id, emsp_org_id, currency, total_excl_minor::bigint AS total_excl_minor,
            total_incl_minor, energy_kwh, fee_cpo_minor, fee_emsp_minor, credit, credits_cdr_id, start_at, end_at, received_at, location_id, flags,
            (SELECT o.cdr_id FROM hub_cdr o WHERE o.id = hub_cdr.credits_cdr_id) AS credits_cdr
       FROM hub_cdr WHERE currency = $1 AND received_at < $2 AND ${PAYABLE}
      ORDER BY received_at, id ${lock ? 'FOR UPDATE' : ''}`, [currency, periodEnd])).rows;
}

async function carried(c: pg.PoolClient, currency: string, periodEnd: Date) {
  return (await c.query(
    `SELECT id, cdr_id, status, cpo_member_id, emsp_member_id, total_excl_minor::bigint AS total_excl_minor, total_incl_minor, dispute_deadline
       FROM hub_cdr WHERE currency = $1 AND received_at < $2 AND settlement_run_id IS NULL AND status IN ('pending','disputed','held')
      ORDER BY received_at LIMIT 2000`, [currency, periodEnd])).rows;
}

async function memberNames(c: pg.PoolClient, ids: string[]) {
  const rows = (await c.query(`SELECT id, org_id, legal_name, country_code, kind, tax_id, billing_email, bank_details FROM hub_member WHERE id = ANY($1::uuid[])`, [ids])).rows;
  return new Map(rows.map((r: any) => [r.id as string, r]));
}

/** What finalising now would produce (draft preview), or what was frozen (shape shared by both). */
function summarise(cdrs: any[], carriedRows: any[], currency: string, names: Map<string, any>) {
  const n = net(cdrs, currency);
  const name = (id: string) => names.get(id)?.legal_name ?? id;
  return {
    cdrCount: cdrs.length,
    grossMinor: cdrs.reduce((s, c) => s + settlementAmount(c), 0),
    feeMinor: n.members.reduce((s, m) => s + m.feeNet, 0),
    positions: n.positions.map((p) => ({ ...p, memberAName: name(p.memberA), memberBName: name(p.memberB), payerName: p.payer ? name(p.payer) : null, payeeName: p.payee ? name(p.payee) : null })),
    members: n.members.map((m) => ({ ...m, name: name(m.memberId) })),
    carried: {
      count: carriedRows.length,
      amountMinor: carriedRows.reduce((s, c) => s + settlementAmount(c), 0),
      byStatus: carriedRows.reduce((acc: Record<string, number>, c) => { acc[c.status] = (acc[c.status] ?? 0) + 1; return acc; }, {}),
    },
  };
}

export function parseRunRequest(b: { currency?: unknown; period?: unknown; cycle?: unknown }): { currency: CurrencyCode; period: string; cycle: Cycle } {
  const currency = String(b.currency ?? '');
  if (!isCurrency(currency)) throw new HubError(400, 2001, `currency: one of ${CURRENCY_CODES.join(', ')}`);
  const cycle = (b.cycle == null ? config.hub.cycle : String(b.cycle)) as Cycle;
  if (cycle !== 'monthly' && cycle !== 'weekly') throw new HubError(400, 2001, 'cycle: monthly or weekly');
  const period = String(b.period ?? '');
  if (!periodBounds(currency, period, cycle)) throw new HubError(400, 2001, cycle === 'monthly' ? 'period: YYYY-MM' : 'period: YYYY-MM-DD, a Monday');
  return { currency, period, cycle };
}

/** Create the draft run for (currency, cycle, period), or refresh it. A finalised run is returned unchanged. */
export async function buildRun(currency: CurrencyCode, period: string, o: { cycle?: Cycle; actorId?: string | null; now?: Date } = {}): Promise<{ run: RunRow; created: boolean }> {
  const cycle = o.cycle ?? config.hub.cycle;
  const now = o.now ?? new Date();
  const b = periodBounds(currency, period, cycle);
  if (!b) throw new HubError(400, 2001, 'malformed period');
  return tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('hub_run:' || $1 || ':' || $2 || ':' || $3, 0))`, [currency, cycle, period]);
    let run = (await c.query<RunRow>(`SELECT * FROM hub_settlement_run WHERE currency = $1 AND cycle = $2 AND period = $3 AND status <> 'void' FOR UPDATE`, [currency, cycle, period])).rows[0];
    let created = false;
    if (!run) {
      run = (await c.query<RunRow>(
        `INSERT INTO hub_settlement_run (currency, cycle, period, time_zone, period_start, period_end, finalisable_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [currency, cycle, period, b.timeZone, b.start, b.end, finalisableAt(b.end, config.hub.disputeDays), o.actorId ?? null])).rows[0]!;
      created = true;
    }
    if (run.status === 'finalised') return { run, created: false };
    const cdrs = await settleable(c, currency, b.end, false);
    const carr = await carried(c, currency, b.end);
    const names = await memberNames(c, [...new Set(cdrs.flatMap((x: any) => [x.cpo_member_id, x.emsp_member_id]))]);
    const preview = { ...summarise(cdrs, carr, currency, names), computedAt: now.toISOString(), finalisable: now >= new Date(run.finalisable_at), periodEnded: now >= b.end };
    run = (await c.query<RunRow>(`UPDATE hub_settlement_run SET preview = $2, refreshed_at = $3 WHERE id = $1 RETURNING *`, [run.id, JSON.stringify(preview), now])).rows[0]!;
    return { run, created };
  });
}

export async function getRun(id: string): Promise<RunRow | null> {
  return one<RunRow>(`SELECT * FROM hub_settlement_run WHERE id = $1`, [id]);
}

/** Recompute a draft (the "preview" button). */
export async function refreshRun(id: string, actorId: string | null, now = new Date()): Promise<RunRow> {
  const r = await getRun(id);
  if (!r) throw new HubError(404, 2000, 'run not found');
  if (r.status === 'void') throw new HubError(409, 2000, 'this run is void');
  return (await buildRun(r.currency as CurrencyCode, r.period, { cycle: r.cycle, actorId, now })).run;
}

export async function voidRun(id: string, actorId: string | null, reason: string | null = null): Promise<RunRow> {
  const r = await one<RunRow>(`UPDATE hub_settlement_run SET status = 'void' WHERE id = $1 AND status = 'draft' RETURNING *`, [id]);
  if (!r) throw new HubError(409, 2000, 'only a draft run can be voided (a finalised run is immutable: correct it with credit CDRs)');
  await audit('hub.settlement_run_void', 'hub_settlement_run', id, { actorId, after: { currency: r.currency, period: r.period, ...(reason ? { reason } : {}) } });
  return r;
}

const unsealBank = (m: any): string | null => {
  if (!m?.bank_details) return null;
  try { return unseal(m.bank_details, `hub_member:${m.id}:bank`); } catch { return null; }
};

/**
 * Finalise a run: stamp its CDRs, write bilateral positions, one statement per member, and a fee invoice per
 * member with a non-zero commission. Idempotent: finalising a finalised run returns it unchanged.
 */
export async function finaliseRun(id: string, o: { actorId?: string | null; force?: boolean; now?: Date; reason?: string | null } = {}): Promise<{ run: RunRow; already: boolean }> {
  const now = o.now ?? new Date();
  const after: Array<() => void> = [];
  const out = await tx(async (c) => {
    const run = (await c.query<RunRow>(`SELECT * FROM hub_settlement_run WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!run) throw new HubError(404, 2000, 'run not found');
    if (run.status === 'finalised') return { run, already: true };
    if (run.status === 'void') throw new HubError(409, 2000, 'this run is void');
    const end = new Date(run.period_end);
    if (now < end) throw new HubError(409, 2000, `the period ends ${end.toISOString()}: it cannot be finalised before`);
    if (now < new Date(run.finalisable_at) && !o.force) {
      throw new HubError(409, 2000, `CDRs received at the end of the period are still inside their dispute window until ${new Date(run.finalisable_at).toISOString()} (finalise with force to settle now; pending CDRs are carried to the next run)`);
    }
    const cur = run.currency as CurrencyCode;
    const cdrs = await settleable(c, cur, end, true);
    const carr = await carried(c, cur, end);
    const memberIds = [...new Set(cdrs.flatMap((x: any) => [x.cpo_member_id, x.emsp_member_id]))];
    const names = await memberNames(c, memberIds);
    const sum = summarise(cdrs, carr, cur, names);
    if (cdrs.length) await c.query(`UPDATE hub_cdr SET settlement_run_id = $1, updated_at = now() WHERE id = ANY($2::uuid[])`, [run.id, cdrs.map((x: any) => x.id)]);
    const today = localDateString(now, cur);
    const due = addDays(today, config.hub.paymentTermsDays);
    const posIds = new Map<string, string>();
    for (const p of sum.positions) {
      const a = names.get(p.memberA), b = names.get(p.memberB);
      const payer = p.payer ? names.get(p.payer) : null, payee = p.payee ? names.get(p.payee) : null;
      const row = (await c.query(
        `INSERT INTO hub_settlement_position (run_id, currency, member_a_id, member_b_id, org_a_id, org_b_id, a_owes_b_minor, b_owes_a_minor, net_minor,
                                              payer_member_id, payee_member_id, payer_org_id, payee_org_id, cdr_count, status, due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [run.id, cur, p.memberA, p.memberB, a.org_id, b.org_id, p.aOwesB, p.bOwesA, p.net, p.payer, p.payee, payer?.org_id ?? null, payee?.org_id ?? null,
          p.cdrCount, p.net === 0 ? 'nothing_due' : 'open', due])).rows[0];
      posIds.set(`${p.memberA}|${p.memberB}`, row.id);
    }
    const year = run.period.slice(0, 4);
    for (const m of sum.members as Array<MemberTotals & { name: string }>) {
      const member = names.get(m.memberId);
      const mine = sum.positions.filter((p) => p.memberA === m.memberId || p.memberB === m.memberId);
      const counterparties = mine.map((p) => {
        const v = positionFor(p, m.memberId);
        const cp = names.get(v.counterparty);
        const direction = p.payer === m.memberId ? 'pay' : p.payee === m.memberId ? 'receive' : 'none';
        return {
          memberId: v.counterparty, name: cp?.legal_name, country: cp?.country_code, positionId: posIds.get(`${p.memberA}|${p.memberB}`),
          receivableMinor: v.receivable, payableMinor: v.payable, netMinor: v.signedNet, direction, cdrCount: p.cdrCount, dueDate: due,
          // Payment instruction: the PAYEE's bank details, as the payee entered them.
          payeeBankDetails: direction === 'pay' ? unsealBank(cp) : null,
        };
      });
      const lines = cdrs.filter((x: any) => x.cpo_member_id === m.memberId || x.emsp_member_id === m.memberId).map((x: any) => {
        const side = x.cpo_member_id === m.memberId ? 'cpo' : 'emsp';
        return {
          id: x.id, cdrId: x.cdr_id, sessionId: x.session_id, side, counterparty: names.get(side === 'cpo' ? x.emsp_member_id : x.cpo_member_id)?.legal_name,
          counterpartyId: side === 'cpo' ? x.emsp_member_id : x.cpo_member_id,
          start: x.start_at, end: x.end_at, energyKwh: Number(x.energy_kwh), exclMinor: Number(x.total_excl_minor),
          inclMinor: x.total_incl_minor == null ? null : Number(x.total_incl_minor), amountMinor: settlementAmount(x), credit: x.credit, credits: x.credits_cdr ?? null,
          feeMinor: Number(side === 'cpo' ? x.fee_cpo_minor ?? 0 : x.fee_emsp_minor ?? 0), locationId: x.location_id,
        };
      });
      const carriedMine = carr.filter((x: any) => x.cpo_member_id === m.memberId || x.emsp_member_id === m.memberId);
      let invoice: { id: string; number: string; total_minor: number } | null = null;
      if (m.feeNet !== 0) invoice = await issueFeeInvoice(c, { run, member, feeCpoMinor: m.feeCpo, feeEmspMinor: m.feeEmsp, cdrsAsCpo: m.cdrsAsCpo, cdrsAsEmsp: m.cdrsAsEmsp, now });
      const number = await nextNumber(c, `statement:${year}`, (seq) => `PSH-ST-${year}-${cur}-${String(seq).padStart(6, '0')}`);
      const data = {
        member: { id: member.id, name: member.legal_name, country: member.country_code, taxId: member.tax_id, kind: member.kind },
        currency: cur, period: run.period, cycle: run.cycle, periodStart: run.period_start, periodEnd: run.period_end, timeZone: run.time_zone, runId: run.id,
        totals: {
          receivableMinor: m.receivable, payableMinor: m.payable, netMinor: m.net, feeCpoMinor: m.feeCpo, feeEmspMinor: m.feeEmsp, feeNetMinor: m.feeNet,
          cdrsAsCpo: m.cdrsAsCpo, cdrsAsEmsp: m.cdrsAsEmsp, energyAsCpoKwh: m.energyAsCpoKwh, energyAsEmspKwh: m.energyAsEmspKwh,
        },
        counterparties, cdrs: lines,
        carried: { count: carriedMine.length, amountMinor: carriedMine.reduce((s: number, x: any) => s + settlementAmount(x), 0), items: carriedMine.slice(0, 200).map((x: any) => ({ cdrId: x.cdr_id, status: x.status, amountMinor: settlementAmount(x) })) },
        feeInvoice: invoice ? { id: invoice.id, number: invoice.number, totalMinor: invoice.total_minor } : null,
        dueDate: due, issuedAt: now.toISOString(),
      };
      const st = (await c.query(
        `INSERT INTO hub_statement (run_id, member_id, org_id, currency, period, period_start, period_end, number, receivable_minor, payable_minor, net_minor,
                                    fee_net_minor, fee_invoice_id, cdr_count, data, issued_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [run.id, member.id, member.org_id, cur, run.period, run.period_start, run.period_end, number, m.receivable, m.payable, m.net, m.feeNet,
          invoice?.id ?? null, m.cdrsAsCpo + m.cdrsAsEmsp, JSON.stringify(data), now])).rows[0];
      after.push(() => alert(member.org_id, 'hub.statement_issued', `Hub statement ${number} (${cur} ${run.period}) is available${invoice ? `, with hub fee invoice ${invoice.number}` : ''}.`, { type: 'hub_statement', id: st.id }, 'info'));
    }
    const totals = { ...sum, finalisedAt: now.toISOString(), dueDate: due, forced: !!o.force && now < new Date(run.finalisable_at) };
    const fin = (await c.query<RunRow>(`UPDATE hub_settlement_run SET status = 'finalised', totals = $2, preview = '{}', finalised_at = $3, finalised_by = $4 WHERE id = $1 RETURNING *`,
      [run.id, JSON.stringify(totals), now, o.actorId ?? null])).rows[0]!;
    after.push(() => void audit('hub.settlement_run_finalised', 'hub_settlement_run', run.id, { actorId: o.actorId, after: { currency: cur, period: run.period, cdrs: cdrs.length, positions: sum.positions.length, forced: totals.forced, ...(o.reason ? { reason: o.reason } : {}) } }));
    return { run: fin, already: false };
  });
  for (const f of after) f();
  return out;
}

// ───────────────────────────────────────────────────────────── payments

export interface PaymentActor { side: 'member' | 'platform'; memberId?: string | null; userId?: string | null; ip?: string | null }

const METHODS = ['bank_transfer', 'stripe_connect', 'xendit', 'other'] as const;

/** Position status from what was recorded (pure). */
export function positionStatus(p: { net_minor: number; paid_minor: number; status: string; due_date: string; unconfirmed: number }, today: string): string {
  if (p.status === 'written_off' || p.status === 'nothing_due') return p.status;
  if (p.paid_minor >= p.net_minor) return p.unconfirmed === 0 ? 'confirmed' : 'paid';
  if (today > p.due_date) return 'overdue';
  return p.paid_minor > 0 ? 'partially_paid' : 'open';
}

async function recomputePosition(c: pg.PoolClient, positionId: string, now: Date) {
  const p = (await c.query(`SELECT *, to_char(due_date, 'YYYY-MM-DD') AS due FROM hub_settlement_position WHERE id = $1 FOR UPDATE`, [positionId])).rows[0];
  const agg = (await c.query<{ paid: string; unconfirmed: number }>(
    `SELECT COALESCE(sum(amount_minor), 0)::bigint AS paid, count(*) FILTER (WHERE confirmed_by_payee_at IS NULL)::int AS unconfirmed FROM hub_payment WHERE position_id = $1`, [positionId])).rows[0]!;
  const today = localDateString(now, p.currency);
  const status = positionStatus({ net_minor: Number(p.net_minor), paid_minor: Number(agg.paid), status: p.status, due_date: p.due, unconfirmed: agg.unconfirmed }, today);
  return (await c.query(`UPDATE hub_settlement_position SET paid_minor = $2, status = $3, updated_at = now(),
                                overdue_since = CASE WHEN $3 = 'overdue' THEN COALESCE(overdue_since, due_date + 1) ELSE overdue_since END
                          WHERE id = $1 RETURNING *`, [positionId, agg.paid, status])).rows[0];
}

/** Record a transfer on a position (payer, payee — counts as confirmed — or the platform). Partial payments add up. */
export async function recordPayment(positionId: string, actor: PaymentActor, b: { amount_minor?: unknown; paid_at?: unknown; reference?: unknown; method?: unknown; note?: unknown }, now = new Date()) {
  const amount = Number(b.amount_minor);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new HubError(400, 2001, 'amount_minor: a whole, positive amount in minor units of the position currency');
  const paidAt = String(b.paid_at ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt) || Number.isNaN(Date.parse(`${paidAt}T00:00:00Z`))) throw new HubError(400, 2001, 'paid_at: the transfer date, YYYY-MM-DD');
  const method = String(b.method ?? 'bank_transfer');
  if (!(METHODS as readonly string[]).includes(method)) throw new HubError(400, 2001, `method: ${METHODS.join(', ')}`);
  const reference = typeof b.reference === 'string' ? b.reference.trim().slice(0, 200) : '';
  if (!reference) throw new HubError(400, 2001, 'reference: the bank transfer reference is required');
  const note = typeof b.note === 'string' ? b.note.slice(0, 1000) : null;
  const after: Array<() => void> = [];
  const out = await tx(async (c) => {
    const p = (await c.query(`SELECT * FROM hub_settlement_position WHERE id = $1 FOR UPDATE`, [positionId])).rows[0];
    if (!p) throw new HubError(404, 2000, 'position not found');
    let side: 'payer' | 'payee' | 'platform' = 'platform';
    if (actor.side === 'member') {
      if (actor.memberId === p.payer_member_id) side = 'payer';
      else if (actor.memberId === p.payee_member_id) side = 'payee';
      else throw new HubError(404, 2000, 'position not found');
    }
    if (!p.payer_member_id || ['nothing_due', 'written_off'].includes(p.status)) throw new HubError(409, 2000, `nothing is due on this position (${p.status})`);
    if (paidAt > addDays(localDateString(now, p.currency), 1)) throw new HubError(400, 2001, 'paid_at is in the future');
    const outstanding = Number(p.net_minor) - Number(p.paid_minor);
    if (amount > outstanding) throw new HubError(409, 2000, `the outstanding balance is ${outstanding} (minor units): record at most that`);
    const pay = (await c.query(
      `INSERT INTO hub_payment (position_id, payer_member_id, payee_member_id, payer_org_id, payee_org_id, currency, amount_minor, method, reference, paid_at,
                                recorded_by, recorded_side, confirmed_by_payee_at, confirmed_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [p.id, p.payer_member_id, p.payee_member_id, p.payer_org_id, p.payee_org_id, p.currency, amount, method, reference, paidAt,
        actor.userId ?? null, side, side === 'payee' ? now : null, side === 'payee' ? actor.userId ?? null : null, note])).rows[0];
    const pos = await recomputePosition(c, p.id, now);
    after.push(() => {
      const msg = `A payment of ${amount} (${p.currency} minor units, ref. ${reference}) was recorded on a hub settlement position; outstanding ${Number(pos.net_minor) - Number(pos.paid_minor)}.`;
      if (side !== 'payee') alert(p.payee_org_id, 'hub.payment_recorded', `${msg} Please confirm receipt.`, { type: 'hub_payment', id: pay.id }, 'info');
      if (side !== 'payer') alert(p.payer_org_id, 'hub.payment_recorded', msg, { type: 'hub_payment', id: pay.id }, 'info');
      void audit('hub.payment_recorded', 'hub_payment', pay.id, { actorId: actor.userId, ip: actor.ip, orgIds: [p.payer_org_id, p.payee_org_id], after: { position: p.id, amount_minor: amount, currency: p.currency, reference, side } });
    });
    return { payment: pay, position: pos };
  });
  for (const f of after) f();
  return out;
}

/** The payee (or the platform) confirms it received a recorded payment. */
export async function confirmPayment(paymentId: string, actor: PaymentActor, now = new Date()) {
  const after: Array<() => void> = [];
  const out = await tx(async (c) => {
    const pay = (await c.query(`SELECT * FROM hub_payment WHERE id = $1 FOR UPDATE`, [paymentId])).rows[0];
    if (!pay) throw new HubError(404, 2000, 'payment not found');
    if (actor.side === 'member' && actor.memberId !== pay.payee_member_id) {
      throw new HubError(actor.memberId === pay.payer_member_id ? 403 : 404, 2000, actor.memberId === pay.payer_member_id ? 'only the payee confirms a payment' : 'payment not found');
    }
    const upd = pay.confirmed_by_payee_at ? pay
      : (await c.query(`UPDATE hub_payment SET confirmed_by_payee_at = $2, confirmed_by = $3 WHERE id = $1 RETURNING *`, [pay.id, now, actor.userId ?? null])).rows[0];
    const pos = await recomputePosition(c, pay.position_id, now);
    if (!pay.confirmed_by_payee_at) {
      after.push(() => void audit('hub.payment_confirmed', 'hub_payment', pay.id, { actorId: actor.userId, ip: actor.ip, orgIds: [pay.payee_org_id, pay.payer_org_id], after: { position: pay.position_id, side: actor.side } }));
    }
    return { payment: upd, position: pos };
  });
  for (const f of after) f();
  return out;
}

/** The platform writes off what remains of a position (e.g. a settled dispute outside the hub). */
export async function writeOffPosition(positionId: string, actorId: string | null, note: string) {
  const p = await one(`UPDATE hub_settlement_position SET status = 'written_off', updated_at = now() WHERE id = $1 AND status IN ('open','partially_paid','overdue') RETURNING *`, [positionId]);
  if (!p) throw new HubError(409, 2000, 'only an open, partially paid or overdue position can be written off');
  await audit('hub.position_written_off', 'hub_settlement_position', positionId, { actorId, orgIds: [p.payer_org_id, p.payee_org_id], after: { note: note.slice(0, 500), outstanding: Number(p.net_minor) - Number(p.paid_minor) } });
  return p;
}

// ───────────────────────────────────────────────────────────── workers

const REMINDER_DAYS = [1, 7, 14];

/** Worker (hourly): positions past due → overdue, with reminders on days 1, 7 and 14; overdue fee invoices. */
export async function markOverdue(now = new Date()): Promise<{ positions: number; reminders: number; invoices: number }> {
  let positions = 0, reminders = 0, invoices = 0;
  const rows = await many(`SELECT p.*, to_char(p.due_date, 'YYYY-MM-DD') AS due, m.legal_name AS payer_name, n.legal_name AS payee_name
                             FROM hub_settlement_position p JOIN hub_member m ON m.id = p.payer_member_id JOIN hub_member n ON n.id = p.payee_member_id
                            WHERE p.status IN ('open','partially_paid','overdue')`);
  for (const p of rows) {
    const today = localDateString(now, p.currency);
    if (today <= p.due) continue;
    const late = daysBetween(p.due, today);
    const owed = REMINDER_DAYS.filter((d) => d <= late).length;
    await tx(async (c) => {
      const before = p.status;
      const pos = await recomputePosition(c, p.id, now);
      if (before !== 'overdue' && pos.status === 'overdue') positions++;
      if (pos.status === 'overdue' && owed > Number(p.reminders_sent)) {
        await c.query(`UPDATE hub_settlement_position SET reminders_sent = $2 WHERE id = $1`, [p.id, owed]);
        const outstanding = Number(pos.net_minor) - Number(pos.paid_minor);
        const msg = `Hub settlement payment overdue ${late} day(s): ${p.payer_name} owes ${p.payee_name} ${outstanding} (${p.currency} minor units), due ${p.due}.`;
        alert(p.payer_org_id, 'hub.payment_overdue', msg, { type: 'hub_settlement_position', id: p.id }, late >= 14 ? 'critical' : 'warning');
        alert(null, 'hub.payment_overdue', msg, { type: 'hub_settlement_position', id: p.id }, late >= 14 ? 'critical' : 'warning');
        reminders++;
      }
    });
  }
  const inv = await many(`SELECT i.*, to_char(i.due_date, 'YYYY-MM-DD') AS due FROM hub_fee_invoice i WHERE i.status = 'issued'`);
  for (const i of inv) {
    const today = localDateString(now, i.currency);
    if (today <= i.due) continue;
    const late = daysBetween(i.due, today);
    const owed = REMINDER_DAYS.filter((d) => d <= late).length;
    if (owed > Number(i.data?.remindersSent ?? 0)) {
      await one(`UPDATE hub_fee_invoice SET data = jsonb_set(data, '{remindersSent}', to_jsonb($2::int)) WHERE id = $1`, [i.id, owed]);
      const msg = `Hub fee invoice ${i.number} is overdue ${late} day(s) (${i.total_minor} ${i.currency} minor units, due ${i.due}).`;
      alert(i.org_id, 'hub.fee_invoice_overdue', msg, { type: 'hub_fee_invoice', id: i.id });
      alert(null, 'hub.fee_invoice_overdue', msg, { type: 'hub_fee_invoice', id: i.id });
      invoices++;
    }
  }
  return { positions, reminders, invoices };
}

/**
 * Worker (daily): keep a draft for the PREVIOUS period of every currency fresh, and tell the platform once it
 * can be finalised. Finalising stays a human decision (it issues statements and invoices).
 */
export async function scheduleRuns(now = new Date()): Promise<number> {
  let n = 0;
  for (const cur of CURRENCY_CODES) {
    const period = previousPeriod(now, cur, config.hub.cycle);
    const any = await one(`SELECT 1 FROM hub_cdr WHERE currency = $1 LIMIT 1`, [cur]);
    if (!any) continue;
    try {
      const { run } = await buildRun(cur, period, { now });
      if (run.status === 'draft') n++;
      if (run.status === 'draft' && now >= new Date(run.finalisable_at) && !(run as any).ready_alerted_at) {
        await one(`UPDATE hub_settlement_run SET ready_alerted_at = $2 WHERE id = $1`, [run.id, now]);
        alert(null, 'hub.settlement_ready', `The ${cur} hub settlement run for ${period} can be finalised (${run.preview?.cdrCount ?? 0} CDRs, ${run.preview?.positions?.length ?? 0} positions).`, { type: 'hub_settlement_run', id: run.id }, 'info');
      }
    } catch (e) {
      logger.error({ err: (e as Error).message, currency: cur, period }, 'hub settlement draft failed');
    }
  }
  return n;
}
