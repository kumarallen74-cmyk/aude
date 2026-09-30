import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { one, many, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { seal, unseal } from './secrets.js';
import {
  ALERT_KINDS, ruleMatches, inQuietHours, quietEndsAt, normaliseWhatsApp, isEmail,
  renderEmail, renderWhatsApp, renderSms, type MessageInput, type Stage,
} from './alert-format.js';
import { sendEmail, sendWhatsApp, sendSms, checkChannelConfig, metaSignatureOk, WHATSAPP_DEFAULTS, type SendResult } from './notify-transports.js';
import { dutyNow } from './on-call.js';

/**
 * Alert routing: e-mail and WhatsApp notifications.
 *
 * Everything goes through the alert_notification outbox, driven by the worker
 * in the gateway every 5 seconds (runAlertRouting):
 *
 *   1. new alerts       → one row per (rule × channel × contact), de-duplicated
 *                         per destination; non-critical rows wait out quiet hours
 *   2. resolved alerts  → a "resolved" notice to everyone who got the alert
 *                         (rule option), and anything still queued is dropped
 *   3. escalation       → still open and unacknowledged after N minutes → the
 *                         rule's escalation contacts
 *   4. delivery         → send, retry transient failures (1, 5, 15 min), fail
 *                         permanent ones at once; flood guard per recipient
 *
 * The alert table is the source of truth (routed_at / resolve_routed_at), so an
 * alert raised in the API process, or while the gateway was restarting, is still
 * routed. Enqueueing is idempotent (unique per alert, destination, channel, stage).
 */

type Channel = 'email' | 'whatsapp' | 'sms';
const CHANNELS: Channel[] = ['email', 'whatsapp', 'sms'];
const MAX_ATTEMPTS = 4;
const BACKOFF_S = [60, 300, 900];
const CH_LABEL: Record<Channel, string> = { email: 'E-mail', whatsapp: 'WhatsApp', sms: 'SMS' };

interface RuleRow {
  id: string; org_id: string; name: string; enabled: boolean; min_severity: string; kinds: string[]; site_ids: string[];
  channels: Channel[]; contact_ids: string[]; notify_resolved: boolean; quiet_start: string | null; quiet_end: string | null;
  escalate_after_min: number | null; escalate_contact_ids: string[];
  sms_fallback: boolean; rota_ids: string[]; escalate_rota_ids: string[];
}
interface ContactRow { id: string; name: string; email: string | null; whatsapp: string | null; sms: string | null; active: boolean }
interface AlertRow { id: string; org_id: string; severity: string; kind: string; message: string; site_id: string | null; raised_at: Date; resolved_at: Date | null }

/** SMS goes to the contact's SMS number, or else to the WhatsApp number (a mobile number either way). */
const destinationOf = (c: ContactRow, ch: Channel) =>
  ch === 'email' ? (isEmail(c.email) ? c.email : null) : ch === 'sms' ? normaliseWhatsApp(c.sms ?? c.whatsapp) : normaliseWhatsApp(c.whatsapp);

/** The contacts a rule notifies: the named ones, and whoever is on duty on its rotas right now. */
const withDuty = (ids: string[], rotaIds: string[], duty: Map<string, string | null>) =>
  [...new Set([...ids, ...rotaIds.map((r) => duty.get(r)).filter((x): x is string => !!x)])];

async function orgRouting(orgId: string) {
  const [rules, contacts, channels, duty] = await Promise.all([
    many<RuleRow>(`SELECT * FROM alert_rule WHERE org_id = $1 AND enabled`, [orgId]),
    many<ContactRow>(`SELECT id, name, email, whatsapp, sms, active FROM alert_contact WHERE org_id = $1 AND active`, [orgId]),
    // Usable = switched on, and holding a secret unless it is an unauthenticated SMTP relay.
    many<{ kind: Channel }>(
      `SELECT kind FROM notification_channel
        WHERE org_id = $1 AND enabled
          AND (secret IS NOT NULL OR (kind = 'email' AND COALESCE(config->>'username', '') = ''))`,
      [orgId],
    ),
    dutyNow(orgId, config.alerts.timeZone),
  ]);
  return { rules, contacts: new Map(contacts.map((c) => [c.id, c])), live: new Set(channels.map((c) => c.kind)), duty };
}

async function enqueue(orgId: string, alertId: string | null, ruleId: string | null, contactId: string | null, ch: Channel, dest: string, stage: Stage, at: Date) {
  await query(
    `INSERT INTO alert_notification (org_id, alert_id, rule_id, contact_id, channel, destination, stage, next_attempt_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (alert_id, destination, channel, stage) WHERE alert_id IS NOT NULL DO NOTHING`,
    [orgId, alertId, ruleId, contactId, ch, dest, stage, at],
  );
}

/** Rows for one alert and one stage across the matching rules. */
async function fanOut(a: AlertRow, stage: 'raised' | 'escalation', pick: (r: RuleRow) => string[], rules: RuleRow[], ctx: Awaited<ReturnType<typeof orgRouting>>) {
  const now = new Date();
  let n = 0;
  for (const r of rules) {
    // Quiet hours hold non-critical messages until the window ends; critical always goes.
    const at = a.severity !== 'critical' && r.quiet_start && r.quiet_end && inQuietHours(now, r.quiet_start, r.quiet_end, config.alerts.timeZone)
      ? quietEndsAt(now, r.quiet_end, config.alerts.timeZone) : now;
    for (const ch of r.channels) {
      if (!ctx.live.has(ch)) continue;
      for (const cid of pick(r)) {
        const c = ctx.contacts.get(cid);
        const dest = c && destinationOf(c, ch);
        if (!dest) continue;
        await enqueue(a.org_id, a.id, r.id, c.id, ch, dest, stage, at);
        n++;
      }
    }
  }
  return n;
}

async function routeNew(): Promise<number> {
  const alerts = await many<AlertRow>(
    `SELECT id, org_id, severity, kind, message, site_id, raised_at, resolved_at FROM alert
      WHERE routed_at IS NULL ORDER BY raised_at LIMIT 200`,
  );
  const cache = new Map<string, Awaited<ReturnType<typeof orgRouting>>>();
  for (const a of alerts) {
    try {
      // Cleared before we got to it (a fault that recovered within seconds): nobody needs paging.
      if (!a.resolved_at) {
        if (!cache.has(a.org_id)) cache.set(a.org_id, await orgRouting(a.org_id));
        const ctx = cache.get(a.org_id)!;
        const rules = ctx.rules.filter((r) => ruleMatches(r, a));
        if (rules.length) await fanOut(a, 'raised', (r) => withDuty(r.contact_ids, r.rota_ids, ctx.duty), rules, ctx);
      }
      await query(`UPDATE alert SET routed_at = now(), resolve_routed_at = CASE WHEN resolved_at IS NOT NULL THEN now() ELSE resolve_routed_at END WHERE id = $1`, [a.id]);
    } catch (e) {
      logger.warn({ alert: a.id, err: (e as Error).message }, 'alert routing failed; will retry');
    }
  }
  return alerts.length;
}

async function routeResolved(): Promise<void> {
  const alerts = await many<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM alert WHERE resolved_at IS NOT NULL AND resolve_routed_at IS NULL AND routed_at IS NOT NULL LIMIT 200`,
  );
  for (const a of alerts) {
    // Anything not yet delivered about this alert is now moot.
    await query(
      `UPDATE alert_notification SET state = 'suppressed', last_error = 'alert resolved before delivery'
        WHERE alert_id = $1 AND state = 'pending' AND stage IN ('raised', 'escalation')`,
      [a.id],
    );
    const got = await many<{ rule_id: string; contact_id: string | null; channel: Channel; destination: string }>(
      `SELECT DISTINCT ON (n.destination, n.channel) n.rule_id, n.contact_id, n.channel, n.destination
         FROM alert_notification n JOIN alert_rule r ON r.id = n.rule_id
        WHERE n.alert_id = $1 AND n.state = 'sent' AND n.stage IN ('raised', 'escalation') AND r.notify_resolved`,
      [a.id],
    );
    for (const g of got) await enqueue(a.org_id, a.id, g.rule_id, g.contact_id, g.channel, g.destination, 'resolved', new Date());
    await query(`UPDATE alert SET resolve_routed_at = now() WHERE id = $1`, [a.id]);
  }
}

async function routeEscalations(): Promise<void> {
  const due = await many<AlertRow & { rule_id: string }>(
    `SELECT DISTINCT a.id, a.org_id, a.severity, a.kind, a.message, a.site_id, a.raised_at, a.resolved_at, r.id AS rule_id
       FROM alert a
       JOIN alert_notification n ON n.alert_id = a.id AND n.stage = 'raised'
       JOIN alert_rule r ON r.id = n.rule_id
      WHERE a.resolved_at IS NULL AND a.acknowledged_at IS NULL AND r.enabled
        AND r.escalate_after_min IS NOT NULL AND (cardinality(r.escalate_contact_ids) > 0 OR cardinality(r.escalate_rota_ids) > 0)
        AND a.raised_at < now() - make_interval(mins => r.escalate_after_min)
        AND NOT EXISTS (SELECT 1 FROM alert_notification e WHERE e.alert_id = a.id AND e.stage = 'escalation' AND e.rule_id = r.id)
      LIMIT 200`,
  );
  for (const a of due) {
    const ctx = await orgRouting(a.org_id);
    const rule = ctx.rules.find((r) => r.id === a.rule_id);
    if (!rule) continue;
    const n = await fanOut(a, 'escalation', (r) => withDuty(r.escalate_contact_ids, r.escalate_rota_ids, ctx.duty), [rule], ctx);
    if (!n) {
      // No reachable escalation contact: record it once so this is not re-evaluated every 5 s.
      await query(
        `INSERT INTO alert_notification (org_id, alert_id, rule_id, channel, destination, stage, state, last_error)
         VALUES ($1,$2,$3,'email','(none)','escalation','failed','no escalation contact reachable on this rule''s channels')
         ON CONFLICT (alert_id, destination, channel, stage) WHERE alert_id IS NOT NULL DO NOTHING`,
        [a.org_id, a.id, rule.id],
      );
    }
  }
}

// ─────────────────────────────────────────── delivery

interface DueRow {
  id: string; org_id: string; alert_id: string | null; rule_id: string | null; contact_id: string | null; channel: Channel; destination: string; stage: Stage; attempts: number;
  severity: string | null; kind: string | null; message: string | null; raised_at: Date | null; resolved_at: Date | null;
  acknowledged_at: Date | null; occurrences: number | null; site_name: string | null; org_name: string | null;
  ch_enabled: boolean | null; ch_config: any; ch_secret: string | null;
}

async function channelSecret(stored: string | null): Promise<string | null> {
  if (!stored) return null;
  try { return unseal(stored); } catch { return null; }
}

export async function deliver(ch: Channel, cfg: any, secret: string | null, destination: string, m: MessageInput): Promise<SendResult> {
  return ch === 'email' ? sendEmail(cfg, secret, destination, renderEmail(m))
    : ch === 'sms' ? sendSms(cfg, secret, destination, renderSms(m))
    : sendWhatsApp(cfg, secret, destination, renderWhatsApp(m));
}

async function sendDue(limit = 50): Promise<number> {
  const rows = await many<DueRow>(
    `WITH picked AS (
       SELECT id FROM alert_notification WHERE state = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     UPDATE alert_notification n SET attempts = n.attempts + 1, next_attempt_at = now() + interval '2 minutes'
       FROM picked WHERE n.id = picked.id
     RETURNING n.id, n.org_id, n.alert_id, n.rule_id, n.contact_id, n.channel, n.destination, n.stage, n.attempts,
       (SELECT severity FROM alert WHERE id = n.alert_id) AS severity,
       (SELECT kind FROM alert WHERE id = n.alert_id) AS kind,
       (SELECT message FROM alert WHERE id = n.alert_id) AS message,
       (SELECT raised_at FROM alert WHERE id = n.alert_id) AS raised_at,
       (SELECT resolved_at FROM alert WHERE id = n.alert_id) AS resolved_at,
       (SELECT acknowledged_at FROM alert WHERE id = n.alert_id) AS acknowledged_at,
       (SELECT occurrences FROM alert WHERE id = n.alert_id) AS occurrences,
       (SELECT s.name FROM alert a JOIN site s ON s.id = a.site_id WHERE a.id = n.alert_id) AS site_name,
       (SELECT name FROM organisation WHERE id = n.org_id) AS org_name,
       (SELECT enabled FROM notification_channel c WHERE c.org_id = n.org_id AND c.kind = n.channel) AS ch_enabled,
       (SELECT config FROM notification_channel c WHERE c.org_id = n.org_id AND c.kind = n.channel) AS ch_config,
       (SELECT secret FROM notification_channel c WHERE c.org_id = n.org_id AND c.kind = n.channel) AS ch_secret`,
    [limit],
  );
  for (const r of rows) await sendOne(r).catch((e) => logger.warn({ id: r.id, err: (e as Error).message }, 'notification send failed'));
  return rows.length;
}

const finish = (id: string, state: 'sent' | 'failed' | 'suppressed', error: string | null, ref: string | null = null) =>
  query(
    `UPDATE alert_notification SET state = $2, last_error = $3, provider_ref = COALESCE($4, provider_ref),
            sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
      WHERE id = $1`,
    [id, state, error, ref],
  );

async function sendOne(r: DueRow): Promise<void> {
  if ((r.stage === 'raised' || r.stage === 'escalation') && r.resolved_at) return void (await finish(r.id, 'suppressed', 'alert resolved before delivery'));
  if (r.stage === 'escalation' && r.acknowledged_at) return void (await finish(r.id, 'suppressed', 'alert acknowledged before escalation'));
  if (!r.ch_enabled || !r.ch_config) {
    await finish(r.id, 'failed', `${CH_LABEL[r.channel]} channel is not configured or is switched off`);
    if (r.channel === 'whatsapp') await smsFallback(r.id);
    return;
  }

  // Flood guard: past the limit a recipient gets one "paused" notice per window, not dozens of alerts.
  if (r.stage !== 'storm' && r.stage !== 'test') {
    const recent = await one<{ n: number; notice: boolean }>(
      `SELECT count(*) FILTER (WHERE state = 'sent' AND stage IN ('raised','escalation','resolved'))::int AS n,
              bool_or(stage = 'storm') AS notice
         FROM alert_notification
        WHERE org_id = $1 AND destination = $2 AND channel = $3 AND created_at > now() - interval '15 minutes'`,
      [r.org_id, r.destination, r.channel],
    );
    if ((recent?.n ?? 0) >= config.alerts.maxPer15Min) {
      await finish(r.id, 'suppressed', `flood guard: over ${config.alerts.maxPer15Min} messages in 15 minutes to this recipient`);
      if (!recent?.notice) {
        await query(
          `INSERT INTO alert_notification (org_id, channel, destination, stage) VALUES ($1,$2,$3,'storm')`,
          [r.org_id, r.channel, r.destination],
        );
      }
      return;
    }
  }

  const m: MessageInput = {
    stage: r.stage,
    severity: r.severity ?? 'info',
    kind: r.kind ?? 'notice',
    message: r.message ?? '',
    siteName: r.site_name,
    raisedAt: r.raised_at ? new Date(r.raised_at) : new Date(),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at) : null,
    occurrences: r.occurrences ?? 1,
    orgName: r.org_name,
    consoleUrl: config.alerts.consoleUrl,
    timeZone: config.alerts.timeZone,
  };
  const res = await deliver(r.channel, r.ch_config, await channelSecret(r.ch_secret), r.destination, m);
  if (res.ok) {
    await finish(r.id, 'sent', null, res.ref ?? null);
    await query(`UPDATE notification_channel SET last_error = NULL WHERE org_id = $1 AND kind = $2 AND last_error IS NOT NULL`, [r.org_id, r.channel]);
    return;
  }
  await query(`UPDATE notification_channel SET last_error = $3 WHERE org_id = $1 AND kind = $2`, [r.org_id, r.channel, res.error ?? 'failed']);
  if (res.permanent || r.attempts >= MAX_ATTEMPTS) {
    await finish(r.id, 'failed', res.error ?? 'failed');
    // WhatsApp gave up on this message: an SMS instead, where the rule asks for it.
    if (r.channel === 'whatsapp') await smsFallback(r.id);
    return;
  }
  const wait = BACKOFF_S[Math.min(r.attempts - 1, BACKOFF_S.length - 1)]!;
  await query(
    `UPDATE alert_notification SET last_error = $2, next_attempt_at = now() + make_interval(secs => $3::int) WHERE id = $1`,
    [r.id, res.error ?? 'failed', wait],
  );
}

/**
 * WhatsApp did not get a message to the contact (refused when sending, or reported failed later by Meta's
 * status webhook): an SMS with the same content instead, when the message's rule asks for it, the SMS
 * channel is live and the contact has a mobile number. Idempotent (one SMS per alert, number and stage).
 */
export async function smsFallback(notificationId: string): Promise<boolean> {
  const n = await one<{ org_id: string; alert_id: string | null; rule_id: string | null; contact_id: string | null; stage: Stage; fallback: boolean | null }>(
    `SELECT n.org_id, n.alert_id, n.rule_id, n.contact_id, n.stage, r.sms_fallback AS fallback
       FROM alert_notification n LEFT JOIN alert_rule r ON r.id = n.rule_id
      WHERE n.id = $1 AND n.channel = 'whatsapp'`, [notificationId]);
  if (!n?.fallback || !n.alert_id || !n.contact_id || !['raised', 'escalation', 'resolved'].includes(n.stage)) return false;
  const live = await one<{ ok: boolean }>(`SELECT true AS ok FROM notification_channel WHERE org_id = $1 AND kind = 'sms' AND enabled AND secret IS NOT NULL`, [n.org_id]);
  if (!live) return false;
  const c = await one<ContactRow>(`SELECT id, name, email, whatsapp, sms, active FROM alert_contact WHERE id = $1 AND active`, [n.contact_id]);
  const dest = c && destinationOf(c, 'sms');
  if (!dest) return false;
  const r = await query(
    `INSERT INTO alert_notification (org_id, alert_id, rule_id, contact_id, channel, destination, stage, fallback_of)
     VALUES ($1,$2,$3,$4,'sms',$5,$6,$7)
     ON CONFLICT (alert_id, destination, channel, stage) WHERE alert_id IS NOT NULL DO NOTHING`,
    [n.org_id, n.alert_id, n.rule_id, n.contact_id, dest, n.stage, notificationId]);
  if (r.rowCount) logger.info({ notification: notificationId, alert: n.alert_id }, 'WhatsApp alert failed: SMS fallback queued');
  return (r.rowCount ?? 0) > 0;
}

// ─────────────────────────────────────────── WhatsApp delivery status (Meta webhook)

/** Meta's subscription check: echo hub.challenge when the verify token matches this channel's. */
export async function whatsappWebhookVerify(key: string, mode: string, token: string, challenge: string): Promise<string | null> {
  if (mode !== 'subscribe' || !/^[A-Za-z0-9_-]{16,64}$/.test(key)) return null;
  const ch = await one<{ verify_token: string | null }>(`SELECT verify_token FROM notification_channel WHERE webhook_key = $1 AND kind = 'whatsapp'`, [key]);
  return ch?.verify_token && sameSecret(token, ch.verify_token) ? challenge : null;
}

/**
 * Constant-time comparison of two secrets. Both are hashed first, so the comparison takes the
 * same time whatever the inputs, and does not reveal the secret's length either.
 */
export function sameSecret(given: string, expected: string): boolean {
  const h = (v: string) => createHash('sha256').update(v, 'utf8').digest();
  return timingSafeEqual(h(given), h(expected));
}

/**
 * Meta's status callbacks for messages PlugSure sent: delivered, read, failed (after WhatsApp accepted them, which is
 * all "sent" means). Signed with the app secret; a failed one can fall back to SMS. Unknown message ids are ignored.
 */
export async function whatsappStatusWebhook(key: string, rawBody: string, signature: string | undefined): Promise<{ status: number; body: unknown }> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) return { status: 404, body: { error: 'unknown webhook' } };
  const ch = await one<{ org_id: string; webhook_secret: string | null }>(`SELECT org_id, webhook_secret FROM notification_channel WHERE webhook_key = $1 AND kind = 'whatsapp'`, [key]);
  if (!ch) return { status: 404, body: { error: 'unknown webhook' } };
  const appSecret = await channelSecret(ch.webhook_secret);
  if (!appSecret) return { status: 403, body: { error: 'the WhatsApp app secret is not saved on this channel' } };
  if (!metaSignatureOk(rawBody, signature, appSecret)) return { status: 401, body: { error: 'invalid signature' } };
  let j: any;
  try { j = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'not JSON' } }; }
  let n = 0;
  for (const e of Array.isArray(j?.entry) ? j.entry : []) for (const c of Array.isArray(e?.changes) ? e.changes : []) {
    for (const s of Array.isArray(c?.value?.statuses) ? c.value.statuses : []) {
      const ref = String(s?.id ?? ''), st = String(s?.status ?? '');
      const at = Number(s?.timestamp) > 0 ? new Date(Number(s.timestamp) * 1000) : new Date();
      if (!ref || !['delivered', 'read', 'failed'].includes(st)) continue;
      const err = st === 'failed' ? (s.errors ?? []).map((x: any) => `${x?.title ?? x?.message ?? 'failed'}${x?.code ? ` (code ${x.code})` : ''}${x?.error_data?.details ? `: ${x.error_data.details}` : ''}`).join('; ').slice(0, 300) || 'failed' : null;
      const row = await one<{ id: string }>(
        `UPDATE alert_notification SET
            delivery = CASE WHEN $3 = 'failed' THEN 'failed' WHEN $3 = 'read' OR delivery = 'read' THEN 'read' ELSE 'delivered' END,
            delivered_at = CASE WHEN $3 IN ('delivered', 'read') THEN COALESCE(delivered_at, $4) ELSE delivered_at END,
            read_at = CASE WHEN $3 = 'read' THEN COALESCE(read_at, $4) ELSE read_at END,
            delivery_error = CASE WHEN $3 = 'failed' THEN $5 ELSE delivery_error END
          WHERE org_id = $1 AND channel = 'whatsapp' AND provider_ref = $2 RETURNING id`,
        [ch.org_id, ref, st, at, err]);
      if (!row) continue;
      n++;
      if (st === 'failed') await smsFallback(row.id);
    }
  }
  return { status: 200, body: { ok: true, statuses: n } };
}

/** One worker pass. */
export async function runAlertRouting(): Promise<void> {
  await routeNew();
  await routeResolved();
  await routeEscalations();
  while ((await sendDue()) === 50);
}

// ─────────────────────────────────────────── management (API)

export async function getChannels(orgId: string) {
  const rows = await many<any>(
    `SELECT kind, enabled, config, secret IS NOT NULL AS has_secret, last_test_at, last_test_ok, last_error, updated_at,
            webhook_key, verify_token, webhook_secret IS NOT NULL AS has_webhook_secret
       FROM notification_channel WHERE org_id = $1`,
    [orgId],
  );
  const by = Object.fromEntries(rows.map((r) => {
    const { webhook_key, verify_token, has_webhook_secret, ...rest } = r;
    // WhatsApp: where Meta sends delivery statuses, the token it checks, and whether the app secret is saved.
    return [r.kind, r.kind === 'whatsapp' ? { ...rest, webhook: webhook_key ? { path: `/hooks/whatsapp/${webhook_key}`, verifyToken: verify_token, hasAppSecret: has_webhook_secret } : null } : rest];
  }));
  return {
    email: by.email ?? { kind: 'email', enabled: false, config: { port: 587, security: 'starttls' }, has_secret: false },
    whatsapp: by.whatsapp ?? { kind: 'whatsapp', enabled: false, config: { ...WHATSAPP_DEFAULTS }, has_secret: false, webhook: null },
    sms: by.sms ?? { kind: 'sms', enabled: false, config: { provider: 'twilio' }, has_secret: false },
  };
}

const EMAIL_KEYS = ['host', 'port', 'security', 'username', 'fromAddress', 'fromName'];
const WA_KEYS = ['apiBase', 'phoneNumberId', 'templateName', 'templateLang'];
const SMS_KEYS = ['provider', 'accountSid', 'from', 'messagingServiceSid', 'baseUrl', 'userkey', 'endpoint', 'url'];

export async function saveChannel(orgId: string, kind: Channel, input: { enabled?: boolean; config?: any; secret?: string | null; webhookSecret?: string | null }) {
  const keys = kind === 'email' ? EMAIL_KEYS : kind === 'sms' ? SMS_KEYS : WA_KEYS;
  const cfg: Record<string, unknown> = {};
  for (const k of keys) {
    const v = input.config?.[k];
    if (v === undefined || v === null || v === '') continue;
    cfg[k] = k === 'port' ? Number(v) : String(v).trim();
  }
  const err = checkChannelConfig(kind, cfg);
  if (err) return { error: err };
  const newSecret = typeof input.secret === 'string' && input.secret.length ? seal(input.secret) : null;
  const existing = await one<{ secret: string | null }>(`SELECT secret FROM notification_channel WHERE org_id = $1 AND kind = $2`, [orgId, kind]);
  const secret = newSecret ?? existing?.secret ?? null;
  if (kind === 'whatsapp' && !secret) return { error: 'Enter the WhatsApp access token (a permanent System User token).' };
  if (kind === 'email' && cfg.username && !secret) return { error: 'Enter the SMTP password for this user name.' };
  if (kind === 'sms' && !secret) return { error: cfg.provider === 'twilio' ? 'Enter the Twilio auth token.' : cfg.provider === 'zenziva' ? 'Enter the Zenziva pass key.' : 'Enter your gateway\'s token.' };
  // WhatsApp's status webhook: a secret path and verify token made once, and Meta's app secret (write-only) to check signatures.
  const hookSecret = kind === 'whatsapp' && typeof input.webhookSecret === 'string' && input.webhookSecret.length ? seal(input.webhookSecret) : null;
  await query(
    `INSERT INTO notification_channel (org_id, kind, enabled, config, secret, webhook_key, verify_token, webhook_secret)
     VALUES ($1,$2,$3,$4,$5,
             CASE WHEN $2 = 'whatsapp' THEN $6 END, CASE WHEN $2 = 'whatsapp' THEN $7 END, $8)
     ON CONFLICT (org_id, kind) DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config, secret = EXCLUDED.secret, updated_at = now(),
       webhook_key = COALESCE(notification_channel.webhook_key, EXCLUDED.webhook_key),
       verify_token = COALESCE(notification_channel.verify_token, EXCLUDED.verify_token),
       webhook_secret = COALESCE(EXCLUDED.webhook_secret, notification_channel.webhook_secret)`,
    [orgId, kind, input.enabled !== false, JSON.stringify(cfg), secret, randomBytes(18).toString('base64url'), randomBytes(18).toString('base64url'), hookSecret],
  );
  return { ok: true };
}

/** Send a test message now (not queued) and record it in the log. */
export async function testChannel(orgId: string, kind: Channel, rawDestination: string) {
  const dest = kind === 'email' ? (isEmail(rawDestination) ? rawDestination.trim() : null) : normaliseWhatsApp(rawDestination);
  if (!dest) return { error: kind === 'email' ? 'Enter a valid e-mail address.' : `Enter a valid ${kind === 'sms' ? 'mobile' : 'WhatsApp'} number, e.g. 0812 3456 7890.` };
  const ch = await one<{ config: any; secret: string | null }>(`SELECT config, secret FROM notification_channel WHERE org_id = $1 AND kind = $2`, [orgId, kind]);
  if (!ch) return { error: 'Save the channel settings first.' };
  const org = await one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [orgId]);
  const res = await deliver(kind, ch.config, await channelSecret(ch.secret), dest, {
    stage: 'test', severity: 'info', kind: 'test', message: '', siteName: null, raisedAt: new Date(),
    orgName: org?.name ?? null, consoleUrl: config.alerts.consoleUrl, timeZone: config.alerts.timeZone,
  });
  await query(
    `UPDATE notification_channel SET last_test_at = now(), last_test_ok = $3, last_error = $4 WHERE org_id = $1 AND kind = $2`,
    [orgId, kind, res.ok, res.ok ? null : res.error ?? 'failed'],
  );
  await query(
    `INSERT INTO alert_notification (org_id, channel, destination, stage, state, attempts, last_error, provider_ref, sent_at)
     VALUES ($1,$2,$3,'test',$4,1,$5,$6,$7)`,
    [orgId, kind, dest, res.ok ? 'sent' : 'failed', res.ok ? null : res.error ?? null, res.ref ?? null, res.ok ? new Date() : null],
  );
  return { result: { ok: res.ok, destination: dest, reference: res.ref ?? null, error: res.error ?? null } };
}

// contacts

export async function listContacts(orgId: string) {
  return many(`SELECT id, name, email, whatsapp, sms, active, created_at FROM alert_contact WHERE org_id = $1 ORDER BY name`, [orgId]);
}

function cleanContact(input: any): { error: string } | { name: string; email: string | null; whatsapp: string | null; sms: string | null; active: boolean } {
  const name = String(input?.name ?? '').trim().slice(0, 120);
  if (!name) return { error: 'Enter a name.' };
  const email = String(input?.email ?? '').trim() || null;
  if (email && !isEmail(email)) return { error: 'That e-mail address is not valid.' };
  const rawWa = String(input?.whatsapp ?? '').trim();
  const whatsapp = rawWa ? normaliseWhatsApp(rawWa) : null;
  if (rawWa && !whatsapp) return { error: 'That WhatsApp number is not valid. Use the full number, e.g. 0812 3456 7890 or +62 812 3456 7890.' };
  const rawSms = String(input?.sms ?? '').trim();
  const sms = rawSms ? normaliseWhatsApp(rawSms) : null;
  if (rawSms && !sms) return { error: 'That SMS number is not valid. Use the full number, e.g. 0812 3456 7890.' };
  if (!email && !whatsapp && !sms) return { error: 'Enter an e-mail address, a WhatsApp number or an SMS number.' };
  return { name, email, whatsapp, sms, active: input?.active !== false };
}

export async function saveContact(orgId: string, id: string | null, input: any) {
  const c = cleanContact(input);
  if ('error' in c) return c;
  const row = id
    ? await one(`UPDATE alert_contact SET name = $3, email = $4, whatsapp = $5, sms = $6, active = $7, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING id, name, email, whatsapp, sms, active`, [id, orgId, c.name, c.email, c.whatsapp, c.sms, c.active])
    : await one(`INSERT INTO alert_contact (org_id, name, email, whatsapp, sms, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, email, whatsapp, sms, active`, [orgId, c.name, c.email, c.whatsapp, c.sms, c.active]);
  return row ? { contact: row } : { error: 'not found' };
}

export async function deleteContact(orgId: string, id: string) {
  // Take them out of every rule and rota too, so nothing points at a ghost.
  await query(`UPDATE on_call_rota SET member_ids = array_remove(member_ids, $2::uuid) WHERE org_id = $1`, [orgId, id]);
  await query(
    `UPDATE alert_rule SET contact_ids = array_remove(contact_ids, $2::uuid), escalate_contact_ids = array_remove(escalate_contact_ids, $2::uuid)
      WHERE org_id = $1`,
    [orgId, id],
  );
  const r = await query(`DELETE FROM alert_contact WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return (r.rowCount ?? 0) > 0;
}

// rules

export async function listRules(orgId: string) {
  return many(`SELECT * FROM alert_rule WHERE org_id = $1 ORDER BY created_at`, [orgId]);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

async function cleanRule(orgId: string, input: any) {
  const name = String(input?.name ?? '').trim().slice(0, 120);
  if (!name) return { error: 'Give the rule a name.' };
  const min = String(input?.minSeverity ?? 'critical');
  if (!['info', 'warning', 'critical'].includes(min)) return { error: 'Choose a minimum severity.' };
  const kinds = (Array.isArray(input?.kinds) ? input.kinds : []).map(String);
  const badKind = kinds.find((k: string) => !(k in ALERT_KINDS) && !/^[a-z_]+\.\*$/.test(k));
  if (badKind) return { error: `Unknown alert type: ${badKind}` };
  const channels = [...new Set((Array.isArray(input?.channels) ? input.channels : []).map(String))] as Channel[];
  if (!channels.length || channels.some((c) => !CHANNELS.includes(c))) return { error: 'Choose e-mail, WhatsApp, SMS, or several.' };
  const ids = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map(String))].filter((x) => UUID_RE.test(x));
  const siteIds = ids(input?.siteIds);
  const contactIds = ids(input?.contactIds);
  const escIds = ids(input?.escalateContactIds);
  const rotaIds = ids(input?.rotaIds);
  const escRotaIds = ids(input?.escalateRotaIds);
  if (!contactIds.length && !rotaIds.length) return { error: 'Choose at least one contact, or an on-call rota, to notify.' };
  const owned = await one<{ sites: number; contacts: number; rotas: number }>(
    `SELECT (SELECT count(*) FROM site WHERE org_id = $1 AND id = ANY($2::uuid[]))::int AS sites,
            (SELECT count(*) FROM alert_contact WHERE org_id = $1 AND id = ANY($3::uuid[]))::int AS contacts,
            (SELECT count(*) FROM on_call_rota WHERE org_id = $1 AND id = ANY($4::uuid[]))::int AS rotas`,
    [orgId, siteIds, [...new Set([...contactIds, ...escIds])], [...new Set([...rotaIds, ...escRotaIds])]],
  );
  if (owned?.sites !== siteIds.length || owned?.contacts !== new Set([...contactIds, ...escIds]).size || owned?.rotas !== new Set([...rotaIds, ...escRotaIds]).size) return { error: 'A chosen site, contact or rota does not exist.' };
  const smsFallbackOn = input?.smsFallback === true;
  if (smsFallbackOn && !channels.includes('whatsapp')) return { error: 'SMS fallback is for WhatsApp messages: send by WhatsApp too, or turn it off.' };
  const qs = String(input?.quietStart ?? '').trim(), qe = String(input?.quietEnd ?? '').trim();
  if ((qs || qe) && !(HHMM.test(qs) && HHMM.test(qe) && qs !== qe)) return { error: 'Quiet hours need a start and an end time (HH:MM), e.g. 22:00 to 06:00.' };
  const esc = input?.escalateAfterMin === '' || input?.escalateAfterMin == null ? null : Number(input.escalateAfterMin);
  if (esc !== null && !(Number.isInteger(esc) && esc >= 1 && esc <= 1440)) return { error: 'Escalate after 1 to 1440 minutes.' };
  if (esc !== null && !escIds.length && !escRotaIds.length) return { error: 'Choose who to escalate to (people or a rota), or turn escalation off.' };
  return {
    rule: {
      name, enabled: input?.enabled !== false, min, kinds, siteIds, channels, contactIds,
      notifyResolved: input?.notifyResolved !== false, quietStart: qs || null, quietEnd: qe || null, esc, escIds: esc === null ? [] : escIds,
      smsFallback: smsFallbackOn, rotaIds, escRotaIds: esc === null ? [] : escRotaIds,
    },
  };
}

export async function saveRule(orgId: string, id: string | null, input: any) {
  const c = await cleanRule(orgId, input);
  if ('error' in c) return c;
  const r = c.rule;
  const vals = [orgId, r.name, r.enabled, r.min, r.kinds, r.siteIds, r.channels, r.contactIds, r.notifyResolved, r.quietStart, r.quietEnd, r.esc, r.escIds, r.smsFallback, r.rotaIds, r.escRotaIds];
  const row = id
    ? await one(
        `UPDATE alert_rule SET name = $2, enabled = $3, min_severity = $4, kinds = $5, site_ids = $6, channels = $7, contact_ids = $8,
                notify_resolved = $9, quiet_start = $10, quiet_end = $11, escalate_after_min = $12, escalate_contact_ids = $13,
                sms_fallback = $14, rota_ids = $15, escalate_rota_ids = $16, updated_at = now()
          WHERE org_id = $1 AND id = $17 RETURNING *`,
        [...vals, id],
      )
    : await one(
        `INSERT INTO alert_rule (org_id, name, enabled, min_severity, kinds, site_ids, channels, contact_ids, notify_resolved, quiet_start, quiet_end, escalate_after_min, escalate_contact_ids, sms_fallback, rota_ids, escalate_rota_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        vals,
      );
  return row ? { rule: row } : { error: 'not found' };
}

export async function deleteRule(orgId: string, id: string) {
  const r = await query(`DELETE FROM alert_rule WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return (r.rowCount ?? 0) > 0;
}

// log

export async function listNotifications(orgId: string, filter: { state?: string; alertId?: string }) {
  return many(
    `SELECT n.id, n.alert_id, n.channel, n.destination, n.stage, n.state, n.attempts, n.next_attempt_at, n.last_error,
            n.provider_ref, n.created_at, n.sent_at, n.delivery, n.delivered_at, n.read_at, n.delivery_error, n.fallback_of,
            a.kind, a.severity, a.message, c.name AS contact_name, r.name AS rule_name
       FROM alert_notification n
       LEFT JOIN alert a ON a.id = n.alert_id
       LEFT JOIN alert_contact c ON c.id = n.contact_id
       LEFT JOIN alert_rule r ON r.id = n.rule_id
      WHERE n.org_id = $1
        AND ($2::text IS NULL OR n.state = $2)
        AND ($3::uuid IS NULL OR n.alert_id = $3::uuid)
      ORDER BY n.created_at DESC LIMIT 300`,
    [orgId, filter.state && ['pending', 'sent', 'failed', 'suppressed'].includes(filter.state) ? filter.state : null, filter.alertId && UUID_RE.test(filter.alertId) ? filter.alertId : null],
  );
}

/** Resend a failed notification (e.g. after fixing the channel settings). */
export async function retryNotification(orgId: string, id: string) {
  const r = await query(
    `UPDATE alert_notification SET state = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
      WHERE id = $1 AND org_id = $2 AND state = 'failed' AND stage <> 'test'`,
    [id, orgId],
  );
  return (r.rowCount ?? 0) > 0;
}
