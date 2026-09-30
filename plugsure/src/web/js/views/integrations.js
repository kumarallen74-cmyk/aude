import { $, $$, esc, api, state, registerView, pageHead, icon, callout, fmt, tag, modal, confirmDialog, toast, copy, table } from '../core.js';

/**
 * Integrations — the third parties PlugSure talks to, connected from the
 * console instead of environment variables: the QRIS acquirer (each operator's
 * own merchant account, or the platform's), driver sign-in codes by WhatsApp /
 * SMS with a fallback, the Plug & Charge PKI, and map tiles. Secrets are
 * write-only: the page shows that a secret is set, never its value.
 */

const SOURCE = {
  console: ['t-ok', 'connected'],
  environment: ['t-info', 'environment variables'],
  default: ['t-mute', 'built-in default'],
};
const OTHERS = [
  ['E-mail (SMTP) and WhatsApp alerts', 'Who is told about charger alerts, and how.', '#/alert-routing'],
  ['Outbound webhooks', 'Sessions, CDRs, charger status and refunds pushed to your systems.', '#/webhooks'],
  ['Roaming (OCPI 2.2.1)', 'Partner networks and hubs, both roles.', '#/roaming'],
  ['Developer API and sandboxes', 'API keys, the OpenAPI document and test tenants.', '#/developers'],
  ['Charging-station certificates', 'The CA for Security Profile 3 client certificates.', '#/onboarding/ca'],
  ['Plug & Charge contracts', 'eMAIDs, trust anchors and chargers\' V2G certificates.', '#/pnc'],
];

registerView('integrations', {
  title: 'Integrations',
  icon: 'link',
  group: 'govern',
  order: 2,
  perm: 'org:read',
  async render(root) {
    root.innerHTML = pageHead('Integrations', 'Connect the services PlugSure depends on: the acquirer that takes drivers\' payments (QRIS, e-wallets, cards), the WhatsApp / SMS provider that sends sign-in codes, the Plug & Charge PKI and the map tiles. Settings made here override environment variables; secrets are stored encrypted and never shown again.', '')
      + '<div data-body></div>';
    await draw($('[data-body]', root));
  },
});

