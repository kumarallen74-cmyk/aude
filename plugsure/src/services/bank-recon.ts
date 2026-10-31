import { createHash } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';

/**
 * Bank statement reconciliation (v1.18.0). The operator uploads its bank's statement (CSV: BCA KlikBCA / KlikBCA
 * Bisnis, Mandiri (Livin', MCM), BRI (CMS / BRImo), or any export with date, description and amount columns); each line
 * is matched to what Finance knows should have passed through the account:
 *
 *   credit   a gateway's withdrawal to the bank (gateway_transaction kind 'payout', Xendit's payouts of collected money)
 *            for the platform: an operator's payment of its statement (statement_payment kind 'platform_fee')
 *   debit    an owner payout recorded against a statement (statement_payment kind 'owner_payout')
 *            a refund recorded as paid by bank transfer (payment_intent refund_method 'manual')
 *
 * Automatic matching takes the same amount (rupiah, to the rupiah) within 4 days, the closest date first, and a bank
 * reference that appears in the line's description first of all; each record is matched once. What is left is listed
 * for a person: match it by hand to a candidate, or mark it ignored with a note (bank fees, other business). An upload
 * that overlaps an earlier one skips the lines already there.
 */

export class BankReconError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export interface ParsedLine { date: string; description: string; reference: string | null; amount: number; balance: number | null }

