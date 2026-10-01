import { createHash, X509Certificate } from 'node:crypto';
import { certConstraints, certInfo, certSubjectDer, hashDataOf, KU_KEY_CERT_SIGN, publicKeyBits, splitPemChain, type CertificateHashData } from './der.js';
import { normaliseEmaid, formatEmaid } from './emaid.js';

/**
 * Certificate path checks for Plug & Charge contract certificates. Pure (no
 * database, no network): the service supplies the operator's MO roots.
 *
 * Node's X509Certificate.checkIssued is a NAME match plus one keyUsage rule
 * (an issuer whose keyUsage is present must have keyCertSign). It does not look
 * at basicConstraints at all, so an END-ENTITY certificate with no keyUsage
 * passed as an issuer: a reviewer took a contract-style certificate issued
 * under the MO root (CA:FALSE, no keyUsage), signed a certificate for any eMAID
 * with its key, and the chain "validated" to the MO root. Every issuer on the
 * path must now be a CA (basicConstraints cA TRUE), carry keyCertSign when it
 * has a keyUsage, and allow the number of CA certificates below it
 * (pathLenConstraint).
 */

export type CertStatus = 'Accepted' | 'SignatureError' | 'CertificateExpired' | 'CertificateRevoked' | 'NoCertificateAvailable' | 'CertChainError' | 'ContractCancelled';

const fp = (x: X509Certificate) => x.fingerprint256;
const inForce = (x: X509Certificate, now: Date) => new Date(x.validFrom) <= now && new Date(x.validTo) >= now;
const issued = (child: X509Certificate, parent: X509Certificate) => {
  try { return child.checkIssued(parent) && child.verify(parent.publicKey); } catch { return false; }
};

/**
 * Why this list of ISSUERS cannot issue what is below it, or null.
 * `issuers[0]` signed the end-entity certificate, `issuers[j]` has j CA
 * certificates between it and the end entity, so its pathLenConstraint must be
 * at least j (RFC 5280 4.2.1.9).
 */
export function issuerPathProblem(issuers: X509Certificate[], now = new Date()): string | null {
  for (const [j, x] of issuers.entries()) {
    let c;
    try { c = certConstraints(x.raw); } catch { return `issuer ${j + 1} cannot be read`; }
    const who = certInfo(x.raw).subject || `issuer ${j + 1}`;
    if (!c.ca) return `${who} is not a CA certificate (basicConstraints cA is not TRUE) and cannot issue certificates`;
    if (c.keyUsage !== null && !(c.keyUsage & KU_KEY_CERT_SIGN)) return `${who} is not allowed to sign certificates (keyUsage without keyCertSign)`;
    if (c.pathLen !== null && j > c.pathLen) return `${who} allows ${c.pathLen} CA certificate(s) below it; the chain has ${j}`;
    if (!inForce(x, now)) return `${who} is expired or not yet valid`;
  }
  return null;
}

export interface ContractChainResult {
  status: CertStatus;
  why?: string;
  /** For OCSP: each presented certificate below the anchor, with its issuer (DER) and responder. */
  revocation?: Array<{ hashData: CertificateHashData; responderURL: string | null; issuer: X509Certificate; serial: string }>;
}

/** Check a contract chain presented to the CSMS: leaf first, up to one of the operator's MO roots. */
export function checkContractChain(pem: string, emaid: string, roots: X509Certificate[], now = new Date()): ContractChainResult {
  let certs: X509Certificate[];
  try { certs = splitPemChain(pem).map((p) => new X509Certificate(p)); } catch { return { status: 'CertChainError', why: 'the certificate cannot be read' }; }
  if (!certs.length) return { status: 'NoCertificateAvailable', why: 'no certificate in the request' };
  if (certs.length > 5) return { status: 'CertChainError', why: 'the chain is longer than ISO 15118 allows' };
  if (certs.some((c) => !inForce(c, now))) return { status: 'CertificateExpired', why: 'a certificate in the chain is expired or not yet valid' };
  const cn = certInfo(certs[0]!.raw).subjectAttrs.find(([k]) => k === 'CN')?.[1] ?? '';
  if (normaliseEmaid(cn) !== emaid) return { status: 'CertChainError', why: `the certificate is for ${cn || 'no contract'}, not ${formatEmaid(emaid)}` };
  if (!roots.length) return { status: 'CertChainError', why: 'no MO root certificate is installed (Plug & Charge → Trust anchors)' };
  // Every link signed by the next; the last by a trusted root (or the last IS a trusted root).
  for (let i = 0; i < certs.length - 1; i++) {
    if (!issued(certs[i]!, certs[i + 1]!)) return { status: 'SignatureError', why: 'the chain does not verify' };
  }
  const top = certs[certs.length - 1]!;
  const topIsRoot = roots.some((r) => fp(r) === fp(top));
  const anchor = topIsRoot ? top : roots.find((r) => issued(top, r));
  if (!anchor) return { status: 'CertChainError', why: 'the chain does not lead to an installed MO root' };
  const path = topIsRoot ? certs : [...certs, anchor];
  // The contract certificate is an end entity; everything above it must be a CA allowed to issue.
  if (certConstraints(path[0]!.raw).ca) return { status: 'CertChainError', why: 'the contract certificate is a CA certificate' };
  const why = issuerPathProblem(path.slice(1), now);
  if (why) return { status: 'CertChainError', why };
  const revocation = path.slice(0, -1).map((c, i) => ({
    hashData: hashDataOf(c.raw, path[i + 1]!.raw),
    responderURL: certInfo(c.raw).ocspUrl,
    issuer: path[i + 1]!,
    serial: certInfo(c.raw).serial,
  }));
  return { status: 'Accepted', revocation };
}

const NODE_HASH = { SHA256: 'sha256', SHA384: 'sha384', SHA512: 'sha512' } as const;

/**
 * The issuer named by OCPP hash data, as a certificate we can trust: one whose
 * key and subject hash to issuerKeyHash / issuerNameHash, that is an MO root or
 * chains to one through `pool` (certificates the OCSP response carried), with
 * every certificate on that path a CA allowed to issue. Null when there is none —
 * the CSMS then cannot tell a genuine OCSP answer from one the charger's chosen
 * responder made up, and must not accept it.
 */
export function trustedIssuerFor(h: CertificateHashData, pool: X509Certificate[], roots: X509Certificate[], now = new Date()): X509Certificate | null {
  const alg = NODE_HASH[h.hashAlgorithm] ?? 'sha256';
  const hash = (b: Buffer) => createHash(alg).update(b).digest('hex');
  const matches = (x: X509Certificate) => {
    try {
      return hash(publicKeyBits(certInfo(x.raw).spkiDer)) === String(h.issuerKeyHash).toLowerCase()
        && hash(certSubjectDer(x.raw)) === String(h.issuerNameHash).toLowerCase();
    } catch { return false; }
  };
  for (const cand of [...roots, ...pool].filter(matches)) {
    // Build the path upward: cand → … → an MO root, at most four steps.
    const path = [cand];
    let anchored = roots.some((r) => fp(r) === fp(cand));
    while (!anchored && path.length <= 4) {
      const cur = path[path.length - 1]!;
      const root = roots.find((r) => issued(cur, r));
      if (root) { path.push(root); anchored = true; break; }
      const next = pool.find((p) => !path.some((q) => fp(q) === fp(p)) && issued(cur, p));
      if (!next) break;
      path.push(next);
    }
    if (anchored && issuerPathProblem(path, now) === null) return cand;
  }
  return null;
}
