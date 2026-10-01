// PlugSure v1.5.0 — white-label operator console, end to end.
//
// Against the running API, as the seeded operator (ops@plugsure.com):
//   - the brand is saved, validated, and returned to the console (/v1/auth/me);
//   - the sign-in page on the brand's own web address shows it (/console-brand.json
//     by Host), and PlugSure's own address does not;
//   - only the operator's accounts sign in on that address (another operator's
//     admin gets the same 401 as a wrong password, and it is audited);
//   - another operator cannot take the address;
//   - the logo is stored as 256 × 256 and served by its hash, publicly and cacheably;
//   - a key without org:write cannot change it; removal goes back to PlugSure.
//
// Needs E2E_DATABASE_URL (the runtime role) to make a second operator with
// src/db/create-admin.ts, as the isolation suite does.
//     npx tsx tools/e2e/console-brand-e2e.mts
// NEVER point this at production.
import { request } from 'node:http';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { encodePng, decodePng } from '../../src/services/png.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const PASSWORD = process.env.E2E_PASSWORD ?? 'Console-Test-2026!';
const DB = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DB) { console.error('E2E_DATABASE_URL is required'); process.exit(2); }

let passed = 0; let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { console.log('PASS ', label); passed++; }
  else { console.log('FAIL ', label, '--', JSON.stringify(detail)?.slice(0, 600)); failed++; }
};

const session = () => {
  let cookie = '';
  return async (method: string, path: string, body?: unknown, bearer?: string) => {
    const r = await fetch(API + path, {
      method,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie, 'x-plugsure-csrf': '1' }),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc && !bearer) cookie = sc.split(';')[0]!;
    const buf = Buffer.from(await r.arrayBuffer());
    let d: any = buf.toString('utf8'); try { d = JSON.parse(d); } catch {}
    return { s: r.status, d, buf, h: r.headers };
  };
};

/** A request as the brand's own web address would make it (fetch() will not send a Host header). */
function viaHost(host: string, method: string, path: string, body?: unknown): Promise<{ s: number; d: any; buf: Buffer; h: Record<string, unknown> }> {
  const u = new URL(API + path);
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((res, rej) => {
    const q = request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { host, ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}) },
    }, (r) => {
      const chunks: Buffer[] = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const buf = Buffer.concat(chunks);
        let d: any = buf.toString('utf8'); try { d = JSON.parse(d); } catch {}
        res({ s: r.statusCode ?? 0, d, buf, h: r.headers });
      });
    });
    q.on('error', rej);
    if (payload) q.write(payload);
    q.end();
  });
}

function logo(size: number): string {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4; const disc = (x - size / 2) ** 2 + (y - size / 2) ** 2 < (size / 3) ** 2;
    data[i] = disc ? 255 : 18; data[i + 1] = disc ? 138 : 48; data[i + 2] = disc ? 0 : 90; data[i + 3] = 255;
  }
  return encodePng({ width: size, height: size, data }).toString('base64');
}

const tag = randomBytes(4).toString('hex');
const HOST = `console-${tag}.brand-e2e.example`;
const slugB = `brand-e2e-b-${tag}`;
const emailB = `b-${tag}@plugsure.test`;
const pwB = 'BrandB-Test-2026!';
const db = new pg.Client({ connectionString: DB });
await db.connect();

