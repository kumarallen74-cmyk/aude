import { $, esc, api, state, registerView, pageHead, icon, field, callout, table, fmt, tag } from '../core.js';
import { renderStatement, recentMonths, monthLabel } from './statement-render.js';

/**
 * Statements — what the organisation owes the platform each month: commission
 * on public charging (on the session subtotal, excluding PBJT and PPN), the
 * per-charger minimum, and platform fees for private chargers. Read-only here;
 * rates are set by the platform operator.
 */

registerView('statements', {
  title: 'Statements',
  icon: 'list',
  group: 'commercial',
  order: 26,
  perm: 'invoice:read',
  // Also shown in the Site Owner portal (read-only, the owner's own sites).
  portal: true,
  async render(root, [initial]) {
    const owner = state.me?.owners?.[0];
    root.innerHTML = pageHead(
      owner ? 'Your statements' : 'Platform statements',
      owner
        ? `Your chargers' monthly charging units and amounts, and how the commission base (what drivers paid, excluding PBJT-TL and PPN) is shared between ${esc(owner.legal_name || owner.name)} and ${esc(state.me.org?.name ?? 'the operator')}. The current month is a draft until it ends and is finalised.`
        : 'What the platform charges each month: commission on public charging (on the session subtotal, excluding PBJT-TL and PPN), the minimum per charger, and platform fees for private chargers. The current month is a draft until it ends and is finalised.',
      `<button class="btn" type="button" data-csv>${icon('download')} CSV</button><button class="btn" type="button" data-print>${icon('download')} Print / PDF</button>`,
    ) + `<div class="filters">${field('Month', '<select data-month></select>')}${field('Currency', '<select data-cur></select>', { attrs: 'data-cur-field hidden' })}</div><div data-body></div><div class="card section" data-history></div>`;

    let first = true;
    // One statement per currency (§D9); the currency switch shows when the organisation has sites in several.
    let cur = null;
    const qOf = (month) => { const p = new URLSearchParams(); if (month) p.set('month', month); if (cur) p.set('currency', cur); return p.toString() ? `?${p}` : ''; };
    const load = async (month) => {
      const q = qOf(month);
      let st;
      try { st = await api(`/v1/billing/statement${q}`); } catch (e) {
        $('[data-body]', root).innerHTML = callout('crit', esc(e.status === 403 ? 'Statements need organisation-wide invoice access.' : e.message));
        return;
      }
      if (first) {
        first = false;
        $('[data-month]', root).innerHTML = recentMonths(st.period).map((m) => `<option value="${m}">${esc(monthLabel(m))}</option>`).join('');
      }
      $('[data-month]', root).value = st.period;
      cur = st.currency ?? cur;
      $('[data-cur-field]', root).hidden = (st.currencies ?? []).length < 2;
      $('[data-cur]', root).innerHTML = (st.currencies ?? []).map((c) => `<option value="${esc(c)}"${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('');
      history.replaceState(null, '', `#/statements/${st.period}`);
      renderStatement($('[data-body]', root), st, { ownerView: !!owner });
      table($('[data-history]', root), {
        columns: [
          { label: 'Finalised statements', render: (h) => `<div class="cell-title">${esc(monthLabel(h.period))}</div><div class="cell-sub mono">${esc(h.number)}</div>` },
          { label: 'Commission base', num: true, render: (h) => fmt.money(h.gtv_minor, h.currency) },
          { label: 'Fee before tax', num: true, render: (h) => fmt.money(h.net_minor, h.currency) },
          { label: 'Total due', num: true, render: (h) => `<b>${fmt.money(h.total_minor, h.currency)}</b>` },
          { label: '', render: (h) => tag('t-ok', 'final') },
        ],
        rows: st.history ?? [],
        empty: owner ? 'No finalised statements yet. Each month is finalised after it ends.' : 'No finalised statements yet. Each month is finalised by the platform operator after it ends.',
        onRow: (h) => load(h.period),
      });
    };
    $('[data-month]', root).addEventListener('change', (e) => load(e.target.value));
    $('[data-cur]', root).addEventListener('change', (e) => { cur = e.target.value; load($('[data-month]', root).value); });
    $('[data-csv]', root).addEventListener('click', () => { location.href = `/v1/billing/statement.csv${qOf($('[data-month]', root).value)}`; });
    $('[data-print]', root).addEventListener('click', () => window.open(`/v1/billing/statement.html${qOf($('[data-month]', root).value)}`, '_blank', 'noopener'));
    await load(initial && /^\d{4}-\d{2}$/.test(initial) ? initial : null);
  },
});
