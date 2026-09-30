import {
  $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, field, callout, kpi, download, teraTag,
} from '../core.js';

/**
 * Indonesian regulatory compliance (SPKLU registration, SLO, PBJT-TL, metrology
 * "tera") and the hardware-quirks registry. Quirk findings are learned from
 * what chargers actually send, so every value is untrusted and escaped.
 */

// ------------------------------------------------------------------ helpers

/** The status that governs selling energy: a meter awaiting calibration is 'pending' whatever its dates say. */
const meterStatus = (m) =>
  m.teraCertStatus === 'pending' ? 'pending' : m.teraCertStatus === 'exempt' ? 'exempt' : (m.teraStatus ?? 'unknown');
const blocked = (st) => st === 'pending' || st === 'lapsed';
const daysUntil = (t) => (t ? Math.floor((new Date(t).getTime() - Date.now()) / 86400000) : null);

/** CSV cell: quoted, and neutralised against spreadsheet formula injection (values come from hardware). */
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');

const sloTag = (d) =>
  d == null ? tag('t-warn', 'no SLO on file')
  : d < 0 ? tag('t-crit', `SLO expired ${-d}d ago`)
  : d < 90 ? tag('t-warn', `SLO ${d}d left`)
  : tag('t-ok', `SLO ${d}d left`);

const spkluTag = (s) =>
  s.spkluIdValid === true ? tag('t-ok', 'valid format')
  : s.spkluIdValid === false ? tag('t-crit', 'malformed', 'Expected XX.SCHEME.YY.ZZZZ.NNN')
  : tag('t-warn', 'missing', 'No SPKLU ID registered for this site');

const muniTag = (s) =>
  s.municipalityMatchesSpklu === true ? tag('t-ok', 'matches SPKLU ID')
  : s.municipalityMatchesSpklu === false ? tag('t-crit', 'municipality mismatch', 'The regency/city code in the SPKLU ID differs from the site\'s code, which drives PBJT-TL — one of them is wrong')
  : tag('t-mute', 'not checked');

// ------------------------------------------------------------------ compliance view

