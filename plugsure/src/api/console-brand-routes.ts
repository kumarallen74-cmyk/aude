import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertCan } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import { sandboxInfo } from '../sandbox/provision.js';
import { BrandError } from '../services/brand.js';
import {
  consoleBrandForHost, consoleBrandForOrg, saveConsoleBrand, saveConsoleLogo, removeConsoleLogo, deleteConsoleBrand,
  logoBySha, brandView, type ConsoleBrand,
} from '../services/console-brand.js';

/**
 * The operator's own console brand (Governance → Console branding), v1.5.0.
 *
 *   GET    /v1/console-brand          the brand and the colours as the console uses them
 *   PUT    /v1/console-brand          create or change it
 *   PUT    /v1/console-brand/logo     the square PNG logo (base64)
 *   DELETE /v1/console-brand/logo     remove the logo
 *   DELETE /v1/console-brand          back to the PlugSure console
 *
 * Public (the sign-in page, before anyone has signed in):
 *   GET    /console-brand.json        the brand of the console's web address, or {brand: null}
 *   GET    /console-brand/<sha256>.png   a logo, by its hash
 */
export async function registerConsoleBrandRoutes(app: FastifyInstance): Promise<void> {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof BrandError) return reply.status(e.status).send({ error: e.message, fields: e.fields });
    throw e;
  };
  const audit = (req: FastifyRequest, action: string, after?: Record<string, unknown>) =>
    writeAudit({ orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action, targetType: 'console_brand', targetId: req.principal.orgId, after: after ?? null, ip: req.ip });
  const view = (b: ConsoleBrand | null) => ({ brand: b, view: b ? brandView(b) : null });

  app.get('/v1/console-brand', async (req) => {
    assertCan(req.principal, { permission: 'org:read' });
    return view(await consoleBrandForOrg(req.principal.orgId));
  });

  app.put('/v1/console-brand', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    try {
      if (await sandboxInfo(req.principal.orgId)) throw new BrandError(409, 'Console branding belongs to a production operator, not a sandbox.');
      const before = await consoleBrandForOrg(req.principal.orgId);
      const b = await saveConsoleBrand(req.principal.orgId, (req.body ?? {}) as Record<string, unknown>);
      await audit(req, before ? 'console_brand.updated' : 'console_brand.created', {
        productName: b.productName, tagline: b.tagline, brandColor: b.brandColor, accentColor: b.accentColor, hostname: b.hostname, showPoweredBy: b.showPoweredBy,
      });
      return view(b);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put('/v1/console-brand/logo', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    const b64 = String(((req.body ?? {}) as Record<string, unknown>).png ?? '').replace(/^data:image\/png;base64,/, '');
    if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) return reply.status(422).send({ error: 'Send the logo as a base64 PNG in "png".' });
    try {
      const { brand, logo } = await saveConsoleLogo(req.principal.orgId, Buffer.from(b64, 'base64'));
      await audit(req, 'console_brand.logo_changed', { sha256: logo.sha256, width: logo.width });
      return { ...view(brand), logo };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete('/v1/console-brand/logo', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    const b = await consoleBrandForOrg(req.principal.orgId);
    if (!b?.hasLogo) return reply.status(404).send({ error: 'There is no logo to remove.' });
    const after = await removeConsoleLogo(req.principal.orgId);
    await audit(req, 'console_brand.logo_removed', { sha256: b.logoSha256 });
    return view(after);
  });

  app.delete('/v1/console-brand', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    const b = await consoleBrandForOrg(req.principal.orgId);
    if (!b) return reply.status(404).send({ error: 'The console already uses the PlugSure brand.' });
    await deleteConsoleBrand(req.principal.orgId);
    await audit(req, 'console_brand.deleted', { productName: b.productName, hostname: b.hostname });
    return { ok: true };
  });

  // ── public: the sign-in page on the brand's own web address
  app.get('/console-brand.json', async (req, reply) => {
    const b = await consoleBrandForHost(req.headers.host).catch(() => null);
    reply.header('cache-control', 'no-cache');
    return { brand: b ? brandView(b) : null };
  });

  app.get<{ Params: { sha: string } }>('/console-brand/:sha', async (req, reply) => {
    const m = /^([0-9a-f]{64})\.png$/.exec(req.params.sha);
    const png = m ? await logoBySha(m[1]!).catch(() => null) : null;
    if (!png) return reply.status(404).send({ error: 'not found' });
    return reply
      .type('image/png')
      // Content-addressed: a new logo has a new address.
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(png);
  });
}
