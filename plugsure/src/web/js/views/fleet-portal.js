import { $, $$, esc, api, state, registerView, pageHead, icon, callout, table, fmt, tag, kpi, confirmDialog, toast, isRupiah } from '../core.js';
import { monthLabel } from './statement-render.js';

/**
 * Fleet customer portal — what a company billed for fleet cards sees when its
 * staff sign in: what it owes, its invoices and credit notes (PDF), this month's
 * charging so far, and its cards, with a button to block a lost one.
 *
 * Shown only to users with the Fleet customer role (the console hides every
 * other page for them); the API checks the account on every call.
 */

const kwh = (wh) => fmt.num((Number(wh) || 0) / 1000, 1);
const open = (url) => window.open(url, '_blank', 'noopener');
/** Amounts per currency ({IDR: …, SGD: …}), one line each: never added across currencies. */
const multi = (o) => Object.keys(o ?? {}).some((c) => !isRupiah(c));
const perCur = (o) => Object.entries(o ?? {}).filter(([, v]) => v).map(([c, v]) => fmt.money(v, c)).join('<br>') || '—';
const SETTLE = (c) => (c.settlement === 'invoice' ? `taken off invoice ${c.invoiceNumber}`
  : c.settlement === 'refund' ? (c.refundedAt ? `refunded ${fmt.date(c.refundedAt)}` : 'to be refunded to you')
  : c.appliedInvoice ? `taken off invoice ${c.appliedInvoice}` : 'will be taken off your next invoice');

