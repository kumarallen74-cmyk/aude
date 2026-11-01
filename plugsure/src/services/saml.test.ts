import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SignedXml } from 'xml-crypto';
import { verifyResponse, normaliseCert, authnRequestXml, metadataXml, SamlError, type Provider } from './saml.js';
import { IDP_KEY, IDP_CERT, OTHER_KEY } from '../../tools/testing/saml-idp-fixture.js';

/**
 * SAML response verification (v1.42.0), against a test identity provider whose key is below (test-only, generated for
 * these tests (tools/testing/saml-idp-fixture.ts), used nowhere else). Each refusal is one way an assertion could be forged, replayed or misdirected.
 */


const ORG = '11111111-2222-4333-8444-555555555555';
const BASE = 'https://csms.example.test';
const ACS = `${BASE}/v1/auth/saml/${ORG}/acs`;
const SP = `${BASE}/v1/auth/saml/${ORG}/metadata`;
const IDP = 'https://idp.example.test/saml';
const REQ = '_0123456789abcdef0123456789abcdef01234567';
const provider: Provider = { orgId: ORG, enabled: true, idpEntityId: IDP, ssoUrl: 'https://idp.example.test/sso', certificates: [normaliseCert(IDP_CERT).pem], allowedDomains: ['example.co.id'],
  jitEnabled: true, groupAttribute: null, roleMap: [{ group: 'CSMS Ops', role: 'cpo_operations_manager' }], updatedAt: null };
const NOW = Date.parse('2026-11-01T10:00:00Z');
const iso = (ms: number) => new Date(NOW + ms).toISOString();

interface Opt { audience?: string; inResponseTo?: string; recipient?: string; notOnOrAfter?: number; issuer?: string; email?: string; status?: string; destination?: string }
function assertionXml(o: Opt = {}) {
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0" IssueInstant="${iso(0)}">`
    + `<saml:Issuer>${o.issuer ?? IDP}</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.email ?? 'rina@example.co.id'}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${o.inResponseTo ?? REQ}" Recipient="${o.recipient ?? ACS}" NotOnOrAfter="${iso(o.notOnOrAfter ?? 300_000)}"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(o.notOnOrAfter ?? 300_000)}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_s1"/>`
    + `<saml:AttributeStatement><saml:Attribute Name="displayName"><saml:AttributeValue>Rina Wulandari</saml:AttributeValue></saml:Attribute>`
    + `<saml:Attribute Name="groups"><saml:AttributeValue>CSMS Ops</saml:AttributeValue><saml:AttributeValue>Everyone</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`
    + `</saml:Assertion>`;
}
const responseOf = (assertion: string, o: Opt = {}) =>
  `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r1" Version="2.0" IssueInstant="${iso(0)}" Destination="${o.destination ?? ACS}" InResponseTo="${o.inResponseTo ?? REQ}">`
  + `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${IDP}</saml:Issuer>`
  + `<samlp:Status><samlp:StatusCode Value="${o.status ?? 'urn:oasis:names:tc:SAML:2.0:status:Success'}"/></samlp:Status>${assertion}</samlp:Response>`;

