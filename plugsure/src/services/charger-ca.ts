import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, X509Certificate, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { many, one, outsideRequestScope, query, tx } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { bus } from './events.js';
import { seal, unseal } from './secrets.js';
import { writeAudit } from './audit.js';
import { setSecurityProfile, tlsAvailable } from './chargepoint-keys.js';
import { buildCertificate, certInfo, certSubjectDer, derToPem, name, OID, parseCsr, pemToDer } from '../pnc/der.js';

/**
 * PlugSure's charging-station CA: automatic client certificates for OCPP
 * Security Profile 3 (mutual TLS).
 *
 * Three ways a charger gets its certificate, all ending with the certificate's
 * SHA-256 fingerprint bound to that one charger (what the gateway checks):
 *   1. At onboarding, PlugSure generates the key and certificate; the bundle
 *      (client.crt, client.key, ca.pem) is downloaded once and loaded onto the
 *      charger. The key is never stored.
 *   2. At onboarding, the charger's own certificate signing request (CSR) is
 *      pasted in and signed. The key never leaves the charger.
 *   3. Over OCPP (1.6 Security Whitepaper / 2.0.1): the charger connects on
 *      Profile 2, PlugSure asks it for a CSR (ExtendedTriggerMessage /
 *      TriggerMessage), signs it and installs it with CertificateSigned. The
 *      charger is then moved to Profile 3. The same path renews it.
 *
 * The CA is created on first use (ECDSA P-256, 20 years; its key sealed with
 * SECRETS_KEY), or an operator's own CA is used (CHARGER_CA_CERT_FILE +
 * CHARGER_CA_KEY_FILE). The TLS terminator must trust it: download it from
 * Onboarding → Certificate authority.
 *
 * The subject follows the OCPP security specification: CN = the charge point
 * identity, O = the operator. A CSR whose CN is not the charger's identity is
 * refused, so one charger cannot obtain another's certificate.
 */

export class CertificateError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export type KeyType = 'ec' | 'rsa';
interface Ca { pem: string; key: KeyObject; der: Buffer; subject: Buffer; spki: Buffer; source: 'builtin' | 'file' }
let cached: Ca | null = null;
const YEAR = 365 * 24 * 3600_000;

/** The CA that signs charger certificates. */
export async function chargerCa(): Promise<Ca> {
  if (cached) return cached;
  let certPem: string, keyPem: string, source: Ca['source'];
  if (config.chargerCa.certPath && config.chargerCa.keyPath) {
    certPem = readFileSync(config.chargerCa.certPath, 'utf8');
    keyPem = readFileSync(config.chargerCa.keyPath, 'utf8');
    source = 'file';
  } else {
    // Outside any request transaction: the gateway (another process) must see it at once.
    const row = await outsideRequestScope(() => tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(3002)`);
      const have = (await c.query(`SELECT cert_pem, key_sealed FROM platform_ca WHERE name = 'charging_station_ca'`)).rows[0];
      if (have) return have as { cert_pem: string; key_sealed: string };
      const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const subject = name([['C', 'ID'], ['O', config.billing.issuerName.slice(0, 64)], ['CN', 'PlugSure Charging Station CA']]);
      const spki = k.publicKey.export({ type: 'spki', format: 'der' });
      const der = buildCertificate({
        serial: randomBytes(12), issuer: subject, subject, spki, notBefore: new Date(Date.now() - 3600_000), notAfter: new Date(Date.now() + 20 * YEAR),
        ca: { pathLen: 0 }, signKey: k.privateKey,
      });
      const r = { cert_pem: derToPem(der), key_sealed: seal(k.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string) };
      await c.query(`INSERT INTO platform_ca (name, cert_pem, key_sealed) VALUES ('charging_station_ca', $1, $2)`, [r.cert_pem, r.key_sealed]);
      logger.warn('created the PlugSure charging-station CA — give ca.pem to the TLS terminator (Onboarding → Certificate authority)');
      return r;
    }));
    certPem = row.cert_pem;
    keyPem = unseal(row.key_sealed);
    source = 'builtin';
  }
  const der = pemToDer(certPem);
  const x = new X509Certificate(der);
  if (!x.ca) throw new Error('the charger CA certificate is not a CA certificate');
  cached = { pem: derToPem(der), key: createPrivateKey(keyPem), der, subject: certSubjectDer(der), spki: certInfo(der).spkiDer, source };
  return cached;
}

/** What the console and the TLS terminator need to know about the CA. */
export async function caInfo() {
  const ca = await chargerCa();
  const i = certInfo(ca.der);
  let csmsRoot: string | null = null;
  if (config.chargerCa.csmsRootPath) { try { csmsRoot = readFileSync(config.chargerCa.csmsRootPath, 'utf8'); } catch { csmsRoot = null; } }
  return {
    source: ca.source,
    subject: i.subject,
    fingerprint: i.fingerprint,
    notAfter: i.notAfter,
    certificatePem: ca.pem,
    certificateDays: config.chargerCa.certDays,
    csmsRootPem: csmsRoot,
    proxy: {
      caddy: `tls {\n  client_auth {\n    mode verify_if_given\n    trusted_ca_cert_file /etc/caddy/plugsure-charger-ca.pem\n  }\n}\n# inside reverse_proxy — an assignment, so a charger cannot forge it:\nheader_up X-Client-Cert-Fingerprint {http.request.tls.client.fingerprint}`,
      gateway: 'When the gateway terminates TLS itself (OCPP_TLS_CERT_PATH / OCPP_TLS_KEY_PATH), it already trusts this CA; no configuration is needed.',
    },
  };
}

