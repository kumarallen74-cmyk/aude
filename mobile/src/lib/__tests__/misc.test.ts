import { updateGate } from '@/api/appConfig';
import type { AppConfig } from '@/api/types';
import { contrast, DARK_SURFACES, LIGHT_SURFACES, palette } from '@/theme/palette';
import { formatDistance, formatDuration, formatKwh, formatNumber, relativeTime } from '../format';
import { formatPhone, toE164 } from '../phone';

describe('phone numbers (OTP sign-in)', () => {
  it.each([
    ['ID', '0812-3456-7890', '+6281234567890'],
    ['ID', '812 3456 7890', '+6281234567890'],
    ['ID', '+62 812 3456 7890', '+6281234567890'],
    ['MY', '012-345 6789', '+60123456789'],
    ['SG', '8123 4567', '+6581234567'],
    ['SG', '+65 9123 4567', '+6591234567'],
  ] as const)('%s %s → %s', (cc, typed, e164) => expect(toE164(cc, typed)).toBe(e164));
  it.each([
    ['ID', '021 555 1234'],
    ['SG', '6123 4567'],
    ['SG', '+62 812 3456 7890'],
    ['MY', '12'],
  ] as const)('refuses %s %s', (cc, typed) => expect(toE164(cc, typed)).toBeNull());
  it('formats for display', () => expect(formatPhone('+6281234567890')).toBe('+62 8123 4567 890'));
});

describe('version gate (§15.3: the server decides force / softUpdate)', () => {
  const cfg = (p: Partial<AppConfig>) => ({ force: false, softUpdate: false, ...p }) as AppConfig;
  it('force wins; soft below latest; ok otherwise; unreachable server never blocks', () => {
    expect(updateGate(cfg({ force: true, softUpdate: true }))).toBe('force');
    expect(updateGate(cfg({ softUpdate: true }))).toBe('soft');
    expect(updateGate(cfg({}))).toBe('ok');
    expect(updateGate(null)).toBe('ok');
  });
});

describe('brand palette (port of backend brand.ts)', () => {
  it.each(['#2fd6a7', '#f5a524', '#ffe600', '#1e40af', '#000000', '#ffffff'])('accent %s reaches 4.5:1 on every surface of both themes', (accent) => {
    const p = palette(accent, '#0a1417');
    for (const s of DARK_SURFACES) expect(contrast(p.dark.accent, s)).toBeGreaterThanOrEqual(4.5);
    for (const s of LIGHT_SURFACES) expect(contrast(p.light.accent, s)).toBeGreaterThanOrEqual(4.5);
    // Text on the fill colour is readable.
    expect(contrast(p.dark.on, p.dark.fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.light.on, p.light.fill)).toBeGreaterThanOrEqual(4.5);
  });
  it('keeps the PlugSure teal as-is on dark surfaces', () => expect(palette('#2fd6a7', '#0a1417').dark.accent).toBe('#2fd6a7'));
});

describe('formatters', () => {
  it('numbers, energy, distance, duration', () => {
    expect(formatNumber(1234.5, 1, 'id')).toBe('1.234,5');
    expect(formatKwh(12.345, 'en')).toBe('12.35 kWh');
    expect(formatDistance(0.234, 'en')).toBe('230 m');
    expect(formatDistance(12.6, 'id')).toBe('13 km');
    expect(formatDuration(83, 'en')).toBe('1 h 23 min');
    expect(formatDuration(45, 'id')).toBe('45 mnt');
  });
  it('relative time', () => {
    const now = Date.UTC(2026, 9, 4, 12);
    expect(relativeTime(now - 30_000, now, 'en')).toBe('just now');
    expect(relativeTime(now - 42 * 60_000, now, 'en')).toBe('42 min ago');
    expect(relativeTime(now - 3 * 3600_000, now, 'id')).toBe('3 j lalu');
    expect(relativeTime(null, now, 'en')).toBe('—');
  });
});
