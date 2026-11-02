import { createHash, createHmac, randomBytes } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { guardedFetch, refuseOutboundUrl } from './net-guard.js';
import { seal, unseal } from './secrets.js';
import { persistAlert } from './alerts.js';

/**
 * Card payment terminals (v1.47.0), Commercial → Card terminals. A card reader on the charger, or a kiosk for the
 * site, takes ad-hoc card payments: the driver taps a card, the terminal pre-authorises an amount, the charger starts,
 * and at the end the session's total is captured (never more than the pre-authorisation) and the rest released.
 *
 *   terminal     posts to its own address, POST /v1/terminals/events/{key}, JSON {type, …}:
 *                  preauth   {reference, amountMinor, cardBrand, cardLast4, connectorId (and, for a kiosk, chargePointId
 *                            or ocppIdentity)}: PlugSure starts the connector with a single-use guest card, limited to
 *                            the amount (the connector's tariff turns it into an energy limit, enforced by a remote
 *                            stop), and answers {accepted, txnId, receiptUrl}; not accepted: the terminal voids at once
 *                  cancel    {reference}: the driver gave up before the car charged
 *                  poll      {}: the instructions waiting for it, [{reference, action: capture | void, amountMinor}]
 *                  captured / voided / failed {reference, amountMinor?, error?}: the terminal did it (or could not)
 *   callback     with a callback address, PlugSure POSTs each instruction there instead (signed: X-PlugSure-Signature,
 *                t=…,v1=HMAC-SHA256(secret, "t.body")); a 2xx answer means done
 *   settling     every minute: the session found for each pre-authorisation; a car that never charged in 10 minutes is
 *                voided; at the end the session's charge record decides the amount (capped at the pre-authorisation;
 *                no energy: void); the guest card is retired
 *   receipt      each payment has a receipt page, /terminal-receipt/{token} (the terminal can show it as a QR code)
 *   settlement   the provider's settlement report (CSV: reference, amount, date) is matched to the captures: matched,
 *                amount differs, or unknown; captures the provider has not settled after 3 days are listed
 */

export class TerminalError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const TERMINAL_ALERT = 'payment.terminal_failed';
const S = <T>(fn: () => T) => outsideRequestScope(fn);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const AAD = 'payment-terminal';
const NO_CAR_MIN = 10;
const MAX_ATTEMPTS = 10;

const termOf = (t: any) => ({
  id: String(t.id), siteId: t.site_id, site: t.site_name ?? null, chargePointId: t.charge_point_id ?? null, charger: t.cp_name ?? null, name: t.name, serial: t.serial ?? null,
  provider: t.provider, keyPrefix: t.key_prefix ?? null, callbackUrl: t.callback_url ?? null, hasCallbackSecret: !!t.callback_secret_sealed,
  maxPreauthMinor: Number(t.max_preauth_minor), currency: t.currency, enabled: t.enabled, lastSeenAt: t.last_seen_at ? new Date(t.last_seen_at).toISOString() : null,
});
const TERM_SELECT = `SELECT t.*, s.name AS site_name, COALESCE(cp.display_name, cp.ocpp_identity) AS cp_name FROM payment_terminal t JOIN site s ON s.id = t.site_id LEFT JOIN charge_point cp ON cp.id = t.charge_point_id`;

export async function terminals(orgId: string) {
  return (await S(() => many<any>(`${TERM_SELECT} WHERE t.org_id = $1 AND t.archived_at IS NULL ORDER BY s.name, t.name`, [orgId]))).map(termOf);
}

