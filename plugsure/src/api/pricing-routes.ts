import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { limitParam } from './paging.js';
import { assertCan } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import * as bn from '../services/benefits.js';
import * as loyalty from '../services/loyalty.js';

/**
 * Commercial → Promotions & plans: membership plans, members (fleet accounts
 * and cards; app drivers subscribe in the app), promotions and loyalty points. Pricing
 * permissions: tariff:read to view, tariff:write to change.
 */
export async function registerPricingRoutes(app: FastifyInstance): Promise<void> {
  const org = (req: FastifyRequest) => req.principal.orgId;
  const audit = (req: FastifyRequest, action: string, targetType: string, targetId: string, after?: unknown) =>
    writeAudit({ orgId: org(req), actorType: 'user', actorId: req.principal.userId, action, targetType, targetId, after: (after ?? null) as any, ip: req.ip });
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof bn.BenefitsError) return reply.status(e.status).send({ error: e.message });
      throw e;
    }
  };

  // ---------------------------------------------------------------- plans

  app.get('/v1/subscription-plans', async (req) => {
    assertCan(req.principal, { permission: 'tariff:read' });
    return { plans: await bn.listPlans(org(req)) };
  });

  app.post('/v1/subscription-plans', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    return run(reply, async () => {
      const p = await bn.createPlan(org(req), req.body ?? {}) as any;
      await audit(req, 'subscription_plan.created', 'subscription_plan', p.id, p);
      return reply.status(201).send(p);
    });
  });

  app.put('/v1/subscription-plans/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      const p = await bn.updatePlan(org(req), id, req.body ?? {});
      await audit(req, 'subscription_plan.updated', 'subscription_plan', id, req.body);
      return p;
    });
  });

  // ---------------------------------------------------------------- members

  app.get('/v1/subscriptions', async (req) => {
    assertCan(req.principal, { permission: 'tariff:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    return { subscriptions: await bn.listSubscriptions(org(req), { planId: q.planId, status: q.status }) };
  });

  app.post('/v1/subscriptions', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    return run(reply, async () => {
      const s = await bn.createSubscription(org(req), req.body ?? {}, req.principal.userId) as any;
      await audit(req, 'subscription.created', 'subscription', s.id, { plan: s.plan_name, kind: s.subscriber_kind, billing: s.billing });
      return reply.status(201).send(s);
    });
  });

  app.post('/v1/subscriptions/:id/cancel', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      const s = await bn.cancelSubscription(org(req), id);
      await audit(req, 'subscription.cancelled', 'subscription', id);
      return s;
    });
  });

  // ---------------------------------------------------------------- loyalty points

  const runL = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof loyalty.LoyaltyError) return reply.status(e.status).send({ error: e.message });
      throw e;
    }
  };

  app.get('/v1/loyalty', async (req) => {
    assertCan(req.principal, { permission: 'tariff:read' });
    return loyalty.programStats(org(req));
  });

  app.put('/v1/loyalty', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    return runL(reply, async () => {
      const p = await loyalty.saveProgram(org(req), req.body ?? {}, req.principal.userId);
      await audit(req, 'loyalty.program_saved', 'organisation', org(req), p);
      return loyalty.programStats(org(req));
    });
  });

  app.get('/v1/loyalty/members', async (req) => {
    assertCan(req.principal, { permission: 'tariff:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    return { members: await loyalty.topMembers(org(req), limitParam(q.limit, 25, 500)) };
  });

  app.post('/v1/loyalty/adjust', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    const b = (req.body ?? {}) as { appDriverId?: string; points?: unknown; note?: unknown };
    return runL(reply, async () => {
      const r = await loyalty.adjustPoints(org(req), String(b.appDriverId ?? ''), b.points, b.note, req.principal.userId);
      await audit(req, 'loyalty.points_adjusted', 'app_driver', String(b.appDriverId), { points: b.points, note: b.note, balance: r.balance });
      return r;
    });
  });

  // ---------------------------------------------------------------- promotions

  app.get('/v1/promotions', async (req) => {
    assertCan(req.principal, { permission: 'tariff:read' });
    return { promotions: await bn.listPromotions(org(req)) };
  });

  app.post('/v1/promotions', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    return run(reply, async () => {
      const p = await bn.createPromotion(org(req), req.body ?? {}) as any;
      await audit(req, 'promotion.created', 'promotion', p.id, p);
      return reply.status(201).send(p);
    });
  });

  app.get('/v1/promotions/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:read' });
    const { id } = req.params as { id: string };
    return run(reply, () => bn.getPromotion(org(req), id));
  });

  app.put('/v1/promotions/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      const p = await bn.updatePromotion(org(req), id, req.body ?? {});
      await audit(req, 'promotion.updated', 'promotion', id, req.body);
      return p;
    });
  });
}
