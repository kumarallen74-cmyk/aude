import { createHash } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { LEGACY_CURRENCY } from '../domain/money.js';
import { logger } from '../logger.js';
import { guardedFetch } from './net-guard.js';
import { seal, unseal } from './secrets.js';
import { autoMatch } from './bank-recon.js';
import { chart, createManual, LedgerError } from './general-ledger.js';

/**
 * Bank feeds and match rules (v1.32.0).
 *
 *   feed    a bank account's mutations fetched on a schedule (hourly) from an HTTPS endpoint that answers JSON: a
 *           bank's API behind a small adapter, or an aggregator. GET <url>?from=YYYY-MM-DD with the token as a bearer;
 *           the answer is { transactions: [...] } (or the array itself), each { date, description, amount, reference?,
 *           balance?, type? } with the amount signed (money in above 0) or type CR / DB (D, K accepted). New lines land
 *           on a statement of the feed's cash account, exactly like an uploaded one — the same fingerprint, so a feed
 *           and an upload of the same days do not double up — and are matched (gateway withdrawals, payments,
 *           refunds, supplier payments). The token is sealed; the console never shows it again.
 *   rules   what to do with lines nothing matched, in priority order (the first that fits wins): by direction, a text
 *           the description or reference contains, and an amount range —
 *             ignore    the line is marked ignored, with the rule's note (bank fees, transfers between own accounts)
 *             suggest   a journal entry against an account (Dr bank / Cr the account for money in; the other way for
 *                       money out) is created awaiting approval in the ledger, and the line is matched to it
 *           Rules run after every feed run and upload, and can be run (or previewed) by hand.
 */

export class FeedError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const aad = (orgId: string) => `bank_feed:${orgId}`;
const text = (v: unknown, max: number) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

// ─────────────────────────────────────────── feeds

const feedView = (r: any) => ({
  id: String(r.id), name: r.name, cashAccountId: String(r.cash_account_id), cashAccount: r.account_name ?? null, currency: r.currency ?? null,
  url: r.url, hasToken: !!r.token_sealed, enabled: r.enabled, since: r.since_s ?? null,
  lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null, lastStatus: r.last_status ?? null, lastError: r.last_error ?? null, linesImported: Number(r.lines_imported),
});
const FEED_SELECT = `SELECT f.*, to_char(f.since, 'YYYY-MM-DD') AS since_s, a.name AS account_name, a.currency, a.kind AS account_kind FROM bank_feed f JOIN cash_account a ON a.id = f.cash_account_id`;

export async function feeds(orgId: string) {
  return (await outsideRequestScope(() => many<any>(`${FEED_SELECT} WHERE f.org_id = $1 ORDER BY lower(f.name), f.id`, [orgId]))).map(feedView);
}

async function feedRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new FeedError(404, 'No such feed.');
  const r = await outsideRequestScope(() => one<any>(`${FEED_SELECT} WHERE f.id = $1 AND f.org_id = $2`, [id, orgId]));
  if (!r) throw new FeedError(404, 'No such feed.');
  return r;
}

