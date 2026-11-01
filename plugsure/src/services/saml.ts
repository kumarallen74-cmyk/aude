import { createHash, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config, isRelaxedEnv } from '../config.js';
import { consoleBrandForHost, consoleBrandForOrg } from './console-brand.js';

/**
 * SAML 2.0 single sign-on for the operator console (v1.42.0): Okta, Microsoft Entra ID, Google Workspace, OneLogin,
 * ADFS… — any identity provider that speaks SAML 2.0 Web Browser SSO.
 *
 * Each organisation connects its own identity provider (org_saml_provider): the entity id, the sign-on URL, its signing
 * certificate(s), the e-mail domains it vouches for, and optionally automatic account set-up with a group → role map.
 * PlugSure is the service provider: entity id …/v1/auth/saml/<org>/metadata, assertion consumer service …/acs.
 *
 * The flow, and why each piece is there:
 *
 *   start    from the sign-in page (a work e-mail, whose domain picks the organisation): a random AuthnRequest ID, a
 *            random handle (RelayState) and a browser-binding value. The transaction is kept server-side (saml_login_tx,
 *            ten minutes, keyed by the handle's hash); the binding value goes into a cookie (HttpOnly, SameSite=Lax).
 *            The request goes to the identity provider by HTTP-Redirect.
 *   acs      the identity provider POSTs the response (HTTP-POST, a cross-site form post that carries no SameSite cookie).
 *            It is verified here — see verifyResponse — against THIS transaction: InResponseTo must be its request ID,
 *            so an unsolicited (IdP-initiated) or replayed assertion is refused. The verified identity is stored on the
 *            transaction, once.
 *   finish   the acs answers with a page that moves the browser to …/finish on our own origin: that navigation carries
 *            the binding cookie, which must match the transaction's. That is what stops login CSRF (an attacker's
 *            assertion delivered into your browser has no matching cookie). The transaction is deleted (single use),
 *            the user resolved, the session created.
 *
 * Verification (verifyResponse):
 *   · no DOCTYPE (entity expansion), at most 256 KiB, one Assertion, never an EncryptedAssertion;
 *   · the XML signature checked with the identity provider's stored certificate only (the KeyInfo in the message is
 *     ignored), RSA-SHA256 or stronger (SHA-1 refused); the Assertion, or the whole Response, must be signed;
 *   · only what the signature covers is read (xml-crypto's getSignedReferences): the defence against signature
 *     wrapping, where a second, unsigned Assertion is slipped in beside the signed one;
 *   · Issuer is the provider's entity id; Audience is our entity id; the bearer SubjectConfirmation's Recipient is our
 *     ACS URL, its InResponseTo our request ID, NotOnOrAfter in the future; Conditions' NotBefore / NotOnOrAfter hold
 *     (three minutes of clock skew); the Response's Destination, when given, is our ACS URL; status Success.
 *
 * Users (resolveUser): the account linked to the NameID; otherwise the console user with that e-mail in the organisation
 * (then linked); otherwise, only when automatic set-up is on and the address is on an allowed domain, a new user with
 * the role its groups map to. A mapping never grants an administrator role (platform:* or user:write) — a compromised
 * or misconfigured identity provider cannot create administrators. No group mapped: refused. Nothing here logs an
 * assertion.
 */

export class SamlError extends Error {
  constructor(public code: string, public detail: string, public statusCode = 400) { super(code); }
}

export const SAML_TX_TTL_MINUTES = 10;
export const SAML_COOKIE = 'ps_saml_tx';
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const SKEW_MS = 3 * 60_000;
const NS = { p: 'urn:oasis:names:tc:SAML:2.0:protocol', a: 'urn:oasis:names:tc:SAML:2.0:assertion', ds: 'http://www.w3.org/2000/09/xmldsig#' };
const STRONG_ALGS = new Set([
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
]);
const STRONG_DIGESTS = new Set(['http://www.w3.org/2001/04/xmlenc#sha256', 'http://www.w3.org/2001/04/xmlenc#sha512']);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const xmlEsc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));

// ------------------------------------------------------------------ addresses

