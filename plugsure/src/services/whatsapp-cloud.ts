import { createHash } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { maskPhone } from '../domain/phone.js';
import { providerFetch } from './payments/provider.js';
import { byWebhookKey, resolve, type Resolved } from '../integrations/store.js';
import { metaSignatureOk, WHATSAPP_DEFAULTS } from './notify-transports.js';
import { applyAlertDeliveryStatus, metaStatusErrorText, sameSecret } from './alert-routing.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { opsAlertOrgs } from './worker-health.js';
import { inbound } from './whatsapp-support.js';

/**
 * WhatsApp Business (Meta Cloud API) — PlugSure's own WhatsApp Business Account (v1.10.0).
 *
 * The connection is the platform's sign-in code integration on the WhatsApp Cloud API (Governance → Integrations →
 * Driver sign-in codes, provider whatsapp_cloud; the fallback's when the main channel is something else): the
 * sending phone number id, a System User token, and — optional, for this dashboard — the WABA id and the app secret.
 * This module is everything that talks to it:
 *
 *   Graph reads     phoneNumber(), account(), templates() — cached 60 s per process, so the dashboard does not
 *                   spend Meta's rate limit on every refresh
 *   sending         sendTemplate(): one template message, recorded in the whatsapp_message ledger with the
 *                   MASKED number and Meta's message id (wamid); the test send uses it, sign-in codes record too
 *   webhook         /hooks/whatsapp-cloud/<key>: Meta's subscription handshake, then signed callbacks — message
 *                   statuses (ledger, and operator alerts sent from the same Meta app), template and number
 *                   quality and account events (whatsapp_event; a platform alert when something stops sending)
 *   dashboard data  stats(), messages(), events(), requiredTemplates()
 *   (v1.11.0)       customers' messages go to the support inbox and its AI assistant (whatsapp-support.ts);
 *                   sendText() sends a free-form reply inside Meta's 24-hour customer service window
 *
 * Every Graph call goes through providerFetch (SSRF guard, no redirects, a deadline) with the bearer token, and
 * Meta's error objects become readable messages (WhatsAppError); nothing raw reaches a route or the console.
 * Neither the full phone number nor a sign-in code is ever stored.
 */

export type Purpose = 'otp' | 'alert' | 'test' | 'other' | 'support';
export type Status = 'accepted' | 'sent' | 'delivered' | 'read' | 'failed';
export const NOT_CONFIGURED = 'WhatsApp is not configured: choose "WhatsApp (Meta Cloud API)" under Governance → Integrations → Driver sign-in codes.';
export const NO_WABA = 'Add the WhatsApp Business Account ID to the sign-in codes integration (Governance → Integrations → Driver sign-in codes) to see templates and account status.';

export class WhatsAppError extends Error {
  constructor(message: string, public code: string | null = null) { super(message); this.name = 'WhatsAppError'; }
}

export interface Connection {
  integrationId: string | null;
  /** Which sign-in code integration it is: the main channel or the fallback. */
  kind: 'otp' | 'otp_fallback';
  /** '' when not saved: the number's health and the ledger work, templates and the account do not. */
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string | null;
  apiVersion: string;
  /** https://graph.facebook.com, or the baseUrl setting (a proxy, or a test double). */
  base: string;
  webhookKey: string | null;
}

export function connectionOf(r: Pick<Resolved, 'kind' | 'settings' | 'secrets' | 'integrationId' | 'webhookKey'>): Connection {
  return {
    integrationId: r.integrationId, kind: r.kind === 'otp_fallback' ? 'otp_fallback' : 'otp', wabaId: String(r.settings.wabaId ?? ''), phoneNumberId: String(r.settings.phoneNumberId ?? ''),
    accessToken: r.secrets.accessToken ?? '', appSecret: r.secrets.appSecret ?? '', verifyToken: r.secrets.verifyToken ?? null,
    apiVersion: String(r.settings.apiVersion || 'v20.0'), base: String(r.settings.baseUrl || 'https://graph.facebook.com').replace(/\/+$/, ''),
    webhookKey: r.webhookKey,
  };
}

/** The platform's sign-in codes on WhatsApp: the main channel's, else the fallback's; null when neither is. */
export async function connection(): Promise<Connection | null> {
  for (const kind of ['otp', 'otp_fallback'] as const) {
    const r = await resolve(kind);
    if (r?.provider === 'whatsapp_cloud') return connectionOf(r);
  }
  return null;
}

// ─────────────────────────────────────────── Graph API

