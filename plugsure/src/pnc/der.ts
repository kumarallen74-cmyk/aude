import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify, X509Certificate, type KeyObject } from 'node:crypto';

/**
 * Just enough ASN.1 DER for ISO 15118 Plug & Charge, on Node's own crypto:
 *
 *   - read a PKCS#10 certificate signing request (SignCertificate) and check
 *     its signature;
 *   - build and sign an X.509 certificate (the test PKI, and nothing else);
 *   - the OCPP CertificateHashData of a certificate (issuer name hash, issuer
 *     key hash, serial) — what chargers send in Authorize and
 *     GetCertificateStatus;
 *   - an OCSP request (RFC 6960) for that hash data, and the certificate status
 *     in an OCSP response, with its signature checked;
 *   - an OCSP response (the test PKI's responder).
 *
 * No dependency: the project hand-writes its protocol crypto (see Web Push).
 * Everything here is pure and unit-tested (der.test.ts).
 */

// ------------------------------------------------------------------ encoding

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
export const tlv = (tag: number, content: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), len(content.length), content]);
export const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
export const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
export const nul = () => Buffer.from([0x05, 0x00]);
export const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
export const octet = (b: Buffer) => tlv(0x04, b);
export const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
export const printable = (s: string) => tlv(0x13, Buffer.from(s, 'ascii'));
export const ia5 = (s: string) => tlv(0x16, Buffer.from(s, 'ascii'));
export const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
export const enumerated = (n: number) => tlv(0x0a, Buffer.from([n]));
/** Context-specific tag [n]; constructed (EXPLICIT / a SEQUENCE body) by default. */
export const ctx = (n: number, content: Buffer, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, content);

