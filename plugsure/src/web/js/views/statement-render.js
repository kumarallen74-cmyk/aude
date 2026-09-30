import { $, esc, table, tag, fmt, kpi, callout, drawer } from '../core.js';

/**
 * Renders a platform commission & fee statement (the customer's view and the
 * platform operator's view share this). Not a view itself.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = (p) => { const [y, m] = String(p).split('-'); return `${MONTHS[Number(m) - 1]} ${y}`; };
const pct = (bps) => (bps == null ? '—' : `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`);

/** The last `n` months, newest first, as YYYY-MM, starting from `current`. */
export function recentMonths(current, n = 13) {
  let [y, m] = current.split('-').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (--m === 0) { m = 12; y--; }
  }
  return out;
}

export function planText(plan) {
  const tiers = plan.tiers.map((t) => `${t.name} ${t.upToIdr ? `below ${fmt.idr(t.upToIdr)}` : 'above'}: ${pct(t.rateBps)}`).join(' · ');
  return `${tiers} (${plan.tierMode === 'whole' ? 'whole month at the tier reached' : 'each band at its own rate'}, per site). ` +
    `Minimum per charger ${fmt.idr(plan.minPerChargerAcIdr)} AC / ${fmt.idr(plan.minPerChargerDcIdr)} DC. ` +
    `Private chargers ${fmt.idr(plan.privateFeeAcIdr)} AC / ${fmt.idr(plan.privateFeeDcIdr)} DC per month. ` +
    `Payment processing (MDR) ${plan.mdrBorneBy === 'platform' ? 'covered by the commission' : 'borne by the site owner'}.`;
}

/**
 * opts.ownerView  the viewer IS the owner ("Your share"); otherwise, on an owner
 *                 statement, the operator's view ("Owner share").
 */
