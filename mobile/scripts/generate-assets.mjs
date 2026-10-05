/**
 * Generates every brand's app icon, Android adaptive icon layers, splash mark, notification icon and favicon as PNG
 * from one SVG design (the charge ring around a bolt), using the brand's accent and badge colours.
 *
 *   node scripts/generate-assets.mjs            # all brands in ./brands/*.json
 *   node scripts/generate-assets.mjs plugsure   # one brand
 *
 * Renders with Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH if set). Outputs to brands/<variant>/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2];
const brands = fs
  .readdirSync(path.join(root, 'brands'))
  .filter((f) => f.endsWith('.json') && !f.includes('schema'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(root, 'brands', f), 'utf8')))
  .filter((b) => !only || b.variant === only);

const mix = (a, b, t) => {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
};

/** The mark on a 100×100 grid: a 300° ring (r=31) and a bolt. `scale` shrinks it into a safe zone. */
function mark({ accent, deep, mono, scale = 1 }) {
  const ring = mono ? '#ffffff' : 'url(#acc)';
  const bolt = mono ? '#ffffff' : accent;
  return `<g transform="translate(50 50) scale(${scale}) translate(-50 -50)">
    <circle cx="50" cy="50" r="31" fill="none" stroke="${ring}" stroke-width="8" stroke-linecap="round" stroke-dasharray="162.3 194.8" transform="rotate(120 50 50)"/>
    <path d="M54.5 26 L36 54 H49 L45.5 74 L64 46 H51 Z" fill="${bolt}"/>
  </g>
  <defs><linearGradient id="acc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${accent}"/><stop offset="1" stop-color="${deep}"/></linearGradient></defs>`;
}

function svg(size, body, bg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">${bg ?? ''}${body}</svg>`;
}

const files = (b) => {
  const accent = b.accentColor;
  const deep = mix(accent, '#000000', 0.25);
  const badge = b.badgeColor;
  const top = mix(badge, accent, 0.18);
  const bg = `<defs><radialGradient id="bg" cx="0.3" cy="0.2" r="1"><stop offset="0" stop-color="${top}"/><stop offset="0.7" stop-color="${badge}"/></radialGradient></defs><rect width="100" height="100" fill="url(#bg)"/>`;
  return {
    'icon.png': [1024, svg(1024, mark({ accent, deep, scale: 1.08 }), bg)],
    'adaptive-foreground.png': [1024, svg(1024, mark({ accent, deep, scale: 0.62 }))],
    'adaptive-monochrome.png': [1024, svg(1024, mark({ accent, deep, mono: true, scale: 0.62 }))],
    'splash.png': [1024, svg(1024, mark({ accent, deep, scale: 1.25 }))],
    'notification-icon.png': [96, svg(96, mark({ accent, deep, mono: true, scale: 1.25 }))],
    'favicon.png': [48, svg(48, mark({ accent, deep, scale: 1.15 }), bg)],
    'store-icon-512.png': [512, svg(512, mark({ accent, deep, scale: 1.08 }), bg)],
  };
};

const browser = await chromium.launch();
const page = await browser.newPage();
for (const b of brands) {
  const dir = path.join(root, 'brands', b.variant);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, [size, markup]] of Object.entries(files(b))) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${markup}</body></html>`);
    await page.locator('svg').screenshot({ path: path.join(dir, name), omitBackground: true });
  }
  console.log(`${b.variant}: ${Object.keys(files(b)).join(', ')}`);
}
await browser.close();
