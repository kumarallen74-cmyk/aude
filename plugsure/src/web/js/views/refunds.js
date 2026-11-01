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

/** (v1.15.0) The gateway's refund window for the payment's channel: days left, or closed (a bank transfer then). */
const windowCell = (r) => {
  if (r.refund_state === 'refunded') return r.partial ? '<span class="cell-sub">partial refund</span>' : '<span class="cell-sub">—</span>';
  if (r.refund_window_days == null) return `<span class="cell-sub">${r.provider === 'duitku' ? `no gateway refund: ${r.disbursement_available ? 'Disbursement or ' : ''}bank transfer` : 'not known'}</span>`;
  const left = r.refund_days_left;
  const head = left < 0 ? tag('t-crit', 'closed: bank transfer') : left <= 7 ? tag('t-warn', `${left} day${left === 1 ? '' : 's'} left`) : esc(`${left} days left`);
  return `${head}<div class="cell-sub">${esc(String(r.channel ?? 'QRIS').toUpperCase())} allows ${esc(String(r.refund_window_days))} days${r.partial ? ' · partial' : ''}</div>`;
};
/** (v1.15.0) The refund as the gateway's ledger has it (Finance's sync), and the fee the gateway keeps. */
const gatewayLine = (r) => {
  const bits = [];
  if (r.gateway_refund_status) bits.push(`at the gateway: ${esc(r.gateway_refund_status)}${r.gateway_refund_fee ? ` · refund fee ${esc(fmt.money(r.gateway_refund_fee, r.currency))}` : ''}`);
  if (r.fee_kept) bits.push(`the payment's fee (${esc(fmt.money(r.fee_kept, r.currency))}) is not returned`);
  return bits.length ? `<div class="cell-sub">${bits.join('<br>')}</div>` : '';
};

