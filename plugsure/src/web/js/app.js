import {
  $, $$, esc, el, api, state, icon, toast, views, parseHash, navigate, setUnauthorizedHandler, setPasswordChangeHandler,
  startLive, stopLive, onLive, modal, formValues, fieldErrors, field, debounce, fmt, closeOverlays,
} from './core.js';

// Views register themselves on import.
import './views/dashboard.js';
import './views/chargers.js';
import './views/onboard.js';
import './views/onboarding.js';
import './views/sites.js';
import './views/power.js';
import './views/tariffs.js';
import './views/sessions.js';
import './views/refunds.js';
import './views/reports.js';
import './views/webhooks.js';
import './views/integrations.js';
import './views/developers.js';
import './views/driver-app.js';
import './views/alert-routing.js';
import './views/statements.js';
import './views/platform-billing.js';
import './views/billing.js';
import './views/fleet-billing.js';
import './views/pricing.js';
import './views/owners.js';
import './views/fleet-portal.js';
import './views/roaming.js';
import './views/rfid.js';
import './views/firmware.js';
import './views/connections.js';
import './views/pnc.js';
import './views/compliance.js';
import './views/logs.js';
import './views/users.js';

/**
 * Application shell: sign-in, the collapsible sidebar (built from the views the
 * principal's permissions allow), the top utility header, the hash router and
 * the live stream.
 */

