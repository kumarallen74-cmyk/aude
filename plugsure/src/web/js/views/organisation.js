import {
  $, esc, api, state, registerView, pageHead, field, options, callout, toast, formValues, fieldErrors, tag, fmt, table, modal, setOrgZone,
} from '../core.js';

/**
 * Governance → Organisation (docs/MULTI-COUNTRY-DESIGN.md §D1, §D3, §D10): the home country (the
 * default for new sites and the eMSP identity), the reporting time zone (statements, alerts and
 * the times on this console), the default language, and the tax registrations per country:
 * Indonesian PKP (PPN), Malaysian service tax (SST) and Singapore GST.
 */

const SCHEME_LABEL = { ID_PKP: 'PKP — PPN (Indonesia)', MY_SST: 'Service tax — SST (Malaysia)', SG_GST: 'GST (Singapore)' };
const NO_LABEL = { ID: 'NPWP', MY: 'SST registration no.', SG: 'GST registration no.' };

registerView('organisation', {
  title: 'Organisation',
  icon: 'globe',
  group: 'govern',
  order: 61,
  perm: 'org:read',
  async render(root) {
    const canWrite = state.can('org:write');
    let d;
    try { d = await api('/v1/org/settings'); } catch (e) { root.innerHTML = callout('crit', esc(e.message)); return; }

    const paint = () => {
      const zones = d.countries.filter((c) => c.code === d.homeCountry || d.sitesByCountry[c.code])
        .flatMap((c) => c.timezones.map((tz) => ({ value: tz, label: `${fmt.tz(tz)} — ${tz} (${c.name})` })));
      const offered = d.countries.filter((c) => c.code === 'ID' || d.multiCountry || c.code === d.homeCountry || d.sitesByCountry[c.code]);
      // An Indonesia-only operator on a default installation: no Malaysian / Singapore choices, rows or notes.
      const single = offered.length < 2;
      const taxCountries = d.countries.filter((c) => offered.includes(c) || d.taxRegistrations.some((r) => r.countryCode === c.code));
      const ro = canWrite ? '' : ' disabled';
      const open = d.taxRegistrations.filter((r) => !r.effectiveTo);
      root.innerHTML = pageHead(
        'Organisation',
        single
          ? 'The time zone your statements and this console use, the language for new documents, and your PKP (PPN) registration.'
          : 'Where you operate: your home country, the time zone your statements and this console use, the language for new documents, and your tax registrations in each country.',
      ) + `
      <div class="grid two section">
        <form class="card pad" data-org novalidate>
          <h3 style="font-size:13px;margin-bottom:10px">${single ? 'Time zone and language' : 'Country, time zone and language'}</h3>
          <div class="form">
            ${single ? `<input type="hidden" name="homeCountry" value="${esc(d.homeCountry)}">` : field('Home country', `<select name="homeCountry"${ro}>${options(offered.map((c) => ({ value: c.code, label: `${c.name} (${c.currency})` })), d.homeCountry)}</select>`,
              { help: 'New sites start in this country; your roaming (eMSP) identity is this country’s.' })}
            ${field('Reporting time zone', `<select name="timezone"${ro}>${options(zones, d.timezone)}</select>`,
              { help: 'Months for statements and invoices, alert times, and every time on this console without a site of its own.' })}
            ${field('Default language', `<select name="defaultLocale"${ro}>${options([{ value: 'id', label: 'Bahasa Indonesia' }, { value: 'en', label: 'English' }], d.defaultLocale)}</select>`,
              { help: `For documents and the driver app where the driver has not chosen.${single ? '' : ' Malaysia and Singapore default to English.'}` })}
          </div>
          ${canWrite ? '<div class="row" style="margin-top:12px"><button class="btn primary" type="submit">Save</button></div>' : ''}
          ${single ? '' : `<div class="small muted" style="margin-top:10px">Sites: ${Object.entries(d.sitesByCountry).map(([c, n]) => `${esc(d.countries.find((x) => x.code === c)?.name ?? c)} ${esc(n)}`).join(' · ') || 'none yet'}</div>`}
        </form>
        <div class="card pad">
          <h3 style="font-size:13px;margin-bottom:10px">${single ? 'Tax registration in force' : 'Tax registrations in force'}</h3>
          <dl class="kv">${taxCountries.map((c) => {
            const r = open.find((x) => x.countryCode === c.code);
            // Indonesia without a registration row: the PKP status billing uses (organisation.pkp, v1.6).
            const legacy = !r && c.code === 'ID' && d.indonesiaPkp?.registered;
            const state = legacy ? `${tag('t-ok', 'registered')}${d.indonesiaPkp.npwp ? ` <span class="mono">${esc(d.indonesiaPkp.npwp)}</span>` : ''}<div class="cell-sub">organisation record (PKP)</div>`
              : !r ? tag('t-mute', 'not registered') : r.registered ? tag('t-ok', 'registered') : tag('t-warn', 'not registered');
            const extra = r && c.code === 'MY' && r.registered ? (r.evChargingTaxable ? ' · EV charging taxed' : ' · EV charging not taxed') : '';
            return `<dt>${esc(SCHEME_LABEL[c.scheme])}</dt><dd>${state}${r?.registrationNo ? ` <span class="mono">${esc(r.registrationNo)}</span>` : ''}${esc(extra)}${r?.rateBps != null ? ` · ${esc(r.rateBps / 100)}%` : ''}${r ? `<div class="cell-sub">since ${esc(r.effectiveFrom)}</div>` : ''}</dd>`;
          }).join('')}</dl>
          ${canWrite ? '<div class="row" style="margin-top:12px"><button class="btn" type="button" data-add>Record a registration</button></div>' : ''}
          ${single ? '' : `<div style="margin-top:12px">${callout('info', '<b>Malaysia:</b> service tax is charged on EV charging only when you are registered <i>and</i> mark EV charging as taxable — whether it is a taxable service is still to be confirmed with a tax adviser (RMCD). <b>Singapore:</b> registered operators show GST-inclusive prices; GST is worked out of each session total.')}</div>`}
        </div>
      </div>
      <div class="section"><h2>Registration history</h2><div class="card" data-hist></div></div>`;

      table($('[data-hist]', root), {
        columns: [
          ...(single ? [] : [{ label: 'Country', render: (r) => esc(d.countries.find((c) => c.code === r.countryCode)?.name ?? r.countryCode) }]),
          { label: 'Tax', render: (r) => esc(SCHEME_LABEL[r.scheme] ?? r.scheme) },
          { label: 'Status', render: (r) => (r.registered ? tag('t-ok', 'registered') : tag('t-mute', 'not registered')) },
          { label: 'Number', render: (r) => `<span class="mono">${esc(r.registrationNo ?? '—')}</span>` },
          { label: 'From', render: (r) => esc(r.effectiveFrom) },
          { label: 'Until', render: (r) => esc(r.effectiveTo ?? 'in force') },
        ],
        rows: d.taxRegistrations,
        empty: 'No registrations recorded.',
      });

      $('[data-org]', root).addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        try {
          d = await api('/v1/org/settings', { method: 'PUT', body: formValues(form) });
          setOrgZone(d.timezone);
          if (state.me?.org) Object.assign(state.me.org, { homeCountry: d.homeCountry, timezone: d.timezone, defaultLocale: d.defaultLocale });
          toast('Organisation settings saved', 'ok');
          paint();
        } catch (err) {
          fieldErrors(form, err.data?.errors ?? {});
          if (!err.data?.errors) toast(err.message, 'crit');
        }
      });
      $('[data-add]', root)?.addEventListener('click', () => addRegistration());
    };

    const addRegistration = () => {
      const today = new Date().toISOString().slice(0, 10);
      const offered = d.countries.filter((c) => c.code === 'ID' || d.multiCountry || c.code === d.homeCountry || d.sitesByCountry[c.code]);
      const ctx = modal({
        title: 'Record a tax registration',
        subtitle: 'Takes effect from the date given: sessions from that day are taxed by it. The registration in force before ends that day.',
        body: `<form novalidate><div class="form">
          ${field('Country', `<select name="countryCode">${options(offered.map((c) => ({ value: c.code, label: `${c.name} — ${SCHEME_LABEL[c.scheme]}` })), d.homeCountry)}</select>`)}
          ${field('Registered', `<select name="registered"><option value="true">Registered</option><option value="false">Not registered (from this date)</option></select>`)}
          ${field('Registration number', '<input name="registrationNo" class="mono" maxlength="40">', { help: '<span data-no-help></span>' })}
          ${field('Effective from', `<input name="effectiveFrom" type="date" value="${esc(today)}">`)}
          ${field('EV charging is a taxable service', '<label class="check"><input type="checkbox" name="evChargingTaxable"><span>Charge service tax on charging sessions</span></label>', { attrs: 'data-my-only', help: 'Only when confirmed with your tax adviser. Off: registered, but sessions are not taxed.' })}
          ${field('Rate', '<div class="inputgroup"><input name="rateBps" inputmode="numeric" placeholder="the statutory rate"><span class="suffix">bps</span></div>', { opt: true, help: 'Leave empty for the statutory rate (SST 8 %, GST 9 %).' })}
        </div></form>`,
        actions: [
          { label: 'Cancel' },
          {
            label: 'Record', kind: 'primary',
            async onClick(c) {
              const form = $('form', c.body);
              const v = formValues(form);
              v.registered = v.registered !== 'false';
              if (v.countryCode !== 'MY') delete v.evChargingTaxable;
              if (v.rateBps === '') delete v.rateBps;
              try {
                d = await api('/v1/org/tax-registrations', { method: 'POST', body: v });
                toast('Tax registration recorded', 'ok');
                paint();
              } catch (err) {
                fieldErrors(form, err.data?.errors ?? {});
                if (!err.data?.errors) toast(err.message, 'crit');
                return false;
              }
            },
          },
        ],
      });
      const form = $('form', ctx.body);
      const sync = () => {
        const cc = $('[name=countryCode]', form).value;
        $('[data-my-only]', form).hidden = cc !== 'MY';
        $('[data-no-help]', form).textContent = NO_LABEL[cc] ?? '';
      };
      $('[name=countryCode]', form).addEventListener('change', sync);
      sync();
    };

    paint();
  },
});
