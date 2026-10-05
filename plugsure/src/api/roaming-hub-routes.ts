import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { many, one, outsideRequestScope } from '../db/pool.js';
import { CURRENCY_CODES } from '../domain/money.js';
import { assertCan } from '../services/authz.js';
import { seal, unseal } from '../services/secrets.js';
import { HubError } from '../hub/errors.js';
import { raiseDispute, transition, addNote } from '../hub/clearing/disputes.js';
import { planFor } from '../hub/clearing/fees.js';
import { confirmPayment, recordPayment } from '../hub/clearing/settlement.js';
import { audit } from '../hub/clearing/notify.js';
import { ledgerCsv } from '../hub/clearing/documents.js';
import {
  UUID_RE, cdrFilterFrom, getCdr, getDispute, getInvoice, getStatement, listCdrs, listDisputes, listInvoices, listPayments, listPositions,
  listStatements, memberDirectory,
} from '../hub/clearing/queries.js';
import { sendInvoice, sendStatement } from './hub-clearing-routes.js';

/**
 * A hub member's own clearing view (WP H2, design §9.2): its ledger rows on both sides, disputes, statements,
 * fee invoices, settlement positions and payments, under /v1/roaming/hub/clearing/*. For internal tenants and
 * for external members' hub-only organisations alike (roaming:read / roaming:write).
 *
 * Reads run INSIDE the member's request scope: row-level security (073) admits only rows of the member's own
 * organisation, and every query also filters by the member. Changes go through the clearing services, which
 * check that the member is the right side (the eMSP disputes and escalates; the CPO accepts or rejects; the
 * payee confirms a payment), and are audited on the platform chain and both members' chains.
 */

