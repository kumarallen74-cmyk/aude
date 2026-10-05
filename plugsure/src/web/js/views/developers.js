import {
  $, esc, api, state, registerView, pageHead, table, tag, icon, fmt, field, callout, modal, confirmDialog, html, toast, copy,
} from '../core.js';

/**
 * Developers — the published API reference and developer sandboxes.
 *
 * A sandbox is a separate tenant with virtual chargers (simulated inside the
 * gateway), a site, a tariff and RFID cards. Its API key is shown once, on
 * create and on rotate. Integrators build against the sandbox, then switch to a
 * production key from Users & roles → API keys.
 */

function showKey(key, what) {
  modal({
    title: 'Sandbox API key',
    subtitle: what,
    body: `${callout('warn', 'Copy it now — it is not shown again. It works only inside this sandbox.')}
      <div class="row" style="margin-top:12px;gap:8px"><code class="mono grow" style="word-break:break-all">${esc(key)}</code>
      <button class="btn sm" type="button" data-copy>${icon('copy')} Copy</button></div>
      <p class="cell-sub" style="margin-top:12px">Try it:</p>
      <pre class="mono" style="white-space:pre-wrap;word-break:break-all;font-size:12px">curl ${esc(location.origin)}/v1/sandbox \\
  -H "Authorization: Bearer ${esc(key)}"</pre>
      <p class="cell-sub">Or paste it into <a href="/api-docs.html" target="_blank" rel="noopener">the API reference</a> and use <b>Try it</b>.</p>`,
    actions: [{ label: 'I have stored it', kind: 'primary' }],
    dismissable: false,
    onMount(ctx) { $('[data-copy]', ctx.body).addEventListener('click', () => copy(key)); },
  });
}