export async function saveTerminal(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await S(() => one<any>(`SELECT * FROM payment_terminal WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [Number(id) || 0, orgId])) : null;
  if (id && !cur) throw new TerminalError(404, 'No such terminal.');
  if (cur && b.archive === true) {
    await S(() => query(`UPDATE payment_terminal SET archived_at = now(), enabled = false, key_hash = NULL WHERE id = $1`, [cur.id]));
    return { id: String(cur.id), archived: true };
  }
  const v = (k: string, col: string) => (b[k] !== undefined ? b[k] : cur?.[col]);
  const name = String(v('name', 'name') ?? '').trim().slice(0, 80);
  if (!name) throw new TerminalError(422, 'name is required.');
  const siteId = String(v('siteId', 'site_id') ?? '');
  const site = UUID_RE.test(siteId) ? await S(() => one<any>(`SELECT s.id, co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.id = $1 AND s.org_id = $2 AND s.archived_at IS NULL`, [siteId, orgId])) : null;
  if (!site) throw new TerminalError(422, 'No such site.');
  const cpRaw = v('chargePointId', 'charge_point_id');
  const cpId = cpRaw ? String(cpRaw) : null;
  if (cpId && !(UUID_RE.test(cpId) && await S(() => one(`SELECT 1 FROM charge_point WHERE id = $1 AND site_id = $2`, [cpId, siteId])))) throw new TerminalError(422, 'The charger must be at the terminal\'s site.');
  const max = Number(v('maxPreauthMinor', 'max_preauth_minor'));
  if (!(Number.isSafeInteger(max) && max > 0)) throw new TerminalError(422, 'maxPreauthMinor is the largest amount the terminal may pre-authorise (minor units).');
  let cb: string | null = v('callbackUrl', 'callback_url') ? String(v('callbackUrl', 'callback_url')).trim() : null;
  if (cb) {
    let u: URL;
    try { u = new URL(cb); } catch { throw new TerminalError(422, 'callbackUrl is not a URL.'); }
    const why = refuseOutboundUrl(u);
    if (why) throw new TerminalError(422, `callbackUrl: ${why}.`);
    cb = u.toString();
  }
  const secret = b.callbackSecret !== undefined ? (b.callbackSecret ? seal(String(b.callbackSecret).slice(0, 500), AAD) : null) : cur?.callback_secret_sealed ?? null;
  const vals = [orgId, siteId, cpId, name, v('serial', 'serial') ? String(v('serial', 'serial')).slice(0, 80) : null, String(v('provider', 'provider') ?? 'generic').slice(0, 40),
    cb, secret, max, site.currency, b.enabled === undefined ? cur?.enabled ?? true : b.enabled === true];
  const r = cur
    ? await S(() => one<any>(`UPDATE payment_terminal SET site_id = $2, charge_point_id = $3, name = $4, serial = $5, provider = $6, callback_url = $7, callback_secret_sealed = $8,
        max_preauth_minor = $9, currency = $10, enabled = $11 WHERE id = $12 AND org_id = $1 RETURNING *`, [...vals, cur.id]))
    : await S(() => one<any>(`INSERT INTO payment_terminal (org_id, site_id, charge_point_id, name, serial, provider, callback_url, callback_secret_sealed, max_preauth_minor, currency, enabled)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, vals));
  let key: string | null = null;
  if (!r.key_hash || b.rotateKey === true) {
    key = `trm_${randomBytes(24).toString('base64url')}`;
    await S(() => query(`UPDATE payment_terminal SET key_hash = $2, key_prefix = $3 WHERE id = $1`, [r.id, sha(key!), key!.slice(0, 8)]));
  }
  const full = await S(() => one<any>(`${TERM_SELECT} WHERE t.id = $1`, [r.id]));
  return { ...termOf(full), ...(key ? { key } : {}) };
}

// ------------------------------------------------------------------ the terminal's webhook

async function terminalByKey(key: string) {
  if (!/^trm_[A-Za-z0-9_-]{20,64}$/.test(key)) throw new TerminalError(404, 'Unknown key.');
  const t = await S(() => one<any>(`SELECT * FROM payment_terminal WHERE key_hash = $1 AND archived_at IS NULL`, [sha(key)]));
  if (!t) throw new TerminalError(404, 'Unknown key.');
  if (!t.enabled) throw new TerminalError(409, 'The terminal is switched off.');
  await S(() => query(`UPDATE payment_terminal SET last_seen_at = now() WHERE id = $1`, [t.id]));
  return t;
}

const txnOf = (x: any) => ({
  id: String(x.id), terminalId: String(x.terminal_id), terminal: x.terminal_name ?? null, site: x.site_name ?? null, reference: x.reference, sessionId: x.session_id ?? null,
  card: x.card_last4 ? `${x.card_brand ?? 'Card'} ··${x.card_last4}` : null, preauthMinor: Number(x.preauth_minor), amountMinor: x.amount_minor == null ? null : Number(x.amount_minor),
  currency: x.currency, status: x.status, startStatus: x.start_status ?? null, lastError: x.last_error ?? null, kwh: x.energy_wh == null ? null : Number(x.energy_wh) / 1000,
  settledMinor: x.settled_minor == null ? null : Number(x.settled_minor), settledOn: x.settled_on_s ?? null,
  createdAt: new Date(x.created_at).toISOString(), updatedAt: new Date(x.updated_at).toISOString(),
});

