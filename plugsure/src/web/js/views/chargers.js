import {
  $, $$, esc, el, api, attempt, state, registerView, pageHead, table, tag, icon, fmt, modal, drawer, confirmDialog, html,
  field, options, formValues, fieldErrors, toast, callout, kpi, navigate, onLive, debounce, connectorTag, teraTag,
  onlineTag, inPortal, sites as loadSites,
} from '../core.js';

/** The raw OCPP log: operators (org-wide) and field technicians only — the server refuses anyone else. */
const canSeeFrames = () => !inPortal() && (state.me?.visibleSites == null || state.can('charge_point:config') || state.can('charge_point:command'));
import { evseBuilder, evsesFromConnectors, credentialPanel, certBundlePanel } from './onboard.js';

/**
 * Charge points: the fleet table and the per-charger drawer.
 *   Overview · Remote control (Module 2) · Configuration (Module 6) · Device model (2.0.1) · Security · Connectors · Sessions
 */

const enc = encodeURIComponent;

// ------------------------------------------------------------------ small renderers

function connectivity(c) {
  const hbAge = c.last_heartbeat_at ? Date.now() - new Date(c.last_heartbeat_at).getTime() : Infinity;
  const hb = hbAge > 900_000 ? 'color:var(--crit)' : hbAge > 600_000 ? 'color:var(--warn)' : '';
  return `<div class="small nowrap"><span class="muted">seen</span> <b title="${esc(fmt.time(c.last_seen_at))}">${esc(fmt.ago(c.last_seen_at))}</b></div>
    <div class="small nowrap"><span class="muted">heartbeat</span> <b style="${hb}" title="${esc(fmt.time(c.last_heartbeat_at))}">${esc(fmt.ago(c.last_heartbeat_at))}</b></div>
    ${c.offline_since ? `<div class="small nowrap" style="color:var(--crit)">offline ${esc(fmt.ago(c.offline_since).replace(/ ago$/, ''))}</div>` : ''}`;
}

function security(c) {
  const p = Number(c.security_profile ?? 0);
  const credOk = p >= 3 ? c.has_client_cert : c.has_auth_key;
  const rotDue = c.key_rotation_days && c.auth_key_rotated_at && Date.now() - new Date(c.auth_key_rotated_at).getTime() > c.key_rotation_days * 86400000;
  return `<div class="chips">${tag(p >= 2 ? 't-ok' : p === 1 ? 't-warn' : 't-crit', `profile ${p}`, ['no auth', 'Basic over ws', 'Basic over TLS', 'mutual TLS'][p] ?? '')}
    ${p >= 1 ? tag(credOk ? 't-ok' : 't-crit', credOk ? (p >= 3 ? 'cert bound' : 'key set') : 'no credential') : ''}
    ${rotDue ? tag('t-warn', 'rotate key') : ''}</div>`;
}

function connectorsCell(c) {
  return (c.connectors ?? []).map((k) => `<div class="row" style="gap:5px;margin-bottom:3px;flex-wrap:nowrap">
      <b class="small">#${esc(k.evseNo)}</b>${connectorTag(k.status)}
      <span class="small muted nowrap">${esc(fmt.num(k.maxPowerW / 1000))} kW ${esc(k.currentType)}</span>
      ${k.sessionId ? `<span class="small nowrap" style="color:var(--info)">${esc(fmt.kwh(k.sessionEnergyWh, 1))}</span>` : ''}
      ${['lapsed', 'pending'].includes(k.teraStatus) ? teraTag(k.teraStatus) : ''}
      ${k.maintenanceReason ? tag('t-warn', 'maintenance', k.maintenanceReason) : ''}</div>`).join('') || '<span class="small muted">none reported</span>';
}

// ------------------------------------------------------------------ remote command dialogs (Module 2.1)

async function sendCommand(identity, path, body, label) {
  return attempt(() => api(`/v1/charge-points/${enc(identity)}/${path}`, { method: 'POST', body }), {
    success: (r) => `${label}: ${r?.status ?? 'sent'}`,
  });
}

export function remoteStartDialog(cp, connectorNo) {
  const conns = cp.connectors ?? [];
  const canSell = state.can('session:write');
  modal({
    title: `Remote start — ${cp.display_name || cp.ocpp_identity}`,
    subtitle: 'Sends RemoteStartTransaction. The driver must plug in within the charger\'s connection timeout.',
    size: 'lg',
    body: `<form class="form" novalidate>
      ${field('Connector', `<select name="connectorId">${options(conns.map((k) => ({ value: k.evseNo ?? k.evse_id, label: `Gun ${k.evseNo ?? k.evse_id} — ${k.connectorType ?? k.connector_type ?? ''} ${fmt.num((k.maxPowerW ?? k.max_power_w) / 1000)} kW (${k.status})` })), connectorNo)}</select>`)}
      ${field('RFID tag / driver account', '<input name="idTag" list="start-tags" class="mono" autocomplete="off" placeholder="Search cards by UID or holder">', { help: canSell ? 'Any active card. The session is billed to it.' : 'Your role may only start test sessions: use a Maintenance Technician or VIP / Internal Testing card.' })}
      <datalist id="start-tags"></datalist>
      <div class="field full"><div class="lbl">Preset limit</div><div class="seg" data-lt>
        <button type="button" data-v="none" aria-pressed="true">Full charge</button><button type="button" data-v="energy">Energy (kWh)</button>
        <button type="button" data-v="duration">Duration (min)</button><button type="button" data-v="amount">Amount (IDR)</button></div>
        <div class="help">The platform stops the session with RemoteStopTransaction when the limit is reached.</div></div>
      <div class="field hidden" data-lv><label data-lv-label>Limit</label><input name="limitValue" inputmode="decimal"></div>
    </form>`,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Start session',
        kind: 'primary',
        async onClick(ctx) {
          const v = formValues(ctx.body);
          const lt = $('[data-lt] [aria-pressed=true]', ctx.body).dataset.v;
          if (!v.idTag.trim()) { fieldErrors(ctx.body, { idTag: 'Choose a card' }); return false; }
          const r = await attempt(() => api(`/v1/charge-points/${enc(cp.ocpp_identity)}/remote-start`, {
            method: 'POST',
            body: { connectorId: Number(v.connectorId), idTag: v.idTag.trim(), limitType: lt, limitValue: lt === 'none' ? null : v.limitValue },
          }));
          if (!r) return false;
          toast(r.status === 'Accepted' ? 'Charger accepted the remote start' : `Charger answered ${r.status}`, r.status === 'Accepted' ? 'ok' : 'warn');
        },
      },
    ],
    onMount(ctx) {
      const lt = $('[data-lt]', ctx.body);
      $$('button', lt).forEach((b) => b.addEventListener('click', () => {
        $$('button', lt).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        $('[data-lv]', ctx.body).classList.toggle('hidden', b.dataset.v === 'none');
        $('[data-lv-label]', ctx.body).textContent = { energy: 'Energy limit (kWh)', duration: 'Duration (minutes)', amount: 'Amount (IDR, incl. taxes)' }[b.dataset.v] ?? '';
      }));
      const input = $('[name=idTag]', ctx.body);
      const list = $('#start-tags', ctx.body);
      const load = debounce(async () => {
        if (!state.can('token:read')) return;
        const cards = await api(`/v1/tokens?status=Accepted&limit=30&q=${enc(input.value.trim())}`).catch(() => []);
        list.replaceChildren(...cards.map((t) => { const o = document.createElement('option'); o.value = t.uid; o.label = `${t.holder_name ?? ''} · ${t.account_type}`; return o; }));
      }, 200);
      input.addEventListener('input', load);
      load();
    },
  });
}

export async function remoteStopDialog(cp, k) {
  const since = k.sessionStartedAt ?? k.session_started_at;
  const tx = k.transactionId ?? k.ocpp_transaction_id;
  const ok = await confirmDialog({
    title: 'Stop charging session?',
    message: html`Transaction <b class="mono">${tx}</b> on gun ${k.evseNo ?? k.evse_id} — running ${fmt.dur((Date.now() - new Date(since).getTime()) / 1000)}, ${fmt.kwh(k.sessionEnergyWh ?? k.session_energy_wh, 2)} delivered. The driver is billed for energy delivered so far.`,
    confirmLabel: 'Stop session',
    danger: true,
  });
  if (ok) await sendCommand(cp.ocpp_identity, 'remote-stop', { transactionId: tx }, 'Remote stop');
}

