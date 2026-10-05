import {
  $, esc, api, state, registerView, pageHead, table, tag, icon, fmt, field, callout, kpi, modal, confirmDialog, toast, isRupiah,
} from '../core.js';

/** A summary amount: rupiah as before, or one figure per currency (never added up). */
const perCur = (s, k) => ((s.by_currency ?? []).some((x) => !isRupiah(x.currency))
  ? s.by_currency.filter((x) => x[k]).map((x) => fmt.money(x[k], x.currency)).join(' + ') || fmt.idr(0)
  : fmt.idr(s[k] ?? 0));

/**
 * Refunds — money owed back to prepaid (QRIS) drivers.
 *
 * Two sources: a session that used less than the driver paid, and a payment
 * whose charge never started (charger busy or faulted, driver left). Both used
 * to end at an alert while the driver app promised the money back. Here finance
 * pays them out: through the payment provider's refund API, or by bank transfer
 * recorded with its reference. Every action is audited.
 */

const STATE_TAG = {
  due: ['t-warn', 'due'],
  processing: ['t-info', 'processing'],
  failed: ['t-crit', 'failed'],
  refunded: ['t-ok', 'refunded'],
};
const stateTag = (s) => tag(...(STATE_TAG[s] ?? ['t-mute', s]));

registerView('refunds', {
  title: 'Refunds',
  icon: 'card',
  group: 'commercial',
  order: 24,
  perm: 'payment:read',
  async render(root) {
    const canPay = state.can('payment:write');
    root.innerHTML = pageHead(
      'Refunds',
      'Money owed back to prepaid drivers: unused balance after a session, or a payment whose charge never started. Pay through the payment provider, or refund by bank transfer and record the transfer reference. Card holds and post-pay e-wallet charges, which never need a refund, are listed below.',
      `<button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button>`,
    ) + `<div class="grid k4" data-kpis></div>
      <div class="filters section">${field('Status', `<select data-state>
        <option value="">Outstanding and recent</option><option value="due">Due</option><option value="processing">Processing</option>
        <option value="failed">Failed</option><option value="refunded">Refunded</option></select>`)}</div>
      <div data-note></div><div class="card" data-list></div>
      <div class="section" data-holds></div>`;

    let rows = [];
    const draw = () => {
      table($('[data-list]', root), {
        columns: [
          { label: 'Owed since', render: (r) => `${esc(fmt.time(r.refund_requested_at))}<div class="cell-sub">paid ${esc(fmt.ago(r.paid_at))}</div>` },
          { label: 'Amount', num: true, render: (r) => `<b>${esc(fmt.money(r.refunded_minor ?? r.refund_due_minor, r.currency))}</b><div class="cell-sub">of ${esc(fmt.money(r.amount_captured_minor, r.currency))} paid</div>` },
          { label: 'Reason', render: (r) => `${esc(r.refund_reason ?? '—')}${r.session_id ? `<div class="cell-sub mono">session ${esc(String(r.session_id).slice(0, 8))}</div>` : '<div class="cell-sub">no session started</div>'}` },
          { label: 'Where', render: (r) => `${esc(r.site_name ?? '—')}<div class="cell-sub mono">${esc(r.ocpp_identity ?? '')}${r.connector_no ? ` #${esc(r.connector_no)}` : ''}</div>` },
          { label: 'Payer', render: (r) => `${esc(String(r.method ?? '').toUpperCase())}<div class="cell-sub">${r.driver_phone ? esc(r.driver_phone) : 'guest'} · <span class="mono">${esc(r.provider_ref ?? '')}</span></div>` },
          { label: 'Status', render: (r) => `${stateTag(r.refund_state)}${r.refund_state === 'refunded' ? `<div class="cell-sub">${esc(r.refund_method === 'manual' ? 'bank transfer' : 'provider')} · <span class="mono">${esc(r.refund_ref ?? '')}</span>${r.refunded_by_name ? ` · ${esc(r.refunded_by_name)}` : ''}</div>` : ''}${r.refund_error ? `<div class="cell-sub" style="color:var(--crit)">${esc(r.refund_error)}</div>` : ''}` },
          {
            label: '',
            render: (r) => canPay && r.refund_state !== 'refunded'
              ? `<div class="row nowrap" style="gap:6px">${r.refund_state !== 'processing' ? `<button class="btn sm primary" type="button" data-pay="${esc(r.id)}">Refund via provider</button>` : ''}<button class="btn sm" type="button" data-manual="${esc(r.id)}">Record bank transfer</button></div>`
              : '',
          },
        ],
        rows,
        empty: 'No refunds in this view. Money owed to drivers appears here automatically.',
      });
    };

    const load = async () => {
      let data;
      try {
        data = await api(`/v1/refunds${$('[data-state]', root).value ? `?state=${encodeURIComponent($('[data-state]', root).value)}` : ''}`);
      } catch (e) {
        $('[data-list]', root).innerHTML = callout('crit', esc(e.status === 403 ? 'You do not have permission to view payments.' : e.message));
        return;
      }
      rows = data.rows ?? [];
      const s = data.summary ?? {};
      $('[data-kpis]', root).innerHTML = [
        kpi('Refunds outstanding', fmt.num(s.due_count ?? 0), perCur(s, 'due_minor') + ' owed', Number(s.due_count) ? 'warn' : ''),
        kpi('Failed', fmt.num(s.failed_count ?? 0), 'need a retry or a bank transfer', Number(s.failed_count) ? 'crit' : ''),
        kpi('Refunded, last 30 days', perCur(s, 'refunded_30d_minor'), 'paid back to drivers', 'ok'),
      ].join('');
      $('[data-note]', root).innerHTML = Number(s.due_count)
        ? callout('warn', 'Drivers see "refund in progress" in the app until the refund is recorded here.')
        : '';
      draw();
    };

    $('[data-list]', root).addEventListener('click', async (ev) => {
      const pay = ev.target.closest('[data-pay]');
      const manual = ev.target.closest('[data-manual]');
      if (pay) {
        const r = rows.find((x) => x.id === pay.dataset.pay);
        const ok = await confirmDialog({
          title: 'Refund via the payment provider',
          message: `Send ${fmt.money(r?.refund_due_minor, r?.currency)} back to the payer's original payment method?`,
          confirmLabel: 'Refund',
        });
        if (!ok) return;
        try {
          const res = await api(`/v1/refunds/${pay.dataset.pay}/process`, { method: 'POST' });
          toast(res.state === 'refunded' ? `Refunded — reference ${res.refundRef}` : 'Refund accepted by the provider; it settles shortly.', 'ok');
        } catch (e) {
          toast(e.message, 'crit');
        }
        load();
      }
      if (manual) {
        const r = rows.find((x) => x.id === manual.dataset.manual);
        modal({
          title: 'Record a bank-transfer refund',
          subtitle: `${fmt.money(r?.refund_due_minor, r?.currency)} to ${r?.driver_phone ?? 'the payer'}`,
          body: `${callout('info', 'Use this after paying the driver outside the payment provider. The reference is stored and audited.')}
            <div class="form one" style="margin-top:12px">${field('Transfer reference', '<input name="reference" autocomplete="off" placeholder="e.g. BCA 20260926-123456">')}</div>`,
          actions: [
            { label: 'Cancel' },
            {
              label: 'Record refund',
              kind: 'primary',
              async onClick(ctx) {
                const reference = $('[name="reference"]', ctx.body).value.trim();
                if (reference.length < 3) { $('[name="reference"]', ctx.body).classList.add('invalid'); return false; }
                try {
                  await api(`/v1/refunds/${manual.dataset.manual}/mark-refunded`, { method: 'POST', body: { reference } });
                  toast('Refund recorded', 'ok');
                  load();
                } catch (e) {
                  toast(e.message, 'crit');
                  return false;
                }
              },
            },
          ],
        });
      }
    });
    // Card holds: captured for what the session cost, released when unused. Shown once there are any.
    const HOLD_TAG = {
      held: ['t-info', 'held'], capturing: ['t-info', 'capturing'], captured: ['t-ok', 'captured'], capture_failed: ['t-crit', 'capture failed'],
      releasing: ['t-info', 'releasing'], released: ['t-mute', 'released'], release_failed: ['t-warn', 'release failed'],
    };
    const loadHolds = async () => {
      const box = $('[data-holds]', root);
      let d;
      try { d = await api('/v1/card-holds'); } catch { box.innerHTML = ''; return; }
      if (!d.holds?.length) { box.innerHTML = ''; return; }
      const s = d.summary ?? {};
      box.innerHTML = `<div class="section-head"><h2>Holds and post-pay</h2><div class="muted">Card holds: authorised for the amount the driver chose; the session's total is captured when it ends and the rest released at once. Post-pay: nothing taken at the start; the session's total is charged to the driver's linked e-wallet when it ends. Unused ones are released automatically.</div></div>
        ${Number(s.failed) - Number(s.expired ?? 0) > 0 ? callout('crit', `${fmt.num(Number(s.failed) - Number(s.expired ?? 0))} capture${Number(s.failed) - Number(s.expired ?? 0) > 1 ? 's or releases' : ' or release'} failed. They are retried automatically; retry now, or collect otherwise before the authorisation expires at the acquirer.`) : ''}
        ${Number(s.expired) ? callout('crit', `${fmt.num(s.expired)} card hold${Number(s.expired) > 1 ? 's' : ''} expired at the acquirer before capture: nothing was taken and ${Number(s.expired) > 1 ? 'they' : 'it'} cannot be captured any more. Drivers can pay ${Object.keys(s.expiredByCurrency ?? {}).some((c) => !isRupiah(c)) ? Object.entries(s.expiredByCurrency).map(([c, v]) => fmt.money(v, c)).join(' + ') : fmt.idr(s.expiredMinor ?? 0)} from their receipts in the app; otherwise collect it another way, or write it off.`) : ''}
        <div class="card" data-holdlist></div>`;
      table($('[data-holdlist]', box), {
        columns: [
          { label: 'Kind', render: (h) => (h.kind === 'postpay' ? `Post-pay<div class="cell-sub">${esc(h.channel ?? 'e-wallet')}</div>` : 'Card hold') },
          { label: 'Held', render: (h) => `${esc(fmt.time(h.authorisedAt ?? h.createdAt))}<div class="cell-sub">${esc(h.site ?? '—')} <span class="mono">${esc(h.charger ?? '')}</span></div>` },
          { label: 'Amount', num: true, render: (h) => `<b>${esc(fmt.money(h.capturedMinor ?? h.captureMinor ?? h.heldMinor, h.currency))}</b><div class="cell-sub">${h.captureMinor != null || h.capturedMinor != null ? `of ${esc(fmt.money(h.heldMinor, h.currency))} held` : 'held'}</div>` },
          { label: 'Status', render: (h) => `${h.paidInApp ? tag('t-ok', h.kind === 'postpay' ? (/^link ended:/.test(h.error ?? '') ? 'link ended, paid in app' : 'paid in app') : 'expired, paid in app') : h.expired ? tag('t-crit', 'expired, not charged') : tag(...(HOLD_TAG[h.state] ?? ['t-mute', h.state]))}${h.error ? `<div class="cell-sub" style="color:var(--crit)">${esc(h.error)}</div>` : ''}${h.kind === 'postpay' && !h.paidInApp && /^link ended:/.test(h.error ?? '') ? `<div class="cell-sub">The driver's e-wallet link ended, so it cannot be charged. The driver can pay it from the receipt in the app with another method, or link the e-wallet again.</div>` : h.kind === 'postpay' && h.state === 'capture_failed' ? `<div class="cell-sub">The driver can top up and pay now, or pay from the receipt in the app with another method (the automatic retries stop when they do).</div>` : ''}${h.expired && !h.paidInApp ? `<div class="cell-sub">Nothing was taken from the card and it cannot be captured any more. The driver can pay it from the receipt in the app; otherwise collect it another way, or write it off.</div>` : ''}${h.nextAttemptAt && /failed/.test(h.state) ? `<div class="cell-sub">next try ${esc(fmt.time(h.nextAttemptAt))} · ${esc(fmt.num(h.attempts))} attempts</div>` : ''}` },
          { label: 'Acquirer', render: (h) => `${esc(h.provider)}<div class="cell-sub mono">${esc(h.providerRef ?? '')}</div>` },
          { label: '', render: (h) => (canPay && /failed/.test(h.state) && !h.expired ? `<button class="btn sm" type="button" data-retryhold="${esc(h.id)}">Retry now</button>` : '') },
        ],
        rows: d.holds,
        empty: '',
      });
    };
    $('[data-holds]', root).addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-retryhold]');
      if (!b) return;
      b.disabled = true;
      try {
        const r = await api(`/v1/card-holds/${b.dataset.retryhold}/retry`, { method: 'POST' });
        toast(r.state === 'captured' ? 'Captured' : 'Released', 'ok');
      } catch (e) {
        toast(e.message, 'crit');
      }
      loadHolds();
    });
    $('[data-state]', root).addEventListener('change', load);
    $('[data-refresh]', root).addEventListener('click', () => { load(); loadHolds(); });
    await Promise.all([load(), loadHolds()]);
  },
});
