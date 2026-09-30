import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { onDuty, zonedInstant, type Rota, type Override } from './on-call.js';
import { renderSms } from './alert-format.js';
import { checkChannelConfig, metaSignatureOk } from './notify-transports.js';

const TZ = 'Asia/Jakarta';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const rota: Rota = { id: 'r1', name: 'Teknisi', member_ids: [A, B, C], shift: 'weekly', handover_time: '08:00:00', starts_on: '2026-09-07' };
// Monday 2026-09-07 08:00 WIB = 01:00 UTC
const wib = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+07:00`);

describe('zonedInstant', () => {
  test('local time in Jakarta and New York (DST)', () => {
    assert.equal(zonedInstant('2026-09-07', '08:00', TZ).toISOString(), '2026-09-07T01:00:00.000Z');
    assert.equal(zonedInstant('2026-07-01', '08:00', 'America/New_York').toISOString(), '2026-07-01T12:00:00.000Z');
    assert.equal(zonedInstant('2026-12-01', '08:00', 'America/New_York').toISOString(), '2026-12-01T13:00:00.000Z');
  });
});

describe('onDuty — rotation', () => {
  test('before the first shift nobody is on duty; the first member is next', () => {
    const d = onDuty(rota, [], wib('2026-09-07', '07:59'), TZ);
    assert.equal(d.contactId, null);
    assert.equal(d.nextContactId, A);
    assert.equal(d.shiftEnds?.toISOString(), '2026-09-07T01:00:00.000Z');
  });
  test('weekly shifts hand over at the local time and wrap round', () => {
    assert.equal(onDuty(rota, [], wib('2026-09-07', '08:00'), TZ).contactId, A);
    assert.equal(onDuty(rota, [], wib('2026-09-14', '07:59'), TZ).contactId, A);
    const w2 = onDuty(rota, [], wib('2026-09-14', '08:00'), TZ);
    assert.equal(w2.contactId, B);
    assert.equal(w2.nextContactId, C);
    assert.equal(w2.shiftEnds?.toISOString(), wib('2026-09-21', '08:00').toISOString());
    assert.equal(onDuty(rota, [], wib('2026-09-21', '12:00'), TZ).contactId, C);
    assert.equal(onDuty(rota, [], wib('2026-09-28', '12:00'), TZ).contactId, A);
  });
  test('daily shifts', () => {
    const daily = { ...rota, shift: 'daily' as const };
    assert.equal(onDuty(daily, [], wib('2026-09-08', '07:00'), TZ).contactId, A);
    assert.equal(onDuty(daily, [], wib('2026-09-08', '08:00'), TZ).contactId, B);
    assert.equal(onDuty(daily, [], wib('2026-09-10', '09:00'), TZ).contactId, A);
  });
  test('an empty rota has nobody', () => {
    const d = onDuty({ ...rota, member_ids: [] }, [], wib('2026-09-10', '09:00'), TZ);
    assert.deepEqual([d.contactId, d.nextContactId, d.shiftEnds], [null, null, null]);
  });
});

describe('onDuty — overrides', () => {
  const ov = (contact: string, from: Date, to: Date, created: string, rotaId = 'r1'): Override =>
    ({ rota_id: rotaId, contact_id: contact, starts_at: from, ends_at: to, created_at: created });
  test('an override wins while it lasts, then the rotation resumes', () => {
    const o = [ov(C, wib('2026-09-08', '00:00'), wib('2026-09-09', '00:00'), '2026-09-01T00:00:00Z')];
    const d = onDuty(rota, o, wib('2026-09-08', '12:00'), TZ);
    assert.equal(d.contactId, C);
    assert.equal(d.override, true);
    assert.equal(d.shiftEnds?.toISOString(), wib('2026-09-09', '00:00').toISOString());
    assert.equal(d.nextContactId, A);
    assert.equal(onDuty(rota, o, wib('2026-09-09', '00:00'), TZ).contactId, A);
  });
  test('the most recently added override wins; other rotas are ignored', () => {
    const o = [
      ov(B, wib('2026-09-08', '00:00'), wib('2026-09-10', '00:00'), '2026-09-01T00:00:00Z'),
      ov(C, wib('2026-09-08', '00:00'), wib('2026-09-10', '00:00'), '2026-09-02T00:00:00Z'),
      ov(A, wib('2026-09-08', '00:00'), wib('2026-09-10', '00:00'), '2026-09-03T00:00:00Z', 'other'),
    ];
    assert.equal(onDuty(rota, o, wib('2026-09-09', '12:00'), TZ).contactId, C);
  });
  test('an override covers even before the first shift', () => {
    const o = [ov(B, wib('2026-09-01', '00:00'), wib('2026-09-02', '00:00'), '2026-08-30T00:00:00Z')];
    assert.equal(onDuty(rota, o, wib('2026-09-01', '12:00'), TZ).contactId, B);
  });
});

describe('SMS text', () => {
  test('one line, status first, capped at two SMS segments', () => {
    const base = { stage: 'raised' as const, severity: 'critical', kind: 'charge_point.offline', message: 'CP-01 has not been heard from', siteName: 'Grand Indonesia', raisedAt: new Date('2026-09-27T01:00:00Z'), consoleUrl: '', timeZone: TZ };
    const s = renderSms(base);
    assert.match(s, /^PlugSure CRITICAL: /);
    assert.doesNotMatch(s, /\n/);
    const long = renderSms({ ...base, message: 'y '.repeat(400), siteName: 'x'.repeat(200) });
    assert.ok(long.length <= 306);
  });
});

describe('SMS channel settings', () => {
  const sid = 'AC' + '0123456789abcdef'.repeat(2);
  test('provider and credentials checked', () => {
    assert.match(checkChannelConfig('sms', {})!, /provider/);
    assert.match(checkChannelConfig('sms', { provider: 'twilio', accountSid: 'nope' })!, /Account SID/);
    assert.match(checkChannelConfig('sms', { provider: 'twilio', accountSid: sid })!, /sender/);
    assert.equal(checkChannelConfig('sms', { provider: 'twilio', accountSid: sid, from: '+15550100000' }), null);
    assert.equal(checkChannelConfig('sms', { provider: 'twilio', accountSid: sid, messagingServiceSid: 'MG' + 'ab'.repeat(16) }), null);
    assert.match(checkChannelConfig('sms', { provider: 'zenziva' })!, /user key/);
    assert.equal(checkChannelConfig('sms', { provider: 'zenziva', userkey: 'k' }), null);
    assert.match(checkChannelConfig('sms', { provider: 'http', url: 'not a url' })!, /gateway URL/);
    assert.equal(checkChannelConfig('sms', { provider: 'http', url: 'https://sms.example.co.id/send' }), null);
  });
});

describe('Meta webhook signature', () => {
  const body = '{"entry":[{"changes":[{"value":{"statuses":[{"id":"wamid.X","status":"delivered"}]}}]}]}';
  const sig = (secret: string, b = body) => 'sha256=' + createHmac('sha256', secret).update(b).digest('hex');
  test('accepts the right signature only', () => {
    assert.equal(metaSignatureOk(body, sig('app-secret'), 'app-secret'), true);
    assert.equal(metaSignatureOk(body, sig('other'), 'app-secret'), false);
    assert.equal(metaSignatureOk(body + ' ', sig('app-secret'), 'app-secret'), false);
    assert.equal(metaSignatureOk(body, sig('app-secret').replace('sha256=', 'sha1='), 'app-secret'), false);
    assert.equal(metaSignatureOk(body, undefined, 'app-secret'), false);
    assert.equal(metaSignatureOk(body, sig(''), ''), false);
  });
});
