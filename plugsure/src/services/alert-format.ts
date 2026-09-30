/**
 * Alert notifications — the pure part: which rule matches, quiet hours, phone
 * numbers, and what the e-mail and the WhatsApp message say. No I/O here, so it
 * is unit-tested directly (alert-format.test.ts).
 */

export type Severity = 'info' | 'warning' | 'critical';
export type Stage = 'raised' | 'escalation' | 'resolved' | 'storm' | 'test';

const RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };

/** Every alert kind the platform raises, with the label people see. */
export const ALERT_KINDS: Record<string, string> = {
  'charge_point.offline': 'Charger offline',
  'connector.faulted': 'Connector fault',
  'charge_point.device_event': 'Hardware monitor alarm',
  'session.stuck': 'Session stuck',
  'session.orphaned': 'Orphaned session',
  'session.needs_review': 'Session needs review',
  'prepaid.stop_failed': 'Prepaid stop failed',
  'prepaid.under_collected': 'Prepaid under-collected',
  'prepaid.refund_due': 'Unused prepaid balance to refund',
  'payment.refund_due': 'Refund due (charge never started)',
  'compliance.tera_lapsed': 'Tera lapsed',
  'compliance.tera_due_soon': 'Tera due soon',
  'compliance.slo_expired': 'SLO expired',
  'compliance.slo_due_soon': 'SLO expiring',
  'security.key_rotation_due': 'Charger key rotation due',
  'firmware.failed': 'Firmware update failed',
  'webhook.disabled': 'Webhook disabled',
};

export const titleOf = (kind: string) =>
  ALERT_KINDS[kind] ?? kind.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export interface RuleLike {
  enabled: boolean;
  min_severity: string;
  kinds: string[];
  site_ids: string[];
}
export interface AlertLike {
  severity: string;
  kind: string;
  site_id: string | null;
}

/**
 * Does the rule take this alert?
 *   kinds    empty = all; 'compliance.*' matches the whole family
 *   site_ids empty = all sites AND alerts with no site; otherwise only alerts at those sites
 */
export function ruleMatches(rule: RuleLike, a: AlertLike): boolean {
  if (!rule.enabled) return false;
  if ((RANK[a.severity] ?? 0) < (RANK[rule.min_severity] ?? 2)) return false;
  if (rule.kinds.length && !rule.kinds.some((k) => (k.endsWith('.*') ? a.kind.startsWith(k.slice(0, -1)) : k === a.kind))) return false;
  if (rule.site_ids.length && (!a.site_id || !rule.site_ids.includes(a.site_id))) return false;
  return true;
}

// ─────────────────────────────────────────── time

function localParts(d: Date, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return p as Record<string, string>;
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Minutes after local midnight. */
export function localMinutes(d: Date, tz: string): number {
  const p = localParts(d, tz);
  return Number(p.hour) * 60 + Number(p.minute);
}

/** Inside [start, end) local time; handles windows that cross midnight (22:00–06:00). */
export function inQuietHours(d: Date, start: string | null, end: string | null, tz: string): boolean {
  if (!start || !end) return false;
  const s = toMin(start), e = toMin(end), n = localMinutes(d, tz);
  if (s === e) return false;
  return s < e ? n >= s && n < e : n >= s || n < e;
}

/** When the current quiet window ends (the next occurrence of `end`). */
export function quietEndsAt(d: Date, end: string, tz: string): Date {
  const wait = (toMin(end) - localMinutes(d, tz) + 1440) % 1440 || 1440;
  const t = new Date(d.getTime() + wait * 60_000);
  t.setSeconds(0, 0);
  return t;
}

const TZ_ABBR: Record<string, string> = { 'Asia/Jakarta': 'WIB', 'Asia/Pontianak': 'WIB', 'Asia/Makassar': 'WITA', 'Asia/Jayapura': 'WIT' };

// Fixed names: ICU's short month differs between versions ("Sep" vs "Sept").
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "27 Sep 2026 14:05 WIB" */
export function formatTime(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year} ${p.hour}:${p.minute} ${TZ_ABBR[tz] ?? tz}`;
}

// ─────────────────────────────────────────── addresses

/**
 * WhatsApp wants the full international number, digits only. Indonesian
 * numbers are usually written 0812…, +62 812…, 62-812…, or 812….
 */
export function normaliseWhatsApp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8') && d.length >= 9 && d.length <= 12) d = '62' + d;
  if (d.includes('+')) return null;
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}

export const isEmail = (s: string | null | undefined): boolean =>
  !!s && s.length <= 254 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(s);

// ─────────────────────────────────────────── content

export interface MessageInput {
  stage: Stage;
  severity: string;
  kind: string;
  message: string;
  siteName: string | null;
  raisedAt: Date;
  resolvedAt?: Date | null;
  occurrences?: number;
  orgName?: string | null;
  consoleUrl: string;
  timeZone: string;
}

const LABEL: Record<Stage, (sev: string) => string> = {
  raised: (s) => s.toUpperCase(),
  escalation: (s) => `ESCALATED ${s.toUpperCase()}`,
  resolved: () => 'RESOLVED',
  storm: () => 'PAUSED',
  test: () => 'TEST',
};

function summary(m: MessageInput): string {
  if (m.stage === 'storm') return 'Many alerts in the last 15 minutes. Further messages to you are paused for now; see the console for the full list.';
  if (m.stage === 'test') return 'This is a test message from PlugSure. Alert notifications to this address are working.';
  const where = m.siteName ? ` at ${m.siteName}` : '';
  const head = `${titleOf(m.kind)}${where}`;
  const tail =
    m.stage === 'resolved' ? ` (open ${durationText(m.raisedAt, m.resolvedAt ?? new Date())})`
    : m.stage === 'escalation' ? ' Still open and not acknowledged.'
    : (m.occurrences ?? 1) > 1 ? ` Raised ${m.occurrences} times.` : '';
  return `${head}: ${m.message}${tail}`;
}

function durationText(a: Date, b: Date): string {
  const min = Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * WhatsApp template parameters must not contain new lines, tabs or more than
 * four consecutive spaces, and are limited in length — Meta rejects the whole
 * message otherwise.
 */
export function waParam(s: string, max = 900): string {
  const t = String(s).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t || '-';
}

/** Body parameters for the approved template: {{1}} status, {{2}} summary, {{3}} time. */
export function renderWhatsApp(m: MessageInput): string[] {
  const at = m.stage === 'resolved' && m.resolvedAt ? m.resolvedAt : m.stage === 'raised' || m.stage === 'escalation' ? m.raisedAt : new Date();
  const link = m.consoleUrl && m.stage !== 'test' ? ` ${m.consoleUrl}/#/dashboard` : '';
  return [waParam(LABEL[m.stage](m.severity), 60), waParam(summary(m) + link), waParam(formatTime(at, m.timeZone), 60)];
}

