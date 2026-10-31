import { $, $$, esc, api, registerView, pageHead, table, tag, icon, fmt, field, callout, kpi, copy, toast } from '../core.js';

/**
 * WhatsApp — PlugSure's WhatsApp Business Account (Meta Cloud API) at a glance (v1.10.0). Platform administrators.
 *
 *   Overview   the connection (number, quality rating, messaging tier, display name), the webhook's last event,
 *              7 / 30-day numbers and a daily chart (sign-in codes, tests, and operator alerts sent from the same
 *              number), the templates PlugSure needs, recent failures
 *   Templates  every template on the WABA, the required ones marked
 *   Messages   the ledger, masked numbers, filters
 *   Setup      the webhook URL and verify token for the Meta app, the fields to subscribe, a test send
 *   Inbox      (v1.11.0) customers' messages: the AI assistant's (Claude) replies and drafts, staff replies, handover
 *
 * Every value from the API is escaped (esc) before it reaches markup.
 */

const QUALITY_TAG = { GREEN: 't-ok', YELLOW: 't-warn', RED: 't-crit' };
const STATUS_TAG = { read: 't-ok', delivered: 't-ok', sent: 't-info', accepted: 't-info', failed: 't-crit' };
const TEMPLATE_TAG = { APPROVED: 't-ok', PENDING: 't-info', IN_APPEAL: 't-info', PAUSED: 't-warn', REJECTED: 't-crit', DISABLED: 't-crit', MISSING: 't-crit' };
const PURPOSE_LABEL = { otp: 'Sign-in code', alert: 'Operator alert', test: 'Test', support: 'Support reply', other: 'Other' };
const HANDLER_TAG = { ai: ['t-info', 'AI'], human: ['t-warn', 'staff'], closed: ['t-mute', 'closed'] };
const MODE_LABEL = { auto: 'replies automatically', draft: 'drafts replies for staff', off: 'is off' };
const handlerTag = (h) => tag(...(HANDLER_TAG[h] ?? ['t-mute', h]));
/** Chart series bottom to top: the furthest a message got. Status tokens, so dark mode has its own steps. */
const SERIES = [
  ['read', 'Read', 'var(--accent)'],
  ['delivered', 'Delivered', 'var(--info)'],
  ['sent', 'Sent, no report yet', 'var(--muted)'],
  ['failed', 'Failed', 'var(--crit)'],
];
const FIELDS_HELP = {
  messages: 'delivery statuses (sent, delivered, read, failed)',
  message_template_status_update: 'a template approved, paused, rejected or disabled',
  phone_number_quality_update: 'the number\'s quality rating and messaging limit',
  account_update: 'restrictions and violations on the account',
};
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(x === 1 ? 0 : 1)}%`);
const qualityTag = (q) => tag(QUALITY_TAG[q] ?? 't-mute', q ? q.toLowerCase() : 'unknown', 'Quality rating at Meta');
const pretty = (s) => (s ? String(s).replace(/_/g, ' ').toLowerCase() : '—');

/** The daily chart: stacked bars by final status, one axis, a tooltip per day, a legend. */
function chart(daily, width = 720) {
  // Drawn at the card's real width (not a fixed viewBox stretched to fit), so the 11px axis text stays 11px.
  const W = Math.max(360, Math.round(width)), H = 220, L = 34, B = 26, T = 8;
  const plotW = W - L - 8, plotH = H - B - T;
  const totals = daily.map((d) => SERIES.reduce((a, [k]) => a + (d[k] ?? 0), 0));
  const max = Math.max(1, ...totals);
  // A round top for the axis: 1, 2, 5 × 10^n.
  const step = 10 ** Math.floor(Math.log10(max));
  const top = [1, 2, 5, 10].map((m) => m * step).find((v) => v >= max) ?? max;
  const slot = plotW / daily.length, bw = Math.max(4, Math.min(36, slot * 0.62));
  const y = (v) => T + plotH - (v / top) * plotH;
  const every = daily.length > 14 ? 5 : 1;
  const grid = [0, top / 2, top].map((v) => `<line x1="${L}" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}" class="wa-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="wa-axis">${esc(fmt.num(v))}</text>`).join('');
  const bars = daily.map((d, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    let acc = 0;
    const segs = SERIES.map(([k, , color]) => {
      const v = d[k] ?? 0;
      if (!v) return '';
      const y0 = y(acc), y1 = y(acc + v);
      acc += v;
      // A 2px surface gap between segments; never thinner than 1px so a single message still shows.
      const h = Math.max(1, y0 - y1 - 2);
      return `<rect x="${x}" y="${y1}" width="${bw}" height="${h}" rx="2" style="fill:${color}"/>`;
    }).join('');
    const tip = `${d.day}: ${totals[i]} message${totals[i] === 1 ? '' : 's'} — ${SERIES.map(([k, label]) => `${label.toLowerCase()} ${d[k] ?? 0}`).join(', ')}`;
    const label = i % every === 0 || i === daily.length - 1
      ? `<text x="${L + i * slot + slot / 2}" y="${H - 8}" text-anchor="middle" class="wa-axis">${esc(new Date(`${d.day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }))}</text>` : '';
    // The hit target is the whole column, not just the coloured part.
    return `<g class="wa-col"><title>${esc(tip)}</title><rect x="${L + i * slot}" y="${T}" width="${slot}" height="${plotH}" class="wa-hit"/>${segs}</g>${label}`;
  }).join('');
  const sum = totals.reduce((a, b) => a + b, 0);
  return `<svg class="wa-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`Messages per day, ${daily.length} days, ${sum} in total. Details per day in the Messages tab.`)}">${grid}${bars}</svg>
    <div class="legend">${SERIES.map(([, label, color]) => `<span style="--c:${color}">${esc(label)}</span>`).join('')}</div>`;
}

