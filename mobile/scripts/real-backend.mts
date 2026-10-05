/**
 * The app's web build against the REAL backend (plugsure/), driven like a driver with Playwright, screenshotting each
 * step at 390×844 and 360×800 (WIDTHS), in light and dark.
 *
 *   Journey A (guest, Indonesia, the sandbox acquirer's QRIS): map → station → connector → pay → live session updated
 *     by the simulated charger (`npm run sim`) → stop → receipt → history.
 *   Journey B (Singapore, Stripe through the local fake Stripe of the stripe e2e): phone OTP sign-in (development code)
 *     → favourites → card hold → live session → the authorisation lapses at Stripe → stop → the session is unpaid →
 *     account deletion refused (409, unpaid) → paid in the app with PayNow (Save QR) → deletion → a new guest device.
 *   Journey C: a QR deep link /c/<IDENTITY>:<n> resolves to its connector (links/resolve, §15.5).
 *
 * Needs: the API and gateway running (CI e2e env; API_PORT / OCPP_PORT below), the seeded Summarecon chargers online
 * through `npm run sim`, DRIVER_WEB_ORIGINS allowing http://127.0.0.1:8090, and the web export built with
 *   EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:9600 npx expo export --platform web --output-dir dist/web-real
 * Run from plugsure/ (for tsx):  npx tsx ../mobile/scripts/real-backend.mts <outDir>
 * The SG Stripe integration and the SG simulator are removed / stopped at the end (the site and charger stay: use a
 * scratch database).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { FakeStripe } from '../../plugsure/tools/testing/fake-stripe.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.join(here, '..');
const backend = path.join(mobile, '..', 'plugsure');
const dist = path.join(mobile, 'dist', 'web-real');
const out = path.resolve(process.argv[2] ?? path.join(mobile, 'screenshots-real'));
fs.mkdirSync(out, { recursive: true });
const API = process.env.E2E_API ?? 'http://127.0.0.1:9600';
const OCPP = process.env.E2E_OCPP ?? 'ws://127.0.0.1:9620/ocpp';
const WEB_PORT = Number(process.env.WEB_PORT ?? 8090);
const DC_CONNECTOR = process.env.DC_CONNECTOR ?? ''; // the seeded CCS2 connector (looked up when empty)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ ok: boolean; label: string }> = [];
const check = (label: string, ok: boolean, detail: unknown = '') => {
  results.push({ ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
};

// ---------------------------------------------------------------- the web build, same origin for its own files
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  let file = path.join(dist, p);
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(WEB_PORT, '127.0.0.1', () => r()));
const WEB = `http://127.0.0.1:${WEB_PORT}`;

// ---------------------------------------------------------------- operator console session (setup only)
let cookie = '';
async function ops(method: string, p: string, body?: unknown) {
  const r = await fetch(API + p, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text();
  let d: any = t;
  try {
    d = JSON.parse(t);
  } catch {
    /* text */
  }
  return { status: r.status, data: d };
}
const cleanup: Array<() => Promise<unknown>> = [];
const children: ChildProcess[] = [];
const stamp = Date.now().toString().slice(-6);

function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* gone */
    }
  }
}

/** `npm run sim` for one charger (its own process group, so the whole tree stops at the end). */
function sim(id: string, extra: string[]): ChildProcess {
  const log = fs.openSync(path.join(out, `sim-${id}.log`), 'w');
  const c = spawn('npm', ['run', 'sim', '--', '--id', id, '--url', OCPP, '--speed', '6', '--meter-interval', '30', ...extra], { cwd: backend, detached: true, stdio: ['ignore', log, log] });
  children.push(c);
  return c;
}

const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
check('setup: operator signs in (console, for the Singapore setup only)', login.status === 200, login.data);

