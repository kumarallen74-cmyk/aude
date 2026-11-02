import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertCan } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import * as dealers from '../services/dealers.js';

/**
 * Phase 38 (v1.50.0): EV dealer partnerships. Behind a console session or an API key, except the dealer's portal
 * (its own secret link): GET /v1/dealer-portal/:token, POST /v1/dealer-portal/:token/sales and the page /dealer/:token.
 */

export function isPublicPhase38Route(route: string, method: string): boolean {
  return (method === 'GET' && route === '/v1/dealer-portal/:token') || (method === 'POST' && route === '/v1/dealer-portal/:token/sales');
}

export async function registerPhase38Routes(app: FastifyInstance): Promise<void> {
  const failed = (reply: FastifyReply, e: unknown) => {
    const s = (e as { statusCode?: number })?.statusCode;
    if ((s && s < 500) || e instanceof dealers.DealerError) return reply.status(s ?? 422).send({ error: (e as Error).message });
    throw e;
  };
  const audit = (req: FastifyRequest, action: string, targetType: string, targetId: string, after: Record<string, unknown>) => writeAudit({
    orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action, targetType, targetId, ip: req.ip, after,
  });
  const P = (req: FastifyRequest) => req.params as Record<string, string>;
  const Q = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string>;
  const B = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const org = (req: FastifyRequest) => req.principal.orgId;
  const R = (req: FastifyRequest) => assertCan(req.principal, { permission: 'invoice:read' });
  const W = (req: FastifyRequest) => assertCan(req.principal, { permission: 'invoice:write' });

  app.get('/v1/dealers', async (req) => { R(req); return { dealers: await dealers.dealers(org(req), Q(req).archived === 'true') }; });
  app.post('/v1/dealers', async (req, reply) => {
    W(req);
    try { const d = await dealers.saveDealer(org(req), null, B(req)) as any; await audit(req, 'dealer.saved', 'dealer', d.id, { name: d.name }); return reply.status(201).send(d); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/dealers/:id', async (req, reply) => {
    W(req);
    try { const d = await dealers.saveDealer(org(req), P(req).id!, { ...B(req), rotatePortal: false }); await audit(req, 'dealer.saved', 'dealer', P(req).id!, { archive: B(req).archive === true }); return d; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/dealers/:id/portal', async (req, reply) => {
    W(req);
    try { const r = await dealers.saveDealer(org(req), P(req).id!, { rotatePortal: true }) as any; await audit(req, 'dealer.portal_link', 'dealer', P(req).id!, { prefix: String(r.token).slice(0, 8) }); return r; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/dealer-sales', async (req) => { R(req); return { sales: await dealers.sales(org(req), Q(req)) }; });
  app.post('/v1/dealers/:id/sales', async (req, reply) => {
    W(req);
    try { const s = await dealers.registerSale(org(req), P(req).id!, B(req), 'console'); await audit(req, 'dealer.sale_registered', 'dealer_sale', s.id, { number: s.number, vin: s.vin }); return reply.status(201).send(s); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/dealer-sales/:id/void', async (req, reply) => {
    W(req);
    try { const r = await dealers.voidSale(org(req), P(req).id!); await audit(req, 'dealer.sale_voided', 'dealer_sale', r.id, {}); return r; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/dealers/:id/preview', async (req, reply) => {
    R(req);
    try { return await dealers.compute(org(req), P(req).id!, Q(req).month ?? new Date().toISOString().slice(0, 7)); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/dealer-statements', async (req) => { R(req); return { statements: await dealers.statements(org(req), Q(req)) }; });
  app.post('/v1/dealers/:id/statements', async (req, reply) => {
    W(req);
    try { return await dealers.draft(org(req), P(req).id!, String(B(req).month ?? '')); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/dealer-statements/:id', async (req, reply) => {
    W(req);
    try { const s = await dealers.act(org(req), P(req).id!, B(req)); await audit(req, `dealer.statement_${String(B(req).action)}`, 'dealer_statement', s.id, { month: s.month, netMinor: s.netMinor, reference: s.reference }); return s; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/dealer-statements/:id/statement.xlsx', async (req, reply) => {
    R(req);
    try {
      const x = await dealers.statementXlsx(org(req), P(req).id!);
      return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="${x.name}"`).send(x.data);
    } catch (e) { return failed(reply, e); }
  });

  // The dealer's portal (its own secret link).
  app.get('/v1/dealer-portal/:token', async (req, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    try { return await dealers.portal(P(req).token!); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/dealer-portal/:token/sales', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    try { return reply.status(201).send(await dealers.portalSale(P(req).token!, B(req))); } catch (e) { return failed(reply, e); }
  });
  app.get('/dealer/:token', async (_req, reply) => reply.header('cache-control', 'no-cache').header('referrer-policy', 'no-referrer').sendFile('dealer.html'));
}