registerView('compliance', {
  title: 'Compliance',
  icon: 'shield',
  group: 'govern',
  order: 40,
  perm: 'compliance:read',
  async render(root) {
    root.innerHTML = pageHead(
      'Regulatory compliance',
      'SPKLU registration (Permen ESDM 1/2023), the SLO operating certificate, PBJT-TL local tax, and metrology verification (tera) of every billing meter. A meter that is pending calibration or whose tera has lapsed cannot run commercial sessions.',
      `<button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button><button class="btn" type="button" data-csv>${icon('download')} Export CSV</button>`,
    ) + `<div class="grid k4" data-kpis></div><div data-alert class="section"></div>
      <div class="filters section">
        ${field('Site', '<input type="search" data-q placeholder="Name or SPKLU ID">')}
        <label class="check" style="align-self:center"><input type="checkbox" data-issues><span>Only sites with issues</span></label>
      </div><div data-sites></div>`;

    let data = [];
    const siteIssues = (s) =>
      s.spkluIdValid !== true || s.municipalityMatchesSpklu === false || s.sloDaysRemaining == null || s.sloDaysRemaining < 90
      || (s.meters ?? []).some((m) => ['pending', 'lapsed', 'due_soon', 'unknown'].includes(meterStatus(m)));

    const drawSites = () => {
      const q = $('[data-q]', root).value.trim().toLowerCase();
      const only = $('[data-issues]', root).checked;
      const list = data.filter((s) => (!q || [s.name, s.spklu_id].some((x) => String(x ?? '').toLowerCase().includes(q))) && (!only || siteIssues(s)));
      const box = $('[data-sites]', root);
      if (!list.length) {
        box.innerHTML = `<div class="card"><div class="empty-state"><h3>${data.length ? 'No sites match' : 'No sites yet'}</h3><p>${data.length ? 'Clear the filters to see every site.' : 'Create a site to start tracking its regulatory status.'}</p></div></div>`;
        return;
      }
      const maxBps = state.meta?.regulatory?.pbjtMaxBps ?? 1000;
      box.innerHTML = list.map((s, i) => {
        const p = s.spkluParsed;
        const bps = Number(s.pbjt_rate_bps ?? 0);
        const schemeMismatch = p && s.spklu_scheme && p.scheme !== s.spklu_scheme;
        return `<div class="card section">
          <header><h3>${esc(s.name)}</h3><div class="right chips">${sloTag(s.sloDaysRemaining)} ${s.municipalityMatchesSpklu === false ? muniTag(s) : ''}</div></header>
          <div class="body">
            <div class="grid two" style="gap:10px 24px">
              <dl class="kv">
                <dt>SPKLU ID</dt><dd><span class="mono">${esc(s.spklu_id ?? '—')}</span> ${spkluTag(s)}</dd>
                <dt>Scheme</dt><dd>${esc(s.spklu_scheme ?? p?.scheme ?? '—')}${p ? ` <span class="muted">· ${esc(p.schemeFamily)}, ${p.ownsAsset ? 'owned' : 'leased'}, ${p.selfOperated ? 'self-operated' : 'partner-operated'}</span>` : ''}${schemeMismatch ? ' ' + tag('t-warn', 'differs from SPKLU ID', `The ID encodes ${p.scheme}`) : ''}</dd>
                <dt>Regency / city</dt><dd><span class="mono">${esc(s.kabupaten_kota_code ?? '—')}</span> ${muniTag(s)}</dd>
              </dl>
              <dl class="kv">
                <dt>SLO</dt><dd>${esc(s.slo_number ?? '—')}</dd>
                <dt>SLO validity</dt><dd>${esc(fmt.date(s.slo_issued_at))} → ${esc(fmt.date(s.slo_expires_at))} ${sloTag(s.sloDaysRemaining)}</dd>
                <dt>PBJT-TL</dt><dd>${(bps / 100).toFixed(2)}%${bps > maxBps ? ' ' + tag('t-crit', 'above legal maximum', `Maximum is ${(maxBps / 100).toFixed(0)}%`) : bps === 0 ? ' ' + tag('t-warn', 'not set') : ''}</dd>
              </dl>
            </div>
            <div class="section" data-meters="${i}"></div>
          </div></div>`;
      }).join('');
      list.forEach((s, i) => {
        table($(`[data-meters="${i}"]`, box), {
          columns: [
            { label: 'Charge point', render: (m) => `<span class="mono">${esc(m.chargePoint)}</span>` },
            { label: 'EVSE', num: true, render: (m) => esc(m.evseNo ?? '—') },
            { label: 'Meter serial', render: (m) => (m.meterSerial ? `<span class="mono">${esc(m.meterSerial)}</span>` : tag('t-warn', 'not recorded')) },
            { label: 'Accuracy class', render: (m) => esc(m.accuracyClass ?? '—') },
            { label: 'Type approval', render: (m) => (m.typeApprovalNo ? `<span class="mono">${esc(m.typeApprovalNo)}</span>` : '—') },
            { label: 'Last tera', render: (m) => esc(fmt.date(m.teraLastAt)) },
            { label: 'Due', render: (m) => { const d = daysUntil(m.teraDueAt); return `${esc(fmt.date(m.teraDueAt))}${d == null ? '' : `<div class="cell-sub">${d < 0 ? `${-d}d overdue` : `in ${d}d`}</div>`}`; } },
            { label: 'Status', render: (m) => { const st = meterStatus(m); return `${teraTag(st)}${blocked(st) ? '<div class="cell-sub" style="color:var(--crit)">commercial sessions blocked</div>' : ''}`; } },
          ],
          rows: s.meters ?? [],
          empty: 'No metered connectors at this site yet.',
        });
      });
    };

    const load = async () => {
      try {
        data = await api('/v1/compliance');
      } catch (e) {
        $('[data-sites]', root).innerHTML = callout('crit', esc(e.status === 403 ? 'You do not have permission to view compliance data.' : e.message));
        return;
      }
      const meters = data.flatMap((s) => s.meters ?? []);
      const count = (st) => meters.filter((m) => meterStatus(m) === st).length;
      const soon = data.filter((s) => s.sloDaysRemaining != null && s.sloDaysRemaining < 90);
      const expired = soon.filter((s) => s.sloDaysRemaining < 0).length;
      const blockedN = count('pending') + count('lapsed');
      $('[data-kpis]', root).innerHTML = [
        kpi('Meters verified', fmt.num(count('verified')), `of ${fmt.num(meters.length)} metered connectors`, 'ok'),
        kpi('Tera due soon', fmt.num(count('due_soon')), 'book the re-verification now', count('due_soon') ? 'warn' : ''),
        kpi('Tera lapsed', fmt.num(count('lapsed')), 'commercial sessions blocked', count('lapsed') ? 'crit' : ''),
        kpi('Pending calibration', fmt.num(count('pending')), 'commercial sessions blocked', count('pending') ? 'crit' : ''),
        kpi('SLO expiring < 90 days', fmt.num(soon.length), expired ? `${fmt.num(expired)} already expired` : 'operating certificates', expired ? 'crit' : soon.length ? 'warn' : ''),
      ].join('');
      $('[data-alert]', root).innerHTML = blockedN
        ? callout('crit', `<b>${esc(fmt.num(blockedN))} connector${blockedN === 1 ? '' : 's'} cannot sell energy.</b> EVSE is a UTTP measuring instrument (Permendag 24/2024): a meter awaiting calibration or with lapsed tera may only run free or test sessions until it is verified.`)
        : '';
      drawSites();
    };

    $('[data-q]', root).addEventListener('input', drawSites);
    $('[data-issues]', root).addEventListener('change', drawSites);
    $('[data-refresh]', root).addEventListener('click', load);
    $('[data-csv]', root).addEventListener('click', () => {
      const rows = data.flatMap((s) => (s.meters ?? []).map((m) => [
        s.name, s.spklu_id ?? '', m.chargePoint, m.evseNo, m.meterSerial ?? '', m.accuracyClass ?? '', m.typeApprovalNo ?? '',
        fmt.isoDate(m.teraLastAt), fmt.isoDate(m.teraDueAt), meterStatus(m), blocked(meterStatus(m)) ? 'yes' : 'no',
      ]));
      if (!rows.length) return;
      download(`plugsure-meters-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(
        ['Site', 'SPKLU ID', 'Charge point', 'EVSE', 'Meter serial', 'Accuracy class', 'Type approval', 'Last tera', 'Tera due', 'Status', 'Commercial sessions blocked'],
        rows,
      ), 'text/csv;charset=utf-8');
    });
    await load();
  },
});

// ------------------------------------------------------------------ hardware quirks

const KNOWN_KEYS = new Set([
  'rejectedConfigKeys', 'acceptedConfigKeys', 'emittedMeasurands', 'observedDataTransferVendorIds', 'chargingRateUnit',
  'compositeScheduleTrustworthy', 'txDefaultProfileOnConnector0Propagates', 'acceptsRemoteFirmwareUpdate',
  'maxLocalAuthListEntries', 'specDeviations', 'notes',
]);

const chips = (arr, cls) =>
  Array.isArray(arr) && arr.length
    ? `<div class="chips">${arr.map((x) => tag(cls, typeof x === 'string' ? x : JSON.stringify(x), '', true)).join('')}</div>`
    : '<span class="muted">none recorded</span>';

const boolTag = (v, yes, no, unknown = 'not tested') =>
  v === true ? tag('t-ok', yes) : v === false ? tag('t-crit', no) : tag('t-mute', unknown);

function quirkCard(q) {
  const f = q.findings && typeof q.findings === 'object' ? q.findings : {};
  const unit = f.chargingRateUnit === 'A' ? 'A — amps (typical of AC)' : f.chargingRateUnit === 'W' ? 'W — watts (typical of DC)' : f.chargingRateUnit;
  const extra = Object.entries(f).filter(([k]) => !KNOWN_KEYS.has(k));
  const deviations = Array.isArray(f.specDeviations) ? f.specDeviations : [];
  return `<div class="card">
    <header><div class="grow"><h3>${esc(q.vendor)} ${esc(q.model)}</h3>
      <div class="cell-sub">firmware <span class="mono">${esc(q.firmware_pattern)}</span></div></div>
      <div class="chips">${tag(Number(q.charge_points) ? 't-info' : 't-mute', `${fmt.num(q.charge_points ?? 0)} charge point${Number(q.charge_points) === 1 ? '' : 's'}`)}</div></header>
    <div class="body">
      <dl class="kv">
        <dt>Charging rate unit</dt><dd>${unit ? esc(unit) : '<span class="muted">not recorded</span>'}</dd>
        <dt>Composite schedule</dt><dd>${boolTag(f.compositeScheduleTrustworthy, 'trustworthy', 'unreliable — never load-bearing')}</dd>
        <dt>TxDefault on connector 0</dt><dd>${boolTag(f.txDefaultProfileOnConnector0Propagates, 'propagates to connectors', 'does not propagate — set per connector')}</dd>
        <dt>Remote firmware update</dt><dd>${boolTag(f.acceptsRemoteFirmwareUpdate, 'accepted', 'refused from a third-party CSMS', 'untested')}</dd>
        <dt>Local auth list size</dt><dd>${f.maxLocalAuthListEntries != null ? esc(fmt.num(f.maxLocalAuthListEntries)) : '<span class="muted">not recorded</span>'}</dd>
        <dt>Rejected config keys</dt><dd>${chips(f.rejectedConfigKeys, 't-crit')}</dd>
        <dt>Accepted config keys</dt><dd>${chips(f.acceptedConfigKeys, 't-ok')}</dd>
        <dt>Emitted measurands</dt><dd>${chips(f.emittedMeasurands, 't-info')}</dd>
        <dt>DataTransfer vendor IDs</dt><dd>${chips(f.observedDataTransferVendorIds, 't-warn')}</dd>
        <dt>Spec deviations</dt><dd>${deviations.length ? `<ul style="margin:0;padding-left:18px">${deviations.map((d) => `<li>${esc(typeof d === 'string' ? d : JSON.stringify(d))}</li>`).join('')}</ul>` : '<span class="muted">none recorded</span>'}</dd>
        ${extra.map(([k, v]) => `<dt class="mono">${esc(k)}</dt><dd><pre class="json">${esc(JSON.stringify(v, null, 2))}</pre></dd>`).join('')}
      </dl>
      ${f.notes ? `<div style="margin-top:12px">${callout('info', esc(typeof f.notes === 'string' ? f.notes : JSON.stringify(f.notes)))}</div>` : ''}
      <div class="cell-sub" style="margin-top:10px">Updated ${esc(fmt.ago(q.updated_at))}</div>
    </div></div>`;
}

registerView('quirks', {
  title: 'Hardware quirks',
  icon: 'bug',
  group: 'maintain',
  order: 32,
  perm: 'charge_point:read',
  async render(root) {
    root.innerHTML = pageHead(
      'Hardware quirks registry',
      'What each vendor, model and firmware actually does, learned from the frames they send: config keys they refuse, measurands they really emit, undocumented DataTransfer extensions and deviations from the OCPP specification. The platform consults this before every command.',
      `<button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button>`,
    ) + `<div class="filters">${field('Filter', '<input type="search" data-q placeholder="Vendor or model">')}</div><div class="grid two" data-list></div>`;

    let list = [];
    const draw = () => {
      const q = $('[data-q]', root).value.trim().toLowerCase();
      const rows = list.filter((x) => !q || `${x.vendor} ${x.model}`.toLowerCase().includes(q));
      $('[data-list]', root).innerHTML = rows.length
        ? rows.map(quirkCard).join('')
        : `<div class="card"><div class="empty-state"><h3>${list.length ? 'No profiles match' : 'No quirk profiles yet'}</h3><p>Profiles are created automatically the first time a vendor/model boots.</p></div></div>`;
    };
    const load = async () => {
      try {
        list = await api('/v1/quirks');
      } catch (e) {
        $('[data-list]', root).innerHTML = callout('crit', esc(e.message));
        return;
      }
      draw();
    };
    $('[data-q]', root).addEventListener('input', draw);
    $('[data-refresh]', root).addEventListener('click', load);
    await load();
  },
});