// ---------------------------------------------------------------- Singapore: Stripe (fake), a site, a DC charger on the simulator
const SK = 'sk_test_51E2eStripeFakeKey';
const PK = 'pk_test_51E2eStripeFakeKey';
const WH = 'whsec_mobileRealSg01';
const sg = await new FakeStripe({ secretKey: SK, webhookSecret: WH, country: 'SG' }).start();
cleanup.push(() => sg.stop());
await ops('DELETE', '/v1/integrations/payments?scope=org&countryCode=SG');
cleanup.push(() => ops('DELETE', '/v1/integrations/payments?scope=org&countryCode=SG'));
const integ = await ops('PUT', '/v1/integrations/payments', {
  provider: 'stripe', countryCode: 'SG', settings: { publishableKey: PK, methods: ['CARD', 'PAYNOW'], cardHolds: true, saveCards: false, baseUrl: sg.url }, secrets: { secretKey: SK, webhookSecret: WH },
});
sg.setWebhookUrl(integ.data.webhookUrl);
const site = await ops('POST', '/v1/sites', { countryCode: 'SG', name: `Marina Bay Link ${stamp}`, address: '6 Raffles Boulevard', city: 'Singapore', postalCode: '039594', lat: '1.2913', lon: '103.8572', connectedKva: '150', powerFactor: '0.95', phases: '3' });
const tariff = await ops('POST', '/v1/tariffs', { name: `Mobile SG ${stamp}`, countryCode: 'SG', appliesToMaxPowerW: 60000, components: [{ kind: 'energy', rate: 0.65, touBlock: 'ANY' }] });
await ops('PUT', `/v1/sites/${site.data.id}/tariff`, { tariffId: tariff.data.tariffId, currentType: 'DC' });
const SG_ID = `MOB-SG-${stamp}`;
await ops('POST', '/v1/charge-points', { ocppIdentity: SG_ID, siteId: site.data.id, displayName: SG_ID, ocppVersion: 'ocpp1.6', evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000 }] }] });
const act = await ops('POST', `/v1/charge-points/${SG_ID}/activate`);
check('setup: a Singapore site with a Stripe account (fake) and a DC charger', integ.status === 200 && site.status === 200 && tariff.status === 200 && act.status < 300, { integ: integ.data, site: site.data, act: act.data });
sim(SG_ID, ['--dc', '--max-power', '60000']);

/** Driver API calls as a given device (to read what the app did). */
const driver = (tok: string) => async (p: string) => (await fetch(`${API}/d${p}`, { headers: { authorization: `Bearer ${tok}`, 'x-driver-brand': 'plugsure' } })).json() as Promise<any>;
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000, every = 500): Promise<T> {
  const t0 = Date.now();
  let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) {
    await sleep(every);
    v = await fn();
  }
  return v;
}
const stations = await until(() => fetch(`${API}/d/v1/stations`).then((r) => r.json() as Promise<any>), (r) => r.stations?.some((s: any) => s.siteId === site.data.id && s.connectors?.[0]?.available), 30_000, 1000);
const sgStation = stations.stations.find((s: any) => s.siteId === site.data.id);
const sgConnector = sgStation?.connectors?.[0]?.connectorId as string;
const bekasi = stations.stations.find((s: any) => /Summarecon/.test(s.name));
const dcConnector = DC_CONNECTOR || (bekasi?.connectors.find((c: any) => c.typeLabel === 'CCS2')?.connectorId as string);
check('setup: the SG charger is online (simulator) and listed; the seeded Summarecon CCS2 connector is available', !!sgConnector && !!bekasi?.connectors.find((c: any) => c.connectorId === dcConnector)?.available, { sg: sgStation, bekasi });

// ---------------------------------------------------------------- the browser
const browser = await chromium.launch();
const errors: string[] = [];
const SETTLED = { onboarded: true, language: 'en', theme: 'system', notifications: { charging: true, payments: true, reservations: true, account: true, promotions: false }, simpleStart: true, mapMode: 'map', locationPrompted: true, pushPrompted: true, phoneCountry: null };

