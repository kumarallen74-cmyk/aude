# Support desk (v1.45.0)

One place for what drivers report, whichever way they write. It is under **Operate → Support**. Reading cases needs
`session:read`; answering them and changing the settings needs `session:write`.

Switch it on in **Settings**. While it is off, drivers cannot report a problem in the app, and e-mail and WhatsApp do
not open cases.

## Where cases come from

| Channel | How a case opens | Where replies go |
| --- | --- | --- |
| **App** | The driver taps *Laporkan masalah* on a receipt. The case is linked to that charge's session, charger, site and payment. | Into the app, with a push notification. The driver sees them under Account → *Laporan saya*. |
| **E-mail** | Your e-mail provider forwards the support address to the inbound webhook (below). A message whose subject carries a case's `[PS-n]` tag, from that case's own customer, is added to the case and reopens it. Anything else opens a new case. Quoted earlier messages are cut off. | Through your e-mail channel (Governance → Alert routing → Channels), with `[PS-n]` in the subject. |
| **WhatsApp** | When the WhatsApp assistant hands a conversation to staff, a case opens for the operator the driver last charged with. The case shows the chat. | Back on WhatsApp, within WhatsApp's 24-hour window. |
| **Staff** | *New case*, for a phone call or a walk-in. | Recorded on the case. |

### The inbound e-mail webhook

1. In Settings, create a key. It is shown once.
2. Have the provider post each message as JSON `{from, fromName, subject, text}` to:

   `https://<console>/v1/support/inbound-email/<key>`

Most providers can do this (Mailgun routes, SendGrid Inbound Parse, Postmark inbound, Cloudflare Email Workers), some
through a small mapping step. Replacing the key stops the old one at once.

## SLA

Each priority has two times: one to the first answer and one to resolution. They are set in Settings, in minutes. The
defaults:

| Priority | First answer | Resolution |
| --- | --- | --- |
| urgent | 30 min | 4 h |
| high | 1 h | 8 h |
| normal | 4 h | 24 h |
| low | 24 h | 72 h |

Changing a case's priority moves its due times, counted from when the case was opened.

A case past either time is marked *past SLA* once and raises **support.sla_breach**. The alert is critical for urgent
and high cases. Route it under Governance → Alert routing. It resolves when the case is resolved.

## Working a case

- **Fields:** status (open, waiting on customer, resolved, closed), priority, category and who it is assigned to.
- **About tab:** the session (energy, total, payment and refund state) and the customer's other cases.
- **Macros:** saved replies. `{{name}}`, `{{number}}`, `{{charger}}` and `{{site}}` are filled in. A macro can also set
  the status, for example *resolved*.
- **Internal notes:** kept on the case and never sent.
- **Rating:** once a case is resolved, the driver can rate it from 1 to 5 in the app. A message from the driver reopens
  it.
- **Category:** a first guess is made from the words in the message (refund, charger fault, payment, account, charging).

## Figures

The page shows active, new and unassigned cases, cases past SLA, the median first answer and satisfaction over 30 days.
`GET /v1/support/stats` adds figures by channel and category.

## Limits

- Drivers: 5 reports an hour.
- WhatsApp: replies only within its 24-hour window.
