import {
  $, $$, esc, asHtml, api, attempt, state, registerView, pageHead, table, tag, icon, fmt, field, options, callout, modal, drawer,
  toast, copy, formValues, fieldErrors, debounce, kpi, COUNTRIES,
} from '../core.js';
import { reasonDialog } from './hub-common.js';
import { drawClearingPlatform } from './hub-clearing.js';

/**
 * PlugSure Hub — the platform operator's console for the OCPI 2.2.1 roaming hub (docs/HUB-DESIGN.md §9.3).
 * platform:admin only, and only when the deployment runs with HUB_ENABLED (features.hub).
 *
 *   Overview     members and parties by status and country, 24 h traffic and errors, outbox backlog, health
 *   Members      external members (token A once, handshakes) and PlugSure tenants (zero-config join);
 *                per member: connections, parties, agreements, traffic, details
 *   Agreements   CPO ⇄ eMSP agreements as a list or a matrix; module flags
 *   Message log  the redacted routing log, filtered; a trace of every leg of one correlation id
 *   Outbox       broadcasts, callbacks and ClientInfo still to deliver, failures, replay
 *   Clearing     only once the clearing module (WP H2) exists in this build
 *
 * Every lifecycle action asks for a reason; the API writes it into the audit entry.
 */

// ─────────────────────────────────────────── vocabulary
const MEMBER_TAG = { onboarding: ['t-info', 'onboarding'], active: ['t-ok', 'active'], suspended: ['t-warn', 'suspended'], terminated: ['t-mute', 'terminated'] };
const CONN_TAG = { pending: ['t-warn', 'waiting for handshake'], connected: ['t-ok', 'connected'], suspended: ['t-warn', 'suspended'], closed: ['t-mute', 'closed'] };
const PARTY_TAG = { CONNECTED: 't-ok', OFFLINE: 't-warn', PLANNED: 't-mute', SUSPENDED: 't-crit' };
const AGREEMENT_TAG = { proposed: 't-info', active: 't-ok', suspended: 't-warn', ended: 't-mute' };
const OUTBOX_TAG = { pending: ['t-info', 'queued'], delivered: ['t-ok', 'delivered'], failed: ['t-crit', 'failed'], dropped: ['t-mute', 'dropped'] };
const ROLE_LABEL = { CPO: 'CPO', EMSP: 'eMSP', NSP: 'NSP', OTHER: 'Other', SCSP: 'SCSP', NAP: 'NAP' };
const MODULES = ['locations', 'tariffs', 'sessions', 'cdrs', 'tokens', 'commands', 'chargingprofiles', 'hubclientinfo', 'credentials', 'versions'];
const ROUTES = ['direct', 'broadcast', 'open', 'get_all', 'hub', 'callback', 'alive'];
const COUNTRY_CODES = ['ID', 'MY', 'SG'];
const countryName = (cc) => COUNTRIES[cc]?.name ?? cc;

const t2 = (m, v) => tag(...(m[v] ?? ['t-mute', v ?? '—']));
const partyKey = (p) => `${p.country_code}*${p.party_id}`;
const shortId = (id) => String(id ?? '').slice(0, 8);
const plural = (n, one, many = `${one}s`) => `${fmt.num(n)} ${n === 1 ? one : many}`;
const flagTag = (on, label) => tag(on ? 't-ok' : 't-mute', label, on ? `${label}: allowed` : `${label}: not allowed`, true);
const ocpiTag = (code) => (code == null ? '' : tag(code < 2000 ? 't-ok' : code < 3000 ? 't-warn' : 't-crit', `OCPI ${code}`, OCPI_TEXT[code] ?? '', true));
const httpTag = (code) => (code == null ? tag('t-crit', 'no answer', '', true) : tag(code < 300 ? 't-ok' : code < 500 ? 't-warn' : 't-crit', `HTTP ${code}`, '', true));
const OCPI_TEXT = {
  1000: 'Success', 2000: 'Client error', 2001: 'Invalid or missing parameters', 2003: 'Unknown location', 2004: 'Unknown token',
  3000: 'Server error', 4000: 'Hub error', 4001: 'Unknown receiver', 4002: 'Timeout on forwarded request', 4003: 'Connection problem (receiver not reachable)',
  4901: 'No active roaming agreement', 4902: 'Module cannot be broadcast', 4903: 'OCPI-from does not belong to this connection', 4904: 'Ambiguous open route', 4905: 'Rate limited',
};

/** POST/PATCH with a toast; resolves to the answer or null. */
const act = (path, body, success, method = 'POST') => attempt(() => api(path, { method, body }), { success });

// ─────────────────────────────────────────── reference data (members, parties, connections)
async function loadRefs() {
  const [m, p, c] = await Promise.all([api('/v1/hub/members'), api('/v1/hub/parties'), api('/v1/hub/connections')]);
  const refs = {
    members: m.members, parties: p.parties, connections: c.connections,
    member: new Map(m.members.map((x) => [x.id, x])),
    party: new Map(p.parties.map((x) => [x.id, x])),
    conn: new Map(c.connections.map((x) => [x.id, x])),
  };
  refs.connLabel = (id) => {
    const cn = refs.conn.get(id);
    return cn ? `${refs.member.get(cn.member_id)?.legal_name ?? 'member'} · ${shortId(id)}` : shortId(id);
  };
  return refs;
}

// ─────────────────────────────────────────── token A (shown once)
function showTokenA(r, memberName) {
  const both = `Versions URL: ${r.versionsUrl}\nToken A: ${r.token}`;
  modal({
    title: 'Send these to the member',
    subtitle: memberName,
    size: 'lg',
    dismissable: false,
    body: `${callout('warn', '<b>Token A is shown once.</b> PlugSure keeps only a hash of it. Send it to the member over a secure channel (not in the same message as the versions URL if you can). It only lets the member register: it stops working as soon as the member has posted its credentials.')}
      <div class="form one" style="margin-top:12px" data-token-a>
        ${field('Versions URL', `<div class="row" style="gap:8px;flex-wrap:nowrap"><code class="secret grow">${esc(r.versionsUrl)}</code><button class="btn sm" type="button" data-copy-url>${icon('copy')} Copy</button></div>`)}
        ${field('Token A (registration token)', `<div class="row" style="gap:8px;flex-wrap:nowrap"><code class="secret grow" data-token>${esc(r.token)}</code><button class="btn sm" type="button" data-copy-token>${icon('copy')} Copy</button></div>`)}
      </div>
      <h4 style="margin:16px 0 6px">What the member does next</h4>
      <ol class="small" style="margin:0;padding-left:20px;display:grid;gap:4px">
        <li><span class="mono">GET</span> the versions URL with the header <span class="mono">Authorization: Token &lt;base64 of token A&gt;</span>, then the 2.2.1 version details.</li>
        <li><span class="mono">POST</span> its credentials (its own token B, its versions URL and its roles) to the hub's <span class="mono">credentials</span> endpoint.</li>
        <li>The hub answers with token C, which the member uses from then on. Token A stops working.</li>
        <li>The connection shows <b>connected</b> here. Its parties stay <b>planned</b> (invisible to others) until you activate the member and create agreements.</li>
      </ol>
      <p class="cell-sub" style="margin:10px 0 0">The member's guide is <span class="mono">deploy/HUB-ONBOARDING.md</span> (routing headers, modules, error codes, go-live checklist).</p>`,
    actions: [
      { label: 'Copy both', onClick() { copy(both); return false; } },
      { label: 'Done, I have sent them', kind: 'primary' },
    ],
    onMount(ctx) {
      $('[data-copy-url]', ctx.body).addEventListener('click', () => copy(r.versionsUrl));
      $('[data-copy-token]', ctx.body).addEventListener('click', () => copy(r.token));
    },
  });
}

async function newConnection(member, done) {
  const reason = await reasonDialog({
    title: `New connection for ${member.legal_name}`,
    message: 'The hub issues a registration token (token A) for the member to start the credentials handshake. It is shown once.',
    confirmLabel: 'Issue token A', reasonRequired: false,
  });
  if (reason === null) return;
  const r = await act(`/v1/hub/members/${member.id}/connections`, { reason: reason || undefined });
  if (!r) return;
  done?.();
  setTimeout(() => showTokenA(r, member.legal_name), 60);
}

function connectDialog(conn, done) {
  modal({
    title: 'Hub starts the handshake',
    subtitle: 'The member gave you its versions URL and a token A of its own. The hub registers with it.',
    body: `<div class="form one">
      ${field("Member's versions URL", '<input name="versions_url" placeholder="https://ocpi.member.example/versions" autocomplete="off">')}
      ${field("Member's token A", '<input name="token" autocomplete="off">', { help: 'Sent once to the member and not stored; the member issues token C in return.' })}
    </div>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Connect', kind: 'primary',
      async onClick(ctx) {
        const v = formValues(ctx.body);
        const errs = {};
        if (!/^https?:\/\//.test(v.versions_url ?? '')) errs.versions_url = 'A versions URL (https://…)';
        if (!String(v.token ?? '').trim()) errs.token = 'The token the member gave you';
        if (Object.keys(errs).length) { fieldErrors(ctx.body, errs); return false; }
        const r = await act(`/v1/hub/connections/${conn.id}/connect`, { versions_url: v.versions_url.trim(), token: v.token.trim() }, (x) => `Connected: ${plural(x.parties?.length ?? 0, 'party', 'parties')} registered`);
        if (!r) return false;
        done();
      },
    }],
  });
}

function approvePartyDialog(conn, done) {
  modal({
    title: 'Approve an additional party',
    subtitle: 'The party is added as planned; the member then confirms it with PUT /credentials listing the new role.',
    body: `<div class="form">
      ${field('Role', `<select name="role">${options([{ value: 'CPO', label: 'CPO — charge point operator' }, { value: 'EMSP', label: 'eMSP — service provider' }, { value: 'NSP', label: 'NSP — navigation service' }, { value: 'SCSP', label: 'SCSP — smart charging' }, { value: 'OTHER', label: 'Other' }], 'CPO')}</select>`)}
      ${field('Country code', `<select name="country_code">${options(COUNTRY_CODES.map((c) => ({ value: c, label: `${c} — ${countryName(c)}` })), 'MY')}</select>`)}
      ${field('Party ID', '<input name="party_id" maxlength="3" placeholder="ABC" autocomplete="off" style="text-transform:uppercase">', { help: 'Three letters or digits.' })}
      ${field('Business name', '<input name="business_name" autocomplete="off">')}
      ${field('Website', '<input name="website" placeholder="https://…" autocomplete="off">', { opt: true, full: true })}
      ${field('Reason', '<input name="reason" maxlength="500" autocomplete="off">', { opt: true, full: true, help: 'Kept in the audit log.' })}
    </div>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Approve party', kind: 'primary',
      async onClick(ctx) {
        const v = formValues(ctx.body);
        if (!/^[A-Za-z0-9]{3}$/.test(v.party_id ?? '')) { fieldErrors(ctx.body, { party_id: 'Three letters or digits' }); return false; }
        if (!String(v.business_name ?? '').trim()) { fieldErrors(ctx.body, { business_name: 'The name drivers and partners see' }); return false; }
        const r = await act(`/v1/hub/connections/${conn.id}/parties`, { ...v, party_id: v.party_id.toUpperCase(), website: v.website || undefined, reason: v.reason || undefined }, (x) => `${partyKey(x.party)} approved (planned)`);
        if (!r) return false;
        done();
      },
    }],
  });
}

