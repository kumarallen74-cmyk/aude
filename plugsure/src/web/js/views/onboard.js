import {
  $, $$, esc, el, api, state, registerView, pageHead, tag, icon, fmt, modal, field, options, formValues,
  toast, callout, navigate, sites as loadSites, download, copy,
} from '../core.js';
import { openSiteModal } from './sites.js';

/**
 * Module 1 — Asset Management & Zero-Touch Onboarding Wizard.
 *
 *   1 Identity & hardware   2 Site   3 Security   4 EVSE & connectors   5 Review & commissioning test
 *
 * Nothing is written until step 5, where the wizard registers the charger,
 * issues its credentials, raises the security profile in the safe order (key
 * first, then profile), activates it and listens for its BootNotification.
 */

const PLUG_ICON = { cCCS2: 'ccs2', sType2: 'type2', cType2: 'type2', cChaDeMo: 'chademo', cGBT: 'gbt', sGBT: 'gbt' };
const IDENTITY_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ------------------------------------------------------------------ barcode scanner

/** Camera scan of a serial-number barcode / QR. Resolves with the text, or null. */
export function scanBarcode() {
  return new Promise((resolve) => {
    let stream = null;
    let timer = null;
    let result = null;
    const supported = 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia;
    const ctx = modal({
      title: 'Scan serial number',
      subtitle: 'Point the camera at the barcode or QR code on the charger\'s rating plate.',
      body: supported
        ? '<video playsinline muted style="width:100%;border-radius:10px;background:#000;max-height:360px"></video><div class="small muted" data-msg style="margin-top:8px">Starting camera…</div>'
        : callout('warn', 'This browser cannot scan barcodes (the BarcodeDetector API is available in Chrome/Edge on Android, ChromeOS and macOS). Type the serial number instead.'),
      actions: [{ label: 'Cancel' }],
      onClose() {
        clearInterval(timer);
        stream?.getTracks().forEach((t) => t.stop());
        resolve(result);
      },
    });
    if (!supported) return;
    const video = $('video', ctx.body);
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then(async (s) => {
        stream = s;
        video.srcObject = s;
        await video.play();
        $('[data-msg]', ctx.body).textContent = 'Scanning…';
        // eslint-disable-next-line no-undef
        const det = new BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'data_matrix', 'upc_a'] });
        timer = setInterval(async () => {
          try {
            const codes = await det.detect(video);
            if (codes.length) { result = String(codes[0].rawValue).trim(); ctx.close(); }
          } catch { /* keep scanning */ }
        }, 300);
      })
      .catch(() => { $('[data-msg]', ctx.body).textContent = 'Camera permission was refused, or no camera is available.'; });
  });
}

// ------------------------------------------------------------------ EVSE builder (shared with the charger drawer)

const blankConnector = (n, dc = true) => ({
  connectorId: 1,
  connectorType: dc ? 'cCCS2' : 'sType2',
  currentKind: dc ? 'DC' : 'AC3',
  maxPowerW: dc ? 60000 : 22000,
  ratedVoltageV: dc ? 1000 : 400,
  ratedCurrentA: dc ? 200 : 32,
  accuracyClass: '1.0',
  teraCertStatus: 'verified',
  teraDueAt: '',
  teraLastAt: '',
  meterSerial: '',
  typeApprovalNo: '',
  _n: n,
});

/** Convert a detail row (API) back into builder state. */
export function evsesFromConnectors(connectors = []) {
  const byEvse = new Map();
  for (const c of connectors) {
    const list = byEvse.get(c.evse_id) ?? [];
    list.push({
      connectorId: c.connector_id,
      connectorType: c.connector_type ?? 'cCCS2',
      currentKind: c.current_type === 'DC' ? 'DC' : Number(c.phases) === 1 ? 'AC1' : 'AC3',
      maxPowerW: c.max_power_w,
      ratedVoltageV: c.rated_voltage_v ?? '',
      ratedCurrentA: c.rated_current_a ?? '',
      accuracyClass: c.meter_accuracy_class ?? '',
      teraCertStatus: c.tera_cert_status ?? 'verified',
      teraDueAt: fmt.isoDate(c.tera_due_at),
      teraLastAt: fmt.isoDate(c.tera_last_at),
      meterSerial: c.meter_serial ?? '', meterPublicKey: c.meter_public_key ?? '',
      typeApprovalNo: c.tera_type_approval_no ?? '',
    });
    byEvse.set(c.evse_id, list);
  }
  return [...byEvse.entries()].sort((a, b) => a[0] - b[0]).map(([evseId, conns]) => ({ evseId, connectors: conns }));
}

/**
 * Render the EVSE & connector architecture builder into `box`.
 * Returns { value(): evses[] } — numbers converted, ready for the API.
 */
