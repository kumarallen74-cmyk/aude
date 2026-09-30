import { appNameFor } from '../services/brand.js';
import { one, many, query, tx } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { paymentsFor, PaymentsUnavailable, logPaymentCreated, startPayment, MethodUnavailable } from '../services/payments/registry.js';
import { CHANNEL_LABEL } from '../services/payments/provider.js';
import { feeTax } from '../services/benefits.js';
import { qrDataUri, qrPngDataUri, paymentSetupFor, paymentView, type PayOptions } from './charge.js';
import { notifyDevices } from './notify.js';
import type { DriverPrincipal } from './identity.js';

/**
 * Memberships in the driver app: 30-day passes on an operator's plan, paid by
 * QRIS, an e-wallet or a card.
 *
 *   Renewing    by hand (the new 30 days start when the current ones end), or
 *               automatically with a saved card or a linked e-wallet: the renewal
 *               worker charges it a day before the pass ends, retries, and tells
 *               the driver when it needs them (a PIN, 3-D Secure, a declined card).
 *   Switching   to another plan with days left credits the unused value of the
 *               current pass: a dearer plan costs the difference now; a cheaper one
 *               costs nothing and runs longer. The plan changes when the switch is
 *               paid, so an abandoned payment never costs the driver their pass.
 *   Reminders   three days before the end ("renews on …" when it will).
 */

const PASS_DAYS = 30;
const DAY_MS = 86_400_000;
const PASS_MS = PASS_DAYS * DAY_MS;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Renewal retries after a decline: 1 h, 6 h, 12 h (within the day before the end and the day of grace after). */
const RENEW_BACKOFF_MS = [60, 360, 720].map((m) => m * 60_000);

// ─────────────────────────────────────────── proration (pure)

/**
 * The value, before tax, of the pass time left at `at`: each paid charge's fee over
 * the part of its own window still to come. Stacked renewals each count.
 */
export function unusedValue(charges: Array<{ feeIdr: number; periodStart: Date; periodEnd: Date }>, at: Date): number {
  let v = 0;
  for (const c of charges) {
    const len = c.periodEnd.getTime() - c.periodStart.getTime();
    if (len <= 0 || c.periodEnd <= at) continue;
    const left = c.periodEnd.getTime() - Math.max(at.getTime(), c.periodStart.getTime());
    v += (c.feeIdr * left) / len;
  }
  return Math.floor(v);
}

/**
 * Switching plans with `credit` of unused value: a dearer plan costs the difference
 * (for 30 days); a cheaper or equal one costs nothing and its window is lengthened
 * by what the credit has left over, at the new plan's daily price.
 */
export function switchTerms(creditIdr: number, newFeeIdr: number): { payFeeIdr: number; creditUsedIdr: number; periodMs: number } {
  if (creditIdr <= 0) return { payFeeIdr: newFeeIdr, creditUsedIdr: 0, periodMs: PASS_MS };
  if (newFeeIdr <= 0) return { payFeeIdr: 0, creditUsedIdr: 0, periodMs: PASS_MS };
  if (newFeeIdr > creditIdr) return { payFeeIdr: newFeeIdr - creditIdr, creditUsedIdr: creditIdr, periodMs: PASS_MS };
  const extra = Math.floor(((creditIdr - newFeeIdr) / newFeeIdr) * PASS_MS);
  return { payFeeIdr: 0, creditUsedIdr: creditIdr, periodMs: PASS_MS + extra };
}

async function paidCharges(subscriptionId: string) {
  return (await many<any>(
    `SELECT fee_idr, period_start, period_end FROM subscription_charge WHERE subscription_id = $1 AND state = 'paid' AND via <> 'invoice'`,
    [subscriptionId],
  )).map((c) => ({ feeIdr: Number(c.fee_idr), periodStart: new Date(c.period_start), periodEnd: new Date(c.period_end) }));
}

/** The driver's live pass at this operator on another plan, with days left, and what it is worth now. */
async function switchCredit(live: any, planId: string, now: Date): Promise<number> {
  if (!live || live.plan_id === planId || live.status !== 'active' || !live.current_period_end || new Date(live.current_period_end) <= now) return 0;
  return unusedValue(await paidCharges(live.id), now);
}

// ─────────────────────────────────────────── the app's view

const methodLabel = (m: { kind: string; channel: string | null; brand: string | null; last4: string | null; account_label: string | null }) =>
  m.kind === 'ewallet' ? `${CHANNEL_LABEL[m.channel as keyof typeof CHANNEL_LABEL] ?? m.channel ?? 'E-wallet'}${m.account_label ? ` ${m.account_label}` : ''}`
    : `${m.brand ?? 'Card'}${m.last4 ? ` •••• ${m.last4}` : ''}`;