function limitsDialog(conn, done) {
  modal({
    title: 'Rate limits',
    subtitle: 'Requests a minute this connection may send to the hub. Over the limit the hub answers HTTP 429 with OCPI 4905.',
    body: `<div class="form">
      ${field('All requests', `<div class="inputgroup"><input name="rate_limit_per_min" inputmode="numeric" value="${esc(conn.rate_limit_per_min)}"><span class="suffix">/ min</span></div>`)}
      ${field('Real-time authorisation', `<div class="inputgroup"><input name="realtime_limit_per_min" inputmode="numeric" value="${esc(conn.realtime_limit_per_min)}"><span class="suffix">/ min</span></div>`)}
      ${field('Reason', '<input name="reason" maxlength="500" autocomplete="off">', { opt: true, full: true })}
    </div>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Save limits', kind: 'primary',
      async onClick(ctx) {
        const v = formValues(ctx.body);
        const n = (x) => Number(String(x).replace(/[^\d]/g, ''));
        const r = await act(`/v1/hub/connections/${conn.id}`, { rate_limit_per_min: n(v.rate_limit_per_min), realtime_limit_per_min: n(v.realtime_limit_per_min), reason: v.reason || undefined }, 'Limits saved', 'PATCH');
        if (!r) return false;
        done();
      },
    }],
  });
}

async function captureDialog(conn, done) {
  const on = conn.capture_bodies_until && new Date(conn.capture_bodies_until) > new Date();
  modal({
    title: 'Body capture (support)',
    subtitle: 'While on, the message log keeps the bodies of this connection\'s messages, redacted (token uids, contract ids, names and e-mail masked). Off by default; at most 72 hours.',
    body: `<div class="form">
      ${field('Capture for', `<select name="hours">${options([{ value: 0, label: 'Off' }, { value: 1, label: '1 hour' }, { value: 4, label: '4 hours' }, { value: 24, label: '24 hours' }, { value: 72, label: '72 hours' }], on ? 4 : 1)}</select>`, { help: on ? `On until ${esc(fmt.time(conn.capture_bodies_until))}.` : 'Currently off.' })}
      ${field('Reason', '<input name="reason" maxlength="500" autocomplete="off" placeholder="support ticket">', { full: true, help: 'Required: captured bodies are personal data, even redacted.' })}
    </div>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Apply', kind: 'primary',
      async onClick(ctx) {
        const v = formValues(ctx.body);
        if (Number(v.hours) > 0 && !String(v.reason ?? '').trim()) { fieldErrors(ctx.body, { reason: 'Give a reason for the audit log' }); return false; }
        const r = await act(`/v1/hub/connections/${conn.id}/capture`, { hours: Number(v.hours), reason: v.reason || undefined }, Number(v.hours) ? 'Body capture on' : 'Body capture off');
        if (!r) return false;
        done();
      },
    }],
  });
}

