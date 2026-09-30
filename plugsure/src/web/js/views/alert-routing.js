import {
  $, $$, esc, api, attempt, state, registerView, pageHead, table, tag, icon, fmt, field, callout, modal, confirmDialog, toast,
  formValues, fieldErrors, sites as loadSites,
} from '../core.js';

/**
 * Alert routing — who gets told about which alerts, by e-mail, WhatsApp and SMS.
 *
 *   Channels   the SMTP server, the WhatsApp Business sender (with its delivery-status
 *              webhook) and the SMS provider (secrets are write-only: the page never
 *              receives them back)
 *   Contacts   people on call: name, e-mail, WhatsApp, SMS
 *   Rotas      who is on duty this week (or day), with overrides for leave and swaps
 *   Rules      severity / alert type / sites → contacts and rotas, quiet hours,
 *              "resolved" notices, SMS when WhatsApp fails, escalation when nobody acknowledges
 *   Log        every message: sent, delivered, read, queued, failed (with the reason), suppressed
 */

const SEV = { info: 'Info and above', warning: 'Warning and above', critical: 'Critical only' };
const STATE_TAG = { sent: 't-ok', pending: 't-info', failed: 't-crit', suppressed: 't-mute' };
const DELIVERY_TAG = { delivered: 't-ok', read: 't-ok', failed: 't-crit' };
const STAGE_LABEL = { raised: 'alert', escalation: 'escalation', resolved: 'resolved', storm: 'flood notice', test: 'test' };
const SMS_PROVIDERS = [['twilio', 'Twilio'], ['zenziva', 'Zenziva'], ['http', 'Your own gateway']];
const chLabel = (c) => (c === 'email' ? 'E-mail' : c === 'sms' ? 'SMS' : 'WhatsApp');
const smsConfigured = (c) => (c.provider === 'zenziva' ? !!c.userkey : c.provider === 'http' ? !!c.url : !!c.accountSid);
const isConfigured = (kind, c) => (kind === 'email' ? !!c.host : kind === 'sms' ? smsConfigured(c) : !!c.phoneNumberId);
// Rota times in the alert time zone (shifts hand over in it), whatever the browser's own zone.
const when = (d, tz) => new Date(d).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz });
const localInput = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
const seg = (name, list, selected) =>
  `<div class="seg" role="group" data-seg="${esc(name)}">${list.map(([v, l]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${String(v === selected)}">${esc(l)}</button>`).join('')}</div>`;
const wireSeg = (root) => $$('[data-seg]', root).forEach((g) => g.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]'); if (!b) return;
  $$('button', g).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  g.dispatchEvent(new Event('change'));
}));
const segVal = (root, name) => $(`[data-seg="${name}"] [aria-pressed="true"]`, root)?.dataset.v;
const checks = (name, items, selected) =>
  `<div class="check-list" data-checks="${esc(name)}" style="display:grid;gap:4px;max-height:220px;overflow:auto">${items.map(([v, l, sub]) =>
    `<label class="check"><input type="checkbox" value="${esc(v)}"${selected.includes(v) ? ' checked' : ''}> <span>${esc(l)}${sub ? ` <span class="cell-sub">${esc(sub)}</span>` : ''}</span></label>`).join('') || '<div class="cell-sub">None yet.</div>'}</div>`;
const checked = (root, name) => $$(`[data-checks="${name}"] input:checked`, root).map((i) => i.value);
const contactName = (data, id) => data.contacts.find((c) => c.id === id)?.name ?? '?';

// ------------------------------------------------------------------ channels

function channelCard(kind, ch, canWrite) {
  const c = ch.config ?? {};
  const configured = isConfigured(kind, c);
  const status = !configured ? tag('t-mute', 'not set up')
    : !ch.enabled ? tag('t-mute', 'off')
    : ch.last_error ? tag('t-crit', 'failing', ch.last_error)
    : ch.last_test_ok ? tag('t-ok', 'working') : tag('t-info', 'on');
  const detail = !configured ? (kind === 'email'
    ? 'Send alerts through your SMTP server: Google Workspace, Microsoft 365, Amazon SES, Mailgun, Brevo or your own relay.'
    : kind === 'sms' ? 'Send alerts by SMS through Twilio, Zenziva or your own gateway — on its own, or only when a WhatsApp message fails.'
    : 'Send alerts through the WhatsApp Business Cloud API (Meta) or a BSP that offers the same API.')
    : kind === 'email' ? `${esc(c.fromName ? `${c.fromName} <${c.fromAddress}>` : c.fromAddress)} via ${esc(c.host)}:${esc(c.port)} (${esc(c.security)})`
    : kind === 'sms' ? `${esc(SMS_PROVIDERS.find(([v]) => v === c.provider)?.[1] ?? c.provider)}${c.from ? ` · from <span class="mono">${esc(c.from)}</span>` : c.messagingServiceSid ? ` · service <span class="mono">${esc(c.messagingServiceSid)}</span>` : ''}${c.url ? ` · <span class="mono">${esc(c.url)}</span>` : ''}`
    : `Number ID <span class="mono">${esc(c.phoneNumberId)}</span> · template <span class="mono">${esc(c.templateName)}</span> (${esc(c.templateLang)})`;
  const hook = kind === 'whatsapp' && configured
    ? `<div class="cell-sub" style="margin-bottom:10px" data-wa-status>${ch.webhook?.hasAppSecret
      ? `${tag('t-ok', 'delivery status on')} Meta reports delivered, read and failed.`
      : `${tag('t-warn', 'no delivery status')} "Sent" only means WhatsApp accepted the message. Add the app secret and the webhook under <b>Edit settings</b> to see delivered, read and failed.`}</div>`
    : '';
  return `<div class="card" data-channel="${kind}"><header><h3>${icon(kind === 'email' ? 'list' : 'bell')} ${chLabel(kind)}</h3><div class="right">${status}</div></header>
    <div class="cell-sub" style="margin-bottom:10px">${detail}</div>
    ${hook}
    ${ch.last_error ? `<div class="cell-sub" style="color:var(--crit);margin-bottom:10px">${esc(ch.last_error)}</div>` : ''}
    ${ch.last_test_at ? `<div class="cell-sub" style="margin-bottom:10px">Last test ${esc(fmt.ago(ch.last_test_at))}: ${ch.last_test_ok ? 'delivered' : 'failed'}</div>` : ''}
    ${canWrite ? `<div class="row" style="gap:6px;flex-wrap:wrap"><button class="btn sm${configured ? '' : ' primary'}" type="button" data-setup="${kind}">${configured ? 'Edit settings' : 'Set up'}</button>${configured ? `<button class="btn sm" type="button" data-test="${kind}">Send a test</button>` : ''}</div>` : ''}
  </div>`;
}

function smsForm(ch) {
  const c = ch.config ?? {};
  const p = c.provider ?? 'twilio';
  const saved = (prov) => ch.has_secret && p === prov;
  const secretField = (prov, label, help) => field(label, `<input name="secret_${prov}" type="password" autocomplete="new-password">`, { opt: saved(prov), help: saved(prov) ? 'Saved. Leave empty to keep it.' : help });
  return `<div class="field full"><label>Provider</label>${seg('provider', SMS_PROVIDERS, p)}</div>
    <div class="form" data-prov="twilio"${p === 'twilio' ? '' : ' hidden'}>
      ${field('Account SID', `<input name="accountSid" value="${esc(c.accountSid ?? '')}" placeholder="AC…" autocomplete="off">`)}
      ${secretField('twilio', 'Auth token', 'Twilio console → Account info.')}
      ${field('Sender number', `<input name="from" value="${esc(c.from ?? '')}" placeholder="+1 555 010 0000" autocomplete="off">`, { opt: true, help: 'Or a Messaging Service below.' })}
      ${field('Messaging Service SID', `<input name="messagingServiceSid" value="${esc(c.messagingServiceSid ?? '')}" placeholder="MG…" autocomplete="off">`, { opt: true, help: 'Needed for an alphanumeric sender in Indonesia.' })}
    </div>
    <div class="form" data-prov="zenziva"${p === 'zenziva' ? '' : ' hidden'}>
      ${field('User key', `<input name="userkey" value="${esc(c.userkey ?? '')}" autocomplete="off">`)}
      ${secretField('zenziva', 'Pass key', 'Zenziva console → API.')}
      ${field('API URL', `<input name="endpoint" value="${esc(c.endpoint ?? '')}" placeholder="https://console.zenziva.net/reguler/api/sendsms/" autocomplete="off">`, { opt: true, full: true })}
    </div>
    <div class="form" data-prov="http"${p === 'http' ? '' : ' hidden'}>
      ${field('Gateway URL', `<input name="url" value="${esc(c.url ?? '')}" placeholder="https://sms.yourcompany.co.id/send" autocomplete="off">`, { full: true, help: 'Receives POST { to, message, channel: "sms", purpose: "alert" } with the token as a bearer token.' })}
      ${secretField('http', 'Token', '')}
    </div>`;
}

function whatsappHook(ch) {
  const w = ch.webhook;
  return `<h4 style="margin:18px 0 6px">Delivery status (Meta webhook)</h4>
    ${w ? `<div class="cell-sub" style="margin-bottom:8px">In your Meta app → WhatsApp → Configuration, enter this callback URL and verify token and subscribe to <b>messages</b>. The address comes from <span class="mono">PUBLIC_BASE_URL</span>; it must be reachable from the internet (the public host that also takes payment notifications).</div>
      <div class="form">
        ${field('Callback URL', `<input readonly class="mono" value="${esc(w.url ?? location.origin + w.path)}" data-copy>`, { full: true })}
        ${field('Verify token', `<input readonly class="mono" value="${esc(w.verifyToken ?? '')}" data-copy>`, { full: true })}
      </div>`
    : '<div class="cell-sub" style="margin-bottom:8px">Save once to create this channel\'s callback URL and verify token.</div>'}
    <div class="form one">${field('App secret', '<input name="webhookSecret" type="password" autocomplete="new-password">', { opt: true, help: w?.hasAppSecret ? 'Saved. Leave empty to keep it.' : 'Meta app → App settings → Basic. Status updates are checked against it; without it they are refused.' })}</div>`;
}

function editChannel(kind, ch, done) {
  const c = ch.config ?? {};
  const secretHelp = ch.has_secret ? 'Saved. Leave empty to keep it.' : '';
  const body = kind === 'sms' ? smsForm(ch) : kind === 'email'
    ? `<div class="form">
        ${field('SMTP server', `<input name="host" value="${esc(c.host ?? '')}" placeholder="smtp.gmail.com" autocomplete="off">`)}
        ${field('Port', `<input name="port" inputmode="numeric" value="${esc(c.port ?? 587)}">`, { help: '587 with STARTTLS, or 465 with TLS.' })}
        <div class="field full"><label>Connection security</label>${seg('security', [['starttls', 'STARTTLS (587)'], ['tls', 'TLS (465)'], ['none', 'None (local relay)']], c.security ?? 'starttls')}</div>
        ${field('User name', `<input name="username" value="${esc(c.username ?? '')}" autocomplete="off">`, { opt: true, help: 'Leave empty for a relay that does not need a login.' })}
        ${field('Password', '<input name="secret" type="password" autocomplete="new-password">', { opt: ch.has_secret, help: secretHelp || 'For Gmail / Google Workspace use an app password.' })}
        ${field('Sender address', `<input name="fromAddress" value="${esc(c.fromAddress ?? '')}" placeholder="alerts@yourcompany.co.id" autocomplete="off">`)}
        ${field('Sender name', `<input name="fromName" value="${esc(c.fromName ?? 'PlugSure Alerts')}" autocomplete="off">`, { opt: true })}
      </div>`
    : `${callout('info', `WhatsApp only delivers business-initiated messages through an <b>approved template</b>. In WhatsApp Manager create a <b>Utility</b> template named as below with exactly three body variables, for example:<br><span class="mono">Peringatan PlugSure ({{1}}): {{2}} Waktu: {{3}}</span><br>{{1}} is the status (CRITICAL, RESOLVED …), {{2}} the alert and site, {{3}} the time.`)}
      <div class="form" style="margin-top:12px">
        ${field('Phone number ID', `<input name="phoneNumberId" inputmode="numeric" value="${esc(c.phoneNumberId ?? '')}" autocomplete="off">`, { help: 'WhatsApp Manager → API setup. Not the phone number itself.' })}
        ${field('Access token', '<input name="secret" type="password" autocomplete="new-password">', { opt: ch.has_secret, help: secretHelp || 'A permanent System User token with whatsapp_business_messaging.' })}
        ${field('Template name', `<input name="templateName" value="${esc(c.templateName ?? 'plugsure_alert')}" autocomplete="off">`)}
        ${field('Template language', `<input name="templateLang" value="${esc(c.templateLang ?? 'id')}" autocomplete="off">`, { help: 'id for Bahasa Indonesia, en_US for English.' })}
        ${field('API base URL', `<input name="apiBase" value="${esc(c.apiBase ?? 'https://graph.facebook.com/v21.0')}" autocomplete="off">`, { full: true, help: 'Change only for a BSP that offers the Cloud API at its own address.' })}
      </div>${whatsappHook(ch)}`;
  modal({
    title: `${chLabel(kind)} settings`,
    size: 'lg',
    body: `${body}<label class="check" style="margin-top:12px"><input type="checkbox" name="enabled"${ch.enabled !== false ? ' checked' : ''}> <span>Send alerts through this channel</span></label>`,
    onMount(ctx) {
      wireSeg(ctx.body);
      $$('[data-copy]', ctx.body).forEach((i) => i.addEventListener('focus', () => i.select()));
      $('[data-seg="provider"]', ctx.body)?.addEventListener('change', () => {
        const p = segVal(ctx.body, 'provider');
        $$('[data-prov]', ctx.body).forEach((d) => { d.hidden = d.dataset.prov !== p; });
      });
    },
    actions: [{ label: 'Cancel' }, {
      label: 'Save', kind: 'primary',
      async onClick(ctx) {
        let payload;
        if (kind === 'sms') {
          const p = segVal(ctx.body, 'provider');
          const { [`secret_${p}`]: secret, ...rest } = formValues($(`[data-prov="${p}"]`, ctx.body));
          const config = { provider: p, ...Object.fromEntries(Object.entries(rest).filter(([, x]) => x !== '' && x != null)) };
          payload = { enabled: $('[name=enabled]', ctx.body).checked, config, secret: secret || undefined };
        } else {
          const { secret, enabled, webhookSecret, ...cfg } = formValues(ctx.body);
          if (kind === 'email') cfg.security = segVal(ctx.body, 'security');
          payload = { enabled, config: cfg, secret: secret || undefined, webhookSecret: webhookSecret || undefined };
        }
        try {
          await api(`/v1/alert-routing/channels/${kind}`, { method: 'PUT', body: payload });
          toast(`${chLabel(kind)} settings saved — send a test to check them`, 'ok');
          done();
        } catch (e) { toast(e.message, 'crit'); return false; }
      },
    }],
  });
}

function testChannel(kind, done) {
  const me = state.me?.user ?? {};
  modal({
    title: `Send a test ${kind === 'email' ? 'e-mail' : kind === 'sms' ? 'SMS' : 'WhatsApp message'}`,
    body: `<div class="form one">${field(kind === 'email' ? 'Send to' : kind === 'sms' ? 'Mobile number' : 'WhatsApp number', `<input name="destination" value="${esc(kind === 'email' ? me.email ?? '' : '')}" placeholder="${kind === 'email' ? 'you@company.co.id' : '0812 3456 7890'}" autocomplete="off">`)}</div>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Send', kind: 'primary',
      async onClick(ctx) {
        try {
          const r = await api(`/v1/alert-routing/channels/${kind}/test`, { method: 'POST', body: { destination: $('[name=destination]', ctx.body).value } });
          toast(r.ok ? `Sent to ${r.destination}${r.reference ? ` (ref ${r.reference.slice(0, 40)})` : ''}` : `Failed: ${r.error}`, r.ok ? 'ok' : 'crit');
          done();
          return r.ok ? undefined : false;
        } catch (e) { toast(e.message, 'crit'); return false; }
      },
    }],
  });
}

