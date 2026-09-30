import { $, $$, esc, api, attempt, state, registerView, pageHead, icon, field, callout, table, fmt, tag, modal, toast, formValues, copy, sites as loadSites } from '../core.js';

/**
 * Site owners — the businesses whose sites you operate. Each owner can have
 * portal users (Site Owner role) who see only that owner's sites, and gets a
 * monthly statement under Billing.
 */

function ownerForm(o = {}) {
  return `<div class="form">
    ${field('Name', `<input name="name" value="${esc(o.name ?? '')}" placeholder="e.g. Hotel Majapahit" autocomplete="off">`)}
    ${field('Legal name', `<input name="legalName" value="${esc(o.legal_name ?? '')}" placeholder="PT …" autocomplete="off">`, { opt: true, help: 'Printed on statements (and on driver receipts if the owner is seller of record).' })}
    ${field('NPWP', `<input name="npwp" value="${esc(o.npwp ?? '')}" inputmode="numeric" autocomplete="off">`, { opt: true })}
    ${field('Address', `<input name="address" value="${esc(o.address ?? '')}" autocomplete="off">`, { opt: true })}
    ${field('Contact name', `<input name="contactName" value="${esc(o.contact_name ?? '')}" autocomplete="off">`, { opt: true })}
    ${field('Contact e-mail', `<input name="contactEmail" type="email" value="${esc(o.contact_email ?? '')}" autocomplete="off">`, { opt: true })}
    ${field('Contact phone', `<input name="contactPhone" inputmode="tel" value="${esc(o.contact_phone ?? '')}" autocomplete="off">`, { opt: true })}
    ${field('Seller on driver receipts', `<select name="sellerOfRecord"><option value="operator"${o.seller_of_record !== 'owner' ? ' selected' : ''}>${esc(state.me?.org?.name ?? 'Operator')} (payments settle to the operator)</option><option value="owner"${o.seller_of_record === 'owner' ? ' selected' : ''}>The owner (payments settle to the owner's merchant account)</option></select>`, { full: true, help: 'Whose name and NPWP go on the driver\'s tax receipt. Switch to the owner only once driver payments are settled to the owner\'s own merchant account.' })}
    <div class="field full"><label class="check"><input type="checkbox" name="pkp"${o.pkp ? ' checked' : ''}> <span>PKP (registered to charge PPN)</span></label></div>
  </div>`;
}

const readForm = (body) => {
  const v = formValues(body);
  return { name: v.name, legalName: v.legalName, npwp: v.npwp, address: v.address, contactName: v.contactName, contactEmail: v.contactEmail, contactPhone: v.contactPhone, sellerOfRecord: v.sellerOfRecord, pkp: v.pkp };
};

registerView('owners', {
  title: 'Owners',
  icon: 'users',
  group: 'commercial',
  order: 27,
  // Managing owners is an operator task (site-scoped Site Hosts also hold site:read).
  perm: 'site:write',
  async render(root) {
    const canWrite = state.can('site:write');
    const canUsers = state.can('user:write');
    root.innerHTML = pageHead(
      'Site owners',
      'The businesses whose sites you operate. Each owner can sign in to a read-only portal showing only its own chargers, sessions, availability and monthly statement, and is billed under Billing.',
      canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} Add owner</button>` : '',
    ) + '<div class="card section" data-list></div>';

    let rows = [];
    const load = async () => {
      try { rows = await api('/v1/owners'); } catch (e) { $('[data-list]', root).innerHTML = callout('crit', esc(e.message)); return; }
      table($('[data-list]', root), {
        columns: [
          { label: 'Owner', render: (o) => `<div class="cell-title">${esc(o.name)}</div><div class="cell-sub">${esc(o.legal_name ?? '')}${o.npwp ? ` · NPWP ${esc(o.npwp)}` : ''}</div>` },
          { label: 'Sites', render: (o) => (o.sites.length ? esc(o.sites.map((s) => s.name).join(', ')) : '<span class="cell-sub">none yet</span>') },
          { label: 'Chargers', num: true, render: (o) => fmt.num(o.chargers) },
          { label: 'Portal users', num: true, render: (o) => fmt.num(o.users) },
          { label: 'Receipts', render: (o) => (o.seller_of_record === 'owner' ? tag('t-info', 'owner is seller') : tag('t-mute', 'operator')) },
          { label: '', render: (o) => (o.archived_at ? tag('t-mute', 'archived') : '') },
        ],
        rows,
        empty: 'No site owners yet. Add the businesses whose sites you operate, then assign their sites.',
        onRow: (o) => openOwner(o),
      });
    };

    const openOwner = async (o) => {
      const siteList = (await loadSites(true)).filter((s) => !s.archived_at);
      const mine = new Set(o.sites.map((s) => s.id));
      const others = new Map(rows.filter((x) => x.id !== o.id).flatMap((x) => x.sites.map((s) => [s.id, x.name])));
      modal({
        title: o.name,
        subtitle: o.legal_name ?? '',
        size: 'lg',
        body: `${ownerForm(o)}
          <div class="field full section"><label>Sites owned</label>
            <div class="stack" style="gap:4px;max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px 10px">${siteList.map((s) => `
              <label class="check"><input type="checkbox" data-site value="${esc(s.id)}"${mine.has(s.id) ? ' checked' : ''}${canWrite ? '' : ' disabled'}>
              <span>${esc(s.name)}${others.has(s.id) ? ` <span class="cell-sub">(now ${esc(others.get(s.id))})</span>` : ''}</span></label>`).join('') || '<div class="cell-sub">No sites.</div>'}</div>
            <div class="help">A site that already has charging history with another owner cannot be moved: create a new site for the new owner and move the chargers.</div></div>
          ${canUsers && !o.archived_at ? `<div class="row section" style="gap:6px"><button class="btn sm" type="button" data-invite>${icon('plus')} Invite a portal user for this owner</button></div>` : ''}
          ${canWrite ? `<div class="row" style="gap:6px;margin-top:8px"><label class="check"><input type="checkbox" data-archived${o.archived_at ? ' checked' : ''}> <span>Archived (portal users lose access)</span></label></div>` : ''}`,
        onMount(ctx) {
          $('[data-invite]', ctx.body)?.addEventListener('click', () => inviteFor(o));
          if (!canWrite) $$('input, select', ctx.body).forEach((i) => { if (!i.closest('[data-invite]')) i.disabled = true; });
        },
        actions: canWrite ? [{ label: 'Cancel' }, {
          label: 'Save', kind: 'primary',
          async onClick(ctx) {
            try {
              await api(`/v1/owners/${o.id}`, { method: 'PUT', body: { ...readForm(ctx.body), archived: $('[data-archived]', ctx.body).checked } });
              const ids = $$('[data-site]:checked', ctx.body).map((i) => i.value);
              const same = ids.length === mine.size && ids.every((id) => mine.has(id));
              if (!same) await api(`/v1/owners/${o.id}/sites`, { method: 'PUT', body: { siteIds: ids } });
              toast('Owner saved', 'ok');
              load();
            } catch (e) { toast(e.message, 'crit'); return false; }
          },
        }] : [{ label: 'Close' }],
      });
    };

    const inviteFor = (o) => modal({
      title: `Portal user for ${o.name}`,
      subtitle: 'Signs in with e-mail and password; sees only this owner\'s sites. Read-only.',
      body: `<div class="form one">
        ${field('Full name', `<input name="name" value="${esc(o.contact_name ?? '')}" autocomplete="off">`)}
        ${field('E-mail (used to sign in)', `<input name="email" type="email" value="${esc(o.contact_email ?? '')}" autocomplete="off">`)}
      </div>`,
      actions: [{ label: 'Cancel' }, {
        label: 'Create portal user', kind: 'primary',
        async onClick(ctx) {
          const v = formValues(ctx.body);
          try {
            const r = await api('/v1/users', { method: 'POST', body: { name: v.name, email: v.email, role: 'site_owner', ownerId: o.id } });
            load();
            setTimeout(() => modal({
              title: 'One-time password',
              dismissable: false,
              body: `${callout('warn', '<b>Shown once.</b> Share it with the owner through a secure channel; they choose their own password at first sign-in.')}
                <div class="row" style="margin-top:12px;gap:8px"><code class="mono grow" data-secret></code><button class="btn sm" type="button" data-copy>${icon('copy')} Copy</button></div>
                <p class="cell-sub" style="margin-top:10px">Sign-in: <span class="mono">${esc(v.email)}</span> at the console address.</p>`,
              actions: [{ label: 'I have shared it', kind: 'primary' }],
              onMount(c2) { $('[data-secret]', c2.body).textContent = r.temporaryPassword; $('[data-copy]', c2.body).addEventListener('click', () => copy(r.temporaryPassword)); },
            }), 50);
          } catch (e) { toast(e.message, 'crit'); return false; }
        },
      }],
    });

    $('[data-add]', root)?.addEventListener('click', () => modal({
      title: 'Add site owner',
      size: 'lg',
      body: ownerForm(),
      actions: [{ label: 'Cancel' }, {
        label: 'Add owner', kind: 'primary',
        async onClick(ctx) {
          const r = await attempt(() => api('/v1/owners', { method: 'POST', body: readForm(ctx.body) }), { success: 'Owner added — now open it to assign its sites' });
          if (!r) return false;
          load();
        },
      }],
    }));
    await load();
  },
});