async function draw(box) {
  const o = await api('/v1/integrations');
  const byKind = Object.fromEntries(o.kinds.map((k) => [k.kind, k]));
  const missing = ['payments', 'otp'].filter((k) => !byKind[k].effective || (o.production && byKind[k].effective.source === 'default'));
  box.innerHTML = `
    ${missing.length && o.production ? callout('crit', `<b>Not ready for drivers:</b> ${missing.map((k) => esc(byKind[k].label)).join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not connected. Drivers cannot ${missing.includes('payments') ? 'pay' : ''}${missing.length > 1 ? ' or ' : ''}${missing.includes('otp') ? 'sign in with their phone' : ''}.`) : ''}
    ${!o.production ? callout('info', 'Development deployment: without settings, the sandbox acquirer and on-screen sign-in codes are used. They are never used in production.') : ''}
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;margin-top:12px">
      ${o.kinds.map((k) => card(k)).join('')}
    </div>
    <h3 style="margin:24px 0 10px">Managed on their own pages</h3>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">
      ${OTHERS.map(([t, d, href]) => `<a class="card section" href="${href}" style="text-decoration:none;color:inherit;display:block"><div class="cell-title">${esc(t)} ${icon('external')}</div><div class="cell-sub">${esc(d)}</div></a>`).join('')}
      <div class="card section"><div class="cell-title">HashiCorp Vault PKI</div><div class="cell-sub">Optional issuer for Profile 3 certificates and V2G signing: ${state.me.features?.vault ? tag('t-ok', 'configured') : tag('t-mute', 'not configured')} (VAULT_ADDR / VAULT_TOKEN).</div></div>
    </div>`;
  $$('[data-act]', box).forEach((b) => b.addEventListener('click', () => {
    const k = byKind[b.dataset.kind];
    const scope = b.dataset.scope;
    ({ configure: () => configure(k, scope, o, () => draw(box)), test: () => test(k, scope), activity: () => activity(k), remove: () => remove(k, scope, () => draw(box)) })[b.dataset.act]();
  }));
}

function statusOf(k) {
  if (!k.effective) return tag('t-crit', 'not configured');
  const [cls, label] = SOURCE[k.effective.source] ?? ['t-mute', k.effective.source];
  const p = k.providers.find((x) => x.id === k.effective.provider);
  const sandbox = p?.devOnly ? ` ${tag('t-warn', 'test only')}` : '';
  return `${tag(cls, label)}${sandbox}`;
}

function providerLabel(k, id) { return k.providers.find((p) => p.id === id)?.label ?? id; }

function lastTest(c) {
  if (!c?.lastTest) return '';
  return `<div class="cell-sub" style="margin-top:4px">Last test ${esc(fmt.ago(c.lastTest.at))}: ${c.lastTest.ok ? tag('t-ok', 'passed') : tag('t-crit', 'failed')} ${esc(c.lastTest.message ?? '')}</div>`;
}

function card(k) {
  const eff = k.effective;
  const isPlatformAdmin = state.can('platform:admin');
  const ownBlock = k.scope === 'org' ? `
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
        <div class="lbl small" style="font-weight:600">Your account</div>
        ${k.own ? `<div>${esc(providerLabel(k, k.own.provider))} ${k.own.enabled ? '' : tag('t-mute', 'off')}</div>${lastTest(k.own)}` : '<div class="cell-sub">None — the platform\'s account is used.</div>'}
        ${state.can('org:write') ? `<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
          <button class="btn sm primary" data-act="configure" data-kind="${k.kind}" data-scope="org">${k.own ? 'Change' : 'Connect my account'}</button>
          ${k.own ? `<button class="btn sm" data-act="test" data-kind="${k.kind}" data-scope="org">Test</button><button class="btn sm ghost" data-act="remove" data-kind="${k.kind}" data-scope="org">Remove</button>` : ''}</div>` : ''}
      </div>` : '';
  const platformBlock = `
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
        <div class="lbl small" style="font-weight:600">${k.scope === 'org' ? 'Platform default' : 'Platform'}</div>
        ${k.platform ? `<div>${esc(providerLabel(k, k.platform.provider))} ${k.platform.enabled === false ? tag('t-mute', 'off') : ''}</div>${lastTest(k.platform)}` : `<div class="cell-sub">${eff && eff.source !== 'console' ? `From ${eff.source === 'environment' ? 'environment variables' : 'the built-in default'}: ${esc(providerLabel(k, eff.provider))}` : 'Not configured'}</div>`}
        ${isPlatformAdmin ? `<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
          <button class="btn sm ${k.scope === 'platform' ? 'primary' : ''}" data-act="configure" data-kind="${k.kind}" data-scope="platform">${k.platform ? 'Change' : 'Connect'}</button>
          <button class="btn sm" data-act="test" data-kind="${k.kind}" data-scope="platform">Test</button>
          ${k.platform ? `<button class="btn sm ghost" data-act="remove" data-kind="${k.kind}" data-scope="platform">Remove</button>` : ''}</div>` : (k.scope === 'platform' ? '<div class="cell-sub" style="margin-top:6px">Set by the platform operator.</div>' : '')}
      </div>`;
  return `<div class="card section">
      <div class="row" style="align-items:flex-start;gap:10px"><div class="grow"><h3 style="margin:0">${esc(k.label)}</h3></div><div>${statusOf(k)}</div></div>
      <p class="cell-sub" style="margin:6px 0 0">${esc(k.description)}</p>
      <div style="margin-top:10px"><span class="lbl small">In force:</span> <b>${eff ? esc(providerLabel(k, eff.provider)) : '—'}</b></div>
      ${ownBlock}${platformBlock}
      <div style="margin-top:10px"><button class="btn sm ghost" data-act="activity" data-kind="${k.kind}">${icon('list')} Activity</button></div>
    </div>`;
}

// ─────────────────────────────────────────── configure

function fieldHtml(f, current, hints) {
  const id = `f-${f.key}`;
  const val = current?.[f.key] ?? f.default ?? '';
  const help = f.help ? `<div class="help">${esc(f.help)}</div>` : '';
  const req = f.required ? '' : ' <span class="opt">(optional)</span>';
  if (f.type === 'boolean') return `<div class="field full"><label class="check"><input type="checkbox" id="${id}" data-f="${f.key}"${val === true || val === 'true' ? ' checked' : ''}> <span>${esc(f.label)}</span></label>${help}</div>`;
  if (f.type === 'multiselect') {
    const on = Array.isArray(val) ? val : (f.default ?? []);
    return `<div class="field full"><label>${esc(f.label)}</label><div class="checks">${f.options.map((o) => `<label class="check"><input type="checkbox" data-m="${f.key}" value="${esc(o.value)}"${on.includes(o.value) ? ' checked' : ''}> <span>${esc(o.label)}</span></label>`).join('')}</div>${help}</div>`;
  }
  if (f.type === 'select') return `<div class="field"><label for="${id}">${esc(f.label)}${req}</label><select id="${id}" data-f="${f.key}">${f.options.map((o) => `<option value="${esc(o.value)}"${String(val) === o.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${help}</div>`;
  if (f.type === 'textarea') return `<div class="field full"><label for="${id}">${esc(f.label)}${req}</label><textarea id="${id}" data-f="${f.key}" rows="5" class="mono" placeholder="${esc(f.placeholder ?? '')}"></textarea>${help}</div>`;
  if (f.type === 'secret') {
    const set = hints?.[f.key];
    return `<div class="field full"><label for="${id}">${esc(f.label)}${req}</label><input id="${id}" data-secret="${f.key}" type="password" autocomplete="new-password" class="mono" placeholder="${set ? `Set (${esc(set)}) — leave empty to keep` : esc(f.placeholder ?? '')}">${help}</div>`;
  }
  return `<div class="field${f.type === 'url' ? ' full' : ''}"><label for="${id}">${esc(f.label)}${req}</label><input id="${id}" data-f="${f.key}" type="${f.type === 'number' ? 'number' : 'text'}" placeholder="${esc(f.placeholder ?? '')}"${f.type === 'url' ? ' inputmode="url"' : ''}>${help}</div>`;
}

function configure(k, scope, o, done) {
  const cur = scope === 'org' ? k.own : k.platform;
  let provider = cur?.provider ?? k.providers[0]?.id;
  const m = modal({
    title: `${k.label}${scope === 'org' ? ' — your account' : k.scope === 'org' ? ' — platform default' : ''}`, size: 'lg',
    body: `<div class="field full"><div class="lbl">Provider</div><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px" data-providers>
        ${k.providers.map((p) => `<button type="button" class="plug" style="text-align:left;padding:10px" data-p="${esc(p.id)}"><div style="font-size:13px;font-weight:600">${esc(p.label)}${p.devOnly ? ` ${tag('t-warn', 'test only')}` : ''}</div><small>${esc(p.description)}</small></button>`).join('')}
      </div></div><div data-fields style="margin-top:14px"></div>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(ctx) {
      const p = k.providers.find((x) => x.id === provider);
      const settings = {}, secrets = {};
      $$('[data-f]', ctx.body).forEach((el) => { settings[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value; });
      $$('[data-m]', ctx.body).forEach((el) => { (settings[el.dataset.m] ??= []); if (el.checked) settings[el.dataset.m].push(el.value); });
      $$('[data-secret]', ctx.body).forEach((el) => { if (el.value.trim()) secrets[el.dataset.secret] = el.value; });
      const enabled = $('[data-enabled]', ctx.body)?.checked ?? true;
      try {
        const saved = await api(`/v1/integrations/${k.kind}`, { method: 'PUT', body: { scope, provider: p.id, settings, secrets, enabled } });
        toast('Saved', 'ok');
        if (saved.webhookUrl) setTimeout(() => showWebhook(p, saved.webhookUrl), 50);
        done();
      } catch (e) { toast(e.message, 'crit'); return false; }
    } }],
  });
  const drawFields = () => {
    $$('[data-p]', m.body).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.p === provider)));
    const p = k.providers.find((x) => x.id === provider);
    const current = cur?.provider === provider ? cur.settings : null;
    const hints = cur?.provider === provider ? cur.secretHints : null;
    const basic = p.fields.filter((f) => !f.advanced), adv = p.fields.filter((f) => f.advanced);
    $('[data-fields]', m.body).innerHTML = `
      ${p.docs ? `<p class="cell-sub" style="margin:0 0 10px">Provider documentation: <a href="${esc(p.docs)}" target="_blank" rel="noopener">${esc(p.docs)}</a></p>` : ''}
      ${p.fields.length ? `<div class="form">${basic.map((f) => fieldHtml(f, current, hints)).join('')}</div>` : `<p class="cell-sub">${esc(p.description)}</p>`}
      ${adv.length ? `<details style="margin-top:10px"><summary class="small">Advanced</summary><div class="form" style="margin-top:8px">${adv.map((f) => fieldHtml(f, current, hints)).join('')}</div></details>` : ''}
      ${p.webhook ? `<div style="margin-top:12px">${callout('info', cur?.webhookUrl && cur.provider === provider ? `Payment notification URL (paste into the provider's dashboard): <span class="mono small" style="word-break:break-all">${esc(cur.webhookUrl)}</span>` : 'After saving, you get the payment notification URL to paste into the provider\'s dashboard.')}</div>` : ''}
      <div class="field full" style="margin-top:10px"><label class="check"><input type="checkbox" data-enabled${cur?.enabled === false ? '' : ' checked'}> <span>Enabled</span></label><div class="help">Off: the ${k.scope === 'org' && scope === 'org' ? 'platform default' : 'environment variables or default'} apply instead.</div></div>`;
    // Values are set as properties, never interpolated into HTML.
    for (const f of p.fields) {
      if (f.type === 'secret' || f.type === 'boolean' || f.type === 'select' || f.type === 'multiselect') continue;
      const el = $(`[data-f="${f.key}"]`, m.body);
      if (el) el.value = current?.[f.key] ?? f.default ?? '';
    }
  };
  $$('[data-p]', m.body).forEach((b) => b.addEventListener('click', () => { provider = b.dataset.p; drawFields(); }));
  drawFields();
}

