import {
  $, $$, esc, api, attempt, state, registerView, pageHead, table, tag, icon, fmt, field, options, callout, modal, confirmDialog, toast, copy, drawer, formValues, download,
} from '../core.js';

/**
 * Roaming (OCPI 2.2.1): other networks' drivers charge on this operator's
 * chargers, and their providers are billed with a charge record per session.
 *
 *   Partners          connect a provider (eMSP), an operator (CPO) or a hub; see what went back and forth
 *   Shared sites      choose which sites partners may show to their drivers
 *   Roaming sessions  other networks' drivers here, and whether their charge record was sent
 *   Cards abroad      your fleet cards on other networks, and the charges to pay and bill on
 *   Partner network   other operators' chargers your cards can use; start and stop charges there
 */

const STATE_TAG = {
  pending: ['t-warn', 'waiting for partner'],
  connected: ['t-ok', 'connected'],
  suspended: ['t-mute', 'suspended'],
};
const PUSH_TAG = { pending: 't-info', delivered: 't-ok', failed: 't-crit' };
const MODULE_LABEL = { locations: 'Location', tariffs: 'Tariff', sessions: 'Session', cdrs: 'Charge record', commands: 'Command result', tokens: 'Card', chargingprofiles: 'Charging limit result' };
const AUTH_LABEL = { WHITELIST: 'card (pre-approved)', AUTH_REQUEST: 'card (checked with provider)', COMMAND: 'app start' };

const partyOf = (p) => (p.country_code ? `${p.country_code}*${p.party_id}` : '—');
const KIND_LABEL = { emsp: 'Service provider', cpo: 'Charge point operator', hub: 'Roaming hub' };
const HUB_CLIENT_TAG = { CONNECTED: 't-ok', OFFLINE: 't-warn', PLANNED: 't-mute', SUSPENDED: 't-crit' };
const EVSE_TAG = { AVAILABLE: 't-ok', CHARGING: 't-info', RESERVED: 't-info', BLOCKED: 't-warn', OUTOFORDER: 't-crit', INOPERATIVE: 't-mute', UNKNOWN: 't-mute', PLANNED: 't-mute' };

function showRegistration(r) {
  modal({
    title: 'Send these to the partner',
    subtitle: r.partner.name,
    size: 'lg',
    dismissable: false,
    body: `${callout('warn', 'The token is shown once. Send it to the partner over a secure channel; it only lets them register, and stops working as soon as they do.')}
      <div class="form one" style="margin-top:12px">
        ${field('Versions URL', `<div class="row" style="gap:8px"><code class="mono grow" style="word-break:break-all">${esc(r.versionsUrl)}</code><button class="btn sm" type="button" data-copy-url>${icon('copy')} Copy</button></div>`)}
        ${field('Registration token (token A)', `<div class="row" style="gap:8px"><code class="mono grow" style="word-break:break-all">${esc(r.token)}</code><button class="btn sm" type="button" data-copy-token>${icon('copy')} Copy</button></div>`)}
      </div>
      <p class="cell-sub" style="margin-top:12px">The partner calls the versions URL with this token, then posts its own credentials. The connection shows as <b>connected</b> here once it has.</p>`,
    actions: [{ label: 'Done', kind: 'primary' }],
    onMount(ctx) {
      $('[data-copy-url]', ctx.body).addEventListener('click', () => copy(r.versionsUrl));
      $('[data-copy-token]', ctx.body).addEventListener('click', () => copy(r.token));
    },
  });
}

