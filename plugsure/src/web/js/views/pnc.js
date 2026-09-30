import { $, $$, esc, api, state, registerView, pageHead, icon, field, callout, table, fmt, tag, kpi, modal, confirmDialog, toast, formValues } from '../core.js';

/**
 * Plug & Charge (ISO 15118): the car identifies itself with its contract
 * certificate, so the driver just plugs in. The CSMS checks the contract,
 * gets chargers' V2G certificates signed by the PKI, and keeps the chargers'
 * trust stores filled.
 */

const TABS = ['overview', 'contracts', 'chargers', 'anchors', 'log'];
const KIND_LABEL = { V2GRootCertificate: 'V2G root', MORootCertificate: 'Mobility operator root', V2GCertificateChain: 'Charger V2G chain' };
const daysLeft = (t) => (t ? Math.floor((new Date(t).getTime() - Date.now()) / 86_400_000) : null);

registerView('pnc', {
  title: 'Plug & Charge',
  icon: 'key',
  group: 'operate',
  order: 5,
  perm: 'charge_point:read',
  async render(root, [tabParam]) {
    root.innerHTML = pageHead(
      'Plug & Charge',
      'ISO 15118: the car proves its charging contract with a certificate, so the driver only plugs in. The contract is then treated like a card — status, limits, fleet account and membership apply.',
      '',
    ) + `<div class="tabs" role="tablist">${[['overview', 'Overview'], ['contracts', 'Contracts'], ['chargers', 'Chargers'], ['anchors', 'Trust anchors'], ['log', 'Log']].map(([k, l]) => `<button type="button" data-tab="${k}">${l}</button>`).join('')}</div><div data-body></div>`;
    const body = $('[data-body]', root);
    const show = (t) => {
      $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
      history.replaceState(null, '', `#/pnc/${t}`);
      ({ overview: renderOverview, contracts: renderContracts, chargers: renderChargers, anchors: renderAnchors, log: renderLog }[t])(body, show);
    };
    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    show(TABS.includes(tabParam) ? tabParam : 'overview');
  },
});

// ─────────────────────────────────────────── overview

async function renderOverview(box, show) {
  const o = await api('/v1/pnc');
  const c = o.counts ?? {};
  const canOrg = state.can('org:write');
  const steps = [
    [o.pki.problem == null, 'A V2G PKI is connected', o.pki.problem ?? o.pki.description],
    [c.trust_anchors > 0, 'Trust anchors are in place', c.trust_anchors ? `${fmt.num(c.trust_anchors)} root certificates` : 'Fetch them from the PKI or add them under Trust anchors.', 'anchors'],
    [c.chargers > 0, 'Chargers are switched on', c.chargers ? `${fmt.num(c.chargers)} chargers with Plug & Charge` : 'Switch it on per charger, install the roots and request its certificate.', 'chargers'],
    [c.contracts > 0, 'Contracts are registered', c.contracts ? `${fmt.num(c.active_contracts)} active of ${fmt.num(c.contracts)}` : 'Register your customers\' eMAIDs, or accept partners\' through roaming.', 'contracts'],
    [o.settings.enabled, 'Plug & Charge is on', o.settings.enabled ? 'Cars with a valid contract can charge.' : 'Contracts are refused until you switch it on.'],
  ];
  box.innerHTML = `
    <div class="grid k4" style="margin-bottom:16px">
      ${kpi('Status', o.settings.enabled ? tag('t-ok', 'on') : tag('t-mute', 'off'), esc(o.pki.mode === 'mock' ? 'test PKI' : o.pki.mode === 'http' ? 'PKI gateway' : 'no PKI'))}
      ${kpi('Contracts', fmt.num(c.active_contracts), `${fmt.num(c.contracts)} registered`)}
      ${kpi('Chargers', fmt.num(c.chargers), 'with Plug & Charge on')}
      ${kpi('Authorisations (30 days)', fmt.num(c.authorizations_30d), `${fmt.num(c.accepted_30d)} accepted`)}
    </div>
    ${o.pki.mode === 'mock' ? callout('warn', '<b>Test PKI.</b> Certificates come from PlugSure\'s built-in test PKI — for development and sandboxes only. Production needs your V2G PKI provider (PNC_PKI=http).') : ''}
    ${o.pki.problem && o.pki.mode !== 'mock' ? callout('warn', esc(o.pki.problem)) : ''}
    <div class="grid" style="grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:16px;align-items:start">
      <div class="card section"><h3 style="margin-top:0">Set-up</h3>
        <ol class="plain" style="padding-left:0;list-style:none;display:grid;gap:10px;margin:0">
          ${steps.map(([ok, t, d, tab]) => `<li style="display:flex;gap:10px;align-items:flex-start"><span style="color:var(${ok ? '--accent' : '--warn'});display:inline-flex;width:18px;height:18px;flex:none;margin-top:1px">${icon(ok ? 'check' : 'warn').replace('<svg ', '<svg width="18" height="18" ')}</span><div><b>${esc(t)}</b><div class="cell-sub">${esc(d ?? '')}${tab ? ` · <a href="#/pnc/${tab}" data-go="${tab}">open</a>` : ''}</div></div></li>`).join('')}
        </ol>
      </div>
      <div class="card section"><h3 style="margin-top:0">Settings</h3>
        <form data-settings class="form" style="grid-template-columns:1fr">
          <div class="field full"><label class="check"><input type="checkbox" name="enabled"${o.settings.enabled ? ' checked' : ''}${canOrg ? '' : ' disabled'}> <span>Plug & Charge on</span></label></div>
          <div class="field full"><label class="check"><input type="checkbox" name="acceptWhenOcspUnavailable"${o.settings.acceptWhenOcspUnavailable ? ' checked' : ''}${canOrg ? '' : ' disabled'}> <span>Accept a contract when its OCSP responder cannot be reached</span></label>
            <div class="help">The charger has already checked the certificate chain. Off: the car is refused until the responder answers.</div></div>
          <div class="field full"><div class="cell-sub">PKI: ${esc(o.pki.description)}</div></div>
          ${canOrg ? '<div><button class="btn primary" type="submit">Save</button></div>' : ''}
        </form>
      </div>
    </div>`;
  $$('[data-go]', box).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); show(a.dataset.go); }));
  $('[data-settings]', box).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/v1/pnc/settings', { method: 'PUT', body: formValues(e.target) }); toast('Saved', 'ok'); renderOverview(box, show); }
    catch (err) { toast(err.message, 'crit'); }
  });
}

