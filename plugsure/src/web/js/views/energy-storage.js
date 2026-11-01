import {
  $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, kpi, field, copy, sites as loadSites, options,
} from '../core.js';

/**
 * (v1.42.0) Assets & Energy → Solar & battery: on-site solar and batteries per site; what the load manager counts from
 * them (only measured, recent output at the trust share; the grid part held at the peak-shaving target); the battery's
 * set-point; the site energy box's key; energy, self-consumption, the peak shaved and the savings.
 */

const kw = (w) => `${fmt.num(w / 1000, 1)} kW`;
const n1 = (x) => fmt.num(x, 1);
const MODE = { idle: ['t-mute', 'idle'], discharge: ['t-info', 'discharging'], charge_solar: ['t-ok', 'charging from solar'], charge_offpeak: ['t-info', 'charging off-peak'] };

registerView('energy-storage', {
  title: 'Solar & battery',
  icon: 'sun',
  group: 'assets',
  order: 12,
  perm: 'site:read',
  async render(root) {
    const canWrite = state.can('site:write');
    root.innerHTML = pageHead('Solar & battery',
      'On-site solar and batteries. The load manager adds only what they are measured to deliver right now — never a forecast — so the chargers stay within the breaker if a cloud passes or the battery does not respond.',
      canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} Add solar or a battery</button>` : '') + '<div data-body></div>';
    const body = $('[data-body]', root);
    const siteList = (await loadSites()).filter((s) => !s.archived_at);
    const draw = async () => {
      body.innerHTML = '<div class="skeleton" style="height:160px"></div>';
      let d;
      try { d = await api('/v1/energy'); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      if (!d.sites.length) {
        body.innerHTML = `<div class="card pad"><div class="empty-state" style="padding:24px 10px"><h3>No solar or batteries yet</h3>
          <p>Add a site's solar array or battery, then give its inverter or energy box the site key so it can post readings every few seconds.</p></div></div>`;
        return;
      }
      body.innerHTML = d.sites.map((s) => {
        const lm = s.loadManager, sp = s.setpoint, l = s.latest;
        const age = l ? Math.round((Date.now() - Date.parse(l.ts)) / 1000) : null;
        const [mc, ml] = MODE[sp.mode] ?? MODE.idle;
        return `<div class="card section" data-site="${esc(s.siteId)}"><header><h3>${esc(s.siteName)}</h3>
            ${l ? (lm.extra.fresh ? tag('t-ok', `live · ${age}s ago`) : tag('t-warn', `stale · ${fmt.ago(l.ts)}`)) : tag('t-mute', 'no readings yet')}
            <div class="right row" style="gap:6px"><button class="btn sm" type="button" data-results>${icon('chart')} Results</button>
            ${canWrite ? `<button class="btn sm" type="button" data-settings>${icon('gear')} Settings</button><button class="btn sm" type="button" data-key>${icon('key')} Site key</button>` : ''}</div></header>
          <div class="body">
            <div class="grid k4">
              ${kpi('Solar now', l?.solarW != null ? kw(l.solarW) : '—', `${n1(s.fleet.solarKw)} kW installed`)}
              ${kpi('Battery', l?.batterySocPct != null ? `${fmt.num(l.batterySocPct)} %` : '—', l?.batteryW != null ? `${l.batteryW >= 0 ? 'giving' : 'taking'} ${kw(Math.abs(l.batteryW))} · ${n1(s.fleet.energyKwh)} kWh` : `${n1(s.fleet.energyKwh)} kWh`)}
              ${kpi('Grid', l?.gridW != null ? kw(l.gridW) : '—', l?.gridW != null && l.gridW < 0 ? 'exporting' : 'import')}
              ${kpi('Charging budget', kw(lm.totalW), `grid ${kw(lm.gridPartW)}${s.settings.peakShaving ? ` (target ${fmt.num(s.settings.peakTargetKw)} kW)` : ''} + solar ${kw(lm.extra.solarW)} + battery ${kw(lm.extra.batteryW)}`)}
            </div>
            <p class="cell-sub" style="margin:10px 0 0">Battery set-point: ${tag(mc, ml)} ${sp.batteryW ? kw(Math.abs(sp.batteryW)) : ''} — ${esc(sp.reason)}. ${lm.extra.fresh ? '' : `Not counted: ${esc(lm.extra.reason)}.`}
              Solar first ${s.settings.solarFirst ? 'on' : 'off'} · counting ${fmt.num(s.settings.trustPct)} % of what is measured · readings older than ${fmt.num(s.settings.maxAgeS)} s ignored.</p>
            <div data-assets style="margin-top:10px"></div>
          </div></div>`;
      }).join('');
      for (const s of d.sites) {
        const card = $(`[data-site="${s.siteId}"]`, body);
        table($('[data-assets]', card), {
          columns: [
            { label: 'Asset', render: (a) => `${a.kind === 'solar' ? icon('sun') : icon('bolt')} <b>${esc(a.name)}</b>` },
            { label: 'Power', num: true, render: (a) => `${n1(a.capacityKw)} kW${a.peakKwp ? `<div class="cell-sub">${n1(a.peakKwp)} kWp</div>` : ''}` },
            { label: 'Energy', num: true, render: (a) => (a.energyKwh ? `${n1(a.energyKwh)} kWh<div class="cell-sub">SoC ${fmt.num(a.minSocPct)}–${fmt.num(a.maxSocPct)} %</div>` : '—') },
            { label: 'Commissioned', render: (a) => esc(a.commissionedOn ? fmt.date(a.commissionedOn) : '—') },
            { label: '', render: (a) => (canWrite ? `<button class="btn sm" type="button" data-edit="${esc(a.id)}">Edit</button>` : '') },
          ],
          rows: s.assets, empty: 'No assets.',
        });
        $('[data-results]', card).addEventListener('click', () => results(s));
        $('[data-settings]', card)?.addEventListener('click', () => settings(s));
        $('[data-key]', card)?.addEventListener('click', () => siteKey(s));
        card.addEventListener('click', (e) => { const b = e.target.closest('[data-edit]'); if (b) assetForm(s.assets.find((a) => a.id === b.dataset.edit)); });
      }
    };

    const assetForm = (a = null) => {
      const m = modal({
        title: a ? `Edit ${a.name}` : 'Add solar or a battery', size: 'lg',
        body: `<div class="form">
          ${field('Site', `<select name="siteId"${a ? ' disabled' : ''}>${options(siteList.map((s) => ({ value: s.id, label: s.name })), a?.siteId)}</select>`)}
          ${field('Kind', `<select name="kind"${a ? ' disabled' : ''}><option value="solar"${a?.kind === 'solar' ? ' selected' : ''}>Solar array</option><option value="battery"${a?.kind === 'battery' ? ' selected' : ''}>Battery</option></select>`)}
          ${field('Name', `<input name="name" value="${esc(a?.name ?? '')}" placeholder="Carport PV">`)}
          ${field('Power (kW)', `<input name="capacityKw" type="number" step="0.1" min="0.1" value="${esc(a?.capacityKw ?? '')}">`, { help: 'Solar: the inverter\'s AC output. Battery: its charge/discharge power.' })}
          <div data-solar>${field('Array peak (kWp)', `<input name="peakKwp" type="number" step="0.1" min="0.1" value="${esc(a?.peakKwp ?? '')}">`, { opt: true })}</div>
          <div data-battery>${field('Usable energy (kWh)', `<input name="energyKwh" type="number" step="0.1" min="0.1" value="${esc(a?.energyKwh ?? '')}">`)}
            ${field('Lowest state of charge (%)', `<input name="minSocPct" type="number" min="0" max="100" value="${esc(a?.minSocPct ?? 10)}">`)}
            ${field('Highest state of charge (%)', `<input name="maxSocPct" type="number" min="0" max="100" value="${esc(a?.maxSocPct ?? 95)}">`)}</div>
          ${field('Commissioned', `<input name="commissionedOn" type="date" value="${esc(a?.commissionedOn ?? '')}">`, { opt: true })}
        </div>`,
        actions: [
          ...(a ? [{ label: 'Archive', kind: 'danger', async onClick() { await api(`/v1/energy/assets/${a.id}`, { method: 'PUT', body: { archive: true } }); toast('Archived.', 'ok'); draw(); } }] : []),
          { label: 'Cancel' },
          { label: 'Save', kind: 'primary', async onClick(mc) {
            const v = Object.fromEntries([...mc.el.querySelectorAll('[name]')].filter((x) => !x.closest('[hidden]')).map((x) => [x.name, x.value]));
            if (a) { delete v.siteId; delete v.kind; }
            for (const k of Object.keys(v)) if (v[k] === '') delete v[k];
            await api(a ? `/v1/energy/assets/${a.id}` : '/v1/energy/assets', { method: a ? 'PUT' : 'POST', body: v });
            toast('Saved.', 'ok'); draw();
          } },
        ],
      });
      const kindSel = $('[name=kind]', m.el);
      const sync = () => { $('[data-solar]', m.el).hidden = kindSel.value !== 'solar'; $('[data-battery]', m.el).hidden = kindSel.value !== 'battery'; };
      kindSel.addEventListener('change', sync); sync();
    };
    $('[data-add]', root)?.addEventListener('click', () => (siteList.length ? assetForm() : toast('Add a site first.', 'warn')));

    const settings = (s) => {
      const st = s.settings;
      modal({
        title: `${s.siteName}: solar and battery settings`,
        body: `<div class="form">
          <label class="row" style="gap:8px"><input type="checkbox" name="solarFirst"${st.solarFirst ? ' checked' : ''}> Solar first: count the solar being produced in the charging budget</label>
          <label class="row" style="gap:8px"><input type="checkbox" name="peakShaving"${st.peakShaving ? ' checked' : ''}> Peak shaving: hold the grid under a target, the battery makes up the rest</label>
          ${field('Grid target (kW)', `<input name="peakTargetKw" type="number" step="0.1" min="0.1" value="${esc(st.peakTargetKw ?? '')}">`, { help: 'With peak shaving: the most the site takes from the grid for charging.' })}
          ${field('Count (% of what is measured)', `<input name="trustPct" type="number" min="0" max="100" value="${esc(st.trustPct)}">`, { help: 'A margin for output that drops between two readings (a cloud). 80 % by default.' })}
          ${field('Ignore readings older than (s)', `<input name="maxAgeS" type="number" min="15" max="900" value="${esc(st.maxAgeS)}">`)}
        </div>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(mc) {
          const f = (n) => $(`[name=${n}]`, mc.el);
          await api(`/v1/energy/sites/${s.siteId}/settings`, { method: 'PUT', body: { solarFirst: f('solarFirst').checked, peakShaving: f('peakShaving').checked,
            peakTargetKw: f('peakTargetKw').value || null, trustPct: f('trustPct').value, maxAgeS: f('maxAgeS').value } });
          toast('Saved.', 'ok'); draw();
        } }],
      });
    };

    const siteKey = (s) => {
      const path = `/v1/energy/sites/${s.siteId}/readings`;
      const m = modal({
        title: `${s.siteName}: the energy box's key`, size: 'lg',
        body: `<p>The site's inverter, EMS or gateway posts what it measures, a few times a minute, and gets back the battery set-point:</p>
          <pre class="mono small" style="white-space:pre-wrap">POST ${esc(location.origin)}${esc(path)}
Authorization: Bearer &lt;site key&gt;
{"ts": "2026-11-01T10:00:00+07:00", "solarW": 42000, "batteryW": 15000, "batterySocPct": 64, "gridW": 38000}</pre>
          <p class="cell-sub">batteryW: + giving power to the site, − charging. gridW: + import, − export. Up to 500 readings in {"readings": [...]}.</p>
          ${s.settings.ingestKeyHint ? callout('info', `A key ending ${esc(s.settings.ingestKeyHint)} is set. A new one replaces it at once.`) : ''}
          <div data-k></div>`,
        actions: [{ label: 'Close' }, { label: s.settings.ingestKeyHint ? 'New key' : 'Create key', kind: 'primary', async onClick() {
          const r = await api(`/v1/energy/sites/${s.siteId}/key`, { method: 'POST' });
          $('[data-k]', m.el).innerHTML = `${callout('warn', 'Shown once. Put it in the energy box now.')}<div class="row" style="gap:8px"><code class="mono" style="word-break:break-all">${esc(r.key)}</code><button class="btn sm" type="button" data-c>Copy</button></div>`;
          $('[data-c]', m.el).addEventListener('click', () => copy(r.key));
          return false;
        } }],
      });
    };

    const results = async (s) => {
      const m = modal({ title: `${s.siteName}: results`, size: 'lg', body: '<div class="filters" style="margin-top:0"><div data-f></div></div><div data-r><div class="skeleton" style="height:140px"></div></div>', actions: [{ label: 'Close' }] });
      const today = new Date().toISOString().slice(0, 10);
      $('[data-f]', m.el).outerHTML = `${field('From', `<input type="date" name="from" value="${new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10)}">`)}${field('To', `<input type="date" name="to" value="${today}">`)}`;
      const load = async () => {
        const box = $('[data-r]', m.el);
        let r;
        try { r = await api(`/v1/energy/sites/${s.siteId}/results?from=${$('[name=from]', m.el).value}&to=${$('[name=to]', m.el).value}`); } catch (e) { box.innerHTML = callout('crit', esc(e.message)); return; }
        const t = r.totals;
        const money = (minor) => (minor == null ? '—' : fmt.money(minor, r.currency));
        const max = Math.max(1, ...r.days.map((d) => Math.max(d.solarKwh, d.importKwh)));
        box.innerHTML = `<div class="grid k4">${kpi('Solar', `${n1(t.solarKwh)} kWh`, t.selfConsumptionPct != null ? `${n1(t.selfConsumptionPct)} % used on site` : '')}
            ${kpi('Battery', `${n1(t.batteryOutKwh)} kWh out`, `${n1(t.batteryInKwh)} in · ${n1(t.batteryFromGridKwh)} from the grid${r.batteryCycles != null ? ` · ${n1(r.batteryCycles)} cycles` : ''}`)}
            ${kpi('Grid peak', `${n1(t.peakGridKw)} kW`, `${n1(t.peakShavedKw)} kW shaved (without the battery ${n1(t.peakWithoutBatteryKw)})`)}
            ${kpi('Saved', money(t.savingsMinor), r.tariff ? `at ${fmt.num(r.tariff.rateOffpeak)}–${fmt.num(r.tariff.ratePeak)} per kWh` : 'set the site\'s tariff (Finance → Energy tariffs)')}</div>
          ${r.days.length ? `<div class="section"><b>Solar and grid import by day (kWh)</b><svg viewBox="0 0 ${Math.max(r.days.length * 14, 210)} 80" preserveAspectRatio="xMinYMax meet" style="width:100%;height:110px" role="img" aria-label="Solar and grid import by day">${r.days.map((d, i) =>
            `<rect x="${i * 14 + 1}" y="${80 - (d.solarKwh / max) * 78}" width="5" height="${(d.solarKwh / max) * 78}" fill="var(--warn)"><title>${esc(d.day)}: solar ${d.solarKwh} kWh</title></rect><rect x="${i * 14 + 7}" y="${80 - (d.importKwh / max) * 78}" width="5" height="${(d.importKwh / max) * 78}" fill="var(--info)"><title>${esc(d.day)}: grid ${d.importKwh} kWh</title></rect>`).join('')}</svg>
            <div class="cell-sub">${tag('t-warn', 'solar')} ${tag('t-info', 'grid import')}</div></div>` : ''}
          <div data-days class="section"></div>`;
        table($('[data-days]', box), {
          columns: [
            { label: 'Day', render: (d) => esc(fmt.date(d.day)) }, { label: 'Solar', num: true, render: (d) => `${n1(d.solarKwh)} kWh` },
            { label: 'Used on site', num: true, render: (d) => (d.selfConsumptionPct != null ? `${n1(d.selfConsumptionPct)} %` : '—') },
            { label: 'Battery out', num: true, render: (d) => `${n1(d.batteryOutKwh)} kWh` }, { label: 'Grid peak', num: true, render: (d) => `${n1(d.peakGridKw)} kW` },
            { label: 'Saved', num: true, render: (d) => money(d.savingsMinor) },
          ],
          rows: r.days.slice().reverse(), empty: 'No readings in this period.',
        });
      };
      $$('[name=from],[name=to]', m.el).forEach((x) => x.addEventListener('change', load));
      load();
    };
    await draw();
  },
});