// ================================================================== issuing

export interface Issued {
  certificatePem: string;
  privateKeyPem: string | null;
  caPem: string;
  chainPem: string;
  fingerprint: string;
  serial: string;
  notAfter: Date;
  subject: string;
  keyType: string;
}

function keyTypeOf(k: KeyObject): string {
  const d = k.asymmetricKeyDetails ?? {};
  return k.asymmetricKeyType === 'ec' ? `ECDSA ${d.namedCurve ?? ''}`.trim() : k.asymmetricKeyType === 'rsa' ? `RSA ${d.modulusLength ?? ''}`.trim() : String(k.asymmetricKeyType);
}

/** OCPP: RSA of at least 2048 bits, or ECDSA P-256 / P-384. */
function keyProblem(k: KeyObject): string | null {
  const d = k.asymmetricKeyDetails ?? {};
  if (k.asymmetricKeyType === 'rsa') return (d.modulusLength ?? 0) >= 2048 ? null : 'RSA keys must be at least 2048 bits';
  if (k.asymmetricKeyType === 'ec') return ['prime256v1', 'secp384r1'].includes(String(d.namedCurve)) ? null : 'EC keys must be P-256 or P-384';
  return `unsupported key type ${k.asymmetricKeyType}`;
}

/** `country`: the organisation's home country, the leaf's C= (§D11; the platform CA keeps C=ID). */
async function signFor(identity: string, orgName: string, spki: Buffer, subjectDer: Buffer | null, days: number, country = 'ID') {
  const ca = await chargerCa();
  const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const why = keyProblem(pub);
  if (why) throw new CertificateError(422, why);
  const subject = subjectDer ?? name([['C', country], ['O', orgName.slice(0, 64) || 'PlugSure'], ['CN', identity]]);
  const der = buildCertificate({
    serial: randomBytes(12), issuer: ca.subject, subject, spki, issuerSpki: ca.spki,
    notBefore: new Date(Date.now() - 5 * 60_000), notAfter: new Date(Date.now() + days * 24 * 3600_000),
    signKey: ca.key, leafUsage: pub.asymmetricKeyType === 'rsa' ? 'tls-rsa' : 'tls-ec', eku: [OID.clientAuth],
  });
  const info = certInfo(der);
  return { der, pem: derToPem(der), info, ca, keyType: keyTypeOf(pub) };
}

/** Check a charger's CSR: well formed, self-signed, for THIS charger, with an allowed key. */
export function checkStationCsr(csrPem: string, identity: string) {
  let csr;
  try { csr = parseCsr(csrPem); } catch (e) { throw new CertificateError(422, `The certificate request cannot be used: ${(e as Error).message}`); }
  const cn = csr.subject.find(([k]) => k === 'CN')?.[1] ?? '';
  if (cn !== identity) throw new CertificateError(422, `The request is for "${cn || 'no CN'}", not for ${identity}. The CN must be the charge point identity.`);
  const why = keyProblem(csr.publicKey);
  if (why) throw new CertificateError(422, why);
  return csr;
}

/**
 * Issue a certificate for a charger at onboarding: with a key generated here
 * (returned once, never stored), or for the charger's own CSR. Binds its
 * fingerprint to the charger.
 */
