import {
  $, $$, esc, api, state, registerView, pageHead, tag, icon, field, callout, toast, formValues, fieldErrors, confirmDialog, options, copy,
} from '../core.js';

/**
 * Commercial → Driver app: the operator's own white-label driver app.
 *
 * The same app as PlugSure's, with the operator's name, colours and icon, on the
 * operator's web address, showing only its stations; plus the build kit for the
 * Play Store (Trusted Web Activity) and the App Store (Capacitor shell).
 */

const STORE_LABEL = { live: 'Go live', play: 'Google Play', appstore: 'App Store', recommended: 'Recommended' };

function checklist(checks, group) {
  const items = checks.filter((c) => c.for === group);
  if (!items.length) return '';
  return `<div class="da-checks"><div class="cell-title">${esc(STORE_LABEL[group])}</div><ul>${items.map((c) =>
    `<li class="${c.ok ? 'ok' : 'todo'}">${icon(c.ok ? 'check' : 'x')}<span>${esc(c.label)}</span></li>`).join('')}</ul></div>`;
}

function swatch(label, color, on, ratio) {
  return `<div class="da-swatch"><span class="chip" style="background:${esc(color)};color:${esc(on)}">Aa</span>
    <div><div class="cell-title">${esc(label)}</div><div class="cell-sub mono">${esc(color)}${ratio ? ` · ${ratio.toFixed(2)}:1` : ''}</div></div></div>`;
}

