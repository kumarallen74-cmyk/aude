import {
  $, $$, esc, api, attempt, state, registerView, pageHead, table, tag, icon, fmt, modal, field, options,
  toast, callout, kpi, debounce, onLive, sites as loadSites,
} from '../core.js';

/**
 * Connections: every WebSocket handshake a charger made (accepted or not), and
 * the adoption queue of identities that knocked and were turned away. This is
 * the first place to look on a commissioning visit — "did it reach us at all?".
 *
 * Identities, paths, user agents and IPs are supplied by the hardware over an
 * unauthenticated handshake: everything is escaped.
 */

const OUTCOMES = {
  accepted: ['t-ok', 'accepted', 'WebSocket upgrade accepted — the charger is connected.'],
  accepted_pending_adoption: ['t-warn', 'accepted · pending', 'Connected, but the charge point is awaiting activation: BootNotification is answered Pending and it cannot transact until an operator activates it.'],
  rejected_unknown_cp: ['t-crit', 'unknown identity', 'Identity is not registered — adopt it, or fix the serial on the unit.'],
  rejected_auth: ['t-crit', 'auth failed', 'Credentials missing or wrong for the required security profile.'],
  rejected_no_subprotocol: ['t-crit', 'no subprotocol', 'The charger did not offer an OCPP version this server speaks (e.g. ocpp1.6) in Sec-WebSocket-Protocol.'],
  rejected_no_identity: ['t-crit', 'no identity', 'The CentralSystem URL is missing the trailing /<identity>.'],
  rejected_tls_required: ['t-crit', 'TLS required', 'The security profile requires wss:// (TLS) but the charger connected over plaintext ws://.'],
  rejected_malformed_path: ['t-crit', 'malformed path', 'The URL path is not a valid CentralSystem path, or the identity contains characters that are not allowed.'],
  error: ['t-crit', 'server error', 'The server failed while handling the handshake — see the detail column.'],
};
const outcomeTag = (o) => {
  const d = OUTCOMES[o];
  return d ? tag(d[0], d[1], `${o}: ${d[2]}`) : tag('t-mute', o ?? 'unknown');
};
const tlsTag = (tls) => (tls ? tag('t-ok', 'TLS') : tag('t-warn', 'plaintext', 'Unencrypted ws:// — credentials and data travel in the clear'));
const n = (x) => Number(x ?? 0);

function tabBar(tabs) {
  return `<div class="tabs" role="tablist">${tabs.map((t) => `<button role="tab" type="button" aria-selected="false" data-tab="${esc(t.id)}">${esc(t.label)}</button>`).join('')}</div>`;
}

// ------------------------------------------------------------------ connection attempts

