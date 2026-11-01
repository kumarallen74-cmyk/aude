import { $, esc, api, state, registerView, pageHead, table, tag, icon, fmt, toast, callout, kpi, field, drawer, sites as loadSites, options } from '../core.js';

/**
 * (v1.42.0) Maintenance → Charger health: each charger's score over 30 days (outages, faults, reboots, failed starts, a
 * fault now), the risk with its reasons — the chargers likely to fail first — the trend, and a work order from it.
 */

const RISK = { at_risk: ['t-crit', 'at risk'], watch: ['t-warn', 'watch'], ok: ['t-ok', 'ok'] };
const bar = (score) => `<span style="display:inline-block;width:64px;height:8px;border-radius:4px;background:var(--line);vertical-align:middle;overflow:hidden">
  <span style="display:block;height:100%;width:${score}%;background:${score < 60 ? 'var(--crit)' : score < 80 ? 'var(--warn)' : 'var(--accent)'}"></span></span>`;
const trend = (now, then) => (then == null ? '' : now > then ? `<span style="color:var(--accent)">▲ ${now - then}</span>` : now < then ? `<span style="color:var(--crit)">▼ ${then - now}</span>` : '<span class="muted">=</span>');

const VERDICT = { healthy: ['t-ok', 'healthy'], fixed: ['t-ok', 'fixed'], needs_attention: ['t-warn', 'needs attention'], needs_visit: ['t-crit', 'needs a visit'], unreachable: ['t-crit', 'unreachable'] };
const SEV = { info: 't-info', warning: 't-warn', critical: 't-crit' };

/** (v1.44.0) The diagnostics bot: reads the charger's errors, asks it for a fresh status and its configuration, tries a soft reset when allowed, and says what to do. */
async function diagTab(host, cpId) {
  const canRun = state.can('charge_point:command');
  const canOrder = state.can('charge_point:write') || state.can('payment:write');
  const runHtml = (r) => `<div class="card" style="padding:12px">
      <div class="row" style="gap:8px;flex-wrap:wrap">${r.status === 'running' ? tag('t-info', 'running…') : r.status === 'failed' ? tag('t-crit', 'failed') : tag(...(VERDICT[r.verdict] ?? ['t-mute', r.verdict ?? '—']))}
        <span class="cell-sub">${esc(fmt.time(r.startedAt))}${r.allowReset ? ' · soft reset allowed' : ''}</span>
        ${r.workOrder ? tag('t-info', `work order ${r.workOrder}`) : r.status === 'done' && canOrder && ['needs_visit', 'needs_attention', 'unreachable'].includes(r.verdict) ? `<button class="btn sm right" type="button" data-dwo="${esc(r.id)}">Open work order</button>` : ''}</div>
      ${r.summary ? `<p style="margin:8px 0">${esc(r.summary.split('\n')[0])}</p>` : ''}
      ${r.findings.length ? `<ul style="margin:4px 0 8px;padding-left:18px">${r.findings.map((f) => `<li>${tag(SEV[f.severity] ?? 't-mute', f.severity)} ${esc(f.text)}</li>`).join('')}</ul>` : ''}
      <details><summary class="cell-sub">Steps (${r.steps.length})</summary><ol style="margin:6px 0;padding-left:18px">${r.steps.map((s) => `<li>${s.ok ? '✓' : '✗'} <b>${esc(s.step)}</b> <span class="cell-sub">${esc(s.detail ?? '')}</span></li>`).join('')}</ol></details></div>`;
  host.innerHTML = `<div class="stack" style="gap:12px">
      <p class="cell-sub">The bot reads 7 days of the charger's errors and its connection, asks it for a fresh status and reads its key configuration, then says what is wrong and whether someone has to go. It never changes the configuration and never does a hard reset.</p>
      ${canRun ? `<div class="row" style="gap:12px;flex-wrap:wrap"><label class="row" style="gap:6px"><input type="checkbox" data-reset> Allow a soft reset if a connector is faulted and nothing is charging</label>
        <label class="row" style="gap:6px"><input type="checkbox" data-order> Open a work order if someone has to act</label>
        <button class="btn primary sm" type="button" data-drun>${icon('play')} Run diagnostics</button></div>` : ''}
      <div data-runs class="stack" style="gap:10px"><div class="skeleton" style="height:60px"></div></div></div>`;
  const el = host.firstElementChild; // replaced when the tab changes, so polling and listeners stop with it
  let timer = null;
  const load = async () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    let runs;
    try { runs = (await api(`/v1/diagnostics-bot/charge-points/${cpId}`)).runs; } catch (e) { $('[data-runs]', el).innerHTML = callout('crit', esc(e.message)); return; }
    if (!el.isConnected) return;
    $('[data-runs]', el).innerHTML = runs.length ? runs.map(runHtml).join('') : '<p class="cell-sub">No runs yet.</p>';
    const running = runs.some((r) => r.status === 'running');
    const btn = $('[data-drun]', el);
    if (btn) btn.disabled = running;
    if (running) timer = setTimeout(load, 3000);
  };
  $('[data-drun]', el)?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await api(`/v1/diagnostics-bot/charge-points/${cpId}`, { method: 'POST', body: { allowReset: $('[data-reset]', el).checked, openWorkOrder: $('[data-order]', el).checked } }); toast('Diagnostics started.', 'ok'); } catch (err) { toast(err.message, 'crit'); }
    load();
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-dwo]');
    if (!b) return;
    b.disabled = true;
    try { const w = await api(`/v1/diagnostics-bot/runs/${b.dataset.dwo}/work-order`, { method: 'POST' }); toast(`Work order ${w.number} opened.`, 'ok'); load(); } catch (err) { toast(err.message, 'crit'); b.disabled = false; }
  });
  await load();
}

