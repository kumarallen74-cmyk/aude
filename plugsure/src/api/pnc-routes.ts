import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { limitParam } from './paging.js';
import { assertCan } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import * as pnc from '../pnc/service.js';
import { issueTestContract, revokeTestContract, PkiError } from '../pnc/pki.js';

/**
 * Operate → Plug & Charge (ISO 15118): settings, contracts (eMAIDs), trust
 * anchors, chargers' V2G certificates and the exchange log.
 *
 *   view                 charge_point:read
 *   settings, anchors    org:write
 *   contracts            token:read / token:write
 *   charger actions      charge_point:command (switching Plug & Charge on: charge_point:config)
 */
export async function registerPncRoutes(app: FastifyInstance): Promise<void> {
  const org = (req: FastifyRequest) => req.principal.orgId;
  const actor = (req: FastifyRequest) => ({ type: 'user' as const, id: req.principal.userId, orgId: req.principal.orgId, ip: req.ip });
  const audit = (req: FastifyRequest, action: string, targetType: string, targetId: string, after?: unknown) =>
    writeAudit({ orgId: org(req), actorType: 'user', actorId: req.principal.userId, action, targetType, targetId, after: (after ?? null) as any, ip: req.ip });
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof pnc.PncError) return reply.status(e.statusCode).send({ error: e.message });
      if (e instanceof PkiError) return reply.status(409).send({ error: e.message });
      throw e;
    }
  };
  const ident = (req: FastifyRequest) => (req.params as { identity: string }).identity;

  app.get('/v1/pnc', async (req) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    return pnc.overview(org(req));
  });

  app.put('/v1/pnc/settings', async (req) => {
    assertCan(req.principal, { permission: 'org:write' });
    const s = await pnc.putSettings(org(req), req.body ?? {});
    await audit(req, 'pnc.settings_updated', 'organisation', org(req), s);
    return s;
  });

  // ---------------------------------------------------------------- contracts

  app.get('/v1/pnc/contracts', async (req) => {
    assertCan(req.principal, { permission: 'token:read' });
    return { contracts: await pnc.listContracts(org(req)) };
  });

  app.post('/v1/pnc/contracts', async (req, reply) => {
    assertCan(req.principal, { permission: 'token:write' });
    return run(reply, async () => {
      const c = (await pnc.createContract(org(req), req.body ?? {})) as any;
      await audit(req, 'pnc.contract_created', 'token', c.id, { emaid: c.emaid, accountType: c.account_type, fleetName: c.fleet_name });
      return reply.status(201).send(c);
    });
  });

  for (const [path, active] of [['cancel', false], ['reactivate', true]] as const) {
    app.post(`/v1/pnc/contracts/:id/${path}`, async (req, reply) => {
      assertCan(req.principal, { permission: 'token:write' });
      const { id } = req.params as { id: string };
      return run(reply, async () => {
        const c = await pnc.setContractStatus(org(req), id, active);
        await audit(req, active ? 'pnc.contract_reactivated' : 'pnc.contract_cancelled', 'token', id);
        return c;
      });
    });
  }

  // ---------------------------------------------------------------- trust anchors

  app.get('/v1/pnc/trust-anchors', async (req) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    return { anchors: await pnc.listTrustAnchors(org(req)) };
  });

  app.post('/v1/pnc/trust-anchors', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    const b = (req.body ?? {}) as { kind?: string; pem?: string };
    return run(reply, async () => {
      const a = (await pnc.addTrustAnchor(org(req), String(b.kind ?? ''), String(b.pem ?? ''))) as any;
      await audit(req, 'pnc.trust_anchor_added', 'pnc_trust_anchor', a.id, { kind: a.kind, subject: a.subject, fingerprint: a.fingerprint });
      return reply.status(201).send(a);
    });
  });

  app.post('/v1/pnc/trust-anchors/sync', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    return run(reply, async () => {
      const r = await pnc.syncTrustAnchors(org(req));
      await audit(req, 'pnc.trust_anchors_synced', 'organisation', org(req), { received: r.received });
      return r;
    });
  });

  app.delete('/v1/pnc/trust-anchors/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'org:write' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      await pnc.removeTrustAnchor(org(req), id);
      await audit(req, 'pnc.trust_anchor_removed', 'pnc_trust_anchor', id);
      return reply.status(204).send();
    });
  });

  // ---------------------------------------------------------------- chargers

  app.get('/v1/pnc/chargers', async (req) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    return { chargers: await pnc.listChargers(org(req)) };
  });

  app.post('/v1/pnc/chargers/:identity/enable', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:config' });
    const on = (req.body as any)?.enabled !== false;
    return run(reply, async () => {
      const r = await pnc.enableCharger(org(req), ident(req), on, actor(req));
      await audit(req, on ? 'pnc.charger_enabled' : 'pnc.charger_disabled', 'charge_point', ident(req), r);
      return r;
    });
  });

  app.post('/v1/pnc/chargers/:identity/request-certificate', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:command' });
    return run(reply, () => pnc.requestCertificate(org(req), ident(req), actor(req)));
  });

  app.post('/v1/pnc/chargers/:identity/install-roots', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:command' });
    const kinds = Array.isArray((req.body as any)?.kinds) ? (req.body as any).kinds.map(String) : undefined;
    return run(reply, () => pnc.installRoots(org(req), ident(req), actor(req), kinds));
  });

  app.post('/v1/pnc/chargers/:identity/read-installed', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:command' });
    return run(reply, () => pnc.readInstalled(org(req), ident(req), actor(req)));
  });

  app.post('/v1/pnc/chargers/:identity/delete-certificate', async (req, reply) => {
    assertCan(req.principal, { permission: 'charge_point:command' });
    return run(reply, async () => {
      const r = await pnc.deleteInstalled(org(req), ident(req), (req.body as any)?.certificateHashData, actor(req));
      await audit(req, 'pnc.certificate_deleted', 'charge_point', ident(req), (req.body as any)?.certificateHashData);
      return r;
    });
  });

  app.get('/v1/pnc/events', async (req) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    const q = (req.query ?? {}) as { identity?: string; limit?: string };
    return { events: await pnc.listEvents(org(req), { identity: q.identity || undefined, limit: q.limit ? limitParam(q.limit, 100, 10_000) : undefined }) };
  });

  // ---------------------------------------------------------------- test PKI

  app.post('/v1/pnc/test-contracts', async (req, reply) => {
    assertCan(req.principal, { permission: 'token:write' });
    const emaid = pnc.normaliseEmaid((req.body as any)?.emaid);
    if (!emaid) return reply.status(422).send({ error: 'eMAID must look like ID-PLS-C12345678.' });
    return run(reply, async () => reply.status(201).send(await issueTestContract(emaid)));
  });

  app.post('/v1/pnc/test-contracts/:serial/revoke', async (req, reply) => {
    assertCan(req.principal, { permission: 'token:write' });
    const { serial } = req.params as { serial: string };
    return run(reply, async () => ({ revoked: await revokeTestContract(serial) }));
  });
}
