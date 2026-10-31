import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, field, callout, kpi, toast, download, modal, zonedYmd, zonedDayStartIso } from '../core.js';
import { formatMoney, LEGACY_CURRENCY, CURRENCIES } from '../money.js';

/**
 * Finance — the payment gateway's side of the money (v1.12.0), per gateway account: Xendit, and (v1.13.0) the
 * Duitku fallback account, whose ledger PlugSure builds from its own payments (Duitku has no ledger API).
 *
 *   Overview        collected, fees (with VAT), refunds, net; receivable (not yet settled) and when; the balance at
 *                   the gateway; refunds due; a daily chart; by channel; open reconciliation differences
 *   Payments        the gateway's ledger: every payment, refund and payout with fee, VAT, net and settlement status,
 *                   matched to PlugSure's payment
 *   Receivables     collected, not yet settled, by expected day (overdue flagged); fleet invoices due
 *   Payables        refunds due (with the e-wallet's refund window), site owners' shares on finalised statements
 *   Fees            by month and channel, the effective rate; QRIS fees charged vs PlugSure's estimate
 *   Reconciliation  differences between the gateway and PlugSure: apply a missed payment, or resolve with a note
 *
 * The period and the account apply to every tab; exports (CSV, Excel, PDF) cover the period. Every value from the
 * API is escaped before it reaches markup.
 */

/**
 * The gateway's amounts (rupiah, the gateways' unit): gateway fees and VAT have cents, shown as two decimals (never one).
 * Written the way the console writes rupiah (formatMoney, Indonesian separators).
 */
