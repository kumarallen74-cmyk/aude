import { $, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, copy, sites as loadSites } from '../core.js';

/**
 * (v1.43.0) Maintain → Status page: the operator's public status page (each site's live availability, incidents,
 * planned maintenance; e-mail updates for subscribers) — its settings, and the incidents and maintenance posted to it.
 */

const IMPACT = { minor: ['t-info', 'minor'], major: ['t-warn', 'major'], critical: ['t-crit', 'critical'] };
const STATUS = { investigating: 't-warn', identified: 't-warn', monitoring: 't-info', resolved: 't-ok', scheduled: 't-info', in_progress: 't-warn', completed: 't-ok', cancelled: 't-mute' };
const NEXT = { incident: ['investigating', 'identified', 'monitoring', 'resolved'], maintenance: ['scheduled', 'in_progress', 'completed', 'cancelled'] };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

registerView('status-page', {
  title: 'Status page',
  icon: 'globe',
  group: 'maintain',
  order: 32,
  perm: 'site:read',
  async render(root) {
    const canWrite = state.can('site:write');
    root.innerHTML = pageHead('Status page',
      'A public page drivers and partners can check: each site\'s live availability, current incidents and planned maintenance. People can subscribe to e-mail updates.',
      canWrite ? `<button class="btn" type="button" data-maint>${icon('plus')} Plan maintenance</button><button class="btn primary" type="button" data-incident>${icon('plus')} Report an incident</button>` : '')
      + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    const siteList = (await loadSites()).filter((s) => !s.archived_at);
    let pg, list;
    const draw = async () => {
      try { [pg, list] = await Promise.all([api('/v1/status-page'), api('/v1/status-page/incidents').then((r) => r.incidents)]); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const url = `${location.origin}/status/${pg.slug}`;
      body.innerHTML = `<div class="card pad"><div class="row" style="gap:14px;flex-wrap:wrap;align-items:center">
          <div class="grow"><b>${esc(pg.title)}</b> ${pg.enabled ? tag('t-ok', 'public') : tag('t-mute', 'off')}
            <div class="cell-sub">${pg.enabled ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a> · ` : ''}${fmt.num(pg.subscribers)} subscriber${pg.subscribers === 1 ? '' : 's'} · ${pg.siteIds?.length ? `${pg.siteIds.length} site${pg.siteIds.length === 1 ? '' : 's'}` : 'every site'}</div></div>
          ${pg.enabled ? `<button class="btn sm" type="button" data-copy>${icon('copy')} Copy link</button>` : ''}
          ${canWrite ? `<button class="btn" type="button" data-settings>${icon('gear')} Settings</button>` : ''}</div></div>
        ${!pg.enabled ? callout('info', 'The page is off: switch it on in Settings. Incidents can be posted already.') : ''}
        <div class="card section"><header><h3>Incidents and maintenance</h3><span class="cell-sub">Open ones, and those closed in the last 60 days. Everything here is public once the page is on.</span></header><div data-list></div></div>`;
      table($('[data-list]', body), {
        columns: [
          { label: '', render: (i) => (i.kind === 'maintenance' ? icon('gear') : icon('warn')) },
          { label: 'Title', render: (i) => `<div class="cell-title">${esc(i.title)}</div><div class="cell-sub">${esc(i.sites.length ? i.sites.map((s) => s.name).join(', ') : 'all sites')}${i.kind === 'maintenance' ? ` · ${esc(fmt.time(i.scheduledFrom))} – ${esc(fmt.time(i.scheduledTo))}` : ` · since ${esc(fmt.time(i.startedAt))}`}</div>` },
          { label: 'Impact', render: (i) => tag(...IMPACT[i.impact]) },
          { label: 'Status', render: (i) => tag(STATUS[i.status] ?? 't-mute', i.status.replace('_', ' ')) },
          { label: 'Latest', render: (i) => `<span class="cell-sub">${esc((i.updates.at(-1)?.message ?? '').slice(0, 120))}</span>` },
          { label: '', render: (i) => (canWrite && i.open ? `<button class="btn sm" type="button" data-update="${esc(i.id)}">Post an update</button>` : '') },
        ],
        rows: list, empty: 'Nothing posted. All quiet.',
      });
    };
    const sitesPicker = (sel = []) => `<div class="field full"><label>Sites</label><div class="row" style="gap:10px;flex-wrap:wrap">${siteList.map((s) => `<label class="row" style="gap:4px"><input type="checkbox" name="site" value="${esc(s.id)}"${sel.includes(s.id) ? ' checked' : ''}> ${esc(s.name)}</label>`).join('')}</div><div class="help">None ticked: all sites.</div></div>`;
    const create = (kind) => {
      const start = new Date(Date.now() + 86_400_000);
      modal({
        title: kind === 'maintenance' ? 'Plan maintenance' : 'Report an incident', size: 'lg',
        body: `<div class="form">
          ${field('Title', `<input name="title" placeholder="${kind === 'maintenance' ? 'Transformer service at Plaza Senayan' : 'Payment terminals not responding'}">`, { full: true })}
          ${field('Impact', '<select name="impact"><option value="minor">Minor</option><option value="major">Major</option><option value="critical">Critical</option></select>')}
          ${kind === 'maintenance' ? `${field('From', `<input name="from" type="datetime-local" value="${local(start)}">`)}${field('To', `<input name="to" type="datetime-local" value="${local(new Date(start.getTime() + 3 * 3_600_000))}">`)}` : field('Status', `<select name="status">${NEXT.incident.slice(0, 3).map((s) => `<option>${s}</option>`).join('')}</select>`)}
          ${sitesPicker()}
          ${field('Message (public)', '<textarea name="message" rows="3" placeholder="What is happening and what drivers should do."></textarea>', { full: true })}
          <label class="row full" style="gap:8px"><input type="checkbox" name="notify" checked> E-mail the subscribers</label>
        </div>`,
        actions: [{ label: 'Cancel' }, { label: 'Post', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name=${n}]`, mc.el)?.value;
          const b = { kind, title: v('title'), impact: v('impact'), message: v('message'), siteIds: [...mc.el.querySelectorAll('[name=site]:checked')].map((x) => x.value), notify: $('[name=notify]', mc.el).checked };
          if (kind === 'maintenance') Object.assign(b, { scheduledFrom: new Date(v('from')).toISOString(), scheduledTo: new Date(v('to')).toISOString() });
          else b.status = v('status');
          await api('/v1/status-page/incidents', { method: 'POST', body: b });
          toast('Posted.', 'ok'); draw();
        }) }],
      });
    };
    const update = (i) => {
      modal({
        title: `Update: ${i.title}`, size: 'lg',
        body: `<div class="stack" style="gap:6px;margin-bottom:12px">${i.updates.slice().reverse().map((u) => `<div><b>${esc(u.status.replace('_', ' '))}</b> <span class="cell-sub">${esc(fmt.time(u.at))}</span><div>${esc(u.message)}</div></div>`).join('')}</div>
          <div class="form">
          ${field('Status', `<select name="status">${NEXT[i.kind].map((s) => `<option value="${s}"${s === i.status ? ' selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}</select>`)}
          ${field('Impact', `<select name="impact">${['minor', 'major', 'critical'].map((s) => `<option${s === i.impact ? ' selected' : ''}>${s}</option>`).join('')}</select>`)}
          ${field('Message (public)', '<textarea name="message" rows="3"></textarea>', { full: true })}
          <label class="row full" style="gap:8px"><input type="checkbox" name="notify" checked> E-mail the subscribers</label></div>`,
        actions: [{ label: 'Cancel' }, { label: 'Post the update', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name=${n}]`, mc.el).value;
          await api(`/v1/status-page/incidents/${i.id}`, { method: 'PUT', body: { status: v('status'), impact: v('impact'), message: v('message'), notify: $('[name=notify]', mc.el).checked } });
          toast('Updated.', 'ok'); draw();
        }) }],
      });
    };
    const settings = () => {
      modal({
        title: 'Status page settings', size: 'lg',
        body: `<div class="form">
          <label class="row full" style="gap:8px"><input type="checkbox" name="enabled"${pg.enabled ? ' checked' : ''}> <b>The page is public</b></label>
          ${field('Title', `<input name="title" value="${esc(pg.title)}">`)}
          ${field('Address', `<div class="row" style="gap:4px;align-items:center"><span class="cell-sub">${esc(location.origin)}/status/</span><input name="slug" value="${esc(pg.slug)}" style="max-width:220px"></div>`, { help: 'On your own approved console address, also at /status.' })}
          ${field('Introduction', `<textarea name="intro" rows="2">${esc(pg.intro ?? '')}</textarea>`, { opt: true, full: true })}
          ${sitesPicker(pg.siteIds ?? [])}
          <label class="row full" style="gap:8px"><input type="checkbox" name="showCounts"${pg.showCounts ? ' checked' : ''}> Show how many connectors are working and free</label>
        </div>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name=${n}]`, mc.el);
          await api('/v1/status-page', { method: 'PUT', body: { enabled: v('enabled').checked, title: v('title').value, slug: v('slug').value, intro: v('intro').value,
            siteIds: [...mc.el.querySelectorAll('[name=site]:checked')].map((x) => x.value), showCounts: v('showCounts').checked } });
          toast('Saved.', 'ok'); draw();
        }) }],
      });
    };
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.matches('[data-incident]')) create('incident');
      else if (b.matches('[data-maint]')) create('maintenance');
      else if (b.matches('[data-settings]')) settings();
      else if (b.matches('[data-copy]')) copy(`${location.origin}/status/${pg.slug}`);
      else if (b.dataset.update) update(list.find((i) => i.id === b.dataset.update));
    });
    await draw();
  },
});
