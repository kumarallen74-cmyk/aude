import http from 'node:http';
import https from 'node:https';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { one, outsideRequestScope, query, tx } from '../db/pool.js';
import { config, isRelaxedEnv } from '../config.js';
import { logger } from '../logger.js';
import { seal, unseal } from '../services/secrets.js';
import { resolve } from '../integrations/store.js';
import { enforcing, guardedLookup, isInternalHost } from '../services/net-guard.js';
import {
  buildCertificate, certInfo, certSubjectDer, derToPem, hashDataOf, name, ocspRequest, ocspResponse, parseCsr, pemToDer, publicKeyBits,
  splitPemChain, type CertificateHashData,
} from './der.js';

/**
 * The V2G PKI behind Plug & Charge.
 *
 * Three things only a PKI can do for the CSMS:
 *   - sign a charger's V2G (SECC) certificate request   (SignCertificate)
 *   - install or update a contract certificate in the car (Get15118EVCertificate;
 *     the request and answer are EXI the PKI's contract pool understands)
 *   - publish its root certificates, for the chargers' trust stores
 *
 * OCSP is not provider-specific: the responder URL is in the certificate, so
 * the CSMS asks it directly (ocspFetch).
 *
 * Providers (PNC_PKI):
 *   none  Plug & Charge requests are answered Failed with the reason logged.
 *   mock  A test PKI kept in the database (V2G root → CPO sub-CA; MO root → MO
 *         sub-CA → contract certificates), with its own OCSP responder. Refused
 *         in production.
 *   http  A PKI gateway (in front of Hubject's or another provider's API), with
 *         the small JSON contract documented in deploy/README.md.
 */

export class PkiError extends Error {}

export type SignableType = 'V2GCertificate' | 'ChargingStationCertificate';

export interface EvCertificateRequest {
  iso15118SchemaVersion: string;
  action: 'Install' | 'Update';
  exiRequest: string;
}

export interface PncConfig {
  mode: 'none' | 'mock' | 'http';
  url: string;
  token: string;
  signer: 'pki' | 'vault';
  vaultMount: string;
  vaultRole: string;
  source: 'console' | 'environment' | 'default';
}

/** The PKI in force: Govern → Integrations → Plug & Charge PKI, else PNC_* environment variables. */
export async function pncConfig(): Promise<PncConfig> {
  const r = await resolve('pnc_pki');
  return {
    mode: r?.provider === 'mock' ? 'mock' : r?.provider === 'http' ? 'http' : 'none',
    url: String(r?.settings.url ?? '').replace(/\/+$/, ''),
    token: r?.secrets.token ?? '',
    signer: r?.settings.signer === 'vault' ? 'vault' : 'pki',
    vaultMount: String(r?.settings.vaultMount || 'pki_v2g'),
    vaultRole: String(r?.settings.vaultRole || 'secc'),
    source: r?.source ?? 'default',
  };
}

export async function pkiMode(): Promise<'none' | 'mock' | 'http'> {
  return (await pncConfig()).mode;
}

/** Why the PKI cannot be used, or null. Shown in the console. */
export async function pkiProblem(): Promise<string | null> {
  const c = await pncConfig();
  if (c.mode === 'none') {
    return !isRelaxedEnv() && config.pnc.pki === 'mock'
      ? 'The test PKI is refused in production. Connect your PKI gateway under Govern → Integrations → Plug & Charge PKI.'
      : 'No V2G PKI is connected (Govern → Integrations → Plug & Charge PKI). Plug & Charge certificate requests are answered Failed.';
  }
  if (c.mode === 'http' && (!c.url || !c.token)) return 'The PKI gateway needs its URL and token (Govern → Integrations → Plug & Charge PKI).';
  if (c.signer === 'vault' && !(config.vault.addr && config.vault.token)) return 'Signing chargers\' V2G certificates with Vault needs VAULT_ADDR and VAULT_TOKEN.';
  return null;
}

export async function pkiDescription(): Promise<string> {
  const c = await pncConfig();
  const signer = c.signer === 'vault' ? ` · charger certificates signed by Vault (${c.vaultMount}/${c.vaultRole})` : '';
  if (c.mode === 'mock') return 'Test PKI (mock) — for development and sandboxes only' + signer;
  if (c.mode === 'http') return `PKI gateway at ${c.url}` + signer;
  return 'Not configured';
}
// ================================================================== signing

