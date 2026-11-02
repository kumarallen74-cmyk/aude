import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options } from '../core.js';

/**
 * (v1.47.0) Assets & energy → Energy prices: day-ahead or time-of-use prices per zone (imported, or fetched every hour
 * from an address), today's curve with its expensive periods, the sites that shift charging to cheap hours (the load
 * manager gives them only part of their grid budget when it is expensive), and what that saved this month.
 */

const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const hhmm = (iso, timeZone) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone });

/** The day's prices as bars; the expensive ones stand out. */
function curve(d) {
  if (!d.periods.length) return '<p class="cell-sub" style="padding:0 16px 14px">No prices for this day yet.</p>';
  const max = d.max || 1;
  return `<div style="display:flex;align-items:flex-end;gap:2px;height:140px;padding:8px 16px 0" role="img" aria-label="Prices for ${esc(d.date)}">
    ${d.periods.map((p) => `<div title="${esc(hhmm(p.startsAt, d.timeZone))}: ${fmt.num(p.priceMinor, 2)} ${esc(d.currency)}/kWh${p.expensive ? ' (expensive)' : ''}"
      style="flex:1;min-width:2px;height:${Math.max(3, Math.round((p.priceMinor / max) * 100))}%;border-radius:2px 2px 0 0;background:${p.expensive ? 'var(--crit, #b42318)' : 'var(--accent, #0c7856)'};opacity:${p.expensive ? 0.9 : 0.6}"></div>`).join('')}</div>
    <div style="display:flex;justify-content:space-between;padding:4px 16px 12px" class="cell-sub"><span>${esc(hhmm(d.periods[0].startsAt, d.timeZone))}</span>
      <span>min ${fmt.num(d.min, 2)} · avg ${fmt.num(d.avg, 2)} · max ${fmt.num(d.max, 2)} ${esc(d.currency)}/kWh</span><span>${esc(hhmm(d.periods[d.periods.length - 1].startsAt, d.timeZone))}</span></div>`;
}

