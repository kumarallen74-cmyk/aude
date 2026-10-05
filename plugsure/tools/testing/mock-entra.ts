import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';

/**
 * TEST SUPPORT ONLY: a mock Microsoft Entra ID (OpenID Connect) provider on a local HTTP
 * port, for "Sign in with Microsoft" (src/services/microsoft-signin.ts). Point
 * MS_AUTHORITY_BASE at `mock.base`. It serves what the real one does, at the same paths:
 *
 *   GET  /organizations/v2.0/.well-known/openid-configuration
 *   GET  /organizations/discovery/v2.0/keys                    (JWKS)
 *   GET  /organizations/oauth2/v2.0/authorize                  → 302 to redirect_uri?code&state
 *   POST /organizations/oauth2/v2.0/token                      code + PKCE + client secret → id_token
 *
 * "Who signs in" at the authorize step is `mock.nextIdentity` (or an error, `mock.nextError`);
 * `mock.tamper` rewrites the next ID token's claims or header for negative tests; `mint()`
 * signs any token directly. The token endpoint checks the client secret, the redirect URI,
 * the PKCE verifier and single use of the code, like Entra.
 *
 * The outbound guard lets the API reach it only because NODE_ENV is development/test there
 * (loopback http is refused in production, and MS_AUTHORITY_BASE must be a Microsoft host).
 */

export interface MockIdentity {
  tid: string;
  oid: string;
  preferred_username?: string;
  email?: string;
  name?: string;
  amr?: string[];
  /** Directory role template ids (the "Directory roles" groups claim). */
  wids?: string[];
  /** Optional claim: 0 member, 1 guest. */
  acct?: number;
  /** The identity provider, for a guest from elsewhere. */
  idp?: string;
  /** Optional claim: the email's domain is verified by the user's tenant. */
  xms_edov?: boolean | string;
}

/** Entra role template ids, for tests. */
export const ENTRA_ROLES = {
  globalAdministrator: '62e90394-69f5-4237-9190-012177145e10',
  applicationAdministrator: '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3',
  /** Not an administrator role that may connect a tenant. */
  userAdministrator: 'fe930be7-5e62-47db-91af-98c3a49a38b1',
  /** "User" — present in wids for every member. */
  member: 'b79fbf4d-3ef9-4689-8143-76b194e85509',
};

export interface MockKey { kid: string; privateKey: KeyObject; jwk: Record<string, unknown> }

