import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ruleMatches, inQuietHours, quietEndsAt, normaliseWhatsApp, isEmail, waParam, renderWhatsApp, renderEmail, formatTime,
  type MessageInput,
} from './alert-format.js';
import { checkChannelConfig } from './notify-transports.js';

const TZ = 'Asia/Jakarta';
// 2026-09-27 02:30 WIB = 2026-09-26 19:30 UTC
const at = (hhmmWib: string) => {
  const [h, m] = hhmmWib.split(':').map(Number);
  return new Date(Date.UTC(2026, 8, 27, h! - 7, m!));
};

describe('alert rule matching', () => {
  const rule = { enabled: true, min_severity: 'warning', kinds: [] as string[], site_ids: [] as string[] };
  const a = { severity: 'critical', kind: 'charge_point.offline', site_id: 'S1' };

  test('severity threshold', () => {
    assert.equal(ruleMatches(rule, a), true);
    assert.equal(ruleMatches(rule, { ...a, severity: 'info' }), false);
    assert.equal(ruleMatches({ ...rule, min_severity: 'critical' }, { ...a, severity: 'warning' }), false);
  });
  test('kinds: exact and family wildcard', () => {
    assert.equal(ruleMatches({ ...rule, kinds: ['connector.faulted'] }, a), false);
    assert.equal(ruleMatches({ ...rule, kinds: ['charge_point.offline'] }, a), true);
    assert.equal(ruleMatches({ ...rule, kinds: ['compliance.*'] }, { ...a, kind: 'compliance.tera_lapsed' }), true);
    assert.equal(ruleMatches({ ...rule, kinds: ['compliance.*'] }, a), false);
  });
  test('site scope: a site-scoped rule never takes an alert with no site', () => {
    assert.equal(ruleMatches({ ...rule, site_ids: ['S1'] }, a), true);
    assert.equal(ruleMatches({ ...rule, site_ids: ['S2'] }, a), false);
    assert.equal(ruleMatches({ ...rule, site_ids: ['S1'] }, { ...a, site_id: null }), false);
    assert.equal(ruleMatches(rule, { ...a, site_id: null }), true);
  });
  test('disabled rules match nothing', () => {
    assert.equal(ruleMatches({ ...rule, enabled: false }, a), false);
  });
});

describe('quiet hours (local time)', () => {
  test('a window across midnight', () => {
    assert.equal(inQuietHours(at('23:10'), '22:00', '06:00', TZ), true);
    assert.equal(inQuietHours(at('02:30'), '22:00', '06:00', TZ), true);
    assert.equal(inQuietHours(at('06:00'), '22:00', '06:00', TZ), false);
    assert.equal(inQuietHours(at('12:00'), '22:00', '06:00', TZ), false);
  });
  test('a daytime window, and none', () => {
    assert.equal(inQuietHours(at('13:00'), '12:00', '14:00', TZ), true);
    assert.equal(inQuietHours(at('14:00'), '12:00', '14:00', TZ), false);
    assert.equal(inQuietHours(at('13:00'), null, null, TZ), false);
  });
  test('held messages go out when the window ends', () => {
    const end = quietEndsAt(at('02:30'), '06:00', TZ);
    assert.equal(formatTime(end, TZ), '27 Sep 2026 06:00 WIB');
  });
});

describe('addresses', () => {
  test('Indonesian WhatsApp numbers in every common spelling', () => {
    for (const s of ['0812-3456-7890', '+62 812 3456 7890', '62 812 3456 7890', '812 3456 7890', '0062 812 3456 7890']) {
      assert.equal(normaliseWhatsApp(s), '6281234567890', s);
    }
    assert.equal(normaliseWhatsApp('+44 7700 900123'), '447700900123');
    assert.equal(normaliseWhatsApp('12'), null);
    assert.equal(normaliseWhatsApp('not a number'), null);
  });
  test('e-mail', () => {
    assert.equal(isEmail('ops@plugsure.com'), true);
    assert.equal(isEmail('ops@localhost'), false);
    assert.equal(isEmail('a b@x.id'), false);
    assert.equal(isEmail('x@y.id\r\nBcc: evil@z.id'), false);
  });
});

