import { $, $$, esc, api, state, registerView, pageHead, icon, callout, table, fmt, tag, kpi, toast, download, copy } from '../core.js';

/**
 * Onboarding — bringing new chargers onto PlugSure.
 *
 *   In progress            chargers registered recently and where each one is
 *   Certificates           every charger's client certificate (Security Profile 3)
 *   Certificate authority  the CA that issues them, for the TLS terminator
 *
 * "Add charge point" opens the wizard (#/onboard): hardware details, site,
 * security (with automatic certificates), connectors, then it watches the
 * charger connect.
 */

const STAGE = {
  waiting: ['t-info', 'waiting for first connection'],
  registered: ['t-info', 'registered'],
  refused: ['t-crit', 'refused at handshake'],
  awaiting_activation: ['t-warn', 'connected — activate it'],
  certificate_in_progress: ['t-info', 'getting its certificate'],
  needs_certificate: ['t-crit', 'Profile 3 without a certificate'],
  connected: ['t-ok', 'connected'],
};
const SOURCE = {
  plugsure_ca: 'PlugSure CA · key generated at onboarding',
  plugsure_ca_csr: 'PlugSure CA · charger\'s own key (CSR)',
  ocpp_csr: 'PlugSure CA · issued over OCPP',
  vault: 'Vault PKI',
  external: 'your own certificate',
};
const daysLeft = (t) => (t ? Math.floor((new Date(t).getTime() - Date.now()) / 86_400_000) : null);

registerView('onboarding', {
  title: 'Onboarding',
  icon: 'plus',
  group: 'operate',
  order: 4,
  perm: 'charge_point:read',
  async render(root, [tabParam]) {
    const canAdd = state.can('charge_point:write');
    root.innerHTML = pageHead(
      'Onboarding',
      'Connect new chargers to PlugSure: enter the hardware details, and the wizard registers the charger, issues its credentials — an authorization key, or a client certificate issued automatically by PlugSure\'s certificate authority — and watches it connect.',
      canAdd ? `<a class="btn primary" href="#/onboard">${icon('plus')} Add charge point</a>` : '',
    ) + `<div class="tabs" role="tablist"><button type="button" data-tab="progress">In progress</button><button type="button" data-tab="certificates">Certificates</button><button type="button" data-tab="ca">Certificate authority</button></div><div data-body></div>`;
    const body = $('[data-body]', root);
    let timer = null;
    const show = (t) => {
      clearInterval(timer);
      $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
      history.replaceState(null, '', `#/onboarding/${t}`);
      if (t === 'progress') { renderProgress(body); timer = setInterval(() => renderProgress(body, true), 10_000); }
      else if (t === 'certificates') renderCertificates(body);
      else renderCa(body);
    };
    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    show(['progress', 'certificates', 'ca'].includes(tabParam) ? tabParam : 'progress');
    return () => clearInterval(timer);
  },
});

// ─────────────────────────────────────────── in progress

