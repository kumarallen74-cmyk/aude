import {
  $, $$, esc, api, state, registerView, pageHead, icon, field, callout, table, fmt, tag, drawer, modal, confirmDialog, html, toast, kpi, download, formValues,
} from '../core.js';
import { recentMonths, monthLabel } from './statement-render.js';

/**
 * Fleet billing — the companies fleet cards are billed to, their monthly
 * statements and invoices, payments, and the e-Faktur (Coretax) export.
 *
 *   Invoices  one month across every fleet account: draft or invoice, overdue, e-Faktur
 *   Accounts  legal and tax details, billing e-mail, terms, cards
 *   Settings  the seller's NPWP / NITKU / address, numbering, payment instructions, e-Faktur items
 */

const prevMonth = (cur) => { let [y, m] = cur.split('-').map(Number); m -= 1; if (!m) { m = 12; y -= 1; } return `${y}-${String(m).padStart(2, '0')}`; };
const statusTag = (r) =>
  r.status === 'draft' ? tag('t-info', 'draft')
  : r.status === 'paid' ? tag('t-ok', 'paid')
  : r.status === 'void' ? tag('t-mute', 'void')
  : r.overdue ? tag('t-crit', 'overdue') : tag('t-warn', 'issued');
const kwh = (wh) => fmt.num((Number(wh) || 0) / 1000, 1);
const open = (url) => window.open(url, '_blank', 'noopener');

registerView('fleet-billing', {
  title: 'Fleet billing',
  icon: 'file',
  group: 'commercial',
  order: 27,
  perm: 'invoice:read',
  async render(root, [tabParam]) {
    const canWrite = state.can('invoice:write');
    root.innerHTML = pageHead(
      'Fleet billing',
      'Monthly invoices for the companies your fleet cards belong to: charging at your stations with PBJT-TL and PPN on DPP nilai lain, charging on partner networks re-billed at cost, and the e-Faktur file for Coretax.',
      '',
    ) + `<div class="tabs" role="tablist">
        <button type="button" data-tab="invoices">Invoices</button><button type="button" data-tab="credits">Credit notes</button><button type="button" data-tab="accounts">Accounts</button>${canWrite ? '<button type="button" data-tab="settings">Settings</button>' : ''}
      </div><div data-body></div>`;
    const body = $('[data-body]', root);
    const show = (t) => {
      $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
      history.replaceState(null, '', `#/fleet-billing/${t}`);
      ({ invoices: renderInvoices, credits: renderCredits, accounts: renderAccounts, settings: renderSettings }[t] ?? renderInvoices)(body, canWrite);
    };
    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    show(['invoices', 'credits', 'accounts', 'settings'].includes(tabParam) ? tabParam : 'invoices');
  },
});

// ─────────────────────────────────────────── invoices (one month)