export function newKey(kid = `k-${randomBytes(4).toString('hex')}`): MockKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, use: 'sig', kty: 'RSA', alg: 'RS256' };
  return { kid, privateKey, jwk };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export class MockEntra {
  server!: http.Server;
  base = '';
  clientId = '';
  clientSecret = '';
  /** Keys published in the JWKS; the first signs. */
  keys: MockKey[] = [newKey()];
  nextIdentity: MockIdentity | null = null;
  nextError: { error: string; error_description?: string } | null = null;
  /** Rewrites the next ID token(s) before signing: return a new header/payload. Cleared after use when `tamperOnce`. */
  tamper: ((t: { header: Record<string, unknown>; payload: Record<string, unknown> }) => void) | null = null;
  /** Counters for assertions. */
  jwksFetches = 0;
  tokenRequests = 0;
  /** The last token request's form (the test checks the code verifier and secret arrived). */
  lastTokenForm: Record<string, string> | null = null;
  private codes = new Map<string, { identity: MockIdentity; nonce: string; challenge: string; redirectUri: string; clientId: string }>();

  constructor(opts: { clientId?: string; clientSecret?: string } = {}) {
    this.clientId = opts.clientId ?? randomUUID();
    this.clientSecret = opts.clientSecret ?? `secret-${randomBytes(12).toString('hex')}`;
  }

  /** `host`: another loopback address (127.0.0.2) makes the mock a different SITE from a console on 127.0.0.1. */
  async start(port = 0, host = '127.0.0.1'): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res).catch((e) => { res.statusCode = 500; res.end(String(e)); }));
    await new Promise<void>((r) => this.server.listen(port, host, r));
    this.base = `http://${host}:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  issuerFor(tid: string) {
    return `${this.base}/${tid}/v2.0`;
  }

  /** Sign a token with the current (or the given) key. */
  mint(payload: Record<string, unknown>, opts: { key?: MockKey; header?: Record<string, unknown> } = {}): string {
    const key = opts.key ?? this.keys[0]!;
    const header = { alg: 'RS256', typ: 'JWT', kid: key.kid, ...(opts.header ?? {}) };
    const input = `${b64(header)}.${b64(payload)}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), key.privateKey).toString('base64url')}`;
  }

  /** The claims Entra would put in an ID token for this identity. */
  claimsFor(id: MockIdentity, nonce: string, nowS = Math.floor(Date.now() / 1000)): Record<string, unknown> {
    return {
      ver: '2.0',
      iss: this.issuerFor(id.tid),
      sub: createHash('sha256').update(id.oid).digest('base64url').slice(0, 43),
      aud: this.clientId,
      exp: nowS + 3600,
      iat: nowS,
      nbf: nowS,
      nonce,
      tid: id.tid,
      oid: id.oid,
      ...(id.preferred_username ? { preferred_username: id.preferred_username } : {}),
      ...(id.email ? { email: id.email } : {}),
      name: id.name ?? 'Mock User',
      ...(id.amr ? { amr: id.amr } : {}),
      ...(id.wids ? { wids: id.wids } : {}),
      ...(id.acct !== undefined ? { acct: id.acct } : {}),
      ...(id.idp ? { idp: id.idp } : {}),
      ...(id.xms_edov !== undefined ? { xms_edov: id.xms_edov } : {}),
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const u = new URL(req.url ?? '/', this.base);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && u.pathname === '/organizations/v2.0/.well-known/openid-configuration') {
      return json(200, {
        issuer: `${this.base}/{tenantid}/v2.0`,
        authorization_endpoint: `${this.base}/organizations/oauth2/v2.0/authorize`,
        token_endpoint: `${this.base}/organizations/oauth2/v2.0/token`,
        jwks_uri: `${this.base}/organizations/discovery/v2.0/keys`,
        response_modes_supported: ['query', 'fragment', 'form_post'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    if (req.method === 'GET' && u.pathname === '/organizations/discovery/v2.0/keys') {
      this.jwksFetches++;
      return json(200, { keys: this.keys.map((k) => ({ ...k.jwk, issuer: `${this.base}/{tenantid}/v2.0` })) });
    }
    if (req.method === 'GET' && u.pathname === '/organizations/oauth2/v2.0/authorize') {
      const p = u.searchParams;
      const redirect = new URL(p.get('redirect_uri') ?? '');
      redirect.searchParams.set('state', p.get('state') ?? '');
      if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge') || !p.get('nonce')) {
        redirect.searchParams.set('error', 'invalid_request');
      } else if (this.nextError) {
        redirect.searchParams.set('error', this.nextError.error);
        if (this.nextError.error_description) redirect.searchParams.set('error_description', this.nextError.error_description);
      } else if (!this.nextIdentity) {
        redirect.searchParams.set('error', 'access_denied');
      } else {
        const code = `code-${randomBytes(16).toString('hex')}`;
        this.codes.set(code, {
          identity: this.nextIdentity,
          nonce: p.get('nonce')!,
          challenge: p.get('code_challenge')!,
          redirectUri: p.get('redirect_uri')!,
          clientId: p.get('client_id') ?? '',
        });
        redirect.searchParams.set('code', code);
      }
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }
    if (req.method === 'POST' && u.pathname === '/organizations/oauth2/v2.0/token') {
      this.tokenRequests++;
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      this.lastTokenForm = form;
      const rec = this.codes.get(form.code ?? '');
      this.codes.delete(form.code ?? '');
      if (form.client_id !== this.clientId || form.client_secret !== this.clientSecret) {
        return json(401, { error: 'invalid_client', error_codes: [7000215] });
      }
      if (!rec || form.grant_type !== 'authorization_code' || rec.redirectUri !== form.redirect_uri || rec.clientId !== form.client_id) {
        return json(400, { error: 'invalid_grant', error_codes: [70008] });
      }
      if (createHash('sha256').update(form.code_verifier ?? '').digest('base64url') !== rec.challenge) {
        return json(400, { error: 'invalid_grant', error_codes: [501481] });
      }
      const t = { header: { alg: 'RS256', typ: 'JWT', kid: this.keys[0]!.kid } as Record<string, unknown>, payload: this.claimsFor(rec.identity, rec.nonce) };
      this.tamper?.(t);
      const input = `${b64(t.header)}.${b64(t.payload)}`;
      const sig = sign('RSA-SHA256', Buffer.from(input), this.keys[0]!.privateKey).toString('base64url');
      return json(200, { token_type: 'Bearer', scope: form.scope, expires_in: 3600, id_token: `${input}.${sig}`, access_token: 'opaque-access-token' });
    }
    json(404, { error: 'not found' });
  }
}
