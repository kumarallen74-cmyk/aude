import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { limitParam, offsetParam } from './paging.js';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { replanSite } from '../services/sessions.js';
import { one, many, query, afterResponse, outsideRequestScope, withOrg } from '../db/pool.js';
import * as registry from '../ocpp/registry.js';
import * as commands from '../ocpp/commands.js';
import { bridgeEnabledOnApi } from '../ocpp/bridge.js';
import {
  CONFIG_CATALOG,
  CONFIG_CATEGORIES,
  catalogEntry,
  validateConfigValue,
} from '../ocpp/config-catalog.js';
import { type Permission, CONSOLE_ROLES, assertCan, assertCanAny, can, heldPermissions, visibleSiteIds } from '../services/authz.js';
import { revokeSession, SESSION_COOKIE, sessionFromCookie } from '../services/auth.js';
import { writeAudit } from '../services/audit.js';
import * as users from '../services/users.js';
import * as sites from '../services/sites.js';
import * as cps from '../services/chargepoints.js';
import * as tokens from '../services/tokens.js';
import * as firmware from '../services/firmware.js';
import { refuseHttpsUrl } from '../services/net-guard.js';
import { syncOrg as syncRoaming } from '../ocpi/push.js';
import * as diagnostics from '../services/diagnostics.js';
import { saveStream, safeFileName, TooLargeError } from '../services/storage.js';
import { issueClientCertificate, vaultConfigured, describePem } from '../services/vault-pki.js';
import { issueAtOnboarding, caInfo, CertificateError } from '../services/charger-ca.js';
import { setClientCertFingerprint, issueAuthorizationKey, providedKeyProblem } from '../services/chargepoint-keys.js';
import { searchSessions, sessionsCsv, receiptHtml, protectDriverData, PAYMENT_STATUSES, type SessionFilter } from '../services/session-query.js';
import { archiveTariff, unassignTariff, assignTariff } from '../services/tariff-store.js';
import { runControlLoop, loadSiteBudget } from '../services/smartcharging.js';
import { effectivePpnRateBps } from '../services/tax.js';
import { ALL_SCHEMES } from '../domain/spklu.js';
import { orgOfSession } from '../services/auth.js';
import * as refunds from '../services/refunds.js';
import { holdsOverview, retryHold } from '../services/payments/holds.js';
import * as uptime from '../services/uptime.js';
import * as webhooks from '../services/webhooks.js';
import * as routing from '../services/alert-routing.js';
import * as onCall from '../services/on-call.js';
import * as dm from '../services/device-model.js';
import * as driverQueue from '../driver/queue.js';
import * as commission from '../services/commission.js';
import * as owners from '../services/owners.js';
import { ALERT_KINDS } from '../services/alert-format.js';

/**
 * API surface of the enterprise operator console (SPEC-UI-CSMS-2026-FINAL).
 *
 * Every route here follows the rules server.ts established: authentication is
 * global (the preHandler), the owning organisation of every raw identifier is
 * resolved and checked (ownedChargePoint / ownedSite), every write is audited,
 * and the request runs inside the org-scoped RLS transaction.
 */

type Owner = { orgId: string; siteId: string; chargePointId: string };

