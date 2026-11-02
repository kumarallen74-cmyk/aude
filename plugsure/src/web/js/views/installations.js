import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options, download } from '../core.js';

/**
 * (v1.48.0) Assets & energy → Installations: new sites from the survey to live. A board by stage (survey, design,
 * permit, grid, install, commission); each project's tasks (a stage's required ones before it moves on), documents,
 * history, and its candidate site, capex project and the site it becomes.
 */

const STAGE = { survey: 'Survey', design: 'Design', permit: 'Permits', grid: 'Grid (PLN)', install: 'Install', commission: 'Commission', live: 'Live', cancelled: 'Cancelled' };
const KINDS = ['survey', 'drawing', 'permit', 'grid', 'photo', 'commissioning', 'contract', 'other'];
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const fileToDataUrl = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read the file.')); r.readAsDataURL(f); });

registerView('installations', {
  title: 'Installations',
  icon: 'list',
  group: 'assets',
  order: 19,
  perm: 'site:read',
  async render(root) {
    const canWrite = state.can('site:write');
    root.innerHTML = pageHead('Installations', 'New sites from the first survey to live: each stage\'s tasks, permits and the PLN connection, documents, dates and the capex budget.',
      canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} New project</button>` : '') + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    let lookups = null;

    const loadLookups = async () => {
      if (lookups) return lookups;
      const [sites, cands, capex, users] = await Promise.all([api('/v1/sites').then((r) => (Array.isArray(r) ? r : r.sites ?? [])).catch(() => []),
        api('/v1/demand/candidates').then((r) => r.candidates ?? []).catch(() => []), api('/v1/finance/projects').then((r) => r.projects ?? []).catch(() => []),
        state.can('user:read') ? api('/v1/users').then((r) => (Array.isArray(r) ? r : r.users ?? [])).catch(() => []) : []]);
      lookups = { sites, cands, capex, users };
      return lookups;
    };

    const projectModal = async (p) => {
      const l = await loadLookups();
      modal({ title: p ? `Edit ${p.number}` : 'New installation project', size: 'lg',
        body: `<div class="form grid2">${field('Name', `<input name="name" maxlength="120" value="${esc(p?.name ?? '')}" placeholder="Mall Galeria basement">`)}
          ${field('Address', `<input name="address" maxlength="300" value="${esc(p?.address ?? '')}">`)}
          ${field('Candidate site', `<select name="cand">${options(l.cands.map((c) => ({ value: c.id, label: c.name })), p?.candidateId ?? '', { blank: 'None' })}</select>`)}
          ${field('Capex project', `<select name="capex">${options(l.capex.map((c) => ({ value: c.id, label: `${c.number} · ${c.name}` })), p?.capexProjectId ?? '', { blank: 'None' })}</select>`)}
          ${field('Site it becomes', `<select name="site">${options(l.sites.map((s) => ({ value: s.id, label: s.name })), p?.siteId ?? '', { blank: 'Not created yet' })}</select>`, { help: 'Needed to go live.' })}
          ${field('Owner', `<select name="owner">${options(l.users.map((u) => ({ value: u.id, label: u.name ?? u.email })), p?.ownerId ?? '', { blank: 'No one' })}</select>`)}
          ${field('Chargers', `<input name="ch" type="number" min="1" max="500" value="${p?.chargersPlanned ?? ''}">`)}
          ${field('Total power (kW)', `<input name="kw" type="number" min="1" step="0.1" value="${p?.kwPlanned ?? ''}">`)}
          ${field('Target go-live', `<input name="target" type="date" value="${esc(p?.targetLiveOn ?? '')}">`)}
          ${field('Notes', `<textarea name="notes" rows="3" maxlength="5000">${esc(p?.notes ?? '')}</textarea>`, { full: true })}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
          const b = { name: v('name'), address: v('address') || null, candidateId: v('cand') || null, capexProjectId: v('capex') || null, siteId: v('site') || null, ownerId: v('owner') || null,
            chargersPlanned: v('ch') === '' ? null : Number(v('ch')), kwPlanned: v('kw') === '' ? null : Number(v('kw')), targetLiveOn: v('target') || null, notes: v('notes') || null };
          const r = await api(p ? `/v1/installations/${p.id}` : '/v1/installations', { method: p ? 'PUT' : 'POST', body: b });
          toast('Saved.', 'ok'); open(r.id);
        }) }] });
    };

    const board = async () => {
      let d;
      try { d = await api('/v1/installations'); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const open_ = d.projects.filter((p) => !['live', 'cancelled'].includes(p.stage));
      body.innerHTML = `<div class="grid k4">${kpi('In progress', fmt.num(open_.length))}${kpi('Overdue', fmt.num(open_.filter((p) => p.overdue).length), 'past the target date', open_.some((p) => p.overdue) ? 'warn' : '')}
          ${kpi('Chargers coming', fmt.num(open_.reduce((a, p) => a + (p.chargersPlanned ?? 0), 0)))}${kpi('Live (90 days)', fmt.num(d.byStage.live ?? 0))}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:10px">${d.stages.filter((s) => s !== 'live').map((s) => `
          <div class="card section"><header><h3>${esc(STAGE[s])}</h3><span class="cell-sub">${d.byStage[s] ?? 0}</span></header>
            <div style="padding:8px;display:flex;flex-direction:column;gap:8px">${d.projects.filter((p) => p.stage === s).map((p) => `
              <button type="button" class="card clickable" data-p="${esc(p.id)}" style="text-align:left;padding:10px 12px;display:block;width:100%">
                <b>${esc(p.name)}</b><div class="cell-sub">${esc(p.number)}${p.chargersPlanned ? ` · ${p.chargersPlanned} chargers` : ''}</div>
                <div class="cell-sub">${p.tasksDone}/${p.tasksDone + p.tasksOpen} tasks · ${p.daysInStage} d in stage</div>
                ${p.overdue ? tag('t-crit', `due ${p.targetLiveOn}`) : p.targetLiveOn ? `<span class="cell-sub">target ${esc(p.targetLiveOn)}</span>` : ''}</button>`).join('') || '<span class="cell-sub" style="padding:4px">—</span>'}</div></div>`).join('')}</div>
        ${d.projects.some((p) => ['live', 'cancelled'].includes(p.stage)) ? `<div class="card section"><header><h3>Recently live or cancelled</h3></header><div data-done></div></div>` : ''}`;
      const done = $('[data-done]', body);
      if (done) table(done, { columns: [{ label: 'Project', render: (p) => `<b>${esc(p.name)}</b><div class="cell-sub">${esc(p.number)}</div>` }, { label: 'Stage', render: (p) => tag(p.stage === 'live' ? 't-ok' : 't-mute', STAGE[p.stage]) },
        { label: 'Live on', render: (p) => esc(p.liveOn ?? '—') }, { label: 'Site', render: (p) => esc(p.site ?? '—') }], rows: d.projects.filter((p) => ['live', 'cancelled'].includes(p.stage)), onRow: (p) => open(p.id) });
      $$('[data-p]', body).forEach((b) => b.addEventListener('click', () => open(b.dataset.p)));
    };

    const open = async (id) => {
      let p;
      try { p = await api(`/v1/installations/${id}`); } catch (e) { toast(e.message, 'crit'); return; }
      const stages = ['survey', 'design', 'permit', 'grid', 'install', 'commission', 'live'];
      const live = !['live', 'cancelled'].includes(p.stage);
      body.innerHTML = `<div><button class="btn sm" type="button" data-back>‹ Board</button></div>
        <div class="card section"><header><h3>${esc(p.number)} · ${esc(p.name)}</h3>${p.overdue ? tag('t-crit', 'overdue') : ''}
          ${canWrite ? `<div class="right" style="display:flex;gap:6px">${live ? `<button class="btn sm" type="button" data-cancel>Cancel project</button>` : ''}<button class="btn sm" type="button" data-edit>Edit</button>${p.nextStage ? `<button class="btn sm primary" type="button" data-next>Move to ${esc(STAGE[p.nextStage])}</button>` : ''}</div>` : ''}</header>
          <div style="padding:10px 16px;display:flex;gap:4px;flex-wrap:wrap">${stages.map((s) => tag(s === p.stage ? 't-info' : stages.indexOf(s) < stages.indexOf(p.stage) || p.stage === 'live' ? 't-ok' : 't-mute', STAGE[s])).join(' ')}${p.stage === 'cancelled' ? tag('t-crit', 'Cancelled') : ''}</div>
          <div class="cell-sub" style="padding:0 16px 12px">${[p.address, p.chargersPlanned ? `${p.chargersPlanned} chargers` : null, p.kwPlanned ? `${fmt.num(p.kwPlanned)} kW` : null, p.targetLiveOn ? `target ${p.targetLiveOn}` : null,
            p.owner ? `owner ${p.owner}` : null, p.candidate ? `candidate: ${p.candidate}` : null, p.site ? `site: ${p.site}` : null].filter(Boolean).map(esc).join(' · ')}</div>
          ${p.capexDetail ? `<div class="cell-sub" style="padding:0 16px 12px">Capex ${esc(p.capexDetail.number)}: spent ${fmt.money(p.capexDetail.spent ?? 0, p.capexDetail.currency)} of ${fmt.money(p.capexDetail.budget ?? 0, p.capexDetail.currency)}${p.capexDetail.committed ? `, ${fmt.money(p.capexDetail.committed, p.capexDetail.currency)} committed` : ''}</div>` : ''}</div>
        <div class="card section"><header><h3>Tasks</h3>${canWrite && live ? `<button class="btn sm right" type="button" data-task>${icon('plus')} Add</button>` : ''}</header><div data-t style="padding:0 16px 12px"></div></div>
        <div class="card section"><header><h3>Documents</h3>${canWrite ? `<label class="btn sm right" style="cursor:pointer">${icon('upload')} Add<input type="file" data-file hidden accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx,.dwg"></label>` : ''}</header><div data-d></div></div>
        <div class="card section"><header><h3>History</h3></header><div data-h></div></div>`;
      const tBox = $('[data-t]', body);
      tBox.innerHTML = stages.filter((s) => p.tasks.some((t) => t.stage === s)).map((s) => `<div class="cell-sub" style="margin:10px 0 4px;font-weight:600">${esc(STAGE[s])}</div>${p.tasks.filter((t) => t.stage === s).map((t) => `
        <label style="display:flex;gap:10px;align-items:center;padding:4px 0"><input type="checkbox" data-tk="${t.id}" ${t.done ? 'checked' : ''} ${canWrite ? '' : 'disabled'}>
          <span style="flex:1">${esc(t.title)}${t.required ? '' : ' <span class="cell-sub">(optional)</span>'}${t.assignee ? ` <span class="cell-sub">· ${esc(t.assignee)}</span>` : ''}${t.dueOn ? ` <span class="cell-sub">· due ${esc(t.dueOn)}</span>` : ''}</span></label>`).join('')}`).join('');
      table($('[data-d]', body), { columns: [{ label: 'Document', render: (d) => `<a href="${esc(d.url)}" data-dl="${esc(d.id)}">${esc(d.name)}</a>` }, { label: 'Kind', key: 'kind' },
        { label: 'Size', num: true, render: (d) => `${fmt.num(d.bytes / 1024, 0)} KB` }, { label: 'Added', render: (d) => esc(fmt.time(d.at)) },
        ...(canWrite ? [{ label: '', render: (d) => `<button class="btn sm" data-rm="${d.id}">Remove</button>` }] : [])], rows: p.documents, empty: 'No documents yet.' });
      table($('[data-h]', body), { columns: [{ label: 'When', render: (h) => esc(fmt.time(h.at)) }, { label: 'Stage', render: (h) => `${h.from ? `${esc(STAGE[h.from])} → ` : ''}${esc(STAGE[h.to])}` },
        { label: 'By', render: (h) => esc(h.by ?? '—') }, { label: 'Note', render: (h) => esc(h.note ?? '') }], rows: p.history });
      $('[data-back]', body).addEventListener('click', board);
      $('[data-edit]', body)?.addEventListener('click', () => projectModal(p));
      $('[data-next]', body)?.addEventListener('click', () => modal({ title: `Move to ${STAGE[p.nextStage]}`, body: field('Note', '<textarea name="note" rows="2" maxlength="1000"></textarea>'),
        actions: [{ label: 'Cancel' }, { label: 'Move on', kind: 'primary', onClick: guard(async (mc) => { await api(`/v1/installations/${p.id}/stage`, { method: 'POST', body: { action: 'advance', note: $('[name="note"]', mc.el).value || null } }); open(p.id); }) }] }));
      $('[data-cancel]', body)?.addEventListener('click', () => modal({ title: `Cancel ${p.number}`, body: field('Why', '<textarea name="note" rows="2" maxlength="1000"></textarea>'),
        actions: [{ label: 'Back' }, { label: 'Cancel the project', kind: 'danger', onClick: guard(async (mc) => { await api(`/v1/installations/${p.id}/stage`, { method: 'POST', body: { action: 'cancel', note: $('[name="note"]', mc.el).value } }); open(p.id); }) }] }));
      $('[data-task]', body)?.addEventListener('click', () => modal({ title: 'Add a task', body: `<div class="form">${field('Task', '<input name="title" maxlength="200">')}
          ${field('Stage', `<select name="stage">${options(stages.filter((s) => s !== 'live').map((s) => ({ value: s, label: STAGE[s] })), p.stage)}</select>`)}
          ${field('Due', '<input name="due" type="date">')}${field('', '<label><input type="checkbox" name="req" checked> Required before moving on</label>')}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', onClick: guard(async (mc) => {
          await api(`/v1/installations/${p.id}/tasks`, { method: 'POST', body: { title: $('[name="title"]', mc.el).value, stage: $('[name="stage"]', mc.el).value, dueOn: $('[name="due"]', mc.el).value || null, required: $('[name="req"]', mc.el).checked } });
          open(p.id);
        }) }] }));
      $$('[data-tk]', body).forEach((c) => c.addEventListener('change', async () => { try { await api(`/v1/installations/${p.id}/tasks/${c.dataset.tk}`, { method: 'PUT', body: { done: c.checked } }); } catch (e) { toast(e.message, 'crit'); c.checked = !c.checked; } }));
      $('[data-file]', body)?.addEventListener('change', async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        modal({ title: `Add ${f.name}`, body: field('Kind', `<select name="kind">${options(KINDS.map((k) => ({ value: k, label: k })), /\.(jpe?g|png)$/i.test(f.name) ? 'photo' : 'other')}</select>`),
          actions: [{ label: 'Cancel' }, { label: 'Upload', kind: 'primary', onClick: guard(async (mc) => {
            if (f.size > 15 * 1024 * 1024) throw new Error('At most 15 MB a file.');
            await api(`/v1/installations/${p.id}/documents`, { method: 'POST', body: { kind: $('[name="kind"]', mc.el).value, name: f.name, dataUrl: await fileToDataUrl(f) } });
            toast('Added.', 'ok'); open(p.id);
          }) }] });
      });
      $$('[data-dl]', body).forEach((a) => a.addEventListener('click', async (e) => { e.preventDefault(); try { const d = p.documents.find((x) => x.id === a.dataset.dl); download(d.name, await api(d.url, { raw: true }).then((r) => r.blob())); } catch (err) { toast(err.message, 'crit'); } }));
      $$('[data-rm]', body).forEach((b) => b.addEventListener('click', async () => { if (!confirm('Remove this document?')) return; try { await api(`/v1/installations/documents/${b.dataset.rm}`, { method: 'DELETE' }); open(p.id); } catch (e) { toast(e.message, 'crit'); } }));
    };

    $('[data-add]', root)?.addEventListener('click', () => projectModal(null).catch((e) => toast(e.message, 'crit')));
    await board();
  },
});
