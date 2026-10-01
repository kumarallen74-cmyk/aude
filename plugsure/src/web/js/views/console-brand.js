import {
  $, $$, esc, api, state, registerView, pageHead, icon, field, callout, toast, formValues, fieldErrors, confirmDialog,
} from '../core.js';

/**
 * Governance → Console branding (v1.5.0): the operator's own name, tagline,
 * colours and logo in this console, and optionally a web address of its own.
 *
 * Everyone who signs in to this operator sees it (staff, site-owner and fleet
 * portals). On the console's own web address the sign-in page shows it too, and
 * only this operator's accounts can sign in there.
 */

function swatch(label, color, on, ratio) {
  return `<div class="da-swatch"><span class="chip" style="background:${esc(color)};color:${esc(on)}">Aa</span>
    <div><div class="cell-title">${esc(label)}</div><div class="cell-sub mono">${esc(color)}${ratio ? ` · ${ratio.toFixed(2)}:1` : ''}</div></div></div>`;
}

/** Tell the shell to repaint with the brand just saved (or PlugSure's, with null). */
const repaint = (view) => window.dispatchEvent(new CustomEvent('ps-brand-changed', { detail: view ?? null }));

registerView('console-brand', {
  title: 'Console branding',
  icon: 'palette',
  group: 'govern',
  order: 63,
  perm: 'org:read',
  async render(root) {
    const canWrite = state.can('org:write');
    let data;
    try { data = await api('/v1/console-brand'); } catch (e) { root.innerHTML = callout('crit', esc(e.message)); return; }

    const paint = () => {
      const b = data.brand;
      const p = data.view?.palette;
      const v = (k, d = '') => esc(b?.[k] ?? d);
      const ro = canWrite ? '' : ' disabled';
      root.innerHTML = pageHead(
        'Console branding',
        'Your name, colours and logo in this console instead of PlugSure’s, for everyone who signs in to your organisation: your staff, and your site owners and fleet customers in their portals.',
      ) + `
      ${!b ? callout('info', 'This console shows the PlugSure brand today. Enter your product name below to use your own.') : ''}
      <div class="da-layout section">
        <form class="da-form" novalidate>
          <fieldset><legend>Name</legend><div class="form">
            ${field('Product name', `<input name="productName" maxlength="30" value="${v('productName')}" placeholder="NusaCharge Ops" required${ro}>`, { help: 'Up to 30 characters. Replaces “PlugSure” in the sidebar, on the sign-in page and in the window title.' })}
            ${field('Tagline', `<input name="tagline" maxlength="30" value="${v('tagline')}" placeholder="Network operations"${ro}>`, { help: 'Under the name in the sidebar. Leave empty for none.', opt: true })}
          </div></fieldset>

          <fieldset style="margin-top:14px"><legend>Colours</legend><div class="form">
            ${field('Brand colour', `<div class="row" style="gap:8px"><input type="color" data-pick="brandColor" value="${v('brandColor', '#1b4d8c')}"${ro}><input name="brandColor" class="mono" maxlength="7" value="${v('brandColor', '#1b4d8c')}"${ro}></div>`, { help: 'The sign-in panel, avatars and the logo tile, under white text.' })}
            ${field('Accent colour', `<div class="row" style="gap:8px"><input type="color" data-pick="accentColor" value="${v('accentColor', '#0c7856')}"${ro}><input name="accentColor" class="mono" maxlength="7" value="${v('accentColor', '#0c7856')}"${ro}></div>`, { help: 'Buttons, links, the selected page and highlights.' })}
          </div>
          ${p ? `<div class="da-swatches">${swatch('Light theme', p.light.accent, p.light.ink, p.light.contrast)}${swatch('Dark theme', p.dark.accent, p.dark.ink, p.dark.contrast)}${swatch('Brand', p.brand, '#ffffff')}</div>
            <p class="cell-sub">${p.adjusted ? 'Your colours are made lighter or darker where needed so text in them reads at 4.5:1 or more (WCAG AA) in both themes. The swatches show what your users see.' : 'Your colours read at 4.5:1 or more in both themes as they are.'}</p>` : ''}
          </fieldset>

          <fieldset style="margin-top:14px"><legend>Logo</legend>
            ${b?.hasLogo ? `<div class="da-icons"><figure><img src="${esc(data.view.logoUrl)}" width="64" height="64" alt="" style="border-radius:12px"><figcaption>Sidebar and sign-in</figcaption></figure>
              <figure><img src="${esc(data.view.logoUrl)}" width="16" height="16" alt=""><figcaption>Browser tab</figcaption></figure></div>` : ''}
            <div class="form">${field('Upload logo', `<input type="file" data-logo accept="image/png"${!b || !canWrite ? ' disabled' : ''}>`,
              { help: b ? 'A square PNG, 64 to 2048 pixels (256 or more is best), up to 1 MB. Without a logo your initials are shown on your brand colour.' : 'Save the product name first.', full: true })}</div>
            <div data-logo-note></div>
            ${b?.hasLogo && canWrite ? '<button class="btn sm ghost" type="button" data-logo-remove>' + icon('x') + ' Remove logo</button>' : ''}
          </fieldset>

          <fieldset style="margin-top:14px"><legend>Web address</legend><div class="form">
            ${field('Console web address', `<input name="hostname" value="${v('hostname')}" placeholder="console.yourcompany.co.id"${ro}>`,
              { help: 'Optional. Your operator (the PlugSure host) adds it to the web server and its access rules, then you point it here with a DNS record. On this address the sign-in page shows your brand, and only your accounts can sign in.', opt: true, full: true })}
          </div></fieldset>

          <fieldset style="margin-top:14px"><legend>Credit</legend>
            <label class="row" style="gap:8px"><input type="checkbox" name="showPoweredBy"${b?.showPoweredBy === false ? '' : ' checked'}${ro}> Show “Powered by PlugSure” under the version in the sidebar</label>
          </fieldset>

          ${canWrite ? `<div class="row section" style="gap:8px">
            <button class="btn primary" type="submit">${icon('check')} ${b ? 'Save' : 'Use my brand'}</button>
            <div class="grow"></div>
            ${b ? `<button class="btn danger" type="button" data-remove>${icon('x')} Back to PlugSure</button>` : ''}
          </div>` : ''}
        </form>

        <aside class="da-side">
          <div class="card"><div class="body">
            <div class="cell-title">Where it shows</div>
            <ul class="cell-sub" style="padding-left:18px;margin:8px 0 0">
              <li>The sidebar: logo, name and tagline.</li>
              <li>The window title and browser tab icon.</li>
              <li>Buttons, links and highlights, in the light and dark themes.</li>
              <li>The sign-in page, on your own console web address.</li>
            </ul>
            <p class="cell-sub" style="margin-top:10px">Your driver app has its own brand, under <a href="#/driver-app">Commercial → Driver app</a>.</p>
          </div></div>
        </aside>
      </div>`;

      const form = $('.da-form', root);
      $$('[data-pick]', root).forEach((pick) => pick.addEventListener('input', () => { $(`[name="${pick.dataset.pick}"]`, form).value = pick.value; }));
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        fieldErrors(form, {});
        try {
          data = await api('/v1/console-brand', { method: 'PUT', body: formValues(form) });
          toast('Saved.', 'ok');
          repaint(data.view);
        } catch (e) {
          fieldErrors(form, e.data?.fields ?? {});
          toast(e.message, 'crit');
        }
      });
      $('[data-logo]', root)?.addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        const note = $('[data-logo-note]', root);
        if (file.size > 1024 * 1024) { note.innerHTML = callout('crit', 'The logo is larger than 1 MB.'); return; }
        const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
        try {
          data = await api('/v1/console-brand/logo', { method: 'PUT', body: { png: b64 } });
          toast('Logo saved.', 'ok');
          repaint(data.view);
        } catch (e) {
          note.innerHTML = callout('crit', esc(e.message));
        }
      });
      $('[data-logo-remove]', root)?.addEventListener('click', async () => {
        try {
          data = await api('/v1/console-brand/logo', { method: 'DELETE' });
          toast('Logo removed.', 'ok');
          repaint(data.view);
        } catch (e) { toast(e.message, 'crit'); }
      });
      $('[data-remove]', root)?.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Go back to the PlugSure brand?',
          message: data.brand.hostname
            ? `Your name, colours and logo are removed. The sign-in page on ${data.brand.hostname} shows PlugSure, and any PlugSure account can sign in there again.`
            : 'Your name, colours and logo are removed from this console.',
          confirmLabel: 'Remove my brand', danger: true,
        });
        if (!ok) return;
        try {
          await api('/v1/console-brand', { method: 'DELETE' });
          toast('The console uses the PlugSure brand again.', 'ok');
          repaint(null);
        } catch (e) { toast(e.message, 'crit'); }
      });
    };
    paint();
  },
});
