import { randomUUID } from 'node:crypto';
import { routePath } from '../api/route-path.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  OCPI_VERSION, STATUS, envelope, paging, parseToken, tokenOut, tokenHash, tokensFromAuthHeader, type Party,
} from './mapping.js';
import {
  getParty, partnerByTokenHash, renderLocations, renderTariffs, publishedTariffIds, listSessions, listCdrs,
  getToken, upsertToken, partnerActsFor, logMessage, getPartner, type PartnerRow,
} from './store.js';
import {
  ourEndpoints, registerFromPartner, currentCredentials, closePartner, versionDetailsUrlOf, RegistrationError,
} from './registration.js';
import { handleCommand, runFollowUp } from './commands.js';
import { syncOrg } from './push.js';
import {
  EmspError, roamingCards, cardToken, authorizeForCpo, receiveLocation, getRemoteLocation, receiveTariff, getRemoteTariff,
  receiveSession, getRemoteSession, receiveCdr, getRemoteCdr, receiveCommandResult, importFromCpo,
} from './emsp.js';
import { setProfile, clearProfile, activeProfile, type ProfileOutcome } from './profiles.js';
import { receiveClientInfo, getClientInfo, pullHubClients, HubClientError } from './hubclients.js';

declare module 'fastify' {
  interface FastifyRequest {
    ocpiPartner?: PartnerRow;
    ocpiParty?: Party;
    ocpiStarted?: number;
  }
}

/**
 * The OCPI 2.2.1 endpoints partners call, under /ocpi. A completely separate
 * surface from the operator API: authenticated by the partner's credentials
 * token (`Authorization: Token …`), never by a console session.
 *
 *   versions, credentials                          both directions
 *   locations, tariffs, sessions, cdrs             we are the SENDER (partners pull)
 *   tokens, commands, chargingprofiles             we are the RECEIVER (partners push)
 *   hubclientinfo                                  RECEIVER: a hub tells us who is behind it
 */

const base = (req: FastifyRequest) =>
  config.ocpi.publicUrl || `${req.protocol}://${String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '127.0.0.1')}`;

class OcpiError extends Error {
  constructor(public http: number, public ocpi: number, message: string) { super(message); }
}

