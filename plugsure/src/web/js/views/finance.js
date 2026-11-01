import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, field, callout, kpi, toast, download, modal, drawer, zonedYmd, zonedDayStartIso } from '../core.js';
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
 *   Bank            (v1.18.0) the bank's statement (CSV) matched to gateway payouts, owner payouts and manual refunds
 *   Tax             (v1.18.0) PPh 23 withheld on the gateway's fees and PlugSure's fee; the platform e-Faktur
 *   Forecast        (v1.19.0) the next 30/60/90 days in and out, the running position and the first shortfall
 *   Collections     (v1.20.0) what customers owe by age, notes and promises, reminders, write-offs (two people)
 *   Margin          (v1.20.0) energy cost (bills or cost per kWh) and gross margin per site and charger
 *   Budgets         (v1.20.0) budgets vs actuals per month, organisation and sites
 *   Summary         (v1.21.0) key figures per currency (and consolidated): revenue, margin, DSO, cash, rates, trends
 *   (v1.21.0) Settings: currencies and exchange rates, the approvals matrix, report e-mails
 *   (v1.20.0) Audit pack: the period's records as one ZIP with checksums
 *   (v1.19.0) Fees: the fee audit against the contracted rates; Settings: the rates and the accounting software export;
 *   Payables: owners' bank detail changes to approve
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

/**
 * (v1.16.0) One ledger row's whole trail, in a drawer: the gateway transaction (and its raw record), the other ledger rows
 * of the same payment, PlugSure's payment and its state history, the session and its charge record, refunds and
 * transfers, the pass it paid, and reconciliation exceptions.
 */
function openTrail(base, t) {
  const dl = (rows) => `<dl class="kv">${rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const sect = (title, html) => `<div class="card section"><header><h3>${esc(title)}</h3></header><div class="body">${html}</div></div>`;
  drawer({
    title: `${KIND_LABEL[t.kind] ?? t.kind} · ${rp(t.amount)}`,
    subtitle: `<span class="mono">${esc(t.gatewayId)}</span> · ${esc(fmt.time(t.at))}`,
    tabs: [
      {
        id: 'trail', label: 'Trail',
        async render(body) {
          const r = await api(`${base}/transactions/${encodeURIComponent(t.id)}/trail`);
          const x = r.transaction, p = r.payment, s = r.session;
          let html = sect('At the gateway', dl([
            ['Status', `${tag(STATUS_TAG[x.status] ?? 't-mute', x.status)} ${settleTag(x.settlement)}`],
            ['Channel', esc(x.channel ?? '—')], ['Reference', `<span class="mono">${esc(x.reference ?? '—')}</span>`],
            ['Amount', esc(rp(x.amount))], ['Fee', esc(rp(x.fee))], ['VAT on fee', esc(rp(x.vat))], ['Withholding tax', x.withholdingTax ? esc(rp(x.withholdingTax)) : null],
            ['Net', x.net == null ? '—' : `<b>${esc(rp(x.net))}</b>`],
            ['Expected settlement', x.expectedSettlementAt ? esc(fmt.time(x.expectedSettlementAt)) : null], ['Seen settled', x.settledSeenAt ? esc(fmt.time(x.settledSeenAt)) : null],
          ]));
          if (r.related.length) {
            html += sect('Same payment at the gateway', r.related.map((g) => `<div class="row" style="justify-content:space-between;gap:8px;padding:4px 0">
              <span>${esc(KIND_LABEL[g.kind] ?? g.kind)} · ${tag(STATUS_TAG[g.status] ?? 't-mute', g.status)}<div class="cell-sub mono">${esc(g.gatewayId)} · ${esc(fmt.time(g.at))}</div></span>
              <span class="num">${esc(rp(g.amount))}${g.fee || g.vat ? `<div class="cell-sub">fee ${esc(rp(g.fee + g.vat))}</div>` : ''}</span></div>`).join(''));
          }
          if (p) {
            html += sect('PlugSure payment', dl([
              ['State', tag(p.state === 'captured' ? 't-ok' : p.state === 'voided' || p.state === 'failed' ? 't-crit' : 't-info', p.state)],
              ['Operator', esc(p.operator ?? '—')], ['Method', esc(`${p.method ?? ''}${p.channel ? ` · ${p.channel}` : ''}${p.mode ? ` · ${p.mode}` : ''}`)],
              ['Captured', p.captured != null ? esc(fmt.money(p.captured, p.currency)) : null], ['Authorised', p.authorised != null && p.authorised !== p.captured ? esc(fmt.money(p.authorised, p.currency)) : null],
              ['Provider', `${esc(p.provider)} · <span class="mono">${esc(p.providerRef ?? '')}</span>`], ['Paid', p.paidAt ? esc(fmt.time(p.paidAt)) : null],
              ['Refund', p.refund ? `${tag(p.refund.state === 'refunded' ? 't-ok' : p.refund.state === 'failed' ? 't-crit' : 't-warn', p.refund.state)} ${esc(fmt.money(p.refund.refunded ?? p.refund.due, p.currency))}${p.refund.method ? `<div class="cell-sub">${esc(p.refund.method === 'manual' ? 'bank transfer' : p.refund.method === 'disbursement' ? 'Duitku Disbursement' : 'provider')} · <span class="mono">${esc(p.refund.reference ?? '')}</span></div>` : ''}${p.refund.reason ? `<div class="cell-sub">${esc(p.refund.reason)}</div>` : ''}` : null],
            ]) + (p.events.length ? `<div class="cell-sub" style="margin-top:8px">State history</div>${p.events.map((e) => `<div class="cell-sub">${esc(e.at ? fmt.time(e.at) : '—')} · ${esc(e.status ?? '')}</div>`).join('')}` : ''));
          }
          if (s) {
            html += sect('Charging session', dl([
              ['Where', `${esc(s.site ?? '—')}<div class="cell-sub mono">${esc(s.charger ?? '')}${s.connector ? ` #${esc(String(s.connector))}` : ''}</div>`],
              ['When', `${esc(fmt.time(s.startedAt))}${s.endedAt ? ` – ${esc(fmt.time(s.endedAt))}` : ''}`], ['Energy', s.energyKwh != null ? esc(`${fmt.num(s.energyKwh, 1)} kWh`) : null],
              ['Driver', esc(s.driver ?? 'guest')],
              ['Charge record', s.chargeRecord ? `${esc(fmt.money(s.chargeRecord.total, s.chargeRecord.currency))} · <a href="/v1/sessions/${esc(s.id)}/receipt" target="_blank" rel="noopener">receipt</a>` : null],
            ]) + `<a class="btn sm" href="#/sessions/${esc(s.id)}">Open the session</a>`);
          }
          if (r.transfers.length) {
            html += sect('Refund transfers (Duitku Disbursement)', r.transfers.map((x2) => `<div style="padding:4px 0">${esc(fmt.money(x2.amount, p?.currency ?? LEGACY_CURRENCY))} · <span class="mono">${esc(x2.account)}</span> · ${esc(x2.state)}<div class="cell-sub">${esc(x2.bankName ?? '')} · requested ${esc(fmt.time(x2.requestedAt))}${x2.error ? ` · ${esc(x2.error)}` : ''}</div></div>`).join(''));
          }
          if (r.pass) html += sect('Membership pass', dl([['Charge', `<span class="mono">${esc(r.pass.id)}</span>`], ['State', esc(r.pass.state)], ['Amount', esc(rp(r.pass.amount))]]));
          if (r.exceptions.length) {
            html += sect('Reconciliation', r.exceptions.map((e) => `<div style="padding:4px 0">${tag(e.state === 'open' ? 't-warn' : 't-ok', e.state)} ${esc(e.kind.replace(/_/g, ' '))}<div class="cell-sub">${esc(fmt.time(e.firstSeenAt))}${e.resolution ? ` · ${esc(e.resolution)}` : ''}</div></div>`).join(''));
          }
          if (!p && !r.pass) html += callout('info', 'This transaction is not matched to a PlugSure payment or pass.');
          html += `<details class="section"><summary class="cell-sub">The gateway's record</summary><pre class="mono small" style="white-space:pre-wrap;word-break:break-all">${esc(JSON.stringify(x.raw, null, 2))}</pre></details>`;
          body.innerHTML = html;
        },
      },
    ],
  });
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
/** (v1.15.0) PlugSure Hub settlement positions, for Receivables (from the payer) and Payables (to the payee). */
const hubPositionColumns = (who) => [
  { label: who, render: (h) => esc(h.counterparty ?? '—') },
  { label: 'Due', render: (h) => `${esc(fmt.date(h.dueDate))}${h.status === 'overdue' ? ` ${tag('t-crit', 'overdue')}` : h.status === 'partially_paid' ? ` ${tag('t-info', 'part-paid')}` : ''}` },
  { label: 'Outstanding', num: true, render: (h) => `<b>${esc(fmt.money(h.outstanding, h.currency))}</b>` },
];

/** (v1.15.0) The last name check of an owner's saved account (Duitku Disbursement), if any. */
const nameCheckLine = (a) => {
  const c = a?.nameCheck;
  if (!c) return '<div data-namecheck class="cell-sub" style="margin-bottom:10px">Not checked with the bank.</div>';
  const t = c.status === 'matched' ? tag('t-ok', 'name matches') : c.status === 'mismatch' ? tag('t-warn', 'name differs') : tag('t-crit', 'check failed');
  return `<div data-namecheck class="cell-sub" style="margin-bottom:10px">${t} ${c.bankName ? `the bank names it <b>${esc(c.bankName)}</b> · ` : ''}${esc(fmt.time(c.checkedAt))}</div>`;
};

async function bankDialog(row, { canWrite, onDone }) {
  let cur = null;
  try { cur = (await api(`/v1/finance/owners/${encodeURIComponent(row.ownerId)}/bank-account`)).account; } catch (e) { if (e.status !== 404) { toast(e.message, 'crit'); return; } }
  modal({
    title: `Bank details · ${row.owner}`,
    subtitle: cur ? `${cur.bankName} · ${cur.accountMasked} · ${cur.holderName}` : 'Not set yet',
    body: (cur ? nameCheckLine(cur) : '') + (canWrite ? `<div class="form">
        ${field('Bank', `<input name="bankName" maxlength="80" placeholder="BCA, Mandiri, BRI…" value="${esc(cur?.bankName ?? '')}">`)}
        ${field('Bank code', `<input name="bankCode" maxlength="12" placeholder="014" value="${esc(cur?.bankCode ?? '')}">`, { opt: true })}
        ${field('Account holder', `<input name="holderName" maxlength="120" value="${esc(cur?.holderName ?? '')}">`, { full: true, help: 'As the bank has it.' })}
        ${field('Account number', `<input name="accountNumber" inputmode="numeric" autocomplete="off" placeholder="${esc(cur ? `${cur.accountMasked} — leave empty to keep` : '')}">`, { full: true })}
      </div>` : (cur ? '' : callout('info', 'No bank details saved.'))),
    actions: canWrite ? [
      { label: 'Cancel' },
      // (v1.15.0) The saved account checked with Duitku Disbursement's inquiry: the name the bank has. Nothing is sent.
      ...(cur ? [{
        label: 'Check name with the bank',
        onClick: async (ctx) => {
          try {
            const r = await api(`/v1/finance/owners/${encodeURIComponent(row.ownerId)}/bank-account/check`, { method: 'POST' });
            const box = $('[data-namecheck]', ctx.el);
            if (box) box.outerHTML = nameCheckLine(r.account);
            toast(r.check.status === 'matched' ? `The bank names it ${r.check.bankName}` : r.check.status === 'mismatch' ? `The bank names it ${r.check.bankName}, not ${r.account.holderName}` : `The check failed: ${r.check.error}`, r.check.status === 'matched' ? 'ok' : 'warn');
          } catch (e) { toast(e.message, 'crit'); }
          return false;
        },
      }] : []),
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
    <p class="cell-sub">Pay owners from your bank, then record each transfer here. The transfer list has what is outstanding with each owner's bank details, for your bank's bulk transfer.${r.payoutsAvailable ? ' Or send a payout from PlugSure (Xendit Payouts or Duitku Disbursement): a second person approves it, and it is recorded here once the gateway confirms it.' : ''}</p>
    <div class="section" data-payouts></div>`;
  const reload = () => ownerSharesSection(el, canWrite);
  table($('[data-list]', el), {
    columns: [
      { label: 'Period', render: (x) => `${esc(x.period)}<div class="cell-sub mono">${esc(x.number)}</div>` },
      { label: 'Owner', render: (x) => `${esc(x.owner)}<div class="cell-sub">${x.bank ? esc(`${x.bank.bankName} · ${x.bank.accountMasked}`) : '<span style="color:var(--warn)">no bank details</span>'}</div>` },
      { label: 'Share', num: true, render: (x) => `<b>${esc(fmt.money(x.due, x.currency))}</b>` },
      { label: 'Paid', num: true, render: (x) => `${esc(fmt.money(x.paid, x.currency))}${x.lastPaidOn ? `<div class="cell-sub">${esc(fmt.date(`${x.lastPaidOn}T12:00:00Z`))}</div>` : ''}` },
      { label: 'Status', render: (x) => payTag(x.status) },
      { label: '', render: (x) => `<div class="row nowrap" style="gap:6px">${canWrite && r.payoutsAvailable && x.status !== 'paid' && x.bank ? `<button class="btn sm primary" type="button" data-send="${esc(x.statementId)}">Send payout</button>` : ''}<button class="btn sm${canWrite && x.status !== 'paid' && !r.payoutsAvailable ? ' primary' : ''}" type="button" data-pay="${esc(x.statementId)}">${canWrite && x.status !== 'paid' ? 'Record payment' : 'Payments'}</button><button class="btn sm" type="button" data-bank="${esc(x.statementId)}">Bank</button></div>` },
    ],
    rows: r.shares, empty: 'No owners\' shares on finalised statements yet (Billing → finalise an owner\'s statement).',
  });
  const byId = (id) => r.shares.find((x) => x.statementId === id);
  $$('[data-pay]', el).forEach((b) => b.addEventListener('click', () => { const x = byId(b.dataset.pay); paymentDialog(x, { title: `Payout to ${x.owner}`, canWrite, onDone: reload }); }));
  $$('[data-bank]', el).forEach((b) => b.addEventListener('click', () => bankDialog(byId(b.dataset.bank), { canWrite, onDone: reload })));
  $('[data-transfers]', el)?.addEventListener('click', async () => {
    try { const res = await api('/v1/finance/owner-shares/transfer-list.csv', { raw: true }); download('plugsure-owner-transfers.csv', await res.blob()); } catch (e) { toast(e.message, 'crit'); }
  });
  // (v1.16.0) Send a payout through Duitku Disbursement: requested here, approved by a second person.
  $$('[data-send]', el).forEach((b) => b.addEventListener('click', () => {
    const x = byId(b.dataset.send);
    const ex = CURRENCIES[x.currency]?.exponent ?? 0;
    modal({
      title: `Send ${x.owner}'s share to the bank account`,
      subtitle: `${x.number} · ${fmt.money(x.outstanding, x.currency)} outstanding · to ${x.bank.bankName} ${x.bank.accountMasked}`,
      body: `${callout('info', 'A second person approves the payout; it is recorded against the statement once the gateway confirms it. Duitku Disbursement also returns the name the bank has for the account; Xendit Payouts does not check names.')}
        <div class="form" style="margin-top:12px">${field(`Amount (${esc(x.currency)})`, `<input name="amount" inputmode="decimal" value="${esc(String(toMajor(x.outstanding, x.currency)))}">`)}${field('Note', '<input name="note" maxlength="300" placeholder="e.g. October share">', { opt: true })}
        ${(r.payoutRails ?? []).length > 1 ? field('Send through', `<select name="rail">${r.payoutRails.map((k) => `<option value="${k}">${k === 'xendit' ? 'Xendit Payouts' : 'Duitku Disbursement'}</option>`).join('')}</select>`) : ''}</div>`,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Check and request', kind: 'primary',
          async onClick(ctx) {
            const amount = Math.round(Number($('[name="amount"]', ctx.body).value.replace(/[^\d.]/g, '')) * 10 ** ex);
            try {
              const t = (await api(`/v1/finance/statements/${encodeURIComponent(x.statementId)}/payout`, { method: 'POST', body: { amount, note: $('[name="note"]', ctx.body).value.trim() || undefined, rail: $('[name="rail"]', ctx.body)?.value || undefined } })).transfer;
              toast(t.rail === 'xendit' ? 'Requested. Awaiting approval by a second person.' : t.namesMatch ? `The bank names it ${t.checkedName}. Awaiting approval.` : `The bank names it ${t.checkedName ?? '—'}, not ${t.holderName}. Awaiting approval.`, t.rail === 'xendit' || t.namesMatch ? 'ok' : 'warn');
              reload();
            } catch (e) { toast(e.message, 'crit'); return false; }
          },
        },
      ],
    });
  }));
  await payoutsSection($('[data-payouts]', el), canWrite, reload);
  return { text: total(open), count: open.length };
}

/** (v1.16.0) Owner payouts through Duitku Disbursement: approve (a second person), reject, or settle by hand. */
async function payoutsSection(el, canWrite, reload) {
  let list = [];
  try { list = (await api('/v1/finance/payout-transfers')).transfers ?? []; } catch { el.innerHTML = ''; return; }
  if (!list.length) { el.innerHTML = ''; return; }
  const me = state.me?.user?.id;
  const TAGS = { awaiting_approval: ['t-warn', 'awaiting approval'], sending: ['t-info', 'sending'], sent: ['t-info', 'sent, not confirmed'], succeeded: ['t-ok', 'paid'], failed: ['t-crit', 'failed'], rejected: ['t-mute', 'rejected'] };
  const waiting = list.filter((t) => t.state === 'awaiting_approval').length;
  el.innerHTML = `<div class="card"><header><h3>Payouts sent from PlugSure</h3></header>${waiting ? `<div class="body">${callout('warn', `${fmt.num(waiting)} payout${waiting === 1 ? '' : 's'} awaiting approval by someone other than the requester.`)}</div>` : ''}<div data-pl></div></div>`;
  table($('[data-pl]', el), {
    columns: [
      { label: 'Requested', render: (t) => `${esc(fmt.time(t.requestedAt))}<div class="cell-sub">${esc(t.requestedByName ?? '—')}</div>` },
      { label: 'Statement', render: (t) => `${esc(t.owner ?? '')}<div class="cell-sub mono">${esc(t.number ?? '')}</div>` },
      { label: 'Amount', num: true, render: (t) => `<b>${esc(fmt.money(t.amount, t.currency))}</b>` },
      { label: 'Account', render: (t) => `<span class="mono">${esc(t.bankCode)} ${esc(t.accountMasked)}</span><div class="cell-sub">${t.rail === 'xendit' ? 'Xendit Payouts · name not checked' : `bank: ${esc(t.checkedName ?? '—')} ${t.checkedName ? (t.namesMatch ? tag('t-ok', 'names match') : tag('t-warn', 'names differ')) : ''}`}</div>` },
      { label: 'Status', render: (t) => `${tag(...(TAGS[t.state] ?? ['t-mute', t.state]))}${t.approvedByName ? `<div class="cell-sub">approved by ${esc(t.approvedByName)}</div>` : ''}${t.reason ? `<div class="cell-sub">${esc(t.reason)}</div>` : ''}${t.error ? `<div class="cell-sub" style="color:var(--crit)">${esc(t.error)}</div>` : ''}` },
      {
        label: '',
        render: (t) => {
          if (!canWrite) return '';
          if (t.state === 'awaiting_approval') {
            const mine = t.requestedBy && t.requestedBy === me;
            const first = t.firstApprovedBy && t.firstApprovedBy === me;
            const wait = mine ? 'needs another person' : first ? 'needs a second approver' : '';
            return `<div class="row nowrap" style="gap:6px">${t.firstApprovedBy ? tag('t-info', '1 of 2 approved') : ''}${wait ? `<span class="cell-sub">${wait}</span>` : `<button class="btn sm primary" type="button" data-papprove="${esc(t.id)}">${t.firstApprovedBy ? 'Second approval and send' : 'Approve and send'}</button>`}<button class="btn sm" type="button" data-preject="${esc(t.id)}">${mine ? 'Withdraw' : 'Reject'}</button></div>`;
          }
          return t.state === 'sent' ? `<button class="btn sm" type="button" data-psettle="${esc(t.id)}">Settle by hand</button>` : '';
        },
      },
    ],
    rows: list, empty: '',
  });
  el.addEventListener('click', async (ev) => {
    const ap = ev.target.closest('[data-papprove]'), rj = ev.target.closest('[data-preject]'), st = ev.target.closest('[data-psettle]');
    const btn = ap ?? rj ?? st;
    if (!btn) return;
    const t = list.find((x) => x.id === (btn.dataset.papprove ?? btn.dataset.preject ?? btn.dataset.psettle));
    if (ap) {
      modal({
        title: 'Approve and send the payout',
        body: `<p>Send <b>${esc(fmt.money(t.amount, t.currency))}</b> to ${esc(t.checkedName ?? t.holderName)} (${esc(t.bankCode)} ${esc(t.accountMasked)}) through ${t.rail === 'xendit' ? 'Xendit Payouts' : 'Duitku Disbursement'}?</p>${t.rail === 'xendit' ? callout('info', 'Xendit does not check the name: approve only if the account is the owner\'s.') : t.namesMatch ? '' : callout('warn', `The bank names the account ${esc(t.checkedName ?? '—')}, not ${esc(t.holderName)}. Approve only if you are sure it is the owner's.`)}`,
        actions: [{ label: 'Cancel' }, {
          label: 'Approve and send', kind: 'primary',
          async onClick() {
            try {
              const r = (await api(`/v1/finance/payout-transfers/${t.id}/approve`, { method: 'POST' })).transfer;
              toast(r.state === 'awaiting_approval' ? 'First approval recorded: a second approver sends it' : r.state === 'succeeded' ? 'Paid and recorded against the statement' : r.state === 'sent' ? 'Sent; its result is checked automatically' : `Not paid: ${r.error ?? r.state}`, r.state === 'failed' ? 'crit' : 'ok');
              reload();
            } catch (e) { toast(e.message, 'crit'); return false; }
          },
        }],
      });
      return;
    }
    const settle = Boolean(st);
    modal({
      title: settle ? 'Settle a payout by hand' : 'Reject the payout',
      subtitle: `${fmt.money(t.amount, t.currency)} to ${t.checkedName ?? t.holderName}`,
      body: settle
        ? `${callout('warn', 'The gateway has not confirmed this payout. Check it in its dashboard first.')}<div class="form one" style="margin-top:12px">${field('Outcome', '<select name="outcome"><option value="succeeded">Paid (the dashboard shows success)</option><option value="failed">Not paid (the dashboard shows it failed)</option></select>')}${field('What the dashboard shows', '<input name="note" maxlength="300">')}</div>`
        : `<div class="form one">${field('Reason', '<input name="note" maxlength="300">')}</div>`,
      actions: [{ label: 'Cancel' }, {
        label: settle ? 'Settle' : 'Reject', kind: settle ? 'primary' : 'danger',
        async onClick(ctx) {
          const note = $('[name="note"]', ctx.body).value.trim();
          if (!note) { $('[name="note"]', ctx.body).classList.add('invalid'); return false; }
          try {
            await api(`/v1/finance/payout-transfers/${t.id}/${settle ? 'resolve' : 'reject'}`, { method: 'POST', body: settle ? { outcome: $('[name="outcome"]', ctx.body).value, note } : { reason: note } });
            toast(settle ? 'Settled' : 'Rejected', 'ok');
            reload();
          } catch (e) { toast(e.message, 'crit'); return false; }
        },
      }],
    });
  });
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

// ─────────────────────────────────────────── (v1.18.0) bank statements and tax

const MATCH_LABEL = { gateway_withdrawal: 'Gateway payout', statement_payment: 'Statement payment', refund: 'Refund', roaming_payment: 'Roaming settlement', supplier_payment: 'Supplier payment', ignored: 'Ignored' };

/** Bank: upload the bank's CSV, see what matched, match the rest by hand. */
async function bankSection(el, canWrite) {
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let st, ls;
  try { [st, ls] = await Promise.all([api('/v1/finance/bank-statements'), api('/v1/finance/bank-lines')]); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = () => bankSection(el, canWrite);
  const open = ls.lines.filter((l) => !l.match);
  el.innerHTML = `<div class="grid k3" style="margin-bottom:16px">${kpi('Lines', fmt.num(ls.lines.length))}${kpi('Matched', fmt.num(ls.lines.length - open.length))}${kpi('Open', fmt.num(open.length), open.length ? 'to match or ignore' : '')}</div>
    <div class="card"><header><h3>Bank statements</h3>${canWrite ? `<label class="btn sm primary" style="cursor:pointer">${icon('upload')} Upload CSV<input type="file" accept=".csv,text/csv" data-up hidden></label>` : ''}</header>
      <div class="body"><p class="cell-sub">Export the account's statement from the bank as CSV (BCA, Mandiri, BRI and others with date, description and amount columns). Lines already uploaded are skipped; each line is matched to a gateway payout, an owner payout or a manual refund of the same amount within 4 days.</p></div>
      <div data-st></div></div>
    <div class="card"><header><h3>Lines</h3><label class="row nowrap" style="gap:6px"><input type="checkbox" data-openonly> open only</label></header><div data-lines></div></div>`;
  table($('[data-st]', el), {
    columns: [
      { label: 'Uploaded', render: (x) => `${esc(fmt.time(x.uploadedAt))}<div class="cell-sub">${esc(x.uploadedBy ?? '')}</div>` },
      { label: 'File', render: (x) => `${esc(x.filename)}<div class="cell-sub">${esc(x.bank)}</div>` },
      { label: 'Period', render: (x) => `${esc(x.from ?? '')} – ${esc(x.to ?? '')}` },
      { label: 'New lines', num: true, render: (x) => esc(fmt.num(x.lines)) },
      { label: 'Open', num: true, render: (x) => (x.open ? tag('t-warn', fmt.num(x.open)) : tag('t-ok', '0')) },
    ],
    rows: st.statements, empty: 'No statements uploaded yet.',
  });
  const drawLines = (rows) => table($('[data-lines]', el), {
    columns: [
      { label: 'Date', render: (l) => esc(fmt.date(`${l.date}T12:00:00Z`)) },
      { label: 'Description', render: (l) => `${esc(l.description)}${l.reference ? `<div class="cell-sub mono">${esc(l.reference)}</div>` : ''}` },
      { label: 'Amount', num: true, render: (l) => `<b style="color:${l.amount < 0 ? 'var(--crit)' : 'inherit'}">${esc(rp(l.amount))}</b>` },
      { label: 'Matched to', render: (l) => (l.match ? `${tag(l.match.kind === 'ignored' ? 't-mute' : 't-ok', MATCH_LABEL[l.match.kind] ?? l.match.kind)}<div class="cell-sub">${esc(l.match.label ?? l.match.note ?? '')}${l.match.auto ? ' · automatic' : l.match.by ? ` · ${esc(l.match.by)}` : ''}</div>` : tag('t-warn', 'open')) },
      { label: '', render: (l) => (!canWrite ? '' : l.match ? `<button class="btn sm" type="button" data-unmatch="${esc(l.id)}">Undo</button>` : `<button class="btn sm primary" type="button" data-match="${esc(l.id)}">Match</button>`) },
    ],
    rows, empty: 'No lines.',
  });
  drawLines(ls.lines);
  $('[data-openonly]', el).addEventListener('change', (e) => drawLines(e.target.checked ? open : ls.lines));
  $('[data-up]', el)?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const r = await api('/v1/finance/bank-statements', { method: 'POST', body: { filename: f.name, csv: await f.text() } });
      toast(`${r.bank}: ${fmt.num(r.lines)} new line${r.lines === 1 ? '' : 's'}${r.duplicates ? `, ${fmt.num(r.duplicates)} already uploaded` : ''}; ${fmt.num(r.matched)} matched.`, 'ok');
      reload();
    } catch (err) { toast(err.message, 'crit'); }
  });
  $('[data-lines]', el).addEventListener('click', async (e) => {
    const un = e.target.closest('[data-unmatch]'), mb = e.target.closest('[data-match]');
    if (un) {
      try { await api(`/v1/finance/bank-lines/${un.dataset.unmatch}/match`, { method: 'POST', body: { kind: 'none' } }); reload(); } catch (err) { toast(err.message, 'crit'); }
      return;
    }
    if (!mb) return;
    const l = ls.lines.find((x) => x.id === mb.dataset.match);
    let cands = [];
    try { cands = (await api(`/v1/finance/bank-lines/${l.id}/candidates`)).candidates; } catch (err) { toast(err.message, 'crit'); return; }
    modal({
      title: 'Match a bank line', subtitle: `${l.date} · ${rp(l.amount)} · ${l.description}`, size: 'lg',
      body: `<div class="form one">${field('Matches', `<select name="cand"><option value="">— Ignore it (not PlugSure's money) —</option>${cands.map((c, i) => `<option value="${i}">${esc(MATCH_LABEL[c.kind])} · ${esc(c.date)} · ${esc(rp(c.amount))} · ${esc(c.label)}${c.amount !== l.amount ? ' (amount differs)' : ''}</option>`).join('')}</select>`)}
        ${field('Note', '<input name="note" maxlength="300" placeholder="e.g. bank fee, another business">')}</div>${cands.length ? '' : callout('info', 'Nothing unmatched of this direction around this date: ignore it with a note.')}`,
      actions: [{ label: 'Cancel' }, {
        label: 'Save', kind: 'primary',
        async onClick(ctx) {
          const i = $('[name="cand"]', ctx.body).value, note = $('[name="note"]', ctx.body).value.trim();
          const c = i === '' ? null : cands[Number(i)];
          if (!c && !note) { $('[name="note"]', ctx.body).classList.add('invalid'); return false; }
          try {
            await api(`/v1/finance/bank-lines/${l.id}/match`, { method: 'POST', body: c ? { kind: c.kind, ref: c.ref, note: note || undefined } : { kind: 'ignored', note } });
            toast('Saved.', 'ok');
            reload();
          } catch (err) { toast(err.message, 'crit'); return false; }
        },
      }],
    });
  });
}

/** Tax: PPh 23 withheld on the gateway's fees and PlugSure's fee; (platform administrators) the platform e-Faktur. */
async function taxSection(el, canWrite, year = new Date().getFullYear()) {
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let y;
  try { y = await api(`/v1/finance/tax/pph23?year=${year}`); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = (yr = year) => taxSection(el, canWrite, yr);
  const KIND = { gateway_fee: 'Gateway fees', platform_fee: 'PlugSure platform fee' };
  const admin = state.can('platform:admin');
  const thisYear = new Date().getFullYear();
  el.innerHTML = `<div data-taxcal></div><div class="card"><header><h3>PPh 23 withheld</h3><div class="row nowrap" style="gap:6px"><select data-year>${[thisYear, thisYear - 1, thisYear - 2].map((v) => `<option${v === year ? ' selected' : ''}>${v}</option>`).join('')}</select><button class="btn sm" type="button" data-csv>${icon('download')} CSV</button></div></header>
      <div class="body">${callout('info', 'If your organisation withholds PPh 23, it withholds 2% of the services it pays for — the gateway\'s fees and PlugSure\'s platform fee — and gives the payee a bukti potong. Finance suggests each month\'s base; record what you withheld. Your tax adviser decides the treatment; Finance files nothing.')}</div>
      <div data-sug></div></div>
    <div class="card"><header><h3>Records</h3></header><div data-rec></div></div>
    ${admin ? `<div class="card"><header><h3>Withheld on PlugSure's fee (by operators)</h3></header><div data-recv></div></div>
    <div class="card"><header><h3>e-Faktur for PlugSure's platform fee</h3></header><div class="body"><div class="filters" style="margin-top:0">
      ${field('Month', `<input type="month" name="ef_period" value="${esc(`${year}-${String(new Date().getMonth() || 12).padStart(2, '0')}`)}">`)}
      ${field('Goods / services', '<select name="ef_opt"><option value="B">B · services</option><option value="A">A · goods</option></select>')}
      ${field('Code (6 digits)', '<input name="ef_code" value="000000" maxlength="6" inputmode="numeric">')}
      ${field('Unit (UM.nnnn)', '<input name="ef_unit" value="UM.0030" maxlength="7">')}
      <div class="row" style="align-self:flex-end"><button class="btn primary" type="button" data-ef>${icon('download')} XML</button></div></div>
      <p class="cell-sub">The month's finalised platform statements with PPN as Coretax's import XML: PlugSure the seller (BILLING_ISSUER_NPWP), each operator the buyer. Operators without an NPWP are left out.</p></div></div>` : ''}`;
  taxCalendarCard($('[data-taxcal]', el), canWrite);
  table($('[data-sug]', el), {
    columns: [
      { label: 'Month', render: (s) => esc(s.period) },
      { label: 'Paid to', render: (s) => `${esc(s.counterparty)}<div class="cell-sub">${esc(KIND[s.kind])}${s.number ? ` · <span class="mono">${esc(s.number)}</span>` : ''}</div>` },
      { label: 'Base', num: true, render: (s) => esc(rp(s.base)) },
      { label: '2%', num: true, render: (s) => esc(rp(s.suggested)) },
      { label: 'Withheld', num: true, render: (s) => (s.recorded ? `${esc(rp(s.withheld))}${s.buktiMissing ? `<div>${tag('t-warn', 'bukti potong missing')}</div>` : ''}` : '<span class="cell-sub">—</span>') },
      { label: '', render: (s, i) => (canWrite && !s.recorded ? `<button class="btn sm primary" type="button" data-rec="${i}">Record</button>` : '') },
    ],
    rows: y.suggestions, empty: 'No gateway fees or PlugSure statements this year.',
  });
  const recTable = (box, rows, withOperator) => table(box, {
    columns: [
      { label: 'Month', render: (w) => esc(w.period) },
      ...(withOperator ? [{ label: 'Operator', render: (w) => esc(w.operator ?? '') }] : []),
      { label: 'Paid to', render: (w) => `${esc(w.counterparty)}<div class="cell-sub">${esc(KIND[w.kind])}${w.counterpartyNpwp ? ` · NPWP ${esc(w.counterpartyNpwp)}` : ''}</div>` },
      { label: 'Base', num: true, render: (w) => esc(rp(w.base)) },
      { label: 'Withheld', num: true, render: (w) => `<b>${esc(rp(w.amount))}</b><div class="cell-sub">${esc(String(w.rateBps / 100))}%</div>` },
      { label: 'Bukti potong', render: (w) => (w.buktiNumber ? `<span class="mono">${esc(w.buktiNumber)}</span><div class="cell-sub">${esc(w.buktiDate ?? '')}</div>` : tag('t-warn', 'missing')) },
      { label: 'Status', render: (w) => (w.voided ? `${tag('t-mute', 'voided')}<div class="cell-sub">${esc(w.voidReason ?? '')}</div>` : tag('t-ok', 'recorded')) },
      ...(withOperator ? [] : [{ label: '', render: (w) => (!canWrite || w.voided ? '' : `<div class="row nowrap" style="gap:6px">${w.buktiNumber ? '' : `<button class="btn sm" type="button" data-bukti="${esc(w.id)}">Add bukti</button>`}<button class="btn sm" type="button" data-void="${esc(w.id)}">Void</button></div>`) }]),
    ],
    rows, empty: withOperator ? 'No operator has recorded withholding on PlugSure\'s fee this year.' : 'Nothing recorded this year.',
  });
  recTable($('[data-rec]', el), y.recorded, false);
  if (admin) recTable($('[data-recv]', el), y.received, true);
  $('[data-year]', el).addEventListener('change', (e) => reload(Number(e.target.value)));
  $('[data-csv]', el).addEventListener('click', async () => {
    try { const res = await api(`/v1/finance/tax/pph23?year=${year}&format=csv`, { raw: true }); download(`plugsure-pph23-${year}.csv`, await res.blob()); } catch (err) { toast(err.message, 'crit'); }
  });
  $('[data-ef]', el)?.addEventListener('click', async (e) => {
    const v = (n) => $(`[name="${n}"]`, el).value.trim();
    e.currentTarget.disabled = true;
    try {
      const q = new URLSearchParams({ period: v('ef_period'), itemOpt: v('ef_opt'), itemCode: v('ef_code'), unitCode: v('ef_unit') });
      const res = await api(`/v1/finance/tax/platform-efaktur?${q}`, { raw: true });
      download(`efaktur-platform-${v('ef_period')}.xml`, await res.blob());
      const skipped = Number(res.headers.get('x-efaktur-skipped') ?? 0);
      if (skipped) toast(`${skipped} statement${skipped === 1 ? '' : 's'} left out: the operator has no valid NPWP.`, 'warn');
    } catch (err) { toast(err.message, 'crit'); }
    e.currentTarget.disabled = false;
  });
  $('[data-sug]', el).addEventListener('click', (e) => {
    const b = e.target.closest('[data-rec]');
    if (!b) return;
    const s = y.suggestions[Number(b.dataset.rec)];
    modal({
      title: 'Record PPh 23 withheld', subtitle: `${s.period} · ${KIND[s.kind]}`,
      body: `<div class="form">${field('Paid to', `<input name="cp" value="${esc(s.counterparty)}" maxlength="160">`)}${field('Their NPWP', '<input name="npwp" inputmode="numeric" maxlength="20">')}
        ${field('Base (rupiah)', `<input name="base" type="number" min="0" step="1" value="${esc(String(s.base))}">`)}${field('Withheld (rupiah)', `<input name="amount" type="number" min="0" step="1" value="${esc(String(s.suggested))}">`)}
        ${field('Bukti potong number', '<input name="bn" maxlength="60">')}${field('Bukti potong date', '<input name="bd" type="date">')}</div>`,
      actions: [{ label: 'Cancel' }, {
        label: 'Record', kind: 'primary',
        async onClick(ctx) {
          const v = (n) => $(`[name="${n}"]`, ctx.body).value.trim();
          try {
            await api('/v1/finance/tax/withholdings', { method: 'POST', body: {
              kind: s.kind, period: s.period, counterparty: v('cp'), counterpartyNpwp: v('npwp') || undefined, integrationId: s.integrationId ?? undefined, statementId: s.statementId ?? undefined,
              base: Number(v('base')), amount: Number(v('amount')), buktiNumber: v('bn') || undefined, buktiDate: v('bd') || undefined,
            } });
            toast('Recorded.', 'ok');
            reload();
          } catch (err) { toast(err.message, 'crit'); return false; }
        },
      }],
    });
  });
  $('[data-rec]', el).addEventListener('click', (e) => {
    const bk = e.target.closest('[data-bukti]'), vd = e.target.closest('[data-void]');
    if (!bk && !vd) return;
    const id = (bk ?? vd).dataset.bukti ?? (bk ?? vd).dataset.void;
    modal({
      title: bk ? 'Add the bukti potong' : 'Void the record',
      body: bk ? `<div class="form">${field('Number', '<input name="bn" maxlength="60">')}${field('Date', '<input name="bd" type="date">')}</div>` : `<div class="form one">${field('Why', '<input name="why" maxlength="300">')}</div>`,
      actions: [{ label: 'Cancel' }, {
        label: bk ? 'Save' : 'Void', kind: bk ? 'primary' : 'danger',
        async onClick(ctx) {
          const v = (n) => $(`[name="${n}"]`, ctx.body).value.trim();
          try {
            await api(`/v1/finance/tax/withholdings/${id}/${bk ? 'bukti' : 'void'}`, { method: 'POST', body: bk ? { buktiNumber: v('bn'), buktiDate: v('bd') } : { reason: v('why') } });
            toast('Saved.', 'ok');
            reload();
          } catch (err) { toast(err.message, 'crit'); return false; }
        },
      }],
    });
  });
}

// ─────────────────────────────────────────── (v1.19.0) forecast, fee audit, accounting export, owners' bank changes

const FLOW_LABEL = { settlement: 'Settlement', fleet_invoice: 'Fleet invoice', hub_in: 'Hub (in)', postpay: 'Post-pay', refund: 'Refund', owner_payout: 'Owner share', platform_statement: 'PlugSure statement', hub_out: 'Hub (out)' };

/** The running position as a small line chart (an area under zero shaded). */
function positionChart(series) {
  if (!series.length) return '';
  const W = 720, H = 140, pad = 6;
  const ys = series.map((d) => d.position);
  const lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
  const x = (i) => pad + (i * (W - 2 * pad)) / Math.max(1, series.length - 1);
  const y = (v) => H - pad - ((v - lo) * (H - 2 * pad)) / Math.max(1, hi - lo);
  const pts = series.map((d, i) => `${x(i).toFixed(1)},${y(d.position).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Position by day">
    <line x1="${pad}" x2="${W - pad}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="var(--line)" stroke-dasharray="4 4"/>
    ${lo < 0 ? `<rect x="${pad}" y="${y(0).toFixed(1)}" width="${W - 2 * pad}" height="${(y(lo) - y(0)).toFixed(1)}" fill="var(--crit)" opacity="0.07"/>` : ''}
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>`;
}

async function forecastSection(el, base, label) {
  const days = el.dataset.days ?? '30', terms = el.dataset.terms ?? '14', run = el.dataset.run === 'true';
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let f;
  try { f = await api(`${base}/forecast?days=${days}&termsDays=${terms}&runRate=${run}`); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const o = f.opening;
  el.innerHTML = `<div class="filters" style="margin-top:0">
      ${field('Horizon', `<select data-fdays>${[30, 60, 90].map((d) => `<option value="${d}"${String(d) === days ? ' selected' : ''}>${d} days</option>`).join('')}</select>`)}
      ${field('Statement terms', `<input data-fterms type="number" min="0" max="120" value="${esc(terms)}" style="width:90px">`, { help: 'days from finalisation' })}
      <label class="check" style="align-self:flex-end"><input type="checkbox" data-frun${run ? ' checked' : ''}><span>Add the run rate (estimate)</span></label>
      <div class="row" style="align-self:flex-end"><button class="btn" type="button" data-fcsv>${icon('download')} CSV</button></div></div>
    ${f.shortfall ? callout('crit', `<b>Shortfall on ${esc(fmt.date(`${f.shortfall.day}T12:00:00Z`))}</b>: the position goes to ${esc(rp(f.shortfall.position))}. Collect what is owed or move a payout.`) : callout('ok', `No shortfall in the next ${f.days} days on what PlugSure knows of; the lowest point is ${esc(rp(f.lowest.position))} on ${esc(fmt.date(`${f.lowest.day}T12:00:00Z`))}.`)}
    <div class="grid k4">${kpi('Opening', esc(rp(o.total)), esc([o.gateway != null ? `${label} ${rp(o.gateway)}` : `${label} balance unknown`, o.bank != null ? `bank ${rp(o.bank)} (${o.bankAsOf})` : 'no bank statement uploaded'].join(' · ')))}
      ${kpi('In', esc(rp(f.totals.in)), f.runRate ? esc(`+ ${rp(f.totals.estimate)} estimated`) : 'committed')}
      ${kpi('Out', esc(rp(-f.totals.out)), 'refunds, owner shares, statements')}
      ${kpi(`In ${f.days} days`, esc(rp(f.closing)), f.runRate ? 'with the run rate' : 'committed only', f.closing < 0 ? 'crit' : '')}</div>
    <div class="card section"><header><h3>Position by day</h3></header><div class="body">${positionChart(f.series)}</div></div>
    <div class="card section"><header><h3>Flows</h3></header><div data-flows></div></div>
    <p class="cell-sub">A forecast of what PlugSure knows: settlements the gateway expects, invoices and statements by their due dates. Payments not made yet are only in the run rate, an estimate from the last 28 days.</p>`;
  table($('[data-flows]', el), {
    columns: [
      { label: 'Day', render: (x) => esc(fmt.date(`${x.day}T12:00:00Z`)) },
      { label: 'What', render: (x) => `${tag(x.amount < 0 ? 't-warn' : 't-ok', FLOW_LABEL[x.kind] ?? x.kind)}<div class="cell-sub">${esc(x.label)}</div>` },
      { label: 'Amount', num: true, render: (x) => `<b style="color:${x.amount < 0 ? 'var(--crit)' : 'inherit'}">${esc(rp(x.amount))}</b>` },
      { label: 'Position', num: true, render: (x) => esc(rp(f.series.find((d) => d.day === x.day)?.position ?? 0)) },
    ],
    rows: f.flows, empty: 'Nothing due in or out in this period.',
  });
  const redo = () => forecastSection(el, base, label);
  $('[data-fdays]', el).addEventListener('change', (e) => { el.dataset.days = e.target.value; redo(); });
  $('[data-fterms]', el).addEventListener('change', (e) => { el.dataset.terms = e.target.value; redo(); });
  $('[data-frun]', el).addEventListener('change', (e) => { el.dataset.run = String(e.target.checked); redo(); });
  $('[data-fcsv]', el).addEventListener('click', async () => {
    try { const res = await api(`${base}/forecast?days=${days}&termsDays=${terms}&runRate=${run}&format=csv`, { raw: true }); download(`plugsure-forecast-${f.from}-${f.days}d.csv`, await res.blob()); } catch (err) { toast(err.message, 'crit'); }
  });
}

async function feeAuditSection(el, base, per, label) {
  let r;
  try { r = await api(`${base}/fee-audit?${per}`); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  el.innerHTML = `<div class="card"><header><h3>Fee audit</h3>${r.rated ? `<button class="btn sm right" type="button" data-fadl>${icon('download')} Claim (CSV)</button>` : ''}</header>
    <div class="body">${!r.rated ? callout('info', `Enter the rates you agreed with ${esc(label)} under <b>Settings → Contracted rates</b>: every fee is then checked against them.`)
      : r.totals.overcharge > 0 ? callout('warn', `<b>${esc(rp(r.totals.overcharge))} charged above the agreed rates</b> on ${esc(fmt.num(r.totals.overcharged))} payment${r.totals.overcharged === 1 ? '' : 's'} in this period. Download the claim for ${esc(label)}'s account manager.`)
        : callout('ok', 'Every fee in this period is within the agreed rates.')}
      ${r.unrated.length && r.rated ? `<p class="cell-sub">No agreed rate for ${r.unrated.map((m) => `<span class="mono">${esc(m)}</span>`).join(', ')}: not checked.</p>` : ''}</div>
    <div data-fa></div></div>`;
  table($('[data-fa]', el), {
    columns: [
      { label: 'Month', render: (x) => esc(x.month) },
      { label: 'Method', render: (x) => `<span class="mono">${esc(x.method)}</span>${x.agreed ? `<div class="cell-sub">${esc(`${x.agreed.pct}%${x.agreed.fixed ? ` + ${rp(x.agreed.fixed)}` : ''}${x.agreed.freeUpTo ? `, free up to ${rp(x.agreed.freeUpTo)}` : ''}`)}</div>` : '<div class="cell-sub">no agreed rate</div>'}` },
      { label: 'Payments', num: true, render: (x) => esc(fmt.num(x.payments)) },
      { label: 'Charged', num: true, render: (x) => esc(rp(x.charged)) },
      { label: 'Agreed', num: true, render: (x) => (x.expected == null ? '<span class="cell-sub">—</span>' : esc(rp(x.expected))) },
      { label: 'Overcharge', num: true, render: (x) => (x.over > 0 ? `<b style="color:var(--crit)">${esc(rp(x.over))}</b><div class="cell-sub">${esc(fmt.num(x.overCount))} payment${x.overCount === 1 ? '' : 's'}</div>` : '<span class="cell-sub">—</span>') },
    ],
    rows: r.byMonth, empty: 'No payments in this period.',
  });
  $('[data-fadl]', el)?.addEventListener('click', async () => {
    try { const res = await api(`${base}/fee-audit?${per}&format=csv`, { raw: true }); download('plugsure-fee-audit.csv', await res.blob()); } catch (err) { toast(err.message, 'crit'); }
  });
}

const RATE_METHODS = ['QRIS', 'DANA', 'OVO', 'SHOPEEPAY', 'LINKAJA', 'GOPAY', 'CARD', 'VA'];

async function accountingSection(el, base, canWrite, pkgSaved) {
  let r;
  try { r = await api(`${base}/accounting-exports`); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const pkg = pkgSaved ?? r.package ?? 'generic';
  el.innerHTML = `<div class="card"><header><h3>Accounting software</h3></header><div class="body">
      <p class="cell-sub" style="margin-top:0">A closed month's journal as your package's import file, with your chart of accounts. Check the first import against the package's template.</p>
      <div class="filters" style="margin-top:0">${field('Package', `<select data-apkg${canWrite ? '' : ' disabled'}>${r.packages.map((p) => `<option value="${esc(p.id)}"${p.id === pkg ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select>`)}</div></div>
    <div data-amonths></div></div>`;
  table($('[data-amonths]', el), {
    columns: [
      { label: 'Month', render: (m) => esc(m.month) },
      { label: 'In the books', render: (m) => (m.exported ? `${tag('t-ok', 'exported')}<div class="cell-sub">${esc(fmt.time(m.lastAt))} · ${esc(r.packages.find((p) => p.id === m.lastPackage)?.label ?? m.lastPackage)}</div>` : tag('t-mute', 'not yet')) },
      { label: '', render: (m) => `<button class="btn sm${m.exported ? '' : ' primary'}" type="button" data-aexp="${esc(m.month)}">${icon('download')} Export</button>` },
    ],
    rows: r.months, empty: '',
  });
  $('[data-apkg]', el).addEventListener('change', async (e) => {
    try { await api(`${base}/settings`, { method: 'PUT', body: { accountingPackage: e.target.value } }); toast('Package saved.', 'ok'); } catch (err) { toast(err.message, 'crit'); }
  });
  $('[data-amonths]', el).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-aexp]');
    if (!b) return;
    b.disabled = true;
    try {
      const res = await api(`${base}/accounting-exports`, { method: 'POST', body: { month: b.dataset.aexp, package: $('[data-apkg]', el).value }, raw: true });
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `plugsure-${b.dataset.aexp}.csv`;
      download(name, await res.blob());
      accountingSection(el, base, canWrite, $('[data-apkg]', el).value);
    } catch (err) { toast(err.message, 'crit'); b.disabled = false; }
  });
}

/** Payables: site owners' requests (from their portal) to change their bank details. */
async function bankRequestsSection(el, canWrite) {
  let list = [];
  try { list = (await api('/v1/finance/owner-bank-requests')).requests ?? []; } catch { el.innerHTML = ''; return; }
  if (!list.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="card"><header><h3>Bank detail changes from owners</h3></header><div class="body">${callout('warn', 'Confirm a change with the owner by phone before approving it: changed bank details are how payouts get stolen.')}</div><div data-br></div></div>`;
  table($('[data-br]', el), {
    columns: [
      { label: 'Owner', render: (x) => `${esc(x.owner)}<div class="cell-sub">${esc(fmt.time(x.requestedAt))} · ${esc(x.requestedBy ?? '')}</div>` },
      { label: 'On file', render: (x) => (x.current ? `${esc(x.current.bankName)} <span class="mono">${esc(x.current.accountMasked)}</span><div class="cell-sub">${esc(x.current.holderName)}</div>` : '<span class="cell-sub">none</span>') },
      { label: 'Requested', render: (x) => `<b>${esc(x.bankName)}</b> ${x.bankCode ? `<span class="mono">${esc(x.bankCode)}</span> ` : ''}<span class="mono">${esc(x.accountMasked)}</span><div class="cell-sub">${esc(x.holderName)}${x.note ? ` · ${esc(x.note)}` : ''}</div>` },
      { label: '', render: (x) => (canWrite ? `<div class="row nowrap" style="gap:6px"><button class="btn sm primary" type="button" data-bra="${esc(x.id)}">Approve</button><button class="btn sm" type="button" data-brr="${esc(x.id)}">Reject</button></div>` : '') },
    ],
    rows: list, empty: '',
  });
  $('[data-br]', el).addEventListener('click', (e) => {
    const ap = e.target.closest('[data-bra]'), rj = e.target.closest('[data-brr]');
    if (!ap && !rj) return;
    const x = list.find((r) => r.id === (ap ?? rj).dataset[ap ? 'bra' : 'brr']);
    modal({
      title: ap ? 'Approve the new bank details' : 'Reject the change',
      subtitle: `${x.owner}: ${x.bankName} ${x.accountMasked} (${x.holderName})`,
      body: `${ap ? callout('warn', 'Payouts will go to this account from now on.') : ''}<div class="form one">${field(ap ? 'How you confirmed it' : 'Reason (the owner sees it)', '<input name="note" maxlength="300">', { opt: Boolean(ap) })}</div>`,
      actions: [{ label: 'Cancel' }, {
        label: ap ? 'Approve' : 'Reject', kind: ap ? 'primary' : 'danger',
        async onClick(ctx) {
          const note = $('[name="note"]', ctx.body).value.trim();
          if (!ap && !note) { $('[name="note"]', ctx.body).classList.add('invalid'); return false; }
          try { const res = await api(`/v1/finance/owner-bank-requests/${x.id}/${ap ? 'approve' : 'reject'}`, { method: 'POST', body: { note: note || undefined } }); toast(res.firstApproval ? 'First approval recorded: a second approver completes it.' : ap ? 'Approved: the account on file is replaced.' : 'Rejected.', 'ok'); bankRequestsSection(el, canWrite); } catch (err) { toast(err.message, 'crit'); return false; }
        },
      }],
    });
  });
}

// ─────────────────────────────────────────── (v1.20.0) margin, budgets, collections

const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const monthOptions = (sel) => { const out = []; const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + 3); for (let i = 0; i < 18; i++) { const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; out.push(`<option value="${m}"${m === sel ? ' selected' : ''}>${m}</option>`); d.setMonth(d.getMonth() - 1); } return out.join(''); };
const pctTxt = (x) => (x == null ? '—' : `${x}%`);

async function marginSection(el, canWrite, month = prevMonth()) {
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let r;
  try { r = await api(`/v1/finance/energy?month=${month}`); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const cur = Object.keys(r.totals)[0];
  const t = cur ? r.totals[cur] : { revenue: 0, energyCost: 0, margin: 0, kwh: 0, unknownSites: 0 };
  const reload = (m = month) => marginSection(el, canWrite, m);
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Month', `<select data-mm>${monthOptions(month)}</select>`)}</div>
    ${t.unknownSites ? callout('info', `${t.unknownSites} site${t.unknownSites === 1 ? ' has' : 's have'} no energy cost for ${esc(month)}: record the bill, or set the cost per kWh for an estimate.`) : ''}
    <div class="grid k4">${kpi('Energy delivered', esc(`${fmt.num(Math.round(t.kwh))} kWh`), '')}${kpi('Revenue', esc(fmt.money(t.revenue, cur)), 'before tax')}${kpi('Energy cost', esc(fmt.money(t.energyCost, cur)), 'bills and estimates')}${kpi('Margin', esc(fmt.money(t.margin, cur)), t.revenue ? `${Math.round((t.margin / t.revenue) * 100)}% of revenue` : '', t.margin < 0 ? 'crit' : '')}</div>
    <div class="card section"><header><h3>By site</h3></header><div data-ms></div></div>
    <p class="cell-sub">Revenue is what drivers paid before tax. The energy cost is the month's electricity bill when recorded, else the site's cost per kWh × the kWh delivered (an estimate). Losses compare the kWh billed with the kWh delivered to cars.</p>`;
  table($('[data-ms]', el), {
    columns: [
      { label: 'Site', render: (x) => `${esc(x.site)}<div class="cell-sub">${esc(fmt.num(x.sessions))} sessions · ${esc(fmt.num(Math.round(x.kwh)))} kWh</div>` },
      { label: 'Revenue', num: true, render: (x) => esc(fmt.money(x.revenue, x.currency)) },
      { label: 'Energy cost', num: true, render: (x) => (x.energyCost == null ? tag('t-warn', 'unknown') : `${esc(fmt.money(x.energyCost, x.currency))}<div class="cell-sub">${x.source === 'bill' ? 'bill' : `estimate at ${esc(fmt.money(x.ratePerKwh, x.currency))}/kWh`}${x.costPerKwh != null ? ` · ${esc(fmt.money(x.costPerKwh, x.currency))}/kWh` : ''}</div>`) },
      { label: 'Losses', num: true, render: (x) => (x.lossPct == null ? '<span class="cell-sub">—</span>' : x.lossPct > 10 ? tag('t-warn', pctTxt(x.lossPct)) : esc(pctTxt(x.lossPct))) },
      { label: 'Margin', num: true, render: (x) => (x.margin == null ? '<span class="cell-sub">—</span>' : `<b style="color:${x.margin < 0 ? 'var(--crit)' : 'inherit'}">${esc(fmt.money(x.margin, x.currency))}</b><div class="cell-sub">${esc(pctTxt(x.marginPct))}</div>`) },
      { label: '', render: (x) => (canWrite ? `<div class="row nowrap" style="gap:6px"><button class="btn sm${x.bill ? '' : ' primary'}" type="button" data-bill="${esc(x.siteId)}">${x.bill ? 'Bill' : 'Record bill'}</button><button class="btn sm" type="button" data-rate="${esc(x.siteId)}">Cost/kWh</button></div>` : '') },
    ],
    rows: r.sites, empty: 'No sites.',
  });
  $('[data-mm]', el).addEventListener('change', (e) => reload(e.target.value));
  $('[data-ms]', el).addEventListener('click', (e) => {
    const bb = e.target.closest('[data-bill]'), rb = e.target.closest('[data-rate]');
    if (!bb && !rb) return;
    const x = r.sites.find((s) => s.siteId === (bb ?? rb).dataset[bb ? 'bill' : 'rate']);
    if (rb) {
      modal({ title: `Electricity cost per kWh — ${x.site}`, subtitle: 'Taxes included; used for months without a bill',
        body: `<div class="form one">${field(`Per kWh (${esc(x.currency)})`, `<input name="rate" inputmode="decimal" value="${esc(x.ratePerKwh ?? '')}">`)}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(ctx) {
          try { await api(`/v1/finance/sites/${x.siteId}/energy-rate`, { method: 'PUT', body: { ratePerKwh: Number($('[name="rate"]', ctx.body).value.replace(',', '.')) } }); toast('Saved.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
        } }] });
      return;
    }
    if (x.bill) {
      modal({ title: `Electricity bill — ${x.site} — ${month}`, subtitle: `${fmt.money(x.bill.amount, x.currency)}${x.bill.kwhBilled != null ? ` · ${x.bill.kwhBilled} kWh` : ''}`,
        body: `<p class="cell-sub">${esc(x.bill.reference ?? '')} ${esc(x.bill.note ?? '')} · recorded by ${esc(x.bill.recordedBy ?? '')}</p><div class="form one">${field('Void it (why)', '<input name="why" maxlength="300">')}</div>`,
        actions: [{ label: 'Close' }, { label: 'Void', kind: 'danger', async onClick(ctx) {
          try { await api(`/v1/finance/energy-bills/${x.bill.id}/void`, { method: 'POST', body: { reason: $('[name="why"]', ctx.body).value.trim() } }); toast('Voided.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
        } }] });
      return;
    }
    modal({ title: `Record the electricity bill — ${x.site}`, subtitle: month,
      body: `<div class="form">${field(`Amount (${esc(x.currency)}, taxes included)`, '<input name="amount" inputmode="numeric">')}${field('kWh billed', '<input name="kwh" inputmode="decimal">', { opt: true })}${field('Bill reference', '<input name="ref" maxlength="80">', { opt: true })}${field('Note', '<input name="note" maxlength="300">', { opt: true })}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', async onClick(ctx) {
        const v = (n) => $(`[name="${n}"]`, ctx.body).value.trim();
        try { await api(`/v1/finance/sites/${x.siteId}/energy-bills`, { method: 'POST', body: { month, amount: Number(v('amount').replace(/\D/g, '')), kwhBilled: v('kwh') ? Number(v('kwh').replace(',', '.')) : undefined, reference: v('ref') || undefined, note: v('note') || undefined } }); toast('Recorded.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
      } }] });
  });
}

async function budgetsSection(host, canWrite, month = prevMonth()) {
  // A fresh element per render: the click handler below must not pile up on the tab body across reloads.
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let r;
  try { r = await api(`/v1/finance/budgets?month=${month}`); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = (m = month) => budgetsSection(host, canWrite, m);
  const LBL = { revenue: 'Revenue', energyCost: 'Energy cost', fees: 'Gateway fees', ownerShare: 'Owners\' share' };
  const good = (k, v) => (k === 'revenue' ? v >= 0 : v <= 0);
  const cellOf = (k, l, cur) => (l.actual == null ? '<span class="cell-sub">—</span>'
    : `${esc(fmt.money(l.actual, cur))}<div class="cell-sub">${l.budget ? `of ${esc(fmt.money(l.budget, cur))} · <span style="color:${good(k, l.variance?.amount ?? 0) ? 'var(--ok)' : 'var(--crit)'}">${l.variance ? `${l.variance.amount >= 0 ? '+' : ''}${esc(String(l.variance.pct))}%` : ''}</span>` : 'no budget'}</div>`);
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Month', `<select data-bm>${monthOptions(month)}</select>`)}
      ${canWrite ? `<div class="row" style="align-self:flex-end;gap:6px"><button class="btn" type="button" data-bcopy>Copy to the next 12 months</button></div>` : ''}</div>
    <div class="card"><header><h3>Organisation</h3></header><div data-bo></div></div>
    <div class="card section"><header><h3>Sites</h3></header><div data-bs></div></div>
    <p class="cell-sub">From the 7th of the month, revenue below or energy cost above the budget so far by more than ${esc(String(r.alertPct))}% raises an alert (route <span class="mono">finance.budget_off_track</span>).</p>`;
  const lineCols = (keys) => keys.map((k) => ({ label: LBL[k], num: true, render: (x) => cellOf(k, x.lines[k], x.currency) }));
  const edit = (x, siteLevel) => (canWrite ? [{ label: '', render: (y) => `<button class="btn sm" type="button" data-bedit="${esc(siteLevel ? y.siteId : `org:${y.currency}`)}">${y.budgeted ? 'Edit' : 'Set budget'}</button>` }] : []);
  table($('[data-bo]', el), { columns: [{ label: 'Currency', render: (x) => esc(x.currency) }, ...lineCols(['revenue', 'energyCost', 'fees', 'ownerShare']), ...edit(null, false)], rows: r.organisation, empty: 'No activity this month.' });
  table($('[data-bs]', el), { columns: [{ label: 'Site', render: (x) => `${esc(x.site)}${x.estimated ? '<div class="cell-sub">energy estimated</div>' : ''}` }, ...lineCols(['revenue', 'energyCost']), ...edit(null, true)], rows: r.sites, empty: 'No sites.' });
  $('[data-bm]', el).addEventListener('change', (e) => reload(e.target.value));
  $('[data-bcopy]', el)?.addEventListener('click', async () => {
    try { const x = await api('/v1/finance/budgets/copy', { method: 'POST', body: { from: month, months: 12 } }); toast(`Copied ${x.copied} budget lines.`, 'ok'); } catch (err) { toast(err.message, 'crit'); }
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bedit]');
    if (!b) return;
    const key = b.dataset.bedit, org = key.startsWith('org:');
    const x = org ? r.organisation.find((o) => o.currency === key.slice(4)) : r.sites.find((s) => s.siteId === key);
    const keys = org ? ['revenue', 'energyCost', 'fees', 'ownerShare'] : ['revenue', 'energyCost'];
    modal({ title: `Budget for ${month} — ${org ? 'organisation' : x.site}`, subtitle: x.currency,
      body: `<div class="form">${keys.map((k) => field(LBL[k], `<input name="${k}" inputmode="numeric" value="${esc(String(x.lines[k].budget || ''))}">`)).join('')}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(ctx) {
        const body = { month, ...(org ? { currency: x.currency } : { siteId: x.siteId }) };
        for (const k of keys) body[k] = Number($(`[name="${k}"]`, ctx.body).value.replace(/\D/g, '') || 0);
        try { await api('/v1/finance/budgets', { method: 'PUT', body }); toast('Saved.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
      } }] });
  });
}

async function collectionsSection(host, canWrite) {
  // A fresh element per render: the click handler below must not pile up on the tab body across reloads.
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let r;
  try { r = await api('/v1/finance/collections'); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = () => collectionsSection(host, canWrite);
  const me = state.me?.user?.id;
  const cur = Object.keys(r.aging)[0];
  const ag = cur ? r.aging[cur] : Object.fromEntries(r.buckets.map((b) => [b, 0]));
  const BL = { current: 'Not due yet', '1-30': '1–30 days', '31-60': '31–60 days', '61-90': '61–90 days', '90+': 'Over 90 days' };
  const d = r.dunning;
  el.innerHTML = `<div class="grid k4">${r.buckets.map((b) => kpi(BL[b], esc(fmt.money(ag[b] ?? 0, cur)), '', b === '90+' && ag[b] ? 'crit' : b !== 'current' && ag[b] ? 'warn' : '')).join('')}</div>
    ${r.writeOffsPending.length ? `<div class="card section"><header><h3>Write-offs waiting for approval</h3></header><div data-wo></div></div>` : ''}
    <div class="card section"><header><h3>Outstanding</h3></header><div data-cr></div></div>
    <div class="card section"><header><h3>Reminders</h3>${canWrite ? '<button class="btn sm right" type="button" data-dset>Settings</button>' : ''}</header><div class="body">
      ${d.enabled ? `Automatic reminders <b>on</b>: ${esc(d.steps.map((x) => (x < 0 ? `${-x} days before` : x === 0 ? 'on the due date' : `${x} days after`)).join(', '))}, by ${esc(d.channels.join(' and '))}. A promise to pay pauses them until its date.` : 'Automatic reminders are off. You can send one at any time.'}</div></div>
    ${r.writtenOff.length ? `<div class="card section"><header><h3>Written off</h3></header><div data-wf></div></div>` : ''}`;
  if (r.writeOffsPending.length) table($('[data-wo]', el), { columns: [
    { label: 'Requested', render: (w) => `${esc(fmt.time(w.requestedAt))}<div class="cell-sub">${esc(w.requestedBy ?? '')}</div>` },
    { label: 'Amount', num: true, render: (w) => `<b>${esc(fmt.money(w.amount, w.currency))}</b>` },
    { label: 'Reason', render: (w) => `<span class="cell-sub wrap">${esc(w.reason)}</span>` },
    { label: '', render: (w) => (!canWrite ? '' : w.requestedById === me ? '<span class="cell-sub">needs another person</span>' : w.firstApprovedBy === me ? `${tag('t-info', '1 of 2 approved')} <span class="cell-sub">needs a second approver</span>` : `<div class="row nowrap" style="gap:6px">${w.firstApprovedBy ? tag('t-info', '1 of 2 approved') : ''}<button class="btn sm primary" type="button" data-woa="${esc(w.id)}">Approve</button><button class="btn sm" type="button" data-wor="${esc(w.id)}">Reject</button></div>`) },
  ], rows: r.writeOffsPending, empty: '' });
  table($('[data-cr]', el), { columns: [
    { label: 'Document', render: (x) => `<span class="mono">${esc(x.number)}</span><div class="cell-sub">${esc(x.counterparty)}</div>` },
    { label: 'Outstanding', num: true, render: (x) => `<b>${esc(fmt.money(x.outstanding, x.currency))}</b>` },
    { label: 'Due', render: (x) => `${esc(x.dueDate)}<div>${x.daysPastDue > 0 ? tag(x.daysPastDue > 60 ? 't-crit' : 't-warn', `${x.daysPastDue} days late`) : tag('t-mute', 'not due')}</div>` },
    { label: 'Last', render: (x) => `${x.lastNote ? `<div class="cell-sub wrap">${esc(x.lastNote.note)}${x.lastNote.promiseDate ? ` · promised ${esc(x.lastNote.promiseDate)}` : ''}</div>` : ''}${x.lastReminder ? `<div class="cell-sub">${x.lastReminder.ok ? 'reminded' : 'reminder failed'} ${esc(fmt.ago(x.lastReminder.at))} (${esc(x.lastReminder.channel)})</div>` : ''}${x.writeOff ? tag('t-info', 'write-off waiting') : ''}` },
    { label: '', render: (x) => (canWrite ? `<div class="row nowrap" style="gap:6px"><button class="btn sm" type="button" data-cnote="${esc(x.kind)}|${esc(x.ref)}">Note</button><button class="btn sm" type="button" data-crem="${esc(x.kind)}|${esc(x.ref)}">Remind</button>${x.writeOff ? '' : `<button class="btn sm" type="button" data-cwo="${esc(x.kind)}|${esc(x.ref)}">Write off</button>`}</div>` : '') },
  ], rows: r.receivables, empty: 'Nothing outstanding.' });
  if (r.writtenOff.length) table($('[data-wf]', el), { columns: [
    { label: 'Document', render: (x) => `<span class="mono">${esc(x.number)}</span><div class="cell-sub">${esc(x.counterparty)}</div>` },
    { label: 'Written off', num: true, render: (x) => esc(fmt.money(x.writeOff.amount, x.currency)) },
    { label: 'Reason', render: (x) => `<span class="cell-sub wrap">${esc(x.writeOff.reason)}</span>` },
  ], rows: r.writtenOff, empty: '' });
  const rowOf = (v) => { const [k, ref] = v.split('|'); return r.receivables.find((x) => x.kind === k && x.ref === ref); };
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-cnote],[data-crem],[data-cwo],[data-woa],[data-wor],[data-dset]');
    if (!t) return;
    if (t.dataset.dset !== undefined) {
      modal({ title: 'Payment reminders', body: `<div class="form one"><label class="check"><input type="checkbox" name="on"${d.enabled ? ' checked' : ''}><span>Send reminders automatically</span></label>
          ${field('Steps (days from the due date)', `<input name="steps" value="${esc(d.steps.join(', '))}">`, { help: '-3 is three days before; 7 is a week late. The latest step reached is sent once.' })}
          <label class="check"><input type="checkbox" name="em"${d.channels.includes('email') ? ' checked' : ''}><span>E-mail (the billing address)</span></label>
          <label class="check"><input type="checkbox" name="wa"${d.channels.includes('whatsapp') ? ' checked' : ''}><span>WhatsApp (the account's phone)</span></label>
          ${field('WhatsApp template', `<div class="row" style="gap:6px"><input name="tn" placeholder="payment_reminder" value="${esc(d.whatsappTemplate?.name ?? '')}" style="flex:1"><input name="tl" placeholder="id" value="${esc(d.whatsappTemplate?.lang ?? '')}" style="width:80px"></div>`, { opt: true, help: 'An approved template with three parameters: the customer, the document and amount, the due date.' })}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(ctx) {
          const v = (n) => $(`[name="${n}"]`, ctx.body);
          const channels = [v('em').checked && 'email', v('wa').checked && 'whatsapp'].filter(Boolean);
          try { await api('/v1/finance/collections/settings', { method: 'PUT', body: { enabled: v('on').checked, steps: v('steps').value, channels, whatsappTemplate: v('tn').value.trim() ? { name: v('tn').value.trim(), lang: v('tl').value.trim() } : null } }); toast('Saved.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
        } }] });
      return;
    }
    if (t.dataset.woa || t.dataset.wor) {
      const id = t.dataset.woa ?? t.dataset.wor, ok = Boolean(t.dataset.woa);
      modal({ title: ok ? 'Approve the write-off' : 'Reject the write-off', body: `<div class="form one">${field(ok ? 'Note' : 'Reason', '<input name="n" maxlength="300">', { opt: ok })}</div>`,
        actions: [{ label: 'Cancel' }, { label: ok ? 'Approve' : 'Reject', kind: ok ? 'primary' : 'danger', async onClick(ctx) {
          try { const x = await api(`/v1/finance/write-offs/${id}/${ok ? 'approve' : 'reject'}`, { method: 'POST', body: { note: $('[name="n"]', ctx.body).value.trim() || undefined } }); toast(x.firstApproval ? 'First approval recorded: a second approver completes it.' : ok ? 'Written off.' : 'Rejected.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
        } }] });
      return;
    }
    const x = rowOf(t.dataset.cnote ?? t.dataset.crem ?? t.dataset.cwo);
    if (t.dataset.cnote) {
      modal({ title: `Note — ${x.number}`, subtitle: x.counterparty, body: `<div class="form one">${field('Note', '<input name="n" maxlength="500">')}${field('Promised to pay by', '<input name="p" type="date">', { opt: true })}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', async onClick(ctx) {
          try { await api(`/v1/finance/collections/${x.kind}/${x.ref}/notes`, { method: 'POST', body: { note: $('[name="n"]', ctx.body).value.trim(), promiseDate: $('[name="p"]', ctx.body).value || undefined } }); toast('Added.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
        } }] });
    } else if (t.dataset.crem) {
      modal({ title: `Send a reminder — ${x.number}`, subtitle: `${fmt.money(x.outstanding, x.currency)} · ${x.counterparty}`,
        body: `<div class="form one">${field('Channel', '<select name="c"><option value="email">E-mail</option><option value="whatsapp">WhatsApp</option></select>')}${field('To', `<input name="to" placeholder="${esc(x.email ?? 'billing e-mail')}">`, { opt: true, help: 'Leave empty for the address on file.' })}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Send', kind: 'primary', async onClick(ctx) {
          try { const res = await api(`/v1/finance/collections/${x.kind}/${x.ref}/remind`, { method: 'POST', body: { channel: $('[name="c"]', ctx.body).value, to: $('[name="to"]', ctx.body).value.trim() || undefined } }); toast(`Sent to ${res.destination}.`, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
        } }] });
    } else {
      modal({ title: `Write off — ${x.number}`, subtitle: `${fmt.money(x.outstanding, x.currency)} outstanding · ${x.counterparty}`,
        body: `${callout('info', 'A second person approves it. The invoice is not changed: your accountant books the bad debt.')}<div class="form one">${field('Amount', `<input name="a" inputmode="numeric" value="${esc(String(x.outstanding))}">`)}${field('Reason', '<input name="r" maxlength="300">')}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Ask for approval', kind: 'primary', async onClick(ctx) {
          try { await api(`/v1/finance/collections/${x.kind}/${x.ref}/write-off`, { method: 'POST', body: { amount: Number($('[name="a"]', ctx.body).value.replace(/\D/g, '')), reason: $('[name="r"]', ctx.body).value.trim() } }); toast('Waiting for a second person.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
        } }] });
    }
  });
}

// ─────────────────────────────────────────── (v1.21.0) summary, currencies, approvals, report e-mails

/** A small trend line (no axes), in the accent colour; a dashed zero line when the series crosses it. */
function spark(values, w = 140, h = 34) {
  const v = values.map((x) => Number(x) || 0);
  if (v.length < 2) return '';
  const lo = Math.min(0, ...v), hi = Math.max(...v, lo + 1);
  const x = (i) => (i * (w - 4)) / (v.length - 1) + 2, y = (n) => h - 2 - ((n - lo) * (h - 4)) / (hi - lo);
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${lo < 0 ? `<line x1="0" x2="${w}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="var(--line)" stroke-dasharray="3 3"/>` : ''}<polyline points="${v.map((n, i) => `${x(i).toFixed(1)},${y(n).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.5"/></svg>`;
}
const deltaTxt = (p, invert = false) => (p == null ? '<span class="cell-sub">—</span>' : `<span style="color:${(invert ? p <= 0 : p >= 0) ? 'var(--ok)' : 'var(--crit)'}">${p >= 0 ? '+' : ''}${esc(String(p))}%</span>`);

async function summarySection(el) {
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let s;
  try { s = await api('/v1/finance/summary'); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const c = s.consolidated;
  el.innerHTML = `${c ? `<div class="card" style="margin-bottom:16px"><header><h3>Consolidated in ${esc(c.currency)}</h3></header><div class="body"><div class="grid k3">
      ${kpi('Revenue this month', esc(fmt.money(c.revenueMtd.amount, c.currency)), c.revenueMtd.missing.length ? `no rate for ${esc(c.revenueMtd.missing.join(', '))}` : 'all currencies')}
      ${kpi('Margin this month', esc(fmt.money(c.marginMtd.amount, c.currency)), c.marginMtd.missing.length ? `no rate for ${esc(c.marginMtd.missing.join(', '))}` : '')}
      ${kpi('Owed by customers', esc(fmt.money(c.receivables.amount, c.currency)), c.receivables.missing.length ? `no rate for ${esc(c.receivables.missing.join(', '))}` : '')}</div></div></div>` : ''}
    ${s.perCurrency.map((p) => `<div class="card section"><header><h3>${esc(p.currency)}</h3><span class="cell-sub">${esc(s.month)}-01 to ${esc(s.asOf)}</span></header><div class="body">
      <div class="grid k4">
        ${kpi('Revenue this month', esc(fmt.money(p.revenue.mtd, p.currency)), `${deltaTxt(p.revenue.vsLastMonthPct)} vs last month · ${deltaTxt(p.revenue.vsLastYearPct)} vs last year`)}
        ${kpi('Margin', p.margin ? esc(fmt.money(p.margin.mtd, p.currency)) : '—', p.margin ? `${p.margin.pct == null ? '' : `${esc(String(p.margin.pct))}% of revenue`}${p.margin.unknownSites ? ` · ${p.margin.unknownSites} site(s) without energy cost` : ''}` : '', p.margin && p.margin.mtd < 0 ? 'crit' : '')}
        ${kpi('Owed by customers', esc(fmt.money(p.receivables, p.currency)), p.dso == null ? 'DSO —' : `DSO ${esc(String(p.dso))} days`, p.dso != null && p.dso > 45 ? 'warn' : '')}
        ${kpi('Cash', esc(fmt.money(p.cash.gateways + (p.cash.bank ?? 0), p.currency)), `gateways${p.cash.bank != null ? ` + bank (${esc(p.cash.bankAsOf)})` : ''}`)}
      </div>
      <div class="row" style="gap:24px;margin-top:14px;flex-wrap:wrap">
        <div><div class="cell-sub">Revenue, 12 months</div>${spark(p.trend.map((t) => t.revenue))}</div>
        <div><div class="cell-sub">Margin, 12 months</div>${spark(p.trend.map((t) => t.margin))}</div>
        <div><div class="cell-sub">Fee rate (30 days)</div><b>${p.feeRatePct == null ? '—' : `${esc(String(p.feeRatePct))}%`}</b></div>
        <div><div class="cell-sub">Refund rate (30 days)</div><b>${p.refundRatePct == null ? '—' : `${esc(String(p.refundRatePct))}%`}</b></div>
        <div><div class="cell-sub">Energy this month</div><b>${esc(fmt.num(Math.round(p.kwhMtd)))} kWh</b></div>
      </div></div></div>`).join('') || callout('info', 'No charging, receivables or payments yet.')}
    <p class="cell-sub">Revenue is before tax. DSO (days sales outstanding) is what customers owe ÷ the last 90 days' revenue per day. Margin uses energy bills, or estimates from each site's cost per kWh.</p>`;
}

const KIND_LBL = { refund: 'Refunds', payout: 'Owner payouts', write_off: 'Write-offs', bank_change: 'Owner bank detail changes', supplier_bill: 'Supplier bills', purchase_order: 'Purchase orders', journal_entry: 'Manual journal entries', expense_claim: 'Expense claims', payroll_run: 'Payroll runs' };

async function phase10Settings(el, canWrite) {
  let fxr, ar, rs;
  try { [fxr, ar, rs] = await Promise.all([api('/v1/finance/fx-rates'), api('/v1/finance/approval-rules'), api('/v1/finance/report-schedules')]); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = () => phase10Settings(el, canWrite);
  const rc = fxr.reportingCurrency;
  const cm = new Intl.DateTimeFormat('en-CA').format(new Date()).slice(0, 7);
  const others = fxr.currencies.filter((c) => c !== rc);
  el.innerHTML = `
    <div class="card section"><header><h3>Currencies</h3></header><div class="body">
      <p class="cell-sub" style="margin-top:0">Your sites use ${esc(fxr.currencies.join(', ') || '—')}. With a reporting currency, Summary, Margin and Budgets also show totals converted at each month's rate.</p>
      <div class="filters" style="margin-top:0">${field('Reporting currency', `<select data-rcur${canWrite ? '' : ' disabled'}><option value="">— none —</option>${[...new Set([...fxr.currencies, ...Object.keys(CURRENCIES)])].map((c) => `<option${c === rc ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>`)}
      ${rc && others.length && canWrite ? `<div class="row" style="align-self:flex-end;gap:6px"><button class="btn" type="button" data-fxfetch>Fetch ECB rates for ${esc(cm)}</button><button class="btn" type="button" data-fxadd>Enter a rate</button></div>` : ''}</div>
      ${rc ? `<div data-fxl></div>` : ''}</div></div>
    <div class="card section"><header><h3>Approvals</h3>${ar.canApprove ? '' : '<span class="cell-sub">changing these needs a Finance Manager (finance:approve)</span>'}</header><div class="body">
      <p class="cell-sub" style="margin-top:0">Every transfer, write-off and bank detail change already needs a second person. Above an amount you can require a Finance Manager (finance:approve), or two approvers.</p>
      <table class="table" data-rules><thead><tr><th>What</th><th>Rule</th><th class="num">Above (minor unit)</th></tr></thead><tbody>
      ${Object.keys(KIND_LBL).map((k) => { const r = ar.rules[k] ?? {}; const dis = ar.canApprove && canWrite ? '' : ' disabled'; return `<tr data-k="${k}"><td>${KIND_LBL[k]}</td><td><select name="rule"${dis}><option value="">Second person only</option><option value="finance_approver"${r.rule === 'finance_approver' ? ' selected' : ''}>A Finance Manager</option><option value="two_approvers"${r.rule === 'two_approvers' ? ' selected' : ''}>Two approvers</option></select></td><td class="num">${k === 'bank_change' ? '<span class="cell-sub">every change</span>' : `<input name="above" inputmode="numeric" value="${esc(String(r.above ?? ''))}" style="width:130px"${dis}>`}</td></tr>`; }).join('')}
      </tbody></table>
      ${ar.canApprove && canWrite ? '<div class="row" style="margin-top:10px"><button class="btn primary" type="button" data-rsave>Save approvals</button></div>' : ''}</div></div>
    <div class="card section"><header><h3>Report e-mails</h3>${canWrite ? '<button class="btn sm right" type="button" data-rnew>New schedule</button>' : ''}</header><div data-rl></div></div>`;
  if (rc) table($('[data-fxl]', el), { columns: [
    { label: 'Month', render: (r) => esc(r.month) }, { label: 'Currency', render: (r) => `1 ${esc(r.currency)}` },
    { label: `In ${esc(rc)}`, num: true, render: (r) => esc(String(r.rate)) }, { label: 'Source', render: (r) => `${tag(r.source === 'ecb' ? 't-info' : 't-mute', r.source === 'ecb' ? 'ECB' : 'manual')}<div class="cell-sub">${esc(r.by ?? '')}</div>` },
  ], rows: fxr.rates, empty: others.length ? 'No rates yet: fetch them or enter them.' : `All your sites use ${rc}.` });
  table($('[data-rl]', el), { columns: [
    { label: 'Schedule', render: (r) => `${esc(r.name)}<div class="cell-sub">${esc(r.reports.join(', '))}</div>` },
    { label: 'When', render: (r) => esc(r.frequency === 'weekly' ? `weekly, ${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][r.weekday]}` : 'monthly, on the 1st') },
    { label: 'To', render: (r) => `<span class="cell-sub wrap">${esc(r.recipients.join(', '))}</span>` },
    { label: 'Last', render: (r) => (r.lastError ? `<span style="color:var(--crit)" class="cell-sub">${esc(r.lastError)}</span>` : r.lastSentAt ? `<span class="cell-sub">${esc(fmt.ago(r.lastSentAt))}</span>` : '<span class="cell-sub">not sent yet</span>') },
    { label: '', render: (r) => (canWrite ? `<div class="row nowrap" style="gap:6px"><button class="btn sm" type="button" data-rsend="${esc(r.id)}">Send now</button><button class="btn sm" type="button" data-rdel="${esc(r.id)}">Remove</button></div>` : '') },
  ], rows: rs.schedules, empty: 'No report e-mails yet. The monthly close e-mail is set above.' });
  $('[data-rcur]', el)?.addEventListener('change', async (e) => {
    try { await api('/v1/finance/fx-rates/reporting-currency', { method: 'PUT', body: { currency: e.target.value || null } }); toast('Saved.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); }
  });
  $('[data-fxfetch]', el)?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { const r = await api('/v1/finance/fx-rates/fetch', { method: 'POST', body: { month: cm } }); toast(`Fetched ${r.rates.map((x) => `${x.currency} ${x.rate}`).join(', ')}${r.failed.length ? `; not ${r.failed.map((x) => x.currency).join(', ')}` : ''}.`, r.failed.length ? 'warn' : 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); e.currentTarget.disabled = false; }
  });
  $('[data-fxadd]', el)?.addEventListener('click', () => modal({ title: 'Enter an exchange rate', subtitle: `Into ${rc}`,
    body: `<div class="form">${field('Month', `<input name="m" type="month" value="${cm}">`)}${field('Currency', `<select name="c">${others.map((c) => `<option>${esc(c)}</option>`).join('')}</select>`)}${field(`1 unit in ${esc(rc)}`, '<input name="r" inputmode="decimal">')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(ctx) {
      const v = (n) => $(`[name="${n}"]`, ctx.body).value.trim();
      try { await api('/v1/finance/fx-rates', { method: 'PUT', body: { month: v('m'), currency: v('c'), rate: Number(v('r').replace(',', '.')) } }); toast('Saved.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] }));
  $('[data-rsave]', el)?.addEventListener('click', async () => {
    const rules = {};
    for (const tr of $$('[data-rules] tbody tr', el)) {
      const rule = $('[name="rule"]', tr).value;
      if (!rule) continue;
      rules[tr.dataset.k] = { rule, above: Number(($('[name="above"]', tr)?.value ?? '0').replace(/\D/g, '') || 0) };
    }
    try { await api('/v1/finance/approval-rules', { method: 'PUT', body: { rules } }); toast('Approvals saved.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); }
  });
  $('[data-rnew]', el)?.addEventListener('click', () => modal({ title: 'New report e-mail', size: 'lg',
    body: `<div class="form">${field('Name', '<input name="n" maxlength="80" value="Finance weekly">')}${field('When', '<select name="f"><option value="weekly">Weekly</option><option value="monthly">Monthly (on the 1st, last month)</option></select>')}
      ${field('Weekday', `<select name="w">${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d, i) => `<option value="${i + 1}">${d}</option>`).join('')}</select>`)}
      ${field('Recipients', '<input name="to" placeholder="cfo@yourcompany.co.id, accountant@firm.co.id">')}</div>
      <div class="row" style="gap:14px;flex-wrap:wrap;margin-top:8px">${rs.reports.map((r) => `<label class="check"><input type="checkbox" name="rep" value="${esc(r)}"${r === 'summary' || r === 'collections' ? ' checked' : ''}><span>${esc(r)}</span></label>`).join('')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Create', kind: 'primary', async onClick(ctx) {
      const v = (n) => $(`[name="${n}"]`, ctx.body).value.trim();
      try { await api('/v1/finance/report-schedules', { method: 'POST', body: { name: v('n'), frequency: v('f'), weekday: Number(v('w')), recipients: v('to'), reports: $$('[name="rep"]:checked', ctx.body).map((x) => x.value) } }); toast('Created.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] }));
  $('[data-rl]', el).addEventListener('click', async (e) => {
    const sb = e.target.closest('[data-rsend]'), db = e.target.closest('[data-rdel]');
    if (sb) { sb.disabled = true; try { const r = await api(`/v1/finance/report-schedules/${sb.dataset.rsend}/send`, { method: 'POST' }); toast(`Sent to ${r.to.join(', ')}.`, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); sb.disabled = false; } }
    if (db) { try { await api(`/v1/finance/report-schedules/${db.dataset.rdel}`, { method: 'PUT', body: { archived: true } }); toast('Removed.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); } }
  });
}

// ─────────────────────────────────────────── (v1.22.0) month lock, site investments, revenue drop alerts

async function closeSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let r;
  try { r = await api('/v1/finance/periods'); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const canApprove = state.can('finance:approve');
  const reload = () => closeSection(host, canWrite);
  el.innerHTML = `${callout('info', 'Lock a month once the accountant has closed it: its energy bills, exchange rates, budgets and site investments can then no longer be added, changed or voided. Reopening needs a Finance Manager (finance:approve) and a reason.')}
    <div class="card section"><header><h3>Months</h3></header><div data-pl></div></div>`;
  table($('[data-pl]', el), {
    columns: [
      { label: 'Month', render: (m) => `<b>${esc(m.month)}</b>` },
      { label: 'State', render: (m) => (m.locked ? `${tag('t-ok', 'locked')}<div class="cell-sub">${esc(m.lockedBy ?? '')} · ${esc(fmt.ago(m.lockedAt))}${m.note ? ` · ${esc(m.note)}` : ''}</div>` : m.lockable ? tag('t-mute', 'open') : '<span class="cell-sub">in progress</span>') },
      { label: 'History', render: (m) => (m.history.filter((h) => h.reopenedAt).length ? `<span class="cell-sub">${m.history.filter((h) => h.reopenedAt).map((h) => `reopened by ${esc(h.reopenedBy ?? '')} (${esc(h.reopenReason ?? '')})`).join('; ')}</span>` : '') },
      { label: '', render: (m) => (!canWrite || !m.lockable ? '' : m.locked ? (canApprove ? `<button class="btn sm" type="button" data-reopen="${m.month}">Reopen</button>` : '') : `<button class="btn sm primary" type="button" data-lock="${m.month}">Close &amp; lock…</button>`) },
    ],
    rows: r.months, empty: 'No months.',
  });
  el.addEventListener('click', async (e) => {
    const lb = e.target.closest('[data-lock]'), rb = e.target.closest('[data-reopen]');
    if (lb) {
      const month = lb.dataset.lock;
      let ck;
      try { ck = await api(`/v1/finance/periods/${month}/checklist`); } catch (err) { toast(err.message, 'crit'); return; }
      modal({ title: `Lock ${month}`, subtitle: ck.ready ? 'Everything is in' : 'Some things are still open',
        body: `<ul class="plain">${ck.items.map((i) => `<li>${tag(i.ok ? 't-ok' : 't-warn', i.ok ? 'done' : 'open')} ${esc(i.label)}${i.sites?.length ? `<div class="cell-sub">${i.sites.map((x) => esc(x.name)).join(', ')}</div>` : ''}</li>`).join('')}</ul>
          <div class="form one" style="margin-top:10px">${field('Note', '<input name="note" maxlength="300" placeholder="e.g. Closed with the accountant on 5 Nov">', { opt: true })}</div>`,
        actions: [{ label: 'Cancel' }, { label: ck.ready ? 'Lock' : 'Lock anyway', kind: 'primary', async onClick(ctx) {
          try { await api(`/v1/finance/periods/${month}/lock`, { method: 'POST', body: { note: $('[name="note"]', ctx.body).value.trim() || undefined } }); toast(`${month} locked.`, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
        } }] });
    }
    if (rb) {
      const month = rb.dataset.reopen;
      modal({ title: `Reopen ${month}`, body: `<div class="form one">${field('Why', '<input name="why" maxlength="300" placeholder="e.g. Late electricity bill">')}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Reopen', kind: 'danger', async onClick(ctx) {
          try { await api(`/v1/finance/periods/${month}/reopen`, { method: 'POST', body: { reason: $('[name="why"]', ctx.body).value.trim() } }); toast(`${month} reopened.`, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
        } }] });
    }
  });
}

const INV_CAT = { chargers: 'Chargers', installation: 'Installation', grid: 'Grid connection', other: 'Other' };
async function investmentsSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let r, sites;
  try { [r, sites] = await Promise.all([api('/v1/finance/investments'), api('/v1/finance/energy').then((x) => x.sites)]); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = () => investmentsSection(host, canWrite);
  const totals = Object.entries(r.totals);
  el.innerHTML = `${totals.length ? `<div class="grid k4">${totals.map(([c, t]) => `${kpi('Invested', esc(fmt.money(t.invested, c)), 'not voided')}${kpi('Net book value', esc(fmt.money(t.netBookValue, c)), 'after depreciation')}${kpi('Margin recovered', esc(fmt.money(t.recovered, c)), t.invested ? `${Math.round((t.recovered / t.invested) * 100)}% of invested` : '')}`).join('')}</div>` : ''}
    <div class="card section"${totals.length ? '' : ' style="margin-top:0"'}><header><h3>By site</h3>${canWrite ? '<button class="btn sm right primary" type="button" data-inew>Record an investment</button>' : ''}</header><div data-il></div></div>
    <p class="cell-sub">Depreciation is straight line from the month after the payment. The margin recovered is revenue − energy cost (Margin) since the first investment; the payback month is when it covered the investment, or when it will at the last 6 months' average margin. ROI: a year's margin at that average less a year's depreciation, ÷ invested.</p>`;
  table($('[data-il]', el), {
    columns: [
      { label: 'Site', render: (x) => `${esc(x.siteName)}<div class="cell-sub">since ${esc(x.since)} · ${Object.entries(x.byCategory).filter(([, v]) => v).map(([k, v]) => `${INV_CAT[k]} ${fmt.money(v, x.currency)}`).map(esc).join(' · ')}</div>` },
      { label: 'Invested', num: true, render: (x) => esc(fmt.money(x.invested, x.currency)) },
      { label: 'Book value', num: true, render: (x) => `${esc(fmt.money(x.depreciation.netBookValue, x.currency))}<div class="cell-sub">${esc(fmt.money(x.depreciation.perMonth, x.currency))}/month</div>` },
      { label: 'Recovered', num: true, render: (x) => `${esc(fmt.money(x.recovered.margin, x.currency))}<div class="cell-sub">${esc(pctTxt(x.recovered.pct))}${x.recovered.unknownCostMonths ? ` · ${x.recovered.unknownCostMonths} month(s) without energy cost` : ''}</div>` },
      { label: 'Payback', render: (x) => (x.payback ? `${x.payback.projected ? tag('t-info', `est. ${x.payback.month}`) : tag('t-ok', x.payback.month)}<div class="cell-sub">${x.payback.monthsFromStart} months</div>` : tag('t-warn', 'not at this margin')) },
      { label: 'ROI', num: true, render: (x) => esc(x.roiPct == null ? '—' : `${x.roiPct}%`) },
    ],
    rows: r.sites, empty: 'No investments recorded yet.',
    onRow: (x) => modal({ title: `Investments — ${x.siteName}`, size: 'lg',
      body: `<table class="table"><thead><tr><th>Paid</th><th>What</th><th class="num">Amount</th><th class="num">Months</th><th></th></tr></thead><tbody>${x.items.map((i) => `<tr><td>${esc(i.investedOn)}</td><td>${esc(INV_CAT[i.category])}<div class="cell-sub">${esc(i.description)}${i.reference ? ` · ${esc(i.reference)}` : ''}</div></td><td class="num">${esc(fmt.money(i.amount, i.currency))}</td><td class="num">${i.lifeMonths}</td><td>${canWrite ? `<button class="btn sm" type="button" data-ivoid="${esc(i.id)}">Void</button>` : ''}</td></tr>`).join('')}</tbody></table>`,
      onMount: (ctx) => $$('[data-ivoid]', ctx.el).forEach((b) => b.addEventListener('click', async () => {
        const reason = window.prompt('Why is this investment voided?');
        if (!reason || !reason.trim()) return;
        try { await api(`/v1/finance/investments/${b.dataset.ivoid}/void`, { method: 'POST', body: { reason: reason.trim() } }); toast('Voided.', 'ok'); ctx.close(); reload(); } catch (e) { toast(e.message, 'crit'); }
      })),
    }),
  });
  $('[data-inew]', el)?.addEventListener('click', () => modal({ title: 'Record an investment', subtitle: 'In the site\'s currency',
    body: `<div class="form">${field('Site', `<select name="site">${sites.map((x) => `<option value="${esc(x.siteId)}">${esc(x.site)} (${esc(x.currency)})</option>`).join('')}</select>`)}
      ${field('Category', `<select name="cat">${Object.entries(INV_CAT).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>`)}
      ${field('Description', '<input name="desc" maxlength="200" placeholder="2 × 60 kW DC">', { full: true })}
      ${field('Amount', '<input name="amount" inputmode="decimal">')}${field('Paid on', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}
      ${field('Depreciated over (months)', '<input name="life" type="number" min="1" max="360" value="96">')}${field('Reference', '<input name="ref" maxlength="80">', { opt: true })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', async onClick(ctx) {
      const v = (n) => $(`[name="${n}"]`, ctx.body).value.trim();
      const cur = sites.find((x) => x.siteId === v('site'))?.currency;
      try { await api('/v1/finance/investments', { method: 'POST', body: { siteId: v('site'), category: v('cat'), description: v('desc'), amount: toMinor(v('amount').replace(',', '.'), cur), investedOn: v('on'), lifeMonths: Number(v('life')), reference: v('ref') || undefined } }); toast('Recorded.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] }));
}

async function phase11Settings(el, canWrite) {
  let ra;
  try { ra = await api('/v1/finance/revenue-alerts'); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const st = ra.settings, dis = canWrite ? '' : ' disabled';
  el.innerHTML = `<div class="card section"><header><h3>Revenue drop alerts</h3></header><div class="body">
      <p class="cell-sub" style="margin-top:0">Each morning, every site's revenue yesterday is compared with the same weekday over the 4 weeks before; a fall by the threshold or more raises an alert (a charger down, a payment method failing, a tariff typed wrong). Sites with less than 3 of those weeks, or a baseline under the minimum, are not compared.</p>
      <div class="filters" style="margin-top:0"><label class="check" style="align-self:flex-end"><input type="checkbox" name="ra_on"${st.enabled ? ' checked' : ''}${dis}><span>Alert on revenue drops</span></label>
      ${field('Drop of at least (%)', `<input name="ra_pct" type="number" min="10" max="100" value="${st.dropPct}" style="width:90px"${dis}>`)}
      ${field('Minimum baseline (minor unit)', `<input name="ra_min" inputmode="numeric" value="${st.minBaseline}" style="width:140px"${dis}>`)}
      ${canWrite ? '<div class="row" style="align-self:flex-end"><button class="btn" type="button" data-rasave>Save</button></div>' : ''}</div>
      <div data-ral></div></div></div>`;
  table($('[data-ral]', el), { columns: [
    { label: 'Day', render: (a) => esc(fmt.date(a.day)) }, { label: 'Site', render: (a) => esc(a.site) },
    { label: 'Revenue', num: true, render: (a) => `${esc(fmt.money(a.revenue, a.currency))}<div class="cell-sub">usual ${esc(fmt.money(a.baseline, a.currency))}</div>` },
    { label: 'Drop', num: true, render: (a) => tag('t-warn', `−${a.dropPct}%`) },
  ], rows: ra.anomalies, empty: 'No drops in the last 90 days.' });
  $('[data-rasave]', el)?.addEventListener('click', async () => {
    try { await api('/v1/finance/revenue-alerts/settings', { method: 'PUT', body: { enabled: $('[name="ra_on"]', el).checked, dropPct: Number($('[name="ra_pct"]', el).value), minBaseline: Number($('[name="ra_min"]', el).value.replace(/\D/g, '') || 0) } }); toast('Saved.', 'ok'); phase11Settings(el, canWrite); } catch (e) { toast(e.message, 'crit'); }
  });
}

// ─────────────────────────────────────────── (v1.23.0) tax calendar, owner queries, site P&L, settlements

const TAX_ST = { filed: ['t-ok', 'filed'], overdue: ['t-crit', 'overdue'], due_soon: ['t-warn', 'due soon'], upcoming: ['t-mute', 'upcoming'] };
async function taxCalendarCard(el, canWrite, all = false) {
  let c;
  try { c = await api('/v1/finance/tax/calendar'); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = () => taxCalendarCard(el, canWrite, all);
  const st = c.settings;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  // What needs attention: not filed and due within 45 days (or overdue), or filed in the last 60 days.
  const shown = all ? c.items : c.items.filter((i) => (i.status !== 'filed' && i.daysLeft <= 45) || (i.status === 'filed' && i.daysLeft >= -60));
  const open = c.items.filter((i) => i.status !== 'filed');
  el.innerHTML = `<div class="card"><header><h3>Tax calendar</h3><span class="right cell-sub">${open.filter((i) => i.status === 'overdue').length} overdue · ${open.filter((i) => i.status === 'due_soon').length} due soon</span><button class="btn sm" type="button" data-tcall>${all ? 'Show what needs attention' : `Show all (${c.items.length})`}</button>${canWrite ? '<button class="btn sm" type="button" data-tcset>Settings</button>' : ''}</header>
    <div class="body cell-sub" style="padding-bottom:0">Each period's obligations, due on a day of the following month (a weekend moved to Monday; check public holidays). The amounts are what PlugSure recorded — your accountant files the returns. ${st.reminders ? `Reminders ${st.reminderDays} days before (alert finance.tax_due).` : 'Reminders are off.'}</div><div data-tcl></div></div>`;
  table($('[data-tcl]', el), {
    columns: [
      { label: 'Due', render: (i) => `<b>${esc(fmt.date(i.dueDate))}</b><div class="cell-sub">${i.status === 'filed' ? '' : i.daysLeft < 0 ? `${plural(-i.daysLeft, 'day')} ago` : i.daysLeft === 0 ? 'today' : `in ${plural(i.daysLeft, 'day')}`}</div>` },
      { label: 'Obligation', render: (i) => `${esc(i.label)}<div class="cell-sub">period ${esc(i.period)} · ${esc(i.detail)}</div>` },
      { label: 'Amount', num: true, render: (i) => (i.amount == null ? '<span class="cell-sub">—</span>' : esc(rp(i.amount))) },
      { label: 'Status', render: (i) => `${tag(...TAX_ST[i.status])}${i.filing ? `<div class="cell-sub">${esc(fmt.date(i.filing.filedOn))} · ${esc(i.filing.reference)}${i.filing.by ? ` · ${esc(i.filing.by)}` : ''}</div>` : ''}` },
      { label: '', render: (i) => (!canWrite ? '' : i.filing ? `<button class="btn sm" type="button" data-tcvoid="${esc(i.filing.id)}">Undo</button>` : `<button class="btn sm${i.status === 'overdue' || i.status === 'due_soon' ? ' primary' : ''}" type="button" data-tcfile="${esc(`${i.obligation}|${i.period}`)}">Mark filed</button>`) },
    ],
    rows: shown.slice().reverse(), empty: all ? 'No obligation enabled.' : 'Nothing due in the next 45 days.',
  });
  el.querySelector('[data-tcl]').addEventListener('click', (e) => {
    const fb = e.target.closest('[data-tcfile]'), vb = e.target.closest('[data-tcvoid]');
    if (fb) {
      const [obligation, period] = fb.dataset.tcfile.split('|');
      const it = c.items.find((x) => x.obligation === obligation && x.period === period);
      modal({ title: `${it.label} — ${period}`, subtitle: `Due ${fmt.date(it.dueDate)}`,
        body: `<div class="form">${field('Filed / paid on', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Reference (NTPN, BPE, receipt)', '<input name="ref" maxlength="80">')}
          ${field('Amount (Rp)', `<input name="amount" inputmode="numeric" value="${it.amount != null ? esc(String(it.amount)) : ''}">`, { opt: true })}${field('Note', '<input name="note" maxlength="300">', { opt: true })}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Mark filed', kind: 'primary', async onClick(ctx) {
          const v = (n) => $(`[name="${n}"]`, ctx.body).value.trim();
          try { await api('/v1/finance/tax/filings', { method: 'POST', body: { obligation, period, filedOn: v('on'), reference: v('ref'), amount: v('amount') ? Number(v('amount').replace(/\D/g, '')) : undefined, note: v('note') || undefined } }); toast('Marked filed.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
        } }] });
    }
    if (vb) {
      const reason = window.prompt('Why is this filing mark undone?');
      if (!reason || !reason.trim()) return;
      api(`/v1/finance/tax/filings/${vb.dataset.tcvoid}/void`, { method: 'POST', body: { reason: reason.trim() } }).then(() => { toast('Undone.', 'ok'); reload(); }, (err) => toast(err.message, 'crit'));
    }
  });
  $('[data-tcall]', el).addEventListener('click', () => taxCalendarCard(el, canWrite, !all));
  $('[data-tcset]', el)?.addEventListener('click', () => modal({ title: 'Tax calendar settings', subtitle: 'The due day in the month after the period (31 = its last day)', size: 'lg',
    body: `<table class="table"><thead><tr><th>Obligation</th><th>Track</th><th class="num">Due day</th></tr></thead><tbody>${Object.entries(c.labels).map(([k, label]) => `<tr data-k="${k}"><td>${esc(label)}</td><td><input type="checkbox" name="on"${st.obligations[k].enabled ? ' checked' : ''}></td><td class="num"><input name="day" type="number" min="1" max="31" value="${st.obligations[k].day}" style="width:80px"></td></tr>`).join('')}</tbody></table>
      <div class="filters"><label class="check" style="align-self:flex-end"><input type="checkbox" name="rem"${st.reminders ? ' checked' : ''}><span>Remind (alert finance.tax_due)</span></label>${field('Days before', `<input name="days" type="number" min="0" max="30" value="${st.reminderDays}" style="width:80px">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(ctx) {
      const obligations = Object.fromEntries($$('tbody tr', ctx.body).map((tr) => [tr.dataset.k, { enabled: $('[name="on"]', tr).checked, day: Number($('[name="day"]', tr).value) }]));
      try { await api('/v1/finance/tax/calendar/settings', { method: 'PUT', body: { obligations, reminders: $('[name="rem"]', ctx.body).checked, reminderDays: Number($('[name="days"]', ctx.body).value) } }); toast('Saved.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] }));
}

const OQ_ST = { open: ['t-warn', 'open'], rejected: ['t-mute', 'rejected'], resolved: ['t-ok', 'resolved'], adjusted: ['t-ok', 'adjusted'], withdrawn: ['t-mute', 'withdrawn'] };
async function ownerQueriesSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  let r;
  try { r = await api('/v1/finance/owner-queries'); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  if (!r.disputes.length && !r.pendingAdjustments.length) { el.innerHTML = ''; return; }
  const reload = () => ownerQueriesSection(host, canWrite);
  el.innerHTML = `<div class="card"><header><h3>Owner queries</h3><span class="right cell-sub">${r.open} open</span></header>
    ${r.pendingAdjustments.length ? `<div class="body cell-sub" style="padding-bottom:0">For the next statements: ${r.pendingAdjustments.map((p) => `${esc(p.owner)} ${esc(fmt.money(p.amount, p.currency))}`).join(' · ')}</div>` : ''}<div data-oql></div></div>`;
  table($('[data-oql]', el), {
    columns: [
      { label: 'Owner', render: (d) => `${esc(d.owner)}<div class="cell-sub mono">${esc(d.statementNumber)}</div>` },
      { label: 'Query', render: (d) => `${d.line ? `<b>${esc(d.line)}</b> · ` : ''}<span class="wrap">${esc(d.message)}</span><div class="cell-sub">${esc(fmt.ago(d.raisedAt))}${d.claimed != null ? ` · claims ${esc(fmt.money(d.claimed, d.currency))}` : ''}</div>` },
      { label: 'Answer', render: (d) => `${tag(...OQ_ST[d.state])}${d.answer ? `<div class="cell-sub wrap">${esc(d.answer)}</div>` : ''}${d.adjustment ? `<div class="cell-sub">${esc(fmt.money(d.adjustment.amount, d.currency))} · ${d.adjustment.applied ? `on ${esc(d.adjustment.appliedTo ?? '')}` : 'next statement'}</div>` : ''}` },
      { label: '', render: (d) => (canWrite && d.state === 'open' ? `<button class="btn sm primary" type="button" data-oqa="${esc(d.id)}">Answer</button>` : '') },
    ],
    rows: r.disputes, empty: '',
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-oqa]');
    if (!b) return;
    const d = r.disputes.find((x) => x.id === b.dataset.oqa);
    const exp = CURRENCIES[d.currency]?.exponent ?? 0;
    modal({ title: `Answer ${d.owner}`, subtitle: `Statement ${d.statementNumber}`, size: 'lg',
      body: `<p class="wrap">${d.line ? `<b>${esc(d.line)}</b>: ` : ''}${esc(d.message)}</p>
        <div class="form">${field('Decision', '<select name="dec"><option value="adjust">Adjust: add an amount to the next statement</option><option value="resolve">Resolve: explained, nothing to change</option><option value="reject">Reject: the statement stands</option></select>')}
        ${field(`Adjustment (${esc(d.currency)}; negative if the owner owes it back)`, `<input name="amount" inputmode="decimal" value="${d.claimed != null ? esc(String(d.claimed / 10 ** exp)) : ''}">`)}
        ${field('Answer the owner sees', '<textarea name="ans" rows="3" maxlength="2000"></textarea>', { full: true })}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Send answer', kind: 'primary', async onClick(ctx) {
        const v = (n) => $(`[name="${n}"]`, ctx.body).value.trim();
        const dec = v('dec');
        try { await api(`/v1/finance/owner-queries/${d.id}/answer`, { method: 'POST', body: { decision: dec, answer: v('ans'), amount: dec === 'adjust' ? Math.round(Number(v('amount').replace(',', '.')) * 10 ** exp) : undefined } }); toast('Answered.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
      } }] });
  });
}

const COST_CAT = { rent: 'Rent', maintenance: 'Maintenance', connectivity: 'Connectivity', insurance: 'Insurance', staff: 'Staff', other: 'Other' };
const COST_BASIS = { kwh: 'by kWh', sessions: 'by sessions', revenue: 'by revenue', equal: 'equally' };
async function pnlSection(host, canWrite, month = prevMonth()) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let p, c, sites;
  try { [p, c, sites] = await Promise.all([api(`/v1/finance/site-pnl?month=${month}`), api('/v1/finance/shared-costs'), api('/v1/finance/energy').then((x) => x.sites)]); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = (m = month) => pnlSection(host, canWrite, m);
  const totals = Object.entries(p.totals);
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Month', `<select data-pm>${monthOptions(month)}</select>`)}</div>
    ${totals.map(([cur, t]) => `<div class="grid k4">${kpi('Revenue', esc(fmt.money(t.revenue, cur)), 'before tax')}${kpi('Energy', esc(fmt.money(t.energyCost, cur)), 'bills and estimates')}${kpi('Shared costs', esc(fmt.money(t.shared, cur)), `+ depreciation ${fmt.money(t.depreciation, cur)}`)}${kpi('Contribution', esc(fmt.money(t.contribution, cur)), t.revenue ? `${Math.round((t.contribution / t.revenue) * 100)}% of revenue` : '', t.contribution < 0 ? 'crit' : '')}</div>`).join('')}
    ${p.unallocated.length ? callout('warn', `Not allocated (no site of their currency): ${p.unallocated.map((u) => esc(u.description)).join(', ')}.`) : ''}
    <div class="card section"><header><h3>By site</h3></header><div data-pl></div></div>
    <div class="card section"><header><h3>Shared costs</h3>${canWrite ? '<button class="btn sm right primary" type="button" data-cnew>Add a cost</button>' : ''}</header><div data-cl></div></div>
    <p class="cell-sub">A site's contribution: revenue − energy cost − its part of the shared costs − depreciation of its investments. Shared costs are spread over the sites each month by kWh, sessions, revenue or equally (equally when the sites had none that month).</p>`;
  table($('[data-pl]', el), {
    columns: [
      { label: 'Site', render: (x) => `${esc(x.site)}<div class="cell-sub">${esc(fmt.num(x.sessions))} sessions · ${esc(fmt.num(Math.round(x.kwh)))} kWh</div>` },
      { label: 'Revenue', num: true, render: (x) => esc(fmt.money(x.revenue, x.currency)) },
      { label: 'Energy', num: true, render: (x) => (x.energyCost == null ? tag('t-warn', 'unknown') : esc(fmt.money(x.energyCost, x.currency))) },
      { label: 'Shared', num: true, render: (x) => `${esc(fmt.money(x.sharedTotal, x.currency))}<div class="cell-sub">${Object.entries(x.shared).filter(([, v]) => v).map(([k, v]) => `${COST_CAT[k]} ${fmt.money(v, x.currency)}`).map(esc).join(' · ')}</div>` },
      { label: 'Depreciation', num: true, render: (x) => esc(fmt.money(x.depreciation, x.currency)) },
      { label: 'Contribution', num: true, render: (x) => `<b style="color:${x.contribution < 0 ? 'var(--crit)' : 'inherit'}">${esc(fmt.money(x.contribution, x.currency))}</b>` },
    ],
    rows: p.sites, empty: 'No sites.',
  });
  const name = (id) => sites.find((s) => s.siteId === id)?.site ?? id.slice(0, 8);
  table($('[data-cl]', el), {
    columns: [
      { label: 'Cost', render: (x) => `${esc(COST_CAT[x.category])} · ${esc(x.description)}<div class="cell-sub">${esc(COST_BASIS[x.basis])} · ${x.siteIds ? x.siteIds.map(name).map(esc).join(', ') : `all ${esc(x.currency)} sites`}</div>` },
      { label: 'Per month', num: true, render: (x) => esc(fmt.money(x.amount, x.currency)) },
      { label: 'Months', render: (x) => `${esc(x.monthFrom)} → ${esc(x.monthTo ?? 'ongoing')}${x.voided ? ` ${tag('t-mute', 'voided')}` : ''}` },
      { label: '', render: (x) => (canWrite && !x.voided ? `<div class="row nowrap" style="gap:6px"><button class="btn sm" type="button" data-cend="${esc(x.id)}">End</button><button class="btn sm" type="button" data-cvoid="${esc(x.id)}">Void</button></div>` : '') },
    ],
    rows: c.costs, empty: 'No shared costs yet: rent, maintenance contracts, SIM cards, insurance…',
  });
  $('[data-pm]', el).addEventListener('change', (e) => reload(e.target.value));
  el.addEventListener('click', async (e) => {
    const eb = e.target.closest('[data-cend]'), vb = e.target.closest('[data-cvoid]');
    if (eb) {
      const to = window.prompt('Last month it counts in (YYYY-MM):', month);
      if (!to) return;
      try { await api(`/v1/finance/shared-costs/${eb.dataset.cend}/end`, { method: 'POST', body: { monthTo: to.trim() } }); toast('Ended.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); }
    }
    if (vb) {
      const reason = window.prompt('Why is this cost voided?');
      if (!reason || !reason.trim()) return;
      try { await api(`/v1/finance/shared-costs/${vb.dataset.cvoid}/void`, { method: 'POST', body: { reason: reason.trim() } }); toast('Voided.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); }
    }
  });
  $('[data-cnew]', el)?.addEventListener('click', () => modal({ title: 'Add a shared cost', subtitle: 'An amount per month, spread over sites', size: 'lg',
    body: `<div class="form">${field('Category', `<select name="cat">${Object.entries(COST_CAT).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>`)}
      ${field('Spread', `<select name="basis">${Object.entries(COST_BASIS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>`)}
      ${field('Description', '<input name="desc" maxlength="200" placeholder="Maintenance contract, all DC chargers">', { full: true })}
      ${field('Amount per month', '<input name="amount" inputmode="decimal">')}${field('Currency', `<select name="cur">${[...new Set(sites.map((s) => s.currency))].map((x) => `<option>${esc(x)}</option>`).join('')}</select>`)}
      ${field('From', `<input name="from" type="month" value="${month}">`)}${field('Until', '<input name="to" type="month">', { opt: true, help: 'Empty: ongoing.' })}</div>
      <div class="cell-sub" style="margin:8px 0 4px">Sites (none ticked: every site of the currency)</div>
      <div class="row" style="gap:12px;flex-wrap:wrap">${sites.map((s) => `<label class="check"><input type="checkbox" name="site" value="${esc(s.siteId)}"><span>${esc(s.site)}</span></label>`).join('')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', async onClick(ctx) {
      const v = (n) => $(`[name="${n}"]`, ctx.body).value.trim();
      const siteIds = $$('[name="site"]:checked', ctx.body).map((x) => x.value);
      try { await api('/v1/finance/shared-costs', { method: 'POST', body: { category: v('cat'), basis: v('basis'), description: v('desc'), amount: toMinor(v('amount').replace(',', '.'), v('cur')), currency: v('cur'), monthFrom: v('from'), monthTo: v('to') || undefined, siteIds: siteIds.length ? siteIds : undefined } }); toast('Added.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] }));
}

const SET_ST = { settled: ['t-ok', 'settled'], due: ['t-info', 'due'], upcoming: ['t-mute', 'upcoming'], late: ['t-crit', 'late'] };
const WD_ST = { in_bank: ['t-ok', 'in the bank'], short: ['t-crit', 'short'], missing: ['t-crit', 'not in the bank'], awaiting_statement: ['t-mute', 'awaiting statement'] };
async function settlementsSection(host, base, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let v;
  try { v = await api(`${base}/settlements`); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const late = Object.entries(v.summary.late.amount), up = Object.entries(v.summary.upcoming);
  el.innerHTML = `<div class="grid k4">${kpi('Late', esc(late.length ? late.map(([c, x]) => fmt.money(x, c)).join(' · ') : '—'), `${v.summary.late.days} day(s) past ${v.settings.graceDays} days' grace`, v.summary.late.days ? 'crit' : '')}
      ${kpi('To come', esc(up.length ? up.map(([c, x]) => fmt.money(x, c)).join(' · ') : '—'), 'pending, not late')}
      ${kpi('Withdrawals not in the bank', esc(String(v.summary.missing)), v.bankStatementsTo ? `bank statements to ${fmt.date(v.bankStatementsTo)}` : 'no bank statement uploaded', v.summary.missing ? 'crit' : '')}
      ${kpi('Arrived short', esc(String(v.summary.short)), 'bank line below the withdrawal', v.summary.short ? 'crit' : '')}</div>
    <div class="grid two section"><div class="card"><header><h3>Settlements by day</h3></header><div data-sd></div></div><div class="card"><header><h3>Withdrawals to the bank</h3></header><div data-sw></div></div></div>
    <div class="card section"><header><h3>Tracking</h3></header><div class="body"><div class="filters" style="margin-top:0">${field('Late after (days)', `<input name="g" type="number" min="0" max="14" value="${v.settings.graceDays}" style="width:80px"${canWrite ? '' : ' disabled'}>`)}
      ${field('Withdrawal missing after (days)', `<input name="w" type="number" min="1" max="14" value="${v.settings.withdrawalDays}" style="width:80px"${canWrite ? '' : ' disabled'}>`)}
      ${canWrite ? '<div class="row" style="align-self:flex-end"><button class="btn" type="button" data-sset>Save</button></div>' : ''}</div>
      <p class="cell-sub">From the gateway's ledger: what it said it would settle each day, and what it has. Withdrawals are checked against the bank statement lines matched under Bank; alerts finance.settlement_late and finance.withdrawal_missing.</p></div></div>`;
  table($('[data-sd]', el), {
    columns: [
      { label: 'Expected', render: (s) => `${esc(fmt.date(s.day))}<div class="cell-sub">${esc(fmt.num(s.payments))} payments</div>` },
      { label: 'Net', num: true, render: (s) => esc(fmt.money(s.expected, s.currency)) },
      { label: 'Pending', num: true, render: (s) => (s.pending ? `${esc(fmt.money(s.pending, s.currency))}<div class="cell-sub">${s.pendingPayments} payments</div>` : '<span class="cell-sub">—</span>') },
      { label: '', render: (s) => tag(...SET_ST[s.state]) },
    ],
    rows: v.settlements.slice().reverse(), empty: 'No settlements in the last 45 days.',
  });
  table($('[data-sw]', el), {
    columns: [
      { label: 'Withdrawn', render: (w) => `${esc(fmt.date(w.day))}<div class="cell-sub mono">${esc(w.reference ?? '')}</div>` },
      { label: 'Amount', num: true, render: (w) => `${esc(fmt.money(w.amount, w.currency))}${w.bankAmount != null ? `<div class="cell-sub">bank ${esc(fmt.money(w.bankAmount, w.currency))} · ${esc(fmt.date(w.bankDay))}</div>` : ''}` },
      { label: '', render: (w) => tag(...WD_ST[w.state]) },
    ],
    rows: v.withdrawals, empty: 'No withdrawals in the last 45 days.',
  });
  $('[data-sset]', el)?.addEventListener('click', async () => {
    try { await api('/v1/finance/settlement-tracking/settings', { method: 'PUT', body: { graceDays: Number($('[name="g"]', el).value), withdrawalDays: Number($('[name="w"]', el).value) } }); toast('Saved.', 'ok'); settlementsSection(host, base, canWrite); } catch (e) { toast(e.message, 'crit'); }
  });
}

// ─────────────────────────────────────────── (v1.24.0) year end, data export

async function yearEndSection(host, canWrite, year = new Date().getFullYear() - 1) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let s;
  try { s = await api(`/v1/finance/year-end?year=${year}`); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = (y = year) => yearEndSection(host, canWrite, y);
  const now = new Date().getFullYear();
  const totals = Object.entries(s.totals);
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Year', `<select data-yy>${[now, now - 1, now - 2, now - 3].map((v) => `<option${v === year ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}
      <div class="row" style="gap:6px;align-self:flex-end"><button class="btn" type="button" data-ypack>${icon('download')} Year-end pack</button>${canWrite && s.ended && s.monthsLocked < 12 ? `<button class="btn primary" type="button" data-yclose>Close ${s.year}</button>` : ''}</div></div>
    ${s.ended ? (s.monthsLocked === 12 ? callout('ok', `${s.year} is closed: every month is locked.`) : callout('info', `${s.monthsLocked} of 12 months locked. <b>Close ${s.year}</b> locks the rest (reopening a month needs a Finance Manager).`)) : callout('info', `${s.year} has not ended: the figures are to date.`)}
    ${totals.map(([c, t]) => `<div class="grid k4">${kpi('Revenue', esc(fmt.money(t.revenue, c)), 'before tax')}${kpi('Energy', esc(fmt.money(t.energyCost, c)), '')}${kpi('Shared costs + depreciation', esc(fmt.money(t.shared + t.depreciation, c)), '')}${kpi('Contribution', esc(fmt.money(t.contribution, c)), t.revenue ? `${Math.round((t.contribution / t.revenue) * 100)}% of revenue` : '', t.contribution < 0 ? 'crit' : '')}</div>`).join('')}
    <div class="grid two section"><div class="card"><header><h3>By month</h3></header><div data-ym></div></div><div class="card"><header><h3>By site</h3></header><div data-ys></div></div></div>
    <div class="grid two section"><div class="card"><header><h3>Site owners</h3></header><div data-yo></div></div>
      <div class="card"><header><h3>PPh 23 withheld</h3><span class="right cell-sub">${esc(rp(s.pph23.total))} · ${s.pph23.records.length} records</span></header>${s.pph23.withoutBukti ? `<div class="body">${callout('warn', `${s.pph23.withoutBukti} without a bukti potong number (Finance → Tax).`)}</div>` : ''}<div data-yw></div></div></div>`;
  const rowsM = s.months.flatMap((m) => Object.entries(m.totals).map(([c, t]) => ({ month: m.month, locked: m.locked, c, ...t })));
  table($('[data-ym]', el), { columns: [
    { label: 'Month', render: (r) => `${esc(r.month)} ${r.locked ? tag('t-ok', 'locked') : ''}` },
    { label: 'Revenue', num: true, render: (r) => esc(fmt.money(r.revenue, r.c)) },
    { label: 'Contribution', num: true, render: (r) => `<span style="color:${r.contribution < 0 ? 'var(--crit)' : 'inherit'}">${esc(fmt.money(r.contribution, r.c))}</span>` },
  ], rows: rowsM, empty: 'No revenue this year.' });
  table($('[data-ys]', el), { columns: [
    { label: 'Site', render: (x) => `${esc(x.site)}<div class="cell-sub">${esc(fmt.num(x.sessions))} sessions · ${esc(fmt.num(Math.round(x.kwh)))} kWh</div>` },
    { label: 'Revenue', num: true, render: (x) => esc(fmt.money(x.revenue, x.currency)) },
    { label: 'Contribution', num: true, render: (x) => `<b style="color:${x.contribution < 0 ? 'var(--crit)' : 'inherit'}">${esc(fmt.money(x.contribution, x.currency))}</b>` },
  ], rows: s.sites, empty: 'No sites.' });
  table($('[data-yo]', el), { columns: [
    { label: 'Owner', render: (o) => `${esc(o.owner)}<div class="cell-sub">${o.statements} statements</div>` },
    { label: 'Share', num: true, render: (o) => esc(fmt.money(o.share, o.currency)) },
    { label: 'Still due', num: true, render: (o) => (o.outstanding ? tag('t-warn', fmt.money(o.outstanding, o.currency)) : '<span class="cell-sub">paid</span>') },
  ], rows: s.owners, empty: 'No owner statements this year.' });
  table($('[data-yw]', el), { columns: [
    { label: 'Period', render: (w) => `${esc(w.period)}<div class="cell-sub">${esc(w.counterparty)}</div>` },
    { label: 'Withheld', num: true, render: (w) => esc(rp(w.amount)) },
    { label: 'Bukti potong', render: (w) => (w.bukti ? `<span class="mono">${esc(w.bukti)}</span>` : tag('t-warn', 'missing')) },
  ], rows: s.pph23.records, empty: 'No PPh 23 records this year.' });
  $('[data-yy]', el).addEventListener('change', (e) => reload(Number(e.target.value)));
  $('[data-ypack]', el).addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { const res = await api(`/v1/finance/year-end/${s.year}/pack`, { raw: true }); download(`plugsure-year-end-${s.year}.zip`, await res.blob()); } catch (err) { toast(err.message, 'crit'); }
    e.currentTarget.disabled = false;
  });
  $('[data-yclose]', el)?.addEventListener('click', () => modal({ title: `Close ${s.year}`, subtitle: 'Lock every month of the year',
    body: `<p>Energy bills, exchange rates, budgets, investments and shared costs dated in ${s.year} can then no longer be changed. A Finance Manager can reopen a month with a reason.</p>`,
    actions: [{ label: 'Cancel' }, { label: `Close ${s.year}`, kind: 'primary', async onClick() {
      try { const r = await api(`/v1/finance/year-end/${s.year}/close`, { method: 'POST' }); toast(`${r.locked.length} month(s) locked.`, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] }));
}

// (v1.27.0) The organisation's WhatsApp template for finance digests.
async function digestSettings(el, canWrite) {
  let d;
  try { d = await api('/v1/finance/digest'); } catch { el.innerHTML = ''; return; }
  const t = d.organisation.whatsappTemplate, dis = canWrite ? '' : ' disabled';
  el.innerHTML = `<div class="card section"><header><h3>Finance digests</h3></header><div class="body">
    <p class="cell-sub" style="margin-top:0">Each person subscribes to their own digest in Finance today. For WhatsApp, name an approved template with one parameter (the digest's text).</p>
    <div class="form">${field('WhatsApp template', `<input name="dg_t" value="${esc(t?.name ?? '')}" placeholder="finance_digest"${dis}>`)}${field('Language', `<input name="dg_l" value="${esc(t?.lang ?? 'id')}"${dis}>`)}</div>
    ${canWrite ? '<div class="row" style="margin-top:10px"><button class="btn primary" type="button" data-dgs>Save</button></div>' : ''}</div></div>`;
  $('[data-dgs]', el)?.addEventListener('click', async () => {
    const name = $('[name="dg_t"]', el).value.trim();
    try { await api('/v1/finance/digest/settings', { method: 'PUT', body: { whatsappTemplate: name ? { name, lang: $('[name="dg_l"]', el).value.trim() } : null } }); toast('Saved.', 'ok'); } catch (e) { toast(e.message, 'crit'); }
  });
}

async function exportSettings(el, canWrite) {
  let w;
  try { w = await api('/v1/finance/warehouse'); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const st = w.settings, dis = canWrite ? '' : ' disabled';
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return zonedYmd(d); })();
  el.innerHTML = `<div class="card section"><header><h3>Data export</h3></header><div class="body">
      <p class="cell-sub" style="margin-top:0">Each night, the day before's payments, charges, refunds, statement payments, fleet invoices and credit notes, and snapshots of statements, shared costs, investments, PPh 23 and sites, as gzipped CSV or JSON Lines — to an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, Wasabi) for your BI tool or warehouse, or to the server's storage. Any day can also be downloaded as a ZIP.</p>
      <div class="form">
        <label class="check"><input type="checkbox" name="w_on"${st.enabled ? ' checked' : ''}${dis}><span>Export every night</span></label>
        ${field('Target', `<select name="w_target"${dis}><option value="s3"${st.target === 's3' ? ' selected' : ''}>S3-compatible bucket</option><option value="local"${st.target === 'local' ? ' selected' : ''}>The server's storage</option></select>`)}
        ${field('Format', `<select name="w_format"${dis}><option value="csv"${st.format === 'csv' ? ' selected' : ''}>CSV (gzipped)</option><option value="ndjson"${st.format === 'ndjson' ? ' selected' : ''}>JSON Lines (gzipped)</option></select>`)}
        ${field('Prefix', `<input name="w_prefix" value="${esc(st.prefix)}"${dis}>`)}
        ${field('Endpoint', `<input name="w_ep" value="${esc(st.endpoint ?? '')}" placeholder="https://s3.ap-southeast-3.amazonaws.com"${dis}>`)}
        ${field('Region', `<input name="w_region" value="${esc(st.region)}"${dis}>`)}
        ${field('Bucket', `<input name="w_bucket" value="${esc(st.bucket ?? '')}"${dis}>`)}
        ${field('Access key id', `<input name="w_key" value="${esc(st.accessKeyId ?? '')}" autocomplete="off"${dis}>`)}
        ${field('Secret access key', `<input name="w_secret" type="password" autocomplete="new-password" placeholder="${st.secretSet ? 'saved — leave empty to keep' : ''}"${dis}>`)}
      </div>
      ${canWrite ? `<div class="row" style="gap:8px;margin-top:10px"><button class="btn primary" type="button" data-wsave>Save</button><input type="date" data-wday value="${yesterday}" style="width:160px"><button class="btn" type="button" data-wrun>Export this day</button><button class="btn" type="button" data-wzip>${icon('download')} Download it</button></div>` : ''}
    </div><div data-wl></div></div>`;
  table($('[data-wl]', el), { columns: [
    { label: 'Day', render: (r) => `${esc(r.day)}<div class="cell-sub">${r.automatic ? 'nightly' : esc(r.by ?? 'by hand')} · ${esc(fmt.ago(r.at))}</div>` },
    { label: 'Target', render: (r) => esc(r.target === 's3' ? 'bucket' : 'server') },
    { label: 'Files', num: true, render: (r) => `${r.files}<div class="cell-sub">${esc(fmt.num(r.rows))} rows · ${esc(fmt.num(Math.round(r.bytes / 1024)))} KB</div>` },
    { label: '', render: (r) => (r.error ? `<span class="cell-sub wrap" style="color:var(--crit)">${esc(r.error)}</span>` : r.finished ? tag('t-ok', 'done') : tag('t-info', 'running')) },
  ], rows: w.runs, empty: 'No export yet.' });
  const v = (n) => $(`[name="${n}"]`, el)?.value.trim();
  $('[data-wsave]', el)?.addEventListener('click', async () => {
    try {
      await api('/v1/finance/warehouse/settings', { method: 'PUT', body: { enabled: $('[name="w_on"]', el).checked, target: v('w_target'), format: v('w_format'), prefix: v('w_prefix'), endpoint: v('w_ep') || undefined, region: v('w_region') || undefined, bucket: v('w_bucket') || undefined, accessKeyId: v('w_key') || undefined, secretAccessKey: v('w_secret') || undefined } });
      toast('Saved.', 'ok'); exportSettings(el, canWrite);
    } catch (e) { toast(e.message, 'crit'); }
  });
  $('[data-wrun]', el)?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { const r = await api('/v1/finance/warehouse/run', { method: 'POST', body: { day: $('[data-wday]', el).value } }); toast(`Exported ${r.files.length} files.`, 'ok'); exportSettings(el, canWrite); } catch (err) { toast(err.message, 'crit'); e.currentTarget.disabled = false; }
  });
  $('[data-wzip]', el)?.addEventListener('click', async () => {
    const day = $('[data-wday]', el).value;
    try { const res = await api(`/v1/finance/warehouse/days/${day}`, { raw: true }); download(`plugsure-finance-${day}.zip`, await res.blob()); } catch (err) { toast(err.message, 'crit'); }
  });
}

// ─────────────────────────────────────────── (v1.25.0) roaming settlement

const lastMonthYm = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return zonedYmd(d).slice(0, 7); };

async function roamingSection(host, canWrite, month = lastMonthYm()) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let o;
  try { o = await api(`/v1/finance/roaming?month=${month}`); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = (m = month) => roamingSection(host, canWrite, m);
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Month', `<input type="month" data-rm value="${esc(o.month)}">`)}
      <div class="row" style="gap:6px;align-self:flex-end"><button class="btn" type="button" data-rcsv>${icon('download')} CSV</button></div></div>
    ${callout('info', 'With each roaming partner: what it owes (our charge records of its drivers at our chargers) and what we owe it (its accepted records of our drivers), netted per currency. Finalise an ended month to freeze it as the settlement statement; record the transfer either way; it is matched on the bank statement.')}
    ${Object.entries(o.totals).map(([c, t]) => `<div class="grid k4 section">${kpi('Partners owe us', esc(fmt.money(t.receivable, c)), '')}${kpi('We owe partners', esc(fmt.money(t.payable, c)), '')}${kpi('Net', esc(fmt.money(t.net, c)), t.net >= 0 ? 'in our favour' : 'we pay')}${kpi('Still to settle', esc(fmt.money(t.outstandingIn, c)), `to receive · ${fmt.money(t.outstandingOut, c)} to pay`)}</div>`).join('')}
    <div class="card section" data-rl></div>`;
  table($('[data-rl]', el), { columns: [
    { label: 'Partner', render: (r) => `<div class="cell-title">${esc(r.partner.name)}</div><div class="cell-sub">${esc(r.partner.kind.toUpperCase())}${r.partner.party ? ` · ${esc(r.partner.party)}` : ''} · ${esc(r.currency)}</div>` },
    { label: 'They owe', num: true, render: (r) => `${esc(fmt.money((r.settlement ?? r.live).receivable, r.currency))}<div class="cell-sub">${(r.settlement ?? r.live).receivableCdrs} records</div>` },
    { label: 'We owe', num: true, render: (r) => `${esc(fmt.money((r.settlement ?? r.live).payable, r.currency))}<div class="cell-sub">${(r.settlement ?? r.live).payableCdrs} records</div>` },
    { label: 'Net', num: true, render: (r) => `<b>${esc(fmt.money((r.settlement ?? r.live).net, r.currency))}</b>` },
    { label: 'Settlement', render: (r) => (r.settlement
      ? `<span class="mono">${esc(r.settlement.number)}</span> ${tag(r.settlement.status === 'settled' || r.settlement.status === 'nil' ? 't-ok' : r.settlement.status === 'partial' ? 't-warn' : 't-info', r.settlement.status)}${r.drift ? `<div class="cell-sub" style="color:var(--warn)">${esc(fmt.money(r.drift, r.currency))} arrived later</div>` : ''}`
      : o.ended ? '<span class="cell-sub">not finalised</span>' : '<span class="cell-sub">month in progress</span>') },
  ], rows: o.rows, empty: 'No charging with roaming partners this month.', onRow: (r) => openRoaming(r, o, canWrite, reload) });
  $('[data-rm]', el).addEventListener('change', (e) => e.target.value && reload(e.target.value));
  $('[data-rcsv]', el).addEventListener('click', async () => {
    try { const res = await api(`/v1/finance/roaming?month=${o.month}&format=csv`, { raw: true }); download(`plugsure-roaming-${o.month}.csv`, await res.blob()); } catch (e) { toast(e.message, 'crit'); }
  });
}

function openRoaming(r, o, canWrite, reload) {
  const q = `month=${o.month}&currency=${encodeURIComponent(r.currency)}`;
  drawer({ title: r.partner.name, subtitle: esc(`${o.month} · ${r.currency}`), tabs: [
    { id: 'settle', label: 'Settlement', async render(body, ctx) {
      const d = await api(`/v1/finance/roaming/partners/${r.partner.id}?${q}`);
      const m = (n) => fmt.money(n, d.currency);
      const s = d.settlement;
      body.innerHTML = `<div class="grid k4">${kpi('They owe', esc(m((s ?? d.live).receivable)), '')}${kpi('We owe', esc(m((s ?? d.live).payable)), '')}${kpi('Net', esc(m((s ?? d.live).net)), (s ?? d.live).net >= 0 ? 'they pay us' : 'we pay them')}${kpi('Outstanding', s ? esc(m(s.outstanding)) : '—', s ? s.status : 'not finalised')}</div>
        <div class="row section" style="gap:6px;flex-wrap:wrap"><button class="btn" type="button" data-dcsv>${icon('download')} Records (CSV)</button>
          ${canWrite && !s && o.ended ? '<button class="btn primary" type="button" data-fin>Finalise settlement</button>' : ''}
          ${canWrite && s && s.outstanding > 0 ? `<button class="btn primary" type="button" data-pay>${s.direction === 'receive' ? 'Record money received' : 'Record money paid'}</button>` : ''}</div>
        ${s ? `<div class="card section"><header><h3>Payments</h3><span class="right cell-sub mono">${esc(s.number)}</span></header><div data-pl></div></div>` : ''}
        <div class="grid two section"><div class="card"><header><h3>They owe (our records)</h3></header><div data-ra></div></div><div class="card"><header><h3>We owe (their records)</h3></header><div data-rb></div></div></div>`;
      if (s) table($('[data-pl]', body), { columns: [
        { label: 'Date', render: (p) => `${esc(p.paidOn)}<div class="cell-sub">${esc(p.direction)}</div>` }, { label: 'Reference', render: (p) => `<span class="mono">${esc(p.reference)}</span>${p.voided ? ` ${tag('t-crit', 'voided')}` : ''}` },
        { label: 'Amount', num: true, render: (p) => esc(m(p.amount)) },
        { label: '', render: (p) => (canWrite && !p.voided ? `<button class="btn sm" type="button" data-void="${esc(p.id)}">Void</button>` : '') },
      ], rows: d.payments, empty: 'Nothing recorded yet.' });
      const cdrCols = [{ label: 'Ended', render: (x) => esc(x.ended) }, { label: 'kWh', num: true, render: (x) => esc(fmt.num(Math.round(x.kwh * 10) / 10)) }, { label: 'Amount', num: true, render: (x) => esc(m(x.amount)) }];
      table($('[data-ra]', body), { columns: cdrCols, rows: d.receivable.slice(0, 200), empty: 'None.' });
      table($('[data-rb]', body), { columns: cdrCols, rows: d.payable.slice(0, 200), empty: 'None.' });
      $('[data-dcsv]', body).addEventListener('click', async () => {
        try { const res = await api(`/v1/finance/roaming/partners/${r.partner.id}?${q}&format=csv`, { raw: true }); download(`plugsure-roaming-${o.month}-${r.partner.name}.csv`, await res.blob()); } catch (e) { toast(e.message, 'crit'); }
      });
      $('[data-fin]', body)?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        try { const x = await api(`/v1/finance/roaming/partners/${r.partner.id}/settle`, { method: 'POST', body: { month: o.month, currency: d.currency } }); toast(`${x.number} finalised.`, 'ok'); ctx.show('settle'); reload(); } catch (err) { toast(err.message, 'crit'); e.currentTarget.disabled = false; }
      });
      $('[data-pay]', body)?.addEventListener('click', () => modal({ title: s.direction === 'receive' ? 'Money received' : 'Money paid', subtitle: s.number,
        body: `<div class="form">${field(`Amount (${esc(d.currency)}, minor units)`, `<input name="amt" type="number" min="1" value="${s.outstanding}">`)}${field('Date', `<input name="on" type="date" value="${zonedYmd(new Date())}">`)}${field('Bank reference', '<input name="ref">')}${field('Note', '<input name="note">')}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', async onClick(mc) {
          try { await api(`/v1/finance/roaming/settlements/${s.id}/payments`, { method: 'POST', body: { amount: Number($('[name="amt"]', mc.el).value), paidOn: $('[name="on"]', mc.el).value, reference: $('[name="ref"]', mc.el).value.trim(), note: $('[name="note"]', mc.el).value.trim() || undefined } }); toast('Recorded.', 'ok'); ctx.show('settle'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
        } }] }));
      body.querySelectorAll('[data-void]').forEach((b) => b.addEventListener('click', () => modal({ title: 'Void the payment', body: field('Why', '<input name="why">'),
        actions: [{ label: 'Cancel' }, { label: 'Void', kind: 'danger', async onClick(mc) {
          try { await api(`/v1/finance/roaming/payments/${b.dataset.void}/void`, { method: 'POST', body: { reason: $('[name="why"]', mc.el).value.trim() } }); toast('Voided.', 'ok'); ctx.show('settle'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
        } }] })));
    } },
  ] });
}

// ─────────────────────────────────────────── (v1.25.0) controls and the change log

async function controlsSection(host, month = zonedYmd(new Date()).slice(0, 7)) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  const canAudit = state.can('audit:read');
  if (!canAudit) { el.innerHTML = callout('info', 'Controls and the change log need the audit:read permission (Finance Manager).'); return; }
  let c;
  try { c = await api(`/v1/finance/controls?month=${month}`); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const canApprove = state.can('finance:approve');
  const reload = (m = month) => controlsSection(host, m);
  const open = c.findings.filter((f) => !f.acknowledged).length;
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Month', `<input type="month" data-cm value="${esc(c.month)}">`)}
      <div class="row" style="gap:6px;align-self:flex-end"><button class="btn" type="button" data-crep>${icon('download')} Controls report</button>${canApprove ? `<button class="btn" type="button" data-cset>${icon('gear')} Thresholds</button>` : ''}</div></div>
    ${open ? callout('warn', `${open} finding${open === 1 ? '' : 's'} to review. Nothing is blocked: these are for a second look, and each can be acknowledged with a note.`) : callout('ok', 'No open findings this month.')}
    <div class="card section"><header><h3>Segregation of duties</h3></header><div data-cs></div></div>
    <div class="card section"><header><h3>Findings</h3></header><div data-cf></div></div>
    <div class="card section"><header><h3>Change log</h3><span class="right"><input type="date" data-lf style="width:150px"> <input type="date" data-lt style="width:150px"> <input data-la placeholder="action, e.g. finance.owner" style="width:200px"> <button class="btn sm" type="button" data-lgo>Show</button> <button class="btn sm" type="button" data-lcsv>CSV</button></span></header><div data-cl></div></div>`;
  table($('[data-cs]', el), { columns: [
    { label: 'Control', render: (s) => `<div class="cell-title">${esc(s.title)}</div><div class="cell-sub wrap">${esc(s.why)}</div>` },
    { label: 'Findings', num: true, render: (s) => (!s.ran ? '<span class="cell-sub">not set</span>' : s.open ? tag('t-warn', `${s.open} open`) : s.findings ? tag('t-ok', `${s.findings} acknowledged`) : tag('t-ok', 'none')) },
  ], rows: c.summary, empty: '' });
  table($('[data-cf]', el), { columns: [
    { label: 'Finding', render: (f) => `<div class="wrap">${esc(f.detail)}</div><div class="cell-sub">${esc(c.summary.find((s) => s.id === f.control)?.title ?? f.control)}${f.at ? ` · ${esc(fmt.date(f.at))}` : ''}</div>` },
    { label: '', render: (f) => (f.acknowledged ? `${tag('t-ok', 'acknowledged')}<div class="cell-sub wrap">${esc(f.acknowledged.by ?? '')}: ${esc(f.acknowledged.note)}</div>` : canApprove ? `<button class="btn sm" type="button" data-ack="${esc(f.key)}">Acknowledge</button>` : tag('t-warn', 'open')) },
  ], rows: c.findings, empty: 'No findings.' });
  el.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', () => modal({ title: 'Acknowledge the finding', body: field('What was checked', '<textarea name="note" rows="3"></textarea>'),
    actions: [{ label: 'Cancel' }, { label: 'Acknowledge', kind: 'primary', async onClick(mc) {
      try { await api('/v1/finance/controls/acknowledge', { method: 'POST', body: { key: b.dataset.ack, note: $('[name="note"]', mc.el).value.trim() } }); toast('Acknowledged.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] })));
  const lq = () => { const p = new URLSearchParams(); const f = $('[data-lf]', el).value, t = $('[data-lt]', el).value, a = $('[data-la]', el).value.trim(); if (f) p.set('from', f); if (t) p.set('to', t); if (a) p.set('action', a); return p.toString(); };
  const drawLog = async () => {
    let l;
    try { l = await api(`/v1/finance/change-log?${lq()}`); } catch (e) { $('[data-cl]', el).innerHTML = callout('crit', esc(e.message)); return; }
    table($('[data-cl]', el), { columns: [
      { label: 'When', render: (e) => `${esc(fmt.ago(e.at))}<div class="cell-sub">${esc(fmt.date(e.at))}</div>` },
      { label: 'Who', render: (e) => esc(e.actor.name ?? e.actor.type) },
      { label: 'Action', render: (e) => `<span class="mono">${esc(e.action)}</span><div class="cell-sub">${esc(e.targetType ?? '')} ${esc(String(e.targetId ?? '').slice(0, 36))}</div>` },
      { label: 'Recorded', render: (e) => `<span class="cell-sub mono wrap">${esc(JSON.stringify(e.after ?? {}).slice(0, 240))}</span>` },
    ], rows: l.entries.slice(0, 300), empty: 'No finance changes in this period.' });
  };
  await drawLog();
  $('[data-lgo]', el).addEventListener('click', drawLog);
  $('[data-lcsv]', el).addEventListener('click', async () => {
    try { const res = await api(`/v1/finance/change-log?${lq()}&format=csv`, { raw: true }); download('plugsure-finance-changes.csv', await res.blob()); } catch (e) { toast(e.message, 'crit'); }
  });
  $('[data-cm]', el).addEventListener('change', (e) => e.target.value && reload(e.target.value));
  $('[data-crep]', el).addEventListener('click', async () => {
    try { const res = await api(`/v1/finance/controls/report?month=${c.month}`, { raw: true }); download(`plugsure-finance-controls-${c.month}.xlsx`, await res.blob()); } catch (e) { toast(e.message, 'crit'); }
  });
  $('[data-cset]', el)?.addEventListener('click', () => modal({ title: 'Control thresholds', body: `<div class="form">${field('At least this many people hold finance:approve', `<input name="min" type="number" min="1" max="10" value="${c.settings.minApprovers}">`)}
      <label class="check"><input type="checkbox" name="wh"${c.settings.workingHours ? ' checked' : ''}><span>Flag payments recorded outside working hours and at weekends</span></label>
      ${field('From (hour)', `<input name="hf" type="number" min="0" max="23" value="${c.settings.workingHours?.from ?? 8}">`)}${field('To (hour)', `<input name="ht" type="number" min="1" max="24" value="${c.settings.workingHours?.to ?? 18}">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el);
      try { await api('/v1/finance/controls/settings', { method: 'PUT', body: { minApprovers: Number(v('min').value), workingHours: v('wh').checked ? { from: Number(v('hf').value), to: Number(v('ht').value) } : null } }); toast('Saved.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] }));
}

// ─────────────────────────────────────────── (v1.26.0) subscription revenue

async function subscriptionsSection(host, canWrite, month = zonedYmd(new Date()).slice(0, 7)) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let r;
  try { r = await api(`/v1/finance/subscription-revenue?month=${month}`); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = (m = month) => subscriptionsSection(host, canWrite, m);
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Month', `<input type="month" data-sm value="${esc(r.month)}">`)}
      <div class="row" style="gap:6px;align-self:flex-end"><button class="btn" type="button" data-sx>${icon('download')} Excel</button>${canWrite ? `<button class="btn" type="button" data-sacc>${icon('gear')} Accounts</button>` : ''}</div></div>
    ${callout('info', 'Memberships and passes are paid ahead for a period; their revenue is earned day by day over it. What is billed for days still to come is deferred revenue (a liability) until earned.')}
    ${r.currencies.map((c) => `<div class="grid k4 section">${kpi('Recognised', esc(fmt.money(c.recognised, c.currency)), `billed ${fmt.money(c.billed, c.currency)}`)}${kpi('Deferred at month end', esc(fmt.money(c.deferredEnd, c.currency)), `start ${fmt.money(c.deferredStart, c.currency)}`)}${kpi('MRR', esc(fmt.money(c.mrr, c.currency)), `ARR ${fmt.money(c.arr, c.currency)}`)}${kpi('Subscribers', String(c.subscribers.atEnd), `+${c.subscribers.new} · −${c.subscribers.cancelled + c.subscribers.expired}${c.churnPct != null ? ` · churn ${c.churnPct}%` : ''}`, c.churnPct > 10 ? 'warn' : '')}</div>`).join('') || callout('info', 'No memberships or passes.')}
    <div class="grid two section"><div class="card"><header><h3>By plan</h3></header><div data-sp></div></div><div class="card"><header><h3>Journal</h3></header><div data-sj></div></div></div>`;
  table($('[data-sp]', el), { columns: [
    { label: 'Plan', render: (p) => `${esc(p.plan)}<div class="cell-sub">${esc(p.currency)}</div>` },
    { label: 'Billed', num: true, render: (p) => esc(fmt.money(p.billed, p.currency)) },
    { label: 'Recognised', num: true, render: (p) => `<b>${esc(fmt.money(p.recognised, p.currency))}</b>` },
    { label: 'Deferred', num: true, render: (p) => esc(fmt.money(p.deferredEnd, p.currency)) },
  ], rows: r.currencies.flatMap((c) => c.plans.map((p) => ({ ...p, currency: c.currency }))), empty: 'No charges this month.' });
  table($('[data-sj]', el), { columns: [
    { label: 'Account', render: (j) => `<span class="mono">${esc(j.code)}</span> ${esc(j.account)}<div class="cell-sub">${esc(j.description)}</div>` },
    { label: 'Debit', num: true, render: (j) => (j.debit ? esc(fmt.money(j.debit, j.currency)) : '') },
    { label: 'Credit', num: true, render: (j) => (j.credit ? esc(fmt.money(j.credit, j.currency)) : '') },
  ], rows: r.journal, empty: 'No entries.' });
  $('[data-sm]', el).addEventListener('change', (e) => e.target.value && reload(e.target.value));
  $('[data-sx]', el).addEventListener('click', async () => {
    try { const res = await api(`/v1/finance/subscription-revenue?month=${r.month}&format=xlsx`, { raw: true }); download(`plugsure-subscription-revenue-${r.month}.xlsx`, await res.blob()); } catch (e) { toast(e.message, 'crit'); }
  });
  $('[data-sacc]', el)?.addEventListener('click', () => modal({ title: 'Journal accounts', body: `<div class="form">${['deferred', 'revenue', 'receivable'].map((k) => `${field(`${k === 'deferred' ? 'Deferred revenue' : k === 'revenue' ? 'Subscription revenue' : 'Cash / receivable'}`, `<div class="row" style="gap:6px"><input name="${k}c" value="${esc(r.accounts[k].code)}" style="width:110px"><input name="${k}n" value="${esc(r.accounts[k].name)}" style="flex:1"></div>`)}`).join('')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
      try { await api('/v1/finance/subscription-revenue/accounts', { method: 'PUT', body: Object.fromEntries(['deferred', 'revenue', 'receivable'].map((k) => [k, { code: v(`${k}c`), name: v(`${k}n`) }])) }); toast('Saved.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; }
    } }] }));
}

// ─────────────────────────────────────────── (v1.26.0) PPN return

async function ppnSection(host, canWrite, month = lastMonthYm()) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let p;
  try { p = await api(`/v1/finance/ppn?month=${month}`); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = (m = month) => ppnSection(host, canWrite, m);
  const R = (n) => fmt.money(n, LEGACY_CURRENCY);
  const dl = async (f, name) => { try { const res = await api(`/v1/finance/ppn?month=${p.month}&format=${f}`, { raw: true }); download(name, await res.blob()); } catch (e) { toast(e.message, 'crit'); } };
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Tax period', `<input type="month" data-pm value="${esc(p.month)}">`)}
      <div class="row" style="gap:6px;align-self:flex-end;flex-wrap:wrap"><button class="btn" type="button" data-px>${icon('download')} Working papers</button><button class="btn" type="button" data-pi>Masukan CSV</button><button class="btn" type="button" data-po>Keluaran CSV</button>
        ${canWrite && p.pkp && p.ended && !p.laterFiled ? `<button class="btn primary" type="button" data-pf>${p.filed ? 'Amend filing' : 'Record as filed'}</button>` : ''}</div></div>
    ${!p.pkp ? callout('info', 'Your organisation is not marked PKP (Fleet billing → Settings): it charges no PPN and files no SPT Masa PPN.') : ''}
    ${p.filed ? callout(p.filed.differs ? 'warn' : 'ok', `Filed ${esc(fmt.date(p.filed.at))}${p.filed.by ? ` by ${esc(p.filed.by)}` : ''}${p.filed.ntpn ? ` · NTPN <span class="mono">${esc(p.filed.ntpn)}</span>` : ''}.${p.filed.differs ? ' The records have changed since: amend the filing (pembetulan).' : ''}`) : p.ended ? callout('info', `Due by ${esc(p.filingDue)}: pay what is payable and file the SPT Masa PPN.`) : callout('info', 'The period has not ended: the figures are to date.')}
    ${p.missingEfaktur ? callout('warn', `${p.missingEfaktur} fleet invoice(s) without an e-Faktur number (Fleet billing → e-Faktur).`) : ''}
    <div class="grid k4 section">${kpi('Output (keluaran)', esc(R(p.output.ppn)), `DPP ${R(p.output.dpp)}`)}${kpi('Input (masukan)', esc(R(p.input.ppn)), `DPP ${R(p.input.dpp)}`)}${kpi('Brought forward', esc(R(p.broughtForward)), p.broughtFrom ? `from ${p.broughtFrom}` : 'none')}${p.payable ? kpi('Payable', esc(R(p.payable)), 'kurang bayar', 'warn') : kpi('Carried forward', esc(R(p.carriedForward)), 'lebih bayar')}</div>
    <div class="grid two section"><div class="card"><header><h3>Output tax</h3></header><div data-pol></div></div>
      <div class="card"><header><h3>Input tax</h3>${canWrite ? '<span class="right"><button class="btn sm" type="button" data-padd>Record faktur masukan</button></span>' : ''}</header><div data-pil></div>${p.input.suggestions.length ? '<div class="body" data-psug></div>' : ''}</div></div>
    <div class="card section"><header><h3>Filed periods</h3></header><div data-pp></div></div>`;
  table($('[data-pol]', el), { columns: [
    { label: 'Source', render: (l) => `${esc(l.label)}<div class="cell-sub">${l.count} record(s)</div>` },
    { label: 'DPP', num: true, render: (l) => esc(R(l.dpp)) }, { label: 'PPN', num: true, render: (l) => `<b>${esc(R(l.ppn))}</b>` },
  ], rows: p.output.lines, empty: '' });
  table($('[data-pil]', el), { columns: [
    { label: 'Faktur', render: (i) => `<span class="mono">${esc(i.faktur)}</span><div class="cell-sub">${esc(i.supplier)} · ${esc(i.date)}${i.creditable ? '' : ' · not creditable'}</div>` },
    { label: 'DPP', num: true, render: (i) => esc(R(i.dpp)) }, { label: 'PPN', num: true, render: (i) => esc(R(i.ppn)) },
    { label: '', render: (i) => (canWrite ? `<button class="btn sm" type="button" data-pv="${esc(i.id)}">Void</button>` : '') },
  ], rows: p.input.invoices, empty: 'No faktur masukan recorded for this period.' });
  if (p.input.suggestions.length) $('[data-psug]', el).innerHTML = `<div class="cell-sub" style="margin-bottom:6px">Not counted until recorded with the supplier's faktur:</div>${p.input.suggestions.map((x, i) => `<div class="row" style="justify-content:space-between;gap:8px;padding:4px 0"><span>${esc(x.description)}<div class="cell-sub">${esc(x.note)}</div></span><span class="row" style="gap:6px"><b>${esc(R(x.ppn))}</b>${canWrite ? `<button class="btn sm" type="button" data-psg="${i}">Record</button>` : ''}</span></div>`).join('')}`;
  table($('[data-pp]', el), { columns: [
    { label: 'Period', render: (f) => `${esc(f.month)}<div class="cell-sub">${esc(f.filedBy ?? '')}</div>` },
    { label: 'Output', num: true, render: (f) => esc(R(f.output)) }, { label: 'Input', num: true, render: (f) => esc(R(f.input)) },
    { label: 'Payable', num: true, render: (f) => (f.payable ? `<b>${esc(R(f.payable))}</b>` : '') }, { label: 'Carried', num: true, render: (f) => (f.carriedForward ? esc(R(f.carriedForward)) : '') },
    { label: 'NTPN', render: (f) => `<span class="mono">${esc(f.ntpn ?? '')}</span>` },
  ], rows: p.periods, empty: 'Nothing filed yet.' });
  $('[data-pm]', el).addEventListener('change', (e) => e.target.value && reload(e.target.value));
  $('[data-px]', el).addEventListener('click', () => dl('xlsx', `plugsure-ppn-${p.month}.xlsx`));
  $('[data-pi]', el).addEventListener('click', () => dl('input-csv', `plugsure-ppn-masukan-${p.month}.csv`));
  $('[data-po]', el).addEventListener('click', () => dl('output-csv', `plugsure-ppn-keluaran-${p.month}.csv`));
  const record = (pre = {}) => modal({ title: 'Faktur masukan', subtitle: `Tax period ${p.month}`, body: `<div class="form">
      ${field('Supplier', `<input name="sup" value="${esc(pre.supplier ?? '')}">`)}${field('Supplier NPWP', '<input name="npwp">')}${field('Faktur number', '<input name="fk">')}
      ${field('Faktur date', `<input name="dt" type="date" value="${p.month}-${p.month < zonedYmd(new Date()).slice(0, 7) ? '28' : '01'}">`)}${field('DPP (rupiah)', `<input name="dpp" type="number" min="0" value="${pre.dpp ?? ''}">`)}${field('PPN (rupiah)', `<input name="ppn" type="number" min="0" value="${pre.ppn ?? ''}">`)}
      ${field('Description', `<input name="desc" value="${esc(pre.description ?? '')}">`)}<label class="check"><input type="checkbox" name="cr" checked><span>Creditable</span></label></div>`,
    actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', async onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el);
      try {
        await api('/v1/finance/ppn/input-invoices', { method: 'POST', body: { month: p.month, supplier: v('sup').value.trim(), supplierNpwp: v('npwp').value.trim() || undefined, faktur: v('fk').value.trim(), date: v('dt').value,
          dpp: Number(v('dpp').value), ppn: Number(v('ppn').value), description: v('desc').value.trim() || undefined, creditable: v('cr').checked, amend: Boolean(p.filed) } });
        toast('Recorded.', 'ok'); reload();
      } catch (e) { toast(e.message, 'crit'); return false; }
    } }] });
  $('[data-padd]', el)?.addEventListener('click', () => record());
  el.querySelectorAll('[data-psg]').forEach((b) => b.addEventListener('click', () => record(p.input.suggestions[Number(b.dataset.psg)])));
  el.querySelectorAll('[data-pv]').forEach((b) => b.addEventListener('click', () => modal({ title: 'Void the faktur', body: field('Why', '<input name="why">'),
    actions: [{ label: 'Cancel' }, { label: 'Void', kind: 'danger', async onClick(mc) {
      try { await api(`/v1/finance/ppn/input-invoices/${b.dataset.pv}/void`, { method: 'POST', body: { reason: $('[name="why"]', mc.el).value.trim() } }); toast('Voided.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; }
    } }] })));
  $('[data-pf]', el)?.addEventListener('click', () => modal({ title: p.filed ? `Amend ${p.month}` : `Record ${p.month} as filed`, body: `<p>${p.payable ? `Payable: <b>${esc(R(p.payable))}</b>. Give the NTPN of the payment.` : `Nothing payable; <b>${esc(R(p.carriedForward))}</b> is carried forward to the next period.`}</p>
      <div class="form">${field('NTPN', '<input name="ntpn" maxlength="16" placeholder="16 letters and digits">')}${field('Reference (BPE)', '<input name="ref">')}${p.payable ? '<label class="check"><input type="checkbox" name="unpaid"><span>Filed, not paid yet</span></label>' : ''}</div>`,
    actions: [{ label: 'Cancel' }, { label: p.filed ? 'Amend' : 'Record', kind: 'primary', async onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el);
      try { await api(`/v1/finance/ppn/${p.month}/file`, { method: 'POST', body: { ntpn: v('ntpn').value.trim() || undefined, reference: v('ref').value.trim() || undefined, unpaid: v('unpaid')?.checked === true, amend: Boolean(p.filed) } }); toast('Recorded.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; }
    } }] }));
}

// ─────────────────────────────────────────── (v1.26.0) automatic owner payouts

async function autoPayoutsSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let a;
  try { a = await api('/v1/finance/owner-payouts/automation'); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = () => autoPayoutsSection(host, canWrite);
  const st = a.settings, dis = canWrite ? '' : ' disabled';
  const ready = a.candidates.filter((c) => c.ready);
  el.innerHTML = `${!a.rails.length ? callout('warn', 'Owner payouts need Xendit payouts or Duitku Disbursement on your own account (Integrations): until then, nothing is requested.') : ''}
    <div class="card"><header><h3>Automatic payouts</h3></header><div class="body">
      <p class="cell-sub" style="margin-top:0">Once an owner statement is finalised, the payout of the owner's share is requested for you, hourly. It is never sent by itself: it waits for the approvals as any payout (two people, or a Finance Manager above your threshold).</p>
      <div class="form"><label class="check"><input type="checkbox" name="ap_on"${st.enabled ? ' checked' : ''}${dis}><span>Request owner payouts automatically</span></label>
        ${field('Wait after finalising (days)', `<input name="ap_d" type="number" min="0" max="60" value="${st.delayDays}"${dis}>`)}${field('Minimum (rupiah)', `<input name="ap_m" type="number" min="0" value="${st.minAmount}"${dis}>`)}</div>
      ${canWrite ? `<div class="row" style="gap:8px;margin-top:10px"><button class="btn primary" type="button" data-aps>Save</button><button class="btn" type="button" data-apr${ready.length ? '' : ' disabled'}>Request ${ready.length} ready now</button></div>` : ''}
    </div></div>
    <div class="card section"><header><h3>Owner statements to pay</h3></header><div data-apc></div></div>
    <div class="card section"><header><h3>Per owner</h3></header><div data-apo></div></div>`;
  table($('[data-apc]', el), { columns: [
    { label: 'Statement', render: (c) => `<span class="mono">${esc(c.number)}</span><div class="cell-sub">${esc(c.owner)} · finalised ${esc(c.finalisedOn)}</div>` },
    { label: 'To pay', num: true, render: (c) => `<b>${esc(fmt.money(c.outstanding, c.currency))}</b>` },
    { label: '', render: (c) => (c.ready ? tag('t-ok', 'ready') : `<span class="cell-sub wrap">${esc(c.reason)}</span>`) },
  ], rows: a.candidates, empty: 'Every finalised owner statement is paid.' });
  table($('[data-apo]', el), { columns: [
    { label: 'Owner', render: (r) => esc(r.owner) },
    { label: 'Automatic', render: (r) => (r.automatic == null ? '<span class="cell-sub">default</span>' : r.automatic ? tag('t-ok', 'on') : tag('t-info', 'off')) },
    { label: 'Minimum', num: true, render: (r) => (r.minAmount == null ? '<span class="cell-sub">default</span>' : esc(fmt.money(r.minAmount, LEGACY_CURRENCY))) },
    { label: '', render: (r) => `${r.hold ? `${tag('t-warn', 'held')}<div class="cell-sub wrap">${esc(r.holdReason)}</div>` : ''}<button class="btn sm" type="button" data-odoc="${esc(r.ownerId)}">Documents</button>` },
  ], rows: a.rules, empty: 'No site owners.', onRow: canWrite ? (r) => modal({ title: r.owner, subtitle: 'Payout rule', body: `<div class="form">
      ${field('Automatic', `<select name="au"><option value="default"${r.automatic == null ? ' selected' : ''}>Default</option><option value="on"${r.automatic === true ? ' selected' : ''}>On</option><option value="off"${r.automatic === false ? ' selected' : ''}>Off</option></select>`)}
      ${field('Minimum (empty for the default)', `<input name="mn" type="number" min="0" value="${r.minAmount ?? ''}">`)}
      <label class="check"><input type="checkbox" name="hd"${r.hold ? ' checked' : ''}><span>Hold this owner's payouts</span></label>${field('Why', `<input name="hr" value="${esc(r.holdReason ?? '')}">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el);
      const au = v('au').value;
      try { await api(`/v1/finance/owner-payouts/automation/owners/${r.ownerId}`, { method: 'PUT', body: { automatic: au === 'default' ? null : au === 'on', minAmount: v('mn').value === '' ? null : Number(v('mn').value), hold: v('hd').checked, holdReason: v('hr').value.trim() } }); toast('Saved.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; }
    } }] }) : undefined });
  el.querySelectorAll('[data-odoc]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); const r = a.rules.find((x) => x.ownerId === b.dataset.odoc); ownerDocsDrawer(r.ownerId, r.owner, canWrite); }));
  $('[data-aps]', el)?.addEventListener('click', async () => {
    try { await api('/v1/finance/owner-payouts/automation', { method: 'PUT', body: { enabled: $('[name="ap_on"]', el).checked, delayDays: Number($('[name="ap_d"]', el).value), minAmount: Number($('[name="ap_m"]', el).value) } }); toast('Saved.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); }
  });
  $('[data-apr]', el)?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { const r = await api('/v1/finance/owner-payouts/automation/run', { method: 'POST' }); toast(`${r.requested.length} payout(s) requested; they wait for approval.${r.failed.length ? ` ${r.failed.length} failed: ${r.failed[0].error}` : ''}`, r.failed.length ? 'warn' : 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); e.currentTarget.disabled = false; }
  });
}

// ─────────────────────────────────────────── (v1.27.0) electricity tariffs and simulation

async function tariffsSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let t;
  try { t = await api('/v1/finance/tariffs'); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = () => tariffsSection(host, canWrite);
  el.innerHTML = `${callout('info', 'Set each site\'s electricity tariff, then simulate: when the site\'s cars charge (peak 17:00–22:00 or off-peak), the energy cost under each PLN class, the margin, and the price per kWh for your target margin. The catalogue\'s rates are indicative: your bills and PLN\'s current tariff decide.')}
    <div class="card section" data-tl></div>`;
  table($('[data-tl]', el), { columns: [
    { label: 'Site', render: (r) => esc(r.site) },
    { label: 'Tariff', render: (r) => (r.tariff ? `<b>${esc(r.tariff.tariffClass)}</b> · ${esc(fmt.num(r.tariff.powerKva))} kVA<div class="cell-sub">peak ${esc(fmt.num(r.tariff.ratePeak))} · off-peak ${esc(fmt.num(r.tariff.rateOffpeak))} per kWh</div>` : '<span class="cell-sub">not set</span>') },
    { label: '', render: (r) => `${canWrite ? `<button class="btn sm" type="button" data-tset="${esc(r.siteId)}">Set</button> ` : ''}<button class="btn sm" type="button" data-tsim="${esc(r.siteId)}"${r.tariff ? '' : ' disabled'}>Simulate</button>` },
  ], rows: t.sites, empty: 'No sites.' });
  el.querySelectorAll('[data-tset]').forEach((b) => b.addEventListener('click', () => {
    const r = t.sites.find((x) => x.siteId === b.dataset.tset); const cur = r.tariff ?? {};
    modal({ title: `Tariff · ${r.site}`, body: `<div class="form">
        ${field('Class', `<select name="cls">${t.catalogue.map((c) => `<option value="${esc(c.id)}"${cur.tariffClass === c.id ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}${cur.tariffClass && !t.catalogue.some((c) => c.id === cur.tariffClass) ? `<option selected>${esc(cur.tariffClass)}</option>` : ''}</select>`)}
        ${field('Connected power (kVA)', `<input name="kva" type="number" step="0.1" value="${cur.powerKva ?? ''}">`)}
        ${field('Peak rate per kWh (empty: the catalogue\'s)', `<input name="rp" type="number" step="0.01" value="${cur.ratePeak ?? ''}">`)}
        ${field('Off-peak rate per kWh', `<input name="ro" type="number" step="0.01" value="${cur.rateOffpeak ?? ''}">`)}
        ${field('Peak from / to (hour)', `<div class="row" style="gap:6px"><input name="pf" type="number" min="0" max="23" value="${cur.peakFrom ?? 17}" style="width:80px"><input name="pt" type="number" min="1" max="24" value="${cur.peakTo ?? 22}" style="width:80px"></div>`)}
        ${field('Fixed monthly charge', `<input name="fx" type="number" min="0" value="${cur.fixedMonthly ?? 0}">`)}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
        const v = (n) => $(`[name="${n}"]`, mc.el).value;
        try { await api(`/v1/finance/tariffs/sites/${r.siteId}`, { method: 'PUT', body: { tariffClass: v('cls'), powerKva: Number(v('kva')), ratePeak: v('rp') === '' ? undefined : Number(v('rp')), rateOffpeak: v('ro') === '' ? undefined : Number(v('ro')), peakFrom: Number(v('pf')), peakTo: Number(v('pt')), fixedMonthly: Number(v('fx')) } }); toast('Saved.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; }
      } }] });
  }));
  el.querySelectorAll('[data-tsim]').forEach((b) => b.addEventListener('click', () => {
    const r = t.sites.find((x) => x.siteId === b.dataset.tsim);
    let target = 30, shift = 20;
    drawer({ title: r.site, subtitle: 'Tariff simulation', tabs: [{ id: 'sim', label: 'Simulation', async render(body, ctx) {
      const s = await api(`/v1/finance/tariffs/sites/${r.siteId}/simulate?months=3&targetMarginPct=${target}&shiftPct=${shift}`);
      const m = (n) => fmt.money(Math.round(n), s.currency);
      const max = Math.max(1, ...s.load.hours);
      body.innerHTML = `<div class="filters" style="margin-top:0">${field('Target margin %', `<input type="number" data-tg value="${target}" min="0" max="90" style="width:90px">`)}${field('Move off-peak %', `<input type="number" data-sh value="${shift}" min="0" max="100" style="width:90px">`)}<button class="btn" type="button" data-go style="align-self:flex-end">Recalculate</button></div>
        <div class="grid k4">${kpi('kWh a month', esc(fmt.num(Math.round(s.load.kwhPerMonth))), `${s.load.sessions} sessions in ${s.months} months`)}${kpi('At peak', `${s.load.peakSharePct}%`, `${s.load.peakFrom}:00–${s.load.peakTo}:00`)}${kpi('Revenue per kWh', esc(m(s.revenuePerKwh)), 'before tax')}${kpi('Losses', `×${s.load.lossFactor}`, 'from recorded bills')}</div>
        <div class="card section"><header><h3>When cars charge</h3></header><div class="body"><div style="display:flex;align-items:flex-end;gap:2px;height:110px">${s.load.hours.map((h, i) => `<div title="${i}:00 · ${fmt.num(Math.round(h))} kWh" style="flex:1;height:${Math.max(2, Math.round((h / max) * 100))}px;background:${i >= s.load.peakFrom && i < s.load.peakTo ? 'var(--warn)' : 'var(--accent, #0b7a5a)'};border-radius:2px 2px 0 0"></div>`).join('')}</div><div class="row" style="justify-content:space-between" ><span class="cell-sub">00:00</span><span class="cell-sub">12:00</span><span class="cell-sub">23:00</span></div></div></div>
        ${s.recommendation ? callout('info', esc(s.recommendation)) : ''}
        ${s.shift ? callout(s.shift.savingPerMonth > 0 ? 'ok' : 'info', `${esc(s.shift.label)}: ${esc(m(s.shift.monthlyCost))} a month, saving ${esc(m(s.shift.savingPerMonth))}.`) : ''}
        <div class="card section" data-opts></div>`;
      table($('[data-opts]', body), { columns: [
        { label: 'Tariff', render: (o) => `${o.current ? '<b>' : ''}${esc(o.label)}${o.current ? '</b>' : ''}${o.id === s.cheapest ? ` ${tag('t-ok', 'cheapest')}` : ''}${o.note ? `<div class="cell-sub">${esc(o.note)}</div>` : ''}` },
        { label: 'A month', num: true, render: (o) => esc(m(o.monthlyCost)) },
        { label: 'Per kWh', num: true, render: (o) => esc(m(o.costPerKwh)) },
        { label: 'Margin', num: true, render: (o) => (o.marginPct == null ? '—' : `<span style="color:${o.marginPct < s.targetMarginPct ? 'var(--warn)' : 'inherit'}">${o.marginPct}%</span>`) },
        { label: `Price for ${s.targetMarginPct}%`, num: true, render: (o) => esc(m(o.priceForTarget)) },
      ], rows: s.options, empty: '' });
      $('[data-go]', body).addEventListener('click', () => { target = Number($('[data-tg]', body).value); shift = Number($('[data-sh]', body).value); ctx.show('sim'); });
    } }] });
  }));
}

// ─────────────────────────────────────────── (v1.27.0) fleet invoicing automation

async function fleetAutoSection(host) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  if (!state.can('invoice:read')) { el.innerHTML = callout('info', 'Fleet invoicing needs the invoice:read permission.'); return; }
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let p;
  try { p = await api('/v1/finance/fleet-automation'); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const canW = state.can('invoice:write'), dis = canW ? '' : ' disabled', st = p.settings;
  const reload = () => fleetAutoSection(host);
  el.innerHTML = `<div class="card"><header><h3>Fleet invoicing automation</h3></header><div class="body">
      <p class="cell-sub" style="margin-top:0">On the day you choose, last month is invoiced for every fleet account with charges; issued invoices are e-mailed with a Xendit payment link, and a paid link marks the invoice paid. Reminders for unpaid invoices are Collections' dunning.</p>
      <div class="form"><label class="check"><input type="checkbox" name="fa_i"${st.autoIssue ? ' checked' : ''}${dis}><span>Issue last month's invoices automatically</span></label>
        ${field('On day of the month', `<input name="fa_d" type="number" min="1" max="28" value="${st.issueDay}"${dis}>`)}
        <label class="check"><input type="checkbox" name="fa_s"${st.autoSend ? ' checked' : ''}${dis}><span>E-mail issued invoices to the fleet's billing address</span></label>
        <label class="check"><input type="checkbox" name="fa_e"${st.requireEfaktur ? ' checked' : ''}${dis}><span>Hold invoices with PPN to a buyer with an NPWP until the e-Faktur number is set</span></label>
        <label class="check"><input type="checkbox" name="fa_l"${st.paymentLinks ? ' checked' : ''}${dis}${p.xendit ? '' : ' disabled'}><span>Add a Xendit payment link${p.xendit ? '' : ' (needs your own Xendit account)'}</span></label></div>
      ${canW ? `<div class="row" style="gap:8px;margin-top:10px"><button class="btn primary" type="button" data-fas>Save</button><button class="btn" type="button" data-far>Run now</button></div>` : ''}
    </div></div>
    <div class="card section"><header><h3>Issued, not sent yet</h3></header><div data-fts></div></div>
    <div class="card section"><header><h3>Payment links</h3></header><div data-ftl></div></div>`;
  table($('[data-fts]', el), { columns: [
    { label: 'Invoice', render: (i) => `<span class="mono">${esc(i.number)}</span><div class="cell-sub">${esc(i.account)} · ${esc(i.period)}</div>` },
    { label: 'Total', num: true, render: (i) => esc(fmt.money(i.total, i.currency)) },
    { label: '', render: (i) => (i.ready ? tag('t-ok', 'ready to send') : `<span class="cell-sub wrap">${esc(i.hold)}</span>`) },
  ], rows: p.toSend, empty: 'Every issued invoice has been sent.' });
  table($('[data-ftl]', el), { columns: [
    { label: 'Invoice', render: (l) => `<span class="mono">${esc(l.number)}</span>${l.error ? `<div class="cell-sub" style="color:var(--crit)">${esc(l.error)}</div>` : ''}` },
    { label: 'Amount', num: true, render: (l) => esc(fmt.money(l.amount, l.currency)) },
    { label: 'Status', render: (l) => tag(l.status === 'paid' ? 't-ok' : l.status === 'pending' ? 't-info' : 't-mute', l.status) },
    { label: '', render: (l) => (l.status === 'pending' ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">link</a>` : '') },
  ], rows: p.links, empty: 'No payment links yet.' });
  $('[data-fas]', el)?.addEventListener('click', async () => {
    const c = (n) => $(`[name="${n}"]`, el).checked;
    try { await api('/v1/finance/fleet-automation', { method: 'PUT', body: { autoIssue: c('fa_i'), issueDay: Number($('[name="fa_d"]', el).value), autoSend: c('fa_s'), requireEfaktur: c('fa_e'), paymentLinks: c('fa_l') } }); toast('Saved.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); }
  });
  $('[data-far]', el)?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { const r = await api('/v1/finance/fleet-automation/run', { method: 'POST' }); toast(`${r.issued.length} issued, ${r.sent.length} sent, ${r.held.length} held${r.failed.length ? `, ${r.failed.length} failed` : ''}.`, r.failed.length ? 'warn' : 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); e.currentTarget.disabled = false; }
  });
}

// (v1.27.0) A site owner's documents, for the operator: advices, tax withheld (record it), annual statements.
function ownerDocsDrawer(ownerId, ownerName, canWrite) {
  drawer({ title: ownerName, subtitle: 'Documents', tabs: [{ id: 'docs', label: 'Documents', async render(body, ctx) {
    const d = await api(`/v1/finance/owners/${ownerId}/documents`);
    body.innerHTML = `<div class="row" style="gap:6px;flex-wrap:wrap">${d.years.map((y) => `<button class="btn sm" type="button" data-oy="${esc(y)}">${icon('download')} Annual statement ${esc(y)}</button>`).join('')}${canWrite && d.statements.length ? '<button class="btn sm primary" type="button" data-ow>Record tax withheld</button>' : ''}</div>
      <div class="card section"><header><h3>Tax withheld</h3></header><div data-owh></div></div><div class="card section"><header><h3>Payments</h3></header><div data-oad></div></div>`;
    table($('[data-owh]', body), { columns: [
      { label: 'Period', render: (w) => `${esc(w.period)}<div class="cell-sub">${esc(w.statement ?? '')} · ${w.ratePct}%</div>` }, { label: 'Withheld', num: true, render: (w) => esc(fmt.money(w.amount, w.currency)) },
      { label: 'Bukti potong', render: (w) => (w.bukti ? `<span class="mono">${esc(w.bukti)}</span>` : tag('t-warn', 'not issued')) },
    ], rows: d.withholdings, empty: 'None recorded.' });
    table($('[data-oad]', body), { columns: [
      { label: 'Paid on', render: (a) => esc(a.paidOn ?? '') }, { label: 'Statement', render: (a) => `<span class="mono">${esc(a.statement)}</span><div class="cell-sub">${esc(a.reference)}</div>` },
      { label: 'Amount', num: true, render: (a) => esc(fmt.money(a.amount, a.currency)) },
    ], rows: d.advices, empty: 'No payments recorded.' });
    body.querySelectorAll('[data-oy]').forEach((b) => b.addEventListener('click', async () => {
      try { const res = await api(`/v1/finance/owners/${ownerId}/documents/year/${b.dataset.oy}`, { raw: true }); download(`annual-statement-${b.dataset.oy}.pdf`, await res.blob()); } catch (e) { toast(e.message, 'crit'); }
    }));
    $('[data-ow]', body)?.addEventListener('click', () => modal({ title: 'Tax withheld', subtitle: ownerName, body: `<div class="form">
        ${field('Statement', `<select name="st">${d.statements.map((s) => `<option value="${esc(s.statementId)}">${esc(s.period)} · ${esc(s.number)} · ${esc(fmt.money(s.share, s.currency))}</option>`).join('')}</select>`)}
        ${field('Rate %', '<input name="rt" type="number" step="0.01" value="10">')}${field('Amount (empty: share × rate)', '<input name="am" type="number" min="0">')}
        ${field('Bukti potong number', '<input name="bk">')}${field('Bukti potong date', '<input name="bd" type="date">')}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', async onClick(mc) {
        const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
        try { await api(`/v1/finance/owners/${ownerId}/withholdings`, { method: 'POST', body: { statementId: v('st'), ratePct: Number(v('rt')), amount: v('am') === '' ? undefined : Number(v('am')), bukti: v('bk') || undefined, buktiDate: v('bd') || undefined } }); toast('Recorded.', 'ok'); ctx.show('docs'); } catch (e) { toast(e.message, 'crit'); return false; }
      } }] }));
  } }] });
}

const BTN = 'class="btn sm" style="white-space:nowrap" type="button"';

// ─────────────────────────────────────────── (v1.31.0) general ledger

const GL_ST = { draft: ['t-mute', 'draft'], awaiting_approval: ['t-warn', 'awaiting approval'], posted: ['t-ok', 'posted'], rejected: ['t-crit', 'rejected'], superseded: ['t-mute', 'superseded'] };

async function ledgerSection(host, canWrite, opts = {}) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  const month = opts.month ?? lastMonthYm();
  let r, e, chart;
  try { [r, e, chart] = await Promise.all([api(`/v1/finance/ledger?month=${month}${opts.currency ? `&currency=${opts.currency}` : ''}`), api(`/v1/finance/ledger/entries?month=${month}`), api('/v1/finance/ledger/accounts')]); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = (o = {}) => ledgerSection(host, canWrite, { month, currency: r.currency, ...o });
  const c = r.currency;
  const m = (v) => esc(fmt.money(v, c));
  const pl = r.profitAndLoss.month, ytd = r.profitAndLoss.yearToDate, bs = r.balanceSheet;
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Month', `<input type="month" data-gm value="${esc(month)}">`)}${field('Currency', `<select data-gc>${r.currencies.map((x) => `<option${x === c ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>`)}
      <div class="row" style="align-self:flex-end;gap:6px">${canWrite ? `<button class="btn" type="button" data-gsync ${r.locked ? 'disabled' : ''}>Sync ${esc(month)}</button><button class="btn primary" type="button" data-gnew>${icon('plus')} Journal entry</button>` : ''}<button class="btn" type="button" data-gx>${icon('download')} Excel</button></div></div>
    ${r.locked ? callout('info', `${esc(month)} is locked: nothing is posted to it.`) : ''}${e.awaitingApproval ? callout('warn', `${e.awaitingApproval} journal entr${e.awaitingApproval === 1 ? 'y waits' : 'ies wait'} for approval.`) : ''}
    ${!r.trialBalance.balanced || !bs.balanced ? callout('crit', 'The ledger does not balance: check the entries of the month.') : ''}
    <div class="grid k4 section">${kpi(`Revenue · ${esc(month)}`, m(pl.totalRevenue), `${m(ytd.totalRevenue)} this year`)}${kpi('Expenses', m(pl.totalExpense), `${m(ytd.totalExpense)} this year`)}${kpi('Result', m(pl.result), `${m(ytd.result)} this year`, pl.result < 0 ? 'crit' : '')}${kpi('Total assets', m(bs.totalAssets), `equity ${m(bs.totalEquity)}`)}</div>
    <div class="grid two section"><div class="card"><header><h3>Profit and loss · ${esc(month)}</h3></header><div data-gpl></div></div><div class="card"><header><h3>Balance sheet · end of ${esc(month)}</h3></header><div data-gbs></div></div></div>
    <div class="card section"><header><h3>Trial balance</h3><span class="cell-sub">${r.trialBalance.balanced ? 'balanced' : 'NOT balanced'}</span></header><div data-gtb></div></div>
    <div class="card section"><header><h3>Entries · ${esc(month)}</h3></header><div data-ge></div></div>`;
  const plRows = [...pl.revenue.map((x) => ({ ...x, g: 'Revenue' })), ...pl.expense.map((x) => ({ ...x, g: 'Expenses', amount: -x.amount })), ...pl.other.map((x) => ({ ...x, g: 'Other' })), { code: '', name: '<b>Result</b>', amount: pl.result, g: '' }];
  table($('[data-gpl]', el), { columns: [{ label: 'Account', render: (x) => `${x.code ? `<span class="mono">${esc(x.code)}</span> ${esc(x.name)}` : x.name}` }, { label: c, num: true, render: (x) => `<span style="color:${x.amount < 0 ? 'var(--crit)' : 'inherit'}">${m(x.amount)}</span>` }], rows: plRows, empty: 'Nothing posted.' });
  const bsRows = [...bs.assets.map((x) => ({ ...x })), { code: '', name: '<b>Total assets</b>', amount: bs.totalAssets }, ...bs.liabilities, { code: '', name: '<b>Total liabilities</b>', amount: bs.totalLiabilities }, ...bs.equity, { code: '', name: 'Result of earlier years', amount: bs.priorYearsResult }, { code: '', name: 'Result of the year', amount: bs.yearResult }, { code: '', name: '<b>Total equity</b>', amount: bs.totalEquity }];
  table($('[data-gbs]', el), { columns: [{ label: 'Account', render: (x) => `${x.code ? `<span class="mono">${esc(x.code)}</span> ${esc(x.name)}` : x.name}` }, { label: c, num: true, render: (x) => m(x.amount) }], rows: bsRows });
  table($('[data-gtb]', el), { columns: [
    { label: 'Account', render: (x) => `<span class="mono">${esc(x.code)}</span> ${esc(x.name)}<div class="cell-sub">${esc(x.type)}</div>` },
    { label: 'Debit', num: true, render: (x) => (x.balance > 0 ? m(x.balance) : '') }, { label: 'Credit', num: true, render: (x) => (x.balance < 0 ? m(-x.balance) : '') },
  ], rows: r.trialBalance.rows, empty: 'Nothing posted yet: sync the month, or make a journal entry.' });
  table($('[data-ge]', el), { columns: [
    { label: 'Entry', render: (x) => `<b>${esc(x.number)}</b> · ${esc(x.date)}<div class="cell-sub">${esc(x.source)} · ${esc(x.memo)}</div>` },
    { label: 'Amount', num: true, render: (x) => esc(fmt.money(x.total, x.currency)) },
    { label: 'Status', render: (x) => `${tag(...(GL_ST[x.status] ?? ['t-mute', x.status]))}${x.reversedBy ? '<div class="cell-sub">reversed</div>' : ''}` },
    { label: '', render: (x) => `<button ${BTN} data-gopen="${esc(x.id)}">Open</button>` },
  ], rows: e.entries, empty: 'No entries this month.' });
  const post = async (url, body, msg) => { try { const x = await api(url, { method: 'POST', body }); toast(x.waitingForSecondApprover ? 'First approval recorded: a second approver is needed.' : msg, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; } };
  $('[data-gm]', el).addEventListener('change', (ev) => ev.target.value && reload({ month: ev.target.value }));
  $('[data-gc]', el).addEventListener('change', (ev) => reload({ currency: ev.target.value }));
  $('[data-gx]', el).addEventListener('click', async () => { try { const res = await api(`/v1/finance/ledger?month=${month}&currency=${c}&format=xlsx`, { raw: true }); download(`plugsure-ledger-${month}.xlsx`, await res.blob()); } catch (err) { toast(err.message, 'crit'); } });
  $('[data-gsync]', el)?.addEventListener('click', async (ev) => { ev.target.disabled = true; try { const x = await api(`/v1/finance/ledger/sync/${month}`, { method: 'POST' }); toast(`${x.posted} posted, ${x.unchanged} unchanged, ${x.superseded} replaced.`, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); ev.target.disabled = false; } });
  el.querySelectorAll('[data-gopen]').forEach((b) => b.addEventListener('click', () => {
    const x = e.entries.find((y) => y.id === b.dataset.gopen);
    drawer({ title: `${x.number} · ${x.date}`, subtitle: esc(x.memo), tabs: [{ id: 'e', label: 'Entry', render(body, ctx) {
      body.innerHTML = `<div data-glines></div><div class="cell-sub" style="margin-top:8px">${esc(x.source)}${x.submittedBy ? ` · by ${esc(x.submittedBy)}` : ''}${x.approvedBy ? ` · approved by ${esc(x.approvedBy)}` : ''}${x.rejectReason ? ` · rejected: ${esc(x.rejectReason)}` : ''}</div>
        <div class="row" style="gap:6px;margin-top:12px">${!canWrite ? '' : x.status === 'awaiting_approval' ? `<button ${BTN} data-ga="approve">Approve</button><button ${BTN} data-ga="reject">Reject</button>` : x.status === 'posted' && x.source === 'manual' && !x.reversedBy ? `<button ${BTN} data-ga="reverse">Reverse</button>` : x.status === 'draft' || x.status === 'rejected' ? `<button ${BTN} data-ga="submit">Submit</button>` : ''}</div>`;
      table($('[data-glines]', body), { columns: [{ label: 'Account', render: (l) => `<span class="mono">${esc(l.account)}</span> ${esc(l.name ?? '')}<div class="cell-sub">${esc(l.description ?? '')}</div>` }, { label: 'Debit', num: true, render: (l) => (l.debit ? esc(fmt.money(l.debit, x.currency)) : '') }, { label: 'Credit', num: true, render: (l) => (l.credit ? esc(fmt.money(l.credit, x.currency)) : '') }], rows: x.lines });
      $$('[data-ga]', body).forEach((a) => a.addEventListener('click', () => {
        const how = a.dataset.ga;
        if (how === 'reject') { const why = window.prompt('Why is it rejected?'); if (why && why.trim()) { ctx.close(); post(`/v1/finance/ledger/entries/${x.id}/reject`, { reason: why.trim() }, 'Rejected.'); } return; }
        ctx.close(); post(`/v1/finance/ledger/entries/${x.id}/${how}`, undefined, how === 'approve' ? 'Posted.' : how === 'reverse' ? 'Reversed.' : 'Submitted.');
      }));
    } }] });
  }));
  $('[data-gnew]', el)?.addEventListener('click', () => {
    const opts2 = chart.accounts.filter((a) => a.active).map((a) => `<option value="${esc(a.code)}">${esc(a.code)} ${esc(a.name)}</option>`).join('');
    const row = () => `<div class="row" data-jl style="gap:6px;margin-bottom:6px"><select name="ja" style="flex:2">${opts2}</select><input name="jd" type="number" min="0" step="0.01" placeholder="Debit" style="width:120px"><input name="jc" type="number" min="0" step="0.01" placeholder="Credit" style="width:120px"></div>`;
    modal({ title: 'Journal entry', subtitle: 'Posted once a second person approves it', size: 'lg', body: `<div class="form">${field('Date', `<input name="d" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Currency', `<input name="c" value="${esc(c)}">`)}${field('Memo', '<input name="m">')}</div>
      <div style="margin-top:10px"><div data-jlines>${row()}${row()}</div><button class="btn sm" type="button" data-jadd>${icon('plus')} Line</button></div>`,
      onMount: (mc) => $('[data-jadd]', mc.el).addEventListener('click', () => $('[data-jlines]', mc.el).insertAdjacentHTML('beforeend', row())),
      actions: [{ label: 'Cancel' }, { label: 'Submit for approval', kind: 'primary', async onClick(mc) {
        const lines = $$('[data-jl]', mc.el).map((x) => ({ account: $('[name="ja"]', x).value, debit: Number($('[name="jd"]', x).value || 0), credit: Number($('[name="jc"]', x).value || 0) })).filter((l) => l.debit || l.credit);
        try { await api('/v1/finance/ledger/entries', { method: 'POST', body: { date: $('[name="d"]', mc.el).value, currency: $('[name="c"]', mc.el).value.trim(), memo: $('[name="m"]', mc.el).value.trim(), lines } }); toast('Submitted.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
      } }] });
  });
}

// ─────────────────────────────────────────── (v1.31.0) expense claims and petty cash

const EX_ST = { draft: ['t-mute', 'draft'], submitted: ['t-warn', 'submitted'], approved: ['t-info', 'approved'], rejected: ['t-crit', 'rejected'], reimbursed: ['t-ok', 'reimbursed'], void: ['t-mute', 'void'] };
const EX_CATS = ['fuel', 'travel', 'meals', 'parking', 'tools', 'supplies', 'phone', 'other'];
const fileB64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = rej; r.readAsDataURL(f); });

async function expensesSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d, pc, accts;
  try { [d, pc, accts] = await Promise.all([api('/v1/finance/expenses'), api('/v1/finance/petty-cash'), api('/v1/finance/cash/accounts')]); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => expensesSection(host, canWrite);
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px"><button class="btn primary" type="button" data-xnew>${icon('plus')} New claim</button><button class="btn" type="button" data-xx>${icon('download')} Excel</button></div>
    ${Object.entries(d.toReimburse).map(([cur, v]) => callout('info', `${esc(fmt.money(v, cur))} approved and waiting to be reimbursed.`)).join('')}
    <div class="card section"><header><h3>Expense claims</h3><span class="cell-sub">receipt needed from ${esc(fmt.money(d.policy.receiptAbove, LEGACY_CURRENCY))}</span></header><div data-xl></div></div>
    <div class="card section"><header><h3>Petty cash</h3></header><div data-xp></div></div>`;
  table($('[data-xl]', el), { columns: [
    { label: 'Claim', render: (x) => `<b>${esc(x.number)}</b> · ${esc(x.claimant)}<div class="cell-sub">${esc(x.title)} · ${x.lines.length} line${x.lines.length === 1 ? '' : 's'}</div>` },
    { label: 'Total', num: true, render: (x) => esc(fmt.money(x.total, x.currency)) },
    { label: 'Status', render: (x) => `${tag(...(EX_ST[x.status] ?? ['t-mute', x.status]))}${x.overLimit ? '<div class="cell-sub" style="color:var(--warn)">over a limit</div>' : ''}${x.receiptsMissing ? `<div class="cell-sub" style="color:var(--warn)">${x.receiptsMissing} receipt${x.receiptsMissing === 1 ? '' : 's'} missing</div>` : ''}` },
    { label: '', render: (x) => `<button ${BTN} data-xopen="${esc(x.id)}">Open</button>` },
  ], rows: d.claims.filter((x) => x.status !== 'void'), empty: 'No claims yet.' });
  table($('[data-xp]', el), { columns: [
    { label: 'Account', render: (a) => `${esc(a.name)}${a.lastCount ? `<div class="cell-sub">counted ${esc(a.lastCount.on)}${a.lastCount.difference ? ` · <span style="color:var(--warn)">${esc(fmt.money(a.lastCount.difference, a.currency))} difference</span>` : ''}</div>` : ''}` },
    { label: 'Balance', num: true, render: (a) => (a.balance == null ? '' : esc(fmt.money(a.balance, a.currency))) },
    { label: 'Float', num: true, render: (a) => (a.float == null ? '' : `${esc(fmt.money(a.float, a.currency))}${a.topUp ? `<div class="cell-sub">top up ${esc(fmt.money(a.topUp, a.currency))}</div>` : ''}`) },
    { label: '', render: (a) => (canWrite ? `<button ${BTN} data-pcount="${esc(a.id)}">Count</button> <button ${BTN} data-pfloat="${esc(a.id)}">Float</button>` : '') },
  ], rows: pc.accounts, empty: 'No petty cash account: add one under Cash (kind: cash on hand).' });
  const post = async (url, body, msg) => { try { const x = await api(url, { method: 'POST', body }); toast(x.waitingForSecondApprover ? 'First approval recorded: a second approver is needed.' : msg, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; } };
  $('[data-xx]', el).addEventListener('click', async () => { try { const res = await api('/v1/finance/expenses?format=xlsx', { raw: true }); download('plugsure-expense-claims.xlsx', await res.blob()); } catch (err) { toast(err.message, 'crit'); } });
  el.querySelectorAll('[data-pfloat]').forEach((b) => b.addEventListener('click', () => modal({ title: 'Petty cash float', body: field('Float (blank: none)', '<input name="f" type="number" min="0">'),
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) { const v = $('[name="f"]', mc.el).value; try { await api(`/v1/finance/petty-cash/${b.dataset.pfloat}/float`, { method: 'PUT', body: { float: v === '' ? null : Number(v) } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] })));
  el.querySelectorAll('[data-pcount]').forEach((b) => b.addEventListener('click', () => {
    const faces = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100];
    modal({ title: 'Count the petty cash', subtitle: 'How many of each note and coin', body: `<div class="form">${faces.map((f) => field(fmt.money(f, LEGACY_CURRENCY), `<input name="d${f}" type="number" min="0" value="0">`)).join('')}${field('Note', '<input name="n">')}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', async onClick(mc) {
        const denominations = Object.fromEntries(faces.map((f) => [f, Number($(`[name="d${f}"]`, mc.el).value || 0)]));
        try { const x = await api(`/v1/finance/petty-cash/${b.dataset.pcount}/counts`, { method: 'POST', body: { denominations, note: $('[name="n"]', mc.el).value.trim() || undefined } }); toast(x.difference ? `Counted ${fmt.money(x.total, LEGACY_CURRENCY)}: ${fmt.money(x.difference, LEGACY_CURRENCY)} against the books.` : 'Counted: it matches the books.', x.difference ? 'warn' : 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
      } }] });
  }));
  el.querySelectorAll('[data-xopen]').forEach((b) => b.addEventListener('click', () => {
    const x = d.claims.find((y) => y.id === b.dataset.xopen);
    drawer({ title: `${x.number} · ${x.claimant}`, subtitle: esc(x.title), tabs: [{ id: 'c', label: 'Claim', render(body, ctx) {
      body.innerHTML = `<div data-xlines></div>${x.rejectReason ? callout('warn', `Rejected: ${esc(x.rejectReason)}`) : ''}<div class="row" style="gap:6px;margin-top:12px;flex-wrap:wrap">
        ${(x.status === 'draft' || x.status === 'rejected') ? `<button ${BTN} data-xa="submit">Submit</button>` : ''}${x.status === 'submitted' && canWrite ? `<button ${BTN} data-xa="approve">Approve</button><button ${BTN} data-xa="reject">Reject</button>` : ''}
        ${x.status === 'approved' && canWrite ? `<button ${BTN} data-xa="reimburse">Reimburse</button>` : ''}${['draft', 'rejected', 'submitted'].includes(x.status) ? `<button ${BTN} data-xa="void">Void</button>` : ''}</div>`;
      table($('[data-xlines]', body), { columns: [
        { label: 'Spent', render: (l) => `${esc(l.spentOn)} · ${esc(l.category)}<div class="cell-sub">${esc(l.description)}${l.site ? ` · ${esc(l.site)}` : ''}</div>` },
        { label: 'Amount', num: true, render: (l) => `${esc(fmt.money(l.total, x.currency))}${l.overLimit ? `<div class="cell-sub" style="color:var(--warn)">over ${esc(fmt.money(l.limit, x.currency))}</div>` : ''}` },
        { label: 'Receipt', render: (l) => `${l.receipts.map((r) => `<a href="/v1/finance/expenses/receipts/${esc(r.id)}" target="_blank" rel="noopener">${esc(r.filename)}</a>`).join('<br>')}${l.receiptNeeded ? '<div class="cell-sub" style="color:var(--warn)">needed</div>' : ''}${(x.status === 'draft' || x.status === 'rejected' || x.status === 'submitted') ? `<div><label class="btn sm" style="white-space:nowrap">Attach<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" data-xr="${esc(l.id)}" hidden></label></div>` : ''}` },
      ], rows: x.lines });
      $$('[data-xr]', body).forEach((inp) => inp.addEventListener('change', async () => {
        const f = inp.files?.[0]; if (!f) return;
        try { await api(`/v1/finance/expenses/${x.id}/lines/${inp.dataset.xr}/receipts`, { method: 'POST', body: { filename: f.name, mime: f.type, data: await fileB64(f) } }); toast('Attached.', 'ok'); ctx.close(); reload(); } catch (err) { toast(err.message, 'crit'); }
      }));
      $$('[data-xa]', body).forEach((a) => a.addEventListener('click', () => {
        const how = a.dataset.xa;
        if (how === 'reject') { const why = window.prompt('Why is it rejected?'); if (why && why.trim()) { ctx.close(); post(`/v1/finance/expenses/${x.id}/reject`, { reason: why.trim() }, 'Rejected.'); } return; }
        if (how === 'reimburse') {
          const opts = accts.accounts.filter((y) => y.currency === x.currency);
          ctx.close();
          modal({ title: `Reimburse ${fmt.money(x.total, x.currency)}`, body: `<div class="form">${field('From', `<select name="a">${opts.map((y) => `<option value="${esc(y.id)}">${esc(y.name)} (${esc(y.kind)})</option>`).join('')}</select>`)}${field('On', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Reference', '<input name="r">')}</div>`,
            actions: [{ label: 'Cancel' }, { label: 'Reimburse', kind: 'primary', onClick: (mc) => post(`/v1/finance/expenses/${x.id}/reimburse`, { cashAccountId: $('[name="a"]', mc.el).value, reimbursedOn: $('[name="on"]', mc.el).value, reference: $('[name="r"]', mc.el).value.trim() || undefined }, 'Reimbursed.') }] });
          return;
        }
        ctx.close(); post(`/v1/finance/expenses/${x.id}/${how}`, undefined, 'Done.');
      }));
    } }] });
  }));
  $('[data-xnew]', el).addEventListener('click', async () => {
    const ss = await sitesList();
    const row = () => `<div class="row" data-el style="gap:6px;margin-bottom:6px;flex-wrap:wrap"><input name="ed" type="date" value="${esc(zonedYmd(new Date()))}" style="width:150px"><select name="ec">${EX_CATS.map((x) => `<option>${x}</option>`).join('')}</select><input name="et" placeholder="What" style="flex:2;min-width:140px"><input name="ea" type="number" min="1" placeholder="Amount" style="width:120px"><select name="es"><option value="">— site —</option>${ss.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></div>`;
    modal({ title: 'New expense claim', subtitle: 'Attach receipts after saving it', size: 'lg', body: `<div class="form">${field('Title', '<input name="t" placeholder="Site visits, week 44">')}</div><div style="margin-top:10px"><div data-elines>${row()}</div><button class="btn sm" type="button" data-eadd>${icon('plus')} Line</button></div>`,
      onMount: (mc) => $('[data-eadd]', mc.el).addEventListener('click', () => $('[data-elines]', mc.el).insertAdjacentHTML('beforeend', row())),
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
        const lines = $$('[data-el]', mc.el).map((x) => ({ spentOn: $('[name="ed"]', x).value, category: $('[name="ec"]', x).value, description: $('[name="et"]', x).value.trim(), amount: Number($('[name="ea"]', x).value), siteId: $('[name="es"]', x).value || undefined })).filter((l) => l.description);
        try { await api('/v1/finance/expenses', { method: 'POST', body: { title: $('[name="t"]', mc.el).value.trim(), lines } }); toast('Saved: attach the receipts, then submit it.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
      } }] });
  });
}

// ─────────────────────────────────────────── (v1.31.0) intercompany

const IC_ST = { draft: ['t-mute', 'draft'], issued: ['t-info', 'issued'], settled: ['t-ok', 'settled'], void: ['t-mute', 'void'] };

async function intercompanySection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api('/v1/finance/intercompany'); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  if (!d.grouped) { el.innerHTML = callout('info', 'Your organisation is not in a group: intercompany recharges are between a parent organisation and its subsidiaries.'); return; }
  const reload = () => intercompanySection(host, canWrite);
  const others = d.group.filter((g) => !g.me);
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-inew>${icon('plus')} Recharge</button><button class="btn" type="button" data-ialloc>Allocate a cost</button>` : ''}</div>
    <div class="card section"><header><h3>Balances</h3></header><div data-ib></div></div>
    <div class="card section"><header><h3>Recharges</h3></header><div data-il></div></div>
    ${d.settlements.length ? '<div class="card section"><header><h3>Settlements</h3></header><div data-is></div></div>' : ''}`;
  table($('[data-ib]', el), { columns: [
    { label: 'Entity', render: (b) => `${esc(b.other)}<div class="cell-sub">${b.open} open</div>` },
    { label: 'They owe you', num: true, render: (b) => esc(fmt.money(b.receivable, b.currency)) },
    { label: 'You owe them', num: true, render: (b) => esc(fmt.money(b.payable, b.currency)) },
    { label: 'Net', num: true, render: (b) => `<b style="color:${b.net < 0 ? 'var(--crit)' : 'inherit'}">${esc(fmt.money(b.net, b.currency))}</b>` },
    { label: '', render: (b) => (canWrite ? `<button ${BTN} data-iset="${esc(b.otherOrgId)}|${esc(b.currency)}">Settle</button>` : '') },
  ], rows: d.balances, empty: 'Nothing open between the group\'s entities.' });
  table($('[data-il]', el), { columns: [
    { label: 'Recharge', render: (r) => `<b>${esc(r.number)}</b> · ${r.direction === 'out' ? `to ${esc(r.to)}` : `from ${esc(r.from)}`}<div class="cell-sub">${esc(r.month)} · ${esc(r.description)}</div>` },
    { label: 'Amount', num: true, render: (r) => `<span style="color:${r.direction === 'in' ? 'var(--crit)' : 'inherit'}">${r.direction === 'in' ? '−' : ''}${esc(fmt.money(r.amount, r.currency))}</span>` },
    { label: 'Status', render: (r) => tag(...(IC_ST[r.status] ?? ['t-mute', r.status])) },
    { label: '', render: (r) => (canWrite && r.direction === 'out' ? `${r.status === 'draft' ? `<button ${BTN} data-iiss="${esc(r.id)}">Issue</button> ` : ''}${r.status === 'draft' || r.status === 'issued' ? `<button ${BTN} data-ivoid="${esc(r.id)}">Void</button>` : ''}` : '') },
  ], rows: d.recharges.filter((r) => r.status !== 'void'), empty: 'No recharges yet.' });
  if (d.settlements.length) table($('[data-is]', el), { columns: [{ label: 'With', render: (s) => `${esc(s.other)}<div class="cell-sub">${esc(s.settledOn)}${s.reference ? ` · ${esc(s.reference)}` : ''}</div>` }, { label: 'Net', num: true, render: (s) => esc(fmt.money(s.net, s.currency)) }, { label: 'Recharges', num: true, render: (s) => String(s.recharges) }], rows: d.settlements });
  const post = async (url, body, msg) => { try { const x = await api(url, { method: 'POST', body }); toast(x.direction ? `Settled: ${x.direction}${x.net ? ` (${fmt.money(Math.abs(x.net), x.currency)})` : ''}.` : msg, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; } };
  el.querySelectorAll('[data-iiss]').forEach((b) => b.addEventListener('click', () => post(`/v1/finance/intercompany/recharges/${b.dataset.iiss}/issue`, undefined, 'Issued.')));
  el.querySelectorAll('[data-ivoid]').forEach((b) => b.addEventListener('click', () => { const why = window.prompt('Why is it voided?'); if (why && why.trim()) post(`/v1/finance/intercompany/recharges/${b.dataset.ivoid}/void`, { reason: why.trim() }, 'Voided.'); }));
  el.querySelectorAll('[data-iset]').forEach((b) => b.addEventListener('click', () => { const [otherOrgId, currency] = b.dataset.iset.split('|'); const ref = window.prompt('Settlement reference (optional)') ?? ''; post('/v1/finance/intercompany/settle', { otherOrgId, currency, reference: ref.trim() || undefined }, 'Settled.'); }));
  const ent = `<select name="to">${others.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select>`;
  $('[data-inew]', el)?.addEventListener('click', () => modal({ title: 'Recharge a group entity', body: `<div class="form">${field('To', ent)}${field('Month', `<input name="m" type="month" value="${esc(lastMonthYm())}">`)}${field('Description', '<input name="d">')}${field('Amount', '<input name="a" type="number" min="1">')}${field('Currency', `<input name="c" value="${esc(LEGACY_CURRENCY)}">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Issue', kind: 'primary', onClick: (mc) => post('/v1/finance/intercompany/recharges', { toOrgId: $('[name="to"]', mc.el).value, month: $('[name="m"]', mc.el).value, description: $('[name="d"]', mc.el).value.trim(), amount: Number($('[name="a"]', mc.el).value), currency: $('[name="c"]', mc.el).value.trim() }, 'Issued.') }] }));
  $('[data-ialloc]', el)?.addEventListener('click', () => modal({ title: 'Allocate a cost across the group', subtitle: 'The other entities\' shares become draft recharges', body: `<div class="form">${field('Month', `<input name="m" type="month" value="${esc(lastMonthYm())}">`)}${field('Description', '<input name="d" placeholder="Head office rent">')}${field('Total', '<input name="t" type="number" min="1">')}${field('Currency', `<input name="c" value="${esc(LEGACY_CURRENCY)}">`)}${field('By', '<select name="b"><option value="kwh">kWh</option><option value="sessions">Sessions</option><option value="revenue">Revenue</option><option value="equal">Equally</option></select>')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Allocate', kind: 'primary', onClick: (mc) => post('/v1/finance/intercompany/allocate', { month: $('[name="m"]', mc.el).value, description: $('[name="d"]', mc.el).value.trim(), total: Number($('[name="t"]', mc.el).value), currency: $('[name="c"]', mc.el).value.trim(), basis: $('[name="b"]', mc.el).value }, 'Draft recharges made: review and issue them.') }] }));
}

// ─────────────────────────────────────────── (v1.31.0) scorecard

async function scorecardSection(host, canWrite, month = lastMonthYm()) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api(`/v1/finance/scorecard?month=${month}`); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = (m = month) => scorecardSection(host, canWrite, m);
  if (!d.currency) { el.innerHTML = callout('info', esc(d.message ?? 'No currency.')); return; }
  const v = (k, x) => (x == null ? '—' : k.money ? fmt.money(x, d.currency) : k.kpi.endsWith('Pct') ? `${x}%` : k.kpi === 'collectionDays' ? `${x} days` : fmt.num(Math.round(x)));
  const RAG = { green: 't-ok', amber: 't-warn', red: 't-crit' };
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Month', `<input type="month" data-sm value="${esc(month)}">`)}<div class="row" style="align-self:flex-end;gap:6px">${canWrite ? `<button class="btn primary" type="button" data-stgt>Targets</button><button class="btn" type="button" data-sset>E-mail</button><button class="btn" type="button" data-ssend>Send now</button>` : ''}</div></div>
    <div class="grid k4 section">${kpi('Green', String(d.counts.green), 'on target')}${kpi('Amber', String(d.counts.amber), `within ${d.settings.amberPct}%`, d.counts.amber ? 'warn' : '')}${kpi('Red', String(d.counts.red), 'off target', d.counts.red ? 'crit' : '')}${kpi('Currency', esc(d.currency), d.settings.enabled ? `e-mailed on day ${d.settings.day}` : 'not e-mailed')}</div>
    <div class="card section"><header><h3>Scorecard · ${esc(month)}</h3></header><div data-sk></div></div>
    <div class="card section"><header><h3>Six months</h3></header><div data-st></div></div>`;
  table($('[data-sk]', el), { columns: [
    { label: 'KPI', render: (k) => `<b>${esc(k.label)}</b>${k.lowerIsBetter ? '<div class="cell-sub">lower is better</div>' : ''}` },
    { label: 'Actual', num: true, render: (k) => esc(v(k, k.actual)) },
    { label: 'Target', num: true, render: (k) => esc(v(k, k.target)) },
    { label: 'Variance', num: true, render: (k) => (k.variancePct == null ? '' : `${k.variancePct > 0 ? '+' : ''}${k.variancePct}%`) },
    { label: '', render: (k) => (k.rag ? tag(RAG[k.rag], k.rag) : '<span class="cell-sub">no target</span>') },
  ], rows: d.kpis });
  table($('[data-st]', el), { columns: [{ label: 'KPI', render: (k) => esc(k.label) }, ...d.trend.map((t) => ({ label: t.month, num: true, render: (k) => esc(v(k, t.actuals[k.kpi])) }))], rows: d.kpis });
  $('[data-sm]', el).addEventListener('change', (e) => e.target.value && reload(e.target.value));
  $('[data-ssend]', el)?.addEventListener('click', async () => { try { const r = await api('/v1/finance/scorecard/send', { method: 'POST', body: { month } }); toast(r.error ? `Sent to ${r.sent}; ${r.error}` : `Sent to ${r.sent}.`, r.error ? 'warn' : 'ok'); } catch (err) { toast(err.message, 'crit'); } });
  $('[data-stgt]', el)?.addEventListener('click', () => modal({ title: `Targets · ${month}`, body: `<div class="form">${d.kpis.map((k) => field(`${k.label}${k.money ? ` (${d.currency})` : ''}`, `<input name="${esc(k.kpi)}" type="number" min="0" step="any" value="${k.target ?? ''}">`)).join('')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
      const targets = Object.fromEntries(d.kpis.map((k) => [k.kpi, $(`[name="${k.kpi}"]`, mc.el).value]).filter(([, x]) => x !== '').map(([k2, x]) => [k2, Number(x)]));
      try { await api(`/v1/finance/scorecard/targets/${month}`, { method: 'PUT', body: { targets } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] }));
  $('[data-sset]', el)?.addEventListener('click', () => modal({ title: 'Scorecard e-mail', body: `<div class="form">${field('Send it', `<select name="en"><option value="false">No</option><option value="true"${d.settings.enabled ? ' selected' : ''}>Yes, monthly</option></select>`)}${field('Day of the month', `<input name="day" type="number" min="1" max="28" value="${d.settings.day}">`)}${field('To (comma separated)', `<input name="to" value="${esc(d.settings.recipients.join(', '))}">`)}${field('Amber band %', `<input name="am" type="number" min="0" max="100" value="${d.settings.amberPct}">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
      try { await api('/v1/finance/scorecard/settings', { method: 'PUT', body: { enabled: $('[name="en"]', mc.el).value === 'true', day: Number($('[name="day"]', mc.el).value), recipients: $('[name="to"]', mc.el).value.split(',').map((x) => x.trim()).filter(Boolean), amberPct: Number($('[name="am"]', mc.el).value) } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] }));
}

/** (v1.32.0) Fetch a file from the API and save it. */
const fetchFile = async (url, name) => { try { const res = await api(url, { raw: true }); download(name, await res.blob()); } catch (err) { toast(err.message, 'crit'); } };

// ─────────────────────────────────────────── (v1.32.0) bank feeds and match rules

async function feedsSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d, accts;
  try { [d, accts] = await Promise.all([api('/v1/finance/bank-feeds'), api('/v1/finance/cash/accounts')]); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => feedsSection(host, canWrite);
  const banks = (accts.accounts ?? accts).filter((a) => a.kind === 'bank');
  el.innerHTML = `${callout('info', 'A feed fetches a bank account\'s mutations every hour from an HTTPS endpoint (a bank API adapter or an aggregator) and matches them like an uploaded statement. Lines nothing matched go through the rules: ignored with a note, or a journal entry suggested for approval in the Ledger.')}
    <div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-fnew>${icon('plus')} Add a feed</button><button class="btn" type="button" data-rnew>${icon('plus')} Add a rule</button><button class="btn" type="button" data-rapply>Apply the rules now</button>` : ''}<button class="btn" type="button" data-rprev>Preview the rules</button></div>
    <div class="card section"><header><h3>Feeds</h3></header><div data-fl></div></div>
    <div class="card section"><header><h3>Match rules</h3><span class="cell-sub">lower priority runs first; the first rule that fits wins</span></header><div data-rl></div></div>`;
  table($('[data-fl]', el), { columns: [
    { label: 'Feed', render: (f) => `<b>${esc(f.name)}</b><div class="cell-sub">${esc(f.cashAccount ?? '')} · ${esc(f.url)}</div>` },
    { label: 'Token', render: (f) => (f.hasToken ? tag('t-ok', 'set') : tag('t-mute', 'none')) },
    { label: 'Last run', render: (f) => (f.lastRunAt ? `${tag(f.lastStatus === 'ok' ? 't-ok' : 't-crit', f.lastStatus)} <span class="cell-sub">${esc(fmt.ago(f.lastRunAt))}</span>${f.lastError ? `<div class="cell-sub">${esc(f.lastError)}</div>` : ''}` : '<span class="cell-sub">never</span>') },
    { label: 'Lines', num: true, render: (f) => fmt.num(f.linesImported) },
    { label: '', render: (f) => (canWrite ? `<div class="row" style="gap:4px;justify-content:flex-end"><button ${BTN} data-frun="${f.id}">Run now</button><button ${BTN} data-fedit="${f.id}">Edit</button></div>` : '') },
  ], rows: d.feeds, empty: 'No feeds yet.' });
  table($('[data-rl]', el), { columns: [
    { label: 'Rule', render: (r) => `<b>${esc(r.name)}</b>${r.enabled ? '' : ` ${tag('t-mute', 'off')}`}<div class="cell-sub">priority ${r.priority}</div>` },
    { label: 'When', render: (r) => esc([r.direction === 'any' ? 'any direction' : r.direction === 'credit' ? 'money in' : 'money out', r.contains ? `contains “${r.contains}”` : null, r.amountMin != null ? `≥ ${fmt.num(r.amountMin)}` : null, r.amountMax != null ? `≤ ${fmt.num(r.amountMax)}` : null].filter(Boolean).join(' · ')) },
    { label: 'Then', render: (r) => (r.action === 'ignore' ? `ignore <span class="cell-sub">${esc(r.note ?? '')}</span>` : `suggest an entry to <b>${esc(r.accountCode)}</b>`) },
    { label: 'Matched', num: true, render: (r) => fmt.num(r.matchedCount) },
    { label: '', render: (r) => (canWrite ? `<button ${BTN} data-redit="${r.id}">Edit</button>` : '') },
  ], rows: d.rules, empty: 'No rules yet.' });
  const feedForm = (f) => modal({ title: f ? `Feed · ${f.name}` : 'Add a bank feed', body: `<div class="form">${field('Name', `<input name="name" value="${esc(f?.name ?? '')}">`)}${field('Bank account', `<select name="acct">${banks.map((a) => `<option value="${a.id}"${f?.cashAccountId === a.id ? ' selected' : ''}>${esc(a.name)} · ${esc(a.currency)}</option>`).join('')}</select>`)}
      ${field('Endpoint (https)', `<input name="url" value="${esc(f?.url ?? '')}" placeholder="https://feeds.example.com/accounts/123/mutations">`)}${field(f?.hasToken ? 'Token (leave empty to keep)' : 'Token', '<input name="token" type="password" autocomplete="off">', { opt: true })}
      ${field('Fetch from', `<input name="since" type="date" value="${esc(f?.since ?? '')}">`, { opt: true })}${field('Enabled', `<select name="en"><option value="true">Yes</option><option value="false"${f && !f.enabled ? ' selected' : ''}>No</option></select>`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
      try { await api(f ? `/v1/finance/bank-feeds/${f.id}` : '/v1/finance/bank-feeds', { method: f ? 'PUT' : 'POST', body: { name: v('name'), cashAccountId: v('acct'), url: v('url'), token: v('token'), since: v('since'), enabled: v('en') === 'true' } }); toast('Saved.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] });
  const ruleForm = (r) => modal({ title: r ? `Rule · ${r.name}` : 'Add a match rule', body: `<div class="form">${field('Name', `<input name="name" value="${esc(r?.name ?? '')}">`)}${field('Priority', `<input name="pr" type="number" min="0" max="10000" value="${r?.priority ?? 100}">`)}
      ${field('Direction', `<select name="dir">${[['any', 'Any'], ['credit', 'Money in'], ['debit', 'Money out']].map(([k, l]) => `<option value="${k}"${r?.direction === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}${field('Description contains', `<input name="ct" value="${esc(r?.contains ?? '')}" placeholder="e.g. BIAYA ADM">`, { opt: true })}
      ${field('Amount from', `<input name="mn" type="number" min="0" value="${r?.amountMin ?? ''}">`, { opt: true })}${field('Amount to', `<input name="mx" type="number" min="0" value="${r?.amountMax ?? ''}">`, { opt: true })}
      ${field('Then', `<select name="ac"><option value="ignore">Ignore the line</option><option value="suggest"${r?.action === 'suggest' ? ' selected' : ''}>Suggest a journal entry</option></select>`)}${field('Account (for a suggestion)', `<input name="code" value="${esc(r?.accountCode ?? '')}" placeholder="e.g. 7300">`, { opt: true })}
      ${field('Note (for ignored lines)', `<input name="note" value="${esc(r?.note ?? '')}" placeholder="e.g. Bank fee">`, { opt: true })}${field('Enabled', `<select name="en"><option value="true">Yes</option><option value="false"${r && !r.enabled ? ' selected' : ''}>No</option></select>`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
      try { await api(r ? `/v1/finance/bank-rules/${r.id}` : '/v1/finance/bank-rules', { method: r ? 'PUT' : 'POST', body: { name: v('name'), priority: v('pr'), direction: v('dir'), contains: v('ct'), amountMin: v('mn'), amountMax: v('mx'), action: v('ac'), accountCode: v('code'), note: v('note'), enabled: v('en') === 'true' } }); toast('Saved.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] });
  $('[data-fnew]', el)?.addEventListener('click', () => (banks.length ? feedForm(null) : toast('Add a bank account first (Finance → Cash).', 'warn')));
  $('[data-rnew]', el)?.addEventListener('click', () => ruleForm(null));
  $('[data-rapply]', el)?.addEventListener('click', async () => { try { const x = await api('/v1/finance/bank-rules/apply', { method: 'POST', body: {} }); toast(`${x.ignored} ignored, ${x.suggested} entr${x.suggested === 1 ? 'y' : 'ies'} suggested.`, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); } });
  $('[data-rprev]', el).addEventListener('click', async () => {
    let p;
    try { p = await api('/v1/finance/bank-rules/preview'); } catch (err) { toast(err.message, 'crit'); return; }
    modal({ title: 'What the rules would take', subtitle: `${p.lines.length} of ${p.open} open line${p.open === 1 ? '' : 's'}`, size: 'lg', body: '<div data-pv></div>', onMount(mc) {
      table($('[data-pv]', mc.el), { columns: [{ label: 'Date', render: (l) => esc(l.date) }, { label: 'Line', render: (l) => esc(l.description) }, { label: 'Amount', num: true, render: (l) => fmt.num(l.amount) }, { label: 'Rule', render: (l) => `${esc(l.rule)} <span class="cell-sub">${esc(l.action)}</span>` }], rows: p.lines, empty: 'No open line fits a rule.' });
    }, actions: [{ label: 'Close' }] });
  });
  el.addEventListener('click', async (e) => {
    const run = e.target.closest('[data-frun]'), fe = e.target.closest('[data-fedit]'), re = e.target.closest('[data-redit]');
    if (run) {
      run.disabled = true;
      try { const x = await api(`/v1/finance/bank-feeds/${run.dataset.frun}/run`, { method: 'POST', body: {} }); toast(`${x.added} new line${x.added === 1 ? '' : 's'} (${x.duplicates} already in); ${x.matched} matched, ${x.ignored} ignored, ${x.suggested} suggested.`, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); run.disabled = false; }
    }
    if (fe) feedForm(d.feeds.find((f) => f.id === fe.dataset.fedit));
    if (re) ruleForm(d.rules.find((r) => r.id === re.dataset.redit));
  });
}

// ─────────────────────────────────────────── (v1.32.0) withholding slips (e-Bupot)

const SLIP_ST = { draft: ['t-warn', 'draft'], issued: ['t-ok', 'issued'], void: ['t-mute', 'void'] };

async function slipsSection(host, canWrite, month = lastMonthYm()) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api(`/v1/finance/tax/slips?month=${month}`); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = (m = month) => slipsSection(host, canWrite, m);
  const cur = d.slips[0]?.currency ?? LEGACY_CURRENCY;
  const t = (k) => d.totals[k] ?? { count: 0, tax: 0 };
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Month', `<input type="month" data-wm value="${esc(month)}">`)}<div class="row" style="align-self:flex-end;gap:6px">${canWrite ? '<button class="btn primary" type="button" data-wdraft>Draft from the bills</button>' : ''}<button class="btn" type="button" data-wx>${icon('download')} e-Bupot (Excel)</button></div></div>
    ${callout('info', 'What a bill withholds follows the supplier: a company PPh 23 at its rate; an individual PPh 21 (Pasal 17 on half the gross, 20% more without an NPWP or NIK); a supplier abroad PPh 26 at the treaty rate, else 20%. Set it on the supplier (Bills → Suppliers).')}
    ${d.billsNotOnSlip ? callout('warn', `${d.billsNotOnSlip} bill${d.billsNotOnSlip === 1 ? '' : 's'} withholding tax ${d.billsNotOnSlip === 1 ? 'is' : 'are'} on no slip: draft again (an issued slip is not changed; void and reissue it).`) : ''}
    <div class="grid k4 section">${kpi('PPh 21', esc(fmt.money(t('pph21').tax, cur)), `${t('pph21').count} slip(s)`)}${kpi('PPh 23', esc(fmt.money(t('pph23').tax, cur)), `${t('pph23').count} slip(s)`)}${kpi('PPh 26', esc(fmt.money(t('pph26').tax, cur)), `${t('pph26').count} slip(s)`)}${kpi('Not issued', String(d.slips.filter((s) => s.status === 'draft').length), 'drafts', d.slips.some((s) => s.status === 'draft') ? 'warn' : '')}</div>
    <div class="card section"><header><h3>Withholding slips · ${esc(month)}</h3></header><div data-wl></div></div>`;
  table($('[data-wl]', el), { columns: [
    { label: 'Payee', render: (s) => `<b>${esc(s.supplier)}</b><div class="cell-sub">${esc(s.taxId ?? s.idNumber ?? 'no NPWP or NIK')}${s.country && s.country !== 'ID' ? ` · ${esc(s.country)}` : ''}</div>` },
    { label: 'Kind', render: (s) => esc(s.label) },
    { label: 'Gross', num: true, render: (s) => esc(fmt.money(s.gross, s.currency)) },
    { label: 'DPP', num: true, render: (s) => esc(fmt.money(s.dpp, s.currency)) },
    { label: 'Rate', num: true, render: (s) => `${s.ratePct}%` },
    { label: 'Tax', num: true, render: (s) => `<b>${esc(fmt.money(s.tax, s.currency))}</b>` },
    { label: 'Status', render: (s) => `${tag(...SLIP_ST[s.status])}${s.number ? `<div class="cell-sub">${esc(s.number)} · ${esc(s.issuedOn ?? '')}</div>` : ''}${s.voidReason ? `<div class="cell-sub">${esc(s.voidReason)}</div>` : ''}` },
    { label: '', render: (s) => (!canWrite || s.status === 'void' ? '' : `<div class="row" style="gap:4px;justify-content:flex-end">${s.status === 'draft' ? `<button ${BTN} data-wiss="${s.id}">Issue…</button>` : ''}<button ${BTN} data-wvoid="${s.id}">Void…</button></div>`) },
  ], rows: d.slips, empty: 'No slips for the month: draft them from the bills.' });
  $('[data-wm]', el).addEventListener('change', (e) => e.target.value && reload(e.target.value));
  $('[data-wx]', el).addEventListener('click', () => fetchFile(`/v1/finance/tax/slips/${month}/ebupot`, `plugsure-ebupot-${month}.xlsx`));
  $('[data-wdraft]', el)?.addEventListener('click', async () => { try { const x = await api(`/v1/finance/tax/slips/${month}/draft`, { method: 'POST', body: {} }); toast(`${x.created} new, ${x.updated} updated${x.issuedChanged ? `; ${x.issuedChanged} issued slip(s) whose bills changed` : ''}.`, x.issuedChanged ? 'warn' : 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); } });
  el.addEventListener('click', (e) => {
    const iss = e.target.closest('[data-wiss]'), vd = e.target.closest('[data-wvoid]');
    if (iss) modal({ title: 'Issue the slip', body: `<div class="form">${field('Number', '<input name="no" placeholder="the Coretax number, or leave empty">', { opt: true })}${field('Date', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Issue', kind: 'primary', async onClick(mc) {
        try { await api(`/v1/finance/tax/slips/${iss.dataset.wiss}/issue`, { method: 'POST', body: { number: $('[name="no"]', mc.el).value.trim(), issuedOn: $('[name="on"]', mc.el).value } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
      } }] });
    if (vd) modal({ title: 'Void the slip', body: `<div class="form one">${field('Reason', '<input name="why" maxlength="300">')}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Void', kind: 'danger', async onClick(mc) {
        try { await api(`/v1/finance/tax/slips/${vd.dataset.wvoid}/void`, { method: 'POST', body: { reason: $('[name="why"]', mc.el).value.trim() } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
      } }] });
  });
}

// ─────────────────────────────────────────── (v1.32.0) management report pack

const PACK_ST = { draft: ['t-mute', 'draft'], in_review: ['t-warn', 'in review'], approved: ['t-info', 'approved'], sent: ['t-ok', 'sent'] };
const PACK_SECTIONS = [['summary', 'Summary'], ['results', 'Results'], ['cash', 'Cash'], ['scorecard', 'Scorecard'], ['sites', 'Sites'], ['payables', 'Payables']];
// (v1.36.0) the board sections: commentary only where the pack has the section.
const BOARD_SECTIONS = [['risk', 'Risk and compliance'], ['lenders', 'Lenders'], ['sustainability', 'Sustainability'], ['grants', 'Grants']];
const packSections = (p) => [...PACK_SECTIONS, ...BOARD_SECTIONS.filter(([k]) => p.data.board?.[k])];

async function reportsSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api('/v1/finance/report-packs'); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => reportsSection(host, canWrite);
  const canApprove = state.can('finance:approve');
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-knew>${icon('plus')} Draft a pack</button><button class="btn" type="button" data-kset>Recipients</button>` : ''}</div>
    ${callout('info', `A month's pack for the board or the owners: results against budget, cash and the 13-week low, the scorecard, sites and payables, and where in use risk and compliance, lenders, sustainability and grants, with commentary; as a PDF, slides (16:9) and Excel. Drafted, submitted, approved by a second Finance Manager, then e-mailed with the PDF and Excel to ${d.settings.recipients.length ? esc(d.settings.recipients.join(', ')) : 'the recipients (none set)'}.`)}
    ${d.trend?.length > 1 ? `<div class="card section"><header><h3>Twelve months</h3><span class="cell-sub">revenue and result of the last packs</span></header><div data-ktr style="padding:12px 16px"></div></div>` : ''}
    <div class="card section"><header><h3>Report packs</h3></header><div data-kl></div></div>`;
  if (d.trend?.length > 1) {
    const max = Math.max(1, ...d.trend.map((t) => Math.abs(t.revenue)), ...d.trend.map((t) => Math.abs(t.result)));
    $('[data-ktr]', el).innerHTML = `<div style="display:flex;align-items:flex-end;gap:10px;height:120px;overflow-x:auto">${d.trend.map((t) => `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;min-width:42px" title="${esc(t.month)}: revenue ${esc(fmt.money(t.revenue, t.currency))}, result ${esc(fmt.money(t.result, t.currency))}"><div style="display:flex;align-items:flex-end;gap:3px;height:96px"><span style="width:12px;height:${Math.max(2, Math.round((Math.abs(t.revenue) / max) * 96))}px;background:var(--accent);opacity:.45;border-radius:2px"></span><span style="width:12px;height:${Math.max(2, Math.round((Math.abs(t.result) / max) * 96))}px;background:${t.result < 0 ? 'var(--crit, #c0392b)' : 'var(--accent)'};border-radius:2px"></span></div><span class="cell-sub">${esc(t.month.slice(2))}</span></div>`).join('')}</div>`;
  }
  table($('[data-kl]', el), { columns: [
    { label: 'Month', render: (p) => `<b>${esc(p.month)}</b> <span class="cell-sub">${esc(p.currency)}</span>` },
    { label: 'Result', num: true, render: (p) => (p.result == null ? '—' : esc(fmt.money(p.result, p.currency))) },
    { label: 'Status', render: (p) => `${tag(...PACK_ST[p.status])}<div class="cell-sub">${esc([p.submittedBy && `submitted by ${p.submittedBy}`, p.approvedBy && `approved by ${p.approvedBy}`, p.sentAt && `sent to ${p.sentTo}`].filter(Boolean).join(' · '))}</div>` },
    { label: '', render: (p) => `<button ${BTN} data-kopen="${p.id}">Open</button>` },
  ], rows: d.packs, empty: 'No packs yet.' });
  const open = async (id) => {
    let p;
    try { p = await api(`/v1/finance/report-packs/${id}`); } catch (err) { toast(err.message, 'crit'); return; }
    const x = p.data, c = p.currency, m = (v) => (v == null ? '—' : fmt.money(v, c));
    const editable = canWrite && (p.status === 'draft' || p.status === 'in_review');
    drawer({ title: `Report pack · ${p.month}`, subtitle: `${PACK_ST[p.status][1]} · figures of ${p.data.composedAt.slice(0, 10)}`, tabs: [
      { id: 'figures', label: 'Figures', render(body) {
        body.innerHTML = `<div class="grid k4">${kpi('Result', esc(m(x.results.month.result)), `year to date ${esc(m(x.results.yearToDate.result))}`, x.results.month.result < 0 ? 'crit' : '')}${kpi('Revenue', esc(m(x.results.month.revenue)), x.results.budget?.revenue ? `budget ${esc(m(x.results.budget.revenue))}` : 'no budget')}${kpi('Cash', esc(m(x.cash.atMonthEnd)), `13-week low ${esc(m(x.cash.lowest13Weeks))}`)}${kpi('Payables', esc(m(x.payables.total)), `${esc(m(x.payables.overdue))} overdue`, x.payables.overdue ? 'warn' : '')}</div>
          ${x.results.ledgerEmpty ? callout('warn', 'The ledger has nothing for this currency: sync the month (Finance → Ledger), then refresh the draft.') : ''}
          <h4 style="margin:14px 0 6px">Scorecard</h4><div data-ks></div><h4 style="margin:14px 0 6px">Top sites</h4><div data-kt></div>`;
        table($('[data-ks]', body), { columns: [{ label: 'KPI', render: (k) => esc(k.label) }, { label: 'Actual', num: true, render: (k) => esc(k.actual == null ? '—' : k.money ? m(k.actual) : fmt.num(Math.round(k.actual * 10) / 10)) }, { label: 'Target', num: true, render: (k) => esc(k.target == null ? '—' : k.money ? m(k.target) : fmt.num(k.target)) }, { label: '', render: (k) => (k.rag ? tag({ green: 't-ok', amber: 't-warn', red: 't-crit' }[k.rag], k.rag) : '') }], rows: x.scorecard.kpis });
        table($('[data-kt]', body), { columns: [{ label: 'Site', render: (s) => esc(s.name) }, { label: 'Revenue', num: true, render: (s) => esc(m(s.revenue)) }, { label: 'Margin', num: true, render: (s) => (s.marginPct == null ? '—' : `${s.marginPct}%`) }], rows: x.sites.top, empty: 'No site revenue.' });
      } },
      ...(x.board && (x.board.risk || x.board.lenders || x.board.sustainability || x.board.grants) ? [{ id: 'board', label: 'Board', render(body) {
        const b = x.board, r = b.risk;
        const rows = [];
        if (r?.compliance) rows.push(['Compliance deadlines', `${r.compliance.overdue} overdue · ${r.compliance.dueIn30} due in 30 days`, r.compliance.overdue ? 'crit' : ''], ['Auditor requests open', String(r.compliance.pbcOpen), '']);
        if (r?.insurance) rows.push(['Insurance', `${r.insurance.renewing} to renew · ${r.insurance.openClaims} open claim(s)`, r.insurance.renewing ? 'warn' : '']);
        if (r?.chargebacks) rows.push(['Chargebacks', `${r.chargebacks.open} open (${m(r.chargebacks.openAmount)}) · ${m(r.chargebacks.lostAmount)} lost`, r.chargebacks.open ? 'warn' : '']);
        if (r?.grants) rows.push(['Grant conditions', `${r.grants.conditionsDue} due in 30 days · ${r.grants.breached} breached`, r.grants.breached ? 'crit' : '']);
        body.innerHTML = `${rows.length ? `<h4 style="margin:0 0 6px">Risk and compliance</h4><div data-kbr></div>` : ''}
          ${b.lenders ? '<h4 style="margin:14px 0 6px">Lenders</h4><div data-kbl></div>' : ''}
          ${b.sustainability || b.grants ? `<div class="grid k4" style="margin-top:14px">${b.sustainability ? `${kpi('Charged', `${b.sustainability.mwh.toLocaleString(undefined, { maximumFractionDigits: 1 })} MWh`, `${b.sustainability.recMwh.toLocaleString(undefined, { maximumFractionDigits: 1 })} MWh of RECs`)}${kpi('Green share', `${b.sustainability.greenPct}%`, `${b.sustainability.avoidedTonnes.toLocaleString(undefined, { maximumFractionDigits: 2 })} t CO2e avoided`)}` : ''}${b.grants ? `${kpi('Grants deferred', esc(m(b.grants.deferred)), `${esc(m(b.grants.received))} received`)}${kpi('Grants repayable', esc(m(b.grants.repayable)), `${esc(m(b.grants.toClaim))} still to claim`, b.grants.repayable ? 'warn' : '')}` : ''}</div>` : ''}`;
        if (rows.length) table($('[data-kbr]', body), { columns: [{ label: 'Area', render: (x2) => esc(x2[0]) }, { label: '', render: (x2) => (x2[2] ? tag(x2[2] === 'crit' ? 't-crit' : 't-warn', x2[1]) : esc(x2[1])) }], rows });
        if (b.lenders) table($('[data-kbl]', body), { columns: [{ label: 'Covenant', render: (t) => `${esc(t.lender ?? 'Overall')} · ${esc(t.kind)}` }, { label: 'Threshold', num: true, render: (t) => `${t.direction === 'min' ? '≥' : '≤'} ${t.kind === 'min_cash' ? esc(m(t.threshold)) : t.threshold}` }, { label: 'Value', num: true, render: (t) => (t.value == null ? '—' : t.kind === 'min_cash' ? esc(m(t.value)) : String(t.value)) }, { label: '', render: (t) => (!t.tested ? '<span class="cell-sub">not tested</span>' : t.passed === false ? tag('t-crit', 'breach') : tag('t-ok', 'met')) }], rows: b.lenders });
      } }] : []),
      { id: 'commentary', label: 'Commentary', render(body) {
        body.innerHTML = `${p.commentary.review ? callout('warn', `Sent back: ${esc(p.commentary.review)}`) : ''}<div class="form one">${packSections(p).map(([k, l]) => field(l, `<textarea name="c_${k}" rows="3" maxlength="4000"${editable ? '' : ' disabled'}>${esc(p.commentary[k] ?? '')}</textarea>`, { opt: k !== 'summary' })).join('')}</div>
          <div class="row" style="gap:6px;margin-top:10px;flex-wrap:wrap">${editable ? `<button ${BTN} data-ksave>Save the commentary</button>` : ''}${canWrite && p.status === 'draft' ? `<button ${BTN} data-krefresh>Refresh the figures</button><button class="btn sm primary" type="button" data-ksub>Submit for review</button>` : ''}${canWrite && canApprove && p.status === 'in_review' ? `<button class="btn sm primary" type="button" data-kapp>Approve</button>` : ''}${canWrite && (p.status === 'in_review' || (p.status === 'approved' && canApprove)) ? `<button ${BTN} data-kback>Send back…</button>` : ''}${canWrite && (p.status === 'approved' || p.status === 'sent') ? `<button class="btn sm primary" type="button" data-ksend>E-mail it</button>` : ''}<button ${BTN} data-kpdf>${icon('download')} PDF</button><button ${BTN} data-kslides>${icon('download')} Slides</button><button ${BTN} data-kxls>${icon('download')} Excel</button></div>`;
        const act = async (fn, msg) => { try { await fn(); toast(msg, 'ok'); reload(); return true; } catch (err) { toast(err.message, 'crit'); return false; } };
        const save = () => api(`/v1/finance/report-packs/${p.id}/commentary`, { method: 'PUT', body: { commentary: Object.fromEntries(packSections(p).map(([k]) => [k, $(`[name="c_${k}"]`, body).value])) } });
        $('[data-ksave]', body)?.addEventListener('click', () => act(save, 'Saved.'));
        $('[data-krefresh]', body)?.addEventListener('click', () => act(() => api('/v1/finance/report-packs', { method: 'POST', body: { month: p.month, currency: p.currency } }), 'Figures refreshed.'));
        $('[data-ksub]', body)?.addEventListener('click', () => act(async () => { await save(); await api(`/v1/finance/report-packs/${p.id}/submit`, { method: 'POST', body: {} }); }, 'Submitted for review.'));
        $('[data-kapp]', body)?.addEventListener('click', () => act(() => api(`/v1/finance/report-packs/${p.id}/approve`, { method: 'POST', body: {} }), 'Approved.'));
        $('[data-ksend]', body)?.addEventListener('click', async () => { try { const r = await api(`/v1/finance/report-packs/${p.id}/send`, { method: 'POST', body: {} }); toast(r.error ? `Sent to ${r.sent}; ${r.error}` : `Sent to ${r.sent}.`, r.error ? 'warn' : 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); } });
        $('[data-kback]', body)?.addEventListener('click', () => modal({ title: 'Send the pack back', body: `<div class="form one">${field('Why', '<input name="why" maxlength="1000">')}</div>`,
          actions: [{ label: 'Cancel' }, { label: 'Send back', kind: 'primary', onClick: (mc) => act(() => api(`/v1/finance/report-packs/${p.id}/send-back`, { method: 'POST', body: { reason: $('[name="why"]', mc.el).value.trim() } }), 'Sent back to draft.') }] }));
        $('[data-kpdf]', body).addEventListener('click', () => fetchFile(`/v1/finance/report-packs/${p.id}?format=pdf`, `management-report-${p.month}.pdf`));
        $('[data-kxls]', body).addEventListener('click', () => fetchFile(`/v1/finance/report-packs/${p.id}?format=xlsx`, `management-report-${p.month}.xlsx`));
        $('[data-kslides]', body).addEventListener('click', () => fetchFile(`/v1/finance/report-packs/${p.id}?format=slides`, `board-pack-${p.month}.pdf`));
      } },
    ] });
  };
  $('[data-knew]', el)?.addEventListener('click', () => modal({ title: 'Draft a report pack', body: `<div class="form one">${field('Month', `<input name="m" type="month" value="${esc(lastMonthYm())}">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Draft', kind: 'primary', async onClick(mc) {
      try { const p = await api('/v1/finance/report-packs', { method: 'POST', body: { month: $('[name="m"]', mc.el).value } }); reload(); open(p.id); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] }));
  $('[data-kset]', el)?.addEventListener('click', () => modal({ title: 'Report pack recipients', body: `<div class="form one">${field('E-mail to (comma separated)', `<input name="to" value="${esc(d.settings.recipients.join(', '))}">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
      try { await api('/v1/finance/report-packs/settings', { method: 'PUT', body: { recipients: $('[name="to"]', mc.el).value } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] }));
  el.addEventListener('click', (e) => { const o = e.target.closest('[data-kopen]'); if (o) open(o.dataset.kopen); });
}

// ─────────────────────────────────────────── (v1.32.0) month close steps

async function closeStepsSection(host, canWrite, month = lastMonthYm()) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api(`/v1/finance/close?month=${month}`); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = (m = month) => closeStepsSection(host, canWrite, m);
  const canApprove = state.can('finance:approve');
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Month', `<input type="month" data-cm value="${esc(month)}">`)}<div class="row" style="align-self:flex-end;gap:6px"><button class="btn" type="button" data-cev>${icon('download')} Evidence pack</button>${canWrite && canApprove ? `<button class="btn" type="button" data-cpol>Policy: ${d.policy.enforce ? 'enforced' : 'not enforced'}</button>` : ''}</div></div>
    <div class="grid k4 section">${kpi('Signed off', `${d.done} / ${d.total}`, d.ready ? 'every step' : 'steps', d.ready ? '' : 'warn')}${kpi('Month', d.locked ? 'locked' : 'open', d.locked ? 'reopen it in Close to change it' : d.canLock ? 'can be locked' : 'locked only once signed off', d.locked ? '' : d.canLock ? '' : 'warn')}${kpi('Policy', d.policy.enforce ? 'enforced' : 'advisory', d.policy.enforce ? 'every step before the lock' : 'the lock is not held')}${kpi('Checks out', String(d.steps.filter((s) => s.ok).length), `of ${d.total} from the data`)}</div>
    <div class="card section"><header><h3>Close steps · ${esc(month)}</h3></header><div data-cl></div></div>`;
  table($('[data-cl]', el), { columns: [
    { label: 'Step', render: (s) => `<b>${esc(s.label)}</b><div class="cell-sub">${esc(s.detail)}</div>` },
    { label: 'Check', render: (s) => tag(s.ok ? 't-ok' : 't-warn', s.ok ? 'checks out' : 'open') },
    { label: 'Sign-off', render: (s) => (s.signoff ? `${tag(s.signoff.accepted ? 't-warn' : 't-ok', s.signoff.accepted ? 'accepted as is' : 'signed off')}<div class="cell-sub">${esc(s.signoff.by ?? '')} · ${esc(fmt.ago(s.signoff.at))}${s.signoff.note ? ` · ${esc(s.signoff.note)}` : ''}</div>` : '<span class="cell-sub">not yet</span>') },
    { label: '', render: (s) => (!canWrite || d.locked ? '' : s.signoff ? `<button ${BTN} data-crev="${s.step}">Withdraw</button>` : s.ok || canApprove ? `<button class="btn sm${s.ok ? ' primary' : ''}" style="white-space:nowrap" type="button" data-csign="${s.step}" data-ok="${s.ok}">${s.ok ? 'Sign off' : 'Accept as is…'}</button>` : '') },
  ], rows: d.steps });
  $('[data-cm]', el).addEventListener('change', (e) => e.target.value && reload(e.target.value));
  $('[data-cev]', el).addEventListener('click', () => fetchFile(`/v1/finance/close/${month}/evidence`, `plugsure-close-evidence-${month}.xlsx`));
  $('[data-cpol]', el)?.addEventListener('click', async () => { try { await api('/v1/finance/close/policy', { method: 'PUT', body: { enforce: !d.policy.enforce } }); reload(); } catch (err) { toast(err.message, 'crit'); } });
  el.addEventListener('click', async (e) => {
    const sb = e.target.closest('[data-csign]'), rb = e.target.closest('[data-crev]');
    if (sb) {
      const step = sb.dataset.csign, ok = sb.dataset.ok === 'true';
      modal({ title: ok ? 'Sign off the step' : 'Accept the step as it is', subtitle: d.steps.find((s) => s.step === step).label, body: `<div class="form one">${field(ok ? 'Note' : 'Why it is accepted', '<input name="note" maxlength="500">', { opt: ok })}</div>`,
        actions: [{ label: 'Cancel' }, { label: ok ? 'Sign off' : 'Accept', kind: 'primary', async onClick(mc) {
          try { await api(`/v1/finance/close/${month}/steps/${step}/sign-off`, { method: 'POST', body: { note: $('[name="note"]', mc.el).value.trim() } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
        } }] });
    }
    if (rb) { try { await api(`/v1/finance/close/${month}/steps/${rb.dataset.crev}/revoke`, { method: 'POST', body: {} }); reload(); } catch (err) { toast(err.message, 'crit'); } }
  });
}

// ─────────────────────────────────────────── (v1.33.0) payroll

const RUN_ST = { draft: ['t-mute', 'draft'], awaiting_approval: ['t-warn', 'awaiting approval'], approved: ['t-info', 'approved'], paid: ['t-ok', 'paid'], void: ['t-mute', 'void'] };

async function payrollSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d, accts;
  try { [d, accts] = await Promise.all([api('/v1/finance/payroll'), api('/v1/finance/cash/accounts')]); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => payrollSection(host, canWrite);
  const active = d.employees.filter((e) => e.active);
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-yrun>${icon('plus')} Draft a payroll</button><button class="btn" type="button" data-ynew>${icon('plus')} Add an employee</button>` : ''}</div>
    ${callout('info', 'BPJS Kesehatan 5% (4% employer, 1% employee) and JP 3% are capped; JHT 5.7%, JKK and JKM 0.3%. PPh 21 by the TER rates January to November and the year\'s Pasal 17 calculation in December (or a leaver\'s last month). Approved under the approvals matrix (Payroll runs).')}
    <div class="grid k4 section">${kpi('Employees', String(active.length), `${d.employees.length - active.length} left`)}${kpi('Last run', d.runs[0] ? esc(d.runs[0].month) : '—', d.runs[0] ? RUN_ST[d.runs[0].status][1] : 'none yet')}${kpi('Net pay', d.runs[0]?.totals?.net != null ? esc(fmt.money(d.runs[0].totals.net, d.runs[0].currency)) : '—', 'last run')}${kpi('Employer cost', d.runs[0]?.totals?.cost != null ? esc(fmt.money(d.runs[0].totals.cost, d.runs[0].currency)) : '—', 'salaries and BPJS')}</div>
    <div class="card section"><header><h3>Payroll runs</h3></header><div data-yl></div></div>
    <div class="card section"><header><h3>Employees</h3></header><div data-ye></div></div>`;
  table($('[data-yl]', el), { columns: [
    { label: 'Month', render: (r) => `<b>${esc(r.month)}</b> <span class="cell-sub">${esc(r.currency)}</span>` },
    { label: 'Employees', num: true, render: (r) => String(r.totals?.employees ?? 0) },
    { label: 'Gross', num: true, render: (r) => esc(fmt.money(r.totals?.wages ?? 0, r.currency)) },
    { label: 'PPh 21', num: true, render: (r) => esc(fmt.money(r.totals?.pph21 ?? 0, r.currency)) },
    { label: 'Net pay', num: true, render: (r) => `<b>${esc(fmt.money(r.totals?.net ?? 0, r.currency))}</b>` },
    { label: 'Status', render: (r) => `${tag(...RUN_ST[r.status])}${r.paidOn ? `<div class="cell-sub">paid ${esc(r.paidOn)}</div>` : ''}` },
    { label: '', render: (r) => `<button ${BTN} data-yopen="${r.id}">Open</button>` },
  ], rows: d.runs, empty: 'No payroll yet.' });
  table($('[data-ye]', el), { columns: [
    { label: 'Employee', render: (e) => `<b>${esc(e.name)}</b> <span class="cell-sub">${esc(e.number)}</span><div class="cell-sub">${esc(e.position ?? '')}${e.active ? '' : ` · left ${esc(e.endOn)}`}</div>` },
    { label: 'PTKP', render: (e) => `${esc(e.ptkp)} <span class="cell-sub">TER ${esc(e.category)}</span>` },
    { label: 'Salary', num: true, render: (e) => esc(fmt.money(e.baseSalary, e.currency)) },
    { label: 'Allowances', num: true, render: (e) => esc(fmt.money(e.allowance, e.currency)) },
    { label: 'BPJS', render: (e) => esc([e.bpjsKesehatan ? 'Kesehatan' : null, e.bpjsKetenagakerjaan ? `TK (JKK ${e.jkkRatePct}%)` : null].filter(Boolean).join(' · ') || 'none') },
    { label: 'Bank', render: (e) => (e.bank ? `${esc(e.bank.name)} ···${esc(e.bank.accountLast4 ?? '')}` : '<span class="cell-sub">none</span>') },
    { label: '', render: (e) => (canWrite ? `<button ${BTN} data-yedit="${e.id}">Edit</button>` : '') },
  ], rows: d.employees, empty: 'No employees yet.' });
  const empForm = (e) => modal({ title: e ? `${e.name} · ${e.number}` : 'Add an employee', size: 'lg', body: `<div class="form">${field('Name', `<input name="name" value="${esc(e?.name ?? '')}">`)}${field('Position', `<input name="pos" value="${esc(e?.position ?? '')}">`, { opt: true })}
      ${field('NIK', `<input name="nik" maxlength="16" value="${esc(e?.nik ?? '')}">`, { opt: true })}${field('NPWP', `<input name="npwp" value="${esc(e?.npwp ?? '')}">`, { opt: true })}
      ${field('PTKP', `<select name="ptkp">${['TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3'].map((p) => `<option${e?.ptkp === p ? ' selected' : ''}>${p}</option>`).join('')}</select>`)}${field('Currency', `<input name="cur" maxlength="3" value="${esc(e?.currency ?? LEGACY_CURRENCY)}">`)}
      ${field('Base salary', `<input name="base" type="number" min="0" value="${e?.baseSalary ?? ''}">`)}${field('Fixed allowances', `<input name="alw" type="number" min="0" value="${e?.allowance ?? 0}">`)}
      ${field('BPJS Kesehatan', `<select name="kes"><option value="true">Yes</option><option value="false"${e && !e.bpjsKesehatan ? ' selected' : ''}>No</option></select>`)}${field('BPJS Ketenagakerjaan', `<select name="tk"><option value="true">Yes</option><option value="false"${e && !e.bpjsKetenagakerjaan ? ' selected' : ''}>No</option></select>`)}
      ${field('JKK rate %', `<input name="jkk" type="number" step="0.01" min="0" max="2" value="${e?.jkkRatePct ?? 0.24}">`)}${field('Started', `<input name="start" type="date" value="${esc(e?.startOn ?? '')}">`)}${field('Left', `<input name="end" type="date" value="${esc(e?.endOn ?? '')}">`, { opt: true })}
      ${field('Bank', `<input name="bn" value="${esc(e?.bank?.name ?? '')}">`, { opt: true })}${field(e?.bank ? 'Account number (leave empty to keep)' : 'Account number', '<input name="ba" inputmode="numeric">', { opt: true })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
      const body = { name: v('name'), position: v('pos'), nik: v('nik'), npwp: v('npwp'), ptkp: v('ptkp'), currency: v('cur'), baseSalary: Number(v('base') || 0), allowance: Number(v('alw') || 0),
        bpjsKesehatan: v('kes') === 'true', bpjsKetenagakerjaan: v('tk') === 'true', jkkRatePct: v('jkk'), startOn: v('start'), endOn: v('end') };
      if (v('ba') || !e) body.bank = v('bn') ? { name: v('bn'), accountNumber: v('ba') || undefined } : null;
      try { await api(e ? `/v1/finance/payroll/employees/${e.id}` : '/v1/finance/payroll/employees', { method: e ? 'PUT' : 'POST', body }); toast('Saved.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] });
  const openRun = async (id) => {
    let r;
    try { r = await api(`/v1/finance/payroll/runs/${id}`); } catch (err) { toast(err.message, 'crit'); return; }
    const c = r.currency, m = (x) => fmt.money(x, c);
    const act = async (path, body, msg) => { try { const x = await api(`/v1/finance/payroll/runs/${r.id}/${path}`, { method: 'POST', body: body ?? {} }); toast(x.waitingForSecondApprover ? 'First approval recorded: a second approver is needed.' : msg, 'ok'); reload(); return true; } catch (err) { toast(err.message, 'crit'); return false; } };
    drawer({ title: `Payroll · ${r.month}`, subtitle: `${RUN_ST[r.status][1]} · ${c}`, tabs: [{ id: 'lines', label: 'Lines', render(body) {
      body.innerHTML = `<div class="grid k4">${kpi('Gross', esc(m(r.totals.wages)), `${r.totals.employees} employee(s)`)}${kpi('PPh 21', esc(m(r.totals.pph21)), 'withheld')}${kpi('BPJS', esc(m(r.totals.employerBpjs + r.totals.employeeBpjs)), 'employer and employee')}${kpi('Net pay', esc(m(r.totals.net)), r.paidOn ? `paid ${esc(r.paidOn)}` : 'to transfer')}</div>
        <div data-rl style="margin-top:10px"></div>
        <div class="row" style="gap:6px;margin-top:10px;flex-wrap:wrap">${canWrite && r.status === 'draft' ? `<button class="btn sm primary" type="button" data-rsub>Submit for approval</button>` : ''}${canWrite && r.status === 'awaiting_approval' ? `<button class="btn sm primary" type="button" data-rapp>Approve</button>` : ''}${canWrite && r.status === 'approved' ? `<button class="btn sm primary" type="button" data-rpay>Record paid…</button><button ${BTN} data-rtr>${icon('download')} Transfer list</button>` : ''}${canWrite && !['paid', 'void'].includes(r.status) ? `<button ${BTN} data-rvoid>Void…</button>` : ''}<button ${BTN} data-rx>${icon('download')} Excel</button></div>`;
      table($('[data-rl]', body), { columns: [
        { label: 'Employee', render: (l) => `<b>${esc(l.name)}</b><div class="cell-sub">${esc(l.ptkp)} · ${esc(l.method ?? '')}${l.terRate != null ? ` ${l.terRate}%` : ''}</div>` },
        { label: 'Gross', num: true, render: (l) => esc(m(l.base + l.allowance + l.overtime + l.bonus)) },
        { label: 'PPh 21', num: true, render: (l) => esc(m(l.pph21)) },
        { label: 'BPJS', num: true, render: (l) => esc(m(l.employeeBpjs)) },
        { label: 'Net', num: true, render: (l) => `<b>${esc(m(l.net))}</b>` },
        { label: '', render: (l) => `<div class="row" style="gap:4px;justify-content:flex-end">${canWrite && r.status === 'draft' ? `<button ${BTN} data-ladj="${l.id}">Adjust</button>` : ''}<button ${BTN} data-lslip="${l.id}">Payslip</button></div>` },
      ], rows: r.lines });
      $('[data-rsub]', body)?.addEventListener('click', () => act('submit', null, 'Submitted for approval.'));
      $('[data-rapp]', body)?.addEventListener('click', () => act('approve', null, 'Approved.'));
      $('[data-rx]', body).addEventListener('click', () => fetchFile(`/v1/finance/payroll/runs/${r.id}?format=xlsx`, `payroll-${r.month}.xlsx`));
      $('[data-rtr]', body)?.addEventListener('click', () => fetchFile(`/v1/finance/payroll/runs/${r.id}?format=transfers`, `payroll-transfers-${r.month}.csv`));
      $('[data-rpay]', body)?.addEventListener('click', () => modal({ title: 'Record the payroll paid', body: `<div class="form">${field('Paid on', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('From', `<select name="acc">${(accts.accounts ?? []).filter((a) => a.currency === c).map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>`)}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', onClick: (mc) => act('pay', { paidOn: $('[name="on"]', mc.el).value, cashAccountId: $('[name="acc"]', mc.el).value }, 'Recorded.') }] }));
      $('[data-rvoid]', body)?.addEventListener('click', () => modal({ title: 'Void the payroll', body: `<div class="form one">${field('Reason', '<input name="why">')}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Void', kind: 'danger', onClick: (mc) => act('void', { reason: $('[name="why"]', mc.el).value.trim() }, 'Voided.') }] }));
      body.addEventListener('click', (e) => {
        const a = e.target.closest('[data-ladj]'), s = e.target.closest('[data-lslip]');
        if (s) fetchFile(`/v1/finance/payroll/runs/${r.id}/payslips/${s.dataset.lslip}`, `payslip-${r.month}.pdf`);
        if (a) {
          const l = r.lines.find((x) => x.id === a.dataset.ladj);
          modal({ title: `Adjust · ${l.name}`, body: `<div class="form">${field('Overtime', `<input name="ot" type="number" min="0" value="${l.overtime}">`)}${field('Bonus', `<input name="bo" type="number" min="0" value="${l.bonus}">`)}${field('Other deductions', `<input name="de" type="number" min="0" value="${l.deduction}">`)}</div>`,
            actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
              try { await api(`/v1/finance/payroll/runs/${r.id}/lines/${l.id}`, { method: 'PUT', body: { overtime: Number($('[name="ot"]', mc.el).value || 0), bonus: Number($('[name="bo"]', mc.el).value || 0), deduction: Number($('[name="de"]', mc.el).value || 0) } }); reload(); openRun(r.id); } catch (err) { toast(err.message, 'crit'); return false; }
            } }] });
        }
      });
    } }] });
  };
  $('[data-ynew]', el)?.addEventListener('click', () => empForm(null));
  $('[data-yrun]', el)?.addEventListener('click', () => modal({ title: 'Draft a payroll', body: `<div class="form">${field('Month', `<input name="m" type="month" value="${esc(zonedYmd(new Date()).slice(0, 7))}">`)}${field('Currency', `<input name="c" maxlength="3" value="${esc(active[0]?.currency ?? LEGACY_CURRENCY)}">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Draft', kind: 'primary', async onClick(mc) {
      try { const r = await api('/v1/finance/payroll/runs', { method: 'POST', body: { month: $('[name="m"]', mc.el).value, currency: $('[name="c"]', mc.el).value.trim() } }); reload(); openRun(r.id); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] }));
  el.addEventListener('click', (e) => {
    const o = e.target.closest('[data-yopen]'), ed = e.target.closest('[data-yedit]');
    if (o) openRun(o.dataset.yopen);
    if (ed) empForm(d.employees.find((x) => x.id === ed.dataset.yedit));
  });
}

// ─────────────────────────────────────────── (v1.33.0) customer credit and deposits

const GRADE_TAG = { A: 't-ok', B: 't-ok', C: 't-warn', D: 't-crit', E: 't-crit' };

async function creditSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api('/v1/finance/credit'); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => creditSection(host, canWrite);
  const canApprove = state.can('finance:approve');
  const held = {};
  for (const a of d.accounts) held[a.currency] = (held[a.currency] ?? 0) + a.deposit;
  el.innerHTML = `${callout('info', 'Fleet customers are scored from the last 12 months of invoices (paid late, days late, overdue now, limit used, tenure; a security deposit helps) and graded A to E. A Finance Manager decides each review: the limit, a hold (the cards are blocked) and the next review date.')}
    <div class="grid k4 section">${kpi('Accounts', String(d.accounts.length), `${d.accounts.filter((a) => a.hold).length} on hold`, d.accounts.some((a) => a.hold) ? 'warn' : '')}${kpi('Reviews due', String(d.accounts.filter((a) => a.reviewDue).length), `${d.openReviews.length} open`, d.openReviews.length ? 'warn' : '')}${kpi('Deposits held', Object.entries(held).filter(([, v]) => v).map(([c, v]) => esc(fmt.money(v, c))).join(' + ') || '—', 'security deposits')}${kpi('Grades', ['A', 'B', 'C', 'D', 'E'].map((g) => [g, d.accounts.filter((a) => a.lastReview?.grade === g).length]).filter(([, n]) => n).map(([g, n]) => `${g}×${n}`).join(' ') || '—', 'from the last reviews')}</div>
    ${d.openReviews.length ? '<div class="card section"><header><h3>Open reviews</h3></header><div data-co></div></div>' : ''}
    <div class="card section"><header><h3>Accounts</h3></header><div data-ca></div></div>`;
  if (d.openReviews.length) table($('[data-co]', el), { columns: [
    { label: 'Account', render: (r) => `<b>${esc(r.account)}</b><div class="cell-sub">${esc((r.factors.reasons ?? []).join('; '))}</div>` },
    { label: 'Score', render: (r) => `${tag(GRADE_TAG[r.grade], r.grade)} ${r.score}` },
    { label: 'Limit now', num: true, render: (r) => esc(fmt.money(r.currentLimit, r.currency)) },
    { label: 'Suggested', num: true, render: (r) => `<b>${esc(fmt.money(r.suggestedLimit, r.currency))}</b>` },
    { label: '', render: (r) => (canWrite && canApprove ? `<button class="btn sm primary" style="white-space:nowrap" type="button" data-cdec="${r.id}">Decide…</button>` : '') },
  ], rows: d.openReviews });
  table($('[data-ca]', el), { columns: [
    { label: 'Account', render: (a) => `<b>${esc(a.name)}</b><div class="cell-sub">${esc(a.mode)}${a.hold ? ` · on hold: ${esc(a.hold.reason ?? '')}` : ''}</div>` },
    { label: 'Grade', render: (a) => (a.lastReview ? `${tag(GRADE_TAG[a.lastReview.grade], a.lastReview.grade)} ${a.lastReview.score}` : '<span class="cell-sub">not reviewed</span>') },
    { label: 'Limit', num: true, render: (a) => esc(fmt.money(a.limit, a.currency)) },
    { label: 'Deposit', num: true, render: (a) => (a.deposit ? esc(fmt.money(a.deposit, a.currency)) : '') },
    { label: 'Next review', render: (a) => (a.nextReviewOn ? `${esc(a.nextReviewOn)}${a.reviewDue ? ` ${tag('t-warn', 'due')}` : ''}` : '<span class="cell-sub">—</span>') },
    { label: '', render: (a) => (canWrite ? `<div class="row" style="gap:4px;justify-content:flex-end"><button ${BTN} data-crev="${a.id}">Review</button><button ${BTN} data-cdep="${a.id}">Deposit…</button>${canApprove ? `<button ${BTN} data-chold="${a.id}" data-on="${a.hold ? 'false' : 'true'}">${a.hold ? 'Release' : 'Hold…'}</button>` : ''}</div>` : '') },
  ], rows: d.accounts, empty: 'No fleet accounts.' });
  el.addEventListener('click', async (e) => {
    const rv = e.target.closest('[data-crev]'), dc = e.target.closest('[data-cdec]'), dp = e.target.closest('[data-cdep]'), hd = e.target.closest('[data-chold]');
    if (rv) { try { const r = await api(`/v1/finance/credit/accounts/${rv.dataset.crev}/reviews`, { method: 'POST', body: {} }); toast(`Scored ${r.score} (${r.grade}).`, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); } }
    if (dc) {
      const r = d.openReviews.find((x) => x.id === dc.dataset.cdec);
      modal({ title: `Decide · ${r.account}`, subtitle: `Score ${r.score}, grade ${r.grade}`, body: `<div class="form">${field('Decision', '<select name="dec"><option value="approve">Approve</option><option value="reject">Reject</option></select>')}${field(`New limit (${r.currency})`, `<input name="lim" type="number" min="0" value="${r.suggestedLimit}">`)}
          ${field('Hold', '<select name="hold"><option value="">Leave as it is</option><option value="true">Put on hold</option><option value="false">Release the hold</option></select>')}${field('Next review', '<input name="next" type="date">', { opt: true })}${field('Note', '<input name="note" maxlength="500">', { opt: true })}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Decide', kind: 'primary', async onClick(mc) {
          const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
          try { await api(`/v1/finance/credit/reviews/${r.id}/decide`, { method: 'POST', body: { decision: v('dec'), newLimit: v('lim'), hold: v('hold') === '' ? undefined : v('hold') === 'true', nextReviewOn: v('next'), note: v('note') } }); toast('Decided.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
        } }] });
    }
    if (dp) {
      const a = d.accounts.find((x) => x.id === dp.dataset.cdep);
      modal({ title: `Security deposit · ${a.name}`, subtitle: `Held ${fmt.money(a.deposit, a.currency)}`, body: `<div class="form">${field('Kind', '<select name="k"><option value="received">Received</option><option value="returned">Returned</option><option value="applied">Applied to an invoice</option></select>')}${field(`Amount (${a.currency})`, '<input name="amt" type="number" min="1">')}
          ${field('Date', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Invoice id (applied)', '<input name="inv">', { opt: true })}${field('Reference', '<input name="ref">', { opt: true })}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', async onClick(mc) {
          const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
          try { await api(`/v1/finance/credit/accounts/${a.id}/deposits`, { method: 'POST', body: { kind: v('k'), amount: Number(v('amt')), onDate: v('on'), invoiceId: v('inv') || undefined, reference: v('ref') || undefined } }); toast('Recorded.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
        } }] });
    }
    if (hd) {
      const on = hd.dataset.on === 'true';
      if (!on) { try { await api(`/v1/finance/credit/accounts/${hd.dataset.chold}/hold`, { method: 'POST', body: { hold: false } }); toast('Released.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); } return; }
      modal({ title: 'Put the account on hold', subtitle: 'Its cards are blocked until the hold is released.', body: `<div class="form one">${field('Why', '<input name="why">')}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Hold', kind: 'danger', async onClick(mc) {
          try { const r = await api(`/v1/finance/credit/accounts/${hd.dataset.chold}/hold`, { method: 'POST', body: { hold: true, reason: $('[name="why"]', mc.el).value.trim() } }); toast(`On hold; ${r.cardsBlocked} card(s) blocked.`, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
        } }] });
    }
  });
}

// ─────────────────────────────────────────── (v1.33.0) capex projects

const PRJ_ST = { planned: ['t-mute', 'planned'], active: ['t-info', 'active'], completed: ['t-ok', 'completed'], cancelled: ['t-mute', 'cancelled'] };

async function projectsSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api('/v1/finance/projects'); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => projectsSection(host, canWrite);
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-pjnew>${icon('plus')} New project</button>` : ''}<button class="btn" type="button" data-pjx>${icon('download')} Excel</button></div>
    ${callout('info', 'Link purchase orders and bills to a project: approved orders not yet billed are committed, approved bills are actual. Bills on a project post to assets under construction; completing it makes one asset of the cost.')}
    ${Object.keys(d.totals).length ? `<div class="grid k4 section">${Object.entries(d.totals).map(([c, t]) => kpi(`Open projects · ${c}`, esc(fmt.money(t.budget, c)), `${fmt.money(t.actual, c)} spent, ${fmt.money(t.committed, c)} committed`)).join('')}</div>` : ''}
    <div class="card section"><header><h3>Projects</h3></header><div data-pjl></div></div>`;
  table($('[data-pjl]', el), { columns: [
    { label: 'Project', render: (p) => `<b>${esc(p.number)}</b> ${esc(p.name)}<div class="cell-sub">${esc(p.site ?? 'no site')}${p.targetOn ? ` · target ${esc(p.targetOn)}` : ''}</div>` },
    { label: 'Budget', num: true, render: (p) => esc(fmt.money(p.budget, p.currency)) },
    { label: 'Actual', num: true, render: (p) => esc(fmt.money(p.actual, p.currency)) },
    { label: 'Committed', num: true, render: (p) => esc(fmt.money(p.committed, p.currency)) },
    { label: 'Forecast', num: true, render: (p) => `<b>${esc(fmt.money(p.forecast, p.currency))}</b>${p.variancePct != null && p.forecast ? `<div class="cell-sub">${p.variancePct > 0 ? '+' : ''}${p.variancePct}%</div>` : ''}` },
    { label: 'Status', render: (p) => `${tag(...PRJ_ST[p.status])}${p.overBudget ? ` ${tag('t-crit', 'over budget')}` : ''}${p.asset ? `<div class="cell-sub">asset ${esc(p.asset.tag)}</div>` : ''}` },
    { label: '', render: (p) => `<button ${BTN} data-pjopen="${p.id}">Open</button>` },
  ], rows: d.projects, empty: 'No projects yet.' });
  const form = (p) => modal({ title: p ? `${p.number} ${p.name}` : 'New capex project', size: 'lg', body: `<div class="form">${field('Name', `<input name="name" value="${esc(p?.name ?? '')}">`)}${field('Site', `<select name="site"><option value="">—</option></select>`, { opt: true })}
      ${field('Status', `<select name="st"><option value="planned">Planned</option><option value="active"${p?.status === 'active' ? ' selected' : ''}>Active</option></select>`)}${field('Target date', `<input name="tg" type="date" value="${esc(p?.targetOn ?? '')}">`, { opt: true })}
      ${d.categories.map((c) => field(`Budget · ${c}`, `<input name="b_${c}" type="number" min="0" value="${p?.categories?.find((x) => x.category === c)?.budget || ''}">`, { opt: true })).join('')}
      ${field('Asset category', `<select name="ac">${d.assetCategories.map((c) => `<option${(p?.assetCategory ?? 'chargers') === c ? ' selected' : ''}>${c}</option>`).join('')}</select>`)}${field('Life (months)', `<input name="life" type="number" min="1" max="360" value="${p?.lifeMonths ?? 96}">`)}</div>`,
    async onMount(mc) {
      try { const sites = await sitesList(); const sel = $('[name="site"]', mc.el); sel.innerHTML = `<option value="">—</option>${sites.map((s) => `<option value="${esc(s.id)}"${p?.siteId === s.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}`; } catch { /* no sites */ }
    },
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
      const budget = Object.fromEntries(d.categories.map((c) => [c, v(`b_${c}`)]).filter(([, x]) => x !== '').map(([c, x]) => [c, Number(x)]));
      try { await api(p ? `/v1/finance/projects/${p.id}` : '/v1/finance/projects', { method: p ? 'PUT' : 'POST', body: { name: v('name'), siteId: v('site') || null, status: v('st'), targetOn: v('tg'), budget, assetCategory: v('ac'), lifeMonths: Number(v('life')) } }); toast('Saved.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] });
  const open = async (id) => {
    let p;
    try { p = await api(`/v1/finance/projects/${id}`); } catch (err) { toast(err.message, 'crit'); return; }
    const m = (x) => fmt.money(x, p.currency);
    const live = p.status === 'planned' || p.status === 'active';
    drawer({ title: `${p.number} · ${p.name}`, subtitle: `${PRJ_ST[p.status][1]} · ${p.currency}`, tabs: [
      { id: 'budget', label: 'Budget', render(body) {
        body.innerHTML = `<div class="grid k4">${kpi('Budget', esc(m(p.budget)), p.spentPct != null ? `${p.spentPct}% spent` : '')}${kpi('Actual', esc(m(p.actual)), `${p.bills.length} bill(s)`)}${kpi('Committed', esc(m(p.committed)), `${p.orders.length} order(s)`)}${kpi('Forecast', esc(m(p.forecast)), p.variancePct != null && p.forecast ? `${p.variancePct > 0 ? '+' : ''}${p.variancePct}% on budget` : 'nothing spent or committed', p.overBudget ? 'crit' : '')}</div><div data-pc style="margin-top:10px"></div>
          <div class="row" style="gap:6px;margin-top:10px;flex-wrap:wrap">${canWrite && live ? `<button ${BTN} data-pe>Edit</button><button ${BTN} data-pl>Link a bill or order…</button><button class="btn sm primary" type="button" data-pc2>Complete…</button><button ${BTN} data-pcan>Cancel…</button>` : ''}</div>`;
        table($('[data-pc]', body), { columns: [{ label: 'Category', render: (c) => esc(c.category) }, { label: 'Budget', num: true, render: (c) => esc(m(c.budget)) }, { label: 'Actual', num: true, render: (c) => esc(m(c.actual)) }, { label: '', render: (c) => (c.budget && c.actual > c.budget ? tag('t-crit', 'over') : '') }], rows: p.categories, empty: 'No budget.' });
        $('[data-pe]', body)?.addEventListener('click', () => form(p));
        $('[data-pl]', body)?.addEventListener('click', () => modal({ title: 'Link to the project', body: `<div class="form">${field('Bill id', '<input name="b">', { opt: true })}${field('Purchase order id', '<input name="o">', { opt: true })}</div>`,
          actions: [{ label: 'Cancel' }, { label: 'Link', kind: 'primary', async onClick(mc) {
            const b = $('[name="b"]', mc.el).value.trim(), o = $('[name="o"]', mc.el).value.trim();
            try { await api(`/v1/finance/projects/${p.id}/link`, { method: 'POST', body: b ? { billId: b } : { orderId: o } }); toast('Linked.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
          } }] }));
        $('[data-pc2]', body)?.addEventListener('click', () => modal({ title: 'Complete the project', subtitle: `${m(p.actual)} becomes one asset (less bills capitalised on their own).`, body: `<div class="form">${field('Completed on', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('In service from', '<input name="ins" type="month">', { opt: true })}</div>`,
          actions: [{ label: 'Cancel' }, { label: 'Complete', kind: 'primary', async onClick(mc) {
            try { const r = await api(`/v1/finance/projects/${p.id}/complete`, { method: 'POST', body: { completedOn: $('[name="on"]', mc.el).value, inService: $('[name="ins"]', mc.el).value } }); toast(`Completed: ${m(r.capitalised)} capitalised.`, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
          } }] }));
        $('[data-pcan]', body)?.addEventListener('click', () => modal({ title: 'Cancel the project', subtitle: 'What was spent is written off.', body: `<div class="form one">${field('Why', '<input name="why">')}</div>`,
          actions: [{ label: 'Back' }, { label: 'Cancel the project', kind: 'danger', async onClick(mc) {
            try { await api(`/v1/finance/projects/${p.id}/cancel`, { method: 'POST', body: { reason: $('[name="why"]', mc.el).value.trim() } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
          } }] }));
      } },
      { id: 'linked', label: 'Bills and orders', render(body) {
        body.innerHTML = '<h4 style="margin:0 0 6px">Bills</h4><div data-pb></div><h4 style="margin:14px 0 6px">Purchase orders</h4><div data-po></div>';
        table($('[data-pb]', body), { columns: [{ label: 'Bill', render: (b) => `<b>${esc(b.number)}</b> · ${esc(b.supplier)}<div class="cell-sub">${esc(b.date)} · ${esc(b.category)}</div>` }, { label: 'Subtotal', num: true, render: (b) => esc(m(b.subtotal)) }, { label: 'Status', render: (b) => esc(b.status.replace('_', ' ')) }], rows: p.bills, empty: 'No bills.' });
        table($('[data-po]', body), { columns: [{ label: 'Order', render: (o) => `<b>${esc(o.number)}</b> · ${esc(o.supplier)}` }, { label: 'Total', num: true, render: (o) => esc(m(o.total)) }, { label: 'Billed', num: true, render: (o) => esc(m(o.billed)) }, { label: 'Open', num: true, render: (o) => esc(m(o.open)) }], rows: p.orders, empty: 'No orders.' });
      } },
    ] });
  };
  $('[data-pjnew]', el)?.addEventListener('click', () => form(null));
  $('[data-pjx]', el).addEventListener('click', () => fetchFile('/v1/finance/projects?format=xlsx', 'plugsure-capex-projects.xlsx'));
  el.addEventListener('click', (e) => { const o = e.target.closest('[data-pjopen]'); if (o) open(o.dataset.pjopen); });
}

// ─────────────────────────────────────────── (v1.33.0) cash forecast

async function cashForecastSection(host, canWrite, sc = {}) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  const qp = new URLSearchParams(Object.entries(sc).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]));
  try { d = await api(`/v1/finance/cash-forecast${qp.toString() ? `?${qp}` : ''}`); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = (s = sc) => cashForecastSection(host, canWrite, s);
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Days', `<select data-fh>${[30, 60, 90, 120, 180].map((h) => `<option${d.horizonDays === h ? ' selected' : ''}>${h}</option>`).join('')}</select>`)}${field('Collections %', `<input data-fp type="number" min="0" max="200" value="${d.scenario.collectionsPct}" style="width:90px">`)}${field('Pay bills later (days)', `<input data-fd type="number" min="0" max="90" value="${d.scenario.delayBillsDays}" style="width:90px">`)}${field('Capex', `<select data-fc><option value="true">Included</option><option value="false"${d.scenario.capex ? '' : ' selected'}>Left out</option></select>`)}
      <div class="row" style="align-self:flex-end;gap:6px"><button class="btn" type="button" data-fgo>Recalculate</button>${canWrite ? '<button class="btn" type="button" data-fset>Save as default</button>' : ''}</div></div>
    ${callout('info', 'Committed flows (gateway settlements, fleet invoices, owner shares, bills, leases, deposits) plus the collections learnt from 180 days of charging (a weekday pattern, a level and a trend; the band is about 80%), the next payrolls and open capex projects.')}
    ${d.notes.length ? callout('warn', d.notes.map(esc).join('<br>')) : ''}<div data-fcur></div>`;
  const host2 = $('[data-fcur]', el);
  for (const c of d.currencies) {
    const m = (x) => fmt.money(x, c.currency);
    const acc = d.accuracy?.[c.currency];
    const card = document.createElement('div');
    card.className = 'section';
    const min = Math.min(...c.days.map((x) => x.low), c.minimum, 0), max = Math.max(...c.days.map((x) => x.high), c.opening, 1);
    const W = 720, H = 160, x = (i) => (i / Math.max(1, c.days.length - 1)) * W, y = (v) => H - ((v - min) / (max - min || 1)) * H;
    const line = (k) => c.days.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[k]).toFixed(1)}`).join(' ');
    card.innerHTML = `<div class="grid k4">${kpi(`Today · ${esc(c.currency)}`, esc(m(c.opening)), `minimum ${esc(m(c.minimum))}`)}${kpi('Lowest', esc(m(c.lowest.closing)), esc(c.lowest.day), c.lowest.closing < c.minimum ? 'crit' : '')}${kpi(`In ${d.horizonDays} days`, esc(m(c.closing)), `${esc(m(c.learnedTotal))} learnt collections`)}${kpi('Below the minimum', c.firstBelowMinimum ? esc(c.firstBelowMinimum) : 'never', c.firstBelowMinimumPessimistic ? `pessimistic: ${esc(c.firstBelowMinimumPessimistic)}` : 'not even pessimistically', c.firstBelowMinimum ? 'crit' : c.firstBelowMinimumPessimistic ? 'warn' : '')}</div>
      ${c.message ? callout('info', esc(c.message)) : ''}
      <div class="card" style="margin-top:10px;padding:12px;overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="Cash forecast">
        <path d="${line('high')} L${W},${y(c.days.at(-1).low)} ${c.days.slice().reverse().map((r, i) => `L${x(c.days.length - 1 - i).toFixed(1)},${y(r.low).toFixed(1)}`).join(' ')} Z" fill="var(--accent)" opacity="0.12"></path>
        <path d="${line('closing')}" fill="none" stroke="var(--accent)" stroke-width="2"></path>
        <line x1="0" x2="${W}" y1="${y(c.minimum)}" y2="${y(c.minimum)}" stroke="var(--crit, #c0392b)" stroke-dasharray="4 4" stroke-width="1"></line></svg>
        <div class="cell-sub">${c.model ? `Learnt from ${c.model.days} days · trend ${c.model.trend > 0 ? '+' : ''}${fmt.num(Math.round(c.model.trend))} a day · fit error ${c.model.wape ?? '—'}%` : 'No model'}${acc ? ` · forecast accuracy ${acc.wape == null ? '—' : `${acc.wape}% error`} over ${acc.days} day(s)` : ''}</div></div>
      <div class="card" style="margin-top:10px"><header><h3>Largest flows</h3></header><div data-fl></div></div>`;
    host2.append(card);
    table($('[data-fl]', card), { columns: [{ label: 'Day', render: (f) => esc(f.day) }, { label: 'What', render: (f) => `${esc(f.label)} <span class="cell-sub">${esc(f.kind.replace('_', ' '))}</span>` }, { label: 'Amount', num: true, render: (f) => `<span class="${f.amount < 0 ? 't-crit' : ''}">${esc(m(f.amount))}</span>` }], rows: c.largest, empty: 'No committed flows.' });
  }
  if (!d.currencies.length) host2.innerHTML = callout('info', 'Add a cash account (Finance → Cash) to forecast the cash position.');
  const cur = () => ({ horizonDays: $('[data-fh]', el).value, collectionsPct: $('[data-fp]', el).value, delayBillsDays: $('[data-fd]', el).value, capex: $('[data-fc]', el).value });
  $('[data-fgo]', el).addEventListener('click', () => reload(cur()));
  $('[data-fset]', el)?.addEventListener('click', async () => { const c = cur(); try { await api('/v1/finance/cash-forecast/settings', { method: 'PUT', body: { horizonDays: Number(c.horizonDays) < 30 ? 30 : Number(c.horizonDays), collectionsPct: Number(c.collectionsPct) } }); toast('Saved as the default.', 'ok'); } catch (err) { toast(err.message, 'crit'); } });
}

// ─────────────────────────────────────────── (v1.34.0) inventory

async function inventorySection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api('/v1/finance/inventory'); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => inventorySection(host, canWrite);
  const live = d.items.filter((i) => !i.archived), locs = d.locations.filter((l) => !l.archived);
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px;flex-wrap:wrap">${canWrite ? `<button class="btn primary" type="button" data-imove>Record a move…</button><button class="btn" type="button" data-inew>${icon('plus')} Item</button><button class="btn" type="button" data-iloc>${icon('plus')} Location</button>` : ''}<button class="btn" type="button" data-ix>${icon('download')} Excel</button></div>
    <div class="grid k4 section">${kpi('Stock value', Object.entries(d.value).map(([c, v]) => esc(fmt.money(v, c))).join(' + ') || '—', 'at the moving average cost')}${kpi('Items', String(live.length), `${locs.length} location(s)`)}${kpi('To reorder', String(d.reorder.length), 'at or below the reorder point', d.reorder.length ? 'warn' : '')}${kpi('Out of stock', String(live.filter((i) => i.onHand <= 0).length), 'items')}</div>
    <div class="card section"><header><h3>Items</h3></header><div data-il></div></div><div class="card section"><header><h3>Recent moves</h3></header><div data-im></div></div>`;
  table($('[data-il]', el), { columns: [
    { label: 'Item', render: (i) => `<b>${esc(i.sku)}</b> ${esc(i.name)}<div class="cell-sub">${esc(i.category)}${i.supplier ? ` · ${esc(i.supplier)}` : ''}</div>` },
    { label: 'On hand', num: true, render: (i) => `${fmt.num(i.onHand)} ${esc(i.unit)}${i.belowReorder ? ` ${tag('t-warn', 'reorder')}` : ''}` },
    { label: 'Average cost', num: true, render: (i) => esc(fmt.money(i.avgCost, i.currency)) },
    { label: 'Value', num: true, render: (i) => `<b>${esc(fmt.money(i.value, i.currency))}</b>` },
    { label: 'Reorder at', num: true, render: (i) => (i.reorderPoint ? `${fmt.num(i.reorderPoint)} <span class="cell-sub">+${fmt.num(i.reorderQty)}</span>` : '') },
  ], rows: d.items, empty: 'No items yet.' });
  try {
    const mv = await api('/v1/finance/inventory/moves');
    table($('[data-im]', el), { columns: [{ label: 'Date', render: (m) => esc(m.date) }, { label: 'Move', render: (m) => `${esc(m.kind.replace('_', ' '))} · <b>${esc(m.sku)}</b><div class="cell-sub">${esc(m.location)}${m.workOrder ? ` · ${esc(m.workOrder)}` : ''}${m.note ? ` · ${esc(m.note)}` : ''}</div>` },
      { label: 'Qty', num: true, render: (m) => fmt.num(m.qty) }, { label: 'Value', num: true, render: (m) => esc(fmt.money(m.value, m.currency)) }], rows: mv.moves.slice(0, 50), empty: 'No moves yet.' });
  } catch { /* moves are optional */ }
  $('[data-ix]', el).addEventListener('click', () => fetchFile('/v1/finance/inventory?format=xlsx', 'plugsure-stock.xlsx'));
  $('[data-inew]', el)?.addEventListener('click', () => modal({ title: 'Add a stock item', body: `<div class="form">${field('SKU', '<input name="sku">')}${field('Name', '<input name="name">')}${field('Unit', '<input name="unit" value="pcs">')}${field('Category', '<select name="cat"><option value="part">Part</option><option value="consumable">Consumable</option><option value="tool">Tool</option></select>')}${field('Currency', `<input name="cur" maxlength="3" value="${esc(LEGACY_CURRENCY)}">`)}${field('Reorder point', '<input name="rp" type="number" min="0" value="0">')}${field('Reorder quantity', '<input name="rq" type="number" min="0" value="0">')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', async onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
      try { await api('/v1/finance/inventory/items', { method: 'POST', body: { sku: v('sku'), name: v('name'), unit: v('unit'), category: v('cat'), currency: v('cur'), reorderPoint: v('rp'), reorderQty: v('rq') } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] }));
  $('[data-iloc]', el)?.addEventListener('click', () => modal({ title: 'Add a stock location', body: `<div class="form one">${field('Name', '<input name="name" placeholder="e.g. Jakarta depot">')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', async onClick(mc) { try { await api('/v1/finance/inventory/locations', { method: 'POST', body: { name: $('[name="name"]', mc.el).value.trim() } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] }));
  $('[data-imove]', el)?.addEventListener('click', () => {
    if (!live.length || !locs.length) { toast('Add an item and a location first.', 'warn'); return; }
    modal({ title: 'Record a stock move', size: 'lg', body: `<div class="form">${field('Kind', '<select name="k"><option value="receipt">Receipt</option><option value="issue">Issue</option><option value="transfer">Transfer</option><option value="adjust">Count (adjust)</option></select>')}${field('Item', `<select name="it">${live.map((i) => `<option value="${i.id}">${esc(i.sku)} ${esc(i.name)}</option>`).join('')}</select>`)}
        ${field('Location', `<select name="loc">${locs.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>`)}${field('To (transfer)', `<select name="to"><option value=""></option>${locs.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>`, { opt: true })}
        ${field('Quantity', '<input name="q" type="number" min="0" step="any">', { opt: true })}${field('Unit cost (receipt)', '<input name="uc" type="number" min="0">', { opt: true })}${field('Counted (count)', '<input name="cq" type="number" min="0" step="any">', { opt: true })}
        ${field('Work order id (issue)', '<input name="wo">', { opt: true })}${field('Date', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Note', '<input name="note">', { opt: true })}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', async onClick(mc) {
        const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
        try { await api('/v1/finance/inventory/moves', { method: 'POST', body: { kind: v('k'), itemId: v('it'), locationId: v('loc'), toLocationId: v('to') || undefined, qty: v('q') || undefined, unitCost: v('uc') || undefined, countedQty: v('cq') || undefined, workOrderId: v('wo') || undefined, onDate: v('on'), note: v('note') || undefined } }); toast('Recorded.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
      } }] });
  });
}

// ─────────────────────────────────────────── (v1.34.0) maintenance

const WO_ST = { open: ['t-warn', 'open'], in_progress: ['t-info', 'in progress'], done: ['t-ok', 'done'], cancelled: ['t-mute', 'cancelled'] };

async function maintenanceSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d, c;
  try { [d, c] = await Promise.all([api('/v1/finance/maintenance'), api('/v1/finance/maintenance/costs')]); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => maintenanceSection(host, canWrite);
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-wnew>${icon('plus')} Work order</button>` : ''}<button class="btn" type="button" data-wx>${icon('download')} Costs (Excel)</button></div>
    <div class="grid k4 section">${Object.entries(c.totals).map(([cur, t]) => kpi(`Net cost · ${cur}`, esc(fmt.money(t.net, cur)), `${t.orders} order(s), ${esc(c.from)} to ${esc(c.to)}`)).join('') || kpi('Net cost', '—', 'no work orders')}${c.byKind.map((k) => kpi(k.kind, String(k.orders), 'orders')).join('')}</div>
    <div class="card section"><header><h3>Work orders</h3></header><div data-wl></div></div>
    <div class="card section"><header><h3>Cost per charger</h3><span class="cell-sub">labour, parts and contractors, less warranty recovered</span></header><div data-wc></div></div>`;
  table($('[data-wl]', el), { columns: [
    { label: 'Order', render: (w) => `<b>${esc(w.number)}</b> ${esc(w.title)}<div class="cell-sub">${esc([w.chargePoint ?? w.site, w.kind, `opened ${w.openedOn}`].filter(Boolean).join(' · '))}</div>` },
    { label: 'Labour', num: true, render: (w) => esc(fmt.money(w.cost.labour, w.currency)) },
    { label: 'Parts', num: true, render: (w) => esc(fmt.money(w.cost.parts, w.currency)) },
    { label: 'Contractors', num: true, render: (w) => `${esc(fmt.money(w.cost.contractor, w.currency))}${w.cost.accrual ? `<div class="cell-sub">+${esc(fmt.money(w.cost.accrual, w.currency))} accrued</div>` : ''}` },
    { label: 'Net', num: true, render: (w) => `<b>${esc(fmt.money(w.cost.net, w.currency))}</b>` },
    { label: 'Status', render: (w) => tag(...WO_ST[w.status]) },
    { label: '', render: (w) => `<button ${BTN} data-wopen="${w.id}">Open</button>` },
  ], rows: d.workOrders, empty: 'No work orders yet.' });
  table($('[data-wc]', el), { columns: [
    { label: 'Charger', render: (x) => `<b>${esc(x.chargePoint ?? '(site)')}</b><div class="cell-sub">${esc(x.site ?? '')}</div>` },
    { label: 'Orders', num: true, render: (x) => String(x.orders) },
    { label: 'Net', num: true, render: (x) => esc(fmt.money(x.net, x.currency)) },
    { label: 'kWh', num: true, render: (x) => (x.kwh == null ? '—' : fmt.num(x.kwh)) },
    { label: 'Per kWh', num: true, render: (x) => (x.perKwh == null ? '—' : esc(fmt.money(x.perKwh, x.currency))) },
  ], rows: c.chargers, empty: 'No costs in the period.' });
  const form = (w) => modal({ title: w ? `${w.number} · ${w.title}` : 'Open a work order', size: 'lg', body: `<div class="form">${field('Title', `<input name="t" value="${esc(w?.title ?? '')}">`)}${field('Kind', `<select name="k">${['corrective', 'preventive', 'warranty'].map((k) => `<option${w?.kind === k ? ' selected' : ''}>${k}</option>`).join('')}</select>`)}
      ${field('Charger id', `<input name="cp" value="${esc(w?.chargePointId ?? '')}">`, { opt: true })}${field('Status', `<select name="st">${['open', 'in_progress', 'done', 'cancelled'].map((k) => `<option value="${k}"${(w?.status ?? 'open') === k ? ' selected' : ''}>${k.replace('_', ' ')}</option>`).join('')}</select>`)}
      ${field('Labour hours', `<input name="h" type="number" min="0" step="0.25" value="${w?.labourHours ?? 0}">`)}${field('Labour rate', `<input name="r" type="number" min="0" value="${w?.labourRate ?? 0}">`)}${field('Contractor estimate', `<input name="e" type="number" min="0" value="${w?.contractorEstimate ?? 0}">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
      try { await api(w ? `/v1/finance/maintenance/${w.id}` : '/v1/finance/maintenance', { method: w ? 'PUT' : 'POST', body: { title: v('t'), kind: v('k'), chargePointId: v('cp') || undefined, status: v('st'), labourHours: v('h'), labourRate: v('r'), contractorEstimate: v('e') } }); toast('Saved.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] });
  $('[data-wnew]', el)?.addEventListener('click', () => form(null));
  $('[data-wx]', el).addEventListener('click', () => fetchFile('/v1/finance/maintenance/costs?format=xlsx', 'plugsure-maintenance-costs.xlsx'));
  el.addEventListener('click', async (e) => {
    const o = e.target.closest('[data-wopen]');
    if (!o) return;
    let w;
    try { w = await api(`/v1/finance/maintenance/${o.dataset.wopen}`); } catch (err) { toast(err.message, 'crit'); return; }
    const m = (x) => fmt.money(x, w.currency);
    drawer({ title: `${w.number} · ${w.title}`, subtitle: `${w.kind} · ${WO_ST[w.status][1]}`, tabs: [{ id: 'cost', label: 'Cost', render(body) {
      body.innerHTML = `<div class="grid k4">${kpi('Labour', esc(m(w.cost.labour)), `${w.labourHours} h`)}${kpi('Parts', esc(m(w.cost.parts)), `${w.parts.length} issue(s)`)}${kpi('Contractors', esc(m(w.cost.contractor + w.cost.accrual)), w.cost.accrual ? 'estimate accrued' : `${w.bills.length} bill(s)`)}${kpi('Net', esc(m(w.cost.net)), w.cost.recovered ? `${esc(m(w.cost.recovered))} recovered` : '')}</div>
        <h4 style="margin:14px 0 6px">Parts</h4><div data-wp></div><h4 style="margin:14px 0 6px">Warranty claims</h4><div data-wcl></div>
        <div class="row" style="gap:6px;margin-top:10px">${canWrite ? `<button ${BTN} data-wedit>Edit</button>` : ''}</div>`;
      table($('[data-wp]', body), { columns: [{ label: 'Part', render: (p) => `${esc(p.sku)} ${esc(p.name)}` }, { label: 'Qty', num: true, render: (p) => `${fmt.num(p.qty)} ${esc(p.unit)}` }, { label: 'Value', num: true, render: (p) => esc(m(p.value)) }], rows: w.parts, empty: 'No parts issued.' });
      table($('[data-wcl]', body), { columns: [{ label: 'Supplier', render: (c2) => esc(c2.supplier ?? '') }, { label: 'Amount', num: true, render: (c2) => esc(m(c2.amount)) }, { label: 'Status', render: (c2) => `${esc(c2.status)}${c2.paid ? ` · ${esc(m(c2.paid))}` : ''}` }], rows: w.claims, empty: 'No claims.' });
      $('[data-wedit]', body)?.addEventListener('click', () => form(w));
    } }] });
  });
}

// ─────────────────────────────────────────── (v1.34.0) revenue assurance

const RA_KIND = { unbilled: 'Not billed', roaming_no_cdr: 'Roaming, no charge record', zero_amount: 'Billed at zero', energy_mismatch: 'Energy billed differs', meter_mismatch: 'Meter values differ', signed_invalid: 'Signed values not verified', price_outlier: 'Price far below the site' };
const RA_ST = { open: ['t-warn', 'open'], recovered: ['t-ok', 'recovered'], written_off: ['t-mute', 'written off'], dismissed: ['t-mute', 'dismissed'] };

async function assuranceSection(host, canWrite, month = lastMonthYm()) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api(`/v1/finance/assurance?month=${month}`); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = (m = month) => assuranceSection(host, canWrite, m);
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Month', `<input type="month" data-am value="${esc(month)}">`)}<div class="row" style="align-self:flex-end;gap:6px">${canWrite ? '<button class="btn primary" type="button" data-arun>Check now</button>' : ''}<button class="btn" type="button" data-ax>${icon('download')} Excel</button></div></div>
    ${callout('info', 'Every session of the month against what was billed: sessions not billed, billed at zero, with energy, meter or price out of line, signed values not verified. Checked daily; a finding found again keeps its review.')}
    <div class="grid k4 section">${Object.entries(d.summary).map(([c, s]) => kpi(`Open leakage · ${c}`, esc(fmt.money(s.leakage, c)), `${s.open} finding(s)`, s.leakage ? 'warn' : '')).join('') || kpi('Open leakage', '—', 'nothing found')}${Object.entries(d.summary).map(([c, s]) => kpi(`Recovered · ${c}`, esc(fmt.money(s.recovered, c)), `${esc(fmt.money(s.writtenOff, c))} written off`)).join('')}</div>
    <div class="card section"><header><h3>By check</h3></header><div data-ak></div></div><div class="card section"><header><h3>Findings · ${esc(month)}</h3></header><div data-al></div></div>`;
  table($('[data-ak]', el), { columns: [{ label: 'Check', render: (k) => esc(RA_KIND[k.kind]) }, { label: 'Open', num: true, render: (k) => String(k.open) }, { label: 'All', num: true, render: (k) => String(k.total) }], rows: d.byKind });
  table($('[data-al]', el), { columns: [
    { label: 'Finding', render: (f) => `<b>${esc(RA_KIND[f.kind])}</b><div class="cell-sub mono">${esc(f.sessionId.slice(0, 8))} · ${esc(f.site ?? '')}${f.energyWh != null ? ` · ${fmt.num(Math.round(f.energyWh / 100) / 10)} kWh` : ''}</div>` },
    { label: 'Billed', num: true, render: (f) => esc(fmt.money(f.billed, f.currency)) },
    { label: 'Expected', num: true, render: (f) => esc(fmt.money(f.expected, f.currency)) },
    { label: 'Gap', num: true, render: (f) => `<b>${esc(fmt.money(f.gap, f.currency))}</b>` },
    { label: 'Status', render: (f) => `${tag(...RA_ST[f.status])}${f.note ? `<div class="cell-sub">${esc(f.note)}</div>` : ''}` },
    { label: '', render: (f) => (canWrite && f.status === 'open' ? `<button ${BTN} data-arev="${f.id}">Review…</button>` : '') },
  ], rows: d.findings, empty: 'Nothing found for the month.' });
  $('[data-am]', el).addEventListener('change', (e) => e.target.value && reload(e.target.value));
  $('[data-ax]', el).addEventListener('click', () => fetchFile(`/v1/finance/assurance?month=${month}&format=xlsx`, `plugsure-revenue-assurance-${month}.xlsx`));
  $('[data-arun]', el)?.addEventListener('click', async () => { try { const r = await api('/v1/finance/assurance/run', { method: 'POST', body: { month } }); toast(`${r.sessions} sessions checked; ${r.added} new finding(s).`, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); } });
  el.addEventListener('click', (e) => {
    const r = e.target.closest('[data-arev]');
    if (!r) return;
    const f = d.findings.find((x) => x.id === r.dataset.arev);
    modal({ title: `Review · ${RA_KIND[f.kind]}`, subtitle: `Gap ${fmt.money(f.gap, f.currency)}`, body: `<div class="form">${field('Outcome', '<select name="s"><option value="recovered">Recovered</option><option value="written_off">Written off</option><option value="dismissed">Dismissed (not a leak)</option></select>')}${field('Recovered amount', `<input name="a" type="number" min="0" value="${Math.max(0, f.gap)}">`, { opt: true })}${field('Note', '<input name="n">', { opt: true })}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
        const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
        try { await api(`/v1/finance/assurance/findings/${f.id}`, { method: 'POST', body: { status: v('s'), recovered: v('s') === 'recovered' ? v('a') : undefined, note: v('n') } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
      } }] });
  });
}

// ─────────────────────────────────────────── (v1.34.0) lenders

async function lendersSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api('/v1/finance/lenders'); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => lendersSection(host, canWrite);
  const KL = { dscr: 'Debt service cover', interest_cover: 'Interest cover', leverage: 'Leverage (debt ÷ EBITDA)', min_cash: 'Minimum cash' };
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px;flex-wrap:wrap">${canWrite ? `<button class="btn primary" type="button" data-lnew>${icon('plus')} Loan</button><button class="btn" type="button" data-cnew>${icon('plus')} Covenant</button><button class="btn" type="button" data-ctest>Test covenants</button>` : ''}<button class="btn" type="button" data-lpdf>${icon('download')} Lender pack (PDF)</button><button class="btn" type="button" data-lxls>${icon('download')} Lender pack (Excel)</button></div>
    <div class="card section"><header><h3>Loans</h3></header><div data-ll></div></div><div class="card section"><header><h3>Covenants</h3><span class="cell-sub">twelve months to the month's end, from the posted ledger</span></header><div data-lc></div></div>`;
  table($('[data-ll]', el), { columns: [
    { label: 'Loan', render: (l) => `<b>${esc(l.lender)}</b>${l.reference ? ` <span class="cell-sub">${esc(l.reference)}</span>` : ''}<div class="cell-sub">${l.ratePct}% · ${l.termMonths} months · ${esc(l.repayment.replace('_', ' '))}</div>` },
    { label: 'Facility', num: true, render: (l) => esc(fmt.money(l.facility, l.currency)) },
    { label: 'Drawn', num: true, render: (l) => esc(fmt.money(l.drawn, l.currency)) },
    { label: 'Balance', num: true, render: (l) => `<b>${esc(fmt.money(l.balance, l.currency))}</b>` },
    { label: 'Status', render: (l) => tag(l.status === 'active' ? 't-info' : 't-mute', l.status) },
    { label: '', render: (l) => `<button ${BTN} data-lopen="${l.id}">Open</button>` },
  ], rows: d.loans, empty: 'No loans yet.' });
  table($('[data-lc]', el), { columns: [
    { label: 'Covenant', render: (c) => `<b>${esc(KL[c.kind])}</b><div class="cell-sub">${esc(c.lender ?? 'Overall')} · ${esc(c.frequency)}</div>` },
    { label: 'Threshold', num: true, render: (c) => `${c.direction === 'min' ? '≥' : '≤'} ${c.kind === 'min_cash' ? esc(fmt.money(c.threshold, c.currency)) : c.threshold}` },
    { label: 'Last test', num: true, render: (c) => { const t = c.tests[0]; return t ? `${t.value == null ? '—' : c.kind === 'min_cash' ? esc(fmt.money(t.value, c.currency)) : t.value} <span class="cell-sub">${esc(t.month)}</span>` : '<span class="cell-sub">not tested</span>'; } },
    { label: '', render: (c) => { const t = c.tests[0]; return !t || t.passed == null ? '' : t.passed ? `${tag(t.headroomPct != null && t.headroomPct < 10 ? 't-warn' : 't-ok', 'met')}${t.headroomPct != null ? ` <span class="cell-sub">${t.headroomPct}% headroom</span>` : ''}` : tag('t-crit', 'breach'); } },
  ], rows: d.covenants, empty: 'No covenants yet.' });
  const month = lastMonthYm();
  $('[data-lpdf]', el).addEventListener('click', () => fetchFile(`/v1/finance/lenders/pack?month=${month}&format=pdf`, `lender-pack-${month}.pdf`));
  $('[data-lxls]', el).addEventListener('click', () => fetchFile(`/v1/finance/lenders/pack?month=${month}&format=xlsx`, `lender-pack-${month}.xlsx`));
  $('[data-ctest]', el)?.addEventListener('click', async () => { try { const r = await api('/v1/finance/lenders/covenants/test', { method: 'POST', body: { month } }); toast(`${r.results.length} covenant(s) tested for ${r.month}; ${r.results.filter((x) => x.passed === false).length} breached.`, r.results.some((x) => x.passed === false) ? 'warn' : 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); } });
  $('[data-lnew]', el)?.addEventListener('click', () => modal({ title: 'Add a loan', size: 'lg', body: `<div class="form">${field('Lender', '<input name="l">')}${field('Reference', '<input name="ref">', { opt: true })}${field('Currency', `<input name="c" maxlength="3" value="${esc(LEGACY_CURRENCY)}">`)}${field('Facility', '<input name="f" type="number" min="1">')}${field('Rate %', '<input name="r" type="number" step="0.01" min="0">')}${field('Start', '<input name="s" type="date">')}${field('Term (months)', '<input name="t" type="number" min="1" value="60">')}${field('Grace (months)', '<input name="g" type="number" min="0" value="0">')}${field('Repayment', '<select name="p"><option value="annuity">Annuity</option><option value="equal_principal">Equal principal</option><option value="bullet">Bullet</option></select>')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', async onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
      try { await api('/v1/finance/lenders/loans', { method: 'POST', body: { lender: v('l'), reference: v('ref'), currency: v('c'), facility: Number(v('f')), ratePct: Number(v('r')), startOn: v('s'), termMonths: Number(v('t')), graceMonths: Number(v('g')), repayment: v('p') } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] }));
  $('[data-cnew]', el)?.addEventListener('click', () => modal({ title: 'Add a covenant', body: `<div class="form">${field('Kind', `<select name="k">${Object.entries(KL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>`)}${field('Threshold', '<input name="th" type="number" step="any" min="0">')}${field('Currency', `<input name="c" maxlength="3" value="${esc(LEGACY_CURRENCY)}">`)}${field('Loan', `<select name="ln"><option value="">Overall</option>${d.loans.map((l) => `<option value="${l.id}">${esc(l.lender)}</option>`).join('')}</select>`)}${field('Tested', '<select name="fq"><option value="quarterly">Quarterly</option><option value="monthly">Monthly</option></select>')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', async onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
      try { await api('/v1/finance/lenders/covenants', { method: 'POST', body: { kind: v('k'), threshold: Number(v('th')), currency: v('c'), loanId: v('ln') || undefined, frequency: v('fq') } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; }
    } }] }));
  el.addEventListener('click', async (e) => {
    const o = e.target.closest('[data-lopen]');
    if (!o) return;
    let l;
    try { l = await api(`/v1/finance/lenders/loans/${o.dataset.lopen}`); } catch (err) { toast(err.message, 'crit'); return; }
    const m = (x) => fmt.money(x, l.currency);
    const act = async (path, body, msg) => { try { await api(`/v1/finance/lenders/loans/${l.id}/${path}`, { method: 'POST', body }); toast(msg, 'ok'); reload(); return true; } catch (err) { toast(err.message, 'crit'); return false; } };
    drawer({ title: l.lender, subtitle: `${l.currency} · ${l.ratePct}% · ${l.repayment.replace('_', ' ')}`, tabs: [
      { id: 'sum', label: 'Loan', render(body) {
        body.innerHTML = `<div class="grid k4">${kpi('Facility', esc(m(l.facility)), `${esc(m(l.undrawn))} undrawn`)}${kpi('Balance', esc(m(l.balance)), `${esc(m(l.repaid))} repaid`)}${kpi('Interest paid', esc(m(l.interestPaid)), '')}${kpi('Term', `${l.termMonths} mo`, `${l.graceMonths} grace · from ${esc(l.startOn)}`)}</div>
          <div class="row" style="gap:6px;margin-top:10px">${canWrite && l.status === 'active' ? `<button ${BTN} data-ldd>Drawdown…</button><button ${BTN} data-lpy>Payment…</button>` : ''}</div>`;
        $('[data-ldd]', body)?.addEventListener('click', () => modal({ title: 'Record a drawdown', body: `<div class="form">${field('Amount', `<input name="a" type="number" min="1" max="${l.undrawn}">`)}${field('Date', `<input name="d" type="date" value="${esc(zonedYmd(new Date()))}">`)}</div>`,
          actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', onClick: (mc) => act('drawdowns', { amount: Number($('[name="a"]', mc.el).value), onDate: $('[name="d"]', mc.el).value }, 'Recorded.') }] }));
        $('[data-lpy]', body)?.addEventListener('click', () => { const nx = l.schedule.find((s) => s.due >= zonedYmd(new Date())); modal({ title: 'Record a payment', subtitle: nx ? `Next due ${nx.due}: interest ${m(nx.interest)}, principal ${m(nx.principal)}` : '', body: `<div class="form">${field('Principal', `<input name="p" type="number" min="0" value="${nx?.principal ?? 0}">`)}${field('Interest', `<input name="i" type="number" min="0" value="${nx?.interest ?? 0}">`)}${field('Fees', '<input name="f" type="number" min="0" value="0">')}${field('Date', `<input name="d" type="date" value="${esc(zonedYmd(new Date()))}">`)}</div>`,
          actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', onClick: (mc) => act('payments', { principal: Number($('[name="p"]', mc.el).value), interest: Number($('[name="i"]', mc.el).value), fees: Number($('[name="f"]', mc.el).value), onDate: $('[name="d"]', mc.el).value }, 'Recorded.') }] }); });
      } },
      { id: 'sch', label: 'Schedule', render(body) {
        body.innerHTML = '<div data-ls></div>';
        table($('[data-ls]', body), { columns: [{ label: 'Due', render: (s) => esc(s.due) }, { label: 'Interest', num: true, render: (s) => esc(m(s.interest)) }, { label: 'Principal', num: true, render: (s) => esc(m(s.principal)) }, { label: 'Balance', num: true, render: (s) => esc(m(s.closing)) }], rows: l.schedule });
      } },
    ] });
  });
}

// ─────────────────────────────────────────── (v1.35.0) carbon and green energy

const CC_ST = { estimated: ['t-mute', 'estimated'], verified: ['t-info', 'verified'], issued: ['t-ok', 'issued'], void: ['t-mute', 'void'] };

async function carbonSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api('/v1/finance/carbon'); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => carbonSection(host, canWrite);
  const m = d.month, t3 = (x) => { const v = Math.round(x * 1000) / 1000; return (Object.is(v, -0) ? 0 : v).toLocaleString(undefined, { maximumFractionDigits: 3 }); };
  const from = d.trend[0]?.month ?? m.month, to = d.trend.at(-1)?.month ?? m.month;
  const max = Math.max(1, ...d.trend.map((x) => x.mwh));
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px;flex-wrap:wrap">${canWrite ? `<button class="btn primary" type="button" data-cbuy>${icon('plus')} RECs bought</button><button class="btn" type="button" data-cest>Estimate credits…</button><button class="btn" type="button" data-cset>Emission factors…</button>` : ''}<button class="btn" type="button" data-cx>${icon('download')} Report (Excel)</button></div>
    ${callout('info', `Avoided emissions: what petrol cars would have emitted for the same distance (${m.settings.iceKgPerKwh} kg CO2e per kWh) less the grid's emissions for the energy not covered by RECs (${m.settings.gridKgPerKwh} kg per kWh).`)}
    <div class="grid k4 section">${kpi(`Charged · ${esc(m.month)}`, `${t3(m.mwh)} MWh`, `${m.sites.reduce((a, s) => a + s.sessions, 0)} sessions`)}${kpi('Green share', `${m.greenPct}%`, `${t3(m.recMwh)} MWh of RECs retired`, m.greenPct >= 100 ? 'ok' : '')}${kpi('Avoided', `${t3(m.avoidedTonnes)} t CO2e`, 'against petrol cars')}${kpi('RECs held', `${t3(d.recsHeld)} MWh`, 'bought, not yet retired')}</div>
    <div class="card section"><header><h3>Six months</h3></header><div data-ct></div></div>
    <div class="grid k2 section"><div class="card"><header><h3>Renewable energy certificates</h3></header><div data-cr></div></div><div class="card"><header><h3>Carbon credits</h3></header><div data-cc></div></div></div>
    <div class="card section"><header><h3>Sites · ${esc(m.month)}</h3></header><div data-cs></div></div>`;
  table($('[data-ct]', el), { columns: [{ label: 'Month', render: (x) => esc(x.month) }, { label: 'MWh', num: true, render: (x) => `${t3(x.mwh)} <span style="display:inline-block;height:8px;width:${Math.round((x.mwh / max) * 80)}px;background:var(--accent);border-radius:2px;vertical-align:middle"></span>` },
    { label: 'Green', num: true, render: (x) => `${x.greenPct}%` }, { label: 'Avoided (t)', num: true, render: (x) => t3(x.avoidedTonnes) }], rows: d.trend });
  table($('[data-cr]', el), { columns: [
    { label: 'Certificate', render: (r) => `<b>${esc(r.registry)}</b> ${r.vintage}${r.reference ? ` <span class="cell-sub">${esc(r.reference)}</span>` : ''}<div class="cell-sub">${esc(r.site ?? 'Portfolio')} · bought ${esc(r.boughtOn)}</div>` },
    { label: 'MWh', num: true, render: (r) => t3(r.mwh) }, { label: 'Price', num: true, render: (r) => esc(fmt.money(r.price, r.currency)) },
    { label: '', render: (r) => (r.retiredMonth ? tag('t-ok', `retired ${r.retiredMonth}`) : canWrite ? `<button ${BTN} data-cret="${r.id}">Retire…</button>` : tag('t-info', 'held')) },
  ], rows: d.recs, empty: 'No RECs yet.' });
  table($('[data-cc]', el), { columns: [
    { label: 'Period', render: (c) => `<b>${esc(c.periodFrom)}${c.periodTo !== c.periodFrom ? ` – ${esc(c.periodTo)}` : ''}</b><div class="cell-sub">${esc(c.standard ?? '')}${c.serial ? ` · ${esc(c.serial)}` : ''}</div>` },
    { label: 'Tonnes', num: true, render: (c) => `${t3(c.tonnes)}${c.sold ? `<div class="cell-sub">${t3(c.sold)} sold</div>` : ''}` },
    { label: 'Status', render: (c) => tag(...CC_ST[c.status]) },
    { label: '', render: (c) => (!canWrite ? '' : c.status === 'issued' ? (c.available > 0 ? `<button ${BTN} data-csell="${c.id}">Sell…</button>` : '') : `<button ${BTN} data-cupd="${c.id}">${c.status === 'estimated' ? 'Verify…' : 'Issue…'}</button>`) },
  ], rows: d.credits, empty: 'No credits yet.' });
  table($('[data-cs]', el), { columns: [{ label: 'Site', render: (s) => esc(s.site) }, { label: 'MWh', num: true, render: (s) => t3(s.mwh) }, { label: 'REC MWh', num: true, render: (s) => t3(s.recMwh) }, { label: 'Green', num: true, render: (s) => `${s.greenPct}%` }, { label: 'Avoided (t)', num: true, render: (s) => t3(s.avoidedTonnes) }], rows: m.sites, empty: 'No sites.' });
  $('[data-cx]', el).addEventListener('click', () => fetchFile(`/v1/finance/carbon?format=xlsx&from=${from}&to=${to}`, `plugsure-carbon-${from}-${to}.xlsx`));
  const post = async (url, body, method = 'POST') => { try { await api(url, { method, body }); toast('Saved.', 'ok'); reload(); return true; } catch (err) { toast(err.message, 'crit'); return false; } };
  $('[data-cset]', el)?.addEventListener('click', () => modal({ title: 'Emission factors', body: `<div class="form">${field('Grid (kg CO2e per kWh)', `<input name="g" type="number" step="0.001" min="0" value="${m.settings.gridKgPerKwh}">`)}${field('Petrol car (kg CO2e per kWh equivalent)', `<input name="i" type="number" step="0.001" min="0" value="${m.settings.iceKgPerKwh}">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: (mc) => post('/v1/finance/carbon/settings', { gridKgPerKwh: Number($('[name="g"]', mc.el).value), iceKgPerKwh: Number($('[name="i"]', mc.el).value) }, 'PUT') }] }));
  $('[data-cbuy]', el)?.addEventListener('click', () => modal({ title: 'RECs bought', size: 'lg', body: `<div class="form">${field('Registry', '<input name="r" placeholder="I-REC, PLN REC…">')}${field('Reference', '<input name="ref">', { opt: true })}${field('Vintage', `<input name="v" type="number" value="${new Date().getFullYear()}">`)}${field('MWh', '<input name="mwh" type="number" step="0.001" min="0">')}${field('Price', '<input name="p" type="number" min="0">')}${field('Currency', `<input name="c" maxlength="3" value="${esc(LEGACY_CURRENCY)}">`)}${field('Bought on', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Site', '<select name="site"><option value="">Portfolio</option></select>', { opt: true })}</div>`,
    async onMount(mc) { const ss = await sitesList(); $('[name="site"]', mc.el).innerHTML = `<option value="">Portfolio</option>${ss.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}`; },
    actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value.trim(); return post('/v1/finance/carbon/recs', { registry: v('r'), reference: v('ref') || undefined, vintage: Number(v('v')), mwh: Number(v('mwh')), price: Number(v('p') || 0), currency: v('c'), boughtOn: v('on'), siteId: v('site') || undefined }); } }] }));
  $('[data-cest]', el)?.addEventListener('click', () => modal({ title: 'Estimate carbon credits', body: `<div class="form">${field('From', `<input name="f" type="month" value="${esc(from)}">`)}${field('To', `<input name="t" type="month" value="${esc(to)}">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Estimate', kind: 'primary', onClick: (mc) => post('/v1/finance/carbon/credits', { from: $('[name="f"]', mc.el).value, to: $('[name="t"]', mc.el).value }) }] }));
  el.addEventListener('click', (e) => {
    const r = e.target.closest('[data-cret]'), u = e.target.closest('[data-cupd]'), s = e.target.closest('[data-csell]');
    if (r) modal({ title: 'Retire RECs', body: `<div class="form one">${field('Against the month', `<input name="m" type="month" value="${esc(m.month)}">`)}</div>`, actions: [{ label: 'Cancel' }, { label: 'Retire', kind: 'primary', onClick: (mc) => post(`/v1/finance/carbon/recs/${r.dataset.cret}/retire`, { month: $('[name="m"]', mc.el).value }) }] });
    if (u) {
      const c = d.credits.find((x) => x.id === u.dataset.cupd), next = c.status === 'estimated' ? 'verified' : 'issued';
      modal({ title: next === 'verified' ? 'Verify credits' : 'Issue credits', body: `<div class="form">${field('Tonnes', `<input name="t" type="number" step="0.001" min="0" value="${c.tonnes}">`)}${field('Standard', `<input name="s" value="${esc(c.standard ?? '')}" placeholder="Verra VCS, Gold Standard, SPEI…">`, { opt: true })}${next === 'issued' ? field('Registry serial', '<input name="sr">') : ''}</div>`,
        actions: [{ label: 'Void', async onClick() { return post(`/v1/finance/carbon/credits/${c.id}`, { status: 'void' }, 'PUT'); } }, { label: 'Cancel' }, { label: next === 'verified' ? 'Verified' : 'Issued', kind: 'primary', onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el)?.value.trim(); return post(`/v1/finance/carbon/credits/${c.id}`, { status: next, tonnes: Number(v('t')), standard: v('s') || undefined, serial: v('sr') || undefined }, 'PUT'); } }] });
    }
    if (s) {
      const c = d.credits.find((x) => x.id === s.dataset.csell);
      modal({ title: 'Sell carbon credits', subtitle: `${t3(c.available)} t available`, body: `<div class="form">${field('Buyer', '<input name="b">')}${field('Tonnes', `<input name="t" type="number" step="0.001" min="0" max="${c.available}" value="${c.available}">`)}${field('Amount', '<input name="a" type="number" min="0">')}${field('Currency', `<input name="c" maxlength="3" value="${esc(LEGACY_CURRENCY)}">`)}${field('Sold on', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Reference', '<input name="ref">', { opt: true })}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value.trim(); return post(`/v1/finance/carbon/credits/${c.id}/sales`, { buyer: v('b'), tonnes: Number(v('t')), amount: Number(v('a')), currency: v('c'), soldOn: v('on'), reference: v('ref') || undefined }); } }] });
    }
  });
}

// ─────────────────────────────────────────── (v1.35.0) insurance

const IN_KIND = { property: 'Property', equipment: 'Equipment', liability: 'Liability', business_interruption: 'Business interruption', vehicle: 'Vehicle', other: 'Other' };
const CL_ST = { reported: ['t-warn', 'reported'], submitted: ['t-info', 'submitted'], accepted: ['t-info', 'accepted'], rejected: ['t-crit', 'rejected'], paid: ['t-ok', 'paid'], closed: ['t-mute', 'closed'] };
const CL_NEXT = { reported: ['submitted', 'closed'], submitted: ['accepted', 'rejected'], accepted: ['paid'], rejected: ['closed', 'submitted'], paid: ['closed'], closed: [] };

async function insuranceSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api('/v1/finance/insurance'); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => insuranceSection(host, canWrite);
  const tot = Object.entries(d.totals);
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px;flex-wrap:wrap">${canWrite ? `<button class="btn primary" type="button" data-inew>${icon('plus')} Policy</button>` : ''}<button class="btn" type="button" data-ix>${icon('download')} Register (Excel)</button></div>
    ${d.renewing.length ? callout('warn', `${d.renewing.length} polic${d.renewing.length === 1 ? 'y ends' : 'ies end'} within 30 days: ${d.renewing.map((p) => `${esc(p.insurer)} ${esc(p.policyNo)} (${esc(p.endOn)})`).join(', ')}.`) : ''}
    <div class="grid k4 section">${tot.map(([c, t]) => kpi(`Cover in force · ${c}`, esc(fmt.money(t.cover, c)), `premium ${esc(fmt.money(t.premium, c))}`)).join('') || kpi('Cover in force', '—', 'no policies')}${tot.map(([c, t]) => kpi(`Prepaid · ${c}`, esc(fmt.money(t.prepaid, c)), 'premium not yet expensed')).join('')}${tot.map(([c, t]) => kpi(`Recovered · ${c}`, esc(fmt.money(t.settled, c)), t.recoveryPct == null ? 'no claims' : `${t.recoveryPct}% of ${esc(fmt.money(t.loss, c))} lost`)).join('')}</div>
    <div class="card section"><header><h3>Policies</h3></header><div data-ip></div></div><div class="card section"><header><h3>Claims</h3></header><div data-ic></div></div>`;
  table($('[data-ip]', el), { columns: [
    { label: 'Policy', render: (p) => `<b>${esc(p.insurer)}</b> ${esc(p.policyNo)}<div class="cell-sub">${esc(IN_KIND[p.kind])} · ${esc(p.chargePoint ?? p.site ?? 'Organisation')}</div>` },
    { label: 'Term', render: (p) => `${esc(p.startOn)} – ${esc(p.endOn)}<div class="cell-sub">${p.status === 'cancelled' ? 'cancelled' : p.renewed ? 'renewed' : p.inForce ? `${p.daysLeft} days left` : p.daysLeft < 0 ? 'ended' : 'not started'}</div>` },
    { label: 'Cover', num: true, render: (p) => esc(fmt.money(p.cover, p.currency)) },
    { label: 'Premium', num: true, render: (p) => `${esc(fmt.money(p.premium, p.currency))}<div class="cell-sub">${p.paidOn ? `paid ${esc(p.paidOn)}` : 'not paid'}</div>` },
    { label: 'Claims', num: true, render: (p) => (p.claims ? `${p.claims}<div class="cell-sub">${esc(fmt.money(p.recovered, p.currency))} recovered</div>` : '') },
    { label: '', render: (p) => (canWrite && p.status === 'active' ? `<button ${BTN} data-iclaim="${p.id}">Claim…</button>${!p.renewed ? ` <button ${BTN} data-iren="${p.id}">Renew…</button>` : ''} <button ${BTN} data-iedit="${p.id}">Edit</button>` : '') },
  ], rows: d.policies, empty: 'No policies yet.' });
  table($('[data-ic]', el), { columns: [
    { label: 'Claim', render: (c) => `<b>${esc(c.number)}</b> · ${esc(c.kind)}<div class="cell-sub">${esc(c.policy)} · ${esc(c.incidentOn)}${c.workOrder ? ` · ${esc(c.workOrder)}` : ''}</div><div class="cell-sub">${esc(c.description)}</div>` },
    { label: 'Loss', num: true, render: (c) => `${esc(fmt.money(c.loss, c.currency))}<div class="cell-sub">excess ${esc(fmt.money(c.excess, c.currency))}</div>` },
    { label: 'Settled', num: true, render: (c) => (c.settled == null ? '' : `<b>${esc(fmt.money(c.settled, c.currency))}</b><div class="cell-sub">${esc(c.paidOn ?? '')}</div>`) },
    { label: 'Status', render: (c) => tag(...CL_ST[c.status]) },
    { label: '', render: (c) => (canWrite && CL_NEXT[c.status].length ? `<button ${BTN} data-iupd="${c.id}">Update…</button>` : '') },
  ], rows: d.claims, empty: 'No claims.' });
  $('[data-ix]', el).addEventListener('click', () => fetchFile('/v1/finance/insurance?format=xlsx', 'plugsure-insurance.xlsx'));
  const send = async (url, body, method = 'POST') => { try { await api(url, { method, body }); toast('Saved.', 'ok'); reload(); return true; } catch (err) { toast(err.message, 'crit'); return false; } };
  let accts = null;
  const accounts = async () => (accts ??= await api('/v1/finance/cash').then((r) => r.accounts ?? []).catch(() => []));
  const form = (p) => modal({ title: p ? `${p.insurer} ${p.policyNo}` : 'Add a policy', size: 'lg', body: `<div class="form">${field('Insurer', `<input name="ins" value="${esc(p?.insurer ?? '')}">`)}${field('Policy number', `<input name="no" value="${esc(p?.policyNo ?? '')}">`)}
      ${field('Kind', `<select name="k">${Object.entries(IN_KIND).map(([k, l]) => `<option value="${k}"${p?.kind === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}${field('Site', '<select name="site"><option value="">Organisation</option></select>', { opt: true })}
      ${field('Currency', `<input name="c" maxlength="3" value="${esc(p?.currency ?? LEGACY_CURRENCY)}">`)}${field('Cover', `<input name="cv" type="number" min="1" value="${p?.cover ?? ''}">`)}${field('Premium', `<input name="pr" type="number" min="0" value="${p?.premium ?? ''}">`)}${field('Excess', `<input name="ex" type="number" min="0" value="${p?.excess ?? 0}">`)}
      ${field('Start', `<input name="s" type="date" value="${esc(p?.startOn ?? '')}">`)}${field('End', `<input name="e" type="date" value="${esc(p?.endOn ?? '')}">`)}${field('Premium paid on', `<input name="pd" type="date" value="${esc(p?.paidOn ?? '')}">`, { opt: true })}${field('Paid from', '<select name="acct"><option value="">—</option></select>', { opt: true })}
      ${p ? field('Status', `<select name="st"><option value="active">Active</option><option value="cancelled">Cancelled</option></select>`) : ''}</div>`,
    async onMount(mc) {
      const [ss, as] = await Promise.all([sitesList(), accounts()]);
      $('[name="site"]', mc.el).innerHTML = `<option value="">Organisation</option>${ss.map((s) => `<option value="${esc(s.id)}"${p?.siteId === s.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}`;
      $('[name="acct"]', mc.el).innerHTML = `<option value="">—</option>${as.map((a) => `<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.currency)}</option>`).join('')}`;
    },
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el)?.value.trim();
      return send(p ? `/v1/finance/insurance/policies/${p.id}` : '/v1/finance/insurance/policies', { insurer: v('ins'), policyNo: v('no'), kind: v('k'), siteId: v('site') || null, currency: v('c'), cover: Number(v('cv')), premium: Number(v('pr') || 0), excess: Number(v('ex') || 0), startOn: v('s'), endOn: v('e'), paidOn: v('pd') || null, cashAccountId: v('acct') || (p ? undefined : null), ...(p ? { status: v('st') } : {}) }, p ? 'PUT' : 'POST');
    } }] });
  $('[data-inew]', el)?.addEventListener('click', () => form(null));
  el.addEventListener('click', (e) => {
    const ed = e.target.closest('[data-iedit]'), cl = e.target.closest('[data-iclaim]'), rn = e.target.closest('[data-iren]'), up = e.target.closest('[data-iupd]');
    if (ed) form(d.policies.find((p) => p.id === ed.dataset.iedit));
    if (cl) modal({ title: 'Report a claim', body: `<div class="form">${field('Kind', '<select name="k"><option value="damage">Damage</option><option value="theft">Theft</option><option value="liability">Liability</option><option value="interruption">Business interruption</option><option value="other">Other</option></select>')}${field('Incident on', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Loss', '<input name="l" type="number" min="0">')}${field('Work order id', '<input name="wo">', { opt: true })}${field('What happened', '<textarea name="d" rows="3"></textarea>')}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Report', kind: 'primary', onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value.trim(); return send(`/v1/finance/insurance/policies/${cl.dataset.iclaim}/claims`, { kind: v('k'), incidentOn: v('on'), loss: Number(v('l')), workOrderId: v('wo') || undefined, description: v('d') }); } }] });
    if (rn) { const p = d.policies.find((x) => x.id === rn.dataset.iren); modal({ title: `Renew ${p.insurer} ${p.policyNo}`, subtitle: `From ${p.endOn}`, body: `<div class="form">${field('New policy number', `<input name="no" value="${esc(p.policyNo)}-R">`)}${field('Premium', `<input name="pr" type="number" min="0" value="${p.premium}">`)}${field('Cover', `<input name="cv" type="number" min="1" value="${p.cover}">`)}${field('Ends', '<input name="e" type="date">', { opt: true })}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Renew', kind: 'primary', onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value.trim(); return send(`/v1/finance/insurance/policies/${p.id}/renew`, { policyNo: v('no'), premium: Number(v('pr')), cover: Number(v('cv')), endOn: v('e') || undefined }); } }] }); }
    if (up) { const c = d.claims.find((x) => x.id === up.dataset.iupd); modal({ title: `${c.number} · ${c.status}`, subtitle: `Loss ${fmt.money(c.loss, c.currency)}, excess ${fmt.money(c.excess, c.currency)}`, body: `<div class="form">${field('Move to', `<select name="s">${CL_NEXT[c.status].map((s) => `<option value="${s}">${s}</option>`).join('')}</select>`)}${field('Settled (when paid)', `<input name="a" type="number" min="0" value="${Math.max(0, c.loss - c.excess)}">`, { opt: true })}${field('Paid on', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`, { opt: true })}${field('Insurer reference', `<input name="ref" value="${esc(c.insurerRef ?? '')}">`, { opt: true })}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value.trim(); const paid = v('s') === 'paid'; return send(`/v1/finance/insurance/claims/${c.id}`, { status: v('s'), settled: paid ? Number(v('a')) : undefined, paidOn: paid ? v('on') : undefined, insurerRef: v('ref') || undefined }); } }] }); }
  });
}

// ─────────────────────────────────────────── (v1.35.0) pricing profitability

const BAND_L = { night: 'Night 22–06', day: 'Day 06–17', peak: 'Peak 17–22' };

async function pricingSection(host, canWrite, months = 3) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api(`/v1/finance/pricing?months=${months}`); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = (n = months) => pricingSection(host, canWrite, n);
  const money = (v, c) => (v == null ? '<span class="cell-sub">—</span>' : esc(fmt.money(v, c)));
  const cols = (dim) => [
    { label: dim === 'band' ? 'Time band' : dim === 'connector' ? 'Connector' : dim === 'site' ? 'Site' : 'Tariff', render: (r) => `<b>${esc(dim === 'band' ? BAND_L[r.key] ?? r.label : r.label)}</b> <span class="cell-sub">${esc(r.currency)}</span><div class="cell-sub">${r.sessions} sessions · ${fmt.num(r.kwh)} kWh${r.notCostedKwh ? ` · ${fmt.num(r.notCostedKwh)} kWh not costed` : ''}</div>` },
    { label: 'Revenue', num: true, render: (r) => money(r.revenue, r.currency) },
    { label: 'Energy cost', num: true, render: (r) => money(r.energyCost, r.currency) },
    { label: 'Margin', num: true, render: (r) => `<b>${money(r.margin, r.currency)}</b>${r.marginPct != null ? `<div class="cell-sub">${r.marginPct}%</div>` : ''}` },
    { label: 'Per kWh', num: true, render: (r) => `${r.pricePerKwh == null ? '—' : esc(fmt.money(r.pricePerKwh, r.currency))}<div class="cell-sub">cost ${r.costPerKwh == null ? '—' : esc(fmt.money(r.costPerKwh, r.currency))}</div>` },
    { label: '', render: (r) => `<button ${BTN} data-pwi="${esc(dim)}|${esc(r.key)}|${esc(r.currency)}">What if…</button>` },
  ];
  const tot = d.totals;
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Months', `<select data-pm>${[1, 3, 6, 12].map((n) => `<option value="${n}"${n === months ? ' selected' : ''}>Last ${n} whole month${n === 1 ? '' : 's'}</option>`).join('')}</select>`)}<div class="row" style="align-self:flex-end;gap:6px"><button class="btn" type="button" data-px>${icon('download')} Excel</button></div></div>
    ${callout('info', `Energy cost per session from the site's bill for the month spread over the kWh delivered, else the site's cost per kWh (Finance → Energy). ${d.months[0]} to ${d.months.at(-1)}.`)}
    <div class="grid k4 section">${tot.map((t) => kpi(`Margin · ${t.currency}`, money(t.margin, t.currency), t.marginPct != null ? `${t.marginPct}% of ${esc(fmt.money(t.revenue, t.currency))}` : 'no cost known')).join('') || kpi('Margin', '—', 'no charging')}${tot.map((t) => kpi(`Per kWh · ${t.currency}`, t.pricePerKwh == null ? '—' : esc(fmt.money(t.pricePerKwh, t.currency)), `cost ${t.costPerKwh == null ? '—' : esc(fmt.money(t.costPerKwh, t.currency))}`)).join('')}${kpi('Price elasticity', String(d.elasticity.used), d.elasticity.source === 'observed' ? `median of ${d.elasticity.observations.length} price moves` : d.elasticity.observations.length ? `assumed: ${d.elasticity.observations.length} price move(s) observed (median ${d.elasticity.estimate}), ${d.elasticity.minObservations} needed` : 'assumed: no price moves of 5% or more yet')}</div>
    <div class="card section"><header><h3>By tariff</h3></header><div data-pt></div></div><div class="card section"><header><h3>By time band</h3></header><div data-pb></div></div>
    <div class="grid k2 section"><div class="card"><header><h3>By connector</h3></header><div data-pc></div></div><div class="card"><header><h3>Price moves</h3><span class="cell-sub">month on month, ≥ 5%</span></header><div data-pe></div></div></div>
    <div class="card section"><header><h3>By site</h3></header><div data-ps></div></div>`;
  table($('[data-pt]', el), { columns: cols('tariff'), rows: d.tariff, empty: 'No charging in the period.' });
  table($('[data-pb]', el), { columns: cols('band'), rows: d.band, empty: 'No charging in the period.' });
  table($('[data-pc]', el), { columns: cols('connector').slice(0, 4), rows: d.connector, empty: 'No charging in the period.' });
  table($('[data-ps]', el), { columns: cols('site'), rows: d.site, empty: 'No charging in the period.' });
  table($('[data-pe]', el), { columns: [{ label: 'Site', render: (o) => `${esc(o.site)}<div class="cell-sub">${esc(o.from)} → ${esc(o.to)}</div>` }, { label: 'Price', num: true, render: (o) => `${esc(fmt.money(o.priceBefore, o.currency))} → ${esc(fmt.money(o.priceAfter, o.currency))}` }, { label: 'kWh/day', num: true, render: (o) => `${fmt.num(o.kwhPerDayBefore)} → ${fmt.num(o.kwhPerDayAfter)}` }, { label: 'Elasticity', num: true, render: (o) => String(o.elasticity) }], rows: d.elasticity.observations, empty: 'No price moves of 5% or more in the last twelve months.' });
  $('[data-pm]', el).addEventListener('change', (e) => reload(Number(e.target.value)));
  $('[data-px]', el).addEventListener('click', () => fetchFile(`/v1/finance/pricing?months=${months}&format=xlsx`, 'plugsure-pricing.xlsx'));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pwi]');
    if (!b) return;
    const [dimension, key, currency] = b.dataset.pwi.split('|');
    modal({ title: 'Price what-if', subtitle: `${dimension === 'band' ? BAND_L[key] ?? key : key} · ${currency}`, body: `<div class="form">${field('Price change %', '<input name="c" type="number" step="0.5" min="-50" max="100" value="10">')}${field('Elasticity', `<input name="e" type="number" step="0.05" min="-5" max="1" value="${d.elasticity.used}">`)}</div><div data-wr style="margin-top:10px"></div>`,
      actions: [{ label: 'Close' }, { label: 'Calculate', kind: 'primary', async onClick(mc) {
        try {
          const w = await api('/v1/finance/pricing/what-if', { method: 'POST', body: { months, dimension, key, currency, changePct: Number($('[name="c"]', mc.el).value), elasticity: Number($('[name="e"]', mc.el).value) } });
          const row = (l, a, z) => `<tr><td>${l}</td><td class="num">${a}</td><td class="num">${z}</td></tr>`;
          $('[data-wr]', mc.el).innerHTML = `<table class="table"><thead><tr><th></th><th class="num">Now</th><th class="num">After</th></tr></thead><tbody>${row('kWh', fmt.num(w.before.kwh), fmt.num(w.after.kwh))}${row('Price per kWh', money(w.before.pricePerKwh, currency), money(w.after.pricePerKwh, currency))}${row('Revenue', money(w.before.revenue, currency), money(w.after.revenue, currency))}${row('Energy cost', money(w.before.energyCost, currency), money(w.after.energyCost, currency))}${row('<b>Margin</b>', money(w.before.margin, currency), `<b>${money(w.after.margin, currency)}</b>`)}</tbody></table>
            ${w.deltaMargin != null ? callout(w.deltaMargin >= 0 ? 'ok' : 'warn', `Margin ${w.deltaMargin >= 0 ? 'up' : 'down'} ${esc(fmt.money(Math.abs(w.deltaMargin), currency))} over the period.`) : ''}`;
        } catch (err) { toast(err.message, 'crit'); }
        return false;
      } }] });
  });
}

// ─────────────────────────────────────────── (v1.35.0) audit and compliance calendar

const CM_CAT = { financial_statements: 'Financial statements', regulator: 'Regulator', licence: 'Licence', corporate: 'Corporate', tax_other: 'Other tax', audit: 'Audit', other: 'Other' };
const PBC_ST = { requested: ['t-warn', 'requested'], in_progress: ['t-info', 'in progress'], provided: ['t-info', 'provided'], accepted: ['t-ok', 'accepted'] };
const EV_MIMES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', csv: 'text/csv' };

async function complianceSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api('/v1/finance/compliance'); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => complianceSection(host, canWrite);
  const st = d.stats;
  const state = (t) => (t.status === 'done' ? tag(t.onTime ? 't-ok' : 't-warn', t.onTime ? 'done' : 'done late') : t.status === 'waived' ? tag('t-mute', 'waived') : t.overdue ? tag('t-crit', 'overdue') : t.daysLeft <= t.remindDays ? tag('t-warn', `${t.daysLeft} days`) : tag('t-info', 'open'));
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px;flex-wrap:wrap">${canWrite ? `<button class="btn primary" type="button" data-mnew>${icon('plus')} Deadline</button><button class="btn" type="button" data-mtpl>Add the standard deadlines…</button><button class="btn" type="button" data-bnew>${icon('plus')} Auditor request</button>` : ''}<button class="btn" type="button" data-mx>${icon('download')} Excel</button></div>
    ${callout('info', 'Statutory, licence and audit deadlines other than tax (tax is in Taxes → Calendar). Reminders start the set number of days ahead; marking a recurring deadline done creates the next one.')}
    <div class="grid k4 section">${kpi('Overdue', String(st.overdue), 'open past the due date', st.overdue ? 'crit' : '')}${kpi('Due in 30 days', String(st.dueIn30), `${st.open} open this year`, st.dueIn30 ? 'warn' : '')}${kpi('On time', st.onTimePct == null ? '—' : `${st.onTimePct}%`, 'done by the due date, last 12 months')}${kpi('Auditor requests', String(st.pbcOpen), st.pbcOverdue ? `${st.pbcOverdue} overdue` : 'open', st.pbcOverdue ? 'warn' : '')}</div>
    <div class="card section"><header><h3>Calendar · ${esc(d.from.slice(0, 4))}</h3></header><div data-ml></div></div><div class="card section"><header><h3>Auditor requests (PBC)</h3></header><div data-mb></div></div>`;
  table($('[data-ml]', el), { columns: [
    { label: 'Due', render: (t) => `<b>${esc(t.dueOn)}</b>${t.recurrence !== 'none' ? `<div class="cell-sub">${esc(t.recurrence)}</div>` : ''}` },
    { label: 'Deadline', render: (t) => `<b>${esc(t.title)}</b><div class="cell-sub">${esc(CM_CAT[t.category])}${t.authority ? ` · ${esc(t.authority)}` : ''}${t.owner ? ` · ${esc(t.owner)}` : ''}</div>` },
    { label: 'Files', num: true, render: (t) => (t.files ? String(t.files) : '') },
    { label: 'Status', render: state },
    { label: '', render: (t) => `<button ${BTN} data-mopen="${t.id}">Open</button>` },
  ], rows: d.tasks, empty: 'Nothing due this year. Add the standard deadlines to start.' });
  table($('[data-mb]', el), { columns: [
    { label: 'Request', render: (p) => `<b>${esc(p.ref ? `${p.ref} · ` : '')}${esc(p.item)}</b><div class="cell-sub">${esc(p.audit)} · asked ${esc(p.requestedOn)}${p.owner ? ` · ${esc(p.owner)}` : ''}</div>` },
    { label: 'Due', render: (p) => `${esc(p.dueOn ?? '')}${p.overdue ? ` ${tag('t-crit', 'overdue')}` : ''}` },
    { label: 'Files', num: true, render: (p) => (p.files ? String(p.files) : '') },
    { label: 'Status', render: (p) => tag(...PBC_ST[p.status]) },
    { label: '', render: (p) => `<button ${BTN} data-bopen="${p.id}">Open</button>` },
  ], rows: d.pbc, empty: 'No requests from the auditors.' });
  $('[data-mx]', el).addEventListener('click', () => fetchFile('/v1/finance/compliance?format=xlsx', 'plugsure-compliance.xlsx'));
  const send = async (url, body, method = 'POST') => { try { const r = await api(url, { method, body }); toast('Saved.', 'ok'); reload(); return r; } catch (err) { toast(err.message, 'crit'); return false; } };
  const upload = (url) => modal({ title: 'Attach evidence', body: `<div class="form one">${field('File (PDF, PNG, JPEG, XLSX, DOCX or CSV; up to 5 MB)', '<input name="f" type="file" accept=".pdf,.png,.jpg,.jpeg,.xlsx,.docx,.csv">')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Attach', kind: 'primary', async onClick(mc) {
      const f = $('[name="f"]', mc.el).files[0];
      if (!f) { toast('Choose a file.', 'warn'); return false; }
      const mime = EV_MIMES[(f.name.split('.').pop() ?? '').toLowerCase()];
      if (!mime) { toast('That type of file is not accepted.', 'warn'); return false; }
      if (f.size > 5 * 1024 * 1024) { toast('A file is at most 5 MB.', 'warn'); return false; }
      return send(url, { filename: f.name, mime, data: await fileB64(f) });
    } }] });
  const files = (list) => (list.length ? `<ul class="plain">${list.map((f) => `<li><a href="#" data-evdl="${f.id}" data-evn="${esc(f.filename)}">${esc(f.filename)}</a> <span class="cell-sub">${fmt.num(Math.round(f.bytes / 1024))} KB · ${esc(f.uploadedBy ?? '')} · <span class="mono">${esc(f.sha256.slice(0, 12))}</span></span></li>`).join('')}</ul>` : '<p class="cell-sub">No files yet.</p>');
  const form = (t) => modal({ title: t ? t.title : 'Add a deadline', size: 'lg', body: `<div class="form">${field('Title', `<input name="t" value="${esc(t?.title ?? '')}">`)}${field('Category', `<select name="c">${Object.entries(CM_CAT).map(([k, l]) => `<option value="${k}"${t?.category === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}${field('Authority', `<input name="a" value="${esc(t?.authority ?? '')}">`, { opt: true })}${field('Due', `<input name="d" type="date" value="${esc(t?.dueOn ?? '')}">`)}${field('Recurs', `<select name="r">${['none', 'monthly', 'quarterly', 'yearly'].map((r) => `<option${t?.recurrence === r ? ' selected' : ''}>${r}</option>`).join('')}</select>`)}${field('Remind days ahead', `<input name="rd" type="number" min="0" max="120" value="${t?.remindDays ?? 14}">`)}${field('Note', `<input name="n" value="${esc(t?.note ?? '')}">`, { opt: true })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value.trim(); return send(t ? `/v1/finance/compliance/tasks/${t.id}` : '/v1/finance/compliance/tasks', { title: v('t'), category: v('c'), authority: v('a') || null, dueOn: v('d'), recurrence: v('r'), remindDays: Number(v('rd')), note: v('n') || null }, t ? 'PUT' : 'POST'); } }] });
  $('[data-mnew]', el)?.addEventListener('click', () => form(null));
  $('[data-mtpl]', el)?.addEventListener('click', () => modal({ title: 'Add the standard deadlines', body: `<div class="form one">${field('Year', `<input name="y" type="number" value="${new Date().getFullYear()}">`)}</div>${callout('info', 'LKPM to BKPM, the manpower report (WLKP), the charging-station report to the energy ministry, the audited financial statements and the annual GMS. Each is added once; check the dates with your advisers.')}`,
    actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', async onClick(mc) { const r = await send('/v1/finance/compliance/templates', { year: Number($('[name="y"]', mc.el).value) }); if (r) toast(`${r.added} of ${r.templates} added.`, 'ok'); return !!r; } }] }));
  $('[data-bnew]', el)?.addEventListener('click', () => modal({ title: 'Add an auditor request', body: `<div class="form">${field('Audit', `<input name="a" value="FY ${new Date().getFullYear() - 1}">`)}${field('Reference', '<input name="r">', { opt: true })}${field('Item', '<input name="i" placeholder="e.g. Bank confirmations">')}${field('Due', '<input name="d" type="date">', { opt: true })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value.trim(); return send('/v1/finance/compliance/pbc', { audit: v('a'), ref: v('r') || undefined, item: v('i'), dueOn: v('d') || undefined }); } }] }));
  el.addEventListener('click', async (e) => {
    const dl = e.target.closest('[data-evdl]');
    if (dl) { e.preventDefault(); fetchFile(`/v1/finance/compliance/evidence/${dl.dataset.evdl}`, dl.dataset.evn); return; }
    const o = e.target.closest('[data-mopen]'), b = e.target.closest('[data-bopen]');
    if (o) {
      let t;
      try { t = await api(`/v1/finance/compliance/tasks/${o.dataset.mopen}`); } catch (err) { toast(err.message, 'crit'); return; }
      drawer({ title: t.title, subtitle: `${CM_CAT[t.category]} · due ${t.dueOn}`, tabs: [{ id: 't', label: 'Deadline', render(body) {
        body.innerHTML = `<div class="grid k4">${kpi('Due', esc(t.dueOn), t.status !== 'open' ? t.status : t.daysLeft < 0 ? `${-t.daysLeft} days overdue` : t.daysLeft === 0 ? 'today' : `in ${t.daysLeft} days`)}${kpi('Recurs', esc(t.recurrence), t.nextId ? 'next one created' : '')}${kpi('Owner', esc(t.owner ?? '—'), esc(t.authority ?? ''))}${kpi('Done', esc(t.doneOn ?? '—'), esc(t.doneBy ?? ''))}</div>${t.note ? `<p>${esc(t.note)}</p>` : ''}<h4 style="margin:16px 0 6px">Evidence</h4>${files(t.evidence)}
          <div class="row" style="gap:6px;margin-top:10px">${canWrite && t.status !== 'waived' ? `<button ${BTN} data-tup>Attach…</button>` : ''}${canWrite && t.status === 'open' ? `<button ${BTN} data-tdone>Mark done</button><button ${BTN} data-twaive>Waive…</button><button ${BTN} data-tedit>Edit</button>` : ''}${canWrite && t.status !== 'open' ? `<button ${BTN} data-treopen>Reopen</button>` : ''}</div>`;
        $('[data-tup]', body)?.addEventListener('click', () => upload(`/v1/finance/compliance/tasks/${t.id}/evidence`));
        $('[data-tdone]', body)?.addEventListener('click', () => send(`/v1/finance/compliance/tasks/${t.id}/status`, { status: 'done' }));
        $('[data-treopen]', body)?.addEventListener('click', () => send(`/v1/finance/compliance/tasks/${t.id}/status`, { status: 'open' }));
        $('[data-tedit]', body)?.addEventListener('click', () => form(t));
        $('[data-twaive]', body)?.addEventListener('click', () => modal({ title: 'Waive the deadline', body: `<div class="form one">${field('Why', '<input name="n">')}</div>`, actions: [{ label: 'Cancel' }, { label: 'Waive', kind: 'primary', onClick: (mc) => send(`/v1/finance/compliance/tasks/${t.id}/status`, { status: 'waived', note: $('[name="n"]', mc.el).value.trim() }) }] }));
      } }] });
    }
    if (b) {
      let p;
      try { p = await api(`/v1/finance/compliance/pbc/${b.dataset.bopen}`); } catch (err) { toast(err.message, 'crit'); return; }
      const NX = { requested: ['in_progress', 'provided'], in_progress: ['provided'], provided: ['accepted', 'in_progress'], accepted: [] };
      drawer({ title: p.item, subtitle: `${p.audit}${p.ref ? ` · ${p.ref}` : ''}`, tabs: [{ id: 'p', label: 'Request', render(body) {
        body.innerHTML = `<div class="grid k4">${kpi('Status', esc(p.status.replace('_', ' ')), p.providedOn ? `provided ${esc(p.providedOn)}` : '')}${kpi('Due', esc(p.dueOn ?? '—'), p.overdue ? 'overdue' : '')}${kpi('Asked', esc(p.requestedOn), '')}${kpi('Owner', esc(p.owner ?? '—'), '')}</div><h4 style="margin:16px 0 6px">Files</h4>${files(p.evidence)}
          <div class="row" style="gap:6px;margin-top:10px">${canWrite && p.status !== 'accepted' ? `<button ${BTN} data-pup>Attach…</button>${NX[p.status].map((s) => `<button ${BTN} data-pst="${s}">${s === 'in_progress' ? 'In progress' : s === 'provided' ? 'Provided' : 'Accepted'}</button>`).join('')}` : ''}</div>`;
        $('[data-pup]', body)?.addEventListener('click', () => upload(`/v1/finance/compliance/pbc/${p.id}/evidence`));
        body.querySelectorAll('[data-pst]').forEach((x) => x.addEventListener('click', () => send(`/v1/finance/compliance/pbc/${p.id}`, { status: x.dataset.pst }, 'PUT')));
      } }] });
    }
  });
}

// ─────────────────────────────────────────── (v1.36.0) grants and incentives

const GR_KIND = { capital: 'Capital (deferred)', revenue: 'Revenue', per_kwh: 'Per kWh' };
const GR_ST = { applied: ['t-mute', 'applied'], awarded: ['t-info', 'awarded'], active: ['t-ok', 'active'], completed: ['t-mute', 'completed'], rejected: ['t-mute', 'rejected'], clawed_back: ['t-crit', 'clawed back'] };
const GC_ST = { draft: ['t-mute', 'draft'], submitted: ['t-info', 'submitted'], approved: ['t-info', 'approved'], rejected: ['t-crit', 'rejected'], paid: ['t-ok', 'paid'] };
const GC_NEXT = { draft: ['submitted'], submitted: ['approved', 'rejected', 'paid'], approved: ['paid'], rejected: [], paid: [] };
const COND_ST = { pending: ['t-warn', 'pending'], met: ['t-ok', 'met'], breached: ['t-crit', 'breached'], waived: ['t-mute', 'waived'] };

async function grantsSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api('/v1/finance/grants'); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => grantsSection(host, canWrite);
  const tot = Object.entries(d.totals);
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px;flex-wrap:wrap">${canWrite ? `<button class="btn primary" type="button" data-gnew>${icon('plus')} Grant</button>` : ''}<button class="btn" type="button" data-gx>${icon('download')} Register (Excel)</button></div>
    ${callout('info', 'Capital grants are deferred when received and released to grant income over their period; revenue and per-kWh grants are income when a claim is approved. A breached condition can mean a clawback.')}
    ${d.conditionsDue.length ? callout('warn', `${d.conditionsDue.length} condition(s) due within 30 days: ${d.conditionsDue.slice(0, 3).map((c) => `${esc(c.grant)}: ${esc(c.description)} (${esc(c.dueOn)})`).join('; ')}.`) : ''}
    <div class="grid k4 section">${tot.map(([c, t]) => kpi(`Awarded · ${c}`, esc(fmt.money(t.awarded, c)), `${esc(fmt.money(t.toClaim, c))} still to claim`)).join('') || kpi('Awarded', '—', 'no grants')}${tot.map(([c, t]) => kpi(`Received · ${c}`, esc(fmt.money(t.received, c)), `${esc(fmt.money(t.deferred, c))} deferred`)).join('')}${tot.filter(([, t]) => t.repayable).map(([c, t]) => kpi(`Repayable · ${c}`, esc(fmt.money(t.repayable, c)), 'clawed back, not repaid', 'crit')).join('')}</div>
    <div class="card section"><header><h3>Grants</h3></header><div data-gl></div></div>`;
  table($('[data-gl]', el), { columns: [
    { label: 'Grant', render: (g) => `<b>${esc(g.grantor)}</b> · ${esc(g.programme)}<div class="cell-sub">${esc(GR_KIND[g.kind])}${g.ratePerKwh ? ` · ${esc(fmt.money(g.ratePerKwh, g.currency))}/kWh` : ''}${g.releaseMonths ? ` · over ${g.releaseMonths} months` : ''}${g.site ? ` · ${esc(g.site)}` : ''}</div>` },
    { label: 'Awarded', num: true, render: (g) => esc(fmt.money(g.awarded, g.currency)) },
    { label: 'Received', num: true, render: (g) => `${esc(fmt.money(g.received, g.currency))}${g.kind === 'capital' ? `<div class="cell-sub">${esc(fmt.money(g.deferred, g.currency))} deferred</div>` : ''}` },
    { label: 'Next condition', render: (g) => (g.nextCondition ? `${esc(g.nextCondition.description)}<div class="cell-sub">${esc(g.nextCondition.dueOn)}</div>` : g.breached ? tag('t-crit', `${g.breached} breached`) : '') },
    { label: 'Status', render: (g) => tag(...GR_ST[g.status]) },
    { label: '', render: (g) => `<button ${BTN} data-gopen="${g.id}">Open</button>` },
  ], rows: d.grants, empty: 'No grants yet.' });
  $('[data-gx]', el).addEventListener('click', () => fetchFile('/v1/finance/grants?format=xlsx', 'plugsure-grants.xlsx'));
  const send = async (url, b, method = 'POST') => { try { const r = await api(url, { method, body: b }); toast('Saved.', 'ok'); reload(); return r; } catch (err) { toast(err.message, 'crit'); return false; } };
  const form = (g) => modal({ title: g ? `${g.grantor} · ${g.programme}` : 'Add a grant', size: 'lg', body: `<div class="form">${field('Grantor', `<input name="gr" value="${esc(g?.grantor ?? '')}" placeholder="Kementerian ESDM, PLN, a development bank…">`)}${field('Programme', `<input name="pg" value="${esc(g?.programme ?? '')}">`)}${field('Reference', `<input name="ref" value="${esc(g?.reference ?? '')}">`, { opt: true })}
      ${field('Kind', `<select name="k">${Object.entries(GR_KIND).map(([k, l]) => `<option value="${k}"${g?.kind === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}${field('Currency', `<input name="c" maxlength="3" value="${esc(g?.currency ?? LEGACY_CURRENCY)}">`)}${field('Awarded', `<input name="aw" type="number" min="0" value="${g?.awarded ?? ''}">`)}
      ${field('Release over (months, capital)', `<input name="rel" type="number" min="1" max="480" value="${g?.releaseMonths ?? ''}" placeholder="the assets' life (96)">`, { opt: true })}${field('Rate per kWh (per kWh)', `<input name="rate" type="number" step="0.01" min="0" value="${g?.ratePerKwh ?? ''}">`, { opt: true })}
      ${field('Awarded on', `<input name="on" type="date" value="${esc(g?.awardedOn ?? '')}">`, { opt: true })}${field('Period from', `<input name="pf" type="date" value="${esc(g?.periodFrom ?? '')}">`, { opt: true })}${field('Period to', `<input name="pt" type="date" value="${esc(g?.periodTo ?? '')}">`, { opt: true })}${field('Site', '<select name="site"><option value="">All sites</option></select>', { opt: true })}
      ${g ? field('Status', `<select name="st">${Object.keys(GR_ST).map((k) => `<option value="${k}"${g.status === k ? ' selected' : ''}>${GR_ST[k][1]}</option>`).join('')}</select>`) : ''}</div>`,
    async onMount(mc) { const ss = await sitesList(); $('[name="site"]', mc.el).innerHTML = `<option value="">All sites</option>${ss.map((x) => `<option value="${esc(x.id)}"${g?.siteId === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}`; },
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el)?.value.trim();
      return send(g ? `/v1/finance/grants/${g.id}` : '/v1/finance/grants', { grantor: v('gr'), programme: v('pg'), reference: v('ref') || null, kind: v('k'), currency: v('c'), awarded: Number(v('aw') || 0), releaseMonths: v('rel') || null, ratePerKwh: v('rate') || null, awardedOn: v('on') || null, periodFrom: v('pf') || null, periodTo: v('pt') || null, siteId: v('site') || null, ...(g ? { status: v('st') } : {}) }, g ? 'PUT' : 'POST');
    } }] });
  $('[data-gnew]', el)?.addEventListener('click', () => form(null));
  el.addEventListener('click', async (e) => {
    const o = e.target.closest('[data-gopen]');
    if (!o) return;
    let g;
    try { g = await api(`/v1/finance/grants/${o.dataset.gopen}`); } catch (err) { toast(err.message, 'crit'); return; }
    const m = (v) => fmt.money(v, g.currency);
    drawer({ title: `${g.grantor} · ${g.programme}`, subtitle: `${GR_KIND[g.kind]} · ${GR_ST[g.status][1]}`, tabs: [
      { id: 'sum', label: 'Grant', render(body) {
        body.innerHTML = `<div class="grid k4">${kpi('Awarded', esc(m(g.awarded)), `${esc(m(g.toClaim))} still to claim`)}${kpi('Received', esc(m(g.received)), `${esc(m(g.claimed))} claimed`)}${g.kind === 'capital' ? kpi('Deferred', esc(m(g.deferred)), `${esc(m(g.released))} released`) : kpi('Kind', esc(GR_KIND[g.kind]), g.ratePerKwh ? `${esc(m(g.ratePerKwh))}/kWh` : '')}${kpi('Clawed back', esc(m(g.clawedBack)), g.clawbacks.some((c) => !c.repaidOn) ? 'not yet repaid' : '', g.clawedBack ? 'crit' : '')}</div>
          <h4 style="margin:14px 0 6px">Claims</h4><div data-gc></div><h4 style="margin:14px 0 6px">Conditions</h4><div data-gd></div>${g.clawbacks.length ? '<h4 style="margin:14px 0 6px">Clawbacks</h4><div data-gb></div>' : ''}
          <div class="row" style="gap:6px;margin-top:10px;flex-wrap:wrap">${canWrite ? `<button ${BTN} data-gclaim>Claim…</button><button ${BTN} data-gcond>Condition…</button>${g.received ? `<button ${BTN} data-gclaw>Clawback…</button>` : ''}<button ${BTN} data-gedit>Edit</button>` : ''}</div>`;
        table($('[data-gc]', body), { columns: [{ label: 'Claim', render: (c) => `<b>${esc(c.number)}</b><div class="cell-sub">${esc([c.periodFrom, c.periodTo].filter(Boolean).join(' – '))}${c.kwh != null ? ` · ${fmt.num(c.kwh)} kWh` : ''}</div>` }, { label: 'Amount', num: true, render: (c) => `${esc(m(c.amount))}${c.paid != null && c.paid !== c.amount ? `<div class="cell-sub">${esc(m(c.paid))} paid</div>` : ''}` },
          { label: 'Status', render: (c) => `${tag(...GC_ST[c.status])}<div class="cell-sub">${esc(c.paidOn ?? c.approvedOn ?? c.submittedOn ?? '')}</div>` }, { label: '', render: (c) => (canWrite && GC_NEXT[c.status].length ? `<button ${BTN} data-gcu="${c.id}">Update…</button>` : '') }], rows: g.claims, empty: 'No claims.' });
        table($('[data-gd]', body), { columns: [{ label: 'Condition', render: (c) => `${esc(c.description)}${c.note ? `<div class="cell-sub">${esc(c.note)}</div>` : ''}` }, { label: 'Due', render: (c) => `${esc(c.dueOn ?? '')}${c.overdue ? ` ${tag('t-crit', 'overdue')}` : ''}` }, { label: 'Status', render: (c) => tag(...COND_ST[c.status]) }, { label: '', render: (c) => (canWrite ? `<button ${BTN} data-gcs="${c.id}">Set…</button>` : '') }], rows: g.conditions, empty: 'No conditions.' });
        if (g.clawbacks.length) table($('[data-gb]', body), { columns: [{ label: 'On', render: (c) => esc(c.onDate) }, { label: 'Amount', num: true, render: (c) => esc(m(c.amount)) }, { label: 'Why', render: (c) => esc(c.note) }, { label: '', render: (c) => (c.repaidOn ? tag('t-ok', `repaid ${c.repaidOn}`) : canWrite ? `<button ${BTN} data-gcr="${c.id}">Repaid…</button>` : tag('t-crit', 'owed')) }], rows: g.clawbacks });
        $('[data-gedit]', body)?.addEventListener('click', () => form(g));
        $('[data-gcond]', body)?.addEventListener('click', () => modal({ title: 'Add a condition', body: `<div class="form">${field('Condition', '<input name="d" placeholder="e.g. Four chargers live by…">')}${field('Due', '<input name="on" type="date">', { opt: true })}</div>`, actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', onClick: (mc) => send(`/v1/finance/grants/${g.id}/conditions`, { description: $('[name="d"]', mc.el).value.trim(), dueOn: $('[name="on"]', mc.el).value || undefined }) }] }));
        $('[data-gclaim]', body)?.addEventListener('click', () => modal({ title: 'Claim', subtitle: g.kind === 'per_kwh' ? 'The kWh charged in the period and the amount follow (or give them).' : `${m(g.toClaim)} left to claim`, body: `<div class="form">${field('From', '<input name="pf" type="date">', { opt: g.kind !== 'per_kwh' })}${field('To', '<input name="pt" type="date">', { opt: g.kind !== 'per_kwh' })}${field('Amount', '<input name="a" type="number" min="1">', { opt: g.kind === 'per_kwh' })}${field('Reference', '<input name="ref">', { opt: true })}${field('Submit now', '<select name="sub"><option value="1">Yes</option><option value="">Keep as draft</option></select>')}</div>`,
          actions: [{ label: 'Cancel' }, { label: 'Claim', kind: 'primary', onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value.trim(); return send(`/v1/finance/grants/${g.id}/claims`, { periodFrom: v('pf') || undefined, periodTo: v('pt') || undefined, amount: v('a') ? Number(v('a')) : undefined, reference: v('ref') || undefined, submit: !!v('sub') }); } }] }));
        $('[data-gclaw]', body)?.addEventListener('click', () => modal({ title: 'Record a clawback', body: `<div class="form">${field('Amount', `<input name="a" type="number" min="1" max="${g.received}">`)}${field('On', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Condition', `<select name="c"><option value="">—</option>${g.conditions.map((c) => `<option value="${c.id}">${esc(c.description)}</option>`).join('')}</select>`, { opt: true })}${field('Why', '<input name="n">')}</div>`,
          actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'danger', onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value.trim(); return send(`/v1/finance/grants/${g.id}/clawbacks`, { amount: Number(v('a')), onDate: v('on'), conditionId: v('c') || undefined, note: v('n') }); } }] }));
        body.addEventListener('click', (ev) => {
          const cu = ev.target.closest('[data-gcu]'), cs = ev.target.closest('[data-gcs]'), cr = ev.target.closest('[data-gcr]');
          if (cu) { const c = g.claims.find((x) => x.id === cu.dataset.gcu); modal({ title: `${c.number} · ${c.status}`, body: `<div class="form">${field('Move to', `<select name="s">${GC_NEXT[c.status].map((x) => `<option value="${x}">${x}</option>`).join('')}</select>`)}${field('On', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Received (when paid)', `<input name="p" type="number" min="0" value="${c.amount}">`, { opt: true })}</div>`,
            actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value.trim(); return send(`/v1/finance/grants/claims/${c.id}`, { status: v('s'), on: v('on'), paid: v('s') === 'paid' ? Number(v('p')) : undefined }); } }] }); }
          if (cs) modal({ title: 'Set the condition', body: `<div class="form">${field('Status', '<select name="s"><option value="met">Met</option><option value="breached">Breached</option><option value="waived">Waived</option><option value="pending">Pending</option></select>')}${field('Note', '<input name="n">', { opt: true })}</div>`,
            actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: (mc) => send(`/v1/finance/grants/conditions/${cs.dataset.gcs}`, { status: $('[name="s"]', mc.el).value, note: $('[name="n"]', mc.el).value.trim() || undefined }) }] });
          if (cr) modal({ title: 'Clawback repaid', body: `<div class="form one">${field('Repaid on', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}</div>`, actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: (mc) => send(`/v1/finance/grants/clawbacks/${cr.dataset.gcr}/repay`, { repaidOn: $('[name="on"]', mc.el).value }) }] });
        });
      } },
    ] });
  });
}

// ─────────────────────────────────────────── (v1.36.0) landlord deals

const LD_BASIS = { fixed: 'Fixed rent', share: 'Share', higher_of: 'Higher of share and minimum', fixed_plus_share: 'Fixed plus share' };
const LS_ST = { draft: ['t-mute', 'draft'], issued: ['t-ok', 'issued'], void: ['t-mute', 'void'] };

async function landlordsSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api('/v1/finance/landlords'); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => landlordsSection(host, canWrite);
  const tot = Object.entries(d.totals), due = d.deals.reduce((a, x) => a + x.unissued, 0);
  const terms = (x) => (x.basis === 'fixed' ? `${fmt.money(x.fixed, x.currency)} a month` : x.basis === 'share' ? `${x.sharePct}% of ${x.shareOf}` : x.basis === 'higher_of' ? `${x.sharePct}% of ${x.shareOf}, at least ${fmt.money(x.minimum, x.currency)}` : `${fmt.money(x.fixed, x.currency)} + ${x.sharePct}% of ${x.shareOf}`);
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px;flex-wrap:wrap">${canWrite ? `<button class="btn primary" type="button" data-lnew>${icon('plus')} Deal</button>` : ''}<button class="btn" type="button" data-lx>${icon('download')} Excel</button></div>
    ${callout('info', 'What each site pays its landlord: fixed rent, a share of revenue or margin, the higher of a share and a minimum guarantee, or both. Statements are drafted on the 2nd for periods that have ended; issued, they become the landlord\'s bill. Months not yet billed are accrued. (Site owners who share the platform\'s revenue are under Owners.)')}
    <div class="grid k4 section">${tot.map(([c, t]) => kpi(`Rent · ${d.month} · ${c}`, esc(fmt.money(t.lastMonth, c)), `${t.deals} active deal(s)`)).join('') || kpi('Rent', '—', 'no deals')}${kpi('Statements to issue', String(d.statements.filter((s) => s.status === 'draft').length), due ? `${due} period(s) not drafted` : 'all periods drafted', d.statements.some((s) => s.status === 'draft') ? 'warn' : '')}</div>
    <div class="card section"><header><h3>Deals</h3></header><div data-ll></div></div><div class="card section"><header><h3>Statements</h3></header><div data-ls></div></div>`;
  table($('[data-ll]', el), { columns: [
    { label: 'Site', render: (x) => `<b>${esc(x.site)}</b><div class="cell-sub">${esc(x.landlord)}${x.reference ? ` · ${esc(x.reference)}` : ''}</div>` },
    { label: 'Terms', render: (x) => `${esc(LD_BASIS[x.basis])}<div class="cell-sub">${esc(terms(x))}${x.escalationPct ? ` · +${x.escalationPct}%/yr` : ''}${x.rentFreeMonths ? ` · ${x.rentFreeMonths} mo free` : ''}${x.lease ? ' · fixed in a lease' : ''}</div>` },
    { label: d.month, num: true, render: (x) => (x.lastMonth ? `<b>${esc(fmt.money(x.lastMonth.total, x.currency))}</b>${x.lastMonth.topUp ? `<div class="cell-sub">${esc(fmt.money(x.lastMonth.topUp, x.currency))} top-up</div>` : x.lastMonth.rentFree ? '<div class="cell-sub">rent-free</div>' : ''}` : '') },
    { label: 'Status', render: (x) => `${tag(x.status === 'active' ? 't-ok' : 't-mute', x.status)}${x.unissued ? `<div class="cell-sub">${x.unissued} to draft</div>` : ''}` },
    { label: '', render: (x) => `<button ${BTN} data-lopen="${x.id}">Open</button>` },
  ], rows: d.deals, empty: 'No landlord deals yet.' });
  const site = (id) => d.deals.find((x) => x.id === id)?.site ?? '';
  table($('[data-ls]', el), { columns: [
    { label: 'Statement', render: (s) => `<b>${esc(s.number)}</b> · ${esc(site(s.dealId))}<div class="cell-sub">${esc(s.monthFrom)}${s.monthTo !== s.monthFrom ? ` – ${esc(s.monthTo)}` : ''}</div>` },
    { label: 'Total', num: true, render: (s) => esc(fmt.money(s.total, d.deals.find((x) => x.id === s.dealId)?.currency ?? LEGACY_CURRENCY)) },
    { label: 'Status', render: (s) => `${tag(...LS_ST[s.status])}${s.billStatus ? `<div class="cell-sub">bill ${esc(s.billStatus.replace('_', ' '))}</div>` : ''}` },
    { label: '', render: (s) => `<button ${BTN} data-lspdf="${s.id}" data-lsn="${esc(s.number)}">PDF</button>${canWrite && s.status === 'draft' ? ` <button class="btn sm primary" type="button" data-lsiss="${s.id}">Issue</button>` : ''}${canWrite && s.status !== 'void' ? ` <button ${BTN} data-lsvoid="${s.id}">Void</button>` : ''}` },
  ], rows: d.statements.slice(0, 60), empty: 'No statements yet.' });
  $('[data-lx]', el).addEventListener('click', () => fetchFile('/v1/finance/landlords?format=xlsx', 'plugsure-landlord-deals.xlsx'));
  const send = async (url, b, method = 'POST') => { try { const r = await api(url, { method, body: b }); toast('Saved.', 'ok'); reload(); return r; } catch (err) { toast(err.message, 'crit'); return false; } };
  const form = (x) => modal({ title: x ? `${x.site} · ${x.landlord}` : 'Add a landlord deal', size: 'lg', body: `<div class="form">${field('Site', '<select name="site"></select>')}${field('Landlord (a supplier)', '<select name="sup"></select>')}${field('Reference', `<input name="ref" value="${esc(x?.reference ?? '')}">`, { opt: true })}
      ${field('Basis', `<select name="b">${Object.entries(LD_BASIS).map(([k, l]) => `<option value="${k}"${x?.basis === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}${field('Currency', `<input name="c" maxlength="3" value="${esc(x?.currency ?? LEGACY_CURRENCY)}">`)}${field('Fixed rent a month', `<input name="f" type="number" min="0" value="${x?.fixed ?? 0}">`, { opt: true })}
      ${field('Share %', `<input name="sp" type="number" step="0.1" min="0" max="100" value="${x?.sharePct ?? 0}">`, { opt: true })}${field('Share of', `<select name="so"><option value="revenue">Revenue</option><option value="margin"${x?.shareOf === 'margin' ? ' selected' : ''}>Margin after energy</option></select>`)}${field('Minimum a month', `<input name="mn" type="number" min="0" value="${x?.minimum ?? 0}">`, { opt: true })}
      ${field('Escalation % a year', `<input name="es" type="number" step="0.1" min="0" max="50" value="${x?.escalationPct ?? 0}">`, { opt: true })}${field('Rent-free months', `<input name="rf" type="number" min="0" max="60" value="${x?.rentFreeMonths ?? 0}">`, { opt: true })}${field('Energy recharge per kWh', `<input name="rc" type="number" step="0.01" min="0" value="${x?.rechargePerKwh ?? 0}">`, { opt: true })}
      ${field('Billing', `<select name="bl"><option value="monthly">Monthly</option><option value="quarterly"${x?.billing === 'quarterly' ? ' selected' : ''}>Quarterly</option></select>`)}${field('Start', `<input name="s" type="date" value="${esc(x?.startOn ?? '')}">`)}${field('End', `<input name="e" type="date" value="${esc(x?.endOn ?? '')}">`, { opt: true })}
      ${x ? field('Status', `<select name="st"><option value="active">Active</option><option value="ended"${x.status === 'ended' ? ' selected' : ''}>Ended</option></select>`) : ''}</div>`,
    async onMount(mc) {
      const [ss, sups] = await Promise.all([sitesList(), api('/v1/finance/suppliers').then((r) => r.suppliers ?? r.items ?? r).catch(() => [])]);
      $('[name="site"]', mc.el).innerHTML = ss.map((s2) => `<option value="${esc(s2.id)}"${x?.siteId === s2.id ? ' selected' : ''}>${esc(s2.name)}</option>`).join('');
      $('[name="sup"]', mc.el).innerHTML = (Array.isArray(sups) ? sups : []).filter((s2) => !s2.archived).map((s2) => `<option value="${esc(s2.id)}"${x?.supplierId === String(s2.id) ? ' selected' : ''}>${esc(s2.name)}</option>`).join('') || '<option value="">Add the landlord under Bills → Suppliers first</option>';
    },
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el)?.value.trim();
      return send(x ? `/v1/finance/landlords/${x.id}` : '/v1/finance/landlords', { siteId: v('site'), supplierId: v('sup'), reference: v('ref') || null, basis: v('b'), currency: v('c'), fixed: Number(v('f') || 0), sharePct: Number(v('sp') || 0), shareOf: v('so'), minimum: Number(v('mn') || 0), escalationPct: Number(v('es') || 0), rentFreeMonths: Number(v('rf') || 0), rechargePerKwh: Number(v('rc') || 0), billing: v('bl'), startOn: v('s'), endOn: v('e') || null, ...(x ? { status: v('st') } : {}) }, x ? 'PUT' : 'POST');
    } }] });
  $('[data-lnew]', el)?.addEventListener('click', () => form(null));
  el.addEventListener('click', async (e) => {
    const o = e.target.closest('[data-lopen]'), pdf = e.target.closest('[data-lspdf]'), iss = e.target.closest('[data-lsiss]'), vd = e.target.closest('[data-lsvoid]');
    if (pdf) fetchFile(`/v1/finance/landlords/statements/${pdf.dataset.lspdf}?format=pdf`, `${pdf.dataset.lsn}.pdf`);
    if (iss) send(`/v1/finance/landlords/statements/${iss.dataset.lsiss}/issue`, {});
    if (vd) send(`/v1/finance/landlords/statements/${vd.dataset.lsvoid}/void`, {});
    if (!o) return;
    let x;
    try { x = await api(`/v1/finance/landlords/${o.dataset.lopen}`); } catch (err) { toast(err.message, 'crit'); return; }
    const m = (v) => (v == null ? '—' : fmt.money(v, x.currency));
    drawer({ title: `${x.site} · ${x.landlord}`, subtitle: `${LD_BASIS[x.basis]} · ${terms(x)}`, tabs: [{ id: 'm', label: 'Months', render(body) {
      body.innerHTML = `<div data-lm></div><div class="row" style="gap:6px;margin-top:10px;flex-wrap:wrap">${canWrite ? `${x.due.map((mm) => `<button ${BTN} data-ldraft="${mm}">Draft ${esc(mm)}</button>`).join('')}<button ${BTN} data-ledit>Edit</button>` : ''}</div>`;
      table($('[data-lm]', body), { columns: [{ label: 'Month', render: (l) => `${esc(l.month)}${l.rentFree ? ` ${tag('t-info', 'rent-free')}` : ''}` }, { label: 'Revenue', num: true, render: (l) => esc(m(l.revenue)) }, { label: 'Share', num: true, render: (l) => esc(m(l.share)) },
        { label: 'Fixed', num: true, render: (l) => (l.inLease ? '<span class="cell-sub">lease</span>' : esc(m(l.fixed))) }, { label: 'Top-up', num: true, render: (l) => esc(m(l.topUp)) }, { label: 'Recharge', num: true, render: (l) => esc(m(l.recharge)) }, { label: 'Due', num: true, render: (l) => `<b>${esc(m(l.total))}</b>` }], rows: x.months, empty: 'The deal has not started.' });
      body.querySelectorAll('[data-ldraft]').forEach((b2) => b2.addEventListener('click', () => send(`/v1/finance/landlords/${x.id}/statements`, { month: b2.dataset.ldraft })));
      $('[data-ledit]', body)?.addEventListener('click', () => form(x));
    } }] });
  });
}

// ─────────────────────────────────────────── (v1.36.0) chargebacks and fraud

const CB_ST = { open: ['t-warn', 'open'], evidence_submitted: ['t-info', 'evidence sent'], won: ['t-ok', 'won'], lost: ['t-crit', 'lost'], accepted: ['t-mute', 'accepted'] };
const CB_NEXT = { open: ['evidence_submitted', 'accepted', 'lost'], evidence_submitted: ['won', 'lost'], won: [], lost: [], accepted: [] };
const CB_REASON = { fraud: 'Fraud', not_received: 'Not received', not_as_described: 'Not as described', duplicate: 'Duplicate', amount: 'Amount', cancelled: 'Cancelled', other: 'Other' };

async function chargebacksSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d, f;
  try { [d, f] = await Promise.all([api('/v1/finance/chargebacks'), api('/v1/finance/chargebacks/fraud')]); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => chargebacksSection(host, canWrite);
  const tot = Object.entries(d.totals), over = f.rates.filter((r) => r.overThreshold);
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px;flex-wrap:wrap">${canWrite ? `<button class="btn primary" type="button" data-cbnew>${icon('plus')} Chargeback</button>` : ''}<button class="btn" type="button" data-cbx>${icon('download')} Excel</button></div>
    ${over.length ? callout('crit', `Chargebacks are at ${over.map((r) => `${r.ratePct}% of ${esc(r.method)} payments`).join(', ')} over 90 days: the card schemes act from about ${f.thresholdPct}%.`) : ''}
    <div class="grid k4 section">${tot.map(([c, t]) => kpi(`Open · ${c}`, esc(fmt.money(t.openAmount, c)), `${t.open} case(s)`, t.open ? 'warn' : '')).join('') || kpi('Open', '—', 'no chargebacks')}${tot.map(([c, t]) => kpi(`Lost · ${c}`, esc(fmt.money(t.lostAmount, c)), `${t.lost} lost or accepted · ${esc(fmt.money(t.fees, c))} fees`)).join('')}${kpi('Win rate', d.winRatePct == null ? '—' : `${d.winRatePct}%`, 'of cases decided')}</div>
    <div class="card section"><header><h3>Chargebacks</h3></header><div data-cbl></div></div>
    <div class="card section"><header><h3>Fraud signals</h3><span class="cell-sub">since ${esc(f.from)}</span></header><div style="padding:0 0 8px">${!f.repeat.length && !f.refundedAndChargedBack.length && !f.failedBursts.length ? '<p class="cell-sub" style="margin:10px 16px">No tokens with repeat chargebacks, no payments refunded and charged back, no bursts of failed payments.</p>' : ''}${f.repeat.length ? '<h4 style="margin:10px 16px 6px">Tokens with repeat chargebacks</h4><div data-cbr></div>' : ''}${f.refundedAndChargedBack.length ? '<h4 style="margin:14px 16px 6px">Refunded and also charged back</h4><div data-cbb></div>' : ''}${f.failedBursts.length ? '<h4 style="margin:14px 16px 6px">Failed-payment bursts (card testing)</h4><div data-cbf></div>' : ''}<h4 style="margin:14px 16px 6px">Rate by method</h4><div data-cbt></div></div></div>`;
  table($('[data-cbl]', el), { columns: [
    { label: 'Case', render: (c) => `<b>${esc(c.provider)} ${esc(c.caseRef)}</b><div class="cell-sub">${esc(CB_REASON[c.reason])}${c.reasonCode ? ` (${esc(c.reasonCode)})` : ''}${c.site ? ` · ${esc(c.site)}` : ''}${c.token ? ` · <span class="mono">${esc(c.token)}</span>` : ''}</div>` },
    { label: 'Amount', num: true, render: (c) => `${esc(fmt.money(c.amount, c.currency))}${c.alsoRefunded ? `<div>${tag('t-crit', 'also refunded')}</div>` : ''}` },
    { label: 'Respond by', render: (c) => `${esc(c.respondBy)}${c.status === 'open' ? `<div>${c.overdue ? tag('t-crit', 'passed') : tag(c.daysLeft <= 3 ? 't-warn' : 't-info', `${c.daysLeft} days`)}</div>` : ''}` },
    { label: 'Status', render: (c) => tag(...CB_ST[c.status]) },
    { label: '', render: (c) => `<button ${BTN} data-cbev="${c.id}" data-cbn="${esc(c.caseRef)}">Evidence</button>${canWrite && CB_NEXT[c.status].length ? ` <button ${BTN} data-cbu="${c.id}">Update…</button>` : ''}` },
  ], rows: d.chargebacks, empty: 'No chargebacks.' });
  if ($('[data-cbr]', el)) table($('[data-cbr]', el), { columns: [{ label: 'Token', render: (r) => `<span class="mono">${esc(r.token ?? '—')}</span>${r.driver ? `<div class="cell-sub">${esc(r.driver)}</div>` : ''}` }, { label: 'Chargebacks', num: true, render: (r) => String(r.chargebacks) }, { label: 'Amount', num: true, render: (r) => esc(fmt.money(r.amount, r.currency)) },
    { label: '', render: (r) => (r.tokenBlocked ? tag('t-mute', 'blocked') : canWrite && r.tokenId ? `<button class="btn sm danger" type="button" data-cbblk="${r.tokenId}">Block</button>` : '') }], rows: f.repeat, empty: 'None.' });
  if ($('[data-cbb]', el)) table($('[data-cbb]', el), { columns: [{ label: 'Case', render: (r) => `${esc(r.provider)} ${esc(r.caseRef)}<div class="cell-sub mono">${esc(r.paymentRef ?? '')}</div>` }, { label: 'Charged back', num: true, render: (r) => esc(fmt.money(r.amount, r.currency)) }, { label: 'Refunded', num: true, render: (r) => esc(fmt.money(r.refunded, r.currency)) }], rows: f.refundedAndChargedBack, empty: 'None.' });
  if ($('[data-cbf]', el)) table($('[data-cbf]', el), { columns: [{ label: 'Charger', render: (r) => `${esc(r.charger ?? '—')}<div class="cell-sub">${esc(r.site ?? '')}</div>` }, { label: 'Day', render: (r) => esc(r.day) }, { label: 'Failed', num: true, render: (r) => String(r.failed) }], rows: f.failedBursts, empty: 'None.' });
  table($('[data-cbt]', el), { columns: [{ label: 'Method', render: (r) => esc(r.method) }, { label: 'Payments', num: true, render: (r) => fmt.num(r.payments) }, { label: 'Chargebacks', num: true, render: (r) => String(r.chargebacks) }, { label: 'Rate', num: true, render: (r) => (r.ratePct == null ? '—' : r.overThreshold ? tag('t-crit', `${r.ratePct}%`) : `${r.ratePct}%`) }], rows: f.rates, empty: 'No payments.' });
  $('[data-cbx]', el).addEventListener('click', () => fetchFile('/v1/finance/chargebacks?format=xlsx', 'plugsure-chargebacks.xlsx'));
  const send = async (url, b) => { try { const r = await api(url, { method: 'POST', body: b }); toast('Saved.', 'ok'); reload(); return r; } catch (err) { toast(err.message, 'crit'); return false; } };
  $('[data-cbnew]', el)?.addEventListener('click', () => modal({ title: 'Record a chargeback', size: 'lg', body: `<div class="form">${field('Payment reference', '<input name="pr" placeholder="ps-… or the provider\'s payment id">', { opt: true })}${field('Provider', '<input name="pv" value="xendit">')}${field('Case number', '<input name="cr">')}
      ${field('Reason', `<select name="r">${Object.entries(CB_REASON).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>`)}${field('Reason code', '<input name="rc" placeholder="e.g. 10.4">', { opt: true })}${field('Amount (default: captured)', '<input name="a" type="number" min="1">', { opt: true })}${field('Currency', `<input name="c" maxlength="3" value="${esc(LEGACY_CURRENCY)}">`)}
      ${field('Fee', '<input name="fee" type="number" min="0" value="0">', { opt: true })}${field('Received on', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Respond by', '<input name="by" type="date">', { opt: true })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value.trim(); return send('/v1/finance/chargebacks', { paymentRef: v('pr') || undefined, provider: v('pv'), caseRef: v('cr'), reason: v('r'), reasonCode: v('rc') || undefined, amount: v('a') ? Number(v('a')) : undefined, currency: v('c'), fee: Number(v('fee') || 0), receivedOn: v('on'), respondBy: v('by') || undefined }); } }] }));
  el.addEventListener('click', (e) => {
    const ev = e.target.closest('[data-cbev]'), u = e.target.closest('[data-cbu]'), blk = e.target.closest('[data-cbblk]');
    if (ev) fetchFile(`/v1/finance/chargebacks/${ev.dataset.cbev}/evidence`, `chargeback-${ev.dataset.cbn}.pdf`);
    if (u) { const c = d.chargebacks.find((x) => x.id === u.dataset.cbu); modal({ title: `${c.provider} ${c.caseRef} · ${CB_ST[c.status][1]}`, body: `<div class="form">${field('Move to', `<select name="s">${CB_NEXT[c.status].map((x) => `<option value="${x}">${CB_ST[x][1]}</option>`).join('')}</select>`)}${field('On', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Note', '<input name="n">', { opt: true })}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: (mc) => send(`/v1/finance/chargebacks/${c.id}`, { status: $('[name="s"]', mc.el).value, on: $('[name="on"]', mc.el).value, note: $('[name="n"]', mc.el).value.trim() || undefined }) }] }); }
    if (blk) modal({ title: 'Block the token', subtitle: 'The driver can no longer start charging with it.', body: `<div class="form one">${field('Why', '<input name="n" value="Repeat chargebacks">')}</div>`, actions: [{ label: 'Cancel' }, { label: 'Block', kind: 'danger', onClick: (mc) => send(`/v1/finance/chargebacks/tokens/${blk.dataset.cbblk}/block`, { reason: $('[name="n"]', mc.el).value.trim() }) }] });
  });
}

// ─────────────────────────────────────────── (v1.37.0) loyalty and promotion costs

async function loyaltyCostSection(host, canWrite, months = 6) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api(`/v1/finance/loyalty?months=${months}`); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = (n = months) => loyaltyCostSection(host, canWrite, n);
  const last = (cur) => d.liability.filter((l) => l.currency === cur).at(-1);
  const curs = [...new Set(d.liability.map((l) => l.currency))];
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Months', `<select data-lcm>${[3, 6, 12].map((n) => `<option value="${n}"${n === months ? ' selected' : ''}>Last ${n} whole months</option>`).join('')}</select>`)}<div class="row" style="align-self:flex-end;gap:6px">${canWrite ? '<button class="btn" type="button" data-lcset>Breakage…</button>' : ''}<button class="btn" type="button" data-lcx>${icon('download')} Excel</button></div></div>
    ${callout('info', `Points not yet used are revenue deferred (PSAK 72): points × what a point is worth (${esc(String(d.program.pointValue))}), less the share that will never be used (breakage, ${d.settings.breakagePct == null ? 'learned from expired against redeemed points' : `set at ${d.settings.breakagePct}%`}). The ledger books the month's change. ${d.program.enabled ? '' : 'Loyalty is switched off (Commercial → Promotions & plans).'}`)}
    <div class="grid k4 section">${curs.map((c) => { const l = last(c); return kpi(`Points liability · ${c}`, esc(fmt.money(l.net, c)), `${fmt.num(l.points)} points · ${l.breakagePct}% breakage`); }).join('') || kpi('Points liability', '—', 'no points yet')}${Object.entries(d.totals).map(([c, t]) => kpi(`Promotion cost · ${c}`, esc(fmt.money(t.cost, c)), `${esc(fmt.money(t.discount, c))} discounts · ${esc(fmt.money(t.pointsRedeemed, c))} points`)).join('')}</div>
    <div class="card section"><header><h3>Liability by month</h3></header><div data-lcl></div></div>
    <div class="grid k2 section"><div class="card"><header><h3>Promotions</h3></header><div data-lcp></div></div><div class="card"><header><h3>Cost by site</h3></header><div data-lcs></div></div></div>`;
  table($('[data-lcl]', el), { columns: [{ label: 'Month', render: (l) => `${esc(l.month)} <span class="cell-sub">${esc(l.currency)}</span>` }, { label: 'Points', num: true, render: (l) => fmt.num(l.points) }, { label: 'Earned', num: true, render: (l) => fmt.num(l.earned) }, { label: 'Redeemed', num: true, render: (l) => fmt.num(l.redeemed) }, { label: 'Expired', num: true, render: (l) => fmt.num(l.expired) },
    { label: 'Breakage', num: true, render: (l) => `${l.breakagePct}%` }, { label: 'Liability', num: true, render: (l) => `<b>${esc(fmt.money(l.net, l.currency))}</b>` }, { label: 'Change', num: true, render: (l) => esc(fmt.money(l.change, l.currency)) }], rows: d.liability, empty: 'No points earned.' });
  table($('[data-lcp]', el), { columns: [{ label: 'Promotion', render: (p) => `<b>${esc(p.name)}</b><div class="cell-sub">${p.redemptions} uses · ${p.customers} customers</div>` }, { label: 'Discount', num: true, render: (p) => `${esc(fmt.money(p.discount, p.currency))}${p.discountPct != null ? `<div class="cell-sub">${p.discountPct}% of the price</div>` : ''}` }, { label: 'Revenue', num: true, render: (p) => esc(fmt.money(p.revenue, p.currency)) }], rows: d.promotions, empty: 'No promotions used.' });
  table($('[data-lcs]', el), { columns: [{ label: 'Site', render: (s) => esc(s.site ?? '') }, { label: 'Discounts', num: true, render: (s) => esc(fmt.money(s.discount, s.currency)) }, { label: 'Points', num: true, render: (s) => esc(fmt.money(s.pointsRedeemed, s.currency)) }, { label: 'Cost', num: true, render: (s) => `<b>${esc(fmt.money(s.cost, s.currency))}</b>${s.costPct != null ? `<div class="cell-sub">${s.costPct}% of revenue</div>` : ''}` }], rows: d.sites, empty: 'Nothing given away.' });
  $('[data-lcm]', el).addEventListener('change', (e) => reload(Number(e.target.value)));
  $('[data-lcx]', el).addEventListener('click', () => fetchFile(`/v1/finance/loyalty?months=${months}&format=xlsx`, 'plugsure-loyalty-costs.xlsx'));
  $('[data-lcset]', el)?.addEventListener('click', () => modal({ title: 'Breakage', body: `<div class="form one">${field('Breakage % (empty: learn it)', `<input name="b" type="number" min="0" max="90" step="0.1" value="${d.settings.breakagePct ?? ''}" placeholder="learned: ${d.liability.at(-1)?.learnedPct ?? 0}%">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) { try { await api('/v1/finance/loyalty/settings', { method: 'PUT', body: { breakagePct: $('[name="b"]', mc.el).value } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] }));
}

// ─────────────────────────────────────────── (v1.37.0) tax audit readiness

const TA_KIND = { sp2dk: 'SP2DK', office_audit: 'Office audit', field_audit: 'Field audit', other: 'Other' };
const TA_ST = { open: ['t-warn', 'open'], responded: ['t-info', 'responded'], closed_no_change: ['t-ok', 'closed, no change'], assessed: ['t-crit', 'assessed'], objected: ['t-warn', 'objected'], paid: ['t-mute', 'paid'] };
const TA_NEXT = { open: ['responded', 'closed_no_change', 'assessed'], responded: ['closed_no_change', 'assessed'], assessed: ['objected', 'paid'], objected: ['paid', 'closed_no_change'], closed_no_change: [], paid: [] };
const GAP_L = { not_filed: 'Not filed', filed_differs: 'Filed ≠ today', revenue_vs_dpp: 'Revenue ≠ DPP', input_vat: 'Input PPN', no_slip: 'No bukti potong', no_efaktur: 'No e-Faktur' };

async function taxAuditSection(host, canWrite, year = new Date().getFullYear()) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api(`/v1/finance/tax-audit?year=${year}`); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = (y = year) => taxAuditSection(host, canWrite, y);
  const rp = (v) => fmt.money(v, LEGACY_CURRENCY);
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Year', `<select data-tay>${[0, 1, 2, 3].map((k) => new Date().getFullYear() - k).map((y) => `<option${y === year ? ' selected' : ''}>${y}</option>`).join('')}</select>`)}<div class="row" style="align-self:flex-end;gap:6px">${canWrite ? `<button class="btn primary" type="button" data-tanew>${icon('plus')} Tax office letter</button>` : ''}<button class="btn" type="button" data-tax>${icon('download')} Excel</button><button class="btn" type="button" data-tapack>${icon('download')} Audit pack (ZIP)</button></div></div>
    ${callout('info', 'Ready when the tax office asks: each month the PPN return as filed against today\'s figures, charging revenue against PPN output, input PPN on bills against faktur masukan, PPh withheld against bukti potong. Each open item is listed with its reference.')}
    <div class="grid k4 section">${kpi('Readiness', d.readinessPct == null ? '—' : `${d.readinessPct}%`, `${d.months.length} month(s) ended`, d.readinessPct === 100 ? 'ok' : d.readinessPct != null && d.readinessPct < 75 ? 'warn' : '')}${kpi('Open items', String(d.gaps.length), Object.entries(d.counts).map(([k, n]) => `${n} ${GAP_L[k] ?? k}`).join(' · ') || 'none', d.gaps.length ? 'warn' : '')}${kpi('Output PPN', esc(rp(d.totals.outputPpn)), `input ${esc(rp(d.totals.inputPpn))}`)}${kpi('PPh withheld', esc(rp(d.totals.withheld)), `${esc(rp(d.totals.slips))} on slips`, d.totals.withheld > d.totals.slips ? 'warn' : '')}</div>
    <div class="card section"><header><h3>Tax office letters</h3></header><div data-tac></div></div>
    <div class="card section"><header><h3>Equalisation · ${year}</h3></header><div data-tae></div></div>
    <div class="card section"><header><h3>Open items</h3></header><div data-tag></div></div>`;
  table($('[data-tac]', el), { columns: [{ label: 'Letter', render: (c) => `<b>${esc(TA_KIND[c.kind])}</b> ${esc(c.letterNo)}<div class="cell-sub">${c.taxYear} · ${esc(c.taxes.join(', ').toUpperCase())}</div>` }, { label: 'Received', render: (c) => esc(c.receivedOn) },
    { label: 'Respond by', render: (c) => `${esc(c.respondBy ?? '—')}${c.status === 'open' && c.daysLeft != null ? `<div>${c.overdue ? tag('t-crit', 'passed') : tag(c.daysLeft <= 7 ? 't-warn' : 't-info', `${c.daysLeft} days`)}</div>` : ''}` },
    { label: 'Status', render: (c) => `${tag(...TA_ST[c.status])}${c.assessed != null ? `<div class="cell-sub">${esc(rp(c.assessed))}</div>` : ''}` }, { label: '', render: (c) => (canWrite && TA_NEXT[c.status].length ? `<button ${BTN} data-tau="${c.id}">Update…</button>` : '') }], rows: d.cases, empty: 'No letters from the tax office.' });
  table($('[data-tae]', el), { columns: [{ label: 'Month', render: (m) => esc(m.month) }, { label: 'Revenue', num: true, render: (m) => esc(rp(m.revenue)) }, { label: 'Retail DPP', num: true, render: (m) => `${esc(rp(m.retailDpp))}${m.otherDpp ? `<div class="cell-sub">+${esc(rp(m.otherDpp))} other</div>` : ''}` },
    { label: 'PPN out / in', num: true, render: (m) => `${esc(rp(m.outputPpn))}<div class="cell-sub">${esc(rp(m.inputPpn))} in</div>` }, { label: 'Filed', render: (m) => (m.filed ? (m.filedDiffers ? tag('t-crit', 'differs') : tag('t-ok', 'filed')) : tag('t-mute', 'not filed')) },
    { label: 'PPh', num: true, render: (m) => `${esc(rp(m.withheld))}<div class="cell-sub">${esc(rp(m.slips))} on slips</div>` }, { label: 'Issues', num: true, render: (m) => (m.issues ? tag('t-warn', String(m.issues)) : '') }], rows: d.months, empty: 'No month of the year has ended.' });
  table($('[data-tag]', el), { columns: [{ label: 'Month', render: (g) => esc(g.month) }, { label: 'Item', render: (g) => `<b>${esc(GAP_L[g.kind] ?? g.kind)}</b> · ${esc(g.reference)}<div class="cell-sub">${esc(g.detail)}</div>` }, { label: 'Amount', num: true, render: (g) => (g.amount == null ? '' : esc(rp(g.amount))) }], rows: d.gaps, empty: 'Nothing open.' });
  $('[data-tay]', el).addEventListener('change', (e) => reload(Number(e.target.value)));
  $('[data-tax]', el).addEventListener('click', () => fetchFile(`/v1/finance/tax-audit?year=${year}&format=xlsx`, `plugsure-tax-equalisation-${year}.xlsx`));
  $('[data-tapack]', el).addEventListener('click', () => fetchFile(`/v1/finance/tax-audit/pack?year=${year}`, `plugsure-tax-audit-${year}.zip`));
  const send = async (url, b, method) => { try { await api(url, { method, body: b }); toast('Saved.', 'ok'); reload(); return true; } catch (err) { toast(err.message, 'crit'); return false; } };
  $('[data-tanew]', el)?.addEventListener('click', () => modal({ title: 'Record a tax office letter', body: `<div class="form">${field('Kind', `<select name="k">${Object.entries(TA_KIND).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>`)}${field('Letter number', '<input name="n">')}${field('Tax year', `<input name="y" type="number" value="${year - 1}">`)}${field('Taxes', '<input name="t" placeholder="ppn, pph23">')}${field('Received on', `<input name="r" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Respond by (SP2DK: 14 days)', '<input name="b" type="date">', { opt: true })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value.trim(); return send('/v1/finance/tax-audit/cases', { kind: v('k'), letterNo: v('n'), taxYear: Number(v('y')), taxes: v('t'), receivedOn: v('r'), respondBy: v('b') || undefined }, 'POST'); } }] }));
  el.addEventListener('click', (e) => {
    const u = e.target.closest('[data-tau]');
    if (!u) return;
    const c = d.cases.find((x) => x.id === u.dataset.tau);
    modal({ title: `${TA_KIND[c.kind]} ${c.letterNo}`, body: `<div class="form">${field('Move to', `<select name="s">${TA_NEXT[c.status].map((x) => `<option value="${x}">${TA_ST[x][1]}</option>`).join('')}</select>`)}${field('Amount assessed (SKP)', `<input name="a" type="number" min="0" value="${c.assessed ?? ''}">`, { opt: true })}${field('On', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Note', '<input name="n">', { opt: true })}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value.trim(); return send(`/v1/finance/tax-audit/cases/${c.id}`, { status: v('s'), assessed: v('a') || undefined, on: v('on'), note: v('n') || undefined }, 'PUT'); } }] });
  });
}

// ─────────────────────────────────────────── (v1.37.0) site portfolio review

const SIG = { close_review: ['t-crit', 'review for closure'], fix: ['t-warn', 'fix'], grow: ['t-ok', 'grow'], keep: ['t-info', 'keep'] };

async function portfolioSection(host, canWrite, months = 6) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api(`/v1/finance/portfolio?months=${months}`); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = (n = months) => portfolioSection(host, canWrite, n);
  const m = (v, c) => esc(fmt.money(v, c));
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Months', `<select data-pfm>${[3, 6, 12].map((n) => `<option value="${n}"${n === months ? ' selected' : ''}>Last ${n} whole months</option>`).join('')}</select>`)}<div class="row" style="align-self:flex-end;gap:6px"><button class="btn" type="button" data-pfx>${icon('download')} Excel</button><button class="btn" type="button" data-pfp>${icon('download')} Review (PDF)</button></div></div>
    ${callout('info', `Each site's full result, ${esc(d.months[0])} to ${esc(d.months.at(-1))}: revenue less energy, shared costs, rent (Landlords), maintenance (work orders) and insurance gives the operating result; less depreciation, plus grants released, the contribution.`)}
    <div class="grid k4 section">${Object.entries(d.totals).map(([c, t]) => kpi(`Contribution · ${c}`, m(t.contribution, c), `operating ${m(t.operating, c)} · ${t.sites} sites`, t.contribution < 0 ? 'crit' : '')).join('') || kpi('Contribution', '—', 'no sites with activity')}${Object.entries(d.totals).map(([c, t]) => kpi('Signals', `${t.signals.close_review ?? 0} / ${t.signals.fix ?? 0}`, `to review / to fix · ${t.signals.grow ?? 0} to grow`, t.signals.close_review ? 'warn' : '')).join('')}</div>
    <div class="card section"><header><h3>Sites</h3></header><div data-pfl></div></div>`;
  table($('[data-pfl]', el), { columns: [
    { label: '#', num: true, render: (s) => String(s.rank) },
    { label: 'Site', render: (s) => `<b>${esc(s.site)}</b><div class="cell-sub">${fmt.num(Math.round(s.kwh))} kWh · ${s.sessions} sessions</div>` },
    { label: 'Revenue', num: true, render: (s) => m(s.revenue, s.currency) },
    { label: 'Costs', num: true, render: (s) => `${m(s.energyCost + s.shared + s.rent + s.maintenance + s.insurance, s.currency)}<div class="cell-sub">energy ${m(s.energyCost, s.currency)} · rent ${m(s.rent, s.currency)}</div>` },
    { label: 'Operating', num: true, render: (s) => m(s.operating, s.currency) },
    { label: 'Contribution', num: true, render: (s) => `<b>${m(s.contribution, s.currency)}</b>${s.marginPct != null ? `<div class="cell-sub">${s.marginPct}%</div>` : ''}` },
    { label: 'Signal', render: (s) => `${tag(...SIG[s.signal])}${s.reasons.length ? `<div class="cell-sub">${esc(s.reasons.join('; '))}</div>` : ''}` },
  ], rows: d.sites, empty: 'No site had activity in the period.' });
  $('[data-pfm]', el).addEventListener('change', (e) => reload(Number(e.target.value)));
  $('[data-pfx]', el).addEventListener('click', () => fetchFile(`/v1/finance/portfolio?months=${months}&format=xlsx`, 'plugsure-site-portfolio.xlsx'));
  $('[data-pfp]', el).addEventListener('click', () => fetchFile(`/v1/finance/portfolio?months=${months}&format=pdf`, 'plugsure-portfolio-review.pdf'));
}

// ─────────────────────────────────────────── (v1.37.0) budget planning

const BP_ST = { draft: ['t-mute', 'draft'], submitted: ['t-warn', 'submitted'], approved: ['t-ok', 'approved'], rejected: ['t-crit', 'rejected'], superseded: ['t-mute', 'superseded'] };
const BP_CAT = { revenue: 'Revenue', energy_cost: 'Energy cost', rent: 'Rent', maintenance: 'Maintenance', insurance: 'Insurance', staff: 'Staff', marketing: 'Marketing', it: 'IT', other_opex: 'Other opex', capex: 'Capex' };

async function planningSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api('/v1/finance/budget-plans'); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => planningSection(host, canWrite);
  const canApprove = state.can('finance:approve');
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-bpnew>${icon('plus')} New budget version</button>` : ''}</div>
    ${callout('info', 'Next year\'s budget, built before it is used: seeded from the rolling forecast and each site\'s last twelve months, edited per site and department, submitted, and approved by a second Finance Manager. Approval publishes each site\'s revenue and energy cost to Budgets.')}
    <div class="card section"><header><h3>Budget versions</h3></header><div data-bpl></div></div>`;
  table($('[data-bpl]', el), { columns: [
    { label: 'Budget', render: (p) => `<b>${esc(p.name)}</b> <span class="cell-sub">${p.year} · v${p.version} · ${esc(p.currency)}</span><div class="cell-sub">${esc(p.seededFrom ?? '')}</div>` },
    { label: 'Revenue', num: true, render: (p) => esc(fmt.money(p.revenue, p.currency)) },
    { label: 'Costs', num: true, render: (p) => `${esc(fmt.money(p.costs, p.currency))}${p.capex ? `<div class="cell-sub">capex ${esc(fmt.money(p.capex, p.currency))}</div>` : ''}` },
    { label: 'Status', render: (p) => `${tag(...BP_ST[p.status])}<div class="cell-sub">${esc([p.submittedBy && `by ${p.submittedBy}`, p.decidedBy && `decided by ${p.decidedBy}`].filter(Boolean).join(' · '))}</div>` },
    { label: '', render: (p) => `<button ${BTN} data-bpo="${p.id}">Open</button>` },
  ], rows: d.plans, empty: 'No budget versions yet.' });
  $('[data-bpnew]', el)?.addEventListener('click', () => modal({ title: 'New budget version', body: `<div class="form">${field('Year', `<input name="y" type="number" value="${new Date().getFullYear() + 1}">`)}${field('Currency', `<input name="c" maxlength="3" value="${esc(LEGACY_CURRENCY)}">`)}${field('Start from', `<select name="s"><option value="forecast">The rolling forecast</option>${d.plans.length ? `<option value="copy">A copy of a version</option>` : ''}<option value="empty">Empty</option></select>`)}${field('Version to copy', `<select name="f">${d.plans.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>`, { opt: true })}${field('Growth % a year', '<input name="g" type="number" step="0.5" value="0">', { opt: true })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Create', kind: 'primary', async onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el)?.value.trim(); try { const p = await api('/v1/finance/budget-plans', { method: 'POST', body: { year: Number(v('y')), currency: v('c'), seed: v('s'), fromPlanId: v('s') === 'copy' ? v('f') : undefined, growthPct: Number(v('g') || 0) } }); reload(); open(p.id); } catch (err) { toast(err.message, 'crit'); return false; } } }] }));
  const open = async (id) => {
    let p;
    try { p = await api(`/v1/finance/budget-plans/${id}`); } catch (err) { toast(err.message, 'crit'); return; }
    const mm = (v) => fmt.money(v, p.currency);
    const act = async (fn, msg) => { try { const r = await fn(); toast(typeof msg === 'function' ? msg(r) : msg, 'ok'); reload(); return true; } catch (err) { toast(err.message, 'crit'); return false; } };
    drawer({ title: p.name, subtitle: `${p.year} · v${p.version} · ${BP_ST[p.status][1]}`, tabs: [
      { id: 's', label: 'Summary', render(body) {
        body.innerHTML = `<div class="grid k4">${kpi('Revenue', esc(mm(p.totals.revenue)), p.previous ? `v${p.previous.version}: ${esc(mm(p.previous.revenue))}` : '')}${kpi('Opex', esc(mm(p.totals.opex)), '')}${kpi('Result', esc(mm(p.totals.result)), '', p.totals.result < 0 ? 'crit' : '')}${kpi('Capex', esc(mm(p.totals.capex)), '')}</div>
          <h4 style="margin:14px 0 6px">By category</h4><div data-bpc></div><h4 style="margin:14px 0 6px">Sites</h4><div data-bps></div>
          <div class="row" style="gap:6px;margin-top:10px;flex-wrap:wrap">${canWrite && p.status === 'draft' ? `<button ${BTN} data-bpdept>Department lines…</button><button class="btn sm primary" type="button" data-bpsub>Submit for approval</button>` : ''}${canWrite && canApprove && p.status === 'submitted' ? `<button class="btn sm primary" type="button" data-bpok>Approve and publish</button><button ${BTN} data-bpno>Reject…</button>` : ''}<button ${BTN} data-bpx>${icon('download')} Excel</button></div>`;
        table($('[data-bpc]', body), { columns: [{ label: 'Category', render: (c) => esc(BP_CAT[c]) }, { label: 'Q1', num: true, render: (c) => esc(mm(p.byCategory[c].slice(0, 3).reduce((a, x) => a + x, 0))) }, { label: 'Q2', num: true, render: (c) => esc(mm(p.byCategory[c].slice(3, 6).reduce((a, x) => a + x, 0))) },
          { label: 'Q3', num: true, render: (c) => esc(mm(p.byCategory[c].slice(6, 9).reduce((a, x) => a + x, 0))) }, { label: 'Q4', num: true, render: (c) => esc(mm(p.byCategory[c].slice(9).reduce((a, x) => a + x, 0))) }, { label: 'Year', num: true, render: (c) => `<b>${esc(mm(p.byCategory[c].reduce((a, x) => a + x, 0)))}</b>` }],
          rows: Object.keys(BP_CAT).filter((c) => p.byCategory[c].some((x) => x)) });
        table($('[data-bps]', body), { columns: [{ label: 'Site', render: (s) => esc(s.site) }, { label: 'Revenue', num: true, render: (s) => esc(mm(s.revenue)) }, { label: 'Costs', num: true, render: (s) => esc(mm(s.energy_cost + s.rent + s.maintenance + s.insurance)) }, { label: 'Contribution', num: true, render: (s) => `<b>${esc(mm(s.contribution))}</b>` }], rows: p.sites, empty: 'No site lines.' });
        $('[data-bpx]', body).addEventListener('click', () => fetchFile(`/v1/finance/budget-plans/${p.id}?format=xlsx`, `plugsure-budget-${p.year}-v${p.version}.xlsx`));
        $('[data-bpsub]', body)?.addEventListener('click', () => act(() => api(`/v1/finance/budget-plans/${p.id}/submit`, { method: 'POST', body: {} }), 'Submitted for approval.'));
        $('[data-bpok]', body)?.addEventListener('click', () => act(() => api(`/v1/finance/budget-plans/${p.id}/decide`, { method: 'POST', body: { approve: true } }), (r) => `Approved: ${r.published} site-month(s) published to Budgets${r.skipped.length ? `; locked months left as they were: ${r.skipped.join(', ')}` : ''}.`));
        $('[data-bpno]', body)?.addEventListener('click', () => modal({ title: 'Reject the budget', body: `<div class="form one">${field('Why', '<input name="n">')}</div>`, actions: [{ label: 'Cancel' }, { label: 'Reject', kind: 'danger', onClick: (mc) => act(() => api(`/v1/finance/budget-plans/${p.id}/decide`, { method: 'POST', body: { approve: false, note: $('[name="n"]', mc.el).value.trim() } }), 'Rejected.') }] }));
        $('[data-bpdept]', body)?.addEventListener('click', () => modal({ title: 'Department lines (a month each)', size: 'lg', body: `<div class="form">${['staff', 'marketing', 'it', 'other_opex', 'capex'].map((c) => field(`${BP_CAT[c]} a month`, `<input name="${c}" type="number" min="0" value="${p.organisation[c][0] || ''}">`, { opt: true })).join('')}</div><p class="cell-sub">Applied to every month of ${p.year}; Excel holds month by month.</p>`,
          actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick(mc) { const lines = []; for (const c of ['staff', 'marketing', 'it', 'other_opex', 'capex']) { const v = $(`[name="${c}"]`, mc.el).value; if (v !== '') for (const mo of p.months) lines.push({ month: mo, category: c, amount: Number(v) }); } return lines.length ? act(() => api(`/v1/finance/budget-plans/${p.id}/lines`, { method: 'PUT', body: { lines } }), 'Saved.') : false; } }] }));
      } },
    ] });
  };
  el.addEventListener('click', (e) => { const o = e.target.closest('[data-bpo]'); if (o) open(o.dataset.bpo); });
}

// ─────────────────────────────────────────── (v1.38.0) FX treasury and hedging

const HG_ST = { open: ['t-info', 'open'], settled: ['t-ok', 'settled'], cancelled: ['t-mute', 'cancelled'] };
// Treasury holds currencies the platform does not charge in (USD, EUR…): two decimals unless the platform knows better.
const fxExp = (c) => CURRENCIES[c]?.exponent ?? (['JPY', 'KRW', 'VND'].includes(c) ? 0 : 2);
const fxMoney = (v, c) => (CURRENCIES[c] ? fmt.money(v, c) : `${c} ${(v / 10 ** fxExp(c)).toLocaleString('en-US', { minimumFractionDigits: fxExp(c), maximumFractionDigits: fxExp(c) })}`);

async function fxTreasurySection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let ex, hs, accts;
  try { [ex, hs, accts] = await Promise.all([api('/v1/finance/fx-exposure'), api('/v1/finance/fx-hedges'), api('/v1/finance/cash/accounts').catch(() => ({ accounts: [] }))]); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => fxTreasurySection(host, canWrite);
  const rep = ex.reportingCurrency;
  const m = (v, c) => (v == null ? '—' : esc(fxMoney(v, c)));
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-hgnew>${icon('plus')} Record a hedge</button>` : ''}<button class="btn" type="button" data-fxx>${icon('download')} Excel</button></div>
    ${rep ? callout('info', `What moves when rates move, at ${esc(ex.date)}: per currency, cash and receivables less payables and loans, and the open hedges. In ${esc(rep)} at ${esc(ex.month)}'s rate, the change since ${esc(ex.previousMonth)}'s rate, and the effect of a ${ex.sensitivityPct}% move.${ex.missingRates.length ? ` No rate for ${esc(ex.missingRates.join(', '))} this month (Settings → Currencies).` : ''}`)
      : callout('warn', 'Set a reporting currency and the month\'s rates (Finance → Settings → Currencies) to value the exposure.')}
    <div class="grid k3 section">${ex.total ? `${kpi(`Net exposure · ${esc(rep)}`, m(ex.total.net, rep), `${ex.currencies.length} currenc${ex.currencies.length === 1 ? 'y' : 'ies'}`)}${kpi('Revaluation', m(ex.total.revaluation, rep), `since ${esc(ex.previousMonth)}`, ex.total.revaluation < 0 ? 'warn' : '')}${kpi(`${ex.sensitivityPct}% move`, m(ex.total.sensitivity, rep), 'gain or loss either way')}` : kpi('Net exposure', '—', 'no reporting currency')}</div>
    <div class="card section"><header><h3>Exposure by currency</h3></header><div data-fxe></div></div>
    <div class="card section"><header><h3>Hedges</h3></header><div data-fxh></div></div>`;
  table($('[data-fxe]', el), { columns: [
    { label: 'Currency', render: (c) => `<b>${esc(c.currency)}</b>${c.rate != null ? `<div class="cell-sub">rate ${c.rate}${c.previousRate != null ? ` (was ${c.previousRate})` : ''}</div>` : `<div class="cell-sub">${tag('t-warn', 'no rate')}</div>`}` },
    { label: 'Cash + receivables', num: true, render: (c) => `${m(c.cash + c.receivables, c.currency)}<div class="cell-sub">cash ${m(c.cash, c.currency)}</div>` },
    { label: 'Payables + loans', num: true, render: (c) => `${m(c.payables + c.loans, c.currency)}<div class="cell-sub">loans ${m(c.loans, c.currency)}</div>` },
    { label: 'Hedges', num: true, render: (c) => `${m(c.hedges, c.currency)}<div class="cell-sub">${c.hedgedPct}% hedged</div>` },
    { label: 'Net', num: true, render: (c) => `<b>${m(c.net, c.currency)}</b>${c.netReporting != null ? `<div class="cell-sub">${m(c.netReporting, rep)}</div>` : ''}` },
    { label: 'Revaluation', num: true, render: (c) => m(c.revaluation, rep) },
  ], rows: ex.currencies, empty: 'Everything is in the reporting currency: no FX exposure.' });
  table($('[data-fxh]', el), { columns: [
    { label: 'Hedge', render: (h) => `<b>${esc(h.bank)}</b> <span class="cell-sub mono">${esc(h.reference ?? '')}</span><div class="cell-sub">${esc(h.purpose ?? '')}</div>` },
    { label: 'Buys', num: true, render: (h) => `${m(h.notional, h.buyCurrency)}<div class="cell-sub">sells ${m(h.sellAmount, h.sellCurrency)} at ${h.rate}</div>` },
    { label: 'Maturity', render: (h) => `${esc(h.maturityOn)}${h.daysToMaturity != null ? `<div class="cell-sub">${h.daysToMaturity < 0 ? `${-h.daysToMaturity} days past` : `in ${h.daysToMaturity} days`}</div>` : ''}` },
    { label: 'Result', num: true, render: (h) => (h.status === 'open' ? (h.markToMarket != null ? `${m(h.markToMarket, h.sellCurrency)}<div class="cell-sub">marked at ${Number(h.marketRate.toFixed(4)).toLocaleString('en-US')}</div>` : '<span class="cell-sub">no rate</span>') : h.realised != null ? `${m(h.realised, h.sellCurrency)}<div class="cell-sub">realised at ${h.settledRate} on ${esc(h.settledOn)}</div>` : '—') },
    { label: 'Status', render: (h) => tag(...HG_ST[h.status]) },
    { label: '', render: (h) => (canWrite && h.status === 'open' ? `<button ${BTN} data-hgs="${h.id}">Settle</button> <button ${BTN} data-hgc="${h.id}">Cancel</button>` : '') },
  ], rows: hs.hedges, empty: 'No hedges recorded.' });
  const ac = (accts.accounts ?? []).filter((a) => !a.archived);
  $('[data-fxx]', el).addEventListener('click', () => fetchFile('/v1/finance/fx-exposure?format=xlsx', 'plugsure-fx-exposure.xlsx'));
  $('[data-hgnew]', el)?.addEventListener('click', () => modal({ title: 'Record an FX hedge', body: `<div class="form">${field('Bank', '<input name="b" maxlength="120">')}${field('Reference', '<input name="r" maxlength="80">', { opt: true })}${field('Buy currency', '<input name="bc" maxlength="3" placeholder="USD">')}${field('Sell currency', `<input name="sc" maxlength="3" value="${esc(rep ?? LEGACY_CURRENCY)}">`)}${field('Notional (in the currency bought)', '<input name="n" type="number" step="any" min="0">')}${field('Contract rate (one unit bought, in the currency sold)', '<input name="rt" type="number" step="any" min="0">')}${field('Trade date', `<input name="t" type="date" value="${zonedYmd()}">`)}${field('Maturity', '<input name="mt" type="date">')}${field('Settlement account', `<select name="a"><option value="">—</option>${ac.map((a) => `<option value="${a.id}">${esc(a.name)} (${esc(a.currency)})</option>`).join('')}</select>`, { opt: true })}${field('Purpose', '<input name="p" maxlength="300">', { opt: true })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', async onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el)?.value.trim(); try { await api('/v1/finance/fx-hedges', { method: 'POST', body: { bank: v('b'), reference: v('r') || undefined, buyCurrency: v('bc').toUpperCase(), sellCurrency: v('sc').toUpperCase(), notional: Math.round(Number(v('n')) * 10 ** fxExp(v('bc').toUpperCase())), rate: Number(v('rt')), tradeOn: v('t'), maturityOn: v('mt'), cashAccountId: v('a') || undefined, purpose: v('p') || undefined } }); toast('Hedge recorded'); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] }));
  el.querySelectorAll('[data-hgs]').forEach((b) => b.addEventListener('click', () => modal({ title: 'Settle the hedge', body: `<div class="form">${field('Settled on', `<input name="d" type="date" value="${zonedYmd()}">`)}${field('Rate of the day', '<input name="r" type="number" step="any" min="0">')}</div><p class="cell-sub">The result, notional × (rate of the day − contract rate), posts to the ledger: FX gains (7400) or FX losses (8400).</p>`,
    actions: [{ label: 'Cancel' }, { label: 'Settle', kind: 'primary', async onClick(mc) { try { const r = await api(`/v1/finance/fx-hedges/${b.dataset.hgs}`, { method: 'PUT', body: { status: 'settled', settledOn: $('[name="d"]', mc.el).value, settledRate: Number($('[name="r"]', mc.el).value) } }); toast(`Settled: ${fxMoney(r.realised, r.sellCurrency)}`); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] })));
  el.querySelectorAll('[data-hgc]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/v1/finance/fx-hedges/${b.dataset.hgc}`, { method: 'PUT', body: { status: 'cancelled' } }); toast('Hedge cancelled'); reload(); } catch (err) { toast(err.message, 'crit'); } }));
}

// ─────────────────────────────────────────── (v1.38.0) procurement analytics

const GRADE_T = { A: 't-ok', B: 't-info', C: 't-warn', D: 't-crit' };

async function procurementSection(host, canWrite, months = 12) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d, sup;
  try { [d, sup] = await Promise.all([api(`/v1/finance/procurement?months=${months}`), api('/v1/finance/suppliers').catch(() => ({ suppliers: [] }))]); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = (n = months) => procurementSection(host, canWrite, n);
  const m = (v, c) => (v == null ? '—' : esc(fmt.money(v, c)));
  const pct = (v) => (v == null ? '—' : `${v}%`);
  const c0 = d.spend.currencies[0];
  const rising = d.prices.parts.filter((p) => p.rising).length + d.prices.energy.filter((p) => p.rising).length;
  const sv = Object.entries(d.savings.totals)[0];
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Months', `<select data-prm>${[3, 6, 12].map((n) => `<option value="${n}"${n === months ? ' selected' : ''}>Last ${n} whole months</option>`).join('')}</select>`)}<div class="row" style="align-self:flex-end;gap:6px">${canWrite ? `<button class="btn primary" type="button" data-svnew>${icon('plus')} Record a saving</button>` : ''}<button class="btn" type="button" data-prx>${icon('download')} Excel</button></div></div>
    <div class="grid k4 section">${c0 ? kpi(`Spend · ${esc(c0.currency)}`, m(c0.total, c0.currency), `${c0.bills} bills · ${c0.suppliers.length} suppliers`) : kpi('Spend', '—', 'no approved bills')}${kpi('Top supplier', c0?.topSupplierPct != null ? `${c0.topSupplierPct}%` : '—', c0?.suppliers[0] ? esc(c0.suppliers[0].supplier) : '', (c0?.topSupplierPct ?? 0) > 50 ? 'warn' : '')}${kpi('Prices rising', String(rising), `over ${d.prices.risePct}% in the period`, rising ? 'warn' : '')}${kpi('Savings', sv ? m(sv[1].expected, sv[0]) : '—', sv ? `${m(sv[1].toDate, sv[0])} to date` : 'none recorded')}</div>
    <div class="grid k2 section"><div class="card"><header><h3>Spend by supplier</h3></header><div data-prs></div></div><div class="card"><header><h3>By category</h3></header><div data-prc></div></div></div>
    <div class="card section"><header><h3>Supplier scorecards</h3></header><div data-prsc></div></div>
    <div class="grid k2 section"><div class="card"><header><h3>Part prices</h3></header><div data-prp></div></div><div class="card"><header><h3>Energy per kWh</h3></header><div data-pre></div></div></div>
    <div class="card section"><header><h3>Savings register</h3></header><div data-prv></div></div>`;
  table($('[data-prs]', el), { columns: [
    { label: 'Supplier', render: (s) => `<b>${esc(s.supplier)}</b><div class="cell-sub">${s.bills} bills</div>` },
    { label: 'Spend', num: true, render: (s) => m(s.total, c0.currency) }, { label: 'Share', num: true, render: (s) => pct(s.sharePct) },
  ], rows: (c0?.suppliers ?? []).slice(0, 10), empty: 'No approved bills in the period.' });
  table($('[data-prc]', el), { columns: [
    { label: 'Category', render: (k) => esc(k.category) }, { label: 'Spend', num: true, render: (k) => m(k.total, c0.currency) }, { label: 'Share', num: true, render: (k) => pct(k.sharePct) },
  ], rows: c0?.categories ?? [], empty: '' });
  table($('[data-prsc]', el), { columns: [
    { label: 'Supplier', render: (s) => `<b>${esc(s.supplier)}</b><div class="cell-sub">${s.orders} orders · ${s.bills} bills</div>` },
    { label: 'On time', num: true, render: (s) => `${pct(s.onTimePct)}${s.avgDaysLate != null ? `<div class="cell-sub">${s.avgDaysLate} days late on average</div>` : ''}` },
    { label: 'Bills rejected', num: true, render: (s) => pct(s.rejectedPct) },
    { label: 'Paid on time', num: true, render: (s) => pct(s.paidOnTimePct) },
    { label: 'Score', num: true, render: (s) => (s.score == null ? '—' : `<b>${s.score}</b> ${tag(GRADE_T[s.grade], s.grade)}`) },
  ], rows: d.scorecards.suppliers, empty: 'No orders or bills in the period.' });
  table($('[data-prp]', el), { columns: [
    { label: 'Part', render: (p) => `<b>${esc(p.name)}</b> <span class="cell-sub mono">${esc(p.sku)}</span><div class="cell-sub">${esc([p.supplier, `${p.receipts} receipt${p.receipts === 1 ? '' : 's'}`].filter(Boolean).join(' · '))}</div>` },
    { label: 'Unit cost', num: true, render: (p) => `${m(p.last, p.currency)}<div class="cell-sub">from ${m(p.first, p.currency)}</div>` },
    { label: 'Change', num: true, render: (p) => (p.changePct == null ? '—' : p.rising ? tag('t-warn', `+${p.changePct}%`) : `${p.changePct}%`) },
  ], rows: d.prices.parts, empty: 'No parts received in the period.' });
  table($('[data-pre]', el), { columns: [
    { label: 'Site', render: (s) => `<b>${esc(s.site)}</b><div class="cell-sub">${s.months.length} bill${s.months.length === 1 ? '' : 's'}</div>` },
    { label: 'Per kWh', num: true, render: (s) => `${s.last == null ? '—' : esc(fmt.money(s.last, s.currency))}<div class="cell-sub">from ${s.first == null ? '—' : esc(fmt.money(s.first, s.currency))}</div>` },
    { label: 'Change', num: true, render: (s) => (s.changePct == null ? '—' : s.rising ? tag('t-warn', `+${s.changePct}%`) : `${s.changePct}%`) },
  ], rows: d.prices.energy, empty: 'No energy bills in the period.' });
  table($('[data-prv]', el), { columns: [
    { label: 'Saving', render: (v) => `<b>${esc(v.description)}</b><div class="cell-sub">${esc([v.supplier, v.category].filter(Boolean).join(' · '))}</div>` },
    { label: 'Price', num: true, render: (v) => `${m(v.negotiatedUnit, v.currency)}<div class="cell-sub">was ${m(v.baselineUnit, v.currency)} (−${v.unitSavingPct}%)</div>` },
    { label: 'Period', render: (v) => `${esc(v.periodFrom)} – ${esc(v.periodTo)}<div class="cell-sub">${v.passedPct}% passed</div>` },
    { label: 'Expected', num: true, render: (v) => `${m(v.expected, v.currency)}<div class="cell-sub">${m(v.toDate, v.currency)} to date</div>` },
    { label: '', render: (v) => (v.voided ? tag('t-mute', 'void') : canWrite ? `<button ${BTN} data-svv="${v.id}">Void</button>` : '') },
  ], rows: d.savings.savings, empty: 'No savings recorded.' });
  $('[data-prm]', el).addEventListener('change', (e) => reload(Number(e.target.value)));
  $('[data-prx]', el).addEventListener('click', () => fetchFile(`/v1/finance/procurement?months=${months}&format=xlsx`, 'plugsure-procurement.xlsx'));
  el.querySelectorAll('[data-svv]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/v1/finance/procurement/savings/${b.dataset.svv}/void`, { method: 'POST' }); toast('Saving voided'); reload(); } catch (err) { toast(err.message, 'crit'); } }));
  const sl = (sup.suppliers ?? []).filter((s) => !s.archived);
  $('[data-svnew]', el)?.addEventListener('click', () => modal({ title: 'Record a negotiated saving', body: `<div class="form">${field('Supplier', `<select name="s"><option value="">—</option>${sl.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>`, { opt: true })}${field('Category', '<input name="c" maxlength="40" placeholder="parts, energy, maintenance…">')}${field('Description', '<input name="d" maxlength="300">')}${field('Currency', `<input name="cu" maxlength="3" value="${esc(LEGACY_CURRENCY)}">`)}${field('Price per unit before', '<input name="b" type="number" min="0">')}${field('Negotiated price per unit', '<input name="n" type="number" min="0">')}${field('Quantity expected', '<input name="q" type="number" step="any" min="0">')}${field('From', `<input name="f" type="date" value="${zonedYmd()}">`)}${field('To', '<input name="t" type="date">')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', async onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el)?.value.trim(); try { await api('/v1/finance/procurement/savings', { method: 'POST', body: { supplierId: v('s') || undefined, category: v('c'), description: v('d'), currency: v('cu').toUpperCase(), baselineUnit: Number(v('b')), negotiatedUnit: Number(v('n')), quantity: Number(v('q')), periodFrom: v('f'), periodTo: v('t') } }); toast('Saving recorded'); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] }));
}

// ─────────────────────────────────────────── (v1.38.0) close automation

const ACT_T = { done: 't-ok', skipped: 't-mute', failed: 't-crit' };

async function closeAutoSection(host, canWrite, month) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d, users;
  try { [d, users] = await Promise.all([api(`/v1/finance/close-automation${month ? `?month=${month}` : ''}`), api('/v1/users').catch(() => [])]); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = (mo = d.month) => closeAutoSection(host, canWrite, mo);
  const c = d.calendar, tr = d.trend;
  const ul = (Array.isArray(users) ? users : users.users ?? []).filter((u) => u.status !== 'disabled');
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Month', `<input type="month" data-cam value="${esc(d.month)}">`)}<div class="row" style="align-self:flex-end;gap:6px">${canWrite && !c.locked ? `<button class="btn primary" type="button" data-carun>${icon('refresh')} Run the close now</button>` : ''}${canWrite ? `<button class="btn" type="button" data-caset>Settings</button><button class="btn" type="button" data-caown>Owners &amp; due days</button>` : ''}</div></div>
    ${callout('info', `The mechanical part of the close: fetch missing rates, record depreciation and leases, sync the ledger and run the checks; then what still blocks. People sign each step off and lock the month (Finance → Close steps). ${d.settings.enabled ? `Automatic: from working day ${d.settings.runOnDay} after the month end, daily until locked${d.nextRunOn ? ` (from ${esc(d.nextRunOn)})` : ''}.` : 'Automatic runs are off.'}`)}
    <div class="grid k4 section">${kpi(`Close · ${esc(d.month)}`, c.locked ? 'locked' : `${c.done} / ${c.total}`, c.locked ? '' : 'steps signed off', c.locked ? 'ok' : '')}${kpi('Overdue steps', String(c.overdue), c.lastDue ? `all due by ${esc(c.lastDue)}` : '', c.overdue ? 'crit' : '')}${kpi('Days to close', tr.averageDays == null ? '—' : String(tr.averageDays), tr.months.length ? `average of ${tr.months.length} month${tr.months.length === 1 ? '' : 's'} · best ${tr.best}` : 'no month locked yet', tr.improving === false ? 'warn' : '')}${kpi('Last run', d.runs[0] ? `${d.runs[0].blocking} blocking` : '—', d.runs[0] ? `${esc(fmt.time(d.runs[0].startedAt))}${d.runs[0].automatic ? ' · automatic' : ''}` : 'not run yet', d.runs[0]?.blocking ? 'warn' : '')}</div>
    <div class="card section"><header><h3>Calendar</h3></header><div data-cac></div></div>
    <div class="grid k2 section"><div class="card"><header><h3>Runs</h3></header><div data-car></div></div><div class="card"><header><h3>Days from month end to lock</h3></header><div data-cat></div></div></div>`;
  table($('[data-cac]', el), { columns: [
    { label: 'Due', render: (s) => `${esc(s.dueOn)}<div class="cell-sub">working day ${s.dueDay}</div>` },
    { label: 'Step', render: (s) => `<b>${esc(s.label)}</b><div class="cell-sub">${esc(s.detail)}</div>` },
    { label: 'Owner', render: (s) => esc(s.owner ?? '—') },
    { label: 'Check', render: (s) => (s.ok ? tag('t-ok', 'passes') : tag('t-warn', 'open')) },
    { label: 'Status', render: (s) => (s.done ? tag('t-ok', 'signed off') : s.overdue ? tag('t-crit', 'overdue') : tag('t-mute', 'to do')) },
  ], rows: c.steps, empty: '' });
  table($('[data-car]', el), { columns: [
    { label: 'Run', render: (r) => `${esc(fmt.time(r.startedAt))}<div class="cell-sub">${r.automatic ? 'automatic' : esc(r.by ?? '')}</div>` },
    { label: 'Actions', render: (r) => r.actions.filter((a) => !a.action.startsWith('blocking:')).map((a) => `<div>${tag(ACT_T[a.status], a.status)} ${esc(a.action.replace(/_/g, ' '))}<span class="cell-sub"> ${esc(a.detail)}</span></div>`).join('') },
    { label: 'Blocking', num: true, render: (r) => (r.blocking ? `<b>${r.blocking}</b>` : tag('t-ok', 'none')) },
  ], rows: d.runs, empty: 'Not run for this month.' });
  table($('[data-cat]', el), { columns: [
    { label: 'Month', render: (x) => esc(x.month) }, { label: 'Locked', render: (x) => esc(x.lockedOn) }, { label: 'Days', num: true, render: (x) => String(x.days) },
  ], rows: tr.months.slice().reverse(), empty: 'No month locked yet.' });
  $('[data-cam]', el).addEventListener('change', (e) => e.target.value && reload(e.target.value));
  $('[data-carun]', el)?.addEventListener('click', async (e) => { e.target.disabled = true; try { const r = await api('/v1/finance/close-automation/run', { method: 'POST', body: { month: d.month } }); toast(`Run done: ${r.blocking} step(s) still blocking`); reload(); } catch (err) { toast(err.message, 'crit'); e.target.disabled = false; } });
  $('[data-caset]', el)?.addEventListener('click', () => modal({ title: 'Close automation', body: `<div class="form">${field('Automatic runs', `<select name="e"><option value="true"${d.settings.enabled ? ' selected' : ''}>On</option><option value="false"${d.settings.enabled ? '' : ' selected'}>Off</option></select>`)}${field('From working day', `<input name="r" type="number" min="1" max="10" value="${d.settings.runOnDay}">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) { try { await api('/v1/finance/close-automation/settings', { method: 'PUT', body: { enabled: $('[name="e"]', mc.el).value === 'true', runOnDay: Number($('[name="r"]', mc.el).value) } }); toast('Saved'); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] }));
  $('[data-caown]', el)?.addEventListener('click', () => modal({ title: 'Owners and due days', body: `<div class="form">${c.steps.slice().sort((a, b) => a.label.localeCompare(b.label)).map((s) => `<div class="row" style="gap:8px;align-items:flex-end">${field(esc(s.label), `<select data-ow="${s.step}"><option value="">—</option>${ul.map((u) => `<option value="${esc(u.id)}"${u.id === s.ownerId ? ' selected' : ''}>${esc(u.name ?? u.email)}</option>`).join('')}</select>`)}${field('Day', `<input data-dd="${s.step}" type="number" min="1" max="20" value="${s.dueDay}" style="width:70px">`)}</div>`).join('')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) { const assignments = c.steps.map((s) => ({ step: s.step, ownerId: $(`[data-ow="${s.step}"]`, mc.el).value || null, dueDay: Number($(`[data-dd="${s.step}"]`, mc.el).value) })); try { await api('/v1/finance/close-automation/owners', { method: 'PUT', body: { assignments } }); toast('Saved'); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] }));
}

// ─────────────────────────────────────────── (v1.38.0) owner and partner finance

async function ownerFinanceSection(host, canWrite, months = 12) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api(`/v1/finance/owner-finance?months=${months}`); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = (n = months) => ownerFinanceSection(host, canWrite, n);
  const m = (v, c) => (v == null || !c ? '—' : esc(fmt.money(v, c)));
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Months', `<select data-ofm>${[3, 6, 12].map((n) => `<option value="${n}"${n === months ? ' selected' : ''}>Last ${n} whole months</option>`).join('')}</select>`)}</div>
    ${callout('info', 'What each site owner earns from the sites you run for them, as they see it in the owner portal (Payouts): their sites\' revenue, the statements\' share, what has been paid and what is still owed.')}
    <div class="grid k3 section">${Object.entries(d.totals).map(([c, t]) => `${kpi(`Owners' share · ${esc(c)}`, m(t.share, c), `${t.owners} owners`)}${kpi('Paid', m(t.paid, c), `${esc(d.from)} to ${esc(d.to)}`)}${kpi('Still owed', m(t.outstanding, c), '', t.outstanding ? 'warn' : '')}`).join('') || kpi("Owners' share", '—', 'no finalised statements')}</div>
    <div class="card section"><header><h3>Owners</h3></header><div data-ofl></div></div>`;
  table($('[data-ofl]', el), { columns: [
    { label: 'Owner', render: (o) => `<b>${esc(o.owner)}</b><div class="cell-sub">${o.sites} site${o.sites === 1 ? '' : 's'}</div>` },
    { label: 'Share', num: true, render: (o) => `${m(o.share, o.currency)}<div class="cell-sub">of ${m(o.gross, o.currency)}</div>` },
    { label: 'Paid', num: true, render: (o) => m(o.paid, o.currency) },
    { label: 'Still owed', num: true, render: (o) => (o.outstanding ? `<b>${m(o.outstanding, o.currency)}</b><div class="cell-sub">since ${esc(o.oldestUnpaid ?? '')}</div>` : '—') },
    { label: 'Queries', num: true, render: (o) => (o.openQueries ? tag('t-warn', `${o.openQueries} open`) : '—') },
    { label: '', render: (o) => `<button ${BTN} data-ofo="${esc(o.ownerId)}">Open</button>` },
  ], rows: d.owners, empty: 'No site owners.' });
  $('[data-ofm]', el).addEventListener('change', (e) => reload(Number(e.target.value)));
  el.querySelectorAll('[data-ofo]').forEach((b) => b.addEventListener('click', async () => {
    let s;
    try { s = await api(`/v1/finance/owners/${b.dataset.ofo}/finance?months=${months}`); } catch (err) { toast(err.message, 'crit'); return; }
    const c = s.currencies[0];
    drawer({ title: s.owner.name, subtitle: esc(`${s.from} to ${s.to} · ${s.siteCount} site${s.siteCount === 1 ? '' : 's'}`), tabs: [
      { label: 'By month', render: (body) => {
        if (!c) { body.innerHTML = '<p class="cell-sub">Nothing in the period.</p>'; return; }
        body.innerHTML = `<div class="grid k3">${kpi('Revenue', m(c.totals.revenue, c.currency), `${fmt.num(Math.round(c.totals.kwh))} kWh`)}${kpi('Share', m(c.totals.share, c.currency), c.totals.sharePct != null ? `${c.totals.sharePct}%` : '')}${kpi('Still owed', m(c.totals.outstanding, c.currency), s.openQueries.count ? `${s.openQueries.count} open queries` : '', c.totals.outstanding ? 'warn' : '')}</div><div data-x></div><div class="row" style="margin-top:10px"><button class="btn" type="button" data-oxx>${icon('download')} Excel</button></div>`;
        table($('[data-x]', body), { columns: [
          { label: 'Month', render: (x) => `${esc(x.month)}${x.statement ? `<div class="cell-sub mono">${esc(x.statement)}</div>` : ''}` },
          { label: 'Revenue', num: true, render: (x) => m(x.revenue, c.currency) },
          { label: 'Share', num: true, render: (x) => m(x.share, c.currency) },
          { label: 'Paid', num: true, render: (x) => m(x.paid, c.currency) },
          { label: 'Owed', num: true, render: (x) => (x.outstanding ? m(x.outstanding, c.currency) : '—') },
        ], rows: c.months.slice().reverse(), empty: '' });
        $('[data-oxx]', body).addEventListener('click', () => fetchFile(`/v1/finance/owners/${s.owner.id}/finance?months=${months}&format=xlsx`, 'plugsure-owner-finance.xlsx'));
      } },
      { label: 'Sites', render: (body) => { table(body, { columns: [
        { label: 'Site', render: (x) => `<b>${esc(x.site)}</b><div class="cell-sub">${x.sessions} sessions</div>` }, { label: 'kWh', num: true, render: (x) => fmt.num(Math.round(x.kwh)) }, { label: 'Revenue', num: true, render: (x) => m(x.revenue, c?.currency) },
      ], rows: c?.sites ?? [], empty: 'No activity.' }); } },
    ] });
  }));
}

// ─────────────────────────────────────────── (v1.39.0) financial statements

async function statutorySection(host, canWrite, year) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  const y = year ?? new Date().getFullYear() - 1;
  let s;
  try { s = await api(`/v1/finance/financial-statements?year=${y}`); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const c = s.currency, m = (v) => esc(fmt.money(v, c));
  const years = Array.from({ length: 6 }, (_, k) => new Date().getFullYear() - k);
  const row = (label, a, b, bold) => `<tr${bold ? ' style="font-weight:600"' : ''}><td>${esc(label)}</td><td class="num">${a === '' ? '' : m(a)}</td><td class="num">${b === '' ? '' : m(b)}</td></tr>`;
  const tbl = (title, rows) => `<div class="card section"><header><h3>${esc(title)}</h3></header><div class="table-wrap"><table class="t"><thead><tr><th></th><th class="num" style="width:28%">${s.year}</th><th class="num" style="width:28%">${s.year - 1}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div></div>`;
  const C = s.current, P = s.prior, cf = s.cashFlow, pf = s.cashFlowPrior;
  const wc = (f) => f.operating - f.result - f.depreciation - f.deferredTax;
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Year', `<select data-sty>${years.map((v) => `<option${v === s.year ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}<div class="row" style="align-self:flex-end;gap:6px"><button class="btn" type="button" data-stx>${icon('download')} Excel</button><button class="btn" type="button" data-stp>${icon('download')} PDF</button></div></div>
    ${callout(s.checks.balanced && s.checks.cashFlowReconciles ? 'info' : 'warn', `${s.checks.balanced && s.checks.cashFlowReconciles ? '' : `<b>Check:</b> ${!s.checks.balanced ? 'the balance sheet does not balance. ' : ''}${!s.checks.cashFlowReconciles ? 'the cash flow does not reconcile to the change in cash. ' : ''}`}The year ended 31 December ${s.year} in ${esc(c)}, from the ledger (sync each month first), with ${s.year - 1} beside it. Earlier years' results are retained earnings. Not audited.`)}
    <div class="grid k4 section">${kpi('Revenue', m(C.profitAndLoss.revenue), `${s.year - 1}: ${m(P.profitAndLoss.revenue)}`)}${kpi('Result for the year', m(C.profitAndLoss.result), `before tax ${m(C.profitAndLoss.resultBeforeTax)}`, C.profitAndLoss.result < 0 ? 'warn' : '')}${kpi('Total assets', m(C.balanceSheet.totalAssets), `equity ${m(C.balanceSheet.equity.total)}`)}${kpi('Cash', m(cf.cashClose), `${cf.net >= 0 ? '+' : ''}${m(cf.net)} in the year`)}</div>
    <div class="grid k2">${tbl('Statement of financial position', [
      row('Current assets', C.balanceSheet.currentAssets, P.balanceSheet.currentAssets), row('Non-current assets', C.balanceSheet.nonCurrentAssets, P.balanceSheet.nonCurrentAssets), row('Total assets', C.balanceSheet.totalAssets, P.balanceSheet.totalAssets, true),
      row('Current liabilities', C.balanceSheet.currentLiabilities, P.balanceSheet.currentLiabilities), row('Non-current liabilities', C.balanceSheet.nonCurrentLiabilities, P.balanceSheet.nonCurrentLiabilities),
      row('Share capital and other equity', C.balanceSheet.equity.capital, P.balanceSheet.equity.capital), row('Retained earnings', C.balanceSheet.equity.retainedEarnings, P.balanceSheet.equity.retainedEarnings), row('Result for the year', C.balanceSheet.equity.result, P.balanceSheet.equity.result),
      row('Total liabilities and equity', C.balanceSheet.totalLiabilities + C.balanceSheet.equity.total, P.balanceSheet.totalLiabilities + P.balanceSheet.equity.total, true)])}
    ${tbl('Statement of profit or loss', [row('Revenue', C.profitAndLoss.revenue, P.profitAndLoss.revenue), row('Cost of energy', C.profitAndLoss.costOfEnergy, P.profitAndLoss.costOfEnergy), row('Gross profit', C.profitAndLoss.grossProfit, P.profitAndLoss.grossProfit, true),
      row('Operating expenses', C.profitAndLoss.operatingExpenses, P.profitAndLoss.operatingExpenses), row('Other income and expense', C.profitAndLoss.otherIncomeExpense, P.profitAndLoss.otherIncomeExpense), row('Result before tax', C.profitAndLoss.resultBeforeTax, P.profitAndLoss.resultBeforeTax, true),
      row('Income tax', C.profitAndLoss.incomeTax, P.profitAndLoss.incomeTax), row('Result for the year', C.profitAndLoss.result, P.profitAndLoss.result, true)])}</div>
    <div class="grid k2">${tbl('Statement of cash flows', [row('Result for the year', cf.result, pf.result), row('Depreciation', cf.depreciation, pf.depreciation), row('Deferred tax', cf.deferredTax, pf.deferredTax), row('Change in working capital', wc(cf), wc(pf)),
      row('Operating activities', cf.operating, pf.operating, true), row('Investing activities', cf.investingTotal, pf.investingTotal, true), row('Financing activities', cf.financingTotal, pf.financingTotal, true),
      row('Net change in cash', cf.net, pf.net, true), row('Cash at the start', cf.cashOpen, pf.cashOpen), row('Cash at the end', cf.cashClose, pf.cashClose)])}
    ${tbl('Changes in equity', [row('Opening equity', s.equity.opening, s.equity.prior.opening), row('Result for the year', s.equity.result, s.equity.prior.result), row('Capital movements', s.equity.capitalMovements, s.equity.prior.capitalMovements), row('Closing equity', s.equity.closing, s.equity.opening, true)])}</div>
    <div class="card section"><header><h3>Notes</h3></header><div data-stn></div></div>`;
  table($('[data-stn]', el), { columns: [
    { label: 'Line', render: (a) => esc(a.line) }, { label: 'Account', render: (a) => `<span class="mono">${esc(a.code)}</span> ${esc(a.name)}` },
    { label: String(s.year), num: true, render: (a) => m(a.amount) }, { label: String(s.year - 1), num: true, render: (a) => m(a.prior) },
  ], rows: s.notes.flatMap((n) => n.accounts.map((a) => ({ ...a, line: n.label }))), empty: 'Nothing posted for these years.' });
  $('[data-sty]', el).addEventListener('change', (e) => statutorySection(host, canWrite, Number(e.target.value)));
  $('[data-stx]', el).addEventListener('click', () => fetchFile(`/v1/finance/financial-statements?year=${s.year}&format=xlsx`, `plugsure-financial-statements-${s.year}.xlsx`));
  $('[data-stp]', el).addEventListener('click', () => fetchFile(`/v1/finance/financial-statements?year=${s.year}&format=pdf`, `plugsure-financial-statements-${s.year}.pdf`));
}

// ─────────────────────────────────────────── (v1.39.0) corporate income tax

const TAXK = { pph25: 'PPh 25 instalment', pph29: 'PPh 29', pph22: 'PPh 22 withheld', pph23: 'PPh 23 withheld' };
const FC_CAT = ['entertainment', 'donations', 'fines', 'benefits_in_kind', 'final_income', 'non_taxable', 'loss_carried_forward', 'other'];

async function corpTaxSection(host, canWrite, year) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  const y = year ?? new Date().getFullYear() - 1;
  let c, accts;
  try { [c, accts] = await Promise.all([api(`/v1/finance/corporate-tax?year=${y}`), api('/v1/finance/cash/accounts').catch(() => ({ accounts: [] }))]); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => corpTaxSection(host, canWrite, c.year);
  const m = (v) => esc(fmt.money(v, c.currency));
  const final = c.status === 'final', canApprove = state.can('finance:approve');
  const years = Array.from({ length: 6 }, (_, k) => new Date().getFullYear() - k);
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Year', `<select data-cty>${years.map((v) => `<option${v === c.year ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}<div class="row" style="align-self:flex-end;gap:6px;flex-wrap:wrap">
      ${canWrite && !final ? `<button class="btn" type="button" data-ctc>${icon('plus')} Fiscal correction</button>` : ''}${canWrite ? `<button class="btn" type="button" data-ctp>${icon('plus')} Tax paid or withheld</button><button class="btn" type="button" data-cts>Rate &amp; facility</button>` : ''}
      ${canApprove && c.ended ? `<button class="btn${final ? '' : ' primary'}" type="button" data-ctd="${final ? 'reopen' : 'finalise'}">${final ? 'Reopen' : 'Finalise the year'}</button>` : ''}<button class="btn" type="button" data-ctx>${icon('download')} Workpaper</button></div></div>
    ${callout(final ? (c.changedSinceFinal ? 'warn' : 'info') : 'info', final ? `Final${c.finalisedBy ? ` (${esc(c.finalisedBy)}, ${esc(fmt.time(c.finalisedAt))})` : ''}: the December tax journal books it.${c.changedSinceFinal ? ' The books have changed since: reopen and finalise again if the change belongs to this year.' : ''}` : `The year's corporate income tax (PPh Badan) from the books, ${c.ratePct}%${c.facility31e ? ' with Article 31E' : ''}. Automatic corrections come from the asset register, leases, the bad-debt allowance and loyalty; add the rest. Confirm with your tax advisor before filing the SPT Tahunan.`)}
    <div class="grid k4 section">${kpi('Fiscal profit', m(c.fiscalProfit), `commercial ${m(c.resultBeforeTax)}`)}${kpi('Corporate income tax', m(c.tax), c.effectiveRatePct != null ? `${c.effectiveRatePct}% of the result${c.facilitySharePct ? ` · 31E on ${c.facilitySharePct}%` : ''}` : '')}${kpi(c.pph29 >= 0 ? 'PPh 29 to pay' : 'Overpaid', m(Math.abs(c.pph29)), `credits ${m(c.totalCredits)} · paid ${m(c.pph29Paid)}`, c.pph29 - c.pph29Paid > 0 ? 'warn' : '')}${kpi('Deferred tax', m(Math.abs(c.deferred.net)), c.deferred.net > 0 ? 'liability' : c.deferred.net < 0 ? 'asset' : 'none')}</div>
    <div class="grid k2"><div class="card section"><header><h3>Fiscal corrections</h3></header><div data-ctl></div></div><div class="card section"><header><h3>Tax paid and credits</h3></header><div data-ctpl></div><div class="body cell-sub">Next year's PPh 25: ${m(c.nextPph25)} a month.</div></div></div>
    <div class="card section"><header><h3>Deferred tax</h3></header><div data-ctdt></div></div>`;
  table($('[data-ctl]', el), { columns: [
    { label: 'Correction', render: (x) => `<b>${esc(x.category.replace(/_/g, ' '))}</b>${x.automatic ? ` ${tag('t-info', 'automatic')}` : ''}<div class="cell-sub">${esc(x.description)}</div>` },
    { label: 'Amount', num: true, render: (x) => `${x.direction === 'positive' ? '+' : '−'}${m(x.amount)}` },
    { label: '', render: (x) => (!x.automatic && canWrite && !final ? `<button ${BTN} data-ctv="${x.id}">Void</button>` : '') },
  ], rows: c.corrections, empty: 'No corrections.' });
  table($('[data-ctpl]', el), { columns: [
    { label: 'Kind', render: (p) => `${esc(TAXK[p.kind])}${p.month ? ` <span class="cell-sub">${esc(p.month)}</span>` : ''}<div class="cell-sub">${esc(p.reference ?? '')}</div>` },
    { label: 'Paid', render: (p) => esc(p.paidOn) }, { label: 'Amount', num: true, render: (p) => m(p.amount) },
    { label: '', render: (p) => (canWrite ? `<button ${BTN} data-ctpv="${p.id}">Void</button>` : '') },
  ], rows: c.payments, empty: 'None recorded.' });
  table($('[data-ctdt]', el), { columns: [
    { label: 'Temporary difference', render: (i) => esc(i.label) }, { label: 'Amount', num: true, render: (i) => m(i.amount) },
    { label: `Tax at ${c.ratePct}%`, num: true, render: (i) => `${m(Math.abs(i.tax))} <span class="cell-sub">${i.tax > 0 ? 'liability' : i.tax < 0 ? 'asset' : ''}</span>` },
  ], rows: c.deferred.items, empty: '' });
  $('[data-cty]', el).addEventListener('change', (e) => corpTaxSection(host, canWrite, Number(e.target.value)));
  $('[data-ctx]', el).addEventListener('click', () => fetchFile(`/v1/finance/corporate-tax?year=${c.year}&format=xlsx`, `plugsure-corporate-tax-${c.year}.xlsx`));
  $('[data-ctd]', el)?.addEventListener('click', async (e) => { try { await api(`/v1/finance/corporate-tax/${c.year}/decide`, { method: 'POST', body: { action: e.currentTarget.dataset.ctd } }); toast('Saved', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); } });
  el.querySelectorAll('[data-ctv]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/v1/finance/corporate-tax/corrections/${b.dataset.ctv}/void`, { method: 'POST' }); reload(); } catch (err) { toast(err.message, 'crit'); } }));
  el.querySelectorAll('[data-ctpv]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/v1/finance/corporate-tax/payments/${b.dataset.ctpv}/void`, { method: 'POST' }); reload(); } catch (err) { toast(err.message, 'crit'); } }));
  $('[data-ctc]', el)?.addEventListener('click', () => modal({ title: `Fiscal correction · ${c.year}`, body: `<div class="form">${field('Direction', '<select name="d"><option value="positive">Positive: not deductible</option><option value="negative">Negative: not taxable or taxed finally</option></select>')}${field('Category', `<select name="c">${FC_CAT.map((x) => `<option value="${x}">${x.replace(/_/g, ' ')}</option>`).join('')}</select>`)}${field('Description', '<input name="t" maxlength="300">')}${field('Amount', '<input name="a" type="number" min="1">')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', async onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value; try { await api('/v1/finance/corporate-tax/corrections', { method: 'POST', body: { year: c.year, currency: c.currency, direction: v('d'), category: v('c'), description: v('t'), amount: Number(v('a')) } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] }));
  const ac = (accts.accounts ?? []).filter((a) => !a.archived && a.currency === c.currency);
  $('[data-ctp]', el)?.addEventListener('click', () => modal({ title: `Income tax · ${c.year}`, body: `<div class="form">${field('Kind', `<select name="k">${Object.entries(TAXK).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>`)}${field('Tax month (PPh 25)', '<input name="mo" type="month">', { opt: true })}${field('Amount', '<input name="a" type="number" min="1">')}${field('Paid or withheld on', `<input name="p" type="date" value="${zonedYmd()}">`)}${field('NTPN or bukti potong', '<input name="r" maxlength="80">', { opt: true })}${field('Paid from (PPh 25 and 29)', `<select name="ac"><option value="">—</option>${ac.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>`, { opt: true })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', async onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value; try { await api('/v1/finance/corporate-tax/payments', { method: 'POST', body: { year: c.year, currency: c.currency, kind: v('k'), month: v('mo') || undefined, amount: Number(v('a')), paidOn: v('p'), reference: v('r') || undefined, cashAccountId: v('ac') || undefined } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] }));
  $('[data-cts]', el)?.addEventListener('click', () => modal({ title: 'Corporate tax settings', body: `<div class="form">${field('Rate %', `<input name="r" type="number" step="0.5" value="${c.settings.ratePct}">`)}${field('Article 31E (turnover up to 50 billion rupiah)', `<select name="f"><option value="true"${c.settings.facility31e ? ' selected' : ''}>Apply</option><option value="false"${c.settings.facility31e ? '' : ' selected'}>Do not apply</option></select>`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) { try { await api('/v1/finance/corporate-tax/settings', { method: 'PUT', body: { ratePct: Number($('[name="r"]', mc.el).value), facility31e: $('[name="f"]', mc.el).value === 'true' } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] }));
}

// ─────────────────────────────────────────── (v1.39.0) supplier payment runs

const PR_ST = { draft: ['t-mute', 'draft'], submitted: ['t-warn', 'submitted'], approved: ['t-info', 'approved'], paid: ['t-ok', 'paid'], cancelled: ['t-mute', 'cancelled'] };

async function payRunsSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d, accts;
  try { [d, accts] = await Promise.all([api('/v1/finance/payment-runs'), api('/v1/finance/cash/accounts').catch(() => ({ accounts: [] }))]); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => payRunsSection(host, canWrite);
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-prn>${icon('plus')} Propose a payment run</button>` : ''}</div>
    ${callout('info', 'Pay many approved bills at once: propose a run from a bank account (every bill due by a day), adjust it, submit it, and have a second Finance Manager approve it. Then upload the bank file to your bank and mark the run paid: each bill gets its payment.')}
    <div class="card section"><header><h3>Payment runs</h3></header><div data-prl></div></div>`;
  table($('[data-prl]', el), { columns: [
    { label: 'Run', render: (r) => `<b class="mono">${esc(r.number)}</b><div class="cell-sub">${esc(r.cashAccount)} · pay ${esc(r.payOn)}</div>` },
    { label: 'Bills', num: true, render: (r) => String(r.bills) }, { label: 'Total', num: true, render: (r) => esc(fmt.money(r.total, r.currency)) },
    { label: 'Status', render: (r) => `${tag(...PR_ST[r.status])}<div class="cell-sub">${esc([r.createdBy && `by ${r.createdBy}`, r.approvedBy && `approved by ${r.approvedBy}`, r.exportedAt && 'file exported'].filter(Boolean).join(' · '))}</div>` },
    { label: '', render: (r) => `<button ${BTN} data-pro="${r.id}">Open</button>` },
  ], rows: d.runs, empty: 'No payment runs yet.' });
  const banks = (accts.accounts ?? []).filter((a) => !a.archived && a.kind === 'bank');
  $('[data-prn]', el)?.addEventListener('click', () => modal({ title: 'Propose a payment run', body: `<div class="form">${field('Pay from', `<select name="a">${banks.map((a) => `<option value="${a.id}">${esc(a.name)} (${esc(a.currency)})</option>`).join('')}</select>`)}${field('Payment day', `<input name="p" type="date" value="${zonedYmd()}">`)}${field('Bills due by', `<input name="d" type="date" value="${zonedYmd(Date.now() + 7 * 864e5)}">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Propose', kind: 'primary', async onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value; try { const r = await api('/v1/finance/payment-runs', { method: 'POST', body: { cashAccountId: v('a'), payOn: v('p'), dueBy: v('d') } }); reload(); open(r.id); } catch (err) { toast(err.message, 'crit'); return false; } } }] }));
  const open = async (id) => {
    let r;
    try { r = await api(`/v1/finance/payment-runs/${id}`); } catch (err) { toast(err.message, 'crit'); return; }
    const mm = (v) => esc(fmt.money(v, r.currency));
    drawer({ title: `${r.number} · ${fmt.money(r.total, r.currency)}`, subtitle: esc(`${r.cashAccount} · pay ${r.payOn} · ${r.status}`), tabs: [{ id: 'b', label: 'Bills', render(body, ctx) {
      const act = async (fn) => { try { await fn(); toast('Done', 'ok'); ctx.close(); reload(); open(id); } catch (err) { toast(err.message, 'crit'); } };
      body.innerHTML = `${r.missingBank.length ? callout('warn', `No bank account on file for ${esc(r.missingBank.join(', '))}: add it to the supplier, or take their bills out.`) : ''}${r.note ? callout('info', esc(r.note)) : ''}<div data-pri></div>
        <div class="row" style="gap:6px;margin-top:12px;flex-wrap:wrap">${r.status === 'draft' && canWrite ? `<button ${BTN} data-pa="submit">Submit</button>` : ''}${r.status === 'submitted' && state.can('finance:approve') ? `<button ${BTN} data-pa="approve">Approve</button><button ${BTN} data-pa="return">Send back</button>` : ''}
        ${['approved', 'paid'].includes(r.status) ? ['generic', 'bca', 'mandiri'].map((f) => `<button ${BTN} data-pf="${f}">${icon('download')} ${f === 'generic' ? 'Bank file (CSV)' : f.toUpperCase() + ' layout'}</button>`).join('') : ''}${r.status === 'approved' && canWrite ? `<button ${BTN} data-pa="paid">Mark paid</button>` : ''}${['draft', 'submitted', 'approved'].includes(r.status) && canWrite ? `<button ${BTN} data-pa="cancel">Cancel</button>` : ''}</div>`;
      table($('[data-pri]', body), { columns: [
        { label: 'Bill', render: (i) => `<b>${esc(i.supplier)}</b> <span class="cell-sub mono">${esc(i.billNumber)}</span><div class="cell-sub">due ${esc(i.dueDate)} · ${i.bankReady ? `${esc(i.bank)} ${esc(i.accountNumber)}` : '<span style="color:var(--warn)">no bank account</span>'}</div>${i.error ? `<div class="cell-sub" style="color:var(--crit)">${esc(i.error)}</div>` : ''}` },
        { label: 'Amount', num: true, render: (i) => `${mm(i.amount)}${i.paid ? `<div>${tag('t-ok', 'paid')}</div>` : ''}` },
        { label: '', render: (i) => (r.status === 'draft' && canWrite ? `<button ${BTN} data-prx="${i.id}">Take out</button>` : '') },
      ], rows: r.items, empty: 'No bills.' });
      $$('[data-prx]', body).forEach((b) => b.addEventListener('click', () => act(() => api(`/v1/finance/payment-runs/${id}/items`, { method: 'PUT', body: { remove: [b.dataset.prx] } }))));
      $$('[data-pf]', body).forEach((b) => b.addEventListener('click', () => fetchFile(`/v1/finance/payment-runs/${id}/bank-file?format=${b.dataset.pf}`, `${r.number}-${b.dataset.pf}.csv`)));
      $$('[data-pa]', body).forEach((b) => b.addEventListener('click', () => {
        const a = b.dataset.pa;
        if (a === 'submit') act(() => api(`/v1/finance/payment-runs/${id}/submit`, { method: 'POST' }));
        else if (a === 'approve') act(() => api(`/v1/finance/payment-runs/${id}/decide`, { method: 'POST', body: { approve: true } }));
        else if (a === 'paid') act(() => api(`/v1/finance/payment-runs/${id}/paid`, { method: 'POST', body: {} }));
        else modal({ title: a === 'cancel' ? 'Cancel the run' : 'Send the run back', body: `<div class="form">${field(a === 'cancel' ? 'Reason' : 'Note', '<input name="n" maxlength="300">')}</div>`, actions: [{ label: 'Close' }, { label: 'Confirm', kind: 'primary', async onClick(mc) { const n = $('[name="n"]', mc.el).value; await act(() => (a === 'cancel' ? api(`/v1/finance/payment-runs/${id}/cancel`, { method: 'POST', body: { reason: n } }) : api(`/v1/finance/payment-runs/${id}/decide`, { method: 'POST', body: { approve: false, note: n } }))); } }] });
      }));
    } }] });
  };
  el.querySelectorAll('[data-pro]').forEach((b) => b.addEventListener('click', () => open(b.dataset.pro)));
}

// ─────────────────────────────────────────── (v1.39.0) corporate cards

const TX_ST = { open: ['t-warn', 'to review'], approved: ['t-ok', 'approved'], rejected: ['t-crit', 'personal'] };
const FLAG_L = { over_single_limit: 'over the single limit', over_monthly_limit: 'over the monthly limit', weekend: 'weekend', blocked_category: 'blocked category', blocked_merchant: 'blocked merchant', no_receipt: 'no receipt', duplicate: 'possible duplicate' };
const CARD_CAT = ['fuel', 'travel', 'meals', 'parking', 'tools', 'supplies', 'phone', 'software', 'other'];

async function cardsSection(host, canWrite, month) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  const mo = month ?? zonedYmd().slice(0, 7);
  let d, tx, users, accts;
  try { [d, tx, users, accts] = await Promise.all([api(`/v1/finance/cards?month=${mo}`), api(`/v1/finance/cards/transactions?month=${mo}`), api('/v1/users').catch(() => []), api('/v1/finance/cash/accounts').catch(() => ({ accounts: [] }))]); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => cardsSection(host, canWrite, mo);
  const ul = Array.isArray(users) ? users : [];
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Month', `<input type="month" data-cdm value="${esc(mo)}">`)}<div class="row" style="align-self:flex-end;gap:6px;flex-wrap:wrap">${canWrite ? `<button class="btn primary" type="button" data-cdn>${icon('plus')} Add a card</button><button class="btn" type="button" data-cdp>Spend policy</button>` : ''}<button class="btn" type="button" data-cdx>${icon('download')} Excel</button></div></div>
    ${callout('info', `Company cards: import each card's transactions from the bank, attach receipts, and review them. Flags: over a limit, weekend, blocked category or merchant, no receipt at or above ${esc(fmt.money(d.policy.receiptAbove))}, a likely duplicate. A flagged one is approved by a Finance Manager with a note; nobody reviews their own card. Personal spending is owed back.`)}
    <div class="grid k3 section">${kpi('Cards', String(d.cards.filter((c) => c.status === 'active').length), `${d.cards.length} in all`)}${kpi('To review', String(d.open), 'all months', d.open ? 'warn' : '')}${kpi('Flagged', String(d.flagged), 'to review', d.flagged ? 'warn' : '')}</div>
    <div class="card section"><header><h3>Cards · ${esc(mo)}</h3></header><div data-cdl></div></div>
    <div class="card section"><header><h3>Transactions · ${esc(mo)}</h3></header><div data-cdt></div></div>
    <div class="card section"><header><h3>Statements</h3></header><div data-cds></div></div>`;
  table($('[data-cdl]', el), { columns: [
    { label: 'Card', render: (c) => `<b>${esc(c.holder)}</b> <span class="mono">${esc(c.masked)}</span><div class="cell-sub">${esc(c.bank)} · ${esc(c.currency)}</div>` },
    { label: 'Spent', num: true, render: (c) => `${esc(fmt.money(c.spent, c.currency))}${c.monthlyLimit ? `<div class="cell-sub">${c.usedPct}% of ${esc(fmt.money(c.monthlyLimit, c.currency))}</div>` : ''}` },
    { label: 'To review', num: true, render: (c) => `${c.open}${c.flagged ? ` <span class="cell-sub">${c.flagged} flagged</span>` : ''}` },
    { label: 'Owed back', num: true, render: (c) => (c.owedByHolder ? esc(fmt.money(c.owedByHolder, c.currency)) : '—') },
    { label: 'Status', render: (c) => tag(c.status === 'active' ? 't-ok' : c.status === 'frozen' ? 't-warn' : 't-mute', c.status) },
    { label: '', render: (c) => (canWrite ? `<label class="btn sm" style="white-space:nowrap">Import CSV<input type="file" accept=".csv,text/csv" data-cdi="${c.id}" hidden></label> <button ${BTN} data-cdst="${c.id}">Statement</button> <button ${BTN} data-cde="${c.id}">Edit</button>` : '') },
  ], rows: d.cards, empty: 'No cards yet.' });
  table($('[data-cdt]', el), { columns: [
    { label: 'Date', render: (t) => esc(t.txnOn) },
    { label: 'Merchant', render: (t) => `<b>${esc(t.merchant)}</b> <span class="cell-sub">${esc(t.category)}</span><div class="cell-sub">${esc(t.card)}${t.note ? ` · ${esc(t.note)}` : ''}</div>${t.flags.length ? `<div>${t.flags.map((f) => tag('t-warn', FLAG_L[f] ?? f)).join(' ')}</div>` : ''}` },
    { label: 'Amount', num: true, render: (t) => esc(fmt.money(t.amount, t.currency)) },
    { label: 'Receipt', render: (t) => (t.receipt ? `<a href="/v1/finance/cards/transactions/${esc(t.id)}/receipt" target="_blank" rel="noopener">${esc(t.receipt.name)}</a>` : t.status === 'open' && canWrite ? `<label class="btn sm" style="white-space:nowrap">Attach<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" data-cdr="${t.id}" hidden></label>` : '—') },
    { label: 'Status', render: (t) => tag(...TX_ST[t.status]) },
    { label: '', render: (t) => (t.status === 'open' && canWrite ? `<button ${BTN} data-cdv="${t.id}">Review</button>` : '') },
  ], rows: tx.transactions, empty: 'No transactions this month.' });
  table($('[data-cds]', el), { columns: [
    { label: 'Card', render: (s) => `${esc(s.card)} <span class="cell-sub">${esc(s.month)}</span>` },
    { label: 'Statement', num: true, render: (s) => esc(fmt.money(s.total, s.currency)) }, { label: 'Transactions', num: true, render: (s) => esc(fmt.money(s.transactions, s.currency)) },
    { label: 'Difference', num: true, render: (s) => (s.difference ? `<b style="color:var(--warn)">${esc(fmt.money(s.difference, s.currency))}</b>` : tag('t-ok', 'matches')) },
    { label: 'Paid', render: (s) => esc(s.paidOn ?? '—') },
  ], rows: d.statements, empty: 'No statements recorded.' });
  $('[data-cdm]', el).addEventListener('change', (e) => e.target.value && cardsSection(host, canWrite, e.target.value));
  $('[data-cdx]', el).addEventListener('click', () => fetchFile(`/v1/finance/cards/transactions?month=${mo}&format=xlsx`, `plugsure-card-transactions-${mo}.xlsx`));
  const ac = (accts.accounts ?? []).filter((a) => !a.archived);
  const cardForm = (c) => `<div class="form">${field('Holder', `<select name="h"><option value="">—</option>${ul.map((u) => `<option value="${esc(u.id)}"${c?.holderId === u.id ? ' selected' : ''}>${esc(u.name ?? u.email)}</option>`).join('')}</select>`, { opt: true })}${field('Name on the card', `<input name="n" maxlength="120" value="${esc(c?.holder ?? '')}">`)}${field('Bank', `<input name="b" maxlength="80" value="${esc(c?.bank ?? '')}">`)}${field('Last four digits', `<input name="l" maxlength="4" inputmode="numeric" value="${esc(c?.last4 ?? '')}">`)}${c ? '' : field('Currency', `<input name="c" maxlength="3" value="${esc(LEGACY_CURRENCY)}">`)}${field('Single transaction limit', `<input name="s" type="number" min="1" value="${c?.singleLimit ?? ''}">`, { opt: true })}${field('Monthly limit', `<input name="m" type="number" min="1" value="${c?.monthlyLimit ?? ''}">`, { opt: true })}${c ? field('Status', `<select name="st">${['active', 'frozen', 'closed'].map((x) => `<option${x === c.status ? ' selected' : ''}>${x}</option>`).join('')}</select>`) : ''}${field('Statement paid from', `<select name="a"><option value="">—</option>${ac.map((a) => `<option value="${a.id}"${c?.cashAccountId === a.id ? ' selected' : ''}>${esc(a.name)} (${esc(a.currency)})</option>`).join('')}</select>`, { opt: true })}</div>`;
  const cardBody = (mc, c) => { const v = (n) => $(`[name="${n}"]`, mc.el)?.value; return { holderId: v('h') || null, holderName: v('n'), bank: v('b'), last4: v('l'), ...(c ? { status: v('st') } : { currency: (v('c') || '').toUpperCase() }), singleLimit: v('s') || null, monthlyLimit: v('m') || null, cashAccountId: v('a') || null }; };
  $('[data-cdn]', el)?.addEventListener('click', () => modal({ title: 'Add a corporate card', body: cardForm(null), actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', async onClick(mc) { try { await api('/v1/finance/cards', { method: 'POST', body: cardBody(mc, null) }); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] }));
  el.querySelectorAll('[data-cde]').forEach((b) => b.addEventListener('click', () => { const c = d.cards.find((x) => x.id === b.dataset.cde); modal({ title: `Card ${c.masked}`, body: cardForm(c), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) { try { await api(`/v1/finance/cards/${c.id}`, { method: 'PUT', body: cardBody(mc, c) }); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] }); }));
  $('[data-cdp]', el)?.addEventListener('click', () => modal({ title: 'Card spend policy', body: `<div class="form">${field('Receipt needed from', `<input name="r" type="number" min="0" value="${d.policy.receiptAbove}">`)}${field('Flag weekend spending', `<select name="w"><option value="true"${d.policy.weekendFlag ? ' selected' : ''}>Yes</option><option value="false"${d.policy.weekendFlag ? '' : ' selected'}>No</option></select>`)}${field('Blocked categories', `<select name="c" multiple size="5">${CARD_CAT.map((x) => `<option${d.policy.blockedCategories.includes(x) ? ' selected' : ''}>${x}</option>`).join('')}</select>`, { opt: true })}${field('Blocked merchants (comma-separated, part of the name)', `<input name="m" value="${esc(d.policy.blockedMerchants.join(', '))}">`, { opt: true })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) { try { await api('/v1/finance/cards/policy', { method: 'PUT', body: { receiptAbove: Number($('[name="r"]', mc.el).value), weekendFlag: $('[name="w"]', mc.el).value === 'true', blockedCategories: [...$('[name="c"]', mc.el).selectedOptions].map((o) => o.value), blockedMerchants: $('[name="m"]', mc.el).value.split(',').map((x) => x.trim()).filter(Boolean) } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] }));
  el.querySelectorAll('[data-cdi]').forEach((inp) => inp.addEventListener('change', async () => { const f = inp.files?.[0]; if (!f) return; try { const r = await api(`/v1/finance/cards/${inp.dataset.cdi}/import`, { method: 'POST', body: { csv: await f.text() } }); toast(`Imported ${r.added}, skipped ${r.skipped} already there${r.errors.length ? `; ${r.errors.length} line(s) not read` : ''}.`, r.errors.length ? 'warn' : 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); } }));
  el.querySelectorAll('[data-cdr]').forEach((inp) => inp.addEventListener('change', async () => { const f = inp.files?.[0]; if (!f) return; try { await api(`/v1/finance/cards/transactions/${inp.dataset.cdr}/receipt`, { method: 'PUT', body: { filename: f.name, mime: f.type, data: await fileB64(f) } }); toast('Attached.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); } }));
  el.querySelectorAll('[data-cdv]').forEach((b) => b.addEventListener('click', () => { const t = tx.transactions.find((x) => x.id === b.dataset.cdv); modal({ title: `${t.merchant} · ${fmt.money(t.amount, t.currency)}`, body: `${t.flags.length ? callout('warn', `Flagged: ${t.flags.map((f) => FLAG_L[f] ?? f).join(', ')}. A Finance Manager approves it, with a note.`) : ''}<div class="form">${field('Category', `<select name="c">${CARD_CAT.map((x) => `<option${x === t.category ? ' selected' : ''}>${x}</option>`).join('')}</select>`)}${field('Note', '<input name="n" maxlength="300">', { opt: !t.flags.length })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Personal (owed back)', async onClick(mc) { try { await api(`/v1/finance/cards/transactions/${t.id}/review`, { method: 'POST', body: { action: 'reject', category: $('[name="c"]', mc.el).value, note: $('[name="n"]', mc.el).value } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }, { label: 'Approve', kind: 'primary', async onClick(mc) { try { await api(`/v1/finance/cards/transactions/${t.id}/review`, { method: 'POST', body: { action: 'approve', category: $('[name="c"]', mc.el).value, note: $('[name="n"]', mc.el).value } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] }); }));
  el.querySelectorAll('[data-cdst]').forEach((b) => b.addEventListener('click', () => { const c = d.cards.find((x) => x.id === b.dataset.cdst); modal({ title: `Statement · ${c.masked}`, body: `<div class="form">${field('Month', `<input name="m" type="month" value="${esc(mo)}">`)}${field("The statement's total", '<input name="t" type="number">')}${field('Paid on', '<input name="p" type="date">', { opt: true })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value; try { const s = await api(`/v1/finance/cards/${c.id}/statements`, { method: 'PUT', body: { month: v('m'), total: Number(v('t')), paidOn: v('p') || undefined } }); toast(s.difference ? `Differs from the transactions by ${fmt.money(s.difference, c.currency)}` : 'Matches the transactions', s.difference ? 'warn' : 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] }); }));
}

// ─────────────────────────────────────────── (v1.40.0) customer contracts

const CT_ST = { draft: ['t-mute', 'draft'], active: ['t-ok', 'active'], ended: ['t-mute', 'ended'], cancelled: ['t-crit', 'cancelled'] };

async function contractsSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d, accts;
  try { [d, accts] = await Promise.all([api('/v1/finance/contracts'), api('/v1/finance/cash/accounts').catch(() => ({ accounts: [] }))]); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => contractsSection(host, canWrite);
  const t0 = Object.entries(d.totals)[0];
  const m = (v, c) => esc(fmt.money(v, c));
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-ctn>${icon('plus')} New contract</button>` : ''}<button class="btn" type="button" data-ctxl>${icon('download')} Excel</button></div>
    ${callout('info', 'Contracts beyond pay-per-charge (a fleet\'s charging-as-a-service, a site with hardware and a service plan), recognised under PSAK 72: each obligation ratably over its months or when delivered. Billed ahead is a contract liability (deferred revenue); recognised ahead, a contract asset. The ledger\'s contracts journal books both.')}
    <div class="grid k4 section">${t0 ? `${kpi(`Contract value · ${esc(t0[0])}`, m(t0[1].value, t0[0]), `${t0[1].active} active`)}${kpi('Recognised', m(t0[1].recognised, t0[0]), `remaining ${m(t0[1].remaining, t0[0])}`)}${kpi('Contract liability', m(t0[1].contractLiability, t0[0]), `asset ${m(t0[1].contractAsset, t0[0])}`)}${kpi('Renewals due', String(d.renewalsDue), 'within their notice', d.renewalsDue ? 'warn' : '')}` : kpi('Contracts', '0', 'none yet')}</div>
    <div class="card section"><header><h3>Contracts</h3></header><div data-ctl></div></div>`;
  table($('[data-ctl]', el), { columns: [
    { label: 'Contract', render: (c) => `<b class="mono">${esc(c.number)}</b> ${esc(c.customer)}<div class="cell-sub">${esc(c.startOn)} – ${esc(c.endOn)}${c.renewalDue ? ` · ${tag('t-warn', `renewal: ${c.daysToEnd} days`)}` : ''}</div>` },
    { label: 'Value', num: true, render: (c) => m(c.value, c.currency) },
    { label: 'Recognised', num: true, render: (c) => `${m(c.recognised, c.currency)}<div class="cell-sub">${c.value ? Math.round((c.recognised / c.value) * 100) : 0}%</div>` },
    { label: 'Billed / paid', num: true, render: (c) => `${m(c.billed, c.currency)}<div class="cell-sub">paid ${m(c.paid, c.currency)}</div>` },
    { label: 'Deferred / accrued', num: true, render: (c) => (c.contractLiability ? `${m(c.contractLiability, c.currency)}<div class="cell-sub">liability</div>` : c.contractAsset ? `${m(c.contractAsset, c.currency)}<div class="cell-sub">asset</div>` : '—') },
    { label: 'Status', render: (c) => tag(...CT_ST[c.status]) },
    { label: '', render: (c) => `<button ${BTN} data-cto="${c.id}">Open</button>` },
  ], rows: d.contracts, empty: 'No contracts yet.' });
  $('[data-ctxl]', el).addEventListener('click', () => fetchFile('/v1/finance/contracts?format=xlsx', 'plugsure-contracts.xlsx'));
  $('[data-ctn]', el)?.addEventListener('click', () => modal({ title: 'New contract', body: `<div class="form">${field('Customer', '<input name="c" maxlength="160">')}${field('Currency', `<input name="cu" maxlength="3" value="${esc(LEGACY_CURRENCY)}">`)}${field('Start', `<input name="s" type="date" value="${zonedYmd()}">`)}${field('End', '<input name="e" type="date">')}${field('Subscription or service (ratably)', '<input name="sub" type="number" min="0" placeholder="its share of the price">', { opt: true })}${field('Hardware or installation (when delivered)', '<input name="hw" type="number" min="0">', { opt: true })}${field('Renewal notice (days)', '<input name="n" type="number" min="0" max="365" value="60">')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Create', kind: 'primary', async onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value.trim(); const obligations = [v('sub') && { description: 'Charging service', kind: 'subscription', amount: Number(v('sub')), recognition: 'ratably' }, v('hw') && { description: 'Hardware', kind: 'hardware', amount: Number(v('hw')), recognition: 'point_in_time' }].filter(Boolean); try { const c = await api('/v1/finance/contracts', { method: 'POST', body: { customer: v('c'), currency: v('cu').toUpperCase(), startOn: v('s'), endOn: v('e'), renewalNoticeDays: Number(v('n')), obligations } }); reload(); open(c.id); } catch (err) { toast(err.message, 'crit'); return false; } } }] }));
  const banks = (accts.accounts ?? []).filter((a) => !a.archived);
  const open = async (id) => {
    let c;
    try { c = await api(`/v1/finance/contracts/${id}`); } catch (err) { toast(err.message, 'crit'); return; }
    const mm = (v) => esc(fmt.money(v, c.currency));
    drawer({ title: `${c.number} · ${c.customer}`, subtitle: esc(`${c.startOn} – ${c.endOn} · ${c.status}`), tabs: [
      { id: 'o', label: 'Obligations', render(body, ctx) {
        const act = async (fn) => { try { await fn(); ctx.close(); reload(); open(id); } catch (err) { toast(err.message, 'crit'); } };
        body.innerHTML = `<div class="grid k3">${kpi('Value', mm(c.value), `${c.obligations.length} obligation${c.obligations.length === 1 ? '' : 's'}`)}${kpi('Recognised', mm(c.recognised), `remaining ${mm(c.remaining)}`)}${kpi(c.contractAsset ? 'Contract asset' : 'Contract liability', mm(c.contractAsset || c.contractLiability), `billed ${mm(c.billed)}`)}</div><div data-ob></div>
          <div class="card section"><header><h3>Billings</h3></header><div data-bl></div></div>
          ${canWrite ? `<div class="row" style="gap:6px;margin-top:10px;flex-wrap:wrap"><button ${BTN} data-a="ob">Add obligation</button><button ${BTN} data-a="bill">Record billing</button>${c.status === 'active' ? `<button ${BTN} data-a="renew">Renew (extend)</button><button ${BTN} data-a="end">End</button>` : ''}</div>` : ''}`;
        table($('[data-ob]', body), { columns: [
          { label: 'Obligation', render: (o) => `<b>${esc(o.description)}</b> <span class="cell-sub">${esc(o.kind)}</span><div class="cell-sub">${o.recognition === 'ratably' ? `ratably ${esc(o.startMonth)} – ${esc(o.endMonth)}` : o.deliveredOn ? `delivered ${esc(o.deliveredOn)}` : 'when delivered'}</div>` },
          { label: 'Amount', num: true, render: (o) => mm(o.amount) },
          { label: '', render: (o) => (canWrite && o.recognition === 'point_in_time' && !o.deliveredOn ? `<button ${BTN} data-dl="${o.id}">Delivered</button>` : '') },
        ], rows: c.obligations, empty: 'No obligations: allocate the price to what is promised.' });
        table($('[data-bl]', body), { columns: [
          { label: 'Billed', render: (b) => `${esc(b.billedOn)}<div class="cell-sub">${esc(b.reference ?? '')}</div>` }, { label: 'Amount', num: true, render: (b) => mm(b.amount) },
          { label: 'Paid', render: (b) => (b.paidOn ? esc(b.paidOn) : canWrite ? `<button ${BTN} data-pd="${b.id}">Paid</button> <button ${BTN} data-bv="${b.id}">Void</button>` : '—') },
        ], rows: c.billings, empty: 'Nothing billed.' });
        $$('[data-dl]', body).forEach((b) => b.addEventListener('click', () => act(() => api(`/v1/finance/contracts/${id}/obligations/${b.dataset.dl}`, { method: 'PUT', body: { deliveredOn: zonedYmd() } }))));
        $$('[data-bv]', body).forEach((b) => b.addEventListener('click', () => act(() => api(`/v1/finance/contracts/${id}/billings/${b.dataset.bv}/void`, { method: 'POST' }))));
        $$('[data-pd]', body).forEach((b) => b.addEventListener('click', () => modal({ title: 'Billing paid', body: `<div class="form">${field('Paid on', `<input name="p" type="date" value="${zonedYmd()}">`)}${field('Into', `<select name="a">${banks.filter((a) => a.currency === c.currency).map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>`)}</div>`, actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) { await act(() => api(`/v1/finance/contracts/${id}/billings/${b.dataset.pd}/paid`, { method: 'POST', body: { paidOn: $('[name="p"]', mc.el).value, cashAccountId: $('[name="a"]', mc.el).value } })); } }] })));
        $$('[data-a]', body).forEach((b) => b.addEventListener('click', () => {
          const a = b.dataset.a;
          if (a === 'end') return act(() => api(`/v1/finance/contracts/${id}`, { method: 'PUT', body: { status: 'ended' } }));
          if (a === 'renew') return modal({ title: 'Renew the contract', body: `<div class="form">${field('New end', '<input name="e" type="date">')}</div>`, actions: [{ label: 'Cancel' }, { label: 'Renew', kind: 'primary', async onClick(mc) { await act(() => api(`/v1/finance/contracts/${id}`, { method: 'PUT', body: { endOn: $('[name="e"]', mc.el).value } })); } }] });
          if (a === 'bill') return modal({ title: 'Record a billing', body: `<div class="form">${field('Billed on', `<input name="d" type="date" value="${zonedYmd()}">`)}${field('Amount', '<input name="a" type="number" min="1">')}${field('Invoice number', '<input name="r" maxlength="80">', { opt: true })}</div>`, actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', async onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value; await act(() => api(`/v1/finance/contracts/${id}/billings`, { method: 'POST', body: { billedOn: v('d'), amount: Number(v('a')), reference: v('r') || undefined } })); } }] });
          modal({ title: 'Add an obligation', body: `<div class="form">${field('Description', '<input name="d" maxlength="300">')}${field('Kind', `<select name="k">${['subscription', 'service', 'hardware', 'installation', 'other'].map((x) => `<option>${x}</option>`).join('')}</select>`)}${field('Share of the price', '<input name="a" type="number" min="0">')}${field('Recognised', '<select name="r"><option value="ratably">Ratably over months</option><option value="point_in_time">When delivered</option></select>')}${field('From month', `<input name="s" type="month" value="${esc(c.startOn.slice(0, 7))}">`, { opt: true })}${field('To month', `<input name="e" type="month" value="${esc(c.endOn.slice(0, 7))}">`, { opt: true })}</div>`,
            actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', async onClick(mc) { const v = (n) => $(`[name="${n}"]`, mc.el).value; await act(() => api(`/v1/finance/contracts/${id}/obligations`, { method: 'POST', body: { description: v('d'), kind: v('k'), amount: Number(v('a')), recognition: v('r'), startMonth: v('r') === 'ratably' ? v('s') : undefined, endMonth: v('r') === 'ratably' ? v('e') : undefined } })); } }] });
        }));
      } },
      { id: 's', label: 'Schedule', render(body) { table(body, { columns: [
        { label: 'Month', render: (x) => esc(x.month) }, { label: 'Recognised', num: true, render: (x) => mm(x.recognised) }, { label: 'Billed', num: true, render: (x) => (x.billed ? mm(x.billed) : '—') },
        { label: 'Liability', num: true, render: (x) => (x.contractLiability ? mm(x.contractLiability) : '—') }, { label: 'Asset', num: true, render: (x) => (x.contractAsset ? mm(x.contractAsset) : '—') },
      ], rows: c.schedule, empty: '' }); } },
    ] });
  };
  el.querySelectorAll('[data-cto]').forEach((b) => b.addEventListener('click', () => open(b.dataset.cto)));
}

// ─────────────────────────────────────────── (v1.40.0) intercompany netting and transfer pricing

const TP_ST = { ok: ['t-ok', 'in range'], below: ['t-warn', 'below range'], above: ['t-warn', 'above range'], no_cost: ['t-warn', 'no cost'], unclassified: ['t-mute', 'unclassified'] };
const TP_KIND = ['management_fee', 'shared_services', 'it_services', 'energy_resale', 'equipment_rental', 'other'];

async function nettingSection(host, canWrite, year) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  const y = year ?? new Date().getFullYear();
  let n, tp;
  try { [n, tp] = await Promise.all([api('/v1/finance/intercompany/netting'), api(`/v1/finance/intercompany/transfer-pricing?year=${y}`)]); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => nettingSection(host, canWrite, y);
  const canNet = state.can('finance:approve') && n.group.find((g) => g.me)?.parent;
  el.innerHTML = `${n.group.length < 2 ? callout('info', 'This organisation has no group entities: netting and transfer pricing apply to a parent and its subsidiaries (Finance → Group).') : callout('info', `Recharges between ${esc(n.group.map((g) => g.name).join(', '))}, netted through ${esc(n.parent)} as the netting centre: each entity pays or receives its net once, instead of every pair settling.`)}
    <div data-nc></div>
    <div class="filters" style="margin-top:12px">${field('Transfer pricing · year', `<select data-tpy>${[0, 1, 2].map((k) => `<option${y === new Date().getFullYear() - k ? ' selected' : ''}>${new Date().getFullYear() - k}</option>`).join('')}</select>`)}<div class="row" style="align-self:flex-end;gap:6px">${tp.canEdit && canWrite ? `<button class="btn" type="button" data-tpp>Policy</button>` : ''}<button class="btn" type="button" data-tpx>${icon('download')} Workpaper</button></div></div>
    <div class="grid k4 section">${kpi('Recharges', String(tp.summary.total), `${y}`)}${kpi('In range', String(tp.summary.ok), 'of the policy')}${kpi('Out of range', String(tp.summary.below + tp.summary.above), `${tp.summary.noCost} without a cost`, tp.summary.below + tp.summary.above ? 'warn' : '')}${kpi('Unclassified', String(tp.summary.unclassified), 'no kind or no policy', tp.summary.unclassified ? 'warn' : '')}</div>
    <div class="card section"><header><h3>Policy</h3></header><div data-tpl></div></div>
    <div class="card section"><header><h3>Recharges against the policy</h3></header><div data-tpi></div></div>`;
  const nc = $('[data-nc]', el);
  nc.innerHTML = n.currencies.map((c, i) => `<div class="card section"><header><h3>Open recharges · ${esc(c.currency)}</h3>${canNet && canWrite ? `<button class="btn sm right" type="button" data-nset="${esc(c.currency)}">Settle the netting</button>` : ''}</header><div class="body"><div class="grid k3">${kpi('Gross', esc(fmt.money(c.gross, c.currency)), `${c.bilateral.reduce((a, b) => a + b.recharges, 0)} recharges`)}${kpi('Transfers', `${c.transfers.length}`, `instead of ${c.bilateralTransfers} between pairs`)}${kpi('Settled by netting', esc(fmt.money(c.settledByNetting, c.currency)), 'no cash moves')}</div></div><div data-np="${i}"></div><div data-nt="${i}"></div></div>`).join('') || '<p class="cell-sub">Nothing issued and open between the group\'s entities.</p>';
  n.currencies.forEach((c, i) => {
    table($(`[data-np="${i}"]`, nc), { columns: [{ label: 'Entity', render: (p) => esc(p.name) }, { label: 'Net position', num: true, render: (p) => `${esc(fmt.money(p.net, c.currency))}<div class="cell-sub">${p.net > 0 ? 'receives' : p.net < 0 ? 'pays' : 'even'}</div>` }], rows: c.positions, empty: '' });
    table($(`[data-nt="${i}"]`, nc), { columns: [{ label: 'Transfer', render: (t) => `${esc(t.fromName)} → ${esc(t.toName)}` }, { label: 'Amount', num: true, render: (t) => esc(fmt.money(t.amount, c.currency)) }], rows: c.transfers, empty: 'Nets to zero.' });
  });
  table($('[data-tpl]', el), { columns: [
    { label: 'Kind', render: (p) => esc(p.kind.replace(/_/g, ' ')) }, { label: 'Method', render: (p) => esc(p.method.replace('_', ' ')) },
    { label: 'Mark-up', num: true, render: (p) => (p.method === 'cost_plus' ? `${p.markupPct}%<div class="cell-sub">${p.minPct}–${p.maxPct}%</div>` : '—') }, { label: 'Note', render: (p) => esc(p.note ?? '') },
  ], rows: tp.policies, empty: 'No policy yet.' });
  table($('[data-tpi]', el), { columns: [
    { label: 'Recharge', render: (i) => `<span class="mono">${esc(i.number)}</span> ${esc(i.from)} → ${esc(i.to)}<div class="cell-sub">${esc(i.month)} · ${esc(i.description)}</div>` },
    { label: 'Amount', num: true, render: (i) => `${esc(fmt.money(i.amount, i.currency))}${i.cost != null ? `<div class="cell-sub">cost ${esc(fmt.money(i.cost, i.currency))}</div>` : ''}` },
    { label: 'Kind', render: (i) => `${esc((i.tpKind ?? '—').replace(/_/g, ' '))}${i.markupPct != null ? `<div class="cell-sub">${i.markupPct}%${i.range ? ` (${i.range[0]}–${i.range[1]}%)` : ''}</div>` : ''}` },
    { label: 'Check', render: (i) => tag(...TP_ST[i.status]) },
    { label: '', render: (i) => (i.mine && canWrite ? `<button ${BTN} data-tpc="${i.id}">Classify</button>` : '') },
  ], rows: tp.items, empty: 'No recharges this year.' });
  $('[data-tpy]', el).addEventListener('change', (e) => nettingSection(host, canWrite, Number(e.target.value)));
  $('[data-tpx]', el).addEventListener('click', () => fetchFile(`/v1/finance/intercompany/transfer-pricing?year=${y}&format=xlsx`, `plugsure-transfer-pricing-${y}.xlsx`));
  el.querySelectorAll('[data-nset]').forEach((b) => b.addEventListener('click', async () => { try { const r = await api('/v1/finance/intercompany/netting/settle', { method: 'POST', body: { currency: b.dataset.nset } }); toast(`${r.settlements.length} pair(s) settled`, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); } }));
  $('[data-tpp]', el)?.addEventListener('click', () => modal({ title: 'Transfer-pricing policy', body: `<div class="form">${field('Kind', `<select name="k">${TP_KIND.map((k) => `<option value="${k}">${k.replace(/_/g, ' ')}</option>`).join('')}</select>`)}${field('Method', '<select name="m"><option value="cost_plus">Cost plus</option><option value="pass_through">Pass-through at cost</option><option value="cup">Comparable uncontrolled price</option></select>')}${field('Mark-up %', '<input name="p" type="number" step="0.1" value="5">')}${field('Range from %', '<input name="lo" type="number" step="0.1" value="3">')}${field('Range to %', '<input name="hi" type="number" step="0.1" value="8">')}${field('Note (benchmark)', '<input name="n" maxlength="500">', { opt: true })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) { const v = (x) => $(`[name="${x}"]`, mc.el).value; try { await api('/v1/finance/intercompany/transfer-pricing/policies', { method: 'PUT', body: { kind: v('k'), method: v('m'), markupPct: Number(v('p')), minPct: Number(v('lo')), maxPct: Number(v('hi')), note: v('n') || undefined } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] }));
  el.querySelectorAll('[data-tpc]').forEach((b) => b.addEventListener('click', () => modal({ title: 'Classify the recharge', body: `<div class="form">${field('Kind', `<select name="k">${TP_KIND.map((k) => `<option value="${k}">${k.replace(/_/g, ' ')}</option>`).join('')}</select>`)}${field('Cost underneath', '<input name="c" type="number" min="0">', { opt: true })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) { try { await api(`/v1/finance/intercompany/recharges/${b.dataset.tpc}/tp`, { method: 'PUT', body: { tpKind: $('[name="k"]', mc.el).value, cost: $('[name="c"]', mc.el).value || null } }); reload(); } catch (err) { toast(err.message, 'crit'); return false; } } }] })));
}

// ─────────────────────────────────────────── (v1.40.0) data quality

const DQ_SEV = { critical: 't-crit', warning: 't-warn', info: 't-info' };

async function dataQualitySection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api('/v1/finance/data-quality'); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = () => dataQualitySection(host, canWrite);
  const l = d.last;
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-dqr>${icon('refresh')} Run the checks</button>` : ''}</div>
    ${callout('info', `Checks on the ledger (entries that do not balance, accounts outside the chart, postings after a lock, old drafts), the masters (duplicate or incomplete suppliers, fleet accounts without a tax id), site costs without a site and stale bank balances. Run daily; under ${d.threshold} raises an alert. Every record's change history is in the audit trail (open a finding).`)}
    <div class="grid k3 section">${kpi('Data quality', l ? `${l.score} / 100` : '—', l ? esc(fmt.time(l.runAt)) : 'not run yet', l && l.score < d.threshold ? 'crit' : l && l.score < 90 ? 'warn' : 'ok')}${kpi('Findings', l ? String(l.findings.length) : '—', l ? `${l.findings.filter((f) => f.severity === 'critical').length} critical` : '')}${kpi('Trend', d.trend.length > 1 ? `${d.trend.at(-1).score - d.trend.at(-2).score >= 0 ? '+' : ''}${d.trend.at(-1).score - d.trend.at(-2).score}` : '—', 'since the run before')}</div>
    <div class="card section"><header><h3>By check</h3></header><div data-dqc></div></div>
    <div class="card section"><header><h3>Findings</h3></header><div data-dqf></div></div>`;
  table($('[data-dqc]', el), { columns: [
    { label: 'Check', render: (k) => `<b>${esc(k.label)}</b>` }, { label: 'Found', num: true, render: (k) => String(k.n) },
    { label: 'Points lost', num: true, render: (k) => (k.n ? `−${Math.min(k.cap, k.each * k.n)}` : '—') + `<div class="cell-sub">${k.each} each, at most ${k.cap}</div>` },
  ], rows: Object.entries(d.weights).map(([k, w]) => ({ ...w, n: l?.counts?.[k] ?? 0 })), empty: '' });
  table($('[data-dqf]', el), { columns: [
    { label: 'Finding', render: (f) => `${tag(DQ_SEV[f.severity], f.label)}<div>${esc(f.message)}</div>` },
    { label: 'Record', render: (f) => `<span class="cell-sub">${esc(f.targetType)}</span> <span class="mono">${esc(f.targetId)}</span>` },
    { label: '', render: (f) => `<button ${BTN} data-dqh="${esc(f.targetType)}|${esc(f.targetId)}">History</button>` },
  ], rows: l?.findings ?? [], empty: l ? 'Nothing found.' : 'Run the checks.' });
  $('[data-dqr]', el)?.addEventListener('click', async (e) => { e.target.disabled = true; try { const r = await api('/v1/finance/data-quality/run', { method: 'POST' }); toast(`Score ${r.score}/100`, r.score < d.threshold ? 'warn' : 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); e.target.disabled = false; } });
  el.querySelectorAll('[data-dqh]').forEach((b) => b.addEventListener('click', async () => {
    const [t, i] = b.dataset.dqh.split('|');
    let h; try { h = await api(`/v1/finance/history?targetType=${encodeURIComponent(t)}&targetId=${encodeURIComponent(i)}`); } catch (err) { toast(err.message, 'crit'); return; }
    drawer({ title: `History · ${t} ${i}`, subtitle: `${h.changes.length} change(s) in the audit trail`, tabs: [{ id: 'h', label: 'Changes', render(body) { table(body, { columns: [
      { label: 'When', render: (c) => esc(fmt.time(c.at)) }, { label: 'What', render: (c) => `<b>${esc(c.action)}</b><div class="cell-sub">${esc(c.by)}</div>` },
      { label: 'Change', render: (c) => `<div class="cell-sub mono" style="white-space:pre-wrap;max-width:420px">${esc(JSON.stringify(c.after ?? c.before ?? {}).slice(0, 400))}</div>` },
    ], rows: h.changes, empty: 'No changes recorded for this record.' }); } }] });
  }));
}

// ─────────────────────────────────────────── (v1.40.0) scenarios

async function scenariosSection(host, canWrite, focus) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api(`/v1/finance/scenarios${focus ? `?sensitivityOf=${focus}` : ''}`); } catch (err) { el.innerHTML = callout('crit', esc(err.message)); return; }
  const reload = (f = focus) => scenariosSection(host, canWrite, f);
  const c = d.currency, m = (v) => esc(fmt.money(v, c));
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-scn>${icon('plus')} New scenario</button>` : ''}<button class="btn" type="button" data-scx>${icon('download')} Excel</button></div>
    ${callout('info', `What-if on the next twelve months, from the rolling forecast held flat, running costs at ${m(d.base.opexPerMonth)} a month, cash today ${m(d.base.cash)} and debt service ${m(d.base.debtServicePerMonth)} a month. Each scenario changes the tariff, utilisation, energy price or running costs, or adds sites with their capex and ramp; covenants (Lenders) are tested on its EBITDA and lowest cash.`)}
    <div class="card section"><header><h3>Side by side</h3></header><div data-scc></div></div>
    <div class="card section"><header><h3>Sensitivity · ${esc(d.sensitivity.of)}</h3></header><div class="body cell-sub">Twelve-month EBITDA when each driver moves ${d.sensitivity.drivers[0]?.step ?? 10} points.</div><div data-scs></div></div>`;
  table($('[data-scc]', el), { columns: [
    { label: 'Scenario', render: (s) => `<b>${esc(s.name)}</b><div class="cell-sub">${s.id ? esc([s.assumptions.tariffPct && `tariff ${s.assumptions.tariffPct > 0 ? '+' : ''}${s.assumptions.tariffPct}%`, s.assumptions.utilisationPct && `use ${s.assumptions.utilisationPct > 0 ? '+' : ''}${s.assumptions.utilisationPct}%`, s.assumptions.energyPricePct && `energy ${s.assumptions.energyPricePct > 0 ? '+' : ''}${s.assumptions.energyPricePct}%`, s.assumptions.opexPct && `costs ${s.assumptions.opexPct > 0 ? '+' : ''}${s.assumptions.opexPct}%`, s.assumptions.newSites.length && `${s.assumptions.newSites.reduce((a, x) => a + x.count, 0)} new sites`].filter(Boolean).join(' · ')) : 'the forecast as it stands'}</div>` },
    { label: 'Revenue', num: true, render: (s) => m(s.totals.revenue) },
    { label: 'EBITDA', num: true, render: (s) => `${m(s.totals.ebitda)}${s.totals.marginPct != null ? `<div class="cell-sub">${s.totals.marginPct}%</div>` : ''}` },
    { label: 'Capex', num: true, render: (s) => (s.totals.capex ? m(s.totals.capex) : '—') },
    { label: 'Lowest cash', num: true, render: (s) => `${s.minCash < 0 ? `<b style="color:var(--crit)">${m(s.minCash)}</b>` : m(s.minCash)}<div class="cell-sub">${esc(s.minCashMonth ?? '')}${s.runwayMonths != null ? ` · runs out in month ${s.runwayMonths + 1}` : ''}</div>` },
    { label: 'Covenants', render: (s) => (s.covenants.length ? s.covenants.map((x) => tag(x.passed === false ? 't-crit' : x.passed ? 't-ok' : 't-mute', `${x.kind.replace('_', ' ')}${x.passed === false ? ' fails' : ''}`)).join(' ') : '<span class="cell-sub">none</span>') },
    { label: '', render: (s) => (s.id ? `<button ${BTN} data-scf="${s.id}">Sensitivity</button>${canWrite ? ` <button ${BTN} data-sca="${s.id}">Archive</button>` : ''}` : '') },
  ], rows: d.scenarios, empty: '' });
  table($('[data-scs]', el), { columns: [
    { label: 'Driver', render: (x) => esc(x.label) }, { label: `−${x0(d)} points`, num: true, render: (x) => m(x.down) }, { label: `+${x0(d)} points`, num: true, render: (x) => m(x.up) },
  ], rows: d.sensitivity.drivers, empty: '' });
  $('[data-scx]', el).addEventListener('click', () => fetchFile('/v1/finance/scenarios?format=xlsx', 'plugsure-scenarios.xlsx'));
  el.querySelectorAll('[data-scf]').forEach((b) => b.addEventListener('click', () => reload(b.dataset.scf)));
  el.querySelectorAll('[data-sca]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/v1/finance/scenarios/${b.dataset.sca}`, { method: 'PUT', body: { archive: true } }); reload(null); } catch (err) { toast(err.message, 'crit'); } }));
  $('[data-scn]', el)?.addEventListener('click', () => modal({ title: 'New scenario', body: `<div class="form">${field('Name', '<input name="n" maxlength="80">')}${field('Tariff %', '<input name="t" type="number" step="0.5" value="0">')}${field('Utilisation %', '<input name="u" type="number" step="0.5" value="0">')}${field('Energy price %', '<input name="e" type="number" step="0.5" value="0">')}${field('Running costs %', '<input name="o" type="number" step="0.5" value="0">')}${field('New sites from', `<input name="sm" type="month" value="${esc(zonedYmd().slice(0, 7))}">`, { opt: true })}${field('How many', '<input name="sc" type="number" min="0" value="0">', { opt: true })}${field('Capex per site', '<input name="sx" type="number" min="0">', { opt: true })}${field('Revenue per site a month (mature)', '<input name="sr" type="number" min="0">', { opt: true })}${field('Running costs per site a month', '<input name="so" type="number" min="0">', { opt: true })}${field('Months to mature', '<input name="sp" type="number" min="1" max="36" value="6">', { opt: true })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) { const v = (x) => $(`[name="${x}"]`, mc.el).value; const count = Number(v('sc') || 0); try { const s = await api('/v1/finance/scenarios', { method: 'POST', body: { name: v('n'), assumptions: { tariffPct: Number(v('t')), utilisationPct: Number(v('u')), energyPricePct: Number(v('e')), opexPct: Number(v('o')), newSites: count ? [{ fromMonth: v('sm'), count, capexPerSite: Number(v('sx') || 0), revenuePerSiteMonth: Number(v('sr') || 0), opexPerSiteMonth: Number(v('so') || 0), rampMonths: Number(v('sp') || 6) }] : [] } } }); reload(s.id); } catch (err) { toast(err.message, 'crit'); return false; } } }] }));
}
const x0 = (d) => d.sensitivity.drivers[0]?.step ?? 10;

// ─────────────────────────────────────────── (v1.30.0) purchase orders

const PO_ST = { draft: ['t-mute', 'draft'], awaiting_approval: ['t-warn', 'awaiting approval'], approved: ['t-info', 'approved'], closed: ['t-ok', 'closed'], cancelled: ['t-mute', 'cancelled'], rejected: ['t-crit', 'rejected'] };

async function ordersSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d, sups;
  try { [d, sups] = await Promise.all([api('/v1/finance/purchase-orders'), api('/v1/finance/suppliers')]); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = () => ordersSection(host, canWrite);
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-pnew>${icon('plus')} Raise an order</button>` : ''}<button class="btn" type="button" data-px>${icon('download')} Excel</button></div>
    ${callout('info', `Bills on an order are matched three ways: ordered, received and billed (tolerance ${d.settings.tolerancePct}%). A bill above what was received needs a Finance Manager.`)}
    ${d.commitments.length ? `<div class="grid k4 section">${d.commitments.map((c) => kpi(`Committed · ${c.currency}`, esc(fmt.money(c.total, c.currency)), `${c.suppliers.length} supplier${c.suppliers.length === 1 ? '' : 's'}, approved not billed`)).join('')}</div>` : ''}
    <div class="card section"><header><h3>Purchase orders</h3></header><div data-pl></div></div>`;
  table($('[data-pl]', el), { columns: [
    { label: 'Order', render: (o) => `<b>${esc(o.number)}</b> · ${esc(o.supplier)}<div class="cell-sub">${esc(o.description)}${o.site ? ` · ${esc(o.site)}` : ''}</div>` },
    { label: 'Ordered', num: true, render: (o) => esc(fmt.money(o.ordered, o.currency)) },
    { label: 'Received', num: true, render: (o) => `${esc(fmt.money(o.received, o.currency))}<div class="cell-sub">${o.receivedPct}%</div>` },
    { label: 'Billed', num: true, render: (o) => `${esc(fmt.money(o.billed, o.currency))}${o.bills ? `<div class="cell-sub">${o.bills} bill${o.bills === 1 ? '' : 's'}</div>` : ''}` },
    { label: 'Status', render: (o) => `${tag(...(PO_ST[o.status] ?? ['t-mute', o.status]))}${o.firstApprovedBy && o.status === 'awaiting_approval' ? `<div class="cell-sub">1st: ${esc(o.firstApprovedBy)}</div>` : ''}` },
    { label: '', render: (o) => `<button ${BTN} data-popen="${esc(o.id)}">Open</button>` },
  ], rows: d.orders, empty: 'No purchase orders yet.' });
  const post = async (url, body, msg) => { try { const r = await api(url, { method: 'POST', body }); toast(r.waitingForSecondApprover ? 'First approval recorded: a second approver is needed.' : msg, 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; } };
  el.querySelectorAll('[data-popen]').forEach((b) => b.addEventListener('click', async () => {
    let o;
    try { o = await api(`/v1/finance/purchase-orders/${b.dataset.popen}`); } catch (e) { toast(e.message, 'crit'); return; }
    const M = { matched: ['t-ok', 'matched'], not_received: ['t-warn', 'nothing received'], over_billed: ['t-crit', 'billed above received'], over_ordered: ['t-crit', 'billed above ordered'] };
    drawer({ title: `${o.number} · ${o.supplier}`, subtitle: esc(o.description), tabs: [{ id: 'po', label: 'Order', render(bodyEl, ctx) {
      bodyEl.innerHTML = `<div class="grid k4 section">${kpi('Ordered', esc(fmt.money(o.ordered, o.currency)))}${kpi('Received', esc(fmt.money(o.received, o.currency)))}${kpi('Billed', esc(fmt.money(o.billed, o.currency)))}<div>${o.bills ? tag(...M[o.match.status]) : ''}</div></div>
      <div data-plines></div>
      ${o.receipts.length ? `<div class="cell-sub" style="margin-top:8px">${o.receipts.map((g) => `${esc(g.receivedOn)}: ${g.quantity} × ${esc(g.description)}${g.note ? ` (${esc(g.note)})` : ''}${g.recordedBy ? ` · ${esc(g.recordedBy)}` : ''}`).join('<br>')}</div>` : ''}
      ${o.billsOnOrder.length ? `<div class="cell-sub" style="margin-top:8px">Bills: ${o.billsOnOrder.map((x) => `${esc(x.number)} (${esc(x.status)}, ${esc(fmt.money(x.subtotal, o.currency))})`).join(', ')}</div>` : ''}
      <div class="row" style="gap:6px;margin-top:12px;flex-wrap:wrap">${!canWrite ? '' : o.status === 'awaiting_approval' ? `<button ${BTN} data-pa="approve">Approve</button><button ${BTN} data-pa="reject">Reject</button>`
        : o.status === 'approved' ? `<button ${BTN} data-prec>Record received</button><button ${BTN} data-pa="close">Close</button>${o.received ? '' : `<button ${BTN} data-pa="cancel">Cancel</button>`}` : o.status === 'draft' || o.status === 'rejected' ? `<button ${BTN} data-pa="submit">Submit</button><button ${BTN} data-pa="cancel">Cancel</button>` : ''}</div>`;
        const recv = canWrite && o.status === 'approved';
        table($('[data-plines]', bodyEl), { columns: [
          { label: 'Line', render: (l) => `${esc(l.description)}<div class="cell-sub">${esc(fmt.money(l.unitPrice, o.currency))} each</div>` },
          { label: 'Qty', num: true, render: (l) => String(l.quantity) },
          { label: 'Received', num: true, render: (l) => String(l.received) },
          { label: 'Amount', num: true, render: (l) => esc(fmt.money(l.amount, o.currency)) },
          ...(recv ? [{ label: 'Receive', num: true, render: (l) => (l.outstanding ? `<input data-rq="${esc(l.id)}" type="number" min="0" max="${l.outstanding}" step="any" style="width:80px" value="0">` : '') }] : []),
        ], rows: o.lines });
        $$('[data-pa]', bodyEl).forEach((x) => x.addEventListener('click', () => {
          const how = x.dataset.pa;
          if (how === 'approve' || how === 'submit') { ctx.close(); post(`/v1/finance/purchase-orders/${o.id}/${how}`, undefined, how === 'approve' ? 'Approved.' : 'Submitted.'); return; }
          const reason = window.prompt(`Why (${how})?`);
          if (reason && reason.trim()) { ctx.close(); post(`/v1/finance/purchase-orders/${o.id}/${how}`, { reason: reason.trim() }, 'Done.'); }
        }));
        $('[data-prec]', bodyEl)?.addEventListener('click', () => {
          const lines = $$('[data-rq]', bodyEl).map((i) => ({ lineId: i.dataset.rq, quantity: Number(i.value) })).filter((x) => x.quantity > 0);
          if (!lines.length) { toast('Enter the quantities received.', 'warn'); return; }
          ctx.close(); post(`/v1/finance/purchase-orders/${o.id}/receipts`, { lines }, 'Received.');
        });
      } }] });
  }));
  $('[data-px]', el).addEventListener('click', async () => { try { const res = await api('/v1/finance/purchase-orders?format=xlsx', { raw: true }); download('plugsure-purchase-orders.xlsx', await res.blob()); } catch (e) { toast(e.message, 'crit'); } });
  $('[data-pnew]', el)?.addEventListener('click', async () => {
    if (!sups.suppliers.length) { toast('Add a supplier first (Bills).', 'warn'); return; }
    const ss = await sitesList();
    const lineRow = () => `<div class="row" data-ln style="gap:6px;margin-bottom:6px"><input name="ld" placeholder="Description" style="flex:2"><input name="lq" type="number" step="any" min="0" value="1" style="width:80px"><input name="lp" type="number" min="0" placeholder="Unit price" style="width:140px"></div>`;
    modal({ title: 'Raise a purchase order', subtitle: 'Prices in the minor unit, before PPN', body: `<div class="form">${field('Supplier', `<select name="sup">${sups.suppliers.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>`)}${field('Site', `<select name="s"><option value="">— none —</option>${ss.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>`)}
      ${field('Description', '<input name="d">')}${field('Expected', '<input name="ex" type="date">')}</div><div style="margin-top:10px"><div class="cell-sub" style="margin-bottom:6px">Lines (description, quantity, unit price)</div><div data-lines>${lineRow()}</div><button class="btn sm" type="button" data-addl>${icon('plus')} Line</button></div>`,
      onMount: (mc) => $('[data-addl]', mc.el).addEventListener('click', () => $('[data-lines]', mc.el).insertAdjacentHTML('beforeend', lineRow())),
      actions: [{ label: 'Cancel' }, { label: 'Submit for approval', kind: 'primary', async onClick(mc) {
        const lines = $$('[data-ln]', mc.el).map((r) => ({ description: $('[name="ld"]', r).value.trim(), quantity: Number($('[name="lq"]', r).value), unitPrice: Number($('[name="lp"]', r).value) })).filter((l) => l.description);
        const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
        try { await api('/v1/finance/purchase-orders', { method: 'POST', body: { supplierId: v('sup'), siteId: v('s') || undefined, description: v('d'), expectedOn: v('ex') || undefined, lines } }); toast('Submitted: a second person approves it.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; }
      } }] });
  });
}

// ─────────────────────────────────────────── (v1.30.0) leases

const LEASE_ST = { active: ['t-ok', 'active'], not_started: ['t-info', 'not started'], expired: ['t-mute', 'expired'], ended: ['t-mute', 'ended early'], voided: ['t-mute', 'voided'] };

async function leasesSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d, j;
  try { [d, j] = await Promise.all([api('/v1/finance/leases'), api('/v1/finance/leases/journal')]); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = () => leasesSection(host, canWrite);
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-lnew>${icon('plus')} Record a lease</button>` : ''}<button class="btn" type="button" data-lx>${icon('download')} Excel</button></div>
    ${Object.entries(d.totals).map(([c, t]) => `<div class="grid k4 section">${kpi(`Lease liability · ${c}`, esc(fmt.money(t.liability, c)), `${t.count} active`)}${kpi('Current (12 months)', esc(fmt.money(t.current, c)))}${kpi('Non-current', esc(fmt.money(t.nonCurrent, c)))}${kpi('Right-of-use assets', esc(fmt.money(t.rouNbv, c)), 'net book value')}</div>`).join('') || callout('info', 'No leases yet: record the site leases (land, parking bays, transformers). Under PSAK 73 they are a right-of-use asset and a lease liability.')}
    <div class="card section"><header><h3>Leases</h3></header><div data-ll></div></div>
    <div class="card section"><header><h3>Journal · ${esc(j.month)}</h3>${canWrite && j.currencies.length ? `<button ${BTN} data-lrec>${j.currencies.some((c) => c.recorded) ? 'Record again' : 'Record the month'}</button>` : ''}</header><div data-lj></div></div>`;
  table($('[data-ll]', el), { columns: [
    { label: 'Lease', render: (l) => `<b>${esc(l.description)}</b><div class="cell-sub">${l.site ? `${esc(l.site)} · ` : ''}${esc(l.startMonth)} to ${esc(l.endMonth)}${l.exempt ? ` · ${l.exempt === 'short_term' ? 'short-term' : 'low value'}: expensed` : ''}</div>` },
    { label: 'Payment', num: true, render: (l) => `${esc(fmt.money(l.payment, l.currency))}<div class="cell-sub">${esc(l.frequency)}, in ${esc(l.timing)} · ${l.ratePct}%</div>` },
    { label: 'Liability', num: true, render: (l) => `<b>${esc(fmt.money(l.position.liability, l.currency))}</b><div class="cell-sub">${esc(fmt.money(l.position.current, l.currency))} current</div>` },
    { label: 'ROU asset', num: true, render: (l) => esc(fmt.money(l.position.rouNbv, l.currency)) },
    { label: 'Status', render: (l) => tag(...(LEASE_ST[l.status] ?? ['t-mute', l.status])) },
    { label: '', render: (l) => (canWrite && (l.status === 'active' || l.status === 'not_started') ? `<button ${BTN} data-lend="${esc(l.id)}">End early</button> <button ${BTN} data-lvoid="${esc(l.id)}">Void</button>` : '') },
  ], rows: d.leases.filter((l) => l.status !== 'voided'), empty: 'No leases.' });
  table($('[data-lj]', el), { columns: [
    { label: 'Account', render: (l) => `<span class="mono">${esc(l.code)}</span> ${esc(l.account)}<div class="cell-sub">${esc(l.description)}</div>` },
    { label: 'Debit', num: true, render: (l) => (l.debit ? esc(fmt.money(l.debit, l.currency)) : '') },
    { label: 'Credit', num: true, render: (l) => (l.credit ? esc(fmt.money(l.credit, l.currency)) : '') },
  ], rows: j.currencies.flatMap((c) => c.lines), empty: `No lease entries in ${j.month}.` });
  const post = async (url, body, msg) => { try { await api(url, { method: 'POST', body }); toast(msg, 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; } };
  $('[data-lrec]', el)?.addEventListener('click', () => post(`/v1/finance/leases/journal/${j.month}/record`, undefined, `${j.month} recorded.`));
  $('[data-lx]', el).addEventListener('click', async () => { try { const res = await api('/v1/finance/leases?format=xlsx', { raw: true }); download('plugsure-leases.xlsx', await res.blob()); } catch (e) { toast(e.message, 'crit'); } });
  el.querySelectorAll('[data-lend]').forEach((b) => b.addEventListener('click', () => modal({ title: 'End the lease early', body: `<div class="form">${field('First month it no longer runs', `<input name="m" type="month" value="${esc(zonedYmd(new Date()).slice(0, 7))}">`)}${field('Why', '<input name="n">')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'End it', kind: 'danger', onClick: (mc) => post(`/v1/finance/leases/${b.dataset.lend}/end`, { month: $('[name="m"]', mc.el).value, note: $('[name="n"]', mc.el).value.trim() }, 'Ended.') }] })));
  el.querySelectorAll('[data-lvoid]').forEach((b) => b.addEventListener('click', () => modal({ title: 'Void the lease', body: field('Why (recorded in error)', '<input name="why">'),
    actions: [{ label: 'Cancel' }, { label: 'Void', kind: 'danger', onClick: (mc) => post(`/v1/finance/leases/${b.dataset.lvoid}/void`, { reason: $('[name="why"]', mc.el).value.trim() }, 'Voided.') }] })));
  $('[data-lnew]', el)?.addEventListener('click', async () => {
    const ss = await sitesList();
    modal({ title: 'Record a lease', subtitle: 'PSAK 73: the payments discounted at the borrowing rate', body: `<div class="form">${field('Description', '<input name="d" placeholder="Parking bays, Jl. …">')}${field('Site', `<select name="s"><option value="">— none —</option>${ss.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>`)}
      ${field('Currency (without a site)', `<input name="c" value="${esc(LEGACY_CURRENCY)}">`)}${field('Starts', `<input name="st" type="month" value="${esc(zonedYmd(new Date()).slice(0, 7))}">`)}${field('Term (months)', '<input name="t" type="number" min="1" max="600" value="60">')}
      ${field('Payment (each period)', '<input name="p" type="number" min="1">')}${field('Paid', '<select name="f"><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option></select>')}${field('Timing', '<select name="tm"><option value="advance">In advance</option><option value="arrears">In arrears</option></select>')}
      ${field('Borrowing rate % a year', '<input name="r" type="number" step="0.01" value="9">')}${field('Initial direct costs', '<input name="idc" type="number" min="0" value="0">')}${field('Exempt', '<select name="ex"><option value="">No (12 months or less: short-term)</option><option value="low_value">Low value</option></select>')}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', async onClick(mc) {
        const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
        try { await api('/v1/finance/leases', { method: 'POST', body: { description: v('d'), siteId: v('s') || undefined, currency: v('s') ? undefined : v('c'), startMonth: v('st'), termMonths: Number(v('t')), payment: Number(v('p')), frequency: v('f'), timing: v('tm'), ratePct: Number(v('r')), directCosts: Number(v('idc') || 0), exempt: v('ex') || undefined } }); toast('Recorded.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; }
      } }] });
  });
}

// ─────────────────────────────────────────── (v1.30.0) treasury

async function treasurySection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d, accts;
  try { [d, accts] = await Promise.all([api('/v1/finance/treasury'), api('/v1/finance/cash/accounts')]); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = () => treasurySection(host, canWrite);
  const banks = accts.accounts.filter((a) => a.kind === 'bank');
  const idle = d.idleCash.filter((x) => x.amount > 0);
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-tnew>${icon('plus')} Place a deposit</button>` : ''}<button class="btn" type="button" data-tx>${icon('download')} Excel</button></div>
    ${idle.map((x) => callout('info', `<b>${esc(fmt.money(x.amount, x.currency))}</b> could be placed for ${x.termMonths} month${x.termMonths === 1 ? '' : 's'}: the next 13 weeks stay above the minimums${d.settings.buffer ? ' and the buffer' : ''}. At ${d.settings.indicativeRatePct}% it would earn about ${esc(fmt.money(x.termMonths === 1 ? x.netInterest1m : x.netInterest3m, x.currency))} after tax.`)).join('')}
    ${Object.entries(d.totals).map(([c, t]) => `<div class="grid k4 section">${kpi(`Deposits · ${c}`, esc(fmt.money(t.principal, c)), `${t.count} active`)}${kpi('Interest accrued (net)', esc(fmt.money(t.accruedNet, c)))}${kpi('Next maturity', esc(t.nextMaturity ?? '—'))}${kpi('Interest this year (net)', esc(fmt.money(d.incomeThisYear[c]?.net ?? 0, c)))}</div>`).join('') || callout('info', 'No deposits placed.')}
    <div class="card section"><header><h3>Deposits</h3></header><div data-tl></div></div>`;
  table($('[data-tl]', el), { columns: [
    { label: 'Deposit', render: (x) => `<b>${esc(x.bankName)}</b>${x.reference ? ` · ${esc(x.reference)}` : ''}<div class="cell-sub">from ${esc(x.account)} · ${x.ratePct}% · tax ${x.taxPct}%</div>` },
    { label: 'Principal', num: true, render: (x) => esc(fmt.money(x.principal, x.currency)) },
    { label: 'Term', render: (x) => `${esc(x.placedOn)} → ${esc(x.maturityOn)}${x.daysToMaturity != null ? `<div class="cell-sub" style="color:${x.daysToMaturity <= 7 ? 'var(--warn)' : 'inherit'}">${x.daysToMaturity < 0 ? `${-x.daysToMaturity} days past` : `${x.daysToMaturity} days left`}</div>` : ''}` },
    { label: 'Interest (net)', num: true, render: (x) => (x.status === 'active' ? `${esc(fmt.money(x.accrued.net, x.currency))}<div class="cell-sub">${esc(fmt.money(x.atMaturity.net, x.currency))} at maturity</div>` : esc(fmt.money(x.interestReceived ?? 0, x.currency))) },
    { label: 'Status', render: (x) => tag(x.status === 'active' ? 't-ok' : x.status === 'broken' ? 't-warn' : 't-mute', x.status) },
    { label: '', render: (x) => (canWrite && x.status === 'active' ? `<button ${BTN} data-tclose="${esc(x.id)}">Close</button>` : '') },
  ], rows: d.deposits, empty: 'No deposits.' });
  $('[data-tx]', el).addEventListener('click', async () => { try { const res = await api('/v1/finance/treasury?format=xlsx', { raw: true }); download('plugsure-deposits.xlsx', await res.blob()); } catch (e) { toast(e.message, 'crit'); } });
  el.querySelectorAll('[data-tclose]').forEach((b) => b.addEventListener('click', () => {
    const x = d.deposits.find((y) => y.id === b.dataset.tclose);
    const early = x.daysToMaturity > 0;
    modal({ title: early ? 'Break the deposit early' : 'Close the matured deposit', subtitle: `${x.bankName} · ${fmt.money(x.principal, x.currency)}`, body: `<div class="form">${field('On', `<input name="on" type="date" value="${esc(early ? zonedYmd(new Date()) : x.maturityOn)}">`)}${field('Interest received (net)', `<input name="i" type="number" min="0" value="${early ? 0 : x.atMaturity.net}">`)}
      ${early ? field('Penalty', '<input name="p" type="number" min="0" value="0">') : field('Roll over for (months, blank: back to the account)', '<input name="ro" type="number" min="1" max="60">')}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Close', kind: 'primary', async onClick(mc) {
        const v = (n) => $(`[name="${n}"]`, mc.el)?.value.trim() ?? '';
        try { await api(`/v1/finance/treasury/deposits/${x.id}/close`, { method: 'POST', body: { closedOn: v('on'), interestReceived: Number(v('i') || 0), penalty: early ? Number(v('p') || 0) : undefined, rollover: !early && v('ro') ? { termMonths: Number(v('ro')) } : undefined } }); toast('Closed.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; }
      } }] });
  }));
  $('[data-tnew]', el)?.addEventListener('click', () => {
    if (!banks.length) { toast('Add a bank account first (Cash).', 'warn'); return; }
    modal({ title: 'Place a time deposit', subtitle: 'The money leaves the account until it matures', body: `<div class="form">${field('From', `<select name="a">${banks.map((a) => `<option value="${esc(a.id)}">${esc(a.name)} (${esc(a.currency)})</option>`).join('')}</select>`)}${field('Bank', '<input name="b">')}${field('Reference (bilyet)', '<input name="r">')}
      ${field('Principal', `<input name="p" type="number" min="1" value="${idle[0]?.amount ?? ''}">`)}${field('Rate % a year', `<input name="rt" type="number" step="0.01" value="${d.settings.indicativeRatePct}">`)}${field('Term (months)', `<input name="t" type="number" min="1" max="60" value="${idle[0]?.termMonths ?? 1}">`)}${field('Tax on interest %', '<input name="tx" type="number" step="0.01" value="20">')}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Place', kind: 'primary', async onClick(mc) {
        const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
        try { await api('/v1/finance/treasury/deposits', { method: 'POST', body: { cashAccountId: v('a'), bankName: v('b') || undefined, reference: v('r') || undefined, principal: Number(v('p')), ratePct: Number(v('rt')), termMonths: Number(v('t')), taxPct: Number(v('tx')) } }); toast('Placed.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; }
      } }] });
  });
}

// ─────────────────────────────────────────── (v1.30.0) anomaly review

async function reviewSection(host, canWrite, status = 'open') {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api(`/v1/finance/checks?status=${status}`); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = (s = status) => reviewSection(host, canWrite, s);
  const SEV = { critical: 't-crit', warning: 't-warn', info: 't-info' };
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Show', `<select data-rs>${['open', 'confirmed', 'dismissed', 'cleared', 'all'].map((s) => `<option${s === status ? ' selected' : ''}>${s}</option>`).join('')}</select>`)}${canWrite ? '<div class="row" style="align-self:flex-end"><button class="btn" type="button" data-rrun>Run the checks now</button></div>' : ''}</div>
    <div class="grid k4 section">${d.summary.map((s) => kpi(s.label, String(s.open), `${s.enabled ? 'open' : 'turned off'}${s.confirmed ? ` · ${s.confirmed} confirmed` : ''}`, s.open ? 'warn' : '')).join('')}</div>
    <div class="card section"><header><h3>Findings</h3></header><div data-rl></div></div>`;
  table($('[data-rl]', el), { columns: [
    { label: 'Finding', render: (f) => `${tag(SEV[f.severity] ?? 't-mute', f.severity)} <b>${esc(f.label)}</b><div>${esc(f.message)}</div><div class="cell-sub">found ${esc(fmt.time(f.foundAt))}${f.reviewNote ? ` · ${esc(f.reviewedBy ?? '')}: ${esc(f.reviewNote)}` : ''}</div>` },
    { label: 'Status', render: (f) => tag(f.status === 'open' ? 't-warn' : f.status === 'confirmed' ? 't-crit' : 't-mute', f.status) },
    { label: '', render: (f) => (canWrite && f.status === 'open' ? `<button ${BTN} data-rv="dismiss|${esc(f.id)}">Dismiss</button> <button ${BTN} data-rv="confirm|${esc(f.id)}">Confirm</button>` : '') },
  ], rows: d.findings, empty: status === 'open' ? 'Nothing to review.' : 'None.' });
  $('[data-rs]', el).addEventListener('change', (e) => reload(e.target.value));
  $('[data-rrun]', el)?.addEventListener('click', async () => { try { const r = await api('/v1/finance/checks/run', { method: 'POST' }); toast(`${r.added} new, ${r.cleared} cleared.`, 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); } });
  el.querySelectorAll('[data-rv]').forEach((b) => b.addEventListener('click', () => {
    const [decision, id] = b.dataset.rv.split('|');
    modal({ title: decision === 'dismiss' ? 'Dismiss the finding' : 'Confirm the finding', subtitle: decision === 'dismiss' ? 'It is fine' : 'It needs action: an alert is raised', body: field('What you checked', '<input name="n">'),
      actions: [{ label: 'Cancel' }, { label: decision === 'dismiss' ? 'Dismiss' : 'Confirm', kind: decision === 'dismiss' ? 'primary' : 'danger', async onClick(mc) {
        try { await api(`/v1/finance/checks/${id}/review`, { method: 'POST', body: { decision, note: $('[name="n"]', mc.el).value.trim() } }); reload(); } catch (e) { toast(e.message, 'crit'); return false; }
      } }] });
  }));
}

// ─────────────────────────────────────────── (v1.29.0) fixed assets

const sitesList = async () => { try { const r = await api('/v1/sites'); return Array.isArray(r) ? r : (r.sites ?? r.items ?? []); } catch { return []; } };
const ASSET_CATS = ['chargers', 'installation', 'grid', 'equipment', 'vehicles', 'it', 'other'];
const ASSET_ST = { in_service: ['t-ok', 'in service'], not_in_service: ['t-info', 'not in service yet'], fully_depreciated: ['t-mute', 'fully depreciated'], disposed: ['t-mute', 'disposed'], voided: ['t-mute', 'voided'] };

async function assetsSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d, j;
  try { [d, j] = await Promise.all([api('/v1/finance/assets'), api('/v1/finance/assets/journal')]); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = () => assetsSection(host, canWrite);
  const live = d.assets.filter((a) => a.status !== 'voided');
  el.innerHTML = `${d.investmentsNotImported && canWrite ? callout('info', `${d.investmentsNotImported} site investment${d.investmentsNotImported === 1 ? ' is' : 's are'} not in the register. <button class="btn sm" style="white-space:nowrap" type="button" data-aimp>Import</button>`) : ''}
    <div class="row" style="gap:6px;margin:10px 0">${canWrite ? `<button class="btn primary" type="button" data-anew>${icon('plus')} Record an asset</button>` : ''}<button class="btn" type="button" data-ax>${icon('download')} Excel</button></div>
    ${Object.entries(d.totals).map(([c, t]) => `<div class="grid k4 section">${kpi(`Assets · ${c}`, esc(fmt.money(t.cost, c)), `${t.count} at cost`)}${kpi('Accumulated depreciation', esc(fmt.money(t.accumulated, c)))}${kpi('Net book value', esc(fmt.money(t.netBookValue, c)))}${kpi('Depreciation this month', esc(fmt.money(t.depreciationThisMonth, c)))}</div>`).join('') || callout('info', 'No assets yet: record chargers and equipment, or import the site investments.')}
    <div class="card section"><header><h3>Register</h3></header><div data-ar></div></div>
    <div class="card section"><header><h3>Journal · ${esc(j.month)}</h3>${canWrite && j.currencies.length ? `<button class="btn sm" style="white-space:nowrap" type="button" data-arec>${j.currencies.some((c) => c.recorded) ? 'Record again' : 'Record the month'}</button>` : ''}</header><div data-aj></div></div>`;
  table($('[data-ar]', el), { columns: [
    { label: 'Asset', render: (a) => `<b>${esc(a.tag)}</b> ${esc(a.description)}<div class="cell-sub">${esc(a.category)}${a.site ? ` · ${esc(a.site)}` : ''}${a.chargePoint ? ` · ${esc(a.chargePoint)}` : ''}</div>` },
    { label: 'Cost', num: true, render: (a) => esc(fmt.money(a.cost, a.currency)) },
    { label: 'Method', render: (a) => `${a.method === 'straight_line' ? 'Straight line' : `Declining ${a.ratePct}%`}<div class="cell-sub">${a.lifeMonths} months from ${esc(a.inService)}</div>` },
    { label: 'This month', num: true, render: (a) => esc(fmt.money(a.depreciationThisMonth, a.currency)) },
    { label: 'Net book value', num: true, render: (a) => `<b>${esc(fmt.money(a.netBookValue, a.currency))}</b>${a.disposal ? `<div class="cell-sub">sold ${esc(fmt.money(a.disposal.proceeds, a.currency))} · ${a.disposal.gainLoss >= 0 ? 'gain' : 'loss'} ${esc(fmt.money(Math.abs(a.disposal.gainLoss), a.currency))}</div>` : ''}` },
    { label: 'Status', render: (a) => tag(...(ASSET_ST[a.status] ?? ['t-mute', a.status])) },
    { label: '', render: (a) => (canWrite && a.status !== 'voided' && a.status !== 'disposed' ? `<button class="btn sm" style="white-space:nowrap" type="button" data-adis="${esc(a.id)}">Dispose</button> <button class="btn sm" style="white-space:nowrap" type="button" data-avoid="${esc(a.id)}">Void</button>` : '') },
  ], rows: live, empty: 'No assets.' });
  const jl = j.currencies.flatMap((c) => c.lines.map((l) => ({ ...l })));
  table($('[data-aj]', el), { columns: [
    { label: 'Account', render: (l) => `<span class="mono">${esc(l.code)}</span> ${esc(l.account)}<div class="cell-sub">${esc(l.description)}</div>` },
    { label: 'Debit', num: true, render: (l) => (l.debit ? esc(fmt.money(l.debit, l.currency)) : '') },
    { label: 'Credit', num: true, render: (l) => (l.credit ? esc(fmt.money(l.credit, l.currency)) : '') },
  ], rows: jl, empty: `No depreciation or disposals in ${j.month}.` });
  if (j.currencies.some((c) => c.recorded)) $('[data-aj]', el).insertAdjacentHTML('beforeend', `<div class="body cell-sub">${j.currencies.filter((c) => c.recorded).map((c) => `${esc(c.currency)} recorded ${esc(fmt.time(c.recorded.at))}${c.recorded.by ? ` by ${esc(c.recorded.by)}` : ''}${c.recorded.changedSince ? ' · <b style="color:var(--warn)">changed since: record again</b>' : ''}`).join('<br>')}</div>`);
  $('[data-ax]', el).addEventListener('click', async () => { try { const res = await api('/v1/finance/assets?format=xlsx', { raw: true }); download('plugsure-assets.xlsx', await res.blob()); } catch (e) { toast(e.message, 'crit'); } });
  $('[data-aimp]', el)?.addEventListener('click', async () => { try { const r = await api('/v1/finance/assets/import-investments', { method: 'POST' }); toast(`${r.imported} imported${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.`, 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); } });
  $('[data-arec]', el)?.addEventListener('click', async (e) => { e.target.disabled = true; try { await api(`/v1/finance/assets/journal/${j.month}/record`, { method: 'POST' }); toast(`${j.month} recorded.`, 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); e.target.disabled = false; } });
  el.querySelectorAll('[data-adis]').forEach((b) => b.addEventListener('click', () => modal({ title: 'Dispose of the asset', body: `<div class="form">${field('Date', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Proceeds (minor units)', '<input name="p" type="number" min="0" value="0">')}${field('How', '<input name="n" placeholder="Sold to…, scrapped…">')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Dispose', kind: 'danger', async onClick(mc) { try { await api(`/v1/finance/assets/${b.dataset.adis}/dispose`, { method: 'POST', body: { disposedOn: $('[name="on"]', mc.el).value, proceeds: Number($('[name="p"]', mc.el).value || 0), note: $('[name="n"]', mc.el).value.trim() } }); reload(); } catch (e) { toast(e.message, 'crit'); return false; } } }] })));
  el.querySelectorAll('[data-avoid]').forEach((b) => b.addEventListener('click', () => modal({ title: 'Void the asset', body: field('Why (recorded in error)', '<input name="why">'),
    actions: [{ label: 'Cancel' }, { label: 'Void', kind: 'danger', async onClick(mc) { try { await api(`/v1/finance/assets/${b.dataset.avoid}/void`, { method: 'POST', body: { reason: $('[name="why"]', mc.el).value.trim() } }); reload(); } catch (e) { toast(e.message, 'crit'); return false; } } }] })));
  $('[data-anew]', el)?.addEventListener('click', async () => {
    const ss = await sitesList();
    modal({ title: 'Record an asset', subtitle: 'Cost before PPN, in the minor unit', body: `<div class="form">${field('Category', `<select name="cat">${ASSET_CATS.map((c) => `<option>${c}</option>`).join('')}</select>`)}${field('Description', '<input name="d">')}
      ${field('Site', `<select name="s"><option value="">— none —</option>${ss.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>`)}${field('Currency (without a site)', `<input name="c" value="${esc(LEGACY_CURRENCY)}">`)}
      ${field('Cost', '<input name="cost" type="number" min="1">')}${field('Residual', '<input name="res" type="number" min="0" value="0">')}${field('Acquired', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}
      ${field('Life (months)', '<input name="life" type="number" min="1" max="360" value="96">')}${field('Method', '<select name="m"><option value="straight_line">Straight line</option><option value="declining_balance">Declining balance</option></select>')}${field('Rate % a year (declining)', '<input name="rate" type="number" step="0.01">')}${field('Tag (optional)', '<input name="tag">')}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', async onClick(mc) {
        const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
        try { await api('/v1/finance/assets', { method: 'POST', body: { category: v('cat'), description: v('d'), siteId: v('s') || undefined, currency: v('s') ? undefined : v('c'), cost: Number(v('cost')), residual: Number(v('res') || 0), acquiredOn: v('on'), lifeMonths: Number(v('life')), method: v('m'), ratePct: v('rate') ? Number(v('rate')) : undefined, tag: v('tag') || undefined } }); toast('Recorded.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; }
      } }] });
  });
}

// ─────────────────────────────────────────── (v1.29.0) supplier bills

const BILL_CATS = ['energy', 'maintenance', 'rent', 'installation', 'equipment', 'connectivity', 'services', 'other'];
const BILL_ST = { draft: ['t-mute', 'draft'], awaiting_approval: ['t-warn', 'awaiting approval'], approved: ['t-info', 'approved'], paid: ['t-ok', 'paid'], rejected: ['t-crit', 'rejected'], void: ['t-mute', 'void'] };

async function billsSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let p, b, s, accts;
  try { [p, b, s, accts] = await Promise.all([api('/v1/finance/payables'), api('/v1/finance/bills'), api('/v1/finance/suppliers'), api('/v1/finance/cash/accounts')]); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = () => billsSection(host, canWrite);
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-bnew>${icon('plus')} Record a bill</button><button class="btn" type="button" data-snew>Add a supplier</button>` : ''}<button class="btn" type="button" data-bx>${icon('download')} Ageing (Excel)</button></div>
    ${p.currencies.map((c, i) => `<div class="grid k4 section">${kpi(`Payable · ${c.currency}`, esc(fmt.money(c.total, c.currency)), `${c.suppliers.length} supplier${c.suppliers.length === 1 ? '' : 's'}`)}${kpi('Overdue', esc(fmt.money(c.overdue, c.currency)), '', c.overdue ? 'crit' : '')}${kpi('Due in 14 days', esc(fmt.money(p.dueSoon.filter((x) => x.currency === c.currency).reduce((a, x) => a + x.balance, 0), c.currency)))}${kpi('Awaiting approval', String(p.awaitingApproval.count))}</div>
      <div class="card section"><header><h3>Ageing · ${esc(c.currency)}</h3></header><div data-bag="${i}"></div></div>`).join('') || (p.awaitingApproval.count ? `<div class="grid k4 section">${kpi('Awaiting approval', String(p.awaitingApproval.count), 'bills approved by a second person')}</div>` : callout('info', 'Nothing owed to suppliers.'))}
    <div class="card section"><header><h3>Bills</h3></header><div data-bl></div></div>
    <div class="card section"><header><h3>Suppliers</h3></header><div data-sl></div></div>`;
  p.currencies.forEach((c, i) => table($(`[data-bag="${i}"]`, el), { columns: [
    { label: 'Supplier', render: (x) => `${esc(x.supplier)}<div class="cell-sub">${x.bills} bills</div>` },
    ...p.buckets.map((k) => ({ label: k === 'current' ? 'Not due' : `${k} days`, num: true, render: (x) => (x.buckets[k] ? esc(fmt.money(x.buckets[k], c.currency)) : '') })),
    { label: 'Total', num: true, render: (x) => `<b>${esc(fmt.money(x.total, c.currency))}</b>` },
  ], rows: c.suppliers }));
  table($('[data-bl]', el), { columns: [
    { label: 'Bill', render: (x) => `<b>${esc(x.supplier)}</b> · ${esc(x.number)}<div class="cell-sub">${esc(x.category)}${x.site ? ` · ${esc(x.site)}` : ''} · ${esc(x.description)}</div>` },
    { label: 'Due', render: (x) => `${esc(x.dueDate)}${x.overdue ? `<div class="cell-sub" style="color:var(--crit)">${x.daysLate} days late</div>` : ''}` },
    { label: 'Payable', num: true, render: (x) => `${esc(fmt.money(x.payable, x.currency))}<div class="cell-sub">PPN ${esc(fmt.money(x.vat, x.currency))} · PPh 23 ${esc(fmt.money(x.wht, x.currency))}</div>` },
    { label: 'Balance', num: true, render: (x) => esc(fmt.money(x.balance, x.currency)) },
    { label: 'Status', render: (x) => `${tag(...(BILL_ST[x.status] ?? ['t-mute', x.status]))}${x.firstApprovedBy && x.status === 'awaiting_approval' ? `<div class="cell-sub">1st: ${esc(x.firstApprovedBy)}</div>` : ''}${x.assetId ? '<div class="cell-sub">capitalised</div>' : ''}` },
    { label: '', render: (x) => (!canWrite ? '' : x.status === 'awaiting_approval' ? `<button class="btn sm" style="white-space:nowrap" type="button" data-bap="${esc(x.id)}">Approve</button> <button class="btn sm" style="white-space:nowrap" type="button" data-brj="${esc(x.id)}">Reject</button>`
      : x.status === 'approved' ? `<button class="btn sm" style="white-space:nowrap" type="button" data-bpay="${esc(x.id)}">Pay</button>` : x.status === 'draft' || x.status === 'rejected' ? `<button class="btn sm" style="white-space:nowrap" type="button" data-bsub="${esc(x.id)}">Submit</button> <button class="btn sm" style="white-space:nowrap" type="button" data-bvo="${esc(x.id)}">Void</button>` : '') },
  ], rows: b.bills.filter((x) => x.status !== 'void'), empty: 'No bills yet.' });
  table($('[data-sl]', el), { columns: [
    { label: 'Supplier', render: (x) => `${esc(x.name)}<div class="cell-sub">${esc(x.taxId ?? 'no NPWP')}${x.bank ? ` · ${esc(x.bank.name)} ${esc(x.bank.accountNumber ?? '')}` : ''}</div>` },
    { label: 'Terms', render: (x) => `${x.termsDays} days · ${x.taxKind === 'individual' ? 'PPh 21 (individual)' : x.taxKind === 'foreign' ? `PPh 26 ${x.treatyRatePct ?? 20}%${x.country ? ` · ${esc(x.country)}` : ''}` : x.whtPct ? `PPh 23 ${x.whtPct}%` : 'no withholding'}` },
    { label: 'Open', num: true, render: (x) => (x.open ? esc(fmt.money(x.open, LEGACY_CURRENCY)) : '') },
  ], rows: s.suppliers, empty: 'No suppliers yet.' });
  const post = async (url, body, msg) => { try { const r = await api(url, { method: 'POST', body }); toast(r.waitingForSecondApprover ? 'First approval recorded: a second approver is needed.' : msg, 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; } };
  el.querySelectorAll('[data-bap]').forEach((x) => x.addEventListener('click', () => post(`/v1/finance/bills/${x.dataset.bap}/approve`, undefined, 'Approved.')));
  el.querySelectorAll('[data-bsub]').forEach((x) => x.addEventListener('click', () => post(`/v1/finance/bills/${x.dataset.bsub}/submit`, undefined, 'Submitted for approval.')));
  for (const [attr, url, title] of [['brj', 'reject', 'Reject the bill'], ['bvo', 'void', 'Void the bill']]) el.querySelectorAll(`[data-${attr}]`).forEach((x) => x.addEventListener('click', () => modal({ title, body: field('Why', '<input name="why">'),
    actions: [{ label: 'Cancel' }, { label: 'OK', kind: 'danger', onClick: (mc) => post(`/v1/finance/bills/${x.dataset[attr]}/${url}`, { reason: $('[name="why"]', mc.el).value.trim() }, 'Done.') }] })));
  el.querySelectorAll('[data-bpay]').forEach((x) => x.addEventListener('click', () => {
    const bill = b.bills.find((y) => y.id === x.dataset.bpay);
    modal({ title: `Pay ${bill.supplier} · ${bill.number}`, subtitle: `Balance ${fmt.money(bill.balance, bill.currency)}`, body: `<div class="form">${field('Amount', `<input name="a" type="number" min="1" value="${bill.balance}">`)}${field('Paid on', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}
      ${field('Method', '<select name="m"><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="card">Card</option><option value="other">Other</option></select>')}${field('From account', `<select name="acc"><option value="">—</option>${accts.accounts.filter((a) => a.currency === bill.currency).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select>`)}${field('Reference', '<input name="r">')}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', onClick: (mc) => post(`/v1/finance/bills/${bill.id}/payments`, { amount: Number($('[name="a"]', mc.el).value), paidOn: $('[name="on"]', mc.el).value, method: $('[name="m"]', mc.el).value, cashAccountId: $('[name="acc"]', mc.el).value || undefined, reference: $('[name="r"]', mc.el).value.trim() || undefined }, 'Payment recorded.') }] });
  }));
  $('[data-bx]', el).addEventListener('click', async () => { try { const res = await api('/v1/finance/payables?format=xlsx', { raw: true }); download('plugsure-payables.xlsx', await res.blob()); } catch (e) { toast(e.message, 'crit'); } });
  $('[data-snew]', el)?.addEventListener('click', () => modal({ title: 'Add a supplier', body: `<div class="form">${field('Name', '<input name="n">')}${field('NPWP', '<input name="t">')}${field('E-mail', '<input name="e" type="email">')}${field('Payment terms (days)', '<input name="d" type="number" min="0" max="180" value="30">')}${field('Withholding', '<select name="tk"><option value="company">Company: PPh 23</option><option value="individual">Individual: PPh 21</option><option value="foreign">Abroad: PPh 26</option></select>')}${field('PPh 23 withheld %', '<input name="w" type="number" min="0" max="30" step="0.01" value="0">')}${field('NIK (individual)', '<input name="nik" maxlength="16">', { opt: true })}${field('Country (abroad)', '<input name="cty" maxlength="2" placeholder="SG">', { opt: true })}${field('Treaty rate % (abroad)', '<input name="tr" type="number" min="0" max="20" step="0.01">', { opt: true })}${field('Bank', '<input name="bn" placeholder="BCA">')}${field('Account number', '<input name="ba">')}${field('Account name', '<input name="bh">')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', async onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
      try { await api('/v1/finance/suppliers', { method: 'POST', body: { name: v('n'), taxId: v('t') || undefined, email: v('e') || undefined, termsDays: Number(v('d') || 30), whtPct: Number(v('w') || 0), taxKind: v('tk'), idNumber: v('nik') || undefined, country: v('cty') || undefined, treatyRatePct: v('tr') || undefined, bank: v('bn') ? { name: v('bn'), accountNumber: v('ba') || undefined, accountName: v('bh') || undefined } : undefined } }); toast('Added.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; }
    } }] }));
  $('[data-bnew]', el)?.addEventListener('click', async () => {
    if (!s.suppliers.length) { toast('Add a supplier first.', 'warn'); return; }
    const ss = await sitesList();
    modal({ title: 'Record a supplier bill', subtitle: 'Amounts in the minor unit', body: `<div class="form">${field('Supplier', `<select name="sup">${s.suppliers.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>`)}${field('Their number', '<input name="no">')}
      ${field('Category', `<select name="cat">${BILL_CATS.map((c) => `<option>${c}</option>`).join('')}</select>`)}${field('Site', `<select name="s"><option value="">— none —</option>${ss.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>`)}${field('Description', '<input name="d">')}
      ${field('Subtotal', '<input name="sub" type="number" min="1">')}${field('PPN', '<input name="vat" type="number" min="0" value="0">')}${field('PPh 23 (blank: the supplier\'s rate)', '<input name="wht" type="number" min="0">')}
      ${field('Bill date', `<input name="bd" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Due (blank: the terms)', '<input name="dd" type="date">')}${field('Capitalise as an asset', '<select name="cap"><option value="">No</option><option value="1">Yes (installation, equipment, other)</option></select>')}${field('Asset life (months)', '<input name="life" type="number" min="1" max="360" value="96">')}</div>`,
      actions: [{ label: 'Save as draft', onClick: (mc) => send(mc, true) }, { label: 'Submit for approval', kind: 'primary', onClick: (mc) => send(mc, false) }] });
    async function send(mc, draft) {
      const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
      try { await api('/v1/finance/bills', { method: 'POST', body: { supplierId: v('sup'), number: v('no'), category: v('cat'), siteId: v('s') || undefined, description: v('d'), subtotal: Number(v('sub')), vat: Number(v('vat') || 0), wht: v('wht') === '' ? undefined : Number(v('wht')), billDate: v('bd'), dueDate: v('dd') || undefined, capitalise: v('cap') === '1', lifeMonths: v('cap') === '1' ? Number(v('life')) : undefined, draft } }); toast(draft ? 'Saved as a draft.' : 'Submitted: a second person approves it.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; }
    }
  });
}

// ─────────────────────────────────────────── (v1.29.0) cash position

async function cashSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let p, w;
  try { [p, w] = await Promise.all([api('/v1/finance/cash'), api('/v1/finance/cash/weeks')]); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = () => cashSection(host, canWrite);
  const SRC = { manual: 'balance taken', statement: 'bank statement', opening: 'opening balance' };
  el.innerHTML = `<div class="row" style="gap:6px;margin:0 0 10px">${canWrite ? `<button class="btn primary" type="button" data-cnew>${icon('plus')} Add an account</button><button class="btn" type="button" data-ctr>Record a transfer</button>` : ''}</div>
    ${Object.entries(p.totals).map(([c, t]) => `<div class="grid k4 section">${kpi(`Cash · ${c}`, esc(fmt.money(t.total, c)), `on ${p.date}`)}${kpi('Banks', esc(fmt.money(t.bank, c)))}${kpi('Gateways', esc(fmt.money(t.gateway, c)))}${kpi('Cash on hand', esc(fmt.money(t.cash, c)))}</div>`).join('') || callout('info', 'Add the bank accounts: their balances come from the bank statements you upload, or a balance you take.')}
    ${p.stale.length ? callout('warn', `${p.stale.length} account${p.stale.length === 1 ? '' : 's'} with no balance for more than 7 days: upload a statement or take a balance.`) : ''}
    <div class="card section"><header><h3>Accounts</h3></header><div data-ca></div></div>
    ${w.currencies.map((c, i) => `<div class="card section"><header><h3>Next 13 weeks · ${esc(c.currency)}</h3><span class="cell-sub">from ${esc(fmt.money(c.opening, c.currency))}${c.firstWeekBelowMinimum ? ` · <b style="color:var(--crit)">below the minimum from ${esc(c.firstWeekBelowMinimum)}</b>` : ''}</span></header><div data-cw="${i}"></div></div>`).join('')}
    <div class="card section"><header><h3>Transfers</h3></header><div data-ct></div></div>`;
  w.currencies.forEach((c, i) => table($(`[data-cw="${i}"]`, el), { columns: [
    { label: 'Week', render: (x) => `${x.week}<div class="cell-sub" style="white-space:nowrap">${esc(x.from.slice(5))}</div>` },
    { label: 'In', num: true, render: (x) => (x.in ? esc(fmt.money(x.in, c.currency)) : '') },
    { label: 'Out', num: true, render: (x) => (x.out ? esc(fmt.money(x.out, c.currency)) : '') },
    { label: 'Closing', num: true, render: (x) => `<b style="color:${x.closing < c.minimum ? 'var(--crit)' : 'inherit'}">${esc(fmt.money(x.closing, c.currency))}</b>` },
  ], rows: c.weeks }));
  const rows = [...p.accounts.map((a) => ({ ...a, gw: false })), ...p.gateways.map((g) => ({ id: g.integrationId, name: g.name, kind: 'gateway', currency: g.currency, balance: g.balance, anchor: { source: 'gateway', date: g.takenAt.slice(0, 10) }, gw: true }))];
  table($('[data-ca]', el), { columns: [
    { label: 'Account', render: (a) => `${esc(a.name)}<div class="cell-sub">${esc(a.kind)}${a.bankName ? ` · ${esc(a.bankName)}` : ''}${a.accountHint ? ` ·••${esc(a.accountHint)}` : ''}</div>` },
    { label: 'Balance', num: true, render: (a) => (a.balance == null ? '<span class="cell-sub">none yet</span>' : `<b style="color:${a.belowMinimum ? 'var(--crit)' : 'inherit'}">${esc(fmt.money(a.balance, a.currency))}</b>${a.minimum != null ? `<div class="cell-sub">minimum ${esc(fmt.money(a.minimum, a.currency))}</div>` : ''}`) },
    { label: 'From', render: (a) => (a.anchor ? `${esc(a.gw ? 'gateway snapshot' : SRC[a.anchor.source] ?? a.anchor.source)} · ${esc(a.anchor.date)}${a.movedSince ? `<div class="cell-sub">${esc(fmt.money(a.movedSince, a.currency))} moved since</div>` : ''}` : '') },
    { label: '', render: (a) => (canWrite && !a.gw ? `<button class="btn sm" style="white-space:nowrap" type="button" data-cbal="${esc(a.id)}">Balance</button>` : '') },
  ], rows, empty: 'No accounts.' });
  table($('[data-ct]', el), { columns: [
    { label: 'Date', render: (t) => esc(t.onDate) },
    { label: 'From → to', render: (t) => `${esc(t.from)} → ${esc(t.to)}${t.reference ? `<div class="cell-sub">${esc(t.reference)}</div>` : ''}` },
    { label: 'Amount', num: true, render: (t) => (t.voided ? `<s>${esc(fmt.money(t.amount, t.currency))}</s>` : esc(fmt.money(t.amount, t.currency))) },
    { label: '', render: (t) => (canWrite && !t.voided ? `<button class="btn sm" style="white-space:nowrap" type="button" data-ctv="${esc(t.id)}">Void</button>` : '') },
  ], rows: p.transfers, empty: 'No transfers.' });
  const post = async (url, body, msg) => { try { await api(url, { method: 'POST', body }); toast(msg, 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; } };
  el.querySelectorAll('[data-cbal]').forEach((b) => b.addEventListener('click', () => modal({ title: 'Take a balance', body: `<div class="form">${field('Balance (minor units)', '<input name="b" type="number">')}${field('On', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Note', '<input name="n">')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: (mc) => post(`/v1/finance/cash/accounts/${b.dataset.cbal}/balances`, { balance: Number($('[name="b"]', mc.el).value), onDate: $('[name="on"]', mc.el).value, note: $('[name="n"]', mc.el).value.trim() || undefined }, 'Saved.') }] })));
  el.querySelectorAll('[data-ctv]').forEach((b) => b.addEventListener('click', () => modal({ title: 'Void the transfer', body: field('Why', '<input name="why">'),
    actions: [{ label: 'Cancel' }, { label: 'Void', kind: 'danger', onClick: (mc) => post(`/v1/finance/cash/transfers/${b.dataset.ctv}/void`, { reason: $('[name="why"]', mc.el).value.trim() }, 'Voided.') }] })));
  $('[data-cnew]', el)?.addEventListener('click', () => modal({ title: 'Add a cash account', body: `<div class="form">${field('Name', '<input name="n" placeholder="BCA operating">')}${field('Kind', '<select name="k"><option value="bank">Bank</option><option value="cash">Cash on hand</option></select>')}${field('Bank', '<input name="bn">')}${field('Last digits of the number', '<input name="h" inputmode="numeric">')}
    ${field('Currency', `<input name="c" value="${esc(LEGACY_CURRENCY)}">`)}${field('Opening balance', '<input name="ob" type="number" value="0">')}${field('On', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Alert below (optional)', '<input name="min" type="number" min="0">')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', async onClick(mc) {
      const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
      try { await api('/v1/finance/cash/accounts', { method: 'POST', body: { name: v('n'), kind: v('k'), bankName: v('bn') || undefined, accountHint: v('h') || undefined, currency: v('c'), openingBalance: Number(v('ob') || 0), openingOn: v('on'), minimum: v('min') === '' ? null : Number(v('min')) } }); toast('Added.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; }
    } }] }));
  $('[data-ctr]', el)?.addEventListener('click', () => {
    if (p.accounts.length < 2) { toast('Add two accounts first.', 'warn'); return; }
    const opts = p.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)} (${esc(a.currency)})</option>`).join('');
    modal({ title: 'Record a transfer', body: `<div class="form">${field('From', `<select name="f">${opts}</select>`)}${field('To', `<select name="t">${opts}</select>`)}${field('Amount (minor units)', '<input name="a" type="number" min="1">')}${field('On', `<input name="on" type="date" value="${esc(zonedYmd(new Date()))}">`)}${field('Reference', '<input name="r">')}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', onClick: (mc) => post('/v1/finance/cash/transfers', { fromAccountId: $('[name="f"]', mc.el).value, toAccountId: $('[name="t"]', mc.el).value, amount: Number($('[name="a"]', mc.el).value), onDate: $('[name="on"]', mc.el).value, reference: $('[name="r"]', mc.el).value.trim() || undefined }, 'Recorded.') }] });
  });
}

// ─────────────────────────────────────────── (v1.29.0) KPI benchmarking

const BENCH_LBL = { revenue: 'Revenue', revenuePerKwh: 'Revenue / kWh', utilisationPct: 'Utilisation', marginPct: 'Margin', revenuePerConnector: 'Revenue / connector / month', collectionDays: 'Collection days' };

async function benchmarkSection(host, opts = { by: 'site', months: 3 }) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let b;
  try { b = await api(`/v1/finance/benchmark?by=${opts.by}&months=${opts.months}`); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = (o) => benchmarkSection(host, { ...opts, ...o });
  const val = (m, v, cur) => (v == null ? '<span class="cell-sub">—</span>' : m === 'revenue' || m === 'revenuePerKwh' || m === 'revenuePerConnector' ? esc(fmt.money(v, cur)) : m === 'collectionDays' ? `${esc(String(v))} d` : `${esc(String(v))}%`);
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Compare', `<select data-bby><option value="site"${opts.by === 'site' ? ' selected' : ''}>Sites</option><option value="owner"${opts.by === 'owner' ? ' selected' : ''}>Site owners</option></select>`)}${field('Months', `<select data-bm>${[1, 3, 6, 12].map((n) => `<option${n === opts.months ? ' selected' : ''}>${n}</option>`).join('')}</select>`)}<div class="row" style="align-self:flex-end"><button class="btn" type="button" data-bxl>${icon('download')} Excel</button></div></div>
    ${callout('info', `${esc(b.from)} to ${esc(b.to)}, against peers in the same currency. The rank is a percentile (100 is the best; fewer collection days is better). Outliers are beyond 1.5 × the interquartile range.`)}
    ${Object.keys(b.stats).map((cur, i) => `<div class="card section"><header><h3>Peers · ${esc(cur)}</h3></header><div data-bp="${i}"></div></div>`).join('')}
    <div class="card section"><header><h3>${opts.by === 'owner' ? 'Owners' : 'Sites'}</h3></header><div data-brows></div></div>`;
  Object.entries(b.stats).forEach(([cur, st], i) => table($(`[data-bp="${i}"]`, el), { columns: [
    { label: 'Metric', render: (m) => esc(BENCH_LBL[m]) },
    { label: 'Q1', num: true, render: (m) => val(m, st[m].q1, cur) },
    { label: 'Median', num: true, render: (m) => `<b>${val(m, st[m].median, cur)}</b>` },
    { label: 'Q3', num: true, render: (m) => val(m, st[m].q3, cur) },
  ], rows: b.metrics.filter((m) => st[m]) }));
  table($('[data-brows]', el), { columns: [
    { label: opts.by === 'owner' ? 'Owner' : 'Site', render: (r) => `<b>${esc(r.name)}</b><div class="cell-sub">${r.sites > 1 ? `${r.sites} sites · ` : ''}${r.connectors} connectors · ${fmt.num(r.sessions)} sessions</div>` },
    { label: 'Score', num: true, render: (r) => (r.score == null ? '' : `<b>${r.score}</b>`) },
    ...b.metrics.map((m) => ({ label: BENCH_LBL[m], num: true, render: (r) => { const o = r.outliers.find((x) => x.metric === m); return `${val(m, r.metrics[m], r.currency)}${r.ranks[m] != null ? `<div class="cell-sub">p${r.ranks[m]}</div>` : ''}${o ? `<div>${tag(o.good ? 't-ok' : 't-crit', o.direction === 'high' ? 'high' : 'low')}</div>` : ''}`; } })),
  ], rows: b.rows, empty: 'No sessions in the period.' });
  $('[data-bby]', el).addEventListener('change', (e) => reload({ by: e.target.value }));
  $('[data-bm]', el).addEventListener('change', (e) => reload({ months: Number(e.target.value) }));
  $('[data-bxl]', el).addEventListener('click', async () => { try { const res = await api(`/v1/finance/benchmark?by=${opts.by}&months=${opts.months}&format=xlsx`, { raw: true }); download('plugsure-benchmark.xlsx', await res.blob()); } catch (e) { toast(e.message, 'crit'); } });
}

// ─────────────────────────────────────────── (v1.28.0) driver funds

async function driverFundsSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let d;
  try { d = await api('/v1/finance/driver-funds'); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = () => driverFundsSection(host, canWrite);
  const canApprove = state.can('finance:approve');
  el.innerHTML = `${callout('info', `Money drivers paid ahead and the operator holds: a liability until used, refunded or, after ${d.position.breakageDays} days unused, recognised as breakage.`)}
    <div class="row" style="gap:6px;margin:10px 0"><button class="btn" type="button" data-dfx>${icon('download')} Excel</button>${canWrite ? `<button class="btn" type="button" data-dfs>${icon('gear')} Breakage days</button>` : ''}</div>
    ${d.position.currencies.map((c) => `<div class="grid k4 section">${kpi('Liability', esc(fmt.money(c.liability, c.currency)), c.currency)}${kpi('Unused (owed)', esc(fmt.money(c.unused, c.currency)), `${c.windowClosing ? `${fmt.money(c.windowClosing, c.currency)} refund window closing` : `${c.payments} payments`}`)}${kpi('In use / refund due', esc(fmt.money(c.inUse + c.refundDue, c.currency)), `${fmt.money(c.inUse, c.currency)} charging · ${fmt.money(c.refundDue, c.currency)} due`)}${kpi('Loyalty points', esc(fmt.money(c.loyaltyValue, c.currency)), `${fmt.num(c.loyaltyPoints)} points`)}</div>`).join('') || callout('info', 'No prepaid driver payments yet.')}
    <div class="grid two section"><div class="card"><header><h3>Breakage</h3></header><div data-dfb></div></div><div class="card"><header><h3>This month</h3></header><div data-dfm></div></div></div>`;
  table($('[data-dfb]', el), { columns: [
    { label: 'Paid in', render: (b) => `${esc(b.month)}<div class="cell-sub">${b.payments} payments</div>` },
    { label: 'Unused', num: true, render: (b) => esc(fmt.money(b.amount, b.currency)) },
    { label: '', render: (b) => (canApprove ? `<button class="btn sm" type="button" data-dfr="${esc(b.month)}|${esc(b.currency)}">Recognise</button>` : '') },
  ], rows: d.position.breakage, empty: 'Nothing past the breakage days.' });
  table($('[data-dfm]', el), { columns: [
    { label: 'Currency', render: (c) => esc(c.currency) },
    { label: 'Collected', num: true, render: (c) => esc(fmt.money(c.collected, c.currency)) },
    { label: 'Used', num: true, render: (c) => esc(fmt.money(c.used, c.currency)) },
    { label: 'Refunded', num: true, render: (c) => esc(fmt.money(c.refunded, c.currency)) },
    { label: 'Gateway', num: true, render: (c) => `${esc(fmt.money(c.gateway, c.currency))}${c.difference ? `<div class="cell-sub" style="color:var(--warn)">${esc(fmt.money(c.difference, c.currency))} apart</div>` : ''}` },
  ], rows: d.movement.currencies, empty: 'No movement this month.' });
  $('[data-dfx]', el).addEventListener('click', async () => { try { const res = await api('/v1/finance/driver-funds?format=xlsx', { raw: true }); download('plugsure-driver-funds.xlsx', await res.blob()); } catch (e) { toast(e.message, 'crit'); } });
  el.querySelectorAll('[data-dfr]').forEach((b) => b.addEventListener('click', async () => {
    const [month, currency] = b.dataset.dfr.split('|');
    b.disabled = true;
    try { const r = await api('/v1/finance/driver-funds/breakage', { method: 'POST', body: { month, currency } }); toast(`${fmt.money(r.amount, currency)} recognised as breakage.`, 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); b.disabled = false; }
  }));
  $('[data-dfs]', el)?.addEventListener('click', () => modal({ title: 'Breakage', body: field('An unused balance is breakage after (days)', `<input name="bd" type="number" min="30" max="1825" value="${d.position.breakageDays}">`),
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
      try { await api('/v1/finance/driver-funds/settings', { method: 'PUT', body: { breakageDays: Number($('[name="bd"]', mc.el).value) } }); toast('Saved.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; }
    } }] }));
}

// ─────────────────────────────────────────── (v1.28.0) group consolidation

async function groupSection(host, canWrite, month = lastMonthYm()) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let g;
  try { g = await api(`/v1/finance/group?month=${month}`); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  if (!g.grouped) { el.innerHTML = callout('info', esc(g.message)); return; }
  const reload = (m = month) => groupSection(host, canWrite, m);
  const curs = Object.keys(g.net).sort();
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Month', `<input type="month" data-gm value="${esc(g.month)}">`)}${canWrite ? '<div class="row" style="align-self:flex-end"><button class="btn" type="button" data-gel>Record elimination</button></div>' : ''}</div>
    <div class="grid k4">${curs.map((c) => kpi(`Group revenue · ${c}`, esc(fmt.money(g.net[c].revenue, c)), 'after eliminations') + kpi(`Operating result · ${c}`, esc(fmt.money(g.net[c].operating, c)), '', g.net[c].operating < 0 ? 'crit' : '')).join('')}
      ${g.reporting ? kpi(`In ${g.reporting.currency}`, esc(fmt.money(g.reporting.revenue, g.reporting.currency)), `result ${fmt.money(g.reporting.operating, g.reporting.currency)}${g.reporting.missing.length ? ` · no rate for ${g.reporting.missing.join(', ')}` : ''}`) : ''}</div>
    <div class="card section"><header><h3>Entities</h3></header><div data-ge></div></div>
    <div class="card section"><header><h3>Eliminations</h3></header><div data-gx></div><div class="body" data-gs></div></div>`;
  const rows = g.entities.flatMap((e) => Object.entries(e.currencies).map(([c, l]) => ({ e, c, l })));
  table($('[data-ge]', el), { columns: [
    { label: 'Entity', render: (r) => `${esc(r.e.name)}${r.e.parent ? ` ${tag('t-info', 'parent')}` : ''}<div class="cell-sub">${r.e.sites} sites · ${r.e.sessions} sessions · ${fmt.num(r.e.kwh)} kWh</div>` },
    { label: 'Revenue', num: true, render: (r) => esc(fmt.money(r.l.revenue, r.c)) },
    { label: 'Energy + shared + depr.', num: true, render: (r) => esc(fmt.money(r.l.energyCost + r.l.shared + r.l.depreciation, r.c)) },
    { label: 'Owners + fees', num: true, render: (r) => esc(fmt.money(r.l.ownerShares + r.l.platformFees, r.c)) },
    { label: 'Operating', num: true, render: (r) => `<b style="color:${r.l.operating < 0 ? 'var(--crit)' : 'inherit'}">${esc(fmt.money(r.l.operating, r.c))}</b>` },
  ], rows, empty: 'No figures this month.' });
  table($('[data-gx]', el), { columns: [
    { label: 'Elimination', render: (x) => `${esc(x.description)}<div class="cell-sub">${esc(x.kind)} · ${esc(x.by ?? '')}</div>` },
    { label: 'Amount', num: true, render: (x) => esc(fmt.money(x.amount, x.currency)) },
    { label: '', render: (x) => (canWrite ? `<button class="btn sm" type="button" data-gv="${esc(x.id)}">Void</button>` : '') },
  ], rows: g.eliminations.recorded, empty: 'None recorded.' });
  const sug = g.eliminations.suggestions.filter((x) => !x.recorded);
  $('[data-gs]', el).innerHTML = sug.length ? `<div class="cell-sub" style="margin-bottom:6px">Suggested (fleet invoices between group entities):</div>${sug.map((x, i) => `<div class="row" style="justify-content:space-between;gap:8px;padding:3px 0"><span>${esc(x.description)}</span><span class="row" style="gap:6px"><b>${esc(fmt.money(x.amount, x.currency))}</b>${canWrite ? `<button class="btn sm" type="button" data-gsa="${i}">Eliminate</button>` : ''}</span></div>`).join('')}` : '';
  const rec = async (body) => { try { await api('/v1/finance/group/eliminations', { method: 'POST', body: { month: g.month, ...body } }); toast('Recorded.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; } };
  el.querySelectorAll('[data-gsa]').forEach((b) => b.addEventListener('click', () => { const x = sug[Number(b.dataset.gsa)]; rec({ kind: x.kind, description: x.description, amount: x.amount, currency: x.currency }); }));
  el.querySelectorAll('[data-gv]').forEach((b) => b.addEventListener('click', () => modal({ title: 'Void the elimination', body: field('Why', '<input name="why">'),
    actions: [{ label: 'Cancel' }, { label: 'Void', kind: 'danger', async onClick(mc) { try { await api(`/v1/finance/group/eliminations/${b.dataset.gv}/void`, { method: 'POST', body: { reason: $('[name="why"]', mc.el).value.trim() } }); reload(); } catch (e) { toast(e.message, 'crit'); return false; } } }] })));
  $('[data-gel]', el)?.addEventListener('click', () => modal({ title: 'Intercompany elimination', subtitle: g.month, body: `<div class="form">${field('Kind', '<select name="k"><option value="revenue">Revenue</option><option value="cost">Cost</option></select>')}${field('Description', '<input name="d">')}${field('Amount (minor units)', '<input name="a" type="number" min="1">')}${field('Currency', `<input name="c" value="${esc(curs[0] ?? LEGACY_CURRENCY)}">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', onClick: (mc) => rec({ kind: $('[name="k"]', mc.el).value, description: $('[name="d"]', mc.el).value.trim(), amount: Number($('[name="a"]', mc.el).value), currency: $('[name="c"]', mc.el).value.trim() }) }] }));
  $('[data-gm]', el).addEventListener('change', (e) => e.target.value && reload(e.target.value));
}

// ─────────────────────────────────────────── (v1.28.0) rolling revenue forecast

async function rollingSection(host, canWrite, q = '') {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let f;
  try { f = await api(`/v1/finance/rolling-forecast${q}`); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const sc = f.scenario;
  el.innerHTML = `<div class="filters" style="margin-top:0">${field('Growth % a year', `<input type="number" data-rg value="${sc.growthPct}" style="width:100px">`)}${field('Price change %', `<input type="number" data-rp value="${sc.pricePct}" style="width:100px">`)}${field('Energy cost change %', `<input type="number" data-re value="${sc.energyPct}" style="width:100px">`)}${field('Alert below budget %', `<input type="number" data-ra value="${sc.alertPct}" style="width:100px">`)}
      <div class="row" style="gap:6px;align-self:flex-end"><button class="btn" type="button" data-rgo>Apply</button>${canWrite ? '<button class="btn" type="button" data-rsv>Save as default</button>' : ''}</div></div>
    ${callout('info', 'Each site\'s trend over the last 12 months (flat at the average with fewer than 6 months of history), with seasonality once there are 13 months, then your scenario. The energy cost follows each site\'s last 3 months.')}
    ${Object.entries(f.totals).map(([c, t]) => `<div class="card section"><header><h3>Next 12 months · ${esc(c)}</h3><span class="right cell-sub">revenue ${esc(fmt.money(t.reduce((a, x) => a + x.revenue, 0), c))} · margin ${esc(fmt.money(t.reduce((a, x) => a + x.margin, 0), c))}</span></header><div data-rt="${esc(c)}"></div></div>`).join('')}
    <div class="card section"><header><h3>Sites</h3></header><div data-rs></div></div>`;
  for (const [c, t] of Object.entries(f.totals)) table($(`[data-rt="${c}"]`, el), { columns: [
    { label: 'Month', render: (r) => esc(r.month) }, { label: 'Revenue', num: true, render: (r) => esc(fmt.money(r.revenue, c)) },
    { label: 'Energy', num: true, render: (r) => esc(fmt.money(r.energyCost, c)) }, { label: 'Margin', num: true, render: (r) => esc(fmt.money(r.margin, c)) },
    { label: 'Budget', num: true, render: (r) => (r.budget == null ? '<span class="cell-sub">—</span>' : `${esc(fmt.money(r.budget, c))}${r.revenue < r.budget ? `<div class="cell-sub" style="color:var(--warn)">${esc(fmt.money(r.revenue - r.budget, c))}</div>` : ''}`) },
  ], rows: t, empty: '' });
  table($('[data-rs]', el), { columns: [
    { label: 'Site', render: (s) => `${esc(s.site)}${s.belowBudget ? ` ${tag('t-warn', 'below budget')}` : ''}<div class="cell-sub">${s.monthsOfHistory} months of history${s.flat ? ' · flat (a trend needs 6 months)' : ''}${s.seasonal ? ' · seasonal' : ''} · energy ${s.costRatioPct}% of revenue</div>` },
    { label: 'Trend a month', num: true, render: (s) => esc(fmt.money(s.trendPerMonth, s.currency)) },
    { label: 'Next 12 months', num: true, render: (s) => `<b>${esc(fmt.money(s.next12, s.currency))}</b>` },
  ], rows: f.sites, empty: 'No sites.' });
  const v = (k) => $(`[data-${k}]`, el).value;
  const params = () => `?growthPct=${v('rg')}&pricePct=${v('rp')}&energyPct=${v('re')}&alertPct=${v('ra')}`;
  $('[data-rgo]', el).addEventListener('click', () => rollingSection(host, canWrite, params()));
  $('[data-rsv]', el)?.addEventListener('click', async () => {
    try { await api('/v1/finance/rolling-forecast/settings', { method: 'PUT', body: { growthPct: Number(v('rg')), pricePct: Number(v('rp')), energyPct: Number(v('re')), alertPct: Number(v('ra')) } }); toast('Saved.', 'ok'); } catch (e) { toast(e.message, 'crit'); }
  });
}

// ─────────────────────────────────────────── (v1.28.0) payment plans and the bad-debt provision

async function plansSection(host, canWrite) {
  const el = document.createElement('div');
  host.replaceChildren(el);
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
  let p, pr;
  try { [p, pr] = await Promise.all([state.can('invoice:read') ? api('/v1/finance/payment-plans') : Promise.resolve({ plans: [] }), api('/v1/finance/provision')]); } catch (e) { el.innerHTML = callout('crit', esc(e.message)); return; }
  const reload = () => plansSection(host, canWrite);
  const canInv = state.can('invoice:write');
  const ST = { active: 't-info', completed: 't-ok', defaulted: 't-crit', cancelled: 't-mute' };
  el.innerHTML = `<div class="card"><header><h3>Payment plans</h3>${canInv ? '<span class="right"><button class="btn sm primary" type="button" data-pn>New plan</button></span>' : ''}</header><div data-pl></div></div>
    <div class="card section"><header><h3>Bad-debt provision</h3><span class="right"><button class="btn sm" type="button" data-px>${icon('download')} Excel</button> ${canWrite ? `<button class="btn sm primary" type="button" data-pr>Record ${esc(lastMonthYm())}</button>` : ''}</span></header>
      <div class="body"><p class="cell-sub" style="margin-top:0">Receivables by age × the rate (${Object.entries(pr.rates).map(([k, v]) => `${k}: ${v}%`).join(', ')}). An invoice on an active plan counts as current.</p></div><div data-pp></div><div data-ph></div></div>`;
  table($('[data-pl]', el), { columns: [
    { label: 'Invoice', render: (x) => `<span class="mono">${esc(x.number)}</span><div class="cell-sub">${esc(x.account)}</div>` },
    { label: 'Instalments', render: (x) => x.instalments.map((i) => `<span title="${esc(i.due)}" class="tag ${i.status === 'paid' ? 't-ok' : i.status === 'late' ? 't-crit' : 't-mute'}">${esc(i.due.slice(5))}</span>`).join(' ') },
    { label: 'Left', num: true, render: (x) => esc(fmt.money(x.outstanding, x.currency)) },
    { label: 'Status', render: (x) => tag(ST[x.status] ?? 't-mute', x.status) },
    { label: '', render: (x) => (canInv && x.status === 'active' ? `<button class="btn sm" type="button" data-ppay="${esc(x.id)}">Payment</button> <button class="btn sm" type="button" data-pc="${esc(x.id)}">Cancel</button>` : '') },
  ], rows: p.plans, empty: 'No payment plans.' });
  table($('[data-pp]', el), { columns: [
    { label: 'Currency · bucket', render: (r) => `${esc(r.c)} · ${esc(r.b.bucket)}<div class="cell-sub">${r.b.count} receivable(s)</div>` },
    { label: 'Receivables', num: true, render: (r) => esc(fmt.money(r.b.amount, r.c)) },
    { label: 'Rate', num: true, render: (r) => `${r.b.ratePct}%` },
    { label: 'Provision', num: true, render: (r) => esc(fmt.money(r.b.provision, r.c)) },
  ], rows: pr.currencies.flatMap((c) => c.buckets.filter((b) => b.amount).map((b) => ({ c: c.currency, b }))), empty: 'No receivables.' });
  $('[data-ph]', el).innerHTML = pr.currencies.map((c) => `<div class="body">${callout('info', `${esc(c.currency)}: provision <b>${esc(fmt.money(c.provision, c.currency))}</b>${c.last ? ` against ${esc(fmt.money(c.last.provision, c.currency))} recorded for ${esc(c.last.month)}` : ''} — movement ${esc(fmt.money(c.movement, c.currency))}.`)}</div>`).join('');
  $('[data-px]', el).addEventListener('click', async () => { try { const res = await api('/v1/finance/provision?format=xlsx', { raw: true }); download('plugsure-provision.xlsx', await res.blob()); } catch (e) { toast(e.message, 'crit'); } });
  $('[data-pr]', el)?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await api(`/v1/finance/provision/${lastMonthYm()}/record`, { method: 'POST' }); toast('Recorded.', 'ok'); reload(); } catch (err) { toast(err.message, 'crit'); e.currentTarget.disabled = false; }
  });
  el.querySelectorAll('[data-ppay]').forEach((b) => b.addEventListener('click', () => modal({ title: 'Payment on the plan', body: `<div class="form">${field('Amount (minor units)', '<input name="a" type="number" min="1">')}${field('Paid on', `<input name="d" type="date" value="${zonedYmd(new Date())}">`)}${field('Bank reference', '<input name="r">')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', async onClick(mc) { try { await api(`/v1/finance/payment-plans/${b.dataset.ppay}/payments`, { method: 'POST', body: { amount: Number($('[name="a"]', mc.el).value), paidOn: $('[name="d"]', mc.el).value, reference: $('[name="r"]', mc.el).value.trim() } }); toast('Recorded.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; } } }] })));
  el.querySelectorAll('[data-pc]').forEach((b) => b.addEventListener('click', () => modal({ title: 'Cancel the plan', body: field('Why', '<input name="w">'),
    actions: [{ label: 'Back' }, { label: 'Cancel plan', kind: 'danger', async onClick(mc) { try { await api(`/v1/finance/payment-plans/${b.dataset.pc}/cancel`, { method: 'POST', body: { reason: $('[name="w"]', mc.el).value.trim() } }); reload(); } catch (e) { toast(e.message, 'crit'); return false; } } }] })));
  $('[data-pn]', el)?.addEventListener('click', async () => {
    let inv;
    try { inv = (await api('/v1/fleet-invoices?status=issued')).invoices ?? []; } catch { inv = []; }
    modal({ title: 'New payment plan', body: `<div class="form">${field('Invoice', `<select name="i">${inv.filter((i) => Number(i.balance_minor) > 0).map((i) => `<option value="${esc(i.id)}">${esc(i.number)}${i.overdue ? ' · overdue' : ''} · ${esc(fmt.money(Number(i.balance_minor), i.currency))}</option>`).join('')}</select>`)}
        ${field('Instalments', '<input name="n" type="number" min="2" max="24" value="3">')}${field('First due', `<input name="f" type="date" value="${zonedYmd(new Date())}">`)}${field('Every (days; empty: monthly)', '<input name="e" type="number" min="7" max="92">')}${field('Grace days', '<input name="g" type="number" min="0" max="60" value="7">')}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Agree', kind: 'primary', async onClick(mc) {
        const v = (n) => $(`[name="${n}"]`, mc.el).value;
        try { await api(`/v1/fleet-invoices/${v('i')}/payment-plan`, { method: 'POST', body: { count: Number(v('n')), firstDue: v('f'), everyDays: v('e') ? Number(v('e')) : undefined, graceDays: Number(v('g')) } }); toast('Plan agreed.', 'ok'); reload(); } catch (e) { toast(e.message, 'crit'); return false; }
      } }] });
  });
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
      { id: 'summary', label: 'Summary' }, { id: 'scorecard', label: 'Scorecard' }, { id: 'reports', label: 'Reports' }, { id: 'overview', label: 'Overview' }, { id: 'payments', label: 'Payments' }, { id: 'receivables', label: 'Receivables' },
      { id: 'payables', label: 'Payables' }, { id: 'orders', label: 'Orders' }, { id: 'bills', label: 'Bills' }, { id: 'expenses', label: 'Expenses' }, { id: 'cash', label: 'Cash' }, { id: 'cashforecast', label: 'Cash forecast' }, { id: 'treasury', label: 'Treasury' }, { id: 'credit', label: 'Credit' }, { id: 'assurance', label: 'Assurance' }, { id: 'payroll', label: 'Payroll' }, { id: 'projects', label: 'Projects' }, { id: 'inventory', label: 'Inventory' }, { id: 'maintenance', label: 'Maintenance' }, { id: 'lenders', label: 'Lenders' }, { id: 'carbon', label: 'Carbon' }, { id: 'insurance', label: 'Insurance' }, { id: 'pricing', label: 'Pricing' }, { id: 'compliance', label: 'Compliance' }, { id: 'grants', label: 'Grants' }, { id: 'landlords', label: 'Landlords' }, { id: 'chargebacks', label: 'Chargebacks' }, { id: 'loyaltycost', label: 'Loyalty costs' }, { id: 'taxaudit', label: 'Tax audit' }, { id: 'portfolio', label: 'Portfolio' }, { id: 'planning', label: 'Budget planning' }, { id: 'fxtreasury', label: 'FX & hedges' }, { id: 'procurement', label: 'Procurement' }, { id: 'closeauto', label: 'Close automation' }, { id: 'ownerfinance', label: 'Owner finance' }, { id: 'statutory', label: 'Financial statements' }, { id: 'corptax', label: 'Corporate tax' }, { id: 'payruns', label: 'Payment runs' }, { id: 'cards', label: 'Cards' }, { id: 'contracts', label: 'Contracts' }, { id: 'netting', label: 'Netting & TP' }, { id: 'dataquality', label: 'Data quality' }, { id: 'scenarios', label: 'Scenarios' }, { id: 'autopay', label: 'Auto payouts' }, { id: 'collections', label: 'Collections' }, { id: 'plans', label: 'Plans & provision' }, { id: 'forecast', label: 'Forecast' }, { id: 'rforecast', label: 'Revenue forecast' }, { id: 'fees', label: 'Fees' }, { id: 'reconciliation', label: 'Reconciliation' },
      { id: 'bank', label: 'Bank' }, { id: 'feeds', label: 'Bank feeds' }, { id: 'tax', label: 'Tax' }, { id: 'slips', label: 'Withholding' }, { id: 'ppn', label: 'PPN' }, { id: 'tariffs', label: 'Tariffs' }, { id: 'fleetauto', label: 'Fleet invoicing' }, { id: 'subscriptions', label: 'Subscriptions' }, { id: 'margin', label: 'Margin' }, { id: 'budgets', label: 'Budgets' }, { id: 'investments', label: 'Investments' }, { id: 'assets', label: 'Assets' }, { id: 'leases', label: 'Leases' }, { id: 'benchmark', label: 'Benchmark' }, { id: 'pnl', label: 'Site P&L' }, { id: 'settlements', label: 'Settlements' }, { id: 'roaming', label: 'Roaming' }, { id: 'ledger', label: 'Ledger' }, { id: 'closesteps', label: 'Close steps' }, { id: 'close', label: 'Close' }, { id: 'yearend', label: 'Year end' }, { id: 'group', label: 'Group' }, { id: 'intercompany', label: 'Intercompany' }, { id: 'funds', label: 'Driver funds' }, { id: 'controls', label: 'Controls' }, { id: 'review', label: 'Review' }, { id: 'settings', label: 'Settings' },
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
          <button class="btn" type="button" data-journal>Journal</button>
          <button class="btn" type="button" data-auditpack title="The period's records as one ZIP for the auditor, with checksums">Audit pack</button>
          <button class="btn" type="button" data-reports>Xendit reports</button>
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
        </div>
        <div class="card section"><header><h3>By operator</h3></header><div data-byop><div class="empty-state"><span class="spinner"></span></div></div></div>
        <p class="cell-sub">The month close by site is in the Excel and PDF exports.</p>`;
      // (v1.15.0) The accountant's close by operator: collected, fees, refunds, net, and owners' shares on its statements.
      api(`${base()}/breakdown?${per()}`).then((b) => table($('[data-byop]', body), {
        columns: [
          { label: 'Operator', render: (x) => esc(x.operator ?? 'platform / not matched') },
          { label: 'Collected', num: true, render: (x) => `${esc(rp(x.collected))}<div class="cell-sub">${esc(fmt.num(x.payments))} payments</div>` },
          { label: 'Fees incl. VAT', num: true, render: (x) => esc(rp(x.fees + x.vat)) },
          { label: 'Refunds', num: true, render: (x) => esc(rp(x.refunds)) },
          { label: 'Net', num: true, render: (x) => `<b>${esc(rp(x.net))}</b>` },
          { label: 'Owners\' shares', num: true, render: (x) => (x.ownerShares ? `${esc(rp(x.ownerShares))}<div class="cell-sub">${esc(rp(x.ownerSharesPaid))} paid</div>` : '<span class="cell-sub">—</span>') },
        ], rows: b.byOperator, empty: 'No payments in this period.',
      })).catch((e) => { $('[data-byop]', body).innerHTML = callout('crit', esc(e.message)); });
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
        <p class="cell-sub">Click a row for its whole trail. ${isDuitku() ? 'Built from PlugSure\'s Duitku payments with the amount and fee Duitku reports for each; the settlement date is estimated from Duitku\'s schedule (QRIS and e-wallets 2 working days, cards 4).' : 'From Xendit\'s ledger: amounts, fees and VAT as Xendit charged them.'} Net = amount − fee − VAT (money in).</p>`;
      let rows = [];
      const draw = async (more = false) => {
        const q = new URLSearchParams({ from, to, limit: '200' });
        $$('[data-f]', body).forEach((el) => { if (el.value.trim()) q.set(el.dataset.f, el.value.trim()); });
        if (more && rows.length) q.set('before', rows[rows.length - 1].id);
        let r;
        try { r = await api(`${base()}/transactions?${q}`); } catch (e) { toast(e.message, 'crit'); return; }
        rows = more ? rows.concat(r.transactions) : r.transactions;
        table($('[data-list]', body), { columns: txColumns(), rows, empty: 'No transactions match.', onRow: (t) => openTrail(base(), t) });
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
          ${kpi('Overdue', esc(rp(r.byDay.filter((d) => d.overdue).reduce((a, d) => a + d.net, 0))), 'past the expected settlement date', r.byDay.some((d) => d.overdue) ? 'warn' : '')}
          ${r.postpay?.count ? kpi('Post-pay not charged', esc(rp(r.postpay.amount)), esc(`${fmt.num(r.postpay.count)} sessions${r.postpay.failed ? ` · ${fmt.num(r.postpay.failed)} failed` : ''}`), r.postpay.failed ? 'warn' : '') : ''}</div>
        ${r.hubFeeInvoices?.length || r.hubPositions?.length ? '<div class="card section" data-hub-recv></div>' : ''}
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
      table($('[data-rows]', body), { columns: txColumns(), rows: r.rows, empty: 'Nothing waiting to settle.', onRow: (t) => openTrail(base(), t) });
      // (v1.15.0) PlugSure Hub: its fee invoices not paid (platform), or settlement positions owed to this operator.
      const hub = $('[data-hub-recv]', body);
      if (hub && r.hubFeeInvoices?.length) {
        hub.innerHTML = '<header><h3>PlugSure Hub fee invoices unpaid</h3><a class="btn sm right" href="#/hub">Open Hub</a></header><div data-t></div>';
        table($('[data-t]', hub), { columns: [
          { label: 'Invoice', render: (h) => `<span class="mono">${esc(h.number)}</span><div class="cell-sub">${esc(h.member ?? '')}</div>` },
          { label: 'Due', render: (h) => `${esc(fmt.date(h.dueDate))}${h.overdue ? ` ${tag('t-crit', 'overdue')}` : ''}` },
          { label: 'Total', num: true, render: (h) => esc(fmt.money(h.total, h.currency)) },
        ], rows: r.hubFeeInvoices, empty: '' });
      } else if (hub) {
        hub.innerHTML = '<header><h3>Owed to you through PlugSure Hub</h3></header><div data-t></div>';
        table($('[data-t]', hub), { columns: hubPositionColumns('From'), rows: r.hubPositions, empty: '' });
      }
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
        <div class="section" data-bankreq></div>
        <div class="section" data-oq></div>
        <div class="section" data-owner-shares></div>
        ${r.hubPositions?.length ? '<div class="card section"><header><h3>Owed through PlugSure Hub</h3></header><div data-hub-pay></div></div>' : ''}`;
      if (r.hubPositions?.length) table($('[data-hub-pay]', body), { columns: hubPositionColumns('To'), rows: r.hubPositions, empty: '' });
      table($('[data-refunds]', body), {
        columns: [
          { label: 'Paid', render: (x) => `${esc(fmt.time(x.paidAt))}<div class="cell-sub">${esc(x.channel ?? '')} · <span class="mono">${esc(x.reference ?? '')}</span></div>` },
          { label: 'Amount', num: true, render: (x) => `<b>${esc(rp(x.amount))}</b>` },
          { label: 'Status', render: (x) => tag(x.state === 'failed' ? 't-crit' : x.state === 'processing' ? 't-info' : 't-warn', x.state) },
          { label: 'Refund window', render: (x) => (x.daysLeft == null ? '<span class="cell-sub">bank transfer</span>' : x.daysLeft < 0 ? tag('t-crit', 'closed: bank transfer') : `${x.daysLeft <= 7 ? tag('t-warn', `${x.daysLeft} days left`) : esc(`${x.daysLeft} days left`)}<div class="cell-sub">${esc(x.channel)} allows ${esc(String(x.refundWindowDays))} days</div>`) },
          { label: 'Reason', render: (x) => `<span class="cell-sub wrap">${esc(x.reason ?? '')}</span>${x.operator ? `<div class="cell-sub">${esc(x.operator)}</div>` : ''}` },
        ], rows: r.refunds, empty: 'No refunds due.',
      });
      bankRequestsSection($('[data-bankreq]', body), canWrite);
      ownerQueriesSection($('[data-oq]', body), canWrite);
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
        <div class="section" data-feeaudit></div>
        <div class="card section"><header><h3>Fees by month and channel</h3></header><div data-rows></div></div>
        <p class="cell-sub">Fees, VAT on fees and withholding tax as ${gw()} reports them on each payment. The estimate is the Bank Indonesia QRIS MDR (0% up to ${esc(rp(100000))}); from v1.15.0 owner statements use the actual fee for every payment synced here, and the estimate only for the rest.</p>`;
      feeAuditSection($('[data-feeaudit]', body), base(), per(), gw());
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
      // (v1.16.0) What each method costs, across the gateway accounts you can see: to choose which methods to offer.
      body.insertAdjacentHTML('beforeend', `<div class="card section"><header><h3>What each method costs</h3></header><div data-costs><div class="empty-state"><span class="spinner"></span></div></div></div>
        <p class="cell-sub">Over the period, from each gateway's ledger: the fee and VAT per payment, and per ${esc(rp(100000))} collected. <i>Quoted</i>: what Duitku's project lists today for ${esc(rp(100000))}, including methods not used yet.</p>`);
      try {
        const c = await api(`/v1/finance/method-costs?${per()}`);
        const rows = [];
        for (const a of c.accounts) {
          const used = new Set(a.methods.map((m) => m.channel));
          for (const m of a.methods) rows.push({ ...m, account: a.label, quotedFee: a.quoted?.find((q) => q.channel === m.channel)?.fee ?? null });
          for (const q of a.quoted ?? []) if (!used.has(q.channel)) rows.push({ channel: q.channel, account: a.label, payments: 0, averageFee: null, rate: null, per100k: null, quotedFee: q.fee });
        }
        rows.sort((x, y) => String(x.channel).localeCompare(String(y.channel)) || (x.per100k ?? x.quotedFee ?? 1e12) - (y.per100k ?? y.quotedFee ?? 1e12));
        const cheapest = new Map();
        for (const x of rows) { const v = x.per100k ?? x.quotedFee; if (v != null && (!cheapest.has(x.channel) || v < cheapest.get(x.channel))) cheapest.set(x.channel, v); }
        table($('[data-costs]', body), {
          columns: [
            { label: 'Method', render: (x) => `<b>${esc(x.channel)}</b>` },
            { label: 'Account', render: (x) => esc(x.account) },
            { label: 'Payments', num: true, render: (x) => (x.payments ? esc(fmt.num(x.payments)) : '<span class="cell-sub">not used</span>') },
            { label: 'Average fee', num: true, render: (x) => (x.averageFee == null ? '—' : esc(rp(x.averageFee))) },
            { label: 'Rate', num: true, render: (x) => esc(pct(x.rate)) },
            { label: `Per ${rp(100000)}`, num: true, render: (x) => (x.per100k == null ? '—' : `<b>${esc(rp(x.per100k))}</b>${x.per100k === cheapest.get(x.channel) && rows.filter((y) => y.channel === x.channel).length > 1 ? ` ${tag('t-ok', 'lowest')}` : ''}`) },
            { label: 'Quoted', num: true, render: (x) => (x.quotedFee == null ? '—' : `${esc(rp(x.quotedFee))}${x.per100k == null && x.quotedFee === cheapest.get(x.channel) && rows.filter((y) => y.channel === x.channel).length > 1 ? ` ${tag('t-ok', 'lowest')}` : ''}`) },
          ], rows, empty: 'No payments in this period.',
        });
      } catch (e) { $('[data-costs]', body).innerHTML = callout('crit', esc(e.message)); }
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

    // (v1.17.0) The accounting journal's chart of accounts and the monthly close e-mail, per account.
    const drawSettings = async () => {
      load();
      const r = await api(`${base()}/settings`);
      const st = r.settings, ce = st.closeEmail;
      body.innerHTML = `
        <div class="card section" style="margin-top:0"><header><h3>Accounting journal</h3><button class="btn sm right" type="button" data-jdl>${icon('download')} Journal (Excel)</button></header>
          <div class="body"><p class="cell-sub" style="margin-top:0">The Journal export turns the period into double-entry entries, one per day and kind: collections, gateway fees and VAT on fees, withholding tax, refunds, withdrawals to the bank, and owner payouts. Set your chart of accounts' codes; the rest keep PlugSure's defaults.</p>
          <div class="form" data-accts>${Object.keys(r.defaults).map((k) => field(r.labels[k], `<div class="row" style="gap:6px"><input name="code_${k}" value="${esc(st.journalAccounts[k].code)}" maxlength="20" style="width:90px"${canWrite ? '' : ' disabled'}><input name="name_${k}" value="${esc(st.journalAccounts[k].name)}" maxlength="80" style="flex:1"${canWrite ? '' : ' disabled'}></div>`)).join('')}</div></div></div>
        <div class="card section"><header><h3>Monthly close e-mail</h3></header><div class="body">
          <p class="cell-sub" style="margin-top:0">On the 1st of each month, the previous month's finance export (Excel and PDF) and journal go to these addresses, through your e-mail channel (Govern → Alert routing → Channels).</p>
          <div class="form one">
            <label class="check"><input type="checkbox" name="ce_on"${ce.enabled ? ' checked' : ''}${canWrite ? '' : ' disabled'}><span>Send the monthly close</span></label>
            ${field('Recipients', `<input name="ce_to" value="${esc(ce.recipients.join(', '))}" placeholder="finance@yourcompany.co.id, accountant@firm.co.id"${canWrite ? '' : ' disabled'}>`, { help: 'Up to 10, separated by commas.' })}
          </div>
          <div class="cell-sub">${ce.sentPeriod ? `Last sent: ${esc(ce.sentPeriod)}` : 'Not sent yet.'}${ce.lastError ? ` <span style="color:var(--crit)">Last attempt failed: ${esc(ce.lastError)}</span>` : ''}</div>
        </div></div>
        <div class="card section"><header><h3>Contracted rates</h3></header><div class="body">
          <p class="cell-sub" style="margin-top:0">The fees you agreed with ${gw()} per method, excluding VAT: a percentage plus a fixed fee, an optional minimum, and the amount up to which the method is free (QRIS: ${esc(rp(100000))}). Every fee is checked against them under Fees → Fee audit. Leave a method's percentage empty to not check it.</p>
          <table class="table" data-rates><thead><tr><th>Method</th><th class="num">%</th><th class="num">Fixed (Rp)</th><th class="num">Minimum (Rp)</th><th class="num">Free up to (Rp)</th></tr></thead><tbody>
          ${[...new Set([...RATE_METHODS, ...Object.keys(st.contractRates ?? {})])].map((m) => { const v = st.contractRates?.[m] ?? {}; const inp = (k, w) => `<input name="r_${k}_${esc(m)}" value="${v[k] ?? ''}" inputmode="decimal" style="width:${w}px"${canWrite ? '' : ' disabled'}>`; return `<tr><td class="mono">${esc(m)}</td><td class="num">${inp('pct', 70)}</td><td class="num">${inp('fixed', 90)}</td><td class="num">${inp('min', 90)}</td><td class="num">${inp('freeUpTo', 110)}</td></tr>`; }).join('')}
          </tbody></table></div></div>
        ${canWrite ? '<div class="row" style="gap:8px"><button class="btn primary" type="button" data-save>Save</button><button class="btn" type="button" data-send>Send last month now</button></div>' : ''}
        <div class="section" data-acct-sw></div>
        <div data-p10></div>
        <div data-p11></div>
        <div data-p13></div><div data-p16></div>`;
      accountingSection($('[data-acct-sw]', body), base(), canWrite, st.accountingPackage);
      phase10Settings($('[data-p10]', body), canWrite);
      phase11Settings($('[data-p11]', body), canWrite);
      exportSettings($('[data-p13]', body), canWrite);
      digestSettings($('[data-p16]', body), canWrite);
      $('[data-jdl]', body).addEventListener('click', () => $('[data-journal]', bodyAll).click());
      $('[data-save]', body)?.addEventListener('click', async () => {
        const journalAccounts = Object.fromEntries(Object.keys(r.defaults).map((k) => [k, { code: $(`[name="code_${k}"]`, body).value.trim(), name: $(`[name="name_${k}"]`, body).value.trim() }]));
        try {
          const contractRates = {};
          for (const tr of $$('[data-rates] tbody tr', body)) {
            const m = tr.firstElementChild.textContent.trim();
            const val = (k) => $(`[name="r_${k}_${m}"]`, tr)?.value.trim().replace(',', '.');
            if (!val('pct')) continue;
            contractRates[m] = Object.fromEntries(['pct', 'fixed', 'min', 'freeUpTo'].filter((k) => val(k)).map((k) => [k, Number(val(k))]));
          }
          await api(`${base()}/settings`, { method: 'PUT', body: { journalAccounts, contractRates, closeEmail: { enabled: $('[name="ce_on"]', body).checked, recipients: $('[name="ce_to"]', body).value } } });
          toast('Saved.', 'ok');
          drawSettings();
        } catch (e) { toast(e.message, 'crit'); }
      });
      $('[data-send]', body)?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        try { const x = await api(`${base()}/close-email/send`, { method: 'POST', body: {} }); toast(`Sent the close for ${x.month} to ${x.to.join(', ')}.`, 'ok'); } catch (err) { toast(err.message, 'crit'); }
        e.currentTarget.disabled = false;
      });
    };

    const DRAW = { overview: drawOverview, payments: drawPayments, receivables: drawReceivables, payables: drawPayables, fees: drawFees, reconciliation: drawReconciliation, settings: drawSettings,
      bank: () => bankSection(body, canWrite), tax: () => taxSection(body, canWrite),
      forecast: () => { load(); return forecastSection(body, base(), gw()); },
      summary: () => summarySection(body),
      margin: () => marginSection(body, canWrite), budgets: () => budgetsSection(body, canWrite), collections: () => collectionsSection(body, canWrite),
      investments: () => investmentsSection(body, canWrite), close: () => closeSection(body, canWrite),
      pnl: () => pnlSection(body, canWrite), settlements: () => settlementsSection(body, base(), canWrite),
      yearend: () => yearEndSection(body, canWrite),
      roaming: () => roamingSection(body, canWrite), controls: () => controlsSection(body),
      subscriptions: () => subscriptionsSection(body, canWrite), ppn: () => ppnSection(body, canWrite), autopay: () => autoPayoutsSection(body, canWrite),
      tariffs: () => tariffsSection(body, canWrite), fleetauto: () => fleetAutoSection(body),
      funds: () => driverFundsSection(body, canWrite), group: () => groupSection(body, canWrite), rforecast: () => rollingSection(body, canWrite), plans: () => plansSection(body, canWrite),
      assets: () => assetsSection(body, canWrite), bills: () => billsSection(body, canWrite), cash: () => cashSection(body, canWrite), benchmark: () => benchmarkSection(body),
      orders: () => ordersSection(body, canWrite), leases: () => leasesSection(body, canWrite), treasury: () => treasurySection(body, canWrite), review: () => reviewSection(body, canWrite),
      ledger: () => ledgerSection(body, canWrite), expenses: () => expensesSection(body, canWrite), intercompany: () => intercompanySection(body, canWrite), scorecard: () => scorecardSection(body, canWrite),
      feeds: () => feedsSection(body, canWrite), slips: () => slipsSection(body, canWrite), reports: () => reportsSection(body, canWrite), closesteps: () => closeStepsSection(body, canWrite),
      payroll: () => payrollSection(body, canWrite), credit: () => creditSection(body, canWrite), projects: () => projectsSection(body, canWrite), cashforecast: () => cashForecastSection(body, canWrite),
      inventory: () => inventorySection(body, canWrite), maintenance: () => maintenanceSection(body, canWrite), assurance: () => assuranceSection(body, canWrite), lenders: () => lendersSection(body, canWrite),
      carbon: () => carbonSection(body, canWrite), insurance: () => insuranceSection(body, canWrite), pricing: () => pricingSection(body, canWrite), compliance: () => complianceSection(body, canWrite),
      grants: () => grantsSection(body, canWrite), landlords: () => landlordsSection(body, canWrite), chargebacks: () => chargebacksSection(body, canWrite),
      loyaltycost: () => loyaltyCostSection(body, canWrite), taxaudit: () => taxAuditSection(body, canWrite), portfolio: () => portfolioSection(body, canWrite), planning: () => planningSection(body, canWrite),
      fxtreasury: () => fxTreasurySection(body, canWrite), procurement: () => procurementSection(body, canWrite), closeauto: () => closeAutoSection(body, canWrite), ownerfinance: () => ownerFinanceSection(body, canWrite),
      statutory: () => statutorySection(body, canWrite), corptax: () => corpTaxSection(body, canWrite), payruns: () => payRunsSection(body, canWrite), cards: () => cardsSection(body, canWrite),
      contracts: () => contractsSection(body, canWrite), netting: () => nettingSection(body, canWrite), dataquality: () => dataQualitySection(body, canWrite), scenarios: () => scenariosSection(body, canWrite) };
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
    // (v1.16.0) Xendit's own reports, generated on request; the button only for a Xendit account.
    const reportsBtn = $('[data-reports]', bodyAll);
    const showReportsBtn = () => { reportsBtn.hidden = isDuitku(); };
    showReportsBtn();
    $('[data-acct]', bodyAll).addEventListener('change', () => setTimeout(showReportsBtn));
    const RTYPE = { TRANSACTIONS: 'Transactions', BALANCE_HISTORY: 'Balance history', UPCOMING_TRANSACTIONS: 'Upcoming settlements' };
    reportsBtn.addEventListener('click', () => {
      let timer = null;
      const m = modal({
        title: 'Xendit reports', subtitle: 'Generated by Xendit as CSV; ready in a few minutes',
        size: 'lg',
        body: `<div class="filters" style="margin-top:0">${field('Report', `<select name="rtype">${Object.entries(RTYPE).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>`)}
            <div class="row" style="align-self:flex-end"><button class="btn primary" type="button" data-rq>Request for ${esc(from)} – ${esc(to)}</button></div></div>
          <p class="cell-sub">Upcoming settlements cover the next 30 days whatever the period. The secret key needs Xendit's Report permission.</p>
          <div data-rlist></div>`,
        actions: [{ label: 'Close' }],
        onClose: () => clearTimeout(timer),
      });
      const box = () => $('[data-rlist]', m.el);
      const draw = async () => {
        let r;
        try { r = await api(`${base()}/reports`); } catch (e) { box().innerHTML = callout('crit', esc(e.message)); return; }
        // Pending ones: ask Xendit again (one call each), then redraw while any stays pending.
        const pending = r.reports.filter((x) => x.status === 'PENDING');
        if (pending.length) r.reports = await Promise.all(r.reports.map((x) => (x.status === 'PENDING' ? api(`${base()}/reports/${x.id}`).then((y) => y.report).catch(() => x) : x)));
        table(box(), {
          columns: [
            { label: 'Report', render: (x) => `${esc(RTYPE[x.type] ?? x.type)}<div class="cell-sub">${esc(fmt.date(x.from))} – ${esc(fmt.date(x.to))}</div>` },
            { label: 'Requested', render: (x) => `${esc(fmt.time(x.requestedAt))}<div class="cell-sub">${esc(x.requestedBy ?? '')}</div>` },
            { label: 'Status', render: (x) => (x.status === 'COMPLETED' ? tag('t-ok', 'ready') : x.status === 'FAILED' ? tag('t-crit', 'failed') : tag('t-info', 'generating')) },
            { label: '', render: (x) => (x.status === 'COMPLETED' ? `<button class="btn sm" type="button" data-rdl="${esc(x.id)}">${icon('download')} Download</button>` : '') },
          ],
          rows: r.reports, empty: 'No reports requested yet.',
        });
        if (r.reports.some((x) => x.status === 'PENDING') && document.body.contains(m.el)) timer = setTimeout(draw, 15_000);
      };
      $('[data-rq]', m.el).addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        try { await api(`${base()}/reports?${per()}`, { method: 'POST', body: { type: $('[name="rtype"]', m.el).value } }); toast('Requested from Xendit.', 'ok'); } catch (err) { toast(err.message, 'crit'); }
        e.currentTarget.disabled = false;
        clearTimeout(timer); draw();
      });
      box().addEventListener('click', async (e) => {
        const b = e.target.closest('[data-rdl]');
        if (!b) return;
        try {
          const r = await api(`${base()}/reports/${b.dataset.rdl}?link=true`);
          if (r.report.url) window.open(r.report.url, '_blank', 'noopener'); else toast('Xendit has no link for it now. Request it again.', 'warn');
        } catch (err) { toast(err.message, 'crit'); }
      });
      draw();
    });
    $('[data-auditpack]', bodyAll).addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try { const res = await api(`${base()}/audit-pack?${per()}`, { raw: true }); download(`plugsure-audit-pack-${from}-${to}.zip`, await res.blob()); toast('Audit pack downloaded: manifest.json lists each file\'s SHA-256.', 'ok'); } catch (err) { toast(err.message, 'crit'); }
      finally { b.disabled = false; }
    });
    $('[data-journal]', bodyAll).addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try { const res = await api(`${base()}/journal?format=xlsx&${per()}`, { raw: true }); download(`plugsure-journal-${from}-${to}.xlsx`, await res.blob()); } catch (err) { toast(err.message, 'crit'); }
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