function showWebhook(p, url) {
  modal({
    title: `${p.label}: payment notification URL`,
    body: `<p>Paste this URL into ${esc(p.label)}'s dashboard as the payment notification (callback) URL. Payments are confirmed only by notifications to it, checked with this account's secret.</p>
      <div class="secret mono" style="word-break:break-all" data-url></div>
      <p class="cell-sub" style="margin-top:10px">It must be reachable from the internet: expose <span class="mono">/pay/*</span> on the public host (deploy/Caddyfile).</p>`,
    actions: [{ label: 'Copy', async onClick() { copy(url); return false; } }, { label: 'Done', kind: 'primary' }],
    onMount(ctx) { $('[data-url]', ctx.body).textContent = url; },
  });
}

// ─────────────────────────────────────────── test, activity, remove

function test(k, scope) {
  const phone = k.kind === 'otp' || k.kind === 'otp_fallback';
  const m = modal({
    title: `Test ${k.label}`,
    body: `${phone ? `<div class="field"><label>Send a real test code to (optional)</label><input data-phone inputmode="tel" placeholder="0812…"><div class="help">Without a number, only the credentials are checked (where the provider allows it).</div></div>` : '<p class="cell-sub">Checks the credentials without moving money or sending anything.</p>'}
      <div data-out style="margin-top:10px"></div>`,
    actions: [{ label: 'Close' }, { label: 'Run test', kind: 'primary', async onClick(ctx) {
      const out = $('[data-out]', ctx.body);
      out.innerHTML = '<span class="spinner"></span>';
      try {
        const r = await api(`/v1/integrations/${k.kind}/test`, { method: 'POST', body: { scope, ...(phone && $('[data-phone]', ctx.body).value ? { phone: $('[data-phone]', ctx.body).value } : {}) } });
        out.innerHTML = callout(r.ok ? 'ok' : 'crit', esc(r.message));
      } catch (e) { out.innerHTML = callout('crit', esc(e.message)); }
      return false;
    } }],
  });
  void m;
}