// ------------------------------------------------------------------ contacts

function editContact(c, done) {
  modal({
    title: c ? 'Edit contact' : 'Add contact',
    body: `<div class="form one">
      ${field('Name', `<input name="name" value="${esc(c?.name ?? '')}" placeholder="e.g. Budi (on-call technician)" autocomplete="off">`)}
      ${field('E-mail', `<input name="email" type="email" value="${esc(c?.email ?? '')}" autocomplete="off">`, { opt: true })}
      ${field('WhatsApp', `<input name="whatsapp" inputmode="tel" value="${esc(c?.whatsapp ? `+${c.whatsapp}` : '')}" placeholder="0812 3456 7890" autocomplete="off">`, { opt: true, help: 'The number must have WhatsApp.' })}
      ${field('SMS', `<input name="sms" inputmode="tel" value="${esc(c?.sms ? `+${c.sms}` : '')}" placeholder="Same as WhatsApp" autocomplete="off">`, { opt: true, help: 'Only if SMS should go to another number than WhatsApp. At least one of e-mail, WhatsApp or SMS is needed.' })}
      <label class="check"><input type="checkbox" name="active"${c?.active === false ? '' : ' checked'}> <span>Active (untick while on leave)</span></label>
    </div>`,
    actions: [{ label: 'Cancel' }, {
      label: c ? 'Save' : 'Add contact', kind: 'primary',
      async onClick(ctx) {
        const v = formValues(ctx.body);
        try {
          await api(c ? `/v1/alert-routing/contacts/${c.id}` : '/v1/alert-routing/contacts', { method: c ? 'PUT' : 'POST', body: v });
          toast(c ? 'Contact saved' : 'Contact added', 'ok');
          done();
        } catch (e) { fieldErrors(ctx.body, {}); toast(e.message, 'crit'); return false; }
      },
    }],
  });
}

