# PlugSure CSMS v1.11.0: release notes

**Date:** 31 October 2026
**Base:** v1.10.0.

v1.11.0 adds **WhatsApp customer support**. Customers who write to PlugSure's WhatsApp number (the sign-in codes number) arrive in an **inbox** in the console. An **AI assistant, Claude** (Anthropic API), answers them or drafts answers for staff. It hands over to staff for anything it cannot do.

- **Migration:** one, 079 (additive).
- **Nothing changes until it is set up.** Without the new integration, messages simply land in the inbox for staff.
- **Setup:** `deploy/WHATSAPP.md` §3.

## New

### Inbox (Operate → WhatsApp → Inbox)

Platform administrators only, like the rest of the WhatsApp dashboard.

- **Conversations:** one per customer number, newest first, filtered by who answers: the assistant (AI), staff, or closed. Each shows the customer's WhatsApp name, the masked number, whether a PlugSure account is registered on it, and unread messages.
- **Thread:** the messages both ways, with each reply's delivery status (from Meta's webhook) and, for AI replies, the model and tokens.
- **Actions:**
  - **Send** a reply. Staff take the conversation over and the assistant stops, except in draft mode, where sending its draft keeps it drafting.
  - **Suggest reply**: Claude drafts one on demand.
  - **Hand to AI**, **Take over**, **Close**. A closed conversation reopens with the assistant when the customer writes again.
- **24-hour window:** WhatsApp allows free-form replies only within 24 hours of the customer's last message. Outside it, sending is refused with an explanation.
- **Refresh:** the inbox updates every 10 seconds while open.
- **Overview tab:** four new figures for the period:
  - support conversations;
  - conversations waiting for staff;
  - AI replies, with tokens;
  - handovers to staff.

### WhatsApp AI support (Govern → Integrations)

A new integration, provider **Claude (Anthropic API)**.

| Setting | |
|---|---|
| Anthropic API key | Sealed like every secret. |
| Replies | **Drafts** (the default: Claude writes, staff check and send), **Automatic**, or **Off**. |
| Model | Claude Opus 5.5 (default), Sonnet 5.5 or Haiku 5.5. |
| What Claude should know | Up to 20,000 characters: support hours, payment and refund policy, links, troubleshooting. |
| Advanced | Effort, the assistant's name, the handover message, reply limits (per customer per hour, default 15; all customers per 24 hours, default 1,000). |

**Test** checks the key and model with one tiny request.

**What the assistant does:**

- **Language and style:** it replies in the customer's language (Bahasa Indonesia by default), briefly.
- **Lookups:** four read-only tools:
  - stations by name or area, or nearest to a shared location, with free chargers and price;
  - one charger's live status;
  - the last sessions and payments of the account registered on **the writer's own number**;
  - a handover to staff.
- **No changes:** it cannot change anything (refunds, charges, accounts). It never asks for codes, PINs or card numbers.
- **Hands to staff** when the customer needs something it cannot do, asks for a person, the reply limits are reached, or Anthropic declines the request. The customer gets the handover message.
- **Refusal fallback:** on Opus and Sonnet, a declined request is re-run on Anthropic's recommended fallback model (`fallbacks: "default"`) first.
- **Errors:** an API error (bad key, rate limit) becomes a note in the conversation. The customer gets no broken reply.

**Operator alert** `platform.whatsapp_support` (*WhatsApp customer waiting for staff*):

- **Raised** when a conversation is handed over, when a draft waits for staff, or when a message arrives that no assistant answers.
- **Resolved** by a staff reply or by handing the conversation back to the assistant.
- **Recipients:** the same organisations as the other platform alerts.

### API

New routes, all `platform:admin`, in the OpenAPI document under *WhatsApp* (333 operations):

```
GET  /v1/whatsapp/conversations
GET  /v1/whatsapp/conversations/:id
POST /v1/whatsapp/conversations/:id/reply
POST /v1/whatsapp/conversations/:id/handler
POST /v1/whatsapp/conversations/:id/suggest
```

- **Audit:** staff replies and handovers are audited as `whatsapp.support_reply` and `whatsapp.support_handler`.
- **Overview:** `/v1/whatsapp/overview` gains `support`.
- **Ledger:** gains the purpose `support`.

### Dependency

`@anthropic-ai/sdk` 1.3.0. It is used only by the AI support integration, and only with the key saved there, never with environment credentials.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **079**:
   - the conversations and their messages;
   - the `ai_support` integration kind;
   - the ledger purpose `support`.

   It is additive and instant.
2. In the Meta app, check that the webhook field **`messages`** is subscribed. It is in the v1.10.0 setup.
3. To use Claude, follow `deploy/WHATSAPP.md` §3:
   1. Create an API key at platform.claude.com.
   2. Connect **WhatsApp AI support** in Integrations, starting in **Drafts** mode.
4. Add to plugsure.com/privacy.html that support messages are kept 90 days and, with the AI assistant on, are processed by Anthropic to write replies.

**Rollback:** roll the code back to v1.10.0, then run `db/rollback/079_down.sql`. This drops the conversations and the AI support integration.

## Privacy

- **Numbers:** the customer's number is stored **sealed** (`SECRETS_KEY`) and as an HMAC to find the conversation, because a reply needs it. It is shown masked.
- **Messages:** kept as text for **90 days**. Media is noted ("[image: caption]"), not downloaded.
- **Sent to Anthropic:** with the assistant on, a conversation's last 24 hours (at most 40 messages) go to Anthropic for each reply.
- **Own data only:** the session lookup only reads the account registered on the number that writes.

## Verification

- **Server:**
  - typecheck clean;
  - unit and database tests passing, with 10 new ones against a stand-in for the Anthropic API and Meta's Graph API.
- **What the new tests cover:**
  - storing and de-duplicating messages;
  - the request to Claude: instructions, cached knowledge, tools, fallback opt-in;
  - tool calls and results;
  - the handover by tool, by refusal and by reply limit, with its alert;
  - draft mode, suggestions;
  - API errors;
  - staff replies and the 24-hour window;
  - handler switches, permissions, retention.
- **Migration 079:** applies cleanly.
- **Console:** the inbox, the overview figures and the integration form, rendered in light and dark mode and at phone width.
