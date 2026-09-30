import { providerFetch } from '../services/payments/provider.js';
import { logEvent, resolve, type Resolved } from './store.js';

/**
 * Driver sign-in codes: WhatsApp (Meta Cloud API authentication template),
 * SMS (Twilio, Zenziva), or your own HTTP gateway — with an optional fallback
 * channel when the main one fails. Configured in Govern → Integrations.
 *
 * The code itself is never logged; the activity list shows the masked number,
 * the channel and the provider's message id.
 */

export const OTP_TEXT = (code: string, app = 'PlugSure') => `Kode masuk ${app}: ${code}. Berlaku 5 menit. Jangan berikan kode ini kepada siapa pun.`;

export interface SendResult { ok: boolean; messageId?: string; error?: string }

interface Sender {
  send(phoneE164: string, code: string, app?: string): Promise<SendResult>;
  /** Credentials check without sending, where the provider allows it. */
  check?(): Promise<{ ok: boolean; message: string }>;
  channel: 'whatsapp' | 'sms' | 'dev';
}

export const maskPhone = (p: string) => (p.length > 7 ? `${p.slice(0, 5)}****${p.slice(-3)}` : '****');
const errText = (r: { status: number; body: any; text: string }) =>
  `${r.status} ${r.body?.error?.message ?? r.body?.message ?? r.body?.text ?? r.text.slice(0, 160)}`.trim();