function signAssertion(xml: string, key = IDP_KEY, alg = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', digest = 'http://www.w3.org/2001/04/xmlenc#sha256') {
  const sig = new SignedXml({ privateKey: key, signatureAlgorithm: alg as any, canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  sig.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: digest as any, transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'] });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
  return sig.getSignedXml();
}
const b64 = (s: string) => Buffer.from(s).toString('base64');
const expect = { requestId: REQ, provider, base: BASE };
const signedResponse = (o: Opt = {}, key?: string) => signAssertion(responseOf(assertionXml(o), o), key);
function refused(xml: string, code: string, e = expect) {
  assert.throws(() => verifyResponse(b64(xml), e, NOW), (err: unknown) => err instanceof SamlError && err.code === code, `expected ${code}`);
}

describe('SAML response verification', () => {
  test('a signed assertion for this sign-in gives the identity, with its groups', () => {
    const id = verifyResponse(b64(signedResponse()), expect, NOW);
    assert.equal(id.nameId, 'rina@example.co.id');
    assert.equal(id.email, 'rina@example.co.id');
    assert.equal(id.name, 'Rina Wulandari');
    assert.deepEqual(id.groups, ['CSMS Ops', 'Everyone']);
    assert.equal(id.sessionIndex, '_s1');
  });

  test('signed by another key, or changed after signing, is refused', () => {
    refused(signedResponse({}, OTHER_KEY), 'bad_signature');
    refused(signedResponse().replace('rina@example.co.id', 'boss@example.co.id'), 'bad_signature');
  });

  test('signature wrapping: a second, unsigned assertion beside the signed one is refused', () => {
    const good = signedResponse();
    const evil = assertionXml({ email: 'boss@example.co.id' }).replace('ID="_a1"', 'ID="_evil"');
    refused(good.replace('<samlp:Status>', `${evil}<samlp:Status>`), 'bad_response');
    // …and moving the signed assertion inside an extension, with the evil one in its place.
    const signedAssertion = good.slice(good.indexOf('<saml:Assertion'), good.indexOf('</saml:Assertion>') + '</saml:Assertion>'.length);
    const wrapped = good.replace(signedAssertion, `${evil}<samlp:Extensions>${signedAssertion}</samlp:Extensions>`);
    refused(wrapped, 'bad_response');
  });

  test('the audience, recipient, request id, issuer and time must all be this sign-in\'s', () => {
    refused(signedResponse({ audience: 'https://other.example.test/sp' }), 'wrong_audience');
    refused(signedResponse({ recipient: 'https://evil.example.test/acs' }), 'not_confirmed');
    refused(signedResponse({ inResponseTo: '_someone-elses-request' }), 'not_confirmed');
    refused(signedResponse({ issuer: 'https://idp.other.test' }), 'wrong_issuer');
    refused(signedResponse({ notOnOrAfter: -10 * 60_000 }), 'expired');
    refused(signedResponse({ destination: 'https://evil.example.test/acs' }), 'wrong_destination');
  });

  test('unsigned, SHA-1, a DOCTYPE, a failure status and encrypted assertions are refused', () => {
    refused(responseOf(assertionXml()), 'unsigned');
    refused(signAssertion(responseOf(assertionXml()), IDP_KEY, 'http://www.w3.org/2000/09/xmldsig#rsa-sha1', 'http://www.w3.org/2000/09/xmldsig#sha1'), 'weak_signature');
    refused(`<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "y">]>${signedResponse()}`, 'bad_response');
    refused(signedResponse({ status: 'urn:oasis:names:tc:SAML:2.0:status:Requester' }), 'idp_refused');
    refused(responseOf('<saml:EncryptedAssertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"/>'), 'unsupported');
    assert.throws(() => verifyResponse(undefined, expect, NOW), SamlError);
  });

  test('certificates, the request and the metadata', () => {
    assert.throws(() => normaliseCert('not a certificate'), (e: unknown) => e instanceof SamlError && e.code === 'bad_certificate');
    assert.throws(() => normaliseCert(IDP_CERT, Date.parse('2099-01-01')), /bad_certificate/);
    const n = normaliseCert(IDP_CERT.replace(/-----[A-Z ]+-----|\s/g, ''));
    assert.match(n.subject, /PlugSure SAML test IdP/);
    const req = authnRequestXml(REQ, provider, BASE, new Date(NOW));
    assert.match(req, new RegExp(`ID="${REQ}"`));
    assert.match(req, new RegExp(`AssertionConsumerServiceURL="${ACS.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"`));
    assert.match(metadataXml(ORG, BASE), new RegExp(`entityID="${SP.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"`));
  });
});
