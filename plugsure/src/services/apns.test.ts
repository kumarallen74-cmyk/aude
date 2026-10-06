import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Http2Server } from 'node:http2';
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { providerToken, p8Problem, outcomeOf, apnsPayload, sendToDevice, checkCredentials, closeApns, forgetProviderToken, forBuild } from './apns.js';

const key = () => {
  const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { p8: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, pub: k.publicKey };
};
const creds = (p8: string) => ({ teamId: 'TEAM123456', keyId: 'KEY1234567', p8, topic: 'id.nusacharge.app' });

/** A stand-in for APNs: checks the JWT with the right public key and answers per device token. */
function fakeApns(pub: KeyObject, tokens: Record<string, number | [number, string]>) {
  const seen: Array<{ path: string; headers: Record<string, unknown>; body: any }> = [];
  const server: Http2Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const jwt = String(req.headers.authorization ?? '').replace(/^bearer /, '');
      const [h, p, s] = jwt.split('.');
      const ok = !!s && verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
      seen.push({ path: req.headers[':path'] as string, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null });
      const send = (status: number, reason?: string) => { res.writeHead(status, { 'apns-id': 'abc-123' }); res.end(reason ? JSON.stringify({ reason }) : ''); };
      if (!ok) return send(403, 'InvalidProviderToken');
      const token = String(req.headers[':path']).split('/').pop()!;
      const a = tokens[token];
      if (a === undefined) return send(400, 'BadDeviceToken');
      if (Array.isArray(a)) return send(a[0], a[1]);
      send(a);
    });
  });
  return { server, seen, listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port))) };
}

after(() => closeApns());

test('provider token: ES256, kid and iss, verifiable with the key; reused for 50 minutes, then renewed', () => {
  const k = key();
  const c = creds(k.p8);
  const t0 = Date.now();
  const jwt = providerToken(c, t0);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h!, 'base64url').toString()), { alg: 'ES256', kid: 'KEY1234567' });
  assert.equal(JSON.parse(Buffer.from(p!, 'base64url').toString()).iss, 'TEAM123456');
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: k.pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url')));
  assert.equal(providerToken(c, t0 + 49 * 60_000), jwt, 'the same token for 49 minutes');
  assert.notEqual(providerToken(c, t0 + 51 * 60_000), jwt, 'a new one after 50');
  forgetProviderToken(c.teamId, c.keyId);
});

