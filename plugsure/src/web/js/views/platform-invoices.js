import { $, esc, api, registerView, pageHead, icon, field, callout, table, fmt, tag, drawer, modal, toast, download } from '../core.js';

/**
 * (v1.25.0) PlugSure's fee invoices to operators: each finalised fee statement as an invoice, e-mailed with its PDF,
 * a Xendit payment link on PlugSure's own account (paid → recorded on the statement), reminders, and each
 * operator's statement of account. Platform administrators.
 */

const STATUS = { due: ['t-info', 'due'], partial: ['t-warn', 'part-paid'], overdue: ['t-crit', 'overdue'], paid: ['t-ok', 'paid'] };

function openInvoice(row, reload) {
  const d = drawer({
    title: `${row.number} · ${row.operator}`,
    subtitle: esc(`Fees for ${row.period}`),
    tabs: [
      { id: 'invoice', label: 'Invoice', async render(body, ctx) {
        const v = await api(`/v1/finance/platform-invoices/${row.statementId}`);
        const m = (n) => fmt.money(n, v.currency);
        body.innerHTML = `
          <div class="grid k4">${[['Total', m(v.total), `issued ${v.issued}`], ['Paid', m(v.paid), `${v.payments.length} payment(s)`], ['Due', m(v.outstanding), `by ${v.due}`],
            ['Days past due', String(Math.max(0, v.daysPastDue)), v.daysPastDue > 0 ? 'overdue' : 'not yet']].map(([a, b, c]) => `<div class="card kpi"><div class="label">${esc(a)}</div><div class="value">${esc(b)}</div><div class="foot">${esc(c)}</div></div>`).join('')}</div>
          <div class="card section"><header><h3>Billing e-mail</h3></header><div class="body"><div class="row" style="gap:6px">
            <input data-email value="${esc(v.operator.billingEmail ?? '')}" placeholder="ap@operator.co.id" style="flex:1"><button class="btn" type="button" data-saveemail>Save</button></div></div></div>
          <div class="row section" style="gap:6px;flex-wrap:wrap">
            <button class="btn" type="button" data-pdf>${icon('download')} PDF</button>
            ${v.outstanding > 0 ? `<button class="btn primary" type="button" data-send>${v.sends.some((s) => s.kind === 'invoice' && !s.error) ? 'Send again' : 'E-mail invoice'}</button>
              <button class="btn" type="button" data-remind>Send reminder</button>
              ${v.link ? `<button class="btn" type="button" data-check>Check payment</button><button class="btn" type="button" data-cancel>Stop link</button>` : '<button class="btn" type="button" data-link>Payment link</button>'}` : ''}
          </div>
          ${v.link ? `<div class="section">${callout('info', `Payment link: <a href="${esc(v.link.url)}" target="_blank" rel="noopener">${esc(v.link.url)}</a> · ${esc(m(v.link.amount))}${v.link.expiresAt ? ` · until ${esc(fmt.date(v.link.expiresAt))}` : ''}${v.link.error ? `<br><span style="color:var(--crit)">${esc(v.link.error)}</span>` : ''}`)}</div>` : ''}
          <div class="card section"><header><h3>Fees</h3></header><div data-lines></div></div>
          <div class="card section"><header><h3>Payments</h3></header><div data-pays></div></div>
          <div class="card section"><header><h3>E-mails</h3></header><div data-sends></div></div>`;
        table($('[data-lines]', body), { columns: [{ label: 'Line', render: (l) => esc(l.label) }, { label: 'Amount', num: true, render: (l) => esc(m(l.amount)) }],
          rows: [...v.lines, { label: 'Net fees', amount: v.net }, ...(v.tax ? [{ label: 'Tax', amount: v.tax }] : []), { label: 'Total', amount: v.total }], empty: 'No fee lines.' });
        table($('[data-pays]', body), { columns: [{ label: 'Date', render: (p) => esc(p.paidOn) }, { label: 'Reference', render: (p) => `<span class="mono">${esc(p.reference)}</span>` }, { label: 'Amount', num: true, render: (p) => esc(m(p.amount)) }],
          rows: v.payments, empty: 'Nothing paid yet.' });
        table($('[data-sends]', body), { columns: [
          { label: 'When', render: (s) => `${esc(fmt.ago(s.at))}<div class="cell-sub">${s.automatic ? 'automatic' : esc(s.by ?? '')}</div>` },
          { label: 'What', render: (s) => esc(s.kind) },
          { label: 'To', render: (s) => (s.error ? `<span style="color:var(--crit)">${esc(s.error)}</span>` : esc(s.to ?? '')) },
        ], rows: v.sends, empty: 'Not e-mailed yet.' });
        const act = async (btn, fn, ok) => {
          btn.disabled = true;
          try { const r = await fn(); toast(typeof ok === 'function' ? ok(r) : ok, 'ok'); ctx.show('invoice'); reload(); } catch (e) { toast(e.message, 'crit'); btn.disabled = false; }
        };
        $('[data-saveemail]', body).addEventListener('click', (e) => act(e.currentTarget, () => api(`/v1/finance/operators/${v.operator.id}/billing-email`, { method: 'PUT', body: { billingEmail: $('[data-email]', body).value.trim() || null } }), 'Saved.'));
        $('[data-pdf]', body).addEventListener('click', async () => {
          try { const res = await api(`/v1/finance/platform-invoices/${v.statementId}/pdf`, { raw: true }); download(`invoice-${v.number}.pdf`, await res.blob()); } catch (e) { toast(e.message, 'crit'); }
        });
        $('[data-send]', body)?.addEventListener('click', (e) => act(e.currentTarget, () => api(`/v1/finance/platform-invoices/${v.statementId}/send`, { method: 'POST', body: { link: true } }), (r) => `Sent to ${r.to}.`));
        $('[data-remind]', body)?.addEventListener('click', (e) => act(e.currentTarget, () => api(`/v1/finance/platform-invoices/${v.statementId}/send`, { method: 'POST', body: { kind: 'reminder', link: true } }), (r) => `Reminder sent to ${r.to}.`));
        $('[data-link]', body)?.addEventListener('click', (e) => act(e.currentTarget, () => api(`/v1/finance/platform-invoices/${v.statementId}/link`, { method: 'POST' }), 'Payment link made.'));
        $('[data-check]', body)?.addEventListener('click', (e) => act(e.currentTarget, () => api(`/v1/finance/platform-invoices/${v.statementId}/link/check`, { method: 'POST' }), (r) => (r.state === 'paid' ? 'Paid: the payment is recorded.' : `Still ${r.state}.`)));
        $('[data-cancel]', body)?.addEventListener('click', (e) => act(e.currentTarget, () => api(`/v1/finance/platform-invoices/${v.statementId}/link/cancel`, { method: 'POST' }), 'Link stopped here: expire it at Xendit too.'));
      } },
      { id: 'account', label: 'Statement of account', async render(body) {
        const a = await api(`/v1/finance/operators/${row.operatorId}/fee-account`);
        body.innerHTML = `<div class="row" style="justify-content:flex-end"><button class="btn sm" type="button" data-csv>${icon('download')} CSV</button></div>${a.currencies.map((c) => `<div class="card section"><header><h3>${esc(c.currency)}</h3><span class="right cell-sub">balance ${esc(fmt.money(c.balance, c.currency))}</span></header><div data-c="${esc(c.currency)}"></div></div>`).join('') || callout('info', 'No fee statements.')}`;
        for (const c of a.currencies) {
          table($(`[data-c="${c.currency}"]`, body), { columns: [
            { label: 'Date', render: (e) => esc(e.date) }, { label: 'Number', render: (e) => `<span class="mono">${esc(e.number)}</span><div class="cell-sub">${esc(e.description)}</div>` },
            { label: 'Debit', num: true, render: (e) => (e.debit ? esc(fmt.money(e.debit, c.currency)) : '') }, { label: 'Credit', num: true, render: (e) => (e.credit ? esc(fmt.money(e.credit, c.currency)) : '') },
            { label: 'Balance', num: true, render: (e) => esc(fmt.money(e.balance, c.currency)) },
          ], rows: c.entries, empty: '' });
        }
        $('[data-csv]', body).addEventListener('click', async () => {
          try { const res = await api(`/v1/finance/operators/${row.operatorId}/fee-account?format=csv`, { raw: true }); download(`plugsure-fees-${row.operator}.csv`, await res.blob()); } catch (e) { toast(e.message, 'crit'); }
        });
      } },
    ],
  });
  return d;
}