const notConfigured = () => `<div class="card pad">
    <div class="empty-state" style="padding:20px 10px 10px"><h3>WhatsApp is not configured</h3><p>The dashboard reads the WhatsApp Business Account that sends driver sign-in codes.</p></div>
    <ol style="margin:0 auto 16px;max-width:640px;display:grid;gap:6px;padding-left:20px">
      <li>At Meta: the WhatsApp Business Account, the sending number, a System User with a permanent token holding <span class="mono">whatsapp_business_messaging</span> and <span class="mono">whatsapp_business_management</span>, and an approved <span class="mono">plugsure_otp</span> Authentication template.</li>
      <li>In PlugSure: <b>Integrations → Driver sign-in codes</b> (or its fallback), provider <b>WhatsApp (Meta Cloud API)</b>: the phone number ID and token, and for this dashboard the WhatsApp Business Account ID and the app secret.</li>
      <li>Paste the webhook URL and verify token shown after saving into the Meta app, and subscribe the webhook fields.</li>
    </ol>
    <div class="row" style="justify-content:center;gap:8px"><a class="btn primary" href="#/integrations">${icon('link')} Open Integrations → Driver sign-in codes</a><span class="cell-sub">Step by step: deploy/WHATSAPP.md</span></div>
  </div>`;

const toIntegrations = `<a class="btn sm" href="#/integrations">${icon('gear')} Edit in Integrations</a>`;

/** (v1.11.0) The support inbox in four numbers, on the overview. */
function supportKpis(sp) {
  if (!sp) return '';
  if (!sp.configured && !sp.conversations) {
    return `<div class="section">${callout('info', `Customers who write to this number land in the <b>Inbox</b>. To have Claude answer them, set up <b>WhatsApp AI support</b> in Integrations. <a class="btn sm" href="#/integrations">${icon('gear')} Set up</a>`)}</div>`;
  }
  return `<div class="grid k4 section">
      ${kpi('Support conversations', esc(fmt.num(sp.conversations)), sp.configured ? esc(`AI ${MODE_LABEL[sp.mode] ?? ''}`) : 'no AI assistant')}
      ${kpi('Waiting for staff', esc(fmt.num(sp.waitingForStaff)), 'answer in the Inbox', sp.waitingForStaff ? 'warn' : '')}
      ${kpi('AI replies', esc(fmt.num(sp.aiReplies)), esc(`${fmt.num(sp.aiTokens)} tokens`))}
      ${kpi('Handed to staff', esc(fmt.num(sp.handoffs)), esc(`${fmt.num(sp.staffReplies)} staff replies`))}
    </div>`;
}

/** One message of the thread. Outgoing on the right; the assistant's in blue; notes centred. */
function bubble(m) {
  if (m.author === 'system') return `<div class="wa-note">${esc(m.body)} · ${esc(fmt.time(m.at))}</div>`;
  const who = m.author === 'customer' ? '' : m.author === 'ai' ? `AI${m.model ? ` · ${m.model}` : ''}` : 'Staff';
  const status = m.direction === 'out' ? (m.error ? `not sent: ${m.error}` : m.status ?? '') : '';
  const meta = [who, fmt.time(m.at), status].filter(Boolean).join(' · ');
  return `<div class="wa-bubble ${m.direction === 'out' ? 'out' : ''} ${m.author === 'ai' ? 'ai' : ''}">${esc(m.body)}<span class="meta"${m.error ? ' style="color:var(--crit)"' : ''}>${esc(meta)}</span></div>`;
}

