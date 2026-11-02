import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options, copy } from '../core.js';

/**
 * (v1.47.0) Commercial → Card terminals: card readers on chargers, or kiosks for a site. A tap pre-authorises an
 * amount and starts the connector; at the end the session's total is captured (never more than the hold) and the rest
 * released. The payments, failed captures to send again, and the provider's settlement report matched to them.
 */

const ST = { preauth: ['t-info', 'held'], charging: ['t-info', 'charging'], capture_due: ['t-warn', 'capture due'], void_due: ['t-warn', 'void due'],
  captured: ['t-ok', 'captured'], voided: ['t-mute', 'voided'], failed: ['t-crit', 'failed'] };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };

registerView('card-terminals', {
  title: 'Card terminals',
  icon: 'card',
  group: 'commercial',
  order: 25,
  perm: 'payment:read',
  async render(root) {
    const canWrite = state.can('payment:write');
    root.innerHTML = pageHead('Card terminals',
      'Pay by card at the charger: the terminal holds an amount, the charger starts, and only what the session cost is captured.',
      canWrite ? `<button class="btn" type="button" data-settle>${icon('upload')} Settlement report</button><button class="btn primary" type="button" data-add>${icon('plus')} Add a terminal</button>` : '')
      + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    let sites = [], cps = [], filt = '';

    const showKey = (key) => modal({ title: 'The terminal\'s address',
      body: `${callout('warn', 'Shown once. Set it in the terminal (or its payment app) as the address its events go to.')}
        <div style="display:flex;gap:6px;margin-top:8px"><input readonly value="${esc(`${location.origin}/v1/terminals/events/${key}`)}" style="flex:1"><button class="btn" type="button" data-cpy>${icon('copy')} Copy</button></div>
        <p class="cell-sub" style="margin-top:8px">POST {"type": "preauth", "reference", "amountMinor", "cardBrand", "cardLast4", "connectorId"}; then "poll", "captured", "voided" or "cancel". See CARD-TERMINALS.md.</p>`,
      onMount: (mc) => $('[data-cpy]', mc.el).addEventListener('click', () => copy(`${location.origin}/v1/terminals/events/${key}`)) });

    const termModal = (t) => modal({ title: t ? `Edit ${t.name}` : 'Add a terminal', size: 'lg',
      body: `<div class="form grid2">${field('Name', `<input name="name" maxlength="80" value="${esc(t?.name ?? '')}" placeholder="Reader on DEMO-1">`)}
        ${field('Serial number', `<input name="serial" maxlength="80" value="${esc(t?.serial ?? '')}">`)}
        ${field('Site', `<select name="site">${options(sites.map((s) => ({ value: s.id, label: s.name })), t?.siteId ?? '')}</select>`)}
        ${field('Charger', `<select name="cp">${options(cps.map((c) => ({ value: c.id, label: c.display_name || c.ocpp_identity })), t?.chargePointId ?? '', { blank: 'None: a kiosk for the site' })}</select>`)}
        ${field('Largest hold (minor units)', `<input name="max" type="number" min="1" step="1" value="${t?.maxPreauthMinor ?? ''}">`)}
        ${field('Provider', `<input name="provider" maxlength="40" value="${esc(t?.provider ?? 'generic')}">`)}
        ${field('Callback address', `<input name="cb" maxlength="500" value="${esc(t?.callbackUrl ?? '')}" placeholder="Empty: the terminal polls">`, { help: 'Captures and voids are POSTed here, signed.' })}
        ${field('Callback secret', `<input name="secret" maxlength="500" placeholder="${t?.hasCallbackSecret ? 'Kept (type to replace)' : 'For the signature'}">`)}
        ${t ? field('', `<label><input type="checkbox" name="enabled" ${t.enabled ? 'checked' : ''}> On</label>`) : ''}</div>`,
      actions: [...(t ? [{ label: 'Archive', kind: 'danger', onClick: guard(async () => { await api(`/v1/terminals/${t.id}`, { method: 'PUT', body: { archive: true } }); draw(); }) },
        { label: 'New key', onClick: guard(async () => { const r = await api(`/v1/terminals/${t.id}`, { method: 'PUT', body: { rotateKey: true } }); showKey(r.key); draw(); }) }] : []),
        { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
          const b = { name: v('name'), serial: v('serial') || null, siteId: v('site'), chargePointId: v('cp') || null, maxPreauthMinor: Number(v('max')), provider: v('provider') || 'generic',
            callbackUrl: v('cb') || null, ...(v('secret') ? { callbackSecret: v('secret') } : {}), ...(t ? { enabled: $('[name="enabled"]', mc.el).checked } : {}) };
          const r = await api(t ? `/v1/terminals/${t.id}` : '/v1/terminals', { method: t ? 'PUT' : 'POST', body: b });
          if (r.key) showKey(r.key); else toast('Saved.', 'ok');
          draw();
        }) }] });

    const settleModal = () => modal({ title: 'The provider\'s settlement report', size: 'lg',
      body: `<div class="form">${field('Batch', `<input name="batch" maxlength="80" value="settlement-${new Date().toISOString().slice(0, 10)}">`)}
        ${field('Report (CSV)', '<textarea name="csv" rows="8" placeholder="reference,amount,date&#10;R-1001,45210,2026-11-01"></textarea>', { help: 'Amounts in minor units. A file can be pasted, or chosen below.' })}
        <input type="file" accept=".csv,text/csv,text/plain" data-file></div><div data-res></div>`,
      onMount: (mc) => $('[data-file]', mc.el).addEventListener('change', async (e) => { const f = e.target.files?.[0]; if (f) $('[name="csv"]', mc.el).value = await f.text(); }),
      actions: [{ label: 'Close' }, { label: 'Match', kind: 'primary', onClick: guard(async (mc) => {
        const r = await api('/v1/terminal-settlements', { method: 'POST', body: { batch: $('[name="batch"]', mc.el).value, csv: $('[name="csv"]', mc.el).value } });
        const res = $('[data-res]', mc.el);
        res.innerHTML = `<div style="margin:10px 0">${tag('t-ok', `${r.matched} matched`)} ${tag(r.mismatch ? 't-warn' : 't-mute', `${r.mismatch} differ`)} ${tag(r.unknown ? 't-crit' : 't-mute', `${r.unknown} unknown`)}</div><div data-l></div>`;
        table($('[data-l]', res), { columns: [{ label: 'Reference', key: 'reference' }, { label: 'Settled', num: true, render: (l) => fmt.num(l.amountMinor) }, { label: 'Captured', num: true, render: (l) => (l.capturedMinor == null ? '—' : fmt.num(l.capturedMinor)) },
          { label: '', render: (l) => tag(l.status === 'matched' ? 't-ok' : l.status === 'mismatch' ? 't-warn' : 't-crit', l.status) }], rows: r.lines.filter((l) => l.status !== 'matched'), empty: 'Every line matched.' });
        draw();
        return false;
      }) }] });

    const draw = async () => {
      let terms, days, pays, unsettled;
      try {
        [{ terminals: terms, days }, { payments: pays }, { payments: unsettled }, sites] = await Promise.all([api('/v1/terminals'), api(`/v1/terminal-payments${filt ? `?status=${filt}` : ''}`),
          api('/v1/terminal-settlements/unsettled'), api('/v1/sites').then((r) => (Array.isArray(r) ? r : r.sites ?? []))]);
        if (canWrite && !cps.length) cps = await api('/v1/charge-points').then((r) => (Array.isArray(r) ? r : r.chargePoints ?? r.items ?? [])).catch(() => []);
      } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const cur = days[0]?.currency ?? terms[0]?.currency;
      const sum = (k) => days.reduce((a, d) => a + d[k], 0);
      body.innerHTML = `${sum('failed') ? callout('crit', `${sum('failed')} payment${sum('failed') === 1 ? '' : 's'} could not be captured or voided at the terminal: send them again below, or settle them with the provider.`) : ''}
        <div class="grid k4">${kpi('Terminals', fmt.num(terms.length), `${fmt.num(terms.filter((t) => t.enabled).length)} on`)}${kpi('Captured (30 days)', cur ? fmt.money(sum('capturedMinor'), cur) : '—', `${fmt.num(sum('captured'))} payments`)}
          ${kpi('Released', fmt.num(sum('voided')), 'no charge')}${kpi('Not settled', fmt.num(unsettled.length), 'captured over 3 days ago', unsettled.length ? 'warn' : '')}</div>
        <div class="card section"><header><h3>Terminals</h3></header><div data-t></div></div>
        <div class="card section"><header><h3>Payments</h3><select class="right" data-f style="width:auto">${options(Object.entries(ST).map(([value, [, label]]) => ({ value, label })), filt, { blank: 'Any' })}</select></header><div data-p></div></div>`;
      table($('[data-t]', body), { columns: [{ label: 'Terminal', render: (t) => `<b>${esc(t.name)}</b>${t.serial ? `<div class="cell-sub">${esc(t.serial)}</div>` : ''}` },
        { label: 'Where', render: (t) => `${esc(t.site ?? '')}<div class="cell-sub">${esc(t.charger ?? 'kiosk')}</div>` }, { label: 'Largest hold', num: true, render: (t) => fmt.money(t.maxPreauthMinor, t.currency) },
        { label: 'Instructions', render: (t) => (t.callbackUrl ? 'sent to its callback' : 'polled') }, { label: 'Last seen', render: (t) => (t.lastSeenAt ? esc(fmt.time(t.lastSeenAt)) : '—') },
        { label: '', render: (t) => (t.enabled ? tag('t-ok', 'on') : tag('t-mute', 'off')) }], rows: terms, empty: 'No terminals yet.', onRow: canWrite ? (t) => termModal(t) : undefined });
      table($('[data-p]', body), { columns: [{ label: 'When', render: (p) => esc(fmt.time(p.createdAt)) }, { label: 'Terminal', render: (p) => `${esc(p.terminal)}<div class="cell-sub">${esc(p.reference)}</div>` },
        { label: 'Card', render: (p) => esc(p.card ?? '—') }, { label: 'Held', num: true, render: (p) => fmt.money(p.preauthMinor, p.currency) },
        { label: 'kWh', num: true, render: (p) => (p.kwh == null ? '—' : fmt.num(p.kwh, 2)) }, { label: 'Captured', num: true, render: (p) => (p.amountMinor == null ? '—' : fmt.money(p.amountMinor, p.currency)) },
        { label: 'Status', render: (p) => `${tag(...(ST[p.status] ?? ['t-mute', p.status]), p.lastError ?? p.startStatus ?? '')}${p.settledMinor != null ? `<div class="cell-sub">settled ${fmt.money(p.settledMinor, p.currency)}</div>` : ''}` },
        ...(canWrite ? [{ label: '', render: (p) => (p.status === 'failed' ? `<button class="btn sm" data-retry="${p.id}">Send again</button>` : '') }] : [])],
      rows: pays, empty: 'No payments yet.' });
      $$('[data-retry]', body).forEach((b) => b.addEventListener('click', async () => { try { await api(`/v1/terminal-payments/${b.dataset.retry}/retry`, { method: 'POST' }); toast('Due again.', 'ok'); draw(); } catch (e) { toast(e.message, 'crit'); } }));
      $('[data-f]', body).addEventListener('change', (e) => { filt = e.target.value; draw(); });
    };

    $('[data-add]', root)?.addEventListener('click', () => (sites.length ? termModal(null) : toast('Add a site first.', 'warn')));
    $('[data-settle]', root)?.addEventListener('click', settleModal);
    await draw();
  },
});
