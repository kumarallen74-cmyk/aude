import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertCan } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import * as home from '../services/home-charging.js';
import * as term from '../services/terminals.js';
import * as prices from '../services/energy-prices.js';
import * as surveys from '../services/surveys.js';

/**
 * Phase 35 (v1.47.0): home charging reimbursement (with the employee's page), card payment terminals (with their
 * webhook and receipts), energy market prices, and driver surveys (the console side; the app's is in driver/server.ts).
 * Behind a console session or an API key, except the terminal webhook, the receipt and the employee's page (their own
 * keys).
 */

const TERMINAL_HOOK = '/v1/terminals/events/:key';
const RECEIPT = '/v1/terminal-receipts/:token';
const HOME_PAGE = '/v1/home-charging/:token';

export function isPublicPhase35Route(route: string, method: string): boolean {
  return (method === 'POST' && route === TERMINAL_HOOK) || (method === 'GET' && route === RECEIPT) || ((method === 'GET' || method === 'POST') && route === HOME_PAGE);
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function registerPhase35Routes(app: FastifyInstance): Promise<void> {
  const failed = (reply: FastifyReply, e: unknown) => {
    const s = (e as { statusCode?: number })?.statusCode;
    if (s && s < 500 || e instanceof home.HomeError || e instanceof term.TerminalError || e instanceof prices.PriceError || e instanceof surveys.SurveyError) {
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
  const month = (req: FastifyRequest) => (MONTH_RE.test(Q(req).month ?? '') ? Q(req).month! : new Date().toISOString().slice(0, 7));
  const origin = (req: FastifyRequest) => `${req.protocol}://${req.headers.host ?? ''}`;

  // ---------------------------------------------------------------- home charging reimbursement

  app.get('/v1/home-chargers', async (req) => { assertCan(req.principal, { permission: 'payment:read' }); return { chargers: await home.chargers(req.principal.orgId) }; });
  app.post('/v1/home-chargers', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try { const h = await home.save(req.principal.orgId, null, B(req)) as any; await audit(req, 'home_charger.saved', 'home_charger', h.id, { employee: h.employeeName }); return reply.status(201).send(h); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/home-chargers/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try { const h = await home.save(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'home_charger.saved', 'home_charger', P(req).id!, { archive: B(req).archive === true }); return h; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/home-chargers/:id/readings', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return { readings: await home.readings(req.principal.orgId, P(req).id!) }; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/home-chargers/:id/readings', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try { return reply.status(201).send({ readings: await home.addReading(req.principal.orgId, P(req).id!, B(req), 'console') }); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/home-chargers/:id/portal', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try { const r = await home.rotatePortal(req.principal.orgId, P(req).id!); await audit(req, 'home_charger.portal_link', 'home_charger', P(req).id!, { prefix: r.token.slice(0, 8) }); return r; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/home-reimbursements', async (req) => {
    assertCan(req.principal, { permission: 'payment:read' });
    return { reimbursements: await home.reimbursements(req.principal.orgId, Q(req).month || null, Q(req).homeChargerId || null) };
  });
  app.post('/v1/home-reimbursements', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try { const r = await home.draft(req.principal.orgId, B(req).month); await audit(req, 'home_reimbursement.drafted', 'organisation', null, { month: r.month, drafted: r.drafted }); return r; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/home-reimbursements/:id/:action', async (req, reply) => {
    assertCan(req.principal, { permission: P(req).action === 'approve' ? 'finance:approve' : 'payment:write' });
    try { const r = await home.setStatus(req.principal.orgId, P(req).id!, P(req).action, userUuid(req)); await audit(req, `home_reimbursement.${r.status}`, 'home_reimbursement', r.id, { amountMinor: r.amountMinor, month: r.month }); return r; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/home-reimbursements/payroll.csv', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const m = month(req);
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="home-charging-${m}.csv"`).send(await home.payrollCsv(req.principal.orgId, m));
  });
  app.get('/v1/home-reimbursements.xlsx', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const m = month(req);
    return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="home-charging-${m}.xlsx"`)
      .send(await home.xlsxFor(req.principal.orgId, m));
  });
  // The employee's page (its secret link).
  app.get('/v1/home-charging/:token', async (req, reply) => { try { return await home.portalView(P(req).token!); } catch (e) { return failed(reply, e); } });
  app.post('/v1/home-charging/:token', async (req, reply) => { try { return await home.portalReading(P(req).token!, B(req)); } catch (e) { return failed(reply, e); } });
  app.get('/home-charging/:token', async (_req, reply) => reply.header('cache-control', 'no-cache').header('referrer-policy', 'no-referrer').sendFile('home-charging.html'));

  // ---------------------------------------------------------------- card payment terminals

  app.get('/v1/terminals', async (req) => { assertCan(req.principal, { permission: 'payment:read' }); return { terminals: await term.terminals(req.principal.orgId), days: await term.summary(req.principal.orgId) }; });
  app.post('/v1/terminals', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try { const t = await term.saveTerminal(req.principal.orgId, null, B(req)) as any; await audit(req, 'terminal.saved', 'payment_terminal', t.id, { name: t.name }); return reply.status(201).send(t); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/terminals/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try { const t = await term.saveTerminal(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'terminal.saved', 'payment_terminal', P(req).id!, { archive: B(req).archive === true, rotateKey: B(req).rotateKey === true }); return t; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/terminal-payments', async (req) => { assertCan(req.principal, { permission: 'payment:read' }); return { payments: await term.txns(req.principal.orgId, Q(req)) }; });
  app.post('/v1/terminal-payments/:id/retry', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try { const t = await term.retry(req.principal.orgId, P(req).id!); await audit(req, 'terminal_payment.retry', 'terminal_txn', t.id, { reference: t.reference }); return t; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/terminal-settlements', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try { const r = await term.reconcile(req.principal.orgId, B(req)); await audit(req, 'terminal.settlement_imported', 'organisation', null, { batch: r.batch, matched: r.matched, mismatch: r.mismatch, unknown: r.unknown }); return r; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/terminal-settlements/unsettled', async (req) => { assertCan(req.principal, { permission: 'payment:read' }); return { payments: await term.unsettled(req.principal.orgId) }; });
  app.post('/v1/terminals/events/:key', async (req, reply) => {
    try { return await term.ingest(P(req).key!, req.body ?? null, origin(req)); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/terminal-receipts/:token', async (req, reply) => { try { return await term.receipt(P(req).token!); } catch (e) { return failed(reply, e); } });
  app.get('/terminal-receipt/:token', async (_req, reply) => reply.header('cache-control', 'no-cache').header('referrer-policy', 'no-referrer').sendFile('terminal-receipt.html'));

  // ---------------------------------------------------------------- energy market prices

  app.get('/v1/energy-prices/zones', async (req) => {
    assertCan(req.principal, { permission: 'smartcharging:read' });
    return { zones: await prices.zones(req.principal.orgId), sites: await prices.sites(req.principal.orgId) };
  });
  app.post('/v1/energy-prices/zones', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { const z = await prices.saveZone(req.principal.orgId, null, B(req)) as any; await audit(req, 'energy_price_zone.saved', 'energy_price_zone', z.id, { name: z.name, source: z.source }); return reply.status(201).send(z); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/energy-prices/zones/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { const z = await prices.saveZone(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'energy_price_zone.saved', 'energy_price_zone', P(req).id!, { archive: B(req).archive === true }); return z; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/energy-prices/zones/:id/prices', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { const r = await prices.importPrices(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'energy_price.imported', 'energy_price_zone', P(req).id!, r); return r; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/energy-prices/zones/:id/fetch', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { return await prices.fetchNow(req.principal.orgId, P(req).id!); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/energy-prices/zones/:id/day', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:read' });
    try { return await prices.day(req.principal.orgId, P(req).id!, Q(req).date); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/sites/:siteId/energy-prices', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { const r = await prices.siteSettings(req.principal.orgId, P(req).siteId!, B(req)); await audit(req, 'site.energy_prices_saved', 'site', P(req).siteId!, r); return r; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/energy-prices/savings', async (req) => { assertCan(req.principal, { permission: 'smartcharging:read' }); return prices.savings(req.principal.orgId, Q(req).month); });

  // ---------------------------------------------------------------- driver surveys

  app.get('/v1/surveys/settings', async (req) => { assertCan(req.principal, { permission: 'session:read' }); return surveys.settings(req.principal.orgId); });
  app.put('/v1/surveys/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    try { const s = await surveys.saveSettings(req.principal.orgId, B(req)); await audit(req, 'survey.settings_saved', 'organisation', null, s); return s; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/surveys/nps', async (req) => { assertCan(req.principal, { permission: 'session:read' }); return surveys.overview(req.principal.orgId, Q(req)); });
  app.get('/v1/surveys/responses', async (req) => { assertCan(req.principal, { permission: 'session:read' }); return { responses: await surveys.responses(req.principal.orgId, Q(req)) }; });
}
