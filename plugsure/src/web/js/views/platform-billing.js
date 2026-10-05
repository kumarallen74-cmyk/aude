import { $, $$, esc, api, attempt, registerView, pageHead, icon, field, callout, table, fmt, tag, drawer, modal, confirmDialog, toast, isRupiah, LEGACY_CURRENCY } from '../core.js';
import { renderStatement, recentMonths, monthLabel, planText } from './statement-render.js';

/**
 * Platform billing — the platform operator's view across every customer
 * organisation: the month's statements, each customer's commission plan, which
 * sites are public (commission) or private (platform fee), and finalising a
 * month once it has ended. platform:admin only.
 */

/** Plan amounts are in the plan currency's minor units: rupiah as before; sen / cents for MYR / SGD. */
export function planForm(plan, cur) {
  const unit = isRupiah(cur) ? fmt.sym(cur) : `${cur} minor units`;
  const tierRows = plan.tiers.map((t, i) => `<div class="row" data-tier style="gap:6px;margin-bottom:6px;flex-wrap:wrap">
      <input data-k="name" value="${esc(t.name)}" style="width:120px" aria-label="Tier ${i + 1} name">
      <span class="cell-sub">below ${esc(unit)}</span><input data-k="upToMinor" inputmode="numeric" value="${t.upToMinor ?? ''}" placeholder="no limit" style="width:150px" aria-label="Tier ${i + 1} upper bound">
      <input data-k="rate" inputmode="decimal" value="${t.rateBps / 100}" style="width:70px" aria-label="Tier ${i + 1} rate percent"><span>%</span></div>`).join('');
  const num = (name, label, v) => field(label, `<input name="${name}" inputmode="numeric" value="${esc(v)}">`);
  return `<div class="form">
    <div class="field full"><label>Commission tiers (per site, monthly commission base)</label>${tierRows}
      <div class="help">Leave the last tier's bound empty. Bounds are exclusive: "below ${esc(isRupiah(cur) ? fmt.money(150000000) : `${unit} 4300000`)}".${isRupiah(cur) ? '' : ` In ${esc(cur)} minor units: 100 = ${esc(fmt.money(100, cur))}.`}</div></div>
    ${field('Tier mode', `<select name="tierMode"><option value="whole"${plan.tierMode === 'whole' ? ' selected' : ''}>Whole month at the tier reached</option><option value="marginal"${plan.tierMode === 'marginal' ? ' selected' : ''}>Each band at its own rate</option></select>`)}
    ${field('Payment processing (MDR)', `<select name="mdrBorneBy"><option value="platform"${plan.mdrBorneBy === 'platform' ? ' selected' : ''}>Covered by the commission</option><option value="site_owner"${plan.mdrBorneBy === 'site_owner' ? ' selected' : ''}>Borne by the site owner</option></select>`)}
    ${num('minPerChargerAcMinor', `Minimum per AC charger (${unit}/month)`, plan.minPerChargerAcMinor)}
    ${num('minPerChargerDcMinor', `Minimum per DC charger (${unit}/month)`, plan.minPerChargerDcMinor)}
    ${num('privateFeeAcMinor', `Private AC charger fee (${unit}/month)`, plan.privateFeeAcMinor)}
    ${num('privateFeeDcMinor', `Private DC charger fee (${unit}/month)`, plan.privateFeeDcMinor)}
    <div class="field full"><label class="check"><input type="checkbox" name="prorate"${plan.prorate ? ' checked' : ''}> <span>Pro-rate minimums and fees by days in service</span></label></div>
  </div>`;
}

