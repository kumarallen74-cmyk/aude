import {
  $, esc, api, attempt, state, registerView, pageHead, table, tag, icon, fmt, drawer, confirmDialog, html, field, options,
  formValues, toast, callout, kpi, download, copy, debounce, onLive, sites as loadSites,
} from '../core.js';

/** Rounding to ROUNDING_UNIT_IDR, shown as its own line so the receipt adds up (subtotal + PBJT + PPN + rounding = total). */
function roundingRow(s) {
  const r = Number(s.total_idr) - Number(s.subtotal_idr) - Number(s.pbjt_idr ?? 0) - Number(s.ppn_idr ?? 0);
  return Number.isFinite(r) && r !== 0
    ? `<tr><td>${r > 0 ? '+' : '−'} Rounding<div class="cell-sub">Total rounded to the operator's rounding unit</div></td><td class="num">${fmt.idr(Math.abs(r))}</td></tr>`
    : '';
}

/**
 * Module 8 — Session Records, Metering & Revenue Analytics.
 *
 * The financial columns come from the FROZEN CDR (server-side breakdown()), never
 * re-computed here: what the explorer shows is exactly what was invoiced.
 * idTags and charger identities arrive from untrusted hardware — every one of
 * them goes through esc().
 */

const LIMIT = 100;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** YYYY-MM-DD of a Date in WIB (UTC+7, no DST). */
const wibDay = (d) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
const dayStartIso = (ymd) => new Date(`${ymd}T00:00:00+07:00`).toISOString();
const dayEndIso = (ymd) => new Date(new Date(`${ymd}T00:00:00+07:00`).getTime() + DAY_MS).toISOString();

const shortId = (id) => String(id ?? '').slice(0, 8);
const kwh3 = (wh) => (wh == null || wh === '' ? '—' : (Number(wh) / 1000).toFixed(3));

const SESSION_STATES = [
  { value: 'active', label: 'Active (charging)' },
  { value: 'ended', label: 'Ended — not rated' },
  { value: 'rated', label: 'Rated (CDR issued)' },
  { value: 'settled', label: 'Settled' },
  { value: 'disputed', label: 'Disputed' },
];
const STATE_TAG = {
  active: ['t-info', 'charging'], ended: ['t-warn', 'ended · unrated'], rated: ['t-ok', 'rated'],
  settled: ['t-ok', 'settled'], disputed: ['t-crit', 'disputed'],
};
const stateTag = (s) => (STATE_TAG[s] ? tag(STATE_TAG[s][0], STATE_TAG[s][1]) : tag('t-mute', s ?? 'unknown'));

const PAY = {
  paid: ['t-ok', 'Paid'], invoiced: ['t-info', 'Invoiced'], pending: ['t-warn', 'Payment pending'],
  unbilled: ['t-warn', 'Unbilled'], review: ['t-crit', 'Needs review'], in_progress: ['t-info', 'In progress'],
  failed: ['t-crit', 'Payment failed'], refunded: ['t-mute', 'Refunded'], free: ['t-mute', 'Free'],
};
const payLabel = (s) => PAY[s]?.[1] ?? String(s ?? '');
const payTag = (s, title) => (PAY[s] ? tag(PAY[s][0], PAY[s][1], title) : tag('t-mute', s ?? 'unknown', title));

/** OCPP stop reasons with a plain-English explanation (tooltip). */
const STOP = {
  EVDisconnected: 'The driver unplugged the vehicle',
  Local: 'Stopped at the charger (card tap or stop button)',
  Remote: 'Stopped remotely from the app or this console',
  EmergencyStop: 'The emergency stop button was pressed',
  HardReset: 'The charger was hard-reset during the session',
  SoftReset: 'The charger was soft-reset during the session',
  Reboot: 'The charger rebooted during the session',
  PowerLoss: 'The charger lost its supply',
  DeAuthorized: 'The card was refused mid-session (blocked, expired or limit reached)',
  UnlockCommand: 'The connector was unlocked by command',
  EnergyLimitReached: 'An energy limit was reached',
  Other: 'Other — including sessions closed by CSMS reconciliation',
};
const ABNORMAL_STOP = new Set(['EmergencyStop', 'HardReset', 'SoftReset', 'Reboot', 'PowerLoss', 'DeAuthorized', 'Other']);
const stopTag = (r) =>
  r.stop_reason
    ? tag(ABNORMAL_STOP.has(r.stop_reason) ? 't-warn' : 't-mute', r.stop_reason, STOP[r.stop_reason] ?? '', true)
    : r.state === 'active' ? tag('t-info', 'charging') : '<span class="muted">—</span>';

const openReceipt = (id) => window.open(`/v1/sessions/${encodeURIComponent(id)}/receipt`, '_blank', 'noopener');

const rerateCall = (id, force) =>
  api(`/v1/sessions/${encodeURIComponent(id)}/rerate`, { method: 'POST', body: force ? { force: true } : {} });

// ------------------------------------------------------------------ meter-value chart (hand-drawn SVG)

/**
 * Turn meter_value rows for one measurand into [{t, v}] in base units (Wh or W).
 * Phase-less samples are preferred; if a charger only reports per-phase values,
 * phases sharing a timestamp are summed.
 */
