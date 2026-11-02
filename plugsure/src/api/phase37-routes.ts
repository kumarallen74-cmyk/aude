import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertCan } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import * as swap from '../services/battery-swap.js';
import * as roadside from '../services/roadside.js';
import * as warranty from '../services/warranty.js';
import * as amenities from '../services/amenities.js';

/**
 * Phase 37 (v1.49.0): two-wheeler battery swap (with the cabinets' own API), mobile and roadside charging, warranty
 * and RMA, accessibility and site amenities (the driver's side of each is in driver/server.ts). Behind a console
 * session or an API key, except the cabinets' API (each cabinet's own key).
 */

const CABINET = '/v1/swap/cabinets/:key';

export function isPublicPhase37Route(route: string, method: string): boolean {
  return method === 'POST' && route === CABINET;
}

export async function registerPhase37Routes(app: FastifyInstance): Promise<void> {
  const failed = (reply: FastifyReply, e: unknown) => {
    const s = (e as { statusCode?: number })?.statusCode;
    if ((s && s < 500) || e instanceof swap.SwapError || e instanceof roadside.RoadsideError || e instanceof warranty.WarrantyError || e instanceof amenities.AmenityError) {
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
  const org = (req: FastifyRequest) => req.principal.orgId;

  // ---------------------------------------------------------------- battery swap

  app.get('/v1/battery-swap', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return swap.overview(org(req)); });
  app.put('/v1/battery-swap/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const s = await swap.saveSettings(org(req), B(req)); await audit(req, 'swap.settings_saved', 'organisation', null, s); return s; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/battery-swap/cabinets', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const c = await swap.saveCabinet(org(req), null, B(req)) as any; await audit(req, 'swap.cabinet_saved', 'swap_cabinet', c.id, { code: c.code }); return reply.status(201).send(c); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/battery-swap/cabinets/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const c = await swap.saveCabinet(org(req), P(req).id!, B(req)); await audit(req, 'swap.cabinet_saved', 'swap_cabinet', P(req).id!, { archive: B(req).archive === true, rotateKey: B(req).rotateKey === true }); return c; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/battery-swap/packs', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return swap.batteries(org(req), Q(req)); });
  app.post('/v1/battery-swap/packs', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const p = await swap.saveBattery(org(req), null, B(req)); await audit(req, 'swap.pack_registered', 'swap_battery', p.id, { serial: p.serial }); return reply.status(201).send(p); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/battery-swap/packs/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const p = await swap.saveBattery(org(req), P(req).id!, B(req)); await audit(req, 'swap.pack_changed', 'swap_battery', p.id, { serial: p.serial, status: p.status }); return p; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/battery-swap/plans', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return { plans: await swap.plans(org(req)) }; });
  app.post('/v1/battery-swap/plans', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const p = await swap.savePlan(org(req), null, B(req)) as any; await audit(req, 'swap.plan_saved', 'swap_plan', p.id, { name: p.name }); return reply.status(201).send(p); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/battery-swap/plans/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const p = await swap.savePlan(org(req), P(req).id!, B(req)); await audit(req, 'swap.plan_saved', 'swap_plan', P(req).id!, { archive: B(req).archive === true }); return p; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/battery-swap/riders', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return { riders: await swap.riders(org(req)) }; });
  app.get('/v1/battery-swap/swaps', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return { swaps: await swap.events(org(req), Q(req)) }; });

  // The cabinet's controller (its own key).
  app.post('/v1/swap/cabinets/:key', async (req, reply) => {
    try {
      const r = await swap.cabinetEvent(P(req).key!, B(req)) as Record<string, unknown>;
      return B(req).type === 'swap' && r.outcome === 'refused' ? reply.status(402).send(r) : r;
    } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- roadside

  app.get('/v1/roadside', async (req) => {
    assertCan(req.principal, { permission: 'session:read' });
    return { settings: await roadside.settings(org(req)), ...(await roadside.requests(org(req), Q(req))), vans: await roadside.vans(org(req)) };
  });
  app.put('/v1/roadside/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'session:write' });
    try { const s = await roadside.saveSettings(org(req), B(req)); await audit(req, 'roadside.settings_saved', 'organisation', null, s); return s; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/roadside/requests', async (req, reply) => {
    assertCan(req.principal, { permission: 'session:write' });
    try { const r = await roadside.createRequest(org(req), B(req)); await audit(req, 'roadside.request_taken', 'roadside_request', r.id, { number: r.number }); return reply.status(201).send(r); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/roadside/requests/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'session:read' });
    try { return await roadside.getRequest(org(req), P(req).id!); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/roadside/requests/:id/status', async (req, reply) => {
    assertCan(req.principal, { permission: 'session:write' });
    try { const r = await roadside.advance(org(req), P(req).id!, B(req)); await audit(req, `roadside.${r.status}`, 'roadside_request', r.id, { number: r.number, van: r.van, kwh: r.kwhDelivered, amountMinor: r.amountMinor }); return r; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/roadside/vans', async (req) => { assertCan(req.principal, { permission: 'session:read' }); return { vans: await roadside.vans(org(req)) }; });
  app.post('/v1/roadside/vans', async (req, reply) => {
    assertCan(req.principal, { permission: 'session:write' });
    try { const v = await roadside.saveVan(org(req), null, B(req)) as any; await audit(req, 'roadside.van_saved', 'roadside_van', v.id, { name: v.name }); return reply.status(201).send(v); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/roadside/vans/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'session:write' });
    try { return await roadside.saveVan(org(req), P(req).id!, B(req)); } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- warranty and RMA

  app.get('/v1/warranty/chargers', async (req) => { assertCan(req.principal, { permission: 'charge_point:read' }); return warranty.chargers(org(req), Q(req)); });
  app.get('/v1/warranty/chargers/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    try { return { warranties: await warranty.chargerWarranties(org(req), P(req).id!), rma: (await warranty.rmas(org(req), { status: 'all', chargePointId: P(req).id })).cases }; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/warranties', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:write' });
    try { const w = await warranty.saveWarranty(org(req), null, B(req)) as any; await audit(req, 'warranty.saved', 'charger_warranty', w.id, { chargePointId: w.chargePointId, endsOn: w.endsOn }); return reply.status(201).send(w); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/warranties/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:write' });
    try { const w = await warranty.saveWarranty(org(req), P(req).id!, B(req)); await audit(req, 'warranty.saved', 'charger_warranty', P(req).id!, { remove: B(req).remove === true }); return w; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/rma', async (req) => { assertCan(req.principal, { permission: 'charge_point:read' }); return warranty.rmas(org(req), Q(req)); });
  app.post('/v1/rma', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:write' });
    try { const r = await warranty.openRma(org(req), B(req), userUuid(req)); await audit(req, 'rma.opened', 'rma_case', r.id, { number: r.number, inWarranty: r.inWarranty }); return reply.status(201).send(r); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/rma/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    try { return await warranty.getRma(org(req), P(req).id!); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/rma/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:write' });
    try { const r = await warranty.updateRma(org(req), P(req).id!, B(req), userUuid(req)); await audit(req, 'rma.updated', 'rma_case', r.id, { number: r.number, status: r.status }); return r; } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- amenities and accessibility

  app.get('/v1/site-amenities', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return amenities.list(org(req)); });
  app.get('/v1/sites/:id/amenities', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:read' });
    try { return await amenities.get(org(req), P(req).id!); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/sites/:id/amenities', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const a = await amenities.save(org(req), P(req).id!, B(req)); await audit(req, 'site.amenities_saved', 'site', P(req).id!, { amenities: a.amenities, accessibleBays: a.accessibleBays, stepFree: a.stepFree }); return a; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/accessibility-reports', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return { reports: await amenities.reports(org(req), Q(req)) }; });
  app.post('/v1/accessibility-reports/:id/resolve', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const r = await amenities.resolveReport(org(req), P(req).id!, B(req)); await audit(req, `access.report_${r.status}`, 'accessibility_report', r.id, {}); return r; } catch (e) { return failed(reply, e); }
  });
}
