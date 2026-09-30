import type { FastifyInstance, FastifyRequest } from 'fastify';
import { routePath } from '../api/route-path.js';
import fastifyStatic from '@fastify/static';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import {
  issueDevice,
  authenticateDriver,
  sendOtp,
  verifyOtp,
  setDriverName,
  fleetLogin,
  signOutDevice,
  type DriverPrincipal,
} from './identity.js';
import { listStations, connectorDetail, resolveCode } from './stations.js';
import {
  quotePrepaid,
  checkoutPrepaid,
  checkoutFleet,
  confirmPayment,
  payPostpayNow,
  payUnpaid,
  unpaidSessions,
  unpaidStatus,
  confirmUnpaidPayment,
  startCharge,
  liveStatus,
  setV2xConsent,
  stopCharge,
  receipt,
  receiptDocument,
  history,
} from './charge.js';
import { listRoamingStations, startRoaming, roamingStatus, stopRoaming, roamingReceipt, roamingHistory, reserveRoaming, roamingReservation, cancelRoamingReservation, currentRoamingReservation } from './roaming.js';
import { config } from '../config.js';
import { vapid } from '../services/webpush.js';
import { listFavourites, addFavourite, removeFavourite } from './favourites.js';
import { subscribe, unsubscribe, pushStatus, subscribeApns, unsubscribeApns } from './notify.js';
import { currentReservation, reserve, cancel as cancelReservationFor, checkoutStatus as reservationCheckoutStatus, confirmCheckoutPayment, cancelCheckout } from './reservations.js';
import { myQueue, siteQueue, join as joinQueue, leave as leaveQueue } from './queue.js';
import { membershipOverview, buyPass, passStatus, confirmPassPayment, setAutoRenew } from './membership.js';
import { driverLoyalty, setAutoRedeem, LoyaltyError } from '../services/loyalty.js';
import { listCards, removeCard } from '../services/payments/cards.js';
import { linkWallet, walletLinkStatus } from './wallets.js';
import { resolve as resolveIntegration } from '../integrations/store.js';
import { readFile } from 'node:fs/promises';
import {
  brandBySlug, brandForHost, brandForOrg, palette, renderIndex, manifestFor, renderServiceWorker, iconFile, assetLinks, appleAssociation, hostnameKnown, type Brand,
} from '../services/brand.js';
import { one, many } from '../db/pool.js';
import { renderChargeCard, powerFromRegister, chargeCardAllowed } from '../services/charge-card.js';
import { registerActivity, registerStartToken, endedOnPhone } from '../services/live-activity.js';

const here = dirname(fileURLToPath(import.meta.url));

declare module 'fastify' {
  interface FastifyRequest {
    driver?: DriverPrincipal;
    /** The white-label app this request is for (its web address, or X-Driver-Brand / ?brand= for a preview). */
    brand?: Brand | null;
    brandPreview?: boolean;
  }
}

/**
 * Which operator's app a request is for. The web address of a live brand wins;
 * otherwise the app names its brand (X-Driver-Brand, or ?brand= on the page
 * itself, which is how a draft is previewed from the console). No brand: the
 * PlugSure app, across every operator.
 */
async function brandOf(req: FastifyRequest): Promise<{ brand: Brand | null; preview: boolean }> {
  const byHost = await brandForHost(String(req.headers.host ?? '')).catch(() => null);
  if (byHost) return { brand: byHost, preview: false };
  const named = String(req.headers['x-driver-brand'] ?? (req.query as Record<string, unknown> | undefined)?.brand ?? '').trim().toLowerCase();
  if (!named) return { brand: null, preview: false };
  return { brand: await brandBySlug(named).catch(() => null), preview: true };
}

/**
 * The driver-facing app and its API.
 *
 * A completely separate surface from the operator API: public browse needs no
 * auth, everything else is a device token (`psd_…`), and NONE of it enters the
 * per-request org scope — a driver legitimately reads across tenants for their
 * own charges. Mounted under /d/ (API) and /app (the web app) on the same
 * process, so deployment does not change.
 */