const SIZES = (process.env.WIDTHS ?? '390,360').split(',').map((w) => ({ width: Number(w), height: Number(w) >= 390 ? 844 : 800 }));
let size = SIZES[0]!;
async function context(scheme: 'light' | 'dark', geo: { latitude: number; longitude: number }) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 2, colorScheme: scheme, locale: 'en-GB', hasTouch: true, isMobile: true, geolocation: geo, permissions: ['geolocation'] });
  await ctx.route(/tile\.openstreetmap\.org|fonts\.gstatic/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${scheme}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(m.text()) && errors.push(`${scheme} console: ${m.text().slice(0, 300)}`));
  await page.goto(WEB + '/');
  await page.evaluate((s) => localStorage.setItem('ps.settings.v1', JSON.stringify(s)), SETTLED);
  return { ctx, page };
}
function helpers(page: Page, prefix: string) {
  let n = 0;
  return {
    shot: async (name: string, wait = 700) => {
      await page.waitForTimeout(wait);
      await page.screenshot({ path: path.join(out, `${prefix}-${String(++n).padStart(2, '0')}-${name}.png`) });
    },
    tid: (id: string) => page.locator(`[data-testid="${id}"]:visible`).first(),
    go: async (p: string, wait = 1500) => {
      await page.goto(WEB + p);
      await page.waitForTimeout(wait);
    },
    text: (t: string | RegExp) => page.getByText(t).first(),
  };
}
const deviceToken = (page: Page) => page.evaluate(() => localStorage.getItem('ps.deviceToken')).catch(() => null);

// ---------------------------------------------------------------- Journey A: guest, QRIS (sandbox), live session from the simulator
async function journeyA(scheme: 'light' | 'dark') {
  const { ctx, page } = await context(scheme, { latitude: -6.2246, longitude: 106.9998 });
  const { shot, tid, go, text } = helpers(page, `${size.width}-${scheme}-A`);
  await go('/', 3500);
  await shot('map');
  await tid('toggle-list').click();
  await shot('map-list', 1200);
  await text(/Summarecon Mall Bekasi/).click();
  await page.waitForTimeout(1800);
  await shot('station');
  await tid(`connector-${dcConnector}`).click();
  await page.waitForTimeout(2500);
  await shot('connector');
  await tid('method-m:QRIS').click();
  await shot('connector-method-chosen', 400);
  await tid('start-cta').click();
  await page.waitForTimeout(2500);
  const qrVisible = await tid('save-qr').isVisible().catch(() => false);
  await shot('pay-qris');
  check(`${scheme} A: QRIS payment screen with the sandbox code and Save QR`, (await tid('pay-screen').isVisible()) && qrVisible);
  await tid('simulate-payment').click();
  await page.waitForTimeout(3000);
  await shot('session-starting', 200);
  // The simulated charger accepts RemoteStart and meters every 30 simulated seconds (speed 6: every 5 s).
  await page.waitForTimeout(12_000);
  const e1 = await tid('energy').innerText().catch(() => '');
  await shot('session-live-1', 200);
  await page.waitForTimeout(12_000);
  const e2 = await tid('energy').innerText().catch(() => '');
  await shot('session-live-2', 200);
  const kwh = (s: string) => Number((/([\d.,]+)/.exec(s)?.[1] ?? '0').replace(/,/g, ''));
  check(`${scheme} A: the live session updates from the simulated charger (energy ${e1} → ${e2})`, kwh(e2) > kwh(e1) && kwh(e2) > 0, { e1, e2 });
  await tid('stop').click();
  await page.waitForTimeout(600);
  await tid('choice-stop').click();
  await page.locator('[data-testid="view-receipt"]').first().waitFor({ timeout: 60_000 }).catch(() => null);
  await shot('session-complete', 800);
  await tid('view-receipt').click();
  await page.waitForTimeout(2500);
  await shot('receipt');
  check(`${scheme} A: the receipt is shown after stopping`, await tid('receipt-screen').isVisible());
  await go('/activity', 2500);
  await shot('history');
  const tok = await deviceToken(page);
  const h = tok ? await driver(tok)('/v1/history') : null;
  check(`${scheme} A: history lists the charge (server)`, (h?.charges?.length ?? 0) >= 1, h);
  await ctx.close();
}

