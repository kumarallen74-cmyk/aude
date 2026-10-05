import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { one, query, outsideRequestScope } from '../db/pool.js';
import { persistAlert } from '../services/alerts.js';
import { opsAlertOrgs } from '../services/worker-health.js';
import { assertCan } from '../services/authz.js';
import { adminHostAllowed, createSession } from '../services/auth.js';
import { writeAudit } from '../services/audit.js';
import { consoleBrandForHost } from '../services/console-brand.js';
import { TokenBuckets } from '../services/ratelimit.js';
import { sandboxInfo } from '../sandbox/provision.js';
import {
  MS_CALLBACK_PATH, MS_START_PATH, MS_TX_MAX_PER_BROWSER, MS_TX_TTL_MINUTES, msTxCookie, sha256Hex, endPendingOneTimePassword,
  listAllTenants, releaseTenant,
  MicrosoftSignInError, SignInRefused, finishMicrosoftFlow, linkTenant, linkedTenant, microsoftEnabled, normaliseDomains,
  redirectUriFor, resolveMicrosoftUser, setAllowedDomains, startMicrosoftFlow, unlinkTenant, type ConsumedTx,
} from '../services/microsoft-signin.js';
import { sessionCookie } from './console-routes.js';

/**
 * "Sign in with Microsoft" (services/microsoft-signin.ts has the protocol and the rules).
 *
 * Public — the browser navigates to these, before anyone is signed in (server.ts lets them
 * past authentication; they authenticate by the OIDC transaction and its binding cookie):
 *   GET  /console-sign-in.json            { microsoft: true } when the button belongs on this host; multiCountry
 *   GET  /v1/auth/microsoft/start         → 302 to Microsoft (sign-in)
 *   GET  /v1/auth/microsoft/callback      ← Microsoft; → 303 to the console (/ or /?ms=<reason>)
 *
 * The organisation's administrator (user:write; user:read to look):
 *   POST   /v1/auth/microsoft/link        start "Connect Microsoft tenant": { url } to open
 *   GET    /v1/auth/microsoft/tenant      the connected tenant, or null, and the redirect URI
 *   PUT    /v1/auth/microsoft/tenant      { allowedDomains }
 *   DELETE /v1/auth/microsoft/tenant      disconnect (unbinds every user, ends Microsoft sessions)
 * (DELETE /v1/users/:id/microsoft, unbinding one user, is with the other user routes.)
 *
 * With MS_CLIENT_ID unset every one of these answers 404 and the JSON says microsoft: false.
 * Start and callback are rate limited per client address (MS_SIGNIN_RATE_PER_MIN, default 60
 * a minute, on top of the API's own per-address limit). Codes and tokens are never logged.
 */

/**
 * Every tenant connection is reported to the PLATFORM operator as an alert (the organisations of
 * OPS_ALERT_ORG_ID / its platform administrators, as for worker alerts): a tenant can belong to
 * one organisation only, so a wrong claim must be noticed — and released (DELETE
 * /v1/platform/microsoft-tenants/:tenantId). One alert per tenant while open; failures to raise
 * it are logged, never fail the connection.
 */
export const TENANT_LINKED_ALERT = 'platform.microsoft_tenant_linked';
async function tellPlatformOperator(orgId: string, tenantId: string, account: string | null, role: string): Promise<void> {
  try {
    const org = await one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [orgId]);
    for (const opsOrg of await opsAlertOrgs()) {
      await persistAlert({
        orgId: opsOrg,
        kind: TENANT_LINKED_ALERT,
        severity: 'warning',
        message: `Organisation "${org?.name ?? orgId}" connected Microsoft tenant ${tenantId} for console sign-in (proved by ${account ?? 'an account'} as ${role}). ` +
          'If that organisation does not own this tenant, release it under Users & Roles → Microsoft sign-in → All connected tenants.',
        targetType: 'microsoft_tenant',
        targetId: tenantId,
      });
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message, orgId, tenantId }, 'could not raise the tenant-connection alert for the platform operator');
  }
}

