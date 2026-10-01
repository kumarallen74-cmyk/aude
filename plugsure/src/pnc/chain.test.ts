import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import {
  buildCertificate, certConstraints, derToPem, hashDataOf, name, ocspFreshnessProblem, ocspResponse, ocspResponseCerts, OID, readOcspResponse,
} from './der.js';
import { checkContractChain, issuerPathProblem, trustedIssuerFor } from './chain.js';

/**
 * Plug & Charge contract chains and OCSP answers (pure; no database).
 * The forged chain below validated to the MO root before the path checks.
 */
const ec = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = (k: ReturnType<typeof ec>) => k.publicKey.export({ type: 'spki', format: 'der' });
const YEAR = 365 * 24 * 3600_000;
const from = () => new Date(Date.now() - 60_000);
const to = (years = 2) => new Date(Date.now() + years * YEAR);
const EMAID = 'IDPLSC12345678';
const OCSP = 'http://ocsp.test/ocsp';

/** MO root → MO sub-CA → contract, as the test PKI builds them. */
function mo(rootPathLen = 1) {
  const rootK = ec(), subK = ec();
  const rootName = name([['C', 'ID'], ['O', 'Test MO'], ['CN', 'Test MO Root']]);
  const subName = name([['C', 'ID'], ['O', 'Test MO'], ['CN', 'Test MO Sub-CA']]);
  const root = buildCertificate({ serial: randomBytes(8), issuer: rootName, subject: rootName, spki: spki(rootK), notBefore: from(), notAfter: to(10), ca: { pathLen: rootPathLen }, signKey: rootK.privateKey });
  const sub = buildCertificate({ serial: randomBytes(8), issuer: rootName, subject: subName, spki: spki(subK), issuerSpki: spki(rootK), notBefore: from(), notAfter: to(5), ca: { pathLen: 0 }, signKey: rootK.privateKey, ocspUrl: OCSP });
  return { rootK, subK, rootName, subName, root, sub, rootX: new X509Certificate(root) };
}
function contract(issuerName: Buffer, issuerK: ReturnType<typeof ec>, emaid = EMAID, extra: Partial<Parameters<typeof buildCertificate>[0]> = {}) {
  const k = ec();
  const der = buildCertificate({
    serial: randomBytes(9), issuer: issuerName, subject: name([['C', 'ID'], ['O', 'Test MO'], ['CN', emaid]]), spki: spki(k), issuerSpki: spki(issuerK),
    notBefore: from(), notAfter: to(), signKey: issuerK.privateKey, ocspUrl: OCSP, ...extra,
  });
  return { k, der };
}

