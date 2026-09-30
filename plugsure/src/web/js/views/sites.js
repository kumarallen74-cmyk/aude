import {
  $, $$, esc, api, attempt, state, registerView, pageHead, table, tag, icon, fmt, modal, drawer, field, options,
  formValues, fieldErrors, toast, callout, kpi, navigate, sites as loadSites, onlineTag, confirmDialog,
} from '../core.js';

/**
 * Module 3 — Site Infrastructure & PLN Grid Capacity Management.
 * Replaces the SQL that used to create every electrical site.
 */

const TIMEZONES = [
  { value: 'Asia/Jakarta', label: 'WIB — Asia/Jakarta' },
  { value: 'Asia/Makassar', label: 'WITA — Asia/Makassar' },
  { value: 'Asia/Jayapura', label: 'WIT — Asia/Jayapura' },
];

const liveTag = (s) =>
  s === 'online' ? tag('t-ok', 'all online') : s === 'partial' ? tag('t-warn', 'partly offline') : s === 'offline' ? tag('t-crit', 'offline') : tag('t-mute', 'no chargers');

// ------------------------------------------------------------------ engineering card

/** The live computed card: kVA × PF ceiling, the 200 kVA cliff, rekening minimum. */
export function computeCard(kva, pf) {
  const k = Number(kva);
  const p = Number(pf);
  if (!(k > 0) || !(p > 0)) return callout('info', 'Enter the subscribed capacity and power factor to see the site\'s active-power ceiling and billing floor.');
  const ceilingKw = k * p;
  const cliff = k > (state.meta?.trTmCliffKva ?? 200);
  return `<div class="grid k3" style="gap:10px">
    ${kpi('Active power ceiling', `${fmt.num(ceilingKw, 1)} kW`, `${fmt.num(k)} kVA × ${p.toFixed(2)} PF — the DLM hard cap`)}
    ${kpi('Rekening minimum', `${fmt.num(40 * k)} kWh`, `40 h × ${fmt.num(k)} kVA per month, payable whether used or not`)}
    ${kpi('Voltage class', cliff ? 'TM (medium)' : 'TR (low)', cliff ? 'Above the 200 kVA cliff: transformer, cubicle switchgear, MV metering' : 'Under the 200 kVA TR/TM cliff', cliff ? 'warn' : 'ok')}
  </div>`;
}

// ------------------------------------------------------------------ map picker (OpenStreetMap tiles, no library)

/**
 * A small slippy map. Drag to pan, +/- or wheel to zoom, click to drop the pin.
 * Tiles come from tile.openstreetmap.org (allowed in the CSP); if the operator's
 * network cannot reach it, the latitude/longitude inputs still work.
 */
