import { many, one, outsideRequestScope } from '../db/pool.js';
import { moneyText, currencyOr } from '../domain/money.js';
import { PdfDoc, Flow, type Rgb } from './pdf.js';
import { footers } from './fleet-pdf.js';
import { preview as payoutPreview } from './owner-payout-automation.js';

/**
 * Site owners' payout and tax documents (v1.27.0), for the Site Owner portal and the operator:
 *
 *   payout advice      one per payment recorded against an owner statement: what was paid, when, the reference,
 *                      the statement, the share and what is still due (PDF)
 *   withholding        tax the operator withheld from the owner's share (tax_withholding kind owner_share, e.g.
 *                      PPh 4(2) on rent or PPh 23), with the bukti potong number once issued — the operator records
 *                      them (Finance → Tax); the owner sees them and downloads a summary
 *   yearly statement   a year's statements: share, withheld, paid, outstanding (PDF), for the owner's tax return
 *   scheduled payouts  the owner's statements in automatic payouts: ready (waiting for approval) or why not yet
 *
 * The bukti potong itself is Coretax's document: the operator gives it to the owner; the summary lists the numbers.
 */

export class OwnerDocsError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const MUTED: Rgb = [0.36, 0.39, 0.44];
const ymd = (d: Date | string | null) => (d ? (typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)) : null);

async function partiesOf(orgId: string, ownerId: string) {
  const [org, owner] = await Promise.all([
    outsideRequestScope(() => one<any>(`SELECT name, npwp, billing_address FROM organisation WHERE id = $1`, [orgId])),
    outsideRequestScope(() => one<any>(`SELECT id, name, legal_name FROM site_owner WHERE id = $1 AND org_id = $2`, [ownerId, orgId])),
  ]);
  if (!owner) throw new OwnerDocsError(404, 'No such site owner.');
  return { org: { name: org?.name ?? '', npwp: org?.npwp ?? null, address: org?.billing_address ?? null }, owner: { id: owner.id, name: owner.legal_name || owner.name } };
}

export async function withholdings(orgId: string, ownerId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT w.id, w.period, w.base_minor, w.rate_bps, w.amount_minor, w.bukti_number, to_char(w.bukti_date, 'YYYY-MM-DD') AS bukti_date, w.note, s.number, s.currency
       FROM tax_withholding w LEFT JOIN commission_statement s ON s.id = w.statement_id
      WHERE w.org_id = $1 AND w.owner_id = $2 AND w.kind = 'owner_share' AND w.voided_at IS NULL ORDER BY w.period DESC, w.id DESC`, [orgId, ownerId]));
  return rows.map((w) => ({ id: String(w.id), period: w.period, statement: w.number ?? null, currency: w.currency ?? null, base: Number(w.base_minor), ratePct: w.rate_bps / 100, amount: Number(w.amount_minor), bukti: w.bukti_number ?? null, buktiDate: w.bukti_date ?? null, note: w.note ?? null }));
}

/** What an owner is told about a statement in automatic payouts (the operator's own notes, such as a hold's reason, stay internal). */
function ownerNote(c: { ready: boolean; reason: string | null }): string {
  if (c.ready) return 'Requested for payment; waiting for the operator\'s approval.';
  const r = c.reason ?? '';
  if (r.startsWith('Held') || r.startsWith('Automatic payouts are off') || r.startsWith('Below the minimum')) return 'Paid by the operator by bank transfer.';
  if (r.startsWith('A payout is already open')) return 'A payment is on its way.';
  return r;
}

/** Everything the owner can download, with the scheduled payouts. */
export async function documents(orgId: string, ownerId: string) {
  const [stmts, pays, wh, pv] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT id, number, to_char(period, 'YYYY-MM') AS period, owner_share_minor, currency FROM commission_statement
        WHERE org_id = $1 AND owner_id = $2 AND finalised_at IS NOT NULL ORDER BY period DESC LIMIT 60`, [orgId, ownerId])),
    outsideRequestScope(() => many<any>(
      `SELECT p.id, p.statement_id, p.amount_minor, p.currency, p.paid_on, p.reference, s.number FROM statement_payment p JOIN commission_statement s ON s.id = p.statement_id
        WHERE s.org_id = $1 AND s.owner_id = $2 AND p.kind = 'owner_payout' AND p.voided_at IS NULL ORDER BY p.paid_on DESC, p.id DESC LIMIT 120`, [orgId, ownerId])),
    withholdings(orgId, ownerId),
    payoutPreview(orgId).catch(() => null),
  ]);
  const years = [...new Set(stmts.map((s) => s.period.slice(0, 4)))].sort().reverse();
  return {
    advices: pays.map((p) => ({ paymentId: String(p.id), statement: p.number, paidOn: ymd(p.paid_on), amount: Number(p.amount_minor), currency: p.currency, reference: p.reference })),
    withholdings: wh,
    years,
    scheduled: (pv?.candidates ?? []).filter((c) => c.ownerId === ownerId).map((c) => ({ statement: c.number, outstanding: c.outstanding, currency: c.currency, ready: c.ready, note: ownerNote(c) })),
    statements: stmts.map((s) => ({ statementId: s.id, number: s.number, period: s.period, share: Number(s.owner_share_minor), currency: s.currency })),
  };
}