async function renderInvoices(box, canWrite) {
  box.innerHTML = `<div class="filters">${field('Month', '<select data-month></select>')}
      <div class="grow"></div>
      <button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button>
      ${canWrite ? `<button class="btn" type="button" data-efaktur>${icon('download')} e-Faktur XML</button>
      <button class="btn primary" type="button" data-issue-all>Issue all invoices</button>` : ''}</div>
    <div data-notes></div><div class="grid k4 section" data-kpis></div><div class="card section" data-list></div>`;
  let data = null;
  let current = null;
  const load = async (period) => {
    try {
      if (!current) current = (await api(`/v1/fleet-billing/periods/2000-01`)).current;
      const p = period || $('[data-month]', box).value || prevMonth(current);
      data = await api(`/v1/fleet-billing/periods/${p}`);
    } catch (e) {
      $('[data-list]', box).innerHTML = `<div class="body">${callout('crit', esc(e.status === 403 ? 'Fleet billing needs invoice access.' : e.message))}</div>`;
      return;
    }
    const sel = $('[data-month]', box);
    if (!sel.options.length) sel.innerHTML = recentMonths(current).map((m) => `<option value="${m}">${esc(monthLabel(m))}${m === current ? ' (so far)' : ''}</option>`).join('');
    sel.value = data.period;
    const rows = data.rows;
    const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const drafts = rows.filter((r) => r.status === 'draft').length;
    $('[data-kpis]', box).innerHTML = [
      kpi('Fleet accounts billed', fmt.num(rows.length), `${drafts} draft · ${rows.length - drafts} invoiced`),
      kpi('Charging', `${fmt.num(sum('sessions'))} sessions`, `${kwh(sum('energyWh'))} kWh at your stations`),
      kpi('To invoice', fmt.idr(sum('totalIdr')), `PPN ${fmt.idr(sum('ppnIdr'))}${sum('roamingIdr') ? ` · partner networks ${fmt.idr(sum('roamingIdr'))}` : ''}`),
      kpi('Overdue', fmt.num(rows.filter((r) => r.overdue).length), 'invoices past their due date', rows.some((r) => r.overdue) ? 'crit' : ''),
    ].join('');
    const notes = [];
    if (!data.ended) notes.push(callout('info', `${esc(data.periodLabel)} has not ended: these are drafts. Invoices can be issued from the 1st of next month.`));
    if (data.unassigned.sessions) notes.push(callout('warn', `${fmt.num(data.unassigned.sessions)} session(s) (${fmt.idr(data.unassigned.totalIdr)}) were charged with fleet cards that are on no fleet account, so they are on no invoice. Give those cards a fleet name in the RFID centre, or add them to an account.`));
    $('[data-notes]', box).innerHTML = notes.join('');
    const iss = $('[data-issue-all]', box);
    if (iss) iss.disabled = !data.ended || !drafts;
    table($('[data-list]', box), {
      columns: [
        { label: 'Fleet account', render: (r) => `<div class="cell-title">${esc(r.name)}</div>${r.legalName && r.legalName !== r.name ? `<div class="cell-sub">${esc(r.legalName)}</div>` : ''}` },
        { label: 'Status', render: (r) => `${statusTag(r)}${r.number ? `<div class="cell-sub mono">${esc(r.number)}</div>` : ''}${r.warnings ? ` ${tag('t-warn', `${r.warnings} note${r.warnings === 1 ? '' : 's'}`)}` : ''}` },
        { label: 'Sessions', num: true, render: (r) => fmt.num(r.sessions) },
        { label: 'kWh', num: true, render: (r) => kwh(r.energyWh) },
        { label: 'PPN', num: true, render: (r) => fmt.idr(r.ppnIdr) },
        { label: 'Partner networks', num: true, render: (r) => (r.roamingIdr ? fmt.idr(r.roamingIdr) : '—') },
        { label: 'Total', num: true, render: (r) => `<b>${fmt.idr(r.totalIdr)}</b>${r.status === 'issued' && r.balanceIdr !== r.totalIdr ? `<div class="cell-sub">owed ${fmt.idr(r.balanceIdr)}</div>` : ''}` },
        { label: 'Due', render: (r) => (r.dueDate ? esc(fmt.date(r.dueDate)) : '—') },
        { label: 'e-Faktur', render: (r) => (r.efakturNumber ? `<span class="mono">${esc(r.efakturNumber)}</span>` : r.efakturExported ? tag('t-info', 'exported') : '—') },
      ],
      rows,
      empty: `No fleet charging in ${esc(data.periodLabel)}.`,
      onRow: (r) => openRow(r),
    });
  };

  const openRow = (r) => {
    const period = data.period;
    const inv = r.invoiceId;
    const d = drawer({
      title: r.name,
      subtitle: `${esc(data.periodLabel)}${r.number ? ` · <span class="mono">${esc(r.number)}</span>` : ' · draft'}`,
      headerHtml: `<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
        <button class="btn sm" type="button" data-pdf>${icon('download')} PDF</button>
        <button class="btn sm" type="button" data-print>Print</button>
        ${inv ? '<button class="btn sm" type="button" data-csv>Sessions CSV</button>' : ''}
        ${canWrite && inv && (r.status === 'issued' || r.status === 'paid') ? '<button class="btn sm" type="button" data-credit>Credit note</button>' : ''}
        ${canWrite && !inv && data.ended ? '<button class="btn sm primary" type="button" data-issue>Issue invoice</button>' : ''}
        ${canWrite && inv && r.status !== 'void' ? '<button class="btn sm" type="button" data-send>E-mail</button>' : ''}
        ${canWrite && inv && r.status === 'issued' ? '<button class="btn sm primary" type="button" data-pay>Record payment</button>' : ''}
        ${canWrite && inv ? '<button class="btn sm" type="button" data-faktur>Faktur number</button>' : ''}
        ${canWrite && inv && r.status === 'issued' ? '<button class="btn sm danger" type="button" data-void>Void</button>' : ''}</div>`,
      tabs: [{
        id: 'statement', label: inv ? 'Invoice' : 'Draft',
        async render(b) {
          const st = inv ? await api(`/v1/fleet-invoices/${inv}`) : await api(`/v1/fleet-accounts/${r.accountId}/statement?period=${period}`);
          renderStatement(b, st, canWrite, () => d.refresh());
        },
      }],
      onClose: () => load(period),
    });
    const on = (sel, fn) => $(sel, d.el)?.addEventListener('click', fn);
    on('[data-pdf]', () => open(inv ? `/v1/fleet-invoices/${inv}/invoice.pdf` : `/v1/fleet-accounts/${r.accountId}/statement.pdf?period=${period}`));
    on('[data-credit]', async () => creditNoteDialog(await api(`/v1/fleet-invoices/${inv}`), () => d.refresh()));
    on('[data-print]', () => open(inv ? `/v1/fleet-invoices/${inv}/invoice.html` : `/v1/fleet-accounts/${r.accountId}/statement.html?period=${period}`));
    on('[data-csv]', () => open(`/v1/fleet-invoices/${inv}/invoice.csv`));
    on('[data-issue]', async () => {
      const ok = await confirmDialog({ title: `Issue the ${monthLabel(period)} invoice?`, message: html`An invoice for <b>${r.name}</b> of <b>${fmt.idr(r.totalIdr)}</b> is numbered and frozen. Charges added later go on next month's invoice.`, confirmLabel: 'Issue invoice' });
      if (!ok) return;
      try { const x = await api('/v1/fleet-invoices', { method: 'POST', body: { fleetAccountId: r.accountId, period } }); toast(`Invoice ${x.number} issued`, 'ok'); d.close(); }
      catch (e) { toast(e.message, 'crit'); }
    });
    on('[data-send]', () => modal({
      title: 'E-mail the invoice',
      body: `<div class="form one">${field('To', '<input name="to" placeholder="the account\'s billing e-mail" autocomplete="off">', { help: 'Leave empty to use the billing e-mail on the fleet account. Sent through your e-mail channel (Alert routing), with the invoice and the session list attached.' })}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Send', kind: 'primary', async onClick(ctx) {
        try { const x = await api(`/v1/fleet-invoices/${inv}/send`, { method: 'POST', body: { to: $('[name="to"]', ctx.body).value.trim() || undefined } }); toast(`Sent to ${x.to}`, 'ok'); d.refresh(); }
        catch (e) { toast(e.message, 'crit'); return false; }
      } }],
    }));
    on('[data-pay]', () => modal({
      title: 'Record payment',
      body: `<div class="form one">${field('Paid on', `<input name="paidAt" type="date" value="${new Date().toISOString().slice(0, 10)}">`)}${field('Reference', '<input name="reference" placeholder="bank transfer reference" autocomplete="off">', { opt: true })}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Record payment', kind: 'primary', async onClick(ctx) {
        try { await api(`/v1/fleet-invoices/${inv}/pay`, { method: 'POST', body: formValues(ctx.body) }); toast('Payment recorded', 'ok'); d.close(); }
        catch (e) { toast(e.message, 'crit'); return false; }
      } }],
    }));
    on('[data-faktur]', () => modal({
      title: 'Faktur pajak number',
      body: `<div class="form one">${field('Number from Coretax', `<input name="number" value="${esc(r.efakturNumber ?? '')}" placeholder="e.g. 04002600000012345" autocomplete="off">`, { help: 'The number Coretax gave the faktur when you approved it. It is printed on the invoice.' })}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(ctx) {
        try { await api(`/v1/fleet-invoices/${inv}/faktur-number`, { method: 'PUT', body: { number: $('[name="number"]', ctx.body).value.trim() || null } }); toast('Saved', 'ok'); d.close(); }
        catch (e) { toast(e.message, 'crit'); return false; }
      } }],
    }));
    on('[data-void]', () => modal({
      title: `Void ${r.number}?`,
      body: `${callout('warn', 'The invoice keeps its number and is marked void; its sessions go back to the draft so a corrected invoice can be issued.')}
        <div class="form one" style="margin-top:10px">${field('Reason', '<input name="reason" placeholder="e.g. wrong NPWP" autocomplete="off">')}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Void invoice', kind: 'danger', async onClick(ctx) {
        try {
          const x = await api(`/v1/fleet-invoices/${inv}/void`, { method: 'POST', body: { reason: $('[name="reason"]', ctx.body).value.trim() } });
          toast('Invoice voided', 'ok');
          if (x.fakturWarning) setTimeout(() => modal({ title: 'Faktur pajak', body: callout('warn', esc(x.fakturWarning)) }), 50);
          d.close();
        } catch (e) { toast(e.message, 'crit'); return false; }
      } }],
    }));
  };

  $('[data-month]', box).addEventListener('change', () => load());
  $('[data-refresh]', box).addEventListener('click', () => load());
  $('[data-issue-all]', box)?.addEventListener('click', async () => {
    const drafts = data.rows.filter((r) => r.status === 'draft');
    const ok = await confirmDialog({ title: `Issue ${drafts.length} invoice(s) for ${monthLabel(data.period)}?`, message: `Totalling ${fmt.idr(drafts.reduce((a, r) => a + r.totalIdr, 0))}. Each is numbered and frozen.`, confirmLabel: 'Issue all' });
    if (!ok) return;
    try {
      const r = await api(`/v1/fleet-billing/periods/${data.period}/issue`, { method: 'POST' });
      toast(`${r.issued.length} invoice(s) issued${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`, r.skipped.length ? 'warn' : 'ok');
      load(data.period);
    } catch (e) { toast(e.message, 'crit'); }
  });
  $('[data-efaktur]', box)?.addEventListener('click', async () => {
    try {
      const res = await fetch(`/v1/fleet-billing/periods/${data.period}/efaktur.xml`, { credentials: 'same-origin' });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
      const skipped = JSON.parse(decodeURIComponent(res.headers.get('x-plugsure-skipped') || '%5B%5D'));
      const included = (res.headers.get('x-plugsure-included') || '').split(',').filter(Boolean);
      download(`efaktur-${data.period}.xml`, await res.blob());
      modal({
        title: 'e-Faktur file downloaded',
        body: `<p>${included.length} faktur(s): ${included.map((n) => `<span class="mono">${esc(n)}</span>`).join(', ')}</p>
          ${skipped.length ? callout('warn', `Skipped: ${skipped.map((s) => `${esc(s.number)} (${esc(s.reason)})`).join('; ')}`) : ''}
          <p class="cell-sub">In Coretax: <b>Faktur Pajak → Pajak Keluaran → Impor Data</b>, choose this file, check the drafts, then upload/sign them. Record each faktur number back here (Faktur number).</p>`,
      });
      load(data.period);
    } catch (e) { toast(e.message, 'crit'); }
  });
  await load();
}

