import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options, copy, download } from '../core.js';

/**
 * (v1.50.0) Commercial → Dealers: car dealers bundle charging with the cars they sell. Each sale gets a welcome code
 * (credit in the app); the dealer pays for the credit or the operator does; the dealer earns a commission on its
 * buyers' charging. Monthly statements, and a portal link for the dealer's staff.
 */

const SALE = { pending: ['t-info', 'code not used yet'], redeemed: ['t-ok', 'redeemed'], expired: ['t-mute', 'expired'], void: ['t-mute', 'void'] };
const STMT = { draft: ['t-mute', 'draft'], issued: ['t-warn', 'issued'], settled: ['t-ok', 'settled'] };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const pct = (bps) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)} %`;

registerView('dealers', {
  title: 'Dealers',
  icon: 'users',
  group: 'commercial',
  order: 27,
  perm: 'invoice:read',
  async render(root) {
    const canWrite = state.can('invoice:write');
    root.innerHTML = pageHead('Dealers', 'Car dealers bundle charging with the cars they sell: buyers get welcome credit in the app, and the dealer earns a commission on their charging.',
      canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} Add a dealer</button>` : '')
      + '<div class="tabs" role="tablist"><button role="tab" type="button" data-tab="d">Dealers</button><button role="tab" type="button" data-tab="s">Sales</button><button role="tab" type="button" data-tab="st">Statements</button></div><div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    let tab = 'd', list = [], cur = '';

    const showOnce = (title, text, value) => modal({ title, body: `${callout('warn', text)}<div style="display:flex;gap:6px;margin-top:8px"><input readonly value="${esc(value)}" style="flex:1;font-family:var(--mono, monospace)"><button class="btn" type="button" data-cpy>${icon('copy')} Copy</button></div>`,
      onMount: (mc) => $('[data-cpy]', mc.el).addEventListener('click', () => copy(value)) });

    const dealerModal = (d) => modal({ title: d ? d.name : 'Add a dealer', size: 'lg', body: `<div class="form grid2">${field('Name', `<input name="name" maxlength="120" value="${esc(d?.name ?? '')}">`)}
        ${field('Car brand', `<input name="make" maxlength="60" value="${esc(d?.make ?? '')}" placeholder="Wuling, Hyundai, BYD …">`)}${field('Branch', `<input name="branch" maxlength="120" value="${esc(d?.branch ?? '')}">`)}
        ${field('Contact', `<input name="contact" maxlength="120" value="${esc(d?.contactName ?? '')}">`)}${field('E-mail', `<input name="email" type="email" value="${esc(d?.email ?? '')}">`)}${field('Phone', `<input name="phone" maxlength="30" value="${esc(d?.phone ?? '')}">`)}
        ${field('Welcome credit per buyer (minor units)', `<input name="welcome" type="number" min="0" value="${d?.welcomeMinor ?? 0}">`)}
        ${field('A code is valid for (days)', `<input name="days" type="number" min="7" max="365" value="${d?.codeDays ?? 90}">`)}
        ${field('The welcome credit is paid by', `<select name="funding">${options([{ value: 'dealer', label: 'The dealer (billed when a buyer redeems it)' }, { value: 'operator', label: 'Us (our promotion)' }], d?.funding ?? 'dealer')}</select>`)}
        ${field('Commission on buyers\' charging (%)', `<input name="comm" type="number" min="0" max="50" step="0.01" value="${(d?.commissionBps ?? 0) / 100}">`, { help: 'Of their charging before tax.' })}
        ${field('For (months after the buyer joins)', `<input name="months" type="number" min="1" max="60" value="${d?.commissionMonths ?? 12}">`)}</div>`,
    actions: [...(d ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { if (!confirm('Archive this dealer? Its portal link stops.')) return false; await api(`/v1/dealers/${d.id}`, { method: 'PUT', body: { archive: true } }); draw(); }) },
      { label: 'Portal link', onClick: guard(async () => { const r = await api(`/v1/dealers/${d.id}/portal`, { method: 'POST' }); showOnce('The dealer\'s portal', 'Shown once: give it to the dealer\'s sales staff. A new link replaces the old one.', `${location.origin}${r.path}`); }) }] : []),
      { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
        const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
        await api(d ? `/v1/dealers/${d.id}` : '/v1/dealers', { method: d ? 'PUT' : 'POST', body: { name: v('name'), make: v('make') || null, branch: v('branch') || null, contactName: v('contact') || null,
          email: v('email') || null, phone: v('phone') || null, welcomeMinor: Number(v('welcome') || 0), codeDays: Number(v('days')), funding: v('funding'),
          commissionBps: Math.round(Number(v('comm') || 0) * 100), commissionMonths: Number(v('months')) } });
        toast('Saved.', 'ok'); draw();
      }) }] });

    const saleModal = (d) => modal({ title: `Register a car sold · ${d.name}`, body: `<div class="form grid2">${field('Buyer', '<input name="buyer" maxlength="120">')}
        ${field('Buyer\'s mobile', '<input name="phone" maxlength="30" placeholder="08…">', { help: 'Only this number can redeem the code.' })}
        ${field('Car', `<input name="veh" maxlength="80" placeholder="${esc(d.make ?? '')}">`)}${field('VIN', '<input name="vin" maxlength="17">')}
        ${field('Plate', '<input name="plate" maxlength="15">')}${field('Sold on', `<input name="on" type="date" value="${new Date().toISOString().slice(0, 10)}">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Register', kind: 'primary', onClick: guard(async (mc) => {
      const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
      const r = await api(`/v1/dealers/${d.id}/sales`, { method: 'POST', body: { buyerName: v('buyer'), buyerPhone: v('phone') || null, vehicle: v('veh') || null, vin: v('vin') || null, plate: v('plate') || null, soldOn: v('on') } });
      showOnce(`${r.number}: the welcome code`, `Shown once: give it to the buyer. They enter it in the app (Account → Credit) for ${fmt.money(r.welcomeMinor, r.currency)} of credit, by ${esc(r.codeExpiresOn)}.`, r.code);
      draw();
    }) }] });

    const draw = async () => {
      $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
      try {
        ({ dealers: list } = await api('/v1/dealers'));
        if (tab === 'd') {
          const m = new Date().toISOString().slice(0, 7);
          const prev = await Promise.all(list.map((d) => api(`/v1/dealers/${d.id}/preview?month=${m}`).catch(() => null)));
          const tot = prev.filter(Boolean).reduce((a, p) => ({ sales: a.sales + p.sales, red: a.red + p.redeemed, rev: a.rev + p.revenueMinor, com: a.com + p.commissionMinor, cur: p.currency }), { sales: 0, red: 0, rev: 0, com: 0, cur: list[0]?.currency });
          body.innerHTML = `<div class="grid k4">${kpi('Dealers', fmt.num(list.length))}${kpi('Cars sold this month', fmt.num(tot.sales), `${fmt.num(tot.red)} codes redeemed`)}
              ${kpi('Their buyers\' charging', fmt.money(tot.rev, tot.cur), 'this month, before tax')}${kpi('Commission due', fmt.money(tot.com, tot.cur), 'this month so far')}</div>
            <div class="card section"><header><h3>Dealers</h3></header><div data-t></div></div>`;
          table($('[data-t]', body), { columns: [{ label: 'Dealer', render: (d) => `<b>${esc(d.name)}</b><div class="cell-sub">${esc([d.make, d.branch].filter(Boolean).join(' · '))}</div>` },
            { label: 'Welcome credit', num: true, render: (d) => `${fmt.money(d.welcomeMinor, d.currency)}<div class="cell-sub">paid by ${d.funding === 'dealer' ? 'the dealer' : 'us'}</div>` },
            { label: 'Commission', num: true, render: (d) => `${pct(d.commissionBps)}<div class="cell-sub">${d.commissionMonths} months</div>` },
            { label: 'Cars sold', num: true, render: (d) => `${fmt.num(d.sales)}<div class="cell-sub">${fmt.num(d.sales30d)} in 30 days</div>` },
            { label: 'Codes', num: true, render: (d) => `${fmt.num(d.redeemed)} redeemed<div class="cell-sub">${fmt.num(d.pendingCodes)} waiting</div>` },
            { label: 'Portal', render: (d) => (d.portalLinked ? tag('t-ok', 'linked') : tag('t-mute', 'no link')) },
            ...(canWrite ? [{ label: '', render: (d) => `<button class="btn sm" data-sale="${d.id}">${icon('plus')} Sale</button>` }] : [])],
          rows: list, empty: 'No dealers yet.', onRow: canWrite ? dealerModal : undefined });
          $$('[data-sale]', body).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); saleModal(list.find((x) => x.id === b.dataset.sale)); }));
        } else if (tab === 's') {
          const { sales } = await api(`/v1/dealer-sales${cur ? `?dealerId=${cur}` : ''}`);
          body.innerHTML = `<div class="card section"><header><h3>Cars sold</h3><select data-f class="right" style="width:auto">${options([{ value: '', label: 'Every dealer' }, ...list.map((d) => ({ value: d.id, label: d.name }))], cur)}</select></header><div data-t></div></div>`;
          table($('[data-t]', body), { columns: [{ label: 'Sale', render: (s) => `<b>${esc(s.number)}</b><div class="cell-sub">${esc(s.soldOn)}${s.createdVia === 'portal' ? ' · by the dealer' : ''}</div>` },
            { label: 'Dealer', render: (s) => esc(s.dealer ?? '') }, { label: 'Buyer', render: (s) => `${esc(s.buyerName)}<div class="cell-sub">${esc(s.buyerPhone ?? '')}</div>` },
            { label: 'Car', render: (s) => `${esc(s.vehicle ?? '')}<div class="cell-sub">${esc(s.vin ?? '')} ${esc(s.plate ?? '')}</div>` },
            { label: 'Code', render: (s) => `${tag(...SALE[s.status])}<div class="cell-sub">…${esc(s.codeLast4)}${s.status === 'pending' ? ` · until ${esc(s.codeExpiresOn)}` : ''}</div>` },
            { label: 'Credit', num: true, render: (s) => fmt.money(s.welcomeMinor, s.currency) },
            ...(canWrite ? [{ label: '', render: (s) => (s.status === 'pending' ? `<button class="btn sm" data-void="${s.id}">Void</button>` : '') }] : [])], rows: sales, empty: 'No sales yet.' });
          $('[data-f]', body).addEventListener('change', (e) => { cur = e.target.value; draw(); });
          $$('[data-void]', body).forEach((b) => b.addEventListener('click', async () => { if (!confirm('Void this sale? Its code stops working.')) return; try { await api(`/v1/dealer-sales/${b.dataset.void}/void`, { method: 'POST' }); draw(); } catch (e) { toast(e.message, 'crit'); } }));
        } else {
          const { statements } = await api('/v1/dealer-statements');
          body.innerHTML = `<div class="card section"><header><h3>Statements</h3><span class="cell-sub">Last month is drafted automatically; issue it once checked</span>
            ${canWrite && list.length ? `<div class="right" style="display:flex;gap:6px"><select data-dd style="width:auto">${options(list.map((d) => ({ value: d.id, label: d.name })), list[0].id)}</select><input type="month" data-m style="width:auto"><button class="btn sm" data-draft>Draft</button></div>` : ''}</header><div data-t></div></div>`;
          table($('[data-t]', body), { columns: [{ label: 'Month', render: (s) => `<b>${esc(s.month)}</b>` }, { label: 'Dealer', render: (s) => esc(s.dealer ?? '') },
            { label: 'Sold · redeemed', num: true, render: (s) => `${fmt.num(s.sales)} · ${fmt.num(s.redeemed)}` }, { label: 'Billed (credit)', num: true, render: (s) => fmt.money(s.billedMinor, s.currency) },
            { label: 'Buyers\' charging', num: true, render: (s) => `${fmt.money(s.revenueMinor, s.currency)}<div class="cell-sub">${fmt.num(s.kwh, 1)} kWh · ${fmt.num(s.drivers)} drivers</div>` },
            { label: 'Commission', num: true, render: (s) => fmt.money(s.commissionMinor, s.currency) },
            { label: 'Net', num: true, render: (s) => `<b>${fmt.money(Math.abs(s.netMinor), s.currency)}</b><div class="cell-sub">${s.netMinor > 0 ? 'the dealer pays' : s.netMinor < 0 ? 'we pay the dealer' : 'nothing due'}</div>` },
            { label: 'Status', render: (s) => `${tag(...STMT[s.status])}${s.reference ? `<div class="cell-sub">${esc(s.reference)}</div>` : ''}` },
            { label: '', render: (s) => `<button class="btn sm" data-x="${s.id}" title="Spreadsheet">${icon('download')}</button>${canWrite && s.status === 'draft' ? ` <button class="btn sm" data-issue="${s.id}">Issue</button>` : ''}${canWrite && s.status === 'issued' ? ` <button class="btn sm" data-settle="${s.id}">Settled</button>` : ''}` }],
          rows: statements, empty: 'No statements yet.' });
          const act = async (id, b) => { try { await api(`/v1/dealer-statements/${id}`, { method: 'POST', body: b }); toast('Done.', 'ok'); draw(); } catch (e) { toast(e.message, 'crit'); } };
          $$('[data-issue]', body).forEach((b) => b.addEventListener('click', () => confirm('Issue this statement? It is refreshed one last time and then fixed.') && act(b.dataset.issue, { action: 'issue' })));
          $$('[data-settle]', body).forEach((b) => b.addEventListener('click', () => { const reference = prompt('The payment\'s reference'); if (reference) act(b.dataset.settle, { action: 'settle', reference }); }));
          $$('[data-x]', body).forEach((b) => b.addEventListener('click', async () => { try { download(`dealer-statement-${b.dataset.x}.xlsx`, await api(`/v1/dealer-statements/${b.dataset.x}/statement.xlsx`, { raw: true }).then((r) => r.blob())); } catch (e) { toast(e.message, 'crit'); } }));
          $('[data-draft]', body)?.addEventListener('click', async () => {
            const month = $('[data-m]', body).value; if (!month) { toast('Choose the month.', 'warn'); return; }
            try { await api(`/v1/dealers/${$('[data-dd]', body).value}/statements`, { method: 'POST', body: { month } }); draw(); } catch (e) { toast(e.message, 'crit'); }
          });
        }
      } catch (e) { body.innerHTML = callout('crit', esc(e.message)); }
    };

    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; draw(); }));
    $('[data-add]', root)?.addEventListener('click', () => dealerModal(null));
    await draw();
  },
});