// ─────────────────────────────────────────── member: create, join, detail
function newMemberDialog(done) {
  modal({
    title: 'New external member',
    subtitle: 'A roaming operator or service provider on its own platform, connecting to PlugSure Hub over OCPI 2.2.1.',
    size: 'lg',
    body: `<div class="form">
      ${field('Legal name', '<input name="legal_name" maxlength="300" placeholder="PT Charge Indo / XYZ Sdn Bhd / ABC Pte Ltd" autocomplete="off">', { full: true })}
      ${field('Country of incorporation', `<select name="country_code">${options(COUNTRY_CODES.map((c) => ({ value: c, label: countryName(c) })), 'ID')}</select>`, { help: 'Picks the PlugSure entity that invoices the hub fees.' })}
      ${field('Tax ID', '<input name="tax_id" maxlength="60" placeholder="NPWP / SST no. / GST no." autocomplete="off">', { opt: true })}
      ${field('Billing e-mail', '<input name="billing_email" type="email" autocomplete="off">', { opt: true })}
      ${field('Contract reference', '<input name="contract_ref" maxlength="120" placeholder="Signed hub agreement" autocomplete="off">', { opt: true })}
      <div class="field full"><label class="check"><input type="checkbox" name="open_roaming"> <span><b>Open roaming.</b> Roams with every other open-roaming member without a bilateral agreement.</span></label></div>
      <div class="field full"><label class="check"><input type="checkbox" name="connect_now" checked> <span><b>Issue its registration token (token A) now.</b> Leave it off when the member gives you its own versions URL and token (the hub then starts the handshake).</span></label></div>
    </div>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Create member', kind: 'primary',
      async onClick(ctx) {
        const v = formValues(ctx.body);
        if (!String(v.legal_name ?? '').trim()) { fieldErrors(ctx.body, { legal_name: 'The member\'s legal name' }); return false; }
        const r = await act('/v1/hub/members', {
          legal_name: v.legal_name.trim(), country_code: v.country_code, tax_id: v.tax_id || undefined, billing_email: v.billing_email || undefined,
          contract_ref: v.contract_ref || undefined, open_roaming: v.open_roaming === true,
        }, `${v.legal_name.trim()} created (onboarding)`);
        if (!r) return false;
        let conn = null;
        if (v.connect_now) conn = await act(`/v1/hub/members/${r.member.id}/connections`, {});
        done(r.member);
        if (conn) setTimeout(() => showTokenA(conn, r.member.legal_name), 60);
      },
    }],
  });
}

async function joinTenantDialog(done) {
  const { tenants } = await api('/v1/hub/tenants');
  const free = tenants.filter((t) => !t.member_id);
  modal({
    title: 'Join a PlugSure tenant to the hub',
    subtitle: 'Zero configuration: the tenant\'s roaming identities become hub parties (CPO, and eMSP for the home party) and a "PlugSure Hub" partner appears in its Roaming page. No handshake, no network calls.',
    body: free.length
      ? `<div class="form one">
          ${field('Tenant', `<select name="org_id">${options(free.map((t) => ({ value: t.id, label: `${t.name} — ${(t.parties ?? []).join(', ')}` })))}</select>`, { help: 'Only organisations with a roaming identity (Roaming → identity) are listed.' })}
          ${field('Reason', '<input name="reason" maxlength="500" autocomplete="off">', { opt: true })}
        </div>
        <p class="cell-sub" style="margin:10px 0 0">The tenant starts in <b>onboarding</b>: activate it once its hub agreement is signed.</p>`
      : callout('info', 'Every tenant with a roaming identity is already a hub member. A tenant sets its identity under Roaming first.'),
    actions: free.length ? [{ label: 'Cancel' }, {
      label: 'Join to hub', kind: 'primary',
      async onClick(ctx) {
        const v = formValues(ctx.body);
        const r = await act('/v1/hub/members/join-tenant', { org_id: v.org_id, reason: v.reason || undefined }, (x) => (x.created ? `${x.member.legal_name} joined the hub` : 'Already a member'));
        if (!r) return false;
        done(r.member);
      },
    }] : [{ label: 'Close' }],
  });
}

function memberHeader(m) {
  const kind = m.kind === 'internal' ? tag('t-info', 'PlugSure tenant', '', true) : tag('t-mute', 'external', '', true);
  return `${t2(MEMBER_TAG, m.status)} ${kind} <span class="cell-sub">${esc(countryName(m.country_code))}${m.open_roaming ? ' · open roaming' : ''}</span>`;
}

function memberActions(m) {
  if (m.status === 'terminated') return '';
  const b = (a, label, cls = '') => `<button class="btn sm ${cls}" type="button" data-maction="${a}">${esc(label)}</button>`;
  return `<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
    ${m.status === 'onboarding' ? b('activate', 'Activate', 'primary') : ''}
    ${m.status === 'active' ? b('suspend', 'Suspend') : ''}
    ${m.status === 'suspended' ? b('resume', 'Resume', 'primary') : ''}
    ${m.kind === 'external' ? b('connection', 'New connection') : ''}
    ${m.kind === 'internal' ? b('leave', 'Remove from hub', 'danger') : b('terminate', 'Terminate', 'danger')}
  </div>`;
}

export function openMember(memberId, onChange) {
  let m = null;
  let d = null;
  let data = null;
  const load = async () => {
    data = await api(`/v1/hub/members/${memberId}`);
    m = data.member;
    $('h2', d.el).textContent = m.legal_name;
    d.setSubtitle(memberHeader(m));
    d.setHeader(memberActions(m));
    wireMemberActions();
    return data;
  };
  const reload = async () => { await load(); await d.refresh(); onChange?.(); };

  const wireMemberActions = () => {
    $$('[data-maction]', d.el).forEach((btn) => btn.addEventListener('click', async () => {
      const a = btn.dataset.maction;
      if (a === 'connection') return newConnection(m, reload);
      const spec = {
        activate: { title: `Activate ${m.legal_name}?`, message: 'Its parties become CONNECTED and visible (ClientInfo) to the members it has agreements with. Do this once the hub agreement is signed.', label: 'Activate', reasonRequired: false },
        suspend: { title: `Suspend ${m.legal_name}?`, message: 'Every connection of the member is refused (HTTP 403) and its parties show SUSPENDED to its counterparties. Messages queued for it are dropped. Resume at any time.', label: 'Suspend', danger: true },
        resume: { title: `Resume ${m.legal_name}?`, message: 'Its connections work again and its parties come back as CONNECTED.', label: 'Resume', reasonRequired: false },
        terminate: { title: `Terminate ${m.legal_name}?`, message: 'Final: every connection is closed, its tokens stop working and its parties are SUSPENDED for good. The records are kept.', label: 'Terminate', danger: true, requireText: 'TERMINATE' },
        leave: { title: `Remove ${m.legal_name} from the hub?`, message: 'The tenant\'s hub connection and its "PlugSure Hub" partner are closed and its parties SUSPENDED. Records are kept; it can be joined again later.', label: 'Remove from hub', danger: true, requireText: 'REMOVE' },
      }[a];
      const reason = await reasonDialog({ title: spec.title, message: spec.message, confirmLabel: spec.label, danger: spec.danger, requireText: spec.requireText, reasonRequired: spec.reasonRequired !== false });
      if (reason === null) return;
      const r = a === 'leave'
        ? await act('/v1/hub/members/leave-tenant', { org_id: m.org_id, reason: reason || undefined }, 'Removed from the hub')
        : await act(`/v1/hub/members/${m.id}`, { action: a, reason: reason || undefined }, `${m.legal_name}: ${a === 'resume' ? 'resumed' : `${a}d`}`, 'PATCH');
      if (r) await reload();
    }));
  };

  // ── connections
  const renderConnections = async (body) => {
    if (!data) await load();
    const conns = [...data.connections].sort((a, b) => (a.state === 'closed') - (b.state === 'closed'));
    const live = conns.filter((c) => c.state !== 'closed');
    const closed = conns.filter((c) => c.state === 'closed');
    const partiesOf = (cid) => data.parties.filter((p) => p.connection_id === cid);
    const card = (c) => {
      const btn = (a, label, cls = '') => `<button class="btn sm ${cls}" type="button" data-caction="${a}" data-cid="${esc(c.id)}">${esc(label)}</button>`;
      const capOn = c.capture_bodies_until && new Date(c.capture_bodies_until) > new Date();
      const eps = Array.isArray(c.endpoints) ? c.endpoints : [];
      const actions = c.state === 'closed' ? '' : `<div class="row" style="gap:6px;flex-wrap:wrap;margin-top:12px">
          ${c.state === 'pending' && c.kind === 'external' ? btn('connect', 'Connect with their URL and token', 'primary') : ''}
          ${c.state === 'connected' ? btn('alive', 'Alive check') : ''}
          ${c.state === 'connected' ? btn('rotate', 'Rotate token') : ''}
          ${c.state === 'connected' ? btn('suspend', 'Suspend') : ''}
          ${c.state === 'suspended' ? btn('resume', 'Resume', 'primary') : ''}
          ${c.kind === 'external' ? btn('parties', 'Approve a party') : ''}
          ${btn('limits', 'Rate limits')}
          ${btn('capture', capOn ? 'Body capture: on' : 'Body capture')}
          ${c.kind === 'external' ? btn('close', 'Close', 'danger') : ''}
        </div>`;
      return `<div class="card section" data-conn="${esc(c.id)}">
        <header><h3>${c.kind === 'internal' ? 'In-process connection' : 'Connection'} <span class="mono cell-sub">${esc(shortId(c.id))}</span></h3>
          ${t2(CONN_TAG, c.state)}${c.rotation_grace ? ` ${tag('t-info', 'old token in grace period', 'After a forced rotation the old token stays valid for HUB_TOKEN_GRACE_MIN.')}` : ''}${capOn ? ` ${tag('t-warn', 'capturing bodies')}` : ''}</header>
        <div class="body">
          <dl class="kv">
            <dt>Versions URL</dt><dd>${c.versions_url ? `<span class="mono">${esc(c.versions_url)}</span>` : '<span class="muted">not yet — waiting for the member\'s credentials</span>'}</dd>
            <dt>OCPI version</dt><dd>${esc(c.version ?? '—')}</dd>
            <dt>Parties</dt><dd>${partiesOf(c.id).map((p) => `${tag(PARTY_TAG[p.status] ?? 't-mute', `${partyKey(p)} ${ROLE_LABEL[p.role] ?? p.role}`, p.status)}`).join(' ') || '<span class="muted">none yet</span>'}</dd>
            <dt>Registered</dt><dd>${esc(c.registered_at ? fmt.time(c.registered_at) : '—')}</dd>
            <dt>Last message</dt><dd>${esc(fmt.ago(c.last_inbound_at))}</dd>
            <dt>Last alive check OK</dt><dd>${esc(fmt.ago(c.last_alive_ok_at))}${c.alive_failures ? ` ${tag('t-warn', plural(c.alive_failures, 'failure'))}` : ''}</dd>
            ${c.last_error ? `<dt>Last problem</dt><dd style="color:var(--crit)">${esc(c.last_error)}</dd>` : ''}
            <dt>Rate limits</dt><dd>${fmt.num(c.rate_limit_per_min)} / min · real-time ${fmt.num(c.realtime_limit_per_min)} / min</dd>
            ${capOn ? `<dt>Body capture</dt><dd>until ${esc(fmt.time(c.capture_bodies_until))}</dd>` : ''}
          </dl>
          ${eps.length ? `<details style="margin-top:10px"><summary class="small" style="cursor:pointer">Endpoints (${eps.length})</summary><div data-eps style="margin-top:8px"></div></details>` : ''}
          ${actions}
        </div></div>`;
    };
    body.innerHTML = `${m.kind === 'external' && !live.length && m.status !== 'terminated' ? callout('info', `No open connection. ${'<button class="btn sm primary" type="button" data-new-conn>Issue token A</button>'}`) : ''}
      ${m.kind === 'external' && live.length && m.status !== 'terminated' ? '<div class="row" style="justify-content:flex-end"><button class="btn sm" type="button" data-new-conn>' + icon('plus') + ' New connection</button></div>' : ''}
      ${live.map(card).join('')}
      ${closed.length ? `<details class="section"><summary class="small muted" style="cursor:pointer">Closed connections (${closed.length})</summary>${closed.map(card).join('')}</details>` : ''}`;
    for (const c of conns) {
      const box = $(`[data-conn="${CSS.escape(c.id)}"] [data-eps]`, body);
      if (box) table(box, { columns: [{ label: 'Module', render: (e) => `<span class="mono">${esc(e.identifier)}</span>` }, { label: 'Role', key: 'role' }, { label: 'URL', render: (e) => `<span class="mono wrap">${esc(e.url)}</span>` }], rows: c.endpoints });
    }
    $$('[data-new-conn]', body).forEach((b) => b.addEventListener('click', () => newConnection(m, reload)));
    $$('[data-caction]', body).forEach((b) => b.addEventListener('click', async () => {
      const c = conns.find((x) => x.id === b.dataset.cid);
      const a = b.dataset.caction;
      if (a === 'connect') return connectDialog(c, reload);
      if (a === 'parties') return approvePartyDialog(c, reload);
      if (a === 'limits') return limitsDialog(c, reload);
      if (a === 'capture') return captureDialog(c, reload);
      if (a === 'alive') {
        const r = await act(`/v1/hub/connections/${c.id}/alive-check`, {});
        const res = r?.checks?.[0];
        if (r) toast(!res ? 'Nothing to check (no versions URL yet)' : res.ok ? 'The member answered' : `No valid answer${res.offline ? ': its parties are now OFFLINE' : ''}`, !res || res.ok ? 'ok' : 'warn');
        return reload();
      }
      const spec = {
        rotate: { title: 'Rotate the connection\'s token?', message: c.kind === 'internal' ? 'Both in-process tokens are replaced at once.' : 'The hub issues new credentials to the member (PUT on its credentials endpoint). The member\'s old token keeps working for the grace period (HUB_TOKEN_GRACE_MIN).', label: 'Rotate', reasonRequired: false },
        suspend: { title: 'Suspend this connection?', message: 'The member\'s requests on it are refused (HTTP 403) and its parties show SUSPENDED to counterparties. Queued messages to it are dropped.', label: 'Suspend', danger: true },
        resume: { title: 'Resume this connection?', message: 'Requests are accepted again and its parties come back.', label: 'Resume', reasonRequired: false },
        close: { title: 'Close this connection?', message: 'Final: its tokens stop working, the member is told (DELETE on its credentials) and its parties become SUSPENDED. A new connection needs a new token A.', label: 'Close connection', danger: true, requireText: 'CLOSE' },
      }[a];
      const reason = await reasonDialog({ title: spec.title, message: spec.message, confirmLabel: spec.label, danger: spec.danger, requireText: spec.requireText, reasonRequired: spec.reasonRequired !== false });
      if (reason === null) return;
      if (await act(`/v1/hub/connections/${c.id}/${a}`, { reason: reason || undefined }, { rotate: 'Token rotated', suspend: 'Connection suspended', resume: 'Connection resumed', close: 'Connection closed' }[a])) await reload();
    }));
  };

  // ── parties
  const renderParties = async (body) => {
    if (!data) await load();
    body.innerHTML = `<p class="cell-sub" style="margin:0 0 10px">A party is a country code and party ID in one role. Routing addresses parties; status is what other members see in ClientInfo. A party suspended here stays suspended whatever its connection does.</p><div class="card" data-t></div>`;
    table($('[data-t]', body), {
      columns: [
        { label: 'Party', render: (p) => `<div class="cell-title mono">${esc(partyKey(p))}</div><div class="cell-sub">${esc(p.business_name)}</div>` },
        { label: 'Role', render: (p) => esc(ROLE_LABEL[p.role] ?? p.role) },
        { label: 'Status', render: (p) => `${tag(PARTY_TAG[p.status] ?? 't-mute', p.status.toLowerCase())}${p.admin_suspended ? '<div class="cell-sub">by the platform</div>' : ''}` },
        { label: 'Since', render: (p) => `<span class="nowrap">${esc(fmt.ago(p.status_changed_at))}</span>` },
        { label: 'Connection', render: (p) => `<span class="mono cell-sub">${esc(shortId(p.connection_id))}</span>` },
        { label: '', render: (p) => (m.status === 'terminated' ? '' : p.admin_suspended
          ? `<button class="btn sm" type="button" data-presume="${esc(p.id)}">Resume</button>`
          : `<button class="btn sm" type="button" data-psuspend="${esc(p.id)}">Suspend</button>`) },
      ],
      rows: data.parties,
      empty: m.kind === 'external' ? 'No parties yet: they appear when the member completes the credentials handshake.' : 'No parties.',
    });
    const set = async (id, action) => {
      const p = data.parties.find((x) => x.id === id);
      const reason = await reasonDialog({
        title: `${action === 'suspend' ? 'Suspend' : 'Resume'} ${partyKey(p)} (${ROLE_LABEL[p.role]})?`,
        message: action === 'suspend' ? 'Only this party: messages to or from it are refused (OCPI 4003), counterparties see it SUSPENDED. The member\'s other parties are not affected.' : 'The party is routed again; counterparties see it CONNECTED (or OFFLINE until its platform answers).',
        confirmLabel: action === 'suspend' ? 'Suspend party' : 'Resume party', danger: action === 'suspend', reasonRequired: action === 'suspend',
      });
      if (reason === null) return;
      if (await act(`/v1/hub/parties/${id}`, { action, reason: reason || undefined }, `${partyKey(p)} ${action === 'suspend' ? 'suspended' : 'resumed'}`, 'PATCH')) await reload();
    };
    $$('[data-psuspend]', body).forEach((b) => b.addEventListener('click', () => set(b.dataset.psuspend, 'suspend')));
    $$('[data-presume]', body).forEach((b) => b.addEventListener('click', () => set(b.dataset.presume, 'resume')));
  };

  // ── agreements of this member
  const renderMemberAgreements = async (body) => {
    if (!data) await load();
    const ids = new Set(data.parties.map((p) => p.id));
    const [{ agreements }, refs] = await Promise.all([api('/v1/hub/agreements'), loadRefs()]);
    const mine = agreements.filter((a) => ids.has(a.cpo_party_id) || ids.has(a.emsp_party_id));
    body.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:10px"><p class="cell-sub" style="margin:0">Roaming agreements its parties are in. Without an active agreement (or mutual open roaming), the hub routes nothing between two parties.</p>
      ${m.status !== 'terminated' && data.parties.length ? `<button class="btn sm primary" type="button" data-new-ag>${icon('plus')} New agreement</button>` : ''}</div><div class="card" data-t></div>`;
    agreementsTable($('[data-t]', body), mine, refs, () => reload());
    $('[data-new-ag]', body)?.addEventListener('click', () => {
      const cpo = data.parties.find((p) => p.role === 'CPO');
      const emsp = data.parties.find((p) => p.role !== 'CPO');
      newAgreementDialog(refs, { cpo: cpo?.id, emsp: cpo ? undefined : emsp?.id }, reload);
    });
  };

  // ── traffic of this member's connections
  const renderMemberTraffic = async (body) => {
    if (!data) await load();
    const conns = data.connections.filter((c) => c.state !== 'closed');
    if (!conns.length) { body.innerHTML = callout('info', 'No open connection, so no traffic.'); return; }
    body.innerHTML = `${conns.length > 1 ? `<div class="filters">${field('Connection', `<select data-conn>${options(conns.map((c) => ({ value: c.id, label: `${shortId(c.id)} · ${c.state}` })))}</select>`)}</div>` : ''}<div data-log></div>`;
    const draw = () => messageLog($('[data-log]', body), { connection: $('[data-conn]', body)?.value ?? conns[0].id }, { compact: true });
    $('[data-conn]', body)?.addEventListener('change', draw);
    await draw();
  };

  // ── details
  const renderDetails = async (body) => {
    if (!data) await load();
    const ro = m.status === 'terminated' ? ' disabled' : '';
    body.innerHTML = `<div class="card pad"><form class="form" novalidate>
        ${field('Legal name', `<input name="legal_name" maxlength="300"${ro}>`, { full: true })}
        ${field('Tax ID', `<input name="tax_id" maxlength="60" placeholder="NPWP / SST no. / GST no."${ro}>`, { opt: true })}
        ${field('Billing e-mail', `<input name="billing_email" type="email"${ro}>`, { opt: true })}
        ${field('Contract reference', `<input name="contract_ref" maxlength="120"${ro}>`, { opt: true })}
        <div class="field full"><label class="check"><input type="checkbox" name="open_roaming"${m.open_roaming ? ' checked' : ''}${ro}> <span><b>Open roaming</b> — roams with every other open-roaming member without a bilateral agreement.</span></label></div>
        ${ro ? '' : '<div class="field full"><div class="row"><button class="btn primary" type="submit">Save</button></div></div>'}
      </form></div>
      <div class="card section"><header><h3>Record</h3></header><div class="body"><dl class="kv">
        <dt>Kind</dt><dd>${m.kind === 'internal' ? 'PlugSure tenant (in-process)' : 'External platform'}</dd>
        <dt>Country</dt><dd>${esc(countryName(m.country_code))}</dd>
        <dt>Organisation</dt><dd class="mono">${esc(m.org_id)}</dd>
        <dt>Member id</dt><dd class="mono">${esc(m.id)}</dd>
        <dt>Created</dt><dd>${esc(fmt.time(m.created_at))}</dd>
        <dt>Updated</dt><dd>${esc(fmt.time(m.updated_at))}</dd>
      </dl></div></div>`;
    const form = $('form', body);
    for (const k of ['legal_name', 'tax_id', 'billing_email', 'contract_ref']) $(`[name="${k}"]`, form).value = m[k] ?? '';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(form);
      if (!String(v.legal_name ?? '').trim()) return fieldErrors(form, { legal_name: 'Required' });
      const patch = { legal_name: v.legal_name.trim(), tax_id: v.tax_id, billing_email: v.billing_email, contract_ref: v.contract_ref };
      if (v.open_roaming !== m.open_roaming) patch.open_roaming = v.open_roaming;
      if (await act(`/v1/hub/members/${m.id}`, patch, 'Saved', 'PATCH')) await reload();
    });
  };

  d = drawer({
    title: 'Member',
    tabs: [
      { id: 'connections', label: 'Connections', render: (b) => renderConnections(b) },
      { id: 'parties', label: 'Parties', render: (b) => renderParties(b) },
      { id: 'agreements', label: 'Agreements', render: (b) => renderMemberAgreements(b) },
      { id: 'traffic', label: 'Traffic', render: (b) => renderMemberTraffic(b) },
      { id: 'details', label: 'Details', render: (b) => renderDetails(b) },
    ],
    onClose: () => { if (location.hash.startsWith('#/hub/members/')) history.replaceState(null, '', '#/hub/members'); },
  });
  return d;
}

