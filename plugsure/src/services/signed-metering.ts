import { one, many, query } from '../db/pool.js';
import type { CanonicalMeterValue } from '../domain/canonical.js';
import {
  parseOcmf, normaliseMeterKey, verifyOcmf, ocmfText, keyFromOcpp, registerOf, readingWh, readingOk, parseOcmfTime,
  type OcmfReading, type ParsedOcmf,
} from './ocmf.js';

/**
 * Signed meter values (OCMF) for billing.
 *
 * Calibration-law meters sign their readings; the charger passes them on
 * (OCPP 1.6 "SignedData" samples, usually in StopTransaction.transactionData;
 * OCPP 2.0.1 / 2.1 signedMeterValue beside the reading). PlugSure keeps every
 * one as received, checks its signature, and when the session ends compares
 * the energy between the signed start and end readings with what it bills.
 *
 * Whose key. A signature only proves something when it is checked against the
 * meter's own key, taken from its label or type approval and registered on the
 * connector. A key the charger sends with the data is used when nothing is
 * registered, but only proves the data was not changed after it was signed —
 * the session is then "unverified_key", never "verified".
 *
 * Policy per site: off (ignored) · record (default: kept, checked, a problem
 * is flagged for the operator) · require (a session is billed only when its
 * signed readings verify against the registered key and match the bill;
 * otherwise it is parked for review).
 */

export type SignedStatus = 'verified' | 'unverified_key' | 'mismatch' | 'invalid' | 'incomplete' | 'missing';
export type Policy = 'off' | 'record' | 'require';

/** Metering resolution: meters print kWh with three decimals (1 Wh); allow rounding on each end. */
export const MATCH_TOLERANCE_WH = 2;

interface Runner { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }

type VerifyStatus = 'valid' | 'invalid' | 'no_key' | 'unreadable' | 'unsupported';

/** Check one signed value: which key, and does the signature hold. */
export function checkSigned(
  data: string,
  opts: { encoding?: string | null; chargerKey?: string | null; registeredKey?: string | null },
): { status: VerifyStatus; detail: string | null; keySource: 'registered' | 'charger' | null; parsed: ParsedOcmf | null } {
  if (opts.encoding && !/^ocmf$/i.test(opts.encoding)) {
    return { status: 'unsupported', detail: `encoding ${opts.encoding} is not supported (only OCMF)`, keySource: null, parsed: null };
  }
  const text = ocmfText(data);
  if (!text) return { status: 'unreadable', detail: 'not OCMF data', keySource: null, parsed: null };
  const parsed = parseOcmf(text);
  if (typeof parsed === 'string') return { status: 'unreadable', detail: parsed, keySource: null, parsed: null };
  const registered = opts.registeredKey ? normaliseMeterKey(opts.registeredKey) : null;
  const sent = opts.chargerKey ? keyFromOcpp(opts.chargerKey) : null;
  const sentKey = sent ? normaliseMeterKey(sent) : null;
  if (registered && typeof registered !== 'string') {
    if (sentKey && typeof sentKey !== 'string' && sentKey.hex !== registered.hex) {
      return { status: 'invalid', detail: 'the charger sent a different meter key than the one registered for this connector', keySource: 'registered', parsed };
    }
    const v = verifyOcmf(parsed, registered.key);
    return { status: v.ok ? 'valid' : 'invalid', detail: v.ok ? null : v.reason, keySource: 'registered', parsed };
  }
  if (sentKey && typeof sentKey !== 'string') {
    const v = verifyOcmf(parsed, sentKey.key);
    return { status: v.ok ? 'valid' : 'invalid', detail: v.ok ? null : v.reason, keySource: 'charger', parsed };
  }
  return { status: 'no_key', detail: 'no meter key registered for this connector, and none sent with the data', keySource: null, parsed };
}

const readingsOf = (p: ParsedOcmf | null) =>
  (p?.payload.RD ?? []).map((r: OcmfReading) => ({
    tm: r.TM, tx: r.TX ?? null, wh: readingWh(r), register: registerOf(r.RI), ri: r.RI ?? null, ok: readingOk(r), st: r.ST ?? 'G', ef: r.EF ?? '',
  }));