// ------------------------------------------------------------------ rotas

function editRota(rota, data, done) {
  const members = rota?.member_ids ?? [];
  // Members in rotation order: the chosen ones first (in order), then the rest unticked.
  const ordered = [...members.map((id) => data.contacts.find((c) => c.id === id)).filter(Boolean), ...data.contacts.filter((c) => !members.includes(c.id))];
  const today = new Date().toISOString().slice(0, 10);
  modal({
    title: rota ? 'Edit rota' : 'New on-call rota',
    size: 'lg',
    body: `<div class="form">
      ${field('Name', `<input name="name" value="${esc(rota?.name ?? '')}" placeholder="e.g. Teknisi Jakarta" autocomplete="off">`, { full: true })}
      <div class="field"><label>Shift</label>${seg('shift', [['weekly', 'Weekly'], ['daily', 'Daily']], rota?.shift ?? 'weekly')}</div>
      ${field(`Handover time (${esc(data.timeZone)})`, `<input name="handoverTime" type="time" value="${esc(rota?.handover_time ?? '08:00')}">`)}
      ${field('First shift starts on', `<input name="startsOn" type="date" value="${esc(String(rota?.starts_on ?? today).slice(0, 10))}">`, { help: 'The first person ticked takes the first shift, the next the one after, and so on round.' })}
      <div class="field full"><label>People, in the order they take shifts</label>
        <ol data-members style="display:grid;gap:4px;padding-left:0;list-style:none;margin:0">${ordered.map((c) => `<li class="row" style="gap:6px" data-id="${esc(c.id)}">
          <label class="check" style="flex:1"><input type="checkbox"${members.includes(c.id) ? ' checked' : ''}> <span>${esc(c.name)}</span></label>
          <button class="btn sm ghost" type="button" data-up aria-label="Move ${esc(c.name)} up">↑</button><button class="btn sm ghost" type="button" data-down aria-label="Move ${esc(c.name)} down">↓</button></li>`).join('') || '<li class="cell-sub">Add contacts first.</li>'}</ol></div>
    </div>`,
    onMount(ctx) {
      wireSeg(ctx.body);
      $('[data-members]', ctx.body).addEventListener('click', (e) => {
        const li = e.target.closest('li'); if (!li) return;
        if (e.target.closest('[data-up]') && li.previousElementSibling) li.parentNode.insertBefore(li, li.previousElementSibling);
        if (e.target.closest('[data-down]') && li.nextElementSibling) li.parentNode.insertBefore(li.nextElementSibling, li);
      });
    },
    actions: [{ label: 'Cancel' }, {
      label: rota ? 'Save rota' : 'Create rota', kind: 'primary',
      async onClick(ctx) {
        const v = formValues(ctx.body);
        const body = {
          name: v.name, shift: segVal(ctx.body, 'shift'), handoverTime: v.handoverTime, startsOn: v.startsOn,
          memberIds: $$('[data-members] li[data-id]', ctx.body).filter((li) => $('input', li).checked).map((li) => li.dataset.id),
        };
        try {
          await api(rota ? `/v1/alert-routing/rotas/${rota.id}` : '/v1/alert-routing/rotas', { method: rota ? 'PUT' : 'POST', body });
          toast(rota ? 'Rota saved' : 'Rota created', 'ok');
          done();
        } catch (e) { toast(e.message, 'crit'); return false; }
      },
    }],
  });
}

