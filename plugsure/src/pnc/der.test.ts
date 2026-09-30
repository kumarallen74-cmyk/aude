import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, X509Certificate, createHash } from 'node:crypto';
import {
  name, buildCsr, parseCsr, buildCertificate, derToPem, certInfo, hashDataOf, ocspRequest, readOcspRequest,
  ocspResponse, readOcspResponse, publicKeyBits, int, parse, intHex, splitPemChain,
} from './der.js';

const ec = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = (k: ReturnType<typeof ec>) => k.publicKey.export({ type: 'spki', format: 'der' });
const year = 365 * 24 * 3600_000;

/** A root and an issuing CA, as the test PKI builds them. */
function pki() {
  const rootK = ec();
  const rootName = name([['C', 'ID'], ['O', 'Test'], ['CN', 'Test V2G Root'], ['DC', 'V2G']]);
  const root = buildCertificate({ serial: randomBytes(8), issuer: rootName, subject: rootName, spki: spki(rootK), notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 10 * year), ca: { pathLen: 1 }, signKey: rootK.privateKey });
  const subK = ec();
  const subName = name([['C', 'ID'], ['O', 'Test'], ['CN', 'Test CPO Sub-CA']]);
  const sub = buildCertificate({ serial: randomBytes(8), issuer: rootName, subject: subName, spki: spki(subK), issuerSpki: spki(rootK), notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 4 * year), ca: { pathLen: 0 }, signKey: rootK.privateKey });
  return { rootK, root, subK, sub, subName };
}

describe('DER, X.509 and OCSP for Plug & Charge', () => {
  test('integers are minimal and positive', () => {
    assert.equal(int(0).toString('hex'), '020100');
    assert.equal(int(128).toString('hex'), '02020080');
    assert.equal(int(Buffer.from('000001', 'hex')).toString('hex'), '020101');
    assert.equal(int(Buffer.from('ff', 'hex')).toString('hex'), '020200ff');
    assert.equal(intHex(parse(int(Buffer.from('00ab12', 'hex')))), 'AB12');
  });

  test('a CSR round-trips and its signature is checked', () => {
    const k = ec();
    const csr = buildCsr(name([['C', 'ID'], ['O', 'PlugSure'], ['CN', 'SECC-CP-01'], ['DC', 'CPO']]), k);
    const p = parseCsr(csr);
    assert.equal(p.subjectText, 'C=ID, O=PlugSure, CN=SECC-CP-01, DC=CPO');
    assert.equal(p.keyType, 'ec');
    // Tamper with one byte of the subject: the signature no longer verifies.
    const der = Buffer.from(csr.replace(/-----[^-]+-----|\s/g, ''), 'base64');
    const i = der.indexOf(Buffer.from('SECC-CP-01'));
    der[i] = 0x54;
    assert.throws(() => parseCsr(der.toString('base64')), /does not verify/);
    assert.throws(() => parseCsr('hello'), /./);
  });

  test('a certificate built here is valid X.509 to OpenSSL, with the right chain and fields', () => {
    const { rootK, root, subK, sub, subName } = pki();
    const leafK = ec();
    const csr = parseCsr(buildCsr(name([['CN', 'SECC-CP-01'], ['O', 'PlugSure'], ['C', 'ID'], ['DC', 'CPO']]), leafK));
    const notAfter = new Date(Date.now() + year);
    const leaf = buildCertificate({ serial: Buffer.from('0102030405', 'hex'), issuer: subName, subject: csr.subjectDer, spki: csr.spkiDer, issuerSpki: spki(subK), notBefore: new Date(), notAfter, signKey: subK.privateKey, ocspUrl: 'http://ocsp.test/ocsp' });
    const xr = new X509Certificate(root), xs = new X509Certificate(sub), xl = new X509Certificate(leaf);
    assert.ok(xr.verify(rootK.publicKey) && xr.ca, 'self-signed root');
    assert.ok(xs.verify(rootK.publicKey) && xs.checkIssued(xr) && xs.ca, 'sub-CA under the root');
    assert.ok(xl.verify(subK.publicKey) && xl.checkIssued(xs) && !xl.ca, 'leaf under the sub-CA');
    const info = certInfo(derToPem(leaf));
    assert.equal(info.serial, '102030405');
    assert.equal(info.subject, 'CN=SECC-CP-01, O=PlugSure, C=ID, DC=CPO');
    assert.equal(info.issuer, 'C=ID, O=Test, CN=Test CPO Sub-CA');
    assert.equal(info.ocspUrl, 'http://ocsp.test/ocsp');
    assert.equal(Math.floor(info.notAfter.getTime() / 1000), Math.floor(notAfter.getTime() / 1000));
    assert.equal(info.fingerprint, xl.fingerprint256.replace(/:/g, '').toLowerCase());
    assert.equal(splitPemChain(derToPem(leaf) + derToPem(sub)).length, 2);
  });

  test('certificate hash data is SHA-256 of the issuer name and the issuer key bits', () => {
    const { sub, subK, subName } = pki();
    const leafK = ec();
    const leaf = buildCertificate({ serial: Buffer.from('00ff01', 'hex'), issuer: subName, subject: name([['CN', 'IDPLSC1A2B3C4D5']]), spki: spki(leafK), issuerSpki: spki(subK), notBefore: new Date(), notAfter: new Date(Date.now() + year), signKey: subK.privateKey });
    const h = hashDataOf(leaf, sub);
    assert.equal(h.hashAlgorithm, 'SHA256');
    assert.equal(h.issuerNameHash, createHash('sha256').update(subName).digest('hex'));
    assert.equal(h.issuerKeyHash, createHash('sha256').update(publicKeyBits(spki(subK))).digest('hex'));
    assert.equal(h.serialNumber, 'FF01');
  });

  test('OCSP: request round-trip; good, revoked and unknown answers; forged answers are caught', () => {
    const { subK } = pki();
    const h = { hashAlgorithm: 'SHA256' as const, issuerNameHash: 'aa'.repeat(32), issuerKeyHash: 'bb'.repeat(32), serialNumber: '1234ABCD' };
    assert.deepEqual(readOcspRequest(ocspRequest(h)), h);
    const signer = { key: subK.privateKey, spkiDer: spki(subK) };
    const good = readOcspResponse(ocspResponse(h, 'good', signer), h, [subK.publicKey]);
    assert.equal(good.status, 'good');
    assert.equal(good.signatureValid, true);
    assert.ok(good.nextUpdate && good.nextUpdate > new Date());
    const revokedAt = new Date(Date.now() - 3600_000);
    const rev = readOcspResponse(ocspResponse(h, 'revoked', signer, new Date(), revokedAt), h, [subK.publicKey]);
    assert.equal(rev.status, 'revoked');
    assert.equal(Math.floor(rev.revokedAt!.getTime() / 1000), Math.floor(revokedAt.getTime() / 1000));
    assert.equal(readOcspResponse(ocspResponse(h, 'unknown', signer), h).status, 'unknown');
    // Signed by some other key: the status is read, but the signature is not valid.
    const other = ec();
    const forged = readOcspResponse(ocspResponse(h, 'good', { key: other.privateKey, spkiDer: spki(other) }), h, [subK.publicKey]);
    assert.equal(forged.signatureValid, false);
    // An answer about a different certificate says nothing about this one.
    assert.equal(readOcspResponse(ocspResponse({ ...h, serialNumber: '99' }, 'good', signer), h, [subK.publicKey]).status, 'unknown');
    // A responder error.
    const tryLater = Buffer.from('30030a0103', 'hex');
    assert.equal(readOcspResponse(tryLater, h).responseStatus, 'tryLater');
  });
});
