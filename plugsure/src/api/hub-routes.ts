import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { many, one, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { routePath } from './route-path.js';
import { assertCan } from '../services/authz.js';
import { aliveChecks } from '../hub/clientinfo.js';
import { approveParty, connectToMember, rotateConnectionToken } from '../hub/credentials.js';
import { createAgreement, getAgreement, transitionAgreement, updateAgreementFlags, type AgreementAction } from '../hub/agreements.js';
import { HubError } from '../hub/errors.js';
import {
  activateMember, closeConnectionAndNotify, hubAudit, joinTenant, leaveTenant, onAgreementChanged, resumeConnection, resumeMember,
  setOpenRoaming, setPartyAdmin, suspendConnection, suspendMember, terminateMember,
} from '../hub/lifecycle.js';
import { kickHubOutbox, replayHub } from '../hub/outbox.js';
import { createConnection, createExternalMember, getConnection, getMember, getParty, selfParties } from '../hub/registry.js';
import { pushClientInfoAbout, pushClientInfoTo } from '../hub/clientinfo.js';
import { syncInternalParties } from '../hub/registry.js';

/**
 * Platform administration of PlugSure Hub (design §9.1, the H1 routes; H2 adds hub-clearing-routes.ts).
 * Every route requires platform:admin, runs unscoped (the hub tables are platform-scoped: inside a tenant's
 * request scope RLS shows nothing) and every change is audited on the platform chain. Tokens are never
 * returned, except token A once when a connection is created.
 *
 * Plus, for tenants: POST /v1/roaming/hub/join (when HUB_SELF_JOIN) and GET /v1/roaming/hub (their own
 * membership).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONN_COLS = `id, member_id, kind, state, versions_url, version, endpoints, peer_org_id, peer_partner_id, rate_limit_per_min,
  realtime_limit_per_min, capture_bodies_until, last_inbound_at, last_alive_ok_at, alive_failures, last_error, registered_at, created_at,
  (token_prev_until > now()) AS rotation_grace`;

export async function registerHubRoutes(app: FastifyInstance): Promise<void> {
  // Registered always (the API document lists them); with HUB_ENABLED=false every one answers 404.
  app.addHook('onRequest', async (req, reply) => {
    if (config.hub.enabled) return;
    // By the matched route as well as the raw target (an encoded path must not slip past: route-path.ts).
    const hit = (p: string) => p.startsWith('/v1/hub/') || p === '/v1/roaming/hub' || p.startsWith('/v1/roaming/hub/');
    if (hit(routePath(req)) || hit(req.url.split('?')[0]!)) {
      return reply.status(404).send({ error: 'PlugSure Hub is not enabled on this platform' });
    }
  });
  const plat = (req: FastifyRequest) => assertCan(req.principal, { permission: 'platform:admin' });
  const actor = (req: FastifyRequest) => req.principal?.userId ?? null;
  const bad = (reply: FastifyReply, status: number, error: string) => reply.status(status).send({ error });
  /** Run unscoped; a HubError becomes a 4xx with its message. */
  const run = async <T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await outsideRequestScope(fn);
    } catch (e) {
      if (e instanceof HubError) return bad(reply, e.http >= 400 ? e.http : 409, e.message);
      throw e;
    }
  };
  const id = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const v = String((req.params as { id?: string }).id ?? '');
    if (!UUID_RE.test(v)) { void bad(reply, 404, 'not found'); return null; }
    return v;
  };
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, any>;
  /** The operator's reason (console confirm dialogs ask for one on lifecycle actions) goes into the audit entry. */
  const reasonOf = (req: FastifyRequest): string | null => {
    const r = body(req).reason;
    return typeof r === 'string' && r.trim() ? r.trim().slice(0, 500) : null;
  };
  const audit = (req: FastifyRequest, action: string, targetType: string, targetId: string, after?: Record<string, unknown>, orgId?: string | null) => {
    const reason = reasonOf(req);
    return hubAudit({ action, targetType, targetId, actorId: actor(req), after: reason ? { ...(after ?? {}), reason } : after ?? null, orgId: orgId ?? null, ip: req.ip });
  };

  // ── overview and configuration
  app.get('/v1/hub/overview', async (req, reply) => {
    plat(req);
    return run(reply, async () => ({
      enabled: config.hub.enabled,
      publicUrl: config.hub.publicUrl || null,
      selfParties: selfParties(),
      members: await many(`SELECT kind, status, count(*)::int AS n FROM hub_member GROUP BY 1, 2 ORDER BY 1, 2`),
      // Parties of terminated members are history, not part of the network.
      parties: await many(`SELECT role, status, count(*)::int AS n FROM hub_party p
                            WHERE NOT EXISTS (SELECT 1 FROM hub_member m WHERE m.id = p.member_id AND m.status = 'terminated') GROUP BY 1, 2 ORDER BY 1, 2`),
      agreements: await many(`SELECT status, count(*)::int AS n FROM hub_agreement GROUP BY 1 ORDER BY 1`),
      traffic24h: await many(`SELECT route, count(*)::int AS n, count(*) FILTER (WHERE http_status >= 400 OR ocpi_status >= 2000)::int AS errors
                                FROM hub_message WHERE created_at > now() - interval '24 hours' AND leg = 'in' GROUP BY 1 ORDER BY 1`),
      outbox: await many(`SELECT state, count(*)::int AS n FROM hub_outbox WHERE created_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1`),
      // By country (members: of incorporation; parties: their OCPI country code), for the console's overview.
      membersByCountry: await many(`SELECT country_code, kind, status, count(*)::int AS n FROM hub_member GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`),
      partiesByCountry: await many(`SELECT country_code, role, status, count(*)::int AS n FROM hub_party p
                                      WHERE NOT EXISTS (SELECT 1 FROM hub_member m WHERE m.id = p.member_id AND m.status = 'terminated') GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`),
      // Open hub alerts (hub.connection_offline, hub.forward_error_rate, hub.response_filtered).
      alerts: await many(`SELECT id, kind, severity, message, target_type, target_id, occurrences, raised_at, last_raised_at FROM alert
                           WHERE kind LIKE 'hub.%' AND resolved_at IS NULL ORDER BY last_raised_at DESC NULLS LAST LIMIT 50`),
      // Optional hub modules present in this build (the console shows their screens only then).
      modules: { clearing: await hasRoutesUnder('/v1/hub/clearing') },
    }));
  });
  // Tenants that can join the hub (they have a roaming identity), with their membership if any.
  app.get('/v1/hub/tenants', async (req, reply) => {
    plat(req);
    return run(reply, async () => ({
      tenants: await many(
        `SELECT o.id, o.name, o.home_country_code,
                (SELECT json_agg(p.country_code || '*' || p.party_id ORDER BY p.is_home DESC, p.country_code) FROM ocpi_party p WHERE p.org_id = o.id) AS parties,
                m.id AS member_id, m.status AS member_status
           FROM organisation o LEFT JOIN hub_member m ON m.org_id = o.id
          WHERE NOT o.hub_only AND EXISTS (SELECT 1 FROM ocpi_party p WHERE p.org_id = o.id)
          ORDER BY o.name LIMIT 1000`),
    }));
  });
  app.get('/v1/hub/self-parties', async (req) => {
    plat(req);
    return { parties: selfParties(), versionsUrl: config.hub.publicUrl ? `${config.hub.publicUrl}/hub/ocpi/versions` : null };
  });

  // ── members
  app.get('/v1/hub/members', async (req, reply) => {
    plat(req);
    const q = req.query as Record<string, string>;
    return run(reply, async () => ({
      members: await many(
        `SELECT m.*, o.name AS org_name, o.hub_only,
                (SELECT count(*)::int FROM hub_connection c WHERE c.member_id = m.id AND c.state <> 'closed') AS connections,
                (SELECT count(*)::int FROM hub_party p WHERE p.member_id = m.id) AS parties
           FROM hub_member m JOIN organisation o ON o.id = m.org_id
          WHERE ($1::text IS NULL OR m.status = $1) AND ($2::text IS NULL OR m.kind = $2)
          ORDER BY m.created_at DESC LIMIT 500`, [q.status ?? null, q.kind ?? null]),
    }));
  });
  app.post('/v1/hub/members', async (req, reply) => {
    plat(req);
    const b = body(req);
    return run(reply, async () => {
      const m = await createExternalMember({
        legal_name: String(b.legal_name ?? ''), country_code: String(b.country_code ?? '').toUpperCase(), tax_id: b.tax_id ?? null,
        billing_email: b.billing_email ?? null, contract_ref: b.contract_ref ?? null, open_roaming: b.open_roaming === true, created_by: actor(req),
      });
      await audit(req, 'hub.member_created', 'hub_member', m.id, { legal_name: m.legal_name, country_code: m.country_code, kind: m.kind }, m.org_id);
      return reply.status(201).send({ member: m });
    });
  });
  app.post('/v1/hub/members/join-tenant', async (req, reply) => {
    plat(req);
    const orgId = String(body(req).org_id ?? '');
    if (!UUID_RE.test(orgId)) return bad(reply, 400, 'org_id is required');
    return run(reply, async () => {
      const r = await joinTenant(orgId, actor(req));
      if (r.created) await audit(req, 'hub.tenant_joined', 'hub_member', r.member.id, { org_id: orgId, connection_id: r.connection.id }, orgId);
      return { member: r.member, connectionId: r.connection.id, partnerId: r.partnerId, created: r.created };
    });
  });
  app.post('/v1/hub/members/leave-tenant', async (req, reply) => {
    plat(req);
    const orgId = String(body(req).org_id ?? '');
    if (!UUID_RE.test(orgId)) return bad(reply, 400, 'org_id is required');
    return run(reply, async () => {
      const left = await leaveTenant(orgId);
      if (!left) throw new HubError(404, 2000, 'this organisation is not on the hub');
      await audit(req, 'hub.tenant_left', 'organisation', orgId, {}, orgId);
      return { ok: true };
    });
  });
  app.get('/v1/hub/members/:id', async (req, reply) => {
    plat(req);
    const mid = id(req, reply); if (!mid) return;
    return run(reply, async () => {
      const member = await getMember(mid);
      if (!member) throw new HubError(404, 2000, 'member not found');
      return {
        member,
        connections: await many(`SELECT ${CONN_COLS} FROM hub_connection WHERE member_id = $1 ORDER BY created_at`, [mid]),
        parties: await many(`SELECT * FROM hub_party WHERE member_id = $1 ORDER BY country_code, party_id, role`, [mid]),
      };
    });
  });
  app.patch('/v1/hub/members/:id', async (req, reply) => {
    plat(req);
    const mid = id(req, reply); if (!mid) return;
    const b = body(req);
    return run(reply, async () => {
      if (!(await getMember(mid))) throw new HubError(404, 2000, 'member not found');
      const action = b.action == null ? null : String(b.action);
      let m = await getMember(mid);
      if (action === 'activate') m = await activateMember(mid);
      else if (action === 'suspend') m = await suspendMember(mid);
      else if (action === 'resume') m = await resumeMember(mid);
      else if (action === 'terminate') m = await terminateMember(mid);
      else if (action != null) throw new HubError(400, 2001, 'action: activate, suspend, resume or terminate');
      if (typeof b.open_roaming === 'boolean') m = await setOpenRoaming(mid, b.open_roaming);
      const fields: Record<string, unknown> = {};
      for (const k of ['billing_email', 'contract_ref', 'tax_id', 'legal_name']) if (typeof b[k] === 'string') fields[k] = String(b[k]).slice(0, 300);
      if (Object.keys(fields).length) {
        const keys = Object.keys(fields);
        m = await one(`UPDATE hub_member SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, [mid, ...keys.map((k) => fields[k])]);
      }
      await audit(req, action ? `hub.member_${action}` : 'hub.member_updated', 'hub_member', mid, { action, open_roaming: b.open_roaming, ...fields }, m?.org_id);
      return { member: m };
    });
  });

  // ── connections
  app.post('/v1/hub/members/:id/connections', async (req, reply) => {
    plat(req);
    const mid = id(req, reply); if (!mid) return;
    const b = body(req);
    return run(reply, async () => {
      const r = await createConnection(mid, { rateLimitPerMin: limitOf(b.rate_limit_per_min), realtimeLimitPerMin: limitOf(b.realtime_limit_per_min) });
      const m = await getMember(mid);
      await audit(req, 'hub.token_a_issued', 'hub_connection', r.connection.id, { member_id: mid }, m?.org_id);
      const c = await one(`SELECT ${CONN_COLS} FROM hub_connection WHERE id = $1`, [r.connection.id]);
      // Token A is shown once: it is stored hashed (and sealed for GET /credentials only).
      return reply.status(201).send({ connection: c, token: r.token, versionsUrl: r.versionsUrl });
    });
  });
  app.get('/v1/hub/connections', async (req, reply) => {
    plat(req);
    const q = req.query as Record<string, string>;
    return run(reply, async () => ({
      connections: await many(`SELECT ${CONN_COLS} FROM hub_connection WHERE ($1::text IS NULL OR state = $1) ORDER BY created_at DESC LIMIT 500`, [q.state ?? null]),
    }));
  });
  app.get('/v1/hub/connections/:id', async (req, reply) => {
    plat(req);
    const cid = id(req, reply); if (!cid) return;
    return run(reply, async () => {
      const c = await one(`SELECT ${CONN_COLS} FROM hub_connection WHERE id = $1`, [cid]);
      if (!c) throw new HubError(404, 2000, 'connection not found');
      return { connection: c, parties: await many(`SELECT * FROM hub_party WHERE connection_id = $1 ORDER BY country_code, party_id, role`, [cid]) };
    });
  });
  app.patch('/v1/hub/connections/:id', async (req, reply) => {
    plat(req);
    const cid = id(req, reply); if (!cid) return;
    const b = body(req);
    return run(reply, async () => {
      const rl = limitOf(b.rate_limit_per_min);
      const rt = limitOf(b.realtime_limit_per_min);
      const c = await one(`UPDATE hub_connection SET rate_limit_per_min = COALESCE($2, rate_limit_per_min), realtime_limit_per_min = COALESCE($3, realtime_limit_per_min),
                                  updated_at = now() WHERE id = $1 RETURNING ${CONN_COLS}`, [cid, rl ?? null, rt ?? null]);
      if (!c) throw new HubError(404, 2000, 'connection not found');
      await audit(req, 'hub.connection_limits', 'hub_connection', cid, { rate_limit_per_min: rl, realtime_limit_per_min: rt });
      return { connection: c };
    });
  });
  app.post('/v1/hub/connections/:id/connect', async (req, reply) => {
    plat(req);
    const cid = id(req, reply); if (!cid) return;
    const b = body(req);
    const versionsUrl = typeof b.versions_url === 'string' ? b.versions_url : '';
    const token = typeof b.token === 'string' ? b.token : '';
    if (!versionsUrl || !token) return bad(reply, 400, 'versions_url and token (the member\'s token A) are required');
    return run(reply, async () => {
      const r = await connectToMember(cid, versionsUrl, token);
      await audit(req, 'hub.connection_registered', 'hub_connection', cid, { initiated_by: 'hub', parties: r.parties.map((p) => `${p.country_code}*${p.party_id}:${p.role}`) });
      setImmediate(() => void (async () => {
        await pushClientInfoAbout(r.parties.map((p) => p.id));
        await pushClientInfoTo(cid);
      })().catch(() => null));
      return { connection: await one(`SELECT ${CONN_COLS} FROM hub_connection WHERE id = $1`, [cid]), parties: r.parties };
    });
  });
  for (const action of ['suspend', 'resume', 'rotate', 'close', 'alive-check'] as const) {
    app.post(`/v1/hub/connections/:id/${action}`, async (req, reply) => {
      plat(req);
      const cid = id(req, reply); if (!cid) return;
      return run(reply, async () => {
        const c = await getConnection(cid);
        if (!c) throw new HubError(404, 2000, 'connection not found');
        let result: unknown = { ok: true };
        if (action === 'suspend') await suspendConnection(cid);
        else if (action === 'resume') await resumeConnection(cid);
        else if (action === 'rotate') await rotateConnectionToken(c);
        else if (action === 'close') await closeConnectionAndNotify(cid, body(req).notify !== false);
        else result = { ok: true, checks: await aliveChecks({ connectionId: cid, force: true }) };
        if (action !== 'alive-check') await audit(req, `hub.connection_${action}`, 'hub_connection', cid, {});
        return result;
      });
    });
  }
  app.post('/v1/hub/connections/:id/capture', async (req, reply) => {
    plat(req);
    const cid = id(req, reply); if (!cid) return;
    const hours = Number(body(req).hours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 72) return bad(reply, 400, 'hours: 0 (off) to 72');
    return run(reply, async () => {
      const c = await one<{ capture_bodies_until: Date | null }>(
        `UPDATE hub_connection SET capture_bodies_until = CASE WHEN $2::numeric = 0 THEN NULL ELSE now() + make_interval(secs => ($2::numeric * 3600)::int) END
          WHERE id = $1 RETURNING capture_bodies_until`, [cid, hours]);
      if (!c) throw new HubError(404, 2000, 'connection not found');
      await audit(req, hours ? 'hub.capture_on' : 'hub.capture_off', 'hub_connection', cid, { hours });
      return { captureBodiesUntil: c.capture_bodies_until };
    });
  });
  app.post('/v1/hub/connections/:id/parties', async (req, reply) => {
    plat(req);
    const cid = id(req, reply); if (!cid) return;
    const b = body(req);
    return run(reply, async () => {
      const p = await approveParty(cid, {
        role: String(b.role ?? '').toUpperCase(), country_code: String(b.country_code ?? '').toUpperCase(), party_id: String(b.party_id ?? '').toUpperCase(),
        business_name: String(b.business_name ?? ''), website: typeof b.website === 'string' ? b.website : null,
      });
      await audit(req, 'hub.party_approved', 'hub_party', p.id, { party: `${p.country_code}*${p.party_id}`, role: p.role, connection_id: cid }, p.org_id);
      return reply.status(201).send({ party: p });
    });
  });

  // ── parties
  app.get('/v1/hub/parties', async (req, reply) => {
    plat(req);
    const q = req.query as Record<string, string>;
    return run(reply, async () => ({
      parties: await many(
        `SELECT p.*, m.legal_name AS member_name, m.kind AS member_kind FROM hub_party p JOIN hub_member m ON m.id = p.member_id
          WHERE ($1::uuid IS NULL OR p.member_id = $1) AND ($2::text IS NULL OR p.status = $2) AND ($3::text IS NULL OR p.role = $3)
          ORDER BY p.country_code, p.party_id, p.role LIMIT 1000`,
        [q.member && UUID_RE.test(q.member) ? q.member : null, q.status ?? null, q.role ?? null]),
    }));
  });
  app.patch('/v1/hub/parties/:id', async (req, reply) => {
    plat(req);
    const pid = id(req, reply); if (!pid) return;
    const action = String(body(req).action ?? '');
    if (action !== 'suspend' && action !== 'resume') return bad(reply, 400, 'action: suspend or resume');
    return run(reply, async () => {
      await setPartyAdmin(pid, action === 'suspend');
      const p = await getParty(pid);
      await audit(req, `hub.party_${action}`, 'hub_party', pid, { status: p?.status }, p?.org_id);
      return { party: p };
    });
  });

  // ── agreements
  app.get('/v1/hub/agreements', async (req, reply) => {
    plat(req);
    const q = req.query as Record<string, string>;
    return run(reply, async () => ({
      agreements: await many(
        `SELECT a.*, c.country_code || '*' || c.party_id AS cpo, e.country_code || '*' || e.party_id AS emsp, e.role AS emsp_role
           FROM hub_agreement a JOIN hub_party c ON c.id = a.cpo_party_id JOIN hub_party e ON e.id = a.emsp_party_id
          WHERE ($1::text IS NULL OR a.status = $1) AND ($2::uuid IS NULL OR a.cpo_party_id = $2 OR a.emsp_party_id = $2)
          ORDER BY a.created_at DESC LIMIT 1000`,
        [q.status ?? null, q.party && UUID_RE.test(q.party) ? q.party : null]),
    }));
  });
  app.post('/v1/hub/agreements', async (req, reply) => {
    plat(req);
    const b = body(req);
    if (!UUID_RE.test(String(b.cpo_party_id)) || !UUID_RE.test(String(b.emsp_party_id))) return bad(reply, 400, 'cpo_party_id and emsp_party_id (hub party ids) are required');
    return run(reply, async () => {
      const cpo = await getParty(b.cpo_party_id);
      const emsp = await getParty(b.emsp_party_id);
      if (!cpo || !emsp) throw new HubError(404, 2000, 'party not found');
      // A platform admin's agreement is active at once unless it asks for a proposal (activate: false).
      const activate = b.activate !== false;
      const a = await createAgreement({
        cpo, emsp, by: 'platform', activate,
        allow_realtime_auth: typeof b.allow_realtime_auth === 'boolean' ? b.allow_realtime_auth : undefined,
        allow_commands: typeof b.allow_commands === 'boolean' ? b.allow_commands : undefined,
        allow_charging_profiles: typeof b.allow_charging_profiles === 'boolean' ? b.allow_charging_profiles : undefined,
        valid_from: b.valid_from ? new Date(b.valid_from) : null, valid_to: b.valid_to ? new Date(b.valid_to) : null,
        notes: typeof b.notes === 'string' ? b.notes.slice(0, 2000) : null,
      });
      await audit(req, 'hub.agreement_created', 'hub_agreement', a.id, { cpo: `${cpo.country_code}*${cpo.party_id}`, emsp: `${emsp.country_code}*${emsp.party_id}`, status: a.status });
      await onAgreementChanged(null, a);
      return reply.status(201).send({ agreement: a });
    });
  });
  app.patch('/v1/hub/agreements/:id', async (req, reply) => {
    plat(req);
    const aid = id(req, reply); if (!aid) return;
    const b = body(req);
    const patch = {
      allow_realtime_auth: typeof b.allow_realtime_auth === 'boolean' ? b.allow_realtime_auth : undefined,
      allow_commands: typeof b.allow_commands === 'boolean' ? b.allow_commands : undefined,
      allow_charging_profiles: typeof b.allow_charging_profiles === 'boolean' ? b.allow_charging_profiles : undefined,
      notes: typeof b.notes === 'string' ? b.notes.slice(0, 2000) : undefined,
    };
    return run(reply, async () => {
      if (!(await getAgreement(aid))) throw new HubError(404, 2000, 'agreement not found');
      if (b.action != null) {
        if (!['approve', 'suspend', 'resume', 'end'].includes(String(b.action))) throw new HubError(400, 2001, 'action: approve, suspend, resume or end');
        const { before, after } = await transitionAgreement(aid, b.action as AgreementAction, patch);
        await audit(req, `hub.agreement_${b.action}`, 'hub_agreement', aid, { status: after.status, ...patch });
        await onAgreementChanged(before, after);
        return { agreement: after };
      }
      const a = await updateAgreementFlags(aid, patch);
      await audit(req, 'hub.agreement_updated', 'hub_agreement', aid, patch);
      return { agreement: a };
    });
  });

  // ── message log, outbox, health
  app.get('/v1/hub/messages', async (req, reply) => {
    plat(req);
    const q = req.query as Record<string, string>;
    const limit = Math.min(500, Math.max(1, Number(q.limit ?? 100) || 100));
    return run(reply, async () => ({
      messages: await many(
        `SELECT * FROM hub_message
          WHERE ($1::uuid IS NULL OR connection_id = $1) AND ($2::text IS NULL OR correlation_id = $2) AND ($3::text IS NULL OR route LIKE $3 || '%')
            AND ($4::text IS NULL OR from_party = $4 OR to_party = $4)
            AND ($5::text IS NULL OR ($5 = 'error' AND (http_status >= 400 OR ocpi_status >= 2000 OR error IS NOT NULL)) OR ($5 = 'ok' AND http_status < 400 AND COALESCE(ocpi_status, 1000) < 2000))
            AND ($6::bigint IS NULL OR id < $6)
            AND ($7::timestamptz IS NULL OR created_at >= $7) AND ($8::timestamptz IS NULL OR created_at < $8)
            AND ($10::text IS NULL OR module = $10)
          ORDER BY id DESC LIMIT $9`,
        [q.connection && UUID_RE.test(q.connection) ? q.connection : null, q.correlation ?? null, q.route ?? null, q.party ?? null,
          q.status === 'error' || q.status === 'ok' ? q.status : null, q.before && /^\d+$/.test(q.before) ? q.before : null,
          q.from ?? null, q.to ?? null, limit, q.module ? String(q.module).slice(0, 40) : null]),
    }));
  });
  app.get('/v1/hub/messages/trace/:correlationId', async (req, reply) => {
    plat(req);
    const cid = String((req.params as { correlationId: string }).correlationId ?? '').slice(0, 100);
    return run(reply, async () => ({ legs: await many(`SELECT * FROM hub_message WHERE correlation_id = $1 ORDER BY id`, [cid]) }));
  });
  app.get('/v1/hub/outbox', async (req, reply) => {
    plat(req);
    const q = req.query as Record<string, string>;
    return run(reply, async () => ({
      rows: await many(
        `SELECT id, kind, origin_party_id, recipient_connection_id, recipient_party_id, module, method, path_suffix, object_key, correlation_id,
                state, attempts, next_attempt_at, last_status, last_ocpi_status, last_error, created_at, delivered_at
           FROM hub_outbox WHERE ($1::text IS NULL OR state = $1) AND ($2::uuid IS NULL OR recipient_connection_id = $2)
          ORDER BY id DESC LIMIT 500`,
        [q.state ?? null, q.connection && UUID_RE.test(q.connection) ? q.connection : null]),
    }));
  });
  app.post('/v1/hub/outbox/replay', async (req, reply) => {
    plat(req);
    const cid = String(body(req).connection_id ?? '');
    if (!UUID_RE.test(cid)) return bad(reply, 400, 'connection_id is required');
    return run(reply, async () => {
      const n = await replayHub(cid);
      await audit(req, 'hub.outbox_replay', 'hub_connection', cid, { rows: n });
      kickHubOutbox();
      return { replayed: n };
    });
  });
  app.get('/v1/hub/health', async (req, reply) => {
    plat(req);
    return run(reply, async () => ({
      connections: await many(
        `SELECT c.id, c.member_id, m.legal_name AS member_name, c.kind, c.state, c.last_inbound_at, c.last_alive_ok_at, c.alive_failures, c.last_error,
                (SELECT json_object_agg(s.status, s.n) FROM (SELECT status, count(*)::int AS n FROM hub_party WHERE connection_id = c.id GROUP BY 1) s) AS parties,
                (SELECT count(*)::int FROM hub_message h WHERE h.connection_id = c.id AND h.leg = 'in' AND h.created_at > now() - interval '15 minutes') AS in_15m,
                (SELECT count(*)::int FROM hub_message h WHERE h.connection_id = c.id AND h.leg = 'out' AND h.created_at > now() - interval '15 minutes') AS out_15m,
                (SELECT count(*)::int FROM hub_message h WHERE h.connection_id = c.id AND h.leg = 'out' AND h.created_at > now() - interval '15 minutes'
                    AND (h.http_status IS NULL OR h.http_status >= 400 OR h.ocpi_status >= 2000)) AS out_errors_15m,
                (SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY h.duration_ms) FROM hub_message h
                  WHERE h.connection_id = c.id AND h.leg = 'out' AND h.created_at > now() - interval '24 hours') AS out_p95_ms_24h,
                (SELECT count(*)::int FROM hub_message h WHERE h.connection_id = c.id AND h.ocpi_status = 4002 AND h.created_at > now() - interval '24 hours') AS timeouts_24h,
                (SELECT count(*)::int FROM hub_message h WHERE h.connection_id = c.id AND h.ocpi_status = 4003 AND h.created_at > now() - interval '24 hours') AS unreachable_24h,
                (SELECT count(*)::int FROM hub_outbox o WHERE o.recipient_connection_id = c.id AND o.state = 'pending') AS outbox_pending,
                (SELECT count(*)::int FROM hub_outbox o WHERE o.recipient_connection_id = c.id AND o.state = 'failed') AS outbox_failed,
                (SELECT count(*)::int FROM hub_outbox o WHERE o.recipient_connection_id = c.id AND o.state = 'dropped' AND o.created_at > now() - interval '24 hours') AS outbox_dropped_24h
           FROM hub_connection c JOIN hub_member m ON m.id = c.member_id
          WHERE c.state <> 'closed' ORDER BY m.legal_name, c.created_at`),
    }));
  });

  // ── tenants: their own membership, and self-join when allowed
  app.get('/v1/roaming/hub', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:read' });
    const orgId = req.principal.orgId;
    return run(reply, async () => {
      const member = await one(`SELECT id, kind, status, open_roaming, legal_name, country_code, created_at FROM hub_member WHERE org_id = $1`, [orgId]);
      return {
        enabled: true,
        selfJoin: config.hub.selfJoin,
        member,
        parties: member ? await many(`SELECT id, country_code, party_id, role, status FROM hub_party WHERE org_id = $1 ORDER BY country_code, party_id, role`, [orgId]) : [],
        // The roaming agreements its parties are in (the counterparty's name, never its tokens or endpoints).
        agreements: member ? await many(
          `SELECT a.id, a.status, a.allow_realtime_auth, a.allow_commands, a.allow_charging_profiles, a.valid_from, a.valid_to, a.created_at,
                  c.country_code || '*' || c.party_id AS cpo, e.country_code || '*' || e.party_id AS emsp, e.role AS emsp_role,
                  (a.cpo_org_id = $1) AS we_are_cpo, (a.emsp_org_id = $1) AS we_are_emsp,
                  CASE WHEN a.cpo_org_id = $1 THEN em.legal_name ELSE cm.legal_name END AS counterparty
             FROM hub_agreement a JOIN hub_party c ON c.id = a.cpo_party_id JOIN hub_party e ON e.id = a.emsp_party_id
             JOIN hub_member cm ON cm.id = c.member_id JOIN hub_member em ON em.id = e.member_id
            WHERE (a.cpo_org_id = $1 OR a.emsp_org_id = $1) AND a.status <> 'ended'
            ORDER BY a.created_at DESC LIMIT 200`, [orgId]) : [],
      };
    });
  });
  app.post('/v1/roaming/hub/join', async (req, reply) => {
    assertCan(req.principal, { permission: 'roaming:write' });
    if (!config.hub.selfJoin) return bad(reply, 403, 'joining the hub is done by the platform operator (HUB_SELF_JOIN is off)');
    const orgId = req.principal.orgId;
    return run(reply, async () => {
      const r = await joinTenant(orgId, actor(req));
      if (r.created) await audit(req, 'hub.tenant_joined', 'hub_member', r.member.id, { org_id: orgId, self: true }, orgId);
      return { member: r.member, created: r.created };
    });
  });
}

/** Whether this build registered routes under a prefix (an optional hub module such as clearing, WP H2). */
async function hasRoutesUnder(prefix: string): Promise<boolean> {
  // Imported when asked, not at load: server.ts imports this file.
  const { registeredRoutes } = await import('./server.js');
  return registeredRoutes.some((r) => r.url === prefix || r.url.startsWith(`${prefix}/`));
}

function limitOf(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new HubError(400, 2001, 'rate limits: a whole number of requests a minute, 1 to 100000');
  return n;
}

/** Hook for the roaming routes: a tenant changed its parties (only when the hub is enabled). */
export async function hubPartiesChanged(orgId: string): Promise<void> {
  if (!config.hub.enabled) return;
  const changed = await syncInternalParties(orgId);
  if (changed.length) await pushClientInfoAbout(changed);
}
