import { $, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, sites as loadSites, options } from '../core.js';

/**
 * (v1.43.0) Commercial → Dynamic pricing: rules that move the energy price with the time of day, the grid's peak hours,
 * how busy a site is or how much solar it is producing — inside a floor and a cap, never past the regulated energy
 * ceiling. Each site's price now; a 7-day preview; the effect on the last 30 days.
 */

const KIND = {
  time: 'At these times', peak: 'In the grid\'s peak hours', occupancy: 'When the site is busy', solar: 'When solar is producing',
};
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pct = (p) => (p == null ? '—' : `${p > 100 ? '+' : ''}${fmt.num(p - 100)}%`);
const daysText = (m) => (m === 127 ? 'every day' : m === 31 ? 'weekdays' : m === 96 ? 'weekends' : DAYS.filter((_, i) => m & (1 << i)).join(', '));
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };

registerView('dynamic-pricing', {
  title: 'Dynamic pricing',
  icon: 'tariff',
  group: 'commercial',
  order: 20.5,
  perm: 'tariff:read',
  async render(root) {
    const canWrite = state.can('tariff:write');
    root.innerHTML = pageHead('Dynamic pricing',
      'Move the energy price with the time of day, the grid\'s peak hours, how busy a site is or how much solar it produces. A driver sees the price before starting and it is fixed for the whole charge; a pre-paid charge keeps the price it was paid at. Fees and the PLN formula rate never move, and an increase never passes the regulated energy ceiling.',
      canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} Add a rule</button>` : '') + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    const siteList = (await loadSites()).filter((s) => !s.archived_at);
    let d;
    const draw = async () => {
      try { d = await api('/v1/dynamic-pricing'); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const st = d.settings;
      body.innerHTML = `<div class="card pad"><div class="row" style="gap:14px;flex-wrap:wrap;align-items:center">
          <div class="grow"><b>Dynamic pricing is ${st.enabled ? tag('t-ok', 'on') : tag('t-mute', 'off')}</b>
          <div class="cell-sub">Prices stay between ${fmt.num(st.floorPct)}% and ${fmt.num(st.capPct)}% of the tariff. ${st.includeTime ? 'The per-minute time fee moves too.' : 'Only the energy price moves.'}</div></div>
          ${canWrite ? `<button class="btn" type="button" data-settings>${icon('gear')} Settings</button>` : ''}</div></div>
        ${!st.enabled && d.rules.length ? callout('info', 'The rules below are not applied until dynamic pricing is switched on (Settings).') : ''}
        <div class="card section"><header><h3>Rules</h3><span class="cell-sub">Matching rules add up.</span></header><div data-rules></div></div>
        <div class="card section"><header><h3>Each site now</h3><span class="cell-sub">What a charge starting now is fixed at.</span></header><div data-sites></div></div>`;
      table($('[data-rules]', body), {
        columns: [
          { label: 'Rule', render: (r) => `<div class="cell-title">${esc(r.name)}</div><div class="cell-sub">${esc(r.siteId ? siteList.find((s) => s.id === r.siteId)?.name ?? 'a site' : 'every site')}</div>` },
          { label: 'When', render: (r) => `${esc(KIND[r.kind])}<div class="cell-sub">${esc(r.kind === 'time' ? `${String(r.hourFrom).padStart(2, '0')}:00–${String(r.hourTo).padStart(2, '0')}:00` : r.kind === 'occupancy' ? `≥ ${fmt.num(r.threshold)}% of connectors in use` : r.kind === 'solar' ? `≥ ${fmt.num(r.threshold, 1)} kW of solar` : 'the site\'s energy tariff')} · ${esc(daysText(r.dayMask))}</div>` },
          { label: 'Price', num: true, render: (r) => tag(r.adjustPct > 0 ? 't-warn' : 't-ok', `${r.adjustPct > 0 ? '+' : ''}${r.adjustPct}%`) },
          { label: '', render: (r) => (r.enabled ? '' : tag('t-mute', 'off')) },
          { label: '', render: (r) => (canWrite ? `<button class="btn sm" type="button" data-edit="${esc(r.id)}">Edit</button>` : '') },
        ],
        rows: d.rules, empty: 'No rules yet: every site charges its tariff.',
      });
      table($('[data-sites]', body), {
        columns: [
          { label: 'Site', render: (s) => `<b>${esc(s.name)}</b>` },
          { label: 'Price now', num: true, render: (s) => (s.factorPct == null ? '<span class="muted">tariff</span>' : s.factorPct === 100 ? 'standard' : tag(s.factorPct > 100 ? 't-warn' : 't-ok', pct(s.factorPct))) },
          { label: 'Why', render: (s) => `<span class="cell-sub">${esc(s.reason ?? '—')}</span>` },
          { label: '', render: (s) => `<button class="btn sm" type="button" data-preview="${esc(s.id)}">${icon('chart')} Preview</button>` },
        ],
        rows: d.sites, empty: 'No sites.',
      });
    };
    const ruleForm = (r = null) => {
      modal({
        title: r ? `Edit ${r.name}` : 'Add a rule', size: 'lg',
        body: `<div class="form">
          ${field('Name', `<input name="name" value="${esc(r?.name ?? '')}" placeholder="Evening peak">`)}
          ${field('Site', `<select name="siteId">${options(siteList.map((s) => ({ value: s.id, label: s.name })), r?.siteId ?? '', { blank: 'Every site' })}</select>`)}
          ${field('When', `<select name="kind">${Object.entries(KIND).map(([k, l]) => `<option value="${k}"${(r?.kind ?? 'time') === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`)}
          ${field('Price change (%)', `<input name="adjustPct" type="number" min="-50" max="50" step="1" value="${esc(r?.adjustPct ?? 10)}">`, { help: 'For example 20 for 20% more, −15 for 15% less.' })}
          <div data-k="time" class="full row" style="gap:8px;align-items:flex-start">${field('From hour', `<input name="hourFrom" type="number" min="0" max="23" value="${esc(r?.hourFrom ?? 17)}">`)}${field('To hour', `<input name="hourTo" type="number" min="1" max="24" value="${esc(r?.hourTo ?? 22)}">`, { help: '22 to 6 runs overnight; the site\'s own time zone.' })}</div>
          <div data-k="occupancy solar">${field('Threshold', `<input name="threshold" type="number" step="0.1" min="0" value="${esc(r?.threshold ?? '')}">`, { help: '<span data-th></span>' })}</div>
          <div class="field full"><label>Days</label><div class="row" style="gap:10px;flex-wrap:wrap">${DAYS.map((dname, i) => `<label class="row" style="gap:4px"><input type="checkbox" name="d${i}"${((r?.dayMask ?? 127) & (1 << i)) ? ' checked' : ''}> ${dname}</label>`).join('')}</div></div>
          <label class="row full" style="gap:8px"><input type="checkbox" name="enabled"${r?.enabled === false ? '' : ' checked'}> The rule is on</label>
        </div>`,
        onMount(mc) {
          const sync = () => {
            const k = $('[name=kind]', mc.el).value;
            mc.el.querySelectorAll('[data-k]').forEach((x) => { x.hidden = !x.dataset.k.split(' ').includes(k); });
            const th = $('[data-th]', mc.el);
            if (th) th.textContent = k === 'occupancy' ? '% of the site\'s connectors in use (e.g. 75).' : 'kW of solar output, from a fresh reading (Solar & battery).';
          };
          $('[name=kind]', mc.el).addEventListener('change', sync);
          sync();
        },
        actions: [
          ...(r ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/dynamic-pricing/rules/${r.id}`, { method: 'PUT', body: { archive: true } }); toast('Archived.', 'ok'); draw(); }) }] : []),
          { label: 'Cancel' },
          { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
            const v = (n) => $(`[name=${n}]`, mc.el).value;
            const kind = v('kind');
            const b = { name: v('name'), siteId: v('siteId') || null, kind, adjustPct: Number(v('adjustPct')), enabled: $('[name=enabled]', mc.el).checked,
              dayMask: DAYS.reduce((m, _, i) => m | ($(`[name=d${i}]`, mc.el).checked ? 1 << i : 0), 0) };
            if (kind === 'time') { b.hourFrom = Number(v('hourFrom')); b.hourTo = Number(v('hourTo')); }
            if (kind === 'occupancy' || kind === 'solar') b.threshold = Number(v('threshold'));
            await api(r ? `/v1/dynamic-pricing/rules/${r.id}` : '/v1/dynamic-pricing/rules', { method: r ? 'PUT' : 'POST', body: b });
            toast('Saved.', 'ok'); draw();
          }) },
        ],
      });
    };
    const settings = () => {
      const st = d.settings;
      modal({
        title: 'Dynamic pricing settings',
        body: `<div class="form">
          <label class="row full" style="gap:8px"><input type="checkbox" name="enabled"${st.enabled ? ' checked' : ''}> <b>Dynamic pricing is on</b></label>
          ${field('Floor (% of the tariff)', `<input name="floorPct" type="number" min="50" max="100" value="${esc(st.floorPct)}">`)}
          ${field('Cap (% of the tariff)', `<input name="capPct" type="number" min="100" max="200" value="${esc(st.capPct)}">`, { help: 'An increase is also held at the regulated energy ceiling.' })}
          <label class="row full" style="gap:8px"><input type="checkbox" name="includeTime"${st.includeTime ? ' checked' : ''}> The per-minute time fee moves too</label>
        </div>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name=${n}]`, mc.el);
          await api('/v1/dynamic-pricing/settings', { method: 'PUT', body: { enabled: v('enabled').checked, floorPct: Number(v('floorPct').value), capPct: Number(v('capPct').value), includeTime: v('includeTime').checked } });
          toast('Saved.', 'ok'); draw();
        }) }],
      });
    };
    const preview = async (siteId) => {
      let p;
      try { p = await api(`/v1/dynamic-pricing/sites/${siteId}/preview`); } catch (e) { toast(e.message, 'crit'); return; }
      // 7 days × 24 hours, in the site's time zone, coloured by the factor.
      const grid = Array.from({ length: 7 }, () => Array(24).fill(null));
      for (const h of p.hours) if (grid[h.dow][h.hour] == null) grid[h.dow][h.hour] = h.factorPct;
      const col = (f) => (f == null ? 'var(--line)' : f > 100 ? `color-mix(in srgb, var(--warn) ${Math.min(100, 25 + (f - 100) * 2.5)}%, transparent)` : f < 100 ? `color-mix(in srgb, var(--accent) ${Math.min(100, 25 + (100 - f) * 2.5)}%, transparent)` : 'var(--panel-2)');
      const s = p.sample;
      modal({
        title: `${p.site.name}: dynamic price preview`, size: 'lg',
        body: `<p>Now: <b>${p.now.factorPct === 100 ? 'standard price' : pct(p.now.factorPct)}</b> <span class="cell-sub">${esc(p.now.reason)}</span></p>
          ${s ? `<p>A 10 kWh charge now: ${fmt.money(s.baseMinorPerKwh, s.currency)}/kWh at the tariff, <b>${fmt.money(s.dynamicMinorPerKwh, s.currency)}/kWh</b> with dynamic pricing${s.heldByCeiling ? ` ${tag('t-info', 'held at the regulated ceiling')}` : ''}.</p>` : ''}
          <div style="overflow-x:auto"><table class="t" style="font-size:11px"><thead><tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th style="padding:2px;text-align:center">${h}</th>`).join('')}</tr></thead>
          <tbody>${grid.map((row, i) => `<tr><th style="padding:2px 6px">${DAYS[i]}</th>${row.map((f, h) => `<td title="${DAYS[i]} ${h}:00 — ${f == null ? '' : pct(f)}" style="padding:0;height:18px;min-width:16px;background:${col(f)}"></td>`).join('')}</tr>`).join('')}</tbody></table></div>
          <p class="cell-sub">Time and peak-hour rules, the next 7 days in ${esc(p.site.timezone)}. Orange: dearer; green: cheaper.${p.conditional.length ? ` Also: ${p.conditional.map((c) => `${esc(c.name)} (${c.adjustPct > 0 ? '+' : ''}${c.adjustPct}% ${c.kind === 'occupancy' ? `when ≥ ${fmt.num(c.threshold)}% busy` : `when ≥ ${fmt.num(c.threshold, 1)} kW solar`})`).join(', ')}.` : ''}</p>
          <p>The last 30 days: ${fmt.num(p.last30Days.sessions)} sessions, ${fmt.num(p.last30Days.kwh, 1)} kWh. Under these rules, energy revenue would have been <b>${p.last30Days.energyRevenueChangePct == null ? '—' : `${p.last30Days.energyRevenueChangePct > 0 ? '+' : ''}${fmt.num(p.last30Days.energyRevenueChangePct, 1)}%`}</b> <span class="cell-sub">(${esc(p.last30Days.note)}; drivers may also change when they charge).</span></p>`,
        actions: [{ label: 'Close' }],
      });
    };
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.matches('[data-add]')) ruleForm();
      else if (b.matches('[data-settings]')) settings();
      else if (b.dataset.edit) ruleForm(d.rules.find((r) => r.id === b.dataset.edit));
      else if (b.dataset.preview) preview(b.dataset.preview);
    });
    await draw();
  },
});
