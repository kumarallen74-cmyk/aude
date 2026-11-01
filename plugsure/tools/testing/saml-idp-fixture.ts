import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A TEST-ONLY SAML identity provider (v1.42.0): a fresh key pair and self-signed certificate made with openssl when the
 * tests start (nothing secret is kept in the repository), and a second key that stands for an attacker.
 */
function make(cn: string): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'saml-idp-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '3650', '-subj', `/CN=${cn}`], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const idp = make('PlugSure SAML test IdP');
const other = make('Attacker IdP');
export const IDP_KEY = idp.key;
export const IDP_CERT = idp.cert;
export const OTHER_KEY = other.key;
