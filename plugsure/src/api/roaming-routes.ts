import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { one, many, query, afterResponse, outsideRequestScope } from '../db/pool.js';
import { logger } from '../logger.js';
import { assertCan } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import { getParty, setParty, getPartner, renderLocations, type PartnerRow } from '../ocpi/store.js';
import { createPartner, connectToPartner, closePartner, versionsUrlOf, RegistrationError, ocpiPublicBase } from '../ocpi/registration.js';
import { syncOrg, replayFailed } from '../ocpi/push.js';
import { setShared, importFromCpo, sendCommand, notifyCdr, EmspError, type OurCommand } from '../ocpi/emsp.js';
import { csvCell } from '../services/session-query.js';
import { listClients, pullHubClients } from '../ocpi/hubclients.js';
import { profileLimitAt, type ChargingProfileIn } from '../ocpi/mapping.js';
import { ampsToWatts } from '../services/smartcharging.js';

/**
 * The console's Roaming page: this operator's roaming identity, its partners,
 * which sites are shared, and what went to and from each partner.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTNER_COLS = `id, name, kind, state, versions_url, version, endpoints, roles, country_code, party_id,
                      last_error, last_success_at, registered_at, created_at`;

/**
 * Our OCPI origin: OCPI_PUBLIC_URL / PUBLIC_BASE_URL, never the request's Host
 * header (see ocpiPublicBase). Throws a RegistrationError (503) when it is not
 * configured outside development/test.
 */
const base = (req: FastifyRequest) => ocpiPublicBase(req as unknown as { protocol: string; headers: Record<string, unknown> });
/** The same, or null with the reason when it is not configured (for read-only views). */
const baseOrProblem = (req: FastifyRequest): { url: string | null; problem: string | null } => {
  try { return { url: base(req), problem: null }; } catch (e) { return { url: null, problem: (e as Error).message }; }
};

