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

const MATCH_LABEL = { gateway_withdrawal: 'Gateway payout', statement_payment: 'Statement payment', refund: 'Refund', ignored: 'Ignored' };

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
  el.innerHTML = `<div class="card"><header><h3>PPh 23 withheld</h3><div class="row nowrap" style="gap:6px"><select data-year>${[thisYear, thisYear - 1, thisYear - 2].map((v) => `<option${v === year ? ' selected' : ''}>${v}</option>`).join('')}</select><button class="btn sm" type="button" data-csv>${icon('download')} CSV</button></div></header>
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

const KIND_LBL = { refund: 'Refunds', payout: 'Owner payouts', write_off: 'Write-offs', bank_change: 'Owner bank detail changes' };

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
      { id: 'summary', label: 'Summary' }, { id: 'overview', label: 'Overview' }, { id: 'payments', label: 'Payments' }, { id: 'receivables', label: 'Receivables' },
      { id: 'payables', label: 'Payables' }, { id: 'collections', label: 'Collections' }, { id: 'forecast', label: 'Forecast' }, { id: 'fees', label: 'Fees' }, { id: 'reconciliation', label: 'Reconciliation' },
      { id: 'bank', label: 'Bank' }, { id: 'tax', label: 'Tax' }, { id: 'margin', label: 'Margin' }, { id: 'budgets', label: 'Budgets' }, { id: 'settings', label: 'Settings' },
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
        <div data-p10></div>`;
      accountingSection($('[data-acct-sw]', body), base(), canWrite, st.accountingPackage);
      phase10Settings($('[data-p10]', body), canWrite);
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
      margin: () => marginSection(body, canWrite), budgets: () => budgetsSection(body, canWrite), collections: () => collectionsSection(body, canWrite) };
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