function attemptsTab(box) {
  box.innerHTML = `
    <div class="grid k4" data-kpis></div>
    <div class="filters section">
      ${field('Outcome', `<select data-f="outcome">${options(Object.keys(OUTCOMES).map((k) => ({ value: k, label: `${OUTCOMES[k][1]} (${k})` })), '', { blank: 'All outcomes' })}</select>`)}
      ${field('Identity', '<input type="search" data-f="identity" placeholder="Exact charge point identity" autocomplete="off">')}
      ${field('Show', `<select data-f="limit">${options([100, 200, 500, 1000].map((v) => ({ value: v, label: `latest ${v}` })), 200)}</select>`)}
    </div>
    <details class="card pad" style="margin-bottom:12px"><summary class="small" style="cursor:pointer"><b>What do these outcomes mean?</b></summary>
      <dl class="kv" style="margin-top:10px">${Object.entries(OUTCOMES).map(([k, d]) => `<dt>${tag(d[0], d[1])}</dt><dd><span class="mono muted">${esc(k)}</span> — ${esc(d[2])}</dd>`).join('')}</dl>
    </details>
    <div class="card" data-list></div>`;

  const val = (k) => $(`[data-f="${k}"]`, box).value.trim();

  const draw = async () => {
    const qs = new URLSearchParams();
    if (val('outcome')) qs.set('outcome', val('outcome'));
    if (val('identity')) qs.set('identity', val('identity'));
    qs.set('limit', val('limit') || '200');
    let rows;
    let stats = null;
    try {
      [rows, stats] = await Promise.all([
        api(`/v1/connection-attempts?${qs}`),
        api('/v1/connection-attempts/stats').catch(() => null),
      ]);
    } catch (e) {
      $('[data-list]', box).innerHTML = `<div class="body">${callout('crit', esc(e.message))}</div>`;
      return;
    }
    const accepted = rows.filter((r) => r.outcome === 'accepted' || r.outcome === 'accepted_pending_adoption').length;
    const plaintext = rows.filter((r) => !r.tls).length;
    const ids = new Set(rows.map((r) => r.ocpp_identity).filter(Boolean));
    $('[data-kpis]', box).innerHTML = [
      kpi('Attempts shown', fmt.num(rows.length), stats ? `${fmt.num(n(stats.accepted) + n(stats.pending_adoption) + n(stats.rejected))} in the last hour` : 'matching the filters'),
      kpi('Accepted / refused', `${fmt.num(accepted)} / ${fmt.num(rows.length - accepted)}`,
        stats ? `last hour: ${fmt.num(n(stats.accepted))} accepted, ${fmt.num(n(stats.rejected))} refused` : '', rows.length - accepted ? 'warn' : 'ok'),
      kpi('Distinct identities', fmt.num(ids.size), stats ? `${fmt.num(n(stats.identities))} in the last hour` : ''),
      kpi('Over plaintext', fmt.num(plaintext), 'ws:// without TLS', plaintext ? 'warn' : ''),
    ].join('');
    table($('[data-list]', box), {
      columns: [
        { label: 'Time', render: (r) => `<div class="nowrap">${esc(fmt.time(r.ts))}</div><div class="cell-sub">${esc(fmt.ago(r.ts))}</div>` },
        { label: 'Outcome', render: (r) => `${outcomeTag(r.outcome)}${r.http_status ? `<div class="cell-sub">HTTP ${esc(r.http_status)}</div>` : ''}` },
        { label: 'Identity / path', render: (r) => `<div class="cell-title mono">${esc(r.ocpp_identity ?? '—')}</div><div class="cell-sub mono wrap">${esc(r.request_path ?? '')}</div>` },
        { label: 'Transport', render: (r) => tlsTag(r.tls) },
        { label: 'Auth', render: (r) => (r.auth_present ? tag('t-info', r.auth_scheme || 'credentials sent') : tag('t-mute', 'none')) },
        { label: 'Subprotocols', render: (r) => `<div class="mono small">${esc(r.subprotocols || '—')}</div><div class="cell-sub">negotiated: <span class="mono">${esc(r.negotiated || 'none')}</span></div>` },
        { label: 'Source', render: (r) => `<div class="mono small">${esc(r.remote_ip ?? '—')}</div>${r.forwarded_for ? `<div class="cell-sub mono">XFF ${esc(r.forwarded_for)}</div>` : ''}${r.user_agent ? `<div class="cell-sub wrap">${esc(r.user_agent)}</div>` : ''}` },
        { label: 'Detail', render: (r) => `<div class="small wrap" style="max-width:320px">${esc(r.detail ?? '')}</div>` },
      ],
      rows,
      empty: 'No connection attempts match. A charger that never appears here has not reached the server — check its CentralSystem URL, network and firewall.',
    });
  };

  const redraw = debounce(() => draw(), 300);
  $$('[data-f]', box).forEach((i) => i.addEventListener(i.tagName === 'INPUT' ? 'input' : 'change', redraw));
  return draw;
}

// ------------------------------------------------------------------ pending adoption

