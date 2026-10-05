import {
  $, $$, esc, api, attempt, state, registerView, pageHead, table, tag, icon, fmt, modal, drawer, confirmDialog, html,
  field, options, formValues, fieldErrors, toast, callout, kpi, navigate, sites as loadSites, debounce, COUNTRIES, countryCurrency, isRupiah,
  zonedYmd, onlyIndonesia,
} from '../core.js';

/**
 * Module 5 — Tariff, Billing & Pricing Engine.
 *
 * Every regulatory number shown here comes from /v1/meta (state.meta.regulatory)
 * or /v1/me (state.me.features); the server re-validates on save and on assign,
 * so the checks in this file are a courtesy that explains a rejection BEFORE the
 * operator presses Save, never the enforcement itself.
 */

// ------------------------------------------------------------------ constants & helpers

const MODEL_LABEL = { flat: 'Flat energy rate', tou: 'Time-of-use (WBP / LWBP)', tiered: 'Tiered by kWh' };
const SCHEME_LABEL = { layanan_khusus: 'Layanan khusus (N × base)', curah: 'Curah / bulk (Q × base)', none: 'No PLN scheme declared' };
const KIND_LABEL = { energy: 'Energy', time: 'Charging time', session: 'Service fee (biaya layanan)', idle: 'Idle / overstay fee', admin: 'Admin fee' };
const BLOCK_LABEL = { WBP: 'Peak (WBP)', LWBP: 'Off-peak (LWBP)', ANY: 'Any time' };
const CLASS_LABEL = { slow: 'slow (≤7 kW)', medium: 'medium (>7–22 kW)', fast: 'fast (>22–50 kW)', ultrafast: 'ultrafast (>50 kW)' };
const DESIGN_FOR = [
  { value: 7000, label: '7 kW AC — slow' },
  { value: 22000, label: '22 kW AC — medium' },
  { value: 50000, label: '50 kW DC — fast' },
  { value: 60000, label: '60+ kW DC — ultrafast' },
];
const GRACE = [0, 5, 10, 15, 20, 30];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SEV_CLS = { violation: 't-crit', warning: 't-warn', info: 't-info' };
// Not exposed by /v1/meta; mirrors config.regulatory.curahQMin/QMax. /v1/tariffs/validate is authoritative.
const CURAH_Q_MIN = 0.8;
const CURAH_Q_MAX = 3;

function reg() {
  const r = state.meta?.regulatory ?? {};
  const base = Number(r.layananKhususBase ?? 1645);
  const nMax = Number(r.layananKhususNMax ?? 1.5);
  return {
    base,
    nMax,
    energyCeiling: Number(r.energyCeilingIdrPerKwh ?? base * nMax),
    serviceCap: r.serviceFeeCeilingIdr ?? { slow: null, medium: null, fast: 25000, ultrafast: 57000 },
    idleCap: r.idleFeeCapIdr != null ? Number(r.idleFeeCapIdr) : null,
    pbjtMaxBps: Number(r.pbjtMaxBps ?? 1000),
  };
}

const wbpWindow = () => state.me?.features?.wbp ?? { start: '17:00', end: '22:00' };
const ppnPct = () => state.me?.features?.effectivePpnPct ?? 11;

/** Same thresholds as domain/spklu.ts chargingClassForPowerW. */
function classForW(w) {
  const kw = Number(w) / 1000;
  return kw <= 7 ? 'slow' : kw <= 22 ? 'medium' : kw <= 50 ? 'fast' : 'ultrafast';
}

/** The regulated per-kWh ceiling, mirroring services/tariff.ts regulatedEnergyCeiling. */
function ceilingFor(scheme, base) {
  const R = reg();
  const b = Number(base) > 0 ? Number(base) : null;
  if (scheme === 'curah') return b == null ? null : b * CURAH_Q_MAX;
  return (b ?? R.base) * R.nMax;
}

function ceilingExplain(scheme) {
  const R = reg();
  if (scheme === 'curah') return `curah: base × Q max ${CURAH_Q_MAX}`;
  if (scheme === 'none') return `no scheme declared, so the layanan khusus ceiling applies: base × N max ${R.nMax}`;
  return `layanan khusus: base × N max ${R.nMax}`;
}

const num = (v) => {
  if (v == null || String(v).trim() === '') return null;
  const x = Number(String(v).trim());
  return Number.isFinite(x) ? x : null;
};

/**
 * A rate (major units) in the tariff's currency: rupiah with decimals only when the value has them
 * (ceilings like Rp 2.467,5) as before; ringgit / Singapore dollars with their sen / cents (RM 0.455).
 */
const idrD = (n, cur) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  if (!isRupiah(cur)) return fmt.rate(Number(n), cur);
  const x = Number(n);
  return fmt.rate(x).replace(/,(\d)$/, ',$10');
};
/** A per-session amount of a tariff (major units): rupiah whole as before, other currencies with decimals. */
const feeD = (n, cur) => (isRupiah(cur) ? fmt.idr(n) : fmt.rate(Number(n ?? 0), cur));
const qty = (n) => Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 3 });

const comps = (t) => (Array.isArray(t?.components) ? t.components : []).map((c) => ({
  ...c,
  rate: Number(c.rate),
  fromKwh: c.fromKwh != null ? Number(c.fromKwh) : null,
  toKwh: c.toKwh != null ? Number(c.toKwh) : null,
  fromMinutes: c.fromMinutes != null ? Number(c.fromMinutes) : 0,
  toMinutes: c.toMinutes != null ? Number(c.toMinutes) : null,
}));

function parseFlags(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } }
  return [];
}

function flagsHtml(flags, empty = '') {
  if (!flags?.length) return empty;
  return `<div class="stack" style="gap:6px">${flags.map((f) => `<div class="row" style="align-items:flex-start;flex-wrap:nowrap">
      ${tag(SEV_CLS[f.severity] ?? 't-info', f.severity ?? 'info')}
      <div class="small"><span class="mono">${esc(f.code ?? '')}</span> — ${esc(f.message ?? '')}</div></div>`).join('')}</div>`;
}

const serviceTotal = (t) => comps(t).filter((c) => c.kind === 'session' || c.kind === 'admin').reduce((a, c) => a + c.rate, 0);
const idleComp = (t) => comps(t).find((c) => c.kind === 'idle');

function dayText(mask) {
  if (mask == null || Number(mask) === 127) return '';
  return DAYS.filter((_, i) => (Number(mask) >> i) & 1).join(', ');
}

// ------------------------------------------------------------------ list-row renderers

function energySummary(t) {
  const e = comps(t).filter((c) => c.kind === 'energy');
  const cur = t.currency;
  // In the tariff's currency. (Was `const idrD0 = idrD; const idrD = …`: the inner const shadowed the
  // module's idrD for the whole function, so idrD0 read it before initialisation and every tariff list threw.)
  const rateD = (n) => idrD(n, cur);
  const ceiling = (t.country_code ?? 'ID') === 'ID' ? ceilingFor(t.pln_scheme, t.pln_base_rate) : null;
  const over = ceiling != null && e.some((c) => c.rate > ceiling + 0.001);
  const flag = over ? `<div>${tag('t-crit', 'above ceiling', `Legal ceiling ${rateD(ceiling)}/kWh`)}</div>` : '';
  if (!e.length) return `<span class="muted">${(t.country_code ?? 'ID') === 'ID' ? 'PLN formula rate' : 'no energy price'}</span>${flag}`;
  if (e.some((c) => c.touBlock !== 'ANY')) {
    return e.map((c) => `<div><span class="cell-sub">${esc(c.touBlock)}</span> ${esc(rateD(c.rate))}</div>`).join('') + flag;
  }
  if (e.length > 1) {
    const rates = e.map((c) => c.rate);
    return `${esc(rateD(Math.min(...rates)))}–${esc(rateD(Math.max(...rates)))}<div class="cell-sub">${esc(e.length)} kWh tiers</div>${flag}`;
  }
  return `${esc(rateD(e[0].rate))}<div class="cell-sub">per kWh</div>${flag}`;
}

function serviceSummary(t) {
  const c = comps(t);
  const s = c.filter((x) => x.kind === 'session').reduce((a, x) => a + x.rate, 0);
  const a = c.filter((x) => x.kind === 'admin').reduce((acc, x) => acc + x.rate, 0);
  if (!s && !a) return '<span class="muted">none</span>';
  const cur = t.currency;
  return `${esc(feeD(s + a, cur))}<div class="cell-sub">service ${esc(feeD(s, cur))} + admin ${esc(feeD(a, cur))}</div>`;
}

function idleSummary(t) {
  const c = idleComp(t);
  if (!c) return '<span class="muted">none</span>';
  if (c.toMinutes == null) return `${esc(idrD(c.rate, t.currency))}/min ${tag('t-crit', 'unbounded')}`;
  const worst = Math.max(0, c.toMinutes - c.fromMinutes) * c.rate;
  return `${esc(idrD(c.rate, t.currency))}/min<div class="cell-sub">after ${esc(c.fromMinutes)} min grace · max ${esc(feeD(worst, t.currency))}</div>`;
}