// ─────────────────────────────────────────── contracts

async function renderContracts(box) {
  const canWrite = state.can('token:write');
  box.innerHTML = `<div class="filters"><div class="grow cell-sub">A contract works like a card: blocking it, its limits, its fleet account and memberships all apply. Partners' contracts arrive through roaming.</div>${canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} Register contract</button>` : ''}</div><div class="card section" data-list></div>`;
  const load = async () => {
    const { contracts } = await api('/v1/pnc/contracts');
    table($('[data-list]', box), {
      columns: [
        { label: 'eMAID', render: (c) => `<div class="cell-title mono">${esc(c.emaid_display)}</div><div class="cell-sub">${esc(c.holder_name ?? '—')}</div>` },
        { label: 'Billed to', render: (c) => (c.account_type === 'fleet' ? `Fleet · ${esc(c.fleet_name ?? '')}` : 'Driver (retail)') },
        { label: 'Status', render: (c) => (c.status === 'Accepted' ? (c.valid_to && new Date(c.valid_to) < new Date() ? tag('t-warn', 'expired') : tag('t-ok', 'active')) : tag('t-mute', 'cancelled')) },
        { label: 'Sessions', num: true, render: (c) => `${fmt.num(c.sessions)}<div class="cell-sub">${c.last_used ? esc(fmt.ago(c.last_used)) : 'never used'}</div>` },
        { label: 'Registered', render: (c) => esc(fmt.date(c.created_at)) },
      ],
      rows: contracts,
      empty: 'No contracts yet.',
      onRow: canWrite ? (c) => act(c) : null,
    });
  };
  const act = async (c) => {
    const cancel = c.status === 'Accepted';
    const ok = await confirmDialog({
      title: `${cancel ? 'Cancel' : 'Reactivate'} ${c.emaid_display}`,
      message: cancel ? 'The car is refused from its next plug-in (certificate status ContractCancelled). Sessions already running continue.' : 'The car can charge again.',
      confirmLabel: cancel ? 'Cancel contract' : 'Reactivate', danger: cancel,
    });
    if (!ok) return;
    try { await api(`/v1/pnc/contracts/${c.id}/${cancel ? 'cancel' : 'reactivate'}`, { method: 'POST' }); toast('Saved', 'ok'); load(); }
    catch (e) { toast(e.message, 'crit'); }
  };
  $('[data-add]', box)?.addEventListener('click', () => modal({
    title: 'Register contract', size: 'md',
    body: `<div class="form">
      ${field('eMAID', '<input name="emaid" placeholder="ID-PLS-C12345678-9" autocomplete="off" style="text-transform:uppercase">', { full: true, help: 'Country, provider, 9-character contract, optional check character. Separators optional.' })}
      ${field('Holder', '<input name="holderName">', { opt: true })}
      ${field('Billed to', '<select name="accountType"><option value="retail">Driver (retail)</option><option value="fleet">Fleet account</option></select>')}
      ${field('Fleet (company)', '<input name="fleetName" placeholder="PT Armada Hijau">', { opt: true, help: 'For fleet contracts: billed on this company\'s monthly fleet invoice.' })}
      ${field('Valid until', '<input name="validTo" type="date">', { opt: true })}
    </div>`,
    actions: [{ label: 'Cancel' }, { label: 'Register', kind: 'primary', async onClick(ctx) {
      const v = formValues(ctx.body);
      try { await api('/v1/pnc/contracts', { method: 'POST', body: { ...v, validTo: v.validTo ? new Date(`${v.validTo}T23:59:59+07:00`).toISOString() : undefined } }); toast('Registered', 'ok'); load(); }
      catch (e) { toast(e.message, 'crit'); return false; }
    } }],
  }));
  await load();
}

// ─────────────────────────────────────────── chargers

function certCell(c) {
  if (!c.cert_state) return `${tag('t-mute', 'none')}<div class="cell-sub">not requested</div>`;
  const d = daysLeft(c.cert_not_after);
  if (c.cert_state === 'delivered') {
    const cls = d == null ? 't-ok' : d <= 7 ? 't-crit' : d <= 30 ? 't-warn' : 't-ok';
    return `${tag(cls, d != null && d <= 0 ? 'expired' : 'installed')}<div class="cell-sub">until ${esc(fmt.date(c.cert_not_after))}${d != null && d > 0 && d <= 30 ? ` · ${d} days` : ''}</div>`;
  }
  const label = { requested: 'signing', signed: 'sending', rejected: 'refused by charger', failed: 'signing failed' }[c.cert_state] ?? c.cert_state;
  return `${tag(c.cert_state === 'failed' || c.cert_state === 'rejected' ? 't-crit' : 't-info', label)}${c.cert_error ? `<div class="cell-sub">${esc(c.cert_error)}</div>` : ''}`;
}

async function renderChargers(box) {
  box.innerHTML = `<div class="card section" data-list></div>`;
  const load = async () => {
    const { chargers } = await api('/v1/pnc/chargers');
    table($('[data-list]', box), {
      columns: [
        { label: 'Charger', render: (c) => `<div class="cell-title">${esc(c.display_name || c.ocpp_identity)}</div><div class="cell-sub mono">${esc(c.ocpp_identity)} · ${esc(c.site_name)}</div>` },
        { label: 'OCPP', render: (c) => esc(c.ocpp_version === 'ocpp2.1' ? '2.1' : c.ocpp_version === 'ocpp2.0.1' ? '2.0.1' : '1.6 (DataTransfer)') },
        { label: 'Plug & Charge', render: (c) => (c.pnc_enabled ? tag('t-ok', 'on') : tag('t-mute', 'off')) },
        { label: 'V2G certificate', render: certCell },
        { label: 'Trust store', render: (c) => (c.pnc_installed_at ? `${fmt.num((c.pnc_installed ?? []).length)} certificates<div class="cell-sub">read ${esc(fmt.ago(c.pnc_installed_at))}</div>` : '<span class="cell-sub">not read</span>') },
      ],
      rows: chargers,
      empty: 'No chargers.',
      onRow: (c) => manage(c, load),
    });
  };
  await load();
}

function manage(c, reload) {
  const canCmd = state.can('charge_point:command');
  const canCfg = state.can('charge_point:config');
  const installed = Array.isArray(c.pnc_installed) ? c.pnc_installed : [];
  const m = modal({
    title: c.display_name || c.ocpp_identity, subtitle: `${c.ocpp_identity} · Plug & Charge`, size: 'lg',
    body: `
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:14px">
        ${canCfg ? `<button class="btn" type="button" data-do="toggle">${c.pnc_enabled ? 'Switch Plug & Charge off' : 'Switch Plug & Charge on'}</button>` : ''}
        ${canCmd ? '<button class="btn" type="button" data-do="roots">Install trust anchors</button>' : ''}
        ${canCmd ? '<button class="btn" type="button" data-do="cert">Request V2G certificate</button>' : ''}
        ${canCmd ? '<button class="btn" type="button" data-do="read">Read installed certificates</button>' : ''}
      </div>
      <div data-out></div>
      <h3>V2G certificate</h3>
      <div class="cell-sub">${c.cert_subject ? `${esc(c.cert_subject)} · serial <span class="mono">${esc(c.cert_serial ?? '')}</span>` : 'None yet: install the trust anchors, then request one.'}</div>
      <div style="margin-top:6px">${certCell(c)}</div>
      <h3>Installed on the charger</h3>
      <div data-installed>${installedTable(installed, canCmd)}</div>
      <p class="cell-sub" style="margin-top:12px">Certificates are renewed automatically ${esc('30')} days before they expire, for chargers with Plug & Charge on.</p>`,
    actions: [{ label: 'Close' }],
    onClose: reload,
  });
  const out = $('[data-out]', m.body ?? document);
  const say = (kind, html) => { if (out) out.innerHTML = callout(kind, html); };
  const run = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { say('warn', esc(e.message)); } finally { btn.disabled = false; } };
  const root = m.body ?? document;
  $$('[data-do]', root).forEach((b) => b.addEventListener('click', () => run(b, async () => {
    const id = encodeURIComponent(c.ocpp_identity);
    if (b.dataset.do === 'toggle') {
      const r = await api(`/v1/pnc/chargers/${id}/enable`, { method: 'POST', body: { enabled: !c.pnc_enabled } });
      c.pnc_enabled = r.pncEnabled; b.textContent = c.pnc_enabled ? 'Switch Plug & Charge off' : 'Switch Plug & Charge on';
      say('ok', `Plug & Charge ${r.pncEnabled ? 'on' : 'off'}. Charger: ${esc(r.charger ?? '—')}`);
    } else if (b.dataset.do === 'roots') {
      const r = await api(`/v1/pnc/chargers/${id}/install-roots`, { method: 'POST', body: {} });
      say(r.results.every((x) => x.status === 'Accepted') ? 'ok' : 'warn', r.results.map((x) => `${esc(KIND_LABEL[x.kind] ?? x.kind)}: <b>${esc(x.status ?? 'no answer')}</b> — ${esc(x.subject)}`).join('<br>'));
    } else if (b.dataset.do === 'cert') {
      const r = await api(`/v1/pnc/chargers/${id}/request-certificate`, { method: 'POST' });
      say(r.status === 'Accepted' ? 'ok' : 'warn', r.status === 'Accepted' ? 'The charger is sending its signing request. The certificate appears here once the PKI has signed it and the charger has accepted it.' : `The charger answered <b>${esc(r.status ?? 'nothing')}</b>.`);
    } else if (b.dataset.do === 'read') {
      const r = await api(`/v1/pnc/chargers/${id}/read-installed`, { method: 'POST' });
      $('[data-installed]', root).innerHTML = installedTable(r.certificates, canCmd);
      bindDeletes();
      say('ok', `The charger reports ${fmt.num(r.certificates.length)} certificates.`);
    }
  })));
  const bindDeletes = () => $$('[data-del]', root).forEach((b) => b.addEventListener('click', async () => {
    const h = JSON.parse(b.dataset.del);
    if (!(await confirmDialog({ title: 'Delete certificate', message: `Delete serial ${h.serialNumber} from ${c.ocpp_identity}?`, confirmLabel: 'Delete', danger: true }))) return;
    await run(b, async () => {
      const r = await api(`/v1/pnc/chargers/${encodeURIComponent(c.ocpp_identity)}/delete-certificate`, { method: 'POST', body: { certificateHashData: h } });
      say(r.status === 'Accepted' ? 'ok' : 'warn', `The charger answered <b>${esc(r.status ?? 'nothing')}</b>.`);
    });
  }));
  bindDeletes();
}

function installedTable(list, canCmd) {
  if (!list.length) return '<div class="cell-sub">Not read yet, or none installed.</div>';
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Type</th><th>Serial</th><th>Issuer key hash</th>${canCmd ? '<th></th>' : ''}</tr></thead><tbody>${list.map((x) => {
    const h = x.certificateHashData ?? {};
    return `<tr><td>${esc(KIND_LABEL[x.certificateType] ?? x.certificateType ?? '')}</td><td class="mono">${esc(h.serialNumber ?? '')}</td><td class="mono cell-sub">${esc(String(h.issuerKeyHash ?? '').slice(0, 16))}…</td>${canCmd ? `<td><button class="btn sm" type="button" data-del='${esc(JSON.stringify(h))}'>Delete</button></td>` : ''}</tr>`;
  }).join('')}</tbody></table></div>`;
}

