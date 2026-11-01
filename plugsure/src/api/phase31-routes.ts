import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { assertCan } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import { TokenBuckets } from '../services/ratelimit.js';
import * as scim from '../services/scim.js';
import * as dp from '../services/dynamic-pricing.js';
import * as dr from '../services/demand-response.js';
import * as sp from '../services/status-page.js';

/**
 * Phase 31 (v1.43.0): SCIM provisioning, dynamic pricing, grid demand response, the public status page.
 *
 * Public (no console session; each authenticates by its own means, or is public by nature — isPublicPhase31Route):
 *   /scim/v2/…                                  the identity provider, with the organisation's SCIM token
 *   POST /v1/dr/programs/:id/events             the grid operator or aggregator, with the programme's key
 *   GET  /v1/status/:slug                       the public status page's data
 *   POST /v1/status/:slug/subscribe             e-mail updates (a confirmation link is sent)
 *   GET  /v1/status/:slug/confirm|unsubscribe   the links in those e-mails
 *   GET  /status/:slug, /status                 the page itself (the shared console; an operator's own address)
 */

const DR_INGEST = '/v1/dr/programs/:id/events';
const STATUS_PUBLIC = ['/v1/status/:slug', '/v1/status/:slug/confirm', '/v1/status/:slug/unsubscribe'];
const STATUS_SUBSCRIBE = '/v1/status/:slug/subscribe';

export function isPublicPhase31Route(route: string, method: string): boolean {
  return (method === 'POST' && (route === DR_INGEST || route === STATUS_SUBSCRIBE))
    || (method === 'GET' && STATUS_PUBLIC.includes(route));
}

const statusOf = (e: unknown): number | null =>
  e instanceof dp.PricingError || e instanceof dr.DrError || e instanceof sp.StatusError ? (e as { statusCode: number }).statusCode
    : e instanceof scim.ScimError ? e.status
      : (e as { statusCode?: number })?.statusCode && (e as { statusCode: number }).statusCode < 500 ? (e as { statusCode: number }).statusCode : null;

/** The base the public links (SCIM locations, status e-mails) are built on: the shared console, else this request's host. */
function publicBase(req: FastifyRequest): string {
  const configured = (config.alerts.consoleUrl || config.console.publicBaseUrl || '').replace(/\/+$/, '');
  if (configured) return configured;
  const host = String(req.headers.host ?? 'localhost');
  return `${req.protocol}://${/^[a-z0-9.-]+(:\d+)?$/i.test(host) ? host : 'localhost'}`;
}

