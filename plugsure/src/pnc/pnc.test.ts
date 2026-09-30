import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { config } from '../config.js';
import { pool, one, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { bus } from '../services/events.js';
import { renewExpiringCertificates } from './service.js';
import { normaliseEmaid, formatEmaid } from './emaid.js';
import { buildCsr, certInfo, name, readOcspResponse, splitPemChain } from './der.js';
import { issueTestContract, mockCa, ocspFetch, pkiMode, revokeTestContract, signCsr, evCertificate, PkiError } from './pki.js';
import { validateCallDetailed } from '../ocpp/validate.js';

describe('Plug & Charge: eMAID', () => {
  test('separators and case do not matter; the shape does', () => {
    assert.equal(normaliseEmaid('ID-PLS-C12345678-9'), 'IDPLSC123456789');
    assert.equal(normaliseEmaid('id*pls*c12345678'), 'IDPLSC12345678');
    assert.equal(normaliseEmaid('IDPLSC12345678'), 'IDPLSC12345678');
    assert.equal(normaliseEmaid('ID-PLS-C1234'), null, 'contract part too short');
    assert.equal(normaliseEmaid('1D-PLS-C12345678'), null, 'country must be letters');
    assert.equal(normaliseEmaid('RFID-0001'), null);
    assert.equal(normaliseEmaid(undefined), null);
    assert.equal(formatEmaid('IDPLSC123456789'), 'ID-PLS-C12345678-9');
    assert.equal(formatEmaid('IDPLSC12345678'), 'ID-PLS-C12345678');
  });
});

describe('Plug & Charge: OCPP 2.0.1 message schemas', () => {
  const h = { hashAlgorithm: 'SHA256', issuerNameHash: 'ab', issuerKeyHash: 'cd', serialNumber: '01', responderURL: 'http://ocsp.test' };
  test('the four charger messages are known and validated', () => {
    assert.equal(validateCallDetailed('Get15118EVCertificate', { iso15118SchemaVersion: 'urn:iso:15118:2:2013:MsgDef', action: 'Install', exiRequest: 'AAA=' }, 'ocpp2.0.1').failure, null);
    assert.ok(validateCallDetailed('Get15118EVCertificate', { iso15118SchemaVersion: 'x', action: 'Replace', exiRequest: 'A' }, 'ocpp2.0.1').failure, 'action is Install or Update');
    assert.equal(validateCallDetailed('GetCertificateStatus', { ocspRequestData: h }, 'ocpp2.0.1').failure, null);
    assert.ok(validateCallDetailed('GetCertificateStatus', { ocspRequestData: { ...h, responderURL: undefined } }, 'ocpp2.0.1').failure);
    assert.equal(validateCallDetailed('SignCertificate', { csr: 'x', certificateType: 'V2GCertificate' }, 'ocpp2.0.1').failure, null);
    assert.ok(validateCallDetailed('SignCertificate', { csr: 'x', certificateType: 'EVCertificate' }, 'ocpp2.0.1').failure);
    assert.equal(validateCallDetailed('Authorize', { idToken: { idToken: 'IDPLSC12345678', type: 'eMAID' }, iso15118CertificateHashData: [h, h] }, 'ocpp2.0.1').failure, null);
    assert.ok(validateCallDetailed('Authorize', { idToken: { idToken: 'IDPLSC12345678', type: 'eMAID' }, iso15118CertificateHashData: [h, h, h, h, h] }, 'ocpp2.0.1').failure, 'at most four certificates');
  });
});

/** The test PKI keeps its CAs in the database; run against the disposable test database only. */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[pnc.test] SKIPPING test-PKI suites (DATABASE_URL is not plugsure_audit_fix).');
// The test PKI is the default outside production (no Plug & Charge PKI row in the test database).
const dbDescribe = DB_OK && config.env !== 'production' ? describe : describe.skip;
// One file at a time against the audit chain (src/db/test-lock.ts).
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);
if (DB_OK) after(async () => { await pool.end(); });