/** Keep every signed value in a batch of meter values (called with the session's other samples). */
export async function storeSigned(sessionId: string, mv: CanonicalMeterValue[], client?: Runner): Promise<number> {
  const signed = mv.flatMap((m) => m.sampledValue.filter((s) => s.signed?.data).map((s) => ({ ts: m.timestamp, s })));
  if (!signed.length) return 0;
  const run: Runner = client ?? { query };
  const k = (await run.query(
    `SELECT cs.org_id, c.meter_public_key FROM charging_session cs JOIN connector c ON c.id = cs.connector_uuid WHERE cs.id = $1`, [sessionId],
  )).rows[0] as { org_id: string; meter_public_key: string | null } | undefined;
  if (!k) return 0;
  let n = 0;
  for (const { ts, s } of signed) {
    const c = checkSigned(s.signed!.data, { encoding: s.signed!.encoding, chargerKey: s.signed!.publicKey, registeredKey: k.meter_public_key });
    const r = await run.query(
      `INSERT INTO signed_meter_value (session_id, org_id, sampled_at, context, measurand, encoding, data, public_key, signing_method,
                                       meter_serial, readings, verify_status, verify_detail, key_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (session_id, data) DO NOTHING`,
      [sessionId, k.org_id, ts, s.context ?? null, s.measurand ?? null, s.signed!.encoding ?? 'OCMF', s.signed!.data,
        s.signed!.publicKey ?? null, s.signed!.method ?? null, c.parsed?.payload.MS ?? null,
        c.parsed ? JSON.stringify(readingsOf(c.parsed)) : null, c.status, c.detail, c.keySource],
    );
    n += (r as any).rowCount ?? 0;
  }
  return n;
}

export interface Assessment {
  status: SignedStatus;
  signedWh: number | null;
  detail: string;
  flag: { code: string; severity: 'warning' | 'violation'; message: string } | null;
}

/**
 * The session's signed readings against its bill. Re-checks every signature
 * with the key registered now (a key may be added after the data arrived).
 */
