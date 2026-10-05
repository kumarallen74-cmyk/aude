import {
  $, $$, esc, api, attempt, state, registerView, pageHead, table, tag, icon, fmt, modal, confirmDialog, html, field,
  formValues, fieldErrors, toast, callout, copy, sites as loadSites, phoneExample
} from '../core.js';
import { MS_MARK } from '../microsoft.js';

/**
 * Module 10 — Multi-Tenancy & RBAC.
 * Users (invite, edit, disable, reset password), the spec's role permission
 * matrix, and API keys for machine integrations.
 */

/** Every permission the API knows; the issue-key dialog offers only those the operator holds. */
const ALL_PERMISSIONS = [
  'org:read', 'org:write', 'site:read', 'site:write',
  'charge_point:read', 'charge_point:write', 'charge_point:command', 'charge_point:config',
  'firmware:read', 'firmware:write', 'session:read', 'session:write', 'session:export',
  'tariff:read', 'tariff:write', 'token:read', 'token:write', 'payment:read', 'payment:write',
  'invoice:read', 'invoice:write', 'compliance:read', 'compliance:write',
  'smartcharging:read', 'smartcharging:write', 'audit:read', 'user:read', 'user:write',
  'webhook:read', 'webhook:write', 'alert:read', 'alert:write',
];

const roleDefs = () => state.meta?.consoleRoles ?? [];
const roleDef = (name) => roleDefs().find((r) => r.name === name);
const roleLabel = (name) => roleDef(name)?.label ?? name;
const myId = () => state.me?.user?.id;

// ------------------------------------------------------------------ one-time secret dialog

/** Shows a secret exactly once, with a Copy button. The value is set as textContent, never as markup. */
function showSecret({ title, label, secret, warning }) {
  return new Promise((resolve) => {
    modal({
      title,
      dismissable: false,
      body: `${callout('warn', `<b>Shown once.</b> ${esc(warning)}`)}
        <div class="field" style="margin-top:12px"><label>${esc(label)}</label>
          <div class="row"><div class="secret grow" data-secret></div>
          <button class="btn" type="button" data-copy>${icon('copy')} Copy</button></div></div>`,
      actions: [{ label: 'I have stored it safely', kind: 'primary' }],
      onMount(ctx) {
        $('[data-secret]', ctx.body).textContent = secret ?? '';
        $('[data-copy]', ctx.body).addEventListener('click', () => copy(secret ?? ''));
      },
      onClose: () => resolve(),
    });
  });
}

// ------------------------------------------------------------------ shared form pieces

const roleCards = (selected, disabled) =>
  `<div class="stack" style="gap:6px">${roleDefs().map((r) => `
    <label class="check card" style="padding:10px 12px">
      <input type="radio" name="role" value="${esc(r.name)}"${r.name === selected ? ' checked' : ''}${disabled ? ' disabled' : ''}>
      <div><div class="cell-title">${esc(r.label)} ${r.siteScoped ? tag('t-info', 'site-scoped') : ''}${r.ownerScoped ? tag('t-info', 'owner portal') : ''}${r.fleetScoped ? tag('t-info', 'fleet portal') : ''}</div>
      <div class="cell-sub">${esc(r.description)}</div></div>
    </label>`).join('')}</div>`;

const siteChecks = (list, selectedIds, disabled) =>
  list.length
    ? `<div class="stack" style="gap:4px;max-height:200px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px 10px">${list.map((s) => `
        <label class="check"><input type="checkbox" data-site value="${esc(s.id)}"${selectedIds.includes(s.id) ? ' checked' : ''}${disabled ? ' disabled' : ''}>
        <span>${esc(s.name)}${s.spklu_id ? ` <span class="mono muted">${esc(s.spklu_id)}</span>` : ''}</span></label>`).join('')}</div>`
    : callout('warn', 'There are no sites yet. Create a site before inviting a Site Host.');

const pickedSites = (root) => $$('[data-site]', root).filter((i) => i.checked).map((i) => i.value);

/** The site owner a Site Owner (portal) user belongs to. */
const ownerPicker = (list, selected, disabled) => `<div class="field full hidden" data-ownerwrap style="margin-top:14px"><label>Site owner</label>
  ${list.length
    ? `<select name="ownerId"${disabled ? ' disabled' : ''}><option value="">Choose the owner…</option>${list.filter((o) => !o.archived_at).map((o) => `<option value="${esc(o.id)}"${o.id === selected ? ' selected' : ''}>${esc(o.name)} (${o.sites.length} site${o.sites.length === 1 ? '' : 's'})</option>`).join('')}</select>`
    : callout('warn', 'There are no site owners yet. Add one under Commercial → Owners first.')}
  <div class="help">The user sees only this owner's sites — its chargers, sessions, availability and monthly statement — and follows the owner's sites automatically. Read-only.</div></div>`;

/** The fleet account a Fleet customer (portal) user belongs to. */
const fleetPicker = (list, selected, disabled) => `<div class="field full hidden" data-fleetwrap style="margin-top:14px"><label>Fleet account</label>
  ${list.length
    ? `<select name="fleetAccountId"${disabled ? ' disabled' : ''}><option value="">Choose the fleet account…</option>${list.filter((a) => !a.archived_at).map((a) => `<option value="${esc(a.id)}"${a.id === selected ? ' selected' : ''}>${esc(a.name)}${a.legal_name && a.legal_name !== a.name ? ` (${esc(a.legal_name)})` : ''}</option>`).join('')}</select>`
    : callout('warn', 'There are no fleet accounts yet. They appear under Commercial → Fleet billing once cards have a fleet name.')}
  <div class="help">The user sees only this account's invoices, credit notes, this month's charging and its cards, and can block a lost card. Nothing else in the console.</div></div>`;

