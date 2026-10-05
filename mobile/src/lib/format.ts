/** Small locale-aware formatters (numbers, energy, power, durations, dates). */
const decimalSep = (lang: string) => (lang === 'id' ? ',' : '.');

export function formatNumber(n: number, decimals: number, lang: string): string {
  const [i, f] = Math.abs(n).toFixed(decimals).split('.');
  const g = lang === 'id' ? '.' : ',';
  const int = i!.replace(/\B(?=(\d{3})+(?!\d))/g, g);
  return `${n < 0 ? '-' : ''}${f ? `${int}${decimalSep(lang)}${f}` : int}`;
}

export const formatKwh = (kwh: number | null | undefined, lang: string) => (kwh == null ? '—' : `${formatNumber(kwh, kwh >= 100 ? 1 : 2, lang)} kWh`);
export const formatKw = (kw: number | null | undefined, lang: string) => (kw == null ? '—' : `${formatNumber(kw, kw >= 10 || Number.isInteger(kw) ? 0 : 1, lang)} kW`);

export function formatDistance(km: number | null | undefined, lang: string): string {
  if (km == null) return '';
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  return `${formatNumber(km, km < 10 ? 1 : 0, lang)} km`;
}

/** 83 → "1 h 23 min" (en) / "1 j 23 mnt" (id). */
export function formatDuration(min: number, lang: string): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  const [H, M] = lang === 'id' || lang === 'ms' ? ['j', 'mnt'] : lang === 'zh' ? ['小时', '分钟'] : ['h', 'min'];
  return h ? `${h} ${H} ${r} ${M}` : `${r} ${M}`;
}

/** mm:ss or h:mm:ss timer text. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const LOCALE_TAG: Record<string, string> = { en: 'en-GB', id: 'id-ID', ms: 'ms-MY', zh: 'zh-Hans-SG' };

export function formatDateTime(iso: string | null | undefined, lang: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, timeZone?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(LOCALE_TAG[lang] ?? 'en-GB', { ...opts, ...(timeZone ? { timeZone } : {}) }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

export function formatTime(iso: string | Date | null | undefined, lang: string): string {
  if (!iso) return '—';
  return formatDateTime(typeof iso === 'string' ? iso : iso.toISOString(), lang, { hour: '2-digit', minute: '2-digit' });
}

/** "2 h ago", "just now" — for reliability ("last successful charge") and cache age. */
export function relativeTime(iso: string | number | null | undefined, now: number, lang: string): string {
  if (iso == null) return '—';
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
  const min = Math.floor((now - t) / 60_000);
  const L = lang === 'id' || lang === 'ms' ? { now: 'baru saja', m: 'mnt lalu', h: 'j lalu', d: 'hr lalu' } : lang === 'zh' ? { now: '刚刚', m: '分钟前', h: '小时前', d: '天前' } : { now: 'just now', m: 'min ago', h: 'h ago', d: 'd ago' };
  if (min < 1) return L.now;
  if (min < 60) return `${min} ${L.m}`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} ${L.h}`;
  return `${Math.round(h / 24)} ${L.d}`;
}
