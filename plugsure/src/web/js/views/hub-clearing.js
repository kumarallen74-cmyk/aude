import {
  $, $$, esc, api, attempt, table, tag, icon, fmt, field, options, callout, modal, drawer, toast, formValues, fieldErrors, kpi, download,
  toMinor, toMajor, debounce, COUNTRIES,
} from '../core.js';
import { reasonDialog, reasonForm } from './hub-common.js';

/**
 * PlugSure Hub clearing and settlement in the console (docs/HUB-DESIGN.md "H2 as built" → API for H3).
 *
 *   drawClearingPlatform(root)  Hub → Clearing, platform admins (/v1/hub/clearing/*): overview, ledger with CDR detail
 *                               (release, void, dispute), disputes (notes, resolve, escalate, withdraw), settlement
 *                               runs (create, preview, finalise, void), positions and payments, statements and fee
 *                               invoices, commission (fee plans, agreement and member terms), issuing entities.
 *   drawClearingMember(root)    Roaming → PlugSure Hub, a member (/v1/roaming/hub/clearing/*): summary, its ledger
 *                               (raise a dispute as the eMSP), disputes (respond as the CPO, escalate/withdraw as the
 *                               eMSP, notes), statements and fee invoices, positions and payments, its commission
 *                               terms, the bank details its counterparties pay into.
 *
 * Money: integers in minor units next to `currency`, shown with fmt.money per currency and never added across
 * currencies. Destructive actions ask for a reason (audited); finalise, void and write-off need a typed phrase.
 */

const PLAT = '/v1/hub/clearing';
const MEMB = '/v1/roaming/hub/clearing';
// The currencies the hub clears: one per country (domain/country via money.js), never converted.
const CURS = Object.values(COUNTRIES).map((c) => c.currency);
const CUR_COUNTRY = Object.fromEntries(Object.values(COUNTRIES).map((c) => [c.currency, c.name]));

const CDR_TAG = { held: 't-crit', pending: 't-info', disputed: 't-warn', accepted: 't-ok', credited: 't-mute', written_off: 't-mute', void: 't-mute' };
const DISPUTE_TAG = { open: 't-info', accepted: 't-warn', rejected: 't-warn', escalated: 't-crit', credited: 't-ok', expired: 't-mute', resolved: 't-ok', withdrawn: 't-mute' };
const RUN_TAG = { draft: 't-info', finalised: 't-ok', void: 't-mute' };
const POS_TAG = { open: 't-info', partially_paid: 't-warn', paid: 't-ok', confirmed: 't-ok', overdue: 't-crit', nothing_due: 't-mute', written_off: 't-mute' };
const INV_TAG = { issued: 't-info', paid: 't-ok', overdue: 't-crit', void: 't-mute' };
const LIVE_DISPUTE = ['open', 'accepted', 'rejected', 'escalated'];
const REASONS = [
  ['amount', 'Amount (price or total wrong)'], ['energy', 'Energy (kWh wrong)'], ['tariff_mismatch', 'Tariff does not match the agreement'],
  ['unknown_token', 'Unknown token'], ['not_authorized', 'Token was not authorised'], ['duplicate', 'Duplicate of another CDR'],
  ['session_not_found', 'No such session'], ['other', 'Other'],
];
const FLAG_TEXT = {
  no_agreement: 'no roaming agreement valid at the session start', unsupported_currency: 'currency not cleared by the hub',
  currency_country_mismatch: 'currency is not the location country\'s', implausible: 'implausible values (price, energy, duration)',
  credit_unknown_reference: 'credit for an unknown CDR', credit_amount_mismatch: 'credit amount does not match the original',
  credit_already_applied: 'original already credited', credit_original_not_payable: 'original is not payable',
  cdr_duplicate_conflict: 'same id seen with other content', not_delivered: 'not delivered to the eMSP yet',
  no_session_seen: 'no session seen for it', no_authorization_seen: 'no authorisation seen', whitelist_token_unknown: 'token unknown to the hub',
  late_cdr: 'sent late', overlap: 'overlaps another session', duplicate_session: 'another CDR for the same session', no_incl_vat: 'no incl.-tax total',
};
const HARD_FLAGS = ['no_agreement', 'unsupported_currency', 'currency_country_mismatch', 'implausible', 'credit_unknown_reference', 'credit_amount_mismatch',
  'credit_already_applied', 'credit_original_not_payable', 'cdr_duplicate_conflict', 'not_delivered'];

const label = (s) => String(s ?? '').replace(/_/g, ' ');
const st = (map, v) => tag(map[v] ?? 't-mute', label(v ?? '—'));
const money = (minor, cur) => (minor == null ? '—' : fmt.money(minor, cur));
const flagChips = (flags) => (flags?.length
  ? `<div class="chips">${flags.map((f) => tag(HARD_FLAGS.includes(f) ? 't-crit' : 't-warn', label(f), FLAG_TEXT[f] ?? '', true)).join('')}</div>` : '');
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '' && v !== false)).toString();
const shortId = (id) => String(id ?? '').slice(0, 8);
const today = () => new Date().toISOString().slice(0, 10);
const prevMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const act = (path, body, success, method = 'POST') => attempt(() => api(path, { method, body }), { success });

/** Amounts grouped by currency, one line each: never one figure across currencies. */
function perCurrency(rows, key, { cur = 'currency', empty = '—' } = {}) {
  const by = {};
  for (const r of rows) by[r[cur]] = (by[r[cur]] ?? 0) + Number(r[key] ?? 0);
  const keys = Object.keys(by).sort();
  return keys.length ? keys.map((c) => `<div class="nowrap">${esc(money(by[c], c))}</div>`).join('') : empty;
}

/** A document (PDF, CSV) fetched with the session and saved; HTML opens in a new tab. */
async function fetchDoc(path, filename, btn) {
  btn?.classList.add('busy');
  try {
    const res = await api(path, { raw: true });
    download(filename, await res.blob());
  } catch (e) { if (e.status !== 401) toast(e.message, 'crit'); } finally { btn?.classList.remove('busy'); }
}
const docButtons = (kind, row, formats) => `<div class="row" style="gap:4px;flex-wrap:nowrap">${formats.map((f) =>
  `<button class="btn sm" type="button" data-doc="${esc(kind)}|${esc(row.id)}|${esc(f)}|${esc(row.number ?? row.id)}">${f === 'html' ? 'View' : f.toUpperCase()}</button>`).join('')}</div>`;
function wireDocs(root, base) {
  $$('[data-doc]', root).forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const [kind, id, f, number] = b.dataset.doc.split('|');
    const path = `${base}/${kind}/${id}/${f}`;
    if (f === 'html') window.open(path, '_blank', 'noopener');
    else fetchDoc(path, `hub-${kind === 'statements' ? 'statement' : 'fee-invoice'}-${number}.${f}`, b);
  }));
}