/** Show the site / owner / fleet picker only while a role scoped that way is chosen. */
function wireRoleSites(root) {
  const sync = () => {
    const r = $('[name=role]:checked', root)?.value;
    $('[data-sitewrap]', root)?.classList.toggle('hidden', !roleDef(r)?.siteScoped);
    $('[data-ownerwrap]', root)?.classList.toggle('hidden', !roleDef(r)?.ownerScoped);
    $('[data-fleetwrap]', root)?.classList.toggle('hidden', !roleDef(r)?.fleetScoped);
  };
  $$('[name=role]', root).forEach((i) => i.addEventListener('change', sync));
  sync();
}

// ------------------------------------------------------------------ users tab

function inviteUser(onDone) {
  (async () => {
    const siteList = (await loadSites()).filter((s) => !s.archived_at);
    const ownerList = await api('/v1/owners').catch(() => []);
    const fleetList = (await api('/v1/fleet-accounts').catch(() => ({ accounts: [] }))).accounts ?? [];
    modal({
      title: 'Invite user',
      subtitle: 'The user receives a one-time password and must choose their own at first sign-in.',
      size: 'lg',
      body: `<form novalidate>
        <div class="form">
          ${field('Full name', '<input name="name" maxlength="200" autocomplete="off">')}
          ${field('Email', '<input name="email" type="email" autocomplete="off">', { help: 'Used to sign in. Must be unique.' })}
          ${field('Phone', `<input name="phone" inputmode="tel" placeholder="${esc(phoneExample())}">`, { opt: true })}
        </div>
        <fieldset style="margin-top:14px"><legend>Role</legend>${roleCards(null, false)}</fieldset>
        <div class="field full hidden" data-sitewrap style="margin-top:14px"><label>Sites this person hosts</label>
          ${siteChecks(siteList, [], false)}
          <div class="help">A Site Host sees only these sites: their chargers, sessions, revenue and power. No commands.</div></div>
        ${ownerPicker(ownerList, null, false)}
        ${fleetPicker(fleetList, null, false)}
      </form>`,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Create user',
          kind: 'primary',
          async onClick(ctx) {
            const form = $('form', ctx.body);
            const v = formValues(form);
            const errs = {};
            if (!v.name?.trim()) errs.name = 'Enter the person\'s name';
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email?.trim() ?? '')) errs.email = 'Enter a valid email address';
            if (Object.keys(errs).length) { fieldErrors(form, errs); return false; }
            if (!v.role) { toast('Choose a role', 'warn'); return false; }
            const def = roleDef(v.role);
            const siteIds = def?.siteScoped ? pickedSites(form) : [];
            if (def?.siteScoped && !siteIds.length) { toast('A Site Host must be assigned at least one site', 'warn'); return false; }
            if (def?.ownerScoped && !v.ownerId) { toast('Choose the site owner', 'warn'); return false; }
            if (def?.fleetScoped && !v.fleetAccountId) { toast('Choose the fleet account', 'warn'); return false; }
            try {
              const r = await api('/v1/users', {
                method: 'POST',
                body: { name: v.name.trim(), email: v.email.trim(), phone: v.phone?.trim() || null, role: v.role, siteIds, ownerId: def?.ownerScoped ? v.ownerId : undefined, fleetAccountId: def?.fleetScoped ? v.fleetAccountId : undefined },
              });
              toast('User created', 'ok');
              onDone?.();
              setTimeout(() => showSecret({
                title: 'Temporary password',
                label: `One-time password for ${v.email.trim()}`,
                secret: r.temporaryPassword,
                warning: r.warning ?? 'Share this password through a secure channel. It cannot be displayed again; the user must replace it at first sign-in.',
              }), 0);
            } catch (e) {
              const k = /email/i.test(e.message) ? 'email' : /name/i.test(e.message) ? 'name' : null;
              if (k) fieldErrors(form, { [k]: e.message });
              else toast(e.message, 'crit');
              return false;
            }
          },
        },
      ],
      onMount(ctx) { wireRoleSites(ctx.body); },
    });
  })();
}

