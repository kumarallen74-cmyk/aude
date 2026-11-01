import { type Op, type Schema, ref, arrayOf, nullable } from '../types.js';

/**
 * Governance → WhatsApp (v1.10.0): src/api/whatsapp-routes.ts. The platform's WhatsApp Business Account — the one the
 * sign-in codes integration (WhatsApp Cloud API) sends from — so every route needs platform:admin. The public Meta webhook (/hooks/whatsapp-cloud/<key>) is not a /v1 route.
 * (v1.11.0) The support inbox: customers' messages to that number, answered by the AI assistant (Claude) or by staff.
 */

const T = 'WhatsApp' as const;
const DT = { type: 'string', format: 'date-time' };
const PURPOSE = { type: 'string', enum: ['otp', 'alert', 'test', 'other', 'support'] };
const HANDLER = { type: 'string', enum: ['ai', 'human', 'closed'], description: 'Who answers: the AI assistant, staff, or nobody (closed; a new customer message reopens it with the assistant).' };
const STATUS = { type: 'string', enum: ['accepted', 'sent', 'delivered', 'read', 'failed'] };
const count: Schema = { type: 'integer', minimum: 0 };

export const schemas: Record<string, Schema> = {
  WhatsAppMessage: {
    type: 'object',
    description: 'One message sent from the platform\'s number: a sign-in code or a test send, or an operator alert from an alert channel on the same number. The number is masked; codes are never stored.',
    required: ['id', 'at', 'purpose', 'to', 'status'],
    properties: {
      id: { type: 'string', description: '`m<n>` for the ledger, `a<n>` for an alert notification.' },
      at: DT, purpose: PURPOSE, to: { type: 'string', description: 'Masked, e.g. +6281****890.' },
      template: nullable('string'), language: nullable('string'), status: { ...STATUS, description: 'accepted: WhatsApp took it, no status report yet.' },
      errorCode: nullable('string'), error: nullable('string', { description: 'Why it failed (Meta\'s title, code and details).' }),
      sentAt: nullable('string', { format: 'date-time' }), deliveredAt: nullable('string', { format: 'date-time' }), readAt: nullable('string', { format: 'date-time' }),
      pricingCategory: nullable('string', { description: 'From Meta\'s status: authentication, utility, marketing, service…' }),
      billable: { type: ['boolean', 'null'] },
    },
  },
  WhatsAppConversation: {
    type: 'object',
    description: 'A customer writing to the platform\'s WhatsApp number (one conversation per number). The number is masked.',
    required: ['id', 'phone', 'handler', 'lastMessageAt', 'windowOpen', 'unread'],
    properties: {
      id: { type: 'string', format: 'uuid' }, phone: { type: 'string', description: 'Masked, e.g. +6281****890.' },
      name: nullable('string', { description: 'The WhatsApp profile name the customer chose.' }),
      hasAccount: { type: 'boolean', description: 'A PlugSure driver account is registered on the number (the assistant can look up its sessions).' },
      handler: HANDLER, handoffReason: nullable('string', { description: 'Why it went to staff.' }),
      draft: nullable('string', { description: 'The assistant\'s suggested reply (mode draft, or a suggestion asked for).' }),
      lastMessage: nullable('string'), lastAuthor: nullable('string', { description: 'customer, ai or staff.' }), lastMessageAt: DT,
      lastInboundAt: nullable('string', { format: 'date-time' }),
      windowOpen: { type: 'boolean', description: 'Within 24 hours of the customer\'s last message: free-form replies are allowed (Meta\'s customer service window).' },
      unread: count,
    },
  },
  WhatsAppChatMessage: {
    type: 'object', required: ['id', 'direction', 'author', 'body', 'at'],
    properties: {
      id: { type: 'string' }, direction: { type: 'string', enum: ['in', 'out'] }, author: { type: 'string', enum: ['customer', 'ai', 'staff', 'system'] },
      body: { type: 'string', description: 'Text; media is named ("[image: caption]"), not kept. system: a note (handover, an assistant failure).' },
      at: DT, status: nullable('string', { description: 'A reply\'s delivery status: accepted, sent, delivered, read or failed.' }), error: nullable('string'),
      model: nullable('string', { description: 'The Claude model that wrote an AI reply.' }),
      tokens: { type: ['object', 'null'], properties: { input: count, output: count } },
    },
  },
  WhatsAppTemplate: {
    type: 'object', required: ['name', 'status', 'language'],
    properties: {
      name: { type: 'string' }, status: { type: 'string', description: 'APPROVED, PENDING, REJECTED, PAUSED, DISABLED…' }, category: nullable('string'), language: { type: 'string' },
      qualityScore: nullable('string', { description: 'GREEN, YELLOW, RED or UNKNOWN.' }), rejectedReason: nullable('string'),
      required: { type: 'boolean', description: 'PlugSure sends it (the sign-in code template, an alert channel\'s template).' },
    },
  },
  WhatsAppRequiredTemplate: {
    type: 'object', required: ['name', 'language', 'purpose', 'inUse'],
    properties: {
      name: { type: 'string' }, language: { type: 'string' }, purpose: { type: 'string', enum: ['otp', 'alert'] },
      inUse: { type: 'boolean', description: 'False for the default alert template when no alert channel sends from this number yet.' },
      status: nullable('string', { description: 'Its status at Meta; MISSING when the WABA has no such template; null when the templates could not be read.' }),
      category: nullable('string'),
    },
  },
};

