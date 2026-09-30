import {
  $, $$, esc, api, attempt, registerView, pageHead, table, tag, icon, fmt, field, options, callout, download, debounce, toast,
} from '../core.js';

/**
 * OCPP frame log (with a live tail) and the hash-chained audit log.
 * Frame payloads are whatever the charger sent: always escaped, never parsed as markup.
 */

const LIVE_CAP = 500;
const MSG_TYPE = { 2: ['t-info', 'CALL'], 3: ['t-ok', 'RESULT'], 4: ['t-crit', 'ERROR'] };
const msgTag = (t) => { const d = MSG_TYPE[Number(t)]; return d ? tag(d[0], `${t} ${d[1]}`, '', true) : tag('t-mute', String(t ?? '?'), '', true); };
const dirTag = (d) =>
  d === 'in' ? tag('t-info', 'in', 'Charger → CSMS')
  : d === 'out' ? tag('t-warn', 'out', 'CSMS → charger')
  : tag('t-mute', d ?? '?');

const COMMON_ACTIONS = [
  'BootNotification', 'Heartbeat', 'StatusNotification', 'Authorize', 'StartTransaction', 'StopTransaction', 'MeterValues',
  'DataTransfer', 'RemoteStartTransaction', 'RemoteStopTransaction', 'Reset', 'UnlockConnector', 'ChangeAvailability',
  'ChangeConfiguration', 'GetConfiguration', 'TriggerMessage', 'SetChargingProfile', 'ClearChargingProfile',
  'GetCompositeSchedule', 'UpdateFirmware', 'FirmwareStatusNotification', 'GetDiagnostics', 'DiagnosticsStatusNotification',
  'SendLocalList', 'GetLocalListVersion', 'SecurityEventNotification', 'SignCertificate', 'TransactionEvent', 'NotifyReport',
];

/** Collapsible JSON: the summary is a one-line preview, the body the full pretty-printed value. */
function jsonCell(v) {
  if (v == null) return '<span class="muted">—</span>';
  let full;
  try { full = typeof v === 'string' ? v : JSON.stringify(v, null, 2); } catch { full = String(v); }
  let flat;
  try { flat = typeof v === 'string' ? v : JSON.stringify(v); } catch { flat = String(v); }
  const preview = flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
  if (flat.length <= 90) return `<pre class="json">${esc(flat)}</pre>`;
  return `<details><summary class="mono small" style="cursor:pointer;word-break:break-all">${esc(preview)}</summary><pre class="json">${esc(full)}</pre></details>`;
}

