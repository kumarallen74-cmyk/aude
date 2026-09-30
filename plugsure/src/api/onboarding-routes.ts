import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { many, one } from '../db/pool.js';
import { assertCan, assertCanAny, visibleSiteIds } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import { caInfo, listStationCertificates, requestStationCertificate } from '../services/charger-ca.js';
import * as registry from '../ocpp/registry.js';

/**
 * Operate → Onboarding: chargers on their way onto the platform, the
 * charging-station CA the TLS terminator must trust, and every charger's
 * client certificate. The wizard itself uses the charge-point routes
 * (register, keys, security-profile, activate, commissioning).
 */
export async function registerOnboardingRoutes(app: FastifyInstance): Promise<void> {
  const org = (req: FastifyRequest) => req.principal.orgId;

  app.get('/v1/onboarding', async (req) => {
    assertCanAny(req.principal, 'charge_point:read');
    const visible = visibleSiteIds(req.principal, 'charge_point:read');
    const rows = await many<any>(
      `SELECT cp.ocpp_identity, cp.display_name, cp.vendor, cp.model, cp.serial, cp.ocpp_version, cp.status, cp.security_profile,
              cp.boot_count, cp.last_seen_at, cp.created_at, cp.cert_auto_upgrade, cp.client_cert_fingerprint IS NOT NULL AS has_certificate,
              cp.client_cert_not_after, cp.client_cert_source, cp.auth_key_hash IS NOT NULL AS has_key, s.name AS site_name,
              (SELECT row_to_json(a) FROM (SELECT ts, outcome, detail FROM connection_attempt ca WHERE ca.ocpp_identity = cp.ocpp_identity ORDER BY ts DESC LIMIT 1) a) AS last_attempt
         FROM charge_point cp JOIN site s ON s.id = cp.site_id
        WHERE s.org_id = $1 AND cp.status <> 'decommissioned' AND cp.created_at > now() - interval '90 days'
          AND ($2::uuid[] IS NULL OR s.id = ANY($2::uuid[]))
        ORDER BY cp.created_at DESC LIMIT 200`,
      [org(req), visible],
    );
    const chargers = rows.map((r) => {
      const online = registry.isOnline(r.ocpp_identity);
      const a = r.last_attempt;
      const stage =
        r.security_profile >= 3 && !r.has_certificate ? 'needs_certificate'
          : r.status === 'pending_adoption' && online ? 'awaiting_activation'
          : a && a.outcome !== 'accepted' && !online ? 'refused'
          : r.cert_auto_upgrade ? 'certificate_in_progress'
          : r.boot_count > 0 && r.status !== 'pending_adoption' ? 'connected'
          : r.status === 'pending_adoption' ? 'registered'
          : 'waiting';
      return { ...r, online, stage };
    });
    const count = (s: string) => chargers.filter((c) => c.stage === s).length;
    return {
      chargers,
      counts: {
        total: chargers.length, connected: count('connected'), waiting: count('waiting') + count('registered'),
        refused: count('refused'), certificateInProgress: count('certificate_in_progress'), needsCertificate: count('needs_certificate'),
      },
    };
  });

  app.get('/v1/charger-ca', async (req) => {
    assertCanAny(req.principal, 'charge_point:read');
    const i = await caInfo();
    return i;
  });

  app.get('/v1/charger-ca/ca.pem', async (req, reply) => {
    assertCanAny(req.principal, 'charge_point:read');
    const i = await caInfo();
    reply.header('Content-Type', 'application/x-pem-file');
    reply.header('Content-Disposition', 'attachment; filename="plugsure-charger-ca.pem"');
    return i.certificatePem;
  });

  app.get('/v1/station-certificates', async (req) => {
    assertCanAny(req.principal, 'charge_point:read');
    const visible = visibleSiteIds(req.principal, 'charge_point:read');
    const rows = await listStationCertificates(org(req));
    const mine = visible ? rows.filter((r: any) => visible.includes(r.site_id)) : rows;
    return { certificates: mine.map((r: any) => ({ ...r, online: registry.isOnline(r.ocpp_identity) })) };
  });

  app.post('/v1/charge-points/:identity/certificate/request', async (req, reply: FastifyReply) => {
    const { identity } = req.params as { identity: string };
    const cp = await one<{ id: string; site_id: string }>(
      `SELECT cp.id, cp.site_id FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE s.org_id = $1 AND cp.ocpp_identity = $2`,
      [org(req), identity],
    );
    if (!cp) return reply.status(404).send({ error: 'charge point not found' });
    assertCan(req.principal, { permission: 'charge_point:command', orgId: org(req), siteId: cp.site_id });
    const r = await requestStationCertificate(identity, { type: 'user', id: req.principal.userId, orgId: org(req), ip: req.ip });
    await writeAudit({ orgId: org(req), actorType: 'user', actorId: req.principal.userId, action: 'charge_point.client_cert.requested', targetType: 'charge_point', targetId: identity, ip: req.ip, after: { answer: r.status } });
    return r;
  });
}
