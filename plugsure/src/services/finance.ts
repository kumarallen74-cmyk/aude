import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { byId, type Resolved } from '../integrations/store.js';
import { providerFor, applyGatewayPayment } from './payments/registry.js';
import { XenditProvider, type XenditTransaction } from './payments/xendit.js';
import { DuitkuProvider } from './payments/duitku.js';
import { estimateQrisMdrIdr } from './payments/provider.js';
import { refundWindowDays, refundDaysLeft } from './refund-windows.js';
import { LEGACY_CURRENCY } from '../domain/money.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { opsAlertOrgs } from './worker-health.js';

/**
 * Finance (v1.12.0): the payment gateway's side of the money, per gateway account (a payments integration).
 *
 *   sync          syncTransactions(): the account's transactions at Xendit (GET /transactions, newest first, cursor
 *                 pages), changed since the last run, into gateway_transaction — with Xendit's fee, VAT, withholding
 *                 tax, net amount and settlement status — and matched to PlugSure's payments by the reference PlugSure
 *                 gave Xendit (payment_intent.provider_ref; passes: subscription_charge.provider_ref; refunds:
 *                 payment_intent.refund_ref). Every 15 minutes; a long backlog continues where it stopped.
 *   balance       snapshotBalance(): the cash balance at the gateway, hourly.
 *   reconcile     reconcile(): the gateway's ledger against PlugSure's payments over the last 35 days; differences
 *                 become reconciliation_exception rows (open until resolved; cleared ones close themselves) and an
 *                 alert to the account's organisation. A payment paid at the gateway that PlugSure never heard of
 *                 can be applied from here exactly as its lost notification would have been (applyMissing).
 *   reports       overview(), transactions(), receivables(), payables(), fees(), exceptions(), monthClose().
 *
 * Accounts: an operator sees its own payments account(s); a platform administrator also sees the platform's (org NULL),
 * which takes the payments of every operator without its own. Queries run unscoped and filter by account id: the
 * caller's accounts are checked by the route (accountsFor). Xendit only for now; Duitku (phase 2) adds its own sync.
 */

export class FinanceError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const FINANCE_PROVIDERS = ['xendit', 'duitku'] as const;
const FINANCE_KINDS = ['payments', 'payments_fallback'];
const LOOKBACK_DAYS = 35;
let MAX_PAGES = 40;
/** For tests: a smaller page limit per run. */
export function setMaxPages(n: number) { MAX_PAGES = n; }
/** Overlap with the previous run: a transaction updated while the last run was paging is not missed. */
const OVERLAP_MS = 10 * 60_000;

export interface Account {
  id: string; orgId: string | null; orgName: string | null; provider: string; environment: string | null;
  archived: boolean; testMode: boolean; label: string;
  /** (v1.13.0) The fallback account (Duitku), used when the main acquirer does not answer. */
  fallback: boolean;
}
export const PROVIDER_LABEL: Record<string, string> = { xendit: 'Xendit', duitku: 'Duitku' };

/** The gateway accounts a caller may see: its organisation's own, and the platform's for platform administrators. */
export async function accountsFor(orgId: string, platformAdmin: boolean): Promise<Account[]> {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT i.id, i.org_id, o.name AS org_name, i.provider, i.kind, i.settings->>'environment' AS environment, i.archived_at, i.test_mode, i.country_code
       FROM integration i LEFT JOIN organisation o ON o.id = i.org_id
      WHERE i.kind = ANY($4::text[]) AND i.provider = ANY($3::text[])
        AND (i.org_id = $1 OR ($2 AND i.org_id IS NULL))
        AND (i.archived_at IS NULL OR i.archived_at > now() - interval '120 days')
      ORDER BY (i.org_id IS NULL) DESC, i.archived_at NULLS FIRST, i.updated_at DESC`,
    [orgId, platformAdmin, [...FINANCE_PROVIDERS], FINANCE_KINDS]));
  return rows.map((r) => ({
    id: r.id, orgId: r.org_id, orgName: r.org_name, provider: r.provider, environment: r.environment,
    archived: Boolean(r.archived_at), testMode: r.test_mode === true || r.environment === 'sandbox',
    fallback: r.kind === 'payments_fallback',
    label: `${r.org_id ? r.org_name ?? 'Operator' : 'PlugSure (platform)'} · ${PROVIDER_LABEL[r.provider] ?? r.provider}${r.kind === 'payments_fallback' ? ' (fallback)' : ''}${r.environment === 'sandbox' ? ' (sandbox)' : ''}${r.archived_at ? ' · archived' : ''}`,
  }));
}

/** The caller's account by id, or 404. */
export async function accountFor(orgId: string, platformAdmin: boolean, id: string): Promise<Account> {
  const a = (await accountsFor(orgId, platformAdmin)).find((x) => x.id === id);
  if (!a) throw new FinanceError(404, 'No such payments account.');
  return a;
}

async function xenditOf(integrationId: string): Promise<{ r: Resolved; x: XenditProvider } | null> {
  const r = await byId(integrationId);
  if (!r || r.provider !== 'xendit') return null;
  const p = providerFor(r);
  return p instanceof XenditProvider ? { r, x: p } : null;
}
async function duitkuOf(integrationId: string): Promise<{ r: Resolved; d: DuitkuProvider } | null> {
  const r = await byId(integrationId);
  if (!r || r.provider !== 'duitku') return null;
  try {
    const p = providerFor(r);
    return p instanceof DuitkuProvider ? { r, d: p } : null;
  } catch { return null; }
}

// ─────────────────────────────────────────── sync

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const KIND: Record<string, string> = {
  PAYMENT: 'payment', REFUND: 'refund', DISBURSEMENT: 'payout', BATCH_DISBURSEMENT: 'payout', WITHDRAWAL: 'payout', REMITTANCE_PAYOUT: 'payout',
  TRANSFER: 'transfer', TRANSFER_IN: 'transfer', TRANSFER_OUT: 'transfer', PLATFORM_FEE: 'fee',
};

/** A Xendit transaction as a ledger row. Exported for tests. */
export function rowOf(t: XenditTransaction) {
  const amount = num(t.amount);
  const fee = num(t.fee?.xendit_fee), vat = num(t.fee?.value_added_tax);
  const wht = num(t.fee?.xendit_withholding_tax) + num(t.fee?.third_party_withholding_tax);
  const net = t.net_amount != null && Number.isFinite(Number(t.net_amount)) ? Number(t.net_amount) : null;
  const settle = t.settlement_status ? String(t.settlement_status).toLowerCase() : null;
  return {
    externalId: String(t.id), kind: KIND[String(t.type ?? '').toUpperCase()] ?? 'other', gatewayType: t.type ? String(t.type).slice(0, 40) : null,
    status: String(t.status ?? 'PENDING').toLowerCase().slice(0, 20), cashflow: String(t.cashflow).toUpperCase() === 'MONEY_OUT' ? 'out' : 'in',
    channelCategory: t.channel_category ? String(t.channel_category).slice(0, 40) : null, channelCode: t.channel_code ? String(t.channel_code).slice(0, 60) : null,
    referenceId: t.reference_id ? String(t.reference_id).slice(0, 255) : null, productId: t.product_id ? String(t.product_id).slice(0, 255) : null,
    currency: String(t.currency ?? LEGACY_CURRENCY).toUpperCase().slice(0, 3), amount, fee, vat, wht,
    // Xendit's net amount; computed when absent (money in: amount − fee − VAT; money out: amount + fee + VAT).
    net: net ?? (String(t.cashflow).toUpperCase() === 'MONEY_OUT' ? amount + fee + vat : amount - fee - vat),
    settlement: settle && ['pending', 'settled', 'early_settled'].includes(settle) ? settle : null,
    estimatedSettlementAt: t.estimated_settlement_time ? new Date(t.estimated_settlement_time) : null,
    createdAt: new Date(t.created ?? t.updated ?? Date.now()), updatedAt: new Date(t.updated ?? t.created ?? Date.now()),
  };
}

type LedgerRow = ReturnType<typeof rowOf>;
async function upsert(r: Resolved, t: XenditTransaction): Promise<void> {
  await upsertRow(r, rowOf(t), trimmed(t));
}
async function upsertRow(r: Resolved, v: LedgerRow, raw: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO gateway_transaction (integration_id, org_id, provider, external_id, kind, gateway_type, status, cashflow, channel_category, channel_code,
            reference_id, product_id, currency, amount, fee, vat, withholding_tax, net_amount, settlement_status, estimated_settlement_at,
            settled_seen_at, gateway_created_at, gateway_updated_at, raw, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             CASE WHEN $19 IN ('settled', 'early_settled') THEN now() END, $21, $22, $23, now())
     ON CONFLICT (integration_id, external_id) DO UPDATE SET
       kind = EXCLUDED.kind, gateway_type = EXCLUDED.gateway_type, status = EXCLUDED.status, cashflow = EXCLUDED.cashflow,
       channel_category = EXCLUDED.channel_category, channel_code = EXCLUDED.channel_code, reference_id = EXCLUDED.reference_id,
       product_id = EXCLUDED.product_id, currency = EXCLUDED.currency, amount = EXCLUDED.amount, fee = EXCLUDED.fee, vat = EXCLUDED.vat,
       withholding_tax = EXCLUDED.withholding_tax, net_amount = EXCLUDED.net_amount, settlement_status = EXCLUDED.settlement_status,
       estimated_settlement_at = EXCLUDED.estimated_settlement_at,
       settled_seen_at = COALESCE(gateway_transaction.settled_seen_at, EXCLUDED.settled_seen_at),
       gateway_updated_at = EXCLUDED.gateway_updated_at, raw = EXCLUDED.raw, synced_at = now()`,
    [r.integrationId, r.orgId, r.provider, v.externalId, v.kind, v.gatewayType, v.status, v.cashflow, v.channelCategory, v.channelCode,
      v.referenceId, v.productId, v.currency, v.amount, v.fee, v.vat, v.wht, v.net, v.settlement, v.estimatedSettlementAt,
      v.createdAt, v.updatedAt, JSON.stringify(raw)]);
}