export async function membershipOverview(p: DriverPrincipal) {
  const plans = await many<any>(
    `SELECT pl.id, pl.name, pl.description, pl.monthly_fee_idr, pl.energy_discount_bps, pl.member_rate_idr::float8 AS member_rate_idr,
            pl.included_kwh::float8 AS included_kwh, pl.waive_session_fees, pl.current_type, o.name AS operator, o.pkp, o.id AS org_id
       FROM subscription_plan pl JOIN organisation o ON o.id = pl.org_id
      WHERE pl.active AND pl.offered_in_app AND o.sandbox_of_org_id IS NULL AND o.archived_at IS NULL
      ORDER BY o.name, pl.monthly_fee_idr`,
  );
  const mine = p.appDriverId
    ? await many<any>(
        `SELECT s.id, s.org_id, s.status, s.current_period_start, s.current_period_end, s.auto_renew, s.renew_error, s.renew_next_at,
                pl.id AS plan_id, pl.name, pl.included_kwh::float8 AS included_kwh, o.name AS operator,
                m.id AS method_id, m.kind AS method_kind, m.channel AS method_channel, m.brand AS method_brand, m.last4 AS method_last4, m.account_label AS method_account,
                COALESCE((SELECT used_kwh::float8 FROM subscription_usage u WHERE u.subscription_id = s.id AND u.period_start = s.current_period_start), 0) AS used_kwh,
                (SELECT json_build_object('chargeId', c.id, 'checkoutUrl', c.checkout_url, 'channel', c.channel, 'totalIdr', c.total_idr)
                   FROM subscription_charge c WHERE c.subscription_id = s.id AND c.state = 'pending' AND c.auto_renewal ORDER BY c.created_at DESC LIMIT 1) AS pending_renewal
           FROM subscription s JOIN subscription_plan pl ON pl.id = s.plan_id JOIN organisation o ON o.id = s.org_id
           LEFT JOIN driver_card m ON m.id = s.renew_method_id AND m.removed_at IS NULL
          WHERE s.app_driver_id = $1 AND s.status IN ('active', 'pending_payment')
          ORDER BY s.created_at DESC`,
        [p.appDriverId],
      )
    : [];
  const now = new Date();
  const methods = new Map<string, Awaited<ReturnType<typeof paymentSetupFor>>>();
  for (const org of new Set(plans.map((x) => x.org_id as string))) methods.set(org, await paymentSetupFor(org, p));
  // The value a switch would credit, per operator where the driver has a pass.
  const credits = new Map<string, { planId: string; creditIdr: number }>();
  for (const m of mine) {
    if (m.status === 'active' && m.current_period_end && new Date(m.current_period_end) > now) {
      credits.set(m.org_id, { planId: m.plan_id, creditIdr: unusedValue(await paidCharges(m.id), now) });
    }
  }
  return {
    signedIn: !!p.appDriverId,
    plans: plans.map((x) => {
      const cr = credits.get(x.org_id);
      const sw = cr && cr.planId !== x.id ? switchTerms(cr.creditIdr, x.monthly_fee_idr) : null;
      return {
        paymentMethods: methods.get(x.org_id)?.paymentMethods ?? [],
        // A pass is a sale, never a hold; saved cards and saving apply.
        canSaveCard: methods.get(x.org_id)?.canSaveCard ?? false,
        savedCards: methods.get(x.org_id)?.savedCards ?? [],
        linkedWallets: methods.get(x.org_id)?.linkedWallets ?? [],
        id: x.id, name: x.name, description: x.description, operator: x.operator,
        monthlyFeeIdr: x.monthly_fee_idr, totalIdr: feeTax(x.monthly_fee_idr, x.pkp).total,
        energyDiscountPercent: x.energy_discount_bps / 100, memberRateIdr: x.member_rate_idr, includedKwh: x.included_kwh,
        waiveSessionFees: x.waive_session_fees, currentType: x.current_type, days: PASS_DAYS,
        // Switching from the driver's current plan at this operator: what the unused days are worth, and what is left to pay.
        switch: sw ? {
          creditIdr: sw.creditUsedIdr, payFeeIdr: sw.payFeeIdr, payTotalIdr: sw.payFeeIdr ? feeTax(sw.payFeeIdr, x.pkp).total : 0,
          days: Math.floor(sw.periodMs / DAY_MS),
        } : null,
      };
    }),
    memberships: mine.map((x) => ({
      id: x.id, planId: x.plan_id, name: x.name, operator: x.operator,
      status: x.status === 'active' && x.current_period_end && new Date(x.current_period_end).getTime() > now.getTime() ? 'active' : x.status === 'pending_payment' ? 'pending_payment' : 'ended',
      periodStart: x.current_period_start, periodEnd: x.current_period_end,
      includedKwh: x.included_kwh, remainingKwh: Math.max(0, x.included_kwh - x.used_kwh),
      autoRenew: !!x.auto_renew && !!x.method_id,
      renewMethod: x.method_id ? { id: x.method_id, kind: x.method_kind, label: methodLabel({ kind: x.method_kind, channel: x.method_channel, brand: x.method_brand, last4: x.method_last4, account_label: x.method_account }) } : null,
      renewError: x.renew_error, renewNextAt: x.renew_next_at,
      pendingRenewal: x.pending_renewal ?? null,
    })),
  };
}

