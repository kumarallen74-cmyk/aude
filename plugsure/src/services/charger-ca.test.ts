import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { buildCsr, name } from '../pnc/der.js';
import { caInfo, chargerCa, checkStationCsr, issueAtOnboarding, CertificateError } from './charger-ca.js';

/**
 * PlugSure's charging-station CA (database-backed: the CA lives in platform_ca).
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5432/plugsure_audit_fix npm test
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[charger-ca.test] SKIPPING charger CA suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
// One file at a time against the audit chain (src/db/test-lock.ts).
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'charger-ca-test';
const ID = 'CA-TEST-UNIT-01';
let cpId = '';
let siteId = '';
const actor = { type: 'system' as const };

if (DB_OK) {
  before(async () => {
    const org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ('PT Charger CA Test', $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    siteId = (await one<{ id: string }>(`INSERT INTO site (org_id, name, pbjt_rate_bps) VALUES ($1, 'CA Test Hub', 1000) RETURNING id`, [org]))!.id;
    await query(`DELETE FROM pnc_certificate WHERE charge_point_id IN (SELECT id FROM charge_point WHERE ocpp_identity = $1)`, [ID]);
    await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [ID]);
    cpId = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, status) VALUES ($1, $2, 'pending_adoption') RETURNING id`, [siteId, ID]))!.id;
  });
  after(async () => {
    await query(`DELETE FROM pnc_certificate WHERE charge_point_id = $1`, [cpId]);
    await query(`DELETE FROM charge_point WHERE id = $1`, [cpId]);
    await query(`DELETE FROM site WHERE id = $1`, [siteId]);
    await pool.end();
  });
}

const CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';

dbDescribe('charging-station CA', () => {
  test('the CA is a CA, and the same one on every call', async () => {
    const a = await chargerCa();
    const x = new X509Certificate(a.pem);
    assert.ok(x.ca && x.verify(x.publicKey), 'self-signed CA');
    assert.equal((await caInfo()).fingerprint, x.fingerprint256.replace(/:/g, '').toLowerCase());
    assert.match((await caInfo()).proxy.caddy, /trusted_ca_cert_file/);
  });

  test('a generated ECDSA key: certificate for this charger, client authentication, bound to it', async () => {
    const r = await issueAtOnboarding(cpId, { keyType: 'ec', days: 365 }, actor);
    const x = new X509Certificate(r.certificatePem);
    const ca = new X509Certificate((await chargerCa()).pem);
    assert.ok(x.checkIssued(ca) && x.verify(ca.publicKey));
    assert.match(x.subject, new RegExp(`CN=${ID}`));
    assert.match(x.subject, /O=PT Charger CA Test/);
    assert.ok(!x.ca);
    assert.deepEqual(x.keyUsage, [CLIENT_AUTH], 'extended key usage: TLS client');
    // The private key matches the certificate.
    const pub = createPublicKey(createPrivateKey(r.privateKeyPem!)).export({ type: 'spki', format: 'der' });
    assert.ok(pub.equals(x.publicKey.export({ type: 'spki', format: 'der' })));
    assert.ok(Math.abs(new Date(x.validTo).getTime() - Date.now() - 365 * 86_400_000) < 86_400_000);
    const cp = await one<any>(`SELECT client_cert_fingerprint, client_cert_serial, client_cert_source FROM charge_point WHERE id = $1`, [cpId]);
    assert.equal(cp.client_cert_fingerprint, x.fingerprint256.replace(/:/g, '').toLowerCase());
    assert.equal(cp.client_cert_source, 'plugsure_ca');
    assert.equal(cp.client_cert_serial, r.serial);
    assert.equal(r.chainPem, r.certificatePem + r.caPem);
  });

  test('RSA 2048 for chargers that need it', async () => {
    const r = await issueAtOnboarding(cpId, { keyType: 'rsa' }, actor);
    assert.equal(r.keyType, 'RSA 2048');
    assert.equal(new X509Certificate(r.certificatePem).publicKey.asymmetricKeyType, 'rsa');
  });

  test('the charger\'s own CSR: signed, no key returned; a CSR for another identity or a weak key is refused', async () => {
    const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const csr = buildCsr(name([['C', 'ID'], ['O', 'Vendor'], ['CN', ID]]), k);
    const r = await issueAtOnboarding(cpId, { csr }, actor);
    assert.equal(r.privateKeyPem, null);
    const x = new X509Certificate(r.certificatePem);
    assert.ok(x.publicKey.export({ type: 'spki', format: 'der' }).equals(k.publicKey.export({ type: 'spki', format: 'der' })));
    assert.equal((await one<any>(`SELECT client_cert_source FROM charge_point WHERE id = $1`, [cpId])).client_cert_source, 'plugsure_ca_csr');
    assert.throws(() => checkStationCsr(buildCsr(name([['CN', 'SOMEONE-ELSE']]), k), ID), (e: unknown) => e instanceof CertificateError && /not for/.test((e as Error).message));
    const weak = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    assert.throws(() => checkStationCsr(buildCsr(name([['CN', ID]]), weak), ID), /P-256 or P-384/);
    await assert.rejects(issueAtOnboarding(cpId, { days: 5 }, actor), /30–3650/);
  });
});