export function senderFor(r: Pick<Resolved, 'provider' | 'settings' | 'secrets'>): Sender {
  const s = r.settings, k = r.secrets;
  switch (r.provider) {
    case 'whatsapp_cloud': {
      const base = `${(s.baseUrl || 'https://graph.facebook.com').replace(/\/+$/, '')}/${s.apiVersion || 'v20.0'}`;
      const auth = { Authorization: `Bearer ${k.accessToken}` };
      return {
        channel: 'whatsapp',
        async send(phone, code) {
          const components: any[] = [{ type: 'body', parameters: [{ type: 'text', text: code }] }];
          // Authentication templates with a copy-code button take the code again as the button's parameter.
          if (s.copyCodeButton !== false) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] });
          const res = await providerFetch(`${base}/${encodeURIComponent(s.phoneNumberId)}/messages`, {
            method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: phone.replace(/^\+/, ''), type: 'template', template: { name: s.templateName, language: { code: s.language || 'id' }, components } }),
          });
          const id = res.body?.messages?.[0]?.id;
          return res.status < 300 && id ? { ok: true, messageId: id } : { ok: false, error: `WhatsApp: ${errText(res)}` };
        },
        async check() {
          const res = await providerFetch(`${base}/${encodeURIComponent(s.phoneNumberId)}?fields=display_phone_number,verified_name`, { headers: auth });
          return res.status === 200 ? { ok: true, message: `WhatsApp sender ${res.body?.display_phone_number ?? ''} ${res.body?.verified_name ? `(${res.body.verified_name})` : ''} is reachable with this token.`.replace(/\s+/g, ' ').trim() } : { ok: false, message: `WhatsApp: ${errText(res)}` };
        },
      };
    }
    case 'twilio': {
      const base = `${(s.baseUrl || 'https://api.twilio.com').replace(/\/+$/, '')}/2010-04-01/Accounts/${encodeURIComponent(s.accountSid)}`;
      const auth = { Authorization: 'Basic ' + Buffer.from(`${s.accountSid}:${k.authToken}`).toString('base64') };
      return {
        channel: 'sms',
        async send(phone, code, app) {
          const form = new URLSearchParams({ To: phone, Body: OTP_TEXT(code, app), ...(s.messagingServiceSid ? { MessagingServiceSid: s.messagingServiceSid } : { From: s.from }) });
          const res = await providerFetch(`${base}/Messages.json`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
          return res.status < 300 && res.body?.sid ? { ok: true, messageId: res.body.sid } : { ok: false, error: `Twilio: ${errText(res)}` };
        },
        async check() {
          const res = await providerFetch(`${base}.json`, { headers: auth });
          return res.status === 200 ? { ok: true, message: `Twilio account ${res.body?.friendly_name ?? s.accountSid} (${res.body?.status ?? 'active'}) accepts these credentials.` } : { ok: false, message: `Twilio: ${errText(res)}` };
        },
      };
    }
    case 'zenziva':
      return {
        channel: 'sms',
        async send(phone, code, app) {
          const form = new URLSearchParams({ userkey: s.userkey, passkey: k.passkey ?? '', to: phone.replace(/^\+/, ''), message: OTP_TEXT(code, app) });
          const res = await providerFetch(s.endpoint || 'https://console.zenziva.net/reguler/api/sendsms/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
          const ok = res.status < 300 && String(res.body?.status ?? '') === '1';
          return ok ? { ok: true, messageId: res.body?.messageId ? String(res.body.messageId) : undefined } : { ok: false, error: `Zenziva: ${errText(res)}` };
        },
      };
    case 'http':
      return {
        channel: s.channel === 'whatsapp' ? 'whatsapp' : 'sms',
        async send(phone, code, app) {
          const res = await providerFetch(s.url, {
            method: 'POST', headers: { Authorization: `Bearer ${k.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: phone, code, message: OTP_TEXT(code, app), channel: s.channel || 'sms', purpose: 'driver_sign_in', ...(app ? { app } : {}) }),
          });
          return res.status < 300 ? { ok: true, messageId: res.body?.id ? String(res.body.id) : undefined } : { ok: false, error: `Gateway: ${errText(res)}` };
        },
      };
    case 'dev':
      return { channel: 'dev', async send() { return { ok: true }; }, async check() { return { ok: true, message: 'Development mode: nothing is sent; the app shows the code.' }; } };
    default:
      return { channel: 'sms', async send() { return { ok: false, error: `unknown provider ${r.provider}` }; } };
  }
}

/**
 * Send a sign-in code: the main channel, then the fallback. `devCode` is set
 * only when the development provider is in force (never in production).
 */
/** `app`: the white-label app the driver is signing in to (its name goes in the SMS text; WhatsApp uses its approved template). */
export async function sendCode(phoneE164: string, code: string, app?: string): Promise<{ ok: true; channel: string; devCode?: string } | { ok: false; error: string; notConfigured?: boolean }> {
  const primary = await resolve('otp');
  if (!primary) return { ok: false, error: 'no sign-in code provider is configured', notConfigured: true };
  const tries: Resolved[] = [primary];
  const fb = await resolve('otp_fallback');
  if (fb && primary.provider !== 'dev') tries.push(fb);
  let lastError = '';
  for (const r of tries) {
    const s = senderFor(r);
    let res: SendResult;
    try { res = await s.send(phoneE164, code, app); } catch (e) { res = { ok: false, error: (e as Error).message }; }
    await logEvent(r, null, 'send_code', res.ok ? 'sent' : 'failed', { to: maskPhone(phoneE164), channel: s.channel, ...(res.messageId ? { messageId: res.messageId } : {}), ...(res.error ? { error: res.error.slice(0, 300) } : {}) });
    if (res.ok) return { ok: true, channel: s.channel, ...(r.provider === 'dev' ? { devCode: code } : {}) };
    lastError = res.error ?? 'not sent';
  }
  return { ok: false, error: lastError };
}

/** Test an OTP integration: its credentials, and a real message when a phone number is given. */
export async function testOtp(r: Resolved, phoneE164: string | null): Promise<{ ok: boolean; message: string }> {
  const s = senderFor(r);
  const parts: string[] = [];
  let ok = true;
  if (s.check) {
    const c = await s.check().catch((e) => ({ ok: false, message: (e as Error).message }));
    ok = c.ok; parts.push(c.message);
  }
  if (phoneE164 && ok) {
    const res = await s.send(phoneE164, String(Math.floor(100000 + Math.random() * 900000))).catch((e) => ({ ok: false, error: (e as Error).message }) as SendResult);
    ok = res.ok;
    parts.push(res.ok ? `A test code was sent to ${maskPhone(phoneE164)}${res.messageId ? ` (message ${res.messageId})` : ''}.` : `Sending failed: ${res.error}`);
    await logEvent(r, null, 'test_send', res.ok ? 'sent' : 'failed', { to: maskPhone(phoneE164), channel: s.channel, ...(res.error ? { error: res.error } : {}) });
  } else if (!s.check && !phoneE164) {
    return { ok: false, message: 'This provider cannot be checked without sending: enter a phone number to send a test code to.' };
  }
  return { ok, message: parts.join(' ') };
}