export async function unlockDialog(cp, connectorNo) {
  const ok = await confirmDialog({
    title: `Release cable on gun ${connectorNo}?`,
    message: 'Sends UnlockConnector to release the mechanical interlock for a driver whose CCS2 / Type 2 plug is stuck. Any session on this connector ends.',
    confirmLabel: 'Unlock cable',
    danger: true,
  });
  if (ok) await sendCommand(cp.ocpp_identity, 'unlock', { connectorId: connectorNo }, 'Unlock');
}

export function availabilityDialog(cp, connectorNo, currentlyInoperative) {
  const goingOut = !currentlyInoperative;
  modal({
    title: goingOut ? `Take gun ${connectorNo || 'all'} out of service` : `Return gun ${connectorNo || 'all'} to service`,
    subtitle: 'Sends ChangeAvailability. An Inoperative connector refuses new sessions until it is made Operative again.',
    body: goingOut
      ? `<div class="form one">${field('Maintenance reason', '<input name="reason" placeholder="Gun 2 cable jacket damaged — awaiting replacement" maxlength="200">', { help: 'Required. Shown on the connector and recorded in the audit log.' })}</div>`
      : '<p>The connector becomes available to drivers again.</p>',
    actions: [
      { label: 'Cancel' },
      {
        label: goingOut ? 'Set Inoperative' : 'Set Operative',
        kind: goingOut ? 'danger' : 'primary',
        async onClick(ctx) {
          const reason = $('[name=reason]', ctx.body)?.value.trim() ?? '';
          if (goingOut && reason.length < 3) { fieldErrors(ctx.body, { reason: 'Enter the maintenance reason' }); return false; }
          const r = await sendCommand(cp.ocpp_identity, 'availability', { connectorId: connectorNo, type: goingOut ? 'Inoperative' : 'Operative', reason }, 'Availability');
          if (!r) return false;
        },
      },
    ],
  });
}

export function resetDialog(cp) {
  let kind = 'Soft';
  const ctx = modal({
    title: `Reboot ${cp.display_name || cp.ocpp_identity}`,
    subtitle: 'Step 1 of 2 — choose the kind of reset.',
    body: `<div class="grid two">
      <button type="button" class="plug" style="text-align:left;padding:14px" data-k="Soft" aria-pressed="true"><div style="font-size:13px">Soft reset</div><small>Restarts the charger's software. Ongoing sessions are stopped gracefully first.</small></button>
      <button type="button" class="plug" style="text-align:left;padding:14px" data-k="Hard" aria-pressed="false"><div style="font-size:13px">Hard reset</div><small>Full power-cycle reboot. Use when the software is unresponsive. Sessions end abruptly.</small></button></div>`,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Continue',
        kind: 'primary',
        async onClick() {
          const ok = await confirmDialog({
            title: `Confirm ${kind.toLowerCase()} reset`,
            message: html`Step 2 of 2 — the charger <b class="mono">${cp.ocpp_identity}</b> will go offline while it restarts${kind === 'Hard' ? ' and any active session will be cut' : ''}.`,
            confirmLabel: `${kind} reset now`,
            danger: true,
            requireText: kind === 'Hard' ? 'REBOOT' : null,
          });
          if (ok) await sendCommand(cp.ocpp_identity, 'reset', { type: kind }, `${kind} reset`);
        },
      },
    ],
  });
  $$('[data-k]', ctx.body).forEach((b) => b.addEventListener('click', () => {
    kind = b.dataset.k;
    $$('[data-k]', ctx.body).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
}

export function triggerDialog(cp) {
  modal({
    title: 'Trigger diagnostic message',
    subtitle: 'Sends TriggerMessage — the charger re-sends the chosen message now. Useful for a silent or stuck unit.',
    body: `<div class="form">
      ${field('Message', `<select name="msg">${options(['StatusNotification', 'MeterValues', 'BootNotification', 'Heartbeat', 'DiagnosticsStatusNotification', 'FirmwareStatusNotification'], 'StatusNotification')}</select>`)}
      ${field('Connector', `<select name="connectorId">${options([{ value: '', label: 'Whole station' }, ...(cp.connectors ?? []).map((k) => ({ value: k.evseNo ?? k.evse_id, label: `Gun ${k.evseNo ?? k.evse_id}` }))], '')}</select>`)}
    </div>`,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Send',
        kind: 'primary',
        async onClick(ctx) {
          const v = formValues(ctx.body);
          const r = await sendCommand(cp.ocpp_identity, 'trigger', { requestedMessage: v.msg, connectorId: v.connectorId ? Number(v.connectorId) : undefined }, 'Trigger');
          if (!r) return false;
        },
      },
    ],
  });
}

export async function clearCacheDialog(cp) {
  const ok = await confirmDialog({
    title: 'Clear authorization cache?',
    message: 'Sends ClearCache — flushes the RFID cache stored in the charger\'s memory. The Local Authorization List (pushed from RFID & Access) is not affected.',
    confirmLabel: 'Clear cache',
  });
  if (ok) await sendCommand(cp.ocpp_identity, 'clear-cache', {}, 'Clear cache');
}

// ------------------------------------------------------------------ drawer tabs