describe('Plug & Charge: contract certificate path', () => {
  test('a genuine chain is accepted, with every certificate below the root up for OCSP', () => {
    const m = mo();
    const c = contract(m.subName, m.subK);
    const r = checkContractChain(derToPem(c.der) + derToPem(m.sub), EMAID, [m.rootX]);
    assert.equal(r.status, 'Accepted', r.why);
    assert.equal(r.revocation?.length, 2);
    assert.ok(r.revocation!.every((x) => x.responderURL === OCSP));
    assert.equal(r.revocation![1]!.issuer.fingerprint256, m.rootX.fingerprint256);
  });

  test('FORGED: a contract certificate signed by an END-ENTITY certificate (CA:FALSE, no keyUsage) is refused', () => {
    const m = mo();
    // An end-entity certificate under the MO root: not a CA, and no keyUsage.
    const eeK = ec();
    const eeName = name([['C', 'ID'], ['O', 'Test MO'], ['CN', 'IDPLSC99999999']]);
    const ee = buildCertificate({ serial: randomBytes(9), issuer: m.rootName, subject: eeName, spki: spki(eeK), issuerSpki: spki(m.rootK), notBefore: from(), notAfter: to(), signKey: m.rootK.privateKey, noKeyUsage: true });
    // Its key signs a "contract certificate" for somebody else's eMAID.
    const forged = contract(eeName, eeK, EMAID, { ocspUrl: undefined });
    const eeX = new X509Certificate(ee), forgedX = new X509Certificate(forged.der);
    // The premise: Node alone links it all the way to the MO root.
    assert.ok(!eeX.ca);
    assert.ok(forgedX.checkIssued(eeX) && forgedX.verify(eeX.publicKey) && eeX.checkIssued(m.rootX) && eeX.verify(m.rootX.publicKey));
    const r = checkContractChain(derToPem(forged.der) + derToPem(ee), EMAID, [m.rootX]);
    assert.equal(r.status, 'CertChainError');
    assert.match(r.why!, /not a CA certificate/);
  });

  test('pathLenConstraint is enforced: a root allowing no sub-CA cannot anchor one', () => {
    const m = mo(0);
    const c = contract(m.subName, m.subK);
    const r = checkContractChain(derToPem(c.der) + derToPem(m.sub), EMAID, [m.rootX]);
    assert.equal(r.status, 'CertChainError');
    assert.match(r.why!, /allows 0 CA certificate/);
  });

  test('a CA certificate presented as the contract, someone else\'s eMAID, and an unanchored chain are refused', () => {
    const m = mo();
    assert.equal(checkContractChain(derToPem(m.sub), EMAID, [m.rootX]).status, 'CertChainError');
    const c = contract(m.subName, m.subK, 'IDPLSC87654321');
    assert.match(checkContractChain(derToPem(c.der) + derToPem(m.sub), EMAID, [m.rootX]).why!, /not ID-PLS-C12345678/);
    const other = mo();
    assert.match(checkContractChain(derToPem(contract(m.subName, m.subK).der) + derToPem(m.sub), EMAID, [other.rootX]).why!, /does not lead/);
  });

  test('issuerPathProblem: a keyUsage without keyCertSign cannot issue', () => {
    const m = mo();
    const leafK = ec();
    const notIssuer = new X509Certificate(buildCertificate({ serial: randomBytes(8), issuer: m.subName, subject: name([['CN', 'leaf']]), spki: spki(leafK), issuerSpki: spki(m.subK), notBefore: from(), notAfter: to(), signKey: m.subK.privateKey }));
    assert.match(issuerPathProblem([notIssuer]) ?? '', /not a CA|keyCertSign/);
    assert.equal(issuerPathProblem([new X509Certificate(m.sub), m.rootX]), null);
  });

  test('certConstraints reads basicConstraints, keyUsage and extendedKeyUsage', () => {
    const m = mo();
    assert.deepEqual(certConstraints(m.root), { ca: true, pathLen: 1, keyUsage: 0x06, eku: [] });
    const leaf = contract(m.subName, m.subK, EMAID, { eku: [OID.ocspSigning] });
    assert.deepEqual(certConstraints(leaf.der), { ca: false, pathLen: null, keyUsage: 0x88, eku: [OID.ocspSigning] });
    const bare = contract(m.subName, m.subK, EMAID, { noKeyUsage: true });
    assert.equal(certConstraints(bare.der).keyUsage, null);
  });
});

