import { $, $$, esc, api, state, registerView, pageHead, icon, field, callout, table, fmt, tag, kpi, modal, confirmDialog, toast, formValues, countryCurrency, isRupiah, toMinor, toMajor } from '../core.js';

/** Currencies a plan or promotion can be in: those of the organisation's sites, the home country's first. */
const orgCurrencies = () => [...new Set([countryCurrency(state.me?.org?.homeCountry), ...(state.me?.org?.countries ?? []).map((c) => c.currency)])];
const curOf = (p) => p.currency ?? orgCurrencies()[0];
/** Amounts in forms are in major units (RM 12.50); rupiah as before (whole rupiah). */
const major = (minor, cur) => (minor == null || minor === '' ? '' : toMajor(minor, cur));
const minorOf = (x, cur) => (x === '' || x == null ? null : toMinor(String(x), cur));
/** The currency choice on a new plan or promotion (fixed afterwards); nothing when the organisation has only one. */
const currencyField = (p) => (p.id || orgCurrencies().length < 2 ? `<input type="hidden" name="currency" value="${esc(curOf(p))}">`
  : field('Currency', `<select name="currency">${orgCurrencies().map((c) => `<option value="${esc(c)}"${c === curOf(p) ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>`, { help: 'Applies only to sessions in this currency. Fixed once created.' }));
const wireSym = (b) => { const sel = $('select[name=currency]', b); sel?.addEventListener('change', () => $$('[data-sym]', b).forEach((x) => { x.textContent = fmt.sym(sel.value); })); };

/**
 * Promotions & plans — memberships and offers that change what a session costs.
 * Both are applied at rating as discount lines before tax, so receipts, fleet
 * invoices and the faktur pajak show them.
 */

const KIND = {
  energy_percent: ['% off energy', (v) => `${fmt.num(v)}% off energy`],
  energy_rate: ['Promo price per kWh', (v, cur) => `${isRupiah(cur) ? fmt.idr(v) : fmt.rate(v, cur)}/kWh`],
  amount_off: ['Rupiah off', (v, cur) => `${fmt.money(v, cur)} off`],
  free_kwh: ['Free kWh', (v) => `${fmt.num(v)} kWh free`],
  waive_fees: ['Service fee waived', () => 'service fee waived'],
};
const AUDIENCE = { everyone: 'Everyone', new_drivers: 'New drivers (first session)', fleet_accounts: 'Chosen fleet accounts', plan_members: 'Members of chosen plans', code: 'Whoever enters the code' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const toLocalInput = (iso) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
const planBenefits = (p) => [
  p.member_rate != null ? `${isRupiah(p.currency) ? fmt.idr(p.member_rate) : fmt.rate(p.member_rate, p.currency)}/kWh` : '',
  p.energy_discount_bps ? `${p.energy_discount_bps / 100}% off energy` : '',
  p.included_kwh ? `${fmt.num(p.included_kwh)} kWh included` : '',
  p.waive_session_fees ? 'no service fee' : '',
].filter(Boolean).join(' · ') || 'no benefits set';

registerView('pricing', {
  title: 'Promotions & plans',
  icon: 'gift',
  group: 'commercial',
  order: 22,
  perm: 'tariff:read',
  async render(root, [tabParam]) {
    const canWrite = state.can('tariff:write');
    root.innerHTML = pageHead(
      'Promotions & plans',
      'Memberships (a monthly plan with a member price, a discount, included kWh or no service fee) and promotions (happy hours, launch offers, promo codes, fleet deals). Each session gets the membership plus at most one promotion — whichever is cheapest for the customer — applied before PBJT-TL and PPN.',
      '',
    ) + `<div class="tabs" role="tablist"><button type="button" data-tab="promotions">Promotions</button><button type="button" data-tab="plans">Plans</button><button type="button" data-tab="members">Members</button><button type="button" data-tab="loyalty">Loyalty points</button></div><div data-body></div>`;
    const body = $('[data-body]', root);
    const show = (t) => {
      $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
      history.replaceState(null, '', `#/pricing/${t}`);
      ({ promotions: renderPromotions, plans: renderPlans, members: renderMembers, loyalty: renderLoyalty }[t] ?? renderPromotions)(body, canWrite);
    };
    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    show(['promotions', 'plans', 'members', 'loyalty'].includes(tabParam) ? tabParam : 'promotions');
  },
});

