import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decodePng, encodePng, resize, onBackground, type Rgba } from './png.js';
import { buildZip, readZip } from './zip.js';
import {
  validateBrand, palette, contrast, DARK_SURFACES, LIGHT_SURFACES, renderIndex, manifestFor, renderServiceWorker, assetLinks, appleAssociation,
  normaliseFingerprint, buildKit, checkIcon, slugFrom, BrandError, type Brand,
} from './brand.js';
import { OTP_TEXT } from '../integrations/otp.js';

const WEB = join(import.meta.dirname, '..', 'driver-web');

/** A test icon: an orange square with a white disc, full bleed. */
function testIcon(size = 1024): Buffer {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const inDisc = (x - size / 2) ** 2 + (y - size / 2) ** 2 < (size / 4) ** 2;
    data[i] = inDisc ? 255 : 255; data[i + 1] = inDisc ? 255 : 138; data[i + 2] = inDisc ? 255 : 0; data[i + 3] = 255;
  }
  return encodePng({ width: size, height: size, data });
}

const brand = (over: Partial<Brand> = {}): Brand => ({
  orgId: '00000000-0000-4000-8000-000000000001', slug: 'nusacharge', status: 'live', appName: 'NusaCharge', shortName: 'NusaCharge',
  taglineId: 'Isi daya di jalan tol', taglineEn: 'Charge on the toll road', descriptionId: null, descriptionEn: null,
  accentColor: '#ff8a00', badgeColor: '#12305a', hasIcon: true, iconSha256: 'ab'.repeat(32),
  supportEmail: 'halo@nusacharge.id', supportPhone: '+6281234567890', privacyUrl: 'https://nusacharge.id/privasi', termsUrl: null,
  hostname: 'app.nusacharge.id', androidPackage: 'id.nusacharge.app', androidCertSha256: [normaliseFingerprint('AB'.repeat(32))!],
  iosBundleId: 'id.nusacharge.app', iosTeamId: 'ABCDE12345', versionName: '1.2.0', versionCode: 7,
  updatedAt: new Date().toISOString(), publishedAt: null,
  apnsKeyId: null, apnsConfigured: false, apnsCheckedAt: null, apnsCheckOk: null, apnsCheckDetail: null,
  scope: 'operator', fcmProjectId: null, fcmClientEmail: null, fcmConfigured: false, fcmCheckedAt: null, fcmCheckOk: null, fcmCheckDetail: null, appConfig: {}, ...over,
});

test('PNG: an encoded image decodes to the same pixels; shrinking averages, enlarging interpolates; the App Store icon is opaque', () => {
  const src: Rgba = { width: 4, height: 4, data: new Uint8Array(64).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) % 256)) };
  const back = decodePng(encodePng(src));
  assert.deepEqual([...back.data], [...src.data]);
  const half = resize(back, 2, 2);
  assert.equal(half.width, 2);
  // Top-left 2×2 block of the red channel: its average.
  const avg = Math.round([0, 1, 4, 5].map((p) => src.data[p * 4]!).reduce((a, b) => a + b) / 4);
  assert.ok(Math.abs(half.data[0]! - avg) <= 1);
  assert.equal(resize(back, 9, 9).width, 9);
  const flat = encodePng(onBackground(decodePng(testIcon(512)), 64, [18, 48, 90]), { opaque: true });
  assert.equal(flat[25], 2, 'colour type 2: RGB, no alpha');
  assert.equal(decodePng(flat).data[3], 255);
});

test('icon checks: square, 512–2048, PNG; a smaller one is accepted with a warning', () => {
  assert.equal(checkIcon(testIcon(1024)).width, 1024);
  assert.equal(checkIcon(testIcon(1024)).warnings.length, 0);
  assert.match(checkIcon(testIcon(512)).warnings[0]!, /1024/);
  assert.throws(() => checkIcon(testIcon(256)), /between 512 and 2048/);
  assert.throws(() => checkIcon(encodePng({ width: 600, height: 512, data: new Uint8Array(600 * 512 * 4) })), /square/);
  assert.throws(() => checkIcon(Buffer.from('GIF89a')), /PNG/);
});