/** Create (no id) or change a feed. The token is replaced only when one is given ('' keeps it; null clears it). */
export async function saveFeed(orgId: string, id: string | null, b: Record<string, unknown>, userId: string | null) {
  const cur = id ? await feedRow(orgId, id) : null;
  const name = b.name === undefined && cur ? cur.name : String(b.name ?? '').trim();
  if (name.length < 2 || name.length > 80) throw new FeedError(422, 'name is 2 to 80 characters.');
  const accountId = b.cashAccountId === undefined && cur ? String(cur.cash_account_id) : String(b.cashAccountId ?? '');
  if (!/^\d{1,18}$/.test(accountId)) throw new FeedError(422, 'cashAccountId is the bank account the feed is of.');
  const acct = await outsideRequestScope(() => one<any>(`SELECT id, kind, archived_at FROM cash_account WHERE id = $1 AND org_id = $2`, [accountId, orgId]));
  if (!acct) throw new FeedError(422, 'No such cash account.');
  if (acct.kind !== 'bank') throw new FeedError(422, 'A feed is of a bank account (not petty cash).');
  const url = b.url === undefined && cur ? cur.url : String(b.url ?? '').trim();
  let u: URL;
  try { u = new URL(url); } catch { throw new FeedError(422, 'url is the endpoint\'s address (https://…).'); }
  if (u.protocol !== 'https:' && config.env === 'production') throw new FeedError(422, 'url must be https.');
  if (u.username || u.password) throw new FeedError(422, 'Put the credentials in the token, not the URL.');
  let tokenSealed: string | null = cur?.token_sealed ?? null;
  if (b.token === null) tokenSealed = null;
  else if (b.token !== undefined && String(b.token) !== '') {
    const t = String(b.token);
    if (t.length > 4000) throw new FeedError(422, 'The token is too long.');
    tokenSealed = seal(t, aad(orgId));
  }
  const enabled = b.enabled === undefined ? (cur ? cur.enabled : true) : b.enabled === true || b.enabled === 'true';
  const since = b.since === undefined ? (cur?.since_s ?? null) : b.since == null || b.since === '' ? null : String(b.since);
  if (since && !DATE_RE.test(since)) throw new FeedError(422, 'since is YYYY-MM-DD (the first day to fetch).');
  const r = cur
    ? await outsideRequestScope(() => one<any>(`UPDATE bank_feed SET name = $3, cash_account_id = $4, url = $5, token_sealed = $6, enabled = $7, since = $8 WHERE id = $1 AND org_id = $2 RETURNING id`,
      [cur.id, orgId, name, accountId, url, tokenSealed, enabled, since]))
    : await outsideRequestScope(() => one<any>(`INSERT INTO bank_feed (org_id, cash_account_id, name, url, token_sealed, enabled, since, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [orgId, accountId, name, url, tokenSealed, enabled, since, userId]));
  return feedView(await feedRow(orgId, String(r.id)));
}

export interface FeedLine { date: string; description: string; reference: string | null; amount: number; balance: number | null }

/** Read an endpoint's answer into lines; what cannot be read is counted as skipped. */
export function parseFeed(body: string): { lines: FeedLine[]; skipped: number } {
  let j: any;
  try { j = JSON.parse(body); } catch { throw new FeedError(502, 'The endpoint did not answer JSON.'); }
  const list: any[] = Array.isArray(j) ? j : Array.isArray(j?.transactions) ? j.transactions : Array.isArray(j?.data) ? j.data : null as any;
  if (!list) throw new FeedError(502, 'The answer has no transactions list.');
  const lines: FeedLine[] = [];
  let skipped = 0;
  for (const t of list.slice(0, 20_000)) {
    const date = String(t?.date ?? t?.transactionDate ?? '').slice(0, 10);
    const raw = Number(typeof t?.amount === 'string' ? t.amount.replace(/,/g, '') : t?.amount);
    const description = String(t?.description ?? t?.remark ?? '').trim().slice(0, 300);
    if (!DATE_RE.test(date) || !Number.isFinite(raw) || raw === 0 || !description) { skipped++; continue; }
    const type = String(t?.type ?? '').toUpperCase();
    const amount = Math.round(['DB', 'D', 'DEBIT'].includes(type) ? -Math.abs(raw) : ['CR', 'K', 'C', 'CREDIT'].includes(type) ? Math.abs(raw) : raw);
    const bal = t?.balance == null || t.balance === '' ? null : Number(t.balance);
    lines.push({ date, description, reference: t?.reference == null || t.reference === '' ? null : String(t.reference).slice(0, 120), amount, balance: bal != null && Number.isFinite(bal) ? Math.round(bal) : null });
  }
  return { lines: lines.sort((a, b) => a.date.localeCompare(b.date)), skipped };
}

/** Store new lines on a statement of the account (the same fingerprints as an upload). */
async function ingest(orgId: string, feed: any, lines: FeedLine[]) {
  const seen = new Map<string, number>();
  const rows = lines.map((l) => {
    const base = `${l.date}|${l.amount}|${l.description}|${l.reference ?? ''}`;
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    return { ...l, fp: createHash('sha256').update(`${base}|${k}`).digest('hex').slice(0, 40) };
  });
  if (!rows.length) return { statementId: null as string | null, added: 0, duplicates: 0 };
  const have = new Set((await outsideRequestScope(() => many<{ fingerprint: string }>(`SELECT fingerprint FROM bank_statement_line WHERE org_id = $1 AND fingerprint = ANY($2::text[])`, [orgId, rows.map((r) => r.fp)]))).map((r) => r.fingerprint));
  const fresh = rows.filter((r) => !have.has(r.fp));
  if (!fresh.length) return { statementId: null, added: 0, duplicates: rows.length };
  const st = (await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO bank_statement (org_id, bank, filename, date_from, date_to, cash_account_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [orgId, feed.name.slice(0, 60), `feed: ${feed.name}`.slice(0, 120), fresh[0]!.date, fresh[fresh.length - 1]!.date, feed.cash_account_id])))!.id;
  let added = 0;
  for (const [i, l] of fresh.entries()) {
    const r = await outsideRequestScope(() => one(
      `INSERT INTO bank_statement_line (statement_id, org_id, line_no, line_date, description, reference, amount_minor, balance_minor, fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (org_id, fingerprint) DO NOTHING RETURNING id`,
      [st, orgId, i + 1, l.date, l.description, l.reference, l.amount, l.balance, l.fp]));
    if (r) added++;
  }
  await outsideRequestScope(() => query(`UPDATE bank_statement SET line_count = $2 WHERE id = $1`, [st, added]));
  return { statementId: String(st), added, duplicates: rows.length - added };
}

/** Fetch a feed now: new lines, then matching and the rules. */
export async function run(orgId: string, id: string, now = new Date()) {
  const f = await feedRow(orgId, id);
  const last = await outsideRequestScope(() => one<{ d: string | null }>(
    `SELECT to_char(max(l.line_date), 'YYYY-MM-DD') AS d FROM bank_statement_line l JOIN bank_statement s ON s.id = l.statement_id WHERE s.org_id = $1 AND s.cash_account_id = $2`, [orgId, f.cash_account_id]));
  // From a few days before the last line (banks post late), else the feed's start, else the last 30 days.
  const from = last?.d ? addDays(last.d, -3) : f.since_s ?? addDays(today(now), -30);
  const u = new URL(f.url);
  u.searchParams.set('from', from);
  const headers: Record<string, string> = { accept: 'application/json' };
  try {
    if (f.token_sealed) headers.authorization = `Bearer ${unseal(f.token_sealed, aad(orgId))}`;
    const r = await guardedFetch(u.toString(), { headers, timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 });
    if (r.status < 200 || r.status >= 300) throw new FeedError(502, `The endpoint answered ${r.status}.`);
    const p = parseFeed(r.text);
    const ing = await ingest(orgId, f, p.lines);
    const matched = ing.added ? await autoMatch(orgId, false) : 0;
    const ruled = ing.added ? await applyRules(orgId, null) : { ignored: 0, suggested: 0 };
    await outsideRequestScope(() => query(`UPDATE bank_feed SET last_run_at = now(), last_status = 'ok', last_error = NULL, lines_imported = lines_imported + $2 WHERE id = $1`, [f.id, ing.added]));
    return { feedId: String(f.id), from, fetched: p.lines.length, skipped: p.skipped, added: ing.added, duplicates: ing.duplicates, statementId: ing.statementId, matched, ...ruled };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await outsideRequestScope(() => query(`UPDATE bank_feed SET last_run_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`, [f.id, msg]));
    if (e instanceof FeedError) throw e;
    throw new FeedError(502, `The feed could not be fetched: ${msg}`);
  }
}

/** Hourly: every enabled feed not run in the last 55 minutes. */
export async function sweep(now = new Date()): Promise<number> {
  const due = await outsideRequestScope(() => many<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM bank_feed WHERE enabled AND (last_run_at IS NULL OR last_run_at < $1::timestamptz - interval '55 minutes') ORDER BY last_run_at NULLS FIRST LIMIT 200`, [now.toISOString()]));
  let n = 0;
  for (const f of due) {
    try { await run(f.org_id, String(f.id), now); n++; } catch (e) { logger.warn({ feed: f.id, err: (e as Error).message }, 'bank feed run failed'); }
  }
  return n;
}

// ─────────────────────────────────────────── rules

const ruleView = (r: any) => ({
  id: String(r.id), name: r.name, priority: Number(r.priority), direction: r.direction, contains: r.contains ?? null,
  amountMin: r.amount_min == null ? null : Number(r.amount_min), amountMax: r.amount_max == null ? null : Number(r.amount_max),
  action: r.action, accountCode: r.account_code ?? null, note: r.note ?? null, enabled: r.enabled, matchedCount: Number(r.matched_count),
});

export async function rules(orgId: string) {
  return (await outsideRequestScope(() => many<any>(`SELECT * FROM bank_match_rule WHERE org_id = $1 ORDER BY enabled DESC, priority, id`, [orgId]))).map(ruleView);
}

export async function saveRule(orgId: string, id: string | null, b: Record<string, unknown>, userId: string | null) {
  let cur: any = null;
  if (id) {
    if (!/^\d{1,18}$/.test(id)) throw new FeedError(404, 'No such rule.');
    cur = await outsideRequestScope(() => one<any>(`SELECT * FROM bank_match_rule WHERE id = $1 AND org_id = $2`, [id, orgId]));
    if (!cur) throw new FeedError(404, 'No such rule.');
  }
  const v = (k: string, col: string) => (b[k] === undefined && cur ? cur[col] : b[k]);
  const name = String(v('name', 'name') ?? '').trim();
  if (name.length < 2 || name.length > 80) throw new FeedError(422, 'name is 2 to 80 characters.');
  const priority = v('priority', 'priority') == null || v('priority', 'priority') === '' ? 100 : Number(v('priority', 'priority'));
  if (!Number.isInteger(priority) || priority < 0 || priority > 10_000) throw new FeedError(422, 'priority is 0 to 10000 (lower runs first).');
  const direction = String(v('direction', 'direction') ?? 'any');
  if (!['any', 'credit', 'debit'].includes(direction)) throw new FeedError(422, 'direction is any, credit (money in) or debit (money out).');
  const contains = text(v('contains', 'contains'), 80);
  const num = (x: unknown) => (x == null || x === '' ? null : Number(x));
  const amountMin = num(v('amountMin', 'amount_min')), amountMax = num(v('amountMax', 'amount_max'));
  for (const [k, x] of [['amountMin', amountMin], ['amountMax', amountMax]] as const) if (x != null && (!Number.isInteger(x) || x < 0)) throw new FeedError(422, `${k} is a whole amount, 0 or more (the line's size, either direction).`);
  if (amountMin != null && amountMax != null && amountMin > amountMax) throw new FeedError(422, 'amountMin is not above amountMax.');
  if (!contains && amountMin == null && amountMax == null) throw new FeedError(422, 'A rule needs a text the line contains or an amount range.');
  const action = String(v('action', 'action') ?? '');
  if (!['ignore', 'suggest'].includes(action)) throw new FeedError(422, 'action is ignore or suggest.');
  const accountCode = action === 'suggest' ? text(v('accountCode', 'account_code'), 10) : null;
  if (action === 'suggest') {
    const a = (await chart(orgId)).find((x) => x.code === accountCode);
    if (!a || !a.active) throw new FeedError(422, 'accountCode is an active account in the chart (Finance → Ledger).');
  }
  const note = text(v('note', 'note'), 200);
  if (action === 'ignore' && !note) throw new FeedError(422, 'Say what the lines are (the note is kept on each line).');
  const enabled = b.enabled === undefined ? (cur ? cur.enabled : true) : b.enabled === true || b.enabled === 'true';
  const params = [orgId, name, priority, direction, contains, amountMin, amountMax, action, accountCode, note, enabled];
  const r = cur
    ? await outsideRequestScope(() => one<any>(`UPDATE bank_match_rule SET name = $2, priority = $3, direction = $4, contains = $5, amount_min = $6, amount_max = $7, action = $8, account_code = $9, note = $10, enabled = $11
        WHERE org_id = $1 AND id = $12 RETURNING *`, [...params, cur.id]))
    : await outsideRequestScope(() => one<any>(`INSERT INTO bank_match_rule (org_id, name, priority, direction, contains, amount_min, amount_max, action, account_code, note, enabled, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`, [...params, userId]));
  return ruleView(r);
}

/** Whether a rule fits a line. */
export function fits(rule: { direction: string; contains: string | null; amountMin: number | null; amountMax: number | null }, line: { amount: number; description: string; reference: string | null }) {
  if (rule.direction === 'credit' && line.amount <= 0) return false;
  if (rule.direction === 'debit' && line.amount >= 0) return false;
  const size = Math.abs(line.amount);
  if (rule.amountMin != null && size < rule.amountMin) return false;
  if (rule.amountMax != null && size > rule.amountMax) return false;
  if (rule.contains && !`${line.description} ${line.reference ?? ''}`.toLowerCase().includes(rule.contains.toLowerCase())) return false;
  return true;
}

async function openLines(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT l.id, to_char(l.line_date, 'YYYY-MM-DD') AS d, l.description, l.reference, l.amount_minor, a.currency, a.kind
       FROM bank_statement_line l JOIN bank_statement s ON s.id = l.statement_id LEFT JOIN cash_account a ON a.id = s.cash_account_id
      WHERE l.org_id = $1 AND l.matched_kind IS NULL ORDER BY l.line_date, l.id LIMIT 5000`, [orgId]));
  return rows.map((r) => ({ id: String(r.id), date: r.d as string, description: r.description as string, reference: r.reference as string | null, amount: Number(r.amount_minor), currency: r.currency as string | null, kind: r.kind as string | null }));
}

/** Which open lines each rule would take (nothing is changed). */
export async function preview(orgId: string) {
  const [rs, ls] = await Promise.all([rules(orgId), openLines(orgId)]);
  const live = rs.filter((r) => r.enabled);
  const out: Array<{ lineId: string; date: string; description: string; amount: number; ruleId: string; rule: string; action: string }> = [];
  for (const l of ls) {
    const r = live.find((x) => fits(x, l));
    if (r) out.push({ lineId: l.id, date: l.date, description: l.description, amount: l.amount, ruleId: r.id, rule: r.name, action: r.action });
  }
  return { open: ls.length, lines: out };
}

/** Apply the rules to the open lines. */
export async function applyRules(orgId: string, userId: string | null) {
  const live = (await rules(orgId)).filter((r) => r.enabled);
  if (!live.length) return { ignored: 0, suggested: 0 };
  let ignored = 0, suggested = 0;
  const counts = new Map<string, number>();
  for (const l of await openLines(orgId)) {
    const r = live.find((x) => fits(x, l));
    if (!r) continue;
    if (r.action === 'ignore') {
      const ok = await outsideRequestScope(() => one(`UPDATE bank_statement_line SET matched_kind = 'ignored', matched_auto = true, matched_at = now(), note = $2 WHERE id = $1 AND matched_kind IS NULL RETURNING id`, [l.id, `${r.note} (rule: ${r.name})`.slice(0, 300)]));
      if (ok) { ignored++; counts.set(r.id, (counts.get(r.id) ?? 0) + 1); }
      continue;
    }
    const bank = l.kind === 'cash' ? '1050' : '1100';
    const size = Math.abs(l.amount);
    const lines = l.amount > 0
      ? [{ account: bank, debit: size, description: l.description }, { account: r.accountCode, credit: size, description: l.description }]
      : [{ account: r.accountCode, debit: size, description: l.description }, { account: bank, credit: size, description: l.description }];
    try {
      const e = await createManual(orgId, { date: l.date, currency: l.currency ?? LEGACY_CURRENCY, memo: `Bank line ${l.date}: ${l.description}`.slice(0, 300), lines }, userId);
      const ok = await outsideRequestScope(() => one(`UPDATE bank_statement_line SET matched_kind = 'gl_entry', matched_ref = $2, matched_auto = true, matched_at = now(), note = $3 WHERE id = $1 AND matched_kind IS NULL RETURNING id`,
        [l.id, e.id, `Suggested ${e.number} (rule: ${r.name})`.slice(0, 300)]));
      if (ok) { suggested++; counts.set(r.id, (counts.get(r.id) ?? 0) + 1); }
    } catch (err) {
      // A locked month (or an account deactivated since): the line stays open for a person.
      if (!(err instanceof LedgerError)) throw err;
    }
  }
  for (const [id, n] of counts) await outsideRequestScope(() => query(`UPDATE bank_match_rule SET matched_count = matched_count + $2 WHERE id = $1`, [id, n]));
  return { ignored, suggested };
}
