import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { limitParam } from './paging.js';
import { assertCan, can } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import { TokenBuckets } from '../services/ratelimit.js';
import * as fin from '../services/finance.js';
import { render, type ExportFormat } from '../services/finance-export.js';

/**
 * Commercial → Finance (v1.12.0): the payment gateway's side of the money, per gateway account.
 *
 *   GET  /v1/finance/accounts                               the gateway accounts the caller may see
 *   GET  /v1/finance/accounts/:id/overview                  collected, fees, refunds, net, receivable, balance, payable
 *   GET  /v1/finance/accounts/:id/transactions              the gateway ledger, filtered, paged
 *   GET  /v1/finance/accounts/:id/receivables               collected, not yet settled; fleet invoices due
 *   GET  /v1/finance/accounts/:id/payables                  refunds due, owners' shares on finalised statements
 *   GET  /v1/finance/accounts/:id/fees                      fees by month and channel; QRIS actual vs estimated
 *   GET  /v1/finance/accounts/:id/exceptions                reconciliation differences
 *   POST /v1/finance/accounts/:id/exceptions/:eid/apply     apply a payment the gateway has and PlugSure missed
 *   POST /v1/finance/accounts/:id/exceptions/:eid/resolve   close one with a note
 *   POST /v1/finance/accounts/:id/sync                      sync, take the balance and reconcile now
 *   GET  /v1/finance/accounts/:id/export                    the period as CSV, Excel or PDF
 *
 * Reading is payment:read, changing is payment:write. An operator sees its own account(s); the platform's account
 * (org NULL) needs platform:admin as well. Every action is audited.
 */

const KINDS = ['payment', 'refund', 'payout', 'transfer', 'fee', 'other'];
const STATUSES = ['success', 'pending', 'failed', 'voided', 'reversed'];
const SETTLEMENTS = ['pending', 'settled', 'early_settled', 'none'];
const syncBuckets = new TokenBuckets();

export async function registerFinanceRoutes(app: FastifyInstance): Promise<void> {
  const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });
  const platform = (req: FastifyRequest) => can(req.principal, { permission: 'platform:admin' });
  const account = (req: FastifyRequest) => {
    const id = String((req.params as Record<string, string>).id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw Object.assign(new Error('No such payments account.'), { statusCode: 404 });
    return fin.accountFor(req.principal.orgId, platform(req), id);
  };
  const period = (req: FastifyRequest) => {
    const q = (req.query ?? {}) as Record<string, string>;
    return fin.periodOf(q.from, q.to);
  };
  const failed = (reply: FastifyReply, e: unknown) => {
    if (e instanceof fin.FinanceError) return reply.status(e.statusCode).send({ error: e.message });
    throw e;
  };
  const audit = (req: FastifyRequest, action: string, targetId: string, after: Record<string, unknown>) => writeAudit({
    orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action, targetType: 'payments_account', targetId, ip: req.ip, after,
  });

  app.get('/v1/finance/accounts', async (req) => {
    assertCan(req.principal, { permission: 'payment:read' });
    return { accounts: await fin.accountsFor(req.principal.orgId, platform(req)) };
  });

  app.get('/v1/finance/accounts/:id/overview', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { const a = await account(req); return { account: a, ...(await fin.overview(a.id, period(req))) }; } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/transactions', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    for (const [k, allowed] of [['kind', KINDS], ['status', STATUSES], ['settlement', SETTLEMENTS]] as const) {
      if (q[k] && !allowed.includes(q[k]!)) throw bad(`${k} must be one of ${allowed.join(', ')}`);
    }
    if (q.matched && !['true', 'false'].includes(q.matched)) throw bad('matched must be true or false');
    if (q.before && !/^\d{1,18}$/.test(q.before)) throw bad('before is the id of the last row of the previous page');
    const limit = limitParam(q.limit, 100, 500);
    try {
      const a = await account(req);
      const rows = await fin.transactions(a.id, period(req), {
        kind: q.kind || null, status: q.status || null, settlement: q.settlement || null, channel: q.channel ? String(q.channel).slice(0, 60) : null,
        matched: q.matched ? q.matched === 'true' : null, q: q.q ? String(q.q).slice(0, 100) : null, beforeId: q.before || null, limit,
      });
      return { transactions: rows, nextBefore: rows.length === limit ? rows[rows.length - 1]!.id : null };
    } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/receivables', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { const a = await account(req); return await fin.receivables(a.id, a.orgId); } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/payables', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { const a = await account(req); return await fin.payables(a.id); } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/fees', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { const a = await account(req); return await fin.fees(a.id, period(req)); } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/exceptions', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    if (q.state && !['open', 'resolved'].includes(q.state)) throw bad('state must be open or resolved');
    try {
      const a = await account(req);
      return { exceptions: await fin.exceptions(a.id, (q.state as 'open' | 'resolved' | undefined) ?? null, limitParam(q.limit, 100, 500)) };
    } catch (e) { return failed(reply, e); }
  });

  const exceptionId = (req: FastifyRequest) => {
    const id = String((req.params as Record<string, string>).eid ?? '');
    if (!/^\d{1,18}$/.test(id)) throw Object.assign(new Error('No such exception.'), { statusCode: 404 });
    return id;
  };

  app.post('/v1/finance/accounts/:id/exceptions/:eid/apply', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const a = await account(req);
      const eid = exceptionId(req);
      const r = await fin.applyMissing(eid, a.id, req.principal.userId ?? null);
      await audit(req, 'finance.exception_applied', a.id, { exception: eid, outcome: r.outcome });
      return { ok: true, outcome: r.outcome };
    } catch (e) { return failed(reply, e); }
  });

  app.post('/v1/finance/accounts/:id/exceptions/:eid/resolve', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const a = await account(req);
      const eid = exceptionId(req);
      const note = String(((req.body ?? {}) as Record<string, unknown>).note ?? '');
      await fin.resolveException(eid, a.id, note, req.principal.userId ?? null);
      await audit(req, 'finance.exception_resolved', a.id, { exception: eid, note: note.trim().slice(0, 200) });
      return { ok: true };
    } catch (e) { return failed(reply, e); }
  });

  app.post('/v1/finance/accounts/:id/sync', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    const d = syncBuckets.take(`${req.principal.userId ?? req.ip}`, 4);
    if (!d.allowed) return reply.status(429).header('Retry-After', d.retryAfterS).send({ error: 'At most 4 syncs a minute.' });
    try {
      const a = await account(req);
      const s = await fin.syncTransactions(a.id);
      const balance = await fin.snapshotBalance(a.id);
      const r = await fin.reconcile(a.id);
      await audit(req, 'finance.synced', a.id, { rows: s.rows, ok: s.ok, open: r.open });
      return { sync: s, balance, reconciliation: r };
    } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/export', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    const format = (q.format ?? 'xlsx') as ExportFormat;
    if (!['csv', 'xlsx', 'pdf'].includes(format)) throw bad('format must be csv, xlsx or pdf');
    try {
      const a = await account(req);
      const p = period(req);
      const out = render(a, await fin.monthClose(a.id, p), format);
      await audit(req, 'finance.exported', a.id, { format, from: p.from.toISOString(), to: p.to.toISOString() });
      const name = `plugsure-finance-${(q.from ?? p.from.toISOString().slice(0, 10))}-${(q.to ?? '').slice(0, 10) || 'to-date'}.${out.ext}`;
      return reply.header('content-type', out.type).header('content-disposition', `attachment; filename="${name}"`).header('cache-control', 'no-store').send(out.body);
    } catch (e) { return failed(reply, e); }
  });
}