/**
 * What to do about Meta's commonest error codes. The message Meta gives is technical ("(#100) Invalid parameter");
 * the operator needs the next step.
 */
const HINTS: Record<string, string> = {
  '190': 'the access token is invalid or has expired: create a permanent System User token',
  '10': 'the token lacks a permission: give the System User whatsapp_business_messaging and whatsapp_business_management on this WABA',
  '200': 'the token lacks a permission: give the System User whatsapp_business_messaging and whatsapp_business_management on this WABA',
  '100': 'an ID or parameter is wrong, or the token cannot see it: check the WABA and phone number IDs and the System User\'s assets',
  '4': 'Meta\'s rate limit: try again in a few minutes',
  '80007': 'Meta\'s rate limit for this WABA: try again in a few minutes',
  '130429': 'the number\'s throughput limit was reached: try again shortly',
  '131056': 'too many messages to this recipient in a short time: try again later',
  '131026': 'not delivered: the number has no WhatsApp, or its app is too old',
  '131030': 'the recipient is not on the test number\'s list of allowed numbers',
  '131042': 'a payment problem on the WhatsApp Business account (Business Settings → Billing)',
  '131047': 'outside the 24-hour window: only approved templates can be sent',
  '131031': 'the account has been locked by Meta',
  '132000': 'the number of parameters does not match the template',
  '132001': 'the template does not exist in that language, or is not approved yet',
  '132015': 'the template is paused for low quality',
  '132016': 'the template is disabled',
  '133010': 'the phone number is not registered with the Cloud API',
  '368': 'the account is temporarily blocked for policy violations',
};

const str = (v: unknown, max = 300) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Meta's error object as one readable line (never the raw answer). */
export function metaErrorText(body: any, status: number): { code: string | null; text: string } {
  const e = body?.error;
  if (!e || typeof e !== 'object') return { code: null, text: `Meta answered HTTP ${status}` };
  const code = e.code != null ? str(e.code, 20) : null;
  const msg = str(e.error_user_msg) || str(e.message) || 'error';
  const details = str(e.error_data?.details);
  const hint = code ? HINTS[code] : undefined;
  return { code, text: `${msg}${code ? ` (code ${code}${e.error_subcode ? `/${str(e.error_subcode, 20)}` : ''})` : ''}${details && details !== msg ? `: ${details}` : ''}${hint ? ` — ${hint}` : ''}`.slice(0, 500) };
}

