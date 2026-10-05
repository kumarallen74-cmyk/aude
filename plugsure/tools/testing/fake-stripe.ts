/**
 * A local fake of the parts of Stripe's API PlugSure uses (services/payments/stripe.ts), for unit tests and
 * tools/e2e/stripe-e2e.mts. Stateful: PaymentIntents, Customers, PaymentMethods and Refunds live in memory; it checks
 * the bearer key, the Stripe-Version header, the Idempotency-Key of every POST (replaying the first answer for a key,
 * refusing a key reused with other parameters, as Stripe does), Stripe's minimum amounts, FPX's band, and the
 * PaymentIntent state machine (one capture, cancel only before capture). Webhooks are signed exactly as Stripe signs them
 * (Stripe-Signature t=…,v1=HMAC-SHA256("<t>.<body>")) and POSTed to the webhook URL given.
 *
 * What a driver does in Stripe's UI (enter a card, approve in GrabPay, scan PayNow, pass 3-D Secure) is a method here:
 * confirmCard, completeRedirect, payNow, … Never a stand-in for testing against Stripe itself: deploy/STRIPE.md has the
 * manual test-mode run.
 */
import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';

export interface FakeStripeOptions {
  secretKey: string;
  webhookSecret: string;
  country: 'MY' | 'SG';
  /** Where events are POSTed (PlugSure's /pay/notify/<key>); set later with setWebhookUrl. */
  webhookUrl?: string;
  livemode?: boolean;
}

type Obj = Record<string, any>;
const MIN: Record<string, number> = { myr: 200, sgd: 50 };
const id = (p: string) => `${p}_${randomBytes(12).toString('hex')}`;

/** Stripe's form encoding back into an object (a[b][0]=v). */
export function parseForm(body: string): Obj {
  const out: Obj = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const parts = k.replace(/\]/g, '').split('[');
    let o: any = out;
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(parts[i + 1]!);
      if (last) o[p] = v;
      else o = o[p] ??= nextIsIndex ? [] : {};
    });
  }
  return out;
}

