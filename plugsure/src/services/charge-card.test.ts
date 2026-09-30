import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng } from './png.js';
import { renderChargeCard, powerFromRegister, chargeCardPath, chargeCardAllowed, CARD_W, CARD_H, CARD_TTL_S } from './charge-card.js';

test('charge card: a 720 × 360 opaque PNG with the figures in white and the curve in the brand’s accent', () => {
  const png = renderChargeCard({ energyWh: 12_500, minutes: 45, powerW: [0, 40_000, 58_000, 57_000, 30_000, 8_000], lang: 'id', accent: '#ff8a00' });
  assert.equal(png[25], 2, 'RGB, no alpha (as iOS attachments like it)');
  const img = decodePng(png);
  assert.deepEqual([img.width, img.height], [CARD_W, CARD_H]);
  let accent = 0, white = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const [r, g, b] = [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
    if (r === 0xff && g === 0x8a && b === 0x00) accent++;
    if (r === 0xea && g === 0xf4 && b === 0xf2) white++;
  }
  assert.ok(accent > 2000, `the curve and "kWh" in the accent (${accent} px)`);
  assert.ok(white > 1500, `the energy in large figures (${white} px)`);
  // Nothing drawn outside the picture, and a charge without samples still renders.
  assert.equal(decodePng(renderChargeCard({ energyWh: 0, minutes: 0, powerW: [], lang: 'en', accent: '#2fd6a7' })).width, CARD_W);
});

test('power from the energy register: even steps, kW from Wh per hour, never negative', () => {
  const t0 = Date.parse('2026-09-28T10:00:00Z');
  const at = (min: number, wh: number) => ({ ts: new Date(t0 + min * 60_000), wh });
  // 30 kW for 30 minutes, then 10 kW for 30 minutes.
  const p = powerFromRegister([at(0, 1000), at(30, 16_000), at(60, 21_000)], 4);
  assert.deepEqual(p.map((w) => Math.round(w)), [30_000, 30_000, 10_000, 10_000]);
  assert.deepEqual(powerFromRegister([at(0, 1000)]), [], 'one sample is no curve');
  assert.ok(powerFromRegister([at(0, 5000), at(10, 4000), at(20, 6000)], 4).every((w) => w >= 0), 'a meter reset does not draw below zero');
});

test('signed picture addresses: valid for 7 days, for that session and language only', () => {
  const now = Date.parse('2026-09-28T10:00:00Z');
  const path = chargeCardPath('7b1f0c5e-0000-4000-8000-000000000001', 'id', now);
  const u = new URL(path, 'https://x.example');
  const [l, e, s] = ['l', 'e', 's'].map((k) => u.searchParams.get(k) ?? '') as [string, string, string];
  assert.match(u.pathname, /^\/d\/n\/charge\/7b1f0c5e-0000-4000-8000-000000000001\.png$/);
  assert.equal(Number(e), Math.floor(now / 1000) + CARD_TTL_S);
  assert.ok(chargeCardAllowed('7b1f0c5e-0000-4000-8000-000000000001', l, e, s, now));
  assert.ok(!chargeCardAllowed('7b1f0c5e-0000-4000-8000-000000000002', l, e, s, now), 'another session');
  assert.ok(!chargeCardAllowed('7b1f0c5e-0000-4000-8000-000000000001', 'en', e, s, now), 'another language');
  assert.ok(!chargeCardAllowed('7b1f0c5e-0000-4000-8000-000000000001', l, String(Number(e) + 60), s, now), 'a longer expiry');
  assert.ok(!chargeCardAllowed('7b1f0c5e-0000-4000-8000-000000000001', l, e, s, now + (CARD_TTL_S + 1) * 1000), 'expired');
});