export async function registerPhase31Routes(app: FastifyInstance): Promise<void> {
  const failed = (reply: FastifyReply, e: unknown) => {
    const s = statusOf(e);
    if (s) return reply.status(s).send({ error: e instanceof scim.ScimError ? e.detail : (e as Error).message });
    throw e;
  };
  const userUuid = (req: FastifyRequest) => (/^[0-9a-f-]{36}$/i.test(String(req.principal.userId ?? '')) ? req.principal.userId! : null);
  const audit = (req: FastifyRequest, action: string, targetType: string, targetId: string | null, after: Record<string, unknown>) => writeAudit({
    orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action, targetType, targetId: targetId ?? req.principal.orgId, ip: req.ip, after,
  });
  const P = (req: FastifyRequest) => req.params as Record<string, string>;
  const Q = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string>;
  const B = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

  // ---------------------------------------------------------------- dynamic pricing

  app.get('/v1/dynamic-pricing', async (req) => { assertCan(req.principal, { permission: 'tariff:read' }); return dp.overview(req.principal.orgId); });
  app.put('/v1/dynamic-pricing/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    try { const s = await dp.saveSettings(req.principal.orgId, B(req), userUuid(req)); await audit(req, 'pricing.dynamic_settings', 'organisation', null, s as any); return s; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/dynamic-pricing/rules', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    try { const r = await dp.saveRule(req.principal.orgId, null, B(req), userUuid(req)); await audit(req, 'pricing.dynamic_rule_saved', 'dynamic_price_rule', (r as any).id, r as any); return reply.status(201).send(r); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/dynamic-pricing/rules/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    try { const r = await dp.saveRule(req.principal.orgId, P(req).id!, B(req), userUuid(req)); await audit(req, 'pricing.dynamic_rule_saved', 'dynamic_price_rule', P(req).id!, r as any); return r; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/dynamic-pricing/sites/:siteId/preview', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:read' });
    try { return await dp.preview(req.principal.orgId, P(req).siteId!); } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- demand response

  app.get('/v1/dr/programs', async (req) => { assertCan(req.principal, { permission: 'smartcharging:read' }); return { programs: await dr.programs(req.principal.orgId) }; });
  app.post('/v1/dr/programs', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { const p = await dr.saveProgram(req.principal.orgId, null, B(req), userUuid(req)); await audit(req, 'dr.program_saved', 'dr_program', (p as any).id, { ...(p as any) }); return reply.status(201).send(p); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/dr/programs/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { const p = await dr.saveProgram(req.principal.orgId, P(req).id!, B(req), userUuid(req)); await audit(req, 'dr.program_saved', 'dr_program', P(req).id!, { ...(p as any) }); return p; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/dr/programs/:id/key', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { const k = await dr.rotateKey(req.principal.orgId, P(req).id!); await audit(req, 'dr.program_key_rotated', 'dr_program', P(req).id!, { hint: k.hint }); return reply.header('cache-control', 'no-store').send(k); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/dr/programs/:id/manual-event', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { const r = await dr.addManual(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'dr.event_added', 'dr_event', r.id, B(req)); return reply.status(201).send(r); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/dr/programs/:id/poll', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try {
      const { one, outsideRequestScope } = await import('../db/pool.js');
      const p = await outsideRequestScope(() => one<any>(`SELECT * FROM dr_program WHERE id = $1 AND org_id = $2 AND kind = 'openadr3' AND archived_at IS NULL`, [Number(P(req).id) || 0, req.principal.orgId]));
      if (!p) return reply.status(404).send({ error: 'No such OpenADR programme.' });
      const n = await dr.pollOpenAdr(p);
      return { events: n, program: (await dr.programs(req.principal.orgId)).find((x) => x.id === String(p.id)) };
    } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/dr/events', async (req) => { assertCan(req.principal, { permission: 'smartcharging:read' }); return dr.events(req.principal.orgId, Q(req)); });
  app.post('/v1/dr/events/:id/opt-out', async (req, reply) => {
    assertCan(req.principal, { permission: 'smartcharging:write' });
    try { const r = await dr.optOut(req.principal.orgId, P(req).id!, userUuid(req), B(req).note); await audit(req, 'dr.event_opted_out', 'dr_event', P(req).id!, { note: B(req).note ?? null }); return r; } catch (e) { return failed(reply, e); }
  });
  const drBuckets = new TokenBuckets();
  app.post('/v1/dr/programs/:id/events', async (req, reply) => {
    if (!drBuckets.take(`dr:${P(req).id}`, 60).allowed) return reply.status(429).send({ error: 'At most 60 events a minute per programme.' });
    const auth = String(req.headers.authorization ?? '');
    try {
      const r = await dr.ingestWebhook(P(req).id ?? '', auth.startsWith('Bearer ') ? auth.slice(7).trim() : '', req.body);
      return reply.status(r.created ? 201 : 200).send(r);
    } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- status page (console)

  app.get('/v1/status-page', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return sp.page(req.principal.orgId); });
  app.put('/v1/status-page', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const p = await sp.savePage(req.principal.orgId, B(req), userUuid(req)); await audit(req, 'status_page.saved', 'organisation', null, { enabled: p.enabled, slug: p.slug, title: p.title }); return p; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/status-page/incidents', async (req) => { assertCan(req.principal, { permission: 'site:read' }); return sp.incidents(req.principal.orgId, Q(req)); });
  app.post('/v1/status-page/incidents', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const i = await sp.createIncident(req.principal.orgId, B(req), userUuid(req)); await audit(req, 'status_page.incident_opened', 'status_incident', i.id, { kind: i.kind, title: i.title, status: i.status }); return reply.status(201).send(i); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/status-page/incidents/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const i = await sp.updateIncident(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'status_page.incident_updated', 'status_incident', i.id, { status: i.status }); return i; } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- status page (public)

  const statusBuckets = new TokenBuckets();
  app.get('/v1/status/:slug', async (req, reply) => {
    try {
      const s = await sp.publicStatus(P(req).slug ?? null, null);
      if (!s) return reply.status(404).send({ error: 'No such status page.' });
      return reply.header('cache-control', 'public, max-age=30').send(s);
    } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/status/:slug/subscribe', async (req, reply) => {
    if (!statusBuckets.take(`sub:${req.ip ?? 'unknown'}`, 5).allowed) return reply.status(429).send({ error: 'Too many requests. Try again in a minute.' });
    try { await sp.subscribe(P(req).slug ?? '', B(req).email, publicBase(req)); return { ok: true, message: 'Check your inbox for a confirmation link.' }; } catch (e) { return failed(reply, e); }
  });
  const htmlNote = (title: string, text: string, slug: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
    + `<body style="font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;line-height:1.5"><h1 style="font-size:1.3rem">${title}</h1><p>${text}</p><p><a href="/status/${encodeURIComponent(slug)}">Back to the status page</a></p></body>`;
  app.get('/v1/status/:slug/confirm', async (req, reply) => {
    const ok = await sp.confirm(P(req).slug ?? '', Q(req).t).catch(() => false);
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
      .send(htmlNote(ok ? 'Subscribed' : 'Link not valid', ok ? 'You will get an e-mail when there is an incident or planned maintenance.' : 'This link is not valid or was already used.', P(req).slug ?? ''));
  });
  app.get('/v1/status/:slug/unsubscribe', async (req, reply) => {
    const ok = await sp.unsubscribe(P(req).slug ?? '', Q(req).t).catch(() => false);
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
      .send(htmlNote(ok ? 'Unsubscribed' : 'Link not valid', ok ? 'You will not get any more e-mails from this status page.' : 'This link is not valid (a newer e-mail has a newer link), or you were already unsubscribed.', P(req).slug ?? ''));
  });
  // The page itself: one static page that reads its slug from the address (or, on an operator's own console address,
  // finds the page by the host: GET /status.json).
  app.get('/status/:slug', async (_req, reply) => reply.header('cache-control', 'no-cache').sendFile('status.html'));
  app.get('/status', async (_req, reply) => reply.header('cache-control', 'no-cache').sendFile('status.html'));
  app.get('/status.json', async (req, reply) => {
    const s = await sp.publicStatus(null, req.headers.host ?? null).catch(() => null);
    if (!s) return reply.status(404).send({ error: 'No status page on this address.' });
    return reply.header('cache-control', 'public, max-age=30').send(s);
  });

  // ---------------------------------------------------------------- SCIM (console)

  app.get('/v1/scim', async (req) => { assertCan(req.principal, { permission: 'user:read' }); return { ...(await scim.config(req.principal.orgId)), endpoint: `${publicBase(req)}/scim/v2`, roles: (await (await import('../services/saml.js')).mappableRoles()).map((r) => r.name) }; });
  app.put('/v1/scim', async (req, reply) => {
    assertCan(req.principal, { permission: 'user:write' });
    try { const c = await scim.saveConfig(req.principal.orgId, B(req), userUuid(req)); await audit(req, 'org.scim_saved', 'organisation', null, { enabled: c.enabled, roleMap: c.roleMap }); return { ...c, endpoint: `${publicBase(req)}/scim/v2` }; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/scim/token', async (req, reply) => {
    assertCan(req.principal, { permission: 'user:write' });
    const t = await scim.rotateToken(req.principal.orgId, userUuid(req));
    await audit(req, 'org.scim_token_rotated', 'organisation', null, { hint: t.hint });
    return reply.header('cache-control', 'no-store').send({ ...t, endpoint: `${publicBase(req)}/scim/v2` });
  });

  // ---------------------------------------------------------------- SCIM 2.0 (the identity provider)

  await app.register(async (app) => {
    app.addContentTypeParser(['application/scim+json', 'application/json'], { parseAs: 'string', bodyLimit: 1024 * 1024 }, (_req, body, done) => {
      try { done(null, body ? JSON.parse(String(body)) : {}); } catch { done(new scim.ScimError(400, 'The body is not JSON.', 'invalidSyntax') as any, undefined); }
    });
    const buckets = new TokenBuckets();
    const send = (reply: FastifyReply, status: number, body: unknown) => reply.status(status).type('application/scim+json; charset=utf-8').header('cache-control', 'no-store').send(body);
    const fail = (reply: FastifyReply, e: unknown) => {
      if (e instanceof scim.ScimError) return send(reply, e.status, scim.errorBody(e));
      logger.error({ err: e }, 'SCIM request failed');
      return send(reply, 500, scim.errorBody(new scim.ScimError(500, 'The request failed.')));
    };
    const handle = (fn: (orgId: string, req: FastifyRequest, base: string) => Promise<unknown>, okStatus = 200) => async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!buckets.take(`scim:${req.ip ?? 'unknown'}`, 600).allowed) throw new scim.ScimError(429, 'Too many requests.');
        const orgId = await scim.orgForToken(req.headers.authorization);
        const out = await fn(orgId, req, `${publicBase(req)}/scim/v2`);
        if (out === undefined) return reply.status(204).send();
        return send(reply, okStatus, out);
      } catch (e) { return fail(reply, e); }
    };
    const auditScim = (orgId: string, req: FastifyRequest, action: string, targetType: string, targetId: string | null, after: Record<string, unknown>) =>
      writeAudit({ orgId, actorType: 'system', actorId: null, action, targetType, targetId: targetId ?? orgId, ip: req.ip, after: { via: 'scim', ...after } }).catch(() => {});

    app.get('/scim/v2/ServiceProviderConfig', handle(async (_o, _r, base) => scim.serviceProviderConfig(base)));
    app.get('/scim/v2/ResourceTypes', handle(async (_o, _r, base) => scim.resourceTypes(base)));
    app.get('/scim/v2/Schemas', handle(async () => scim.schemas()));
    app.get('/scim/v2/Users', handle(async (o, r, base) => scim.listUsers(o, Q(r), base)));
    app.post('/scim/v2/Users', handle(async (o, r, base) => {
      const u = await scim.createUser(o, r.body, base);
      await auditScim(o, r, 'user.scim_provisioned', 'user', u.id, { userName: u.userName, active: u.active });
      return u;
    }, 201));
    app.get('/scim/v2/Users/:id', handle(async (o, r, base) => scim.getUser(o, P(r).id!, base)));
    app.put('/scim/v2/Users/:id', handle(async (o, r, base) => {
      const u = await scim.replaceUser(o, P(r).id!, r.body, base);
      await auditScim(o, r, 'user.scim_updated', 'user', u.id, { userName: u.userName, active: u.active });
      return u;
    }));
    app.patch('/scim/v2/Users/:id', handle(async (o, r, base) => {
      const u = await scim.patchUser(o, P(r).id!, r.body, base);
      await auditScim(o, r, 'user.scim_updated', 'user', u.id, { userName: u.userName, active: u.active });
      return u;
    }));
    app.delete('/scim/v2/Users/:id', handle(async (o, r) => {
      await scim.deleteUser(o, P(r).id!);
      await auditScim(o, r, 'user.scim_deactivated', 'user', P(r).id!, {});
      return undefined;
    }));
    app.get('/scim/v2/Groups', handle(async (o, r, base) => scim.listGroups(o, Q(r), base)));
    app.post('/scim/v2/Groups', handle(async (o, r, base) => {
      const g = await scim.createGroup(o, r.body, base);
      await auditScim(o, r, 'group.scim_created', 'scim_group', g.id, { displayName: g.displayName, members: g.members.length });
      return g;
    }, 201));
    app.get('/scim/v2/Groups/:id', handle(async (o, r, base) => scim.getGroup(o, P(r).id!, base, Q(r))));
    app.put('/scim/v2/Groups/:id', handle(async (o, r, base) => {
      const g = await scim.replaceGroup(o, P(r).id!, r.body, base);
      await auditScim(o, r, 'group.scim_updated', 'scim_group', g.id, { displayName: g.displayName, members: g.members.length });
      return g;
    }));
    app.patch('/scim/v2/Groups/:id', handle(async (o, r, base) => {
      const g = await scim.patchGroup(o, P(r).id!, r.body, base);
      await auditScim(o, r, 'group.scim_updated', 'scim_group', g.id, { displayName: g.displayName, members: g.members.length });
      return g;
    }));
    app.delete('/scim/v2/Groups/:id', handle(async (o, r) => {
      await scim.deleteGroup(o, P(r).id!);
      await auditScim(o, r, 'group.scim_deleted', 'scim_group', P(r).id!, {});
      return undefined;
    }));
  });
}