async function graph(conn: Connection, path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<any> {
  if (!conn.accessToken) throw new WhatsAppError('WhatsApp: no access token is saved on the connection.');
  let res: { status: number; body: any };
  try {
    res = await providerFetch(`${conn.base}/${encodeURIComponent(conn.apiVersion)}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${conn.accessToken}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      timeoutMs: 10_000,
    });
  } catch (e) {
    throw new WhatsAppError(`Cannot reach the WhatsApp Cloud API: ${(e as Error).message}`.slice(0, 300));
  }
  if (res.status >= 200 && res.status < 300 && res.body && typeof res.body === 'object' && !res.body.error) return res.body;
  const m = metaErrorText(res.body, res.status);
  throw new WhatsAppError(`WhatsApp: ${m.text}`, m.code);
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: unknown }>();
/** For tests, and after the connection changes. */
export function clearCache(): void { cache.clear(); }

/** A read call, cached per connection (ids, token and endpoint) for a minute. Failures are not cached. */
async function cached<T>(conn: Connection, path: string, fn: () => Promise<T>): Promise<T> {
  const who = createHash('sha256').update(`${conn.base}|${conn.apiVersion}|${conn.accessToken}`).digest('hex').slice(0, 16);
  const key = `${who}:${path}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 100) for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_MS) cache.delete(k);
  return value;
}

const need = async (conn?: Connection | null): Promise<Connection> => {
  const c = conn ?? (await connection());
  if (!c) throw new WhatsAppError(NOT_CONFIGURED);
  return c;
};

export interface PhoneNumberInfo {
  displayPhoneNumber: string | null; verifiedName: string | null; qualityRating: string | null; codeVerificationStatus: string | null;
  nameStatus: string | null; messagingLimitTier: string | null; throughput: string | null; platformType: string | null; status: string | null;
}

export async function phoneNumber(conn?: Connection | null): Promise<PhoneNumberInfo> {
  const c = await need(conn);
  const path = `/${encodeURIComponent(c.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,name_status,messaging_limit_tier,throughput,platform_type,status`;
  return cached(c, path, async () => {
    const b = await graph(c, path);
    const s = (v: unknown) => str(v, 120) || null;
    return {
      displayPhoneNumber: s(b.display_phone_number), verifiedName: s(b.verified_name), qualityRating: s(b.quality_rating),
      codeVerificationStatus: s(b.code_verification_status), nameStatus: s(b.name_status), messagingLimitTier: s(b.messaging_limit_tier),
      throughput: s(b.throughput?.level), platformType: s(b.platform_type), status: s(b.status),
    };
  });
}

export async function account(conn?: Connection | null): Promise<{ name: string | null; currency: string | null; timezoneId: string | null; reviewStatus: string | null }> {
  const c = await need(conn);
  if (!c.wabaId) throw new WhatsAppError(NO_WABA, 'no_waba');
  const path = `/${encodeURIComponent(c.wabaId)}?fields=name,currency,timezone_id,account_review_status`;
  return cached(c, path, async () => {
    const b = await graph(c, path);
    return { name: str(b.name, 200) || null, currency: str(b.currency, 10) || null, timezoneId: str(b.timezone_id, 10) || null, reviewStatus: str(b.account_review_status, 40) || null };
  });
}

export interface TemplateInfo { name: string; status: string; category: string | null; language: string; qualityScore: string | null; rejectedReason: string | null }

/** The WABA's message templates, following Meta's cursor paging up to 500. */
export async function templates(conn?: Connection | null): Promise<TemplateInfo[]> {
  const c = await need(conn);
  if (!c.wabaId) throw new WhatsAppError(NO_WABA, 'no_waba');
  const base = `/${encodeURIComponent(c.wabaId)}/message_templates?fields=name,status,category,language,quality_score,rejected_reason&limit=100`;
  return cached(c, base, async () => {
    const out: TemplateInfo[] = [];
    let after: string | null = null;
    // Only the `after` cursor is taken from Meta's answer: following its absolute `next` URL would send the
    // bearer token wherever that URL points.
    for (let page = 0; page < 5; page++) {
      const b = await graph(c, `${base}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      for (const t of Array.isArray(b.data) ? b.data : []) {
        out.push({
          name: str(t?.name, 512), status: str(t?.status, 40) || 'UNKNOWN', category: str(t?.category, 40) || null, language: str(t?.language, 20),
          qualityScore: str(t?.quality_score?.score, 20) || null,
          rejectedReason: t?.rejected_reason && t.rejected_reason !== 'NONE' ? str(t.rejected_reason, 120) : null,
        });
      }
      after = b.paging?.next && b.paging?.cursors?.after ? String(b.paging.cursors.after) : null;
      if (!after) break;
    }
    return out;
  });
}

// ─────────────────────────────────────────── sending and the ledger

export interface LedgerInput {
  purpose: Purpose; template: string | null; language: string | null;
  /** E.164 (with or without +): masked before it is stored. */
  to: string;
  wamid: string | null; status: Status; errorCode?: string | null; errorText?: string | null; orgId?: string | null;
}

/** Record one message. Never throws: the message was (or was not) sent either way. */
export async function recordMessage(m: LedgerInput): Promise<void> {
  const digits = m.to.replace(/[^\d]/g, '');
  await outsideRequestScope(() => query(
    `INSERT INTO whatsapp_message (org_id, purpose, template, language, to_masked, wamid, status, error_code, error_text, failed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $7 = 'failed' THEN now() END)
     ON CONFLICT (wamid) DO NOTHING`,
    [m.orgId ?? null, m.purpose, m.template, m.language, maskPhone(`+${digits}`), m.wamid, m.status, m.errorCode ?? null, m.errorText?.slice(0, 500) ?? null],
  )).catch((e) => logger.warn({ err: (e as Error).message }, 'WhatsApp message not recorded in the ledger'));
}

export type SendOutcome = { ok: true; wamid: string } | { ok: false; error: string; code?: string | null; notConfigured?: boolean };

/** Send one template message through the connection, and record it (purpose, masked number, wamid or the error). */
export async function sendTemplate(i: {
  to: string; template: string; language: string; components?: unknown[]; purpose: Purpose; orgId?: string | null; conn?: Connection | null;
}): Promise<SendOutcome> {
  let conn: Connection | null;
  try { conn = i.conn ?? (await connection()); } catch (e) { return { ok: false, error: `WhatsApp: ${(e as Error).message}` }; }
  if (!conn) return { ok: false, error: NOT_CONFIGURED, notConfigured: true };
  const to = i.to.replace(/[^\d]/g, '');
  const ledger = { purpose: i.purpose, template: i.template, language: i.language, to, orgId: i.orgId ?? null };
  try {
    const b = await graph(conn, `/${encodeURIComponent(conn.phoneNumberId)}/messages`, {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
        template: { name: i.template, language: { code: i.language }, ...(i.components?.length ? { components: i.components } : {}) },
      },
    });
    const wamid = b?.messages?.[0]?.id;
    if (!wamid) throw new WhatsAppError('WhatsApp: the Cloud API accepted the request but returned no message id.');
    await recordMessage({ ...ledger, wamid: String(wamid), status: 'accepted' });
    return { ok: true, wamid: String(wamid) };
  } catch (e) {
    const err = e instanceof WhatsAppError ? e : new WhatsAppError(`WhatsApp: ${(e as Error).message}`);
    await recordMessage({ ...ledger, wamid: null, status: 'failed', errorCode: err.code, errorText: err.message.replace(/^WhatsApp: /, '') });
    return { ok: false, error: err.message, code: err.code };
  }
}

/**
 * (v1.11.0) One free-form text message: a support reply. Meta accepts it only within 24 hours of the customer's last
 * message (error 131047 otherwise); the caller checks the window first. Recorded in the ledger as purpose 'support'.
 */
export async function sendText(i: { to: string; body: string; conn?: Connection | null }): Promise<SendOutcome> {
  let conn: Connection | null;
  try { conn = i.conn ?? (await connection()); } catch (e) { return { ok: false, error: `WhatsApp: ${(e as Error).message}` }; }
  if (!conn) return { ok: false, error: NOT_CONFIGURED, notConfigured: true };
  const to = i.to.replace(/[^\d]/g, '');
  const ledger = { purpose: 'support' as const, template: null, language: null, to };
  try {
    const b = await graph(conn, `/${encodeURIComponent(conn.phoneNumberId)}/messages`, {
      method: 'POST',
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body: i.body.slice(0, 4096) } },
    });
    const wamid = b?.messages?.[0]?.id;
    if (!wamid) throw new WhatsAppError('WhatsApp: the Cloud API accepted the request but returned no message id.');
    await recordMessage({ ...ledger, wamid: String(wamid), status: 'accepted' });
    return { ok: true, wamid: String(wamid) };
  } catch (e) {
    const err = e instanceof WhatsAppError ? e : new WhatsAppError(`WhatsApp: ${(e as Error).message}`);
    await recordMessage({ ...ledger, wamid: null, status: 'failed', errorCode: err.code, errorText: err.message.replace(/^WhatsApp: /, '') });
    return { ok: false, error: err.message, code: err.code };
  }
}

/** (v1.11.0) The customer's message shows two blue ticks: the support inbox has it. Best effort. */
export async function markRead(wamid: string, conn?: Connection | null): Promise<void> {
  const c = conn ?? (await connection().catch(() => null));
  if (!c) return;
  await graph(c, `/${encodeURIComponent(c.phoneNumberId)}/messages`, { method: 'POST', body: { messaging_product: 'whatsapp', status: 'read', message_id: wamid } })
    .catch((e) => logger.debug({ err: (e as Error).message }, 'WhatsApp read receipt not sent'));
}

// ─────────────────────────────────────────── webhook

const KEY_RE = /^[A-Za-z0-9_-]{20,64}$/;

/** Meta's subscription check: echo hub.challenge when the verify token is this connection's (constant time). */
export async function webhookVerify(key: string, mode: string, token: string, challenge: string): Promise<string | null> {
  // Meta's challenge is a short token (digits): anything else is not echoed back, so the endpoint never reflects text.
  if (mode !== 'subscribe' || !KEY_RE.test(key) || !/^[A-Za-z0-9_.-]{1,128}$/.test(challenge)) return null;
  const r = await byWebhookKey(key, 'whatsapp');
  const expected = r?.secrets.verifyToken;
  return expected && sameSecret(token, expected) ? challenge : null;
}

/**
 * Meta's signed callbacks. 404 unknown key, 403 no app secret saved, 401 bad signature; otherwise 200 at once, whatever the payload holds,
 * because Meta retries anything else for days. A single bad item is logged and skipped, not answered with an error.
 */
export async function webhook(key: string, rawBody: string, signature: string | undefined): Promise<{ status: number; body: unknown }> {
  if (!KEY_RE.test(key)) return { status: 404, body: { error: 'unknown webhook' } };
  const r = await byWebhookKey(key, 'whatsapp');
  if (!r) return { status: 404, body: { error: 'unknown webhook' } };
  // Optional on the integration (configurations from before 1.10.0): without it nothing can be verified.
  if (!r.secrets.appSecret) return { status: 403, body: { error: 'the WhatsApp app secret is not saved on the sign-in codes integration' } };
  if (!metaSignatureOk(rawBody, signature, r.secrets.appSecret)) return { status: 401, body: { error: 'invalid signature' } };
  let j: any;
  try { j = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'not JSON' } }; }
  let statuses = 0, events = 0, inbounds = 0;
  for (const e of Array.isArray(j?.entry) ? j.entry : []) for (const c of Array.isArray(e?.changes) ? e.changes : []) {
    const field = str(c?.field, 80);
    const value = c?.value && typeof c.value === 'object' ? c.value : {};
    for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
      try { if (await applyStatus(s, true)) statuses++; } catch (err) { logger.warn({ err: (err as Error).message }, 'WhatsApp status not applied'); }
    }
    // (v1.11.0) Customers' messages: the support inbox, and its AI assistant when one is configured.
    if (field === 'messages' && Array.isArray(value.messages) && value.messages.length) {
      try { inbounds += await inbound(value, r); } catch (err) { logger.warn({ err: (err as Error).message }, 'WhatsApp message not taken into the support inbox'); }
    }
    if (field && field !== 'messages') {
      try { await recordEvent(field, value); events++; } catch (err) { logger.warn({ err: (err as Error).message, field }, 'WhatsApp event not recorded'); }
    }
  }
  return { status: 200, body: { ok: true, statuses, events, messages: inbounds } };
}

/** Order of the statuses: a late "delivered" never replaces "read", and a message that arrived is not "failed". */
const RANK = ['accepted', 'sent', 'failed', 'delivered', 'read'];

/**
 * One status from Meta: the ledger row (if PlugSure sent it through the connection) and the operator alert (if an
 * alert channel on the same Meta app sent it). Neither matched: the status may have overtaken the sender recording
 * its row (Meta's "sent" can come within the same second), so it is tried once more a few seconds later.
 */
export async function applyStatus(s: any, retry = false): Promise<boolean> {
  const wamid = str(s?.id, 200), st = str(s?.status, 20);
  if (!wamid || !['sent', 'delivered', 'read', 'failed'].includes(st)) return false;
  const at = Number(s?.timestamp) > 0 ? new Date(Number(s.timestamp) * 1000) : new Date();
  const errors = Array.isArray(s?.errors) ? s.errors : [];
  const pricing = s?.pricing && typeof s.pricing === 'object' ? s.pricing : {};
  const row = await outsideRequestScope(() => one<{ id: string }>(
    `UPDATE whatsapp_message SET
        status = CASE WHEN array_position($8::text[], $2) > array_position($8::text[], status) THEN $2 ELSE status END,
        sent_at = CASE WHEN $2 = 'sent' THEN LEAST(sent_at, $3) ELSE sent_at END,
        delivered_at = CASE WHEN $2 = 'delivered' THEN LEAST(delivered_at, $3) WHEN $2 = 'read' THEN COALESCE(delivered_at, $3) ELSE delivered_at END,
        read_at = CASE WHEN $2 = 'read' THEN LEAST(read_at, $3) ELSE read_at END,
        failed_at = CASE WHEN $2 = 'failed' THEN LEAST(failed_at, $3) ELSE failed_at END,
        error_code = CASE WHEN $2 = 'failed' THEN $4 ELSE error_code END,
        error_text = CASE WHEN $2 = 'failed' THEN $5 ELSE error_text END,
        pricing_category = COALESCE($6, pricing_category),
        billable = COALESCE($7, billable),
        webhook_at = now()
      WHERE wamid = $1 RETURNING id`,
    [wamid, st, at, st === 'failed' && errors[0]?.code != null ? str(errors[0].code, 20) : null, st === 'failed' ? metaStatusErrorText(errors) : null,
      str(pricing.category, 40) || null, typeof pricing.billable === 'boolean' ? pricing.billable : null, RANK],
  ));
  const alerts = await outsideRequestScope(() => applyAlertDeliveryStatus({ orgId: null, ref: wamid, status: st, at, errors }));
  if (!row && !alerts && retry) {
    setTimeout(() => { void applyStatus(s, false).catch(() => {}); }, 5_000).unref();
  }
  return Boolean(row) || alerts > 0;
}

/** A payload, trimmed to a few kilobytes: these are notices, not archives. */
function trimmed(v: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(v);
  if (text.length <= 4_000) return v;
  return { truncated: true, event: v.event ?? null, keys: Object.keys(v).slice(0, 30) };
}

const TEMPLATE_BAD = ['PAUSED', 'DISABLED', 'REJECTED', 'FLAGGED'];
const TEMPLATE_GOOD = ['APPROVED', 'REINSTATED', 'UNFLAGGED'];
const ACCOUNT_BAD = ['DISABLED_UPDATE', 'ACCOUNT_VIOLATION', 'ACCOUNT_RESTRICTION', 'ACCOUNT_DELETED'];

/**
 * An account-level event: stored, and for something that stops PlugSure sending, a platform alert to the platform
 * operator's organisations (as worker failures: OPS_ALERT_ORG_ID, else the platform administrators' own), so it
 * reaches whoever is on call through the ordinary alert routing. The good news resolves it.
 */
async function recordEvent(field: string, v: Record<string, any>): Promise<void> {
  await outsideRequestScope(() => query(`INSERT INTO whatsapp_event (field, payload) VALUES ($1, $2)`, [field, JSON.stringify(trimmed(v))]));
  const event = str(v.event, 60).toUpperCase();
  if (field === 'message_template_status_update' || field === 'message_template_quality_update') {
    const name = str(v.message_template_name, 200), lang = str(v.message_template_language, 20);
    if (!name) return;
    const target = `${name}:${lang}`;
    const quality = str(v.new_quality_score, 20).toUpperCase();
    const bad = field === 'message_template_status_update' ? TEMPLATE_BAD.includes(event) : quality === 'RED';
    const good = field === 'message_template_status_update' ? TEMPLATE_GOOD.includes(event) : quality === 'GREEN';
    if (bad) {
      const otp = (await requiredTemplates()).some((t) => t.purpose === 'otp' && t.name === name);
      const reason = str(v.reason, 120);
      const what = field === 'message_template_status_update' ? event.toLowerCase() : 'rated low quality (RED)';
      await raise('platform.whatsapp_template', otp ? 'critical' : 'warning', 'whatsapp_template', target,
        `WhatsApp template "${name}"${lang ? ` (${lang})` : ''} is ${what}${reason && reason !== 'NONE' ? `: ${reason}` : ''}.${otp ? ' Driver sign-in codes sent with it are not delivered until it is approved again.' : ''}`);
    } else if (good) {
      await settle('platform.whatsapp_template', 'whatsapp_template', target);
    }
  } else if (field === 'phone_number_quality_update') {
    const number = str(v.display_phone_number, 40) || 'the sending number';
    const red = ['FLAGGED', 'DOWNGRADE'].includes(event) || str(v.quality_rating ?? v.new_quality_rating, 20).toUpperCase() === 'RED';
    if (red) {
      await raise('platform.whatsapp_quality', 'warning', 'whatsapp_number', number,
        `WhatsApp number ${number}: quality ${event === 'DOWNGRADE' ? 'stayed low and its messaging limit was lowered' : 'is low (RED)'}${v.current_limit ? ` — messaging limit ${str(v.current_limit, 40)}` : ''}. Too many recipients block or report its messages; check the templates.`);
    } else if (['UNFLAGGED', 'UPGRADE'].includes(event)) {
      await settle('platform.whatsapp_quality', 'whatsapp_number', number);
    }
  } else if (field === 'account_update' && ACCOUNT_BAD.includes(event)) {
    await raise('platform.whatsapp_account', 'critical', 'whatsapp_account', str(v.waba_info?.waba_id ?? '', 40) || 'waba',
      `WhatsApp Business account: ${event.toLowerCase().replace(/_/g, ' ')}${v.violation_info?.violation_type ? ` (${str(v.violation_info.violation_type, 80)})` : ''}. Messages may stop being delivered; check WhatsApp Manager.`);
  }
}

export async function raise(kind: string, severity: 'warning' | 'critical', targetType: string, targetId: string, message: string) {
  const orgs = await outsideRequestScope(() => opsAlertOrgs());
  if (!orgs.length) { logger.error({ kind, targetId, message }, 'WhatsApp problem and no organisation to alert (set OPS_ALERT_ORG_ID or create a platform administrator)'); return; }
  for (const orgId of orgs) await outsideRequestScope(() => persistAlert({ orgId, kind, severity, message, targetType, targetId }));
}
export async function settle(kind: string, targetType: string, targetId: string) {
  for (const orgId of await outsideRequestScope(() => opsAlertOrgs())) await outsideRequestScope(() => resolveAlertsFor(orgId, kind, targetType, targetId));
}

// ─────────────────────────────────────────── dashboard data

export interface RequiredTemplate { name: string; language: string; purpose: 'otp' | 'alert'; inUse: boolean }

/**
 * The templates PlugSure sends from this number: the sign-in code template (main channel and fallback, when on
 * this number) and the alert template of every
 * operator alert channel on this number (plugsure_alert by default, listed even when no channel uses it yet).
 */
export async function requiredTemplates(conn?: Connection | null): Promise<RequiredTemplate[]> {
  const c = conn === undefined ? await connection().catch(() => null) : conn;
  const out: RequiredTemplate[] = [];
  const add = (t: RequiredTemplate) => { if (!out.some((x) => x.name === t.name && x.language === t.language)) out.push(t); };
  for (const kind of ['otp', 'otp_fallback'] as const) {
    const r = await resolve(kind).catch(() => null);
    if (!r) continue;
    if (r.provider === 'whatsapp_cloud' && c && String(r.settings.phoneNumberId) === c.phoneNumberId) {
      add({ name: String(r.settings.templateName || 'plugsure_otp'), language: String(r.settings.language || 'id'), purpose: 'otp', inUse: true });
    }
  }
  if (c) {
    const rows = await outsideRequestScope(() => many<{ name: string; language: string }>(
      `SELECT DISTINCT COALESCE(NULLIF(config->>'templateName', ''), $2) AS name, COALESCE(NULLIF(config->>'templateLang', ''), $3) AS language
         FROM notification_channel WHERE kind = 'whatsapp' AND config->>'phoneNumberId' = $1 ORDER BY 1, 2`,
      [c.phoneNumberId, WHATSAPP_DEFAULTS.templateName, WHATSAPP_DEFAULTS.templateLang]));
    for (const r of rows) add({ ...r, purpose: 'alert', inUse: true });
  }
  if (!out.some((t) => t.purpose === 'alert')) add({ name: WHATSAPP_DEFAULTS.templateName, language: WHATSAPP_DEFAULTS.templateLang, purpose: 'alert', inUse: false });
  return out;
}

/**
 * Operator alerts sent from this number, in SQL: alert_notification rows of the alert channels whose phone number id
 * is the connection's. $1 = that phone number id. `n` is the notification, `c` its channel.
 */
const ALERTS_ON_NUMBER = `alert_notification n JOIN notification_channel c ON c.org_id = n.org_id AND c.kind = 'whatsapp'
   WHERE n.channel = 'whatsapp' AND n.state IN ('sent', 'failed') AND c.config->>'phoneNumberId' = $1`;

export interface Stats {
  days: number; total: number; byStatus: Record<Status, number>; byPurpose: Record<Purpose, number>;
  /** (delivered + read) / total; null with nothing sent. */
  deliveryRate: number | null;
  /** read / (delivered + read); null with nothing delivered. */
  readRate: number | null;
  daily: Array<{ day: string; sent: number; delivered: number; read: number; failed: number }>;
}

/**
 * The last `days` calendar days (today included) in the platform's zone (ALERT_TIMEZONE, WIB by default): the
 * ledger, plus the operator alerts sent from the same number. Each message counts once, at its latest status;
 * "sent" includes accepted (WhatsApp took it, no delivery report yet).
 */
export async function stats(days: number, phoneNumberId: string | null, tz = config.alerts.timeZone): Promise<Stats> {
  const [dayRows, rows] = await outsideRequestScope(() => Promise.all([
    many<{ day: string }>(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day FROM generate_series((now() AT TIME ZONE $1)::date - ($2::int - 1), (now() AT TIME ZONE $1)::date, interval '1 day') d`,
      [tz, days]),
    many<{ day: string; purpose: Purpose; status: Status; n: number }>(
      `WITH since AS (SELECT (((now() AT TIME ZONE $2)::date - ($3::int - 1))::timestamp AT TIME ZONE $2) AS t),
       m AS (
         SELECT purpose, status, created_at AS at FROM whatsapp_message WHERE created_at >= (SELECT t FROM since)
         UNION ALL
         SELECT 'alert', COALESCE(n.delivery, n.state), COALESCE(n.sent_at, n.created_at)
           FROM ${ALERTS_ON_NUMBER} AND COALESCE(n.sent_at, n.created_at) >= (SELECT t FROM since)
       )
       SELECT to_char((at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day, purpose, status, count(*)::int AS n FROM m GROUP BY 1, 2, 3`,
      [phoneNumberId ?? '', tz, days]),
  ]));
  const byStatus: Record<Status, number> = { accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
  const byPurpose: Record<Purpose, number> = { otp: 0, alert: 0, test: 0, other: 0, support: 0 };
  const daily = dayRows.map((d) => ({ day: d.day, sent: 0, delivered: 0, read: 0, failed: 0 }));
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n;
    byPurpose[r.purpose] = (byPurpose[r.purpose] ?? 0) + r.n;
    const d = daily.find((x) => x.day === r.day);
    if (d) d[r.status === 'accepted' ? 'sent' : r.status] += r.n;
  }
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const arrived = byStatus.delivered + byStatus.read;
  const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : null);
  return { days, total, byStatus, byPurpose, deliveryRate: rate(arrived, total), readRate: rate(byStatus.read, arrived), daily };
}