describe('message content', () => {
  const m: MessageInput = {
    stage: 'raised', severity: 'critical', kind: 'charge_point.offline',
    message: 'Kuningan DC (CP-1) has been offline for 16 minutes.\nDrivers cannot start charging there.',
    siteName: 'Kuningan Lobby', raisedAt: at('02:30'), consoleUrl: 'https://csms.example.co.id', timeZone: TZ, orgName: 'Nusantara Charge',
  };
  test('WhatsApp: three template parameters, no new lines, time in WIB', () => {
    const p = renderWhatsApp(m);
    assert.equal(p.length, 3);
    assert.equal(p[0], 'CRITICAL');
    assert.match(p[1]!, /^Charger offline at Kuningan Lobby: Kuningan DC \(CP-1\) has been offline/);
    assert.ok(!/[\n\r\t]/.test(p.join('')) && !/ {2,}/.test(p.join('')));
    assert.match(p[1]!, /https:\/\/csms\.example\.co\.id\/#\/dashboard$/);
    assert.equal(p[2], '27 Sep 2026 02:30 WIB');
  });
  test('WhatsApp parameters are length-limited', () => {
    assert.equal(waParam('x'.repeat(5000)).length, 900);
    assert.equal(waParam('   '), '-');
  });
  test('resolved and escalated wording', () => {
    const r = renderWhatsApp({ ...m, stage: 'resolved', resolvedAt: at('03:05') });
    assert.equal(r[0], 'RESOLVED');
    assert.match(r[1]!, /\(open 35 min\)/);
    assert.equal(renderWhatsApp({ ...m, stage: 'escalation' })[0], 'ESCALATED CRITICAL');
  });
  test('e-mail: subject, escaped HTML, plain-text alternative', () => {
    const e = renderEmail({ ...m, message: 'Charger <script>alert(1)</script> offline' });
    assert.equal(e.subject, '[CRITICAL] Charger offline — Kuningan Lobby');
    assert.ok(!e.html.includes('<script>') && e.html.includes('&lt;script&gt;'));
    assert.match(e.text, /Site: Kuningan Lobby/);
    assert.match(e.text, /Raised: 27 Sep 2026 02:30 WIB/);
    assert.match(e.text, /Acknowledge or resolve it in the PlugSure console: https:\/\/csms\.example\.co\.id\/#\/dashboard/);
  });
  test('e-mail subject cannot carry header injection', () => {
    const e = renderEmail({ ...m, siteName: 'Lobby\r\nBcc: x@y.id' });
    assert.ok(!/[\r\n]/.test(e.subject));
  });
});

describe('channel settings validation', () => {
  test('e-mail', () => {
    assert.equal(checkChannelConfig('email', { host: 'smtp.gmail.com', port: 587, security: 'starttls', fromAddress: 'alerts@x.co.id' }), null);
    assert.match(checkChannelConfig('email', { host: 'smtp.gmail.com', port: 587, security: 'starttls', fromAddress: 'nope' })!, /sender/);
    assert.match(checkChannelConfig('email', { host: 'smtp.x.id', port: 99999, security: 'tls', fromAddress: 'a@x.id' })!, /port/);
  });
  test('WhatsApp', () => {
    const ok = { apiBase: 'https://graph.facebook.com/v21.0', phoneNumberId: '109876543210', templateName: 'plugsure_alert', templateLang: 'id' };
    assert.equal(checkChannelConfig('whatsapp', ok), null);
    assert.match(checkChannelConfig('whatsapp', { ...ok, templateName: 'Bad Name' })!, /Template/);
    assert.match(checkChannelConfig('whatsapp', { ...ok, phoneNumberId: '+62812' })!, /phone number ID/);
    assert.match(checkChannelConfig('whatsapp', { ...ok, apiBase: 'ftp://x' })!, /http/);
  });
});

test('secrets are compared in constant time, whatever their length', async () => {
  const { sameSecret } = await import('./alert-routing.js');
  assert.equal(sameSecret('v3rify-token-abc', 'v3rify-token-abc'), true);
  assert.equal(sameSecret('v3rify-token-abd', 'v3rify-token-abc'), false);
  assert.equal(sameSecret('short', 'v3rify-token-abc'), false, 'a different length is a plain false, not an exception');
  assert.equal(sameSecret('', 'v3rify-token-abc'), false);
});