async function renderProgress(box, quiet = false) {
  const r = await api('/v1/onboarding').catch((e) => { if (!quiet) toast(e.message, 'crit'); return null; });
  if (!r || !box.isConnected) return;
  const c = r.counts;
  box.innerHTML = `
    <div class="grid k4" style="margin-bottom:16px">
      ${kpi('Registered (90 days)', fmt.num(c.total))}
      ${kpi('Connected', fmt.num(c.connected))}
      ${kpi('Waiting to connect', fmt.num(c.waiting), c.refused ? `<span style="color:var(--crit)">${fmt.num(c.refused)} refused at handshake</span>` : 'none refused')}
      ${kpi('Certificates in progress', fmt.num(c.certificateInProgress), c.needsCertificate ? `<span style="color:var(--crit)">${fmt.num(c.needsCertificate)} on Profile 3 without one</span>` : '')}
    </div>
    <div class="card section" data-list></div>`;
  table($('[data-list]', box), {
    columns: [
      { label: 'Charger', render: (x) => `<div class="cell-title">${esc(x.display_name || x.ocpp_identity)}</div><div class="cell-sub mono">${esc(x.ocpp_identity)} · ${esc(x.site_name)}</div>` },
      { label: 'Hardware', render: (x) => `${esc([x.vendor, x.model].filter(Boolean).join(' ') || '—')}<div class="cell-sub mono">${esc(x.serial ?? '')}</div>` },
      { label: 'Security', render: (x) => `Profile ${esc(x.security_profile)}<div class="cell-sub">${x.has_certificate ? `certificate${x.client_cert_not_after ? ` until ${esc(fmt.date(x.client_cert_not_after))}` : ''}` : x.cert_auto_upgrade ? 'certificate over OCPP' : x.has_key ? 'authorization key' : 'no credential'}</div>` },
      { label: 'Stage', render: (x) => { const [cls, l] = STAGE[x.stage] ?? ['t-mute', x.stage]; return `${tag(cls, l)}${x.stage === 'refused' && x.last_attempt ? `<div class="cell-sub">${esc(x.last_attempt.outcome)}${x.last_attempt.detail ? ` — ${esc(String(x.last_attempt.detail).slice(0, 80))}` : ''}</div>` : ''}`; } },
      { label: 'Last seen', render: (x) => (x.online ? tag('t-ok', 'online') : `<span class="cell-sub">${x.last_seen_at ? esc(fmt.ago(x.last_seen_at)) : 'never'}</span>`) },
      { label: 'Registered', render: (x) => esc(fmt.date(x.created_at)) },
    ],
    rows: r.chargers,
    empty: 'No chargers registered in the last 90 days. Use “Add charge point” to onboard one.',
    onRow: (x) => { location.hash = `#/chargers/${encodeURIComponent(x.ocpp_identity)}`; },
  });
}

// ─────────────────────────────────────────── certificates

async function renderCertificates(box) {
  const canCmd = state.can('charge_point:command');
  box.innerHTML = `<p class="cell-sub" style="margin:0 0 12px">Chargers on Security Profile 3 authenticate with a client certificate instead of a password. Certificates from PlugSure's CA are renewed over OCPP ${esc('30')} days before they expire, with an alert two weeks before.</p><div class="card section" data-list></div>`;
  const load = async () => {
    const { certificates } = await api('/v1/station-certificates');
    table($('[data-list]', box), {
      columns: [
        { label: 'Charger', render: (x) => `<div class="cell-title">${esc(x.display_name || x.ocpp_identity)}</div><div class="cell-sub mono">${esc(x.ocpp_identity)} · ${esc(x.site_name)}</div>` },
        { label: 'Profile', render: (x) => `Profile ${esc(x.security_profile)}${x.cert_auto_upgrade ? `<div class="cell-sub">moving to 3</div>` : ''}` },
        { label: 'Certificate', render: (x) => (x.bound ? `${esc(SOURCE[x.source] ?? 'bound')}<div class="cell-sub mono">${esc(x.serial ?? '')}</div>` : x.last_request ? `<span class="cell-sub">requested ${esc(fmt.ago(x.last_request.requested_at))}</span>` : '<span class="cell-sub">none</span>') },
        { label: 'Valid until', render: (x) => { const d = daysLeft(x.not_after); if (!x.not_after) return '—'; return `${esc(fmt.date(x.not_after))}${d != null && d <= 30 ? ` ${tag(d <= 7 ? 't-crit' : 't-warn', d <= 0 ? 'expired' : `${d} days`)}` : ''}${x.rotating ? `<div class="cell-sub">new certificate installed; old one accepted until used</div>` : ''}`; } },
        { label: 'Latest request', render: (x) => (x.last_request ? `${tag(x.last_request.state === 'delivered' || x.last_request.state === 'issued' ? 't-ok' : x.last_request.state === 'rejected' || x.last_request.state === 'failed' ? 't-crit' : 't-info', x.last_request.state)}${x.last_request.error ? `<div class="cell-sub">${esc(x.last_request.error)}</div>` : ''}` : '—') },
        ...(canCmd ? [{ label: '', render: (x) => (x.online ? `<button class="btn sm" type="button" data-renew="${esc(x.ocpp_identity)}">Renew over OCPP</button>` : '<span class="cell-sub">offline</span>') }] : []),
      ],
      rows: certificates,
      empty: 'No charger uses a client certificate yet.',
    });
    $$('[data-renew]', box).forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      b.disabled = true;
      try {
        const r = await api(`/v1/charge-points/${encodeURIComponent(b.dataset.renew)}/certificate/request`, { method: 'POST' });
        toast(r.status === 'Accepted' ? 'The charger is sending its certificate request' : `The charger answered ${r.status ?? 'nothing'}`, r.status === 'Accepted' ? 'ok' : 'warn');
        setTimeout(load, 3000);
      } catch (err) { toast(err.message, 'crit'); b.disabled = false; }
    }));
  };
  await load();
}

