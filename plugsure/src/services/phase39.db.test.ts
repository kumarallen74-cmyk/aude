import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 39 (v1.51.0), advertising on charger and kiosk screens: CPM and flat pricing; a screen and its key; a
 * campaign that plays only once active with an approved creative (the file's type checked), at its sites and dates;
 * the player's playlist, files and proof of play; the budget pausing it; the invoice (CPM by plays, flat prorated,
 * the tax), issued with a number and paid; the worker ending campaigns.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/phase39.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const ads = await import('./advertising.js');

const TAG = randomBytes(3).toString('hex');
let org = '', siteA = '', siteB = '', cp = '';
const png = `data:image/png;base64,${Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)]).toString('base64')}`;
const fakePng = `data:image/png;base64,${Buffer.from('this is not a png at all').toString('base64')}`;

describe('Phase 39, pure', () => {
  test('CPM and flat pricing', () => {
    assert.equal(ads.cpmAmount(2500, 40_000), 100_000);
    assert.equal(ads.cpmAmount(1, 1500), 2);
    assert.deepEqual(ads.flatAmount(3_000_000, '2026-11', '2026-11-01', '2026-12-31'), { days: 30, amount: 3_000_000 });
    assert.deepEqual(ads.flatAmount(3_000_000, '2026-11', '2026-11-16', '2026-12-31'), { days: 15, amount: 1_500_000 });
    assert.deepEqual(ads.flatAmount(3_000_000, '2026-11', '2026-12-01', '2026-12-31'), { days: 0, amount: 0 });
  });
});

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P39 ${TAG}`, `p39-${TAG}`]))!.id;
    siteA = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, timezone) VALUES ($1, $2, 'ID', 'Asia/Jakarta') RETURNING id`, [org, `Mall ${TAG}`]))!.id;
    siteB = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, timezone) VALUES ($1, $2, 'ID', 'Asia/Jakarta') RETURNING id`, [org, `Toll ${TAG}`]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, adopted_at, status) VALUES ($1, $2, now(), 'active') RETURNING id`, [siteA, `P39-${TAG}`]))!.id;
  });
}