function messageColumns() {
  return [
    { label: 'When', render: (m) => `<span class="nowrap">${esc(fmt.time(m.at))}</span>` },
    { label: 'Purpose', render: (m) => esc(PURPOSE_LABEL[m.purpose] ?? m.purpose) },
    { label: 'To', render: (m) => `<span class="mono">${esc(m.to)}</span>` },
    { label: 'Template', render: (m) => (m.template ? `<span class="mono">${esc(m.template)}</span>${m.language ? ` <span class="cell-sub">${esc(m.language)}</span>` : ''}` : '—') },
    { label: 'Status', render: (m) => `${tag(STATUS_TAG[m.status] ?? 't-mute', m.status === 'accepted' ? 'accepted' : m.status)}${m.readAt ? `<div class="cell-sub">read ${esc(fmt.time(m.readAt))}</div>` : m.deliveredAt ? `<div class="cell-sub">delivered ${esc(fmt.time(m.deliveredAt))}</div>` : ''}${m.pricingCategory ? `<div class="cell-sub">${esc(m.pricingCategory)}${m.billable === false ? ' · not billed' : ''}</div>` : ''}` },
    { label: 'Error', render: (m) => (m.error ? `<span class="cell-sub wrap" style="color:var(--crit)">${esc(m.error)}</span>` : '') },
  ];
}

