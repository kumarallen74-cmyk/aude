import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { writeAudit } from '../services/audit.js';
import { afterResponse } from '../db/pool.js';
import { syncOrg as syncRoaming } from '../ocpi/push.js';
import * as fb from '../services/fleet-billing.js';
import * as credit from '../services/fleet-credit.js';
import * as portal from '../services/fleet-portal.js';
import { invoicePdf, creditNotePdf } from '../services/fleet-pdf.js';
import { sendPdf } from './fleet-routes.js';

/**
 * The fleet customer portal (/v1/fleet-portal): a fleet customer's own staff,
 * signed in to the console with the fleet_customer role, see their account's
 * invoices and credit notes (PDF), this month's charging so far and their cards,
 * and can block a lost card. Every route checks the account against the
 * principal's fleet grant first; operator roles have no access here.
 */
export async function registerFleetPortalRoutes(app: FastifyInstance): Promise<void> {
  const org = (req: FastifyRequest) => req.principal.orgId;
  const account = (req: FastifyRequest) => portal.portalAccount(req.principal, (req.params as { accountId: string }).accountId);
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof fb.FleetBillingError) return reply.status(e.status).send({ error: e.message });
      throw e;
    }
  };

  app.get('/v1/fleet-portal', async (req, reply) => {
    const ids = req.principal.fleetAccountIds ?? [];
    if (!ids.length) return reply.status(403).send({ error: 'This sign-in is not a fleet customer portal user.' });
    return portal.overview(org(req), ids);
  });

  app.get('/v1/fleet-portal/:accountId/invoices', async (req, reply) =>
    run(reply, async () => portal.invoicesOf(org(req), account(req))));

  app.get('/v1/fleet-portal/:accountId/invoices/:id/invoice.pdf', async (req, reply) =>
    run(reply, async () => {
      const id = await portal.ownInvoice(org(req), account(req), (req.params as { id: string }).id);
      const st = await fb.getInvoice(org(req), id);
      return sendPdf(reply, `${st.number}.pdf`, invoicePdf(portal.forCustomer(st)));
    }));

  app.get('/v1/fleet-portal/:accountId/invoices/:id/invoice.csv', async (req, reply) =>
    run(reply, async () => {
      const id = await portal.ownInvoice(org(req), account(req), (req.params as { id: string }).id);
      const st = await fb.getInvoice(org(req), id);
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${st.number.replace(/[^\w.-]+/g, '_')}-sessions.csv"`);
      return fb.invoiceCsv(st);
    }));

  app.get('/v1/fleet-portal/:accountId/credit-notes/:id/credit-note.pdf', async (req, reply) =>
    run(reply, async () => {
      const id = await portal.ownCreditNote(org(req), account(req), (req.params as { id: string }).id);
      const cn = await credit.getCreditNote(org(req), id);
      return sendPdf(reply, `${cn.number}.pdf`, creditNotePdf(cn));
    }));

  /** This month so far (or ?period=YYYY-MM): the invoice once issued, else the running draft. */
  app.get('/v1/fleet-portal/:accountId/statement', async (req, reply) =>
    run(reply, async () => {
      const q = (req.query ?? {}) as Record<string, string>;
      const st = await fb.statementFor(org(req), account(req), String(q.period || portal.thisPeriod()));
      if (st.status === 'void') throw new fb.FleetBillingError(404, 'statement not found');
      return portal.forCustomer(st);
    }));

  app.get('/v1/fleet-portal/:accountId/cards', async (req, reply) =>
    run(reply, async () => ({ cards: await portal.cardsOf(org(req), account(req)) })));

  app.post('/v1/fleet-portal/:accountId/cards/:tokenId/block', async (req, reply) =>
    run(reply, async () => {
      const accountId = account(req);
      const blocked = (req.body as { blocked?: unknown } | undefined)?.blocked !== false;
      const r = await portal.setCardBlocked(org(req), accountId, (req.params as { tokenId: string }).tokenId, blocked);
      await writeAudit({
        orgId: org(req), actorType: 'user', actorId: req.principal.userId, action: blocked ? 'token.blocked_by_fleet_customer' : 'token.unblocked_by_fleet_customer',
        targetType: 'token', targetId: (req.params as { tokenId: string }).tokenId, after: { status: r.status, fleetAccountId: accountId }, before: { status: r.previous }, ip: req.ip,
      });
      // A card shared for roaming must stop (or start) working on partner networks too.
      const orgId = org(req);
      afterResponse(reply.raw, () => syncRoaming(orgId), () => {});
      return { ok: true, status: r.status };
    }));
}
