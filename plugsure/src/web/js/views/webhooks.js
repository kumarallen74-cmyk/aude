import {
  $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, field, callout, modal, confirmDialog, html, toast, copy, drawer,
} from '../core.js';

/**
 * Webhooks — signed, retried event delivery to the operator's own systems
 * (fleet portal, ERP, ticketing, BI). The signing secret is shown ONCE, on
 * create and on rotate. Failed deliveries are kept and can be replayed.
 */

const EVENT_HELP = {
  'session.started': 'A charging session started',
  'session.ended': 'A session ended (energy, duration, stop reason)',
  'cdr.created': 'The priced record of a session (invoice line)',
  'charge_point.connected': 'A charger came online',
  'charge_point.disconnected': 'A charger went offline',
  'charge_point.booted': 'A charger (re)booted, with vendor/model/firmware',
  'connector.status_changed': 'A connector changed status (Available, Charging, Faulted …)',
  'alert.raised': 'An alert was raised (offline too long, fault, refund due …)',
  'refund.due': 'Money is owed back to a driver',
  'refund.completed': 'A refund was paid',
  'firmware.status': 'Firmware update progress',
};

const stateTag = (w) =>
  w.state === 'active' ? (w.consecutive_failures > 0 ? tag('t-warn', 'failing') : tag('t-ok', 'active'))
  : w.state === 'paused' ? tag('t-mute', 'paused')
  : tag('t-crit', 'disabled');

const deliveryTag = (s) => tag(s === 'delivered' ? 't-ok' : s === 'failed' ? 't-crit' : 't-info', s);

function showSecret(secret, what) {
  modal({
    title: 'Signing secret',
    subtitle: what,
    body: `${callout('warn', 'Copy it now — it is not shown again. Store it in the receiving system; rotate it if it is ever exposed.')}
      <div class="row" style="margin-top:12px;gap:8px"><code class="mono grow" style="word-break:break-all">${esc(secret)}</code>
      <button class="btn sm" type="button" data-copy>${icon('copy')} Copy</button></div>
      <p class="cell-sub" style="margin-top:12px">Every request carries <span class="mono">PlugSure-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</span>.
      Verify with HMAC-SHA256(secret, <span class="mono">"&lt;t&gt;.&lt;raw body&gt;"</span>), compare in constant time, and reject timestamps older than 5 minutes.
      <span class="mono">PlugSure-Delivery</span> is the event id — de-duplicate on it (delivery is at-least-once).</p>`,
    actions: [{ label: 'I have stored it', kind: 'primary' }],
    dismissable: false,
    onMount(ctx) { $('[data-copy]', ctx.body).addEventListener('click', () => copy(secret)); },
  });
}

function endpointForm(events, w = {}) {
  const sel = new Set(w.events ?? ['*']);
  const all = sel.has('*');
  return `<div class="form one">
    ${field('Endpoint URL', `<input name="url" value="${esc(w.url ?? '')}" placeholder="https://erp.example.co.id/plugsure/webhook" autocomplete="off">`, { help: 'Must accept POST with a JSON body and answer 2xx within 10 seconds. https is required in production.' })}
    ${field('Description', `<input name="description" value="${esc(w.description ?? '')}" placeholder="e.g. Fleet portal" autocomplete="off">`, { opt: true })}
    <div class="field"><label>Events</label>
      <label class="check"><input type="checkbox" data-all${all ? ' checked' : ''}> <span><b>All events</b>, including types added later</span></label>
      <div data-list style="display:grid;gap:4px;margin-top:6px${all ? ';opacity:.5' : ''}">
        ${events.map((e) => `<label class="check"><input type="checkbox" data-ev="${esc(e)}"${all || sel.has(e) ? ' checked' : ''}${all ? ' disabled' : ''}> <span><span class="mono">${esc(e)}</span> <span class="cell-sub">${esc(EVENT_HELP[e] ?? '')}</span></span></label>`).join('')}
      </div></div></div>`;
}

function wireForm(body) {
  const allBox = $('[data-all]', body);
  allBox.addEventListener('change', () => {
    $$('[data-ev]', body).forEach((b) => { b.disabled = allBox.checked; if (allBox.checked) b.checked = true; });
    $('[data-list]', body).style.opacity = allBox.checked ? '.5' : '';
  });
}

function readForm(body) {
  const url = $('[name="url"]', body).value.trim();
  const description = $('[name="description"]', body).value.trim();
  const events = $('[data-all]', body).checked ? ['*'] : $$('[data-ev]:checked', body).map((b) => b.dataset.ev);
  return { url, description, events };
}