export async function ingest(key: string, payload: unknown, origin: string | null = null) {
  const t = await terminalByKey(key);
  const b = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const type = String(b.type ?? '');
  if (type === 'preauth') return preauth(t, b, origin);
  if (type === 'poll') return { instructions: await instructions(t) };
  const ref = String(b.reference ?? '').trim();
  if (!ref) throw new TerminalError(422, 'reference is required.');
  const x = await S(() => one<any>(`SELECT * FROM terminal_txn WHERE terminal_id = $1 AND reference = $2`, [t.id, ref]));
  if (!x) throw new TerminalError(404, 'Unknown reference.');
  if (type === 'cancel') {
    if (x.status !== 'preauth' || x.session_id) throw new TerminalError(409, 'The car is already charging: stop it at the charger.');
    await retireToken(x.token_id);
    await S(() => query(`UPDATE terminal_txn SET status = 'void_due', amount_minor = 0, updated_at = now() WHERE id = $1`, [x.id]));
    return { reference: ref, status: 'void_due' };
  }
  if (type === 'captured' || type === 'voided') {
    const want = type === 'captured' ? 'capture_due' : 'void_due';
    if (x.status === (type === 'captured' ? 'captured' : 'voided')) return { reference: ref, status: x.status };
    if (x.status !== want) throw new TerminalError(409, `The payment is ${x.status}.`);
    const amt = type === 'captured' && b.amountMinor != null ? Math.round(Number(b.amountMinor)) : x.amount_minor;
    await S(() => query(`UPDATE terminal_txn SET status = $2, amount_minor = $3, last_error = NULL, updated_at = now() WHERE id = $1`, [x.id, type, amt]));
    return { reference: ref, status: type };
  }
  if (type === 'failed') {
    await S(() => query(`UPDATE terminal_txn SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1 AND status IN ('capture_due', 'void_due')`, [x.id, String(b.error ?? 'failed at the terminal').slice(0, 300)]));
    await alertFailed(x, String(b.error ?? 'failed at the terminal'));
    return { reference: ref, status: 'failed' };
  }
  throw new TerminalError(422, 'type is preauth, cancel, poll, captured, voided or failed.');
}