export async function registerRoamingHubClearingRoutes(app: FastifyInstance): Promise<void> {
  const read = (req: FastifyRequest) => assertCan(req.principal, { permission: 'roaming:read' });
  const write = (req: FastifyRequest) => assertCan(req.principal, { permission: 'roaming:write' });
  const bad = (reply: FastifyReply, status: number, error: string) => reply.status(status).send({ error });
  const q = (req: FastifyRequest) => (req.query ?? {}) as Record<string, unknown>;
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, any>;
  /** The caller's hub member (in its own scope: RLS shows only its own member row). */
  const memberOf = async (req: FastifyRequest) => {
    const m = await one<{ id: string; org_id: string; country_code: string; legal_name: string; bank_details: string | null; status: string; kind: string }>(
      `SELECT id, org_id, country_code, legal_name, bank_details, status, kind FROM hub_member WHERE org_id = $1`, [req.principal.orgId]);
    if (!m) throw new HubError(404, 2000, 'this organisation is not a member of PlugSure Hub');
    return m;
  };
  const run = async <T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HubError) return bad(reply, e.http >= 400 ? e.http : 409, e.message);
      throw e;
    }
  };
  /** A change: made by the clearing services on their own transaction (not the request's). */
  const change = <T>(fn: () => Promise<T>) => outsideRequestScope(fn);
  const pid = (req: FastifyRequest) => {
    const v = String((req.params as { id?: string }).id ?? '');
    if (!UUID_RE.test(v)) throw new HubError(404, 2000, 'not found');
    return v;
  };
  const who = (req: FastifyRequest) => ({ userId: req.principal?.userId ?? null, ip: req.ip });
  const named = async <T extends Record<string, any>>(rows: T[], keys: string[]) => {
    const dir = await memberDirectory(rows.flatMap((r) => keys.map((k) => r[k])));
    return rows.map((r) => ({ ...r, ...Object.fromEntries(keys.map((k) => [k.replace(/_id$/, '_name'), dir[r[k]]?.name ?? null])) }));
  };
  const sideOf = (row: { cpo_member_id?: string; emsp_member_id?: string }, memberId: string) => (row.cpo_member_id === memberId ? 'cpo' : 'emsp');

  app.get('/v1/roaming/hub/clearing/summary', async (req, reply) => {
    read(req);
    return run(reply, async () => {
      const m = await memberOf(req);
      let bank: string | null = null;
      try { bank = m.bank_details ? unseal(m.bank_details, `hub_member:${m.id}:bank`) : null; } catch { bank = null; }
      return {
        member: { id: m.id, legal_name: m.legal_name, country_code: m.country_code, status: m.status, kind: m.kind, bank_details: bank },
        cdrs: await many(`SELECT CASE WHEN cpo_member_id = $1 THEN 'cpo' ELSE 'emsp' END AS side, currency, status, count(*)::int AS n,
                                 COALESCE(sum(COALESCE(total_incl_minor, total_excl_minor)), 0)::bigint AS amount_minor
                            FROM hub_cdr WHERE cpo_member_id = $1 OR emsp_member_id = $1 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [m.id]),
        openDisputes: (await one<{ n: number }>(`SELECT count(*)::int AS n FROM hub_dispute WHERE (cpo_member_id = $1 OR emsp_member_id = $1) AND status IN ('open','accepted','rejected','escalated')`, [m.id]))?.n ?? 0,
        positions: await many(`SELECT currency, CASE WHEN payer_member_id = $1 THEN 'pay' ELSE 'receive' END AS direction, status, count(*)::int AS n,
                                      COALESCE(sum(net_minor - paid_minor), 0)::bigint AS outstanding_minor
                                 FROM hub_settlement_position WHERE (payer_member_id = $1 OR payee_member_id = $1) AND status IN ('open','partially_paid','overdue','paid')
                                GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [m.id]),
      };
    });
  });

  // ── own ledger
  app.get('/v1/roaming/hub/clearing/cdrs', async (req, reply) => {
    read(req);
    return run(reply, async () => {
      const m = await memberOf(req);
      const r = await listCdrs(cdrFilterFrom(q(req)), m.id);
      const rows = (await named(r.cdrs, ['cpo_member_id', 'emsp_member_id'])).map((x) => ({ ...x, side: sideOf(x, m.id) }));
      return { cdrs: rows, next_cursor: r.next_cursor };
    });
  });
  app.get('/v1/roaming/hub/clearing/cdrs.csv', async (req, reply) => {
    read(req);
    return run(reply, async () => {
      const m = await memberOf(req);
      const all: any[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 100; i++) {
        const p = await listCdrs({ ...cdrFilterFrom(q(req)), limit: 500, cursor }, m.id);
        all.push(...p.cdrs);
        if (!p.next_cursor) break;
        cursor = p.next_cursor;
      }
      return reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="hub-cdrs.csv"').send('﻿' + ledgerCsv(all));
    });
  });
  app.get('/v1/roaming/hub/clearing/cdrs/:id', async (req, reply) => {
    read(req);
    return run(reply, async () => {
      const m = await memberOf(req);
      const r = await getCdr(pid(req), m.id);
      if (!r) throw new HubError(404, 2000, 'CDR not found');
      const [cdr] = await named([r.cdr], ['cpo_member_id', 'emsp_member_id']);
      return { ...r, cdr: { ...cdr, side: sideOf(cdr, m.id) } };
    });
  });
  app.post('/v1/roaming/hub/clearing/cdrs/:id/dispute', async (req, reply) => {
    write(req);
    return run(reply, async () => {
      const m = await memberOf(req);
      const cid = pid(req);
      const d = await change(() => raiseDispute(cid, { side: 'emsp', memberId: m.id, ...who(req) }, body(req)));
      return reply.status(201).send({ dispute: d });
    });
  });

  // ── disputes
  app.get('/v1/roaming/hub/clearing/disputes', async (req, reply) => {
    read(req);
    return run(reply, async () => {
      const m = await memberOf(req);
      const rows = await listDisputes(q(req), m.id);
      return { disputes: (await named(rows, ['cpo_member_id', 'emsp_member_id'])).map((d) => ({ ...d, side: sideOf(d, m.id) })) };
    });
  });
  app.get('/v1/roaming/hub/clearing/disputes/:id', async (req, reply) => {
    read(req);
    return run(reply, async () => {
      const m = await memberOf(req);
      const r = await getDispute(pid(req), m.id);
      if (!r) throw new HubError(404, 2000, 'dispute not found');
      const [named1] = await named([r.dispute], ['cpo_member_id', 'emsp_member_id']);
      return { ...r, dispute: { ...named1, side: sideOf(r.dispute, m.id) } };
    });
  });
  app.post('/v1/roaming/hub/clearing/disputes/:id/respond', async (req, reply) => {
    write(req);
    return run(reply, async () => {
      const m = await memberOf(req);
      const did = pid(req);
      const b = body(req);
      if (b.action !== 'accept' && b.action !== 'reject') throw new HubError(400, 2001, 'action: accept (you will send a credit CDR) or reject (with a note)');
      return { dispute: await change(() => transition(did, b.action, { side: 'cpo', memberId: m.id, ...who(req) }, { note: b.note })) };
    });
  });
  for (const action of ['escalate', 'withdraw'] as const) {
    app.post(`/v1/roaming/hub/clearing/disputes/:id/${action}`, async (req, reply) => {
      write(req);
      return run(reply, async () => {
        const m = await memberOf(req);
        const did = pid(req);
        return { dispute: await change(() => transition(did, action, { side: 'emsp', memberId: m.id, ...who(req) }, { note: body(req).note })) };
      });
    });
  }
  app.post('/v1/roaming/hub/clearing/disputes/:id/notes', async (req, reply) => {
    write(req);
    return run(reply, async () => {
      const m = await memberOf(req);
      const did = pid(req);
      const d = await getDispute(did, m.id);
      if (!d) throw new HubError(404, 2000, 'dispute not found');
      const side = d.dispute.cpo_member_id === m.id ? 'cpo' : 'emsp';
      return { notes: await change(() => addNote(did, { side, memberId: m.id, ...who(req) }, body(req).note)) };
    });
  });

  // ── statements and fee invoices
  app.get('/v1/roaming/hub/clearing/statements', async (req, reply) => {
    read(req);
    return run(reply, async () => ({ statements: await listStatements(q(req), (await memberOf(req)).id) }));
  });
  app.get('/v1/roaming/hub/clearing/statements/:id', async (req, reply) => {
    read(req);
    return run(reply, async () => {
      const s = await getStatement(pid(req), (await memberOf(req)).id);
      if (!s) throw new HubError(404, 2000, 'statement not found');
      return { statement: s };
    });
  });
  for (const fmt of ['html', 'pdf', 'csv'] as const) {
    app.get(`/v1/roaming/hub/clearing/statements/:id/${fmt}`, async (req, reply) => {
      read(req);
      return run(reply, async () => {
        const s = await getStatement(pid(req), (await memberOf(req)).id);
        if (!s) throw new HubError(404, 2000, 'statement not found');
        return sendStatement(reply, s, fmt);
      });
    });
  }
  app.get('/v1/roaming/hub/clearing/fee-invoices', async (req, reply) => {
    read(req);
    return run(reply, async () => ({ feeInvoices: await listInvoices(q(req), (await memberOf(req)).id) }));
  });
  app.get('/v1/roaming/hub/clearing/fee-invoices/:id', async (req, reply) => {
    read(req);
    return run(reply, async () => {
      const i = await getInvoice(pid(req), (await memberOf(req)).id);
      if (!i) throw new HubError(404, 2000, 'fee invoice not found');
      return { feeInvoice: i };
    });
  });
  for (const fmt of ['html', 'pdf'] as const) {
    app.get(`/v1/roaming/hub/clearing/fee-invoices/:id/${fmt}`, async (req, reply) => {
      read(req);
      return run(reply, async () => {
        const i = await getInvoice(pid(req), (await memberOf(req)).id);
        if (!i) throw new HubError(404, 2000, 'fee invoice not found');
        return sendInvoice(reply, i, fmt);
      });
    });
  }
  app.get('/v1/roaming/hub/clearing/fee-plans', async (req, reply) => {
    read(req);
    return run(reply, async () => {
      const m = await memberOf(req);
      // The member's own commission terms per currency (its plan, else the default); agreement plans override per agreement.
      const plans: Record<string, unknown> = {};
      for (const cur of CURRENCY_CODES) {
        const ctx = { agreement_id: null, cpo_member_id: m.id, emsp_member_id: m.id, currency: cur, start_at: new Date() };
        const [cpo, emsp] = await outsideRequestScope(() => Promise.all([planFor('cpo', ctx), planFor('emsp', ctx)]));
        plans[cur] = {
          asCpo: cpo ? { feePlanId: cpo.id, name: cpo.name, bps: cpo.cpo_bps, fixed_minor: cpo.cpo_fixed_minor, min_minor: cpo.cpo_min_minor, max_minor: cpo.cpo_max_minor } : null,
          asEmsp: emsp ? { feePlanId: emsp.id, name: emsp.name, bps: emsp.emsp_bps, fixed_minor: emsp.emsp_fixed_minor, min_minor: emsp.emsp_min_minor, max_minor: emsp.emsp_max_minor } : null,
        };
      }
      return { feePlans: plans };
    });
  });

  // ── positions and payments
  app.get('/v1/roaming/hub/clearing/positions', async (req, reply) => {
    read(req);
    return run(reply, async () => {
      const m = await memberOf(req);
      const rows = await named(await listPositions(q(req), m.id), ['member_a_id', 'member_b_id', 'payer_member_id', 'payee_member_id']);
      return { positions: rows.map((p) => ({ ...p, direction: p.payer_member_id === m.id ? 'pay' : p.payee_member_id === m.id ? 'receive' : 'none' })) };
    });
  });
  app.get('/v1/roaming/hub/clearing/payments', async (req, reply) => {
    read(req);
    return run(reply, async () => {
      const m = await memberOf(req);
      return { payments: await named(await listPayments(q(req), m.id), ['payer_member_id', 'payee_member_id']) };
    });
  });
  app.post('/v1/roaming/hub/clearing/payments', async (req, reply) => {
    write(req);
    return run(reply, async () => {
      const m = await memberOf(req);
      const b = body(req);
      if (!UUID_RE.test(String(b.position_id ?? ''))) throw new HubError(400, 2001, 'position_id is required');
      return reply.status(201).send(await change(() => recordPayment(String(b.position_id), { side: 'member', memberId: m.id, ...who(req) }, b)));
    });
  });
  app.post('/v1/roaming/hub/clearing/payments/:id/confirm', async (req, reply) => {
    write(req);
    return run(reply, async () => {
      const m = await memberOf(req);
      const id = pid(req);
      return change(() => confirmPayment(id, { side: 'member', memberId: m.id, ...who(req) }));
    });
  });
  app.put('/v1/roaming/hub/clearing/bank-details', async (req, reply) => {
    write(req);
    return run(reply, async () => {
      const m = await memberOf(req);
      const text = typeof body(req).bank_details === 'string' ? body(req).bank_details.trim().slice(0, 1000) : '';
      if (!text) throw new HubError(400, 2001, 'bank_details: the account your counterparties pay into (bank, account name and number)');
      await change(() => one(`UPDATE hub_member SET bank_details = $2, updated_at = now() WHERE id = $1`, [m.id, seal(text, `hub_member:${m.id}:bank`)]));
      await change(() => audit('hub.bank_details_updated', 'hub_member', m.id, { actorId: req.principal?.userId ?? null, orgIds: [m.org_id], ip: req.ip }));
      return { ok: true };
    });
  });
}