/** Sub-navigation inside a tab (a segmented control); remembers the choice per screen. */
function subnav(root, items, current, onPick) {
  root.innerHTML = `<div class="seg" role="group" aria-label="Section" style="margin-bottom:14px">${items.map(([id, l]) =>
    `<button type="button" data-sub="${esc(id)}" aria-pressed="${id === current}">${esc(l)}</button>`).join('')}</div><div data-sub-body></div>`;
  $$('[data-sub]', root).forEach((b) => b.addEventListener('click', () => {
    $$('[data-sub]', root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    onPick(b.dataset.sub);
  }));
  return $('[data-sub-body]', root);
}

// ─────────────────────────────────────────── ledger (shared)
function ledgerColumns(mode) {
  return [
    { label: 'Received', render: (c) => `<span class="nowrap">${esc(fmt.date(c.received_at))}</span><div class="cell-sub nowrap">${esc(fmt.timeS(c.received_at))}</div>` },
    { label: 'CDR', render: (c) => `<div class="cell-title mono" style="min-width:8rem">${esc(c.cdr_id)}</div>${c.credit ? tag('t-info', 'credit', '', true) : ''}<div class="cell-sub">${esc(c.source)}</div>` },
    { label: mode === 'member' ? 'Counterparty' : 'CPO → eMSP', render: (c) => mode === 'member'
      ? `<div>${esc(c.side === 'cpo' ? c.emsp_member_name : c.cpo_member_name)}</div><div class="cell-sub">${c.side === 'cpo' ? 'you are the CPO' : 'you are the eMSP'} · <span class="mono">${esc(c.side === 'cpo' ? c.emsp : c.cpo)}</span></div>`
      : `<div class="mono nowrap">${esc(c.cpo)} → ${esc(c.emsp)}</div><div class="cell-sub">${esc(c.cpo_member_name ?? '')} → ${esc(c.emsp_member_name ?? '')}</div>` },
    { label: 'Amount', num: true, render: (c) => `<b>${esc(money(c.total_incl_minor ?? c.total_excl_minor, c.currency))}</b><div class="cell-sub">excl. ${esc(money(c.total_excl_minor, c.currency))}</div>` },
    { label: 'Energy', num: true, render: (c) => `${fmt.num(c.energy_kwh, 2)} kWh` },
    { label: 'Status', render: (c) => `${st(CDR_TAG, c.status)}${flagChips(c.flags)}` },
    { label: 'Dispute until', render: (c) => (c.status === 'pending' && c.dispute_deadline ? `<span class="nowrap">${esc(fmt.date(c.dispute_deadline))}</span>` : '—') },
    { label: 'Settled', render: (c) => (c.settlement_run_id ? tag('t-ok', 'in a run', '', true) : '<span class="cell-sub">not yet</span>') },
  ];
}

/** The ledger with filters, cursor paging and CSV. `fixed` filters are applied silently (e.g. a run). */
async function ledger(root, { base, mode, members = [], preset = {}, onChange, openTrace = null }) {
  const f = { status: '', flag: '', currency: '', member: '', side: '', q: '', unsettled: false, from: '', to: '', ...preset };
  root.innerHTML = `<div class="filters">
      ${field('Status', `<select data-lf="status">${options([{ value: '', label: 'All' }, ...Object.keys(CDR_TAG).map((s) => ({ value: s, label: label(s) })), { value: 'pending,disputed', label: 'pending or disputed' }], f.status)}</select>`)}
      ${mode === 'platform' ? field('Flag', `<select data-lf="flag">${options([{ value: '', label: 'Any' }, ...Object.keys(FLAG_TEXT).map((x) => ({ value: x, label: label(x) }))], f.flag)}</select>`) : field('Side', `<select data-lf="side">${options([{ value: '', label: 'Both' }, { value: 'cpo', label: 'As CPO (we are paid)' }, { value: 'emsp', label: 'As eMSP (we pay)' }], f.side)}</select>`)}
      ${field('Currency', `<select data-lf="currency">${options([{ value: '', label: 'All' }, ...CURS], f.currency)}</select>`)}
      ${mode === 'platform' ? field('Member', `<select data-lf="member">${options([{ value: '', label: 'All members' }, ...members.map((m) => ({ value: m.id, label: m.legal_name }))], f.member)}</select>`) : ''}
      ${field('From', '<input type="date" data-lf="from">', { opt: true })}
      ${field('To', '<input type="date" data-lf="to">', { opt: true })}
      ${field('CDR or session id', '<input type="search" data-lf="q" placeholder="CDR-…" autocomplete="off">')}
      <label class="check" style="align-self:center"><input type="checkbox" data-lf="unsettled"${f.unsettled ? ' checked' : ''}> <span>Not settled yet</span></label>
      <div class="row right"><button class="btn" type="button" data-csv>${icon('download')} CSV</button></div>
    </div><div class="card" data-t></div><div class="row" style="justify-content:center;margin-top:10px"><button class="btn sm" type="button" data-more hidden>Load more</button></div>`;
  $('[data-lf="q"]', root).value = f.q;
  $('[data-lf="from"]', root).value = f.from;
  $('[data-lf="to"]', root).value = f.to;
  let rows = [], next = null;
  const query = (cursor) => qs({ status: f.status, flag: f.flag, currency: f.currency, member: f.member, side: f.side, q: f.q.trim(), unsettled: f.unsettled ? 'true' : '',
    from: f.from, to: f.to ? `${f.to}T23:59:59` : '', run: preset.run, cursor, limit: 100 });
  const draw = () => {
    table($('[data-t]', root), { columns: ledgerColumns(mode), rows, empty: 'No CDRs match.', onRow: (c) => openCdr(c.id, { base, mode, openTrace, onChange: () => { load(); onChange?.(); } }) });
    $('[data-more]', root).hidden = !next;
  };
  const load = async () => {
    try { const r = await api(`${base}/cdrs?${query()}`); rows = r.cdrs; next = r.next_cursor; } catch (e) { $('[data-t]', root).innerHTML = callout('crit', esc(e.message)); return; }
    draw();
  };
  $$('select[data-lf]', root).forEach((s) => s.addEventListener('change', () => { f[s.dataset.lf] = s.value; load(); }));
  $$('input[type=date][data-lf]', root).forEach((s) => s.addEventListener('change', () => { f[s.dataset.lf] = s.value; load(); }));
  $('[data-lf="q"]', root).addEventListener('input', debounce((e) => { f.q = e.target.value; load(); }, 300));
  $('[data-lf="unsettled"]', root).addEventListener('change', (e) => { f.unsettled = e.target.checked; load(); });
  $('[data-more]', root).addEventListener('click', async (e) => {
    const b = e.currentTarget; b.classList.add('busy');
    try { const r = await api(`${base}/cdrs?${query(next)}`); rows = rows.concat(r.cdrs); next = r.next_cursor; draw(); } catch (err) { toast(err.message, 'crit'); } finally { b.classList.remove('busy'); }
  });
  $('[data-csv]', root).addEventListener('click', (e) => fetchDoc(`${base}/cdrs.csv?${query().replace(/(^|&)limit=\d+/, '')}`, `hub-ledger-${today()}.csv`, e.currentTarget));
  await load();
}

/** One ledger row: amounts, flags, routing, disputes, credits, the CDR as received; the actions this caller may take. */
function openCdr(id, { base, mode, onChange, openTrace = null }) {
  let r = null;
  let d = null;
  const load = async () => {
    r = await api(`${base}/cdrs/${id}`);
    const c = r.cdr;
    $('h2', d.el).textContent = `CDR ${c.cdr_id}`;
    d.setSubtitle(`${st(CDR_TAG, c.status)} <span class="mono cell-sub">${esc(c.cpo)} → ${esc(c.emsp)}</span>`);
    const can = [];
    if (mode === 'platform' && c.status === 'held') can.push('<button class="btn sm primary" type="button" data-ca="release">Release</button>', '<button class="btn sm danger" type="button" data-ca="void">Void</button>');
    if (c.status === 'pending' && (mode === 'platform' || c.side === 'emsp') && (!c.dispute_deadline || new Date(c.dispute_deadline) > new Date())) can.push('<button class="btn sm" type="button" data-ca="dispute">Raise a dispute</button>');
    if (r.disputes?.length) can.push(`<button class="btn sm" type="button" data-ca="open-dispute">Open dispute</button>`);
    d.setHeader(can.length ? `<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">${can.join('')}</div>` : '');
    $$('[data-ca]', d.el).forEach((b) => b.addEventListener('click', () => action(b.dataset.ca)));
  };
  const renderDetail = async (b) => {
    if (!r) await load();
    const c = r.cdr;
    const cur = c.currency;
    b.innerHTML = `
      ${c.status === 'held' ? callout('crit', `<b>Held:</b> forwarded to the eMSP but not payable until the platform releases it. ${esc((c.flags ?? []).filter((f) => HARD_FLAGS.includes(f)).map((f) => FLAG_TEXT[f] ?? label(f)).join('; '))}${c.hold_note ? `<br>${esc(c.hold_note)}` : ''}`) : ''}
      <div class="grid two">
        <div class="card"><header><h3>Charge</h3></header><div class="body"><dl class="kv">
          <dt>Total incl. tax</dt><dd><b>${esc(money(c.total_incl_minor, cur))}</b></dd>
          <dt>Total excl. tax</dt><dd>${esc(money(c.total_excl_minor, cur))}</dd>
          <dt>Energy</dt><dd>${fmt.num(c.energy_kwh, 3)} kWh</dd>
          <dt>Session</dt><dd>${esc(fmt.time(c.start_at))} – ${esc(fmt.timeS(c.end_at))}<div class="cell-sub mono">${esc(c.session_id ?? '—')}</div></dd>
          <dt>Location</dt><dd><span class="mono">${esc(c.location_id ?? '—')}</span> ${esc(c.location_country ?? '')}<div class="cell-sub mono">${esc(c.evse_uid ?? '')}</div></dd>
          <dt>Token</dt><dd>${esc(c.token_type ?? '—')} <span class="mono">${esc(c.contract_id ?? '')}</span><div class="cell-sub">${esc(label(c.auth_method ?? ''))}</div></dd>
          ${c.credit ? `<dt>Credit of</dt><dd class="mono">${esc(c.credit_reference_id ?? '—')}</dd>` : ''}
        </dl></div></div>
        <div class="card"><header><h3>Clearing</h3></header><div class="body"><dl class="kv">
          <dt>CPO</dt><dd><span class="mono">${esc(c.cpo)}</span> ${esc(c.cpo_member_name ?? '')}</dd>
          <dt>eMSP</dt><dd><span class="mono">${esc(c.emsp)}</span> ${esc(c.emsp_member_name ?? '')}</dd>
          <dt>Status</dt><dd>${st(CDR_TAG, c.status)} ${flagChips(c.flags)}</dd>
          <dt>Received</dt><dd>${esc(fmt.time(c.received_at))} · ${esc(c.source)} · ${esc(label(c.forward_state ?? ''))}</dd>
          <dt>Dispute window</dt><dd>${c.dispute_deadline ? `until ${esc(fmt.time(c.dispute_deadline))}` : '—'}</dd>
          <dt>Accepted</dt><dd>${esc(c.accepted_at ? fmt.time(c.accepted_at) : '—')}</dd>
          <dt>Commission</dt><dd>${c.fee_cpo_minor == null && c.fee_emsp_minor == null ? '<span class="cell-sub">set when accepted</span>' : `CPO ${esc(money(c.fee_cpo_minor, cur))} · eMSP ${esc(money(c.fee_emsp_minor, cur))}`}</dd>
          <dt>Settlement</dt><dd>${c.settlement_run_id ? `run <span class="mono">${esc(shortId(c.settlement_run_id))}</span>` : 'not settled yet'}</dd>
          ${mode === 'platform' && c.routing?.correlation_id ? `<dt>Correlation id</dt><dd class="mono">${esc(c.routing.correlation_id)}${openTrace ? ' <button class="btn sm" type="button" data-trace>Trace</button>' : ''}</dd>` : ''}
        </dl></div></div>
      </div>
      ${r.related?.length ? `<div class="card section"><header><h3>Credit links</h3></header><div data-rel></div></div>` : ''}
      ${r.disputes?.length ? `<div class="card section"><header><h3>Disputes</h3></header><div data-disp></div></div>` : ''}`;
    if (r.related?.length) table($('[data-rel]', b), { columns: [
      { label: 'CDR', render: (x) => `<span class="mono">${esc(x.cdr_id)}</span> ${x.credit ? tag('t-info', 'credit', '', true) : ''}` },
      { label: 'Status', render: (x) => st(CDR_TAG, x.status) },
      { label: 'Amount', num: true, render: (x) => esc(money(x.total_incl_minor ?? x.total_excl_minor, cur)) },
    ], rows: r.related, onRow: (x) => openCdr(x.id, { base, mode, onChange, openTrace }) });
    if (r.disputes?.length) table($('[data-disp]', b), { columns: [
      { label: 'Opened', render: (x) => esc(fmt.date(x.created_at)) },
      { label: 'Reason', render: (x) => esc(label(x.reason)) },
      { label: 'Claimed', num: true, render: (x) => esc(money(x.claimed_minor, x.currency)) },
      { label: 'Status', render: (x) => st(DISPUTE_TAG, x.status) },
    ], rows: r.disputes, onRow: (x) => openDispute(x.id, { base, mode, onChange: () => { d.refresh(); onChange?.(); } }) });
    $('[data-trace]', b)?.addEventListener('click', () => openTrace(c.routing.correlation_id));
  };
  const action = async (a) => {
    const c = r.cdr;
    if (a === 'open-dispute') return openDispute(r.disputes[r.disputes.length - 1].id, { base, mode, onChange: () => { load().then(() => d.refresh()); onChange?.(); } });
    if (a === 'dispute') return raiseDisputeDialog(c, base, async () => { await load(); d.refresh(); onChange?.(); });
    const spec = a === 'release'
      ? { title: `Release CDR ${c.cdr_id}?`, message: 'It becomes payable: pending until its dispute window ends, then accepted and settled in the next run.', confirmLabel: 'Release' }
      : { title: `Void CDR ${c.cdr_id}?`, message: 'Final: it is never settled. Use it for a CDR the CPO sent in error (the eMSP has it, but owes nothing for it).', confirmLabel: 'Void', danger: true, requireText: 'VOID' };
    const reason = await reasonDialog({ ...spec, reasonLabel: 'Note' });
    if (reason === null) return;
    if (await act(`${base}/cdrs/${c.id}/${a}`, { note: reason }, a === 'release' ? 'CDR released' : 'CDR voided')) { await load(); d.refresh(); onChange?.(); }
  };
  d = drawer({
    title: 'CDR',
    tabs: [
      { id: 'detail', label: 'Detail', render: (b) => renderDetail(b) },
      { id: 'body', label: 'As received', render: async (b) => { if (!r) await load(); b.innerHTML = `<pre class="json" style="max-height:none">${esc(JSON.stringify(r.cdr.body ?? {}, null, 2))}</pre>`; } },
    ],
  });
  return d;
}

function raiseDisputeDialog(c, base, done) {
  reasonForm({
    title: `Dispute CDR ${c.cdr_id}`,
    message: `The CPO answers within its response window: it accepts (and sends a credit CDR) or rejects. Until the dispute ends the CDR is not settled. Total: ${money(c.total_incl_minor ?? c.total_excl_minor, c.currency)}.`,
    confirmLabel: 'Raise dispute', reasonLabel: 'Message to the CPO',
    extra: `<div class="form" style="margin-bottom:12px">
      ${field('Reason', `<select name="dreason">${options(REASONS.map(([v, l]) => ({ value: v, label: l })), 'amount')}</select>`)}
      ${field(`Correct amount (${c.currency})`, `<input name="claimed" inputmode="decimal" placeholder="${esc(String(toMajor(c.total_incl_minor ?? c.total_excl_minor ?? 0, c.currency)))}">`, { opt: true, help: 'What it should have been, incl. tax.' })}
    </div>`,
    validate: (v) => (v.claimed && !(toMinor(v.claimed, c.currency) >= 0) ? { claimed: 'An amount, e.g. 12.50' } : {}),
  }).then(async (r) => {
    if (!r) return;
    const body = { reason: r.values.dreason, message: r.reason, ...(r.values.claimed ? { claimed_minor: toMinor(r.values.claimed, c.currency) } : {}) };
    if (await act(`${base}/cdrs/${c.id}/dispute`, body, 'Dispute raised')) done();
  });
}

// ─────────────────────────────────────────── disputes (shared)
function disputeColumns(mode) {
  return [
    { label: 'Opened', render: (x) => `<span class="nowrap">${esc(fmt.date(x.created_at))}</span>` },
    { label: 'CDR', render: (x) => `<span class="mono">${esc(x.cdr_id)}</span><div class="cell-sub">${esc(label(x.reason))}</div>` },
    { label: mode === 'member' ? 'Counterparty' : 'CPO / eMSP', render: (x) => (mode === 'member'
      ? `${esc(x.side === 'cpo' ? x.emsp_member_name : x.cpo_member_name)}<div class="cell-sub">${x.side === 'cpo' ? 'against you (CPO)' : 'raised by you (eMSP)'}</div>`
      : `${esc(x.cpo_member_name ?? '')}<div class="cell-sub">${esc(x.emsp_member_name ?? '')}</div>`) },
    { label: 'Claimed', num: true, render: (x) => esc(money(x.claimed_minor, x.currency)) },
    { label: 'Status', render: (x) => `${st(DISPUTE_TAG, x.status)}${x.resolution ? `<div class="cell-sub">${esc(label(x.resolution))}</div>` : ''}` },
    { label: 'Next deadline', render: (x) => { const dl = x.status === 'open' ? ['answer by', x.respond_by] : x.status === 'accepted' ? ['credit by', x.credit_due_by] : x.status === 'rejected' ? ['escalate by', x.escalate_by] : null; return dl && dl[1] ? `<span class="nowrap">${esc(dl[0])} ${esc(fmt.date(dl[1]))}</span>` : '—'; } },
  ];
}

async function disputeList(root, { base, mode, onChange }) {
  let status = 'open,accepted,rejected,escalated';
  root.innerHTML = `<div class="filters">${field('Status', `<select data-ds>${options([{ value: 'open,accepted,rejected,escalated', label: 'Live' }, { value: '', label: 'All' }, ...Object.keys(DISPUTE_TAG).map((s) => ({ value: s, label: label(s) }))], status)}</select>`)}</div><div class="card" data-t></div>`;
  const load = async () => {
    const { disputes } = await api(`${base}/disputes?${qs({ status })}`);
    table($('[data-t]', root), { columns: disputeColumns(mode), rows: disputes, empty: 'No disputes.', onRow: (x) => openDispute(x.id, { base, mode, onChange: () => { load(); onChange?.(); } }) });
  };
  $('[data-ds]', root).addEventListener('change', (e) => { status = e.target.value; load(); });
  await load();
}

function openDispute(id, { base, mode, onChange }) {
  let r = null;
  let d = null;
  const render = async (b) => {
    r = await api(`${base}/disputes/${id}`);
    const x = r.dispute;
    $('h2', d.el).textContent = `Dispute on CDR ${x.cdr_id}`;
    d.setSubtitle(`${st(DISPUTE_TAG, x.status)} <span class="cell-sub">${esc(label(x.reason))}</span>`);
    const live = LIVE_DISPUTE.includes(x.status);
    const btns = [];
    if (mode === 'platform' && live) {
      btns.push('<button class="btn sm primary" type="button" data-da="resolve">Resolve</button>');
      if (['open', 'accepted', 'rejected'].includes(x.status)) btns.push('<button class="btn sm" type="button" data-da="escalate">Escalate</button>');
      btns.push('<button class="btn sm" type="button" data-da="withdraw">Withdraw</button>');
    }
    if (mode === 'member' && x.side === 'cpo' && x.status === 'open') btns.push('<button class="btn sm primary" type="button" data-da="accept">Accept</button>', '<button class="btn sm danger" type="button" data-da="reject">Reject</button>');
    if (mode === 'member' && x.side === 'emsp' && x.status === 'rejected') btns.push('<button class="btn sm primary" type="button" data-da="escalate">Escalate to PlugSure</button>');
    if (mode === 'member' && x.side === 'emsp' && live) btns.push('<button class="btn sm" type="button" data-da="withdraw">Withdraw</button>');
    d.setHeader(btns.length ? `<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">${btns.join('')}</div>` : '');
    $$('[data-da]', d.el).forEach((btn) => btn.addEventListener('click', () => action(btn.dataset.da)));
    b.innerHTML = `<div class="card"><div class="body"><dl class="kv">
        <dt>CDR</dt><dd><span class="mono">${esc(x.cdr_id)}</span></dd>
        <dt>CPO / eMSP</dt><dd>${esc(x.cpo_member_name ?? '—')} / ${esc(x.emsp_member_name ?? '—')}</dd>
        <dt>Reason</dt><dd>${esc(label(x.reason))}</dd>
        <dt>Claimed</dt><dd>${esc(money(x.claimed_minor, x.currency))}</dd>
        <dt>Raised by</dt><dd>${esc(x.raised_by)} · ${esc(fmt.time(x.created_at))}</dd>
        <dt>Deadlines</dt><dd>${x.respond_by ? `CPO answers by ${esc(fmt.time(x.respond_by))}<br>` : ''}${x.credit_due_by ? `credit CDR by ${esc(fmt.time(x.credit_due_by))}<br>` : ''}${x.escalate_by ? `eMSP may escalate until ${esc(fmt.time(x.escalate_by))}` : ''}${!x.respond_by && !x.credit_due_by && !x.escalate_by ? '—' : ''}</dd>
        ${x.resolution ? `<dt>Resolution</dt><dd>${esc(label(x.resolution))} · ${esc(fmt.time(x.resolved_at))}</dd>` : ''}
      </dl></div></div>
      <h4 style="margin:16px 0 8px">History and notes</h4>
      <ol class="trace">${r.notes.map((n) => `<li class="card"><div class="row" style="gap:8px">${tag(n.side === 'platform' ? 't-info' : n.side === 'cpo' ? 't-ok' : n.side === 'emsp' ? 't-warn' : 't-mute', n.side === 'emsp' ? 'eMSP' : n.side === 'cpo' ? 'CPO' : n.side, '', true)}<span class="cell-sub">${esc(label(n.kind))}</span><span class="right cell-sub nowrap">${esc(fmt.time(n.created_at))}</span></div>${n.body ? `<div class="wrap" style="margin-top:6px">${esc(n.body)}</div>` : ''}</li>`).join('')}</ol>
      <form class="form one section" data-note novalidate>${field('Add a note (both sides see it)', '<textarea name="note" rows="2" maxlength="2000" style="font-family:var(--sans);font-size:13px;min-height:56px"></textarea>')}<div><button class="btn sm" type="submit">Add note</button></div></form>`;
    $('[data-note]', b).addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(e.currentTarget);
      if (!String(v.note ?? '').trim()) return fieldErrors(e.currentTarget, { note: 'Write the note' });
      if (await act(`${base}/disputes/${id}/notes`, { note: v.note.trim() }, 'Note added')) d.refresh();
    });
  };
  const action = async (a) => {
    const x = r.dispute;
    let path = `${base}/disputes/${id}/${a}`, body;
    if (a === 'resolve') {
      const res = await reasonForm({
        title: 'Resolve the dispute', message: 'The platform decides an escalated dispute. The note is shown to both members.', confirmLabel: 'Resolve', reasonLabel: 'Note',
        extra: field('Outcome', `<select name="outcome">${options([{ value: 'upheld', label: 'Upheld — the CDR stands, the eMSP pays' }, { value: 'credit_required', label: 'Credit required — the CPO must send a credit CDR' }, { value: 'written_off', label: 'Written off — nobody pays this CDR' }], 'upheld')}</select>`),
      });
      if (!res) return;
      body = { outcome: res.values.outcome, note: res.reason };
    } else if (a === 'accept' || a === 'reject') {
      const note = await reasonDialog({
        title: a === 'accept' ? 'Accept the dispute?' : 'Reject the dispute?',
        message: a === 'accept' ? 'You agree: send a credit CDR (and a corrected CDR if needed) before the credit deadline, or it is escalated.' : 'Explain why the CDR is right. The eMSP may escalate to PlugSure.',
        confirmLabel: a === 'accept' ? 'Accept' : 'Reject', danger: a === 'reject', reasonLabel: 'Note to the eMSP',
      });
      if (note === null) return;
      path = `${base}/disputes/${id}/respond`;
      body = { action: a, note };
    } else {
      const note = await reasonDialog({
        title: a === 'escalate' ? 'Escalate to PlugSure?' : 'Withdraw the dispute?',
        message: a === 'escalate' ? 'PlugSure decides: the CDR stands, a credit is required, or it is written off.' : 'Final: the CDR is payable again (or accepted if its window has passed).',
        confirmLabel: a === 'escalate' ? 'Escalate' : 'Withdraw', danger: a === 'withdraw', reasonLabel: 'Note', reasonRequired: a === 'withdraw' || mode === 'platform',
      });
      if (note === null) return;
      body = { note: note || undefined };
    }
    if (await act(path, body, `Dispute ${a === 'resolve' ? 'resolved' : a === 'accept' ? 'accepted' : a === 'reject' ? 'rejected' : a === 'escalate' ? 'escalated' : 'withdrawn'}`)) {
      void x;
      d.refresh(); onChange?.();
    }
  };
  d = drawer({ title: 'Dispute', tabs: [{ id: 'd', label: 'Dispute', render: (b) => render(b) }] });
  return d;
}