/** Raw payloads kept small: the ledger is not an archive of Xendit's answers. */
function trimmed(t: XenditTransaction): Record<string, unknown> {
  const s = JSON.stringify(t);
  return s.length <= 3000 ? (t as unknown as Record<string, unknown>) : { id: t.id, type: t.type, status: t.status, truncated: true };
}

/** Link ledger rows of this account to PlugSure's payments, passes and refunds (rows not linked yet). */
async function match(integrationId: string): Promise<number> {
  const a = await query(
    `UPDATE gateway_transaction g SET payment_intent_id = p.id, matched = 'intent'
       FROM payment_intent p
      WHERE g.integration_id = $1 AND g.matched IS NULL AND g.kind = 'payment' AND g.reference_id IS NOT NULL
        AND p.provider = g.provider AND p.provider_ref = g.reference_id`, [integrationId]);
  const b = await query(
    `UPDATE gateway_transaction g SET subscription_charge_id = s.id, matched = 'pass'
       FROM subscription_charge s
      WHERE g.integration_id = $1 AND g.matched IS NULL AND g.kind = 'payment' AND g.reference_id IS NOT NULL
        AND s.provider_ref = g.reference_id AND (s.provider = g.provider OR s.provider IS NULL)`, [integrationId]);
  const c = await query(
    `UPDATE gateway_transaction g SET payment_intent_id = p.id, matched = 'refund'
       FROM payment_intent p
      WHERE g.integration_id = $1 AND g.matched IS NULL AND g.kind = 'refund'
        AND p.provider = g.provider AND p.refund_ref IS NOT NULL AND p.refund_ref IN (g.external_id, g.product_id, g.reference_id)`, [integrationId]);
  return (a.rowCount ?? 0) + (b.rowCount ?? 0) + (c.rowCount ?? 0);
}

export interface SyncResult { integrationId: string; ok: boolean; rows: number; complete: boolean; error?: string }

/** Sync one account's transactions changed since the last run (the first run: the last 35 days). */
export async function syncTransactions(integrationId: string, now = new Date()): Promise<SyncResult> {
  return outsideRequestScope(async () => {
    const dk = await duitkuOf(integrationId);
    if (dk) return syncDuitku(integrationId, dk.r, dk.d, now);
    const g = await xenditOf(integrationId);
    if (!g) return { integrationId, ok: false, rows: 0, complete: true, error: 'not a Xendit or Duitku payments account' };
    const st = await one<{ watermark: Date | null; resume_after_id: string | null; resume_from: Date | null }>(
      `SELECT watermark, resume_after_id, resume_from FROM gateway_sync_state WHERE integration_id = $1`, [integrationId]);
    const from = st?.resume_after_id
      ? st.resume_from
      : st?.watermark ? new Date(st.watermark.getTime() - OVERLAP_MS) : new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
    let after = st?.resume_after_id ?? null;
    let rows = 0, newest = st?.watermark ?? null, complete = false;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await g.x.listTransactions({ updatedFrom: from, afterId: after, limit: 50 });
        for (const t of res.data) {
          if (!t?.id) continue;
          await upsert(g.r, t);
          rows++;
          const u = new Date(t.updated ?? t.created ?? 0);
          if (!Number.isNaN(u.getTime()) && (!newest || u > newest)) newest = u;
        }
        if (!res.hasMore || !res.data.length) { complete = true; break; }
        after = String(res.data[res.data.length - 1]!.id);
      }
      await match(integrationId);
      await query(
        `INSERT INTO gateway_sync_state (integration_id, org_id, watermark, resume_after_id, resume_from, last_run_at, last_ok, last_error, last_rows)
         VALUES ($1, $2, $3, $4, $5, now(), true, NULL, $6)
         ON CONFLICT (integration_id) DO UPDATE SET watermark = EXCLUDED.watermark, resume_after_id = EXCLUDED.resume_after_id,
           resume_from = EXCLUDED.resume_from, last_run_at = now(), last_ok = true, last_error = NULL, last_rows = EXCLUDED.last_rows`,
        // Incomplete: keep the old watermark and continue from the cursor next time; complete: advance it.
        [integrationId, g.r.orgId, complete ? newest ?? now : st?.watermark ?? null, complete ? null : after, complete ? null : from, rows]);
      return { integrationId, ok: true, rows, complete };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      await query(
        `INSERT INTO gateway_sync_state (integration_id, org_id, last_run_at, last_ok, last_error, last_rows) VALUES ($1, $2, now(), false, $3, $4)
         ON CONFLICT (integration_id) DO UPDATE SET last_run_at = now(), last_ok = false, last_error = EXCLUDED.last_error, last_rows = EXCLUDED.last_rows`,
        [integrationId, g.r.orgId, msg, rows]);
      logger.warn({ integrationId, err: msg }, 'finance: transaction sync failed');
      return { integrationId, ok: false, rows, complete: false, error: msg };
    }
  });
}

// ─────────────────────────────────────────── Duitku (v1.13.0): no ledger API, so the ledger is built from PlugSure's payments