export function mapPicker(box, { lat, lon, onPick }) {
  const TILE = 256;
  let z = lat != null && lon != null ? 16 : 5;
  let cLat = lat ?? -2.5;
  let cLon = lon ?? 118;
  let pin = lat != null && lon != null ? { lat, lon } : null;

  box.classList.add('map');
  box.innerHTML = `<div class="ctrls"><button type="button" data-z="1" aria-label="Zoom in">+</button><button type="button" data-z="-1" aria-label="Zoom out">−</button></div>
    <div class="attr">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a></div><div data-layer></div>`;
  const layer = $('[data-layer]', box);

  const project = (la, lo, zz) => {
    const n = TILE * 2 ** zz;
    const s = Math.sin((la * Math.PI) / 180);
    return { x: ((lo + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
  };
  const unproject = (x, y, zz) => {
    const n = TILE * 2 ** zz;
    const lo = (x / n) * 360 - 180;
    const la = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    return { lat: la, lon: lo };
  };

  function draw() {
    const w = box.clientWidth || 600;
    const h = box.clientHeight || 280;
    const c = project(cLat, cLon, z);
    const x0 = c.x - w / 2;
    const y0 = c.y - h / 2;
    const n = 2 ** z;
    let html = '';
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + w) / TILE); tx++) {
      for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + h) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        html += `<img alt="" loading="lazy" src="https://tile.openstreetmap.org/${z}/${wx}/${ty}.png" style="left:${Math.round(tx * TILE - x0)}px;top:${Math.round(ty * TILE - y0)}px">`;
      }
    }
    if (pin) {
      const p = project(pin.lat, pin.lon, z);
      html += `<svg class="pin" viewBox="0 0 24 24" style="left:${Math.round(p.x - x0)}px;top:${Math.round(p.y - y0)}px">${icon('pin').replace(/^<svg[^>]*>|<\/svg>$/g, '')}</svg>`;
    }
    layer.innerHTML = html;
  }

  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.ctrls, .attr')) return;
    drag = { x: e.clientX, y: e.clientY, moved: false, c: project(cLat, cLon, z) };
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    const ll = unproject(drag.c.x - dx, drag.c.y - dy, z);
    cLat = ll.lat; cLon = ll.lon;
    draw();
  });
  box.addEventListener('pointerup', (e) => {
    if (!drag) return;
    if (!drag.moved) {
      const r = box.getBoundingClientRect();
      const c = project(cLat, cLon, z);
      const ll = unproject(c.x - r.width / 2 + (e.clientX - r.left), c.y - r.height / 2 + (e.clientY - r.top), z);
      pin = { lat: Math.round(ll.lat * 1e6) / 1e6, lon: Math.round(ll.lon * 1e6) / 1e6 };
      onPick?.(pin.lat, pin.lon);
      draw();
    }
    drag = null;
  });
  box.addEventListener('wheel', (e) => { e.preventDefault(); z = Math.max(3, Math.min(19, z + (e.deltaY < 0 ? 1 : -1))); draw(); }, { passive: false });
  $$('[data-z]', box).forEach((b) => b.addEventListener('click', () => { z = Math.max(3, Math.min(19, z + Number(b.dataset.z))); draw(); }));
  requestAnimationFrame(draw);
  return {
    set(la, lo) {
      if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
      pin = { lat: la, lon: lo }; cLat = la; cLon = lo; if (z < 14) z = 16; draw();
    },
  };
}

// ------------------------------------------------------------------ create / edit modal

