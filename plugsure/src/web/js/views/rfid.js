import {
  $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, confirmDialog, html, field, options,
  formValues, fieldErrors, toast, callout, kpi, debounce, sites as loadSites, phoneExample,
  countryCurrency, isRupiah, toMinor, toMajor, zonedDayStartIso
} from '../core.js';

/** Currencies a card's spending limit can be in: those of the organisation's sites, the home country's first. */
const limitCurrencies = () => [...new Set([countryCurrency(state.me?.org?.homeCountry), ...(state.me?.org?.countries ?? []).map((c) => c.currency)])];

/**
 * Module 7 — RFID Card Inventory & Access Control Center.
 *
 * Card UIDs (idTags) are read off hardware and may have been presented by any
 * card at any charger, so they are escaped everywhere and form values are set
 * as DOM properties. A change here applies at the next Authorize; offline
 * chargers only learn it when the local authorisation list is pushed.
 */

const ID_TAG_RE = /^[\x21-\x7e]{1,20}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const FALLBACK_ACCOUNT_TYPES = [
  { code: 'retail', label: 'Retail Driver' },
  { code: 'fleet', label: 'Corporate Fleet' },
  { code: 'vip', label: 'VIP / Internal Testing' },
  { code: 'technician', label: 'Maintenance Technician' },
];
const accountTypes = () => (state.meta?.accountTypes?.length ? state.meta.accountTypes : FALLBACK_ACCOUNT_TYPES);
const accountLabel = (code) => accountTypes().find((a) => a.code === code)?.label ?? code ?? '—';
const ACCOUNT_CLS = { retail: 't-mute', fleet: 't-info', vip: 't-warn', technician: 't-ok' };
const accountTag = (code) => tag(ACCOUNT_CLS[code] ?? 't-mute', accountLabel(code), '', true);

const STATUS_OPTS = [
  { value: 'Accepted', label: 'Active' },
  { value: 'Blocked', label: 'Blocked / Stolen' },
  { value: 'Expired', label: 'Expired' },
];
const pastExpiry = (t) => Boolean(t.valid_to) && new Date(t.valid_to).getTime() < Date.now();
function statusTag(t) {
  if (t.status === 'Blocked') return tag('t-crit', 'Blocked / Stolen');
  if (t.status === 'Expired') return tag('t-mute', 'Expired');
  if (t.status === 'Accepted') return pastExpiry(t) ? tag('t-warn', 'Past expiry', 'Status is Active but the expiry date has passed — chargers refuse it') : tag('t-ok', 'Active');
  return tag('t-mute', t.status ?? 'Unknown');
}

/** Usage bar against a cumulative cap. `used`/`limit` are numbers; fmtFn formats them. */
function usageBar(label, used, limit, fmtFn) {
  const lim = Number(limit);
  if (limit == null || !(lim > 0)) return '';
  const pct = Math.max(0, Math.min(100, Math.round((Number(used ?? 0) / lim) * 100)));
  const cls = pct >= 100 ? 'crit' : pct >= 80 ? 'warn' : '';
  return `<div class="small nowrap">${esc(label)} ${fmtFn(used ?? 0)} / ${fmtFn(lim)}</div>
    <div class="meter" style="margin-top:3px;width:140px" title="${pct}% of the cap used"><i class="${cls}" style="width:${pct}%"></i></div>`;
}
const kwh1 = (wh) => `${fmt.num(Number(wh ?? 0) / 1000, 1)} kWh`;

const loadChargers = () => api('/v1/charge-points').then((l) => (l ?? []).filter((c) => c.status !== 'decommissioned')).catch(() => []);

// ------------------------------------------------------------------ local list sync

