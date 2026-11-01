import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertCan, can } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import * as desk from '../services/support-desk.js';
import * as forecast from '../services/demand-forecast.js';
import * as credit from '../services/driver-credit.js';
import * as tlm from '../services/telematics.js';

/**
 * Phase 33 (v1.45.0): the support case desk, demand forecasting and site planning, driver credit (gift cards, vouchers,
 * referrals) and vehicle telematics. Behind a console session or an API key, except the two webhooks (their own keys).
 */

const SUPPORT_INBOUND = '/v1/support/inbound-email/:key';
const TELEMATICS_INGEST = '/v1/telematics/ingest/:key';

/** The e-mail provider's inbound webhook and the telematics platform's: each authenticated by its own key. */
export function isPublicPhase33Route(route: string, method: string): boolean {
  return method === 'POST' && (route === SUPPORT_INBOUND || route === TELEMATICS_INGEST);
}

const statusOf = (e: unknown): number | null =>
  e instanceof desk.SupportError || e instanceof forecast.ForecastError || e instanceof credit.CreditError || e instanceof tlm.TelematicsError ? (e as { statusCode: number }).statusCode
    : (e as { statusCode?: number })?.statusCode && (e as { statusCode: number }).statusCode < 500 ? (e as { statusCode: number }).statusCode : null;

