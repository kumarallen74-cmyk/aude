# @plugsure/csms-sdk

A TypeScript client for the PlugSure CSMS operator API, generated from its OpenAPI document.

- It has no dependencies. It runs on Node 18 or later, Deno, Bun and browsers.
- It covers every operation in the API reference (`/api-docs.html`), with one typed method each.

## Install

Download the package from your installation (Govern → Developers, or `https://<your console>/sdk/plugsure-csms-sdk.tgz`), then:

```bash
npm install ./plugsure-csms-sdk.tgz
```

## Use

```ts
import { PlugSure, PlugSureError } from '@plugsure/csms-sdk';

const plugsure = new PlugSure({
  apiKey: process.env.PLUGSURE_API_KEY!, // psk_… from Govern → API keys (or a sandbox key)
  baseUrl: 'https://api.example.id',
});

const chargers = await plugsure.listChargePoints();
const cp = await plugsure.getChargePoint({ identity: 'AUTEL-DC60-SMB-002' });
const sessions = await plugsure.listChargingSessions({ query: { from: '2026-09-01T00:00:00Z', limit: 100 } });
await plugsure.startSessionRemotely({ identity: cp.ocpp_identity, body: { connectorId: 1, idTag: 'FLEET-0042' } });

try {
  await plugsure.getChargePoint({ identity: 'NOPE' });
} catch (e) {
  if (e instanceof PlugSureError && e.status === 404) { /* not found */ }
}
```

- **Method names** are the operation ids in the API reference.
- **Arguments** go in one object:
  - path parameters by name;
  - `query: {…}` for query parameters;
  - `body` for the request body.
- **Return values:**
  - JSON answers are returned parsed;
  - CSV, XML and HTML come back as a string;
  - PDFs and files come back as an `ArrayBuffer`;
  - event streams come back as the raw `Response`.
- **Errors** are thrown as `PlugSureError`, with:
  - `status` (0 when there was no answer);
  - `code`, where the API gives one (e.g. `rate_limited`, `charger_offline`);
  - `body`, the parsed error.

## Rate limits

Each API key has its own limit, in requests a minute:
- the installation default is 600;
- an administrator can set a different limit per key under Govern → API keys.

It works as a token bucket: a key may send its whole minute's allowance at once, then refills steadily.

- **Refused requests:** when a request is refused (429), the SDK waits as long as the API asks (`Retry-After`) and sends it again, up to `maxRetries` times (default 2). A wait longer than `maxRetryWaitS` (default 60) is thrown instead.
- **Failed reads:** reads (GET) that fail with 502, 503 or 504, or with a network error, are retried too, with back-off.
- **Checking the allowance:** `plugsure.rateLimit` gives `{ limit, remaining, resetS }` from the last answer. Use it to slow down before being refused.

```ts
const plugsure = new PlugSure({ apiKey, baseUrl, maxRetries: 5, timeoutMs: 15_000 });
```

## Webhooks

Verify every delivery against the raw body before trusting it.
- `parseWebhook` throws `WebhookSignatureError` for a missing, wrong or old signature (5 minutes by default).
- Deliveries can arrive more than once: deduplicate on `event.id`.

```ts
import { parseWebhook } from '@plugsure/csms-sdk';

app.post('/plugsure-hooks', express.raw({ type: 'application/json' }), async (req, res) => {
  const event = await parseWebhook({
    secret: process.env.PLUGSURE_WEBHOOK_SECRET!,
    signature: req.header('PlugSure-Signature'),
    body: req.body, // the raw bytes
  });
  if (event.type === 'session.ended') console.log(event.data.sessionId, event.data.energyWh);
  res.sendStatus(204);
});
```

## Versions

The SDK's version is the API's (`API_VERSION`). It is regenerated with the API: `npm run openapi && npm run sdk` in the PlugSure repository.
