import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { buildCertificate, certInfo, derToPem, hashDataOf, name, ocspResponse } from './der.js';
import { authorizeContract, getSettings } from './service.js';

/**
 * Plug & Charge Authorize, end to end through the service (database-backed:
 * settings, trust anchors and the contract live in the database).
 *
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5433/plugsure_audit_fix npx tsx --test src/pnc/authorize-hardening.test.ts
 *
 * Both attacks below were Accepted before v1.3.x's path and OCSP checks.
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[authorize-hardening.test] SKIPPING (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const ec = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = (k: ReturnType<typeof ec>) => k.publicKey.export({ type: 'spki', format: 'der' });
const from = () => new Date(Date.now() - 60_000);
const to = () => new Date(Date.now() + 2 * 365 * 86_400_000);

const SLUG = 'pnc-authorize-hardening-test';
const EMAID = 'IDHRDC00000001';
const ID = 'PNC-HARDEN-01';
let orgId = '', siteId = '', cpId = '';
const rootK = ec();
const rootName = name([['C', 'ID'], ['O', 'Harden MO'], ['CN', 'Harden MO Root']]);
const root = buildCertificate({ serial: randomBytes(8), issuer: rootName, subject: rootName, spki: spki(rootK), notBefore: from(), notAfter: to(), ca: { pathLen: 1 }, signKey: rootK.privateKey });

if (DB_OK) {
  before(async () => {
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug, pnc_settings) VALUES ('PnC Hardening Test', $1, '{"enabled":true,"acceptWhenOcspUnavailable":true}')
       ON CONFLICT (slug) DO UPDATE SET pnc_settings = EXCLUDED.pnc_settings RETURNING id`, [SLUG]))!.id;
    siteId = (await one<{ id: string }>(`INSERT INTO site (org_id, name, local_tax_rate_bps) VALUES ($1, 'PnC Hardening Hub', 1000) RETURNING id`, [orgId]))!.id;
    await query(`DELETE FROM pnc_event WHERE charge_point_id IN (SELECT id FROM charge_point WHERE ocpp_identity = $1)`, [ID]);
    await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [ID]);
    cpId = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, status) VALUES ($1, $2, 'online') RETURNING id`, [siteId, ID]))!.id;
    await query(`DELETE FROM pnc_trust_anchor WHERE org_id = $1`, [orgId]);
    const i = certInfo(root);
    await query(`INSERT INTO pnc_trust_anchor (org_id, kind, pem, subject, fingerprint, not_after) VALUES ($1, 'MORootCertificate', $2, $3, $4, $5)`,
      [orgId, derToPem(root), i.subject, i.fingerprint, i.notAfter]);
    await query(`INSERT INTO token (org_id, kind, uid, status, offline_allowed) VALUES ($1, 'emaid', $2, 'Accepted', false) ON CONFLICT DO NOTHING`, [orgId, EMAID]);
  });
  after(async () => {
    await query(`DELETE FROM pnc_event WHERE charge_point_id = $1`, [cpId]);
    await query(`DELETE FROM charge_point WHERE id = $1`, [cpId]);
    await query(`DELETE FROM site WHERE id = $1`, [siteId]);
    await query(`DELETE FROM pnc_trust_anchor WHERE org_id = $1`, [orgId]);
    await query(`DELETE FROM token WHERE org_id = $1 AND uid = $2`, [orgId, EMAID]);
    await pool.end();
  });
}

const ctx = () => ({ ocppIdentity: ID, chargePointId: cpId, orgId });

dbDescribe('Plug & Charge Authorize: forged chains and unverifiable OCSP', () => {
  test('a contract certificate signed by an end-entity certificate (CA:FALSE, no keyUsage) under the MO root is refused', async () => {
    // Even with the operator's "accept when OCSP is unavailable" on: the CHAIN is the problem.
    assert.equal((await getSettings(orgId)).acceptWhenOcspUnavailable, true);
    const eeK = ec();
    const eeName = name([['C', 'ID'], ['O', 'Harden MO'], ['CN', 'IDHRDC99999999']]);
    const ee = buildCertificate({ serial: randomBytes(9), issuer: rootName, subject: eeName, spki: spki(eeK), issuerSpki: spki(rootK), notBefore: from(), notAfter: to(), signKey: rootK.privateKey, noKeyUsage: true });
    const leafK = ec();
    const forged = buildCertificate({ serial: randomBytes(9), issuer: eeName, subject: name([['C', 'ID'], ['CN', EMAID]]), spki: spki(leafK), issuerSpki: spki(eeK), notBefore: from(), notAfter: to(), signKey: eeK.privateKey });
    const r = await authorizeContract(ctx() as any, { idToken: { idToken: EMAID, type: 'eMAID' }, certificate: derToPem(forged) + derToPem(ee) });
    assert.equal(r.idTokenInfo.status, 'Invalid');
    assert.equal(r.certificateStatus, 'CertChainError');
  });

  test('hash data naming the charger\'s own responder: an answer not signed by a trusted issuer is refused', async () => {
    // A genuine-looking sub-CA name, but the attacker's own key, and a responder that says "good".
    const evilK = ec();
    const subName = name([['C', 'ID'], ['O', 'Harden MO'], ['CN', 'Harden MO Sub-CA']]);
    const evilSub = buildCertificate({ serial: randomBytes(8), issuer: subName, subject: subName, spki: spki(evilK), notBefore: from(), notAfter: to(), ca: { pathLen: 0 }, signKey: evilK.privateKey });
    const leafK = ec();
    const leaf = buildCertificate({ serial: randomBytes(9), issuer: subName, subject: name([['CN', EMAID]]), spki: spki(leafK), issuerSpki: spki(evilK), notBefore: from(), notAfter: to(), signKey: evilK.privateKey });
    const h = hashDataOf(leaf, evilSub);
    const answer = ocspResponse(h, 'good', { key: evilK.privateKey, spkiDer: spki(evilK) }, new Date(), undefined, { certs: [evilSub] });
    const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/ocsp-response' }); res.end(answer); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ocsp`;
      const r = await authorizeContract(ctx() as any, { idToken: { idToken: EMAID, type: 'eMAID' }, iso15118CertificateHashData: [{ ...h, responderURL: url }] });
      assert.equal(r.idTokenInfo.status, 'Invalid');
      assert.equal(r.certificateStatus, 'SignatureError');
    } finally {
      server.close();
    }
  });

  test('defaults fail closed: acceptWhenOcspUnavailable is off unless an operator turns it on', async () => {
    const other = await one<{ id: string }>(
      `INSERT INTO organisation (name, slug, pnc_settings) VALUES ('PnC Defaults Test', 'pnc-defaults-test', '{"enabled":true}')
       ON CONFLICT (slug) DO UPDATE SET pnc_settings = EXCLUDED.pnc_settings RETURNING id`);
    assert.equal((await getSettings(other!.id)).acceptWhenOcspUnavailable, false);
  });
});