export async function assessSession(sessionId: string, billedWh: number, client?: Runner): Promise<Assessment | null> {
  const run: Runner = client ?? { query };
  const s = (await run.query(
    `SELECT s.signed_meter_policy AS policy, c.meter_public_key, c.meter_serial, t.uid AS token_uid
       FROM charging_session cs JOIN site s ON s.id = cs.site_id JOIN connector c ON c.id = cs.connector_uuid
       LEFT JOIN token t ON t.id = cs.token_id
      WHERE cs.id = $1`,
    [sessionId],
  )).rows[0] as { policy: Policy; meter_public_key: string | null; meter_serial: string | null; token_uid: string | null } | undefined;
  if (!s || s.policy === 'off') return null;
  const rows = (await run.query(
    `SELECT id, data, encoding, public_key FROM signed_meter_value WHERE session_id = $1 ORDER BY id`, [sessionId],
  )).rows as Array<{ id: number; data: string; encoding: string | null; public_key: string | null }>;

  const out = (status: SignedStatus, signedWh: number | null, detail: string): Assessment => ({
    status,
    signedWh,
    detail,
    flag: s.policy === 'require' && status !== 'verified'
      ? { code: `SIGNED_METER_${status.toUpperCase()}`, severity: 'violation', message: `Signed meter data: ${detail} This site bills only verified signed readings; parked for review.` }
      : (status === 'mismatch' || status === 'invalid')
        ? { code: `SIGNED_METER_${status.toUpperCase()}`, severity: 'warning', message: `Signed meter data: ${detail}` }
        : null,
  });

  if (!rows.length) {
    // A charger that does not sign is normal unless the site requires it.
    return s.policy === 'require' ? out('missing', null, 'the charger sent no signed readings for this session.') : null;
  }

  const checked = rows.map((r) => ({ id: r.id, ...checkSigned(r.data, { encoding: r.encoding, chargerKey: r.public_key, registeredKey: s.meter_public_key }) }));
  for (const c of checked) {
    await run.query(`UPDATE signed_meter_value SET verify_status = $2, verify_detail = $3, key_source = $4 WHERE id = $1`, [c.id, c.status, c.detail, c.keySource]);
  }
  const bad = checked.find((c) => c.status === 'invalid' || c.status === 'unreadable' || c.status === 'unsupported');
  if (bad) return out('invalid', null, `a signed reading failed its check (${bad.detail}).`);

  // One meter, and the one this connector has.
  const serials = [...new Set(checked.map((c) => String(c.parsed?.payload.MS ?? '').trim()).filter(Boolean))];
  if (serials.length > 1) return out('invalid', null, `the signed readings come from more than one meter (${serials.join(', ')}).`);
  const norm = (x: string) => x.replace(/[\s-]/g, '').toUpperCase();
  if (serials[0] && s.meter_serial && norm(serials[0]) !== norm(s.meter_serial)) {
    return out('invalid', null, `the signed readings are from meter ${serials[0]}, but this connector's meter is ${s.meter_serial}.`);
  }

  // The import register at the start and at the end — OF ONE TRANSACTION.
  const readings = checked.flatMap((c, row) => readingsOf(c.parsed).map((r, idx) => ({
    ...r, row, idx, pg: parsePagination(c.parsed?.payload.PG), id: idOf(c.parsed), it: c.parsed?.payload.IT ?? null,
  }))).filter((r) => r.register === 'import' && r.wh !== null);
  const notOk = readings.find((r) => !r.ok);
  if (notOk) return out('invalid', null, `the meter marked a reading as not valid (status ${notOk.st}${notOk.ef ? `, error ${notOk.ef}` : ''}).`);
  const pair = transactionPair(readings);
  if ('missing' in pair) return out('incomplete', null, pair.missing);
  const { begin, end } = pair;
  const signedWh = end.wh! - begin.wh!;

  /**
   * Whose transaction. The OCMF `ID` is the identification the meter recorded
   * for the transaction. Start and end must carry the same one, and where it is
   * a token identifier (RFID UID, eMAID, a central or local id) it must be this
   * session's token: otherwise these are signed readings of somebody else's
   * charge, however well their energy matches.
   */
  if (begin.id && end.id && normId(begin.id) !== normId(end.id)) {
    return out('mismatch', signedWh, `the signed start and end readings identify different transactions (ID ${begin.id} and ${end.id}).`);
  }
  const txId = end.id ?? begin.id;
  const txIt = String(end.id ? end.it ?? '' : begin.it ?? '').toUpperCase();
  if (txId && s.token_uid && TOKEN_ID_TYPES.has(txIt) && normId(txId) !== normId(s.token_uid)) {
    return out('mismatch', signedWh, `the signed readings belong to identification ${txId}, but this session was started with token ${s.token_uid}.`);
  }

  if (Math.abs(signedWh - billedWh) > MATCH_TOLERANCE_WH) {
    return out('mismatch', signedWh, `the signed readings show ${signedWh} Wh (${begin.wh} → ${end.wh} Wh), the session is billed for ${billedWh} Wh.`);
  }
  const noKey = checked.some((c) => c.status === 'no_key');
  const charger = checked.some((c) => c.keySource === 'charger');
  if (noKey || charger) {
    return out('unverified_key', signedWh,
      noKey
        ? 'the readings match the bill, but no meter key is registered to check their signatures.'
        : 'the readings match the bill and their signatures hold, but only against the key the charger sent; register the meter key to verify them.');
  }
  return out('verified', signedWh, `verified: ${signedWh} Wh between the signed start and end readings of meter ${serials[0] ?? '(no serial)'}, as billed.`);
}

// ─────────────────────────────────────────────── one transaction

/** OCMF identification types that name a token this CSMS can compare with the session's. */
const TOKEN_ID_TYPES = new Set(['ISO14443', 'ISO15693', 'EMAID', 'EVCOID', 'CENTRAL', 'CENTRAL_1', 'CENTRAL_2', 'LOCAL', 'LOCAL_1', 'LOCAL_2']);