// ─────────────────────────────────────────── documents and payments (shared)
async function statementsTable(root, { base, mode, q = {} }) {
  const { statements } = await api(`${base}/statements?${qs(q)}`);
  table(root, {
    columns: [
      { label: 'Statement', render: (s) => `<div class="cell-title mono nowrap">${esc(s.number)}</div><div class="cell-sub">${esc(s.period)} · ${esc(fmt.date(s.issued_at))}</div>` },
      ...(mode === 'platform' ? [{ label: 'Member', render: (s) => esc(s.member_name ?? '') }] : []),
      { label: 'Receivable', num: true, render: (s) => esc(money(s.receivable_minor, s.currency)) },
      { label: 'Payable', num: true, render: (s) => esc(money(s.payable_minor, s.currency)) },
      { label: 'Net', num: true, render: (s) => `<b>${esc(money(s.net_minor, s.currency))}</b>` },
      { label: 'Commission', num: true, render: (s) => esc(money(s.fee_net_minor, s.currency)) },
      { label: 'CDRs', num: true, render: (s) => fmt.num(s.cdr_count) },
      { label: '', render: (s) => docButtons('statements', s, ['html', 'pdf', 'csv']) },
    ],
    rows: statements,
    empty: 'No statements yet: one is issued per member when a settlement run is finalised.',
  });
  wireDocs(root, base);
}