describe('Plug & Charge: OCSP answers', () => {
  test('a delegated responder must carry id-kp-OCSPSigning', () => {
    const m = mo();
    const c = contract(m.subName, m.subK);
    const h = hashDataOf(c.der, m.sub);
    const respK = ec();
    const responder = (eku: string[]) => buildCertificate({ serial: randomBytes(8), issuer: m.subName, subject: name([['CN', 'OCSP responder']]), spki: spki(respK), issuerSpki: spki(m.subK), notBefore: from(), notAfter: to(), signKey: m.subK.privateKey, eku });
    const signer = { key: respK.privateKey, spkiDer: spki(respK) };
    const ok = readOcspResponse(ocspResponse(h, 'good', signer, new Date(), undefined, { certs: [responder([OID.ocspSigning])] }), h, [m.subK.publicKey]);
    assert.equal(ok.signatureValid, true);
    // Any other certificate the issuer signed (here: a TLS client certificate) cannot vouch.
    const notResponder = readOcspResponse(ocspResponse(h, 'good', signer, new Date(), undefined, { certs: [responder([OID.clientAuth])] }), h, [m.subK.publicKey]);
    assert.equal(notResponder.signatureValid, false);
  });

  test('freshness: stale, future-dated and undated-but-old answers are refused', () => {
    const now = new Date();
    assert.equal(ocspFreshnessProblem({ thisUpdate: new Date(now.getTime() - 3600_000), nextUpdate: new Date(now.getTime() + 3600_000) }, now), null);
    assert.match(ocspFreshnessProblem({ thisUpdate: new Date(now.getTime() - 3 * 86_400_000), nextUpdate: new Date(now.getTime() - 86_400_000) }, now)!, /stale/);
    assert.match(ocspFreshnessProblem({ thisUpdate: new Date(now.getTime() + 3600_000) }, now)!, /future/);
    assert.match(ocspFreshnessProblem({ thisUpdate: new Date(now.getTime() - 8 * 86_400_000) }, now)!, /7 days/);
    assert.equal(ocspFreshnessProblem({ thisUpdate: new Date(now.getTime() - 86_400_000) }, now), null);
    // Round trip through a real response without nextUpdate.
    const m = mo();
    const h = hashDataOf(contract(m.subName, m.subK).der, m.sub);
    const old = readOcspResponse(ocspResponse(h, 'good', { key: m.subK.privateKey, spkiDer: spki(m.subK) }, new Date(now.getTime() - 10 * 86_400_000), undefined, { nextUpdate: null }), h, [m.subK.publicKey]);
    assert.equal(old.nextUpdate, undefined);
    assert.ok(ocspFreshnessProblem(old, now));
  });

  test('hash data: the issuer is trusted only when it chains to an MO root as a CA', () => {
    const m = mo();
    const c = contract(m.subName, m.subK);
    const h = hashDataOf(c.der, m.sub);
    const subX = new X509Certificate(m.sub);
    const resp = ocspResponse(h, 'good', { key: m.subK.privateKey, spkiDer: spki(m.subK) }, new Date(), undefined, { certs: [m.sub] });
    const pool = ocspResponseCerts(resp).map((d) => new X509Certificate(d));
    assert.equal(pool.length, 1);
    assert.equal(trustedIssuerFor(h, pool, [m.rootX])?.fingerprint256, subX.fingerprint256);
    // Hash data about the sub-CA: its issuer is the root itself.
    assert.equal(trustedIssuerFor(hashDataOf(m.sub, m.root), [], [m.rootX])?.fingerprint256, m.rootX.fingerprint256);
    // Nothing to chain it with, or an attacker's own CA carried in the answer: no trusted issuer.
    assert.equal(trustedIssuerFor(h, [], [m.rootX]), null);
    const evil = mo();
    const evilC = contract(evil.subName, evil.subK);
    assert.equal(trustedIssuerFor(hashDataOf(evilC.der, evil.sub), [new X509Certificate(evil.sub), evil.rootX], [m.rootX]), null);
    // An end entity under the root (CA:FALSE) does not become an issuer by being carried along.
    const eeK = ec();
    const eeName = name([['CN', 'IDPLSC99999999']]);
    const ee = buildCertificate({ serial: randomBytes(9), issuer: m.rootName, subject: eeName, spki: spki(eeK), issuerSpki: spki(m.rootK), notBefore: from(), notAfter: to(), signKey: m.rootK.privateKey, noKeyUsage: true });
    const forged = contract(eeName, eeK);
    assert.equal(trustedIssuerFor(hashDataOf(forged.der, ee), [new X509Certificate(ee)], [m.rootX]), null);
  });
});
