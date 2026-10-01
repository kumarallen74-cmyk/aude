import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Socket, AddressInfo } from 'node:net';
import { config } from '../config.js';
import { pool, one, query } from '../db/pool.js';
import { post, deliverDue, DELIVERY_DEADLINE_MS } from './webhooks.js';
import { ocpiCall } from '../ocpi/client.js';

/**
 * One slow receiver must not stall everyone's deliveries: webhook and OCPI
 * calls have a hard TOTAL deadline (the socket idle timeout is reset by every
 * byte, so a receiver trickling its answer used to hold a call for days), and
 * a pass settles each attempt on its own.
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbTest = DB_OK ? test : test.skip;
const SLUG = 'outbound-deadline-test';

const servers: http.Server[] = [];
const sockets = new Set<Socket>();
after(async () => {
  for (const s of sockets) s.destroy();
  for (const s of servers) s.close();
  if (DB_OK) {
    const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
    if (org) await query(`DELETE FROM webhook_endpoint WHERE org_id = $1`, [org.id]);
  }
  await pool.end();
});

async function listen(handler: http.RequestListener): Promise<number> {
  const srv = http.createServer(handler);
  servers.push(srv);
  srv.on('connection', (s: Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return (srv.address() as AddressInfo).port;
}

/** Answers 200 at once, then one byte a second and never finishes. */
const trickle = (): http.RequestListener => (req, res) => {
  req.resume();
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write('{');
  const t = setInterval(() => { if (!res.destroyed) res.write(' '); }, 1000);
  res.on('close', () => clearInterval(t));
};

describe('webhook delivery deadline', () => {
  test('a receiver trickling its answer is cut off at the deadline', { timeout: 10_000 }, async () => {
    const port = await listen(trickle());
    const t0 = Date.now();
    const r = await post(`http://127.0.0.1:${port}/hook`, '{}', {}, 1500);
    const ms = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.match(r.error!, /no complete answer within 1\.5s/);
    assert.ok(ms >= 1400 && ms < 3000, `cut after ${ms} ms`);
  });

  test('the default deadline is a total limit, not the 10 s idle timeout', () => {
    assert.ok(DELIVERY_DEADLINE_MS > 0 && DELIVERY_DEADLINE_MS <= 30_000);
  });

  dbTest('one slow endpoint does not delay a fast one, and the pass ends at the deadline', { timeout: DELIVERY_DEADLINE_MS + 15_000 }, async () => {
    const slowPort = await listen(trickle());
    let fastAt = 0;
    const fastPort = await listen((req, res) => { req.resume(); fastAt = Date.now(); res.end('ok'); });
    const orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('Outbound Deadline Test', $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    await query(`DELETE FROM webhook_endpoint WHERE org_id = $1`, [orgId]);
    const { createEndpoint, enqueue } = await import('./webhooks.js');
    const slow = await createEndpoint(orgId, { url: `http://127.0.0.1:${slowPort}/slow`, events: ['*'] });
    const fast = await createEndpoint(orgId, { url: `http://127.0.0.1:${fastPort}/fast`, events: ['*'] });
    assert.ok('endpoint' in slow && 'endpoint' in fast);
    assert.equal(await enqueue(orgId, 'alert.raised', { kind: 'test' }), 2);

    const t0 = Date.now();
    const pass = deliverDue();
    // The fast receiver is served (and its row recorded) while the slow one is still trickling.
    let fastRow: { state: string } | null = null;
    while (Date.now() - t0 < 5_000) {
      fastRow = await one<{ state: string }>(`SELECT d.state FROM webhook_delivery d WHERE d.endpoint_id = $1`, [(fast as any).endpoint.id]);
      if (fastRow?.state === 'delivered') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(fastRow?.state, 'delivered');
    assert.ok(fastAt - t0 < 2_000, `fast receiver reached after ${fastAt - t0} ms`);

    await pass;
    const ms = Date.now() - t0;
    assert.ok(ms < DELIVERY_DEADLINE_MS + 5_000, `pass took ${ms} ms`);
    const slowRow = await one<{ state: string; last_error: string }>(`SELECT state, last_error FROM webhook_delivery WHERE endpoint_id = $1`, [(slow as any).endpoint.id]);
    assert.equal(slowRow?.state, 'pending', 'retried later');
    assert.match(slowRow!.last_error, /no complete answer within/);
  });
});

describe('OCPI call deadline', () => {
  test('timeoutMs is a total deadline (real-time authorisation, outbox pushes)', { timeout: 10_000 }, async () => {
    const port = await listen(trickle());
    const t0 = Date.now();
    const r = await ocpiCall({
      orgId: '00000000-0000-4000-8000-000000000000', partnerId: null, method: 'POST',
      url: `http://127.0.0.1:${port}/ocpi/2.2.1/tokens/ABC/authorize`, token: 'x', body: {}, timeoutMs: 1500,
    });
    const ms = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.match(r.error!, /no complete answer within 1\.5 s/);
    assert.ok(ms >= 1400 && ms < 3000, `cut after ${ms} ms`);
  });
});