// ─────────────────────────────────────────── certificate authority

async function renderCa(box) {
  const ca = await api('/v1/charger-ca');
  box.innerHTML = `
    <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start">
      <div class="card section"><h3 style="margin-top:0">Charging-station CA</h3>
        <dl class="kv">
          <dt>Subject</dt><dd data-f="subject"></dd>
          <dt>SHA-256</dt><dd class="mono small" data-f="fingerprint" style="word-break:break-all"></dd>
          <dt>Valid until</dt><dd>${esc(fmt.date(ca.notAfter))}</dd>
          <dt>Source</dt><dd>${ca.source === 'file' ? 'your own CA (CHARGER_CA_CERT_FILE)' : 'created by PlugSure; its key is sealed with SECRETS_KEY'}</dd>
          <dt>Charger certificates</dt><dd>valid ${esc(fmt.num(ca.certificateDays))} days by default</dd>
          <dt>OCPP host root</dt><dd>${ca.csmsRootPem ? 'configured — included in onboarding bundles as csms-root.pem' : 'public CA — chargers need its root (e.g. ISRG Root X1 for Let\'s Encrypt)'}</dd>
        </dl>
        <div class="row" style="margin-top:12px;gap:8px"><button class="btn" type="button" data-dl>${icon('download')} plugsure-charger-ca.pem</button><button class="btn" type="button" data-copy>Copy PEM</button></div>
      </div>
      <div class="card section"><h3 style="margin-top:0">How chargers get certificates</h3>
        <ol style="margin:0;padding-left:18px;display:grid;gap:8px">
          <li><b>Generated at onboarding</b> — PlugSure makes the key and certificate; download the bundle once and load it onto the charger.</li>
          <li><b>Charger's own request (CSR)</b> — paste the CSR from the charger's web page; the key never leaves the charger.</li>
          <li><b>Over OCPP, zero-touch</b> — the charger connects on Profile 2; PlugSure asks for its CSR, signs it, installs it with CertificateSigned and moves it to Profile 3. Needs chargers with the OCPP security extension.</li>
        </ol>
        <p class="cell-sub" style="margin:10px 0 0">Every certificate is bound to one charger by its fingerprint, and its CN is the charger's OCPP identity.</p>
      </div>
    </div>
    <div class="card section" style="margin-top:16px"><h3 style="margin-top:0">TLS terminator</h3>
      ${callout('info', 'Chargers on Profile 3 present their certificate in the TLS handshake, so whatever terminates TLS for the OCPP host must trust this CA and pass the certificate\'s fingerprint on.')}
      <p style="margin:12px 0 6px"><b>Caddy</b> — save the CA as <span class="mono">/etc/caddy/plugsure-charger-ca.pem</span> and add to the OCPP site (see deploy/Caddyfile):</p>
      <pre class="code" data-caddy style="white-space:pre-wrap"></pre>
      <p class="cell-sub" style="margin:8px 0 0" data-gw></p>
    </div>`;
  $('[data-f=subject]', box).textContent = ca.subject;
  $('[data-f=fingerprint]', box).textContent = ca.fingerprint;
  $('[data-caddy]', box).textContent = ca.proxy.caddy;
  $('[data-gw]', box).textContent = ca.proxy.gateway;
  $('[data-dl]', box).addEventListener('click', () => download('plugsure-charger-ca.pem', ca.certificatePem, 'application/x-pem-file'));
  $('[data-copy]', box).addEventListener('click', () => copy(ca.certificatePem));
}
