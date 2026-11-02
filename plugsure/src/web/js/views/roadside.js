import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options } from '../core.js';

/**
 * (v1.49.0) Operate → Roadside: mobile charging vans sent to cars that cannot reach a charger. Requests from the app or
 * taken by phone, dispatched to the nearest van with enough energy, moved on by the technician, paid from the driver's
 * credit and the rest collected on site.
 */

const ST = { requested: ['t-crit', 'waiting for a van'], assigned: ['t-warn', 'assigned'], en_route: ['t-info', 'on the way'], charging: ['t-info', 'charging'], done: ['t-ok', 'done'], cancelled: ['t-mute', 'cancelled'] };
const VAN = { available: ['t-ok', 'available'], busy: ['t-info', 'on a request'], off_duty: ['t-mute', 'off duty'] };
const NEXT = { assigned: [['en_route', 'On the way'], ['requested', 'Unassign']], en_route: [['charging', 'Arrived, charging']], charging: [] };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const map = (lat, lon) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;

registerView('roadside', {
  title: 'Roadside',
  icon: 'phone',
  group: 'operate',
  order: 7,
  perm: 'session:read',
  async render(root) {
    const canWrite = state.can('session:write');
    root.innerHTML = pageHead('Roadside charging', 'Charging vans sent to cars that cannot reach a charger: requests from the app or by phone, dispatched to the nearest van.',
      canWrite ? `<button class="btn" type="button" data-settings>${icon('gear')} Settings</button><button class="btn" type="button" data-van>${icon('plus')} Add a van</button><button class="btn primary" type="button" data-take>${icon('phone')} Take a request</button>` : '')
      + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    let d = null, users = [], timer = null;

    const settingsModal = () => {
      const s = d.settings;
      modal({ title: 'Roadside settings', body: `<div class="form grid2">${field('Roadside charging', `<select name="en">${options([{ value: '1', label: 'On (drivers can request it in the app)' }, { value: '0', label: 'Off' }], s.enabled ? '1' : '0')}</select>`)}
          ${field('Dispatch phone', `<input name="phone" maxlength="30" value="${esc(s.phone ?? '')}">`, { help: 'Shown to the driver.' })}
          ${field(`Call-out fee (${esc(s.currency)}, minor units)`, `<input name="co" type="number" min="0" value="${s.calloutMinor}">`)}
          ${field(`Price per kWh (${esc(s.currency)}, minor units)`, `<input name="kwh" type="number" min="0" value="${s.perKwhMinor}">`)}
          ${field('Service radius from a van\'s base (km)', `<input name="r" type="number" min="1" max="300" value="${s.radiusKm}">`)}
          ${field('Most kWh per request', `<input name="max" type="number" min="1" max="200" value="${s.maxKwh}">`)}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
        const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
        await api('/v1/roadside/settings', { method: 'PUT', body: { enabled: v('en') === '1', phone: v('phone') || null, calloutMinor: Number(v('co')), perKwhMinor: Number(v('kwh')), radiusKm: Number(v('r')), maxKwh: Number(v('max')) } });
        toast('Saved.', 'ok'); draw();
      }) }] });
    };

    const vanModal = (v) => modal({ title: v ? `Van ${v.name}` : 'Add a van', body: `<div class="form grid2">${field('Name', `<input name="name" maxlength="80" value="${esc(v?.name ?? '')}">`)}
        ${field('Plate', `<input name="plate" maxlength="15" value="${esc(v?.plate ?? '')}">`)}
        ${field('Usable battery (kWh)', `<input name="cap" type="number" min="1" step="0.1" value="${v?.kwhCapacity ?? ''}">`)}${field('Charger power (kW)', `<input name="kw" type="number" min="1" step="0.1" value="${v?.kwOutput ?? ''}">`)}
        ${field('Base latitude', `<input name="lat" type="number" step="0.000001" value="${v?.baseLat ?? ''}">`)}${field('Base longitude', `<input name="lon" type="number" step="0.000001" value="${v?.baseLon ?? ''}">`)}
        ${field('Technician', `<select name="tech">${options(users.map((u) => ({ value: u.id, label: u.name || u.email })), v?.technicianId ?? '', { blank: 'Nobody yet' })}</select>`)}
        ${v && v.status !== 'busy' ? field('Status', `<select name="st">${options([{ value: 'available', label: 'Available' }, { value: 'off_duty', label: 'Off duty' }], v.status)}</select>`) : ''}
        ${v ? field('Energy left now (kWh)', `<input name="left" type="number" min="0" step="0.1" value="${v.kwhLeft}">`, { help: 'After recharging the van, set it back to full.' }) : ''}</div>`,
    actions: [...(v && v.status !== 'busy' ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/roadside/vans/${v.id}`, { method: 'PUT', body: { archive: true } }); draw(); }) }] : []),
      { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
        const g = (n) => $(`[name="${n}"]`, mc.el)?.value.trim();
        const r = await api(v ? `/v1/roadside/vans/${v.id}` : '/v1/roadside/vans', { method: v ? 'PUT' : 'POST', body: { name: g('name'), plate: g('plate') || null, kwhCapacity: Number(g('cap')), kwOutput: Number(g('kw')),
          baseLat: Number(g('lat')), baseLon: Number(g('lon')), technicianId: g('tech') || null, ...(g('st') ? { status: g('st') } : {}) } });
        if (v && g('left') !== '' && Number(g('left')) !== v.kwhLeft) await api(`/v1/roadside/vans/${r.id}`, { method: 'PUT', body: { lat: r.lat, lon: r.lon, kwhLeft: Number(g('left')) } });
        toast('Saved.', 'ok'); draw();
      }) }] });

    const takeModal = () => modal({ title: 'Take a roadside request', size: 'lg', body: `<div class="form grid2">${field('Name', '<input name="name" maxlength="80">')}${field('Phone', '<input name="phone" maxlength="30">')}
        ${field('Latitude', '<input name="lat" type="number" step="0.000001">')}${field('Longitude', '<input name="lon" type="number" step="0.000001">')}
        ${field('Where (address, landmark)', '<input name="addr" maxlength="200">', { full: true })}
        ${field('Car', '<input name="veh" maxlength="80">')}${field('Plate', '<input name="plate" maxlength="15">')}
        ${field('Connector', `<select name="conn">${options(['CCS2', 'Type 2', 'CHAdeMO', 'GB/T'].map((x) => ({ value: x, label: x })), 'CCS2', { blank: 'Not known' })}</select>`)}
        ${field('Battery now (%)', '<input name="soc" type="number" min="0" max="100">')}
        ${field('kWh wanted', `<input name="kwh" type="number" min="1" max="${d.settings.maxKwh}" value="10">`)}${field('Note', '<input name="note" maxlength="500">')}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Take it', kind: 'primary', onClick: guard(async (mc) => {
      const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
      const r = await api('/v1/roadside/requests', { method: 'POST', body: { name: v('name') || null, phone: v('phone') || null, lat: Number(v('lat')), lon: Number(v('lon')), address: v('addr') || null,
        vehicle: v('veh') || null, plate: v('plate') || null, connector: v('conn') || null, soc: v('soc') === '' ? null : Number(v('soc')), kwh: Number(v('kwh')), note: v('note') || null } });
      toast(`${r.number} taken: quote ${fmt.money(r.quoteMinor, r.currency)}.`, 'ok'); draw(); openReq(r.id);
    }) }] });

    const openReq = async (id) => {
      let r;
      try { r = await api(`/v1/roadside/requests/${id}`); } catch (e) { toast(e.message, 'crit'); return; }
      const move = (status, extra = {}) => guard(async () => { await api(`/v1/roadside/requests/${r.id}/status`, { method: 'POST', body: { status, ...extra } }); toast('Updated.', 'ok'); draw(); });
      const acts = [];
      if (canWrite && r.status === 'requested') {
        acts.push({ label: 'Cancel the request', kind: 'danger', onClick: guard(async () => { const reason = prompt('Why is it cancelled?'); if (!reason) return false; await api(`/v1/roadside/requests/${r.id}/status`, { method: 'POST', body: { status: 'cancelled', reason } }); draw(); }) });
      }
      if (canWrite) for (const [st, label] of NEXT[r.status] ?? []) acts.push({ label, kind: st === 'requested' ? '' : 'primary', onClick: move(st) });
      if (canWrite && r.status === 'charging') {
        acts.push({ label: 'Done', kind: 'primary', onClick: guard(async (mc) => {
          const kwh = Number($('[name="kd"]', mc.el).value);
          await api(`/v1/roadside/requests/${r.id}/status`, { method: 'POST', body: { status: 'done', kwhDelivered: kwh, collectedBy: $('[name="cb"]', mc.el).value || null } });
          toast('Done.', 'ok'); draw();
        }) });
      }
      if (canWrite && ['assigned', 'en_route'].includes(r.status)) acts.push({ label: 'Cancel', kind: 'danger', onClick: guard(async () => { const reason = prompt('Why is it cancelled?'); if (!reason) return false; await api(`/v1/roadside/requests/${r.id}/status`, { method: 'POST', body: { status: 'cancelled', reason } }); draw(); }) });
      acts.push({ label: 'Close' });
      modal({ title: `${r.number} · ${ST[r.status][1]}`, size: 'lg', body: `
        <div class="grid2" style="gap:6px 16px"><div><b>${esc(r.name ?? 'Driver')}</b> ${r.phone ? `· <a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : ''}<div class="cell-sub">${r.fromApp ? 'From the app' : 'By phone'} · ${esc(fmt.time(r.createdAt))}</div></div>
          <div>${esc(r.address ?? '')} <a href="${map(r.lat, r.lon)}" target="_blank" rel="noopener">${icon('external')} Map</a></div>
          <div>${esc(r.vehicle ?? '')} ${esc(r.plate ?? '')}<div class="cell-sub">${esc(r.connector ?? 'connector not known')}${r.soc != null ? ` · ${r.soc}% now` : ''}</div></div>
          <div>${fmt.num(r.kwhRequested, 1)} kWh wanted · quote <b>${fmt.money(r.quoteMinor, r.currency)}</b>${r.van ? `<div class="cell-sub">${esc(r.van)}${r.etaAt ? ` · ETA ${esc(fmt.time(r.etaAt))}` : ''}</div>` : ''}</div></div>
        ${r.note ? `<p class="cell-sub" style="margin-top:8px">${esc(r.note)}</p>` : ''}
        ${r.status === 'done' ? callout('ok', `${fmt.num(r.kwhDelivered, 2)} kWh · ${fmt.money(r.amountMinor, r.currency)}: ${fmt.money(r.creditMinor, r.currency)} from credit${r.collectMinor ? `, ${fmt.money(r.collectMinor, r.currency)} collected by ${esc((r.collectedBy ?? '').replace('_', ' '))}` : ''}.`) : ''}
        ${r.cancelReason ? callout('info', `Cancelled: ${esc(r.cancelReason)}`) : ''}
        ${r.status === 'requested' ? `<h4 style="margin:14px 0 6px">Vans that can go</h4><div data-c></div>` : ''}
        ${r.status === 'charging' && canWrite ? `<div class="form grid2" style="margin-top:12px">${field('kWh delivered', `<input name="kd" type="number" min="0" step="0.01" value="${r.kwhRequested}">`)}
          ${field('The rest after credit is collected by', `<select name="cb">${options([['cash', 'Cash'], ['qris', 'QRIS'], ['card_terminal', 'Card terminal'], ['invoice', 'Invoice']].map(([value, label]) => ({ value, label })), '', { blank: 'Nothing left (credit covers it)' })}</select>`)}</div>` : ''}`,
      actions: acts, onMount: (mc) => {
        const c = $('[data-c]', mc.el);
        if (!c) return;
        table(c, { columns: [{ label: 'Van', render: (v) => `<b>${esc(v.name)}</b> ${esc(v.plate ?? '')}` }, { label: 'Distance', num: true, render: (v) => `${fmt.num(v.distanceKm, 1)} km` },
          { label: 'ETA', num: true, render: (v) => `${fmt.num(v.etaMin)} min` }, { label: 'Energy left', num: true, render: (v) => `${fmt.num(v.kwhLeft, 1)} kWh` },
          ...(canWrite ? [{ label: '', render: (v) => `<button class="btn sm primary" data-assign="${v.id}">Send</button>` }] : [])], rows: r.candidates, empty: 'No van available with enough energy within the service radius.' });
        $$('[data-assign]', c).forEach((b) => b.addEventListener('click', async () => {
          try { await api(`/v1/roadside/requests/${r.id}/status`, { method: 'POST', body: { status: 'assigned', vanId: b.dataset.assign } }); toast('Van sent.', 'ok'); mc.close?.(); draw(); } catch (e) { toast(e.message, 'crit'); }
        }));
      } });
    };

    const draw = async () => {
      try {
        [d, users] = await Promise.all([api('/v1/roadside'), state.can('user:read') ? api('/v1/users').then((u) => (Array.isArray(u) ? u : u?.users ?? []).filter((x) => x.status !== 'disabled')).catch(() => []) : []]);
      } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const k = d.kpis, cur = d.settings.currency;
      const waiting = d.requests.filter((r) => r.status === 'requested');
      body.innerHTML = `${d.settings.enabled ? '' : callout('info', 'Roadside charging is off in the app. Requests can still be taken by phone here once it is on (Settings).')}
        ${waiting.length ? callout('crit', `${waiting.length} request${waiting.length === 1 ? '' : 's'} waiting for a van.`) : ''}
        <div class="grid k4">${kpi('Open', fmt.num(k.open))}${kpi('Done (30 days)', fmt.num(k.done30d), `${fmt.num(k.kwh30d, 1)} kWh`)}
          ${kpi('Revenue (30 days)', fmt.money(k.revenue30dMinor, cur))}${kpi('Median time to arrive', k.medianArrivalMin == null ? '—' : `${fmt.num(k.medianArrivalMin)} min`, `${fmt.num(k.cancelled30d)} cancelled`)}</div>
        <div class="card section"><header><h3>Requests</h3><span class="cell-sub">Open, and the last day's</span></header><div data-r></div></div>
        <div class="card section"><header><h3>Vans</h3></header><div data-v></div></div>`;
      table($('[data-r]', body), { columns: [{ label: 'Request', render: (r) => `<b>${esc(r.number)}</b><div class="cell-sub">${esc(fmt.time(r.createdAt))}</div>` },
        { label: 'Where', render: (r) => `${esc(r.address ?? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}`)}<div class="cell-sub">${esc(r.vehicle ?? '')} ${esc(r.plate ?? '')}</div>` },
        { label: 'Status', render: (r) => `${tag(...ST[r.status])}${r.status === 'requested' ? `<div class="cell-sub">${fmt.num(r.waitingMin)} min</div>` : r.van ? `<div class="cell-sub">${esc(r.van)}</div>` : ''}` },
        { label: 'kWh', num: true, render: (r) => fmt.num(r.kwhDelivered ?? r.kwhRequested, 1) }, { label: 'Amount', num: true, render: (r) => fmt.money(r.amountMinor ?? r.quoteMinor, r.currency) }],
      rows: d.requests, empty: 'No requests.', onRow: (r) => openReq(r.id) });
      table($('[data-v]', body), { columns: [{ label: 'Van', render: (v) => `<b>${esc(v.name)}</b> ${esc(v.plate ?? '')}<div class="cell-sub">${esc(v.technician ?? '')}</div>` },
        { label: 'Status', render: (v) => tag(...(VAN[v.status] ?? ['t-mute', v.status])) }, { label: 'Energy left', num: true, render: (v) => `${fmt.num(v.kwhLeft, 1)} / ${fmt.num(v.kwhCapacity, 1)} kWh` },
        { label: 'Charger', num: true, render: (v) => `${fmt.num(v.kwOutput, 0)} kW` }, { label: 'Last position', render: (v) => (v.lat != null ? `<a href="${map(v.lat, v.lon)}" target="_blank" rel="noopener">${icon('external')} Map</a><div class="cell-sub">${v.locatedAt ? esc(fmt.time(v.locatedAt)) : 'base'}</div>` : '—') }],
      rows: d.vans, empty: 'No vans yet.', onRow: canWrite ? vanModal : undefined });
    };

    $('[data-settings]', root)?.addEventListener('click', () => d && settingsModal());
    $('[data-van]', root)?.addEventListener('click', () => vanModal(null));
    $('[data-take]', root)?.addEventListener('click', () => d && takeModal());
    await draw();
    timer = setInterval(() => { if (!document.querySelector('.modal')) draw().catch(() => {}); }, 30_000);
    return () => clearInterval(timer);
  },
});