const SETTLE = { invoice: 'reduces this invoice', refund: 'to refund', next_invoice: 'off the next invoice' };

/** Credit notes against an invoice (and earlier ones deducted from it), with what can be done to each. */
function creditSection(st, canWrite, refresh) {
  const prior = st.priorCredits ?? [];
  const notes = st.creditNotes ?? [];
  if (!prior.length && !notes.length) return '';
  const rows = [
    ...prior.map((c) => `<tr><td>Credit note <span class="mono">${esc(c.number)}</span> <span class="cell-sub">from invoice ${esc(c.invoiceNumber)}, deducted here</span></td><td class="num">− ${fmt.idr(c.totalIdr)}</td><td></td></tr>`),
    ...notes.map((c) => `<tr><td>${c.status === 'void' ? tag('t-mute', 'void') : ''} Credit note <span class="mono">${esc(c.number)}</span> <span class="cell-sub">${esc(c.reason)} · ${esc(SETTLE[c.settlement])}${c.settlement === 'refund' ? (c.refundedAt ? `, refunded ${esc(fmt.date(c.refundedAt))}` : ', not refunded yet') : ''}${c.settlement === 'next_invoice' && c.applied ? ', deducted' : ''}</span></td>
      <td class="num">${c.status === 'void' ? `<s>${fmt.idr(c.totalIdr)}</s>` : `− ${fmt.idr(c.totalIdr)}`}</td>
      <td class="num nowrap"><button class="btn sm ghost" type="button" data-cn-pdf="${esc(c.id)}">PDF</button>${canWrite && c.status === 'issued' ? `<button class="btn sm ghost" type="button" data-cn-send="${esc(c.id)}">E-mail</button>${c.settlement === 'refund' && !c.refundedAt ? `<button class="btn sm ghost" type="button" data-cn-refunded="${esc(c.id)}">Refunded</button>` : ''}${!c.refundedAt && !c.applied ? `<button class="btn sm ghost" type="button" data-cn-void="${esc(c.id)}">Void</button>` : ''}` : ''}</td></tr>`),
  ].join('');
  return `<div class="cell-sub" style="margin-top:12px">Credits</div><table class="t"><tbody>${rows}
    ${st.status === 'issued' ? `<tr><td><b>Still owed</b></td><td class="num"><b>${fmt.idr(st.balanceIdr)}</b></td><td></td></tr>` : ''}</tbody></table>`;
}