registerView('platform-invoices', {
  title: 'Fee invoices',
  icon: 'card',
  group: 'govern',
  order: 71,
  perm: 'platform:admin',
  async render(root) {
    root.innerHTML = pageHead('Fee invoices',
      'PlugSure\'s invoices to operators: each finalised fee statement, e-mailed with its PDF and a Xendit payment link on PlugSure\'s own account. A paid link is recorded on the statement within the hour.',
      `<button class="btn" type="button" data-settings>${icon('gear')} Automatic invoicing</button>`) +
      `<div class="filters">${field('Status', '<select data-status><option value="">All</option><option value="overdue">Overdue</option><option value="due">Due</option><option value="partial">Part-paid</option><option value="paid">Paid</option></select>')}</div><div class="grid k4 section" data-kpis></div><div class="card" data-list></div>`;
    let data = null;
    const load = async () => {
      const st = $('[data-status]', root).value;
      try { data = await api(`/v1/finance/platform-invoices${st ? `?status=${st}` : ''}`); } catch (e) { $('[data-list]', root).innerHTML = callout('crit', esc(e.message)); return; }
      const per = (k, f = () => true) => {
        const by = {};
        for (const r of data.invoices.filter(f)) by[r.currency] = (by[r.currency] ?? 0) + r[k];
        return Object.entries(by).map(([c, n]) => fmt.money(n, c)).join(' · ') || '—';
      };
      $('[data-kpis]', root).innerHTML = [
        ['Invoices', String(data.invoices.length), `${data.termsDays}-day terms`],
        ['Outstanding', per('outstanding'), `${data.invoices.filter((r) => r.outstanding > 0).length} open`],
        ['Overdue', per('outstanding', (r) => r.status === 'overdue'), `${data.invoices.filter((r) => r.status === 'overdue').length} invoices`],
        ['Automatic', data.settings.autoSend ? 'on' : 'off', data.settings.reminderDays.length ? `reminders at ${data.settings.reminderDays.join(', ')} days` : 'no reminders'],
      ].map(([a, b, c]) => `<div class="card kpi"><div class="label">${esc(a)}</div><div class="value">${esc(b)}</div><div class="foot">${esc(c)}</div></div>`).join('');
      table($('[data-list]', root), { columns: [
        { label: 'Invoice', render: (r) => `<div class="cell-title mono">${esc(r.number)}</div><div class="cell-sub">${esc(r.operator)} · ${esc(r.period)}</div>` },
        { label: 'Status', render: (r) => tag(...STATUS[r.status]) + (r.linkUrl ? ` ${tag('t-info', 'link')}` : '') },
        { label: 'Due', render: (r) => `${esc(r.due)}${r.outstanding > 0 && r.daysPastDue > 0 ? `<div class="cell-sub">${r.daysPastDue} days past</div>` : ''}` },
        { label: 'E-mailed', render: (r) => (r.sentAt ? `${esc(fmt.ago(r.sentAt))}${r.reminders ? `<div class="cell-sub">${r.reminders} reminder(s)</div>` : ''}` : r.billingEmail ? '<span class="cell-sub">not yet</span>' : tag('t-warn', 'no e-mail')) },
        { label: 'Total', num: true, render: (r) => esc(fmt.money(r.total, r.currency)) },
        { label: 'Outstanding', num: true, render: (r) => `<b>${esc(fmt.money(r.outstanding, r.currency))}</b>` },
      ], rows: data.invoices, empty: 'No finalised fee statements yet (Platform billing → finalise a month).', onRow: (r) => openInvoice(r, load) });
    };
    $('[data-status]', root).addEventListener('change', load);
    $('[data-settings]', root).addEventListener('click', () => {
      const s = data?.settings ?? { autoSend: false, autoLink: false, reminderDays: [3, 14, 30], linkDays: 30 };
      modal({ title: 'Automatic invoicing', subtitle: 'Hourly, by the platform-invoicing worker',
        body: `<div class="form">
          <label class="check"><input type="checkbox" name="auto"${s.autoSend ? ' checked' : ''}><span>E-mail each fee statement to the operator once it is finalised</span></label>
          <label class="check"><input type="checkbox" name="link"${s.autoLink ? ' checked' : ''}><span>With a Xendit payment link</span></label>
          ${field('Reminders (days from the due date)', `<input name="days" value="${esc(s.reminderDays.join(', '))}" placeholder="3, 14, 30">`)}
          ${field('A payment link lasts (days)', `<input name="ld" type="number" min="1" max="90" value="${s.linkDays}">`)}
        </div><p class="cell-sub">E-mails go out through the e-mail channel (Governance → Alert routing → Channels), to each operator's billing e-mail.</p>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(ctx) {
          const b = ctx?.el ?? document;
          try {
            await api('/v1/finance/platform-invoices/settings', { method: 'PUT', body: { autoSend: $('[name="auto"]', b).checked, autoLink: $('[name="link"]', b).checked, reminderDays: $('[name="days"]', b).value, linkDays: Number($('[name="ld"]', b).value) } });
            toast('Saved.', 'ok'); load();
          } catch (e) { toast(e.message, 'crit'); return false; }
        } }] });
    });
    await load();
  },
});
