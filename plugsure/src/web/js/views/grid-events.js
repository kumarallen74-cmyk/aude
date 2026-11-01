import { $, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, copy, sites as loadSites, options } from '../core.js';

/**
 * (v1.43.0) Assets & energy → Grid events: demand-response programmes (a webhook the grid operator or an aggregator
 * posts events to, or an OpenADR 3 server PlugSure polls), their events, what the load manager delivered and the
 * incentive; opting a site's event out.
 */

const STATE = { upcoming: ['t-info', 'upcoming'], active: ['t-warn', 'active'], completed: ['t-ok', 'completed'], cancelled: ['t-mute', 'cancelled'], opted_out: ['t-mute', 'opted out'] };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const local = (iso) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');

registerView('grid-events', {
  title: 'Grid events',
  icon: 'bolt',
  group: 'assets',
  order: 13,
  perm: 'smartcharging:read',
  async render(root) {
    const canWrite = state.can('smartcharging:write');
    root.innerHTML = pageHead('Grid events',
      'Demand response: when the grid operator or an aggregator asks your sites to cut or cap their power, the load manager holds charging to it for the event and measures what it delivered for the incentive claim.',
      canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} Add a programme</button>` : '') + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    const siteList = (await loadSites()).filter((s) => !s.archived_at);
    let ps = [], evs = [];
    const draw = async () => {
      try { [ps, evs] = await Promise.all([api('/v1/dr/programs').then((r) => r.programs), api('/v1/dr/events').then((r) => r.events)]); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const active = evs.filter((e) => e.state === 'active');
      body.innerHTML = `${active.length ? callout('warn', `${active.length} event${active.length === 1 ? ' is' : 's are'} limiting charging now.`) : ''}
        <div class="card section"><header><h3>Programmes</h3></header><div data-programs></div></div>
        <div class="card section"><header><h3>Events</h3><span class="cell-sub">The last 90 days and what is coming. Measured by the load manager: the power the chargers asked for within the usual budget, against what they were given.</span></header><div data-events></div></div>`;
      table($('[data-programs]', body), {
        columns: [
          { label: 'Programme', render: (p) => `<div class="cell-title">${esc(p.name)}</div><div class="cell-sub">${p.kind === 'webhook' ? 'webhook' : `OpenADR 3 · ${esc(p.programRef ?? '')}`}${p.enabled ? '' : ' · off'}</div>` },
          { label: 'Sites', render: (p) => `<span class="cell-sub">${esc(p.siteIds.map((id) => siteList.find((s) => s.id === id)?.name ?? '…').join(', '))}</span>` },
          { label: 'Incentive', num: true, render: (p) => (p.incentiveMinorPerKwh == null ? '—' : `${fmt.money(p.incentiveMinorPerKwh, p.currency)}/kWh`) },
          { label: 'Connection', render: (p) => (p.kind === 'webhook' ? (p.tokenHint ? `key …${esc(p.tokenHint)}` : tag('t-warn', 'no key yet')) : p.lastError ? tag('t-crit', 'poll failed') : p.lastPollAt ? `polled ${esc(fmt.ago(p.lastPollAt))}` : tag('t-mute', 'not polled yet')) },
          { label: '', render: (p) => (canWrite ? `<div class="row" style="gap:4px;justify-content:flex-end">${p.kind === 'webhook' ? `<button class="btn sm" type="button" data-key="${esc(p.id)}">${icon('key')} Key</button>` : `<button class="btn sm" type="button" data-poll="${esc(p.id)}">${icon('refresh')} Poll</button>`}
              <button class="btn sm" type="button" data-manual="${esc(p.id)}">Add event</button><button class="btn sm" type="button" data-edit="${esc(p.id)}">Edit</button></div>` : '') },
        ],
        rows: ps, empty: 'No programmes yet. Add the one your grid operator or aggregator enrolled you in.',
      });
      table($('[data-events]', body), {
        columns: [
          { label: 'Event', render: (e) => `<div class="cell-title">${esc(fmt.time(e.startsAt))} – ${esc(fmt.time(e.endsAt))}</div><div class="cell-sub">${esc(e.program)} · ${esc(e.extId)}</div>` },
          { label: 'Asks', render: (e) => (e.limitKw != null ? `at most ${fmt.num(e.limitKw)} kW` : `${fmt.num(e.reducePct)}% less`) + `<div class="cell-sub">${esc(e.sites.map((s) => s.name).join(', '))}</div>` },
          { label: 'State', render: (e) => tag(...(STATE[e.state] ?? ['t-mute', e.state])) },
          { label: 'Delivered', num: true, render: (e) => (e.measured.length ? `${fmt.num(e.reducedKwh, 1)} kWh<div class="cell-sub">${e.avgReducedKw == null ? '' : `${fmt.num(e.avgReducedKw, 1)} kW on average`}</div>` : '<span class="muted">—</span>') },
          { label: 'Incentive', num: true, render: (e) => (e.incentiveMinor == null ? '—' : fmt.money(e.incentiveMinor, e.currency)) },
          { label: '', render: (e) => (canWrite && (e.state === 'upcoming' || e.state === 'active') ? `<button class="btn sm" type="button" data-optout="${esc(e.id)}">Opt out</button>` : '') },
        ],
        rows: evs, empty: 'No events.',
      });
    };
    const programForm = (p = null) => {
      modal({
        title: p ? `Edit ${p.name}` : 'Add a programme', size: 'lg',
        body: `<div class="form">
          ${field('Name', `<input name="name" value="${esc(p?.name ?? '')}" placeholder="PLN peak relief">`)}
          ${field('Connection', `<select name="kind"${p ? ' disabled' : ''}><option value="webhook"${p?.kind !== 'openadr3' ? ' selected' : ''}>Webhook: they post events to PlugSure</option><option value="openadr3"${p?.kind === 'openadr3' ? ' selected' : ''}>OpenADR 3: PlugSure polls their server</option></select>`)}
          <div class="field full"><label>Sites</label><div class="row" style="gap:10px;flex-wrap:wrap">${siteList.map((s) => `<label class="row" style="gap:4px"><input type="checkbox" name="site" value="${esc(s.id)}"${p?.siteIds.includes(s.id) ? ' checked' : ''}> ${esc(s.name)}</label>`).join('')}</div></div>
          ${field('Incentive per kWh (minor units)', `<input name="incentiveMinorPerKwh" type="number" min="0" step="1" value="${esc(p?.incentiveMinorPerKwh ?? '')}">`, { opt: true })}
          ${field('Currency', `<input name="currency" value="${esc(p?.currency ?? '')}" maxlength="3" placeholder="the sites' currency">`, { opt: true })}
          <div data-adr class="full form" style="padding:0">
            ${field('OpenADR server (VTN) URL', `<input name="vtnUrl" value="${esc(p?.vtnUrl ?? '')}" placeholder="https://vtn.example.com/openadr3">`)}
            ${field('Token URL (OAuth 2)', `<input name="tokenUrl" value="${esc(p?.tokenUrl ?? '')}" placeholder="https://vtn.example.com/oauth/token">`)}
            ${field('Programme ID on the server', `<input name="programRef" value="${esc(p?.programRef ?? '')}">`)}
            ${field('Client ID', `<input name="clientId" value="${esc(p?.clientId ?? '')}">`)}
            ${field('Client secret', `<input name="clientSecret" type="password" placeholder="${p?.hasClientSecret ? 'kept (leave empty to keep)' : ''}">`)}
          </div>
          <label class="row full" style="gap:8px"><input type="checkbox" name="enabled"${p?.enabled === false ? '' : ' checked'}> The programme is on</label>
        </div>`,
        onMount(mc) {
          const sync = () => { $('[data-adr]', mc.el).hidden = $('[name=kind]', mc.el).value !== 'openadr3'; };
          $('[name=kind]', mc.el).addEventListener('change', sync); sync();
        },
        actions: [
          ...(p ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/dr/programs/${p.id}`, { method: 'PUT', body: { archive: true } }); toast('Archived.', 'ok'); draw(); }) }] : []),
          { label: 'Cancel' },
          { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
            const v = (n) => $(`[name=${n}]`, mc.el).value.trim();
            const b = { name: v('name'), kind: $('[name=kind]', mc.el).value, siteIds: [...mc.el.querySelectorAll('[name=site]:checked')].map((x) => x.value),
              incentiveMinorPerKwh: v('incentiveMinorPerKwh') === '' ? null : Number(v('incentiveMinorPerKwh')), currency: v('currency'), enabled: $('[name=enabled]', mc.el).checked };
            if (b.kind === 'openadr3') Object.assign(b, { vtnUrl: v('vtnUrl'), tokenUrl: v('tokenUrl'), programRef: v('programRef'), clientId: v('clientId'), ...(v('clientSecret') ? { clientSecret: v('clientSecret') } : {}) });
            const r = await api(p ? `/v1/dr/programs/${p.id}` : '/v1/dr/programs', { method: p ? 'PUT' : 'POST', body: b });
            toast('Saved.', 'ok'); await draw();
            if (!p && r.kind === 'webhook') showKey(r.id);
          }) },
        ],
      });
    };
    const showKey = async (id) => {
      let k;
      try { k = await api(`/v1/dr/programs/${id}/key`, { method: 'POST' }); } catch (e) { toast(e.message, 'crit'); return; }
      const url = `${location.origin}${k.url}`;
      modal({
        title: 'The programme\'s key',
        body: `${callout('warn', 'Shown once. Give it to the grid operator or aggregator; a new key stops this one.')}
          <dl class="kv"><dt>Post events to</dt><dd class="mono">${esc(url)}</dd><dt>Authorization</dt><dd class="mono">Bearer ${esc(k.key)}</dd></dl>
          <p class="cell-sub">Body: <span class="mono">{"id": "evt-1", "start": "2026-11-02T17:00:00+07:00", "end": "2026-11-02T19:00:00+07:00", "limitKw": 120}</span> — or <span class="mono">reducePct</span> instead of limitKw; <span class="mono">"status": "cancelled"</span> to call it off. See deploy/DEMAND-RESPONSE.md.</p>`,
        actions: [{ label: 'Copy the key', onClick: () => { copy(k.key); return false; } }, { label: 'Done', kind: 'primary' }],
      });
      draw();
    };
    const manual = (p) => {
      const start = new Date(Date.now() + 3_600_000), end = new Date(start.getTime() + 2 * 3_600_000);
      modal({
        title: `Add an event to ${p.name}`,
        body: `<div class="form">
          ${field('Starts', `<input name="startsAt" type="datetime-local" value="${local(start.toISOString())}">`)}
          ${field('Ends', `<input name="endsAt" type="datetime-local" value="${local(end.toISOString())}">`)}
          ${field('Limit (kW, the sites together)', '<input name="limitKw" type="number" min="0" step="0.1">', { help: 'Or a reduction below.' })}
          ${field('Reduction (%)', '<input name="reducePct" type="number" min="1" max="100">')}
          ${field('Note', '<input name="note" placeholder="Phone call from the PLN control room">', { opt: true, full: true })}
        </div>`,
        actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name=${n}]`, mc.el).value;
          await api(`/v1/dr/programs/${p.id}/manual-event`, { method: 'POST', body: { startsAt: new Date(v('startsAt')).toISOString(), endsAt: new Date(v('endsAt')).toISOString(),
            limitKw: v('limitKw') === '' ? null : Number(v('limitKw')), reducePct: v('reducePct') === '' ? null : Number(v('reducePct')), note: v('note') } });
          toast('Added: charging will be held to it.', 'ok'); draw();
        }) }],
      });
    };
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.matches('[data-add]')) return programForm();
      if (b.dataset.edit) return programForm(ps.find((p) => p.id === b.dataset.edit));
      if (b.dataset.key) {
        return modal({ title: 'A new key?', body: '<p>The current key stops working at once: give the new one to the grid operator or aggregator.</p>',
          actions: [{ label: 'Cancel' }, { label: 'New key', kind: 'primary', onClick: () => { showKey(b.dataset.key); } }] });
      }
      if (b.dataset.manual) return manual(ps.find((p) => p.id === b.dataset.manual));
      if (b.dataset.poll) {
        b.disabled = true;
        try { const r = await api(`/v1/dr/programs/${b.dataset.poll}/poll`, { method: 'POST' }); toast(r.program?.lastError ? `Poll failed: ${r.program.lastError}` : `${r.events} event${r.events === 1 ? '' : 's'} read.`, r.program?.lastError ? 'crit' : 'ok'); } catch (err) { toast(err.message, 'crit'); }
        b.disabled = false; return draw();
      }
      if (b.dataset.optout) {
        return modal({ title: 'Opt out of this event?', body: `<p>Charging at its sites is no longer held to it. The grid operator may not pay the incentive for it.</p>${field('Why', '<input name="note" placeholder="A fleet must leave fully charged">', { opt: true })}`,
          actions: [{ label: 'Cancel' }, { label: 'Opt out', kind: 'danger', onClick: guard(async (mc) => { await api(`/v1/dr/events/${b.dataset.optout}/opt-out`, { method: 'POST', body: { note: $('[name=note]', mc.el).value } }); toast('Opted out.', 'ok'); draw(); }) }] });
      }
    });
    await draw();
  },
});