function renderSyncResults(out, results) {
  const ok = results.filter((r) => r.ok).length;
  out.innerHTML = `<div style="margin-bottom:10px">${
    !results.length
      ? callout('warn', 'There are no commissioned chargers at this site, so nothing was pushed.')
      : ok === results.length
        ? callout('ok', `<b>All ${esc(results.length)} charger(s) accepted the list.</b> Authorised cards will keep working on these units during a WAN outage.`)
        : callout('warn', `<b>${esc(ok)} of ${esc(results.length)} charger(s) accepted the list.</b> The others keep their previous list; push again once they are online.`)
  }</div><div class="card" data-results></div>`;
  table($('[data-results]', out), {
    columns: [
      { label: 'Charger', render: (r) => `<span class="mono">${esc(r.identity ?? '—')}</span>` },
      { label: 'Result', render: (r) => (r.ok ? tag('t-ok', 'accepted') : tag('t-crit', 'failed')) },
      { label: 'Charger response', render: (r) => esc(r.status ?? '—') },
      { label: 'List version', num: true, render: (r) => esc(r.version ?? '—') },
      { label: 'Cards sent', num: true, render: (r) => esc(r.count ?? '—') },
      { label: 'Error', render: (r) => `<span class="wrap">${esc(r.error ?? '')}</span>` },
    ],
    rows: results,
    empty: 'No chargers.',
  });
}

export async function openSiteSync(presetSiteId = '') {
  const list = ((await loadSites()) ?? []).filter((s) => !s.archived_at);
  modal({
    title: 'Push local list to every charger at a site',
    subtitle: 'Sends the full card list (SendLocalList, full update) to each commissioned charger at the site, one after another. Offline chargers are skipped.',
    size: 'lg',
    body: `${field('Site', `<select data-site>${options(list.map((s) => ({ value: s.id, label: s.name })), presetSiteId, { blank: 'Choose a site…' })}</select>`)}
      <div data-out style="margin-top:14px"></div>`,
    actions: [
      { label: 'Close' },
      {
        label: 'Push list',
        kind: 'primary',
        async onClick(c) {
          const sel = $('[data-site]', c.body);
          const out = $('[data-out]', c.body);
          if (!sel.value) { sel.classList.add('invalid'); toast('Choose a site first', 'warn'); return false; }
          sel.classList.remove('invalid');
          out.innerHTML = '<div class="skeleton" style="width:60%"></div>';
          try {
            const r = await api(`/v1/sites/${encodeURIComponent(sel.value)}/local-list/sync`, { method: 'POST', body: {} });
            renderSyncResults(out, r?.results ?? []);
          } catch (e) {
            out.innerHTML = callout('crit', `Push failed: ${esc(e.message)}`);
          }
          return false;
        },
      },
    ],
  });
}

async function openChargerSync() {
  const cps = await loadChargers();
  const opts = cps.map((c) => ({
    value: c.ocpp_identity,
    label: `${c.display_name ? `${c.display_name} — ` : ''}${c.ocpp_identity}${c.online ? '' : ' (offline)'}`,
  }));
  modal({
    title: 'Push local list to one charger',
    subtitle: 'The charger must be online. Its list version is read first, then the full list is sent with the next version number.',
    body: `${field('Charger', `<select data-cp>${options(opts, '', { blank: cps.length ? 'Choose a charger…' : 'No chargers available' })}</select>`)}
      <div data-out style="margin-top:14px"></div>`,
    actions: [
      { label: 'Close' },
      {
        label: 'Push list',
        kind: 'primary',
        async onClick(c) {
          const sel = $('[data-cp]', c.body);
          const out = $('[data-out]', c.body);
          if (!sel.value) { sel.classList.add('invalid'); toast('Choose a charger first', 'warn'); return false; }
          sel.classList.remove('invalid');
          out.innerHTML = '<div class="skeleton" style="width:60%"></div>';
          try {
            const r = await api(`/v1/charge-points/${encodeURIComponent(sel.value)}/local-list/sync`, { method: 'POST', body: {} });
            renderSyncResults(out, [r]);
          } catch (e) {
            out.innerHTML = callout('crit', `Push failed: ${esc(e.message)}`);
          }
          return false;
        },
      },
    ],
  });
}