export function evseBuilder(box, { evses, ocppVersion = 'ocpp1.6' }) {
  let model = evses?.length ? structuredClone(evses) : [{ evseId: 1, connectors: [blankConnector(1)] }];
  const types = state.meta?.connectorTypes ?? [];
  const multi = ocppVersion === 'ocpp2.0.1' || ocppVersion === 'ocpp2.1';

  const conHtml = (c, ei, ci) => {
    const warnDays = c.teraDueAt ? Math.floor((new Date(c.teraDueAt) - Date.now()) / 86400000) : null;
    return `<div class="conn-tile" data-e="${ei}" data-c="${ci}" style="margin-top:10px">
      <div class="row" style="margin-bottom:8px"><b>Connector ${esc(c.connectorId)}</b>
        ${multi && model[ei].connectors.length > 1 ? `<button type="button" class="btn sm ghost right" data-del-conn>Remove</button>` : ''}</div>
      <div class="lbl small" style="font-weight:600;margin-bottom:6px">Standard / plug type</div>
      <div class="plugs">${types.map((t) => `<button type="button" class="plug" data-plug="${esc(t.code)}" aria-pressed="${t.code === c.connectorType}">${icon(PLUG_ICON[t.code] ?? 'plug')}${esc(t.label)}<small>${esc(t.current)}</small></button>`).join('')}</div>
      <div class="form" style="margin-top:12px">
        ${field('Current type', `<select data-k="currentKind">${options([{ value: 'DC', label: 'DC' }, { value: 'AC3', label: 'AC (3-phase)' }, { value: 'AC1', label: 'AC (single phase)' }], c.currentKind)}</select>`)}
        ${field('Nameplate power', `<div class="inputgroup"><input data-k="maxPowerKw" inputmode="decimal"><span class="suffix">kW</span></div>`)}
        ${field('Rated voltage', `<div class="inputgroup"><input data-k="ratedVoltageV" inputmode="numeric"><span class="suffix">V</span></div>`)}
        ${field('Max current', `<div class="inputgroup"><input data-k="ratedCurrentA" inputmode="numeric"><span class="suffix">A</span></div>`)}
      </div>
      <fieldset style="margin-top:12px"><legend>Metrology compliance (Indonesian tera)</legend><div class="form">
        ${field('Accuracy class', `<select data-k="accuracyClass">${options([{ value: '', label: '—' }, { value: '0.5', label: 'Class 0.5' }, { value: '1.0', label: 'Class 1.0' }, { value: '2.0', label: 'Class 2.0' }], c.accuracyClass)}</select>`)}
        ${field('Tera certification', `<select data-k="teraCertStatus">${options([{ value: 'verified', label: 'Verified' }, { value: 'pending', label: 'Pending calibration' }, { value: 'exempt', label: 'Exempt' }], c.teraCertStatus)}</select>`)}
        ${field('Tera expiry date', `<input data-k="teraDueAt" type="date">`, { help: warnDays != null && warnDays <= 30 ? `<span style="color:var(--crit);font-weight:600">${warnDays < 0 ? 'Expired — commercial sessions will be blocked' : `Expires in ${warnDays} days`}</span>` : 'A warning is raised 30 days before expiry.' })}
        ${field('Last tera date', `<input data-k="teraLastAt" type="date">`, { opt: true })}
        ${field('Meter serial', `<input data-k="meterSerial">`, { opt: true })}
        ${field('Meter public key', `<input data-k="meterPublicKey" class="mono" placeholder="hex, base64 or PEM">`, { opt: true, full: true, help: 'For meters that sign their readings (OCMF). From the meter’s label or type approval; signed readings are verified against it.' })}
        ${field('Type approval no.', `<input data-k="typeApprovalNo">`, { opt: true })}
      </div>${c.teraCertStatus === 'pending' ? `<div style="margin-top:8px">${callout('warn', 'A meter pending calibration cannot sell energy: remote starts and paid sessions on this connector are refused until it is verified (Permendag 24/2024, UTTP).')}</div>` : ''}</fieldset>
    </div>`;
  };

  function draw() {
    box.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <div class="field" style="min-width:auto"><div class="lbl small" style="font-weight:600">Number of ${multi ? 'EVSEs' : 'guns (EVSEs)'}</div>
          <div class="row"><button type="button" class="btn icon" data-dec aria-label="Remove EVSE">−</button>
          <b style="min-width:24px;text-align:center;font-size:16px">${model.length}</b>
          <button type="button" class="btn icon" data-inc aria-label="Add EVSE">+</button></div></div>
        <div class="small muted grow" style="max-width:60ch">${multi
          ? 'OCPP 2.0.1 addresses each EVSE and each connector on it separately.'
          : 'On OCPP 1.6 every gun is its own connectorId, so a dual-gun charger has two EVSEs here — gun 1 is connectorId 1, gun 2 is connectorId 2.'}</div>
      </div>
      ${model.map((e, ei) => `<div class="evse-card"><div class="head"><b>EVSE ${esc(e.evseId)}</b>${!multi ? `<span class="small muted">· OCPP connectorId ${esc(e.evseId)}</span>` : ''}
        ${multi ? `<button type="button" class="btn sm right" data-add-conn="${ei}">${icon('plus')} Connector</button>` : ''}</div>
        ${e.connectors.map((c, ci) => conHtml(c, ei, ci)).join('')}</div>`).join('')}`;

    // Values are written as properties, never interpolated.
    $$('.conn-tile', box).forEach((tile) => {
      const c = model[Number(tile.dataset.e)].connectors[Number(tile.dataset.c)];
      $('[data-k=maxPowerKw]', tile).value = c.maxPowerW ? String(Number(c.maxPowerW) / 1000) : '';
      for (const k of ['ratedVoltageV', 'ratedCurrentA', 'teraDueAt', 'teraLastAt', 'meterSerial', 'meterPublicKey', 'typeApprovalNo']) $(`[data-k=${k}]`, tile).value = c[k] ?? '';
      tile.addEventListener('input', (e) => {
        const k = e.target.dataset.k;
        if (!k) return;
        if (k === 'maxPowerKw') c.maxPowerW = Math.round(Number(e.target.value) * 1000);
        else c[k] = e.target.value;
      });
      tile.addEventListener('change', (e) => { if (['teraCertStatus', 'teraDueAt', 'currentKind'].includes(e.target.dataset.k)) draw(); });
      $$('[data-plug]', tile).forEach((b) => b.addEventListener('click', () => {
        c.connectorType = b.dataset.plug;
        const t = types.find((x) => x.code === b.dataset.plug);
        if (t?.current === 'DC') c.currentKind = 'DC';
        else if (t && c.currentKind === 'DC') c.currentKind = 'AC3';
        draw();
      }));
      $('[data-del-conn]', tile)?.addEventListener('click', () => {
        model[Number(tile.dataset.e)].connectors.splice(Number(tile.dataset.c), 1);
        draw();
      });
    });
    $('[data-inc]', box).addEventListener('click', () => {
      const prev = model[model.length - 1]?.connectors[0];
      const n = model.length + 1;
      const copyC = prev ? { ...structuredClone(prev), connectorId: 1 } : blankConnector(n);
      model.push({ evseId: n, connectors: [copyC] });
      draw();
    });
    $('[data-dec]', box).addEventListener('click', () => { if (model.length > 1) { model.pop(); draw(); } });
    $$('[data-add-conn]', box).forEach((b) => b.addEventListener('click', () => {
      const e = model[Number(b.dataset.addConn)];
      e.connectors.push({ ...blankConnector(1), connectorId: e.connectors.length + 1 });
      draw();
    }));
  }
  draw();

  return {
    value() {
      return model.map((e) => ({
        evseId: Number(e.evseId),
        connectors: e.connectors.map((c) => ({
          connectorId: Number(c.connectorId),
          connectorType: c.connectorType,
          currentKind: c.currentKind,
          maxPowerW: Number(c.maxPowerW),
          ratedVoltageV: c.ratedVoltageV === '' || c.ratedVoltageV == null ? null : Number(c.ratedVoltageV),
          ratedCurrentA: c.ratedCurrentA === '' || c.ratedCurrentA == null ? null : Number(c.ratedCurrentA),
          accuracyClass: c.accuracyClass || null,
          teraCertStatus: c.teraCertStatus,
          teraDueAt: c.teraDueAt || null,
          teraLastAt: c.teraLastAt || null,
          meterSerial: c.meterSerial || null, meterPublicKey: c.meterPublicKey ? c.meterPublicKey.trim() : null,
          typeApprovalNo: c.typeApprovalNo || null,
        })),
      }));
    },
    setVersion(v) { if ((v === 'ocpp2.0.1' || v === 'ocpp2.1') !== multi) { evseBuilder(box, { evses: model, ocppVersion: v }); } },
  };
}

// ------------------------------------------------------------------ commissioning results (shared)

/** Render a one-time credential + commissioning export block. */
export function credentialPanel(identity, issued) {
  const c = issued.commissioning;
  const wrap = el(`<div class="card pad" style="margin-top:12px"><div class="row" style="align-items:flex-start;gap:18px">
    <div class="grow" style="min-width:260px">
      <b>Commissioning export</b>
      <p class="small muted" style="margin:4px 0 10px">Load this into the charger's commissioning app, or configure it by hand. ${issued.key ? '<b>The key is shown once</b> — PlugSure keeps only its hash.' : ''}</p>
      <dl class="kv">
        <dt>Central system URL</dt><dd class="mono" data-url></dd>
        <dt>Charge point ID</dt><dd class="mono" data-id></dd>
        ${issued.key ? '<dt>Authorization key</dt><dd><div class="secret" data-key></div></dd>' : ''}
        <dt>Security profile</dt><dd data-prof></dd>
      </dl>
      <div class="row" style="margin-top:10px">
        ${issued.key ? `<button class="btn sm" data-copy-key>${icon('copy')} Copy key</button>` : ''}
        <button class="btn sm" data-json>${icon('download')} Download .json</button>
      </div>
    </div>
    <div class="qr"><img alt="Commissioning QR code" data-qr></div>
  </div></div>`);
  $('[data-url]', wrap).textContent = c.config.centralSystemUrl;
  $('[data-id]', wrap).textContent = identity;
  $('[data-prof]', wrap).textContent = String(c.config.securityProfile);
  if (issued.key) $('[data-key]', wrap).textContent = issued.key;
  $('[data-qr]', wrap).src = c.qrDataUrl; // a data: URL generated by our own server
  $('[data-copy-key]', wrap)?.addEventListener('click', () => copy(issued.key));
  $('[data-json]', wrap).addEventListener('click', () => download(`${identity}-commissioning.json`, c.json, 'application/json'));
  return wrap;
}

/** Profile 3 certificate bundle: from PlugSure's CA (key generated or CSR) or Vault. */
export function certBundlePanel(identity, r) {
  const title = r.source === 'plugsure_ca' ? 'Client certificate issued by PlugSure (key generated for the charger)' : r.source === 'plugsure_ca_csr' ? 'Client certificate issued by PlugSure for the charger\'s own key' : 'Client certificate issued by Vault PKI';
  const files = Object.keys(r.files ?? {});
  const wrap = el(`<div class="card pad" style="margin-top:12px"><b>${esc(title)}</b>
    <p class="small muted" style="margin:4px 0 10px">${r.files?.['client.key'] ? '<b>The private key is shown once</b> and is not stored by PlugSure. ' : 'The key stayed on the charger. '}Install ${r.files?.['client.key'] ? 'client.key, client.crt' : 'client.crt'} and ca.pem on the charger${r.files?.['csms-root.pem'] ? ', and csms-root.pem as its CSMS root' : ''}.</p>
    <dl class="kv"><dt>Subject</dt><dd class="mono small" data-sub></dd><dt>Fingerprint (SHA-256)</dt><dd class="mono small" data-fp style="word-break:break-all"></dd><dt>Serial</dt><dd class="mono" data-sn></dd><dt>Key</dt><dd data-kt></dd><dt>Expires</dt><dd data-exp></dd></dl>
    <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px">${files.map((n) => `<button class="btn sm" data-f="${esc(n)}">${icon('download')} ${esc(n)}</button>`).join('')}</div></div>`);
  $('[data-sub]', wrap).textContent = r.subject ?? '—';
  $('[data-kt]', wrap).textContent = r.keyType ?? '—';
  $('[data-fp]', wrap).textContent = r.fingerprint;
  $('[data-sn]', wrap).textContent = r.serialNumber ?? '';
  $('[data-exp]', wrap).textContent = fmt.date(r.expiresAt);
  $$('[data-f]', wrap).forEach((b) => b.addEventListener('click', () => download(`${identity}-${b.dataset.f}`, r.files[b.dataset.f], 'application/x-pem-file')));
  return wrap;
}

/** Poll the commissioning status until adopted (or the returned stop() is called). */
export function commissioningListener(box, identity) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const s = await api(`/v1/charge-points/${encodeURIComponent(identity)}/commissioning`).catch(() => null);
    if (!s || stopped) return;
    const a = s.lastAttempt;
    box.innerHTML = `<div class="card pad"><div class="row" style="gap:14px">
      ${s.adopted ? `<span class="tag t-ok" style="font-size:13px;padding:6px 12px">${icon('check')} Hardware Connected &amp; Adopted</span>`
        : `<span class="live-dot on"></span><b>${esc(s.headline)}</b>`}
      <span class="right small muted">${s.online ? 'WebSocket open' : 'no WebSocket yet'} · ${esc(s.bootCount)} boots</span></div>
      ${s.adopted ? `<dl class="kv" style="margin-top:12px"><dt>Reported hardware</dt><dd>${esc(s.hardware.vendor ?? '—')} ${esc(s.hardware.model ?? '')}</dd><dt>Firmware</dt><dd>${esc(s.hardware.firmware ?? '—')}</dd><dt>Protocol</dt><dd>${esc(s.hardware.ocppVersion ?? '—')}</dd><dt>Booted</dt><dd>${esc(fmt.ago(s.lastBootAt))}</dd></dl>` : ''}
      ${!s.adopted && a && a.outcome !== 'accepted' ? `<div style="margin-top:10px">${callout('warn', `Last handshake ${esc(fmt.ago(a.ts))}: <b>${esc(a.outcome)}</b> — ${esc(a.detail ?? '')}. ${a.outcome === 'rejected_auth' ? 'Check the authorization key on the charger.' : a.outcome === 'rejected_tls_required' ? 'The charger must use wss:// for this security profile.' : a.outcome === 'rejected_no_subprotocol' ? 'Check the charger\'s OCPP version setting.' : ''}`)}</div>` : ''}
      ${s.adopted && s.security ? `<div class="small" style="margin-top:10px">Security: <b>Profile ${esc(s.security.profile)}</b>${s.security.certificate ? ` · client certificate ${esc(s.security.certificate.serial ?? '')} until ${esc(fmt.date(s.security.certificate.notAfter))}` : ''}${s.security.certAutoUpgrade ? `<div style="margin-top:6px"><span class="live-dot on"></span> ${s.security.certificate ? 'Certificate installed — moving the charger to Profile 3…' : 'Asking the charger for its certificate request (CSR) and installing the certificate…'}</div>` : ''}</div>` : ''}
      ${!s.adopted ? '<p class="small muted" style="margin:10px 0 0">Waiting for the BootNotification. Power-cycle the charger or re-save its OCPP settings to make it connect now.</p>' : ''}
    </div>`;
    if (s.adopted && !s.security?.certAutoUpgrade) { stopped = true; toast(`${identity} connected and adopted`, 'ok'); return; }
    setTimeout(tick, 3000);
  };
  tick();
  return () => { stopped = true; };
}

