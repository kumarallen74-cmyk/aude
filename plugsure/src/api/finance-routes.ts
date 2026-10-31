import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { limitParam } from './paging.js';
import { assertCan, can } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import { TokenBuckets } from '../services/ratelimit.js';
import * as fin from '../services/finance.js';
import { render, type ExportFormat } from '../services/finance-export.js';
import * as pay from '../services/payouts.js';
import * as xfer from '../services/refund-transfers.js';
import * as pxfer from '../services/payout-transfers.js';
import * as fj from '../services/finance-journal.js';
import * as bank from '../services/bank-recon.js';
import * as wht from '../services/withholding.js';
import * as forecast from '../services/finance-forecast.js';
import * as feeAudit from '../services/fee-audit.js';
import * as acctx from '../services/accounting-export.js';
import * as ownerPortal from '../services/owner-portal.js';
import * as energy from '../services/energy-margin.js';
import * as budgets from '../services/budgets.js';
import * as collections from '../services/collections.js';
import * as auditPack from '../services/audit-pack.js';
import * as fx from '../services/fx.js';
import * as approvals from '../services/finance-approvals.js';
import * as reportSched from '../services/report-schedules.js';
import * as finSummary from '../services/finance-summary.js';
import * as periods from '../services/finance-periods.js';
import * as invest from '../services/site-investments.js';
import * as anomalies from '../services/revenue-anomalies.js';
import * as taxCal from '../services/tax-calendar.js';
import * as disputes from '../services/owner-disputes.js';
import * as sharedCosts from '../services/shared-costs.js';
import * as settle from '../services/settlement-tracking.js';
import * as driverRefunds from '../services/driver-refunds.js';
import * as warehouse from '../services/finance-warehouse.js';
import * as yearEnd from '../services/year-end.js';

/**
 * Commercial → Finance (v1.12.0): the payment gateway's side of the money, per gateway account.
 *
 *   GET  /v1/finance/accounts                               the gateway accounts the caller may see
 *   GET  /v1/finance/accounts/:id/overview                  collected, fees, refunds, net, receivable, balance, payable
 *   GET  /v1/finance/accounts/:id/transactions              the gateway ledger, filtered, paged
 *   GET  /v1/finance/accounts/:id/receivables               collected, not yet settled; fleet invoices due
 *   GET  /v1/finance/accounts/:id/payables                  refunds due, owners' shares on finalised statements
 *   GET  /v1/finance/accounts/:id/breakdown                 (v1.15.0) the period by operator and by site
 *   GET  /v1/finance/accounts/:id/transactions/:tid/trail   (v1.16.0) one ledger row's whole trail
 *   GET  /v1/finance/method-costs                           (v1.16.0) what each method costs, per gateway account
 *   GET  /v1/finance/accounts/:id/reports                   (v1.16.0) Xendit reports requested for the account
 *   POST /v1/finance/accounts/:id/reports                   ask Xendit to generate one (?from&to; body { type })
 *   GET  /v1/finance/accounts/:id/reports/:rid              its state (asked of Xendit while pending); ?link=true: the download link
 *   (v1.17.0) GET/PUT /v1/finance/accounts/:id/settings     the journal's chart of accounts; the monthly close e-mail
 *   GET  /v1/finance/accounts/:id/journal                   the period as double-entry journal entries (CSV, Excel, JSON)
 *   POST /v1/finance/accounts/:id/close-email/send          send a month's close now (body { month }, default last month)
 *   (v1.18.0) GET /v1/finance/approvals                     transfers waiting for a second person
 *   GET/POST /v1/finance/bank-statements                    bank statements uploaded (CSV), matched automatically
 *   GET  /v1/finance/bank-lines                             their lines (?statement, ?open=true), each with its match
 *   GET  /v1/finance/bank-lines/:lid/candidates             what an open line could be
 *   POST /v1/finance/bank-lines/:lid/match                  match by hand, mark ignored (with a note), or undo
 *   (v1.16.0) owner payouts sent through Duitku Disbursement (two people)
 *   GET  /v1/finance/payout-transfers                       payouts (?open=true: not settled)
 *   POST /v1/finance/statements/:sid/payout                 request one: the owner's saved account, checked by name
 *   POST /v1/finance/payout-transfers/:tid/approve          a second person approves: sent once; paid → statement payment
 *   POST /v1/finance/payout-transfers/:tid/reject           before it is sent, with a reason
 *   POST /v1/finance/payout-transfers/:tid/resolve          a result Duitku never confirmed, settled by a person
 *   GET  /v1/finance/accounts/:id/fees                      fees by month and channel; QRIS actual vs estimated
 *   GET  /v1/finance/accounts/:id/exceptions                reconciliation differences
 *   POST /v1/finance/accounts/:id/exceptions/:eid/apply     apply a payment the gateway has and PlugSure missed
 *   POST /v1/finance/accounts/:id/exceptions/:eid/resolve   close one with a note
 *   POST /v1/finance/accounts/:id/sync                      sync, take the balance and reconcile now
 *   GET  /v1/finance/accounts/:id/export                    the period as CSV, Excel or PDF
 *   (v1.14.0) payouts and statement payments, recorded (PlugSure moves no money: the operator's bank does)
 *   GET  /v1/finance/owner-shares                           owners' shares on finalised statements: due, part-paid, paid
 *   GET  /v1/finance/owner-shares/transfer-list.csv         what is owed, with the owners' bank details, for the bank
 *   GET  /v1/finance/operator-statements                    operators' statements to PlugSure (platform:admin)
 *   GET  /v1/finance/statements/:sid/payments               the payments recorded against a statement
 *   POST /v1/finance/statements/:sid/payments               record a transfer (amount, date, bank reference)
 *   POST /v1/finance/statement-payments/:pid/void           void a mistaken one, with a reason
 *   GET  /v1/finance/owners/:oid/bank-account               an owner's bank details (the number masked)
 *   PUT  /v1/finance/owners/:oid/bank-account               set them (the number sealed)
 *   (v1.15.0) Duitku Disbursement: refunds sent with two people, owners' accounts checked by name
 *   POST /v1/finance/owners/:oid/bank-account/check         the holder's name the bank has (Disbursement inquiry)
 *   GET  /v1/refund-transfers                               refund transfers (?open=true: those not settled)
 *   POST /v1/refunds/:id/disbursement                       request one: the driver's bank account, checked by name
 *   POST /v1/refund-transfers/:tid/approve                  a second person approves: sent, once
 *   POST /v1/refund-transfers/:tid/reject                   rejected or withdrawn before it is sent, with a reason
 *   POST /v1/refund-transfers/:tid/resolve                  a result Duitku never confirmed, settled by a person
 *
 * Reading is payment:read, changing is payment:write. An operator sees its own account(s); the platform's account
 * (org NULL) needs platform:admin as well. Every action is audited.
 */

const KINDS = ['payment', 'refund', 'payout', 'transfer', 'fee', 'other'];
const STATUSES = ['success', 'pending', 'failed', 'voided', 'reversed'];
const SETTLEMENTS = ['pending', 'settled', 'early_settled', 'none'];
const syncBuckets = new TokenBuckets();