function wireCreditActions(scope, refresh) {
  $$('[data-cn-pdf]', scope).forEach((x) => { if (!x.dataset.w) { x.dataset.w = 1; x.addEventListener('click', () => open(`/v1/fleet-credit-notes/${x.dataset.cnPdf}/credit-note.pdf`)); } });
  $$('[data-cn-send]', scope).forEach((x) => { if (!x.dataset.w) { x.dataset.w = 1; x.addEventListener('click', async () => {
    try { const r = await api(`/v1/fleet-credit-notes/${x.dataset.cnSend}/send`, { method: 'POST', body: {} }); toast(`Sent to ${r.to}`, 'ok'); refresh?.(); } catch (e) { toast(e.message, 'crit'); }
  }); } });
  $$('[data-cn-refunded]', scope).forEach((x) => { if (!x.dataset.w) { x.dataset.w = 1; x.addEventListener('click', () => modal({
    title: 'Record the refund',
    body: `<div class="form one">${field('Refunded on', `<input name="refundedAt" type="date" value="${new Date().toISOString().slice(0, 10)}">`)}${field('Reference', '<input name="reference" placeholder="bank transfer reference" autocomplete="off">', { opt: true })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(ctx) {
      try { await api(`/v1/fleet-credit-notes/${x.dataset.cnRefunded}/refunded`, { method: 'POST', body: formValues(ctx.body) }); toast('Refund recorded', 'ok'); refresh?.(); }
      catch (e) { toast(e.message, 'crit'); return false; }
    } }],
  })); } });
  $$('[data-cn-void]', scope).forEach((x) => { if (!x.dataset.w) { x.dataset.w = 1; x.addEventListener('click', () => modal({
    title: 'Void the credit note?',
    body: `${callout('warn', 'Only for a credit note issued in error. What it credited is owed again.')}<div class="form one" style="margin-top:10px">${field('Reason', '<input name="reason" placeholder="e.g. issued against the wrong invoice" autocomplete="off">')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Void credit note', kind: 'danger', async onClick(ctx) {
      try { await api(`/v1/fleet-credit-notes/${x.dataset.cnVoid}/void`, { method: 'POST', body: { reason: $('[name="reason"]', ctx.body).value.trim() } }); toast('Credit note voided', 'ok'); refresh?.(); }
      catch (e) { toast(e.message, 'crit'); return false; }
    } }],
  })); } });
}

/** Issue a credit note against an invoice: the whole of what is left, or lines of an amount each. */
function creditNoteDialog(st, done) {
  const paid = st.status === 'paid';
  const taxed = st.totals.ppnIdr > 0;
  const lineRow = () => `<div class="row" data-line style="gap:6px;margin-bottom:6px"><input name="description" placeholder="What is credited, e.g. session 12 Aug billed twice" style="flex:3" autocomplete="off">
    <input name="amountIdr" inputmode="numeric" placeholder="Rp, incl. PPN" style="flex:1;min-width:110px">
    ${taxed ? '<label class="check" title="The amount includes PPN (split into DPP and PPN like an invoice line)"><input type="checkbox" name="taxed" checked> <span>PPN</span></label>' : ''}</div>`;
  modal({
    title: `Credit note on ${st.number}`,
    size: 'lg',
    body: `${callout('info', `The invoice stays as it is (its figures match the faktur pajak). ${paid ? 'It has been paid, so the credit is refunded or deducted from the next invoice.' : `It is not paid yet: the credit reduces what is owed (now ${fmt.idr(st.balanceIdr)}).`}`)}
      <div class="form one" style="margin-top:10px">
        ${field('Reason', '<input name="reason" maxlength="500" placeholder="Printed on the credit note" autocomplete="off">')}
        <div class="field"><label>What to credit</label>
          <label class="check"><input type="radio" name="kind" value="full"> <span>Everything still creditable on the invoice</span></label>
          <label class="check"><input type="radio" name="kind" value="lines" checked> <span>Lines of an amount each</span></label></div>
        <div data-lines>${lineRow()}<button class="btn sm ghost" type="button" data-add-line>${icon('plus')} Add line</button>
          <div class="help">Amounts are what the customer gets back, PPN included${taxed ? '; with "PPN" ticked the amount is split into DPP (11/12) and PPN (12% of DPP), reversing the tax like an invoice line. Untick for partner-network charges, which carry no PPN of ours' : ''}.</div></div>
        ${paid ? `<div class="field"><label>Settle by</label>${`<select name="settlement"><option value="refund">Refund to the customer</option><option value="next_invoice">Deduct from their next invoice</option></select>`}</div>` : ''}
      </div>`,
    onMount(ctx) {
      const box = $('[data-lines]', ctx.body);
      $('[data-add-line]', ctx.body).addEventListener('click', (e) => e.target.closest('button').insertAdjacentHTML('beforebegin', lineRow()));
      $$('[name="kind"]', ctx.body).forEach((r) => r.addEventListener('change', () => { box.hidden = $('[name="kind"]:checked', ctx.body).value === 'full'; }));
    },
    actions: [{ label: 'Cancel' }, { label: 'Issue credit note', kind: 'primary', async onClick(ctx) {
      const full = $('[name="kind"]:checked', ctx.body).value === 'full';
      const lines = full ? undefined : $$('[data-line]', ctx.body)
        .map((l) => ({ description: $('[name="description"]', l).value.trim(), amountIdr: Number(String($('[name="amountIdr"]', l).value).replace(/\D/g, '')), taxed: taxed ? $('[name="taxed"]', l).checked : false }))
        .filter((l) => l.description || l.amountIdr);
      try {
        const r = await api(`/v1/fleet-invoices/${st.id}/credit-notes`, { method: 'POST', body: { reason: $('[name="reason"]', ctx.body).value.trim(), full: full || undefined, lines, settlement: $('[name="settlement"]', ctx.body)?.value } });
        toast(`Credit note ${r.creditNote.number} issued: ${fmt.idr(r.creditNote.totalIdr)}${r.settledInvoice ? ' — the invoice is settled' : ''}`, 'ok');
        if (r.fakturWarning) setTimeout(() => modal({ title: 'Faktur pajak', body: callout('warn', esc(r.fakturWarning)) }), 50);
        done?.();
      } catch (e) { toast(e.message, 'crit'); return false; }
    } }],
  });
}