export async function payoutAdvicePdf(orgId: string, ownerId: string, paymentId: string): Promise<{ filename: string; body: Buffer }> {
  if (!/^\d{1,18}$/.test(paymentId)) throw new OwnerDocsError(404, 'No such payment.');
  const p = await outsideRequestScope(() => one<any>(
    `SELECT p.*, s.number, to_char(s.period, 'YYYY-MM') AS period, s.owner_share_minor FROM statement_payment p JOIN commission_statement s ON s.id = p.statement_id
      WHERE p.id = $1 AND s.org_id = $2 AND s.owner_id = $3 AND p.kind = 'owner_payout' AND p.voided_at IS NULL`, [paymentId, orgId, ownerId]));
  if (!p) throw new OwnerDocsError(404, 'No such payment.');
  const { org, owner } = await partiesOf(orgId, ownerId);
  const paid = Number((await outsideRequestScope(() => one<{ n: string }>(
    `SELECT COALESCE(sum(amount_minor), 0) AS n FROM statement_payment WHERE statement_id = $1 AND voided_at IS NULL AND (paid_on < $2 OR (paid_on = $2 AND id <= $3))`, [p.statement_id, p.paid_on, p.id])))?.n ?? 0);
  const wh = (await withholdings(orgId, ownerId)).filter((w) => w.statement === p.number);
  const m = (n: number) => moneyText(n, currencyOr(p.currency));
  const title = `Payout advice ${p.number}`;
  const doc = new PdfDoc({ title, author: org.name, subject: `Payment to ${owner.name}` });
  const f = new Flow(doc);
  doc.text(f.left, f.y + 18, 'Payout advice', { size: 20, bold: true });
  doc.text(f.left, f.y + 34, `${org.name} to ${owner.name}`, { size: 9, color: MUTED });
  f.y += 44;
  f.heading('Payment');
  f.row('Paid on', ymd(p.paid_on) ?? '');
  f.row('Amount', m(Number(p.amount_minor)), { bold: true });
  f.row('Bank reference', p.reference);
  f.heading(`Statement ${p.number} (${p.period})`);
  f.row('Your share', m(Number(p.owner_share_minor)));
  for (const w of wh) f.row(`Withheld (${w.ratePct}%${w.bukti ? `, bukti ${w.bukti}` : ''})`, m(w.amount), { muted: true });
  f.row('Paid to date', m(paid));
  f.row('Still due', m(Math.max(0, Number(p.owner_share_minor) - paid)), { bold: true, rule: false });
  if (org.npwp) f.para(`${org.name} · NPWP ${org.npwp}`, { size: 8.5 });
  footers(doc, `${org.name} · ${title}`);
  return { filename: `payout-advice-${String(p.number).replace(/[^\w-]+/g, '-')}-${ymd(p.paid_on)}.pdf`, body: doc.toBuffer() };
}