/*
 * Two kinds of address:
 *   the entity ID   is built on the shared console's address (CONSOLE_PUBLIC_URL, else PUBLIC_BASE_URL), so it never
 *                   changes with the address someone signs in on. (PUBLIC_BASE_URL is usually the chargers' OCPP host:
 *                   deploy/README.md §2.)
 *   the ACS URL     is on the address the sign-in started on: the shared console, or the organisation's approved
 *                   white-label address. The browser must come back there, because the binding cookie and the new
 *                   session belong to that address. Any other address does not offer single sign-on.
 * Outside production, without those settings, the request's own host serves for both (benches, tests).
 */
const urlOrigin = (u: string | undefined) => { try { return u ? new URL(u).origin : null; } catch { return null; } };
const relaxedOrigin = (host: unknown, protocol: string) =>
  isRelaxedEnv() && typeof host === 'string' && /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `${protocol === 'https' ? 'https' : 'http'}://${host.toLowerCase()}` : null;
const sharedConsole = () => urlOrigin(config.alerts.consoleUrl) ?? urlOrigin(config.console.publicBaseUrl);

/** The base of the entity ID: the shared console's address. */
export function entityBase(host?: unknown, protocol = 'https'): string {
  const o = sharedConsole() ?? relaxedOrigin(host, protocol);
  if (!o) throw new SamlError('not_configured', 'CONSOLE_PUBLIC_URL (or PUBLIC_BASE_URL) is not set', 503);
  return o;
}

/** The addresses a sign-in can run on for this organisation: the shared console's and its approved white-label one. */
export async function flowBases(orgId: string): Promise<string[]> {
  const out = new Set<string>();
  const shared = sharedConsole();
  if (shared) out.add(shared);
  const brand = await consoleBrandForOrg(orgId).catch(() => null);
  if (brand?.hostname && brand.hostnameApproved) out.add(`https://${brand.hostname}`);
  return [...out];
}

/** The base of the address this request came in on, when a sign-in for this organisation may run there. */
export async function flowBase(orgId: string, host: unknown, protocol = 'https'): Promise<string> {
  const h = String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
  const hit = (await flowBases(orgId)).find((b) => new URL(b).host === h);
  if (hit) return hit;
  const r = relaxedOrigin(host, protocol);
  if (r) return r;
  throw new SamlError('wrong_host', 'single sign-on for this organisation is not offered on this address', 400);
}
export const spEntityId = (orgId: string, base: string) => `${base}/v1/auth/saml/${orgId}/metadata`;
export const acsUrl = (orgId: string, base: string) => `${base}/v1/auth/saml/${orgId}/acs`;

// ------------------------------------------------------------------ configuration

export interface Provider {
  orgId: string; enabled: boolean; idpEntityId: string; ssoUrl: string; certificates: string[]; allowedDomains: string[];
  jitEnabled: boolean; groupAttribute: string | null; roleMap: Array<{ group: string; role: string }>; updatedAt: string | null;
}
const providerOf = (r: any): Provider => ({
  orgId: r.org_id, enabled: r.enabled, idpEntityId: r.idp_entity_id, ssoUrl: r.sso_url, certificates: r.certificates, allowedDomains: r.allowed_domains ?? [],
  jitEnabled: r.jit_enabled, groupAttribute: r.group_attribute ?? null, roleMap: r.role_map ?? [], updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
});

/** A PEM certificate (or its bare base64 body), normalised; refused when it does not parse or has expired. */
export function normaliseCert(raw: string, now = Date.now()): { pem: string; subject: string; notAfter: string; fingerprint: string } {
  const body = String(raw ?? '').replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]{200,}$/.test(body)) throw new SamlError('bad_certificate', 'not a base64 X.509 certificate', 422);
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  let c: X509Certificate;
  try { c = new X509Certificate(pem); } catch { throw new SamlError('bad_certificate', 'the certificate does not parse', 422); }
  if (Date.parse(c.validTo) < now) throw new SamlError('bad_certificate', `the certificate expired on ${c.validTo}`, 422);
  return { pem, subject: c.subject.replace(/\n/g, ', '), notAfter: new Date(c.validTo).toISOString(), fingerprint: c.fingerprint256 };
}