function overviewTab(identity) {
  return async (body, ctx) => {
    const d = await api(`/v1/charge-points/${enc(identity)}`);
    ctx.el.querySelector('h2').textContent = d.display_name || d.ocpp_identity;
    ctx.setSubtitle(`<span class="mono">${esc(d.ocpp_identity)}</span> · ${esc(d.site_name)}`);
    ctx.setHeader(`<div class="row" style="margin-top:6px">${onlineTag(d.online, d.status)} ${tag('t-mute', d.negotiatedVersion ?? d.ocpp_version ?? 'protocol unknown', '', true)} ${security({ ...d, has_client_cert: !!d.client_cert_fingerprint })}</div>`);
    const canWrite = state.can('charge_point:write');
    body.innerHTML = `
      ${d.status === 'pending_adoption' ? callout('warn', `<b>Pending adoption.</b> This charger is registered but not yet allowed to transact. ${canWrite ? '<button class="btn sm primary" data-activate style="margin-left:8px">Activate now</button>' : ''}`) : ''}
      ${d.status === 'suspended' ? callout('warn', `<b>Suspended.</b> It keeps its credentials and stays connected, but new sessions are refused until it is resumed. ${canWrite ? '<button class="btn sm primary" data-resume style="margin-left:8px">Resume</button>' : ''}`) : ''}
      ${d.status === 'decommissioned' ? callout('crit', `<b>Decommissioned</b> ${esc(fmt.date(d.decommissioned_at))}. Its credentials were revoked. ${canWrite ? '<button class="btn sm" data-reinstate style="margin-left:8px">Reinstate</button>' : ''}`) : ''}
      <div class="grid k3" style="margin-top:12px" data-conns></div>
      <div class="grid two section">
        <div class="card pad"><div class="row" style="margin-bottom:10px"><h3 style="font-size:13px">Hardware profile</h3>${canWrite ? `<button class="btn sm ghost right" data-edit>${icon('gear')} Edit</button>` : ''}</div>
          <dl class="kv" data-hw></dl></div>
        <div class="card pad"><h3 style="font-size:13px;margin-bottom:10px">Connectivity</h3><dl class="kv">
          <dt>WebSocket</dt><dd>${d.online ? tag('t-ok', 'connected') : tag('t-mute', 'not connected')}</dd>
          <dt>Last seen</dt><dd>${esc(fmt.time(d.last_seen_at))} <span class="muted">(${esc(fmt.ago(d.last_seen_at))})</span></dd>
          <dt>Last heartbeat</dt><dd>${esc(fmt.time(d.last_heartbeat_at))}</dd>
          <dt>Offline since</dt><dd>${d.offline_since ? esc(fmt.time(d.offline_since)) : '—'}</dd>
          <dt>Boots</dt><dd>${esc(d.boot_count)}</dd>
          <dt>Commissioned</dt><dd>${esc(fmt.date(d.commissioned_at ?? d.adopted_at))}</dd>
          <dt>OCPP URL</dt><dd class="mono small" data-url></dd>
        </dl></div>
      </div>
      <div class="row section">
        ${canSeeFrames() ? `<a class="btn sm" href="#/logs/${esc(enc(identity))}">${icon('terminal')} OCPP frames</a>` : ''}
        ${canWrite && !['decommissioned', 'suspended', 'pending_adoption'].includes(d.status) ? `<button class="btn sm ghost right" data-suspend>Suspend…</button>` : ''}
        ${canWrite && d.status !== 'decommissioned' ? `<button class="btn sm ghost${['suspended', 'pending_adoption'].includes(d.status) ? ' right' : ''}" data-decom style="color:var(--crit)">Decommission…</button>` : ''}
      </div>`;
    const hw = $('[data-hw]', body);
    const rows = [['Vendor', d.vendor], ['Model', d.model], ['Serial', d.serial], ['Firmware', d.firmware], ['Protocol', d.ocpp_version], ['Site', d.site_name]];
    hw.innerHTML = rows.map(([k]) => `<dt>${esc(k)}</dt><dd></dd>`).join('');
    $$('dd', hw).forEach((dd, i) => { dd.textContent = rows[i][1] ?? '—'; });
    $('[data-url]', body).textContent = d.ocppUrl;

    $('[data-conns]', body).innerHTML = d.connectors.map((k) => `<div class="conn-tile">
      <div class="top"><b>Gun ${esc(k.evse_id)}${k.connector_id > 1 ? `.${esc(k.connector_id)}` : ''}</b>${connectorTag(k.status)}<span class="right small muted">${esc(k.connector_type ?? '')}</span></div>
      <div class="big" style="margin-top:6px">${esc(fmt.num(k.max_power_w / 1000, 1))} kW <span class="small muted">${esc(k.current_type)}${k.current_type === 'AC' ? ` · ${esc(k.phases)}Ø` : ''}</span></div>
      ${k.session_id ? `<div class="small" style="margin-top:4px;color:var(--info)">Session ${esc(fmt.kwh(k.session_energy_wh, 2))} · ${esc(fmt.dur((Date.now() - new Date(k.session_started_at)) / 1000))} · <span class="mono">${esc(k.session_id_tag ?? '')}</span></div>` : ''}
      ${k.error_code ? `<div class="small" style="color:var(--crit)">${esc(k.error_code)}${k.vendor_error_code ? ` / ${esc(k.vendor_error_code)}` : ''}</div>` : ''}
      ${k.maintenance_reason ? `<div class="small" style="color:var(--warn)">Maintenance: ${esc(k.maintenance_reason)}</div>` : ''}
      <div class="row" style="margin-top:6px">${teraTag(k.tera_status)}<span class="small muted">${k.tera_due_at ? `due ${esc(fmt.date(k.tera_due_at))}` : ''}</span></div>
    </div>`).join('') || callout('info', 'No connectors yet — they appear when the charger reports them, or add them on the Connectors tab.');

    $('[data-activate]', body)?.addEventListener('click', async () => {
      if (await attempt(() => api(`/v1/charge-points/${enc(identity)}/activate`, { method: 'POST' }), { success: 'Activated' })) ctx.refresh();
    });
    $('[data-reinstate]', body)?.addEventListener('click', async () => {
      if (await attempt(() => api(`/v1/charge-points/${enc(identity)}/reinstate`, { method: 'POST' }), { success: 'Reinstated as pending adoption — issue new credentials' })) ctx.refresh();
    });
    $('[data-resume]', body)?.addEventListener('click', async () => {
      if (await attempt(() => api(`/v1/charge-points/${enc(identity)}/resume`, { method: 'POST' }), { success: 'Resumed' })) ctx.refresh();
    });
    $('[data-suspend]', body)?.addEventListener('click', () => {
      modal({
        title: 'Suspend this charge point?',
        body: `<p style="margin:0 0 10px">New sessions are refused until you resume it. A session already running finishes and is billed normally. Its credentials are kept, so resuming needs nothing on the charger.</p>
          <div class="form one">${field('Reason', '<input data-reason maxlength="500" autocomplete="off" placeholder="Site closed for electrical works">', { opt: true, help: 'Recorded in the audit log.' })}</div>`,
        actions: [
          { label: 'Cancel' },
          {
            label: 'Suspend',
            kind: 'danger',
            async onClick(m) {
              const reason = $('[data-reason]', m.body).value.trim();
              const r = await attempt(() => api(`/v1/charge-points/${enc(identity)}/suspend`, { method: 'POST', body: reason ? { reason } : {} }), { success: 'Suspended' });
              if (!r) return false;
              ctx.refresh();
            },
          },
        ],
      });
    });
    $('[data-decom]', body)?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Decommission this charge point?',
        message: 'It stops being able to connect: its authorization key and certificate binding are revoked. Sessions and invoices are kept.',
        confirmLabel: 'Decommission',
        danger: true,
        requireText: d.ocpp_identity,
      });
      if (ok && await attempt(() => api(`/v1/charge-points/${enc(identity)}/decommission`, { method: 'POST', body: {} }), { success: 'Decommissioned' })) ctx.refresh();
    });
    $('[data-edit]', body)?.addEventListener('click', () => editProfile(d, ctx));
  };
}

async function editProfile(d, dctx) {
  const siteList = (await loadSites()).filter((s) => !s.archived_at);
  const m = modal({
    title: 'Edit hardware profile',
    size: 'lg',
    body: `<form class="form" novalidate>
      ${field('Station name / alias', '<input name="displayName" maxlength="200">')}
      ${field('Site', `<select name="siteId">${options(siteList.map((s) => ({ value: s.id, label: s.name })), d.site_id)}</select>`)}
      ${field('Vendor', `<input name="vendor" list="vendors-e"><datalist id="vendors-e">${(state.meta?.vendors ?? []).map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`)}
      ${field('Model', '<input name="model">')}
      ${field('Serial', '<input name="serial" class="mono">')}
      ${field('Protocol', `<select name="ocppVersion">${options([{ value: 'ocpp1.6', label: 'OCPP 1.6-J' }, { value: 'ocpp2.0.1', label: 'OCPP 2.0.1' }], d.ocpp_version ?? 'ocpp1.6')}</select>`)}
    </form>`,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save',
        kind: 'primary',
        async onClick(ctx) {
          const r = await attempt(() => api(`/v1/charge-points/${enc(d.ocpp_identity)}`, { method: 'PUT', body: formValues(ctx.body) }), { success: 'Saved' });
          if (!r) return false;
          dctx.refresh();
        },
      },
    ],
  });
  for (const [k, v] of [['displayName', d.display_name], ['vendor', d.vendor], ['model', d.model], ['serial', d.serial]]) $(`[name=${k}]`, m.body).value = v ?? '';
}

