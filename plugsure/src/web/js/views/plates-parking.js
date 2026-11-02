import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options, copy } from '../core.js';

/**
 * (v1.46.0) Assets & energy → Plates & parking: number-plate cameras at the car park, each car's stay (in, charging,
 * out), the parking fee for staying past the grace after charging, the barrier (opened for known cars, everyone or
 * never), and starting the charger when a known car plugs in. Known cars: fleet vehicles and residents or staff with a
 * plate (Private charging).
 */

const VST = { open: ['t-info', 'parked'], closed: ['t-warn', 'left'], paid: ['t-ok', 'paid'], waived: ['t-mute', 'waived'] };
const POLICY = { none: 'never', known: 'known cars', everyone: 'everyone' };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const mins = (m) => (m == null ? '—' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);

registerView('plates-parking', {
  title: 'Plates & parking',
  icon: 'camera',
  group: 'assets',
  order: 17,
  perm: 'site:read',
  async render(root) {
    const canWrite = state.can('site:write');
    root.innerHTML = pageHead('Plates & parking',
      'Number-plate cameras at the car park: each car\'s stay and charging, a fee for staying long after charging, the barrier, and charging that starts by itself when a known car plugs in.',
      canWrite ? `<button class="btn" type="button" data-rules>${icon('gear')} Site rules</button><button class="btn primary" type="button" data-add>${icon('plus')} Add a camera</button>` : '')
      + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    let sites = [], cams = [];
    const filt = { status: '', siteId: '', plate: '' };

    const showKey = (key) => modal({ title: 'The camera\'s address',
      body: `${callout('warn', 'Shown once. Set it in the camera (or its software) as the address to post each plate read to.')}
        <div style="display:flex;gap:6px;margin-top:8px"><input readonly value="${esc(`${location.origin}/v1/anpr/events/${key}`)}" style="flex:1"><button class="btn" type="button" data-cpy>${icon('copy')} Copy</button></div>
        <p class="cell-sub" style="margin-top:8px">POST JSON: {"plate": "B 1234 XYZ", "confidence": 93, "direction": "entry"} (direction is optional; a list of reads also works).</p>`,
      onMount: (mc) => $('[data-cpy]', mc.el).addEventListener('click', () => copy(`${location.origin}/v1/anpr/events/${key}`)) });

    const camModal = (c) => modal({ title: c ? `Edit ${c.name}` : 'Add a camera', size: 'lg',
      body: `<div class="form grid2">${field('Name', `<input name="name" maxlength="80" value="${esc(c?.name ?? '')}" placeholder="Entrance gate">`)}
        ${field('Site', `<select name="site">${options(sites.map((s) => ({ value: s.id, label: s.name })), c?.siteId ?? '')}</select>`)}
        ${field('Sees', `<select name="dir">${options([{ value: 'entry', label: 'Cars coming in' }, { value: 'exit', label: 'Cars going out' }, { value: 'both', label: 'Both (in or out from the open stay)' }], c?.direction ?? 'both')}</select>`)}
        ${field('Opens the barrier for', `<select name="policy">${options(Object.entries(POLICY).map(([value, label]) => ({ value, label })), c?.gatePolicy ?? 'none')}</select>`)}
        ${field('Barrier controller address', `<input name="url" maxlength="500" value="${esc(c?.gateUrl ?? '')}" placeholder="https://gate.example.com/open">`, { help: 'PlugSure POSTs {action: "open", plate, direction, camera}.' })}
        ${field('Its Authorization header', `<input name="auth" maxlength="2000" placeholder="${c?.gateHasAuth ? 'Kept (type to replace)' : 'Optional'}">`)}
        ${c ? field('', `<label><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}> On</label>`) : ''}</div>`,
      actions: [...(c ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/anpr/cameras/${c.id}`, { method: 'PUT', body: { archive: true } }); draw(); }) },
        { label: 'New key', onClick: guard(async () => { const r = await api(`/v1/anpr/cameras/${c.id}`, { method: 'PUT', body: { rotateKey: true } }); showKey(r.key); draw(); }) }] : []),
        { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
          const b = { name: v('name'), siteId: v('site'), direction: v('dir'), gatePolicy: v('policy'), gateUrl: v('url') || null, ...(v('auth') ? { gateAuthorization: v('auth') } : {}), ...(c ? { enabled: $('[name="enabled"]', mc.el).checked } : {}) };
          const r = await api(c ? `/v1/anpr/cameras/${c.id}` : '/v1/anpr/cameras', { method: c ? 'PUT' : 'POST', body: b });
          if (r.key) showKey(r.key); else toast('Saved.', 'ok');
          draw();
        }) }] });

    const rulesModal = () => modal({ title: 'Parking rules', size: 'lg',
      body: `<div class="form grid2">${field('Site', `<select name="site">${options(sites.map((s) => ({ value: s.id, label: s.name })), sites[0]?.id ?? '')}</select>`)}
        ${field('Free after charging ends (minutes)', '<input name="grace" type="number" min="0" max="1440" step="1" placeholder="e.g. 15">')}
        ${field('Fee per started hour after that (minor units)', '<input name="fee" type="number" min="0" step="1" placeholder="0: no fee">', { help: 'Residents and staff do not pay it.' })}
        ${field('Alert when a car stays longer than (minutes)', '<input name="max" type="number" min="10" max="10080" step="1" placeholder="Empty: never">')}
        ${field('', '<label><input type="checkbox" name="auto"> A known car starts charging when it plugs in (its card on file, one car waiting)</label>', { full: true })}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
        const v = (n) => $(`[name="${n}"]`, mc.el).value;
        await api(`/v1/sites/${v('site')}/parking`, { method: 'PUT', body: { graceMinutes: v('grace') === '' ? null : Number(v('grace')), feePerHourMinor: v('fee') === '' ? null : Number(v('fee')), maxMinutes: v('max') === '' ? null : Number(v('max')), plateAutostart: $('[name="auto"]', mc.el).checked } });
        toast('Saved.', 'ok');
      }) }] });

    const draw = async () => {
      let visits, events;
      const qs = new URLSearchParams(Object.entries(filt).filter(([, v]) => v)).toString();
      try {
        [{ cameras: cams }, { visits }, { events }, sites] = await Promise.all([api('/v1/anpr/cameras'), api(`/v1/parking/visits${qs ? `?${qs}` : ''}`), api('/v1/anpr/events?limit=50'),
          api('/v1/sites').then((r) => (Array.isArray(r) ? r : r.sites ?? []))]);
      } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const parked = visits.filter((v) => v.status === 'open').length;
      const owed = visits.filter((v) => v.status === 'closed' && v.feeMinor > 0);
      body.innerHTML = `<div class="grid k4">${kpi('Cameras', fmt.num(cams.length), `${fmt.num(cams.filter((c) => c.enabled).length)} on`)}${kpi('Parked now', fmt.num(parked))}
          ${kpi('Fees to settle', fmt.num(owed.length), owed.length ? fmt.money(owed.reduce((a, v) => a + v.feeMinor, 0), owed[0].currency) : '')}${kpi('Reads (latest)', fmt.num(events.length))}</div>
        <div class="card section"><header><h3>Cameras</h3></header><div data-c></div></div>
        <div class="card section"><header><h3>Stays</h3><div class="right" style="display:flex;gap:6px">
            <select data-f="siteId" style="width:auto">${options(sites.map((s) => ({ value: s.id, label: s.name })), filt.siteId, { blank: 'All sites' })}</select>
            <select data-f="status" style="width:auto">${options(Object.entries(VST).map(([value, [, label]]) => ({ value, label })), filt.status, { blank: 'Any' })}</select>
            <input data-f="plate" placeholder="Plate" value="${esc(filt.plate)}" style="width:110px"></div></header><div data-v></div></div>
        <div class="card section"><header><h3>Latest reads</h3></header><div data-e></div></div>`;
      table($('[data-c]', body), { columns: [{ label: 'Camera', render: (c) => `<b>${esc(c.name)}</b><div class="cell-sub">${esc(c.site ?? '')}</div>` },
        { label: 'Sees', render: (c) => esc(c.direction) }, { label: 'Barrier', render: (c) => esc(POLICY[c.gatePolicy] ?? c.gatePolicy) },
        { label: 'Last read', render: (c) => (c.lastSeenAt ? esc(fmt.time(c.lastSeenAt)) : '—') }, { label: '', render: (c) => (c.enabled ? tag('t-ok', 'on') : tag('t-mute', 'off')) }],
      rows: cams, empty: 'No cameras yet.', onRow: canWrite ? (c) => camModal(c) : undefined });
      table($('[data-v]', body), { columns: [{ label: 'Plate', render: (v) => `<b>${esc(v.plate)}</b>${v.who ? `<div class="cell-sub">${esc(v.who)}</div>` : ''}` },
        { label: 'Site', key: 'site' }, { label: 'In', render: (v) => esc(fmt.time(v.enteredAt)) }, { label: 'Out', render: (v) => (v.exitedAt ? esc(fmt.time(v.exitedAt)) : '—') },
        { label: 'Charging', render: (v) => `${mins(v.chargingMinutes)}${v.chargedKwh ? `<div class="cell-sub">${fmt.num(v.chargedKwh, 1)} kWh${v.autostarted ? ' · started by plate' : ''}</div>` : ''}` },
        { label: 'Over', render: (v) => mins(v.overstayMinutes) }, { label: 'Fee', num: true, render: (v) => (v.feeMinor ? fmt.money(v.feeMinor, v.currency) : '—') },
        { label: 'Status', render: (v) => tag(...(VST[v.status] ?? ['t-mute', v.status])) },
        ...(canWrite ? [{ label: '', render: (v) => (v.status === 'closed' && v.feeMinor > 0 ? `<button class="btn sm" data-settle="paid" data-id="${v.id}">Paid</button> <button class="btn sm" data-settle="waived" data-id="${v.id}">Waive</button>` : '') }] : [])],
      rows: visits, empty: 'No stays yet.' });
      table($('[data-e]', body), { columns: [{ label: 'When', render: (e) => esc(fmt.time(e.seenAt)) }, { label: 'Camera', render: (e) => `${esc(e.camera)}<div class="cell-sub">${esc(e.site)}</div>` },
        { label: 'Plate', render: (e) => `<b>${esc(e.plate)}</b>${e.confidence != null ? `<div class="cell-sub">${fmt.num(e.confidence)} % sure</div>` : ''}` }, { label: 'Way', key: 'direction' },
        { label: 'Known', render: (e) => (e.matched === 'vehicle' ? tag('t-info', 'fleet') : e.matched === 'member' ? tag('t-info', 'resident/staff') : '—') },
        { label: 'Barrier', render: (e) => (e.gateOpened == null ? '—' : e.gateOpened ? tag('t-ok', 'opened') : tag('t-crit', 'failed', e.gateError ?? '')) }],
      rows: events, empty: 'No reads yet.' });
      $$('[data-settle]', body).forEach((b) => b.addEventListener('click', async () => { try { await api(`/v1/parking/visits/${b.dataset.id}/${b.dataset.settle}`, { method: 'POST' }); draw(); } catch (e) { toast(e.message, 'crit'); } }));
      $$('[data-f]', body).forEach((el) => el.addEventListener('change', () => { filt[el.dataset.f] = el.value.trim(); draw(); }));
    };

    $('[data-add]', root)?.addEventListener('click', () => (sites.length ? camModal(null) : toast('Add a site first.', 'warn')));
    $('[data-rules]', root)?.addEventListener('click', rulesModal);
    await draw();
  },
});