const ops = session();
const other = session();
const keys: string[] = [];
let orgB = '';
try {
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: PASSWORD });
  check('operator signs in', login.s === 200, login.s);
  const me0 = await ops('GET', '/v1/auth/me');
  const orgA = me0.d?.org?.id;
  // A previous run may have left a brand: start from PlugSure's.
  await ops('DELETE', '/v1/console-brand');
  check('no brand: the console is PlugSure’s (/v1/auth/me consoleBrand null)', (await ops('GET', '/v1/auth/me')).d?.consoleBrand === null);
  check('no brand: GET /v1/console-brand answers brand null', (await ops('GET', '/v1/console-brand')).d?.brand === null);

  // ── validation
  const bad = await ops('PUT', '/v1/console-brand', { accentColor: 'orange' });
  check('a brand needs a product name and real colours (422 with the fields)', bad.s === 422 && !!bad.d?.fields?.productName && !!bad.d?.fields?.accentColor, bad.d);
  const reserved = await ops('PUT', '/v1/console-brand', { productName: 'X', hostname: 'not a host' });
  check('a web address must be a domain name', reserved.s === 422 && !!reserved.d?.fields?.hostname, reserved.d);

  // ── save
  const put = await ops('PUT', '/v1/console-brand', { productName: 'NusaCharge Ops', tagline: 'Network operations', brandColor: '#12305a', accentColor: '#ffd400', hostname: `https://${HOST}/`, showPoweredBy: false });
  check('the operator saves its brand; the web address is normalised', put.s === 200 && put.d?.brand?.productName === 'NusaCharge Ops' && put.d?.brand?.hostname === HOST && put.d?.brand?.showPoweredBy === false, put.d);
  const pal = put.d?.view?.palette;
  check('a yellow accent is darkened for the light theme and kept readable (≥ 4.5:1)', pal?.adjusted === true && pal?.light?.accent !== '#ffd400' && pal?.light?.contrast >= 4.5 && pal?.dark?.contrast >= 4.5, pal);
  const me = await ops('GET', '/v1/auth/me');
  check('/v1/auth/me gives the console its brand', me.d?.consoleBrand?.productName === 'NusaCharge Ops' && me.d?.consoleBrand?.tagline === 'Network operations' && me.d?.consoleBrand?.logoUrl === null, me.d?.consoleBrand);

  // ── the sign-in page, by web address
  const pub = await viaHost(HOST, 'GET', '/console-brand.json');
  check('the brand’s web address serves its brand to the sign-in page, before sign-in', pub.s === 200 && pub.d?.brand?.productName === 'NusaCharge Ops' && !('hostname' in (pub.d?.brand ?? {})), pub.d);
  const pubPort = await viaHost(`${HOST.toUpperCase()}:443`, 'GET', '/console-brand.json');
  check('the lookup ignores case and port', pubPort.d?.brand?.productName === 'NusaCharge Ops', pubPort.d);
  const plain = await (await fetch(API + '/console-brand.json')).json();
  check('PlugSure’s own address serves no brand', plain.brand === null, plain);
  const index = await viaHost(HOST, 'GET', '/');
  check('the console itself is served on the brand’s address', index.s === 200 && /<div id="app"/.test(index.buf.toString()), index.s);

  // ── who may sign in there
  execSync(
    `npx tsx src/db/create-admin.ts --email ${emailB} --name "Admin B" --org-slug ${slugB} --org-name "Brand E2E ${tag}" --password '${pwB}'`,
    { env: { ...process.env, DATABASE_URL: DB, MIGRATION_DATABASE_URL: DB }, stdio: 'pipe' },
  );
  orgB = (await db.query(`SELECT id FROM organisation WHERE slug = $1`, [slugB])).rows[0]?.id;
  await db.query(`UPDATE app_user SET must_change_password = false WHERE email = $1`, [emailB]);
  const own = await viaHost(HOST, 'POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: PASSWORD });
  check('the operator’s own account signs in on its console address', own.s === 200 && /ps_session=/.test(String(own.h['set-cookie'] ?? '')), own.s);
  const foreign = await viaHost(HOST, 'POST', '/v1/auth/login', { email: emailB, password: pwB });
  check('another operator’s admin is refused there, with the wrong-password answer and no session', foreign.s === 401 && /^invalid email or password/.test(foreign.d?.error ?? '') && !/ps_session=[^;]/.test(String(foreign.h['set-cookie'] ?? '')), { s: foreign.s, d: foreign.d, c: foreign.h['set-cookie'] });
  const wrongPw = await viaHost(HOST, 'POST', '/v1/auth/login', { email: emailB, password: 'not-the-password' });
  check('… the same answer as a wrong password', wrongPw.s === 401 && wrongPw.d?.error === foreign.d?.error, wrongPw.d);
  const elsewhere = await other('POST', '/v1/auth/login', { email: emailB, password: pwB });
  check('the other operator still signs in on PlugSure’s address', elsewhere.s === 200, elsewhere.s);
  const auditRow = (await db.query(`SELECT 1 FROM audit_log WHERE action = 'auth.login_wrong_console' AND org_id = $1 AND target_id = $2`, [orgA, emailB])).rowCount;
  check('the refused sign-in is audited for the console’s operator', auditRow === 1, auditRow);
  const meB = await other('GET', '/v1/auth/me');
  check('the other operator sees PlugSure’s console, not this brand', meB.d?.consoleBrand === null, meB.d?.consoleBrand);

  // ── the address is the operator's
  const steal = await other('PUT', '/v1/console-brand', { productName: 'Thief', hostname: HOST });
  check('another operator cannot take the console’s web address (409)', steal.s === 409 && steal.d?.fields?.hostname === 'taken', steal.d);
  const stealApp = await other('PUT', '/v1/driver-app', { appName: 'Thief App', hostname: HOST });
  check('… nor use it for a driver app (409)', stealApp.s === 409 && stealApp.d?.fields?.hostname === 'taken', stealApp.d);

  // ── the logo
  const tooSmall = await ops('PUT', '/v1/console-brand/logo', { png: logo(32) });
  check('a logo under 64 px is refused (422)', tooSmall.s === 422, tooSmall.d);
  const up = await ops('PUT', '/v1/console-brand/logo', { png: logo(512) });
  check('a square PNG logo is accepted', up.s === 200 && up.d?.brand?.hasLogo === true && /^\/console-brand\/[0-9a-f]{64}\.png$/.test(up.d?.view?.logoUrl ?? ''), up.d?.view);
  const img = await fetch(API + up.d?.view?.logoUrl);
  const imgBuf = Buffer.from(await img.arrayBuffer());
  check('the logo is served publicly as a 256 × 256 PNG, cacheable for good (content-addressed)',
    img.status === 200 && img.headers.get('content-type') === 'image/png' && /immutable/.test(img.headers.get('cache-control') ?? '') && decodePng(imgBuf).width === 256,
    { s: img.status, ct: img.headers.get('content-type'), cc: img.headers.get('cache-control') });
  check('an unknown logo answers 404', (await fetch(API + '/console-brand/' + '0'.repeat(64) + '.png')).status === 404);
  check('the sign-in page gets the logo too', (await viaHost(HOST, 'GET', '/console-brand.json')).d?.brand?.logoUrl === up.d?.view?.logoUrl);

  // ── permissions
  const ro = await ops('POST', '/v1/api-keys', { name: `e2e brand read ${tag}`, permissions: ['org:read'] });
  keys.push(ro.d?.id);
  const readOnly = await ops('PUT', '/v1/console-brand', { productName: 'Nope' }, ro.d?.key);
  check('a key with org:read only cannot change the brand (403)', readOnly.s === 403, readOnly.s);
  check('… but can read it', (await ops('GET', '/v1/console-brand', undefined, ro.d?.key)).d?.brand?.productName === 'NusaCharge Ops');

  // ── audit, removal
  const audit = await ops('GET', '/v1/audit');
  const actions = new Set((audit.d?.entries ?? []).filter((e: any) => e.target_type === 'console_brand').map((e: any) => e.action));
  check('saving and the logo are audited', actions.has('console_brand.created') && actions.has('console_brand.logo_changed'), [...actions]);
  const rmLogo = await ops('DELETE', '/v1/console-brand/logo');
  check('the logo can be removed', rmLogo.s === 200 && rmLogo.d?.brand?.hasLogo === false, rmLogo.d?.brand);
  const del = await ops('DELETE', '/v1/console-brand');
  check('removing the brand goes back to PlugSure', del.s === 200 && (await ops('GET', '/v1/auth/me')).d?.consoleBrand === null, del.d);
  const after = await viaHost(HOST, 'GET', '/console-brand.json');
  check('… and its web address shows PlugSure’s sign-in page again', after.d?.brand === null, after.d);
  const reopened = await viaHost(HOST, 'POST', '/v1/auth/login', { email: emailB, password: pwB });
  check('… where any account may sign in again', reopened.s === 200, reopened.s);
} finally {
  for (const id of keys) if (id) await ops('DELETE', `/v1/api-keys/${id}`).catch(() => undefined);
  await ops('DELETE', '/v1/console-brand').catch(() => undefined);
  if (orgB) {
    await db.query(`DELETE FROM console_brand WHERE org_id = $1`, [orgB]).catch(() => {});
    await db.query(`DELETE FROM auth_session WHERE user_id IN (SELECT id FROM app_user WHERE org_id = $1)`, [orgB]).catch(() => {});
    await db.query(`DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE org_id = $1)`, [orgB]).catch(() => {});
    await db.query(`DELETE FROM app_user WHERE org_id = $1`, [orgB]).catch(() => {});
    await db.query(`DELETE FROM organisation WHERE id = $1`, [orgB]).catch(() => {});
  }
  await db.end();
}

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
