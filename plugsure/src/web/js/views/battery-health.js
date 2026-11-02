import { $, esc, api, registerView, pageHead, table, tag, fmt, modal, toast, callout, kpi } from '../core.js';

/**
 * (v1.48.0) Assets & energy → Battery health: each fleet vehicle's estimated usable capacity and state of health from
 * its own charging (the state of charge gained against the energy delivered), the degradation per year, and sessions
 * flagged for a capacity drop or unusually slow charging.
 */

const FLAG = { capacity_drop: ['t-crit', 'capacity drop'], slow_charging: ['t-warn', 'slow charging'], low_health: ['t-crit', 'low health'], implausible: ['t-mute', 'not used'] };
const soh = (v) => (v == null ? '—' : `<b style="color:${v < 75 ? 'var(--crit, #b42318)' : v < 85 ? 'var(--warn, #b26a00)' : 'inherit'}">${fmt.num(v, 1)}%</b>`);

registerView('battery-health', {
  title: 'Battery health',
  icon: 'bolt',
  group: 'assets',
  order: 20,
  perm: 'smartcharging:read',
  async render(root) {
    root.innerHTML = pageHead('Battery health', 'For fleet vehicles: the usable capacity each charge shows (energy delivered against the charge gained), the state of health and its trend, and charges that look wrong.')
      + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    let d;
    try { d = await api('/v1/battery-health'); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
    const noCard = d.vehicles.filter((v) => !v.hasCard).length;
    const noSize = d.vehicles.filter((v) => v.batteryKwh == null).length;
    body.innerHTML = `${noCard || noSize ? callout('info', `${noCard ? `${noCard} vehicle${noCard === 1 ? ' has' : 's have'} no charging card, so their charges cannot be matched. ` : ''}${noSize ? `${noSize} ${noSize === 1 ? 'has' : 'have'} no battery size, so there is no state of health. ` : ''}Set them in Depot charging.`) : ''}
      <div class="grid k4">${kpi('Vehicles measured', fmt.num(d.fleet.measured), `of ${fmt.num(d.fleet.vehicles)}`)}${kpi('Median health', d.fleet.medianSohPct == null ? '—' : `${fmt.num(d.fleet.medianSohPct, 1)}%`)}
        ${kpi('Below 80 %', fmt.num(d.fleet.below80), '', d.fleet.below80 ? 'warn' : '')}${kpi('Flagged (90 days)', fmt.num(d.fleet.flagged), 'vehicles', d.fleet.flagged ? 'warn' : '')}</div>
      <div class="card section"><header><h3>Vehicles</h3><span class="cell-sub">Estimates from charging, not the car's own battery system</span></header><div data-v></div></div>`;
    table($('[data-v]', body), { columns: [{ label: 'Vehicle', render: (v) => `<b>${esc(v.name)}</b>${v.plate ? `<div class="cell-sub">${esc(v.plate)}</div>` : ''}` },
      { label: 'Battery', num: true, render: (v) => (v.batteryKwh == null ? '—' : `${fmt.num(v.batteryKwh, 1)} kWh`) }, { label: 'Usable now', num: true, render: (v) => (v.capacityKwh == null ? '—' : `${fmt.num(v.capacityKwh, 1)} kWh`) },
      { label: 'Health', num: true, render: (v) => soh(v.sohPct) }, { label: 'Per year', num: true, render: (v) => (v.degradationPctPerYear == null ? '—' : `${v.degradationPctPerYear > 0 ? '+' : ''}${fmt.num(v.degradationPctPerYear, 1)}%`) },
      { label: 'Estimates', num: true, render: (v) => `${fmt.num(v.estimates)}<div class="cell-sub">of ${fmt.num(v.sessions)} charges</div>` },
      { label: 'Latest', render: (v) => `${v.flags.map((f) => tag(...(FLAG[f] ?? ['t-mute', f]))).join(' ')}${v.lastAt ? `<div class="cell-sub">${esc(fmt.time(v.lastAt))}</div>` : '<span class="cell-sub">no charges yet</span>'}` }],
    rows: d.vehicles, empty: 'No fleet vehicles. Add them in Depot charging.', onRow: async (v) => {
      let x;
      try { x = await api(`/v1/battery-health/${v.id}`); } catch (e) { toast(e.message, 'crit'); return; }
      const max = Math.max(1, ...x.monthly.map((m) => m.capacityKwh), x.batteryKwh ?? 0);
      modal({ title: `${x.name} · battery health`, size: 'lg', body: `
        ${x.monthly.length ? `<div style="display:flex;align-items:flex-end;gap:6px;height:120px;margin-bottom:4px" role="img" aria-label="Monthly capacity">${x.monthly.map((m) => `<div title="${esc(m.month)}: ${fmt.num(m.capacityKwh, 1)} kWh (${m.estimates})"
          style="flex:1;height:${Math.round((m.capacityKwh / max) * 100)}%;background:var(--accent, #0c7856);opacity:.7;border-radius:3px 3px 0 0"></div>`).join('')}</div>
          <div style="display:flex;gap:6px" class="cell-sub">${x.monthly.map((m) => `<span style="flex:1;text-align:center">${esc(m.month.slice(2))}</span>`).join('')}</div>` : '<p class="cell-sub">No capacity estimates yet: charges need to gain at least 20 points of charge, with the state of charge reported.</p>'}
        <div data-s style="margin-top:12px"></div>`,
      onMount: (mc) => table($('[data-s]', mc.el), { columns: [{ label: 'When', render: (s) => esc(fmt.time(s.at)) }, { label: 'Where', render: (s) => esc(s.site ?? '—') },
        { label: 'Charge', render: (s) => (s.socStart == null || s.socEnd == null ? '—' : `${fmt.num(s.socStart)} → ${fmt.num(s.socEnd)}%<div class="cell-sub">${esc(s.socSource ?? '')}</div>`) },
        { label: 'kWh', num: true, render: (s) => fmt.num(s.kwh, 1) }, { label: 'Capacity', num: true, render: (s) => (s.capacityKwh == null ? '—' : fmt.num(s.capacityKwh, 1)) },
        { label: 'Peak', num: true, render: (s) => (s.peakKw == null ? '—' : `${fmt.num(s.peakKw, 0)} kW`) }, { label: '', render: (s) => s.flags.map((f) => tag(...(FLAG[f] ?? ['t-mute', f]))).join(' ') }],
      rows: x.sessions, empty: 'No charges yet.' }) });
    } });
  },
});
