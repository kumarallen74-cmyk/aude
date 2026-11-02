import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options } from '../core.js';

/**
 * (v1.49.0) Assets & energy → Amenities & access: what each site offers while the car charges and how accessible it
 * is (shown in the driver app, which filters on them), and drivers' reports of what is wrong.
 */

export const AMENITY = { toilet: 'Toilets', prayer_room: 'Prayer room', food: 'Food & drink', shop: 'Shop', wifi: 'Wi-Fi', covered: 'Roof or shade', lit: 'Lit at night', security: 'Security', lounge: 'Lounge', free_parking: 'Free parking' };
const KIND = { blocked_bay: 'Bay blocked', no_step_free: 'No step-free route', cable_short: 'Cable too short', screen_high: 'Screen too high', amenity_wrong: 'Amenity not there', other: 'Other' };
const CHECK = { accessibleBay: 'An accessible bay', stepFree: 'Step-free route', wideBay: 'Bay at least 3.6 m wide', cableReach: 'Cable reaches 3 m or more', screenHeight: 'Screen and payment at most 120 cm' };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const tri = (v) => (v == null ? '' : v ? '1' : '0');

registerView('amenities', {
  title: 'Amenities & access',
  icon: 'info',
  group: 'assets',
  order: 11,
  perm: 'site:read',
  async render(root) {
    const canWrite = state.can('site:write');
    root.innerHTML = pageHead('Amenities & access', 'What each site offers while the car charges, and how accessible it is. Drivers see both in the app, filter on them and report what is wrong.')
      + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);

    const siteModal = (s) => modal({ title: `${s.name} · amenities & access`, size: 'lg', body: `
        <div class="form"><div class="field full"><div class="lbl">Amenities</div><div style="display:flex;flex-wrap:wrap;gap:6px 14px">${Object.entries(AMENITY).map(([v, l]) => `<label style="display:inline-flex;gap:5px"><input type="checkbox" name="am" value="${v}"${s.amenities.includes(v) ? ' checked' : ''}${canWrite ? '' : ' disabled'}>${l}</label>`).join('')}</div></div></div>
        <div class="form grid2" style="margin-top:8px">${field('Open', `<select name="h24">${options([{ value: '1', label: '24 hours' }, { value: '0', label: 'Set hours' }], tri(s.open24h), { blank: 'Not recorded' })}</select>`)}
          ${field('Hours', `<input name="hours" maxlength="120" value="${esc(s.hours ?? '')}" placeholder="06:00–22:00">`)}
          ${field('Accessible bays', `<input name="bays" type="number" min="0" max="50" value="${s.accessibleBays}">`, { help: 'Wider, close to the charger, marked.' })}
          ${field('Step-free route', `<select name="sf">${options([{ value: '1', label: 'Yes' }, { value: '0', label: 'No' }], tri(s.stepFree), { blank: 'Not checked' })}</select>`, { help: 'From the bay to the charger and the screen: no kerbs or steps.' })}
          ${field('Bay width (m)', `<input name="w" type="number" step="0.1" min="1.5" max="10" value="${s.bayWidthM ?? ''}">`)}${field('Cable reach (m)', `<input name="reach" type="number" step="0.1" min="0.5" max="15" value="${s.cableReachM ?? ''}">`)}
          ${field('Screen and payment height (cm)', `<input name="scr" type="number" min="50" max="250" value="${s.maxScreenHeightCm ?? ''}">`, { help: 'The highest control a driver must reach.' })}
          ${field('Checked on site', `<label style="display:inline-flex;gap:6px"><input type="checkbox" name="ver"${canWrite ? '' : ' disabled'}> Checked today${s.verifiedOn ? ` (last ${esc(s.verifiedOn)})` : ''}</label>`)}
          ${field('Notes for drivers', `<textarea name="notes" rows="2" maxlength="500">${esc(s.notes ?? '')}</textarea>`, { full: true })}</div>
        <div class="cell-sub" style="margin-top:8px">${Object.entries(CHECK).map(([k, l]) => `${s.checks[k] === true ? '✓' : s.checks[k] === false ? '✗' : '?'} ${l}`).join(' · ')}</div>`,
    actions: canWrite ? [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
      const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
      const n = (k) => (v(k) === '' ? null : Number(v(k)));
      const b = (k) => (v(k) === '' ? null : v(k) === '1');
      await api(`/v1/sites/${s.siteId}/amenities`, { method: 'PUT', body: { amenities: $$('[name="am"]:checked', mc.el).map((x) => x.value), open24h: b('h24'), hours: v('hours') || null,
        accessibleBays: Number(v('bays') || 0), stepFree: b('sf'), bayWidthM: n('w'), cableReachM: n('reach'), maxScreenHeightCm: n('scr'), notes: v('notes') || null, verified: $('[name="ver"]', mc.el).checked } });
      toast('Saved.', 'ok'); draw();
    }) }] : [{ label: 'Close' }] });

    const draw = async () => {
      let d, reports;
      try { [d, { reports }] = await Promise.all([api('/v1/site-amenities'), api('/v1/accessibility-reports')]); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const s = d.summary;
      body.innerHTML = `<div class="grid k4">${kpi('Sites filled in', `${fmt.num(s.filled)} / ${fmt.num(s.sites)}`)}${kpi('Accessible', fmt.num(s.accessible), 'an accessible bay and step-free')}
          ${kpi('Open reports', fmt.num(s.openReports), 'from drivers', s.openReports ? 'warn' : '')}${kpi('Not filled in', fmt.num(s.sites - s.filled), 'drivers see nothing for them')}</div>
        ${reports.length ? '<div class="card section"><header><h3>Drivers\' reports</h3><span class="cell-sub">From the app</span></header><div data-r></div></div>' : ''}
        <div class="card section"><header><h3>Sites</h3></header><div data-s></div></div>`;
      if (reports.length) {
        table($('[data-r]', body), { columns: [{ label: 'When', render: (r) => esc(fmt.time(r.createdAt)) }, { label: 'Site', render: (r) => `<b>${esc(r.site)}</b>` },
          { label: 'Problem', render: (r) => `${tag(r.kind === 'blocked_bay' ? 't-warn' : 't-info', KIND[r.kind] ?? r.kind)}${r.details ? `<div class="cell-sub">${esc(r.details)}</div>` : ''}` },
          { label: 'From', render: (r) => esc(r.from ?? 'a visitor') },
          ...(canWrite ? [{ label: '', render: (r) => `<button class="btn sm" data-res="${r.id}">Resolve</button> <button class="btn sm" data-dis="${r.id}">Dismiss</button>` }] : [])], rows: reports });
        const act = (status) => (b) => b.addEventListener('click', async () => {
          const resolution = prompt(status === 'resolved' ? 'What was done?' : 'Why is it dismissed?');
          if (!resolution) return;
          try { await api(`/v1/accessibility-reports/${b.dataset.res ?? b.dataset.dis}/resolve`, { method: 'POST', body: { status, resolution } }); draw(); } catch (e) { toast(e.message, 'crit'); }
        });
        $$('[data-res]', body).forEach(act('resolved'));
        $$('[data-dis]', body).forEach(act('dismissed'));
      }
      table($('[data-s]', body), { columns: [{ label: 'Site', render: (x) => `<b>${esc(x.name)}</b><div class="cell-sub">${esc(x.address ?? '')}</div>` },
        { label: 'Amenities', render: (x) => (x.amenities.length ? esc(x.amenities.map((a) => AMENITY[a] ?? a).join(', ')) : '<span class="cell-sub">none recorded</span>') },
        { label: 'Access', render: (x) => `${x.accessible ? tag('t-ok', 'accessible') : x.filled ? tag('t-mute', 'not accessible') : tag('t-mute', 'not checked')}<div class="cell-sub">${x.score} of 5 checks</div>` },
        { label: 'Open', render: (x) => (x.open24h ? '24 hours' : esc(x.hours ?? '—')) }, { label: 'Reports', num: true, render: (x) => (x.openReports ? tag('t-warn', String(x.openReports)) : '') },
        { label: 'Checked', render: (x) => esc(x.verifiedOn ?? '—') }], rows: d.sites, empty: 'No sites.', onRow: siteModal });
    };
    await draw();
  },
});
