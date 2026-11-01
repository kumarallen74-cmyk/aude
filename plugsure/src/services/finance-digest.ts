import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { moneyText, currencyOr } from '../domain/money.js';
import { unseal } from './secrets.js';
import { sendEmail, sendWhatsApp } from './notify-transports.js';
import { today } from './finance-today.js';
import { list as collectionsList } from './collections.js';

/**
 * Finance digests (v1.27.0). Each console user with payment:read may subscribe to a digest of the organisation's
 * finance, daily or weekly (a weekday), at an hour in the billing time zone, by e-mail and/or WhatsApp:
 *
 *   figures     yesterday's and the month's revenue, cash, what is owed and the DSO
 *   approvals   what waits for an approval, and how many the reader may decide
 *   overdue     receivables past due, by age (Collections)
 *   cash        gateway and bank balances
 *   anomalies   revenue drops raised in the last days (revenue anomalies)
 *
 * WhatsApp needs an approved template with one parameter (the digest's text, up to 1,000 characters), named in
 * Finance → Settings; e-mail goes through the e-mail channel. Each send is logged; a digest is sent once per period.
 */

export class DigestError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const SECTIONS = ['figures', 'approvals', 'overdue', 'cash', 'anomalies'] as const;
const zone = () => config.billing.timeZone;
const local = (now: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday!) + 1;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: wd };
};

export interface Subscription { frequency: 'off' | 'daily' | 'weekly'; channels: Array<'email' | 'whatsapp'>; sections: string[]; hour: number; weekday: number; phone: string | null; lastSentAt: string | null }

export async function subscription(orgId: string, userId: string): Promise<Subscription> {
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM finance_digest_subscription WHERE user_id = $1 AND org_id = $2`, [userId, orgId]));
  return {
    frequency: r?.frequency ?? 'off', channels: r?.channels ?? ['email'], sections: r?.sections ?? [...SECTIONS], hour: r?.hour ?? 7, weekday: r?.weekday ?? 1,
    phone: r?.phone ?? null, lastSentAt: r?.last_sent_at ? new Date(r.last_sent_at).toISOString() : null,
  };
}

export async function subscribe(orgId: string, userId: string, b: Record<string, unknown>) {
  const cur = await subscription(orgId, userId);
  const frequency = b.frequency === undefined ? cur.frequency : String(b.frequency);
  if (!['off', 'daily', 'weekly'].includes(frequency)) throw new DigestError(422, 'frequency is off, daily or weekly.');
  const channels = b.channels === undefined ? cur.channels : (Array.isArray(b.channels) ? b.channels : [b.channels]).map(String);
  if (!channels.length || channels.some((c) => c !== 'email' && c !== 'whatsapp')) throw new DigestError(422, 'Choose e-mail, WhatsApp or both.');
  const sections = b.sections === undefined ? cur.sections : (Array.isArray(b.sections) ? b.sections : [b.sections]).map(String);
  if (!sections.length || sections.some((s) => !(SECTIONS as readonly string[]).includes(s))) throw new DigestError(422, `Sections are ${SECTIONS.join(', ')}.`);
  const hour = b.hour === undefined ? cur.hour : Number(b.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new DigestError(422, 'The hour is 0 to 23.');
  const weekday = b.weekday === undefined ? cur.weekday : Number(b.weekday);
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new DigestError(422, 'The weekday is 1 (Monday) to 7 (Sunday).');
  let phone = b.phone === undefined ? cur.phone : (String(b.phone ?? '').replace(/\D/g, '') || null);
  if (channels.includes('whatsapp') && (!phone || phone.length < 8 || phone.length > 15)) throw new DigestError(422, 'Give the WhatsApp number (with the country code).');
  if (!channels.includes('whatsapp') && b.phone === undefined) phone = cur.phone;
  await outsideRequestScope(() => query(
    `INSERT INTO finance_digest_subscription (user_id, org_id, frequency, channels, sections, hour, weekday, phone) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id) DO UPDATE SET frequency = EXCLUDED.frequency, channels = EXCLUDED.channels, sections = EXCLUDED.sections, hour = EXCLUDED.hour,
       weekday = EXCLUDED.weekday, phone = EXCLUDED.phone, updated_at = now()`, [userId, orgId, frequency, channels, sections, hour, weekday, phone]));
  return subscription(orgId, userId);
}

export async function orgSettings(orgId: string) {
  const r = await outsideRequestScope(() => one<{ finance_digest: any }>(`SELECT finance_digest FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const t = r?.finance_digest?.whatsappTemplate;
  return { whatsappTemplate: t?.name ? { name: String(t.name), lang: String(t.lang ?? 'id') } : null };
}

