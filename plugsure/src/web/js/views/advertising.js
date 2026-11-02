import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options, copy, download } from '../core.js';

/**
 * (v1.51.0) Commercial → Advertising: ads on charger and kiosk screens. Campaigns for advertisers (per thousand plays
 * or flat per month), creatives reviewed before they play, the screens and their players, proof of play and monthly
 * invoices.
 */

const CST = { draft: ['t-mute', 'draft'], active: ['t-ok', 'running'], paused: ['t-warn', 'paused'], ended: ['t-mute', 'ended'] };
const REV = { pending: ['t-warn', 'to review'], approved: ['t-ok', 'approved'], rejected: ['t-crit', 'rejected'] };
const INV = { draft: ['t-mute', 'draft'], issued: ['t-warn', 'issued'], paid: ['t-ok', 'paid'], void: ['t-mute', 'void'] };
const TABS = [['c', 'Campaigns'], ['s', 'Screens'], ['a', 'Advertisers'], ['i', 'Invoices']];
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const readFile = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });

registerView('advertising', {
  title: 'Advertising',
  icon: 'play',
  group: 'commercial',
  order: 28,
  perm: 'invoice:read',
  async render(root) {
    const canWrite = state.can('invoice:write');
    const canScreens = state.can('site:write');
    root.innerHTML = pageHead('Advertising', 'Ads on charger and kiosk screens: campaigns for advertisers, creatives reviewed before they play, proof of play and monthly invoices.',
      canWrite ? `<button class="btn" type="button" data-settings>${icon('gear')} Settings</button>` : '')
      + `<div class="tabs" role="tablist">${TABS.map(([id, l]) => `<button role="tab" type="button" data-tab="${id}">${l}</button>`).join('')}</div><div data-body class="stack" style="gap:14px"></div>`;
    const body = $('[data-body]', root);
    let tab = 'c', st = null, advs = [], sites = [];

    const showOnce = (title, text, value) => modal({ title, body: `${callout('warn', text)}<div style="display:flex;gap:6px;margin-top:8px"><input readonly value="${esc(value)}" style="flex:1"><button class="btn" type="button" data-cpy>${icon('copy')} Copy</button></div>`,
      onMount: (mc) => $('[data-cpy]', mc.el).addEventListener('click', () => copy(value)) });

    const settingsModal = () => modal({ title: 'Advertising settings', body: `<div class="form grid2">${field('Advertising', `<select name="en">${options([{ value: '1', label: 'On (screens play campaigns)' }, { value: '0', label: 'Off' }], st.enabled ? '1' : '0')}</select>`)}
        ${field('Tax on advertising invoices (%)', `<input name="tax" type="number" min="0" max="50" step="0.01" value="${st.taxBps / 100}">`)}
        ${field('Default slot (seconds)', `<input name="slot" type="number" min="5" max="120" value="${st.slotSeconds}">`)}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
      const v = (n) => $(`[name="${n}"]`, mc.el).value;
      await api('/v1/advertising/settings', { method: 'PUT', body: { enabled: v('en') === '1', taxBps: Math.round(Number(v('tax') || 0) * 100), slotSeconds: Number(v('slot')) } });
      toast('Saved.', 'ok'); draw();
    }) }] });

    const advModal = (a) => modal({ title: a ? a.name : 'Add an advertiser', body: `<div class="form grid2">${field('Name', `<input name="name" maxlength="120" value="${esc(a?.name ?? '')}">`)}
        ${field('Contact', `<input name="contact" maxlength="120" value="${esc(a?.contactName ?? '')}">`)}${field('E-mail', `<input name="email" type="email" value="${esc(a?.email ?? '')}">`)}
        ${field('Phone', `<input name="phone" maxlength="30" value="${esc(a?.phone ?? '')}">`)}${field('Tax id', `<input name="tax" maxlength="40" value="${esc(a?.taxId ?? '')}">`)}
        ${field('Billing address', `<textarea name="addr" rows="2" maxlength="300">${esc(a?.address ?? '')}</textarea>`, { full: true })}</div>`,
    actions: [...(a ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/advertisers/${a.id}`, { method: 'PUT', body: { archive: true } }); draw(); }) }] : []),
      { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
        const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
        await api(a ? `/v1/advertisers/${a.id}` : '/v1/advertisers', { method: a ? 'PUT' : 'POST', body: { name: v('name'), contactName: v('contact') || null, email: v('email') || null, phone: v('phone') || null, taxId: v('tax') || null, address: v('addr') || null } });
        toast('Saved.', 'ok'); draw();
      }) }] });

    const screenModal = async (s) => {
      const chargers = await api('/v1/charge-points').then((r) => (Array.isArray(r) ? r : r.chargePoints ?? r.items ?? [])).catch(() => []);
      modal({ title: s ? s.name : 'Add a screen', body: `<div class="form grid2">${field('Site', `<select name="site">${options(sites.map((x) => ({ value: x.id, label: x.name })), s?.siteId ?? '')}</select>`)}
          ${field('Charger', `<select name="cp">${options(chargers.map((c) => ({ value: c.id, label: c.display_name || c.displayName || c.ocpp_identity || c.ocppIdentity || c.id })), s?.chargePointId ?? '', { blank: 'None (a kiosk)' })}</select>`)}
          ${field('Name', `<input name="name" maxlength="120" value="${esc(s?.name ?? '')}">`)}
          ${field('Orientation', `<select name="or">${options([{ value: 'landscape', label: 'Landscape' }, { value: 'portrait', label: 'Portrait' }], s?.orientation ?? 'landscape')}</select>`)}
          ${s ? field('Status', `<select name="st">${options([{ value: 'active', label: 'Playing' }, { value: 'off', label: 'Off' }], s.status)}</select>`) : ''}</div>`,
      actions: [...(s ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/ad-screens/${s.id}`, { method: 'PUT', body: { archive: true } }); draw(); }) },
        { label: 'New key', onClick: guard(async () => { const r = await api(`/v1/ad-screens/${s.id}`, { method: 'PUT', body: { rotateKey: true } }); showOnce('The screen\'s player address', 'Shown once: set it in the screen\'s player (see ADVERTISING.md).', `${location.origin}/v1/ad-player/${r.key}`); }) }] : []),
        { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name="${n}"]`, mc.el)?.value;
          const r = await api(s ? `/v1/ad-screens/${s.id}` : '/v1/ad-screens', { method: s ? 'PUT' : 'POST', body: { siteId: v('site'), chargePointId: v('cp') || null, name: v('name').trim(), kind: v('cp') ? 'charger' : 'kiosk', orientation: v('or'), ...(s ? { status: v('st') } : {}) } });
          if (r.key) showOnce('The screen\'s player address', 'Shown once: set it in the screen\'s player (see ADVERTISING.md).', `${location.origin}/v1/ad-player/${r.key}`); else toast('Saved.', 'ok');
          draw();
        }) }] });
    };

    const campaignForm = (c) => modal({ title: c ? `Change ${c.name}` : 'New campaign', size: 'lg', body: `<div class="form grid2">${field('Advertiser', `<select name="adv">${options(advs.filter((a) => !a.archived).map((a) => ({ value: a.id, label: a.name })), c?.advertiserId ?? '')}</select>`)}
        ${field('Name', `<input name="name" maxlength="120" value="${esc(c?.name ?? '')}">`)}
        ${field('From', `<input name="from" type="date" value="${esc(c?.startsOn ?? '')}">`)}${field('To', `<input name="to" type="date" value="${esc(c?.endsOn ?? '')}">`)}
        ${field('Pricing', `<select name="pr">${options([{ value: 'cpm', label: 'Per thousand plays (CPM)' }, { value: 'flat', label: 'Flat per month' }], c?.pricing ?? 'cpm')}</select>`)}
        ${field(`Rate (${esc(st.currency)}, minor units)`, `<input name="rate" type="number" min="0" value="${c?.rateMinor ?? ''}">`)}
        ${field('Budget (CPM, minor units)', `<input name="budget" type="number" min="1" value="${c?.budgetMinor ?? ''}">`, { help: 'It stops playing once spent. Empty: no cap.' })}
        ${field('Share of the rotation (1–10)', `<input name="w" type="number" min="1" max="10" value="${c?.weight ?? 1}">`)}
        ${field('Sites', `<select name="sites" multiple size="5">${sites.map((x) => `<option value="${esc(x.id)}"${(c?.siteIds ?? []).includes(x.id) ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`, { full: true, help: 'None selected: every site with a screen.' })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
      const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
      const r = await api(c ? `/v1/ad-campaigns/${c.id}` : '/v1/ad-campaigns', { method: c ? 'PUT' : 'POST', body: { advertiserId: v('adv'), name: v('name'), startsOn: v('from'), endsOn: v('to'), pricing: v('pr'),
        rateMinor: Number(v('rate') || 0), budgetMinor: v('budget') === '' ? null : Number(v('budget')), weight: Number(v('w') || 1), siteIds: [...$('[name="sites"]', mc.el).selectedOptions].map((o) => o.value) } });
      toast('Saved.', 'ok'); draw(); openCampaign(r.id);
    }) }] });

    const openCampaign = async (id) => {
      let c;
      try { c = await api(`/v1/ad-campaigns/${id}`); } catch (e) { toast(e.message, 'crit'); return; }
      const max = Math.max(1, ...c.byDay.map((d) => d.plays));
      const status = (s, extra = {}) => guard(async () => { await api(`/v1/ad-campaigns/${c.id}/status`, { method: 'POST', body: { status: s, ...extra } }); toast('Updated.', 'ok'); draw(); });
      modal({ title: `${c.name} · ${c.advertiser}`, size: 'lg', body: `
        <p>${tag(...CST[c.status])}${c.pausedReason ? ` <span class="cell-sub">${esc(c.pausedReason)}</span>` : ''} · ${esc(c.startsOn)} → ${esc(c.endsOn)} · ${c.pricing === 'cpm' ? `${fmt.money(c.rateMinor, c.currency)} per 1,000 plays${c.budgetMinor ? `, budget ${fmt.money(c.budgetMinor, c.currency)}` : ''}` : `${fmt.money(c.rateMinor, c.currency)} a month`}</p>
        <div class="grid k4">${kpi('Plays', fmt.num(c.plays))}${kpi('Spent', c.spentMinor == null ? '—' : fmt.money(c.spentMinor, c.currency))}${kpi('Charging sessions at its screens', fmt.num(c.sessionsAtScreens))}${kpi('Sites', fmt.num(c.bySite.length))}</div>
        ${c.byDay.length ? `<div style="display:flex;align-items:flex-end;gap:3px;height:80px;margin:12px 0 2px" role="img" aria-label="Plays by day">${c.byDay.slice(-45).map((d) => `<div title="${esc(d.day)}: ${d.plays}" style="flex:1;height:${Math.max(2, Math.round((d.plays / max) * 100))}%;background:var(--accent, #0c7856);opacity:.7;border-radius:2px 2px 0 0"></div>`).join('')}</div><div class="cell-sub">Plays by day</div>` : ''}
        <h4 style="margin:14px 0 6px">Creatives</h4><div data-k></div>
        ${canWrite && c.status !== 'ended' ? `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px"><input type="file" data-file accept="image/jpeg,image/png,image/webp,video/mp4"><input type="number" data-sec min="3" max="120" placeholder="Seconds" style="width:110px"><select data-or style="width:auto">${options([{ value: 'landscape', label: 'Landscape' }, { value: 'portrait', label: 'Portrait' }], 'landscape')}</select><button class="btn sm" data-up>${icon('upload')} Upload</button></div>` : ''}
        ${c.bySite.length ? `<h4 style="margin:14px 0 6px">By site</h4><div data-s></div>` : ''}`,
      actions: [{ label: 'Proof of play', onClick: async () => { try { download(`proof-of-play-${c.id}.xlsx`, await api(`/v1/ad-campaigns/${c.id}/proof.xlsx`, { raw: true }).then((r) => r.blob())); } catch (e) { toast(e.message, 'crit'); } return false; } },
        ...(canWrite && c.status !== 'ended' ? [{ label: 'Change', onClick: () => campaignForm(c) }] : []),
        ...(canWrite && ['draft', 'paused'].includes(c.status) ? [{ label: 'Start', kind: 'primary', onClick: status('active') }] : []),
        ...(canWrite && c.status === 'active' ? [{ label: 'Pause', onClick: status('paused', { reason: 'Paused by the operator' }) }] : []),
        ...(canWrite && c.status !== 'ended' && c.status !== 'draft' ? [{ label: 'End', kind: 'danger', onClick: status('ended') }] : []), { label: 'Close' }],
      onMount: (mc) => {
        table($('[data-k]', mc.el), { columns: [{ label: 'Creative', render: (k) => `<b>${esc(k.name)}</b><div class="cell-sub">${esc(k.mime)} · ${fmt.bytes ? fmt.bytes(k.bytes) : k.bytes} · ${k.seconds} s · ${esc(k.orientation)}</div>` },
          { label: 'Review', render: (k) => `${tag(...REV[k.review])}${k.reviewNote ? `<div class="cell-sub">${esc(k.reviewNote)}</div>` : ''}` }, { label: 'Plays', num: true, render: (k) => fmt.num(k.plays) },
          { label: '', render: (k) => `<button class="btn sm" data-view="${k.id}">View</button>${canWrite ? `${k.review !== 'approved' ? ` <button class="btn sm" data-ok="${k.id}">Approve</button>` : ''}${k.review !== 'rejected' ? ` <button class="btn sm" data-no="${k.id}">Reject</button>` : ''} <button class="btn sm" data-rm="${k.id}">Remove</button>` : ''}` }],
        rows: c.creatives, empty: 'No creatives yet: upload an image or a video.' });
        if (c.bySite.length) table($('[data-s]', mc.el), { columns: [{ label: 'Site', render: (x) => esc(x.site) }, { label: 'Screens', num: true, render: (x) => fmt.num(x.screens) }, { label: 'Plays', num: true, render: (x) => fmt.num(x.plays) }], rows: c.bySite });
        const again = () => { mc.close(); openCampaign(c.id); };
        $$('[data-view]', mc.el).forEach((b) => b.addEventListener('click', async () => {
          try {
            const k = c.creatives.find((x) => x.id === b.dataset.view);
            const url = URL.createObjectURL(await api(`/v1/ad-creatives/${k.id}/file`, { raw: true }).then((r) => r.blob()));
            modal({ title: k.name, size: 'lg', body: k.mime.startsWith('video/') ? `<video src="${url}" controls style="max-width:100%"></video>` : `<img src="${url}" alt="${esc(k.name)}" style="max-width:100%">`, onClose: () => URL.revokeObjectURL(url) });
          } catch (e) { toast(e.message, 'crit'); }
        }));
        const review = async (id, review, note) => { try { await api(`/v1/ad-creatives/${id}/review`, { method: 'POST', body: { review, note } }); again(); } catch (e) { toast(e.message, 'crit'); } };
        $$('[data-ok]', mc.el).forEach((b) => b.addEventListener('click', () => review(b.dataset.ok, 'approved', null)));
        $$('[data-no]', mc.el).forEach((b) => b.addEventListener('click', () => { const note = prompt('Why is it rejected? The advertiser is told.'); if (note) review(b.dataset.no, 'rejected', note); }));
        $$('[data-rm]', mc.el).forEach((b) => b.addEventListener('click', async () => { if (!confirm('Remove this creative? It stops playing.')) return; try { await api(`/v1/ad-creatives/${b.dataset.rm}/remove`, { method: 'POST' }); again(); } catch (e) { toast(e.message, 'crit'); } }));
        $('[data-up]', mc.el)?.addEventListener('click', async () => {
          const f = $('[data-file]', mc.el).files[0];
          if (!f) { toast('Choose a file.', 'warn'); return; }
          if (f.size > 30 * 1024 * 1024) { toast('At most 30 MB a file.', 'crit'); return; }
          try {
            await api(`/v1/ad-campaigns/${c.id}/creatives`, { method: 'POST', body: { name: f.name, dataUrl: await readFile(f), seconds: $('[data-sec]', mc.el).value ? Number($('[data-sec]', mc.el).value) : null, orientation: $('[data-or]', mc.el).value } });
            toast('Uploaded: review it to let it play.', 'ok'); again();
          } catch (e) { toast(e.message, 'crit'); }
        });
      } });
    };

    const draw = async () => {
      $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
      try {
        [st, { advertisers: advs }, sites] = await Promise.all([api('/v1/advertising/settings'), api('/v1/advertisers'), api('/v1/sites').then((r) => (Array.isArray(r) ? r : r.sites ?? []))]);
        const off = st.enabled ? '' : callout('info', 'Advertising is off: screens get an empty playlist. Turn it on in Settings.');
        if (tab === 'c') {
          const { campaigns } = await api('/v1/ad-campaigns');
          const run = campaigns.filter((c) => c.status === 'active');
          const review = campaigns.reduce((a, c) => a + c.pendingReview, 0);
          body.innerHTML = `${off}${review ? callout('warn', `${review} creative${review === 1 ? '' : 's'} to review before they play.`) : ''}
            <div class="grid k4">${kpi('Running', fmt.num(run.length))}${kpi('Plays (running)', fmt.num(run.reduce((a, c) => a + c.plays, 0)))}
              ${kpi('Spent (CPM, running)', fmt.money(run.reduce((a, c) => a + (c.spentMinor ?? 0), 0), st.currency))}${kpi('To review', fmt.num(review), 'creatives', review ? 'warn' : '')}</div>
            <div class="card section"><header><h3>Campaigns</h3>${canWrite ? `<button class="btn sm right" type="button" data-addc>${icon('plus')} New campaign</button>` : ''}</header><div data-t></div></div>`;
          table($('[data-t]', body), { columns: [{ label: 'Campaign', render: (c) => `<b>${esc(c.name)}</b><div class="cell-sub">${esc(c.advertiser ?? '')}</div>` },
            { label: 'Dates', render: (c) => `${esc(c.startsOn)} → ${esc(c.endsOn)}` }, { label: 'Status', render: (c) => `${tag(...CST[c.status])}${c.pendingReview ? `<div class="cell-sub">${c.pendingReview} to review</div>` : ''}` },
            { label: 'Price', num: true, render: (c) => `${fmt.money(c.rateMinor, c.currency)}<div class="cell-sub">${c.pricing === 'cpm' ? 'per 1,000 plays' : 'a month'}</div>` },
            { label: 'Plays', num: true, render: (c) => fmt.num(c.plays) }, { label: 'Spent', num: true, render: (c) => (c.spentMinor == null ? '—' : `${fmt.money(c.spentMinor, c.currency)}${c.budgetMinor ? `<div class="cell-sub">of ${fmt.money(c.budgetMinor, c.currency)}</div>` : ''}`) }],
          rows: campaigns, empty: 'No campaigns yet.', onRow: (c) => openCampaign(c.id) });
          $('[data-addc]', body)?.addEventListener('click', () => (advs.length ? campaignForm(null) : toast('Add an advertiser first.', 'warn')));
        } else if (tab === 's') {
          const { screens } = await api('/v1/ad-screens');
          body.innerHTML = `${off}<div class="card section"><header><h3>Screens</h3>${canScreens ? `<button class="btn sm right" type="button" data-adds>${icon('plus')} Add a screen</button>` : ''}</header><div data-t></div></div>`;
          table($('[data-t]', body), { columns: [{ label: 'Screen', render: (s) => `<b>${esc(s.name)}</b><div class="cell-sub">${esc(s.site ?? '')}${s.charger ? ` · ${esc(s.charger)}` : ''}</div>` },
            { label: 'Kind', render: (s) => `${esc(s.kind)}<div class="cell-sub">${esc(s.orientation)}</div>` },
            { label: 'Player', render: (s) => (s.status === 'off' ? tag('t-mute', 'off') : s.online ? tag('t-ok', 'online') : tag('t-warn', 'not calling', s.lastSeenAt ? `Last: ${fmt.time(s.lastSeenAt)}` : 'Never')) },
            { label: 'Plays (7 days)', num: true, render: (s) => fmt.num(s.plays7d) }, { label: 'Key', render: (s) => (s.keyPrefix ? `<code>${esc(s.keyPrefix)}…</code>` : '—') }],
          rows: screens, empty: 'No screens yet.', onRow: canScreens ? screenModal : undefined });
          $('[data-adds]', body)?.addEventListener('click', () => screenModal(null));
        } else if (tab === 'a') {
          body.innerHTML = `<div class="card section"><header><h3>Advertisers</h3>${canWrite ? `<button class="btn sm right" type="button" data-adda>${icon('plus')} Add an advertiser</button>` : ''}</header><div data-t></div></div>`;
          table($('[data-t]', body), { columns: [{ label: 'Advertiser', render: (a) => `<b>${esc(a.name)}</b>${a.archived ? ` ${tag('t-mute', 'archived')}` : ''}<div class="cell-sub">${esc(a.contactName ?? '')}</div>` },
            { label: 'Contact', render: (a) => `${esc(a.email ?? '')}<div class="cell-sub">${esc(a.phone ?? '')}</div>` }, { label: 'Tax id', render: (a) => esc(a.taxId ?? '—') },
            { label: 'Campaigns', num: true, render: (a) => `${fmt.num(a.campaigns)}<div class="cell-sub">${fmt.num(a.active)} running</div>` }],
          rows: advs, empty: 'No advertisers yet.', onRow: canWrite ? advModal : undefined });
          $('[data-adda]', body)?.addEventListener('click', () => advModal(null));
        } else {
          const { invoices } = await api('/v1/ad-invoices');
          body.innerHTML = `<div class="card section"><header><h3>Invoices</h3><span class="cell-sub">Last month is drafted automatically; issue it once checked</span>
            ${canWrite && advs.length ? `<div class="right" style="display:flex;gap:6px"><select data-av style="width:auto">${options(advs.map((a) => ({ value: a.id, label: a.name })), advs[0].id)}</select><input type="month" data-m style="width:auto"><button class="btn sm" data-draft>Draft</button></div>` : ''}</header><div data-t></div></div>`;
          table($('[data-t]', body), { columns: [{ label: 'Invoice', render: (i) => `<b>${esc(i.number ?? 'draft')}</b><div class="cell-sub">${esc(i.month)}</div>` }, { label: 'Advertiser', render: (i) => esc(i.advertiser ?? '') },
            { label: 'Campaigns', render: (i) => esc(i.lines.map((l) => l.campaign).join(', ')) }, { label: 'Subtotal', num: true, render: (i) => fmt.money(i.subtotalMinor, i.currency) },
            { label: 'Total', num: true, render: (i) => `<b>${fmt.money(i.totalMinor, i.currency)}</b><div class="cell-sub">tax ${fmt.money(i.taxMinor, i.currency)}</div>` },
            { label: 'Status', render: (i) => `${tag(...INV[i.status])}${i.reference ? `<div class="cell-sub">${esc(i.reference)}</div>` : ''}` },
            { label: '', render: (i) => `<button class="btn sm" data-x="${i.id}" title="Spreadsheet">${icon('download')}</button>${canWrite && i.status === 'draft' ? ` <button class="btn sm" data-issue="${i.id}">Issue</button>` : ''}${canWrite && i.status === 'issued' ? ` <button class="btn sm" data-paid="${i.id}">Paid</button>` : ''}` }],
          rows: invoices, empty: 'No invoices yet.' });
          const act = async (id, b) => { try { await api(`/v1/ad-invoices/${id}`, { method: 'POST', body: b }); toast('Done.', 'ok'); draw(); } catch (e) { toast(e.message, 'crit'); } };
          $$('[data-issue]', body).forEach((b) => b.addEventListener('click', () => confirm('Issue this invoice? It is refreshed, numbered and fixed.') && act(b.dataset.issue, { action: 'issue' })));
          $$('[data-paid]', body).forEach((b) => b.addEventListener('click', () => { const reference = prompt('The payment\'s reference'); if (reference) act(b.dataset.paid, { action: 'paid', reference }); }));
          $$('[data-x]', body).forEach((b) => b.addEventListener('click', async () => { try { download(`ad-invoice-${b.dataset.x}.xlsx`, await api(`/v1/ad-invoices/${b.dataset.x}/invoice.xlsx`, { raw: true }).then((r) => r.blob())); } catch (e) { toast(e.message, 'crit'); } }));
          $('[data-draft]', body)?.addEventListener('click', async () => {
            const month = $('[data-m]', body).value; if (!month) { toast('Choose the month.', 'warn'); return; }
            try { await api(`/v1/advertisers/${$('[data-av]', body).value}/invoices`, { method: 'POST', body: { month } }); draw(); } catch (e) { toast(e.message, 'crit'); }
          });
        }
      } catch (e) { body.innerHTML = callout('crit', esc(e.message)); }
    };

    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; draw(); }));
    $('[data-settings]', root)?.addEventListener('click', () => st && settingsModal());
    await draw();
  },
});
