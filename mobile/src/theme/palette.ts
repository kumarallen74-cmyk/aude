/**
 * Brand palette, ported 1:1 from the backend (`src/services/brand.ts` → `palette()`), so a white-label
 * accent always reaches 4.5:1 on every surface of both themes. Spec §7 / [BACKEND] G18 will move this into a
 * shared `@plugsure/brand-tokens` package; until then keep both copies in sync (tests pin the outputs).
 */
export const DARK_SURFACES = ['#0a1417', '#0f1e22', '#15282d'];
export const LIGHT_SURFACES = ['#ffffff', '#eef3f2', '#f2f6f5'];

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');

export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return `#${toHex(x[0] + (y[0] - x[0]) * t)}${toHex(x[1] + (y[1] - x[1]) * t)}${toHex(x[2] + (y[2] - x[2]) * t)}`;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Nudge a colour toward white (dark theme) or black (light theme) until it reaches 4.5:1 on every surface. */
export function readableOn(accent: string, surfaces: string[], toward: string): string {
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = mix(accent, toward, t);
    if (surfaces.every((s) => contrast(c, s) >= 4.5)) return c;
  }
  return toward;
}

/** Text on a solid fill: near-black or white, whichever reads better. */
export const onFill = (fill: string) => (contrast(fill, '#ffffff') >= contrast(fill, '#08130f') ? '#ffffff' : '#08130f');

export const rgba = (hex: string, a: number) => `rgba(${hexToRgb(hex).join(',')},${a})`;

export interface ThemeAccent {
  accent: string;
  deep: string;
  on: string;
  glow: string;
  /** The raw brand colour, for large fills (buttons, rings) where 3:1 suffices. */
  fill: string;
}

export function palette(accentColor: string, badgeColor: string): { dark: ThemeAccent; light: ThemeAccent; badge: string } {
  const d = readableOn(accentColor, DARK_SURFACES, '#ffffff');
  const l = readableOn(accentColor, LIGHT_SURFACES, '#000000');
  // Fills: the brand colour itself where it reaches 3:1 (non-text UI, WCAG 1.4.11), else the readable variant.
  const fillDark = DARK_SURFACES.every((s) => contrast(accentColor, s) >= 3) ? accentColor : d;
  const fillLight = LIGHT_SURFACES.every((s) => contrast(accentColor, s) >= 3) ? accentColor : l;
  return {
    dark: { accent: d, deep: mix(d, '#000000', 0.16), on: onFill(fillDark), glow: rgba(d, 0.18), fill: fillDark },
    light: { accent: l, deep: mix(l, '#000000', 0.16), on: onFill(fillLight), glow: rgba(l, 0.12), fill: fillLight },
    badge: badgeColor,
  };
}
