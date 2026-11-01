import { $, esc, api, state, registerView, pageHead, callout, fmt, toast, modal, field } from '../core.js';
import { LEGACY_CURRENCY } from '../money.js';

/**
 * (v1.26.0) Finance today: a phone-first page. Today's and the month's figures, and every approval waiting, decided
 * here with the same rules as in Finance (two people, the approvals matrix).
 */

const KIND = { payout_transfer: 'Owner payout', refund_transfer: 'Refund transfer', write_off: 'Write-off', bank_change: 'Bank details', driver_refund: 'Driver refund' };

registerView('finance-today', {
  title: 'Finance today',
  subtitle: 'Figures and approvals, for the phone',
  icon: 'chart',
  group: 'commercial',
  order: 23,
  perm: 'payment:read',
  async render(root) {
    root.innerHTML = pageHead('Finance today', 'Today\'s takings, the month so far, and what is waiting for you to approve.', '') + '<div data-ft><div class="empty-state"><span class="spinner"></span></div></div>';
    const host = $('[data-ft]', root);
    const canWrite = state.can('payment:write');
    const load = async () => {
      let t;
      try { t = await api('/v1/finance/today'); } catch (e) { host.innerHTML = callout('crit', esc(e.message)); return; }
      const tile = (label, value, foot = '', tone = '') => `<div class="card kpi"${tone ? ` style="border-color:var(--${tone})"` : ''}><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="foot">${esc(foot)}</div></div>`;
      const today = t.today.length ? t.today : [{ currency: t.month[0]?.currency ?? LEGACY_CURRENCY, revenue: 0, sessions: 0, kwh: 0 }];
      host.innerHTML = `
        <div class="ft-grid">${today.map((d) => tile(`Today${t.today.length > 1 ? ` · ${d.currency}` : ''}`, fmt.money(d.revenue, d.currency), `${d.sessions} sessions · ${fmt.num(d.kwh)} kWh`)).join('')}
          ${t.month.map((m) => tile(`Month to date${t.month.length > 1 ? ` · ${m.currency}` : ''}`, fmt.money(m.revenue, m.currency), m.vsLastMonthPct == null ? '' : `${m.vsLastMonthPct >= 0 ? '+' : ''}${m.vsLastMonthPct}% vs last month`)).join('')}
          ${t.month.map((m) => tile(`Cash${t.month.length > 1 ? ` · ${m.currency}` : ''}`, fmt.money((m.cash.gateways ?? 0) + (m.cash.bank ?? 0), m.currency), m.cash.bankAsOf ? `bank as of ${m.cash.bankAsOf}` : 'gateways')).join('')}
          ${t.month.map((m) => tile(`Owed to you${t.month.length > 1 ? ` · ${m.currency}` : ''}`, fmt.money(m.receivables, m.currency), m.dso == null ? '' : `DSO ${m.dso} days`)).join('')}</div>
        <div class="card section"><header><h3>Waiting for approval</h3><span class="right">${t.waiting ? `<span class="tag t-warn">${t.waiting} for you</span>` : ''}</span></header>
          <div class="ft-list">${t.approvals.length ? t.approvals.map((a, i) => `
            <div class="ft-item">
              <div class="ft-head"><span class="cell-sub">${esc(KIND[a.kind] ?? a.kind)}</span><span class="cell-sub">${esc(fmt.ago(a.at))}</span></div>
              <div class="cell-title">${esc(a.title)}</div>
              ${a.amount != null ? `<div class="ft-amount">${esc(fmt.money(a.amount, a.currency))}</div>` : ''}
              ${a.detail ? `<div class="cell-sub wrap">${esc(a.detail)}</div>` : ''}
              <div class="cell-sub">Asked by ${esc(a.requestedBy ?? '—')}${a.firstApprovedBy ? ` · first approval ${esc(a.firstApprovedBy)}` : ''}</div>
              ${canWrite && a.canDecide ? `<div class="ft-actions"><button class="btn primary" type="button" data-ok="${i}">Approve</button><button class="btn" type="button" data-no="${i}">Reject</button></div>`
                : `<div class="cell-sub" style="margin-top:6px">${a.mine ? 'You asked for this: someone else approves it.' : canWrite ? 'You already gave the first approval.' : 'View only.'}</div>`}
            </div>`).join('') : '<div class="empty-state" style="padding:18px">Nothing is waiting. 🎉</div>'}</div></div>
        <div class="card section" data-dg><header><h3>Your digest</h3></header><div class="body"><span class="spinner"></span></div></div>`;
      api('/v1/finance/digest').then((d) => {
        const c = $('[data-dg]', host); if (!c) return;
        const sub = d.subscription;
        const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        c.innerHTML = `<header><h3>Your digest</h3></header><div class="body"><p class="cell-sub" style="margin-top:0">These figures and approvals, sent to you every day or week.</p><div class="form">
          ${field('How often', `<select name="dq">${[['off', 'Off'], ['daily', 'Every day'], ['weekly', 'Every week']].map(([v, l]) => `<option value="${v}"${sub.frequency === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}
          ${field('At (hour)', `<input name="dh" type="number" min="0" max="23" value="${sub.hour}">`)}
          ${field('On (weekly)', `<select name="dw">${days.map((x, i) => `<option value="${i + 1}"${sub.weekday === i + 1 ? ' selected' : ''}>${x}</option>`).join('')}</select>`)}
          <label class="check"><input type="checkbox" name="de"${sub.channels.includes('email') ? ' checked' : ''}><span>E-mail</span></label>
          <label class="check"><input type="checkbox" name="dwa"${sub.channels.includes('whatsapp') ? ' checked' : ''}${d.organisation.whatsappTemplate ? '' : ' disabled'}><span>WhatsApp${d.organisation.whatsappTemplate ? '' : ' (no template set in Finance → Settings)'}</span></label>
          ${field('WhatsApp number', `<input name="dp" inputmode="tel" value="${esc(sub.phone ?? '')}" placeholder="62811…">`)}</div>
          <div class="ft-actions"><button class="btn primary" type="button" data-dsave>Save</button><button class="btn" type="button" data-dsend>Send me one now</button></div>
          ${sub.lastSentAt ? `<p class="cell-sub">Last sent ${esc(fmt.ago(sub.lastSentAt))}.</p>` : ''}</div>`;
        const v = (n) => $(`[name="${n}"]`, c);
        $('[data-dsave]', c).addEventListener('click', async () => {
          const channels = [v('de').checked ? 'email' : null, v('dwa').checked ? 'whatsapp' : null].filter(Boolean);
          try { await api('/v1/finance/digest', { method: 'PUT', body: { frequency: v('dq').value, hour: Number(v('dh').value), weekday: Number(v('dw').value), channels: channels.length ? channels : ['email'], phone: v('dp').value.trim() || undefined } }); toast('Saved.', 'ok'); } catch (e) { toast(e.message, 'crit'); }
        });
        $('[data-dsend]', c).addEventListener('click', async (ev) => {
          ev.currentTarget.disabled = true;
          try { const r = await api('/v1/finance/digest/send', { method: 'POST' }); const bad = r.results.filter((x) => !x.ok); toast(bad.length ? bad.map((x) => `${x.channel}: ${x.error}`).join('; ') : 'Sent.', bad.length ? 'warn' : 'ok'); } catch (e) { toast(e.message, 'crit'); }
          ev.currentTarget.disabled = false;
        });
      }).catch(() => { const c = $('[data-dg]', host); if (c) c.remove(); });
      host.querySelectorAll('[data-ok]').forEach((b) => b.addEventListener('click', async () => {
        const a = t.approvals[Number(b.dataset.ok)];
        b.disabled = true;
        try { await api(a.approve, { method: 'POST', body: {} }); toast('Approved.', 'ok'); load(); } catch (e) { toast(e.message, 'crit'); b.disabled = false; }
      }));
      host.querySelectorAll('[data-no]').forEach((b) => b.addEventListener('click', () => {
        const a = t.approvals[Number(b.dataset.no)];
        modal({ title: 'Reject', subtitle: a.title, body: field('Why', '<textarea name="why" rows="3"></textarea>'),
          actions: [{ label: 'Cancel' }, { label: 'Reject', kind: 'danger', async onClick(mc) {
            const why = $('[name="why"]', mc.el).value.trim();
            try { await api(a.reject, { method: 'POST', body: { reason: why, note: why } }); toast('Rejected.', 'ok'); load(); } catch (e) { toast(e.message, 'crit'); return false; }
          } }] });
      }));
    };
    await load();
  },
});