export function isPublicMicrosoftRoute(route: string, method: string): boolean {
  return method === 'GET' && (route === MS_START_PATH || route === MS_CALLBACK_PATH);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The browser-binding cookie (microsoft-signin.ts msTxCookie: `__Host-ps_ms_tx` on https,
 * SameSite=Lax, ten minutes). Its value is the binding values of the sign-ins this browser has
 * in progress, newest first, joined by "." (base64url has no "."), at most MS_TX_MAX_PER_BROWSER:
 * starting a second sign-in in another tab no longer breaks the first.
 */
function bindingCookie(values: string[]): string {
  const c = msTxCookie(config.console.cookieSecure);
  const parts = [
    `${c.name}=${values.join('.')}`,
    `Path=${c.path}`,
    'HttpOnly',
    'SameSite=Lax',
    values.length ? `Max-Age=${MS_TX_TTL_MINUTES * 60}` : 'Max-Age=0',
  ];
  if (config.console.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

const BINDING_VALUE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The binding values the request carries. A malformed value, or the cookie name appearing MORE
 * THAN ONCE (a planted duplicate: which one the server reads first depends on the browser), is
 * no binding at all — never "take the first".
 */
export function bindingsFromCookie(header: unknown, secure = config.console.cookieSecure): string[] {
  if (typeof header !== 'string') return [];
  const { name } = msTxCookie(secure);
  const found: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq >= 0 && part.slice(0, eq).trim() === name) found.push(part.slice(eq + 1).trim());
  }
  if (found.length !== 1) return [];
  const values = found[0]!.split('.');
  if (values.length > MS_TX_MAX_PER_BROWSER || !values.every((v) => BINDING_VALUE.test(v))) return [];
  return values;
}

/** Where the console shows the outcome: /?ms=<code>, on the Microsoft panel for a tenant connection. */
const consoleUrl = (code: string | null, mode: 'signin' | 'link' = 'signin') =>
  `/${code ? `?ms=${encodeURIComponent(code)}` : ''}${mode === 'link' ? '#/users/microsoft' : ''}`;

function ratePerMin(): number {
  const n = Number(process.env.MS_SIGNIN_RATE_PER_MIN);
  return Number.isInteger(n) && n > 0 ? n : 60;
}

/** This browser's sign-ins in progress plus a new one, newest first (the oldest drops off). */
const withBinding = (req: FastifyRequest, value: string) =>
  [value, ...bindingsFromCookie(req.headers.cookie)].slice(0, MS_TX_MAX_PER_BROWSER);

export async function registerMicrosoftRoutes(app: FastifyInstance): Promise<void> {
  const buckets = new TokenBuckets();
  /** One bucket per client address for start + callback together. */
  const limited = (req: FastifyRequest) => !buckets.take(`ms:${req.ip ?? 'unknown'}`, ratePerMin()).allowed;
  const notFound = (reply: FastifyReply) => reply.status(404).send({ error: 'not found' });
  /** Browser navigations: a plain redirect, no caching, no referrer (the callback URL carries a code). */
  const go = (reply: FastifyReply, url: string, status = 303) => reply.header('cache-control', 'no-store').redirect(url, status);

  // ---------------------------------------------------------------- public

  app.get('/console-sign-in.json', async (req, reply) => {
    reply.header('cache-control', 'no-cache');
    // multiCountry: the sign-in page's copy names Malaysia and Singapore only on a deployment that
    // offers them (MULTI_COUNTRY); an Indonesian installation keeps v1.5's wording.
    return { microsoft: microsoftEnabled() && redirectUriFor(req.headers.host, req.protocol) !== null, multiCountry: config.features.multiCountry };
  });

  app.get('/v1/auth/microsoft/start', async (req, reply) => {
    if (!microsoftEnabled()) return notFound(reply);
    if (limited(req)) return go(reply, consoleUrl('rate_limited'));
    try {
      const started = await startMicrosoftFlow({ mode: 'signin', host: req.headers.host, protocol: req.protocol, ip: req.ip });
      reply.header('set-cookie', bindingCookie(withBinding(req, started.binding)));
      await writeAudit({
        orgId: null, actorType: 'user', actorId: null, action: 'auth.microsoft_started',
        targetType: 'user', targetId: null, after: { mode: 'signin' }, ip: req.ip,
      }).catch(() => {});
      return go(reply, started.url, 302);
    } catch (e) {
      if (e instanceof MicrosoftSignInError) {
        logger.warn({ reason: e.code, detail: e.detail, ip: req.ip }, 'Microsoft sign-in could not start');
        return go(reply, consoleUrl(e.code));
      }
      throw e;
    }
  });

  app.get('/v1/auth/microsoft/callback', async (req, reply) => {
    if (!microsoftEnabled()) return notFound(reply);
    if (limited(req)) return go(reply, consoleUrl('rate_limited'));
    const q = (req.query ?? {}) as Record<string, unknown>;
    const bindings = bindingsFromCookie(req.headers.cookie);
    // This sign-in's binding value is single use, like the transaction: the cookie keeps the
    // others (another tab's sign-in still in progress). Before the state is known, nothing changes.
    const cookies: string[] = [];
    let tx: ConsumedTx | null = null;
    try {
      const f = await finishMicrosoftFlow(
        { state: q.state, code: q.code, error: q.error, errorDescription: q.error_description, bindings, host: req.headers.host },
        (t) => {
          tx = t;
          cookies.push(bindingCookie(bindings.filter((b) => sha256Hex(b) !== t.browserHash)));
        },
      );

      if (f.mode === 'link') {
        const t = await linkTenant(f);
        await writeAudit({
          orgId: f.orgId, actorType: 'user', actorId: f.userId, action: 'org.microsoft_tenant_linked',
          targetType: 'organisation', targetId: f.orgId,
          after: { provider: 'microsoft', tenantId: t.tenantId, provenBy: t.linkedByAccount, provenRole: t.provenRole, oid: f.claims.oid }, ip: req.ip,
        });
        await tellPlatformOperator(f.orgId!, t.tenantId, t.linkedByAccount, t.provenRole);
        reply.header('set-cookie', cookies);
        return go(reply, consoleUrl('linked', 'link'));
      }

      // On an operator's own console address only its own accounts (v1.5.0); outside
      // CONSOLE_ADMIN_HOSTS no administrator — exactly as for a password.
      const hostBrand = await consoleBrandForHost(f.host).catch(() => null);
      const user = await resolveMicrosoftUser(f.claims, { onlyOrgId: hostBrand?.orgId ?? null, refuseAdministrators: !adminHostAllowed(f.host) });
      const account = f.claims.preferredUsername ?? f.claims.email;
      if (user.boundNow) {
        await writeAudit({
          orgId: user.orgId, actorType: 'user', actorId: user.id, action: 'user.microsoft_bound', targetType: 'user', targetId: user.id,
          after: { tenantId: f.claims.tid, oid: f.claims.oid, matchedBy: account }, ip: req.ip,
        });
      }
      /*
       * Two-step verification, as for a password:
       *   · Microsoft reported MFA (amr contains "mfa", MS_TRUST_MFA_CLAIM not off): a full
       *     session that counts as having its second factor (no code step, no forced enrolment);
       *   · otherwise, an account with an authenticator app: a PENDING session, the code step;
       *   · otherwise a full session, which the enrolment hold catches if the account is an
       *     administrator that must enrol (api/session-holds.ts) — the same grace path.
       * The failure counter is left alone: a Microsoft sign-in proves nothing about who has
       * been guessing the console password. A locked account was refused above.
       */
      const pending = !user.mfaSatisfied && user.mfaEnabled;
      const token = await createSession(user.id, { authMethod: 'microsoft', mfaPending: pending, idpMfa: user.mfaSatisfied });
      if (!pending) {
        await query(`UPDATE app_user SET last_login_at = now() WHERE id = $1`, [user.id]);
        if (await endPendingOneTimePassword(user.id)) {
          await writeAudit({
            orgId: user.orgId, actorType: 'user', actorId: user.id, action: 'user.one_time_password_ended', targetType: 'user', targetId: user.id,
            after: { reason: 'signed in with Microsoft' }, ip: req.ip,
          });
        }
      }
      cookies.push(sessionCookie(token));
      await writeAudit({
        orgId: user.orgId, actorType: 'user', actorId: user.id, action: pending ? 'auth.login_mfa_challenge' : 'auth.login',
        targetType: 'user', targetId: user.id,
        after: { method: 'microsoft', tenantId: f.claims.tid, account, ...(user.mfaSatisfied ? { secondFactor: 'microsoft_mfa' } : {}) },
        ip: req.ip,
      });
      reply.header('set-cookie', cookies);
      return go(reply, consoleUrl(null));
    } catch (e) {
      if (cookies.length) reply.header('set-cookie', cookies);
      const consumed = tx as ConsumedTx | null;
      const mode = consumed?.mode ?? 'signin';
      if (e instanceof MicrosoftSignInError) {
        const orgId = (e instanceof SignInRefused ? e.orgId : null) ?? consumed?.orgId ?? null;
        const userId = (e instanceof SignInRefused ? e.userId : null) ?? consumed?.userId ?? null;
        logger.warn({ reason: e.code, detail: e.detail, mode, orgId, ip: req.ip }, 'Microsoft sign-in refused');
        await writeAudit({
          orgId, actorType: 'user', actorId: mode === 'link' ? userId : null,
          action: mode === 'link' ? 'org.microsoft_tenant_link_failed' : 'auth.microsoft_refused',
          targetType: userId ? 'user' : 'organisation', targetId: userId ?? orgId,
          after: { reason: e.code, detail: e.detail.slice(0, 300) }, ip: req.ip,
        }).catch(() => {});
        return go(reply, consoleUrl(e.code, mode));
      }
      logger.error({ err: e, mode }, 'Microsoft sign-in failed unexpectedly');
      return go(reply, consoleUrl('failed', mode));
    }
  });

  // ---------------------------------------------------------------- the organisation's administrator

  /**
   * Start "Connect Microsoft tenant". The administrator then signs in at Microsoft with an
   * account of the tenant to connect; the callback records the tenant of that VALIDATED
   * sign-in (proof that they control an account there), never a tenant id typed in.
   */
  app.post('/v1/auth/microsoft/link', async (req, reply) => {
    if (!microsoftEnabled()) return notFound(reply);
    assertCan(req.principal, { permission: 'user:write' });
    if (!UUID_RE.test(req.principal.userId)) return reply.status(400).send({ error: 'only a signed-in administrator can connect a Microsoft tenant' });
    if (await sandboxInfo(req.principal.orgId)) return reply.status(409).send({ error: 'Microsoft sign-in belongs to a production operator, not a sandbox.' });
    if (await linkedTenant(req.principal.orgId)) return reply.status(409).send({ error: 'A Microsoft tenant is already connected. Disconnect it first.', code: 'already_linked' });
    if (limited(req)) return reply.status(429).send({ error: 'too many attempts — wait a minute', code: 'rate_limited' });
    try {
      const started = await startMicrosoftFlow({
        mode: 'link', host: req.headers.host, protocol: req.protocol, ip: req.ip, orgId: req.principal.orgId, userId: req.principal.userId,
      });
      reply.header('set-cookie', bindingCookie(withBinding(req, started.binding)));
      await writeAudit({
        orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action: 'org.microsoft_tenant_link_started',
        targetType: 'organisation', targetId: req.principal.orgId, ip: req.ip,
      });
      return { url: started.url };
    } catch (e) {
      if (e instanceof MicrosoftSignInError) {
        const msg = e.code === 'wrong_host'
          ? 'Microsoft sign-in is not offered on this console address. Use the address in PUBLIC_BASE_URL (or add this one to MS_SIGNIN_HOSTS).'
          : 'Microsoft cannot be reached just now. Try again in a minute.';
        return reply.status(e.code === 'wrong_host' ? 409 : 502).send({ error: msg, code: e.code });
      }
      throw e;
    }
  });

  app.get('/v1/auth/microsoft/tenant', async (req, reply) => {
    if (!microsoftEnabled()) return notFound(reply);
    assertCan(req.principal, { permission: 'user:read' });
    const tenant = await linkedTenant(req.principal.orgId);
    const bound = await query<{ n: number }>(`SELECT count(*)::int AS n FROM app_user WHERE org_id = $1 AND ms_object_id IS NOT NULL`, [req.principal.orgId]);
    return {
      tenant,
      boundUsers: bound.rows[0]?.n ?? 0,
      // What the platform registered in the Entra admin center for this address, or null when not offered here.
      redirectUri: redirectUriFor(req.headers.host, req.protocol),
    };
  });

  /**
   * Changing or disconnecting the tenant decides who can sign in to the organisation: a signed-in
   * administrator's decision in the console, like connecting it — not something an API key may
   * do (v1.6.0 review).
   */
  const consoleUserOnly = (req: FastifyRequest, reply: FastifyReply) =>
    UUID_RE.test(req.principal.userId) ? null : reply.status(403).send({ error: 'only a signed-in administrator can change Microsoft sign-in', code: 'console_user_required' });

  app.put('/v1/auth/microsoft/tenant', async (req, reply) => {
    if (!microsoftEnabled()) return notFound(reply);
    assertCan(req.principal, { permission: 'user:write' });
    if (consoleUserOnly(req, reply)) return reply;
    let domains: string[];
    try {
      domains = normaliseDomains(((req.body ?? {}) as Record<string, unknown>).allowedDomains);
    } catch (e) {
      return reply.status(400).send({ error: (e as Error).message });
    }
    const before = await linkedTenant(req.principal.orgId);
    if (!before || !(await setAllowedDomains(req.principal.orgId, domains))) return reply.status(404).send({ error: 'No Microsoft tenant is connected.' });
    await writeAudit({
      orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action: 'org.microsoft_tenant_updated',
      targetType: 'organisation', targetId: req.principal.orgId,
      before: { allowedDomains: before.allowedDomains }, after: { allowedDomains: domains }, ip: req.ip,
    });
    return { tenant: await linkedTenant(req.principal.orgId) };
  });

  app.delete('/v1/auth/microsoft/tenant', async (req, reply) => {
    if (!microsoftEnabled()) return notFound(reply);
    assertCan(req.principal, { permission: 'user:write' });
    if (consoleUserOnly(req, reply)) return reply;
    const r = await unlinkTenant(req.principal.orgId);
    if (!r) return reply.status(404).send({ error: 'No Microsoft tenant is connected.' });
    await writeAudit({
      orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action: 'org.microsoft_tenant_unlinked',
      targetType: 'organisation', targetId: req.principal.orgId,
      before: { provider: 'microsoft', tenantId: r.tenantId }, after: { usersUnbound: r.usersUnbound, sessionsEnded: r.sessionsEnded }, ip: req.ip,
    });
    return { ok: true, ...r };
  });

  // ---------------------------------------------------------------- the platform operator

  /** Every organisation's connected tenant (platform:admin). */
  app.get('/v1/platform/microsoft-tenants', async (req, reply) => {
    if (!microsoftEnabled()) return notFound(reply);
    assertCan(req.principal, { permission: 'platform:admin' });
    return { tenants: await listAllTenants() };
  });

  /**
   * Release a tenant from whichever organisation holds it — the supported way out of a squatted
   * tenant (v1.6.0 review): the holder's links and Microsoft sessions end, exactly as when it
   * disconnects itself, and the tenant's real owner can then connect it. Audited in the platform
   * operator's log and in the organisation's own.
   */
  app.delete('/v1/platform/microsoft-tenants/:tenantId', async (req, reply) => {
    if (!microsoftEnabled()) return notFound(reply);
    assertCan(req.principal, { permission: 'platform:admin' });
    if (consoleUserOnly(req, reply)) return reply;
    const { tenantId } = req.params as { tenantId: string };
    if (!UUID_RE.test(tenantId)) return reply.status(404).send({ error: 'No organisation has connected this tenant.' });
    const r = await releaseTenant(tenantId.toLowerCase());
    if (!r) return reply.status(404).send({ error: 'No organisation has connected this tenant.' });
    const after = { provider: 'microsoft', tenantId: tenantId.toLowerCase(), usersUnbound: r.usersUnbound, sessionsEnded: r.sessionsEnded };
    await outsideRequestScope(async () => {
      await writeAudit({
        orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action: 'platform.microsoft_tenant_released',
        targetType: 'organisation', targetId: r.orgId, after, ip: req.ip,
      });
      if (r.orgId !== req.principal.orgId) {
        await writeAudit({
          orgId: r.orgId, actorType: 'user', actorId: req.principal.userId, action: 'org.microsoft_tenant_unlinked',
          targetType: 'organisation', targetId: r.orgId, after: { ...after, byPlatformOperator: true }, ip: req.ip,
        });
      }
    });
    return { ok: true, orgId: r.orgId, usersUnbound: r.usersUnbound, sessionsEnded: r.sessionsEnded };
  });
}
