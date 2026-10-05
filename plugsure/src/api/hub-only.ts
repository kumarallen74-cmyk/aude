import { one } from '../db/pool.js';

/**
 * Hub-only organisations (migration 072, `organisation.hub_only`): the organisation of an EXTERNAL PlugSure Hub
 * member. It has no CSMS here — its console shows the hub views only — and the server enforces the same: a
 * session or API key of a hub-only organisation may call only the routes below; everything else is 403.
 *
 *   /v1/auth/*                      sign-in, session, two-step verification, Microsoft sign-in
 *   GET /v1/meta, /v1/stream, /v1/events/*, /v1/alerts*   the console shell (its own events and hub alerts)
 *   /v1/users*, GET /v1/roles       Users & roles
 *   /v1/api-keys*, /v1/webhooks*    Developers (an integration with the member clearing API; alert webhooks)
 *   GET /v1/roaming                 the Roaming page's header data (read-only)
 *   /v1/roaming/hub, /v1/roaming/hub/*   its membership and the member clearing API
 */
export function hubOnlyAllowed(method: string, path: string): boolean {
  const p = path.split('?')[0]!;
  const get = method === 'GET' || method === 'HEAD';
  const under = (prefix: string) => p === prefix || p.startsWith(`${prefix}/`);
  if (under('/v1/auth')) return true;
  if (get && (p === '/v1/meta' || p === '/v1/stream' || under('/v1/events'))) return true;
  if (under('/v1/alerts')) return true;
  if (under('/v1/users') || (get && p === '/v1/roles')) return true;
  if (under('/v1/api-keys') || under('/v1/webhooks')) return true;
  if (get && p === '/v1/roaming') return true;
  if (under('/v1/roaming/hub')) return true;
  return false;
}

export const HUB_ONLY_MESSAGE = 'this organisation is a PlugSure Hub member without a CSMS: only the hub, users, API keys and webhooks are available';

const cache = new Map<string, { hubOnly: boolean; at: number }>();
const TTL_MS = 60_000;

/** Whether an organisation is hub-only (cached for a minute; the flag is set when the member is created). */
export async function isHubOnlyOrg(orgId: string | null | undefined): Promise<boolean> {
  if (!orgId) return false;
  const c = cache.get(orgId);
  if (c && Date.now() - c.at < TTL_MS) return c.hubOnly;
  const r = await one<{ hub_only: boolean }>(`SELECT hub_only FROM organisation WHERE id = $1`, [orgId]).catch(() => null);
  const hubOnly = r?.hub_only === true;
  cache.set(orgId, { hubOnly, at: Date.now() });
  if (cache.size > 10_000) cache.clear();
  return hubOnly;
}