/**
 * SMS: one plain-text message, kept within two segments (306 GSM characters) so it arrives
 * as one; the same content as the WhatsApp template (status, alert and site, time).
 */
export function renderSms(m: MessageInput): string {
  const [status, body, time] = renderWhatsApp(m);
  const text = `PlugSure ${status}: ${body} (${time})`.replace(/\s+/g, ' ').trim();
  return text.length > 306 ? `${text.slice(0, 305)}…` : text;
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderEmail(m: MessageInput): { subject: string; text: string; html: string } {
  const label = LABEL[m.stage](m.severity);
  const subject = (
    m.stage === 'storm' ? '[PlugSure] Alert messages paused (many alerts)'
    : m.stage === 'test' ? '[PlugSure] Test message'
    : `[${label}] ${titleOf(m.kind)}${m.siteName ? ` — ${m.siteName}` : ''}`
  ).replace(/[\r\n]+/g, ' ').slice(0, 200);
  const rows: Array<[string, string]> = [];
  if (m.stage !== 'storm' && m.stage !== 'test') {
    rows.push(['Status', label], ['Alert', titleOf(m.kind)]);
    if (m.siteName) rows.push(['Site', m.siteName]);
    rows.push(['Raised', formatTime(m.raisedAt, m.timeZone)]);
    if (m.stage === 'resolved' && m.resolvedAt) rows.push(['Resolved', `${formatTime(m.resolvedAt, m.timeZone)} (open ${durationText(m.raisedAt, m.resolvedAt)})`]);
    if ((m.occurrences ?? 1) > 1) rows.push(['Occurrences', String(m.occurrences)]);
  }
  const body = m.stage === 'storm' || m.stage === 'test' ? summary(m) : m.message;
  const link = m.consoleUrl ? `${m.consoleUrl}/#/dashboard` : '';
  const action =
    m.stage === 'raised' || m.stage === 'escalation' ? 'Acknowledge or resolve it in the PlugSure console'
    : m.stage === 'storm' ? 'Open the console to see every alert' : '';
  const text = [
    body,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    action && link ? `${action}: ${link}` : action,
    '',
    `— PlugSure CSMS${m.orgName ? ` · ${m.orgName}` : ''}. You receive this because you are an alert contact.`,
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  const colour = m.stage === 'resolved' || m.stage === 'test' ? '#0a7d4f' : m.severity === 'critical' || m.stage === 'escalation' ? '#b42318' : m.severity === 'warning' ? '#9a6700' : '#475467';
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f2f4f7;font-family:Segoe UI,Arial,sans-serif;color:#101828">
<table role="presentation" width="100%" style="max-width:560px;margin:auto;background:#fff;border-radius:8px;border-top:4px solid ${colour}">
<tr><td style="padding:20px 24px">
<div style="font-size:12px;font-weight:700;letter-spacing:.06em;color:${colour}">${escHtml(label)}</div>
<h1 style="font-size:18px;margin:6px 0 12px">${escHtml(m.stage === 'storm' ? 'Alert messages paused' : m.stage === 'test' ? 'Test message' : titleOf(m.kind))}</h1>
<p style="font-size:15px;line-height:1.5;margin:0 0 16px">${escHtml(body)}</p>
${rows.length ? `<table role="presentation" style="font-size:14px;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:3px 16px 3px 0;color:#475467">${escHtml(k)}</td><td style="padding:3px 0">${escHtml(v)}</td></tr>`).join('')}</table>` : ''}
${action && link ? `<p style="margin:20px 0 0"><a href="${escHtml(link)}" style="display:inline-block;background:#101828;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px">${escHtml(action)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:12px 24px;border-top:1px solid #eaecf0;font-size:12px;color:#475467">PlugSure CSMS${m.orgName ? ` · ${escHtml(m.orgName)}` : ''}. You receive this because you are an alert contact.</td></tr>
</table></body></html>`;
  return { subject, text, html };
}