/** Duitku's settlement schedule (its dashboard documentation): QRIS and e-wallets D+2, cards 4 working days. */
const DUITKU_SETTLE_DAYS: Record<string, number> = { QRIS: 2, DANA: 2, SHOPEEPAY: 2, LINKAJA: 2, CARD: 4 };
/** `days` working days (Monday to Friday) after a moment: Duitku's expected settlement, public holidays aside. */
export function addWorkingDays(from: Date, days: number): Date {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

/**
 * One Duitku account: (1) its pending payments asked about (transactionStatus): one Duitku reports paid is applied as
 * its lost callback would have been; (2) its paid payments of the last 35 days not in the ledger yet, added with Duitku's
 * amount and fee; (3) the expected settlement (computed: Duitku reports none) passed → settled.
 */
async function syncDuitku(integrationId: string, r: Resolved, d: DuitkuProvider, now: Date): Promise<SyncResult> {
  let rows = 0;
  try {
    const pending = await many<{ provider_ref: string }>(
      `SELECT provider_ref FROM payment_intent WHERE integration_id = $1 AND provider = 'duitku' AND state = 'pending' AND provider_ref IS NOT NULL
          AND created_at BETWEEN now() - interval '2 days' AND now() - interval '3 minutes' ORDER BY created_at LIMIT 100`, [integrationId]);
    for (const p of pending) {
      const st = await d.paymentStatus(p.provider_ref);
      if (st?.status !== 'captured') continue;
      await applyGatewayPayment(r, { providerRef: p.provider_ref, paid: true, status: `${st.acquirerStatus} (status check)`, amountMinor: st.amountMinor, paymentId: st.providerPaymentId, currency: LEGACY_CURRENCY });
    }
    const paid = await many<{ provider_ref: string; channel: string | null; paid_at: Date | null; created_at: Date }>(
      `SELECT p.provider_ref, p.channel, p.paid_at, p.created_at FROM payment_intent p
        WHERE p.integration_id = $1 AND p.provider = 'duitku' AND p.state IN ('captured', 'refunded') AND p.provider_ref IS NOT NULL
          AND COALESCE(p.paid_at, p.created_at) > now() - make_interval(days => $2)
          AND NOT EXISTS (SELECT 1 FROM gateway_transaction g WHERE g.integration_id = $1 AND g.external_id = p.provider_ref)
        ORDER BY p.created_at LIMIT 200`, [integrationId, LOOKBACK_DAYS]);
    for (const p of paid) {
      const st = await d.paymentStatus(p.provider_ref);
      if (!st) continue; // unknown at Duitku: the reconciliation reports it (missing at the gateway)
      const raw = (st.raw ?? {}) as { fee?: unknown; reference?: unknown };
      const amount = st.amountMinor ?? 0, fee = num(raw.fee);
      const at = p.paid_at ?? p.created_at;
      const ch = String(p.channel ?? 'QRIS').toUpperCase();
      const expected = addWorkingDays(at, DUITKU_SETTLE_DAYS[ch] ?? 2);
      await upsertRow(r, {
        externalId: p.provider_ref, kind: 'payment', gatewayType: 'PAYMENT', status: st.status === 'captured' ? 'success' : st.status === 'pending' ? 'pending' : 'failed',
        cashflow: 'in', channelCategory: ch === 'QRIS' ? 'QR_CODE' : ch === 'CARD' ? 'CARDS' : 'EWALLET', channelCode: ch, referenceId: p.provider_ref,
        productId: raw.reference ? String(raw.reference) : null, currency: LEGACY_CURRENCY, amount, fee, vat: 0, wht: 0, net: amount - fee,
        settlement: expected <= now ? 'settled' : 'pending', estimatedSettlementAt: expected, createdAt: at, updatedAt: now,
      }, { source: 'transactionStatus', ...(st.raw as Record<string, unknown>) });
      rows++;
    }
    // The expected time passed: settled (computed from Duitku's schedule, Duitku reports no settlement).
    await query(`UPDATE gateway_transaction SET settlement_status = 'settled', settled_seen_at = COALESCE(settled_seen_at, now())
                  WHERE integration_id = $1 AND settlement_status = 'pending' AND estimated_settlement_at <= now()`, [integrationId]);
    await match(integrationId);
    await query(
      `INSERT INTO gateway_sync_state (integration_id, org_id, watermark, last_run_at, last_ok, last_error, last_rows) VALUES ($1, $2, now(), now(), true, NULL, $3)
       ON CONFLICT (integration_id) DO UPDATE SET watermark = now(), last_run_at = now(), last_ok = true, last_error = NULL, last_rows = EXCLUDED.last_rows`,
      [integrationId, r.orgId, rows]);
    return { integrationId, ok: true, rows, complete: true };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    await query(
      `INSERT INTO gateway_sync_state (integration_id, org_id, last_run_at, last_ok, last_error, last_rows) VALUES ($1, $2, now(), false, $3, $4)
       ON CONFLICT (integration_id) DO UPDATE SET last_run_at = now(), last_ok = false, last_error = EXCLUDED.last_error, last_rows = EXCLUDED.last_rows`,
      [integrationId, r.orgId, msg, rows]);
    logger.warn({ integrationId, err: msg }, 'finance: Duitku sync failed');
    return { integrationId, ok: false, rows, complete: false, error: msg };
  }
}

/** Every Xendit payments account in use (and those archived recently, whose money is still settling). */
async function syncedAccounts(): Promise<string[]> {
  const rows = await outsideRequestScope(() => many<{ id: string }>(
    `SELECT id FROM integration WHERE kind = ANY($2::text[]) AND provider = ANY($1::text[]) AND secrets_sealed IS NOT NULL
        AND ((enabled AND archived_at IS NULL) OR archived_at > now() - interval '60 days')`, [[...FINANCE_PROVIDERS], FINANCE_KINDS]));
  return rows.map((r) => r.id);
}

export async function syncAll(): Promise<SyncResult[]> {
  const out: SyncResult[] = [];
  for (const id of await syncedAccounts()) out.push(await syncTransactions(id));
  return out;
}

export async function snapshotBalance(integrationId: string): Promise<number | null> {
  return outsideRequestScope(async () => {
    const dk = await duitkuOf(integrationId);
    if (dk) {
      try {
        const b = await dk.d.accountBalance();
        if (!b) return null;
        await query(`INSERT INTO gateway_balance_snapshot (integration_id, org_id, account_type, currency, balance) VALUES ($1, $2, 'EFFECTIVE', $4, $3)`, [integrationId, dk.r.orgId, b.effective, LEGACY_CURRENCY]);
        return b.effective;
      } catch (e) {
        logger.warn({ integrationId, err: (e as Error).message }, 'finance: Duitku balance not read');
        return null;
      }
    }
    const g = await xenditOf(integrationId);
    if (!g) return null;
    try {
      const b = await g.x.accountBalance('CASH');
      // Xendit's Indonesian accounts hold rupiah (the only currency the rails take: integrations/store.ts).
      await query(`INSERT INTO gateway_balance_snapshot (integration_id, org_id, account_type, currency, balance) VALUES ($1, $2, 'CASH', $4, $3)`, [integrationId, g.r.orgId, b, LEGACY_CURRENCY]);
      return b;
    } catch (e) {
      logger.warn({ integrationId, err: (e as Error).message }, 'finance: balance not read');
      return null;
    }
  });
}

export async function snapshotAll(): Promise<void> {
  for (const id of await syncedAccounts()) await snapshotBalance(id);
}

// ─────────────────────────────────────────── reconciliation

export type ExceptionKind = 'missing_in_plugsure' | 'missing_at_gateway' | 'amount_mismatch' | 'pending_too_long' | 'settlement_overdue' | 'refund_mismatch';
export const EXCEPTION_TEXT: Record<ExceptionKind, string> = {
  missing_in_plugsure: 'Paid at the gateway, not recorded as paid in PlugSure (a lost notification)',
  missing_at_gateway: 'Paid in PlugSure, not found in the gateway\'s ledger',
  amount_mismatch: 'The gateway\'s amount differs from PlugSure\'s',
  pending_too_long: 'Pending at the gateway for more than a day',
  settlement_overdue: 'Past its expected settlement date, not settled',
  refund_mismatch: 'Refund status differs between the gateway and PlugSure',
};

interface Found { kind: ExceptionKind; refKey: string; gatewayTransactionId?: string | null; paymentIntentId?: string | null; amount?: number | null; detail: Record<string, unknown> }

/** Compare the account's ledger with PlugSure over the last 35 days; record what differs. */
export async function reconcile(integrationId: string): Promise<{ open: number; found: number; cleared: number }> {
  return outsideRequestScope(async () => {
    const acct = await one<{ org_id: string | null; provider: string }>(`SELECT org_id, provider FROM integration WHERE id = $1`, [integrationId]);
    if (!acct) throw new FinanceError(404, 'No such payments account.');
    const since = `now() - interval '${LOOKBACK_DAYS} days'`;
    const found: Found[] = [];
    // 1. Paid at the gateway, but PlugSure has no paid payment for it (15 minutes' grace for the notification).
    for (const g of await many<any>(
      `SELECT g.id, g.reference_id, g.product_id, g.amount, g.channel_code, g.gateway_created_at, g.matched, p.id AS intent_id, p.state AS intent_state
         FROM gateway_transaction g LEFT JOIN payment_intent p ON p.id = g.payment_intent_id
        WHERE g.integration_id = $1 AND g.kind = 'payment' AND g.status = 'success' AND g.cashflow = 'in'
          AND g.gateway_created_at > ${since} AND g.gateway_created_at < now() - interval '15 minutes'
          AND (g.matched IS NULL OR (g.matched = 'intent' AND p.state IN ('pending', 'expired', 'failed')))`, [integrationId])) {
      found.push({
        kind: 'missing_in_plugsure', refKey: `g:${g.id}`, gatewayTransactionId: String(g.id), paymentIntentId: g.intent_id, amount: num(g.amount),
        detail: { reference: g.reference_id, channel: g.channel_code, intentState: g.intent_state ?? null, plugsureReference: /^ps-[0-9a-f]{32}$/.test(String(g.reference_id ?? '')) },
      });
    }
    // 2. Amounts that differ (a matched, captured payment).
    for (const g of await many<any>(
      `SELECT g.id, g.amount, g.reference_id, p.id AS intent_id, p.amount_captured_minor
         FROM gateway_transaction g JOIN payment_intent p ON p.id = g.payment_intent_id
        WHERE g.integration_id = $1 AND g.kind = 'payment' AND g.status = 'success' AND g.matched = 'intent' AND p.state IN ('captured', 'refunded')
          AND g.gateway_created_at > ${since} AND round(g.amount) <> COALESCE(p.amount_captured_minor, -1)`, [integrationId])) {
      found.push({ kind: 'amount_mismatch', refKey: `g:${g.id}`, gatewayTransactionId: String(g.id), paymentIntentId: g.intent_id, amount: num(g.amount),
        detail: { reference: g.reference_id, gatewayAmount: num(g.amount), plugsureAmount: g.amount_captured_minor } });
    }
    // 3. Paid in PlugSure through this account, absent from the ledger (once the ledger covers the day: synced since then).
    for (const p of await many<any>(
      `SELECT p.id, p.provider_ref, p.amount_captured_minor, p.paid_at FROM payment_intent p
        WHERE p.integration_id = $1 AND p.provider = $2 AND p.state IN ('captured', 'refunded') AND p.provider_ref IS NOT NULL
          AND p.paid_at > ${since} AND p.paid_at < now() - interval '1 day'
          AND p.paid_at > (SELECT min(gateway_created_at) FROM gateway_transaction WHERE integration_id = $1)
          AND NOT EXISTS (SELECT 1 FROM gateway_transaction g WHERE g.integration_id = $1 AND g.kind = 'payment' AND g.reference_id = p.provider_ref)`,
      [integrationId, acct.provider])) {
      found.push({ kind: 'missing_at_gateway', refKey: `p:${p.id}`, paymentIntentId: p.id, amount: p.amount_captured_minor, detail: { reference: p.provider_ref, paidAt: p.paid_at } });
    }
    // 4. Pending at the gateway for more than a day.
    for (const g of await many<any>(
      `SELECT id, reference_id, amount, kind, gateway_created_at FROM gateway_transaction
        WHERE integration_id = $1 AND status = 'pending' AND gateway_created_at < now() - interval '1 day' AND gateway_created_at > ${since}`, [integrationId])) {
      found.push({ kind: 'pending_too_long', refKey: `g:${g.id}`, gatewayTransactionId: String(g.id), amount: num(g.amount), detail: { reference: g.reference_id, type: g.kind, since: g.gateway_created_at } });
    }
    // 5. Settlement overdue: a day past the expected time, still pending.
    for (const g of await many<any>(
      `SELECT id, reference_id, amount, net_amount, estimated_settlement_at FROM gateway_transaction
        WHERE integration_id = $1 AND status = 'success' AND settlement_status = 'pending' AND estimated_settlement_at < now() - interval '1 day'`, [integrationId])) {
      found.push({ kind: 'settlement_overdue', refKey: `g:${g.id}`, gatewayTransactionId: String(g.id), amount: num(g.net_amount ?? g.amount), detail: { reference: g.reference_id, expected: g.estimated_settlement_at } });
    }
    // 6. Refunds out of step: succeeded at the gateway but not refunded in PlugSure, or failed there but refunded here.
    for (const g of await many<any>(
      `SELECT g.id, g.status, g.amount, p.id AS intent_id, p.refund_state FROM gateway_transaction g JOIN payment_intent p ON p.id = g.payment_intent_id
        WHERE g.integration_id = $1 AND g.kind = 'refund' AND g.matched = 'refund' AND g.gateway_created_at > ${since}
          AND ((g.status = 'success' AND p.refund_state IS DISTINCT FROM 'refunded') OR (g.status = 'failed' AND p.refund_state = 'refunded'))`, [integrationId])) {
      found.push({ kind: 'refund_mismatch', refKey: `g:${g.id}`, gatewayTransactionId: String(g.id), paymentIntentId: g.intent_id, amount: num(g.amount),
        detail: { gatewayStatus: g.status, plugsureRefundState: g.refund_state } });
    }

    let fresh = 0;
    for (const f of found) {
      const r = await one<{ inserted: boolean }>(
        `INSERT INTO reconciliation_exception (integration_id, org_id, kind, ref_key, gateway_transaction_id, payment_intent_id, amount, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (integration_id, kind, ref_key) DO UPDATE SET last_seen_at = now(), detail = EXCLUDED.detail, amount = EXCLUDED.amount
         RETURNING (xmax = 0) AS inserted`,
        [integrationId, acct.org_id, f.kind, f.refKey, f.gatewayTransactionId ?? null, f.paymentIntentId ?? null, f.amount ?? null, JSON.stringify(f.detail)]);
      if (r?.inserted) fresh++;
    }
    // What is no longer found has been put right (a late notification, a settlement): closed, not deleted.
    const keys = found.map((f) => `${f.kind}|${f.refKey}`);
    const cleared = await query(
      `UPDATE reconciliation_exception SET state = 'resolved', resolution = 'Cleared: no longer found by the reconciliation.', resolved_at = now()
        WHERE integration_id = $1 AND state = 'open' AND NOT (kind || '|' || ref_key = ANY($2::text[]))`, [integrationId, keys]);
    const open = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM reconciliation_exception WHERE integration_id = $1 AND state = 'open'`, [integrationId]))?.n ?? 0;
    await query(`UPDATE gateway_sync_state SET last_reconciled_at = now() WHERE integration_id = $1`, [integrationId]);
    await alertOpen(integrationId, acct.org_id, open, fresh);
    return { open, found: found.length, cleared: cleared.rowCount ?? 0 };
  });
}

/** One alert per account while exceptions are open (raised again when new ones appear), resolved at zero. */
async function alertOpen(integrationId: string, orgId: string | null, open: number, fresh: number): Promise<void> {
  const orgs = orgId ? [orgId] : await opsAlertOrgs();
  for (const o of orgs) {
    if (open && fresh) {
      await persistAlert({ orgId: o, kind: 'finance.reconciliation', severity: 'warning', targetType: 'payments_account', targetId: integrationId,
        message: `Payments reconciliation: ${open} difference${open === 1 ? '' : 's'} between the gateway and PlugSure need checking (Finance → Reconciliation).` });
    } else if (!open) {
      await resolveAlertsFor(o, 'finance.reconciliation', 'payments_account', integrationId);
    }
  }
}

export async function reconcileAll(): Promise<void> {
  for (const id of await syncedAccounts()) {
    try { await reconcile(id); } catch (e) { logger.warn({ integrationId: id, err: (e as Error).message }, 'finance: reconciliation failed'); }
  }
}

/**
 * Apply a "paid at the gateway, not in PlugSure" exception: the payment is applied as its lost notification would
 * have been (registry.applyGatewayPayment), and the exception is resolved with the outcome.
 */
export async function applyMissing(exceptionId: string, integrationId: string, userId: string | null): Promise<{ outcome: string }> {
  return outsideRequestScope(async () => {
    const e = await one<any>(
      `SELECT x.*, g.reference_id, g.product_id, g.amount AS g_amount, g.currency AS g_currency, g.status AS g_status
         FROM reconciliation_exception x LEFT JOIN gateway_transaction g ON g.id = x.gateway_transaction_id
        WHERE x.id = $1 AND x.integration_id = $2`, [exceptionId, integrationId]);
    if (!e) throw new FinanceError(404, 'No such exception.');
    if (e.state !== 'open') throw new FinanceError(409, 'This exception is already resolved.');
    if (e.kind !== 'missing_in_plugsure' || !e.payment_intent_id || !e.reference_id || e.g_status !== 'success') {
      throw new FinanceError(409, 'Only a gateway payment that matches a PlugSure payment can be applied; resolve this one with a note.');
    }
    const r = await byId(integrationId);
    if (!r) throw new FinanceError(404, 'No such payments account.');
    const res = await applyGatewayPayment(r, {
      providerRef: String(e.reference_id), paid: true, status: 'SUCCEEDED (from the gateway ledger)',
      amountMinor: Math.round(num(e.g_amount)), paymentId: e.product_id ?? undefined, currency: e.g_currency ?? undefined,
    });
    await query(`UPDATE reconciliation_exception SET state = 'resolved', resolution = $3, resolved_by = $4, resolved_at = now() WHERE id = $1 AND integration_id = $2`,
      [exceptionId, integrationId, `Applied from the gateway ledger: ${res.outcome}.`, userId]);
    return { outcome: res.outcome };
  });
}

export async function resolveException(exceptionId: string, integrationId: string, note: string, userId: string | null): Promise<void> {
  const text = note.trim();
  if (!text || text.length > 500) throw new FinanceError(422, 'A note of 1 to 500 characters says how it was resolved.');
  const r = await outsideRequestScope(() => query(
    `UPDATE reconciliation_exception SET state = 'resolved', resolution = $3, resolved_by = $4, resolved_at = now()
      WHERE id = $1 AND integration_id = $2 AND state = 'open'`, [exceptionId, integrationId, text, userId]));
  if (!r.rowCount) throw new FinanceError(404, 'No such open exception.');
}

export async function exceptions(integrationId: string, state: 'open' | 'resolved' | null, limit: number) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT x.*, g.reference_id, g.channel_code, g.external_id FROM reconciliation_exception x LEFT JOIN gateway_transaction g ON g.id = x.gateway_transaction_id
      WHERE x.integration_id = $1 AND ($2::text IS NULL OR x.state = $2) ORDER BY (x.state = 'open') DESC, x.last_seen_at DESC LIMIT $3`,
    [integrationId, state, limit]));
  return rows.map((x) => ({
    id: String(x.id), kind: x.kind as ExceptionKind, text: EXCEPTION_TEXT[x.kind as ExceptionKind] ?? x.kind, state: x.state,
    amount: x.amount != null ? num(x.amount) : null, reference: x.reference_id ?? x.detail?.reference ?? null, channel: x.channel_code ?? null,
    gatewayId: x.external_id ?? null, paymentId: x.payment_intent_id ?? null, detail: x.detail ?? {},
    canApply: x.state === 'open' && x.kind === 'missing_in_plugsure' && Boolean(x.payment_intent_id),
    resolution: x.resolution, resolvedAt: iso(x.resolved_at), firstSeenAt: iso(x.first_seen_at), lastSeenAt: iso(x.last_seen_at),
  }));
}

// ─────────────────────────────────────────── reports

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const tz = () => config.billing?.timeZone ?? config.alerts.timeZone;

export interface Period { from: Date; to: Date }
/** A period from query parameters: from / to (dates, platform time zone, `to` inclusive); default the current month. */
export function periodOf(fromRaw?: string, toRaw?: string, now = new Date()): Period {
  const zone = tz();
  const day = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new FinanceError(400, 'Dates are YYYY-MM-DD.');
    return s;
  };
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now);
  const f = fromRaw ? day(fromRaw) : `${today.slice(0, 7)}-01`;
  const t = toRaw ? day(toRaw) : today;
  const at = (d: string) => new Date(new Date(`${d}T00:00:00Z`).getTime() - offsetMs(zone, new Date(`${d}T12:00:00Z`)));
  const from = at(f), to = new Date(at(t).getTime() + 86_400_000);
  if (to <= from) throw new FinanceError(400, 'The end date is before the start date.');
  if (to.getTime() - from.getTime() > 400 * 86_400_000) throw new FinanceError(400, 'A period is at most 400 days.');
  return { from, to };
}
function offsetMs(zone: string, d: Date): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - d.getTime();
}

