import { $, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options, copy } from '../core.js';

/**
 * (v1.44.0) Assets & energy → Depot charging: fleet vehicles with their usual departure and target, each active
 * session's departure and the load manager's plan (on track, deferred to off-peak, at risk, ready, missed), and the
 * sites where depot scheduling is on.
 */

const STATE = { on_track: ['t-ok', 'on track'], deferred: ['t-info', 'deferred to off-peak'], at_risk: ['t-crit', 'at risk'], ready: ['t-ok', 'ready'], missed: ['t-crit', 'missed'] };
const SOURCE = { vehicle: 'the vehicle', ocpp: 'the car', console: 'set here' };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const local = (iso) => new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

registerView('depot-charging', {
  title: 'Depot charging',
  icon: 'plug',
  group: 'assets',
  order: 14,
  perm: 'smartcharging:read',
  async render(root) {
    const canWrite = state.can('smartcharging:write');
    root.innerHTML = pageHead('Depot charging',
      'For fleets that must leave charged: give each vehicle its usual departure and target, or set a session\'s departure. At a depot site the load manager plans every session to be ready in time, charging off-peak when there is time and first when there is not.',
      canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} Add a vehicle</button>` : '') + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    let d, tl = { connections: [], latest: [] };
    const vehicleModal = async (v) => {
      const [cards, fleets] = await Promise.all([
        state.can('token:read') ? api('/v1/tokens?limit=2000').catch(() => []) : [],
        state.can('invoice:read') ? api('/v1/fleet-accounts').then((r) => r.accounts ?? []).catch(() => []) : [],
      ]);
      const cardOpts = (Array.isArray(cards) ? cards : cards.tokens ?? []).filter((t) => t.status !== 'Blocked' || t.id === v?.tokenId)
        .map((t) => ({ value: t.id, label: `${t.uid}${t.holder_name || t.fleet_name ? ` · ${t.holder_name || t.fleet_name}` : ''}` }));
      if (v?.tokenId && !cardOpts.some((o) => o.value === v.tokenId)) cardOpts.unshift({ value: v.tokenId, label: v.tokenUid ?? v.tokenId });
      modal({ title: v ? `Edit ${v.name}` : 'Add a vehicle', size: 'lg',
        body: `<div class="form grid2">${field('Name', `<input name="name" maxlength="80" required value="${esc(v?.name ?? '')}" placeholder="Bus 12">`)}
          ${field('Plate', `<input name="plate" maxlength="20" value="${esc(v?.plate ?? '')}">`)}
          ${field('Card it charges with', `<select name="tokenId">${options(cardOpts, v?.tokenId ?? '', { blank: 'None' })}</select>`, { help: 'A session started with this card gets the vehicle\'s next departure.' })}
          ${field('Fleet account', `<select name="fleetAccountId">${options(fleets.map((f) => ({ value: f.id, label: f.name })), v?.fleetAccountId ?? '', { blank: 'None' })}</select>`)}
          ${field('Battery (kWh)', `<input name="batteryKwh" type="number" min="1" max="2000" step="0.1" value="${v?.batteryKwh ?? ''}">`)}
          ${field('Usual departure', `<input name="departureTime" type="time" value="${esc(v?.departureTime ?? '')}">`, { help: 'The site\'s time.' })}
          ${field('Target (kWh to deliver)', `<input name="targetKwh" type="number" min="1" max="2000" step="0.1" value="${v?.targetKwh ?? ''}">`)}
          ${field('or target state of charge (%)', `<input name="targetSocPct" type="number" min="10" max="100" step="1" value="${v?.targetSocPct ?? ''}">`, { help: 'Needs the battery size; used when the car or its telematics reports the state of charge.' })}
          ${tl.connections.length ? `${field('Telematics', `<select name="tconn">${options(tl.connections.map((c) => ({ value: c.id, label: c.name })), v?.telematicsConnectionId ?? '', { blank: 'None' })}</select>`)}
            ${field('Its id there (often the VIN)', `<input name="tid" maxlength="80" value="${esc(v?.telematicsId ?? '')}">`)}` : ''}</div>`,
        actions: [...(v ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/fleet-vehicles/${v.id}`, { method: 'PUT', body: { archive: true } }); toast('Archived.', 'ok'); draw(); }) }] : []),
          { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
            const g = (n) => $(`[name="${n}"]`, mc.el).value.trim();
            const num = (n) => (g(n) === '' ? null : Number(g(n)));
            const b = { name: g('name'), plate: g('plate') || null, tokenId: g('tokenId') || null, fleetAccountId: g('fleetAccountId') || null, batteryKwh: num('batteryKwh'), departureTime: g('departureTime') || null, targetKwh: num('targetKwh'), targetSocPct: num('targetSocPct') };
            const saved = await api(v ? `/v1/fleet-vehicles/${v.id}` : '/v1/fleet-vehicles', { method: v ? 'PUT' : 'POST', body: b });
            if (tl.connections.length && (g('tconn') !== (v?.telematicsConnectionId ?? '') || g('tid') !== (v?.telematicsId ?? ''))) {
              await api(`/v1/fleet-vehicles/${saved.id}/telematics`, { method: 'PUT', body: { connectionId: g('tconn') || null, telematicsId: g('tid') || null } });
            }
            toast('Saved.', 'ok'); draw();
          }) }] });
    };
    const departureModal = (s) => {
      const dflt = s.departureAt ?? new Date(Date.now() + 8 * 3_600_000).toISOString();
      modal({ title: `Departure · ${s.charger}`,
        body: `<div class="form">${field('Leaves at', `<input name="at" type="datetime-local" value="${esc(local(dflt))}">`)}
          ${field('Energy it needs in all (kWh)', `<input name="kwh" type="number" min="0.1" max="2000" step="0.1" value="${s.neededKwh ?? ''}">`, { help: `Delivered so far: ${fmt.num(s.deliveredKwh, 1)} kWh.` })}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          await api(`/v1/depot/sessions/${s.sessionId}/departure`, { method: 'PUT', body: { departureAt: new Date($('[name="at"]', mc.el).value).toISOString(), neededKwh: Number($('[name="kwh"]', mc.el).value) } });
          toast('Departure set. The next control-loop run plans it.', 'ok'); draw();
        }) }] });
    };
    const draw = async () => {
      try { [d, tl] = await Promise.all([api('/v1/depot'), api('/v1/telematics/connections').catch(() => ({ connections: [], latest: [] }))]); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const siteName = Object.fromEntries(d.sites.map((s) => [s.id, s.name]));
      const n = (st) => d.sessions.filter((s) => s.state === st).length;
      const on = d.sites.filter((s) => s.depotScheduling);
      body.innerHTML = `${n('at_risk') ? callout('crit', `${n('at_risk')} vehicle${n('at_risk') === 1 ? '' : 's'} will not be ready in time even at full power.`) : ''}
        <div class="grid k4">${kpi('Planned', fmt.num(d.sessions.length), 'sessions with a departure')}${kpi('At risk', fmt.num(n('at_risk') + n('missed')), 'not ready in time', n('at_risk') + n('missed') ? 'crit' : '')}
          ${kpi('Deferred', fmt.num(n('deferred')), 'waiting for off-peak')}${kpi('Depot sites', fmt.num(on.length), `of ${fmt.num(d.sites.length)}`)}</div>
        <div class="card section"><header><h3>Sessions with a departure</h3></header><div data-ss></div></div>
        ${d.without.length ? '<div class="card section"><header><h3>Charging without a departure</h3><span class="cell-sub">At depot sites; planned as usual until a departure is set</span></header><div data-wo></div></div>' : ''}
        <div class="card section"><header><h3>Vehicles</h3></header><div data-vs></div></div>
        <div class="card section"><header><h3>Telematics</h3><span class="cell-sub">Battery level and position from the car maker's or the fleet's platform</span>
          ${canWrite ? `<button class="btn sm right" type="button" data-tadd style="white-space:nowrap;flex:none">${icon('plus')} Connect</button>` : ''}</header><div data-tl></div></div>
        <div class="card section"><header><h3>Sites</h3><span class="cell-sub">Depot scheduling on a site plans its sessions by departure; the site needs load management</span></header><div data-st></div></div>`;
      const departCell = (s) => `${esc(fmt.time(s.departureAt))}<div class="cell-sub">from ${esc(SOURCE[s.source] ?? s.source)}</div>`;
      table($('[data-ss]', body), { columns: [
        { label: 'Vehicle', render: (s) => `<div class="cell-title">${esc(s.vehicle ?? s.charger)}</div><div class="cell-sub">${esc(siteName[s.siteId] ?? '')}${s.vehicle ? ` · ${esc(s.charger)}` : ''}${s.plate ? ` · ${esc(s.plate)}` : ''}</div>` },
        { label: 'Leaves', render: departCell },
        { label: 'Energy', num: true, render: (s) => `${fmt.num(s.deliveredKwh, 1)} / ${fmt.num(s.neededKwh, 1)} kWh${s.socPct == null ? '' : `<div class="cell-sub">${s.socPct}% now</div>`}` },
        { label: 'Plan', render: (s) => tag(...(STATE[s.state] ?? ['t-mute', s.state])) + (s.requiredKw ? `<div class="cell-sub">needs ${fmt.num(s.requiredKw, 1)} kW</div>` : '') },
        { label: 'Ready by', render: (s) => (s.etaAt ? `${esc(fmt.time(s.etaAt))}${s.late ? `<div>${tag('t-crit', 'late')}</div>` : ''}` : '<span class="muted">—</span>') },
        { label: '', render: (s) => (canWrite ? `<button class="btn sm" type="button" data-dep="${esc(s.sessionId)}">Change</button>` : '') },
      ], rows: d.sessions, empty: 'No active session has a departure.' });
      if (d.without.length) table($('[data-wo]', body), { columns: [
        { label: 'Charger', render: (s) => `<div class="cell-title">${esc(s.charger)}</div><div class="cell-sub">${esc(siteName[s.siteId] ?? '')}</div>` },
        { label: 'Started', render: (s) => esc(fmt.time(s.startedAt)) }, { label: 'Delivered', num: true, render: (s) => `${fmt.num(s.deliveredKwh, 1)} kWh` },
        { label: '', render: (s) => (canWrite ? `<button class="btn sm" type="button" data-dep="${esc(s.sessionId)}">Set departure</button>` : '') },
      ], rows: d.without });
      table($('[data-vs]', body), { columns: [
        { label: 'Vehicle', render: (v) => `<div class="cell-title">${esc(v.name)}</div><div class="cell-sub">${esc([v.plate, v.fleet].filter(Boolean).join(' · ') || '—')}</div>` },
        { label: 'Card', render: (v) => (v.tokenUid ? `<span class="mono">${esc(v.tokenUid)}</span>` : '<span class="muted">none</span>') },
        { label: 'Battery', num: true, render: (v) => (v.batteryKwh ? `${fmt.num(v.batteryKwh, 1)} kWh` : '—') },
        { label: 'Usual departure', render: (v) => (v.departureTime ? esc(v.departureTime) : '<span class="muted">none</span>') },
        { label: 'Target', render: (v) => (v.targetKwh ? `${fmt.num(v.targetKwh, 1)} kWh` : v.targetSocPct ? `${v.targetSocPct}%` : '—') },
        { label: 'Battery now', render: (v) => (v.socPct == null ? '<span class="muted">—</span>' : `${fmt.num(v.socPct, 0)}%${v.rangeKm != null ? ` · ${fmt.num(v.rangeKm)} km` : ''}<div class="cell-sub">${esc(fmt.time(v.readingAt))}</div>`) },
      ], rows: d.vehicles, empty: 'No vehicles yet.', onRow: canWrite ? (v) => vehicleModal(v) : undefined });
      table($('[data-tl]', body), { columns: [
        { label: 'Platform', render: (c) => `<div class="cell-title">${esc(c.name)}</div><div class="cell-sub">${c.kind === 'webhook' ? `posts to PlugSure${c.keyPrefix ? ` · key <span class="mono">${esc(c.keyPrefix)}…</span>` : ''}` : `read every ${c.pollMinutes} min`}</div>` },
        { label: 'Vehicles', num: true, render: (c) => fmt.num(c.vehicles) },
        { label: 'Last reading', render: (c) => (c.lastSeenAt ? esc(fmt.time(c.lastSeenAt)) : '<span class="muted">none yet</span>') + (c.lastError ? `<div>${tag('t-crit', 'error')} <span class="cell-sub">${esc(c.lastError)}</span></div>` : '') },
        { label: '', render: (c) => (canWrite && c.kind === 'poll' ? `<button class="btn sm" type="button" data-tpoll="${esc(c.id)}">Read now</button>` : '') },
      ], rows: tl.connections, empty: 'No telematics platform connected.', onRow: canWrite ? (c) => tlModal(c) : undefined });
      table($('[data-st]', body), { columns: [
        { label: 'Site', render: (s) => esc(s.name) },
        { label: 'Depot scheduling', render: (s) => (canWrite ? `<label class="row" style="gap:6px"><input type="checkbox" data-site="${esc(s.id)}" ${s.depotScheduling ? 'checked' : ''}> ${s.depotScheduling ? 'on' : 'off'}</label>` : s.depotScheduling ? tag('t-ok', 'on') : tag('t-mute', 'off')) },
      ], rows: d.sites, empty: 'No sites.' });
    };
    const FIELDS = [['list', 'Where the vehicles are (a list)', 'data.vehicles'], ['vehicleId', 'Vehicle id', 'vin'], ['socPct', 'State of charge', 'battery.soc'], ['rangeKm', 'Range (km)', 'battery.range_km'],
      ['lat', 'Latitude', 'location.lat'], ['lon', 'Longitude', 'location.lon'], ['odometerKm', 'Odometer (km)', 'odometer'], ['charging', 'Charging (true/false)', 'charging'], ['at', 'Time of the reading', 'timestamp']];
    const tlModal = (c) => modal({ title: c ? `Edit ${c.name}` : 'Connect a telematics platform', size: 'lg', body: `<div class="form grid2">
        ${field('Name', `<input name="n" value="${esc(c?.name ?? '')}" placeholder="Fleet platform">`)}
        ${field('How', `<select name="k"><option value="webhook" ${c?.kind !== 'poll' ? 'selected' : ''}>The platform posts readings to PlugSure</option><option value="poll" ${c?.kind === 'poll' ? 'selected' : ''}>PlugSure reads the platform</option></select>`)}
        ${field('Platform URL (to read)', `<input name="u" value="${esc(c?.url ?? '')}" placeholder="https://api.example.com/v1/vehicles">`)}
        ${field('Authorization header', `<input name="a" placeholder="${c?.hasAuth ? 'kept (type to replace)' : 'Bearer …'}">`, { help: 'Sent when reading; kept sealed.' })}
        ${field('Read every (minutes)', `<input name="pm" type="number" min="5" max="1440" value="${c?.pollMinutes ?? 15}">`)}
        <label class="row" style="gap:6px;align-self:end"><input type="checkbox" name="frac" ${c?.fieldMap?.socIsFraction === 'true' ? 'checked' : ''}> State of charge is a share (0–1)</label>
        <div style="grid-column:1/-1"><b>Where each value is</b> <span class="cell-sub">dot paths in the platform's JSON</span></div>
        ${FIELDS.map(([k, label, ph]) => field(label, `<input name="f-${k}" value="${esc(c?.fieldMap?.[k] ?? '')}" placeholder="${esc(ph)}">`)).join('')}</div>`,
      actions: [...(c ? [{ label: 'Archive', kind: 'danger', onClick: async () => { try { await api(`/v1/telematics/connections/${c.id}`, { method: 'PUT', body: { archive: true } }); toast('Archived.', 'ok'); draw(); } catch (err) { toast(err.message, 'crit'); return false; } } },
          ...(c.kind === 'webhook' ? [{ label: 'New key', onClick: async () => { try { const r = await api(`/v1/telematics/connections/${c.id}`, { method: 'PUT', body: { rotateKey: true } }); showKey(r.key); draw(); } catch (err) { toast(err.message, 'crit'); return false; } } }] : [])] : []),
        { label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
          const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
          const fieldMap = Object.fromEntries(FIELDS.map(([k]) => [k, v(`f-${k}`)]));
          fieldMap.socIsFraction = $('[name="frac"]', mc.el).checked ? 'true' : '';
          const b = { name: v('n'), kind: v('k'), url: v('k') === 'poll' ? v('u') : null, pollMinutes: Number(v('pm')), fieldMap, ...(v('a') ? { authorization: v('a') } : {}) };
          try {
            const r = await api(c ? `/v1/telematics/connections/${c.id}` : '/v1/telematics/connections', { method: c ? 'PUT' : 'POST', body: b });
            if (r.key) showKey(r.key);
            toast('Saved.', 'ok'); draw();
          } catch (err) { toast(err.message, 'crit'); return false; }
        } }] });
    const showKey = (key) => modal({ title: 'The platform\'s address', body: `${callout('warn', 'Copy it now: the key is shown only once.')}<p>Have the platform post readings (JSON, one or a list) to:</p><pre class="mono" style="white-space:pre-wrap;word-break:break-all">${esc(location.origin)}/v1/telematics/ingest/${esc(key)}</pre>`,
      actions: [{ label: 'Copy', onClick: () => { copy(`${location.origin}/v1/telematics/ingest/${key}`); return false; } }, { label: 'Done', kind: 'primary' }] });
    body.addEventListener('click', async (e) => {
      const p = e.target.closest('[data-tpoll]');
      if (p) {
        e.stopPropagation(); p.disabled = true;
        try { const r = await api(`/v1/telematics/connections/${p.dataset.tpoll}/poll`, { method: 'POST' }); toast(`${r.readings} readings, ${r.stored} new${r.unknownVehicles ? `, ${r.unknownVehicles} for vehicles not linked` : ''}.`, 'ok'); draw(); } catch (err) { toast(err.message, 'crit'); p.disabled = false; }
        return;
      }
      if (e.target.closest('[data-tadd]')) { tlModal(null); return; }
    });
    body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dep]');
      if (!b) return;
      e.stopPropagation();
      const s = d.sessions.find((x) => x.sessionId === b.dataset.dep) ?? d.without.find((x) => x.sessionId === b.dataset.dep);
      if (s) departureModal(s);
    });
    body.addEventListener('change', async (e) => {
      const c = e.target.closest('[data-site]');
      if (!c) return;
      c.disabled = true;
      try { await api(`/v1/depot/sites/${c.dataset.site}`, { method: 'PUT', body: { enabled: c.checked } }); toast(c.checked ? 'Depot scheduling on.' : 'Depot scheduling off.', 'ok'); draw(); } catch (err) { toast(err.message, 'crit'); c.checked = !c.checked; c.disabled = false; }
    });
    $('[data-add]', root)?.addEventListener('click', () => vehicleModal(null).catch((err) => toast(err.message, 'crit')));
    await draw();
  },
});