const root = $('#app');
const LOGO = `<svg viewBox="0 0 120 120" aria-hidden="true"><rect width="120" height="120" rx="28" fill="#1b4d8c"/><rect x="40" y="22" width="10" height="28" rx="5" fill="#2fd6a7"/><rect x="70" y="22" width="10" height="28" rx="5" fill="#2fd6a7"/><path d="M32 68 56 92 92 46" stroke="#2fd6a7" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

const GROUPS = [
  ['operate', 'Operate'],
  ['assets', 'Assets & Energy'],
  ['commercial', 'Commercial'],
  ['maintain', 'Maintenance'],
  ['govern', 'Governance'],
];

let cleanupView = null;

// ------------------------------------------------------------------ theme

const THEME_COLOR = { light: '#ffffff', dark: '#151b23' };
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  // The phone's toolbar follows the console: a chosen theme overrides the OS setting.
  document.querySelectorAll('meta[data-theme-color]').forEach((m) => {
    m.content = THEME_COLOR[t === 'light' || t === 'dark' ? t : m.dataset.themeColor];
  });
}
try { applyTheme(localStorage.getItem('ps-theme')); } catch {}

// ------------------------------------------------------------------ sign in

function renderLogin(message = '') {
  stopLive();
  root.innerHTML = `
  <div class="login-wrap">
    <section class="login-art">
      <div class="row" style="gap:12px"><span style="width:40px;height:40px;display:block">${LOGO}</span>
        <div><b style="font-size:18px;color:#fff">PlugSure</b><div style="font-size:12px;opacity:.8">Enterprise CSMS</div></div></div>
      <div>
        <h1>Run your charging network from one console.</h1>
        <p>Onboard chargers, set PLN capacity limits, price sessions under Permen ESDM, and resolve faults remotely — without a terminal or a SQL prompt.</p>
        <ul><li>OCPP 1.6-J &amp; 2.0.1 dual stack</li><li>Security profiles 1–3 with mutual TLS</li><li>PBJT-TL &amp; PPN (DPP nilai lain) invoicing</li></ul>
      </div>
      <div style="font-size:12px;opacity:.7">ISO 27001-aligned: every action is attributed and hash-chained in the audit log.</div>
    </section>
    <section class="login-form">
      <form novalidate>
        <div><h2>Sign in</h2><p class="muted" style="margin:4px 0 0">Use the account your administrator created for you.</p></div>
        ${message ? `<div class="callout warn">${icon('warn')}<div>${esc(message)}</div></div>` : ''}
        ${field('Email', '<input name="email" type="email" autocomplete="username" required>')}
        ${field('Password', '<input name="password" type="password" autocomplete="current-password" required>')}
        <div class="err" data-error role="alert"></div>
        <button class="btn primary" type="submit" style="height:38px">Sign in</button>
        <p class="small muted">Forgotten your password? Ask a Super Administrator to reset it from <b>Users &amp; Roles</b>.</p>
      </form>
    </section>
  </div>`;
  const form = $('form', root);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    btn.classList.add('busy');
    $('[data-error]', form).textContent = '';
    try {
      const v = formValues(form);
      const r = await api('/v1/auth/login', { method: 'POST', body: v });
      await boot(r.mustChangePassword);
    } catch (err) {
      $('[data-error]', form).textContent = err.message;
    } finally {
      btn.classList.remove('busy');
    }
  });
  setTimeout(() => $('input[name=email]', form)?.focus(), 30);
}

setUnauthorizedHandler(() => renderLogin('Your session has ended. Please sign in again.'));
// Safety net: if the server ever answers "password change required" (it holds a
// one-time password to that), ask for a new password once, then reload the console.
let askingForPassword = false;
setPasswordChangeHandler(() => {
  if (askingForPassword) return;
  askingForPassword = true;
  changePasswordDialog(true, () => { askingForPassword = false; void boot(); });
});

/**
 * forced: the user signed in with a one-time password. The server refuses
 * everything else until it is replaced, so the console loads (onDone) only after.
 */
function changePasswordDialog(forced = false, onDone = null) {
  modal({
    title: forced ? 'Choose a new password' : 'Change password',
    subtitle: forced ? 'Your administrator issued a one-time password. Set your own before continuing.' : '',
    dismissable: !forced,
    body: `<form class="form one" novalidate>
      ${field(forced ? 'One-time password' : 'Current password', '<input name="current" type="password" autocomplete="current-password">')}
      ${field('New password', '<input name="next" type="password" autocomplete="new-password">', { help: 'At least 12 characters, mixing upper and lower case, digits or symbols.' })}
      ${field('Repeat new password', '<input name="again" type="password" autocomplete="new-password">')}
    </form>`,
    actions: [
      ...(forced
        ? [{ label: 'Sign out', async onClick() { await api('/v1/auth/logout', { method: 'POST' }).catch(() => {}); renderLogin(); } }]
        : [{ label: 'Cancel' }]),
      {
        label: forced ? 'Save and continue' : 'Save password',
        kind: 'primary',
        async onClick(ctx) {
          const v = formValues(ctx.body);
          if (v.next !== v.again) { fieldErrors(ctx.body, { again: 'The passwords do not match' }); return false; }
          try {
            await api('/v1/auth/change-password', { method: 'POST', body: { current: v.current, next: v.next } });
            toast('Password changed', 'ok');
            state.me.user.mustChangePassword = false;
            onDone?.();
          } catch (e) {
            fieldErrors(ctx.body, { [/current/i.test(e.message) ? 'current' : 'next']: e.message });
            return false;
          }
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ shell

/** Site Owner portal: the signed-in user acts for a site owner and sees only portal pages. */
const portalMode = () => (state.me?.owners?.length ?? 0) > 0;
/** Fleet customer portal: the user is a fleet customer's staff and sees only the fleet-portal page. */
const fleetMode = () => !portalMode() && (state.me?.fleets?.length ?? 0) > 0;
/** In a portal, only views flagged for it are shown. */
const inPortal = (v) => (portalMode() ? !!v.portal : fleetMode() ? !!v.fleetPortal : !v.fleetPortal);

function visibleViews() {
  return [...views.values()]
    .filter((v) => !v.hidden && (!v.perm || [].concat(v.perm).some((p) => state.can(p))) && inPortal(v))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

function renderShell() {
  const me = state.me;
  const initials = (me.user.name ?? '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const roleLabel = me.roles?.[0]?.label ?? (me.user.id?.startsWith?.('apikey:') ? 'API key' : 'Operator');
  let collapsed = false;
  try { collapsed = localStorage.getItem('ps-collapsed') === '1'; } catch {}

  root.innerHTML = `
  <div class="shell${collapsed ? ' collapsed' : ''}">
    <aside class="sidebar">
      <div class="brand">${LOGO}<b>PlugSure<small>Enterprise CSMS</small></b></div>
      <nav class="nav" aria-label="Main">${GROUPS.map(([g, label]) => {
        const items = visibleViews().filter((v) => v.group === g);
        if (!items.length) return '';
        return `<div class="nav-group"><div class="label">${esc(label)}</div>${items
          .map((v) => `<a href="#/${esc(v.id)}" data-view="${esc(v.id)}" title="${esc(v.title)}">${icon(v.icon)}<span>${esc(v.title)}</span>${v.id === 'dashboard' ? '<b class="count hidden" data-alerts></b>' : ''}</a>`)
          .join('')}</div>`;
      }).join('')}</nav>
      <div class="sidebar-foot"><div>${esc(portalMode() ? `${me.owners[0].name} · operated by ${me.org?.name ?? ''}` : fleetMode() ? `${me.fleets[0].name} · billed by ${me.org?.name ?? ''}` : me.org?.name ?? '')}</div><div class="mono">${me.features?.version ? `v${esc(me.features.version)} · ` : ''}${esc(me.features?.env ?? '')}</div></div>
    </aside>
    <div class="nav-scrim" data-scrim></div>
    <div class="main">
      <header class="topbar">
        <button class="btn ghost icon" data-toggle title="Collapse sidebar" aria-label="Toggle sidebar">${icon('menu')}</button>
        <div class="crumbs" data-crumbs></div>
        <div class="spacer"></div>
        <div class="search${fleetMode() ? ' hidden' : ''}" role="search">${icon('search')}
          <input type="search" placeholder="${portalMode() ? 'Find one of your chargers…' : 'Find a charger, site or card…  ( / )'}" aria-label="Search" data-search autocomplete="off">
          <button class="btn ghost icon search-close" type="button" data-search-close aria-label="Close search">${icon('x')}</button>
          <div class="results hidden" data-results></div></div>
        ${fleetMode() ? '' : `<button class="btn ghost icon mobile-only" type="button" data-search-open aria-label="Search" title="Search">${icon('search')}</button>`}
        ${portalMode() || fleetMode() ? '' : '<span class="row small muted" title="Live event stream"><span class="live-dot" data-live></span>live</span>'}
        <button class="userchip" data-user aria-haspopup="menu"><span class="avatar">${esc(initials)}</span>
          <span class="who"><b>${esc(me.user.name)}</b><small>${esc(roleLabel)}</small></span></button>
      </header>
      <main class="content" id="view" tabindex="-1"></main>
    </div>
  </div>`;

  $('[data-toggle]', root).addEventListener('click', () => {
    const shell = $('.shell', root);
    if (window.matchMedia('(max-width: 900px)').matches) { shell.classList.toggle('mobile-open'); return; }
    shell.classList.toggle('collapsed');
    try { localStorage.setItem('ps-collapsed', shell.classList.contains('collapsed') ? '1' : '0'); } catch {}
  });
  $$('.nav a', root).forEach((a) => a.addEventListener('click', () => $('.shell', root).classList.remove('mobile-open')));
  $('[data-scrim]', root).addEventListener('click', () => $('.shell', root).classList.remove('mobile-open'));

  // ---- user menu
  $('[data-user]', root).addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = $('.menu');
    if (existing) { existing.remove(); return; }
    const m = el(`<div class="menu" role="menu">
      <div style="padding:6px 10px 8px"><b></b><div class="small muted" data-email></div><div class="small muted" data-roles></div></div><hr>
      ${me.user.email ? `<button data-a="password">${icon('key')} Change password</button>` : ''}
      <button data-a="theme">${icon('sun')} Theme: <span data-theme-label></span></button>
      <hr><button data-a="logout">${icon('logout')} Sign out</button></div>`);
    $('b', m).textContent = me.user.name;
    $('[data-email]', m).textContent = me.user.email ?? '';
    $('[data-roles]', m).textContent = (me.roles ?? []).map((r) => r.label).join(', ') || roleLabel;
    const themeLabel = () => { let t = 'system'; try { t = localStorage.getItem('ps-theme') || 'system'; } catch {} $('[data-theme-label]', m).textContent = t; };
    themeLabel();
    m.addEventListener('click', async (ev) => {
      const a = ev.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'theme') {
        let t = 'system'; try { t = localStorage.getItem('ps-theme') || 'system'; } catch {}
        const next = t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system';
        try { localStorage.setItem('ps-theme', next === 'system' ? '' : next); } catch {}
        applyTheme(next); themeLabel(); return;
      }
      m.remove();
      if (a === 'password') changePasswordDialog(false);
      if (a === 'logout') {
        await api('/v1/auth/logout', { method: 'POST' }).catch(() => {});
        state.me = null;
        renderLogin();
      }
    });
    document.body.append(m);
    setTimeout(() => document.addEventListener('click', function close(ev2) { if (!m.contains(ev2.target)) { m.remove(); document.removeEventListener('click', close); } }), 0);
  });

  wireSearch();
  // The live event stream is org-wide; portal users do not get it (pages refresh on load).
  if (!portalMode() && !fleetMode()) startLive($('[data-live]', root));
  onLive((e) => { if (e.kind === 'alert.raised') refreshAlertCount(); });
  refreshAlertCount();
}

async function refreshAlertCount() {
  const badge = $('[data-alerts]');
  if (!badge) return;
  const d = await api('/v1/dashboard').catch(() => null);
  const n = d?.alerts?.critical ?? 0;
  badge.textContent = String(n);
  badge.classList.toggle('hidden', !n);
}

// ------------------------------------------------------------------ global search

function wireSearch() {
  const input = $('[data-search]', root);
  const box = $('[data-results]', root);
  let items = [];
  let active = -1;
  const close = () => { box.classList.add('hidden'); active = -1; };

  // Phones: the search box is hidden in the header; a search button opens it as a
  // full-width bar over the header, and it folds away again after use.
  const topbar = $('.topbar', root);
  const closeMobile = () => { topbar.classList.remove('search-open'); input.value = ''; close(); };
  // (The fleet customer portal has no search: it has one page.)
  $('[data-search-open]', root)?.addEventListener('click', () => {
    topbar.classList.add('search-open');
    input.focus();
  });
  $('[data-search-close]', root).addEventListener('click', () => { closeMobile(); input.blur(); });
  // A tap on a result navigates; route() folds the bar away.
  box.addEventListener('click', (e) => { if (e.target.closest('a')) closeMobile(); });
  const draw = () => {
    box.innerHTML = items.length
      ? items.map((it, i) => `<a href="${esc(it.href)}" class="${i === active ? 'active' : ''}">${icon(it.icon)}<div><div class="cell-title">${esc(it.title)}</div><div class="cell-sub">${esc(it.sub)}</div></div></a>`).join('')
      : '<div class="empty-state small">No matches</div>';
    box.classList.remove('hidden');
  };
  const run = debounce(async () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { close(); return; }
    const [cps, siteList, cards] = await Promise.all([
      state.can('charge_point:read') ? api('/v1/charge-points').catch(() => []) : [],
      // Portal users cannot open the Sites page: search their chargers only.
      state.can('site:read') && !portalMode() ? api('/v1/sites').catch(() => []) : [],
      state.can('token:read') ? api(`/v1/tokens?q=${encodeURIComponent(q)}&limit=5`).catch(() => []) : [],
    ]);
    items = [
      ...cps.filter((c) => [c.ocpp_identity, c.display_name, c.model, c.site_name].some((x) => String(x ?? '').toLowerCase().includes(q)))
        .slice(0, 6).map((c) => ({ href: `#/chargers/${encodeURIComponent(c.ocpp_identity)}`, icon: 'charger', title: c.display_name || c.ocpp_identity, sub: `${c.ocpp_identity} · ${c.site_name}` })),
      ...siteList.filter((s) => [s.name, s.spklu_id, s.address].some((x) => String(x ?? '').toLowerCase().includes(q)))
        .slice(0, 4).map((s) => ({ href: `#/sites/${encodeURIComponent(s.id)}`, icon: 'site', title: s.name, sub: s.spklu_id ?? s.address ?? '' })),
      ...cards.slice(0, 4).map((t) => ({ href: `#/rfid/${encodeURIComponent(t.id)}`, icon: 'card', title: t.uid, sub: t.holder_name ?? t.account_type })),
    ];
    active = items.length ? 0 : -1;
    draw();
  }, 200);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
    if (e.key === 'Enter' && items[active]) { navigate(items[active].href); closeMobile(); input.blur(); }
    if (e.key === 'Escape') { closeMobile(); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(() => {
    close();
    // Tapping elsewhere folds the phone bar away, unless the tap was its own close button
    // or the box still has text the operator may come back to.
    if (!input.value.trim()) topbar.classList.remove('search-open');
  }, 150));
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { e.preventDefault(); input.focus(); }
  });
}

