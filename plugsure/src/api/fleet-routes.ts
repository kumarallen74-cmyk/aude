import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { limitParam } from './paging.js';
import { assertCan } from '../services/authz.js';
import { writeAudit } from '../services/audit.js';
import * as fb from '../services/fleet-billing.js';
import * as credit from '../services/fleet-credit.js';
import { invoicePdf, creditNotePdf } from '../services/fleet-pdf.js';

/**
 * Fleet billing (Commercial → Fleet billing): fleet accounts, their monthly
 * statements, invoices and credit notes (with PDFs), and the e-Faktur export.
 * Reading needs invoice:read; issuing, voiding, crediting, payments and settings
 * need invoice:write.
 */
export async function registerFleetRoutes(app: FastifyInstance): Promise<void> {
  const org = (req: FastifyRequest) => req.principal.orgId;
  const audit = (req: FastifyRequest, action: string, targetType: string, targetId: string, after?: Record<string, unknown>) =>
    writeAudit({ orgId: org(req), actorType: 'user', actorId: req.principal.userId, action, targetType, targetId, after: after ?? null, ip: req.ip });
  /** Runs a handler, mapping FleetBillingError to its status. */
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof fb.FleetBillingError) return reply.status(e.status).send({ error: e.message });
      throw e;
    }
  };
  const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_');

  // ---------------------------------------------------------------- settings

  app.get('/v1/fleet-billing/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    return run(reply, () => fb.getSettings(org(req)));
  });

  app.put('/v1/fleet-billing/settings', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    return run(reply, async () => {
      const r = await fb.saveSettings(org(req), req.body ?? {}, req.principal.userId);
      await audit(req, 'fleet_billing.settings_saved', 'organisation', org(req), { seller: r.seller, settings: r.settings } as any);
      return r;
    });
  });

  // ---------------------------------------------------------------- accounts

  app.get('/v1/fleet-accounts', async (req) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    return { accounts: await fb.listAccounts(org(req), q.archived === '1' || q.archived === 'true') };
  });

  app.post('/v1/fleet-accounts', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    return run(reply, async () => {
      const a = await fb.createAccount(org(req), req.body ?? {});
      await audit(req, 'fleet_account.created', 'fleet_account', a.id, { name: a.name });
      return reply.status(201).send(a);
    });
  });

  app.get('/v1/fleet-accounts/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    const { id } = req.params as { id: string };
    return run(reply, () => fb.getAccount(org(req), id));
  });

  app.put('/v1/fleet-accounts/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      const a = await fb.updateAccount(org(req), id, req.body ?? {});
      await audit(req, 'fleet_account.updated', 'fleet_account', id, req.body as Record<string, unknown>);
      return a;
    });
  });

  app.post('/v1/fleet-accounts/:id/archive', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    const { id } = req.params as { id: string };
    const archived = (req.body as any)?.archived !== false;
    return run(reply, async () => {
      const a = await fb.archiveAccount(org(req), id, archived);
      await audit(req, archived ? 'fleet_account.archived' : 'fleet_account.restored', 'fleet_account', id);
      return a;
    });
  });

  app.put('/v1/fleet-accounts/:id/cards', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    assertCan(req.principal, { permission: 'token:write' });
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { add?: unknown; remove?: unknown };
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String).slice(0, 1000) : []);
    return run(reply, async () => {
      const r = await fb.assignCards(org(req), id, list(b.add), list(b.remove));
      await audit(req, 'fleet_account.cards_changed', 'fleet_account', id, { add: list(b.add), remove: list(b.remove) });
      return r;
    });
  });

  app.get('/v1/fleet-accounts/:id/statement', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    const { id } = req.params as { id: string };
    const q = (req.query ?? {}) as Record<string, string>;
    return run(reply, () => fb.statementFor(org(req), id, String(q.period ?? '')));
  });

  app.get('/v1/fleet-accounts/:id/statement.html', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    const { id } = req.params as { id: string };
    const q = (req.query ?? {}) as Record<string, string>;
    return run(reply, async () => {
      const st = await fb.statementFor(org(req), id, String(q.period ?? ''));
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return fb.invoiceHtml(st);
    });
  });

  // ---------------------------------------------------------------- a month

  app.get('/v1/fleet-billing/periods/:period', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    const { period } = req.params as { period: string };
    return run(reply, () => fb.periodOverview(org(req), period));
  });

  app.post('/v1/fleet-billing/periods/:period/issue', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    const { period } = req.params as { period: string };
    return run(reply, async () => {
      const r = await fb.issueAll(org(req), period, req.principal.userId);
      for (const i of r.issued) await audit(req, 'fleet_invoice.issued', 'fleet_invoice', i.number, { period, accountId: i.accountId });
      return r;
    });
  });

  app.get('/v1/fleet-billing/periods/:period/efaktur.xml', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    const { period } = req.params as { period: string };
    const q = (req.query ?? {}) as Record<string, string>;
    const ids = q.ids ? String(q.ids).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    return run(reply, async () => {
      // Invoices already exported are skipped unless named in ids or reexport=true (a re-import makes duplicate drafts in Coretax).
      const r = await fb.efakturExport(org(req), period, ids, { reexport: q.reexport === 'true' || q.reexport === '1' });
      await audit(req, 'fleet_invoice.efaktur_exported', 'fleet_billing', period, { invoices: r.included, skipped: r.skipped });
      reply.header('Content-Type', 'application/xml; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="efaktur-${safeName(period)}.xml"`);
      reply.header('X-PlugSure-Included', r.included.join(','));
      reply.header('X-PlugSure-Skipped', encodeURIComponent(JSON.stringify(r.skipped)));
      return r.xml;
    });
  });

  // ---------------------------------------------------------------- invoices

  app.post('/v1/fleet-invoices', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    const b = (req.body ?? {}) as { fleetAccountId?: string; period?: string };
    return run(reply, async () => {
      const r = await fb.issueInvoice(org(req), String(b.fleetAccountId ?? ''), String(b.period ?? ''), req.principal.userId);
      await audit(req, 'fleet_invoice.issued', 'fleet_invoice', r.id, { number: r.number, period: b.period, total: r.totalIdr });
      return reply.status(201).send(await fb.getInvoice(org(req), r.id));
    });
  });

  app.get('/v1/fleet-invoices', async (req) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    return { invoices: await fb.listInvoices(org(req), { accountId: q.accountId, status: q.status, limit: q.limit ? limitParam(q.limit, 100, 10_000) : undefined }) };
  });

  app.get('/v1/fleet-invoices/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    const { id } = req.params as { id: string };
    return run(reply, () => fb.getInvoice(org(req), id));
  });

  app.get('/v1/fleet-invoices/:id/invoice.html', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      const st = await fb.getInvoice(org(req), id);
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return fb.invoiceHtml(st);
    });
  });

  app.get('/v1/fleet-invoices/:id/invoice.csv', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      const st = await fb.getInvoice(org(req), id);
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${safeName(st.number)}-sessions.csv"`);
      return fb.invoiceCsv(st);
    });
  });

  app.post('/v1/fleet-invoices/:id/pay', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      const r = await fb.markPaid(org(req), id, req.body ?? {});
      await audit(req, 'fleet_invoice.paid', 'fleet_invoice', id, { paidAt: r.paidAt, reference: r.paidReference });
      return r;
    });
  });

  app.post('/v1/fleet-invoices/:id/void', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      const r = await fb.voidInvoice(org(req), id, String((req.body as any)?.reason ?? ''));
      await audit(req, 'fleet_invoice.voided', 'fleet_invoice', id, { reason: r.invoice.voidReason });
      return r;
    });
  });

  app.put('/v1/fleet-invoices/:id/faktur-number', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      const r = await fb.setFakturNumber(org(req), id, (req.body as any)?.number ?? null);
      await audit(req, 'fleet_invoice.faktur_number_set', 'fleet_invoice', id, { number: r.efakturNumber });
      return r;
    });
  });

  app.post('/v1/fleet-invoices/:id/send', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      const r = await fb.sendInvoice(org(req), id, (req.body as any)?.to ? String((req.body as any).to) : undefined);
      await audit(req, 'fleet_invoice.sent', 'fleet_invoice', id, { to: r.to });
      return r;
    });
  });

  app.get('/v1/fleet-invoices/:id/invoice.pdf', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      const st = await fb.getInvoice(org(req), id);
      return sendPdf(reply, `${st.number}.pdf`, invoicePdf(st));
    });
  });

  app.get('/v1/fleet-accounts/:id/statement.pdf', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    const { id } = req.params as { id: string };
    const q = (req.query ?? {}) as Record<string, string>;
    return run(reply, async () => {
      const st = await fb.statementFor(org(req), id, String(q.period ?? ''));
      return sendPdf(reply, `${st.number ?? `statement-${st.period}`}.pdf`, invoicePdf(st));
    });
  });

  // ---------------------------------------------------------------- credit notes

  app.post('/v1/fleet-invoices/:id/credit-notes', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      const r = await credit.issueCreditNote(org(req), id, req.body ?? {}, req.principal.userId);
      await audit(req, 'fleet_credit_note.issued', 'fleet_credit_note', r.id, { number: r.number, invoiceId: id, settlement: r.settlement, total: r.totalIdr, reason: (req.body as any)?.reason });
      return reply.status(201).send({ creditNote: await credit.getCreditNote(org(req), r.id), settledInvoice: r.settledInvoice, fakturWarning: r.fakturWarning });
    });
  });

  app.get('/v1/fleet-credit-notes', async (req) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    return { creditNotes: await credit.listCreditNotes(org(req), { accountId: q.accountId, invoiceId: q.invoiceId, open: q.open === '1' || q.open === 'true' }) };
  });

  app.get('/v1/fleet-credit-notes/:id', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    const { id } = req.params as { id: string };
    return run(reply, () => credit.getCreditNote(org(req), id));
  });

  app.get('/v1/fleet-credit-notes/:id/credit-note.pdf', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:read' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      const cn = await credit.getCreditNote(org(req), id);
      return sendPdf(reply, `${cn.number}.pdf`, creditNotePdf(cn));
    });
  });

  app.post('/v1/fleet-credit-notes/:id/refunded', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      const r = await credit.markRefunded(org(req), id, req.body ?? {});
      await audit(req, 'fleet_credit_note.refunded', 'fleet_credit_note', id, { refundedAt: r.refundedAt, reference: r.refundReference });
      return r;
    });
  });

  app.post('/v1/fleet-credit-notes/:id/void', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      const r = await credit.voidCreditNote(org(req), id, String((req.body as any)?.reason ?? ''));
      await audit(req, 'fleet_credit_note.voided', 'fleet_credit_note', id, { reason: r.voidReason });
      return r;
    });
  });

  app.post('/v1/fleet-credit-notes/:id/send', async (req, reply) => {
    assertCan(req.principal, { permission: 'invoice:write' });
    const { id } = req.params as { id: string };
    return run(reply, async () => {
      const r = await credit.sendCreditNote(org(req), id, creditNotePdf, (req.body as any)?.to ? String((req.body as any).to) : undefined);
      await audit(req, 'fleet_credit_note.sent', 'fleet_credit_note', id, { to: r.to });
      return r;
    });
  });
}

/** A generated PDF, downloaded under its document number. */
export function sendPdf(reply: FastifyReply, filename: string, pdf: Buffer) {
  reply.header('Content-Type', 'application/pdf');
  reply.header('Content-Disposition', `inline; filename="${filename.replace(/[^\w.-]+/g, '_')}"`);
  reply.header('Cache-Control', 'private, no-store');
  return reply.send(pdf);
}
