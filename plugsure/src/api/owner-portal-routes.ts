import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { writeAudit } from '../services/audit.js';
import * as portal from '../services/owner-portal.js';
import * as disputes from '../services/owner-disputes.js';
import * as docs from '../services/owner-docs.js';
import * as ownerFinance from '../services/owner-finance.js';

/**
 * The Site Owner portal's money (v1.19.0), /v1/owner-portal: a Site Owner user (role site_owner, scope 'owner') sees
 * the payouts recorded against its own statements and its bank details on file, and asks for a change the operator
 * approves (services/owner-portal.ts). Every route resolves the owner from the principal's owner grant; operator
 * users have none and get 404.
 */
export async function registerOwnerPortalRoutes(app: FastifyInstance): Promise<void> {
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try { return await fn(); } catch (e) {
      if (e instanceof portal.OwnerPortalError) return reply.status(e.statusCode).send({ error: e.message });
      if (e instanceof disputes.DisputeError) return reply.status(e.statusCode).send({ error: e.message });
      if (e instanceof docs.OwnerDocsError) return reply.status(e.statusCode).send({ error: e.message });
      if (e instanceof ownerFinance.OwnerFinanceError) return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
  };
  const uid = (req: FastifyRequest) => (/^[0-9a-f-]{36}$/i.test(String(req.principal.userId ?? '')) ? req.principal.userId! : null);
  const audit = (req: FastifyRequest, action: string, targetId: string, after: Record<string, unknown>, targetType = 'owner_bank_change_request') => writeAudit({
    orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action, targetType, targetId, ip: req.ip, after,
  });

  // (v1.38.0) The owner's finance: the sites' results, statements, payouts and what is owed; the year's pack.
  app.get('/v1/owner-portal/finance', async (req, reply) => run(reply, async () => {
    const q = (req.query ?? {}) as Record<string, unknown>, ownerId = portal.portalOwner(req.principal);
    if (q.format === 'xlsx') {
      const buf = await ownerFinance.summaryXlsx(req.principal.orgId, ownerId, q);
      return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', 'attachment; filename="plugsure-owner-finance.xlsx"').send(buf);
    }
    return ownerFinance.summary(req.principal.orgId, ownerId, q);
  }));
  app.get('/v1/owner-portal/finance/pack', async (req, reply) => run(reply, async () => {
    const q = (req.query ?? {}) as Record<string, unknown>, ownerId = portal.portalOwner(req.principal);
    const r = await ownerFinance.pack(req.principal.orgId, ownerId, q.year);
    await audit(req, 'owner.finance_pack_exported', ownerId, { year: q.year ?? null, manifestSha256: r.manifestSha256 }, 'site_owner');
    return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="${r.name}"`).header('x-manifest-sha256', r.manifestSha256).send(r.buffer);
  }));
  app.get('/v1/owner-portal/payouts', async (req, reply) => run(reply, () => portal.payouts(req.principal.orgId, portal.portalOwner(req.principal))));
  app.get('/v1/owner-portal/bank', async (req, reply) => run(reply, () => portal.bank(req.principal.orgId, portal.portalOwner(req.principal))));
  app.post('/v1/owner-portal/bank/change-request', async (req, reply) => run(reply, async () => {
    const ownerId = portal.portalOwner(req.principal);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = await portal.requestChange(req.principal.orgId, ownerId, b, uid(req));
    const digits = String(b.accountNumber ?? '').replace(/\D/g, '');
    await audit(req, 'owner.bank_change_requested', r.id, { ownerId, bank: b.bankName, holder: b.holderName, account: `••••${digits.slice(-4)}` });
    return reply.status(201).send(r);
  }));
  app.post('/v1/owner-portal/bank/change-request/:rid/withdraw', async (req, reply) => run(reply, async () => {
    const rid = String((req.params as Record<string, string>).rid ?? '');
    const r = await portal.withdraw(req.principal.orgId, portal.portalOwner(req.principal), rid);
    await audit(req, 'owner.bank_change_withdrawn', rid, {});
    return r;
  }));

  // (v1.23.0) Queries on a finalised statement (services/owner-disputes.ts).
  app.get('/v1/owner-portal/queries', async (req, reply) => run(reply, () => disputes.forOwner(req.principal.orgId, portal.portalOwner(req.principal))));
  app.post('/v1/owner-portal/queries', async (req, reply) => run(reply, async () => {
    const ownerId = portal.portalOwner(req.principal);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = await disputes.raise(req.principal.orgId, ownerId, b, uid(req));
    await audit(req, 'owner.statement_queried', r.id, { ownerId, statementId: b.statementId, line: b.line ?? null, claimed: b.claimed ?? null }, 'owner_statement_dispute');
    return reply.status(201).send(r);
  }));
  app.post('/v1/owner-portal/queries/:qid/withdraw', async (req, reply) => run(reply, async () => {
    const qid = String((req.params as Record<string, string>).qid ?? '');
    const r = await disputes.withdraw(req.principal.orgId, portal.portalOwner(req.principal), qid);
    await audit(req, 'owner.statement_query_withdrawn', qid, {}, 'owner_statement_dispute');
    return r;
  }));

  // (v1.27.0) Payout advices, tax withheld, yearly statements and scheduled payouts (services/owner-docs.ts).
  app.get('/v1/owner-portal/documents', async (req, reply) => run(reply, () => docs.documents(req.principal.orgId, portal.portalOwner(req.principal))));
  app.get('/v1/owner-portal/documents/advice/:pid', async (req, reply) => run(reply, async () => {
    const r = await docs.payoutAdvicePdf(req.principal.orgId, portal.portalOwner(req.principal), String((req.params as Record<string, string>).pid ?? ''));
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${r.filename}"`).send(r.body);
  }));
  app.get('/v1/owner-portal/documents/year/:year', async (req, reply) => run(reply, async () => {
    const r = await docs.yearlyPdf(req.principal.orgId, portal.portalOwner(req.principal), (req.params as Record<string, string>).year);
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${r.filename}"`).send(r.body);
  }));
}