function controlTab(identity) {
  return async (body, ctx) => {
    const d = await api(`/v1/charge-points/${enc(identity)}`);
    const cp = { ...d, connectors: d.connectors.map((k) => ({ ...k, evseNo: k.evse_id, maxPowerW: k.max_power_w, connectorType: k.connector_type })) };
    const canCmd = state.can('charge_point:command');
    if (!canCmd) { body.innerHTML = callout('info', 'Your role does not include remote commands.'); return; }
    body.innerHTML = `
      ${d.online ? '' : callout('warn', '<b>The charger is offline.</b> Commands are sent over its WebSocket, so they will fail until it reconnects.')}
      <div class="section" style="margin-top:6px"><h2>Per connector</h2><div class="grid two" data-guns></div></div>
      <div class="section"><h2>Station</h2><div class="card pad"><div class="row">
        <button class="btn" data-reset>${icon('reboot')} Reboot hardware…</button>
        <button class="btn" data-trigger>${icon('refresh')} Trigger message…</button>
        <button class="btn" data-cache>${icon('card')} Clear authorization cache</button>
        <button class="btn" data-all-out>Set whole station Inoperative…</button>
        <button class="btn" data-all-in>Set whole station Operative</button>
      </div><p class="small muted" style="margin:10px 0 0">Every command is recorded in the audit log with your name.</p></div></div>`;
    $('[data-guns]', body).innerHTML = cp.connectors.map((k, i) => `<div class="card pad" data-i="${i}">
      <div class="row"><b>Gun ${esc(k.evse_id)}</b>${connectorTag(k.status)}<span class="small muted">${esc(k.connector_type ?? '')} · ${esc(fmt.num(k.max_power_w / 1000))} kW</span></div>
      ${k.session_id ? `<div class="small" style="margin:6px 0;color:var(--info)">Transaction <span class="mono">${esc(k.ocpp_transaction_id)}</span> · ${esc(fmt.kwh(k.session_energy_wh))} · started ${esc(fmt.ago(k.session_started_at))}</div>` : '<div class="small muted" style="margin:6px 0">No session.</div>'}
      ${k.maintenance_reason ? `<div class="small" style="color:var(--warn);margin-bottom:6px">Out of service: ${esc(k.maintenance_reason)}</div>` : ''}
      <div class="row">
        ${k.session_id ? `<button class="btn sm danger" data-a="stop">${icon('stop')} Stop</button>` : `<button class="btn sm primary" data-a="start">${icon('play')} Start</button>`}
        <button class="btn sm" data-a="unlock">${icon('unlock')} Unlock cable</button>
        <button class="btn sm" data-a="avail">${k.status === 'Unavailable' || k.maintenance_reason ? 'Make operative' : 'Take out of service'}</button>
      </div></div>`).join('') || callout('info', 'No connectors.');
    $$('[data-guns] [data-i]', body).forEach((card) => {
      const k = cp.connectors[Number(card.dataset.i)];
      card.addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'start') remoteStartDialog(cp, k.evse_id);
        if (a === 'stop') remoteStopDialog(cp, k).then(() => setTimeout(() => ctx.refresh(), 1500));
        if (a === 'unlock') unlockDialog(cp, k.evse_id);
        if (a === 'avail') availabilityDialog(cp, k.evse_id, k.status === 'Unavailable' || !!k.maintenance_reason);
      });
    });
    $('[data-reset]', body).addEventListener('click', () => resetDialog(cp));
    $('[data-trigger]', body).addEventListener('click', () => triggerDialog(cp));
    $('[data-cache]', body).addEventListener('click', () => clearCacheDialog(cp));
    $('[data-all-out]', body).addEventListener('click', () => availabilityDialog(cp, 0, false));
    $('[data-all-in]', body).addEventListener('click', () => availabilityDialog(cp, 0, true));
    const off = onLive((e) => { if (e.payload?.ocppIdentity === identity && /^(connector|session)\./.test(e.kind)) debouncedRefresh(); });
    const debouncedRefresh = debounce(() => ctx.refresh(), 800);
    ctx.cleanup = off;
  };
}

// ------------------------------------------------------------------ Configuration Key Studio (Module 6)

