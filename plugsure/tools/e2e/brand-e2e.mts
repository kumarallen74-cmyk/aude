// PlugSure v1.3 — white-label driver apps, end to end.
//
// An operator makes its own driver app in the console: name, colours, icon,
// web address, store identifiers. The test then checks, against the running
// API:
//   - the preview (/app/?brand=) and the live web address (Host) serve the app
//     renamed and recoloured, with its manifest, icons and push worker;
//   - the app shows only that operator's stations, and a charger of another
//     operator is named as such (listing, code, connector, checkout);
//   - the store association files (Android Digital Asset Links, Apple
//     app-site association) and the on-demand TLS check;
//   - the build kit (Android Bubblewrap project, iOS Capacitor shell, icons,
//     store texts);
//   - validation, going live, removing a live app, and the audit trail.
//
// Needs E2E_DATABASE_URL (the runtime role) to give a test site to a second
// operator. Same prerequisites as console-e2e.mts otherwise.
//     npx tsx tools/e2e/brand-e2e.mts
// NEVER point this at production.
import { request } from 'node:http';
import pg from 'pg';
import { decodePng, encodePng } from '../../src/services/png.js';
import { readZip } from '../../src/services/zip.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const results: boolean[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 700)}`}`);
};
const RUN = Date.now().toString().slice(-6);
let cookie = '';
async function ops(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const buf = Buffer.from(await r.arrayBuffer());
  let d: any = buf.toString('utf8'); try { d = JSON.parse(d); } catch {}
  return { status: r.status, data: d, buf, headers: r.headers };
}
/** A request as the brand's own web address would make it (a Host header fetch() will not send). */
function viaHost(host: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }> {
  const u = new URL(API + path);
  return new Promise((res, rej) => {
    const q = request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { host: host, ...headers } }, (r) => {
      const chunks: Buffer[] = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res({ status: r.statusCode ?? 0, body: Buffer.concat(chunks), headers: r.headers }));
    });
    q.on('error', rej);
    q.end();
  });
}
const drv = async (path: string, init: { method?: string; body?: unknown; brand?: string } = {}) => {
  const r = await fetch(API + path, {
    method: init.method ?? 'GET',
    headers: { ...(init.brand ? { 'x-driver-brand': init.brand } : {}), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d, text: t, headers: r.headers };
};
function icon(size: number, w = size): string {
  const data = new Uint8Array(w * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; const disc = (x - w / 2) ** 2 + (y - size / 2) ** 2 < (size / 4) ** 2;
    data[i] = 255; data[i + 1] = disc ? 255 : 138; data[i + 2] = disc ? 255 : 0; data[i + 3] = 255;
  }
  return encodePng({ width: w, height: size, data }).toString('base64');
}

const db = process.env.E2E_DATABASE_URL ? new pg.Client({ connectionString: process.env.E2E_DATABASE_URL }) : null;
let otherOrg = '';
try {
  if (!db) throw new Error('set E2E_DATABASE_URL (the runtime role)');
  await db.connect();
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: operator signs in', login.status === 200, login.data);
  const existing = await ops('GET', '/v1/driver-app');
  if (existing.data.brand) await ops('DELETE', `/v1/driver-app?confirm=${existing.data.brand.slug}`);

  // Two stations: one of ours, one that we then hand to another operator.
  const mkSite = async (name: string) => (await ops('POST', '/v1/sites', { name, address: 'Jl. Sudirman 1', city: 'Jakarta Pusat', postalCode: '10220', lat: '-6.2000', lon: '106.8200', kabupatenKotaCode: '3171', gridTariffGroup: 'B-2/TR', connectedKva: '53', powerFactor: '0.95', phases: '3', pbjtRateBps: '1000' })).data.id as string;
  const mkCharger = async (siteId: string, id: string) => {
    await ops('POST', '/v1/charge-points', { ocppIdentity: id, siteId, ocppVersion: 'ocpp1.6', evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'sType2', currentKind: 'AC3', maxPowerW: 22000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }] });
    await ops('POST', `/v1/charge-points/${id}/activate`);
    const d = await ops('GET', `/v1/charge-points/${id}`);
    return (d.data?.evses?.[0]?.connectors?.[0]?.id ?? d.data?.connectors?.[0]?.id) as string;
  };
  const OWN_ID = `WL-OWN-${RUN}`, OTHER_ID = `WL-OTHER-${RUN}`;
  const ownSite = await mkSite(`WL Own ${RUN}`);
  const ownConn = await mkCharger(ownSite, OWN_ID);
  const otherSite = await mkSite(`WL Other ${RUN}`);
  const otherConn = await mkCharger(otherSite, OTHER_ID);
  otherOrg = (await db.query(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Other Operator ${RUN}`, `other-op-${RUN}`])).rows[0].id;
  await db.query(`UPDATE site SET org_id = $1 WHERE id = $2`, [otherOrg, otherSite]);
  check('setup: a station of ours and one of another operator', !!ownConn && !!otherConn, { ownConn, otherConn });

  // ─────────────────────────────────────────── validation and the draft
  const none = await ops('GET', '/v1/driver-app');
  check('api: without an app the operator uses the PlugSure app (brand null)', none.status === 200 && none.data.brand === null && none.data.checks.length === 0, none.data);
  const bad = await ops('PUT', '/v1/driver-app', { appName: 'Nusa "Charge"', accentColor: 'orange', privacyUrl: 'http://x.example/p', androidPackage: 'NoDots' });
  check('validation: a name with quotes, a colour name, a plain-http privacy page and a bad package name are refused, field by field',
    bad.status === 422 && ['appName', 'accentColor', 'privacyUrl', 'androidPackage'].every((f) => bad.data.fields?.[f]), bad.data);
  const NAME = `NusaCharge ${RUN}`, SLUG = `nusacharge-${RUN}`, HOST = `app-${RUN}.nusacharge-e2e.id`;
  const draft = await ops('PUT', '/v1/driver-app', {
    appName: NAME, shortName: 'NusaCharge', taglineId: 'Isi daya di jalan tol', taglineEn: 'Charge on the toll road',
    accentColor: '#FF8A00', badgeColor: '#12305a', supportEmail: 'halo@nusacharge.id', supportPhone: '0812 3456 7890', privacyUrl: 'https://nusacharge.id/privasi',
  });
  const b = draft.data.brand;
  check('draft: saved with a slug made from the name, the phone in +62 form, and a palette readable in both themes (the orange darkened for the light theme)',
    draft.status === 200 && b.slug === SLUG && b.status === 'draft' && b.supportPhone === '+6281234567890' && draft.data.palette.light.contrast >= 4.5 && draft.data.palette.dark.contrast >= 4.5
      && draft.data.palette.adjusted === true && draft.data.previewUrl.endsWith(`/app/?brand=${SLUG}`),
    draft.data);
  const early = await ops('PUT', '/v1/driver-app', { status: 'live' });
  check('going live: refused without an icon and a web address', early.status === 409 && /icon/.test(early.data.error) && /web address/.test(early.data.error), early.data);

  // ─────────────────────────────────────────── the icon
  const notSquare = await ops('PUT', '/v1/driver-app/icon', { png: icon(512, 600) });
  const small = await ops('PUT', '/v1/driver-app/icon', { png: icon(256) });
  check('icon: a non-square or too-small PNG is refused', notSquare.status === 422 && /square/.test(notSquare.data.error) && small.status === 422 && /512/.test(small.data.error), { a: notSquare.data, b: small.data });
  const up = await ops('PUT', '/v1/driver-app/icon', { png: `data:image/png;base64,${icon(1024)}` });
  check('icon: a 1024-pixel PNG is stored, with launcher and maskable addresses', up.status === 200 && up.data.icon.width === 1024 && up.data.icon.warnings.length === 0 && !!up.data.iconUrls?.['192'] && !!up.data.maskableUrl, up.data);
  const i192 = await drv(`/app/brand/${SLUG}/icon-192.png`);
  const i192b = Buffer.from(await (await fetch(`${API}/app/brand/${SLUG}/icon-192.png`)).arrayBuffer());
  const ios = Buffer.from(await (await fetch(`${API}/app/brand/${SLUG}/appstore-1024.png`)).arrayBuffer());
  const mask = decodePng(Buffer.from(await (await fetch(`${API}/app/brand/${SLUG}/maskable-512.png`)).arrayBuffer()));
  check('icon: every size is made from it — 192 px launcher, 512 px maskable on the icon background, 1024 px App Store icon with no alpha',
    i192.status === 200 && i192.headers.get('content-type') === 'image/png' && decodePng(i192b).width === 192 && ios[25] === 2 && decodePng(ios).width === 1024
      && mask.width === 512 && mask.data[0] === 0x12 && mask.data[1] === 0x30 && mask.data[2] === 0x5a,
    { s: i192.status, t: i192.headers.get('content-type'), ios: ios[25], corner: [...mask.data.slice(0, 4)] });

  // ─────────────────────────────────────────── the preview
  const page = await drv(`/app/?brand=${SLUG}`);
  const plain = await drv('/app/');
  check('preview: /app/?brand= serves the app renamed (no “PlugSure” left), with its tagline, colours, icon and brand',
    page.status === 200 && page.text.includes(`<title>${NAME} — `) && !page.text.includes('PlugSure') && page.text.includes('Isi daya di jalan tol')
      && /id="brand-theme"/.test(page.text) && page.text.includes(`window.BRAND={"slug":"${SLUG}"`) && page.text.includes(`/app/brand/${SLUG}/icon-96.png`),
    page.text.slice(0, 400));
  check('preview: the PlugSure app itself is unchanged', plain.status === 200 && plain.text.includes('<title>PlugSure') && !plain.text.includes('window.BRAND='), plain.text.slice(0, 200));
  const man = await drv(`/app/manifest.webmanifest?brand=${SLUG}`);
  check('preview: its manifest has the name, PNG icons (maskable too) and a start address that keeps the brand',
    man.status === 200 && man.data.short_name === 'NusaCharge' && man.data.start_url === `/app/?brand=${SLUG}` && man.data.icons.some((i: any) => i.purpose === 'maskable'), man.data);
  check('preview: the app may be framed by the console (same origin) for the live preview; the API may not',
    page.headers.get('x-frame-options') === 'SAMEORIGIN' && /frame-ancestors 'self'/.test(page.headers.get('content-security-policy') ?? '')
      && (await fetch(`${API}/v1/driver-app`, { headers: { cookie } })).headers.get('x-frame-options') === 'DENY');

  // ─────────────────────────────────────────── only our stations
  const allSt = await drv('/d/v1/stations');
  const brandSt = await drv('/d/v1/stations', { brand: SLUG });
  const ids = (r: any) => (r.data.stations ?? []).map((s: any) => s.siteId);
  check('scope: the branded app lists only this operator’s stations; the PlugSure app lists both',
    ids(allSt).includes(otherSite) && ids(allSt).includes(ownSite) && ids(brandSt).includes(ownSite) && !ids(brandSt).includes(otherSite)
      && (brandSt.data.stations ?? []).every((s: any) => s.operator === (brandSt.data.stations[0]?.operator)),
    { all: ids(allSt).length, brand: ids(brandSt).length });
  const rOther = await drv(`/d/v1/resolve?code=${OTHER_ID}`, { brand: SLUG });
  const rOtherPlain = await drv(`/d/v1/resolve?code=${OTHER_ID}`);
  const rOwn = await drv(`/d/v1/resolve?code=${OWN_ID}`, { brand: SLUG });
  check('scope: scanning another operator’s charger says so, by name, instead of “unknown code”; ours resolves; the PlugSure app resolves both',
    rOther.status === 404 && rOther.data.code === 'other_operator' && rOther.data.message.includes(NAME) && rOtherPlain.status === 200 && rOwn.status === 200,
    { o: rOther.data, p: rOtherPlain.status, own: rOwn.status });
  const cOther = await drv(`/d/v1/connectors/${otherConn}`, { brand: SLUG });
  const cOwn = await drv(`/d/v1/connectors/${ownConn}`, { brand: SLUG });
  check('scope: another operator’s connector page is refused; ours opens', cOther.status === 404 && cOther.data.code === 'other_operator' && cOwn.status === 200 && cOwn.data.station?.siteId === ownSite, { o: cOther.data, own: cOwn.status });
  const device = (await drv('/d/v1/device', { method: 'POST', brand: SLUG })).data?.deviceToken;
  const quote = (connectorId: string) => fetch(`${API}/d/v1/charge/quote`, {
    method: 'POST', headers: { 'x-driver-brand': SLUG, authorization: `Bearer ${device}`, 'content-type': 'application/json' }, body: JSON.stringify({ connectorId, amountIdr: 50000 }),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  const qOther = await quote(otherConn);
  const qOwn = await quote(ownConn);
  check('scope: paying for another operator’s charger is refused before anything is charged; ours is quoted', qOther.status === 404 && qOther.data.code === 'other_operator' && qOwn.data?.code !== 'other_operator', { o: qOther.data, own: qOwn.data });

  // ─────────────────────────────────────────── the web address, live
  const badVer = await ops('PUT', '/v1/driver-app', { versionCode: 0 });
  check('validation: a version code below 1 is refused', badVer.status === 422 && !!badVer.data.fields?.versionCode, badVer.data);
  const FP = Array.from({ length: 32 }, (_, i) => ((i * 37 + 11) % 256).toString(16).padStart(2, '0')).join('');
  const live = await ops('PUT', '/v1/driver-app', {
    hostname: `https://${HOST.toUpperCase()}/`, status: 'live', androidPackage: `id.nusacharge.e${RUN}`, androidCertSha256: [FP],
    iosBundleId: `id.nusacharge.e${RUN}`, iosTeamId: 'abcde12345', versionName: '1.0.0', versionCode: 3,
  });
  check('live: with an icon and a web address the app goes live; the address and fingerprint are normalised',
    live.status === 200 && live.data.brand.status === 'live' && live.data.brand.hostname === HOST && live.data.brand.androidCertSha256[0] === FP.toUpperCase().match(/../g)!.join(':')
      && live.data.brand.iosTeamId === 'ABCDE12345' && live.data.appUrl === `https://${HOST}/app/` && !!live.data.brand.publishedAt,
    live.data);
  const down = await ops('PUT', '/v1/driver-app', { versionCode: 2 });
  check('store: the version code cannot go down', down.status === 422 && /cannot go down/.test(down.data.error), down.data);
  const hostPage = await viaHost(HOST, '/app/');
  const hostMan = JSON.parse((await viaHost(HOST, '/app/manifest.webmanifest')).body.toString());
  const hostSw = (await viaHost(HOST, '/app/sw.js')).body.toString();
  check('live: on its own web address the app is branded without ?brand=, installable from there, with notifications under its name and icon',
    hostPage.status === 200 && hostPage.body.toString().includes(`window.BRAND={"slug":"${SLUG}"`) && hostMan.start_url === '/app/' && hostMan.related_applications?.[0]?.id === `id.nusacharge.e${RUN}`
      && hostSw.includes(`/app/brand/${SLUG}/icon-192.png`) && !hostSw.includes('PlugSure'),
    { s: hostPage.status, m: hostMan });
  const hostStations = JSON.parse((await viaHost(HOST, '/d/v1/stations')).body.toString());
  check('live: the web address alone scopes the stations (no header needed)', hostStations.stations.some((s: any) => s.siteId === ownSite) && !hostStations.stations.some((s: any) => s.siteId === otherSite), hostStations.stations?.length);
  const links = JSON.parse((await viaHost(HOST, '/.well-known/assetlinks.json')).body.toString());
  const aasa = JSON.parse((await viaHost(HOST, '/.well-known/apple-app-site-association')).body.toString());
  const noLinks = JSON.parse((await viaHost('127.0.0.1', '/.well-known/assetlinks.json')).body.toString());
  check('store: the web address vouches for its Android app (Digital Asset Links) and its iOS app (app-site association); PlugSure’s own address for none',
    links[0]?.target?.package_name === `id.nusacharge.e${RUN}` && links[0].target.sha256_cert_fingerprints[0] === live.data.brand.androidCertSha256[0]
      && aasa.applinks.details[0].appIDs[0] === `ABCDE12345.id.nusacharge.e${RUN}` && Array.isArray(noLinks) && noLinks.length === 0,
    { links, aasa });
  const ask = await drv(`/d/tls-ask?domain=${HOST}`);
  const askNo = await drv('/d/tls-ask?domain=evil.example.com');
  check('tls: the certificate check allows the brand’s web address only', ask.status === 200 && askNo.status === 404, { a: ask.status, n: askNo.status });

  // ─────────────────────────────────────────── the build kit
  const kit = await ops('GET', '/v1/driver-app/kit');
  const files = kit.status === 200 ? readZip(kit.buf) : new Map<string, Buffer>();
  const twa = files.get('android/twa-manifest.json') ? JSON.parse(files.get('android/twa-manifest.json')!.toString()) : null;
  const cap = files.get('ios/capacitor.config.json') ? JSON.parse(files.get('ios/capacitor.config.json')!.toString()) : null;
  check('kit: a zip with the Android project (the brand’s address, package, version and icon), the iOS shell and the store texts; the one thing missing is the notifications key',
    kit.status === 200 && kit.headers.get('content-type') === 'application/zip' && /attachment; filename="nusacharge-\d+-build-kit-1\.0\.0\.zip"/.test(kit.headers.get('content-disposition') ?? '')
      && twa?.host === HOST && twa.packageId === `id.nusacharge.e${RUN}` && twa.appVersionCode === 3 && twa.iconUrl.startsWith(`https://${HOST}/app/brand/${SLUG}/icon-512.png`)
      && cap?.server.url === `https://${HOST}/app/` && decodePng(files.get('ios/AppIcon-1024.png')!).width === 1024
      && decodePng(files.get('android/res/mipmap-xxxhdpi/ic_launcher.png')!).width === 192 && files.get('store/listing-id.md')!.toString().includes(NAME)
      && kit.headers.get('x-kit-warnings') === '1' && /No notifications key \(APNs\) yet/.test(files.get('README.md')!.toString()),
    { s: kit.status, files: [...files.keys()], w: kit.headers.get('x-kit-warnings') });

  // ─────────────────────────────────────────── removing it
  const noConfirm = await ops('DELETE', '/v1/driver-app');
  check('remove: a live app needs the slug to confirm (its store apps would stop working)', noConfirm.status === 409 && noConfirm.data.error.includes(HOST), noConfirm.data);
  const audit = await ops('GET', '/v1/audit?limit=60');
  const acts = JSON.stringify(audit.data);
  check('audit: created, icon changed, published and kit downloaded are recorded', ['driver_app.created', 'driver_app.icon_changed', 'driver_app.published', 'driver_app.kit_downloaded'].every((a) => acts.includes(a)), audit.status);
  const del = await ops('DELETE', `/v1/driver-app?confirm=${SLUG}`);
  const after = await viaHost(HOST, '/app/');
  const again = await ops('GET', '/v1/driver-app');
  check('remove: confirmed, the address no longer serves the brand and the operator is back on the PlugSure app',
    del.status === 200 && !after.body.toString().includes('window.BRAND=') && again.data.brand === null && (await drv(`/app/brand/${SLUG}/icon-192.png`)).status === 404,
    { d: del.data, again: again.data.brand });
} catch (e) {
  check('no unexpected exception', false, (e as Error).stack);
} finally {
  if (db) {
    if (otherOrg) await db.query(`UPDATE site SET archived_at = now() WHERE org_id = $1`, [otherOrg]).catch(() => {});
    await db.end().catch(() => {});
  }
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
