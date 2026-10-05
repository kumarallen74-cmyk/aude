import {
  $, $$, esc, api, attempt, state, registerView, pageHead, table, tag, icon, fmt, field, options, callout, modal, confirmDialog, toast, copy, drawer, formValues, download,
  COUNTRIES, toMinor, toMajor, multiCountryUi, isRupiah, countryCurrency,
} from '../core.js';
import { drawClearingMember } from './hub-clearing.js';

/** A partner's amount in major units (OCPI) in its currency; a currency PlugSure does not know is shown as sent. */
const knownCurrency = (cur) => Object.values(COUNTRIES).some((c) => c.currency === cur);
const majorMoney = (x, cur) => (x == null ? '—' : knownCurrency(cur) ? fmt.money(toMinor(x, cur), cur) : `${esc(cur)} ${fmt.num(x, 2)}`);

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

/**
 * A roaming identity for one more country (v1.7.0): one OCPI party per (organisation, country). A site is
 * shared only under its own country's party, so without one a Malaysian or Singapore site stays unshared
 * ("no OCPI party for MY"). The console showed only the home party, so these could be set only by API.
 */
function editCountryParty(cc, party, done) {
  const name = COUNTRIES[cc]?.name ?? cc;
  modal({
    title: `Roaming identity — ${name}`,
    subtitle: `Your sites in ${name} are shared with partners under this party. Partners cannot follow a change of party ID, so choose it once.`,
    body: `<div class="form">
      ${field('Country', `<input value="${esc(`${name} (${cc})`)}" disabled>`)}
      ${field('Party ID', `<input name="partyId" maxlength="3" placeholder="PLS" autocomplete="off">`, { help: `Three letters or digits. Shown in every EVSE id of your ${esc(name)} sites (${esc(cc)}*PLS*E…).` })}
      ${field('Business name', '<input name="businessName" placeholder="Your company in this country">', { full: true })}
      ${field('Website', '<input name="website" placeholder="https://…">', { full: true, opt: true })}
    </div>`,
    actions: [
      ...(party ? [{ label: 'Remove', kind: 'danger', async onClick() {
        const ok = await confirmDialog({ title: `Remove the ${name} identity?`, message: `Your ${name} sites stop being shared with partners.`, confirmLabel: 'Remove', danger: true });
        if (!ok) return false;
        if (await attempt(() => api(`/v1/roaming/parties/${cc}`, { method: 'DELETE' }), { success: 'Roaming identity removed' })) done();
        else return false;
      } }] : []),
      { label: 'Cancel' },
      { label: 'Save', kind: 'primary', async onClick(ctx) {
        const v = formValues(ctx.body);
        if (await attempt(() => api(`/v1/roaming/parties/${cc}`, { method: 'PUT', body: v }), { success: `Roaming identity for ${name} saved` })) done();
        else return false;
      } },
    ],
    onMount(ctx) {
      // Values are set as properties, never interpolated into markup.
      $('[name="partyId"]', ctx.body).value = party?.party_id ?? '';
      $('[name="businessName"]', ctx.body).value = party?.business_name ?? '';
      $('[name="website"]', ctx.body).value = party?.website ?? '';
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
    const ok = await confirmDialog({ title: `Suspend ${p.name}?`, message: 'The partner can no longer call PlugSure and receives no updates. Its drivers cannot start new sessions. Resume at any time.', confirmLabel: 'Suspend', danger: true });
    if (ok && await attempt(() => api(`/v1/roaming/partners/${p.id}`, { method: 'PATCH', body: { state: 'suspended' } }), { success: 'Suspended' })) d.close();
  });
  $('[data-resume]', d.el)?.addEventListener('click', async () => {
    if (await attempt(() => api(`/v1/roaming/partners/${p.id}`, { method: 'PATCH', body: { state: 'connected' } }), { success: 'Resumed' })) d.close();
  });
  $('[data-connect]', d.el)?.addEventListener('click', () => connectExisting(p, () => d.close()));
  $('[data-del]', d.el)?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: `Disconnect ${p.name}?`, message: 'The partner is told, its tokens stop working, and nothing more is sent. Reconnecting needs a new registration.', confirmLabel: 'Disconnect', danger: true, requireText: 'DISCONNECT' });
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
  // Shown to external hub members too (a hub-only organisation sees its PlugSure Hub tab only).
  hubOnly: true,
  async render(root, [initial]) {
    const canWrite = state.can('roaming:write');
    // A hub-only organisation (an external hub member's console) has no CSMS: only its PlugSure Hub tab.
    const hubOnly = state.me?.org?.hubOnly === true;
    const hubTab = { id: 'hub', label: 'PlugSure Hub' };
    const tabs = hubOnly ? [hubTab] : [
      { id: 'partners', label: 'Partners' },
      { id: 'sites', label: 'Shared sites' },
      { id: 'sessions', label: 'Roaming sessions' },
      { id: 'abroad', label: 'Cards abroad' },
      { id: 'network', label: 'Partner network' },
      ...(state.me?.features?.hub ? [hubTab] : []),
    ];
    root.innerHTML = pageHead(
      hubOnly ? 'PlugSure Hub' : 'Roaming',
      hubOnly
        ? 'Your membership of PlugSure Hub: the CDRs routed through it, disputes, settlement statements, PlugSure\'s fee invoices and payments between members.'
        : 'Let drivers of other networks charge on your chargers, and your fleet cards charge on theirs (OCPI 2.2.1). Every session produces a charge record: you bill their provider for sessions here, and pay the other operator (and bill your card holder) for sessions there.',
      `<button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button>`,
    ) + `<div data-identity></div><div class="tabs" role="tablist">${tabs.map((t) => `<button role="tab" type="button" aria-selected="false" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}</div><div data-body></div>`;

    const body = $('[data-body]', root);
    let current = tabs.find((t) => t.id === initial)?.id ?? tabs[0].id;
    let data = null;

    const drawIdentity = () => {
      const p = data.party;
      // The other countries the organisation operates in, each with its own party (or none yet).
      const others = (state.me?.org?.countries ?? []).map((c) => c.country_code).filter((cc) => p && cc !== p.country_code);
      const partyOfCc = (cc) => (data.parties ?? []).find((x) => x.country_code === cc && !x.is_home) ?? null;
      const otherRows = others.map((cc) => {
        const q = partyOfCc(cc);
        return `<div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px"><span class="cell-sub" style="min-width:90px">${esc(COUNTRIES[cc]?.name ?? cc)}</span>
          ${q ? `<b>${esc(q.business_name)}</b> <span class="mono cell-sub">${esc(`${cc}*${q.party_id}`)}</span>` : `${tag('t-warn', 'no identity')} <span class="cell-sub">sites here are not shared</span>`}
          ${canWrite ? `<button class="btn sm" type="button" data-edit-party="${esc(cc)}">${q ? 'Edit' : 'Set identity'}</button>` : ''}</div>`;
      }).join('');
      $('[data-identity]', root).innerHTML = p
        ? `<div class="card section"><header><h3>${esc(p.business_name)} <span class="mono cell-sub">${esc(`${p.country_code}*${p.party_id}`)}</span></h3>${canWrite ? '<button class="btn sm right" type="button" data-edit-identity>Edit</button>' : ''}</header>
            <div class="body"><div class="row" style="gap:8px;align-items:center;flex-wrap:wrap"><span class="cell-sub">Versions URL for partners:</span> <code class="mono" style="word-break:break-all">${esc(data.versionsUrl)}</code> <button class="btn sm" type="button" data-copy-versions>${icon('copy')} Copy</button></div>
            ${others.length ? `<div style="margin-top:10px;padding-top:6px;border-top:1px solid var(--line)"><div class="lbl small" style="font-weight:600">Identity in other countries</div>${otherRows}</div>` : ''}</div></div>`
        : callout('info', `Set your roaming identity first: the country code and three-character party ID partners will know you by.${canWrite ? ' <button class="btn sm primary" type="button" data-edit-identity>Set roaming identity</button>' : ''}`);
      $('[data-edit-identity]', root)?.addEventListener('click', () => editIdentity(p, refresh));
      $$('[data-edit-party]', root).forEach((b) => b.addEventListener('click', () => editCountryParty(b.dataset.editParty, partyOfCc(b.dataset.editParty), refresh)));
      $('[data-copy-versions]', root)?.addEventListener('click', () => copy(data.versionsUrl));
    };

    const drawPartners = () => {
      body.innerHTML = `<div class="card section" data-hub hidden></div><div class="card section"><header><h3>Partners</h3>${canWrite && data.party ? `<button class="btn sm primary right" type="button" data-add>${icon('plus')} Add partner</button>` : ''}</header><div data-t></div></div>`;
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
      void drawHubCard($('[data-hub]', body));
    };

    // ── the PlugSure Hub tab: membership card, then clearing and settlement once a member (hub-clearing.js)
    const drawHubTab = async () => {
      body.innerHTML = '<div class="card section" data-hub hidden></div><div class="section" data-clearing></div>';
      await drawHubCard($('[data-hub]', body));
      let h = null;
      if (state.me?.features?.hub === true) { try { h = await api('/v1/roaming/hub'); } catch { /* the hub is off */ } }
      const box = $('[data-clearing]', body);
      if (!box?.isConnected) return;
      if (!h) { box.innerHTML = callout('info', 'PlugSure Hub is not enabled on this platform.'); return; }
      if (!h.member) { box.innerHTML = ''; return; }
      box.innerHTML = '<h2 style="font-size:15px;margin:0 0 10px">Clearing and settlement</h2><div data-cl></div>';
      await drawClearingMember($('[data-cl]', box), { canWrite });
    };

    // ── PlugSure Hub (v1.8): membership, the parties announced, agreements. Only when the platform runs the hub.
    const drawHubCard = async (box) => {
      // HUB_ENABLED off (the default): no card and no request (v1.7's Partners tab made no such call; a 404 per
      // visit is a failed request in the browser console).
      if (state.me?.features?.hub !== true) return;
      let h;
      try { h = await api('/v1/roaming/hub'); } catch { return; } // 404: the hub is off on this platform
      if (!box.isConnected) return;
      box.hidden = false;
      const m = h.member;
      const intro = 'Connect once to PlugSure Hub and roam with every operator and service provider on it that you have a roaming agreement with, in Indonesia, Malaysia and Singapore. Your roaming identities become hub parties: nothing to set up, no tokens to exchange.';
      if (!m) {
        const canJoin = canWrite && h.selfJoin && data.party;
        box.innerHTML = `<header><h3>${icon('link')} PlugSure Hub</h3>${tag('t-mute', 'not a member')}</header>
          <div class="body"><p class="cell-sub" style="margin:0 0 10px">${esc(intro)}</p>
            ${!data.party ? callout('info', 'Set your roaming identity first: the hub announces it to its members.')
              : canJoin ? '<button class="btn primary" type="button" data-hub-join>Join PlugSure Hub</button>'
              : `<p class="small" style="margin:0">${h.selfJoin ? 'Ask an administrator with roaming rights to join.' : 'Joining is arranged by PlugSure: contact your PlugSure account manager.'}</p>`}
          </div>`;
        $('[data-hub-join]', box)?.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: 'Join PlugSure Hub?',
            message: 'Your roaming identities are announced to the hub as a CPO (and, for your home identity, a service provider). A "PlugSure Hub" partner appears in your partner list. Nothing is exchanged with other members until PlugSure activates your membership and you have roaming agreements.',
            confirmLabel: 'Join',
          });
          if (ok && await attempt(() => api('/v1/roaming/hub/join', { method: 'POST' }), { success: 'Joined PlugSure Hub' })) refresh();
        });
        return;
      }
      const STATUS = { onboarding: ['t-info', 'onboarding'], active: ['t-ok', 'active'], suspended: ['t-warn', 'suspended'], terminated: ['t-mute', 'terminated'] };
      const note = {
        onboarding: 'Waiting for activation by PlugSure (signed hub agreement). Until then your parties are not visible to other members.',
        active: 'Your parties are visible to the members you have an active agreement with.',
        suspended: 'Suspended by PlugSure: nothing is routed to or from your parties.',
        terminated: 'Your hub membership has ended.',
      }[m.status] ?? '';
      const ROLE = { CPO: 'CPO', EMSP: 'eMSP', NSP: 'NSP', SCSP: 'SCSP', OTHER: 'Other' };
      box.innerHTML = `<header><h3>${icon('link')} PlugSure Hub</h3>${tag(...(STATUS[m.status] ?? ['t-mute', m.status]))}${m.open_roaming ? ` ${tag('t-info', 'open roaming', '', true)}` : ''}</header>
        <div class="body">
          <p class="cell-sub" style="margin:0 0 10px">${esc(note)}</p>
          <div class="row" style="gap:6px;flex-wrap:wrap"><span class="cell-sub">Your parties on the hub:</span>${(h.parties ?? []).map((p) => tag(HUB_CLIENT_TAG[p.status] ?? 't-mute', `${p.country_code}*${p.party_id} ${ROLE[p.role] ?? p.role}`, p.status.toLowerCase())).join(' ') || '<span class="cell-sub">none</span>'}</div>
          <h4 style="margin:14px 0 6px;font-size:13px">Roaming agreements</h4>
          <div data-hub-ag></div>
        </div>`;
      const flag = (on, label) => tag(on ? 't-ok' : 't-mute', label, '', true);
      table($('[data-hub-ag]', box), {
        columns: [
          { label: 'With', render: (a) => `<div class="cell-title" style="min-width:9rem">${esc(a.counterparty)}</div><div class="cell-sub mono">${esc(a.we_are_cpo ? a.emsp : a.cpo)}</div>` },
          { label: 'Your party', render: (a) => `<span class="mono">${esc(a.we_are_cpo ? a.cpo : a.emsp)}</span><div class="cell-sub">${a.we_are_cpo ? 'their drivers at your chargers' : 'your drivers at their chargers'}</div>` },
          { label: 'Status', render: (a) => tag(a.status === 'active' ? 't-ok' : a.status === 'proposed' ? 't-info' : 't-warn', a.status) },
          { label: 'Allows', render: (a) => `<div class="chips">${flag(a.allow_realtime_auth, 'real-time auth')}${flag(a.allow_commands, 'commands')}${flag(a.allow_charging_profiles, 'charging profiles')}</div>` },
          { label: 'Since', render: (a) => `<span class="nowrap">${esc(fmt.date(a.valid_from ?? a.created_at))}</span>` },
        ],
        rows: h.agreements ?? [],
        empty: 'No agreements yet. PlugSure sets them up with the operators and providers you want to roam with.',
      });
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
        box.innerHTML = `<header><h3>Charging limits from partners</h3></header><p class="cell-sub" style="margin:0;padding:10px 16px">A partner can slow its driver's session down (OCPI smart charging). Load management applies the limit on top of the site's power budget: a partner can never make a session draw more than the site allows.</p><div data-lt></div>`;
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
          { label: 'Total', num: true, render: (s) => fmt.money(s.total_minor, s.currency) },
          { label: 'Charge record', render: (s) => (s.state === 'active' ? tag('t-info', 'charging')
            : s.cdr_push_state === 'delivered' ? tag('t-ok', 'sent')
            : s.cdr_push_state === 'failed' ? tag('t-crit', 'not accepted')
            : s.cdr_push_state === 'pending' ? tag('t-info', 'queued')
            : s.total_minor == null ? tag('t-warn', 'not billed yet') : tag('t-mute', '—')) },
        ],
        rows,
        empty: 'No roaming sessions yet.',
      });
    };

    // ── eMSP role: driver-app drivers on partner networks, guaranteed by a card hold in the partner's currency
    const drawAppRoaming = async (box) => {
      let st;
      try { st = await api('/v1/roaming/settings'); } catch { box.hidden = true; return; }
      const ro = canWrite ? '' : ' disabled';
      // Holds in the currencies that apply: an Indonesia-only operator sets its rupiah hold (MYR / SGD only with
      // multi-country, or one already customised). The server keeps the others' defaults either way.
      const orgCurs = new Set([countryCurrency(state.me?.org?.homeCountry ?? 'ID'), ...(state.me?.org?.countries ?? []).map((c) => c.currency)]);
      const holds = st.holds.filter((h) => multiCountryUi() || orgCurs.has(h.currency) || h.custom);
      box.innerHTML = `<header><h3>Driver app on partner networks</h3></header>
        <form class="pad" novalidate style="padding:10px 16px">
          <p class="cell-sub" style="margin:0 0 10px">Signed-in app drivers can start charges at partner operators' chargers. Before the start, a hold is placed on the driver's card in the partner's currency; the partner's charge record is then taken from it (up to the hold) and the rest released.</p>
          <label class="check"><input type="checkbox" name="appDrivers"${st.appDrivers ? ' checked' : ''}${ro}> <span>Let app drivers charge on partner networks</span></label>
          <div class="form" style="margin-top:10px">${holds.map((h) => field(`Hold in ${h.currency}`, `<div class="inputgroup"><input name="hold_${esc(h.currency)}" inputmode="${isRupiah(h.currency) ? 'numeric' : 'decimal'}" value="${h.custom ? esc(toMajor(h.holdMinor, h.currency)) : ''}" placeholder="${esc(toMajor(h.defaultMinor, h.currency))}"${ro}><span class="suffix">${esc(fmt.sym(h.currency))}</span></div>`, { opt: true, help: `Empty: ${fmt.money(h.defaultMinor, h.currency)}. A charge costing more than the hold is a shortfall you collect from the driver.` })).join('')}</div>
          ${canWrite ? '<div class="row" style="margin-top:10px"><button class="btn primary" type="submit">Save</button></div>' : ''}
        </form>`;
      $('form', box).addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = formValues(e.currentTarget);
        const holdMinor = {};
        for (const h of holds) {
          const raw = String(v[`hold_${h.currency}`] ?? '').trim();
          if (!raw) continue;
          const m = toMinor(raw, h.currency);
          if (!Number.isFinite(m) || m <= 0) { toast(`The ${h.currency} hold is not an amount`, 'warn'); return; }
          holdMinor[h.currency] = m;
        }
        if (await attempt(() => api('/v1/roaming/settings', { method: 'PUT', body: { appDrivers: $('[name=appDrivers]', box).checked, holdMinor } }), { success: 'Saved' })) drawAppRoaming(box);
      });
    };

    // ── eMSP role: your cards on other networks
    const drawAbroad = async () => {
      body.innerHTML = `<div class="card section"><header><h3>Cards that can roam</h3>${canWrite && data.party ? `<button class="btn sm right" type="button" data-share-all>Share all active cards</button>` : ''}</header>
          <p class="cell-sub" style="margin:0;padding:10px 16px">Shared cards are sent to every connected operator (CPO) and work at its chargers; a blocked or unshared card stops working there within a minute. Cards with an energy or spending limit are checked with PlugSure before every session, and roaming charges count towards the limit.</p>
          <div data-cards></div></div>
        <div class="card section"><header><h3>Charges from other networks</h3><button class="btn sm right" type="button" data-csv>${icon('download')} Export CSV</button></header><div data-active></div><div data-cdrs></div></div>
        <div class="card section" data-app-roam></div>`; // v1.7's driver-app card after v1.5's two, which keep their place
      const [cards, abroad] = await Promise.all([api('/v1/roaming/cards'), api('/v1/roaming/abroad')]);
      drawAppRoaming($('[data-app-roam]', body));
      table($('[data-cards]', body), {
        columns: [
          { label: 'Card', render: (c) => `<div class="cell-title mono">${esc(c.uid)}</div><div class="cell-sub">${esc(c.holder_name ?? '—')}${c.fleet_name ? ` · ${esc(c.fleet_name)}` : ''}</div>` },
          { label: 'Contract id', render: (c) => (c.contract_id ? `<span class="mono">${esc(c.contract_id)}</span>` : '—') },
          { label: 'Status', render: (c) => (c.status !== 'Accepted' ? tag('t-crit', c.status.toLowerCase()) : c.roaming_shared ? tag('t-ok', 'roaming') : tag('t-mute', 'home only')) },
          { label: 'Limit', render: (c) => esc(c.spend_limit_minor != null ? fmt.money(c.spend_limit_minor, c.spend_limit_currency) : c.energy_limit_wh != null ? fmt.kwh(c.energy_limit_wh, 0) : '—') },
          { label: 'Roaming charges', num: true, render: (c) => (c.roaming_cdrs ? `${Object.entries(c.roaming_by_currency ?? {}).map(([cur, m]) => fmt.money(m, cur)).join('<br>') || fmt.money(c.roaming_minor, c.roaming_currency)}<div class="cell-sub">${fmt.num(c.roaming_cdrs)} ${c.roaming_cdrs === 1 ? 'session' : 'sessions'}</div>` : '—') },
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
          { label: 'Excl. VAT', num: true, render: (c) => majorMoney(c.total_excl_vat, c.currency) },
          { label: 'Total', num: true, render: (c) => `${majorMoney(c.total_incl_vat, c.currency)}${c.status === 'held' ? `<div class="cell-sub">${tag('t-warn', 'held for review')}</div>` : ''}` },
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
        // The page was left while loading (a partner drawer's close refreshes it): nothing to draw into.
        if (!body.isConnected) return;
        if (!hubOnly) drawIdentity();
      }
      if (id === 'partners') drawPartners();
      else if (id === 'hub') await drawHubTab();
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