/** Opens the Create / Edit Electrical Site modal. Resolves with the site id when saved. */
export function openSiteModal(site = null) {
  return new Promise((resolve) => {
    const meta = state.meta ?? {};
    const s = site ?? { power_factor: 0.95, phases: 3, timezone: 'Asia/Jakarta', pbjt_rate_bps: 0 };
    let savedId = null;
    const ctx = modal({
      title: site ? `Edit site — ${site.name}` : 'Create electrical site',
      subtitle: 'Grid connection and regulatory details are validated on save; an invalid site cannot be stored.',
      size: 'xl',
      body: `<form novalidate>
        <fieldset><legend>General information</legend><div class="form">
          ${field('Site name', `<input name="name" maxlength="200" placeholder="Summarecon Mall Bekasi — P2 Basement">`, { full: true })}
          ${field('Street address', `<input name="address" placeholder="Jl. Bulevar Ahmad Yani, Bekasi">`, { full: true })}
          ${field('City', `<input name="city" maxlength="45" placeholder="Bekasi">`, { opt: true, help: 'Needed to share the site with roaming partners.' })}
          ${field('Postal code', `<input name="postalCode" inputmode="numeric" maxlength="5" placeholder="17142">`, { opt: true })}
          ${field('Regency / city code', `<input name="kabupatenKotaCode" inputmode="numeric" maxlength="4" placeholder="3171">`, { help: '4-digit BPS code, e.g. 3171 Jakarta Pusat, 3275 Kota Bekasi. Drives PBJT and must match the SPKLU ID.' })}
          ${field('Time zone', `<select name="timezone">${options(TIMEZONES, s.timezone)}</select>`)}
          ${field('Latitude', `<input name="lat" inputmode="decimal" placeholder="-6.2246">`)}
          ${field('Longitude', `<input name="lon" inputmode="decimal" placeholder="106.9998">`)}
          <div class="field full"><div class="row"><span class="lbl small muted">Click the map to place the site, drag to pan.</span>
            <button type="button" class="btn sm ghost right" data-geo>${icon('site')} Use my location</button></div><div data-map></div></div>
        </div></fieldset>
        <fieldset style="margin-top:14px"><legend>PLN grid connection</legend><div class="form">
          ${field('Grid tariff group', `<select name="gridTariffGroup">${options((meta.plnTariffGroups ?? []).map((g) => ({ value: g.code, label: g.label })), s.grid_tariff_group, { blank: 'Choose…' })}</select>`)}
          ${field('Subscribed capacity', `<div class="inputgroup"><input name="connectedKva" inputmode="decimal" placeholder="250"><span class="suffix">kVA</span></div>`)}
          ${field('Power factor', `<input name="powerFactor" inputmode="decimal" placeholder="0.95">`)}
          ${field('Incoming supply', `<select name="phases">${options([{ value: 3, label: '3-phase (400 V)' }, { value: 1, label: '1-phase (230 V)' }], s.phases)}</select>`)}
          <div class="full" data-compute></div>
        </div></fieldset>
        <fieldset style="margin-top:14px"><legend>Indonesian regulatory & SPKLU compliance (Permen ESDM 1/2023)</legend><div class="form">
          ${field('Official SPKLU ID', `<input name="spkluId" placeholder="01.POSO.20.3171.011" class="mono">`, { help: 'XX.SCHEME.YY.ZZZZ.NNN' })}
          ${field('Business scheme', `<select name="spkluScheme">${options(meta.spkluSchemes ?? [], s.spklu_scheme, { blank: 'Choose…' })}</select>`, { help: 'P = provider, R = retailer · O = owned, L = leased · SO = self-operated, PO = partner-operated' })}
          ${field('PBJT-TL local tax', `<div class="inputgroup"><input name="pbjtRateBps" inputmode="numeric" placeholder="500"><span class="suffix">bps</span></div>`, { help: '<span data-pbjt></span> Set by the kabupaten/kota; 1000 bps = 10% maximum.' })}
          ${field('SLO certificate number', `<input name="sloNumber" placeholder="SLO/2025/JKT/00412">`)}
          ${field('SLO issuing agency (LIT)', `<input name="sloIssuer" placeholder="PT …">`)}
          ${field('SLO issue date', `<input name="sloIssuedAt" type="date">`)}
          ${field('SLO expiry date', `<input name="sloExpiresAt" type="date">`)}
        </div></fieldset>
        <fieldset style="margin-top:14px"><legend>Monitoring</legend><div class="form">
          ${field('Offline alert after', `<div class="inputgroup"><input name="offlineAlertMinutes" inputmode="numeric" placeholder="fleet default"><span class="suffix">minutes</span></div>`, { opt: true, help: 'How long a charger here may be offline before the critical alert. Empty = the fleet default. A site with a weak mobile signal may need longer.' })}
        </div></fieldset>
        <fieldset style="margin-top:14px"><legend>Driver queue</legend>
          <label class="check"><input type="checkbox" name="queueEnabled"${s.queue_enabled ? ' checked' : ''}> <span>Let drivers queue in the app when every connector they can use is taken</span></label>
          <p class="small muted" style="margin:6px 0 10px">First come, first served. When a connector frees up, the charger holds it for the first driver waiting who can use it. Nobody can walk up and take it meanwhile. Not taken in time, the driver misses their turn and leaves the queue.</p>
          <div class="form">
          ${field('Time to start', `<div class="inputgroup"><input name="queueOfferMinutes" inputmode="numeric" placeholder="5"><span class="suffix">minutes</span></div>`, { help: '2 to 15. How long a freed connector is held for the next driver.' })}
          ${field('Longest queue', `<div class="inputgroup"><input name="queueMaxLength" inputmode="numeric" placeholder="20"><span class="suffix">drivers</span></div>`, { help: '1 to 200.' })}
          ${field('Longest wait', `<div class="inputgroup"><input name="queueMaxWaitMinutes" inputmode="numeric" placeholder="120"><span class="suffix">minutes</span></div>`, { help: '15 to 720. A place in the queue ends after this.' })}
        </div></fieldset>
        <fieldset style="margin-top:14px"><legend>Reservations</legend><div class="form">
          ${field('Reservation fee', `<div class="inputgroup"><input name="reservationFeeIdr" inputmode="numeric" placeholder="0 = free"><span class="suffix">Rp</span></div>`, { help: 'For holding a connector 15 minutes from the driver app, before PPN. App drivers pay it first; fleet cards are billed on the fleet invoice. Kept once the connector is held, charging or not; not charged if the charger refuses or the driver cancels within 2 minutes. Queue turns are always free.' })}
        </div></fieldset>
        <fieldset style="margin-top:14px"><legend>Signed meter data (OCMF)</legend><div class="form">
          ${field('Signed readings', `<select name="signedMeterPolicy"><option value="record">Keep and check (default)</option><option value="require">Require: bill only verified sessions</option><option value="off">Ignore</option></select>`, { full: true, help: 'For chargers whose meters sign their readings (calibration-law meters, OCMF). Readings are checked against each connector’s registered meter key and against the bill. Require parks any session whose signed start and end readings do not verify or do not match.' })}
        </div></fieldset>
        <fieldset style="margin-top:14px"><legend>Bidirectional charging (V2G / V2B)</legend>
          <label class="check"><input type="checkbox" name="v2xEnabled"${s.v2x_enabled ? ' checked' : ''}> <span>Let cars give energy back during set hours, when their driver or fleet agrees</span></label>
          <p class="small muted" style="margin:6px 0 10px">Needs OCPP 2.1 chargers and cars that offer bidirectional charging over ISO 15118-20. A car is never discharged below the battery floor, nor in the hour before its driver leaves. Drivers switch it on per charge in the app; fleets agree for all their cards.</p>
          <div class="form">
          ${field('Discharge hours', `<input name="v2xWindows" placeholder="17:00-22:00">`, { help: 'Local time, e.g. PLN’s evening peak 17:00-22:00. Several ranges separated by commas; 00:00-00:00 is all day.' })}
          ${field('Site discharge limit', `<div class="inputgroup"><input name="v2xMaxDischargeKw" inputmode="decimal" placeholder="no limit"><span class="suffix">kW</span></div>`, { opt: true, help: 'The most all cars together give back at once.' })}
          ${field('Battery floor', `<div class="inputgroup"><input name="v2xMinSocPercent" inputmode="numeric" placeholder="40"><span class="suffix">%</span></div>`, { help: '10 to 95. Drivers may choose a higher floor, never a lower one.' })}
          ${field('Driver credit', `<div class="inputgroup"><input name="v2xCreditIdrPerKwh" inputmode="numeric" placeholder="0"><span class="suffix">Rp / kWh</span></div>`, { help: 'Taken off the driver’s session before tax, for each kWh given back (never below zero). Fixed for a charge when the driver agrees.' })}
          </div>
          <label class="check" style="margin-top:8px"><input type="checkbox" name="v2xAllowExport"${s.v2x_allow_export ? ' checked' : ''}> <span>Energy may flow back to the PLN grid (only with a PLN export agreement)</span></label>
          <p class="small muted" style="margin:6px 0 0">Off: cars only cover the site’s own use. Discharge is capped at the auxiliary load set under Load management (lighting, air-conditioning, the shop), so nothing reaches the grid.</p>
        </fieldset>
        <div data-warnings style="margin-top:12px"></div>
      </form>`,
      actions: [
        { label: 'Cancel' },
        {
          label: site ? 'Save changes' : 'Create site',
          kind: 'primary',
          async onClick(c) {
            const form = $('form', c.body);
            const v = formValues(form);
            // The discharge limit is typed in kW and stored in W.
            const kw = String(v.v2xMaxDischargeKw ?? '').trim();
            v.v2xMaxDischargeW = kw ? Math.round(Number(kw) * 1000) : null;
            delete v.v2xMaxDischargeKw;
            try {
              const r = site
                ? await api(`/v1/sites/${encodeURIComponent(site.id)}`, { method: 'PUT', body: v })
                : await api('/v1/sites', { method: 'POST', body: v });
              savedId = site?.id ?? r.id;
              toast(site ? 'Site updated' : 'Site created', 'ok');
              (r.warnings ?? []).forEach((w) => toast(w, 'warn'));
              state.sitesCache = null;
            } catch (e) {
              fieldErrors(form, e.data?.errors ?? {});
              if (!e.data?.errors) toast(e.message, 'crit');
              return false;
            }
          },
        },
      ],
      onClose: () => resolve(savedId),
    });

    const form = $('form', ctx.body);
    // Values are assigned as properties, never interpolated into markup.
    const set = (name, v) => { const i = $(`[name="${name}"]`, form); if (i && v != null) i.value = v; };
    set('name', s.name); set('address', s.address); set('city', s.city); set('postalCode', s.postal_code); set('kabupatenKotaCode', s.kabupaten_kota_code);
    set('lat', s.lat); set('lon', s.lon); set('connectedKva', s.connected_kva); set('powerFactor', s.power_factor);
    set('spkluId', s.spklu_id); set('pbjtRateBps', s.pbjt_rate_bps); set('sloNumber', s.slo_number); set('sloIssuer', s.slo_issuer);
    set('sloIssuedAt', fmt.isoDate(s.slo_issued_at)); set('sloExpiresAt', fmt.isoDate(s.slo_expires_at)); set('offlineAlertMinutes', s.offline_alert_minutes);
    set('queueOfferMinutes', s.queue_offer_minutes); set('queueMaxLength', s.queue_max_length); set('queueMaxWaitMinutes', s.queue_max_wait_minutes); set('reservationFeeIdr', s.reservation_fee_idr || '');
    set('v2xWindows', (s.v2x_windows ?? []).map((w) => `${w.from}-${w.to}`).join(', ')); set('v2xMinSocPercent', s.v2x_min_soc_percent); set('v2xCreditIdrPerKwh', s.v2x_credit_idr_per_kwh);
    set('v2xMaxDischargeKw', s.v2x_max_discharge_w ? s.v2x_max_discharge_w / 1000 : '');
    set('signedMeterPolicy', s.signed_meter_policy ?? 'record');

    const compute = () => {
      $('[data-compute]', form).innerHTML = computeCard($('[name=connectedKva]', form).value, $('[name=powerFactor]', form).value);
      const bps = Number($('[name=pbjtRateBps]', form).value);
      $('[data-pbjt]', form).textContent = Number.isFinite(bps) ? `= ${(bps / 100).toFixed(2)}%.` : '';
    };
    ['connectedKva', 'powerFactor', 'pbjtRateBps'].forEach((n) => $(`[name=${n}]`, form).addEventListener('input', compute));
    compute();

    // SPKLU ID -> suggest scheme and municipality.
    $('[name=spkluId]', form).addEventListener('change', (e) => {
      const m = /^\d{2}\.([A-Z]{4})\.\d{2}\.(\d{4})\.\d{3}$/.exec(e.target.value.trim().toUpperCase());
      if (!m) return;
      if (!$('[name=spkluScheme]', form).value) $('[name=spkluScheme]', form).value = m[1];
      if (!$('[name=kabupatenKotaCode]', form).value) $('[name=kabupatenKotaCode]', form).value = m[2];
    });

    const map = mapPicker($('[data-map]', form), {
      lat: s.lat != null ? Number(s.lat) : null,
      lon: s.lon != null ? Number(s.lon) : null,
      onPick(la, lo) { set('lat', la); set('lon', lo); },
    });
    const syncMap = () => map.set(Number($('[name=lat]', form).value), Number($('[name=lon]', form).value));
    $('[name=lat]', form).addEventListener('change', syncMap);
    $('[name=lon]', form).addEventListener('change', syncMap);
    $('[data-geo]', form).addEventListener('click', () => {
      if (!navigator.geolocation) return toast('This browser cannot share its location', 'warn');
      navigator.geolocation.getCurrentPosition(
        (p) => { const la = Math.round(p.coords.latitude * 1e6) / 1e6; const lo = Math.round(p.coords.longitude * 1e6) / 1e6; set('lat', la); set('lon', lo); map.set(la, lo); },
        () => toast('Location permission was refused', 'warn'),
      );
    });
  });
}