// ─────────────────────────────────────────── trust anchors

async function renderAnchors(box) {
  const canOrg = state.can('org:write');
  box.innerHTML = `<div class="filters"><div class="grow cell-sub">Installed on chargers with “Install trust anchors”. Contract chains the CSMS checks itself must lead to one of the mobility operator roots.</div>
    ${canOrg ? `<button class="btn" type="button" data-sync>${icon('refresh')} Fetch from the PKI</button><button class="btn primary" type="button" data-add>${icon('plus')} Add certificate</button>` : ''}</div><div class="card section" data-list></div>`;
  const load = async () => {
    const { anchors } = await api('/v1/pnc/trust-anchors');
    table($('[data-list]', box), {
      columns: [
        { label: 'Certificate', render: (a) => `<div class="cell-title">${esc(a.subject)}</div><div class="cell-sub mono">${esc(a.fingerprint.slice(0, 32))}…</div>` },
        { label: 'Type', render: (a) => esc(KIND_LABEL[a.kind] ?? a.kind) },
        { label: 'Valid until', render: (a) => { const d = daysLeft(a.not_after); return `${esc(fmt.date(a.not_after))}${d != null && d < 90 ? ` ${tag('t-warn', `${d} days`)}` : ''}`; } },
        { label: 'Source', render: (a) => (a.source === 'pki' ? 'PKI' : 'uploaded') },
      ],
      rows: anchors,
      empty: 'No trust anchors yet.',
      onRow: canOrg ? async (a) => {
        if (!(await confirmDialog({ title: 'Remove trust anchor', message: `Remove ${a.subject} from the list? It stays on chargers until you delete it there.`, confirmLabel: 'Remove', danger: true }))) return;
        try { await api(`/v1/pnc/trust-anchors/${a.id}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message, 'crit'); }
      } : null,
    });
  };
  $('[data-sync]', box)?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { const r = await api('/v1/pnc/trust-anchors/sync', { method: 'POST' }); toast(`${r.received} certificates received`, 'ok'); load(); }
    catch (err) { toast(err.message, 'crit'); } finally { e.target.disabled = false; }
  });
  $('[data-add]', box)?.addEventListener('click', () => modal({
    title: 'Add trust anchor', size: 'md',
    body: `<div class="form">${field('Type', '<select name="kind"><option value="V2GRootCertificate">V2G root</option><option value="MORootCertificate">Mobility operator root</option></select>', { full: true })}
      ${field('Certificate (PEM)', '<textarea name="pem" rows="8" class="mono" placeholder="-----BEGIN CERTIFICATE-----"></textarea>', { full: true })}</div>`,
    actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', async onClick(ctx) {
      try { await api('/v1/pnc/trust-anchors', { method: 'POST', body: formValues(ctx.body) }); toast('Added', 'ok'); load(); }
      catch (e) { toast(e.message, 'crit'); return false; }
    } }],
  }));
  await load();
}

// ─────────────────────────────────────────── log

const OUTCOME_CLS = (o) => (/^accepted|delivered|good|^on$/.test(o) ? 't-ok' : /refused|rejected|failed|revoked|unknown_contract|bad_emaid|disabled/.test(o) ? 't-crit' : /unavailable|not_delivered/.test(o) ? 't-warn' : 't-info');

async function renderLog(box) {
  box.innerHTML = `<div class="card section" data-list></div>`;
  const { events } = await api('/v1/pnc/events?limit=200');
  table($('[data-list]', box), {
    columns: [
      { label: 'When', render: (e) => esc(fmt.time(e.created_at)) },
      { label: 'Charger', render: (e) => `<span class="mono">${esc(e.ocpp_identity ?? '—')}</span>` },
      { label: 'Message', render: (e) => `${esc(e.action)}${e.emaid ? `<div class="cell-sub mono">${esc(e.emaid)}</div>` : ''}` },
      { label: 'Outcome', render: (e) => tag(OUTCOME_CLS(e.outcome), e.outcome.replace(/_/g, ' ')) },
      { label: 'Detail', render: (e) => `<div class="cell-sub">${esc(detailText(e.detail))}</div>` },
    ],
    rows: events,
    empty: 'Nothing yet. Every Plug & Charge exchange with a charger or the PKI is listed here.',
  });
}

function detailText(d) {
  if (!d) return '';
  const parts = [];
  if (d.certificateStatus) parts.push(`certificate ${d.certificateStatus}`);
  if (d.idTokenInfo) parts.push(`contract ${d.idTokenInfo}`);
  if (d.reason) parts.push(d.reason);
  if (d.subject) parts.push(d.subject);
  if (d.serial) parts.push(`serial ${d.serial}`);
  if (d.certificateType) parts.push(d.certificateType);
  if (Array.isArray(d.ocsp) && d.ocsp.length) parts.push(`OCSP ${d.ocsp.map((x) => x.status).join(', ')}`);
  return parts.join(' · ');
}
