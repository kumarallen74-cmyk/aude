import nodemailer from 'nodemailer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config, isRelaxedEnv } from '../config.js';
import { isEmail } from './alert-format.js';

/**
 * How alert messages leave the building.
 *
 *  E-mail    any SMTP server: the company's Google Workspace / Microsoft 365
 *            relay, a transactional provider (SES, Mailgun, SendGrid, Brevo …)
 *            or a local Postfix. nodemailer does SMTP, STARTTLS and AUTH.
 *  WhatsApp  the WhatsApp Business Cloud API (Meta), or any BSP that exposes the
 *            same /{phone-number-id}/messages endpoint. Alerts are
 *            business-initiated, so they MUST use a pre-approved message
 *            template; free text only works inside a 24-hour customer window.
 *  SMS       Twilio, Zenziva (Indonesia) or your own HTTP gateway, the same
 *            providers as the driver sign-in codes. Plain text, no template.
 */

export interface SendResult {
  ok: boolean;
  ref?: string;
  error?: string;
  /** Retrying will not help (bad address, template not approved, auth rejected). */
  permanent?: boolean;
}

export interface EmailConfig {
  host: string;
  port: number;
  /** tls = implicit TLS (465); starttls = upgrade required (587); none = plain (local relay only). */
  security: 'tls' | 'starttls' | 'none';
  username?: string;
  fromAddress: string;
  fromName?: string;
}

export interface WhatsAppConfig {
  apiBase: string;
  phoneNumberId: string;
  templateName: string;
  templateLang: string;
}

export interface SmsConfig {
  provider: 'twilio' | 'zenziva' | 'http';
  /** Twilio */
  accountSid?: string; from?: string; messagingServiceSid?: string; baseUrl?: string;
  /** Zenziva */
  userkey?: string; endpoint?: string;
  /** Your gateway: POST { to, message, purpose: 'alert' } with a bearer token. */
  url?: string;
}

export const WHATSAPP_DEFAULTS = {
  apiBase: 'https://graph.facebook.com/v21.0',
  templateName: 'plugsure_alert',
  templateLang: 'id',
};

const production = () => !isRelaxedEnv();
const localHost = (h: string) => /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i.test(h);

