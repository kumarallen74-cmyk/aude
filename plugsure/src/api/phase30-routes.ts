import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { query, outsideRequestScope } from '../db/pool.js';
import { assertCan, can } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import { adminHostAllowed, createSession } from '../services/auth.js';
import { consoleBrandForHost } from '../services/console-brand.js';
import { endPendingOneTimePassword } from '../services/microsoft-signin.js';
import { TokenBuckets } from '../services/ratelimit.js';
import { sessionCookie } from './console-routes.js';
import * as energy from '../services/energy-storage.js';
import * as health from '../services/charger-health.js';
import * as rb from '../services/report-builder.js';
import * as saml from '../services/saml.js';

/**
 * Phase 30 (v1.42.0): solar and battery storage, charger health, the report builder, SAML single sign-on.
 *
 * Public (no console session; each authenticates by its own means — see isPublicPhase30Route):
 *   POST /v1/energy/sites/:siteId/readings   the site's energy box, with its site key (Authorization: Bearer pse_…)
 *   GET  /v1/auth/saml/start                 the sign-in page sends the browser here with a work e-mail
 *   POST /v1/auth/saml/:orgId/acs            the identity provider's answer (HTTP-POST binding)
 *   GET  /v1/auth/saml/finish                our own page moves the browser here, with the binding cookie
 *   GET  /v1/auth/saml/:orgId/metadata       the service-provider metadata for the identity provider's set-up
 */

const SAML_START = '/v1/auth/saml/start', SAML_ACS = '/v1/auth/saml/:orgId/acs', SAML_FINISH = '/v1/auth/saml/finish', SAML_META = '/v1/auth/saml/:orgId/metadata';
const ENERGY_INGEST = '/v1/energy/sites/:siteId/readings';

export function isPublicPhase30Route(route: string, method: string): boolean {
  return (method === 'GET' && (route === SAML_START || route === SAML_FINISH || route === SAML_META))
    || (method === 'POST' && (route === SAML_ACS || route === ENERGY_INGEST));
}