function renderStatement(b, st, canWrite = false, refresh = null) {
  const t = st.totals;
  b.innerHTML = `${st.status === 'void' ? callout('crit', `Void: ${esc(st.voidReason ?? '')}`) : ''}
    ${st.status === 'paid' ? callout('ok', `Paid ${esc(fmt.date(st.paidAt))}${st.paidReference ? ` · ${esc(st.paidReference)}` : ''}`) : ''}
    ${(st.warnings ?? []).map((w) => callout('warn', esc(w))).join('')}
    <div class="grid two" style="margin:10px 0">
      <div><div class="cell-sub">Bill to</div><div class="cell-title">${esc(st.buyer.name)}</div>
        <div class="cell-sub">${st.buyer.taxId ? `${st.buyer.taxIdKind === 'TIN' ? 'NPWP' : esc(st.buyer.taxIdKind)} <span class="mono">${esc(st.buyer.taxId)}</span>` : 'no NPWP / NIK'}${st.buyer.email ? ` · ${esc(st.buyer.email)}` : ''}</div></div>
      <div><div class="cell-sub">${st.number ? `Invoice <span class="mono">${esc(st.number)}</span>` : 'Draft'}</div>
        <div class="cell-sub">${st.dueDate ? `Due ${esc(fmt.date(st.dueDate))}` : `Terms ${esc(st.buyer.termsDays)} days`}${st.efakturNumber ? ` · faktur <span class="mono">${esc(st.efakturNumber)}</span>` : ''}${st.sentAt ? ` · e-mailed ${esc(fmt.ago(st.sentAt))}` : ''}</div></div>
    </div>
    <div data-sites></div>
    <table class="t" style="margin-top:12px"><tbody>
      <tr><td>Energy, service and admin fees</td><td class="num">${fmt.idr(t.subtotalIdr)}</td></tr>
      <tr><td>PBJT-TL</td><td class="num">${fmt.idr(t.pbjtIdr)}</td></tr>
      <tr><td class="cell-sub">DPP nilai lain (11/12 of ${fmt.idr(t.taxBaseIdr)})</td><td class="num cell-sub">${fmt.idr(t.dppIdr)}</td></tr>
      <tr><td>PPN 12% × DPP</td><td class="num">${fmt.idr(t.ppnIdr)}</td></tr>
      ${t.roamingSessions ? `<tr><td>Partner networks (${t.roamingSessions}), re-billed at cost</td><td class="num">${fmt.idr(t.roamingIdr)}</td></tr>` : ''}
      ${(st.fees ?? []).map((f) => `<tr><td>${f.kind === 'reservation' ? 'Reservation' : 'Membership'}: ${esc(f.planName)} <span class="cell-sub">(${esc(f.subscriber)}${f.kind === 'reservation' ? `, ${esc(fmt.time(f.periodStart))}` : ''}, incl. PPN)</span></td><td class="num">${fmt.idr(f.totalIdr)}</td></tr>`).join('')}
      <tr><td><b>Total</b></td><td class="num"><b>${fmt.idr(t.totalIdr)}</b></td></tr>
    </tbody></table>
    ${st.id ? creditSection(st, canWrite, refresh) : ''}
    <p class="cell-sub">${fmt.num(t.sessions)} sessions · ${kwh(t.energyWh)} kWh${t.roundingIdr ? ` · session receipts add up to ${fmt.idr(t.receiptsTotalIdr)} (PPN here is per invoice line)` : ''}</p>
    <div class="cell-sub" style="margin-top:12px">Cards</div><div data-cards></div>`;
  table($('[data-sites]', b), {
    columns: [
      { label: 'Site', render: (l) => `<div class="cell-title">${esc(l.siteName)}</div>` },
      { label: 'Sessions', num: true, render: (l) => fmt.num(l.sessions) },
      { label: 'kWh', num: true, render: (l) => kwh(l.energyWh) },
      { label: 'PPN', num: true, render: (l) => fmt.idr(l.ppnIdr) },
      { label: 'Amount', num: true, render: (l) => `<b>${fmt.idr(l.totalIdr)}</b>` },
    ],
    rows: st.sites,
    empty: 'No sessions at your stations.',
  });
  table($('[data-cards]', b), {
    columns: [
      { label: 'Card', render: (c) => `<span class="mono">${esc(c.uid)}</span>${c.holder ? `<div class="cell-sub">${esc(c.holder)}</div>` : ''}` },
      { label: 'Sessions', num: true, render: (c) => fmt.num(c.sessions) },
      { label: 'kWh', num: true, render: (c) => kwh(c.energyWh) },
      { label: 'Amount', num: true, render: (c) => fmt.idr(c.totalIdr + c.roamingIdr) },
    ],
    rows: st.cards,
    empty: 'No cards used.',
  });
  wireCreditActions(b, refresh);
}

// ─────────────────────────────────────────── credit notes

async function renderCredits(box, canWrite) {
  box.innerHTML = `<div class="filters"><label class="check"><input type="checkbox" data-open checked> <span>Only those still to refund or deduct</span></label><div class="grow"></div>
    <button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button></div>
    <p class="cell-sub">Credit notes are issued from an invoice (open it under Invoices → Credit note). An unpaid invoice's credit reduces what is owed; a paid one's is refunded or taken off the next invoice.</p>
    <div class="card section" data-list></div>`;
  const load = async () => {
    const { creditNotes } = await api(`/v1/fleet-credit-notes${$('[data-open]', box).checked ? '?open=1' : ''}`);
    table($('[data-list]', box), {
      columns: [
        { label: 'Credit note', render: (c) => `<span class="mono">${esc(c.number)}</span><div class="cell-sub">${esc(fmt.date(c.issued_at))}</div>` },
        { label: 'Fleet account', render: (c) => `<div class="cell-title">${esc(c.account_name)}</div><div class="cell-sub">invoice <span class="mono">${esc(c.invoice_number)}</span></div>` },
        { label: 'Reason', render: (c) => `<div class="cell-sub wrap">${esc(c.reason)}</div>` },
        { label: 'Settled', render: (c) => (c.status === 'void' ? tag('t-mute', 'void')
          : c.settlement === 'invoice' ? tag('t-ok', 'on the invoice')
          : c.settlement === 'refund' ? (c.refunded_at ? tag('t-ok', `refunded ${fmt.date(c.refunded_at)}`) : tag('t-warn', 'to refund'))
          : c.applied_invoice ? tag('t-ok', `on ${c.applied_invoice}`) : tag('t-info', 'next invoice')) },
        { label: 'Amount', num: true, render: (c) => `<b>${fmt.idr(c.total_idr)}</b>${c.ppn_idr ? `<div class="cell-sub">PPN ${fmt.idr(c.ppn_idr)}</div>` : ''}` },
        { label: '', render: (c) => `<button class="btn sm ghost" type="button" data-cn-pdf="${esc(c.id)}">PDF</button>${canWrite && c.status === 'issued' && c.settlement === 'refund' && !c.refunded_at ? `<button class="btn sm ghost" type="button" data-cn-refunded="${esc(c.id)}">Refunded</button>` : ''}` },
      ],
      rows: creditNotes,
      empty: $('[data-open]', box).checked ? 'Nothing waiting: every credit note is settled.' : 'No credit notes yet.',
    });
    wireCreditActions(box, load);
  };
  $('[data-open]', box).addEventListener('change', load);
  $('[data-refresh]', box).addEventListener('click', load);
  await load();
}