export async function getProvider(orgId: string): Promise<Provider | null> {
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM org_saml_provider WHERE org_id = $1`, [orgId]));
  return r ? providerOf(r) : null;
}

/** The roles a group may map to: the organisation's assignable roles that are not administrator roles. */
export async function mappableRoles(): Promise<Array<{ name: string }>> {
  // (v1.43.0) Only roles granted organisation-wide: a group (SAML or SCIM) gives its role across the organisation, so a
  // site-, owner- or fleet-limited role (Site Host / Landlord, the portals) would be widened to every site. Those are
  // given in the console, with their sites.
  const { CONSOLE_ROLES } = await import('./authz.js');
  const limited = CONSOLE_ROLES.filter((r) => r.siteScoped || r.ownerScoped || r.fleetScoped).map((r) => r.name);
  return outsideRequestScope(() => many<{ name: string }>(
    `SELECT r.name FROM role r WHERE r.org_id IS NULL AND NOT EXISTS (SELECT 1 FROM unnest(r.permissions) p WHERE p LIKE 'platform:%' OR p = 'user:write')
      AND r.name NOT IN ('fleet_customer', 'site_owner', 'api_client') AND NOT (r.name = ANY($1::text[])) ORDER BY r.name`, [limited]));
}

export async function saveProvider(orgId: string, b: Record<string, unknown>, userId: string | null): Promise<Provider> {
  const cur = await getProvider(orgId);
  const pick = <T>(k: string, d: T): T => (b[k] === undefined ? d : (b[k] as T));
  const idpEntityId = String(pick('idpEntityId', cur?.idpEntityId ?? '')).trim();
  if (idpEntityId.length < 3 || idpEntityId.length > 500) throw new SamlError('invalid', 'idpEntityId (the identity provider\'s entity id / issuer) is required.', 422);
  const ssoUrl = String(pick('ssoUrl', cur?.ssoUrl ?? '')).trim();
  let u: URL | null = null;
  try { u = new URL(ssoUrl); } catch { u = null; }
  if (!u || u.protocol !== 'https:') throw new SamlError('invalid', 'ssoUrl is the identity provider\'s https sign-on URL (HTTP-Redirect binding).', 422);
  const rawCerts = pick<unknown>('certificates', cur?.certificates ?? []);
  const list = (Array.isArray(rawCerts) ? rawCerts : [rawCerts]).map(String).filter((x) => x.trim());
  if (!list.length || list.length > 3) throw new SamlError('invalid', 'certificates: the identity provider\'s signing certificate (1 to 3, PEM).', 422);
  const certificates = list.map((c) => normaliseCert(c).pem);
  const rawDomains = pick<unknown>('allowedDomains', cur?.allowedDomains ?? []);
  const allowedDomains = [...new Set((Array.isArray(rawDomains) ? rawDomains : String(rawDomains).split(/[,\s]+/)).map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  if (!allowedDomains.length || allowedDomains.some((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) throw new SamlError('invalid', 'allowedDomains: the e-mail domains this identity provider vouches for (e.g. example.co.id).', 422);
  // One domain belongs to one organisation's SSO: the sign-in page picks the organisation by it.
  const clash = await outsideRequestScope(() => one<{ org_id: string }>(`SELECT org_id FROM org_saml_provider WHERE org_id <> $1 AND allowed_domains && $2::text[] LIMIT 1`, [orgId, allowedDomains]));
  if (clash) throw new SamlError('invalid', 'One of these domains is already used by another organisation\'s single sign-on.', 409);
  const jitEnabled = pick('jitEnabled', cur?.jitEnabled ?? false) === true;
  const groupAttribute = (pick<unknown>('groupAttribute', cur?.groupAttribute ?? null) as string | null) ? String(pick('groupAttribute', cur?.groupAttribute)).trim().slice(0, 300) : null;
  const rawMap = pick<unknown>('roleMap', cur?.roleMap ?? []);
  const allowedRoles = new Set((await mappableRoles()).map((r) => r.name));
  const roleMap = (Array.isArray(rawMap) ? rawMap : []).slice(0, 50).map((m: any, i: number) => {
    const group = String(m?.group ?? '').trim(), role = String(m?.role ?? '').trim();
    if (!group || group.length > 300) throw new SamlError('invalid', `roleMap[${i}]: a group name is required.`, 422);
    if (!allowedRoles.has(role)) throw new SamlError('invalid', `roleMap[${i}]: ${role.slice(0, 40)} is not a role a group may give (never an administrator role).`, 422);
    return { group, role };
  });
  if (jitEnabled && !roleMap.length) throw new SamlError('invalid', 'Automatic account set-up needs at least one group → role mapping.', 422);
  const enabled = pick('enabled', cur?.enabled ?? false) === true;
  const dup = await outsideRequestScope(() => one<{ org_id: string }>(`SELECT org_id FROM org_saml_provider WHERE org_id <> $1 AND idp_entity_id = $2`, [orgId, idpEntityId]));
  if (dup) throw new SamlError('invalid', 'This identity provider is already connected to another organisation.', 409);
  await outsideRequestScope(() => query(
    `INSERT INTO org_saml_provider (org_id, enabled, idp_entity_id, sso_url, certificates, allowed_domains, jit_enabled, group_attribute, role_map, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, idp_entity_id = EXCLUDED.idp_entity_id, sso_url = EXCLUDED.sso_url, certificates = EXCLUDED.certificates,
       allowed_domains = EXCLUDED.allowed_domains, jit_enabled = EXCLUDED.jit_enabled, group_attribute = EXCLUDED.group_attribute, role_map = EXCLUDED.role_map,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, enabled, idpEntityId, ssoUrl, certificates, allowedDomains, jitEnabled, groupAttribute, JSON.stringify(roleMap), userId]));
  return (await getProvider(orgId))!;
}