/** Returns an error message, or null when the settings are usable. */
export function checkChannelConfig(kind: 'email' | 'whatsapp' | 'sms', c: any): string | null {
  if (kind === 'sms') {
    if (!['twilio', 'zenziva', 'http'].includes(c?.provider)) return 'Choose the SMS provider: Twilio, Zenziva or your own gateway.';
    if (c.provider === 'twilio') {
      if (!/^AC[0-9a-f]{32}$/i.test(String(c.accountSid ?? ''))) return 'Enter the Twilio Account SID (AC…).';
      if (!c.from && !/^MG[0-9a-f]{32}$/i.test(String(c.messagingServiceSid ?? ''))) return 'Enter the Twilio sender number, or a Messaging Service SID (MG…).';
    }
    if (c.provider === 'zenziva' && !String(c.userkey ?? '').trim()) return 'Enter the Zenziva user key.';
    const u = c.provider === 'http' ? c.url : c.provider === 'twilio' ? c.baseUrl : c.endpoint;
    if (c.provider === 'http' || u) {
      let parsed: URL;
      try { parsed = new URL(String(u ?? '')); } catch { return c.provider === 'http' ? 'Enter your gateway URL.' : 'The provider URL is not valid.'; }
      if (production() && parsed.protocol !== 'https:') return 'The SMS provider URL must use https.';
    }
    return null;
  }
  if (kind === 'email') {
    if (!c?.host || !/^[a-z0-9.-]{1,253}$/i.test(String(c.host))) return 'Enter the SMTP server host name.';
    const port = Number(c.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Enter the SMTP port (usually 587 or 465).';
    if (!['tls', 'starttls', 'none'].includes(c.security)) return 'Choose the connection security.';
    if (c.security === 'none' && production() && !localHost(String(c.host))) {
      return 'An unencrypted SMTP connection is only allowed to a relay on this server (localhost). Use STARTTLS or TLS.';
    }
    if (!isEmail(c.fromAddress)) return 'Enter the sender address, e.g. alerts@yourcompany.co.id.';
    if (c.fromName && /[\r\n<>"]/.test(String(c.fromName))) return 'The sender name cannot contain quotes, < > or line breaks.';
    return null;
  }
  let u: URL;
  try { u = new URL(String(c?.apiBase ?? '')); } catch { return 'Enter the API base URL, e.g. https://graph.facebook.com/v21.0'; }
  if (production() && u.protocol !== 'https:') return 'The WhatsApp API URL must use https.';
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The WhatsApp API URL must be http(s).';
  if (!/^\d{5,30}$/.test(String(c?.phoneNumberId ?? ''))) return 'Enter the WhatsApp phone number ID (digits, from WhatsApp Manager → API setup).';
  if (!/^[a-z0-9_]{1,512}$/.test(String(c?.templateName ?? ''))) return 'Template names use lower-case letters, digits and underscores.';
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(String(c?.templateLang ?? ''))) return 'Enter the template language code, e.g. id or en_US.';
  return null;
}

export interface EmailAttachment { filename: string; content: string | Buffer; contentType: string }

export async function sendEmail(
  c: EmailConfig, password: string | null, to: string,
  content: { subject: string; text: string; html: string; attachments?: EmailAttachment[]; kind?: string },
): Promise<SendResult> {
  const transport = nodemailer.createTransport({
    host: c.host,
    port: Number(c.port),
    secure: c.security === 'tls',
    requireTLS: c.security === 'starttls',
    ignoreTLS: c.security === 'none',
    auth: c.username ? { user: c.username, pass: password ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    const info = await transport.sendMail({
      from: c.fromName ? { name: c.fromName, address: c.fromAddress } : c.fromAddress,
      to,
      subject: content.subject,
      text: content.text,
      html: content.html,
      ...(content.attachments?.length ? { attachments: content.attachments } : {}),
      headers: { 'X-PlugSure-Notification': content.kind ?? 'alert', 'Auto-Submitted': 'auto-generated' },
    });
    const rejected = (info.rejected ?? []).length > 0;
    return rejected ? { ok: false, error: `recipient rejected: ${to}`, permanent: true } : { ok: true, ref: info.messageId };
  } catch (e: any) {
    const code = Number(e?.responseCode);
    const msg = String(e?.response ?? e?.message ?? e).slice(0, 300);
    // 5xx is a permanent SMTP answer (bad mailbox, relay denied, auth failed).
    return { ok: false, error: msg, permanent: code >= 500 && code < 600 };
  } finally {
    transport.close();
  }
}

/** One SMS through the configured provider. */
export async function sendSms(c: SmsConfig, secret: string | null, toDigits: string, text: string): Promise<SendResult> {
  if (!secret) return { ok: false, error: 'No SMS provider credential saved.', permanent: true };
  const to = `+${toDigits.replace(/^\+/, '')}`;
  const call = async (url: string, init: RequestInit) => {
    const r = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const text = await r.text();
    let body: any = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body, text };
  };
  const fail = (who: string, r: { status: number; body: any; text: string }): SendResult => ({
    ok: false,
    error: `${who}: ${r.status} ${r.body?.message ?? r.body?.error?.message ?? r.body?.text ?? r.text.slice(0, 160)}`.trim().slice(0, 300),
    // 4xx other than rate limiting will fail again: bad number, bad credentials.
    permanent: r.status >= 400 && r.status < 500 && r.status !== 429,
  });
  try {
    if (c.provider === 'twilio') {
      const base = `${String(c.baseUrl || 'https://api.twilio.com').replace(/\/+$/, '')}/2010-04-01/Accounts/${encodeURIComponent(String(c.accountSid))}`;
      const form = new URLSearchParams({ To: to, Body: text, ...(c.messagingServiceSid ? { MessagingServiceSid: c.messagingServiceSid } : { From: String(c.from) }) });
      const r = await call(`${base}/Messages.json`, {
        method: 'POST',
        headers: { authorization: 'Basic ' + Buffer.from(`${c.accountSid}:${secret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      return r.status < 300 && r.body?.sid ? { ok: true, ref: String(r.body.sid) } : fail('Twilio', r);
    }
    if (c.provider === 'zenziva') {
      const form = new URLSearchParams({ userkey: String(c.userkey), passkey: secret, to: toDigits.replace(/^\+/, ''), message: text });
      const r = await call(c.endpoint || 'https://console.zenziva.net/reguler/api/sendsms/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
      return r.status < 300 && String(r.body?.status ?? '') === '1' ? { ok: true, ref: r.body?.messageId ? String(r.body.messageId) : undefined } : fail('Zenziva', r);
    }
    const r = await call(String(c.url), {
      method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to, message: text, channel: 'sms', purpose: 'alert' }),
    });
    return r.status < 300 ? { ok: true, ref: r.body?.id ? String(r.body.id) : undefined } : fail('Gateway', r);
  } catch (e) {
    return { ok: false, error: `SMS provider unreachable: ${(e as Error).message}`.slice(0, 300) };
  }
}

/** Meta signs each webhook with the app secret: X-Hub-Signature-256 = sha256=<HMAC-SHA256 of the raw body>. */
export function metaSignatureOk(rawBody: string, header: string | undefined, appSecret: string): boolean {
  const given = String(header ?? '');
  if (!given.startsWith('sha256=') || !appSecret) return false;
  const expect = 'sha256=' + createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  return given.length === expect.length && timingSafeEqual(Buffer.from(given), Buffer.from(expect));
}

export async function sendWhatsApp(c: WhatsAppConfig, token: string | null, to: string, params: string[]): Promise<SendResult> {
  if (!token) return { ok: false, error: 'No WhatsApp access token saved.', permanent: true };
  const url = `${String(c.apiBase).replace(/\/+$/, '')}/${encodeURIComponent(c.phoneNumberId)}/messages`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: {
          name: c.templateName,
          language: { code: c.templateLang },
          components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
        },
      }),
    });
    const body: any = await r.json().catch(() => ({}));
    if (r.ok && body?.messages?.[0]?.id) return { ok: true, ref: String(body.messages[0].id) };
    const err = body?.error;
    const msg = err ? `${err.message ?? 'error'}${err.code ? ` (code ${err.code})` : ''}${err.error_data?.details ? `: ${err.error_data.details}` : ''}` : `HTTP ${r.status}`;
    // 4xx other than rate limiting will fail again: bad number, template missing, token invalid.
    return { ok: false, error: msg.slice(0, 300), permanent: r.status >= 400 && r.status < 500 && r.status !== 429 };
  } catch (e) {
    return { ok: false, error: `WhatsApp API unreachable: ${(e as Error).message}`.slice(0, 300) };
  }
}