export async function overview(integrationId: string, p: Period) {
  return outsideRequestScope(async () => {
    const zone = tz();
    const [tot, byChannel, daily, recv, recvDays, bal, refundsDue, exc, sync] = await Promise.all([
      one<any>(
        `SELECT
           COALESCE(sum(amount) FILTER (WHERE kind = 'payment' AND status = 'success' AND cashflow = 'in'), 0) AS collected,
           count(*) FILTER (WHERE kind = 'payment' AND status = 'success' AND cashflow = 'in')::int AS payments,
           COALESCE(sum(fee) FILTER (WHERE status = 'success'), 0) AS fees,
           COALESCE(sum(vat) FILTER (WHERE status = 'success'), 0) AS vat,
           COALESCE(sum(withholding_tax) FILTER (WHERE status = 'success'), 0) AS wht,
           COALESCE(sum(amount) FILTER (WHERE kind = 'refund' AND status = 'success'), 0) AS refunds,
           count(*) FILTER (WHERE kind = 'refund' AND status = 'success')::int AS refund_count,
           COALESCE(sum(amount) FILTER (WHERE kind = 'payout' AND status = 'success'), 0) AS payouts,
           COALESCE(sum(net_amount) FILTER (WHERE kind = 'payment' AND status = 'success' AND settlement_status IN ('settled', 'early_settled')), 0) AS settled
         FROM gateway_transaction WHERE integration_id = $1 AND gateway_created_at >= $2 AND gateway_created_at < $3`, [integrationId, p.from, p.to]),
      many<any>(
        `SELECT COALESCE(channel_code, channel_category, 'OTHER') AS channel, count(*)::int AS n, sum(amount) AS amount, sum(fee + vat) AS fees
           FROM gateway_transaction WHERE integration_id = $1 AND kind = 'payment' AND status = 'success' AND gateway_created_at >= $2 AND gateway_created_at < $3
          GROUP BY 1 ORDER BY 3 DESC`, [integrationId, p.from, p.to]),
      many<any>(
        `SELECT to_char((gateway_created_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS day,
                COALESCE(sum(amount) FILTER (WHERE kind = 'payment' AND status = 'success' AND cashflow = 'in'), 0) AS collected,
                COALESCE(sum(fee + vat) FILTER (WHERE status = 'success'), 0) AS fees,
                COALESCE(sum(amount) FILTER (WHERE kind = 'refund' AND status = 'success'), 0) AS refunds
           FROM gateway_transaction WHERE integration_id = $1 AND gateway_created_at >= $2 AND gateway_created_at < $3 GROUP BY 1 ORDER BY 1`,
        [integrationId, p.from, p.to, zone]),
      one<any>(
        `SELECT COALESCE(sum(COALESCE(net_amount, amount)), 0) AS amount, count(*)::int AS n,
                COALESCE(sum(COALESCE(net_amount, amount)) FILTER (WHERE estimated_settlement_at < now()), 0) AS overdue
           FROM gateway_transaction WHERE integration_id = $1 AND status = 'success' AND cashflow = 'in' AND settlement_status = 'pending'`, [integrationId]),
      many<any>(
        `SELECT to_char((estimated_settlement_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day, sum(COALESCE(net_amount, amount)) AS amount, count(*)::int AS n
           FROM gateway_transaction WHERE integration_id = $1 AND status = 'success' AND cashflow = 'in' AND settlement_status = 'pending' AND estimated_settlement_at IS NOT NULL
          GROUP BY 1 ORDER BY 1 LIMIT 14`, [integrationId, zone]),
      one<any>(`SELECT balance, taken_at FROM gateway_balance_snapshot WHERE integration_id = $1 ORDER BY taken_at DESC LIMIT 1`, [integrationId]),
      one<any>(
        `SELECT COALESCE(sum(refund_due_minor), 0) AS amount, count(*)::int AS n FROM payment_intent
          WHERE integration_id = $1 AND refund_state IN ('due', 'processing', 'failed')`, [integrationId]),
      one<any>(`SELECT count(*)::int AS n FROM reconciliation_exception WHERE integration_id = $1 AND state = 'open'`, [integrationId]),
      one<any>(`SELECT * FROM gateway_sync_state WHERE integration_id = $1`, [integrationId]),
    ]);
    const collected = num(tot?.collected), fees = num(tot?.fees) + num(tot?.vat), refunds = num(tot?.refunds);
    return {
      period: { from: p.from.toISOString(), to: p.to.toISOString(), timeZone: zone },
      currency: LEGACY_CURRENCY,
      collected, payments: tot?.payments ?? 0,
      fees: num(tot?.fees), vat: num(tot?.vat), withholdingTax: num(tot?.wht), feeRate: collected ? Math.round((fees / collected) * 10_000) / 10_000 : null,
      refunds, refundCount: tot?.refund_count ?? 0, payouts: num(tot?.payouts), settled: num(tot?.settled),
      net: collected - fees - refunds,
      receivable: { amount: num(recv?.amount), count: recv?.n ?? 0, overdue: num(recv?.overdue), byDay: recvDays.map((d) => ({ day: d.day, amount: num(d.amount), count: d.n })) },
      balance: bal ? { amount: num(bal.balance), at: iso(bal.taken_at) } : null,
      payable: { refundsDue: num(refundsDue?.amount), refundsDueCount: refundsDue?.n ?? 0 },
      byChannel: byChannel.map((c) => ({ channel: c.channel, count: c.n, amount: num(c.amount), fees: num(c.fees) })),
      daily: daily.map((d) => ({ day: d.day, collected: num(d.collected), fees: num(d.fees), refunds: num(d.refunds) })),
      exceptionsOpen: exc?.n ?? 0,
      sync: sync ? { lastRunAt: iso(sync.last_run_at), ok: sync.last_ok, error: sync.last_error, rows: sync.last_rows, complete: !sync.resume_after_id, lastReconciledAt: iso(sync.last_reconciled_at) } : null,
    };
  });
}

