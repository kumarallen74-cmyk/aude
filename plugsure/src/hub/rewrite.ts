import { randomBytes } from 'node:crypto';
import { seal, unseal } from '../services/secrets.js';
import { OCPI_VERSION } from '../ocpi/mapping.js';

/**
 * URL rewrites (design D8, §5.6). A member can never reach another member directly, so every URL one member
 * hands the other through the hub is replaced by a hub URL the hub maps back:
 *   - pagination Link (direct GET and GET All) → `…/sender/{module}?hub_cursor=C`, C a sealed cursor bound to
 *     the requesting connection, expiring after an hour;
 *   - command / charging-profile `response_url` → `…/sender/commands/{TYPE}/{cbId}` or
 *     `…/sender/chargingprofiles/result/{cbId}` (hub_callback row);
 *   - the eMSP's CDR `Location` → `…/receiver/cdrs/{cbId}` (hub_callback row, kind cdr_location).
 */

export const CURSOR_AAD = 'hub-cursor';
export const CURSOR_TTL_MS = 60 * 60_000;

export interface Cursor {
  v: 1;
  /** The requesting connection: another member's token cannot use it. */
  conn: string;
  kind: 'direct' | 'all';
  module: string;
  /** The requesting party (hub_party.id). */
  from: string;
  /** Source parties (hub_party.id), in order. */
  src: string[];
  /** Index of the source being read. */
  i: number;
  /** Upstream URL of the next page of source i; null = source i from the start (original query). */
  next: string | null;
  /** Original query string (filters), without offset / limit / hub_cursor. */
  q: string;
  limit: number;
  /** X-Total-Count across all sources (GET All), fixed at the first page. */
  total: number | null;
  exp: number;
}

export function sealCursor(c: Omit<Cursor, 'v' | 'exp'> & { exp?: number }, now = Date.now()): string {
  const full: Cursor = { v: 1, ...c, exp: c.exp ?? now + CURSOR_TTL_MS };
  return Buffer.from(seal(JSON.stringify(full), CURSOR_AAD), 'utf8').toString('base64url');
}

export type CursorProblem = 'malformed' | 'expired' | 'other_connection';

export function openCursor(token: string, connectionId: string, now = Date.now()): Cursor | CursorProblem {
  let c: Cursor;
  try {
    c = JSON.parse(unseal(Buffer.from(token, 'base64url').toString('utf8'), CURSOR_AAD));
  } catch { return 'malformed'; }
  if (!c || c.v !== 1 || !Array.isArray(c.src) || typeof c.i !== 'number') return 'malformed';
  if (c.conn !== connectionId) return 'other_connection';
  if (!(c.exp > now)) return 'expired';
  return c;
}

export const hubUrl = (base: string, rest: string) => `${base}/hub/ocpi/${OCPI_VERSION}/${rest}`;
export const cursorUrl = (base: string, module: string, token: string) => hubUrl(base, `sender/${module}?hub_cursor=${token}`);
export const linkNext = (url: string) => `<${url}>; rel="next"`;

/** The rel="next" URL of a Link header, or null. */
export function parseLinkNext(link: unknown): string | null {
  const s = Array.isArray(link) ? link.join(', ') : typeof link === 'string' ? link : '';
  for (const part of s.split(/,(?=\s*<)/)) {
    const m = /<([^>]+)>\s*;(.*)$/.exec(part.trim());
    if (m && /rel="?next"?/i.test(m[2]!)) return m[1]!;
  }
  return null;
}

export function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

/** The original query with paging parameters (and the hub's own) removed; `limit` capped at 100. */
export function filtersOf(query: Record<string, unknown>): { q: string; limit: number } {
  const p = new URLSearchParams();
  let limit = 100;
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v == null) continue;
    if (k === 'limit') { const n = Math.floor(Number(v)); if (Number.isFinite(n) && n > 0) limit = Math.min(n, 100); continue; }
    if (k === 'offset' || k === 'hub_cursor') continue;
    p.append(k, String(Array.isArray(v) ? v[0] : v));
  }
  return { q: p.toString(), limit };
}

export function withQuery(url: string, q: string, limit: number, offset?: number): string {
  const u = new URL(url);
  for (const [k, v] of new URLSearchParams(q)) u.searchParams.set(k, v);
  u.searchParams.set('limit', String(limit));
  if (offset != null) u.searchParams.set('offset', String(offset));
  return u.toString();
}

/** A callback id: 128 random bits, the only secret in a callback URL. */
export const newCallbackId = () => randomBytes(16).toString('base64url');

export const commandCallbackUrl = (base: string, command: string, id: string) => hubUrl(base, `sender/commands/${encodeURIComponent(command)}/${id}`);
export const profileCallbackUrl = (base: string, id: string) => hubUrl(base, `sender/chargingprofiles/result/${id}`);
export const cdrLocationUrl = (base: string, id: string) => hubUrl(base, `receiver/cdrs/${id}`);

/** The body with its response_url replaced (a copy; nothing else is touched). */
export function withResponseUrl<T extends Record<string, unknown>>(body: T, url: string): T {
  return { ...body, response_url: url };
}

/** The query string with response_url replaced (charging profiles GET / DELETE). */
export function queryWithResponseUrl(query: Record<string, unknown>, url: string): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v != null && k !== 'response_url') p.append(k, String(v));
  p.set('response_url', url);
  return p.toString();
}