export async function saveOrgSettings(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const t = b.whatsappTemplate as any;
  let v: { name: string; lang: string } | null = null;
  if (t && t.name) {
    if (!/^[a-z0-9_]{1,512}$/.test(String(t.name))) throw new DigestError(422, 'The WhatsApp template name is its lowercase name in Meta (letters, digits, _).');
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(String(t.lang ?? ''))) throw new DigestError(422, 'The template language is a code like id or en_US.');
    v = { name: String(t.name), lang: String(t.lang) };
  }
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, finance_digest, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET finance_digest = EXCLUDED.finance_digest, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify({ whatsappTemplate: v }), userId]));
  return { whatsappTemplate: v };
}

/** The digest's text for a reader (plain text; e-mail wraps it in HTML). */
export async function compose(orgId: string, userId: string, sections: string[], frequency: 'daily' | 'weekly' = 'daily', now = new Date()) {
  const t = await today(orgId, userId, now);
  const m = (n: number, c: string) => moneyText(n, currencyOr(c));
  const org = await outsideRequestScope(() => one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [orgId]));
  const lines: string[] = [`${org?.name ?? 'PlugSure'} — finance ${frequency === 'weekly' ? 'this week' : 'today'}, ${t.day}`];
  const has = (s: string) => sections.includes(s);
  if (has('figures')) {
    const y = await outsideRequestScope(() => many<any>(
      `SELECT d.currency, COALESCE(sum(d.subtotal_minor), 0)::bigint AS revenue, count(*)::int AS n FROM cdr d
        WHERE d.org_id = $1 AND NOT COALESCE(d.test_mode, false) AND (d.issued_at AT TIME ZONE $3)::date >= ($2::date - $4::int) AND (d.issued_at AT TIME ZONE $3)::date < $2::date GROUP BY 1`,
      [orgId, t.day, zone(), frequency === 'weekly' ? 7 : 1]));
    lines.push('', frequency === 'weekly' ? 'Last 7 days' : 'Yesterday');
    for (const r of y) lines.push(`  Revenue ${m(Number(r.revenue), r.currency)} · ${r.n} sessions`);
    if (!y.length) lines.push('  No charging.');
    for (const c of t.month) lines.push(`  Month to date ${m(c.revenue, c.currency)}${c.vsLastMonthPct != null ? ` (${c.vsLastMonthPct >= 0 ? '+' : ''}${c.vsLastMonthPct}% vs last month)` : ''}`);
  }
  if (has('cash')) {
    lines.push('', 'Cash');
    for (const c of t.month) lines.push(`  ${m((c.cash.gateways ?? 0) + (c.cash.bank ?? 0), c.currency)}${c.cash.bankAsOf ? ` (bank as of ${c.cash.bankAsOf})` : ''}`);
  }
  if (has('approvals')) {
    lines.push('', `Waiting for approval: ${t.approvals.length}${t.waiting ? ` (${t.waiting} for you)` : ''}`);
    for (const a of t.approvals.slice(0, 8)) lines.push(`  ${a.title}${a.amount != null ? ` — ${m(a.amount, a.currency ?? '')}` : ''}`);
  }
  if (has('overdue')) {
    const l = await collectionsList(orgId, false, now);
    const od = l.receivables.filter((r: any) => r.daysPastDue > 0 && !r.writeOff);
    const by: Record<string, number> = {};
    for (const r of od) by[r.currency] = (by[r.currency] ?? 0) + r.outstanding;
    lines.push('', `Overdue: ${od.length} receivable(s)`);
    for (const [c, n] of Object.entries(by)) lines.push(`  ${m(n, c)}`);
    for (const r of od.sort((a: any, b: any) => b.outstanding - a.outstanding).slice(0, 5)) lines.push(`  ${r.counterparty} · ${r.number} · ${r.daysPastDue} days`);
  }
  if (has('anomalies')) {
    const an = await outsideRequestScope(() => many<any>(
      `SELECT s.name, a.drop_pct, to_char(a.day, 'YYYY-MM-DD') AS d FROM revenue_anomaly a JOIN site s ON s.id = a.site_id
        WHERE a.org_id = $1 AND a.day >= ($2::date - 7) ORDER BY a.day DESC LIMIT 5`, [orgId, t.day]));
    if (an.length) { lines.push('', 'Revenue drops'); for (const a of an) lines.push(`  ${a.name} ${a.d}: −${Math.round(Number(a.drop_pct))}%`); }
  }
  lines.push('', `Open Finance today: ${config.console.publicBaseUrl ? `${config.console.publicBaseUrl}/#/finance-today` : 'Finance today in the console'}`);
  return lines.join('\n');
}

