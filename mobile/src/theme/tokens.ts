import { brand } from '@/config';
import { palette, rgba, type ThemeAccent } from './palette';

/**
 * Design tokens. Two typefaces give the app its own voice: Sora (geometric, for numbers and headings — kWh and
 * money read at a glance) and Plus Jakarta Sans (an Indonesian-designed humanist sans, for body text).
 * Spacing is a 4-pt grid; touch targets never go below 44 pt.
 */
export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
export const radius = { sm: 8, md: 14, lg: 20, xl: 28, pill: 999 } as const;
export const touch = { min: 44, comfortable: 52 } as const;

export const font = {
  display: 'Sora_700Bold',
  displaySemi: 'Sora_600SemiBold',
  displayX: 'Sora_800ExtraBold',
  body: 'PlusJakartaSans_400Regular',
  bodyMedium: 'PlusJakartaSans_500Medium',
  bodySemi: 'PlusJakartaSans_600SemiBold',
  bodyBold: 'PlusJakartaSans_700Bold',
} as const;

/** Type scale (size / line height). Fonts scale with the OS setting up to 2× (spec §7: 200 % without truncating prices). */
export const type = {
  hero: { fontFamily: font.displayX, fontSize: 44, lineHeight: 50, letterSpacing: -1 },
  display: { fontFamily: font.display, fontSize: 32, lineHeight: 38, letterSpacing: -0.6 },
  title1: { fontFamily: font.display, fontSize: 26, lineHeight: 32, letterSpacing: -0.4 },
  title2: { fontFamily: font.display, fontSize: 20, lineHeight: 26, letterSpacing: -0.2 },
  title3: { fontFamily: font.displaySemi, fontSize: 17, lineHeight: 23 },
  body: { fontFamily: font.body, fontSize: 16, lineHeight: 23 },
  bodyStrong: { fontFamily: font.bodySemi, fontSize: 16, lineHeight: 23 },
  callout: { fontFamily: font.bodyMedium, fontSize: 15, lineHeight: 21 },
  footnote: { fontFamily: font.bodyMedium, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: font.bodySemi, fontSize: 12, lineHeight: 16, letterSpacing: 0.2 },
  overline: { fontFamily: font.bodyBold, fontSize: 11, lineHeight: 14, letterSpacing: 1.2, textTransform: 'uppercase' as const },
  button: { fontFamily: font.bodyBold, fontSize: 16, lineHeight: 20 },
  number: { fontFamily: font.display, fontVariant: ['tabular-nums'] as 'tabular-nums'[] },
} as const;

export type Scheme = 'light' | 'dark';

/** Availability colours are fixed (not brand colours), colour-blind-safe and always paired with an icon + text. */
export interface StatusColors {
  available: string;
  busy: string;
  fault: string;
  offline: string;
  reserved: string;
}

export interface Colors extends ThemeAccent {
  scheme: Scheme;
  bg: string;
  surface: string;
  raised: string;
  sunken: string;
  line: string;
  lineStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  danger: string;
  dangerSoft: string;
  warning: string;
  warningSoft: string;
  info: string;
  infoSoft: string;
  success: string;
  successSoft: string;
  accentSoft: string;
  overlay: string;
  mapLand: string;
  mapWater: string;
  mapRoad: string;
  status: StatusColors;
  badge: string;
}

const p = palette(brand.accentColor, brand.badgeColor);

export const colors: Record<Scheme, Colors> = {
  dark: {
    scheme: 'dark',
    ...p.dark,
    badge: p.badge,
    bg: '#0a1417',
    surface: '#0f1e22',
    raised: '#15282d',
    sunken: '#071012',
    line: '#23363b',
    lineStrong: '#344c52',
    text: '#e9f3f1',
    textMuted: '#9db3af',
    textFaint: '#6f8783',
    danger: '#ff6b6b',
    dangerSoft: 'rgba(255,107,107,0.14)',
    warning: '#f5b94a',
    warningSoft: 'rgba(245,185,74,0.14)',
    info: '#7cb8ff',
    infoSoft: 'rgba(124,184,255,0.14)',
    success: '#4ade80',
    successSoft: 'rgba(74,222,128,0.14)',
    accentSoft: rgba(p.dark.accent, 0.14),
    overlay: 'rgba(3,8,10,0.66)',
    mapLand: '#122126',
    mapWater: '#0b2a33',
    mapRoad: '#1d3439',
    status: { available: '#4ade80', busy: '#7cb8ff', fault: '#ff8a7a', offline: '#9aa9a6', reserved: '#c4a5ff' },
  },
  light: {
    scheme: 'light',
    ...p.light,
    badge: p.badge,
    bg: '#f2f6f5',
    surface: '#ffffff',
    raised: '#eef3f2',
    sunken: '#e4ecea',
    line: '#d6e1de',
    lineStrong: '#b9cac6',
    text: '#12211f',
    textMuted: '#4f6461',
    textFaint: '#71857f',
    danger: '#c62828',
    dangerSoft: 'rgba(198,40,40,0.09)',
    warning: '#a15c00',
    warningSoft: 'rgba(214,138,0,0.12)',
    info: '#1d5fb8',
    infoSoft: 'rgba(29,95,184,0.09)',
    success: '#167a3e',
    successSoft: 'rgba(22,122,62,0.09)',
    accentSoft: rgba(p.light.accent, 0.1),
    overlay: 'rgba(10,20,23,0.45)',
    mapLand: '#e8efed',
    mapWater: '#cfe3ea',
    mapRoad: '#ffffff',
    status: { available: '#15803d', busy: '#1d5fb8', fault: '#c2410c', offline: '#5f6f6c', reserved: '#7c3aed' },
  },
};

/** Cross-platform shadow (RN `boxShadow`, New Architecture + web). */
export const elevation = (scheme: Scheme, level: 1 | 2 | 3) => {
  const o = scheme === 'dark' ? [0.35, 0.45, 0.55][level - 1] : [0.06, 0.1, 0.14][level - 1];
  const y = [2, 6, 14][level - 1];
  const blur = [6, 16, 32][level - 1];
  return { boxShadow: `0px ${y}px ${blur}px rgba(0,0,0,${o})` };
};