// ─────────────────────────────────────────── promotions

async function lookups() {
  const [sites, accounts, plans] = await Promise.all([
    api('/v1/sites').catch(() => []),
    api('/v1/fleet-accounts').then((r) => r.accounts).catch(() => []),
    api('/v1/subscription-plans').then((r) => r.plans).catch(() => []),
  ]);
  return { sites: Array.isArray(sites) ? sites : sites.sites ?? [], accounts, plans };
}
const multi = (name, items, selected, label) => `<select name="${name}" multiple size="${Math.min(5, Math.max(2, items.length))}">${items.map((x) => `<option value="${esc(x.id)}"${(selected ?? []).includes(x.id) ? ' selected' : ''}>${esc(label(x))}</option>`).join('')}</select>`;
const selectedOf = (b, name) => [...$(`[name="${name}"]`, b).selectedOptions].map((o) => o.value);

function promoForm(p, L) {
  const days = p.days_mask ?? 127;
  return `<div class="form">
    ${field('Name', `<input name="name" value="${esc(p.name ?? '')}" placeholder="Happy hour malam">`)}
    ${currencyField(p)}
    ${field('Offer', `<select name="kind">${Object.entries(KIND).map(([k, [l]]) => `<option value="${k}"${p.kind === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`)}
    ${field('Value', `<input name="value" type="number" min="0" step="any" value="${esc(p.kind === 'amount_off' ? major(p.value, curOf(p)) : p.value ?? '')}">`, { help: isRupiah(curOf(p)) && orgCurrencies().length < 2 ? '% for "% off", rupiah for a price or amount, kWh for free kWh; ignored for "service fee waived".' : '% for "% off", an amount in the currency for a price or amount off, kWh for free kWh; ignored for "service fee waived".' })}
    ${field('Who', `<select name="audience">${Object.entries(AUDIENCE).map(([k, l]) => `<option value="${k}"${(p.audience ?? 'everyone') === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`)}
    ${field('Promo code', `<input name="code" value="${esc(p.code ?? '')}" placeholder="HEMAT20" style="text-transform:uppercase">`, { opt: true, help: 'Drivers enter it at checkout in the app. Needed for "whoever enters the code".' })}
    ${field('Fleet accounts', multi('fleetAccountIds', L.accounts, p.fleet_account_ids, (a) => a.name), { opt: true })}
    ${field('Plans', multi('planIds', L.plans, p.plan_ids, (x) => x.name), { opt: true })}
    ${field('Sites', multi('siteIds', L.sites, p.site_ids, (s) => s.name), { opt: true, help: 'None selected = every site.' })}
    ${field('AC / DC', `<select name="currentType"><option value="">Both</option><option value="AC"${p.current_type === 'AC' ? ' selected' : ''}>AC only</option><option value="DC"${p.current_type === 'DC' ? ' selected' : ''}>DC only</option></select>`)}
    ${field('Starts', `<input name="startsAt" type="datetime-local" value="${esc(toLocalInput(p.starts_at ?? new Date().toISOString()))}">`)}
    ${field('Ends', `<input name="endsAt" type="datetime-local" value="${esc(toLocalInput(p.ends_at))}">`, { opt: true })}
    <div class="field full"><label>Days</label><div class="row" style="gap:10px;flex-wrap:wrap">${DAYS.map((d, i) => `<label class="check"><input type="checkbox" data-day="${i}"${(days >> i) & 1 ? ' checked' : ''}> <span>${d}</span></label>`).join('')}</div></div>
    ${field('From (time)', `<input name="timeFrom" type="time" value="${esc(p.time_from ?? '')}">`, { opt: true, help: 'Local time at the site; empty = all day.' })}
    ${field('To (time)', `<input name="timeTo" type="time" value="${esc(p.time_to ?? '')}">`, { opt: true })}
    ${field('Minimum kWh', `<input name="minKwh" type="number" min="0" step="any" value="${esc(p.min_kwh ?? 0)}">`)}
    ${field('Total uses', `<input name="maxRedemptions" type="number" min="1" value="${esc(p.max_redemptions ?? '')}">`, { opt: true })}
    ${field('Uses per customer', `<input name="maxPerCustomer" type="number" min="1" value="${esc(p.max_per_customer ?? '')}">`, { opt: true })}
    ${field(`Budget (<span data-sym>${esc(fmt.sym(curOf(p)))}</span>)`, `<input name="budgetMinor" type="number" min="0" step="any" value="${esc(major(p.budget_minor, curOf(p)))}">`, { opt: true, labelHtml: true, help: 'The offer stops once this much discount has been given.' })}
    <div class="field full"><label class="check"><input type="checkbox" name="stacksWithMembership"${p.stacks_with_membership === false ? '' : ' checked'}> <span>Also for members, on top of their plan</span></label></div>
    <div class="field full"><label class="check"><input type="checkbox" name="active"${p.active === false ? '' : ' checked'}> <span>Active</span></label></div>
  </div>`;
}
function readPromo(b) {
  const v = formValues(b);
  const mask = $$('[data-day]', b).reduce((m, x) => (x.checked ? m | (1 << Number(x.dataset.day)) : m), 0);
  const cur = v.currency || orgCurrencies()[0];
  return {
    ...(v.currency ? { currency: v.currency } : {}),
    name: v.name, kind: v.kind, value: v.kind === 'amount_off' ? minorOf(v.value || 0, cur) : Number(v.value || 0), audience: v.audience, code: v.code || null,
    fleetAccountIds: selectedOf(b, 'fleetAccountIds'), planIds: selectedOf(b, 'planIds'), siteIds: selectedOf(b, 'siteIds'),
    currentType: v.currentType || null, startsAt: v.startsAt ? new Date(v.startsAt).toISOString() : null, endsAt: v.endsAt ? new Date(v.endsAt).toISOString() : null,
    daysMask: mask, timeFrom: v.timeFrom || null, timeTo: v.timeTo || null, minKwh: Number(v.minKwh || 0),
    maxRedemptions: v.maxRedemptions ? Number(v.maxRedemptions) : null, maxPerCustomer: v.maxPerCustomer ? Number(v.maxPerCustomer) : null,
    budgetMinor: v.budgetMinor ? minorOf(v.budgetMinor, cur) : null, stacksWithMembership: v.stacksWithMembership, active: v.active,
  };
}

async function renderPromotions(box, canWrite) {
  box.innerHTML = `<div class="filters"><div class="grow"></div>${canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} New promotion</button>` : ''}</div><div class="card section" data-list></div>`;
  const L = await lookups();
  const load = async () => {
    const { promotions } = await api('/v1/promotions');
    const now = Date.now();
    table($('[data-list]', box), {
      columns: [
        { label: 'Promotion', render: (p) => `<div class="cell-title">${esc(p.name)}</div><div class="cell-sub">${esc(KIND[p.kind][1](p.value, p.currency))}${p.code ? ` · code <span class="mono">${esc(p.code)}</span>` : ''}</div>` },
        { label: 'Who', render: (p) => esc(AUDIENCE[p.audience]) },
        { label: 'When', render: (p) => `<div class="cell-sub">${esc(fmt.date(p.starts_at))} – ${p.ends_at ? esc(fmt.date(p.ends_at)) : 'open'}${p.time_from ? ` · ${esc(p.time_from)}–${esc(p.time_to)}` : ''}${p.days_mask !== 127 ? ` · ${DAYS.filter((_, i) => (p.days_mask >> i) & 1).join(', ')}` : ''}</div>` },
        { label: 'Status', render: (p) => (!p.active ? tag('t-mute', 'off') : p.ends_at && new Date(p.ends_at) < now ? tag('t-mute', 'ended') : new Date(p.starts_at) > now ? tag('t-info', 'scheduled') : tag('t-ok', 'running')) },
        { label: 'Uses', num: true, render: (p) => `${fmt.num(p.redemptions)}${p.max_redemptions ? ` / ${fmt.num(p.max_redemptions)}` : ''}<div class="cell-sub">${fmt.num(p.customers)} customers</div>` },
        { label: 'Discount given', num: true, render: (p) => `<b>${fmt.money(p.discount_minor, p.currency)}</b>${p.budget_minor ? `<div class="cell-sub">of ${fmt.money(p.budget_minor, p.currency)}</div>` : ''}` },
      ],
      rows: promotions,
      empty: 'No promotions yet.',
      onRow: canWrite ? (p) => edit(p) : null,
    });
  };
  const edit = (p = {}) => wireSym(modal({
    title: p.id ? `Edit ${p.name}` : 'New promotion', size: 'lg', body: promoForm(p, L),
    actions: [{ label: 'Cancel' }, { label: p.id ? 'Save' : 'Create', kind: 'primary', async onClick(ctx) {
      try { await api(p.id ? `/v1/promotions/${p.id}` : '/v1/promotions', { method: p.id ? 'PUT' : 'POST', body: readPromo(ctx.body) }); toast('Saved', 'ok'); load(); }
      catch (e) { toast(e.message, 'crit'); return false; }
    } }],
  }).body);
  $('[data-add]', box)?.addEventListener('click', () => edit());
  await load();
}

// ─────────────────────────────────────────── plans

function planForm(p, L) {
  return `<div class="form">
    ${field('Name', `<input name="name" value="${esc(p.name ?? '')}" placeholder="Member Hemat">`)}
    ${currencyField(p)}
    ${field(`Monthly fee (<span data-sym>${esc(fmt.sym(curOf(p)))}</span>, ${isRupiah(curOf(p)) && orgCurrencies().length < 2 ? 'before tax' : 'before tax where tax is added'})`, `<input name="monthlyFeeMinor" type="number" min="0" step="${isRupiah(curOf(p)) && orgCurrencies().length < 2 ? '1' : 'any'}" value="${esc(major(p.monthly_fee_minor ?? 0, curOf(p)))}">`, { labelHtml: true })}
    ${field(`Member price per kWh (<span data-sym>${esc(fmt.sym(curOf(p)))}</span>)`, `<input name="memberRate" type="number" min="0" step="any" value="${esc(p.member_rate ?? '')}">`, { opt: true, labelHtml: true, help: 'Energy is billed at this price where it is lower than the tariff.' })}
    ${field('Discount on energy (%)', `<input name="energyDiscountPercent" type="number" min="0" max="100" step="any" value="${esc((p.energy_discount_bps ?? 0) / 100)}">`)}
    ${field('Included kWh per month', `<input name="includedKwh" type="number" min="0" step="any" value="${esc(p.included_kwh ?? 0)}">`)}
    ${field('AC / DC', `<select name="currentType"><option value="">Both</option><option value="AC"${p.current_type === 'AC' ? ' selected' : ''}>AC only</option><option value="DC"${p.current_type === 'DC' ? ' selected' : ''}>DC only</option></select>`)}
    ${field('Sites', multi('siteIds', L.sites, p.site_ids, (s) => s.name), { opt: true, help: 'None selected = every site.' })}
    ${field('Description', `<input name="description" value="${esc(p.description ?? '')}">`, { opt: true, full: true })}
    <div class="field full"><label class="check"><input type="checkbox" name="waiveSessionFees"${p.waive_session_fees ? ' checked' : ''}> <span>No service or admin fee for members</span></label></div>
    <div class="field full"><label class="check"><input type="checkbox" name="offeredInApp"${p.offered_in_app ? ' checked' : ''}> <span>Offered in the driver app (30-day passes paid by QRIS)</span></label></div>
    <div class="field full"><label class="check"><input type="checkbox" name="active"${p.active === false ? '' : ' checked'}> <span>Active</span></label></div>
  </div>`;
}
function readPlan(b) {
  const v = formValues(b);
  const cur = v.currency || orgCurrencies()[0];
  return {
    ...(v.currency ? { currency: v.currency } : {}),
    name: v.name, monthlyFeeMinor: minorOf(v.monthlyFeeMinor || 0, cur), memberRate: v.memberRate === '' ? null : Number(v.memberRate),
    energyDiscountPercent: Number(v.energyDiscountPercent || 0), includedKwh: Number(v.includedKwh || 0), currentType: v.currentType || null,
    siteIds: selectedOf(b, 'siteIds'), description: v.description, waiveSessionFees: v.waiveSessionFees, offeredInApp: v.offeredInApp, active: v.active,
  };
}

async function renderPlans(box, canWrite) {
  box.innerHTML = `<div class="filters"><div class="grow"></div>${canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} New plan</button>` : ''}</div><div class="card section" data-list></div>
    <p class="cell-sub">Fleet accounts and cards are enrolled under Members and billed on the monthly fleet invoice. Drivers buy app plans as 30-day passes.</p>`;
  const L = await lookups();
  const load = async () => {
    const { plans } = await api('/v1/subscription-plans');
    table($('[data-list]', box), {
      columns: [
        { label: 'Plan', render: (p) => `<div class="cell-title">${esc(p.name)}</div><div class="cell-sub">${esc(planBenefits(p))}</div>` },
        { label: 'Fee / month', num: true, render: (p) => fmt.money(p.monthly_fee_minor, p.currency) },
        { label: 'Where', render: (p) => `${esc(p.current_type ?? 'AC & DC')}${p.site_ids?.length ? ` · ${p.site_ids.length} site(s)` : ''}` },
        { label: 'In app', render: (p) => (p.offered_in_app ? tag('t-info', 'offered') : '—') },
        { label: 'Members', num: true, render: (p) => fmt.num(p.members) },
        { label: 'Status', render: (p) => (p.active ? tag('t-ok', 'active') : tag('t-mute', 'off')) },
      ],
      rows: plans,
      empty: 'No plans yet.',
      onRow: canWrite ? (p) => edit(p) : null,
    });
  };
  const edit = (p = {}) => wireSym(modal({
    title: p.id ? `Edit ${p.name}` : 'New plan', size: 'lg', body: planForm(p, L),
    actions: [{ label: 'Cancel' }, { label: p.id ? 'Save' : 'Create', kind: 'primary', async onClick(ctx) {
      try { await api(p.id ? `/v1/subscription-plans/${p.id}` : '/v1/subscription-plans', { method: p.id ? 'PUT' : 'POST', body: readPlan(ctx.body) }); toast('Saved', 'ok'); load(); }
      catch (e) { toast(e.message, 'crit'); return false; }
    } }],
  }).body);
  $('[data-add]', box)?.addEventListener('click', () => edit());
  await load();
}

// ─────────────────────────────────────────── members

async function renderMembers(box, canWrite) {
  box.innerHTML = `<div class="filters"><div class="grow"></div>${canWrite ? `<button class="btn primary" type="button" data-add>${icon('plus')} Enrol member</button>` : ''}</div><div class="card section" data-list></div>`;
  const L = await lookups();
  const load = async () => {
    const { subscriptions } = await api('/v1/subscriptions');
    table($('[data-list]', box), {
      columns: [
        { label: 'Member', render: (s) => `<div class="cell-title">${esc(s.subscriber_kind === 'fleet_account' ? s.fleet_account_name : s.subscriber_kind === 'card' ? s.card_uid : s.driver_phone ?? 'app driver')}</div><div class="cell-sub">${esc({ fleet_account: 'fleet account', card: 'card', app_driver: 'driver app' }[s.subscriber_kind])}</div>` },
        { label: 'Plan', render: (s) => esc(s.plan_name) },
        { label: 'Billing', render: (s) => `${esc({ invoice: 'fleet invoice (prorated by day)', qris: 'app pass', complimentary: 'complimentary' }[s.billing])}${s.billing === 'qris' ? `<div class="cell-sub">${s.auto_renew ? 'renews automatically' : 'renewed by the driver'}</div>${s.renew_error ? `<div class="cell-sub" style="color:var(--warn)">${esc(s.renew_error)}</div>` : ''}` : ''}` },
        { label: 'Since', render: (s) => esc(fmt.date(s.started_at)) },
        { label: 'Until', render: (s) => (s.current_period_end ? esc(fmt.date(s.current_period_end)) : s.cancelled_at ? esc(fmt.date(s.cancelled_at)) : '—') },
        { label: 'Status', render: (s) => tag({ active: 't-ok', pending_payment: 't-info', cancelled: 't-mute', expired: 't-mute' }[s.status] ?? 't-mute', s.status.replace('_', ' ')) },
        { label: '', render: (s) => (canWrite && s.status === 'active' && s.billing !== 'qris' ? `<button class="btn sm" type="button" data-cancel="${esc(s.id)}">Cancel</button>` : '') },
      ],
      rows: subscriptions,
      empty: 'No members yet.',
    });
  };
  box.addEventListener('click', async (ev) => {
    const c = ev.target.closest('[data-cancel]');
    if (!c) return;
    const ok = await confirmDialog({ title: 'Cancel this membership?', message: 'Benefits stop now. A membership billed on the fleet invoice is billed for the days of this month it was in force.', confirmLabel: 'Cancel membership', danger: true });
    if (!ok) return;
    try { await api(`/v1/subscriptions/${c.dataset.cancel}/cancel`, { method: 'POST' }); toast('Cancelled', 'ok'); load(); } catch (e) { toast(e.message, 'crit'); }
  });
  $('[data-add]', box)?.addEventListener('click', () => modal({
    title: 'Enrol a member',
    body: `<div class="form one">
      ${field('Plan', `<select name="planId">${L.plans.filter((p) => p.active).map((p) => `<option value="${esc(p.id)}">${esc(p.name)} — ${fmt.money(p.monthly_fee_minor, p.currency)}/month</option>`).join('')}</select>`)}
      ${field('Member', `<select name="subscriberKind"><option value="fleet_account">A fleet account (all its cards)</option><option value="card">One card</option></select>`)}
      ${field('Fleet account', `<select name="fleetAccountId">${L.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select>`)}
      ${field('Card UID', '<input name="cardUid" placeholder="for one card" autocomplete="off">')}
      ${field('Billing', '<select name="billing"><option value="invoice">On the monthly fleet invoice</option><option value="complimentary">Complimentary (no fee)</option></select>')}
    </div>${callout('info', 'Drivers who pay per session subscribe themselves in the app.')}`,
    actions: [{ label: 'Cancel' }, { label: 'Enrol', kind: 'primary', async onClick(ctx) {
      const v = formValues(ctx.body);
      try {
        await api('/v1/subscriptions', { method: 'POST', body: { planId: v.planId, subscriberKind: v.subscriberKind, fleetAccountId: v.subscriberKind === 'fleet_account' ? v.fleetAccountId : undefined, cardUid: v.subscriberKind === 'card' ? v.cardUid : undefined, billing: v.billing } });
        toast('Member enrolled', 'ok'); load();
      } catch (e) { toast(e.message, 'crit'); return false; }
    } }],
  }));
  await load();
}

// ─────────────────────────────────────────── loyalty points

async function renderLoyalty(box, canWrite) {
  const draw = async () => {
    const [s, m] = await Promise.all([api('/v1/loyalty'), api('/v1/loyalty/members?limit=25')]);
    const p = s.program;
    box.innerHTML = `
      ${callout('info', 'Drivers signed in to the app earn points on what each session costs them. Those who tick “use my points” have them taken off their next sessions automatically — like a discount, before PBJT-TL and PPN. Points are spent oldest first and expire after the set number of months.')}
      <div class="grid k4 section">
        ${kpi('Loyalty', p.enabled ? 'On' : 'Off', p.enabled ? `${esc(p.earnPer1000Minor)} pt / Rp 1,000 · 1 pt = ${fmt.idr(p.pointValueMinor)}` : 'switch it on below')}
        ${kpi('Points outstanding', fmt.num(s.outstandingPoints), `worth ${fmt.idr(s.liabilityMinor)} · ${fmt.num(s.members)} driver(s)`)}
        ${kpi('Earned this month', fmt.num(s.thisMonth.earned), `${fmt.num(s.thisMonth.expired)} expired`)}
        ${kpi('Spent this month', fmt.num(s.thisMonth.redeemed), `${fmt.idr(s.thisMonth.discountMinor)} discount given`)}
      </div>
      <div class="card section"><header><h3>Program</h3></header><div class="body">
        <div class="form">
          <div class="field full"><label class="check"><input type="checkbox" name="enabled"${p.enabled ? ' checked' : ''}${canWrite ? '' : ' disabled'}> <span>Loyalty points are on</span></label></div>
          ${field('Points per Rp 1,000', `<input name="earnPer1000Minor" inputmode="numeric" value="${esc(p.earnPer1000Minor)}"${canWrite ? '' : ' disabled'}>`, { help: 'Of the session receipt total, rounded down.' })}
          ${field('Value of a point (Rp)', `<input name="pointValueMinor" inputmode="numeric" value="${esc(p.pointValueMinor)}"${canWrite ? '' : ' disabled'}>`, { help: `With these settings a driver gets ${((p.earnPer1000Minor * p.pointValueMinor) / 10).toLocaleString('en-GB', { maximumFractionDigits: 2 })}% back.` })}
          ${field('Most points may pay of a session (%)', `<input name="maxRedeemPercent" inputmode="decimal" value="${esc(p.maxRedeemBps / 100)}"${canWrite ? '' : ' disabled'}>`, { help: 'Of the energy and service fees.' })}
          ${field('Points expire after (months)', `<input name="expiryMonths" inputmode="numeric" value="${esc(p.expiryMonths)}"${canWrite ? '' : ' disabled'}>`)}
        </div>
        ${canWrite ? '<button class="btn primary" type="button" data-save style="margin-top:12px">Save</button>' : ''}
      </div></div>
      <div class="card section"><header><h3>Drivers with the most points</h3></header><div data-members></div></div>`;
    table($('[data-members]', box), {
      columns: [
        { label: 'Driver', render: (x) => `<div class="cell-title">${esc(x.name ?? x.phone)}</div><div class="cell-sub mono">${esc(x.phone)}</div>` },
        { label: 'Points', num: true, render: (x) => `<b>${fmt.num(x.balance)}</b><div class="cell-sub">${fmt.idr(x.balance * p.pointValueMinor)}</div>` },
        { label: 'Uses them', render: (x) => (x.autoRedeem ? tag('t-ok', 'yes') : tag('t-mute', 'saving')) },
        { label: 'Last activity', render: (x) => esc(fmt.ago(x.lastActivity)) },
        { label: '', render: (x) => (canWrite ? `<button class="btn sm ghost" type="button" data-adjust="${esc(x.appDriverId)}">Adjust</button>` : '') },
      ],
      rows: m.members,
      empty: p.enabled ? 'No driver holds points yet.' : 'Switch loyalty on to start.',
    });
    $('[data-save]', box)?.addEventListener('click', async () => {
      const v = formValues(box);
      try {
        await api('/v1/loyalty', { method: 'PUT', body: { enabled: !!v.enabled, earnPer1000Minor: Number(v.earnPer1000Minor), pointValueMinor: Number(v.pointValueMinor), maxRedeemBps: Math.round(Number(v.maxRedeemPercent) * 100), expiryMonths: Number(v.expiryMonths) } });
        toast('Loyalty program saved', 'ok'); draw();
      } catch (e) { toast(e.message, 'crit'); }
    });
    $$('[data-adjust]', box).forEach((b) => b.addEventListener('click', () => modal({
      title: 'Adjust points',
      body: `<div class="form one">${field('Points', '<input name="points" inputmode="numeric" placeholder="e.g. 500, or -200">', { help: 'Positive adds (goodwill); negative takes away, never below zero.' })}
        ${field('Reason', '<input name="note" placeholder="Shown in the driver\'s history" autocomplete="off">')}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Adjust', kind: 'primary', async onClick(ctx) {
        const v = formValues(ctx.body);
        try { const r = await api('/v1/loyalty/adjust', { method: 'POST', body: { appDriverId: b.dataset.adjust, points: Number(v.points), note: v.note } }); toast(`Balance now ${fmt.num(r.balance)} points`, 'ok'); draw(); }
        catch (e) { toast(e.message, 'crit'); return false; }
      } }],
    })));
  };
  await draw();
}