dbDescribe('Phase 39: advertising', () => {
  let keyA = '', keyB = '', adv = '', camp = '', creative = '';
  test('screens with their keys; a charger must be at the screen\'s site', async () => {
    await assert.rejects(ads.saveScreen(org, null, { siteId: siteB, chargePointId: cp, name: 'X' }), /not at this site/);
    keyA = ((await ads.saveScreen(org, null, { siteId: siteA, chargePointId: cp, name: 'DC 1 screen' })) as any).key;
    keyB = ((await ads.saveScreen(org, null, { siteId: siteB, name: 'Rest area kiosk', orientation: 'portrait' })) as any).key;
    assert.match(keyA, /^scr_/);
    await assert.rejects(ads.player('scr_nope'), /Unknown screen key/);
    const p = await ads.player(keyA);
    assert.deepEqual(p.playlist, [], 'advertising is off');
  });

  test('a campaign plays only when active, with an approved creative, at its sites', async () => {
    await ads.saveSettings(org, { enabled: true, taxBps: 1100 });
    adv = ((await ads.saveAdvertiser(org, null, { name: 'Kopi Kenangan', email: 'ads@kopi.test' })) as any).id;
    const today = ads.localDay();
    const c = await ads.saveCampaign(org, null, { advertiserId: adv, name: 'Pagi', startsOn: today, endsOn: today, siteIds: [siteA], pricing: 'cpm', rateMinor: 40_000, budgetMinor: 100 });
    camp = c.id;
    assert.equal(c.status, 'draft');
    await assert.rejects(ads.addCreative(org, camp, { name: 'fake.png', dataUrl: fakePng }), /not the type it says/);
    creative = (await ads.addCreative(org, camp, { name: 'pagi.png', dataUrl: png, seconds: 10 })).id;
    await assert.rejects(ads.setStatus(org, camp, { status: 'active' }), /Approve a creative first/);
    await assert.rejects(ads.reviewCreative(org, creative, { review: 'rejected' }, null), /why/);
    await ads.reviewCreative(org, creative, { review: 'approved' }, null);
    await ads.setStatus(org, camp, { status: 'active' });
    const a = await ads.player(keyA);
    assert.equal(a.playlist.length, 1);
    assert.equal(a.playlist[0]!.seconds, 10);
    assert.deepEqual((await ads.player(keyB)).playlist, [], 'not at the other site');
    const f = await ads.playerFile(keyA, creative);
    assert.equal(f.mime, 'image/png');
  });

  test('proof of play is counted; a spent budget pauses the campaign', async () => {
    await assert.rejects(ads.reportPlays(keyA, { plays: [{ creativeId: creative, count: 5, day: '2020-01-01' }] }), /today or yesterday/);
    const r = await ads.reportPlays(keyA, { plays: [{ creativeId: creative, count: 2000 }, { creativeId: creative, count: 600 }] });
    assert.equal(r.counted, 2600);
    const c = await ads.campaign(org, camp);
    assert.equal(c.plays, 2600);
    assert.equal(c.spentMinor, 104_000, '2,600 plays at 40,000 per thousand');
    assert.deepEqual((await ads.player(keyA)).playlist, [], 'over budget: no longer played');
    const s = await ads.sweep();
    assert.ok(s.paused >= 1);
    const p = await ads.campaign(org, camp);
    assert.equal(p.status, 'paused');
    assert.equal(p.pausedReason, 'Budget spent');
    await assert.rejects(ads.setStatus(org, camp, { status: 'active' }), /budget is spent/);
    const x = await ads.proofXlsx(org, camp);
    assert.ok(x.data.length > 1000);
  });

  test('the month\'s invoice: CPM by plays, flat prorated, the tax; issued with a number, then paid', async () => {
    const month = ads.localDay().slice(0, 7);
    const flat = await ads.saveCampaign(org, null, { advertiserId: adv, name: 'Banner', startsOn: `${month}-01`, endsOn: `${month}-10`, pricing: 'flat', rateMinor: 3_000_000 });
    const k = await ads.addCreative(org, flat.id, { name: 'banner.png', dataUrl: png });
    await ads.reviewCreative(org, k.id, { review: 'approved' }, null);
    await query(`UPDATE ad_campaign SET status = 'active' WHERE id = $1`, [flat.id]);
    const inv = await ads.draftInvoice(org, adv, month);
    const days = Number(month.slice(5)) === 2 ? 28 : 30;
    const flatLine = inv.lines.find((l: any) => l.pricing === 'flat');
    assert.equal(inv.lines.find((l: any) => l.pricing === 'cpm').amountMinor, 104_000);
    assert.equal(flatLine.days, 10);
    assert.ok(Math.abs(flatLine.amountMinor - Math.round((3_000_000 * 10) / (days === 28 ? 28 : new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate()))) <= 1);
    assert.equal(inv.taxMinor, Math.round(inv.subtotalMinor * 0.11));
    assert.equal(inv.totalMinor, inv.subtotalMinor + inv.taxMinor);
    await assert.rejects(ads.invoiceAct(org, inv.id, { action: 'issue' }), /once it is over/);
    await query(`UPDATE ad_invoice SET month = to_char(now() - interval '1 month', 'YYYY-MM') WHERE id = $1`, [inv.id]);
    await query(`UPDATE ad_play SET day = day - interval '1 month' WHERE campaign_id = $1`, [camp]);
    await query(`UPDATE ad_campaign SET starts_on = starts_on - interval '1 month' WHERE id = $1`, [camp]);
    const iss = await ads.invoiceAct(org, inv.id, { action: 'issue' });
    assert.equal(iss.status, 'issued');
    assert.match(iss.number!, /^ADV-\d{6}-001$/);
    const paid = await ads.invoiceAct(org, inv.id, { action: 'paid', reference: 'BCA-7781' });
    assert.equal(paid.status, 'paid');
    await assert.rejects(ads.invoiceAct(org, inv.id, { action: 'void' }), /paid invoice/);
    assert.ok((await ads.invoiceXlsx(org, inv.id)).data.length > 1000);
  });

  test('the worker ends campaigns past their end', async () => {
    await query(`UPDATE ad_campaign SET status = 'active', ends_on = current_date - 2, starts_on = current_date - 5 WHERE id = $1`, [camp]);
    await ads.sweep();
    assert.equal((await ads.campaign(org, camp)).status, 'ended');
    await assert.rejects(ads.saveCampaign(org, camp, { name: 'Again' }), /ended/);
  });
});