async function invoicesTable(root, { base, mode, q = {}, onChange }) {
  const { feeInvoices } = await api(`${base}/fee-invoices?${qs(q)}`);
  table(root, {
    columns: [
      { label: 'Fee invoice', render: (i) => `<div class="cell-title mono nowrap">${esc(i.number)}</div><div class="cell-sub">${esc(fmt.date(i.issued_at))} · issuer ${esc(i.entity_country)}</div>` },
      ...(mode === 'platform' ? [{ label: 'Member', render: (i) => esc(i.member_name ?? '') }] : []),
      { label: 'Net', num: true, render: (i) => esc(money(i.net_minor, i.currency)) },
      { label: 'Tax', num: true, render: (i) => `${esc(money(i.tax_minor, i.currency))}<div class="cell-sub">${esc(label(i.tax_scheme ?? ''))}</div>` },
      { label: 'Total', num: true, render: (i) => `<b>${esc(money(i.total_minor, i.currency))}</b>${Number(i.wht_expected_minor) ? `<div class="cell-sub">PPh 23 ${esc(money(i.wht_expected_minor, i.currency))}</div>` : ''}` },
      { label: 'Status', render: (i) => `${st(INV_TAG, i.status)}<div class="cell-sub">${i.paid_at ? `paid ${esc(i.paid_at)}` : `due ${esc(i.due_date ?? '—')}`}</div>` },
      { label: '', render: (i) => `<div class="row" style="gap:4px;flex-wrap:nowrap">${docButtons('fee-invoices', i, ['html', 'pdf'])}${mode === 'platform' && i.status !== 'paid' ? `<button class="btn sm" type="button" data-paid="${esc(i.id)}">Mark paid</button>` : ''}</div>` },
    ],
    rows: feeInvoices,
    empty: 'No fee invoices yet: PlugSure invoices its commission per member when a run is finalised.',
  });
  wireDocs(root, base);
  $$('[data-paid]', root).forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const i = feeInvoices.find((x) => x.id === b.dataset.paid);
    const r = await reasonForm({
      title: `Mark ${i.number} paid?`, message: `Total ${money(i.total_minor, i.currency)} from ${i.member_name ?? 'the member'}.`, confirmLabel: 'Mark paid', reasonLabel: 'Note', reasonRequired: false,
      extra: `<div class="form">${field('Paid on', `<input name="paid_at" type="date" value="${today()}">`)}${field('Reference', '<input name="reference" maxlength="200" autocomplete="off">', { opt: true })}</div>`,
      validate: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v.paid_at) ? {} : { paid_at: 'The date it was received' }),
    });
    if (!r) return;
    if (await act(`${base}/fee-invoices/${i.id}/paid`, { paid_at: r.values.paid_at, reference: r.values.reference || undefined }, 'Fee invoice marked paid')) { invoicesTable(root, { base, mode, q, onChange }); onChange?.(); }
  }));
}

const METHODS = [{ value: 'bank_transfer', label: 'Bank transfer' }, { value: 'stripe_connect', label: 'Stripe Connect' }, { value: 'xendit', label: 'Xendit' }, { value: 'other', label: 'Other' }];
function recordPaymentDialog(p, base, done, who) {
  const outstanding = Number(p.outstanding_minor);
  reasonForm({
    title: `Record a payment — ${p.payer_member_name ?? ''} → ${p.payee_member_name ?? ''}`,
    message: `Outstanding ${money(outstanding, p.currency)} of ${money(p.net_minor, p.currency)}, due ${p.due_date ?? '—'}. Partial payments add up.${who === 'payee' ? ' Recorded by the payee, it counts as confirmed.' : who === 'payer' ? ' The payee confirms it.' : ''}`,
    confirmLabel: 'Record payment', reasonLabel: 'Note', reasonRequired: false,
    extra: `<div class="form" style="margin-bottom:12px">
      ${field(`Amount (${p.currency})`, `<input name="amount" inputmode="decimal" value="${esc(String(toMajor(outstanding, p.currency)))}">`)}
      ${field('Paid on', `<input name="paid_at" type="date" value="${today()}">`)}
      ${field('Transfer reference', '<input name="reference" maxlength="200" autocomplete="off">')}
      ${field('Method', `<select name="method">${options(METHODS, 'bank_transfer')}</select>`)}
    </div>`,
    validate: (v) => {
      const e = {};
      const m = toMinor(v.amount, p.currency);
      if (!(m > 0)) e.amount = 'A positive amount';
      else if (m > outstanding) e.amount = `At most the outstanding ${money(outstanding, p.currency)}`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.paid_at)) e.paid_at = 'The transfer date';
      if (!String(v.reference ?? '').trim()) e.reference = 'The bank reference';
      return e;
    },
  }).then(async (r) => {
    if (!r) return;
    const v = r.values;
    if (await act(`${base}/payments`, { position_id: p.id, amount_minor: toMinor(v.amount, p.currency), paid_at: v.paid_at, reference: v.reference.trim(), method: v.method, note: r.reason || undefined }, 'Payment recorded')) done();
  });
}

function positionColumns(mode) {
  return [
    { label: 'Period', render: (p) => `<span class="nowrap">${esc(p.period ?? '—')}</span><div class="cell-sub">${esc(p.currency)}</div>` },
    { label: mode === 'member' ? 'With' : 'Payer → payee', render: (p) => (mode === 'member'
      ? `<div style="min-width:8rem">${esc(p.direction === 'pay' ? p.payee_member_name : p.direction === 'receive' ? p.payer_member_name : `${p.member_a_name ?? ''} / ${p.member_b_name ?? ''}`)}</div><div class="cell-sub">${p.direction === 'pay' ? 'you pay' : p.direction === 'receive' ? 'you receive' : 'nothing due'}</div>`
      : `<div style="min-width:9rem">${esc(p.payer_member_name ?? p.member_a_name ?? '')}</div><div class="cell-sub">→ ${esc(p.payee_member_name ?? p.member_b_name ?? '')}</div>`) },
    { label: 'Net', num: true, render: (p) => `<b>${esc(money(p.net_minor, p.currency))}</b><div class="cell-sub">${fmt.num(p.cdr_count)} CDRs</div>` },
    { label: 'Paid', num: true, render: (p) => esc(money(p.paid_minor, p.currency)) },
    { label: 'Outstanding', num: true, render: (p) => (Number(p.outstanding_minor) > 0 ? `<b>${esc(money(p.outstanding_minor, p.currency))}</b>` : esc(money(0, p.currency))) },
    { label: 'Status', render: (p) => `${st(POS_TAG, p.status)}<div class="cell-sub">due ${esc(p.due_date ?? '—')}</div>` },
  ];
}

async function positionsAndPayments(root, { base, mode, onChange }) {
  let status = '', currency = '';
  root.innerHTML = `<div class="filters">
      ${field('Status', `<select data-ps>${options([{ value: '', label: 'All' }, { value: 'open,partially_paid,overdue,paid', label: 'Outstanding' }, ...Object.keys(POS_TAG).map((s) => ({ value: s, label: label(s) }))], status)}</select>`)}
      ${field('Currency', `<select data-pc>${options([{ value: '', label: 'All' }, ...CURS], currency)}</select>`)}
    </div>
    <div class="card"><header><h3>Positions</h3><span class="cell-sub right">bilateral net per settlement run</span></header><div data-pos></div></div>
    <div class="card section"><header><h3>Payments</h3></header><div data-pays></div></div>`;
  const self = mode === 'member' ? (await api(`${base}/summary`)).member.id : null;
  const load = async () => {
    const [{ positions }, { payments }] = await Promise.all([api(`${base}/positions?${qs({ status, currency })}`), api(`${base}/payments`)]);
    const posById = new Map(positions.map((p) => [p.id, p]));
    const canPay = (p) => ['open', 'partially_paid', 'overdue'].includes(p.status) && (mode === 'platform' || p.direction === 'pay' || p.direction === 'receive');
    table($('[data-pos]', root), {
      columns: [...positionColumns(mode), { label: '', render: (p) => `<div class="row" style="gap:4px;flex-wrap:nowrap">${canPay(p) ? `<button class="btn sm" type="button" data-pay="${esc(p.id)}">Record payment</button>` : ''}${mode === 'platform' && ['open', 'partially_paid', 'overdue'].includes(p.status) ? `<button class="btn sm danger" type="button" data-wo="${esc(p.id)}">Write off</button>` : ''}</div>` }],
      rows: positions,
      empty: 'No positions yet: they are written when a settlement run is finalised.',
    });
    table($('[data-pays]', root), {
      columns: [
        { label: 'Paid on', render: (y) => `<span class="nowrap">${esc(y.paid_at)}</span>` },
        { label: 'Payer → payee', render: (y) => `${esc(y.payer_member_name ?? '')}<div class="cell-sub">→ ${esc(y.payee_member_name ?? '')}</div>` },
        { label: 'Amount', num: true, render: (y) => `<b>${esc(money(y.amount_minor, y.currency))}</b>` },
        { label: 'Reference', render: (y) => `<span class="mono">${esc(y.reference)}</span><div class="cell-sub">${esc(label(y.method))} · recorded by ${esc(y.recorded_side)}</div>` },
        { label: 'Confirmed', render: (y) => (y.confirmed_by_payee_at ? tag('t-ok', 'confirmed') : `${tag('t-warn', 'awaiting payee')}${mode === 'platform' || y.payee_member_id === self ? ` <button class="btn sm" type="button" data-confirm="${esc(y.id)}">Confirm received</button>` : ''}`) },
      ],
      rows: payments,
      empty: 'No payments recorded.',
    });
    $$('[data-pay]', root).forEach((b) => b.addEventListener('click', () => {
      const p = posById.get(b.dataset.pay);
      recordPaymentDialog(p, base, () => { load(); onChange?.(); }, mode === 'platform' ? 'platform' : p.direction === 'pay' ? 'payer' : 'payee');
    }));
    $$('[data-wo]', root).forEach((b) => b.addEventListener('click', async () => {
      const p = posById.get(b.dataset.wo);
      const note = await reasonDialog({ title: 'Write off the outstanding balance?', message: `${money(p.outstanding_minor, p.currency)} owed by ${p.payer_member_name ?? ''} to ${p.payee_member_name ?? ''} is closed without payment. Final.`, confirmLabel: 'Write off', danger: true, requireText: 'WRITE OFF', reasonLabel: 'Note' });
      if (note === null) return;
      if (await act(`${base}/positions/${p.id}/write-off`, { note }, 'Position written off')) { load(); onChange?.(); }
    }));
    $$('[data-confirm]', root).forEach((b) => b.addEventListener('click', async () => {
      if (await act(`${base}/payments/${b.dataset.confirm}/confirm`, {}, 'Payment confirmed')) { load(); onChange?.(); }
    }));
  };
  $('[data-ps]', root).addEventListener('change', (e) => { status = e.target.value; load(); });
  $('[data-pc]', root).addEventListener('change', (e) => { currency = e.target.value; load(); });
  await load();
}