function series(mv, measurand) {
  const rows = mv.filter((m) => (m.measurand || 'Energy.Active.Import.Register') === measurand);
  const scale = (m) => {
    const u = String(m.unit ?? '').toLowerCase();
    return u === 'kwh' || u === 'kw' ? 1000 : 1;
  };
  const noPhase = rows.filter((m) => !m.phase);
  let pts;
  if (noPhase.length) {
    pts = noPhase.map((m) => ({ t: new Date(m.ts).getTime(), v: Number(m.value) * scale(m) }));
  } else {
    const by = new Map();
    for (const m of rows) {
      const t = new Date(m.ts).getTime();
      by.set(t, (by.get(t) ?? 0) + Number(m.value) * scale(m));
    }
    pts = [...by].map(([t, v]) => ({ t, v }));
  }
  return pts.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
}

/**
 * A small theme-aware line/area chart. `color` is always a constant CSS var from
 * this file, never data; everything else interpolated is a computed number or esc()'d.
 */
function lineChart(points, { title, unit, color, area = false, digits = 1 }) {
  if (points.length < 2) {
    return `<div class="small muted">${esc(title)}: ${points.length ? 'only one sample' : 'no samples'} — nothing to plot.</div>`;
  }
  const W = 640, H = 190, L = 58, R = 14, T = 12, B = 28;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const vals = points.map((p) => p.v);
  let vmin = Math.min(...vals);
  let vmax = Math.max(...vals);
  if (area) vmin = Math.min(0, vmin);
  if (vmax - vmin < 1e-9) vmax = vmin + 1;
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - vmin) / (vmax - vmin)) * (H - T - B);
  const pts = points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const v = vmin + (vmax - vmin) * f;
      const yy = y(v).toFixed(1);
      return `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="currentColor" stroke-opacity=".18" stroke-dasharray="${f === 0 ? '' : '3 4'}"/>
        <text x="${L - 6}" y="${yy}" dy="4" text-anchor="end" font-size="11" fill="currentColor">${esc(fmt.num(v, digits))}</text>`;
    })
    .join('');
  const peak = points.reduce((a, p) => (p.v > a.v ? p : a), points[0]);
  return `<figure style="margin:0">
    <figcaption class="row" style="margin-bottom:6px"><b class="small">${esc(title)}</b>
      <span class="small muted right">${esc(points.length)} samples · peak ${esc(fmt.num(peak.v, digits))} ${esc(unit)}</span></figcaption>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(title)}" style="display:block;color:var(--muted);overflow:visible">
      ${grid}
      ${area ? `<polygon points="${x(t0).toFixed(1)},${y(vmin).toFixed(1)} ${pts} ${x(t1).toFixed(1)},${y(vmin).toFixed(1)}" style="fill:${color};fill-opacity:.14"/>` : ''}
      <polyline points="${pts}" fill="none" style="stroke:${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <text x="${L}" y="${H - 8}" font-size="11" fill="currentColor">${esc(fmt.timeS(t0))}</text>
      <text x="${W - R}" y="${H - 8}" font-size="11" fill="currentColor" text-anchor="end">${esc(fmt.timeS(t1))}</text>
      <text x="${L + 4}" y="${T + 10}" font-size="11" fill="currentColor">${esc(unit)}</text>
    </svg></figure>`;
}

// ------------------------------------------------------------------ session drawer