async function showSuggestions(identity) {
  const list = await attempt(() => api(`/v1/pending-chargers/${encodeURIComponent(identity)}/suggestions`));
  if (!list) return;
  const m = modal({
    title: 'Near matches',
    subtitle: 'Registered identities in your fleet that resemble this one.',
    body: `<p style="margin:0 0 10px">Refused identity: <span class="mono" data-id></span></p>
      ${list.length
        ? `${callout('info', 'If one of these is the same unit, the serial on the charger is mistyped (wrong case or transposed characters). Correct its ChargeBoxIdentity / CentralSystem URL instead of adopting a duplicate.')}<div data-list style="margin-top:10px"></div>`
        : callout('ok', 'No near matches in your fleet — this looks like a genuinely new charger. Adopt it into a site.')}`,
  });
  $('[data-id]', m.body).textContent = identity;
  if (list.length) {
    table($('[data-list]', m.body), {
      columns: [
        { label: 'Registered identity', render: (s) => `<a class="mono" href="#/chargers/${encodeURIComponent(s.ocpp_identity)}">${esc(s.ocpp_identity)}</a>` },
        { label: 'Site', render: (s) => esc(s.site_name ?? '—') },
      ],
      rows: list,
    });
    $$('a', m.body).forEach((a) => a.addEventListener('click', () => m.close()));
  }
}

function offerActivation(identity, siteName, onDone) {
  const m = modal({
    title: 'Charger adopted',
    body: `${callout('ok', `<span class="mono" data-id></span> is now registered at <b data-site></b> in <b>pending adoption</b>.`)}
      <p style="margin:12px 0 0">While pending, the charger may connect but every BootNotification is answered <span class="mono">Pending</span> and it cannot transact.
      Activate it now if its credentials and security profile are already correct, or later from the charger's commissioning page.</p>`,
    actions: [
      { label: 'Later', onClick: () => { onDone?.(); } },
      {
        label: 'Activate now',
        kind: 'primary',
        async onClick() {
          const r = await attempt(() => api(`/v1/charge-points/${encodeURIComponent(identity)}/activate`, { method: 'POST' }));
          if (!r) return false;
          toast(r.activated ? 'Charger activated — it may now transact' : 'Charger was already active', 'ok');
          onDone?.();
        },
      },
    ],
  });
  $('[data-id]', m.body).textContent = identity;
  $('[data-site]', m.body).textContent = siteName;
}