function configTab(identity) {
  return async (body, ctx) => {
    const canEdit = state.can('charge_point:config') || state.can('charge_point:command');
    let category = 'All';
    let q = '';
    let data = null;
    let pendingReboot = false;

    body.innerHTML = `<div class="row" style="margin-bottom:10px">
        <button class="btn primary" data-fetch>${icon('refresh')} Fetch from charger</button>
        <div class="search" style="width:260px">${icon('search')}<input type="search" placeholder="Search keys…" data-q></div>
        <span class="small muted right" data-status></span></div>
      <div class="chips" data-cats style="margin-bottom:10px"></div>
      <div data-reboot></div>
      <div class="card" data-table></div>`;

    const draw = () => {
      const cats = ['All', ...(data?.categories ?? [])];
      $('[data-cats]', body).innerHTML = cats.map((c) => `<button class="btn sm ${c === category ? 'primary' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
      $$('[data-cat]', body).forEach((b) => b.addEventListener('click', () => { category = b.dataset.cat; draw(); }));
      $('[data-status]', body).innerHTML = data?.live ? `${tag('t-ok', 'live')} read just now` : data?.error ? tag('t-warn', data.error) : '';
      $('[data-reboot]', body).innerHTML = pendingReboot || data?.keys?.some((k) => k.rebootRequired)
        ? callout('warn', `<b>Reboot required.</b> The charger accepted a change that only takes effect after a restart. <button class="btn sm" data-reboot-now style="margin-left:8px">${icon('reboot')} Reboot now…</button>`)
        : '';
      $('[data-reboot-now]', body)?.addEventListener('click', () => resetDialog({ ocpp_identity: identity, connectors: [] }));
      const rows = (data?.keys ?? []).filter((k) =>
        (category === 'All' || k.category === category) &&
        (!q || k.key.toLowerCase().includes(q) || (k.description ?? '').toLowerCase().includes(q)));
      table($('[data-table]', body), {
        columns: [
          { label: 'Parameter', width: '26%', render: (k) => `<div class="cell-title mono" style="font-size:12.5px">${esc(k.key)}</div><div class="cell-sub">${esc(k.category)}${k.managed ? ' · provisioned by PlugSure' : ''}${!k.reported ? ' · not reported by this charger' : ''}</div>` },
          { label: 'Current value', width: '30%', render: (k, i) => k.writeOnly ? '<span class="muted small">write-only — set from the Security tab</span>'
            : `<input class="mono" style="width:100%" data-val="${i}" ${k.readonly || !canEdit || !k.reported ? 'disabled' : ''}>${k.unit ? `<div class="cell-sub">${esc(k.unit)} · ${esc(k.type)}</div>` : `<div class="cell-sub">${esc(k.type)}</div>`}` },
          { label: 'Access', render: (k) => (k.readonly ? tag('t-mute', 'Read-only') : tag('t-info', 'Read-Write')) },
          { label: 'Description', render: (k) => `<div class="wrap small" style="max-width:48ch">${esc(k.description)}</div>` },
          { label: '', render: (k, i) => (k.readonly || k.writeOnly || !canEdit || !k.reported ? '' : `<button class="btn sm" data-save="${i}">Save</button>`)
              + (k.lastStatus ? `<div style="margin-top:4px">${tag(k.lastStatus === 'Accepted' ? 't-ok' : k.lastStatus === 'RebootRequired' ? 't-warn' : 't-crit', k.lastStatus)}</div>` : '') },
        ],
        rows,
        empty: data ? 'No keys match.' : 'Press "Fetch from charger" to read its configuration.',
      });
      $$('[data-val]', body).forEach((inp) => { const k = rows[Number(inp.dataset.val)]; inp.value = k.value ?? ''; });
      $$('[data-save]', body).forEach((b) => b.addEventListener('click', async () => {
        const k = rows[Number(b.dataset.save)];
        const value = $(`[data-val="${b.dataset.save}"]`, body).value;
        b.classList.add('busy');
        try {
          const r = await api(`/v1/charge-points/${enc(identity)}/config`, { method: 'PUT', body: { key: k.key, value } });
          k.value = value; k.lastStatus = r.status; k.rebootRequired = r.rebootRequired;
          if (r.rebootRequired) pendingReboot = true;
          toast(`${k.key}: ${r.status}`, r.ok ? 'ok' : 'warn');
        } catch (e) { toast(e.message, 'crit'); }
        b.classList.remove('busy');
        draw();
      }));
    };

    const load = async (refresh) => {
      $('[data-fetch]', body).classList.add('busy');
      try { data = await api(`/v1/charge-points/${enc(identity)}/config?refresh=${refresh ? 1 : 0}`); }
      catch (e) { toast(e.message, 'crit'); }
      $('[data-fetch]', body).classList.remove('busy');
      draw();
    };
    $('[data-fetch]', body).addEventListener('click', () => load(true));
    $('[data-q]', body).addEventListener('input', debounce((e) => { q = e.target.value.trim().toLowerCase(); draw(); }, 150));
    await load(false);
  };
}

// ------------------------------------------------------------------ Device model (OCPP 2.0.1)

const SEVERITY = ['Danger', 'Hardware failure', 'System failure', 'Critical', 'Error', 'Alert', 'Warning', 'Notice', 'Informational', 'Debug'];
const compLabel = (c) => c.name === 'EVSE' && c.evseId && !c.instance ? `EVSE ${c.evseId}`
  : `${c.name}${c.instance ? ` (${c.instance})` : ''}${c.evseId ? ` · EVSE ${c.evseId}${c.connectorId ? ` / connector ${c.connectorId}` : ''}` : ''}`;
const varLabel = (v) => `${v.name}${v.instance ? ` (${v.instance})` : ''}`;
const keyBody = (c, v) => ({
  component: c.name, componentInstance: c.instance || undefined, evseId: c.evseId || undefined, connectorId: c.connectorId || undefined,
  variable: v.name, variableInstance: v.instance || undefined,
});
function rangeText(ch) {
  if (!ch) return '';
  const parts = [ch.dataType];
  if (ch.unit) parts.push(ch.unit);
  if (ch.minLimit != null || ch.maxLimit != null) parts.push(`${ch.minLimit ?? '…'} to ${ch.maxLimit ?? '…'}`);
  if (ch.valuesList?.length) parts.push(ch.valuesList.slice(0, 6).join(' | ') + (ch.valuesList.length > 6 ? ' …' : ''));
  return parts.join(' · ');
}
function valueInput(v, attr, i, editable) {
  const ch = v.characteristics;
  const val = attr?.value ?? '';
  const dis = editable ? '' : 'disabled';
  if (ch?.dataType === 'boolean' || ch?.dataType === 'OptionList' && ch.valuesList?.length) {
    const opts = ch.dataType === 'boolean' ? ['true', 'false'] : ch.valuesList;
    return `<select data-dv="${i}" ${dis}>${(opts.includes(val) ? opts : [val, ...opts]).map((o) => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  return `<input class="mono" style="width:100%" data-dv="${i}" value="${esc(val)}" ${dis} ${ch?.dataType === 'integer' || ch?.dataType === 'decimal' ? 'inputmode="decimal"' : ''}>`;
}

function monitorDialog(identity, c, v, done) {
  modal({
    title: `Monitor ${varLabel(v)}`,
    subtitle: `${compLabel(c)} — the station sends an event when the monitor triggers; an alerting event raises an alert here, and clears it when the value is back.`,
    body: `<form class="form" novalidate>
      ${field('Type', `<select name="type">${options([
        { value: 'UpperThreshold', label: 'Upper threshold — above a value' }, { value: 'LowerThreshold', label: 'Lower threshold — below a value' },
        { value: 'Delta', label: 'Delta — changes by more than' }, { value: 'Periodic', label: 'Periodic — every N seconds' },
        { value: 'PeriodicClockAligned', label: 'Clock-aligned — every N seconds on the clock' }], 'UpperThreshold')}</select>`)}
      ${field(`Value${v.characteristics?.unit ? ` (${esc(v.characteristics.unit)})` : ''}`, '<input name="value" inputmode="decimal" required>', { help: 'The limit, the change, or the interval in seconds.' })}
      ${field('Severity', `<select name="severity">${options(SEVERITY.map((s, n) => ({ value: n, label: `${n} · ${s}` })), 4)}</select>`, { help: 'Stations usually send 0–4 at once and queue the rest.' })}
      ${field('Only during a session', '<select name="transaction"><option value="">No — always</option><option value="1">Yes</option></select>')}
    </form>`,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Add monitor',
        kind: 'primary',
        async onClick(ctx) {
          const f = formValues(ctx.body);
          if (f.value === '' || !Number.isFinite(Number(f.value))) { fieldErrors(ctx.body, { value: 'Enter a number' }); return false; }
          const r = await attempt(() => api(`/v1/charge-points/${enc(identity)}/device-model/monitors`, {
            method: 'POST', body: { ...keyBody(c, v), type: f.type, value: Number(f.value), severity: Number(f.severity), transaction: f.transaction === '1' },
          }));
          if (!r) return false;
          toast(r.ok ? `Monitor ${r.id} added` : `The station answered ${r.status}${r.reason ? ` (${r.reason})` : ''}`, r.ok ? 'ok' : 'warn');
          done();
        },
      },
    ],
  });
}

function deviceModelTab(identity) {
  return async (body, ctx) => {
    const canEdit = state.can('charge_point:config') || state.can('charge_point:command');
    let d = await api(`/v1/charge-points/${enc(identity)}/device-model`);
    if (!d.supported) {
      body.innerHTML = callout('info', 'The device model is an OCPP 2.0.1 feature. This charger speaks OCPP 1.6 — its settings are on the <b>Configuration</b> tab.');
      return;
    }
    let q = '';
    let open = new Set();
    let poll = null;
    ctx.cleanup = () => clearTimeout(poll);

    body.innerHTML = `<div class="row" style="margin-bottom:10px">
        ${canEdit ? `<select data-base title="What to ask for">${options([{ value: 'FullInventory', label: 'Full inventory' }, { value: 'ConfigurationInventory', label: 'Configurable only' }, { value: 'SummaryInventory', label: 'Summary (problems)' }], 'FullInventory')}</select>
        <button class="btn primary" data-report>${icon('refresh')} Request report</button>
        <button class="btn" data-mreport>Monitoring report</button>` : ''}
        <div class="search" style="width:240px">${icon('search')}<input type="search" placeholder="Search components and variables…" data-q></div>
        <span class="small muted right" data-status></span></div>
      <div data-note></div>
      <div data-comps></div>
      <div class="section"><h2>Monitors</h2><div class="card" data-mons></div></div>`;

    const reportState = () => {
      const r = d.reports[0];
      if (!r) return '';
      const when = fmt.time(r.completedAt ?? r.requestedAt);
      const kind = r.kind === 'monitoring' ? 'Monitoring report' : 'Report';
      if (r.status === 'requested') return `${tag('t-info', 'requested')} ${kind} asked ${esc(when)} — waiting for the station`;
      if (r.status === 'receiving') return `${tag('t-info', 'receiving')} ${fmt.num(r.items)} items so far`;
      if (r.status === 'complete') return `${tag('t-ok', 'complete')} ${kind}: ${fmt.num(r.items)} items · ${esc(when)}`;
      return `${tag(r.status === 'empty' ? 't-mute' : 't-warn', r.status)} ${esc(r.note ?? kind)} · ${esc(when)}`;
    };

    const draw = () => {
      $('[data-status]', body).innerHTML = `${d.online ? '' : `${tag('t-warn', 'offline')} `}${reportState()}`;
      $('[data-note]', body).innerHTML = !d.variables
        ? callout('info', `Nothing reported yet. ${canEdit ? 'Press <b>Request report</b>: the station sends its components and variables in parts (NotifyReport), which appear here as they arrive.' : 'An operator can request a report from the station.'}`)
        : '';
      const needle = q.toLowerCase();
      const comps = d.components.map((c) => ({
        c,
        vars: c.variables.filter((v) => !needle || compLabel(c).toLowerCase().includes(needle) || varLabel(v).toLowerCase().includes(needle)),
      })).filter((x) => x.vars.length);
      const flat = [];
      $('[data-comps]', body).innerHTML = comps.map(({ c, vars }) => {
        const key = compLabel(c);
        return `<details class="card" style="margin-bottom:8px" data-comp="${esc(key)}" ${open.has(key) || needle ? 'open' : ''}>
          <summary style="padding:10px 14px;cursor:pointer"><b>${esc(key)}</b> <span class="muted small">${vars.length} variable${vars.length === 1 ? '' : 's'}</span></summary>
          <div class="table-wrap"><table class="t" style="table-layout:fixed"><thead><tr><th style="width:22%">Variable</th><th style="width:28%">Value</th><th style="width:25%">Type</th><th style="width:11%">Access</th><th style="width:14%"></th></tr></thead><tbody>
          ${vars.map((v) => {
            const i = flat.push({ c, v }) - 1;
            const attr = v.attributes.find((a) => a.type === 'Actual') ?? v.attributes[0];
            const ro = attr?.mutability === 'ReadOnly' || attr?.constant;
            const editable = canEdit && d.online && !ro && !v.protected;
            const others = v.attributes.filter((a) => a !== attr && a.value != null).map((a) => `${a.type} ${a.value}`).join(' · ');
            return `<tr><td><div class="cell-title mono" style="font-size:12.5px">${esc(varLabel(v))}</div>${others ? `<div class="cell-sub">${esc(others)}</div>` : ''}</td>
              <td>${attr?.mutability === 'WriteOnly' ? '<span class="muted small">write-only</span>' : valueInput(v, attr, i, editable)}</td>
              <td class="small">${esc(rangeText(v.characteristics)) || '<span class="muted">—</span>'}</td>
              <td>${v.protected ? tag('t-mute', 'Protected') : ro ? tag('t-mute', 'Read-only') : attr?.mutability === 'WriteOnly' ? tag('t-info', 'Write-only') : tag('t-info', 'Read-Write')}</td>
              <td><div style="display:flex;flex-wrap:wrap;gap:4px">${editable ? `<button class="btn sm" data-dsave="${i}">Save</button>` : ''}${canEdit && d.online ? `<button class="btn sm ghost" data-dread="${i}" title="Read the current value (GetVariables)">${icon('refresh')}</button>` : ''}${canEdit && d.online && v.characteristics?.supportsMonitoring ? `<button class="btn sm ghost" data-dmon="${i}">Monitor…</button>` : ''}</div></td></tr>`;
          }).join('')}</tbody></table></div></details>`;
      }).join('') || (d.variables ? '<p class="muted small">No component or variable matches.</p>' : '');

      $$('details[data-comp]', body).forEach((el) => el.addEventListener('toggle', () => { el.open ? open.add(el.dataset.comp) : open.delete(el.dataset.comp); }));
      $$('[data-dsave]', body).forEach((b) => b.addEventListener('click', async () => {
        const { c, v } = flat[Number(b.dataset.dsave)];
        const value = $(`[data-dv="${b.dataset.dsave}"]`, body).value;
        b.classList.add('busy');
        const r = await attempt(() => api(`/v1/charge-points/${enc(identity)}/device-model/variable`, { method: 'PUT', body: { ...keyBody(c, v), value } }));
        b.classList.remove('busy');
        if (!r) return;
        toast(`${r.label}: ${r.status}${r.reason ? ` (${r.reason})` : ''}${r.rebootRequired ? ' — takes effect after a reboot' : ''}`, r.ok ? 'ok' : 'warn');
        await reload();
      }));
      $$('[data-dread]', body).forEach((b) => b.addEventListener('click', async () => {
        const { c, v } = flat[Number(b.dataset.dread)];
        b.classList.add('busy');
        const r = await attempt(() => api(`/v1/charge-points/${enc(identity)}/device-model/get`, { method: 'POST', body: { items: [keyBody(c, v)] } }));
        b.classList.remove('busy');
        const res = r?.results?.[0];
        if (res) toast(res.status === 'Accepted' ? `${res.label} = ${res.value ?? '(empty)'}` : `${res.label}: ${res.status}`, res.status === 'Accepted' ? 'ok' : 'warn');
        await reload();
      }));
      $$('[data-dmon]', body).forEach((b) => b.addEventListener('click', () => {
        const { c, v } = flat[Number(b.dataset.dmon)];
        monitorDialog(identity, c, v, reload);
      }));

      table($('[data-mons]', body), {
        columns: [
          { label: 'Id', num: true, render: (m) => esc(m.id) },
          { label: 'Watches', render: (m) => `<div class="mono small">${esc(compLabel({ name: m.component, instance: m.componentInstance, evseId: m.evseId, connectorId: m.connectorId }))}.${esc(varLabel({ name: m.variable, instance: m.variableInstance }))}</div>` },
          { label: 'Type', render: (m) => esc(m.type) + (m.transaction ? ' <span class="muted small">· during sessions</span>' : '') },
          { label: 'Value', num: true, render: (m) => esc(fmt.num(m.value)) },
          { label: 'Severity', render: (m) => tag(m.severity <= 3 ? 't-crit' : m.severity <= 6 ? 't-warn' : 't-mute', `${m.severity} · ${SEVERITY[m.severity] ?? ''}`) },
          { label: 'Kind', render: (m) => `<span class="small">${esc((m.kind ?? '—').replace(/Monitor$/, ''))}</span>` },
          { label: '', render: (m) => (canEdit && d.online && m.kind !== 'HardWiredMonitor' ? `<button class="btn sm ghost" data-mdel="${esc(m.id)}">Remove</button>` : '') },
        ],
        rows: d.monitors,
        empty: canEdit ? 'No monitors known. "Monitoring report" asks the station for the ones it has; "Monitor…" on a variable adds one.' : 'No monitors known.',
      });
      $$('[data-mdel]', body).forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Remove monitor ${b.dataset.mdel}?`, message: 'The station stops watching this variable (ClearVariableMonitoring).', confirmLabel: 'Remove', danger: true }))) return;
        const r = await attempt(() => api(`/v1/charge-points/${enc(identity)}/device-model/monitors/${enc(b.dataset.mdel)}`, { method: 'DELETE' }));
        if (r) toast(r.ok ? 'Monitor removed' : `The station answered ${r.status}`, r.ok ? 'ok' : 'warn');
        await reload();
      }));
    };

    // While a report is arriving, look again every 2 s (for up to a minute).
    let polls = 0;
    const watch = () => {
      clearTimeout(poll);
      if (!['requested', 'receiving'].includes(d.reports[0]?.status) || polls > 30) return;
      poll = setTimeout(async () => { polls += 1; await reload(); }, 2000);
    };
    const reload = async () => {
      try { d = await api(`/v1/charge-points/${enc(identity)}/device-model`); } catch (e) { toast(e.message, 'crit'); }
      if (!body.isConnected) return;
      draw();
      watch();
    };
    const request = async (btn, path, payload) => {
      btn.classList.add('busy');
      const r = await attempt(() => api(`/v1/charge-points/${enc(identity)}/device-model/${path}`, { method: 'POST', body: payload }));
      btn.classList.remove('busy');
      if (!r) return;
      toast(r.state === 'requested' ? 'Asked — the answer arrives in parts' : `The station answered ${r.status}`, r.state === 'requested' ? 'ok' : 'warn');
      polls = 0;
      await reload();
    };
    $('[data-report]', body)?.addEventListener('click', (e) => request(e.currentTarget, 'report', { reportBase: $('[data-base]', body).value }));
    $('[data-mreport]', body)?.addEventListener('click', (e) => request(e.currentTarget, 'monitoring-report', {}));
    $('[data-q]', body).addEventListener('input', debounce((e) => { q = e.target.value.trim(); draw(); }, 150));
    draw();
    watch();
  };
}

// ------------------------------------------------------------------ Security

function securityTab(identity) {
  return async (body, ctx) => {
    const d = await api(`/v1/charge-points/${enc(identity)}`);
    const canWrite = state.can('charge_point:write');
    const p = Number(d.security_profile);
    const f = state.me.features ?? {};
    body.innerHTML = `
      <div class="grid k3">
        ${kpi('Enforced profile', `Profile ${p}`, ['No authentication', 'Basic auth over plain ws://', 'Basic auth over TLS', 'Mutual TLS (client certificate)'][p] ?? '', p >= 2 ? 'ok' : 'crit')}
        ${kpi('Authorization key', d.has_auth_key ? 'Provisioned' : 'None', d.auth_key_rotated_at ? `issued ${esc(fmt.date(d.auth_key_rotated_at))}${d.key_rotation_days ? ` · rotate every ${esc(d.key_rotation_days)} days` : ''}` : 'never issued', d.has_auth_key ? '' : p >= 1 && p < 3 ? 'crit' : '')}
        ${kpi('Client certificate', d.client_cert_fingerprint ? 'Bound' : 'None', d.client_cert_fingerprint ? `<span class="mono">${esc(d.client_cert_fingerprint.slice(0, 16))}…</span>` : 'required for profile 3', d.client_cert_fingerprint ? '' : p >= 3 ? 'crit' : '')}
      </div>
      ${canWrite ? `
      <div class="section"><h2>Profile 1–2 · Authorization key</h2><div class="card pad">
        <p class="small muted" style="margin-top:0">Issue (or rotate) the per-charger key. The previous key keeps working for a grace window so a unit that has not applied the change yet can still connect. <b>Set the key on the charger first, then raise the profile.</b></p>
        <div class="form">
          ${field('Key', '<input name="key" class="mono" placeholder="Leave empty to auto-generate" autocomplete="off">', { help: 'Optional: 16–40 letters and digits.' })}
          ${field('Rotation reminder', `<select name="rotationDays">${options([{ value: '', label: 'Keep current' }, { value: 30, label: '30 days' }, { value: 90, label: '90 days' }, { value: 180, label: '180 days' }, { value: 365, label: '365 days' }], '')}</select>`)}
        </div>
        ${d.has_auth_key ? `<label class="check" style="margin-top:10px"><input type="checkbox" name="compromised"> <span>Old key is compromised — revoke it immediately</span></label>
        <p class="small muted" style="margin:4px 0 0">No grace window: the old key stops working at once, and the charger cannot connect until the new key is set on it.</p>` : ''}
        <div class="row" style="margin-top:12px"><button class="btn primary" data-issue>${icon('key')} ${d.has_auth_key ? 'Rotate key' : 'Issue key'}</button>
          <button class="btn" data-export>${icon('download')} Commissioning export (without key)</button></div>
        <div data-issued></div></div></div>
      <div class="section"><h2>Profile 3 · Client certificate (mutual TLS)</h2><div class="card pad">
        <div class="row"><button class="btn" data-vault ${f.vault ? '' : 'disabled title="Set VAULT_ADDR / VAULT_TOKEN to enable"'}>${icon('shield')} Issue from Vault PKI</button>
          <span class="small muted">${f.vault ? 'Issues a certificate for this identity and binds its fingerprint.' : 'Vault PKI is not configured on this deployment — paste a certificate instead.'}</span></div>
        <div class="form" style="margin-top:12px">
          ${field('Certificate (PEM) or SHA-256 fingerprint', '<textarea name="cert" rows="4" placeholder="-----BEGIN CERTIFICATE----- … or AB:CD:…"></textarea>', { full: true })}
        </div>
        <div class="row" style="margin-top:8px"><button class="btn" data-bind>Bind certificate</button>${d.client_cert_fingerprint ? '<button class="btn ghost" data-unbind>Remove binding</button>' : ''}</div>
        <div data-cert></div></div></div>
      <div class="section"><h2>Enforced security profile</h2><div class="card pad">
        <div class="row">${[0, 1, 2, 3].map((n) => `<button class="btn ${n === p ? 'primary' : ''}" data-prof="${n}">Profile ${n}</button>`).join('')}</div>
        <p class="small muted" style="margin-bottom:0">Raising the profile is refused until the matching credential exists — the safeguard that keeps a field unit from being locked out. Profile 2+ requires TLS at the gateway or proxy.</p>
      </div></div>` : callout('info', 'Your role can view but not change charger security.')}`;
    if (!canWrite) return;
    $('[data-issue]', body).addEventListener('click', async () => {
      const v = formValues(body);
      // A compromised key is revoked with no grace window (the server records the reason in
      // the audit log), which takes the charger offline until it has the new key: confirm.
      const compromised = v.compromised === true;
      if (compromised && !(await confirmDialog({
        title: 'Revoke the old key immediately?',
        message: 'The current key stops working now, with no grace window. The charger is refused until the new key is configured on it.',
        confirmLabel: 'Rotate and revoke',
        danger: true,
      }))) return;
      const r = await attempt(() => api(`/v1/charge-points/${enc(identity)}/keys`, { method: 'POST', body: { profile: Math.max(1, Math.min(2, p || 2)), key: v.key || undefined, rotationDays: v.rotationDays || undefined, ...(compromised ? { reason: 'compromised' } : {}) } }));
      if (!r) return;
      $('[data-issued]', body).replaceChildren(credentialPanel(identity, r));
      toast(compromised ? 'Key issued — shown once. The old key is revoked.' : 'Key issued — shown once', 'ok');
    });
    $('[data-export]', body).addEventListener('click', async () => {
      const r = await attempt(() => api(`/v1/charge-points/${enc(identity)}/commissioning-export`));
      if (r) $('[data-issued]', body).replaceChildren(credentialPanel(identity, { commissioning: r }));
    });
    $('[data-vault]', body).addEventListener('click', async () => {
      const r = await attempt(() => api(`/v1/charge-points/${enc(identity)}/keys`, { method: 'POST', body: { profile: 3, method: 'vault' } }));
      if (r) $('[data-cert]', body).replaceChildren(certBundlePanel(identity, r));
    });
    $('[data-bind]', body).addEventListener('click', async () => {
      const t = $('[name=cert]', body).value.trim();
      const bodyJson = t.includes('BEGIN CERTIFICATE') ? { profile: 3, certificatePem: t } : { profile: 3, fingerprint: t };
      if (await attempt(() => api(`/v1/charge-points/${enc(identity)}/keys`, { method: 'POST', body: bodyJson }), { success: 'Certificate bound' })) ctx.refresh();
    });
    $('[data-unbind]', body)?.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Remove certificate binding?', message: 'A charger on profile 3 can no longer connect until a new certificate is bound.', danger: true, confirmLabel: 'Remove' }))) return;
      if (await attempt(() => api(`/v1/charge-points/${enc(identity)}/client-certificate`, { method: 'PUT', body: { fingerprint: '' } }), { success: 'Binding removed' })) ctx.refresh();
    });
    $$('[data-prof]', body).forEach((b) => b.addEventListener('click', async () => {
      const n = Number(b.dataset.prof);
      if (n === p) return;
      if (n < 2 && !(await confirmDialog({ title: `Lower to profile ${n}?`, message: n === 0 ? 'The charger will be accepted with NO authentication. Bench use only.' : 'The key will cross the network unencrypted.', danger: true, confirmLabel: `Set profile ${n}` }))) return;
      if (await attempt(() => api(`/v1/charge-points/${enc(identity)}/security-profile`, { method: 'PUT', body: { profile: n } }), { success: `Profile ${n} enforced` })) ctx.refresh();
    }));
  };
}

function connectorsTab(identity) {
  return async (body, ctx) => {
    const d = await api(`/v1/charge-points/${enc(identity)}`);
    if (!state.can('charge_point:write')) {
      body.innerHTML = '<div class="card" data-t></div>';
      table($('[data-t]', body), {
        columns: [
          { label: 'EVSE', render: (k) => esc(`${k.evse_id}.${k.connector_id}`) },
          { label: 'Plug', render: (k) => esc(k.connector_type ?? '—') },
          { label: 'Power', num: true, render: (k) => esc(fmt.kw(k.max_power_w)) },
          { label: 'Meter', render: (k) => `${esc(k.meter_serial ?? '—')} · class ${esc(k.meter_accuracy_class ?? '—')}` },
          { label: 'Tera', render: (k) => `${teraTag(k.tera_status)} ${esc(fmt.date(k.tera_due_at))}` },
        ],
        rows: d.connectors,
      });
      return;
    }
    body.innerHTML = `<p class="small muted" style="margin-top:0">Edit the EVSE and connector architecture: plug standard, nameplate and metrology data. Connectors are never deleted (sessions reference them).</p>
      <div data-builder></div><div class="row" style="margin-top:12px"><button class="btn primary" data-save>Save connectors</button></div>`;
    const b = evseBuilder($('[data-builder]', body), { evses: evsesFromConnectors(d.connectors), ocppVersion: d.ocpp_version ?? 'ocpp1.6' });
    $('[data-save]', body).addEventListener('click', async () => {
      if (await attempt(() => api(`/v1/charge-points/${enc(identity)}/evses`, { method: 'PUT', body: { evses: b.value() } }), { success: 'Connectors saved' })) ctx.refresh();
    });
  };
}

function sessionsTab(identity) {
  return async (body) => {
    if (!state.can('session:read')) { body.innerHTML = callout('info', 'Your role cannot view sessions.'); return; }
    const r = await api(`/v1/sessions/search?identity=${enc(identity)}&limit=50`);
    body.innerHTML = '<div class="card" data-t></div>';
    table($('[data-t]', body), {
      columns: [
        { label: 'Started', render: (s) => `<span class="nowrap">${esc(fmt.time(s.started_at))}</span>` },
        { label: 'Gun', render: (s) => esc(s.evse_no) },
        { label: 'Card', render: (s) => `<span class="mono">${esc(s.id_tag ?? '—')}</span>` },
        { label: 'State', render: (s) => tag(s.state === 'active' ? 't-info' : s.state === 'rated' ? 't-ok' : 't-mute', s.state) },
        { label: 'Energy', num: true, render: (s) => esc(fmt.kwh(s.energy_wh)) },
        { label: 'Duration', num: true, render: (s) => esc(fmt.dur(s.duration_s)) },
        { label: 'Stop reason', render: (s) => esc(s.stop_reason ?? '—') },
        { label: 'Total', num: true, render: (s) => `<b>${esc(fmt.idr(s.total_idr))}</b>` },
      ],
      rows: r.rows,
      empty: 'No sessions on this charger yet.',
      onRow: (s) => window.open(`/v1/sessions/${enc(s.id)}/receipt`, '_blank', 'noopener'),
    });
  };
}

export function openChargerDrawer(identity, initial = 'overview') {
  const tabs = [
    { id: 'overview', label: 'Overview', render: overviewTab(identity) },
    { id: 'control', label: 'Remote control', render: controlTab(identity) },
    { id: 'config', label: 'Configuration', render: configTab(identity) },
    { id: 'device', label: 'Device model', render: deviceModelTab(identity) },
    { id: 'security', label: 'Security', render: securityTab(identity) },
    { id: 'connectors', label: 'Connectors', render: connectorsTab(identity) },
    { id: 'sessions', label: 'Sessions', render: sessionsTab(identity) },
  ].filter((t) => !inPortal() || ['overview', 'connectors', 'sessions'].includes(t.id));
  // Site Owner portal: read-only — no remote control, configuration or security tabs.
  // Closing the drawer returns the URL to the list without re-rendering it.
  const onClose = () => { if (location.hash.startsWith('#/chargers/')) history.replaceState(null, '', '#/chargers'); };
  return drawer({ title: identity, tabs, initial, onClose });
}

// ------------------------------------------------------------------ fleet view

registerView('chargers', {
  title: 'Charge points',
  icon: 'charger',
  group: 'operate',
  order: 2,
  perm: 'charge_point:read',
  // Also shown in the Site Owner portal (read-only, the owner's own sites).
  portal: true,
  async render(root, [param]) {
    const preset = param === '~faulted' ? 'faulted' : '';
    root.innerHTML = pageHead(
      'Charge points',
      'Every charger across your sites. Offline is not the same as faulted: the connectivity column separates a dropped link from broken hardware.',
      state.can('charge_point:write') ? `<a class="btn primary" href="#/onboard">${icon('plus')} Add charge point</a>` : '',
    ) + `<div class="grid k4" data-kpis></div>
      <div class="filters section">
        ${field('Search', '<input type="search" data-f="q" placeholder="Identity, name, model…">')}
        ${field('Site', '<select data-f="site"><option value="">All sites</option></select>')}
        ${field('State', `<select data-f="state">${options([{ value: '', label: 'Any' }, { value: 'online', label: 'Online' }, { value: 'offline', label: 'Offline' }, { value: 'charging', label: 'Charging' }, { value: 'faulted', label: 'Faulted' }, { value: 'pending', label: 'Pending adoption' }, { value: 'suspended', label: 'Suspended' }, { value: 'decommissioned', label: 'Decommissioned' }], preset)}</select>`)}
      </div>
      <div class="card" data-list></div>`;
    const siteSel = $('[data-f=site]', root);
    (await loadSites()).forEach((s) => siteSel.append(new Option(s.name, s.id)));

    let rows = [];
    const draw = () => {
      const q = $('[data-f=q]', root).value.trim().toLowerCase();
      const site = siteSel.value;
      const st = $('[data-f=state]', root).value;
      const list = rows.filter((c) =>
        (!q || [c.ocpp_identity, c.display_name, c.model, c.vendor, c.serial].some((x) => String(x ?? '').toLowerCase().includes(q))) &&
        (!site || c.site_id === site) &&
        (st !== 'decommissioned' ? c.status !== 'decommissioned' : true) &&
        (!st || (st === 'online' && c.online) || (st === 'offline' && !c.online) || (st === 'pending' && c.status === 'pending_adoption') ||
          (st === 'decommissioned' && c.status === 'decommissioned') ||
          (st === 'suspended' && c.status === 'suspended') ||
          (st === 'charging' && c.connectors.some((k) => k.status === 'Charging')) ||
          (st === 'faulted' && (c.status === 'faulted' || c.connectors.some((k) => k.status === 'Faulted')))));
      const active = rows.filter((c) => c.status !== 'decommissioned');
      const conns = active.flatMap((c) => c.connectors);
      $('[data-kpis]', root).innerHTML = [
        kpi('Online', `${fmt.num(active.filter((c) => c.online).length)} / ${fmt.num(active.length)}`, 'charge points connected now'),
        kpi('Charging', fmt.num(conns.filter((k) => k.status === 'Charging').length), `${fmt.num(conns.length)} connectors`),
        kpi('Faulted', fmt.num(conns.filter((k) => k.status === 'Faulted').length), 'connectors reporting a fault', conns.some((k) => k.status === 'Faulted') ? 'crit' : 'ok'),
        kpi('Blocked by metrology', fmt.num(conns.filter((k) => ['lapsed', 'pending'].includes(k.teraStatus)).length), 'tera lapsed or pending calibration', conns.some((k) => ['lapsed', 'pending'].includes(k.teraStatus)) ? 'warn' : ''),
      ].join('');
      const canCmd = state.can('charge_point:command');
      table($('[data-list]', root), {
        columns: [
          { label: 'Charge point', render: (c) => `<div class="cell-title">${esc(c.display_name || c.ocpp_identity)}</div><div class="cell-sub mono">${esc(c.ocpp_identity)}</div><div class="cell-sub">${esc(c.firmware ?? '')}</div>` },
          { label: 'Model', render: (c) => `${esc(c.vendor ?? '—')}<div class="cell-sub">${esc(c.model ?? '')}</div>` },
          { label: 'Site', render: (c) => esc(c.site_name) },
          { label: 'State', render: (c) => `${onlineTag(c.online, c.status)}<div class="cell-sub">${esc(c.negotiatedVersion ?? c.ocpp_version ?? '')}</div>` },
          { label: 'Connectivity', render: connectivity },
          { label: 'Security', render: security },
          { label: 'Connectors', render: connectorsCell },
          {
            label: '',
            render: (c) => c.status === 'pending_adoption' && state.can('charge_point:write')
              ? `<button class="btn sm primary" data-act="activate">Activate</button>`
              : canCmd && c.online ? `<div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-act="start" title="Remote start" aria-label="Remote start">${icon('play')}</button><button class="btn sm" data-act="reset" title="Reboot" aria-label="Reboot">${icon('reboot')}</button></div>` : '',
          },
        ],
        rows: list,
        empty: rows.length ? 'No charge points match the filters.' : 'No charge points yet. Use "Add charge point" to onboard the first one.',
        onRow: (c) => navigate(`#/chargers/${enc(c.ocpp_identity)}`),
      });
      $$('[data-list] tbody tr', root).forEach((tr) => {
        const c = list[Number(tr.dataset.i)];
        if (!c) return;
        tr.querySelector('[data-act=start]')?.addEventListener('click', () => remoteStartDialog(c, c.connectors[0]?.evseNo ?? 1));
        tr.querySelector('[data-act=reset]')?.addEventListener('click', () => resetDialog(c));
        tr.querySelector('[data-act=activate]')?.addEventListener('click', async () => {
          if (await attempt(() => api(`/v1/charge-points/${enc(c.ocpp_identity)}/activate`, { method: 'POST' }), { success: `${c.ocpp_identity} activated` })) load();
        });
      });
    };
    const load = async () => { rows = await api('/v1/charge-points'); draw(); };
    $$('[data-f]', root).forEach((i) => i.addEventListener('input', debounce(draw, 120)));
    await load();
    if (param && param !== '~faulted') openChargerDrawer(param);
    const reload = debounce(() => load().catch(() => {}), 1000);
    const off = onLive((e) => { if (/^(connector|charge_point|session)\./.test(e.kind)) reload(); });
    const t = setInterval(() => load().catch(() => {}), 20_000);
    return () => { off(); clearInterval(t); };
  },
});
