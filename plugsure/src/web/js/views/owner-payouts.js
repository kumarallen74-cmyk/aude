import { $, esc, api, state, registerView, pageHead, table, tag, field, callout, kpi, toast, modal, fmt } from '../core.js';
import { CURRENCIES } from '../money.js';

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
      let q;
      try { [p, b, q] = await Promise.all([api('/v1/owner-portal/payouts'), api('/v1/owner-portal/bank'), api('/v1/owner-portal/queries')]); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const cur = Object.keys(p.totals)[0];
      const t = cur ? p.totals[cur] : { share: 0, paid: 0, outstanding: 0 };
      const rq = b.request;
      body.innerHTML = `<div class="grid k3">${kpi('Your share', esc(fmt.money(t.share, cur)), 'finalised statements')}${kpi('Paid', esc(fmt.money(t.paid, cur)), `recorded by ${esc(opName)}`)}${kpi('Still due', esc(fmt.money(t.outstanding, cur)), '', t.outstanding > 0 ? 'warn' : '')}</div>
        <div class="card section"><header><h3>By statement</h3></header><div data-st></div></div>
        <div class="card section"><header><h3>Your queries</h3></header><div data-q></div></div>
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
          { label: '', render: (s) => `<button class="btn sm" type="button" data-query="${esc(s.statementId)}">Query</button>` },
        ],
        rows: p.statements, empty: 'No finalised statements yet. Each month is finalised after it ends.',
      });
      // (v1.23.0) Queries on a statement, answered by the operator; an agreed adjustment comes on the next statement.
      const QS = { open: ['t-info', 'waiting'], rejected: ['t-mute', 'statement stands'], resolved: ['t-ok', 'answered'], adjusted: ['t-ok', 'adjusted'], withdrawn: ['t-mute', 'withdrawn'] };
      table($('[data-q]', body), {
        columns: [
          { label: 'Statement', render: (d) => `${esc(d.period)}<div class="cell-sub mono">${esc(d.statementNumber)}</div>` },
          { label: 'Your query', render: (d) => `${d.line ? `<b>${esc(d.line)}</b> · ` : ''}<span class="wrap">${esc(d.message)}</span>${d.claimed != null ? `<div class="cell-sub">claimed ${esc(fmt.money(d.claimed, d.currency))}</div>` : ''}` },
          { label: 'Answer', render: (d) => `${tag(...(QS[d.state] ?? ['t-mute', d.state]))}${d.answer ? `<div class="cell-sub wrap">${esc(d.answer)}</div>` : ''}${d.adjustment ? `<div class="cell-sub">${esc(fmt.money(d.adjustment.amount, d.currency))} ${d.adjustment.applied ? `on statement ${esc(d.adjustment.appliedTo ?? '')}` : 'on your next statement'}</div>` : ''}` },
          { label: '', render: (d) => (d.state === 'open' ? `<button class="btn sm" type="button" data-qw="${esc(d.id)}">Withdraw</button>` : '') },
        ],
        rows: q.disputes, empty: 'No queries. Something wrong on a statement? Use Query beside it.',
      });
      $('[data-q]', body).addEventListener('click', async (e) => {
        const w = e.target.closest('[data-qw]');
        if (!w) return;
        try { await api(`/v1/owner-portal/queries/${w.dataset.qw}/withdraw`, { method: 'POST' }); toast('Withdrawn.', 'ok'); draw(); } catch (err) { toast(err.message, 'crit'); }
      });
      $('[data-st]', body).addEventListener('click', (e) => {
        const qb = e.target.closest('[data-query]');
        if (!qb) return;
        const st = q.statements.find((x) => x.id === qb.dataset.query);
        if (!st) { toast('This statement cannot be queried.', 'warn'); return; }
        modal({ title: `Query statement ${st.number}`, subtitle: `${st.period} · ${opName} answers it`,
          body: `<div class="form">${field('About', `<select name="line"><option value="">The whole statement</option>${st.lines.map((l) => `<option>${esc(l)}</option>`).join('')}</select>`)}
            ${field(`Amount you believe is owed (${esc(st.currency)})`, '<input name="claimed" inputmode="decimal">', { opt: true })}
            ${field('What is wrong', '<textarea name="message" rows="4" maxlength="2000" placeholder="e.g. Two sessions on 12 September are missing for the lobby charger."></textarea>', { full: true })}</div>`,
          actions: [{ label: 'Cancel' }, { label: 'Send', kind: 'primary', async onClick(ctx) {
            const v = (n) => $(`[name="${n}"]`, ctx.body).value.trim();
            const exp = CURRENCIES[st.currency]?.exponent ?? 0;
            try {
              await api('/v1/owner-portal/queries', { method: 'POST', body: { statementId: st.id, line: v('line') || undefined, message: v('message'), claimed: v('claimed') ? Math.round(Number(v('claimed').replace(',', '.')) * 10 ** exp) : undefined } });
              toast(`Sent to ${opName}.`, 'ok'); draw();
            } catch (err) { toast(err.message, 'crit'); return false; }
          } }] });
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