export async function issueAtOnboarding(chargePointId: string, opts: { keyType?: KeyType; csr?: string; days?: number }, actor: { type: 'user' | 'api_client' | 'system'; id?: string; orgId?: string; ip?: string }): Promise<Issued> {
  const cp = await one<{ ocpp_identity: string; org_id: string; org_name: string; home_country_code: string }>(
    `SELECT cp.ocpp_identity, s.org_id, o.name AS org_name, o.home_country_code FROM charge_point cp JOIN site s ON s.id = cp.site_id JOIN organisation o ON o.id = s.org_id WHERE cp.id = $1`,
    [chargePointId],
  );
  if (!cp) throw new CertificateError(404, 'charge point not found');
  const days = Math.round(Number(opts.days ?? config.chargerCa.certDays));
  if (!(days >= 30 && days <= 3650)) throw new CertificateError(422, 'validity must be 30–3650 days');
  let privateKeyPem: string | null = null;
  let spki: Buffer, subject: Buffer | null = null;
  if (opts.csr && opts.csr.trim()) {
    const csr = checkStationCsr(opts.csr, cp.ocpp_identity);
    spki = csr.spkiDer; subject = csr.subjectDer;
  } else {
    const k = opts.keyType === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    spki = k.publicKey.export({ type: 'spki', format: 'der' });
    privateKeyPem = k.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  }
  const s = await signFor(cp.ocpp_identity, cp.org_name, spki, subject, days, cp.home_country_code);
  const source = opts.csr ? 'plugsure_ca_csr' : 'plugsure_ca';
  await query(
    `UPDATE charge_point SET client_cert_fingerprint = $2, client_cert_prev_fingerprint = NULL, client_cert_serial = $3,
            client_cert_not_after = $4, client_cert_source = $5 WHERE id = $1`,
    [chargePointId, s.info.fingerprint, s.info.serial, s.info.notAfter, source],
  );
  await recordCertificate(cp.org_id, chargePointId, 'issued', s, source);
  await writeAudit({
    orgId: actor.orgId ?? cp.org_id, actorType: actor.type, actorId: actor.id ?? null, action: 'charge_point.client_cert.issued',
    targetType: 'charge_point', targetId: cp.ocpp_identity, ip: actor.ip ?? null,
    after: { source, serial: s.info.serial, fingerprint: s.info.fingerprint, notAfter: s.info.notAfter, keyType: s.keyType },
  });
  return {
    certificatePem: s.pem, privateKeyPem, caPem: s.ca.pem, chainPem: s.pem + s.ca.pem, fingerprint: s.info.fingerprint,
    serial: s.info.serial, notAfter: s.info.notAfter, subject: s.info.subject, keyType: s.keyType,
  };
}

async function recordCertificate(orgId: string, chargePointId: string, state: string, s: Awaited<ReturnType<typeof signFor>>, source: string, extra: { id?: string } = {}) {
  if (extra.id) {
    await query(
      `UPDATE pnc_certificate SET state = $2, subject = $3, serial = $4, fingerprint = $5, not_before = $6, not_after = $7, chain_pem = $8, key_type = $9, source = $10 WHERE id = $1`,
      [extra.id, state, s.info.subject, s.info.serial, s.info.fingerprint, s.info.notBefore, s.info.notAfter, s.pem + s.ca.pem, s.keyType, source],
    );
    return;
  }
  await query(
    `INSERT INTO pnc_certificate (org_id, charge_point_id, certificate_type, state, subject, serial, fingerprint, not_before, not_after, chain_pem, key_type, source, delivered_at)
     VALUES ($1,$2,'ChargingStationCertificate',$3,$4,$5,$6,$7,$8,$9,$10,$11, now())`,
    [orgId, chargePointId, state, s.info.subject, s.info.serial, s.info.fingerprint, s.info.notBefore, s.info.notAfter, s.pem + s.ca.pem, s.keyType, source],
  );
}

// ================================================================== over OCPP (the charger keeps its key)

interface Ctx {
  ocppIdentity: string;
  chargePointId: string;
  orgId: string;
  /**
   * The OCPP Security Profile this CONNECTION was authenticated at (set by the
   * gateway when the WebSocket is accepted): 3 = mutual TLS, 2 = Basic auth over
   * TLS, 1 = Basic auth in clear, 0 = no credential. Unknown is treated as 0.
   */
  securityProfile?: number | null;
}

