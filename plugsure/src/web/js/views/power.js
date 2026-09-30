import {
  $, $$, esc, api, attempt, state, registerView, pageHead, table, tag, icon, fmt, confirmDialog, toast, callout, kpi,
  navigate, onLive, debounce, sites as loadSites, options,
} from '../core.js';

/**
 * Module 4 — Dynamic Load Management & Smart Charging Studio.
 *
 * The subscription guardrail (PLUGSURE-FIX-CAP-01) is enforced twice: the
 * slider snaps back at connected kVA × PF with the prescribed message, and the
 * API refuses to store anything above it.
 */

const RESERVES = [
  ['lighting', 'Station lighting'],
  ['pos', 'POS terminals & kiosks'],
  ['cctv', 'CCTV & network'],
  ['hvac', 'Air conditioning'],
  ['other', 'Other building load'],
];

registerView('power', {
  title: 'Load management',
  icon: 'power',
  group: 'assets',
  order: 11,
  perm: 'smartcharging:read',
  async render(root, [siteParam]) {
    const siteList = (await loadSites()).filter((s) => !s.archived_at);
    if (!siteList.length) {
      root.innerHTML = pageHead('Load management') + callout('info', 'Create a site first — load management works per electrical site.');
      return;
    }
    const siteId = siteList.some((s) => s.id === siteParam) ? siteParam : siteList[0].id;
    const canWrite = state.can('smartcharging:write');

    root.innerHTML = pageHead(
      'Dynamic Load Management',
      'Share the site\'s PLN subscription between chargers. The hard ceiling is the subscribed kVA × power factor; above it the breaker trips and the site is billed for over-limit draw.',
      `<select data-site style="min-width:280px">${options(siteList.map((s) => ({ value: s.id, label: s.name })), siteId)}</select>`,
    ) + `
      <div class="grid k4" data-kpis></div>
      <div class="grid two section">
        <div class="card"><header><h3>Site power ceiling</h3><span class="right" data-strategy-tag></span></header><div class="body" data-ceiling></div></div>
        <div class="card"><header><h3>Genset / emergency curtailment</h3></header><div class="body" data-genset></div></div>
      </div>
      <div class="grid two section">
        <div class="card"><header><h3>Auxiliary reserve buffer</h3></header><div class="body" data-reserve></div></div>
        <div class="card"><header><h3>Connector priority</h3><span class="right small muted">drag to rank</span></header><div class="body" data-rank></div></div>
      </div>
      <div class="section"><div class="row" style="margin-bottom:10px"><h2 style="margin:0">Allocation plan</h2>
        ${canWrite ? `<button class="btn right" data-defaults title="Install the conservative TxDefaultProfile every connector falls back to when the CSMS is unreachable">${icon('shield')} Provision fallback profiles</button>
        <button class="btn primary" data-apply>${icon('bolt')} Apply plan to chargers</button>` : ''}</div>
        <p class="hint">Fair-share water-filling with a minimum-viable floor: sessions below the floor are shed rather than starved. The charger's own RS485 load balancing remains the layer that guarantees the breaker during a WAN outage.</p>
        <div class="card" data-plan></div></div>`;
    $('[data-site]', root).addEventListener('change', (e) => navigate(`#/power/${encodeURIComponent(e.target.value)}`));

    let data = null;
    const load = async () => {
      data = await api(`/v1/sites/${encodeURIComponent(siteId)}/power`);
      draw();
    };

    const draw = () => {
      const { headroom: h, budget: b, plan } = data;
      const capW = Number.isFinite(data.subscriptionCeilingW) && data.subscriptionCeilingW ? data.subscriptionCeilingW : null;
      const kvaLabel = `${fmt.num(h.subscribedKva)} kVA`;
      const installedKw = plan.reduce((a, p) => a + p.maxPowerW, 0);
      const allocated = plan.reduce((a, p) => a + p.allocatedW, 0);

      $('[data-kpis]', root).innerHTML = [
        kpi('Subscribed capacity', kvaLabel, `PF ${Number(h.powerFactor).toFixed(2)} · ${h.subscribedKva > 200 ? 'TM (above the 200 kVA cliff)' : 'TR (under the 200 kVA cliff)'}`),
        kpi('Subscription ceiling', capW ? fmt.kw(capW) : '—', 'connected kVA × PF — the hard cap'),
        kpi('Allocated now', fmt.kw(allocated), `${fmt.num(plan.filter((p) => p.active).length)} active sessions · usable ${fmt.kw(data.usableW)}`, b.curtailed ? 'crit' : ''),
        kpi('Installed nameplate', fmt.kw(installedKw), h.unmanagedOversubscriptionKva > 0 ? `oversubscribed by ${fmt.num(h.unmanagedOversubscriptionKva, 1)} kVA — DLM makes this safe` : 'within subscription', h.unmanagedOversubscriptionKva > 0 ? 'warn' : ''),
      ].join('');
      $('[data-strategy-tag]', root).innerHTML = b.configuredCeilingW > b.ceilingW ? tag('t-warn', 'stored value clamped', `A ceiling of ${fmt.kw(b.configuredCeilingW)} was stored; ${fmt.kw(b.ceilingW)} is in force.`) : '';

      // ---------------- ceiling slider with hard guardrail
      const maxSlider = Math.max(capW ?? 0, installedKw, b.ceilingW) * 1.15 || 100_000;
      const box = $('[data-ceiling]', root);
      box.innerHTML = `
        <div class="row"><div class="kpi" style="padding:0"><div class="value" data-val></div><div class="foot">managed ceiling</div></div>
          <div class="right field" style="width:170px"><label>Set ceiling</label><div class="inputgroup"><input data-num inputmode="decimal" ${canWrite ? '' : 'disabled'}><span class="suffix">kW</span></div></div></div>
        <div class="slider-wrap" data-wrap>
          ${capW ? `<span class="cap-mark" style="left:${(capW / maxSlider) * 100}%">▼ ${esc(fmt.kw(capW))} contract limit</span>` : ''}
          <input type="range" data-range min="0" max="${Math.round(maxSlider)}" step="500" ${canWrite ? '' : 'disabled'} aria-label="Site power ceiling">
          <div class="slider-scale"><span>0 kW</span><span>${esc(fmt.kw(maxSlider, 0))}</span></div>
        </div>
        <div data-guard></div>
        <div class="field" style="margin-top:12px"><label>Allocation strategy</label><div class="seg" data-strat>
          <button type="button" data-v="fair_share">Fair share</button><button type="button" data-v="priority">Priority tiers</button></div>
          <div class="help">Priority tiers rank connectors (e.g. fleet buses before retail cars); fair share treats every session equally.</div></div>
        ${canWrite ? `<div class="row" style="margin-top:14px"><button class="btn primary" data-save>Save ceiling & strategy</button><span class="small muted" data-dirty></span></div>` : ''}`;
      const range = $('[data-range]', box);
      const numIn = $('[data-num]', box);
      const guard = $('[data-guard]', box);
      let ceiling = b.configuredCeilingW != null ? Math.min(b.configuredCeilingW, capW ?? Infinity) : b.ceilingW;
      let strategy = b.strategy === 'priority' ? 'priority' : 'fair_share';
      const show = (w, over = false) => {
        range.value = String(w);
        numIn.value = (w / 1000).toFixed(1);
        $('[data-val]', box).textContent = fmt.kw(w);
        $('[data-wrap]', box).classList.toggle('over', over);
        numIn.classList.toggle('invalid', over);
      };
      /**
       * The guardrail. Above the cap: flash red, show the prescribed message, and
       * snap back to exactly the cap.
       */
      const propose = (w) => {
        if (capW && w > capW) {
          show(w, true);
          guard.innerHTML = callout('crit', `<b>Exceeds ${esc(kvaLabel)} PLN contract limit. Clamped to prevent breaker trip.</b> The maximum is ${esc(fmt.num(h.subscribedKva))} kVA × ${esc(Number(h.powerFactor).toFixed(2))} PF = ${esc(fmt.kw(capW))}.`);
          setTimeout(() => { ceiling = capW; show(capW, false); }, 450);
          return;
        }
        guard.innerHTML = '';
        ceiling = Math.max(0, w);
        show(ceiling);
        const dirty = $('[data-dirty]', box);
        if (dirty) dirty.textContent = 'unsaved change';
      };
      show(ceiling);
      range.addEventListener('input', () => propose(Number(range.value)));
      numIn.addEventListener('change', () => propose(Math.round(Number(numIn.value) * 1000)));
      $$('[data-strat] button', box).forEach((btn) => {
        btn.setAttribute('aria-pressed', String(btn.dataset.v === strategy));
        btn.addEventListener('click', () => {
          if (!canWrite) return;
          strategy = btn.dataset.v;
          $$('[data-strat] button', box).forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
          const dirty = $('[data-dirty]', box); if (dirty) dirty.textContent = 'unsaved change';
        });
      });
      $('[data-save]', box)?.addEventListener('click', async (e) => {
        e.target.classList.add('busy');
        try {
          await api(`/v1/sites/${encodeURIComponent(siteId)}/power/budget`, { method: 'PUT', body: { ceilingW: ceiling, strategy, applyNow: true } });
          toast('Ceiling saved and dispatched', 'ok');
          await load();
        } catch (err) {
          guard.innerHTML = callout('crit', esc(err.message));
          if (err.data?.maxW) { ceiling = err.data.maxW; show(ceiling); }
        }
        e.target.classList.remove('busy');
      });

      // ---------------- genset switch
      const g = $('[data-genset]', root);
      g.innerHTML = `<div class="big-switch ${b.curtailed ? 'on' : ''}">
          <label class="switch"><input type="checkbox" data-genset-switch ${b.curtailed ? 'checked' : ''} ${canWrite ? '' : 'disabled'}><span></span></label>
          <div class="grow"><b>${b.curtailed ? 'CURTAILED — all chargers held at 0 kW' : 'Grid supply — normal operation'}</b>
          <div class="small muted">${b.curtailed ? `Since ${esc(fmt.time(b.curtailedAt))}${b.curtailedReason ? ` · ${esc(b.curtailedReason)}` : ''}` : 'Switch on during a grid outage or while the site runs on its emergency diesel generator.'}</div></div></div>
        <p class="small muted">Switching on immediately dispatches 0 kW station ceilings (ChargePointMaxProfile) to every connected charger at this site; switching off restores the allocation plan.</p>`;
      $('[data-genset-switch]', g)?.addEventListener('change', async (e) => {
        const on = e.target.checked;
        const ok = await confirmDialog({
          title: on ? 'Curtail the whole site to 0 kW?' : 'Restore normal charging?',
          message: on ? 'Every active session at this site will be throttled to zero immediately. Use this for grid outages and genset operation.' : 'Chargers receive their normal allocation again.',
          confirmLabel: on ? 'Curtail now' : 'Restore',
          danger: on,
        });
        if (!ok) { e.target.checked = !on; return; }
        const r = await attempt(() => api(`/v1/sites/${encodeURIComponent(siteId)}/power/curtail`, { method: 'POST', body: { curtailed: on, reason: on ? 'Genset / grid outage (manual)' : null } }));
        if (r) toast(on ? 'Curtailed — 0 kW ceilings are being dispatched to every connected charger' : 'Curtailment lifted — normal allocation is being restored', on ? 'warn' : 'ok');
        setTimeout(() => load().catch(() => {}), 1500);
      });

      // ---------------- auxiliary reserve
      const bd = b.reserveBreakdown ?? {};
      const hasBreakdown = Object.keys(bd).length > 0;
      const r = $('[data-reserve]', root);
      r.innerHTML = `<p class="small muted" style="margin-top:0">Power held back from charging for the site's own loads, so chargers never compete with the lights and the tills.</p>
        <div class="form">${RESERVES.map(([k, l]) => `<div class="field"><label>${esc(l)}</label><div class="inputgroup"><input data-res="${k}" inputmode="decimal" ${canWrite ? '' : 'disabled'}><span class="suffix">kW</span></div></div>`).join('')}</div>
        <div class="row" style="margin-top:12px"><div><b data-res-total></b> <span class="small muted">reserved · <span data-res-usable></span> left for charging</span></div>
        ${canWrite ? '<button class="btn right" data-res-save>Save reserve</button>' : ''}</div>
        ${!hasBreakdown && b.reserveW ? `<div class="small muted" style="margin-top:6px">A single reserve of ${esc(fmt.kw(b.reserveW))} is configured; entering a breakdown replaces it.</div>` : ''}`;
      RESERVES.forEach(([k]) => { $(`[data-res="${k}"]`, r).value = bd[k] ? String(bd[k] / 1000) : k === 'other' && !hasBreakdown && b.reserveW ? String(b.reserveW / 1000) : ''; });
      const sumRes = () => {
        const w = RESERVES.reduce((a, [k]) => a + Math.round(Number($(`[data-res="${k}"]`, r).value || 0) * 1000), 0);
        $('[data-res-total]', r).textContent = fmt.kw(w);
        $('[data-res-usable]', r).textContent = fmt.kw(Math.max(0, ceiling - w));
        return w;
      };
      $$('[data-res]', r).forEach((i) => i.addEventListener('input', sumRes));
      sumRes();
      $('[data-res-save]', r)?.addEventListener('click', async () => {
        const reserveBreakdown = Object.fromEntries(RESERVES.map(([k]) => [k, Math.round(Number($(`[data-res="${k}"]`, r).value || 0) * 1000)]));
        if (await attempt(() => api(`/v1/sites/${encodeURIComponent(siteId)}/power/budget`, { method: 'PUT', body: { reserveBreakdown, applyNow: true } }), { success: 'Reserve saved' })) load();
      });

      // ---------------- connector prioritisation (drag and drop)
      const rank = $('[data-rank]', root);
      const conns = [...plan].sort((a, b2) => b2.priority - a.priority || a.ocppIdentity.localeCompare(b2.ocppIdentity) || a.connectorNo - b2.connectorNo);
      rank.innerHTML = `${strategy !== 'priority' ? callout('', 'Ranks apply only under the <b>Priority tiers</b> strategy.') : ''}
        <ol class="rank-list" style="margin-top:10px">${conns.map((p, i) => `<li draggable="${canWrite}" data-uuid="${esc(p.connectorUuid ?? '')}">
          <span class="grip">${icon('grip')}</span><span class="pos">${i + 1}</span>
          <div class="grow"><b class="mono" style="font-size:12px">${esc(p.ocppIdentity)}</b> · gun ${esc(p.connectorNo)}<div class="cell-sub">${esc(p.connectorType ?? p.currentType)} · ${esc(fmt.kw(p.maxPowerW))}</div></div>
          ${p.active ? tag('t-info', 'charging') : ''}</li>`).join('')}</ol>
        ${canWrite && conns.length ? '<div class="row" style="margin-top:10px"><button class="btn" data-rank-save>Save ranking</button><span class="small muted">Top of the list is served first and shed last.</span></div>' : ''}`;
      const ol = $('.rank-list', rank);
      let dragging = null;
      ol.addEventListener('dragstart', (e) => { dragging = e.target.closest('li'); dragging?.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      ol.addEventListener('dragend', () => { dragging?.classList.remove('dragging'); $$('li', ol).forEach((li) => li.classList.remove('over')); dragging = null; renumber(); });
      ol.addEventListener('dragover', (e) => {
        e.preventDefault();
        const over = e.target.closest('li');
        if (!over || over === dragging || !dragging) return;
        const rect = over.getBoundingClientRect();
        ol.insertBefore(dragging, e.clientY < rect.top + rect.height / 2 ? over : over.nextSibling);
      });
      const renumber = () => $$('li .pos', ol).forEach((s, i) => { s.textContent = String(i + 1); });
      $('[data-rank-save]', rank)?.addEventListener('click', async () => {
        const lis = $$('li', ol);
        const priorities = lis.filter((li) => li.dataset.uuid).map((li, i) => ({ connectorUuid: li.dataset.uuid, priority: lis.length - i }));
        if (await attempt(() => api(`/v1/sites/${encodeURIComponent(siteId)}/power/priorities`, { method: 'PUT', body: { priorities } }), { success: 'Priorities saved' })) load();
      });

      // ---------------- plan
      table($('[data-plan]', root), {
        columns: [
          { label: 'Charge point', render: (p) => `<span class="mono">${esc(p.ocppIdentity)}</span>` },
          { label: 'Gun', render: (p) => esc(p.connectorNo) },
          { label: 'Type', render: (p) => `${esc(p.currentType)} · ${esc(p.phases)}Ø` },
          { label: 'Priority', num: true, render: (p) => esc(p.priority) },
          { label: 'State', render: (p) => tag(p.active ? 't-info' : 't-mute', p.active ? 'drawing' : 'idle') },
          { label: 'Nameplate', num: true, render: (p) => esc(fmt.kw(p.maxPowerW)) },
          { label: 'Allocated', num: true, render: (p) => `<b>${esc(fmt.kw(p.allocatedW))}</b>` },
          { label: 'Sent as', num: true, render: (p) => `<span class="mono">${esc(p.limit)} ${esc(p.unit)}</span>` },
        ],
        rows: plan,
        empty: 'No connectors at this site.',
      });
    };

    $('[data-apply]', root)?.addEventListener('click', async (e) => {
      e.target.classList.add('busy');
      const r = await attempt(() => api(`/v1/sites/${encodeURIComponent(siteId)}/power/apply`, { method: 'POST' }));
      e.target.classList.remove('busy');
      if (r) toast(`${r.applied?.length ?? 0} connector allocations sent`, 'ok');
      load();
    });
    $('[data-defaults]', root)?.addEventListener('click', async () => {
      const r = await attempt(() => api(`/v1/sites/${encodeURIComponent(siteId)}/power/provision-defaults`, { method: 'POST' }));
      if (r) toast(`${r.applied} fallback profiles installed`, 'ok');
    });

    await load();
    // Live refresh, but never over an operator's unsaved slider change.
    const reload = debounce(() => { if (!$('[data-dirty]', root)?.textContent) load().catch(() => {}); }, 1500);
    const off = onLive((e) => { if (e.kind === 'connector.status_changed' || e.kind.startsWith('session.')) reload(); });
    return off;
  },
});
