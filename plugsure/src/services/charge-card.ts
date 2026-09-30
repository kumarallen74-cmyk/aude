import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { encodePng, type Rgba } from './png.js';

/**
 * The picture on a "charging finished" notification: the energy in large
 * figures, the time and the peak power, and the power curve of the charge, in
 * the brand's accent colour. Drawn pixel by pixel into a PNG (no image or font
 * library): a 5×7 pixel font for the few characters it needs.
 *
 * iOS shows it through the app's Notification Service Extension (mutable-content),
 * which downloads it without the driver's credentials; so its address is signed
 * and expires (7 days), like a pre-signed link.
 */

export const CARD_W = 720;
export const CARD_H = 360;

const GLYPHS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '·': ['00000', '00000', '00000', '01100', '01100', '00000', '00000'],
  k: ['10000', '10000', '10010', '10100', '11000', '10100', '10010'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  h: ['10000', '10000', '10110', '11001', '10001', '10001', '10001'],
  m: ['00000', '00000', '11010', '10101', '10101', '10001', '10001'],
  i: ['00100', '00000', '01100', '00100', '00100', '00100', '01110'],
  n: ['00000', '00000', '10110', '11001', '10001', '10001', '10001'],
  a: ['00000', '00000', '01110', '00001', '01111', '10001', '01111'],
  s: ['00000', '00000', '01110', '10000', '01110', '00001', '11110'],
  x: ['00000', '00000', '10001', '01010', '00100', '01010', '10001'],
};

type RGB = [number, number, number];
const rgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;

class Canvas implements Rgba {
  data: Uint8Array;
  constructor(public width: number, public height: number, bg: RGB) {
    this.data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) { this.data[i * 4] = bg[0]; this.data[i * 4 + 1] = bg[1]; this.data[i * 4 + 2] = bg[2]; this.data[i * 4 + 3] = 255; }
  }
  /** Blend a colour onto a pixel. */
  px(x: number, y: number, c: RGB, a = 1): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const o = (Math.floor(y) * this.width + Math.floor(x)) * 4;
    for (let k = 0; k < 3; k++) this.data[o + k] = Math.round(c[k]! * a + this.data[o + k]! * (1 - a));
  }
  rect(x: number, y: number, w: number, h: number, c: RGB, a = 1): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) this.px(xx, yy, c, a);
  }
  text(s: string, x: number, y: number, scale: number, c: RGB): number {
    let cx = x;
    for (const ch of s) {
      const g = GLYPHS[ch] ?? GLYPHS[' ']!;
      g.forEach((row, ry) => [...row].forEach((bit, rx) => { if (bit === '1') this.rect(cx + rx * scale, y + ry * scale, scale, scale, c); }));
      cx += 6 * scale;
    }
    return cx;
  }
}

export interface CardData {
  energyWh: number;
  minutes: number;
  /** Power in W over the session, evenly spaced. */
  powerW: number[];
  lang: 'id' | 'en';
  accent: string;
}

const kwhText = (wh: number, lang: 'id' | 'en') => {
  const s = (wh / 1000).toFixed(wh >= 100_000 ? 0 : 1);
  return lang === 'id' ? s.replace('.', ',') : s;
};

export function renderChargeCard(d: CardData): Buffer {
  const bg = rgb('#0f1e22');
  const c = new Canvas(CARD_W, CARD_H, bg);
  const accent = rgb(d.accent);
  // Figures: energy large, then time and peak.
  const x = c.text(kwhText(d.energyWh, d.lang), 40, 40, 8, rgb('#eaf4f2'));
  c.text('kWh', x + 12, 40 + 3 * 8, 5, accent);
  const peak = Math.max(0, ...d.powerW);
  const sub = `${Math.max(0, Math.round(d.minutes))} min${peak > 0 ? ` · ${d.lang === 'id' ? 'maks' : 'max'} ${Math.round(peak / 1000)} kW` : ''}`;
  c.text(sub, 42, 116, 4, rgb('#a0b6b3'));

  // The power curve: area in the accent (translucent), then its edge.
  const left = 40, right = CARD_W - 40, top = 176, bottom = CARD_H - 36;
  c.rect(left, bottom, right - left, 2, rgb('#2b4a51'));
  const pts = d.powerW.length >= 2 ? d.powerW : [peak, peak];
  const max = Math.max(1, peak);
  const yAt = (i: number) => {
    const f = (i / (right - left)) * (pts.length - 1);
    const a = Math.floor(f), b = Math.min(pts.length - 1, a + 1);
    const v = pts[a]! + (pts[b]! - pts[a]!) * (f - a);
    return bottom - (v / max) * (bottom - top);
  };
  let prev = yAt(0);
  for (let i = 0; i < right - left; i++) {
    const y = yAt(i);
    for (let yy = Math.round(y); yy < bottom; yy++) c.px(left + i, yy, accent, 0.28);
    // The edge: a 4 px line, joining steep steps.
    const y0 = Math.min(prev, y), y1 = Math.max(prev, y);
    for (let yy = Math.round(y0) - 2; yy <= Math.round(y1) + 1; yy++) c.px(left + i, yy, accent, 1);
    prev = y;
  }
  return encodePng(c, { opaque: true });
}

/** Power samples from an energy register series (Wh at times), resampled into `n` even steps. */
export function powerFromRegister(samples: Array<{ ts: Date; wh: number }>, n = 48): number[] {
  const s = samples.filter((p) => Number.isFinite(p.wh)).sort((a, b) => a.ts.getTime() - b.ts.getTime());
  if (s.length < 2) return [];
  const t0 = s[0]!.ts.getTime(), t1 = s[s.length - 1]!.ts.getTime();
  if (t1 <= t0) return [];
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + ((i + 0.5) / n) * (t1 - t0);
    while (j < s.length - 2 && s[j + 1]!.ts.getTime() < t) j++;
    const a = s[j]!, b = s[j + 1]!;
    const hours = (b.ts.getTime() - a.ts.getTime()) / 3_600_000;
    out.push(hours > 0 ? Math.max(0, (b.wh - a.wh) / hours) : 0);
  }
  return out;
}

// ─────────────────────────────────────────────── signed addresses

const key = () => createHash('sha256').update(`plugsure-notification-image|${config.security.secretsKey || 'development'}`).digest();
const sig = (sessionId: string, lang: string, exp: number) => createHmac('sha256', key()).update(`${sessionId}|${lang}|${exp}`).digest('base64url').slice(0, 32);

export const CARD_TTL_S = 7 * 24 * 3600;

export function chargeCardPath(sessionId: string, lang: 'id' | 'en', now = Date.now()): string {
  const exp = Math.floor(now / 1000) + CARD_TTL_S;
  return `/d/n/charge/${sessionId}.png?l=${lang}&e=${exp}&s=${sig(sessionId, lang, exp)}`;
}

/** Is this a valid, unexpired signed address for the session's picture? */
export function chargeCardAllowed(sessionId: string, lang: string, exp: string, s: string, now = Date.now()): boolean {
  const e = Number(exp);
  if (!Number.isInteger(e) || e < now / 1000 || (lang !== 'id' && lang !== 'en')) return false;
  const want = Buffer.from(sig(sessionId, lang, e));
  const got = Buffer.from(String(s));
  return want.length === got.length && timingSafeEqual(want, got);
}