/** The view for the console: the provider (certificates summarised) and what to enter at the identity provider. */
export async function describe(orgId: string, host?: unknown, protocol = 'https') {
  const p = await getProvider(orgId);
  let base: string | null = null;
  try { base = entityBase(host, protocol); } catch { base = null; }
  const acsList = (await flowBases(orgId)).map((b) => acsUrl(orgId, b));
  if (!acsList.length && base) acsList.push(acsUrl(orgId, base));
  return {
    provider: p ? { ...p, certificates: p.certificates.map((c) => { try { const n = normaliseCert(c, 0); return { subject: n.subject, notAfter: n.notAfter, fingerprint: n.fingerprint }; } catch { return { subject: 'unreadable', notAfter: null, fingerprint: null }; } }) } : null,
    serviceProvider: base ? { entityId: spEntityId(orgId, base), acsUrl: acsList[0], acsUrls: acsList, metadataUrl: spEntityId(orgId, base), nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' } : null,
    roles: (await mappableRoles()).map((r) => r.name),
  };
}

export function metadataXml(orgId: string, base: string, acsBases: string[] = [base]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${xmlEsc(spEntityId(orgId, base))}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
${acsBases.map((b, i) => `    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${xmlEsc(acsUrl(orgId, b))}" index="${i}"${i === 0 ? ' isDefault="true"' : ''}/>`).join('\n')}
  </md:SPSSODescriptor>
</md:EntityDescriptor>
`;
}

// ------------------------------------------------------------------ start

/**
 * Whether the sign-in page on this address offers the single sign-on button: on an operator's approved white-label
 * address, when that operator has it switched on; on the shared console (or outside production), when any
 * organisation has. Anywhere else the browser could not complete it.
 */
export async function offeredOn(host: unknown, protocol = 'https'): Promise<boolean> {
  const h = String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
  const brand = await consoleBrandForHost(h).catch(() => null);
  if (brand) return (await getProvider(brand.orgId).catch(() => null))?.enabled === true;
  const shared = sharedConsole();
  if (!(shared && new URL(shared).host === h) && !relaxedOrigin(host, protocol)) return false;
  const r = await outsideRequestScope(() => one<{ on: boolean }>(`SELECT EXISTS (SELECT 1 FROM org_saml_provider WHERE enabled) AS on`));
  return r?.on === true;
}

/** The organisation whose single sign-on covers this e-mail's domain (enabled only). */
export async function providerForEmail(email: unknown): Promise<Provider> {
  const e = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) throw new SamlError('bad_email', 'enter your work e-mail address', 400);
  const domain = e.slice(e.lastIndexOf('@') + 1);
  const r = await outsideRequestScope(() => one<any>(
    `SELECT p.* FROM org_saml_provider p JOIN organisation o ON o.id = p.org_id WHERE p.enabled AND o.archived_at IS NULL AND $1 = ANY(p.allowed_domains)`, [domain]));
  if (!r) throw new SamlError('no_sso', `no single sign-on is set up for ${domain}`, 404);
  return providerOf(r);
}

export function authnRequestXml(id: string, p: Provider, base: string, now = new Date(), acsBase = base): string {
  return `<samlp:AuthnRequest xmlns:samlp="${NS.p}" xmlns:saml="${NS.a}" ID="${id}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${xmlEsc(p.ssoUrl)}" `
    + `ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" AssertionConsumerServiceURL="${xmlEsc(acsUrl(p.orgId, acsBase))}">`
    + `<saml:Issuer>${xmlEsc(spEntityId(p.orgId, base))}</saml:Issuer>`
    + `<samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="true"/></samlp:AuthnRequest>`;
}

/** Start a sign-in: the redirect to the identity provider and the binding value for the cookie. */
export async function start(email: unknown, host: unknown, protocol: string, ip: string | undefined) {
  const p = await providerForEmail(email);
  const base = entityBase(host, protocol);
  const flow = await flowBase(p.orgId, host, protocol);
  const requestId = `_${randomBytes(20).toString('hex')}`;
  const handle = randomBytes(32).toString('base64url'), binding = randomBytes(32).toString('base64url');
  await outsideRequestScope(() => query(`DELETE FROM saml_login_tx WHERE expires_at < now()`));
  await outsideRequestScope(() => query(
    `INSERT INTO saml_login_tx (id_hash, org_id, request_id, browser_hash, host, ip, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))`,
    [sha(handle), p.orgId, requestId, sha(binding), String(host ?? '').slice(0, 200), ip ?? null, SAML_TX_TTL_MINUTES]));
  const req = deflateRawSync(Buffer.from(authnRequestXml(requestId, p, base, new Date(), flow))).toString('base64');
  const url = new URL(p.ssoUrl);
  url.searchParams.set('SAMLRequest', req);
  url.searchParams.set('RelayState', handle);
  return { url: url.toString(), binding, orgId: p.orgId };
}

// ------------------------------------------------------------------ the response

export interface Identity { nameId: string; email: string | null; name: string | null; groups: string[]; sessionIndex: string | null }

const childrenNS = (el: any, ns: string, local: string): any[] => {
  const out: any[] = [];
  for (let n = el?.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.namespaceURI === ns && n.localName === local) out.push(n);
  return out;
};
const allNS = (el: any, ns: string, local: string): any[] => Array.from(el.getElementsByTagNameNS(ns, local) as ArrayLike<any>);
const text = (n: any) => (n?.textContent ?? '').trim();

function parse(xml: string): any {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) throw new SamlError('bad_response', 'a DOCTYPE is not allowed');
  const errors: string[] = [];
  const doc = new DOMParser({ onError: (level: string, msg: string) => { if (level !== 'warning') errors.push(msg); } }).parseFromString(xml, 'text/xml');
  if (errors.length || !doc?.documentElement) throw new SamlError('bad_response', 'the XML does not parse');
  return doc;
}