registerView('charger-health', {
  title: 'Charger health',
  icon: 'shield',
  group: 'maintain',
  order: 29,
  perm: 'charge_point:read',
  async render(root) {
    const canRun = state.can('charge_point:write');
    const canOrder = state.can('charge_point:write') || state.can('payment:write');
    root.innerHTML = pageHead('Charger health',
      'Each charger scored over the last 30 days from its outages, faults, reboots and failed starts. "At risk" means likely to fail: a fault code recurring, faults speeding up, a fault now, or a low score.',
      canRun ? `<button class="btn" type="button" data-run>${icon('refresh')} Score now</button>` : '') + `<div class="grid k4" data-kpis></div>
      <div class="filters">${field('Risk', '<select data-risk><option value="">All</option><option value="at_risk">At risk</option><option value="watch">Watch</option><option value="ok">OK</option></select>')}
        ${field('Site', `<select data-site>${options((await loadSites()).filter((s) => !s.archived_at).map((s) => ({ value: s.id, label: s.name })), '', { blank: 'All sites' })}</select>`)}</div>
      <div class="card section" data-list></div>`;
    const draw = async () => {
      const q = new URLSearchParams();
      if ($('[data-risk]', root).value) q.set('risk', $('[data-risk]', root).value);
      if ($('[data-site]', root).value) q.set('siteId', $('[data-site]', root).value);
      let d;
      try { d = await api(`/v1/charger-health${q.size ? `?${q}` : ''}`); } catch (e) { $('[data-list]', root).innerHTML = callout('crit', esc(e.message)); return; }
      const s = d.summary;
      $('[data-kpis]', root).innerHTML = kpi('At risk', fmt.num(s.atRisk), 'likely to fail', s.atRisk ? 'crit' : '') + kpi('Watch', fmt.num(s.watch), 'worth a look', s.watch ? 'warn' : '')
        + kpi('OK', fmt.num(s.ok), `of ${fmt.num(s.chargers)} chargers`) + kpi('Average score', s.averageScore == null ? '—' : `${s.averageScore}/100`, `${d.windowDays} days`);
      table($('[data-list]', root), {
        columns: [
          { label: 'Charger', render: (c) => `<div class="cell-title">${esc(c.name ?? c.identity)}</div><div class="cell-sub">${esc(c.siteName)}${c.name ? ` · <span class="mono">${esc(c.identity)}</span>` : ''}</div>` },
          { label: 'Score', render: (c) => `${bar(c.score)} <b>${c.score}</b><div class="cell-sub">7 days ${trend(c.score, c.trend.d7)} · 30 days ${trend(c.score, c.trend.d30)}</div>` },
          { label: 'Risk', render: (c) => tag(...RISK[c.risk]) },
          { label: 'Why', render: (c) => (c.reasons.length ? c.reasons.slice(0, 2).map((r) => `<div class="cell-sub">${esc(r)}</div>`).join('') + (c.reasons.length > 2 ? `<div class="cell-sub muted">+${c.reasons.length - 2} more</div>` : '') : '<span class="muted">—</span>') },
          { label: 'Work orders', render: (c) => (c.workOrders.length ? c.workOrders.map((w) => `${tag('t-info', w.number)} <span class="cell-sub">${esc(w.status.replace('_', ' '))}</span>`).join('<br>') : '<span class="muted">none open</span>') },
          { label: '', render: (c) => (canOrder && c.risk !== 'ok' && !c.workOrders.length ? `<button class="btn sm" type="button" data-wo="${esc(c.id)}">Open work order</button>` : '') },
        ],
        rows: d.chargers, empty: 'No chargers match.',
        onRow: (c) => detail(c.id),
      });
    };
    const detail = async (id) => {
      let c;
      try { c = await api(`/v1/charger-health/${id}`); } catch (e) { toast(e.message, 'crit'); return; }
      const p = c.parts;
      const codes = Object.entries(p.codes).sort((a, b) => b[1] - a[1]);
      const hist = c.history;
      const html = `<div class="stack" style="gap:12px">
          <div>${tag(...RISK[c.risk])} ${c.reasons.map((r) => `<div class="cell-sub">${esc(r)}</div>`).join('')}</div>
          <dl class="kv">
            <dt>Outages</dt><dd>${fmt.num(p.outages)} · ${fmt.num(p.offlineHours, 1)} h offline <span class="muted">(−${c.penalties.outages})</span></dd>
            <dt>Faults</dt><dd>${fmt.num(p.faults)} (${fmt.num(p.recentFaults)} in 7 days) <span class="muted">(−${c.penalties.faults})</span>${codes.length ? `<div class="cell-sub">${codes.map(([k, n]) => `${esc(k)} × ${n}`).join(', ')}</div>` : ''}</dd>
            <dt>Reboots</dt><dd>${fmt.num(p.reboots)} <span class="muted">(−${c.penalties.reboots})</span></dd>
            <dt>Failed starts</dt><dd>${fmt.num(p.failedStarts)} of ${fmt.num(p.sessions)} sessions <span class="muted">(−${c.penalties.failedStarts})</span></dd>
            <dt>Now</dt><dd>${p.faultedNow ? tag('t-crit', `faulted${p.errorNow ? `: ${p.errorNow}` : ''}`) : tag('t-ok', 'no fault')}</dd>
          </dl>
          ${hist.length > 1 ? `<div><b>Score by day</b><svg viewBox="0 0 ${hist.length * 6} 100" preserveAspectRatio="none" style="width:100%;height:80px" role="img" aria-label="Score by day">
            <polyline fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" points="${hist.map((h, i) => `${i * 6},${100 - h.score}`).join(' ')}"/></svg>
            <div class="cell-sub">${esc(fmt.date(hist[0].day))} – ${esc(fmt.date(hist[hist.length - 1].day))}</div></div>` : '<p class="cell-sub">The daily history starts with the first daily run.</p>'}
        </div>`;
      drawer({ title: c.name ?? c.identity, subtitle: `${esc(c.siteName)} · health ${c.score}/100`, tabs: [{ id: 'health', label: 'Health', render: (el) => { el.innerHTML = html; } },
        { id: 'diag', label: 'Diagnostics', render: (el) => diagTab(el, id) }] });
    };
    $('[data-list]', root).addEventListener('click', async (e) => {
      const b = e.target.closest('[data-wo]');
      if (!b) return;
      e.stopPropagation();
      b.disabled = true;
      try { const w = await api(`/v1/charger-health/${b.dataset.wo}/work-order`, { method: 'POST' }); toast(`Work order ${w.number} opened.`, 'ok'); draw(); } catch (err) { toast(err.message, 'crit'); b.disabled = false; }
    });
    $('[data-run]', root)?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try { const r = await api('/v1/charger-health/run', { method: 'POST' }); toast(`Scored ${r.chargers} charger${r.chargers === 1 ? '' : 's'}; ${r.alerts} at risk.`, 'ok'); await draw(); } catch (err) { toast(err.message, 'crit'); }
      e.currentTarget.disabled = false;
    });
    $('[data-risk]', root).addEventListener('change', draw);
    $('[data-site]', root).addEventListener('change', draw);
    await draw();
  },
});
