import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { unseal } from './secrets.js';
import { sendEmail } from './notify-transports.js';
import { accountsFor, monthClose, periodOf, FinanceError, type Account } from './finance.js';
import { render } from './finance-export.js';
import { journal, journalXlsx } from './finance-journal.js';

/**
 * The monthly close e-mail (v1.17.0): on the 1st of each month (platform time zone), each gateway account whose close
 * e-mail is on sends the previous month to its recipients: the finance export (Excel and PDF) and the accounting journal
 * (Excel), through the e-mail channel of the organisation that set it up (Govern → Alert routing → Channels). A month
 * is sent once (gateway_account_settings.close_email_sent_period); a failure is kept and retried on the next pass.
 */

const NIL = '00000000-0000-0000-0000-000000000000';
const ymOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: config.billing.timeZone, year: 'numeric', month: '2-digit' }).format(d).slice(0, 7);

/** The month before `now`'s month, YYYY-MM (platform time zone). */
export function previousMonth(now = new Date()): string {
  const [y, m] = ymOf(now).split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function monthPeriod(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new FinanceError(422, 'month is YYYY-MM.');
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return periodOf(`${month}-01`, `${month}-${String(last).padStart(2, '0')}`);
}

async function accountById(id: string, orgId: string | null): Promise<Account | null> {
  return (await accountsFor(orgId ?? NIL, orgId == null)).find((a) => a.id === id) ?? null;
}

/** Send one month's close for an account now, to its recipients (or `to`). Throws FinanceError on a refusal. */
export async function sendClose(a: Account, month: string, opts: { to?: string[] } = {}): Promise<{ to: string[]; reference: string | null }> {
  const s = await outsideRequestScope(() => one<any>(`SELECT * FROM gateway_account_settings WHERE integration_id = $1`, [a.id]));
  const to = opts.to?.length ? opts.to : (s?.close_email_recipients ?? []);
  if (!to.length) throw new FinanceError(422, 'Add the recipients of the monthly close e-mail first.');
  const channelOrg = s?.channel_org_id ?? a.orgId;
  const ch = channelOrg ? await outsideRequestScope(() => one<{ enabled: boolean; config: any; secret: string | null }>(
    `SELECT enabled, config, secret FROM notification_channel WHERE org_id = $1 AND kind = 'email'`, [channelOrg])) : null;
  if (!ch?.enabled || !ch.config?.host) throw new FinanceError(409, 'Set up the e-mail channel first (Govern → Alert routing → Channels).');
  let secret: string | null = null;
  try { secret = ch.secret ? unseal(ch.secret) : null; } catch { secret = null; }
  const p = monthPeriod(month);
  const close = await monthClose(a.id, p);
  const xl = render(a, close, 'xlsx'), pdf = render(a, close, 'pdf');
  const j = journal(a, p);
  const jx = journalXlsx(a, p, await j);
  const o = close.overview;
  const fmt = (n: number) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(n);
  const text = `${a.label}: the close for ${month}\n\n` +
    `Collected: ${fmt(o.collected)} (${o.payments} payments)\nGateway fees incl. VAT: ${fmt(o.fees + o.vat)}\nRefunds: ${fmt(o.refunds)}\nNet: ${fmt(o.net)}\nSettled to the bank: ${fmt(o.settled)}\n` +
    `Receivable now: ${fmt(o.receivable.amount)}\nOpen reconciliation differences: ${o.exceptionsOpen}\n\n` +
    `Attached: the finance export (Excel and PDF) and the accounting journal (Excel). Amounts in rupiah, from the gateway's ledger.\n` +
    `Sent by PlugSure Finance; change the recipients in Commercial → Finance → Settings.`;
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const html = `<p><b>${esc(a.label)}</b>: the close for ${esc(month)}</p><pre style="font:13px/1.5 ui-monospace,Menlo,monospace">${esc(text.split('\n\n')[1] ?? '')}</pre><p>${esc(text.split('\n\n').slice(2).join(' '))}</p>`;
  const base = `plugsure-finance-${month}`;
  const res = await sendEmail(ch.config, secret, to.join(', '), {
    subject: `Finance close ${month} — ${a.label}`, text, html, kind: 'finance-close',
    attachments: [
      { filename: `${base}.xlsx`, content: xl.body as Buffer, contentType: xl.type },
      { filename: `${base}.pdf`, content: pdf.body as Buffer, contentType: pdf.type },
      { filename: `${base}-journal.xlsx`, content: jx, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    ],
  });
  if (!res.ok) throw new FinanceError(502, `The e-mail was not sent: ${res.error ?? 'failed'}`);
  return { to, reference: res.ref ?? null };
}

/** The worker: each account with the close e-mail on, the previous month once. */
export async function closeMailAll(now = new Date()): Promise<number> {
  const month = previousMonth(now);
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT s.integration_id, s.org_id FROM gateway_account_settings s JOIN integration i ON i.id = s.integration_id
      WHERE s.close_email_enabled AND cardinality(s.close_email_recipients) > 0 AND i.archived_at IS NULL
        AND (s.close_email_sent_period IS NULL OR s.close_email_sent_period < $1)
        AND (s.close_email_last_at IS NULL OR s.close_email_last_at < now() - interval '1 hour')`, [month]));
  let sent = 0;
  for (const r of rows) {
    const a = await accountById(r.integration_id, r.org_id).catch(() => null);
    if (!a) continue;
    try {
      await sendClose(a, month);
      await outsideRequestScope(() => query(`UPDATE gateway_account_settings SET close_email_sent_period = $2, close_email_last_error = NULL, close_email_last_at = now() WHERE integration_id = $1`, [a.id, month]));
      sent++;
    } catch (e) {
      logger.warn({ account: a.id, month, err: (e as Error).message }, 'finance: the monthly close e-mail failed; retried later');
      await outsideRequestScope(() => query(`UPDATE gateway_account_settings SET close_email_last_error = $2, close_email_last_at = now() WHERE integration_id = $1`, [a.id, (e as Error).message.slice(0, 300)]));
    }
  }
  return sent;
}