/**
 * Verify a base64 SAMLResponse for a sign-in in flight. Returns the identity, or throws SamlError. `expect` is what the
 * transaction knows: our request ID and the provider; `now` for the time checks.
 */
export function verifyResponse(samlResponse: unknown, expect: { requestId: string; provider: Provider; base: string; acsBase?: string }, now = Date.now()): Identity {
  if (typeof samlResponse !== 'string' || !samlResponse || samlResponse.length > MAX_RESPONSE_BYTES * 1.4) throw new SamlError('bad_response', 'no SAMLResponse, or too large');
  const xml = Buffer.from(samlResponse, 'base64').toString('utf8');
  if (xml.length > MAX_RESPONSE_BYTES) throw new SamlError('bad_response', 'too large');
  const doc = parse(xml);
  const root = doc.documentElement;
  if (root.namespaceURI !== NS.p || root.localName !== 'Response') throw new SamlError('bad_response', 'not a samlp:Response');
  if (allNS(doc, NS.a, 'EncryptedAssertion').length) throw new SamlError('unsupported', 'encrypted assertions are not supported: switch assertion encryption off at the identity provider');
  const acs = acsUrl(expect.provider.orgId, expect.acsBase ?? expect.base), sp = spEntityId(expect.provider.orgId, expect.base);
  const dest = root.getAttribute('Destination');
  if (dest && dest !== acs) throw new SamlError('wrong_destination', 'the response is for another address');
  const status = allNS(root, NS.p, 'StatusCode')[0]?.getAttribute('Value');
  if (status !== 'urn:oasis:names:tc:SAML:2.0:status:Success') throw new SamlError('idp_refused', `the identity provider answered ${String(status ?? 'no status').split(':').pop()}`);
  if (allNS(doc, NS.a, 'Assertion').length !== 1) throw new SamlError('bad_response', 'exactly one Assertion is expected');

  // The signature: on the Assertion or on the Response, checked with the stored certificates only.
  const sigs = allNS(doc, NS.ds, 'Signature').filter((s) => {
    const parent = s.parentNode;
    return parent && parent.namespaceURI && ((parent.namespaceURI === NS.a && parent.localName === 'Assertion') || (parent.namespaceURI === NS.p && parent.localName === 'Response'));
  });
  if (!sigs.length) throw new SamlError('unsigned', 'the response is not signed');
  let signedXml: string | null = null;
  for (const s of sigs) {
    const alg = allNS(s, NS.ds, 'SignatureMethod')[0]?.getAttribute('Algorithm');
    if (!STRONG_ALGS.has(alg)) throw new SamlError('weak_signature', `signature algorithm ${String(alg).split('#').pop()} refused: use RSA-SHA256`);
    for (const dm of allNS(s, NS.ds, 'DigestMethod')) if (!STRONG_DIGESTS.has(dm.getAttribute('Algorithm'))) throw new SamlError('weak_signature', 'digest algorithm refused: use SHA-256');
    for (const pem of expect.provider.certificates) {
      const v = new SignedXml({ publicCert: pem, getCertFromKeyInfo: () => null });
      v.loadSignature(s);
      let ok = false;
      try { ok = v.checkSignature(xml); } catch { ok = false; }
      if (!ok) continue;
      const refs = v.getSignedReferences();
      if (refs.length !== 1) continue;
      signedXml = refs[0]!;
      break;
    }
    if (signedXml) break;
  }
  if (!signedXml) throw new SamlError('bad_signature', 'the signature does not verify with the configured certificate');

  // Read ONLY what was signed.
  const sdoc = parse(signedXml);
  const sroot = sdoc.documentElement;
  const assertion = sroot.namespaceURI === NS.a && sroot.localName === 'Assertion' ? sroot
    : sroot.namespaceURI === NS.p && sroot.localName === 'Response' ? (() => { const a = childrenNS(sroot, NS.a, 'Assertion'); return a.length === 1 ? a[0] : null; })() : null;
  if (!assertion) throw new SamlError('bad_response', 'the signature does not cover an assertion');
  if (allNS(sdoc, NS.a, 'Assertion').length !== 1) throw new SamlError('bad_response', 'exactly one signed Assertion is expected');

  const issuer = text(childrenNS(assertion, NS.a, 'Issuer')[0]);
  if (issuer !== expect.provider.idpEntityId) throw new SamlError('wrong_issuer', 'the assertion is from another identity provider');
  const conditions = childrenNS(assertion, NS.a, 'Conditions')[0];
  if (!conditions) throw new SamlError('bad_response', 'no Conditions');
  const nb = conditions.getAttribute('NotBefore'), noa = conditions.getAttribute('NotOnOrAfter');
  if (nb && Date.parse(nb) - SKEW_MS > now) throw new SamlError('expired', 'the assertion is not valid yet (check the clocks)');
  if (!noa || Date.parse(noa) + SKEW_MS <= now) throw new SamlError('expired', 'the assertion has expired');
  const audiences = allNS(conditions, NS.a, 'Audience').map(text);
  if (!audiences.includes(sp)) throw new SamlError('wrong_audience', 'the assertion is for another service provider (check the entity id at the identity provider)');
  const subject = childrenNS(assertion, NS.a, 'Subject')[0];
  const nameId = text(subject && childrenNS(subject, NS.a, 'NameID')[0]);
  if (!nameId || nameId.length > 500) throw new SamlError('bad_response', 'no NameID');
  const confirmed = (subject ? childrenNS(subject, NS.a, 'SubjectConfirmation') : []).some((sc) => {
    if (sc.getAttribute('Method') !== 'urn:oasis:names:tc:SAML:2.0:cm:bearer') return false;
    const d = childrenNS(sc, NS.a, 'SubjectConfirmationData')[0];
    if (!d) return false;
    const nooa = d.getAttribute('NotOnOrAfter');
    return d.getAttribute('Recipient') === acs && d.getAttribute('InResponseTo') === expect.requestId && !!nooa && Date.parse(nooa) + SKEW_MS > now;
  });
  if (!confirmed) throw new SamlError('not_confirmed', 'no bearer confirmation for this sign-in (Recipient, InResponseTo or its time)');

  const attrs = new Map<string, string[]>();
  for (const a of allNS(assertion, NS.a, 'Attribute')) {
    const vals = childrenNS(a, NS.a, 'AttributeValue').map(text).filter(Boolean);
    for (const k of [a.getAttribute('Name'), a.getAttribute('FriendlyName')].filter(Boolean)) attrs.set(String(k).toLowerCase(), [...(attrs.get(String(k).toLowerCase()) ?? []), ...vals]);
  }
  const first = (...keys: string[]) => { for (const k of keys) { const v = attrs.get(k.toLowerCase())?.[0]; if (v) return v; } return null; };
  const isEmail = (s: string | null) => !!s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  const email = [first('email', 'mail', 'emailaddress', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'urn:oid:0.9.2342.19200300.100.1.3'), nameId].find(isEmail)?.toLowerCase() ?? null;
  const display = first('displayname', 'name', 'http://schemas.microsoft.com/identity/claims/displayname', 'urn:oid:2.16.840.1.113730.3.1.241');
  const given = first('givenname', 'firstname', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname', 'urn:oid:2.5.4.42');
  const sur = first('surname', 'sn', 'lastname', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname', 'urn:oid:2.5.4.4');
  const groupKeys = expect.provider.groupAttribute ? [expect.provider.groupAttribute] : ['groups', 'group', 'memberof', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups', 'http://schemas.xmlsoap.org/claims/group'];
  const groups = [...new Set(groupKeys.flatMap((k) => attrs.get(k.toLowerCase()) ?? []))].slice(0, 200);
  const authn = childrenNS(assertion, NS.a, 'AuthnStatement')[0];
  return { nameId, email, name: (display ?? [given, sur].filter(Boolean).join(' ')) || null, groups, sessionIndex: authn?.getAttribute('SessionIndex') ?? null };
}

/** The identity provider's POST: verify it against its transaction and keep the identity on it (once). */
export async function acs(orgId: string, body: Record<string, unknown>, host: unknown, protocol: string, now = Date.now()) {
  if (!UUID_RE.test(orgId)) throw new SamlError('not_found', 'no such organisation', 404);
  const handle = typeof body.RelayState === 'string' ? body.RelayState : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(handle)) throw new SamlError('no_transaction', 'unsolicited response (sign in from PlugSure\'s page)');
  const tx = await outsideRequestScope(() => one<any>(`SELECT * FROM saml_login_tx WHERE id_hash = $1 AND org_id = $2 AND expires_at > now() AND answered_at IS NULL`, [sha(handle), orgId]));
  if (!tx) throw new SamlError('no_transaction', 'the sign-in expired or was already used: start again');
  const p = await getProvider(orgId);
  if (!p?.enabled) throw new SamlError('not_enabled', 'single sign-on is off for this organisation', 403);
  const identity = verifyResponse(body.SAMLResponse, { requestId: tx.request_id, provider: p, base: entityBase(host, protocol), acsBase: await flowBase(orgId, host, protocol) }, now);
  const r = await outsideRequestScope(() => query(`UPDATE saml_login_tx SET identity = $2, answered_at = now() WHERE id_hash = $1 AND answered_at IS NULL`, [tx.id_hash, JSON.stringify(identity)]));
  if (!r.rowCount) throw new SamlError('no_transaction', 'the sign-in was already used');
  return { handle, orgId };
}

/** The finish step: the binding cookie must match; the transaction is consumed. */
export async function consume(handle: unknown, bindings: string[]): Promise<{ orgId: string; identity: Identity; host: string }> {
  if (typeof handle !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(handle)) throw new SamlError('no_transaction', 'no sign-in to finish');
  const tx = await outsideRequestScope(() => one<any>(`DELETE FROM saml_login_tx WHERE id_hash = $1 AND identity IS NOT NULL AND expires_at > now() RETURNING *`, [sha(handle)]));
  if (!tx) throw new SamlError('no_transaction', 'the sign-in expired or was already used: start again');
  const want = Buffer.from(tx.browser_hash, 'hex');
  const ok = bindings.some((b) => { const h = Buffer.from(sha(b), 'hex'); return h.length === want.length && timingSafeEqual(h, want); });
  if (!ok) throw new SamlError('wrong_browser', 'the sign-in was started in another browser');
  return { orgId: tx.org_id, identity: tx.identity as Identity, host: tx.host };
}

// ------------------------------------------------------------------ the user

export interface SamlUser { id: string; orgId: string; email: string; mfaEnabled: boolean; created: boolean; linkedNow: boolean; role?: string }

export async function resolveUser(orgId: string, id: Identity, opts: { onlyOrgId?: string | null; refuseAdministrators?: boolean } = {}): Promise<SamlUser> {
  if (opts.onlyOrgId && opts.onlyOrgId !== orgId) throw new SamlError('wrong_host', 'another operator\'s console address', 403);
  const p = await getProvider(orgId);
  if (!p?.enabled) throw new SamlError('not_enabled', 'single sign-on is off for this organisation', 403);
  const cols = `id, org_id, email, status, (locked_until IS NOT NULL AND locked_until > now()) AS locked, (totp_secret IS NOT NULL AND totp_enabled_at IS NOT NULL) AS mfa_enabled`;
  const uCols = `u.id, u.org_id, u.email, u.status, (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
                 (u.totp_secret IS NOT NULL AND u.totp_enabled_at IS NOT NULL) AS mfa_enabled`;
  let u = await outsideRequestScope(() => one<any>(
    `SELECT ${uCols} FROM saml_user_link l JOIN app_user u ON u.id = l.user_id WHERE l.org_id = $1 AND l.name_id = $2 AND u.org_id = $1`, [orgId, id.nameId]));
  let linkedNow = false, created = false, role: string | undefined;
  const domainOk = (e: string | null) => !!e && p.allowedDomains.includes(e.slice(e.lastIndexOf('@') + 1));
  if (!u) {
    if (!domainOk(id.email)) throw new SamlError('domain_not_allowed', 'the account\'s e-mail is not on an allowed domain', 403);
    u = await outsideRequestScope(() => one<any>(`SELECT ${cols} FROM app_user WHERE org_id = $1 AND lower(email) = $2`, [orgId, id.email]));
    if (!u) {
      if (!p.jitEnabled) throw new SamlError('no_user', 'no console user with this e-mail: ask an administrator to invite you', 403);
      const mapped = p.roleMap.find((m) => id.groups.some((g) => g.toLowerCase() === m.group.toLowerCase()));
      if (!mapped) throw new SamlError('no_role', 'none of your groups is mapped to a role', 403);
      // Re-checked here: a role must still be non-administrative at the time it is granted.
      const roleRow = await outsideRequestScope(() => one<{ id: string; admin: boolean }>(
        `SELECT r.id, EXISTS (SELECT 1 FROM unnest(r.permissions) p WHERE p LIKE 'platform:%' OR p = 'user:write') AS admin FROM role r WHERE r.name = $1 AND r.org_id IS NULL`, [mapped.role]));
      if (!roleRow || roleRow.admin || !(await mappableRoles()).some((r) => r.name === mapped.role)) throw new SamlError('no_role', 'the mapped role cannot be given by single sign-on', 403);
      u = await outsideRequestScope(() => one<any>(
        `INSERT INTO app_user (org_id, email, name, status) VALUES ($1, $2, $3, 'active') RETURNING ${cols}`, [orgId, id.email, (id.name ?? id.email!.split('@')[0]!).slice(0, 120)]));
      await outsideRequestScope(() => query(`INSERT INTO user_role (user_id, role_id, scope_type) VALUES ($1, $2, 'org')`, [u.id, roleRow.id]));
      created = true; role = mapped.role;
    }
    await outsideRequestScope(() => query(`INSERT INTO saml_user_link (org_id, name_id, user_id) VALUES ($1, $2, $3) ON CONFLICT (org_id, name_id) DO NOTHING`, [orgId, id.nameId, u.id]));
    linkedNow = true;
  }
  if (u.status !== 'active') throw new SamlError('disabled', 'the console user is disabled', 403);
  if (u.locked) throw new SamlError('locked', 'the console user is locked', 403);
  if (opts.refuseAdministrators) {
    const { isAdministratorAccount } = await import('./users.js');
    if (await outsideRequestScope(() => isAdministratorAccount(u.id))) throw new SamlError('admin_host', 'administrators sign in on the administration address', 403);
  }
  await outsideRequestScope(() => query(`UPDATE saml_user_link SET last_seen_at = now() WHERE org_id = $1 AND name_id = $2`, [orgId, id.nameId]));
  return { id: u.id, orgId, email: u.email, mfaEnabled: u.mfa_enabled === true, created, linkedNow, role };
}