/** How long a platform request for a station CSR stays open. */
export const STATION_CSR_REQUEST_TTL_MS = 15 * 60_000;
/** Station certificates signed per charger in any 24 hours, whatever asked for them. */
export const STATION_CSR_MAX_PER_DAY = 3;

/** The Security Profile a connection was authenticated at; unknown counts as 0 (refuse). */
export function connectionProfile(ctx: { securityProfile?: unknown }): number {
  const p = Number(ctx.securityProfile);
  return Number.isInteger(p) && p >= 0 && p <= 3 ? p : 0;
}

/**
 * Whether a station CSR may be signed — pure, for onStationCsr and its tests.
 *
 *   - the connection is authenticated AND encrypted (Security Profile 2 or 3):
 *     on Profile 0/1 the identity is unauthenticated or its key travels in
 *     clear, so anyone who can claim the identity would get a client
 *     certificate the TLS terminator trusts — i.e. a permanent Profile 3
 *     credential for someone else's charger;
 *   - PlugSure asked for it: a request (zero-touch upgrade, renewal, operator)
 *     is open, or the certificate PlugSure's CA issued is inside its renewal
 *     window (OCPP 2.0.1 lets a station start its own renewal);
 *   - at most STATION_CSR_MAX_PER_DAY signings per charger per day.
 */
export function stationCsrRefusal(s: {
  profile: number;
  requestOpen: boolean;
  renewalDue: boolean;
  signedLastDay: number;
}): string | null {
  if (s.profile < 2) return `the connection is on Security Profile ${s.profile}; a station certificate is only issued over an authenticated TLS connection (Profile 2 or 3)`;
  if (!s.requestOpen && !s.renewalDue) return 'PlugSure did not ask this charger for a certificate request (no open request and no renewal due)';
  if (s.signedLastDay >= STATION_CSR_MAX_PER_DAY) return `rate limit: ${STATION_CSR_MAX_PER_DAY} station certificates were already requested by this charger in the last 24 hours`;
  return null;
}

/**
 * SignCertificate from a charger for its own (station) certificate. Answered
 * at once; the certificate is signed and sent with CertificateSigned after.
 *
 * It used to sign ANY such request, unsolicited and at any security profile: a
 * Profile 0/1 connection claiming a charger's identity (no credential, or a
 * Basic password sent in clear) walked away with a client certificate from the
 * CA the TLS terminator trusts. See stationCsrRefusal for the rules; anything
 * else is answered Rejected.
 */
export async function onStationCsr(ctx: Ctx, csrPem: string): Promise<{ status: 'Accepted' | 'Rejected'; reason?: string; code?: 'InvalidCSR' | 'NotAllowed' }> {
  const { logEvent } = await import('../pnc/service.js');
  const reject = async (reason: string, code: 'InvalidCSR' | 'NotAllowed') => {
    await logEvent(ctx.orgId, ctx.chargePointId, 'SignCertificate', 'rejected', { certificateType: 'ChargingStationCertificate', reason });
    if (code === 'NotAllowed') logger.warn({ cp: ctx.ocppIdentity, reason }, 'station certificate request refused');
    return { status: 'Rejected' as const, reason, code };
  };
  let subject: string;
  try { subject = checkStationCsr(csrPem, ctx.ocppIdentity).subjectText; }
  catch (e) { return reject((e as Error).message, 'InvalidCSR'); }

  // Decide and consume the request in one transaction, so two CSRs racing on
  // one request cannot both be signed.
  const decision = await tx(async (c) => {
    const cp = (await c.query<{ request_open: boolean; renewal_due: boolean; signed_last_day: number }>(
      `SELECT cp.station_csr_requested_until IS NOT NULL AND cp.station_csr_requested_until > now() AS request_open,
              (cp.client_cert_source IN ('plugsure_ca', 'plugsure_ca_csr', 'ocpp_csr')
                 AND cp.client_cert_not_after < now() + make_interval(days => $2)) IS TRUE AS renewal_due,
              (SELECT count(*)::int FROM pnc_certificate p
                WHERE p.charge_point_id = cp.id AND p.certificate_type = 'ChargingStationCertificate'
                  AND p.source = 'ocpp_csr' AND p.requested_at > now() - interval '24 hours') AS signed_last_day
         FROM charge_point cp WHERE cp.id = $1 FOR UPDATE`,
      [ctx.chargePointId, config.chargerCa.renewDays],
    )).rows[0];
    if (!cp) return { refusal: 'charge point not found' } as const;
    const refusal = stationCsrRefusal({
      profile: connectionProfile(ctx), requestOpen: cp.request_open, renewalDue: cp.renewal_due, signedLastDay: cp.signed_last_day,
    });
    if (refusal) return { refusal } as const;
    // One request, one certificate.
    await c.query(`UPDATE charge_point SET station_csr_requested_until = NULL WHERE id = $1`, [ctx.chargePointId]);
    const row = (await c.query<{ id: string }>(
      `INSERT INTO pnc_certificate (org_id, charge_point_id, certificate_type, csr_subject, source) VALUES ($1,$2,'ChargingStationCertificate',$3,'ocpp_csr') RETURNING id`,
      [ctx.orgId, ctx.chargePointId, subject],
    )).rows[0]!;
    return { refusal: null, row } as const;
  });
  if (decision.refusal !== null) return reject(decision.refusal, 'NotAllowed');
  const row = decision.row;
  await logEvent(ctx.orgId, ctx.chargePointId, 'SignCertificate', 'accepted', { certificateType: 'ChargingStationCertificate', subject });
  setTimeout(() => { void signAndInstall(ctx, row!.id, csrPem).catch((e) => logger.warn({ cp: ctx.ocppIdentity, err: (e as Error).message }, 'station certificate not installed')); }, 250);
  return { status: 'Accepted' };
}