const daily: Schema = arrayOf({ type: 'object', required: ['day', 'sent', 'delivered', 'read', 'failed'], properties: { day: { type: 'string', format: 'date' }, sent: count, delivered: count, read: count, failed: count } });

export const ops: Op[] = [
  {
    method: 'GET', path: '/v1/whatsapp/overview', tag: T, summary: 'WhatsApp Business dashboard',
    description:
      'The connection: the platform\'s sign-in codes integration on the WhatsApp Cloud API (main channel, else fallback), read from the Graph API (display number, verified name, quality rating, messaging limit tier, name status; a Graph API failure is `connection.error`, never an error status), ' +
      'the webhook (URL and verify token for the Meta app, the fields to subscribe, when it last delivered an event and a status), the templates PlugSure needs with their status, ' +
      'and statistics for the last 7 or 30 days in the platform time zone (ALERT_TIMEZONE): the ledger plus the operator alerts sent from the same number. ' +
      'Each message counts once at its latest status; `sent` in `daily` includes accepted. deliveryRate = (delivered + read) / total; readRate = read / (delivered + read).',
    query: [{ name: 'days', schema: { type: 'integer', enum: [7, 30], default: 7 } }],
    responses: { 200: { description: 'The dashboard', schema: { type: 'object', required: ['configured', 'connection', 'webhook', 'requiredTemplates', 'stats', 'recentFailures'], properties: {
      configured: { type: 'boolean' },
      connection: { type: ['object', 'null'], properties: {
        source: { type: 'string', enum: ['otp', 'otp_fallback'], description: 'The sign-in codes integration the credentials come from: the main channel, else the fallback.' },
        wabaId: nullable('string', { description: 'Null when not saved on the integration: no templates then.' }), phoneNumberId: { type: 'string' }, displayPhoneNumber: nullable('string'), verifiedName: nullable('string'),
        qualityRating: nullable('string', { description: 'GREEN, YELLOW, RED or UNKNOWN.' }), messagingLimitTier: nullable('string'), nameStatus: nullable('string'), status: nullable('string'),
        checkedAt: DT, error: nullable('string'),
      } },
      webhook: { type: ['object', 'null'], properties: {
        url: nullable('string', { description: 'Null until the sign-in codes integration is saved once on 1.10.0 (that issues the key).' }),
        hasAppSecret: { type: 'boolean', description: 'False: Meta\'s calls are refused (403) until the app secret is saved.' }, verifyToken: nullable('string'), fields: arrayOf({ type: 'string' }),
        lastEventAt: nullable('string', { format: 'date-time' }), lastStatusAt: nullable('string', { format: 'date-time' }),
      } },
      requiredTemplates: arrayOf(ref('WhatsAppRequiredTemplate')),
      stats: { type: 'object', required: ['days', 'total', 'byStatus', 'byPurpose', 'daily'], properties: {
        days: { type: 'integer' }, total: count,
        byStatus: { type: 'object', properties: { accepted: count, sent: count, delivered: count, read: count, failed: count } },
        byPurpose: { type: 'object', properties: { otp: count, alert: count, test: count, other: count, support: count } },
        deliveryRate: { type: ['number', 'null'] }, readRate: { type: ['number', 'null'] }, daily,
      } },
      recentFailures: arrayOf(ref('WhatsAppMessage')),
      support: { type: 'object', description: '(v1.11.0) The support inbox over the same days.', properties: {
        configured: { type: 'boolean', description: 'The WhatsApp AI support integration has an API key.' }, mode: nullable('string', { enum: ['auto', 'draft', 'off', null] }), model: nullable('string'),
        conversations: count, waitingForStaff: count, aiReplies: count, staffReplies: count, handoffs: count, aiTokens: count,
      } },
    } } } },
    errors: [400],
  },
  {
    method: 'GET', path: '/v1/whatsapp/templates', tag: T, summary: 'WhatsApp message templates',
    description: 'The WhatsApp Business Account\'s templates (up to 500), the ones PlugSure sends marked, and a link to WhatsApp Manager. 409 when WhatsApp is not configured, or no WhatsApp Business Account ID is saved (`code: no_waba`); 502 with Meta\'s message when the Graph API refuses.',
    responses: { 200: { description: 'Templates', schema: { type: 'object', required: ['templates', 'required', 'managerUrl'], properties: {
      templates: arrayOf(ref('WhatsAppTemplate')), required: arrayOf(ref('WhatsAppRequiredTemplate')), managerUrl: { type: 'string' },
    } } } },
    errors: [409, 502],
  },
  {
    method: 'GET', path: '/v1/whatsapp/messages', tag: T, summary: 'WhatsApp messages',
    description: 'Newest first: the ledger and the WhatsApp alerts sent from the same number, numbers masked. Kept 180 days. Page with `before` = the `nextBefore` of the previous page.',
    query: [
      { name: 'purpose', schema: PURPOSE }, { name: 'status', schema: STATUS },
      { name: 'before', schema: DT, description: 'Only messages before this time.' },
      { name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    ],
    responses: { 200: { description: 'Messages', schema: { type: 'object', required: ['messages', 'nextBefore'], properties: { messages: arrayOf(ref('WhatsAppMessage')), nextBefore: nullable('string', { format: 'date-time' }) } } } },
    errors: [400],
  },
  {
    method: 'GET', path: '/v1/whatsapp/events', tag: T, summary: 'WhatsApp account events',
    description: 'From the webhook: template status and quality changes, number quality, account updates (payloads trimmed). The last 500, at most 90 days.',
    query: [{ name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }],
    responses: { 200: { description: 'Events', schema: { type: 'object', required: ['events'], properties: { events: arrayOf({ type: 'object', required: ['id', 'field', 'createdAt'], properties: { id: { type: 'string' }, field: { type: 'string' }, event: nullable('string'), payload: { type: 'object' }, createdAt: DT } }) } } } },
    errors: [400],
  },
  {
    method: 'POST', path: '/v1/whatsapp/test', tag: T, summary: 'Send a WhatsApp test message',
    description: 'Sends one approved template with the sign-in codes integration\'s credentials (recorded with purpose test). `params` fill the body variables in order; `copyCodeButton` repeats the first one for an Authentication template\'s copy-code button. At most 5 a minute per administrator. Audited as whatsapp.test_sent (number masked).',
    body: { required: true, schema: { type: 'object', required: ['phone', 'template', 'language'], properties: {
      phone: { type: 'string', description: 'A mobile number in Indonesia, Malaysia or Singapore.' }, template: { type: 'string', pattern: '^[a-z0-9_]{1,512}$' }, language: { type: 'string', examples: ['id', 'en_US'] },
      params: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 1024 } }, copyCodeButton: { type: 'boolean', default: false },
    } }, example: { phone: '081234567890', template: 'plugsure_alert', language: 'id', params: ['Test', 'PlugSure test message'] } },
    responses: { 200: { description: 'Sent, or Meta\'s reason it was not', schema: { type: 'object', required: ['ok', 'to'], properties: { ok: { type: 'boolean' }, messageId: { type: 'string' }, error: { type: 'string' }, to: { type: 'string' } } } } },
    errors: [409, 422],
  },
  {
    method: 'GET', path: '/v1/whatsapp/conversations', tag: T, summary: 'WhatsApp support inbox',
    description: 'Customers who wrote to the platform\'s WhatsApp number, newest first, with the last message. Filter by `handler`; page with `before` = the `nextBefore` of the previous page. `assistant` says whether the AI support integration is set up and its mode. Messages are kept 90 days.',
    query: [
      { name: 'handler', schema: HANDLER }, { name: 'before', schema: DT, description: 'Only conversations last active before this time.' },
      { name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    ],
    responses: { 200: { description: 'Conversations', schema: { type: 'object', required: ['conversations', 'nextBefore', 'assistant'], properties: {
      conversations: arrayOf(ref('WhatsAppConversation')), nextBefore: nullable('string', { format: 'date-time' }),
      assistant: { type: 'object', properties: { configured: { type: 'boolean' }, mode: nullable('string', { enum: ['auto', 'draft', 'off', null] }) } },
    } } } },
    errors: [400],
  },
  {
    method: 'GET', path: '/v1/whatsapp/conversations/:id', tag: T, summary: 'One WhatsApp support conversation',
    description: 'The conversation and its last 200 messages, oldest first, with each reply\'s delivery status. Opening it marks it read.',
    pathParams: { id: 'The conversation id.' },
    responses: { 200: { description: 'The conversation', schema: { type: 'object', required: ['conversation', 'messages'], properties: { conversation: ref('WhatsAppConversation'), messages: arrayOf(ref('WhatsAppChatMessage')) } } } },
    errors: [404],
  },
  {
    method: 'POST', path: '/v1/whatsapp/conversations/:id/reply', tag: T, summary: 'Reply to a WhatsApp customer',
    description: 'Sends a free-form text from the platform\'s number. Allowed within 24 hours of the customer\'s last message only (409 otherwise: WhatsApp then takes approved templates only). Staff take the conversation over (handler human; the assistant stops), except in draft mode when the assistant has it: sending its drafts keeps it drafting. 502 with Meta\'s reason when the send fails. Audited as whatsapp.support_reply.',
    pathParams: { id: 'The conversation id.' },
    body: { required: true, schema: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 4096 } } }, example: { text: 'Halo, kami sudah memproses refund Anda.' } },
    responses: { 200: { description: 'Sent', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } } },
    errors: [404, 409, 422, 502],
  },
  {
    method: 'POST', path: '/v1/whatsapp/conversations/:id/handler', tag: T, summary: 'Hand a WhatsApp conversation over',
    description: '`ai`: back to the assistant (it answers a customer message still unanswered); `human`: staff take over; `closed`: nothing pending. Audited as whatsapp.support_handler.',
    pathParams: { id: 'The conversation id.' },
    body: { required: true, schema: { type: 'object', required: ['handler'], properties: { handler: HANDLER } }, example: { handler: 'human' } },
    responses: { 200: { description: 'The conversation', schema: { type: 'object', required: ['conversation'], properties: { conversation: ref('WhatsAppConversation') } } } },
    errors: [400, 404],
  },
  {
    method: 'POST', path: '/v1/whatsapp/conversations/:id/suggest', tag: T, summary: 'Suggest a WhatsApp reply',
    description: 'Asks the assistant (Claude) for a reply to the conversation as it stands, whoever handles it, and keeps it as the draft; nothing is sent. `handoff` is set when the assistant would rather a person answered. 409 when the AI support integration is not set up; 502 when the Anthropic API fails. At most 10 a minute per administrator.',
    pathParams: { id: 'The conversation id.' },
    responses: { 200: { description: 'The suggestion', schema: { type: 'object', required: ['draft', 'handoff'], properties: { draft: nullable('string'), handoff: nullable('string') } } } },
    errors: [404, 409, 502],
  },
];
