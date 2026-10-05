/**
 * Visual review: serves the web export (built with EXPO_PUBLIC_API_BASE_URL=mock) and captures every screen at
 * phone sizes, light and dark, with Playwright's Chromium.
 *
 *   EXPO_PUBLIC_API_BASE_URL=mock npx expo export --platform web --output-dir dist/web
 *   node scripts/screenshots.mjs [outDir]
 *
 * Screens that need state (payment, live session, receipt, signed-in account) are reached by driving the app
 * like a driver would; the mock backend keeps its state in localStorage across navigations.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist', 'web');
const out = path.resolve(process.argv[2] ?? path.join(root, 'screenshots'));
fs.mkdirSync(out, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = path.join(dist, p);
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const SITE = '00000000-0000-4000-8000-000000000001';
const CONNECTOR = '00000000-0000-4000-8000-000000001001';
const SETTLED = { onboarded: true, language: 'en', theme: 'system', notifications: { charging: true, payments: true, reservations: true, account: true, promotions: false }, simpleStart: true, mapMode: 'map', locationPrompted: false, pushPrompted: false, phoneCountry: null };

const browser = await chromium.launch();
const errors = [];
const shots = [];

async function run(size, scheme, lang) {
  const tag = `${size.width}x${size.height}-${scheme}${lang === 'en' ? '' : `-${lang}`}`;
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 2, colorScheme: scheme, locale: lang === 'id' ? 'id-ID' : 'en-GB', hasTouch: true, isMobile: true });
  await ctx.route(/tile\.openstreetmap\.org|fonts\.gstatic/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(m.text()) && errors.push(`${tag} console: ${m.text().slice(0, 300)}`));
  const shot = async (name, wait = 900) => {
    await page.waitForTimeout(wait);
    const file = path.join(out, `${tag}-${name}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  };
  const tid = (id) => page.locator(`[data-testid="${id}"]`).first();
  const go = async (p, wait = 1200) => {
    await page.goto(base + p);
    await page.waitForTimeout(wait);
  };

  // 1. First open: onboarding.
  await go('/');
  await page.evaluate(() => localStorage.clear());
  await go('/', 1800);
  await shot('01-onboarding');
  await tid('onboarding-next').click();
  await shot('02-onboarding-pay', 500);

  // Settled driver from here on (English / Indonesian, button start for automation).
  await page.evaluate((s) => localStorage.setItem('ps.settings.v1', JSON.stringify(s)), { ...SETTLED, language: lang });
  await go('/', 2600);
  await shot('03-map');
  await tid('toggle-list').click();
  await shot('04-map-list', 900);
  await tid('toggle-list').click();
  await page.waitForTimeout(500);
  await tid('filters-button').click();
  await shot('05-filters', 900);
  await go('/search', 900);
  await tid('search-input').fill('Sudirman');
  await shot('06-search', 700);

  await go(`/station/${SITE}`, 1800);
  await shot('07-station');
  await go(`/connector/${CONNECTOR}`, 2200);
  await shot('08-connector');
  await page.mouse.wheel(0, 900);
  await shot('09-connector-methods', 500);

  // Start → QRIS payment → simulate → starting → charging.
  await tid('start-cta').click();
  await page.waitForTimeout(1500);
  await shot('10-pay-qris');
  await tid('simulate-payment').click();
  await page.waitForTimeout(1200);
  await shot('11-session-starting', 300);
  await page.waitForTimeout(9000);
  await shot('12-session-charging', 300);
  await go('/', 2000);
  await shot('13-map-with-session-pill');
  await tid('tab-activity').click();
  await shot('14-activity', 1500);
  await tid('session-pill').click();
  await page.waitForTimeout(1500);
  await tid('stop').click();
  await page.waitForTimeout(500);
  await tid('choice-stop').click();
  await page.waitForTimeout(4000);
  await shot('15-session-complete', 300);
  await tid('view-receipt').click();
  await shot('16-receipt', 1800);
  await go('/rate/charge/00000000-0000-4000-8000-000000500002', 1000);
  await page.locator('[data-testid="star-2"]').click();
  await shot('17-rate', 400);

  // Account, sign-in (OTP), signed-in screens.
  await go('/account', 1500);
  await shot('18-account-guest');
  await tid('go-sign-in').click();
  await page.waitForTimeout(800);
  await tid('phone-input').fill('812 3456 7890');
  await shot('19-sign-in-phone', 300);
  await tid('send-code').click();
  await page.waitForTimeout(1200);
  await shot('20-sign-in-code', 300);
  await tid('code-input').fill('123456');
  await page.waitForTimeout(2500);
  await shot('21-account-signed-in', 500);
  await go('/payment-methods', 1500);
  await shot('22-payment-methods');
  await go('/activity', 2000);
  await shot('23-activity-history');
  await go('/partner/00000000-0000-4000-8000-000000009003/LOC-SG-11?countryCode=SG&partyId=LCE', 2000);
  await page.locator('[data-testid="evse-EVSE-1"]').click();
  await shot('24-partner-station', 600);
  await page.evaluate((s) => localStorage.setItem('ps.settings.v1', JSON.stringify(s)), { ...SETTLED, language: lang, simpleStart: false });
  await go(`/connector/${CONNECTOR.replace('1001', '1019')}`, 2200);
  await shot('25-connector-sgd');
  await go('/receipt/roaming/00000000-0000-4000-8000-000000008002', 1800);
  await shot('26-receipt-partner');
  await go('/delete-account', 1200);
  await shot('27-delete-account');
  await go('/settings/notifications', 900);
  await shot('28-settings-notifications');
  await go('/scan', 1200);
  await shot('29-scan-manual');
  await go('/c/NOPE-404', 1800);
  await shot('30-resolve-not-found');
  await go('/report?connectorId=x&site=Senayan%20Hub', 900);
  await tid('cat-broken').click();
  await shot('31-report', 300);
  await go('/settings/language', 800);
  await shot('32-language');
  await ctx.close();
}

const sizes = [
  { width: 390, height: 844 },
  { width: 360, height: 800 },
];
if (process.env.QUICK) await run(sizes[0], 'dark', 'en');
else for (const size of sizes) for (const scheme of ['light', 'dark']) await run(size, scheme, 'en');
if (!process.env.QUICK) await run(sizes[0], 'dark', 'id');

await browser.close();
server.close();
fs.writeFileSync(path.join(out, 'errors.txt'), errors.join('\n') || 'no page errors');
console.log(`${shots.length} screenshots → ${out}`);
console.log(errors.length ? `${errors.length} page errors (see errors.txt)` : 'no page errors');