export async function channels(orgId: string) {
  const rows = await outsideRequestScope(() => many<{ kind: string; enabled: boolean; config: any; secret: string | null }>(
    `SELECT kind, enabled, config, secret FROM notification_channel WHERE org_id = $1 AND kind IN ('email', 'whatsapp') AND enabled`, [orgId]));
  const open = (k: string) => {
    const c = rows.find((r) => r.kind === k);
    if (!c) return null;
    let secret: string | null = null;
    try { secret = c.secret ? unseal(c.secret) : null; } catch { secret = null; }
    return { config: c.config, secret };
  };
  return { email: open('email'), whatsapp: open('whatsapp') };
}

/** Send one reader's digest now on their channels. Returns the result per channel. */
export async function send(orgId: string, userId: string, o: { automatic?: boolean; now?: Date } = {}) {
  const sub = await subscription(orgId, userId);
  const user = await outsideRequestScope(() => one<{ email: string | null; name: string }>(`SELECT email, name FROM app_user WHERE id = $1 AND org_id = $2 AND status = 'active'`, [userId, orgId]));
  if (!user) throw new DigestError(404, 'No such user.');
  const text = await compose(orgId, userId, sub.sections, sub.frequency === 'weekly' ? 'weekly' : 'daily', o.now);
  const ch = await channels(orgId);
  const results: Array<{ channel: 'email' | 'whatsapp'; ok: boolean; error: string | null }> = [];
  for (const c of sub.channels) {
    let ok = false, error: string | null = null;
    if (c === 'email') {
      if (!ch.email?.config?.host) error = 'No e-mail channel (Governance → Alert routing → Channels).';
      else if (!user.email) error = 'Your account has no e-mail address.';
      else {
        const esc = (x: string) => x.replace(/[&<>"]/g, (k) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[k]!);
        const res = await sendEmail(ch.email.config, ch.email.secret, user.email, { subject: text.split('\n')[0]!, text, html: `<pre style="font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap">${esc(text)}</pre>`, kind: 'finance-digest' });
        ok = res.ok; error = res.ok ? null : res.error ?? 'failed';
      }
    } else {
      const tpl = (await orgSettings(orgId)).whatsappTemplate;
      if (!ch.whatsapp?.config?.phoneNumberId) error = 'No WhatsApp channel.';
      else if (!tpl) error = 'No WhatsApp template for digests (Finance → Settings).';
      else if (!sub.phone) error = 'No WhatsApp number.';
      else {
        const res = await sendWhatsApp({ ...ch.whatsapp.config, templateName: tpl.name, templateLang: tpl.lang }, ch.whatsapp.secret, sub.phone, [text.replace(/\n+/g, ' · ').slice(0, 1000)]);
        ok = res.ok; error = res.ok ? null : res.error ?? 'failed';
      }
    }
    await outsideRequestScope(() => query(`INSERT INTO finance_digest_send (org_id, user_id, channel, ok, error, automatic) VALUES ($1, $2, $3, $4, $5, $6)`, [orgId, userId, c, ok, error?.slice(0, 300) ?? null, o.automatic === true]));
    results.push({ channel: c, ok, error });
  }
  if (results.some((r) => r.ok)) await outsideRequestScope(() => query(`UPDATE finance_digest_subscription SET last_sent_at = now() WHERE user_id = $1`, [userId]));
  return { results, text };
}

export async function sends(orgId: string, userId: string) {
  const rows = await outsideRequestScope(() => many<any>(`SELECT channel, ok, error, automatic, sent_at FROM finance_digest_send WHERE org_id = $1 AND user_id = $2 ORDER BY sent_at DESC LIMIT 20`, [orgId, userId]));
  return rows.map((r) => ({ channel: r.channel, ok: r.ok, error: r.error ?? null, automatic: r.automatic, at: new Date(r.sent_at).toISOString() }));
}

/** The worker (hourly): every subscription due at this hour (and weekday), not sent yet today. */
export async function sweep(now = new Date()): Promise<number> {
  const l = local(now);
  const due = await outsideRequestScope(() => many<{ user_id: string; org_id: string }>(
    `SELECT f.user_id, f.org_id FROM finance_digest_subscription f JOIN app_user u ON u.id = f.user_id AND u.status = 'active'
      WHERE f.frequency <> 'off' AND f.hour <= $1 AND (f.frequency = 'daily' OR f.weekday = $2)
        AND (f.last_sent_at IS NULL OR (f.last_sent_at AT TIME ZONE $4)::date < $3::date)
        AND NOT EXISTS (SELECT 1 FROM finance_digest_send s WHERE s.user_id = f.user_id AND s.automatic AND (s.sent_at AT TIME ZONE $4)::date = $3::date)`,
    [l.hour, l.weekday, l.day, zone()]));
  let n = 0;
  for (const d of due) {
    try { const r = await send(d.org_id, d.user_id, { automatic: true, now }); if (r.results.some((x) => x.ok)) n++; } catch (e) { logger.warn({ user: d.user_id, err: (e as Error).message }, 'finance digest not sent'); }
  }
  return n;
}
