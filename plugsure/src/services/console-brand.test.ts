import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { one, query, withOrg } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { decodePng, encodePng } from './png.js';
import { contrast, saveBrand, forgetBrands } from './brand.js';
import {
  consolePalette, saveConsoleBrand, saveConsoleLogo, removeConsoleLogo, deleteConsoleBrand, consoleBrandForHost, consoleBrandForOrg,
  logoBySha, brandView, forgetConsoleBrands, hostOf, listHostnameClaims, approveHostname, revokeHostname,
} from './console-brand.js';

/**
 * White-label console (v1.5.0): colours that stay readable, validation, and the
 * checks that must see across operators even inside one operator's request
 * (row-level security shows a request only its own rows). The database tests run
 * only against the disposable database (plugsure_audit_fix).
 */

const LIGHT = ['#ffffff', '#f4f6f9', '#f8f9fb', '#eceff4'];
const DARK = ['#0d1117', '#11161d', '#151b23', '#1a212b'];

test('palette: the accent reads at 4.5:1 on every surface and on its own tint, in both themes; white reads on the brand colour', () => {
  for (const accent of ['#0c7856', '#ffd400', '#ff8a00', '#00e5ff', '#1b1b1b', '#ffffff', '#7a00ff', '#e11d48']) {
    for (const brand of ['#1b4d8c', '#ffe066', '#ffffff', '#000000']) {
      const p = consolePalette(brand, accent);
      for (const s of [...LIGHT, p.light.soft]) assert.ok(contrast(p.light.accent, s) >= 4.5, `light ${accent} on ${s}: ${contrast(p.light.accent, s)}`);
      for (const s of [...DARK, p.dark.soft]) assert.ok(contrast(p.dark.accent, s) >= 4.5, `dark ${accent} on ${s}: ${contrast(p.dark.accent, s)}`);
      assert.ok(contrast(p.light.accent, p.light.ink) >= 4.5, `button text, light, ${accent}`);
      assert.ok(contrast(p.dark.accent, p.dark.ink) >= 4.5, `button text, dark, ${accent}`);
      assert.ok(contrast(p.brand, '#ffffff') >= 4.5, `white on brand ${brand}`);
    }
  }
  // PlugSure's own accent is already readable in the light theme; a yellow one is not.
  assert.equal(consolePalette('#1b4d8c', '#0c7856').light.accent, '#0c7856');
  assert.equal(consolePalette('#1b4d8c', '#ffd400').adjusted, true);
});

test('hostOf: lower-case, without port or trailing dot', () => {
  assert.equal(hostOf('Console.Example.CO.ID:443'), 'console.example.co.id');
  assert.equal(hostOf('console.example.id.'), 'console.example.id');
  assert.equal(hostOf(undefined), '');
});

// ─────────────────────────────────────────────── database

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbTest = DB_OK ? test : test.skip;
const dbLock = databaseTestLock('shared', DB_OK);
const SLUGS = ['console-brand-test-a', 'console-brand-test-b', 'console-brand-test-c'];
const HOST_A = 'console.brand-test-a.example';
const HOST_C = 'app.brand-test-c.example';
let orgA = '', orgB = '', orgC = '';

/**
 * A request of this operator as the API makes it: its org pinned, and as the runtime
 * role (the tests otherwise connect as the superuser, which row-level security ignores).
 */
const asOrg = <T>(orgId: string, fn: () => Promise<T>) => withOrg(orgId, async () => { await query('SET LOCAL ROLE plugsure_app'); return fn(); });

/** A square test logo. */
function logo(size: number, w = size): Buffer {
  const data = new Uint8Array(w * size * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 255; data[i + 1] = 138; data[i + 2] = 0; data[i + 3] = 255; }
  return encodePng({ width: w, height: size, data });
}

async function cleanup() {
  const orgs = await query<{ id: string }>(`SELECT id FROM organisation WHERE slug = ANY($1)`, [SLUGS]);
  const ids = orgs.rows.map((r) => r.id);
  await query(`DELETE FROM console_brand WHERE org_id = ANY($1::uuid[])`, [ids]);
  await query(`DELETE FROM driver_app_brand WHERE org_id = ANY($1::uuid[])`, [ids]);
  forgetConsoleBrands(); forgetBrands();
}