function editIdentity(party, done) {
  modal({
    title: 'Roaming identity',
    subtitle: 'How partners and their drivers see this network. Partners cannot follow a change of party ID, so choose it once.',
    body: `<div class="form">
      ${field('Country code', `<input name="countryCode" maxlength="2" value="${esc(party?.country_code ?? 'ID')}" autocomplete="off">`, { help: 'ISO 3166 alpha-2: ID for Indonesia.' })}
      ${field('Party ID', `<input name="partyId" maxlength="3" value="${esc(party?.party_id ?? '')}" placeholder="PLS" autocomplete="off">`, { help: 'Three letters or digits, unique among roaming operators. Shown in every EVSE id (ID*PLS*E…).' })}
      ${field('Business name', `<input name="businessName" value="${esc(party?.business_name ?? '')}" placeholder="PT Nusantara Charge">`, { full: true })}
      ${field('Website', `<input name="website" value="${esc(party?.website ?? '')}" placeholder="https://…">`, { full: true, opt: true })}
    </div>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Save', kind: 'primary',
      async onClick(ctx) {
        const v = formValues(ctx.body);
        if (await attempt(() => api('/v1/roaming/party', { method: 'PUT', body: v }), { success: 'Roaming identity saved' })) done();
        else return false;
      },
    }],
  });
}

function addPartner(done) {
  modal({
    title: 'Add a roaming partner',
    size: 'lg',
    body: `<div class="form one">
      ${field('Name', '<input name="name" placeholder="e.g. Hubject, or a local app" autocomplete="off">')}
      ${field('Type', `<select name="kind">${options([{ value: 'emsp', label: 'Service provider (eMSP): its drivers charge on your chargers' }, { value: 'cpo', label: 'Charge point operator (CPO): your cards charge on its chargers' }, { value: 'hub', label: 'Roaming hub: one connection to many providers and operators' }], 'emsp')}</select>`)}
      <div class="field"><label>Who starts the connection?</label>
        <label class="check"><input type="radio" name="how" value="them" checked> <span><b>The partner connects to us.</b> You get a versions URL and a one-time token to send them.</span></label>
        <label class="check"><input type="radio" name="how" value="us"> <span><b>We connect to the partner.</b> They gave you their versions URL and a token.</span></label>
      </div>
      <div data-us hidden class="form one">
        ${field("Partner's versions URL", '<input name="versionsUrl" placeholder="https://ocpi.partner.example/versions" autocomplete="off">')}
        ${field("Partner's token", '<input name="token" autocomplete="off">')}
      </div>
    </div>`,
    onMount(ctx) {
      $$('[name="how"]', ctx.body).forEach((r) => r.addEventListener('change', () => {
        $('[data-us]', ctx.body).hidden = $('[name="how"]:checked', ctx.body).value !== 'us';
      }));
    },
    actions: [{ label: 'Cancel' }, {
      label: 'Add partner', kind: 'primary',
      async onClick(ctx) {
        const v = formValues(ctx.body);
        const how = $('[name="how"]:checked', ctx.body).value;
        if (!v.name) { $('[name="name"]', ctx.body).classList.add('invalid'); return false; }
        if (how === 'us' && (!v.versionsUrl || !v.token)) { toast("Enter the partner's versions URL and token", 'warn'); return false; }
        const r = await attempt(() => api('/v1/roaming/partners', { method: 'POST', body: { name: v.name, kind: v.kind } }));
        if (!r) return false;
        if (how === 'them') { done(); setTimeout(() => showRegistration(r), 50); return; }
        const c = await attempt(() => api(`/v1/roaming/partners/${r.partner.id}/connect`, { method: 'POST', body: { versionsUrl: v.versionsUrl, token: v.token } }), { success: 'Connected' });
        done();
        if (!c) toast('The partner was added but not connected. Open it to try again.', 'warn');
      },
    }],
  });
}

function connectExisting(p, done) {
  modal({
    title: `Connect to ${p.name}`,
    body: `<div class="form one">
      ${field("Partner's versions URL", '<input name="versionsUrl" placeholder="https://ocpi.partner.example/versions" autocomplete="off">')}
      ${field("Partner's token", '<input name="token" autocomplete="off">')}
    </div>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Connect', kind: 'primary',
      async onClick(ctx) {
        const v = formValues(ctx.body);
        if (await attempt(() => api(`/v1/roaming/partners/${p.id}/connect`, { method: 'POST', body: v }), { success: 'Connected' })) done();
        else return false;
      },
    }],
  });
}