export async function registerPhase33Routes(app: FastifyInstance): Promise<void> {
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

  // ---------------------------------------------------------------- the support desk

  app.get('/v1/support/cases', async (req) => { assertCan(req.principal, { permission: 'session:read' }); return desk.list(req.principal.orgId, Q(req), userUuid(req)); });
  app.post('/v1/support/cases', async (req, reply) => {
    assertCan(req.principal, { permission: 'session:write' });
    try {
      const b = B(req);
      const c = await desk.create(req.principal.orgId, { subject: String(b.subject ?? ''), body: String(b.body ?? ''), channel: 'console', category: b.category as string, priority: b.priority as string,
        customerName: b.customerName as string, customerEmail: b.customerEmail as string, sessionId: b.sessionId ? String(b.sessionId) : null, chargePointId: b.chargePointId ? String(b.chargePointId) : null, createdBy: userUuid(req) });
      await audit(req, 'support_case.created', 'support_case', c.id, { ref: c.ref });
      return reply.status(201).send(c);
    } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/support/cases/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'session:read' });
    try { return await desk.get(req.principal.orgId, P(req).id!); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/support/cases/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'session:write' });
    try { const c = await desk.update(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'support_case.updated', 'support_case', c.id, B(req)); return c; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/support/cases/:id/messages', async (req, reply) => {
    assertCan(req.principal, { permission: 'session:write' });
    try {
      const c = await desk.reply(req.principal.orgId, P(req).id!, B(req), userUuid(req));
      await audit(req, B(req).internal === true ? 'support_case.note' : 'support_case.replied', 'support_case', c.id, { macroId: B(req).macroId ?? null });
      return reply.status(201).send(c);
    } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/support/macros', async (req) => { assertCan(req.principal, { permission: 'session:read' }); return { macros: await desk.macros(req.principal.orgId) }; });
  app.post('/v1/support/macros', async (req, reply) => {
    assertCan(req.principal, { permission: 'session:write' });
    try { const m = await desk.saveMacro(req.principal.orgId, null, B(req)); await audit(req, 'support_macro.saved', 'support_macro', m.id, { name: (m as any).name }); return reply.status(201).send(m); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/support/macros/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'session:write' });
    try { const m = await desk.saveMacro(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'support_macro.saved', 'support_macro', P(req).id!, B(req)); return m; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/support/settings', async (req) => { assertCan(req.principal, { permission: 'session:read' }); return desk.settings(req.principal.orgId); });
  app.put('/v1/support/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'session:write' });
    try { const s = await desk.saveSettings(req.principal.orgId, B(req), userUuid(req)); await audit(req, 'support.settings_saved', 'organisation', null, { enabled: s.enabled, sla: s.sla }); return s; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/support/settings/inbound-key', async (req) => {
    assertCan(req.principal, { permission: 'session:write' });
    const k = await desk.rotateInboundKey(req.principal.orgId, userUuid(req));
    await audit(req, 'support.inbound_key_rotated', 'organisation', null, { prefix: k.prefix });
    return k;
  });
  app.get('/v1/support/stats', async (req) => { assertCan(req.principal, { permission: 'session:read' }); return desk.stats(req.principal.orgId, Number(Q(req).days) || 30); });
  app.post('/v1/support/inbound-email/:key', async (req, reply) => {
    try { return reply.status(201).send(await desk.inboundEmail(P(req).key!, B(req))); } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- demand forecasting and site planning

  app.get('/v1/demand/sites', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return forecast.overview(req.principal.orgId); });
  app.get('/v1/demand/forecast', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:read' });
    try { return await forecast.siteForecast(req.principal.orgId, Q(req).siteId || null, Q(req).days); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/demand/candidates', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return forecast.candidates(req.principal.orgId); });
  app.post('/v1/demand/candidates', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const c = await forecast.saveCandidate(req.principal.orgId, null, B(req), userUuid(req)); await audit(req, 'site_candidate.saved', 'site_candidate', c.id, B(req)); return reply.status(201).send(c); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/demand/candidates/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const c = await forecast.saveCandidate(req.principal.orgId, P(req).id!, B(req), userUuid(req)); await audit(req, 'site_candidate.saved', 'site_candidate', P(req).id!, B(req)); return c; } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- driver credit

  app.get('/v1/credit', async (req) => { assertCan(req.principal, { permission: 'tariff:read' }); return credit.overview(req.principal.orgId); });
  app.put('/v1/credit/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    try { const s = await credit.saveSettings(req.principal.orgId, B(req), userUuid(req)); await audit(req, 'credit.settings_saved', 'organisation', null, s as any); return s; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/credit/batches', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    try {
      const r = await credit.createBatch(req.principal.orgId, B(req), userUuid(req));
      await audit(req, 'gift_card_batch.created', 'gift_card_batch', r.batch.id, { kind: r.batch.kind, quantity: r.batch.quantity, valueMinor: r.batch.valueMinor, currency: r.batch.currency });
      return reply.status(201).send(r);
    } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/credit/batches/:id/void', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    try { const r = await credit.voidBatch(req.principal.orgId, P(req).id!); await audit(req, 'gift_card_batch.voided', 'gift_card_batch', P(req).id!, r); return r; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/credit/drivers/:driverId/adjust', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    try { const r = await credit.adjust(req.principal.orgId, P(req).driverId!, B(req), userUuid(req)); await audit(req, 'driver_credit.adjusted', 'app_driver', P(req).driverId!, { ...r, note: B(req).note }); return reply.status(201).send(r); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/finance/driver-credit', async (req, reply) => {
    if (!can(req.principal, { permission: 'payment:read' })) assertCan(req.principal, { permission: 'tariff:read' });
    const s = await credit.settings(req.principal.orgId);
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(Q(req).month ?? '') ? Q(req).month! : new Date().toISOString().slice(0, 7);
    try { return await credit.movement(req.principal.orgId, month, Q(req).currency || s.currency); } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- vehicle telematics

  app.get('/v1/telematics/connections', async (req) => {
    assertCan(req.principal, { permission: 'smartcharging:read' });
    return { connections: await tlm.connections(req.principal.orgId), latest: await tlm.latest(req.principal.orgId) };
  });
  app.post('/v1/telematics/connections', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { const c = await tlm.saveConnection(req.principal.orgId, null, B(req)); await audit(req, 'telematics.connection_saved', 'telematics_connection', c.id, { name: (c as any).name, kind: (c as any).kind }); return reply.status(201).send(c); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/telematics/connections/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { const c = await tlm.saveConnection(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'telematics.connection_saved', 'telematics_connection', P(req).id!, { archive: B(req).archive === true, rotateKey: B(req).rotateKey === true }); return c; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/telematics/connections/:id/poll', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { return await tlm.pollNow(req.principal.orgId, P(req).id!); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/fleet-vehicles/:id/telematics', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { const r = await tlm.linkVehicle(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'fleet_vehicle.telematics_linked', 'fleet_vehicle', P(req).id!, r); return r; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/telematics/ingest/:key', async (req, reply) => {
    try { return await tlm.webhook(P(req).key!, req.body ?? null); } catch (e) { return failed(reply, e); }
  });
}