// ------------------------------------------------------------------ wizard view

registerView('onboard', {
  title: 'Add charge point',
  icon: 'plus',
  group: 'operate',
  hidden: true,
  navAs: 'onboarding',
  perm: 'charge_point:write',
  async render(root, [presetSite]) {
    const features = state.me.features ?? {};
    const draft = {
      displayName: '', ocppIdentity: '', ocppVersion: 'ocpp1.6', vendor: '', model: '', serial: '', firmware: '',
      siteId: presetSite ?? '', securityProfile: features.minSecurityProfile >= 2 ? 2 : 2, keyMode: 'generate', key: '', rotationDays: 90,
      p3Method: 'auto', keyType: 'ec', certDays: '', csr: '', autoCertificate: false, certificatePem: '', fingerprint: '', evses: null,
    };
    let step = 1;
    let builder = null;
    let stopListener = null;
    const STEPS = ['Identity & hardware', 'Location & site', 'Security & credentials', 'EVSEs & connectors', 'Review & commissioning'];

    root.innerHTML = pageHead('Add charge point', 'Register a new charger end to end — identity, site, credentials and connectors — then watch it connect. No scripts, no SQL.')
      + `<ol class="steps">${STEPS.map((s) => `<li>${esc(s)}</li>`).join('')}</ol><div class="card pad" data-step></div>
         <div class="row" style="margin-top:14px"><button class="btn" data-back>Back</button><span class="grow"></span>
         <a class="btn ghost" href="#/onboarding">Cancel</a><button class="btn primary" data-next>Next</button></div>`;
    const box = $('[data-step]', root);
    const siteList = (await loadSites(true)).filter((s) => !s.archived_at);

    const renderStep = () => {
      $$('.steps li', root).forEach((li, i) => { li.className = i + 1 < step ? 'done' : i + 1 === step ? 'active' : ''; });
      $('[data-back]', root).disabled = step === 1;
      $('[data-next]', root).textContent = step === 4 ? 'Review' : step === 5 ? 'Register & commission' : 'Next';
      if (step === 1) {
        box.innerHTML = `<h3 style="margin-bottom:12px">Station identity & hardware profile</h3><div class="form">
          ${field('Station name / alias', '<input name="displayName" placeholder="Star Charger Hub — Thamrin Gun #1" maxlength="200">')}
          ${field('OCPP identity', '<input name="ocppIdentity" class="mono" placeholder="HY0400010001" maxlength="64" autocomplete="off">', { help: 'The last segment of the charger\'s WebSocket URL. Letters, digits, dash and underscore.' })}
          <div class="field"><div class="lbl">Protocol stack</div><div class="seg" data-proto>
            <button type="button" data-v="ocpp1.6">OCPP 1.6-J</button><button type="button" data-v="ocpp2.0.1">OCPP 2.0.1</button><button type="button" data-v="ocpp2.1">OCPP 2.1</button></div>
            <div class="help" data-proto-help></div></div>
          ${field('Hardware manufacturer', `<input name="vendor" list="vendors" placeholder="Hengyi, Autel Energy, Star Charger…"><datalist id="vendors">${(state.meta?.vendors ?? []).map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`)}
          ${field('Model name', '<input name="model" placeholder="HY SwiftHorse-120KW">')}
          ${field('Hardware serial number', `<div class="inputgroup"><input name="serial" class="mono"><button type="button" class="btn" data-scan title="Scan with camera">${icon('camera')}</button></div>`)}
          ${field('Initial firmware version', '<input name="firmware" placeholder="1.0.5">', { help: 'Updated automatically from the charger\'s BootNotification.' })}
        </div>`;
        for (const k of ['displayName', 'ocppIdentity', 'vendor', 'model', 'serial', 'firmware']) $(`[name=${k}]`, box).value = draft[k];
        const setProto = () => {
          $$('[data-proto] button', box).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === draft.ocppVersion)));
          const supported = (features.supportedVersions ?? []).includes(draft.ocppVersion);
          $('[data-proto-help]', box).innerHTML = supported ? 'The gateway accepts this protocol.' : `<span style="color:var(--warn)">The gateway is not currently configured for ${esc(draft.ocppVersion)} (OCPP_VERSIONS). Ask your administrator to enable it.</span>`;
        };
        $$('[data-proto] button', box).forEach((b) => b.addEventListener('click', () => { draft.ocppVersion = b.dataset.v; draft.evses = null; setProto(); }));
        setProto();
        $('[name=ocppIdentity]', box).addEventListener('input', (e) => e.target.classList.toggle('invalid', !!e.target.value && !IDENTITY_RE.test(e.target.value)));
        $('[data-scan]', box).addEventListener('click', async () => {
          const code = await scanBarcode();
          if (code) { $('[name=serial]', box).value = code; if (!$('[name=ocppIdentity]', box).value && IDENTITY_RE.test(code)) $('[name=ocppIdentity]', box).value = code; }
        });
      } else if (step === 2) {
        box.innerHTML = `<h3 style="margin-bottom:12px">Location & site assignment</h3>
          <div class="row" style="align-items:flex-end;gap:12px">${field('Electrical site', `<select name="siteId" style="min-width:320px">${options(siteList.map((s) => ({ value: s.id, label: s.name })), draft.siteId, { blank: 'Choose a site…' })}</select>`)}
          ${state.can('site:write') ? `<button type="button" class="btn" data-quick-site>${icon('plus')} Quick add site</button>` : ''}</div>
          <div data-site-card style="margin-top:14px"></div>`;
        const card = () => {
          const s = siteList.find((x) => x.id === $('[name=siteId]', box).value);
          $('[data-site-card]', box).innerHTML = s
            ? `<div class="grid k4">${[
                ['Subscribed', `${fmt.num(s.connected_kva)} kVA`, `PF ${Number(s.power_factor).toFixed(2)} · ${esc(s.grid_tariff_group ?? '')}`],
                ['Managed ceiling', fmt.kw(s.managed_ceiling_w), 'connected kVA × PF'],
                ['Chargers', `${s.charger_count}`, `${s.connector_count} connectors`],
                ['Voltage class', s.computed?.crossesTrTmCliff ? 'TM' : 'TR', s.computed?.crossesTrTmCliff ? 'above 200 kVA' : 'under the 200 kVA cliff'],
              ].map(([l, v, f]) => `<div class="card kpi"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div><div class="foot">${esc(f)}</div></div>`).join('')}</div>
              <p class="small muted">Load management keeps every charger at this site inside the managed ceiling; adding nameplate power beyond it is safe, it is shared.</p>`
            : callout('info', 'Pick the site this charger is installed at. Its PLN subscription decides how much power the charger may draw.');
        };
        $('[name=siteId]', box).addEventListener('change', card);
        card();
        $('[data-quick-site]', box)?.addEventListener('click', async () => {
          const id = await openSiteModal();
          if (!id) return;
          const fresh = (await loadSites(true)).filter((s) => !s.archived_at);
          siteList.splice(0, siteList.length, ...fresh);
          draft.siteId = id;
          renderStep();
        });
      } else if (step === 3) {
        const p = draft.securityProfile;
        box.innerHTML = `<h3 style="margin-bottom:4px">Security profile & credential provisioning</h3>
          <p class="small muted" style="margin:0 0 12px">ISO 27001: production chargers use Profile 2 (TLS + per-unit key) or Profile 3 (mutual TLS). The gateway currently requires at least Profile ${esc(features.minSecurityProfile ?? 0)}.</p>
          <div class="grid k3">${[
            [1, 'Profile 1 — Unsecured', 'HTTP Basic over plain ws://', 't-crit'],
            [2, 'Profile 2 — TLS + key', 'Basic authentication over wss:// with a pre-shared key', 't-ok'],
            [3, 'Profile 3 — Mutual TLS', 'Client X.509 certificate, no password', 't-ok'],
          ].map(([v, l, d, cls]) => `<button type="button" class="plug" style="text-align:left;padding:12px" data-prof="${v}" aria-pressed="${p === v}"><div class="row">${tag(cls, v === 1 ? 'insecure' : 'recommended')}</div><div style="margin-top:6px;font-size:13px">${esc(l)}</div><small>${esc(d)}</small></button>`).join('')}</div>
          <div data-prof-body style="margin-top:14px"></div>`;
        const body = $('[data-prof-body]', box);
        const drawBody = () => {
          body.innerHTML = '';
          if (draft.securityProfile === 1) {
            body.innerHTML = callout('crit', '<b>Insecure — for isolated test benches only.</b> The key crosses the network in clear text. Never use on a public or internet-connected charger.');
            toast('Insecure — for isolated test benches only', 'warn');
          }
          if (draft.securityProfile <= 2) {
            body.innerHTML += `<div class="form" style="margin-top:12px">
              <div class="field full"><div class="lbl">Authorization key</div><div class="seg" data-km>
                <button type="button" data-v="generate">Auto-generate cryptographic key</button><button type="button" data-v="manual">Enter my own</button></div></div>
              <div class="field" data-manual>${'<label>Key</label><input name="key" class="mono" autocomplete="off" placeholder="16–40 letters and digits">'}<div class="help">Minimum 16 alphanumeric characters.</div></div>
              ${field('Key rotation reminder', `<select name="rotationDays">${options([{ value: 30, label: 'Every 30 days' }, { value: 90, label: 'Every 90 days' }, { value: 180, label: 'Every 180 days' }, { value: 365, label: 'Every 365 days' }, { value: '', label: 'No reminder' }], draft.rotationDays)}</select>`)}
            </div>
            <p class="small muted">The key is generated when you commission (step 5) and shown once with a QR code and a .json commissioning file for the field technician.</p>
            ${draft.securityProfile === 2 ? `<div class="field full" style="margin-top:8px"><label class="check"><input type="checkbox" name="autoCertificate"${draft.autoCertificate ? ' checked' : ''}> <span><b>Then move it to Profile 3 automatically.</b> After its first connection PlugSure asks the charger for a certificate request, signs it with its certificate authority, installs it (CertificateSigned) and switches the charger to mutual TLS. The key never leaves the charger.</span></label>
              <div class="help">Needs a charger with the OCPP security extension (1.6 Security Whitepaper / 2.0.1). On 2.0.1 the certificate is installed; the profile is then raised with the charger's network profile.</div></div>` : ''}`;
            const km = () => {
              $$('[data-km] button', body).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === draft.keyMode)));
              $('[data-manual]', body).classList.toggle('hidden', draft.keyMode !== 'manual');
            };
            $$('[data-km] button', body).forEach((b) => b.addEventListener('click', () => { draft.keyMode = b.dataset.v; km(); }));
            $('[name=key]', body).value = draft.key;
            km();
          } else {
            body.innerHTML = `<div class="field"><div class="lbl">Client certificate</div><div class="seg" data-p3>
                <button type="button" data-v="auto">Issue automatically</button>
                <button type="button" data-v="csr">Sign the charger's request (CSR)</button>
                <button type="button" data-v="vault"${features.vault ? '' : ' disabled title="Vault PKI is not configured on this deployment"'}>Issue from Vault PKI</button>
                <button type="button" data-v="pem">Paste certificate (PEM)</button><button type="button" data-v="fingerprint">SHA-256 fingerprint</button></div></div>
              <div data-p3-body style="margin-top:12px"></div>`;
            const p3 = () => {
              $$('[data-p3] button', body).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === draft.p3Method)));
              const validity = field('Validity', `<select name="certDays">${options([{ value: '', label: 'Default (2 years)' }, { value: 365, label: '1 year' }, { value: 730, label: '2 years' }, { value: 1095, label: '3 years' }, { value: 1825, label: '5 years' }], draft.certDays)}</select>`, { help: 'Renewed over OCPP before it expires, on chargers that support it.' });
              $('[data-p3-body]', body).innerHTML = draft.p3Method === 'auto'
                ? `<div class="form">${field('Key type', `<select name="keyType">${options([{ value: 'ec', label: 'ECDSA P-256 (recommended)' }, { value: 'rsa', label: 'RSA 2048' }], draft.keyType)}</select>`, { help: 'Whichever the charger supports; most accept both.' })}${validity}</div>
                  <div style="margin-top:10px">${callout('info', 'At commissioning, PlugSure\'s certificate authority issues a key and certificate for this charger (CN = its OCPP identity) and binds the certificate to it. You download client.key, client.crt and ca.pem <b>once</b> and load them onto the charger with its commissioning tool.')}</div>`
                : draft.p3Method === 'csr'
                  ? `${field('Certificate signing request (PEM)', '<textarea name="csr" rows="7" class="mono" placeholder="-----BEGIN CERTIFICATE REQUEST-----"></textarea>', { full: true, help: 'Generated on the charger (its web page or commissioning tool). Its CN must be the OCPP identity from step 1. The private key never leaves the charger.' })}<div class="form" style="margin-top:8px">${validity}</div>`
                  : draft.p3Method === 'vault'
                    ? callout('info', 'At commissioning, PlugSure asks the internal HashiCorp Vault CA for a client certificate for this identity and binds its fingerprint. You download the bundle — private key, client.crt and ca.pem — once.')
                    : draft.p3Method === 'pem'
                      ? field('Charger certificate (PEM)', '<textarea name="certificatePem" rows="6" placeholder="-----BEGIN CERTIFICATE-----"></textarea>', { full: true, help: 'The certificate the charger presents. Only its SHA-256 fingerprint is stored.' })
                      : field('Certificate SHA-256 fingerprint', '<input name="fingerprint" class="mono" placeholder="AB:CD:… or 64 hex characters">');
              if (!features.vault && draft.p3Method === 'vault') draft.p3Method = 'auto';
              const ta = $('[name=certificatePem]', body); if (ta) ta.value = draft.certificatePem;
              const fp = $('[name=fingerprint]', body); if (fp) fp.value = draft.fingerprint;
              const cs = $('[name=csr]', body); if (cs) cs.value = draft.csr;
            };
            $$('[data-p3] button', body).forEach((b) => b.addEventListener('click', () => { if (!b.disabled) { Object.assign(draft, formValues(body).certDays !== undefined ? { certDays: formValues(body).certDays } : {}); draft.p3Method = b.dataset.v; p3(); } }));
            p3();
            body.insertAdjacentHTML('beforeend', `<div style="margin-top:10px">${callout('', 'Whatever terminates TLS for the OCPP host must trust the certificate authority and pass the certificate\'s fingerprint on. Download it and the proxy settings under <a href="#/onboarding/ca">Onboarding → Certificate authority</a>.')}</div>`);
          }
        };
        $$('[data-prof]', box).forEach((b) => b.addEventListener('click', () => {
          draft.securityProfile = Number(b.dataset.prof);
          $$('[data-prof]', box).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          drawBody();
        }));
        drawBody();
      } else if (step === 4) {
        box.innerHTML = '<h3 style="margin-bottom:12px">EVSE & connector architecture</h3><div data-builder></div>';
        builder = evseBuilder($('[data-builder]', box), { evses: draft.evses, ocppVersion: draft.ocppVersion });
      } else if (step === 5) {
        const site = siteList.find((s) => s.id === draft.siteId);
        const ev = draft.evses ?? [];
        const totalKw = ev.reduce((a, e) => a + e.connectors.reduce((b, c) => b + c.maxPowerW, 0), 0) / 1000;
        box.innerHTML = `<h3 style="margin-bottom:12px">Review & commissioning test</h3>
          <div class="grid two">
            <div><dl class="kv">
              <dt>Station</dt><dd data-r="name"></dd><dt>OCPP identity</dt><dd class="mono" data-r="id"></dd>
              <dt>Protocol</dt><dd>${esc(draft.ocppVersion === 'ocpp2.1' ? 'OCPP 2.1' : draft.ocppVersion === 'ocpp2.0.1' ? 'OCPP 2.0.1' : 'OCPP 1.6-J')}</dd>
              <dt>Hardware</dt><dd data-r="hw"></dd><dt>Serial</dt><dd class="mono" data-r="serial"></dd>
              <dt>Site</dt><dd>${esc(site?.name ?? '—')}</dd>
              <dt>Security</dt><dd>Profile ${esc(draft.securityProfile)}${draft.securityProfile <= 2 ? ` · ${draft.keyMode === 'manual' ? 'operator-supplied key' : 'generated key'}${draft.rotationDays ? ` · rotate every ${esc(draft.rotationDays)} days` : ''}` : ` · ${esc({ auto: `certificate issued automatically (${draft.keyType === 'rsa' ? 'RSA 2048' : 'ECDSA P-256'})`, csr: 'certificate for the charger\'s own request', vault: 'certificate from Vault PKI', pem: 'your certificate', fingerprint: 'certificate fingerprint' }[draft.p3Method])}`}${draft.securityProfile === 2 && draft.autoCertificate ? ' · then Profile 3 automatically (certificate over OCPP)' : ''}</dd>
              <dt>Topology</dt><dd>${esc(ev.length)} EVSE(s), ${esc(ev.reduce((a, e) => a + e.connectors.length, 0))} connector(s), ${esc(fmt.num(totalKw, 1))} kW nameplate</dd>
            </dl></div>
            <div>${ev.map((e) => e.connectors.map((c) => `<div class="row small" style="margin-bottom:4px">${tag('t-info', `EVSE ${e.evseId}`, '', true)} ${esc(c.connectorType)} · ${esc(c.currentKind)} · ${esc(fmt.num(c.maxPowerW / 1000, 1))} kW · ${c.teraCertStatus === 'pending' ? tag('t-crit', 'pending calibration') : tag('t-ok', `tera ${c.teraCertStatus}`)}</div>`).join('')).join('')}</div>
          </div>
          <div data-results style="margin-top:16px"></div>`;
        $('[data-r=name]', box).textContent = draft.displayName || '—';
        $('[data-r=id]', box).textContent = draft.ocppIdentity;
        $('[data-r=hw]', box).textContent = `${draft.vendor || '—'} ${draft.model || ''}`;
        $('[data-r=serial]', box).textContent = draft.serial || '—';
      }
    };

    const collect = () => {
      const v = formValues(box);
      if (step === 1) Object.assign(draft, { displayName: v.displayName.trim(), ocppIdentity: v.ocppIdentity.trim(), vendor: v.vendor.trim(), model: v.model.trim(), serial: v.serial.trim(), firmware: v.firmware.trim() });
      if (step === 2) draft.siteId = v.siteId;
      if (step === 3) Object.assign(draft, {
        key: v.key ?? draft.key, rotationDays: v.rotationDays ?? draft.rotationDays, certificatePem: v.certificatePem ?? draft.certificatePem, fingerprint: v.fingerprint ?? draft.fingerprint,
        csr: v.csr ?? draft.csr, keyType: v.keyType ?? draft.keyType, certDays: v.certDays ?? draft.certDays,
        autoCertificate: draft.securityProfile === 2 ? Boolean(v.autoCertificate) : false,
      });
      if (step === 4) draft.evses = builder.value();
    };

    const validate = async () => {
      if (step === 1) {
        if (!IDENTITY_RE.test(draft.ocppIdentity)) return 'The OCPP identity must be 1–64 letters, digits, dashes or underscores.';
        const existing = await api(`/v1/charge-points/${encodeURIComponent(draft.ocppIdentity)}`).catch(() => null);
        if (existing) return `${draft.ocppIdentity} is already registered.`;
      }
      if (step === 2 && !draft.siteId) return 'Choose the site.';
      if (step === 3) {
        if (draft.securityProfile < (features.minSecurityProfile ?? 0)) return `The gateway requires at least security profile ${features.minSecurityProfile}.`;
        if (draft.securityProfile <= 2 && draft.keyMode === 'manual' && !/^[A-Za-z0-9]{16,40}$/.test(draft.key)) return 'A manual key must be 16–40 letters and digits.';
        if (draft.securityProfile === 3 && draft.p3Method === 'pem' && !draft.certificatePem.includes('BEGIN CERTIFICATE')) return 'Paste the charger\'s PEM certificate.';
        if (draft.securityProfile === 3 && draft.p3Method === 'csr' && !draft.csr.includes('BEGIN CERTIFICATE REQUEST')) return 'Paste the charger\'s certificate signing request (PEM).';
        if (draft.securityProfile === 3 && draft.p3Method === 'fingerprint' && draft.fingerprint.replace(/[:\s]/g, '').length !== 64) return 'The fingerprint must be 64 hex characters.';
      }
      if (step === 4) {
        for (const e of draft.evses) for (const c of e.connectors) {
          if (!(c.maxPowerW >= 1000)) return `EVSE ${e.evseId}: enter the nameplate power.`;
          if (c.teraCertStatus === 'verified' && !c.teraDueAt) return `EVSE ${e.evseId}: a verified meter needs its tera expiry date.`;
        }
      }
      return null;
    };

    const commission = async () => {
      const results = $('[data-results]', box);
      const log = (html) => results.insertAdjacentHTML('beforeend', `<div class="row small" style="margin-bottom:6px">${html}</div>`);
      const ok = (m) => log(`${tag('t-ok', 'done')} ${esc(m)}`);
      const fail = (m) => { log(`${tag('t-crit', 'failed')} ${esc(m)}`); };
      const id = draft.ocppIdentity;
      const enc = encodeURIComponent(id);
      $('[data-next]', root).disabled = true;
      $('[data-back]', root).disabled = true;
      try {
        await api('/v1/charge-points', { method: 'POST', body: {
          ocppIdentity: id, siteId: draft.siteId, displayName: draft.displayName, vendor: draft.vendor, model: draft.model,
          serial: draft.serial, firmware: draft.firmware, ocppVersion: draft.ocppVersion, evses: draft.evses,
        } });
        ok(`Registered ${id} (pending adoption)`);
      } catch (e) { fail(`Registration: ${e.message}`); $('[data-back]', root).disabled = false; $('[data-next]', root).disabled = false; return; }

      let issuedPanel = null;
      let commissioningPanel = null;
      try {
        if (draft.securityProfile <= 2) {
          const r = await api(`/v1/charge-points/${enc}/keys`, { method: 'POST', body: { profile: draft.securityProfile, key: draft.keyMode === 'manual' ? draft.key : undefined, rotationDays: draft.rotationDays || undefined, autoCertificate: draft.securityProfile === 2 ? draft.autoCertificate : undefined } });
          ok('Authorization key issued');
          if (draft.securityProfile === 2 && draft.autoCertificate) ok('Certificate over OCPP scheduled: after its first connection the charger gets its certificate and moves to Profile 3');
          issuedPanel = credentialPanel(id, r);
        } else if (draft.p3Method === 'auto' || draft.p3Method === 'csr') {
          const r = await api(`/v1/charge-points/${enc}/keys`, { method: 'POST', body: { profile: 3, method: draft.p3Method, keyType: draft.keyType, csr: draft.p3Method === 'csr' ? draft.csr : undefined, days: draft.certDays ? Number(draft.certDays) : undefined } });
          ok(`Client certificate issued by PlugSure's certificate authority and bound (serial ${r.serialNumber})`);
          issuedPanel = certBundlePanel(id, r);
          commissioningPanel = credentialPanel(id, { commissioning: r.commissioning });
        } else if (draft.p3Method === 'vault') {
          const r = await api(`/v1/charge-points/${enc}/keys`, { method: 'POST', body: { profile: 3, method: 'vault' } });
          ok('Client certificate issued by Vault and bound');
          issuedPanel = certBundlePanel(id, r);
        } else {
          await api(`/v1/charge-points/${enc}/keys`, { method: 'POST', body: { profile: 3, certificatePem: draft.p3Method === 'pem' ? draft.certificatePem : undefined, fingerprint: draft.p3Method === 'fingerprint' ? draft.fingerprint : undefined } });
          ok('Client certificate fingerprint bound');
        }
        await api(`/v1/charge-points/${enc}/security-profile`, { method: 'PUT', body: { profile: draft.securityProfile } });
        ok(`Security profile ${draft.securityProfile} enforced`);
      } catch (e) {
        fail(`Security: ${e.message}`);
        log('<span class="muted">The charger is registered. Finish its security from the charger\'s Security tab.</span>');
      }
      if (issuedPanel) results.append(issuedPanel);
      if (commissioningPanel) results.append(commissioningPanel);
      if (draft.securityProfile === 3 && !['vault', 'auto', 'csr'].includes(draft.p3Method)) {
        const r = await api(`/v1/charge-points/${enc}/commissioning-export`).catch(() => null);
        if (r) results.append(credentialPanel(id, { commissioning: r }));
      }
      try {
        await api(`/v1/charge-points/${enc}/activate`, { method: 'POST' });
        ok('Activated — the charger may transact once it connects');
      } catch (e) { fail(`Activation: ${e.message}`); }

      const listen = el('<div style="margin-top:14px"></div>');
      results.append(listen);
      stopListener = commissioningListener(listen, id);
      results.insertAdjacentHTML('beforeend', `<div class="row" style="margin-top:14px"><a class="btn primary" href="#/chargers/${esc(enc)}">Open ${esc(id)}</a><a class="btn" href="#/onboard/${esc(encodeURIComponent(draft.siteId))}">Onboard another at this site</a></div>`);
      $('[data-next]', root).classList.add('hidden');
      $('[data-back]', root).classList.add('hidden');
      $('a.btn.ghost[href="#/onboarding"]', root)?.classList.add('hidden');
    };

    $('[data-back]', root).addEventListener('click', () => { collect(); if (step > 1) { step--; renderStep(); } });
    $('[data-next]', root).addEventListener('click', async () => {
      collect();
      const problem = await validate();
      if (problem) { toast(problem, 'crit'); return; }
      if (step < 5) { step++; renderStep(); return; }
      await commission();
    });
    renderStep();
    return () => stopListener?.();
  },
});