before(dbLock.acquire);
after(dbLock.release);
if (DB_OK) {
  before(async () => {
    await cleanup();
    const mk = async (slug: string, name: string) => (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name, slug]))!.id;
    orgA = await mk(SLUGS[0]!, 'Console Brand A');
    orgB = await mk(SLUGS[1]!, 'Console Brand B');
    orgC = await mk(SLUGS[2]!, 'Console Brand C');
  });
  after(cleanup);
}

dbTest('save: validation, defaults, and fields left out keep their value', async () => {
  await asOrg(orgA, async () => {
    await assert.rejects(saveConsoleBrand(orgA, {}), (e: any) => e.status === 422 && !!e.fields.productName);
    await assert.rejects(saveConsoleBrand(orgA, { productName: 'X', accentColor: 'red' }), (e: any) => e.status === 422 && !!e.fields.accentColor);
    await assert.rejects(saveConsoleBrand(orgA, { productName: 'X', hostname: 'https://not a host/' }), (e: any) => e.status === 422 && !!e.fields.hostname);
    await assert.rejects(saveConsoleBrand(orgA, { productName: 'X', hostname: 'localhost' }), (e: any) => e.status === 422 && !!e.fields.hostname);
    await assert.rejects(saveConsoleBrand(orgA, { productName: '<script>' }), (e: any) => e.status === 422 && !!e.fields.productName);
    const b = await saveConsoleBrand(orgA, { productName: 'NusaCharge Ops', accentColor: '#FF8A00', hostname: `https://${HOST_A.toUpperCase()}/login` });
    assert.equal(b.accentColor, '#ff8a00');
    assert.equal(b.brandColor, '#1b4d8c');
    assert.equal(b.hostname, HOST_A);
    assert.equal(b.showPoweredBy, true);
    const b2 = await saveConsoleBrand(orgA, { tagline: 'Network operations', showPoweredBy: false });
    assert.equal(b2.productName, 'NusaCharge Ops');
    assert.equal(b2.hostname, HOST_A);
    assert.equal(b2.tagline, 'Network operations');
    assert.equal(b2.showPoweredBy, false);
  });
});

dbTest('web address: it takes effect only once the platform operator approves it; a waiting claim blocks nobody', async () => {
  forgetConsoleBrands();
  assert.equal(await consoleBrandForHost(HOST_A), null, 'not approved: no brand on the sign-in page, no restriction');
  // Another operator may enter the same address while A's waits (no squatting by claiming first).
  await asOrg(orgB, async () => {
    const b = await saveConsoleBrand(orgB, { productName: 'B', hostname: HOST_A });
    assert.equal(b.hostnameApproved, false);
  });
  const claims = (await listHostnameClaims()).filter((c) => c.hostname === HOST_A);
  assert.equal(claims.length, 2);
  await assert.rejects(approveHostname(orgA, 'elsewhere.example', null), (e: any) => e.status === 409 && e.fields.hostname === 'changed');
  const ok = await approveHostname(orgA, HOST_A.toUpperCase(), null);
  assert.ok(ok.approvedAt);
  assert.equal((await consoleBrandForHost(HOST_A))?.orgId, orgA);
  // Now it is A's: B can neither have it approved nor enter it.
  await assert.rejects(approveHostname(orgB, HOST_A, null), (e: any) => e.status === 409 && e.fields.hostname === 'taken');
  await asOrg(orgB, async () => {
    await assert.rejects(saveConsoleBrand(orgB, { hostname: HOST_A }), (e: any) => e.status === 409 && /console already uses/.test(e.message));
  });
});

