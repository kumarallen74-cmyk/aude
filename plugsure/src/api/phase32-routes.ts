import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertCan, can } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import * as depot from '../services/depot.js';
import * as carbon from '../services/carbon.js';
import * as bot from '../services/diagnostics-bot.js';
import { queueAnalytics } from '../driver/queue.js';

/**
 * Phase 32 (v1.44.0): fleet depot scheduling, queue analytics, carbon per session and site (the ESG report), the
 * diagnostics bot. All behind a console session or an API key.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statusOf = (e: unknown): number | null =>
  e instanceof depot.DepotError || e instanceof carbon.CarbonError || e instanceof bot.DiagError ? (e as { statusCode: number }).statusCode
    : (e as { statusCode?: number })?.statusCode && (e as { statusCode: number }).statusCode < 500 ? (e as { statusCode: number }).statusCode : null;

export async function registerPhase32Routes(app: FastifyInstance): Promise<void> {
  const failed = (reply: FastifyReply, e: unknown) => {
    const s = statusOf(e);
    if (s) return reply.status(s).send({ error: (e as Error).message });
    throw e;
  };
  const userUuid = (req: FastifyRequest) => (/^[0-9a-f-]{36}$/i.test(String(req.principal.userId ?? '')) ? req.principal.userId! : null);
  const audit = (req: FastifyRequest, action: string, targetType: string, targetId: string | null, after: Record<string, unknown>) => writeAudit({
    orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action, targetType, targetId: targetId ?? req.principal.orgId, ip: req.ip, after,
  });
  const P = (req: FastifyRequest) => req.params as Record<string, string>;
  const Q = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string>;
  const B = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

  // ---------------------------------------------------------------- depot scheduling

  app.get('/v1/depot', async (req) => { assertCan(req.principal, { permission: 'smartcharging:read' }); return depot.overview(req.principal.orgId); });
  app.put('/v1/depot/sites/:siteId', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { const r = await depot.setSite(req.principal.orgId, P(req).siteId!, B(req).enabled); await audit(req, 'depot.site_saved', 'site', P(req).siteId!, r); return r; } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/depot/sessions/:sessionId/departure', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { const r = await depot.setDeparture(req.principal.orgId, P(req).sessionId!, B(req)); await audit(req, 'depot.departure_set', 'charging_session', P(req).sessionId!, r); return r; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/fleet-vehicles', async (req) => { assertCan(req.principal, { permission: 'smartcharging:read' }); return { vehicles: await depot.vehicles(req.principal.orgId) }; });
  app.post('/v1/fleet-vehicles', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { const v = await depot.saveVehicle(req.principal.orgId, null, B(req)); await audit(req, 'fleet_vehicle.saved', 'fleet_vehicle', (v as any).id, v as any); return reply.status(201).send(v); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/fleet-vehicles/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { const v = await depot.saveVehicle(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'fleet_vehicle.saved', 'fleet_vehicle', P(req).id!, v as any); return v; } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- queue analytics

  app.get('/v1/sites/:siteId/queue/analytics', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:read' });
    if (!UUID_RE.test(P(req).siteId ?? '')) return reply.status(404).send({ error: 'No such site.' });
    return queueAnalytics(req.principal.orgId, P(req).siteId!, Number(Q(req).days) || 30);
  });
  app.get('/v1/queue/analytics', async (req) => {
    assertCan(req.principal, { permission: 'site:read' });
    return queueAnalytics(req.principal.orgId, null, Number(Q(req).days) || 30);
  });

  // ---------------------------------------------------------------- carbon per session and site

  app.get('/v1/finance/carbon/sites', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await carbon.siteReport(req.principal.orgId, Q(req).from, Q(req).to); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/finance/carbon/esg', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try {
      const file = await carbon.esgWorkbook(req.principal.orgId, Q(req).from, Q(req).to);
      return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', `attachment; filename="plugsure-esg-${String(Q(req).from ?? '').replace(/[^0-9-]/g, '')}-${String(Q(req).to ?? '').replace(/[^0-9-]/g, '')}.xlsx"`).send(file);
    } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/sessions/:id/carbon', async (req, reply) => {
    if (!can(req.principal, { permission: 'session:read' })) assertCan(req.principal, { permission: 'payment:read' });
    try { return (await carbon.sessionCarbon(req.principal.orgId, P(req).id!)) ?? { sessionId: P(req).id, kwh: 0 }; } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- the diagnostics bot

  app.get('/v1/diagnostics-bot/charge-points/:cpId', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    try { return await bot.list(req.principal.orgId, P(req).cpId!); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/diagnostics-bot/charge-points/:cpId', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:command' });
    try {
      const b = B(req);
      const r = await bot.start(req.principal.orgId, P(req).cpId!, { userId: userUuid(req), ip: req.ip, allowReset: b.allowReset === true, openWorkOrder: b.openWorkOrder === true });
      await audit(req, 'diagnostics_bot.started', 'charge_point', P(req).cpId!, { runId: r.id, allowReset: b.allowReset === true, openWorkOrder: b.openWorkOrder === true });
      return reply.status(202).send(r);
    } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/diagnostics-bot/runs/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    try { return await bot.get(req.principal.orgId, P(req).id!); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/diagnostics-bot/runs/:id/work-order', async (req, reply) => {
    if (!can(req.principal, { permission: 'charge_point:write' })) assertCan(req.principal, { permission: 'payment:write' });
    try { const w = await bot.openWorkOrder(req.principal.orgId, P(req).id!, userUuid(req)); await audit(req, 'diagnostics_bot.work_order', 'work_order', w.id, { runId: P(req).id }); return reply.status(201).send(w); } catch (e) { return failed(reply, e); }
  });
}