export interface TxFilter { kind?: string | null; status?: string | null; settlement?: string | null; channel?: string | null; matched?: boolean | null; q?: string | null; beforeId?: string | null; limit: number }

export async function transactions(integrationId: string, p: Period, f: TxFilter) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT g.*, p.state AS intent_state, p.session_id, o.name AS org_name
       FROM gateway_transaction g
       LEFT JOIN payment_intent p ON p.id = g.payment_intent_id
       LEFT JOIN organisation o ON o.id = p.org_id
      WHERE g.integration_id = $1 AND g.gateway_created_at >= $2 AND g.gateway_created_at < $3
        AND ($4::text IS NULL OR g.kind = $4) AND ($5::text IS NULL OR g.status = $5)
        AND ($6::text IS NULL OR g.settlement_status = $6 OR ($6 = 'none' AND g.settlement_status IS NULL))
        AND ($7::text IS NULL OR g.channel_code = $7 OR g.channel_category = $7)
        AND ($8::boolean IS NULL OR (g.matched IS NOT NULL) = $8)
        AND ($9::text IS NULL OR g.reference_id ILIKE '%' || $9 || '%' OR g.external_id ILIKE '%' || $9 || '%' OR g.product_id ILIKE '%' || $9 || '%')
        AND ($10::bigint IS NULL OR g.id < $10)
      ORDER BY g.gateway_created_at DESC, g.id DESC LIMIT $11`,
    [integrationId, p.from, p.to, f.kind ?? null, f.status ?? null, f.settlement ?? null, f.channel ?? null, f.matched ?? null, f.q ?? null, f.beforeId ?? null, f.limit]));
  return rows.map(txView);
}

/**
 * (v1.16.0) One ledger row's whole trail: the gateway transaction (with its raw record), the other ledger rows of the same
 * PlugSure payment (the payment and its refunds), the payment itself with its state history, the charging session (site,
 * charger, energy) and its charge record, refund transfers, the membership pass it paid, and reconciliation exceptions.
 * The driver's phone is masked. 404 when the row is not this account's.
 */
export async function trail(integrationId: string, txId: string) {
  if (!/^\d{1,18}$/.test(txId)) throw new FinanceError(404, 'No such transaction.');
  return outsideRequestScope(async () => {
    const g = await one<any>(
      `SELECT g.*, p.state AS intent_state, p.session_id, o.name AS org_name FROM gateway_transaction g
         LEFT JOIN payment_intent p ON p.id = g.payment_intent_id LEFT JOIN organisation o ON o.id = p.org_id
        WHERE g.id = $1 AND g.integration_id = $2`, [txId, integrationId]);
    if (!g) throw new FinanceError(404, 'No such transaction.');
    const pid = g.payment_intent_id as string | null;
    const [related, pi, exceptions, pass] = await Promise.all([
      pid ? many<any>(`SELECT g.*, NULL::text AS intent_state, NULL::uuid AS session_id, NULL::text AS org_name FROM gateway_transaction g
                        WHERE g.payment_intent_id = $1 AND g.id <> $2 ORDER BY g.gateway_created_at`, [pid, txId]) : Promise.resolve([]),
      pid ? one<any>(`SELECT pi.*, o.name AS org_name FROM payment_intent pi LEFT JOIN organisation o ON o.id = pi.org_id WHERE pi.id = $1`, [pid]) : Promise.resolve(null),
      many<any>(`SELECT id, kind, state, resolution, first_seen_at, resolved_at FROM reconciliation_exception
                  WHERE integration_id = $1 AND (gateway_transaction_id = $2 OR ($3::uuid IS NOT NULL AND payment_intent_id = $3::uuid)) ORDER BY first_seen_at`, [integrationId, txId, pid]),
      g.subscription_charge_id ? one<any>(`SELECT id, state, total_minor AS amount_minor, currency, created_at FROM subscription_charge WHERE id = $1`, [g.subscription_charge_id]) : Promise.resolve(null),
    ]);
    const sess = pi ? await one<any>(
      `SELECT cs.id, cs.state, cs.started_at, cs.ended_at, cs.energy_wh, s.name AS site, cp.ocpp_identity AS charger, e.evse_id AS connector,
              d.id AS cdr_id, d.total_minor AS cdr_total, d.currency AS cdr_currency, d.issued_at AS cdr_issued_at, ad.phone
         FROM charging_session cs LEFT JOIN site s ON s.id = cs.site_id LEFT JOIN charge_point cp ON cp.id = cs.charge_point_id
         LEFT JOIN connector c ON c.id = cs.connector_uuid LEFT JOIN evse e ON e.id = c.evse_uuid
         LEFT JOIN cdr d ON d.session_id = cs.id
         LEFT JOIN driver_charge dc ON dc.payment_intent_id = $1 LEFT JOIN app_driver ad ON ad.id = dc.app_driver_id
        WHERE cs.id = $2 OR cs.payment_intent_id = $1 LIMIT 1`, [pi.id, pi.session_id]) : null;
    const transfers = pi ? await many<any>(`SELECT id, state, amount_minor, bank_code, account_last4, checked_name, requested_at, approved_at, response_code, error
                                               FROM refund_transfer WHERE payment_intent_id = $1 ORDER BY requested_at`, [pi.id]) : [];
    const mask = (ph: string | null | undefined) => (ph ? `${ph.slice(0, 6)}••••${ph.slice(-3)}` : null);
    // The gateway's raw record, without anything that identifies the payer beyond what the ledger shows.
    const raw = JSON.parse(JSON.stringify(g.raw ?? {}), (k, v) => (/phone|mobile|email|account_number|customer/i.test(k) && typeof v === 'string' ? '••••' : v));
    return {
      transaction: { ...txView(g), raw },
      related: related.map(txView),
      payment: pi ? {
        id: pi.id, operator: pi.org_name, provider: pi.provider, method: pi.method, channel: pi.channel, mode: pi.mode, state: pi.state, currency: pi.currency,
        authorised: pi.amount_authorised_minor != null ? Number(pi.amount_authorised_minor) : null, captured: pi.amount_captured_minor != null ? Number(pi.amount_captured_minor) : null,
        providerRef: pi.provider_ref, providerPaymentId: pi.provider_payment_id, createdAt: iso(pi.created_at), paidAt: iso(pi.paid_at ?? pi.captured_at),
        refund: pi.refund_state ? { state: pi.refund_state, due: pi.refund_due_minor != null ? Number(pi.refund_due_minor) : null, refunded: pi.refunded_minor != null ? Number(pi.refunded_minor) : null,
          method: pi.refund_method, reference: pi.refund_ref, reason: pi.refund_reason, requestedAt: iso(pi.refund_requested_at), refundedAt: iso(pi.refunded_at), error: pi.refund_error } : null,
        events: (Array.isArray(pi.raw_events) ? pi.raw_events : []).slice(-50).map((e: any) => ({ at: e?.at ?? null, status: e?.status ?? null, paymentId: e?.paymentId ?? null })),
      } : null,
      session: sess ? {
        id: sess.id, state: sess.state, startedAt: iso(sess.started_at), endedAt: iso(sess.ended_at), energyKwh: sess.energy_wh != null ? Math.round(Number(sess.energy_wh) / 100) / 10 : null,
        site: sess.site, charger: sess.charger, connector: sess.connector, driver: mask(sess.phone),
        chargeRecord: sess.cdr_id ? { id: sess.cdr_id, total: Number(sess.cdr_total), currency: sess.cdr_currency, issuedAt: iso(sess.cdr_issued_at) } : null,
      } : null,
      transfers: transfers.map((t: any) => ({ id: String(t.id), state: t.state, amount: Number(t.amount_minor), account: `${t.bank_code} ••••${t.account_last4}`, bankName: t.checked_name,
        requestedAt: iso(t.requested_at), approvedAt: iso(t.approved_at), responseCode: t.response_code, error: t.error })),
      pass: pass ? { id: pass.id, state: pass.state, amount: Number(pass.amount_minor), createdAt: iso(pass.created_at) } : null,
      exceptions: exceptions.map((x: any) => ({ id: String(x.id), kind: x.kind, state: x.state, resolution: x.resolution, firstSeenAt: iso(x.first_seen_at), resolvedAt: iso(x.resolved_at) })),
    };
  });
}

/** One name per payment method across gateways (Xendit says ID_DANA and CARDS; Duitku, DANA and CARD). */
export const methodName = (c: string) => { const u = String(c).toUpperCase().replace(/^ID_/, ''); return ['CARDS', 'CREDIT_CARD', 'CARD'].includes(u) ? 'CARD' : u; };

/**
 * (v1.16.0) What each payment method actually costs, per gateway account the caller may see, over the period: payments,
 * amount, fees and VAT on fees, the average fee, the effective rate and the cost per 100,000 rupiah collected. For a
 * Duitku account, also what Duitku quotes today for 100,000 rupiah by method (getpaymentmethod), for methods not used yet.
 */
export async function methodCosts(accounts: Account[], p: Period) {
  const ids = accounts.map((a) => a.id);
  const rows = ids.length ? await outsideRequestScope(() => many<any>(
    `SELECT integration_id, upper(COALESCE(channel_code, channel_category, 'OTHER')) AS channel, count(*)::int AS n, sum(amount) AS amount, sum(fee + vat) AS fees
       FROM gateway_transaction WHERE integration_id = ANY($1::uuid[]) AND kind = 'payment' AND status = 'success' AND cashflow = 'in'
        AND gateway_created_at >= $2 AND gateway_created_at < $3
      GROUP BY 1, 2 ORDER BY 1, 4 DESC`, [ids, p.from, p.to])) : [];
  const quoted = new Map<string, Array<{ channel: string; fee: number }>>();
  await Promise.all(accounts.filter((a) => a.provider === 'duitku' && !a.archived).map(async (a) => {
    const r = await byId(a.id).catch(() => null);
    const prov = r ? (() => { try { return providerFor(r); } catch { return null; } })() : null;
    const q = prov instanceof DuitkuProvider ? await prov.quotedFees(100_000) : null;
    if (q) quoted.set(a.id, q);
  }));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    per: 100_000,
    accounts: accounts.map((a) => ({
      id: a.id, label: a.label, provider: a.provider, fallback: a.fallback,
      methods: (() => {
        const norm = methodName;
        const by = new Map<string, { n: number; amount: number; fees: number }>();
        for (const x of rows.filter((y) => y.integration_id === a.id)) {
          const k = norm(String(x.channel));
          const t = by.get(k) ?? { n: 0, amount: 0, fees: 0 };
          t.n += x.n; t.amount += num(x.amount); t.fees += num(x.fees);
          by.set(k, t);
        }
        return [...by.entries()].sort((p1, p2) => p2[1].amount - p1[1].amount).map(([channel, t]) => ({
          channel, payments: t.n, amount: t.amount, fees: r2(t.fees), averageFee: t.n ? r2(t.fees / t.n) : null, rate: t.amount ? t.fees / t.amount : null, per100k: t.amount ? r2((t.fees / t.amount) * 100_000) : null,
        }));
      })(),
      quoted: quoted.get(a.id) ?? null,
    })),
  };
}

// ─────────────────────────────────────────── (v1.16.0) Xendit's own reports, requested from Finance

export const REPORT_TYPES = ['TRANSACTIONS', 'BALANCE_HISTORY', 'UPCOMING_TRANSACTIONS'] as const;
export type ReportType = typeof REPORT_TYPES[number];
const reportView = (r: any) => ({
  id: String(r.id), type: r.type, from: iso(r.period_from), to: iso(r.period_to), status: r.status, ready: r.status === 'COMPLETED' && Boolean(r.url),
  error: r.error, requestedAt: iso(r.requested_at), updatedAt: iso(r.updated_at), requestedBy: r.requested_by_name ?? null,
});

/** Reports requested for this Xendit account, newest first. */
export async function reports(a: Account) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT r.*, u.name AS requested_by_name FROM gateway_report r LEFT JOIN app_user u ON u.id = r.requested_by
      WHERE r.integration_id = $1 ORDER BY r.requested_at DESC LIMIT 50`, [a.id]));
  return rows.map(reportView);
}