function assignmentSummary(t) {
  const list = Array.isArray(t.assignments) ? t.assignments : [];
  if (!list.length) return t.status === 'archived' ? '<span class="muted">—</span>' : tag('t-warn', 'unassigned', 'Prices nothing until it is assigned');
  const shown = list.slice(0, 3).map((a) => `<div>${esc(a.scopeName ?? a.scopeType)} ${
    a.currentType ? tag('t-info', a.currentType, `${a.currentType} connectors only`, true) : tag('t-mute', 'AC+DC', 'Any current type', true)}</div>`).join('');
  return shown + (list.length > 3 ? `<div class="cell-sub">+${esc(list.length - 3)} more</div>` : '');
}

// ------------------------------------------------------------------ assign modal

/** Tariff Assignment Rule. Resolves true when an assignment was saved. */
export function openAssignModal(tariff) {
  return new Promise((resolve) => {
    let ok = false;
    let scope = 'site';
    let cps = null;
    const SCOPES = [['org', 'All sites'], ['site', 'Specific site'], ['connector', 'Single connector']];
    const ctx = modal({
      title: `Assign tariff — ${tariff.name}`,
      subtitle: 'Most specific wins at billing time: connector › site › all sites. Within a scope, an AC/DC-specific rule beats "Any", then higher priority wins.',
      size: 'lg',
      body: `<form novalidate>
        <div class="field"><span class="lbl">Scope</span><div class="seg" data-scope role="group" aria-label="Scope">${SCOPES.map(([v, l]) =>
          `<button type="button" data-v="${esc(v)}" aria-pressed="${v === scope}">${esc(l)}</button>`).join('')}</div></div>
        <div class="form" style="margin-top:12px">
          <div class="full" data-for="org">${callout('info', 'Applies to every connector in your organization that has no more specific site or connector assignment.')}</div>
          <div class="full" data-for="site">${field('Site', '<select name="siteId"><option value="">Loading sites…</option></select>')}</div>
          <div data-for="connector">${field('Charger', '<select name="cp"><option value="">Loading chargers…</option></select>')}</div>
          <div data-for="connector">${field('Connector', '<select name="connectorUuid"><option value="">Choose a charger first</option></select>')}</div>
          ${field('Applies to', `<select name="currentType">${options([{ value: '', label: 'Any current type' }, { value: 'AC', label: 'AC connectors only' }, { value: 'DC', label: 'DC connectors only' }], '')}</select>`,
            { help: 'Lets one site carry an AC tariff and a DC tariff side by side.' })}
          ${field('Priority', '<input name="priority" type="number" step="1" inputmode="numeric">', { help: 'Tie-breaker within the same scope; higher wins.' })}
          <div class="full" data-mismatch></div>
        </div>
        <div style="margin-top:12px">${callout('info', 'The platform re-validates the tariff against the least and most powerful connectors in the chosen scope. The service-fee ceiling depends on connector nameplate power, so a plan legal for ultrafast DC can be illegal on a 50 kW fast charger.')}</div>
        <div data-flags style="margin-top:12px"></div>
      </form>`,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Assign tariff',
          kind: 'primary',
          async onClick() {
            const form = $('form', ctx.body);
            const v = formValues(form);
            const errs = {};
            let scopeId = null;
            if (scope === 'site') { if (!v.siteId) errs.siteId = 'Choose a site.'; scopeId = v.siteId || null; }
            if (scope === 'connector') {
              if (!v.cp) errs.cp = 'Choose a charger.';
              else if (!v.connectorUuid) errs.connectorUuid = 'Choose a connector.';
              scopeId = v.connectorUuid || null;
            }
            const pr = num(v.priority);
            if (pr == null || !Number.isInteger(pr)) errs.priority = 'Whole number, e.g. 0 or 10.';
            fieldErrors(form, errs);
            if (Object.keys(errs).length) return false;
            const flagsEl = $('[data-flags]', form);
            flagsEl.innerHTML = '';
            try {
              const r = await api(`/v1/tariffs/${encodeURIComponent(tariff.id)}/assign`, {
                method: 'POST',
                body: { scopeType: scope, scopeId, priority: pr, currentType: v.currentType || null },
              });
              ok = true;
              toast('Tariff assigned', 'ok');
              (r?.flags ?? []).filter((f) => f.severity === 'warning').forEach((f) => toast(f.message, 'warn'));
            } catch (e) {
              flagsEl.innerHTML = callout('crit', `<b>${esc(e.message)}</b>${e.status === 409 ? ' Correct the tariff (or assign a different one) — sessions on these connectors could not be billed legally under it.' : ''}`)
                + (e.data?.flags?.length ? `<div style="margin-top:8px">${flagsHtml(e.data.flags)}</div>` : '');
              return false;
            }
          },
        },
      ],
      onClose: () => resolve(ok),
    });

    const form = $('form', ctx.body);
    const siteSel = $('[name=siteId]', form);
    const cpSel = $('[name=cp]', form);
    const connSel = $('[name=connectorUuid]', form);
    $('[name=priority]', form).value = '0';

    const checkMismatch = () => {
      const box = $('[data-mismatch]', form);
      const cp = cps?.find((c) => c.id === cpSel.value);
      const k = cp?.connectors?.find((x) => x.connectorUuid === connSel.value);
      const want = $('[name=currentType]', form).value;
      box.innerHTML = scope === 'connector' && k && want && k.currentType && k.currentType !== want
        ? callout('warn', `This connector is <b>${esc(k.currentType)}</b> but the rule applies to <b>${esc(want)}</b> only, so it would never match. Choose "Any current type".`)
        : '';
    };

    async function ensureCps() {
      if (cps) return;
      try {
        cps = await api('/v1/charge-points');
      } catch (e) {
        cps = [];
        toast(e.message, 'crit');
      }
      const list = cps.filter((c) => c.status !== 'decommissioned');
      cpSel.innerHTML = options(list.map((c) => ({ value: c.id, label: `${c.display_name || c.ocpp_identity} · ${c.site_name ?? ''}` })), '',
        { blank: list.length ? 'Choose a charger…' : 'No chargers available' });
    }

    const setScope = (s) => {
      scope = s;
      $$('[data-scope] button', form).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === s)));
      $$('[data-for]', form).forEach((x) => x.classList.toggle('hidden', x.dataset.for !== s));
      fieldErrors(form, {});
      if (s === 'connector') ensureCps();
      checkMismatch();
    };
    $$('[data-scope] button', form).forEach((b) => b.addEventListener('click', () => setScope(b.dataset.v)));
    cpSel.addEventListener('change', () => {
      const cp = cps?.find((c) => c.id === cpSel.value);
      const ks = cp?.connectors ?? [];
      connSel.innerHTML = options(ks.map((k) => ({
        value: k.connectorUuid,
        label: `EVSE ${k.evseNo} / #${k.connectorId} · ${k.connectorType ?? '?'} · ${k.currentType ?? '?'} · ${fmt.kw(k.maxPowerW)}`,
      })), '', { blank: cp ? (ks.length ? 'Choose a connector…' : 'This charger has no connectors') : 'Choose a charger first' });
      checkMismatch();
    });
    connSel.addEventListener('change', checkMismatch);
    $('[name=currentType]', form).addEventListener('change', checkMismatch);

    loadSites().then((list) => {
      const active = (list ?? []).filter((s) => !s.archived_at);
      siteSel.innerHTML = options(active.map((s) => ({ value: s.id, label: s.name })), '', { blank: active.length ? 'Choose a site…' : 'No sites yet' });
    });
    setScope(scope);
  });
}

// ------------------------------------------------------------------ create wizard