const csvCell = (v) => {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

/** datetime-local (browser local time) -> ISO string for the API. */
const toIso = (v) => { if (!v) return ''; const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : ''; };

// ------------------------------------------------------------------ OCPP log

registerView('logs', {
  title: 'OCPP log',
  icon: 'terminal',
  group: 'maintain',
  order: 31,
  perm: 'charge_point:read',
  async render(root, [identity]) {
    const cps = await api('/v1/charge-points').catch(() => []);
    const cpOpts = cps
      .slice()
      .sort((a, b) => String(a.ocpp_identity).localeCompare(String(b.ocpp_identity)))
      .map((c) => ({ value: c.ocpp_identity, label: c.display_name && c.display_name !== c.ocpp_identity ? `${c.ocpp_identity} — ${c.display_name}` : c.ocpp_identity }));
    if (identity && !cpOpts.some((o) => o.value === identity)) cpOpts.unshift({ value: identity, label: identity });

    root.innerHTML = pageHead(
      'OCPP message log',
      'Every OCPP-J frame exchanged with a charger, newest first. Narrow to the window that matters, tail it live during a site visit, or export NDJSON for the vendor.',
      `<label class="row small" style="gap:8px" title="Stream new frames as they are logged"><span class="switch green"><input type="checkbox" data-live><span></span></span> Live</label>
       <button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button>
       <button class="btn" type="button" data-export>${icon('download')} Export NDJSON</button>`,
    ) + `<div class="filters">
        ${field('Charger', `<select data-f="cp">${options(cpOpts, identity, { blank: 'Choose a charger…' })}</select>`)}
        ${field('Action', `<input data-f="action" list="ocpp-actions" placeholder="Any action" autocomplete="off"><datalist id="ocpp-actions">${COMMON_ACTIONS.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>`)}
        ${field('Direction', `<select data-f="direction">${options([{ value: 'in', label: 'in — charger → CSMS' }, { value: 'out', label: 'out — CSMS → charger' }], '', { blank: 'Both' })}</select>`)}
        ${field('Since', '<input type="datetime-local" data-f="since">')}
        ${field('Until', '<input type="datetime-local" data-f="until">')}
        ${field('Limit', `<select data-f="limit">${options([100, 200, 500, 1000, 2000], 200)}</select>`)}
      </div>
      <div class="row small muted" style="margin-bottom:8px" data-status></div>
      <div class="card" data-list></div>`;

    const f = (k) => $(`[data-f="${k}"]`, root).value.trim();
    const statusEl = $('[data-status]', root);
    let rows = [];
    let es = null;
    let reqSeq = 0;

    const draw = () => {
      table($('[data-list]', root), {
        columns: [
          { label: 'Time', render: (r) => `<div class="nowrap mono small">${esc(fmt.date(r.ts))} ${esc(fmt.timeS(r.ts))}</div>` },
          { label: 'Dir', render: (r) => dirTag(r.direction) },
          { label: 'Type', render: (r) => msgTag(r.message_type) },
          { label: 'Action', render: (r) => `<span class="mono">${esc(r.action ?? '—')}</span>` },
          { label: 'Unique ID', render: (r) => `<span class="mono small">${esc(r.unique_id ?? '—')}</span>` },
          { label: 'Payload', render: (r) => `<div style="min-width:280px;max-width:640px">${jsonCell(r.payload)}</div>` },
        ],
        rows,
        empty: f('cp') ? 'No frames match these filters.' : 'Choose a charger to see its OCPP traffic.',
      });
    };

    const load = async () => {
      const cp = f('cp');
      if (!cp) { rows = []; statusEl.textContent = ''; draw(); return; }
      const qs = new URLSearchParams();
      if (f('action')) qs.set('action', f('action'));
      if (f('direction')) qs.set('direction', f('direction'));
      if (toIso(f('since'))) qs.set('since', toIso(f('since')));
      if (toIso(f('until'))) qs.set('until', toIso(f('until')));
      qs.set('limit', f('limit') || '200');
      const seq = ++reqSeq;
      try {
        const r = await api(`/v1/charge-points/${encodeURIComponent(cp)}/frames?${qs}`);
        if (seq !== reqSeq) return;
        rows = r;
        statusEl.textContent = `${rows.length} frame${rows.length === 1 ? '' : 's'} · times in WIB (Asia/Jakarta)${es ? ' · live' : ''}`;
        draw();
      } catch (e) {
        if (seq !== reqSeq) return;
        $('[data-list]', root).innerHTML = `<div class="body">${callout(e.status === 404 || e.status === 403 ? 'warn' : 'crit', esc(e.status === 404 ? 'That charger does not exist or is not visible to you.' : e.message))}</div>`;
      }
    };

    // ---- live tail
    const redrawSoon = debounce(draw, 150);
    const matchesFilters = (r) => (!f('action') || r.action === f('action')) && (!f('direction') || r.direction === f('direction'));
    const stopLive = () => { if (es) { es.close(); es = null; } };
    const startLive = () => {
      stopLive();
      const cp = f('cp');
      if (!cp) { $('[data-live]', root).checked = false; toast('Choose a charger first', 'warn'); return; }
      es = new EventSource('/v1/events/frames?identity=' + encodeURIComponent(cp));
      es.onopen = () => { statusEl.textContent = `Live: streaming new frames from ${cp}`; };
      es.onerror = () => {
        if (es && es.readyState === EventSource.CLOSED) {
          stopLive();
          $('[data-live]', root).checked = false;
          statusEl.textContent = 'Live stream was refused or closed by the server.';
        } else {
          statusEl.textContent = 'Live: connection interrupted — reconnecting…';
        }
      };
      es.onmessage = (m) => {
        let r;
        try { r = JSON.parse(m.data); } catch { return; }
        if (!r || (r.ocpp_identity && r.ocpp_identity !== cp) || !matchesFilters(r)) return;
        rows.unshift(r);
        if (rows.length > LIVE_CAP) rows.length = LIVE_CAP;
        redrawSoon();
      };
    };

    $('[data-live]', root).addEventListener('change', (e) => {
      if (e.target.checked) startLive();
      else { stopLive(); statusEl.textContent = 'Live stopped.'; }
    });
    $('[data-f="cp"]', root).addEventListener('change', () => {
      const cp = f('cp');
      history.replaceState(null, '', cp ? `#/logs/${encodeURIComponent(cp)}` : '#/logs');
      if (es) startLive();
      load();
    });
    const reload = debounce(load, 350);
    ['action', 'direction', 'since', 'until', 'limit'].forEach((k) => {
      const i = $(`[data-f="${k}"]`, root);
      i.addEventListener(i.tagName === 'INPUT' && i.type !== 'datetime-local' ? 'input' : 'change', reload);
    });
    $('[data-refresh]', root).addEventListener('click', load);
    $('[data-export]', root).addEventListener('click', async (e) => {
      const cp = f('cp');
      if (!cp) { toast('Choose a charger first', 'warn'); return; }
      const btn = e.currentTarget;
      btn.classList.add('busy');
      await attempt(async () => {
        const res = await api(`/v1/charge-points/${encodeURIComponent(cp)}/frames.ndjson`, { raw: true });
        const blob = await res.blob();
        download(`${cp.replace(/[^\w.-]/g, '_')}-frames.ndjson`, blob);
      });
      btn.classList.remove('busy');
    });

    await load();
    return () => stopLive();
  },
});

// ------------------------------------------------------------------ audit log

function chainBanner(chain) {
  if (!chain) return callout('warn', 'The server did not return a chain verification result.');
  if (chain.ok) {
    return callout('ok', `${tag('t-ok', 'hash chain intact')} <b>${esc(fmt.num(chain.entries))}</b> entries verified${chain.expectedEntries != null ? ` against a head count of ${esc(fmt.num(chain.expectedEntries))}` : ''}. No entry has been altered, removed or reordered since it was written.`);
  }
  const problems = Array.isArray(chain.problems) ? chain.problems : [];
  return callout('crit', `${tag('t-crit', 'hash chain broken')} <b>The audit log has been tampered with or damaged.</b>
    ${chain.brokenAtId != null ? ` First failing entry id: <span class="mono">${esc(chain.brokenAtId)}</span>.` : ''}
    ${chain.entries != null ? ` ${esc(fmt.num(chain.entries))} entries present, ${esc(fmt.num(chain.expectedEntries))} expected.` : ''}
    ${problems.length ? `<ul style="margin:6px 0 0;padding-left:18px">${problems.slice(0, 20).map((p) => `<li><span class="mono">${esc(p.kind)}</span>${p.atId != null ? ` at id <span class="mono">${esc(p.atId)}</span>` : ''}${p.atSeq != null ? ` (seq ${esc(p.atSeq)})` : ''} — ${esc(p.detail)}</li>`).join('')}${problems.length > 20 ? `<li>… and ${esc(problems.length - 20)} more</li>` : ''}</ul>` : ''}
    <div style="margin-top:6px">Preserve the database as evidence and escalate to your security officer before making further changes.</div>`);
}

registerView('audit', {
  title: 'Audit log',
  icon: 'list',
  group: 'govern',
  order: 42,
  perm: 'audit:read',
  async render(root) {
    root.innerHTML = pageHead(
      'Audit log',
      'Every administrative action, attributed to a user or API key and hash-chained so that any deletion or edit is detectable. Showing the latest 200 entries.',
      `<button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button><button class="btn" type="button" data-csv>${icon('download')} Export CSV</button>`,
    ) + `<div data-chain style="margin-bottom:14px"></div>
      <div class="filters">
        ${field('Action contains', '<input type="search" data-f="action" placeholder="e.g. user. or tariff" autocomplete="off">')}
        ${field('Actor', '<input type="search" data-f="actor" placeholder="Type or id" autocomplete="off">')}
        ${field('Target', '<input type="search" data-f="target" placeholder="Type or id" autocomplete="off">')}
        <div class="small muted" style="align-self:center" data-count></div>
      </div>
      <div class="card" data-list></div>`;

    let entries = [];
    const f = (k) => $(`[data-f="${k}"]`, root).value.trim().toLowerCase();
    const filtered = () => {
      const a = f('action');
      const ac = f('actor');
      const t = f('target');
      return entries.filter((e) => (!a || String(e.action ?? '').toLowerCase().includes(a))
        && (!ac || `${e.actor_type ?? ''} ${e.actor_id ?? ''}`.toLowerCase().includes(ac))
        && (!t || `${e.target_type ?? ''} ${e.target_id ?? ''}`.toLowerCase().includes(t)));
    };
    const draw = () => {
      const rows = filtered();
      $('[data-count]', root).textContent = `${rows.length} of ${entries.length} entries`;
      table($('[data-list]', root), {
        columns: [
          { label: 'Time', render: (e) => `<div class="nowrap">${esc(fmt.time(e.ts))}</div><div class="cell-sub">${esc(fmt.ago(e.ts))}</div>` },
          { label: 'Actor', render: (e) => `${tag(e.actor_type === 'user' ? 't-info' : e.actor_type === 'system' ? 't-mute' : 't-warn', e.actor_type ?? '?', '', true)}<div class="cell-sub mono wrap">${esc(e.actor_id ?? '')}</div>` },
          { label: 'Action', render: (e) => `<span class="mono">${esc(e.action)}</span>` },
          { label: 'Target', render: (e) => `${esc(e.target_type ?? '—')}<div class="cell-sub mono wrap">${esc(e.target_id ?? '')}</div>` },
          { label: 'Details', render: (e) => `<div style="min-width:220px;max-width:520px">${jsonCell(e.after_state)}</div>` },
        ],
        rows,
        empty: entries.length ? 'No entries match these filters.' : 'The audit log is empty.',
      });
    };
    const load = async () => {
      let r;
      try {
        r = await api('/v1/audit');
      } catch (e) {
        $('[data-list]', root).innerHTML = `<div class="body">${callout('crit', esc(e.status === 403 ? 'You do not have permission to read the audit log.' : e.message))}</div>`;
        return;
      }
      entries = Array.isArray(r?.entries) ? r.entries : [];
      $('[data-chain]', root).innerHTML = chainBanner(r?.chain);
      draw();
    };

    const redraw = debounce(draw, 150);
    $$('[data-f]', root).forEach((i) => i.addEventListener('input', redraw));
    $('[data-refresh]', root).addEventListener('click', load);
    $('[data-csv]', root).addEventListener('click', () => {
      const rows = filtered();
      if (!rows.length) { toast('Nothing to export', 'warn'); return; }
      const lines = [['Time (UTC)', 'Actor type', 'Actor id', 'Action', 'Target type', 'Target id', 'Details']]
        .concat(rows.map((e) => [e.ts ? new Date(e.ts).toISOString() : '', e.actor_type, e.actor_id, e.action, e.target_type, e.target_id, e.after_state]))
        .map((r) => r.map(csvCell).join(','));
      download(`plugsure-audit-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\r\n'), 'text/csv;charset=utf-8');
    });
    await load();
  },
});