/** RFC 4180-ish CSV (quotes, doubled quotes, commas or semicolons). */
export function csvRows(text: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const firstLine = t.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/** "1,000,000.00", "1.000.000,00", "1000000", "(25.000)", "1,000.00 CR" → { value, side }. */
export function parseAmount(raw: string): { value: number; side: 'CR' | 'DB' | null } | null {
  let s = String(raw ?? '').trim().toUpperCase();
  if (!s) return null;
  let side: 'CR' | 'DB' | null = null;
  const m = s.match(/\s*(CR|DB|D|K|C)\.?$/);
  if (m) { side = m[1] === 'CR' || m[1] === 'K' || m[1] === 'C' ? 'CR' : 'DB'; s = s.slice(0, m.index).trim(); }
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  s = s.replace(/^(IDR|RP\.?)\s*/, '').replace(/\s/g, '');
  if (!/^[\d.,]+$/.test(s)) return null;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  let n: string;
  if (lastDot >= 0 && lastComma >= 0) n = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  else if (lastComma >= 0) n = /,\d{1,2}$/.test(s) && (s.match(/,/g)?.length ?? 0) === 1 ? s.replace(',', '.') : s.replace(/,/g, '');
  else if (lastDot >= 0) n = /\.\d{1,2}$/.test(s) && (s.match(/\./g)?.length ?? 0) === 1 ? s : s.replace(/\./g, '');
  else n = s;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return { value: neg ? -v : v, side };
}

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, MEI: 5, JUN: 6, JUL: 7, AUG: 8, AGU: 8, AGT: 8, SEP: 9, OCT: 10, OKT: 10, NOV: 11, DEC: 12, DES: 12 };
/** dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy, yyyy-mm-dd, dd/mm/yy, dd MMM yyyy, dd/mm (the statement's year). */
export function parseDate(raw: string, year: number): string | null {
  const s = String(raw ?? '').trim().toUpperCase().replace(/^'/, '');
  let d: number, m: number, y: number;
  let x = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (x) { y = +x[1]!; m = +x[2]!; d = +x[3]!; }
  else if ((x = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/))) { d = +x[1]!; m = +x[2]!; y = +x[3]!; if (y < 100) y += 2000; }
  else if ((x = s.match(/^(\d{1,2})[\s/-]([A-Z]{3})[A-Z]*[\s/-](\d{2,4})/))) { d = +x[1]!; m = MONTHS[x[2]!] ?? 0; y = +x[3]!; if (y < 100) y += 2000; }
  else if ((x = s.match(/^(\d{1,2})\/(\d{1,2})$/))) { d = +x[1]!; m = +x[2]!; y = year; }
  else return null;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The statement's lines, whatever the bank, from its header row. */
export function parseStatement(text: string, now = new Date()): { bank: string; lines: ParsedLine[]; skipped: number } {
  const rows = csvRows(text);
  const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const find = (hdr: string[], re: RegExp, not?: RegExp) => hdr.findIndex((h) => re.test(h) && !(not && not.test(h)));
  let hi = -1, col = { date: -1, desc: -1, amount: -1, debit: -1, credit: -1, balance: -1, ref: -1, side: -1 };
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const h = rows[i]!.map(norm);
    // The posting date, not the value date (Mandiri has both: Date and Val. Date).
    const date = find(h, /^(tanggal|tgl|date|transaction date|posting date|tanggal transaksi|tgl tran)\b/, /val/);
    const desc = find(h, /(keterangan|description|desk|uraian|remark|narasi|transaction detail)/);
    if (date < 0 || desc < 0) continue;
    hi = i;
    col = {
      date, desc,
      debit: find(h, /(debet|debit|mutasi debet|withdrawal|db)\b/),
      credit: find(h, /(kredit|credit|mutasi kredit|deposit|cr)\b/),
      amount: find(h, /^(jumlah|amount|mutasi|nominal|nilai)\b/),
      balance: find(h, /(saldo|balance)/),
      ref: find(h, /(no ref|ref no|reference|referensi|no referensi|ref)\b/),
      side: find(h, /^(db cr|d k|dk|cr db|type|jenis)$/),
    };
    break;
  }
  if (hi < 0) throw new BankReconError(422, 'No header row with a date and a description column was found. Export the statement as CSV from the bank, with its column headings.');
  const head = rows[hi]!.map(norm).join(' ');
  const bank = /keterangan.*cabang|tanggal transaksi/.test(head) ? 'BCA' : /transaction code|val date/.test(head) ? 'Mandiri' : /desk tran|mutasi debet|tgl tran/.test(head) ? 'BRI' : 'bank';
  const lines: ParsedLine[] = [];
  let skipped = 0;
  for (const r of rows.slice(hi + 1)) {
    const date = parseDate(r[col.date] ?? '', now.getUTCFullYear());
    if (!date) { skipped++; continue; }
    let amount: number | null = null;
    if (col.debit >= 0 || col.credit >= 0) {
      const dr = col.debit >= 0 ? parseAmount(r[col.debit] ?? '') : null, cr = col.credit >= 0 ? parseAmount(r[col.credit] ?? '') : null;
      const v = (cr?.value ?? 0) - Math.abs(dr?.value ?? 0);
      amount = dr || cr ? v : null;
    }
    if (amount == null && col.amount >= 0) {
      const a = parseAmount(r[col.amount] ?? '');
      if (a) {
        const sideCell = col.side >= 0 ? String(r[col.side] ?? '').trim().toUpperCase() : '';
        const side = a.side ?? (/^(CR|K|C|KREDIT|CREDIT)$/.test(sideCell) ? 'CR' : /^(DB|D|DEBET|DEBIT)$/.test(sideCell) ? 'DB' : null);
        amount = side === 'DB' ? -Math.abs(a.value) : side === 'CR' ? Math.abs(a.value) : a.value;
      }
    }
    if (amount == null || amount === 0) { skipped++; continue; }
    const bal = col.balance >= 0 ? parseAmount(r[col.balance] ?? '') : null;
    lines.push({
      date, description: String(r[col.desc] ?? '').replace(/\s+/g, ' ').trim().slice(0, 400), reference: col.ref >= 0 ? (String(r[col.ref] ?? '').trim().slice(0, 80) || null) : null,
      amount: Math.round(amount), balance: bal ? Math.round(bal.side === 'DB' ? -Math.abs(bal.value) : bal.value) : null,
    });
  }
  if (!lines.length) throw new BankReconError(422, 'The file has a header but no transaction lines PlugSure could read (a date and an amount per line).');
  return { bank, lines, skipped };
}

// ─────────────────────────────────────────── candidates and matching

export interface Candidate { kind: 'gateway_withdrawal' | 'statement_payment' | 'refund'; ref: string; date: string; amount: number; label: string; reference: string | null }