// ------------------------------------------------------------------ detail drawer

export async function openSiteDrawer(siteId) {
  const d = drawer({
    title: 'Site',
    onClose: () => { if (location.hash.startsWith('#/sites/')) history.replaceState(null, '', '#/sites'); },
    tabs: [
      {
        id: 'overview',
        label: 'Overview',
        async render(body, ctx) {
          const s = await api(`/v1/sites/${encodeURIComponent(siteId)}`);
          ctx.el.querySelector('h2').textContent = s.name;
          ctx.setSubtitle(`${esc(s.address ?? '')}${s.spklu_id ? ` · <span class="mono">${esc(s.spklu_id)}</span>` : ''}`);
          const canEdit = state.can('site:write');
          const sloDays = s.slo_expires_at ? Math.floor((new Date(s.slo_expires_at) - Date.now()) / 86400000) : null;
          body.innerHTML = `
            <div class="row" style="margin-bottom:14px">
              ${canEdit ? `<button class="btn" data-edit>${icon('gear')} Edit site</button>` : ''}
              ${state.can('smartcharging:read') ? `<a class="btn" href="#/power/${encodeURIComponent(siteId)}">${icon('power')} Load management</a>` : ''}
              ${state.can('charge_point:write') ? `<a class="btn" href="#/onboard/${encodeURIComponent(siteId)}">${icon('plus')} Add charge point here</a>` : ''}
            </div>
            <div data-compute></div>
            <div class="grid two" style="margin-top:14px">
              <div class="card pad"><h3 style="font-size:13px;margin-bottom:10px">Grid connection</h3><dl class="kv">
                <dt>Tariff group</dt><dd>${esc(s.grid_tariff_group ?? '—')}</dd>
                <dt>Subscribed</dt><dd>${esc(s.connected_kva ?? '—')} kVA · PF ${esc(s.power_factor)}</dd>
                <dt>Supply</dt><dd>${Number(s.phases) === 1 ? '1-phase 230 V' : '3-phase 400 V'}</dd>
                <dt>Managed ceiling</dt><dd>${s.ceiling_w != null ? fmt.kw(Math.min(Number(s.ceiling_w), Number(s.connected_kva ?? Infinity) * 1000 * Number(s.power_factor))) : '—'}${s.curtailed ? ' ' + tag('t-crit', 'curtailed') : ''}</dd>
                <dt>Coordinates</dt><dd class="mono">${s.lat != null ? `${esc(s.lat)}, ${esc(s.lon)}` : '—'}</dd>
                <dt>Time zone</dt><dd>${esc(s.timezone)}</dd>
              </dl></div>
              <div class="card pad"><h3 style="font-size:13px;margin-bottom:10px">Regulatory</h3><dl class="kv">
                <dt>SPKLU ID</dt><dd class="mono">${esc(s.spklu_id ?? '—')}</dd>
                <dt>Scheme</dt><dd>${esc(s.spklu_scheme ?? '—')}</dd>
                <dt>Regency/city</dt><dd>${esc(s.kabupaten_kota_code ?? '—')}</dd>
                <dt>PBJT-TL</dt><dd>${(Number(s.pbjt_rate_bps ?? 0) / 100).toFixed(2)}%</dd>
                <dt>SLO</dt><dd>${esc(s.slo_number ?? '—')}${s.slo_issuer ? ` · ${esc(s.slo_issuer)}` : ''}</dd>
                <dt>SLO validity</dt><dd>${fmt.date(s.slo_issued_at)} → ${fmt.date(s.slo_expires_at)} ${
                  sloDays == null ? '' : sloDays < 0 ? tag('t-crit', 'expired') : sloDays < 90 ? tag('t-warn', `${sloDays}d left`) : tag('t-ok', `${sloDays}d left`)}</dd>
              </dl></div>
            </div>
            <div class="section"><h2>Charge points</h2><div class="card" data-cps></div></div>`;
          $('[data-compute]', body).innerHTML = computeCard(s.connected_kva, s.power_factor);
          $('[data-edit]', body)?.addEventListener('click', async () => { if (await openSiteModal(s)) ctx.refresh(); });
          const cps = (await api('/v1/charge-points').catch(() => [])).filter((c) => c.site_id === siteId);
          table($('[data-cps]', body), {
            columns: [
              { label: 'Charge point', render: (c) => `<div class="cell-title">${esc(c.display_name || c.ocpp_identity)}</div><div class="cell-sub mono">${esc(c.ocpp_identity)}</div>` },
              { label: 'Model', render: (c) => `${esc(c.vendor ?? '—')} ${esc(c.model ?? '')}` },
              { label: 'State', render: (c) => onlineTag(c.online, c.status) },
              { label: 'Connectors', num: true, render: (c) => esc((c.connectors ?? []).length) },
            ],
            rows: cps,
            empty: 'No charge points at this site yet.',
            onRow: (c) => { ctx.close(); navigate(`#/chargers/${encodeURIComponent(c.ocpp_identity)}`); },
          });
        },
      },
      { id: 'queue', label: 'Driver queue', render: queueTab(siteId) },
    ],
  });
  return d;
}