/** Sign a charger's certificate request. Returns the chain: leaf first, without the root. */
export async function signCsr(csrPem: string, type: SignableType, identity: string): Promise<string> {
  const csr = parseCsr(csrPem); // throws on a malformed or badly signed request
  if (!csr.subject.some(([k, v]) => k === 'CN' && v)) throw new PkiError('the request has no common name (CN)');
  if (type !== 'V2GCertificate') {
    throw new PkiError('ChargingStationCertificate requests are handled with the Security Profile 3 client certificate (Charger → Security).');
  }
  const why = await pkiProblem();
  const c = await pncConfig();
  if (c.signer === 'vault') {
    if (why && /Vault/.test(why)) throw new PkiError(why);
    return vaultSign(csrPem, csr.subject.find(([k]) => k === 'CN')![1], c);
  }
  if (why) throw new PkiError(why);
  if (c.mode === 'mock') return mockSign(csrPem);
  const r = await gateway<{ certificateChain?: string }>('POST', '/v1/certificates/sign', { csr: csrPem, certificateType: type, chargingStation: identity });
  const chain = String(r.certificateChain ?? '');
  if (!splitPemChain(chain).length) throw new PkiError('the PKI returned no certificate');
  return chain;
}

async function vaultSign(csrPem: string, cn: string, c: PncConfig): Promise<string> {
  const headers: Record<string, string> = { 'X-Vault-Token': config.vault.token, 'content-type': 'application/json' };
  if (config.vault.namespace) headers['X-Vault-Namespace'] = config.vault.namespace;
  const url = `${config.vault.addr}/v1/${c.vaultMount}/sign/${encodeURIComponent(c.vaultRole)}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ csr: csrPem, common_name: cn, ttl: `${config.pnc.certDays * 24}h`, format: 'pem' }), signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new PkiError(`Vault is unreachable: ${(e as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new PkiError(`Vault refused to sign: ${Array.isArray(body?.errors) ? body.errors.join('; ') : `HTTP ${res.status}`}`);
  const d = body?.data ?? {};
  const chain = [String(d.certificate ?? ''), ...(Array.isArray(d.ca_chain) ? d.ca_chain.map(String) : [String(d.issuing_ca ?? '')])];
  return chain.filter((p) => p.includes('BEGIN CERTIFICATE')).map((p) => p.trim() + '\n').join('');
}

// ================================================================== contract certificates in the car

export async function evCertificate(req: EvCertificateRequest, identity: string): Promise<{ status: 'Accepted' | 'Failed'; exiResponse: string; reason?: string }> {
  const why = await pkiProblem();
  if (why) return { status: 'Failed', exiResponse: '', reason: why };
  if ((await pkiMode()) === 'mock') {
    // The test PKI cannot decode EXI. It proves the round trip: the answer is a
    // marker tied to the request, which a real PKI replaces with the
    // CertificateInstallationRes / CertificateUpdateRes EXI stream.
    const marker = `PLUGSURE-TEST-PKI:${req.action}:${createHash('sha256').update(req.exiRequest).digest('hex')}`;
    return { status: 'Accepted', exiResponse: Buffer.from(marker).toString('base64') };
  }
  try {
    const r = await gateway<{ status?: string; exiResponse?: string }>('POST', '/v1/ev-certificates', { ...req, chargingStation: identity });
    const ok = r.status === 'Accepted' && typeof r.exiResponse === 'string';
    return { status: ok ? 'Accepted' : 'Failed', exiResponse: ok ? r.exiResponse! : '', ...(ok ? {} : { reason: `PKI answered ${r.status ?? 'nothing'}` }) };
  } catch (e) {
    return { status: 'Failed', exiResponse: '', reason: (e as Error).message };
  }
}

// ================================================================== roots

export async function pkiRoots(): Promise<{ v2g: string[]; mo: string[] }> {
  const why = await pkiProblem();
  if (why) throw new PkiError(why);
  if ((await pkiMode()) === 'mock') {
    const ca = await mockCa();
    return { v2g: [ca.v2g_root.pem], mo: [ca.mo_root.pem] };
  }
  const r = await gateway<{ v2gRoots?: string[]; moRoots?: string[] }>('GET', '/v1/roots');
  return { v2g: (r.v2gRoots ?? []).map(String), mo: (r.moRoots ?? []).map(String) };
}

// ================================================================== OCSP

/**
 * Ask the responder named in the certificate about it. Returns the DER
 * response, which the caller interprets (and, for GetCertificateStatus, hands
 * to the charger unchanged: the car checks its signature).
 *
 * The URL comes from a certificate a charger presented, so it goes through the
 * SSRF guard: http or https, no private addresses in production, no
 * redirects, a small body and a short timeout.
 */
export async function ocspFetch(h: CertificateHashData, responderURL: string): Promise<Buffer> {
  if (responderURL === config.pnc.mockOcspUrl && (await pkiMode()) === 'mock') return mockOcsp(h);
  let u: URL;
  try { u = new URL(responderURL); } catch { throw new PkiError('the OCSP responder URL is invalid'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new PkiError('the OCSP responder URL must be http or https');
  if (u.username || u.password) throw new PkiError('the OCSP responder URL must not contain credentials');
  if (enforcing() && isInternalHost(u.hostname)) throw new PkiError('the OCSP responder must be publicly reachable');
  const body = ocspRequest(h);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise<Buffer>((resolve, reject) => {
    const req = lib.request(u, { method: 'POST', lookup: guardedLookup as any, headers: { 'content-type': 'application/ocsp-request', 'content-length': body.length, 'user-agent': 'PlugSure-PnC/1.3' } }, (res) => {
      if ((res.statusCode ?? 0) !== 200) { res.resume(); return reject(new PkiError(`the OCSP responder answered HTTP ${res.statusCode}`)); }
      const parts: Buffer[] = []; let n = 0;
      res.on('data', (c: Buffer) => { n += c.length; if (n > 65_536) { req.destroy(new PkiError('the OCSP response is too large')); return; } parts.push(c); });
      res.on('end', () => resolve(Buffer.concat(parts)));
      res.on('error', reject);
    });
    req.setTimeout(config.pnc.ocspTimeoutMs, () => req.destroy(new PkiError('the OCSP responder did not answer in time')));
    req.on('error', (e) => reject(e instanceof PkiError ? e : new PkiError(`the OCSP responder is unreachable: ${e.message}`)));
    req.end(body);
  });
}

// ================================================================== PKI gateway (http)

async function gateway<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const c = await pncConfig();
  let res: Response;
  try {
    res = await fetch(c.url + path, {
      method,
      headers: { authorization: `Bearer ${c.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new PkiError(`the PKI gateway is unreachable: ${(e as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new PkiError(`the PKI gateway answered HTTP ${res.status}${data?.error ? `: ${String(data.error).slice(0, 200)}` : ''}`);
  return data as T;
}

// ================================================================== test PKI (mock)

type CaName = 'v2g_root' | 'cpo_sub' | 'mo_root' | 'mo_sub';
interface Ca { pem: string; key: KeyObject; der: Buffer; subject: Buffer; spki: Buffer }
let cached: Record<CaName, Ca> | null = null;

const YEAR = 365 * 24 * 3600_000;

function loadCa(row: { cert_pem: string; key_sealed: string }): Ca {
  const der = pemToDer(row.cert_pem);
  const info = certInfo(der);
  // The subject Name is the issuer Name of everything this CA signs: take it from the certificate itself.
  return { pem: row.cert_pem, key: createPrivateKey(unseal(row.key_sealed)), der, subject: certSubjectDer(der), spki: info.spkiDer };
}

/** The test PKI's CAs, created on first use and kept (keys sealed) in the database. */
export async function mockCa(): Promise<Record<CaName, Ca>> {
  if (cached) return cached;
  // Outside any request transaction: the gateway must see the CAs at once (a request that
  // issues a test contract and then asks the gateway would otherwise wait on its own lock).
  const rows = await outsideRequestScope(() => tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(15118)`);
    const have = (await c.query(`SELECT name, cert_pem, key_sealed FROM pnc_mock_ca`)).rows as Array<{ name: CaName; cert_pem: string; key_sealed: string }>;
    if (have.length === 4) {
      /**
       * Test PKIs created before v1.3.x issued their sub-CAs without an OCSP URL,
       * which the contract check now refuses as "not verifiable". Re-issue those
       * sub-CA certificates in place — same key, same subject, same issuer — so
       * the roots already installed on chargers and every certificate issued
       * under them stay valid.
       */
      const byName = Object.fromEntries(have.map((r) => [r.name, r])) as Record<CaName, { name: CaName; cert_pem: string; key_sealed: string }>;
      for (const [sub, parent] of [['cpo_sub', 'v2g_root'], ['mo_sub', 'mo_root']] as Array<[CaName, CaName]>) {
        const der = pemToDer(byName[sub].cert_pem);
        const info = certInfo(der);
        if (info.ocspUrl) continue;
        const parentDer = pemToDer(byName[parent].cert_pem);
        const reissued = buildCertificate({
          serial: randomBytes(8), issuer: certSubjectDer(parentDer), subject: certSubjectDer(der), spki: info.spkiDer, issuerSpki: certInfo(parentDer).spkiDer,
          notBefore: info.notBefore, notAfter: info.notAfter, ca: { pathLen: 0 }, signKey: createPrivateKey(unseal(byName[parent].key_sealed)),
          ocspUrl: config.pnc.mockOcspUrl,
        });
        byName[sub].cert_pem = derToPem(reissued);
        await c.query(`UPDATE pnc_mock_ca SET cert_pem = $2 WHERE name = $1`, [sub, byName[sub].cert_pem]);
        logger.warn({ ca: sub }, 'Plug & Charge test PKI: re-issued a sub-CA certificate with its OCSP URL');
      }
      return Object.values(byName);
    }
    const made: Record<string, { pem: string; key: KeyObject; subject: Buffer; spki: Buffer }> = {};
    const mk = (id: CaName, cn: string, parent: CaName | null, years: number) => {
      const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const subject = name([['C', 'ID'], ['O', 'PlugSure Test PKI'], ['CN', cn], ...(parent ? [] : [['DC', 'V2G'] as ['DC', string]])]);
      const spki = k.publicKey.export({ type: 'spki', format: 'der' });
      const p = parent ? made[parent]! : null;
      const der = buildCertificate({
        serial: randomBytes(8), issuer: p ? p.subject : subject, subject, spki, issuerSpki: p?.spki,
        notBefore: new Date(Date.now() - 3600_000), notAfter: new Date(Date.now() + years * YEAR),
        ca: { pathLen: parent ? 0 : 1 }, signKey: p ? p.key : k.privateKey,
        // A sub-CA names its responder too: a certificate without one cannot be revocation-checked.
        ...(parent ? { ocspUrl: config.pnc.mockOcspUrl } : {}),
      });
      made[id] = { pem: derToPem(der), key: k.privateKey, subject, spki };
    };
    mk('v2g_root', 'PlugSure Test V2G Root CA', null, 20);
    mk('cpo_sub', 'PlugSure Test CPO Sub-CA', 'v2g_root', 10);
    mk('mo_root', 'PlugSure Test MO Root CA', null, 20);
    mk('mo_sub', 'PlugSure Test MO Sub-CA', 'mo_root', 10);
    await c.query(`DELETE FROM pnc_mock_ca`);
    for (const [n, m] of Object.entries(made)) {
      await c.query(`INSERT INTO pnc_mock_ca (name, cert_pem, key_sealed) VALUES ($1,$2,$3)`, [n, m.pem, seal(m.key.export({ type: 'pkcs8', format: 'pem' }) as string)]);
    }
    logger.warn('Plug & Charge: created the test PKI (PNC_PKI=mock). Not for production.');
    return (await c.query(`SELECT name, cert_pem, key_sealed FROM pnc_mock_ca`)).rows;
  }));
  const out = {} as Record<CaName, Ca>;
  for (const r of rows) out[r.name as CaName] = loadCa(r);
  cached = out;
  return out;
}

async function mockSign(csrPem: string): Promise<string> {
  const ca = await mockCa();
  const csr = parseCsr(csrPem);
  const der = buildCertificate({
    serial: randomBytes(9), issuer: ca.cpo_sub.subject, subject: csr.subjectDer, spki: csr.spkiDer, issuerSpki: ca.cpo_sub.spki,
    notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + config.pnc.certDays * 24 * 3600_000),
    signKey: ca.cpo_sub.key, ocspUrl: config.pnc.mockOcspUrl,
  });
  return derToPem(der) + ca.cpo_sub.pem;
}

/**
 * The test PKI's OCSP responder: contract certificates it issued, and charger
 * certificates. Answers are signed by the issuing CA and carry its certificate,
 * as many real responders do, so a CSMS that knows only the MO root can still
 * verify an answer about a contract certificate from hash data alone.
 */
async function mockOcsp(h: CertificateHashData): Promise<Buffer> {
  const ca = await mockCa();
  const keyHash = (c: Ca) => createHash(h.hashAlgorithm === 'SHA384' ? 'sha384' : h.hashAlgorithm === 'SHA512' ? 'sha512' : 'sha256').update(publicKeyBits(c.spki)).digest('hex');
  const issuer = (['mo_sub', 'cpo_sub', 'mo_root', 'v2g_root'] as CaName[]).find((n) => keyHash(ca[n]) === h.issuerKeyHash.toLowerCase());
  if (!issuer) return ocspResponse(h, 'unknown', { key: ca.mo_sub.key, spkiDer: ca.mo_sub.spki });
  const signer = { key: ca[issuer].key, spkiDer: ca[issuer].spki };
  const opts = { certs: [ca[issuer].der] };
  if (issuer === 'mo_sub') {
    const c = await one<{ revoked_at: Date | null }>(`SELECT revoked_at FROM pnc_mock_contract WHERE upper(ltrim(serial, '0')) = upper(ltrim($1, '0'))`, [h.serialNumber]);
    if (!c) return ocspResponse(h, 'unknown', signer, new Date(), undefined, opts);
    return c.revoked_at ? ocspResponse(h, 'revoked', signer, new Date(), new Date(c.revoked_at), opts) : ocspResponse(h, 'good', signer, new Date(), undefined, opts);
  }
  // Sub-CAs and charger certificates the test PKI issued are in good standing.
  return ocspResponse(h, 'good', signer, new Date(), undefined, opts);
}

export interface TestContract {
  emaid: string;
  serial: string;
  certificatePem: string;
  chainPem: string;
  /** The OCPP iso15118CertificateHashData a charger would send: the contract certificate and its sub-CA. */
  hashData: Array<CertificateHashData & { responderURL: string }>;
}

/** Issue a contract certificate from the test PKI (sandboxes and tests only). */
export async function issueTestContract(emaid: string): Promise<TestContract> {
  if ((await pkiMode()) !== 'mock') throw new PkiError('Test contract certificates exist only with the test PKI (Govern → Integrations → Plug & Charge PKI → Test PKI).');
  const ca = await mockCa();
  const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = buildCertificate({
    serial: randomBytes(9), issuer: ca.mo_sub.subject, subject: name([['C', 'ID'], ['O', 'PlugSure Test MO'], ['CN', emaid]]),
    spki: k.publicKey.export({ type: 'spki', format: 'der' }), issuerSpki: ca.mo_sub.spki,
    notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 2 * YEAR), signKey: ca.mo_sub.key, ocspUrl: config.pnc.mockOcspUrl,
  });
  const pem = derToPem(der);
  const serial = certInfo(der).serial;
  // Committed at once: the charger's Authorize (in the gateway) may follow within the same request.
  await outsideRequestScope(() => query(`INSERT INTO pnc_mock_contract (serial, emaid, cert_pem) VALUES ($1,$2,$3)`, [serial, emaid, pem]));
  return {
    emaid, serial, certificatePem: pem, chainPem: pem + ca.mo_sub.pem,
    hashData: [
      { ...hashDataOf(der, ca.mo_sub.der), responderURL: config.pnc.mockOcspUrl },
      { ...hashDataOf(ca.mo_sub.der, ca.mo_root.der), responderURL: config.pnc.mockOcspUrl },
    ],
  };
}

export async function revokeTestContract(serial: string): Promise<boolean> {
  if ((await pkiMode()) !== 'mock') throw new PkiError('Only test contract certificates can be revoked here.');
  const r = await outsideRequestScope(() => query(`UPDATE pnc_mock_contract SET revoked_at = now() WHERE upper(ltrim(serial, '0')) = upper(ltrim($1, '0')) AND revoked_at IS NULL`, [serial]));
  return (r.rowCount ?? 0) > 0;
}

/** For tests: forget the cached CA material (another process may have created it). */
export function resetMockCache() { cached = null; }