async function editUser(u, onDone) {
  const siteList = (await loadSites()).filter((s) => !s.archived_at);
  const canWrite = state.can('user:write');
  const self = u.id === myId();
  const roles = Array.isArray(u.roles) ? u.roles : [];
  const currentRole = roles.find((r) => roleDef(r.role))?.role ?? null;
  const legacy = roles.filter((r) => !roleDef(r.role)).map((r) => r.role);
  const siteIds = roles.filter((r) => r.scopeType === 'site' && r.scopeId).map((r) => r.scopeId);
  const ownerId = roles.find((r) => r.scopeType === 'owner')?.scopeId ?? null;
  const ownerList = await api('/v1/owners').catch(() => []);
  const fleetAccountId = roles.find((r) => r.scopeType === 'fleet')?.scopeId ?? null;
  const fleetList = (await api('/v1/fleet-accounts').catch(() => ({ accounts: [] }))).accounts ?? [];
  const lockRole = !canWrite || self;

  modal({
    title: `User — ${u.name}`,
    subtitle: u.email ?? '',
    size: 'lg',
    body: `<form novalidate>
      ${self ? callout('info', 'This is your own account. You cannot change your own role or status — ask another administrator.') : ''}
      <div class="form" style="margin-top:${self ? '12px' : '0'}">
        ${field('Full name', `<input name="name" maxlength="200"${canWrite ? '' : ' disabled'}>`)}
        ${field('Phone', `<input name="phone" inputmode="tel"${canWrite ? '' : ' disabled'}>`, { opt: true })}
      </div>
      <fieldset style="margin-top:14px"><legend>Role</legend>
        ${legacy.length ? `<div style="margin-bottom:8px">${callout('warn', `Currently holds legacy role(s): <span class="mono">${esc(legacy.join(', '))}</span>. Choosing a console role below replaces them.`)}</div>` : ''}
        ${roleCards(currentRole, lockRole)}</fieldset>
      <div class="field full hidden" data-sitewrap style="margin-top:14px"><label>Sites this person hosts</label>
        ${siteChecks(siteList, siteIds, lockRole)}</div>
      ${ownerPicker(ownerList, ownerId, lockRole)}
      ${fleetPicker(fleetList, fleetAccountId, lockRole)}
      <fieldset style="margin-top:14px"><legend>Account</legend>
        <dl class="kv">
          <dt>Status</dt><dd>${statusTags(u)}</dd>
          <dt>Last sign-in</dt><dd>${u.last_login_at ? `${esc(fmt.time(u.last_login_at))} <span class="muted">(${esc(fmt.ago(u.last_login_at))})</span>` : 'never'}</dd>
          <dt>Created</dt><dd>${esc(fmt.date(u.created_at))}</dd>
        </dl>
        ${canWrite ? `<div class="row" style="margin-top:12px">
          <button type="button" class="btn${u.status === 'disabled' ? '' : ' danger'}" data-status${self ? ' disabled title="You cannot change your own status"' : ''}>
            ${u.status === 'disabled' ? `${icon('check')} Enable user` : `${icon('stop')} Disable user`}</button>
          <button type="button" class="btn" data-reset>${icon('key')} Reset password</button>
          ${u.microsoft_bound ? `<button type="button" class="btn" data-ms-unbind title="Remove the link to their Microsoft account; their next Microsoft sign-in is matched by email address again">${icon('x')} Unlink Microsoft account</button>` : ''}
          ${u.mfa_enabled ? `<button type="button" class="btn" data-reset-mfa${self ? ' disabled title="Ask another administrator to reset your own two-step verification"' : ''}>${icon('phone')} Reset two-step verification</button>` : ''}
        </div>` : ''}
      </fieldset>
    </form>`,
    actions: canWrite
      ? [
          { label: 'Cancel' },
          {
            label: 'Save changes',
            kind: 'primary',
            async onClick(ctx) {
              const form = $('form', ctx.body);
              const v = formValues(form);
              if (!v.name?.trim()) { fieldErrors(form, { name: 'Name is required' }); return false; }
              const body = { name: v.name.trim(), phone: v.phone?.trim() || null };
              if (!self && v.role) {
                const def = roleDef(v.role);
                const ids = def?.siteScoped ? pickedSites(form) : [];
                if (def?.siteScoped && !ids.length) { toast('A Site Host must be assigned at least one site', 'warn'); return false; }
                if (def?.ownerScoped && !v.ownerId) { toast('Choose the site owner', 'warn'); return false; }
                if (def?.fleetScoped && !v.fleetAccountId) { toast('Choose the fleet account', 'warn'); return false; }
                const same = v.role === currentRole && ids.slice().sort().join() === (def?.siteScoped ? siteIds.slice().sort().join() : '')
                  && (!def?.ownerScoped || v.ownerId === ownerId) && (!def?.fleetScoped || v.fleetAccountId === fleetAccountId);
                if (!same) { body.role = v.role; body.siteIds = ids; if (def?.ownerScoped) body.ownerId = v.ownerId; if (def?.fleetScoped) body.fleetAccountId = v.fleetAccountId; }
              }
              try {
                await api(`/v1/users/${encodeURIComponent(u.id)}`, { method: 'PUT', body });
                toast('User updated', 'ok');
                onDone?.();
              } catch (e) {
                toast(e.message, 'crit');
                return false;
              }
            },
          },
        ]
      : [{ label: 'Close' }],
    onMount(ctx) {
      const form = $('form', ctx.body);
      $('[name=name]', form).value = u.name ?? '';
      $('[name=phone]', form).value = u.phone ?? '';
      wireRoleSites(form);

      $('[data-status]', form)?.addEventListener('click', async () => {
        const enable = u.status === 'disabled';
        const ok = await confirmDialog({
          title: enable ? 'Enable user' : 'Disable user',
          message: enable
            ? html`<b>${u.name}</b> will be able to sign in again with their existing password.`
            : html`<b>${u.name}</b> will be signed out and unable to sign in until re-enabled. Their audit history is kept.`,
          confirmLabel: enable ? 'Enable' : 'Disable',
          danger: !enable,
        });
        if (!ok) return;
        const r = await attempt(() => api(`/v1/users/${encodeURIComponent(u.id)}`, { method: 'PUT', body: { status: enable ? 'active' : 'disabled' } }),
          { success: enable ? 'User enabled' : 'User disabled' });
        if (r) { ctx.close(); onDone?.(); }
      });

      $('[data-reset]', form)?.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Reset password',
          message: html`Issue a new one-time password for <b>${u.name}</b>? Their current password stops working immediately and they must choose a new one at next sign-in.`,
          confirmLabel: 'Reset password',
          danger: true,
        });
        if (!ok) return;
        const r = await attempt(() => api(`/v1/users/${encodeURIComponent(u.id)}/reset-password`, { method: 'POST' }));
        if (!r) return;
        ctx.close();
        onDone?.();
        showSecret({
          title: 'Temporary password',
          label: `One-time password for ${u.email ?? u.name}`,
          secret: r.temporaryPassword,
          warning: `Share it through a secure channel. It cannot be displayed again${r.expiresInHours ? ` and stops working after ${r.expiresInHours} hours` : ''}; the user must replace it at first sign-in.`,
        });
      });

      $('[data-ms-unbind]', form)?.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Unlink Microsoft account',
          message: html`Remove the link between <b>${u.name}</b> and their Microsoft account? Their sessions signed in with Microsoft end. Their next "Sign in with Microsoft" is matched by email address again and links that Microsoft account. Password sign-in is not affected.`,
          confirmLabel: 'Unlink',
          danger: true,
        });
        if (!ok) return;
        const r = await attempt(() => api(`/v1/users/${encodeURIComponent(u.id)}/microsoft`, { method: 'DELETE' }), { success: 'Microsoft account unlinked' });
        if (r) { ctx.close(); onDone?.(); }
      });

      $('[data-reset-mfa]', form)?.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Reset two-step verification',
          message: html`Remove <b>${u.name}</b>'s authenticator and recovery codes? Do this only when you are sure who is asking (a lost phone): they are signed out everywhere, and if two-step verification is required for their role they set it up again at next sign-in.`,
          confirmLabel: 'Reset two-step verification',
          danger: true,
        });
        if (!ok) return;
        const r = await attempt(() => api(`/v1/users/${encodeURIComponent(u.id)}/reset-mfa`, { method: 'POST' }), { success: 'Two-step verification reset' });
        if (r) { ctx.close(); onDone?.(); }
      });
    },
  });
}