async function signAndInstall(ctx: Ctx, certId: string, csrPem: string) {
  const { logEvent } = await import('../pnc/service.js');
  const { sendBackground, wireVersion, changeConfiguration } = await import('../ocpp/commands.js');
  const cp = await one<{ org_name: string; home_country_code: string; security_profile: number; cert_auto_upgrade: boolean; client_cert_fingerprint: string | null }>(
    `SELECT o.name AS org_name, o.home_country_code, cp.security_profile, cp.cert_auto_upgrade, cp.client_cert_fingerprint
       FROM charge_point cp JOIN site s ON s.id = cp.site_id JOIN organisation o ON o.id = s.org_id WHERE cp.id = $1`,
    [ctx.chargePointId],
  );
  const csr = checkStationCsr(csrPem, ctx.ocppIdentity);
  const s = await signFor(ctx.ocppIdentity, cp!.org_name, csr.spkiDer, csr.subjectDer, config.chargerCa.certDays, cp!.home_country_code);
  await recordCertificate(ctx.orgId, ctx.chargePointId, 'signed', s, 'ocpp_csr', { id: certId });
  const v = await wireVersion(ctx.ocppIdentity);
  const payload = v === 'ocpp2.0.1' || v === 'ocpp2.1'
    ? { certificateChain: s.pem + s.ca.pem, certificateType: 'ChargingStationCertificate' }
    : { certificateChain: s.pem + s.ca.pem };
  const actor = { type: 'system' as const, orgId: ctx.orgId };
  const r = await sendBackground<{ status?: string }>(ctx.ocppIdentity, 'CertificateSigned', payload, actor).catch((e) => ({ status: `error: ${(e as Error).message}` }));
  if (r?.status !== 'Accepted') {
    await query(`UPDATE pnc_certificate SET state = 'rejected', error = $2 WHERE id = $1`, [certId, `the charger answered ${r?.status ?? 'nothing'}`]);
    await logEvent(ctx.orgId, ctx.chargePointId, 'CertificateSigned', 'rejected', { certificateType: 'ChargingStationCertificate', answer: r?.status });
    return;
  }
  // Installed on the charger. The old certificate stays accepted until the charger uses the new one.
  await query(
    `UPDATE charge_point SET client_cert_prev_fingerprint = client_cert_fingerprint, client_cert_fingerprint = $2, client_cert_serial = $3,
            client_cert_not_after = $4, client_cert_source = 'ocpp_csr' WHERE id = $1`,
    [ctx.chargePointId, s.info.fingerprint, s.info.serial, s.info.notAfter],
  );
  await query(`UPDATE pnc_certificate SET state = 'delivered', delivered_at = now() WHERE id = $1`, [certId]);
  await logEvent(ctx.orgId, ctx.chargePointId, 'CertificateSigned', 'delivered', { certificateType: 'ChargingStationCertificate', serial: s.info.serial, notAfter: s.info.notAfter });
  await writeAudit({ orgId: ctx.orgId, actorType: 'system', action: 'charge_point.client_cert.issued', targetType: 'charge_point', targetId: ctx.ocppIdentity, after: { source: 'ocpp_csr', serial: s.info.serial, fingerprint: s.info.fingerprint, notAfter: s.info.notAfter } });
  const { resolveAlertsFor } = await import('./alerts.js');
  await resolveAlertsFor(ctx.orgId, 'charge_point.certificate_expiring', 'charge_point', ctx.chargePointId).catch(() => 0);

  // Zero-touch onboarding: move the charger to Profile 3 now that it holds its certificate.
  if (cp!.cert_auto_upgrade && (cp!.security_profile ?? 0) < 3) {
    if (!tlsAvailable()) {
      await logEvent(ctx.orgId, ctx.chargePointId, 'SecurityProfile', 'kept', { reason: 'TLS is not configured on this deployment; the charger stays on Profile 2' });
      return;
    }
    if (v === 'ocpp2.0.1' || v === 'ocpp2.1') {
      // 2.0.1 changes profiles with SetNetworkProfile + a reset, per the operator's network slots.
      await logEvent(ctx.orgId, ctx.chargePointId, 'SecurityProfile', 'manual', { reason: 'OCPP 2.0.1: raise the profile with the charger\'s network profile; the certificate is installed' });
      return;
    }
    const c = await changeConfiguration(ctx.ocppIdentity, 'SecurityProfile', '3', actor).catch((e) => ({ status: `error: ${(e as Error).message}` }));
    if (c?.status === 'Accepted' || c?.status === 'RebootRequired') {
      // The flag first, so nothing ever sees Profile 3 still marked as moving to it.
      await query(`UPDATE charge_point SET cert_auto_upgrade = false WHERE id = $1`, [ctx.chargePointId]);
      const raised = await setSecurityProfile(ctx.chargePointId, 3, actor);
      if (!raised.ok) await query(`UPDATE charge_point SET cert_auto_upgrade = true WHERE id = $1`, [ctx.chargePointId]);
      await logEvent(ctx.orgId, ctx.chargePointId, 'SecurityProfile', 'raised', { to: 3, answer: c.status });
    } else {
      await logEvent(ctx.orgId, ctx.chargePointId, 'SecurityProfile', 'kept', { reason: `the charger answered ${c?.status ?? 'nothing'} to SecurityProfile = 3` });
    }
  }
}