/** What should appear on the operator's bank account between two dates (credits positive, debits negative). */
export async function candidates(orgId: string, platformAdmin: boolean, from: string, to: string): Promise<Candidate[]> {
  return outsideRequestScope(async () => {
    const [wd, sp, rf] = await Promise.all([
      many<any>(
        `SELECT g.id::text AS ref, to_char(g.gateway_created_at::date, 'YYYY-MM-DD') AS d, round(g.amount)::bigint AS amount, g.external_id, i.provider
           FROM gateway_transaction g JOIN integration i ON i.id = g.integration_id
          WHERE g.kind = 'payout' AND g.status = 'success' AND (g.org_id = $1 OR ($2 AND g.org_id IS NULL))
            AND g.gateway_created_at >= ($3::date - 5) AND g.gateway_created_at < ($4::date + 6)`, [orgId, platformAdmin, from, to]),
      many<any>(
        `SELECT p.id::text AS ref, to_char(p.paid_on, 'YYYY-MM-DD') AS d, p.amount_minor AS amount, p.kind, p.reference, s.number, COALESCE(w.legal_name, w.name, o.name) AS who
           FROM statement_payment p JOIN commission_statement s ON s.id = p.statement_id LEFT JOIN site_owner w ON w.id = p.owner_id LEFT JOIN organisation o ON o.id = p.org_id
          WHERE p.voided_at IS NULL AND p.paid_on BETWEEN ($3::date - 5) AND ($4::date + 5)
            AND ((p.kind = 'owner_payout' AND p.org_id = $1) OR ($2 AND p.kind = 'platform_fee'))`, [orgId, platformAdmin, from, to]),
      many<any>(
        `SELECT id::text AS ref, to_char(refunded_at::date, 'YYYY-MM-DD') AS d, refunded_minor AS amount, refund_ref
           FROM payment_intent WHERE org_id = $1 AND refund_state = 'refunded' AND refund_method = 'manual'
            AND refunded_at >= ($2::date - 5) AND refunded_at < ($3::date + 6)`, [orgId, from, to]),
    ]);
    return [
      ...wd.map((x) => ({ kind: 'gateway_withdrawal' as const, ref: x.ref, date: x.d, amount: Number(x.amount), label: `${x.provider === 'xendit' ? 'Xendit' : x.provider} payout to the bank`, reference: x.external_id })),
      ...sp.map((x) => ({ kind: 'statement_payment' as const, ref: x.ref, date: x.d, amount: x.kind === 'owner_payout' ? -Number(x.amount) : Number(x.amount),
        label: x.kind === 'owner_payout' ? `Owner payout · ${x.who ?? ''} · ${x.number}` : `Statement paid by ${x.who ?? 'operator'} · ${x.number}`, reference: x.reference })),
      ...rf.map((x) => ({ kind: 'refund' as const, ref: x.ref, date: x.d, amount: -Number(x.amount), label: 'Refund by bank transfer', reference: x.refund_ref })),
    ];
  });
}

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
const refIn = (ref: string | null, text: string) => Boolean(ref && ref.length >= 5 && text.toUpperCase().includes(ref.toUpperCase()));

/** Match the organisation's open lines automatically. Returns how many were matched. */
export async function autoMatch(orgId: string, platformAdmin: boolean): Promise<number> {
  const open = await many<any>(`SELECT id, to_char(line_date, 'YYYY-MM-DD') AS d, amount_minor, description, reference FROM bank_statement_line WHERE org_id = $1 AND matched_kind IS NULL ORDER BY line_date, id`, [orgId]);
  if (!open.length) return 0;
  const from = open[0].d, to = open[open.length - 1].d;
  const used = new Set((await many<{ k: string }>(`SELECT matched_kind || ':' || matched_ref AS k FROM bank_statement_line WHERE org_id = $1 AND matched_kind IS NOT NULL AND matched_kind <> 'ignored'`, [orgId])).map((r) => r.k));
  const cands = (await candidates(orgId, platformAdmin, from, to)).filter((c) => !used.has(`${c.kind}:${c.ref}`));
  let n = 0;
  for (const l of open) {
    const amount = Number(l.amount_minor);
    const text = `${l.description} ${l.reference ?? ''}`;
    const fits = cands.filter((c) => !used.has(`${c.kind}:${c.ref}`) && c.amount === amount && dayDiff(c.date, l.d) <= 4)
      .sort((a, b) => Number(refIn(b.reference, text)) - Number(refIn(a.reference, text)) || dayDiff(a.date, l.d) - dayDiff(b.date, l.d));
    const c = fits[0];
    if (!c) continue;
    const ok = await one(`UPDATE bank_statement_line SET matched_kind = $2, matched_ref = $3, matched_auto = true, matched_at = now() WHERE id = $1 AND matched_kind IS NULL RETURNING id`, [l.id, c.kind, c.ref]).catch(() => null);
    if (ok) { used.add(`${c.kind}:${c.ref}`); n++; }
  }
  return n;
}