async function activity(k) {
  const { events } = await api(`/v1/integrations/${k.kind}/events?limit=100`);
  const m = modal({ title: `${k.label}: activity`, size: 'lg', body: '<div data-list></div>', actions: [{ label: 'Close' }] });
  table($('[data-list]', m.body), {
    columns: [
      { label: 'When', render: (e) => esc(fmt.time(e.created_at)) },
      { label: 'Provider', render: (e) => esc(providerLabel(k, e.provider)) },
      { label: 'What', render: (e) => esc(e.action.replace(/_/g, ' ')) },
      { label: 'Outcome', render: (e) => tag(/^(ok|sent|created|captured|pass_paid|duplicate)$/.test(e.outcome) ? 't-ok' : /failed|rejected|mismatch|wrong/.test(e.outcome) ? 't-crit' : 't-info', e.outcome.replace(/_/g, ' ')) },
      { label: 'Detail', render: (e) => `<span class="cell-sub">${esc(Object.entries(e.detail ?? {}).filter(([, v]) => v != null && v !== '').map(([key, v]) => `${key}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ').slice(0, 220))}</span>` },
    ],
    rows: events,
    empty: 'Nothing yet.',
  });
}

async function remove(k, scope, done) {
  const ok = await confirmDialog({
    title: `Remove ${k.label} settings`,
    message: scope === 'org' ? 'Your own account is removed; the platform default applies again. Payments already taken keep their account for refunds.' : 'The console settings are removed; environment variables (or the default) apply again.',
    confirmLabel: 'Remove', danger: true,
  });
  if (!ok) return;
  try { await api(`/v1/integrations/${k.kind}?scope=${scope}`, { method: 'DELETE' }); toast('Removed', 'ok'); done(); }
  catch (e) { toast(e.message, 'crit'); }
}
