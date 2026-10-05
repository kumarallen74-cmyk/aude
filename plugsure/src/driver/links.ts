import { one, many } from '../db/pool.js';
import { resolveCode, type ConnectorView } from './stations.js';
import { emspOrgForApp } from './roaming-pay.js';

/**
 * Deep links and charger QR codes (docs/MOBILE-APP-SPEC.md §6.11, §13.1, G6).
 *
 * Link domain paths (served by the API too, as the web fallback when the app is not installed):
 *   /c/<code>              a charger QR sticker (connector UUID, IDENTITY:n, IDENTITY/n, identity, SPKLU id, partner EVSE id)
 *   /s/<siteId>            a shared station
 *   /r/<charge|partner>/<id>  a receipt
 *   /paid?for=…            back from a payment
 *   /app/…                 the web app's own links: ?code= / ?c= / #c/<code>, #s/<chargeId>, #r/<chargeId>, #rr/<cdrId>
 * Any other URL: its `code` / `c` parameter, else its last path segment (the PWA's rule, so stickers printed by
 * operators keep working). Not a URL: the text itself is the code.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedLink =
  | { kind: 'code'; code: string }
  | { kind: 'site'; siteId: string }
  | { kind: 'charge'; chargeId: string }
  | { kind: 'receipt'; chargeId: string }
  | { kind: 'partner_receipt'; cdrId: string }
  | { kind: 'payment_return'; for: string | null };

/** What a scanned or tapped link (or a typed code) points at, without looking anything up. */
export function parseLink(raw: string): ParsedLink | null {
  const text = String(raw ?? '').trim().slice(0, 2048);
  if (!text) return null;
  if (!/^https?:\/\//i.test(text) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { kind: 'code', code: text };
  let u: URL;
  try { u = new URL(text); } catch { return { kind: 'code', code: text }; }
  // A custom scheme (plugsure://c/CODE): the host is the first path segment.
  const segs = (u.protocol === 'http:' || u.protocol === 'https:' ? u.pathname : `/${u.host}${u.pathname}`).split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  const hash = u.hash.replace(/^#/, '');
  const first = segs[0] ?? '';
  if (first === 'c' && segs[1]) return { kind: 'code', code: segs.slice(1).join('/') };
  if (first === 's' && segs[1] && UUID.test(segs[1])) return { kind: 'site', siteId: segs[1].toLowerCase() };
  if (first === 'r' && segs.length >= 2) {
    const [kind, id] = segs.length >= 3 ? [segs[1], segs[2]] : ['charge', segs[1]];
    if (id && UUID.test(id)) return kind === 'partner' ? { kind: 'partner_receipt', cdrId: id.toLowerCase() } : { kind: 'receipt', chargeId: id.toLowerCase() };
  }
  if (first === 'paid' || (first === 'app' && segs[1] === 'paid.html')) return { kind: 'payment_return', for: u.searchParams.get('for') };
  const code = u.searchParams.get('code') || u.searchParams.get('c');
  if (code) return { kind: 'code', code };
  if (hash.startsWith('c/')) {
    try { return { kind: 'code', code: decodeURIComponent(hash.slice(2)) }; } catch { return { kind: 'code', code: hash.slice(2) }; }
  }
  const h = /^(s|r|rr)\/([0-9a-f-]{36})$/i.exec(hash);
  if (h && UUID.test(h[2]!)) {
    const id = h[2]!.toLowerCase();
    return h[1] === 's' ? { kind: 'charge', chargeId: id } : h[1] === 'r' ? { kind: 'receipt', chargeId: id } : { kind: 'partner_receipt', cdrId: id };
  }
  if (first === 'app' && segs.length === 1) return null; // the app's home page, no target
  const last = segs[segs.length - 1];
  return last ? { kind: 'code', code: last } : null;
}

/** An EVSE id as printed (ID*ABC*E123, IDABCE123): letters and digits only, upper case, for comparison. */
export const normEvseId = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export type ResolvedLink =
  | { kind: 'connector'; path: 'direct'; connectorId: string; siteId: string | null; connector: ConnectorView }
  | { kind: 'partner_evse'; path: 'roaming'; name: string; operator: string | null; status: string | null;
      partner: { partnerId: string; countryCode: string; partyId: string; locationId: string; evseUid: string; connectorId: string | null } }
  | Exclude<ParsedLink, { kind: 'code' }>;

/**
 * Resolve a link for this app: a hosted charger (as /d/v1/resolve), else an EVSE of a partner network the app's
 * eMSP organisation receives (its printed EVSE id), else the non-charger targets as parsed.
 */
export async function resolveLink(raw: string, ctx: { scopeOrg: string | null; emspBrandOrg: string | null }): Promise<ResolvedLink | 'other_operator' | null> {
  const p = parseLink(raw);
  if (!p) return null;
  if (p.kind !== 'code') return p;
  const hosted = await resolveCode(p.code, ctx.scopeOrg);
  if (hosted === 'other_operator') return hosted;
  if (hosted) {
    const site = await one<{ site_id: string }>(
      `SELECT cp.site_id FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id WHERE c.id = $1`, [hosted.connectorId]);
    return { kind: 'connector', path: 'direct', connectorId: hosted.connectorId, siteId: site?.site_id ?? null, connector: hosted };
  }
  const emsp = await emspOrgForApp(ctx.emspBrandOrg);
  const want = normEvseId(p.code);
  if (!emsp || want.length < 5) return null;
  // The EVSE's printed id inside the partner's location (a GIN index is not needed: one eMSP's locations, by evse_id).
  const rows = await many<{ partner_id: string; partner_name: string; country_code: string; party_id: string; location_id: string; data: any }>(
    `SELECT l.partner_id, pa.name AS partner_name, l.country_code, l.party_id, l.location_id, l.data
       FROM ocpi_remote_location l JOIN ocpi_partner pa ON pa.id = l.partner_id
      WHERE l.org_id = $1 AND pa.state = 'connected'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(l.data->'evses', '[]'::jsonb)) ev
                     WHERE upper(regexp_replace(COALESCE(ev->>'evse_id', ''), '[^A-Za-z0-9]', '', 'g')) = $2 OR ev->>'uid' = $3)
      LIMIT 1`,
    [emsp, want, p.code]);
  const r = rows[0];
  if (!r) return null;
  const evse = (r.data?.evses ?? []).find((e: any) => normEvseId(String(e.evse_id ?? '')) === want || e.uid === p.code);
  return {
    kind: 'partner_evse', path: 'roaming', name: String(r.data?.name ?? r.location_id), operator: r.data?.operator?.name ?? r.partner_name, status: evse?.status ?? null,
    partner: { partnerId: r.partner_id, countryCode: r.country_code, partyId: r.party_id, locationId: r.location_id, evseUid: String(evse?.uid ?? ''),
      connectorId: evse?.connectors?.[0]?.id != null ? String(evse.connectors[0].id) : null },
  };
}

/** Where the web fallback of a link domain path goes (the PWA's own routes). */
export function webFallback(p: ParsedLink | null, query = ''): string {
  if (!p) return '/app/';
  switch (p.kind) {
    case 'code': return `/app/#c/${encodeURIComponent(p.code)}`;
    case 'charge': return `/app/#s/${p.chargeId}`;
    case 'receipt': return `/app/#r/${p.chargeId}`;
    case 'partner_receipt': return `/app/#rr/${p.cdrId}`;
    case 'payment_return': return `/app/paid.html${query}`;
    case 'site': return '/app/#home';
  }
}
