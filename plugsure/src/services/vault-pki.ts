import { X509Certificate } from 'node:crypto';
import { config } from '../config.js';

/**
 * OCPP Security Profile 3 client certificates from HashiCorp Vault's PKI engine
 * (SPEC Module 1, step 3 — "Vault PKI Issuance").
 *
 * Vault signs a certificate for the charge point identity and returns the
 * private key ONCE. PlugSure hands the bundle to the operator for installation
 * on the charger and keeps only the SHA-256 fingerprint — the same binding the
 * manual Profile 3 path stores (migration 008). The private key is never
 * written anywhere by this process.
 *
 *   POST {VAULT_ADDR}/v1/{VAULT_PKI_MOUNT}/issue/{VAULT_PKI_ROLE}
 *        { common_name: <identity>, ttl: VAULT_CERT_TTL }
 *
 * The role must allow the charger identities as common names (allow_any_name,
 * or allowed_domains + allow_bare_domains to taste) and client_flag=true.
 */

export function vaultConfigured(): boolean {
  return Boolean(config.vault.addr && config.vault.token);
}

export interface IssuedBundle {
  certificatePem: string;
  privateKeyPem: string;
  caPem: string;
  caChainPem: string[];
  serialNumber: string;
  expiresAt: string | null;
  fingerprint: string;
}

/** SHA-256 fingerprint of a PEM certificate: 64 lowercase hex, no colons. */
export function fingerprintOfPem(pem: string): string | null {
  try {
    const cert = new X509Certificate(pem);
    return cert.fingerprint256.replace(/:/g, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Parse the facts the console shows about an uploaded or issued certificate. */
export function describePem(pem: string) {
  try {
    const c = new X509Certificate(pem);
    return {
      subject: c.subject,
      issuer: c.issuer,
      validFrom: new Date(c.validFrom).toISOString(),
      validTo: new Date(c.validTo).toISOString(),
      serialNumber: c.serialNumber,
      fingerprint: c.fingerprint256.replace(/:/g, '').toLowerCase(),
    };
  } catch {
    return null;
  }
}

export async function issueClientCertificate(identity: string): Promise<IssuedBundle> {
  if (!vaultConfigured()) {
    throw Object.assign(
      new Error(
        'Vault PKI is not configured. Set VAULT_ADDR, VAULT_TOKEN, VAULT_PKI_MOUNT and VAULT_PKI_ROLE, or bind a ' +
          'certificate you issued elsewhere by pasting its PEM or fingerprint.',
      ),
      { statusCode: 501, expose: true },
    );
  }
  const url = `${config.vault.addr}/v1/${config.vault.pkiMount}/issue/${encodeURIComponent(config.vault.role)}`;
  const headers: Record<string, string> = { 'X-Vault-Token': config.vault.token, 'content-type': 'application/json' };
  if (config.vault.namespace) headers['X-Vault-Namespace'] = config.vault.namespace;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ common_name: identity, ttl: config.vault.ttl, format: 'pem' }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw Object.assign(new Error(`Vault is unreachable: ${(e as Error).message}`), { statusCode: 502, expose: true });
  }
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const why = Array.isArray(body?.errors) ? body.errors.join('; ') : `HTTP ${res.status}`;
    throw Object.assign(new Error(`Vault refused to issue the certificate: ${why}`), { statusCode: 502, expose: true });
  }
  const d = body?.data ?? {};
  const certificatePem = String(d.certificate ?? '');
  const fingerprint = fingerprintOfPem(certificatePem);
  if (!fingerprint || !d.private_key) {
    throw Object.assign(new Error('Vault returned an incomplete certificate bundle'), { statusCode: 502, expose: true });
  }
  return {
    certificatePem,
    privateKeyPem: String(d.private_key),
    caPem: String(d.issuing_ca ?? ''),
    caChainPem: Array.isArray(d.ca_chain) ? d.ca_chain.map(String) : [],
    serialNumber: String(d.serial_number ?? ''),
    expiresAt: d.expiration ? new Date(Number(d.expiration) * 1000).toISOString() : null,
    fingerprint,
  };
}