test('zip: what is written reads back byte for byte', () => {
  const z = buildZip([{ name: 'a.txt', data: 'hello '.repeat(100) }, { name: 'dir/b.bin', data: Buffer.from([0, 1, 2, 255]) }]);
  const r = readZip(z);
  assert.equal(r.get('a.txt')!.toString(), 'hello '.repeat(100));
  assert.deepEqual([...r.get('dir/b.bin')!], [0, 1, 2, 255]);
  assert.throws(() => buildZip([{ name: '../x', data: '' }]));
});

test('validation: names, colours, addresses and store identifiers; the version code never goes down', () => {
  const v = validateBrand({ appName: 'NusaCharge', accentColor: '#FF8A00', hostname: 'https://App.NusaCharge.id/', supportPhone: '0812-3456-7890', androidCertSha256: 'ab'.repeat(32) }, null);
  assert.equal(v.slug, 'nusacharge');
  assert.equal(v.accentColor, '#ff8a00');
  assert.equal(v.hostname, 'app.nusacharge.id');
  assert.equal(v.supportPhone, '+6281234567890');
  assert.equal(v.androidCertSha256[0], 'AB:'.repeat(31) + 'AB');
  assert.equal(v.shortName, 'NusaCharge');
  const bad = (input: Record<string, unknown>, field: string, current: Brand | null = null) => {
    try { validateBrand({ appName: 'X Charge', ...input }, current); assert.fail(`${field} accepted`); } catch (e) { assert.ok(e instanceof BrandError && e.fields[field], `${field}: ${(e as Error).message}`); }
  };
  bad({ appName: 'Nusa "Charge"' }, 'appName');
  bad({ appName: 'A'.repeat(31) }, 'appName');
  bad({ accentColor: 'orange' }, 'accentColor');
  bad({ hostname: 'not a host' }, 'hostname');
  bad({ privacyUrl: 'http://insecure.example/privacy' }, 'privacyUrl');
  bad({ androidPackage: 'NusaCharge' }, 'androidPackage');
  bad({ androidCertSha256: ['12:34'] }, 'androidCertSha256');
  bad({ iosTeamId: 'abc' }, 'iosTeamId');
  bad({ taglineId: 'Isi <b>daya</b>' }, 'taglineId');
  bad({ slug: 'app' }, 'slug');
  bad({ versionCode: 3 }, 'versionCode', brand());
  assert.equal(slugFrom('Ésa Charge! 2'), 'esa-charge-2');
});

test('colours: whatever the accent, text in it reads at 4.5:1 on every surface of both themes, and so does text on it', () => {
  for (const accent of ['#ff8a00', '#ffff00', '#000080', '#777777', '#2fd6a7', '#e30613', '#ffffff', '#000000']) {
    const p = palette(accent, '#12305a');
    for (const s of DARK_SURFACES) assert.ok(contrast(p.dark.accent, s) >= 4.5, `${accent} dark on ${s}: ${contrast(p.dark.accent, s)}`);
    for (const s of LIGHT_SURFACES) assert.ok(contrast(p.light.accent, s) >= 4.5, `${accent} light on ${s}: ${contrast(p.light.accent, s)}`);
    assert.ok(contrast(p.dark.accent, p.dark.on) >= 4.5 && contrast(p.light.accent, p.light.on) >= 4.5);
  }
  assert.equal(palette('#2fd6a7', '#1b4d8c').dark.accent, '#2fd6a7', 'PlugSure’s own teal is fine in the dark theme as it is');
});

