import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertCan, can } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import * as field from '../services/field.js';
import * as priv from '../services/private-charging.js';
import * as anpr from '../services/anpr.js';

/**
 * Phase 34 (v1.46.0): the technician field app, residential and workplace charging (with the manager's page), and
 * number-plate cameras and parking. Behind a console session or an API key, except the camera webhook and the
 * building manager's page (their own keys). The trip planner is in the driver API (driver/server.ts).
 */

const ANPR_INGEST = '/v1/anpr/events/:key';
const BUILDING = '/v1/building/:token';

export function isPublicPhase34Route(route: string, method: string): boolean {
  return (method === 'POST' && route === ANPR_INGEST) || ((method === 'GET' || method === 'POST') && route === BUILDING);
}

const statusOf = (e: unknown): number | null =>
  e instanceof field.FieldError || e instanceof priv.PrivateError || e instanceof anpr.AnprError ? (e as { statusCode: number }).statusCode
    : (e as { statusCode?: number })?.statusCode && (e as { statusCode: number }).statusCode < 500 ? (e as { statusCode: number }).statusCode : null;

export async function registerPhase34Routes(app: FastifyInstance): Promise<void> {
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
  /** A technician (charge_point:command) or the office (charge_point:write). */
  const fieldWrite = (req: FastifyRequest) => { if (!can(req.principal, { permission: 'charge_point:command' })) assertCan(req.principal, { permission: 'charge_point:write' }); };

  // ---------------------------------------------------------------- the field app

  app.get('/v1/field/jobs', async (req) => { assertCan(req.principal, { permission: 'charge_point:read' }); return { jobs: await field.jobs(req.principal.orgId, userUuid(req), Q(req)) }; });
  app.get('/v1/field/jobs/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    try { return await field.job(req.principal.orgId, P(req).id!); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/field/jobs/:id', async (req, reply) => {
    fieldWrite(req);
    try {
      const j = await field.update(req.principal.orgId, P(req).id!, B(req), userUuid(req));
      if (['finish', 'arrive', 'take'].includes(String(B(req).action))) await audit(req, `field.${B(req).action}`, 'work_order', j.id, { number: j.number, status: j.status });
      return j;
    } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/field/jobs/:id/photos', async (req, reply) => {
    fieldWrite(req);
    try { return reply.status(201).send(await field.addPhoto(req.principal.orgId, P(req).id!, B(req), userUuid(req))); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/field/photos/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    try { const p = await field.photo(req.principal.orgId, P(req).id!); return reply.header('content-type', p.mime).header('cache-control', 'private, max-age=3600').send(p.data); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/field/jobs/:id/signature', async (req, reply) => {
    fieldWrite(req);
    try { const j = await field.sign(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'field.signed', 'work_order', j.id, { name: j.signatureName }); return j; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/field/jobs/:id/signature', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    try { return reply.header('content-type', 'image/png').send(await field.signature(req.principal.orgId, P(req).id!)); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/field/jobs/:id/parts', async (req, reply) => {
    fieldWrite(req);
    try { const j = await field.issuePart(req.principal.orgId, P(req).id!, B(req), userUuid(req)); await audit(req, 'field.part_issued', 'work_order', j.id, { itemId: B(req).itemId, qty: B(req).qty }); return j; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/field/jobs/:id/check', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:command' });
    try { return await field.checkCharger(req.principal.orgId, P(req).id!, userUuid(req), req.ip); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/field/parts', async (req) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    const o = await (await import('../services/inventory.js')).overview(req.principal.orgId) as any;
    return { items: o.items ?? [], locations: o.locations ?? [] };
  });
  app.put('/v1/field/jobs/:id/plan', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:write' });
    try { const j = await field.plan(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'field.planned', 'work_order', j.id, B(req)); return j; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/field/templates', async (req) => { assertCan(req.principal, { permission: 'charge_point:read' }); return { templates: await field.templates(req.principal.orgId) }; });
  app.post('/v1/field/templates', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:write' });
    try { const t = await field.saveTemplate(req.principal.orgId, null, B(req)); await audit(req, 'field.template_saved', 'field_template', t.id, { name: (t as any).name }); return reply.status(201).send(t); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/field/templates/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:write' });
    try { const t = await field.saveTemplate(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'field.template_saved', 'field_template', P(req).id!, { archive: B(req).archive === true }); return t; } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- residential and workplace charging

  app.get('/v1/private-groups', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return { groups: await priv.groups(req.principal.orgId) }; });
  app.post('/v1/private-groups', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const g = await priv.saveGroup(req.principal.orgId, null, B(req)); await audit(req, 'private_group.saved', 'private_group', (g as any).id, B(req)); return reply.status(201).send(g); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/private-groups/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:read' });
    try { return await priv.detail(req.principal.orgId, P(req).id!); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/private-groups/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const g = await priv.saveGroup(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'private_group.saved', 'private_group', P(req).id!, B(req)); return g; } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/private-groups/:id/chargers', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const g = await priv.setChargers(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'private_group.chargers', 'private_group', P(req).id!, B(req)); return g; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/private-groups/:id/units', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { return reply.status(201).send(await priv.saveUnit(req.principal.orgId, P(req).id!, null, B(req))); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/private-groups/:id/units/:unitId', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { return await priv.saveUnit(req.principal.orgId, P(req).id!, P(req).unitId!, B(req)); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/private-groups/:id/members', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const m = await priv.saveMember(req.principal.orgId, P(req).id!, null, B(req)); await audit(req, 'private_member.saved', 'private_group', P(req).id!, { memberId: (m as any).id }); return reply.status(201).send(m); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/private-groups/:id/members/:memberId', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const m = await priv.saveMember(req.principal.orgId, P(req).id!, P(req).memberId!, B(req)); await audit(req, 'private_member.saved', 'private_group', P(req).id!, { memberId: P(req).memberId, archive: B(req).archive === true }); return m; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/private-groups/:id/statements', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:read' });
    try { return { statements: await priv.statements(req.principal.orgId, P(req).id!, Q(req).month || null) }; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/private-groups/:id/statements', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const r = await priv.draftStatements(req.principal.orgId, P(req).id!, B(req).month); await audit(req, 'private_statement.drafted', 'private_group', P(req).id!, { month: r.month, drafted: r.drafted }); return r; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/private-groups/:id/statements.xlsx', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:read' });
    try {
      const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(Q(req).month ?? '') ? Q(req).month! : new Date().toISOString().slice(0, 7);
      const f = await priv.statementsXlsx(req.principal.orgId, P(req).id!, month);
      return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="private-statements-${month}.xlsx"`).send(f);
    } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/private-statements/:id/:action', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const s = await priv.setStatement(req.principal.orgId, P(req).id!, P(req).action); await audit(req, `private_statement.${P(req).action}`, 'private_statement', s.id, { amountMinor: s.amountMinor }); return s; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/private-groups/:id/portal', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const r = await priv.rotatePortal(req.principal.orgId, P(req).id!); await audit(req, 'private_group.portal_link', 'private_group', P(req).id!, { prefix: r.token.slice(0, 8) }); return r; } catch (e) { return failed(reply, e); }
  });
  // The building or office manager's page (its secret link).
  app.get('/v1/building/:token', async (req, reply) => {
    try { return await priv.portalView(P(req).token!); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/building/:token', async (req, reply) => {
    try { return await priv.portalChange(P(req).token!, B(req)); } catch (e) { return failed(reply, e); }
  });
  app.get('/building/:token', async (_req, reply) => reply.header('cache-control', 'no-cache').header('referrer-policy', 'no-referrer').sendFile('building.html'));

  // ---------------------------------------------------------------- number-plate cameras and parking

  app.get('/v1/anpr/cameras', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return { cameras: await anpr.cameras(req.principal.orgId) }; });
  app.post('/v1/anpr/cameras', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const c = await anpr.saveCamera(req.principal.orgId, null, B(req)); await audit(req, 'anpr.camera_saved', 'anpr_camera', c.id, { name: (c as any).name }); return reply.status(201).send(c); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/anpr/cameras/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const c = await anpr.saveCamera(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'anpr.camera_saved', 'anpr_camera', P(req).id!, { archive: B(req).archive === true, rotateKey: B(req).rotateKey === true }); return c; } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/sites/:siteId/parking', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const r = await anpr.siteParking(req.principal.orgId, P(req).siteId!, B(req)); await audit(req, 'site.parking_saved', 'site', P(req).siteId!, r); return r; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/parking/visits', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return { visits: await anpr.visits(req.principal.orgId, Q(req)) }; });
  app.get('/v1/anpr/events', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return { events: await anpr.events(req.principal.orgId, Number(Q(req).limit) || 100) }; });
  app.post('/v1/parking/visits/:id/:action', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const r = await anpr.settleVisit(req.principal.orgId, P(req).id!, P(req).action); await audit(req, `parking_visit.${r.status}`, 'parking_visit', r.id, r); return r; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/anpr/events/:key', async (req, reply) => {
    try { return await anpr.ingest(P(req).key!, req.body ?? null); } catch (e) { return failed(reply, e); }
  });
}