export async function registerOcpiApi(app: FastifyInstance): Promise<void> {
  // ── authentication, headers and the message log
  app.addHook('preHandler', async (req, reply) => {
    // Decided on the matched route, never the raw URL (see routePath).
    if (!routePath(req).startsWith('/ocpi/')) return;
    req.ocpiStarted = Date.now();
    const partner = await partnerByTokenHash(tokensFromAuthHeader(req.headers.authorization).map(tokenHash));
    if (!partner) {
      return reply.status(401).header('www-authenticate', 'Token').send(envelope(undefined, STATUS.CLIENT_ERROR, 'invalid or missing credentials token'));
    }
    const path = routePath(req);
    const registrationOnly = path === '/ocpi/versions' || path === `/ocpi/${OCPI_VERSION}` || path === `/ocpi/${OCPI_VERSION}/credentials`;
    if (partner.state !== 'connected' && !registrationOnly) {
      return reply.status(401).send(envelope(undefined, STATUS.CLIENT_ERROR, 'register first: this token only gives access to versions and credentials'));
    }
    const party = await getParty(partner.org_id);
    if (!party) return reply.status(503).send(envelope(undefined, STATUS.SERVER_ERROR, 'this operator has not set up roaming yet'));
    // Hub routing: a message addressed to another party is not ours to answer.
    const toCc = req.headers['ocpi-to-country-code'];
    const toPid = req.headers['ocpi-to-party-id'];
    if (typeof toCc === 'string' && typeof toPid === 'string' && (toCc !== party.country_code || toPid !== party.party_id)) {
      return reply.status(400).send(envelope(undefined, STATUS.INVALID_PARAMS, `this platform is ${party.country_code}*${party.party_id}, not ${toCc}*${toPid}`));
    }
    req.ocpiPartner = partner;
    req.ocpiParty = party;
  });

  // Echo only well-formed values: a header value from the caller is never trusted verbatim.
  const idLike = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(v) ? v : randomUUID());
  app.addHook('onSend', async (req, reply, payload) => {
    if (!routePath(req).startsWith('/ocpi/')) return payload;
    reply.header('x-request-id', idLike(req.headers['x-request-id']));
    reply.header('x-correlation-id', idLike(req.headers['x-correlation-id']));
    if (req.ocpiParty) {
      reply.header('ocpi-from-country-code', req.ocpiParty.country_code);
      reply.header('ocpi-from-party-id', req.ocpiParty.party_id);
      const fc = req.headers['ocpi-from-country-code'];
      const fp = req.headers['ocpi-from-party-id'];
      if (typeof fc === 'string' && typeof fp === 'string' && /^[A-Za-z]{2}$/.test(fc) && /^[A-Za-z0-9]{3}$/.test(fp)) {
        reply.header('ocpi-to-country-code', fc);
        reply.header('ocpi-to-party-id', fp);
      }
    }
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!routePath(req).startsWith('/ocpi/') || !req.ocpiPartner) return;
    await logMessage({
      orgId: req.ocpiPartner.org_id, partnerId: req.ocpiPartner.id, direction: 'in', method: req.method, url: req.url,
      httpStatus: reply.statusCode, ocpiStatus: null, ms: Date.now() - (req.ocpiStarted ?? Date.now()), error: reply.statusCode >= 400 ? `HTTP ${reply.statusCode}` : null,
    });
  });

  const ctx = (req: FastifyRequest) => ({ partner: req.ocpiPartner!, party: req.ocpiParty! });
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof OcpiError) return reply.status(e.http).send(envelope(undefined, e.ocpi, e.message));
    if (e instanceof RegistrationError) return reply.status(e.httpStatus).send(envelope(undefined, e.ocpiStatus, e.message));
    if (e instanceof EmspError) return reply.status(e.http).send(envelope(undefined, e.ocpi, e.message));
    if (e instanceof HubClientError) return reply.status(e.http).send(envelope(undefined, e.ocpi, e.message));
    logger.error({ err: e }, 'OCPI handler failed');
    return reply.status(500).send(envelope(undefined, STATUS.SERVER_ERROR, 'internal error'));
  };

  /** A paginated list with OCPI's X-Total-Count, X-Limit and Link headers. */
  const page = (req: FastifyRequest, reply: FastifyReply, items: unknown[], total: number, p: { offset: number; limit: number }) => {
    reply.header('x-total-count', String(total));
    reply.header('x-limit', String(p.limit));
    if (p.offset + items.length < total) {
      const u = new URL(req.url, base(req));
      u.searchParams.set('offset', String(p.offset + p.limit));
      u.searchParams.set('limit', String(p.limit));
      reply.header('link', `<${base(req)}${u.pathname}${u.search}>; rel="next"`);
    }
    return envelope(items);
  };

  // ── versions
  app.get('/ocpi/versions', async (req) => envelope([{ version: OCPI_VERSION, url: versionDetailsUrlOf(base(req)) }]));
  app.get(`/ocpi/${OCPI_VERSION}`, async (req) => envelope({ version: OCPI_VERSION, endpoints: ourEndpoints(base(req)) }));

  // ── credentials
  const C = `/ocpi/${OCPI_VERSION}/credentials`;
  app.get(C, async (req, reply) => {
    const { partner } = ctx(req);
    if (partner.state !== 'connected') return reply.status(405).send(envelope(undefined, STATUS.CLIENT_ERROR, 'not registered yet: POST your credentials'));
    return envelope(await currentCredentials(partner, base(req)));
  });
  for (const method of ['POST', 'PUT'] as const) {
    app.route({ method, url: C, handler: async (req, reply) => {
      const { partner } = ctx(req);
      try {
        const creds = await registerFromPartner(partner, req.body, base(req), method === 'PUT');
        // Share the network straight away rather than waiting for the next sync pass.
        // A CPO partner's network is imported the same way (eMSP role).
        setImmediate(() => void (async () => {
          await syncOrg(partner.org_id, { forceAll: true, partnerId: partner.id });
          const fresh = await getPartner(partner.org_id, partner.id);
          if (fresh) await importFromCpo(fresh);
          if (fresh) await pullHubClients(fresh);
        })().catch(() => null));
        return envelope(creds);
      } catch (e) { return fail(reply, e); }
    } });
  }
  app.delete(C, async (req, reply) => {
    const { partner } = ctx(req);
    if (partner.state !== 'connected') return reply.status(405).send(envelope(undefined, STATUS.CLIENT_ERROR, 'not registered'));
    await closePartner(partner, false);
    return envelope(undefined);
  });

  // ── locations (SENDER)
  const L = `/ocpi/${OCPI_VERSION}/locations`;
  app.get(L, async (req, reply) => {
    const { partner, party } = ctx(req);
    const p = paging(req.query as Record<string, unknown>);
    const all = (await renderLocations(partner.org_id, party)).map((l) => l.location)
      .filter((l) => (!p.dateFrom || new Date(l.last_updated) >= p.dateFrom) && (!p.dateTo || new Date(l.last_updated) < p.dateTo));
    return page(req, reply, all.slice(p.offset, p.offset + p.limit), all.length, p);
  });
  app.get(`${L}/:locationId`, async (req, reply) => {
    const { partner, party } = ctx(req);
    const { locationId } = req.params as { locationId: string };
    const l = await findLocation(partner, party, locationId);
    return l ? envelope(l.location) : reply.status(404).send(envelope(undefined, STATUS.UNKNOWN_LOCATION, 'unknown location'));
  });
  app.get(`${L}/:locationId/:evseUid`, async (req, reply) => {
    const { partner, party } = ctx(req);
    const { locationId, evseUid } = req.params as { locationId: string; evseUid: string };
    const evse = (await findLocation(partner, party, locationId))?.location.evses.find((e) => e.uid === evseUid);
    return evse ? envelope(evse) : reply.status(404).send(envelope(undefined, STATUS.UNKNOWN_LOCATION, 'unknown location or EVSE'));
  });
  app.get(`${L}/:locationId/:evseUid/:connectorId`, async (req, reply) => {
    const { partner, party } = ctx(req);
    const { locationId, evseUid, connectorId } = req.params as { locationId: string; evseUid: string; connectorId: string };
    const conn = (await findLocation(partner, party, locationId))?.location.evses.find((e) => e.uid === evseUid)?.connectors.find((c) => c.id === connectorId);
    return conn ? envelope(conn) : reply.status(404).send(envelope(undefined, STATUS.UNKNOWN_LOCATION, 'unknown location, EVSE or connector'));
  });

  // ── tariffs (SENDER)
  app.get(`/ocpi/${OCPI_VERSION}/tariffs`, async (req, reply) => {
    const { partner, party } = ctx(req);
    const p = paging(req.query as Record<string, unknown>);
    const all = (await renderTariffs(partner.org_id, party, await publishedTariffIds(partner.org_id, party))).map((t) => t.tariff)
      .filter((t) => (!p.dateFrom || new Date(t.last_updated) >= p.dateFrom) && (!p.dateTo || new Date(t.last_updated) < p.dateTo));
    return page(req, reply, all.slice(p.offset, p.offset + p.limit), all.length, p);
  });

  // ── sessions and CDRs (SENDER): each partner sees only its own drivers' sessions
  app.get(`/ocpi/${OCPI_VERSION}/sessions`, async (req, reply) => {
    const { partner, party } = ctx(req);
    const p = paging(req.query as Record<string, unknown>);
    if (!p.dateFrom) return reply.status(400).send(envelope(undefined, STATUS.INVALID_PARAMS, 'date_from is required'));
    const r = await listSessions(partner.org_id, partner.id, party, p);
    return page(req, reply, r.items, r.total, p);
  });
  app.put(`/ocpi/${OCPI_VERSION}/sessions/:sessionId/charging_preferences`, async () =>
    // Smart-charging preferences from the driver are not supported yet.
    envelope('NOT_POSSIBLE'));
  app.get(`/ocpi/${OCPI_VERSION}/cdrs`, async (req, reply) => {
    const { partner, party } = ctx(req);
    const p = paging(req.query as Record<string, unknown>);
    const r = await listCdrs(partner.org_id, partner.id, party, p);
    return page(req, reply, r.items, r.total, p);
  });

  // ── tokens (RECEIVER)
  const T = `/ocpi/${OCPI_VERSION}/tokens/:cc/:pid/:uid`;
  const tokenPath = (req: FastifyRequest) => {
    const { cc, pid, uid } = req.params as { cc: string; pid: string; uid: string };
    const type = String((req.query as Record<string, unknown>)?.type ?? 'RFID');
    return { country_code: cc.toUpperCase(), party_id: pid.toUpperCase(), uid, type };
  };
  app.get(T, async (req, reply) => {
    const { partner } = ctx(req);
    const k = tokenPath(req);
    const t = await getToken(partner.org_id, k.country_code, k.party_id, k.uid, k.type);
    if (!t || t.partner_id !== partner.id) return reply.status(404).send(envelope(undefined, STATUS.UNKNOWN_TOKEN, 'unknown token'));
    return envelope(tokenOut(t));
  });
  app.put(T, async (req, reply) => {
    const { partner } = ctx(req);
    const k = tokenPath(req);
    if (!(await partnerActsFor(partner, k.country_code, k.party_id))) {
      return reply.status(403).send(envelope(undefined, STATUS.CLIENT_ERROR, `this connection may not push tokens for ${k.country_code}*${k.party_id}`));
    }
    const t = parseToken(req.body, k);
    if (typeof t === 'string') return reply.status(400).send(envelope(undefined, STATUS.INVALID_PARAMS, t));
    if (t.type !== k.type && (req.query as any)?.type) return reply.status(400).send(envelope(undefined, STATUS.INVALID_PARAMS, 'type must match ?type='));
    await upsertToken(partner, t);
    return envelope(undefined);
  });
  app.patch(T, async (req, reply) => {
    const { partner } = ctx(req);
    const k = tokenPath(req);
    const cur = await getToken(partner.org_id, k.country_code, k.party_id, k.uid, k.type);
    if (!cur || cur.partner_id !== partner.id) return reply.status(404).send(envelope(undefined, STATUS.UNKNOWN_TOKEN, 'unknown token'));
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!b.last_updated) return reply.status(400).send(envelope(undefined, STATUS.INVALID_PARAMS, 'last_updated is required'));
    const merged = parseToken({ ...tokenOut(cur), ...b, country_code: cur.country_code, party_id: cur.party_id, uid: cur.uid, type: cur.type }, k);
    if (typeof merged === 'string') return reply.status(400).send(envelope(undefined, STATUS.INVALID_PARAMS, merged));
    await upsertToken(partner, merged);
    return envelope(undefined);
  });

  // ── commands (RECEIVER)
  app.post(`/ocpi/${OCPI_VERSION}/commands/:command`, async (req, reply) => {
    const { partner, party } = ctx(req);
    const { command } = req.params as { command: string };
    const from = {
      country_code: typeof req.headers['ocpi-from-country-code'] === 'string' ? req.headers['ocpi-from-country-code'] : partner.country_code,
      party_id: typeof req.headers['ocpi-from-party-id'] === 'string' ? req.headers['ocpi-from-party-id'] : partner.party_id,
    };
    try {
      const o = await handleCommand(partner, party, from, command.toUpperCase(), req.body);
      runFollowUp(o, command);
      const http = o.ocpiStatus === STATUS.UNKNOWN_LOCATION ? 404 : o.ocpiStatus === STATUS.INVALID_PARAMS ? 400 : 200;
      return reply.status(http).send(envelope(o.response, o.ocpiStatus));
    } catch (e) { return fail(reply, e); }
  });

  // ── chargingprofiles (RECEIVER): a partner limits its driver's session
  const CP = `/ocpi/${OCPI_VERSION}/chargingprofiles/:sessionId`;
  const profileReply = (reply: FastifyReply, o: ProfileOutcome, what: string) => {
    if (o.followUp) {
      const f = o.followUp;
      setImmediate(() => void f().catch((e) => logger.warn({ what, err: (e as Error).message }, 'charging profile follow-up failed')));
    }
    return reply.status(o.http).send(envelope(o.response, o.ocpiStatus, o.message));
  };
  app.get(CP, async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    try { return profileReply(reply, await activeProfile(ctx(req).partner, sessionId, req.query as Record<string, unknown>), 'get'); } catch (e) { return fail(reply, e); }
  });
  app.put(CP, async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    try { return profileReply(reply, await setProfile(ctx(req).partner, sessionId, req.body), 'set'); } catch (e) { return fail(reply, e); }
  });
  app.delete(CP, async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const q = req.query as Record<string, unknown>;
    try { return profileReply(reply, await clearProfile(ctx(req).partner, sessionId, q?.response_url), 'clear'); } catch (e) { return fail(reply, e); }
  });

  // ── hubclientinfo (RECEIVER): the parties behind a hub
  const H = `/ocpi/${OCPI_VERSION}/hubclientinfo/:cc/:pid`;
  app.get(H, async (req, reply) => {
    const { cc, pid } = req.params as { cc: string; pid: string };
    const c = await getClientInfo(ctx(req).partner, cc.toUpperCase(), pid.toUpperCase());
    return c ? envelope(c) : reply.status(404).send(envelope(undefined, STATUS.CLIENT_ERROR, 'unknown party'));
  });
  app.put(H, async (req, reply) => {
    const { cc, pid } = req.params as { cc: string; pid: string };
    try {
      await receiveClientInfo(ctx(req).partner, cc.toUpperCase(), pid.toUpperCase(), req.body);
      return envelope(undefined);
    } catch (e) { return fail(reply, e); }
  });

  // ═════════════════════════════════════════ eMSP role: our cards on CPOs' networks
  const E = `/ocpi/${OCPI_VERSION}/emsp`;
  const up = (s: string) => String(s).toUpperCase();
  const ok = (reply: FastifyReply, found: unknown, what: string, code: number = STATUS.CLIENT_ERROR) =>
    found ? envelope(found) : reply.status(404).send(envelope(undefined, code, `unknown ${what}`));
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try { await fn(); return envelope(undefined); } catch (e) { return fail(reply, e); }
  };

  // ── tokens (SENDER): our shared cards, and real-time authorisation
  app.get(`${E}/tokens`, async (req, reply) => {
    const { partner, party } = ctx(req);
    const p = paging(req.query as Record<string, unknown>);
    const all = (await roamingCards(partner.org_id)).map((c) => cardToken(party, c))
      .filter((t) => (!p.dateFrom || new Date(t.last_updated) >= p.dateFrom) && (!p.dateTo || new Date(t.last_updated) < p.dateTo));
    return page(req, reply, all.slice(p.offset, p.offset + p.limit), all.length, p);
  });
  app.post(`${E}/tokens/:uid/authorize`, async (req, reply) => {
    const { partner, party } = ctx(req);
    const { uid } = req.params as { uid: string };
    const type = String((req.query as Record<string, unknown>)?.type ?? 'RFID');
    const r = await authorizeForCpo(partner, party, uid, type, req.body);
    return r ? envelope(r) : reply.status(404).send(envelope(undefined, STATUS.UNKNOWN_TOKEN, 'unknown token'));
  });

  // ── locations (RECEIVER)
  for (const method of ['PUT', 'PATCH'] as const) {
    for (const suffix of ['/:cc/:pid/:loc', '/:cc/:pid/:loc/:evse', '/:cc/:pid/:loc/:evse/:conn']) {
      app.route({ method, url: `${E}/locations${suffix}`, handler: async (req, reply) => {
        const { partner } = ctx(req);
        const q = req.params as { cc: string; pid: string; loc: string; evse?: string; conn?: string };
        return run(reply, () => receiveLocation(partner, method, { ...q, cc: up(q.cc), pid: up(q.pid) }, req.body));
      } });
    }
  }
  app.get(`${E}/locations/:cc/:pid/:loc`, async (req, reply) => {
    const q = req.params as { cc: string; pid: string; loc: string };
    return ok(reply, await getRemoteLocation(ctx(req).partner, up(q.cc), up(q.pid), q.loc), 'location', STATUS.UNKNOWN_LOCATION);
  });
  app.get(`${E}/locations/:cc/:pid/:loc/:evse`, async (req, reply) => {
    const q = req.params as { cc: string; pid: string; loc: string; evse: string };
    const l = await getRemoteLocation(ctx(req).partner, up(q.cc), up(q.pid), q.loc);
    return ok(reply, l?.evses?.find((e: any) => e.uid === q.evse), 'EVSE', STATUS.UNKNOWN_LOCATION);
  });
  app.get(`${E}/locations/:cc/:pid/:loc/:evse/:conn`, async (req, reply) => {
    const q = req.params as { cc: string; pid: string; loc: string; evse: string; conn: string };
    const l = await getRemoteLocation(ctx(req).partner, up(q.cc), up(q.pid), q.loc);
    return ok(reply, l?.evses?.find((e: any) => e.uid === q.evse)?.connectors?.find((c: any) => c.id === q.conn), 'connector', STATUS.UNKNOWN_LOCATION);
  });

  // ── tariffs (RECEIVER)
  app.get(`${E}/tariffs/:cc/:pid/:id`, async (req, reply) => {
    const q = req.params as { cc: string; pid: string; id: string };
    return ok(reply, await getRemoteTariff(ctx(req).partner, up(q.cc), up(q.pid), q.id), 'tariff');
  });
  for (const method of ['PUT', 'DELETE'] as const) {
    app.route({ method, url: `${E}/tariffs/:cc/:pid/:id`, handler: async (req, reply) => {
      const q = req.params as { cc: string; pid: string; id: string };
      return run(reply, () => receiveTariff(ctx(req).partner, method, { ...q, cc: up(q.cc), pid: up(q.pid) }, req.body));
    } });
  }

  // ── sessions (RECEIVER): our drivers on their chargers
  app.get(`${E}/sessions/:cc/:pid/:id`, async (req, reply) => {
    const q = req.params as { cc: string; pid: string; id: string };
    return ok(reply, await getRemoteSession(ctx(req).partner, up(q.cc), up(q.pid), q.id), 'session');
  });
  for (const method of ['PUT', 'PATCH'] as const) {
    app.route({ method, url: `${E}/sessions/:cc/:pid/:id`, handler: async (req, reply) => {
      const { partner, party } = ctx(req);
      const q = req.params as { cc: string; pid: string; id: string };
      return run(reply, () => receiveSession(partner, party, method, { ...q, cc: up(q.cc), pid: up(q.pid) }, req.body));
    } });
  }

  // ── cdrs (RECEIVER): what we owe for our drivers' sessions
  app.post(`${E}/cdrs`, async (req, reply) => {
    const { partner, party } = ctx(req);
    try {
      const id = await receiveCdr(partner, party, req.body);
      reply.header('location', `${base(req)}${E}/cdrs/${id}`);
      return envelope(undefined);
    } catch (e) { return fail(reply, e); }
  });
  app.get(`${E}/cdrs/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    return ok(reply, await getRemoteCdr(ctx(req).partner, id), 'CDR');
  });

  // ── commands (SENDER): results of the commands we sent
  app.post(`${E}/commands/:command/:id`, async (req, reply) => {
    const { command, id } = req.params as { command: string; id: string };
    try {
      const found = await receiveCommandResult(ctx(req).partner, up(command), id, req.body);
      return found ? envelope(undefined) : reply.status(404).send(envelope(undefined, STATUS.CLIENT_ERROR, 'unknown command'));
    } catch (e) { return fail(reply, e); }
  });

  logger.info('OCPI 2.2.1 (CPO and eMSP) mounted at /ocpi');
}

async function findLocation(partner: PartnerRow, party: Party, id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const [l] = await renderLocations(partner.org_id, party, { siteId: id });
  return l ?? null;
}