/** "Create Tariff Plan". Resolves {id, name} when saved, else null. */
export function openTariffWizard() {
  return new Promise((resolve) => {
    const R = reg();
    const wbp = wbpWindow();
    // The tariff's country (§D4): Indonesia's PLN / Kepmen rules, or Malaysia / Singapore (no price regulation; consumer prices tax-inclusive).
    const countries = Object.values(COUNTRIES).filter((c) => c.code === 'ID' || state.me?.features?.multiCountry || (state.me?.org?.countries ?? []).some((x) => x.country_code === c.code));
    let cc = countries.some((c) => c.code === state.me?.org?.homeCountry) ? state.me.org.homeCountry : 'ID';
    const cur = () => countryCurrency(cc);
    const st = {
      model: 'flat',
      flat: String(R.base * 1.5),
      wbp: '2450',
      lwbp: '2200',
      tiers: [{ toKwh: '20', rate: '2450' }, { toKwh: '', rate: '2300' }],
    };
    let saved = null;
    let seq = 0;

    const ctx = modal({
      title: 'Create tariff plan',
      subtitle: 'Regulatory ceilings are checked live and again by the server on save. An illegal plan cannot be stored.',
      size: 'xl',
      dismissable: false,
      body: `<div class="grid split">
        <form novalidate data-form>
          <fieldset><legend>1 · Plan profile</legend><div class="form">
            ${field('Plan name', '<input name="name" maxlength="200" placeholder="Public DC Ultra-Fast Commercial 2026">', { full: true })}
            ${field('Description', '<textarea name="description" rows="2" maxlength="1000" placeholder="Who this plan is for and when it applies"></textarea>', { full: true, opt: true })}
            ${countries.length > 1 ? field('Country', `<select name="countryCode">${options(countries.map((c) => ({ value: c.code, label: `${c.name} — prices in ${c.currency}` })), cc)}</select>`,
              { help: 'A tariff prices sites of one country, in its currency. Indonesia: PLN and Kepmen ceilings apply. Malaysia and Singapore: no price regulation.' }) : ''}
            ${field('PLN scheme', `<select name="plnScheme">${options(Object.entries(SCHEME_LABEL).map(([value, label]) => ({ value, label })), 'layanan_khusus')}</select>`,
              { attrs: 'data-only="ID"', help: 'How the site buys electricity from PLN. It sets the legal ceiling on your kWh price.' })}
            ${field('PLN base rate', '<div class="inputgroup"><input name="plnBaseRate" inputmode="decimal"><span class="suffix">IDR/kWh</span></div>',
              { attrs: 'data-only="ID"', help: `Published quarterly by PLN (Q3-2026: ${esc(fmt.rate(1645))}).` })}
            ${field('Multiplier (N or Q)', '<input name="plnMultiplier" inputmode="decimal">',
              { attrs: 'data-only="ID"', help: `Layanan khusus N: 1.0–${esc(R.nMax)}. Curah Q: ${CURAH_Q_MIN}–${CURAH_Q_MAX}.` })}
            <div class="full" data-formula></div>
          </div></fieldset>

          <fieldset style="margin-top:14px"><legend>2 · Energy pricing model</legend>
            <div class="seg" data-model role="group" aria-label="Pricing model">${Object.entries(MODEL_LABEL).map(([v, l]) =>
              `<button type="button" data-v="${esc(v)}" aria-pressed="${v === st.model}">${esc(l)}</button>`).join('')}</div>
            <div data-energy style="margin-top:12px"></div>
          </fieldset>

          <fieldset style="margin-top:14px"><legend>3 · Service &amp; convenience surcharges</legend><div class="form">
            ${field('Designed for', `<select name="designedFor">${options(DESIGN_FOR, 60000)}</select>`,
              { help: 'Connector nameplate power this plan targets. Checked again against real connectors on assignment.' })}
            ${field('Service fee (biaya layanan)', '<div class="inputgroup"><input name="serviceFee" inputmode="decimal" placeholder="0"><span class="suffix"><span data-cur-code>IDR</span>/session</span></div>')}
            ${field('Admin fee', '<div class="inputgroup"><input name="adminFee" inputmode="decimal" placeholder="0"><span class="suffix"><span data-cur-code>IDR</span>/session</span></div>',
              { help: 'Counts toward the same cap: an admin fee on every session is a service fee under another name.' })}
            <div class="full" data-cap></div>
          </div></fieldset>

          <fieldset style="margin-top:14px"><legend>4 · Idle parking penalty</legend>
            <label class="check"><input type="checkbox" name="idleOn"><span>Charge an idle fee when a vehicle stays plugged in after charging finishes</span></label>
            <div class="form" data-idle-fields style="margin-top:10px">
              ${field('Grace period', `<select name="idleGrace">${options(GRACE.map((m) => ({ value: m, label: m ? `${m} minutes` : 'No grace period' })), 15)}</select>`)}
              ${field('Penalty rate', '<div class="inputgroup"><input name="idleRate" inputmode="decimal"><span class="suffix"><span data-cur-code>IDR</span>/min</span></div>')}
              ${field('Maximum billable idle minutes', '<div class="inputgroup"><input name="idleMax" inputmode="numeric"><span class="suffix">min</span></div>',
                { help: 'Required. Unbounded idle fees are rejected by the server.' })}
              <div class="full" data-idle-calc></div>
            </div>
          </fieldset>

          <fieldset style="margin-top:14px"><legend>5 · Tax &amp; statutory</legend>
            <div data-not-id hidden>
              <div class="row"><label class="switch green"><input type="checkbox" name="pricesIncludeTax" aria-label="Prices include tax"><span></span></label>
                <div><b data-incl-label>Prices include GST</b><div class="small muted" data-incl-note></div></div></div>
            </div>
            <div data-only="ID">
            <div class="row"><label class="switch green"><input type="checkbox" name="ppnApplies" aria-label="Charge PPN"><span></span></label>
              <div><b>Charge PPN (VAT)</b><div class="small muted" data-ppn-rate></div></div></div>
            <div data-ppn-note style="margin-top:8px"></div>
            <div style="margin-top:10px">${callout('info', '<b>PBJT-TL</b> (local tax on electricity, 0–10%) is not part of the tariff. Each kabupaten/kota sets its own rate, so it is configured per site under Sites and added on top of the energy lines at billing time.')}</div>
            <div class="field" style="margin-top:12px"><span class="lbl">Payment gateway MDR (QRIS / e-wallet fee)</span>
              <label class="check"><input type="radio" name="mdrMode" value="absorb"><span>Absorbed by CPO</span></label>
              <label class="check" style="opacity:.6;cursor:not-allowed"><input type="radio" name="mdrMode" value="surcharge" disabled><span>Surcharged to customer — <span class="muted">not allowed: Bank Indonesia QRIS rules prohibit passing the MDR to the payer as a surcharge. Build the cost into the kWh price instead.</span></span></label>
            </div>
            </div>
          </fieldset>
          <div data-save-flags style="margin-top:12px"></div>
        </form>

        <aside class="card" style="position:sticky;top:0">
          <header><h3>Live invoice preview</h3><span class="small muted right" data-busy></span></header>
          <div class="body">
            <div class="form" style="grid-template-columns:1fr 1fr">
              ${field('Energy delivered', '<div class="inputgroup"><input data-pv="kwh" inputmode="decimal"><span class="suffix">kWh</span></div>')}
              ${field('Sample time', `<select data-pv="window">${options([{ value: 'off', label: 'Off-peak (10:00 WIB)' }, { value: 'peak', label: `Peak (WBP ${wbp.start}–${wbp.end})` }], 'off')}</select>`, { attrs: 'data-only="ID"' })}
              ${field('Site PBJT-TL', '<div class="inputgroup"><input data-pv="pbjt" inputmode="numeric"><span class="suffix">bps</span></div>', { attrs: 'data-only="ID"', help: '<span data-pv-pbjt></span>' })}
              ${field('Idle after charging', '<div class="inputgroup"><input data-pv="idle" inputmode="numeric"><span class="suffix">min</span></div>')}
            </div>
            <div data-preview style="margin-top:12px"><div class="skeleton" style="width:60%"></div></div>
            <div data-flags style="margin-top:12px"></div>
          </div>
        </aside>
      </div>`,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save tariff plan',
          kind: 'primary',
          async onClick() {
            readState();
            const errs = liveCheck(true);
            if (errs.length) {
              toast(`${errs.length} field${errs.length > 1 ? 's need' : ' needs'} attention before this plan can be saved.`, 'crit');
              $('.invalid', form)?.focus();
              return false;
            }
            const v = formValues(form);
            const body = {
              name: v.name.trim(),
              description: v.description.trim() || undefined,
              ...(cc === 'ID' ? {
                plnScheme: v.plnScheme,
                plnBaseRate: num(v.plnBaseRate),
                plnMultiplier: v.plnScheme === 'none' ? undefined : num(v.plnMultiplier),
                ppnApplies: v.ppnApplies === true,
              } : { countryCode: cc, currency: cur(), plnScheme: 'none', pricesIncludeTax: v.pricesIncludeTax === true }),
              pricingModel: st.model,
              mdrMode: 'absorb',
              components: buildComponents(v),
              appliesToMaxPowerW: Number(v.designedFor),
            };
            const box = $('[data-save-flags]', form);
            box.innerHTML = '';
            try {
              const r = await api('/v1/tariffs', { method: 'POST', body });
              saved = { id: r.tariffId, name: body.name };
              toast('Tariff plan saved', 'ok');
              (r.flags ?? []).filter((f) => f.severity === 'warning').forEach((f) => toast(f.message, 'warn'));
            } catch (e) {
              if (e.data?.errors) { fieldErrors(form, e.data.errors); liveCheck(true); }
              box.innerHTML = callout('crit', `<b>${esc(e.message)}</b>`) + (e.data?.flags?.length ? `<div style="margin-top:8px">${flagsHtml(e.data.flags)}</div>` : '');
              box.scrollIntoView({ block: 'nearest' });
              return false;
            }
          },
        },
      ],
      onClose: () => { seq = -1; resolve(saved); },
    });

    const form = $('[data-form]', ctx.body);
    const aside = $('aside', ctx.body);
    const val = (name) => $(`[name="${name}"]`, form)?.value ?? '';
    const setv = (name, v) => { const i = $(`[name="${name}"]`, form); if (i && v != null) i.value = v; };

    // Initial values are assigned as DOM properties, never interpolated into markup.
    setv('plnBaseRate', R.base); setv('plnMultiplier', 1.5);
    setv('serviceFee', 25000); setv('adminFee', 0);
    setv('idleRate', 1000); setv('idleMax', 60);
    $('[name=idleOn]', form).checked = true;
    $('[name=ppnApplies]', form).checked = true;
    $('[name=mdrMode][value=absorb]', form).checked = true;
    $('[data-pv=kwh]', aside).value = '20';
    $('[data-pv=pbjt]', aside).value = '500';
    $('[data-pv=idle]', aside).value = '20';

    // ---- energy section --------------------------------------------------

    function readState() {
      if (st.model === 'flat') st.flat = val('rateFlat');
      if (st.model === 'tou') { st.wbp = val('rateWbp'); st.lwbp = val('rateLwbp'); }
      if (st.model === 'tiered') st.tiers.forEach((t, i) => { t.toKwh = val(`tierTo${i}`); t.rate = val(`tierRate${i}`); });
    }

    const tierFrom = (i) => (i === 0 ? 0 : num(st.tiers[i - 1].toKwh));

    function renderEnergy() {
      const box = $('[data-energy]', form);
      const ceil = ceilingFor(val('plnScheme'), num(val('plnBaseRate')));
      if (st.model === 'flat') {
        box.innerHTML = `<div class="form">
          ${field('Energy price', '<div class="inputgroup"><input name="rateFlat" inputmode="decimal"><span class="suffix"><span data-cur-code>IDR</span>/kWh</span></div>',
            { help: 'One price for every kWh at any time of day.' })}
          ${cc === 'ID' ? '<div class="field" style="justify-content:flex-end"><button type="button" class="btn sm" data-use-formula>Use PLN formula rate</button></div>' : ''}</div>`;
        setv('rateFlat', st.flat);
      } else if (st.model === 'tou') {
        const eg = ceil != null ? `A ${esc(fmt.rate(2850))}/kWh peak price, for example, is ${(2850 / ceil).toFixed(2)}× the ${esc(idrD(ceil))} ceiling and would be rejected.` : '';
        box.innerHTML = `<div class="form">
          ${field(`Peak (WBP) ${wbp.start}–${wbp.end} WIB`, '<div class="inputgroup"><input name="rateWbp" inputmode="decimal"><span class="suffix">IDR/kWh</span></div>',
            { help: 'Waktu Beban Puncak, PLN’s evening peak block.' })}
          ${field(`Off-peak (LWBP) ${wbp.end}–${wbp.start} WIB`, '<div class="inputgroup"><input name="rateLwbp" inputmode="decimal"><span class="suffix">IDR/kWh</span></div>',
            { help: 'Luar Waktu Beban Puncak: every other hour.' })}
          </div>
          <div class="small muted" style="margin-top:8px">The WBP window is set platform-wide, not per tariff. The ceiling applies to the <b>peak</b> price too, not to an average. ${eg}</div>`;
        setv('rateWbp', st.wbp); setv('rateLwbp', st.lwbp);
      } else {
        box.innerHTML = `<div class="table-wrap"><table class="t"><thead><tr><th>Band from</th><th>Band to</th><th>Price</th><th style="width:40px"></th></tr></thead><tbody>
          ${st.tiers.map((_, i) => `<tr>
            <td class="num" style="vertical-align:middle"><span data-tier-from="${i}"></span> kWh</td>
            <td><div class="field"><div class="inputgroup"><input name="tierTo${i}" inputmode="decimal" placeholder="${i === st.tiers.length - 1 ? 'no limit' : ''}"><span class="suffix">kWh</span></div></div></td>
            <td><div class="field"><div class="inputgroup"><input name="tierRate${i}" inputmode="decimal"><span class="suffix"><span data-cur-code>IDR</span>/kWh</span></div></div></td>
            <td>${st.tiers.length > 1 ? `<button type="button" class="btn sm ghost" data-rm-tier="${i}" aria-label="Remove band">${icon('x')}</button>` : ''}</td></tr>`).join('')}
          </tbody></table></div>
          <div class="row" style="margin-top:8px"><button type="button" class="btn sm" data-add-tier>${icon('plus')} Add band</button>
            <span class="small muted">Each band bills only the kWh that fall inside it; the next band starts where the previous one ends. Leave the last "to" empty for no limit.</span></div>`;
        st.tiers.forEach((t, i) => { setv(`tierTo${i}`, t.toKwh); setv(`tierRate${i}`, t.rate); });
        updateTierFrom();
      }
      $$('[data-cur-code]', form).forEach((x) => { x.textContent = cur(); });
      // Whole rupiah per session / minute (the numeric keypad, as in v1.5); sen / cents need a decimal point.
      ['serviceFee', 'adminFee', 'idleRate'].forEach((n) => { const i = $(`[name=${n}]`, form); if (i) i.inputMode = isRupiah(cur()) ? 'numeric' : 'decimal'; });
    }

    function updateTierFrom() {
      $$('[data-tier-from]', form).forEach((s) => {
        const f = tierFrom(Number(s.dataset.tierFrom));
        s.textContent = f == null ? '?' : qty(f);
      });
    }

    function buildComponents(v) {
      const out = [];
      const push = (c) => out.push({ dayMask: 127, ...c, sortOrder: out.length });
      if (st.model === 'flat') push({ kind: 'energy', rate: num(st.flat) ?? 0, touBlock: 'ANY' });
      if (st.model === 'tou') {
        push({ kind: 'energy', rate: num(st.wbp) ?? 0, touBlock: 'WBP' });
        push({ kind: 'energy', rate: num(st.lwbp) ?? 0, touBlock: 'LWBP' });
      }
      if (st.model === 'tiered') {
        st.tiers.forEach((t, i) => push({
          kind: 'energy', rate: num(t.rate) ?? 0, touBlock: 'ANY', fromKwh: tierFrom(i) ?? 0, toKwh: num(t.toKwh) ?? undefined,
        }));
      }
      const sf = num(v.serviceFee) ?? 0;
      const af = num(v.adminFee) ?? 0;
      if (sf > 0) push({ kind: 'session', rate: sf, touBlock: 'ANY' });
      if (af > 0) push({ kind: 'admin', rate: af, touBlock: 'ANY' });
      if (v.idleOn) {
        const grace = Number(v.idleGrace) || 0;
        const max = num(v.idleMax);
        push({ kind: 'idle', rate: num(v.idleRate) ?? 0, touBlock: 'ANY', fromMinutes: grace, toMinutes: max != null ? grace + max : undefined });
      }
      return out;
    }

    function draft() {
      const v = formValues(form);
      return {
        id: 'draft',
        name: v.name.trim() || 'Draft tariff',
        currency: cur(),
        ...(cc === 'ID' ? {
          plnScheme: v.plnScheme,
          plnBaseRate: num(v.plnBaseRate) ?? undefined,
          plnMultiplier: v.plnScheme === 'none' ? undefined : (num(v.plnMultiplier) ?? undefined),
          ppnApplies: v.ppnApplies === true,
        } : { countryCode: cc, plnScheme: 'none', pricesIncludeTax: v.pricesIncludeTax === true }),
        components: buildComponents(v),
      };
    }

    // ---- live checks -----------------------------------------------------

    function problems(forSave) {
      const v = formValues(form);
      const out = [];
      const scheme = v.plnScheme;
      const base = num(v.plnBaseRate);
      const mult = num(v.plnMultiplier);
      const ceil = cc === 'ID' ? ceilingFor(scheme, base) : null;
      if (forSave && !v.name.trim()) out.push({ name: 'name', msg: 'Give the plan a name operators will recognise.' });
      if (cc === 'ID' && !(base > 0)) out.push({ name: 'plnBaseRate', msg: 'Enter the PLN base rate published for this quarter.' });
      if (cc === 'ID' && scheme !== 'none') {
        if (mult == null) out.push({ name: 'plnMultiplier', msg: 'Enter the multiplier.' });
        else if (scheme === 'layanan_khusus' && (mult < 1 || mult > R.nMax)) out.push({ name: 'plnMultiplier', msg: `N must be 1.0–${R.nMax}. Values outside the range need Director-General approval.` });
        else if (scheme === 'curah' && (mult < CURAH_Q_MIN || mult > CURAH_Q_MAX)) out.push({ name: 'plnMultiplier', msg: `Q must be ${CURAH_Q_MIN}–${CURAH_Q_MAX}.` });
      }
      const energy = (name, label, raw) => {
        const r = num(raw);
        // 0 is a real price: a free tier ("first 5 kWh free"). Only a missing or negative price is refused.
        if (r == null || r < 0) out.push({ name, msg: `Enter the ${label} price (0 for free).` });
        else if (ceil != null && r > ceil + 0.001) {
          out.push({ name, msg: `Rejected: ${idrD(r)}/kWh is ${(r / ceil).toFixed(2)}× the legal ceiling of ${idrD(ceil)}/kWh (${ceilingExplain(scheme)}). A price above the ceiling cannot be saved or billed.` });
        }
      };
      if (st.model === 'flat') energy('rateFlat', 'energy', st.flat);
      if (st.model === 'tou') { energy('rateWbp', 'peak', st.wbp); energy('rateLwbp', 'off-peak', st.lwbp); }
      if (st.model === 'tiered') {
        st.tiers.forEach((t, i) => {
          const from = tierFrom(i);
          const to = num(t.toKwh);
          const last = i === st.tiers.length - 1;
          if (!last && to == null) out.push({ name: `tierTo${i}`, msg: 'Every band except the last needs an upper bound.' });
          else if (to != null && from != null && to <= from) out.push({ name: `tierTo${i}`, msg: `Must be above ${qty(from)} kWh.` });
          energy(`tierRate${i}`, 'band', t.rate);
        });
      }
      const sf = num(v.serviceFee) ?? 0;
      const af = num(v.adminFee) ?? 0;
      if (sf < 0) out.push({ name: 'serviceFee', msg: 'Cannot be negative.' });
      if (af < 0) out.push({ name: 'adminFee', msg: 'Cannot be negative.' });
      const cls = classForW(v.designedFor);
      const cap = cc === 'ID' ? R.serviceCap[cls] : null;
      if (cap != null && sf + af > cap) {
        out.push({ name: 'serviceFee', msg: `Service + admin = ${fmt.idr(sf + af)}, above the ${fmt.idr(cap)} per-session ceiling for ${CLASS_LABEL[cls]} charging (Kepmen ESDM 182.K/2023).` });
      }
      if (v.idleOn) {
        const rate = num(v.idleRate);
        const max = num(v.idleMax);
        if (rate == null || rate < 0) out.push({ name: 'idleRate', msg: 'Enter a penalty rate (0 or more).' });
        if (max == null || max <= 0 || !Number.isInteger(max)) out.push({ name: 'idleMax', msg: 'Required: a whole number of minutes. The server rejects idle fees with no upper bound.' });
        else if (cc === 'ID' && rate != null && R.idleCap != null && rate * max > R.idleCap) {
          out.push({ name: 'idleMax', msg: `Worst case ${fmt.idr(rate * max)} is above the ${fmt.idr(R.idleCap)} per-session platform cap. Lower the rate or the minutes.` });
        }
      }
      return out;
    }

    function liveCheck(forSave = false) {
      $$('[data-live-err]', form).forEach((e) => e.remove());
      $$('[data-live-invalid]', form).forEach((i) => { i.classList.remove('invalid'); i.removeAttribute('data-live-invalid'); });
      const list = problems(forSave);
      for (const p of list) {
        const input = $(`[name="${p.name}"]`, form);
        if (!input) continue;
        input.classList.add('invalid');
        input.setAttribute('data-live-invalid', '');
        const e = document.createElement('div');
        e.className = 'err';
        e.setAttribute('data-live-err', '');
        e.textContent = p.msg;
        (input.closest('.field') ?? input.parentElement).append(e);
      }
      return list;
    }

    // ---- computed panels -------------------------------------------------

    function renderComputed() {
      const v = formValues(form);
      // Malaysia / Singapore: no PLN formula, no Kepmen caps, no PPN; prices may include GST / service tax.
      $$('[data-only]', ctx.body).forEach((x) => { x.hidden = x.dataset.only !== cc; });
      $('[data-not-id]', form).hidden = cc === 'ID';
      if (cc !== 'ID') {
        $('[data-formula]', form).innerHTML = callout('info', `<b>No regulated price ceilings in ${esc(COUNTRIES[cc].name)}.</b> Prices are set commercially; the platform still bounds idle fees. Prices are in ${esc(cur())}.`);
        $('[data-cap]', form).innerHTML = '';
        $('[data-incl-label]', form).textContent = cc === 'SG' ? 'Prices include GST' : 'Prices include service tax';
        $('[data-incl-note]', form).textContent = cc === 'SG'
          ? 'Singapore: a GST-registered operator must show GST-inclusive prices (IRAS). The GST is worked out of each session total.'
          : 'Malaysia: shown as the price drivers pay. No service tax is charged unless your organisation is registered for it (Settings → Organisation).';
        const on = v.idleOn === true;
        $$('input, select', $('[data-idle-fields]', form)).forEach((i) => { i.disabled = !on; });
        const rate = num(v.idleRate);
        const max = num(v.idleMax);
        const worst = rate != null && max != null ? rate * max : null;
        $('[data-idle-calc]', form).innerHTML = !on ? '' : worst == null ? callout('warn', 'Set the maximum billable minutes so the worst-case charge is known before it is billed.')
          : callout('info', `<b>Worst case per session: ${esc(fmt.rate(worst, cur()))}</b> (${esc(max)} min × ${esc(fmt.rate(rate, cur()))}).`);
        return;
      }
      const scheme = v.plnScheme;
      const base = num(v.plnBaseRate);
      const mult = num(v.plnMultiplier);
      const ceil = ceilingFor(scheme, base);
      const formula = scheme !== 'none' && base > 0 && mult != null ? base * mult : null;
      $('[name=plnMultiplier]', form).disabled = scheme === 'none';
      $('[data-formula]', form).innerHTML = `<div class="grid k3" style="gap:10px">
        ${kpi('PLN formula rate', esc(idrD(formula)), formula != null ? esc(`${idrD(base)} × ${scheme === 'curah' ? 'Q' : 'N'} ${mult}`) : 'No scheme: no formula rate')}
        ${kpi('Legal energy ceiling', esc(idrD(ceil)), esc(ceil != null ? ceilingExplain(scheme) : 'Enter the curah base rate'), 'warn')}
      </div>${scheme === 'none' ? `<div style="margin-top:8px">${callout('info', 'Declaring no scheme does not remove the ceiling. The scheme describes the site’s PLN supply, not a choice made in the tariff, so the layanan khusus ceiling still applies.')}</div>` : ''}`;

      const cls = classForW(v.designedFor);
      const cap = R.serviceCap[cls];
      const sum = (num(v.serviceFee) ?? 0) + (num(v.adminFee) ?? 0);
      $('[data-cap]', form).innerHTML = (cap == null
        ? callout('info', `<b>No cap for ${esc(CLASS_LABEL[cls])} charging.</b> Kepmen ESDM 182.K/2023 caps the per-session service fee only for fast (${esc(fmt.idr(R.serviceCap.fast))}) and ultrafast (${esc(fmt.idr(R.serviceCap.ultrafast))}) charging. If you later assign this plan to faster connectors, the cap for those connectors applies.`)
        : callout(sum > cap ? 'crit' : 'ok', `<b>Cap for ${esc(CLASS_LABEL[cls])}: ${esc(fmt.idr(cap))} per session.</b> This plan charges ${esc(fmt.idr(sum))} (service + admin)${sum > cap ? `, which is ${esc(fmt.idr(sum - cap))} too much` : ''}.`))
        + `<div class="small muted" style="margin-top:6px">The specification text says “&gt;100 kW” for the ultrafast cap; the platform applies the Kepmen ESDM 182.K/2023 threshold of &gt;50 kW.</div>`;

      const on = v.idleOn === true;
      $$('input, select', $('[data-idle-fields]', form)).forEach((i) => { i.disabled = !on; });
      const grace = Number(v.idleGrace) || 0;
      const rate = num(v.idleRate);
      const max = num(v.idleMax);
      const worst = rate != null && max != null ? rate * max : null;
      $('[data-idle-calc]', form).innerHTML = !on ? '' : worst == null
        ? callout('warn', 'Set the maximum billable minutes so the worst-case charge is known before it is billed.')
        : callout(R.idleCap != null && worst > R.idleCap ? 'crit' : 'info',
          `Billing starts ${esc(grace)} min after charging ends and stops at minute ${esc(grace + max)}. <b>Worst case per session: ${esc(fmt.idr(worst))}</b> (${esc(max)} min × ${esc(idrD(rate))})${R.idleCap != null ? ` against the ${esc(fmt.idr(R.idleCap))} platform cap` : ''}.`);

      $('[data-ppn-rate]', form).textContent = v.ppnApplies
        ? `${ppnPct()}% effective on the pre-tax amount (PPN on DPP nilai lain).`
        : 'Not charged on sessions under this plan.';
      $('[data-ppn-note]', form).innerHTML = v.ppnApplies ? ''
        : state.me?.org?.pkp
          ? callout('warn', '<b>Your organization is PKP-registered.</b> A PKP CPO must charge PPN on EV charging and issue a faktur pajak. Turning it off means you still owe the tax but do not collect it.')
          : callout('info', 'PPN off is only allowed because your organization is not PKP-registered. Turn it back on once you register as PKP.');

      const bps = num($('[data-pv=pbjt]', aside).value);
      $('[data-pv-pbjt]', aside).textContent = bps != null ? `= ${(bps / 100).toFixed(2)}% (max ${(R.pbjtMaxBps / 100).toFixed(0)}%)` : '';
    }

    // ---- preview ---------------------------------------------------------

    function sampleWindow(which) {
      // The sample session runs on a date in the country's first zone (WIB for Indonesia, as before).
      const tz = (COUNTRIES[cc] ?? COUNTRIES.ID).timezones[0];
      const day = zonedYmd(new Date(), tz);
      if (cc !== 'ID') which = 'off';
      const [h, m] = (which === 'peak' ? wbp.start : '10:00').split(':').map(Number);
      const startMin = (h || 0) * 60 + (m || 0) + (which === 'peak' ? 15 : 0);
      const hh = String(Math.floor(startMin / 60) % 24).padStart(2, '0');
      const mm = String(startMin % 60).padStart(2, '0');
      const offset = cc === 'ID' ? '+07:00' : '+08:00';
      const start = new Date(`${day}T${hh}:${mm}:00${offset}`);
      return { startedAt: start.toISOString(), endedAt: new Date(start.getTime() + 45 * 60000).toISOString() };
    }

    async function refreshPreview() {
      if (seq < 0) return;
      const my = ++seq;
      const t = draft();
      const powerW = Number(val('designedFor')) || 60000;
      const kwh = num($('[data-pv=kwh]', aside).value) ?? 0;
      const pbjt = num($('[data-pv=pbjt]', aside).value) ?? 0;
      const idle = num($('[data-pv=idle]', aside).value) ?? 0;
      const win = sampleWindow($('[data-pv=window]', aside).value);
      $('[data-busy]', aside).textContent = 'updating…';
      const [p, vd] = await Promise.all([
        api('/v1/tariffs/preview', {
          method: 'POST',
          body: { tariff: { ...t, countryCode: cc }, energyWh: Math.round(kwh * 1000), connectorMaxPowerW: powerW, localTaxRateBps: pbjt, idleMinutes: idle, ...win },
        }).catch((e) => ({ error: e.message })),
        api('/v1/tariffs/validate', { method: 'POST', body: { tariff: t, connectorMaxPowerW: powerW } }).catch((e) => ({ error: e.message })),
      ]);
      if (my !== seq || seq < 0) return;
      $('[data-busy]', aside).textContent = '';

      const prev = $('[data-preview]', aside);
      if (p?.error) {
        prev.innerHTML = callout('crit', `Preview unavailable: ${esc(p.error)}`);
      } else if (cc !== 'ID') {
        // Amounts in minor units of the tariff's currency; the tax of the engine (GST / service tax / none).
        const tx = p.tax ?? {};
        const lines = p.lines ?? [];
        const c = cur();
        const taxed = tx.scheme && tx.scheme !== 'NONE';
        const perKwh = kwh > 0 ? tx.totalMinor / kwh / 100 : null;
        prev.innerHTML = `<div class="table-wrap"><table class="t"><thead><tr><th>Line</th><th class="num">Amount</th></tr></thead><tbody>
          ${lines.length ? lines.map((l) => `<tr><td>${esc(l.description)}<div class="cell-sub">${esc(qty(l.quantity))} ${esc(l.unit)} × ${esc(fmt.rate(l.unitRate, c))}</div></td>
            <td class="num">${esc(fmt.money(l.amountMinor, c))}</td></tr>`).join('') : '<tr><td class="empty" colspan="2">No billable lines.</td></tr>'}
          <tr><td><b>Subtotal</b><div class="cell-sub">before tax</div></td><td class="num"><b>${esc(fmt.money(tx.subtotalMinor, c))}</b></td></tr>
          <tr><td>${taxed ? `${esc(cc === 'SG' ? 'GST' : 'Service tax')} ${esc(((tx.taxRateBps ?? 0) / 100).toFixed(0))}%${tx.pricesIncludeTax ? ' (included in the prices)' : ''}` : 'No tax charged<div class="cell-sub">Not registered for tax in this country (Settings → Organisation)</div>'}</td><td class="num">${esc(fmt.money(tx.taxMinor, c))}</td></tr>
          </tbody><tfoot><tr><td>Total payable</td><td class="num">${esc(fmt.money(tx.totalMinor, c))}</td></tr></tfoot></table></div>
          <div class="row small muted" style="margin-top:6px">${tag('t-info', p.chargingClass ?? classForW(powerW))}<span>45-min session${perKwh != null ? ` · all-in ${esc(fmt.rate(Math.round(perKwh * 10000) / 10000, c))}/kWh` : ''}</span></div>`;
      } else {
        const tx = p.tax ?? {};
        const lines = p.lines ?? [];
        const perKwh = kwh > 0 ? tx.totalMinor / kwh : null;
        prev.innerHTML = `<div class="table-wrap"><table class="t"><thead><tr><th>Line</th><th class="num">Amount</th></tr></thead><tbody>
          ${lines.length ? lines.map((l) => `<tr><td>${esc(l.description)}<div class="cell-sub">${esc(qty(l.quantity))} ${esc(l.unit)} × ${esc(idrD(l.unitRate))}</div></td>
            <td class="num">${esc(fmt.idr(l.amountMinor))}</td></tr>`).join('') : '<tr><td class="empty" colspan="2">No billable lines.</td></tr>'}
          <tr><td><b>Subtotal</b></td><td class="num"><b>${esc(fmt.idr(tx.subtotalMinor))}</b></td></tr>
          <tr><td>PBJT-TL ${esc(((tx.localTaxRateBps ?? 0) / 100).toFixed(2))}%<div class="cell-sub">on ${esc(fmt.idr(tx.localTaxBaseMinor))} (electricity)</div></td><td class="num">${esc(fmt.idr(tx.localTaxMinor))}</td></tr>
          <tr><td>DPP nilai lain<div class="cell-sub">PPN base shown on the faktur pajak</div></td><td class="num">${esc(fmt.idr(tx.taxBaseMinor))}</td></tr>
          <tr><td>PPN ${esc(((tx.taxRateBps ?? 0) / 100).toFixed(0))}% of DPP${t.ppnApplies ? '' : ' <span class="muted">(off)</span>'}</td><td class="num">${esc(fmt.idr(tx.taxMinor))}</td></tr>
          </tbody><tfoot><tr><td>Total payable</td><td class="num">${esc(fmt.idr(tx.totalMinor))}</td></tr></tfoot></table></div>
          <div class="row small muted" style="margin-top:6px">${tag('t-info', p.chargingClass ?? classForW(powerW))}<span>45-min session${perKwh != null ? ` · all-in ${esc(idrD(Math.round(perKwh * 100) / 100))}/kWh` : ''}</span></div>`;
      }

      const fl = $('[data-flags]', aside);
      const cls = CLASS_LABEL[classForW(powerW)];
      fl.innerHTML = `<div class="small" style="font-weight:600;margin-bottom:6px">Save-time validation · ${esc(cls)} connector</div>
        ${vd?.error ? callout('warn', `Validation unavailable: ${esc(vd.error)}`) : flagsHtml(vd?.flags, callout('ok', 'No regulatory issues. This plan can be saved.'))}
        ${!p?.error && p.flags?.length ? `<div class="small" style="font-weight:600;margin:10px 0 6px">This sample session</div>${flagsHtml(p.flags)}` : ''}`;
    }
    const schedule = debounce(refreshPreview, 400);

    // ---- wiring ----------------------------------------------------------

    const onEdit = () => { readState(); updateTierFrom(); renderComputed(); liveCheck(); schedule(); };
    // Switching country: its currency, its rules, and sample prices of the right size.
    $('[name=countryCode]', form)?.addEventListener('change', (e) => {
      cc = e.target.value;
      const sample = { ID: ['2450', '25000', '1000', true], MY: ['1.20', '0', '0.50', true], SG: ['0.65', '0', '0.30', true] }[cc] ?? ['0', '0', '0', true];
      st.flat = sample[0]; st.wbp = sample[0]; st.lwbp = sample[0];
      st.tiers = [{ toKwh: '20', rate: sample[0] }, { toKwh: '', rate: sample[0] }];
      setv('serviceFee', sample[1]); setv('idleRate', sample[2]);
      $('[name=pricesIncludeTax]', form).checked = cc !== 'ID';
      if (cc !== 'ID' && st.model === 'tou') { st.model = 'flat'; $$('[data-model] button', form).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === 'flat'))); }
      $$('[data-model] button', form).forEach((x) => { x.hidden = cc !== 'ID' && x.dataset.v === 'tou'; });
      renderEnergy();
      onEdit();
    });
    form.addEventListener('input', onEdit);
    form.addEventListener('change', onEdit);
    aside.addEventListener('input', () => { renderComputed(); schedule(); });
    aside.addEventListener('change', schedule);

    if (cc !== 'ID') $('[name=countryCode]', form)?.dispatchEvent(new Event('change'));
    $$('[data-model] button', form).forEach((b) => b.addEventListener('click', () => {
      readState();
      st.model = b.dataset.v;
      $$('[data-model] button', form).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderEnergy();
      onEdit();
    }));

    $('[data-energy]', form).addEventListener('click', (e) => {
      const add = e.target.closest('[data-add-tier]');
      const rm = e.target.closest('[data-rm-tier]');
      const use = e.target.closest('[data-use-formula]');
      if (!add && !rm && !use) return;
      readState();
      if (add) {
        const last = st.tiers[st.tiers.length - 1];
        if (!last.toKwh) last.toKwh = String((tierFrom(st.tiers.length - 1) ?? 0) + 20);
        st.tiers.push({ toKwh: '', rate: last.rate });
      }
      if (rm) st.tiers.splice(Number(rm.dataset.rmTier), 1);
      if (use) {
        const base = num(val('plnBaseRate'));
        const mult = num(val('plnMultiplier'));
        if (val('plnScheme') === 'none' || !(base > 0) || mult == null) return toast('Set a PLN scheme, base rate and multiplier first', 'warn');
        st.flat = String(Math.round(base * mult * 100) / 100);
      }
      renderEnergy();
      onEdit();
    });

    renderEnergy();
    renderComputed();
    liveCheck();
    refreshPreview();
  });
}