export interface MessageRow {
  id: string; at: string; purpose: Purpose; to: string; template: string | null; language: string | null; status: Status;
  errorCode: string | null; error: string | null; sentAt: string | null; deliveredAt: string | null; readAt: string | null;
  pricingCategory: string | null; billable: boolean | null;
}

/** The ledger and the operator alerts from this number, newest first, numbers masked. */
export async function messages(f: { phoneNumberId: string | null; purpose?: Purpose | null; status?: Status | null; before?: Date | null; limit: number }): Promise<MessageRow[]> {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT * FROM (
       SELECT 'm' || m.id AS id, m.created_at AS at, m.purpose, m.to_masked, NULL::text AS dest, m.template, m.language, m.status, m.error_code, m.error_text,
              m.sent_at, m.delivered_at, m.read_at, m.pricing_category, m.billable
         FROM whatsapp_message m
        WHERE ($2::text IS NULL OR m.purpose = $2) AND ($3::text IS NULL OR m.status = $3) AND ($4::timestamptz IS NULL OR m.created_at < $4)
       UNION ALL
       SELECT 'a' || n.id, COALESCE(n.sent_at, n.created_at), 'alert', NULL, n.destination,
              COALESCE(NULLIF(c.config->>'templateName', ''), $6), COALESCE(NULLIF(c.config->>'templateLang', ''), $7),
              COALESCE(n.delivery, n.state), NULL, COALESCE(n.delivery_error, n.last_error), n.sent_at, n.delivered_at, n.read_at, NULL, NULL
         FROM ${ALERTS_ON_NUMBER}
          AND ($2::text IS NULL OR $2 = 'alert') AND ($3::text IS NULL OR COALESCE(n.delivery, n.state) = $3)
          AND ($4::timestamptz IS NULL OR COALESCE(n.sent_at, n.created_at) < $4)
     ) x ORDER BY at DESC, id DESC LIMIT $5`,
    [f.phoneNumberId ?? '', f.purpose ?? null, f.status ?? null, f.before ?? null, f.limit, WHATSAPP_DEFAULTS.templateName, WHATSAPP_DEFAULTS.templateLang]));
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return rows.map((r) => ({
    id: r.id, at: iso(r.at)!, purpose: r.purpose, to: r.to_masked ?? maskPhone(`+${String(r.dest ?? '').replace(/[^\d]/g, '')}`),
    template: r.template, language: r.language, status: r.status, errorCode: r.error_code, error: r.error_text,
    sentAt: iso(r.sent_at), deliveredAt: iso(r.delivered_at), readAt: iso(r.read_at), pricingCategory: r.pricing_category, billable: r.billable,
  }));
}

export async function events(limit: number) {
  const rows = await outsideRequestScope(() => many<{ id: string; field: string; payload: any; created_at: Date }>(
    `SELECT id, field, payload, created_at FROM whatsapp_event ORDER BY id DESC LIMIT $1`, [limit]));
  return rows.map((r) => ({ id: String(r.id), field: r.field, event: typeof r.payload?.event === 'string' ? r.payload.event : null, payload: r.payload, createdAt: r.created_at.toISOString() }));
}

/** When the webhook last delivered anything: an account event, and a message status. */
export async function webhookActivity(): Promise<{ lastEventAt: string | null; lastStatusAt: string | null }> {
  const r = await outsideRequestScope(() => one<{ e: Date | null; s: Date | null }>(
    `SELECT (SELECT max(created_at) FROM whatsapp_event) AS e, (SELECT max(webhook_at) FROM whatsapp_message) AS s`));
  return { lastEventAt: r?.e ? r.e.toISOString() : null, lastStatusAt: r?.s ? r.s.toISOString() : null };
}
