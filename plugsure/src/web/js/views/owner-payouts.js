import { $, esc, api, state, registerView, pageHead, table, tag, field, callout, kpi, toast, modal, fmt } from '../core.js';

/**
 * Payouts (v1.19.0), in the Site Owner portal only: what the operator recorded as paid against each of the owner's
 * finalised statements and what is still due; the bank account on file (masked), and a request to change it, which
 * the operator approves before anything changes. Every value from the API is escaped.
 */

const STATUS = { paid: ['t-ok', 'paid'], partial: ['t-info', 'part-paid'], due: ['t-warn', 'due'], nothing: ['t-mute', 'no share'] };

registerView('owner-payouts', {
  title: 'Payouts',
  icon: 'chart',
  group: 'commercial',
  order: 27,
  // Owner portal users only (the server resolves the owner from the sign-in); no operator permission is needed.
  portal: true,
  when: () => (state.me?.owners?.length ?? 0) > 0,
  async render(root) {
    const owner = state.me.owners[0];
    const opName = state.me.org?.name ?? 'the operator';
    root.innerHTML = pageHead('Your payouts', `What ${esc(opName)} has paid ${esc(owner.legal_name || owner.name)} against each monthly statement, what is still due, and the bank account payouts go to.`, '')
      + '<div data-body><div class="empty-state"><span class="spinner"></span></div></div>';
    const body = $('[data-body]', root);
    const draw = async () => {
      let p, b;
      try { [p, b] = await Promise.all([api('/v1/owner-portal/payouts'), api('/v1/owner-portal/bank')]); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const cur = Object.keys(p.totals)[0];
      const t = cur ? p.totals[cur] : { share: 0, paid: 0, outstanding: 0 };
      const rq = b.request;
      body.innerHTML = `<div class="grid k3">${kpi('Your share', esc(fmt.money(t.share, cur)), 'finalised statements')}${kpi('Paid', esc(fmt.money(t.paid, cur)), `recorded by ${esc(opName)}`)}${kpi('Still due', esc(fmt.money(t.outstanding, cur)), '', t.outstanding > 0 ? 'warn' : '')}</div>
        <div class="card section"><header><h3>By statement</h3></header><div data-st></div></div>
        <div class="card section"><header><h3>Bank account</h3>${rq?.state === 'pending' ? '' : '<button class="btn sm right" type="button" data-change>Request a change</button>'}</header><div class="body">
          ${b.onFile ? `<p style="margin-top:0"><b>${esc(b.onFile.bankName)}</b> ${b.onFile.bankCode ? `<span class="mono">${esc(b.onFile.bankCode)}</span> ` : ''}<span class="mono">${esc(b.onFile.accountMasked)}</span> · ${esc(b.onFile.holderName)}</p>`
            : `<p style="margin-top:0">${esc(opName)} has no bank account on file for you yet.</p>`}
          ${rq?.state === 'pending' ? callout('info', `Your change to <b>${esc(rq.bankName)} ${esc(rq.accountMasked)}</b> (${esc(rq.holderName)}) is waiting for ${esc(opName)}: payouts keep going to the account above until it is approved. <button class="btn sm" type="button" data-withdraw="${esc(rq.id)}">Withdraw</button>`)
            : rq?.state === 'rejected' ? callout('warn', `Your last change (${esc(rq.bankName)} ${esc(rq.accountMasked)}) was not approved${rq.decisionNote ? `: ${esc(rq.decisionNote)}` : ''}.`)
            : rq?.state === 'approved' ? `<p class="cell-sub">Changed on ${esc(fmt.time(rq.decidedAt))}.</p>` : ''}
          <p class="cell-sub">${esc(opName)} confirms every change with you before approving it.</p></div></div>`;
      table($('[data-st]', body), {
        columns: [
          { label: 'Month', render: (s) => `${esc(s.period)}<div class="cell-sub mono">${esc(s.number)}</div>` },
          { label: 'Your share', num: true, render: (s) => esc(fmt.money(s.share, s.currency)) },
          { label: 'Paid', num: true, render: (s) => `${esc(fmt.money(s.paid, s.currency))}${s.payments.map((x) => `<div class="cell-sub">${esc(x.paidOn ?? '')} · ${esc(fmt.money(x.amount, x.currency))}${x.reference ? ` · ${esc(x.reference)}` : ''}</div>`).join('')}` },
          { label: 'Still due', num: true, render: (s) => `<b>${esc(fmt.money(s.outstanding, s.currency))}</b>` },
          { label: 'Status', render: (s) => tag(...(STATUS[s.status] ?? ['t-mute', s.status])) },
        ],
        rows: p.statements, empty: 'No finalised statements yet. Each month is finalised after it ends.',
      });
      $('[data-withdraw]', body)?.addEventListener('click', async (e) => {
        try { await api(`/v1/owner-portal/bank/change-request/${e.currentTarget.dataset.withdraw}/withdraw`, { method: 'POST' }); toast('Withdrawn.', 'ok'); draw(); } catch (err) { toast(err.message, 'crit'); }
      });
      $('[data-change]', body)?.addEventListener('click', () => modal({
        title: 'Request a new bank account', subtitle: `${opName} confirms it with you before payouts go there`,
        body: `<div class="form">${field('Bank', '<input name="bankName" maxlength="80" placeholder="BCA, Mandiri, BRI…">')}${field('Bank code', '<input name="bankCode" maxlength="12" placeholder="014" inputmode="numeric">', { opt: true })}
          ${field('Account holder (as the bank has it)', '<input name="holderName" maxlength="120">')}${field('Account number', '<input name="accountNumber" inputmode="numeric" autocomplete="off" maxlength="24">')}
          ${field('Note', '<input name="note" maxlength="300">', { opt: true })}</div>`,
        actions: [{ label: 'Cancel' }, {
          label: 'Send to ' + opName, kind: 'primary',
          async onClick(ctx) {
            const v = (n) => $(`[name="${n}"]`, ctx.body).value.trim();
            try {
              await api('/v1/owner-portal/bank/change-request', { method: 'POST', body: { bankName: v('bankName'), bankCode: v('bankCode') || undefined, holderName: v('holderName'), accountNumber: v('accountNumber'), note: v('note') || undefined } });
              toast(`Sent. ${opName} will confirm it with you.`, 'ok');
              draw();
            } catch (err) { toast(err.message, 'crit'); return false; }
          },
        }],
      }));
    };
    await draw();
  },
});