// ------------------------------------------------------------------ detail drawer

export function openTariffDrawer(tariffId, onChange = () => {}) {
  let t = null;
  const load = async () => {
    const list = await api('/v1/tariffs');
    t = (list ?? []).find((x) => x.id === tariffId);
    if (!t) throw new Error('Tariff not found. It may have been removed or belong to another organization.');
  };

  const header = (ctx) => {
    ctx.el.querySelector('h2').textContent = t.name;
    ctx.setSubtitle(`${esc(MODEL_LABEL[t.pricing_model] ?? 'Flat energy rate')} · ${esc(SCHEME_LABEL[t.pln_scheme] ?? t.pln_scheme ?? '—')} · active from ${esc(fmt.date(t.active_from))}`);
    const active = t.status !== 'archived';
    const canWrite = state.can('tariff:write') && active;
    ctx.setHeader(`<div class="row" style="margin-top:8px">${active ? tag('t-ok', 'active') : tag('t-mute', 'archived')}
      ${canWrite ? `<button class="btn sm primary" data-assign>${icon('plus')} Assign</button><button class="btn sm" data-archive>Archive</button>` : ''}</div>`);
    $('[data-assign]', ctx.el)?.addEventListener('click', async () => {
      if (await openAssignModal(t)) { onChange(); ctx.show('assign'); }
    });
    $('[data-archive]', ctx.el)?.addEventListener('click', async () => {
      const go = await confirmDialog({
        title: 'Archive tariff plan',
        message: html`Archive <b>${t.name}</b>? It stops pricing new sessions immediately. Sessions it already priced keep it, so their invoices stay reproducible. Archived plans cannot be deleted or reactivated.`,
        confirmLabel: 'Archive plan',
        danger: true,
      });
      if (!go) return;
      if (await attempt(() => api(`/v1/tariffs/${encodeURIComponent(t.id)}/archive`, { method: 'POST' }), { success: 'Tariff archived' })) {
        onChange();
        ctx.refresh();
      }
    });
  };

  return drawer({
    title: 'Tariff plan',
    onClose: () => { if (location.hash.startsWith('#/tariffs/')) history.replaceState(null, '', '#/tariffs'); },
    tabs: [
      {
        id: 'pricing',
        label: 'Pricing',
        async render(body, ctx) {
          await load();
          header(ctx);
          const R = reg();
          const ceil = ceilingFor(t.pln_scheme, t.pln_base_rate);
          const base = t.pln_base_rate != null ? Number(t.pln_base_rate) : null;
          const mult = t.pln_multiplier != null ? Number(t.pln_multiplier) : null;
          const svc = serviceTotal(t);
          const capTags = ['fast', 'ultrafast'].filter((c) => R.serviceCap[c] != null).map((c) =>
            svc <= R.serviceCap[c] ? tag('t-ok', `legal on ${c}`, `Cap ${fmt.idr(R.serviceCap[c])}`) : tag('t-crit', `too high for ${c}`, `Cap ${fmt.idr(R.serviceCap[c])}`)).join(' ');
          const stored = parseFlags(t.validation);
          const foreign = (t.country_code ?? 'ID') !== 'ID';
          body.innerHTML = foreign ? `
            ${t.description ? `<p class="muted" style="margin:0 0 12px"></p>` : ''}
            <div class="grid two">
              <div class="card pad"><h3 style="font-size:13px;margin-bottom:10px">Country &amp; currency</h3><dl class="kv">
                <dt>Country</dt><dd>${esc(COUNTRIES[t.country_code]?.name ?? t.country_code)}</dd>
                <dt>Currency</dt><dd>${esc(t.currency)}</dd>
                <dt>Price regulation</dt><dd>None (commercial prices); idle fees are bounded by the platform cap</dd>
                <dt>Service + admin</dt><dd>${esc(feeD(svc, t.currency))} per session</dd>
              </dl></div>
              <div class="card pad"><h3 style="font-size:13px;margin-bottom:10px">Tax</h3><dl class="kv">
                <dt>Prices</dt><dd>${t.prices_include_tax ? tag('t-ok', `include ${t.country_code === 'SG' ? 'GST' : 'service tax'}`) : tag('t-mute', 'before tax')}</dd>
                <dt>Tax</dt><dd>${esc(COUNTRIES[t.country_code]?.taxName ?? '—')}, per your registration in ${esc(COUNTRIES[t.country_code]?.name ?? t.country_code)} (Settings → Organisation)</dd>
                <dt>Validated</dt><dd>${esc(fmt.time(t.validated_at))}</dd>
                ${t.archived_at ? `<dt>Archived</dt><dd>${esc(fmt.time(t.archived_at))}</dd>` : ''}
              </dl></div>
            </div>
            <div class="section"><h2>Components</h2><div class="card" data-comps></div></div>
            <div class="section"><h2>Validation at save</h2><div data-stored></div></div>` : `
            ${t.description ? `<p class="muted" style="margin:0 0 12px"></p>` : ''}
            <div class="grid two">
              <div class="card pad"><h3 style="font-size:13px;margin-bottom:10px">PLN basis &amp; ceiling</h3><dl class="kv">
                <dt>Scheme</dt><dd>${esc(SCHEME_LABEL[t.pln_scheme] ?? t.pln_scheme ?? '—')}</dd>
                <dt>Base × multiplier</dt><dd>${base != null ? `${esc(idrD(base))} × ${esc(mult ?? '—')}${mult != null ? ` = ${esc(idrD(base * mult))}` : ''}` : '—'}</dd>
                <dt>Energy ceiling</dt><dd>${esc(idrD(ceil))}/kWh <span class="cell-sub">${esc(ceilingExplain(t.pln_scheme))}</span></dd>
                <dt>Service + admin</dt><dd>${esc(fmt.idr(svc))} per session<div style="margin-top:4px">${capTags}</div></dd>
              </dl></div>
              <div class="card pad"><h3 style="font-size:13px;margin-bottom:10px">Tax &amp; payments</h3><dl class="kv">
                <dt>PPN</dt><dd>${t.ppn_applies === false ? tag('t-warn', 'not charged') : tag('t-ok', `charged · ${ppnPct()}% effective`)}</dd>
                <dt>PBJT-TL</dt><dd>Per site (0–10%), set under Sites</dd>
                <dt>QRIS MDR</dt><dd>${t.mdr_mode && t.mdr_mode !== 'absorb' ? esc(t.mdr_mode) : 'Absorbed by CPO'} <span class="cell-sub">surcharging is prohibited by Bank Indonesia</span></dd>
                <dt>Validated</dt><dd>${esc(fmt.time(t.validated_at))}</dd>
                ${t.archived_at ? `<dt>Archived</dt><dd>${esc(fmt.time(t.archived_at))}</dd>` : ''}
              </dl></div>
            </div>
            <div class="section"><h2>Components</h2><div class="card" data-comps></div></div>
            <div class="section"><h2>Validation at save</h2><div data-stored></div></div>`;
          if (t.description) $('p', body).textContent = t.description;
          table($('[data-comps]', body), {
            columns: [
              { label: 'Component', render: (c) => `<div class="cell-title">${esc(KIND_LABEL[c.kind] ?? c.kind)}</div>` },
              {
                label: 'Applies',
                render: (c) => {
                  if (c.kind !== 'energy' && c.kind !== 'time') return c.kind === 'idle' ? 'After charging ends' : 'Once per session';
                  const days = dayText(c.dayMask);
                  return `${esc(BLOCK_LABEL[c.touBlock] ?? c.touBlock ?? 'Any time')}${c.timeFrom && c.timeTo ? `<div class="cell-sub">${esc(c.timeFrom)}–${esc(c.timeTo)}</div>` : ''}${days ? `<div class="cell-sub">${esc(days)}</div>` : ''}`;
                },
              },
              {
                label: 'Band',
                render: (c) => {
                  if (c.kind === 'energy') return (c.fromKwh ?? 0) > 0 || c.toKwh != null ? `${esc(qty(c.fromKwh ?? 0))}–${c.toKwh != null ? esc(qty(c.toKwh)) : '∞'} kWh` : '—';
                  if (c.kind === 'idle' || c.kind === 'time') return `min ${esc(c.fromMinutes)}–${c.toMinutes != null ? esc(c.toMinutes) : '∞'}`;
                  return '—';
                },
              },
              {
                label: 'Rate',
                num: true,
                render: (c) => esc(`${idrD(c.rate, t.currency)}${c.kind === 'energy' ? '/kWh' : c.kind === 'idle' || c.kind === 'time' ? '/min' : '/session'}`),
              },
              {
                label: 'Check',
                render: (c) => {
                  // A Malaysian or Singapore price has no regulated ceiling (and no connector-class fee cap).
                  if (foreign && (c.kind === 'energy' || c.kind === 'session' || c.kind === 'admin')) return tag('t-mute', 'no regulated cap');
                  if (c.kind === 'energy') return ceil != null && c.rate > ceil + 0.001 ? tag('t-crit', `${(c.rate / ceil).toFixed(2)}× ceiling`) : tag('t-ok', 'within ceiling');
                  if (c.kind === 'idle' || c.kind === 'time') {
                    if (c.toMinutes == null) return tag('t-crit', 'unbounded');
                    const worst = Math.max(0, c.toMinutes - c.fromMinutes) * c.rate;
                    if ((t.country_code ?? 'ID') !== 'ID') return tag('t-ok', `max ${feeD(worst, t.currency)}`);
                    return R.idleCap != null && worst > R.idleCap ? tag('t-crit', `max ${fmt.idr(worst)}`) : tag('t-ok', `max ${fmt.idr(worst)}`);
                  }
                  return tag('t-mute', 'capped by connector class');
                },
              },
            ],
            rows: comps(t),
            empty: foreign ? 'No components: delivered energy is not priced, so sessions here are held for review.' : 'No components: every kWh is billed at the PLN formula rate and no fees apply.',
          });
          $('[data-stored]', body).innerHTML = flagsHtml(stored, callout('ok', 'No regulatory flags were recorded when this plan was saved.'));
        },
      },
      {
        id: 'assign',
        label: 'Assignments',
        async render(body, ctx) {
          await load();
          header(ctx);
          const canWrite = state.can('tariff:write') && t.status !== 'archived';
          const list = Array.isArray(t.assignments) ? t.assignments : [];
          body.innerHTML = `${callout('info', 'At billing time the most specific assignment wins: <b>connector › site › all sites</b>. Within one scope, an AC-only or DC-only rule beats “Any”, then the higher priority wins. The tariff in force at session <b>start</b> is used, so changes never re-price past sessions.')}
            <div class="card" style="margin-top:12px" data-list></div>`;
          table($('[data-list]', body), {
            columns: [
              { label: 'Scope', render: (a) => `<div class="cell-title">${esc(a.scopeName ?? '—')}</div><div class="cell-sub">${esc({ org: 'All sites', site: 'Site', connector: 'Connector' }[a.scopeType] ?? a.scopeType)}</div>` },
              { label: 'Applies to', render: (a) => (a.currentType ? tag('t-info', `${a.currentType} only`) : tag('t-mute', 'AC + DC')) },
              { label: 'Priority', num: true, render: (a) => esc(a.priority ?? 0) },
              { label: '', render: (a) => (canWrite ? `<button class="btn sm ghost" data-rm="${esc(a.id)}">${icon('x')} Remove</button>` : '') },
            ],
            rows: list,
            empty: t.status === 'archived' ? 'Archived plans have no assignments.' : 'Not assigned anywhere yet, so this plan prices no sessions.',
          });
          $$('[data-rm]', body).forEach((b) => b.addEventListener('click', async () => {
            const a = list.find((x) => x.id === b.dataset.rm);
            if (!a) return;
            const go = await confirmDialog({
              title: 'Remove assignment',
              message: html`Stop using <b>${t.name}</b> for <b>${a.scopeName ?? a.scopeType}</b>? New sessions there fall back to the next matching assignment, or to the regulated default (layanan khusus at N max, energy only) if none matches.`,
              confirmLabel: 'Remove',
              danger: true,
            });
            if (!go) return;
            if (await attempt(() => api(`/v1/tariff-assignments/${encodeURIComponent(a.id)}`, { method: 'DELETE' }), { success: 'Assignment removed' })) {
              onChange();
              ctx.refresh();
            }
          }));
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ list view

registerView('tariffs', {
  title: 'Tariffs & Billing',
  icon: 'tariff',
  group: 'commercial',
  order: 20,
  perm: 'tariff:read',
  async render(root, [tariffId]) {
    const canWrite = state.can('tariff:write');
    const R = reg();
    root.innerHTML = pageHead(
      'Tariff Plans',
      'What drivers pay per kWh, per session and per idle minute. Every plan is checked against the PLN formula ceiling and the Kepmen ESDM 182.K/2023 service-fee caps before it can be saved or assigned.',
      canWrite ? `<button class="btn primary" data-new>${icon('plus')} Create tariff plan</button>` : '',
    ) + `<div class="grid k4" data-kpis></div>
      <div class="section">
        <div class="row" style="margin-bottom:10px"><div class="seg" data-filter role="group" aria-label="Status filter">
          <button type="button" data-v="active" aria-pressed="true">Active</button>
          <button type="button" data-v="archived" aria-pressed="false">Archived</button>
          <button type="button" data-v="all" aria-pressed="false">All</button></div>
          <span class="small muted right" data-count></span></div>
        <div class="card" data-list></div>
      </div>
      <div class="section"><h2>${icon('shield')} How pricing is regulated</h2><div class="card pad" data-reg></div></div>`;

    let filter = 'active';
    let list = [];

    const drawList = () => {
      const rows = list.filter((t) => filter === 'all' || (filter === 'archived' ? t.status === 'archived' : t.status !== 'archived'));
      $('[data-count]', root).textContent = `${rows.length} plan${rows.length === 1 ? '' : 's'}`;
      table($('[data-list]', root), {
        columns: [
          { label: 'Plan name', render: (t) => `<div class="cell-title">${esc(t.name)}</div><div class="cell-sub">${esc(MODEL_LABEL[t.pricing_model] ?? 'Flat energy rate')}${t.description ? ` · ${esc(t.description)}` : ''}</div>` },
          { label: 'Assigned to', render: assignmentSummary },
          { label: onlyIndonesia() ? 'Base rate (IDR/kWh)' : 'Energy price (per kWh)', num: true, render: energySummary },
          { label: 'Service fee', num: true, render: serviceSummary },
          { label: 'Idle fee', num: true, render: idleSummary },
          { label: 'Tax mode', render: (t) => ((t.country_code ?? 'ID') !== 'ID'
            ? `${tag('t-info', `${esc(COUNTRIES[t.country_code]?.name ?? t.country_code)} · ${esc(t.currency)}`)}<div class="cell-sub">${t.prices_include_tax ? 'prices include tax' : 'prices before tax'}</div>`
            : `${t.ppn_applies === false ? tag('t-warn', 'PPN off') : tag('t-ok', 'PPN on')}<div class="cell-sub">+ PBJT-TL at each site’s rate</div>`) },
          { label: 'Status', render: (t) => (t.status === 'archived' ? tag('t-mute', 'archived') : tag('t-ok', 'active')) },
        ],
        rows,
        empty: filter === 'archived' ? 'No archived plans.' : canWrite
          ? 'No tariff plans yet. Until one is assigned, sessions bill at the regulated default (layanan khusus at N max, energy only).'
          : 'No tariff plans yet.',
        onRow: (t) => navigate(`#/tariffs/${encodeURIComponent(t.id)}`),
      });
    };

    const draw = async () => {
      const r = await attempt(() => api('/v1/tariffs'));
      list = Array.isArray(r) ? r : [];
      const active = list.filter((t) => t.status !== 'archived');
      const unassigned = active.filter((t) => !(t.assignments ?? []).length);
      $('[data-kpis]', root).innerHTML = [
        kpi('Active plans', fmt.num(active.length), `${fmt.num(list.length - active.length)} archived`),
        kpi('Unassigned plans', fmt.num(unassigned.length), 'active but pricing nothing', unassigned.length ? 'warn' : ''),
        kpi('Energy ceiling', `${esc(idrD(R.energyCeiling))}`, esc(`per kWh · PLN base ${idrD(R.base)} × N max ${R.nMax}`)),
        kpi('Service-fee caps', `${esc(fmt.idr(R.serviceCap.fast))} / ${esc(fmt.idr(R.serviceCap.ultrafast))}`, 'per session · fast ≤50 kW / ultrafast &gt;50 kW'),
      ].join('');
      drawList();
    };

    $('[data-reg]', root).innerHTML = `<dl class="kv">
      <dt>Energy price</dt><dd>PLN sells SPKLU power under <b>layanan khusus</b> at N × base (N 1.0–${esc(R.nMax)}). The kWh price to drivers may not exceed base × N max, currently <b>${esc(idrD(R.energyCeiling))}/kWh</b>. This applies to peak prices and every tier, not just the average.</dd>
      <dt>Service fee</dt><dd>Kepmen ESDM 182.K/2023 caps the per-session biaya layanan (plus any admin fee) at <b>${esc(fmt.idr(R.serviceCap.fast))}</b> for fast (&gt;22–50 kW) and <b>${esc(fmt.idr(R.serviceCap.ultrafast))}</b> for ultrafast (&gt;50 kW). Slow and medium AC are unregulated. The cap follows each connector’s nameplate power, so it is re-checked on every assignment.</dd>
      <dt>Idle fee</dt><dd>Must have an upper bound. The worst case per session may not exceed ${R.idleCap != null ? `<b>${esc(fmt.idr(R.idleCap))}</b>` : 'the platform cap'}; anything above it is capped on the invoice.</dd>
      <dt>PBJT-TL</dt><dd>Local tax on electricity, 0–${esc((R.pbjtMaxBps / 100).toFixed(0))}%, set per kabupaten/kota and configured on each site.</dd>
      <dt>PPN</dt><dd>${esc(ppnPct())}% effective, on DPP nilai lain. Required for PKP-registered CPOs.</dd>
      <dt>QRIS MDR</dt><dd>Bank Indonesia prohibits surcharging the payment fee to the customer. The CPO absorbs it or builds it into the kWh price.</dd>
    </dl>`;

    $$('[data-filter] button', root).forEach((b) => b.addEventListener('click', () => {
      filter = b.dataset.v;
      $$('[data-filter] button', root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      drawList();
    }));

    await draw();

    $('[data-new]', root)?.addEventListener('click', async () => {
      const created = await openTariffWizard();
      if (!created) return;
      await draw();
      const go = await confirmDialog({
        title: 'Tariff plan saved',
        message: html`<b>${created.name}</b> is saved but prices no sessions until it is assigned. Assign it to all sites, a site, or a single connector now?`,
        confirmLabel: 'Assign now',
      });
      if (go && (await openAssignModal(created))) draw();
    });

    if (tariffId) openTariffDrawer(tariffId, draw);
  },
});