export function renderStatement(box, st, opts = {}) {
  const t = st.totals;
  const isOwner = !!st.owner && t.ownerShareIdr != null;
  const ownerLabel = opts.ownerView ? 'Your share' : 'Owner share';
  const opName = st.owner ? (st.issuer?.name || 'Operator') : 'Platform';
  box.innerHTML = `
    <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
      ${st.status === 'final' ? tag('t-ok', `final · ${st.number}`) : tag('t-info', st.projected ? 'draft · projected to month end' : 'draft')}
      <span class="cell-sub">${esc(monthLabel(st.period))} · ${esc(st.billTo?.name ?? st.org?.name ?? '')}</span>
    </div>
    ${st.warnings.length ? callout('warn', st.warnings.map(esc).join('<br>')) : ''}
    <div class="grid k4 section">
      ${isOwner ? kpi('Charging units', `${fmt.num(t.energyKwh, 1)} kWh`, `${fmt.num(t.sessions)} sessions`) : ''}
      ${kpi('Commission base', fmt.idr(t.gtvIdr), `${isOwner ? '' : `${fmt.num(t.sessions)} sessions · `}what drivers paid, excl. PBJT and PPN`)}
      ${isOwner ? kpi(ownerLabel, fmt.idr(t.ownerShareIdr), t.gtvIdr ? `${pct(Math.round((t.ownerShareIdr / t.gtvIdr) * 10000))} of the base` : '', t.ownerShareIdr >= 0 ? 'ok' : 'warn') : ''}
      ${isOwner ? kpi(`${opName} share`, fmt.idr(t.platformShareIdr), `invoiced ${fmt.idr(t.totalIdr)} incl. PPN`) : ''}
      ${isOwner ? '' : kpi('Commission', fmt.idr(t.commissionIdr), t.gtvIdr ? `${pct(Math.round((t.commissionIdr / t.gtvIdr) * 10000))} effective` : '')}
      ${isOwner ? '' : kpi('Minimums & platform fees', fmt.idr(t.minimumTopUpIdr + t.privateFeeIdr), `top-up ${fmt.idr(t.minimumTopUpIdr)} · private ${fmt.idr(t.privateFeeIdr)}`)}
      ${isOwner ? '' : kpi('Total due', fmt.idr(t.totalIdr), `${fmt.idr(t.netIdr)} + PPN ${fmt.idr(t.ppnIdr)}${t.mdrCreditIdr ? ` · MDR credit ${fmt.idr(t.mdrCreditIdr)}` : ''}`, 'ok')}
    </div>
    <div class="card section" data-sites></div>
    <div class="card section"><header><h3>How it adds up</h3></header>
      <table class="t"><tbody>
        <tr><td>Gross collected from drivers</td><td class="num">${esc(fmt.idr(t.grossCollectedIdr))}</td></tr>
        <tr><td class="cell-sub">less PBJT-TL</td><td class="num cell-sub">${esc(fmt.idr(t.pbjtIdr))}</td></tr>
        <tr><td class="cell-sub">less PPN collected</td><td class="num cell-sub">${esc(fmt.idr(t.ppnCollectedIdr))}</td></tr>
        <tr><td><b>Commission base</b> (energy, service, admin, idle fees)</td><td class="num"><b>${esc(fmt.idr(t.gtvIdr))}</b></td></tr>
        <tr><td>Commission</td><td class="num">${esc(fmt.idr(t.commissionIdr))}</td></tr>
        <tr><td>Minimum top-up (quiet chargers)</td><td class="num">${esc(fmt.idr(t.minimumTopUpIdr))}</td></tr>
        <tr><td>Platform fee (private chargers)</td><td class="num">${esc(fmt.idr(t.privateFeeIdr))}</td></tr>
        ${t.mdrCreditIdr ? `<tr><td>Less payment processing (QRIS MDR, estimated)</td><td class="num">− ${esc(fmt.idr(t.mdrCreditIdr))}</td></tr>` : ''}
        <tr><td><b>Fee before tax</b></td><td class="num"><b>${esc(fmt.idr(t.netIdr))}</b></td></tr>
        <tr><td class="cell-sub">DPP nilai lain (11/12)</td><td class="num cell-sub">${esc(fmt.idr(t.dppIdr))}</td></tr>
        <tr><td>PPN</td><td class="num">${esc(fmt.idr(t.ppnIdr))}</td></tr>
        <tr><td><b>Total due</b></td><td class="num"><b>${esc(fmt.idr(t.totalIdr))}</b></td></tr>
        <tr><td class="cell-sub">PPh 23 you may withhold (2%), if you are a withholding agent</td><td class="num cell-sub">${esc(fmt.idr(t.pph23Idr))}</td></tr>
        ${isOwner ? `
        <tr><td colspan="2"><b>How the commission base is shared</b></td></tr>
        <tr><td>${esc(ownerLabel)}</td><td class="num"><b>${esc(fmt.idr(t.ownerShareIdr))}</b></td></tr>
        <tr><td>${esc(opName)} share (fee before tax)</td><td class="num">${esc(fmt.idr(t.platformShareIdr))}</td></tr>
        <tr><td class="cell-sub">Payment processing (QRIS MDR, estimated, kept by the gateway)</td><td class="num cell-sub">${esc(fmt.idr(t.mdrEstimateIdr))}</td></tr>` : ''}
      </tbody></table>
      <p class="cell-sub" style="margin-top:10px">${esc(planText(st.plan))} Sessions count in the month their charge record was issued.</p>
    </div>`;
  table($('[data-sites]', box), {
    columns: [
      { label: 'Site', render: (s) => `<div class="cell-title">${esc(s.name)}</div><div class="cell-sub">${s.model === 'public' ? `public · ${esc(s.tier)} tier` : 'private · platform fee'} · ${s.chargers.length} charger${s.chargers.length === 1 ? '' : 's'}</div>${s.warnings.length ? tag('t-warn', `${s.warnings.length} note${s.warnings.length === 1 ? '' : 's'}`) : ''}` },
      { label: 'Sessions', num: true, render: (s) => fmt.num(s.sessions) },
      { label: 'kWh', num: true, render: (s) => fmt.num(s.energyKwh, 1) },
      { label: 'Commission base', num: true, render: (s) => fmt.idr(s.gtvIdr) },
      { label: 'Rate', num: true, render: (s) => (s.model === 'public' ? pct(s.rateBps) : '—') },
      { label: 'Commission', num: true, render: (s) => fmt.idr(s.commissionIdr) },
      { label: 'Min. top-up', num: true, render: (s) => fmt.idr(s.minimumTopUpIdr) },
      { label: 'Platform fee', num: true, render: (s) => fmt.idr(s.privateFeeIdr) },
      { label: 'Fee', num: true, render: (s) => `<b>${fmt.idr(s.feeIdr)}</b>` },
      ...(isOwner ? [{ label: ownerLabel, num: true, render: (s) => `<b>${fmt.idr(s.ownerShareIdr)}</b>` }] : []),
    ],
    rows: st.sites,
    empty: 'No chargers in service this month.',
    onRow: (s) => drawer({
      title: s.name,
      subtitle: `${esc(monthLabel(st.period))} · ${s.model === 'public' ? `public, ${esc(s.tier)} tier at ${esc(pct(s.rateBps))}` : 'private, platform fee'}`,
      tabs: [{
        id: 'chargers', label: 'Chargers',
        render(body) {
          body.innerHTML = `${s.warnings.length ? callout('warn', s.warnings.map(esc).join('<br>')) : ''}<div data-t></div>`;
          table($('[data-t]', body), {
            columns: [
              { label: 'Charger', render: (c) => `<div class="cell-title">${esc(c.displayName || c.ocppIdentity)}</div><div class="cell-sub mono">${esc(c.ocppIdentity)} · ${esc(c.kind)} · ${esc(c.activeDays)} days in service</div>` },
              { label: 'Sessions', num: true, render: (c) => fmt.num(c.sessions) },
              { label: 'kWh', num: true, render: (c) => fmt.num(c.energyWh / 1000, 1) },
              { label: 'Base', num: true, render: (c) => fmt.idr(c.gtvIdr) },
              { label: 'Commission', num: true, render: (c) => fmt.idr(c.commissionIdr) },
              { label: 'Minimum', num: true, render: (c) => (s.model === 'public' ? fmt.idr(c.minimumIdr) : '—') },
              { label: 'Top-up', num: true, render: (c) => fmt.idr(c.topUpIdr) },
              { label: 'Platform fee', num: true, render: (c) => fmt.idr(c.privateFeeIdr) },
              { label: 'Fee', num: true, render: (c) => `<b>${fmt.idr(c.feeIdr)}</b>` },
            ],
            rows: s.chargers,
          });
        },
      }],
    }),
  });
}