/**
 * Ask the charger for a CSR for its station certificate (it answers with
 * SignCertificate). Opens the request onStationCsr requires — BEFORE the
 * trigger goes out, since the charger may answer before our call returns.
 */
export async function requestStationCertificate(identity: string, actor: { type: 'user' | 'api_client' | 'system'; id?: string; orgId?: string; ip?: string }) {
  const { sendBackground, wireVersion, triggerMessage } = await import('../ocpp/commands.js');
  // Outside any request transaction: the gateway (another process) must see it at once.
  await outsideRequestScope(() => query(
    `UPDATE charge_point SET station_csr_requested_until = now() + make_interval(secs => $2) WHERE ocpp_identity = $1`,
    [identity, STATION_CSR_REQUEST_TTL_MS / 1000],
  ));
  const v = await wireVersion(identity);
  const r = v === 'ocpp2.0.1' || v === 'ocpp2.1'
    ? await triggerMessage(identity, 'SignChargingStationCertificate', undefined, actor)
    : await sendBackground<{ status?: string }>(identity, 'ExtendedTriggerMessage', { requestedMessage: 'SignChargePointCertificate' }, actor);
  const cp = await one<{ id: string; org_id: string }>(`SELECT cp.id, s.org_id FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE cp.ocpp_identity = $1`, [identity]);
  if (cp) {
    const { logEvent } = await import('../pnc/service.js');
    await logEvent(cp.org_id, cp.id, v === 'ocpp2.0.1' || v === 'ocpp2.1' ? 'TriggerMessage' : 'ExtendedTriggerMessage', String(r?.status ?? 'no answer'), { requestedMessage: 'station certificate' });
  }
  return { status: r?.status ?? null };
}