// ---------------------------------------------------------------- Journey B: OTP sign-in, favourites, Stripe hold → unpaid → deletion
async function journeyB(scheme: 'light' | 'dark') {
  const { ctx, page } = await context(scheme, { latitude: 1.2913, longitude: 103.8572 });
  const { shot, tid, go, text } = helpers(page, `${size.width}-${scheme}-B`);
  await go('/account', 2500);
  await shot('account-guest');
  await tid('go-sign-in').click();
  await page.waitForTimeout(900);
  const local = `81${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
  await tid('phone-input').fill(local);
  await shot('sign-in-phone', 300);
  await tid('send-code').click();
  await text(/Development server code/).waitFor({ timeout: 15_000 });
  const code = /(\d{6})/.exec(await text(/Development server code/).innerText())?.[1] ?? '';
  await shot('sign-in-code', 300);
  await tid('code-input').fill(code);
  await page.waitForTimeout(3000);
  await shot('account-signed-in');
  const tok = await deviceToken(page);
  const me = tok ? await driver(tok)('/v1/me') : null;
  check(`${scheme} B: phone OTP sign-in with the development code (dev OTP provider)`, !!me?.account?.phone && code.length === 6, me);

  // Favourites: the Singapore station.
  await go(`/station/${site.data.id}`, 2500);
  await tid('favourite').click();
  await page.waitForTimeout(1200);
  await shot('station-favourited');
  await go('/favourites', 2500);
  await shot('favourites');
  const favs = tok ? await driver(tok)('/v1/favourites') : null;
  check(`${scheme} B: the station is a favourite (server)`, favs?.favourites?.some((f: any) => f.siteId === site.data.id), favs);

  // Card hold through Stripe (fake): the hosted card page is Stripe's Payment Element; the fake confirms the card.
  await go(`/connector/${sgConnector}`, 3000);
  await tid('method-m:CARD').click();
  await page.waitForTimeout(800);
  await shot('connector-sg-card');
  const before = sg.intents.size;
  await tid('start-cta').click();
  await page.waitForTimeout(2500);
  await shot('pay-card-hold');
  const pi = [...sg.intents.values()].slice(before).pop();
  check(`${scheme} B: a Stripe PaymentIntent with manual capture (card hold) in SGD`, pi?.capture_method === 'manual' && pi?.currency === 'sgd', pi);
  sg.confirmCard(pi!.id);
  await sg.flush();
  await tid('session-screen').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(14_000);
  await shot('session-live-sg', 200);
  // The authorisation lapses at Stripe before the capture (its webhook not delivered): capture fails as expired.
  sg.behaviour.deliver = false;
  sg.expireAuthorisation(pi!.id);
  sg.behaviour.deliver = true;
  await tid('stop').click();
  await page.waitForTimeout(600);
  await tid('choice-stop').click();
  await page.locator('[data-testid="view-receipt"]').first().waitFor({ timeout: 60_000 }).catch(() => null);
  const unpaid = await until(() => driver(tok!)('/v1/unpaid'), (r) => (r.unpaid ?? []).length > 0, 60_000, 1500);
  check(`${scheme} B: the hold expired before capture → the session is unpaid (server)`, unpaid.unpaid?.[0]?.kind === 'expired_hold' && unpaid.unpaid[0].owedMinor > 0, unpaid);
  await shot('session-complete-sg', 500);

  // Account deletion: refused while unpaid. One code a minute per number (429 "wait a moment" right after sign-in):
  // the driver taps again until a code is sent.
  const requestDeletionCode = async () => {
    for (let i = 0; i < 12; i++) {
      await tid('delete-continue').click();
      if (await tid('delete-dev-code').waitFor({ timeout: 6_000 }).then(() => true, () => false)) return;
      if (i === 0) await shot('delete-wait-a-minute', 200);
      await page.waitForTimeout(8_000);
    }
  };
  await go('/delete-account', 1800);
  await shot('delete-explain');
  await requestDeletionCode();
  const delCode = /(\d{6})/.exec(await tid('delete-dev-code').innerText())?.[1] ?? '';
  await shot('delete-code-blockers');
  await tid('delete-code').fill(delCode);
  await tid('delete-confirm').click();
  await tid('delete-blocked').waitFor({ timeout: 15_000 });
  await shot('delete-refused-unpaid');
  check(`${scheme} B: deletion refused (409) while a session is unpaid; the blocker offers Pay`, await tid('delete-blocker-unpaid').isVisible());

  // Pay it in the app: PayNow through Stripe (Save QR), paid at the fake.
  await tid('delete-blocker-unpaid').click();
  await page.waitForTimeout(2500);
  await shot('activity-unpaid');
  await page.locator('[data-testid^="unpaid-"]').first().click();
  await page.waitForTimeout(2500);
  await shot('receipt-unpaid');
  await tid('unpaid-method-m:PAYNOW').click().catch(() => null);
  const before2 = sg.intents.size;
  await tid('unpaid-pay-button').click();
  await page.waitForTimeout(2500);
  await shot('pay-unpaid-paynow');
  check(`${scheme} B: the unpaid session is paid with PayNow — a QR with Save QR`, await tid('save-qr').isVisible().catch(() => false));
  const settle = [...sg.intents.values()].slice(before2).pop();
  sg.payNow(settle!.id);
  await sg.flush();
  await tid('receipt-screen').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  await shot('receipt-paid');
  const after = await until(() => driver(tok!)('/v1/unpaid'), (r) => (r.unpaid ?? []).length === 0, 30_000, 1000);
  check(`${scheme} B: nothing unpaid any more (server)`, (after.unpaid ?? []).length === 0, after);

  // Deletion now succeeds; the app discards its revoked token and starts again as a guest.
  await go('/delete-account', 1800);
  await requestDeletionCode();
  const delCode2 = /(\d{6})/.exec(await tid('delete-dev-code').innerText())?.[1] ?? '';
  await tid('delete-code').fill(delCode2);
  await tid('delete-confirm').click();
  await tid('delete-done').waitFor({ timeout: 20_000 });
  await shot('delete-done');
  const oldMe = await fetch(`${API}/d/v1/me`, { headers: { authorization: `Bearer ${tok}` } });
  const newTok = await until(() => deviceToken(page), (t) => !!t && t !== tok, 10_000, 500);
  const newMe = newTok ? await driver(newTok)('/v1/me') : null;
  check(`${scheme} B: account deleted; the old device token is revoked (401) and the app has a new guest device`, oldMe.status === 401 && !!newTok && newTok !== tok && newMe?.account === null, { old: oldMe.status, newMe });
  await go('/', 2500);
  await shot('guest-map-after-delete');
  await ctx.close();
}

// ---------------------------------------------------------------- Journey C: QR deep link
async function journeyC(scheme: 'light' | 'dark') {
  const { ctx, page } = await context(scheme, { latitude: -6.2246, longitude: 106.9998 });
  const { shot, tid, go } = helpers(page, `${size.width}-${scheme}-C`);
  await go('/c/AUTEL-DC60-SMB-002%3A1', 3500);
  await shot('qr-deep-link');
  check(`${scheme} C: /c/AUTEL-DC60-SMB-002:1 resolves to its connector`, page.url().includes(`/connector/${dcConnector}`) && (await tid('connector-screen').isVisible()), page.url());
  await go('/c/NOPE-404', 2500);
  await shot('qr-unknown');
  check(`${scheme} C: an unknown code → not found, with manual entry`, await tid('resolve-not-found').isVisible());
  await ctx.close();
}

try {
  for (const sz of SIZES) {
    size = sz;
    for (const scheme of ['light', 'dark'] as const) {
      for (const [name, j] of [['A', journeyA], ['B', journeyB], ['C', journeyC]] as const) {
        try {
          await j(scheme);
        } catch (e) {
          check(`${sz.width} ${scheme} ${name}: journey ran to the end`, false, (e as Error).message);
        }
      }
    }
  }
} finally {
  await browser.close();
  for (const c of children) killTree(c.pid);
  for (const f of cleanup.reverse()) await f().catch(() => null);
  server.close();
}
fs.writeFileSync(path.join(out, 'errors.txt'), errors.join('\n') || 'no page errors');
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed; ${fs.readdirSync(out).filter((f) => f.endsWith('.png')).length} screenshots → ${out}; ${errors.length} page errors`);
process.exit(failed ? 1 : 0);
