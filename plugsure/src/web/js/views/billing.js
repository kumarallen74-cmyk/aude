import { $, esc, api, attempt, state, registerView, pageHead, icon, field, callout, table, fmt, tag, drawer, modal, confirmDialog, toast, kpi, download } from '../core.js';
import { renderStatement, recentMonths, monthLabel, planText } from './statement-render.js';
import { planForm, readPlan } from './platform-billing.js';

/**
 * Billing — the operator's month across its site owners: charging units
 * (sessions, kWh) and amounts (gross collected, taxes, commission base), the
 * split between each owner and the operator, and the operator's own sites.
 * Per owner: the statement, the plan (versioned by month) and finalising.
 */

const csvCell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };

registerView('billing', {
  title: 'Billing',
  icon: 'chart',
  group: 'commercial',
  order: 25,
  perm: 'invoice:read',
  async render(root) {
    const canWrite = state.can('invoice:write');
    const opName = state.me?.org?.name ?? 'Operator';
    root.innerHTML = pageHead(
      'Billing',
      `Charging units and amounts for every site owner, and how each month's commission base (what drivers paid, excluding PBJT-TL and PPN) is shared between the owner and ${esc(opName)}. Finalise a month after it ends to freeze and number each owner's statement.`,
      `<button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button><button class="btn" type="button" data-csv>${icon('download')} CSV</button>`,
    ) + `<div class="filters">${field('Month', '<select data-month></select>')}${field('Currency', '<select data-cur></select>', { attrs: 'data-cur-field hidden' })}</div>
      <div class="grid k4 section" data-kpis></div><div class="card section" data-list></div>
      <p class="cell-sub">Owner share = commission base − ${esc(opName)}'s fee (before PPN) − payment processing (QRIS MDR, estimated). Sites with no owner are ${esc(opName)}'s own: everything after taxes and MDR is ${esc(opName)}'s.</p>`;

    let data = null;
    // One statement per currency (§D9): the month's figures for one currency at a time, never added across currencies.
    let cur = null;
    const money = (n) => fmt.money(n, cur);
    const load = async () => {
      const m = $('[data-month]', root).value;
      const qs = new URLSearchParams();
      if (m) qs.set('month', m);
      if (cur) qs.set('currency', cur);
      try { data = await api(`/v1/billing/owners${qs.toString() ? `?${qs}` : ''}`); } catch (e) {
        $('[data-list]', root).innerHTML = callout('crit', esc(e.status === 403 ? 'Billing needs organisation-wide invoice access.' : e.message));
        return;
      }
      if (!m) $('[data-month]', root).innerHTML = recentMonths(data.current).map((x) => `<option value="${x}">${esc(monthLabel(x))}</option>`).join('');
      $('[data-month]', root).value = data.period;
      cur = data.currency ?? cur;
      const curs = data.currencies ?? [];
      $('[data-cur-field]', root).hidden = curs.length < 2;
      $('[data-cur]', root).innerHTML = curs.map((c) => `<option value="${esc(c)}"${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('');
      const T = data.totals;
      $('[data-kpis]', root).innerHTML = [
        kpi('Charging units', `${fmt.num(T.energyKwh, 1)} kWh`, `${fmt.num(T.sessions)} sessions · ${fmt.num(T.chargers)} chargers`),
        kpi('Gross collected', money(T.grossMinor), `commission base ${money(T.baseMinor)} after PBJT and PPN`),
        kpi("Owners' share", money(T.ownerShareMinor), `${data.owners.length} owner${data.owners.length === 1 ? '' : 's'}`),
        kpi(`${opName} share`, money(T.platformShareMinor), 'fees from owners + own sites, before PPN', 'ok'),
      ].join('');
      const rows = [...data.owners, { ...data.operatorOwn, own: true, name: `${opName} — own sites (no owner)` }];
      const foot = `<tr><td><b>Total</b></td><td class="num">${fmt.num(T.sessions)}</td><td class="num">${fmt.num(T.energyKwh, 1)}</td><td class="num">${money(T.grossMinor)}</td><td class="num">${money(T.localTaxMinor + T.taxMinor)}</td><td class="num"><b>${money(T.baseMinor)}</b></td><td class="num"><b>${money(T.ownerShareMinor)}</b></td><td class="num"><b>${money(T.platformShareMinor)}</b></td><td class="num">${money(T.mdrMinor)}</td><td></td></tr>`;
      table($('[data-list]', root), {
        columns: [
          { label: 'Owner', render: (o) => `<div class="cell-title">${esc(o.name)}</div><div class="cell-sub">${fmt.num(o.sites)} site${o.sites === 1 ? '' : 's'} · ${fmt.num(o.chargers)} charger${o.chargers === 1 ? '' : 's'}${o.customPlan ? ' · own plan' : ''}${o.archived ? ' · archived' : ''}</div>` },
          { label: 'Sessions', num: true, render: (o) => fmt.num(o.sessions) },
          { label: 'kWh', num: true, render: (o) => fmt.num(o.energyKwh, 1) },
          { label: 'Gross', num: true, render: (o) => money(o.grossMinor) },
          { label: 'PBJT + PPN', num: true, render: (o) => money(o.localTaxMinor + o.taxMinor) },
          { label: 'Commission base', num: true, render: (o) => money(o.baseMinor) },
          { label: 'Owner share', num: true, render: (o) => (o.own ? '—' : `<b>${money(o.ownerShareMinor)}</b>`) },
          { label: `${opName} share`, num: true, render: (o) => `<b>${money(o.platformShareMinor)}</b>` },
          { label: 'MDR', num: true, render: (o) => money(o.mdrMinor) },
          { label: 'Statement', render: (o) => (o.own ? '' : (o.status === 'final' ? tag('t-ok', 'final') : tag('t-info', 'draft')) + (o.warnings ? ` ${tag('t-warn', `${o.warnings} note${o.warnings === 1 ? '' : 's'}`)}` : '')) },
        ],
        rows,
        foot,
        empty: 'No site owners yet. Add them under Commercial → Owners and assign their sites.',
        onRow: (o) => (o.own ? null : openOwner(o)),
      });
    };

    const openOwner = (o) => {
      const month = data.period;
      const q = `?ownerId=${o.ownerId}&month=${month}${cur ? `&currency=${cur}` : ''}`;
      const d = drawer({
        title: o.name,
        subtitle: esc(monthLabel(month)),
        headerHtml: `<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
          <button class="btn sm" type="button" data-print>Print / PDF</button><button class="btn sm" type="button" data-csv1>CSV</button>
          ${canWrite && month < data.current && o.status !== 'final' ? '<button class="btn sm primary" type="button" data-final>Finalise month</button>' : ''}</div>`,
        tabs: [
          { id: 'statement', label: 'Statement', async render(body) { renderStatement(body, await api(`/v1/billing/statement${q}`)); } },
          {
            id: 'plan', label: 'Plan',
            async render(body) {
              const r = await api(`/v1/billing/owners/${o.ownerId}/plan?month=${month}${cur ? `&currency=${cur}` : ''}`);
              const fromOptions = recentMonths(data.current, 13).slice(0, 4).reverse()
                .map((m) => `<option value="${m}"${m === data.current ? ' selected' : ''}>${esc(monthLabel(m))}</option>`).join('');
              body.innerHTML = `${callout('info', r.plan.custom ? `Own plan for ${esc(monthLabel(month))}, in force from ${esc(monthLabel(r.plan.effectiveFrom))}.` : `Published rates for ${esc(monthLabel(month))}.`)}
                <p class="cell-sub" style="margin:10px 0">${esc(planText(r.plan.plan, cur))}</p>
                ${canWrite ? `<div class="row" style="gap:6px;flex-wrap:wrap">${field('Change from', `<select data-from>${fromOptions}</select>`)}</div>
                <div class="row" style="gap:6px;margin-top:8px"><button class="btn sm primary" type="button" data-edit>Edit plan</button><button class="btn sm" type="button" data-reset>Published rates from then</button></div>` : ''}
                <div class="section" data-hist></div>`;
              table($('[data-hist]', body), {
                columns: [
                  { label: 'Plan versions', render: (h) => `<div class="cell-title">From ${esc(monthLabel(h.effectiveFrom))}</div><div class="cell-sub">${esc(planText(h.plan, cur))}</div>` },
                  { label: '', render: (h) => (h.custom ? tag('t-info', 'custom') : tag('t-mute', 'published')) },
                ],
                rows: r.history,
                empty: 'Published rates since the start.',
              });
              if (!canWrite) return;
              const from = () => $('[data-from]', body).value;
              $('[data-edit]', body).addEventListener('click', () => modal({
                title: `Plan — ${o.name}, from ${monthLabel(from())}`, size: 'lg', body: planForm(r.plan.plan, cur),
                actions: [{ label: 'Cancel' }, {
                  label: 'Save plan', kind: 'primary',
                  async onClick(ctx) {
                    try { await api(`/v1/billing/owners/${o.ownerId}/plan`, { method: 'PUT', body: { plan: readPlan(ctx.body), effectiveFrom: from(), currency: cur } }); toast(`Plan saved, in force from ${monthLabel(from())}`, 'ok'); d.refresh(); load(); }
                    catch (e) { toast(e.message, 'crit'); return false; }
                  },
                }],
              }));
              $('[data-reset]', body).addEventListener('click', async () => {
                if (!(await confirmDialog({ title: `Published rates from ${monthLabel(from())}?`, message: 'Months before then keep the plan agreed for them. Finalised statements never change.', confirmLabel: 'Apply' }))) return;
                if (await attempt(() => api(`/v1/billing/owners/${o.ownerId}/plan`, { method: 'PUT', body: { plan: null, effectiveFrom: from(), currency: cur } }), { success: 'Published rates applied' })) { d.refresh(); load(); }
              });
            },
          },
        ],
      });
      $('[data-print]', d.el).addEventListener('click', () => window.open(`/v1/billing/statement.html${q}`, '_blank', 'noopener'));
      $('[data-csv1]', d.el).addEventListener('click', () => { location.href = `/v1/billing/statement.csv${q}`; });
      $('[data-final]', d.el)?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Finalise ${monthLabel(month)} for ${o.name}?`, message: 'The statement is frozen and numbered, and the owner sees it as final. Later rate changes or late sessions do not alter it.', confirmLabel: 'Finalise' }))) return;
        const r = await attempt(() => api(`/v1/billing/owners/${o.ownerId}/finalise`, { method: 'POST', body: { month, currency: cur } }));
        if (r) { toast(`Finalised — ${r.number}`, 'ok'); d.close(); load(); }
      });
    };

    $('[data-month]', root).addEventListener('change', load);
    $('[data-cur]', root).addEventListener('change', (e) => { cur = e.target.value; load(); });
    $('[data-refresh]', root).addEventListener('click', load);
    $('[data-csv]', root).addEventListener('click', () => {
      if (!data) return;
      const head = ['Month', 'Owner', 'Sites', 'Chargers', 'Sessions', 'kWh', 'Gross collected', 'PBJT', 'PPN', 'Commission base', 'Owner share', `${opName} share`, 'MDR estimate', 'Statement'];
      const line = (o, name) => [data.period, name, o.sites, o.chargers, o.sessions, o.energyKwh, o.grossMinor, o.localTaxMinor, o.taxMinor, o.baseMinor, o.ownerShareMinor, o.platformShareMinor, o.mdrMinor, o.status ?? ''];
      const lines = [head, ...data.owners.map((o) => line(o, o.name)), line(data.operatorOwn, `${opName} own sites`), line(data.totals, 'TOTAL')];
      download(`plugsure-billing-${data.period}${cur && data.currencies?.length > 1 ? `-${cur}` : ''}.csv`, '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
    });
    await load();
  },
});