// ─────────────────────────────────────────── accounts

const accountForm = (a = {}) => `<div class="form">
  ${field('Fleet name', `<input name="name" value="${esc(a.name ?? '')}" maxlength="200" placeholder="PT Logistik Nusantara">`, { help: 'As on the cards (RFID centre → fleet / company name). Cards with this fleet name are billed to this account.' })}
  ${field('Legal name', `<input name="legalName" value="${esc(a.legal_name ?? '')}" placeholder="PT Logistik Nusantara Tbk">`, { opt: true, help: 'As registered for tax; printed on the invoice.' })}
  ${field('Tax ID type', `<select name="taxIdKind">${['TIN', 'NIK', 'Passport', 'Other'].map((k) => `<option value="${k}"${(a.tax_id_kind ?? 'TIN') === k ? ' selected' : ''}>${k === 'TIN' ? 'NPWP' : k}</option>`).join('')}</select>`)}
  ${field('NPWP / NIK', `<input name="taxId" value="${esc(a.tax_id ?? '')}" inputmode="numeric" placeholder="16 digits">`, { opt: true, help: 'Needed for a faktur pajak. A 15-digit NPWP is converted to 16 digits.' })}
  ${field('NITKU', `<input name="nitku" value="${esc(a.nitku ?? '')}" inputmode="numeric" placeholder="22 digits">`, { opt: true, help: 'Branch ID for Coretax. Leave empty for the head office (NPWP + 000000).' })}
  ${field('Billing e-mail', `<input name="billingEmail" value="${esc(a.billing_email ?? '')}" placeholder="ap@company.co.id">`, { opt: true, help: 'Invoices are e-mailed here; separate several with commas.' })}
  ${field('Address', `<input name="address" value="${esc(a.address ?? '')}">`, { opt: true, full: true })}
  ${field('Contact', `<input name="contactName" value="${esc(a.contact_name ?? '')}">`, { opt: true })}
  ${field('Phone', `<input name="phone" value="${esc(a.phone ?? '')}">`, { opt: true })}
  ${field('Payment terms (days)', `<input name="paymentTermsDays" type="number" min="0" max="120" value="${esc(a.payment_terms_days ?? 14)}">`)}
  <div class="field full"><label class="check"><input type="checkbox" name="includeRoaming"${a.include_roaming === false ? '' : ' checked'}> <span>Re-bill charging on partner networks (roaming) on this account's invoices</span></label></div>
  <div class="field full"><label class="check"><input type="checkbox" name="v2xAllowed"${a.v2x_allowed ? ' checked' : ''}> <span>The fleet agrees that its cars give energy back at sites with a bidirectional programme (V2G / V2B)</span></label>
    <div class="small muted">The fleet earns each site's credit per kWh on its invoice. Only cars and chargers that support it (ISO 15118-20, OCPP 2.1) take part.</div></div>
  ${field('Battery floor', `<div class="inputgroup"><input name="v2xMinSocPercent" type="number" min="10" max="95" value="${esc(a.v2x_min_soc_percent ?? 50)}"><span class="suffix">%</span></div>`, { help: 'Its cars are never discharged below this, nor below the site’s own floor.' })}
</div>`;
const readAccount = (b) => {
  const v = formValues(b);
  return { ...v, paymentTermsDays: Number(v.paymentTermsDays), includeRoaming: $('[name="includeRoaming"]', b).checked, v2xAllowed: $('[name="v2xAllowed"]', b).checked, v2xMinSocPercent: Number(v.v2xMinSocPercent) };
};

