import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * v1.41.1: a finance manager may not read the user list (user:read), but must still be able to name a close
 * step's owner and a card's holder. Close automation and Corporate cards return the organisation's active
 * console users (id and name only) to a caller who may write finance; not to a read-only one.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-people.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const { assignablePeople } = await import('./finance-people.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), B = randomUUID(), C = randomUUID();
let org = '';
let app: FastifyInstance;
let perms = ['payment:read', 'payment:write'];

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`People ${TAG}`, `ppl-${TAG}`]))!.id;
    await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, 'Rina')`, [A, org, `${TAG}-a@people.test`]);
    await query(`INSERT INTO app_user (id, org_id, email, name, status) VALUES ($1, $2, $3, 'Agus', 'disabled')`, [B, org, `${TAG}-b@people.test`]);
    // A driver-style account without an e-mail is not a console user.
    await query(`INSERT INTO app_user (id, org_id, name, phone) VALUES ($1, $2, 'No e-mail', $3)`, [C, org, `+62812${TAG.replace(/\D/g, '0').padEnd(6, '0').slice(0, 6)}`]);
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: A, orgId: org, assignments: [{ permissions: perms, scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    await app?.close();
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

dbDescribe('People a finance user can assign (v1.41.1)', () => {
  test('active console users only, by id and name', async () => {
    assert.deepEqual(await assignablePeople(org), [{ id: A, name: 'Rina' }]);
  });

  test('close automation and cards return them to a finance writer, not to a reader', async () => {
    perms = ['payment:read', 'payment:write'];
    for (const url of ['/v1/finance/close-automation', '/v1/finance/cards']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
      assert.deepEqual(r.json().people, [{ id: A, name: 'Rina' }], url);
    }
    perms = ['payment:read'];
    for (const url of ['/v1/finance/close-automation', '/v1/finance/cards']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
      assert.equal(r.json().people, undefined, `${url}: a reader assigns no one`);
    }
    perms = ['payment:read', 'payment:write'];
  });
});
