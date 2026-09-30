import { $, $$, esc, api, attempt, registerView, pageHead, icon, field, callout, table, fmt, tag, drawer, modal, confirmDialog, toast } from '../core.js';
import { renderStatement, recentMonths, monthLabel, planText } from './statement-render.js';

/**
 * Platform billing — the platform operator's view across every customer
 * organisation: the month's statements, each customer's commission plan, which
 * sites are public (commission) or private (platform fee), and finalising a
 * month once it has ended. platform:admin only.
 */

export function planForm(plan) {
  const tierRows = plan.tiers.map((t, i) => `<div class="row" data-tier style="gap:6px;margin-bottom:6px;flex-wrap:wrap">
      <input data-k="name" value="${esc(t.name)}" style="width:120px" aria-label="Tier ${i + 1} name">
      <span class="cell-sub">below Rp</span><input data-k="upToIdr" inputmode="numeric" value="${t.upToIdr ?? ''}" placeholder="no limit" style="width:150px" aria-label="Tier ${i + 1} upper bound">
      <input data-k="rate" inputmode="decimal" value="${t.rateBps / 100}" style="width:70px" aria-label="Tier ${i + 1} rate percent"><span>%</span></div>`).join('');
  const num = (name, label, v) => field(label, `<input name="${name}" inputmode="numeric" value="${esc(v)}">`);
  return `<div class="form">
    <div class="field full"><label>Commission tiers (per site, monthly commission base)</label>${tierRows}
      <div class="help">Leave the last tier's bound empty. Bounds are exclusive: "below Rp 150,000,000".</div></div>
    ${field('Tier mode', `<select name="tierMode"><option value="whole"${plan.tierMode === 'whole' ? ' selected' : ''}>Whole month at the tier reached</option><option value="marginal"${plan.tierMode === 'marginal' ? ' selected' : ''}>Each band at its own rate</option></select>`)}
    ${field('Payment processing (MDR)', `<select name="mdrBorneBy"><option value="platform"${plan.mdrBorneBy === 'platform' ? ' selected' : ''}>Covered by the commission</option><option value="site_owner"${plan.mdrBorneBy === 'site_owner' ? ' selected' : ''}>Borne by the site owner</option></select>`)}
    ${num('minPerChargerAcIdr', 'Minimum per AC charger (Rp/month)', plan.minPerChargerAcIdr)}
    ${num('minPerChargerDcIdr', 'Minimum per DC charger (Rp/month)', plan.minPerChargerDcIdr)}
    ${num('privateFeeAcIdr', 'Private AC charger fee (Rp/month)', plan.privateFeeAcIdr)}
    ${num('privateFeeDcIdr', 'Private DC charger fee (Rp/month)', plan.privateFeeDcIdr)}
    <div class="field full"><label class="check"><input type="checkbox" name="prorate"${plan.prorate ? ' checked' : ''}> <span>Pro-rate minimums and fees by days in service</span></label></div>
  </div>`;
}

export function readPlan(body) {
  const v = (n) => $(`[name="${n}"]`, body);
  return {
    tiers: $$('[data-tier]', body).map((row) => ({
      name: $('[data-k=name]', row).value.trim(),
      upToIdr: $('[data-k=upToIdr]', row).value.replace(/[^\d]/g, '') || null,
      rateBps: Math.round(Number($('[data-k=rate]', row).value.replace(',', '.')) * 100),
    })),
    tierMode: v('tierMode').value,
    mdrBorneBy: v('mdrBorneBy').value,
    minPerChargerAcIdr: v('minPerChargerAcIdr').value.replace(/[^\d]/g, ''),
    minPerChargerDcIdr: v('minPerChargerDcIdr').value.replace(/[^\d]/g, ''),
    privateFeeAcIdr: v('privateFeeAcIdr').value.replace(/[^\d]/g, ''),
    privateFeeDcIdr: v('privateFeeDcIdr').value.replace(/[^\d]/g, ''),
    prorate: v('prorate').checked,
  };
}