function statusTags(u) {
  return [
    u.status === 'active' ? tag('t-ok', 'active') : tag('t-mute', u.status ?? 'unknown'),
    u.mfa_enabled ? tag('t-info', '2-step', 'Signs in with a code from an authenticator app as well as the password') : '',
    u.microsoft_bound ? tag('t-info', 'Microsoft', 'Bound to a Microsoft account: signs in with "Sign in with Microsoft"') : '',
    u.locked ? tag('t-crit', 'locked', 'Temporarily locked after repeated failed sign-ins') : '',
    u.temp_password_expired
      ? tag('t-crit', 'one-time password expired', 'The one-time password was not used in time and no longer signs in. Reset the password to issue a new one.')
      : u.must_change_password ? tag('t-warn', 'must change password', `Signed in with a one-time password that has not been replaced yet${u.temp_password_expires_at ? ` (it stops working ${fmt.time(u.temp_password_expires_at)})` : ''}`) : '',
    u.has_password === false ? tag('t-mute', 'no password set') : '',
  ].filter(Boolean).join(' ');
}

function roleCell(u) {
  const roles = Array.isArray(u.roles) ? u.roles : [];
  if (!roles.length) return tag('t-warn', 'no role');
  const names = [...new Set(roles.map((r) => r.role))];
  return names.map((n) => {
    const sitesFor = roles.filter((r) => r.role === n && (r.scopeType === 'site' || r.scopeType === 'owner' || r.scopeType === 'fleet'))
      .map((r) => (r.scopeType === 'owner' ? `owner: ${r.ownerName ?? r.scopeId}` : r.scopeType === 'fleet' ? `fleet: ${r.fleetName ?? r.scopeId}` : r.siteName ?? r.scopeId));
    return `<div>${esc(roleLabel(n))}${sitesFor.length ? `<div class="cell-sub">${esc(sitesFor.join(', '))}</div>` : ''}</div>`;
  }).join('');
}

async function renderUsers(box) {
  const canWrite = state.can('user:write');
  box.innerHTML = `<div class="filters">
      ${field('Search', '<input type="search" data-q placeholder="Name, email or phone">')}
      ${field('Status', '<select data-st><option value="">All</option><option value="active">Active</option><option value="disabled">Disabled</option></select>')}
      <div class="right row">${canWrite ? `<button class="btn primary" data-invite>${icon('plus')} Invite user</button>` : ''}</div>
    </div><div class="card" data-list></div>`;
  let list = [];
  const draw = () => {
    const q = $('[data-q]', box).value.trim().toLowerCase();
    const st = $('[data-st]', box).value;
    const rows = list.filter((u) => (!st || u.status === st)
      && (!q || [u.name, u.email, u.phone].some((x) => String(x ?? '').toLowerCase().includes(q))));
    table($('[data-list]', box), {
      columns: [
        { label: 'User', render: (u) => `<div class="cell-title">${esc(u.name)}${u.id === myId() ? ' ' + tag('t-info', 'you', '', true) : ''}</div><div class="cell-sub">${esc(u.email ?? '')}</div>` },
        { label: 'Phone', render: (u) => esc(u.phone || '—') },
        { label: 'Role', render: roleCell },
        { label: 'Status', render: (u) => `<div class="chips">${statusTags(u)}</div>` },
        { label: 'Last sign-in', render: (u) => (u.last_login_at ? `<span title="${esc(fmt.time(u.last_login_at))}">${esc(fmt.ago(u.last_login_at))}</span>` : '<span class="muted">never</span>') },
      ],
      rows,
      empty: list.length ? 'No users match these filters.' : 'No users yet.',
      onRow: (u) => editUser(u, load),
    });
  };
  const load = async () => {
    try {
      list = await api('/v1/users');
    } catch (e) {
      $('[data-list]', box).innerHTML = `<div class="body">${callout('crit', esc(e.status === 403 ? 'You do not have permission to view users.' : e.message))}</div>`;
      return;
    }
    draw();
  };
  $('[data-q]', box).addEventListener('input', draw);
  $('[data-st]', box).addEventListener('change', draw);
  $('[data-invite]', box)?.addEventListener('click', () => inviteUser(load));
  await load();
}

// ------------------------------------------------------------------ role permission matrix

const MATRIX_COLS = ['Fleet Monitoring', 'Remote Commands', 'Add/Edit Hardware', 'Tariffs & Billing', 'DLM Power Ceilings', 'User Management'];
const MATRIX = [
  { role: 'super_admin', label: 'Super Administrator', cells: ['Full', 'Full', 'Full', 'Full', 'Full', 'Full'] },
  { role: 'cpo_operations_manager', label: 'CPO Operations Manager', cells: ['Full', 'Full', 'Full', 'Full', 'Full', 'Read Only'] },
  { role: 'site_host_landlord', label: 'Site Host / Landlord', cells: ['Site Only', 'None', 'None', 'View Revenue', 'Read Only', 'None'] },
  { role: 'field_technician', label: 'Field Technician', cells: ['Full', 'Full (Test Only)', 'Edit Config', 'None', 'Read Only', 'None'] },
  { role: 'financial_auditor', label: 'Financial Auditor', cells: ['Read Only', 'None', 'None', 'Full Export', 'Read Only', 'None'] },
];
const cellCls = (v) =>
  /Test|Config/.test(v) ? 't-warn' : v.startsWith('Full') ? 't-ok' : v === 'None' ? 't-mute' : 't-info';

