import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options, copy } from '../core.js';

/**
 * (v1.49.0) Assets & energy → Battery swap: two-wheeler swap cabinets (their slots, packs ready and charging, online),
 * every battery pack (where it is, its charge and health), riders' plans and the swap log.
 */

const PACK = { in_cabinet: ['t-ok', 'in a cabinet'], with_rider: ['t-info', 'with a rider'], maintenance: ['t-warn', 'maintenance'], retired: ['t-mute', 'retired'] };
const OUT = { included: ['t-ok', 'in the plan'], paid: ['t-info', 'paid'], refused: ['t-crit', 'refused'] };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const TABS = [['cabinets', 'Cabinets'], ['packs', 'Packs'], ['riders', 'Riders & plans'], ['swaps', 'Swaps']];

registerView('battery-swap', {
  title: 'Battery swap',
  icon: 'bolt',
  group: 'assets',
  order: 21,
  perm: 'site:read',
  async render(root) {
    const canWrite = state.can('site:write');
    root.innerHTML = pageHead('Battery swap', 'Swap cabinets for electric motorbikes: riders swap a flat pack for a charged one, within their plan or paid from their credit.',
      canWrite ? `<button class="btn" type="button" data-settings>${icon('gear')} Settings</button>` : '')
      + `<div data-k></div><div class="tabs" role="tablist">${TABS.map(([id, l]) => `<button role="tab" type="button" aria-selected="false" data-tab="${id}">${l}</button>`).join('')}</div><div data-body class="stack" style="gap:14px"></div>`;
    const body = $('[data-body]', root);
    let tab = 'cabinets', ov = null, sites = [];

    const showOnce = (title, text, value) => modal({ title, body: `${callout('warn', text)}<div style="display:flex;gap:6px;margin-top:8px"><input readonly value="${esc(value)}" style="flex:1"><button class="btn" type="button" data-cpy>${icon('copy')} Copy</button></div>`,
      onMount: (mc) => $('[data-cpy]', mc.el).addEventListener('click', () => copy(value)) });

    const settingsModal = () => {
      const s = ov.settings;
      modal({ title: 'Battery swap settings', body: `<div class="form grid2">${field('Battery swap', `<select name="en">${options([{ value: '1', label: 'On' }, { value: '0', label: 'Off' }], s.enabled ? '1' : '0')}</select>`)}
          ${field(`Price per swap (${esc(s.currency)}, minor units)`, `<input name="price" type="number" min="0" value="${s.pricePerSwapMinor}">`, { help: 'Without a plan, or beyond the swaps it includes. Paid from the rider\'s credit.' })}
          ${field('A pack is ready at (%)', `<input name="soc" type="number" min="50" max="100" value="${s.minSocOut}">`)}
          ${field('Flag packs below health (%)', `<input name="soh" type="number" min="40" max="95" value="${s.retireSoh}">`)}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
        const v = (n) => $(`[name="${n}"]`, mc.el).value;
        await api('/v1/battery-swap/settings', { method: 'PUT', body: { enabled: v('en') === '1', pricePerSwapMinor: Number(v('price')), minSocOut: Number(v('soc')), retireSoh: Number(v('soh')) } });
        toast('Saved.', 'ok'); draw();
      }) }] });
    };

    const cabinetModal = (c) => modal({ title: c ? `Cabinet ${c.code}` : 'Add a cabinet', body: `<div class="form grid2">${field('Site', `<select name="site">${options(sites.map((s) => ({ value: s.id, label: s.name })), c?.siteId ?? '')}</select>`)}
        ${field('Code', `<input name="code" maxlength="30" value="${esc(c?.code ?? '')}" placeholder="SWP-01">`)}${field('Name', `<input name="name" maxlength="120" value="${esc(c?.name ?? '')}">`)}
        ${field('Slots', `<input name="slots" type="number" min="1" max="60" value="${c?.slots ?? 8}">`)}
        ${c ? field('Status', `<select name="st">${options([{ value: 'active', label: 'Active' }, { value: 'maintenance', label: 'Maintenance' }], c.status)}</select>`) : ''}</div>`,
    actions: [...(c ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/battery-swap/cabinets/${c.id}`, { method: 'PUT', body: { archive: true } }); draw(); }) },
      { label: 'New key', onClick: guard(async () => { const r = await api(`/v1/battery-swap/cabinets/${c.id}`, { method: 'PUT', body: { rotateKey: true } }); showOnce('The cabinet\'s address', 'Shown once: configure the cabinet\'s controller with it (see BATTERY-SWAP.md).', `${location.origin}/v1/swap/cabinets/${r.key}`); }) }] : []),
      { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
        const v = (n) => $(`[name="${n}"]`, mc.el)?.value.trim();
        const r = await api(c ? `/v1/battery-swap/cabinets/${c.id}` : '/v1/battery-swap/cabinets', { method: c ? 'PUT' : 'POST', body: { siteId: v('site'), code: v('code'), name: v('name'), slots: Number(v('slots')), ...(c ? { status: v('st') } : {}) } });
        if (r.key) showOnce('The cabinet\'s address', 'Shown once: configure the cabinet\'s controller with it (see BATTERY-SWAP.md).', `${location.origin}/v1/swap/cabinets/${r.key}`); else toast('Saved.', 'ok');
        draw();
      }) }] });

    const packModal = (p) => modal({ title: p ? `Pack ${p.serial}` : 'Register a pack', body: `<div class="form grid2">${p ? '' : field('Serial number', '<input name="serial" maxlength="60">')}
        ${field('Model', `<input name="model" maxlength="60" value="${esc(p?.model ?? '')}">`)}${field('Capacity (Wh)', `<input name="cap" type="number" min="1" value="${p?.capacityWh ?? ''}">`)}
        ${p ? field('Status', `<select name="st">${options([{ value: p.status, label: PACK[p.status]?.[1] ?? p.status }, ...['maintenance', 'retired', ...(p.status === 'maintenance' ? ['in_cabinet'] : [])].filter((x) => x !== p.status).map((x) => ({ value: x, label: PACK[x][1] }))], p.status)}</select>`) : ''}
        ${p ? field('Fault', `<input name="fault" maxlength="200" value="${esc(p.fault ?? '')}">`, { full: true }) : ''}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
      const v = (n) => $(`[name="${n}"]`, mc.el)?.value.trim();
      await api(p ? `/v1/battery-swap/packs/${p.id}` : '/v1/battery-swap/packs', { method: p ? 'PUT' : 'POST', body: { ...(p ? { status: v('st'), fault: v('fault') || null } : { serial: v('serial') }), model: v('model') || null, capacityWh: v('cap') ? Number(v('cap')) : null } });
      toast('Saved.', 'ok'); draw();
    }) }] });

    const planModal = (p) => modal({ title: p ? `Plan ${p.name}` : 'Add a plan', body: `<div class="form grid2">${field('Name', `<input name="name" maxlength="80" value="${esc(p?.name ?? '')}">`)}
        ${field(`Monthly fee (${esc(ov.settings.currency)}, minor units)`, `<input name="fee" type="number" min="0" value="${p?.monthlyMinor ?? 0}">`)}
        ${field('Swaps included a month', `<input name="inc" type="number" min="0" value="${p?.swapsIncluded ?? ''}">`, { help: 'Empty: unlimited. A fee of 0 with 0 included is pay per swap.' })}</div>`,
    actions: [...(p ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/battery-swap/plans/${p.id}`, { method: 'PUT', body: { archive: true } }); draw(); }) }] : []),
      { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
        const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
        await api(p ? `/v1/battery-swap/plans/${p.id}` : '/v1/battery-swap/plans', { method: p ? 'PUT' : 'POST', body: { name: v('name'), monthlyMinor: Number(v('fee')), swapsIncluded: v('inc') === '' ? null : Number(v('inc')) } });
        toast('Saved.', 'ok'); draw();
      }) }] });

    const draw = async () => {
      $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
      try {
        [ov, sites] = await Promise.all([api('/v1/battery-swap'), api('/v1/sites').then((r) => (Array.isArray(r) ? r : r.sites ?? []))]);
      } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const k = ov.kpis, cur = ov.settings.currency;
      $('[data-k]', root).innerHTML = `${ov.settings.enabled ? '' : callout('info', 'Battery swap is off: cabinets report, but riders cannot subscribe or swap. Turn it on in Settings.')}
        <div class="grid k4" style="margin-bottom:14px">${kpi('Swaps (24 h)', fmt.num(k.swaps24h), `${fmt.num(k.swaps30d)} in 30 days`)}${kpi('Riders', fmt.num(k.riders), `${fmt.money(k.monthlyFeesMinor, cur)} a month in fees`)}
          ${kpi('Paid per swap (30 days)', fmt.money(k.paid30dMinor, cur), `${fmt.num(k.kwh30d, 1)} kWh`)}${kpi('Packs needing attention', fmt.num(k.attention), `${fmt.num(k.refused30d)} swaps refused (30 days)`, k.attention ? 'warn' : '')}</div>`;
      if (tab === 'cabinets') {
        body.innerHTML = `<div class="card section"><header><h3>Cabinets</h3>${canWrite ? `<button class="btn sm right" type="button" data-addc>${icon('plus')} Add a cabinet</button>` : ''}</header><div data-t></div></div>`;
        table($('[data-t]', body), { columns: [{ label: 'Cabinet', render: (c) => `<b>${esc(c.code)}</b> ${esc(c.name)}<div class="cell-sub">${esc(c.site ?? '')}</div>` },
          { label: 'State', render: (c) => (c.status !== 'active' ? tag('t-warn', c.status) : c.online ? tag('t-ok', 'online') : tag('t-crit', 'not reporting', c.lastSeenAt ? `Last: ${fmt.time(c.lastSeenAt)}` : 'Never reported')) },
          { label: 'Ready', num: true, render: (c) => `<b>${fmt.num(c.ready)}</b><div class="cell-sub">${fmt.num(c.charging)} charging · ${fmt.num(c.slots)} slots</div>` },
          { label: 'Swaps (24 h)', num: true, render: (c) => fmt.num(c.swaps24h) }, { label: 'Key', render: (c) => (c.keyPrefix ? `<code>${esc(c.keyPrefix)}…</code>` : '—') }],
        rows: ov.cabinets, empty: 'No cabinets yet.', onRow: canWrite ? cabinetModal : undefined });
        $('[data-addc]', body)?.addEventListener('click', () => cabinetModal(null));
      } else if (tab === 'packs') {
        const p = await api('/v1/battery-swap/packs');
        body.innerHTML = `<div class="card section"><header><h3>Battery packs</h3><span class="cell-sub">${Object.entries(p.byStatus).map(([s, n]) => `${fmt.num(n)} ${esc(PACK[s]?.[1] ?? s)}`).join(' · ')}</span>
          ${canWrite ? `<button class="btn sm right" type="button" data-addp>${icon('plus')} Register a pack</button>` : ''}</header><div data-t></div></div>`;
        table($('[data-t]', body), { columns: [{ label: 'Pack', render: (x) => `<b>${esc(x.serial)}</b><div class="cell-sub">${esc(x.model ?? '')}${x.capacityWh ? ` · ${fmt.num(x.capacityWh)} Wh` : ''}</div>` },
          { label: 'Where', render: (x) => `${tag(...PACK[x.status])}<div class="cell-sub">${x.cabinet ? `${esc(x.cabinet)} slot ${esc(x.slot ?? '?')}` : x.rider ? `rider ${esc(x.rider)}` : ''}</div>` },
          { label: 'Charge', num: true, render: (x) => fmt.pct(x.soc) }, { label: 'Health', num: true, render: (x) => (x.soh == null ? '—' : `<b style="color:${x.soh < p.retireSoh ? 'var(--crit, #b42318)' : 'inherit'}">${fmt.pct(x.soh, 1)}</b>`) },
          { label: 'Temp.', num: true, render: (x) => (x.tempC == null ? '—' : `${fmt.num(x.tempC, 1)} °C`) }, { label: 'Cycles', num: true, render: (x) => fmt.num(x.cycles) },
          { label: '', render: (x) => (x.fault ? tag('t-crit', 'fault', x.fault) : x.attention ? tag('t-warn', 'retire') : '') }],
        rows: p.packs, empty: 'No packs yet: they appear when a cabinet reports them, or register them here.', onRow: canWrite ? packModal : undefined });
        $('[data-addp]', body)?.addEventListener('click', () => packModal(null));
      } else if (tab === 'riders') {
        const [{ plans }, { riders }] = await Promise.all([api('/v1/battery-swap/plans'), api('/v1/battery-swap/riders')]);
        body.innerHTML = `<div class="card section"><header><h3>Plans</h3>${canWrite ? `<button class="btn sm right" type="button" data-addpl>${icon('plus')} Add a plan</button>` : ''}</header><div data-pl></div></div>
          <div class="card section"><header><h3>Riders</h3><span class="cell-sub">Riders subscribe in the app</span></header><div data-r></div></div>`;
        table($('[data-pl]', body), { columns: [{ label: 'Plan', render: (x) => `<b>${esc(x.name)}</b>${x.archived ? ` ${tag('t-mute', 'archived')}` : ''}` }, { label: 'Monthly', num: true, render: (x) => fmt.money(x.monthlyMinor, x.currency) },
          { label: 'Swaps included', num: true, render: (x) => (x.swapsIncluded == null ? 'unlimited' : fmt.num(x.swapsIncluded)) }, { label: 'Subscribers', num: true, render: (x) => fmt.num(x.subscribers) }],
        rows: plans, empty: 'No plans yet. Riders need one to swap (a fee of 0 with 0 included is pay per swap).', onRow: canWrite ? (x) => (x.archived ? null : planModal(x)) : undefined });
        table($('[data-r]', body), { columns: [{ label: 'Rider', render: (x) => `${esc(x.rider ?? '')}<div class="cell-sub">${esc(x.phone ?? '')}</div>` }, { label: 'Plan', render: (x) => `${esc(x.plan)} ${x.status === 'active' ? '' : tag('t-mute', x.status)}` },
          { label: 'Period', render: (x) => `${esc(x.periodStart)} → ${esc(x.periodEnd)}` }, { label: 'Swaps', num: true, render: (x) => `${fmt.num(x.swaps)}${x.swapsIncluded == null ? '' : ` / ${fmt.num(x.swapsIncluded)}`}` },
          { label: 'Holds', render: (x) => esc(x.pack ?? '—') }], rows: riders, empty: 'No riders yet.' });
        $('[data-addpl]', body)?.addEventListener('click', () => planModal(null));
      } else {
        const { swaps } = await api('/v1/battery-swap/swaps');
        body.innerHTML = '<div class="card section"><header><h3>Swaps</h3><span class="cell-sub">The last 500</span></header><div data-t></div></div>';
        table($('[data-t]', body), { columns: [{ label: 'When', render: (x) => esc(fmt.time(x.at)) }, { label: 'Cabinet', render: (x) => esc(x.cabinet) }, { label: 'Rider', render: (x) => esc(x.rider ?? '—') },
          { label: 'Packs', render: (x) => `${esc(x.packIn ?? '?')} ${x.socIn == null ? '' : `(${fmt.pct(x.socIn)})`} → ${esc(x.packOut ?? '?')} ${x.socOut == null ? '' : `(${fmt.pct(x.socOut)})`}` },
          { label: 'kWh', num: true, render: (x) => (x.kwh == null ? '—' : fmt.num(x.kwh, 2)) }, { label: 'Outcome', render: (x) => `${tag(...OUT[x.outcome])}${x.reason ? `<div class="cell-sub">${esc(x.reason)}</div>` : ''}` },
          { label: 'Paid', num: true, render: (x) => (x.amountMinor ? fmt.money(x.amountMinor, x.currency) : '—') }], rows: swaps, empty: 'No swaps yet.' });
      }
    };

    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; draw(); }));
    $('[data-settings]', root)?.addEventListener('click', () => ov && settingsModal());
    await draw();
  },
});