async function renderAccounts(box, canWrite) {
  box.innerHTML = `<div class="filters"><label class="check"><input type="checkbox" data-archived> <span>Show archived</span></label><div class="grow"></div>
    ${canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} Add fleet account</button>` : ''}</div>
    <div class="card section" data-list></div>`;
  const load = async () => {
    const { accounts } = await api(`/v1/fleet-accounts${$('[data-archived]', box).checked ? '?archived=1' : ''}`);
    table($('[data-list]', box), {
      columns: [
        { label: 'Fleet account', render: (a) => `<div class="cell-title">${esc(a.name)}</div><div class="cell-sub">${esc(a.legal_name ?? '')}${a.archived_at ? ' · archived' : ''}</div>` },
        { label: 'NPWP / NIK', render: (a) => (a.tax_id ? `<span class="mono">${esc(a.tax_id)}</span>` : tag('t-warn', 'missing')) },
        { label: 'Billing e-mail', render: (a) => esc(a.billing_email ?? '—') },
        { label: 'Terms', num: true, render: (a) => `${fmt.num(a.payment_terms_days)} d` },
        { label: 'Cards', num: true, render: (a) => fmt.num(a.cards) },
        { label: 'Outstanding', num: true, render: (a) => (a.outstanding_idr ? `<b>${fmt.idr(a.outstanding_idr)}</b><div class="cell-sub">${a.open_invoices} invoice(s)</div>` : '—') },
      ],
      rows: accounts,
      empty: 'No fleet accounts yet. Cards with a fleet name in the RFID centre create one automatically; add the legal and tax details here.',
      onRow: (a) => openAccount(a.id),
    });
  };
  const openAccount = async (id) => {
    const a = await api(`/v1/fleet-accounts/${id}`);
    const d = drawer({
      title: a.name,
      subtitle: esc(a.legal_name ?? ''),
      headerHtml: canWrite ? `<div class="row" style="gap:6px;margin-top:8px"><button class="btn sm" type="button" data-archive>${a.archived_at ? 'Restore' : 'Archive'}</button></div>` : '',
      tabs: [
        {
          id: 'details', label: 'Details',
          render(b) {
            b.innerHTML = accountForm(a) + (canWrite ? '<button class="btn primary" type="button" data-save style="margin-top:12px">Save</button>' : '');
            if (!canWrite) b.querySelectorAll('input,select').forEach((x) => { x.disabled = true; });
            $('[data-save]', b)?.addEventListener('click', async () => {
              try { await api(`/v1/fleet-accounts/${id}`, { method: 'PUT', body: readAccount(b) }); toast('Saved', 'ok'); }
              catch (e) { toast(e.message, 'crit'); }
            });
          },
        },
        {
          id: 'cards', label: `Cards (${a.cards.length})`,
          async render(b) {
            const cur = await api(`/v1/fleet-accounts/${id}`);
            b.innerHTML = `${canWrite ? `<div class="row" style="gap:8px;margin-bottom:10px"><input data-uids class="grow" placeholder="Card UIDs to add, separated by commas" autocomplete="off"><button class="btn sm primary" type="button" data-addcards>Add</button></div>` : ''}<div data-t></div>`;
            table($('[data-t]', b), {
              columns: [
                { label: 'Card', render: (c) => `<span class="mono">${esc(c.uid)}</span>` },
                { label: 'Holder', render: (c) => esc(c.holder_name ?? '') },
                { label: 'Status', render: (c) => `${tag(c.status === 'Accepted' ? 't-ok' : 't-mute', c.status)}${c.blocked_by_customer ? '<div class="cell-sub">blocked by the customer (lost card?)</div>' : ''}` },
                { label: '', render: (c) => (canWrite ? `<button class="btn sm" type="button" data-rm="${esc(c.uid)}">Remove</button>` : '') },
              ],
              rows: cur.cards,
              empty: 'No cards. Add them by UID, or set this fleet name on cards in the RFID centre.',
            });
            b.onclick = async (ev) => {
              const rm = ev.target.closest('[data-rm]');
              const add = ev.target.closest('[data-addcards]');
              if (!rm && !add) return;
              const body = rm ? { remove: [rm.dataset.rm] } : { add: $('[data-uids]', b).value.split(/[,\s]+/).filter(Boolean) };
              try {
                const r = await api(`/v1/fleet-accounts/${id}/cards`, { method: 'PUT', body });
                if (r.unknown?.length) toast(`Not registered: ${r.unknown.join(', ')}`, 'warn'); else toast('Cards updated', 'ok');
                d.refresh();
              } catch (e) { toast(e.message, 'crit'); }
            };
          },
        },
        {
          id: 'invoices', label: 'Invoices',
          async render(b) {
            const { invoices } = await api(`/v1/fleet-invoices?accountId=${id}`);
            table(b, {
              columns: [
                { label: 'Invoice', render: (i) => `<span class="mono">${esc(i.number)}</span><div class="cell-sub">${esc(monthLabel(i.period))}</div>` },
                { label: 'Status', render: (i) => statusTag(i) },
                { label: 'Total', num: true, render: (i) => `${fmt.idr(i.total_idr)}${i.status === 'issued' && i.balance_idr !== Number(i.total_idr) ? `<div class="cell-sub">owed ${fmt.idr(i.balance_idr)}</div>` : ''}` },
                { label: 'Due', render: (i) => esc(fmt.date(i.due_date)) },
              ],
              rows: invoices,
              empty: 'No invoices yet.',
              onRow: (i) => open(`/v1/fleet-invoices/${i.id}/invoice.pdf`),
            });
          },
        },
        {
          id: 'portal', label: `Portal access (${a.portalUsers?.length ?? 0})`,
          async render(b) {
            const cur = await api(`/v1/fleet-accounts/${id}`);
            const canInvite = state.can('user:write');
            b.innerHTML = `<p class="cell-sub">The customer's own staff can sign in to see this account's invoices, credit notes (PDF), this month's charging and its cards, and block a lost card. They see nothing else.</p>
              ${canInvite ? `<div class="row" style="margin-bottom:10px"><button class="btn sm primary" type="button" data-invite>${icon('plus')} Invite a user</button></div>` : '<p class="cell-sub">Inviting needs user management (a Super Administrator).</p>'}<div data-t></div>`;
            table($('[data-t]', b), {
              columns: [
                { label: 'Name', render: (u) => `<div class="cell-title">${esc(u.name)}</div><div class="cell-sub">${esc(u.email)}</div>` },
                { label: 'Status', render: (u) => (u.status !== 'active' ? tag('t-mute', u.status) : u.must_change_password ? tag('t-info', 'invited') : tag('t-ok', 'active')) },
                { label: 'Last sign-in', render: (u) => (u.last_login_at ? esc(fmt.ago(u.last_login_at)) : '—') },
              ],
              rows: cur.portalUsers ?? [],
              empty: 'No portal users yet.',
            });
            $('[data-invite]', b)?.addEventListener('click', () => modal({
              title: `Invite to the ${esc(a.name)} portal`,
              body: `<div class="form one">${field('Name', '<input name="name" autocomplete="off">')}${field('E-mail', '<input name="email" type="email" autocomplete="off">')}</div>`,
              actions: [{ label: 'Cancel' }, { label: 'Invite', kind: 'primary', async onClick(ctx) {
                const v = formValues(ctx.body);
                try {
                  const r = await api('/v1/users', { method: 'POST', body: { name: v.name, email: v.email, role: 'fleet_customer', fleetAccountId: id } });
                  setTimeout(() => modal({
                    title: 'User invited',
                    body: `${callout('warn', esc(r.warning))}<div class="form one" style="margin-top:10px">${field('One-time password', `<input readonly class="mono" value="${esc(r.temporaryPassword)}">`)}</div><p class="cell-sub">They sign in to this console and see only the fleet portal.</p>`,
                  }), 50);
                  d.refresh();
                } catch (e) { toast(e.message, 'crit'); return false; }
              } }],
            }));
          },
        },
      ],
      onClose: load,
    });
    $('[data-archive]', d.el)?.addEventListener('click', async () => {
      try { await api(`/v1/fleet-accounts/${id}/archive`, { method: 'POST', body: { archived: !a.archived_at } }); toast(a.archived_at ? 'Restored' : 'Archived', 'ok'); d.close(); }
      catch (e) { toast(e.message, 'crit'); }
    });
  };
  $('[data-archived]', box).addEventListener('change', load);
  $('[data-add]', box)?.addEventListener('click', () => modal({
    title: 'Add fleet account', size: 'lg', body: accountForm(),
    actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', async onClick(ctx) {
      try { await api('/v1/fleet-accounts', { method: 'POST', body: readAccount(ctx.body) }); toast('Fleet account added', 'ok'); load(); }
      catch (e) { toast(e.message, 'crit'); return false; }
    } }],
  }));
  await load();
}

// ─────────────────────────────────────────── settings

async function renderSettings(box) {
  const r = await api('/v1/fleet-billing/settings');
  const s = r.settings;
  const ef = s.efaktur;
  box.innerHTML = `
    ${r.efakturReady ? callout('warn', `e-Faktur export: ${esc(r.efakturReady)}`) : callout('ok', 'e-Faktur export is ready.')}
    <div class="card section"><header><h3>On your invoices</h3></header><div class="body"><div class="form">
      ${field('Seller', `<input value="${esc(r.seller.name)}" disabled>`, { help: `The organisation's name${r.seller.pkp ? ' · PKP (VAT-registered)' : ' · not PKP: no PPN is charged'}.` })}
      ${field('NPWP', `<input name="npwp" value="${esc(r.seller.npwp ?? '')}" inputmode="numeric" placeholder="16 digits">`)}
      ${field('NITKU', `<input name="nitku" value="${esc(r.seller.nitku ?? '')}" inputmode="numeric" placeholder="22 digits">`, { opt: true, help: 'Empty = head office (NPWP + 000000).' })}
      ${field('Invoice number prefix', `<input name="prefix" value="${esc(s.prefix)}" maxlength="12">`, { help: `Numbers look like ${esc(s.prefix)}/2026/10/0001 (per year).` })}
      ${field('Address', `<input name="address" value="${esc(r.seller.address ?? '')}">`, { full: true })}
      ${field('How to pay', `<textarea name="paymentInstructions" rows="3" placeholder="Transfer to BCA 123-456-7890 a.n. PT …, quoting the invoice number">${esc(s.paymentInstructions)}</textarea>`, { full: true })}
    </div></div></div>
    <div class="card section"><header><h3>e-Faktur (Coretax import)</h3></header><div class="body">
      <p class="cell-sub">Each invoice with PPN becomes one faktur with transaction code 04 (PPN 12% on DPP nilai lain, 11/12 of the price) and one line per site. How EV charging is classified — goods or services, the 6-digit code and the unit — is for your tax adviser; the export stays blocked until you confirm it.</p>
      <div class="form">
        ${field('Type', `<select name="itemOpt"><option value="A"${ef.itemOpt === 'A' ? ' selected' : ''}>A — goods (barang)</option><option value="B"${ef.itemOpt === 'B' ? ' selected' : ''}>B — services (jasa)</option></select>`)}
        ${field('Goods / service code', `<input name="itemCode" value="${esc(ef.itemCode)}" inputmode="numeric" maxlength="6" placeholder="6 digits">`)}
        ${field('Unit code', `<input name="unitCode" value="${esc(ef.unitCode)}" placeholder="UM.0000">`)}
        ${field('Membership fees: type', `<select name="feeItemOpt"><option value="B"${(ef.feeItemOpt ?? 'B') === 'B' ? ' selected' : ''}>B — services (jasa)</option><option value="A"${ef.feeItemOpt === 'A' ? ' selected' : ''}>A — goods (barang)</option></select>`, { help: 'Only needed when memberships are billed on fleet invoices.' })}
        ${field('Membership fees: code', `<input name="feeItemCode" value="${esc(ef.feeItemCode ?? '')}" inputmode="numeric" maxlength="6" placeholder="6 digits">`)}
        ${field('Membership fees: unit', `<input name="feeUnitCode" value="${esc(ef.feeUnitCode ?? '')}" placeholder="UM.0000">`)}
        <div class="field full"><label class="check"><input type="checkbox" name="confirmed"${ef.confirmed ? ' checked' : ''}> <span>Confirmed with our tax adviser${ef.confirmed && ef.confirmedAt ? ` <span class="cell-sub">(${esc(fmt.date(ef.confirmedAt))})</span>` : ''}</span></label></div>
      </div></div></div>
    <button class="btn primary" type="button" data-save>Save settings</button>`;
  $('[data-save]', box).addEventListener('click', async () => {
    const v = formValues(box);
    try {
      await api('/v1/fleet-billing/settings', {
        method: 'PUT',
        body: {
          npwp: v.npwp, nitku: v.nitku, prefix: v.prefix, address: v.address, paymentInstructions: v.paymentInstructions,
          efaktur: {
            itemOpt: v.itemOpt, itemCode: v.itemCode, unitCode: v.unitCode.toUpperCase(),
            feeItemOpt: v.feeItemOpt, feeItemCode: v.feeItemCode, feeUnitCode: v.feeUnitCode.toUpperCase(),
            confirmed: $('[name="confirmed"]', box).checked,
          },
        },
      });
      toast('Settings saved', 'ok');
      renderSettings(box);
    } catch (e) { toast(e.message, 'crit'); }
  });
}