test('p8 keys: an EC P-256 PKCS#8 key is accepted; anything else is explained', () => {
  assert.equal(p8Problem(key().p8), null);
  assert.match(p8Problem('hello')!, /whole \.p8 file/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  assert.match(p8Problem(rsa)!, /not an APNs key/);
});

test('outcomes and payload: gone tokens are dropped, refused keys are the operator’s, overload is retried', () => {
  const r = (status: number | null, reason: string | null) => ({ status, reason, apnsId: null, env: 'production' as const });
  assert.equal(outcomeOf(r(200, null)), 'sent');
  assert.equal(outcomeOf(r(410, 'Unregistered')), 'gone');
  assert.equal(outcomeOf(r(400, 'BadDeviceToken')), 'gone');
  assert.equal(outcomeOf(r(400, 'DeviceTokenNotForTopic')), 'gone');
  assert.equal(outcomeOf(r(403, 'InvalidProviderToken')), 'credentials');
  assert.equal(outcomeOf(r(429, 'TooManyRequests')), 'retry');
  assert.equal(outcomeOf(r(503, 'ServiceUnavailable')), 'retry');
  assert.equal(outcomeOf(r(null, 'timeout')), 'retry');
  assert.equal(outcomeOf(r(400, 'PayloadTooLarge')), 'failed');
  assert.deepEqual(apnsPayload({ title: 'Pengisian selesai', body: '12 kWh', url: '/app/#s/1', collapseId: 's-1' }),
    { aps: { alert: { title: 'Pengisian selesai', body: '12 kWh' }, sound: 'default', 'thread-id': 's-1' }, url: '/app/#s/1' });
});

test('rich notifications: subtitle, badge, action category, time-sensitive, a picture for the service extension; a badge-only update shows nothing', () => {
  const p = apnsPayload({
    title: 'Pengisian selesai', subtitle: 'Hub Tol KM 57', body: '12,5 kWh terisi', badge: 2, category: 'PS_RECEIPT',
    interruptionLevel: 'time-sensitive', relevance: 1, imageUrl: 'https://app.example.id/d/n/charge/x.png', url: '/app/#s/1',
    data: { actions: { receipt: '/app/#r/1' } }, collapseId: 's-1',
  }) as any;
  assert.deepEqual(p.aps.alert, { title: 'Pengisian selesai', subtitle: 'Hub Tol KM 57', body: '12,5 kWh terisi' });
  assert.equal(p.aps.badge, 2);
  assert.equal(p.aps.category, 'PS_RECEIPT');
  assert.equal(p.aps['interruption-level'], 'time-sensitive');
  assert.equal(p.aps['relevance-score'], 1);
  assert.equal(p.aps['mutable-content'], 1, 'the service extension runs only with mutable-content');
  assert.equal(p.image, 'https://app.example.id/d/n/charge/x.png');
  assert.deepEqual(p.actions, { receipt: '/app/#r/1' });
  assert.deepEqual(apnsPayload({ title: '', body: '', badgeOnly: true, badge: 0 }), { aps: { badge: 0 } });
  assert.equal((apnsPayload({ title: 't', body: 'b', badge: 250 }) as any).aps.badge, 99, 'capped');
});

test('sending: headers and body as Apple wants them; an Xcode (development) token found on the second server; a key check that notifies nobody', async () => {
  const k = key();
  const good = 'a'.repeat(64), devOnly = 'b'.repeat(64);
  const prod = fakeApns(k.pub, { [good]: 200 });
  const dev = fakeApns(k.pub, { [devOnly]: 200 });
  process.env.APNS_URL_PRODUCTION = `http://127.0.0.1:${await prod.listen()}`;
  process.env.APNS_URL_DEVELOPMENT = `http://127.0.0.1:${await dev.listen()}`;
  try {
    const c = creds(k.p8);
    const r = await sendToDevice(good, null, c, { title: 'Pengisian dimulai', body: 'Hub A', url: '/app/#s/9', collapseId: 's-9', ttlS: 600, priority: 10 });
    assert.deepEqual([r.status, r.env, r.apnsId], [200, 'production', 'abc-123']);
    const req = prod.seen[0]!;
    assert.equal(req.path, `/3/device/${good}`);
    assert.equal(req.headers['apns-topic'], 'id.nusacharge.app');
    assert.equal(req.headers['apns-push-type'], 'alert');
    assert.equal(req.headers['apns-collapse-id'], 's-9');
    assert.equal(req.headers['apns-priority'], '10');
    assert.equal(req.body.aps.alert.title, 'Pengisian dimulai');
    assert.equal(req.body.url, '/app/#s/9');

    const d = await sendToDevice(devOnly, null, c, { title: 't', body: 'b' });
    assert.deepEqual([d.status, d.env], [200, 'development'], 'production said BadDeviceToken, development took it');
    const known = await sendToDevice(devOnly, 'development', c, { title: 't', body: 'b' });
    assert.equal(known.env, 'development');
    assert.equal(prod.seen.filter((s) => s.path.endsWith(devOnly)).length, 1, 'a known environment is not guessed again');

    assert.deepEqual((await checkCredentials(c)).ok, true);
    const wrong = await checkCredentials(creds(key().p8));
    assert.equal(wrong.ok, false);
    assert.match(wrong.detail, /refused the key/);
  } finally {
    delete process.env.APNS_URL_PRODUCTION;
    delete process.env.APNS_URL_DEVELOPMENT;
    closeApns();
    prod.server.close();
    dev.server.close();
  }
});

test('a preview / development build (v1.9.1): its own topic for alerts and Live Activities; a refused build topic is not the brand\'s key', async () => {
  const k = key();
  const tok = 'c'.repeat(64);
  const prod = fakeApns(k.pub, { [tok]: 200 });
  process.env.APNS_URL_PRODUCTION = `http://127.0.0.1:${await prod.listen()}`;
  try {
    const c = creds(k.p8);
    assert.equal(forBuild(c, null), c);
    assert.equal(forBuild(c, c.topic), c);
    const dev = forBuild(c, 'id.nusacharge.app.dev');
    assert.deepEqual({ ...dev, p8: '' }, { ...c, p8: '', topic: 'id.nusacharge.app.dev' });
    await sendToDevice(tok, 'production', dev, { title: 't', body: 'b' });
    await sendToDevice(tok, 'production', dev, { title: '', body: '', liveActivity: { aps: { event: 'update' } } });
    assert.deepEqual(prod.seen.map((x) => x.headers['apns-topic']), ['id.nusacharge.app.dev', 'id.nusacharge.app.dev.push-type.liveactivity']);
    const r = (reason: string) => ({ status: 400, reason, apnsId: null, env: 'production' as const });
    assert.equal(outcomeOf(r('TopicDisallowed')), 'credentials');
    assert.equal(outcomeOf(r('TopicDisallowed'), { buildTopic: true }), 'failed');
    assert.equal(outcomeOf(r('DeviceTokenNotForTopic'), { buildTopic: true }), 'gone');
  } finally {
    delete process.env.APNS_URL_PRODUCTION;
    closeApns();
    prod.server.close();
  }
});