// ═══════════════════════════════════════════ platform: Hub → Clearing
let platSection = 'overview';

export async function drawClearingPlatform(root, { openTrace } = {}) {
  const { members } = await api('/v1/hub/members');
  const ctx = { base: PLAT, mode: 'platform', members, openTrace };
  const body = subnav(root, [['overview', 'Overview'], ['ledger', 'Ledger'], ['disputes', 'Disputes'], ['runs', 'Settlement runs'], ['payments', 'Positions & payments'],
    ['documents', 'Documents'], ['commission', 'Commission'], ['entities', 'Entities']], platSection, (s) => show(s));
  const show = async (s, preset = {}) => {
    platSection = s;
    $$('[data-sub]', root).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.sub === s)));
    body.innerHTML = '<div class="skeleton" style="height:120px"></div>';
    try {
      if (s === 'overview') await platOverview(body, { ...ctx, go: show });
      else if (s === 'ledger') await ledger(body, { ...ctx, preset });
      else if (s === 'disputes') await disputeList(body, ctx);
      else if (s === 'runs') await runs(body, ctx);
      else if (s === 'payments') await positionsAndPayments(body, ctx);
      else if (s === 'documents') await platDocuments(body, ctx);
      else if (s === 'commission') await commission(body, ctx);
      else await entities(body);
    } catch (e) { if (body.isConnected) body.innerHTML = callout('crit', esc(e.message)); }
  };
  await show(platSection);
}

async function platOverview(root, { go }) {
  const ov = await api(`${PLAT}/overview`);
  const n = (arr, pred = () => true) => arr.filter(pred).reduce((s, x) => s + Number(x.n), 0);
  const held = n(ov.cdrs, (x) => x.status === 'held');
  const live = n(ov.disputes, (x) => LIVE_DISPUTE.includes(x.status));
  const escalated = n(ov.disputes, (x) => x.status === 'escalated');
  const drafts = ov.runs.filter((r) => r.status === 'draft');
  const ready = drafts.filter((r) => new Date(r.finalisable_at) <= new Date());
  const overdue = ov.outstanding.filter((x) => x.status === 'overdue');
  const currencies = [...new Set(ov.cdrs.map((x) => x.currency))].sort();
  const STATUSES = ['held', 'pending', 'disputed', 'accepted', 'credited', 'written_off', 'void'];
  root.innerHTML = `
    <div class="grid k4">
      ${kpi('Held CDRs', fmt.num(held), held ? 'need a decision' : 'none waiting', held ? 'crit' : '')}
      ${kpi('Live disputes', fmt.num(live), `${fmt.num(escalated)} escalated to PlugSure`, escalated ? 'warn' : '')}
      ${kpi('Draft runs', fmt.num(drafts.length), `${fmt.num(ready.length)} ready to finalise`)}
      ${kpi('Outstanding', perCurrency(ov.outstanding, 'outstanding_minor', { empty: fmt.num(0) }), overdue.length ? `${fmt.num(n(overdue))} overdue` : 'nothing overdue', overdue.length ? 'crit' : '')}
    </div>
    <div class="row section" style="gap:8px;justify-content:flex-end"><button class="btn" type="button" data-accept>${icon('check')} Accept due CDRs now</button></div>
    <div class="card section"><header><h3>Ledger by currency</h3><span class="cell-sub right">count · amount incl. tax</span></header><div data-ledger></div></div>
    <div class="grid two section">
      <div class="card"><header><h3>Held, by reason</h3></header><div class="body" data-held></div></div>
      <div class="card"><header><h3>Disputes</h3></header><div class="body" data-disp></div></div>
    </div>
    <div class="grid two section">
      <div class="card"><header><h3>Settlement runs</h3></header><div data-runs></div></div>
      <div class="card"><header><h3>Positions and fee invoices</h3></header><div data-money></div></div>
    </div>`;
  const cell = (cur, s) => { const r = ov.cdrs.find((x) => x.currency === cur && x.status === s); return r ? `${fmt.num(r.n)}<div class="cell-sub nowrap">${esc(money(r.amount_minor, cur))}</div>` : '<span class="cell-sub">—</span>'; };
  table($('[data-ledger]', root), {
    columns: [{ label: 'Currency', render: (c) => `<b>${esc(c)}</b><div class="cell-sub">${esc(CUR_COUNTRY[c] ?? '')}</div>` }, ...STATUSES.map((s) => ({ label: label(s), num: true, render: (c) => cell(c, s) }))],
    rows: currencies, empty: 'No CDRs in the ledger yet.', onRow: (c) => go('ledger', { currency: c }),
  });
  $('[data-held]', root).innerHTML = ov.held.length
    ? `<div class="chips">${ov.held.map((h) => `<button class="btn sm" type="button" data-flag="${esc(h.flag)}" title="${esc(FLAG_TEXT[h.flag] ?? '')}">${esc(label(h.flag))} <span class="pill-count">${fmt.num(h.n)}</span></button>`).join('')}</div>`
    : '<p class="cell-sub" style="margin:0">Nothing held.</p>';
  $$('[data-flag]', root).forEach((b) => b.addEventListener('click', () => go('ledger', { status: 'held', flag: b.dataset.flag })));
  $('[data-disp]', root).innerHTML = ov.disputes.length
    ? `<div class="chips">${ov.disputes.map((x) => tag(DISPUTE_TAG[x.status] ?? 't-mute', `${x.n} ${label(x.status)}`, '', true)).join('')}</div><button class="btn sm" type="button" data-godisp style="margin-top:10px">Open disputes</button>`
    : '<p class="cell-sub" style="margin:0">No disputes.</p>';
  $('[data-godisp]', root)?.addEventListener('click', () => go('disputes'));
  table($('[data-runs]', root), {
    columns: [
      { label: 'Run', render: (r) => `<b>${esc(r.currency)}</b> ${esc(r.period)}<div class="cell-sub">${esc(r.cycle)}</div>` },
      { label: 'Status', render: (r) => `${st(RUN_TAG, r.status)}${r.status === 'draft' ? `<div class="cell-sub">${new Date(r.finalisable_at) <= new Date() ? 'ready to finalise' : `finalisable ${esc(fmt.date(r.finalisable_at))}`}</div>` : ''}` },
    ],
    rows: ov.runs.slice(0, 8), empty: 'No runs yet.', onRow: (r) => openRun(r.id, () => go('overview')),
  });
  const moneyRows = [...ov.outstanding.map((x) => ({ kind: 'Positions', ...x, amount: x.outstanding_minor })), ...ov.feeInvoices.map((x) => ({ kind: 'Fee invoices', ...x, amount: x.total_minor }))];
  table($('[data-money]', root), {
    columns: [
      { label: 'What', render: (x) => `${esc(x.kind)}<div class="cell-sub">${esc(x.currency)}</div>` },
      { label: 'Status', render: (x) => st(x.kind === 'Positions' ? POS_TAG : INV_TAG, x.status) },
      { label: 'Count', num: true, render: (x) => fmt.num(x.n) },
      { label: 'Amount', num: true, render: (x) => esc(money(x.amount, x.currency)) },
    ],
    rows: moneyRows, empty: 'Nothing outstanding.',
  });
  $('[data-accept]', root).addEventListener('click', async () => {
    const r = await act(`${PLAT}/accept-due`, {}, (x) => `${fmt.num(x.accepted)} CDRs accepted`);
    if (r) go('overview');
  });
}