registerView('webhooks', {
  title: 'Webhooks',
  icon: 'link',
  group: 'govern',
  order: 60,
  perm: 'webhook:read',
  async render(root) {
    const canWrite = state.can('webhook:write');
    root.innerHTML = pageHead(
      'Webhooks',
      'Send PlugSure events to your own systems — fleet portal, ERP, ticketing, BI. Deliveries are signed, retried with back-off for about 11 hours, and kept for replay if the receiver was down.',
      `<button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button>${canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} Add endpoint</button>` : ''}`,
    ) + `<div class="card section" data-list></div>`;

    let events = [];
    let rows = [];

    const load = async () => {
      try {
        const data = await api('/v1/webhooks');
        events = data.events ?? [];
        rows = data.rows ?? [];
      } catch (e) {
        const box = $('[data-list]', root);
        if (box) box.innerHTML = callout('crit', esc(e.status === 403 ? 'You do not have permission to view webhooks.' : e.message));
        return;
      }
      // The page was left while loading (an endpoint drawer's close reloads it): nothing to draw into.
      if (!$('[data-list]', root)) return;
      table($('[data-list]', root), {
        columns: [
          { label: 'Endpoint', render: (w) => `<div class="cell-title mono" style="word-break:break-all">${esc(w.url)}</div>${w.description ? `<div class="cell-sub">${esc(w.description)}</div>` : ''}` },
          { label: 'Events', render: (w) => (w.events.includes('*') ? tag('t-info', 'all events') : `<div class="cell-sub">${w.events.map(esc).join(', ')}</div>`) },
          { label: 'Status', render: (w) => `${stateTag(w)}${w.last_error ? `<div class="cell-sub" style="color:var(--crit)">${esc(w.last_error)}</div>` : ''}` },
          { label: 'Last success', render: (w) => esc(w.last_success_at ? fmt.ago(w.last_success_at) : 'never') },
          { label: 'Delivered 24h', num: true, render: (w) => fmt.num(w.delivered_24h) },
          { label: 'Queued', num: true, render: (w) => fmt.num(w.pending) },
          { label: 'Failed', num: true, render: (w) => (w.failed ? `<b style="color:var(--crit)">${fmt.num(w.failed)}</b>` : '0') },
        ],
        rows,
        empty: 'No webhook endpoints yet. Add one to push sessions, CDRs, charger status and alerts to your own systems.',
        onRow: (w) => openEndpoint(w),
      });
    };

    const openEndpoint = (w) => {
      const d = drawer({
        title: w.description || 'Webhook endpoint',
        subtitle: `<span class="mono">${esc(w.url)}</span>`,
        headerHtml: canWrite
          ? `<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
              <button class="btn sm primary" type="button" data-test>Send test event</button>
              <button class="btn sm" type="button" data-edit>Edit</button>
              <button class="btn sm" type="button" data-toggle>${w.state === 'active' ? 'Pause' : 'Enable'}</button>
              <button class="btn sm" type="button" data-rotate>Rotate secret</button>
              <button class="btn sm danger" type="button" data-del>Delete</button></div>`
          : '',
        tabs: [{
          id: 'deliveries',
          label: 'Deliveries',
          async render(body) {
            const { rows: dl } = await api(`/v1/webhooks/${w.id}/deliveries`);
            const failed = dl.filter((x) => x.state === 'failed' && x.event_type !== 'ping').length;
            body.innerHTML = `${failed && canWrite ? `<div class="row" style="margin-bottom:10px">${callout('warn', `${failed} failed ${failed === 1 ? 'delivery' : 'deliveries'} — fix the receiver, then replay.`)}<button class="btn sm" type="button" data-replay-all>Replay failed</button></div>` : ''}<div data-t></div>`;
            table($('[data-t]', body), {
              columns: [
                { label: 'Event', render: (x) => `<span class="mono">${esc(x.event_type)}</span><div class="cell-sub">${esc(fmt.time(x.created_at))}</div>` },
                { label: 'Result', render: (x) => `${deliveryTag(x.state)}${x.last_status ? ` <span class="cell-sub">HTTP ${esc(x.last_status)}</span>` : ''}${x.last_error ? `<div class="cell-sub" style="color:var(--crit)">${esc(x.last_error)}</div>` : ''}` },
                { label: 'Attempts', num: true, render: (x) => `${fmt.num(x.attempts)}${x.state === 'pending' && x.attempts ? `<div class="cell-sub">next ${esc(fmt.timeS(x.next_attempt_at))}</div>` : ''}` },
                { label: '', render: (x) => (x.state === 'failed' && x.event_type !== 'ping' && canWrite ? `<button class="btn sm" type="button" data-replay="${esc(x.id)}">Replay</button>` : '') },
              ],
              rows: dl,
              empty: 'No deliveries yet. Send a test event to check the receiver.',
              onRow: (x) => modal({ title: x.event_type, subtitle: `event ${x.event_id}`, size: 'lg', body: `<pre class="mono" style="white-space:pre-wrap;max-height:60vh;overflow:auto">${esc(JSON.stringify(x.payload, null, 2))}</pre>` }),
            });
            // One handler per render: the drawer body element is reused on refresh.
            body.onclick = async (ev) => {
              const one = ev.target.closest('[data-replay]');
              const all = ev.target.closest('[data-replay-all]');
              if (!one && !all) return;
              try {
                const r = await api(`/v1/webhooks/${w.id}/replay`, { method: 'POST', body: one ? { deliveryId: one.dataset.replay } : {} });
                toast(`${r.requeued} ${r.requeued === 1 ? 'delivery' : 'deliveries'} queued again`, 'ok');
                d.refresh();
              } catch (e) { toast(e.message, 'crit'); }
            };
          },
        }],
        onClose: load,
      });
      if (!canWrite) return;
      $('[data-test]', d.el).addEventListener('click', async (ev) => {
        ev.target.classList.add('busy');
        try {
          const r = await api(`/v1/webhooks/${w.id}/test`, { method: 'POST' });
          toast(r.ok ? `Receiver answered HTTP ${r.status} in ${r.ms} ms` : `Test failed: ${r.error}`, r.ok ? 'ok' : 'crit');
        } catch (e) { toast(e.message, 'crit'); }
        ev.target.classList.remove('busy');
        d.refresh();
      });
      $('[data-edit]', d.el).addEventListener('click', () => {
        modal({
          title: 'Edit webhook endpoint',
          size: 'lg',
          body: endpointForm(events, w),
          onMount: (ctx) => wireForm(ctx.body),
          actions: [{ label: 'Cancel' }, {
            label: 'Save', kind: 'primary',
            async onClick(ctx) {
              const v = readForm(ctx.body);
              if (!v.events.length) { toast('Choose at least one event', 'warn'); return false; }
              try {
                const r = await api(`/v1/webhooks/${w.id}`, { method: 'PATCH', body: v });
                Object.assign(w, r.endpoint);
                toast('Endpoint saved', 'ok');
                d.close();
              } catch (e) { toast(e.message, 'crit'); return false; }
            },
          }],
        });
      });
      $('[data-toggle]', d.el).addEventListener('click', async () => {
        try {
          await api(`/v1/webhooks/${w.id}`, { method: 'PATCH', body: { state: w.state === 'active' ? 'paused' : 'active' } });
          toast(w.state === 'active' ? 'Paused — events are not queued while paused' : 'Enabled', 'ok');
          d.close();
        } catch (e) { toast(e.message, 'crit'); }
      });
      $('[data-rotate]', d.el).addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Rotate the signing secret?', message: 'The old secret stops working immediately. Update the receiver with the new one straight away.', confirmLabel: 'Rotate', danger: true });
        if (!ok) return;
        try {
          const r = await api(`/v1/webhooks/${w.id}/rotate-secret`, { method: 'POST' });
          showSecret(r.secret, w.url);
        } catch (e) { toast(e.message, 'crit'); }
      });
      $('[data-del]', d.el).addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Delete this endpoint?', message: html`Nothing more is sent to <span class="mono">${w.url}</span>, and its delivery history is removed.`, confirmLabel: 'Delete', danger: true, requireText: 'DELETE' });
        if (!ok) return;
        try {
          await api(`/v1/webhooks/${w.id}`, { method: 'DELETE' });
          toast('Endpoint deleted', 'ok');
          d.close();
        } catch (e) { toast(e.message, 'crit'); }
      });
    };

    $('[data-refresh]', root).addEventListener('click', load);
    $('[data-add]', root)?.addEventListener('click', () => {
      modal({
        title: 'Add webhook endpoint',
        size: 'lg',
        body: endpointForm(events),
        onMount: (ctx) => wireForm(ctx.body),
        actions: [{ label: 'Cancel' }, {
          label: 'Add endpoint', kind: 'primary',
          async onClick(ctx) {
            const v = readForm(ctx.body);
            if (!v.url) { $('[name="url"]', ctx.body).classList.add('invalid'); return false; }
            if (!v.events.length) { toast('Choose at least one event', 'warn'); return false; }
            try {
              const r = await api('/v1/webhooks', { method: 'POST', body: v });
              load();
              setTimeout(() => showSecret(r.secret, r.endpoint.url), 50);
            } catch (e) { toast(e.message, 'crit'); return false; }
          },
        }],
      });
    });
    await load();
  },
});