const COL_PERMS = [
  ['Fleet Monitoring', 'site:read, charge_point:read — live status, connection log, OCPP log, quirks.'],
  ['Remote Commands', 'charge_point:command — remote start/stop, unlock, reset, availability, trigger message.'],
  ['Add/Edit Hardware', 'charge_point:write (register, adopt, suspend, decommission), charge_point:config (OCPP configuration keys, diagnostics), firmware:write.'],
  ['Tariffs & Billing', 'tariff:read/write, session:read/write, session:export, payment:*, invoice:*.'],
  ['DLM Power Ceilings', 'smartcharging:read to view site ceilings and curtailment; smartcharging:write to change them.'],
  ['User Management', 'user:read to view users; user:write to invite, change roles, disable and reset passwords.'],
];

const LEVELS = [
  ['Full', 't-ok', 'Holds both the read and write permissions for the area. Every control is available.'],
  ['Read Only', 't-info', 'Holds only the read permission. Write controls are hidden in the console and the API refuses writes with 403.'],
  ['Site Only', 't-info', 'Same permissions as a read role, but the grant is scoped to the assigned sites (scope type "site"). Every list, export and API call is filtered to those sites; other sites do not exist for this user.'],
  ['View Revenue', 't-info', 'session:read, payment:read and invoice:read at the hosted sites — their revenue share — with tariff:read but never tariff:write.'],
  ['Full (Test Only)', 't-warn', 'Holds charge_point:command but not session:write. Diagnostic commands (reset, unlock, availability, trigger) work normally; a remote start is accepted only with a Maintenance Technician or VIP/test card, so a technician can prove a charger works without starting a billable session for a customer.'],
  ['Edit Config', 't-warn', 'Holds charge_point:config: read and change OCPP configuration keys and pull diagnostics. Cannot register, adopt, suspend or decommission hardware (charge_point:write).'],
  ['Full Export', 't-ok', 'session:export on top of read access: bulk CSV export of sessions and invoices, plus the audit log.'],
  ['None', 't-mute', 'No permission for the area. The module is hidden from navigation and the API answers 403.'],
];

