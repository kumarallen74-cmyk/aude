import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { routePath } from './route-path.js';
import { many, afterResponse } from '../db/pool.js';
import { logger } from '../logger.js';
import { assertCan } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import { sandboxCall } from '../ocpp/bridge.js';
import {
  listSandboxes, createSandbox, rotateSandboxKey, deleteSandbox, sandboxInfo, SandboxError, MAX_SANDBOXES_PER_ORG,
} from '../sandbox/provision.js';
import { SIMULATE_EVENTS } from '../sandbox/events.js';
import { normaliseEmaid } from '../pnc/emaid.js';
import { issueTestContract, PkiError } from '../pnc/pki.js';

/**
 * Developer sandboxes.
 *
 *   The operator's side  /v1/sandboxes …        create, list, rotate the key, delete
 *   Inside a sandbox     /v1/sandbox …          what is in it, and simulate events at its virtual chargers
 *
 * Everything else in /v1 works in a sandbox exactly as in production, with the
 * sandbox's key. A sandbox cannot connect roaming partners.
 */
export async function registerSandboxRoutes(app: FastifyInstance): Promise<void> {
  const bad = (reply: FastifyReply, status: number, error: string) => reply.status(status).send({ error });
  const fail = (reply: FastifyReply, e: unknown) => {
    const status = Number((e as { status?: number }).status);
    if (e instanceof PkiError) return bad(reply, 409, e.message);
    if (e instanceof SandboxError || (status >= 400 && status < 600)) return bad(reply, status, (e as Error).message);
    throw e;
  };
  const audit = (req: FastifyRequest, action: string, targetId: string, after?: Record<string, unknown>) =>
    writeAudit({ orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action, targetType: 'sandbox', targetId, after: after ?? null, ip: req.ip });
  const syncFleetSoon = (reply: FastifyReply) =>
    afterResponse(reply.raw, () => sandboxCall('*', 'sync'), (e) => logger.warn({ err: e.message }, 'sandbox fleet sync failed'));

  // A sandbox never talks to real roaming partners.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.principal?.orgId || req.method === 'GET' || !routePath(req).startsWith('/v1/roaming')) return;
    if (await sandboxInfo(req.principal.orgId)) return bad(reply, 403, 'Roaming is not available in a sandbox.');
  });

  // ---------------------------------------------------------------- the operator's side

  app.get('/v1/sandboxes', async (req) => {
    assertCan(req.principal, { permission: 'org:read' });
    return { sandboxes: await listSandboxes(req.principal.orgId), max: MAX_SANDBOXES_PER_ORG };
  });

  app.post('/v1/sandboxes', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const s = await createSandbox(req.principal.orgId, String(b.name ?? ''), req.principal.userId);
      await audit(req, 'sandbox.created', s.id, { name: s.name, chargePoints: s.chargePoints.map((c) => c.identity) });
      syncFleetSoon(reply);
      return reply.status(201).send(s);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/v1/sandboxes/:id/rotate-key', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    const { id } = req.params as { id: string };
    try {
      const r = await rotateSandboxKey(req.principal.orgId, id);
      await audit(req, 'sandbox.key_rotated', id);
      return r;
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete('/v1/sandboxes/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    const { id } = req.params as { id: string };
    try {
      await deleteSandbox(req.principal.orgId, id);
      await audit(req, 'sandbox.deleted', id);
      syncFleetSoon(reply);
      return { ok: true };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ---------------------------------------------------------------- inside a sandbox

  async function mySandbox(req: FastifyRequest, reply: FastifyReply) {
    const s = await sandboxInfo(req.principal.orgId);
    if (!s) {
      bad(reply, 404, 'This is not a sandbox. Use a sandbox API key (create one under Govern → Developers).');
      return null;
    }
    return s;
  }

  const virtualChargers = (orgId: string) =>
    many<{ ocpp_identity: string; display_name: string | null; status: string; connectors: number }>(
      `SELECT cp.ocpp_identity, cp.display_name, cp.status,
              (SELECT count(*)::int FROM evse e WHERE e.charge_point_id = cp.id) AS connectors
         FROM charge_point cp JOIN site s ON s.id = cp.site_id
        WHERE s.org_id = $1 AND cp.virtual AND cp.status <> 'decommissioned'
        ORDER BY cp.ocpp_identity`,
      [orgId],
    );

  app.get('/v1/sandbox', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    const s = await mySandbox(req, reply);
    if (!s) return reply;
    const chargers = await virtualChargers(req.principal.orgId);
    const out = [];
    for (const c of chargers) {
      let simulator: unknown = null;
      try {
        simulator = (await sandboxCall<{ charger: unknown }>(c.ocpp_identity, 'status')).charger;
      } catch {
        simulator = null;
      }
      out.push({ identity: c.ocpp_identity, displayName: c.display_name, status: c.status, connectors: c.connectors, simulator });
    }
    const tokens = await many<{ uid: string; status: string; holder_name: string | null }>(
      `SELECT uid, status, holder_name FROM token WHERE org_id = $1 AND kind = 'rfid' ORDER BY uid`,
      [req.principal.orgId],
    );
    return {
      sandbox: { id: s.id, name: s.name, parent: s.parentName },
      chargePoints: out,
      tokens: tokens.map((t) => ({ uid: t.uid, status: t.status, holder: t.holder_name })),
      events: SIMULATE_EVENTS,
      timeScale: 30,
    };
  });

  app.post('/v1/sandbox/chargers/:identity/simulate', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:command' });
    if (!(await mySandbox(req, reply))) return reply;
    const { identity } = req.params as { identity: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const event = String(b.event ?? '');
    if (!(SIMULATE_EVENTS as readonly string[]).includes(event)) {
      return bad(reply, 400, `event must be one of: ${SIMULATE_EVENTS.join(', ')}`);
    }
    const mine = (await virtualChargers(req.principal.orgId)).some((c) => c.ocpp_identity === identity);
    if (!mine) return bad(reply, 404, 'charge point not found in this sandbox');
    const { event: _e, ...args } = b;
    try {
      if (event === 'plug-and-charge') {
        // The car's contract certificate comes from the test PKI; its hash data is what the charger sends.
        const emaid = normaliseEmaid(String(b.emaid ?? ''));
        if (!emaid) return bad(reply, 400, 'emaid is required: the car\'s contract, e.g. ID-PLS-C12345678');
        const c = await issueTestContract(emaid);
        return { ...(await sandboxCall<Record<string, unknown>>(identity, event, { ...args, emaid, hashData: c.hashData })), contract: { emaid, serial: c.serial } };
      }
      return await sandboxCall(identity, event, args);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/v1/sandbox/reset', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:command' });
    if (!(await mySandbox(req, reply))) return reply;
    const reset: string[] = [];
    for (const c of await virtualChargers(req.principal.orgId)) {
      try {
        await sandboxCall(c.ocpp_identity, 'come-online');
        const st = await sandboxCall<{ charger: { charging: boolean; faults: Array<{ connectorId: number }> } }>(c.ocpp_identity, 'status');
        if (st.charger.charging) await sandboxCall(c.ocpp_identity, 'stop');
        for (const f of st.charger.faults) await sandboxCall(c.ocpp_identity, 'clear-fault', { connectorId: f.connectorId });
        reset.push(c.ocpp_identity);
      } catch (e) {
        logger.debug({ cp: c.ocpp_identity, err: (e as Error).message }, 'sandbox reset skipped a charger');
      }
    }
    return { ok: true, reset };
  });
}
