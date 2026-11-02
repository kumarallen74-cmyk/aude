import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options, copy, download } from '../core.js';

/**
 * (v1.47.0) Finance → Home charging: employees paid back for charging a company car at home. Each employee's home
 * charger (one PlugSure manages over OCPP, or a meter they read), their electricity rate, a month's reimbursement
 * drafted, approved, marked paid, and the payroll export. Each employee has their own page (a secret link) to see
 * their months and add meter readings.
 */

const ST = { draft: 't-mute', approved: 't-info', paid: 't-ok', void: 't-mute' };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const lastMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

registerView('home-charging', {
  title: 'Home charging',
  icon: 'plug',
  group: 'finance',
  order: 9,
  perm: 'payment:read',
  async render(root) {
    const canWrite = state.can('payment:write');
    const canApprove = state.can('finance:approve');
    root.innerHTML = pageHead('Home charging',
      'Employees who charge a company car at home are paid back each month: the energy their home charger delivered (or their meter shows) × their home electricity rate.',
      canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} Add an employee</button>` : '') + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    let chargers = [], cps = [], cards = [], month = lastMonth();

    const chargerModal = (h) => modal({ title: h ? h.employeeName : 'Add an employee\'s home charger', size: 'lg',
      body: `<div class="form grid2">${field('Employee', `<input name="name" maxlength="120" value="${esc(h?.employeeName ?? '')}">`)}
        ${field('Payroll number', `<input name="ref" maxlength="40" value="${esc(h?.employeeRef ?? '')}">`)}
        ${field('E-mail', `<input name="email" type="email" value="${esc(h?.employeeEmail ?? '')}">`)}
        ${field('Address', `<input name="address" maxlength="300" value="${esc(h?.address ?? '')}">`)}
        ${field('Measured by', `<select name="mode">${options([{ value: 'readings', label: 'Meter readings (the employee reads a meter)' }, { value: 'ocpp', label: 'An OCPP charger PlugSure manages' }], h?.mode ?? 'readings')}</select>`)}
        ${field('Charger', `<select name="cp">${options(cps.map((c) => ({ value: c.id, label: c.display_name || c.ocpp_identity })), h?.chargePointId ?? '', { blank: '—' })}</select>`, { help: 'For OCPP: the charger at the employee\'s home. It leaves the public map.' })}
        ${field('Only this card\'s sessions', `<select name="tok">${options(cards.map((t) => ({ value: t.id, label: `${t.uid}${t.holder_name ? ` · ${t.holder_name}` : ''}` })), h?.tokenId ?? '', { blank: 'All sessions on the charger' })}</select>`)}
        ${field('Home electricity rate per kWh (minor units)', `<input name="rate" type="number" min="0" step="0.01" value="${h?.rateMinorPerKwh ?? ''}">`)}
        ${field('Monthly cap (minor units)', `<input name="cap" type="number" min="0" step="1" value="${h?.monthlyCapMinor ?? ''}">`, { help: 'Empty: no cap.' })}
        ${field('Currency', `<input name="cur" maxlength="3" value="${esc(h?.currency ?? state.me?.org?.currency ?? '')}" placeholder="ISO code">`)}</div>`,
      actions: [...(h ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/home-chargers/${h.id}`, { method: 'PUT', body: { archive: true } }); draw(); }) }] : []),
        { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
          const b = { employeeName: v('name'), employeeRef: v('ref') || null, employeeEmail: v('email') || null, address: v('address') || null, mode: v('mode'),
            chargePointId: v('cp') || null, tokenId: v('tok') || null, rateMinorPerKwh: Number(v('rate')), monthlyCapMinor: v('cap') === '' ? null : Number(v('cap')), currency: v('cur').toUpperCase() };
          await api(h ? `/v1/home-chargers/${h.id}` : '/v1/home-chargers', { method: h ? 'PUT' : 'POST', body: b });
          toast('Saved.', 'ok'); draw();
        }) }] });

    const readingsModal = async (h) => {
      let r;
      try { r = await api(`/v1/home-chargers/${h.id}/readings`); } catch (e) { toast(e.message, 'crit'); return; }
      modal({ title: `Meter readings · ${h.employeeName}`, body: `${canWrite ? `<div class="form grid2">${field('Date', `<input name="on" type="date" value="${new Date().toISOString().slice(0, 10)}">`)}
          ${field('Meter (kWh)', '<input name="kwh" type="number" min="0" step="0.1">')}</div>` : ''}<div data-r style="margin-top:10px"></div>`,
        onMount: (mc) => table($('[data-r]', mc.el), { columns: [{ label: 'Date', key: 'readOn' }, { label: 'kWh', num: true, render: (x) => fmt.num(x.kwhTotal, 1) }, { label: 'By', key: 'source' }], rows: r.readings, empty: 'No readings yet.' }),
        actions: [{ label: 'Close' }, ...(canWrite ? [{ label: 'Add reading', kind: 'primary', onClick: guard(async (mc) => {
          await api(`/v1/home-chargers/${h.id}/readings`, { method: 'POST', body: { readOn: $('[name="on"]', mc.el).value, kwhTotal: Number($('[name="kwh"]', mc.el).value) } });
          toast('Saved.', 'ok'); draw();
        }) }] : [])] });
    };

    const linkModal = (h) => modal({ title: `${h.employeeName}'s page`,
      body: `<p>${h.portalLinked ? 'A new link replaces the one sent before.' : 'The employee sees their months and reimbursements' + (h.mode === 'readings' ? ', and adds meter readings' : '') + '. No account needed.'}</p><div data-link></div>`,
      actions: [{ label: 'Close' }, { label: h.portalLinked ? 'Make a new link' : 'Make the link', kind: 'primary', onClick: guard(async (mc) => {
        const r = await api(`/v1/home-chargers/${h.id}/portal`, { method: 'POST' });
        const url = `${location.origin}${r.path}`;
        $('[data-link]', mc.el).innerHTML = `${callout('warn', 'Shown once: send it to the employee.')}<div style="display:flex;gap:6px;margin-top:8px"><input readonly value="${esc(url)}" style="flex:1"><button class="btn" type="button" data-cpy>${icon('copy')} Copy</button></div>`;
        $('[data-cpy]', mc.el).addEventListener('click', () => copy(url));
        return false;
      }) }] });

    const draw = async () => {
      let reimb;
      try {
        [{ chargers }, { reimbursements: reimb }] = await Promise.all([api('/v1/home-chargers'), api(`/v1/home-reimbursements?month=${month}`)]);
        if (canWrite && !cps.length) [cps, cards] = await Promise.all([api('/v1/charge-points').then((r) => (Array.isArray(r) ? r : r.chargePoints ?? r.items ?? [])).catch(() => []),
          state.can('token:read') ? api('/v1/tokens?limit=2000').then((r) => (Array.isArray(r) ? r : r.tokens ?? [])).catch(() => []) : []]);
      } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const active = chargers.filter((h) => !h.archived);
      const total = reimb.filter((r) => r.status !== 'void').reduce((a, r) => a + r.amountMinor, 0);
      body.innerHTML = `<div class="grid k4">${kpi('Employees', fmt.num(active.length))}${kpi('Reimbursements', fmt.num(reimb.length), month)}
          ${kpi('Amount', reimb.length ? fmt.money(total, reimb[0].currency) : '—', month)}${kpi('To approve', fmt.num(reimb.filter((r) => r.status === 'draft').length), '', reimb.some((r) => r.status === 'draft') ? 'warn' : '')}</div>
        <div class="card section"><header><h3>Reimbursements</h3><div class="right" style="display:flex;gap:6px;align-items:center">
          <input type="month" data-month value="${month}" style="width:auto">${canWrite ? '<button class="btn sm" type="button" data-draft>Draft</button>' : ''}
          <button class="btn sm" type="button" data-csv>${icon('download')} Payroll CSV</button><button class="btn sm" type="button" data-xlsx>${icon('download')} .xlsx</button></div></header><div data-r></div></div>
        <div class="card section"><header><h3>Employees</h3></header><div data-h></div></div>`;
      table($('[data-r]', body), { columns: [{ label: 'Employee', render: (r) => `<b>${esc(r.employeeName)}</b>${r.employeeRef ? `<div class="cell-sub">${esc(r.employeeRef)}</div>` : ''}` },
        { label: 'kWh', num: true, render: (r) => fmt.num(r.kwh, 1) }, { label: 'Rate', num: true, render: (r) => fmt.num(r.rateMinorPerKwh, 2) },
        { label: 'Amount', num: true, render: (r) => `${fmt.money(r.amountMinor, r.currency)}${r.capped ? ' <span class="cell-sub">cap</span>' : ''}` }, { label: 'Status', render: (r) => tag(ST[r.status] ?? 't-mute', r.status) },
        ...(canWrite ? [{ label: '', render: (r) => (r.status === 'draft' && canApprove ? `<button class="btn sm" data-st="approve" data-id="${r.id}">Approve</button> ` : '')
          + (r.status === 'approved' ? `<button class="btn sm" data-st="paid" data-id="${r.id}">Paid</button> ` : '') + (['draft', 'approved'].includes(r.status) ? `<button class="btn sm" data-st="void" data-id="${r.id}">Void</button>` : '') }] : [])],
      rows: reimb, empty: 'Nothing for this month. Draft it once the month is over.' });
      table($('[data-h]', body), { columns: [{ label: 'Employee', render: (h) => `<b>${esc(h.employeeName)}</b>${h.employeeRef ? `<div class="cell-sub">${esc(h.employeeRef)}</div>` : ''}` },
        { label: 'Measured by', render: (h) => (h.mode === 'ocpp' ? `OCPP · ${esc(h.charger ?? '')}${h.card ? `<div class="cell-sub">card ${esc(h.card)}</div>` : ''}` : `Meter${h.lastReading ? `<div class="cell-sub">${fmt.num(h.lastReading.kwhTotal, 1)} kWh on ${esc(h.lastReading.readOn)}</div>` : '<div class="cell-sub">no reading yet</div>'}`) },
        { label: 'Rate', num: true, render: (h) => `${fmt.num(h.rateMinorPerKwh, 2)} ${esc(h.currency)}/kWh` }, { label: 'Cap', num: true, render: (h) => (h.monthlyCapMinor == null ? '—' : fmt.money(h.monthlyCapMinor, h.currency)) },
        { label: '', render: (h) => (h.archived ? tag('t-mute', 'archived') : `${h.mode === 'readings' ? `<button class="btn sm" data-read="${h.id}">Readings</button> ` : ''}${canWrite ? `<button class="btn sm" data-link="${h.id}">${icon('link')} Page</button> <button class="btn sm" data-edit="${h.id}">Edit</button>` : ''}`) }],
      rows: chargers, empty: 'No employees yet.' });
      const byId = (id) => chargers.find((h) => h.id === id);
      $$('[data-read]', body).forEach((b) => b.addEventListener('click', () => readingsModal(byId(b.dataset.read))));
      $$('[data-link]', body).forEach((b) => b.addEventListener('click', () => linkModal(byId(b.dataset.link))));
      $$('[data-edit]', body).forEach((b) => b.addEventListener('click', () => chargerModal(byId(b.dataset.edit))));
      $$('[data-st]', body).forEach((b) => b.addEventListener('click', async () => { try { await api(`/v1/home-reimbursements/${b.dataset.id}/${b.dataset.st}`, { method: 'POST' }); draw(); } catch (e) { toast(e.message, 'crit'); } }));
      $('[data-month]', body).addEventListener('change', (e) => { month = e.target.value || month; draw(); });
      $('[data-draft]', body)?.addEventListener('click', async () => {
        try {
          const r = await api('/v1/home-reimbursements', { method: 'POST', body: { month } });
          toast(`${r.drafted} drafted.${r.missing.length ? ` ${r.missing.length} without the readings needed: ${r.missing.map((m) => m.employeeName).join(', ')}.` : ''}`, r.missing.length ? 'warn' : 'ok');
          draw();
        } catch (e) { toast(e.message, 'crit'); }
      });
      const dl = async (path, name) => { try { download(name, await api(path, { raw: true }).then((r) => r.blob())); } catch (e) { toast(e.message, 'crit'); } };
      $('[data-csv]', body).addEventListener('click', () => dl(`/v1/home-reimbursements/payroll.csv?month=${month}`, `home-charging-${month}.csv`));
      $('[data-xlsx]', body).addEventListener('click', () => dl(`/v1/home-reimbursements.xlsx?month=${month}`, `home-charging-${month}.xlsx`));
    };

    $('[data-add]', root)?.addEventListener('click', async () => { await draw(); chargerModal(null); });
    await draw();
  },
});
