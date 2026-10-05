import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { many, one, outsideRequestScope, tx } from '../db/pool.js';
import { CURRENCY_CODES, isCurrency } from '../domain/money.js';
import { assertCan } from '../services/authz.js';
import { seal, unseal } from '../services/secrets.js';
import { HubError } from '../hub/errors.js';
import { autoAccept } from '../hub/clearing/accept.js';
import { raiseDispute, transition, addNote } from '../hub/clearing/disputes.js';
import { feePlanProblem } from '../hub/clearing/fees.js';
import { releaseCdr, voidCdr } from '../hub/clearing/intake.js';
import { audit } from '../hub/clearing/notify.js';
import {
  buildRun, confirmPayment, finaliseRun, getRun, parseRunRequest, recordPayment, refreshRun, voidRun, writeOffPosition,
} from '../hub/clearing/settlement.js';
import { feeInvoiceHtml, feeInvoicePdf, ledgerCsv, statementCsv, statementHtml, statementPdf } from '../hub/clearing/documents.js';
import {
  FEE_PLAN_COLS, UUID_RE, cdrFilterFrom, getCdr, getDispute, getInvoice, getStatement, listCdrs, listDisputes, listInvoices, listPayments,
  listPositions, listStatements, memberDirectory,
} from '../hub/clearing/queries.js';

/**
 * Platform administration of hub clearing and settlement (WP H2, docs/HUB-DESIGN.md §9.1 and "H2 as built").
 * Every route requires platform:admin, runs unscoped (the clearing tables are platform-scoped for a platform
 * admin; members use /v1/roaming/hub/clearing/*) and every change is audited on the platform chain (and the
 * members' chains). Like the H1 routes they answer 404 while HUB_ENABLED is false (hub-routes.ts hook).
 */