export function readPlan(body) {
  const v = (n) => $(`[name="${n}"]`, body);
  return {
    tiers: $$('[data-tier]', body).map((row) => ({
      name: $('[data-k=name]', row).value.trim(),
      upToMinor: $('[data-k=upToMinor]', row).value.replace(/[^\d]/g, '') || null,
      rateBps: Math.round(Number($('[data-k=rate]', row).value.replace(',', '.')) * 100),
    })),
    tierMode: v('tierMode').value,
    mdrBorneBy: v('mdrBorneBy').value,
    minPerChargerAcMinor: v('minPerChargerAcMinor').value.replace(/[^\d]/g, ''),
    minPerChargerDcMinor: v('minPerChargerDcMinor').value.replace(/[^\d]/g, ''),
    privateFeeAcMinor: v('privateFeeAcMinor').value.replace(/[^\d]/g, ''),
    privateFeeDcMinor: v('privateFeeDcMinor').value.replace(/[^\d]/g, ''),
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
    // Statements are per (customer, currency): the totals are per currency, never added across currencies.
    const perCur = (k) => {
      const by = {};
      for (const o of data.orgs) by[o.currency ?? LEGACY_CURRENCY] = (by[o.currency ?? LEGACY_CURRENCY] ?? 0) + (o.totals[k] ?? 0);
      return Object.entries(by).map(([c, n]) => fmt.money(n, c)).join(' · ');
    };

    let data = null;
    const load = async () => {
      const m = $('[data-month]', root).value;
      try { data = await api(`/v1/platform/billing${m ? `?month=${m}` : ''}`); } catch (e) { $('[data-list]', root).innerHTML = callout('crit', esc(e.message)); return; }
      if (!m) $('[data-month]', root).innerHTML = recentMonths(data.current).map((x) => `<option value="${x}">${esc(monthLabel(x))}</option>`).join('');
      $('[data-month]', root).value = data.month;
      $('[data-kpis]', root).innerHTML = [
        ['Customers', fmt.num(new Set(data.orgs.map((o) => o.orgId)).size), `${data.orgs.filter((o) => o.status === 'final').length} finalised`],
        ['Commission base', perCur('gtvMinor') || fmt.idr(0), 'excl. PBJT and PPN'],
        ['Platform revenue', perCur('netMinor') || fmt.idr(0), 'before PPN'],
        ['Invoiced incl. PPN', perCur('totalMinor') || fmt.idr(0), data.month < data.current ? 'month ended' : 'month in progress'],
      ].map(([a, b, c]) => `<div class="card kpi"><div class="label">${esc(a)}</div><div class="value">${esc(b)}</div><div class="foot">${esc(c)}</div></div>`).join('');
      table($('[data-list]', root), {
        columns: [
          { label: 'Customer', render: (o) => `<div class="cell-title">${esc(o.name)}${!isRupiah(o.currency) ? ` ${tag('t-info', o.currency)}` : ''}</div><div class="cell-sub">${esc(o.sites)} sites · ${esc(o.chargers)} chargers${o.customPlan ? ' · custom plan' : ''}</div>` },
          { label: 'Status', render: (o) => (o.status === 'final' ? tag('t-ok', 'final') : tag('t-info', 'draft')) + (o.warnings ? ` ${tag('t-warn', `${o.warnings} note${o.warnings === 1 ? '' : 's'}`)}` : '') },
          { label: 'Commission base', num: true, render: (o) => fmt.money(o.totals.gtvMinor, o.currency) },
          { label: 'Commission', num: true, render: (o) => fmt.money(o.totals.commissionMinor, o.currency) },
          { label: 'Min. & fees', num: true, render: (o) => fmt.money(o.totals.minimumTopUpMinor + o.totals.privateFeeMinor, o.currency) },
          { label: 'Before tax', num: true, render: (o) => fmt.money(o.totals.netMinor, o.currency) },
          { label: 'Total', num: true, render: (o) => `<b>${fmt.money(o.totals.totalMinor, o.currency)}</b>` },
        ],
        rows: data.orgs,
        empty: 'No customer organisations with sites.',
        onRow: (o) => openOrg(o),
      });
    };

    const openOrg = (o) => {
      const month = data.month;
      const base = `/v1/platform/billing/orgs/${o.orgId}`;
      const cur = o.currency;
      const cq = isRupiah(cur) ? '' : `&currency=${cur}`;
      const d = drawer({
        title: o.name,
        subtitle: esc(monthLabel(month)),
        headerHtml: `<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
          <button class="btn sm" type="button" data-print>Print / PDF</button><button class="btn sm" type="button" data-csv>CSV</button>
          ${month < data.current && o.status !== 'final' ? '<button class="btn sm primary" type="button" data-final>Finalise month</button>' : ''}</div>`,
        tabs: [
          { id: 'statement', label: 'Statement', async render(body) { const r = await api(`${base}?month=${month}${cq}`); renderStatement(body, r.statement); } },
          {
            id: 'plan', label: 'Plan',
            async render(body) {
              const r = await api(`${base}?month=${month}${cq}`);
              // A plan change takes effect from a month on; earlier months keep the rates agreed for them.
              const fromOptions = recentMonths(data.current, 13).slice(0, 4).reverse()
                .map((m) => `<option value="${m}"${m === data.current ? ' selected' : ''}>${esc(monthLabel(m))}</option>`).join('');
              body.innerHTML = `${callout('info', r.plan.custom ? `Custom plan for ${esc(monthLabel(month))}${r.plan.effectiveFrom ? `, in force from ${esc(monthLabel(r.plan.effectiveFrom))}` : ''}.` : `Standard published rates for ${esc(monthLabel(month))}.`)}
                <p class="cell-sub" style="margin:10px 0">${esc(planText(r.plan.plan, cur))}</p>
                <div class="row" style="gap:6px;flex-wrap:wrap">${field('Change from', `<select data-from>${fromOptions}</select>`)}</div>
                <div class="row" style="gap:6px;margin-top:8px"><button class="btn sm primary" type="button" data-edit>Edit plan</button><button class="btn sm" type="button" data-reset>Published rates from then</button></div>
                <div class="section" data-hist></div>`;
              table($('[data-hist]', body), {
                columns: [
                  { label: 'Plan versions', render: (h) => `<div class="cell-title">From ${esc(monthLabel(h.effectiveFrom))}</div><div class="cell-sub">${esc(planText(h.plan, cur))}</div>` },
                  { label: '', render: (h) => (h.custom ? tag('t-info', 'custom') : tag('t-mute', 'published')) },
                ],
                rows: r.planHistory,
                empty: 'Published rates since the start.',
              });
              const from = () => $('[data-from]', body).value;
              $('[data-edit]', body).addEventListener('click', () => modal({
                title: `Commission plan — ${o.name}, from ${monthLabel(from())}`, size: 'lg', body: planForm(r.plan.plan, cur),
                actions: [{ label: 'Cancel' }, {
                  label: 'Save plan', kind: 'primary',
                  async onClick(ctx) {
                    try { await api(`${base}/plan`, { method: 'PUT', body: { plan: readPlan(ctx.body), effectiveFrom: from(), currency: cur } }); toast(`Plan saved, in force from ${monthLabel(from())}`, 'ok'); d.refresh(); load(); }
                    catch (e) { toast(e.message, 'crit'); return false; }
                  },
                }],
              }));
              $('[data-reset]', body).addEventListener('click', async () => {
                if (!(await confirmDialog({ title: `Published rates from ${monthLabel(from())}?`, message: 'Months before then keep the plan agreed for them. Finalised statements never change.', confirmLabel: 'Apply' }))) return;
                if (await attempt(() => api(`${base}/plan`, { method: 'PUT', body: { plan: null, effectiveFrom: from(), currency: cur } }), { success: 'Published rates applied' })) { d.refresh(); load(); }
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
      $('[data-print]', d.el).addEventListener('click', () => window.open(`${base}/statement.html?month=${month}${cq}`, '_blank', 'noopener'));
      $('[data-csv]', d.el).addEventListener('click', () => { location.href = `${base}/statement.csv?month=${month}${cq}`; });
      $('[data-final]', d.el)?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Finalise ${monthLabel(month)} for ${o.name}?`, message: 'The statement is frozen and numbered. Later changes to rates or late-rated sessions do not alter it.', confirmLabel: 'Finalise' }))) return;
        const r = await attempt(() => api(`${base}/finalise`, { method: 'POST', body: { month, currency: cur } }));
        if (r) { toast(`Finalised — ${r.number}`, 'ok'); d.close(); load(); }
      });
    };

    $('[data-month]', root).addEventListener('change', load);
    $('[data-refresh]', root).addEventListener('click', load);
    await load();
  },
});