/** Ask Xendit to generate a report for the period (upcoming settlements: from now on, the period is ignored). */
export async function requestReport(a: Account, type: string, p: Period, userId: string | null) {
  if (!REPORT_TYPES.includes(type as ReportType)) throw new FinanceError(422, `type is one of ${REPORT_TYPES.join(', ')}`);
  const x = await xenditOf(a.id);
  if (!x) throw new FinanceError(409, 'Reports are generated by Xendit: this is not a Xendit account.');
  const from = type === 'UPCOMING_TRANSACTIONS' ? new Date() : p.from;
  const to = type === 'UPCOMING_TRANSACTIONS' ? new Date(Date.now() + 30 * 86_400_000) : p.to;
  let res: { id: string; status: string; url: string | null };
  try { res = await x.x.createReport({ type: type as ReportType, from, to }); } catch (e) { throw new FinanceError(502, `${(e as Error).message}. The secret key needs Xendit's Report permission.`); }
  const r = await outsideRequestScope(() => one<any>(
    `INSERT INTO gateway_report (integration_id, org_id, type, period_from, period_to, external_id, status, url, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [a.id, a.orgId, type, from, to, res.id, ['COMPLETED', 'FAILED'].includes(res.status) ? res.status : 'PENDING', res.url, userId]));
  return reportView(r);
}

/**
 * A report's state, asked of Xendit while it is pending (or when its link is wanted again: Xendit's links expire).
 * `link`: also return the download link of a completed report.
 */
export async function reportStatus(a: Account, id: string, link = false) {
  if (!/^\d{1,18}$/.test(id)) throw new FinanceError(404, 'No such report.');
  let r = await outsideRequestScope(() => one<any>(`SELECT * FROM gateway_report WHERE id = $1 AND integration_id = $2`, [id, a.id]));
  if (!r) throw new FinanceError(404, 'No such report.');
  if ((r.status === 'PENDING' || (link && r.status === 'COMPLETED')) && r.external_id) {
    const x = await xenditOf(a.id);
    if (x) {
      try {
        const g = await x.x.getReport(r.external_id);
        const status = ['COMPLETED', 'FAILED'].includes(g.status) ? g.status : 'PENDING';
        r = await outsideRequestScope(() => one<any>(`UPDATE gateway_report SET status = $2, url = COALESCE($3, url), error = $4, updated_at = now() WHERE id = $1 RETURNING *`,
          [id, status, g.url, status === 'FAILED' ? 'Xendit could not generate the report.' : null]));
      } catch (e) {
        logger.warn({ id, err: (e as Error).message }, 'finance: Xendit report status failed');
      }
    }
  }
  return { ...reportView(r), url: link && r.status === 'COMPLETED' ? r.url : undefined };
}

function txView(g: any) {
  return {
    id: String(g.id), gatewayId: g.external_id, kind: g.kind, type: g.gateway_type, status: g.status, cashflow: g.cashflow,
    channel: g.channel_code ?? g.channel_category, channelCategory: g.channel_category, reference: g.reference_id, productId: g.product_id,
    currency: g.currency, amount: num(g.amount), fee: num(g.fee), vat: num(g.vat), withholdingTax: num(g.withholding_tax), net: g.net_amount != null ? num(g.net_amount) : null,
    settlement: g.settlement_status, expectedSettlementAt: iso(g.estimated_settlement_at), settledSeenAt: iso(g.settled_seen_at),
    at: iso(g.gateway_created_at), updatedAt: iso(g.gateway_updated_at),
    matched: g.matched, paymentId: g.payment_intent_id ?? null, paymentState: g.intent_state ?? null, sessionId: g.session_id ?? null,
    operator: g.org_name ?? null, passChargeId: g.subscription_charge_id ?? null,
  };
}

/** Collected and not yet settled, by expected settlement day; and the rows (oldest expected first). */
export async function receivables(integrationId: string, orgId: string | null) {
  return outsideRequestScope(async () => {
    const zone = tz();
    const [days, rows, fleet] = await Promise.all([
      many<any>(
        `SELECT to_char((estimated_settlement_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day, sum(COALESCE(net_amount, amount)) AS net, sum(amount) AS gross, count(*)::int AS n,
                bool_or(estimated_settlement_at < now()) AS overdue
           FROM gateway_transaction WHERE integration_id = $1 AND status = 'success' AND cashflow = 'in' AND settlement_status = 'pending'
          GROUP BY 1 ORDER BY 1 NULLS FIRST`, [integrationId, zone]),
      many<any>(
        `SELECT g.*, NULL::text AS intent_state, NULL::uuid AS session_id, NULL::text AS org_name FROM gateway_transaction g
          WHERE g.integration_id = $1 AND g.status = 'success' AND g.cashflow = 'in' AND g.settlement_status = 'pending'
          ORDER BY g.estimated_settlement_at NULLS FIRST, g.id LIMIT 500`, [integrationId]),
      // An operator's own account: its fleet invoices issued and not paid yet are money it is owed too.
      orgId ? many<any>(
        `SELECT f.id, f.number, f.period, f.total_minor, f.currency, f.due_date, a.name AS account
           FROM fleet_invoice f LEFT JOIN fleet_account a ON a.id = f.fleet_account_id
          WHERE f.org_id = $1 AND f.status = 'issued' ORDER BY f.due_date NULLS LAST LIMIT 200`, [orgId]) : Promise.resolve([]),
    ]);
    // (v1.15.0) Also owed: post-pay sessions not charged yet (on this account); for the platform, PlugSure Hub's fee
    // invoices issued and not paid; for an operator, Hub settlement positions where it is the payee.
    const [postpay, hubFees, hubOwed] = await Promise.all([
      one<any>(
        `SELECT count(*)::int AS n, COALESCE(sum(COALESCE(pi.hold_capture_minor, d.total_minor, 0)), 0) AS amount,
                count(*) FILTER (WHERE pi.hold_state = 'capture_failed')::int AS failed
           FROM payment_intent pi LEFT JOIN cdr d ON d.session_id = pi.session_id
          WHERE pi.integration_id = $1 AND pi.mode = 'postpay' AND (pi.state = 'authorised' OR pi.hold_state = 'capture_failed') AND pi.settled_at IS NULL`, [integrationId]),
      orgId ? Promise.resolve([]) : many<any>(
        `SELECT i.number, i.currency, i.total_minor, i.due_date, o.name AS member FROM hub_fee_invoice i LEFT JOIN organisation o ON o.id = i.org_id
          WHERE i.status = 'issued' ORDER BY i.due_date LIMIT 200`),
      orgId ? many<any>(
        `SELECT p.id, p.currency, p.net_minor - p.paid_minor AS outstanding, p.due_date, p.status, o.name AS payer FROM hub_settlement_position p LEFT JOIN organisation o ON o.id = p.payer_org_id
          WHERE p.payee_org_id = $1 AND p.status IN ('open', 'partially_paid', 'overdue') ORDER BY p.due_date LIMIT 200`, [orgId]) : Promise.resolve([]),
    ]);
    return {
      postpay: { count: postpay?.n ?? 0, amount: num(postpay?.amount), failed: postpay?.failed ?? 0 },
      hubFeeInvoices: hubFees.map((h: any) => ({ number: h.number, member: h.member, total: num(h.total_minor), currency: h.currency, dueDate: h.due_date, overdue: h.due_date ? new Date(h.due_date) < new Date() : false })),
      hubPositions: hubOwed.map((h: any) => ({ id: h.id, counterparty: h.payer, outstanding: num(h.outstanding), currency: h.currency, dueDate: h.due_date, status: h.status })),
      byDay: days.map((d) => ({ day: d.day, net: num(d.net), gross: num(d.gross), count: d.n, overdue: d.overdue === true })),
      total: days.reduce((a, d) => a + num(d.net), 0),
      rows: rows.map(txView),
      fleetInvoices: fleet.map((f: any) => ({ id: f.id, number: f.number, period: f.period, total: num(f.total_minor), currency: f.currency, dueDate: f.due_date, account: f.account, overdue: f.due_date ? new Date(f.due_date) < new Date() : false })),
    };
  });
}

/**
 * Money owed out of this account: refunds due (outstanding, failed, processing) on payments it took, and the site
 * owners' shares on finalised statements of the operators whose payments it took, with what was paid against each
 * (recorded from v1.14.0, services/payouts.ts).
 */
export async function payables(integrationId: string, orgId: string | null = null) {
  return outsideRequestScope(async () => {
    // (v1.15.0) An operator's own account: PlugSure Hub settlement positions where it is the payer.
    const hubOwes = orgId ? await many<any>(
      `SELECT p.id, p.currency, p.net_minor - p.paid_minor AS outstanding, p.due_date, p.status, o.name AS payee FROM hub_settlement_position p LEFT JOIN organisation o ON o.id = p.payee_org_id
        WHERE p.payer_org_id = $1 AND p.status IN ('open', 'partially_paid', 'overdue') ORDER BY p.due_date LIMIT 200`, [orgId]) : [];
    const [refunds, owners] = await Promise.all([
      many<any>(
        `SELECT p.id, p.provider, p.refund_state, p.refund_due_minor, p.refund_reason, p.refund_requested_at, p.channel, p.paid_at, p.provider_ref, p.currency, o.name AS org_name
           FROM payment_intent p LEFT JOIN organisation o ON o.id = p.org_id
          WHERE p.integration_id = $1 AND p.refund_state IN ('due', 'processing', 'failed') ORDER BY p.paid_at NULLS LAST LIMIT 500`, [integrationId]),
      many<any>(
        `SELECT s.id, s.period, s.owner_share_minor, s.finalised_at, s.currency, COALESCE(w.legal_name, w.name) AS owner, o.name AS org_name,
                COALESCE((SELECT sum(amount_minor) FROM statement_payment p WHERE p.statement_id = s.id AND p.voided_at IS NULL), 0)::bigint AS paid
           FROM commission_statement s JOIN site_owner w ON w.id = s.owner_id JOIN organisation o ON o.id = s.org_id
          WHERE s.finalised_at IS NOT NULL AND s.owner_share_minor > 0 AND s.finalised_at > now() - interval '120 days'
            AND s.org_id IN (SELECT DISTINCT org_id FROM payment_intent WHERE integration_id = $1 AND created_at > now() - interval '120 days')
          ORDER BY s.period DESC, 6 LIMIT 500`, [integrationId]),
    ]);
    const now = Date.now();
    return {
      hubPositions: hubOwes.map((h: any) => ({ id: h.id, counterparty: h.payee, outstanding: num(h.outstanding), currency: h.currency, dueDate: h.due_date, status: h.status })),
      refunds: refunds.map((r) => {
        // The gateway's refund window for the channel (services/refund-windows.ts): past it, a refund goes by bank transfer.
        const window = refundWindowDays(r.provider, r.channel);
        const left = refundDaysLeft(window, r.paid_at, now);
        return {
          paymentId: r.id, state: r.refund_state, amount: num(r.refund_due_minor), currency: r.currency, reason: r.refund_reason, requestedAt: iso(r.refund_requested_at),
          channel: r.channel, paidAt: iso(r.paid_at), reference: r.provider_ref, operator: r.org_name,
          refundWindowDays: window, daysLeft: left,
        };
      }),
      // (v1.14.0) Paid as recorded against the statement (services/payouts.ts).
      ownerShares: owners.map((s: any) => {
        const due = num(s.owner_share_minor), paid = num(s.paid);
        return { statementId: s.id, period: s.period, owner: s.owner, operator: s.org_name, amount: due, paid, currency: s.currency, finalisedAt: iso(s.finalised_at), status: paid <= 0 ? 'due' : paid >= due ? 'paid' : 'partial' };
      }),
    };
  });
}

/** Fees per month and channel, the effective rate, and Xendit's actual QRIS fee against PlugSure's estimate. */
export async function fees(integrationId: string, p: Period) {
  return outsideRequestScope(async () => {
    const zone = tz();
    const [rows, qris] = await Promise.all([
      many<any>(
        `SELECT to_char((gateway_created_at AT TIME ZONE $4)::date, 'YYYY-MM') AS month, COALESCE(channel_code, channel_category, 'OTHER') AS channel,
                count(*)::int AS n, sum(amount) AS amount, sum(fee) AS fee, sum(vat) AS vat, sum(withholding_tax) AS wht
           FROM gateway_transaction WHERE integration_id = $1 AND kind = 'payment' AND status = 'success' AND gateway_created_at >= $2 AND gateway_created_at < $3
          GROUP BY 1, 2 ORDER BY 1 DESC, 4 DESC`, [integrationId, p.from, p.to, zone]),
      many<{ amount: string; fee: string; vat: string }>(
        `SELECT amount, fee, vat FROM gateway_transaction WHERE integration_id = $1 AND kind = 'payment' AND status = 'success'
            AND (channel_category = 'QR_CODE' OR channel_code ILIKE '%QRIS%') AND gateway_created_at >= $2 AND gateway_created_at < $3 LIMIT 100000`,
        [integrationId, p.from, p.to]),
    ]);
    const actual = qris.reduce((a, r) => a + num(r.fee) + num(r.vat), 0);
    const estimate = qris.reduce((a, r) => a + estimateQrisMdrIdr(Math.round(num(r.amount))), 0);
    return {
      rows: rows.map((r) => {
        const amount = num(r.amount), total = num(r.fee) + num(r.vat);
        return { month: r.month, channel: r.channel, count: r.n, amount, fee: num(r.fee), vat: num(r.vat), withholdingTax: num(r.wht), total, rate: amount ? Math.round((total / amount) * 10_000) / 10_000 : null };
      }),
      qris: { payments: qris.length, actual, estimated: estimate, difference: actual - estimate },
    };
  });
}

/** Everything for one month's close of an account: the summary, by channel, and every transaction. */
export async function monthClose(integrationId: string, p: Period) {
  const [o, tx, f, b] = await Promise.all([overview(integrationId, p), transactions(integrationId, p, { limit: 100_000 }), fees(integrationId, p), closeBreakdown(integrationId, p)]);
  return { overview: o, transactions: tx, fees: f, ...b };
}

/**
 * (v1.15.0) The accountant's month close by site and by operator: collected, fees, VAT on fees, refunds and net from the
 * gateway's ledger (each row attributed through PlugSure's payment to its session's site and its operator), and per
 * operator the site owners' shares on statements finalised for months in the period, with what was paid against them.
 * Gateway rows with no PlugSure payment (or no session: passes) are listed under "no site".
 */
export async function closeBreakdown(integrationId: string, p: Period) {
  return outsideRequestScope(async () => {
    const rows = await many<any>(
      `SELECT COALESCE(o.id::text, '') AS org_id, o.name AS operator, s.id AS site_id, s.name AS site,
              COALESCE(sum(g.amount) FILTER (WHERE g.kind = 'payment' AND g.status = 'success' AND g.cashflow = 'in'), 0) AS collected,
              count(*) FILTER (WHERE g.kind = 'payment' AND g.status = 'success' AND g.cashflow = 'in')::int AS payments,
              COALESCE(sum(g.fee) FILTER (WHERE g.status = 'success'), 0) AS fees,
              COALESCE(sum(g.vat) FILTER (WHERE g.status = 'success'), 0) AS vat,
              COALESCE(sum(g.amount) FILTER (WHERE g.kind = 'refund' AND g.status = 'success'), 0) AS refunds
         FROM gateway_transaction g
         LEFT JOIN payment_intent pi ON pi.id = g.payment_intent_id
         LEFT JOIN LATERAL (SELECT cs.site_id FROM charging_session cs WHERE cs.id = pi.session_id OR cs.payment_intent_id = pi.id LIMIT 1) ss ON true
         LEFT JOIN site s ON s.id = ss.site_id
         LEFT JOIN organisation o ON o.id = COALESCE(pi.org_id, g.org_id)
        WHERE g.integration_id = $1 AND g.gateway_created_at >= $2 AND g.gateway_created_at < $3 AND g.kind IN ('payment', 'refund')
        GROUP BY 1, 2, 3, 4 ORDER BY 2 NULLS LAST, 4 NULLS LAST`, [integrationId, p.from, p.to]);
    const line = (r: any) => {
      const collected = num(r.collected), fees = num(r.fees), vat = num(r.vat), refunds = num(r.refunds);
      return { collected, payments: r.payments, fees, vat, refunds, net: Math.round((collected - fees - vat - refunds) * 100) / 100 };
    };
    const bySite = rows.map((r) => ({ operator: r.operator ?? null, site: r.site ?? null, ...line(r) }));
    const ops = new Map<string, { orgId: string | null; operator: string | null; collected: number; payments: number; fees: number; vat: number; refunds: number; net: number }>();
    for (const r of bySite.map((x, i) => ({ ...x, orgId: rows[i].org_id || null }))) {
      const k = r.orgId ?? '';
      const a = ops.get(k) ?? { orgId: r.orgId, operator: r.operator, collected: 0, payments: 0, fees: 0, vat: 0, refunds: 0, net: 0 };
      for (const f of ['collected', 'payments', 'fees', 'vat', 'refunds', 'net'] as const) a[f] = Math.round((a[f] + r[f]) * 100) / 100;
      ops.set(k, a);
    }
    const orgIds = [...ops.values()].map((o) => o.orgId).filter(Boolean) as string[];
    // Months whose first day falls in the period (platform time zone).
    const shares = orgIds.length ? await many<any>(
      `SELECT s.org_id, COALESCE(sum(s.owner_share_minor), 0) AS share,
              COALESCE(sum((SELECT sum(amount_minor) FROM statement_payment sp WHERE sp.statement_id = s.id AND sp.voided_at IS NULL)), 0) AS paid
         FROM commission_statement s
        WHERE s.org_id = ANY($1::uuid[]) AND s.owner_id IS NOT NULL AND s.finalised_at IS NOT NULL AND s.owner_share_minor > 0
          AND (s.period::timestamp AT TIME ZONE $4) >= $2 AND (s.period::timestamp AT TIME ZONE $4) < $3
        GROUP BY 1`, [orgIds, p.from, p.to, tz()]) : [];
    const byShare = new Map(shares.map((x: any) => [x.org_id, x]));
    const byOperator = [...ops.values()].map((o) => {
      const sh = o.orgId ? byShare.get(o.orgId) : null;
      return { ...o, ownerShares: num(sh?.share), ownerSharesPaid: num(sh?.paid) };
    });
    return { bySite, byOperator };
  });
}