export async function registerFinanceRoutes(app: FastifyInstance): Promise<void> {
  const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });
  const platform = (req: FastifyRequest) => can(req.principal, { permission: 'platform:admin' });
  const account = (req: FastifyRequest) => {
    const id = String((req.params as Record<string, string>).id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw Object.assign(new Error('No such payments account.'), { statusCode: 404 });
    return fin.accountFor(req.principal.orgId, platform(req), id);
  };
  const period = (req: FastifyRequest) => {
    const q = (req.query ?? {}) as Record<string, string>;
    return fin.periodOf(q.from, q.to);
  };
  const failed = (reply: FastifyReply, e: unknown) => {
    if (e instanceof fin.FinanceError) return reply.status(e.statusCode).send({ error: e.message });
    throw e;
  };
  const audit = (req: FastifyRequest, action: string, targetId: string, after: Record<string, unknown>) => writeAudit({
    orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action, targetType: 'payments_account', targetId, ip: req.ip, after,
  });

  app.get('/v1/finance/accounts', async (req) => {
    assertCan(req.principal, { permission: 'payment:read' });
    return { accounts: await fin.accountsFor(req.principal.orgId, platform(req)) };
  });

  app.get('/v1/finance/method-costs', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await fin.methodCosts(await fin.accountsFor(req.principal.orgId, platform(req)), period(req)); } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/overview', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { const a = await account(req); return { account: a, ...(await fin.overview(a.id, period(req))) }; } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/transactions', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    for (const [k, allowed] of [['kind', KINDS], ['status', STATUSES], ['settlement', SETTLEMENTS]] as const) {
      if (q[k] && !allowed.includes(q[k]!)) throw bad(`${k} must be one of ${allowed.join(', ')}`);
    }
    if (q.matched && !['true', 'false'].includes(q.matched)) throw bad('matched must be true or false');
    if (q.before && !/^\d{1,18}$/.test(q.before)) throw bad('before is the id of the last row of the previous page');
    const limit = limitParam(q.limit, 100, 500);
    try {
      const a = await account(req);
      const rows = await fin.transactions(a.id, period(req), {
        kind: q.kind || null, status: q.status || null, settlement: q.settlement || null, channel: q.channel ? String(q.channel).slice(0, 60) : null,
        matched: q.matched ? q.matched === 'true' : null, q: q.q ? String(q.q).slice(0, 100) : null, beforeId: q.before || null, limit,
      });
      return { transactions: rows, nextBefore: rows.length === limit ? rows[rows.length - 1]!.id : null };
    } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/receivables', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { const a = await account(req); return await fin.receivables(a.id, a.orgId); } catch (e) { return failed(reply, e); }
  });

  // (v1.19.0) The cash-flow forecast: committed flows over 30/60/90 days, the running position, the first shortfall.
  app.get('/v1/finance/accounts/:id/forecast', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    try {
      const a = await account(req);
      const f = await forecast.forecast(a, { days: q.days, termsDays: q.termsDays, runRate: q.runRate });
      if (q.format === 'csv') {
        return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="forecast-${f.from}-${f.days}d.csv"`).send(forecast.forecastCsv(f));
      }
      return f;
    } catch (e) {
      if (e instanceof forecast.ForecastError) return reply.status(e.statusCode).send({ error: e.message });
      return failed(reply, e);
    }
  });

  app.get('/v1/finance/accounts/:id/transactions/:tid/trail', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { const a = await account(req); return await fin.trail(a.id, String((req.params as Record<string, string>).tid ?? '')); } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/reports', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return { reports: await fin.reports(await account(req)) }; } catch (e) { return failed(reply, e); }
  });

  app.post('/v1/finance/accounts/:id/reports', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try {
      const a = await account(req);
      const type = String(((req.body ?? {}) as Record<string, unknown>).type ?? '');
      const r = await fin.requestReport(a, type, period(req), /^[0-9a-f-]{36}$/i.test(String(req.principal.userId ?? '')) ? req.principal.userId! : null);
      await audit(req, 'finance.report_requested', a.id, { type, report: r.id, from: r.from, to: r.to });
      return reply.status(201).send({ report: r });
    } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/reports/:rid', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try {
      const a = await account(req);
      const link = String(((req.query ?? {}) as Record<string, string>).link ?? '') === 'true';
      const r = await fin.reportStatus(a, String((req.params as Record<string, string>).rid ?? ''), link);
      if (link && r.url) await audit(req, 'finance.report_downloaded', a.id, { report: r.id, type: r.type });
      return { report: r };
    } catch (e) { return failed(reply, e); }
  });

  // ─────────────────────────────────────────── (v1.17.0) the accounting journal and the monthly close e-mail

  app.get('/v1/finance/accounts/:id/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try {
      const a = await account(req);
      return { settings: await fj.settingsFor(a), defaults: fj.DEFAULT_ACCOUNTS, labels: fj.JOURNAL_LABELS };
    } catch (e) { return failed(reply, e); }
  });

  app.put('/v1/finance/accounts/:id/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const a = await account(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const st = await fj.saveSettings(a, b, req.principal.orgId, /^[0-9a-f-]{36}$/i.test(String(req.principal.userId ?? '')) ? req.principal.userId! : null);
      await audit(req, 'finance.settings_saved', a.id, { closeEmail: { enabled: st.closeEmail.enabled, recipients: st.closeEmail.recipients.length }, journalAccounts: b.journalAccounts !== undefined });
      return { settings: st };
    } catch (e) { return failed(reply, e); }
  });

  // (v1.19.0) The journal of a closed month as the accounting package's import file; the export log.
  app.get('/v1/finance/accounts/:id/accounting-exports', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { const a = await account(req); return await acctx.log(a); } catch (e) { return failed(reply, e); }
  });

  app.post('/v1/finance/accounts/:id/accounting-exports', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try {
      const a = await account(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await acctx.exportMonth(a, b.month, b.package, userUuid(req));
      await audit(req, 'finance.accounting_exported', a.id, { month: r.month, package: r.package, entries: r.entries, totalDebit: r.totalDebit });
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${r.filename}"`).send(r.csv);
    } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/journal', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const format = String(((req.query ?? {}) as Record<string, string>).format ?? 'xlsx');
    if (!['csv', 'xlsx', 'json'].includes(format)) throw bad('format must be csv, xlsx or json');
    try {
      const a = await account(req);
      const p = period(req);
      const j = await fj.journal(a, p);
      await audit(req, 'finance.journal_exported', a.id, { format, from: p.from.toISOString(), to: p.to.toISOString(), lines: j.lines.length });
      if (format === 'json') return j;
      const name = `plugsure-journal-${p.from.toISOString().slice(0, 10)}`;
      return format === 'csv'
        ? reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}.csv"`).header('cache-control', 'no-store').send(fj.journalCsv(j))
        : reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="${name}.xlsx"`).header('cache-control', 'no-store').send(fj.journalXlsx(a, p, j));
    } catch (e) { return failed(reply, e); }
  });

  app.post('/v1/finance/accounts/:id/close-email/send', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const a = await account(req);
      const { sendClose, previousMonth } = await import('../services/finance-close-mail.js');
      const month = String(((req.body ?? {}) as Record<string, unknown>).month ?? previousMonth());
      const r = await sendClose(a, month);
      await audit(req, 'finance.close_email_sent', a.id, { month, recipients: r.to.length });
      return { ok: true, month, to: r.to, reference: r.reference };
    } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/breakdown', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { const a = await account(req); return await fin.closeBreakdown(a.id, period(req)); } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/payables', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { const a = await account(req); return await fin.payables(a.id, a.orgId ?? null); } catch (e) { return failed(reply, e); }
  });

  // (v1.19.0) The gateway fee audit: every fee against the contracted rate; the overcharged payments as CSV.
  app.get('/v1/finance/accounts/:id/fee-audit', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    try {
      const a = await account(req);
      const p = period(req);
      const r = await feeAudit.audit(a, p);
      if (q.format === 'csv') {
        await auditPay(req, 'finance.fee_audit_exported', 'integration', a.id, { from: p.from, to: p.to, overcharged: r.totals.overcharged, overcharge: r.totals.overcharge });
        return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="fee-audit-${a.provider}.csv"`).send(feeAudit.auditCsv(r));
      }
      const { _all, ...view } = r;
      void _all;
      return view;
    } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/fees', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { const a = await account(req); return await fin.fees(a.id, period(req)); } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/exceptions', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    if (q.state && !['open', 'resolved'].includes(q.state)) throw bad('state must be open or resolved');
    try {
      const a = await account(req);
      return { exceptions: await fin.exceptions(a.id, (q.state as 'open' | 'resolved' | undefined) ?? null, limitParam(q.limit, 100, 500)) };
    } catch (e) { return failed(reply, e); }
  });

  const exceptionId = (req: FastifyRequest) => {
    const id = String((req.params as Record<string, string>).eid ?? '');
    if (!/^\d{1,18}$/.test(id)) throw Object.assign(new Error('No such exception.'), { statusCode: 404 });
    return id;
  };

  app.post('/v1/finance/accounts/:id/exceptions/:eid/apply', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const a = await account(req);
      const eid = exceptionId(req);
      const r = await fin.applyMissing(eid, a.id, req.principal.userId ?? null);
      await audit(req, 'finance.exception_applied', a.id, { exception: eid, outcome: r.outcome });
      return { ok: true, outcome: r.outcome };
    } catch (e) { return failed(reply, e); }
  });

  app.post('/v1/finance/accounts/:id/exceptions/:eid/resolve', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const a = await account(req);
      const eid = exceptionId(req);
      const note = String(((req.body ?? {}) as Record<string, unknown>).note ?? '');
      await fin.resolveException(eid, a.id, note, req.principal.userId ?? null);
      await audit(req, 'finance.exception_resolved', a.id, { exception: eid, note: note.trim().slice(0, 200) });
      return { ok: true };
    } catch (e) { return failed(reply, e); }
  });

  app.post('/v1/finance/accounts/:id/sync', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    const d = syncBuckets.take(`${req.principal.userId ?? req.ip}`, 4);
    if (!d.allowed) return reply.status(429).header('Retry-After', d.retryAfterS).send({ error: 'At most 4 syncs a minute.' });
    try {
      const a = await account(req);
      const s = await fin.syncTransactions(a.id);
      const balance = await fin.snapshotBalance(a.id);
      const r = await fin.reconcile(a.id);
      await audit(req, 'finance.synced', a.id, { rows: s.rows, ok: s.ok, open: r.open });
      return { sync: s, balance, reconciliation: r };
    } catch (e) { return failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/export', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    const format = (q.format ?? 'xlsx') as ExportFormat;
    if (!['csv', 'xlsx', 'pdf'].includes(format)) throw bad('format must be csv, xlsx or pdf');
    try {
      const a = await account(req);
      const p = period(req);
      const out = render(a, await fin.monthClose(a.id, p), format);
      await audit(req, 'finance.exported', a.id, { format, from: p.from.toISOString(), to: p.to.toISOString() });
      const name = `plugsure-finance-${(q.from ?? p.from.toISOString().slice(0, 10))}-${(q.to ?? '').slice(0, 10) || 'to-date'}.${out.ext}`;
      return reply.header('content-type', out.type).header('content-disposition', `attachment; filename="${name}"`).header('cache-control', 'no-store').send(out.body);
    } catch (e) { return failed(reply, e); }
  });

  // ─────────────────────────────────────────── (v1.14.0) payouts and statement payments, recorded

  const PAY_STATUSES = ['due', 'partial', 'paid'];
  const payFailed = (reply: FastifyReply, e: unknown) => {
    if (e instanceof pay.PayoutError) return reply.status(e.statusCode).send({ error: e.message });
    throw e;
  };
  const uuidParam = (req: FastifyRequest, name: string, what: string) => {
    const v = String((req.params as Record<string, string>)[name] ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(v)) throw Object.assign(new Error(`No such ${what}.`), { statusCode: 404 });
    return v;
  };
  const statusParam = (req: FastifyRequest) => {
    const st = String(((req.query ?? {}) as Record<string, string>).status ?? '');
    if (st && !PAY_STATUSES.includes(st)) throw bad(`status must be one of ${PAY_STATUSES.join(', ')}`);
    return (st || null) as pay.PayStatus | null;
  };
  const auditPay = (req: FastifyRequest, action: string, targetType: string, targetId: string, after: Record<string, unknown>) => writeAudit({
    orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action, targetType, targetId, ip: req.ip, after,
  });

  app.get('/v1/finance/owner-shares', async (req) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const rails = await pxfer.payoutRails(req.principal.orgId, platform(req));
    return { shares: await pay.ownerShares(req.principal.orgId, { status: statusParam(req) }), payoutsAvailable: rails.length > 0, payoutRails: rails };
  });

  app.get('/v1/finance/owner-shares/transfer-list.csv', async (req, reply) => {
    // The full account numbers: only those who may record payouts, and audited.
    assertCan(req.principal, { permission: 'payment:write' });
    const csv = await pay.transferList(req.principal.orgId);
    await auditPay(req, 'finance.transfer_list_exported', 'organisation', req.principal.orgId, { lines: Math.max(0, csv.split('\r\n').length - 2) });
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="plugsure-owner-transfers.csv"').header('cache-control', 'no-store').send(csv);
  });

  app.get('/v1/finance/operator-statements', async (req) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    return { statements: await pay.platformStatements({ status: statusParam(req) }) };
  });

  app.get('/v1/finance/statements/:sid/payments', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await pay.payments(uuidParam(req, 'sid', 'statement'), req.principal.orgId, platform(req)); } catch (e) { return payFailed(reply, e); }
  });

  app.post('/v1/finance/statements/:sid/payments', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const sid = uuidParam(req, 'sid', 'statement');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await pay.recordPayment(sid, req.principal.orgId, platform(req), b, req.principal.userId ?? null);
      await auditPay(req, r.statement.kind === 'owner_payout' ? 'finance.owner_payout_recorded' : 'finance.platform_fee_recorded', 'commission_statement', sid,
        { payment: r.paymentId, amount: Number(b.amount), paidOn: b.paidOn, reference: String(b.reference ?? '').slice(0, 120), operator: r.orgId });
      return reply.status(201).send({ paymentId: r.paymentId, statement: r.statement });
    } catch (e) { return payFailed(reply, e); }
  });

  app.post('/v1/finance/statement-payments/:pid/void', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    const pid = String((req.params as Record<string, string>).pid ?? '');
    if (!/^\d{1,18}$/.test(pid)) return reply.status(404).send({ error: 'No such payment.' });
    try {
      const reason = ((req.body ?? {}) as Record<string, unknown>).reason;
      const r = await pay.voidPayment(pid, req.principal.orgId, platform(req), reason, req.principal.userId ?? null);
      await auditPay(req, 'finance.statement_payment_voided', 'commission_statement', r.statementId, { payment: pid, reason: String(reason ?? '').slice(0, 300) });
      return { ok: true, statement: (await pay.payments(r.statementId, req.principal.orgId, platform(req))).statement };
    } catch (e) { return payFailed(reply, e); }
  });

  app.get('/v1/finance/owners/:oid/bank-account', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const a = await pay.bankAccount(req.principal.orgId, uuidParam(req, 'oid', 'site owner'));
    return a ? { account: a } : reply.status(404).send({ error: 'No bank details saved for this owner.' });
  });

  // ─────────────────────────────────────────── (v1.15.0) Duitku Disbursement

  const xferFailed = (reply: FastifyReply, e: unknown) => {
    if (e instanceof xfer.TransferError) return reply.status(e.statusCode).send({ error: e.message });
    return payFailed(reply, e);
  };
  const userUuid = (req: FastifyRequest) => (/^[0-9a-f-]{36}$/i.test(String(req.principal.userId ?? '')) ? req.principal.userId! : null);
  const tidParam = (req: FastifyRequest) => String((req.params as Record<string, string>).tid ?? '');
  const auditX = (req: FastifyRequest, action: string, t: xfer.TransferView, extra: Record<string, unknown> = {}) =>
    auditPay(req, action, 'payment_intent', t.paymentId, { transfer: t.id, amount: t.amount, currency: t.currency, bank: t.bankCode, account: t.accountMasked, state: t.state, ...extra });

  app.post('/v1/finance/owners/:oid/bank-account/check', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const oid = uuidParam(req, 'oid', 'site owner');
      const r = await xfer.checkOwnerAccount(req.principal.orgId, oid);
      await auditPay(req, 'finance.owner_bank_account_checked', 'site_owner', oid, { status: r.status, bankName: r.bankName });
      return { check: r, account: await pay.bankAccount(req.principal.orgId, oid) };
    } catch (e) { return xferFailed(reply, e); }
  });

  // (v1.18.0) How many transfers wait for a second person (the console's badge).
  app.get('/v1/finance/approvals', async (req) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const { approvalsCount } = await import('../services/transfer-approvals.js');
    return approvalsCount(req.principal.orgId, userUuid(req));
  });

  app.get('/v1/refund-transfers', async (req) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const open = String(((req.query ?? {}) as Record<string, string>).open ?? '') === 'true';
    return { transfers: await xfer.listTransfers(req.principal.orgId, { open }) };
  });

  app.post('/v1/refunds/:id/disbursement', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const id = uuidParam(req, 'id', 'payment');
      const t = await xfer.requestTransfer(req.principal.orgId, id, (req.body ?? {}) as Record<string, unknown>, userUuid(req));
      await auditX(req, 'refund.transfer_requested', t, { holder: t.holderName, bankName: t.checkedName, namesMatch: t.namesMatch });
      return reply.status(201).send({ transfer: t });
    } catch (e) { return xferFailed(reply, e); }
  });

  app.post('/v1/refund-transfers/:tid/approve', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const t = await xfer.approveTransfer(req.principal.orgId, tidParam(req), userUuid(req), can(req.principal, { permission: 'finance:approve' }));
      await auditX(req, t.state === 'awaiting_approval' ? 'refund.transfer_first_approval' : 'refund.transfer_approved', t, { responseCode: t.responseCode, error: t.error });
      return { transfer: t };
    } catch (e) { return xferFailed(reply, e); }
  });

  app.post('/v1/refund-transfers/:tid/reject', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const t = await xfer.rejectTransfer(req.principal.orgId, tidParam(req), ((req.body ?? {}) as Record<string, unknown>).reason, userUuid(req));
      await auditX(req, 'refund.transfer_rejected', t, { reason: t.reason });
      return { transfer: t };
    } catch (e) { return xferFailed(reply, e); }
  });

  app.post('/v1/refund-transfers/:tid/resolve', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const t = await xfer.resolveTransfer(req.principal.orgId, tidParam(req), b.outcome, b.note, userUuid(req));
      await auditX(req, 'refund.transfer_resolved', t, { outcome: b.outcome, note: String(b.note ?? '').slice(0, 300) });
      return { transfer: t };
    } catch (e) { return xferFailed(reply, e); }
  });

  // ─────────────────────────────────────────── (v1.16.0) owner payouts sent through Duitku Disbursement

  const auditP = (req: FastifyRequest, action: string, t: pxfer.PayoutTransferView, extra: Record<string, unknown> = {}) =>
    auditPay(req, action, 'commission_statement', t.statementId, { payout: t.id, amount: t.amount, currency: t.currency, bank: t.bankCode, account: t.accountMasked, state: t.state, ...extra });

  app.get('/v1/finance/payout-transfers', async (req) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const open = String(((req.query ?? {}) as Record<string, string>).open ?? '') === 'true';
    return { transfers: await pxfer.listPayoutTransfers(req.principal.orgId, { open }) };
  });

  app.post('/v1/finance/statements/:sid/payout', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const t = await pxfer.requestPayout(req.principal.orgId, platform(req), uuidParam(req, 'sid', 'statement'), (req.body ?? {}) as Record<string, unknown>, userUuid(req));
      await auditP(req, 'finance.owner_payout_requested', t, { holder: t.holderName, bankName: t.checkedName, namesMatch: t.namesMatch });
      return reply.status(201).send({ transfer: t });
    } catch (e) { return xferFailed(reply, e); }
  });

  app.post('/v1/finance/payout-transfers/:tid/approve', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const t = await pxfer.approvePayout(req.principal.orgId, tidParam(req), userUuid(req), can(req.principal, { permission: 'finance:approve' }));
      await auditP(req, t.state === 'awaiting_approval' ? 'finance.owner_payout_first_approval' : 'finance.owner_payout_approved', t, { responseCode: t.responseCode, error: t.error, statementPayment: t.statementPaymentId });
      return { transfer: t };
    } catch (e) { return xferFailed(reply, e); }
  });

  app.post('/v1/finance/payout-transfers/:tid/reject', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const t = await pxfer.rejectPayout(req.principal.orgId, tidParam(req), ((req.body ?? {}) as Record<string, unknown>).reason, userUuid(req));
      await auditP(req, 'finance.owner_payout_rejected', t, { reason: t.reason });
      return { transfer: t };
    } catch (e) { return xferFailed(reply, e); }
  });

  app.post('/v1/finance/payout-transfers/:tid/resolve', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const t = await pxfer.resolvePayout(req.principal.orgId, tidParam(req), b.outcome, b.note, userUuid(req));
      await auditP(req, 'finance.owner_payout_resolved', t, { outcome: b.outcome, note: String(b.note ?? '').slice(0, 300), statementPayment: t.statementPaymentId });
      return { transfer: t };
    } catch (e) { return xferFailed(reply, e); }
  });

  // ─────────────────────────────────────────── (v1.18.0) bank statements reconciled

  const bankFailed = (reply: FastifyReply, e: unknown) => {
    if (e instanceof bank.BankReconError) return reply.status(e.statusCode).send({ error: e.message });
    throw e;
  };

  app.get('/v1/finance/bank-statements', async (req) => {
    assertCan(req.principal, { permission: 'payment:read' });
    return { statements: await bank.statements(req.principal.orgId) };
  });

  app.post('/v1/finance/bank-statements', { bodyLimit: 6 * 1024 * 1024 }, async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await bank.upload(req.principal.orgId, platform(req), (req.body ?? {}) as Record<string, unknown>, userUuid(req));
      await auditPay(req, 'finance.bank_statement_uploaded', 'bank_statement', r.statementId, { bank: r.bank, from: r.from, to: r.to, lines: r.lines, matched: r.matched });
      return reply.status(201).send(r);
    } catch (e) { return bankFailed(reply, e); }
  });

  app.get('/v1/finance/bank-lines', async (req) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    const statementId = /^\d{1,18}$/.test(q.statement ?? '') ? q.statement : undefined;
    return { lines: await bank.lines(req.principal.orgId, platform(req), { statementId, open: q.open === 'true' }) };
  });

  app.get('/v1/finance/bank-lines/:lid/candidates', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return { candidates: await bank.lineCandidates(req.principal.orgId, platform(req), String((req.params as Record<string, string>).lid ?? '')) }; } catch (e) { return bankFailed(reply, e); }
  });

  app.post('/v1/finance/bank-lines/:lid/match', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const lid = String((req.params as Record<string, string>).lid ?? '');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await bank.setMatch(req.principal.orgId, platform(req), lid, b, userUuid(req));
      await auditPay(req, 'finance.bank_line_matched', 'bank_statement_line', lid, { kind: b.kind, ref: b.ref ?? null, note: b.note ?? null });
      return r;
    } catch (e) { return bankFailed(reply, e); }
  });

  // ─────────────────────────────────────────── (v1.18.0) PPh 23 withholding, platform e-Faktur

  const taxFailed = (reply: FastifyReply, e: unknown) => {
    if (e instanceof wht.WithholdingError) return reply.status(e.statusCode).send({ error: e.message });
    throw e;
  };
  const whtId = (req: FastifyRequest) => String((req.params as Record<string, string>).wid ?? '');

  app.get('/v1/finance/tax/pph23', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    try {
      const y = await wht.pph23(req.principal.orgId, platform(req), Number(q.year ?? new Date().getFullYear()));
      if (q.format === 'csv') {
        return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="pph23-${y.year}.csv"`).send(wht.pph23Csv(y));
      }
      return y;
    } catch (e) { return taxFailed(reply, e); }
  });

  app.post('/v1/finance/tax/withholdings', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await wht.record(req.principal.orgId, b, userUuid(req));
      await auditPay(req, 'finance.tax_withholding_recorded', 'tax_withholding', r.id, { kind: b.kind, period: b.period, base: b.base, amount: r.amount, bukti: b.buktiNumber ?? null });
      return reply.status(201).send(r);
    } catch (e) { return taxFailed(reply, e); }
  });

  app.post('/v1/finance/tax/withholdings/:wid/bukti', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await wht.setBukti(req.principal.orgId, whtId(req), b);
      await auditPay(req, 'finance.tax_withholding_bukti', 'tax_withholding', whtId(req), { bukti: b.buktiNumber, date: b.buktiDate });
      return r;
    } catch (e) { return taxFailed(reply, e); }
  });

  app.post('/v1/finance/tax/withholdings/:wid/void', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await wht.voidRecord(req.principal.orgId, whtId(req), b.reason, userUuid(req));
      await auditPay(req, 'finance.tax_withholding_voided', 'tax_withholding', whtId(req), { reason: String(b.reason ?? '').slice(0, 300) });
      return r;
    } catch (e) { return taxFailed(reply, e); }
  });

  app.get('/v1/finance/tax/platform-efaktur', async (req, reply) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    const q = (req.query ?? {}) as Record<string, string>;
    try {
      const r = await wht.platformEfaktur(String(q.period ?? ''), { itemOpt: q.itemOpt as 'A' | 'B', itemCode: q.itemCode, unitCode: q.unitCode });
      await auditPay(req, 'finance.platform_efaktur_exported', 'commission_statement', q.period ?? '', { included: r.included.length, skipped: r.skipped.length });
      return reply.header('content-type', 'application/xml; charset=utf-8').header('content-disposition', `attachment; filename="efaktur-platform-${q.period}.xml"`)
        .header('x-efaktur-skipped', String(r.skipped.length)).send(r.xml);
    } catch (e) { return taxFailed(reply, e); }
  });

  // (v1.19.0) Site owners' requests (from the owner portal) to change their bank details: approve or reject.
  app.get('/v1/finance/owner-bank-requests', async (req) => {
    assertCan(req.principal, { permission: 'payment:read' });
    return { requests: await ownerPortal.pendingRequests(req.principal.orgId) };
  });

  app.post('/v1/finance/owner-bank-requests/:rid/:decision', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    const { rid, decision } = req.params as Record<string, string>;
    if (decision !== 'approve' && decision !== 'reject') return reply.status(404).send({ error: 'Not found' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await ownerPortal.decide(req.principal.orgId, String(rid ?? ''), decision === 'approve', b.note, userUuid(req), can(req.principal, { permission: 'finance:approve' }));
      await auditPay(req, r.firstApproval ? 'finance.owner_bank_change_first_approval' : decision === 'approve' ? 'finance.owner_bank_change_approved' : 'finance.owner_bank_change_rejected', 'owner_bank_change_request', String(rid), { ownerId: r.ownerId, note: b.note ?? null });
      return r;
    } catch (e) {
      if (e instanceof ownerPortal.OwnerPortalError) return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // ─────────────────────────────────────────── (v1.20.0) energy and margin, budgets, collections, audit pack

  const p9Failed = (reply: FastifyReply, e: unknown) => {
    if (e instanceof energy.EnergyError || e instanceof budgets.BudgetError || e instanceof collections.CollectionsError) return reply.status(e.statusCode).send({ error: e.message });
    throw e;
  };
  const prm = (req: FastifyRequest, k: string) => String((req.params as Record<string, string>)[k] ?? '');

  app.get('/v1/finance/energy', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    try { return await energy.month(req.principal.orgId, q.month, q.site || undefined); } catch (e) { return p9Failed(reply, e); }
  });
  app.get('/v1/finance/energy/trend', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    try { return await energy.trend(req.principal.orgId, q.months, q.site || undefined); } catch (e) { return p9Failed(reply, e); }
  });
  app.put('/v1/finance/sites/:sid/energy-rate', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await energy.setRate(req.principal.orgId, prm(req, 'sid'), ((req.body ?? {}) as Record<string, unknown>).ratePerKwh, userUuid(req));
      await auditPay(req, 'finance.energy_rate_saved', 'site', r.siteId, { ratePerKwh: r.ratePerKwh, currency: r.currency });
      return r;
    } catch (e) { return p9Failed(reply, e); }
  });
  app.post('/v1/finance/sites/:sid/energy-bills', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await energy.recordBill(req.principal.orgId, prm(req, 'sid'), b, userUuid(req));
      await auditPay(req, 'finance.energy_bill_recorded', 'site_energy_cost', r.id, { site: prm(req, 'sid'), month: b.month, amount: b.amount, kwhBilled: b.kwhBilled ?? null });
      return reply.status(201).send(r);
    } catch (e) { return p9Failed(reply, e); }
  });
  app.post('/v1/finance/energy-bills/:bid/void', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await energy.voidBill(req.principal.orgId, prm(req, 'bid'), b.reason, userUuid(req));
      await auditPay(req, 'finance.energy_bill_voided', 'site_energy_cost', prm(req, 'bid'), { reason: String(b.reason ?? '').slice(0, 300) });
      return r;
    } catch (e) { return p9Failed(reply, e); }
  });

  app.get('/v1/finance/budgets', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await budgets.compare(req.principal.orgId, ((req.query ?? {}) as Record<string, string>).month); } catch (e) { return p9Failed(reply, e); }
  });
  app.put('/v1/finance/budgets', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await budgets.save(req.principal.orgId, (req.body ?? {}) as Record<string, unknown>, userUuid(req));
      await auditPay(req, 'finance.budget_saved', 'finance_budget', `${r.month}:${r.siteId ?? 'org'}:${r.currency}`, r);
      return r;
    } catch (e) { return p9Failed(reply, e); }
  });
  app.post('/v1/finance/budgets/copy', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await budgets.copyForward(req.principal.orgId, b.from, b.months, userUuid(req));
      await auditPay(req, 'finance.budget_copied', 'finance_budget', String(b.from ?? ''), { months: b.months, copied: r.copied });
      return r;
    } catch (e) { return p9Failed(reply, e); }
  });
  app.put('/v1/finance/budgets/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await budgets.saveAlertPct(req.principal.orgId, ((req.body ?? {}) as Record<string, unknown>).budgetAlertPct, userUuid(req));
      await auditPay(req, 'finance.budget_settings_saved', 'organisation', req.principal.orgId, r);
      return r;
    } catch (e) { return p9Failed(reply, e); }
  });

  app.get('/v1/finance/collections', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return { ...(await collections.list(req.principal.orgId, platform(req))), writeOffsPending: await collections.pendingWriteOffs(req.principal.orgId) }; } catch (e) { return p9Failed(reply, e); }
  });
  app.get('/v1/finance/collections/:kind/:ref', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await collections.history(req.principal.orgId, platform(req), prm(req, 'kind'), prm(req, 'ref')); } catch (e) { return p9Failed(reply, e); }
  });
  app.post('/v1/finance/collections/:kind/:ref/notes', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await collections.addNote(req.principal.orgId, platform(req), prm(req, 'kind'), prm(req, 'ref'), b, userUuid(req));
      await auditPay(req, 'finance.collection_note_added', prm(req, 'kind'), prm(req, 'ref'), { promiseDate: b.promiseDate ?? null });
      return reply.status(201).send(r);
    } catch (e) { return p9Failed(reply, e); }
  });
  app.post('/v1/finance/collections/:kind/:ref/remind', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await collections.remindNow(req.principal.orgId, platform(req), prm(req, 'kind'), prm(req, 'ref'), (req.body ?? {}) as Record<string, unknown>, userUuid(req));
      await auditPay(req, 'finance.collection_reminder_sent', prm(req, 'kind'), prm(req, 'ref'), { destination: r.destination });
      return r;
    } catch (e) { return p9Failed(reply, e); }
  });
  app.post('/v1/finance/collections/:kind/:ref/write-off', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await collections.requestWriteOff(req.principal.orgId, platform(req), prm(req, 'kind'), prm(req, 'ref'), b, userUuid(req));
      await auditPay(req, 'finance.write_off_requested', 'receivable_write_off', r.id, { kind: prm(req, 'kind'), ref: prm(req, 'ref'), amount: r.amount, reason: String(b.reason ?? '').slice(0, 300) });
      return reply.status(201).send(r);
    } catch (e) { return p9Failed(reply, e); }
  });
  app.post('/v1/finance/write-offs/:wid/:decision', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    const decision = prm(req, 'decision');
    if (decision !== 'approve' && decision !== 'reject') return reply.status(404).send({ error: 'Not found' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await collections.decideWriteOff(req.principal.orgId, prm(req, 'wid'), decision === 'approve', b.note, userUuid(req), can(req.principal, { permission: 'finance:approve' }));
      await auditPay(req, r.firstApproval ? 'finance.write_off_first_approval' : decision === 'approve' ? 'finance.write_off_approved' : 'finance.write_off_rejected', 'receivable_write_off', prm(req, 'wid'), { kind: r.kind, ref: r.ref, amount: r.amount, note: b.note ?? null });
      return r;
    } catch (e) { return p9Failed(reply, e); }
  });
  app.put('/v1/finance/collections/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await collections.saveDunning(req.principal.orgId, (req.body ?? {}) as Record<string, unknown>, userUuid(req));
      await auditPay(req, 'finance.dunning_settings_saved', 'organisation', req.principal.orgId, r);
      return r;
    } catch (e) { return p9Failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/audit-pack', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try {
      const a = await account(req);
      const p = period(req);
      const r = await auditPack.build(a, p, req.principal.orgId, platform(req));
      await audit(req, 'finance.audit_pack_exported', a.id, { from: p.from.toISOString(), to: p.to.toISOString(), manifestSha256: r.manifestSha256, files: r.manifest.files.map((f) => `${f.name}:${f.rows}`) });
      return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="plugsure-audit-pack-${p.from.toISOString().slice(0, 10)}.zip"`)
        .header('x-manifest-sha256', r.manifestSha256).send(r.body);
    } catch (e) { return failed(reply, e); }
  });

  // ─────────────────────────────────────────── (v1.21.0) summary, currencies, approvals matrix, report e-mails

  const p10Failed = (reply: FastifyReply, e: unknown) => {
    if (e instanceof fx.FxError || e instanceof approvals.ApprovalError || e instanceof reportSched.ReportError) return reply.status(e.statusCode).send({ error: e.message });
    return p9Failed(reply, e);
  };
  const canApprove = (req: FastifyRequest) => can(req.principal, { permission: 'finance:approve' });

  app.get('/v1/finance/summary', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await finSummary.summary(req.principal.orgId); } catch (e) { return p10Failed(reply, e); }
  });

  app.get('/v1/finance/fx-rates', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await fx.rates(req.principal.orgId, ((req.query ?? {}) as Record<string, string>).month); } catch (e) { return p10Failed(reply, e); }
  });
  app.put('/v1/finance/fx-rates/reporting-currency', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await fx.setReporting(req.principal.orgId, ((req.body ?? {}) as Record<string, unknown>).currency, userUuid(req));
      await auditPay(req, 'finance.reporting_currency_saved', 'organisation', req.principal.orgId, r);
      return r;
    } catch (e) { return p10Failed(reply, e); }
  });
  app.put('/v1/finance/fx-rates', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await fx.setRate(req.principal.orgId, (req.body ?? {}) as Record<string, unknown>, userUuid(req));
      await auditPay(req, 'finance.fx_rate_saved', 'fx_rate', `${r.month}:${r.currency}:${r.reporting}`, r);
      return r;
    } catch (e) { return p10Failed(reply, e); }
  });
  app.post('/v1/finance/fx-rates/fetch', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await fx.fetchEcb(req.principal.orgId, ((req.body ?? {}) as Record<string, unknown>).month, userUuid(req));
      await auditPay(req, 'finance.fx_rates_fetched', 'fx_rate', r.month, { rates: r.rates, failed: r.failed });
      return r;
    } catch (e) { return p10Failed(reply, e); }
  });

  app.get('/v1/finance/approval-rules', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return { rules: await approvals.rules(req.principal.orgId), canApprove: canApprove(req) }; } catch (e) { return p10Failed(reply, e); }
  });
  app.put('/v1/finance/approval-rules', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const rules = await approvals.saveRules(req.principal.orgId, ((req.body ?? {}) as Record<string, unknown>).rules, canApprove(req), userUuid(req));
      await auditPay(req, 'finance.approval_rules_saved', 'organisation', req.principal.orgId, { rules });
      return { rules, canApprove: true };
    } catch (e) { return p10Failed(reply, e); }
  });

  app.get('/v1/finance/report-schedules', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return { schedules: await reportSched.list(req.principal.orgId), reports: reportSched.REPORTS }; } catch (e) { return p10Failed(reply, e); }
  });
  app.post('/v1/finance/report-schedules', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await reportSched.create(req.principal.orgId, (req.body ?? {}) as Record<string, unknown>, userUuid(req));
      await auditPay(req, 'finance.report_schedule_created', 'finance_report_schedule', r.id, { name: r.name, reports: r.reports, frequency: r.frequency, recipients: r.recipients });
      return reply.status(201).send(r);
    } catch (e) { return p10Failed(reply, e); }
  });
  app.put('/v1/finance/report-schedules/:rid', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await reportSched.update(req.principal.orgId, prm(req, 'rid'), (req.body ?? {}) as Record<string, unknown>);
      await auditPay(req, 'finance.report_schedule_saved', 'finance_report_schedule', r.id, { name: r.name, reports: r.reports, frequency: r.frequency, recipients: r.recipients, enabled: r.enabled, archived: (r as any).archived ?? false });
      return r;
    } catch (e) { return p10Failed(reply, e); }
  });
  app.post('/v1/finance/report-schedules/:rid/send', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await reportSched.send(req.principal.orgId, prm(req, 'rid'));
      await auditPay(req, 'finance.report_sent', 'finance_report_schedule', prm(req, 'rid'), { to: r.to });
      return r;
    } catch (e) { return p10Failed(reply, e); }
  });

  // ─────────────────────────────────────────── (v1.22.0) month lock, site investments, revenue drop alerts

  const p11Failed = (reply: FastifyReply, e: unknown) => {
    if (e instanceof periods.PeriodError || e instanceof invest.InvestmentError || e instanceof anomalies.AnomalyError) return reply.status(e.statusCode).send({ error: e.message });
    return p10Failed(reply, e);
  };

  app.get('/v1/finance/periods', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await periods.list(req.principal.orgId); } catch (e) { return p11Failed(reply, e); }
  });
  app.get('/v1/finance/periods/:month/checklist', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await periods.checklist(req.principal.orgId, prm(req, 'month')); } catch (e) { return p11Failed(reply, e); }
  });
  app.post('/v1/finance/periods/:month/lock', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await periods.lock(req.principal.orgId, prm(req, 'month'), b.note, userUuid(req));
      await auditPay(req, 'finance.period_locked', 'finance_period_lock', r.id, { month: r.month, note: b.note ?? null });
      return r;
    } catch (e) { return p11Failed(reply, e); }
  });
  app.post('/v1/finance/periods/:month/reopen', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await periods.reopen(req.principal.orgId, prm(req, 'month'), b.reason, userUuid(req), can(req.principal, { permission: 'finance:approve' }));
      await auditPay(req, 'finance.period_reopened', 'finance_period_lock', r.id, { month: r.month, reason: String(b.reason ?? '').slice(0, 300) });
      return r;
    } catch (e) { return p11Failed(reply, e); }
  });

  app.get('/v1/finance/investments', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    try { return await invest.overview(req.principal.orgId, q.site || undefined); } catch (e) { return p11Failed(reply, e); }
  });
  app.post('/v1/finance/investments', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await invest.record(req.principal.orgId, (req.body ?? {}) as Record<string, unknown>, userUuid(req));
      await auditPay(req, 'finance.investment_recorded', 'site_investment', r.id, { site: r.siteId, category: r.category, amount: r.amount, currency: r.currency, investedOn: r.investedOn, lifeMonths: r.lifeMonths });
      return reply.status(201).send(r);
    } catch (e) { return p11Failed(reply, e); }
  });
  app.post('/v1/finance/investments/:iid/void', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await invest.voidInvestment(req.principal.orgId, prm(req, 'iid'), b.reason, userUuid(req));
      await auditPay(req, 'finance.investment_voided', 'site_investment', prm(req, 'iid'), { reason: String(b.reason ?? '').slice(0, 300) });
      return r;
    } catch (e) { return p11Failed(reply, e); }
  });

  app.get('/v1/finance/revenue-alerts', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await anomalies.list(req.principal.orgId); } catch (e) { return p11Failed(reply, e); }
  });
  app.put('/v1/finance/revenue-alerts/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await anomalies.saveSettings(req.principal.orgId, (req.body ?? {}) as Record<string, unknown>, userUuid(req));
      await auditPay(req, 'finance.revenue_alert_settings_saved', 'organisation', req.principal.orgId, r as unknown as Record<string, unknown>);
      return r;
    } catch (e) { return p11Failed(reply, e); }
  });
  app.post('/v1/finance/revenue-alerts/check', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try { return await anomalies.detect(req.principal.orgId, ((req.body ?? {}) as Record<string, unknown>).day); } catch (e) { return p11Failed(reply, e); }
  });

  // ─────────────────────────────────────────── (v1.23.0) tax calendar, owner queries, shared costs, settlements

  const p12Failed = (reply: FastifyReply, e: unknown) => {
    if (e instanceof taxCal.TaxCalendarError || e instanceof disputes.DisputeError || e instanceof sharedCosts.SharedCostError || e instanceof settle.SettlementError) return reply.status(e.statusCode).send({ error: e.message });
    return p11Failed(reply, e);
  };

  app.get('/v1/finance/tax/calendar', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await taxCal.calendar(req.principal.orgId); } catch (e) { return p12Failed(reply, e); }
  });
  app.put('/v1/finance/tax/calendar/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await taxCal.saveSettings(req.principal.orgId, (req.body ?? {}) as Record<string, unknown>, userUuid(req));
      await auditPay(req, 'finance.tax_calendar_saved', 'organisation', req.principal.orgId, r as unknown as Record<string, unknown>);
      return r;
    } catch (e) { return p12Failed(reply, e); }
  });
  app.post('/v1/finance/tax/filings', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await taxCal.markFiled(req.principal.orgId, (req.body ?? {}) as Record<string, unknown>, userUuid(req));
      await auditPay(req, 'finance.tax_filed', 'tax_filing', r.id, r);
      return reply.status(201).send(r);
    } catch (e) { return p12Failed(reply, e); }
  });
  app.post('/v1/finance/tax/filings/:fid/void', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await taxCal.voidFiling(req.principal.orgId, prm(req, 'fid'), b.reason, userUuid(req));
      await auditPay(req, 'finance.tax_filing_voided', 'tax_filing', prm(req, 'fid'), { reason: String(b.reason ?? '').slice(0, 300) });
      return r;
    } catch (e) { return p12Failed(reply, e); }
  });

  app.get('/v1/finance/owner-queries', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await disputes.list(req.principal.orgId); } catch (e) { return p12Failed(reply, e); }
  });
  app.post('/v1/finance/owner-queries/:qid/answer', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await disputes.answer(req.principal.orgId, prm(req, 'qid'), (req.body ?? {}) as Record<string, unknown>, userUuid(req));
      await auditPay(req, `finance.owner_query_${r.state}`, 'owner_statement_dispute', r.id, { amount: r.amount, currency: r.currency });
      return r;
    } catch (e) { return p12Failed(reply, e); }
  });

  app.get('/v1/finance/shared-costs', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await sharedCosts.list(req.principal.orgId); } catch (e) { return p12Failed(reply, e); }
  });
  app.post('/v1/finance/shared-costs', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await sharedCosts.record(req.principal.orgId, (req.body ?? {}) as Record<string, unknown>, userUuid(req));
      await auditPay(req, 'finance.shared_cost_recorded', 'finance_shared_cost', r.id, { category: r.category, amount: r.amount, currency: r.currency, basis: r.basis, monthFrom: r.monthFrom, monthTo: r.monthTo, sites: r.siteIds });
      return reply.status(201).send(r);
    } catch (e) { return p12Failed(reply, e); }
  });
  app.post('/v1/finance/shared-costs/:cid/end', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await sharedCosts.end(req.principal.orgId, prm(req, 'cid'), ((req.body ?? {}) as Record<string, unknown>).monthTo);
      await auditPay(req, 'finance.shared_cost_ended', 'finance_shared_cost', r.id, { monthTo: r.monthTo });
      return r;
    } catch (e) { return p12Failed(reply, e); }
  });
  app.post('/v1/finance/shared-costs/:cid/void', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await sharedCosts.voidCost(req.principal.orgId, prm(req, 'cid'), b.reason, userUuid(req));
      await auditPay(req, 'finance.shared_cost_voided', 'finance_shared_cost', prm(req, 'cid'), { reason: String(b.reason ?? '').slice(0, 300) });
      return r;
    } catch (e) { return p12Failed(reply, e); }
  });
  app.get('/v1/finance/site-pnl', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await sharedCosts.pnl(req.principal.orgId, ((req.query ?? {}) as Record<string, string>).month); } catch (e) { return p12Failed(reply, e); }
  });

  app.get('/v1/finance/accounts/:id/settlements', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await settle.overview(await account(req), req.principal.orgId); } catch (e) { return failed(reply, e); }
  });
  app.put('/v1/finance/settlement-tracking/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await settle.saveSettings(req.principal.orgId, (req.body ?? {}) as Record<string, unknown>, userUuid(req));
      await auditPay(req, 'finance.settlement_tracking_saved', 'organisation', req.principal.orgId, r as unknown as Record<string, unknown>);
      return r;
    } catch (e) { return p12Failed(reply, e); }
  });

  // ─────────────────────────────────────────── (v1.24.0) driver refund requests, data export, year end

  const p13Failed = (reply: FastifyReply, e: unknown) => {
    if (e instanceof driverRefunds.DriverRefundError || e instanceof warehouse.WarehouseError || e instanceof yearEnd.YearEndError) return reply.status(e.statusCode).send({ error: e.message });
    return p12Failed(reply, e);
  };

  app.get('/v1/finance/driver-refunds', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await driverRefunds.list(req.principal.orgId); } catch (e) { return p13Failed(reply, e); }
  });
  app.post('/v1/finance/driver-refunds/:qid/:decision', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    const decision = prm(req, 'decision');
    if (decision !== 'approve' && decision !== 'reject') return reply.status(404).send({ error: 'Not found' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await driverRefunds.decide(req.principal.orgId, prm(req, 'qid'), decision === 'approve', b, userUuid(req));
      await auditPay(req, `finance.driver_refund_${r.state}`, 'driver_refund_request', r.id, { payment: r.paymentId, amount: r.amount, note: b.note ?? null });
      return r;
    } catch (e) { return p13Failed(reply, e); }
  });
  app.put('/v1/finance/driver-refunds/policy', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await driverRefunds.savePolicy(req.principal.orgId, (req.body ?? {}) as Record<string, unknown>, userUuid(req));
      await auditPay(req, 'finance.driver_refund_policy_saved', 'organisation', req.principal.orgId, r as unknown as Record<string, unknown>);
      return r;
    } catch (e) { return p13Failed(reply, e); }
  });

  app.get('/v1/finance/warehouse', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return { settings: await warehouse.settings(req.principal.orgId), runs: await warehouse.runs(req.principal.orgId), datasets: { daily: warehouse.DAILY, snapshots: warehouse.SNAPSHOTS } }; } catch (e) { return p13Failed(reply, e); }
  });
  app.put('/v1/finance/warehouse/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await warehouse.saveSettings(req.principal.orgId, b, userUuid(req));
      await auditPay(req, 'finance.warehouse_settings_saved', 'organisation', req.principal.orgId, { enabled: r.enabled, target: r.target, format: r.format, endpoint: r.endpoint, bucket: r.bucket, prefix: r.prefix, secretChanged: Boolean(b.secretAccessKey) });
      return r;
    } catch (e) { return p13Failed(reply, e); }
  });
  app.post('/v1/finance/warehouse/run', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await warehouse.run(req.principal.orgId, ((req.body ?? {}) as Record<string, unknown>).day, { userId: userUuid(req) });
      await auditPay(req, 'finance.warehouse_exported', 'finance_export_run', r.id, { day: r.day, target: r.target, files: r.files.length });
      return r;
    } catch (e) { return p13Failed(reply, e); }
  });
  app.get('/v1/finance/warehouse/days/:day', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try {
      const day = prm(req, 'day').replace(/\.zip$/, '');
      const body = await warehouse.zipDay(req.principal.orgId, day);
      await audit(req, 'finance.warehouse_downloaded', req.principal.orgId, { day });
      return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="plugsure-finance-${day}.zip"`).send(body);
    } catch (e) { return p13Failed(reply, e); }
  });

  app.get('/v1/finance/year-end', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try { return await yearEnd.summary(req.principal.orgId, ((req.query ?? {}) as Record<string, string>).year ?? new Date().getFullYear() - 1); } catch (e) { return p13Failed(reply, e); }
  });
  app.post('/v1/finance/year-end/:year/close', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const r = await yearEnd.closeYear(req.principal.orgId, prm(req, 'year'), userUuid(req));
      await auditPay(req, 'finance.year_closed', 'organisation', req.principal.orgId, r as unknown as Record<string, unknown>);
      return r;
    } catch (e) { return p13Failed(reply, e); }
  });
  app.get('/v1/finance/year-end/:year/pack', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:read' });
    try {
      const r = await yearEnd.pack(req.principal.orgId, prm(req, 'year'));
      await audit(req, 'finance.year_end_pack_exported', req.principal.orgId, { year: r.year, manifestSha256: r.manifestSha256 });
      return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="plugsure-year-end-${r.year}.zip"`).header('x-manifest-sha256', r.manifestSha256).send(r.body);
    } catch (e) { return p13Failed(reply, e); }
  });

  app.put('/v1/finance/owners/:oid/bank-account', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    try {
      const oid = uuidParam(req, 'oid', 'site owner');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const a = await pay.saveBankAccount(req.principal.orgId, oid, b, req.principal.userId ?? null);
      await auditPay(req, 'finance.owner_bank_account_saved', 'site_owner', oid, { bank: a.bankName, holder: a.holderName, account: a.accountMasked, numberChanged: Boolean(b.accountNumber) });
      return { account: a };
    } catch (e) { return payFailed(reply, e); }
  });
}