// ------------------------------------------------------------------ driver queue

const QUEUE_STATE = {
  waiting: ['t-info', 'waiting'], offered: ['t-ok', 'connector held'], served: ['t-ok', 'charged'], left: ['t-mute', 'left'],
  missed: ['t-warn', 'missed turn'], expired: ['t-warn', 'waited too long'], removed: ['t-mute', 'removed'],
};
const queueTag = (st) => tag(...(QUEUE_STATE[st] ?? ['t-mute', st]));
const minsSince = (t, until = Date.now()) => Math.max(0, Math.round((new Date(until) - new Date(t)) / 60000));

/** Who is waiting at the site, who holds a connector, and how the last day went. Refreshes every 15 s. */
function queueTab(siteId) {
  return async (body, ctx) => {
    const canEdit = state.can('site:write');
    const draw = async () => {
      const q = await api(`/v1/sites/${encodeURIComponent(siteId)}/queue`);
      if (!body.isConnected) return;
      const live = q.entries.filter((e) => e.state === 'waiting' || e.state === 'offered');
      const ended = q.entries.filter((e) => e.state !== 'waiting' && e.state !== 'offered');
      body.innerHTML = `
        ${q.settings.enabled ? '' : callout('info', `The driver queue is off at this site.${canEdit ? ' Switch it on under <b>Edit site</b> → Driver queue.' : ''}`)}
        <div class="grid k4">
          ${kpi('Waiting', fmt.num(q.stats.waiting), q.settings.enabled ? `of at most ${fmt.num(q.settings.maxLength)}` : 'queue off')}
          ${kpi('Connector held', fmt.num(q.stats.offered), `${fmt.num(q.settings.offerMinutes)} min to start`)}
          ${kpi('Charged from the queue', fmt.num(q.stats.served24h), q.stats.medianWaitMinutes != null ? `median wait ${fmt.num(q.stats.medianWaitMinutes)} min · 24 h` : 'last 24 h')}
          ${kpi('Missed their turn', fmt.num(q.stats.missed24h), `${fmt.num(q.stats.left24h)} left · 24 h`, q.stats.missed24h > 0 ? 'warn' : '')}
        </div>
        <div class="section"><h2>In the queue now</h2><div class="card" data-live></div></div>
        <div class="section"><h2>Last 24 hours</h2><div class="card" data-ended></div></div>`;
      table($('[data-live]', body), {
        columns: [
          { label: '#', num: true, render: (e) => (e.position != null ? esc(e.position) : '—') },
          { label: 'Driver', render: (e) => `<span class="mono">${esc(e.driver)}</span>` },
          { label: 'Wants', render: (e) => esc(e.want) },
          { label: 'Joined', render: (e) => `${esc(fmt.time(e.joinedAt))}<div class="cell-sub">${e.state === 'offered' ? `waited ${fmt.num(minsSince(e.joinedAt, e.offeredAt))} min` : `waiting ${fmt.num(minsSince(e.joinedAt))} min`}</div>` },
          { label: 'State', render: (e) => `${queueTag(e.state)}${e.offer ? `<div class="cell-sub">${esc(e.offer.connector)} until ${esc(fmt.time(e.offer.expiresAt))}</div>` : ''}` },
          { label: '', render: (e) => (canEdit ? `<button class="btn sm ghost" data-remove="${esc(e.id)}">Remove</button>` : '') },
        ],
        rows: live,
        empty: q.settings.enabled ? 'Nobody is waiting.' : 'The queue is off.',
      });
      table($('[data-ended]', body), {
        columns: [
          { label: 'Driver', render: (e) => `<span class="mono">${esc(e.driver)}</span>` },
          { label: 'Wants', render: (e) => esc(e.want) },
          { label: 'Joined', render: (e) => esc(fmt.time(e.joinedAt)) },
          { label: 'Waited', num: true, render: (e) => `${fmt.num(minsSince(e.joinedAt, e.offeredAt ?? e.endedAt))} min` },
          { label: 'Outcome', render: (e) => `${queueTag(e.state)}${e.endReason && !['charging', 'left', 'waited too long', 'offer not taken in time'].includes(e.endReason) ? `<div class="cell-sub">${esc(e.endReason)}</div>` : ''}` },
        ],
        rows: ended,
        empty: 'No queue activity in the last 24 hours.',
      });
      $$('[data-remove]', body).forEach((b) => b.addEventListener('click', async () => {
        const e = live.find((x) => x.id === b.dataset.remove);
        if (!(await confirmDialog({
          title: 'Remove this driver from the queue?',
          message: e?.state === 'offered' ? 'The connector held for them is released and goes to the next driver. They get a notification.' : 'They lose their place and get a notification.',
          danger: true, confirmLabel: 'Remove',
        }))) return;
        if (await attempt(() => api(`/v1/sites/${encodeURIComponent(siteId)}/queue/${encodeURIComponent(b.dataset.remove)}`, { method: 'DELETE' }), { success: 'Removed from the queue' })) draw();
      }));
    };
    await draw();
    const timer = setInterval(() => { if (body.isConnected) draw().catch(() => {}); }, 15_000);
    ctx.cleanup = () => clearInterval(timer);
  };
}