export async function registerDriverApi(app: FastifyInstance): Promise<void> {
  // Serve the driver web app at /app. decorateReply:false — the operator console
  // already registered the sendFile decorator on the root static plugin.
  const webRoot = join(here, '../driver-web');
  // The page, its manifest and the push worker are rendered per brand; the rest is static.
  const RENDERED = new Set(['index.html', 'manifest.webmanifest', 'sw.js']);
  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: '/app/',
    decorateReply: false,
    index: false,
    allowedPath: (path) => !RENDERED.has(path.replace(/^\/+/, '')),
  });
  const webFile = (name: string) => readFile(join(webRoot, name), 'utf8');

  app.addHook('onRequest', async (req) => {
    const p = req.url.split('?')[0]!;
    if (p.startsWith('/app') || p.startsWith('/d/') || p.startsWith('/.well-known/')) {
      const r = await brandOf(req);
      req.brand = r.brand;
      req.brandPreview = r.preview;
    }
  });

  const page = async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const html = await webFile('index.html');
    const b = req.brand;
    return reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8')
      .send(b ? renderIndex(html, b, { preview: !!req.brandPreview }) : html);
  };
  app.get('/app', async (req, reply) => reply.redirect('/app/' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), 301));
  app.get('/app/', page);
  app.get('/app/index.html', page);
  app.get('/app/manifest.webmanifest', async (req, reply) => {
    const m = manifestFor(req.brand ?? null, await webFile('manifest.webmanifest'), { preview: !!req.brandPreview });
    return reply.header('cache-control', 'no-cache').type('application/manifest+json; charset=utf-8').send(JSON.stringify(m, null, 2));
  });
  app.get('/app/sw.js', async (req, reply) => {
    const js = await webFile('sw.js');
    // A live brand's own address only: a preview shares PlugSure's origin, and so its worker.
    const b = req.brand && !req.brandPreview ? req.brand : null;
    return reply.header('cache-control', 'no-cache').header('service-worker-allowed', '/app/').type('application/javascript; charset=utf-8')
      .send(b ? renderServiceWorker(js, b) : js);
  });
  app.get('/app/brand/:slug/:file', async (req, reply) => {
    const { slug, file } = req.params as { slug: string; file: string };
    const b = await brandBySlug(slug).catch(() => null);
    const png = b ? await iconFile(b, file) : null;
    if (!png) return reply.status(404).send({ error: 'not found' });
    return reply.header('cache-control', 'public, max-age=86400').type('image/png').send(png);
  });
  // Store apps prove they belong to the brand's web address.
  app.get('/.well-known/assetlinks.json', async (req, reply) =>
    reply.header('cache-control', 'public, max-age=300').type('application/json').send(JSON.stringify(assetLinks(req.brand && !req.brandPreview ? req.brand : null))));
  app.get('/.well-known/apple-app-site-association', async (req, reply) =>
    reply.header('cache-control', 'public, max-age=300').type('application/json').send(JSON.stringify(appleAssociation(req.brand && !req.brandPreview ? req.brand : null))));
  // The picture on a "charging finished" notification: fetched by the iPhone's Notification Service
  // Extension (or the browser) without credentials, so its address is signed and expires.
  const cardCache = new Map<string, Buffer>();
  app.get('/d/n/charge/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    const q = (req.query ?? {}) as Record<string, string>;
    const m = /^([0-9a-f-]{36})\.png$/i.exec(file);
    if (!m || !chargeCardAllowed(m[1]!, q.l ?? '', q.e ?? '', q.s ?? '')) return reply.status(404).send({ error: 'not found' });
    const key = `${m[1]}:${q.l}`;
    let png = cardCache.get(key);
    if (!png) {
      const s = await one<{ org_id: string; energy_wh: string | null; started_at: Date; ended_at: Date | null }>(
        `SELECT org_id, energy_wh, started_at, ended_at FROM charging_session WHERE id = $1`, [m[1]]);
      if (!s) return reply.status(404).send({ error: 'not found' });
      const samples = await many<{ ts: Date; value: string; unit: string | null }>(
        `SELECT ts, value, unit FROM meter_value WHERE session_id = $1 AND measurand = 'Energy.Active.Import.Register' AND phase IS NULL ORDER BY ts LIMIT 2000`, [m[1]]);
      const b = await brandForOrg(s.org_id).catch(() => null);
      // The operator's accent (as used in the dark theme), else PlugSure's teal.
      const accent = b ? palette(b.accentColor, b.badgeColor).dark.accent : '#2fd6a7';
      const end = s.ended_at ?? new Date();
      png = renderChargeCard({
        energyWh: Number(s.energy_wh ?? 0),
        minutes: (new Date(end).getTime() - new Date(s.started_at).getTime()) / 60_000,
        powerW: powerFromRegister(samples.map((x) => ({ ts: new Date(x.ts), wh: Number(x.value) * (/^kwh$/i.test(x.unit ?? '') ? 1000 : 1) }))),
        lang: q.l === 'en' ? 'en' : 'id',
        accent,
      });
      if (cardCache.size > 200) cardCache.clear();
      if (s.ended_at) cardCache.set(key, png);
    }
    return reply.header('cache-control', 'private, max-age=3600').type('image/png').send(png);
  });
  // Caddy's on-demand TLS asks before issuing a certificate for an unknown name: only brands' web addresses.
  app.get('/d/tls-ask', async (req, reply) => {
    const domain = String((req.query as Record<string, unknown>)?.domain ?? '');
    return (await hostnameKnown(domain).catch(() => false)) ? { ok: true } : reply.status(404).send({ error: 'not a driver app address' });
  });

  // A device token is required for everything except issuing one and public browse.
  const PUBLIC = new Set(['/d/health', '/d/tls-ask', '/d/v1/device', '/d/v1/stations', '/d/v1/resolve', '/d/v1/meta']);
  app.addHook('preHandler', async (req, reply) => {
    // Decided on the matched route, never the raw URL (see routePath).
    const path = routePath(req);
    if (!path.startsWith('/d/v1/') && path !== '/d/health') return;
    // Public: station browse, connector detail, resolve, device issue, health.
    if (
      PUBLIC.has(path) ||
      path.startsWith('/d/v1/connectors/') ||
      /^\/d\/v1\/sites\/[^/]+\/queue$/.test(path) ||
      path === '/d/v1/stations'
    ) {
      // Still resolve a principal if one is presented (so browse can personalise),
      // but do not require it.
      req.driver = (await authenticateDriver(req.headers as Record<string, unknown>)) ?? undefined;
      return;
    }
    const principal = await authenticateDriver(req.headers as Record<string, unknown>);
    if (!principal) {
      return reply.status(401).send({ error: 'device token required', code: 'no_device' });
    }
    req.driver = principal;
  });

  // A white-label app works only with its own operator's chargers and sites.
  const brandOrg = (req: FastifyRequest) => req.brand?.orgId ?? null;
  const otherOperator = (req: FastifyRequest) => ({
    error: 'Charger ini dikelola operator lain, bukan ' + req.brand!.appName + '.', code: 'other_operator',
  });
  app.addHook('preHandler', async (req, reply) => {
    const org = brandOrg(req);
    if (!org || !routePath(req).startsWith('/d/v1/') || reply.sent) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const params = (req.params ?? {}) as Record<string, unknown>;
    const connectorId = typeof b.connectorId === 'string' ? b.connectorId : null;
    const siteId = typeof b.siteId === 'string' ? b.siteId : typeof params.siteId === 'string' ? params.siteId : null;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (connectorId && UUID.test(connectorId)) {
      const r = await one<{ org_id: string }>(
        'SELECT s.org_id FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id WHERE c.id = $1', [connectorId]);
      if (r && r.org_id !== org) return reply.status(404).send(otherOperator(req));
    }
    if (siteId && UUID.test(siteId)) {
      const r = await one<{ org_id: string }>('SELECT org_id FROM site WHERE id = $1', [siteId]);
      if (r && r.org_id !== org) return reply.status(404).send(otherOperator(req));
    }
  });

  const driver = (req: FastifyRequest): DriverPrincipal => req.driver!;

  /**
   * The chosen payment method and where the acquirer sends the driver back after
   * an e-wallet or card payment: the app's return page on the public address
   * (DRIVER_PUBLIC_URL / CONSOLE_PUBLIC_URL), else this request's own origin.
   */
  const payOptions = (req: FastifyRequest, b: Record<string, unknown>, kind: 'charge' | 'pass' | 'link' | 'settle' | 'reservation') => {
    // A live white-label app returns to its own web address.
    const own = req.brand?.hostname && !req.brandPreview ? `https://${req.brand.hostname}` : null;
    const base = (own || process.env.DRIVER_PUBLIC_URL || process.env.CONSOLE_PUBLIC_URL || `${req.protocol}://${req.headers.host ?? 'localhost'}`).replace(/\/+$/, '');
    return {
      channel: b.method ? String(b.method) : null,
      phone: b.phone ? String(b.phone).slice(0, 20) : null,
      savedCardId: b.savedCardId ? String(b.savedCardId) : null,
      saveCard: b.saveCard === true,
      walletId: b.walletId ? String(b.walletId) : null,
      returnUrl: `${base}/app/paid.html?for=${kind}`,
    };
  };

  // ───────────────────────────────────────────────────────── public browse

  app.get('/d/health', async () => ({ ok: true, service: 'driver' }));

  app.get('/d/v1/stations', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const lat = Number(q.lat);
    const lon = Number(q.lon);
    const loc = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : undefined;
    return { stations: await listStations(loc, brandOrg(req)) };
  });

  app.get('/d/v1/connectors/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = await connectorDetail(id, req.driver ?? null, brandOrg(req));
    if (detail === 'other_operator') return reply.status(404).send(otherOperator(req));
    if (!detail) return reply.status(404).send({ error: 'connector not found' });
    return detail;
  });

  app.get('/d/v1/resolve', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const conn = await resolveCode(q.code ?? '', brandOrg(req));
    if (conn === 'other_operator') return reply.status(404).send({ ...otherOperator(req), message: otherOperator(req).error });
    if (!conn) return reply.status(404).send({ error: 'not_found', message: 'Kode charger tidak dikenal.' });
    return conn;
  });

  // ───────────────────────────────────────────────────────── identity

  app.post('/d/v1/device', async (req) => {
    const ua = String(req.headers['user-agent'] ?? '');
    return issueDevice(ua);
  });

  app.get('/d/v1/me', async (req) => {
    const p = driver(req);
    return {
      deviceId: p.deviceId,
      account: p.account,
      fleet: p.fleet ? { uid: p.fleet.uid, orgId: p.fleet.orgId } : null,
    };
  });

  app.post('/d/v1/otp/send', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const r = await sendOtp(String(b.phone ?? ''), req.brand?.appName);
    if (!r.ok) return reply.status(400).send({ error: r.error });
    return r;
  });

  app.post('/d/v1/otp/verify', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const r = await verifyOtp(driver(req).deviceId, String(b.phone ?? ''), String(b.code ?? ''));
    if (!r.ok) return reply.status(400).send({ error: r.error });
    return r;
  });

  app.post('/d/v1/account/name', async (req, reply) => {
    const p = driver(req);
    if (!p.appDriverId) return reply.status(400).send({ error: 'Belum masuk akun.' });
    await setDriverName(p.appDriverId, String((req.body as any)?.name ?? ''));
    return { ok: true };
  });

  app.post('/d/v1/fleet/login', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const r = await fleetLogin(driver(req).deviceId, String(b.orgSlug ?? ''), String(b.rfidUid ?? ''), String(b.pin ?? ''));
    if (!r.ok) return reply.status(400).send({ error: r.error });
    return r;
  });

  app.post('/d/v1/signout', async (req) => {
    await signOutDevice(driver(req).deviceId);
    return { ok: true };
  });

  // ───────────────────────────────────────────────────────── charge

  app.post('/d/v1/charge/quote', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const r = await quotePrepaid(String(b.connectorId ?? ''), Number(b.amountIdr), { principal: req.driver ?? null, promoCode: b.promoCode ? String(b.promoCode) : null });
    if (!r.ok) return reply.status(422).send(r);
    return r;
  });

  app.post('/d/v1/charge/prepaid', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const r = await checkoutPrepaid(driver(req), String(b.connectorId ?? ''), Number(b.amountIdr), b.promoCode ? String(b.promoCode) : null, payOptions(req, b, 'charge'));
    if (!r.ok) return reply.status(422).send(r);
    return r;
  });

  app.post('/d/v1/charge/fleet', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const r = await checkoutFleet(driver(req), String(b.connectorId ?? ''));
    if (!r.ok) return reply.status(422).send(r);
    return r;
  });

  app.post('/d/v1/charge/:id/confirm-payment', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await confirmPayment(driver(req), id);
    if (!r.ok) return reply.status(400).send(r);
    return r;
  });

  // Post-pay: pay an unpaid session now (charged again, or the e-wallet's confirmation link).
  app.post('/d/v1/charge/:id/pay-now', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await payPostpayNow(driver(req), id);
    if (!r.ok) return reply.status(409).send(r);
    return r;
  });

  // Unpaid sessions payable in the app, for the home screen's notice.
  app.get('/d/v1/unpaid', async (req) => ({ unpaid: await unpaidSessions(driver(req)) }));

  // An unpaid session (a card hold that expired, or post-pay whose e-wallet link ended): the driver pays
  // what it cost in the app, with any method the operator offers. /pay-expired is the earlier name.
  for (const name of ['pay-unpaid', 'pay-expired']) {
    app.post(`/d/v1/charge/:id/${name}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const r = await payUnpaid(driver(req), id, payOptions(req, (req.body ?? {}) as Record<string, unknown>, 'settle'));
      if (!r.ok) return reply.status(r.status).send({ ok: false, error: r.error, ...(r.code ? { code: r.code } : {}) });
      return r;
    });
    app.get(`/d/v1/charge/:id/${name}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const r = await unpaidStatus(driver(req), id);
      if (!r) return reply.status(404).send({ error: 'Tidak ada tagihan yang perlu dibayar untuk sesi ini.' });
      return r;
    });
    app.post(`/d/v1/charge/:id/${name}/confirm-payment`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const r = await confirmUnpaidPayment(driver(req), id);
      if (!r.ok) return reply.status(r.error === 'Not available in production.' ? 403 : 404).send(r);
      return r;
    });
  }

  app.post('/d/v1/charge/:id/start', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await startCharge(driver(req), id);
    if (!r.ok) return reply.status(400).send(r);
    return r;
  });

  app.get('/d/v1/charge/:id/status', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = await liveStatus(driver(req), id);
    if (!s) return reply.status(404).send({ error: 'not_found' });
    return s;
  });

  // Bidirectional charging: the driver agrees (or no longer agrees) to give energy back during this charge.
  app.post('/d/v1/charge/:id/v2x', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { enabled?: unknown; minSocPercent?: unknown };
    if (typeof b.enabled !== 'boolean') return reply.status(400).send({ ok: false, error: 'enabled harus true atau false.' });
    const soc = b.minSocPercent === undefined || b.minSocPercent === null ? null : Number(b.minSocPercent);
    const r = await setV2xConsent(driver(req), id, b.enabled, soc);
    if (!r.ok) return reply.status(r.status).send(r);
    return r;
  });

  app.post('/d/v1/charge/:id/stop', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await stopCharge(driver(req), id);
    if (!r.ok) return reply.status(400).send(r);
    return r;
  });

  app.get('/d/v1/charge/:id/receipt', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await receipt(driver(req), id);
    if (!r) return reply.status(404).send({ error: 'not_found' });
    return r;
  });

  // The receipts' Print button, as a same-origin script: pages carry no inline script (src/api/csp.ts).
  // Under /d/ so it is served on white-label hosts too; public, like the receipt page's assets.
  app.get('/d/print.js', async (_req, reply) => reply
    .header('cache-control', 'public, max-age=86400')
    .type('application/javascript; charset=utf-8')
    .send("document.addEventListener('click',function(e){var t=e.target;if(t&&t.closest&&t.closest('[data-print]'))window.print();});\n"));

  app.get('/d/v1/charge/:id/receipt.html', async (req, reply) => {
    const { id } = req.params as { id: string };
    const html = await receiptDocument(driver(req), id);
    if (!html) return reply.status(404).send({ error: 'not_found' });
    return reply
      .header('cache-control', 'no-store')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'self'")
      .type('text/html; charset=utf-8')
      .send(html);
  });

  app.get('/d/v1/history', async (req) => {
    const own = await history(driver(req), 40, brandOrg(req));
    const roam = await roamingHistory(driver(req));
    const charges = [...own, ...roam].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { charges };
  });

  // ───────────────────────────────────────────────────────── app settings (map, push, reservations)

  app.get('/d/v1/meta', async () => {
    let publicKey: string | null = null;
    try { publicKey = (await vapid()).publicKey; } catch { /* push unavailable */ }
    // Govern → Integrations → Map tiles, else MAP_TILE_URL.
    const tiles = await resolveIntegration('map_tiles').catch(() => null);
    return {
      map: {
        tileUrl: String(tiles?.settings.tileUrl ?? config.driverApp.mapTileUrl),
        attribution: String(tiles?.settings.attribution ?? config.driverApp.mapAttribution),
        maxZoom: Number(tiles?.settings.maxZoom ?? 19) || 19,
      },
      push: { publicKey },
      reservations: { enabled: config.driverApp.reservationsEnabled, minutes: config.driverApp.reservationMinutes },
    };
  });

  // ───────────────────────────────────────────────────────── favourites

  app.get('/d/v1/favourites', async (req) => ({ favourites: await listFavourites(driver(req)) }));
  app.post('/d/v1/favourites', async (req, reply) => {
    const r = await addFavourite(driver(req), req.body ?? {});
    if (!r.ok) return reply.status(422).send(r);
    return r;
  });
  app.delete('/d/v1/favourites/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return (await removeFavourite(driver(req), id)) ? { ok: true } : reply.status(404).send({ error: 'not_found' });
  });

  // ───────────────────────────────────────────────────────── push notifications

  app.get('/d/v1/push', async (req) => pushStatus(driver(req).deviceId));
  app.post('/d/v1/push/subscribe', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = await subscribe(driver(req).deviceId, b.subscription, String(b.lang ?? 'id'));
    if (!r.ok) return reply.status(422).send(r);
    return r;
  });
  app.post('/d/v1/push/unsubscribe', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    await unsubscribe(driver(req).deviceId, String(b.endpoint ?? ''));
    return { ok: true };
  });
  // The white-label iOS app: native notifications through the brand's APNs key.
  app.post('/d/v1/push/apns', async (req, reply) => {
    if (!req.brand) return reply.status(409).send({ ok: false, error: 'Notifikasi iOS hanya untuk aplikasi operator.' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = await subscribeApns(driver(req).deviceId, req.brand.orgId, b.token, String(b.lang ?? 'id'));
    if (!r.ok) return reply.status(422).send(r);
    return r;
  });
  // iOS Live Activities: the activity's update token (ref = the charge, or the session for one started by push),
  // the app's push-to-start token (iOS 17.2+), and "closed on the phone".
  app.post('/d/v1/live-activities', async (req, reply) => {
    if (!req.brand) return reply.status(409).send({ ok: false, error: 'Live Activity hanya untuk aplikasi operator.' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = await registerActivity(driver(req).deviceId, req.brand.orgId, b.ref, b.token);
    return r.ok ? r : reply.status(422).send(r);
  });
  app.post('/d/v1/live-activities/start-token', async (req, reply) => {
    if (!req.brand) return reply.status(409).send({ ok: false, error: 'Live Activity hanya untuk aplikasi operator.' });
    const r = await registerStartToken(driver(req).deviceId, req.brand.orgId, ((req.body ?? {}) as Record<string, unknown>).token);
    return r.ok ? r : reply.status(422).send(r);
  });
  app.post('/d/v1/live-activities/ended', async (req) => {
    await endedOnPhone(driver(req).deviceId, ((req.body ?? {}) as Record<string, unknown>).ref);
    return { ok: true };
  });
  app.post('/d/v1/push/apns/remove', async (req, reply) => {
    if (!req.brand) return reply.status(409).send({ ok: false, error: 'Notifikasi iOS hanya untuk aplikasi operator.' });
    await unsubscribeApns(driver(req).deviceId, req.brand.orgId, ((req.body ?? {}) as Record<string, unknown>).token);
    return { ok: true };
  });

  // ───────────────────────────────────────────────────────── saved cards (the acquirer's tokens; never card numbers)

  app.get('/d/v1/cards', async (req) => {
    const p = driver(req);
    return { cards: p.appDriverId ? await listCards(p.appDriverId) : [], signedIn: !!p.appDriverId };
  });
  app.delete('/d/v1/cards/:id', async (req, reply) => {
    const p = driver(req);
    const { id } = req.params as { id: string };
    if (!p.appDriverId) return reply.status(401).send({ error: 'Masuk dengan nomor HP terlebih dahulu.' });
    return (await removeCard(p.appDriverId, id)) ? { ok: true } : reply.status(404).send({ error: 'Kartu tidak ditemukan.' });
  });

  // Linked e-wallets (GoPay, OVO, DANA): link once at a charger or a pass, then pay in one tap.
  app.post('/d/v1/wallets', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = await linkWallet(driver(req), { connectorId: b.connectorId ? String(b.connectorId) : null, planId: b.planId ? String(b.planId) : null, channel: String(b.channel ?? ''), phone: b.phone ? String(b.phone).slice(0, 20) : null }, payOptions(req, b, 'link').returnUrl);
    if (!r.ok) return reply.status(r.status).send({ error: r.error });
    return r;
  });
  app.get('/d/v1/wallets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await walletLinkStatus(driver(req), id);
    return r ?? reply.status(404).send({ error: 'E-wallet tidak ditemukan.' });
  });

  // ───────────────────────────────────────────────────────── memberships (30-day passes: buy, renew, switch, auto-renew)

  app.get('/d/v1/memberships', async (req) => membershipOverview(driver(req)));
  app.post('/d/v1/memberships', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = await buyPass(driver(req), String(b.planId ?? ''), { ...payOptions(req, b, 'pass'), autoRenew: b.autoRenew === true });
    if (!r.ok) return reply.status(422).send(r);
    return r;
  });
  app.put('/d/v1/memberships/:id/auto-renew', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await setAutoRenew(driver(req), id, (req.body ?? {}) as { enabled?: unknown; methodId?: unknown });
    if (!r.ok) return reply.status(r.status).send({ error: r.error });
    return r;
  });

  // ───────────────────────────────────────────────────────── loyalty points (per operator)

  app.get('/d/v1/loyalty', async (req, reply) => {
    const p = driver(req);
    if (!p.appDriverId) return reply.status(401).send({ error: 'Masuk dengan nomor HP untuk melihat poin Anda.' });
    return driverLoyalty(p.appDriverId);
  });
  app.put('/d/v1/loyalty/:orgId', async (req, reply) => {
    const p = driver(req);
    if (!p.appDriverId) return reply.status(401).send({ error: 'Masuk dengan nomor HP untuk memakai poin.' });
    const { orgId } = req.params as { orgId: string };
    try {
      return await setAutoRedeem(p.appDriverId, orgId, (req.body as { autoRedeem?: unknown } | undefined)?.autoRedeem === true);
    } catch (e) {
      if (e instanceof LoyaltyError) return reply.status(e.status).send({ error: e.message });
      throw e;
    }
  });
  app.get('/d/v1/memberships/charges/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await passStatus(driver(req), id);
    return r ?? reply.status(404).send({ error: 'Transaksi tidak ditemukan.' });
  });
  app.post('/d/v1/memberships/charges/:id/confirm-payment', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await confirmPassPayment(driver(req), id);
    if (!r.ok) return reply.status(r.error === 'Not available in production.' ? 403 : 404).send(r);
    return r;
  });

  // ───────────────────────────────────────────────────────── reservations

  // The driver's live reservation: at a PlugSure charger (or a queue offer), and on a partner network.
  app.get('/d/v1/reservation', async (req) => ({ reservation: await currentReservation(driver(req)), partner: await currentRoamingReservation(driver(req)) }));
  app.post('/d/v1/reservations', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    // A reservation fee is paid first (payment options as for a charge); free reservations hold at once.
    const r = await reserve(driver(req), String(b.connectorId ?? ''), payOptions(req, b, 'reservation'));
    if (!r.ok) return reply.status(422).send(r);
    return r;
  });
  // Paying a reservation fee: where it stands (the connector is held once paid), the mock payment, giving up.
  app.get('/d/v1/reservations/checkout/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = await reservationCheckoutStatus(driver(req), id);
    return s ?? reply.status(404).send({ error: 'Transaksi tidak ditemukan.' });
  });
  app.post('/d/v1/reservations/checkout/:id/confirm-payment', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await confirmCheckoutPayment(driver(req), id);
    if (!r.ok) return reply.status(r.error === 'Not available in production.' ? 403 : 422).send(r);
    return r;
  });
  app.post('/d/v1/reservations/checkout/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    return (await cancelCheckout(driver(req), id)) ? { ok: true } : reply.status(404).send({ error: 'Transaksi tidak ditemukan.' });
  });
  app.post('/d/v1/reservations/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await cancelReservationFor(driver(req), id);
    if (!r.ok) return reply.status(404).send(r);
    return r;
  });

  // ───────────────────────────────────────────────────────── site queues (waitlist)

  app.get('/d/v1/queue', async (req) => myQueue(driver(req)));
  app.get('/d/v1/sites/:siteId/queue', async (req, reply) => {
    const { siteId } = req.params as { siteId: string };
    const q = await siteQueue(siteId, req.driver ?? null);
    return q ?? reply.status(404).send({ error: 'Lokasi tidak ditemukan.' });
  });
  app.post('/d/v1/queue', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = await joinQueue(driver(req), String(b.siteId ?? ''), { current: b.current, type: b.type });
    if (!r.ok) return reply.status(422).send(r);
    return r;
  });
  app.post('/d/v1/queue/:id/leave', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await leaveQueue(driver(req), id);
    if (!r.ok) return reply.status(404).send(r);
    return r;
  });

  // ───────────────────────────────────────────────────────── roaming (fleet cards on partner networks)

  const ocpiBase = (req: FastifyRequest) =>
    config.ocpi.publicUrl || `${req.protocol}://${String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '127.0.0.1')}`;

  app.get('/d/v1/roaming/stations', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const lat = Number(q.lat);
    const lon = Number(q.lon);
    return listRoamingStations(driver(req), Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : undefined);
  });

  app.post('/d/v1/roaming/charge', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).slice(0, 64) : '');
    if (!s('partnerId') || !s('locationId') || !s('evseUid')) return reply.status(400).send({ error: 'Pilih charger terlebih dahulu.' });
    const r = await startRoaming(driver(req), {
      partnerId: s('partnerId'), countryCode: s('countryCode'), partyId: s('partyId'), locationId: s('locationId'),
      evseUid: s('evseUid'), connectorId: s('connectorId') || undefined,
    }, ocpiBase(req));
    if (!r.ok) return reply.status(422).send(r);
    return r;
  });

  // Reserving a partner operator's charger (OCPI RESERVE_NOW / CANCEL_RESERVATION).
  app.post('/d/v1/roaming/reservations', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).slice(0, 64) : '');
    if (!s('partnerId') || !s('locationId') || !s('evseUid')) return reply.status(400).send({ error: 'Pilih charger terlebih dahulu.' });
    const r = await reserveRoaming(driver(req), {
      partnerId: s('partnerId'), countryCode: s('countryCode'), partyId: s('partyId'), locationId: s('locationId'), evseUid: s('evseUid'),
    }, ocpiBase(req));
    if (!r.ok) return reply.status(422).send(r);
    return r;
  });
  app.get('/d/v1/roaming/reservations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await roamingReservation(driver(req), id);
    return r ? { reservation: r } : reply.status(404).send({ error: 'Reservasi tidak ditemukan.' });
  });
  app.post('/d/v1/roaming/reservations/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await cancelRoamingReservation(driver(req), id, ocpiBase(req));
    if (!r.ok) return reply.status(404).send(r);
    return r;
  });
  app.get('/d/v1/roaming/charge/:id/status', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = await roamingStatus(driver(req), id);
    if (!s) return reply.status(404).send({ error: 'not_found' });
    return s;
  });

  app.post('/d/v1/roaming/charge/:id/stop', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await stopRoaming(driver(req), id, ocpiBase(req));
    if (!r.ok) return reply.status(400).send(r);
    return r;
  });

  app.get('/d/v1/roaming/cdr/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await roamingReceipt(driver(req), id);
    if (!r) return reply.status(404).send({ error: 'not_found' });
    return r;
  });

  logger.info('driver API mounted at /d, app at /app');
}