/** Upload: parse, store new lines (an overlapping upload skips those already there), match. */
export async function upload(orgId: string, platformAdmin: boolean, b: { filename?: unknown; csv?: unknown }, userId: string | null) {
  const csv = String(b.csv ?? '');
  const filename = String(b.filename ?? 'statement.csv').replace(/[^\w.() -]+/g, '_').slice(0, 120) || 'statement.csv';
  if (!csv.trim()) throw new BankReconError(422, 'The file is empty.');
  if (csv.length > 4_000_000) throw new BankReconError(413, 'The file is larger than 4 MB: export a shorter period.');
  const p = parseStatement(csv);
  const dates = p.lines.map((l) => l.date).sort();
  const st = (await one<{ id: string }>(
    `INSERT INTO bank_statement (org_id, bank, filename, date_from, date_to, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [orgId, p.bank, filename, dates[0], dates[dates.length - 1], userId]))!.id;
  const seen = new Map<string, number>();
  let added = 0, duplicate = 0;
  for (const [i, l] of p.lines.entries()) {
    const base = `${l.date}|${l.amount}|${l.description}|${l.reference ?? ''}`;
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    const fp = createHash('sha256').update(`${base}|${k}`).digest('hex').slice(0, 40);
    const r = await one(
      `INSERT INTO bank_statement_line (statement_id, org_id, line_no, line_date, description, reference, amount_minor, balance_minor, fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (org_id, fingerprint) DO NOTHING RETURNING id`,
      [st, orgId, i + 1, l.date, l.description, l.reference, l.amount, l.balance, fp]);
    if (r) added++; else duplicate++;
  }
  await query(`UPDATE bank_statement SET line_count = $2 WHERE id = $1`, [st, added]);
  const matched = await autoMatch(orgId, platformAdmin);
  return { statementId: String(st), bank: p.bank, from: dates[0], to: dates[dates.length - 1], lines: added, duplicates: duplicate, skipped: p.skipped, matched };
}

export async function statements(orgId: string) {
  const rows = await many<any>(
    `SELECT s.*, u.name AS uploaded_by_name,
            (SELECT count(*) FROM bank_statement_line l WHERE l.statement_id = s.id AND l.matched_kind IS NULL)::int AS open
       FROM bank_statement s LEFT JOIN app_user u ON u.id = s.uploaded_by WHERE s.org_id = $1 ORDER BY s.uploaded_at DESC LIMIT 100`, [orgId]);
  return rows.map((s) => ({ id: String(s.id), bank: s.bank, filename: s.filename, from: s.date_from ? String(s.date_from instanceof Date ? s.date_from.toISOString().slice(0, 10) : s.date_from) : null,
    to: s.date_to ? String(s.date_to instanceof Date ? s.date_to.toISOString().slice(0, 10) : s.date_to) : null, lines: s.line_count, open: s.open, uploadedAt: new Date(s.uploaded_at).toISOString(), uploadedBy: s.uploaded_by_name ?? null }));
}

/** Lines (all statements, or one), open first; each with what it is matched to. */
export async function lines(orgId: string, platformAdmin: boolean, f: { statementId?: string; open?: boolean } = {}) {
  const rows = await many<any>(
    `SELECT l.*, to_char(l.line_date, 'YYYY-MM-DD') AS d, u.name AS matched_by_name FROM bank_statement_line l LEFT JOIN app_user u ON u.id = l.matched_by
      WHERE l.org_id = $1 AND ($2::bigint IS NULL OR l.statement_id = $2::bigint) AND ($3::boolean IS NOT TRUE OR l.matched_kind IS NULL)
      ORDER BY (l.matched_kind IS NULL) DESC, l.line_date DESC, l.id DESC LIMIT 1000`, [orgId, f.statementId ?? null, f.open ?? null]);
  const ds = rows.map((r) => r.d).sort();
  const cands = rows.length ? await candidates(orgId, platformAdmin, ds[0], ds[ds.length - 1]) : [];
  const byKey = new Map(cands.map((c) => [`${c.kind}:${c.ref}`, c]));
  return rows.map((l) => ({
    id: String(l.id), statementId: String(l.statement_id), date: l.d, description: l.description, reference: l.reference, amount: Number(l.amount_minor),
    balance: l.balance_minor != null ? Number(l.balance_minor) : null,
    match: l.matched_kind ? { kind: l.matched_kind, ref: l.matched_ref, auto: l.matched_auto, by: l.matched_by_name ?? null, note: l.note, label: byKey.get(`${l.matched_kind}:${l.matched_ref}`)?.label ?? null } : null,
  }));
}

/** For one open line: what it could be (same direction; the same amount first, then the nearest amounts and dates). */
export async function lineCandidates(orgId: string, platformAdmin: boolean, lineId: string) {
  const l = await one<any>(`SELECT id, to_char(line_date, 'YYYY-MM-DD') AS d, amount_minor FROM bank_statement_line WHERE id = $1 AND org_id = $2`, [lineId, orgId]);
  if (!l) throw new BankReconError(404, 'No such line.');
  const used = new Set((await many<{ k: string }>(`SELECT matched_kind || ':' || matched_ref AS k FROM bank_statement_line WHERE org_id = $1 AND matched_kind IS NOT NULL AND matched_kind <> 'ignored'`, [orgId])).map((r) => r.k));
  const amount = Number(l.amount_minor);
  return (await candidates(orgId, platformAdmin, l.d, l.d))
    .filter((c) => !used.has(`${c.kind}:${c.ref}`) && Math.sign(c.amount) === Math.sign(amount))
    .sort((a, b) => Math.abs(a.amount - amount) - Math.abs(b.amount - amount) || dayDiff(a.date, l.d) - dayDiff(b.date, l.d))
    .slice(0, 20);
}

/** Match a line by hand (to a candidate of the same direction), mark it ignored (with a note), or undo its match. */
export async function setMatch(orgId: string, platformAdmin: boolean, lineId: string, b: { kind?: unknown; ref?: unknown; note?: unknown }, userId: string | null) {
  if (!/^\d{1,18}$/.test(lineId)) throw new BankReconError(404, 'No such line.');
  const l = await one<any>(`SELECT * FROM bank_statement_line WHERE id = $1 AND org_id = $2`, [lineId, orgId]);
  if (!l) throw new BankReconError(404, 'No such line.');
  const kind = String(b.kind ?? '');
  const note = b.note == null ? null : String(b.note).trim().slice(0, 300) || null;
  if (kind === 'none') {
    await query(`UPDATE bank_statement_line SET matched_kind = NULL, matched_ref = NULL, matched_auto = false, matched_by = $3, matched_at = now(), note = $4 WHERE id = $1 AND org_id = $2`, [lineId, orgId, userId, note]);
    return { ok: true };
  }
  if (kind === 'ignored') {
    if (!note) throw new BankReconError(422, 'Say what the line is (e.g. bank fee, another business).');
    await query(`UPDATE bank_statement_line SET matched_kind = 'ignored', matched_ref = NULL, matched_auto = false, matched_by = $3, matched_at = now(), note = $4 WHERE id = $1 AND org_id = $2`, [lineId, orgId, userId, note]);
    return { ok: true };
  }
  if (!['gateway_withdrawal', 'statement_payment', 'refund'].includes(kind)) throw new BankReconError(422, 'kind is gateway_withdrawal, statement_payment, refund, ignored or none.');
  const ref = String(b.ref ?? '');
  const c = (await lineCandidates(orgId, platformAdmin, lineId)).find((x) => x.kind === kind && x.ref === ref);
  if (!c) throw new BankReconError(422, 'That record is not a candidate for this line (another direction, already matched, or not this organisation\'s).');
  try {
    await query(`UPDATE bank_statement_line SET matched_kind = $3, matched_ref = $4, matched_auto = false, matched_by = $5, matched_at = now(), note = $6 WHERE id = $1 AND org_id = $2`,
      [lineId, orgId, kind, ref, userId, note]);
  } catch (e) {
    if ((e as any).code === '23505') throw new BankReconError(409, 'That record is already matched to another line.');
    throw e;
  }
  return { ok: true, amountDiffers: c.amount !== Number(l.amount_minor) };
}