dbTest('web address: PlugSure’s own addresses can never be approved or matched', async () => {
  const old = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = 'https://console.plugsure-shared.example';
  try {
    await asOrg(orgB, async () => {
      await assert.rejects(saveConsoleBrand(orgB, { hostname: 'console.plugsure-shared.example' }), (e: any) => e.status === 422 && !!e.fields.hostname);
    });
    // Even a row that names one (written before the address was reserved) is never used.
    await query(`UPDATE console_brand SET hostname = 'console.plugsure-shared.example' WHERE org_id = $1`, [orgB]);
    await assert.rejects(approveHostname(orgB, 'console.plugsure-shared.example', null), (e: any) => e.status === 409 && e.fields.hostname === 'reserved');
    await query(`UPDATE console_brand SET hostname_approved_at = now() WHERE org_id = $1`, [orgB]);
    forgetConsoleBrands();
    assert.equal(await consoleBrandForHost('console.plugsure-shared.example'), null);
  } finally {
    if (old === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = old;
    await query(`UPDATE console_brand SET hostname = NULL, hostname_approved_at = NULL WHERE org_id = $1`, [orgB]);
    forgetConsoleBrands();
  }
});

dbTest('web address: changing it withdraws the approval; the platform operator can withdraw it too', async () => {
  await asOrg(orgA, async () => {
    const moved = await saveConsoleBrand(orgA, { hostname: `new.${HOST_A}` });
    assert.equal(moved.hostnameApproved, false);
    const back = await saveConsoleBrand(orgA, { hostname: HOST_A });
    assert.equal(back.hostnameApproved, false, 'moving back needs a new approval');
    const same = await saveConsoleBrand(orgA, { tagline: 'Ops' });
    assert.equal(same.hostnameApproved, false);
  });
  await approveHostname(orgA, HOST_A, null);
  const kept = await asOrg(orgA, () => saveConsoleBrand(orgA, { tagline: 'Network operations' }));
  assert.equal(kept.hostnameApproved, true, 'saving other fields keeps the approval');
  assert.equal(await revokeHostname(orgA), true);
  forgetConsoleBrands();
  assert.equal(await consoleBrandForHost(HOST_A), null);
  await approveHostname(orgA, HOST_A, null);
});

dbTest('web address: console and driver-app addresses are kept apart, both ways, across operators', async () => {
  await asOrg(orgC, async () => {
    // A driver app may not take A's approved console address.
    await assert.rejects(saveBrand(orgC, { appName: 'C App', hostname: HOST_A }), (e: any) => e.status === 409 && /operator console already uses/.test(e.message));
    await saveBrand(orgC, { appName: 'C App', slug: 'brand-test-c', hostname: HOST_C });
  });
  await asOrg(orgB, async () => {
    // A console may not take C's driver-app address.
    await assert.rejects(saveConsoleBrand(orgB, { hostname: HOST_C }), (e: any) => e.status === 409 && /driver app already uses/.test(e.message));
    // The driver-app check itself now sees other operators (before v1.5.0 it hit the UNIQUE constraint: a server error).
    await assert.rejects(saveBrand(orgB, { appName: 'B App', slug: 'brand-test-c' }), (e: any) => e.status === 409 && /short name/.test(e.message));
  });
});

dbTest('a request sees only its own brand; the sign-in lookup ignores case and port', async () => {
  forgetConsoleBrands();
  assert.equal((await consoleBrandForHost(`${HOST_A.toUpperCase()}:443`))?.orgId, orgA);
  assert.equal(await consoleBrandForHost('unknown.example'), null);
  forgetConsoleBrands();
  const seen = await asOrg(orgB, () => one<{ n: number }>(`SELECT count(*)::int AS n FROM console_brand WHERE org_id = $1`, [orgA]));
  assert.equal(seen?.n, 0, 'row-level security: B cannot read A’s brand');
  assert.equal((await asOrg(orgA, () => consoleBrandForOrg(orgA)))?.productName, 'NusaCharge Ops');
});

dbTest('save: a body that is not an object is refused (422), not a server error', async () => {
  await asOrg(orgA, async () => {
    for (const bad of ['x', 5, null, [1]]) await assert.rejects(saveConsoleBrand(orgA, bad as any), (e: any) => e.status === 422);
  });
});

dbTest('logo: square PNG only, stored as 256 × 256, served by its hash, and removable', async () => {
  const brand = await asOrg(orgA, async () => {
    await assert.rejects(saveConsoleLogo(orgA, logo(300, 400)), /square/);
    await assert.rejects(saveConsoleLogo(orgA, logo(32)), /between 64 and 2048/);
    await assert.rejects(saveConsoleLogo(orgA, Buffer.from('GIF89a')), /PNG/);
    const { brand: b, logo: report } = await saveConsoleLogo(orgA, logo(512));
    assert.equal(report.width, 512);
    assert.ok(b.hasLogo);
    return b;
  });
  // Served publicly (the sign-in page), outside any request's org.
  const png = await logoBySha(brand.logoSha256!);
  assert.equal(decodePng(png!).width, 256);
  assert.equal(brandView(brand).logoUrl, `/console-brand/${brand.logoSha256}.png`);
  assert.equal(await logoBySha('../etc/passwd'), null);
  const after = await asOrg(orgA, () => removeConsoleLogo(orgA));
  assert.equal(after?.hasLogo, false);
  await asOrg(orgB, async () => {
    await deleteConsoleBrand(orgB);
    await assert.rejects(saveConsoleLogo(orgB, logo(256)), (e: any) => e.status === 404);
  });
});