export interface RouteHelpers {
  ownedChargePoint(req: FastifyRequest, identity: string, permission: Permission): Promise<Owner>;
  ownedSite(req: FastifyRequest, siteId: string, permission: Permission): Promise<{ orgId: string }>;
  actorOf(req: FastifyRequest): { type: 'user'; id: string; orgId: string; ip: string };
  NotFoundError: new (message: string) => Error;
  BadRequestError: new (message: string) => Error;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The origin a charger or browser used to reach us, for URLs we hand out. */
export function requestOrigin(req: FastifyRequest): string {
  return `${req.protocol}://${req.headers.host ?? 'localhost'}`;
}

/** The OCPP URL (without identity) chargers are configured with. */
function ocppBaseUrl(req: FastifyRequest): string {
  if (config.console.ocppPublicUrl) return config.console.ocppPublicUrl;
  const host = String(req.headers.host ?? 'localhost').replace(/:\d+$/, '');
  return `${req.protocol === 'https' ? 'wss' : 'ws'}://${host}${config.gateway.path}`;
}

/**
 * The commissioning export for a field technician: the configuration a charger
 * needs, as JSON and as a QR code for vendor commissioning apps. Carries the
 * AuthorizationKey when one was just issued — it is never retrievable later.
 */
export async function commissioningBundle(req: FastifyRequest, identity: string, securityProfile: number, key?: string) {
  const cfg = {
    format: 'plugsure-commissioning/1',
    chargePointId: identity,
    centralSystemUrl: `${ocppBaseUrl(req)}/${identity}`,
    ocppVersions: config.gateway.supportedVersions,
    securityProfile,
    ...(key ? { basicAuth: { username: identity, password: key } } : {}),
    heartbeatIntervalS: config.gateway.heartbeatIntervalS,
    generatedAt: new Date().toISOString(),
  };
  const json = JSON.stringify(cfg, null, 2);
  const qrDataUrl = await QRCode.toDataURL(JSON.stringify(cfg), { errorCorrectionLevel: 'M', margin: 1, width: 320 });
  return { config: cfg, json, qrDataUrl };
}

function setSessionCookie(reply: FastifyReply, token: string | null) {
  const parts = [
    `${SESSION_COOKIE}=${token ? encodeURIComponent(token) : ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    token ? 'Max-Age=43200' : 'Max-Age=0',
  ];
  if (config.console.cookieSecure) parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
}

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));

export async function registerConsoleRoutes(app: FastifyInstance, h: RouteHelpers): Promise<void> {
  const { ownedChargePoint, ownedSite, actorOf, NotFoundError, BadRequestError } = h;

  const audit = (req: FastifyRequest, action: string, targetType: string, targetId: string, after?: Record<string, unknown> | null, before?: Record<string, unknown> | null) =>
    writeAudit({
      orgId: req.principal.orgId,
      actorType: 'user',
      actorId: req.principal.userId,
      action,
      targetType,
      targetId,
      before: before ?? null,
      after: after ?? null,
      ip: req.ip,
    });

  const clientError = (reply: FastifyReply, status: number, error: string, extra: Record<string, unknown> = {}) =>
    reply.status(status).send({ error, ...extra });

  // =================================================================== auth

  app.post('/v1/auth/login', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const r = await users.login(b.email, b.password, req.ip);
    if (!r.ok || !r.token) {
      await writeAudit({
        orgId: null,
        actorType: 'user',
        actorId: null,
        action: 'auth.login_failed',
        targetType: 'user',
        targetId: String(b.email ?? '').slice(0, 200).toLowerCase(),
        ip: req.ip,
      }).catch(() => {});
      return clientError(reply, 401, r.error ?? 'invalid email or password');
    }
    setSessionCookie(reply, r.token);
    await writeAudit({
      orgId: r.user!.orgId,
      actorType: 'user',
      actorId: r.user!.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: r.user!.id,
      ip: req.ip,
    });
    return { ok: true, user: { id: r.user!.id, name: r.user!.name, email: r.user!.email }, mustChangePassword: r.mustChangePassword };
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const token = sessionFromCookie(req.headers.cookie);
    if (token) await revokeSession(token);
    setSessionCookie(reply, null);
    return { ok: true };
  });

  app.get('/v1/auth/me', async (req) => {
    const p = req.principal;
    const user = UUID_RE.test(p.userId)
      ? await one<any>(
          `SELECT u.id, u.name, u.email, u.must_change_password, o.name AS org_name, o.pkp, o.npwp
             FROM app_user u JOIN organisation o ON o.id = u.org_id WHERE u.id = $1`,
          [p.userId],
        )
      : null;
    const org = user ? null : await one<any>(`SELECT name AS org_name, pkp, npwp FROM organisation WHERE id = $1`, [p.orgId]);
    const roles = UUID_RE.test(p.userId)
      ? await many<{ name: string; scope_type: string; scope_id: string | null }>(
          `SELECT r.name, ur.scope_type, ur.scope_id FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = $1`,
          [p.userId],
        )
      : [];
    return {
      user: user ? { id: user.id, name: user.name, email: user.email, mustChangePassword: user.must_change_password } : { id: p.userId, name: p.userId.startsWith('apikey:') ? 'API key' : 'Developer', email: null },
      org: { id: p.orgId, name: user?.org_name ?? org?.org_name, pkp: user?.pkp ?? org?.pkp, npwp: user?.npwp ?? org?.npwp },
      roles: roles.map((r) => ({ ...r, label: CONSOLE_ROLES.find((c) => c.name === r.name)?.label ?? r.name })),
      permissions: [...heldPermissions(p)],
      visibleSites: visibleSiteIds(p, 'site:read'),
      // Site Owner portal: the console shows only the owner-portal pages.
      owners: p.ownerIds?.length
        ? await many(`SELECT id, name, legal_name FROM site_owner WHERE id = ANY($1::uuid[]) AND org_id = $2`, [p.ownerIds, p.orgId])
        : [],
      // Fleet customer portal: the console shows only the fleet-portal page.
      fleets: p.fleetAccountIds?.length
        ? await many(`SELECT id, name, legal_name FROM fleet_account WHERE id = ANY($1::uuid[]) AND org_id = $2 ORDER BY name`, [p.fleetAccountIds, p.orgId])
        : [],
      features: {
        vault: vaultConfigured(),
        bridge: bridgeEnabledOnApi(),
        publicBaseUrl: config.console.publicBaseUrl || null,
        ocppPublicUrl: config.console.ocppPublicUrl || null,
        supportedVersions: config.gateway.supportedVersions,
        minSecurityProfile: config.gateway.minSecurityProfile,
        effectivePpnPct: effectivePpnRateBps() / 100,
        wbp: { start: config.tou.wbpStart, end: config.tou.wbpEnd },
        env: config.env,
      },
    };
  });

  app.post('/v1/auth/change-password', async (req, reply) => {
    if (!UUID_RE.test(req.principal.userId)) return clientError(reply, 400, 'only a signed-in operator can change a password');
    const b = (req.body ?? {}) as any;
    const err = await users.changePassword(req.principal.userId, b.current, b.next);
    if (err) return clientError(reply, 400, err);
    await audit(req, 'auth.password_changed', 'user', req.principal.userId);
    return { ok: true };
  });

  // =================================================================== reference data

  app.get('/v1/meta', async () => ({
    plnTariffGroups: sites.PLN_TARIFF_GROUPS,
    spkluSchemes: ALL_SCHEMES,
    connectorTypes: cps.CONNECTOR_TYPES,
    vendors: cps.VENDORS,
    accountTypes: tokens.ACCOUNT_TYPES,
    configCategories: CONFIG_CATEGORIES,
    firmwareStages: firmware.STAGES,
    consoleRoles: CONSOLE_ROLES,
    paymentStatuses: PAYMENT_STATUSES,
    trTmCliffKva: sites.TR_TM_CLIFF_KVA,
    regulatory: {
      serviceFeeCeilingIdr: config.regulatory.serviceFeeCeilingIdr,
      energyCeilingIdrPerKwh: config.regulatory.layananKhususBase * config.regulatory.layananKhususNMax,
      layananKhususBase: config.regulatory.layananKhususBase,
      layananKhususNMax: config.regulatory.layananKhususNMax,
      idleFeeCapIdr: config.regulatory.idleFeeCapIdr,
      pbjtMaxBps: config.regulatory.pbjtMaxBps,
    },
  }));

  // =================================================================== dashboard

  app.get('/v1/dashboard', async (req) => {
    assertCanAny(req.principal, 'charge_point:read');
    const orgId = req.principal.orgId;
    const visible = visibleSiteIds(req.principal, 'charge_point:read');
    const fleet = await many<{ ocpp_identity: string; status: string }>(
      `SELECT cp.ocpp_identity, cp.status FROM charge_point cp JOIN site s ON s.id = cp.site_id
        WHERE s.org_id = $1 AND ($2::uuid[] IS NULL OR s.id = ANY($2)) AND cp.status <> 'decommissioned'`,
      [orgId, visible],
    );
    const connectors = await many<{ status: string; n: number }>(
      `SELECT c.status, count(*)::int AS n FROM connector c JOIN evse e ON e.id = c.evse_uuid
         JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id
        WHERE s.org_id = $1 AND ($2::uuid[] IS NULL OR s.id = ANY($2)) AND cp.status <> 'decommissioned'
        GROUP BY c.status`,
      [orgId, visible],
    );
    // Money is shown to anyone who may read sessions, over the sites they may see
    // (a Site Owner sees its own revenue; the queries below filter by sessVisible).
    const canMoney = heldPermissions(req.principal).has('session:read');
    const sessVisible = visibleSiteIds(req.principal, 'session:read');
    const today = canMoney
      ? await one<any>(
          `SELECT count(*)::int AS sessions, COALESCE(sum(cs.energy_wh),0)::bigint AS energy_wh,
                  COALESCE(sum(d.total_idr),0)::bigint AS revenue_idr,
                  count(*) FILTER (WHERE cs.state = 'active')::int AS active
             FROM charging_session cs LEFT JOIN cdr d ON d.session_id = cs.id
            WHERE cs.org_id = $1 AND ($2::uuid[] IS NULL OR cs.site_id = ANY($2))
              AND cs.started_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta'`,
          [orgId, sessVisible],
        )
      : null;
    const series = canMoney
      ? await many<any>(
          `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                  COALESCE(sum(x.energy_wh),0)::bigint AS energy_wh, COALESCE(sum(x.total_idr),0)::bigint AS revenue_idr,
                  count(x.id)::int AS sessions
             FROM generate_series((now() AT TIME ZONE 'Asia/Jakarta')::date - 13, (now() AT TIME ZONE 'Asia/Jakarta')::date, '1 day') AS d(day)
             LEFT JOIN (
               SELECT cs.id, cs.energy_wh, cdr.total_idr, (cs.started_at AT TIME ZONE 'Asia/Jakarta')::date AS day
                 FROM charging_session cs LEFT JOIN cdr ON cdr.session_id = cs.id
                WHERE cs.org_id = $1 AND ($2::uuid[] IS NULL OR cs.site_id = ANY($2))
                  AND cs.started_at >= now() - interval '15 days'
             ) x ON x.day = d.day
            GROUP BY d.day ORDER BY d.day`,
          [orgId, sessVisible],
        )
      : [];
    // Alerts record their site (migration 012): a site-scoped user counts only its own.
    const alerts = await one<{ critical: number; warning: number }>(
      `SELECT count(*) FILTER (WHERE severity = 'critical')::int AS critical,
              count(*) FILTER (WHERE severity = 'warning')::int AS warning
         FROM alert WHERE org_id = $1 AND resolved_at IS NULL AND raised_at > now() - interval '7 days'
          AND ($2::uuid[] IS NULL OR site_id = ANY($2))`,
      [orgId, visible],
    );
    const online = fleet.filter((f) => registry.isOnline(f.ocpp_identity)).length;
    return {
      chargers: {
        total: fleet.length,
        online,
        pending: fleet.filter((f) => f.status === 'pending_adoption').length,
        faulted: fleet.filter((f) => f.status === 'faulted').length,
      },
      connectors: Object.fromEntries(connectors.map((c) => [c.status, c.n])),
      today,
      series,
      alerts,
    };
  });

  // =================================================================== refunds
  // Money owed back to prepaid drivers. Reading is finance-visible; paying out is
  // payment:write (Super Admin, CPO Operations Manager, Finance).

  const actorUuid = (req: FastifyRequest) => (UUID_RE.test(String(req.principal.userId)) ? req.principal.userId : null);

  app.get('/v1/refunds', async (req) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    const [summary, rows] = await Promise.all([refunds.refundSummary(req.principal.orgId), refunds.listRefunds(req.principal.orgId, q.state)]);
    return { summary, rows };
  });

  app.post('/v1/refunds/:id/process', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw new NotFoundError('payment not found');
    const owner = await one(`SELECT id FROM payment_intent WHERE id = $1 AND org_id = $2`, [id, req.principal.orgId]);
    if (!owner) throw new NotFoundError('payment not found');
    const r = await refunds.processRefund(id, actorUuid(req));
    await audit(req, r.ok ? 'refund.processed' : 'refund.failed', 'payment_intent', id, { ...r });
    if (!r.ok) return clientError(reply, 409, r.error ?? 'refund failed', { state: r.state });
    return r;
  });

  app.post('/v1/refunds/:id/mark-refunded', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw new NotFoundError('payment not found');
    const owner = await one(`SELECT id FROM payment_intent WHERE id = $1 AND org_id = $2`, [id, req.principal.orgId]);
    if (!owner) throw new NotFoundError('payment not found');
    const reference = String((req.body as any)?.reference ?? '');
    const r = await refunds.markRefundedManually(id, reference, actorUuid(req));
    if (!r.ok) return clientError(reply, 400, r.error ?? 'could not record the refund', { state: r.state });
    await audit(req, 'refund.recorded_manual', 'payment_intent', id, { reference: r.refundRef });
    return r;
  });

  // Card holds (pre-authorisation): captured for what the session cost, released when unused.
  app.get('/v1/card-holds', async (req) => {
    assertCan(req.principal, { permission: 'payment:read' });
    return holdsOverview(req.principal.orgId);
  });

  app.post('/v1/card-holds/:id/retry', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw new NotFoundError('card hold not found');
    const r = await retryHold(req.principal.orgId, id);
    if (!r) throw new NotFoundError('no failed or pending capture / release for this payment');
    await audit(req, r.ok ? 'card_hold.retried' : 'card_hold.retry_failed', 'payment_intent', id, { ...r });
    if (!r.ok) return clientError(reply, 409, r.error ?? 'the acquirer refused', { state: r.state });
    return r;
  });

  // =================================================================== availability report
  // Uptime and utilisation per charger — the first numbers a site host, a PLN
  // partner or an SLA asks for. Site-scoped users see only their sites.
  app.get('/v1/reports/availability', async (req) => {
    assertCanAny(req.principal, 'charge_point:read');
    const q = (req.query ?? {}) as Record<string, string>;
    let sitesFilter = visibleSiteIds(req.principal, 'charge_point:read');
    if (q.siteId && UUID_RE.test(q.siteId)) sitesFilter = sitesFilter ? sitesFilter.filter((s) => s === q.siteId) : [q.siteId];
    return uptime.availabilityReport(req.principal.orgId, Number(q.days ?? 30), sitesFilter);
  });

  // =================================================================== webhooks
  // Outbound, signed, retried event delivery (services/webhooks.ts). The signing
  // secret is returned once, on create and on rotate, and never again.
  const whId = (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw new NotFoundError('webhook not found');
    return id;
  };

  app.get('/v1/webhooks', async (req) => {
    assertCan(req.principal, { permission: 'webhook:read' });
    return { events: webhooks.WEBHOOK_EVENTS, rows: await webhooks.listEndpoints(req.principal.orgId) };
  });

  app.post('/v1/webhooks', async (req, reply) => {
    assertCan(req.principal, { permission: 'webhook:write' });
    const r = await webhooks.createEndpoint(req.principal.orgId, (req.body ?? {}) as any);
    if ('error' in r) return clientError(reply, 400, r.error!);
    await audit(req, 'webhook.created', 'webhook_endpoint', (r.endpoint as any).id, { url: (r.endpoint as any).url, events: (r.endpoint as any).events });
    return reply.code(201).send(r);
  });

  app.patch('/v1/webhooks/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'webhook:write' });
    const id = whId(req);
    const r = await webhooks.updateEndpoint(req.principal.orgId, id, (req.body ?? {}) as any);
    if ('error' in r) return r.error === 'not found' ? clientError(reply, 404, 'webhook not found') : clientError(reply, 400, r.error!);
    await audit(req, 'webhook.updated', 'webhook_endpoint', id, (req.body ?? {}) as Record<string, unknown>);
    return r;
  });

  app.delete('/v1/webhooks/:id', async (req) => {
    assertCan(req.principal, { permission: 'webhook:write' });
    const id = whId(req);
    if (!(await webhooks.deleteEndpoint(req.principal.orgId, id))) throw new NotFoundError('webhook not found');
    await audit(req, 'webhook.deleted', 'webhook_endpoint', id);
    return { ok: true };
  });

  app.post('/v1/webhooks/:id/rotate-secret', async (req, reply) => {
    assertCan(req.principal, { permission: 'webhook:write' });
    const id = whId(req);
    const r = await webhooks.rotateSecret(req.principal.orgId, id);
    if ('error' in r) return clientError(reply, 404, 'webhook not found');
    await audit(req, 'webhook.secret_rotated', 'webhook_endpoint', id);
    return r;
  });

  app.post('/v1/webhooks/:id/test', async (req, reply) => {
    assertCan(req.principal, { permission: 'webhook:write' });
    const id = whId(req);
    const r = await webhooks.testEndpoint(req.principal.orgId, id);
    if ('error' in r) return clientError(reply, 404, 'webhook not found');
    return r.result;
  });

  app.get('/v1/webhooks/:id/deliveries', async (req) => {
    assertCan(req.principal, { permission: 'webhook:read' });
    const id = whId(req);
    return { rows: await webhooks.listDeliveries(req.principal.orgId, id, ((req.query ?? {}) as Record<string, string>).state) };
  });

  // =================================================================== alert routing (e-mail, WhatsApp)
  // Channels, contacts and rules (services/alert-routing.ts). Secrets (SMTP
  // password, WhatsApp token) are write-only: sealed at rest, never returned,
  // never written to the audit log.

  const idParam = (req: FastifyRequest, what: string) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw new NotFoundError(`${what} not found`);
    return id;
  };
  const channelParam = (req: FastifyRequest) => {
    const { kind } = req.params as { kind: string };
    if (kind !== 'email' && kind !== 'whatsapp' && kind !== 'sms') throw new NotFoundError('channel not found');
    return kind;
  };

  app.get('/v1/alert-routing', async (req) => {
    assertCan(req.principal, { permission: 'alert:read' });
    const orgId = req.principal.orgId;
    const [channels, contacts, rules, rotas] = await Promise.all([routing.getChannels(orgId), routing.listContacts(orgId), routing.listRules(orgId), onCall.listRotas(orgId, config.alerts.timeZone)]);
    // Meta must reach the status webhook from the internet: the public address (PUBLIC_BASE_URL), as for payment notifications.
    const wh = (channels.whatsapp as { webhook?: { path: string; url?: string } | null }).webhook;
    if (wh) wh.url = (config.console.publicBaseUrl || `${req.protocol}://${req.headers.host ?? 'localhost'}`) + wh.path;
    return { channels, contacts, rules, rotas, kinds: ALERT_KINDS, timeZone: config.alerts.timeZone, consoleUrl: config.alerts.consoleUrl || null };
  });

  app.put('/v1/alert-routing/channels/:kind', async (req, reply) => {
    assertCan(req.principal, { permission: 'alert:write' });
    const kind = channelParam(req);
    const b = (req.body ?? {}) as { enabled?: boolean; config?: unknown; secret?: string; webhookSecret?: string };
    const r = await routing.saveChannel(req.principal.orgId, kind, b);
    if ('error' in r) return clientError(reply, 400, r.error!);
    await audit(req, 'alert_channel.saved', 'notification_channel', kind, { enabled: b.enabled !== false, config: b.config as Record<string, unknown>, secretChanged: !!b.secret, webhookSecretChanged: !!b.webhookSecret });
    return r;
  });

  app.post('/v1/alert-routing/channels/:kind/test', async (req, reply) => {
    assertCan(req.principal, { permission: 'alert:write' });
    const kind = channelParam(req);
    const r = await routing.testChannel(req.principal.orgId, kind, String((req.body as any)?.destination ?? ''));
    if ('error' in r) return clientError(reply, 400, r.error!);
    await audit(req, 'alert_channel.tested', 'notification_channel', kind, { ok: r.result.ok, destination: r.result.destination });
    return r.result;
  });

  app.post('/v1/alert-routing/contacts', async (req, reply) => {
    assertCan(req.principal, { permission: 'alert:write' });
    const r = await routing.saveContact(req.principal.orgId, null, req.body);
    if ('error' in r) return clientError(reply, 400, r.error!);
    await audit(req, 'alert_contact.created', 'alert_contact', (r.contact as any).id, { name: (r.contact as any).name });
    return reply.code(201).send(r);
  });

  app.put('/v1/alert-routing/contacts/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'alert:write' });
    const id = idParam(req, 'contact');
    const r = await routing.saveContact(req.principal.orgId, id, req.body);
    if ('error' in r) return r.error === 'not found' ? clientError(reply, 404, 'contact not found') : clientError(reply, 400, r.error!);
    await audit(req, 'alert_contact.updated', 'alert_contact', id, { name: (r.contact as any).name, active: (r.contact as any).active });
    return r;
  });

  app.delete('/v1/alert-routing/contacts/:id', async (req) => {
    assertCan(req.principal, { permission: 'alert:write' });
    const id = idParam(req, 'contact');
    if (!(await routing.deleteContact(req.principal.orgId, id))) throw new NotFoundError('contact not found');
    await audit(req, 'alert_contact.deleted', 'alert_contact', id);
    return { ok: true };
  });

  app.post('/v1/alert-routing/rules', async (req, reply) => {
    assertCan(req.principal, { permission: 'alert:write' });
    const r = await routing.saveRule(req.principal.orgId, null, req.body);
    if ('error' in r) return clientError(reply, 400, r.error!);
    await audit(req, 'alert_rule.created', 'alert_rule', (r.rule as any).id, req.body as Record<string, unknown>);
    return reply.code(201).send(r);
  });

  app.put('/v1/alert-routing/rules/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'alert:write' });
    const id = idParam(req, 'rule');
    const r = await routing.saveRule(req.principal.orgId, id, req.body);
    if ('error' in r) return r.error === 'not found' ? clientError(reply, 404, 'rule not found') : clientError(reply, 400, r.error!);
    await audit(req, 'alert_rule.updated', 'alert_rule', id, req.body as Record<string, unknown>);
    return r;
  });

  app.delete('/v1/alert-routing/rules/:id', async (req) => {
    assertCan(req.principal, { permission: 'alert:write' });
    const id = idParam(req, 'rule');
    if (!(await routing.deleteRule(req.principal.orgId, id))) throw new NotFoundError('rule not found');
    await audit(req, 'alert_rule.deleted', 'alert_rule', id);
    return { ok: true };
  });

  // On-call rotas: who is on duty, with overrides; rules notify whoever is on duty.
  app.post('/v1/alert-routing/rotas', async (req, reply) => {
    assertCan(req.principal, { permission: 'alert:write' });
    const r = await onCall.saveRota(req.principal.orgId, null, req.body);
    if ('error' in r) return clientError(reply, 400, r.error!);
    await audit(req, 'on_call_rota.created', 'on_call_rota', r.rota.id, req.body as Record<string, unknown>);
    return reply.code(201).send(r);
  });
  app.put('/v1/alert-routing/rotas/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'alert:write' });
    const id = idParam(req, 'rota');
    const r = await onCall.saveRota(req.principal.orgId, id, req.body);
    if ('error' in r) return r.error === 'not found' ? clientError(reply, 404, 'rota not found') : clientError(reply, 400, r.error!);
    await audit(req, 'on_call_rota.updated', 'on_call_rota', id, req.body as Record<string, unknown>);
    return r;
  });
  app.delete('/v1/alert-routing/rotas/:id', async (req) => {
    assertCan(req.principal, { permission: 'alert:write' });
    const id = idParam(req, 'rota');
    if (!(await onCall.deleteRota(req.principal.orgId, id))) throw new NotFoundError('rota not found');
    await audit(req, 'on_call_rota.deleted', 'on_call_rota', id);
    return { ok: true };
  });
  app.post('/v1/alert-routing/rotas/:id/overrides', async (req, reply) => {
    assertCan(req.principal, { permission: 'alert:write' });
    const id = idParam(req, 'rota');
    const r = await onCall.addOverride(req.principal.orgId, id, req.body);
    if ('error' in r) return r.error === 'not found' ? clientError(reply, 404, 'rota not found') : clientError(reply, 400, r.error!);
    await audit(req, 'on_call_override.created', 'on_call_rota', id, req.body as Record<string, unknown>);
    return reply.code(201).send(r);
  });
  app.delete('/v1/alert-routing/rotas/:id/overrides/:overrideId', async (req) => {
    assertCan(req.principal, { permission: 'alert:write' });
    const id = idParam(req, 'rota');
    const { overrideId } = req.params as { overrideId: string };
    if (!UUID_RE.test(overrideId) || !(await onCall.deleteOverride(req.principal.orgId, id, overrideId))) throw new NotFoundError('override not found');
    await audit(req, 'on_call_override.deleted', 'on_call_rota', id, { overrideId });
    return { ok: true };
  });

  app.get('/v1/alert-routing/log', async (req) => {
    assertCan(req.principal, { permission: 'alert:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    return { rows: await routing.listNotifications(req.principal.orgId, { state: q.state, alertId: q.alertId }) };
  });

  app.post('/v1/alert-routing/log/:id/retry', async (req) => {
    assertCan(req.principal, { permission: 'alert:write' });
    const { id } = req.params as { id: string };
    if (!/^\d{1,18}$/.test(id) || !(await routing.retryNotification(req.principal.orgId, id))) throw new NotFoundError('failed notification not found');
    await audit(req, 'alert_notification.retried', 'alert_notification', id);
    return { ok: true };
  });

  // =================================================================== platform commission & fee statements
  // Customers (organisations) see their own statement: invoice:read, org-wide.
  // Rates and site billing models are PlugSure's contract with the customer, so
  // only the platform operator (platform:admin) may change them — a tenant
  // administrator could otherwise lower its own commission.

  const monthParam = (req: FastifyRequest) => {
    const m = String(((req.query ?? {}) as Record<string, string>).month ?? commission.currentPeriod());
    if (!commission.PERIOD_RE.test(m)) throw new BadRequestError('month must be YYYY-MM');
    return m;
  };
  const sendHtml = (reply: FastifyReply, html: string) => { reply.header('Content-Type', 'text/html; charset=utf-8'); return html; };
  const sendCsv = (reply: FastifyReply, st: any) => {
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="plugsure-statement-${st.org?.slug ?? 'org'}-${st.period}.csv"`);
    return '﻿' + commission.statementCsv(st);
  };
  /** Run as another organisation (platform operator), outside the caller's own org scope. */
  const asOrg = <T>(orgId: string, fn: () => Promise<T>) => outsideRequestScope(() => withOrg(orgId, fn));

  /**
   * Whose statement: a Site Owner portal user gets its own owner's (and only
   * that); org-wide finance staff get the organisation's, or any owner's of the
   * organisation with ?ownerId=.
   */
  const statementScope = async (req: FastifyRequest): Promise<string | null> => {
    const asked = String(((req.query ?? {}) as Record<string, string>).ownerId ?? '') || null;
    const mine = req.principal.ownerIds ?? [];
    if (mine.length && !can(req.principal, { permission: 'invoice:read' })) {
      assertCanAny(req.principal, 'invoice:read');
      if (asked && !mine.includes(asked)) throw new NotFoundError('statement not found');
      return asked ?? mine[0]!;
    }
    assertCan(req.principal, { permission: 'invoice:read' });
    if (!asked) return null;
    if (!UUID_RE.test(asked) || !(await owners.ownerOf(req.principal.orgId, asked))) throw new NotFoundError('owner not found');
    return asked;
  };

  app.get('/v1/billing/statement', async (req) => {
    const ownerId = await statementScope(req);
    const st = await commission.statementFor(req.principal.orgId, monthParam(req), ownerId);
    return { ...st, history: await commission.listFinalised(req.principal.orgId, ownerId) };
  });
  app.get('/v1/billing/statement.csv', async (req, reply) => {
    const ownerId = await statementScope(req);
    return sendCsv(reply, await commission.statementFor(req.principal.orgId, monthParam(req), ownerId));
  });
  app.get('/v1/billing/statement.html', async (req, reply) => {
    const ownerId = await statementScope(req);
    return sendHtml(reply, commission.statementHtml(await commission.statementFor(req.principal.orgId, monthParam(req), ownerId)));
  });

  // ---- operator billing across owners (org-wide invoice access: PlugSure's own finance staff)
  app.get('/v1/billing/owners', async (req) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    const month = monthParam(req);
    return { ...(await commission.ownersOverview(req.principal.orgId, month)), current: commission.currentPeriod() };
  });

  const ownerParam = async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id) || !(await owners.ownerOf(req.principal.orgId, id))) throw new NotFoundError('owner not found');
    return id;
  };

  app.get('/v1/billing/owners/:id/plan', async (req) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    const id = await ownerParam(req);
    const month = monthParam(req);
    return { plan: await commission.planFor(req.principal.orgId, month, id), history: await commission.planHistory(req.principal.orgId, id) };
  });
  app.put('/v1/billing/owners/:id/plan', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    const id = await ownerParam(req);
    const raw = (req.body as any)?.plan;
    const from = (req.body as any)?.effectiveFrom ? String((req.body as any).effectiveFrom) : undefined;
    const r = await commission.savePlan(req.principal.orgId, raw === null ? null : raw ?? {}, actorUuid(req), from, id);
    if ('error' in r) return clientError(reply, 400, r.error!);
    await audit(req, raw === null ? 'billing.owner_plan_reset' : 'billing.owner_plan_set', 'site_owner', id, { effectiveFrom: r.effectiveFrom, plan: r.plan as unknown as Record<string, unknown> });
    return r;
  });
  app.post('/v1/billing/owners/:id/finalise', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    const id = await ownerParam(req);
    const month = String((req.body as any)?.month ?? '');
    if (!commission.PERIOD_RE.test(month)) return clientError(reply, 400, 'month must be YYYY-MM');
    const r = await commission.finalise(req.principal.orgId, month, actorUuid(req), id);
    if ('error' in r) return clientError(reply, r.error === 'already finalised' ? 409 : 400, r.error!);
    await audit(req, 'billing.owner_statement_finalised', 'site_owner', id, { month, number: r.number });
    return r;
  });

  // ---- site owners (who they are, which sites are theirs)
  app.get('/v1/owners', async (req) => {
    assertCan(req.principal, { permission: 'site:read' });
    return owners.listOwners(req.principal.orgId);
  });
  app.post('/v1/owners', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    const r = await owners.createOwner(req.principal.orgId, (req.body ?? {}) as owners.OwnerInput);
    if ('error' in r) return clientError(reply, 400, r.error);
    await audit(req, 'site_owner.created', 'site_owner', r.id, req.body as Record<string, unknown>);
    return reply.code(201).send(r);
  });
  app.put('/v1/owners/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    const id = await ownerParam(req);
    const r = await owners.updateOwner(req.principal.orgId, id, (req.body ?? {}) as owners.OwnerInput & { archived?: boolean });
    if ('error' in r) return clientError(reply, r.error === 'not found' ? 404 : 400, r.error!);
    await audit(req, 'site_owner.updated', 'site_owner', id, req.body as Record<string, unknown>);
    return r;
  });
  app.put('/v1/owners/:id/sites', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    const id = await ownerParam(req);
    const siteIds = Array.isArray((req.body as any)?.siteIds) ? (req.body as any).siteIds.map(String) : null;
    if (!siteIds || siteIds.some((s: string) => !UUID_RE.test(s))) return clientError(reply, 400, 'siteIds must be a list of sites');
    const r = await owners.setOwnerSites(req.principal.orgId, id, siteIds);
    if ('error' in r) return clientError(reply, r.error === 'not found' ? 404 : 409, r.error!);
    await audit(req, 'site_owner.sites_set', 'site_owner', id, { siteIds });
    return r;
  });

  const orgParam = async (req: FastifyRequest) => {
    const { orgId } = req.params as { orgId: string };
    if (!UUID_RE.test(orgId)) throw new NotFoundError('organisation not found');
    const org = await outsideRequestScope(() => commission.orgInfo(orgId));
    if (!org) throw new NotFoundError('organisation not found');
    return orgId;
  };

  app.get('/v1/platform/billing', async (req) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const month = monthParam(req);
    return { month, current: commission.currentPeriod(), orgs: await outsideRequestScope(() => commission.platformOverview(month)) };
  });
  app.get('/v1/platform/billing/orgs/:orgId', async (req) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const orgId = await orgParam(req);
    const month = monthParam(req);
    return asOrg(orgId, async () => ({
      statement: await commission.statementFor(orgId, month),
      plan: await commission.planFor(orgId, month),
      planHistory: await commission.planHistory(orgId),
      sites: await many(`SELECT id, name, billing_model FROM site WHERE org_id = $1 AND archived_at IS NULL ORDER BY name`, [orgId]),
    }));
  });
  app.get('/v1/platform/billing/orgs/:orgId/statement.html', async (req, reply) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const orgId = await orgParam(req);
    const month = monthParam(req);
    return sendHtml(reply, commission.statementHtml(await asOrg(orgId, () => commission.statementFor(orgId, month))));
  });
  app.get('/v1/platform/billing/orgs/:orgId/statement.csv', async (req, reply) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const orgId = await orgParam(req);
    const month = monthParam(req);
    return sendCsv(reply, await asOrg(orgId, () => commission.statementFor(orgId, month)));
  });
  app.put('/v1/platform/billing/orgs/:orgId/plan', async (req, reply) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const orgId = await orgParam(req);
    const raw = (req.body as any)?.plan;
    const from = (req.body as any)?.effectiveFrom ? String((req.body as any).effectiveFrom) : undefined;
    const r = await asOrg(orgId, () => commission.savePlan(orgId, raw === null ? null : raw ?? {}, actorUuid(req), from));
    if ('error' in r) return clientError(reply, 400, r.error!);
    await audit(req, raw === null ? 'billing.plan_reset' : 'billing.plan_set', 'organisation', orgId, { effectiveFrom: r.effectiveFrom, plan: r.plan as unknown as Record<string, unknown> });
    return r;
  });
  app.put('/v1/platform/billing/sites/:siteId/model', async (req, reply) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const { siteId } = req.params as { siteId: string };
    if (!UUID_RE.test(siteId)) throw new NotFoundError('site not found');
    const model = String((req.body as any)?.model ?? '');
    const r = await outsideRequestScope(() => commission.setSiteModel(siteId, model));
    if ('error' in r) return r.error === 'not found' ? clientError(reply, 404, 'site not found') : clientError(reply, 400, r.error!);
    await audit(req, 'billing.site_model_set', 'site', siteId, { model, orgId: r.site.org_id });
    return { ok: true };
  });
  app.post('/v1/platform/billing/orgs/:orgId/finalise', async (req, reply) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const orgId = await orgParam(req);
    const month = String((req.body as any)?.month ?? '');
    if (!commission.PERIOD_RE.test(month)) return clientError(reply, 400, 'month must be YYYY-MM');
    const r = await asOrg(orgId, () => commission.finalise(orgId, month, actorUuid(req)));
    if ('error' in r) return clientError(reply, r.error === 'already finalised' ? 409 : 400, r.error!);
    await audit(req, 'billing.statement_finalised', 'organisation', orgId, { month, number: r.number });
    return r;
  });

  // "I'm on it": stops escalation. Anyone who can act on a charger may acknowledge.
  app.post('/v1/alerts/:id/acknowledge', async (req) => {
    assertCanAny(req.principal, 'charge_point:command');
    const id = idParam(req, 'alert');
    const r = await one<{ id: string }>(
      `UPDATE alert SET acknowledged_at = now(), acknowledged_by = $3
        WHERE id = $1 AND org_id = $2 AND acknowledged_at IS NULL AND resolved_at IS NULL RETURNING id`,
      [id, req.principal.orgId, actorUuid(req)],
    );
    if (!r) throw new NotFoundError('open, unacknowledged alert not found');
    await audit(req, 'alert.acknowledged', 'alert', id);
    return { ok: true };
  });

  app.post('/v1/webhooks/:id/replay', async (req) => {
    assertCan(req.principal, { permission: 'webhook:write' });
    const id = whId(req);
    const deliveryId = (req.body as any)?.deliveryId;
    const n = await webhooks.replay(req.principal.orgId, id, deliveryId != null && /^\d+$/.test(String(deliveryId)) ? String(deliveryId) : undefined);
    await audit(req, 'webhook.replayed', 'webhook_endpoint', id, { deliveries: n });
    return { requeued: n };
  });

  app.post('/v1/alerts/:id/resolve', async (req) => {
    assertCan(req.principal, { permission: 'charge_point:write' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw new NotFoundError('alert not found');
    const r = await query(`UPDATE alert SET resolved_at = now() WHERE id = $1 AND org_id = $2 AND resolved_at IS NULL`, [
      id,
      req.principal.orgId,
    ]);
    if (!r.rowCount) throw new NotFoundError('alert not found');
    await audit(req, 'alert.resolved', 'alert', id);
    return { ok: true };
  });

  // =================================================================== users & roles (Module 10)

  app.get('/v1/roles', async (req) => {
    assertCan(req.principal, { permission: 'user:read' });
    return CONSOLE_ROLES;
  });

  app.get('/v1/users', async (req) => {
    assertCan(req.principal, { permission: 'user:read' });
    return users.listUsers(req.principal.orgId);
  });

  async function checkSiteIds(req: FastifyRequest, siteIds: unknown): Promise<string[]> {
    const ids = Array.isArray(siteIds) ? siteIds.map(String) : [];
    for (const s of ids) {
      if (!UUID_RE.test(s)) throw new BadRequestError('invalid site');
      // A grant must name a site of the user's own organisation — even for a
      // platform admin, whom can() lets past the org check.
      const site = await ownedSite(req, s, 'user:write');
      if (site.orgId !== req.principal.orgId) throw new BadRequestError('invalid site');
    }
    return ids;
  }

  /** An owner of the caller's own organisation, or null. */
  async function checkOwnerId(req: FastifyRequest, ownerId: unknown): Promise<string | null> {
    const id = ownerId == null || ownerId === '' ? null : String(ownerId);
    if (!id) return null;
    if (!UUID_RE.test(id)) throw new BadRequestError('invalid owner');
    const o = await one(`SELECT id FROM site_owner WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [id, req.principal.orgId]);
    if (!o) throw new BadRequestError('invalid owner');
    return id;
  }

  /** A live fleet account of the caller's own organisation, or null. */
  async function checkFleetAccountId(req: FastifyRequest, fleetAccountId: unknown): Promise<string | null> {
    const id = fleetAccountId == null || fleetAccountId === '' ? null : String(fleetAccountId);
    if (!id) return null;
    if (!UUID_RE.test(id)) throw new BadRequestError('invalid fleet account');
    const a = await one(`SELECT id FROM fleet_account WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [id, req.principal.orgId]);
    if (!a) throw new BadRequestError('invalid fleet account');
    return id;
  }

  app.post('/v1/users', async (req, reply) => {
    assertCan(req.principal, { permission: 'user:write' });
    const b = (req.body ?? {}) as any;
    const name = String(b.name ?? '').trim();
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!name) return clientError(reply, 400, 'name is required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return clientError(reply, 400, 'a valid email is required');
    if (!users.validRole(String(b.role))) return clientError(reply, 400, 'choose a role');
    const siteIds = await checkSiteIds(req, b.siteIds);
    const role = CONSOLE_ROLES.find((r) => r.name === b.role)!;
    if (role.siteScoped && siteIds.length === 0) return clientError(reply, 400, 'a Site Host must be assigned at least one site');
    const ownerId = role.ownerScoped ? await checkOwnerId(req, b.ownerId) : null;
    if (role.ownerScoped && !ownerId) return clientError(reply, 400, 'choose the site owner this user belongs to');
    const fleetAccountId = role.fleetScoped ? await checkFleetAccountId(req, b.fleetAccountId) : null;
    if (role.fleetScoped && !fleetAccountId) return clientError(reply, 400, 'choose the fleet account this user belongs to');
    const exists = await one(`SELECT id FROM app_user WHERE lower(email) = $1`, [email]);
    if (exists) return clientError(reply, 409, 'a user with that email already exists');
    const created = await users.createUser(req.principal.orgId, { name, email, phone: b.phone ?? null, role: role.name, siteIds, ownerId, fleetAccountId });
    await audit(req, 'user.created', 'user', created.id, { email, role: role.name, siteIds, ownerId, fleetAccountId });
    return {
      ok: true,
      id: created.id,
      temporaryPassword: created.temporaryPassword,
      warning: 'Share this one-time password securely. The user must choose a new one at first sign-in.',
    };
  });

  app.put('/v1/users/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'user:write' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw new NotFoundError('user not found');
    const u = await one<{ id: string; org_id: string }>(`SELECT id, org_id FROM app_user WHERE id = $1`, [id]);
    if (!u || u.org_id !== req.principal.orgId) throw new NotFoundError('user not found');
    const b = (req.body ?? {}) as any;
    const self = id === req.principal.userId;
    if (self && (b.role !== undefined || b.status !== undefined)) {
      return clientError(reply, 400, 'you cannot change your own role or status — ask another administrator');
    }
    if (b.name !== undefined || b.phone !== undefined) {
      await query(
        `UPDATE app_user SET name = COALESCE($2, name),
                phone_display = CASE WHEN $4::boolean THEN $3::text ELSE phone_display END WHERE id = $1`,
        [id, b.name ? String(b.name).trim() : null, b.phone ?? null, b.phone !== undefined],
      );
    }
    if (b.role !== undefined) {
      if (!users.validRole(String(b.role))) return clientError(reply, 400, 'choose a role');
      const siteIds = await checkSiteIds(req, b.siteIds);
      const role = CONSOLE_ROLES.find((r) => r.name === b.role)!;
      if (role.siteScoped && siteIds.length === 0) return clientError(reply, 400, 'a Site Host must be assigned at least one site');
      const ownerId = role.ownerScoped ? await checkOwnerId(req, b.ownerId) : null;
      if (role.ownerScoped && !ownerId) return clientError(reply, 400, 'choose the site owner this user belongs to');
      const fleetAccountId = role.fleetScoped ? await checkFleetAccountId(req, b.fleetAccountId) : null;
      if (role.fleetScoped && !fleetAccountId) return clientError(reply, 400, 'choose the fleet account this user belongs to');
      await users.setUserRole(id, req.principal.orgId, role.name, siteIds, ownerId, fleetAccountId);
    }
    if (b.status !== undefined) {
      if (!['active', 'disabled'].includes(b.status)) return clientError(reply, 400, 'status is active or disabled');
      await users.setUserStatus(id, b.status);
    }
    await audit(req, 'user.updated', 'user', id, { name: b.name, role: b.role, siteIds: b.siteIds, status: b.status });
    return { ok: true };
  });

  app.post('/v1/users/:id/reset-password', async (req) => {
    assertCan(req.principal, { permission: 'user:write' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw new NotFoundError('user not found');
    const u = await one<{ org_id: string }>(`SELECT org_id FROM app_user WHERE id = $1`, [id]);
    if (!u || u.org_id !== req.principal.orgId) throw new NotFoundError('user not found');
    const temporaryPassword = await users.resetPassword(id);
    await audit(req, 'user.password_reset', 'user', id);
    return { ok: true, temporaryPassword };
  });

  // =================================================================== sites (Module 3)

  app.get('/v1/sites', async (req) => {
    assertCanAny(req.principal, 'site:read');
    const visible = visibleSiteIds(req.principal, 'site:read');
    return sites.listSites(req.principal.orgId, visible, new Set(registry.onlineIdentities()));
  });

  app.get('/v1/sites/:siteId', async (req) => {
    const { siteId } = req.params as { siteId: string };
    if (!UUID_RE.test(siteId)) throw new NotFoundError('site not found');
    await ownedSite(req, siteId, 'site:read');
    const s = await sites.getSite(siteId);
    return { ...s, computed: sites.siteComputations(s?.connected_kva != null ? Number(s.connected_kva) : null, Number(s?.power_factor ?? 0.95)) };
  });

  app.post('/v1/sites', async (req, reply) => {
    assertCan(req.principal, { permission: 'site:write' });
    const input = sites.siteInputFrom(req.body ?? {});
    const v = sites.validateSite(input, true);
    if (Object.keys(v.errors).length) return clientError(reply, 422, Object.values(v.errors)[0]!, v as any);
    const id = await sites.createSite(req.principal.orgId, input);
    await audit(req, 'site.created', 'site', id, input as Record<string, unknown>);
    return { ok: true, id, warnings: v.warnings };
  });

  app.put('/v1/sites/:siteId', async (req, reply) => {
    const { siteId } = req.params as { siteId: string };
    if (!UUID_RE.test(siteId)) throw new NotFoundError('site not found');
    await ownedSite(req, siteId, 'site:write');
    const before = await sites.getSite(siteId);
    const input = sites.siteInputFrom(req.body ?? {});
    // Validate against the merged record, so a partial update is checked in context.
    const merged: sites.SiteInput = {
      kabupatenKotaCode: before?.kabupaten_kota_code,
      spkluScheme: before?.spklu_scheme,
      sloIssuedAt: before?.slo_issued_at ? new Date(before.slo_issued_at).toISOString().slice(0, 10) : null,
      sloExpiresAt: before?.slo_expires_at ? new Date(before.slo_expires_at).toISOString().slice(0, 10) : null,
      v2xEnabled: before?.v2x_enabled,
      v2xAllowExport: before?.v2x_allow_export,
      ...input,
    };
    const v = sites.validateSite(merged, false);
    if (Object.keys(v.errors).length) return clientError(reply, 422, Object.values(v.errors)[0]!, v as any);
    await sites.updateSite(siteId, input);
    // A changed bidirectional programme applies to cars already plugged in, once this change is committed.
    if (Object.keys(input).some((k) => k.startsWith('v2x'))) {
      afterResponse(reply.raw, async () => replanSite(siteId), (e) => logger.warn({ siteId, err: e.message }, 're-plan after a site change failed'));
    }
    // A lower subscription can leave the stored DLM ceiling above the new cap;
    // bring it down with it rather than leaving a value the budget PUT would refuse.
    if (input.connectedKva != null || input.powerFactor != null) {
      const b = await loadSiteBudget(siteId);
      if (b?.configuredCeilingW != null && b.configuredCeilingW > b.ceilingW) {
        await query(`UPDATE site_power_budget SET ceiling_w = $2, updated_at = now() WHERE site_id = $1`, [siteId, b.ceilingW]);
      }
    }
    await audit(req, 'site.updated', 'site', siteId, input as Record<string, unknown>);
    return { ok: true, warnings: v.warnings };
  });

  // Driver queue at a site (driver/queue.ts): who is waiting, and removing someone.
  app.get('/v1/sites/:siteId/queue', async (req) => {
    const { siteId } = req.params as { siteId: string };
    if (!UUID_RE.test(siteId)) throw new NotFoundError('site not found');
    await ownedSite(req, siteId, 'site:read');
    const s = await sites.getSite(siteId);
    return {
      settings: { enabled: s.queue_enabled, offerMinutes: s.queue_offer_minutes, maxLength: s.queue_max_length, maxWaitMinutes: s.queue_max_wait_minutes },
      ...(await driverQueue.operatorQueue(siteId)),
    };
  });

  app.delete('/v1/sites/:siteId/queue/:entryId', async (req) => {
    const { siteId, entryId } = req.params as { siteId: string; entryId: string };
    if (!UUID_RE.test(siteId)) throw new NotFoundError('site not found');
    await ownedSite(req, siteId, 'site:write');
    const removed = await driverQueue.removeEntry(siteId, entryId);
    if (!removed) throw new NotFoundError('no one with that place in the queue');
    await audit(req, 'driver_queue.removed', 'site', siteId, removed);
    return { ok: true };
  });

  app.post('/v1/sites/:siteId/archive', async (req) => {
    const { siteId } = req.params as { siteId: string };
    if (!UUID_RE.test(siteId)) throw new NotFoundError('site not found');
    await ownedSite(req, siteId, 'site:write');
    const active = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM charge_point WHERE site_id = $1 AND status <> 'decommissioned'`,
      [siteId],
    );
    if ((active?.n ?? 0) > 0) throw new BadRequestError('decommission or move this site\'s charge points before archiving it');
    await query(`UPDATE site SET archived_at = now() WHERE id = $1`, [siteId]);
    await audit(req, 'site.archived', 'site', siteId);
    return { ok: true };
  });

  // =================================================================== charge points (Module 1)

  app.get('/v1/charge-points/:identity', async (req) => {
    const { identity } = req.params as { identity: string };
    await ownedChargePoint(req, identity, 'charge_point:read');
    const d = await cps.chargePointDetail(identity);
    if (!d) throw new NotFoundError('charge point not found');
    // Site-scoped viewers: the active session's card is masked (see protectDriverData).
    if (visibleSiteIds(req.principal, 'charge_point:read') !== null) d.connectors = d.connectors.map((c: any) => protectDriverData(c));
    return {
      ...d,
      online: registry.isOnline(identity),
      negotiatedVersion: registry.versionOf(identity) ?? null,
      ocppUrl: `${ocppBaseUrl(req)}/${identity}`,
    };
  });

  app.put('/v1/charge-points/:identity', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'charge_point:write');
    const b = (req.body ?? {}) as any;
    const p: cps.ChargePointProfile = {};
    for (const k of ['displayName', 'vendor', 'model', 'serial', 'firmware'] as const) {
      if (b[k] !== undefined) p[k] = b[k] == null ? null : String(b[k]).slice(0, 200);
    }
    if (b.ocppVersion !== undefined) p.ocppVersion = b.ocppVersion === 'ocpp2.0.1' || b.ocppVersion === 'ocpp2.1' ? b.ocppVersion : 'ocpp1.6';
    if (b.keyRotationDays !== undefined) {
      const n = num(b.keyRotationDays);
      if (n != null && (!Number.isInteger(n) || n < 7 || n > 730)) return clientError(reply, 400, 'rotation reminder must be 7–730 days');
      p.keyRotationDays = n;
    }
    if (b.siteId !== undefined) {
      if (!UUID_RE.test(String(b.siteId))) return clientError(reply, 400, 'invalid site');
      const target = await ownedSite(req, String(b.siteId), 'charge_point:write');
      if (target.orgId !== owner.orgId) return clientError(reply, 400, 'a charge point can only move between sites of its own organisation');
      p.siteId = String(b.siteId);
    }
    await cps.updateProfile(owner.chargePointId, p);
    await audit(req, 'charge_point.updated', 'charge_point', identity, p as Record<string, unknown>);
    return { ok: true };
  });

  app.put('/v1/charge-points/:identity/evses', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'charge_point:write');
    const cp = await one<{ ocpp_version: string | null }>(`SELECT ocpp_version FROM charge_point WHERE id = $1`, [owner.chargePointId]);
    const evses = ((req.body as any)?.evses ?? []) as cps.EvseSpec[];
    const problems = cps.validateTopology(evses, cp?.ocpp_version ?? 'ocpp1.6');
    if (problems.length) return clientError(reply, 422, problems[0]!, { problems });
    await cps.applyTopology(owner.chargePointId, evses);
    await audit(req, 'charge_point.topology_changed', 'charge_point', identity, { evses: evses as unknown as Record<string, unknown> });
    return { ok: true };
  });

  app.get('/v1/charge-points/:identity/commissioning', async (req) => {
    const { identity } = req.params as { identity: string };
    await ownedChargePoint(req, identity, 'charge_point:read');
    const s = await cps.commissioningStatus(identity, registry.isOnline(identity));
    if (!s) throw new NotFoundError('charge point not found');
    // Site-scoped users: no connection details (source IP) and nothing from
    // before the charger joined their site.
    if (visibleSiteIds(req.principal, 'charge_point:read') !== null && s.lastAttempt) {
      const floor = await siteAssignedAt(identity);
      const { remote_ip: _ip, ...rest } = s.lastAttempt;
      s.lastAttempt = floor && new Date(rest.ts) < floor ? null : rest;
    }
    return s;
  });

  const siteAssignedAt = async (identity: string): Promise<Date | null> =>
    (await one<{ at: Date | null }>(`SELECT site_assigned_at AS at FROM charge_point WHERE ocpp_identity = $1`, [identity]))?.at ?? null;

  app.post('/v1/charge-points/:identity/decommission', async (req) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'charge_point:write');
    const active = await one(`SELECT 1 FROM charging_session WHERE charge_point_id = $1 AND state = 'active'`, [owner.chargePointId]);
    if (active) throw new BadRequestError('this charge point has a session in progress — stop it first');
    await query(
      `UPDATE charge_point SET status = 'decommissioned', decommissioned_at = now(), auth_key_hash = NULL,
              auth_key_prev_hash = NULL, client_cert_fingerprint = NULL WHERE id = $1`,
      [owner.chargePointId],
    );
    await audit(req, 'charge_point.decommissioned', 'charge_point', identity, { reason: (req.body as any)?.reason ?? null });
    return { ok: true };
  });

  app.post('/v1/charge-points/:identity/reinstate', async (req) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'charge_point:write');
    // Back to pending adoption: credentials were cleared at decommissioning, so it
    // re-enters through the same gate a new unit does.
    await query(
      `UPDATE charge_point SET status = 'pending_adoption', decommissioned_at = NULL, security_profile = 0
        WHERE id = $1 AND status = 'decommissioned'`,
      [owner.chargePointId],
    );
    await audit(req, 'charge_point.reinstated', 'charge_point', identity);
    return { ok: true };
  });

  /**
   * Security provisioning in one call (the spec's POST /keys):
   *   { profile: 1|2, key?, rotationDays? }         -> AuthorizationKey (+ commissioning export)
   *   { profile: 3, method: 'vault' }               -> Vault-issued client certificate bundle
   *   { profile: 3, certificatePem | fingerprint }  -> bind an existing certificate
   * The profile itself is raised separately (PUT security-profile) — key first,
   * then profile, or the unit is locked out.
   */
  async function issueFromVault(req: FastifyRequest, reply: FastifyReply, identity: string) {
    const owner = await ownedChargePoint(req, identity, 'charge_point:write');
    const bundle = await issueClientCertificate(identity);
    const res = await setClientCertFingerprint(owner.chargePointId, bundle.fingerprint, actorOf(req));
    if (!res.ok) return clientError(reply, 400, res.error ?? 'could not bind the certificate');
    await query(`UPDATE charge_point SET client_cert_prev_fingerprint = NULL, client_cert_serial = $2, client_cert_not_after = $3, client_cert_source = 'vault' WHERE id = $1`, [owner.chargePointId, bundle.serialNumber || null, bundle.expiresAt]);
    await audit(req, 'charge_point.client_cert.issued', 'charge_point', identity, {
      source: 'vault',
      serialNumber: bundle.serialNumber,
      fingerprint: bundle.fingerprint,
      expiresAt: bundle.expiresAt,
    });
    return {
      ok: true,
      fingerprint: bundle.fingerprint,
      serialNumber: bundle.serialNumber,
      expiresAt: bundle.expiresAt,
      files: {
        'client.crt': bundle.certificatePem,
        'client.key': bundle.privateKeyPem,
        'ca.pem': [bundle.caPem, ...bundle.caChainPem].filter(Boolean).join('\n'),
      },
      commissioning: await commissioningBundle(req, identity, 3),
      warning: 'The private key is shown once and is not stored by PlugSure. Download the bundle now.',
    };
  }

  /** Profile 3 from PlugSure's charging-station CA: a generated key (shown once) or the charger's CSR. */
  async function issueFromPlugsureCa(req: FastifyRequest, reply: FastifyReply, identity: string, b: any) {
    const owner = await ownedChargePoint(req, identity, 'charge_point:write');
    if (b.method === 'csr' && !String(b.csr ?? '').includes('CERTIFICATE REQUEST')) return clientError(reply, 400, 'paste the charger\'s certificate signing request (PEM)');
    let issued;
    try {
      issued = await issueAtOnboarding(owner.chargePointId, { keyType: b.keyType === 'rsa' ? 'rsa' : 'ec', csr: b.method === 'csr' ? String(b.csr) : undefined, days: b.days }, actorOf(req));
    } catch (e) {
      if (e instanceof CertificateError) return clientError(reply, e.statusCode, e.message);
      throw e;
    }
    const ca = await caInfo();
    const commissioning = await commissioningBundle(req, identity, 3);
    return {
      ok: true,
      source: b.method === 'csr' ? 'plugsure_ca_csr' : 'plugsure_ca',
      fingerprint: issued.fingerprint,
      serialNumber: issued.serial,
      expiresAt: issued.notAfter,
      subject: issued.subject,
      keyType: issued.keyType,
      files: {
        'client.crt': issued.certificatePem,
        ...(issued.privateKeyPem ? { 'client.key': issued.privateKeyPem } : {}),
        'ca.pem': issued.caPem,
        'chain.pem': issued.chainPem,
        ...(ca.csmsRootPem ? { 'csms-root.pem': ca.csmsRootPem } : {}),
      },
      commissioning,
      warning: issued.privateKeyPem
        ? 'The private key is shown once and is not stored by PlugSure. Download the bundle now.'
        : 'The key stayed on the charger. Install client.crt (and chain.pem) on it.',
    };
  }

  app.post('/v1/charge-points/:identity/keys', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const b = (req.body ?? {}) as any;
    const profile = Number(b.profile ?? 2);
    if (profile === 3) {
      if (b.method === 'vault') return issueFromVault(req, reply, identity);
      if (b.method === 'auto' || b.method === 'csr') return issueFromPlugsureCa(req, reply, identity, b);
      const owner = await ownedChargePoint(req, identity, 'charge_point:write');
      const pem = String(b.certificatePem ?? '').trim();
      const info = pem ? describePem(pem) : null;
      if (pem && !info) return clientError(reply, 400, 'that is not a valid PEM certificate');
      const res = await setClientCertFingerprint(owner.chargePointId, info?.fingerprint ?? String(b.fingerprint ?? ''), actorOf(req));
      if (!res.ok) return clientError(reply, 400, res.error ?? 'invalid fingerprint');
      await query(`UPDATE charge_point SET client_cert_prev_fingerprint = NULL, client_cert_serial = $2, client_cert_not_after = $3, client_cert_source = CASE WHEN $4::text IS NULL THEN NULL ELSE 'external' END WHERE id = $1`,
        [owner.chargePointId, info?.serialNumber ?? null, info?.validTo ?? null, res.fingerprint ?? null]);
      return { ok: true, fingerprint: res.fingerprint, certificate: info };
    }
    if (profile !== 1 && profile !== 2) return clientError(reply, 400, 'profile must be 1, 2 or 3');
    const owner = await ownedChargePoint(req, identity, 'charge_point:write');
    const provided = typeof b.key === 'string' && b.key.trim() !== '' ? b.key.trim() : undefined;
    if (provided) {
      const problem = providedKeyProblem(provided);
      if (problem) return clientError(reply, 400, problem);
    }
    if (b.rotationDays != null && b.rotationDays !== '') {
      const n = Number(b.rotationDays);
      if (!Number.isInteger(n) || n < 7 || n > 730) return clientError(reply, 400, 'rotation reminder must be 7–730 days');
      await query(`UPDATE charge_point SET key_rotation_days = $2 WHERE id = $1`, [owner.chargePointId, n]);
    }
    const issued = await issueAuthorizationKey(owner.chargePointId, actorOf(req), provided);
    if (!issued) throw new NotFoundError('charge point not found');
    // Zero-touch certificate: after its first boot on this key, the charger is asked for a
    // CSR, gets its certificate over OCPP and is moved to Profile 3 (services/charger-ca.ts).
    if (typeof b.autoCertificate === 'boolean') {
      await query(`UPDATE charge_point SET cert_auto_upgrade = $2 WHERE id = $1`, [owner.chargePointId, b.autoCertificate && profile === 2]);
    }
    return {
      ...issued,
      commissioning: await commissioningBundle(req, identity, profile, issued.key),
      warning:
        'This key is shown once. Configure it on the charger FIRST, then raise the security profile — ' +
        'the other order leaves the unit unable to connect.',
    };
  });

  app.post('/v1/charge-points/:identity/client-certificate/vault', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    return issueFromVault(req, reply, identity);
  });

  app.get('/v1/charge-points/:identity/commissioning-export', async (req) => {
    const { identity } = req.params as { identity: string };
    await ownedChargePoint(req, identity, 'charge_point:write');
    const cp = await one<{ security_profile: number }>(`SELECT security_profile FROM charge_point WHERE ocpp_identity = $1`, [identity]);
    // Without the key: it was shown once at issue and is not recoverable.
    return commissioningBundle(req, identity, cp?.security_profile ?? 0);
  });

  // =================================================================== config key studio (Module 6)

  async function configView(chargePointId: string) {
    const rows = await many<any>(
      `SELECT key, value, readonly, reboot_required, last_status, read_at FROM charge_point_config
        WHERE charge_point_id = $1 ORDER BY key`,
      [chargePointId],
    );
    const seen = new Set(rows.map((r) => r.key));
    const list = rows.map((r) => {
      const info = catalogEntry(r.key);
      return {
        key: r.key,
        value: info?.writeOnly ? null : r.value,
        readonly: r.readonly,
        rebootRequired: r.reboot_required,
        lastStatus: r.last_status,
        readAt: r.read_at,
        category: info?.category ?? 'Vendor',
        type: info?.type ?? 'string',
        unit: info?.unit ?? null,
        description: info?.description ?? 'Vendor-specific key. See the manufacturer\'s OCPP documentation.',
        managed: Boolean(info?.managed),
        writeOnly: Boolean(info?.writeOnly),
        reported: true,
      };
    });
    // Catalog keys the charger did not report stay visible (greyed), so an
    // operator can tell "not supported" from "not loaded yet".
    for (const c of CONFIG_CATALOG) {
      if (seen.has(c.key)) continue;
      list.push({
        key: c.key, value: null, readonly: false, rebootRequired: false, lastStatus: null, readAt: null,
        category: c.category, type: c.type, unit: c.unit ?? null, description: c.description,
        managed: Boolean(c.managed), writeOnly: Boolean(c.writeOnly), reported: false,
      });
    }
    return list;
  }

  app.get('/v1/charge-points/:identity/config', async (req) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'charge_point:read');
    const refresh = (req.query as any)?.refresh !== '0';
    let error: string | null = null;
    let live = false;
    if (refresh && registry.isOnline(identity)) {
      if (!can(req.principal, { permission: 'charge_point:config', orgId: owner.orgId, siteId: owner.siteId }) &&
          !can(req.principal, { permission: 'charge_point:command', orgId: owner.orgId, siteId: owner.siteId })) {
        error = 'showing the last snapshot — your role cannot query the charger';
      } else {
        try {
          const r = await commands.getConfiguration(identity, undefined, actorOf(req));
          for (const k of r?.configurationKey ?? []) {
            await query(
              `INSERT INTO charge_point_config (charge_point_id, key, value, readonly, read_at)
               VALUES ($1,$2,$3,$4, now())
               ON CONFLICT (charge_point_id, key) DO UPDATE
                 SET value = EXCLUDED.value, readonly = EXCLUDED.readonly, read_at = now()`,
              [owner.chargePointId, String(k.key).slice(0, 200), k.value == null ? null : String(k.value).slice(0, 1000), Boolean(k.readonly)],
            );
          }
          live = true;
        } catch (e) {
          error = `the charger did not answer GetConfiguration: ${(e as Error).message}`;
        }
      }
    } else if (refresh) {
      error = 'the charger is offline — showing the last snapshot';
    }
    return { live, error, keys: await configView(owner.chargePointId), categories: CONFIG_CATEGORIES };
  });

  app.put('/v1/charge-points/:identity/config', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'charge_point:read');
    if (!can(req.principal, { permission: 'charge_point:config', orgId: owner.orgId, siteId: owner.siteId }) &&
        !can(req.principal, { permission: 'charge_point:command', orgId: owner.orgId, siteId: owner.siteId })) {
      assertCan(req.principal, { permission: 'charge_point:config', orgId: owner.orgId, siteId: owner.siteId });
    }
    const b = (req.body ?? {}) as any;
    const key = String(b.key ?? '').trim();
    const value = String(b.value ?? '');
    if (!/^[A-Za-z0-9_.-]{1,50}$/.test(key)) return clientError(reply, 400, 'invalid configuration key');
    if (key === 'SecurityProfile' || key === 'AuthorizationKey') {
      return clientError(reply, 400, `${key} is changed from the Security tab, which enforces the safe order of operations`);
    }
    const problem = validateConfigValue(key, value);
    if (problem) return clientError(reply, 400, problem);
    const snapshot = await one<{ readonly: boolean }>(
      `SELECT readonly FROM charge_point_config WHERE charge_point_id = $1 AND key = $2`,
      [owner.chargePointId, key],
    );
    if (snapshot?.readonly) return clientError(reply, 400, `${key} is read-only on this charger`);
    // commands.send throws "not connected" for an offline unit, which would surface as a bare 500.
    if (!registry.isOnline(identity)) return clientError(reply, 409, 'the charger is offline');
    const r = await commands.changeConfiguration(identity, key, value, actorOf(req));
    const status = r?.status ?? 'NoResponse';
    await query(
      `INSERT INTO charge_point_config (charge_point_id, key, value, readonly, reboot_required, last_status, read_at)
       VALUES ($1,$2,$3,false,$4,$5, now())
       ON CONFLICT (charge_point_id, key) DO UPDATE
         SET value = CASE WHEN $5 IN ('Accepted','RebootRequired') THEN EXCLUDED.value ELSE charge_point_config.value END,
             reboot_required = EXCLUDED.reboot_required, last_status = EXCLUDED.last_status, read_at = now()`,
      [owner.chargePointId, key, value, status === 'RebootRequired', status],
    );
    return { ok: status === 'Accepted' || status === 'RebootRequired', status, rebootRequired: status === 'RebootRequired' };
  });

  // =================================================================== OCPP 2.0.1 device model

  /** A 2.0.1 station this principal may configure, online: the owner row, or an error already sent. */
  async function deviceTarget(req: FastifyRequest, reply: FastifyReply, identity: string) {
    const owner = await ownedChargePoint(req, identity, 'charge_point:read');
    if (!can(req.principal, { permission: 'charge_point:config', orgId: owner.orgId, siteId: owner.siteId }) &&
        !can(req.principal, { permission: 'charge_point:command', orgId: owner.orgId, siteId: owner.siteId })) {
      assertCan(req.principal, { permission: 'charge_point:config', orgId: owner.orgId, siteId: owner.siteId });
    }
    const version = await commands.wireVersion(identity);
    if (version !== 'ocpp2.0.1' && version !== 'ocpp2.1') {
      clientError(reply, 409, 'The device model is OCPP 2.0.1; this charger speaks 1.6 — use the Configuration tab.');
      return null;
    }
    if (!registry.isOnline(identity)) { clientError(reply, 409, 'the charger is offline'); return null; }
    return owner;
  }
  const noAnswer = (reply: FastifyReply, what: string, e: unknown) =>
    clientError(reply, 502, `the charger did not answer ${what}: ${(e as Error).message}`);
  const keyFrom = (b: any) => dm.keyOf(
    { name: b?.component, instance: b?.componentInstance || undefined, evse: b?.evseId ? { id: Number(b.evseId), connectorId: b?.connectorId ? Number(b.connectorId) : undefined } : undefined },
    { name: b?.variable, instance: b?.variableInstance || undefined });
  const validKey = (k: ReturnType<typeof dm.keyOf>) =>
    /^[A-Za-z0-9_.:-]{1,50}$/.test(k.component) && /^[A-Za-z0-9_.:-]{1,50}$/.test(k.variable) &&
    /^[A-Za-z0-9_.:-]{0,50}$/.test(k.componentInstance) && /^[A-Za-z0-9_.:-]{0,50}$/.test(k.variableInstance);

  app.get('/v1/charge-points/:identity/device-model', async (req) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'charge_point:read');
    const version = await commands.wireVersion(identity);
    return {
      supported: version === 'ocpp2.0.1' || version === 'ocpp2.1',
      online: registry.isOnline(identity),
      ...(await dm.deviceModel(owner.chargePointId)),
    };
  });

  app.post('/v1/charge-points/:identity/device-model/report', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const owner = await deviceTarget(req, reply, identity);
    if (!owner) return reply;
    const reportBase = String((req.body as any)?.reportBase ?? 'FullInventory');
    if (!dm.REPORT_BASES.includes(reportBase as any)) return clientError(reply, 400, `reportBase is one of ${dm.REPORT_BASES.join(', ')}`);
    const requestId = dm.newRequestId();
    await dm.startReportRequest(owner.chargePointId, owner.orgId, requestId, 'base', reportBase, actorOf(req).id ?? 'user');
    let status: string;
    try { status = (await commands.getBaseReport(identity, requestId, reportBase, actorOf(req)))?.status ?? 'NoResponse'; }
    catch (e) { await dm.answerReportRequest(owner.chargePointId, requestId, null); return noAnswer(reply, 'GetBaseReport', e); }
    const state = await dm.answerReportRequest(owner.chargePointId, requestId, status);
    return { requestId, status, state };
  });

  app.post('/v1/charge-points/:identity/device-model/monitoring-report', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const owner = await deviceTarget(req, reply, identity);
    if (!owner) return reply;
    const requestId = dm.newRequestId();
    await dm.startReportRequest(owner.chargePointId, owner.orgId, requestId, 'monitoring', null, actorOf(req).id ?? 'user');
    let status: string;
    try { status = (await commands.getMonitoringReport(identity, requestId, actorOf(req)))?.status ?? 'NoResponse'; }
    catch (e) { await dm.answerReportRequest(owner.chargePointId, requestId, null); return noAnswer(reply, 'GetMonitoringReport', e); }
    const state = await dm.answerReportRequest(owner.chargePointId, requestId, status);
    return { requestId, status, state };
  });

  /** Read chosen variables now (GetVariables), up to 20 at a time; the answers are stored. */
  app.post('/v1/charge-points/:identity/device-model/get', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const owner = await deviceTarget(req, reply, identity);
    if (!owner) return reply;
    const items = Array.isArray((req.body as any)?.items) ? (req.body as any).items : [];
    if (!items.length || items.length > 20) return clientError(reply, 400, 'items: 1 to 20 component/variable pairs');
    const keys = items.map((i: any) => ({ k: keyFrom(i), attributeType: dm.ATTRIBUTE_TYPES.includes(i?.attributeType) ? i.attributeType : 'Actual' }));
    if (keys.some((x: any) => !validKey(x.k))) return clientError(reply, 400, 'every item needs a component and a variable (letters, digits, _ . : -)');
    let r;
    try { r = await commands.getVariables(identity, keys.map((x: any) => ({ ...dm.refsOf(x.k), attributeType: x.attributeType })), actorOf(req)); }
    catch (e) { return noAnswer(reply, 'GetVariables', e); }
    const results = [];
    for (const [i, res] of (r?.getVariableResult ?? []).entries()) {
      const k = dm.keyOf(res.component as any, res.variable as any);
      const attributeType = res.attributeType ?? keys[i]?.attributeType ?? 'Actual';
      if (res.attributeStatus === 'Accepted' && k.component && k.variable) {
        await dm.recordValue(owner.chargePointId, owner.orgId, k, attributeType, res.attributeValue ?? null);
      }
      results.push({ ...k, label: dm.label(k), attributeType, status: res.attributeStatus, value: res.attributeValue ?? null });
    }
    return { results };
  });

  /** Set one variable (SetVariables), checked against what the station reported about it. */
  app.put('/v1/charge-points/:identity/device-model/variable', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const owner = await deviceTarget(req, reply, identity);
    if (!owner) return reply;
    const b = (req.body ?? {}) as any;
    const k = keyFrom(b);
    if (!validKey(k)) return clientError(reply, 400, 'component and variable are required (letters, digits, _ . : -)');
    const attributeType = b.attributeType == null ? 'Actual' : String(b.attributeType);
    if (!dm.ATTRIBUTE_TYPES.includes(attributeType as any)) return clientError(reply, 400, `attributeType is one of ${dm.ATTRIBUTE_TYPES.join(', ')}`);
    const value = String(b.value ?? '');
    const guarded = dm.protectedVariable(k.component, k.variable);
    if (guarded) return clientError(reply, 400, guarded);
    const known = await dm.stored(owner.chargePointId, k);
    const attr = (known?.attributes ?? []).find((a: any) => a.type === attributeType);
    if (attr?.mutability === 'ReadOnly' || attr?.constant === true) return clientError(reply, 400, `${dm.label(k)} is read-only on this station`);
    const problem = dm.valueProblem(known?.characteristics ?? null, value);
    if (problem) return clientError(reply, 400, `${dm.label(k)}: ${problem}`);
    let r;
    try { r = await commands.setVariables(identity, [{ ...dm.refsOf(k), attributeType, attributeValue: value }], actorOf(req)); }
    catch (e) { return noAnswer(reply, 'SetVariables', e); }
    const res = r?.setVariableResult?.[0];
    const status = res?.attributeStatus ?? 'NoResponse';
    if (status === 'Accepted' || status === 'RebootRequired') await dm.recordValue(owner.chargePointId, owner.orgId, k, attributeType, value);
    return {
      ok: status === 'Accepted' || status === 'RebootRequired', status, rebootRequired: status === 'RebootRequired',
      reason: res?.attributeStatusInfo?.reasonCode ?? null, label: dm.label(k),
    };
  });

  app.post('/v1/charge-points/:identity/device-model/monitors', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const owner = await deviceTarget(req, reply, identity);
    if (!owner) return reply;
    const b = (req.body ?? {}) as any;
    const k = keyFrom(b);
    if (!validKey(k)) return clientError(reply, 400, 'component and variable are required (letters, digits, _ . : -)');
    const problem = dm.monitorProblem(b);
    if (problem) return clientError(reply, 400, problem);
    const known = await dm.stored(owner.chargePointId, k);
    if (known?.characteristics && known.characteristics.supportsMonitoring === false) {
      return clientError(reply, 400, `${dm.label(k)} does not support monitoring on this station`);
    }
    const m = { type: String(b.type), value: Number(b.value), severity: Number(b.severity), transaction: b.transaction === true };
    let r;
    try { r = await commands.setVariableMonitoring(identity, [{ ...dm.refsOf(k), ...m }], actorOf(req)); }
    catch (e) { return noAnswer(reply, 'SetVariableMonitoring', e); }
    const res = r?.setMonitoringResult?.[0];
    const status = res?.status ?? 'NoResponse';
    if (status === 'Accepted' && Number.isInteger(res?.id)) {
      await dm.saveMonitor(owner.chargePointId, owner.orgId, { ...k, monitorId: res!.id!, ...m, kind: 'CustomMonitor' });
    }
    return { ok: status === 'Accepted', status, id: res?.id ?? null, reason: res?.statusInfo?.reasonCode ?? null };
  });

  app.delete('/v1/charge-points/:identity/device-model/monitors/:monitorId', async (req, reply) => {
    const { identity, monitorId } = req.params as { identity: string; monitorId: string };
    const owner = await deviceTarget(req, reply, identity);
    if (!owner) return reply;
    const id = Number(monitorId);
    if (!Number.isInteger(id) || id < 0) return clientError(reply, 400, 'invalid monitor id');
    let r;
    try { r = await commands.clearVariableMonitoring(identity, [id], actorOf(req)); }
    catch (e) { return noAnswer(reply, 'ClearVariableMonitoring', e); }
    const status = r?.clearMonitoringResult?.[0]?.status ?? 'NoResponse';
    // NotFound: the station no longer has it either — drop our copy too.
    if (status === 'Accepted' || status === 'NotFound') await dm.dropMonitor(owner.chargePointId, id);
    return { ok: status === 'Accepted' || status === 'NotFound', status };
  });

  // =================================================================== local auth list (Module 7)

  app.post('/v1/charge-points/:identity/local-list/sync', async (req) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'token:write');
    if (!registry.isOnline(identity)) throw new BadRequestError('the charger is offline');
    const r = await tokens.pushLocalList(identity, owner.chargePointId, actorOf(req));
    await audit(req, 'token.local_list_synced', 'charge_point', identity, r as unknown as Record<string, unknown>);
    return r;
  });

  app.post('/v1/sites/:siteId/local-list/sync', async (req) => {
    const { siteId } = req.params as { siteId: string };
    if (!UUID_RE.test(siteId)) throw new NotFoundError('site not found');
    await ownedSite(req, siteId, 'token:write');
    const list = await many<{ id: string; ocpp_identity: string }>(
      `SELECT id, ocpp_identity FROM charge_point WHERE site_id = $1 AND status NOT IN ('decommissioned','pending_adoption')`,
      [siteId],
    );
    const results = [];
    for (const cp of list) {
      if (!registry.isOnline(cp.ocpp_identity)) {
        results.push({ ok: false, identity: cp.ocpp_identity, error: 'offline' });
        continue;
      }
      results.push(await tokens.pushLocalList(cp.ocpp_identity, cp.id, actorOf(req)));
    }
    await audit(req, 'token.local_list_synced', 'site', siteId, { results } as unknown as Record<string, unknown>);
    return { results };
  });

  // =================================================================== RFID (Module 7)

  app.get('/v1/tokens', async (req) => {
    assertCan(req.principal, { permission: 'token:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    return tokens.listTokens(req.principal.orgId, {
      q: q.q,
      status: q.status,
      accountType: q.accountType,
      limit: q.limit ? limitParam(q.limit, 100, 10_000) : undefined,
    });
  });

  app.get('/v1/tokens/unknown', async (req) => {
    assertCan(req.principal, { permission: 'token:write' });
    const q = (req.query ?? {}) as Record<string, string>;
    return tokens.recentUnknownTags(req.principal.orgId, q.identity || undefined);
  });

  function tokenInputFrom(b: any): tokens.TokenInput {
    const t: tokens.TokenInput = {};
    if (b.uid !== undefined) t.uid = String(b.uid).trim();
    for (const k of ['holderName', 'holderPhone', 'fleetName', 'notes'] as const) {
      if (b[k] !== undefined) t[k] = b[k] == null ? null : String(b[k]).trim().slice(0, 200);
    }
    if (b.accountType !== undefined) t.accountType = String(b.accountType);
    if (b.status !== undefined) t.status = String(b.status);
    if (b.validTo !== undefined) t.validTo = b.validTo || null;
    if (b.energyLimitKwh !== undefined) t.energyLimitKwh = num(b.energyLimitKwh);
    if (b.spendLimitIdr !== undefined) t.spendLimitIdr = num(b.spendLimitIdr);
    if (b.offlineAllowed !== undefined) t.offlineAllowed = Boolean(b.offlineAllowed);
    if (b.pin !== undefined) t.pin = b.pin == null ? null : String(b.pin);
    return t;
  }

  app.post('/v1/tokens', async (req, reply) => {
    assertCan(req.principal, { permission: 'token:write' });
    const t = tokenInputFrom(req.body ?? {});
    t.accountType ??= 'retail';
    t.status ??= 'Accepted';
    const errors = tokens.validateToken(t, true);
    if (Object.keys(errors).length) return clientError(reply, 422, Object.values(errors)[0]!, { errors });
    const uid = tokens.normaliseUid(t.uid!);
    const dup = await one(`SELECT id FROM token WHERE org_id = $1 AND uid = $2`, [req.principal.orgId, uid]);
    if (dup) return clientError(reply, 409, 'that card is already registered');
    const pinHash = t.pin ? await users.hashPassword(t.pin) : null;
    const id = await tokens.createToken(req.principal.orgId, { ...t, uid }, pinHash);
    await audit(req, 'token.issued', 'token', id, { uid, accountType: t.accountType, holderName: t.holderName ?? null });
    return { ok: true, id, uid };
  });

  app.put('/v1/tokens/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'token:write' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw new NotFoundError('card not found');
    const owner = await tokens.tokenOwner(id);
    if (!owner || owner.org_id !== req.principal.orgId) throw new NotFoundError('card not found');
    const t = tokenInputFrom(req.body ?? {});
    delete t.uid; // the UID is the card; changing it is issuing a new card
    const errors = tokens.validateToken(t, false);
    if (Object.keys(errors).length) return clientError(reply, 422, Object.values(errors)[0]!, { errors });
    const pinHash = t.pin === undefined ? undefined : t.pin ? await users.hashPassword(t.pin) : null;
    delete t.pin;
    await tokens.updateToken(id, t, pinHash);
    await audit(req, t.status === 'Blocked' ? 'token.blocked' : 'token.updated', 'token', id, t as Record<string, unknown>, {
      status: owner.status,
    });
    // A card shared for roaming: tell the CPOs now (a blocked card must stop working there too).
    const orgId = req.principal.orgId;
    afterResponse(reply.raw, () => syncRoaming(orgId), () => {});
    return {
      ok: true,
      hint:
        t.status && t.status !== owner.status
          ? 'Push the local authorisation list to the site\'s chargers so offline units learn the new status.'
          : undefined,
    };
  });

  // =================================================================== tariffs (Module 5)

  app.put('/v1/sites/:siteId/tariff', async (req, reply) => {
    const { siteId } = req.params as { siteId: string };
    if (!UUID_RE.test(siteId)) throw new NotFoundError('site not found');
    await ownedSite(req, siteId, 'tariff:write');
    const b = (req.body ?? {}) as any;
    if (!UUID_RE.test(String(b.tariffId))) throw new NotFoundError('tariff not found');
    const owned = await one(`SELECT id FROM tariff WHERE id = $1 AND org_id = $2`, [String(b.tariffId), req.principal.orgId]);
    if (!owned) throw new NotFoundError('tariff not found');
    const currentType = b.currentType === 'AC' || b.currentType === 'DC' ? b.currentType : null;
    const r = await assignTariff(String(b.tariffId), 'site', siteId, Number(b.priority ?? 0), currentType);
    if (!r.ok) return clientError(reply, 409, 'this tariff is not legal for the connectors at that site', { flags: r.flags });
    await audit(req, 'tariff.assigned', 'tariff', String(b.tariffId), { scopeType: 'site', scopeId: siteId, currentType });
    return { ok: true, flags: r.flags };
  });

  app.delete('/v1/tariff-assignments/:id', async (req) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw new NotFoundError('assignment not found');
    if (!(await unassignTariff(id, req.principal.orgId))) throw new NotFoundError('assignment not found');
    await audit(req, 'tariff.unassigned', 'tariff_assignment', id);
    return { ok: true };
  });

  app.post('/v1/tariffs/:id/archive', async (req) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw new NotFoundError('tariff not found');
    if (!(await archiveTariff(id, req.principal.orgId))) throw new NotFoundError('tariff not found or already archived');
    await audit(req, 'tariff.archived', 'tariff', id);
    return { ok: true };
  });

  // =================================================================== sessions (Module 8)

  /** Reject filter values that would reach a uuid/timestamptz parameter malformed (a 500 otherwise). */
  function sessionFilterProblem(q: Record<string, unknown>): string | null {
    for (const [k, v] of Object.entries(q)) if (v !== undefined && typeof v !== 'string') return `${k} must be given once`;
    if (q.siteId && !UUID_RE.test(String(q.siteId))) return 'invalid site';
    for (const k of ['from', 'to'] as const) {
      if (q[k] && Number.isNaN(new Date(String(q[k])).getTime())) return `${k} must be a date`;
    }
    return null;
  }

  app.get('/v1/sessions/search', async (req, reply) => {
    assertCanAny(req.principal, 'session:read');
    const q = (req.query ?? {}) as Record<string, string>;
    const bad = sessionFilterProblem(q);
    if (bad) return clientError(reply, 400, bad);
    const f: SessionFilter = {
      ...(q as unknown as SessionFilter),
      limit: limitParam(q.limit, 100, 500),
      offset: offsetParam(q.offset),
    };
    return searchSessions(req.principal.orgId, f, visibleSiteIds(req.principal, 'session:read'));
  });

  app.get('/v1/sessions.csv', async (req, reply) => {
    assertCanAny(req.principal, 'session:export');
    const q = (req.query ?? {}) as Record<string, string>;
    const bad = sessionFilterProblem(q);
    if (bad) return clientError(reply, 400, bad);
    const { limit: _l, offset: _o, ...filters } = q;
    const csv = await sessionsCsv(req.principal.orgId, filters as unknown as SessionFilter, visibleSiteIds(req.principal, 'session:read'));
    await audit(req, 'session.exported', 'session', 'csv', { filters: q });
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="plugsure-sessions-${new Date().toISOString().slice(0, 10)}.csv"`);
    return '﻿' + csv; // BOM so Excel opens UTF-8 (site names) correctly
  });

  app.get('/v1/sessions/:id/receipt', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw new NotFoundError('not found');
    const owner = await orgOfSession(id);
    if (!owner) throw new NotFoundError('not found');
    assertCan(req.principal, { permission: 'session:read', orgId: owner.orgId, siteId: owner.siteId });
    const html = await receiptHtml(id, visibleSiteIds(req.principal, 'session:read') !== null);
    if (!html) throw new NotFoundError('not found');
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return html;
  });

  // =================================================================== DLM (Module 4)

  app.put('/v1/sites/:siteId/power/priorities', async (req) => {
    const { siteId } = req.params as { siteId: string };
    if (!UUID_RE.test(siteId)) throw new NotFoundError('site not found');
    await ownedSite(req, siteId, 'smartcharging:write');
    const list = Array.isArray((req.body as any)?.priorities) ? (req.body as any).priorities : [];
    for (const p of list) {
      const uuid = String(p.connectorUuid ?? '');
      if (!UUID_RE.test(uuid)) throw new BadRequestError('invalid connector');
      const own = await cps.connectorOwner(uuid);
      if (!own || own.site_id !== siteId) throw new BadRequestError('connector is not at this site');
      await cps.setConnectorPriority(uuid, Number(p.priority ?? 0));
    }
    await audit(req, 'site.power_priorities.changed', 'site', siteId, { priorities: list });
    return { ok: true };
  });

  app.post('/v1/sites/:siteId/power/curtail', async (req, reply) => {
    const { siteId } = req.params as { siteId: string };
    if (!UUID_RE.test(siteId)) throw new NotFoundError('site not found');
    const owner = await ownedSite(req, siteId, 'smartcharging:write');
    const b = (req.body ?? {}) as any;
    const curtailed = Boolean(b.curtailed);
    const reason = b.reason ? String(b.reason).slice(0, 200) : curtailed ? 'Genset / grid outage' : null;
    const budget = await loadSiteBudget(siteId);
    await query(
      `INSERT INTO site_power_budget (site_id, ceiling_w, curtailed, curtailed_at, curtailed_reason)
       VALUES ($1, $2, $3, CASE WHEN $3 THEN now() END, $4)
       ON CONFLICT (site_id) DO UPDATE SET curtailed = $3,
         curtailed_at = CASE WHEN $3 THEN now() END, curtailed_reason = $4, updated_at = now()`,
      [siteId, budget?.ceilingW ?? 0, curtailed, reason],
    );
    await writeAudit({
      orgId: owner.orgId,
      actorType: 'user',
      actorId: req.principal.userId,
      action: curtailed ? 'site.curtailed' : 'site.curtailment_lifted',
      targetType: 'site',
      targetId: siteId,
      after: { curtailed, reason },
      ip: req.ip,
    });
    // Dispatch the moment the change has committed (milliseconds after this
    // reply). On curtailment this sends the 0 W station ceilings; on release it
    // restores the allocation. It runs outside the request transaction so a
    // dispatch failure can never roll back the curtailment itself.
    afterResponse(reply.raw, () => runControlLoop(siteId), (e) =>
      logger.warn({ siteId, err: e.message }, 'curtailment dispatch failed'),
    );
    return { ok: true, curtailed, dispatch: 'started' };
  });

  // =================================================================== firmware (Module 9)

  app.get('/v1/firmware/images', async (req) => {
    assertCan(req.principal, { permission: 'firmware:read' });
    return firmware.listImages(req.principal.orgId);
  });

  app.post('/v1/firmware/images', async (req, reply) => {
    assertCan(req.principal, { permission: 'firmware:write' });
    const b = (req.body ?? {}) as any;
    const meta = imageMetaFrom(b);
    if (typeof meta === 'string') return clientError(reply, 400, meta);
    const url = String(b.url ?? '').trim();
    if (!/^https:\/\/[^\s]+$/i.test(url)) return clientError(reply, 400, 'enter the HTTPS download URL of the firmware');
    let parsed: URL;
    try { parsed = new URL(url); } catch { return clientError(reply, 400, 'enter the HTTPS download URL of the firmware'); }
    const refused = refuseHttpsUrl(parsed);
    if (refused) return clientError(reply, 400, `firmware URL refused: ${refused}`);
    const r = await firmware.createImage(req.principal.orgId, meta, { kind: 'url', url }, req.principal.userId);
    if (!r.ok) return clientError(reply, 400, r.error);
    await audit(req, 'firmware.image_added', 'firmware_image', r.id, { ...meta, url } as Record<string, unknown>);
    return r;
  });

  /**
   * Binary upload. The body is the raw file (Content-Type application/octet-stream);
   * the metadata travels in the query string so the file can be streamed.
   */
  app.post('/v1/firmware/images/upload', { bodyLimit: config.storage.maxFirmwareBytes }, async (req, reply) => {
    assertCan(req.principal, { permission: 'firmware:write' });
    const q = (req.query ?? {}) as Record<string, string>;
    const meta = imageMetaFrom({ ...q, compatibleModels: q.compatibleModels ? q.compatibleModels.split(',') : [] });
    if (typeof meta === 'string') return clientError(reply, 400, meta);
    const body = req.body as unknown;
    if (!(body instanceof Readable) && !(body && typeof (body as any).pipe === 'function')) {
      return clientError(reply, 400, 'send the firmware file as the request body with Content-Type application/octet-stream');
    }
    const fileName = safeFileName(q.fileName, `${meta.name}-${meta.version}.bin`);
    let saved: Awaited<ReturnType<typeof saveStream>>;
    try {
      saved = await saveStream('firmware', fileName, body as Readable, config.storage.maxFirmwareBytes);
    } catch (e) {
      if (e instanceof TooLargeError) return clientError(reply, 413, e.message);
      throw e;
    }
    if (saved.size === 0) return clientError(reply, 400, 'the uploaded file is empty');
    const r = await firmware.createImage(
      req.principal.orgId,
      meta,
      { kind: 'upload', path: saved.path, fileName, size: saved.size, sha256: saved.sha256 },
      req.principal.userId,
    );
    if (!r.ok) {
      await import('node:fs/promises').then((fs) => fs.rm(saved.path, { force: true })).catch(() => {});
      return clientError(reply, 400, r.error);
    }
    await audit(req, 'firmware.image_uploaded', 'firmware_image', r.id, { ...meta, fileName, size: saved.size, sha256: saved.sha256 } as Record<string, unknown>);
    return { ...r, sha256: saved.sha256, size: saved.size };
  });

  function imageMetaFrom(b: any): firmware.ImageMeta | string {
    const name = String(b.name ?? '').trim();
    const version = String(b.version ?? '').trim();
    if (!name) return 'give the image a name';
    if (!version || version.length > 100) return 'enter the firmware version string the charger will report';
    if (b.sha256 && !firmware.normaliseSha256(b.sha256)) return 'SHA-256 must be 64 hex characters';
    const models = (Array.isArray(b.compatibleModels) ? b.compatibleModels : String(b.compatibleModels ?? '').split(','))
      .map((m: unknown) => String(m).trim())
      .filter(Boolean)
      .slice(0, 50);
    return {
      name: name.slice(0, 200),
      version: version.slice(0, 100),
      vendor: b.vendor ? String(b.vendor).slice(0, 100) : null,
      compatibleModels: models,
      sha256: b.sha256 ? String(b.sha256) : null,
      notes: b.notes ? String(b.notes).slice(0, 2000) : null,
    };
  }

  app.post('/v1/firmware/images/:id/verify', async (req, reply) => {
    assertCan(req.principal, { permission: 'firmware:write' });
    const { id } = req.params as { id: string };
    const owned = UUID_RE.test(id) && (await one(`SELECT 1 FROM firmware_image WHERE id = $1 AND org_id = $2`, [id, req.principal.orgId]));
    if (!owned) throw new NotFoundError('image not found');
    const r = await firmware.verifyRemoteChecksum(id, config.storage.maxFirmwareBytes);
    await audit(req, 'firmware.image_verified', 'firmware_image', id, r as Record<string, unknown>);
    return r.ok ? r : clientError(reply, 422, r.error ?? 'verification failed');
  });

  app.post('/v1/firmware/images/:id/archive', async (req) => {
    assertCan(req.principal, { permission: 'firmware:write' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw new NotFoundError('image not found');
    const r = await query(`UPDATE firmware_image SET archived_at = now() WHERE id = $1 AND org_id = $2`, [id, req.principal.orgId]);
    if (!r.rowCount) throw new NotFoundError('image not found');
    await audit(req, 'firmware.image_archived', 'firmware_image', id);
    return { ok: true };
  });

  app.get('/v1/firmware/campaigns', async (req) => {
    assertCan(req.principal, { permission: 'firmware:read' });
    return firmware.listCampaigns(req.principal.orgId);
  });

  app.post('/v1/firmware/campaigns', async (req, reply) => {
    assertCan(req.principal, { permission: 'firmware:write' });
    const b = (req.body ?? {}) as any;
    const input: firmware.CampaignInput = {
      imageId: String(b.imageId ?? ''),
      name: String(b.name ?? ''),
      targetType: b.targetType,
      targetIds: Array.isArray(b.targetIds) ? b.targetIds.map(String).filter((x: string) => UUID_RE.test(x)) : [],
      windowStart: b.windowStart || null,
      windowEnd: b.windowEnd || null,
      maxRetries: b.maxRetries != null ? Number(b.maxRetries) : undefined,
      retryIntervalS: b.retryIntervalS != null ? Number(b.retryIntervalS) : undefined,
    };
    if (!UUID_RE.test(input.imageId)) return clientError(reply, 400, 'choose a firmware image');
    const problems = firmware.validateCampaign(input);
    if (problems.length) return clientError(reply, 422, problems[0]!, { problems });
    const r = await firmware.createCampaign(req.principal.orgId, input, req.principal.userId);
    if (!r.ok) return clientError(reply, 422, r.error);
    await audit(req, 'firmware.campaign_created', 'firmware_campaign', r.id, input as unknown as Record<string, unknown>);
    // The FOTA scheduler (gateway workers, every 30 s) dispatches the jobs; it is not
    // kicked from here, because a scheduler pass must never share this request's transaction.
    return r;
  });

  app.get('/v1/firmware/campaigns/:id', async (req) => {
    assertCan(req.principal, { permission: 'firmware:read' });
    const { id } = req.params as { id: string };
    const c = UUID_RE.test(id)
      ? await one<any>(
          `SELECT c.*, i.name AS image_name, i.version AS image_version FROM firmware_campaign c
             JOIN firmware_image i ON i.id = c.image_id WHERE c.id = $1 AND c.org_id = $2`,
          [id, req.principal.orgId],
        )
      : null;
    if (!c) throw new NotFoundError('campaign not found');
    return { campaign: c, jobs: await firmware.campaignJobs(id), stages: firmware.STAGES };
  });

  app.post('/v1/firmware/campaigns/:id/cancel', async (req) => {
    assertCan(req.principal, { permission: 'firmware:write' });
    const { id } = req.params as { id: string };
    const owned = UUID_RE.test(id) && (await one(`SELECT 1 FROM firmware_campaign WHERE id = $1 AND org_id = $2`, [id, req.principal.orgId]));
    if (!owned) throw new NotFoundError('campaign not found');
    await firmware.cancelCampaign(id);
    await audit(req, 'firmware.campaign_cancelled', 'firmware_campaign', id);
    return { ok: true };
  });

  app.post('/v1/firmware/campaigns/:id/retry-failed', async (req) => {
    assertCan(req.principal, { permission: 'firmware:write' });
    const { id } = req.params as { id: string };
    const owned = UUID_RE.test(id) && (await one(`SELECT 1 FROM firmware_campaign WHERE id = $1 AND org_id = $2`, [id, req.principal.orgId]));
    if (!owned) throw new NotFoundError('campaign not found');
    const r = await query(
      `UPDATE firmware_job SET state = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
        WHERE campaign_id = $1 AND state = 'failed'`,
      [id],
    );
    await query(`UPDATE firmware_campaign SET status = 'running', completed_at = NULL WHERE id = $1 AND status <> 'cancelled'`, [id]);
    await audit(req, 'firmware.campaign_retried', 'firmware_campaign', id, { jobs: r.rowCount });
    return { ok: true, retried: r.rowCount };
  });

  // =================================================================== diagnostics (Module 9.2)

  app.get('/v1/charge-points/:identity/diagnostics', async (req) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'charge_point:read');
    const rows = await diagnostics.listDiagnostics(req.principal.orgId, owner.chargePointId);
    // A site-scoped user does not see requests from before the charger joined its site.
    if (visibleSiteIds(req.principal, 'charge_point:read') === null) return rows;
    const floor = await siteAssignedAt(identity);
    return floor ? rows.filter((r: any) => new Date(r.requested_at) >= floor) : rows;
  });

  app.post('/v1/charge-points/:identity/diagnostics', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'charge_point:read');
    if (!can(req.principal, { permission: 'charge_point:config', orgId: owner.orgId, siteId: owner.siteId }) &&
        !can(req.principal, { permission: 'charge_point:command', orgId: owner.orgId, siteId: owner.siteId })) {
      assertCan(req.principal, { permission: 'charge_point:config', orgId: owner.orgId, siteId: owner.siteId });
    }
    if (!registry.isOnline(identity)) return clientError(reply, 409, 'the charger is offline');
    const b = (req.body ?? {}) as any;
    const r = await diagnostics.requestDiagnostics({
      orgId: owner.orgId,
      chargePointId: owner.chargePointId,
      identity,
      startTime: b.startTime || null,
      stopTime: b.stopTime || null,
      location: b.location || null,
      origin: requestOrigin(req),
      actor: actorOf(req),
      requestedBy: req.principal.userId,
    });
    if (!r.ok) return clientError(reply, 422, r.error, { id: (r as any).id });
    return r;
  });

  async function ownedDiagnostics(req: FastifyRequest, id: string) {
    const d = UUID_RE.test(id)
      ? await one<{ org_id: string; storage_path: string | null; file_name: string | null; charge_point_id: string }>(
          `SELECT org_id, storage_path, file_name, charge_point_id FROM diagnostics_request WHERE id = $1`,
          [id],
        )
      : null;
    if (!d || d.org_id !== req.principal.orgId) throw new NotFoundError('diagnostics not found');
    assertCan(req.principal, { permission: 'charge_point:read' });
    return d;
  }

  app.get('/v1/diagnostics/:id/content', async (req) => {
    const { id } = req.params as { id: string };
    const d = await ownedDiagnostics(req, id);
    if (!d.storage_path) return { available: false, note: 'no file has been received for this request' };
    return { available: true, fileName: d.file_name, ...(await diagnostics.logContent(d.storage_path)) };
  });

  app.get('/v1/diagnostics/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const d = await ownedDiagnostics(req, id);
    if (!d.storage_path) throw new NotFoundError('no file received');
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${safeFileName(d.file_name ?? undefined, 'diagnostics.log')}"`);
    return reply.send(createReadStream(d.storage_path));
  });

  // =================================================================== live frame stream

  /**
   * SSE of raw OCPP frames for this organisation (optionally one charger).
   * Reads the frame log rather than the event bus, so it works identically in
   * the single-process and split deployments without relaying every frame.
   * Outside the org-scoped transaction (a long-lived stream cannot hold a
   * pooled client), so every query filters by org explicitly.
   */
  app.get('/v1/events/frames', async (req, reply) => {
    assertCanAny(req.principal, 'charge_point:read');
    const orgId = req.principal.orgId;
    const identity = String((req.query as any)?.identity ?? '') || null;
    if (identity) await ownedChargePoint(req, identity, 'charge_point:read');
    const visible = visibleSiteIds(req.principal, 'charge_point:read');
    // The OCPP log (drivers' idTags) is for operators and field technicians, not
    // read-only site-scoped viewers (Site Owner, Site Host). See server.ts.
    if (visible !== null) {
      const held = heldPermissions(req.principal);
      if (!held.has('charge_point:config') && !held.has('charge_point:command')) {
        return clientError(reply, 403, 'The OCPP log is available to operators and field technicians.');
      }
    }

    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    let lastId = Number((await one<{ id: number }>(`SELECT COALESCE(max(id), 0)::bigint AS id FROM ocpp_frame`))?.id ?? 0);
    let closed = false;
    const poll = async () => {
      if (closed) return;
      try {
        const rows = await many<any>(
          `SELECT f.id, f.ts, f.ocpp_identity, f.direction, f.message_type, f.action, f.unique_id, f.payload
             FROM ocpp_frame f JOIN charge_point cp ON cp.id = f.charge_point_id JOIN site s ON s.id = cp.site_id
            WHERE f.id > $1 AND s.org_id = $2 AND ($3::text IS NULL OR f.ocpp_identity = $3)
              AND ($4::uuid[] IS NULL OR s.id = ANY($4))
            ORDER BY f.id LIMIT 200`,
          [lastId, orgId, identity, visible],
        );
        for (const r of rows) {
          lastId = Math.max(lastId, Number(r.id));
          reply.raw.write(`data: ${JSON.stringify(r)}\n\n`);
        }
      } catch {
        /* transient; next poll retries */
      }
    };
    const t = setInterval(() => void poll(), 1500);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      closed = true;
      clearInterval(t);
      clearInterval(ping);
    });
  });

  // =================================================================== public: firmware download & log upload

  /**
   * Charger-facing, UNAUTHENTICATED by necessity (chargers cannot log in). The
   * unguessable token in the path is the capability; nothing is listed or
   * enumerable. It is served only while a campaign needs it (and a grace period
   * after), and never once the image is archived.
   */
  app.get('/fw/:token/:name', async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return reply.status(404).send({ error: 'not found' });
    // Only while a campaign needs it (services/firmware.ts, downloadableImage).
    const img = await firmware.downloadableImage(token);
    if (!img?.storage_path) return reply.status(404).send({ error: 'not found' });
    reply.header('Content-Type', 'application/octet-stream');
    if (img.size_bytes) reply.header('Content-Length', String(img.size_bytes));
    reply.header('Content-Disposition', `attachment; filename="${safeFileName(img.file_name ?? undefined, 'firmware.bin')}"`);
    return reply.send(createReadStream(img.storage_path));
  });

  const receiveDiag = async (req: FastifyRequest, reply: FastifyReply) => {
    const { token, name } = req.params as { token: string; name?: string };
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return reply.status(404).send({ error: 'not found' });
    const d = await diagnostics.diagnosticsByToken(token);
    // One upload per request: a used token is spent.
    if (!d || d.storage_path) return reply.status(404).send({ error: 'not found' });
    const ct = String(req.headers['content-type'] ?? '');
    let source: Readable;
    let fileName = safeFileName(name, 'diagnostics.log');
    if (Buffer.isBuffer(req.body) && /^multipart\/form-data/i.test(ct)) {
      const part = diagnostics.extractMultipartFile(req.body, ct);
      if (!part) return reply.status(400).send({ error: 'no file in the multipart body' });
      fileName = safeFileName(part.name, fileName);
      source = Readable.from([part.data]);
    } else if (req.body && typeof (req.body as any).pipe === 'function') {
      source = req.body as Readable;
    } else if (Buffer.isBuffer(req.body)) {
      source = Readable.from([req.body]);
    } else if (typeof req.body === 'string') {
      source = Readable.from([Buffer.from(req.body)]);
    } else if (req.body !== undefined && req.body !== null) {
      // A JSON body was already parsed; store it as sent.
      source = Readable.from([Buffer.from(JSON.stringify(req.body))]);
    } else {
      // Some chargers send the file with no or an unusual content type: the raw request stream.
      source = req.raw;
    }
    try {
      const saved = await saveStream('diagnostics', fileName, source, config.storage.maxDiagnosticsBytes);
      await diagnostics.recordUpload(d.id, saved.path, saved.size, fileName);
      logger.info({ diagnosticsId: d.id, size: saved.size }, 'diagnostics file received');
      return reply.status(201).send({ ok: true });
    } catch (e) {
      if (e instanceof TooLargeError) return reply.status(413).send({ error: e.message });
      throw e;
    }
  };
  for (const method of ['PUT', 'POST'] as const) {
    app.route({ method, url: '/diag/:token', bodyLimit: config.storage.maxDiagnosticsBytes, handler: receiveDiag });
    app.route({ method, url: '/diag/:token/:name', bodyLimit: config.storage.maxDiagnosticsBytes, handler: receiveDiag });
  }
}
