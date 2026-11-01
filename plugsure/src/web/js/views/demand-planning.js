import { $, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options } from '../core.js';

/**
 * (v1.45.0) Assets & energy → Demand & planning: how busy each site is by hour of the week, the forecast for the coming
 * days, where connectors are needed, and candidate places for a new site, scored.
 */

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ADVICE = {
  add_connectors: (a) => tag('t-warn', `add ${a.connectors} connector${a.connectors === 1 ? '' : 's'}`),
  under_used: () => tag('t-info', 'under-used'),
  no_history: () => tag('t-mute', 'no history yet'),
  ok: () => tag('t-ok', 'fine'),
};
const CSTATUS = { idea: ['t-mute', 'idea'], surveyed: ['t-info', 'surveyed'], approved: ['t-ok', 'approved'], rejected: ['t-crit', 'rejected'] };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };

/** An hour-of-week heatmap: 7 rows × 24 columns, the occupancy as the cell's strength. */
function heatmap(cells) {
  const w = 22, h = 18, left = 34, top = 14;
  const max = Math.max(1, ...cells.map((c) => c.occupancyPct));
  const rects = cells.map((c) => {
    const a = c.occupancyPct / max;
    return `<rect x="${left + c.hour * w}" y="${top + c.day * h}" width="${w - 2}" height="${h - 2}" rx="2" fill="var(--accent)" fill-opacity="${(0.06 + a * 0.94).toFixed(2)}"><title>${DAYS[c.day]} ${String(c.hour).padStart(2, '0')}:00 · ${c.occupancyPct}% busy · ${c.sessions} sessions</title></rect>`;
  }).join('');
  const hours = [0, 6, 12, 18, 23].map((x) => `<text x="${left + x * w + 2}" y="10" font-size="10" fill="var(--muted)">${String(x).padStart(2, '0')}</text>`).join('');
  const days = DAYS.map((d, i) => `<text x="0" y="${top + i * h + 12}" font-size="10" fill="var(--muted)">${d}</text>`).join('');
  return `<svg viewBox="0 0 ${left + 24 * w} ${top + 7 * h}" style="width:100%;max-width:640px" role="img" aria-label="Occupancy by hour of the week">${hours}${days}${rects}</svg>`;
}