registerView('platform-billing', {
  title: 'Platform billing',
  icon: 'card',
  group: 'govern',
  order: 70,
  perm: 'platform:admin',
  async render(root) {
    root.innerHTML = pageHead(
      'Platform billing',
      "Every customer's monthly statement. Set each customer's commission plan and which sites are public (commission) or private (platform fee); finalise a month after it ends to freeze and number the statement.",
      `<button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button>`,
    ) + `<div class="filters">${field('Month', '<select data-month></select>')}</div><div class="grid k4 section" data-kpis></div><div class="card" data-list></div>`;

    let data = null;
    const load = async () => {
      const m = $('[data-month]', root).value;
      try { data = await api(`/v1/platform/billing${m ? `?month=${m}` : ''}`); } catch (e) { $('[data-list]', root).innerHTML = callout('crit', esc(e.message)); return; }
      if (!m) $('[data-month]', root).innerHTML = recentMonths(data.current).map((x) => `<option value="${x}">${esc(monthLabel(x))}</option>`).join('');
      $('[data-month]', root).value = data.month;
      const sum = (k) => data.orgs.reduce((a, o) => a + (o.totals[k] ?? 0), 0);
      $('[data-kpis]', root).innerHTML = [
        ['Customers', fmt.num(data.orgs.length), `${data.orgs.filter((o) => o.status === 'final').length} finalised`],
        ['Commission base', fmt.idr(sum('gtvIdr')), 'excl. PBJT and PPN'],
        ['Platform revenue', fmt.idr(sum('netIdr')), 'before PPN'],
        ['Invoiced incl. PPN', fmt.idr(sum('totalIdr')), data.month < data.current ? 'month ended' : 'month in progress'],
      ].map(([a, b, c]) => `<div class="card kpi"><div class="label">${esc(a)}</div><div class="value">${esc(b)}</div><div class="foot">${esc(c)}</div></div>`).join('');
      table($('[data-list]', root), {
        columns: [
          { label: 'Customer', render: (o) => `<div class="cell-title">${esc(o.name)}</div><div class="cell-sub">${esc(o.sites)} sites · ${esc(o.chargers)} chargers${o.customPlan ? ' · custom plan' : ''}</div>` },
          { label: 'Status', render: (o) => (o.status === 'final' ? tag('t-ok', 'final') : tag('t-info', 'draft')) + (o.warnings ? ` ${tag('t-warn', `${o.warnings} note${o.warnings === 1 ? '' : 's'}`)}` : '') },
          { label: 'Commission base', num: true, render: (o) => fmt.idr(o.totals.gtvIdr) },
          { label: 'Commission', num: true, render: (o) => fmt.idr(o.totals.commissionIdr) },
          { label: 'Min. & fees', num: true, render: (o) => fmt.idr(o.totals.minimumTopUpIdr + o.totals.privateFeeIdr) },
          { label: 'Before PPN', num: true, render: (o) => fmt.idr(o.totals.netIdr) },
          { label: 'Total', num: true, render: (o) => `<b>${fmt.idr(o.totals.totalIdr)}</b>` },
        ],
        rows: data.orgs,
        empty: 'No customer organisations with sites.',
        onRow: (o) => openOrg(o),
      });
    };

    const openOrg = (o) => {
      const month = data.month;
      const base = `/v1/platform/billing/orgs/${o.orgId}`;
      const d = drawer({
        title: o.name,
        subtitle: esc(monthLabel(month)),
        headerHtml: `<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
          <button class="btn sm" type="button" data-print>Print / PDF</button><button class="btn sm" type="button" data-csv>CSV</button>
          ${month < data.current && o.status !== 'final' ? '<button class="btn sm primary" type="button" data-final>Finalise month</button>' : ''}</div>`,
        tabs: [
          { id: 'statement', label: 'Statement', async render(body) { const r = await api(`${base}?month=${month}`); renderStatement(body, r.statement); } },
          {
            id: 'plan', label: 'Plan',
            async render(body) {
              const r = await api(`${base}?month=${month}`);
              // A plan change takes effect from a month on; earlier months keep the rates agreed for them.
              const fromOptions = recentMonths(data.current, 13).slice(0, 4).reverse()
                .map((m) => `<option value="${m}"${m === data.current ? ' selected' : ''}>${esc(monthLabel(m))}</option>`).join('');
              body.innerHTML = `${callout('info', r.plan.custom ? `Custom plan for ${esc(monthLabel(month))}${r.plan.effectiveFrom ? `, in force from ${esc(monthLabel(r.plan.effectiveFrom))}` : ''}.` : `Standard published rates for ${esc(monthLabel(month))}.`)}
                <p class="cell-sub" style="margin:10px 0">${esc(planText(r.plan.plan))}</p>
                <div class="row" style="gap:6px;flex-wrap:wrap">${field('Change from', `<select data-from>${fromOptions}</select>`)}</div>
                <div class="row" style="gap:6px;margin-top:8px"><button class="btn sm primary" type="button" data-edit>Edit plan</button><button class="btn sm" type="button" data-reset>Published rates from then</button></div>
                <div class="section" data-hist></div>`;
              table($('[data-hist]', body), {
                columns: [
                  { label: 'Plan versions', render: (h) => `<div class="cell-title">From ${esc(monthLabel(h.effectiveFrom))}</div><div class="cell-sub">${esc(planText(h.plan))}</div>` },
                  { label: '', render: (h) => (h.custom ? tag('t-info', 'custom') : tag('t-mute', 'published')) },
                ],
                rows: r.planHistory,
                empty: 'Published rates since the start.',
              });
              const from = () => $('[data-from]', body).value;
              $('[data-edit]', body).addEventListener('click', () => modal({
                title: `Commission plan — ${o.name}, from ${monthLabel(from())}`, size: 'lg', body: planForm(r.plan.plan),
                actions: [{ label: 'Cancel' }, {
                  label: 'Save plan', kind: 'primary',
                  async onClick(ctx) {
                    try { await api(`${base}/plan`, { method: 'PUT', body: { plan: readPlan(ctx.body), effectiveFrom: from() } }); toast(`Plan saved, in force from ${monthLabel(from())}`, 'ok'); d.refresh(); load(); }
                    catch (e) { toast(e.message, 'crit'); return false; }
                  },
                }],
              }));
              $('[data-reset]', body).addEventListener('click', async () => {
                if (!(await confirmDialog({ title: `Published rates from ${monthLabel(from())}?`, message: 'Months before then keep the plan agreed for them. Finalised statements never change.', confirmLabel: 'Apply' }))) return;
                if (await attempt(() => api(`${base}/plan`, { method: 'PUT', body: { plan: null, effectiveFrom: from() } }), { success: 'Published rates applied' })) { d.refresh(); load(); }
              });
            },
          },
          {
            id: 'sites', label: 'Sites',
            async render(body) {
              const r = await api(`${base}?month=${month}`);
              body.innerHTML = `<p class="cell-sub">Public sites take driver payments and pay commission. Private sites (fleet depots, staff and residential parking) take no payment and pay a flat fee per charger.</p><div data-t></div>`;
              table($('[data-t]', body), {
                columns: [
                  { label: 'Site', render: (s) => `<div class="cell-title">${esc(s.name)}</div>` },
                  { label: 'Billing model', render: (s) => `<select data-model="${esc(s.id)}" aria-label="Billing model for ${esc(s.name)}"><option value="public"${s.billing_model === 'public' ? ' selected' : ''}>Public — commission</option><option value="private"${s.billing_model === 'private' ? ' selected' : ''}>Private — platform fee</option></select>` },
                ],
                rows: r.sites,
                empty: 'No sites.',
              });
              $$('[data-model]', body).forEach((sel) => sel.addEventListener('change', async () => {
                if (await attempt(() => api(`/v1/platform/billing/sites/${sel.dataset.model}/model`, { method: 'PUT', body: { model: sel.value } }), { success: 'Billing model saved' })) load();
              }));
            },
          },
        ],
      });
      $('[data-print]', d.el).addEventListener('click', () => window.open(`${base}/statement.html?month=${month}`, '_blank', 'noopener'));
      $('[data-csv]', d.el).addEventListener('click', () => { location.href = `${base}/statement.csv?month=${month}`; });
      $('[data-final]', d.el)?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Finalise ${monthLabel(month)} for ${o.name}?`, message: 'The statement is frozen and numbered. Later changes to rates or late-rated sessions do not alter it.', confirmLabel: 'Finalise' }))) return;
        const r = await attempt(() => api(`${base}/finalise`, { method: 'POST', body: { month } }));
        if (r) { toast(`Finalised — ${r.number}`, 'ok'); d.close(); load(); }
      });
    };

    $('[data-month]', root).addEventListener('change', load);
    $('[data-refresh]', root).addEventListener('click', load);
    await load();
  },
});
