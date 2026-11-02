import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options, copy, download } from '../core.js';

/**
 * (v1.48.0) Commercial → Hotels: guests charge on their room. Each hotel bills charges to the guest's folio in its PMS,
 * or to the hotel monthly. Guests are checked in here or by the PMS; the hotel's staff start and stop cars from the
 * valet page (a secret link).
 */

const ST = { charging: ['t-info', 'charging'], posted: ['t-ok', 'on the folio'], on_statement: ['t-ok', 'on the statement'], post_failed: ['t-crit', 'not posted'], void: ['t-mute', 'no charge'] };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };

registerView('hotels', {
  title: 'Hotels',
  icon: 'site',
  group: 'commercial',
  order: 26,
  perm: 'site:read',
  async render(root) {
    const canWrite = state.can('site:write');
    root.innerHTML = pageHead('Hotels', 'Guests charge on their room: billed to their folio in the hotel\'s PMS, or to the hotel each month. The hotel\'s staff start cars from the valet page.',
      canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} Add a hotel</button>` : '') + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    let hotels = [], sites = [], cur = null, month = new Date().toISOString().slice(0, 7);

    const showOnce = (title, text, value) => modal({ title, body: `${callout('warn', text)}<div style="display:flex;gap:6px;margin-top:8px"><input readonly value="${esc(value)}" style="flex:1"><button class="btn" type="button" data-cpy>${icon('copy')} Copy</button></div>`,
      onMount: (mc) => $('[data-cpy]', mc.el).addEventListener('click', () => copy(value)) });

    const hotelModal = (h) => modal({ title: h ? `Edit ${h.name}` : 'Add a hotel', size: 'lg',
      body: `<div class="form grid2">${field('Name', `<input name="name" maxlength="120" value="${esc(h?.name ?? '')}">`)}
        ${field('Site', `<select name="site">${options(sites.map((s) => ({ value: s.id, label: s.name })), h?.siteId ?? '')}</select>`)}
        ${field('Charges go', `<select name="posting">${options([{ value: 'pms', label: 'To the guest\'s folio (the hotel\'s PMS)' }, { value: 'statement', label: 'On a monthly statement to the hotel' }], h?.posting ?? 'statement')}</select>`)}
        ${field('PMS address', `<input name="url" maxlength="500" value="${esc(h?.pmsUrl ?? '')}" placeholder="https://pms.example.com/folio-charges">`, { help: 'Each charge is POSTed here, signed.' })}
        ${field('PMS signing secret', `<input name="secret" maxlength="500" placeholder="${h?.hasPmsSecret ? 'Kept (type to replace)' : 'Shared with the PMS'}">`)}</div>`,
      actions: [...(h ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/hotels/${h.id}`, { method: 'PUT', body: { archive: true } }); cur = null; draw(); }) },
        { label: 'New PMS key', onClick: guard(async () => { const r = await api(`/v1/hotels/${h.id}`, { method: 'PUT', body: { rotatePmsKey: true } }); showOnce('The PMS\'s address', 'Shown once. The PMS posts check-ins, check-outs and room moves here.', `${location.origin}/v1/hotels/pms/${r.pmsKey}`); }) }] : []),
        { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
          const r = await api(h ? `/v1/hotels/${h.id}` : '/v1/hotels', { method: h ? 'PUT' : 'POST', body: { name: v('name'), siteId: v('site'), posting: v('posting'), pmsUrl: v('url') || null, ...(v('secret') ? { pmsSecret: v('secret') } : {}) } });
          if (r.pmsKey) showOnce('The PMS\'s address', 'Shown once. The PMS posts check-ins, check-outs and room moves here (see HOTELS.md).', `${location.origin}/v1/hotels/pms/${r.pmsKey}`);
          else toast('Saved.', 'ok');
          cur = r.id; draw();
        }) }] });

    const checkInModal = (h) => modal({ title: `Check a guest in · ${h.name}`,
      body: `<div class="form grid2">${field('Room', '<input name="room" maxlength="20">')}${field('Guest', '<input name="guest" maxlength="120">')}
        ${field('Reservation', '<input name="ref" maxlength="60">')}${field('Departure', '<input name="dep" type="date">')}${field('Plate', '<input name="plate" maxlength="15">')}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Check in', kind: 'primary', onClick: guard(async (mc) => {
        const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
        await api(`/v1/hotels/${h.id}/stays`, { method: 'POST', body: { room: v('room'), guestName: v('guest'), reservationRef: v('ref') || null, departureOn: v('dep') || null, plate: v('plate') || null } });
        toast('Checked in.', 'ok'); draw();
      }) }] });

    const draw = async () => {
      try {
        [{ hotels }, sites] = await Promise.all([api('/v1/hotels'), api('/v1/sites').then((r) => (Array.isArray(r) ? r : r.sites ?? []))]);
      } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      if (!hotels.some((h) => h.id === cur)) cur = hotels[0]?.id ?? null;
      const h = hotels.find((x) => x.id === cur);
      if (!h) { body.innerHTML = '<div class="card section"><p class="cell-sub" style="padding:16px">No hotels yet.</p></div>'; return; }
      const [{ stays }, { charges }, stmt] = await Promise.all([api(`/v1/hotels/${h.id}/stays`), api(`/v1/hotels/${h.id}/charges?month=${month}`), api(`/v1/hotels/${h.id}/statement?month=${month}`)]);
      const failed = charges.filter((c) => c.status === 'post_failed');
      body.innerHTML = `${hotels.length > 1 ? `<div><select data-h style="width:auto">${options(hotels.map((x) => ({ value: x.id, label: x.name })), h.id)}</select></div>` : ''}
        ${failed.length ? callout('crit', `${failed.length} charge${failed.length === 1 ? '' : 's'} could not be posted to the PMS: send them again below.`) : ''}
        <div class="grid k4">${kpi('In house', fmt.num(stays.length), esc(h.site ?? ''))}${kpi('Charges', fmt.num(charges.filter((c) => c.status !== 'void').length), month)}
          ${kpi('Charged', fmt.money(charges.filter((c) => ['posted', 'on_statement'].includes(c.status)).reduce((a, c) => a + (c.amountMinor ?? 0), 0), h.currency), month)}
          ${kpi('Billing', h.posting === 'pms' ? 'Guest folio' : 'Monthly statement')}</div>
        <div class="card section"><header><h3>${esc(h.name)}</h3>${canWrite ? `<div class="right" style="display:flex;gap:6px"><button class="btn sm" type="button" data-valet>${icon('link')} Valet page</button><button class="btn sm" type="button" data-edit>Edit</button></div>` : ''}</header></div>
        <div class="card section"><header><h3>Guests in house</h3>${canWrite ? `<button class="btn sm right" type="button" data-in>${icon('plus')} Check in</button>` : ''}</header><div data-s></div></div>
        <div class="card section"><header><h3>Charges</h3><div class="right" style="display:flex;gap:6px;align-items:center"><input type="month" data-m value="${month}" style="width:auto">
          ${h.posting === 'statement' ? `<button class="btn sm" type="button" data-x>${icon('download')} Statement</button>` : ''}</div></header><div data-c></div>
          ${h.posting === 'statement' ? `<div class="cell-sub" style="padding:8px 16px 12px">Statement: ${fmt.num(stmt.kwh, 1)} kWh, ${fmt.money(stmt.amountMinor, stmt.currency)}</div>` : ''}</div>`;
      table($('[data-s]', body), { columns: [{ label: 'Room', render: (s) => `<b>${esc(s.room)}</b>` }, { label: 'Guest', render: (s) => `${esc(s.guestName)}${s.reservationRef ? `<div class="cell-sub">${esc(s.reservationRef)}</div>` : ''}` },
        { label: 'Departure', render: (s) => esc(s.departureOn ?? '—') }, { label: 'Plate', render: (s) => esc(s.plate ?? '') }, { label: 'Charged', num: true, render: (s) => (s.charges ? `${fmt.money(s.amountMinor, h.currency)}<div class="cell-sub">${s.charges} charges</div>` : '—') },
        ...(canWrite ? [{ label: '', render: (s) => `<button class="btn sm" data-out="${s.id}">Check out</button>` }] : [])], rows: stays, empty: 'No guests in house.' });
      table($('[data-c]', body), { columns: [{ label: 'When', render: (c) => esc(fmt.time(c.createdAt)) }, { label: 'Room', render: (c) => `${esc(c.room ?? '')}<div class="cell-sub">${esc(c.guestName ?? '')}</div>` },
        { label: 'kWh', num: true, render: (c) => (c.kwh == null ? '—' : fmt.num(c.kwh, 2)) }, { label: 'Amount', num: true, render: (c) => (c.amountMinor == null ? '—' : fmt.money(c.amountMinor, c.currency)) },
        { label: 'Status', render: (c) => tag(...(ST[c.status] ?? ['t-mute', c.status]), c.lastError ?? '') },
        ...(canWrite ? [{ label: '', render: (c) => (c.status === 'post_failed' ? `<button class="btn sm" data-retry="${c.id}">Send again</button>` : '') }] : [])], rows: charges, empty: 'No charges this month.' });
      $('[data-h]', body)?.addEventListener('change', (e) => { cur = e.target.value; draw(); });
      $('[data-m]', body).addEventListener('change', (e) => { month = e.target.value || month; draw(); });
      $('[data-edit]', body)?.addEventListener('click', () => hotelModal(h));
      $('[data-in]', body)?.addEventListener('click', () => checkInModal(h));
      $('[data-valet]', body)?.addEventListener('click', () => modal({ title: 'The valet page', body: '<p>The hotel\'s staff open it on a phone at the car park to start and stop cars by room. A new link replaces the old one.</p>',
        actions: [{ label: 'Cancel' }, { label: 'Make the link', kind: 'primary', onClick: guard(async () => { const r = await api(`/v1/hotels/${h.id}/valet`, { method: 'POST' }); showOnce('The valet page', 'Shown once: give it to the hotel\'s staff.', `${location.origin}${r.path}`); }) }] }));
      $('[data-x]', body)?.addEventListener('click', async () => { try { download(`hotel-statement-${month}.xlsx`, await api(`/v1/hotels/${h.id}/statement.xlsx?month=${month}`, { raw: true }).then((r) => r.blob())); } catch (e) { toast(e.message, 'crit'); } });
      $$('[data-out]', body).forEach((b) => b.addEventListener('click', async () => { if (!confirm('Check this guest out? Their charging card stops.')) return; try { await api(`/v1/hotel-stays/${b.dataset.out}`, { method: 'PUT', body: { action: 'check_out' } }); draw(); } catch (e) { toast(e.message, 'crit'); } }));
      $$('[data-retry]', body).forEach((b) => b.addEventListener('click', async () => { try { await api(`/v1/hotel-charges/${b.dataset.retry}/retry`, { method: 'POST' }); toast('It will be sent again within a minute.', 'ok'); draw(); } catch (e) { toast(e.message, 'crit'); } }));
    };

    $('[data-add]', root)?.addEventListener('click', () => hotelModal(null));
    await draw();
  },
});