// ------------------------------------------------------------------ list view

registerView('sites', {
  title: 'Sites',
  icon: 'site',
  group: 'assets',
  order: 10,
  perm: 'site:read',
  async render(root, [siteId]) {
    root.innerHTML = pageHead(
      'Site Management Hub',
      'Electrical sites, their PLN subscription and regulatory identity. The subscribed kVA × power factor is the hard ceiling load management enforces.',
      state.can('site:write') ? `<button class="btn primary" data-new>${icon('plus')} Create site</button>` : '',
    ) + '<div class="grid k4" data-kpis></div><div class="card section" data-list></div>';

    const draw = async () => {
      const list = await loadSites(true);
      const active = list.filter((s) => !s.archived_at);
      $('[data-kpis]', root).innerHTML = [
        kpi('Sites', fmt.num(active.length), `${list.length - active.length} archived`),
        kpi('Subscribed capacity', `${fmt.num(active.reduce((a, s) => a + Number(s.connected_kva ?? 0), 0))} kVA`, 'across all sites'),
        kpi('Charge points', fmt.num(active.reduce((a, s) => a + s.charger_count, 0)), `${fmt.num(active.reduce((a, s) => a + s.online_count, 0))} online now`),
        kpi('Above 200 kVA', fmt.num(active.filter((s) => s.computed?.crossesTrTmCliff).length), 'medium-voltage (TM) connections', active.some((s) => s.computed?.crossesTrTmCliff) ? 'warn' : ''),
      ].join('');
      table($('[data-list]', root), {
        columns: [
          { label: 'Site', render: (s) => `<div class="cell-title">${esc(s.name)}</div><div class="cell-sub">${esc(s.address ?? '')}${s.archived_at ? ' · archived' : ''}</div>` },
          { label: 'Organization', render: (s) => esc(s.org_name) },
          { label: 'SPKLU ID', render: (s) => (s.spklu_id ? `<span class="mono">${esc(s.spklu_id)}</span>${s.spklu_valid === false ? ' ' + tag('t-crit', 'malformed') : ''}` : tag('t-warn', 'missing')) },
          { label: 'Subscribed', num: true, render: (s) => (s.connected_kva != null ? `${fmt.num(s.connected_kva)} kVA` : '—') },
          { label: 'PF', num: true, render: (s) => esc(Number(s.power_factor).toFixed(2)) },
          { label: 'Managed ceiling', num: true, render: (s) => `${fmt.kw(s.managed_ceiling_w)}${s.curtailed ? '<div>' + tag('t-crit', 'curtailed') + '</div>' : ''}` },
          { label: 'Chargers', num: true, render: (s) => esc(s.charger_count) },
          { label: 'Connectors', num: true, render: (s) => esc(s.connector_count) },
          { label: 'Live status', render: (s) => `${liveTag(s.live_status)}<div class="cell-sub">${esc(s.online_count)}/${esc(s.charger_count)} online${s.faulted_count ? ` · ${esc(s.faulted_count)} faulted` : ''}</div>` },
        ],
        rows: list,
        empty: 'No sites yet. Create the first electrical site to start onboarding chargers.',
        onRow: (s) => navigate(`#/sites/${encodeURIComponent(s.id)}`),
      });
    };
    await draw();
    $('[data-new]', root)?.addEventListener('click', async () => { if (await openSiteModal()) draw(); });
    if (siteId) openSiteDrawer(siteId);
  },
});