// ─────────────────────────────────────────── agreements
function agreementsTable(root, rows, refs, done) {
  const side = (pid, label) => {
    const p = refs.party.get(pid);
    const mem = p ? refs.member.get(p.member_id) : null;
    return `<div class="cell-title mono">${esc(label ?? (p ? partyKey(p) : '—'))}</div><div class="cell-sub">${esc(mem?.legal_name ?? '')}</div>`;
  };
  table(root, {
    columns: [
      { label: 'CPO', render: (a) => side(a.cpo_party_id, a.cpo) },
      { label: 'Service provider', render: (a) => `${side(a.emsp_party_id, a.emsp)}${a.emsp_role && a.emsp_role !== 'EMSP' ? `<div class="cell-sub">${esc(ROLE_LABEL[a.emsp_role] ?? a.emsp_role)}</div>` : ''}` },
      { label: 'Status', render: (a) => tag(AGREEMENT_TAG[a.status] ?? 't-mute', a.status) },
      { label: 'Modules', render: (a) => `<div class="chips">${flagTag(a.allow_realtime_auth, 'real-time auth')}${flagTag(a.allow_commands, 'commands')}${flagTag(a.allow_charging_profiles, 'charging profiles')}</div>` },
      { label: 'Valid', render: (a) => `<span class="nowrap">${a.valid_from || a.valid_to ? `${esc(a.valid_from ? fmt.date(a.valid_from) : 'now')} – ${esc(a.valid_to ? fmt.date(a.valid_to) : 'open')}` : 'open-ended'}</span>` },
      { label: 'Created', render: (a) => `<span class="nowrap">${esc(fmt.date(a.created_at))}</span>` },
    ],
    rows,
    empty: 'No agreements.',
    onRow: (a) => agreementDialog(a, refs, done),
  });
}

