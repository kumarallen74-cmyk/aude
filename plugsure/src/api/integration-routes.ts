import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { limitParam } from './paging.js';
import { assertCan, assertCanAny, can } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import { config } from '../config.js';
import { one, outsideRequestScope } from '../db/pool.js';
import { kindDef, type Kind } from '../integrations/catalogue.js';
import * as store from '../integrations/store.js';
import { testOtp } from '../integrations/otp.js';
import { whatsappWebhookVerify, whatsappStatusWebhook } from '../services/alert-routing.js';
import { handleNotification, providerFor, sandboxCheckout, sandboxSettle, sandboxProvider } from '../services/payments/registry.js';
import { CHANNEL_LABEL, type Channel } from '../services/payments/provider.js';
import { normalisePhone } from '../driver/identity.js';
import { providerFetch } from '../services/payments/provider.js';

/**
 * Govern → Integrations: the third parties PlugSure talks to.
 *
 *   view                      org:read
 *   the operator's own        org:write     (QRIS payments: its own merchant account)
 *   the platform's            platform:admin (sign-in codes, PKI, map tiles, default QRIS)
 *
 * Secrets are write-only: the console gets a hint (last characters) and
 * sends a secret again only to change it. Every change is audited, without
 * secret values.
 *
 * Also the public payment webhook: POST /pay/notify/<key>, one URL per QRIS
 * account, verified with that account's secret. Expose /pay/* publicly
 * (deploy/Caddyfile).
 */