test('the page for a brand: renamed, recoloured, its icon, told its brand; still valid script; nothing of PlugSure left', () => {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  const b = brand();
  const out = renderIndex(html, b, { preview: false });
  assert.ok(!out.includes('PlugSure'), 'no PlugSure left');
  assert.match(out, /<title>NusaCharge — /);
  assert.match(out, /window\.BRAND=\{"slug":"nusacharge","name":"NusaCharge"/);
  assert.match(out, /:root\{--arus:#[0-9a-f]{6};/);
  assert.match(out, /const BRAND_ICON='<img class="brand-badge" src="\/app\/brand\/nusacharge\/icon-96\.png/);
  assert.ok(out.includes("'Isi daya di jalan tol':'Charge on the toll road'"), 'the tagline has its English');
  assert.ok(!out.includes('Isi daya, di mana saja'));
  assert.ok(out.includes('<link rel="manifest" href="manifest.webmanifest">'));
  assert.ok(renderIndex(html, b, { preview: true }).includes('manifest.webmanifest?brand=nusacharge'));
  // Every inline script still parses.
  for (const m of out.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(m[1]!), 'script parses');
});

test('the page for a brand: the operator\'s default language (English in Malaysia and Singapore) is what the app starts in', () => {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  const b = brand();
  assert.match(renderIndex(html, b, { preview: false, defaultLang: 'en' }), /<html lang="en" data-default-lang="en">/);
  assert.match(renderIndex(html, b, { preview: false, defaultLang: 'id' }), /<html lang="id" data-default-lang="id">/);
  assert.match(renderIndex(html, b, { preview: false }), /<html lang="id">/, 'none set: as before');
  assert.match(renderIndex(html, b, { preview: false, defaultLang: 'fr"><script>' }), /<html lang="id">/, 'only id or en');
});

test('manifest, push worker and store association files for a brand', () => {
  const base = readFileSync(join(WEB, 'manifest.webmanifest'), 'utf8');
  const b = brand();
  const m = manifestFor(b, base, { preview: false }) as any;
  assert.equal(m.short_name, 'NusaCharge');
  assert.equal(m.start_url, '/app/');
  assert.deepEqual(m.icons.map((i: any) => i.purpose), ['any', 'any', 'maskable']);
  assert.equal(m.related_applications[0].id, 'id.nusacharge.app');
  assert.equal((manifestFor(b, base, { preview: true }) as any).start_url, '/app/?brand=nusacharge');
  assert.equal((manifestFor(null, base, { preview: false }) as any).short_name, 'PlugSure');
  const sw = renderServiceWorker(readFileSync(join(WEB, 'sw.js'), 'utf8'), b);
  assert.ok(!sw.includes('PlugSure') && sw.includes('/app/brand/nusacharge/icon-192.png') && !sw.includes('data:image/svg'));
  assert.doesNotThrow(() => new Function(sw));
  assert.deepEqual((assetLinks(b)[0] as any).target, { namespace: 'android_app', package_name: 'id.nusacharge.app', sha256_cert_fingerprints: b.androidCertSha256 });
  assert.deepEqual(assetLinks(brand({ androidCertSha256: [] })), []);
  assert.deepEqual((appleAssociation(b) as any).applinks.details[0].appIDs, ['ABCDE12345.id.nusacharge.app']);
  assert.equal(OTP_TEXT('123456', 'NusaCharge').startsWith('Kode masuk NusaCharge: 123456.'), true);
  assert.equal(OTP_TEXT('123456').startsWith('Kode masuk PlugSure: 123456.'), true);
});

test('build kit: Android (Bubblewrap), iOS (Capacitor) and store texts, with icons of the right sizes', async () => {
  const png = testIcon(1024);
  const b = brand({ iconSha256: createHash('sha256').update(png).digest('hex'), apnsKeyId: 'ABC1234567', apnsConfigured: true, apnsCheckOk: true });
  const kit = await buildKit(b, { iconPng: png });
  assert.deepEqual(kit.warnings, []);
  const files = readZip(kit.zip);
  const twa = JSON.parse(files.get('android/twa-manifest.json')!.toString());
  assert.equal(twa.packageId, 'id.nusacharge.app');
  assert.equal(twa.host, 'app.nusacharge.id');
  assert.equal(twa.appVersionCode, 7);
  assert.match(twa.iconUrl, /^https:\/\/app\.nusacharge\.id\/app\/brand\/nusacharge\/icon-512\.png/);
  for (const [d, s] of [['mdpi', 48], ['xxxhdpi', 192]] as const) assert.equal(decodePng(files.get(`android/res/mipmap-${d}/ic_launcher.png`)!).width, s);
  const ios = decodePng(files.get('ios/AppIcon-1024.png')!);
  assert.equal(ios.width, 1024);
  assert.equal(files.get('ios/AppIcon-1024.png')![25], 2, 'App Store icon without alpha');
  assert.equal(JSON.parse(files.get('ios/capacitor.config.json')!.toString()).server.url, 'https://app.nusacharge.id/app/');
  assert.match(files.get('store/listing-id.md')!.toString(), /NusaCharge adalah aplikasi resmi/);
  assert.match(files.get('README.md')!.toString(), /bubblewrap build/);
  assert.match(files.get('README.md')!.toString(), /The key ABC1234567 is uploaded and was accepted by Apple/);
  assert.deepEqual(JSON.parse(files.get('ios/package.json')!.toString()).dependencies['@capacitor/push-notifications'], '^7.0.0');
  assert.match(files.get('ios/App.entitlements.additions.xml')!.toString(), /aps-environment/);
  assert.match(files.get('ios/AppDelegate.additions.swift')!.toString(), /capacitorDidRegisterForRemoteNotifications/);
  const cats = files.get('ios/PlugSureNotifications.swift')!.toString();
  for (const c of ['PS_SESSION', 'PS_RECEIPT', 'PS_UNPAID', 'PS_QUEUE', 'PS_RESERVATION']) assert.ok(cats.includes(`"${c}"`), c);
  assert.match(files.get('ios/NotificationService/NotificationService.swift')!.toString(), /UNNotificationAttachment/);
  assert.match(files.get('ios/App.entitlements.additions.xml')!.toString(), /usernotifications\.time-sensitive/);
  // Live Activities: Swift string interpolation survives the template literal ("\(…)", not "(…)").
  const widget = files.get('ios/LiveActivity/ChargingLiveActivity.swift')!.toString();
  assert.ok(widget.includes('Text("\\(Int(end.timeIntervalSince(state.started) / 60)) min")'), 'interpolation kept');
  assert.ok(widget.includes('"Baterai \\(pct)%"'));
  assert.ok(files.get('ios/LiveActivity/ChargingAttributes.swift')!.toString().includes('"\\(Int((Double($0) / 1000).rounded())) kW"'));
  // The cost so far while charging: decoded (optional, so older payloads still decode) and shown, interpolation intact.
  const attrs = files.get('ios/LiveActivity/ChargingAttributes.swift')!.toString();
  assert.match(attrs, /var estimateIdr: Int\?/);
  assert.ok(attrs.includes('"Biaya sejauh ini \\(e)"') && attrs.includes('"Cost so far \\(e)"'), 'running cost label kept');
  assert.match(widget, /state\.runningCostText/);
  assert.match(files.get('ios/LiveActivity/LiveActivityPlugin.swift')!.toString(), /costIdr: nil, estimateIdr: nil/);
  assert.match(files.get('ios/LiveActivity/LiveActivityPlugin.swift')!.toString(), /pushToStartTokenUpdates/);
  assert.match(files.get('ios/LiveActivity/MyViewController.swift')!.toString(), /registerPluginInstance\(LiveActivityPlugin\(\)\)/);
  assert.match(files.get('ios/Info.plist.additions.xml')!.toString(), /NSSupportsLiveActivities/);
  const draft = await buildKit(brand({ status: 'draft', hostname: null, hasIcon: false, androidPackage: null, privacyUrl: null }));
  assert.equal(draft.warnings.length, 6);
});