const normId = (x: string) => x.replace(/[^0-9A-Za-z]/g, '').toUpperCase();

function idOf(p: ParsedOcmf | null): string | null {
  const id = p?.payload.ID;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/** OCMF pagination: "T12" (transaction counter) or "F3" (fiscal counter). */
export function parsePagination(pg: unknown): { kind: string; n: number } | null {
  const m = /^\s*([A-Za-z])\s*(\d+)\s*$/.exec(String(pg ?? ''));
  return m ? { kind: m[1]!.toUpperCase(), n: Number(m[2]) } : null;
}

export interface PairReading {
  tx: string | null;
  tm: string;
  wh: number | null;
  /** Which stored signed value the reading came from, and where in its RD list. */
  row: number;
  idx: number;
  pg: { kind: string; n: number } | null;
  id: string | null;
  it: string | null;
}

/**
 * Meter order: within one data set, the order of its readings; between data
 * sets, the meter's pagination counter when both carry one of the same kind
 * (OCMF increments it for every data set it signs, so it orders them even when
 * clocks do not); otherwise the readings' own times, then arrival.
 */
function meterOrder(a: PairReading, b: PairReading): number {
  if (a.row === b.row) return a.idx - b.idx;
  if (a.pg && b.pg && a.pg.kind === b.pg.kind && a.pg.n !== b.pg.n) return a.pg.n - b.pg.n;
  const ta = parseOcmfTime(a.tm)?.getTime();
  const tb = parseOcmfTime(b.tm)?.getTime();
  if (ta != null && tb != null && ta !== tb) return ta - tb;
  return a.row - b.row;
}

/**
 * The begin ("B") and end ("E") readings of ONE transaction.
 *
 * They used to be picked across every signed value stored for the session —
 * the earliest B and the latest E, by time alone — so a B of one transaction
 * and an E of another (a replayed data set, a charger that keeps the previous
 * transaction's start in its buffer, two transactions under one session after
 * a missed stop) were billed against each other and could even come out
 * "verified".
 *
 * Now the end is the last E in meter order and the begin is the B that
 * immediately precedes it: no other B or E may lie between them. When there is
 * no such B (none at all, or only after the end) the pair is incomplete. The
 * same-identification check is the caller's (assessSession).
 */
export function transactionPair<R extends PairReading>(readings: R[]): { begin: R; end: R } | { missing: string } {
  const sorted = [...readings].sort(meterOrder);
  const hasB = sorted.some((r) => r.tx === 'B');
  const endAt = sorted.map((r) => r.tx).lastIndexOf('E');
  if (endAt < 0) {
    return { missing: `${!hasB ? 'neither the start nor the end' : 'the end'} reading of the transaction is not among the signed data.` };
  }
  for (let i = endAt - 1; i >= 0; i--) {
    const r = sorted[i]!;
    if (r.tx === 'B') return { begin: r, end: sorted[endAt]! };
    if (r.tx === 'E') {
      return { missing: 'the start reading of the transaction is not among the signed data: the signed end reading follows another transaction\'s end, not a start.' };
    }
  }
  return {
    missing: hasB
      ? 'the start reading of the transaction is not among the signed data: the only signed start reading comes after the end reading, so they are not one transaction.'
      : 'the start reading of the transaction is not among the signed data.',
  };
}

/** What the console, the receipt and the API show for a session. */
export async function signedDataFor(sessionId: string) {
  const s = await one<{ signed_status: SignedStatus | null; signed_energy_wh: string | null; signed_detail: string | null; energy_wh: string; meter_public_key: string | null; meter_serial: string | null; policy: Policy; ocpp_transaction_id: string | null }>(
    `SELECT cs.signed_status, cs.signed_energy_wh, cs.signed_detail, cs.energy_wh, c.meter_public_key, c.meter_serial, st.signed_meter_policy AS policy, cs.ocpp_transaction_id
       FROM charging_session cs JOIN connector c ON c.id = cs.connector_uuid JOIN site st ON st.id = cs.site_id WHERE cs.id = $1`,
    [sessionId],
  );
  if (!s) return null;
  const values = await many<any>(
    `SELECT id, sampled_at, context, encoding, data, public_key, meter_serial, readings, verify_status, verify_detail, key_source
       FROM signed_meter_value WHERE session_id = $1 ORDER BY id`,
    [sessionId],
  );
  const reg = s.meter_public_key ? normaliseMeterKey(s.meter_public_key) : null;
  return {
    policy: s.policy,
    status: s.signed_status,
    detail: s.signed_detail,
    signedEnergyWh: s.signed_energy_wh === null ? null : Number(s.signed_energy_wh),
    billedEnergyWh: Number(s.energy_wh),
    meterSerial: s.meter_serial,
    /** The key the signatures are checked against (hex DER), as the Transparency Software takes it. */
    meterPublicKey: reg && typeof reg !== 'string' ? reg.hex : null,
    transactionId: s.ocpp_transaction_id,
    values: values.map((v) => ({
      id: Number(v.id),
      sampledAt: v.sampled_at,
      context: v.context,
      encoding: v.encoding,
      ocmf: ocmfText(v.data) ?? v.data,
      meterSerial: v.meter_serial,
      readings: v.readings ?? [],
      verifyStatus: v.verify_status,
      verifyDetail: v.verify_detail,
      keySource: v.key_source,
      chargerKey: v.public_key ? keyFromOcpp(v.public_key) : null,
    })),
  };
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The session's signed data as an XML file for the S.A.F.E. Transparency
 * Software: each signed value with the meter's public key.
 */
export function transparencyXml(d: NonNullable<Awaited<ReturnType<typeof signedDataFor>>>): string {
  const key = (v: (typeof d.values)[number]) => d.meterPublicKey ?? (v.chargerKey ? (normaliseMeterKey(v.chargerKey) as any)?.hex ?? '' : '');
  const lines = d.values.map((v) => [
    `  <value transactionId="${xmlEsc(String(d.transactionId ?? ''))}" context="${xmlEsc(String(v.context ?? 'Sample.Periodic'))}">`,
    `    <signedData format="OCMF" encoding="plain">${xmlEsc(v.ocmf)}</signedData>`,
    `    <publicKey encoding="plain">${xmlEsc(key(v))}</publicKey>`,
    '  </value>',
  ].join('\n'));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<values>\n${lines.join('\n')}\n</values>\n`;
}

/** Register (or clear) a connector's meter key; returns the canonical hex form. */
export function meterKeyProblem(input: unknown): { hex: string | null } | { error: string } {
  if (input === null || input === '') return { hex: null };
  const k = normaliseMeterKey(String(input));
  return typeof k === 'string' ? { error: `Meter public key: ${k}` } : { hex: k.hex };
}

/**
 * OCPI 2.2.1 CDR signed_data: the meter's signed values, Start / End /
 * Intermediate, with a short plain reading beside each and the meter's key.
 */
export function ocpiSignedData(d: NonNullable<Awaited<ReturnType<typeof signedDataFor>>>) {
  if (!d.values.length) return null;
  const nature = (v: (typeof d.values)[number]) => {
    const tx = (v.readings as Array<{ tx: string | null }>).map((r) => r.tx);
    return v.context === 'Transaction.Begin' || tx.includes('B') ? 'Start' : v.context === 'Transaction.End' || tx.includes('E') ? 'End' : 'Intermediate';
  };
  const plain = (v: (typeof d.values)[number]) => {
    const r = (v.readings as Array<{ register: string; wh: number | null; tm: string }>).find((x) => x.register === 'import' && x.wh !== null);
    return r ? `${(r.wh! / 1000).toFixed(3)} kWh at ${r.tm}`.slice(0, 512) : '';
  };
  return {
    encoding_method: 'OCMF',
    ...(d.meterPublicKey ? { public_key: d.meterPublicKey.slice(0, 512) } : {}),
    signed_values: d.values.filter((v) => v.ocmf.length <= 5000).map((v) => ({ nature: nature(v), plain_data: plain(v), signed_data: v.ocmf })),
  };
}