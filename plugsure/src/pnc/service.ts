import { X509Certificate, type KeyObject } from 'node:crypto';
import { one, many, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { bus } from '../services/events.js';
import { authorizeIdTag, type AdapterContext } from '../ocpp/adapter16.js';
import { authorizeRoaming } from '../ocpi/authorize.js';
import { pncCommand, type Actor } from '../ocpp/commands.js';
import {
  certInfo, ocspFreshnessProblem, ocspResponseCerts, readOcspResponse, splitPemChain, parseCsr, type CertificateHashData, type OcspResult,
} from './der.js';
import { checkContractChain, trustedIssuerFor, type CertStatus } from './chain.js';
import { normaliseEmaid, formatEmaid } from './emaid.js';
import { evCertificate, ocspFetch, pkiRoots, PkiError, signCsr, pkiProblem } from './pki.js';

/**
 * ISO 15118 Plug & Charge, CSMS side (OCPP 2.0.1, and OCPP 1.6 through the OCA
 * application note's DataTransfer wrapping).
 *
 * From the charger:
 *   Authorize (eMAID + contract certificate or its hash data)
 *                           → contract checks: chain, expiry, OCSP, then the
 *                             contract (a token of kind 'emaid') as for a card
 *   GetCertificateStatus    → the OCSP answer, fetched from the certificate's responder
 *   Get15118EVCertificate   → the PKI installs/updates the car's contract certificate
 *   SignCertificate (V2G)   → the PKI signs; CertificateSigned is sent back
 * To the charger (operator actions and renewal):
 *   InstallCertificate (V2G / MO roots), GetInstalledCertificateIds,
 *   DeleteCertificate, TriggerMessage(SignV2GCertificate), and the
 *   ISO15118Ctrlr variables.
 */

export class PncError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

// ================================================================== eMAID

export { normaliseEmaid, formatEmaid };


/**
 * The idTag a charger's eMAID stands for: the operator's own contract (uid =
 * eMAID without separators), or a roaming partner's contract whose contract_id
 * is this eMAID. Null when it is neither.
 */
export async function contractIdTag(chargePointId: string, value: string): Promise<string | null> {
  const e = normaliseEmaid(value);
  if (!e) return null;
  const own = await one<{ uid: string }>(
    `SELECT t.uid FROM token t JOIN site s ON s.org_id = t.org_id JOIN charge_point cp ON cp.site_id = s.id
      WHERE cp.id = $1 AND t.kind = 'emaid' AND t.uid = $2 LIMIT 1`,
    [chargePointId, e],
  );
  if (own) return own.uid;
  const roaming = await one<{ uid: string }>(
    `SELECT t.uid FROM ocpi_token t JOIN site s ON s.org_id = t.org_id JOIN charge_point cp ON cp.site_id = s.id
      WHERE cp.id = $1 AND upper(replace(t.contract_id, '-', '')) = $2
      ORDER BY t.valid DESC, t.last_updated DESC LIMIT 1`,
    [chargePointId, e],
  ).catch(() => null);
  return roaming?.uid ?? null;
}

// ================================================================== settings

export interface PncSettings {
  enabled: boolean;
  /**
   * Accept a contract whose revocation status cannot be established: the OCSP
   * responder is unreachable or errs, its answer is stale, or the certificate
   * names no responder. OFF by default (fail closed): with it on, anyone able to
   * block or delay OCSP traffic — or holding a certificate with no OCSP URL —
   * charges on a revoked contract. Turn it on only where outages are a bigger
   * risk than revoked contracts, and know that it is then a policy, not a check.
   * A forged, unsigned or wrongly signed answer is refused either way.
   */
  acceptWhenOcspUnavailable: boolean;
}
const DEFAULTS: PncSettings = { enabled: false, acceptWhenOcspUnavailable: false };

export async function getSettings(orgId: string): Promise<PncSettings> {
  const r = await one<{ s: any }>(`SELECT pnc_settings AS s FROM organisation WHERE id = $1`, [orgId]);
  return { ...DEFAULTS, ...(r?.s ?? {}) };
}

export async function putSettings(orgId: string, b: any): Promise<PncSettings> {
  const cur = await getSettings(orgId);
  const next: PncSettings = {
    enabled: typeof b?.enabled === 'boolean' ? b.enabled : cur.enabled,
    acceptWhenOcspUnavailable: typeof b?.acceptWhenOcspUnavailable === 'boolean' ? b.acceptWhenOcspUnavailable : cur.acceptWhenOcspUnavailable,
  };
  await query(`UPDATE organisation SET pnc_settings = $2 WHERE id = $1`, [orgId, JSON.stringify(next)]);
  return next;
}

// ================================================================== event log

export async function logEvent(orgId: string, chargePointId: string | null, action: string, outcome: string, detail: Record<string, unknown> = {}, emaid: string | null = null) {
  await query(
    `INSERT INTO pnc_event (org_id, charge_point_id, action, outcome, emaid, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
    [orgId, chargePointId, action, outcome.slice(0, 60), emaid, JSON.stringify(detail)],
  ).catch((e) => logger.warn({ err: e.message }, 'pnc event not recorded'));
}

const statusInfo = (reasonCode: string, additionalInfo?: string) => ({ statusInfo: { reasonCode: reasonCode.slice(0, 20), ...(additionalInfo ? { additionalInfo: additionalInfo.slice(0, 512) } : {}) } });

// ================================================================== charger → CSMS

export const PNC_INBOUND = new Set(['Authorize', 'Get15118EVCertificate', 'GetCertificateStatus', 'SignCertificate']);

/** One entry point for both OCPP versions; payloads and answers are 2.0.1-shaped. */
export async function handlePncCall(ctx: AdapterContext, action: string, p: any): Promise<any> {
  switch (action) {
    case 'Authorize': return authorizeContract(ctx, p);
    case 'Get15118EVCertificate': return onEvCertificate(ctx, p);
    case 'GetCertificateStatus': return onCertificateStatus(ctx, p);
    case 'SignCertificate': return onSignCertificate(ctx, p);
    default: throw new PncError(400, `not a Plug & Charge message: ${action}`);
  }
}

async function onEvCertificate(ctx: AdapterContext, p: any) {
  const s = await getSettings(ctx.orgId);
  if (!s.enabled) {
    await logEvent(ctx.orgId, ctx.chargePointId, 'Get15118EVCertificate', 'disabled', { action: p?.action });
    return { status: 'Failed', exiResponse: '', ...statusInfo('Disabled', 'Plug & Charge is switched off') };
  }
  const r = await evCertificate({ iso15118SchemaVersion: String(p.iso15118SchemaVersion), action: p.action, exiRequest: String(p.exiRequest) }, ctx.ocppIdentity);
  await logEvent(ctx.orgId, ctx.chargePointId, 'Get15118EVCertificate', r.status === 'Accepted' ? 'accepted' : 'failed', { action: p.action, schema: p.iso15118SchemaVersion, ...(r.reason ? { reason: r.reason } : {}) });
  return r.status === 'Accepted' ? { status: 'Accepted', exiResponse: r.exiResponse } : { status: 'Failed', exiResponse: '', ...statusInfo('PkiFailed', r.reason) };
}

async function onCertificateStatus(ctx: AdapterContext, p: any) {
  const d = p.ocspRequestData ?? {};
  const s = await getSettings(ctx.orgId);
  if (!s.enabled) return { status: 'Failed', ...statusInfo('Disabled', 'Plug & Charge is switched off') };
  const h: CertificateHashData = { hashAlgorithm: d.hashAlgorithm, issuerNameHash: d.issuerNameHash, issuerKeyHash: d.issuerKeyHash, serialNumber: d.serialNumber };
  try {
    const der = await ocspFetch(h, String(d.responderURL));
    const r = readOcspResponse(der, h);
    const b64 = der.toString('base64');
    if (b64.length > 5500) throw new PkiError('the OCSP response is larger than OCPP allows (5500 characters)');
    await logEvent(ctx.orgId, ctx.chargePointId, 'GetCertificateStatus', r.status ?? r.responseStatus, { serial: h.serialNumber, responder: d.responderURL });
    return { status: 'Accepted', ocspResult: b64 };
  } catch (e) {
    await logEvent(ctx.orgId, ctx.chargePointId, 'GetCertificateStatus', 'failed', { serial: h.serialNumber, responder: d.responderURL, reason: (e as Error).message });
    return { status: 'Failed', ...statusInfo('OcspUnavailable', (e as Error).message) };
  }
}

// ------------------------------------------------------------------ SignCertificate → CertificateSigned

async function onSignCertificate(ctx: AdapterContext, p: any) {
  const type = p.certificateType === 'V2GCertificate' ? 'V2GCertificate' : 'ChargingStationCertificate';
  const s = await getSettings(ctx.orgId);
  const refuse = async (code: string, why: string) => {
    await logEvent(ctx.orgId, ctx.chargePointId, 'SignCertificate', 'rejected', { certificateType: type, reason: why });
    return { status: 'Rejected', ...statusInfo(code, why) };
  };
  // The station's own client certificate (Security Profile 3): PlugSure's charging-station CA, independent of Plug & Charge.
  // Its rules (platform request, Profile 2+, rate limit) live in charger-ca.ts.
  const { onStationCsr, connectionProfile } = await import('../services/charger-ca.js');
  if (type !== 'V2GCertificate') {
    const r = await onStationCsr(ctx, String(p.csr));
    return r.status === 'Accepted' ? { status: 'Accepted' } : { status: 'Rejected', ...statusInfo(r.code ?? 'InvalidCSR', r.reason) };
  }
  if (!s.enabled) return refuse('Disabled', 'Plug & Charge is switched off');
  /**
   * A V2G (SECC) certificate is the TLS server identity the station presents to
   * cars, chained to the V2G root every car trusts. Issued to a connection that
   * is not authenticated over TLS (Profile 0/1: no credential, or a Basic
   * password in clear), anyone who can claim the station's identity could obtain
   * one and impersonate a charging station to cars. Same bar as the station
   * certificate: Security Profile 2 or 3; unknown counts as 0.
   */
  const profile = connectionProfile(ctx as { securityProfile?: unknown });
  if (profile < 2) return refuse('NotAllowed', `the connection is on Security Profile ${profile}; a V2G certificate is only issued over an authenticated TLS connection (Profile 2 or 3)`);
  const why = await pkiProblem();
  if (why) return refuse('NoPki', why);
  let subject: string;
  try { subject = parseCsr(String(p.csr)).subjectText; } catch (e) { return refuse('InvalidCSR', (e as Error).message); }
  const row = await one<{ id: string }>(
    `INSERT INTO pnc_certificate (org_id, charge_point_id, certificate_type, csr_subject) VALUES ($1,$2,$3,$4) RETURNING id`,
    [ctx.orgId, ctx.chargePointId, type, subject],
  );
  await logEvent(ctx.orgId, ctx.chargePointId, 'SignCertificate', 'accepted', { certificateType: type, subject });
  // Answer first; sign and deliver once the charger has its answer.
  setTimeout(() => { void signAndDeliver(ctx, row!.id, String(p.csr), type); }, 250);
  return { status: 'Accepted' };
}

async function signAndDeliver(ctx: AdapterContext, certId: string, csr: string, type: 'V2GCertificate') {
  let chain: string;
  try {
    chain = await signCsr(csr, type, ctx.ocppIdentity);
  } catch (e) {
    const msg = (e as Error).message;
    await query(`UPDATE pnc_certificate SET state = 'failed', error = $2 WHERE id = $1`, [certId, msg.slice(0, 500)]);
    await logEvent(ctx.orgId, ctx.chargePointId, 'CertificateSigned', 'sign_failed', { reason: msg });
    bus.emit('alert.raised', { orgId: ctx.orgId, kind: 'pnc.certificate_failed', severity: 'warning', message: `${ctx.ocppIdentity}: its V2G certificate could not be signed — ${msg.slice(0, 200)}`, targetType: 'charge_point', targetId: ctx.chargePointId });
    return;
  }
  const leaf = certInfo(splitPemChain(chain)[0]!);
  await query(
    `UPDATE pnc_certificate SET state = 'signed', subject = $2, serial = $3, fingerprint = $4, not_before = $5, not_after = $6, chain_pem = $7 WHERE id = $1`,
    [certId, leaf.subject, leaf.serial, leaf.fingerprint, leaf.notBefore, leaf.notAfter, chain],
  );
  try {
    const r = await pncCommand<{ status?: string }>(ctx.ocppIdentity, 'CertificateSigned', { certificateChain: chain, certificateType: type }, { type: 'system', orgId: ctx.orgId }, 1);
    const ok = r?.status === 'Accepted';
    await query(`UPDATE pnc_certificate SET state = $2, delivered_at = CASE WHEN $2 = 'delivered' THEN now() END, error = $3 WHERE id = $1`, [certId, ok ? 'delivered' : 'rejected', ok ? null : `the charger answered ${r?.status ?? 'nothing'}`]);
    await logEvent(ctx.orgId, ctx.chargePointId, 'CertificateSigned', ok ? 'delivered' : 'rejected', { serial: leaf.serial, notAfter: leaf.notAfter, answer: r?.status });
    if (ok) {
      const { resolveAlertsFor } = await import('../services/alerts.js');
      await resolveAlertsFor(ctx.orgId, 'pnc.certificate_expiring', 'charge_point', ctx.chargePointId).catch(() => 0);
      await resolveAlertsFor(ctx.orgId, 'pnc.certificate_failed', 'charge_point', ctx.chargePointId).catch(() => 0);
    }
  } catch (e) {
    await query(`UPDATE pnc_certificate SET error = $2 WHERE id = $1`, [certId, `not delivered: ${(e as Error).message}`.slice(0, 500)]);
    await logEvent(ctx.orgId, ctx.chargePointId, 'CertificateSigned', 'not_delivered', { reason: (e as Error).message });
  }
}

// ------------------------------------------------------------------ Authorize with a contract

async function moRoots(orgId: string): Promise<X509Certificate[]> {
  const rows = await many<{ pem: string }>(`SELECT pem FROM pnc_trust_anchor WHERE org_id = $1 AND kind = 'MORootCertificate'`, [orgId]);
  return rows.map((r) => new X509Certificate(r.pem));
}

/** One certificate to check by OCSP: its hash data, where to ask, and who may sign the answer (when known). */
type OcspItem = CertificateHashData & { responderURL: string | null; issuerKey?: KeyObject };

/**
 * OCSP for each certificate: revoked or unknown fails; unreachable is reported
 * separately (the operator's acceptWhenOcspUnavailable decides).
 *
 * The answer must be SIGNED by the certificate's issuer (or a delegated
 * responder the issuer certified for OCSP signing) and FRESH. Before, an answer
 * nobody could verify (signatureValid null) counted as good — and on the
 * hash-data path, where the CHARGER names the responder and no issuer key was
 * known, every answer was unverifiable, so any "good" from any URL passed. An
 * old good answer could also be replayed for ever (no thisUpdate/nextUpdate
 * check, OCSP is plain HTTP). And a certificate without an OCSP URL was simply
 * not checked: it is now "not verifiable", which only acceptWhenOcspUnavailable
 * lets through.
 */
async function checkRevocation(
  list: OcspItem[],
  roots: X509Certificate[],
  now = new Date(),
): Promise<{ status: CertStatus | 'unreachable'; why?: string; results: Array<{ serial: string; status: string }> }> {
  const results: Array<{ serial: string; status: string }> = [];
  for (const h of list) {
    if (!h.responderURL) {
      results.push({ serial: h.serialNumber, status: 'no_ocsp_url' });
      return { status: 'unreachable', why: `certificate ${h.serialNumber} names no OCSP responder, so its revocation status cannot be checked`, results };
    }
    let r: OcspResult;
    try {
      const der = await ocspFetch(h, h.responderURL);
      // Who may sign: the issuer we already verified (full chain), else an issuer
      // certificate that chains to an installed MO root — from the trust anchors
      // or carried in the answer itself. Never "whoever the responder says".
      let issuerKey = h.issuerKey;
      if (!issuerKey) {
        const pool = ocspResponseCerts(der).flatMap((d) => { try { return [new X509Certificate(d)]; } catch { return []; } });
        issuerKey = trustedIssuerFor(h, pool, roots, now)?.publicKey;
      }
      r = readOcspResponse(der, h, issuerKey ? [issuerKey] : [], now);
      if (r.responseStatus === 'successful' && !issuerKey) {
        results.push({ serial: h.serialNumber, status: 'unverifiable' });
        return { status: 'SignatureError', why: `the OCSP answer for ${h.serialNumber} cannot be verified: its issuer does not chain to an installed MO root`, results };
      }
    } catch (e) {
      results.push({ serial: h.serialNumber, status: 'unreachable' });
      return { status: 'unreachable', why: (e as Error).message, results };
    }
    results.push({ serial: h.serialNumber, status: r.status ?? r.responseStatus });
    if (r.responseStatus !== 'successful') return { status: 'unreachable', why: `the OCSP responder answered ${r.responseStatus}`, results };
    if (r.signatureValid !== true) return { status: 'SignatureError', why: 'the OCSP answer is not signed by the issuer or a delegated OCSP responder', results };
    const stale = ocspFreshnessProblem(r, now);
    if (stale) return { status: 'unreachable', why: `${stale} (certificate ${h.serialNumber})`, results };
    if (r.status === 'revoked') return { status: 'CertificateRevoked', why: `certificate ${h.serialNumber} is revoked`, results };
    if (r.status !== 'good') return { status: 'CertChainError', why: `the PKI does not know certificate ${h.serialNumber}`, results };
  }
  return { status: 'Accepted', results };
}

/**
 * Authorize for Plug & Charge. The certificate decides whether the car really
 * holds this contract; the contract (a token) decides whether it may charge
 * here, with the card rules the operator already has (status, expiry, limits).
 */
export async function authorizeContract(ctx: AdapterContext, p: any): Promise<{ idTokenInfo: { status: string }; certificateStatus?: CertStatus }> {
  const raw = String(p?.idToken?.idToken ?? '');
  const emaid = normaliseEmaid(raw);
  const hasCert = typeof p?.certificate === 'string' && p.certificate.length > 0;
  const hashData: any[] = Array.isArray(p?.iso15118CertificateHashData) ? p.iso15118CertificateHashData : [];
  const s = await getSettings(ctx.orgId);
  const done = async (outcome: string, res: { idTokenInfo: { status: string }; certificateStatus?: CertStatus }, detail: Record<string, unknown> = {}) => {
    await logEvent(ctx.orgId, ctx.chargePointId, 'Authorize', outcome, { ...detail, idTokenInfo: res.idTokenInfo.status, ...(res.certificateStatus ? { certificateStatus: res.certificateStatus } : {}) }, emaid);
    logger.info({ cp: ctx.ocppIdentity, emaid, status: res.idTokenInfo.status, cert: res.certificateStatus }, 'Plug & Charge Authorize');
    return res;
  };
  if (!s.enabled) return done('disabled', { idTokenInfo: { status: 'Invalid' } });
  if (!emaid) return done('bad_emaid', { idTokenInfo: { status: 'Invalid' } }, { presented: raw.slice(0, 40) });

  // 1. The certificate: the chain itself (checked here), or the hash data of a chain the charger checked.
  const roots = hasCert || hashData.length ? await moRoots(ctx.orgId) : [];
  let ocspList: OcspItem[] = [];
  if (hasCert) {
    const c = checkContractChain(String(p.certificate), emaid, roots);
    if (c.status !== 'Accepted') return done('certificate_refused', { idTokenInfo: { status: 'Invalid' }, certificateStatus: c.status }, { reason: c.why });
    ocspList = (c.revocation ?? []).map((x) => ({ ...x.hashData, responderURL: x.responderURL, issuerKey: x.issuer.publicKey }));
  } else if (hashData.length) {
    // The charger checked the chain; we check revocation. The responder URL is the
    // charger's word, so the answer counts only if an issuer we trust signed it.
    ocspList = hashData.map((h) => ({
      hashAlgorithm: h.hashAlgorithm, issuerNameHash: h.issuerNameHash, issuerKeyHash: h.issuerKeyHash, serialNumber: h.serialNumber,
      responderURL: typeof h.responderURL === 'string' && h.responderURL ? h.responderURL : null,
    }));
  }
  let ocsp: Awaited<ReturnType<typeof checkRevocation>> | null = null;
  if (ocspList.length) {
    ocsp = await checkRevocation(ocspList, roots);
    if (ocsp.status === 'unreachable') {
      if (!s.acceptWhenOcspUnavailable) return done('ocsp_unavailable', { idTokenInfo: { status: 'Unknown' } }, { reason: ocsp.why, ocsp: ocsp.results });
    } else if (ocsp.status !== 'Accepted') {
      return done('certificate_refused', { idTokenInfo: { status: 'Invalid' }, certificateStatus: ocsp.status }, { reason: ocsp.why, ocsp: ocsp.results });
    }
  }
  const certificateStatus: CertStatus | undefined = hasCert || hashData.length ? 'Accepted' : undefined;

  // 2. The contract.
  const idTag = await contractIdTag(ctx.chargePointId, emaid);
  if (!idTag) return done('unknown_contract', { idTokenInfo: { status: 'Invalid' }, ...(certificateStatus ? { certificateStatus: 'ContractCancelled' as CertStatus } : {}) }, { ocsp: ocsp?.results });
  const info = await authorizeIdTag(ctx.chargePointId, idTag);
  const status = info.status;
  const cancelled = status === 'Blocked' || status === 'Expired';
  return done(status === 'Accepted' ? (ocsp?.status === 'unreachable' ? 'accepted_ocsp_unavailable' : 'accepted') : 'contract_refused', {
    idTokenInfo: { status },
    ...(certificateStatus ? { certificateStatus: cancelled ? 'ContractCancelled' : certificateStatus } : {}),
  }, { ocsp: ocsp?.results, ...(ocsp?.status === 'unreachable' ? { reason: ocsp.why } : {}) });
}

// ================================================================== operator side

const CERT_TYPES = ['V2GRootCertificate', 'MORootCertificate'] as const;

export async function overview(orgId: string) {
  const settings = await getSettings(orgId);
  const counts = await one<any>(
    `SELECT (SELECT count(*)::int FROM token WHERE org_id = $1 AND kind = 'emaid') AS contracts,
            (SELECT count(*)::int FROM token WHERE org_id = $1 AND kind = 'emaid' AND status = 'Accepted') AS active_contracts,
            (SELECT count(*)::int FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE s.org_id = $1 AND cp.pnc_enabled) AS chargers,
            (SELECT count(*)::int FROM pnc_trust_anchor WHERE org_id = $1) AS trust_anchors,
            (SELECT count(*)::int FROM pnc_event WHERE org_id = $1 AND action = 'Authorize' AND created_at > now() - interval '30 days') AS authorizations_30d,
            (SELECT count(*)::int FROM pnc_event WHERE org_id = $1 AND action = 'Authorize' AND outcome LIKE 'accepted%' AND created_at > now() - interval '30 days') AS accepted_30d`,
    [orgId],
  );
  const { pkiDescription, pkiMode } = await import('./pki.js');
  return { settings, pki: { mode: await pkiMode(), description: await pkiDescription(), problem: await pkiProblem() }, counts };
}

// ------------------------------------------------------------------ contracts

export async function listContracts(orgId: string) {
  return many(
    `SELECT t.id, t.uid AS emaid, t.status, t.holder_name, t.account_type, t.fleet_name, t.valid_to, t.notes, t.created_at,
            (SELECT count(*)::int FROM charging_session cs WHERE cs.token_id = t.id) AS sessions,
            (SELECT max(started_at) FROM charging_session cs WHERE cs.token_id = t.id) AS last_used
       FROM token t WHERE t.org_id = $1 AND t.kind = 'emaid' ORDER BY t.created_at DESC`,
    [orgId],
  ).then((rows) => rows.map((r: any) => ({ ...r, emaid_display: formatEmaid(r.emaid) })));
}

export async function createContract(orgId: string, b: any) {
  const emaid = normaliseEmaid(b?.emaid);
  if (!emaid) throw new PncError(422, 'eMAID must look like ID-PLS-C12345678 (country, provider, 9-character contract, optional check character).');
  const accountType = b?.accountType === 'fleet' ? 'fleet' : 'retail';
  if (accountType === 'fleet' && !String(b?.fleetName ?? '').trim()) throw new PncError(422, 'A fleet contract needs the fleet (company) name.');
  const clash = await one(`SELECT kind FROM token WHERE org_id = $1 AND uid = $2`, [orgId, emaid]);
  if (clash) throw new PncError(409, 'That eMAID is already registered.');
  const r = await one<{ id: string }>(
    `INSERT INTO token (org_id, kind, uid, status, holder_name, account_type, fleet_name, valid_to, notes, offline_allowed)
     VALUES ($1,'emaid',$2,'Accepted',$3,$4,$5,$6,$7,false) RETURNING id`,
    [orgId, emaid, String(b?.holderName ?? '').trim().slice(0, 120) || null, accountType, accountType === 'fleet' ? String(b.fleetName).trim().slice(0, 120) : null, b?.validTo || null, String(b?.notes ?? '').slice(0, 500) || null],
  );
  return (await listContracts(orgId)).find((c: any) => c.id === r!.id);
}

export async function setContractStatus(orgId: string, id: string, active: boolean) {
  const r = await query(`UPDATE token SET status = $3, updated_at = now() WHERE org_id = $1 AND id = $2 AND kind = 'emaid'`, [orgId, id, active ? 'Accepted' : 'Blocked']);
  if (!r.rowCount) throw new PncError(404, 'contract not found');
  return (await listContracts(orgId)).find((c: any) => c.id === id);
}

// ------------------------------------------------------------------ trust anchors

export async function listTrustAnchors(orgId: string) {
  return many(`SELECT id, kind, subject, fingerprint, not_after, source, created_at, pem FROM pnc_trust_anchor WHERE org_id = $1 ORDER BY kind, created_at`, [orgId]);
}

export async function addTrustAnchor(orgId: string, kind: string, pem: string, source: 'pki' | 'upload' = 'upload') {
  if (!CERT_TYPES.includes(kind as any)) throw new PncError(422, 'kind is V2GRootCertificate or MORootCertificate');
  let x: X509Certificate;
  try { x = new X509Certificate(pem); } catch { throw new PncError(422, 'That is not a PEM certificate.'); }
  if (!x.ca) throw new PncError(422, 'A trust anchor must be a CA certificate.');
  if (new Date(x.validTo) < new Date()) throw new PncError(422, 'That certificate has expired.');
  const info = certInfo(x.raw);
  await query(
    `INSERT INTO pnc_trust_anchor (org_id, kind, pem, subject, fingerprint, not_after, source) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (org_id, fingerprint) DO NOTHING`,
    [orgId, kind, x.toString(), info.subject, info.fingerprint, info.notAfter, source],
  );
  return one(`SELECT id, kind, subject, fingerprint, not_after, source, created_at FROM pnc_trust_anchor WHERE org_id = $1 AND fingerprint = $2`, [orgId, info.fingerprint]);
}

export async function removeTrustAnchor(orgId: string, id: string) {
  const r = await query(`DELETE FROM pnc_trust_anchor WHERE org_id = $1 AND id = $2`, [orgId, id]);
  if (!r.rowCount) throw new PncError(404, 'trust anchor not found');
}

/** Fetch the PKI's root certificates and keep them as trust anchors. */
export async function syncTrustAnchors(orgId: string) {
  let roots;
  try { roots = await pkiRoots(); } catch (e) { throw new PncError(502, (e as Error).message); }
  const added = [];
  for (const pem of roots.v2g) added.push(await addTrustAnchor(orgId, 'V2GRootCertificate', pem, 'pki'));
  for (const pem of roots.mo) added.push(await addTrustAnchor(orgId, 'MORootCertificate', pem, 'pki'));
  return { anchors: await listTrustAnchors(orgId), received: added.length };
}

// ------------------------------------------------------------------ chargers

export async function listChargers(orgId: string) {
  return many(
    `SELECT cp.id, cp.ocpp_identity, cp.display_name, cp.ocpp_version, cp.pnc_enabled, cp.pnc_installed, cp.pnc_installed_at, s.name AS site_name,
            c.state AS cert_state, c.subject AS cert_subject, c.serial AS cert_serial, c.not_after AS cert_not_after, c.requested_at AS cert_requested_at,
            c.delivered_at AS cert_delivered_at, c.error AS cert_error
       FROM charge_point cp
       JOIN site s ON s.id = cp.site_id
       LEFT JOIN LATERAL (SELECT * FROM pnc_certificate x WHERE x.charge_point_id = cp.id AND x.certificate_type = 'V2GCertificate'
                           ORDER BY (x.state = 'delivered') DESC, x.requested_at DESC LIMIT 1) c ON true
      WHERE s.org_id = $1 AND cp.status <> 'decommissioned'
      ORDER BY cp.pnc_enabled DESC, cp.ocpp_identity`,
    [orgId],
  );
}

async function cpOf(orgId: string, identity: string) {
  const cp = await one<{ id: string; ocpp_identity: string; ocpp_version: string }>(`SELECT cp.id, cp.ocpp_identity, cp.ocpp_version FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE s.org_id = $1 AND cp.ocpp_identity = $2`, [orgId, identity]);
  if (!cp) throw new PncError(404, 'charge point not found');
  return cp;
}

/** Mark a charger as Plug & Charge capable and switch it on at the charger. */
export async function enableCharger(orgId: string, identity: string, on: boolean, actor: Actor) {
  const cp = await cpOf(orgId, identity);
  await query(`UPDATE charge_point SET pnc_enabled = $2 WHERE id = $1`, [cp.id, on]);
  const { changeConfiguration } = await import('../ocpp/commands.js');
  // Sent through the bridge when the charger is in the gateway; an offline charger is reported, not an error.
  let charger: string | null = null;
  try { charger = (await changeConfiguration(identity, 'ISO15118PnCEnabled', on ? 'true' : 'false', actor))?.status ?? null; }
  catch (e) { charger = /not connected/.test((e as Error).message) ? 'offline — set it when the charger is back' : `not sent: ${(e as Error).message}`; }
  await logEvent(orgId, cp.id, 'PnCEnabled', on ? 'on' : 'off', { charger });
  return { pncEnabled: on, charger };
}

/** Ask the charger for a new V2G certificate (it answers with SignCertificate). */
export async function requestCertificate(orgId: string, identity: string, actor: Actor) {
  const cp = await cpOf(orgId, identity);
  const r = await pncCommand<{ status?: string }>(identity, 'TriggerMessage', { requestedMessage: 'SignV2GCertificate' }, actor);
  await logEvent(orgId, cp.id, 'TriggerMessage', String(r?.status ?? 'no answer'), { requestedMessage: 'SignV2GCertificate' });
  return { status: r?.status ?? null };
}

/** Install the operator's trust anchors on the charger. */
export async function installRoots(orgId: string, identity: string, actor: Actor, kinds: string[] = [...CERT_TYPES]) {
  const cp = await cpOf(orgId, identity);
  const anchors = (await listTrustAnchors(orgId)).filter((a: any) => kinds.includes(a.kind));
  if (!anchors.length) throw new PncError(409, 'There are no trust anchors to install. Add them under Trust anchors, or fetch them from the PKI.');
  const results = [];
  for (const a of anchors as any[]) {
    const r = await pncCommand<{ status?: string }>(identity, 'InstallCertificate', { certificateType: a.kind, certificate: a.pem }, actor);
    results.push({ kind: a.kind, subject: a.subject, status: r?.status ?? null });
    await logEvent(orgId, cp.id, 'InstallCertificate', String(r?.status ?? 'no answer'), { certificateType: a.kind, subject: a.subject });
  }
  return { results };
}

/** Read what the charger has installed (GetInstalledCertificateIds). */
export async function readInstalled(orgId: string, identity: string, actor: Actor) {
  const cp = await cpOf(orgId, identity);
  const r = await pncCommand<any>(identity, 'GetInstalledCertificateIds', { certificateType: ['V2GRootCertificate', 'MORootCertificate', 'V2GCertificateChain'] }, actor);
  const list = Array.isArray(r?.certificateHashDataChain) ? r.certificateHashDataChain : [];
  await query(`UPDATE charge_point SET pnc_installed = $2, pnc_installed_at = now() WHERE id = $1`, [cp.id, JSON.stringify(list)]);
  await logEvent(orgId, cp.id, 'GetInstalledCertificateIds', String(r?.status ?? 'no answer'), { count: list.length });
  return { status: r?.status ?? null, certificates: list };
}

export async function deleteInstalled(orgId: string, identity: string, hash: CertificateHashData, actor: Actor) {
  const cp = await cpOf(orgId, identity);
  if (!hash?.serialNumber || !hash.issuerKeyHash || !hash.issuerNameHash) throw new PncError(422, 'certificateHashData is required');
  const r = await pncCommand<{ status?: string }>(identity, 'DeleteCertificate', { certificateHashData: { hashAlgorithm: hash.hashAlgorithm ?? 'SHA256', issuerNameHash: hash.issuerNameHash, issuerKeyHash: hash.issuerKeyHash, serialNumber: hash.serialNumber } }, actor);
  await logEvent(orgId, cp.id, 'DeleteCertificate', String(r?.status ?? 'no answer'), { serial: hash.serialNumber });
  return { status: r?.status ?? null };
}

export async function listEvents(orgId: string, q: { identity?: string; limit?: number } = {}) {
  return many(
    `SELECT e.id, e.action, e.outcome, e.emaid, e.detail, e.created_at, cp.ocpp_identity
       FROM pnc_event e LEFT JOIN charge_point cp ON cp.id = e.charge_point_id
      WHERE e.org_id = $1 AND ($2::text IS NULL OR cp.ocpp_identity = $2)
      ORDER BY e.id DESC LIMIT $3`,
    [orgId, q.identity ?? null, Math.min(Math.max(Number(q.limit) || 100, 1), 500)],
  );
}

// ================================================================== renewal (worker)

/**
 * Chargers marked Plug & Charge whose delivered V2G certificate ends within
 * PNC_RENEW_DAYS: ask them for a new one (at most daily), and raise an alert
 * a week before it ends. A car refuses to charge at a charger whose
 * certificate has expired.
 */
export async function renewExpiringCertificates(now = new Date()): Promise<{ triggered: number; alerted: number }> {
  const due = await many<{ org_id: string; id: string; ocpp_identity: string; not_after: Date; last: Date | null }>(
    `SELECT s.org_id, cp.id, cp.ocpp_identity, c.not_after,
            (SELECT max(created_at) FROM pnc_event e WHERE e.charge_point_id = cp.id AND e.action = 'TriggerMessage') AS last
       FROM charge_point cp
       JOIN site s ON s.id = cp.site_id
       JOIN organisation o ON o.id = s.org_id AND (o.pnc_settings->>'enabled')::boolean IS TRUE
       JOIN LATERAL (SELECT not_after FROM pnc_certificate x WHERE x.charge_point_id = cp.id AND x.certificate_type = 'V2GCertificate' AND x.state = 'delivered'
                      ORDER BY x.not_after DESC LIMIT 1) c ON true
      WHERE cp.pnc_enabled AND c.not_after < $1::timestamptz + make_interval(days => $2)`,
    [now, config.pnc.renewDays],
  );
  let triggered = 0, alerted = 0;
  const { reachable } = await import('../ocpp/commands.js');
  for (const d of due) {
    const days = Math.floor((new Date(d.not_after).getTime() - now.getTime()) / 86_400_000);
    if (days <= 7) {
      bus.emit('alert.raised', { orgId: d.org_id, kind: 'pnc.certificate_expiring', severity: days <= 0 ? 'critical' : 'warning', message: `${d.ocpp_identity}: its Plug & Charge (V2G) certificate ${days <= 0 ? 'has expired' : `expires in ${days} day${days === 1 ? '' : 's'}`}. Cars will not start Plug & Charge there.`, targetType: 'charge_point', targetId: d.id });
      alerted++;
    }
    if (d.last && now.getTime() - new Date(d.last).getTime() < 20 * 3600_000) continue;
    if (!reachable(d.ocpp_identity)) continue;
    try {
      const r = await pncCommand<{ status?: string }>(d.ocpp_identity, 'TriggerMessage', { requestedMessage: 'SignV2GCertificate' }, { type: 'system', orgId: d.org_id }, 1);
      await logEvent(d.org_id, d.id, 'TriggerMessage', String(r?.status ?? 'no answer'), { requestedMessage: 'SignV2GCertificate', reason: 'renewal', daysLeft: days });
      triggered++;
    } catch (e) {
      await logEvent(d.org_id, d.id, 'TriggerMessage', 'failed', { reason: (e as Error).message });
    }
  }
  return { triggered, alerted };
}
