// PlugSure v1.6.0 — "Sign in with Microsoft" end to end, against the REAL split deployment
// (API as plugsure_app, row-level security in force) and a MOCK Microsoft Entra ID started
// here (tools/testing/mock-entra.ts) on the port of MS_AUTHORITY_BASE.
//
// The API must have been started with the SAME settings this script reads:
//   MS_CLIENT_ID=<a GUID>  MS_CLIENT_SECRET=<anything>  MS_AUTHORITY_BASE=http://127.0.0.1:<port>
//   PUBLIC_BASE_URL=<E2E_API>  (NODE_ENV=development: the outbound guard lets the API reach the
//   loopback mock only outside production)
// and the seed run with SEED_ADMIN_PASSWORD (E2E_PASSWORD, default Console-Test-2026!).
//
//     npx tsx tools/e2e/ms-login-e2e.mts
//
// It connects a fresh random tenant to the seeded organisation, invites a user, signs them in
// with Microsoft, checks the refusals, then unlinks and disconnects again. NEVER point this at
// production.
import { randomUUID } from 'node:crypto';
import { MockEntra, ENTRA_ROLES, type MockIdentity } from '../testing/mock-entra.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const PASSWORD = process.env.E2E_PASSWORD ?? 'Console-Test-2026!';
const results: Array<{ ok: boolean; name: string }> = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push({ ok, name });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`}`);
};

const clientId = process.env.MS_CLIENT_ID ?? '';
const clientSecret = process.env.MS_CLIENT_SECRET ?? '';
const authority = process.env.MS_AUTHORITY_BASE ?? '';
if (!clientId || !clientSecret || !/^http:\/\/127\.0\.0\.1:\d+$/.test(authority)) {
  console.error('Set MS_CLIENT_ID, MS_CLIENT_SECRET and MS_AUTHORITY_BASE=http://127.0.0.1:<port> for both the API and this script.');
  process.exit(2);
}
const mock = new MockEntra({ clientId, clientSecret });

/** A browser: a cookie jar per cookie name, no automatic redirects. */
class Browser {
  jar = new Map<string, string>();
  cookieHeader() { return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  take(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      const k = pair!.slice(0, i).trim();
      const v = pair!.slice(i + 1).trim();
      if (/Max-Age=0/i.test(c) || !v) this.jar.delete(k); else this.jar.set(k, v);
    }
  }
  async req(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (this.jar.size) headers.cookie = this.cookieHeader();
    if (method !== 'GET') headers['x-plugsure-csrf'] = '1';
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    this.take(res);
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, data, headers: res.headers };
  }
  /** Follow the sign-in from `authorizeUrl`: Microsoft (mock) → our callback. Returns where the callback sends us. */
  async viaMicrosoft(authorizeUrl: string) {
    const atMs = await fetch(authorizeUrl, { redirect: 'manual' });
    const back = atMs.headers.get('location') ?? '';
    const cb = await this.req('GET', new URL(back).pathname + new URL(back).search);
    return { status: cb.status, location: cb.headers.get('location') ?? '' };
  }
  async signInWithMicrosoft(id: MockIdentity) {
    mock.nextIdentity = id;
    const start = await this.req('GET', '/v1/auth/microsoft/start');
    if (start.status !== 302) return { status: start.status, location: start.headers.get('location') ?? '' };
    return this.viaMicrosoft(start.headers.get('location') ?? '');
  }
}

const TENANT = randomUUID();
const stamp = Date.now().toString(36);
const staffEmail = `ms-staff-${stamp}@plugsure.com`;

