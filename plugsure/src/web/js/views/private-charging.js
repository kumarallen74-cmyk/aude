import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options, copy, download } from '../core.js';

/**
 * (v1.46.0) Assets & energy → Private charging: apartment buildings' and offices' chargers. A group's chargers leave
 * the public map and only its members' cards start them; each month the units (flats, or teams and cost centres) get a
 * statement: the energy their cards drew × the group's rate, plus a monthly fee. The building or office manager has
 * their own page (a secret link) to add and remove cards.
 */

const KIND = { residential: 'Residential', workplace: 'Workplace' };
const BILLING = { per_unit: 'per unit', cost_centre: 'per cost centre', none: 'free to members' };
const ST = { draft: 't-mute', issued: 't-info', paid: 't-ok', void: 't-mute' };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const lastMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

registerView('private-charging', {
  title: 'Private charging',
  icon: 'users',
  group: 'assets',
  order: 16,
  perm: 'site:read',
  async render(root) {
    const canWrite = state.can('site:write');
    root.innerHTML = pageHead('Private charging',
      'Chargers for an apartment building\'s residents or an office\'s staff: only members\' cards start them, they are not on the public map, and each unit or cost centre gets a monthly statement.',
      canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} Add a group</button>` : '') + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    let sites = [];

    const groupModal = (g) => modal({ title: g ? `Edit ${g.name}` : 'Add a group', size: 'lg',
      body: `<div class="form grid2">${field('Name', `<input name="name" maxlength="120" value="${esc(g?.name ?? '')}" placeholder="Menara Sudirman residents">`)}
        ${field('Site', `<select name="siteId">${options(sites.map((s) => ({ value: s.id, label: s.name })), g?.siteId ?? '')}</select>`)}
        ${field('Kind', `<select name="kind">${options([{ value: 'residential', label: 'Residential (units are flats)' }, { value: 'workplace', label: 'Workplace (units are teams or cost centres)' }], g?.kind ?? 'residential')}</select>`)}
        ${field('Billing', `<select name="billing">${options([{ value: 'per_unit', label: 'Per unit' }, { value: 'cost_centre', label: 'Per cost centre' }, { value: 'none', label: 'Free to members' }], g?.billing ?? '', { blank: 'By the kind' })}</select>`)}
        ${field('Rate per kWh (minor units)', `<input name="rate" type="number" min="0" step="1" value="${g?.rateMinor ?? ''}">`, { help: 'Empty: the charger tariff\'s amounts.' })}
        ${field('Monthly fee per unit (minor units)', `<input name="fee" type="number" min="0" step="1" value="${g?.monthlyFeeMinor ?? 0}">`)}
        ${field('Manager', `<input name="mgr" maxlength="120" value="${esc(g?.managerName ?? '')}">`)}
        ${field('Manager\'s e-mail', `<input name="mgrEmail" type="email" maxlength="200" value="${esc(g?.managerEmail ?? '')}">`)}</div>`,
      actions: [...(g ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/private-groups/${g.id}`, { method: 'PUT', body: { archive: true } }); toast('Archived: its chargers are public again.', 'ok'); draw(); }) }] : []),
        { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
          const b = { name: v('name'), siteId: v('siteId'), kind: v('kind'), ...(v('billing') ? { billing: v('billing') } : {}), rateMinor: v('rate') === '' ? null : Number(v('rate')), monthlyFeeMinor: Number(v('fee') || 0), managerName: v('mgr') || null, managerEmail: v('mgrEmail') || null };
          const r = await api(g ? `/v1/private-groups/${g.id}` : '/v1/private-groups', { method: g ? 'PUT' : 'POST', body: b });
          toast('Saved.', 'ok'); g ? openGroup(g.id) : openGroup(r.id);
        }) }] });

    const draw = async () => {
      let groups;
      try { [{ groups }, sites] = await Promise.all([api('/v1/private-groups'), api('/v1/sites').then((r) => (Array.isArray(r) ? r : r.sites ?? []))]); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      body.innerHTML = `<div class="grid k4">${kpi('Groups', fmt.num(groups.length))}${kpi('Private chargers', fmt.num(groups.reduce((a, g) => a + g.chargers, 0)))}
          ${kpi('Units', fmt.num(groups.reduce((a, g) => a + g.units, 0)))}${kpi('Members', fmt.num(groups.reduce((a, g) => a + g.members, 0)))}</div>
        <div class="card section"><header><h3>Groups</h3></header><div data-g></div></div>`;
      table($('[data-g]', body), { columns: [
        { label: 'Group', render: (g) => `<b>${esc(g.name)}</b><div class="cell-sub">${esc(g.site ?? '')}</div>` },
        { label: 'Kind', render: (g) => `${esc(KIND[g.kind] ?? g.kind)}<div class="cell-sub">${esc(BILLING[g.billing] ?? g.billing)}</div>` },
        { label: 'Chargers', num: true, render: (g) => fmt.num(g.chargers) }, { label: 'Units', num: true, render: (g) => fmt.num(g.units) }, { label: 'Members', num: true, render: (g) => fmt.num(g.members) },
        { label: 'Manager\'s page', render: (g) => (g.portalLinked ? tag('t-ok', 'link sent') : tag('t-mute', 'none')) },
      ], rows: groups, empty: 'No groups yet. Add one for a building or an office.', onRow: (g) => openGroup(g.id) });
    };

    const openGroup = async (id) => {
      let g;
      try { g = await api(`/v1/private-groups/${id}`); } catch (e) { toast(e.message, 'crit'); return; }
      const unitWord = g.kind === 'workplace' ? 'Team' : 'Unit';
      const unitLabel = Object.fromEntries(g.units.map((u) => [u.id, `${u.code}${u.name ? ` · ${u.name}` : ''}`]));
      const month = lastMonth();
      body.innerHTML = `<div><button class="btn sm" type="button" data-back>‹ Groups</button></div>
        <div class="card section"><header><h3>${esc(g.name)}</h3><span class="cell-sub">${esc(g.site ?? '')} · ${esc(KIND[g.kind])} · ${esc(BILLING[g.billing])}${g.rateMinor != null ? ` · ${esc(fmt.money(g.rateMinor, g.currency))}/kWh` : ''}${g.monthlyFeeMinor ? ` + ${esc(fmt.money(g.monthlyFeeMinor, g.currency))} a month` : ''}</span>
          ${canWrite ? `<div class="right" style="display:flex;gap:6px"><button class="btn sm" type="button" data-edit>Edit</button><button class="btn sm" type="button" data-portal>${icon('link')} Manager's link</button></div>` : ''}</header></div>
        <div class="card section"><header><h3>Chargers</h3><span class="cell-sub">Ticked: private to this group</span>${canWrite ? '<button class="btn sm right" type="button" data-save-ch>Save</button>' : ''}</header>
          <div style="padding:0 16px 14px">${g.chargers.length ? g.chargers.map((c) => `<label style="display:flex;gap:8px;padding:4px 0"><input type="checkbox" data-cp="${esc(c.id)}" ${c.inGroup ? 'checked' : ''} ${c.inOtherGroup || !canWrite ? 'disabled' : ''}> ${esc(c.name)} ${c.inOtherGroup ? tag('t-mute', 'in another group') : ''}</label>`).join('') : '<span class="cell-sub">No chargers at this site.</span>'}</div></div>
        <div class="card section"><header><h3>${unitWord}s</h3><span class="cell-sub">This month</span>${canWrite ? `<button class="btn sm right" type="button" data-unit>${icon('plus')} Add</button>` : ''}</header><div data-u></div></div>
        <div class="card section"><header><h3>Members</h3>${canWrite && g.units.length ? `<button class="btn sm right" type="button" data-member>${icon('plus')} Add</button>` : ''}</header><div data-m></div></div>
        ${g.billing === 'none' ? '' : `<div class="card section"><header><h3>Statements</h3>
          <div class="right" style="display:flex;gap:6px;align-items:center"><input type="month" data-month value="${month}" style="width:auto">
            ${canWrite ? '<button class="btn sm" type="button" data-draft>Draft</button>' : ''}<button class="btn sm" type="button" data-xlsx>${icon('download')} .xlsx</button></div></header><div data-s></div></div>`}`;
      table($('[data-u]', body), { columns: [{ label: unitWord, render: (u) => `<b>${esc(u.code)}</b>${u.name ? `<div class="cell-sub">${esc(u.name)}</div>` : ''}` },
        { label: 'Charges', num: true, render: (u) => fmt.num(u.thisMonth.sessions) }, { label: 'kWh', num: true, render: (u) => fmt.num(u.thisMonth.kwh, 1) },
        ...(g.billing === 'none' ? [] : [{ label: 'Energy', num: true, render: (u) => fmt.money(u.thisMonth.energyMinor, g.currency) }]),
        { label: 'Statement to', render: (u) => esc(u.billingEmail ?? '—') }], rows: g.units, empty: `No ${unitWord.toLowerCase()}s yet.`,
      onRow: canWrite ? (u) => unitModal(u) : undefined });
      table($('[data-m]', body), { columns: [{ label: 'Name', key: 'name' }, { label: unitWord, render: (m) => esc(unitLabel[m.unitId] ?? '') }, { label: 'Card', render: (m) => esc(m.card ?? '—') }, { label: 'Plate', render: (m) => esc(m.plate ?? '') }],
        rows: g.members, empty: 'No members yet: nobody can start these chargers.', onRow: canWrite ? (m) => memberModal(m) : undefined });
      const unitModal = (u) => modal({ title: u ? `${unitWord} ${u.code}` : `Add a ${unitWord.toLowerCase()}`,
        body: `<div class="form">${field(g.kind === 'workplace' ? 'Cost centre' : 'Unit', `<input name="code" maxlength="40" value="${esc(u?.code ?? '')}" placeholder="${g.kind === 'workplace' ? 'CC-410' : 'A-12'}">`)}
          ${field('Name', `<input name="name" maxlength="120" value="${esc(u?.name ?? '')}">`)}${field('Statement to (e-mail)', `<input name="email" type="email" value="${esc(u?.billingEmail ?? '')}">`)}</div>`,
        actions: [...(u ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/private-groups/${g.id}/units/${u.id}`, { method: 'PUT', body: { archive: true } }); openGroup(g.id); }) }] : []),
          { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
            const b = { code: $('[name="code"]', mc.el).value, name: $('[name="name"]', mc.el).value || null, billingEmail: $('[name="email"]', mc.el).value || null };
            await api(u ? `/v1/private-groups/${g.id}/units/${u.id}` : `/v1/private-groups/${g.id}/units`, { method: u ? 'PUT' : 'POST', body: b });
            openGroup(g.id);
          }) }] });
      const memberModal = (m) => modal({ title: m ? m.name : 'Add a member',
        body: `<div class="form">${field(unitWord, `<select name="unit">${options(g.units.map((u) => ({ value: u.id, label: unitLabel[u.id] })), m?.unitId ?? '')}</select>`)}
          ${field('Name', `<input name="name" maxlength="120" value="${esc(m?.name ?? '')}">`)}
          ${m ? '' : field('Card number', '<input name="card" maxlength="20" placeholder="The number on the RFID card">', { help: 'A new card is added to RFID cards.' })}
          ${field('Plate', `<input name="plate" maxlength="15" value="${esc(m?.plate ?? '')}">`, { help: 'For the plate cameras: the barrier opens, and the car can start charging when it plugs in.' })}</div>`,
        actions: [...(m ? [{ label: 'Remove', kind: 'danger', onClick: guard(async () => { await api(`/v1/private-groups/${g.id}/members/${m.id}`, { method: 'PUT', body: { archive: true } }); toast('Removed: the card no longer starts these chargers.', 'ok'); openGroup(g.id); }) }] : []),
          { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
            const b = { unitId: $('[name="unit"]', mc.el).value, name: $('[name="name"]', mc.el).value, plate: $('[name="plate"]', mc.el).value || null, ...(m ? {} : { cardUid: $('[name="card"]', mc.el).value }) };
            await api(m ? `/v1/private-groups/${g.id}/members/${m.id}` : `/v1/private-groups/${g.id}/members`, { method: m ? 'PUT' : 'POST', body: b });
            openGroup(g.id);
          }) }] });
      const stmts = async () => {
        const el = $('[data-s]', body);
        if (!el) return;
        const mo = $('[data-month]', body).value;
        const { statements } = await api(`/v1/private-groups/${g.id}/statements?month=${encodeURIComponent(mo)}`);
        table(el, { columns: [{ label: unitWord, render: (s) => `${esc(s.unit)}${s.unitName ? `<div class="cell-sub">${esc(s.unitName)}</div>` : ''}` },
          { label: 'Charges', num: true, render: (s) => fmt.num(s.sessions) }, { label: 'kWh', num: true, render: (s) => fmt.num(s.kwh, 1) },
          { label: 'Energy', num: true, render: (s) => fmt.money(s.energyMinor, s.currency) }, { label: 'Fee', num: true, render: (s) => fmt.money(s.feeMinor, s.currency) },
          { label: 'Total', num: true, render: (s) => `<b>${fmt.money(s.amountMinor, s.currency)}</b>` }, { label: 'Status', render: (s) => tag(ST[s.status] ?? 't-mute', s.status) },
          ...(canWrite ? [{ label: '', render: (s) => (s.status === 'draft' ? `<button class="btn sm" data-st="issue" data-id="${s.id}">Issue</button> ` : s.status === 'issued' ? `<button class="btn sm" data-st="paid" data-id="${s.id}">Paid</button> ` : '') + (s.status === 'draft' || s.status === 'issued' ? `<button class="btn sm" data-st="void" data-id="${s.id}">Void</button>` : '') }] : [])],
        rows: statements, empty: 'No statements for this month. Draft them once the month is over.' });
        $$('[data-st]', el).forEach((b) => b.addEventListener('click', async (e) => { e.stopPropagation(); try { await api(`/v1/private-statements/${b.dataset.id}/${b.dataset.st}`, { method: 'POST' }); stmts(); } catch (err) { toast(err.message, 'crit'); } }));
      };
      $('[data-back]', body).addEventListener('click', draw);
      $('[data-edit]', body)?.addEventListener('click', () => groupModal(g));
      $('[data-unit]', body)?.addEventListener('click', () => unitModal(null));
      $('[data-member]', body)?.addEventListener('click', () => memberModal(null));
      $('[data-save-ch]', body)?.addEventListener('click', async () => {
        try { await api(`/v1/private-groups/${g.id}/chargers`, { method: 'PUT', body: { chargePointIds: $$('[data-cp]:checked', body).map((c) => c.dataset.cp) } }); toast('Saved: these chargers are private now.', 'ok'); openGroup(g.id); } catch (e) { toast(e.message, 'crit'); }
      });
      $('[data-portal]', body)?.addEventListener('click', () => modal({ title: 'The manager\'s link',
        body: `<p>${g.portalLinked ? 'A new link replaces the one sent before (it stops working).' : 'The manager sees the units, members and statements, and adds or removes cards. No account needed.'}</p><div data-link></div>`,
        actions: [{ label: 'Close' }, { label: g.portalLinked ? 'Make a new link' : 'Make the link', kind: 'primary', onClick: guard(async (mc) => {
          const r = await api(`/v1/private-groups/${g.id}/portal`, { method: 'POST' });
          const url = `${location.origin}${r.path}`;
          $('[data-link]', mc.el).innerHTML = `${callout('warn', 'Shown once. Send it to the manager; anyone with it can change the members.')}<div style="display:flex;gap:6px;margin-top:8px"><input readonly value="${esc(url)}" style="flex:1"><button class="btn" type="button" data-cpy>${icon('copy')} Copy</button></div>`;
          $('[data-cpy]', mc.el).addEventListener('click', () => copy(url));
          return false;
        }) }] }));
      $('[data-month]', body)?.addEventListener('change', () => stmts().catch((e) => toast(e.message, 'crit')));
      $('[data-draft]', body)?.addEventListener('click', async () => {
        try { const r = await api(`/v1/private-groups/${g.id}/statements`, { method: 'POST', body: { month: $('[data-month]', body).value } }); toast(`${r.drafted} statement${r.drafted === 1 ? '' : 's'} drafted.`, 'ok'); stmts(); } catch (e) { toast(e.message, 'crit'); }
      });
      $('[data-xlsx]', body)?.addEventListener('click', async () => {
        const mo = $('[data-month]', body).value;
        try { const blob = await api(`/v1/private-groups/${g.id}/statements.xlsx?month=${encodeURIComponent(mo)}`, { raw: true }).then((r) => r.blob()); download(`private-statements-${mo}.xlsx`, blob); } catch (e) { toast(e.message, 'crit'); }
      });
      await stmts().catch(() => null);
    };

    $('[data-add]', root)?.addEventListener('click', () => groupModal(null));
    await draw();
  },
});