async function runs(root) {
  let currency = '', status = '';
  root.innerHTML = `<div class="filters">
      ${field('Currency', `<select data-rc>${options([{ value: '', label: 'All' }, ...CURS], currency)}</select>`)}
      ${field('Status', `<select data-rs>${options([{ value: '', label: 'All' }, 'draft', 'finalised', 'void'], status)}</select>`)}
      <div class="row right"><button class="btn primary" type="button" data-new>${icon('plus')} New run</button></div>
    </div>
    ${callout('info', 'A run settles one currency for one period: accepted CDRs received in it are netted per member pair. A draft can be refreshed any time; finalising writes positions, statements and fee invoices and cannot be undone (correct with credit CDRs).')}
    <div class="card section" data-t></div>`;
  const load = async () => {
    const r = await api(`${PLAT}/runs?${qs({ currency, status })}`);
    table($('[data-t]', root), {
      columns: [
        { label: 'Period', render: (x) => `<b>${esc(x.period)}</b> <span class="cell-sub">${esc(x.cycle)}</span><div class="cell-sub">${esc(fmt.date(x.period_start, x.time_zone))} – ${esc(fmt.date(new Date(new Date(x.period_end).getTime() - 1), x.time_zone))} ${esc(fmt.tz(x.time_zone))}</div>` },
        { label: 'Currency', render: (x) => esc(x.currency) },
        { label: 'CDRs', num: true, render: (x) => fmt.num(x.cdr_count) },
        { label: 'Status', render: (x) => `${st(RUN_TAG, x.status)}${x.status === 'draft' ? `<div class="cell-sub">${new Date(x.finalisable_at) <= new Date() ? 'ready to finalise' : `finalisable from ${esc(fmt.date(x.finalisable_at))}`}</div>` : x.finalised_at ? `<div class="cell-sub">${esc(fmt.date(x.finalised_at))}</div>` : ''}` },
      ],
      rows: r.runs, empty: 'No settlement runs yet.', onRow: (x) => openRun(x.id, load),
    });
  };
  $('[data-rc]', root).addEventListener('change', (e) => { currency = e.target.value; load(); });
  $('[data-rs]', root).addEventListener('change', (e) => { status = e.target.value; load(); });
  $('[data-new]', root).addEventListener('click', () => modal({
    title: 'New settlement run', subtitle: 'Creates the draft, or refreshes the existing one for that currency and period (idempotent).',
    body: `<div class="form">
      ${field('Currency', `<select name="currency">${options(CURS, CURS[0])}</select>`)}
      ${field('Cycle', `<select name="cycle">${options([{ value: 'monthly', label: 'Monthly' }, { value: 'weekly', label: 'Weekly' }], 'monthly')}</select>`)}
      ${field('Period', `<input name="period" value="${prevMonth()}" placeholder="YYYY-MM">`, { help: 'Monthly: YYYY-MM. Weekly: the Monday, YYYY-MM-DD. In the currency\'s country time zone.' })}
    </div>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Create draft', kind: 'primary',
      async onClick(c) {
        const v = formValues(c.body);
        const r = await act(`${PLAT}/runs`, { currency: v.currency, cycle: v.cycle, period: v.period.trim() }, (x) => (x.created ? 'Draft run created' : 'Existing run refreshed'));
        if (!r) return false;
        load();
        setTimeout(() => openRun(r.run.id, load), 60);
      },
    }],
  }));
  await load();
}

function openRun(id, onChange) {
  let r = null;
  let d = null;
  const load = async () => {
    r = await api(`${PLAT}/runs/${id}`);
    const x = r.run;
    $('h2', d.el).textContent = `${x.currency} ${x.period}`;
    d.setSubtitle(`${st(RUN_TAG, x.status)} <span class="cell-sub">${esc(x.cycle)} · ${esc(fmt.tz(x.time_zone))}</span>`);
    const ready = new Date(x.finalisable_at) <= new Date();
    d.setHeader(x.status === 'draft' ? `<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
      <button class="btn sm" type="button" data-ra="preview">${icon('refresh')} Refresh preview</button>
      <button class="btn sm primary" type="button" data-ra="finalise">Finalise${ready ? '' : '…'}</button>
      <button class="btn sm danger" type="button" data-ra="void">Void draft</button></div>` : '');
    $$('[data-ra]', d.el).forEach((b) => b.addEventListener('click', () => action(b.dataset.ra)));
  };
  const summary = async (b) => {
    if (!r) await load();
    const x = r.run;
    const p = x.status === 'finalised' ? x.totals : x.preview;
    const cur = x.currency;
    b.innerHTML = `
      ${x.status === 'draft' && new Date(x.finalisable_at) > new Date() ? callout('warn', `The dispute window of the period's last CDRs is still open: finalising is possible from ${esc(fmt.time(x.finalisable_at))} (or earlier with "force", which settles CDRs that may still be disputed).`) : ''}
      <div class="grid k4">
        ${kpi('CDRs', fmt.num(p?.cdrCount ?? 0), 'accepted or credited, received in the period')}
        ${kpi('Gross', esc(money(p?.grossMinor ?? 0, cur)), 'sum of the CDRs settled')}
        ${kpi('Commission', esc(money(p?.feeMinor ?? 0, cur)), 'invoiced separately')}
        ${kpi('Carried', fmt.num(p?.carried?.count ?? 0), p?.carried?.count ? `${esc(money(p.carried.amountMinor, cur))} pending, disputed or held` : 'nothing left out')}
      </div>
      <dl class="kv section"><dt>Period</dt><dd>${esc(fmt.time(x.period_start, x.time_zone))} – ${esc(fmt.time(x.period_end, x.time_zone))} ${esc(fmt.tz(x.time_zone))}</dd>
        <dt>Finalisable from</dt><dd>${esc(fmt.time(x.finalisable_at))}</dd>${x.finalised_at ? `<dt>Finalised</dt><dd>${esc(fmt.time(x.finalised_at))}${p?.forced ? ` ${tag('t-warn', 'forced')}` : ''}</dd>` : ''}</dl>
      <div class="card section"><header><h3>Positions${x.status === 'draft' ? ' (preview)' : ''}</h3></header><div data-pos></div></div>
      <div class="card section"><header><h3>Members${x.status === 'draft' ? ' (preview)' : ''}</h3></header><div data-mem></div></div>`;
    if (x.status === 'finalised') {
      table($('[data-pos]', b), { columns: positionColumns('platform'), rows: r.positions, empty: 'No positions.' });
    } else {
      table($('[data-pos]', b), {
        columns: [
          { label: 'Payer → payee', render: (q) => `<div style="min-width:9rem">${esc(q.payerName ?? '—')}</div><div class="cell-sub">→ ${esc(q.payeeName ?? '—')}</div>` },
          { label: 'A owes B / B owes A', num: true, render: (q) => `${esc(money(q.aOwesB, cur))}<div class="cell-sub">${esc(money(q.bOwesA, cur))}</div>` },
          { label: 'Net', num: true, render: (q) => `<b>${esc(money(q.net, cur))}</b>` },
          { label: 'CDRs', num: true, render: (q) => fmt.num(q.cdrCount) },
        ],
        rows: p?.positions ?? [], empty: 'Nothing to settle in this period.',
      });
    }
    const mem = x.status === 'finalised' ? (p?.members ?? []) : (p?.members ?? []);
    table($('[data-mem]', b), {
      columns: [
        { label: 'Member', render: (m) => `<div style="min-width:9rem">${esc(m.name ?? m.memberId)}</div>` },
        { label: 'Receivable', num: true, render: (m) => esc(money(m.receivable, cur)) },
        { label: 'Payable', num: true, render: (m) => esc(money(m.payable, cur)) },
        { label: 'Net', num: true, render: (m) => `<b>${esc(money(m.net, cur))}</b>` },
        { label: 'Commission', num: true, render: (m) => esc(money(m.feeNet, cur)) },
      ],
      rows: mem, empty: 'No members in this run.',
    });
  };
  const action = async (a) => {
    const x = r.run;
    if (a === 'preview') { if (await act(`${PLAT}/runs/${id}/preview`, {}, 'Preview refreshed')) { await load(); d.refresh(); onChange?.(); } return; }
    if (a === 'finalise') {
      const early = new Date(x.finalisable_at) > new Date();
      const res = await reasonForm({
        title: `Finalise ${x.currency} ${x.period}?`,
        message: 'Stamps the CDRs and writes positions, a statement per member and fee invoices, with numbers. Final: a finalised run cannot be changed or voided.',
        confirmLabel: 'Finalise', danger: true, requireText: 'FINALISE', reasonLabel: 'Note',
        extra: early ? `<label class="check" style="margin-bottom:12px"><input type="checkbox" name="force"> <span><b>Force:</b> the dispute window is still open until ${esc(fmt.time(x.finalisable_at))}; CDRs disputed later are corrected with credit CDRs in a later run.</span></label>` : '',
        validate: (v) => (early && !v.force ? { force: 'Tick to finalise before the window closes' } : {}),
      });
      if (!res) return;
      const out = await act(`${PLAT}/runs/${id}/finalise`, { force: early ? true : undefined, reason: res.reason }, (o) => (o.alreadyFinalised ? 'Already finalised' : 'Run finalised: statements and fee invoices issued'));
      if (out) { await load(); d.refresh(); onChange?.(); }
      return;
    }
    const reason = await reasonDialog({ title: `Void the draft ${x.currency} ${x.period}?`, message: 'Nothing was stamped by the draft; the CDRs stay unsettled. A new run for the period can be created later.', confirmLabel: 'Void draft', danger: true, requireText: 'VOID' });
    if (reason === null) return;
    if (await act(`${PLAT}/runs/${id}/void`, { reason }, 'Draft voided')) { await load(); d.refresh(); onChange?.(); }
  };
  d = drawer({
    title: 'Settlement run',
    tabs: [
      { id: 'summary', label: 'Summary', render: (b) => summary(b) },
      { id: 'cdrs', label: 'CDRs', render: async (b) => { if (!r) await load(); if (r.run.status !== 'finalised') { b.innerHTML = callout('info', 'A draft stamps nothing: the CDRs of a run are listed once it is finalised. The preview counts them.'); return; } await ledger(b, { base: PLAT, mode: 'platform', preset: { run: id } }); } },
      { id: 'documents', label: 'Documents', render: async (b) => {
        if (!r) await load();
        if (r.run.status !== 'finalised') { b.innerHTML = callout('info', 'Statements and fee invoices are issued when the run is finalised.'); return; }
        b.innerHTML = '<div class="card"><header><h3>Statements</h3></header><div data-st></div></div><div class="card section"><header><h3>Fee invoices</h3></header><div data-inv></div></div>';
        await statementsTable($('[data-st]', b), { base: PLAT, mode: 'platform', q: { run: id } });
        await invoicesTable($('[data-inv]', b), { base: PLAT, mode: 'platform', q: { run: id } });
      } },
    ],
  });
  return d;
}

async function platDocuments(root, { members }) {
  let member = '';
  root.innerHTML = `<div class="filters">${field('Member', `<select data-dm>${options([{ value: '', label: 'All members' }, ...members.map((m) => ({ value: m.id, label: m.legal_name }))], member)}</select>`)}</div>
    <div class="card"><header><h3>Statements</h3><span class="cell-sub right">not tax invoices</span></header><div data-st></div></div>
    <div class="card section"><header><h3>Fee invoices</h3><span class="cell-sub right">PlugSure's commission</span></header><div data-inv></div></div>`;
  const load = async () => {
    await statementsTable($('[data-st]', root), { base: PLAT, mode: 'platform', q: { member } });
    await invoicesTable($('[data-inv]', root), { base: PLAT, mode: 'platform', q: { member } });
  };
  $('[data-dm]', root).addEventListener('change', (e) => { member = e.target.value; load(); });
  await load();
}

// ── commission
const feeSide = (p, side) => {
  const cur = p.currency;
  const parts = [];
  if (Number(p[`${side}_bps`])) parts.push(`${Number(p[`${side}_bps`]) / 100}%`);
  if (Number(p[`${side}_fixed_minor`])) parts.push(`+ ${money(p[`${side}_fixed_minor`], cur)}`);
  if (Number(p[`${side}_min_minor`])) parts.push(`min ${money(p[`${side}_min_minor`], cur)}`);
  if (p[`${side}_max_minor`] != null) parts.push(`max ${money(p[`${side}_max_minor`], cur)}`);
  return parts.length ? parts.join(' ') : 'none';
};

function feePlanDialog(plan, done) {
  const cur0 = plan?.currency ?? CURS[0];
  const mj = (k) => (plan?.[k] == null ? '' : String(toMajor(plan[k], plan.currency)));
  const side = (s, title) => `<fieldset class="full"><legend>${esc(title)}</legend><div class="form">
      ${field('Percentage of excl.-tax total', `<div class="inputgroup"><input name="${s}_pct" inputmode="decimal" value="${plan ? Number(plan[`${s}_bps`]) / 100 : 0}"><span class="suffix">%</span></div>`)}
      ${field('Fixed per CDR', `<input name="${s}_fixed" inputmode="decimal" value="${esc(mj(`${s}_fixed_minor`) || '0')}">`)}
      ${field('Minimum per CDR', `<input name="${s}_min" inputmode="decimal" value="${esc(mj(`${s}_min_minor`) || '0')}">`)}
      ${field('Maximum per CDR', `<input name="${s}_max" inputmode="decimal" value="${esc(mj(`${s}_max_minor`))}" placeholder="no maximum">`, { opt: true })}
    </div></fieldset>`;
  modal({
    title: plan ? `Fee plan — ${plan.name}` : 'New fee plan',
    subtitle: 'Commission per CDR, charged to each side separately (never netted). Amounts in the plan\'s currency. A change applies to CDRs accepted from now on.',
    size: 'lg',
    body: `<div class="form">
      ${field('Name', `<input name="name" maxlength="120" value="${esc(plan?.name ?? '')}">`)}
      ${field('Currency', plan ? `<input value="${esc(plan.currency)}" disabled>` : `<select name="currency">${options(CURS, cur0)}</select>`)}
      ${plan ? '' : field('Effective from', `<input name="effective_from" type="date" value="${today()}">`)}
      ${plan ? '' : '<div class="field full"><label class="check"><input type="checkbox" name="is_default"> <span>The default plan for this currency from that date (members and agreements without a plan of their own)</span></label></div>'}
      ${side('cpo', 'Charged to the CPO')}
      ${side('emsp', 'Charged to the eMSP')}
      ${field('Notes', `<input name="notes" maxlength="1000" value="${esc(plan?.notes ?? '')}">`, { opt: true, full: true })}
    </div>`,
    actions: [{ label: 'Cancel' }, {
      label: plan ? 'Save plan' : 'Create plan', kind: 'primary',
      async onClick(c) {
        const v = formValues(c.body);
        const cur = plan?.currency ?? v.currency;
        const errs = {};
        const minor = (k, opt = false) => { const s = String(v[k] ?? '').trim(); if (!s) return opt ? null : 0; const n = toMinor(s, cur); if (!(n >= 0)) errs[k] = 'An amount'; return n; };
        const bps = (k) => { const n = Math.round(Number(String(v[k]).replace(',', '.')) * 100); if (!(n >= 0 && n <= 10000)) errs[k] = '0 to 100'; return n; };
        if (!String(v.name ?? '').trim()) errs.name = 'A name';
        const out = { name: v.name?.trim(), cpo_bps: bps('cpo_pct'), cpo_fixed_minor: minor('cpo_fixed'), cpo_min_minor: minor('cpo_min'), cpo_max_minor: minor('cpo_max', true),
          emsp_bps: bps('emsp_pct'), emsp_fixed_minor: minor('emsp_fixed'), emsp_min_minor: minor('emsp_min'), emsp_max_minor: minor('emsp_max', true), notes: v.notes || null };
        if (Object.keys(errs).length) { fieldErrors(c.body, errs); return false; }
        const r = plan
          ? await act(`${PLAT}/fee-plans/${plan.id}`, out, 'Fee plan saved', 'PATCH')
          : await act(`${PLAT}/fee-plans`, { ...out, currency: v.currency, is_default: v.is_default, effective_from: v.effective_from || undefined }, 'Fee plan created');
        if (!r) return false;
        done();
      },
    }],
  });
}

async function commission(root, { members }) {
  root.innerHTML = `${callout('warn', '<b>TODO(commercial):</b> the commission rates are placeholders (0) until PlugSure\'s commercial terms are set. Plans per currency; an agreement\'s plan overrides the member\'s, which overrides the currency default.')}
    <div class="card section"><header><h3>Fee plans</h3><button class="btn sm primary right" type="button" data-newplan>${icon('plus')} New plan</button></header><div data-plans></div></div>
    <div class="card section"><header><h3>Agreement terms</h3><span class="cell-sub right">dispute window and commission per agreement</span></header><div data-ags></div></div>
    <div class="card section"><header><h3>Member terms</h3></header><div class="body"><div class="filters" style="margin:0">${field('Member', `<select data-mt>${options([{ value: '', label: 'Choose a member' }, ...members.filter((m) => m.status !== 'terminated').map((m) => ({ value: m.id, label: m.legal_name }))], '')}</select>`)}</div><div data-mterms></div></div></div>`;
  const [{ feePlans }, { agreements }] = await Promise.all([api(`${PLAT}/fee-plans`), api(`${PLAT}/agreements`)]);
  const planName = (pid) => feePlans.find((p) => p.id === pid)?.name ?? shortId(pid);
  const reload = () => commission(root, { members });
  table($('[data-plans]', root), {
    columns: [
      { label: 'Plan', render: (p) => `<div class="cell-title">${esc(p.name)}</div><div class="cell-sub">${p.is_default ? `${tag('t-info', 'default', '', true)} ` : ''}from ${esc(p.effective_from)}</div>` },
      { label: 'Currency', render: (p) => esc(p.currency) },
      { label: 'CPO pays', render: (p) => esc(feeSide(p, 'cpo')) },
      { label: 'eMSP pays', render: (p) => esc(feeSide(p, 'emsp')) },
      { label: 'Used by', num: true, render: (p) => fmt.num(p.assignments) },
    ],
    rows: feePlans, empty: 'No fee plans.', onRow: (p) => feePlanDialog(p, reload),
  });
  $('[data-newplan]', root).addEventListener('click', () => feePlanDialog(null, reload));
  table($('[data-ags]', root), {
    columns: [
      { label: 'Agreement', render: (a) => `<div class="mono nowrap">${esc(a.cpo)} ⇄ ${esc(a.emsp)}</div><div class="cell-sub">${esc(a.cpo_member_name ?? '')} · ${esc(a.emsp_member_name ?? '')}</div>` },
      { label: 'Status', render: (a) => tag(a.status === 'active' ? 't-ok' : 't-mute', a.status) },
      { label: 'Dispute window', render: (a) => (a.dispute_days ? `${fmt.num(a.dispute_days)} days` : '<span class="cell-sub">hub default</span>') },
      { label: 'Commission plans', render: (a) => (Object.keys(a.fee_plans ?? {}).length ? Object.entries(a.fee_plans).map(([c, id]) => `<div class="nowrap">${esc(c)}: ${esc(planName(id))}</div>`).join('') : '<span class="cell-sub">member or default</span>') },
    ],
    rows: agreements.filter((a) => a.status !== 'ended'), empty: 'No agreements.',
    onRow: (a) => termsDialog({ title: `Terms — ${a.cpo} ⇄ ${a.emsp}`, current: a.fee_plans ?? {}, feePlans, disputeDays: a.dispute_days, withDays: true,
      save: (body) => act(`${PLAT}/agreements/${a.id}/terms`, body, 'Agreement terms saved', 'PUT'), done: reload }),
  });
  $('[data-mt]', root).addEventListener('change', async (e) => {
    const box = $('[data-mterms]', root);
    if (!e.target.value) { box.innerHTML = ''; return; }
    const mid = e.target.value;
    const t = await api(`${PLAT}/members/${mid}/terms`);
    box.innerHTML = `<dl class="kv" style="margin-top:10px">${CURS.map((c) => `<dt>${esc(c)}</dt><dd>${t.fee_plans[c] ? esc(t.fee_plans[c].name) : '<span class="cell-sub">currency default</span>'}</dd>`).join('')}</dl><button class="btn sm" type="button" data-edit-mt style="margin-top:10px">Edit</button>`;
    $('[data-edit-mt]', box).addEventListener('click', () => termsDialog({
      title: `Commission — ${members.find((m) => m.id === mid)?.legal_name ?? ''}`, current: Object.fromEntries(Object.entries(t.fee_plans).map(([c, x]) => [c, x.feePlanId])), feePlans,
      save: (body) => act(`${PLAT}/members/${mid}/terms`, body, 'Member terms saved', 'PUT'), done: () => e.target.dispatchEvent(new Event('change')),
    }));
  });
}

function termsDialog({ title, current, feePlans, disputeDays = null, withDays = false, save, done }) {
  modal({
    title,
    body: `<div class="form">
      ${withDays ? field('Dispute window (days)', `<input name="dispute_days" inputmode="numeric" value="${esc(disputeDays ?? '')}" placeholder="hub default">`, { help: '1 to 90; empty: the hub default (HUB_DISPUTE_DAYS).', full: true }) : ''}
      ${CURS.map((c) => field(`${c} plan`, `<select name="plan_${c}">${options([{ value: '', label: 'No override' }, ...feePlans.filter((p) => p.currency === c).map((p) => ({ value: p.id, label: p.name }))], current[c] ?? '')}</select>`)).join('')}
    </div>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Save', kind: 'primary',
      async onClick(c) {
        const v = formValues(c.body);
        const body = { fee_plans: Object.fromEntries(CURS.map((cur) => [cur, v[`plan_${cur}`] || null])) };
        if (withDays) {
          const s = String(v.dispute_days ?? '').trim();
          if (s && !(Number.isInteger(Number(s)) && Number(s) >= 1 && Number(s) <= 90)) { fieldErrors(c.body, { dispute_days: '1 to 90, or empty' }); return false; }
          body.dispute_days = s ? Number(s) : null;
        }
        if (!(await save(body))) return false;
        done();
      },
    }],
  });
}

async function entities(root) {
  const { entities: list } = await api(`${PLAT}/entities`);
  const anyPlaceholder = list.some((e) => e.placeholder);
  root.innerHTML = `${anyPlaceholder ? callout('crit', '<b>Placeholder entities.</b> PlugSure\'s issuing entities are not confirmed [OWNER/LEGAL]: fee invoices from a placeholder say "not valid as a tax invoice". Replace the details and untick "placeholder" once confirmed.') : ''}
    <div class="grid three section">${list.map((e) => `<div class="card"><header><h3>${esc(COUNTRIES[e.country_code]?.name ?? e.country_code)}</h3>${e.placeholder ? tag('t-crit', 'placeholder') : tag('t-ok', 'confirmed')}<button class="btn sm right" type="button" data-ent="${esc(e.country_code)}">Edit</button></header>
      <div class="body"><dl class="kv">
        <dt>Legal name</dt><dd>${esc(e.legal_name)}</dd>
        <dt>Tax id</dt><dd>${esc(e.tax_id ?? '—')} ${e.tax_registered ? tag('t-ok', 'tax registered', '', true) : tag('t-mute', 'not registered', '', true)}</dd>
        <dt>Address</dt><dd class="wrap">${esc(e.address)}</dd>
        <dt>Invoice prefix</dt><dd class="mono">${esc(e.invoice_prefix)}</dd>
        <dt>Bank details</dt><dd class="wrap">${e.bank_details ? esc(e.bank_details) : '<span class="cell-sub">not set</span>'}</dd>
      </dl></div></div>`).join('')}</div>`;
  $$('[data-ent]', root).forEach((b) => b.addEventListener('click', () => {
    const e = list.find((x) => x.country_code === b.dataset.ent);
    modal({
      title: `Issuing entity — ${e.country_code}`, size: 'lg',
      body: `<div class="form">
        ${field('Legal name', '<input name="legal_name" maxlength="200">', { full: true })}
        ${field('Address', '<textarea name="address" rows="2" maxlength="500" style="font-family:var(--sans);font-size:13px;min-height:56px"></textarea>', { full: true })}
        ${field('Tax id', '<input name="tax_id" maxlength="40" placeholder="NPWP / SST no. / GST no.">', { opt: true })}
        ${field('Invoice prefix', '<input name="invoice_prefix" maxlength="20" placeholder="PSH-ID-">')}
        <div class="field full"><label class="check"><input type="checkbox" name="tax_registered"> <span>Registered for tax (PKP / SST / GST): fee invoices carry tax</span></label></div>
        ${field('Bank details', '<textarea name="bank_details" rows="2" maxlength="1000" style="font-family:var(--sans);font-size:13px;min-height:56px"></textarea>', { opt: true, full: true, help: 'Printed on fee invoices. Empty keeps the current details.' })}
        <div class="field full"><label class="check"><input type="checkbox" name="placeholder"> <span><b>Placeholder</b> — not a confirmed legal entity (documents say "not valid as a tax invoice")</span></label></div>
      </div>`,
      onMount(c) {
        for (const k of ['legal_name', 'address', 'tax_id', 'invoice_prefix']) $(`[name="${k}"]`, c.body).value = e[k] ?? '';
        $('[name="tax_registered"]', c.body).checked = !!e.tax_registered;
        $('[name="placeholder"]', c.body).checked = !!e.placeholder;
      },
      actions: [{ label: 'Cancel' }, {
        label: 'Save', kind: 'primary',
        async onClick(c) {
          const v = formValues(c.body);
          if (!/^[A-Z0-9-]{2,20}$/.test(v.invoice_prefix ?? '')) { fieldErrors(c.body, { invoice_prefix: '2-20 of A-Z, 0-9 and -' }); return false; }
          const r = await act(`${PLAT}/entities/${e.country_code}`, { legal_name: v.legal_name, address: v.address, tax_id: v.tax_id || undefined, invoice_prefix: v.invoice_prefix, tax_registered: v.tax_registered, placeholder: v.placeholder, bank_details: v.bank_details || undefined }, 'Entity saved', 'PUT');
          if (!r) return false;
          entities(root);
        },
      }],
    });
  }));
}

// ═══════════════════════════════════════════ member: Roaming → PlugSure Hub
let membSection = 'summary';

export async function drawClearingMember(root, { canWrite }) {
  const ctx = { base: MEMB, mode: 'member', canWrite };
  const body = subnav(root, [['summary', 'Summary'], ['ledger', 'Ledger'], ['disputes', 'Disputes'], ['documents', 'Statements & invoices'], ['payments', 'Positions & payments'],
    ['commission', 'Commission'], ['bank', 'Bank details']], membSection, (s) => show(s));
  const show = async (s, preset = {}) => {
    membSection = s;
    $$('[data-sub]', root).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.sub === s)));
    body.innerHTML = '<div class="skeleton" style="height:120px"></div>';
    try {
      if (s === 'summary') await memberSummary(body, { go: show });
      else if (s === 'ledger') await ledger(body, { ...ctx, preset });
      else if (s === 'disputes') await disputeList(body, ctx);
      else if (s === 'documents') {
        body.innerHTML = '<div class="card"><header><h3>Statements</h3><span class="cell-sub right">per settlement run; not tax invoices</span></header><div data-st></div></div><div class="card section"><header><h3>Fee invoices</h3><span class="cell-sub right">PlugSure\'s commission</span></header><div data-inv></div></div>';
        await statementsTable($('[data-st]', body), ctx);
        await invoicesTable($('[data-inv]', body), ctx);
      } else if (s === 'payments') await positionsAndPayments(body, ctx);
      else if (s === 'commission') await memberCommission(body);
      else await bankDetails(body, ctx);
    } catch (e) { if (body.isConnected) body.innerHTML = callout(e.status === 404 ? 'info' : 'crit', esc(e.status === 404 ? 'Clearing starts once you are a hub member.' : e.message)); }
  };
  await show(membSection);
}

async function memberSummary(root, { go }) {
  const s = await api(`${MEMB}/summary`);
  const pay = s.positions.filter((p) => p.direction === 'pay');
  const recv = s.positions.filter((p) => p.direction === 'receive');
  const curs = [...new Set(s.cdrs.map((x) => x.currency))].sort();
  root.innerHTML = `
    <div class="grid k4">
      ${kpi('To pay', perCurrency(pay, 'outstanding_minor', { empty: fmt.num(0) }), pay.some((p) => p.status === 'overdue') ? 'some overdue' : 'outstanding', pay.some((p) => p.status === 'overdue') ? 'crit' : '')}
      ${kpi('To receive', perCurrency(recv, 'outstanding_minor', { empty: fmt.num(0) }), 'outstanding')}
      ${kpi('Live disputes', fmt.num(s.openDisputes), 'open, accepted, rejected or escalated', s.openDisputes ? 'warn' : '')}
      ${kpi('Bank details', s.member.bank_details ? 'set' : 'missing', s.member.bank_details ? 'printed on your payers\' statements' : 'needed to be paid', s.member.bank_details ? '' : 'warn')}
    </div>
    <div class="card section"><header><h3>Your CDRs</h3><span class="cell-sub right">count · amount incl. tax</span></header><div data-t></div></div>`;
  const cell = (cur, side, stt) => { const r = s.cdrs.filter((x) => x.currency === cur && x.side === side && stt.includes(x.status)); const n = r.reduce((a, x) => a + Number(x.n), 0); return n ? `${fmt.num(n)}<div class="cell-sub nowrap">${esc(money(r.reduce((a, x) => a + Number(x.amount_minor), 0), cur))}</div>` : '<span class="cell-sub">—</span>'; };
  const rows = curs.flatMap((c) => ['cpo', 'emsp'].filter((side) => s.cdrs.some((x) => x.currency === c && x.side === side)).map((side) => ({ c, side })));
  table($('[data-t]', root), {
    columns: [
      { label: 'Currency · side', render: (r) => `<b>${esc(r.c)}</b><div class="cell-sub">${r.side === 'cpo' ? 'as CPO (you are paid)' : 'as eMSP (you pay)'}</div>` },
      { label: 'Pending', num: true, render: (r) => cell(r.c, r.side, ['pending']) },
      { label: 'Disputed', num: true, render: (r) => cell(r.c, r.side, ['disputed']) },
      { label: 'Held', num: true, render: (r) => cell(r.c, r.side, ['held']) },
      { label: 'Accepted', num: true, render: (r) => cell(r.c, r.side, ['accepted']) },
      { label: 'Credited / written off', num: true, render: (r) => cell(r.c, r.side, ['credited', 'written_off', 'void']) },
    ],
    rows, empty: 'No CDRs through the hub yet.', onRow: (r) => go('ledger', { currency: r.c, side: r.side }),
  });
}

async function memberCommission(root) {
  const { feePlans } = await api(`${MEMB}/fee-plans`);
  const desc = (x, cur) => (!x ? 'none' : [Number(x.bps) ? `${Number(x.bps) / 100}%` : '', Number(x.fixed_minor) ? `+ ${money(x.fixed_minor, cur)}` : '', Number(x.min_minor) ? `min ${money(x.min_minor, cur)}` : '', x.max_minor != null ? `max ${money(x.max_minor, cur)}` : ''].filter(Boolean).join(' ') || 'none (0)');
  root.innerHTML = `<p class="cell-sub" style="margin:0 0 10px">PlugSure's commission per CDR on the excl.-tax total, invoiced to you per settlement run (not netted with your roaming positions). An agreement may carry its own terms.</p><div class="card" data-t></div>`;
  table($('[data-t]', root), {
    columns: [
      { label: 'Currency', render: (r) => `<b>${esc(r.cur)}</b>` },
      { label: 'As CPO', render: (r) => `${esc(desc(r.asCpo, r.cur))}<div class="cell-sub">${esc(r.asCpo?.name ?? '')}</div>` },
      { label: 'As eMSP', render: (r) => `${esc(desc(r.asEmsp, r.cur))}<div class="cell-sub">${esc(r.asEmsp?.name ?? '')}</div>` },
    ],
    rows: Object.entries(feePlans).map(([cur, v]) => ({ cur, ...v })),
  });
}

async function bankDetails(root, { canWrite }) {
  const s = await api(`${MEMB}/summary`);
  root.innerHTML = `<div class="card pad"><form class="form one" novalidate>
      <p class="cell-sub" style="margin:0">The account your counterparties pay into: printed on the statements of the members who owe you. Stored encrypted.</p>
      ${field('Bank details', `<textarea name="bank_details" rows="4" maxlength="1000" style="font-family:var(--sans);font-size:13px"${canWrite ? '' : ' disabled'} placeholder="Bank, account name, account number, SWIFT/BIC"></textarea>`)}
      ${canWrite ? '<div><button class="btn primary" type="submit">Save</button></div>' : ''}
    </form></div>`;
  const form = $('form', root);
  $('[name="bank_details"]', form).value = s.member.bank_details ?? '';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    if (!String(v.bank_details ?? '').trim()) return fieldErrors(form, { bank_details: 'Bank, account name and number' });
    await act(`${MEMB}/bank-details`, { bank_details: v.bank_details.trim() }, 'Bank details saved', 'PUT');
  });
}
