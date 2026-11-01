import type { FastifyInstance, FastifyRequest } from 'fastify';
import { limitParam } from './paging.js';
import { assertCan } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import { config } from '../config.js';
import { maskPhone } from '../domain/phone.js';
import { normalisePhone } from '../driver/identity.js';
import { TokenBuckets } from '../services/ratelimit.js';
import { webhookPathFor } from '../integrations/store.js';
import * as wa from '../services/whatsapp-cloud.js';
import * as support from '../services/whatsapp-support.js';

/**
 * Governance → WhatsApp (v1.10.0): the dashboard of PlugSure's WhatsApp Business Account.
 *
 *   GET  /v1/whatsapp/overview    connection health (number, quality, tier), webhook, required templates, stats
 *   GET  /v1/whatsapp/templates   the WABA's templates, the ones PlugSure needs marked
 *   GET  /v1/whatsapp/messages    the message ledger and the WhatsApp alerts from the same number (masked)
 *   GET  /v1/whatsapp/events      template, quality and account events from the webhook
 *   POST /v1/whatsapp/test        send one template message
 *   (v1.11.0) the support inbox — customers' messages, answered by the AI assistant (Claude) or by staff:
 *   GET  /v1/whatsapp/conversations                 newest first, by handler (ai / human / closed)
 *   GET  /v1/whatsapp/conversations/:id             one conversation and its messages
 *   POST /v1/whatsapp/conversations/:id/reply       staff reply (within Meta's 24-hour window); staff take over
 *   POST /v1/whatsapp/conversations/:id/handler     hand to the assistant, take over, or close
 *   POST /v1/whatsapp/conversations/:id/suggest     a suggested reply from the assistant
 *
 * The connection is the platform's sign-in codes integration on the WhatsApp Cloud API (whatsapp-cloud.ts).
 * platform:admin only: the WABA is the platform's asset, and the ledger spans every tenant's drivers. Queries run
 * outside the caller's tenant scope (whatsapp-cloud.ts) for the same reason. A Graph API failure is part of the
 * answer (connection.error), never a 500: the dashboard is where an operator goes when WhatsApp is broken.
 */