export async function registerRoamingRoutes(app: FastifyInstance): Promise<void> {
  const audit = (req: FastifyRequest, action: string, targetType: string, targetId: string, after?: Record<string, unknown>) =>
    writeAudit({ orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action, targetType, targetId, after: after ?? null, ip: req.ip });
  const bad = (reply: FastifyReply, status: number, error: string) => reply.status(status).send({ error });
  const org = (req: FastifyRequest) => req.principal.orgId;
  /**
   * Publish changes straight away, once this request's transaction has committed.
   * A partner that is new (or back from suspension) gets everything, not just
   * what changed since the last publish: it may never have seen any of it.
   */
  const syncSoon = (req: FastifyRequest, reply: FastifyReply, partnerId?: string) =>
    afterResponse(reply.raw, async () => {
      await syncOrg(org(req), { partnerId, forceAll: !!partnerId });
      // A CPO partner's network is imported too (eMSP role).
      const p = partnerId ? await getPartner(org(req), partnerId) : null;
      if (p) await importFromCpo(p);
      // A hub: who is behind it.
      if (p) await pullHubClients(p);
    }, (e) => logger.warn({ err: e.message }, 'roaming sync after console change failed'));

  async function partnerOr404(req: FastifyRequest, reply: FastifyReply): Promise<PartnerRow | null> {
    const { id } = req.params as { id: string };
    const p = UUID_RE.test(id) ? await getPartner(org(req), id) : null;
    if (!p) { bad(reply, 404, 'roaming partner not found'); return null; }
    return p;
  }

  app.get('/v1/roaming', async (req) => {
    assertCan(req.principal, { permission: 'roaming:read' });
    const party = await getParty(org(req));
    const partners = await many(
      `SELECT ${PARTNER_COLS},
              (SELECT count(*) FROM ocpi_push o WHERE o.partner_id = p.id AND o.state = 'pending')::int AS queued,
              (SELECT count(*) FROM ocpi_push o WHERE o.partner_id = p.id AND o.state = 'failed')::int AS failed,
              (SELECT count(*) FROM ocpi_token t WHERE t.partner_id = p.id)::int AS tokens,
              (SELECT count(*) FROM charging_session cs WHERE cs.ocpi_partner_id = p.id)::int AS sessions,
              (SELECT count(*) FROM ocpi_remote_location l WHERE l.partner_id = p.id)::int AS network_locations,
              (SELECT count(*) FROM ocpi_remote_cdr r WHERE r.partner_id = p.id)::int AS cdrs_received,
              (SELECT count(*) FROM ocpi_remote_cdr r WHERE r.partner_id = p.id AND r.status = 'held')::int AS cdrs_held,
              (SELECT count(*) FROM ocpi_hub_client h WHERE h.partner_id = p.id)::int AS hub_clients
         FROM ocpi_partner p WHERE p.org_id = $1 AND p.state <> 'closed' ORDER BY p.created_at`,
      [org(req)],
    );
    const sites = party
      ? (await renderLocations(org(req), party, { onlyPublished: false })).map((l) => ({
          id: l.siteId, name: l.location.name, city: l.location.city, publish: l.published, problem: l.problem,
          evses: l.evses.length, tariffs: l.tariffIds.length,
        }))
      : [];
    const optedIn = new Set((await many<{ id: string }>(`SELECT id FROM site WHERE org_id = $1 AND roaming_publish`, [org(req)])).map((s) => s.id));
    const pub = baseOrProblem(req);
    return {
      party,
      versionsUrl: pub.url ? versionsUrlOf(pub.url) : null,
      // Why there is no versions URL (OCPI_PUBLIC_URL not set), for the console to show.
      publicUrlProblem: pub.problem,
      partners,
      sites: sites.map((s) => ({ ...s, optedIn: optedIn.has(s.id) })),
    };
  });

  app.put('/v1/roaming/party', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:write' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cc = String(b.countryCode ?? '').trim().toUpperCase();
    const pid = String(b.partyId ?? '').trim().toUpperCase();
    const name = String(b.businessName ?? '').trim();
    const website = String(b.website ?? '').trim();
    if (!/^[A-Z]{2}$/.test(cc)) return bad(reply, 400, 'Country code: two letters, e.g. ID');
    if (!/^[A-Z0-9]{3}$/.test(pid)) return bad(reply, 400, 'Party ID: three letters or digits, e.g. PLS');
    if (!name) return bad(reply, 400, 'Enter the business name partners will see');
    if (website && !/^https:\/\/\S+$/.test(website)) return bad(reply, 400, 'Website must start with https://');
    const current = await getParty(org(req));
    const connected = await one<{ n: number }>(`SELECT count(*)::int AS n FROM ocpi_partner WHERE org_id = $1 AND state = 'connected'`, [org(req)]);
    if (current && (current.country_code !== cc || current.party_id !== pid) && (connected?.n ?? 0) > 0) {
      return bad(reply, 409, 'Partners already know you by your current party ID. Disconnect them before changing it.');
    }
    const taken = await one(`SELECT 1 FROM ocpi_party WHERE country_code = $1 AND party_id = $2 AND org_id <> $3`, [cc, pid, org(req)]);
    if (taken) return bad(reply, 409, `${cc}*${pid} is already used by another organisation on this platform`);
    const party = await setParty(org(req), { country_code: cc, party_id: pid, business_name: name, website: website || null });
    await audit(req, 'roaming.identity_set', 'ocpi_party', org(req), { ...party });
    return { party };
  });

  app.post('/v1/roaming/partners', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:write' });
    if (!(await getParty(org(req)))) return bad(reply, 409, 'Set your roaming identity first');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = String(b.name ?? '').trim();
    if (!name) return bad(reply, 400, 'Give the partner a name');
    // The partner needs our versions URL to register: refuse before issuing a token it cannot use.
    const pub = baseOrProblem(req);
    if (!pub.url) return bad(reply, 503, pub.problem!);
    // The kind is pinned here: the partner may only register with the matching role.
    const r = await createPartner(org(req), { name, kind: String(b.kind ?? 'emsp') });
    await audit(req, 'roaming.partner_created', 'ocpi_partner', r.partner.id, { name, kind: r.partner.kind });
    const { token_in: _a, token_in_hash: _b, token_out: _c, ...partner } = r.partner;
    return { partner, token: r.token, versionsUrl: versionsUrlOf(pub.url) };
  });

  app.post('/v1/roaming/partners/:id/connect', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:write' });
    const p = await partnerOr404(req, reply);
    if (!p) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const versionsUrl = String(b.versionsUrl ?? '').trim();
    const token = String(b.token ?? '').trim();
    if (!versionsUrl || !token) return bad(reply, 400, "Enter the partner's versions URL and the token it gave you");
    const pub = baseOrProblem(req);
    if (!pub.url) return bad(reply, 503, pub.problem!);
    try {
      // Outside this request's transaction: the partner calls back into /ocpi while
      // we register, and must see the token we just issued.
      await outsideRequestScope(() => connectToPartner(org(req), p.id, versionsUrl, token, pub.url!));
    } catch (e) {
      if (e instanceof RegistrationError) return bad(reply, 502, e.message);
      throw e;
    }
    await audit(req, 'roaming.partner_connected', 'ocpi_partner', p.id, { versionsUrl });
    syncSoon(req, reply, p.id);
    return one(`SELECT ${PARTNER_COLS} FROM ocpi_partner WHERE id = $1`, [p.id]);
  });

  app.patch('/v1/roaming/partners/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:write' });
    const p = await partnerOr404(req, reply);
    if (!p) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) return bad(reply, 400, 'The name cannot be empty');
      await query(`UPDATE ocpi_partner SET name = $2, updated_at = now() WHERE id = $1`, [p.id, name.slice(0, 120)]);
    }
    if (b.state !== undefined) {
      const to = String(b.state);
      if (!['suspended', 'connected'].includes(to)) return bad(reply, 400, 'state must be suspended or connected');
      if (to === 'connected' && p.state !== 'suspended') return bad(reply, 409, 'Only a suspended partner can be resumed');
      if (to === 'suspended' && p.state !== 'connected') return bad(reply, 409, 'Only a connected partner can be suspended');
      await query(`UPDATE ocpi_partner SET state = $2, updated_at = now() WHERE id = $1`, [p.id, to]);
      await audit(req, to === 'suspended' ? 'roaming.partner_suspended' : 'roaming.partner_resumed', 'ocpi_partner', p.id);
      if (to === 'connected') syncSoon(req, reply, p.id);
    }
    return one(`SELECT ${PARTNER_COLS} FROM ocpi_partner WHERE id = $1`, [p.id]);
  });

  app.delete('/v1/roaming/partners/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:write' });
    const p = await partnerOr404(req, reply);
    if (!p) return;
    await outsideRequestScope(() => closePartner(p, true));
    await audit(req, 'roaming.partner_disconnected', 'ocpi_partner', p.id, { name: p.name });
    return { ok: true };
  });

  app.get('/v1/roaming/partners/:id/messages', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:read' });
    const p = await partnerOr404(req, reply);
    if (!p) return;
    return many(
      `SELECT id, direction, method, url, http_status, ocpi_status, duration_ms, error, created_at
         FROM ocpi_message WHERE partner_id = $1 AND org_id = $2 ORDER BY created_at DESC, id DESC LIMIT 300`,
      [p.id, org(req)],
    );
  });

  app.get('/v1/roaming/partners/:id/pushes', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:read' });
    const p = await partnerOr404(req, reply);
    if (!p) return;
    return many(
      `SELECT id, module, action, object_key, state, attempts, next_attempt_at, last_status, last_error, created_at, delivered_at
         FROM ocpi_push WHERE partner_id = $1 AND org_id = $2 ORDER BY id DESC LIMIT 300`,
      [p.id, org(req)],
    );
  });

  app.get('/v1/roaming/partners/:id/tokens', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:read' });
    const p = await partnerOr404(req, reply);
    if (!p) return;
    return many(
      `SELECT id, country_code, party_id, uid, type, contract_id, visual_number, issuer, valid, whitelist, last_updated, received_at
         FROM ocpi_token WHERE partner_id = $1 AND org_id = $2 ORDER BY received_at DESC LIMIT 500`,
      [p.id, org(req)],
    );
  });

  app.post('/v1/roaming/partners/:id/replay', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:write' });
    const p = await partnerOr404(req, reply);
    if (!p) return;
    const n = await replayFailed(org(req), p.id);
    await audit(req, 'roaming.replayed', 'ocpi_partner', p.id, { requeued: n });
    return { requeued: n };
  });

  app.get('/v1/roaming/partners/:id/hub-clients', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:read' });
    const p = await partnerOr404(req, reply);
    if (!p) return;
    return listClients(org(req), p.id);
  });

  app.post('/v1/roaming/partners/:id/hub-clients/refresh', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:write' });
    const p = await partnerOr404(req, reply);
    if (!p) return;
    if (p.kind !== 'hub') return bad(reply, 409, 'Only a hub has parties behind it');
    if (p.state !== 'connected') return bad(reply, 409, 'The hub is not connected');
    const r = await outsideRequestScope(() => pullHubClients(p));
    if (!r) return bad(reply, 502, 'The hub did not return its client list (it may not offer one; see the message log)');
    return r;
  });

  /** Partners' charging limits on sessions still running, and what each allows right now. */
  app.get('/v1/roaming/charging-profiles', async (req) => {
    assertCan(req.principal, { permission: 'roaming:read' });
    const rows = await many<{
      session_id: string; partner_name: string; site_name: string; ocpp_identity: string; started_at: Date; phases: number | null;
      profile: ChargingProfileIn; received_at: Date; last_result: string | null; applied_at: Date | null; contract_id: string | null;
    }>(
      `SELECT p.session_id, pa.name AS partner_name, s.name AS site_name, cp.ocpp_identity, cs.started_at, c.phases,
              p.profile, p.received_at, p.last_result, p.applied_at, t.contract_id
         FROM ocpi_charging_profile p
         JOIN charging_session cs ON cs.id = p.session_id AND cs.state = 'active'
         JOIN ocpi_partner pa ON pa.id = p.partner_id
         JOIN site s ON s.id = cs.site_id
         JOIN charge_point cp ON cp.id = cs.charge_point_id
         JOIN connector c ON c.id = cs.connector_uuid
         LEFT JOIN ocpi_token t ON t.id = cs.ocpi_token_id
        WHERE p.org_id = $1
        ORDER BY p.received_at DESC LIMIT 200`,
      [org(req)],
    );
    const now = new Date();
    return rows.map(({ profile, phases, ...r }) => {
      const limit = profileLimitAt(profile, now, new Date(r.started_at));
      return {
        ...r,
        unit: profile.charging_rate_unit,
        periods: profile.charging_profile_period.length,
        limitNow: limit,
        limitNowW: limit == null ? null : Math.floor(profile.charging_rate_unit === 'A' ? ampsToWatts(limit, phases ?? 3) : limit),
      };
    });
  });

  app.post('/v1/roaming/partners/:id/sync', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:write' });
    const p = await partnerOr404(req, reply);
    if (!p) return;
    if (p.state !== 'connected') return bad(reply, 409, 'The partner is not connected');
    const r = await syncOrg(org(req), { forceAll: true, partnerId: p.id });
    return r;
  });

  app.put('/v1/roaming/sites/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:write' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return bad(reply, 404, 'site not found');
    const site = await one<{ id: string }>(`SELECT id FROM site WHERE id = $1 AND org_id = $2`, [id, org(req)]);
    if (!site) return bad(reply, 404, 'site not found');
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.city !== undefined) {
      await query(`UPDATE site SET city = $2 WHERE id = $1`, [id, String(b.city).trim().slice(0, 45) || null]);
    }
    if (b.publish !== undefined) {
      const party = await getParty(org(req));
      if (b.publish === true && party) {
        const [l] = await renderLocations(org(req), party, { siteId: id, onlyPublished: false });
        if (l?.problem) return bad(reply, 422, `This site cannot be shared yet: ${l.problem}.`);
      }
      await query(`UPDATE site SET roaming_publish = $2 WHERE id = $1`, [id, b.publish === true]);
      await audit(req, b.publish === true ? 'roaming.site_published' : 'roaming.site_withdrawn', 'site', id);
    }
    syncSoon(req, reply);
    return { ok: true };
  });

  // ═════════════════════════════════════════ eMSP role: our cards on other networks

  app.get('/v1/roaming/cards', async (req) => {
    assertCan(req.principal, { permission: 'roaming:read' });
    return many(
      `SELECT t.id, t.uid, t.status, t.valid_to, t.holder_name, t.fleet_name, t.account_type, t.roaming_shared, t.contract_id,
              t.energy_limit_wh, t.spend_limit_idr,
              (SELECT count(*) FROM ocpi_remote_cdr r WHERE r.token_id = t.id AND r.status = 'accepted')::int AS roaming_cdrs,
              (SELECT count(*) FROM ocpi_remote_cdr r WHERE r.token_id = t.id AND r.status = 'held')::int AS roaming_cdrs_held,
              (SELECT COALESCE(sum(COALESCE(r.total_incl_vat, r.total_excl_vat)), 0) FROM ocpi_remote_cdr r
                WHERE r.token_id = t.id AND r.currency = 'IDR' AND r.status = 'accepted')::bigint AS roaming_idr
         FROM token t WHERE t.org_id = $1 AND t.kind = 'rfid'
        ORDER BY t.roaming_shared DESC, t.fleet_name NULLS LAST, t.holder_name NULLS LAST, t.uid LIMIT 2000`,
      [org(req)],
    );
  });

  app.put('/v1/roaming/cards', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:write' });
    if (!(await getParty(org(req)))) return bad(reply, 409, 'Set your roaming identity first');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const shared = b.shared === true;
    const ids = b.all === true ? 'all-active' as const
      : Array.isArray(b.ids) ? (b.ids as unknown[]).map(String).filter((x) => UUID_RE.test(x)) : [];
    if (ids !== 'all-active' && ids.length === 0) return bad(reply, 400, 'Choose the cards');
    const n = await setShared(org(req), ids, shared);
    await audit(req, shared ? 'roaming.cards_shared' : 'roaming.cards_unshared', 'token', ids === 'all-active' ? 'all-active' : ids.join(',').slice(0, 200), { count: n });
    syncSoon(req, reply);
    return { changed: n };
  });

  app.get('/v1/roaming/network', async (req) => {
    assertCan(req.principal, { permission: 'roaming:read' });
    const rows = await many<{ partner_id: string; partner_name: string; country_code: string; party_id: string; location_id: string; data: any; last_updated: Date }>(
      `SELECT l.partner_id, p.name AS partner_name, l.country_code, l.party_id, l.location_id, l.data, l.last_updated
         FROM ocpi_remote_location l JOIN ocpi_partner p ON p.id = l.partner_id
        WHERE l.org_id = $1 AND p.state = 'connected' AND COALESCE((l.data->>'publish')::boolean, true)
        ORDER BY l.data->>'city', l.data->>'name' LIMIT 1000`,
      [org(req)],
    );
    return rows.map((r) => {
      const evses = (r.data.evses ?? []).filter((e: any) => e.status !== 'REMOVED');
      return {
        partnerId: r.partner_id, partnerName: r.partner_name, party: `${r.country_code}*${r.party_id}`,
        countryCode: r.country_code, partyId: r.party_id, id: r.location_id,
        name: r.data.name ?? r.data.address, address: r.data.address, city: r.data.city,
        operator: r.data.operator?.name ?? null, lastUpdated: r.last_updated,
        available: evses.filter((e: any) => e.status === 'AVAILABLE').length,
        evses: evses.map((e: any) => ({
          uid: e.uid, evseId: e.evse_id ?? e.uid, status: e.status,
          connectors: (e.connectors ?? []).map((c: any) => ({ id: c.id, standard: c.standard, powerType: c.power_type, maxPowerW: c.max_electric_power ?? null })),
        })),
      };
    });
  });

  app.post('/v1/roaming/partners/:id/import', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:write' });
    const p = await partnerOr404(req, reply);
    if (!p) return;
    if (p.state !== 'connected') return bad(reply, 409, 'The partner is not connected');
    return outsideRequestScope(() => importFromCpo(p));
  });

  app.post('/v1/roaming/commands', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:write' });
    const b = (req.body ?? {}) as Record<string, string>;
    if (!['START_SESSION', 'STOP_SESSION', 'UNLOCK_CONNECTOR'].includes(b.command ?? '')) return bad(reply, 400, 'Unknown command');
    if (!UUID_RE.test(String(b.partnerId))) return bad(reply, 404, 'roaming partner not found');
    // The CPO answers to our response_url: no configured public URL, no command.
    const pub = baseOrProblem(req);
    if (!pub.url) return bad(reply, 503, pub.problem!);
    try {
      // Outside this request's transaction: the CPO may post the result back
      // before this request ends, and must find the command.
      const r = await outsideRequestScope(() => sendCommand({
        orgId: org(req), partnerId: b.partnerId!, command: b.command as OurCommand, base: pub.url!, userId: req.principal.userId,
        tokenId: b.tokenId, locationId: b.locationId, evseUid: b.evseUid, connectorId: b.connectorId, sessionId: b.sessionId,
        locationParty: b.countryCode && b.partyId ? { country_code: b.countryCode, party_id: b.partyId } : undefined,
      }));
      await audit(req, `roaming.command.${String(b.command).toLowerCase()}`, 'ocpi_command', r.id, { ...b });
      return r;
    } catch (e) {
      if (e instanceof EmspError) return bad(reply, e.http, e.message);
      throw e;
    }
  });

  app.get('/v1/roaming/commands', async (req) => {
    assertCan(req.principal, { permission: 'roaming:read' });
    return many(
      `SELECT c.id, c.command, c.response, c.result, c.message, c.created_at, c.responded_at, c.result_at,
              c.request->>'location_id' AS location_id, c.request->>'session_id' AS session_id,
              p.name AS partner_name, t.uid, t.holder_name
         FROM ocpi_command c JOIN ocpi_partner p ON p.id = c.partner_id LEFT JOIN token t ON t.id = c.token_id
        WHERE c.org_id = $1 ORDER BY c.created_at DESC LIMIT 200`,
      [org(req)],
    );
  });

  const ABROAD_SQL = `
    SELECT r.id, r.cdr_id, r.session_id, r.start_date_time, r.end_date_time, r.total_energy, r.currency,
           r.total_excl_vat, r.total_incl_vat, r.received_at, r.country_code, r.party_id, r.status, r.hold_reason,
           p.name AS partner_name, t.uid, t.contract_id, t.holder_name, t.fleet_name,
           COALESCE(r.data->'cdr_location'->>'name', l.data->>'name') AS location_name,
           COALESCE(r.data->'cdr_location'->>'city', l.data->>'city') AS city
      FROM ocpi_remote_cdr r
      JOIN ocpi_partner p ON p.id = r.partner_id
      LEFT JOIN token t ON t.id = r.token_id
      LEFT JOIN ocpi_remote_location l ON l.partner_id = r.partner_id AND l.country_code = r.country_code
           AND l.party_id = r.party_id AND l.location_id = r.data->'cdr_location'->>'id'
     WHERE r.org_id = $1
       AND ($2::timestamptz IS NULL OR r.end_date_time >= $2) AND ($3::timestamptz IS NULL OR r.end_date_time < $3)
     ORDER BY r.end_date_time DESC`;
  const range = (q: Record<string, string>) => {
    const d = (s?: string) => (s && !Number.isNaN(new Date(s).getTime()) ? new Date(s) : null);
    return [d(q.from), d(q.to)];
  };

  app.get('/v1/roaming/abroad', async (req) => {
    assertCan(req.principal, { permission: 'roaming:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    const cdrs = await many(`${ABROAD_SQL} LIMIT 500`, [org(req), ...range(q)]);
    const sessions = await many(
      `SELECT s.session_id, s.partner_id, s.status, s.kwh, s.last_updated, s.data->>'start_date_time' AS started_at, s.data->>'location_id' AS location_id,
              p.name AS partner_name, t.uid, t.holder_name, t.fleet_name, l.data->>'name' AS location_name, l.data->>'city' AS city
         FROM ocpi_remote_session s JOIN ocpi_partner p ON p.id = s.partner_id LEFT JOIN token t ON t.id = s.token_id
         LEFT JOIN ocpi_remote_location l ON l.partner_id = s.partner_id AND l.country_code = s.country_code AND l.party_id = s.party_id AND l.location_id = s.data->>'location_id'
        WHERE s.org_id = $1 AND s.status IN ('ACTIVE', 'PENDING', 'RESERVATION')
        ORDER BY s.last_updated DESC LIMIT 100`,
      [org(req)],
    );
    return { active: sessions, cdrs };
  });

  app.get('/v1/roaming/abroad.csv', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    const rows = await many<any>(ABROAD_SQL, [org(req), ...range(q)]);
    // status: accepted (billed), held (awaiting review, not billed) or rejected.
    const head = ['start', 'end', 'partner', 'operator', 'location', 'city', 'card', 'contract_id', 'holder', 'fleet', 'kwh', 'currency', 'total_excl_vat', 'total_incl_vat', 'cdr_id', 'session_id', 'status'];
    const lines = rows.map((r) => [r.start_date_time, r.end_date_time, r.partner_name, `${r.country_code}*${r.party_id}`, r.location_name, r.city, r.uid, r.contract_id,
      r.holder_name, r.fleet_name, r.total_energy, r.currency, r.total_excl_vat, r.total_incl_vat, r.cdr_id, r.session_id, r.status].map(csvCell).join(','));
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="roaming-charges-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send([head.join(','), ...lines].join('\r\n') + '\r\n');
  });

  // ── Partner charge records held for review (no matching session or approval of
  //    ours, or implausible totals). They stay off fleet invoices and card limits
  //    until accepted here; a rejected one never counts.
  app.get('/v1/roaming/cdrs/held', async (req) => {
    assertCan(req.principal, { permission: 'roaming:read' });
    return many(
      `SELECT r.id, r.cdr_id, r.session_id, r.start_date_time, r.end_date_time, r.total_energy, r.currency,
              r.total_excl_vat, r.total_incl_vat, r.received_at, r.country_code, r.party_id, r.hold_reason,
              p.name AS partner_name, t.uid, t.contract_id, t.holder_name, t.fleet_name,
              r.data->'cdr_location'->>'name' AS location_name, r.data->>'authorization_reference' AS authorization_reference
         FROM ocpi_remote_cdr r
         JOIN ocpi_partner p ON p.id = r.partner_id
         LEFT JOIN token t ON t.id = r.token_id
        WHERE r.org_id = $1 AND r.status = 'held'
        ORDER BY r.received_at DESC LIMIT 500`,
      [org(req)],
    );
  });

  for (const decision of ['accept', 'reject'] as const) {
    app.post(`/v1/roaming/cdrs/:id/${decision}`, async (req, reply) => {
      assertCan(req.principal, { permission: 'roaming:write' });
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return bad(reply, 404, 'charge record not found');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) : null;
      // Accept a held record (or one rejected by mistake); reject only a held one:
      // an accepted record may already be on an invoice.
      const row = await one<{ id: string; cdr_id: string; token_id: string | null; currency: string; total: string; location_name: string | null; partner_name: string; hold_reason: string | null }>(
        `UPDATE ocpi_remote_cdr r SET status = $3, reviewed_by = $4, reviewed_at = now()
           FROM ocpi_partner p
          WHERE r.id = $1 AND r.org_id = $2 AND p.id = r.partner_id
            AND r.status = ANY($5::text[])
          RETURNING r.id, r.cdr_id, r.token_id, r.currency, COALESCE(r.total_incl_vat, r.total_excl_vat)::text AS total,
                    r.data->'cdr_location'->>'name' AS location_name, p.name AS partner_name, r.hold_reason`,
        [id, org(req), decision === 'accept' ? 'accepted' : 'rejected', req.principal.userId,
          decision === 'accept' ? ['held', 'rejected'] : ['held']],
      );
      if (!row) {
        const exists = await one<{ status: string }>(`SELECT status FROM ocpi_remote_cdr WHERE id = $1 AND org_id = $2`, [id, org(req)]);
        return exists ? bad(reply, 409, `This charge record is ${exists.status}`) : bad(reply, 404, 'charge record not found');
      }
      await audit(req, decision === 'accept' ? 'roaming.cdr_accepted' : 'roaming.cdr_rejected', 'ocpi_remote_cdr', row.id,
        { cdrId: row.cdr_id, partner: row.partner_name, currency: row.currency, total: Number(row.total), holdReason: row.hold_reason, note });
      // The driver's receipt, held back while the record was in review.
      if (decision === 'accept') {
        afterResponse(reply.raw, async () => notifyCdr(row.token_id, row.id, row.location_name ?? row.partner_name, row.currency, Number(row.total)),
          (e) => logger.warn({ err: e.message }, 'roaming receipt push after review failed'));
      }
      return { id: row.id, status: decision === 'accept' ? 'accepted' : 'rejected' };
    });
  }

  app.get('/v1/roaming/sessions', async (req) => {
    assertCan(req.principal, { permission: 'roaming:read' });
    return many(
      `SELECT cs.id, cs.started_at, cs.ended_at, cs.state, cs.energy_wh, cs.ocpi_auth_method,
              p.name AS partner_name, t.contract_id, t.country_code, t.party_id, t.visual_number,
              s.name AS site_name, cp.ocpp_identity, d.total_idr,
              (SELECT o.state FROM ocpi_push o WHERE o.partner_id = cs.ocpi_partner_id AND o.object_key = 'session:' || cs.id
                  AND o.module = 'cdrs' ORDER BY o.id DESC LIMIT 1) AS cdr_push_state
         FROM charging_session cs
         JOIN ocpi_partner p ON p.id = cs.ocpi_partner_id
         JOIN ocpi_token t ON t.id = cs.ocpi_token_id
         JOIN site s ON s.id = cs.site_id
         JOIN charge_point cp ON cp.id = cs.charge_point_id
         LEFT JOIN cdr d ON d.session_id = cs.id
        WHERE cs.org_id = $1
        ORDER BY cs.started_at DESC LIMIT 200`,
      [org(req)],
    );
  });
}