const rp = (n) => {
  if (n == null) return '—';
  const v = Number(n), whole = Number.isInteger(Math.round(v * 100) / 100);
  return formatMoney(v, LEGACY_CURRENCY, 'id', { decimals: whole ? 0 : 2 });
};
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(2)}%`);
const STATUS_TAG = { success: 't-ok', pending: 't-info', failed: 't-crit', voided: 't-mute', reversed: 't-warn' };
const SETTLE_TAG = { settled: ['t-ok', 'settled'], early_settled: ['t-ok', 'settled early'], pending: ['t-info', 'to settle'] };
const KIND_LABEL = { payment: 'Payment', refund: 'Refund', payout: 'Payout', transfer: 'Transfer', fee: 'Fee', other: 'Other' };
const EXC_TAG = {
  missing_in_plugsure: 't-crit', missing_at_gateway: 't-crit', amount_mismatch: 't-warn', pending_too_long: 't-info', settlement_overdue: 't-warn', refund_mismatch: 't-warn',
};
const SERIES = [['net', 'Net', 'var(--accent)'], ['fees', 'Fees incl. VAT', 'var(--warn)'], ['refunds', 'Refunds', 'var(--crit)']];

/** Today and month starts in the organisation's zone, as YYYY-MM-DD. */
const zoneDay = (d) => zonedYmd(d);
function presets() {
  const today = zoneDay(new Date());
  const [y, m] = today.split('-').map(Number);
  const first = `${today.slice(0, 7)}-01`;
  const prevY = m === 1 ? y - 1 : y, prevM = m === 1 ? 12 : m - 1;
  const prevFirst = `${prevY}-${String(prevM).padStart(2, '0')}-01`;
  const prevLast = zoneDay(new Date(Date.UTC(y, m - 1, 0, 12)));
  return {
    month: { label: 'This month', from: first, to: today },
    last: { label: 'Last month', from: prevFirst, to: prevLast },
    d30: { label: 'Last 30 days', from: zoneDay(new Date(Date.now() - 29 * 864e5)), to: today },
    d90: { label: 'Last 90 days', from: zoneDay(new Date(Date.now() - 89 * 864e5)), to: today },
  };
}

/** Daily stacked bars: net, fees and refunds make up what was collected. Drawn at the card's width. */
function chart(daily, width) {
  const W = Math.max(360, Math.round(width)), H = 210, L = 64, B = 24, T = 8;
  const plotW = W - L - 8, plotH = H - B - T;
  const rows = daily.map((d) => ({ day: d.day, net: Math.max(0, d.collected - d.fees - d.refunds), fees: d.fees, refunds: d.refunds, total: d.collected }));
  const max = Math.max(1, ...rows.map((r) => Math.max(r.total, r.net + r.fees + r.refunds)));
  const step = 10 ** Math.floor(Math.log10(max));
  const top = [1, 2, 5, 10].map((m) => m * step).find((v) => v >= max) ?? max;
  const y = (v) => T + plotH - (v / top) * plotH;
  const slot = plotW / Math.max(1, rows.length), bw = Math.max(3, Math.min(30, slot * 0.62));
  const short = (v) => (v >= 1e9 ? `${(v / 1e9).toFixed(1)} M` : v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)} jt` : v >= 1e3 ? `${Math.round(v / 1e3)} rb` : String(v));
  const grid = [0, top / 2, top].map((v) => `<line x1="${L}" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}" class="wa-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="wa-axis">${esc(short(v))}</text>`).join('');
  // A label every ~44px, counted back from the last day so the last label never collides with another.
  const every = Math.max(1, Math.ceil(44 / slot));
  const bars = rows.map((r, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    let acc = 0;
    const segs = SERIES.map(([k, , color]) => {
      const v = r[k];
      if (!v) return '';
      const y0 = y(acc), y1 = y(acc + v);
      acc += v;
      return `<rect x="${x}" y="${y1}" width="${bw}" height="${Math.max(1, y0 - y1 - 1.5)}" rx="2" style="fill:${color}"/>`;
    }).join('');
    const tip = `${r.day}: collected ${rp(r.total)} — net ${rp(r.net)}, fees ${rp(r.fees)}, refunds ${rp(r.refunds)}`;
    const label = (rows.length - 1 - i) % every === 0
      ? `<text x="${i === rows.length - 1 ? W - 8 : L + i * slot + slot / 2}" y="${H - 7}" text-anchor="${i === rows.length - 1 ? 'end' : 'middle'}" class="wa-axis">${esc(new Date(`${r.day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }))}</text>` : '';
    return `<g class="wa-col"><title>${esc(tip)}</title><rect x="${L + i * slot}" y="${T}" width="${slot}" height="${plotH}" class="wa-hit"/>${segs}</g>${label}`;
  }).join('');
  return `<svg class="wa-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`Collected per day over ${rows.length} days, split into net, fees and refunds`)}">${grid}${bars}</svg>
    <div class="legend">${SERIES.map(([, label, color]) => `<span style="--c:${color}">${esc(label)}</span>`).join('')}</div>`;
}

const settleTag = (s) => (s ? tag(...(SETTLE_TAG[s] ?? ['t-mute', s])) : '<span class="cell-sub">—</span>');

function txColumns() {
  return [
    { label: 'When', render: (t) => `<span class="nowrap">${esc(fmt.time(t.at))}</span>` },
    { label: 'Type', render: (t) => `${esc(KIND_LABEL[t.kind] ?? t.kind)}<div class="cell-sub">${esc(t.channel ?? '')}</div>` },
    { label: 'Reference', render: (t) => `<span class="mono small">${esc(t.reference ?? t.gatewayId)}</span>${t.matched ? `<div class="cell-sub">${esc(t.matched === 'pass' ? 'membership pass' : t.matched === 'refund' ? 'PlugSure refund' : `PlugSure payment · ${t.paymentState ?? ''}`)}${t.operator ? ` · ${esc(t.operator)}` : ''}</div>` : '<div class="cell-sub">not matched</div>'}` },
    { label: 'Amount', num: true, render: (t) => `<b>${esc(rp(t.amount))}</b>` },
    { label: 'Fee + VAT', num: true, render: (t) => (t.fee || t.vat ? `${esc(rp(t.fee + t.vat))}<div class="cell-sub">VAT ${esc(rp(t.vat))}</div>` : '—') },
    { label: 'Net', num: true, render: (t) => esc(rp(t.net)) },
    { label: 'Status', render: (t) => `${tag(STATUS_TAG[t.status] ?? 't-mute', t.status)}` },
    { label: 'Settlement', render: (t) => `${settleTag(t.settlement)}${t.settlement === 'pending' && t.expectedSettlementAt ? `<div class="cell-sub">${new Date(t.expectedSettlementAt) < new Date() ? '<span style="color:var(--crit)">overdue</span> · ' : ''}${esc(fmt.date(t.expectedSettlementAt))}</div>` : ''}` },
  ];
}

// ─────────────────────────────────────────── (v1.14.0) payouts and statement payments, recorded

const PAY_TAG = { due: ['t-warn', 'due'], partial: ['t-info', 'part-paid'], paid: ['t-ok', 'paid'] };
const payTag = (s) => tag(...(PAY_TAG[s] ?? ['t-mute', s]));
/** Minor units ↔ the amount a person types (rupiah: the same; ringgit / dollars: two decimals). */
const toMajor = (minor, cur) => Number(minor) / 10 ** (CURRENCIES[cur]?.exponent ?? 0);
const toMinor = (major, cur) => Math.round(Number(major) * 10 ** (CURRENCIES[cur]?.exponent ?? 0));

/**
 * Record a transfer against a statement (an owner's share, or an operator's statement to PlugSure), with the payments
 * already recorded and a way to void a mistaken one. PlugSure moves no money: this records what the bank did.
 */
async function paymentDialog(row, { title, canWrite, onDone }) {
  let detail;
  try { detail = await api(`/v1/finance/statements/${encodeURIComponent(row.statementId)}/payments`); } catch (e) { toast(e.message, 'crit'); return; }
  const st = detail.statement;
  const exp = CURRENCIES[st.currency]?.exponent ?? 0;
  const history = detail.payments.length
    ? `<div class="section"><div class="lbl small" style="font-weight:600">Recorded</div><ul style="margin:6px 0 0;padding-left:18px;display:grid;gap:6px">${detail.payments.map((p) => `<li${p.voided ? ' style="opacity:.6"' : ''}>${p.voided ? '<s>' : ''}<b>${esc(fmt.money(p.amount, p.currency))}</b> on ${esc(fmt.date(`${p.paidOn}T12:00:00Z`))} · <span class="mono">${esc(p.reference)}</span>${p.voided ? '</s>' : ''}
        ${p.note ? `<div class="cell-sub">${esc(p.note)}</div>` : ''}<div class="cell-sub">${esc(p.recordedBy ?? '')}${p.voided ? ` · voided: ${esc(p.voidReason ?? '')}` : ''}</div>
        ${canWrite && !p.voided ? `<button class="btn sm" type="button" data-void="${esc(p.id)}">Void…</button>` : ''}</li>`).join('')}</ul></div>` : '';
  modal({
    title,
    subtitle: `${st.number} · due ${fmt.money(st.due, st.currency)} · paid ${fmt.money(st.paid, st.currency)} · outstanding ${fmt.money(st.outstanding, st.currency)}`,
    body: `${callout('info', 'Record a transfer your bank has made. PlugSure does not move the money.')}
      ${canWrite && st.outstanding > 0 ? `<div class="form" style="margin-top:12px">
        ${field(`Amount (${st.currency})`, `<input name="amount" type="number" min="0" step="${exp ? (1 / 10 ** exp).toFixed(exp) : '1'}" value="${esc(String(toMajor(st.outstanding, st.currency)))}">`)}
        ${field('Paid on', `<input name="paidOn" type="date" value="${esc(zonedYmd(new Date()))}">`)}
        ${field('Bank reference', '<input name="reference" maxlength="120" autocomplete="off" placeholder="e.g. BCA 20261105-7781">', { full: true })}
        ${field('Note', '<input name="note" maxlength="500" autocomplete="off">', { full: true, opt: true })}
      </div>` : st.outstanding <= 0 ? callout('ok', 'Paid in full.') : ''}
      ${history}`,
    actions: canWrite && st.outstanding > 0 ? [
      { label: 'Cancel' },
      {
        label: 'Record payment', kind: 'primary',
        onClick: async (ctx) => {
          const v = (n) => $(`[name="${n}"]`, ctx.el).value.trim();
          try {
            await api(`/v1/finance/statements/${encodeURIComponent(row.statementId)}/payments`, { method: 'POST', body: { amount: toMinor(v('amount'), st.currency), paidOn: v('paidOn'), reference: v('reference'), note: v('note') || undefined } });
          } catch (e) { toast(e.message, 'crit'); return false; }
          toast('Payment recorded.');
          await onDone();
          return true;
        },
      },
    ] : [{ label: 'Close' }],
    onMount: (ctx) => {
      $$('[data-void]', ctx.el).forEach((b) => b.addEventListener('click', async () => {
        const reason = window.prompt('Why is this payment voided? (e.g. recorded against the wrong month)');
        if (!reason || !reason.trim()) return;
        try { await api(`/v1/finance/statement-payments/${encodeURIComponent(b.dataset.void)}/void`, { method: 'POST', body: { reason: reason.trim() } }); } catch (e) { toast(e.message, 'crit'); return; }
        toast('Voided.');
        ctx.close();
        await onDone();
      }));
    },
  });
}

/** An owner's bank details: shown masked, set or changed (the account number is kept sealed on the server). */
async function bankDialog(row, { canWrite, onDone }) {
  let cur = null;
  try { cur = (await api(`/v1/finance/owners/${encodeURIComponent(row.ownerId)}/bank-account`)).account; } catch (e) { if (e.status !== 404) { toast(e.message, 'crit'); return; } }
  modal({
    title: `Bank details · ${row.owner}`,
    subtitle: cur ? `${cur.bankName} · ${cur.accountMasked} · ${cur.holderName}` : 'Not set yet',
    body: canWrite ? `<div class="form">
        ${field('Bank', `<input name="bankName" maxlength="80" placeholder="BCA, Mandiri, BRI…" value="${esc(cur?.bankName ?? '')}">`)}
        ${field('Bank code', `<input name="bankCode" maxlength="12" placeholder="014" value="${esc(cur?.bankCode ?? '')}">`, { opt: true })}
        ${field('Account holder', `<input name="holderName" maxlength="120" value="${esc(cur?.holderName ?? '')}">`, { full: true, help: 'As the bank has it.' })}
        ${field('Account number', `<input name="accountNumber" inputmode="numeric" autocomplete="off" placeholder="${esc(cur ? `${cur.accountMasked} — leave empty to keep` : '')}">`, { full: true })}
      </div>` : (cur ? '' : callout('info', 'No bank details saved.')),
    actions: canWrite ? [
      { label: 'Cancel' },
      {
        label: 'Save', kind: 'primary',
        onClick: async (ctx) => {
          const v = (n) => $(`[name="${n}"]`, ctx.el).value.trim();
          try {
            await api(`/v1/finance/owners/${encodeURIComponent(row.ownerId)}/bank-account`, { method: 'PUT', body: { bankName: v('bankName'), bankCode: v('bankCode') || undefined, holderName: v('holderName'), ...(v('accountNumber') ? { accountNumber: v('accountNumber') } : {}) } });
          } catch (e) { toast(e.message, 'crit'); return false; }
          toast('Bank details saved.');
          await onDone();
          return true;
        },
      },
    ] : [{ label: 'Close' }],
  });
}

/** Site owners' shares: due, part-paid, paid; record a payout; bank details; the transfer list for the bank. */
async function ownerSharesSection(el, canWrite) {
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let r;
  try { r = await api('/v1/finance/owner-shares'); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return null; }
  const open = r.shares.filter((x) => x.status !== 'paid');
  const total = (rows) => {
    const by = {};
    for (const x of rows) by[x.currency] = (by[x.currency] ?? 0) + x.outstanding;
    return Object.entries(by).map(([c, v]) => fmt.money(v, c)).join(' + ') || fmt.money(0, LEGACY_CURRENCY);
  };
  el.innerHTML = `<div class="card"><header><h3>Site owners' shares</h3>
      <span class="cell-sub">${esc(open.length ? `${total(open)} outstanding on ${open.length} statement${open.length === 1 ? '' : 's'}` : 'nothing outstanding')}</span>
      ${canWrite && open.length ? `<button class="btn sm right" type="button" data-transfers>${icon('download')} Transfer list (CSV)</button>` : ''}</header><div data-list></div></div>
    <p class="cell-sub">Pay owners from your bank, then record each transfer here. The transfer list has what is outstanding with each owner's bank details, for your bank's bulk transfer.</p>`;
  const reload = () => ownerSharesSection(el, canWrite);
  table($('[data-list]', el), {
    columns: [
      { label: 'Period', render: (x) => `${esc(x.period)}<div class="cell-sub mono">${esc(x.number)}</div>` },
      { label: 'Owner', render: (x) => `${esc(x.owner)}<div class="cell-sub">${x.bank ? esc(`${x.bank.bankName} · ${x.bank.accountMasked}`) : '<span style="color:var(--warn)">no bank details</span>'}</div>` },
      { label: 'Share', num: true, render: (x) => `<b>${esc(fmt.money(x.due, x.currency))}</b>` },
      { label: 'Paid', num: true, render: (x) => `${esc(fmt.money(x.paid, x.currency))}${x.lastPaidOn ? `<div class="cell-sub">${esc(fmt.date(`${x.lastPaidOn}T12:00:00Z`))}</div>` : ''}` },
      { label: 'Status', render: (x) => payTag(x.status) },
      { label: '', render: (x) => `<div class="row nowrap" style="gap:6px"><button class="btn sm${canWrite && x.status !== 'paid' ? ' primary' : ''}" type="button" data-pay="${esc(x.statementId)}">${canWrite && x.status !== 'paid' ? 'Record payment' : 'Payments'}</button><button class="btn sm" type="button" data-bank="${esc(x.statementId)}">Bank</button></div>` },
    ],
    rows: r.shares, empty: 'No owners\' shares on finalised statements yet (Billing → finalise an owner\'s statement).',
  });
  const byId = (id) => r.shares.find((x) => x.statementId === id);
  $$('[data-pay]', el).forEach((b) => b.addEventListener('click', () => { const x = byId(b.dataset.pay); paymentDialog(x, { title: `Payout to ${x.owner}`, canWrite, onDone: reload }); }));
  $$('[data-bank]', el).forEach((b) => b.addEventListener('click', () => bankDialog(byId(b.dataset.bank), { canWrite, onDone: reload })));
  $('[data-transfers]', el)?.addEventListener('click', async () => {
    try { const res = await api('/v1/finance/owner-shares/transfer-list.csv', { raw: true }); download('plugsure-owner-transfers.csv', await res.blob()); } catch (e) { toast(e.message, 'crit'); }
  });
  return { text: total(open), count: open.length };
}

/** Platform administrators: operators' statements to PlugSure and what each paid. */
async function operatorStatementsSection(el, canWrite) {
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let r;
  try { r = await api('/v1/finance/operator-statements'); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = () => operatorStatementsSection(el, canWrite);
  el.innerHTML = `<div class="card"><header><h3>Operators' statements to PlugSure</h3><span class="cell-sub">${esc(`${r.statements.filter((x) => x.status !== 'paid').length} not fully paid`)}</span></header><div data-list></div></div>`;
  table($('[data-list]', el), {
    columns: [
      { label: 'Period', render: (x) => `${esc(x.period)}<div class="cell-sub mono">${esc(x.number)}</div>` },
      { label: 'Operator', render: (x) => esc(x.operator) },
      { label: 'Due', num: true, render: (x) => `<b>${esc(fmt.money(x.due, x.currency))}</b>` },
      { label: 'Paid', num: true, render: (x) => `${esc(fmt.money(x.paid, x.currency))}${x.lastPaidOn ? `<div class="cell-sub">${esc(fmt.date(`${x.lastPaidOn}T12:00:00Z`))}</div>` : ''}` },
      { label: 'Status', render: (x) => payTag(x.status) },
      { label: '', render: (x) => `<button class="btn sm${canWrite && x.status !== 'paid' ? ' primary' : ''}" type="button" data-pay="${esc(x.statementId)}">${canWrite && x.status !== 'paid' ? 'Record payment' : 'Payments'}</button>` },
    ],
    rows: r.statements, empty: 'No finalised operator statements yet.',
  });
  $$('[data-pay]', el).forEach((b) => b.addEventListener('click', () => {
    const x = r.statements.find((s) => s.statementId === b.dataset.pay);
    paymentDialog(x, { title: `Payment from ${x.operator}`, canWrite, onDone: reload });
  }));
}