const PURPOSES = ['otp', 'alert', 'test', 'other', 'support'] as const;
const HANDLERS = ['ai', 'human', 'closed'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['accepted', 'sent', 'delivered', 'read', 'failed'] as const;
/** Test sends: a handful a minute per administrator is plenty, and keeps a stuck button from spamming a phone. */
const testBuckets = new TokenBuckets();
const TEST_PER_MIN = 5;
/** Suggested replies cost an Anthropic request each. */
const suggestBuckets = new TokenBuckets();
const SUGGEST_PER_MIN = 10;

export async function registerWhatsAppRoutes(app: FastifyInstance): Promise<void> {
  const publicBase = (req: FastifyRequest) => config.console.publicBaseUrl || `${req.protocol}://${req.headers.host ?? 'localhost'}`;
  const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });

  app.get('/v1/whatsapp/overview', async (req) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const q = (req.query ?? {}) as Record<string, string>;
    if (q.days !== undefined && q.days !== '7' && q.days !== '30') throw bad('days must be 7 or 30');
    const days = q.days === '30' ? 30 : 7;
    const conn = await wa.connection();
    const [stats, activity, required, failures, supportStats, supportCfg] = await Promise.all([
      wa.stats(days, conn?.phoneNumberId ?? null),
      wa.webhookActivity(),
      wa.requiredTemplates(conn),
      wa.messages({ phoneNumberId: conn?.phoneNumberId ?? null, status: 'failed', limit: 10 }),
      support.supportStats(days),
      support.supportConfig(),
    ]);
    let connection: Record<string, unknown> | null = null;
    let requiredTemplates: Array<wa.RequiredTemplate & { status: string | null; category: string | null }> = required.map((t) => ({ ...t, status: null, category: null }));
    if (conn) {
      connection = {
        source: conn.kind, wabaId: conn.wabaId || null, phoneNumberId: conn.phoneNumberId, displayPhoneNumber: null, verifiedName: null, qualityRating: null,
        messagingLimitTier: null, nameStatus: null, status: null, checkedAt: new Date().toISOString(), error: null,
      };
      const [n, t] = await Promise.allSettled([wa.phoneNumber(conn), wa.templates(conn)]);
      if (n.status === 'fulfilled') {
        const v = n.value;
        Object.assign(connection, { displayPhoneNumber: v.displayPhoneNumber, verifiedName: v.verifiedName, qualityRating: v.qualityRating, messagingLimitTier: v.messagingLimitTier, nameStatus: v.nameStatus, status: v.status });
      } else connection.error = (n.reason as Error).message;
      if (t.status === 'fulfilled') {
        requiredTemplates = required.map((r) => {
          const hit = t.value.find((x) => x.name === r.name && x.language === r.language);
          return { ...r, status: hit?.status ?? 'MISSING', category: hit?.category ?? null };
        });
      } else if ((t.reason as wa.WhatsAppError).code !== 'no_waba' && !connection.error) connection.error = (t.reason as Error).message;
    }
    return {
      configured: Boolean(conn),
      connection,
      webhook: conn ? {
        url: conn.webhookKey ? publicBase(req) + webhookPathFor(conn.kind, 'whatsapp_cloud', conn.webhookKey) : null,
        hasAppSecret: Boolean(conn.appSecret),
        verifyToken: conn.verifyToken,
        fields: ['messages', 'message_template_status_update', 'phone_number_quality_update', 'account_update'],
        ...activity,
      } : null,
      requiredTemplates,
      stats,
      recentFailures: failures,
      support: { ...supportStats, configured: Boolean(supportCfg?.apiKey), mode: supportCfg?.mode ?? null, model: supportCfg?.model ?? null },
    };
  });

  app.get('/v1/whatsapp/templates', async (req, reply) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const conn = await wa.connection();
    if (!conn) return reply.status(409).send({ error: wa.NOT_CONFIGURED });
    if (!conn.wabaId) return reply.status(409).send({ error: wa.NO_WABA, code: 'no_waba' });
    try {
      const [list, required] = await Promise.all([wa.templates(conn), wa.requiredTemplates(conn)]);
      return {
        templates: list.map((t) => ({ ...t, required: required.some((r) => r.name === t.name && r.language === t.language) })),
        required,
        managerUrl: `https://business.facebook.com/wa/manage/message-templates/?waba_id=${encodeURIComponent(conn.wabaId)}`,
      };
    } catch (e) {
      return reply.status(502).send({ error: (e as Error).message });
    }
  });

  app.get('/v1/whatsapp/messages', async (req) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const q = (req.query ?? {}) as Record<string, string>;
    const purpose = q.purpose ? String(q.purpose) : null;
    const status = q.status ? String(q.status) : null;
    if (purpose && !(PURPOSES as readonly string[]).includes(purpose)) throw bad(`purpose must be one of ${PURPOSES.join(', ')}`);
    if (status && !(STATUSES as readonly string[]).includes(status)) throw bad(`status must be one of ${STATUSES.join(', ')}`);
    let before: Date | null = null;
    if (q.before) { before = new Date(String(q.before)); if (Number.isNaN(before.getTime())) throw bad('before must be a date-time'); }
    const limit = limitParam(q.limit, 50, 200);
    const conn = await wa.connection();
    const rows = await wa.messages({ phoneNumberId: conn?.phoneNumberId ?? null, purpose: purpose as wa.Purpose | null, status: status as wa.Status | null, before, limit });
    return { messages: rows, nextBefore: rows.length === limit ? rows[rows.length - 1]!.at : null };
  });

  app.get('/v1/whatsapp/events', async (req) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    return { events: await wa.events(limitParam((req.query as any)?.limit, 50, 200)) };
  });

  app.post('/v1/whatsapp/test', async (req, reply) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const phone = normalisePhone(String(b.phone ?? ''));
    if (!phone) return reply.status(422).send({ error: 'That is not a mobile number we can send to (Indonesia, Malaysia or Singapore).' });
    const template = String(b.template ?? '').trim();
    if (!/^[a-z0-9_]{1,512}$/.test(template)) return reply.status(422).send({ error: 'Template names use lower-case letters, digits and underscores.' });
    const language = String(b.language ?? '').trim();
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) return reply.status(422).send({ error: 'The language is a template language code such as id, en or en_US.' });
    const params = b.params === undefined || b.params === null ? [] : b.params;
    if (!Array.isArray(params) || params.length > 10 || params.some((p) => typeof p !== 'string' || !p.trim() || p.length > 1024)) {
      return reply.status(422).send({ error: 'params: up to 10 non-empty texts, one per template variable.' });
    }
    const d = testBuckets.take(req.principal.userId ?? req.ip, TEST_PER_MIN);
    if (!d.allowed) return reply.status(429).header('Retry-After', d.retryAfterS).send({ error: `At most ${TEST_PER_MIN} test messages a minute.` });
    const conn = await wa.connection();
    if (!conn) return reply.status(409).send({ error: wa.NOT_CONFIGURED });
    const components: unknown[] = params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : [];
    // An Authentication template takes its code again for the copy-code button.
    if (b.copyCodeButton === true && params.length) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: params[0] }] });
    const r = await wa.sendTemplate({ to: phone, template, language, components, purpose: 'test', conn });
    await writeAudit({
      orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action: 'whatsapp.test_sent', targetType: 'integration', targetId: 'whatsapp:platform', ip: req.ip,
      after: { to: maskPhone(phone), template, language, ok: r.ok, ...(r.ok ? { messageId: r.wamid } : { error: r.error.slice(0, 200) }) },
    });
    return r.ok ? { ok: true, messageId: r.wamid, to: maskPhone(phone) } : { ok: false, error: r.error, to: maskPhone(phone) };
  });

  // ─────────────────────────────────────────── (v1.11.0) the support inbox

  const conversationId = (req: FastifyRequest) => {
    const id = String((req.params as Record<string, string>).id ?? '');
    if (!UUID_RE.test(id)) throw Object.assign(new Error('No such conversation.'), { statusCode: 404 });
    return id;
  };
  const failed = (reply: any, e: unknown) => {
    if (e instanceof support.SupportError) return reply.status(e.statusCode).send({ error: e.message });
    throw e;
  };

  app.get('/v1/whatsapp/conversations', async (req) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const q = (req.query ?? {}) as Record<string, string>;
    const handler = q.handler ? String(q.handler) : null;
    if (handler && !(HANDLERS as readonly string[]).includes(handler)) throw bad(`handler must be one of ${HANDLERS.join(', ')}`);
    let before: Date | null = null;
    if (q.before) { before = new Date(String(q.before)); if (Number.isNaN(before.getTime())) throw bad('before must be a date-time'); }
    const limit = limitParam(q.limit, 50, 200);
    const rows = await support.conversations({ handler: handler as support.Handler | null, before, limit });
    const cfg = await support.supportConfig();
    return { conversations: rows, nextBefore: rows.length === limit ? rows[rows.length - 1]!.lastMessageAt : null, assistant: { configured: Boolean(cfg?.apiKey), mode: cfg?.mode ?? null } };
  });

  app.get('/v1/whatsapp/conversations/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const r = await support.conversation(conversationId(req));
    return r ?? reply.status(404).send({ error: 'No such conversation.' });
  });

  app.post('/v1/whatsapp/conversations/:id/reply', async (req, reply) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const id = conversationId(req);
    const text = String(((req.body ?? {}) as Record<string, unknown>).text ?? '');
    try {
      const r = await support.sendStaffReply(id, text, req.principal.userId ?? null);
      await writeAudit({
        orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action: 'whatsapp.support_reply', targetType: 'whatsapp_conversation', targetId: id, ip: req.ip,
        after: { ok: r.ok, length: text.trim().length, ...(r.ok ? {} : { error: r.error?.slice(0, 200) }) },
      });
      return r.ok ? r : reply.status(502).send({ error: r.error });
    } catch (e) { return failed(reply, e); }
  });

  app.post('/v1/whatsapp/conversations/:id/handler', async (req, reply) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const id = conversationId(req);
    const handler = String(((req.body ?? {}) as Record<string, unknown>).handler ?? '');
    if (!(HANDLERS as readonly string[]).includes(handler)) throw bad(`handler must be one of ${HANDLERS.join(', ')}`);
    try {
      const c = await support.setHandler(id, handler as support.Handler);
      await writeAudit({ orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action: 'whatsapp.support_handler', targetType: 'whatsapp_conversation', targetId: id, ip: req.ip, after: { handler } });
      return { conversation: c };
    } catch (e) { return failed(reply, e); }
  });

  app.post('/v1/whatsapp/conversations/:id/suggest', async (req, reply) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const id = conversationId(req);
    const d = suggestBuckets.take(req.principal.userId ?? req.ip, SUGGEST_PER_MIN);
    if (!d.allowed) return reply.status(429).header('Retry-After', d.retryAfterS).send({ error: `At most ${SUGGEST_PER_MIN} suggestions a minute.` });
    try { return await support.suggest(id); } catch (e) { return failed(reply, e); }
  });
}
