import { countryOfCurrency } from '../../domain/country.js';
import { isCurrency, type CurrencyCode } from '../../domain/money.js';
import { localParts, utcOffsetMinutes } from '../../domain/timezone.js';

/**
 * Settlement periods (docs/HUB-DESIGN.md §8.5). A run settles ONE currency over one period of that currency's
 * country calendar: IDR in the Indonesian zone (WIB), MYR in Malaysia's, SGD in Singapore's. A CDR belongs to
 * the period in which the hub RECEIVED it (`received_at`), so a finalised period never changes; late CDRs and
 * CDRs accepted after their own period's run are settled by the next run (the inclusion rule is "accepted,
 * unsettled, received before period_end").
 *
 *   monthly  '2026-09'      → [1 Sep 00:00 local, 1 Oct 00:00 local)
 *   weekly   '2026-09-07'   → [Mon 7 Sep 00:00 local, Mon 14 Sep 00:00 local)   (the period is its Monday)
 *
 * The three zones have no daylight saving time, but the arithmetic does not assume it.
 */

export type Cycle = 'monthly' | 'weekly';

export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const WEEK_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The settlement time zone of a currency: its country's first (default) zone. */
export function zoneOfCurrency(cur: string): string {
  const c = isCurrency(cur) ? countryOfCurrency(cur) : null;
  if (!c) throw new Error(`unsupported currency ${JSON.stringify(cur)}`);
  return c.timezones[0]!;
}

/** The UTC instant of 00:00 local time on y-m-d in `tz`. */
export function localMidnight(y: number, m: number, d: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - utcOffsetMinutes(new Date(guess), tz) * 60_000;
  const again = guess - utcOffsetMinutes(new Date(t), tz) * 60_000;
  if (again !== t) t = again;
  return new Date(t);
}

/** The local calendar date of an instant in `tz`. */
export function localYmd(at: Date, tz: string): { y: number; m: number; d: number } {
  const p = localParts(at, tz);
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The period an instant falls in, for a currency and cycle. */
export function periodOf(at: Date, cur: CurrencyCode, cycle: Cycle = 'monthly'): string {
  const { y, m, d } = localYmd(at, zoneOfCurrency(cur));
  if (cycle === 'monthly') return `${y}-${pad(m)}`;
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
  const mon = new Date(Date.UTC(y, m - 1, d - dow));
  return `${mon.getUTCFullYear()}-${pad(mon.getUTCMonth() + 1)}-${pad(mon.getUTCDate())}`;
}

/** [start, end) of a period as UTC instants; null for a malformed period (a weekly one must be a Monday). */
export function periodBounds(cur: CurrencyCode, period: string, cycle: Cycle = 'monthly'): { start: Date; end: Date; timeZone: string } | null {
  const tz = zoneOfCurrency(cur);
  if (cycle === 'monthly') {
    const m = MONTH_RE.exec(period);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]);
    return { start: localMidnight(y, mo, 1, tz), end: mo === 12 ? localMidnight(y + 1, 1, 1, tz) : localMidnight(y, mo + 1, 1, tz), timeZone: tz };
  }
  const w = WEEK_RE.exec(period);
  if (!w) return null;
  const y = Number(w[1]), mo = Number(w[2]), d = Number(w[3]);
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCMonth() !== mo - 1 || day.getUTCDay() !== 1) return null;
  const next = new Date(Date.UTC(y, mo - 1, d + 7));
  return { start: localMidnight(y, mo, d, tz), end: localMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), tz), timeZone: tz };
}

/** The period before the one `at` falls in (what the scheduler drafts). */
export function previousPeriod(at: Date, cur: CurrencyCode, cycle: Cycle = 'monthly'): string {
  const current = periodBounds(cur, periodOf(at, cur, cycle), cycle)!;
  return periodOf(new Date(current.start.getTime() - 1), cur, cycle);
}

/** When a run may be finalised: the dispute window of CDRs received on the period's last day has passed. */
export function finalisableAt(periodEnd: Date, disputeDays: number): Date {
  return new Date(periodEnd.getTime() + (disputeDays + 1) * 86_400_000);
}

/** A local date (YYYY-MM-DD) in a currency's zone, e.g. a due date. */
export function localDateString(at: Date, cur: CurrencyCode): string {
  const { y, m, d } = localYmd(at, zoneOfCurrency(cur));
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** YYYY-MM-DD plus whole days (calendar arithmetic, no zone). */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole days from a to b (YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  const p = (s: string) => { const [y, m, d] = s.split('-').map(Number) as [number, number, number]; return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 86_400_000);
}