function renderMatrix(box) {
  const mine = new Set((state.me?.roles ?? []).map((r) => r.name));
  box.innerHTML = `
    <p class="hint" style="margin:0 0 12px">The five console roles of the platform specification (Module 10). A user holds exactly one; permissions are enforced by the API on every request, not only hidden in the console.</p>
    <div class="card"><div class="table-wrap"><table class="t matrix">
      <thead><tr><th>Role</th>${MATRIX_COLS.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${MATRIX.map((r) => `<tr>
        <td><div class="cell-title">${esc(roleDef(r.role)?.label ?? r.label)}${mine.has(r.role) ? ' ' + tag('t-info', 'your role', '', true) : ''}</div>
          <div class="cell-sub">${esc(roleDef(r.role)?.description ?? '')}</div></td>
        ${r.cells.map((c) => `<td>${tag(cellCls(c), c)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div></div>
    <div class="grid two section">
      <div class="card pad"><h3 style="font-size:13px;margin-bottom:10px">What each level means</h3>
        <dl class="kv">${LEVELS.map(([l, c, d]) => `<dt>${tag(c, l)}</dt><dd>${esc(d)}</dd>`).join('')}</dl></div>
      <div class="card pad"><h3 style="font-size:13px;margin-bottom:10px">Which permissions each column checks</h3>
        <dl class="kv">${COL_PERMS.map(([c, d]) => `<dt>${esc(c)}</dt><dd class="small">${esc(d)}</dd>`).join('')}</dl></div>
    </div>`;
}

// ------------------------------------------------------------------ API keys

function grantable() {
  const held = state.me?.permissions ?? [];
  return held.includes('platform:admin') ? ALL_PERMISSIONS : ALL_PERMISSIONS.filter((p) => held.includes(p));
}

async function issueKey(onDone) {
  const siteList = (await loadSites()).filter((s) => !s.archived_at);
  const perms = grantable();
  modal({
    title: 'Issue API key',
    subtitle: 'For machine integrations (billing systems, BI, fleet platforms). A key can never carry permissions you do not hold yourself.',
    size: 'lg',
    body: `<form novalidate>
      <div class="form">
        ${field('Key name', '<input name="name" maxlength="120" placeholder="e.g. ERP invoice sync">', { full: true, help: 'Describe the system that will use it, so it can be identified in the audit log.' })}
        ${field('Rate limit', '<div class="inputgroup"><input name="rateLimitPerMin" type="number" min="1" max="100000" step="1" placeholder="default"><span class="suffix">requests / min</span></div>', { help: 'Leave empty for the installation default. The key may send this many at once, then this many a minute.' })}
      </div>
      <fieldset style="margin-top:14px"><legend>Permissions</legend>
        <div class="row" style="margin-bottom:8px"><button type="button" class="btn sm ghost" data-readonly>Select read-only</button>
          <button type="button" class="btn sm ghost" data-none>Clear</button></div>
        <div class="form" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px 12px">${perms.map((p) => `
          <label class="check"><input type="checkbox" data-perm value="${esc(p)}"><span class="mono">${esc(p)}</span></label>`).join('')}</div>
      </fieldset>
      <fieldset style="margin-top:14px"><legend>Scope</legend>
        <div class="row" style="gap:16px">
          <label class="check"><input type="radio" name="scopeType" value="org" checked><span>Whole organisation</span></label>
          <label class="check"><input type="radio" name="scopeType" value="site"><span>A single site</span></label>
        </div>
        <div class="hidden" data-sitepick style="margin-top:10px">${field('Site', `<select name="scopeId"><option value="">Choose…</option>${siteList.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>`)}</div>
      </fieldset>
    </form>`,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Issue key',
        kind: 'primary',
        async onClick(ctx) {
          const form = $('form', ctx.body);
          const v = formValues(form);
          const permissions = $$('[data-perm]', form).filter((i) => i.checked).map((i) => i.value);
          if (!v.name?.trim()) { fieldErrors(form, { name: 'Give the key a name' }); return false; }
          if (!permissions.length) { toast('Choose at least one permission', 'warn'); return false; }
          if (v.scopeType === 'site' && !v.scopeId) { fieldErrors(form, { scopeId: 'Choose the site' }); return false; }
          const limit = String(v.rateLimitPerMin ?? '').trim();
          if (limit && !(Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 100000)) { fieldErrors(form, { rateLimitPerMin: 'A whole number from 1 to 100,000, or empty for the default' }); return false; }
          try {
            const r = await api('/v1/api-keys', {
              method: 'POST',
              body: { name: v.name.trim(), permissions, scopeType: v.scopeType, scopeId: v.scopeType === 'site' ? v.scopeId : null, rateLimitPerMin: limit ? Number(limit) : null },
            });
            toast('API key issued', 'ok');
            onDone?.();
            setTimeout(() => showSecret({
              title: 'New API key',
              label: v.name.trim(),
              secret: r.key,
              warning: r.warning ?? 'The key is shown once and cannot be retrieved later.',
            }), 0);
          } catch (e) {
            toast(e.message, 'crit');
            return false;
          }
        },
      },
    ],
    onMount(ctx) {
      const form = $('form', ctx.body);
      const sync = () => $('[data-sitepick]', form).classList.toggle('hidden', $('[name=scopeType]:checked', form)?.value !== 'site');
      $$('[name=scopeType]', form).forEach((i) => i.addEventListener('change', sync));
      $('[data-readonly]', form).addEventListener('click', () => $$('[data-perm]', form).forEach((i) => { i.checked = /:read$/.test(i.value); }));
      $('[data-none]', form).addEventListener('click', () => $$('[data-perm]', form).forEach((i) => { i.checked = false; }));
    },
  });
}

function editKeyLimit(k, onDone) {
  modal({
    title: `Rate limit of ${esc(k.name)}`,
    subtitle: `Now ${fmt.num(k.effective_rate_limit_per_min)} requests a minute${k.rate_limit_per_min == null ? ' (the default)' : ''}. The key may send its whole allowance at once, then refills steadily; over it, it is answered 429 with Retry-After.`,
    body: `<form novalidate><div class="form">${field('Requests a minute', `<input name="limit" type="number" min="1" max="100000" step="1" value="${k.rate_limit_per_min ?? ''}" placeholder="default">`, { full: true, help: 'Leave empty to use the installation default. A new limit applies from the key\'s next request.' })}</div></form>`,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save',
        kind: 'primary',
        async onClick(ctx) {
          const form = $('form', ctx.body);
          const raw = String(formValues(form).limit ?? '').trim();
          if (raw && !(Number.isInteger(Number(raw)) && Number(raw) >= 1 && Number(raw) <= 100000)) { fieldErrors(form, { limit: 'A whole number from 1 to 100,000, or empty for the default' }); return false; }
          if (await attempt(() => api(`/v1/api-keys/${encodeURIComponent(k.id)}`, { method: 'PATCH', body: { rateLimitPerMin: raw ? Number(raw) : null } }), { success: 'Rate limit saved' })) onDone?.();
          else return false;
        },
      },
    ],
  });
}