function agreementDialog(a, refs, done) {
  const cpo = refs.party.get(a.cpo_party_id);
  const emsp = refs.party.get(a.emsp_party_id);
  const name = (p) => (p ? `${partyKey(p)} (${refs.member.get(p.member_id)?.legal_name ?? ''})` : '—');
  const live = a.status !== 'ended';
  const ctx = modal({
    title: `${a.cpo ?? (cpo ? partyKey(cpo) : 'CPO')} ⇄ ${a.emsp ?? (emsp ? partyKey(emsp) : 'eMSP')}`,
    subtitle: `Roaming agreement · ${a.status}`,
    size: 'lg',
    body: `<dl class="kv">
        <dt>CPO</dt><dd>${esc(name(cpo))}</dd>
        <dt>Service provider</dt><dd>${esc(name(emsp))}</dd>
        <dt>Status</dt><dd>${tag(AGREEMENT_TAG[a.status] ?? 't-mute', a.status)}</dd>
        <dt>Proposed by</dt><dd>${esc(a.proposed_by ?? '—')}</dd>
        <dt>Valid</dt><dd>${esc(a.valid_from ? fmt.time(a.valid_from) : 'from creation')} – ${esc(a.valid_to ? fmt.time(a.valid_to) : 'open-ended')}</dd>
        <dt>Created</dt><dd>${esc(fmt.time(a.created_at))}</dd>
        ${a.notes ? `<dt>Notes</dt><dd>${esc(a.notes)}</dd>` : ''}
      </dl>
      <fieldset style="margin-top:14px"><legend>Modules the agreement allows</legend>
        <div class="checks">
          <label class="check"><input type="checkbox" name="allow_realtime_auth"${a.allow_realtime_auth ? ' checked' : ''}${live ? '' : ' disabled'}> <span>Real-time authorisation</span></label>
          <label class="check"><input type="checkbox" name="allow_commands"${a.allow_commands ? ' checked' : ''}${live ? '' : ' disabled'}> <span>Commands (remote start/stop, reserve, unlock)</span></label>
          <label class="check"><input type="checkbox" name="allow_charging_profiles"${a.allow_charging_profiles ? ' checked' : ''}${live ? '' : ' disabled'}> <span>Charging profiles</span></label>
        </div>
        <p class="cell-sub" style="margin:6px 0 0">Locations, tariffs, tokens, sessions and CDRs always flow under an active agreement; a module turned off here is refused with OCPI 4901.</p>
      </fieldset>`,
    actions: [
      ...(a.status === 'proposed' ? [{ label: 'Approve', kind: 'primary', onClick: () => transition('approve') }] : []),
      ...(a.status === 'active' ? [{ label: 'Suspend', onClick: () => transition('suspend') }] : []),
      ...(a.status === 'suspended' ? [{ label: 'Resume', kind: 'primary', onClick: () => transition('resume') }] : []),
      ...(live ? [{ label: 'End', kind: 'danger', onClick: () => transition('end') }] : []),
      ...(live ? [{
        label: 'Save modules',
        async onClick(c) {
          const v = formValues(c.body);
          const r = await act(`/v1/hub/agreements/${a.id}`, { allow_realtime_auth: v.allow_realtime_auth, allow_commands: v.allow_commands, allow_charging_profiles: v.allow_charging_profiles }, 'Modules saved', 'PATCH');
          if (!r) return false;
          done();
        },
      }] : []),
      { label: 'Close' },
    ],
  });
  async function transition(action) {
    const spec = {
      approve: { title: 'Approve this agreement?', message: 'It becomes active: the parties see each other in ClientInfo and the hub routes between them.', label: 'Approve', reasonRequired: false },
      suspend: { title: 'Suspend this agreement?', message: 'Routing between the two parties stops (OCPI 4901) and each sees the other SUSPENDED. Resume at any time.', label: 'Suspend', danger: true },
      resume: { title: 'Resume this agreement?', message: 'Routing between the two parties starts again.', label: 'Resume', reasonRequired: false },
      end: { title: 'End this agreement?', message: 'Final: routing between the two parties stops for good. A new agreement can be created later.', label: 'End agreement', danger: true, requireText: 'END' },
    }[action];
    const reason = await reasonDialog({ title: spec.title, message: spec.message, confirmLabel: spec.label, danger: spec.danger, requireText: spec.requireText, reasonRequired: spec.reasonRequired !== false });
    if (reason === null) return false;
    const r = await act(`/v1/hub/agreements/${a.id}`, { action, reason: reason || undefined }, { approve: 'Agreement active', suspend: 'Agreement suspended', resume: 'Agreement resumed', end: 'Agreement ended' }[action], 'PATCH');
    if (!r) return false;
    ctx.close();
    done();
    return true;
  }
}

function newAgreementDialog(refs, pre = {}, done) {
  const usable = (p) => p.status !== 'SUSPENDED' || !p.admin_suspended;
  const label = (p) => `${partyKey(p)} — ${refs.member.get(p.member_id)?.legal_name ?? ''}${p.status === 'PLANNED' ? ' (planned)' : ''}`;
  const live = (p) => refs.member.get(p.member_id)?.status !== 'terminated';
  const cpos = refs.parties.filter((p) => p.role === 'CPO' && live(p) && usable(p));
  const emsps = refs.parties.filter((p) => p.role !== 'CPO' && p.role !== 'NAP' && live(p) && usable(p));
  modal({
    title: 'New roaming agreement',
    subtitle: 'Between a CPO party and a service-provider party of two different members. Created active unless you leave it as a proposal.',
    size: 'lg',
    body: `<div class="form">
      ${field('CPO', `<select name="cpo_party_id">${options(cpos.map((p) => ({ value: p.id, label: label(p) })), pre.cpo, { blank: 'Choose a CPO party' })}</select>`, { full: true })}
      ${field('Service provider (eMSP, NSP, SCSP …)', `<select name="emsp_party_id">${options(emsps.map((p) => ({ value: p.id, label: `${label(p)} · ${ROLE_LABEL[p.role] ?? p.role}` })), pre.emsp, { blank: 'Choose a party' })}</select>`, { full: true })}
      ${field('Valid from', '<input name="valid_from" type="date">', { opt: true })}
      ${field('Valid to', '<input name="valid_to" type="date">', { opt: true })}
      <fieldset class="full"><legend>Modules</legend><div class="checks">
        <label class="check"><input type="checkbox" name="allow_realtime_auth" checked> <span>Real-time authorisation</span></label>
        <label class="check"><input type="checkbox" name="allow_commands" checked> <span>Commands</span></label>
        <label class="check"><input type="checkbox" name="allow_charging_profiles" checked> <span>Charging profiles</span></label>
      </div></fieldset>
      ${field('Commercial notes', '<textarea name="notes" rows="2" maxlength="2000" style="font-family:var(--sans);font-size:13px;min-height:56px" placeholder="e.g. tariff reference, contract number"></textarea>', { full: true, opt: true })}
      <div class="field full"><label class="check"><input type="checkbox" name="activate" checked> <span><b>Active at once.</b> Off: created as a proposal, to approve later.</span></label></div>
    </div>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Create agreement', kind: 'primary',
      async onClick(ctx) {
        const v = formValues(ctx.body);
        const errs = {};
        if (!v.cpo_party_id) errs.cpo_party_id = 'Choose the CPO';
        if (!v.emsp_party_id) errs.emsp_party_id = 'Choose the service provider';
        const c = refs.party.get(v.cpo_party_id), e = refs.party.get(v.emsp_party_id);
        if (c && e && c.member_id === e.member_id) errs.emsp_party_id = 'Both parties belong to the same member: it needs no agreement with itself';
        if (Object.keys(errs).length) { fieldErrors(ctx.body, errs); return false; }
        const r = await act('/v1/hub/agreements', {
          cpo_party_id: v.cpo_party_id, emsp_party_id: v.emsp_party_id, activate: v.activate,
          allow_realtime_auth: v.allow_realtime_auth, allow_commands: v.allow_commands, allow_charging_profiles: v.allow_charging_profiles,
          valid_from: v.valid_from || undefined, valid_to: v.valid_to || undefined, notes: v.notes || undefined,
        }, (x) => `Agreement ${x.agreement.status}`);
        if (!r) return false;
        done();
      },
    }],
  });
}

function agreementMatrix(root, agreements, refs, done) {
  const live = (p) => refs.member.get(p.member_id)?.status !== 'terminated';
  const cpos = refs.parties.filter((p) => p.role === 'CPO' && live(p));
  const emsps = refs.parties.filter((p) => p.role !== 'CPO' && p.role !== 'NAP' && live(p));
  if (!cpos.length || !emsps.length) { root.innerHTML = `<div class="empty-state small">The matrix needs at least one CPO party and one service-provider party.</div>`; return; }
  const current = new Map();
  for (const a of agreements) if (a.status !== 'ended') current.set(`${a.cpo_party_id}|${a.emsp_party_id}`, a);
  const head = emsps.map((p) => `<th title="${esc(refs.member.get(p.member_id)?.legal_name ?? '')}"><span class="mono">${esc(partyKey(p))}</span><div class="cell-sub" style="text-transform:none;letter-spacing:0">${esc(ROLE_LABEL[p.role] ?? p.role)}</div></th>`).join('');
  const rows = cpos.map((c) => `<tr><td><div class="cell-title mono">${esc(partyKey(c))}</div><div class="cell-sub">${esc(refs.member.get(c.member_id)?.legal_name ?? '')}</div></td>${emsps.map((e) => {
    if (c.member_id === e.member_id) return '<td><span class="cell-sub" title="Same member: no agreement needed">same member</span></td>';
    const a = current.get(`${c.id}|${e.id}`);
    return a
      ? `<td><button class="btn sm ghost" type="button" data-ag="${esc(a.id)}" aria-label="${esc(`${partyKey(c)} and ${partyKey(e)}: ${a.status}`)}">${tag(AGREEMENT_TAG[a.status] ?? 't-mute', a.status)}</button></td>`
      : `<td><button class="btn sm ghost" type="button" data-new="${esc(c.id)}|${esc(e.id)}" title="Create an agreement" aria-label="${esc(`Create an agreement between ${partyKey(c)} and ${partyKey(e)}`)}">${icon('plus')}</button></td>`;
  }).join('')}</tr>`).join('');
  root.innerHTML = `<div class="table-wrap"><table class="t matrix hub-matrix"><thead><tr><th>CPO ↓ · provider →</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  $$('[data-ag]', root).forEach((b) => b.addEventListener('click', () => agreementDialog(agreements.find((a) => a.id === b.dataset.ag), refs, done)));
  $$('[data-new]', root).forEach((b) => b.addEventListener('click', () => {
    const [cpo, emsp] = b.dataset.new.split('|');
    newAgreementDialog(refs, { cpo, emsp }, done);
  }));
}

// ─────────────────────────────────────────── message log and trace
const legRoute = (r) => String(r ?? '').replace('+inproc', '');
const isInproc = (r) => String(r ?? '').includes('+inproc');
/** The two ends of a logged leg: a hub-originated call (alive check, ClientInfo) has no from party; an unaddressed one no to. */
const fromOf = (m) => m.from_party ?? 'hub';
const toOf = (m) => m.to_party ?? (m.leg === 'out' ? `connection ${shortId(m.connection_id)}` : 'open');
const msgError = (m) => (m.http_status != null && m.http_status >= 400) || (m.ocpi_status != null && m.ocpi_status >= 2000) || !!m.error;

/** The routing log into `root`, filtered by `q` (connection, correlation, route, party, status, module). */
async function messageLog(root, q, { compact = false } = {}) {
  let rows = [];
  let more = false;
  const qs = (extra = {}) => new URLSearchParams(Object.entries({ ...q, ...extra, limit: compact ? 50 : 100 }).filter(([, v]) => v != null && v !== '')).toString();
  const draw = () => {
    table($('[data-t]', root), {
      columns: [
        { label: 'When', render: (m) => `<span class="nowrap">${esc(fmt.timeS(m.created_at))}</span><div class="cell-sub nowrap">${esc(fmt.date(m.created_at))}</div>` },
        { label: 'Leg', render: (m) => `${tag(m.leg === 'in' ? 't-info' : 't-mute', m.leg === 'in' ? 'in' : 'out', m.leg === 'in' ? 'Request received by the hub' : 'Leg forwarded by the hub', true)}${isInproc(m.route) ? '<div class="cell-sub nowrap">in-process</div>' : ''}` },
        { label: 'From → to', render: (m) => `<span class="mono nowrap">${esc(fromOf(m))} → ${esc(toOf(m))}</span><div class="cell-sub">${esc(legRoute(m.route))}</div>` },
        { label: 'Request', render: (m) => `<span class="mono">${esc(m.method)}</span> <b>${esc(m.module ?? '')}</b><div class="cell-sub mono wrap">${esc(m.path)}</div>` },
        { label: 'Result', render: (m) => `<div class="chips">${httpTag(m.http_status)}${ocpiTag(m.ocpi_status)}</div>${m.error ? `<div class="cell-sub" style="color:var(--crit)">${esc(m.error)}</div>` : ''}` },
        { label: 'Time', num: true, render: (m) => (m.duration_ms != null ? `${fmt.num(m.duration_ms)} ms` : '—') },
      ],
      rows,
      empty: 'No messages match.',
      onRow: (m) => openTrace(m.correlation_id),
    });
    $('[data-more]', root).hidden = !more;
  };
  root.innerHTML = '<div class="card" data-t><div class="skeleton" style="margin:14px;width:40%"></div></div><div class="row" style="justify-content:center;margin-top:10px"><button class="btn sm" type="button" data-more hidden>Load older</button></div>';
  const limit = compact ? 50 : 100;
  try {
    rows = (await api(`/v1/hub/messages?${qs()}`)).messages;
  } catch (e) { $('[data-t]', root).innerHTML = callout('crit', esc(e.message)); return; }
  more = rows.length === limit;
  draw();
  $('[data-more]', root).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('busy');
    try {
      const older = (await api(`/v1/hub/messages?${qs({ before: rows[rows.length - 1]?.id })}`)).messages;
      rows = rows.concat(older);
      more = older.length === limit;
      draw();
    } catch (err) { toast(err.message, 'crit'); } finally { btn.classList.remove('busy'); }
  });
}