export async function yearlyPdf(orgId: string, ownerId: string, yearRaw: unknown): Promise<{ filename: string; body: Buffer }> {
  const year = String(yearRaw ?? '');
  if (!/^\d{4}$/.test(year)) throw new OwnerDocsError(422, 'year is YYYY.');
  const { org, owner } = await partiesOf(orgId, ownerId);
  const stmts = await outsideRequestScope(() => many<any>(
    `SELECT s.id, s.number, to_char(s.period, 'YYYY-MM') AS period, s.owner_share_minor, s.currency,
            COALESCE((SELECT sum(amount_minor) FROM statement_payment p WHERE p.statement_id = s.id AND p.voided_at IS NULL), 0)::bigint AS paid
       FROM commission_statement s WHERE s.org_id = $1 AND s.owner_id = $2 AND s.finalised_at IS NOT NULL AND to_char(s.period, 'YYYY') = $3 ORDER BY s.period`, [orgId, ownerId, year]));
  const wh = (await withholdings(orgId, ownerId)).filter((w) => w.period.startsWith(year));
  const doc = new PdfDoc({ title: `Annual statement ${year} — ${owner.name}`, author: org.name, subject: `Site owner statement ${year}` });
  const f = new Flow(doc);
  doc.text(f.left, f.y + 18, `Annual statement ${year}`, { size: 20, bold: true });
  doc.text(f.left, f.y + 34, `${owner.name} · from ${org.name}`, { size: 9, color: MUTED });
  f.y += 44;
  const curs = [...new Set(stmts.map((s) => s.currency))];
  if (!curs.length) f.para('No finalised statements this year.', { size: 9.5 });
  for (const c of curs) {
    const m = (n: number) => moneyText(n, currencyOr(c));
    const mine = stmts.filter((s) => s.currency === c);
    f.heading(curs.length > 1 ? `In ${c}` : 'Statements');
    f.table([{ label: 'Month', width: 1.2 }, { label: 'Statement', width: 2 }, { label: 'Share', width: 1.6, align: 'right' }, { label: 'Withheld', width: 1.4, align: 'right' }, { label: 'Paid', width: 1.6, align: 'right' }, { label: 'Due', width: 1.4, align: 'right' }],
      mine.map((s) => {
        const w = wh.filter((x) => x.statement === s.number).reduce((a, x) => a + x.amount, 0);
        return { cells: [s.period, s.number, m(Number(s.owner_share_minor)), w ? m(w) : '', m(Number(s.paid)), m(Math.max(0, Number(s.owner_share_minor) - Number(s.paid)))] };
      }));
    const share = mine.reduce((a, s) => a + Number(s.owner_share_minor), 0), paid = mine.reduce((a, s) => a + Number(s.paid), 0);
    const withheld = wh.filter((x) => mine.some((s) => s.number === x.statement)).reduce((a, x) => a + x.amount, 0);
    f.gap(4);
    f.row('Share for the year', m(share), { bold: true });
    if (withheld) f.row('Tax withheld', m(withheld), { muted: true });
    f.row('Paid', m(paid));
    f.row('Still due', m(Math.max(0, share - paid)), { bold: true, rule: false });
  }
  if (wh.length) {
    f.heading('Tax withheld (bukti potong)');
    f.table([{ label: 'Period', width: 1.2 }, { label: 'Base', width: 1.8, align: 'right' }, { label: 'Rate', width: 0.8, align: 'right' }, { label: 'Withheld', width: 1.6, align: 'right' }, { label: 'Bukti potong', width: 2.6 }],
      wh.map((w) => ({ cells: [w.period, moneyText(w.base, currencyOr(w.currency)), `${w.ratePct}%`, moneyText(w.amount, currencyOr(w.currency)), w.bukti ? `${w.bukti}${w.buktiDate ? ` (${w.buktiDate})` : ''}` : 'not issued yet'] })));
    f.para('The bukti potong are issued in Coretax; ask the operator for any not received.', { size: 8.5 });
  }
  footers(doc, `${org.name} · Annual statement ${year} · ${owner.name}`);
  return { filename: `annual-statement-${year}-${owner.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`, body: doc.toBuffer() };
}

/** Operator: record tax withheld from an owner's share on a statement. */
export async function recordWithholding(orgId: string, ownerId: string, b: Record<string, unknown>, userId: string | null) {
  const { owner } = await partiesOf(orgId, ownerId);
  const sid = String(b.statementId ?? '');
  const s = await outsideRequestScope(() => one<any>(`SELECT id, to_char(period, 'YYYY-MM') AS period, owner_share_minor FROM commission_statement WHERE id::text = $1 AND org_id = $2 AND owner_id = $3 AND finalised_at IS NOT NULL`, [sid, orgId, ownerId]));
  if (!s) throw new OwnerDocsError(422, 'Choose one of the owner\'s finalised statements.');
  const rateBps = Math.round(Number(b.ratePct) * 100);
  if (!Number.isInteger(rateBps) || rateBps <= 0 || rateBps > 3000) throw new OwnerDocsError(422, 'The rate is above 0 and at most 30 (%).');
  const base = b.base === undefined || b.base === '' ? Number(s.owner_share_minor) : Number(b.base);
  if (!Number.isInteger(base) || base <= 0) throw new OwnerDocsError(422, 'The base is a whole amount above 0.');
  const amount = b.amount === undefined || b.amount === '' ? Math.round(base * rateBps / 10_000) : Number(b.amount);
  if (!Number.isInteger(amount) || amount < 0 || amount > base) throw new OwnerDocsError(422, 'The amount withheld is a whole amount, at most the base.');
  const bukti = b.bukti == null || b.bukti === '' ? null : String(b.bukti).trim().slice(0, 60);
  const buktiDate = b.buktiDate == null || b.buktiDate === '' ? null : String(b.buktiDate);
  if (buktiDate && !/^\d{4}-\d{2}-\d{2}$/.test(buktiDate)) throw new OwnerDocsError(422, 'The bukti potong date is YYYY-MM-DD.');
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO tax_withholding (org_id, kind, period, counterparty, statement_id, owner_id, base_minor, rate_bps, amount_minor, bukti_number, bukti_date, note, recorded_by)
     VALUES ($1, 'owner_share', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [orgId, s.period, owner.name, s.id, ownerId, base, rateBps, amount, bukti, buktiDate, b.note == null ? null : String(b.note).slice(0, 300), userId]));
  return { id: String(r!.id), period: s.period, base, ratePct: rateBps / 100, amount, bukti };
}