/** After BootNotification: a charger commissioned for zero-touch certificates is asked for its CSR. */
export async function afterBoot(ctx: Ctx): Promise<void> {
  const cp = await one<{ cert_auto_upgrade: boolean; security_profile: number; recent: boolean }>(
    `SELECT cp.cert_auto_upgrade, cp.security_profile,
            EXISTS (SELECT 1 FROM pnc_certificate x WHERE x.charge_point_id = cp.id AND x.certificate_type = 'ChargingStationCertificate'
                     AND x.requested_at > now() - interval '10 minutes') AS recent
       FROM charge_point cp WHERE cp.id = $1`,
    [ctx.chargePointId],
  );
  if (!cp?.cert_auto_upgrade || cp.security_profile >= 3 || cp.recent) return;
  setTimeout(() => { void requestStationCertificate(ctx.ocppIdentity, { type: 'system', orgId: ctx.orgId }).catch((e) => logger.warn({ cp: ctx.ocppIdentity, err: (e as Error).message }, 'could not ask for a station certificate')); }, 3_000);
}

// ================================================================== lists and renewal

export async function listStationCertificates(orgId: string) {
  return many(
    `SELECT cp.ocpp_identity, cp.display_name, cp.security_profile, cp.status, cp.ocpp_version, cp.cert_auto_upgrade,
            cp.client_cert_fingerprint IS NOT NULL AS bound, cp.client_cert_serial AS serial, cp.client_cert_not_after AS not_after,
            cp.client_cert_source AS source, cp.client_cert_prev_fingerprint IS NOT NULL AS rotating, s.name AS site_name, s.id AS site_id,
            (SELECT row_to_json(x) FROM (SELECT state, requested_at, delivered_at, error FROM pnc_certificate p
               WHERE p.charge_point_id = cp.id AND p.certificate_type = 'ChargingStationCertificate' ORDER BY p.requested_at DESC LIMIT 1) x) AS last_request
       FROM charge_point cp JOIN site s ON s.id = cp.site_id
      WHERE s.org_id = $1 AND cp.status <> 'decommissioned' AND (cp.client_cert_fingerprint IS NOT NULL OR cp.cert_auto_upgrade OR cp.security_profile >= 3)
      ORDER BY cp.client_cert_not_after NULLS FIRST, cp.ocpp_identity`,
    [orgId],
  );
}

/**
 * Station certificates from PlugSure's CA that end within CHARGER_CERT_RENEW_DAYS:
 * ask the charger for a new CSR (at most daily; only chargers that do the OCPP
 * security extension answer), and raise an alert two weeks before the end.
 */
export async function renewStationCertificates(now = new Date()): Promise<{ asked: number; alerted: number }> {
  const due = await many<{ id: string; org_id: string; ocpp_identity: string; not_after: Date; last: Date | null }>(
    `SELECT cp.id, s.org_id, cp.ocpp_identity, cp.client_cert_not_after AS not_after,
            (SELECT max(requested_at) FROM pnc_certificate p WHERE p.charge_point_id = cp.id AND p.certificate_type = 'ChargingStationCertificate') AS last
       FROM charge_point cp JOIN site s ON s.id = cp.site_id
      WHERE cp.status <> 'decommissioned' AND cp.client_cert_source IN ('plugsure_ca', 'plugsure_ca_csr', 'ocpp_csr')
        AND cp.client_cert_not_after < $1::timestamptz + make_interval(days => $2)`,
    [now, config.chargerCa.renewDays],
  );
  const { reachable } = await import('../ocpp/commands.js');
  let asked = 0, alerted = 0;
  for (const d of due) {
    const days = Math.floor((new Date(d.not_after).getTime() - now.getTime()) / 86_400_000);
    if (days <= 14) {
      bus.emit('alert.raised', {
        orgId: d.org_id, kind: 'charge_point.certificate_expiring', severity: days <= 3 ? 'critical' : 'warning',
        message: `${d.ocpp_identity}: its client certificate ${days <= 0 ? 'has expired' : `expires in ${days} day${days === 1 ? '' : 's'}`}. On Security Profile 3 it cannot connect without one — renew it under Onboarding → Certificates.`,
        targetType: 'charge_point', targetId: d.id,
      });
      alerted++;
    }
    if (d.last && now.getTime() - new Date(d.last).getTime() < 20 * 3600_000) continue;
    if (!reachable(d.ocpp_identity)) continue;
    try { await requestStationCertificate(d.ocpp_identity, { type: 'system', orgId: d.org_id }); asked++; } catch { /* logged by the command path */ }
  }
  return { asked, alerted };
}

/** For tests: forget the cached CA. */
export function resetChargerCaCache() { cached = null; }
