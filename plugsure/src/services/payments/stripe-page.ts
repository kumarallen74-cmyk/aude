import { one, outsideRequestScope } from '../../db/pool.js';
import { currencyOr, formatMoney, fromProviderAmount } from '../../domain/money.js';
import { providerOfPayment } from './registry.js';
import { StripeProvider } from './stripe.js';

/**
 * PlugSure's Stripe checkout page, /pay/stripe/<ref>/<payment intent>: the Stripe Payment Element for a card payment
 * (a hold, a sale, a card to save, 3-D Secure of a saved card) or FPX (its bank list and terms). It stands where
 * Midtrans' Snap page and Xendit's hosted session stand for Indonesian cards.
 *
 * Why not Stripe Checkout (Stripe's own hosted page): Checkout asks every customer for an e-mail address unless one is
 * passed in, and Singapore's EV charging licence conditions (LTA, §2.4.10(iv)) require a guest option needing no
 * personal details (docs/MULTI-COUNTRY-DESIGN.md SG-5). The Payment Element is told not to ask for e-mail, phone or name;
 * the card details go from the driver's browser to Stripe (Stripe.js iframes), never to PlugSure.
 *
 * The page is reached only with both references: PlugSure's (ps_…, which finds the payment and its Stripe account) and
 * Stripe's PaymentIntent id, which must carry that reference in its metadata. The page holds the PaymentIntent's client
 * secret (the same capability Stripe's own hosted URL carries); it is not cached and sends no referrer. Its CSP admits
 * js.stripe.com on this path only (api/csp.ts). The script is /pay/stripe.js (no inline script).
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export const STRIPE_JS_URL = 'https://js.stripe.com/dahlia/stripe.js';

interface PayRow { org_id: string; provider: string; integration_id: string | null; currency: string; amount: number; purpose: string }

async function paymentOf(ref: string): Promise<PayRow | null> {
  return outsideRequestScope(async () => {
    const pi = await one<PayRow>(
      `SELECT org_id, provider, integration_id, currency, amount_authorised_minor AS amount,
              CASE mode WHEN 'reservation' THEN 'Reservation fee' WHEN 'settlement' THEN 'Charging session' ELSE 'EV charging' END AS purpose
         FROM payment_intent WHERE provider = 'stripe' AND provider_ref = $1`, [ref]);
    if (pi) return pi;
    return one<PayRow>(
      `SELECT org_id, provider, integration_id, currency, total_minor AS amount, '30-day pass' AS purpose
         FROM subscription_charge WHERE provider = 'stripe' AND provider_ref = $1`, [ref]);
  });
}

export async function stripeCheckoutPage(ref: string, paymentIntentId: string): Promise<{ status: number; html: string }> {
  const notFound = { status: 404, html: page('Payment not found', '<p>This payment link is not valid. Go back to the app and start again.</p>') };
  if (!/^ps_[0-9a-f]{32}$/.test(ref) || !/^pi_[A-Za-z0-9]{6,80}$/.test(paymentIntentId)) return notFound;
  const row = await paymentOf(ref);
  if (!row) return notFound;
  const provider = await providerOfPayment(row);
  if (!(provider instanceof StripeProvider)) return notFound;
  let pi: any;
  try { pi = await provider.pageIntent(ref, paymentIntentId); } catch { return { status: 502, html: page('Stripe is not answering', '<p>Try again in a moment.</p>') }; }
  if (!pi) return notFound;
  const cur = currencyOr(String(pi.currency ?? row.currency).toUpperCase());
  const amount = formatMoney(fromProviderAmount(Number(pi.amount), cur, 'minor'), cur, 'en');
  const back = String(pi.metadata?.plugsure_return ?? '/app/paid.html');
  const done = ['succeeded', 'requires_capture', 'processing', 'canceled'].includes(pi.status);
  const hold = pi.capture_method === 'manual';
  const save = pi.setup_future_usage != null;
  const notes = [
    hold ? 'Hold only: the amount is reserved on your card, and only what the session uses is charged. The rest is released when it ends.' : '',
    save ? 'Your card will be saved with Stripe for next time (PlugSure keeps only its brand and last four digits).' : '',
  ].filter(Boolean).map((x) => `<p class="note">${esc(x)}</p>`).join('');
  if (done) {
    const word = pi.status === 'canceled' ? 'cancelled' : pi.status === 'processing' ? 'being processed' : 'done';
    return { status: 200, html: page(`${esc(row.purpose)} · ${esc(amount)}`, `<p>This payment is ${word}.</p><p><a href="${esc(back)}">Back to the app</a></p>`) };
  }
  if (!provider.publishableKey) return { status: 503, html: page('Card payments are not set up', '<p>The operator has not finished setting up card payments.</p>') };
  // The heading says how the driver pays, the line under the amount what for. Both said "Charging" before.
  const method = String(pi.payment_method_types?.[0] ?? 'card');
  const heading = method === 'fpx' ? 'Online banking (FPX)' : method === 'grabpay' ? 'GrabPay' : hold ? 'Card hold' : 'Card payment';
  const body = `
<div class="amt">${esc(amount)}</div>
<p class="mute">${esc(row.purpose)}</p>
${notes}
<form id="pay" data-pk="${esc(provider.publishableKey)}" data-secret="${esc(String(pi.client_secret ?? ''))}" data-return="${esc(back)}" data-status="${esc(String(pi.status))}">
  <div id="element"></div>
  <button id="go" type="submit" disabled>${hold ? 'Authorise' : 'Pay'} ${esc(amount)}</button>
  <p id="msg" role="alert"></p>
</form>
<p class="small"><a href="${esc(cancelUrl(back))}">Cancel and go back to the app</a></p>
<p class="mute small">Payments by Stripe. PlugSure never sees your card number.</p>
<script src="${STRIPE_JS_URL}"></script>
<script src="/pay/stripe.js"></script>`;
  return { status: 200, html: page(esc(heading), body) };
}

/** The app's return page, told the driver left without paying (it shows "Payment cancelled" and forgets the checkout). */
export function cancelUrl(back: string): string {
  return `${back}${back.includes('?') ? '&' : '?'}status=cancelled`;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${title}</title>
<style>
:root{color-scheme:light dark;--bg:#f3f5f4;--card:#fff;--ink:#16211c;--mute:#5b6a63;--line:#d9e0dc;--go:#0f7a4f;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#0f1512;--card:#18201c;--ink:#e6eee9;--mute:#9aaba2;--line:#2a3530;--go:#38b27c;--bad:#f2b8b5}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;max-width:420px;width:100%;box-sizing:border-box;display:grid;gap:14px}
h1{font-size:20px;margin:0}.amt{font-size:30px;font-weight:700;font-variant-numeric:tabular-nums}p{margin:0}.mute{color:var(--mute)}.small{font-size:12px}
.note{color:var(--mute);font-size:14px}#element{min-height:120px}#msg{color:var(--bad);min-height:1.5em}
button{width:100%;margin-top:14px;padding:12px;border-radius:10px;border:1px solid var(--go);background:var(--go);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.6;cursor:default}a{color:var(--go)}
</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
}

/**
 * The page's script. The Payment Element shows what the PaymentIntent allows (card, or FPX's bank list), asks for no
 * e-mail, phone or name (and no Link), and confirms with the return URL; a saved card's 3-D Secure (requires_action)
 * is handed to Stripe.js directly.
 */
export const STRIPE_PAGE_JS = `(function () {
  var form = document.getElementById('pay');
  if (!form || typeof Stripe !== 'function') { var m0 = document.getElementById('msg'); if (m0) m0.textContent = 'The card form could not be loaded. Check your connection and reload.'; return; }
  var d = form.dataset, msg = document.getElementById('msg'), go = document.getElementById('go');
  var stripe = Stripe(d.pk);
  if (d.status === 'requires_action') {
    stripe.handleNextAction({ clientSecret: d.secret }).then(function () { location.href = d['return']; });
    return;
  }
  var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var elements = stripe.elements({ clientSecret: d.secret, appearance: { theme: dark ? 'night' : 'stripe' } });
  var pe = elements.create('payment', {
    fields: { billingDetails: { name: 'auto', email: 'never', phone: 'never', address: 'if_required' } },
    wallets: { link: 'never' }
  });
  pe.on('ready', function () { go.disabled = false; });
  pe.mount('#element');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    go.disabled = true; msg.textContent = '';
    stripe.confirmPayment({
      elements: elements,
      confirmParams: { return_url: d['return'], payment_method_data: { billing_details: { email: null, phone: null } } }
    }).then(function (r) { if (r && r.error) { msg.textContent = r.error.message || 'The payment did not go through.'; go.disabled = false; } });
  });
})();
`;
