/**
 * Bilateral netting (docs/HUB-DESIGN.md §8.5) — pure, unit-tested.
 *
 * For one run (one currency), every settled CDR moves its amount from its eMSP member to its CPO member. The
 * amount is the CDR's total INCLUDING tax (what the CPO invoices the eMSP), or its total excluding tax when the
 * CDR carried no incl_vat (flag no_incl_vat). Credit CDRs carry negative totals and offset their originals.
 *
 * Per unordered member pair {A, B} (A < B by id):
 *   a_owes_b = Σ amount where B is CPO and A is eMSP
 *   b_owes_a = Σ amount where A is CPO and B is eMSP
 *   net = |a_owes_b − b_owes_a|, paid by the side that owes more (none when 0).
 * Per member: receivable = Σ as CPO, payable = Σ as eMSP, net = receivable − payable, which equals the sum of
 * its signed bilateral nets (the identity is asserted). Hub fees are per member and NOT netted (§8.4: PlugSure
 * holds no funds and invoices its fees separately).
 *
 * Only one currency per call: a mixed list is an error, never a total (no FX, D11).
 */

export interface NetInput {
  cpo_member_id: string;
  emsp_member_id: string;
  currency: string;
  total_excl_minor: number | string;
  total_incl_minor: number | string | null;
  fee_cpo_minor?: number | string | null;
  fee_emsp_minor?: number | string | null;
  energy_kwh?: number | string | null;
}

export interface Position {
  memberA: string;
  memberB: string;
  aOwesB: number;
  bOwesA: number;
  net: number;
  payer: string | null;
  payee: string | null;
  cdrCount: number;
}

export interface MemberTotals {
  memberId: string;
  receivable: number;
  payable: number;
  net: number;
  feeCpo: number;
  feeEmsp: number;
  feeNet: number;
  cdrsAsCpo: number;
  cdrsAsEmsp: number;
  energyAsCpoKwh: number;
  energyAsEmspKwh: number;
}

/** The amount that moves for one CDR (incl. tax; excl. when incl is absent). */
export const settlementAmount = (c: Pick<NetInput, 'total_excl_minor' | 'total_incl_minor'>): number =>
  Number(c.total_incl_minor ?? c.total_excl_minor);

const assertInt = (n: number, what: string) => { if (!Number.isSafeInteger(n)) throw new Error(`${what} is not a whole number of minor units: ${n}`); };

export function net(cdrs: NetInput[], currency: string): { positions: Position[]; members: MemberTotals[] } {
  const pairs = new Map<string, Position>();
  const members = new Map<string, MemberTotals>();
  const m = (id: string): MemberTotals => {
    let t = members.get(id);
    if (!t) { t = { memberId: id, receivable: 0, payable: 0, net: 0, feeCpo: 0, feeEmsp: 0, feeNet: 0, cdrsAsCpo: 0, cdrsAsEmsp: 0, energyAsCpoKwh: 0, energyAsEmspKwh: 0 }; members.set(id, t); }
    return t;
  };
  for (const c of cdrs) {
    if (c.currency !== currency) throw new Error(`cannot net a ${c.currency} CDR in a ${currency} run`);
    if (c.cpo_member_id === c.emsp_member_id) throw new Error('a member cannot owe itself (self-roaming CDR)');
    const amt = settlementAmount(c);
    assertInt(amt, 'CDR total');
    const [a, b] = c.emsp_member_id < c.cpo_member_id ? [c.emsp_member_id, c.cpo_member_id] : [c.cpo_member_id, c.emsp_member_id];
    const key = `${a}|${b}`;
    let p = pairs.get(key);
    if (!p) { p = { memberA: a, memberB: b, aOwesB: 0, bOwesA: 0, net: 0, payer: null, payee: null, cdrCount: 0 }; pairs.set(key, p); }
    if (c.emsp_member_id === a) p.aOwesB += amt; else p.bOwesA += amt;
    p.cdrCount++;
    const cpo = m(c.cpo_member_id);
    const emsp = m(c.emsp_member_id);
    const kwh = Number(c.energy_kwh ?? 0);
    cpo.receivable += amt; cpo.cdrsAsCpo++; cpo.energyAsCpoKwh += kwh;
    emsp.payable += amt; emsp.cdrsAsEmsp++; emsp.energyAsEmspKwh += kwh;
    const fc = Number(c.fee_cpo_minor ?? 0), fe = Number(c.fee_emsp_minor ?? 0);
    assertInt(fc, 'CPO fee'); assertInt(fe, 'eMSP fee');
    cpo.feeCpo += fc;
    emsp.feeEmsp += fe;
  }
  for (const p of pairs.values()) {
    const d = p.aOwesB - p.bOwesA;
    p.net = Math.abs(d);
    p.payer = d > 0 ? p.memberA : d < 0 ? p.memberB : null;
    p.payee = d > 0 ? p.memberB : d < 0 ? p.memberA : null;
  }
  for (const t of members.values()) {
    t.net = t.receivable - t.payable;
    t.feeNet = t.feeCpo + t.feeEmsp;
    t.energyAsCpoKwh = Math.round(t.energyAsCpoKwh * 1000) / 1000;
    t.energyAsEmspKwh = Math.round(t.energyAsEmspKwh * 1000) / 1000;
    // Identity: a member's net is the sum of its signed bilateral nets.
    const signed = [...pairs.values()].reduce((s, p) => s + (p.payee === t.memberId ? p.net : p.payer === t.memberId ? -p.net : 0), 0);
    if (signed !== t.net) throw new Error(`netting identity broken for member ${t.memberId}: ${signed} ≠ ${t.net}`);
  }
  const byId = (x: { memberA?: string; memberId?: string }, y: { memberA?: string; memberId?: string }) => String(x.memberA ?? x.memberId).localeCompare(String(y.memberA ?? y.memberId));
  return {
    positions: [...pairs.values()].sort((x, y) => byId(x, y) || x.memberB.localeCompare(y.memberB)),
    members: [...members.values()].sort(byId),
  };
}

/** What a member sees of a position: its counterparty, and what it receives (+) or pays (−). */
export function positionFor(p: Position, memberId: string): { counterparty: string; receivable: number; payable: number; signedNet: number } {
  const isA = p.memberA === memberId;
  if (!isA && p.memberB !== memberId) throw new Error('not a party to this position');
  const receivable = isA ? p.bOwesA : p.aOwesB;
  const payable = isA ? p.aOwesB : p.bOwesA;
  return { counterparty: isA ? p.memberB : p.memberA, receivable, payable, signedNet: receivable - payable };
}