dbDescribe('Plug & Charge: the test PKI', () => {
  test('signs a charger\'s V2G request into a chain that verifies up to the V2G root', async () => {
    const ca = await mockCa();
    const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const csr = buildCsr(name([['C', 'ID'], ['O', 'PlugSure'], ['CN', 'SECC-UNIT-TEST'], ['DC', 'CPO']]), k);
    const chain = await signCsr(csr, 'V2GCertificate', 'UNIT-TEST');
    const [leafPem, subPem] = splitPemChain(chain);
    const leaf = new X509Certificate(leafPem!), sub = new X509Certificate(subPem!), root = new X509Certificate(ca.v2g_root.pem);
    assert.ok(leaf.checkIssued(sub) && leaf.verify(sub.publicKey));
    assert.ok(sub.checkIssued(root) && sub.verify(root.publicKey));
    assert.ok(leaf.publicKey.export({ type: 'spki', format: 'der' }).equals(k.publicKey.export({ type: 'spki', format: 'der' })), 'the charger\'s own key');
    assert.equal(certInfo(leafPem!).subject, 'C=ID, O=PlugSure, CN=SECC-UNIT-TEST, DC=CPO');
    await assert.rejects(signCsr(csr, 'ChargingStationCertificate', 'UNIT-TEST'), PkiError);
    await assert.rejects(signCsr('not a csr', 'V2GCertificate', 'UNIT-TEST'));
  });

  test('a contract certificate: good, then revoked, by its OCSP responder; signed by the issuer', async () => {
    const c = await issueTestContract('IDPLSU1T2E3S4T');
    const [leafH, subH] = c.hashData;
    assert.equal(leafH!.serialNumber, c.serial);
    const issuerKey = new X509Certificate(splitPemChain(c.chainPem)[1]!).publicKey;
    const good = readOcspResponse(await ocspFetch(leafH!, leafH!.responderURL), leafH!, [issuerKey]);
    assert.equal(good.status, 'good');
    assert.equal(good.signatureValid, true);
    assert.equal(readOcspResponse(await ocspFetch(subH!, subH!.responderURL), subH!).status, 'good', 'the sub-CA too');
    assert.equal(await revokeTestContract(c.serial), true);
    assert.equal(readOcspResponse(await ocspFetch(leafH!, leafH!.responderURL), leafH!, [issuerKey]).status, 'revoked');
    assert.equal(readOcspResponse(await ocspFetch({ ...leafH!, serialNumber: 'ABCDEF' }, leafH!.responderURL), { ...leafH!, serialNumber: 'ABCDEF' }).status, 'unknown');
  });

  test('an OCSP responder URL from a certificate cannot point anywhere', async () => {
    const h = { hashAlgorithm: 'SHA256' as const, issuerNameHash: 'aa', issuerKeyHash: 'bb', serialNumber: '01' };
    await assert.rejects(ocspFetch(h, 'file:///etc/passwd'), /http or https/);
    await assert.rejects(ocspFetch(h, 'http://user:pw@ocsp.test/'), /credentials/);
  });

  test('renewal: a certificate ending within a week raises an alert; an unreachable charger is not asked', async () => {
    const slug = 'pnc-renewal-test';
    const org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug, pnc_settings) VALUES ('PnC Renewal Test', $1, '{"enabled":true}') ON CONFLICT (slug) DO UPDATE SET pnc_settings = EXCLUDED.pnc_settings RETURNING id`, [slug]))!.id;
    const site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, pbjt_rate_bps) VALUES ($1, 'PnC Renewal Hub', 1000) RETURNING id`, [org]))!.id;
    const ident = `PNC-RENEW-${Date.now()}`;
    const cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, status, pnc_enabled) VALUES ($1, $2, 'online', true) RETURNING id`, [site, ident]))!.id;
    await query(`INSERT INTO pnc_certificate (org_id, charge_point_id, certificate_type, state, not_after) VALUES ($1, $2, 'V2GCertificate', 'delivered', now() + interval '5 days')`, [org, cp]);
    const alerts: any[] = [];
    const off = bus.onAny((e) => { const a = e.payload as any; if (e.kind === 'alert.raised' && a?.targetId === cp) alerts.push(a); });
    try {
      const r = await renewExpiringCertificates();
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].kind, 'pnc.certificate_expiring');
      assert.equal(alerts[0].severity, 'warning');
      assert.match(alerts[0].message, /expires in [45] days/);
      assert.equal(r.triggered, 0, 'not connected: nothing sent');
      // Plenty of time left: nothing to do.
      await query(`UPDATE pnc_certificate SET not_after = now() + interval '200 days' WHERE charge_point_id = $1`, [cp]);
      alerts.length = 0;
      await renewExpiringCertificates();
      assert.equal(alerts.length, 0);
    } finally {
      off();
      await query(`DELETE FROM pnc_certificate WHERE charge_point_id = $1`, [cp]);
      await query(`DELETE FROM charge_point WHERE id = $1`, [cp]);
      await query(`DELETE FROM site WHERE id = $1`, [site]);
    }
  });

  test('Get15118EVCertificate round trip through the test PKI', async () => {
    const r = await evCertificate({ iso15118SchemaVersion: 'urn:iso:15118:2:2013:MsgDef', action: 'Install', exiRequest: Buffer.from('exi').toString('base64') }, 'UNIT-TEST');
    assert.equal(r.status, 'Accepted');
    assert.match(Buffer.from(r.exiResponse, 'base64').toString(), /^PLUGSURE-TEST-PKI:Install:/);
  });
});
