import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertCan } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import * as hotel from '../services/hotel.js';
import * as inst from '../services/installations.js';
import * as privacy from '../services/privacy.js';
import * as battery from '../services/battery-health.js';

/**
 * Phase 36 (v1.48.0): hotels (with the PMS webhook and the valet page), the installation pipeline, data privacy (the
 * console side; the driver's is in driver/server.ts) and EV battery health. Behind a console session or an API key,
 * except the PMS webhook and the valet page (their own keys).
 */

const PMS_HOOK = '/v1/hotels/pms/:key';
const VALET = '/v1/valet/:token';

export function isPublicPhase36Route(route: string, method: string): boolean {
  return (method === 'POST' && route === PMS_HOOK) || ((method === 'GET' || method === 'POST') && route === VALET);
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function registerPhase36Routes(app: FastifyInstance): Promise<void> {
  const failed = (reply: FastifyReply, e: unknown) => {
    const s = (e as { statusCode?: number })?.statusCode;
    if ((s && s < 500) || e instanceof hotel.HotelError || e instanceof inst.InstallError || e instanceof privacy.PrivacyError || e instanceof battery.BatteryError) {
      return reply.status(s ?? 422).send({ error: (e as Error).message });
    }
    throw e;
  };
  const userUuid = (req: FastifyRequest) => (/^[0-9a-f-]{36}$/i.test(String(req.principal.userId ?? '')) ? req.principal.userId! : null);
  const audit = (req: FastifyRequest, action: string, targetType: string, targetId: string | null, after: Record<string, unknown>) => writeAudit({
    orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action, targetType, targetId: targetId ?? req.principal.orgId, ip: req.ip, after,
  });
  const P = (req: FastifyRequest) => req.params as Record<string, string>;
  const Q = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string>;
  const B = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

  // ---------------------------------------------------------------- hotels

  app.get('/v1/hotels', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return { hotels: await hotel.properties(req.principal.orgId) }; });
  app.post('/v1/hotels', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const h = await hotel.saveProperty(req.principal.orgId, null, B(req)) as any; await audit(req, 'hotel.saved', 'hotel_property', h.id, { name: h.name, posting: h.posting }); return reply.status(201).send(h); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/hotels/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const h = await hotel.saveProperty(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'hotel.saved', 'hotel_property', P(req).id!, { archive: B(req).archive === true, rotatePmsKey: B(req).rotatePmsKey === true }); return h; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/hotels/:id/valet', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const r = await hotel.rotateValet(req.principal.orgId, P(req).id!); await audit(req, 'hotel.valet_link', 'hotel_property', P(req).id!, { prefix: r.token.slice(0, 8) }); return r; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/hotels/:id/stays', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:read' });
    try { return { stays: await hotel.stays(req.principal.orgId, P(req).id!, Q(req)) }; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/hotels/:id/stays', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const s = await hotel.checkIn(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'hotel.check_in', 'hotel_stay', s.id, { room: s.room }); return reply.status(201).send(s); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/hotel-stays/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const s = await hotel.updateStay(req.principal.orgId, P(req).id!, B(req)); await audit(req, B(req).action === 'check_out' ? 'hotel.check_out' : 'hotel.stay_changed', 'hotel_stay', s.id, { room: s.room }); return s; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/hotels/:id/charges', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:read' });
    try { return { charges: await hotel.charges(req.principal.orgId, P(req).id!, Q(req)) }; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/hotel-charges/:id/retry', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { return await hotel.retryCharge(req.principal.orgId, P(req).id!); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/hotels/:id/statement', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:read' });
    try { return await hotel.statement(req.principal.orgId, P(req).id!, Q(req).month); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/hotels/:id/statement.xlsx', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:read' });
    const m = MONTH_RE.test(Q(req).month ?? '') ? Q(req).month! : new Date().toISOString().slice(0, 7);
    try {
      return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="hotel-statement-${m}.xlsx"`)
        .send(await hotel.statementXlsx(req.principal.orgId, P(req).id!, m));
    } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/hotels/pms/:key', async (req, reply) => { try { return await hotel.pmsEvent(P(req).key!, B(req)); } catch (e) { return failed(reply, e); } });
  app.get('/v1/valet/:token', async (req, reply) => { try { return await hotel.valetView(P(req).token!); } catch (e) { return failed(reply, e); } });
  app.post('/v1/valet/:token', async (req, reply) => { try { return await hotel.valetAction(P(req).token!, B(req)); } catch (e) { return failed(reply, e); } });
  app.get('/valet/:token', async (_req, reply) => reply.header('cache-control', 'no-cache').header('referrer-policy', 'no-referrer').sendFile('valet.html'));

  // ---------------------------------------------------------------- installations

  app.get('/v1/installations', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return inst.list(req.principal.orgId, Q(req)); });
  app.post('/v1/installations', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const p = await inst.save(req.principal.orgId, null, B(req), userUuid(req)); await audit(req, 'install.created', 'install_project', p.id, { number: p.number, name: p.name }); return reply.status(201).send(p); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/installations/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:read' });
    try { return await inst.get(req.principal.orgId, P(req).id!); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/installations/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { return await inst.save(req.principal.orgId, P(req).id!, B(req), userUuid(req)); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/installations/:id/stage', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const p = await inst.advance(req.principal.orgId, P(req).id!, B(req), userUuid(req)); await audit(req, `install.${B(req).action === 'cancel' ? 'cancelled' : 'stage'}`, 'install_project', p.id, { stage: p.stage }); return p; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/installations/:id/tasks', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { return reply.status(201).send(await inst.saveTask(req.principal.orgId, P(req).id!, null, B(req), userUuid(req))); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/installations/:id/tasks/:taskId', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { return await inst.saveTask(req.principal.orgId, P(req).id!, P(req).taskId!, B(req), userUuid(req)); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/installations/:id/documents', { bodyLimit: 22 * 1024 * 1024 }, async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const d = await inst.addDocument(req.principal.orgId, P(req).id!, B(req), userUuid(req)); await audit(req, 'install.document_added', 'install_project', P(req).id!, d); return reply.status(201).send(d); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/installations/documents/:docId', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:read' });
    try {
      const d = await inst.document(req.principal.orgId, P(req).docId!);
      return reply.header('content-type', d.mime).header('content-disposition', `attachment; filename="${d.name.replace(/[^\w.\- ]/g, '_')}"`).send(d.data);
    } catch (e) { return failed(reply, e); }
  });
  app.delete('/v1/installations/documents/:docId', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const r = await inst.removeDocument(req.principal.orgId, P(req).docId!); await audit(req, 'install.document_removed', 'install_document', r.id, {}); return r; } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- privacy

  app.get('/v1/privacy/settings', async (req) => { assertCan(req.principal, { permission: 'org:read' }); return privacy.settings(req.principal.orgId); });
  app.put('/v1/privacy/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    try { const s = await privacy.saveSettings(req.principal.orgId, B(req)); await audit(req, 'privacy.settings_saved', 'organisation', null, s); return s; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/privacy/requests', async (req) => { assertCan(req.principal, { permission: 'org:read' }); return { requests: await privacy.requests(req.principal.orgId, Q(req)) }; });
  app.post('/v1/privacy/requests', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    try { const r = await privacy.create(req.principal.orgId, B(req)); await audit(req, 'privacy.request_recorded', 'privacy_request', r.id, { number: r.number, kind: r.kind }); return reply.status(201).send(r); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/privacy/requests/:id/verify', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    try { const r = await privacy.verify(req.principal.orgId, P(req).id!, B(req), userUuid(req)); await audit(req, 'privacy.request_verified', 'privacy_request', r.id, { number: r.number }); return r; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/privacy/requests/:id/close', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    try { const r = await privacy.close(req.principal.orgId, P(req).id!, B(req), userUuid(req)); await audit(req, `privacy.request_${r.status}`, 'privacy_request', r.id, { number: r.number, kind: r.kind, result: r.result }); return r; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/privacy/requests/:id/export.json', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    try {
      const r = (await privacy.requests(req.principal.orgId, { status: 'all' })).find((x) => x.id === P(req).id);
      if (!r) return reply.status(404).send({ error: 'No such request.' });
      if (!['access', 'export'].includes(r.kind) || r.status !== 'done' || !r.appDriverId) return reply.status(409).send({ error: 'Only a completed access or export request has a copy.' });
      const data = await privacy.driverData(req.principal.orgId, r.appDriverId);
      await audit(req, 'privacy.export_downloaded', 'privacy_request', r.id, { number: r.number });
      return reply.header('content-type', 'application/json; charset=utf-8').header('content-disposition', `attachment; filename="${r.number}.json"`).send(JSON.stringify(data, null, 2));
    } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/privacy/consents', async (req) => { assertCan(req.principal, { permission: 'org:read' }); return privacy.consentLog(req.principal.orgId, Q(req)); });
  app.get('/v1/privacy/inventory', async (req) => { assertCan(req.principal, { permission: 'org:read' }); return { inventory: await privacy.inventory(req.principal.orgId) }; });

  // ---------------------------------------------------------------- battery health

  app.get('/v1/battery-health', async (req) => { assertCan(req.principal, { permission: 'smartcharging:read' }); return battery.overview(req.principal.orgId); });
  app.get('/v1/battery-health/:vehicleId', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:read' });
    try { return await battery.vehicle(req.principal.orgId, P(req).vehicleId!); } catch (e) { return failed(reply, e); }
  });
}