registerView('finance', {
  title: 'Finance',
  subtitle: 'Payments, receivables, payables, fees',
  icon: 'chart',
  group: 'commercial',
  // Right after Sessions & Revenue (21) and Tariffs (22), before Refunds (24).
  order: 23,
  perm: 'payment:read',
  async render(root, [initialTab]) {
    const canWrite = state.can('payment:write');
    const tabs = [
      { id: 'overview', label: 'Overview' }, { id: 'payments', label: 'Payments' }, { id: 'receivables', label: 'Receivables' },
      { id: 'payables', label: 'Payables' }, { id: 'fees', label: 'Fees' }, { id: 'reconciliation', label: 'Reconciliation' },
    ];
    root.innerHTML = pageHead('Finance',
      'What the payment gateway collected, charged, refunded and settled to the bank, matched to PlugSure\'s payments. Synced from the gateway every 15 minutes; reconciled every 6 hours.',
      '') + '<div data-body><div class="empty-state"><span class="spinner"></span></div></div>';
    const bodyAll = $('[data-body]', root);
    let accounts;
    try { accounts = (await api('/v1/finance/accounts')).accounts; } catch (e) { bodyAll.innerHTML = callout('crit', esc(e.message)); return; }
    if (!accounts.length) {
      bodyAll.innerHTML = `<div class="card pad"><div class="empty-state" style="padding:20px 10px"><h3>No payments account to show</h3>
        <p>Finance reads the ledger of a Xendit (or Duitku fallback) payments account: ${state.can('platform:admin') ? 'connect PlugSure\'s under <b>Integrations → Payments</b>.' : 'connect your own under <b>Integrations → Payments → Your account</b>. Payments taken through PlugSure\'s account are in PlugSure\'s finance.'}</p></div>
        <div class="row" style="justify-content:center"><a class="btn primary" href="#/integrations">${icon('link')} Open Integrations</a></div></div>
        <div class="section" data-owner-shares></div>`;
      // Owners are paid whatever acquirer took the money: the payouts are here without a gateway account too.
      await ownerSharesSection($('[data-owner-shares]', bodyAll), canWrite);
      return;
    }
    const pre = presets();
    const gw = () => (accounts.find((a) => a.id === acct)?.provider === 'duitku' ? 'Duitku' : 'Xendit');
    const isDuitku = () => gw() === 'Duitku';
    let acct = accounts[0].id, from = pre.month.from, to = pre.month.to, current = tabs.find((t) => t.id === initialTab)?.id ?? 'overview';
    bodyAll.innerHTML = `
      <div class="filters" style="margin-top:0">
        ${field('Account', `<select data-acct>${accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('')}</select>`)}
        ${field('Period', `<select data-preset>${Object.entries(pre).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}<option value="custom">Custom…</option></select>`)}
        ${field('From', `<input type="date" data-from value="${from}">`)}
        ${field('To', `<input type="date" data-to value="${to}">`)}
        <div class="row" style="gap:6px;align-self:flex-end">
          ${canWrite ? `<button class="btn" type="button" data-sync>${icon('refresh')} Sync now</button>` : ''}
          <button class="btn" type="button" data-export="xlsx">${icon('download')} Excel</button>
          <button class="btn" type="button" data-export="csv">CSV</button>
          <button class="btn" type="button" data-export="pdf">PDF</button>
        </div>
      </div>
      <div class="tabs" role="tablist">${tabs.map((t) => `<button role="tab" type="button" aria-selected="false" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}</div>
      <div data-tabbody></div>`;
    const body = $('[data-tabbody]', bodyAll);
    const base = () => `/v1/finance/accounts/${encodeURIComponent(acct)}`;
    const per = () => `from=${from}&to=${to}`;
    const load = (html = '<div class="empty-state"><span class="spinner"></span></div>') => { body.innerHTML = html; };

    const drawOverview = async () => {
      load();
      const o = await api(`${base()}/overview?${per()}`);
      const s = o.sync;
      body.innerHTML = `<div class="fin-notes">
        ${!s ? callout('info', `Not synced yet: the first sync reads the last 35 days from ${gw()} within 15 minutes, or now with <b>Sync now</b>.`)
          : s.ok === false ? callout('crit', `<b>The last sync failed</b> (${esc(fmt.ago(s.lastRunAt))}): ${esc(s.error ?? '')}`) : ''}
        ${o.exceptionsOpen ? callout('warn', `<b>${esc(String(o.exceptionsOpen))} difference${o.exceptionsOpen === 1 ? '' : 's'}</b> between ${gw()} and PlugSure to check. <button class="btn sm" type="button" data-go="reconciliation">Open Reconciliation</button>`) : ''}</div>
        <div class="grid k4">
          ${kpi('Collected', esc(rp(o.collected)), esc(`${fmt.num(o.payments)} payments`))}
          ${kpi('Fees incl. VAT', esc(rp(o.fees + o.vat)), esc(o.feeRate == null ? 'no payments' : `${pct(o.feeRate)} of collected`))}
          ${kpi('Refunds', esc(rp(o.refunds)), esc(`${fmt.num(o.refundCount)} refunds`))}
          ${kpi('Net', esc(rp(o.net)), 'collected − fees − VAT − refunds')}
        </div>
        <div class="grid k4 section">
          ${kpi('Receivable', esc(rp(o.receivable.amount)), esc(o.receivable.overdue ? `${rp(o.receivable.overdue)} overdue` : `${fmt.num(o.receivable.count)} payments not yet settled`), o.receivable.overdue ? 'warn' : '')}
          ${kpi('Settled in period', esc(rp(o.settled)), 'net, paid out to the bank')}
          ${kpi(`Balance at ${gw()}`, esc(o.balance ? rp(o.balance.amount) : '—'), esc(o.balance ? `${isDuitku() ? 'available (Disbursement)' : 'cash account'} · ${fmt.ago(o.balance.at)}` : isDuitku() ? 'needs the Disbursement credentials' : 'not read yet'))}
          ${kpi('Refunds due', esc(rp(o.payable.refundsDue)), esc(`${fmt.num(o.payable.refundsDueCount)} to pay back`), o.payable.refundsDueCount ? 'warn' : '')}
        </div>
        <div class="card section"><header><h3>Collected per day</h3><span class="cell-sub right">days in the platform time zone · ${esc(s?.lastRunAt ? `synced ${fmt.ago(s.lastRunAt)}` : 'not synced')}</span></header>
          <div class="body" data-chart>${o.daily.length ? '' : '<div class="empty-state">Nothing in this period.</div>'}</div></div>
        <div class="grid two section">
          <div class="card"><header><h3>By channel</h3></header><div data-channels></div></div>
          <div class="card"><header><h3>Next settlements</h3></header><div data-settle></div></div>
        </div>`;
      if (o.daily.length) $('[data-chart]', body).innerHTML = chart(o.daily, $('[data-chart]', body).clientWidth - 32);
      table($('[data-channels]', body), {
        columns: [
          { label: 'Channel', render: (c) => esc(c.channel) },
          { label: 'Payments', num: true, render: (c) => esc(fmt.num(c.count)) },
          { label: 'Amount', num: true, render: (c) => esc(rp(c.amount)) },
          { label: 'Fees incl. VAT', num: true, render: (c) => `${esc(rp(c.fees))}<div class="cell-sub">${esc(pct(c.amount ? c.fees / c.amount : null))}</div>` },
        ],
        rows: o.byChannel, empty: 'No payments in this period.',
      });
      table($('[data-settle]', body), {
        columns: [
          { label: 'Expected', render: (d) => `${esc(fmt.date(`${d.day}T12:00:00Z`))}${new Date(zonedDayStartIso(d.day)).getTime() + 864e5 < Date.now() ? ` ${tag('t-crit', 'overdue')}` : ''}` },
          { label: 'Payments', num: true, render: (d) => esc(fmt.num(d.count)) },
          { label: 'Net', num: true, render: (d) => `<b>${esc(rp(d.amount))}</b>` },
        ],
        rows: o.receivable.byDay, empty: 'Nothing waiting to settle.',
      });
      $('[data-go]', body)?.addEventListener('click', () => show('reconciliation'));
    };

    const drawPayments = async () => {
      body.innerHTML = `<div class="filters section" style="margin-top:0">
          ${field('Type', `<select data-f="kind"><option value="">All</option>${Object.entries(KIND_LABEL).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>`)}
          ${field('Status', `<select data-f="status"><option value="">All</option>${Object.keys(STATUS_TAG).map((v) => `<option>${v}</option>`).join('')}</select>`)}
          ${field('Settlement', '<select data-f="settlement"><option value="">All</option><option value="pending">To settle</option><option value="settled">Settled</option><option value="early_settled">Settled early</option><option value="none">Not applicable</option></select>')}
          ${field('Matched', '<select data-f="matched"><option value="">All</option><option value="true">Matched to PlugSure</option><option value="false">Not matched</option></select>')}
          ${field('Search', '<input data-f="q" placeholder="Reference or id" autocomplete="off">')}
        </div>
        <div class="card" data-list></div><div class="row" style="justify-content:center;margin-top:10px" data-more></div>
        <p class="cell-sub">${isDuitku() ? 'Built from PlugSure\'s Duitku payments with the amount and fee Duitku reports for each; the settlement date is estimated from Duitku\'s schedule (QRIS and e-wallets 2 working days, cards 4).' : 'From Xendit\'s ledger: amounts, fees and VAT as Xendit charged them.'} Net = amount − fee − VAT (money in).</p>`;
      let rows = [];
      const draw = async (more = false) => {
        const q = new URLSearchParams({ from, to, limit: '200' });
        $$('[data-f]', body).forEach((el) => { if (el.value.trim()) q.set(el.dataset.f, el.value.trim()); });
        if (more && rows.length) q.set('before', rows[rows.length - 1].id);
        let r;
        try { r = await api(`${base()}/transactions?${q}`); } catch (e) { toast(e.message, 'crit'); return; }
        rows = more ? rows.concat(r.transactions) : r.transactions;
        table($('[data-list]', body), { columns: txColumns(), rows, empty: 'No transactions match.' });
        $('[data-more]', body).innerHTML = r.nextBefore ? '<button class="btn sm" type="button" data-load-more>Load older</button>' : '';
        $('[data-load-more]', body)?.addEventListener('click', () => draw(true));
      };
      let t = null;
      $$('[data-f]', body).forEach((el) => el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', () => { clearTimeout(t); t = setTimeout(() => draw(), 250); }));
      await draw();
    };

    const drawReceivables = async () => {
      load();
      const r = await api(`${base()}/receivables`);
      body.innerHTML = `
        <div class="grid k4">${kpi('Not yet settled', esc(rp(r.total)), 'net of fees, all periods')}
          ${kpi('Overdue', esc(rp(r.byDay.filter((d) => d.overdue).reduce((a, d) => a + d.net, 0))), 'past the expected settlement date', r.byDay.some((d) => d.overdue) ? 'warn' : '')}</div>
        <div class="grid two section">
          <div class="card"><header><h3>By expected settlement day</h3></header><div data-days></div></div>
          <div class="card"><header><h3>Fleet invoices due</h3></header><div data-fleet></div></div>
        </div>
        <div class="card section"><header><h3>Payments waiting to settle</h3></header><div data-rows></div></div>
        ${state.can('platform:admin') && !accounts.find((a) => a.id === acct)?.orgId ? '<div class="section" data-op-statements></div>' : ''}`;
      table($('[data-days]', body), {
        columns: [
          { label: 'Expected', render: (d) => `${esc(d.day ? fmt.date(`${d.day}T12:00:00Z`) : 'not given')}${d.overdue ? ` ${tag('t-crit', 'overdue')}` : ''}` },
          { label: 'Payments', num: true, render: (d) => esc(fmt.num(d.count)) },
          { label: 'Gross', num: true, render: (d) => esc(rp(d.gross)) },
          { label: 'Net', num: true, render: (d) => `<b>${esc(rp(d.net))}</b>` },
        ], rows: r.byDay, empty: 'Nothing waiting to settle.',
      });
      table($('[data-fleet]', body), {
        columns: [
          { label: 'Invoice', render: (f) => `<span class="mono">${esc(f.number)}</span><div class="cell-sub">${esc(f.account ?? '')}</div>` },
          { label: 'Due', render: (f) => `${esc(fmt.date(f.dueDate))}${f.overdue ? ` ${tag('t-crit', 'overdue')}` : ''}` },
          { label: 'Total', num: true, render: (f) => esc(fmt.money(f.total, f.currency)) },
        ], rows: r.fleetInvoices, empty: 'No fleet invoices outstanding for this account.',
      });
      table($('[data-rows]', body), { columns: txColumns(), rows: r.rows, empty: 'Nothing waiting to settle.' });
      const ops = $('[data-op-statements]', body);
      if (ops) await operatorStatementsSection(ops, canWrite);
    };

    const drawPayables = async () => {
      load();
      const r = await api(`${base()}/payables`);
      body.innerHTML = `
        <div class="grid k4">${kpi('Refunds due', esc(rp(r.refunds.reduce((a, x) => a + x.amount, 0))), esc(`${r.refunds.length} payments`), r.refunds.length ? 'warn' : '')}
          <div data-kpi-owners>${kpi('Owners\' shares outstanding', '…', 'site owners\' statements')}</div></div>
        <div class="card section"><header><h3>Refunds due</h3><a class="btn sm right" href="#/refunds">Open Refunds</a></header><div data-refunds></div></div>
        <div class="section" data-owner-shares></div>`;
      table($('[data-refunds]', body), {
        columns: [
          { label: 'Paid', render: (x) => `${esc(fmt.time(x.paidAt))}<div class="cell-sub">${esc(x.channel ?? '')} · <span class="mono">${esc(x.reference ?? '')}</span></div>` },
          { label: 'Amount', num: true, render: (x) => `<b>${esc(rp(x.amount))}</b>` },
          { label: 'Status', render: (x) => tag(x.state === 'failed' ? 't-crit' : x.state === 'processing' ? 't-info' : 't-warn', x.state) },
          { label: 'Refund window', render: (x) => (x.daysLeft == null ? '<span class="cell-sub">bank transfer</span>' : x.daysLeft < 0 ? tag('t-crit', 'closed: bank transfer') : `${x.daysLeft <= 7 ? tag('t-warn', `${x.daysLeft} days left`) : esc(`${x.daysLeft} days left`)}<div class="cell-sub">${esc(x.channel)} allows ${esc(String(x.refundWindowDays))} days</div>`) },
          { label: 'Reason', render: (x) => `<span class="cell-sub wrap">${esc(x.reason ?? '')}</span>${x.operator ? `<div class="cell-sub">${esc(x.operator)}</div>` : ''}` },
        ], rows: r.refunds, empty: 'No refunds due.',
      });
      const owed = await ownerSharesSection($('[data-owner-shares]', body), canWrite);
      if (owed) $('[data-kpi-owners]', body).innerHTML = kpi('Owners\' shares outstanding', esc(owed.text), esc(`${owed.count} statement${owed.count === 1 ? '' : 's'} not fully paid`), owed.count ? 'warn' : '');
    };

    const drawFees = async () => {
      load();
      const r = await api(`${base()}/fees?${per()}`);
      const q = r.qris;
      body.innerHTML = `
        <div class="grid k4">${kpi('QRIS fees charged', esc(rp(q.actual)), esc(`${fmt.num(q.payments)} QRIS payments`))}
          ${kpi('PlugSure\'s estimate', esc(rp(q.estimated)), 'the MDR on owner statements')}
          ${kpi('Difference', esc(rp(q.difference)), q.difference > 0 ? `${gw()} charged more than estimated` : q.difference < 0 ? `${gw()} charged less than estimated` : 'as estimated', Math.abs(q.difference) > 0 ? 'warn' : '')}</div>
        <div class="card section"><header><h3>Fees by month and channel</h3></header><div data-rows></div></div>
        <p class="cell-sub">Fees, VAT on fees and withholding tax as ${gw()} reports them on each payment. The estimate is the Bank Indonesia QRIS MDR PlugSure applies on statements (0% up to ${esc(rp(100000))}).</p>`;
      table($('[data-rows]', body), {
        columns: [
          { label: 'Month', render: (x) => esc(x.month) },
          { label: 'Channel', render: (x) => esc(x.channel) },
          { label: 'Payments', num: true, render: (x) => esc(fmt.num(x.count)) },
          { label: 'Amount', num: true, render: (x) => esc(rp(x.amount)) },
          { label: 'Fee', num: true, render: (x) => esc(rp(x.fee)) },
          { label: 'VAT', num: true, render: (x) => esc(rp(x.vat)) },
          { label: 'Total', num: true, render: (x) => `<b>${esc(rp(x.total))}</b>` },
          { label: 'Rate', num: true, render: (x) => esc(pct(x.rate)) },
        ], rows: r.rows, empty: 'No payments in this period.',
      });
    };

    const drawReconciliation = async () => {
      body.innerHTML = `<div class="filters section" style="margin-top:0">${field('Show', '<select data-state><option value="open">Open</option><option value="resolved">Resolved</option><option value="">All</option></select>')}</div>
        <div class="card" data-list></div>
        <p class="cell-sub">Every 6 hours PlugSure compares the last 35 days of ${gw()}'s ledger with its own payments. A difference that is put right (a late notification, a settlement) closes itself.</p>`;
      const draw = async () => {
        const st = $('[data-state]', body).value;
        let r;
        try { r = await api(`${base()}/exceptions${st ? `?state=${st}` : ''}`); } catch (e) { toast(e.message, 'crit'); return; }
        table($('[data-list]', body), {
          columns: [
            { label: 'Difference', render: (x) => `${tag(x.state === 'open' ? EXC_TAG[x.kind] ?? 't-warn' : 't-mute', x.state === 'open' ? x.kind.replace(/_/g, ' ') : 'resolved')}<div class="wrap" style="margin-top:4px">${esc(x.text)}</div>` },
            { label: 'Reference', render: (x) => `<span class="mono small">${esc(x.reference ?? x.gatewayId ?? '—')}</span>${x.channel ? `<div class="cell-sub">${esc(x.channel)}</div>` : ''}${x.detail?.intentState ? `<div class="cell-sub">PlugSure: ${esc(x.detail.intentState)}</div>` : ''}${x.detail?.plugsureAmount != null ? `<div class="cell-sub">PlugSure ${esc(rp(x.detail.plugsureAmount))} · ${gw()} ${esc(rp(x.detail.gatewayAmount))}</div>` : ''}` },
            { label: 'Amount', num: true, render: (x) => esc(rp(x.amount)) },
            { label: 'Seen', render: (x) => `${esc(fmt.ago(x.firstSeenAt))}${x.resolution ? `<div class="cell-sub wrap">${esc(x.resolution)}</div>` : ''}` },
            { label: '', render: (x) => (canWrite && x.state === 'open'
              ? `<div class="row nowrap" style="gap:6px">${x.canApply ? `<button class="btn sm primary" type="button" data-apply="${esc(x.id)}">Apply payment</button>` : ''}<button class="btn sm" type="button" data-resolve="${esc(x.id)}">Resolve…</button></div>` : '') },
          ],
          rows: r.exceptions, empty: st === 'open' ? `No open differences: ${gw()} and PlugSure agree.` : 'Nothing here.',
        });
        $$('[data-apply]', body).forEach((b) => b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            const res = await api(`${base()}/exceptions/${b.dataset.apply}/apply`, { method: 'POST' });
            toast(`Applied: ${res.outcome}`);
            await draw();
          } catch (e) { toast(e.message, 'crit'); b.disabled = false; }
        }));
        $$('[data-resolve]', body).forEach((b) => b.addEventListener('click', () => {
          modal({
            title: 'Resolve this difference',
            body: `<div class="form one">${field('What was done', '<textarea name="note" rows="3" maxlength="500" placeholder="e.g. Refunded by bank transfer, ref 123456"></textarea>', { full: true })}</div>`,
            actions: [
              { label: 'Cancel' },
              {
                label: 'Resolve', kind: 'primary',
                onClick: async (ctx) => {
                  const note = $('textarea', ctx.el).value.trim();
                  if (!note) { toast('Say what was done.', 'warn'); return false; }
                  try { await api(`${base()}/exceptions/${b.dataset.resolve}/resolve`, { method: 'POST', body: { note } }); } catch (e) { toast(e.message, 'crit'); return false; }
                  toast('Resolved.');
                  await draw();
                  return true;
                },
              },
            ],
          });
        }));
      };
      $('[data-state]', body).addEventListener('change', draw);
      await draw();
    };

    const DRAW = { overview: drawOverview, payments: drawPayments, receivables: drawReceivables, payables: drawPayables, fees: drawFees, reconciliation: drawReconciliation };
    const show = async (id) => {
      current = id;
      $$('[data-tab]', bodyAll).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
      history.replaceState(null, '', `#/finance/${id}`);
      try { await DRAW[id](); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); }
    };
    $$('[data-tab]', bodyAll).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    $('[data-acct]', bodyAll).addEventListener('change', (e) => { acct = e.target.value; show(current); });
    $('[data-preset]', bodyAll).addEventListener('change', (e) => {
      const p = pre[e.target.value];
      if (!p) return;
      from = p.from; to = p.to;
      $('[data-from]', bodyAll).value = from; $('[data-to]', bodyAll).value = to;
      show(current);
    });
    for (const k of ['from', 'to']) {
      $(`[data-${k}]`, bodyAll).addEventListener('change', (e) => {
        if (!e.target.value) return;
        if (k === 'from') from = e.target.value; else to = e.target.value;
        $('[data-preset]', bodyAll).value = 'custom';
        show(current);
      });
    }
    $('[data-sync]', bodyAll)?.addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        const r = await api(`${base()}/sync`, { method: 'POST' });
        toast(r.sync.ok ? `Synced ${r.sync.rows} change${r.sync.rows === 1 ? '' : 's'}; ${r.reconciliation.open} difference${r.reconciliation.open === 1 ? '' : 's'} open.` : `Sync failed: ${r.sync.error}`, r.sync.ok ? undefined : 'crit');
        await show(current);
      } catch (err) { toast(err.message, 'crit'); }
      finally { b.disabled = false; }
    });
    $$('[data-export]', bodyAll).forEach((b) => b.addEventListener('click', async () => {
      const f = b.dataset.export;
      b.disabled = true;
      try {
        const res = await api(`${base()}/export?format=${f}&${per()}`, { raw: true });
        download(`plugsure-finance-${from}-${to}.${f}`, await res.blob());
      } catch (e) { toast(e.message, 'crit'); }
      finally { b.disabled = false; }
    }));
    await show(current);
  },
});