/** The SAML browser-binding cookie: __Host- on https (Path=/), SameSite=Lax, ten minutes. */
export const samlCookieName = (secure = config.console.cookieSecure) => (secure ? `__Host-${saml.SAML_COOKIE}` : saml.SAML_COOKIE);
function samlCookie(value: string | null): string {
  const parts = [`${samlCookieName()}=${value ?? ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', value ? `Max-Age=${saml.SAML_TX_TTL_MINUTES * 60}` : 'Max-Age=0'];
  if (config.console.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}
export function samlBindings(header: unknown): string[] {
  if (typeof header !== 'string') return [];
  const name = samlCookieName();
  const found = header.split(';').map((p) => p.trim()).filter((p) => p.startsWith(`${name}=`)).map((p) => p.slice(name.length + 1));
  // A planted duplicate is no binding at all (never "take the first").
  return found.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(found[0]!) ? [found[0]!] : [];
}

const statusOf = (e: unknown): number | null =>
  e instanceof energy.EnergyError || e instanceof health.HealthError || e instanceof rb.ReportBuilderError ? (e as { statusCode: number }).statusCode
    : e instanceof saml.SamlError ? e.statusCode : (e as { statusCode?: number })?.statusCode && (e as { statusCode: number }).statusCode < 500 ? (e as { statusCode: number }).statusCode : null;

export async function registerPhase30Routes(app: FastifyInstance): Promise<void> {
  const failed = (reply: FastifyReply, e: unknown) => {
    const s = statusOf(e);
    if (s) return reply.status(s).send({ error: e instanceof saml.SamlError ? e.detail : (e as Error).message });
    throw e;
  };
  const userUuid = (req: FastifyRequest) => (/^[0-9a-f-]{36}$/i.test(String(req.principal.userId ?? '')) ? req.principal.userId! : null);
  const audit = (req: FastifyRequest, action: string, targetType: string, targetId: string | null, after: Record<string, unknown>) => writeAudit({
    orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action, targetType, targetId: targetId ?? req.principal.orgId, ip: req.ip, after,
  });
  const P = (req: FastifyRequest) => req.params as Record<string, string>;
  const Q = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string>;
  const B = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const canFor = (req: FastifyRequest) => (perm: string) => can(req.principal, { permission: perm as any });
  const anyOf = (req: FastifyRequest, perms: string[]) => {
    if (!perms.some((p) => can(req.principal, { permission: p as any }))) assertCan(req.principal, { permission: perms[0] as any });
  };

  // ---------------------------------------------------------------- solar and battery

  app.get('/v1/energy', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:read' });
    try { return await energy.overview(req.principal.orgId); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/energy/sites/:siteId/results', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:read' });
    try { return await energy.results(req.principal.orgId, P(req).siteId!, Q(req)); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/energy/assets', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const r = await energy.saveAsset(req.principal.orgId, null, B(req)); await audit(req, 'energy.asset_saved', 'site_energy_asset', (r as any).id, r as any); return reply.status(201).send(r); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/energy/assets/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const r = await energy.saveAsset(req.principal.orgId, P(req).id!, B(req)); await audit(req, 'energy.asset_saved', 'site_energy_asset', P(req).id!, r as any); return r; } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/energy/sites/:siteId/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try { const r = await energy.saveSettings(req.principal.orgId, P(req).siteId!, B(req), userUuid(req)); await audit(req, 'energy.settings_saved', 'site', P(req).siteId!, r as any); return r; } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/energy/sites/:siteId/key', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    try {
      const r = await energy.rotateKey(req.principal.orgId, P(req).siteId!, userUuid(req));
      await audit(req, 'energy.site_key_rotated', 'site', P(req).siteId!, { hint: r.hint });
      return reply.header('cache-control', 'no-store').send(r);
    } catch (e) { return failed(reply, e); }
  });
  const ingestBuckets = new TokenBuckets();
  app.post('/v1/energy/sites/:siteId/readings', async (req, reply) => {
    const siteId = P(req).siteId ?? '';
    if (!ingestBuckets.take(`energy:${siteId}`, 120).allowed) return reply.status(429).send({ error: 'At most 120 posts a minute per site.' });
    const auth = String(req.headers.authorization ?? '');
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.headers['x-site-key'] ?? '');
    try { return await energy.ingest(siteId, key, req.body); } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- charger health

  app.get('/v1/charger-health', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    try { return await health.list(req.principal.orgId, Q(req)); } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/charger-health/:cpId', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    try { return await health.detail(req.principal.orgId, P(req).cpId!); } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/charger-health/:cpId/work-order', async (req, reply) => {
    anyOf(req, ['charge_point:write', 'payment:write']);
    try {
      const r = await health.openWorkOrder(req.principal.orgId, P(req).cpId!, userUuid(req));
      await audit(req, 'maintenance.work_order_saved', 'work_order', String((r as any).id), { from: 'charger_health', chargePointId: P(req).cpId });
      return reply.status(201).send(r);
    } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/charger-health/run', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:write' });
    try { return await health.sweepOrg(req.principal.orgId); } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- the report builder

  const READS = ['session:read', 'charge_point:read', 'payment:read'];
  app.get('/v1/reports/builder', async (req) => { anyOf(req, READS); return rb.catalogue(canFor(req)); });
  app.post('/v1/reports/builder/run', async (req, reply) => {
    anyOf(req, READS);
    try {
      const b = B(req);
      const r = await rb.run(req.principal.orgId, b.dataset, b.spec, canFor(req));
      if (Q(req).format === 'xlsx') {
        return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          .header('content-disposition', `attachment; filename="report-${r.dataset.key}.xlsx"`).send(rb.xlsxOf(String(b.name ?? r.dataset.label), r));
      }
      return r;
    } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/reports/saved', async (req, reply) => { anyOf(req, READS); try { return await rb.list(req.principal.orgId, canFor(req)); } catch (e) { return failed(reply, e); } });
  app.get('/v1/reports/saved/:id', async (req, reply) => { anyOf(req, READS); try { return await rb.get(req.principal.orgId, P(req).id!, canFor(req)); } catch (e) { return failed(reply, e); } });
  app.post('/v1/reports/saved', async (req, reply) => {
    anyOf(req, READS);
    try { const r = await rb.save(req.principal.orgId, null, B(req), userUuid(req), canFor(req)); await audit(req, 'report.saved', 'report_definition', (r as any).id, { name: (r as any).name, dataset: (r as any).dataset, frequency: (r as any).frequency }); return reply.status(201).send(r); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/reports/saved/:id', async (req, reply) => {
    anyOf(req, READS);
    try { const r = await rb.save(req.principal.orgId, P(req).id!, B(req), userUuid(req), canFor(req)); await audit(req, 'report.saved', 'report_definition', P(req).id!, { ...(r as any), spec: undefined }); return r; } catch (e) { return failed(reply, e); }
  });
  app.get('/v1/reports/saved/:id/run', async (req, reply) => {
    anyOf(req, READS);
    try {
      const s = await rb.get(req.principal.orgId, P(req).id!, canFor(req));
      const r = await rb.run(req.principal.orgId, s.dataset, s.spec, canFor(req));
      if (Q(req).format === 'xlsx') {
        return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          .header('content-disposition', `attachment; filename="${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report'}.xlsx"`).send(rb.xlsxOf(s.name, r));
      }
      return { report: s, ...r };
    } catch (e) { return failed(reply, e); }
  });
  app.post('/v1/reports/saved/:id/send', async (req, reply) => {
    anyOf(req, READS);
    try { const r = await rb.send(req.principal.orgId, P(req).id!, canFor(req)); await audit(req, 'report.sent', 'report_definition', P(req).id!, r as any); return r; } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- SAML: the organisation's administrator

  app.get('/v1/auth/saml', async (req, reply) => {
    assertCan(req.principal, { permission: 'user:read' });
    try { return await saml.describe(req.principal.orgId, req.headers.host, req.protocol); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/auth/saml', async (req, reply) => {
    assertCan(req.principal, { permission: 'user:write' });
    try {
      const p = await saml.saveProvider(req.principal.orgId, B(req), userUuid(req));
      await audit(req, 'org.saml_saved', 'organisation', req.principal.orgId, { enabled: p.enabled, idpEntityId: p.idpEntityId, ssoUrl: p.ssoUrl, allowedDomains: p.allowedDomains, jitEnabled: p.jitEnabled, roleMap: p.roleMap, certificates: p.certificates.length });
      return await saml.describe(req.principal.orgId, req.headers.host, req.protocol);
    } catch (e) { return failed(reply, e); }
  });

  // ---------------------------------------------------------------- SAML: the browser's legs (public)

  const buckets = new TokenBuckets();
  const limited = (req: FastifyRequest) => !buckets.take(`saml:${req.ip ?? 'unknown'}`, 60).allowed;
  const go = (reply: FastifyReply, url: string) => reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').redirect(url, 303);
  const consoleUrl = (code: string | null) => `/${code ? `?sso=${encodeURIComponent(code)}` : ''}`;
  const refusedAudit = (orgId: string | null, e: saml.SamlError, ip: string | undefined, step: string) => writeAudit({
    orgId, actorType: 'user', actorId: null, action: 'auth.saml_refused', targetType: 'organisation', targetId: orgId, after: { step, reason: e.code, detail: e.detail.slice(0, 300) }, ip,
  }).catch(() => {});

  app.get('/v1/auth/saml/start', async (req, reply) => {
    if (limited(req)) return go(reply, consoleUrl('rate_limited'));
    try {
      const s = await saml.start(Q(req).email, req.headers.host, req.protocol, req.ip);
      reply.header('set-cookie', samlCookie(s.binding));
      return go(reply, s.url);
    } catch (e) {
      if (e instanceof saml.SamlError) { logger.warn({ reason: e.code, ip: req.ip }, 'SAML sign-in could not start'); return go(reply, consoleUrl(e.code)); }
      throw e;
    }
  });

  await app.register(async (app) => {
    // The identity provider's form post (application/x-www-form-urlencoded), parsed here only.
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: Math.ceil(saml.MAX_RESPONSE_BYTES * 1.5) }, (_req, body, done) => {
      try { done(null, Object.fromEntries(new URLSearchParams(String(body)))); } catch (err) { done(err as Error, undefined); }
    });
    app.post('/v1/auth/saml/:orgId/acs', async (req, reply) => {
      if (limited(req)) return go(reply, consoleUrl('rate_limited'));
      const orgId = P(req).orgId ?? '';
      try {
        const r = await saml.acs(orgId, B(req), req.headers.host, req.protocol);
        // Move the browser to our own origin, where the binding cookie (SameSite=Lax) comes along.
        const to = `/v1/auth/saml/finish?h=${encodeURIComponent(r.handle)}`;
        return reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').type('text/html; charset=utf-8')
          .send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${to}"><title>Signing in…</title><p>Signing in… <a href="${to}">Continue</a></p>`);
      } catch (e) {
        if (e instanceof saml.SamlError) {
          logger.warn({ reason: e.code, detail: e.detail, orgId, ip: req.ip }, 'SAML response refused');
          await refusedAudit(/^[0-9a-f-]{36}$/i.test(orgId) ? orgId : null, e, req.ip, 'acs');
          return go(reply, consoleUrl(e.code));
        }
        throw e;
      }
    });
  });

  app.get('/v1/auth/saml/finish', async (req, reply) => {
    if (limited(req)) return go(reply, consoleUrl('rate_limited'));
    const cookies = [samlCookie(null)];
    let orgId: string | null = null;
    try {
      const t = await saml.consume(Q(req).h, samlBindings(req.headers.cookie));
      orgId = t.orgId;
      const hostBrand = await consoleBrandForHost(t.host).catch(() => null);
      const user = await saml.resolveUser(t.orgId, t.identity, { onlyOrgId: hostBrand?.orgId ?? null, refuseAdministrators: !adminHostAllowed(t.host) });
      if (user.created) {
        await writeAudit({ orgId: user.orgId, actorType: 'user', actorId: user.id, action: 'user.saml_provisioned', targetType: 'user', targetId: user.id, after: { email: user.email, role: user.role, groups: t.identity.groups.slice(0, 20) }, ip: req.ip });
      } else if (user.linkedNow) {
        await writeAudit({ orgId: user.orgId, actorType: 'user', actorId: user.id, action: 'user.saml_linked', targetType: 'user', targetId: user.id, after: { nameId: t.identity.nameId }, ip: req.ip });
      }
      // The identity provider is the first factor; an account with an authenticator app still gives its code.
      const pending = user.mfaEnabled;
      const token = await createSession(user.id, { authMethod: 'saml', mfaPending: pending });
      if (!pending) {
        await outsideRequestScope(() => query(`UPDATE app_user SET last_login_at = now() WHERE id = $1`, [user.id]));
        await outsideRequestScope(() => endPendingOneTimePassword(user.id)).catch(() => false);
      }
      cookies.push(sessionCookie(token));
      await writeAudit({ orgId: user.orgId, actorType: 'user', actorId: user.id, action: pending ? 'auth.login_mfa_challenge' : 'auth.login', targetType: 'user', targetId: user.id, after: { method: 'saml', account: t.identity.email ?? t.identity.nameId }, ip: req.ip });
      reply.header('set-cookie', cookies);
      return go(reply, consoleUrl(null));
    } catch (e) {
      reply.header('set-cookie', cookies);
      if (e instanceof saml.SamlError) {
        logger.warn({ reason: e.code, detail: e.detail, orgId, ip: req.ip }, 'SAML sign-in refused');
        await refusedAudit(orgId, e, req.ip, 'finish');
        return go(reply, consoleUrl(e.code));
      }
      logger.error({ err: e }, 'SAML sign-in failed unexpectedly');
      return go(reply, consoleUrl('failed'));
    }
  });

  app.get('/v1/auth/saml/:orgId/metadata', async (req, reply) => {
    const orgId = P(req).orgId ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) return reply.status(404).send({ error: 'not found' });
    try { return reply.type('application/samlmetadata+xml; charset=utf-8').send(saml.metadataXml(orgId, saml.entityBase(req.headers.host, req.protocol), await saml.flowBases(orgId).then((l) => (l.length ? l : [saml.entityBase(req.headers.host, req.protocol)])))); } catch (e) { return failed(reply, e); }
  });
}