export function openTrace(correlationId) {
  drawer({
    title: 'Trace',
    subtitle: `<span class="mono">${esc(correlationId)}</span>`,
    headerHtml: `<div class="row" style="gap:6px;margin-top:8px"><button class="btn sm" type="button" data-copy-corr>${icon('copy')} Copy correlation id</button></div>`,
    tabs: [{
      id: 'legs', label: 'Legs',
      async render(body, ctx) {
        $('[data-copy-corr]', ctx.el)?.addEventListener('click', () => copy(correlationId));
        const { legs } = await api(`/v1/hub/messages/trace/${encodeURIComponent(correlationId)}`);
        if (!legs.length) { body.innerHTML = '<div class="empty-state">No legs for this correlation id (the log keeps 30 days).</div>'; return; }
        const t0 = new Date(legs[0].created_at).getTime();
        const anyBody = legs.some((l) => l.body_redacted != null);
        body.innerHTML = `<p class="cell-sub" style="margin:0 0 12px">Every message the hub received (in) and forwarded (out) under this X-Correlation-ID, in order. ${anyBody ? 'Bodies are shown redacted.' : 'Bodies are not logged; turn on body capture on the member\'s connection (support, at most 72 h) to see them redacted.'}</p>
          <ol class="trace">${legs.map((l) => `<li class="card${msgError(l) ? ' bad' : ''}">
            <div class="row" style="gap:8px;flex-wrap:wrap">${tag(l.leg === 'in' ? 't-info' : 't-mute', l.leg === 'in' ? 'in' : 'out', '', true)}
              <span class="mono">${esc(fromOf(l))} → ${esc(toOf(l))}</span>
              <span class="cell-sub">${esc(legRoute(l.route))}${isInproc(l.route) ? ' · in-process' : ''}</span>
              <span class="right cell-sub nowrap">+${fmt.num(new Date(l.created_at).getTime() - t0)} ms · ${esc(fmt.timeS(l.created_at))}</span></div>
            <div class="mono wrap" style="margin-top:6px"><b>${esc(l.method)}</b> ${esc(l.path)}</div>
            <div class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap">${httpTag(l.http_status)}${ocpiTag(l.ocpi_status)}${l.duration_ms != null ? `<span class="cell-sub">${fmt.num(l.duration_ms)} ms</span>` : ''}${l.bytes != null ? `<span class="cell-sub">${esc(fmt.bytes(l.bytes))}</span>` : ''}</div>
            ${l.error ? `<div class="small" style="color:var(--crit);margin-top:4px">${esc(l.error)}</div>` : ''}
            <div class="cell-sub mono" style="margin-top:4px">X-Request-ID in ${esc(l.request_id_in ?? '—')}${l.request_id_out ? ` · out ${esc(l.request_id_out)}` : ''}</div>
            ${l.body_redacted != null ? `<details style="margin-top:6px"><summary class="small" style="cursor:pointer">Body (redacted)</summary><pre class="json" style="margin-top:6px">${esc(JSON.stringify(l.body_redacted, null, 2))}</pre></details>` : ''}
          </li>`).join('')}</ol>`;
      },
    }],
  });
}

