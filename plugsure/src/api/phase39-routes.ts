import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertCan } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import * as ads from '../services/advertising.js';

/**
 * Phase 39 (v1.51.0): advertising on charger and kiosk screens. Behind a console session or an API key, except the
 * screens' player API (each screen's own key): its playlist, the creatives' files and the plays it reports.
 */

export function isPublicPhase39Route(route: string, method: string): boolean {
  return (method === 'GET' && (route === '/v1/ad-player/:key' || route === '/v1/ad-player/:key/creatives/:id')) || (method === 'POST' && route === '/v1/ad-player/:key/plays');
}

export async function registerPhase39Routes(app: FastifyInstance): Promise<void> {
  const failed = (reply: FastifyReply, e: unknown) => {
    const s = (e as { statusCode?: number })?.statusCode;
    if ((s && s < 500) || e instanceof ads.AdError) return reply.status(s ?? 422).send({ error: (e as Error).message });
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
  const R = (req: FastifyRequest) => assertCan(req.principal, { permission: 'invoice:read' });
  const W = (req: FastifyRequest) => assertCan(req.principal, { permission: 'invoice:write' });
  const xlsxReply = (reply: FastifyReply, x: { name: string; data: Buffer }) =>
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="${x.name}"`).send(x.data);

  // ---------------------------------------------------------------- settings and advertisers
  app.get('/v1/advertising/settings', async (req) => { R(req); return ads.settings(org(req)); });
  app.put('/v1/advertising/settings', async (req, reply) => {
    W(req);
    try { const s = await ads.saveSettings(org(req), B(req)); await audit(req, 'ads.settings_saved', 'organisation', null, s); return s; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/advertisers', async (req) => { R(req); return { advertisers: await ads.advertisers(org(req)) }; });
  app.post('/v1/advertisers', async (req, reply) => {
    W(req);
    try { const a = await ads.saveAdvertiser(org(req), null, B(req)) as any; await audit(req, 'ads.advertiser_saved', 'ad_advertiser', a.id, { name: a.name }); return reply.status(201).send(a); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/advertisers/:id', async (req, reply) => {
    W(req);
    try { const a = await ads.saveAdvertiser(org(req), P(req).id!, B(req)); await audit(req, 'ads.advertiser_saved', 'ad_advertiser', P(req).id!, { archive: B(req).archive === true }); return a; } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- screens
  app.get('/v1/ad-screens', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return { screens: await ads.screens(org(req)) }; });
  app.post('/v1/ad-screens', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const s = await ads.saveScreen(org(req), null, B(req)) as any; await audit(req, 'ads.screen_saved', 'ad_screen', s.id, { name: s.name }); return reply.status(201).send(s); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/ad-screens/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const s = await ads.saveScreen(org(req), P(req).id!, B(req)); await audit(req, 'ads.screen_saved', 'ad_screen', P(req).id!, { archive: B(req).archive === true, rotateKey: B(req).rotateKey === true }); return s; } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- campaigns and creatives
  app.get('/v1/ad-campaigns', async (req) => { R(req); return { campaigns: await ads.campaigns(org(req), Q(req)) }; });
  app.post('/v1/ad-campaigns', async (req, reply) => {
    W(req);
    try { const c = await ads.saveCampaign(org(req), null, B(req)); await audit(req, 'ads.campaign_saved', 'ad_campaign', c.id, { name: c.name }); return reply.status(201).send(c); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/ad-campaigns/:id', async (req, reply) => { R(req); try { return await ads.campaign(org(req), P(req).id!); } catch (e) { return failed(reply, e); } });
  app.put('/v1/ad-campaigns/:id', async (req, reply) => {
    W(req);
    try { const c = await ads.saveCampaign(org(req), P(req).id!, B(req)); await audit(req, 'ads.campaign_saved', 'ad_campaign', c.id, { name: c.name, rateMinor: c.rateMinor }); return c; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/ad-campaigns/:id/status', async (req, reply) => {
    W(req);
    try { const c = await ads.setStatus(org(req), P(req).id!, B(req)); await audit(req, `ads.campaign_${c.status}`, 'ad_campaign', c.id, { name: c.name }); return c; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/ad-campaigns/:id/proof.xlsx', async (req, reply) => { R(req); try { return xlsxReply(reply, await ads.proofXlsx(org(req), P(req).id!)); } catch (e) { return failed(reply, e); } });
  app.post('/v1/ad-campaigns/:id/creatives', { bodyLimit: 42 * 1024 * 1024 }, async (req, reply) => {
    W(req);
    try { const k = await ads.addCreative(org(req), P(req).id!, B(req)); await audit(req, 'ads.creative_added', 'ad_creative', k.id, { name: k.name, campaignId: P(req).id }); return reply.status(201).send(k); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/ad-creatives/:id/file', async (req, reply) => {
    R(req);
    try { const f = await ads.creativeFile(org(req), P(req).id!); return reply.header('content-type', f.mime).header('cache-control', 'private, max-age=300').send(f.data); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/ad-creatives/:id/review', async (req, reply) => {
    W(req);
    try { const k = await ads.reviewCreative(org(req), P(req).id!, B(req), userUuid(req)); await audit(req, `ads.creative_${k.review}`, 'ad_creative', k.id, { note: B(req).note ?? null }); return k; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/ad-creatives/:id/remove', async (req, reply) => {
    W(req);
    try { const k = await ads.removeCreative(org(req), P(req).id!); await audit(req, 'ads.creative_removed', 'ad_creative', k.id, {}); return k; } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- invoices
  app.get('/v1/ad-invoices', async (req) => { R(req); return { invoices: await ads.invoices(org(req)) }; });
  app.post('/v1/advertisers/:id/invoices', async (req, reply) => {
    W(req);
    try { return await ads.draftInvoice(org(req), P(req).id!, String(B(req).month ?? '')); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/ad-invoices/:id', async (req, reply) => {
    W(req);
    try { const i = await ads.invoiceAct(org(req), P(req).id!, B(req)); await audit(req, `ads.invoice_${String(B(req).action)}`, 'ad_invoice', i.id, { number: i.number, totalMinor: i.totalMinor, reference: i.reference }); return i; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/ad-invoices/:id/invoice.xlsx', async (req, reply) => { R(req); try { return xlsxReply(reply, await ads.invoiceXlsx(org(req), P(req).id!)); } catch (e) { return failed(reply, e); } });

  // ---------------------------------------------------------------- the screen's player (its own key)
  app.get('/v1/ad-player/:key', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    try { return await ads.player(P(req).key!); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/ad-player/:key/creatives/:id', async (req, reply) => {
    try { const f = await ads.playerFile(P(req).key!, P(req).id!); return reply.header('content-type', f.mime).header('cache-control', 'private, max-age=86400').send(f.data); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/ad-player/:key/plays', async (req, reply) => {
    try { return await ads.reportPlays(P(req).key!, B(req)); } catch (e) { return failed(reply, e); }
  });
}