async function preauth(t: any, b: Record<string, unknown>, origin: string | null) {
  const ref = String(b.reference ?? '').trim().slice(0, 80);
  if (!ref) throw new TerminalError(422, 'reference is the terminal\'s transaction reference.');
  const again = await S(() => one<any>(`SELECT * FROM terminal_txn WHERE terminal_id = $1 AND reference = $2`, [t.id, ref]));
  if (again) return { accepted: !['void_due', 'voided', 'failed'].includes(again.status), txnId: String(again.id), status: again.status, duplicate: true };
  const amount = Math.round(Number(b.amountMinor));
  if (!(Number.isSafeInteger(amount) && amount > 0)) throw new TerminalError(422, 'amountMinor is the pre-authorised amount.');
  if (amount > Number(t.max_preauth_minor)) throw new TerminalError(422, `At most ${Number(t.max_preauth_minor)} may be pre-authorised at this terminal.`);
  if (b.currency && String(b.currency).toUpperCase() !== t.currency) throw new TerminalError(422, `The terminal takes ${t.currency}.`);
  // The connector: on the terminal's charger, or (a kiosk) on the charger named.
  let cpId: string | null = t.charge_point_id;
  if (!cpId) {
    const want = String(b.chargePointId ?? b.ocppIdentity ?? '');
    const cp = want ? await S(() => one<any>(`SELECT id FROM charge_point WHERE site_id = $1 AND (id::text = $2 OR ocpp_identity = $2)`, [t.site_id, want])) : null;
    if (!cp) throw new TerminalError(422, 'chargePointId (or ocppIdentity): a charger at the kiosk\'s site.');
    cpId = cp.id;
  }
  const connNo = Math.round(Number(b.connectorId ?? 1));
  const c = await S(() => one<any>(
    `SELECT c.id, c.status, cp.ocpp_identity FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id
      WHERE cp.id = $1 AND e.evse_id = $2 ORDER BY c.connector_id LIMIT 1`, [cpId, connNo]));
  const brand = b.cardBrand ? String(b.cardBrand).slice(0, 20) : null;
  const last4 = b.cardLast4 && /^\d{4}$/.test(String(b.cardLast4)) ? String(b.cardLast4) : null;
  const receipt = `trr_${randomBytes(18).toString('base64url')}`;
  const receiptUrl = `${origin ?? ''}/terminal-receipt/${receipt}`;
  const record = async (status: string, startStatus: string | null, tokenId: string | null) => (await S(() => one<any>(
    `INSERT INTO terminal_txn (org_id, terminal_id, reference, connector_uuid, token_id, card_brand, card_last4, preauth_minor, currency, status, start_status, receipt_token_hash, amount_minor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [t.org_id, t.id, ref, c?.id ?? null, tokenId, brand, last4, amount, t.currency, status, startStatus, sha(receipt), status === 'void_due' ? 0 : null])))!.id;
  if (!c) { const id = await record('void_due', 'no such connector', null); return { accepted: false, txnId: String(id), status: 'void_due', reason: 'No such connector.' }; }
  if (!['Available', 'Preparing'].includes(String(c.status))) {
    const id = await record('void_due', `connector ${c.status ?? 'unknown'}`, null);
    return { accepted: false, txnId: String(id), status: 'void_due', reason: `The connector is ${String(c.status ?? 'not available').toLowerCase()}.` };
  }
  // A single-use guest card for this payment, limited to the amount.
  const uid = `TRM-${randomBytes(6).toString('hex').toUpperCase()}`;
  const tok = await S(() => one<{ id: string }>(
    `INSERT INTO token (org_id, kind, uid, status, offline_allowed, valid_to) VALUES ($1, 'guest', $2, 'Accepted', false, now() + make_interval(mins => $3)) RETURNING id`,
    [t.org_id, uid, NO_CAR_MIN]));
  const limits = await import('./operator-limits.js');
  const lim = await limits.recordRemoteStartRequest({ orgId: t.org_id, chargePointId: cpId!, connectorNo: connNo, connectorUuid: c.id, idTag: uid, limitType: 'amount', limitValue: amount, requestedBy: `terminal:${t.id}` });
  if (lim.error) {
    await retireToken(tok!.id);
    const id = await record('void_due', lim.error.slice(0, 120), null);
    return { accepted: false, txnId: String(id), status: 'void_due', reason: lim.error };
  }
  let started = 'Unreachable';
  const commands = await import('../ocpp/commands.js');
  if (commands.reachable(c.ocpp_identity)) {
    try { started = (await commands.remoteStartTransaction(c.ocpp_identity, connNo, uid, { type: 'system', orgId: t.org_id }))?.status ?? 'Rejected'; } catch (e) { started = `Failed: ${(e as Error).message}`.slice(0, 80); }
  }
  if (started !== 'Accepted') {
    await retireToken(tok!.id);
    const id = await record('void_due', started, null);
    return { accepted: false, txnId: String(id), status: 'void_due', reason: 'The charger did not start.' };
  }
  const id = await record('preauth', started, tok!.id);
  return { accepted: true, txnId: String(id), status: 'preauth', receiptUrl, energyLimitKwh: lim.energyLimitWh == null ? null : lim.energyLimitWh / 1000 };
}

async function retireToken(tokenId: string | null) {
  if (tokenId) await S(() => query(`UPDATE token SET status = 'Expired', valid_to = LEAST(COALESCE(valid_to, now()), now()) WHERE id = $1 AND kind = 'guest'`, [tokenId]));
}

async function instructions(t: any) {
  return (await S(() => many<any>(`SELECT reference, status, amount_minor FROM terminal_txn WHERE terminal_id = $1 AND status IN ('capture_due', 'void_due') ORDER BY id LIMIT 100`, [t.id])))
    .map((x) => ({ reference: x.reference, action: x.status === 'capture_due' ? 'capture' : 'void', amountMinor: x.status === 'capture_due' ? Number(x.amount_minor) : 0 }));
}

async function alertFailed(x: any, why: string) {
  await S(() => persistAlert({ orgId: x.org_id, kind: TERMINAL_ALERT, severity: 'warning', targetType: 'terminal_txn', targetId: String(x.id),
    message: `Card terminal payment ${x.reference}: ${why}`.slice(0, 300) } as any)).catch(() => null);
}

/** The amount to capture: the charge record's total, never above the pre-authorisation; nothing without energy. Pure. */
export function captureAmount(preauthMinor: number, cdrTotalMinor: number | null, energyWh: number): { action: 'capture' | 'void'; amountMinor: number } {
  if (!(energyWh > 0) || !cdrTotalMinor || cdrTotalMinor <= 0) return { action: 'void', amountMinor: 0 };
  return { action: 'capture', amountMinor: Math.min(preauthMinor, Math.round(cdrTotalMinor)) };
}

/** Worker (every minute): sessions found, cars that never came voided, finished sessions captured, instructions sent. */
export async function settle(now = new Date()): Promise<{ linked: number; decided: number; sent: number }> {
  let linked = 0, decided = 0, sent = 0;
  // 1. The session each pre-authorisation started.
  const pre = await S(() => many<any>(`SELECT * FROM terminal_txn WHERE status = 'preauth'`));
  for (const x of pre) {
    const s = await S(() => one<any>(`SELECT id FROM charging_session WHERE token_id = $1 ORDER BY started_at LIMIT 1`, [x.token_id]));
    if (s) { await S(() => query(`UPDATE terminal_txn SET status = 'charging', session_id = $2, updated_at = now() WHERE id = $1`, [x.id, s.id])); linked++; continue; }
    if (now.getTime() - new Date(x.created_at).getTime() > NO_CAR_MIN * 60_000) {
      await retireToken(x.token_id);
      await S(() => query(`UPDATE terminal_txn SET status = 'void_due', amount_minor = 0, last_error = 'no car charged', updated_at = now() WHERE id = $1`, [x.id]));
      decided++;
    }
  }
  // 2. Finished sessions: the charge record decides (wait up to 15 minutes for it after the end).
  const ch = await S(() => many<any>(
    `SELECT x.*, cs.state, cs.ended_at, COALESCE(cs.energy_wh, 0) AS energy_wh, d.total_minor FROM terminal_txn x JOIN charging_session cs ON cs.id = x.session_id
       LEFT JOIN cdr d ON d.session_id = cs.id WHERE x.status = 'charging' AND cs.state <> 'active'`));
  for (const x of ch) {
    if (x.total_minor == null && Number(x.energy_wh) > 0 && x.ended_at && now.getTime() - new Date(x.ended_at).getTime() < 15 * 60_000) continue;
    const a = captureAmount(Number(x.preauth_minor), x.total_minor == null ? null : Number(x.total_minor), Number(x.energy_wh));
    await retireToken(x.token_id);
    await S(() => query(`UPDATE terminal_txn SET status = $2, amount_minor = $3, updated_at = now() WHERE id = $1 AND status = 'charging'`,
      [x.id, a.action === 'capture' ? 'capture_due' : 'void_due', a.amountMinor]));
    decided++;
  }
  // 3. Terminals with a callback address: send what is due.
  const due = await S(() => many<any>(
    `SELECT x.*, t.callback_url, t.callback_secret_sealed FROM terminal_txn x JOIN payment_terminal t ON t.id = x.terminal_id
      WHERE x.status IN ('capture_due', 'void_due') AND t.callback_url IS NOT NULL AND x.attempts < $1
        AND (x.attempts = 0 OR x.updated_at < now() - make_interval(secs => LEAST(3600, 30 * power(2, x.attempts))))`, [MAX_ATTEMPTS]));
  for (const x of due) { if (await sendInstruction(x)) sent++; }
  return { linked, decided, sent };
}

/** POST one instruction to the terminal's callback (signed). True when it was done. */
async function sendInstruction(x: any): Promise<boolean> {
  const capture = x.status === 'capture_due';
  const body = JSON.stringify({ reference: x.reference, action: capture ? 'capture' : 'void', amountMinor: capture ? Number(x.amount_minor) : 0, currency: x.currency });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (x.callback_secret_sealed) {
    try {
      const secret = unseal(x.callback_secret_sealed, AAD);
      const ts = Math.floor(Date.now() / 1000);
      headers['x-plugsure-signature'] = `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
    } catch { /* sent unsigned */ }
  }
  let err: string | null = null;
  try {
    const r = await guardedFetch(x.callback_url, { method: 'POST', headers, body, timeoutMs: 10_000, maxBytes: 16 * 1024 });
    if (r.status >= 200 && r.status < 300) {
      await S(() => query(`UPDATE terminal_txn SET status = $2, attempts = attempts + 1, last_error = NULL, updated_at = now() WHERE id = $1`, [x.id, capture ? 'captured' : 'voided']));
      return true;
    }
    err = `HTTP ${r.status}`;
  } catch (e) { err = (e as Error).message.slice(0, 200); }
  const n = Number(x.attempts) + 1;
  if (n >= MAX_ATTEMPTS) {
    await S(() => query(`UPDATE terminal_txn SET status = 'failed', attempts = $2, last_error = $3, updated_at = now() WHERE id = $1`, [x.id, n, err]));
    await alertFailed(x, `the terminal did not accept the ${capture ? 'capture' : 'void'} (${err})`);
    logger.warn({ txn: x.id, err }, 'terminal instruction failed for good');
  } else {
    await S(() => query(`UPDATE terminal_txn SET attempts = $2, last_error = $3, updated_at = now() WHERE id = $1`, [x.id, n, err]));
  }
  return false;
}

/** Try a due instruction again now (console), or mark a failed one to be sent again. */
export async function retry(orgId: string, id: string) {
  const x = await S(() => one<any>(`SELECT * FROM terminal_txn WHERE id = $1 AND org_id = $2`, [Number(id) || 0, orgId]));
  if (!x) throw new TerminalError(404, 'No such payment.');
  if (x.status !== 'failed') throw new TerminalError(409, 'Only a failed payment can be sent again.');
  await S(() => query(`UPDATE terminal_txn SET status = CASE WHEN COALESCE(amount_minor, 0) > 0 THEN 'capture_due' ELSE 'void_due' END, attempts = 0, updated_at = now() WHERE id = $1`, [x.id]));
  return txn(orgId, id);
}

const TXN_SELECT = `SELECT x.*, to_char(x.settled_on, 'YYYY-MM-DD') AS settled_on_s, t.name AS terminal_name, s.name AS site_name, cs.energy_wh
  FROM terminal_txn x JOIN payment_terminal t ON t.id = x.terminal_id JOIN site s ON s.id = t.site_id LEFT JOIN charging_session cs ON cs.id = x.session_id`;

export async function txns(orgId: string, q: Record<string, unknown> = {}) {
  const st = String(q.status ?? '');
  return (await S(() => many<any>(
    `${TXN_SELECT} WHERE x.org_id = $1 AND ($2 = '' OR x.status = $2) AND ($3::bigint IS NULL OR x.terminal_id = $3) ORDER BY x.created_at DESC LIMIT 500`,
    [orgId, ['preauth', 'charging', 'capture_due', 'void_due', 'captured', 'voided', 'failed'].includes(st) ? st : '', q.terminalId ? Number(q.terminalId) || 0 : null]))).map(txnOf);
}

export async function txn(orgId: string, id: string) {
  const x = await S(() => one<any>(`${TXN_SELECT} WHERE x.id = $1 AND x.org_id = $2`, [Number(id) || 0, orgId]));
  if (!x) throw new TerminalError(404, 'No such payment.');
  return txnOf(x);
}

/** Per day (the last 30): pre-authorised, captured, voided, failed. */
export async function summary(orgId: string) {
  const rows = await S(() => many<any>(
    `SELECT to_char(created_at, 'YYYY-MM-DD') AS d, currency, count(*) AS n, sum(preauth_minor) AS pre,
            sum(CASE WHEN status = 'captured' THEN amount_minor ELSE 0 END) AS cap, count(*) FILTER (WHERE status = 'captured') AS n_cap,
            count(*) FILTER (WHERE status = 'voided') AS n_void, count(*) FILTER (WHERE status = 'failed') AS n_fail,
            count(*) FILTER (WHERE status IN ('preauth', 'charging', 'capture_due', 'void_due')) AS n_open
       FROM terminal_txn WHERE org_id = $1 AND created_at > now() - interval '30 days' GROUP BY 1, 2 ORDER BY 1 DESC`, [orgId]));
  return rows.map((r) => ({ day: r.d, currency: r.currency, payments: Number(r.n), preauthMinor: Number(r.pre), capturedMinor: Number(r.cap), captured: Number(r.n_cap), voided: Number(r.n_void), failed: Number(r.n_fail), open: Number(r.n_open) }));
}

// ------------------------------------------------------------------ the receipt

export async function receipt(token: string) {
  if (!/^trr_[A-Za-z0-9_-]{20,64}$/.test(token)) throw new TerminalError(404, 'No such receipt.');
  const x = await S(() => one<any>(
    `SELECT x.*, t.name AS terminal_name, s.name AS site_name, s.address, o.name AS operator, COALESCE(cp.display_name, cp.ocpp_identity) AS charger,
            cs.started_at, cs.ended_at, cs.energy_wh FROM terminal_txn x JOIN payment_terminal t ON t.id = x.terminal_id JOIN site s ON s.id = t.site_id
       JOIN organisation o ON o.id = x.org_id LEFT JOIN charging_session cs ON cs.id = x.session_id LEFT JOIN charge_point cp ON cp.id = cs.charge_point_id
      WHERE x.receipt_token_hash = $1`, [sha(token)]));
  if (!x) throw new TerminalError(404, 'No such receipt.');
  return {
    operator: x.operator, site: x.site_name, address: x.address ?? null, charger: x.charger ?? null, card: x.card_last4 ? `${x.card_brand ?? 'Card'} ··${x.card_last4}` : null,
    reference: x.reference, startedAt: x.started_at ? new Date(x.started_at).toISOString() : null, endedAt: x.ended_at ? new Date(x.ended_at).toISOString() : null,
    kwh: x.energy_wh == null ? null : Number(x.energy_wh) / 1000, preauthMinor: Number(x.preauth_minor), amountMinor: x.amount_minor == null ? null : Number(x.amount_minor),
    currency: x.currency, status: ['captured', 'capture_due'].includes(x.status) ? 'paid' : ['voided', 'void_due'].includes(x.status) ? 'released' : x.status === 'failed' ? 'pending' : 'charging',
  };
}

// ------------------------------------------------------------------ settlement

/**
 * The provider's settlement report: CSV lines "reference,amount[,date]" (a header line is skipped; amounts in minor
 * units). Each line is matched to a capture by reference: matched, amount differs, or unknown.
 */
export async function reconcile(orgId: string, b: Record<string, unknown>) {
  const csv = String(b.csv ?? '');
  if (!csv.trim()) throw new TerminalError(422, 'csv: the settlement report (reference,amount[,date] per line).');
  if (csv.length > 2_000_000) throw new TerminalError(413, 'At most 2 MB.');
  const batch = String(b.batch ?? `settlement-${new Date().toISOString().slice(0, 10)}`).slice(0, 80);
  const out = { batch, matched: 0, mismatch: 0, unknown: 0, lines: [] as Array<{ reference: string; amountMinor: number; status: string; capturedMinor: number | null }> };
  for (const raw of csv.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    const amount = Number(cells[1]);
    if (!cells[0] || !Number.isFinite(amount)) continue; // a header or a blank
    const on = cells[2] && /^\d{4}-\d{2}-\d{2}$/.test(cells[2]) ? cells[2] : null;
    const x = await S(() => one<any>(`SELECT id, amount_minor, status FROM terminal_txn WHERE org_id = $1 AND reference = $2 ORDER BY id DESC LIMIT 1`, [orgId, cells[0]]));
    const status = !x ? 'unknown' : Number(x.amount_minor ?? 0) === Math.round(amount) && x.status === 'captured' ? 'matched' : 'mismatch';
    await S(() => query(`INSERT INTO terminal_settlement_line (org_id, batch, reference, amount_minor, settled_on, txn_id, status) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [orgId, batch, cells[0]!.slice(0, 80), Math.round(amount), on, x?.id ?? null, status]));
    if (x) await S(() => query(`UPDATE terminal_txn SET settled_minor = $2, settled_on = COALESCE($3::date, current_date) WHERE id = $1`, [x.id, Math.round(amount), on]));
    out[status as 'matched' | 'mismatch' | 'unknown']++;
    if (out.lines.length < 500) out.lines.push({ reference: cells[0], amountMinor: Math.round(amount), status, capturedMinor: x?.amount_minor == null ? null : Number(x.amount_minor) });
  }
  return out;
}

/** Captures older than 3 days that no settlement report has listed. */
export async function unsettled(orgId: string) {
  return (await S(() => many<any>(`${TXN_SELECT} WHERE x.org_id = $1 AND x.status = 'captured' AND x.settled_minor IS NULL AND x.updated_at < now() - interval '3 days' ORDER BY x.created_at LIMIT 500`, [orgId]))).map(txnOf);
}
