import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, options } from '../core.js';

/**
 * (v1.46.0) Maintain → Field: the technician's app, built for a phone. My jobs (and unassigned ones to pick up), then
 * one job: the charger now (with "Check now"), arrive, the checklist, photos (shrunk on the phone), parts from the van,
 * notes and hours, the site contact's signature, finish.
 *
 * Without a signal, changes wait in this browser (localStorage) with their own id and are sent when it is back: the
 * server applies each once however often it arrives. The office plans jobs (who, when, which checklist) and keeps the
 * checklists here too.
 */

const QKEY = 'plugsure.field.queue';
const STATUS = { open: ['t-info', 'open'], in_progress: ['t-warn', 'in progress'], done: ['t-ok', 'done'], cancelled: ['t-mute', 'cancelled'] };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const opId = () => `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const queue = {
  read() { try { return JSON.parse(localStorage.getItem(QKEY) ?? '[]'); } catch { return []; } },
  write(q) { try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch { /* full or blocked: kept in memory only */ } },
  push(item) { const q = queue.read(); q.push(item); queue.write(q); },
};

/** Send a change; without a network it waits in the queue (the server applies it once). */
async function send(path, method, body) {
  const b = { ...body, opId: body.opId ?? opId() };
  try {
    return await api(path, { method, body: b });
  } catch (err) {
    if (err.status === 0) { queue.push({ path, method, body: b, at: new Date().toISOString() }); toast('No signal: saved on this phone, sent when you are back online.', 'warn'); return null; }
    throw err;
  }
}

async function flush() {
  const q = queue.read();
  if (!q.length) return 0;
  const left = [];
  let sent = 0;
  for (const it of q) {
    try { await api(it.path, { method: it.method, body: it.body }); sent++; } catch (err) { if (err.status === 0) left.push(it); else toast(`A saved change was refused: ${err.message}`, 'crit'); }
  }
  queue.write(left);
  if (sent) toast(`${sent} saved change${sent === 1 ? '' : 's'} sent.`, 'ok');
  return sent;
}

/** A photo from the camera, shrunk to at most 1600 px (JPEG). */
function shrink(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => reject(new Error('That file is not an image.'));
    img.src = URL.createObjectURL(file);
  });
}

/** A signature pad: draw with a finger or the mouse. */
function signaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * ratio; canvas.height = canvas.clientHeight * ratio;
  ctx.scale(ratio, ratio); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
  let drawing = false, drawn = false;
  const at = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => { drawing = true; canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...at(e)); });
  canvas.addEventListener('pointermove', (e) => { if (!drawing) return; ctx.lineTo(...at(e)); ctx.stroke(); drawn = true; });
  canvas.addEventListener('pointerup', () => { drawing = false; });
  return {
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false; },
    empty: () => !drawn,
    png() {
      // White behind the ink, so it reads on any background.
      const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(canvas, 0, 0);
      return c.toDataURL('image/png');
    },
  };
}

registerView('field', {
  title: 'Field',
  icon: 'gear',
  group: 'maintain',
  order: 28,
  perm: 'charge_point:read',
  async render(root) {
    const canWork = state.can('charge_point:command') || state.can('charge_point:write');
    const office = state.can('charge_point:write');
    root.innerHTML = pageHead('Field',
      'Your jobs on the road: open one on site to see the charger, work the checklist, add photos and parts, get it signed and finish. Works without a signal: changes are sent when you are back online.',
      `${office ? `<button class="btn" type="button" data-tpl>${icon('list')} Checklists</button>` : ''}<button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button>`)
      + '<div data-body class="stack" style="gap:14px;max-width:760px"></div>';
    const body = $('[data-body]', root);
    const onOnline = () => flush().then((n) => { if (n) list(); });
    window.addEventListener('online', onOnline);

    const list = async () => {
      await flush().catch(() => 0);
      let jobs;
      try { ({ jobs } = await api('/v1/field/jobs')); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const waiting = queue.read().length;
      const mine = jobs.filter((j) => j.assigneeId === state.me?.user?.id);
      const free = jobs.filter((j) => !j.assigneeId);
      const others = jobs.filter((j) => j.assigneeId && j.assigneeId !== state.me?.user?.id);
      const card = (j) => `<button type="button" class="card section clickable" data-job="${esc(j.id)}" style="text-align:left;width:100%;padding:12px 14px;display:block">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>${esc(j.number)}</b> ${tag(...(STATUS[j.status] ?? ['t-mute', j.status]))} ${tag('t-mute', j.kind)}
            ${j.scheduledFor ? `<span class="cell-sub">${esc(fmt.date(j.scheduledFor))}</span>` : ''}</div>
          <div style="margin-top:4px">${esc(j.title)}</div>
          <div class="cell-sub">${esc([j.site, j.charger].filter(Boolean).join(' · '))}${j.assignee && j.assigneeId !== state.me?.user?.id ? ` · ${esc(j.assignee)}` : ''}</div></button>`;
      body.innerHTML = `${waiting ? callout('warn', `${waiting} change${waiting === 1 ? '' : 's'} saved on this phone, waiting for a signal.`) : ''}
        <h3 style="margin:4px 0 0">My jobs</h3>${mine.length ? mine.map(card).join('') : '<p class="cell-sub">Nothing assigned to you.</p>'}
        ${free.length ? `<h3 style="margin:8px 0 0">Not assigned</h3>${free.map(card).join('')}` : ''}
        ${others.length && office ? `<h3 style="margin:8px 0 0">Assigned to others</h3>${others.map(card).join('')}` : ''}`;
      $$('[data-job]', body).forEach((b) => b.addEventListener('click', () => open(b.dataset.job)));
    };

    const open = async (id) => {
      let j;
      try { j = await api(`/v1/field/jobs/${id}`); } catch (e) { toast(e.message, 'crit'); return; }
      const ch = j.charger;
      const live = j.status === 'open' || j.status === 'in_progress';
      const work = canWork && live;
      body.innerHTML = `<div><button class="btn sm" type="button" data-back>${'‹'} Jobs</button></div>
        <div class="card section"><header><h3>${esc(j.number)} · ${esc(j.title)}</h3>${tag(...(STATUS[j.status] ?? ['t-mute', j.status]))}</header>
          <div style="padding:0 16px 14px">${j.description ? `<p>${esc(j.description)}</p>` : ''}
            <div class="cell-sub">${esc([j.site, j.siteAddress].filter(Boolean).join(' · '))}</div>
            ${j.lat != null ? `<a class="btn sm" style="margin-top:8px" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${j.lat},${j.lon}`)}">${icon('site')} Directions</a>` : ''}
            ${j.arrivedAt ? `<div class="cell-sub" style="margin-top:6px">Arrived ${esc(fmt.time(j.arrivedAt))}</div>` : ''}
            ${work ? `<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
              ${!j.assigneeId ? '<button class="btn" type="button" data-act="take">Take this job</button>' : ''}
              ${!j.arrivedAt ? '<button class="btn primary" type="button" data-act="arrive">I have arrived</button>' : ''}
              ${office ? '<button class="btn" type="button" data-plan>Plan</button>' : ''}</div>` : office && live ? '<div style="margin-top:10px"><button class="btn" type="button" data-plan>Plan</button></div>' : ''}</div></div>
        ${ch ? `<div class="card section"><header><h3>The charger</h3>${tag(ch.online ? 't-ok' : 't-crit', ch.online ? 'online' : 'offline')}
            ${work && state.can('charge_point:command') ? `<button class="btn sm right" type="button" data-check>${icon('refresh')} Check now</button>` : ''}</header>
          <div style="padding:0 16px 14px"><div class="cell-sub">${esc(ch.identity)}${ch.vendor ? ` · ${esc(ch.vendor)} ${esc(ch.model ?? '')}` : ''}${ch.lastHeartbeatAt ? ` · last heartbeat ${esc(fmt.time(ch.lastHeartbeatAt))}` : ''}</div>
            <div data-conns style="margin-top:6px"></div>
            ${ch.alerts.length ? `<div style="margin-top:8px">${ch.alerts.map((a) => `<div>${tag(a.severity === 'critical' ? 't-crit' : 't-warn', a.kind)} ${esc(a.message)}</div>`).join('')}</div>` : ''}</div></div>` : ''}
        <div class="card section"><header><h3>Checklist</h3>${j.template ? `<span class="cell-sub">${esc(j.template.name)}</span>` : ''}</header>
          <div data-check-list style="padding:0 16px 14px">${j.checklist.length ? j.checklist.map((it) => `<label style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--line)">
              <input type="checkbox" data-item="${esc(it.id)}" ${it.done ? 'checked' : ''} ${work ? '' : 'disabled'} style="width:22px;height:22px;flex:none">
              <span>${esc(it.label)}${it.required ? '' : ' <span class="cell-sub">(optional)</span>'}${it.note ? `<br><span class="cell-sub">${esc(it.note)}</span>` : ''}</span></label>`).join('') : '<p class="cell-sub">No checklist for this job.</p>'}</div></div>
        <div class="card section"><header><h3>Photos</h3>${work ? `<label class="btn sm right" style="cursor:pointer">${icon('camera')} Add<input type="file" accept="image/*" capture="environment" data-photo hidden></label>` : ''}</header>
          <div style="padding:0 16px 14px;display:flex;gap:8px;flex-wrap:wrap">${j.photos.length ? j.photos.map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.url)}" alt="${esc(p.caption ?? 'Photo')}" loading="lazy" style="width:96px;height:96px;object-fit:cover;border-radius:6px;border:1px solid var(--line)"></a>`).join('') : `<span class="cell-sub">None yet${j.template?.requirePhoto ? ' (at least one is needed)' : ''}.</span>`}</div></div>
        <div class="card section"><header><h3>Parts used</h3>${work ? `<button class="btn sm right" type="button" data-part>${icon('plus')} Add</button>` : ''}</header><div data-parts></div></div>
        <div class="card section"><header><h3>Notes and hours</h3></header><div class="form" style="padding:0 16px 14px">
          ${field('Notes', `<textarea name="notes" rows="3" maxlength="5000" ${canWork ? '' : 'disabled'}>${esc(j.notes ?? '')}</textarea>`)}
          ${field('Hours on site', `<input name="hours" type="number" min="0" max="200" step="0.25" value="${j.labourHours || ''}" ${work ? '' : 'disabled'}>`)}
          ${canWork ? '<div><button class="btn" type="button" data-notes>Save notes</button></div>' : ''}</div></div>
        <div class="card section"><header><h3>Signature</h3>${j.signedAt ? tag('t-ok', 'signed') : ''}</header><div style="padding:0 16px 14px">
          ${j.signedAt ? `<img src="/v1/field/jobs/${esc(j.id)}/signature" alt="Signature" style="max-width:100%;height:110px;background:#fff;border:1px solid var(--line);border-radius:6px"><div class="cell-sub">${esc(j.signatureName)} · ${esc(fmt.time(j.signedAt))}</div>`
            : work ? `${field('Name of who signs', '<input name="signer" maxlength="120" placeholder="The site contact or the customer">')}
              <canvas data-sig style="width:100%;height:160px;background:#fff;border:1px solid var(--line);border-radius:6px;touch-action:none"></canvas>
              <div style="display:flex;gap:8px;margin-top:6px"><button class="btn sm" type="button" data-sig-clear>Clear</button><button class="btn sm primary" type="button" data-sign>Save signature</button></div>`
            : `<span class="cell-sub">Not signed${j.template?.requireSignature ? ' (needed)' : ''}.</span>`}</div></div>
        ${work ? `<button class="btn primary" type="button" data-finish style="padding:14px;font-size:1.05rem">${icon('check')} Finish the job</button>` : ''}`;
      if (ch) table($('[data-conns]', body), { columns: [{ label: 'Connector', render: (c) => `${c.evse}/${c.connector}${c.type ? ` · ${esc(c.type)}` : ''}` }, { label: 'Status', render: (c) => `${esc(c.status ?? '—')}${c.errorCode ? ` ${tag('t-crit', c.errorCode)}` : ''}` }], rows: ch.connectors, empty: 'No connectors reported.' });
      table($('[data-parts]', body), { columns: [{ label: 'Part', render: (p) => `${esc(p.item)}${p.sku ? `<div class="cell-sub">${esc(p.sku)}</div>` : ''}` }, { label: 'Qty', num: true, render: (p) => fmt.num(p.qty, 2) }], rows: j.parts, empty: 'None.' });
      $('[data-back]', body).addEventListener('click', list);
      const act = async (b) => { const r = await send(`/v1/field/jobs/${j.id}`, 'PUT', b); if (r) open(j.id); };
      $$('[data-act]', body).forEach((b) => b.addEventListener('click', () => act({ action: b.dataset.act, at: new Date().toISOString() }).catch((e) => toast(e.message, 'crit'))));
      $$('[data-item]', body).forEach((c) => c.addEventListener('change', () => send(`/v1/field/jobs/${j.id}`, 'PUT', { action: 'checklist', items: [{ id: c.dataset.item, done: c.checked }] }).catch((e) => { toast(e.message, 'crit'); c.checked = !c.checked; })));
      $('[data-check]', body)?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        try { const r = await api(`/v1/field/jobs/${j.id}/check`, { method: 'POST' }); toast(`The charger answered: ${r.asked}.`, r.charger?.online ? 'ok' : 'warn'); open(j.id); } catch (err) { toast(err.message, 'crit'); e.target.disabled = false; }
      });
      $('[data-photo]', body)?.addEventListener('change', async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        try { const dataUrl = await shrink(f); const r = await send(`/v1/field/jobs/${j.id}/photos`, 'POST', { dataUrl }); if (r) { toast(r.duplicate ? 'That photo is already on the job.' : 'Photo added.', 'ok'); open(j.id); } } catch (err) { toast(err.message, 'crit'); }
      });
      $('[data-notes]', body)?.addEventListener('click', () => act({ action: 'notes', notes: $('[name="notes"]', body).value, labourHours: $('[name="hours"]', body).value }).then(() => toast('Saved.', 'ok')).catch((e) => toast(e.message, 'crit')));
      const sigEl = $('[data-sig]', body);
      if (sigEl) {
        const pad = signaturePad(sigEl);
        $('[data-sig-clear]', body).addEventListener('click', () => pad.clear());
        $('[data-sign]', body).addEventListener('click', async () => {
          const name = $('[name="signer"]', body).value.trim();
          if (!name) { toast('Who signs?', 'warn'); return; }
          if (pad.empty()) { toast('Sign in the box first.', 'warn'); return; }
          try { const r = await send(`/v1/field/jobs/${j.id}/signature`, 'POST', { name, dataUrl: pad.png() }); if (r) { toast('Signed.', 'ok'); open(j.id); } } catch (err) { toast(err.message, 'crit'); }
        });
      }
      $('[data-part]', body)?.addEventListener('click', async () => {
        let p;
        try { p = await api('/v1/field/parts'); } catch (e) { toast(e.message, 'crit'); return; }
        modal({ title: 'Part used', body: `<div class="form">${field('Part', `<select name="item">${options(p.items.filter((i) => !i.archived).map((i) => ({ value: i.id, label: `${i.sku} · ${i.name} (${fmt.num(i.onHand, 2)} ${i.unit})` })), '')}</select>`)}
            ${field('From', `<select name="loc">${options(p.locations.filter((l) => !l.archived).map((l) => ({ value: l.id, label: l.name })), '')}</select>`)}
            ${field('Quantity', '<input name="qty" type="number" min="0.001" step="any" value="1">')}</div>`,
          actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', onClick: guard(async (mc) => {
            const r = await send(`/v1/field/jobs/${j.id}/parts`, 'POST', { itemId: $('[name="item"]', mc.el).value, locationId: $('[name="loc"]', mc.el).value, qty: Number($('[name="qty"]', mc.el).value) });
            if (r) open(j.id);
          }) }] });
      });
      $('[data-finish]', body)?.addEventListener('click', () => {
        modal({ title: `Finish ${j.number}`, body: `<div class="form">${field('Hours on site', `<input name="h" type="number" min="0" max="200" step="0.25" value="${$('[name="hours"]', body).value}">`)}
            ${field('What was done', `<textarea name="n" rows="3" maxlength="5000">${esc($('[name="notes"]', body).value)}</textarea>`)}</div>`,
          actions: [{ label: 'Cancel' }, { label: 'Finish', kind: 'primary', onClick: guard(async (mc) => {
            const r = await send(`/v1/field/jobs/${j.id}`, 'PUT', { action: 'finish', labourHours: $('[name="h"]', mc.el).value, notes: $('[name="n"]', mc.el).value || null });
            if (r) { toast('Job done.', 'ok'); list(); }
          }) }] });
      });
      $('[data-plan]', body)?.addEventListener('click', () => plan(j));
    };

    const plan = async (j) => {
      const [users, { templates }] = await Promise.all([state.can('user:read') ? api('/v1/users').catch(() => []) : [], api('/v1/field/templates')]);
      const ul = (Array.isArray(users) ? users : users?.users ?? []).filter((u) => u.status !== 'disabled');
      modal({ title: `Plan ${j.number}`, body: `<div class="form">${field('Technician', `<select name="a">${options(ul.map((u) => ({ value: u.id, label: `${u.name ?? u.email}${u.role ? ` · ${u.role}` : ''}` })), j.assigneeId ?? '', { blank: 'No one yet' })}</select>`)}
          ${field('Day', `<input name="d" type="date" value="${esc(j.scheduledFor ?? '')}">`)}
          ${field('Checklist', `<select name="t">${options(templates.map((t) => ({ value: t.id, label: t.name })), j.template?.id ?? '', { blank: 'By the job\'s kind' })}</select>`)}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          await api(`/v1/field/jobs/${j.id}/plan`, { method: 'PUT', body: { assigneeId: $('[name="a"]', mc.el).value || null, scheduledFor: $('[name="d"]', mc.el).value || null, templateId: $('[name="t"]', mc.el).value || null } });
          toast('Planned.', 'ok'); open(j.id);
        }) }] });
    };

    const templatesModal = async () => {
      let templates;
      try { ({ templates } = await api('/v1/field/templates')); } catch (e) { toast(e.message, 'crit'); return; }
      const edit = (t) => modal({ title: t ? `Edit ${t.name}` : 'New checklist', size: 'lg',
        body: `<div class="form grid2">${field('Name', `<input name="name" maxlength="80" value="${esc(t?.name ?? '')}" placeholder="Quarterly preventive">`)}
          ${field('For jobs of kind', `<select name="kind">${options([{ value: 'corrective', label: 'Corrective' }, { value: 'preventive', label: 'Preventive' }, { value: 'warranty', label: 'Warranty' }], t?.kind ?? '', { blank: 'Any kind' })}</select>`)}
          ${field('Items', `<textarea name="items" rows="8" placeholder="One per line; end with (optional) for an item that need not be done">${esc((t?.items ?? []).map((i) => `${i.label}${i.required ? '' : ' (optional)'}`).join('\n'))}</textarea>`, { help: 'Up to 60.' })}
          <div>${field('', `<label><input type="checkbox" name="photo" ${t?.requirePhoto ? 'checked' : ''}> At least one photo before finishing</label>`)}
          ${field('', `<label><input type="checkbox" name="sig" ${t?.requireSignature ? 'checked' : ''}> A signature before finishing</label>`)}</div></div>`,
        actions: [...(t ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/field/templates/${t.id}`, { method: 'PUT', body: { archive: true } }); toast('Archived.', 'ok'); }) }] : []),
          { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
            const lines = $('[name="items"]', mc.el).value.split('\n').map((x) => x.trim()).filter(Boolean);
            const items = lines.map((l, i) => { const opt = /\(optional\)\s*$/i.test(l); return { id: t?.items?.[i]?.id ?? `i${i + 1}`, label: l.replace(/\s*\(optional\)\s*$/i, ''), required: !opt }; });
            const b = { name: $('[name="name"]', mc.el).value, kind: $('[name="kind"]', mc.el).value || null, items, requirePhoto: $('[name="photo"]', mc.el).checked, requireSignature: $('[name="sig"]', mc.el).checked };
            await api(t ? `/v1/field/templates/${t.id}` : '/v1/field/templates', { method: t ? 'PUT' : 'POST', body: b });
            toast('Saved.', 'ok');
          }) }] });
      modal({ title: 'Checklists', size: 'lg', body: '<div data-t></div>', onMount: (mc) => {
        table($('[data-t]', mc.el), { columns: [{ label: 'Name', key: 'name' }, { label: 'For', render: (t) => esc(t.kind ?? 'any job') }, { label: 'Items', num: true, render: (t) => fmt.num(t.items.length) },
          { label: 'Needs', render: (t) => [t.requirePhoto ? 'photo' : '', t.requireSignature ? 'signature' : ''].filter(Boolean).join(', ') || '—' }],
        rows: templates, empty: 'No checklists yet: jobs have none.', onRow: (t) => { mc.close?.(); edit(t); } });
      }, actions: [{ label: 'Close' }, { label: 'New checklist', kind: 'primary', onClick: () => { edit(null); } }] });
    };

    $('[data-refresh]', root).addEventListener('click', list);
    $('[data-tpl]', root)?.addEventListener('click', templatesModal);
    await list();
    return () => window.removeEventListener('online', onOnline);
  },
});