export function openSessionDrawer(initialRow, onChanged) {
  let row = { ...initialRow };
  let detail = null;
  const getDetail = async () => (detail ??= await api(`/v1/sessions/${encodeURIComponent(row.id)}`));
  const ensureRow = async () => {
    if (row.ocpp_identity) return;
    // Opened by URL: fetch the explorer row (identity, site, breakdown) for this id.
    const r = await api(`/v1/sessions/search?q=${encodeURIComponent(row.id)}&limit=1`).catch(() => null);
    const hit = r?.rows?.find((x) => x.id === row.id);
    if (hit) row = hit;
  };

  return drawer({
    title: `Session ${shortId(row.id)}`,
    tabs: [
      {
        id: 'billing',
        label: 'Summary & billing',
        async render(body, ctx) {
          await ensureRow();
          const s = await getDetail();
          ctx.setSubtitle(`<span class="mono">${esc(row.ocpp_identity ?? '')}</span>${row.evse_no != null ? ` · connector #${esc(row.evse_no)}` : ''}${row.site_name ? ` · ${esc(row.site_name)}` : ''}`);
          ctx.setHeader(`<div class="chips" style="margin-top:6px">${stateTag(s.state)} ${row.payment_status ? payTag(row.payment_status) : ''}</div>`);

          const lines = Array.isArray(s.lines) ? s.lines : [];
          const flags = Array.isArray(s.regulatory_flags) ? s.regulatory_flags : [];
          const rated = s.total_idr != null;
          const canRerate = state.can('session:write') && !rated && s.state !== 'active';
          const b = row.breakdown ?? {};
          const pbjtPct = s.pbjt_rate_bps != null ? (Number(s.pbjt_rate_bps) / 100).toFixed(2) : null;
          const ppnPct = row.ppn_rate_bps != null ? (Number(row.ppn_rate_bps) / 100).toFixed(0) : null;
          const dur = s.duration_s ?? (s.state === 'active' && s.started_at ? (Date.now() - new Date(s.started_at).getTime()) / 1000 : null);

          const taxStack = rated
            ? `<table class="t"><tbody>
                <tr><td>Subtotal<div class="cell-sub">Energy + fast-charging service fee + idle/time fees</div></td><td class="num">${fmt.idr(s.subtotal_idr)}</td></tr>
                <tr><td>+ PBJT-TL ${pbjtPct != null ? esc(pbjtPct) + '%' : ''}<div class="cell-sub">Regional tax on electricity, set by the regency/city</div></td><td class="num">${fmt.idr(s.pbjt_idr)}</td></tr>
                <tr><td class="muted">DPP nilai lain<div class="cell-sub">PPN tax base — shown on the invoice, not added to the total</div></td><td class="num muted">${fmt.idr(s.ppn_dpp_idr)}</td></tr>
                <tr><td>+ PPN ${ppnPct != null ? esc(ppnPct) + '% × DPP' : ''}<div class="cell-sub">VAT, effective 11% of the price (UU HPP)</div></td><td class="num">${fmt.idr(s.ppn_idr)}</td></tr>
                ${roundingRow(s)}
              </tbody><tfoot><tr><td>Total charged to driver</td><td class="num">${fmt.idr(s.total_idr)}</td></tr></tfoot></table>
              <div class="small muted" style="margin-top:8px">Payment gateway MDR (estimate): <b>${fmt.idr(b.mdrIdr)}</b> — the CPO's cost, deducted at settlement. It is not charged to the driver.</div>`
            : `<div class="small muted">No CDR has been issued for this session, so there is no tax breakdown yet.</div>`;

          const flagsHtml = flags.length
            ? `<div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>Severity</th><th>Check</th><th>Detail</th></tr></thead><tbody>${flags
                .map((f) => `<tr><td>${tag(f.severity === 'violation' ? 't-crit' : f.severity === 'warning' ? 't-warn' : 't-info', f.severity ?? 'info')}</td>
                  <td class="mono">${esc(f.code ?? '')}</td><td class="wrap">${esc(f.message ?? '')}</td></tr>`)
                .join('')}</tbody></table></div></div>`
            : `<div class="small muted">${rated ? 'No regulatory flags — the price was within the ESDM service-fee and energy ceilings.' : 'Checks run when the session is rated.'}</div>`;

          body.innerHTML = `
            <div class="row" style="margin-bottom:14px">
              <button class="btn" data-receipt>${icon('sessions')} Tax receipt</button>
              <button class="btn ghost" data-copy>${icon('copy')} Copy session ID</button>
              ${canRerate ? `<button class="btn primary" data-rerate>${icon('refresh')} Re-rate</button>` : ''}
            </div>
            ${s.needs_review ? `<div style="margin-bottom:10px">${callout('crit', `<b>Needs review.</b> ${esc(s.review_reason ?? 'No reason was recorded.')} The session is parked: no CDR or invoice has been issued, so the driver has not been billed.`)}</div>` : ''}
            ${!rated && !s.needs_review && s.state !== 'active' ? `<div style="margin-bottom:10px">${callout('warn', 'This session has ended but has not been rated yet, so no invoice exists.')}</div>` : ''}
            <div data-rerate-out></div>
            <div class="grid two">
              <div class="card pad"><h3 style="font-size:13px;margin-bottom:10px">Session</h3><dl class="kv">
                <dt>Session ID</dt><dd class="mono">${esc(s.id)}</dd>
                <dt>Transaction ID</dt><dd class="mono">${esc(s.ocpp_transaction_id ?? '—')}</dd>
                <dt>Charger</dt><dd><span class="mono">${esc(row.ocpp_identity ?? '—')}</span>${row.evse_no != null ? ` · #${esc(row.evse_no)}` : ''}</dd>
                <dt>Connector</dt><dd>${esc(row.connector_type ?? '—')} ${esc(row.current_type ?? '')}</dd>
                <dt>Site</dt><dd>${esc(row.site_name ?? '—')}</dd>
                <dt>Card / idTag</dt><dd><span class="mono">${esc(row.id_tag ?? '—')}</span>${row.holder_name ? ` · ${esc(row.holder_name)}` : ''}</dd>
                <dt>Payment</dt><dd>${esc(s.payment_mode ?? row.payment_mode ?? '—')}${row.payment_method ? ` · ${esc(row.payment_method)}` : ''}${row.payment_status ? ` · ${esc(payLabel(row.payment_status))}` : ''}</dd>
                <dt>Started</dt><dd>${fmt.time(s.started_at)}</dd>
                <dt>Ended</dt><dd>${s.ended_at ? fmt.time(s.ended_at) : tag('t-info', 'still charging')}</dd>
                <dt>Duration</dt><dd>${fmt.dur(dur)}${s.idle_minutes ? ` · ${esc(s.idle_minutes)} min idle` : ''}</dd>
                <dt>Meter</dt><dd class="mono">${kwh3(s.meter_start_wh)} → ${kwh3(s.meter_stop_wh)} kWh</dd>
                <dt>Delivered</dt><dd><b>${fmt.kwh(s.energy_wh, 3)}</b></dd>
                <dt>Stop reason</dt><dd>${stopTag(s)}${s.stop_reason && STOP[s.stop_reason] ? `<div class="cell-sub">${esc(STOP[s.stop_reason])}</div>` : ''}</dd>
              </dl></div>
              <div class="card pad"><h3 style="font-size:13px;margin-bottom:10px">Tax stack (frozen CDR)</h3>${taxStack}</div>
            </div>
            <div class="section"><h2>CDR lines</h2><div class="card" data-lines></div></div>
            <div class="section"><h2>Regulatory checks</h2>${flagsHtml}</div>`;

          table($('[data-lines]', body), {
            columns: [
              { label: 'Description', render: (l) => `<div class="wrap">${esc(l.description ?? l.kind ?? '')}</div>${l.kind ? `<div class="cell-sub">${esc(l.kind)}</div>` : ''}` },
              { label: 'Qty', num: true, render: (l) => `${esc(l.quantity ?? '')} ${esc(l.unit ?? '')}` },
              { label: 'Unit rate', num: true, render: (l) => fmt.idr(l.unitRate) },
              { label: 'Amount', num: true, render: (l) => fmt.idr(l.amountIdr) },
            ],
            rows: lines,
            empty: rated ? 'The CDR has no lines.' : 'No CDR yet — lines appear once the session is rated.',
            foot: rated && lines.length ? `<tr><td colspan="3">Subtotal before tax</td><td class="num">${fmt.idr(s.subtotal_idr)}</td></tr>` : '',
          });

          $('[data-receipt]', body).addEventListener('click', () => openReceipt(row.id));
          $('[data-copy]', body).addEventListener('click', () => copy(String(row.id)));

          const rerateBtn = $('[data-rerate]', body);
          rerateBtn?.addEventListener('click', async () => {
            const out = $('[data-rerate-out]', body);
            rerateBtn.classList.add('busy');
            let r;
            try {
              r = await rerateCall(row.id, false);
            } catch (e) {
              toast(e.message, 'crit');
              return;
            } finally {
              rerateBtn.classList.remove('busy');
            }
            if (r?.ok) {
              toast('Session rated — CDR issued', 'ok');
              detail = null;
              onChanged?.();
              ctx.refresh();
              return;
            }
            out.innerHTML = `<div style="margin-bottom:10px">${callout('warn', `<b>The rating engine declined to price this session.</b> ${esc(r?.reason ?? '')}
              <div class="small" style="margin-top:6px">${esc(r?.hint ?? '')}</div>
              <div class="row" style="margin-top:10px"><button class="btn sm danger" data-force>Force bill as rated…</button></div>`)}</div>`;
            $('[data-force]', out).addEventListener('click', async () => {
              const ok = await confirmDialog({
                title: 'Force bill as rated?',
                message: html`The engine flagged this session: <b>${r?.reason ?? 'unknown reason'}</b>.<br><br>
                  Forcing issues a CDR with the current tariff and bills the driver anyway. The override is recorded in the audit log under your name.
                  If the tariff is wrong, correct it and use Re-rate instead.`,
                confirmLabel: 'Force bill',
                danger: true,
                requireText: 'FORCE',
              });
              if (!ok) return;
              const f = await attempt(() => rerateCall(row.id, true));
              if (!f) return;
              if (f.ok) {
                toast('Session billed under override — recorded in the audit log', 'warn');
                detail = null;
                onChanged?.();
                ctx.refresh();
              } else {
                toast(f.reason ?? 'The session still could not be rated', 'crit');
              }
            });
          });
        },
      },
      {
        id: 'meter',
        label: 'Metering',
        async render(body) {
          const s = await getDetail();
          const mv = Array.isArray(s.meterValues) ? s.meterValues : [];
          const energyRaw = series(mv, 'Energy.Active.Import.Register');
          const base = energyRaw.length ? energyRaw[0].v : 0;
          const energy = energyRaw.map((p) => ({ t: p.t, v: (p.v - base) / 1000 }));
          const power = series(mv, 'Power.Active.Import').map((p) => ({ t: p.t, v: p.v / 1000 }));
          const measurands = [...new Set(mv.map((m) => m.measurand || 'Energy.Active.Import.Register'))];
          body.innerHTML = `
            <div class="grid k3">
              ${kpi('Meter start', `${kwh3(s.meter_start_wh)} kWh`, 'register at StartTransaction')}
              ${kpi('Meter stop', `${kwh3(s.meter_stop_wh)} kWh`, s.meter_stop_wh == null ? 'session still open' : 'register at StopTransaction')}
              ${kpi('Delivered', fmt.kwh(s.energy_wh, 3), `${esc(mv.length)} meter samples received`)}
            </div>
            ${mv.length ? '' : `<div style="margin-top:14px">${callout('info', 'The charger sent no MeterValues for this session — only the start and stop register readings are known. Check the charger\'s MeterValueSampleInterval setting.')}</div>`}
            <div class="card pad section">${lineChart(energy, { title: 'Energy delivered (from Energy.Active.Import.Register)', unit: 'kWh', color: 'var(--accent)', area: true, digits: 2 })}</div>
            <div class="card pad section">${lineChart(power, { title: 'Charging power (Power.Active.Import)', unit: 'kW', color: 'var(--info)', digits: 1 })}</div>
            ${measurands.length ? `<p class="small muted section">Measurands reported: ${measurands.map((m) => `<span class="mono">${esc(m)}</span>`).join(', ')}</p>` : ''}`;
        },
      },
      {
        id: 'signed',
        label: 'Signed meter data',
        async render(body) {
          const d = await api(`/v1/sessions/${encodeURIComponent(row.id)}/signed-data`);
          if (!d.values.length) {
            body.innerHTML = callout(d.status === 'missing' ? 'crit' : 'info', d.status === 'missing'
              ? `<b>No signed readings.</b> ${esc(d.detail ?? '')}`
              : 'The charger sent no signed readings for this session. Meters that sign (calibration-law meters, OCMF) send them at the start and end of each transaction; on OCPP 2.0.1 and 2.1 stations, switch them on with <span class="mono">POST /v1/charge-points/{identity}/signed-metering</span>.');
            return;
          }
          const ST = { verified: ['t-ok', 'verified'], unverified_key: ['t-warn', 'matches · key not registered'], mismatch: ['t-crit', 'does not match the bill'], invalid: ['t-crit', 'not valid'], incomplete: ['t-warn', 'incomplete'], missing: ['t-crit', 'missing'] };
          const VS = { valid: ['t-ok', 'signature valid'], invalid: ['t-crit', 'signature invalid'], no_key: ['t-warn', 'no key'], unreadable: ['t-crit', 'unreadable'], unsupported: ['t-mute', 'unsupported'] };
          body.innerHTML = `
            <div class="grid k3">
              ${kpi('Outcome', d.status ? tag(...(ST[d.status] ?? ['t-mute', d.status])) : tag('t-mute', 'not assessed yet'), d.policy === 'require' ? 'this site requires verified readings' : d.policy === 'off' ? 'this site ignores signed readings' : 'kept and checked')}
              ${kpi('Signed energy', d.signedEnergyWh != null ? fmt.kwh(d.signedEnergyWh, 3) : '—', `billed ${fmt.kwh(d.billedEnergyWh, 3)}`)}
              ${kpi('Meter', esc(d.meterSerial ?? '—'), d.meterPublicKey ? 'public key registered' : 'no public key registered')}
            </div>
            ${d.detail ? `<div class="section">${callout(d.status === 'verified' ? 'ok' : d.status === 'unverified_key' || d.status === 'incomplete' ? 'warn' : 'crit', esc(d.detail))}</div>` : ''}
            <div class="row section" style="gap:8px"><button class="btn" data-xml>${icon('download')} File for the Transparency Software</button></div>
            ${d.values.map((v) => `<div class="card pad section">
              <div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap"><div><b>${esc(v.context ?? 'Signed value')}</b> <span class="cell-sub">${esc(v.sampledAt ? fmt.time(v.sampledAt) : '')}</span></div>
                <div>${tag(...(VS[v.verifyStatus] ?? ['t-mute', v.verifyStatus]))} ${v.keySource ? `<span class="cell-sub">${esc(v.keySource === 'registered' ? 'against the registered key' : 'against the key the charger sent')}</span>` : ''}</div></div>
              ${v.verifyDetail ? `<div class="cell-sub" style="margin-top:4px">${esc(v.verifyDetail)}</div>` : ''}
              ${(v.readings ?? []).length ? `<div class="table-wrap" style="margin-top:8px"><table class="t"><thead><tr><th>Reading</th><th>Meter time</th><th>Register</th><th class="num">Value</th><th>Status</th></tr></thead><tbody>${v.readings.map((r) => `<tr><td>${esc(r.tx === 'B' ? 'start' : r.tx === 'E' ? 'end' : r.tx ?? '—')}</td><td class="mono">${esc(r.tm)}</td><td>${esc(r.register)}${r.ri ? ` <span class="cell-sub mono">${esc(r.ri)}</span>` : ''}</td><td class="num">${r.wh != null ? fmt.kwh(r.wh, 3) : '—'}</td><td>${r.ok ? tag('t-ok', r.st) : tag('t-crit', `${r.st}${r.ef ? ` ${r.ef}` : ''}`)}</td></tr>`).join('')}</tbody></table></div>` : ''}
              <pre class="mono" style="white-space:pre-wrap;word-break:break-all;font-size:11px;margin-top:8px">${esc(v.ocmf)}</pre>
            </div>`).join('')}`;
          $('[data-xml]', body).addEventListener('click', async () => {
            const res = await api(`/v1/sessions/${encodeURIComponent(row.id)}/signed-data.xml`, { raw: true }).catch((e) => { toast(e.message, 'crit'); return null; });
            if (!res) return;
            const blob = await res.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `signed-meter-data-${row.id}.xml`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          });
        },
      },
      {
        id: 'car',
        label: 'Car (ISO 15118)',
        async render(body) {
          const s = await getDetail();
          const v = s.v2x;
          const n = v?.needs;
          if (!v || (!n && !v.exportWh && !v.consent && v.socPercent == null)) {
            body.innerHTML = callout('info', 'The car told the charger nothing beyond the session itself. Charging needs (energy wanted, departure time, battery level, whether it can give energy back) arrive from cars and chargers that speak ISO 15118 (OCPP 2.0.1 or 2.1).');
            return;
          }
          const kw = (w) => (w == null ? '—' : `${fmt.num(Math.round(w / 100) / 10)} kW`);
          const exportSeries = series(Array.isArray(s.meterValues) ? s.meterValues : [], 'Energy.Active.Export.Register');
          const base = exportSeries.length ? exportSeries[0].v : 0;
          body.innerHTML = `
            <div class="grid k3">
              ${kpi('Battery', v.socPercent == null ? '—' : `${fmt.num(v.socPercent)}%`, v.socAt ? `reported ${esc(fmt.ago(v.socAt))}` : 'not reported')}
              ${kpi('Given back', fmt.kwh(v.exportWh, 3), v.creditIdr ? `credit ${fmt.idr(v.creditIdr)}` : v.consent ? 'no credit rate' : 'bidirectional off')}
              ${kpi('Now', v.discharging ? `giving back ${kw(v.dischargeW)}` : 'charging', v.discharging ? 'discharge setpoint sent (OCPP 2.1)' : esc(v.notDischargingBecause ?? (v.consent ? '' : 'no consent')))}
            </div>
            <div class="grid two section">
              <div class="card pad"><h3 style="font-size:13px;margin-bottom:10px">What the car asked for</h3>${n ? `<dl class="kv">
                <dt>Energy transfer</dt><dd class="mono">${esc(n.requestedTransfer)}${n.availableTransfer?.length > 1 ? `<div class="cell-sub">can also: ${esc(n.availableTransfer.filter((m) => m !== n.requestedTransfer).join(', '))}</div>` : ''}</dd>
                <dt>Bidirectional</dt><dd>${n.bidirectional ? tag('t-ok', 'yes') : tag('t-mute', 'no')}${n.maxDischargePowerW ? ` · up to ${kw(n.maxDischargePowerW)} back` : ''}</dd>
                <dt>Control mode</dt><dd>${esc(n.controlMode === 'DynamicControl' ? 'dynamic (ISO 15118-20)' : n.controlMode === 'ScheduledControl' ? 'scheduled' : '—')}</dd>
                <dt>Leaves at</dt><dd>${n.departureTime ? esc(fmt.time(n.departureTime)) : '—'}</dd>
                <dt>Energy wanted</dt><dd>${n.energyRequestWh != null ? fmt.kwh(n.energyRequestWh, 1) : '—'}${n.targetSocPercent != null ? ` · to ${fmt.num(n.targetSocPercent)}%` : ''}</dd>
                <dt>Battery size</dt><dd>${n.evCapacityWh ? fmt.kwh(n.evCapacityWh, 0) : '—'}</dd>
                <dt>Max charging</dt><dd>${kw(n.maxChargePowerW)}</dd>
                <dt>Received</dt><dd>${esc(fmt.time(n.receivedAt))}${n.evProposedSchedule ? ' · the car proposed a schedule' : ''}</dd>
              </dl>` : '<div class="small muted">No charging needs received.</div>'}</div>
              <div class="card pad"><h3 style="font-size:13px;margin-bottom:10px">Giving energy back</h3><dl class="kv">
                <dt>Consent</dt><dd>${v.consent ? `${tag('t-ok', 'yes')} <span class="cell-sub">${esc(v.consentSource === 'fleet' ? 'the fleet’s standing consent' : 'the driver, in the app')}</span>` : tag('t-mute', 'no')}</dd>
                <dt>Battery floor</dt><dd>${v.minSocPercent != null ? `${fmt.num(v.minSocPercent)}%` : '—'}</dd>
                <dt>Credit</dt><dd>${v.creditIdrPerKwh != null ? `${fmt.idr(v.creditIdrPerKwh)} / kWh` : '—'}</dd>
                <dt>Site programme</dt><dd>${v.siteProgramme?.enabled ? `${tag('t-info', 'on')} ${esc((v.siteProgramme.windows ?? []).map((w) => `${w.from}–${w.to}`).join(', '))}` : tag('t-mute', 'off')}</dd>
                <dt>Operation mode</dt><dd class="mono">${esc(v.operationMode ?? '—')}</dd>
              </dl></div>
            </div>
            ${exportSeries.length ? `<div class="card pad section">${lineChart(exportSeries.map((p) => ({ t: p.t, v: (p.v - base) / 1000 })), { title: 'Energy given back (Energy.Active.Export.Register)', unit: 'kWh', color: 'var(--ok)', area: true, digits: 2 })}</div>` : ''}`;
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ list view

registerView('sessions', {
  title: 'Sessions & Revenue',
  icon: 'sessions',
  group: 'commercial',
  order: 21,
  perm: 'session:read',
  // Also shown in the Site Owner portal (read-only, the owner's own sites).
  portal: true,
  async render(root, [sessionId]) {
    const meta = state.meta ?? {};
    const canExport = state.can('session:export');
    root.innerHTML = pageHead(
      'Sessions & Revenue',
      'Every charging session with its meter readings and the tax breakdown frozen in its CDR. Filters apply as you type; totals cover all matching sessions, not just this page.',
      `<button class="btn" data-refresh>${icon('refresh')} Refresh</button>${canExport ? `<button class="btn" data-export>${icon('download')} Export CSV</button>` : ''}`,
    ) + `<div class="card pad" data-filterbox></div>
      <div class="grid k4 section" data-kpis></div>
      <div class="card section" data-list><div class="body"><div class="skeleton" style="width:50%"></div></div></div>
      <div data-pager></div>`;

    const siteList = (await loadSites()) ?? [];
    const plugTypes = (meta.connectorTypes ?? []).map((c) => ({ value: c.code, label: `${c.label} (${c.current})` }));
    const payStatuses = (meta.paymentStatuses ?? Object.keys(PAY)).map((p) => ({ value: p, label: payLabel(p) }));

    const fbox = $('[data-filterbox]', root);
    fbox.innerHTML = `<div class="filters" style="margin-bottom:0">
      ${field('From', '<input type="date" name="from">')}
      ${field('To', '<input type="date" name="to">')}
      ${field('Site', `<select name="siteId">${options(siteList.map((s) => ({ value: s.id, label: s.name })), '', { blank: 'All sites' })}</select>`)}
      ${field('Station ID', '<input name="identity" list="ps-session-cp-list" placeholder="Any charger" autocomplete="off" spellcheck="false"><datalist id="ps-session-cp-list"></datalist>')}
      ${field('Connector', `<select name="connectorType">${options([{ value: 'AC', label: 'All AC' }, { value: 'DC', label: 'All DC' }, ...plugTypes], '', { blank: 'Any connector' })}</select>`)}
      ${field('Payment', `<select name="paymentStatus">${options(payStatuses, '', { blank: 'Any payment status' })}</select>`)}
      ${field('State', `<select name="state">${options(SESSION_STATES, '', { blank: 'Any state' })}</select>`)}
      <div class="field grow" style="min-width:240px"><label>Search</label><input type="search" name="q" placeholder="Session ID, card idTag or transaction ID" autocomplete="off" spellcheck="false"></div>
      <button class="btn ghost" type="button" data-reset>Reset</button>
    </div>`;

    const setDefaults = () => {
      const now = new Date();
      $('[name=from]', fbox).value = wibDay(new Date(now.getTime() - 6 * DAY_MS));
      $('[name=to]', fbox).value = wibDay(now);
      ['siteId', 'identity', 'connectorType', 'paymentStatus', 'state', 'q'].forEach((n) => { $(`[name=${n}]`, fbox).value = ''; });
    };
    setDefaults();

    // Charger identities for the datalist — set as DOM properties (identities are hardware-supplied).
    if (state.can('charge_point:read')) {
      api('/v1/charge-points')
        .then((list) => {
          const dl = $('#ps-session-cp-list', fbox);
          (list ?? []).forEach((c) => {
            const o = document.createElement('option');
            o.value = c.ocpp_identity;
            if (c.display_name) o.label = c.display_name;
            dl.append(o);
          });
        })
        .catch(() => {});
    }

    const listEl = $('[data-list]', root);
    const pagerEl = $('[data-pager]', root);
    const kpiEl = $('[data-kpis]', root);
    let offset = 0;
    let seq = 0;

    const filterParams = () => {
      const v = formValues(fbox);
      const p = new URLSearchParams();
      if (YMD.test(v.from ?? '')) p.set('from', dayStartIso(v.from));
      if (YMD.test(v.to ?? '')) p.set('to', dayEndIso(v.to));
      for (const k of ['siteId', 'identity', 'connectorType', 'paymentStatus', 'state', 'q']) {
        const x = String(v[k] ?? '').trim();
        if (x) p.set(k, x);
      }
      return p;
    };

    const drawKpis = (t = {}) => {
      const n = Number(t.sessions ?? 0);
      const rev = Number(t.revenue_idr ?? 0);
      kpiEl.innerHTML = [
        kpi('Sessions', fmt.num(n), 'matching the filters'),
        kpi('Energy delivered', `${fmt.num(Number(t.energy_wh ?? 0) / 1000, 1)} kWh`, n ? `${fmt.num(Number(t.energy_wh ?? 0) / 1000 / n, 1)} kWh per session` : ''),
        kpi('Gross revenue', fmt.idr(rev), n ? `${fmt.idr(rev / n)} per session · incl. tax` : 'incl. PBJT and PPN'),
        kpi('PBJT-TL collected', fmt.idr(t.pbjt_idr ?? 0), 'regional electricity tax, remitted to the Pemda'),
        kpi('PPN collected', fmt.idr(t.ppn_idr ?? 0), 'VAT, effective 11%'),
      ].join('');
    };

    const columns = [
      {
        label: 'Session',
        render: (r) => `<div class="cell-title mono">${esc(shortId(r.id))}</div><div class="cell-sub">tx <span class="mono">${esc(r.ocpp_transaction_id ?? '—')}</span></div>`,
        foot: (t) => `All ${esc(fmt.num(t.sessions ?? 0))} matching`,
      },
      {
        label: 'Station & connector',
        render: (r) => `<div class="cell-title mono">${esc(r.ocpp_identity)}</div>
          <div class="cell-sub">#${esc(r.evse_no)} · ${esc(r.connector_type ?? '')} ${esc(r.current_type ?? '')}</div>
          <div class="cell-sub">${esc(r.site_name ?? '')}</div>`,
      },
      {
        label: 'Driver ID / RFID',
        // A masked card (site-scoped viewer) has its holder withheld, not unknown.
        render: (r) => (r.id_tag
          ? `<div class="mono">${esc(r.id_tag)}</div><div class="cell-sub">${esc(r.holder_name ?? (String(r.id_tag).startsWith('••••') ? r.payment_mode ?? '' : 'unregistered holder'))}</div>`
          : `<span class="muted">—</span><div class="cell-sub">${esc(r.payment_mode ?? '')}</div>`),
      },
      { label: 'Start', render: (r) => `<span class="nowrap">${fmt.time(r.started_at)}</span>` },
      { label: 'End', render: (r) => (r.ended_at ? `<span class="nowrap">${fmt.time(r.ended_at)}</span>` : stateTag(r.state)) },
      {
        label: 'Duration',
        num: true,
        render: (r) => fmt.dur(r.duration_s ?? (r.state === 'active' && r.started_at ? (Date.now() - new Date(r.started_at).getTime()) / 1000 : null)),
      },
      {
        label: 'Energy',
        num: true,
        render: (r) => `<div class="cell-title">${fmt.kwh(r.energy_wh, 3)}</div><div class="cell-sub mono">${kwh3(r.meter_start_wh)} → ${kwh3(r.meter_stop_wh)}</div>`,
        foot: (t) => `${fmt.num(Number(t.energy_wh ?? 0) / 1000, 1)} kWh`,
      },
      { label: 'Base energy', num: true, render: (r) => fmt.idr(r.breakdown?.energySubtotalIdr) },
      {
        label: 'Service fee',
        num: true,
        render: (r) => `${fmt.idr(r.breakdown?.serviceFeeIdr)}${Number(r.breakdown?.idleFeeIdr) > 0 ? `<div class="cell-sub">+ idle ${fmt.idr(r.breakdown.idleFeeIdr)}</div>` : ''}`,
      },
      {
        label: 'PBJT-TL',
        num: true,
        render: (r) => `${fmt.idr(r.breakdown?.pbjtIdr)}${r.pbjt_rate_bps != null ? `<div class="cell-sub">${esc((Number(r.pbjt_rate_bps) / 100).toFixed(1))}%</div>` : ''}`,
        foot: (t) => fmt.idr(t.pbjt_idr ?? 0),
      },
      {
        label: 'PPN 11%',
        num: true,
        render: (r) => `${fmt.idr(r.breakdown?.ppnIdr)}${r.breakdown?.dppIdr != null ? `<div class="cell-sub">DPP ${fmt.idr(r.breakdown.dppIdr)}</div>` : ''}`,
        foot: (t) => fmt.idr(t.ppn_idr ?? 0),
      },
      {
        label: 'MDR (est.)',
        num: true,
        render: (r) => `<span class="muted" title="Payment gateway fee — the CPO's cost, not charged to the driver">${r.breakdown?.grossTotalIdr == null ? '—' : fmt.idr(r.breakdown.mdrIdr)}</span>`,
      },
      {
        label: 'Gross total',
        num: true,
        render: (r) => `<b>${fmt.idr(r.breakdown?.grossTotalIdr)}</b>`,
        foot: (t) => fmt.idr(t.revenue_idr ?? 0),
      },
      { label: 'Stop reason', render: (r) => stopTag(r) },
      {
        label: 'Payment',
        render: (r) => `${payTag(r.payment_status, r.needs_review ? r.review_reason ?? '' : '')}${r.needs_review && r.review_reason ? `<div class="cell-sub wrap" style="max-width:180px">${esc(r.review_reason)}</div>` : ''}`,
      },
      {
        label: '',
        render: (r) => `<button class="btn sm ghost" type="button" data-receipt="${esc(r.id)}" title="Printable tax receipt (DPP, PPN, PBJT-TL)">${icon('sessions')} Receipt</button>`,
      },
    ];

    const drawTable = (r) => {
      const rows = r.rows ?? [];
      const t = r.totals ?? {};
      const total = Number(t.sessions ?? 0);
      table(listEl, {
        columns,
        rows,
        empty: 'No sessions match these filters. Widen the date range or clear a filter.',
        onRow: (row) => openSessionDrawer(row, () => refreshSoon()),
        foot: rows.length ? `<tr>${columns.map((c) => `<td class="${c.num ? 'num' : ''}">${c.foot ? c.foot(t) : ''}</td>`).join('')}</tr>` : '',
      });
      pagerEl.innerHTML = total > 0
        ? `<div class="row" style="margin-top:10px">
            <span class="small muted">Showing ${esc(fmt.num(rows.length ? offset + 1 : 0))}–${esc(fmt.num(offset + rows.length))} of ${esc(fmt.num(total))} sessions · newest first</span>
            <button class="btn sm right" type="button" data-prev${offset === 0 ? ' disabled' : ''}>← Previous</button>
            <button class="btn sm" type="button" data-next${offset + rows.length >= total ? ' disabled' : ''}>Next →</button>
          </div>`
        : '';
    };

    const load = async () => {
      const my = ++seq;
      const p = filterParams();
      p.set('limit', String(LIMIT));
      p.set('offset', String(offset));
      let r;
      try {
        r = await api(`/v1/sessions/search?${p}`);
      } catch (e) {
        if (my !== seq) return;
        if (e.status !== 401) listEl.innerHTML = `<div class="body">${callout('crit', `Could not load sessions: ${esc(e.message)}`)}</div>`;
        return;
      }
      if (my !== seq) return;
      // A live refresh may shrink the result set under the current page.
      if (!(r.rows ?? []).length && offset > 0 && Number(r.totals?.sessions ?? 0) > 0) {
        offset = Math.max(0, Math.floor((Number(r.totals.sessions) - 1) / LIMIT) * LIMIT);
        return load();
      }
      drawKpis(r.totals ?? {});
      drawTable(r);
    };
    const refreshSoon = debounce(() => load(), 1500);
    const applyFilters = debounce(() => { offset = 0; load(); }, 350);

    fbox.addEventListener('input', applyFilters);
    fbox.addEventListener('change', applyFilters);
    $('[data-reset]', fbox).addEventListener('click', () => { setDefaults(); offset = 0; load(); });

    pagerEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-prev]')) { offset = Math.max(0, offset - LIMIT); load(); }
      else if (e.target.closest('[data-next]')) { offset += LIMIT; load(); }
    });
    listEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-receipt]');
      if (b) openReceipt(b.dataset.receipt);
    });

    $('[data-refresh]', root).addEventListener('click', () => load());
    $('[data-export]', root)?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.classList.add('busy');
      try {
        const res = await api(`/v1/sessions.csv?${filterParams()}`, { raw: true });
        download(`plugsure-sessions-${wibDay(new Date())}.csv`, await res.blob());
        toast('CSV export downloaded (up to 50,000 rows)', 'ok');
      } catch (err) {
        if (err.status !== 401) toast(err.message, 'crit');
      } finally {
        btn.classList.remove('busy');
      }
    });

    await load();
    if (sessionId) openSessionDrawer({ id: sessionId }, () => refreshSoon());

    const off = onLive((e) => {
      const k = typeof e?.kind === 'string' ? e.kind : '';
      if (k.startsWith('session.') || k.startsWith('cdr.')) refreshSoon();
    });
    return () => off();
  },
});
