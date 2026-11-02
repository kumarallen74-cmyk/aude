import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options, download } from '../core.js';

/**
 * (v1.48.0) Govern → Privacy (UU PDP): drivers' data requests with their deadlines (verify who it is, then complete
 * or reject), the personal data inventory, consent records and the retention of plates, survey comments and support
 * cases.
 */

const KIND = { access: 'Access', export: 'Copy (export)', correction: 'Correction', erasure: 'Erasure', objection: 'Objection' };
const ST = { new: ['t-warn', 'to verify'], verified: ['t-info', 'verified'], done: ['t-ok', 'done'], rejected: ['t-mute', 'rejected'] };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const left = (iso) => { const h = Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000); return h < 0 ? `${-h} h overdue` : h < 48 ? `${h} h left` : `${Math.round(h / 24)} days left`; };

registerView('privacy', {
  title: 'Privacy',
  icon: 'shield',
  group: 'govern',
  order: 64,
  perm: 'org:read',
  async render(root) {
    const canWrite = state.can('org:write');
    root.innerHTML = pageHead('Privacy', 'Drivers\' requests about their personal data (UU PDP) and their deadlines, what personal data is held and for how long, and consent records.',
      canWrite ? `<button class="btn" type="button" data-settings>${icon('gear')} Settings</button><button class="btn primary" type="button" data-add>${icon('plus')} Record a request</button>` : '')
      + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    let all = false;

    const settingsModal = async () => {
      const s = await api('/v1/privacy/settings');
      modal({ title: 'Privacy settings', size: 'lg', body: `<div class="form grid2">${field('Data protection officer', `<input name="dpo" maxlength="120" value="${esc(s.dpoName ?? '')}">`)}
          ${field('Their e-mail', `<input name="email" type="email" value="${esc(s.dpoEmail ?? '')}">`)}
          ${field('Answer requests within (hours)', `<input name="hours" type="number" min="24" max="2160" value="${s.responseHours}">`, { help: '72 hours = 3 × 24 hours.' })}
          ${field('Clear plates after (days)', `<input name="plates" type="number" min="7" max="3650" value="${s.plateRetentionDays ?? ''}">`, { help: 'Camera reads and finished parking stays. Empty: kept.' })}
          ${field('Clear survey comments after (days)', `<input name="survey" type="number" min="30" max="3650" value="${s.surveyCommentDays ?? ''}">`)}
          ${field('Clear closed support cases after (days)', `<input name="cases" type="number" min="90" max="3650" value="${s.supportCaseDays ?? ''}">`, { help: 'The customer\'s details and the messages.' })}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
          const n = (k) => (v(k) === '' ? null : Number(v(k)));
          await api('/v1/privacy/settings', { method: 'PUT', body: { dpoName: v('dpo') || null, dpoEmail: v('email') || null, responseHours: Number(v('hours')), plateRetentionDays: n('plates'), surveyCommentDays: n('survey'), supportCaseDays: n('cases') } });
          toast('Saved.', 'ok'); draw();
        }) }] });
    };

    const addModal = () => modal({ title: 'Record a data request', body: `<div class="form grid2">${field('Request', `<select name="kind">${options(Object.entries(KIND).map(([value, label]) => ({ value, label })), 'access')}</select>`)}
        ${field('Received by', `<select name="ch">${options([{ value: 'email', label: 'E-mail' }, { value: 'console', label: 'Phone or in person' }, { value: 'other', label: 'Other' }], 'email')}</select>`)}
        ${field('Name', '<input name="name" maxlength="120">')}${field('Phone number', '<input name="phone" maxlength="20" placeholder="Finds their account">')}
        ${field('E-mail', '<input name="email" type="email">')}${field('Details', '<textarea name="details" rows="3" maxlength="5000"></textarea>', { full: true })}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Record', kind: 'primary', onClick: guard(async (mc) => {
        const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
        const r = await api('/v1/privacy/requests', { method: 'POST', body: { kind: v('kind'), channel: v('ch'), subjectName: v('name') || null, subjectPhone: v('phone') || null, subjectEmail: v('email') || null, details: v('details') || null } });
        toast(`${r.number} recorded${r.appDriverId ? ' and linked to the account' : ''}. Due ${fmt.time(r.dueAt)}.`, 'ok'); draw();
      }) }] });

    const requestModal = (r) => {
      const actions = [{ label: 'Close' }];
      if (canWrite && r.status === 'new') actions.push({ label: 'Verify', kind: 'primary', onClick: guard(async (mc) => {
        await api(`/v1/privacy/requests/${r.id}/verify`, { method: 'POST', body: { verification: $('[name="how"]', mc.el).value } }); toast('Verified.', 'ok'); draw();
      }) });
      if (canWrite && ['new', 'verified'].includes(r.status)) actions.splice(1, 0, { label: 'Reject', kind: 'danger', onClick: guard(async (mc) => {
        await api(`/v1/privacy/requests/${r.id}/close`, { method: 'POST', body: { action: 'reject', outcome: $('[name="outcome"]', mc.el).value } }); draw();
      }) });
      if (canWrite && r.status === 'verified') actions.push({ label: r.kind === 'erasure' ? 'Erase the account' : 'Complete', kind: r.kind === 'erasure' ? 'danger' : 'primary', onClick: guard(async (mc) => {
        if (r.kind === 'erasure' && !confirm('Erase this driver\'s account? This cannot be undone.')) return false;
        const b = { action: 'complete', outcome: $('[name="outcome"]', mc.el).value || null };
        if (r.kind === 'correction') { const n = $('[name="cname"]', mc.el).value.trim(), e = $('[name="cemail"]', mc.el).value.trim(); if (n) b.name = n; if (e) b.email = e; }
        await api(`/v1/privacy/requests/${r.id}/close`, { method: 'POST', body: b }); toast('Done.', 'ok'); draw();
      }) });
      modal({ title: `${r.number} · ${KIND[r.kind]}`, size: 'lg', actions,
        body: `<p>${tag(...(ST[r.status] ?? ['t-mute', r.status]))} ${r.closedAt ? '' : `<b>${esc(left(r.dueAt))}</b> · due ${esc(fmt.time(r.dueAt))}`}</p>
          <p class="cell-sub">${esc([r.subjectName, r.subjectPhone, r.subjectEmail].filter(Boolean).join(' · ') || 'Unknown person')} · ${r.appDriverId ? 'account found' : 'no account linked'} · via ${esc(r.channel)} · received ${esc(fmt.time(r.receivedAt))}</p>
          ${r.details ? `<p>${esc(r.details)}</p>` : ''}${r.verification ? `<p class="cell-sub">Verified: ${esc(r.verification)}</p>` : ''}${r.outcome ? `<p class="cell-sub">Outcome: ${esc(r.outcome)}</p>` : ''}
          ${r.status === 'done' && ['access', 'export'].includes(r.kind) ? `<button class="btn sm" type="button" data-exp>${icon('download')} The copy (JSON)</button>` : ''}
          <div class="form" style="margin-top:10px">${r.status === 'new' ? field('How the identity was checked', '<input name="how" maxlength="500" placeholder="For example: called back on the account\'s number">') : ''}
            ${r.status === 'verified' && r.kind === 'correction' ? `${field('Corrected name', '<input name="cname" maxlength="120">')}${field('Corrected e-mail', '<input name="cemail" type="email">')}` : ''}
            ${['new', 'verified'].includes(r.status) ? field('Outcome (told to the person)', '<textarea name="outcome" rows="2" maxlength="2000"></textarea>') : ''}</div>`,
        onMount: (mc) => $('[data-exp]', mc.el)?.addEventListener('click', async () => { try { download(`${r.number}.json`, await api(`/v1/privacy/requests/${r.id}/export.json`, { raw: true }).then((x) => x.blob())); } catch (e) { toast(e.message, 'crit'); } }) });
    };

    const draw = async () => {
      let reqs, inv, cons, s;
      try { [{ requests: reqs }, { inventory: inv }, cons, s] = await Promise.all([api(`/v1/privacy/requests${all ? '?status=all' : ''}`), api('/v1/privacy/inventory'), api('/v1/privacy/consents'), api('/v1/privacy/settings')]); }
      catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const open = reqs.filter((r) => ['new', 'verified'].includes(r.status));
      body.innerHTML = `${open.some((r) => r.overdue) ? callout('crit', `${open.filter((r) => r.overdue).length} request${open.filter((r) => r.overdue).length === 1 ? ' is' : 's are'} past the deadline.`) : ''}
        ${!s.dpoName ? callout('info', 'No data protection officer named yet (Settings).') : ''}
        <div class="grid k4">${kpi('Open requests', fmt.num(open.length))}${kpi('Due within a day', fmt.num(open.filter((r) => new Date(r.dueAt) - Date.now() < 86_400_000).length), '', open.some((r) => new Date(r.dueAt) - Date.now() < 86_400_000) ? 'warn' : '')}
          ${kpi('Answer within', `${s.responseHours} h`)}${kpi('Marketing consent', fmt.num(cons.summary.find((x) => x.purpose === 'marketing')?.granted ?? 0), 'drivers now')}</div>
        <div class="card section"><header><h3>Requests</h3><label class="right cell-sub"><input type="checkbox" data-all ${all ? 'checked' : ''}> Closed too</label></header><div data-r></div></div>
        <div class="card section"><header><h3>Personal data held</h3></header><div data-i></div></div>
        <div class="card section"><header><h3>Consents</h3><span class="cell-sub">${cons.summary.map((x) => `${esc(x.purpose)}: ${x.granted} of ${x.drivers}`).join(' · ')}</span></header><div data-c></div></div>`;
      table($('[data-r]', body), { columns: [{ label: 'Request', render: (r) => `<b>${esc(r.number)}</b> ${esc(KIND[r.kind])}<div class="cell-sub">${esc(r.subjectName ?? r.subjectPhone ?? r.subjectEmail ?? '')}</div>` },
        { label: 'Status', render: (r) => tag(...(ST[r.status] ?? ['t-mute', r.status])) }, { label: 'Due', render: (r) => (r.closedAt ? `<span class="cell-sub">closed ${esc(fmt.time(r.closedAt))}</span>` : `${r.overdue ? tag('t-crit', left(r.dueAt)) : esc(left(r.dueAt))}`) },
        { label: 'Via', key: 'channel' }], rows: reqs, empty: 'No requests.', onRow: (r) => requestModal(r) });
      table($('[data-i]', body), { columns: [{ label: 'Data', render: (x) => `<b>${esc(x.category)}</b><div class="cell-sub">${esc(x.data)}</div>` }, { label: 'Why', render: (x) => `${esc(x.purpose)}<div class="cell-sub">${esc(x.basis)}</div>` },
        { label: 'Kept', key: 'retention' }, { label: 'Records', num: true, render: (x) => fmt.num(x.records) }], rows: inv });
      table($('[data-c]', body), { columns: [{ label: 'When', render: (x) => esc(fmt.time(x.at)) }, { label: 'Driver', key: 'driver' }, { label: 'Purpose', key: 'purpose' },
        { label: '', render: (x) => tag(x.granted ? 't-ok' : 't-mute', x.granted ? 'granted' : 'withdrawn') }, { label: 'From', key: 'source' }], rows: cons.log.slice(0, 50), empty: 'No consent records yet.' });
      $('[data-all]', body).addEventListener('change', (e) => { all = e.target.checked; draw(); });
    };

    $('[data-settings]', root)?.addEventListener('click', () => settingsModal().catch((e) => toast(e.message, 'crit')));
    $('[data-add]', root)?.addEventListener('click', addModal);
    await draw();
  },
});