registerView('developers', {
  title: 'Developers',
  icon: 'code',
  group: 'govern',
  order: 62,
  perm: 'org:read',
  hubOnly: true,
  async render(root) {
    const canWrite = state.can('org:write');
    root.innerHTML = pageHead(
      'Developers',
      'Integrate your own systems — fleet portals, ERP, apps — with the PlugSure API. Build against a sandbox with virtual chargers, then switch to a production key.',
      `<a class="btn" href="/openapi.json" download="plugsure-openapi.json">${icon('download')} OpenAPI 3.1</a>
       <a class="btn" href="/sdk/plugsure-csms-sdk.tgz" download>${icon('download')} TypeScript SDK</a>
       <a class="btn primary" href="/api-docs.html" target="_blank" rel="noopener">${icon('external')} API reference</a>`,
    ) + `
      <div class="grid k3 section">
        <div class="card"><div class="body">
          <div class="cell-title">1 · Read the reference</div>
          <p class="cell-sub">Every operation with its parameters, responses and required permissions, and the webhook events. Machine-readable as OpenAPI 3.1 for code generators and Postman, and as a TypeScript SDK (<span class="mono">npm install ./plugsure-csms-sdk.tgz</span>; no dependencies) that retries a request refused for the rate limit.</p>
        </div></div>
        <div class="card"><div class="body">
          <div class="cell-title">2 · Build in a sandbox</div>
          <p class="cell-sub">A separate tenant with a 60 kW DC and a 22 kW AC virtual charger that speak real OCPP. Start and stop sessions, tap cards, cause faults, drop the 4G link — and receive the same webhooks as production.</p>
        </div></div>
        <div class="card"><div class="body">
          <div class="cell-title">3 · Go live</div>
          <p class="cell-sub">Create a production key with only the permissions the integration needs under <a href="#/users/keys">Users &amp; roles → API keys</a>, and subscribe to <a href="#/webhooks">webhooks</a>. Each key has its own rate limit (set it there) and its usage by hour.</p>
        </div></div>
      </div>
      <div class="card section">
        <header><h3>Sandboxes</h3><div class="grow"></div>
          ${canWrite ? `<button class="btn primary sm" type="button" data-add>${icon('plus')} Create sandbox</button>` : ''}</header>
        <div data-list></div>
      </div>`;

    let max = 3;
    // A hub-only organisation (an external PlugSure Hub member) has no CSMS: no sandboxes (the API refuses them).
    if (state.me?.org?.hubOnly === true) {
      $('[data-list]', root).innerHTML = `<div class="body">${callout('info', 'Sandboxes simulate a charging network, which a PlugSure Hub member does not run here. Use an API key (Users &amp; roles → API keys) for the member clearing API under /v1/roaming/hub/clearing.')}</div>`;
      const add = $('[data-add]', root);
      if (add) add.remove();
      return;
    }
    const load = async () => {
      let rows = [];
      try {
        const r = await api('/v1/sandboxes');
        rows = r.sandboxes; max = r.max;
      } catch (e) {
        $('[data-list]', root).innerHTML = `<div class="body">${callout('crit', esc(e.message))}</div>`;
        return;
      }
      const add = $('[data-add]', root);
      if (add) add.disabled = rows.length >= max;
      table($('[data-list]', root), {
        columns: [
          { label: 'Sandbox', render: (s) => `<div class="cell-title">${esc(s.name)}</div><div class="cell-sub mono">${esc(s.slug)}</div>` },
          { label: 'Chargers', num: true, render: (s) => `${fmt.num(s.chargePoints)} ${tag('t-info', 'virtual')}` },
          { label: 'API key', render: (s) => s.keys.length
              ? s.keys.map((k) => `<span class="mono">psk_${esc(k.prefix)}_…</span><div class="cell-sub">${k.lastUsedAt ? `used ${esc(fmt.ago(k.lastUsedAt))}` : 'not used yet'}</div>`).join('')
              : tag('t-mute', 'no key') },
          { label: 'Created', render: (s) => esc(fmt.time(s.createdAt)) },
          { label: '', render: (s) => canWrite
              ? `<div class="row" style="gap:6px;justify-content:flex-end"><button class="btn sm" type="button" data-rotate="${esc(s.id)}">New key</button>
                 <button class="btn sm danger" type="button" data-del="${esc(s.id)}" data-name="${esc(s.name)}">Delete</button></div>`
              : '' },
        ],
        rows,
        empty: `No sandboxes yet.${canWrite ? ' Create one to get a key and two virtual chargers.' : ''} At most ${max}.`,
      });
    };

    root.addEventListener('click', async (ev) => {
      const rot = ev.target.closest('[data-rotate]');
      const del = ev.target.closest('[data-del]');
      if (rot) {
        const ok = await confirmDialog({ title: 'Issue a new sandbox key?', message: 'The current key stops working immediately.', confirmLabel: 'New key', danger: true });
        if (!ok) return;
        try { const r = await api(`/v1/sandboxes/${rot.dataset.rotate}/rotate-key`, { method: 'POST' }); showKey(r.apiKey, 'New key'); load(); }
        catch (e) { toast(e.message, 'crit'); }
      } else if (del) {
        const ok = await confirmDialog({
          title: 'Delete this sandbox?',
          message: html`<b>${del.dataset.name}</b>: its key stops working and its virtual chargers go offline. Its records stay in the audit trail.`,
          confirmLabel: 'Delete', danger: true, requireText: 'DELETE',
        });
        if (!ok) return;
        try { await api(`/v1/sandboxes/${del.dataset.del}`, { method: 'DELETE' }); toast('Sandbox deleted', 'ok'); load(); }
        catch (e) { toast(e.message, 'crit'); }
      }
    });

    $('[data-add]', root)?.addEventListener('click', () => {
      modal({
        title: 'Create a developer sandbox',
        body: `<div class="form one">${field('Name', '<input name="name" maxlength="60" placeholder="e.g. Fleet app integration" autocomplete="off">', { help: 'Who or what it is for. The sandbox is a separate tenant: it never sees your real sites, chargers, drivers or money, and nothing in it reaches the driver app or roaming partners.' })}</div>`,
        actions: [{ label: 'Cancel' }, {
          label: 'Create sandbox', kind: 'primary',
          async onClick(ctx) {
            try {
              const r = await api('/v1/sandboxes', { method: 'POST', body: { name: $('[name="name"]', ctx.body).value.trim() } });
              load();
              setTimeout(() => showKey(r.apiKey, `${r.name} · chargers ${r.chargePoints.map((c) => c.identity).join(', ')}`), 50);
            } catch (e) { toast(e.message, 'crit'); return false; }
          },
        }],
      });
    });
    await load();
  },
});
