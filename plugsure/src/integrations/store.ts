import { randomBytes } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { seal, unseal } from '../services/secrets.js';
import { CATALOGUE, kindDef, providerDef, type Kind } from './catalogue.js';

/**
 * Integration settings: the console's (a row in `integration`) over the
 * environment's, over the built-in default.
 *
 * Resolution for a kind and an organisation:
 *   1. the organisation's own row (kinds with scope 'org', e.g. its own QRIS merchant)
 *   2. the platform row (org_id NULL)
 *   3. environment variables (what v1.3 used before this page existed)
 *   4. the default: test doubles outside production, nothing in production
 *
 * Secrets are sealed with SECRETS_KEY and only ever returned inside the server.
 * Both processes (API and gateway) read the table; a change is picked up within
 * CACHE_MS by the other one.
 */

export class IntegrationError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export interface Resolved {
  kind: Kind;
  provider: string;
  settings: Record<string, any>;
  secrets: Record<string, string>;
  integrationId: string | null;
  orgId: string | null;
  source: 'console' | 'environment' | 'default';
  webhookKey: string | null;
}

interface Row {
  id: string; org_id: string | null; kind: Kind; provider: string; settings: Record<string, any>; secrets_sealed: string | null;
  secret_hints: Record<string, string>; enabled: boolean; webhook_key: string | null; last_test_at: Date | null; last_test_ok: boolean | null;
  last_test_message: string | null; updated_at: Date;
}

const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; value: Resolved | null }>();
const isProd = () => config.env === 'production';

export function invalidate() { cache.clear(); }

function fromRow(r: Row): Resolved {
  let secrets: Record<string, string> = {};
  if (r.secrets_sealed) { try { secrets = JSON.parse(unseal(r.secrets_sealed)); } catch (e) { logger.error({ kind: r.kind, err: (e as Error).message }, 'integration secrets cannot be unsealed (SECRETS_KEY changed?)'); } }
  return { kind: r.kind, provider: r.provider, settings: r.settings ?? {}, secrets, integrationId: r.id, orgId: r.org_id, source: 'console', webhookKey: r.webhook_key };
}

