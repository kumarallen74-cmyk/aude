import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { many, pool } from './pool.js';

/**
 * v1.9.0: the runtime role keeps least privilege. No migration after 048 hands every table back with a blanket
 * grant (it re-opens the append-only audit log), and on a migrated database the tables that are append-only,
 * write-once or reference data have exactly the privileges the code uses (migration 076).
 */
after(() => pool.end());
const DIR = join(import.meta.dirname, '..', '..', 'db', 'migrations');
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);

test('no migration after 048 grants ALL TABLES or ALL SEQUENCES to the runtime role', () => {
  const offenders = readdirSync(DIR).filter((f) => f.endsWith('.sql') && f > '048')
    .filter((f) => /^\s*GRANT\b[^;]*\bON\s+ALL\s+(TABLES|SEQUENCES)\b/im.test(readFileSync(join(DIR, f), 'utf8').replace(/--.*$/gm, '')));
  assert.deepEqual(offenders, []);
});

test('the runtime role has exactly the privileges the code uses on restricted tables', { skip: !DB_OK }, async () => {
  const rows = await many<{ t: string; p: string }>(
    `SELECT table_name AS t, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
       FROM information_schema.role_table_grants
      WHERE grantee = 'plugsure_app' AND table_name = ANY($1::text[]) GROUP BY 1 ORDER BY 1`,
    [['app_driver_deletion', 'audit_head', 'driver_idempotency', 'audit_log', 'country', 'currency_unit', 'oidc_login_tx', 'payment_webhook_event', 'whatsapp_event', 'whatsapp_message',
      'whatsapp_conversation', 'whatsapp_chat_message', 'gateway_transaction', 'gateway_balance_snapshot', 'gateway_sync_state', 'reconciliation_exception',
      'owner_bank_account', 'statement_payment', 'refund_transfer', 'payout_transfer', 'gateway_report', 'gateway_account_settings',
      'bank_statement', 'bank_statement_line', 'tax_withholding', 'owner_bank_change_request', 'accounting_export',
      'site_energy_rate', 'site_energy_cost', 'finance_budget', 'finance_org_settings', 'receivable_note', 'dunning_reminder', 'receivable_write_off',
      'fx_rate', 'finance_report_schedule', 'finance_period_lock', 'site_investment', 'revenue_anomaly', 'fleet_statement_send',
      'tax_filing', 'owner_statement_dispute', 'owner_statement_adjustment', 'finance_shared_cost',
      'driver_refund_request', 'fleet_prepay_entry', 'fleet_credit_alert', 'finance_export_run',
      'platform_invoice_send', 'platform_invoice_link', 'roaming_settlement', 'roaming_settlement_payment',
      'owner_payout_rule', 'ppn_input_invoice', 'ppn_period',
      'finance_digest_subscription', 'finance_digest_send', 'site_tariff', 'fleet_invoice_link',
      'driver_funds_breakage', 'consolidation_elimination', 'payment_plan', 'payment_plan_instalment', 'bad_debt_provision',
      'supplier', 'cash_account', 'cash_balance', 'cash_transfer', 'supplier_bill', 'supplier_payment', 'fixed_asset', 'fixed_asset_run',
      'purchase_order', 'purchase_order_line', 'goods_receipt', 'lease', 'lease_run', 'deposit', 'finance_check_finding',
      'gl_account', 'gl_entry', 'gl_line', 'expense_claim', 'expense_claim_line', 'expense_receipt', 'cash_count', 'intercompany_recharge', 'intercompany_settlement', 'kpi_target', 'kpi_scorecard_send',
      'bank_feed', 'bank_match_rule', 'tax_slip', 'report_pack', 'close_signoff',
      'employee', 'payroll_run', 'payroll_line', 'credit_review', 'customer_deposit', 'capex_project', 'cash_forecast_run',
      'stock_item', 'stock_location', 'stock_move', 'work_order', 'warranty_claim', 'revenue_finding', 'loan', 'loan_drawdown', 'loan_payment', 'covenant', 'covenant_test',
      'rec_purchase', 'carbon_credit', 'carbon_credit_sale', 'insurance_policy', 'insurance_claim', 'compliance_task', 'pbc_request', 'compliance_evidence',
      'grant_programme', 'grant_condition', 'grant_claim', 'grant_clawback', 'landlord_deal', 'landlord_statement', 'chargeback',
      'tax_audit_case', 'budget_plan', 'budget_plan_line', 'fx_hedge', 'procurement_saving', 'close_assignment', 'close_run',
      'corporate_tax_year', 'tax_fiscal_correction', 'tax_payment', 'payment_run', 'payment_run_item', 'corp_card', 'card_txn', 'card_statement',
      'customer_contract', 'contract_obligation', 'contract_billing', 'tp_policy', 'dq_run', 'finance_scenario']]);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.t, r.p])), {
    app_driver_deletion: 'INSERT,SELECT',
    audit_head: 'INSERT,SELECT,UPDATE',
    audit_log: 'INSERT,SELECT',
    driver_idempotency: 'DELETE,INSERT,SELECT,UPDATE',
    country: 'SELECT',
    currency_unit: 'SELECT',
    oidc_login_tx: 'DELETE,INSERT,SELECT',
    payment_webhook_event: 'DELETE,INSERT,SELECT',
    // (v1.10.0, 078) the WhatsApp ledger is updated by the webhook; an account event is recorded once.
    whatsapp_event: 'DELETE,INSERT,SELECT',
    whatsapp_message: 'DELETE,INSERT,SELECT,UPDATE',
    // (v1.11.0, 079) a support message is written once; its conversation changes.
    whatsapp_chat_message: 'DELETE,INSERT,SELECT',
    whatsapp_conversation: 'DELETE,INSERT,SELECT,UPDATE',
    // (v1.12.0, 080) the finance ledger is a financial record: synced and updated, never deleted by the app.
    gateway_balance_snapshot: 'DELETE,INSERT,SELECT',
    gateway_sync_state: 'INSERT,SELECT,UPDATE',
    gateway_transaction: 'INSERT,SELECT,UPDATE',
    reconciliation_exception: 'INSERT,SELECT,UPDATE',
    // (v1.14.0, 082) a recorded payment is voided, never deleted; an owner's bank details are replaced.
    owner_bank_account: 'DELETE,INSERT,SELECT,UPDATE',
    statement_payment: 'INSERT,SELECT,UPDATE',
    refund_transfer: 'INSERT,SELECT,UPDATE',
    payout_transfer: 'INSERT,SELECT,UPDATE',
    gateway_report: 'INSERT,SELECT,UPDATE',
    gateway_account_settings: 'INSERT,SELECT,UPDATE',
    bank_statement: 'INSERT,SELECT,UPDATE',
    bank_statement_line: 'INSERT,SELECT,UPDATE',
    tax_withholding: 'INSERT,SELECT,UPDATE',
    owner_bank_change_request: 'INSERT,SELECT,UPDATE',
    accounting_export: 'INSERT,SELECT,UPDATE',
    site_energy_rate: 'INSERT,SELECT,UPDATE',
    site_energy_cost: 'INSERT,SELECT,UPDATE',
    finance_budget: 'INSERT,SELECT,UPDATE',
    finance_org_settings: 'INSERT,SELECT,UPDATE',
    receivable_note: 'INSERT,SELECT,UPDATE',
    dunning_reminder: 'INSERT,SELECT,UPDATE',
    receivable_write_off: 'INSERT,SELECT,UPDATE',
    fx_rate: 'INSERT,SELECT,UPDATE',
    finance_report_schedule: 'INSERT,SELECT,UPDATE',
    finance_period_lock: 'INSERT,SELECT,UPDATE',
    site_investment: 'INSERT,SELECT,UPDATE',
    revenue_anomaly: 'INSERT,SELECT,UPDATE',
    fleet_statement_send: 'INSERT,SELECT,UPDATE',
    tax_filing: 'INSERT,SELECT,UPDATE',
    owner_statement_dispute: 'INSERT,SELECT,UPDATE',
    owner_statement_adjustment: 'INSERT,SELECT,UPDATE',
    finance_shared_cost: 'INSERT,SELECT,UPDATE',
    driver_refund_request: 'INSERT,SELECT,UPDATE',
    fleet_prepay_entry: 'INSERT,SELECT,UPDATE',
    fleet_credit_alert: 'INSERT,SELECT,UPDATE',
    finance_export_run: 'INSERT,SELECT,UPDATE',
    platform_invoice_send: 'INSERT,SELECT,UPDATE',
    platform_invoice_link: 'INSERT,SELECT,UPDATE',
    roaming_settlement: 'INSERT,SELECT,UPDATE',
    roaming_settlement_payment: 'INSERT,SELECT,UPDATE',
    owner_payout_rule: 'INSERT,SELECT,UPDATE',
    ppn_input_invoice: 'INSERT,SELECT,UPDATE',
    ppn_period: 'INSERT,SELECT,UPDATE',
    finance_digest_subscription: 'INSERT,SELECT,UPDATE',
    finance_digest_send: 'INSERT,SELECT,UPDATE',
    site_tariff: 'INSERT,SELECT,UPDATE',
    fleet_invoice_link: 'INSERT,SELECT,UPDATE',
    driver_funds_breakage: 'INSERT,SELECT,UPDATE',
    consolidation_elimination: 'INSERT,SELECT,UPDATE',
    payment_plan: 'INSERT,SELECT,UPDATE',
    payment_plan_instalment: 'INSERT,SELECT,UPDATE',
    bad_debt_provision: 'INSERT,SELECT,UPDATE',
    supplier: 'INSERT,SELECT,UPDATE',
    cash_account: 'INSERT,SELECT,UPDATE',
    cash_balance: 'INSERT,SELECT,UPDATE',
    cash_transfer: 'INSERT,SELECT,UPDATE',
    supplier_bill: 'INSERT,SELECT,UPDATE',
    supplier_payment: 'INSERT,SELECT,UPDATE',
    fixed_asset: 'INSERT,SELECT,UPDATE',
    fixed_asset_run: 'INSERT,SELECT,UPDATE',
    purchase_order: 'INSERT,SELECT,UPDATE',
    purchase_order_line: 'INSERT,SELECT,UPDATE',
    goods_receipt: 'INSERT,SELECT,UPDATE',
    lease: 'INSERT,SELECT,UPDATE',
    lease_run: 'INSERT,SELECT,UPDATE',
    deposit: 'INSERT,SELECT,UPDATE',
    finance_check_finding: 'INSERT,SELECT,UPDATE',
    gl_account: 'INSERT,SELECT,UPDATE',
    gl_entry: 'INSERT,SELECT,UPDATE',
    gl_line: 'INSERT,SELECT,UPDATE',
    expense_claim: 'INSERT,SELECT,UPDATE',
    expense_claim_line: 'INSERT,SELECT,UPDATE',
    expense_receipt: 'INSERT,SELECT,UPDATE',
    cash_count: 'INSERT,SELECT,UPDATE',
    intercompany_recharge: 'INSERT,SELECT,UPDATE',
    intercompany_settlement: 'INSERT,SELECT,UPDATE',
    kpi_target: 'INSERT,SELECT,UPDATE',
    kpi_scorecard_send: 'INSERT,SELECT,UPDATE',
    bank_feed: 'INSERT,SELECT,UPDATE', bank_match_rule: 'INSERT,SELECT,UPDATE', tax_slip: 'INSERT,SELECT,UPDATE', report_pack: 'INSERT,SELECT,UPDATE', close_signoff: 'INSERT,SELECT,UPDATE',
    employee: 'INSERT,SELECT,UPDATE', payroll_run: 'INSERT,SELECT,UPDATE', payroll_line: 'INSERT,SELECT,UPDATE', credit_review: 'INSERT,SELECT,UPDATE', customer_deposit: 'INSERT,SELECT,UPDATE', capex_project: 'INSERT,SELECT,UPDATE', cash_forecast_run: 'INSERT,SELECT,UPDATE',
    stock_item: 'INSERT,SELECT,UPDATE', stock_location: 'INSERT,SELECT,UPDATE', stock_move: 'INSERT,SELECT,UPDATE', work_order: 'INSERT,SELECT,UPDATE', warranty_claim: 'INSERT,SELECT,UPDATE', revenue_finding: 'INSERT,SELECT,UPDATE',
    loan: 'INSERT,SELECT,UPDATE', loan_drawdown: 'INSERT,SELECT,UPDATE', loan_payment: 'INSERT,SELECT,UPDATE', covenant: 'INSERT,SELECT,UPDATE', covenant_test: 'INSERT,SELECT,UPDATE',
    rec_purchase: 'INSERT,SELECT,UPDATE', carbon_credit: 'INSERT,SELECT,UPDATE', carbon_credit_sale: 'INSERT,SELECT,UPDATE', insurance_policy: 'INSERT,SELECT,UPDATE', insurance_claim: 'INSERT,SELECT,UPDATE',
    compliance_task: 'INSERT,SELECT,UPDATE', pbc_request: 'INSERT,SELECT,UPDATE', compliance_evidence: 'INSERT,SELECT,UPDATE',
    grant_programme: 'INSERT,SELECT,UPDATE', grant_condition: 'INSERT,SELECT,UPDATE', grant_claim: 'INSERT,SELECT,UPDATE', grant_clawback: 'INSERT,SELECT,UPDATE', landlord_deal: 'INSERT,SELECT,UPDATE',
    landlord_statement: 'INSERT,SELECT,UPDATE', chargeback: 'INSERT,SELECT,UPDATE', tax_audit_case: 'INSERT,SELECT,UPDATE', budget_plan: 'INSERT,SELECT,UPDATE', budget_plan_line: 'INSERT,SELECT,UPDATE', fx_hedge: 'INSERT,SELECT,UPDATE', procurement_saving: 'INSERT,SELECT,UPDATE', close_assignment: 'INSERT,SELECT,UPDATE', close_run: 'INSERT,SELECT,UPDATE', corporate_tax_year: 'INSERT,SELECT,UPDATE', tax_fiscal_correction: 'INSERT,SELECT,UPDATE', tax_payment: 'INSERT,SELECT,UPDATE', payment_run: 'INSERT,SELECT,UPDATE', payment_run_item: 'INSERT,SELECT,UPDATE', corp_card: 'INSERT,SELECT,UPDATE', card_txn: 'INSERT,SELECT,UPDATE', card_statement: 'INSERT,SELECT,UPDATE', customer_contract: 'INSERT,SELECT,UPDATE', contract_obligation: 'INSERT,SELECT,UPDATE', contract_billing: 'INSERT,SELECT,UPDATE', tp_policy: 'INSERT,SELECT,UPDATE', dq_run: 'INSERT,SELECT,UPDATE', finance_scenario: 'INSERT,SELECT,UPDATE',
  });
});