export class FakeStripe {
  readonly requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: Obj; raw: string; at: number }> = [];
  readonly intents = new Map<string, Obj>();
  readonly refunds = new Map<string, Obj>();
  readonly customers = new Map<string, Obj>();
  readonly methods = new Map<string, Obj>();
  readonly events: Array<{ id: string; type: string; body: string; status: number | null }> = [];
  private idem = new Map<string, { raw: string; status: number; body: unknown }>();
  /** Behaviour switches for failure paths. */
  readonly behaviour = { captureFailures: 0, refundStatus: null as null | 'pending' | 'succeeded' | 'failed', requires3ds: false, deliver: true };
  private server: http.Server;
  url = '';

  constructor(private o: FakeStripeOptions) {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const [path, qs] = (req.url ?? '').split('?') as [string, string | undefined];
        const body = req.method === 'GET' ? parseForm(qs ?? '') : parseForm(raw);
        this.requests.push({ method: req.method ?? '', path, headers: req.headers, body, raw, at: Date.now() });
        const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
        if (req.headers.authorization !== `Bearer ${this.o.secretKey}`) return send(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } });
        if (!req.headers['stripe-version']) return send(400, { error: { type: 'invalid_request_error', message: 'Stripe-Version is pinned by PlugSure and must be sent' } });
        if (req.method === 'POST') {
          const key = String(req.headers['idempotency-key'] ?? '');
          if (!key) return send(400, { error: { type: 'invalid_request_error', message: 'fake: every POST must carry an Idempotency-Key' } });
          const hit = this.idem.get(key);
          if (hit) {
            if (hit.raw !== raw) return send(400, { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' } });
            res.writeHead(hit.status, { 'content-type': 'application/json', 'idempotent-replayed': 'true' }); res.end(JSON.stringify(hit.body)); return;
          }
          const [status, out] = this.route('POST', path, body);
          this.idem.set(key, { raw, status, body: out });
          return send(status, out);
        }
        const [status, out] = this.route(req.method ?? 'GET', path, body);
        send(status, out);
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as any).port}`;
    return this;
  }
  async stop(): Promise<void> { await new Promise<void>((r) => this.server.close(() => r())); }
  setWebhookUrl(u: string) { this.o.webhookUrl = u; }
  get currency() { return this.o.country === 'MY' ? 'myr' : 'sgd'; }
  posts(re: RegExp, after = 0) { return this.requests.filter((r) => r.method === 'POST' && re.test(r.path) && r.at >= after); }

  private err(status: number, code: string, message: string, extra: Obj = {}): [number, Obj] {
    return [status, { error: { type: status === 402 ? 'card_error' : 'invalid_request_error', code, message, ...extra } }];
  }

  private route(method: string, path: string, b: Obj): [number, unknown] {
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/v1/balance') return [200, { object: 'balance', available: [{ amount: 0, currency: this.currency }] }];
    if (method === 'GET' && path === '/v1/account') return [200, { object: 'account', id: 'acct_fake', country: this.o.country, default_currency: this.currency }];
    if (method === 'POST' && path === '/v1/customers') {
      const c = { id: id('cus'), object: 'customer', description: b.description ?? null, metadata: b.metadata ?? {} };
      this.customers.set(c.id, c); return [200, c];
    }
    if (method === 'POST' && path === '/v1/payment_intents') return this.createIntent(b);
    if (method === 'GET' && path === '/v1/payment_intents/search') {
      const want = /metadata\['plugsure_ref'\]:'([^']+)'/.exec(String(b.query ?? ''))?.[1];
      return [200, { object: 'search_result', data: [...this.intents.values()].filter((p) => p.metadata?.plugsure_ref === want) }];
    }
    if ((m = /^\/v1\/payment_intents\/(pi_[a-z0-9]+)$/.exec(path)) && method === 'GET') {
      const pi = this.intents.get(m[1]!); return pi ? [200, pi] : this.err(404, 'resource_missing', 'No such payment_intent');
    }
    if ((m = /^\/v1\/payment_intents\/(pi_[a-z0-9]+)\/capture$/.exec(path))) return this.capture(m[1]!, b);
    if ((m = /^\/v1\/payment_intents\/(pi_[a-z0-9]+)\/cancel$/.exec(path))) return this.cancel(m[1]!, b.cancellation_reason ?? null);
    if (method === 'POST' && path === '/v1/refunds') return this.refund(b);
    if (method === 'GET' && path === '/v1/refunds') return [200, { object: 'list', data: [...this.refunds.values()].filter((r) => r.payment_intent === b.payment_intent) }];
    if ((m = /^\/v1\/refunds\/(re_[a-z0-9]+)$/.exec(path))) { const r = this.refunds.get(m[1]!); return r ? [200, r] : this.err(404, 'resource_missing', 'No such refund'); }
    if ((m = /^\/v1\/payment_methods\/(pm_[a-z0-9]+)$/.exec(path))) { const p = this.methods.get(m[1]!); return p ? [200, p] : this.err(404, 'resource_missing', 'No such PaymentMethod'); }
    if ((m = /^\/v1\/payment_methods\/(pm_[a-z0-9]+)\/detach$/.exec(path))) {
      const p = this.methods.get(m[1]!); if (!p) return this.err(404, 'resource_missing', 'No such PaymentMethod');
      p.customer = null; return [200, p];
    }
    return this.err(404, 'resource_missing', `fake: no route ${method} ${path}`);
  }

  private createIntent(b: Obj): [number, unknown] {
    const amount = Number(b.amount);
    const currency = String(b.currency ?? '');
    const types: string[] = b.payment_method_types ?? ['card'];
    const type = types[0]!;
    if (!Number.isInteger(amount) || amount < 1) return this.err(400, 'parameter_invalid_integer', 'amount must be a positive integer');
    if (currency !== this.currency) return this.err(400, 'parameter_invalid', `fake: this ${this.o.country} account settles ${this.currency}`);
    if (type === 'fpx' && (amount < 200 || amount > 3_000_000)) return this.err(400, 'invalid_amount', 'FPX transactions must be greater than RM2 and less than RM30,000.');
    if (type !== 'grabpay' && type !== 'fpx' && amount < (MIN[currency] ?? 50)) return this.err(400, 'amount_too_small', 'Amount must be at least the minimum charge amount');
    const pi: Obj = {
      id: id('pi'), object: 'payment_intent', amount, amount_capturable: 0, amount_received: 0, currency, livemode: !!this.o.livemode,
      capture_method: b.capture_method ?? 'automatic', payment_method_types: types, status: 'requires_payment_method',
      metadata: b.metadata ?? {}, description: b.description ?? null, customer: b.customer ?? null, payment_method: null,
      setup_future_usage: b.setup_future_usage ?? null, next_action: null, cancellation_reason: null, last_payment_error: null,
      latest_charge: null, created: Math.floor(Date.now() / 1000),
    };
    pi.client_secret = `${pi.id}_secret_${randomBytes(8).toString('hex')}`;
    this.intents.set(pi.id, pi);
    if (String(b.confirm) !== 'true') return [200, pi];
    if (type === 'paynow') {
      pi.status = 'requires_action';
      pi.payment_method = this.newMethod('paynow').id;
      pi.next_action = { type: 'paynow_display_qr_code', paynow_display_qr_code: {
        data: `00020101021226490009SG.PAYNOW010120213${pi.id.slice(3, 16)}0301104${pi.id}5204000053037025405${(amount / 100).toFixed(2)}5802SG5913PLUGSURE FAKE6009SINGAPORE6304ABCD`,
        expires_at: Math.floor(Date.now() / 1000) + 3600, hosted_instructions_url: `${this.url}/paynow/${pi.id}`, image_url_png: `${this.url}/qr/${pi.id}.png`,
      } };
      return [200, pi];
    }
    if (type === 'grabpay') {
      pi.status = 'requires_action';
      pi.payment_method = this.newMethod('grabpay').id;
      pi.next_action = { type: 'redirect_to_url', redirect_to_url: { url: `${this.url}/grabpay/${pi.id}`, return_url: b.return_url } };
      return [200, pi];
    }
    // A saved card, confirmed server-side.
    const pm = this.methods.get(String(b.payment_method ?? ''));
    if (!pm || (b.customer && pm.customer !== b.customer)) {
      pi.status = 'requires_payment_method';
      return this.err(400, 'resource_missing', `No such PaymentMethod: '${b.payment_method}'`, { payment_intent: pi });
    }
    if (pm.card?.declined) {
      pi.last_payment_error = { code: 'card_declined', decline_code: 'insufficient_funds' };
      return this.err(402, 'card_declined', 'Your card has insufficient funds.', { decline_code: 'insufficient_funds', payment_intent: pi });
    }
    pi.payment_method = pm.id;
    if (this.behaviour.requires3ds) {
      pi.status = 'requires_action';
      pi.next_action = { type: 'redirect_to_url', redirect_to_url: { url: `${this.url}/3ds/${pi.id}`, return_url: b.return_url } };
      return [200, pi];
    }
    this.authorise(pi, pi.amount);
    return [200, pi];
  }

  private newMethod(type: string, card?: Obj): Obj {
    const pm = { id: id('pm'), object: 'payment_method', type, customer: null as string | null, ...(card ? { card } : {}) };
    this.methods.set(pm.id, pm);
    return pm;
  }

  /** The card went through: held (manual capture) or taken; events emitted. */
  private authorise(pi: Obj, amount: number, currency = pi.currency) {
    if (pi.capture_method === 'manual') {
      pi.status = 'requires_capture'; pi.amount_capturable = amount;
      this.emit('payment_intent.amount_capturable_updated', { ...pi, currency });
    } else {
      pi.status = 'succeeded'; pi.amount_received = amount; pi.latest_charge = id('ch');
      this.emit('payment_intent.succeeded', { ...pi, currency });
    }
    pi.next_action = null;
  }

  private capture(piId: string, b: Obj): [number, unknown] {
    const pi = this.intents.get(piId);
    if (!pi) return this.err(404, 'resource_missing', 'No such payment_intent');
    if (this.behaviour.captureFailures > 0) { this.behaviour.captureFailures--; return [500, { error: { type: 'api_error', message: 'An unknown error occurred' } }]; }
    if (pi.status !== 'requires_capture') return this.err(400, 'payment_intent_unexpected_state', `This PaymentIntent could not be captured because it has a status of ${pi.status}.`);
    const amt = b.amount_to_capture != null ? Number(b.amount_to_capture) : pi.amount_capturable;
    if (amt > pi.amount_capturable) return this.err(400, 'amount_too_large', 'amount_to_capture must be at most amount_capturable');
    pi.status = 'succeeded'; pi.amount_received = amt; pi.amount_capturable = 0; pi.latest_charge = id('ch');
    this.emit('payment_intent.succeeded', pi);
    return [200, pi];
  }

  private cancel(piId: string, reason: string | null): [number, unknown] {
    const pi = this.intents.get(piId);
    if (!pi) return this.err(404, 'resource_missing', 'No such payment_intent');
    if (['succeeded', 'canceled'].includes(pi.status)) return this.err(400, 'payment_intent_unexpected_state', `You cannot cancel this PaymentIntent because it has a status of ${pi.status}.`);
    pi.status = 'canceled'; pi.cancellation_reason = reason; pi.amount_capturable = 0;
    this.emit('payment_intent.canceled', pi);
    return [200, pi];
  }

  private refund(b: Obj): [number, unknown] {
    const pi = this.intents.get(String(b.payment_intent ?? ''));
    if (!pi) return this.err(404, 'resource_missing', 'No such payment_intent');
    if (pi.status !== 'succeeded') return this.err(400, 'charge_not_refundable', 'This PaymentIntent has no successful charge to refund.');
    const already = [...this.refunds.values()].filter((r) => r.payment_intent === pi.id && r.status !== 'failed').reduce((n, r) => n + r.amount, 0);
    const amount = b.amount != null ? Number(b.amount) : pi.amount_received - already;
    if (amount + already > pi.amount_received) return this.err(400, 'charge_already_refunded', 'Refund amount is greater than unrefunded amount on charge');
    const async = ['paynow', 'grabpay'].includes(pi.payment_method_types[0]);
    const status = this.behaviour.refundStatus ?? (async ? 'pending' : 'succeeded');
    const r = { id: id('re'), object: 'refund', amount, currency: pi.currency, payment_intent: pi.id, status, metadata: b.metadata ?? {}, reason: b.reason ?? null };
    this.refunds.set(r.id, r);
    this.emit('refund.created', r);
    return [200, r];
  }

  // ---------------------------------------------------------------- what the driver (or Stripe) does

  /** The driver enters a card on the Payment Element page (and passes 3-D Secure). amount: what the bank authorised. */
  confirmCard(piId: string, o: { brand?: string; last4?: string; amount?: number; currency?: string } = {}): Obj {
    const pi = this.intents.get(piId)!;
    const pm = this.newMethod('card', { brand: o.brand ?? 'visa', last4: o.last4 ?? '4242', exp_month: 12, exp_year: new Date().getFullYear() + 3 });
    if (pi.customer && pi.setup_future_usage) pm.customer = pi.customer;
    pi.payment_method = pm.id;
    this.authorise(pi, o.amount ?? pi.amount, o.currency ?? pi.currency);
    return pi;
  }
  /** A saved card that will be declined. */
  declineCard(pmId: string) { const pm = this.methods.get(pmId); if (pm?.card) pm.card.declined = true; }
  /** 3-D Secure passed for a saved card that needed it. */
  pass3ds(piId: string) { const pi = this.intents.get(piId)!; this.authorise(pi, pi.amount); return pi; }
  /** A redirect method (GrabPay, FPX) or PayNow paid. amount: what was paid (an underpayment test sends less). */
  completeRedirect(piId: string, o: { amount?: number; currency?: string; bank?: string } = {}) {
    const pi = this.intents.get(piId)!;
    if (!pi.payment_method) pi.payment_method = this.newMethod(pi.payment_method_types[0], undefined).id;
    pi.status = 'succeeded'; pi.amount_received = o.amount ?? pi.amount; pi.next_action = null; pi.latest_charge = id('ch');
    this.emit('payment_intent.succeeded', { ...pi, currency: o.currency ?? pi.currency });
    return pi;
  }
  payNow(piId: string, o: { amount?: number; currency?: string } = {}) { return this.completeRedirect(piId, o); }
  /** A declined attempt (the PaymentIntent stays open for another try). */
  failAttempt(piId: string, code = 'card_declined') {
    const pi = this.intents.get(piId)!;
    pi.status = 'requires_payment_method'; pi.last_payment_error = { code };
    this.emit('payment_intent.payment_failed', pi);
  }
  /** The PayNow QR expired unpaid. */
  expirePayNow(piId: string) { this.failAttempt(piId, 'payment_intent_payment_attempt_expired'); }
  /** The uncaptured authorisation lapsed (Stripe cancels it, cancellation_reason automatic). */
  expireAuthorisation(piId: string) {
    const pi = this.intents.get(piId)!;
    pi.status = 'canceled'; pi.cancellation_reason = 'automatic'; pi.amount_capturable = 0;
    this.emit('payment_intent.canceled', pi);
  }
  /** An asynchronous refund settles. */
  settleRefund(refundId: string, status: 'succeeded' | 'failed') {
    const r = this.refunds.get(refundId)!;
    r.status = status;
    this.emit(status === 'failed' ? 'refund.failed' : 'refund.updated', r);
  }

  // ---------------------------------------------------------------- events

  /** Build, sign and (unless behaviour.deliver is off) deliver an event. Returns the event body. */
  emit(type: string, object: Obj): string {
    const ev = { id: id('evt'), object: 'event', api_version: '2026-09-30.endive', created: Math.floor(Date.now() / 1000), livemode: !!this.o.livemode, type, data: { object: JSON.parse(JSON.stringify(object)) }, pending_webhooks: 1 };
    const body = JSON.stringify(ev);
    const rec = { id: ev.id, type, body, status: null as number | null };
    this.events.push(rec);
    if (this.behaviour.deliver && this.o.webhookUrl) this.pending.push(this.deliver(body).then((s) => { rec.status = s; }));
    return body;
  }
  private pending: Array<Promise<unknown>> = [];
  /** Wait until every event emitted so far has been delivered (and answered). */
  async flush(): Promise<void> { while (this.pending.length) await Promise.all(this.pending.splice(0)); }

  sign(body: string, t = Math.floor(Date.now() / 1000), secret = this.o.webhookSecret): string {
    return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex')}`;
  }
  /** POST a body to the webhook URL with the given (or a valid) Stripe-Signature. */
  async deliver(body: string, signature?: string): Promise<number> {
    const r = await fetch(this.o.webhookUrl!, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', 'stripe-signature': signature ?? this.sign(body), 'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)' }, body });
    await r.text();
    return r.status;
  }
  lastEvent(type: string, piId?: string) {
    return [...this.events].reverse().find((e) => e.type === type && (!piId || JSON.parse(e.body).data.object.id === piId || JSON.parse(e.body).data.object.payment_intent === piId));
  }
}