function addOverride(rota, data, done) {
  const start = new Date(); start.setMinutes(0, 0, 0);
  const end = rota.duty?.shiftEnds ? new Date(rota.duty.shiftEnds) : new Date(start.getTime() + 24 * 3600_000);
  modal({
    title: `Cover a shift — ${rota.name}`,
    body: `<div class="form one">
      ${field('Who is on duty instead', `<select name="contactId">${data.contacts.filter((c) => c.active).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>`)}
      ${field('From', `<input name="startsAt" type="datetime-local" value="${esc(localInput(start))}">`)}
      ${field('Until', `<input name="endsAt" type="datetime-local" value="${esc(localInput(end))}">`, { help: 'Times in this browser\'s time zone. At most 92 days.' })}
      ${field('Note', '<input name="note" placeholder="e.g. Budi on leave" autocomplete="off">', { opt: true })}
    </div>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Add override', kind: 'primary',
      async onClick(ctx) {
        const v = formValues(ctx.body);
        try {
          await api(`/v1/alert-routing/rotas/${rota.id}/overrides`, { method: 'POST', body: { contactId: v.contactId, startsAt: new Date(v.startsAt).toISOString(), endsAt: new Date(v.endsAt).toISOString(), note: v.note || undefined } });
          toast('Override added', 'ok');
          done();
        } catch (e) { toast(e.message, 'crit'); return false; }
      },
    }],
  });
}

// ------------------------------------------------------------------ rules

function editRule(r, data, siteList, done) {
  const kinds = Object.entries(data.kinds);
  const contacts = data.contacts.map((c) => [c.id, c.name, [c.email, c.whatsapp && `+${c.whatsapp}`, c.sms && `SMS +${c.sms}`].filter(Boolean).join(' · ')]);
  const rotas = data.rotas.map((x) => [x.id, `Whoever is on duty: ${x.name}`, `now ${x.duty?.contactId ? contactName(data, x.duty.contactId) : 'nobody'}`]);
  const rotaIds = new Set(data.rotas.map((x) => x.id));
  const people = [...rotas, ...contacts];
  const esc0 = r?.escalate_after_min != null;
  modal({
    title: r ? 'Edit rule' : 'New alert rule',
    size: 'lg',
    body: `<div class="form">
      ${field('Rule name', `<input name="name" value="${esc(r?.name ?? '')}" placeholder="e.g. Critical — on-call technicians" autocomplete="off">`, { full: true })}
      <div class="field full"><label>Severity</label>${seg('minSeverity', Object.entries(SEV), r?.min_severity ?? 'critical')}</div>
      <div class="field full"><label>Send by</label>
        <label class="check"><input type="checkbox" data-ch value="email"${!r || r.channels.includes('email') ? ' checked' : ''}> <span>E-mail</span></label>
        <label class="check"><input type="checkbox" data-ch value="whatsapp"${!r || r.channels.includes('whatsapp') ? ' checked' : ''}> <span>WhatsApp</span></label>
        <label class="check"><input type="checkbox" data-ch value="sms"${r?.channels.includes('sms') ? ' checked' : ''}> <span>SMS</span></label>
        <label class="check" style="margin-top:6px"><input type="checkbox" name="smsFallback"${r?.sms_fallback ? ' checked' : ''}> <span>Send an SMS instead when a WhatsApp message fails (not delivered, or the number has no WhatsApp)</span></label></div>
      <div class="field"><label>Notify</label>${checks('contacts', people, [...(r?.rota_ids ?? []), ...(r?.contact_ids ?? [])])}</div>
      <div class="field"><label>Alert types <span class="opt">(none ticked = all)</span></label>${checks('kinds', kinds.map(([k, l]) => [k, l]), r?.kinds ?? [])}</div>
      <div class="field"><label>Sites <span class="opt">(none ticked = all)</span></label>${checks('sites', siteList.filter((s) => !s.archived_at).map((s) => [s.id, s.name]), r?.site_ids ?? [])}</div>
      <div class="field"><label>Quiet hours <span class="opt">(${esc(data.timeZone)})</span></label>
        <div class="row" style="gap:6px"><input name="quietStart" type="time" value="${esc(r?.quiet_start?.slice(0, 5) ?? '')}"> to <input name="quietEnd" type="time" value="${esc(r?.quiet_end?.slice(0, 5) ?? '')}"></div>
        <div class="help">Warnings wait until the quiet hours end. Critical alerts are always sent.</div></div>
      <div class="field full"><label class="check"><input type="checkbox" name="notifyResolved"${r?.notify_resolved === false ? '' : ' checked'}> <span>Also send a message when the alert is resolved</span></label></div>
      <div class="field full"><label class="check"><input type="checkbox" data-esc${esc0 ? ' checked' : ''}> <span>Escalate if nobody acknowledges the alert</span></label>
        <div data-escbox style="margin-top:8px${esc0 ? '' : ';display:none'}">
          <div class="row" style="gap:6px;margin-bottom:8px">after <input name="escalateAfterMin" inputmode="numeric" style="width:80px" value="${esc(r?.escalate_after_min ?? 30)}"> minutes, also notify:</div>
          ${checks('esc', people, [...(r?.escalate_rota_ids ?? []), ...(r?.escalate_contact_ids ?? [])])}</div></div>
      <div class="field full"><label class="check"><input type="checkbox" name="enabled"${r?.enabled === false ? '' : ' checked'}> <span>Rule is on</span></label></div>
    </div>`,
    onMount(ctx) {
      wireSeg(ctx.body);
      $('[data-esc]', ctx.body).addEventListener('change', (e) => { $('[data-escbox]', ctx.body).style.display = e.target.checked ? '' : 'none'; });
    },
    actions: [{ label: 'Cancel' }, {
      label: r ? 'Save rule' : 'Create rule', kind: 'primary',
      async onClick(ctx) {
        const v = formValues(ctx.body);
        const escOn = $('[data-esc]', ctx.body).checked;
        const who = checked(ctx.body, 'contacts');
        const escWho = escOn ? checked(ctx.body, 'esc') : [];
        const body = {
          name: v.name,
          enabled: v.enabled,
          minSeverity: segVal(ctx.body, 'minSeverity'),
          channels: $$('[data-ch]:checked', ctx.body).map((i) => i.value),
          smsFallback: v.smsFallback,
          contactIds: who.filter((id) => !rotaIds.has(id)),
          rotaIds: who.filter((id) => rotaIds.has(id)),
          kinds: checked(ctx.body, 'kinds'),
          siteIds: checked(ctx.body, 'sites'),
          quietStart: v.quietStart, quietEnd: v.quietEnd,
          notifyResolved: v.notifyResolved,
          escalateAfterMin: escOn ? v.escalateAfterMin : null,
          escalateContactIds: escWho.filter((id) => !rotaIds.has(id)),
          escalateRotaIds: escWho.filter((id) => rotaIds.has(id)),
        };
        try {
          await api(r ? `/v1/alert-routing/rules/${r.id}` : '/v1/alert-routing/rules', { method: r ? 'PUT' : 'POST', body });
          toast(r ? 'Rule saved' : 'Rule created', 'ok');
          done();
        } catch (e) { toast(e.message, 'crit'); return false; }
      },
    }],
  });
}

function ruleSummary(r, data, siteList) {
  const who = (ids, rotaIds = []) => [
    ...rotaIds.map((id) => `on duty: ${data.rotas.find((x) => x.id === id)?.name ?? '?'}`),
    ...ids.map((id) => contactName(data, id)),
  ].join(', ');
  const kinds = r.kinds.length ? r.kinds.map((k) => data.kinds[k] ?? k).join(', ') : 'all alert types';
  const sitesTxt = r.site_ids.length ? r.site_ids.map((id) => siteList.find((s) => s.id === id)?.name ?? '?').join(', ') : 'all sites';
  const extras = [
    r.quiet_start ? `quiet ${r.quiet_start.slice(0, 5)}–${r.quiet_end.slice(0, 5)}` : '',
    r.notify_resolved ? 'resolved notices' : '',
    r.sms_fallback ? 'SMS if WhatsApp fails' : '',
    r.escalate_after_min ? `escalate to ${who(r.escalate_contact_ids, r.escalate_rota_ids ?? [])} after ${r.escalate_after_min} min` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="cell-sub">${esc(kinds)} · ${esc(sitesTxt)}</div>${extras ? `<div class="cell-sub">${esc(extras)}</div>` : ''}<div class="cell-sub">→ ${esc(who(r.contact_ids, r.rota_ids ?? []))}</div>`;
}

// ------------------------------------------------------------------ view

registerView('alert-routing', {
  title: 'Alert routing',
  icon: 'bell',
  group: 'govern',
  order: 58,
  perm: 'alert:read',
  async render(root, [initial]) {
    const canWrite = state.can('alert:write');
    const tabs = [
      { id: 'setup', label: 'Channels & contacts' },
      { id: 'rotas', label: 'On-call rotas' },
      { id: 'rules', label: 'Rules' },
      { id: 'log', label: 'Delivery log' },
    ];
    root.innerHTML = pageHead(
      'Alert routing',
      'Send alerts to the right people by e-mail, WhatsApp and SMS — critical faults to whoever is on call at any hour, warnings to the office in working hours, and a second person if nobody acknowledges.',
      `<button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button>`,
    ) + `<div class="tabs" role="tablist">${tabs.map((t) => `<button role="tab" type="button" aria-selected="false" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}</div><div data-body></div>`;

    const body = $('[data-body]', root);
    let current = tabs.find((t) => t.id === initial)?.id ?? 'setup';
    let data = null;
    let siteList = [];

    const load = async () => {
      [data, siteList] = await Promise.all([api('/v1/alert-routing'), loadSites().catch(() => [])]);
    };

    const drawSetup = () => {
      const ch = data.channels;
      body.innerHTML = `
        ${!data.consoleUrl ? callout('info', 'Messages link to the console only when <span class="mono">CONSOLE_PUBLIC_URL</span> (or <span class="mono">PUBLIC_BASE_URL</span>) is set on the server.') : ''}
        <div class="grid three section">${channelCard('email', ch.email, canWrite)}${channelCard('whatsapp', ch.whatsapp, canWrite)}${channelCard('sms', ch.sms, canWrite)}</div>
        <div class="card section"><header><h3>Contacts</h3>${canWrite ? `<button class="btn sm primary right" type="button" data-add-contact>${icon('plus')} Add contact</button>` : ''}</header><div data-contacts></div></div>`;
      table($('[data-contacts]', body), {
        columns: [
          { label: 'Name', render: (c) => `<div class="cell-title">${esc(c.name)}</div>` },
          { label: 'E-mail', render: (c) => esc(c.email ?? '—') },
          { label: 'WhatsApp', render: (c) => (c.whatsapp ? `<span class="mono">+${esc(c.whatsapp)}</span>` : '—') },
          { label: 'SMS', render: (c) => (c.sms ? `<span class="mono">+${esc(c.sms)}</span>` : c.whatsapp ? '<span class="cell-sub">as WhatsApp</span>' : '—') },
          { label: 'Rules', render: (c) => esc(String(data.rules.filter((r) => r.contact_ids.includes(c.id) || r.escalate_contact_ids.includes(c.id)).length)) },
          { label: 'Status', render: (c) => (c.active ? tag('t-ok', 'active') : tag('t-mute', 'inactive')) },
          { label: '', render: (c) => (canWrite ? `<button class="btn sm ghost" type="button" data-del-contact="${esc(c.id)}">Remove</button>` : '') },
        ],
        rows: data.contacts,
        empty: 'No contacts yet. Add the people who should hear about alerts.',
        onRow: canWrite ? (c) => editContact(c, refresh) : undefined,
      });
      $$('[data-setup]', body).forEach((b) => b.addEventListener('click', () => editChannel(b.dataset.setup, data.channels[b.dataset.setup], refresh)));
      $$('[data-test]', body).forEach((b) => b.addEventListener('click', () => testChannel(b.dataset.test, refresh)));
      $('[data-add-contact]', body)?.addEventListener('click', () => editContact(null, refresh));
      $$('[data-del-contact]', body).forEach((b) => b.addEventListener('click', async () => {
        const c = data.contacts.find((x) => x.id === b.dataset.delContact);
        if (!(await confirmDialog({ title: 'Remove contact?', message: `${esc(c?.name)} is also taken out of every rule and rota.`, confirmLabel: 'Remove', danger: true }))) return;
        if (await attempt(() => api(`/v1/alert-routing/contacts/${c.id}`, { method: 'DELETE' }), { success: 'Contact removed' })) refresh();
      }));
    };

    const drawRotas = () => {
      body.innerHTML = `<div class="card section"><header><h3>On-call rotas</h3>${canWrite ? `<button class="btn sm primary right" type="button" data-add-rota${data.contacts.length ? '' : ' disabled title="Add a contact first"'}>${icon('plus')} New rota</button>` : ''}</header><div data-rotas></div></div>
        <p class="cell-sub">Pick "Whoever is on duty" in a rule (or its escalation) and the alert goes to the person on shift when it is routed. Shifts hand over at the rota's time in ${esc(data.timeZone)}.</p>`;
      const box = $('[data-rotas]', body);
      if (!data.rotas.length) { box.innerHTML = '<div class="empty-state">No rotas yet. A good start: "Teknisi Jakarta", weekly, handover Monday 08:00.</div>'; }
      else box.innerHTML = data.rotas.map((x) => {
        const d = x.duty ?? {};
        const ovs = (x.overrides ?? []).filter((o) => new Date(o.ends_at) > Date.now());
        return `<div class="section" data-rota="${esc(x.id)}" style="border-top:1px solid var(--line);padding-top:12px">
          <div class="row" style="gap:8px;flex-wrap:wrap;align-items:baseline">
            <div class="cell-title">${esc(x.name)}</div>
            <span class="cell-sub">${esc(x.shift === 'daily' ? 'daily' : 'weekly')} · handover ${esc(x.handover_time)} · ${esc(x.member_ids.map((id) => contactName(data, id)).join(' → '))}</span>
            ${canWrite ? `<div class="right row" style="gap:6px"><button class="btn sm" type="button" data-cover="${esc(x.id)}">Cover a shift</button><button class="btn sm" type="button" data-edit-rota="${esc(x.id)}">Edit</button><button class="btn sm ghost" type="button" data-del-rota="${esc(x.id)}">Delete</button></div>` : ''}
          </div>
          <div style="margin-top:6px" data-duty>${d.contactId
            ? `${tag('t-ok', 'on duty')} <b>${esc(contactName(data, d.contactId))}</b>${d.override ? ' (override)' : ''}${d.shiftEnds ? ` <span class="cell-sub">until ${esc(when(d.shiftEnds, data.timeZone))}, then ${esc(d.nextContactId ? contactName(data, d.nextContactId) : '—')}</span>` : ''}`
            : `${tag('t-mute', 'nobody on duty')}${d.shiftEnds ? ` <span class="cell-sub">first shift ${esc(when(d.shiftEnds, data.timeZone))}: ${esc(d.nextContactId ? contactName(data, d.nextContactId) : '—')}</span>` : ''}`}</div>
          ${ovs.length ? `<div style="margin-top:6px;display:grid;gap:4px">${ovs.map((o) => `<div class="cell-sub" data-override="${esc(o.id)}">${esc(contactName(data, o.contact_id))} covers ${esc(when(o.starts_at, data.timeZone))} – ${esc(when(o.ends_at, data.timeZone))}${o.note ? ` · ${esc(o.note)}` : ''} ${canWrite ? `<button class="btn sm ghost" type="button" data-del-override="${esc(o.id)}" data-rota-id="${esc(x.id)}">Remove</button>` : ''}</div>`).join('')}</div>` : ''}
        </div>`;
      }).join('');
      const byId = (id) => data.rotas.find((x) => x.id === id);
      $('[data-add-rota]', body)?.addEventListener('click', () => editRota(null, data, refresh));
      $$('[data-edit-rota]', body).forEach((b) => b.addEventListener('click', () => editRota(byId(b.dataset.editRota), data, refresh)));
      $$('[data-cover]', body).forEach((b) => b.addEventListener('click', () => addOverride(byId(b.dataset.cover), data, refresh)));
      $$('[data-del-rota]', body).forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Delete rota?', message: 'Rules that notify whoever is on duty on it stop doing so.', confirmLabel: 'Delete', danger: true }))) return;
        if (await attempt(() => api(`/v1/alert-routing/rotas/${b.dataset.delRota}`, { method: 'DELETE' }), { success: 'Rota deleted' })) refresh();
      }));
      $$('[data-del-override]', body).forEach((b) => b.addEventListener('click', async () => {
        if (await attempt(() => api(`/v1/alert-routing/rotas/${b.dataset.rotaId}/overrides/${b.dataset.delOverride}`, { method: 'DELETE' }), { success: 'Override removed' })) refresh();
      }));
    };

    const drawRules = () => {
      const noChannel = !['email', 'whatsapp', 'sms'].some((k) => data.channels[k].enabled && isConfigured(k, data.channels[k].config ?? {}));
      body.innerHTML = `${noChannel ? callout('warn', 'No channel is set up yet, so rules cannot send anything. Set up e-mail, WhatsApp or SMS under <b>Channels &amp; contacts</b>.') : ''}
        <div class="card section"><header><h3>Rules</h3>${canWrite ? `<button class="btn sm primary right" type="button" data-add-rule${data.contacts.length ? '' : ' disabled title="Add a contact first"'}>${icon('plus')} New rule</button>` : ''}</header><div data-rules></div></div>
        <p class="cell-sub">Every rule that matches an alert sends to its contacts; a person in several matching rules still gets one message. The same problem raised again (e.g. an hourly compliance check) does not send again while it is open.</p>`;
      table($('[data-rules]', body), {
        columns: [
          { label: 'Rule', render: (r) => `<div class="cell-title">${esc(r.name)}</div>${ruleSummary(r, data, siteList)}` },
          { label: 'Severity', render: (r) => tag(r.min_severity === 'critical' ? 't-crit' : r.min_severity === 'warning' ? 't-warn' : 't-mute', SEV[r.min_severity]) },
          { label: 'By', render: (r) => esc(r.channels.map(chLabel).join(' + ')) },
          { label: 'Status', render: (r) => (r.enabled ? tag('t-ok', 'on') : tag('t-mute', 'off')) },
          { label: '', render: (r) => (canWrite ? `<button class="btn sm ghost" type="button" data-del-rule="${esc(r.id)}">Delete</button>` : '') },
        ],
        rows: data.rules,
        empty: 'No rules yet. A good start: "Critical — on-call technician", WhatsApp with SMS fallback, whoever is on duty, escalate to the operations manager after 30 minutes.',
        onRow: canWrite ? (r) => editRule(r, data, siteList, refresh) : undefined,
      });
      $('[data-add-rule]', body)?.addEventListener('click', () => editRule(null, data, siteList, refresh));
      $$('[data-del-rule]', body).forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Delete rule?', message: 'Alerts it matched will no longer be sent by it.', confirmLabel: 'Delete', danger: true }))) return;
        if (await attempt(() => api(`/v1/alert-routing/rules/${b.dataset.delRule}`, { method: 'DELETE' }), { success: 'Rule deleted' })) refresh();
      }));
    };

    const result = (n) => {
      const base = tag(STATE_TAG[n.state] ?? 't-mute', n.state === 'pending' ? 'queued' : n.state);
      const dl = n.delivery ? ` ${tag(DELIVERY_TAG[n.delivery], n.delivery, n.delivery_error ?? '')}` : '';
      const sub = n.state === 'pending' && n.attempts ? `<div class="cell-sub">retry ${esc(fmt.timeS(n.next_attempt_at))}</div>`
        : n.state === 'pending' && new Date(n.next_attempt_at) > Date.now() + 60_000 ? `<div class="cell-sub">held until ${esc(fmt.time(n.next_attempt_at))}</div>` : '';
      const err = n.last_error ? `<div class="cell-sub" style="color:${n.state === 'failed' ? 'var(--crit)' : 'inherit'}">${esc(n.last_error)}</div>` : '';
      const derr = n.delivery === 'failed' && n.delivery_error ? `<div class="cell-sub" style="color:var(--crit)">${esc(n.delivery_error)}</div>` : '';
      const seen = n.read_at ? `<div class="cell-sub">read ${esc(fmt.time(n.read_at))}</div>` : n.delivered_at ? `<div class="cell-sub">delivered ${esc(fmt.time(n.delivered_at))}</div>` : '';
      const fb = n.fallback_of ? '<div class="cell-sub">SMS fallback for a failed WhatsApp message</div>' : '';
      return `${base}${dl}${sub}${seen}${err}${derr}${fb}`;
    };

    const drawLog = async () => {
      body.innerHTML = `<div class="filters section">${field('Status', `<select data-state><option value="">All</option><option value="sent">Sent</option><option value="pending">Queued</option><option value="failed">Failed</option><option value="suppressed">Suppressed</option></select>`)}</div><div class="card" data-log></div>`;
      const draw = async () => {
        const st = $('[data-state]', body).value;
        const { rows } = await api(`/v1/alert-routing/log${st ? `?state=${st}` : ''}`);
        table($('[data-log]', body), {
          columns: [
            { label: 'When', render: (n) => `<span class="nowrap">${esc(fmt.time(n.sent_at ?? n.created_at))}</span>` },
            { label: 'Message', render: (n) => `${tag('t-mute', STAGE_LABEL[n.stage] ?? n.stage)} ${n.kind ? `<span class="cell-title">${esc(data.kinds[n.kind] ?? n.kind)}</span>` : ''}${n.message ? `<div class="cell-sub wrap">${esc(n.message)}</div>` : ''}` },
            { label: 'To', render: (n) => `${esc(chLabel(n.channel))} · <span class="mono">${esc(n.channel === 'email' ? n.destination : `+${n.destination}`)}</span>${n.contact_name ? `<div class="cell-sub">${esc(n.contact_name)}${n.rule_name ? ` · ${esc(n.rule_name)}` : ''}</div>` : ''}` },
            { label: 'Result', render: result },
            { label: '', render: (n) => (canWrite && n.state === 'failed' && n.stage !== 'test' ? `<button class="btn sm" type="button" data-retry="${esc(n.id)}">Retry</button>` : '') },
          ],
          rows,
          empty: 'Nothing sent yet.',
        });
        $$('[data-retry]', body).forEach((b) => b.addEventListener('click', async () => {
          if (await attempt(() => api(`/v1/alert-routing/log/${b.dataset.retry}/retry`, { method: 'POST' }), { success: 'Queued again' })) draw();
        }));
      };
      $('[data-state]', body).addEventListener('change', draw);
      await draw();
    };

    const show = async (id) => {
      current = id;
      $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
      history.replaceState(null, '', `#/alert-routing/${id}`);
      if (!data) {
        try { await load(); } catch (e) { body.innerHTML = callout('crit', esc(e.status === 403 ? 'You do not have permission to view alert routing.' : e.message)); return; }
      }
      if (id === 'setup') drawSetup();
      else if (id === 'rotas') drawRotas();
      else if (id === 'rules') drawRules();
      else await drawLog();
    };
    const refresh = async () => { data = null; await show(current); };

    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    $('[data-refresh]', root).addEventListener('click', refresh);
    await show(current);
  },
});