export async function registerIntegrationRoutes(app: FastifyInstance): Promise<void> {
  const org = (req: FastifyRequest) => req.principal.orgId;
  const isPlatform = (req: FastifyRequest) => can(req.principal, { permission: 'platform:admin' });
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof store.IntegrationError) return reply.status(e.statusCode).send({ error: e.message });
    throw e;
  };
  const publicBase = (req: FastifyRequest) => config.console.publicBaseUrl || `${req.protocol}://${req.headers.host ?? 'localhost'}`;

  /** Which row a request addresses, after checking the caller may touch it. */
  const target = (req: FastifyRequest, kind: string, scopeRaw: unknown): { kind: Kind; orgId: string | null } => {
    const def = kindDef(kind);
    if (!def) throw new store.IntegrationError(404, 'unknown integration');
    const scope = scopeRaw === 'platform' || def.scope === 'platform' ? 'platform' : 'org';
    if (scope === 'platform') assertCan(req.principal, { permission: 'platform:admin' });
    else assertCan(req.principal, { permission: 'org:write' });
    return { kind: def.kind, orgId: scope === 'platform' ? null : org(req) };
  };

  app.get('/v1/integrations', async (req) => {
    assertCanAny(req.principal, 'org:read');
    const o = await store.overview(org(req), isPlatform(req));
    const base = publicBase(req);
    for (const k of o.kinds as any[]) for (const v of [k.own, k.platform]) if (v?.webhookPath) v.webhookUrl = base + v.webhookPath;
    return { ...o, publicBaseUrl: base };
  });

  app.put('/v1/integrations/:kind', async (req, reply) => {
    const { kind } = req.params as { kind: string };
    const b = (req.body ?? {}) as any;
    try {
      const t = target(req, kind, b.scope);
      const saved = await store.save(t.kind, t.orgId, { provider: b.provider, settings: b.settings ?? {}, secrets: b.secrets ?? {}, enabled: b.enabled }, req.principal.userId ?? null);
      await writeAudit({
        orgId: org(req), actorType: 'user', actorId: req.principal.userId, action: 'integration.updated', targetType: 'integration', targetId: `${t.kind}:${t.orgId ? 'org' : 'platform'}`, ip: req.ip,
        after: { provider: saved!.provider, scope: t.orgId ? 'org' : 'platform', enabled: saved!.enabled, secretsChanged: Object.keys(b.secrets ?? {}).filter((k) => String(b.secrets[k] ?? '').trim()) },
      });
      return { ...saved, webhookUrl: saved!.webhookPath ? publicBase(req) + saved!.webhookPath : null };
    } catch (e) { return fail(reply, e); }
  });

  app.delete('/v1/integrations/:kind', async (req, reply) => {
    const { kind } = req.params as { kind: string };
    try {
      const t = target(req, kind, (req.query as any)?.scope);
      const removed = await store.remove(t.kind, t.orgId);
      if (removed) await writeAudit({ orgId: org(req), actorType: 'user', actorId: req.principal.userId, action: 'integration.removed', targetType: 'integration', targetId: `${t.kind}:${t.orgId ? 'org' : 'platform'}`, ip: req.ip });
      return { removed };
    } catch (e) { return fail(reply, e); }
  });

  app.post('/v1/integrations/:kind/test', async (req, reply) => {
    const { kind } = req.params as { kind: string };
    const b = (req.body ?? {}) as any;
    try {
      const t = target(req, kind, b.scope);
      // The stored row for that scope, or what is in force when there is none.
      const row = await outsideRequestScope(() => one<{ id: string }>(`SELECT id FROM integration WHERE kind = $1 AND org_id IS NOT DISTINCT FROM $2::uuid AND archived_at IS NULL`, [t.kind, t.orgId]));
      const r = row ? await store.byId(row.id) : await store.resolve(t.kind, t.orgId);
      if (!r) return { ok: false, message: 'Nothing is configured to test.' };
      let result: { ok: boolean; message: string };
      try {
        result = await runTest(r, b);
      } catch (e) {
        result = { ok: false, message: (e as Error).message };
      }
      if (row) await store.recordTest(row.id, result.ok, result.message);
      await store.logEvent(r, t.orgId, 'test', result.ok ? 'ok' : 'failed', { message: result.message.slice(0, 300) });
      return result;
    } catch (e) { return fail(reply, e); }
  });

  app.get('/v1/integrations/:kind/events', async (req, reply) => {
    assertCanAny(req.principal, 'org:read');
    const { kind } = req.params as { kind: string };
    if (!kindDef(kind)) return reply.status(404).send({ error: 'unknown integration' });
    const limit = limitParam((req.query as any)?.limit, 50, 500);
    return { events: await store.events(kind as Kind, org(req), isPlatform(req), limit) };
  });

  // ---------------------------------------------------------------- public payment webhook

  await app.register(async (pub) => {
    // The signature covers the exact bytes the acquirer sent: keep the body raw.
    pub.addContentTypeParser(['application/json', 'text/plain', 'application/x-www-form-urlencoded'], { parseAs: 'string', bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));
    pub.post('/pay/notify/:key', async (req, reply) => {
      const { key } = req.params as { key: string };
      const raw = typeof req.body === 'string' ? req.body : '';
      const path = req.url.split('?')[0]!;
      const r = await handleNotification(key, raw, req.headers as Record<string, string | string[] | undefined>, path);
      return reply.status(r.status).send(r.body);
    });

    // WhatsApp delivery status (Meta webhook) for alert messages: GET is Meta's subscription check, POST the statuses.
    pub.get('/hooks/whatsapp/:key', async (req, reply) => {
      const { key } = req.params as { key: string };
      const q = (req.query ?? {}) as Record<string, string>;
      const echo = await whatsappWebhookVerify(key, String(q['hub.mode'] ?? ''), String(q['hub.verify_token'] ?? ''), String(q['hub.challenge'] ?? ''));
      return echo === null ? reply.status(403).send({ error: 'verification failed' }) : reply.type('text/plain').send(echo);
    });
    pub.post('/hooks/whatsapp/:key', async (req, reply) => {
      const { key } = req.params as { key: string };
      const r = await outsideRequestScope(() => whatsappStatusWebhook(key, typeof req.body === 'string' ? req.body : '', req.headers['x-hub-signature-256'] as string | undefined));
      return reply.status(r.status).send(r.body);
    });

    // The sandbox acquirer's test checkout page: stands in for the e-wallet app or
    // the hosted card page. Development only — it confirms payments without money.
    const back = (raw: unknown): string => {
      try { const u = new URL(String(raw ?? ''), 'http://x'); return u.pathname === '/app/paid.html' ? u.pathname + u.search : '/app/paid.html'; } catch { return '/app/paid.html'; }
    };
    // The sandbox e-wallet link approval (stands in for GoPay / OVO / DANA's own screen).
    pub.get('/pay/sandbox/link/:ref', async (req, reply) => {
      if (config.env === 'production') return reply.status(404).send({ error: 'not found' });
      const { ref } = req.params as { ref: string };
      const l = sandboxProvider().sandboxLinkInfo(ref);
      if (!l) return reply.status(404).send({ error: 'unknown sandbox link' });
      const q = `?return=${encodeURIComponent(back((req.query as any)?.return))}`;
      const label = CHANNEL_LABEL[l.channel] ?? l.channel;
      const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandbox · link ${esc(label)}</title>
<style>body{margin:0;background:#f3f5f4;color:#16211c;font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:#fff;border:1px solid #d9e0dc;border-radius:14px;padding:24px;max-width:380px;width:100%;box-sizing:border-box;display:grid;gap:14px}.tag{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#9a5b00;font-weight:600}
h1{font-size:20px;margin:0}p{margin:0;color:#5b6a63}.row{display:flex;gap:10px}form{flex:1}button{width:100%;padding:12px;border-radius:10px;border:1px solid #d9e0dc;background:#fff;font:inherit;font-weight:600;cursor:pointer}button.go{background:#0f7a4f;border-color:#0f7a4f;color:#fff}</style></head><body><main>
<div class="tag">Sandbox — no real e-wallet</div><h1>Hubungkan ${esc(label)}</h1><p>PlugSure meminta izin untuk menagih akun ${esc(label)} ${esc(l.phone.replace(/^(\+62)\d+(\d{4})$/, '$1 ••••$2'))} tanpa konfirmasi setiap kali.</p>
${l.status !== 'pending' ? `<p>This link is already <b>${esc(l.status)}</b>.</p>` : `<div class="row"><form method="post" action="/pay/sandbox/link/${esc(ref)}/deny${esc(q)}"><button type="submit">Tolak</button></form><form method="post" action="/pay/sandbox/link/${esc(ref)}/approve${esc(q)}"><button class="go" type="submit">Izinkan</button></form></div>`}
</main></body></html>`;
      return reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(html);
    });
    pub.post('/pay/sandbox/link/:ref/:outcome', async (req, reply) => {
      if (config.env === 'production') return reply.status(404).send({ error: 'not found' });
      const { ref, outcome } = req.params as { ref: string; outcome: string };
      if (outcome !== 'approve' && outcome !== 'deny') return reply.status(404).send({ error: 'not found' });
      const done = sandboxProvider().sandboxLink(ref, outcome === 'approve');
      if (String(req.headers.accept ?? '').includes('application/json')) return { ok: done };
      const ret = back((req.query as any)?.return);
      return reply.redirect(ret + (ret.includes('?') ? '&' : '?') + `status=${outcome === 'approve' ? 'linked' : 'cancelled'}`, 303);
    });

    pub.get('/pay/sandbox/:ref', async (req, reply) => {
      if (config.env === 'production') return reply.status(404).send({ error: 'not found' });
      const { ref } = req.params as { ref: string };
      const c = await sandboxCheckout(ref);
      if (!c) return reply.status(404).send({ error: 'unknown sandbox payment' });
      const ret = back((req.query as any)?.return);
      return reply.header('cache-control', 'no-store')
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
        .type('text/html; charset=utf-8').send(sandboxPage(ref, c, ret));
    });
    pub.post('/pay/sandbox/:ref/:outcome', async (req, reply) => {
      if (config.env === 'production') return reply.status(404).send({ error: 'not found' });
      const { ref, outcome } = req.params as { ref: string; outcome: string };
      if (outcome !== 'pay' && outcome !== 'cancel') return reply.status(404).send({ error: 'not found' });
      if (!(await sandboxCheckout(ref))) return reply.status(404).send({ error: 'unknown sandbox payment' });
      const result = await sandboxSettle(ref, outcome === 'pay');
      const ret = back((req.query as any)?.return);
      if (String(req.headers.accept ?? '').includes('application/json')) return { outcome: result };
      return reply.redirect(ret + (ret.includes('?') ? '&' : '?') + `status=${outcome === 'pay' ? 'paid' : 'cancelled'}`, 303);
    });
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function sandboxPage(ref: string, c: { amountIdr: number; channel: string; state: string; purpose: string; hold?: boolean; save?: boolean }, ret: string): string {
  const label = CHANNEL_LABEL[c.channel as Channel] ?? c.channel;
  const q = `?return=${encodeURIComponent(ret)}`;
  const done = c.state !== 'pending';
  const extras = [c.hold ? 'Hold only (pre-authorisation): the amount is reserved, and only what the session uses is captured.' : '', c.save ? 'The card will be saved for next time (a sandbox token).' : ''].filter(Boolean);
  const card = c.channel === 'CARD';
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sandbox checkout · ${esc(label)}</title>
<style>
:root{color-scheme:light dark;--bg:#f3f5f4;--card:#fff;--ink:#16211c;--mute:#5b6a63;--line:#d9e0dc;--go:#0f7a4f;--warn:#9a5b00}
@media (prefers-color-scheme:dark){:root{--bg:#0f1512;--card:#18201c;--ink:#e6eee9;--mute:#9aaba2;--line:#2a3530;--go:#38b27c;--warn:#e0a24a}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;max-width:380px;width:100%;box-sizing:border-box;display:grid;gap:14px}
.tag{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--warn);font-weight:600}
h1{font-size:20px;margin:0}.amt{font-size:30px;font-weight:700;font-variant-numeric:tabular-nums}
p{margin:0;color:var(--mute)}.row{display:flex;gap:10px}form{flex:1}
button{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);font:inherit;font-weight:600;cursor:pointer}
button.go{background:var(--go);border-color:var(--go);color:#fff}.fake{border:1px dashed var(--line);border-radius:10px;padding:10px 12px;font-family:ui-monospace,monospace;color:var(--mute)}
</style></head><body><main>
<div class="tag">Sandbox — no real money</div>
<h1>${esc(label)}</h1>
<p>${esc(c.purpose)} · ref <code>${esc(ref)}</code></p>
<div class="amt">Rp ${c.amountIdr.toLocaleString('id-ID')}</div>
${card ? '<div class="fake">4811 1111 1111 1114 · 12/30 · 3-D Secure OK</div>' : `<p>Stands in for the ${esc(label)} app: approve or decline the payment.</p>`}
${extras.map((x) => `<p>${esc(x)}</p>`).join('')}
${done ? `<p>This payment is already <b>${esc(c.state)}</b>.</p><a href="${esc(ret)}">Back to PlugSure</a>` : `<div class="row">
<form method="post" action="/pay/sandbox/${esc(ref)}/cancel${esc(q)}"><button type="submit">Batal</button></form>
<form method="post" action="/pay/sandbox/${esc(ref)}/pay${esc(q)}"><button class="go" type="submit">Bayar</button></form></div>`}
</main></body></html>`;
}

async function runTest(r: store.Resolved, b: any): Promise<{ ok: boolean; message: string }> {
  switch (r.kind) {
    case 'payments': {
      const p = providerFor(r);
      return p.testConnection ? p.testConnection() : { ok: true, message: 'No connection test for this provider.' };
    }
    case 'otp':
    case 'otp_fallback': {
      const phone = b.phone ? normalisePhone(String(b.phone)) : null;
      if (b.phone && !phone) return { ok: false, message: 'That is not an Indonesian mobile number.' };
      return testOtp(r, phone);
    }
    case 'pnc_pki': {
      if (r.provider === 'mock') return { ok: true, message: 'Test PKI: built in, nothing to connect to.' };
      if (r.provider === 'none') return { ok: false, message: 'No PKI selected.' };
      const res = await providerFetch(`${String(r.settings.url).replace(/\/+$/, '')}/v1/roots`, { headers: { authorization: `Bearer ${r.secrets.token ?? ''}` } });
      if (res.status === 200) return { ok: true, message: `The PKI gateway answered with ${(res.body?.v2gRoots ?? []).length} V2G and ${(res.body?.moRoots ?? []).length} mobility operator root certificates.` };
      return { ok: false, message: `The PKI gateway answered HTTP ${res.status}${res.body?.error ? `: ${res.body.error}` : ''}.` };
    }
    case 'map_tiles': {
      const url = String(r.settings.tileUrl).replace('{s}', 'a').replace('{z}', '0').replace('{x}', '0').replace('{y}', '0').replace('{r}', '');
      const res = await fetch(url, { headers: { 'user-agent': 'PlugSure/1.3 (tile check)' }, signal: AbortSignal.timeout(10_000) }).catch((e) => { throw new Error(`cannot reach the tile server: ${(e as Error).message}`); });
      const type = res.headers.get('content-type') ?? '';
      await res.arrayBuffer().catch(() => null);
      return res.ok && type.startsWith('image/') ? { ok: true, message: `The tile server returned a ${type} tile.` } : { ok: false, message: `The tile server answered HTTP ${res.status} (${type || 'no content type'}).` };
    }
  }
}
