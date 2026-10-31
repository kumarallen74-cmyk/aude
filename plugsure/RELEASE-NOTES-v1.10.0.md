# PlugSure CSMS v1.10.0: release notes

**Date:** 31 October 2026
**Base:** v1.9.2.

v1.10.0 adds a **WhatsApp dashboard** to the operator console, and **delivery tracking** for the WhatsApp messages PlugSure sends: drivers' sign-in codes, and operator alerts. It uses the WhatsApp configuration that already exists (Integrations → Driver sign-in codes → WhatsApp (Meta Cloud API)): there is no second place to enter WhatsApp credentials.

One migration (078, additive). Nothing changes until the WhatsApp integration is given the two new optional fields and Meta's webhook is set up (`deploy/WHATSAPP.md`).

## New

### WhatsApp dashboard (Operate → WhatsApp)

It sits directly under Dashboard in the menu and is visible to **platform administrators** only, because the WhatsApp Business Account is PlugSure's and its log spans every operator's drivers.

| Tab | What it shows |
|---|---|
| **Overview** | Connection health read live from Meta: the number, its verified name, quality rating (green / yellow / red), messaging limit and display-name status. Messages sent, delivered, read and failed over 7 or 30 days, with a daily chart, the templates PlugSure needs and their approval status, and the latest failures with Meta's reason. |
| **Templates** | Every template on the account with category, language, approval status, quality and rejection reason; the ones PlugSure uses are flagged. |
| **Messages** | The delivery log (sign-in codes, alerts, tests), filtered by purpose and status. Phone numbers are masked; codes are never stored. |
| **Setup** | The webhook URL and verify token to paste into the Meta app, the webhook fields to subscribe, and a test send of any approved template (at most 5 a minute, audited). |

### Delivery tracking

- **New fields:** the sign-in codes integration's WhatsApp provider gets two optional fields:
  - **WhatsApp Business Account ID** (templates and account status);
  - **App secret** (verifies Meta's callbacks).
- **Webhook:** saving it issues a webhook at `/hooks/whatsapp-cloud/<key>` with its own verify token.
- **Statuses:** sent, delivered, read and failed are recorded for every sign-in code. Before, PlugSure only knew a code had been handed to Meta.
- **Alerts on the same app:** WhatsApp alerts sent from the same Meta app get their delivery status through this webhook too, because a Meta app has a single callback URL. A failed alert still falls back to SMS. The per-channel alert webhook (`/hooks/whatsapp/<key>`) is unchanged.
- **Late statuses** never downgrade a message: a late "delivered" does not replace "read".

### Operator alerts from Meta's events

| Alert | When | Resolves when |
|---|---|---|
| `platform.whatsapp_template` | A template is paused, disabled, rejected or flagged, or its quality turns red. It is **critical** for the sign-in template, since drivers then cannot sign in. | The template is approved or reinstated |
| `platform.whatsapp_quality` | The number is flagged or downgraded | The number is unflagged or upgraded |
| `platform.whatsapp_account` | An account restriction or violation (critical) | — |

These alerts go to the same organisations as the other platform alerts.

## Upgrading

1. Deploy and run `npm run migrate` (applies **078**: the message log and Meta's events; additive, instant).
2. Follow `deploy/WHATSAPP.md`:
   1. In the console, open Integrations → Driver sign-in codes → WhatsApp (Meta Cloud API). Add the **WhatsApp Business Account ID** and the **App secret**, then save. The webhook URL and verify token appear.
   2. In the Meta app, open WhatsApp → Configuration → Webhook. Paste the URL and token, verify, and subscribe `messages`, `message_template_status_update`, `phone_number_quality_update` and `account_update`.
3. `/hooks/*` must be reachable from the internet. The shipped Caddyfile already routes it on the OCPP host. `PUBLIC_BASE_URL` decides the URL shown.

**Rollback:** run `db/rollback/078_down.sql` and redeploy v1.9.2. The integration keeps its extra fields, which v1.9.2 ignores.

## Privacy

- **Masked numbers:** the log keeps masked numbers only, never a sign-in code.
- **Retention:** messages are deleted after 180 days; Meta's account events after 90 days, at most the last 500.
- **Incoming messages** from customers are not stored.

## Verification

- **Server:** typecheck clean; 1,493 unit and database tests passing, 18 of them new. Among the new tests:
  - the webhook handshake and signature;
  - out-of-order statuses;
  - alert delivery and the SMS fallback;
  - template and quality alerts;
  - masking;
  - permissions and retention.
- **Migration 078:** applies, rolls back and re-applies cleanly.
- **Console:** rendered against a stand-in for Meta's Graph API with a week of messages, in light and dark mode and at phone width.