// ─────────────────────────────────────────── the view
registerView('hub', {
  title: 'Hub',
  subtitle: 'PlugSure roaming hub',
  icon: 'link',
  group: 'govern',
  order: 71,
  perm: 'platform:admin',
  when: () => state.me?.features?.hub === true,
  async render(root, [initial, param]) {
    let overview = null;
    try { overview = await api('/v1/hub/overview'); } catch (e) {
      root.innerHTML = pageHead('PlugSure Hub') + callout('crit', esc(e.status === 404 ? 'PlugSure Hub is not enabled on this platform (HUB_ENABLED).' : e.message));
      return;
    }
    const tabs = [
      { id: 'overview', label: 'Overview' },
      { id: 'members', label: 'Members' },
      { id: 'agreements', label: 'Agreements' },
      { id: 'messages', label: 'Message log' },
      { id: 'outbox', label: 'Outbox' },
      // Clearing & settlement (WP H2): only once this build has its API.
      ...(overview.modules?.clearing ? [{ id: 'clearing', label: 'Clearing' }] : []),
    ];
    root.innerHTML = pageHead(
      'PlugSure Hub',
      'The OCPI 2.2.1 roaming hub: operators and service providers connect once, to PlugSure, and roam with every member they have an agreement with.',
      `<button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button>`,
    ) + `<div class="tabs" role="tablist">${tabs.map((t) => `<button role="tab" type="button" aria-selected="false" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}</div><div data-body></div>`;
    const body = $('[data-body]', root);
    let current = tabs.find((t) => t.id === initial)?.id ?? 'overview';
    let memberToOpen = current === 'members' && /^[0-9a-f-]{36}$/i.test(param ?? '') ? param : null;
    let traceToOpen = current === 'messages' && param ? param : null;

    // ── overview
    const drawOverview = async () => {
      const [ov, health] = await Promise.all([api('/v1/hub/overview'), api('/v1/hub/health')]);
      overview = ov;
      const sum = (arr, pred = () => true) => arr.filter(pred).reduce((s, x) => s + x.n, 0);
      const mem = (s) => sum(ov.members, (x) => x.status === s);
      const par = (s) => sum(ov.parties, (x) => x.status === s);
      const ag = (s) => sum(ov.agreements, (x) => x.status === s);
      const ob = (s) => sum(ov.outbox, (x) => x.state === s);
      const reqs = sum(ov.traffic24h), errs = ov.traffic24h.reduce((s, x) => s + x.errors, 0);
      const errPct = reqs ? (errs * 100) / reqs : 0;
      const partiesTotal = sum(ov.parties);
      const countries = [...new Set([...ov.membersByCountry.map((x) => x.country_code), ...ov.partiesByCountry.map((x) => x.country_code)])].sort();
      const byC = (arr, cc, pred = () => true) => arr.filter((x) => x.country_code === cc && pred(x)).reduce((s, x) => s + x.n, 0);
      body.innerHTML = `
        <div class="grid k4" data-kpis>
          ${kpi('Members', `${fmt.num(mem('active'))}<span class="cell-sub" style="font-size:13px"> / ${fmt.num(sum(ov.members, (x) => x.status !== 'terminated'))}</span>`, `active · ${fmt.num(mem('onboarding'))} onboarding${mem('suspended') ? ` · ${fmt.num(mem('suspended'))} suspended` : ''}`)}
          ${kpi('Parties connected', `${fmt.num(par('CONNECTED'))}<span class="cell-sub" style="font-size:13px"> / ${fmt.num(partiesTotal)}</span>`, `${fmt.num(par('OFFLINE'))} offline · ${fmt.num(par('PLANNED'))} planned · ${fmt.num(par('SUSPENDED'))} suspended`, par('OFFLINE') ? 'warn' : '')}
          ${kpi('Agreements', fmt.num(ag('active')), `active · ${fmt.num(ag('proposed'))} proposed · ${fmt.num(ag('suspended'))} suspended`)}
          ${kpi('Requests, 24 h', fmt.num(reqs), `${fmt.num(errs)} errors (${fmt.pct(errPct, errPct && errPct < 1 ? 1 : 0)})`, errPct >= 10 ? 'crit' : errs ? 'warn' : '')}
          ${kpi('Outbox backlog', fmt.num(ob('pending')), `${fmt.num(ob('failed'))} failed · ${fmt.num(ob('delivered'))} delivered (14 d)`, ob('failed') ? 'crit' : '')}
        </div>
        ${ov.alerts?.length ? `<div class="card section"><header><h3>${icon('bell')} Open hub alerts</h3><span class="pill-count">${ov.alerts.length}</span></header><div data-alerts></div></div>` : ''}
        <div class="grid two section">
          <div class="card"><header><h3>By country</h3></header><div data-countries></div></div>
          <div class="card"><header><h3>Traffic, last 24 hours</h3><span class="cell-sub right">requests received</span></header><div data-traffic></div></div>
        </div>
        <div class="card section"><header><h3>Connection health</h3><span class="cell-sub right">last 15 min · p95 and 4002/4003 over 24 h</span></header><div data-health></div></div>
        <div class="card section"><header><h3>Hub endpoint</h3></header><div class="body">
          <div class="row" style="gap:8px;flex-wrap:wrap"><span class="cell-sub">Versions URL for members:</span>${ov.publicUrl ? `<code class="mono" style="word-break:break-all">${esc(`${ov.publicUrl}/hub/ocpi/versions`)}</code><button class="btn sm" type="button" data-copy-versions>${icon('copy')} Copy</button>` : tag('t-warn', 'HUB_PUBLIC_URL is not set')}</div>
          <div class="row" style="gap:6px;margin-top:10px;flex-wrap:wrap"><span class="cell-sub">Hub parties (role HUB):</span>${(ov.selfParties ?? []).map((p) => tag('t-info', `${p.country_code}*${p.party_id}`, p.business_name, true)).join(' ')}</div>
        </div></div>`;
      if (ov.alerts?.length) {
        table($('[data-alerts]', body), {
          columns: [
            { label: 'Alert', render: (a) => `${tag(a.severity === 'critical' ? 't-crit' : 't-warn', a.kind.replace('hub.', '').replace(/_/g, ' '))}<div class="cell-sub wrap" style="margin-top:4px">${esc(a.message)}</div>` },
            { label: 'Times', num: true, render: (a) => fmt.num(a.occurrences ?? 1) },
            { label: 'Last', render: (a) => `<span class="nowrap">${esc(fmt.ago(a.last_raised_at ?? a.raised_at))}</span>` },
          ],
          rows: ov.alerts,
        });
      }
      table($('[data-countries]', body), {
        columns: [
          { label: 'Country', render: (cc) => `<div class="cell-title">${esc(countryName(cc))}</div><div class="cell-sub">${esc(cc)}</div>` },
          { label: 'Members', num: true, render: (cc) => `${fmt.num(byC(ov.membersByCountry, cc, (x) => x.status === 'active'))}<span class="cell-sub"> / ${fmt.num(byC(ov.membersByCountry, cc, (x) => x.status !== 'terminated'))}</span><div class="cell-sub">active</div>` },
          { label: 'Parties', num: true, render: (cc) => `${fmt.num(byC(ov.partiesByCountry, cc))}<div class="cell-sub">${fmt.num(byC(ov.partiesByCountry, cc, (x) => x.role === 'CPO'))} CPO · ${fmt.num(byC(ov.partiesByCountry, cc, (x) => x.role !== 'CPO'))} eMSP</div>` },
          { label: 'Party status', render: (cc) => `<div class="chips">${['CONNECTED', 'OFFLINE', 'PLANNED', 'SUSPENDED'].map((st) => { const n = byC(ov.partiesByCountry, cc, (x) => x.status === st); return n ? tag(PARTY_TAG[st], `${n} ${st.toLowerCase()}`, '', true) : ''; }).join('') || '—'}</div>` },
        ],
        rows: countries,
        empty: 'No members yet.',
      });
      table($('[data-traffic]', body), {
        columns: [
          { label: 'Route', render: (t) => `<span class="mono">${esc(t.route)}</span>` },
          { label: 'Requests', num: true, render: (t) => fmt.num(t.n) },
          { label: 'Errors', num: true, render: (t) => (t.errors ? `<b style="color:var(--crit)">${fmt.num(t.errors)}</b>` : '0') },
          { label: 'Share', render: (t) => `<div class="meter" style="margin:6px 0 0;min-width:80px"><i class="${t.errors && t.errors / t.n >= 0.1 ? 'crit' : ''}" style="width:${reqs ? Math.max(2, Math.round((t.n * 100) / reqs)) : 0}%"></i></div>` },
        ],
        rows: ov.traffic24h,
        empty: 'No traffic in the last 24 hours.',
      });
      table($('[data-health]', body), {
        columns: [
          { label: 'Member', render: (c) => `<div class="cell-title" style="min-width:9rem">${esc(c.member_name)}</div><div class="cell-sub">${c.kind === 'internal' ? 'PlugSure tenant' : 'external'} · <span class="mono">${esc(shortId(c.id))}</span></div>` },
          { label: 'State', render: (c) => `${t2(CONN_TAG, c.state)}${c.alive_failures ? `<div class="cell-sub">${plural(c.alive_failures, 'failed alive check')}</div>` : ''}` },
          { label: 'Parties', render: (c) => `<div class="chips">${Object.entries(c.parties ?? {}).map(([s, n]) => tag(PARTY_TAG[s] ?? 't-mute', `${n} ${s.toLowerCase()}`, '', true)).join('') || '—'}</div>` },
          { label: 'In / out', num: true, render: (c) => `${fmt.num(c.in_15m)} / ${fmt.num(c.out_15m)}` },
          { label: 'Errors', num: true, render: (c) => (c.out_errors_15m ? `<b style="color:var(--crit)">${fmt.num(c.out_errors_15m)}</b>` : '0') },
          { label: 'p95', num: true, render: (c) => (c.out_p95_ms_24h != null ? `${fmt.num(c.out_p95_ms_24h)} ms` : '—') },
          { label: '4002 / 4003', num: true, render: (c) => `${fmt.num(c.timeouts_24h)} / ${fmt.num(c.unreachable_24h)}` },
          { label: 'Outbox', num: true, render: (c) => `${fmt.num(c.outbox_pending)}${c.outbox_failed ? ` · <b style="color:var(--crit)">${fmt.num(c.outbox_failed)} failed</b>` : ''}` },
          { label: 'Last seen', render: (c) => `<span class="nowrap">${esc(fmt.ago(c.last_inbound_at ?? c.last_alive_ok_at))}</span>${c.last_error ? `<div class="cell-sub wrap" style="color:var(--crit);max-width:260px">${esc(c.last_error)}</div>` : ''}` },
        ],
        rows: health.connections,
        empty: 'No open connections.',
        onRow: (c) => openMember(c.member_id, () => show(current)),
      });
      $('[data-copy-versions]', body)?.addEventListener('click', () => copy(`${ov.publicUrl}/hub/ocpi/versions`));
    };

    // ── members
    const memberFilters = { kind: '', status: '', q: '' };
    const drawMembers = async () => {
      body.innerHTML = `<div class="filters">
          ${field('Kind', `<select data-f="kind">${options([{ value: '', label: 'All' }, { value: 'external', label: 'External' }, { value: 'internal', label: 'PlugSure tenants' }], memberFilters.kind)}</select>`)}
          ${field('Status', `<select data-f="status">${options([{ value: '', label: 'All but terminated' }, 'onboarding', 'active', 'suspended', 'terminated'], memberFilters.status)}</select>`)}
          ${field('Search', '<input data-f="q" type="search" placeholder="Name or party (MY*ABC)" autocomplete="off">')}
          <div class="row right" style="gap:8px"><button class="btn" type="button" data-join>${icon('plus')} Join a tenant</button><button class="btn primary" type="button" data-new>${icon('plus')} New external member</button></div>
        </div><div class="card" data-t></div>`;
      $('[data-f="q"]', body).value = memberFilters.q;
      $('[data-new]', body).addEventListener('click', () => newMemberDialog((m) => { drawMembers(); openMember(m.id, () => drawMembers()); }));
      $('[data-join]', body).addEventListener('click', () => joinTenantDialog((m) => { drawMembers(); if (m?.id) openMember(m.id, () => drawMembers()); }));
      const [{ members }, { parties }] = await Promise.all([api('/v1/hub/members'), api('/v1/hub/parties')]);
      const partiesOf = new Map();
      for (const p of parties) partiesOf.set(p.member_id, [...(partiesOf.get(p.member_id) ?? []), p]);
      const draw = () => {
        const q = memberFilters.q.trim().toLowerCase();
        const rows = members.filter((m) => (!memberFilters.kind || m.kind === memberFilters.kind)
          && (memberFilters.status ? m.status === memberFilters.status : m.status !== 'terminated')
          && (!q || m.legal_name.toLowerCase().includes(q) || (partiesOf.get(m.id) ?? []).some((p) => partyKey(p).toLowerCase().includes(q))));
        table($('[data-t]', body), {
          columns: [
            { label: 'Member', render: (m) => `<div class="cell-title" style="min-width:9rem">${esc(m.legal_name)}</div><div class="cell-sub">${m.kind === 'internal' ? 'PlugSure tenant' : 'external platform'}${m.open_roaming ? ' · open roaming' : ''}</div>` },
            { label: 'Country', render: (m) => esc(countryName(m.country_code)) },
            { label: 'Status', render: (m) => t2(MEMBER_TAG, m.status) },
            { label: 'Parties', render: (m) => `<div class="chips">${(partiesOf.get(m.id) ?? []).map((p) => tag(PARTY_TAG[p.status] ?? 't-mute', `${partyKey(p)} ${ROLE_LABEL[p.role] ?? p.role}`, p.status)).join('') || '<span class="cell-sub">none yet</span>'}</div>` },
            { label: 'Connections', num: true, render: (m) => fmt.num(m.connections) },
            { label: 'Since', render: (m) => `<span class="nowrap">${esc(fmt.date(m.created_at))}</span>` },
          ],
          rows,
          empty: members.length ? 'No members match.' : 'No members yet. Create an external member or join a PlugSure tenant.',
          onRow: (m) => { history.replaceState(null, '', `#/hub/members/${m.id}`); openMember(m.id, () => drawMembers()); },
        });
      };
      draw();
      $$('select[data-f]', body).forEach((s) => s.addEventListener('change', () => { memberFilters[s.dataset.f] = s.value; draw(); }));
      $('[data-f="q"]', body).addEventListener('input', debounce((e) => { memberFilters.q = e.target.value; draw(); }, 150));
      if (memberToOpen) { const id = memberToOpen; memberToOpen = null; openMember(id, () => drawMembers()); }
    };

    // ── agreements
    let agView = 'list';
    let agStatus = '';
    const drawAgreements = async () => {
      body.innerHTML = `<div class="filters">
          <div class="field"><span class="lbl" style="font-size:12px;font-weight:600;color:var(--ink-2)">View</span><div class="seg" role="group" aria-label="View"><button type="button" data-v="list" aria-pressed="${agView === 'list'}">List</button><button type="button" data-v="matrix" aria-pressed="${agView === 'matrix'}">Matrix</button></div></div>
          ${agView === 'list' ? field('Status', `<select data-status>${options([{ value: '', label: 'Live (not ended)' }, 'proposed', 'active', 'suspended', 'ended'], agStatus)}</select>`) : ''}
          <div class="row right"><button class="btn primary" type="button" data-new>${icon('plus')} New agreement</button></div>
        </div><div class="card" data-t></div>`;
      // Controls work at once; the dialogs wait for the data they need.
      const loading = Promise.all([api('/v1/hub/agreements'), loadRefs()]);
      const redraw = () => drawAgreements();
      $$('[data-v]', body).forEach((b) => b.addEventListener('click', () => { agView = b.dataset.v; drawAgreements(); }));
      $('[data-status]', body)?.addEventListener('change', (e) => { agStatus = e.target.value; drawAgreements(); });
      $('[data-new]', body).addEventListener('click', async () => newAgreementDialog((await loading)[1], {}, redraw));
      const [{ agreements }, refs] = await loading;
      if (agView === 'matrix') agreementMatrix($('[data-t]', body), agreements, refs, redraw);
      else agreementsTable($('[data-t]', body), agreements.filter((a) => (agStatus ? a.status === agStatus : a.status !== 'ended')), refs, redraw);
    };

    // ── message log
    const msgFilters = { party: '', module: '', route: '', status: '', correlation: '' };
    const drawMessages = async () => {
      body.innerHTML = `<div class="filters">
          ${field('Party', '<input data-mf="party" placeholder="MY*ABC" autocomplete="off" style="text-transform:uppercase">')}
          ${field('Module', `<select data-mf="module">${options([{ value: '', label: 'All' }, ...MODULES], msgFilters.module)}</select>`)}
          ${field('Route', `<select data-mf="route">${options([{ value: '', label: 'All' }, ...ROUTES], msgFilters.route)}</select>`)}
          ${field('Status', `<select data-mf="status">${options([{ value: '', label: 'All' }, { value: 'error', label: 'Errors only' }, { value: 'ok', label: 'Successful' }], msgFilters.status)}</select>`)}
          ${field('Correlation id', '<input data-mf="correlation" placeholder="X-Correlation-ID" autocomplete="off" style="min-width:240px">')}
        </div>
        <p class="cell-sub" style="margin:0 0 10px">Token uids in paths are masked; bodies are not logged unless body capture is on for a connection. Click a row for every leg of its correlation id.</p>
        <div data-log></div>`;
      $('[data-mf="party"]', body).value = msgFilters.party;
      $('[data-mf="correlation"]', body).value = msgFilters.correlation;
      const draw = () => messageLog($('[data-log]', body), { ...msgFilters, party: msgFilters.party.trim().toUpperCase(), correlation: msgFilters.correlation.trim() });
      const onChange = (e) => { msgFilters[e.target.dataset.mf] = e.target.value; draw(); };
      $$('select[data-mf]', body).forEach((s) => s.addEventListener('change', onChange));
      $$('input[data-mf]', body).forEach((s) => s.addEventListener('input', debounce(onChange, 350)));
      await draw();
      if (traceToOpen) { const c = traceToOpen; traceToOpen = null; openTrace(c); }
    };

    // ── outbox
    const obFilters = { state: '', connection: '' };
    const drawOutbox = async () => {
      const [health, refs] = await Promise.all([api('/v1/hub/health'), loadRefs()]);
      body.innerHTML = `<div class="card"><header><h3>Backlog by recipient</h3><span class="cell-sub right">broadcasts, callbacks and ClientInfo the hub still has to deliver</span></header><div data-backlog></div></div>
        <div class="filters section">
          ${field('State', `<select data-of="state">${options([{ value: '', label: 'All' }, { value: 'pending', label: 'Queued' }, { value: 'failed', label: 'Failed' }, { value: 'delivered', label: 'Delivered' }, { value: 'dropped', label: 'Dropped' }], obFilters.state)}</select>`)}
          ${field('Recipient', `<select data-of="connection">${options([{ value: '', label: 'All connections' }, ...refs.connections.filter((c) => c.state !== 'closed').map((c) => ({ value: c.id, label: refs.connLabel(c.id) }))], obFilters.connection)}</select>`)}
        </div><div class="card" data-rows></div>`;
      table($('[data-backlog]', body), {
        columns: [
          { label: 'Recipient', render: (c) => `<div class="cell-title" style="min-width:9rem">${esc(c.member_name)}</div><div class="cell-sub mono">${esc(shortId(c.id))}</div>` },
          { label: 'Connection', render: (c) => t2(CONN_TAG, c.state) },
          { label: 'Queued', num: true, render: (c) => fmt.num(c.outbox_pending) },
          { label: 'Failed', num: true, render: (c) => (c.outbox_failed ? `<b style="color:var(--crit)">${fmt.num(c.outbox_failed)}</b>` : '0') },
          { label: 'Dropped, 24 h', num: true, render: (c) => fmt.num(c.outbox_dropped_24h) },
          { label: '', render: (c) => (c.outbox_failed ? `<button class="btn sm" type="button" data-replay="${esc(c.id)}">Replay failed</button>` : '') },
        ],
        rows: health.connections,
        empty: 'No open connections.',
      });
      $$('[data-replay]', body).forEach((b) => b.addEventListener('click', async () => {
        const c = health.connections.find((x) => x.id === b.dataset.replay);
        const reason = await reasonDialog({
          title: `Replay ${plural(c.outbox_failed, 'failed message')} to ${c.member_name}?`,
          message: 'They are queued again, in their original order, and retried from the first attempt. Fix the cause first (the member\'s endpoint, its token), or they fail again.',
          confirmLabel: 'Replay', reasonRequired: false,
        });
        if (reason === null) return;
        if (await act('/v1/hub/outbox/replay', { connection_id: c.id, reason: reason || undefined }, (r) => `${plural(r.replayed, 'message')} queued again`)) drawOutbox();
      }));
      const drawRows = async () => {
        const qs = new URLSearchParams(Object.entries(obFilters).filter(([, v]) => v)).toString();
        const { rows } = await api(`/v1/hub/outbox${qs ? `?${qs}` : ''}`);
        table($('[data-rows]', body), {
          columns: [
            { label: 'Queued', render: (o) => `<span class="nowrap">${esc(fmt.time(o.created_at))}</span><div class="cell-sub mono">#${esc(o.id)}</div>` },
            { label: 'What', render: (o) => `<span class="mono">${esc(o.method)}</span> <b>${esc(o.module)}</b> <span class="cell-sub">${esc(o.kind.replace('_', ' '))}</span><div class="cell-sub mono wrap">${esc(o.object_key)}</div>` },
            { label: 'To', render: (o) => { const p = refs.party.get(o.recipient_party_id); return `${p ? `<span class="mono">${esc(partyKey(p))}</span> ` : ''}<div class="cell-sub">${esc(refs.connLabel(o.recipient_connection_id))}</div>`; } },
            { label: 'State', render: (o) => `${t2(OUTBOX_TAG, o.state)}${o.state === 'pending' && o.attempts ? `<div class="cell-sub">next ${esc(fmt.timeS(o.next_attempt_at))}</div>` : ''}` },
            { label: 'Attempts', num: true, render: (o) => fmt.num(o.attempts) },
            { label: 'Last answer', render: (o) => `${o.last_status != null ? `<div class="chips">${httpTag(o.last_status)}${ocpiTag(o.last_ocpi_status)}</div>` : '—'}${o.last_error ? `<div class="cell-sub wrap" style="color:${o.state === 'failed' ? 'var(--crit)' : 'inherit'}">${esc(o.last_error)}</div>` : ''}` },
          ],
          rows,
          empty: 'Nothing in the outbox for this filter.',
          onRow: (o) => openTrace(o.correlation_id),
        });
      };
      $$('[data-of]', body).forEach((s) => s.addEventListener('change', () => { obFilters[s.dataset.of] = s.value; drawRows(); }));
      await drawRows();
    };

    const drawClearing = () => drawClearingPlatform(body, { openTrace });

    const show = async (id) => {
      current = id;
      $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
      if (!location.hash.startsWith(`#/hub/${id}/`)) history.replaceState(null, '', `#/hub/${id}`);
      body.innerHTML = '<div class="skeleton" style="height:120px"></div>';
      try {
        if (id === 'overview') await drawOverview();
        else if (id === 'members') await drawMembers();
        else if (id === 'agreements') await drawAgreements();
        else if (id === 'messages') await drawMessages();
        else if (id === 'outbox') await drawOutbox();
        else await drawClearing();
      } catch (e) {
        if (body.isConnected) body.innerHTML = callout('crit', esc(e.message));
      }
    };
    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    $('[data-refresh]', root).addEventListener('click', () => show(current));
    await show(current);
  },
});