try {
  await mock.start(Number(new URL(authority).port));

  // ---------------------------------------------------------------- the button
  const opts = await (await fetch(`${API}/console-sign-in.json`)).json();
  check('sign-in page: the Microsoft button is offered', opts.microsoft === true, opts);
  const js = await fetch(`${API}/js/microsoft.js`);
  check('console: the Microsoft module is served under script-src \'self\'', js.status === 200 && /script-src 'self'(?! 'unsafe-inline')/.test(js.headers.get('content-security-policy') ?? ''), js.status);

  // ---------------------------------------------------------------- connect the tenant
  const admin = new Browser();
  const login = await admin.req('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: PASSWORD });
  check('admin: password sign-in', login.status === 200 && !login.data.mfaRequired, login.data);
  const before = await admin.req('GET', '/v1/auth/microsoft/tenant');
  if (before.data?.tenant) await admin.req('DELETE', '/v1/auth/microsoft/tenant'); // a previous run's
  check('panel: redirect URI is PUBLIC_BASE_URL + /v1/auth/microsoft/callback', before.status === 200 && before.data.redirectUri === `${API}/v1/auth/microsoft/callback`, before.data);

  // An ordinary member of the tenant cannot claim it for the organisation.
  const notAdmin = await admin.req('POST', '/v1/auth/microsoft/link', {});
  mock.nextIdentity = { tid: TENANT, oid: randomUUID(), preferred_username: `clerk@${stamp}.example`, wids: [ENTRA_ROLES.member] };
  const refusedLink = await admin.viaMicrosoft(notAdmin.data.url);
  check('connect: refused for an account that is not a tenant administrator', refusedLink.location === '/?ms=not_tenant_admin#/users/microsoft', refusedLink);

  const link = await admin.req('POST', '/v1/auth/microsoft/link', {});
  check('connect: the server hands out the Microsoft URL and a binding cookie', link.status === 200 && link.data.url?.startsWith(authority) && admin.jar.has('ps_ms_tx'), link.data);
  mock.nextIdentity = { tid: TENANT, oid: randomUUID(), preferred_username: `it-admin@${stamp}.example`, wids: [ENTRA_ROLES.member, ENTRA_ROLES.globalAdministrator] };
  const linked = await admin.viaMicrosoft(link.data.url);
  check('connect: back on the panel, connected', linked.status === 303 && linked.location === '/?ms=linked#/users/microsoft', linked);
  const after = await admin.req('GET', '/v1/auth/microsoft/tenant');
  check('connect: the tenant of the validated sign-in is recorded', after.data?.tenant?.tenantId === TENANT, after.data);

  // ---------------------------------------------------------------- sign in
  const invite = await admin.req('POST', '/v1/users', { name: 'MS Staff', email: staffEmail, role: 'cpo_operations_manager' });
  check('invite: a console user for the member of staff', invite.status === 200, invite.data);
  const staff = new Browser();
  const oid = randomUUID();
  const s1 = await staff.signInWithMicrosoft({ tid: TENANT, oid, preferred_username: staffEmail.toUpperCase(), amr: ['pwd'] });
  check('sign in: Microsoft → console, session cookie set', s1.status === 303 && s1.location === '/' && staff.jar.has('ps_session'), s1);
  const me = await staff.req('GET', '/v1/auth/me');
  check('sign in: the invited user, signed in with Microsoft', me.status === 200 && me.data.user.email === staffEmail && me.data.user.signedInWith === 'microsoft', me.data?.user);
  check('sign in: no forced password change for a Microsoft session (one-time password unused)', me.data?.user?.mustChangePassword === false, me.data?.user);
  const otp = await new Browser().req('POST', '/v1/auth/login', { email: staffEmail, password: invite.data.temporaryPassword });
  check('sign in: the unused one-time password from the invitation stops working', otp.status === 401, otp.status);
  const sites = await staff.req('GET', '/v1/sites');
  check('sign in: the console works (RLS scope of the organisation)', sites.status === 200 && Array.isArray(sites.data), sites.status);
  const list = await admin.req('GET', '/v1/users');
  const row = Array.isArray(list.data) ? list.data.find((u: any) => u.email === staffEmail) : null;
  check('users: tagged as bound to a Microsoft account', row?.microsoft_bound === true, row);

  // Later sign-ins by oid, whatever the address says now.
  const s2 = await new Browser().signInWithMicrosoft({ tid: TENANT, oid, preferred_username: `renamed-${stamp}@plugsure.com` });
  check('sign in again: found by oid after an address change', s2.location === '/', s2);

  // ---------------------------------------------------------------- refusals
  const unknown = await new Browser().signInWithMicrosoft({ tid: TENANT, oid: randomUUID(), preferred_username: `nobody-${stamp}@plugsure.com` });
  check('refused: a person without a console user (nobody is created)', unknown.location === '/?ms=no_user', unknown);
  const otherOid = await new Browser().signInWithMicrosoft({ tid: TENANT, oid: randomUUID(), preferred_username: staffEmail });
  check('refused: the user is bound to another Microsoft account', otherOid.location === '/?ms=oid_conflict', otherOid);
  const stranger = await new Browser().signInWithMicrosoft({ tid: randomUUID(), oid: randomUUID(), preferred_username: staffEmail });
  check('refused: a tenant no organisation connected', stranger.location === '/?ms=not_linked', stranger);
  const personal = await new Browser().signInWithMicrosoft({ tid: '9188040d-6c67-4c5b-b112-36a304b66dad', oid: randomUUID(), preferred_username: 'someone@outlook.com' });
  check('refused: a personal Microsoft account', personal.location === '/?ms=personal_account', personal);
  // Login CSRF: someone else's callback link in a browser that did not start the sign-in.
  mock.nextIdentity = { tid: TENANT, oid, preferred_username: staffEmail };
  const attacker = new Browser();
  const aStart = await attacker.req('GET', '/v1/auth/microsoft/start');
  const back = (await fetch(aStart.headers.get('location') ?? '', { redirect: 'manual' })).headers.get('location') ?? '';
  const victim = new Browser();
  const v = await victim.req('GET', new URL(back).pathname + new URL(back).search);
  check('refused: a callback in a browser without the binding cookie (login CSRF)', v.headers.get('location') === '/?ms=expired' && !victim.jar.has('ps_session'), v.headers.get('location'));
  const replay = await attacker.req('GET', new URL(back).pathname + new URL(back).search);
  check('refused: the state was consumed by the first callback (single use)', replay.headers.get('location') === '/?ms=expired', replay.headers.get('location'));

  // ---------------------------------------------------------------- unlink, disconnect
  const un = await admin.req('DELETE', `/v1/users/${invite.data.id}/microsoft`);
  const gone = await staff.req('GET', '/v1/auth/me');
  check('unlink a user: their Microsoft session ends', un.status === 200 && gone.status === 401, { un: un.status, me: gone.status });
  const s3 = await new Browser().signInWithMicrosoft({ tid: TENANT, oid: randomUUID(), preferred_username: staffEmail });
  check('unlinked: the next sign-in binds afresh by address', s3.location === '/', s3);
  const del = await admin.req('DELETE', '/v1/auth/microsoft/tenant');
  check('disconnect: bindings removed', del.status === 200 && del.data.usersUnbound >= 1, del.data);
  const s4 = await new Browser().signInWithMicrosoft({ tid: TENANT, oid: randomUUID(), preferred_username: staffEmail });
  check('disconnected: the tenant no longer signs anyone in', s4.location === '/?ms=not_linked', s4);
  const audit = await admin.req('GET', '/v1/audit');
  const actions = new Set((audit.data?.entries ?? []).map((e: any) => e.action));
  check('audit: connection, sign-in, refusal, unlink and disconnect recorded; chain intact',
    audit.data?.chain?.ok === true && ['org.microsoft_tenant_linked', 'user.microsoft_bound', 'auth.microsoft_refused', 'user.microsoft_unbound', 'org.microsoft_tenant_unlinked'].every((a) => actions.has(a)),
    { chain: audit.data?.chain, missing: ['org.microsoft_tenant_linked', 'user.microsoft_bound', 'auth.microsoft_refused', 'user.microsoft_unbound', 'org.microsoft_tenant_unlinked'].filter((a) => !actions.has(a)) });
  // Tidy: the invited user cannot be deleted through the API; disable them.
  await admin.req('PUT', `/v1/users/${invite.data.id}`, { status: 'disabled' });
  await admin.req('POST', '/v1/auth/logout', {});
} catch (e) {
  check('UNEXPECTED EXCEPTION', false, String((e as Error)?.stack ?? e));
} finally {
  await mock.stop().catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