async function renderKeys(box) {
  const canWrite = state.can('org:write');
  box.innerHTML = `<div class="filters">
      <p class="hint grow" style="margin:0">API keys authenticate integrations with the <span class="mono">Authorization: Bearer</span> header. Only the prefix is stored in readable form; the secret is hashed.</p>
      ${canWrite ? `<div class="right"><button class="btn primary" data-issue>${icon('key')} Issue key</button></div>` : ''}
    </div><div class="card" data-list></div>`;
  const siteName = new Map((await loadSites()).map((s) => [s.id, s.name]));
  const load = async () => {
    let keys;
    try {
      keys = await api('/v1/api-keys');
    } catch (e) {
      $('[data-list]', box).innerHTML = `<div class="body">${callout(e.status === 403 ? 'warn' : 'crit', esc(e.status === 403 ? 'API keys are visible to organisation administrators (org:read).' : e.message))}</div>`;
      return;
    }
    table($('[data-list]', box), {
      columns: [
        { label: 'Name', render: (k) => `<div class="cell-title">${esc(k.name)}</div>` },
        { label: 'Prefix', render: (k) => `<span class="mono">${esc(k.prefix)}</span>` },
        { label: 'Permissions', render: (k) => `<div class="chips">${(k.permissions ?? []).map((p) => tag('t-info', p, '', true)).join('')}</div>` },
        { label: 'Scope', render: (k) => (k.scope_type === 'site' ? `site<div class="cell-sub">${esc(siteName.get(k.scope_id) ?? k.scope_id ?? '')}</div>` : esc(k.scope_type ?? 'org')) },
        { label: 'Created', render: (k) => esc(fmt.date(k.created_at)) },
        { label: 'Last used', render: (k) => (k.last_used_at ? `<span title="${esc(fmt.time(k.last_used_at))}">${esc(fmt.ago(k.last_used_at))}</span>` : '<span class="muted">never</span>') },
        { label: 'Rate limit', num: true, render: (k) => `${fmt.num(k.effective_rate_limit_per_min)}/min<div class="cell-sub">${k.rate_limit_per_min == null ? 'default' : 'own limit'}</div>` },
        { label: 'Last 24 h', num: true, render: (k) => `${fmt.num(k.requests_24h ?? 0)}${k.limited_24h ? `<div class="cell-sub" style="color:var(--warn)">${fmt.num(k.limited_24h)} over the limit</div>` : ''}${k.errors_24h ? `<div class="cell-sub">${fmt.num(k.errors_24h)} errors</div>` : ''}` },
        { label: 'Status', render: (k) => (k.revoked_at ? `${tag('t-mute', 'revoked')}<div class="cell-sub">${esc(fmt.date(k.revoked_at))}</div>` : tag('t-ok', 'active')) },
        ...(canWrite ? [{ label: '', render: (k) => (k.revoked_at ? '' : `<div class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn sm" type="button" data-limit>Limit</button><button class="btn sm danger" type="button" data-revoke>Revoke</button></div>`) }] : []),
      ],
      rows: keys,
      empty: 'No API keys issued yet.',
    });
    $$('[data-limit]', box).forEach((b) => b.addEventListener('click', () => {
      const k = keys[Number(b.closest('tr').dataset.i)];
      if (k) editKeyLimit(k, load);
    }));
    $$('[data-revoke]', box).forEach((b) => b.addEventListener('click', async () => {
      const k = keys[Number(b.closest('tr').dataset.i)];
      if (!k) return;
      const ok = await confirmDialog({
        title: 'Revoke API key',
        message: html`Revoke <b>${k.name}</b> (<span class="mono">${k.prefix}</span>)? Every integration using it stops working immediately. This cannot be undone.`,
        confirmLabel: 'Revoke key',
        danger: true,
      });
      if (!ok) return;
      if (await attempt(() => api(`/v1/api-keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' }), { success: 'API key revoked' })) load();
    }));
  };
  $('[data-issue]', box)?.addEventListener('click', () => issueKey(load));
  await load();
}

// ------------------------------------------------------------------ Microsoft sign-in (v1.6.0)

/**
 * The organisation's Microsoft Entra tenant: connect (the administrator signs in at Microsoft with
 * an account of the tenant; the server records the tenant of that validated sign-in), the allowed
 * email domains, disconnect. Users are never created from Microsoft: they are invited here first.
 */
async function renderMicrosoft(box) {
  const canWrite = state.can('user:write');
  let r;
  try {
    r = await api('/v1/auth/microsoft/tenant');
  } catch (e) {
    box.innerHTML = callout('crit', esc(e.status === 404 ? 'Microsoft sign-in is not set up on this installation.' : e.message));
    return;
  }
  const t = r.tenant;
  const domains = t?.allowedDomains ?? [];
  box.innerHTML = `<div class="card pad stack" style="gap:14px;max-width:820px">
      <div class="row" style="gap:10px"><span style="width:21px;height:21px;display:inline-block">${MS_MARK}</span>
        <h3 style="font-size:15px;margin:0">Sign in with Microsoft</h3>
        ${t ? tag('t-ok', 'connected') : tag('t-mute', 'not connected')}</div>
      <p class="hint" style="margin:0">Your staff sign in with their company Microsoft account (Microsoft Entra ID). Only people who already have a console user here can sign in — invite them under <b>Users</b> first, with the email address of their Microsoft account. The first Microsoft sign-in is matched by that address and then remembered, so later changes to the address in Microsoft do not move it to someone else. Password sign-in stays available for everyone. When Microsoft has checked a second factor (MFA), the console's own two-step verification is not asked again — except at a person's first Microsoft sign-in, which links their account.</p>
      ${t
        ? `<dl class="kv">
            <dt>Tenant ID</dt><dd class="mono">${esc(t.tenantId)}</dd>
            <dt>Connected</dt><dd>${esc(fmt.time(t.linkedAt))}${t.linkedBy ? ` by ${esc(t.linkedBy.name)}` : ''}${t.linkedByAccount ? ` <span class="muted">(proved with ${esc(t.linkedByAccount)})</span>` : ''}</dd>
            <dt>Users linked</dt><dd>${esc(String(r.boundUsers))} <span class="muted">— tagged "Microsoft" in the user list</span></dd>
            <dt>Allowed email domains</dt><dd>${domains.length ? domains.map((d) => tag('t-info', d, '', true)).join(' ') : '<span class="muted">any address of the tenant</span>'}</dd>
          </dl>`
        : callout('info', 'To connect, you sign in at Microsoft with an <b>administrator account of your organisation\'s Microsoft tenant</b> (Global Administrator, Privileged Role Administrator, Cloud Application Administrator or Application Administrator — not a guest); PlugSure records that tenant. If PlugSure has not been approved in your tenant yet, Microsoft asks for consent first.')}
      ${t && !domains.length ? callout('warn', '<b>Set the allowed email domains.</b> Without them, the first Microsoft sign-in of any account in your tenant is matched by its address alone — including addresses on domains you do not intend for console staff. List your company\'s domains (e.g. voltindo.co.id).') : ''}
      ${r.redirectUri ? '' : callout('warn', 'Microsoft sign-in is not offered on this console address. Open the console on its main address to connect, and to sign in with Microsoft.')}
      ${canWrite
        ? `<div class="row">${t
            ? `<button type="button" class="btn" data-domains>${icon('gear')} Allowed domains</button>
               <button type="button" class="btn danger" data-unlink>${icon('x')} Disconnect Microsoft tenant</button>`
            : `<button type="button" class="ms-signin sm" data-link${r.redirectUri ? '' : ' disabled'}>${MS_MARK}<span>Connect Microsoft tenant</span></button>`}</div>`
        : ''}
    </div>`;

  if (state.can('platform:admin')) await renderAllTenants(box);

  $('[data-link]', box)?.addEventListener('click', async (e) => {
    e.currentTarget.classList.add('busy');
    const x = await attempt(() => api('/v1/auth/microsoft/link', { method: 'POST' }));
    if (x?.url) location.assign(x.url);
    else e.currentTarget.classList.remove('busy');
  });

  $('[data-unlink]', box)?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Disconnect Microsoft tenant',
      message: html`Stop Microsoft sign-in for this organisation? Every user's link to their Microsoft account is removed and everyone signed in with Microsoft is signed out. Password sign-in is not affected. You can connect again later.`,
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    if (await attempt(() => api('/v1/auth/microsoft/tenant', { method: 'DELETE' }), { success: 'Microsoft tenant disconnected' })) renderMicrosoft(box);
  });

  $('[data-domains]', box)?.addEventListener('click', () => {
    modal({
      title: 'Allowed email domains',
      subtitle: 'Optional. When set, a first Microsoft sign-in is matched to a console user only by an address in one of these domains.',
      body: `<form novalidate><div class="form">${field('Domains', '<input name="domains" placeholder="e.g. voltindo.co.id, voltindo.com" autocomplete="off">', { full: true, help: 'Separate with commas. Leave empty to allow any address of your tenant.' })}</div></form>`,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save',
          kind: 'primary',
          async onClick(ctx) {
            const form = $('form', ctx.body);
            const list = String(formValues(form).domains ?? '').split(/[,\s]+/).map((d) => d.trim()).filter(Boolean);
            try {
              await api('/v1/auth/microsoft/tenant', { method: 'PUT', body: { allowedDomains: list } });
              toast('Allowed domains saved', 'ok');
              renderMicrosoft(box);
            } catch (e) {
              fieldErrors(form, { domains: e.message });
              return false;
            }
          },
        },
      ],
      onMount(ctx) { $('[name=domains]', ctx.body).value = domains.join(', '); },
    });
  });
}

/**
 * The platform operator: every organisation's connected tenant, and Release — the supported way
 * out of a tenant connected by an organisation that does not own it (it then cannot be
 * connected by its real owner: one organisation per tenant).
 */
async function renderAllTenants(box) {
  const wrap = document.createElement('div');
  wrap.className = 'card pad stack';
  wrap.style.cssText = 'gap:12px;max-width:820px;margin-top:14px';
  box.append(wrap);
  let list;
  try {
    list = (await api('/v1/platform/microsoft-tenants')).tenants ?? [];
  } catch (e) {
    wrap.innerHTML = callout('crit', esc(e.message));
    return;
  }
  wrap.innerHTML = `<h3 style="font-size:15px;margin:0">All connected tenants <span class="muted" style="font-weight:400">· platform operator</span></h3>
    <p class="hint" style="margin:0">Every connection raises a "Microsoft tenant connected" alert for you. If an organisation connected a tenant it does not own, release it: that organisation's Microsoft links and sessions end, and the real owner can connect it.</p>
    <div data-tenants></div>`;
  table($('[data-tenants]', wrap), {
    columns: [
      { label: 'Organisation', render: (t) => `<div class="cell-title">${esc(t.orgName)}</div>` },
      { label: 'Tenant ID', render: (t) => `<span class="mono">${esc(t.tenantId)}</span>` },
      { label: 'Connected', render: (t) => `${esc(fmt.time(t.linkedAt))}${t.linkedByAccount ? `<div class="cell-sub">${esc(t.linkedByAccount)}</div>` : ''}` },
      { label: 'Users linked', num: true, render: (t) => esc(String(t.boundUsers)) },
      { label: '', render: () => '<button class="btn sm danger" type="button" data-release>Release</button>' },
    ],
    rows: list,
    empty: 'No organisation has connected a Microsoft tenant.',
  });
  $$('[data-release]', wrap).forEach((b) => b.addEventListener('click', async () => {
    const t = list[Number(b.closest('tr').dataset.i)];
    if (!t) return;
    const ok = await confirmDialog({
      title: 'Release Microsoft tenant',
      message: html`Release tenant <span class="mono">${t.tenantId}</span> from <b>${t.orgName}</b>? Its users' Microsoft links are removed and everyone there signed in with Microsoft is signed out. Password sign-in is not affected.`,
      confirmLabel: 'Release',
      danger: true,
    });
    if (!ok) return;
    if (await attempt(() => api(`/v1/platform/microsoft-tenants/${encodeURIComponent(t.tenantId)}`, { method: 'DELETE' }), { success: 'Tenant released' })) {
      renderMicrosoft(box);
    }
  }));
}

// ------------------------------------------------------------------ view

registerView('users', {
  title: 'Users & Roles',
  icon: 'users',
  group: 'govern',
  order: 43,
  perm: ['user:read', 'org:read'],
  hubOnly: true,
  async render(root, [initial]) {
    const tabs = [
      state.can('user:read') && { id: 'users', label: 'Users', render: renderUsers },
      { id: 'roles', label: 'Role permissions', render: renderMatrix },
      state.can('org:read') && { id: 'keys', label: 'API keys', render: renderKeys },
      state.can('user:read') && state.me?.features?.microsoftSignIn && { id: 'microsoft', label: 'Microsoft sign-in', render: renderMicrosoft },
    ].filter(Boolean);

    root.innerHTML = pageHead(
      'Users & Roles',
      'Who can operate this network, and what each role may do. Every change here is recorded in the audit log.',
    ) + `<div class="tabs" role="tablist">${tabs.map((t) => `<button role="tab" type="button" aria-selected="false" data-tab="${esc(t.id)}">${esc(t.label)}</button>`).join('')}</div><div data-body></div>`;

    const body = $('[data-body]', root);
    const show = async (id) => {
      const t = tabs.find((x) => x.id === id) ?? tabs[0];
      $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t.id)));
      history.replaceState(null, '', `#/users/${t.id}`);
      body.innerHTML = '<div class="skeleton" style="height:120px"></div>';
      try {
        await t.render(body);
      } catch (e) {
        body.innerHTML = callout('crit', esc(e.message));
      }
    };
    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    await show(initial);
  },
});
