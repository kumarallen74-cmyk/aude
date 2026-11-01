import { $, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, drawer, copy, options } from '../core.js';

/**
 * (v1.45.0) Operate → Support: the case desk. Cases from the driver app ("Laporkan masalah"), e-mail (the inbound
 * webhook), WhatsApp (when the assistant hands over) and staff; SLAs, assignment, macros, internal notes.
 */

const STATUS = { new: ['t-info', 'new'], open: ['t-warn', 'open'], pending: ['t-mute', 'waiting on customer'], resolved: ['t-ok', 'resolved'], closed: ['t-mute', 'closed'] };
const PRIO = { urgent: ['t-crit', 'urgent'], high: ['t-warn', 'high'], normal: ['t-info', 'normal'], low: ['t-mute', 'low'] };
const CHANNEL = { app: 'App', email: 'E-mail', whatsapp: 'WhatsApp', console: 'Staff' };
const CATS = { charging: 'Charging', payment: 'Payment', refund: 'Refund', account: 'Account', charger_fault: 'Charger fault', other: 'Other' };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const due = (c) => {
  if (['resolved', 'closed'].includes(c.status)) return '<span class="muted">—</span>';
  const t = !c.firstRespondedAt ? c.firstResponseDueAt : c.resolveDueAt;
  const mins = Math.round((new Date(t).getTime() - Date.now()) / 60_000);
  const label = !c.firstRespondedAt ? 'answer' : 'resolve';
  const txt = mins < 0 ? `${label} overdue ${fmt.dur(-mins * 60)}` : `${label} in ${fmt.dur(mins * 60)}`;
  return mins < 0 || c.breached ? `<span style="color:var(--crit)">${esc(txt)}</span>` : mins < 60 ? `<span style="color:var(--warn)">${esc(txt)}</span>` : `<span class="cell-sub">${esc(txt)}</span>`;
};

