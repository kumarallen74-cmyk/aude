import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertCan } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import { sandboxInfo } from '../sandbox/provision.js';
import {
  brandOf, saveBrand, saveIcon, deleteBrand, palette, readiness, buildKit, BrandError, ICON_SIZES, type Brand,
  saveApnsKey, recheckApns, removeApnsKey,
} from '../services/brand.js';
import { one } from '../db/pool.js';
import { liveActivityCounts } from '../services/live-activity.js';

/**
 * The operator's own driver app (Commercial → Driver app).
 *
 *   GET    /v1/driver-app          the brand, its colours as used, what is missing, and where it is served
 *   PUT    /v1/driver-app          create or change it (and set it live)
 *   PUT    /v1/driver-app/icon     the square PNG icon (base64); every size is made from it
 *   GET    /v1/driver-app/kit      the store build kit (zip)
 *   DELETE /v1/driver-app          back to the PlugSure app
 *   PUT    /v1/driver-app/apns     the iOS notifications key (.p8), checked with Apple
 *   POST   /v1/driver-app/apns/check   check it again
 *   DELETE /v1/driver-app/apns     remove it (the iOS app stops getting notifications)
 */
export async function registerBrandRoutes(app: FastifyInstance): Promise<void> {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof BrandError) return reply.status(e.status).send({ error: e.message, fields: e.fields });
    throw e;
  };
  const audit = (req: FastifyRequest, action: string, after?: Record<string, unknown>) =>
    writeAudit({ orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action, targetType: 'driver_app', targetId: req.principal.orgId, after: after ?? null, ip: req.ip });

  const iosDevices = async (b: Brand | null) => b ? Number((await one<{ n: number }>(`SELECT count(*)::int AS n FROM push_subscription WHERE kind = 'apns' AND brand_org_id = $1`, [b.orgId]))?.n ?? 0) : 0;
  const view = (req: FastifyRequest, b: Brand | null, iosPushDevices = 0) => {
    const origin = (process.env.DRIVER_PUBLIC_URL || process.env.CONSOLE_PUBLIC_URL || `${req.protocol}://${req.headers.host ?? 'localhost'}`).replace(/\/+$/, '');
    return {
      brand: b,
      palette: b ? palette(b.accentColor, b.badgeColor) : null,
      checks: b ? readiness(b) : [],
      previewUrl: b ? `${origin}/app/?brand=${b.slug}` : null,
      appUrl: b?.hostname ? `https://${b.hostname}/app/` : null,
      iconUrls: b?.hasIcon ? Object.fromEntries(ICON_SIZES.map((s) => [s, `/app/brand/${b.slug}/icon-${s}.png?v=${(b.iconSha256 ?? '').slice(0, 10)}`])) : null,
      maskableUrl: b?.hasIcon ? `/app/brand/${b.slug}/maskable-512.png?v=${(b.iconSha256 ?? '').slice(0, 10)}` : null,
      // What to point the brand's web address at.
      dnsTarget: (() => { try { return new URL(origin).hostname; } catch { return null; } })(),
      // iPhones registered for native notifications through the brand's APNs key.
      iosPushDevices,
    };
  };

  const notInSandbox = async (req: FastifyRequest) => {
    if (await sandboxInfo(req.principal.orgId)) throw new BrandError(409, 'A white-label app belongs to a production operator, not a sandbox.');
  };

  app.get('/v1/driver-app', async (req) => {
    assertCan(req.principal, { permission: 'org:read' });
    const b = await brandOf(req.principal.orgId);
    return { ...view(req, b, await iosDevices(b)), liveActivities: b ? await liveActivityCounts(b.orgId) : { active: 0, pushToStart: 0 } };
  });

  app.put('/v1/driver-app', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    try {
      await notInSandbox(req);
      const before = await brandOf(req.principal.orgId);
      const b = await saveBrand(req.principal.orgId, (req.body ?? {}) as Record<string, unknown>);
      await audit(req, before ? 'driver_app.updated' : 'driver_app.created', { slug: b.slug, status: b.status, hostname: b.hostname, versionCode: b.versionCode });
      if (before?.status !== 'live' && b.status === 'live') await audit(req, 'driver_app.published', { hostname: b.hostname });
      return view(req, b);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put('/v1/driver-app/icon', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    const b64 = String(((req.body ?? {}) as Record<string, unknown>).png ?? '').replace(/^data:image\/png;base64,/, '');
    if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) return reply.status(422).send({ error: 'Send the icon as a base64 PNG in "png".' });
    try {
      const { brand, icon } = await saveIcon(req.principal.orgId, Buffer.from(b64, 'base64'));
      await audit(req, 'driver_app.icon_changed', { sha256: icon.sha256, width: icon.width });
      return { ...view(req, brand), icon };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/v1/driver-app/kit', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:read' });
    const b = await brandOf(req.principal.orgId);
    if (!b) return reply.status(404).send({ error: 'Set up the driver app first.' });
    const kit = await buildKit(b);
    await audit(req, 'driver_app.kit_downloaded', { versionCode: b.versionCode, warnings: kit.warnings.length });
    return reply
      .header('content-disposition', `attachment; filename="${b.slug}-build-kit-${b.versionName}.zip"`)
      .header('x-kit-warnings', String(kit.warnings.length))
      .type('application/zip')
      .send(kit.zip);
  });

  app.put('/v1/driver-app/apns', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const brand = await saveApnsKey(req.principal.orgId, b.keyId, b.p8);
      await audit(req, 'driver_app.apns_key_set', { keyId: brand.apnsKeyId, checkOk: brand.apnsCheckOk });
      return view(req, brand, await iosDevices(brand));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/v1/driver-app/apns/check', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    try {
      const brand = await recheckApns(req.principal.orgId);
      return view(req, brand, await iosDevices(brand));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete('/v1/driver-app/apns', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    const b = await brandOf(req.principal.orgId);
    if (!b?.apnsConfigured) return reply.status(404).send({ error: 'There is no notifications key to remove.' });
    await removeApnsKey(req.principal.orgId);
    await audit(req, 'driver_app.apns_key_removed', { keyId: b.apnsKeyId });
    return { ok: true };
  });

  app.delete('/v1/driver-app', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    const b = await brandOf(req.principal.orgId);
    if (!b) return reply.status(404).send({ error: 'There is no driver app to remove.' });
    if (b.status === 'live' && ((req.query ?? {}) as Record<string, unknown>).confirm !== b.slug) {
      return reply.status(409).send({ error: `The app is live at ${b.hostname}. Its store apps stop working when it is removed. Confirm with ?confirm=${b.slug}.` });
    }
    await deleteBrand(req.principal.orgId);
    await audit(req, 'driver_app.deleted', { slug: b.slug, hostname: b.hostname });
    return { ok: true };
  });
}