function openPartner(p, canWrite, done) {
  const d = drawer({
    title: p.name,
    subtitle: `${esc(KIND_LABEL[p.kind] ?? p.kind)} · ${esc(partyOf(p))} · ${tag(...(STATE_TAG[p.state] ?? ['t-mute', p.state]))}`,
    headerHtml: canWrite
      ? `<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
          ${p.state === 'connected' ? '<button class="btn sm primary" type="button" data-sync>Send everything again</button><button class="btn sm" type="button" data-import>Refresh their network</button><button class="btn sm" type="button" data-suspend>Suspend</button>' : ''}
          ${p.state === 'suspended' ? '<button class="btn sm primary" type="button" data-resume>Resume</button>' : ''}
          ${p.state === 'pending' ? '<button class="btn sm primary" type="button" data-connect>Connect with their URL and token</button>' : ''}
          <button class="btn sm danger" type="button" data-del>Disconnect</button></div>`
      : '',
    tabs: [
      {
        id: 'messages', label: 'Messages',
        async render(body) {
          const rows = await api(`/v1/roaming/partners/${p.id}/messages`);
          body.innerHTML = `${p.last_error ? callout('warn', `Last problem: ${esc(p.last_error)}`) : ''}<div data-t></div>`;
          table($('[data-t]', body), {
            columns: [
              { label: 'When', render: (m) => `<span class="nowrap">${esc(fmt.time(m.created_at))}</span>` },
              { label: 'Call', render: (m) => `${tag(m.direction === 'in' ? 't-info' : 't-mute', m.direction === 'in' ? 'from partner' : 'to partner')} <span class="mono">${esc(m.method)}</span><div class="cell-sub mono" style="word-break:break-all">${esc(m.url)}</div>` },
              { label: 'Answer', render: (m) => `${m.http_status ? tag(m.http_status < 300 ? 't-ok' : m.http_status < 500 ? 't-warn' : 't-crit', `HTTP ${m.http_status}`) : tag('t-crit', 'no answer')}${m.error ? `<div class="cell-sub" style="color:var(--crit)">${esc(m.error)}</div>` : ''}` },
              { label: 'Time', num: true, render: (m) => (m.duration_ms != null ? `${fmt.num(m.duration_ms)} ms` : '—') },
            ],
            rows,
            empty: 'No messages yet.',
          });
        },
      },
      {
        id: 'outbox', label: 'Sent to partner',
        async render(body) {
          const rows = await api(`/v1/roaming/partners/${p.id}/pushes`);
          const failed = rows.filter((x) => x.state === 'failed').length;
          body.innerHTML = `${failed && canWrite ? `<div class="row" style="margin-bottom:10px">${callout('warn', `${failed} ${failed === 1 ? 'update was' : 'updates were'} not accepted by the partner. Fix the connection, then send again.`)}<button class="btn sm" type="button" data-replay>Send failed again</button></div>` : ''}<div data-t></div>`;
          table($('[data-t]', body), {
            columns: [
              { label: 'What', render: (x) => `<div class="cell-title">${esc(MODULE_LABEL[x.module] ?? x.module)} <span class="cell-sub">${esc(x.action.replace('_', ' '))}</span></div><div class="cell-sub mono">${esc(x.object_key)}</div>` },
              { label: 'Queued', render: (x) => `<span class="nowrap">${esc(fmt.time(x.created_at))}</span>` },
              { label: 'Result', render: (x) => `${tag(PUSH_TAG[x.state] ?? 't-mute', x.state === 'pending' ? 'queued' : x.state)}${x.last_status ? ` <span class="cell-sub">HTTP ${esc(x.last_status)}</span>` : ''}${x.last_error ? `<div class="cell-sub" style="color:${x.state === 'failed' ? 'var(--crit)' : 'inherit'}">${esc(x.last_error)}</div>` : ''}` },
              { label: 'Attempts', num: true, render: (x) => fmt.num(x.attempts) },
            ],
            rows,
            empty: 'Nothing sent yet.',
          });
          $('[data-replay]', body)?.addEventListener('click', async () => {
            const r = await attempt(() => api(`/v1/roaming/partners/${p.id}/replay`, { method: 'POST' }), { success: (x) => `${x.requeued} queued again` });
            if (r) d.refresh();
          });
        },
      },
      {
        id: 'tokens', label: 'Driver tokens',
        async render(body) {
          const rows = await api(`/v1/roaming/partners/${p.id}/tokens`);
          body.innerHTML = `<p class="cell-sub" style="margin-bottom:10px">Cards and app accounts the partner shared, so its drivers can start at your chargers. "Check with provider" tokens are approved by the partner at each start.</p><div data-t></div>`;
          table($('[data-t]', body), {
            columns: [
              { label: 'Contract', render: (t) => `<div class="cell-title mono">${esc(t.contract_id)}</div><div class="cell-sub">${esc(t.visual_number ?? t.issuer)}</div>` },
              { label: 'Type', render: (t) => esc(t.type === 'RFID' ? 'Card' : t.type === 'APP_USER' ? 'App' : t.type) },
              { label: 'Provider', render: (t) => `<span class="mono">${esc(`${t.country_code}*${t.party_id}`)}</span>` },
              { label: 'Approval', render: (t) => esc(t.whitelist === 'NEVER' ? 'check with provider' : 'pre-approved') },
              { label: 'Status', render: (t) => (t.valid ? tag('t-ok', 'valid') : tag('t-crit', 'blocked')) },
              { label: 'Updated', render: (t) => esc(fmt.ago(t.received_at)) },
            ],
            rows,
            empty: 'The partner has not shared any tokens yet.',
          });
        },
      },
      ...(p.kind === 'hub' ? [{
        id: 'hubclients', label: 'Behind this hub',
        async render(body) {
          const rows = await api(`/v1/roaming/partners/${p.id}/hub-clients`);
          body.innerHTML = `<div class="row" style="margin-bottom:10px;gap:8px;align-items:flex-start"><p class="cell-sub" style="margin:0;flex:1">The operators and service providers the hub connects you to, as the hub reports them. Once the hub has sent this list, it may only act for parties on it that are connected or offline, not for suspended or planned ones.</p>${canWrite && p.state === 'connected' ? '<button class="btn sm" type="button" data-pull>Refresh from hub</button>' : ''}</div><div data-t></div>`;
          table($('[data-t]', body), {
            columns: [
              { label: 'Party', render: (c) => `<span class="mono">${esc(`${c.country_code}*${c.party_id}`)}</span>` },
              { label: 'Role', render: (c) => esc(c.role === 'EMSP' ? 'Service provider' : c.role === 'CPO' ? 'Charge point operator' : c.role) },
              { label: 'Status', render: (c) => tag(HUB_CLIENT_TAG[c.status] ?? 't-mute', c.status.toLowerCase()) },
              { label: 'Updated', render: (c) => esc(fmt.ago(c.last_updated)) },
            ],
            rows,
            empty: 'The hub has not told PlugSure who is behind it. Until it does, it may act for any party.',
          });
          $('[data-pull]', body)?.addEventListener('click', async () => {
            const r = await attempt(() => api(`/v1/roaming/partners/${p.id}/hub-clients/refresh`, { method: 'POST' }), { success: (x) => `${x.clients} ${x.clients === 1 ? 'party' : 'parties'} behind the hub` });
            if (r) d.refresh();
          });
        },
      }] : []),
    ],
    onClose: done,
  });
  if (!canWrite) return;
  $('[data-sync]', d.el)?.addEventListener('click', async () => {
    const r = await attempt(() => api(`/v1/roaming/partners/${p.id}/sync`, { method: 'POST' }), { success: (x) => `Queued ${x.locations} ${x.locations === 1 ? 'location' : 'locations'} and ${x.tariffs} ${x.tariffs === 1 ? 'tariff' : 'tariffs'}` });
    if (r) d.refresh();
  });
  $('[data-import]', d.el)?.addEventListener('click', async () => {
    await attempt(() => api(`/v1/roaming/partners/${p.id}/import`, { method: 'POST' }), { success: (x) => `Imported ${x.locations} ${x.locations === 1 ? 'location' : 'locations'} and ${x.tariffs} ${x.tariffs === 1 ? 'tariff' : 'tariffs'}` });
  });
  $('[data-suspend]', d.el)?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: `Suspend ${esc(p.name)}?`, message: 'The partner can no longer call PlugSure and receives no updates. Its drivers cannot start new sessions. Resume at any time.', confirmLabel: 'Suspend', danger: true });
    if (ok && await attempt(() => api(`/v1/roaming/partners/${p.id}`, { method: 'PATCH', body: { state: 'suspended' } }), { success: 'Suspended' })) d.close();
  });
  $('[data-resume]', d.el)?.addEventListener('click', async () => {
    if (await attempt(() => api(`/v1/roaming/partners/${p.id}`, { method: 'PATCH', body: { state: 'connected' } }), { success: 'Resumed' })) d.close();
  });
  $('[data-connect]', d.el)?.addEventListener('click', () => connectExisting(p, () => d.close()));
  $('[data-del]', d.el)?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: `Disconnect ${esc(p.name)}?`, message: 'The partner is told, its tokens stop working, and nothing more is sent. Reconnecting needs a new registration.', confirmLabel: 'Disconnect', danger: true, requireText: 'DISCONNECT' });
    if (ok && await attempt(() => api(`/v1/roaming/partners/${p.id}`, { method: 'DELETE' }), { success: 'Disconnected' })) d.close();
  });
}