registerView('support', {
  title: 'Support',
  icon: 'users',
  group: 'operate',
  order: 6,
  perm: 'session:read',
  async render(root) {
    const canWrite = state.can('session:write');
    root.innerHTML = pageHead('Support',
      'What drivers report, whichever way they write: the app ("Laporkan masalah" on a receipt), e-mail and WhatsApp. Each case is linked to the session, charger and payment it is about, with its answer and resolution times.',
      `${canWrite ? `<button class="btn" type="button" data-macros>Macros</button><button class="btn" type="button" data-settings>${icon('gear')} Settings</button><button class="btn primary" type="button" data-new>${icon('plus')} New case</button>` : ''}`)
      + `<div class="grid k4" data-kpis></div>
      <div class="filters">${field('Show', '<select data-st><option value="active">Active</option><option value="new">New</option><option value="open">Open</option><option value="pending">Waiting on customer</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select>')}
        ${field('Priority', `<select data-pr>${options(Object.keys(PRIO).map((k) => ({ value: k, label: PRIO[k][1] })), '', { blank: 'Any' })}</select>`)}
        ${field('Assigned', '<select data-as><option value="">Anyone</option><option value="me">Me</option><option value="none">Nobody</option></select>')}
        ${field('Search', '<input type="search" data-q placeholder="PS-12, subject, customer">')}</div>
      <div class="card section" data-list></div>`;
    let settingsCache = null, macrosCache = [], users = [];
    const draw = async () => {
      const q = new URLSearchParams({ status: $('[data-st]', root).value });
      if ($('[data-pr]', root).value) q.set('priority', $('[data-pr]', root).value);
      if ($('[data-as]', root).value) q.set('assignee', $('[data-as]', root).value);
      if ($('[data-q]', root).value.trim()) q.set('q', $('[data-q]', root).value.trim());
      let d, st;
      try { [d, st] = await Promise.all([api(`/v1/support/cases?${q}`), api('/v1/support/stats?days=30')]); } catch (e) { $('[data-list]', root).innerHTML = callout('crit', esc(e.message)); return; }
      $('[data-kpis]', root).innerHTML = kpi('Active', fmt.num(d.counts.active), `${fmt.num(d.counts.new)} new · ${fmt.num(d.counts.unassigned)} unassigned`)
        + kpi('Past SLA', fmt.num(d.counts.breached), 'active cases', d.counts.breached ? 'crit' : '')
        + kpi('First answer', st.medianFirstAnswerMinutes == null ? '—' : fmt.dur(st.medianFirstAnswerMinutes * 60), 'median, 30 days')
        + kpi('Satisfaction', st.satisfaction == null ? '—' : `${st.satisfaction}/5`, `${fmt.num(st.rated)} rated · ${fmt.num(st.opened)} opened`);
      table($('[data-list]', root), {
        columns: [
          { label: 'Case', render: (c) => `<div class="cell-title">${esc(c.subject)}</div><div class="cell-sub mono">${esc(c.ref)}</div>` },
          { label: 'Customer', render: (c) => `${esc(c.customerName ?? c.customerEmail ?? c.customerPhone ?? '—')}<div class="cell-sub">${esc(CHANNEL[c.channel])}${c.charger ? ` · ${esc(c.charger)}` : ''}</div>` },
          { label: 'Status', render: (c) => `${tag(...STATUS[c.status])} ${tag(...PRIO[c.priority])}${c.breached ? ` ${tag('t-crit', 'past SLA')}` : ''}<div class="cell-sub">${esc(CATS[c.category])}</div>` },
          { label: 'Due', render: due },
          { label: 'Assigned', render: (c) => (c.assignee ? esc(c.assignee) : '<span class="muted">nobody</span>') },
          { label: 'Updated', render: (c) => esc(fmt.time(c.updatedAt)) },
        ],
        rows: d.cases, empty: 'No cases here.', onRow: (c) => openCase(c.id),
      });
    };
    const loadSide = async () => {
      if (!macrosCache.length) macrosCache = (await api('/v1/support/macros').catch(() => ({ macros: [] }))).macros;
      if (!users.length && state.can('user:read')) users = await api('/v1/users').then((r) => (Array.isArray(r) ? r : r.users ?? [])).catch(() => []);
    };
    const openCase = async (id) => {
      await loadSide();
      let c;
      try { c = await api(`/v1/support/cases/${id}`); } catch (e) { toast(e.message, 'crit'); return; }
      const thread = (c) => c.messages.map((m) => `<div style="margin:0 0 10px;${m.author === 'customer' ? '' : 'margin-left:24px;'}padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:${m.internal ? 'color-mix(in srgb, var(--warn) 12%, var(--panel-2))' : m.author === 'customer' ? 'var(--panel-2)' : 'transparent'}">
          <div class="cell-sub">${m.internal ? 'Internal note' : m.author === 'customer' ? 'Customer' : esc(m.by ?? 'Staff')} · ${esc(CHANNEL[m.channel] ?? m.channel)} · ${esc(fmt.time(m.at))}${m.delivery === 'failed' ? ` · ${tag('t-crit', 'not sent')} ${esc(m.deliveryError ?? '')}` : ''}</div>
          <div style="white-space:pre-wrap;margin-top:4px">${esc(m.body)}</div></div>`).join('');
      const s = c.session;
      const about = `<dl class="kv">
          <dt>Customer</dt><dd>${esc(c.customerName ?? '—')}${c.customerEmail ? `<div class="cell-sub">${esc(c.customerEmail)}</div>` : ''}${c.customerPhone ? `<div class="cell-sub">${esc(c.customerPhone)}</div>` : ''}</dd>
          <dt>Channel</dt><dd>${esc(CHANNEL[c.channel])}</dd>
          ${c.charger ? `<dt>Charger</dt><dd>${esc(c.charger)}<div class="cell-sub">${esc(c.site ?? '')}</div></dd>` : ''}
          ${s ? `<dt>Session</dt><dd>${esc(fmt.time(s.startedAt))} · ${fmt.num(s.kwh, 2)} kWh${s.totalMinor != null ? ` · ${esc(fmt.money(s.totalMinor, s.currency))}` : ''}
            <div class="cell-sub">payment ${esc(s.paymentState ?? '—')}${s.refundState ? ` · refund ${esc(s.refundState)}` : ''}</div><div><a href="#/sessions/${encodeURIComponent(s.id)}">Open the session</a></div></dd>` : ''}
          ${c.otherCases.length ? `<dt>Other cases</dt><dd>${c.otherCases.map((o) => `<div class="cell-sub">${esc(o.ref)} · ${esc(o.subject)} · ${esc(o.status)}</div>`).join('')}</dd>` : ''}
        </dl>`;
      const controls = canWrite ? `<div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px">
          ${field('Status', `<select data-cst>${options(['open', 'pending', 'resolved', 'closed'].map((k) => ({ value: k, label: STATUS[k][1] })), c.status === 'new' ? '' : c.status, { blank: c.status === 'new' ? 'new' : undefined })}</select>`)}
          ${field('Priority', `<select data-cpr>${options(Object.keys(PRIO).map((k) => ({ value: k, label: PRIO[k][1] })), c.priority)}</select>`)}
          ${field('Category', `<select data-cca>${options(Object.entries(CATS).map(([value, label]) => ({ value, label })), c.category)}</select>`)}
          ${users.length ? field('Assigned', `<select data-cas>${options(users.filter((u) => !u.disabled_at && !u.deactivated_at).map((u) => ({ value: u.id, label: u.name ?? u.email })), c.assigneeId ?? '', { blank: 'Nobody' })}</select>`) : ''}</div>` : '';
      const composer = canWrite ? `<div class="stack" style="gap:8px;margin-top:12px">
          <textarea data-body rows="4" placeholder="Reply to the customer${c.channel === 'console' ? ' (recorded on the case)' : ` (sent by ${CHANNEL[c.channel]})`}"></textarea>
          <div class="row" style="gap:8px;flex-wrap:wrap">${macrosCache.length ? `<select data-macro>${options(macrosCache.map((m) => ({ value: m.id, label: m.name })), '', { blank: 'Use a macro…' })}</select>` : ''}
            <label class="row" style="gap:6px"><input type="checkbox" data-internal> Internal note</label>
            <button class="btn primary right" type="button" data-send>Send</button></div></div>` : '';
      const d = drawer({ title: `${c.ref} · ${c.subject}`, subtitle: `${tag(...STATUS[c.status])} ${tag(...PRIO[c.priority])}${c.breached ? ` ${tag('t-crit', 'past SLA')}` : ''}`,
        tabs: [{ id: 'case', label: 'Conversation', render: (el) => {
          el.innerHTML = `${controls}<div data-thread>${thread(c)}</div>${composer}`;
          const upd = async (b) => { try { await api(`/v1/support/cases/${c.id}`, { method: 'PUT', body: b }); toast('Saved.', 'ok'); draw(); } catch (err) { toast(err.message, 'crit'); } };
          $('[data-cst]', el)?.addEventListener('change', (e) => e.target.value && upd({ status: e.target.value }));
          $('[data-cpr]', el)?.addEventListener('change', (e) => upd({ priority: e.target.value }));
          $('[data-cca]', el)?.addEventListener('change', (e) => upd({ category: e.target.value }));
          $('[data-cas]', el)?.addEventListener('change', (e) => upd({ assigneeId: e.target.value || null }));
          $('[data-macro]', el)?.addEventListener('change', (e) => { const m = macrosCache.find((x) => x.id === e.target.value); if (m) $('[data-body]', el).value = m.body; });
          $('[data-send]', el)?.addEventListener('click', async (e) => {
            const body = $('[data-body]', el).value.trim();
            if (!body) { toast('Write a reply first.', 'warn'); return; }
            e.currentTarget.disabled = true;
            const m = macrosCache.find((x) => x.id === $('[data-macro]', el)?.value && x.body === body);
            try {
              c = await api(`/v1/support/cases/${c.id}/messages`, { method: 'POST', body: { body, internal: $('[data-internal]', el).checked, ...(m ? { macroId: m.id } : {}) } });
              $('[data-thread]', el).innerHTML = thread(c); $('[data-body]', el).value = '';
              const last = c.messages[c.messages.length - 1];
              toast(last?.delivery === 'failed' ? `Saved, but not sent: ${last.deliveryError}` : 'Sent.', last?.delivery === 'failed' ? 'warn' : 'ok');
              draw();
            } catch (err) { toast(err.message, 'crit'); }
            e.currentTarget.disabled = false;
          });
        } }, { id: 'about', label: 'About', render: (el) => { el.innerHTML = about; } }] });
      void d;
    };
    const settingsModal = async () => {
      settingsCache = await api('/v1/support/settings');
      const s = settingsCache;
      const row = (p) => `<tr><td>${esc(PRIO[p][1])}</td><td><input type="number" min="5" max="20160" name="f-${p}" value="${s.sla[p].first}" style="width:100px"></td><td><input type="number" min="5" max="43200" name="r-${p}" value="${s.sla[p].resolve}" style="width:100px"></td></tr>`;
      modal({ title: 'Support settings', size: 'lg', body: `<div class="form">
          <label class="row" style="gap:6px"><input type="checkbox" name="en" ${s.enabled ? 'checked' : ''}> The desk is on: drivers can report a problem in the app, and e-mail and WhatsApp open cases</label>
          <label class="row" style="gap:6px"><input type="checkbox" name="ack" ${s.autoAcknowledge ? 'checked' : ''}> Acknowledge e-mails with the case number</label>
          <div><b>SLA</b> <span class="cell-sub">minutes to the first answer and to resolution</span>
            <table class="table" style="margin-top:6px"><thead><tr><th>Priority</th><th>First answer</th><th>Resolution</th></tr></thead><tbody>${['urgent', 'high', 'normal', 'low'].map(row).join('')}</tbody></table></div>
          <div><b>Inbound e-mail</b><div class="cell-sub">Have your e-mail provider forward the support address to <span class="mono">${esc(location.origin)}/v1/support/inbound-email/&lt;key&gt;</span> as JSON {from, fromName, subject, text}. ${s.inboundKeyPrefix ? `Current key: <span class="mono">${esc(s.inboundKeyPrefix)}…</span>` : 'No key yet.'}</div>
            <button class="btn sm" type="button" data-key style="margin-top:6px">${s.inboundKeyPrefix ? 'Replace the key' : 'Create a key'}</button><div data-keyout></div></div></div>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          const sla = {};
          for (const p of ['urgent', 'high', 'normal', 'low']) sla[p] = { first: Number($(`[name="f-${p}"]`, mc.el).value), resolve: Number($(`[name="r-${p}"]`, mc.el).value) };
          await api('/v1/support/settings', { method: 'PUT', body: { enabled: $('[name="en"]', mc.el).checked, autoAcknowledge: $('[name="ack"]', mc.el).checked, sla } });
          toast('Saved.', 'ok');
        }) }],
        onMount: (mc) => $('[data-key]', mc.el).addEventListener('click', async () => {
          try {
            const k = await api('/v1/support/settings/inbound-key', { method: 'POST' });
            $('[data-keyout]', mc.el).innerHTML = callout('warn', `Copy it now, it is not shown again: <span class="mono">${esc(k.key)}</span> <button class="btn sm" type="button" data-cp>Copy</button>`);
            $('[data-cp]', mc.el).addEventListener('click', () => copy(`${location.origin}/v1/support/inbound-email/${k.key}`));
          } catch (err) { toast(err.message, 'crit'); }
        }) });
    };
    const macrosModal = async () => {
      macrosCache = (await api('/v1/support/macros')).macros;
      const edit = (m) => modal({ title: m ? `Edit ${m.name}` : 'New macro', body: `<div class="form">${field('Name', `<input name="n" value="${esc(m?.name ?? '')}">`)}
          ${field('Reply', `<textarea name="b" rows="6">${esc(m?.body ?? '')}</textarea>`, { help: '{{name}}, {{number}}, {{charger}} and {{site}} are filled in.' })}
          ${field('Then set the status', `<select name="s">${options([{ value: 'open', label: 'open' }, { value: 'pending', label: 'waiting on customer' }, { value: 'resolved', label: 'resolved' }], m?.setStatus ?? '', { blank: 'Leave it' })}</select>`)}</div>`,
        actions: [...(m ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/support/macros/${m.id}`, { method: 'PUT', body: { archive: true } }); macrosCache = []; toast('Archived.', 'ok'); }) }] : []),
          { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
            const b = { name: $('[name="n"]', mc.el).value, body: $('[name="b"]', mc.el).value, setStatus: $('[name="s"]', mc.el).value || null };
            await api(m ? `/v1/support/macros/${m.id}` : '/v1/support/macros', { method: m ? 'PUT' : 'POST', body: b });
            macrosCache = []; toast('Saved.', 'ok');
          }) }] });
      modal({ title: 'Macros', body: `<div data-ml></div><button class="btn sm" type="button" data-mnew style="margin-top:8px">${icon('plus')} New macro</button>`, actions: [{ label: 'Close' }],
        onMount: (mc) => {
          table($('[data-ml]', mc.el), { columns: [{ label: 'Name', render: (m) => esc(m.name) }, { label: 'Sets', render: (m) => esc(m.setStatus ?? '—') }], rows: macrosCache, empty: 'No macros yet.', onRow: (m) => edit(m) });
          $('[data-mnew]', mc.el).addEventListener('click', () => edit(null));
        } });
    };
    $('[data-new]', root)?.addEventListener('click', () => modal({ title: 'New case', body: `<div class="form">${field('Subject', '<input name="s" maxlength="200">')}
        ${field('What happened', '<textarea name="b" rows="4"></textarea>')}
        ${field('Category', `<select name="c">${options(Object.entries(CATS).map(([value, label]) => ({ value, label })), 'other')}</select>`)}
        ${field('Priority', `<select name="p">${options(Object.keys(PRIO).map((k) => ({ value: k, label: PRIO[k][1] })), 'normal')}</select>`)}
        ${field('Customer name', '<input name="cn">')}${field('Customer e-mail', '<input name="ce" type="email">', { help: 'Replies are e-mailed only for e-mail cases; this one is recorded here.' })}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Open the case', kind: 'primary', onClick: guard(async (mc) => {
        const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
        const c = await api('/v1/support/cases', { method: 'POST', body: { subject: v('s'), body: v('b'), category: v('c'), priority: v('p'), customerName: v('cn') || null, customerEmail: v('ce') || null } });
        toast(`${c.ref} opened.`, 'ok'); draw(); openCase(c.id);
      }) }] }));
    $('[data-settings]', root)?.addEventListener('click', () => settingsModal().catch((e) => toast(e.message, 'crit')));
    $('[data-macros]', root)?.addEventListener('click', () => macrosModal().catch((e) => toast(e.message, 'crit')));
    for (const s of ['[data-st]', '[data-pr]', '[data-as]']) $(s, root).addEventListener('change', draw);
    let t = null;
    $('[data-q]', root).addEventListener('input', () => { clearTimeout(t); t = setTimeout(draw, 300); });
    await draw();
  },
});