// ─────────────────────────────────────────── buying, renewing, switching

/** Start buying (or renewing, or switching to) a pass: a charge for the next window. */
export async function buyPass(p: DriverPrincipal, planId: string, pay: PayOptions & { autoRenew?: boolean } = { returnUrl: '/app/paid.html' }) {
  if (!p.appDriverId) return { ok: false as const, error: 'Masuk dengan nomor HP untuk berlangganan.' };
  if (!UUID_RE.test(String(planId))) return { ok: false as const, error: 'Paket tidak ditemukan.' };
  const plan = await one<any>(
    `SELECT pl.*, o.pkp, o.name AS operator FROM subscription_plan pl JOIN organisation o ON o.id = pl.org_id
      WHERE pl.id = $1 AND pl.active AND pl.offered_in_app AND o.sandbox_of_org_id IS NULL`,
    [planId],
  );
  if (!plan) return { ok: false as const, error: 'Paket tidak ditemukan.' };
  const live = await one<any>(
    `SELECT * FROM subscription WHERE org_id = $1 AND app_driver_id = $2 AND status IN ('active', 'pending_payment')`,
    [plan.org_id, p.appDriverId],
  );
  const now = new Date();
  // An automatic renewal waiting for the driver (e-wallet PIN, 3-D Secure): finish that one instead of paying twice.
  if (live) {
    const waiting = await one<{ channel: string | null }>(`SELECT channel FROM subscription_charge WHERE subscription_id = $1 AND state = 'pending' AND auto_renewal`, [live.id]);
    if (waiting) {
      const n = CHANNEL_LABEL[waiting.channel as keyof typeof CHANNEL_LABEL] ?? waiting.channel ?? 'pembayaran';
      return { ok: false as const, error: `Perpanjangan otomatis sedang menunggu konfirmasi Anda di ${n}. Selesaikan di sana (lihat Akun), atau tunggu sampai kedaluwarsa.`, code: 'renewal_pending' };
    }
  }
  const switching = !!live && live.plan_id !== plan.id && live.status === 'active' && !!live.current_period_end && new Date(live.current_period_end) > now;
  const credit = switching ? await switchCredit(live, plan.id, now) : 0;
  const terms = switching ? switchTerms(credit, plan.monthly_fee_idr) : { payFeeIdr: plan.monthly_fee_idr, creditUsedIdr: 0, periodMs: PASS_MS };
  const tax = feeTax(terms.payFeeIdr, plan.pkp);
  let acq: Awaited<ReturnType<typeof paymentsFor>> | null = null;
  if (tax.total > 0) {
    try { acq = await paymentsFor(plan.org_id); } catch (e) { if (e instanceof PaymentsUnavailable) return { ok: false as const, error: 'Pembayaran belum tersedia di operator ini.' }; throw e; }
  }
  let r;
  try { r = await tx(async () => {
    let subId: string;
    if (live && (live.plan_id === plan.id || switching)) subId = live.id;
    else {
      // An ended (or never paid) membership on another plan makes way for this one.
      if (live) await query(`UPDATE subscription SET status = 'expired' WHERE id = $1`, [live.id]);
      subId = (await one<{ id: string }>(
        `INSERT INTO subscription (org_id, plan_id, subscriber_kind, app_driver_id, billing, status, created_by)
         VALUES ($1,$2,'app_driver',$3,'qris','pending_payment','driver-app') RETURNING id`,
        [plan.org_id, plan.id, p.appDriverId],
      ))!.id;
    }
    // Renewing the same plan: the new window starts when the current one ends. Switching or starting: now.
    const cur = !switching && live && live.plan_id === plan.id && live.current_period_end && new Date(live.current_period_end) > now ? new Date(live.current_period_end) : now;
    const end = new Date(cur.getTime() + terms.periodMs);
    // An unpaid pending charge (an abandoned checkout) is replaced.
    const pending = await one<any>(`SELECT * FROM subscription_charge WHERE subscription_id = $1 AND state = 'pending'`, [subId]);
    if (pending) await query(`UPDATE subscription_charge SET state = 'void' WHERE id = $1`, [pending.id]);
    const started = acq
      ? await startPayment(acq, {
          channel: pay.channel, customerPhone: pay.phone ?? p.account?.phone ?? null, returnUrl: pay.returnUrl,
          appDriverId: p.appDriverId, savedCardId: pay.savedCardId ?? null, saveCard: pay.saveCard === true, allowHold: false, walletId: pay.walletId ?? null,
          referenceId: `membership:${subId}:${Date.now()}`, amountIdr: tax.total, description: `${await appNameFor(plan.org_id)} ${plan.name}`,
        })
      : null;
    const ch = await one<{ id: string }>(
      `INSERT INTO subscription_charge (subscription_id, org_id, period_start, period_end, fee_idr, dpp_idr, ppn_idr, total_idr, via, provider_ref, provider, integration_id,
                                        channel, checkout_url, save_card, driver_card_id, credit_idr, switch_to_plan_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$12,$9,$10,$11,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [subId, plan.org_id, cur, end, plan.monthly_fee_idr, tax.dpp, tax.ppn, tax.total, started?.providerRef ?? null, acq?.provider.name ?? null, acq?.resolved.integrationId ?? null,
       started?.method ?? 'credit', started?.channel ?? null, started?.checkoutUrl ?? null, started?.saveCard ?? false, started?.savedCardId ?? null,
       terms.creditUsedIdr, switching ? plan.id : null],
    );
    // Renew automatically with this saved card or linked e-wallet, if the driver asked.
    if (pay.autoRenew === true && (pay.savedCardId || pay.walletId)) {
      await query(`UPDATE subscription SET auto_renew = true, renew_method_id = $2, renew_error = NULL, renew_attempts = 0, renew_next_at = NULL WHERE id = $1`,
        [subId, pay.savedCardId ?? pay.walletId]);
    }
    return { subId, chargeId: ch!.id, started, start: cur, end };
  }); } catch (e) { if (e instanceof MethodUnavailable) return { ok: false as const, error: e.message, ...(e.code ? { code: e.code } : {}) }; throw e; }
  if (r.started && acq) await logPaymentCreated(acq.resolved, plan.org_id, r.started.providerRef, tax.total, 'app pass', r.started.channel);
  // Nothing to pay (a switch covered by the credit), or a saved card / linked e-wallet taken at once: the pass is paid now.
  if (!r.started || r.started.immediate === 'captured') await markPassPaid(r.chargeId);
  return {
    ok: true as const,
    chargeId: r.chargeId, subscriptionId: r.subId, plan: plan.name, operator: plan.operator,
    periodStart: r.start.toISOString(), periodEnd: r.end.toISOString(),
    feeIdr: plan.monthly_fee_idr, creditIdr: terms.creditUsedIdr, ppnIdr: tax.ppn, totalIdr: tax.total,
    paid: !r.started || r.started.immediate === 'captured',
    // Sandbox acquirer only: the app offers the demo payment button.
    demo: acq?.provider.demo === true,
    ...(r.started ? { payment: paymentView(r.started, tax.total) } : {}),
    ...(r.started?.qrString ? { qr: { qrString: r.started.qrString, qrImage: await qrDataUri(r.started.qrString), qrPng: await qrPngDataUri(r.started.qrString), providerRef: r.started.providerRef, amountIdr: tax.total, expiresAt: r.started.expiresAt } } : {}),
  };
}

/** Turn automatic renewal on (with a saved card or linked e-wallet usable at the plan's operator) or off. */
export async function setAutoRenew(p: DriverPrincipal, subscriptionId: string, b: { enabled?: unknown; methodId?: unknown }) {
  if (!p.appDriverId || !UUID_RE.test(String(subscriptionId))) return { ok: false as const, status: 404, error: 'Langganan tidak ditemukan.' };
  const s = await one<any>(`SELECT id, org_id, status FROM subscription WHERE id = $1 AND app_driver_id = $2 AND billing = 'qris'`, [subscriptionId, p.appDriverId]);
  if (!s || !['active', 'pending_payment'].includes(s.status)) return { ok: false as const, status: 404, error: 'Langganan tidak ditemukan.' };
  if (b.enabled === false) {
    await query(`UPDATE subscription SET auto_renew = false, renew_next_at = NULL WHERE id = $1`, [s.id]);
    return { ok: true as const, autoRenew: false };
  }
  const methodId = String(b.methodId ?? '');
  if (!UUID_RE.test(methodId)) return { ok: false as const, status: 422, error: 'Pilih kartu tersimpan atau e-wallet terhubung untuk perpanjangan otomatis.' };
  let acq: Awaited<ReturnType<typeof paymentsFor>>;
  try { acq = await paymentsFor(s.org_id); } catch { return { ok: false as const, status: 409, error: 'Pembayaran belum tersedia di operator ini.' }; }
  const m = await one<any>(
    `SELECT id, kind, status FROM driver_card
      WHERE id = $1 AND app_driver_id = $2 AND removed_at IS NULL AND provider = $3 AND integration_id IS NOT DISTINCT FROM $4`,
    [methodId, p.appDriverId, acq.resolved.provider, acq.resolved.integrationId],
  );
  if (!m || (m.kind === 'ewallet' && m.status !== 'active')) {
    return { ok: false as const, status: 422, error: 'Kartu atau e-wallet ini tidak bisa dipakai di operator ini. Simpan kartu atau hubungkan e-wallet saat membayar.' };
  }
  await query(`UPDATE subscription SET auto_renew = true, renew_method_id = $2, renew_error = NULL, renew_attempts = 0, renew_next_at = NULL WHERE id = $1`, [s.id, m.id]);
  return { ok: true as const, autoRenew: true };
}

async function ownCharge(p: DriverPrincipal, id: string) {
  if (!p.appDriverId || !UUID_RE.test(String(id))) return null;
  return one<any>(
    `SELECT c.*, s.status AS sub_status, s.current_period_end AS sub_end, pl.name AS plan
       FROM subscription_charge c JOIN subscription s ON s.id = c.subscription_id JOIN subscription_plan pl ON pl.id = COALESCE(c.switch_to_plan_id, s.plan_id)
      WHERE c.id = $1 AND s.app_driver_id = $2`,
    [id, p.appDriverId],
  );
}

export async function passStatus(p: DriverPrincipal, id: string) {
  const c = await ownCharge(p, id);
  if (!c) return null;
  return {
    id: c.id, state: c.state, plan: c.plan, periodStart: c.period_start, periodEnd: c.period_end,
    feeIdr: c.fee_idr, creditIdr: c.credit_idr, dppIdr: c.dpp_idr, ppnIdr: c.ppn_idr, totalIdr: c.total_idr, paidAt: c.paid_at,
    membership: c.sub_status === 'active' ? 'active' : c.sub_status,
  };
}

/**
 * A pass is paid: the membership becomes (or stays) active and its window is
 * extended; a switch moves it to the new plan now. Idempotent. Called by the
 * development confirm and, in production, by the payment provider's webhook for
 * the charge's provider reference.
 */
export async function markPassPaid(chargeId: string): Promise<boolean> {
  const done = await tx(async () => {
    const c = await one<any>(`SELECT * FROM subscription_charge WHERE id = $1 FOR UPDATE`, [chargeId]);
    if (!c || !['qris', 'ewallet', 'card', 'credit'].includes(c.via)) return null;
    if (c.state === 'paid') return { already: true, c };
    if (c.state !== 'pending') return null;
    await query(`UPDATE subscription_charge SET state = 'paid', paid_at = now() WHERE id = $1`, [chargeId]);
    const s = await one<any>(`SELECT * FROM subscription WHERE id = $1 FOR UPDATE`, [c.subscription_id]);
    if (c.switch_to_plan_id) {
      // The switch: the new plan from now, for its own window. The charges it replaces end here: their unused
      // value was credited, so they must count neither for a later switch nor as a renewal already paid.
      await query(
        `UPDATE subscription_charge SET period_end = $3 WHERE subscription_id = $1 AND id <> $2 AND state = 'paid' AND period_end > $3`,
        [s.id, c.id, c.period_start]);
      await query(
        `UPDATE subscription SET status = 'active', plan_id = $2, current_period_start = $3, current_period_end = $4,
                renew_attempts = 0, renew_error = NULL, renew_next_at = NULL WHERE id = $1`,
        [s.id, c.switch_to_plan_id, c.period_start, c.period_end]);
    } else {
      const contiguous = s.status === 'active' && s.current_period_end && new Date(s.current_period_end) >= new Date(c.period_start);
      await query(
        `UPDATE subscription SET status = 'active',
                current_period_start = CASE WHEN $2 THEN current_period_start ELSE $3 END,
                current_period_end = GREATEST(COALESCE(current_period_end, $4), $4),
                renew_attempts = 0, renew_error = NULL, renew_next_at = NULL
          WHERE id = $1`,
        [s.id, contiguous, c.period_start, c.period_end],
      );
    }
    logger.info({ subscription: s.id, charge: chargeId, switch: !!c.switch_to_plan_id, renewal: c.auto_renewal }, 'membership pass paid');
    return { already: false, c, s };
  });
  if (!done) return false;
  // An automatic renewal went through: tell the driver.
  if (!done.already && done.c.auto_renewal && done.s) {
    await tellDriver(done.s.app_driver_id, 'membership.renewed', `membership.renewed:${chargeId}`,
      (plan, day) => ({ title: `${plan} diperpanjang sampai ${day}`, body: `Rp ${Number(done.c.total_idr).toLocaleString('id-ID')} ditagihkan. Matikan perpanjangan otomatis kapan saja di Akun.` }),
      (plan, day) => ({ title: `${plan} renewed until ${day}`, body: `Rp ${Number(done.c.total_idr).toLocaleString('id-ID')} charged. Turn off automatic renewal any time under Account.` }),
      done.s.id, new Date(done.c.period_end)).catch(() => {});
  }
  return true;
}

export async function markPassPaidByProviderRef(providerRef: string): Promise<boolean> {
  const c = await one<{ id: string }>(`SELECT id FROM subscription_charge WHERE provider_ref = $1`, [providerRef]);
  return c ? markPassPaid(c.id) : false;
}

/**
 * The acquirer reports a pass payment that will not complete (expired, denied or
 * cancelled). An automatic renewal is retried by the worker; a checkout in front of
 * the driver simply stays unpaid (they see it in the app).
 */
export async function passPaymentFailed(chargeId: string, status: string): Promise<void> {
  const c = await one<any>(`SELECT id, subscription_id, auto_renewal, state FROM subscription_charge WHERE id = $1`, [chargeId]);
  if (!c || c.state !== 'pending' || !c.auto_renewal) return;
  await query(`UPDATE subscription_charge SET state = 'void' WHERE id = $1 AND state = 'pending'`, [chargeId]);
  const why = /expire|DID_NOT_AUTHORIZE/i.test(status) ? 'the confirmation expired before you confirmed it'
    : /deny|denied|declin/i.test(status) ? 'the payment was refused' : /cancel/i.test(status) ? 'the payment was cancelled' : `the payment did not complete (${status})`;
  await query(`UPDATE subscription SET renew_error = $2, renew_attempts = renew_attempts + 1, renew_next_at = now() + interval '1 hour' WHERE id = $1`, [c.subscription_id, `Renewal: ${why}.`]);
}

/** Development / mock provider only: act as if the driver paid. */
export async function confirmPassPayment(p: DriverPrincipal, id: string) {
  const c = await ownCharge(p, id);
  if (!c) return { ok: false, error: 'Transaksi tidak ditemukan.' };
  if (config.env === 'production') return { ok: false, error: 'Not available in production.' };
  if (c.provider && c.provider !== 'mock') return { ok: false, error: 'Menunggu konfirmasi pembayaran dari penyedia QRIS.' };
  await markPassPaid(c.id);
  return { ok: true };
}

// ─────────────────────────────────────────── workers

async function tellDriver(
  appDriverId: string, kind: string, dedupe: string,
  id: (plan: string, day: string) => { title: string; body: string }, en: (plan: string, day: string) => { title: string; body: string },
  subscriptionId: string, day: Date,
): Promise<number> {
  const devices = (await many<{ id: string }>(`SELECT id FROM driver_device WHERE app_driver_id = $1`, [appDriverId])).map((d) => d.id);
  if (!devices.length) return 0;
  const plan = (await one<{ name: string }>(`SELECT pl.name FROM subscription s JOIN subscription_plan pl ON pl.id = s.plan_id WHERE s.id = $1`, [subscriptionId]))?.name ?? 'Pass';
  const dayId = day.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long' });
  const dayEn = day.toLocaleDateString('en-GB', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long' });
  return notifyDevices(devices, kind, dedupe, { id: id(plan, dayId), en: en(plan, dayEn), url: '/app/#account', tag: `membership-${subscriptionId}` });
}

/**
 * Worker: renew passes that renew automatically, from a day before they end until
 * the day of grace after, with the saved card or linked e-wallet chosen.
 */
export async function renewPasses(): Promise<{ renewed: number; waiting: number; failed: number }> {
  const due = await many<any>(
    `SELECT s.id, s.org_id, s.app_driver_id, s.plan_id, s.current_period_end, s.renew_method_id, s.renew_attempts,
            pl.name AS plan_name, pl.monthly_fee_idr, pl.active AND pl.offered_in_app AS offered, o.pkp, d.phone,
            m.kind AS method_kind
       FROM subscription s JOIN subscription_plan pl ON pl.id = s.plan_id JOIN organisation o ON o.id = s.org_id
       JOIN app_driver d ON d.id = s.app_driver_id
       LEFT JOIN driver_card m ON m.id = s.renew_method_id AND m.removed_at IS NULL
      WHERE s.billing = 'qris' AND s.status = 'active' AND s.auto_renew
        AND s.current_period_end <= now() + interval '1 day' AND s.current_period_end > now() - interval '1 day'
        AND (s.renew_next_at IS NULL OR s.renew_next_at <= now())
        -- Not already renewed, nor a renewal waiting for the driver, nor a checkout the driver opened just now.
        AND NOT EXISTS (SELECT 1 FROM subscription_charge c WHERE c.subscription_id = s.id AND c.period_start >= s.current_period_end AND c.period_end > c.period_start
                          AND (c.state = 'paid' OR (c.state = 'pending' AND (c.auto_renewal OR c.created_at > now() - interval '30 minutes'))))
      ORDER BY s.current_period_end LIMIT 100`,
  );
  const out = { renewed: 0, waiting: 0, failed: 0 };
  for (const s of due) {
    const stop = async (why: string, en: string) => {
      await query(`UPDATE subscription SET auto_renew = false, renew_error = $2, renew_next_at = NULL WHERE id = $1`, [s.id, en]);
      await tellDriver(s.app_driver_id, 'membership.renewal_stopped', `membership.renewal_stopped:${s.id}:${new Date(s.current_period_end).toISOString()}`,
        (plan, day) => ({ title: `${plan} tidak bisa diperpanjang otomatis`, body: `${why} Perpanjang di aplikasi sebelum ${day}.` }),
        (plan, day) => ({ title: `${plan} can't renew automatically`, body: `${en} Renew in the app before ${day}.` }),
        s.id, new Date(s.current_period_end)).catch(() => {});
      out.failed++;
    };
    if (!s.offered) { await stop('Paket ini tidak ditawarkan lagi.', 'This plan is no longer offered.'); continue; }
    if (!s.renew_method_id || !s.method_kind) { await stop('Kartu atau e-wallet untuk perpanjangan sudah dihapus.', 'The card or e-wallet chosen for renewal was removed.'); continue; }
    let acq: Awaited<ReturnType<typeof paymentsFor>>;
    try { acq = await paymentsFor(s.org_id); } catch { await query(`UPDATE subscription SET renew_next_at = now() + interval '1 hour' WHERE id = $1`, [s.id]); continue; }
    const start = new Date(s.current_period_end);
    const end = new Date(start.getTime() + PASS_MS);
    const tax = feeTax(s.monthly_fee_idr, s.pkp);
    // A checkout the driver abandoned for the same window makes way (before any money moves, so the renewal's record always fits).
    await query(`UPDATE subscription_charge SET state = 'void' WHERE subscription_id = $1 AND state = 'pending' AND NOT auto_renewal AND period_start = $2`, [s.id, start]);
    try {
      const started = await startPayment(acq, {
        appDriverId: s.app_driver_id, customerPhone: s.phone, returnUrl: '/app/paid.html', allowHold: false,
        ...(s.method_kind === 'ewallet' ? { walletId: s.renew_method_id } : { savedCardId: s.renew_method_id, channel: 'CARD' }),
        referenceId: `membership-renew:${s.id}:${Date.now()}`, amountIdr: tax.total, description: `${await appNameFor(s.org_id)} ${s.plan_name} (renewal)`,
      });
      const ch = await one<{ id: string }>(
        `INSERT INTO subscription_charge (subscription_id, org_id, period_start, period_end, fee_idr, dpp_idr, ppn_idr, total_idr, via, provider_ref, provider, integration_id,
                                          channel, checkout_url, driver_card_id, auto_renewal)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true) RETURNING id`,
        [s.id, s.org_id, start, end, s.monthly_fee_idr, tax.dpp, tax.ppn, tax.total, started.method, started.providerRef, acq.provider.name, acq.resolved.integrationId,
         started.channel, started.checkoutUrl, s.renew_method_id],
      );
      await logPaymentCreated(acq.resolved, s.org_id, started.providerRef, tax.total, 'pass renewal', started.channel);
      if (started.immediate === 'captured') { await markPassPaid(ch!.id); out.renewed++; continue; }
      // A PIN in the e-wallet or 3-D Secure: only the driver can finish it. The settlement notification completes it.
      const n = CHANNEL_LABEL[started.channel as keyof typeof CHANNEL_LABEL] ?? started.channel;
      await query(`UPDATE subscription SET renew_error = $2 WHERE id = $1`, [s.id, `Renewal waiting for you to confirm the payment in ${n}.`]);
      await tellDriver(s.app_driver_id, 'membership.renewal_confirm', `membership.renewal_confirm:${ch!.id}`,
        (plan) => ({ title: `Konfirmasi perpanjangan ${plan}`, body: `Buka Akun di aplikasi dan konfirmasi pembayaran di ${n}.` }),
        (plan) => ({ title: `Confirm your ${plan} renewal`, body: `Open Account in the app and confirm the payment in ${n}.` }),
        s.id, start).catch(() => {});
      out.waiting++;
    } catch (e) {
      if (!(e instanceof MethodUnavailable)) {
        logger.warn({ subscription: s.id, err: (e as Error).message }, 'pass renewal failed — retried');
        await query(`UPDATE subscription SET renew_next_at = now() + interval '30 minutes' WHERE id = $1`, [s.id]);
        continue;
      }
      // The card or the e-wallet link has ended: renewal cannot go on with it.
      if (e.code === 'saved_card_ended' || e.code === 'wallet_link_ended') { await stop(e.message, 'The saved card or linked e-wallet no longer works.'); continue; }
      // Declined (balance, limit, bank): retried a few times until the pass ends.
      const attempt = Number(s.renew_attempts) + 1;
      const wait = RENEW_BACKOFF_MS[Math.min(attempt - 1, RENEW_BACKOFF_MS.length - 1)]!;
      await query(`UPDATE subscription SET renew_attempts = $2, renew_error = $3, renew_next_at = now() + make_interval(secs => $4::int) WHERE id = $1`,
        [s.id, attempt, `Renewal declined: ${e.message}`, Math.round(wait / 1000)]);
      if (attempt === 1) {
        await tellDriver(s.app_driver_id, 'membership.renewal_failed', `membership.renewal_failed:${s.id}:${start.toISOString()}`,
          (plan, day) => ({ title: `Perpanjangan ${plan} gagal`, body: `${e.message} Kami coba lagi; atau perpanjang di aplikasi sebelum ${day}.` }),
          (plan, day) => ({ title: `${plan} renewal failed`, body: `The payment was declined. We'll try again; or renew in the app before ${day}.` }),
          s.id, start).catch(() => {});
      }
      out.failed++;
    }
  }
  return out;
}

/** Worker: remind a driver three days before a pass ends (once per window); expire passes that are over. */
export async function remindEndingPasses(): Promise<number> {
  const rows = await many<any>(
    `SELECT s.id, s.app_driver_id, s.current_period_end, pl.name, s.auto_renew AND m.id IS NOT NULL AS renews,
            m.kind, m.channel, m.brand, m.last4, m.account_label
       FROM subscription s JOIN subscription_plan pl ON pl.id = s.plan_id
       LEFT JOIN driver_card m ON m.id = s.renew_method_id AND m.removed_at IS NULL
      WHERE s.billing = 'qris' AND s.status = 'active'
        AND s.current_period_end BETWEEN now() AND now() + interval '3 days'
        AND NOT EXISTS (SELECT 1 FROM subscription_charge c WHERE c.subscription_id = s.id AND c.state = 'paid' AND c.period_start >= s.current_period_end AND c.period_end > c.period_start)`,
  );
  let n = 0;
  for (const r of rows) {
    const via = r.renews ? methodLabel(r) : '';
    n += await tellDriver(r.app_driver_id, 'membership.ending', `membership.ending:${r.id}:${new Date(r.current_period_end).toISOString()}`,
      (plan, day) => (r.renews ? { title: `${plan} diperpanjang otomatis ${day}`, body: `Dengan ${via}. Matikan kapan saja di Akun.` } : { title: `${plan} berakhir ${day}`, body: 'Perpanjang di aplikasi agar harga member tetap berlaku.' }),
      (plan, day) => (r.renews ? { title: `${plan} renews on ${day}`, body: `With ${via}. Turn it off any time under Account.` } : { title: `${plan} ends ${day}`, body: 'Renew in the app to keep member prices.' }),
      r.id, new Date(r.current_period_end));
  }
  // Passes whose window (and the day of grace for a renewal) is over.
  await query(`UPDATE subscription SET status = 'expired' WHERE billing = 'qris' AND status = 'active' AND current_period_end < now() - interval '1 day'`);
  return n;
}
