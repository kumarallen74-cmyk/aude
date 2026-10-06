import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, verify } from 'node:crypto';
import { parseServiceAccount, tokenUriFor, GOOGLE_TOKEN_URI, assertionFor, fcmPayload, outcomeOfFcm, sendFcm, checkFcmCredentials, FCM_SCOPE, type FcmCredentials } from './fcm.js';
import { fcmMessageOf, fcmChannelOf, fcmLiveStartOf } from '../driver/notify.js';

/**
 * FCM HTTP v1 (services/fcm.ts): the service account file, the OAuth assertion Google verifies, the message body,
 * what each answer means, and a send against a local stand-in for Google's token endpoint and FCM.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let server: Server;
let base = '';
const seen: Array<{ path: string; auth: string | undefined; body: string }> = [];
let sendStatus = 200;
let sendBody: unknown = { name: 'projects/plugsure-test/messages/0:1' };
let tokenStatus = 200;

const sa = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'service_account', project_id: 'plugsure-test', private_key_id: 'kid123', private_key: pem,
  client_email: 'fcm@plugsure-test.iam.gserviceaccount.com', token_uri: `${base}/token`, ...over,
});

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ path: req.url ?? '', auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/token') {
        res.statusCode = tokenStatus;
        res.end(JSON.stringify(tokenStatus === 200 ? { access_token: 'ya29.test', expires_in: 3599, token_type: 'Bearer' } : { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }));
        return;
      }
      res.statusCode = sendStatus;
      res.end(JSON.stringify(sendBody));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.FCM_URL = base;
});
after(() => { server.close(); delete process.env.FCM_URL; });

describe('FCM HTTP v1', () => {
  test('a service account file is read, and a wrong one says what is wrong', () => {
    const ok = parseServiceAccount(sa());
    assert.ok(ok.ok);
    assert.equal(ok.ok && ok.creds.projectId, 'plugsure-test');
    assert.match((parseServiceAccount('{') as { error: string }).error, /whole service account JSON/);
    assert.match((parseServiceAccount(sa({ type: 'authorized_user' })) as { error: string }).error, /service_account/);
    assert.match((parseServiceAccount(sa({ private_key: 'nope' })) as { error: string }).error, /private_key/);
    // An EC key is not what Google issues for service accounts.
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    assert.match((parseServiceAccount(sa({ private_key: ec })) as { error: string }).error, /RSA/);
    // Escaped newlines (as pasted from some tools) are accepted.
    assert.ok(parseServiceAccount(sa({ private_key: pem.replace(/\n/g, '\\n') })).ok);
  });

  test('the assertion is an RS256 JWT for the messaging scope, signed with the account key', () => {
    const c = (parseServiceAccount(sa()) as { creds: FcmCredentials }).creds;
    const jwt = assertionFor(c, Date.UTC(2026, 9, 4) );
    const [h, p, sig] = jwt.split('.');
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    assert.deepEqual(header, { alg: 'RS256', typ: 'JWT', kid: 'kid123' });
    assert.equal(claims.iss, c.clientEmail);
    assert.equal(claims.scope, FCM_SCOPE);
    assert.equal(claims.aud, c.tokenUri);
    assert.equal(claims.exp - claims.iat, 3600);
    assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig!, 'base64url')));
  });

  test('the message body: notification, string data, Android priority, TTL, channel, collapse key', () => {
    const b = fcmPayload({ token: 'T', notification: { title: 'Charging finished', body: '12.5 kWh', image: 'https://x/y.png' },
      data: { type: 'session.ended', n: 5 as unknown as string }, priority: 'high', ttlS: 86_400, channelId: 'charging', tag: 's-1', collapseKey: 'k' }) as any;
    assert.equal(b.message.token, 'T');
    assert.deepEqual(b.message.notification, { title: 'Charging finished', body: '12.5 kWh', image: 'https://x/y.png' });
    assert.deepEqual(b.message.data, { type: 'session.ended', n: '5' });
    assert.deepEqual(b.message.android, { priority: 'HIGH', ttl: '86400s', collapse_key: 'k', notification: { channel_id: 'charging', tag: 's-1', image: 'https://x/y.png' } });
    assert.equal(fcmPayload({ token: 'T', priority: 'normal', ttlS: 0 }, true).validate_only, true);
    // Data-only: no notification block at all (the app builds its own).
    assert.equal((fcmPayload({ token: 'T', data: { a: '1' }, priority: 'normal', ttlS: 120 }) as any).message.notification, undefined);
  });

  test('outcomes: sent, token gone, credentials refused, retry, give up', () => {
    assert.equal(outcomeOfFcm({ status: 200, errorCode: null, detail: null }), 'sent');
    assert.equal(outcomeOfFcm({ status: 404, errorCode: 'UNREGISTERED', detail: null }), 'gone');
    assert.equal(outcomeOfFcm({ status: 403, errorCode: 'SENDER_ID_MISMATCH', detail: null }), 'gone');
    assert.equal(outcomeOfFcm({ status: 400, errorCode: 'INVALID_ARGUMENT', detail: 'The registration token is not a valid FCM registration token' }), 'gone');
    assert.equal(outcomeOfFcm({ status: 400, errorCode: 'INVALID_ARGUMENT', detail: 'Invalid value at message.data' }), 'failed');
    assert.equal(outcomeOfFcm({ status: 401, errorCode: 'THIRD_PARTY_AUTH_ERROR', detail: null }), 'credentials');
    assert.equal(outcomeOfFcm({ status: 403, errorCode: 'PERMISSION_DENIED', detail: null }), 'credentials');
    assert.equal(outcomeOfFcm({ status: 429, errorCode: 'QUOTA_EXCEEDED', detail: null }), 'retry');
    assert.equal(outcomeOfFcm({ status: 503, errorCode: 'UNAVAILABLE', detail: null }), 'retry');
    assert.equal(outcomeOfFcm({ status: null, errorCode: 'UNAVAILABLE', detail: 'ECONNREFUSED' }), 'retry');
  });

  test('a send: the token is fetched once and reused, the message goes to the project', async () => {
    const c = (parseServiceAccount(sa({ client_email: 'send@plugsure-test.iam.gserviceaccount.com' })) as { creds: FcmCredentials }).creds;
    seen.length = 0;
    const r1 = await sendFcm(c, { token: 'dev-token-1', notification: { title: 'a', body: 'b' }, priority: 'high', ttlS: 60 });
    const r2 = await sendFcm(c, { token: 'dev-token-2', data: { type: 'x' }, priority: 'normal', ttlS: 60 });
    assert.equal(r1.status, 200);
    assert.equal(r2.name, 'projects/plugsure-test/messages/0:1');
    assert.equal(seen.filter((s) => s.path === '/token').length, 1, 'one token exchange for two sends');
    const tokenReq = new URLSearchParams(seen.find((s) => s.path === '/token')!.body);
    assert.equal(tokenReq.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const sends = seen.filter((s) => s.path === '/v1/projects/plugsure-test/messages:send');
    assert.equal(sends.length, 2);
    assert.equal(sends[0]!.auth, 'Bearer ya29.test');
    assert.equal(JSON.parse(sends[1]!.body).message.token, 'dev-token-2');
  });

  test('errors: FCM\'s errorCode is read; a refused token exchange is a credentials problem', async () => {
    const c = (parseServiceAccount(sa({ client_email: 'err@plugsure-test.iam.gserviceaccount.com' })) as { creds: FcmCredentials }).creds;
    sendStatus = 404;
    sendBody = { error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } };
    const r = await sendFcm(c, { token: 'gone', priority: 'normal', ttlS: 1 });
    assert.equal(r.errorCode, 'UNREGISTERED');
    assert.equal(outcomeOfFcm(r), 'gone');
    tokenStatus = 400;
    const c2 = (parseServiceAccount(sa({ client_email: 'bad@plugsure-test.iam.gserviceaccount.com' })) as { creds: FcmCredentials }).creds;
    const r2 = await sendFcm(c2, { token: 'x', priority: 'normal', ttlS: 1 });
    assert.equal(outcomeOfFcm(r2), 'credentials');
    const chk = await checkFcmCredentials(c2);
    assert.equal(chk.ok, false);
    assert.match(chk.detail, /refused/);
    tokenStatus = 200;
    // The check: INVALID_ARGUMENT for the made-up token means the account may send.
    sendStatus = 400;
    sendBody = { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token' } };
    assert.equal((await checkFcmCredentials(c)).ok, true);
    sendStatus = 200; sendBody = { name: 'projects/plugsure-test/messages/0:1' };
  });

  test('queued notifications become Android notifications on the right channel, with the app\'s routing in data', () => {
    assert.equal(fcmChannelOf('session.started'), 'charging');
    assert.equal(fcmChannelOf('session.ended'), 'charging');
    assert.equal(fcmChannelOf('session.unpaid'), 'payments');
    assert.equal(fcmChannelOf('roaming.cdr'), 'payments');
    assert.equal(fcmChannelOf('queue.offer'), 'reservations');
    assert.equal(fcmChannelOf('reservation.reminder'), 'reservations');
    const id = '11111111-2222-4333-8444-555555555555';
    const m = fcmMessageOf('session.ended', { title: 'Charging finished', body: '12 kWh at Mall', site: 'Mall', detail: '12 kWh charged', url: `/app/#s/${id}`, tag: 's-x', category: 'PS_RECEIPT', actions: { receipt: `/app/#r/${id}` } },
      'tok', 86_400, false, 'https://go.plugsure.test/d/n/charge/x.png');
    assert.equal(m.notification.body, 'Mall · 12 kWh charged');
    assert.equal(m.notification.image, 'https://go.plugsure.test/d/n/charge/x.png');
    assert.equal(m.data.ref, id);
    assert.equal(m.data.type, 'session.ended');
    assert.equal(JSON.parse(m.data.actions!).receipt, `/app/#r/${id}`);
    assert.equal(m.priority, 'high');
    assert.equal(m.channelId, 'charging');
    assert.equal(fcmMessageOf('cdr.created', { title: 't', body: 'b', url: '/app/#history' }, 'tok', 86_400, false, null).priority, 'normal');
  });
});

describe('Android live session start (v1.9.1)', () => {
  test('data-only: no notification block, high priority, the keys the app reads, its own collapse key', () => {
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
    const m = fcmLiveStartOf({ dataOnly: true, ref: id, url: `/app/#s/${id}`, site: 'Mall', connector: 'AC 22 kW' }, 'tok', 600);
    const body = fcmPayload(m) as any;
    assert.equal(body.message.notification, undefined);
    assert.equal(body.message.android.notification, undefined);
    assert.deepEqual(body.message.data, { type: 'session.started', ref: id, url: `/app/#s/${id}`, path: `/app/#s/${id}`, site: 'Mall', connector: 'AC 22 kW' });
    assert.equal(body.message.android.priority, 'HIGH');
    assert.equal(body.message.android.collapse_key, `ls-start-${id}`);
    assert.equal(body.message.android.ttl, '600s');
  });
});

describe('FCM token endpoint pinned in production', () => {
  test('production: always Google\'s token endpoint, whatever the file says; a bench may use a local fake', () => {
    assert.equal(tokenUriFor('https://evil.example/token', 'production'), GOOGLE_TOKEN_URI);
    assert.equal(tokenUriFor('http://127.0.0.1:9298/token', 'production'), GOOGLE_TOKEN_URI);
    assert.equal(tokenUriFor('http://127.0.0.1:9298/token', 'test'), 'http://127.0.0.1:9298/token');
    assert.equal(tokenUriFor(GOOGLE_TOKEN_URI, 'staging'), GOOGLE_TOKEN_URI);
  });
});
