import { config } from '../config.js';
import { query } from '../db/pool.js';
import { logger } from '../logger.js';

/**
 * Retention for the high-volume diagnostic logs.
 *
 *   ocpp_frame          every OCPP message in and out (with drivers' idTags):
 *                       OCPP_FRAME_RETENTION_DAYS, default 90
 *   connection_attempt  every WebSocket upgrade, accepted or refused:
 *                       CONNECTION_ATTEMPT_RETENTION_DAYS, default 30
 *   api_key_rate_bucket shared rate-limit buckets idle for a day (a bucket idle
 *                       that long is full; dropping it changes nothing)
 *
 * Both logs grew without bound — a few hundred chargers write tens of millions
 * of frames a year — until the disk filled or backups became unrestorable in
 * any reasonable window. Nothing billing- or audit-relevant lives here: sessions,
 * meter values, CDRs and the audit log are other tables and are not touched.
 *
 * Deletes go in batches of BATCH_ROWS with a short pause between them, so a pass
 * never holds a long lock, never writes one huge WAL burst, and leaves the
 * gateway's own frame INSERTs room to run. A pass stops after MAX_PASS_MS and the
 * next hourly pass continues, so the first run on an old installation catches up
 * over a few hours instead of blocking for one. Registered as an exclusive()
 * worker in workers.ts: one runner platform-wide.
 */

export const BATCH_ROWS = 10_000;
const PAUSE_MS = 200;
const MAX_PASS_MS = 50_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetentionResult {
  ocppFrames: number;
  connectionAttempts: number;
  rateBuckets: number;
  /** True when the pass stopped on its time budget with old rows still left. */
  incomplete: boolean;
}

/**
 * Delete until `step` deletes nothing or the deadline passes. `step` deletes one
 * batch and returns its row count.
 */
async function drain(step: () => Promise<number>, deadline: number, pauseMs: number): Promise<{ n: number; done: boolean }> {
  let n = 0;
  for (;;) {
    const d = await step();
    n += d;
    if (d === 0) return { n, done: true };
    if (Date.now() >= deadline) return { n, done: false };
    await sleep(pauseMs);
  }
}

/**
 * One batch of ocpp_frame, oldest first.
 *
 * ocpp_frame has no index on ts (see migration 052 for why none is added), so
 * the batch is chosen from the oldest BATCH_ROWS primary keys and only the old
 * ones among them are deleted. ids and ts both grow with insertion, so the head
 * of the table is where the old rows are; when the oldest BATCH_ROWS rows hold
 * nothing past retention, there is nothing older to find and the pass stops.
 * Every batch is one bounded primary-key range scan — never a table scan.
 */
async function deleteFrameBatch(cutoff: Date, batch: number): Promise<number> {
  const r = await query(
    `DELETE FROM ocpp_frame
      WHERE id IN (SELECT id FROM (SELECT id, ts FROM ocpp_frame ORDER BY id LIMIT $2) head WHERE ts < $1)`,
    [cutoff, batch],
  );
  return r.rowCount ?? 0;
}

/** One batch of connection_attempt, by its (ts) index from migration 002. */
async function deleteAttemptBatch(cutoff: Date, batch: number): Promise<number> {
  const r = await query(
    `DELETE FROM connection_attempt
      WHERE id IN (SELECT id FROM connection_attempt WHERE ts < $1 ORDER BY ts LIMIT $2)`,
    [cutoff, batch],
  );
  return r.rowCount ?? 0;
}

const daysAgo = (days: number, now: number) => new Date(now - days * 86_400_000);

export async function runRetention(opts: {
  ocppFrameDays?: number;
  connectionAttemptDays?: number;
  batchRows?: number;
  pauseMs?: number;
  maxPassMs?: number;
  now?: number;
} = {}): Promise<RetentionResult> {
  const frameDays = opts.ocppFrameDays ?? config.retention.ocppFrameDays;
  const attemptDays = opts.connectionAttemptDays ?? config.retention.connectionAttemptDays;
  const batch = opts.batchRows ?? BATCH_ROWS;
  const pause = opts.pauseMs ?? PAUSE_MS;
  const now = opts.now ?? Date.now();
  const deadline = Date.now() + (opts.maxPassMs ?? MAX_PASS_MS);
  const out: RetentionResult = { ocppFrames: 0, connectionAttempts: 0, rateBuckets: 0, incomplete: false };

  // 0 (or a negative / non-numeric value) keeps that table forever.
  if (frameDays > 0) {
    const r = await drain(() => deleteFrameBatch(daysAgo(frameDays, now), batch), deadline, pause);
    out.ocppFrames = r.n;
    out.incomplete ||= !r.done;
  }
  if (attemptDays > 0 && Date.now() < deadline) {
    const r = await drain(() => deleteAttemptBatch(daysAgo(attemptDays, now), batch), deadline, pause);
    out.connectionAttempts = r.n;
    out.incomplete ||= !r.done;
  } else if (attemptDays > 0) {
    out.incomplete = true;
  }
  const b = await query(`DELETE FROM api_key_rate_bucket WHERE updated_at < now() - interval '1 day'`).catch(() => null);
  out.rateBuckets = b?.rowCount ?? 0;

  if (out.ocppFrames || out.connectionAttempts || out.incomplete) {
    logger.info({ ...out, frameDays, attemptDays }, out.incomplete ? 'retention pass stopped on its time budget; the next pass continues' : 'retention pass');
  }
  return out;
}