registerView('refunds', {
  title: 'Refunds',
  icon: 'card',
  group: 'finance',
  order: 3,
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
      <div class="section" data-requests style="margin-top:0"></div>
      <div data-note></div><div class="card" data-list></div>
      <div class="section" data-transfers></div>
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
          { label: 'Refund window', render: (r) => windowCell(r) },
          { label: 'Status', render: (r) => `${stateTag(r.refund_state)}${gatewayLine(r)}${r.refund_state === 'refunded' ? `<div class="cell-sub">${esc(r.refund_method === 'manual' ? 'bank transfer' : r.refund_method === 'disbursement' ? 'Duitku Disbursement' : 'provider')} · <span class="mono">${esc(r.refund_ref ?? '')}</span>${r.refunded_by_name ? ` · ${esc(r.refunded_by_name)}` : ''}</div>` : ''}${r.refund_error ? `<div class="cell-sub"${r.refund_method === 'disbursement' && r.refund_state === 'processing' ? '' : ' style="color:var(--crit)"'}>${esc(r.refund_error)}</div>` : ''}` },
          {
            label: '',
            render: (r) => {
              if (!canPay || r.refund_state === 'refunded') return '';
              // (v1.15.0) Duitku has no refund API: a transfer through Disbursement (two people), or a bank transfer.
              if (r.refund_state === 'processing' && r.refund_method === 'disbursement') return '<span class="cell-sub">see Transfers below</span>';
              const open = r.refund_state !== 'processing';
              // (v1.17.0) Xendit payments too: Xendit Payouts sends to a bank account when the payer's method cannot be refunded.
              const send = open && r.disbursement_available ? `<button class="btn sm${r.provider === 'duitku' ? ' primary' : ''}" type="button" data-disb="${esc(r.id)}">Send to bank account</button>` : '';
              const primary = r.provider === 'duitku' ? send
                : `${open ? `<button class="btn sm primary" type="button" data-pay="${esc(r.id)}">Refund via provider</button>` : ''}${send}`;
              return `<div class="row nowrap" style="gap:6px">${primary}<button class="btn sm" type="button" data-manual="${esc(r.id)}">Record bank transfer</button></div>`;
            },
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
        kpi('Window closing', fmt.num(s.closing_soon_count ?? 0), 'gateway refund window ends within 7 days', Number(s.closing_soon_count) ? 'warn' : ''),
        kpi('Failed', fmt.num(s.failed_count ?? 0), 'need a retry or a bank transfer', Number(s.failed_count) ? 'crit' : ''),
        kpi('Refunded, last 30 days', perCur(s, 'refunded_30d_minor'), 'paid back to drivers', 'ok'),
      ].join('');
      $('[data-note]', root).innerHTML = Number(s.due_count)
        ? callout('warn', `Drivers see "refund in progress" in the app until the refund is recorded here.${Number(s.closing_soon_count) ? ' Refunds whose gateway window closes soonest are listed first: after it closes, only a bank transfer is possible.' : ''}`)
        : '';
      draw();
    };

    // (v1.15.0) Refund transfers through Duitku Disbursement: requested by one person, approved by another.
    const XFER_TAG = {
      awaiting_approval: ['t-warn', 'awaiting approval'], sending: ['t-info', 'sending'], sent: ['t-info', 'sent, not confirmed'],
      succeeded: ['t-ok', 'paid'], failed: ['t-crit', 'failed'], rejected: ['t-mute', 'rejected'],
    };
    let transfers = [];
    const loadTransfers = async () => {
      const box = $('[data-transfers]', root);
      try { transfers = (await api('/v1/refund-transfers')).transfers ?? []; } catch { box.innerHTML = ''; return; }
      if (!transfers.length) { box.innerHTML = ''; return; }
      const me = state.me?.user?.id;
      const waiting = transfers.filter((t) => t.state === 'awaiting_approval').length;
      box.innerHTML = `<div class="section-head"><h2>Transfers to bank accounts</h2><div class="muted">Refunds paid to the driver's bank account through Duitku Disbursement or Xendit Payouts. Duitku checks the bank's name for the account first; a second person approves each transfer.</div></div>
        ${waiting ? callout('warn', `${fmt.num(waiting)} transfer${waiting === 1 ? '' : 's'} awaiting approval by someone other than the requester.`) : ''}
        <div class="card" data-xferlist></div>`;
      table($('[data-xferlist]', box), {
        columns: [
          { label: 'Requested', render: (t) => `${esc(fmt.time(t.requestedAt))}<div class="cell-sub">${esc(t.requestedByName ?? '—')}</div>` },
          { label: 'Amount', num: true, render: (t) => `<b>${esc(fmt.money(t.amount, t.currency))}</b>` },
          { label: 'Account', render: (t) => `<span class="mono">${esc(t.bankCode)} ${esc(t.accountMasked)}</span><div class="cell-sub">entered: ${esc(t.holderName)}</div>${t.rail === 'xendit' ? '<div class="cell-sub">Xendit Payouts · name not checked</div>' : `<div class="cell-sub">bank: ${esc(t.checkedName ?? '—')} ${t.checkedName ? (t.namesMatch ? tag('t-ok', 'names match') : tag('t-warn', 'names differ')) : ''}</div>`}` },
          { label: 'Status', render: (t) => `${tag(...(XFER_TAG[t.state] ?? ['t-mute', t.state]))}${t.approvedByName ? `<div class="cell-sub">approved by ${esc(t.approvedByName)}</div>` : ''}${t.reason ? `<div class="cell-sub">${esc(t.reason)}</div>` : ''}${t.error ? `<div class="cell-sub" style="color:var(--crit)">${esc(t.error)}</div>` : ''}` },
          {
            label: '',
            render: (t) => {
              if (!canPay) return '';
              if (t.state === 'awaiting_approval') {
                const mine = t.requestedBy && t.requestedBy === me;
                // (v1.21.0) Two approvers: after the first, the first approver cannot approve again.
                const first = t.firstApprovedBy && t.firstApprovedBy === me;
                const wait = mine ? 'needs another person' : first ? 'needs a second approver' : '';
                return `<div class="row nowrap" style="gap:6px">${t.firstApprovedBy ? tag('t-info', '1 of 2 approved') : ''}${wait ? `<span class="cell-sub">${wait}</span>` : `<button class="btn sm primary" type="button" data-approve="${esc(t.id)}">${t.firstApprovedBy ? 'Second approval and send' : 'Approve and send'}</button>`}<button class="btn sm" type="button" data-reject="${esc(t.id)}">${mine ? 'Withdraw' : 'Reject'}</button></div>`;
              }
              if (t.state === 'sent') return `<button class="btn sm" type="button" data-settle="${esc(t.id)}">Settle by hand</button>`;
              return '';
            },
          },
        ],
        rows: transfers,
        empty: '',
      });
    };
    $('[data-transfers]', root).addEventListener('click', async (ev) => {
      const ap = ev.target.closest('[data-approve]'), rj = ev.target.closest('[data-reject]'), st = ev.target.closest('[data-settle]');
      const t = transfers.find((x) => x.id === (ap ?? rj ?? st)?.dataset[ap ? 'approve' : rj ? 'reject' : 'settle']);
      if (!t) return;
      if (ap) {
        const ok = await confirmDialog({
          title: 'Approve and send the transfer',
          message: `Send ${fmt.money(t.amount, t.currency)} to ${t.checkedName ?? t.holderName} (${t.bankCode} ${t.accountMasked}) through ${t.rail === 'xendit' ? 'Xendit Payouts' : 'Duitku Disbursement'}?${t.rail === 'xendit' ? ' Xendit does not check the name: approve only if the account is the driver\'s.' : t.namesMatch ? '' : ` The bank names the account ${t.checkedName ?? '—'}, not ${t.holderName}: approve only if you are sure it is the driver's.`}`,
          confirmLabel: 'Approve and send',
        });
        if (!ok) return;
        try {
          const r = (await api(`/v1/refund-transfers/${t.id}/approve`, { method: 'POST' })).transfer;
          toast(r.state === 'awaiting_approval' ? 'First approval recorded: a second approver sends it' : r.state === 'succeeded' ? 'Paid: the refund is recorded' : r.state === 'sent' ? 'Sent; its result is checked automatically' : `Not paid: ${r.error ?? r.state}`, r.state === 'failed' ? 'crit' : 'ok');
        } catch (e) { toast(e.message, 'crit'); }
        load(); loadTransfers();
        return;
      }
      const settle = Boolean(st);
      modal({
        title: settle ? 'Settle a transfer by hand' : 'Reject the transfer',
        subtitle: `${fmt.money(t.amount, t.currency)} to ${t.checkedName ?? t.holderName}`,
        body: settle
          ? `${callout('warn', 'The gateway has not confirmed this transfer. Check it in its dashboard first: marking a paid transfer as not paid lets the refund be paid twice.')}
             <div class="form one" style="margin-top:12px">${field('Outcome', '<select name="outcome"><option value="succeeded">Paid (the dashboard shows success)</option><option value="failed">Not paid (the dashboard shows it failed)</option></select>')}${field('What the dashboard shows', '<input name="note" maxlength="300" autocomplete="off">')}</div>`
          : `<div class="form one">${field('Reason', '<input name="note" maxlength="300" autocomplete="off" placeholder="e.g. the bank names someone else">')}</div>`,
        actions: [
          { label: 'Cancel' },
          {
            label: settle ? 'Settle' : 'Reject', kind: settle ? 'primary' : 'danger',
            async onClick(ctx) {
              const note = $('[name="note"]', ctx.body).value.trim();
              if (!note) { $('[name="note"]', ctx.body).classList.add('invalid'); return false; }
              try {
                await api(`/v1/refund-transfers/${t.id}/${settle ? 'resolve' : 'reject'}`, { method: 'POST', body: settle ? { outcome: $('[name="outcome"]', ctx.body).value, note } : { reason: note } });
                toast(settle ? 'Settled' : 'Rejected: the refund is due again', 'ok');
                load(); loadTransfers();
              } catch (e) { toast(e.message, 'crit'); return false; }
            },
          },
        ],
      });
    });

    $('[data-list]', root).addEventListener('click', async (ev) => {
      const disb = ev.target.closest('[data-disb]');
      if (disb) {
        const r = rows.find((x) => x.id === disb.dataset.disb);
        modal({
          title: `Send the refund to a bank account (${r?.disbursement_rail === 'xendit' ? 'Xendit Payouts' : 'Duitku Disbursement'})`,
          subtitle: `${fmt.money(r?.refund_due_minor, r?.currency)} to ${r?.driver_phone ?? 'the payer'}`,
          body: `${callout('info', r?.disbursement_rail === 'xendit' ? 'Enter the driver\'s bank account (bank code e.g. 014 for BCA, or Xendit\'s ID_BCA). A second person then approves the transfer.' : 'Enter the driver\'s bank account. Duitku checks it and returns the name the bank has; a second person then approves the transfer.')}
            <div class="form" style="margin-top:12px">${field('Bank code', '<input name="bankCode" maxlength="12" autocomplete="off" placeholder="e.g. 014 (BCA)">')}${field('Account number', '<input name="accountNumber" inputmode="numeric" maxlength="24" autocomplete="off">')}</div>
            <div class="form one">${field('Account holder', '<input name="holderName" maxlength="120" autocomplete="off">')}</div>`,
          actions: [
            { label: 'Cancel' },
            {
              label: 'Check and request', kind: 'primary',
              async onClick(ctx) {
                const v = (n) => $(`[name="${n}"]`, ctx.body).value.trim();
                const body = { bankCode: v('bankCode'), accountNumber: v('accountNumber'), holderName: v('holderName') };
                if (!body.bankCode || !body.accountNumber || !body.holderName) { for (const k of Object.keys(body)) if (!body[k]) $(`[name="${k}"]`, ctx.body).classList.add('invalid'); return false; }
                try {
                  const t = (await api(`/v1/refunds/${disb.dataset.disb}/disbursement`, { method: 'POST', body })).transfer;
                  toast(t.rail === 'xendit' ? 'Requested. Awaiting approval by a second person.' : t.namesMatch ? `The bank names it ${t.checkedName}. Awaiting approval.` : `The bank names it ${t.checkedName ?? '—'}, not ${t.holderName}. Awaiting approval.`, t.rail === 'xendit' || t.namesMatch ? 'ok' : 'warn');
                  load(); loadTransfers();
                } catch (e) { toast(e.message, 'crit'); return false; }
              },
            },
          ],
        });
        return;
      }
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
    // (v1.24.0) Drivers' requests from the app's receipt: approved ones join the list below as due.
    const RQ = { pending: ['t-warn', 'waiting'], approved: ['t-ok', 'approved'], rejected: ['t-mute', 'rejected'], withdrawn: ['t-mute', 'withdrawn'] };
    const REASON = { unused_balance: 'Unused balance', charging_failed: 'Charging failed', overcharged: 'Overcharged', other: 'Other' };
    const loadRequests = async () => {
      const box = $('[data-requests]', root);
      let d;
      try { d = await api('/v1/finance/driver-refunds'); } catch { box.innerHTML = ''; return; }
      const pol = d.policy;
      box.innerHTML = `<div class="section-head"><h2>Driver requests</h2><div class="muted">Drivers ask from a charge's receipt in the app. ${pol.enabled ? (pol.autoApproveUpTo ? `Unused balance and failed charges up to ${esc(fmt.idr(pol.autoApproveUpTo))} are approved at once` : 'Every request is reviewed here') : 'Requests in the app are off'}; requests are taken within ${pol.windowDays} days of the payment. ${canPay ? '<button class="btn sm" type="button" data-rqpol>Policy</button>' : ''}</div></div><div class="card" data-rql></div>`;
      table($('[data-rql]', box), {
        columns: [
          { label: 'Asked', render: (q) => `${esc(fmt.ago(q.createdAt))}<div class="cell-sub">${esc(q.site ?? '')}</div>` },
          { label: 'Amount', num: true, render: (q) => `<b>${esc(fmt.money(q.amount, q.currency))}</b>${q.captured != null ? `<div class="cell-sub">of ${esc(fmt.money(q.captured, q.currency))} paid</div>` : ''}` },
          { label: 'Why', render: (q) => `${esc(REASON[q.reason] ?? q.reason)}${q.message ? `<div class="cell-sub wrap">${esc(q.message)}</div>` : ''}` },
          { label: 'Status', render: (q) => `${tag(...RQ[q.state])}${q.auto ? '<div class="cell-sub">by the policy</div>' : q.decidedBy ? `<div class="cell-sub">${esc(q.decidedBy)}</div>` : ''}${q.note && !q.auto ? `<div class="cell-sub wrap">${esc(q.note)}</div>` : ''}` },
          { label: '', render: (q) => (canPay && q.state === 'pending' ? `<div class="row nowrap" style="gap:6px"><button class="btn sm primary" type="button" data-rqok="${esc(q.id)}">Approve</button><button class="btn sm" type="button" data-rqno="${esc(q.id)}">Reject</button></div>` : '') },
        ],
        rows: d.requests, empty: 'No requests from drivers yet.',
      });
      $('[data-rqpol]', box)?.addEventListener('click', () => modal({ title: 'Driver refund policy',
        body: `<div class="form one"><label class="check"><input type="checkbox" name="on"${pol.enabled ? ' checked' : ''}><span>Drivers can ask for a refund in the app</span></label>
          ${field('Approve automatically up to (Rp)', `<input name="auto" inputmode="numeric" value="${pol.autoApproveUpTo}">`, { help: 'Unused balance and failed charges within what is left on the payment. 0: review every request.' })}
          ${field('Within (days of the payment)', `<input name="days" type="number" min="1" max="365" value="${pol.windowDays}">`)}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', async onClick(ctx) {
          try { await api('/v1/finance/driver-refunds/policy', { method: 'PUT', body: { enabled: $('[name="on"]', ctx.body).checked, autoApproveUpTo: Number($('[name="auto"]', ctx.body).value.replace(/\D/g, '') || 0), windowDays: Number($('[name="days"]', ctx.body).value) } }); toast('Saved', 'ok'); loadRequests(); } catch (e) { toast(e.message, 'crit'); return false; }
        } }] }));
      box.onclick = (ev) => {
        const ok = ev.target.closest('[data-rqok]'), no = ev.target.closest('[data-rqno]');
        const q = d.requests.find((x) => x.id === (ok ?? no)?.dataset[ok ? 'rqok' : 'rqno']);
        if (!q) return;
        modal({ title: ok ? 'Approve the request' : 'Reject the request', subtitle: `${REASON[q.reason]} · ${fmt.money(q.amount, q.currency)}`,
          body: `<div class="form one">${ok ? field(`Amount (${esc(q.currency)})`, `<input name="amount" inputmode="numeric" value="${q.amount}">`, { help: 'Up to what was asked. The refund then appears below as due.' }) : ''}
            ${field(ok ? 'Note' : 'Why (the driver sees it)', '<input name="note" maxlength="500">', ok ? { opt: true } : {})}</div>`,
          actions: [{ label: 'Cancel' }, { label: ok ? 'Approve' : 'Reject', kind: ok ? 'primary' : 'danger', async onClick(ctx) {
            const v = (n) => $(`[name="${n}"]`, ctx.body)?.value.trim();
            try {
              await api(`/v1/finance/driver-refunds/${q.id}/${ok ? 'approve' : 'reject'}`, { method: 'POST', body: { note: v('note') || undefined, amount: ok ? Number(v('amount').replace(/\D/g, '')) : undefined } });
              toast(ok ? 'Approved: the refund is due.' : 'Rejected.', 'ok'); loadRequests(); load();
            } catch (e) { toast(e.message, 'crit'); return false; }
          } }] });
      };
    };
    $('[data-state]', root).addEventListener('change', load);
    $('[data-refresh]', root).addEventListener('click', () => { load(); loadHolds(); loadTransfers(); loadRequests(); });
    await Promise.all([load(), loadHolds(), loadTransfers(), loadRequests()]);
  },
});