/** Environment variables and defaults, as before this page existed. */
function fromEnv(kind: Kind): Resolved | null {
  const base = { kind, integrationId: null, orgId: null, webhookKey: null } as const;
  switch (kind) {
    case 'payments':
      return isProd() ? null : { ...base, provider: 'mock', settings: {}, secrets: {}, source: 'default' };
    case 'otp':
      return isProd() ? null : { ...base, provider: 'dev', settings: {}, secrets: {}, source: 'default' };
    case 'otp_fallback':
      return null;
    case 'pnc_pki': {
      const mode = config.pnc.pki === 'mock' && isProd() ? 'none' : config.pnc.pki;
      const source = process.env.PNC_PKI ? 'environment' : 'default';
      if (mode === 'http') return { ...base, provider: 'http', settings: { url: config.pnc.pkiUrl, signer: config.pnc.signer, vaultMount: config.pnc.vaultMount, vaultRole: config.pnc.vaultRole }, secrets: { token: config.pnc.pkiToken }, source };
      return { ...base, provider: mode === 'mock' ? 'mock' : 'none', settings: { signer: config.pnc.signer, vaultMount: config.pnc.vaultMount, vaultRole: config.pnc.vaultRole }, secrets: {}, source };
    }
    case 'map_tiles':
      return process.env.MAP_TILE_URL
        ? { ...base, provider: 'custom', settings: { tileUrl: config.driverApp.mapTileUrl, attribution: config.driverApp.mapAttribution, maxZoom: 19 }, secrets: {}, source: 'environment' }
        : { ...base, provider: 'osm', settings: { tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', maxZoom: 19 }, secrets: {}, source: 'default' };
  }
}

/** The settings in force for a kind (and organisation, for per-operator kinds). Null = not configured. */
export async function resolve(kind: Kind, orgId: string | null = null): Promise<Resolved | null> {
  const def = kindDef(kind)!;
  const key = `${kind}:${def.scope === 'org' ? orgId ?? '' : ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const rows = await outsideRequestScope(() => many<Row>(
    `SELECT * FROM integration WHERE kind = $1 AND enabled AND archived_at IS NULL AND (org_id IS NULL OR org_id = $2::uuid)
      ORDER BY (org_id IS NULL) ASC`,
    [kind, def.scope === 'org' ? orgId : null],
  ));
  let value: Resolved | null = rows[0] ? fromRow(rows[0]) : fromEnv(kind);
  // A test double stored in the table is ignored in production.
  if (value && isProd() && providerDef(kind, value.provider)?.devOnly) value = kind === 'payments' || kind === 'otp' ? null : fromEnv(kind);
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** The account behind a payment webhook URL. */
export async function byWebhookKey(key: string): Promise<Resolved | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(key)) return null;
  const r = await outsideRequestScope(() => one<Row>(`SELECT * FROM integration WHERE webhook_key = $1 AND kind = 'payments'`, [key]));
  return r ? fromRow(r) : null;
}

/** The account that took a payment, by its id (refunds); null → the current one for the organisation. */
export async function byId(id: string): Promise<Resolved | null> {
  const r = await outsideRequestScope(() => one<Row>(`SELECT * FROM integration WHERE id = $1`, [id]));
  return r ? fromRow(r) : null;
}

// ================================================================== console view

const hint = (v: string) => (v.length <= 4 ? '••••' : `••••${v.slice(-4)}`);

function publicView(r: Row | null) {
  if (!r) return null;
  return {
    id: r.id, scope: r.org_id ? 'org' : 'platform', provider: r.provider, settings: r.settings, secretHints: r.secret_hints,
    enabled: r.enabled, webhookPath: r.webhook_key ? `/pay/notify/${r.webhook_key}` : null,
    lastTest: r.last_test_at ? { at: r.last_test_at, ok: r.last_test_ok, message: r.last_test_message } : null, updatedAt: r.updated_at,
  };
}

/** Every kind with what is configured for this organisation and the platform, and what is in force. Secrets are never included. */
export async function overview(orgId: string, isPlatformAdmin: boolean) {
  const rows = await outsideRequestScope(() => many<Row>(`SELECT * FROM integration WHERE archived_at IS NULL AND (org_id IS NULL OR org_id = $1)`, [orgId]));
  const out = [];
  for (const def of CATALOGUE) {
    const own = def.scope === 'org' ? rows.find((r) => r.kind === def.kind && r.org_id === orgId) ?? null : null;
    const platform = rows.find((r) => r.kind === def.kind && r.org_id === null) ?? null;
    const eff = await resolve(def.kind, orgId);
    out.push({
      kind: def.kind, label: def.label, description: def.description, scope: def.scope,
      providers: def.providers.filter((p) => !(p.devOnly && isProd())).map((p) => ({ ...p })),
      own: publicView(own),
      // The platform's account: its settings are the platform operator's business.
      platform: platform ? (isPlatformAdmin ? publicView(platform) : { scope: 'platform', provider: platform.provider, enabled: platform.enabled }) : null,
      effective: eff ? { provider: eff.provider, source: eff.source, scope: eff.orgId ? 'org' : eff.source === 'console' ? 'platform' : eff.source } : null,
      editable: def.scope === 'org' ? true : isPlatformAdmin,
    });
  }
  return { kinds: out, production: isProd() };
}

// ================================================================== saving

export interface SaveInput {
  provider: string;
  settings?: Record<string, unknown>;
  /** Only the secrets being set or changed; an empty or missing field keeps the stored one. */
  secrets?: Record<string, string>;
  enabled?: boolean;
}

export async function save(kind: Kind, orgId: string | null, input: SaveInput, userId: string | null): Promise<ReturnType<typeof publicView>> {
  const def = kindDef(kind);
  if (!def) throw new IntegrationError(404, 'unknown integration');
  const p = providerDef(kind, String(input.provider ?? ''));
  if (!p) throw new IntegrationError(422, `provider must be one of: ${def.providers.map((x) => x.id).join(', ')}`);
  if (p.devOnly && isProd()) throw new IntegrationError(422, `${p.label} is a test double and is not available in production.`);
  const existing = await outsideRequestScope(() => one<Row>(`SELECT * FROM integration WHERE kind = $1 AND org_id IS NOT DISTINCT FROM $2::uuid AND archived_at IS NULL`, [kind, orgId]));
  const sameProvider = existing?.provider === p.id;
  const oldSecrets: Record<string, string> = sameProvider && existing?.secrets_sealed ? JSON.parse(unseal(existing.secrets_sealed)) : {};
  const settings: Record<string, unknown> = {};
  const secrets: Record<string, string> = { ...oldSecrets };
  const hints: Record<string, string> = sameProvider ? { ...(existing?.secret_hints ?? {}) } : {};
  for (const f of p.fields) {
    if (f.type === 'secret') {
      const v = input.secrets?.[f.key];
      if (typeof v === 'string' && v.trim()) { secrets[f.key] = v.trim(); hints[f.key] = hint(v.trim()); }
      if (f.required && !secrets[f.key]) throw new IntegrationError(422, `${f.label} is required.`);
      continue;
    }
    let v: unknown = input.settings?.[f.key];
    if (f.type === 'multiselect') {
      const allowed = (f.options ?? []).map((o) => o.value);
      const given = Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === '' ? (f.default as string[] | undefined) ?? [] : String(v).split(',');
      const bad = given.filter((x) => !allowed.includes(x));
      if (bad.length) throw new IntegrationError(422, `${f.label}: ${bad.join(', ')} is not offered by this provider (choose from ${allowed.join(', ')}).`);
      const picked = allowed.filter((x) => given.includes(x));
      if (f.required && !picked.length) throw new IntegrationError(422, `${f.label}: choose at least one.`);
      settings[f.key] = picked;
      continue;
    }
    if (v === undefined || v === null || v === '') v = f.default;
    if (f.type === 'number' && v !== undefined) { v = Number(v); if (!Number.isFinite(v as number)) throw new IntegrationError(422, `${f.label} must be a number.`); }
    if (f.type === 'boolean') v = v === true || v === 'true';
    if (typeof v === 'string') v = v.trim();
    if (f.required && (v === undefined || v === '')) throw new IntegrationError(422, `${f.label} is required.`);
    if (f.type === 'url' && typeof v === 'string' && v) {
      let u: URL;
      try { u = new URL(v); } catch { throw new IntegrationError(422, `${f.label} is not a valid URL.`); }
      if (u.protocol !== 'https:' && (isProd() || f.key === 'tileUrl')) throw new IntegrationError(422, `${f.label} must use https.`);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new IntegrationError(422, `${f.label} must be http(s).`);
    }
    if (v !== undefined) settings[f.key] = v;
  }
  if (kind === 'map_tiles' && p.id === 'custom' && !/\{z\}/.test(String(settings.tileUrl)) ) throw new IntegrationError(422, 'The tile URL must contain {z}, {x} and {y}.');
  if (kind === 'otp' || kind === 'otp_fallback') {
    if (p.id === 'twilio' && !settings.from && !settings.messagingServiceSid) throw new IntegrationError(422, 'Set the sender (From) or a Messaging Service SID.');
  }
  if (kind === 'payments' && p.id === 'snap') {
    const { createPrivateKey, createPublicKey } = await import('node:crypto');
    try { createPrivateKey(secrets.privateKeyPem!); } catch { throw new IntegrationError(422, 'Your RSA private key is not a valid PEM private key.'); }
    try { createPublicKey(String(settings.bankPublicKeyPem)); } catch { throw new IntegrationError(422, 'The bank public key is not a valid PEM public key.'); }
  }
  // Drop secrets the provider does not have (a provider change).
  for (const k of Object.keys(secrets)) if (!p.fields.some((f) => f.key === k && f.type === 'secret')) { delete secrets[k]; delete hints[k]; }
  // A different acquirer is a different account: the old one is archived, not overwritten, so the
  // payments it took still get its notifications (its URL keeps working) and its refunds.
  let keep = existing;
  if (existing && kind === 'payments' && !sameProvider) {
    await outsideRequestScope(() => query(`UPDATE integration SET archived_at = now(), enabled = false WHERE id = $1`, [existing.id]));
    keep = null;
  }
  const webhookKey = p.webhook ? keep?.webhook_key ?? randomBytes(24).toString('base64url') : null;
  const row = await outsideRequestScope(() => one<Row>(
    `INSERT INTO integration (org_id, kind, provider, settings, secrets_sealed, secret_hints, enabled, webhook_key, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), kind) WHERE archived_at IS NULL DO UPDATE
       SET provider = EXCLUDED.provider, settings = EXCLUDED.settings, secrets_sealed = EXCLUDED.secrets_sealed,
           secret_hints = EXCLUDED.secret_hints, enabled = EXCLUDED.enabled, webhook_key = EXCLUDED.webhook_key,
           updated_by = EXCLUDED.updated_by, updated_at = now(),
           last_test_at = CASE WHEN integration.provider = EXCLUDED.provider THEN integration.last_test_at END,
           last_test_ok = CASE WHEN integration.provider = EXCLUDED.provider THEN integration.last_test_ok END,
           last_test_message = CASE WHEN integration.provider = EXCLUDED.provider THEN integration.last_test_message END
     RETURNING *`,
    [orgId, kind, p.id, JSON.stringify(settings), Object.keys(secrets).length ? seal(JSON.stringify(secrets)) : null, JSON.stringify(hints), input.enabled !== false, webhookKey, userId],
  ));
  invalidate();
  return publicView(row);
}

/** Remove the console's settings: the environment (or default) applies again. */
export async function remove(kind: Kind, orgId: string | null): Promise<boolean> {
  // A QRIS account is archived (its payments keep their notifications and refunds); others are deleted.
  const r = await outsideRequestScope(() => query(
    kind === 'payments'
      ? `UPDATE integration SET archived_at = now(), enabled = false WHERE kind = $1 AND org_id IS NOT DISTINCT FROM $2::uuid AND archived_at IS NULL`
      : `DELETE FROM integration WHERE kind = $1 AND org_id IS NOT DISTINCT FROM $2::uuid AND archived_at IS NULL`,
    [kind, orgId],
  ));
  invalidate();
  return (r.rowCount ?? 0) > 0;
}

export async function recordTest(integrationId: string, ok: boolean, message: string) {
  await outsideRequestScope(() => query(`UPDATE integration SET last_test_at = now(), last_test_ok = $2, last_test_message = $3 WHERE id = $1`, [integrationId, ok, message.slice(0, 500)]));
}

// ================================================================== activity

export async function logEvent(r: Pick<Resolved, 'kind' | 'provider' | 'integrationId'>, orgId: string | null, action: string, outcome: string, detail: Record<string, unknown> = {}) {
  await outsideRequestScope(() => query(
    `INSERT INTO integration_event (integration_id, org_id, kind, provider, action, outcome, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [r.integrationId, orgId, r.kind, r.provider, action, outcome.slice(0, 80), JSON.stringify(detail)],
  )).catch((e) => logger.warn({ err: (e as Error).message }, 'integration event not recorded'));
}

export async function events(kind: Kind, orgId: string, isPlatformAdmin: boolean, limit = 50) {
  return outsideRequestScope(() => many(
    `SELECT id, kind, provider, action, outcome, detail, created_at FROM integration_event
      WHERE kind = $1 AND (org_id = $2 OR ($3 AND org_id IS NULL))
      ORDER BY id DESC LIMIT $4`,
    [kind, orgId, isPlatformAdmin, Math.min(Math.max(limit, 1), 200)],
  ));
}