function pendingTab(box) {
  const canWrite = state.can('charge_point:write');
  box.innerHTML = `<p class="hint" style="margin:0 0 12px">Identities that connected and were refused because no charge point is registered under that name (or that failed authentication / TLS before being registered). Adopting one registers it at a site in <b>pending adoption</b>; activating it lets it transact.</p>
    <div class="card" data-list></div>`;

  const draw = async () => {
    let rows;
    try {
      rows = await api('/v1/pending-chargers');
    } catch (e) {
      $('[data-list]', box).innerHTML = `<div class="body">${e.status === 403
        ? callout('info', `<b>The adoption queue is a platform-operator view.</b> A refused identity belongs to no organisation, so listing them would expose other tenants' hardware, source IPs and authentication failures.
            To commission a charger, pre-register its identity first${canWrite ? ' with <a href="#/onboard">Onboard a charger</a>' : ''}; its connection attempts then appear in the <b>Connection attempts</b> tab.`)
        : callout('crit', esc(e.message))}</div>`;
      return;
    }
    const siteList = canWrite ? (await loadSites()).filter((s) => !s.archived_at) : [];
    const siteOpts = options(siteList.map((s) => ({ value: s.id, label: s.name })), '', { blank: 'Adopt into…' });
    table($('[data-list]', box), {
      columns: [
        { label: 'Identity', render: (p) => `<div class="cell-title mono">${esc(p.ocpp_identity)}</div><button type="button" class="btn sm ghost" data-suggest>${icon('search')} Suggestions</button>` },
        { label: 'Attempts', num: true, render: (p) => esc(fmt.num(p.attempts)) },
        { label: 'First seen', render: (p) => esc(fmt.time(p.first_seen_at)) },
        { label: 'Last seen', render: (p) => `<span title="${esc(fmt.time(p.last_seen_at))}">${esc(fmt.ago(p.last_seen_at))}</span>` },
        { label: 'Last outcome', render: (p) => outcomeTag(p.last_outcome) },
        { label: 'Transport', render: (p) => `${tlsTag(p.last_tls)}${p.last_subprotocols ? `<div class="cell-sub mono">${esc(p.last_subprotocols)}</div>` : ''}` },
        { label: 'Credentials seen?', render: (p) => (p.ever_sent_credentials ? tag('t-info', 'yes') : tag('t-mute', 'never', 'The unit has never sent a Basic auth header — set its AuthorizationKey before activating a profile ≥ 1')) },
        { label: 'Source IP', render: (p) => `<span class="mono small">${esc(p.last_remote_ip ?? '—')}</span>` },
        ...(canWrite ? [{ label: 'Adopt', render: () => `<div class="row" style="flex-wrap:nowrap"><select data-site style="min-width:170px">${siteOpts}</select><button type="button" class="btn sm primary" data-adopt>Adopt</button></div>` }] : []),
      ],
      rows,
      empty: 'Nothing waiting. Every charger that has connected is registered.',
    });
    const rowOf = (el) => rows[Number(el.closest('tr').dataset.i)];
    $$('[data-suggest]', box).forEach((b) => b.addEventListener('click', () => { const p = rowOf(b); if (p) showSuggestions(p.ocpp_identity); }));
    $$('[data-adopt]', box).forEach((b) => b.addEventListener('click', async () => {
      const p = rowOf(b);
      const sel = $('[data-site]', b.closest('tr'));
      if (!p) return;
      if (!sel.value) { sel.classList.add('invalid'); toast('Choose the site this charger is installed at', 'warn'); return; }
      b.classList.add('busy');
      const r = await attempt(() => api(`/v1/pending-chargers/${encodeURIComponent(p.ocpp_identity)}/adopt`, { method: 'POST', body: { siteId: sel.value } }));
      b.classList.remove('busy');
      if (!r) return;
      state.sitesCache = null;
      offerActivation(p.ocpp_identity, sel.selectedOptions[0]?.textContent ?? '', () => draw());
      draw();
    }));
  };
  return draw;
}

// ------------------------------------------------------------------ view

registerView('connections', {
  title: 'Connections',
  icon: 'plug',
  group: 'operate',
  order: 3,
  perm: 'charge_point:read',
  async render(root, [initial]) {
    const tabs = [
      { id: 'attempts', label: 'Connection attempts', make: attemptsTab },
      { id: 'pending', label: 'Pending adoption', make: pendingTab },
    ];
    root.innerHTML = pageHead(
      'Connections',
      'Every handshake a charger attempts, with the reason it was refused in plain language — and the chargers waiting to be adopted.',
      `<button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button>${
        state.can('charge_point:write') ? `<a class="btn primary" href="#/onboard">${icon('plus')} Onboard a charger</a>` : ''}`,
    ) + tabBar(tabs) + '<div data-body></div>';

    const body = $('[data-body]', root);
    let draw = null;
    const show = async (id) => {
      const t = tabs.find((x) => x.id === id) ?? tabs[0];
      $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t.id)));
      history.replaceState(null, '', `#/connections/${t.id}`);
      body.innerHTML = '';
      const inner = document.createElement('div');
      body.append(inner);
      draw = t.make(inner);
      await draw();
    };
    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    $('[data-refresh]', root).addEventListener('click', () => draw?.());

    await show(initial);
    const redraw = debounce(() => { draw?.().catch(() => {}); }, 1200);
    const off = onLive((e) => {
      if (e.kind === 'charge_point.connected' || e.kind === 'charge_point.disconnected') redraw();
    });
    return () => off();
  },
});