registerView('driver-app', {
  title: 'Driver app',
  icon: 'phone',
  group: 'commercial',
  order: 58,
  perm: 'org:read',
  async render(root) {
    const canWrite = state.can('org:write');
    let data;
    try { data = await api('/v1/driver-app'); } catch (e) { root.innerHTML = callout('crit', esc(e.message)); return; }

    const paint = () => {
      const b = data.brand;
      const p = data.palette;
      const v = (k, d = '') => esc(b?.[k] ?? d);
      const ro = canWrite ? '' : ' disabled';
      root.innerHTML = pageHead(
        'Driver app',
        'Your own driver app: your name, colours and icon, on your web address, showing only your stations. The same app as PlugSure’s, kept up to date with it. Publish it in the Play Store and the App Store from the build kit.',
        b ? `${tag(b.status === 'live' ? 't-ok' : 't-warn', b.status === 'live' ? 'live' : 'draft')}
          <a class="btn" href="${esc(data.previewUrl)}" target="_blank" rel="noopener">${icon('external')} Open preview</a>
          <a class="btn primary" href="/v1/driver-app/kit" download>${icon('download')} Build kit</a>` : '',
      ) + `
      ${!b ? callout('info', 'Your drivers use the PlugSure app today, which shows every operator’s stations. Set up your own app below: it starts as a draft you can preview, and goes live on your web address when you are ready.') : ''}
      ${b?.status === 'live' ? callout('ok', `Live at <a href="${esc(data.appUrl)}" target="_blank" rel="noopener">${esc(data.appUrl)}</a>.`) : ''}
      <div class="da-layout section">
        <form class="da-form" novalidate>
          <fieldset><legend>Name and words</legend><div class="form">
            ${field('App name', `<input name="appName" maxlength="30" value="${v('appName')}" placeholder="NusaCharge" required${ro}>`, { help: 'Up to 30 characters. It replaces “PlugSure” everywhere in the app, on receipts and payment pages, and in sign-in texts.' })}
            ${field('Short name', `<input name="shortName" maxlength="12" value="${v('shortName')}"${ro}>`, { help: 'Under the icon on a phone (12 characters).', opt: true })}
            ${field('Preview name', `<input name="slug" maxlength="32" value="${v('slug')}" placeholder="made from the app name"${ro}>`, { help: 'Lowercase letters, digits and hyphens: /app/?brand=<b>name</b>.', opt: true })}
            ${field('Tagline', `<input name="taglineId" maxlength="40" value="${v('taglineId')}" placeholder="Isi daya, di mana saja"${ro}>`, { opt: true })}
            ${field('Tagline (English)', `<input name="taglineEn" maxlength="40" value="${v('taglineEn')}" placeholder="Charge anywhere"${ro}>`, { opt: true })}
            ${field('Short store description', `<input name="descriptionId" maxlength="80" value="${v('descriptionId')}"${ro}>`, { help: 'Play Store short description, Indonesian (80 characters).', opt: true, full: true })}
            ${field('Short store description (English)', `<input name="descriptionEn" maxlength="80" value="${v('descriptionEn')}"${ro}>`, { opt: true, full: true })}
          </div></fieldset>

          <fieldset style="margin-top:14px"><legend>Colours</legend><div class="form">
            ${field('Accent', `<div class="row" style="gap:8px"><input type="color" data-pick="accentColor" value="${v('accentColor', '#2fd6a7')}"${ro}><input name="accentColor" class="mono" maxlength="7" value="${v('accentColor', '#2fd6a7')}"${ro}></div>`, { help: 'Buttons, links and highlights.' })}
            ${field('Icon background', `<div class="row" style="gap:8px"><input type="color" data-pick="badgeColor" value="${v('badgeColor', '#1b4d8c')}"${ro}><input name="badgeColor" class="mono" maxlength="7" value="${v('badgeColor', '#1b4d8c')}"${ro}></div>`, { help: 'Behind the icon where a phone or store needs a solid square.' })}
          </div>
          ${p ? `<div class="da-swatches">${swatch('Dark theme', p.dark.accent, p.dark.on, p.dark.contrast)}${swatch('Light theme', p.light.accent, p.light.on, p.light.contrast)}${swatch('Icon background', p.badge, '#ffffff')}</div>
            <p class="cell-sub">${p.adjusted ? 'Your accent is made lighter in the dark theme and/or darker in the light theme so text in it reads at 4.5:1 or more (WCAG AA). The swatches show what drivers see.' : 'Your accent reads at 4.5:1 or more in both themes as it is.'}</p>` : ''}
          </fieldset>

          <fieldset style="margin-top:14px"><legend>Icon</legend>
            ${b?.hasIcon ? `<div class="da-icons">
                <figure><img src="${esc(data.iconUrls[192])}" width="64" height="64" alt=""><figcaption>Launcher</figcaption></figure>
                <figure><img src="${esc(data.maskableUrl)}" width="64" height="64" alt="" style="border-radius:50%"><figcaption>Maskable (circle)</figcaption></figure>
                <figure><img src="${esc(data.iconUrls[180])}" width="64" height="64" alt="" style="border-radius:14px"><figcaption>iPhone</figcaption></figure>
                <figure><img src="${esc(data.iconUrls[48])}" width="24" height="24" alt=""><figcaption>48 px</figcaption></figure>
              </div>` : ''}
            <div class="form">${field('Upload icon', `<input type="file" data-icon accept="image/png"${!b || !canWrite ? ' disabled' : ''}>`,
              { help: b ? 'A square PNG, 512 to 2048 pixels (1024 is best), up to 2 MB, filling the whole square. Every launcher, store and App Store size is made from it.' : 'Save the app’s name first.', full: true })}</div>
            <div data-icon-note></div>
          </fieldset>

          <fieldset style="margin-top:14px"><legend>Support and legal</legend><div class="form">
            ${field('Support e-mail', `<input name="supportEmail" type="email" value="${v('supportEmail')}"${ro}>`, { opt: true })}
            ${field('Support WhatsApp / phone', `<input name="supportPhone" value="${v('supportPhone')}" placeholder="+62 812 3456 7890"${ro}>`, { opt: true })}
            ${field('Privacy policy', `<input name="privacyUrl" value="${v('privacyUrl')}" placeholder="https://…"${ro}>`, { help: 'Required by both stores.', opt: true })}
            ${field('Terms of use', `<input name="termsUrl" value="${v('termsUrl')}" placeholder="https://…"${ro}>`, { opt: true })}
          </div><p class="cell-sub">Shown to drivers under Account → Bantuan.</p></fieldset>

          <fieldset style="margin-top:14px"><legend>Web address</legend><div class="form">
            ${field('Web address', `<input name="hostname" value="${v('hostname')}" placeholder="app.yourcompany.co.id"${ro}>`,
              { help: `Point it at PlugSure with a DNS <span class="mono">CNAME</span> to <span class="mono">${esc(data.dnsTarget ?? 'the driver host')}</span>. The certificate is issued automatically.`, opt: true })}
            ${field('Status', `<select name="status"${ro}>${options([{ value: 'draft', label: 'Draft — preview only' }, { value: 'live', label: 'Live on the web address' }], b?.status ?? 'draft')}</select>`,
              { help: 'Live needs an icon and a web address.' })}
          </div></fieldset>

          <fieldset style="margin-top:14px"><legend>Store builds</legend><div class="form">
            ${field('Android package name', `<input name="androidPackage" class="mono" value="${v('androidPackage')}" placeholder="id.yourcompany.app"${ro}>`, { help: 'Fixed once published in Play.', opt: true })}
            ${field('iOS bundle identifier', `<input name="iosBundleId" class="mono" value="${v('iosBundleId')}" placeholder="id.yourcompany.app"${ro}>`, { opt: true })}
            ${field('Signing certificate SHA-256', `<textarea name="androidCertSha256" class="mono" rows="3" placeholder="AB:CD:…  (one per line)"${ro}>${esc((b?.androidCertSha256 ?? []).join('\n'))}</textarea>`,
              { help: 'The upload key, and Play’s app signing key (Play Console → App integrity). Without them the app shows a browser bar.', full: true, opt: true })}
            ${field('Apple Team ID', `<input name="iosTeamId" class="mono" maxlength="10" value="${v('iosTeamId')}"${ro}>`, { opt: true })}
            ${field('Version', `<div class="row" style="gap:8px"><input name="versionName" class="mono" value="${v('versionName', '1.0.0')}" style="max-width:110px"${ro}><input name="versionCode" type="number" min="1" value="${v('versionCode', '1')}" style="max-width:110px"${ro}></div>`,
              { help: 'Name and code; raise the code for every store upload.' })}
          </div></fieldset>

          ${b ? `<fieldset style="margin-top:14px" data-apns><legend>iOS notifications (APNs)</legend>
            <p class="cell-sub" style="margin-top:0">The iOS app gets native notifications — charging started and finished, receipts, refunds, reservations, the queue — sent with your Apple key. Create it in the Apple Developer account: Certificates, Identifiers &amp; Profiles → Keys → +, tick <i>Apple Push Notifications service</i>, and download the .p8 (Apple lets you download it once).</p>
            ${b.apnsConfigured
              ? callout(b.apnsCheckOk ? 'ok' : 'crit', `Key <b class="mono">${esc(b.apnsKeyId)}</b> · ${esc(b.apnsCheckDetail ?? '')}${b.apnsCheckedAt ? ` <span class="cell-sub">(checked ${esc(new Date(b.apnsCheckedAt).toLocaleString())})</span>` : ''}<br>${data.iosPushDevices ?? 0} iPhone(s) registered.`)
              : (!b.iosTeamId || !b.iosBundleId ? callout('warn', 'Enter the Apple Team ID and the iOS bundle identifier above and save first: the key is checked against them.') : '')}
            ${canWrite ? `<div class="form" style="margin-top:10px">
              ${field('Key ID', `<input data-apns-id class="mono" maxlength="10" placeholder="ABC123DEFG" value="${esc(b.apnsKeyId ?? '')}">`)}
              ${field('Key file (.p8)', `<input type="file" data-apns-file accept=".p8,text/plain">`, { help: 'Or paste it below. It is stored encrypted and never shown again.' })}
              ${field('Or paste the key', `<textarea data-apns-p8 class="mono" rows="3" placeholder="-----BEGIN PRIVATE KEY-----"></textarea>`, { full: true, opt: true })}
            </div>
            <div class="row" style="gap:8px;margin-top:8px">
              <button class="btn sm primary" type="button" data-apns-save>${icon('upload')} ${b.apnsConfigured ? 'Replace key' : 'Upload and check'}</button>
              ${b.apnsConfigured ? `<button class="btn sm" type="button" data-apns-check>${icon('refresh')} Check with Apple</button>
              <button class="btn sm ghost" type="button" data-apns-remove>${icon('x')} Remove key</button>` : ''}
            </div>` : ''}
          </fieldset>` : ''}

          ${canWrite ? `<div class="row section" style="gap:8px">
            <button class="btn primary" type="submit">${icon('check')} ${b ? 'Save' : 'Create the app'}</button>
            <div class="grow"></div>
            ${b ? `<button class="btn danger" type="button" data-remove>${icon('x')} Remove app</button>` : ''}
          </div>` : ''}
        </form>

        <aside class="da-side">
          ${b ? `<div class="da-phone"><iframe title="Preview of ${esc(b.appName)}" src="${esc(data.previewUrl)}" loading="lazy"></iframe></div>
            <div class="row" style="gap:6px;justify-content:center;margin-top:8px"><span class="cell-sub mono">${esc(data.previewUrl)}</span>
              <button class="btn sm ghost" type="button" data-copy-preview>${icon('copy')}</button></div>
            <div class="card section"><div class="body">
              ${checklist(data.checks, 'live')}${checklist(data.checks, 'recommended')}${checklist(data.checks, 'play')}${checklist(data.checks, 'appstore')}
              <p class="cell-sub" style="margin-top:10px">The build kit has the Android project (Bubblewrap), the iOS shell (Capacitor), icons, store texts and data-safety answers, with step-by-step instructions.</p>
            </div></div>` : `<div class="card"><div class="body"><div class="cell-title">What you get</div>
              <ul class="cell-sub" style="padding-left:18px;margin:8px 0 0">
                <li>The full driver app — map, QR scan, QRIS / e-wallet / card payments, live charging, receipts, reservations, queue — under your name.</li>
                <li>Only your stations, and your payment account.</li>
                <li>On your web address, installable from the browser.</li>
                <li>A build kit for the Play Store and the App Store.</li>
              </ul></div></div>`}
        </aside>
      </div>`;

      const form = $('.da-form', root);
      $$('[data-pick]', root).forEach((pick) => pick.addEventListener('input', () => { $(`[name="${pick.dataset.pick}"]`, form).value = pick.value; }));
      $('[data-copy-preview]', root)?.addEventListener('click', () => copy(data.previewUrl));
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const vals = formValues(form);
        vals.versionCode = Number(vals.versionCode);
        vals.androidCertSha256 = String(vals.androidCertSha256 ?? '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
        try {
          data = await api('/v1/driver-app', { method: 'PUT', body: vals });
          toast(data.brand.status === 'live' ? 'Saved — the app is live.' : 'Saved.', 'ok');
          paint();
        } catch (e) {
          fieldErrors(form, e.data?.fields ?? {});
          toast(e.message, 'crit');
        }
      });
      $('[data-icon]', root)?.addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        const note = $('[data-icon-note]', root);
        if (file.size > 2 * 1024 * 1024) { note.innerHTML = callout('crit', 'The icon is larger than 2 MB.'); return; }
        const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
        try {
          const r = await api('/v1/driver-app/icon', { method: 'PUT', body: { png: b64 } });
          data = r;
          paint();
          toast('Icon saved.', 'ok');
          if (r.icon.warnings.length) $('[data-icon-note]', root).innerHTML = callout('warn', r.icon.warnings.map(esc).join('<br>'));
        } catch (e) {
          note.innerHTML = callout('crit', esc(e.message));
        }
      });
      const apnsFile = $('[data-apns-file]', root);
      apnsFile?.addEventListener('change', async () => { const f = apnsFile.files?.[0]; if (f) $('[data-apns-p8]', root).value = await f.text(); });
      $('[data-apns-save]', root)?.addEventListener('click', async () => {
        try {
          data = await api('/v1/driver-app/apns', { method: 'PUT', body: { keyId: $('[data-apns-id]', root).value, p8: $('[data-apns-p8]', root).value } });
          toast(data.brand.apnsCheckOk ? 'Key saved — Apple accepted it.' : 'Key saved, but Apple refused it: see the message.', data.brand.apnsCheckOk ? 'ok' : 'warn');
          paint();
        } catch (e) { toast(e.message, 'crit'); }
      });
      $('[data-apns-check]', root)?.addEventListener('click', async () => {
        try { data = await api('/v1/driver-app/apns/check', { method: 'POST' }); toast(data.brand.apnsCheckOk ? 'Apple accepted the key.' : 'Apple refused the key.', data.brand.apnsCheckOk ? 'ok' : 'crit'); paint(); }
        catch (e) { toast(e.message, 'crit'); }
      });
      $('[data-apns-remove]', root)?.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Remove the notifications key?', message: 'The iOS app stops getting notifications until a key is uploaded again.', confirmLabel: 'Remove', danger: true });
        if (!ok) return;
        try { await api('/v1/driver-app/apns', { method: 'DELETE' }); data = await api('/v1/driver-app'); toast('Key removed.', 'ok'); paint(); }
        catch (e) { toast(e.message, 'crit'); }
      });
      $('[data-remove]', root)?.addEventListener('click', async () => {
        const live = data.brand.status === 'live';
        const ok = await confirmDialog({
          title: 'Remove the driver app?',
          message: live ? `It is live at <b>${esc(data.brand.hostname)}</b>. The address stops serving it and your store apps stop working.` : 'Your drivers keep using the PlugSure app.',
          confirmLabel: 'Remove', danger: true, requireText: live ? data.brand.slug : null,
        });
        if (!ok) return;
        try {
          await api(`/v1/driver-app${live ? `?confirm=${encodeURIComponent(data.brand.slug)}` : ''}`, { method: 'DELETE' });
          data = await api('/v1/driver-app');
          toast('Removed.', 'ok');
          paint();
        } catch (e) { toast(e.message, 'crit'); }
      });
    };
    paint();
  },
});
