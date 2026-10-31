import { createHash } from 'node:crypto';
import { many, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { zip } from './xlsx.js';
import { journal, journalCsv } from './finance-journal.js';
import { verifyChain } from './audit.js';
import type { Account, Period } from './finance.js';

/**
 * The audit pack (v1.20.0): one ZIP for the year-end auditor, for a payments account and a period (up to 400 days):
 *
 *   journal.csv            the accounting journal (double entry, the operator's chart of accounts)
 *   ledger.csv             the gateway's ledger: every payment, refund, payout and fee
 *   statements.csv         owner statements and statements to PlugSure finalised in the period
 *   statement-payments.csv payments recorded against statements (voids included, with the reason)
 *   transfers.csv          refunds and owner payouts sent from PlugSure: who asked, who approved, the result
 *   bank-lines.csv         uploaded bank statement lines and what each was matched to
 *   tax-withholdings.csv   PPh 23 records (voids included)
 *   write-offs.csv         write-off requests and decisions
 *   audit-log.csv          the organisation's audit log for the period: actor, action, target, and the hash chain
 *   manifest.json          what is in the pack: the period, each file's rows, bytes and SHA-256, and the audit chain's
 *                          verification at the time the pack was made
 *   README.txt             how to check the checksums
 *
 * Account numbers are never included (only the last four digits). The pack is generated on request and audited.
 */

const zone = () => config.billing.timeZone;
const cell = (v: unknown) => {
  const s = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csvOf = (rows: any[], cols: string[]) => '﻿' + [cols, ...rows.map((r) => cols.map((c) => r[c]))].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

export async function build(a: Account, p: Period, orgId: string, platformAdmin: boolean) {
  const org = a.orgId ?? orgId;
  const args = [p.from, p.to];
  const q = (sql: string, params: unknown[]) => outsideRequestScope(() => many<any>(sql, params));
  const [j, ledger, statements, payments, refunds, payouts, bank, tax, wo, log, chain] = await Promise.all([
    journal(a, p),
    q(`SELECT gateway_created_at, external_id, reference_id, kind, status, cashflow, channel_code, currency, amount, fee, vat, withholding_tax, net_amount, settlement_status, estimated_settlement_at
         FROM gateway_transaction WHERE integration_id = $1 AND gateway_created_at >= $2 AND gateway_created_at < $3 ORDER BY gateway_created_at LIMIT 200000`, [a.id, ...args]),
    q(`SELECT s.number, to_char(s.period, 'YYYY-MM') AS period, CASE WHEN s.owner_id IS NULL THEN 'to PlugSure' ELSE 'owner' END AS kind, COALESCE(w.legal_name, w.name) AS owner,
              s.currency, s.gtv_minor, s.commission_minor, s.net_minor, s.tax_minor, s.total_minor, s.owner_share_minor, s.finalised_at
         FROM commission_statement s LEFT JOIN site_owner w ON w.id = s.owner_id
        WHERE s.org_id = $1 AND s.finalised_at >= $2 AND s.finalised_at < $3 ORDER BY s.finalised_at`, [org, ...args]),
    q(`SELECT s.number AS statement, p.kind, p.amount_minor, p.currency, p.paid_on, p.reference, p.created_at, p.voided_at, p.void_reason
         FROM statement_payment p JOIN commission_statement s ON s.id = p.statement_id
        WHERE p.org_id = $1 AND p.created_at >= $2 AND p.created_at < $3 ORDER BY p.created_at`, [org, ...args]),
    q(`SELECT 'refund' AS kind, t.id, t.rail, t.amount_minor, t.currency, t.bank_code, '••••' || t.account_last4 AS account, t.holder_name, t.checked_name, t.state,
              ra.name AS requested_by, t.requested_at, aa.name AS approved_by, t.approved_at, t.reason, t.disburse_id, t.response_code, t.error
         FROM refund_transfer t LEFT JOIN app_user ra ON ra.id = t.requested_by LEFT JOIN app_user aa ON aa.id = t.approved_by
        WHERE t.org_id = $1 AND t.requested_at >= $2 AND t.requested_at < $3`, [org, ...args]),
    q(`SELECT 'owner_payout' AS kind, t.id, t.rail, t.amount_minor, t.currency, t.bank_code, '••••' || t.account_last4 AS account, t.holder_name, t.checked_name, t.state,
              ra.name AS requested_by, t.requested_at, aa.name AS approved_by, t.approved_at, t.reason, t.disburse_id, t.response_code, t.error
         FROM payout_transfer t LEFT JOIN app_user ra ON ra.id = t.requested_by LEFT JOIN app_user aa ON aa.id = t.approved_by
        WHERE t.org_id = $1 AND t.requested_at >= $2 AND t.requested_at < $3`, [org, ...args]),
    q(`SELECT s.bank, s.filename, l.line_date, l.description, l.reference, l.amount_minor, l.balance_minor, l.matched_kind, l.matched_ref, l.matched_auto, u.name AS matched_by, l.matched_at, l.note
         FROM bank_statement_line l JOIN bank_statement s ON s.id = l.statement_id LEFT JOIN app_user u ON u.id = l.matched_by
        WHERE l.org_id = $1 AND l.line_date >= ($2::timestamptz AT TIME ZONE $4)::date AND l.line_date < ($3::timestamptz AT TIME ZONE $4)::date ORDER BY l.line_date, l.id`, [org, ...args, zone()]),
    q(`SELECT period, kind, counterparty, counterparty_npwp, base_minor, rate_bps, amount_minor, bukti_number, bukti_date, created_at, voided_at, void_reason
         FROM tax_withholding WHERE org_id = $1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at`, [org, ...args]),
    q(`SELECT w.kind, w.ref, w.amount_minor, w.currency, w.reason, w.state, a.name AS requested_by, w.requested_at, b.name AS decided_by, w.decided_at, w.decision_note
         FROM receivable_write_off w LEFT JOIN app_user a ON a.id = w.requested_by LEFT JOIN app_user b ON b.id = w.decided_by
        WHERE w.org_id = $1 AND w.requested_at >= $2 AND w.requested_at < $3 ORDER BY w.requested_at`, [org, ...args]),
    q(`SELECT l.seq, l.ts, l.actor_type, COALESCE(u.email, l.actor_id::text) AS actor, l.action, l.target_type, l.target_id, l.ip, l.prev_hash, l.hash
         FROM audit_log l LEFT JOIN app_user u ON u.id::text = l.actor_id::text
        WHERE l.org_id = $1 AND l.ts >= $2 AND l.ts < $3 ORDER BY l.seq LIMIT 500000`, [org, ...args]),
    verifyChain(org).catch((e) => ({ ok: false, entries: 0, expectedEntries: 0, problems: [(e as Error).message] } as any)),
  ]);
  const transferCols = ['kind', 'id', 'rail', 'amount_minor', 'currency', 'bank_code', 'account', 'holder_name', 'checked_name', 'state', 'requested_by', 'requested_at', 'approved_by', 'approved_at', 'reason', 'disburse_id', 'response_code', 'error'];
  const files: Array<{ name: string; rows: number; data: Buffer }> = [
    { name: 'journal.csv', rows: j.lines.length, data: Buffer.from(journalCsv(j)) },
    { name: 'ledger.csv', rows: ledger.length, data: Buffer.from(csvOf(ledger, ['gateway_created_at', 'external_id', 'reference_id', 'kind', 'status', 'cashflow', 'channel_code', 'currency', 'amount', 'fee', 'vat', 'withholding_tax', 'net_amount', 'settlement_status', 'estimated_settlement_at'])) },
    { name: 'statements.csv', rows: statements.length, data: Buffer.from(csvOf(statements, ['number', 'period', 'kind', 'owner', 'currency', 'gtv_minor', 'commission_minor', 'net_minor', 'tax_minor', 'total_minor', 'owner_share_minor', 'finalised_at'])) },
    { name: 'statement-payments.csv', rows: payments.length, data: Buffer.from(csvOf(payments, ['statement', 'kind', 'amount_minor', 'currency', 'paid_on', 'reference', 'created_at', 'voided_at', 'void_reason'])) },
    { name: 'transfers.csv', rows: refunds.length + payouts.length, data: Buffer.from(csvOf([...refunds, ...payouts], transferCols)) },
    { name: 'bank-lines.csv', rows: bank.length, data: Buffer.from(csvOf(bank, ['bank', 'filename', 'line_date', 'description', 'reference', 'amount_minor', 'balance_minor', 'matched_kind', 'matched_ref', 'matched_auto', 'matched_by', 'matched_at', 'note'])) },
    { name: 'tax-withholdings.csv', rows: tax.length, data: Buffer.from(csvOf(tax, ['period', 'kind', 'counterparty', 'counterparty_npwp', 'base_minor', 'rate_bps', 'amount_minor', 'bukti_number', 'bukti_date', 'created_at', 'voided_at', 'void_reason'])) },
    { name: 'write-offs.csv', rows: wo.length, data: Buffer.from(csvOf(wo, ['kind', 'ref', 'amount_minor', 'currency', 'reason', 'state', 'requested_by', 'requested_at', 'decided_by', 'decided_at', 'decision_note'])) },
    { name: 'audit-log.csv', rows: log.length, data: Buffer.from(csvOf(log, ['seq', 'ts', 'actor_type', 'actor', 'action', 'target_type', 'target_id', 'ip', 'prev_hash', 'hash'])) },
  ];
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const manifest = {
    generatedAt: new Date().toISOString(), generator: 'PlugSure CSMS', version: process.env.npm_package_version ?? null,
    account: { id: a.id, label: a.label, provider: a.provider }, organisation: org, platformAdmin,
    period: { from: p.from.toISOString(), to: p.to.toISOString(), timeZone: zone() },
    files: files.map((f) => ({ name: f.name, rows: f.rows, bytes: f.data.length, sha256: sha(f.data) })),
    auditChain: { ok: chain.ok, entries: chain.entries, expectedEntries: chain.expectedEntries, problems: chain.problems ?? [] },
    notes: ['Amounts in the minor unit of their currency (rupiah for IDR).', 'Bank account numbers are shown by their last four digits only.'],
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
  const readme = Buffer.from([
    `PlugSure audit pack — ${a.label}`,
    `Period: ${p.from.toISOString()} to ${p.to.toISOString()} (${zone()})`,
    '',
    'manifest.json lists every file with its SHA-256. To check a file:',
    '  sha256sum journal.csv            (Linux)',
    '  shasum -a 256 journal.csv        (macOS)',
    '  CertUtil -hashfile journal.csv SHA256   (Windows)',
    `manifest.json itself: SHA-256 ${sha(manifestBuf)}`,
    '',
    `The audit log's hash chain was ${manifest.auditChain.ok ? 'verified intact' : 'NOT verified (see manifest.json → auditChain)'} when the pack was made.`,
  ].join('\r\n') + '\r\n');
  const body = zip([...files.map((f) => ({ name: f.name, data: f.data })), { name: 'manifest.json', data: manifestBuf }, { name: 'README.txt', data: readme }]);
  return { body, manifest, manifestSha256: sha(manifestBuf) };
}