registerView('energy-prices', {
  title: 'Energy prices',
  icon: 'bolt',
  group: 'assets',
  order: 18,
  perm: 'smartcharging:read',
  async render(root) {
    const canWrite = state.can('smartcharging:write');
    root.innerHTML = pageHead('Energy prices',
      'Market or time-of-use prices per zone. Sites that shift to cheap hours get only part of their grid budget when energy is expensive; cars with a departure still get what they need.',
      canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} Add a price zone</button>` : '') + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    let zones = [], sites = [], zoneId = null, month = new Date().toISOString().slice(0, 7);

    const zoneModal = (z) => modal({ title: z ? `Edit ${z.name}` : 'Add a price zone', size: 'lg',
      body: `<div class="form grid2">${field('Name', `<input name="name" maxlength="80" value="${esc(z?.name ?? '')}" placeholder="Day-ahead market">`)}
        ${field('Currency', `<input name="cur" maxlength="3" value="${esc(z?.currency ?? '')}" placeholder="ISO code">`)}
        ${field('Prices come', `<select name="src">${options([{ value: 'manual', label: 'Imported here' }, { value: 'url', label: 'Fetched every hour from an address' }], z?.source ?? 'manual')}</select>`)}
        ${field('Address', `<input name="url" maxlength="500" value="${esc(z?.url ?? '')}" placeholder="https://…">`, { help: 'JSON: a list of {start, price} (or {prices: […]}), or CSV "start,price".' })}
        ${field('Authorization header', `<input name="auth" maxlength="2000" placeholder="${z?.hasAuth ? 'Kept (type to replace)' : 'Optional'}">`)}</div>`,
      actions: [...(z ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/energy-prices/zones/${z.id}`, { method: 'PUT', body: { archive: true } }); zoneId = null; draw(); }) }] : []),
        { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
          const r = await api(z ? `/v1/energy-prices/zones/${z.id}` : '/v1/energy-prices/zones', { method: z ? 'PUT' : 'POST', body: { name: v('name'), currency: v('cur').toUpperCase(), source: v('src'), url: v('url') || null, ...(v('auth') ? { authorization: v('auth') } : {}) } });
          zoneId = r.id; toast('Saved.', 'ok'); draw();
        }) }] });

    const importModal = (z) => modal({ title: `Import prices · ${z.name}`, size: 'lg',
      body: `<div class="form">${field('Prices (CSV or JSON)', '<textarea name="csv" rows="10" placeholder="start,price&#10;2026-11-03T00:00:00+07:00,820&#10;2026-11-03T01:00:00+07:00,790"></textarea>', { help: `Per kWh in minor units of ${esc(z.currency)}; a period already held is replaced.` })}
        <input type="file" accept=".csv,.json,text/csv,application/json,text/plain" data-file></div>`,
      onMount: (mc) => $('[data-file]', mc.el).addEventListener('change', async (e) => { const f = e.target.files?.[0]; if (f) $('[name="csv"]', mc.el).value = await f.text(); }),
      actions: [{ label: 'Cancel' }, { label: 'Import', kind: 'primary', onClick: guard(async (mc) => {
        const r = await api(`/v1/energy-prices/zones/${z.id}/prices`, { method: 'POST', body: { csv: $('[name="csv"]', mc.el).value } });
        toast(`${r.stored} periods stored${r.skipped ? `, ${r.skipped} lines skipped` : ''}.`, 'ok'); draw();
      }) }] });

    const siteModal = (s) => modal({ title: `Energy prices · ${s.name}`,
      body: `<div class="form">${field('Price zone', `<select name="zone">${options(zones.map((z) => ({ value: z.id, label: z.name })), s.zoneId ?? '', { blank: 'None' })}</select>`)}
        ${field('', `<label><input type="checkbox" name="shift" ${s.shift ? 'checked' : ''}> Shift charging to cheap hours</label>`)}
        ${field('Grid budget in expensive periods (%)', `<input name="pct" type="number" min="0" max="100" step="5" value="${s.capPct}">`)}
        ${field('Expensive at or above (minor units per kWh)', `<input name="th" type="number" min="0" step="0.01" value="${s.thresholdMinor ?? ''}">`, { help: 'Empty: the day\'s most expensive quarter of periods.' })}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
        const v = (n) => $(`[name="${n}"]`, mc.el).value;
        await api(`/v1/sites/${s.siteId}/energy-prices`, { method: 'PUT', body: { zoneId: v('zone') || null, shift: $('[name="shift"]', mc.el).checked, capPct: Number(v('pct')), thresholdMinor: v('th') === '' ? null : Number(v('th')) } });
        toast('Saved.', 'ok'); draw();
      }) }] });

    const draw = async () => {
      let sv;
      try { [{ zones, sites }, sv] = await Promise.all([api('/v1/energy-prices/zones'), api(`/v1/energy-prices/savings?month=${month}`)]); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      if (!zones.some((z) => z.id === zoneId)) zoneId = zones[0]?.id ?? null;
      const z = zones.find((x) => x.id === zoneId);
      const day = z ? await api(`/v1/energy-prices/zones/${z.id}/day`).catch(() => null) : null;
      const saved = sv.sites.reduce((a, s) => a + (s.savingsMinor ?? 0), 0);
      body.innerHTML = `${zones.some((x) => x.lastError) ? callout('warn', `Fetching failed: ${zones.filter((x) => x.lastError).map((x) => `${esc(x.name)} (${esc(x.lastError)})`).join('; ')}`) : ''}
        <div class="grid k4">${kpi('Zones', fmt.num(zones.length))}${kpi('Sites shifting', fmt.num(sites.filter((s) => s.shift).length), `of ${fmt.num(sites.length)}`)}
          ${kpi('Now', day?.periods?.length ? (() => { const n = day.periods.filter((p) => new Date(p.startsAt) <= new Date()).pop(); return n ? `${fmt.num(n.priceMinor, 2)}${n.expensive ? ` ${tag('t-crit', 'expensive')}` : ''}` : '—'; })() : '—', z ? `${esc(z.currency)}/kWh · ${esc(z.name)}` : '')}
          ${kpi('Saved this month', sv.sites.length ? fmt.money(saved, sv.sites[0].currency) : '—', 'against the month\'s average price')}</div>
        <div class="card section"><header><h3>Today</h3>${zones.length > 1 ? `<select class="right" data-z style="width:auto">${options(zones.map((x) => ({ value: x.id, label: x.name })), zoneId ?? '')}</select>` : z ? `<span class="cell-sub">${esc(z.name)}</span>` : ''}</header>
          ${day ? curve(day) : '<p class="cell-sub" style="padding:0 16px 14px">Add a price zone to see its prices.</p>'}</div>
        <div class="card section"><header><h3>Price zones</h3></header><div data-zs></div></div>
        <div class="card section"><header><h3>Sites</h3></header><div data-s></div></div>
        <div class="card section"><header><h3>Savings</h3><input class="right" type="month" data-m value="${month}" style="width:auto"></header><div data-sv></div></div>`;
      table($('[data-zs]', body), { columns: [{ label: 'Zone', render: (x) => `<b>${esc(x.name)}</b><div class="cell-sub">${x.source === 'url' ? 'fetched hourly' : 'imported'}</div>` },
        { label: 'Periods', num: true, render: (x) => fmt.num(x.periods) }, { label: 'Until', render: (x) => (x.lastPeriod ? esc(fmt.time(x.lastPeriod)) : '—') },
        { label: 'Last fetch', render: (x) => (x.source === 'url' ? `${x.lastFetchAt ? esc(fmt.time(x.lastFetchAt)) : '—'}${x.lastError ? ` ${tag('t-crit', 'failed', x.lastError)}` : ''}` : '—') },
        { label: 'Sites', num: true, render: (x) => fmt.num(x.sites) },
        ...(canWrite ? [{ label: '', render: (x) => `<button class="btn sm" data-imp="${x.id}">${icon('upload')} Import</button>${x.source === 'url' ? ` <button class="btn sm" data-fetch="${x.id}">Fetch now</button>` : ''} <button class="btn sm" data-edit="${x.id}">Edit</button>` }] : [])],
      rows: zones, empty: 'No price zones yet.' });
      table($('[data-s]', body), { columns: [{ label: 'Site', key: 'name' }, { label: 'Zone', render: (s) => esc(zones.find((x) => x.id === s.zoneId)?.name ?? '—') },
        { label: 'Shifting', render: (s) => (s.shift ? tag('t-ok', `on · ${s.capPct}% when expensive`) : tag('t-mute', 'off')) },
        { label: 'Expensive', render: (s) => (s.thresholdMinor != null ? `≥ ${fmt.num(s.thresholdMinor, 2)}` : 'the day\'s top quarter') }],
      rows: sites, empty: 'No sites.', onRow: canWrite ? (s) => siteModal(s) : undefined });
      table($('[data-sv]', body), { columns: [{ label: 'Site', key: 'site' }, { label: 'Shifting', render: (s) => (s.shift ? 'on' : 'off') },
        { label: 'kWh priced', num: true, render: (s) => fmt.num(s.pricedKwh, 1) }, { label: 'Paid on average', num: true, render: (s) => (s.paidAvgMinor == null ? '—' : fmt.num(s.paidAvgMinor, 2)) },
        { label: 'Month\'s average', num: true, render: (s) => (s.avgPriceMinor == null ? '—' : fmt.num(s.avgPriceMinor, 2)) }, { label: 'Energy cost', num: true, render: (s) => fmt.money(s.costMinor, s.currency) },
        { label: 'Saved', num: true, render: (s) => (s.savingsMinor == null ? '—' : `<b>${fmt.money(s.savingsMinor, s.currency)}</b>`) }],
      rows: sv.sites, empty: 'No site is on a price zone.' });
      const zById = (id) => zones.find((x) => x.id === id);
      $$('[data-imp]', body).forEach((b) => b.addEventListener('click', () => importModal(zById(b.dataset.imp))));
      $$('[data-edit]', body).forEach((b) => b.addEventListener('click', () => zoneModal(zById(b.dataset.edit))));
      $$('[data-fetch]', body).forEach((b) => b.addEventListener('click', async () => { try { const r = await api(`/v1/energy-prices/zones/${b.dataset.fetch}/fetch`, { method: 'POST' }); toast(`${r.stored} periods stored.`, 'ok'); draw(); } catch (e) { toast(e.message, 'crit'); } }));
      $('[data-z]', body)?.addEventListener('change', (e) => { zoneId = e.target.value; draw(); });
      $('[data-m]', body).addEventListener('change', (e) => { month = e.target.value || month; draw(); });
    };

    $('[data-add]', root)?.addEventListener('click', () => zoneModal(null));
    await draw();
  },
});