registerView('fleet-portal', {
  title: 'My fleet',
  icon: 'file',
  group: 'commercial',
  order: 1,
  perm: 'fleet:portal',
  fleetPortal: true,
  async render(root, [tabParam]) {
    const fleets = state.me?.fleets ?? [];
    let accountId = fleets[0]?.id;
    try { const saved = localStorage.getItem('ps-fleet'); if (fleets.some((f) => f.id === saved)) accountId = saved; } catch {}
    root.innerHTML = pageHead('My fleet', `Your charging with ${esc(state.me?.org?.name ?? 'us')}: what you owe, your invoices and credit notes, this month so far, and your cards.`,
      fleets.length > 1 ? `<select data-account aria-label="Fleet account">${fleets.map((f) => `<option value="${esc(f.id)}"${f.id === accountId ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</select>` : '')
      + `<div class="grid k4 section" data-kpis></div>
      <div class="tabs" role="tablist"><button type="button" data-tab="month">This month</button><button type="button" data-tab="invoices">Invoices</button><button type="button" data-tab="cards">Cards</button></div>
      <div data-body></div>`;
    const body = $('[data-body]', root);
    let current = ['month', 'invoices', 'cards'].includes(tabParam) ? tabParam : 'month';
    // The month's statement is per currency (an account charging in Indonesia and Singapore has two).
    let currencies = [];
    let cur = null;
    const curQ = () => (cur && !isRupiah(cur) ? `?currency=${cur}` : '');

    const kpis = async () => {
      const { accounts } = await api('/v1/fleet-portal');
      const a = accounts.find((x) => x.id === accountId) ?? accounts[0];
      if (!a) { $('[data-kpis]', root).innerHTML = ''; return; }
      currencies = a.currencies ?? [];
      if (!currencies.includes(cur)) cur = currencies[0] ?? null;
      const st = await api(`/v1/fleet-portal/${a.id}/statement${curQ()}`).catch(() => null);
      $('[data-kpis]', root).innerHTML = [
        kpi('You owe', multi(a.outstandingByCurrency) ? perCur(a.outstandingByCurrency) : fmt.idr(a.outstandingMinor), a.overdueInvoices ? `${a.overdueInvoices} invoice(s) overdue` : 'on issued invoices', a.overdueInvoices ? 'crit' : ''),
        kpi(`${monthLabel(a.period)} so far`, st ? fmt.money(st.totals.totalMinor, st.currency) : '—',
          st ? `${fmt.num(st.totals.sessions)} sessions · ${kwh(st.totals.energyWh)} kWh${st.totals.roamingSessions ? ` · ${fmt.num(st.totals.roamingSessions)} on partner networks` : ''}` : ''),
        kpi('Cards', fmt.num(a.cards), a.blockedCards ? `${a.blockedCards} blocked` : 'all active'),
        kpi('Credit to come', multi(a.creditToComeByCurrency) ? perCur(a.creditToComeByCurrency) : a.creditToComeMinor ? fmt.idr(a.creditToComeMinor) : '—', a.creditToComeMinor || multi(a.creditToComeByCurrency) ? 'off your next invoice' : 'nothing waiting'),
      ].join('');
    };

    const drawMonth = async () => {
      const st = await api(`/v1/fleet-portal/${accountId}/statement${curQ()}`);
      const t = st.totals;
      const id = isRupiah(st.currency);
      const m = (n) => fmt.money(n, st.currency);
      body.innerHTML = `${currencies.length > 1 ? `<div class="row" style="gap:6px;margin-bottom:8px">${currencies.map((c) => `<button type="button" class="btn sm${c === cur ? ' primary' : ''}" data-cur="${esc(c)}">${esc(c)}</button>`).join('')}<span class="cell-sub">one statement per currency</span></div>` : ''}
        ${callout('info', `${esc(st.periodLabel)} so far. Figures change until the month ends and we issue the invoice.`)}
        <div class="card section" data-sites></div>
        ${st.roaming.length ? '<div class="card section"><header><h3>On partner networks</h3></header><div class="cell-sub" style="padding:0 16px 8px">Charged by other operators and passed on at the amount they billed.</div><div data-roaming></div></div>' : ''}
        <div class="card section"><header><h3>By card</h3></header><div data-cards></div></div>
        <p class="cell-sub">${fmt.num(t.sessions)} sessions · ${kwh(t.energyWh)} kWh · ${m(t.totalMinor)} including ${id ? 'PBJT-TL and PPN' : 'tax'}${t.roamingSessions ? `, of which ${m(t.roamingMinor)} on partner networks` : ''}. Each session also has its own receipt.</p>`;
      table($('[data-sites]', body), {
        columns: [
          { label: 'Where', render: (l) => `<div class="cell-title">${esc(l.siteName)}</div>` },
          { label: 'Sessions', num: true, render: (l) => fmt.num(l.sessions) },
          { label: 'kWh', num: true, render: (l) => kwh(l.energyWh) },
          { label: id ? 'PPN' : 'Tax', num: true, render: (l) => m(l.taxMinor) },
          { label: 'Amount', num: true, render: (l) => `<b>${m(l.totalMinor)}</b>` },
        ],
        rows: st.sites,
        empty: st.roaming.length ? 'No charging at our stations this month.' : 'No charging this month yet.',
      });
      if (st.roaming.length) {
        table($('[data-roaming]', body), {
          columns: [
            { label: 'When', render: (x) => `<span class="nowrap">${esc(fmt.time(x.startedAt))}</span>` },
            { label: 'Operator', render: (x) => `<div class="cell-title">${esc(x.operator)}</div>${x.location ? `<div class="cell-sub">${esc(x.location)}</div>` : ''}` },
            { label: 'Card', render: (x) => `<span class="mono">${esc(x.cardUid)}</span>` },
            { label: 'kWh', num: true, render: (x) => fmt.num(x.energyKwh, 1) },
            { label: 'Amount', num: true, render: (x) => m(x.amountMinor) },
          ],
          rows: st.roaming,
        });
      }
      table($('[data-cards]', body), {
        columns: [
          { label: 'Card', render: (c) => `<span class="mono">${esc(c.uid)}</span>${c.holder ? `<div class="cell-sub">${esc(c.holder)}</div>` : ''}` },
          { label: 'Sessions', num: true, render: (c) => fmt.num(c.sessions) },
          { label: 'kWh', num: true, render: (c) => kwh(c.energyWh) },
          { label: 'Amount', num: true, render: (c) => m(c.totalMinor + c.roamingMinor) },
        ],
        rows: st.cards,
        empty: 'No card used yet this month.',
      });
      $$('[data-cur]', body).forEach((b) => b.addEventListener('click', () => { cur = b.dataset.cur; drawMonth(); kpis(); }));
    };

    const drawInvoices = async () => {
      const { invoices, creditNotes } = await api(`/v1/fleet-portal/${accountId}/invoices`);
      body.innerHTML = `<div class="card section"><header><h3>Invoices</h3></header><div data-inv></div></div>
        <div class="card section"><header><h3>Credit notes</h3></header><div data-cn></div></div>`;
      table($('[data-inv]', body), {
        columns: [
          { label: 'Invoice', render: (i) => `<span class="mono">${esc(i.number)}</span><div class="cell-sub">${esc(monthLabel(i.period))}</div>` },
          { label: 'Status', render: (i) => (i.status === 'paid' ? tag('t-ok', 'paid') : i.overdue ? tag('t-crit', 'overdue') : tag('t-warn', 'to pay')) },
          { label: 'Total', num: true, render: (i) => fmt.money(i.totalMinor, i.currency) },
          { label: 'You owe', num: true, render: (i) => (i.status === 'issued' ? `<b>${fmt.money(i.balanceMinor, i.currency)}</b>${i.creditedMinor ? `<div class="cell-sub">after ${fmt.money(i.creditedMinor, i.currency)} credit</div>` : ''}` : '—') },
          { label: 'Due', render: (i) => esc(fmt.date(i.dueDate)) },
          { label: '', render: (i) => `<div class="row" style="gap:4px;justify-content:flex-end"><button class="btn sm" type="button" data-pdf="${esc(i.id)}">${icon('download')} PDF</button><button class="btn sm ghost" type="button" data-csv="${esc(i.id)}">Sessions</button></div>` },
        ],
        rows: invoices,
        empty: 'No invoices yet. We invoice each month after it ends.',
      });
      table($('[data-cn]', body), {
        columns: [
          { label: 'Credit note', render: (c) => `<span class="mono">${esc(c.number)}</span><div class="cell-sub">${esc(fmt.date(c.issuedAt))}</div>` },
          { label: 'For', render: (c) => `<div class="cell-sub wrap">${esc(c.reason)}</div><div class="cell-sub">invoice <span class="mono">${esc(c.invoiceNumber)}</span></div>` },
          { label: 'Credited', num: true, render: (c) => `<b>${fmt.money(c.totalMinor, c.currency)}</b>` },
          { label: 'How', render: (c) => esc(SETTLE(c)) },
          { label: '', render: (c) => `<button class="btn sm" type="button" data-cn="${esc(c.id)}">${icon('download')} PDF</button>` },
        ],
        rows: creditNotes,
        empty: 'No credit notes.',
      });
      $$('[data-pdf]', body).forEach((b) => b.addEventListener('click', () => open(`/v1/fleet-portal/${accountId}/invoices/${b.dataset.pdf}/invoice.pdf`)));
      $$('[data-csv]', body).forEach((b) => b.addEventListener('click', () => open(`/v1/fleet-portal/${accountId}/invoices/${b.dataset.csv}/invoice.csv`)));
      $$('[data-cn]', body).forEach((b) => b.addEventListener('click', () => open(`/v1/fleet-portal/${accountId}/credit-notes/${b.dataset.cn}/credit-note.pdf`)));
    };

    const drawCards = async () => {
      const { cards } = await api(`/v1/fleet-portal/${accountId}/cards`);
      body.innerHTML = `<p class="cell-sub">Lost a card? Block it here and it stops working at once, at our chargers and on partner networks. You can unblock a card you blocked; a card we blocked needs us.</p><div class="card section" data-list></div>`;
      table($('[data-list]', body), {
        columns: [
          { label: 'Card', render: (c) => `<span class="mono">${esc(c.uid)}</span>${c.holder ? `<div class="cell-sub">${esc(c.holder)}</div>` : ''}` },
          { label: 'Status', render: (c) => (c.status === 'Accepted' ? tag('t-ok', 'active') : c.blockedByYou ? tag('t-warn', 'blocked by you') : tag('t-mute', c.status.toLowerCase())) },
          { label: 'This month', num: true, render: (c) => (c.thisMonth.sessions ? `${fmt.num(c.thisMonth.sessions)} · ${kwh(c.thisMonth.energyWh)} kWh<div class="cell-sub">${multi(c.thisMonth.byCurrency) ? perCur(c.thisMonth.byCurrency) : fmt.idr(c.thisMonth.totalMinor)}</div>` : '—') },
          { label: 'Last used', render: (c) => (c.lastUsed ? esc(fmt.ago(c.lastUsed)) : '—') },
          { label: '', render: (c) => (c.canBlock ? `<button class="btn sm danger" type="button" data-block="${esc(c.id)}">Block</button>` : c.canUnblock ? `<button class="btn sm" type="button" data-unblock="${esc(c.id)}">Unblock</button>` : '') },
        ],
        rows: cards,
        empty: 'No cards on this account.',
      });
      const act = async (id, blocked) => {
        const c = cards.find((x) => x.id === id);
        const ok = await confirmDialog({
          title: blocked ? `Block card ${c.uid}?` : `Unblock card ${c.uid}?`,
          message: blocked ? 'It stops working at once. You can unblock it again here.' : 'It works again at once.',
          confirmLabel: blocked ? 'Block card' : 'Unblock', danger: blocked,
        });
        if (!ok) return;
        try { await api(`/v1/fleet-portal/${accountId}/cards/${id}/block`, { method: 'POST', body: { blocked } }); toast(blocked ? 'Card blocked' : 'Card unblocked', 'ok'); drawCards(); kpis(); }
        catch (e) { toast(e.message, 'crit'); }
      };
      $$('[data-block]', body).forEach((b) => b.addEventListener('click', () => act(b.dataset.block, true)));
      $$('[data-unblock]', body).forEach((b) => b.addEventListener('click', () => act(b.dataset.unblock, false)));
    };

    const show = async (t) => {
      current = t;
      $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
      history.replaceState(null, '', `#/fleet-portal/${t}`);
      try { await ({ month: drawMonth, invoices: drawInvoices, cards: drawCards }[t])(); }
      catch (e) { body.innerHTML = callout('crit', esc(e.message)); }
    };
    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    $('[data-account]', root)?.addEventListener('change', (e) => {
      accountId = e.target.value;
      try { localStorage.setItem('ps-fleet', accountId); } catch {}
      cur = null;
      kpis().catch(() => {}).then(() => show(current));
    });
    if (!accountId) { body.innerHTML = callout('warn', 'This sign-in is not linked to a fleet account. Ask your charging operator.'); return; }
    // The KPIs first: they learn the account's currencies, which the month tab offers.
    await kpis().catch(() => {});
    await show(current);
  },
});