// ------------------------------------------------------------------ routing

async function route() {
  if (!state.me) return;
  // An overlay belongs to the page that opened it. Without this, drawers
  // survived navigation and stacked up (on a phone, covering the new page).
  // It also makes the phone's Back button close an open drawer.
  closeOverlays();
  $('.shell', root)?.classList.remove('mobile-open');
  $('.topbar', root)?.classList.remove('search-open');
  const { view, params } = parseHash();
  const allowed = visibleViews();
  const want = views.get(view);
  const def = want && ((want.hidden && inPortal(want)) || allowed.includes(want)) ? want : allowed[0];
  if (!def) {
    $('#view').innerHTML = '<div class="empty-state"><h3>No modules available</h3><p>Your role does not grant access to any console module. Ask an administrator.</p></div>';
    return;
  }
  $$('.nav a', root).forEach((a) => a.setAttribute('aria-current', a.dataset.view === (def.navAs ?? def.id) ? 'page' : 'false'));
  $('[data-crumbs]', root).innerHTML = `${esc(def.title)}${def.subtitle ? ` <span class="sub">· ${esc(def.subtitle)}</span>` : ''}`;
  document.title = `${def.title} — PlugSure CSMS`;
  try { cleanupView?.(); } catch {}
  cleanupView = null;
  const target = $('#view');
  target.innerHTML = '<div class="skeleton" style="width:30%;height:22px;margin-bottom:14px"></div><div class="skeleton" style="height:160px"></div>';
  try {
    const r = await def.render(target, params);
    if (typeof r === 'function') cleanupView = r;
  } catch (e) {
    target.innerHTML = `<div class="callout crit">${icon('warn')}<div><b>This view failed to load.</b><br>${esc(e.message)}</div></div>`;
  }
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------ boot

async function boot(mustChangePassword = false) {
  try {
    const [me, meta] = await Promise.all([api('/v1/auth/me'), api('/v1/meta')]);
    state.me = me;
    state.meta = meta;
  } catch (e) {
    if (e.status === 401) return renderLogin();
    root.innerHTML = `<div class="content"><div class="callout crit">${icon('warn')}<div><b>Cannot reach the PlugSure API.</b><br>${esc(e.message)}</div></div></div>`;
    return;
  }
  const start = async () => { renderShell(); await route(); };
  if (mustChangePassword || state.me.user.mustChangePassword) {
    // Nothing else is served until the one-time password is replaced.
    root.innerHTML = '';
    changePasswordDialog(true, () => void start());
    return;
  }
  await start();
}

boot();

export { fmt };