/** After a status change: surface the server's hint and offer the push. */
async function offerSync(hint) {
  if (!hint) return;
  toast(hint, 'warn');
  if (!state.can('token:write')) return;
  const yes = await confirmDialog({
    title: 'Push the local list now?',
    message: html`${hint}<br><br>Chargers that are online already enforce the new status at the next tap. Chargers that later go offline use the list stored in their flash.`,
    confirmLabel: 'Choose a site…',
  });
  if (yes) openSiteSync();
}

// ------------------------------------------------------------------ issue / edit dialog

function cardFormHtml(t, isEdit) {
  const pinHelp = isEdit && t?.has_pin
    ? 'A PIN is set. Leave blank to keep it, or type a new 4–8 digit PIN to replace it.'
    : 'Optional 4–8 digit PIN the fleet driver enters in the app. Stored hashed; it cannot be shown again.';
  return `<form novalidate>
    ${isEdit
      ? `<fieldset><legend>Access status</legend>
          <div class="row" style="align-items:flex-end">
            ${field('Status', `<select name="status">${options(STATUS_OPTS, t.status)}</select>`)}
            ${t.status !== 'Blocked' && state.can('token:write') ? `<button type="button" class="btn danger right" data-block>${icon('warn')} Block card (lost/stolen)</button>` : ''}
          </div>
          <div class="help small muted" style="margin-top:6px">Active cards start sessions. Blocked cards are refused at the next tap on any online charger. Offline chargers only learn a change after the local list is pushed.</div>
        </fieldset>`
      : `<fieldset><legend>Card UID</legend>
          <div class="seg" role="group" aria-label="How to enter the card UID" style="margin-bottom:10px">
            <button type="button" data-mode="manual" aria-pressed="true">Type the UID</button>
            <button type="button" data-mode="scan" aria-pressed="false">Scan from live charger</button>
          </div>
          <div class="form">${field('Card UID (hex idTag)', '<input name="uid" class="mono" maxlength="20" autocomplete="off" spellcheck="false" placeholder="04A2B3C4D5E680">', {
            full: true,
            help: 'The idTag the charger reads from the card — usually the hex serial on the supplier\'s delivery list. Up to 20 characters, no spaces. Hex is stored upper-case.',
          })}</div>
          <div data-scan class="hidden" style="margin-top:12px">
            ${callout('info', '<b>Tap the new card on any charger\'s RFID reader, then press Refresh.</b> Cards presented in the last 30 minutes that are not registered yet appear below — press <b>Use</b> to take its UID. The charger will refuse the tap; that is expected.')}
            <div class="row" style="margin-top:10px">
              <select data-scan-cp style="min-width:260px" aria-label="Filter by charger"></select>
              <button type="button" class="btn" data-scan-refresh>${icon('refresh')} Refresh</button>
            </div>
            <div data-scan-list style="margin-top:10px"></div>
          </div>
        </fieldset>`}
    <fieldset style="margin-top:14px"><legend>Cardholder & account</legend><div class="form">
      ${field('Cardholder name', '<input name="holderName" maxlength="200" placeholder="Budi Santoso">')}
      ${field('Mobile phone', `<input name="holderPhone" inputmode="tel" maxlength="20" placeholder="${esc(phoneExample())}">`, { opt: true })}
      ${field('Account type', `<select name="accountType">${options(accountTypes().map((a) => ({ value: a.code, label: a.label })), t?.account_type ?? 'retail')}</select>`)}
      <div data-fleet>${field('Fleet / company name', '<input name="fleetName" maxlength="200" placeholder="PT Logistik Nusantara">')}</div>
      <div data-fleet>${field('App PIN', '<input name="pin" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password">', { opt: true, help: pinHelp })}
        ${isEdit && t?.has_pin ? '<label class="check small" style="margin-top:6px"><input type="checkbox" name="clearPin"><span>Remove the existing PIN</span></label>' : ''}</div>
      ${field('Expiry date', '<input name="validTo" type="date">', { opt: true, help: 'Leave blank for no expiry. Sent to chargers as the idTag expiry date.' })}
    </div></fieldset>
    <fieldset style="margin-top:14px"><legend>Limits & offline access</legend><div class="form">
      ${field('Energy limit', '<div class="inputgroup"><input name="energyLimitKwh" inputmode="decimal" placeholder="No cap"><span class="suffix">kWh</span></div>', {
        opt: true,
        help: `Cumulative over the card's lifetime. Once reached, the card is refused.${isEdit ? ` Used so far: ${esc(kwh1(t.lifetime_energy_wh))}.` : ''}`,
      })}
      ${field('Spending limit', `<div class="inputgroup"><input name="spendLimitMinor" inputmode="${limitCurrencies().length > 1 || !isRupiah(limitCurrencies()[0]) ? 'decimal' : 'numeric'}" placeholder="No cap">${limitCurrencies().length > 1
        ? `<select name="spendLimitCurrency" style="max-width:90px">${options(limitCurrencies().map((c) => ({ value: c, label: c })), t?.spend_limit_currency ?? limitCurrencies()[0])}</select>`
        : `<span class="suffix">${esc(limitCurrencies()[0])}</span><input type="hidden" name="spendLimitCurrency" value="${esc(limitCurrencies()[0])}">`}</div>`, {
        opt: true,
        help: `Cumulative, including tax. Once reached, the card is refused.${limitCurrencies().length > 1 ? ' Charges in another currency are refused.' : ''}${isEdit ? ` Spent so far: ${esc(fmt.money(t.lifetime_spend_minor ?? 0, t.spend_limit_currency))}.` : ''}`,
      })}
      <div class="full"><label class="check"><input type="checkbox" name="offlineAllowed">
        <span><b>Allow offline charging</b><div class="help small muted">Include this card in the chargers' local authorisation list so it still starts sessions when a charger cannot reach the CSMS.</div></span></label></div>
      ${field('Notes', '<textarea name="notes" maxlength="200" rows="2" style="font-family:var(--sans);font-size:13px;min-height:56px" placeholder="Internal notes — delivery batch, vehicle plate…"></textarea>', { full: true, opt: true })}
    </div></fieldset>
  </form>`;
}

/** Validate locally and build the request body. Returns null (and shows errors) if invalid. */
function payloadFrom(form, t, isEdit) {
  const v = formValues(form);
  const errs = {};
  const s = (x) => String(x ?? '').trim();
  const num = (name, idr) => {
    const x = s(v[name]);
    if (!x) return null;
    const n = Number(idr ? x.replace(/[.,\s]/g, '') : x.replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) errs[name] = 'Enter a positive number, or leave blank for no cap';
    return n;
  };
  // Rupiah as before (whole rupiah, "1.000.000" accepted); ringgit / dollars with their cents.
  const limitMinor = () => {
    const cur = v.spendLimitCurrency;
    if (isRupiah(cur)) return num('spendLimitMinor', true);
    const x = s(v.spendLimitMinor);
    if (!x) return null;
    const n = toMinor(x.replace(/,/g, ''), cur);
    if (!Number.isFinite(n) || n <= 0) errs.spendLimitMinor = 'Enter a positive amount, or leave blank for no cap';
    return n;
  };
  const fleet = v.accountType === 'fleet';
  const body = {
    holderName: s(v.holderName) || null,
    holderPhone: s(v.holderPhone) || null,
    accountType: v.accountType,
    fleetName: fleet ? s(v.fleetName) || null : null,
    // The end of that day in the organisation's time zone.
    validTo: YMD.test(s(v.validTo)) ? new Date(Date.parse(zonedDayStartIso(s(v.validTo))) + 86_399_000).toISOString() : null,
    energyLimitKwh: num('energyLimitKwh', false),
    spendLimitMinor: limitMinor(),
    ...(v.spendLimitCurrency ? { spendLimitCurrency: v.spendLimitCurrency } : {}),
    offlineAllowed: Boolean(v.offlineAllowed),
    notes: s(v.notes) || null,
  };
  if (!isEdit) {
    body.uid = s(v.uid);
    if (!ID_TAG_RE.test(body.uid)) errs.uid = 'Card UID must be 1–20 printable characters with no spaces';
  } else {
    body.status = v.status;
  }
  const pin = s(v.pin);
  if (fleet && pin) {
    if (!/^\d{4,8}$/.test(pin)) errs.pin = 'PIN is 4–8 digits';
    body.pin = pin;
  } else if (isEdit && t?.has_pin && (!fleet || v.clearPin)) {
    body.pin = null; // PINs only exist on fleet cards
  }
  if (body.holderPhone && !/^\+?[0-9 ()-]{6,20}$/.test(body.holderPhone)) errs.holderPhone = 'Phone number looks wrong';
  if (Object.keys(errs).length) { fieldErrors(form, errs); return null; }
  return body;
}

/** Issue (t = null) or edit a card. Calls onSaved() after the dialog closes if anything was saved. */
export function openCardModal(t = null, onSaved) {
  const isEdit = Boolean(t);
  const canWrite = state.can('token:write');
  let saved = false;

  const summary = isEdit
    ? `<div class="card pad" style="margin-bottom:14px"><dl class="kv">
        <dt>Card UID</dt><dd class="mono">${esc(t.uid)} <span class="cell-sub">(read-only — a new UID is a new card)</span></dd>
        <dt>Status</dt><dd>${statusTag(t)}</dd>
        <dt>Lifetime use</dt><dd>${esc(kwh1(t.lifetime_energy_wh))} · ${esc(fmt.num(t.total_sessions ?? 0))} sessions · ${esc(fmt.money(t.lifetime_spend_minor ?? 0, t.spend_limit_currency))}</dd>
        <dt>Last used</dt><dd>${t.last_used_at ? `${esc(fmt.time(t.last_used_at))} (${esc(fmt.ago(t.last_used_at))})` : 'never'}</dd>
        <dt>Issued</dt><dd>${esc(fmt.date(t.created_at))}</dd>
      </dl></div>`
    : '';

  const ctx = modal({
    title: isEdit ? `RFID card ${t.uid}` : 'Issue new RFID tag',
    subtitle: isEdit
      ? (t.holder_name ? `${t.holder_name} · ${accountLabel(t.account_type)}` : accountLabel(t.account_type))
      : 'Register a card so chargers accept it. It works at the next tap on any online charger.',
    size: 'lg',
    body: summary + cardFormHtml(t, isEdit),
    actions: canWrite
      ? [
          { label: 'Cancel' },
          {
            label: isEdit ? 'Save changes' : 'Issue card',
            kind: 'primary',
            async onClick(c) {
              const form = $('form', c.body);
              fieldErrors(form, {});
              const body = payloadFrom(form, t, isEdit);
              if (!body) return false;
              try {
                if (isEdit) {
                  const r = await api(`/v1/tokens/${encodeURIComponent(t.id)}`, { method: 'PUT', body });
                  toast('Card updated', 'ok');
                  if (r?.hint) setTimeout(() => offerSync(r.hint), 0);
                } else {
                  const r = await api('/v1/tokens', { method: 'POST', body });
                  toast(`Card ${r?.uid ?? body.uid} issued`, 'ok');
                  if (body.offlineAllowed) toast('Push the local list so offline chargers learn the new card.', 'warn');
                }
                saved = true;
              } catch (e) {
                if (e.status === 422 && e.data?.errors) fieldErrors(form, e.data.errors);
                else if (e.status === 409) fieldErrors(form, { uid: 'That card is already registered — search for it in the inventory instead.' });
                else if (e.status !== 401) toast(e.message, 'crit');
                return false;
              }
            },
          },
        ]
      : [{ label: 'Close' }],
    onClose: () => { if (saved) onSaved?.(); },
  });

  const form = $('form', ctx.body);
  // Values are assigned as properties, never interpolated into markup.
  const set = (name, v) => { const i = $(`[name="${name}"]`, form); if (i && v != null) i.value = v; };
  if (isEdit) {
    set('holderName', t.holder_name); set('holderPhone', t.holder_phone); set('accountType', t.account_type);
    set('fleetName', t.fleet_name); set('validTo', fmt.isoDate(t.valid_to)); set('notes', t.notes);
    set('energyLimitKwh', t.energy_limit_wh != null ? Number(t.energy_limit_wh) / 1000 : null);
    set('spendLimitMinor', t.spend_limit_minor != null ? toMajor(t.spend_limit_minor, t.spend_limit_currency) : null);
    set('status', t.status);
    $('[name=offlineAllowed]', form).checked = Boolean(t.offline_allowed);
  } else {
    $('[name=offlineAllowed]', form).checked = true;
  }

  const syncFleet = () => {
    const fleet = $('[name=accountType]', form).value === 'fleet';
    $$('[data-fleet]', form).forEach((d) => d.classList.toggle('hidden', !fleet));
  };
  $('[name=accountType]', form).addEventListener('change', syncFleet);
  syncFleet();

  if (!canWrite) $$('input, select, textarea', form).forEach((i) => { i.disabled = true; });

  // Block (lost / stolen) — immediate, confirmed.
  $('[data-block]', form)?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Block this card?',
      message: html`Card <b class="mono">${t.uid}</b>${t.holder_name ? html` held by <b>${t.holder_name}</b>` : ''} will be refused at the next tap on every online charger.
        Offline chargers keep accepting it until the local authorisation list is pushed. Other unsaved edits in this dialog are discarded.`,
      confirmLabel: 'Block card',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api(`/v1/tokens/${encodeURIComponent(t.id)}`, { method: 'PUT', body: { status: 'Blocked' } });
      toast('Card blocked', 'ok');
      saved = true;
      ctx.close();
      offerSync(r?.hint ?? 'Push the local authorisation list to the site\'s chargers so offline units learn the new status.');
    } catch (e) {
      if (e.status !== 401) toast(e.message, 'crit');
    }
  });

  // Scan-from-live-charger helper (issue mode only).
  if (!isEdit) {
    const scan = $('[data-scan]', form);
    const scanList = $('[data-scan-list]', form);
    const cpSel = $('[data-scan-cp]', form);
    let scanned = [];
    let loadedCps = false;

    const loadScan = async () => {
      scanList.innerHTML = '<div class="skeleton" style="width:50%"></div>';
      const q = cpSel.value ? `?identity=${encodeURIComponent(cpSel.value)}` : '';
      try {
        scanned = (await api(`/v1/tokens/unknown${q}`)) ?? [];
      } catch (e) {
        scanList.innerHTML = callout('crit', `Could not read recent card taps: ${esc(e.message)}`);
        return;
      }
      table(scanList, {
        columns: [
          { label: 'Card UID', render: (r) => `<span class="mono">${esc(r.id_tag)}</span>` },
          { label: 'Charger', render: (r) => `<span class="mono">${esc(r.ocpp_identity ?? '—')}</span>` },
          { label: 'Last tap', render: (r) => `<span class="nowrap">${esc(fmt.ago(r.last_seen_at))}</span>` },
          { label: 'Taps', num: true, render: (r) => esc(r.presentations ?? 1) },
          { label: '', render: (_r, i) => `<button type="button" class="btn sm primary" data-use="${i}">Use</button>` },
        ],
        rows: scanned,
        empty: 'No unregistered cards tapped in the last 30 minutes. Tap the card on a reader, wait a few seconds, then press Refresh.',
      });
    };

    const setMode = async (mode) => {
      $$('[data-mode]', form).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
      scan.classList.toggle('hidden', mode !== 'scan');
      if (mode !== 'scan') return;
      if (!loadedCps) {
        loadedCps = true;
        const cps = await loadChargers();
        cpSel.innerHTML = options(
          cps.map((c) => ({ value: c.ocpp_identity, label: `${c.display_name ? `${c.display_name} — ` : ''}${c.ocpp_identity}${c.online ? '' : ' (offline)'}` })),
          '',
          { blank: 'Taps at any charger' },
        );
      }
      loadScan();
    };
    $$('[data-mode]', form).forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    $('[data-scan-refresh]', form).addEventListener('click', loadScan);
    cpSel.addEventListener('change', loadScan);
    scanList.addEventListener('click', (e) => {
      const b = e.target.closest('[data-use]');
      if (!b) return;
      const r = scanned[Number(b.dataset.use)];
      if (!r) return;
      const uid = $('[name=uid]', form);
      uid.value = r.id_tag;
      uid.classList.remove('invalid');
      toast('Card UID filled in — complete the cardholder details and press Issue card', 'ok');
      $('[name=holderName]', form).focus();
    });
  }

  return ctx;
}

// ------------------------------------------------------------------ list view

registerView('rfid', {
  title: 'RFID & Access',
  icon: 'card',
  group: 'commercial',
  order: 22,
  perm: 'token:read',
  async render(root, [tokenId]) {
    const canWrite = state.can('token:write');
    root.innerHTML = pageHead(
      'RFID & Access Control',
      'Every RFID card that can start a charge: who holds it, what it may draw, and whether chargers accept it. Changes apply at the next tap on an online charger.',
      canWrite ? `<button class="btn primary" data-new>${icon('plus')} Issue new RFID tag</button>` : '',
    ) + `<div class="grid k4" data-kpis></div>
      <div class="card section">
        <div class="body" style="padding-bottom:0"><div class="filters" data-filters>
          <div class="field grow" style="min-width:240px"><label>Search</label><input type="search" name="q" placeholder="UID, cardholder, fleet or phone" autocomplete="off" spellcheck="false"></div>
          ${field('Status', `<select name="status">${options(STATUS_OPTS, '', { blank: 'Any status' })}</select>`)}
          ${field('Account type', `<select name="accountType">${options(accountTypes().map((a) => ({ value: a.code, label: a.label })), '', { blank: 'Any account type' })}</select>`)}
        </div></div>
        <div data-list><div class="body"><div class="skeleton" style="width:50%"></div></div></div>
      </div>
      ${canWrite ? `<div class="card section">
        <header><h3>Local Authorization List — hardware synchronisation</h3></header>
        <div class="body">
          <p class="hint" style="margin:0 0 12px">Pushing the list (OCPP <span class="mono">SendLocalList</span>, full update) writes every card marked
            <b>Allow offline charging</b> — with its status and expiry — into the charger's own flash memory. If the charger then loses its WAN link
            to the CSMS, authorised drivers can still start charging and blocked cards are still refused. Push after issuing or blocking cards and
            after commissioning a charger. Offline chargers are skipped; push again when they reconnect.</p>
          <div class="row">
            <button class="btn primary" type="button" data-sync-site>${icon('upload')} Push to all chargers at site…</button>
            <button class="btn" type="button" data-sync-cp>${icon('charger')} Push to one charger…</button>
          </div>
        </div>
      </div>` : ''}`;

    const filtersEl = $('[data-filters]', root);
    const listEl = $('[data-list]', root);
    let all = [];
    let seq = 0;

    const drawKpis = () => {
      const active = all.filter((t) => t.status === 'Accepted' && !pastExpiry(t)).length;
      const blocked = all.filter((t) => t.status === 'Blocked').length;
      const energy = all.reduce((a, t) => a + Number(t.lifetime_energy_wh ?? 0), 0);
      const sessions = all.reduce((a, t) => a + Number(t.total_sessions ?? 0), 0);
      $('[data-kpis]', root).innerHTML = [
        kpi('Total cards', fmt.num(all.length), `${fmt.num(all.filter((t) => t.offline_allowed).length)} in chargers' local lists`),
        kpi('Active', fmt.num(active), 'accepted and not past expiry', 'ok'),
        kpi('Blocked / stolen', fmt.num(blocked), 'refused at every online charger', blocked ? 'crit' : ''),
        kpi('Lifetime energy', `${fmt.num(energy / 1000, 0)} kWh`, `${fmt.num(sessions)} sessions on registered cards`),
      ].join('');
    };

    const drawTable = (rows) => {
      table(listEl, {
        columns: [
          {
            label: 'Card UID',
            render: (t) => `<div class="cell-title mono">${esc(t.uid)}</div><div class="cell-sub">${t.offline_allowed ? 'in local list' : 'online only'}${t.has_pin ? ' · PIN set' : ''}</div>`,
          },
          {
            label: 'Cardholder',
            render: (t) => `<div class="cell-title">${esc(t.holder_name ?? '—')}</div><div class="cell-sub">${esc(t.holder_phone ?? '')}</div>`,
          },
          {
            label: 'Account type',
            render: (t) => `${accountTag(t.account_type)}${t.account_type === 'fleet' && t.fleet_name ? `<div class="cell-sub">${esc(t.fleet_name)}</div>` : ''}`,
          },
          {
            label: 'Expiry',
            render: (t) => (t.valid_to
              ? `<span class="nowrap">${esc(fmt.date(t.valid_to))}</span>${pastExpiry(t) ? `<div>${tag('t-warn', 'passed')}</div>` : ''}`
              : '<span class="muted">none</span>'),
          },
          { label: 'Status', render: (t) => statusTag(t) },
          {
            label: 'Limits',
            render: (t) => {
              const e = usageBar('Energy', t.lifetime_energy_wh, t.energy_limit_wh, kwh1);
              const s = usageBar('Spend', t.lifetime_spend_minor, t.spend_limit_minor, (n) => fmt.money(n, t.spend_limit_currency));
              return (e || s) ? `${e}${e && s ? '<div style="height:6px"></div>' : ''}${s}` : '<span class="muted small">no cap</span>';
            },
          },
          {
            label: 'Lifetime energy',
            num: true,
            render: (t) => `<div class="cell-title">${esc(kwh1(t.lifetime_energy_wh))}</div><div class="cell-sub">${esc(fmt.num(t.total_sessions ?? 0))} sessions</div>`,
          },
          {
            label: 'Last used',
            render: (t) => (t.last_used_at
              ? `<span class="nowrap">${esc(fmt.ago(t.last_used_at))}</span><div class="cell-sub nowrap">${esc(fmt.time(t.last_used_at))}</div>`
              : '<span class="muted">never</span>'),
          },
        ],
        rows,
        empty: all.length ? 'No cards match these filters.' : 'No RFID cards yet. Issue the first card to let drivers start sessions with a tap.',
        onRow: (t) => openCardModal(t, reload),
      });
    };

    const drawList = async () => {
      const my = ++seq;
      const v = formValues(filtersEl);
      const q = String(v.q ?? '').trim();
      let rows = all;
      if (q || v.status || v.accountType) {
        const p = new URLSearchParams({ limit: '2000' });
        if (q) p.set('q', q);
        if (v.status) p.set('status', v.status);
        if (v.accountType) p.set('accountType', v.accountType);
        try {
          rows = (await api(`/v1/tokens?${p}`)) ?? [];
        } catch (e) {
          if (my === seq && e.status !== 401) listEl.innerHTML = `<div class="body">${callout('crit', `Could not load cards: ${esc(e.message)}`)}</div>`;
          return;
        }
      }
      if (my !== seq) return;
      drawTable(rows);
    };

    async function reload() {
      try {
        all = (await api('/v1/tokens?limit=2000')) ?? [];
      } catch (e) {
        if (e.status !== 401) listEl.innerHTML = `<div class="body">${callout('crit', `Could not load cards: ${esc(e.message)}`)}</div>`;
        return false;
      }
      drawKpis();
      await drawList();
      return true;
    }

    const onFilter = debounce(drawList, 300);
    filtersEl.addEventListener('input', onFilter);
    filtersEl.addEventListener('change', onFilter);
    $('[data-new]', root)?.addEventListener('click', () => openCardModal(null, reload));
    $('[data-sync-site]', root)?.addEventListener('click', () => openSiteSync());
    $('[data-sync-cp]', root)?.addEventListener('click', () => openChargerSync());

    const ok = await reload();
    if (ok && tokenId) {
      const t = all.find((x) => x.id === tokenId);
      if (t) openCardModal(t, reload);
      else toast('That card was not found — it may belong to another organisation or have been removed.', 'warn');
    }
  },
});