/** A non-negative INTEGER from big-endian bytes (a serial number) or a small number. */
export function int(v: Buffer | number): Buffer {
  let b: Buffer;
  if (typeof v === 'number') {
    const h = v.toString(16);
    b = Buffer.from(h.length % 2 ? '0' + h : h, 'hex');
  } else b = v;
  let i = 0;
  while (i < b.length - 1 && b[i] === 0 && (b[i + 1]! & 0x80) === 0) i++;
  b = b.subarray(i);
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

export function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

const pad = (n: number) => String(n).padStart(2, '0');
export function utcTime(d: Date): Buffer {
  const s = `${pad(d.getUTCFullYear() % 100)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}
export function generalizedTime(d: Date): Buffer {
  const s = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return tlv(0x18, Buffer.from(s, 'ascii'));
}
/** RFC 5280: UTCTime through 2049, GeneralizedTime after. */
const certTime = (d: Date) => (d.getUTCFullYear() < 2050 ? utcTime(d) : generalizedTime(d));

// ------------------------------------------------------------------ decoding

export interface Node {
  tag: number;
  /** Offset of the tag byte and of the first content byte, and the end, in `buf`. */
  start: number;
  contentStart: number;
  end: number;
  buf: Buffer;
  children: Node[];
}
export const content = (n: Node) => n.buf.subarray(n.contentStart, n.end);
export const raw = (n: Node) => n.buf.subarray(n.start, n.end);

export function parse(buf: Buffer, offset = 0, depth = 0): Node {
  if (depth > 20) throw new Error('DER nested too deeply');
  if (offset + 2 > buf.length) throw new Error('truncated DER');
  const tag = buf[offset]!;
  let l = buf[offset + 1]!;
  let p = offset + 2;
  if (l & 0x80) {
    const nb = l & 0x7f;
    if (nb === 0 || nb > 4 || p + nb > buf.length) throw new Error('bad DER length');
    l = 0;
    for (let i = 0; i < nb; i++) l = l * 256 + buf[p + i]!;
    p += nb;
  }
  const end = p + l;
  if (end > buf.length) throw new Error('truncated DER');
  const node: Node = { tag, start: offset, contentStart: p, end, buf, children: [] };
  if (tag & 0x20) {
    let q = p;
    while (q < end) {
      const child = parse(buf, q, depth + 1);
      node.children.push(child);
      q = child.end;
    }
  }
  return node;
}

export function oidString(n: Node): string {
  const b = content(n);
  const out: number[] = [Math.floor(b[0]! / 40), b[0]! % 40];
  let v = 0;
  for (const x of b.subarray(1)) {
    v = v * 128 + (x & 0x7f);
    if (!(x & 0x80)) { out.push(v); v = 0; }
  }
  return out.join('.');
}

/** The INTEGER's value as hex: no leading zeros, upper case (OCPP serialNumber). */
export function intHex(n: Node): string {
  const h = content(n).toString('hex').replace(/^0+/, '').toUpperCase();
  return h || '0';
}

function timeOf(n: Node): Date {
  const s = content(n).toString('ascii');
  const m = n.tag === 0x17 ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/.exec(s) : /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?(?:\.\d+)?Z$/.exec(s);
  if (!m) throw new Error('bad time');
  const y = n.tag === 0x17 ? (Number(m[1]) < 50 ? 2000 : 1900) + Number(m[1]) : Number(m[1]);
  return new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
}

// ------------------------------------------------------------------ names

export const OID = {
  CN: '2.5.4.3', O: '2.5.4.10', OU: '2.5.4.11', C: '2.5.4.6', DC: '0.9.2342.19200300.100.1.25',
  ecPublicKey: '1.2.840.10045.2.1', ecdsaSha256: '1.2.840.10045.4.3.2', sha256WithRSA: '1.2.840.113549.1.1.11',
  sha256: '2.16.840.1.101.3.4.2.1', sha384: '2.16.840.1.101.3.4.2.2', sha512: '2.16.840.1.101.3.4.2.3',
  basicConstraints: '2.5.29.19', keyUsage: '2.5.29.15', ski: '2.5.29.14', aki: '2.5.29.35', aia: '1.3.6.1.5.5.7.1.1',
  ocsp: '1.3.6.1.5.5.7.48.1', ocspBasic: '1.3.6.1.5.5.7.48.1.1',
  eku: '2.5.29.37', clientAuth: '1.3.6.1.5.5.7.3.2', serverAuth: '1.3.6.1.5.5.7.3.1',
} as const;
const SHORT: Record<string, string> = { [OID.CN]: 'CN', [OID.O]: 'O', [OID.OU]: 'OU', [OID.C]: 'C', [OID.DC]: 'DC' };

export type NameAttr = [keyof typeof SHORT_REV, string];
const SHORT_REV = { CN: OID.CN, O: OID.O, OU: OID.OU, C: OID.C, DC: OID.DC } as const;

/** Build an X.501 Name, e.g. name([['C','ID'],['O','PlugSure'],['CN','...']]). */
export function name(attrs: Array<[keyof typeof SHORT_REV, string]>): Buffer {
  return seq(...attrs.map(([k, v]) => set(seq(oid(SHORT_REV[k]), k === 'C' ? printable(v) : k === 'DC' ? ia5(v) : utf8(v)))));
}

/** A Name as its attributes, and as 'C=ID, O=..., CN=...'. */
export function readName(n: Node): { attrs: Array<[string, string]>; text: string } {
  const attrs: Array<[string, string]> = [];
  for (const rdn of n.children) {
    for (const atv of rdn.children) {
      const [o, v] = atv.children;
      if (!o || !v) continue;
      attrs.push([SHORT[oidString(o)] ?? oidString(o), content(v).toString('utf8')]);
    }
  }
  return { attrs, text: attrs.map(([k, v]) => `${k}=${v}`).join(', ') };
}

// ------------------------------------------------------------------ PEM

export function pemToDer(pem: string): Buffer {
  const m = /-----BEGIN [A-Z ]+-----([\s\S]*?)-----END [A-Z ]+-----/.exec(pem);
  if (!m) throw new Error('not a PEM block');
  return Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64');
}
export function derToPem(der: Buffer, label = 'CERTIFICATE'): string {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}
/** Every certificate in a PEM bundle, leaf first as given. */
export function splitPemChain(pem: string): string[] {
  return (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []).map((p) => p + '\n');
}

// ------------------------------------------------------------------ CSR (PKCS#10)

export interface Csr {
  subject: Array<[string, string]>;
  subjectText: string;
  subjectDer: Buffer;
  spkiDer: Buffer;
  publicKey: KeyObject;
  keyType: string;
}

/** Parse a certificate signing request (PEM or base64 DER) and check its self-signature. */
export function parseCsr(input: string): Csr {
  const der = /-----BEGIN/.test(input) ? pemToDer(input) : Buffer.from(input.replace(/\s+/g, ''), 'base64');
  const root = parse(der);
  const [info, alg, sig] = root.children;
  if (root.tag !== 0x30 || !info || !alg || !sig || sig.tag !== 0x03) throw new Error('not a certificate signing request');
  const [, subject, spki] = info.children;
  if (!subject || !spki) throw new Error('not a certificate signing request');
  const publicKey = createPublicKey({ key: raw(spki), format: 'der', type: 'spki' });
  const algOid = oidString(alg.children[0]!);
  if (algOid !== OID.ecdsaSha256 && algOid !== OID.sha256WithRSA) throw new Error(`unsupported signature algorithm ${algOid}`);
  const ok = cryptoVerify('sha256', raw(info), publicKey, content(sig).subarray(1));
  if (!ok) throw new Error('the request signature does not verify');
  const n = readName(subject);
  return { subject: n.attrs, subjectText: n.text, subjectDer: Buffer.from(raw(subject)), spkiDer: Buffer.from(raw(spki)), publicKey, keyType: publicKey.asymmetricKeyType ?? '?' };
}

/** Build a PKCS#10 request (what a charger sends in SignCertificate). PEM. */
export function buildCsr(subject: Buffer, keys: { publicKey: KeyObject; privateKey: KeyObject }): string {
  const spki = keys.publicKey.export({ type: 'spki', format: 'der' });
  const info = seq(int(0), subject, spki, ctx(0, Buffer.alloc(0)));
  const der = seq(info, seq(oid(OID.ecdsaSha256)), bits(cryptoSign('sha256', info, keys.privateKey)));
  return derToPem(der, 'CERTIFICATE REQUEST');
}

// ------------------------------------------------------------------ certificates

/** The subjectPublicKey BIT STRING's key bytes (what issuerKeyHash and key identifiers hash). */
export function publicKeyBits(spkiDer: Buffer): Buffer {
  const n = parse(spkiDer);
  const b = n.children[1];
  if (!b || b.tag !== 0x03) throw new Error('bad SubjectPublicKeyInfo');
  return Buffer.from(content(b).subarray(1));
}

export interface CertSpec {
  serial: Buffer;
  issuer: Buffer;
  subject: Buffer;
  spki: Buffer;
  notBefore: Date;
  notAfter: Date;
  ca?: { pathLen?: number };
  /** Issuer's SubjectPublicKeyInfo, for the authority key identifier (omit when self-signed). */
  issuerSpki?: Buffer;
  ocspUrl?: string;
  signKey: KeyObject;
  /** Key usage of a leaf: 'v2g' (digitalSignature + keyAgreement, the default), or a TLS client key by its type. */
  leafUsage?: 'v2g' | 'tls-ec' | 'tls-rsa';
  /** Extended key usage OIDs, e.g. OID.clientAuth. */
  eku?: string[];
}

function ext(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [bool(true)] : []), octet(value));
}

/** Build and sign an X.509 v3 certificate (ECDSA with SHA-256). Returns DER. */
export function buildCertificate(s: CertSpec): Buffer {
  const alg = seq(oid(OID.ecdsaSha256));
  const keyId = (spki: Buffer) => createHash('sha1').update(publicKeyBits(spki)).digest();
  const exts = [
    ext(OID.basicConstraints, true, s.ca ? seq(bool(true), ...(s.ca.pathLen != null ? [int(s.ca.pathLen)] : [])) : seq()),
    // CA: keyCertSign + cRLSign. Leaf (V2G SECC, contract): digitalSignature + keyAgreement.
    ext(OID.keyUsage, true, s.ca ? bits(Buffer.from([0x06]), 1)
      : s.leafUsage === 'tls-ec' ? bits(Buffer.from([0x80]), 7) // digitalSignature
      : s.leafUsage === 'tls-rsa' ? bits(Buffer.from([0xa0]), 5) // digitalSignature + keyEncipherment
      : bits(Buffer.from([0x88]), 3)),
    ...(s.eku?.length ? [ext(OID.eku, false, seq(...s.eku.map((o) => oid(o))))] : []),
    ext(OID.ski, false, octet(keyId(s.spki))),
    ext(OID.aki, false, seq(tlv(0x80, keyId(s.issuerSpki ?? s.spki)))),
    ...(s.ocspUrl ? [ext(OID.aia, false, seq(seq(oid(OID.ocsp), tlv(0x86, Buffer.from(s.ocspUrl, 'ascii')))))] : []),
  ];
  const tbs = seq(
    ctx(0, int(2)),
    int(s.serial),
    alg,
    s.issuer,
    seq(certTime(s.notBefore), certTime(s.notAfter)),
    s.subject,
    s.spki,
    ctx(3, seq(...exts)),
  );
  const signature = cryptoSign('sha256', tbs, s.signKey);
  return seq(tbs, alg, bits(signature));
}

export interface CertInfo {
  subject: string;
  subjectAttrs: Array<[string, string]>;
  issuer: string;
  serial: string;
  notBefore: Date;
  notAfter: Date;
  fingerprint: string;
  issuerNameDer: Buffer;
  spkiDer: Buffer;
  ocspUrl: string | null;
  isCa: boolean;
}

/** A certificate's subject Name, as DER (the issuer Name of what it signs). */
export function certSubjectDer(certDer: Buffer): Buffer {
  const tbs = parse(certDer).children[0]!;
  const f = tbs.children[0]?.tag === 0xa0 ? tbs.children.slice(1) : tbs.children;
  return Buffer.from(raw(f[4]!));
}

/** The fields Plug & Charge needs from a certificate (PEM or DER). */
export function certInfo(input: string | Buffer): CertInfo {
  const der = typeof input === 'string' ? pemToDer(input) : input;
  const root = parse(der);
  const tbs = root.children[0]!;
  const f = tbs.children[0]?.tag === 0xa0 ? tbs.children.slice(1) : tbs.children;
  const [serial, , issuer, validity, subject, spki] = f;
  if (!serial || !issuer || !validity || !subject || !spki) throw new Error('not an X.509 certificate');
  const x = new X509Certificate(der);
  const s = readName(subject);
  const aia = /OCSP - URI:(\S+)/.exec(x.infoAccess ?? '');
  return {
    subject: s.text,
    subjectAttrs: s.attrs,
    issuer: readName(issuer).text,
    serial: intHex(serial),
    notBefore: timeOf(validity.children[0]!),
    notAfter: timeOf(validity.children[1]!),
    fingerprint: x.fingerprint256.replace(/:/g, '').toLowerCase(),
    issuerNameDer: Buffer.from(raw(issuer)),
    spkiDer: Buffer.from(raw(spki)),
    ocspUrl: aia?.[1] ?? null,
    isCa: x.ca,
  };
}

// ------------------------------------------------------------------ OCPP CertificateHashData

export type HashAlgorithm = 'SHA256' | 'SHA384' | 'SHA512';
export interface CertificateHashData {
  hashAlgorithm: HashAlgorithm;
  issuerNameHash: string;
  issuerKeyHash: string;
  serialNumber: string;
}
const NODE_HASH: Record<HashAlgorithm, string> = { SHA256: 'sha256', SHA384: 'sha384', SHA512: 'sha512' };
const HASH_OID: Record<HashAlgorithm, string> = { SHA256: OID.sha256, SHA384: OID.sha384, SHA512: OID.sha512 };

/** CertificateHashData of `cert` issued by `issuer` (the issuer's key is hashed). */
export function hashDataOf(cert: string | Buffer, issuer: string | Buffer, alg: HashAlgorithm = 'SHA256'): CertificateHashData {
  const c = certInfo(cert);
  const i = certInfo(issuer);
  const h = (b: Buffer) => createHash(NODE_HASH[alg]).update(b).digest('hex');
  return { hashAlgorithm: alg, issuerNameHash: h(c.issuerNameDer), issuerKeyHash: h(publicKeyBits(i.spkiDer)), serialNumber: c.serial };
}

export const sameSerial = (a: string, b: string) => a.replace(/^0+/, '').toUpperCase() === b.replace(/^0+/, '').toUpperCase();

// ------------------------------------------------------------------ OCSP (RFC 6960)

function certId(h: CertificateHashData): Buffer {
  return seq(seq(oid(HASH_OID[h.hashAlgorithm]), nul()), octet(Buffer.from(h.issuerNameHash, 'hex')), octet(Buffer.from(h.issuerKeyHash, 'hex')), int(Buffer.from(h.serialNumber.length % 2 ? '0' + h.serialNumber : h.serialNumber, 'hex')));
}

/** An OCSPRequest for one certificate (no nonce, unsigned — what responders expect). */
export function ocspRequest(h: CertificateHashData): Buffer {
  return seq(seq(seq(seq(certId(h)))));
}

/** Read the certificate identified in an OCSPRequest (the test responder). */
export function readOcspRequest(der: Buffer): CertificateHashData {
  const r = parse(der);
  const cid = r.children[0]?.children.find((c) => c.tag === 0x30)?.children[0]?.children[0];
  if (!cid) throw new Error('not an OCSP request');
  const [alg, nameHash, keyHash, serial] = cid.children;
  const algOid = oidString(alg!.children[0]!);
  const hashAlgorithm = (Object.keys(HASH_OID) as HashAlgorithm[]).find((k) => HASH_OID[k] === algOid) ?? 'SHA256';
  return { hashAlgorithm, issuerNameHash: content(nameHash!).toString('hex'), issuerKeyHash: content(keyHash!).toString('hex'), serialNumber: intHex(serial!) };
}

export type OcspCertStatus = 'good' | 'revoked' | 'unknown';

/** Build a signed OCSP response (the test PKI's responder, which is the issuing CA). */
export function ocspResponse(h: CertificateHashData, status: OcspCertStatus, signer: { key: KeyObject; spkiDer: Buffer }, at = new Date(), revokedAt?: Date): Buffer {
  const alg = seq(oid(OID.ecdsaSha256));
  const certStatus = status === 'good' ? tlv(0x80, Buffer.alloc(0)) : status === 'revoked' ? ctx(1, generalizedTime(revokedAt ?? at)) : tlv(0x82, Buffer.alloc(0));
  const single = seq(certId(h), certStatus, generalizedTime(at), ctx(0, generalizedTime(new Date(at.getTime() + 24 * 3600_000))));
  const responderId = ctx(2, octet(createHash('sha1').update(publicKeyBits(signer.spkiDer)).digest()));
  const tbs = seq(responderId, generalizedTime(at), seq(single));
  const basic = seq(tbs, alg, bits(cryptoSign('sha256', tbs, signer.key)));
  return seq(enumerated(0), ctx(0, seq(oid(OID.ocspBasic), octet(basic))));
}

export interface OcspResult {
  /** 'successful' or the responder's error (malformedRequest, tryLater, unauthorized…). */
  responseStatus: string;
  status: OcspCertStatus | null;
  revokedAt?: Date;
  thisUpdate?: Date;
  nextUpdate?: Date;
  /** The response signature verified with one of the keys given (issuer, or a responder certificate it issued). */
  signatureValid: boolean | null;
}
const RESPONSE_STATUS = ['successful', 'malformedRequest', 'internalError', 'tryLater', '4', 'sigRequired', 'unauthorized'];

/**
 * The status of the certificate `h` in an OCSP response. `trusted` are public
 * keys allowed to sign it: the issuer's, normally. A responder certificate
 * embedded in the response is accepted when the issuer signed it.
 */
export function readOcspResponse(der: Buffer, h: CertificateHashData, trusted: KeyObject[] = []): OcspResult {
  const r = parse(der);
  const code = content(r.children[0]!)[0] ?? 2;
  const responseStatus = RESPONSE_STATUS[code] ?? String(code);
  if (code !== 0) return { responseStatus, status: null, signatureValid: null };
  const bytes = r.children[1]?.children[0]?.children[1];
  if (!bytes) throw new Error('OCSP response without a body');
  const basic = parse(content(bytes));
  const [tbs, , sig, certs] = basic.children;
  // tbsResponseData: [0] version?, responderID ([1]/[2]), producedAt, responses, [1] extensions?
  const responses = tbs!.children.find((c) => c.tag === 0x30);
  let found: OcspResult | null = null;
  for (const single of responses?.children ?? []) {
    const [cid, st, thisUpd, next] = single.children;
    const [, nameHash, keyHash, serial] = cid!.children;
    if (content(nameHash!).toString('hex') !== h.issuerNameHash.toLowerCase() || content(keyHash!).toString('hex') !== h.issuerKeyHash.toLowerCase() || !sameSerial(intHex(serial!), h.serialNumber)) continue;
    const status: OcspCertStatus = st!.tag === 0x80 ? 'good' : st!.tag === 0xa1 ? 'revoked' : 'unknown';
    found = {
      responseStatus,
      status,
      ...(status === 'revoked' ? { revokedAt: timeOf(st!.children[0]!) } : {}),
      thisUpdate: timeOf(thisUpd!),
      ...(next?.tag === 0xa0 ? { nextUpdate: timeOf(next.children[0]!) } : {}),
      signatureValid: null,
    };
    break;
  }
  if (!found) return { responseStatus, status: 'unknown', signatureValid: null };
  // Signature: by a trusted key, or by a responder certificate a trusted key issued.
  const keys = [...trusted];
  for (const c of certs?.children[0]?.children ?? []) {
    try {
      const x = new X509Certificate(raw(c));
      if (trusted.some((k) => x.verify(k))) keys.push(x.publicKey);
    } catch { /* not a certificate */ }
  }
  if (keys.length) {
    const sigBytes = content(sig!).subarray(1);
    found.signatureValid = keys.some((k) => {
      try { return cryptoVerify('sha256', raw(tbs!), k, sigBytes); } catch { return false; }
    });
  }
  return found;
}