/** The forecast: occupancy % per coming hour, as bars. */
function forecastChart(rows) {
  const W = 640, H = 120, bw = W / rows.length;
  const bars = rows.map((r, i) => `<rect x="${(i * bw).toFixed(1)}" y="${(H - (r.occupancyPct / 100) * H).toFixed(1)}" width="${Math.max(1, bw - 0.5).toFixed(1)}" height="${((r.occupancyPct / 100) * H).toFixed(1)}" fill="var(--info)"><title>${fmt.time(r.at)} · ${r.occupancyPct}% · ${r.sessions} sessions</title></rect>`).join('');
  const days = rows.map((r, i) => (new Date(r.at).getHours() === 0 ? `<line x1="${(i * bw).toFixed(1)}" x2="${(i * bw).toFixed(1)}" y1="0" y2="${H}" stroke="var(--line)"/>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:120px" role="img" aria-label="Forecast occupancy by hour">${days}${bars}</svg>`;
}

registerView('demand-planning', {
  title: 'Demand & planning',
  icon: 'chart',
  group: 'assets',
  order: 15,
  perm: 'site:read',
  async render(root) {
    const canWrite = state.can('site:write');
    root.innerHTML = pageHead('Demand & planning',
      'How busy each site is by hour of the week over the last 8 weeks, what the coming days look like, where drivers need more connectors, and how places you are considering for a new site compare.',
      canWrite ? `<button class="btn primary" type="button" data-cand>${icon('plus')} Add a candidate site</button>` : '') + '<div data-body class="stack" style="gap:14px"><div class="skeleton" style="height:160px"></div></div>';
    const body = $('[data-body]', root);
    let ov, cands;
    try { [ov, cands] = await Promise.all([api('/v1/demand/sites'), api('/v1/demand/candidates')]); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
    const need = ov.sites.filter((s) => s.advice.kind === 'add_connectors');
    const tot = ov.sites.reduce((a, s) => ({ conn: a.conn + s.connectors, sess: a.sess + s.next7Days.sessions, kwh: a.kwh + s.next7Days.kwh }), { conn: 0, sess: 0, kwh: 0 });
    const avgUtil = ov.sites.length ? ov.sites.reduce((a, s) => a + s.utilisationPct * s.connectors, 0) / Math.max(1, tot.conn) : 0;
    body.innerHTML = `${need.length ? callout('warn', `${need.length} site${need.length === 1 ? ' needs' : 's need'} more connectors: busy 80 % or more for long stretches, or turning drivers away.`) : ''}
      <div class="grid k4">${kpi('Utilisation', `${fmt.num(avgUtil, 1)}%`, 'of connector-hours, 8 weeks')}${kpi('Next 7 days', fmt.num(tot.sess), 'sessions expected')}
        ${kpi('Energy', `${fmt.num(tot.kwh / 1000, 1)} MWh`, 'expected, next 7 days')}${kpi('Need connectors', fmt.num(need.length), `of ${fmt.num(ov.sites.length)} sites`, need.length ? 'warn' : '')}</div>
      <div class="card section"><header><h3>Sites</h3><span class="cell-sub">Advice: enough connectors to bring the busiest hour to 70 %</span></header><div data-sites></div></div>
      <div class="card section"><header><h3>By hour</h3><div class="right">${field('', `<select data-site>${options(ov.sites.map((s) => ({ value: s.siteId, label: s.site })), '', { blank: 'All sites' })}</select>`)}</div></header>
        <div style="padding:12px" data-heat><div class="skeleton" style="height:140px"></div></div></div>
      <div class="card section"><header><h3>Candidate sites</h3><span class="cell-sub">Scored on nearby demand (50 %), the gap to your nearest site (30 %) and how busy the sites within 5 km are (20 %)</span></header><div data-cands></div></div>`;
    table($('[data-sites]', body), { columns: [
      { label: 'Site', render: (s) => `<div class="cell-title">${esc(s.site)}</div><div class="cell-sub">${fmt.num(s.connectors)} connector${s.connectors === 1 ? '' : 's'} · ${fmt.num(s.sessions8Weeks)} sessions in 8 weeks</div>` },
      { label: 'Utilisation', num: true, render: (s) => `${fmt.num(s.utilisationPct, 1)}%` },
      { label: 'Busiest hour', render: (s) => `${fmt.num(s.peakOccupancyPct, 0)}% <span class="cell-sub">${DAYS[s.peakHour.day]} ${String(s.peakHour.hour).padStart(2, '0')}:00</span><div class="cell-sub">${fmt.num(s.busyHoursPerWeek)} h/week at 80 %+</div>` },
      { label: 'Turned away', num: true, render: (s) => fmt.num(s.turnedAway30d) },
      { label: 'Trend', num: true, render: (s) => (s.trend > 1.05 ? `<span style="color:var(--accent)">▲ ${Math.round((s.trend - 1) * 100)}%</span>` : s.trend < 0.95 ? `<span style="color:var(--crit)">▼ ${Math.round((1 - s.trend) * 100)}%</span>` : '<span class="muted">steady</span>') },
      { label: 'Next 7 days', num: true, render: (s) => `${fmt.num(s.next7Days.sessions)}<div class="cell-sub">${fmt.num(s.next7Days.kwh)} kWh</div>` },
      { label: 'Advice', render: (s) => ADVICE[s.advice.kind](s.advice) },
    ], rows: ov.sites, empty: 'No sites.', onRow: (s) => { $('[data-site]', body).value = s.siteId; drawHeat(); } });
    const drawHeat = async () => {
      const box = $('[data-heat]', body), sid = $('[data-site]', body).value;
      try {
        const f = await api(`/v1/demand/forecast?days=7${sid ? `&siteId=${encodeURIComponent(sid)}` : ''}`);
        box.innerHTML = `<div class="cell-sub" style="margin-bottom:6px">Occupancy by hour of the week (darker is busier; hover for the figures)</div>${heatmap(f.heatmap)}
          <div class="cell-sub" style="margin:14px 0 6px">The next 7 days, hour by hour: ${fmt.num(f.totals.sessions)} sessions, ${fmt.num(f.totals.kwh)} kWh expected</div>${forecastChart(f.forecast)}`;
      } catch (e) { box.innerHTML = callout('crit', esc(e.message)); }
    };
    $('[data-site]', body).addEventListener('change', drawHeat);
    drawHeat();
    const candModal = (c) => modal({ title: c ? `Edit ${c.name}` : 'Add a candidate site', body: `<div class="form grid2">${field('Name', `<input name="n" value="${esc(c?.name ?? '')}" placeholder="Mall parking, level B1">`)}
        ${field('Status', `<select name="s">${options(Object.keys(CSTATUS).map((k) => ({ value: k, label: CSTATUS[k][1] })), c?.status ?? 'idea')}</select>`)}
        ${field('Latitude', `<input name="lat" type="number" step="0.000001" value="${c?.lat ?? ''}">`)}${field('Longitude', `<input name="lon" type="number" step="0.000001" value="${c?.lon ?? ''}">`)}
        ${field('Connectors', `<input name="c" type="number" min="1" max="100" value="${c?.connectors ?? 2}">`)}${field('Power each (kW)', `<input name="kw" type="number" min="1" max="1000" value="${c?.powerKw ?? 22}">`)}
        ${field('Notes', `<textarea name="no" rows="3">${esc(c?.notes ?? '')}</textarea>`, { full: true })}</div>`,
      actions: [...(c ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/demand/candidates/${c.id}`, { method: 'PUT', body: { archive: true } }); toast('Archived.', 'ok'); reload(); }) }] : []),
        { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name="${n}"]`, mc.el).value;
          await api(c ? `/v1/demand/candidates/${c.id}` : '/v1/demand/candidates', { method: c ? 'PUT' : 'POST', body: { name: v('n'), status: v('s'), lat: Number(v('lat')), lon: Number(v('lon')), connectors: Number(v('c')), powerKw: Number(v('kw')), notes: v('no') || null } });
          toast('Saved.', 'ok'); reload();
        }) }] });
    const drawCands = () => { $('[data-cands]', body).innerHTML = ''; return table($('[data-cands]', body), { columns: [
      { label: 'Place', render: (c) => `<div class="cell-title">${esc(c.name)}</div><div class="cell-sub mono">${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</div>` },
      { label: 'Score', render: (c) => `<b>${c.score}</b>/100<div class="cell-sub">demand ${c.demandScore} · gap ${c.gapScore} · pressure ${c.pressureScore}</div>` },
      { label: 'Nearest site', num: true, render: (c) => (c.gapKm == null ? '—' : `${fmt.num(c.gapKm, 1)} km`) },
      { label: 'Sessions/day', num: true, render: (c) => `${fmt.num(c.estimatedSessionsPerDay, 1)}<div class="cell-sub">estimate, ${c.connectors} × ${fmt.num(c.powerKw)} kW</div>` },
      { label: 'Status', render: (c) => tag(...CSTATUS[c.status]) },
    ], rows: cands.candidates, empty: 'No candidate sites yet. Add the places you are considering to compare them.', onRow: canWrite ? (c) => candModal(c) : undefined })
      && (cands.candidates.length && !cands.sites ? $('[data-cands]', body).insertAdjacentHTML('afterbegin', callout('info', 'None of your sites has a map position yet (Sites → Edit → location), so nearby demand and the distance to your sites cannot be measured: the scores only count new ground.')) : null); };
    const reload = async () => { try { cands = await api('/v1/demand/candidates'); drawCands(); } catch (e) { toast(e.message, 'crit'); } };
    drawCands();
    $('[data-cand]', root)?.addEventListener('click', () => candModal(null));
  },
});
