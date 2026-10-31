import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { writeAudit } from '../services/audit.js';
import * as portal from '../services/owner-portal.js';

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
      throw e;
    }
  };
  const uid = (req: FastifyRequest) => (/^[0-9a-f-]{36}$/i.test(String(req.principal.userId ?? '')) ? req.principal.userId! : null);
  const audit = (req: FastifyRequest, action: string, targetId: string, after: Record<string, unknown>) => writeAudit({
    orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action, targetType: 'owner_bank_change_request', targetId, ip: req.ip, after,
  });

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
}