registerView('whatsapp', {
  title: 'WhatsApp',
  subtitle: 'WhatsApp Business (Cloud API)',
  icon: 'phone',
  group: 'operate',
  // Directly under the Dashboard (order 1).
  order: 1.5,
  perm: 'platform:admin',
  async render(root, [initial]) {
    const tabs = [
      { id: 'overview', label: 'Overview' },
      { id: 'inbox', label: 'Inbox' },
      { id: 'templates', label: 'Templates' },
      { id: 'messages', label: 'Messages' },
      { id: 'setup', label: 'Setup' },
    ];
    root.innerHTML = pageHead(
      'WhatsApp',
      'PlugSure\'s WhatsApp Business Account (Meta Cloud API): the number\'s health, the templates it needs, and whether sign-in codes and alerts reach people.',
      `<button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button>`,
    ) + `<div class="tabs" role="tablist">${tabs.map((t) => `<button role="tab" type="button" aria-selected="false" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}</div><div data-body></div>`;

    const body = $('[data-body]', root);
    let current = tabs.find((t) => t.id === initial)?.id ?? 'overview';
    let days = 7;
    let o = null;

    const load = async () => { o = await api(`/v1/whatsapp/overview?days=${days}`); };

    const drawOverview = () => {
      if (!o.configured) { body.innerHTML = notConfigured(); return; }
      const c = o.connection, s = o.stats, w = o.webhook;
      const item = (label, value) => `<div><div class="lbl small">${esc(label)}</div><div>${value}</div></div>`;
      const conn = c.error ? tag('t-crit', 'error') : tag('t-ok', 'connected');
      const missing = o.requiredTemplates.filter((t) => t.inUse && t.status && t.status !== 'APPROVED');
      body.innerHTML = `
        ${c.error ? callout('crit', `<b>The Graph API refused:</b> ${esc(c.error)}`) : ''}
        ${!c.wabaId ? callout('info', `Add the <b>WhatsApp Business Account ID</b> to the sign-in codes integration to see templates and account status. ${toIntegrations}`) : ''}
        ${missing.length ? callout('warn', `<b>Not approved:</b> ${missing.map((t) => `<span class="mono">${esc(t.name)}</span> (${esc(t.language)}): ${esc(pretty(t.status))}`).join(', ')}. Messages with ${missing.length > 1 ? 'these templates' : 'this template'} are not delivered.`) : ''}
        ${!w.url ? callout('warn', `Save the sign-in codes integration once to issue the webhook URL: without it, delivery (delivered / read / failed) is not tracked. ${toIntegrations}`) : !w.hasAppSecret ? callout('warn', `Save the Meta <b>app secret</b> on the sign-in codes integration: without it Meta's webhook calls are refused (they cannot be verified). ${toIntegrations}`) : ''}
        ${w.url && !w.lastEventAt && !w.lastStatusAt ? callout('info', 'No webhook call received yet. Paste the webhook URL and verify token from <b>Setup</b> into the Meta app, or delivery is not tracked.') : ''}
        <div class="card pad"><div class="grid k4" style="gap:12px 18px">
          ${item('Connection', `${conn} <span class="cell-sub">checked ${esc(fmt.ago(c.checkedAt))}</span>`)}
          ${item('Number', `<b>${esc(c.displayPhoneNumber ?? c.phoneNumberId)}</b>${c.verifiedName ? `<div class="cell-sub">${esc(c.verifiedName)}</div>` : ''}`)}
          ${item('Quality rating', qualityTag(c.qualityRating))}
          ${item('Messaging limit', esc(pretty(c.messagingLimitTier)))}
          ${item('Display name', c.nameStatus ? tag(c.nameStatus === 'APPROVED' ? 't-ok' : /DECLINED|REJECTED/.test(c.nameStatus) ? 't-crit' : 't-info', pretty(c.nameStatus)) : '—')}
          ${item('Webhook', w.lastStatusAt || w.lastEventAt ? `last call ${esc(fmt.ago([w.lastStatusAt, w.lastEventAt].filter(Boolean).sort().pop()))}` : tag('t-warn', 'nothing received'))}
        </div></div>
        <div class="row section" style="justify-content:space-between"><h2 style="font-size:14.5px;margin:0">Last ${esc(String(s.days))} days</h2>
          <div class="seg" role="group" aria-label="Period" data-days>${[7, 30].map((d) => `<button type="button" data-v="${d}" aria-pressed="${String(d === days)}">${d} days</button>`).join('')}</div></div>
        <div class="grid k4" style="margin-top:10px">
          ${kpi('Sent', esc(fmt.num(s.total)), esc(`${fmt.num(s.byPurpose.otp)} sign-in codes · ${fmt.num(s.byPurpose.alert)} alerts${s.byPurpose.test ? ` · ${fmt.num(s.byPurpose.test)} tests` : ''}`))}
          ${kpi('Delivered', esc(pct(s.deliveryRate)), esc(`${fmt.num(s.byStatus.delivered + s.byStatus.read)} reached the phone`), s.deliveryRate != null && s.deliveryRate < 0.9 ? 'warn' : '')}
          ${kpi('Read', esc(pct(s.readRate)), 'of those delivered')}
          ${kpi('Failed', esc(fmt.num(s.byStatus.failed)), s.total ? esc(pct(s.byStatus.failed / s.total)) : '', s.byStatus.failed ? 'crit' : '')}
        </div>
        ${supportKpis(o.support)}
        <div class="card section"><header><h3>Messages per day</h3><span class="cell-sub right">by the furthest status reached · days in the platform time zone</span></header><div class="body">${s.total ? chart(s.daily, body.clientWidth - 34) : '<div class="empty-state">Nothing sent in this period.</div>'}</div></div>
        <div class="grid two section">
          <div class="card"><header><h3>Templates PlugSure sends</h3></header><div data-required></div></div>
          <div class="card"><header><h3>Recent failures</h3></header><div data-failures></div></div>
        </div>`;
      table($('[data-required]', body), {
        columns: [
          { label: 'Template', render: (t) => `<span class="mono">${esc(t.name)}</span> <span class="cell-sub">${esc(t.language)}</span>${t.inUse ? '' : '<div class="cell-sub">default, not in use yet</div>'}` },
          { label: 'For', render: (t) => esc(t.purpose === 'otp' ? 'Sign-in codes' : 'Operator alerts') },
          { label: 'Status', render: (t) => (t.status ? tag(TEMPLATE_TAG[t.status] ?? 't-mute', pretty(t.status)) : '<span class="cell-sub">unknown</span>') },
        ],
        rows: o.requiredTemplates,
        empty: 'No template in use.',
      });
      table($('[data-failures]', body), {
        columns: [
          { label: 'When', render: (m) => `<span class="nowrap">${esc(fmt.time(m.at))}</span>` },
          { label: 'To', render: (m) => `<span class="mono">${esc(m.to)}</span><div class="cell-sub">${esc(PURPOSE_LABEL[m.purpose] ?? m.purpose)}</div>` },
          { label: 'Why', render: (m) => `<span class="cell-sub wrap">${esc(m.error ?? 'failed')}</span>` },
        ],
        rows: o.recentFailures,
        empty: 'No failures.',
      });
      $('[data-days]', body).addEventListener('click', async (e) => {
        const b = e.target.closest('button[data-v]');
        if (!b || Number(b.dataset.v) === days) return;
        days = Number(b.dataset.v);
        await refresh();
      });
    };

    const drawTemplates = async () => {
      body.innerHTML = '<div class="card" data-list><div class="empty-state"><span class="spinner"></span></div></div>';
      let r;
      try { r = await api('/v1/whatsapp/templates'); } catch (e) {
        body.innerHTML = e.status === 409 && /not configured/.test(e.message) ? notConfigured() : callout(e.status === 409 ? 'info' : 'crit', `${esc(e.message)} ${e.status === 409 ? toIntegrations : ''}`);
        return;
      }
      body.innerHTML = `<div class="card"><header><h3>${esc(String(r.templates.length))} templates</h3><a class="btn sm right" href="${esc(r.managerUrl)}" target="_blank" rel="noopener noreferrer">${icon('external')} Open WhatsApp Manager</a></header><div data-list></div></div>
        <p class="cell-sub">New templates are created and submitted for review in WhatsApp Manager. The sign-in code template is an <b>Authentication</b> template with a copy-code button; the alert template a <b>Utility</b> template. Approval usually takes minutes, sometimes a day.</p>`;
      table($('[data-list]', body), {
        columns: [
          { label: 'Name', render: (t) => `<span class="mono">${esc(t.name)}</span>${t.required ? ` ${tag('t-info', 'used by PlugSure')}` : ''}` },
          { label: 'Category', render: (t) => esc(pretty(t.category)) },
          { label: 'Language', render: (t) => `<span class="mono">${esc(t.language)}</span>` },
          { label: 'Status', render: (t) => `${tag(TEMPLATE_TAG[t.status] ?? 't-mute', pretty(t.status))}${t.rejectedReason ? `<div class="cell-sub">${esc(pretty(t.rejectedReason))}</div>` : ''}` },
          { label: 'Quality', render: (t) => (t.qualityScore && t.qualityScore !== 'UNKNOWN' ? qualityTag(t.qualityScore) : '<span class="cell-sub">—</span>') },
        ],
        rows: [...r.templates].sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name)),
        empty: 'No templates on this WhatsApp Business Account yet.',
      });
    };

    const drawMessages = async () => {
      body.innerHTML = `<div class="filters section" style="margin-top:0">
          ${field('Purpose', `<select data-purpose><option value="">All</option>${Object.entries(PURPOSE_LABEL).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>`)}
          ${field('Status', `<select data-status><option value="">All</option>${['accepted', 'sent', 'delivered', 'read', 'failed'].map((v) => `<option value="${v}">${esc(v)}</option>`).join('')}</select>`)}
          <button class="btn" type="button" data-reload>${icon('refresh')} Refresh</button>
        </div>
        <div class="card" data-log></div><div class="row" style="justify-content:center;margin-top:10px" data-more></div>
        <p class="cell-sub">Numbers are masked; sign-in codes are never stored. Messages are kept 180 days. Operator alerts appear here when their alert channel sends from this number.</p>`;
      let rows = [];
      const draw = async (more = false) => {
        const q = new URLSearchParams({ limit: '100' });
        const p = $('[data-purpose]', body).value, st = $('[data-status]', body).value;
        if (p) q.set('purpose', p);
        if (st) q.set('status', st);
        if (more && rows.length) q.set('before', rows[rows.length - 1].at);
        let r;
        try { r = await api(`/v1/whatsapp/messages?${q}`); } catch (e) { toast(e.message, 'crit'); return; }
        rows = more ? rows.concat(r.messages) : r.messages;
        table($('[data-log]', body), { columns: messageColumns(), rows, empty: 'No messages match.' });
        $('[data-more]', body).innerHTML = r.nextBefore ? '<button class="btn sm" type="button" data-load-more>Load older</button>' : '';
        $('[data-load-more]', body)?.addEventListener('click', () => draw(true));
      };
      $('[data-purpose]', body).addEventListener('change', () => draw());
      $('[data-status]', body).addEventListener('change', () => draw());
      $('[data-reload]', body).addEventListener('click', () => draw());
      await draw();
    };

    const drawSetup = () => {
      if (!o.configured) { body.innerHTML = notConfigured(); return; }
      const w = o.webhook;
      const otp = o.requiredTemplates.find((t) => t.purpose === 'otp');
      const alertT = o.requiredTemplates.find((t) => t.purpose === 'alert');
      body.innerHTML = `
        <div class="grid two">
          <div class="card pad">
            <h3 style="margin:0 0 6px">Webhook for the Meta app</h3>
            <p class="cell-sub" style="margin:0 0 10px">Meta app → WhatsApp → Configuration → Webhook: <b>Edit</b>, paste these two, <b>Verify and save</b>. Then subscribe the fields below.</p>
            ${field('Callback URL', `<div class="row" style="gap:6px;flex-wrap:nowrap"><div class="secret" style="flex:1" data-url></div><button class="btn sm" type="button" data-copy="url" aria-label="Copy the callback URL">${icon('copy')} Copy</button></div>`, { full: true })}
            ${field('Verify token', `<div class="row" style="gap:6px;flex-wrap:nowrap"><div class="secret" style="flex:1" data-token></div><button class="btn sm" type="button" data-copy="token" aria-label="Copy the verify token">${icon('copy')} Copy</button></div>`, { full: true, help: 'Made by PlugSure when the connection was first saved. Meta signs every callback with the app secret, which PlugSure checks.' })}
            <div class="lbl small" style="margin-top:12px;font-weight:600">Webhook fields to subscribe</div>
            <ul style="margin:6px 0 0;padding-left:18px;display:grid;gap:4px">${(w.fields ?? []).map((f) => `<li><span class="mono">${esc(f)}</span> <span class="cell-sub">${esc(FIELDS_HELP[f] ?? '')}</span></li>`).join('')}</ul>
            <p class="cell-sub" style="margin-top:10px">${w.lastStatusAt || w.lastEventAt ? `Last call received ${esc(fmt.ago([w.lastStatusAt, w.lastEventAt].filter(Boolean).sort().pop()))}.` : 'No call received yet.'} <span class="mono">/hooks/*</span> must be reachable from the internet (deploy/Caddyfile).</p>
            ${w.hasAppSecret ? '' : callout('warn', 'No app secret is saved on the sign-in codes integration: Meta\'s calls are refused until it is.')}
            <div class="row" style="margin-top:12px"><a class="btn" href="#/integrations">${icon('gear')} Edit connection</a><span class="cell-sub">Integrations → Driver sign-in codes${o.connection?.source === 'otp_fallback' ? ' — fallback' : ''}</span></div>
          </div>
          <div class="card pad">
            <h3 style="margin:0 0 6px">Send a test message</h3>
            <p class="cell-sub" style="margin:0 0 10px">Sends one approved template to a phone you hold. Recorded as a test; at most 5 a minute.</p>
            <form class="form" data-test-form>
              ${field('Phone', '<input name="phone" inputmode="tel" autocomplete="off" required placeholder="0812 3456 7890" aria-describedby="wa-phone-help">', { help: '<span id="wa-phone-help">Indonesia, Malaysia or Singapore mobile number.</span>' })}
              ${field('Template', `<input name="template" required list="wa-templates" class="mono" value="${esc(alertT?.name ?? 'plugsure_alert')}"><datalist id="wa-templates">${o.requiredTemplates.map((t) => `<option value="${esc(t.name)}">`).join('')}</datalist>`)}
              ${field('Language', `<input name="language" required class="mono" value="${esc(alertT?.language ?? 'id')}">`)}
              ${field('Parameters', '<textarea name="params" rows="3" placeholder="One per line, in the template\'s order ({{1}}, {{2}}, …)"></textarea>', { full: true, opt: true })}
              <div class="field full"><label class="check"><input type="checkbox" name="copyCode"> <span>Authentication template with a copy-code button (the first parameter is the code)</span></label>${otp ? `<div class="help">The sign-in code template is <span class="mono">${esc(otp.name)}</span> (${esc(otp.language)}).</div>` : ''}</div>
              <div class="field full"><button class="btn primary" type="submit">Send test</button></div>
            </form>
            <div data-test-out style="margin-top:10px" aria-live="polite"></div>
          </div>
        </div>`;
      // Values set as text, never interpolated as markup.
      $('[data-url]', body).textContent = w.url ?? 'Save the sign-in codes integration once to issue the webhook URL.';
      $('[data-token]', body).textContent = w.verifyToken ?? '—';
      $$('[data-copy]', body).forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy === 'url' ? w.url ?? '' : w.verifyToken ?? '')));
      const form = $('[data-test-form]', body);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        const params = String(f.get('params') ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
        const out = $('[data-test-out]', body);
        const btn = $('button[type="submit"]', form);
        btn.disabled = true;
        out.innerHTML = '<span class="spinner"></span>';
        try {
          const r = await api('/v1/whatsapp/test', { method: 'POST', body: { phone: f.get('phone'), template: f.get('template'), language: f.get('language'), params, copyCodeButton: f.get('copyCode') === 'on' } });
          out.innerHTML = r.ok
            ? callout('ok', `Sent to <span class="mono">${esc(r.to)}</span> (message <span class="mono small">${esc(r.messageId)}</span>). Its delivery shows under <b>Messages</b> once Meta reports it.`)
            : callout('crit', `Not sent to <span class="mono">${esc(r.to)}</span>: ${esc(r.error)}`);
        } catch (err) { out.innerHTML = callout('crit', esc(err.message)); }
        finally { btn.disabled = false; }
      });
    };

    // (v1.11.0) The support inbox: refreshed every 10 s while it is open.
    let poll = null;
    let openId = null;
    let handlerFilter = '';
    let assistantMode = null;
    const stopPoll = () => { if (poll) { clearInterval(poll); poll = null; } };

    const drawInbox = async () => {
      body.innerHTML = `<div data-assistant></div>
        <div class="row section" style="margin-top:0;justify-content:space-between">
          <div class="seg" role="group" aria-label="Show" data-handler>${[['', 'All'], ['human', 'Staff'], ['ai', 'AI'], ['closed', 'Closed']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(v === handlerFilter)}">${esc(l)}</button>`).join('')}</div>
          <span class="cell-sub">Customers who write to the WhatsApp number. Messages are kept 90 days.</span>
        </div>
        <div class="wa-inbox"><div class="card wa-list" data-convs></div><div class="card" data-thread><div class="empty-state">Choose a conversation.</div></div></div>`;

      const drawList = async () => {
        let r;
        try { r = await api(`/v1/whatsapp/conversations?limit=100${handlerFilter ? `&handler=${handlerFilter}` : ''}`); } catch (e) { $('[data-convs]', body).innerHTML = callout('crit', esc(e.message)); return; }
        const a = r.assistant;
        assistantMode = a.configured ? a.mode : null;
        $('[data-assistant]', body).innerHTML = a.configured
          ? (a.mode === 'off' ? callout('info', `The AI assistant is off: staff answer every message. ${toIntegrations}`) : '')
          : callout('info', `No AI assistant: staff answer every message here. To have Claude answer (or draft answers), set up <b>WhatsApp AI support</b>. ${toIntegrations}`);
        const list = $('[data-convs]', body);
        if (!r.conversations.length) { list.innerHTML = '<div class="empty-state">No conversations yet.</div>'; return; }
        list.innerHTML = r.conversations.map((c) => `<button type="button" class="wa-conv" data-conv="${esc(c.id)}" aria-current="${String(c.id === openId)}">
            <span class="top"><span class="who">${esc(c.name ?? c.phone)}</span>${c.unread ? `<span class="wa-unread" aria-label="${esc(`${c.unread} unread`)}">${esc(String(c.unread))}</span>` : ''}${handlerTag(c.handler)}</span>
            <span class="snip">${esc(c.lastAuthor && c.lastAuthor !== 'customer' ? `${c.lastAuthor === 'ai' ? 'AI' : 'Staff'}: ` : '')}${esc(c.lastMessage ?? '')}</span>
            <span class="cell-sub">${esc(c.name ? `${c.phone} · ` : '')}${esc(fmt.ago(c.lastMessageAt))}${c.draft ? ' · draft ready' : ''}</span>
          </button>`).join('');
      };

      const drawThread = async (id, keepCompose = false) => {
        const box = $('[data-thread]', body);
        let r;
        try { r = await api(`/v1/whatsapp/conversations/${encodeURIComponent(id)}`); } catch (e) { box.innerHTML = callout('crit', esc(e.message)); return; }
        const c = r.conversation;
        const typed = keepCompose ? $('[data-text]', box)?.value : null;
        box.innerHTML = `<div class="wa-thread">
            <header><h3 style="margin:0">${esc(c.name ?? c.phone)}</h3>
              <span class="cell-sub">${esc(c.phone)}${c.hasAccount ? ' · PlugSure account' : ''}</span>${handlerTag(c.handler)}
              <span class="actions">
                ${c.handler !== 'human' ? `<button class="btn sm" type="button" data-set="human">${icon('users')} Take over</button>` : ''}
                ${c.handler !== 'ai' ? `<button class="btn sm" type="button" data-set="ai">Hand to AI</button>` : ''}
                ${c.handler !== 'closed' ? `<button class="btn sm" type="button" data-set="closed">Close</button>` : ''}
              </span></header>
            ${c.handoffReason && c.handler === 'human' ? callout('warn', `<b>Handed to staff:</b> ${esc(c.handoffReason)}`) : ''}
            <div class="wa-msgs" data-msgs>${r.messages.map(bubble).join('') || '<div class="wa-note">No messages.</div>'}</div>
            <form class="wa-compose" data-compose>
              ${c.windowOpen ? '' : callout('info', 'More than 24 hours since the customer last wrote: WhatsApp only allows approved templates now. They can write again to reopen the chat.')}
              ${c.draft ? '<div class="cell-sub">The assistant\'s draft is below: edit it if needed, then send.</div>' : ''}
              <label class="sr-only" for="wa-reply">Reply</label>
              <textarea id="wa-reply" data-text maxlength="4096" placeholder="Write a reply…" ${c.windowOpen ? '' : 'disabled'}></textarea>
              <div class="row" style="gap:8px;justify-content:flex-end">
                <button class="btn" type="button" data-suggest ${c.windowOpen ? '' : 'disabled'}>Suggest reply</button>
                <button class="btn primary" type="submit" ${c.windowOpen ? '' : 'disabled'}>Send</button>
              </div>
              ${c.handler === 'human' ? '' : `<div class="cell-sub">${c.handler === 'ai' && assistantMode === 'draft' ? 'The assistant keeps drafting the next replies.' : 'Sending takes the conversation over from the assistant.'}</div>`}
            </form></div>`;
        // Set as a value, never as markup.
        $('[data-text]', box).value = typed ?? c.draft ?? '';
        const msgs = $('[data-msgs]', box);
        msgs.scrollTop = msgs.scrollHeight;
        $$('[data-set]', box).forEach((b) => b.addEventListener('click', async () => {
          try { await api(`/v1/whatsapp/conversations/${encodeURIComponent(id)}/handler`, { method: 'POST', body: { handler: b.dataset.set } }); } catch (e) { toast(e.message, 'crit'); return; }
          toast(b.dataset.set === 'ai' ? 'The assistant answers this conversation again.' : b.dataset.set === 'human' ? 'You have taken over: the assistant stays quiet.' : 'Closed.');
          await Promise.all([drawThread(id), drawList()]);
        }));
        $('[data-suggest]', box).addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const s2 = await api(`/v1/whatsapp/conversations/${encodeURIComponent(id)}/suggest`, { method: 'POST' });
            if (s2.draft) $('[data-text]', box).value = s2.draft;
            if (s2.handoff) toast(`The assistant suggests a person answers: ${s2.handoff}`, 'warn');
            else if (!s2.draft) toast('The assistant had no suggestion.', 'warn');
          } catch (err) { toast(err.message, 'crit'); }
          finally { btn.disabled = false; }
        });
        $('[data-compose]', box).addEventListener('submit', async (e) => {
          e.preventDefault();
          const text = $('[data-text]', box).value.trim();
          if (!text) return;
          const btn = $('button[type="submit"]', box);
          btn.disabled = true;
          try {
            await api(`/v1/whatsapp/conversations/${encodeURIComponent(id)}/reply`, { method: 'POST', body: { text } });
            $('[data-text]', box).value = '';
            await Promise.all([drawThread(id), drawList()]);
          } catch (err) { toast(err.message, 'crit'); btn.disabled = false; }
        });
      };

      $('[data-handler]', body).addEventListener('click', async (e) => {
        const b = e.target.closest('button[data-v]');
        if (!b) return;
        handlerFilter = b.dataset.v;
        $$('[data-handler] button', body).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        await drawList();
      });
      $('[data-convs]', body).addEventListener('click', async (e) => {
        const b = e.target.closest('[data-conv]');
        if (!b) return;
        openId = b.dataset.conv;
        $$('[data-conv]', body).forEach((x) => x.setAttribute('aria-current', String(x === b)));
        await drawThread(openId);
        await drawList();
      });
      await drawList();
      if (openId) await drawThread(openId);
      poll = setInterval(async () => {
        if (!root.isConnected || current !== 'inbox') { stopPoll(); return; }
        // Not while staff are typing a reply: the thread is redrawn with what they typed.
        await drawList();
        if (openId) await drawThread(openId, true);
      }, 10_000);
    };

    const show = async (id) => {
      stopPoll();
      current = id;
      $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
      history.replaceState(null, '', `#/whatsapp/${id}`);
      if ((id === 'overview' || id === 'setup') && !o) {
        body.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
        try { await load(); } catch (e) { body.innerHTML = callout('crit', esc(e.status === 403 ? 'Only platform administrators can see the WhatsApp Business dashboard.' : e.message)); return; }
      }
      if (id === 'overview') drawOverview();
      else if (id === 'inbox') await drawInbox();
      else if (id === 'templates') await drawTemplates();
      else if (id === 'messages') await drawMessages();
      else drawSetup();
    };
    const refresh = async () => { o = null; await show(current); };

    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    $('[data-refresh]', root).addEventListener('click', refresh);
    await show(current);
  },
});