function setCity(site, done) {
  modal({
    title: `City of ${site.name}`,
    body: field('City', `<input name="city" maxlength="45" value="${esc(site.city ?? '')}" placeholder="Bekasi">`, { help: 'Partners show it to drivers. Required to share a site.' }),
    actions: [{ label: 'Cancel' }, {
      label: 'Save', kind: 'primary',
      async onClick(ctx) {
        const v = formValues(ctx.body);
        if (await attempt(() => api(`/v1/roaming/sites/${site.id}`, { method: 'PUT', body: { city: v.city } }), { success: 'City saved' })) done();
        else return false;
      },
    }],
  });
}

registerView('roaming', {
  title: 'Roaming',
  icon: 'globe',
  group: 'commercial',
  order: 28,
  perm: 'roaming:read',
  async render(root, [initial]) {
    const canWrite = state.can('roaming:write');
    const tabs = [
      { id: 'partners', label: 'Partners' },
      { id: 'sites', label: 'Shared sites' },
      { id: 'sessions', label: 'Roaming sessions' },
      { id: 'abroad', label: 'Cards abroad' },
      { id: 'network', label: 'Partner network' },
    ];
    root.innerHTML = pageHead(
      'Roaming',
      'Let drivers of other networks charge on your chargers, and your fleet cards charge on theirs (OCPI 2.2.1). Every session produces a charge record: you bill their provider for sessions here, and pay the other operator (and bill your card holder) for sessions there.',
      `<button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button>`,
    ) + `<div data-identity></div><div class="tabs" role="tablist">${tabs.map((t) => `<button role="tab" type="button" aria-selected="false" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}</div><div data-body></div>`;

    const body = $('[data-body]', root);
    let current = tabs.find((t) => t.id === initial)?.id ?? 'partners';
    let data = null;

    const drawIdentity = () => {
      const p = data.party;
      $('[data-identity]', root).innerHTML = p
        ? `<div class="card section"><header><h3>${esc(p.business_name)} <span class="mono cell-sub">${esc(`${p.country_code}*${p.party_id}`)}</span></h3>${canWrite ? '<button class="btn sm right" type="button" data-edit-identity>Edit</button>' : ''}</header>
            <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap"><span class="cell-sub">Versions URL for partners:</span> <code class="mono" style="word-break:break-all">${esc(data.versionsUrl)}</code> <button class="btn sm" type="button" data-copy-versions>${icon('copy')} Copy</button></div></div>`
        : callout('info', `Set your roaming identity first: the country code and three-character party ID partners will know you by.${canWrite ? ' <button class="btn sm primary" type="button" data-edit-identity>Set roaming identity</button>' : ''}`);
      $('[data-edit-identity]', root)?.addEventListener('click', () => editIdentity(p, refresh));
      $('[data-copy-versions]', root)?.addEventListener('click', () => copy(data.versionsUrl));
    };

    const drawPartners = () => {
      body.innerHTML = `<div class="card section"><header><h3>Partners</h3>${canWrite && data.party ? `<button class="btn sm primary right" type="button" data-add>${icon('plus')} Add partner</button>` : ''}</header><div data-t></div></div>`;
      table($('[data-t]', body), {
        columns: [
          { label: 'Partner', render: (p) => `<div class="cell-title">${esc(p.name)}</div><div class="cell-sub">${esc(KIND_LABEL[p.kind] ?? p.kind)} · <span class="mono">${esc(partyOf(p))}</span></div>` },
          { label: 'Status', render: (p) => `${tag(...(STATE_TAG[p.state] ?? ['t-mute', p.state]))}${p.last_error && p.state === 'connected' ? `<div class="cell-sub">${esc(p.last_error)}</div>` : ''}` },
          { label: 'Last success', render: (p) => esc(p.last_success_at ? fmt.ago(p.last_success_at) : 'never') },
          { label: 'Sessions here', num: true, render: (p) => fmt.num(p.sessions) },
          { label: 'Their chargers', num: true, render: (p) => (p.network_locations ? `${fmt.num(p.network_locations)} sites` : '—') },
          { label: 'Charges received', num: true, render: (p) => fmt.num(p.cdrs_received) },
          { label: 'Tokens', num: true, render: (p) => fmt.num(p.tokens) },
          { label: 'Queued', num: true, render: (p) => fmt.num(p.queued) },
          { label: 'Failed', num: true, render: (p) => (p.failed ? `<b style="color:var(--crit)">${fmt.num(p.failed)}</b>` : '0') },
        ],
        rows: data.partners,
        empty: data.party ? 'No partners yet. Add a service provider or a roaming hub.' : 'Set your roaming identity to add partners.',
        onRow: (p) => openPartner(p, canWrite, refresh),
      });
      $('[data-add]', body)?.addEventListener('click', () => addPartner(refresh));
    };

    const drawSites = () => {
      const shared = data.sites.filter((s) => s.publish).length;
      body.innerHTML = `<p class="cell-sub" style="margin:4px 0 10px">${shared} of ${data.sites.length} sites shared. A shared site's chargers, plugs, live availability and tariffs are sent to every connected partner; changes go out within a minute. Private sites cannot be shared.</p><div class="card" data-t></div>`;
      table($('[data-t]', body), {
        columns: [
          { label: 'Site', render: (s) => `<div class="cell-title">${esc(s.name)}</div><div class="cell-sub">${esc(s.city || 'no city')}</div>` },
          { label: 'EVSEs', num: true, render: (s) => fmt.num(s.evses) },
          { label: 'Tariffs', num: true, render: (s) => fmt.num(s.tariffs) },
          { label: 'Status', render: (s) => (s.publish ? tag('t-ok', 'shared') : s.problem ? `${tag('t-mute', 'cannot share')}<div class="cell-sub">${esc(s.problem)}</div>` : tag('t-mute', 'not shared')) },
          { label: '', render: (s) => (!canWrite || !data.party ? ''
            : s.publish ? `<button class="btn sm" type="button" data-unshare="${esc(s.id)}">Stop sharing</button>`
            : /city/.test(s.problem ?? '') ? `<button class="btn sm" type="button" data-city="${esc(s.id)}">Set city</button>`
            : s.problem ? '' : `<button class="btn sm primary" type="button" data-share="${esc(s.id)}">Share</button>`) },
        ],
        rows: data.sites,
        empty: 'No sites yet.',
      });
      $$('[data-share]', body).forEach((b) => b.addEventListener('click', async () => {
        if (await attempt(() => api(`/v1/roaming/sites/${b.dataset.share}`, { method: 'PUT', body: { publish: true } }), { success: 'Shared with partners' })) refresh();
      }));
      $$('[data-unshare]', body).forEach((b) => b.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Stop sharing this site?', message: "Partners are told to hide it; their drivers can no longer find or start at its chargers. Sessions already running finish normally.", confirmLabel: 'Stop sharing' });
        if (ok && await attempt(() => api(`/v1/roaming/sites/${b.dataset.unshare}`, { method: 'PUT', body: { publish: false } }), { success: 'No longer shared' })) refresh();
      }));
      $$('[data-city]', body).forEach((b) => b.addEventListener('click', () => setCity(data.sites.find((s) => s.id === b.dataset.city), refresh)));
    };

    const drawSessions = async () => {
      body.innerHTML = '<div data-limits></div><div class="card" data-t></div>';
      const [rows, limits] = await Promise.all([api('/v1/roaming/sessions'), api('/v1/roaming/charging-profiles')]);
      if (limits.length) {
        const box = $('[data-limits]', body);
        box.className = 'card section';
        box.innerHTML = `<header><h3>Charging limits from partners</h3></header><p class="cell-sub" style="margin:0 0 10px">A partner can slow its driver's session down (OCPI smart charging). Load management applies the limit on top of the site's power budget: a partner can never make a session draw more than the site allows.</p><div data-lt></div>`;
        table($('[data-lt]', box), {
          columns: [
            { label: 'Session', render: (l) => `<div class="cell-title">${esc(l.partner_name)}</div><div class="cell-sub mono">${esc(l.contract_id ?? l.session_id)}</div>` },
            { label: 'Where', render: (l) => `${esc(l.site_name)}<div class="cell-sub mono">${esc(l.ocpp_identity)}</div>` },
            { label: 'Limit now', num: true, render: (l) => (l.limitNowW == null ? '<span class="cell-sub">none in force</span>' : `${fmt.num(Math.round(l.limitNowW / 100) / 10)} kW${l.unit === 'A' ? `<div class="cell-sub">${fmt.num(l.limitNow)} A</div>` : ''}`) },
            { label: 'Schedule', render: (l) => esc(l.periods === 1 ? 'one step' : `${l.periods} steps`) },
            { label: 'Charger', render: (l) => (l.last_result === 'ACCEPTED' ? tag('t-ok', 'applied') : l.last_result === 'REJECTED' ? tag('t-warn', 'not applied yet') : tag('t-info', 'applying')) },
            { label: 'Received', render: (l) => esc(fmt.ago(l.received_at)) },
          ],
          rows: limits,
          empty: '',
        });
      }
      table($('[data-t]', body), {
        columns: [
          { label: 'Started', render: (s) => `<span class="nowrap">${esc(fmt.time(s.started_at))}</span>` },
          { label: 'Partner', render: (s) => `<div class="cell-title">${esc(s.partner_name)}</div><div class="cell-sub mono">${esc(s.contract_id)}</div>` },
          { label: 'Where', render: (s) => `${esc(s.site_name)}<div class="cell-sub mono">${esc(s.ocpp_identity)}</div>` },
          { label: 'Started by', render: (s) => esc(AUTH_LABEL[s.ocpi_auth_method] ?? '—') },
          { label: 'Energy', num: true, render: (s) => fmt.kwh(s.energy_wh) },
          { label: 'Total', num: true, render: (s) => fmt.idr(s.total_idr) },
          { label: 'Charge record', render: (s) => (s.state === 'active' ? tag('t-info', 'charging')
            : s.cdr_push_state === 'delivered' ? tag('t-ok', 'sent')
            : s.cdr_push_state === 'failed' ? tag('t-crit', 'not accepted')
            : s.cdr_push_state === 'pending' ? tag('t-info', 'queued')
            : s.total_idr == null ? tag('t-warn', 'not billed yet') : tag('t-mute', '—')) },
        ],
        rows,
        empty: 'No roaming sessions yet.',
      });
    };

    // ── eMSP role: your cards on other networks
    const drawAbroad = async () => {
      body.innerHTML = `<div class="card section"><header><h3>Cards that can roam</h3>${canWrite && data.party ? `<button class="btn sm right" type="button" data-share-all>Share all active cards</button>` : ''}</header>
          <p class="cell-sub" style="margin:0 0 10px">Shared cards are sent to every connected operator (CPO) and work at its chargers; a blocked or unshared card stops working there within a minute. Cards with an energy or spending limit are checked with PlugSure before every session, and roaming charges count towards the limit.</p>
          <div data-cards></div></div>
        <div class="card section"><header><h3>Charges from other networks</h3><button class="btn sm right" type="button" data-csv>${icon('download')} Export CSV</button></header><div data-active></div><div data-cdrs></div></div>`;
      const [cards, abroad] = await Promise.all([api('/v1/roaming/cards'), api('/v1/roaming/abroad')]);
      table($('[data-cards]', body), {
        columns: [
          { label: 'Card', render: (c) => `<div class="cell-title mono">${esc(c.uid)}</div><div class="cell-sub">${esc(c.holder_name ?? '—')}${c.fleet_name ? ` · ${esc(c.fleet_name)}` : ''}</div>` },
          { label: 'Contract id', render: (c) => (c.contract_id ? `<span class="mono">${esc(c.contract_id)}</span>` : '—') },
          { label: 'Status', render: (c) => (c.status !== 'Accepted' ? tag('t-crit', c.status.toLowerCase()) : c.roaming_shared ? tag('t-ok', 'roaming') : tag('t-mute', 'home only')) },
          { label: 'Limit', render: (c) => esc(c.spend_limit_idr != null ? fmt.idr(c.spend_limit_idr) : c.energy_limit_wh != null ? fmt.kwh(c.energy_limit_wh, 0) : '—') },
          { label: 'Roaming charges', num: true, render: (c) => (c.roaming_cdrs ? `${fmt.idr(c.roaming_idr)}<div class="cell-sub">${fmt.num(c.roaming_cdrs)} ${c.roaming_cdrs === 1 ? 'session' : 'sessions'}</div>` : '—') },
          { label: '', render: (c) => (!canWrite || !data.party ? '' : c.roaming_shared
            ? `<button class="btn sm" type="button" data-unshare-card="${esc(c.id)}">Stop roaming</button>`
            : c.status === 'Accepted' ? `<button class="btn sm primary" type="button" data-share-card="${esc(c.id)}">Allow roaming</button>` : '') },
        ],
        rows: cards,
        empty: 'No RFID cards yet. Issue cards in the RFID centre first.',
      });
      const setShare = async (ids, shared, msg) => {
        if (await attempt(() => api('/v1/roaming/cards', { method: 'PUT', body: ids === 'all' ? { all: true, shared } : { ids, shared } }), { success: msg })) drawAbroad();
      };
      $$('[data-share-card]', body).forEach((b) => b.addEventListener('click', () => setShare([b.dataset.shareCard], true, 'Card can roam')));
      $$('[data-unshare-card]', body).forEach((b) => b.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Stop roaming for this card?', message: 'Operators are told the card is no longer valid; it keeps working at your own chargers.', confirmLabel: 'Stop roaming' });
        if (ok) setShare([b.dataset.unshareCard], false, 'Card no longer roams');
      }));
      $('[data-share-all]', body)?.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Share all active cards?', message: 'Every active RFID card becomes usable on the networks of your connected operators. Charges there are billed to you.', confirmLabel: 'Share all' });
        if (ok) setShare('all', true, (r) => `${r.changed} ${r.changed === 1 ? 'card' : 'cards'} can now roam`);
      });
      $('[data-active]', body).innerHTML = abroad.active.length ? `<h4 style="margin:4px 0 8px">Charging now</h4><div data-active-t></div>` : '';
      if (abroad.active.length) {
        table($('[data-active-t]', body), {
          columns: [
            { label: 'Started', render: (s) => `<span class="nowrap">${esc(fmt.time(s.started_at))}</span>` },
            { label: 'Where', render: (s) => `${esc(s.location_name ?? s.location_id)}<div class="cell-sub">${esc(s.city ?? '')} · ${esc(s.partner_name)}</div>` },
            { label: 'Card', render: (s) => `<span class="mono">${esc(s.uid ?? '—')}</span><div class="cell-sub">${esc(s.holder_name ?? '')}</div>` },
            { label: 'Energy', num: true, render: (s) => (s.kwh != null ? `${fmt.num(s.kwh, 2)} kWh` : '—') },
            { label: '', render: (s) => (canWrite ? `<button class="btn sm" type="button" data-stop-remote="${esc(s.session_id)}" data-partner="${esc(s.partner_id)}">Stop</button>` : '') },
          ],
          rows: abroad.active,
        });
        $$('[data-stop-remote]', body).forEach((b) => b.addEventListener('click', async () => {
          const r = await attempt(() => api('/v1/roaming/commands', { method: 'POST', body: { command: 'STOP_SESSION', partnerId: b.dataset.partner, sessionId: b.dataset.stopRemote } }));
          if (r) toast(r.response === 'ACCEPTED' ? 'Stop sent to the operator' : `The operator answered ${r.response}${r.message ? `: ${r.message}` : ''}`, r.response === 'ACCEPTED' ? 'ok' : 'warn');
        }));
      }
      table($('[data-cdrs]', body), {
        columns: [
          { label: 'Ended', render: (c) => `<span class="nowrap">${esc(fmt.time(c.end_date_time))}</span>` },
          { label: 'Where', render: (c) => `${esc(c.location_name ?? '—')}<div class="cell-sub">${esc(c.city ?? '')} · ${esc(c.partner_name)} <span class="mono">${esc(`${c.country_code}*${c.party_id}`)}</span></div>` },
          { label: 'Card', render: (c) => `<span class="mono">${esc(c.uid ?? '—')}</span><div class="cell-sub">${esc(c.holder_name ?? '')}${c.fleet_name ? ` · ${esc(c.fleet_name)}` : ''}</div>` },
          { label: 'Energy', num: true, render: (c) => `${fmt.num(c.total_energy, 2)} kWh` },
          { label: 'Excl. VAT', num: true, render: (c) => (c.currency === 'IDR' ? fmt.idr(c.total_excl_vat) : `${esc(c.currency)} ${fmt.num(c.total_excl_vat, 2)}`) },
          { label: 'Total', num: true, render: (c) => (c.total_incl_vat == null ? '—' : c.currency === 'IDR' ? fmt.idr(c.total_incl_vat) : `${esc(c.currency)} ${fmt.num(c.total_incl_vat, 2)}`) },
        ],
        rows: abroad.cdrs,
        empty: 'No charges from other networks yet.',
      });
      $('[data-csv]', body).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('busy');
        try {
          const res = await api('/v1/roaming/abroad.csv', { raw: true });
          download(`plugsure-roaming-charges-${new Date().toISOString().slice(0, 10)}.csv`, await res.blob());
        } catch (err) { if (err.status !== 401) toast(err.message, 'crit'); } finally { btn.classList.remove('busy'); }
      });
    };

    const startAbroad = (loc, evse) => {
      const cards = data._cards ?? [];
      modal({
        title: `Start a charge at ${loc.name}`,
        subtitle: `${loc.partnerName} · EVSE ${evse.evseId}`,
        body: `<div class="form one">${field('Card', `<select name="tokenId">${options(cards.filter((c) => c.roaming_shared && c.status === 'Accepted').map((c) => ({ value: c.id, label: `${c.uid}${c.holder_name ? ` · ${c.holder_name}` : ''}` })))}</select>`, { help: 'For a driver who cannot start at the charger (a card that will not read, a support call). The operator starts the charger and reports back.' })}
          ${evse.connectors.length > 1 ? field('Connector', `<select name="connectorId">${options(evse.connectors.map((c) => ({ value: c.id, label: `${c.id} · ${c.standard ?? ''}` })))}</select>`) : ''}</div>`,
        actions: [{ label: 'Cancel' }, {
          label: 'Start charge', kind: 'primary',
          async onClick(ctx) {
            const v = formValues(ctx.body);
            if (!v.tokenId) { toast('Share a card for roaming first (Cards abroad)', 'warn'); return false; }
            const r = await attempt(() => api('/v1/roaming/commands', { method: 'POST', body: {
              command: 'START_SESSION', partnerId: loc.partnerId, tokenId: v.tokenId, locationId: loc.id, evseUid: evse.uid,
              connectorId: v.connectorId ?? evse.connectors[0]?.id, countryCode: loc.countryCode, partyId: loc.partyId,
            } }));
            if (!r) return false;
            toast(r.response === 'ACCEPTED' ? 'Sent to the operator; the result appears under Recent commands' : `The operator answered ${r.response}${r.message ? `: ${r.message}` : ''}`, r.response === 'ACCEPTED' ? 'ok' : 'warn');
            setTimeout(drawNetwork, 1500);
          },
        }],
      });
    };

    const drawNetwork = async () => {
      body.innerHTML = `<p class="cell-sub" style="margin:4px 0 10px">Chargers of connected operators where your shared cards can charge. Operators send changes as they happen; the full list is refreshed every six hours.</p>
        <div class="card section" data-net></div>
        <div class="card section"><header><h3>Recent commands</h3></header><div data-cmds></div></div>`;
      const [net, cmds, cards] = await Promise.all([api('/v1/roaming/network'), api('/v1/roaming/commands'), api('/v1/roaming/cards')]);
      data._cards = cards;
      table($('[data-net]', body), {
        columns: [
          { label: 'Location', render: (l) => `<div class="cell-title">${esc(l.name ?? l.id)}</div><div class="cell-sub">${esc([l.address, l.city].filter(Boolean).join(', '))}</div>` },
          { label: 'Operator', render: (l) => `${esc(l.operator ?? l.partnerName)}<div class="cell-sub mono">${esc(l.party)}</div>` },
          { label: 'Chargers', render: (l) => l.evses.map((e) => `<div class="row" style="gap:6px;align-items:center;margin:2px 0">${tag(EVSE_TAG[e.status] ?? 't-mute', (e.status ?? 'unknown').toLowerCase())} <span class="mono cell-sub">${esc(e.evseId)}</span>${e.connectors[0]?.maxPowerW ? ` <span class="cell-sub">${esc(fmt.kw(e.connectors[0].maxPowerW, 0))}</span>` : ''}${canWrite && e.status === 'AVAILABLE' ? ` <button class="btn sm" type="button" data-start="${esc(l.partnerId)}|${esc(l.id)}|${esc(e.uid)}">Start</button>` : ''}</div>`).join('') },
          { label: 'Updated', render: (l) => esc(fmt.ago(l.lastUpdated)) },
        ],
        rows: net,
        empty: 'No operator has shared its network yet. Connect a charge point operator under Partners.',
      });
      $$('[data-start]', body).forEach((b) => b.addEventListener('click', () => {
        const [pid, lid, uid] = b.dataset.start.split('|');
        const loc = net.find((l) => l.partnerId === pid && l.id === lid);
        startAbroad(loc, loc.evses.find((e) => e.uid === uid));
      }));
      const RES_TAG = { ACCEPTED: 't-ok', REJECTED: 't-crit', FAILED: 't-crit', TIMEOUT: 't-warn', EVSE_OCCUPIED: 't-warn', EVSE_INOPERATIVE: 't-warn', NOT_SUPPORTED: 't-mute', UNKNOWN_SESSION: 't-warn' };
      table($('[data-cmds]', body), {
        columns: [
          { label: 'When', render: (c) => `<span class="nowrap">${esc(fmt.time(c.created_at))}</span>` },
          { label: 'Command', render: (c) => `${esc(c.command.replace('_', ' ').toLowerCase())}<div class="cell-sub">${esc(c.partner_name)}${c.uid ? ` · <span class="mono">${esc(c.uid)}</span>` : ''}</div>` },
          { label: 'Operator answer', render: (c) => (c.response ? tag(RES_TAG[c.response] ?? 't-mute', c.response.toLowerCase()) : '—') },
          { label: 'Charger result', render: (c) => `${c.result ? tag(RES_TAG[c.result] ?? 't-mute', c.result.toLowerCase().replace('_', ' ')) : c.response === 'ACCEPTED' ? tag('t-info', 'waiting') : '—'}${c.message ? `<div class="cell-sub">${esc(c.message)}</div>` : ''}` },
        ],
        rows: cmds,
        empty: 'No commands sent yet.',
      });
    };

    const show = async (id) => {
      current = id;
      $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
      history.replaceState(null, '', `#/roaming/${id}`);
      if (!data) {
        try { data = await api('/v1/roaming'); } catch (e) {
          body.innerHTML = callout('crit', esc(e.status === 403 ? 'You do not have permission to view roaming.' : e.message));
          return;
        }
        drawIdentity();
      }
      if (id === 'partners') drawPartners();
      else if (id === 'sites') drawSites();
      else if (id === 'sessions') await drawSessions();
      else if (id === 'abroad') await drawAbroad();
      else await drawNetwork();
    };
    const refresh = async () => { data = null; await show(current); };

    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    $('[data-refresh]', root).addEventListener('click', refresh);
    await show(current);
  },
});