export async function registerHubClearingRoutes(app: FastifyInstance): Promise<void> {
  const plat = (req: FastifyRequest) => assertCan(req.principal, { permission: 'platform:admin' });
  const actor = (req: FastifyRequest) => req.principal?.userId ?? null;
  const bad = (reply: FastifyReply, status: number, error: string) => reply.status(status).send({ error });
  const run = async <T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await outsideRequestScope(fn);
    } catch (e) {
      if (e instanceof HubError) return bad(reply, e.http >= 400 ? e.http : 409, e.message);
      throw e;
    }
  };
  const id = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const v = String((req.params as { id?: string }).id ?? '');
    if (!UUID_RE.test(v)) { void bad(reply, 404, 'not found'); return null; }
    return v;
  };
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, any>;
  const q = (req: FastifyRequest) => (req.query ?? {}) as Record<string, unknown>;
  const noteOf = (b: Record<string, any>, required = true) => {
    const n = typeof b.note === 'string' ? b.note.trim().slice(0, 2000) : '';
    if (required && !n) throw new HubError(400, 2001, 'note is required');
    return n;
  };
  const withNames = async <T extends Record<string, any>>(rows: T[], keys: string[]) => {
    const dir = await memberDirectory(rows.flatMap((r) => keys.map((k) => r[k])));
    return rows.map((r) => ({ ...r, ...Object.fromEntries(keys.map((k) => [k.replace(/_id$/, '_name'), dir[r[k]]?.name ?? null])) }));
  };

  // ── overview
  app.get('/v1/hub/clearing/overview', async (req, reply) => {
    plat(req);
    return run(reply, async () => ({
      cdrs: await many(`SELECT currency, status, count(*)::int AS n, COALESCE(sum(COALESCE(total_incl_minor, total_excl_minor)), 0)::bigint AS amount_minor
                          FROM hub_cdr GROUP BY 1, 2 ORDER BY 1, 2`),
      held: await many(`SELECT unnest(flags) AS flag, count(*)::int AS n FROM hub_cdr WHERE status = 'held' GROUP BY 1 ORDER BY 2 DESC`),
      disputes: await many(`SELECT status, count(*)::int AS n FROM hub_dispute GROUP BY 1 ORDER BY 1`),
      runs: await many(`SELECT currency, cycle, period, status, finalisable_at, id FROM hub_settlement_run WHERE status <> 'void' ORDER BY period_start DESC, currency LIMIT 36`),
      outstanding: await many(`SELECT currency, status, count(*)::int AS n, COALESCE(sum(net_minor - paid_minor), 0)::bigint AS outstanding_minor
                                 FROM hub_settlement_position WHERE status IN ('open','partially_paid','overdue','paid') GROUP BY 1, 2 ORDER BY 1, 2`),
      feeInvoices: await many(`SELECT currency, status, count(*)::int AS n, COALESCE(sum(total_minor), 0)::bigint AS total_minor FROM hub_fee_invoice GROUP BY 1, 2 ORDER BY 1, 2`),
    }));
  });

  // ── ledger
  app.get('/v1/hub/clearing/cdrs', async (req, reply) => {
    plat(req);
    return run(reply, async () => {
      const r = await listCdrs(cdrFilterFrom(q(req)));
      return { cdrs: await withNames(r.cdrs, ['cpo_member_id', 'emsp_member_id']), next_cursor: r.next_cursor };
    });
  });
  app.get('/v1/hub/clearing/cdrs.csv', async (req, reply) => {
    plat(req);
    return run(reply, async () => {
      const r = await listCdrs({ ...cdrFilterFrom(q(req)), limit: 500 });
      const all = [...r.cdrs];
      let next = r.next_cursor;
      for (let i = 0; next && i < 99; i++) { const p = await listCdrs({ ...cdrFilterFrom(q(req)), limit: 500, cursor: next }); all.push(...p.cdrs); next = p.next_cursor; }
      return reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="hub-ledger.csv"').send(ledgerCsv(all));
    });
  });
  app.get('/v1/hub/clearing/cdrs/:id', async (req, reply) => {
    plat(req);
    const cid = id(req, reply); if (!cid) return;
    return run(reply, async () => {
      const r = await getCdr(cid);
      if (!r) throw new HubError(404, 2000, 'CDR not found');
      const [cdr] = await withNames([r.cdr], ['cpo_member_id', 'emsp_member_id']);
      return { ...r, cdr };
    });
  });
  app.post('/v1/hub/clearing/cdrs/:id/release', async (req, reply) => {
    plat(req);
    const cid = id(req, reply); if (!cid) return;
    return run(reply, async () => ({ cdr: await releaseCdr(cid, actor(req), noteOf(body(req))) }));
  });
  app.post('/v1/hub/clearing/cdrs/:id/void', async (req, reply) => {
    plat(req);
    const cid = id(req, reply); if (!cid) return;
    return run(reply, async () => ({ cdr: await voidCdr(cid, actor(req), noteOf(body(req))) }));
  });
  app.post('/v1/hub/clearing/cdrs/:id/dispute', async (req, reply) => {
    plat(req);
    const cid = id(req, reply); if (!cid) return;
    return run(reply, async () => reply.status(201).send({ dispute: await raiseDispute(cid, { side: 'platform', userId: actor(req), ip: req.ip }, body(req)) }));
  });
  app.post('/v1/hub/clearing/accept-due', async (req, reply) => {
    plat(req);
    return run(reply, async () => {
      const n = await autoAccept();
      if (n) await audit('hub.cdrs_accepted', 'hub_cdr', 'accept-due', { actorId: actor(req), after: { accepted: n } });
      return { accepted: n };
    });
  });

  // ── disputes
  app.get('/v1/hub/clearing/disputes', async (req, reply) => {
    plat(req);
    return run(reply, async () => ({ disputes: await withNames(await listDisputes(q(req)), ['cpo_member_id', 'emsp_member_id']) }));
  });
  app.get('/v1/hub/clearing/disputes/:id', async (req, reply) => {
    plat(req);
    const did = id(req, reply); if (!did) return;
    return run(reply, async () => {
      const r = await getDispute(did);
      if (!r) throw new HubError(404, 2000, 'dispute not found');
      const [dispute] = await withNames([r.dispute], ['cpo_member_id', 'emsp_member_id']);
      return { ...r, dispute };
    });
  });
  app.post('/v1/hub/clearing/disputes/:id/resolve', async (req, reply) => {
    plat(req);
    const did = id(req, reply); if (!did) return;
    const b = body(req);
    const outcome = String(b.outcome ?? '');
    if (!['upheld', 'written_off', 'credit_required'].includes(outcome)) return bad(reply, 400, 'outcome: upheld, written_off or credit_required');
    return run(reply, async () => ({ dispute: await transition(did, `resolve_${outcome}` as 'resolve_upheld', { side: 'platform', userId: actor(req), ip: req.ip }, { note: b.note }) }));
  });
  for (const action of ['escalate', 'withdraw'] as const) {
    app.post(`/v1/hub/clearing/disputes/:id/${action}`, async (req, reply) => {
      plat(req);
      const did = id(req, reply); if (!did) return;
      return run(reply, async () => ({ dispute: await transition(did, action, { side: 'platform', userId: actor(req), ip: req.ip }, { note: body(req).note }) }));
    });
  }
  app.post('/v1/hub/clearing/disputes/:id/notes', async (req, reply) => {
    plat(req);
    const did = id(req, reply); if (!did) return;
    return run(reply, async () => ({ notes: await addNote(did, { side: 'platform', userId: actor(req) }, body(req).note) }));
  });

  // ── commission: fee plans, per-agreement and per-member terms. TODO(commercial): rates are placeholders (0).
  app.get('/v1/hub/clearing/fee-plans', async (req, reply) => {
    plat(req);
    return run(reply, async () => ({
      feePlans: await many(`SELECT ${FEE_PLAN_COLS}, (SELECT count(*)::int FROM hub_fee_assignment f WHERE f.fee_plan_id = hub_fee_plan.id) AS assignments
                              FROM hub_fee_plan ORDER BY currency, is_default DESC, effective_from DESC, name`),
    }));
  });
  app.post('/v1/hub/clearing/fee-plans', async (req, reply) => {
    plat(req);
    const b = body(req);
    if (!isCurrency(b.currency)) return bad(reply, 400, `currency: ${CURRENCY_CODES.join(', ')}`);
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 120) : '';
    if (!name) return bad(reply, 400, 'name is required');
    const problem = feePlanProblem(b);
    if (problem) return bad(reply, 400, problem);
    const eff = b.effective_from == null ? null : String(b.effective_from);
    if (eff != null && !/^\d{4}-\d{2}-\d{2}$/.test(eff)) return bad(reply, 400, 'effective_from: YYYY-MM-DD');
    return run(reply, async () => {
      const p = await one(
        `INSERT INTO hub_fee_plan (name, currency, cpo_bps, cpo_fixed_minor, cpo_min_minor, cpo_max_minor, emsp_bps, emsp_fixed_minor, emsp_min_minor, emsp_max_minor,
                                   is_default, effective_from, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::date, CURRENT_DATE),$13,$14,$14) RETURNING ${FEE_PLAN_COLS}`,
        [name, b.currency, b.cpo_bps ?? 0, b.cpo_fixed_minor ?? 0, b.cpo_min_minor ?? 0, b.cpo_max_minor ?? null, b.emsp_bps ?? 0, b.emsp_fixed_minor ?? 0,
          b.emsp_min_minor ?? 0, b.emsp_max_minor ?? null, b.is_default === true, eff, typeof b.notes === 'string' ? b.notes.slice(0, 1000) : null, actor(req)],
      ).catch((e: { code?: string }) => { if (e.code === '23505') throw new HubError(409, 2000, 'a default plan for this currency already starts on that date'); throw e; });
      await audit('hub.fee_plan_created', 'hub_fee_plan', p.id, { actorId: actor(req), after: p });
      return reply.status(201).send({ feePlan: p });
    });
  });
  app.patch('/v1/hub/clearing/fee-plans/:id', async (req, reply) => {
    plat(req);
    const pid = id(req, reply); if (!pid) return;
    const b = body(req);
    return run(reply, async () => {
      const before = await one(`SELECT ${FEE_PLAN_COLS} FROM hub_fee_plan WHERE id = $1`, [pid]);
      if (!before) throw new HubError(404, 2000, 'fee plan not found');
      const merged = { ...before, ...b };
      const problem = feePlanProblem(merged);
      if (problem) throw new HubError(400, 2001, problem);
      const keys = ['name', 'cpo_bps', 'cpo_fixed_minor', 'cpo_min_minor', 'cpo_max_minor', 'emsp_bps', 'emsp_fixed_minor', 'emsp_min_minor', 'emsp_max_minor', 'notes'].filter((k) => k in b);
      if (!keys.length) return { feePlan: before };
      const p = await one(`UPDATE hub_fee_plan SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now(), updated_by = $${keys.length + 2}
                            WHERE id = $1 RETURNING ${FEE_PLAN_COLS}`, [pid, ...keys.map((k) => (b[k] === undefined ? null : b[k])), actor(req)]);
      // Fees already frozen on accepted CDRs do not move; the new values apply to CDRs accepted from now on.
      await audit('hub.fee_plan_updated', 'hub_fee_plan', pid, { actorId: actor(req), before, after: p });
      return { feePlan: p };
    });
  });
  const feeTerms = async (column: 'agreement_id' | 'member_id', target: string, plans: unknown, actorId: string | null) => {
    if (plans == null) return;
    if (typeof plans !== 'object' || Array.isArray(plans)) throw new HubError(400, 2001, 'fee_plans: { "<currency>": "<fee plan id>" | null }');
    await tx(async (c) => {
      for (const [cur, planId] of Object.entries(plans as Record<string, unknown>)) {
        if (!isCurrency(cur)) throw new HubError(400, 2001, `fee_plans: unknown currency ${cur}`);
        await c.query(`DELETE FROM hub_fee_assignment WHERE ${column} = $1 AND currency = $2`, [target, cur]);
        if (planId == null) continue;
        const p = (await c.query(`SELECT currency FROM hub_fee_plan WHERE id = $1`, [String(planId)])).rows[0];
        if (!p || !UUID_RE.test(String(planId))) throw new HubError(404, 2000, `fee plan ${String(planId)} not found`);
        if (p.currency !== cur) throw new HubError(400, 2001, `fee plan ${String(planId)} is a ${p.currency} plan, not ${cur}`);
        await c.query(`INSERT INTO hub_fee_assignment (${column}, currency, fee_plan_id, created_by) VALUES ($1,$2,$3,$4)`, [target, cur, planId, actorId]);
      }
    });
  };
  const termsOf = async (column: 'agreement_id' | 'member_id', target: string) =>
    Object.fromEntries((await many(`SELECT f.currency, f.fee_plan_id, p.name FROM hub_fee_assignment f JOIN hub_fee_plan p ON p.id = f.fee_plan_id WHERE f.${column} = $1`, [target]))
      .map((r) => [r.currency, { feePlanId: r.fee_plan_id, name: r.name }]));
  app.get('/v1/hub/clearing/agreements', async (req, reply) => {
    plat(req);
    return run(reply, async () => {
      const rows = await many(
        `SELECT a.id, a.status, a.cpo_party_id, a.emsp_party_id, c.country_code || '*' || c.party_id AS cpo, e.country_code || '*' || e.party_id AS emsp,
                c.member_id AS cpo_member_id, e.member_id AS emsp_member_id, a.dispute_days,
                (SELECT COALESCE(json_object_agg(f.currency, f.fee_plan_id), '{}'::json) FROM hub_fee_assignment f WHERE f.agreement_id = a.id) AS fee_plans
           FROM hub_agreement a JOIN hub_party c ON c.id = a.cpo_party_id JOIN hub_party e ON e.id = a.emsp_party_id
          ORDER BY a.created_at DESC LIMIT 1000`);
      return { agreements: (await withNames(rows, ['cpo_member_id', 'emsp_member_id'])).map((a) => ({ ...a, effective_dispute_days: a.dispute_days ?? null })) };
    });
  });
  app.put('/v1/hub/clearing/agreements/:id/terms', async (req, reply) => {
    plat(req);
    const aid = id(req, reply); if (!aid) return;
    const b = body(req);
    return run(reply, async () => {
      const a = await one(`SELECT id, cpo_org_id, emsp_org_id, dispute_days FROM hub_agreement WHERE id = $1`, [aid]);
      if (!a) throw new HubError(404, 2000, 'agreement not found');
      if ('dispute_days' in b) {
        const d = b.dispute_days;
        if (d !== null && (!Number.isInteger(d) || d < 1 || d > 90)) throw new HubError(400, 2001, 'dispute_days: null (the hub default) or 1 to 90');
        await one(`UPDATE hub_agreement SET dispute_days = $2, updated_at = now() WHERE id = $1`, [aid, d]);
      }
      await feeTerms('agreement_id', aid, b.fee_plans, actor(req));
      const terms = { dispute_days: (await one(`SELECT dispute_days FROM hub_agreement WHERE id = $1`, [aid]))?.dispute_days ?? null, fee_plans: await termsOf('agreement_id', aid) };
      await audit('hub.agreement_terms', 'hub_agreement', aid, { actorId: actor(req), orgIds: [a.cpo_org_id, a.emsp_org_id], before: { dispute_days: a.dispute_days }, after: terms });
      return { agreementId: aid, ...terms };
    });
  });
  app.get('/v1/hub/clearing/members/:id/terms', async (req, reply) => {
    plat(req);
    const mid = id(req, reply); if (!mid) return;
    return run(reply, async () => {
      if (!(await one(`SELECT 1 FROM hub_member WHERE id = $1`, [mid]))) throw new HubError(404, 2000, 'member not found');
      return { memberId: mid, fee_plans: await termsOf('member_id', mid) };
    });
  });
  app.put('/v1/hub/clearing/members/:id/terms', async (req, reply) => {
    plat(req);
    const mid = id(req, reply); if (!mid) return;
    return run(reply, async () => {
      const m = await one(`SELECT id, org_id FROM hub_member WHERE id = $1`, [mid]);
      if (!m) throw new HubError(404, 2000, 'member not found');
      await feeTerms('member_id', mid, body(req).fee_plans, actor(req));
      const terms = { fee_plans: await termsOf('member_id', mid) };
      await audit('hub.member_fee_terms', 'hub_member', mid, { actorId: actor(req), orgIds: [m.org_id], after: terms });
      return { memberId: mid, ...terms };
    });
  });

  // ── PlugSure entities (fee invoice issuers): placeholders until the owner confirms them
  const entityOut = (e: any) => {
    let bank: string | null = null;
    try { bank = e.bank_details ? unseal(e.bank_details, `hub_entity:${e.country_code}:bank`) : null; } catch { bank = null; }
    return { ...e, bank_details: bank };
  };
  app.get('/v1/hub/clearing/entities', async (req, reply) => {
    plat(req);
    return run(reply, async () => ({ entities: (await many(`SELECT * FROM hub_entity ORDER BY country_code`)).map(entityOut) }));
  });
  app.put('/v1/hub/clearing/entities/:country', async (req, reply) => {
    plat(req);
    const cc = String((req.params as { country?: string }).country ?? '').toUpperCase();
    if (!['ID', 'MY', 'SG'].includes(cc)) return bad(reply, 404, 'not found');
    const b = body(req);
    const str = (k: string, max: number) => (typeof b[k] === 'string' ? b[k].trim().slice(0, max) : undefined);
    const legal = str('legal_name', 200), address = str('address', 500), prefix = str('invoice_prefix', 20);
    if (!legal || !address || !prefix) return bad(reply, 400, 'legal_name, address and invoice_prefix are required');
    if (!/^[A-Z0-9-]{2,20}$/.test(prefix)) return bad(reply, 400, 'invoice_prefix: 2-20 of A-Z, 0-9 and -');
    return run(reply, async () => {
      const bank = str('bank_details', 1000);
      const e = await one(
        `INSERT INTO hub_entity (country_code, legal_name, tax_id, tax_registered, address, bank_details, invoice_prefix, placeholder, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (country_code) DO UPDATE SET legal_name = EXCLUDED.legal_name, tax_id = EXCLUDED.tax_id, tax_registered = EXCLUDED.tax_registered,
           address = EXCLUDED.address, bank_details = COALESCE(EXCLUDED.bank_details, hub_entity.bank_details), invoice_prefix = EXCLUDED.invoice_prefix,
           placeholder = EXCLUDED.placeholder, updated_at = now()
         RETURNING *`,
        [cc, legal, str('tax_id', 40) ?? null, b.tax_registered === true, address, bank ? seal(bank, `hub_entity:${cc}:bank`) : null, prefix, b.placeholder === true]);
      await audit('hub.entity_updated', 'hub_entity', cc, { actorId: actor(req), after: { legal_name: legal, tax_registered: b.tax_registered === true, placeholder: b.placeholder === true } });
      return { entity: entityOut(e) };
    });
  });

  // ── settlement runs
  app.get('/v1/hub/clearing/runs', async (req, reply) => {
    plat(req);
    const qq = q(req);
    return run(reply, async () => ({
      runs: await many(`SELECT id, currency, cycle, period, time_zone, period_start, period_end, finalisable_at, status, created_at, refreshed_at, finalised_at,
                               COALESCE((preview->>'cdrCount')::int, (totals->>'cdrCount')::int, 0) AS cdr_count
                          FROM hub_settlement_run WHERE ($1::text IS NULL OR currency = $1) AND ($2::text IS NULL OR status = $2)
                         ORDER BY period_start DESC, currency LIMIT 200`, [typeof qq.currency === 'string' ? qq.currency : null, typeof qq.status === 'string' ? qq.status : null]),
    }));
  });
  app.post('/v1/hub/clearing/runs', async (req, reply) => {
    plat(req);
    return run(reply, async () => {
      const r = parseRunRequest(body(req));
      const out = await buildRun(r.currency, r.period, { cycle: r.cycle, actorId: actor(req) });
      if (out.created) await audit('hub.settlement_run_created', 'hub_settlement_run', out.run.id, { actorId: actor(req), after: { currency: r.currency, period: r.period, cycle: r.cycle } });
      return reply.status(out.created ? 201 : 200).send({ run: out.run, created: out.created });
    });
  });
  app.get('/v1/hub/clearing/runs/:id', async (req, reply) => {
    plat(req);
    const rid = id(req, reply); if (!rid) return;
    return run(reply, async () => {
      const r = await getRun(rid);
      if (!r) throw new HubError(404, 2000, 'run not found');
      return {
        run: r,
        positions: r.status === 'finalised' ? await withNames(await listPositions({ run: rid }), ['member_a_id', 'member_b_id', 'payer_member_id', 'payee_member_id']) : [],
        statements: r.status === 'finalised' ? await withNames(await listStatements({ run: rid }), ['member_id']) : [],
        feeInvoices: r.status === 'finalised' ? await withNames(await listInvoices({ run: rid }), ['member_id']) : [],
      };
    });
  });
  app.post('/v1/hub/clearing/runs/:id/preview', async (req, reply) => {
    plat(req);
    const rid = id(req, reply); if (!rid) return;
    return run(reply, async () => ({ run: await refreshRun(rid, actor(req)) }));
  });
  app.post('/v1/hub/clearing/runs/:id/finalise', async (req, reply) => {
    plat(req);
    const rid = id(req, reply); if (!rid) return;
    return run(reply, async () => {
      const r = await finaliseRun(rid, { actorId: actor(req), force: body(req).force === true, reason: noteOf({ note: body(req).reason }, false) || null });
      return { run: r.run, alreadyFinalised: r.already };
    });
  });
  app.post('/v1/hub/clearing/runs/:id/void', async (req, reply) => {
    plat(req);
    const rid = id(req, reply); if (!rid) return;
    return run(reply, async () => ({ run: await voidRun(rid, actor(req), noteOf({ note: body(req).reason }, false) || null) }));
  });

  // ── positions, payments
  app.get('/v1/hub/clearing/positions', async (req, reply) => {
    plat(req);
    return run(reply, async () => ({ positions: await withNames(await listPositions(q(req)), ['member_a_id', 'member_b_id', 'payer_member_id', 'payee_member_id']) }));
  });
  app.post('/v1/hub/clearing/positions/:id/write-off', async (req, reply) => {
    plat(req);
    const pid = id(req, reply); if (!pid) return;
    return run(reply, async () => ({ position: await writeOffPosition(pid, actor(req), noteOf(body(req))) }));
  });
  app.get('/v1/hub/clearing/payments', async (req, reply) => {
    plat(req);
    return run(reply, async () => ({ payments: await withNames(await listPayments(q(req)), ['payer_member_id', 'payee_member_id']) }));
  });
  app.post('/v1/hub/clearing/payments', async (req, reply) => {
    plat(req);
    const b = body(req);
    if (!UUID_RE.test(String(b.position_id ?? ''))) return bad(reply, 400, 'position_id is required');
    return run(reply, async () => reply.status(201).send(await recordPayment(String(b.position_id), { side: 'platform', userId: actor(req), ip: req.ip }, b)));
  });
  app.post('/v1/hub/clearing/payments/:id/confirm', async (req, reply) => {
    plat(req);
    const pid = id(req, reply); if (!pid) return;
    return run(reply, async () => confirmPayment(pid, { side: 'platform', userId: actor(req), ip: req.ip }));
  });

  // ── statements and fee invoices
  app.get('/v1/hub/clearing/statements', async (req, reply) => {
    plat(req);
    return run(reply, async () => ({ statements: await withNames(await listStatements(q(req)), ['member_id']) }));
  });
  app.get('/v1/hub/clearing/statements/:id', async (req, reply) => {
    plat(req);
    const sid = id(req, reply); if (!sid) return;
    return run(reply, async () => {
      const s = await getStatement(sid);
      if (!s) throw new HubError(404, 2000, 'statement not found');
      return { statement: s };
    });
  });
  for (const fmt of ['html', 'pdf', 'csv'] as const) {
    app.get(`/v1/hub/clearing/statements/:id/${fmt}`, async (req, reply) => {
      plat(req);
      const sid = id(req, reply); if (!sid) return;
      return run(reply, async () => {
        const s = await getStatement(sid);
        if (!s) throw new HubError(404, 2000, 'statement not found');
        return sendStatement(reply, s, fmt);
      });
    });
  }
  app.get('/v1/hub/clearing/fee-invoices', async (req, reply) => {
    plat(req);
    return run(reply, async () => ({ feeInvoices: await withNames(await listInvoices(q(req)), ['member_id']) }));
  });
  app.get('/v1/hub/clearing/fee-invoices/:id', async (req, reply) => {
    plat(req);
    const iid = id(req, reply); if (!iid) return;
    return run(reply, async () => {
      const i = await getInvoice(iid);
      if (!i) throw new HubError(404, 2000, 'fee invoice not found');
      return { feeInvoice: i };
    });
  });
  for (const fmt of ['html', 'pdf'] as const) {
    app.get(`/v1/hub/clearing/fee-invoices/:id/${fmt}`, async (req, reply) => {
      plat(req);
      const iid = id(req, reply); if (!iid) return;
      return run(reply, async () => {
        const i = await getInvoice(iid);
        if (!i) throw new HubError(404, 2000, 'fee invoice not found');
        return sendInvoice(reply, i, fmt);
      });
    });
  }
  app.post('/v1/hub/clearing/fee-invoices/:id/paid', async (req, reply) => {
    plat(req);
    const iid = id(req, reply); if (!iid) return;
    const b = body(req);
    const paidAt = String(b.paid_at ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) return bad(reply, 400, 'paid_at: YYYY-MM-DD');
    return run(reply, async () => {
      const i = await one(`UPDATE hub_fee_invoice SET status = 'paid', paid_at = $2, paid_reference = $3 WHERE id = $1 AND status = 'issued' RETURNING id, org_id, number`,
        [iid, paidAt, typeof b.reference === 'string' ? b.reference.slice(0, 200) : null]);
      if (!i) throw new HubError(409, 2000, 'only an issued fee invoice can be marked paid');
      await audit('hub.fee_invoice_paid', 'hub_fee_invoice', iid, { actorId: actor(req), orgIds: [i.org_id], after: { number: i.number, paid_at: paidAt } });
      return { feeInvoice: await getInvoice(iid) };
    });
  });
}

export function sendStatement(reply: FastifyReply, s: any, fmt: 'html' | 'pdf' | 'csv') {
  const name = `hub-statement-${s.number}`;
  if (fmt === 'html') return reply.type('text/html; charset=utf-8').send(statementHtml(s));
  if (fmt === 'csv') return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}.csv"`).send(statementCsv(s));
  return reply.type('application/pdf').header('content-disposition', `attachment; filename="${name}.pdf"`).send(statementPdf(s));
}

export function sendInvoice(reply: FastifyReply, i: any, fmt: 'html' | 'pdf') {
  if (fmt === 'html') return reply.type('text/html; charset=utf-8').send(feeInvoiceHtml(i));
  return reply.type('application/pdf').header('content-disposition', `attachment; filename="hub-fee-invoice-${i.number}.pdf"`).send(feeInvoicePdf(i));
}
