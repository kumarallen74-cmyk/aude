import { createHash } from 'node:crypto';
import { defaultTimezone } from '../domain/timezone.js';
import { one, many, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { bus } from './events.js';
import * as commands from '../ocpp/commands.js';
import * as registry from '../ocpp/registry.js';
import { newRequestId } from '../ocpp/translate201.js';
import { newToken, publicUrl } from './storage.js';
import { guardedHttpsGet } from './net-guard.js';

/**
 * Firmware Over-the-Air campaigns (SPEC Module 9.1).
 *
 * v1.2.1 could send exactly one UpdateFirmware by hand and then ignored every
 * FirmwareStatusNotification the charger sent back (logged and dropped). This
 * adds the repository, campaign targeting, a maintenance window, retry policy and
 * a per-charger state machine driven by those notifications:
 *
 *   pending -> dispatched (Initiated) -> Downloading -> Downloaded
 *           -> Installing -> Installed -> Verified (the unit rebooted and reported
 *              the target version in BootNotification)
 *   any failure -> retried after retry_interval_s until max_retries, then failed.
 *
 * The scheduler (tick) runs where the charger sockets are — the gateway in the
 * split deployment, the single process otherwise.
 */

export const JOB_TERMINAL = ['Verified', 'failed', 'cancelled'];
export const JOB_ACTIVE = ['dispatched', 'Downloading', 'Downloaded', 'Installing', 'Installed', 'InstallRebooting', 'InstallScheduled', 'DownloadScheduled', 'DownloadPaused', 'SignatureVerified'];

/** Display stages for the progress bar. */
export const STAGES = ['Initiated', 'Downloading', 'Downloaded', 'Installing', 'Installed', 'Verified'] as const;

export function stageIndex(state: string): number {
  switch (state) {
    case 'pending':
      return -1;
    case 'dispatched':
    case 'DownloadScheduled':
    case 'DownloadPaused':
      return 0;
    case 'Downloading':
      return 1;
    case 'Downloaded':
    case 'SignatureVerified':
    case 'InstallScheduled':
      return 2;
    case 'Installing':
    case 'InstallRebooting':
      return 3;
    case 'Installed':
      return 4;
    case 'Verified':
      return 5;
    default:
      return -1;
  }
}

const FAILURE_STATUSES = new Set([
  'DownloadFailed',
  'InstallationFailed',
  'InstallVerificationFailed',
  'InvalidSignature',
]);

// ------------------------------------------------------------------ images

export interface ImageMeta {
  name: string;
  version: string;
  vendor?: string | null;
  compatibleModels?: string[];
  sha256?: string | null;
  notes?: string | null;
}

export function normaliseSha256(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase().replace(/[:\s]/g, '');
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

export async function createImage(
  orgId: string,
  meta: ImageMeta,
  src:
    | { kind: 'upload'; path: string; fileName: string; size: number; sha256: string }
    | { kind: 'url'; url: string },
  createdBy: string,
) {
  const declared = normaliseSha256(meta.sha256);
  const verified = src.kind === 'upload' ? (declared ? declared === src.sha256 : true) : false;
  if (src.kind === 'upload' && declared && declared !== src.sha256) {
    return {
      ok: false as const,
      error: `SHA-256 mismatch: the uploaded file hashes to ${src.sha256}, not the declared ${declared}. The file was not saved.`,
    };
  }
  const row = await one<{ id: string }>(
    `INSERT INTO firmware_image (org_id, name, version, vendor, compatible_models, source, url, storage_path,
                                 file_name, size_bytes, sha256, sha256_verified, download_token, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [
      orgId,
      meta.name,
      meta.version,
      meta.vendor ?? null,
      meta.compatibleModels ?? [],
      src.kind,
      src.kind === 'url' ? src.url : null,
      src.kind === 'upload' ? src.path : null,
      src.kind === 'upload' ? src.fileName : null,
      src.kind === 'upload' ? src.size : null,
      src.kind === 'upload' ? src.sha256 : declared,
      verified,
      newToken(),
      meta.notes ?? null,
      createdBy,
    ],
  );
  return { ok: true as const, id: row!.id };
}

export async function listImages(orgId: string) {
  return many(
    `SELECT i.id, i.name, i.version, i.vendor, i.compatible_models, i.source, i.url, i.file_name, i.size_bytes,
            i.sha256, i.sha256_verified, i.notes, i.created_by, i.created_at, i.archived_at,
            (SELECT count(*)::int FROM firmware_campaign c WHERE c.image_id = i.id) AS campaigns
       FROM firmware_image i WHERE i.org_id = $1 ORDER BY i.created_at DESC`,
    [orgId],
  );
}

/** Where a charger downloads the image from. */
/** Hours a firmware link keeps working after a charger's job last moved (slow downloads, retries). */
export const FIRMWARE_LINK_GRACE_HOURS = Number(process.env.FIRMWARE_LINK_GRACE_HOURS ?? 24);

/**
 * The uploaded image a charger-facing /fw/<token> link points to, if it may be downloaded now.
 *
 * The link is a capability (chargers cannot sign in), and it used to work until the image was
 * archived, so one copied from a charger's log or a vendor ticket stayed valid for good. Now it
 * works only while a campaign that uses the image is scheduled or running and that charger's job
 * is not finished, or for FIRMWARE_LINK_GRACE_HOURS after a job last moved. Campaigns are the only
 * place links are handed to chargers (dispatch, below).
 */
export async function downloadableImage(token: string, now = new Date()) {
  return one<{ storage_path: string | null; size_bytes: number | null; file_name: string | null }>(
    `SELECT i.storage_path, i.size_bytes, i.file_name FROM firmware_image i
      WHERE i.download_token = $1 AND i.source = 'upload' AND i.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM firmware_job j JOIN firmware_campaign c ON c.id = j.campaign_id
                     WHERE c.image_id = i.id
                       AND ((c.status IN ('scheduled', 'running') AND j.state <> ALL($2::text[]))
                            OR j.updated_at > $3::timestamptz - make_interval(hours => $4::int)))`,
    [token, JOB_TERMINAL, now, FIRMWARE_LINK_GRACE_HOURS],
  );
}

export function imageLocation(img: { source: string; url: string | null; download_token: string; file_name: string | null }, origin?: string) {
  if (img.source === 'url' && img.url) return img.url;
  return publicUrl(`/fw/${img.download_token}/${encodeURIComponent(img.file_name ?? 'firmware.bin')}`, origin);
}

/**
 * Verify a URL-sourced image's checksum by downloading it once, server-side.
 * Streams and hashes; nothing is stored.
 */
export async function verifyRemoteChecksum(
  imageId: string,
  maxBytes: number,
): Promise<{ ok: boolean; error?: string; sha256?: string; size?: number }> {
  const img = await one<{ url: string | null; sha256: string | null; source: string }>(
    `SELECT url, sha256, source FROM firmware_image WHERE id = $1`,
    [imageId],
  );
  if (!img || img.source !== 'url' || !img.url) return { ok: false, error: 'only URL-sourced images can be verified this way' };
  if (!img.url.startsWith('https://')) return { ok: false, error: 'firmware URLs must be HTTPS' };
  // The server itself downloads this operator-supplied URL, so it goes through
  // the same SSRF guard as webhooks: a plain fetch() let anyone with
  // firmware:write point it at the metadata endpoint or an internal service
  // (directly, by DNS rebinding, or through a redirect) and learn from the
  // error, size and hash what answered there.
  const res = await guardedHttpsGet(img.url, { signal: AbortSignal.timeout(10 * 60_000) }).catch((e) => e as Error);
  if (res instanceof Error) return { ok: false, error: `download failed: ${res.message}` };
  const status = res.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    res.resume();
    return { ok: false, error: `download failed: HTTP ${status}` };
  }
  const declaredLength = Number(res.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    res.destroy();
    return { ok: false, error: 'file exceeds the firmware size limit' };
  }
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of res) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) return { ok: false, error: 'file exceeds the firmware size limit' };
      hash.update(chunk as Buffer);
    }
  } catch (e) {
    // A timeout or reset mid-body rejects the iterator; report it like any other download failure.
    return { ok: false, error: `download failed: ${(e as Error).message}` };
  }
  const actual = hash.digest('hex');
  const matches = img.sha256 ? img.sha256 === actual : true;
  await query(`UPDATE firmware_image SET sha256 = COALESCE(sha256, $2), sha256_verified = $3, size_bytes = $4 WHERE id = $1`, [
    imageId,
    actual,
    matches,
    size,
  ]);
  return matches
    ? { ok: true, sha256: actual, size }
    : { ok: false, error: `checksum mismatch: the file hashes to ${actual}, the declared value is ${img.sha256}` };
}

// ------------------------------------------------------------------ campaigns

export interface CampaignInput {
  imageId: string;
  name: string;
  targetType: 'charge_point' | 'site' | 'fleet';
  targetIds: string[];
  windowStart?: string | null;
  windowEnd?: string | null;
  maxRetries?: number;
  retryIntervalS?: number;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateCampaign(c: CampaignInput): string[] {
  const p: string[] = [];
  if (!c.name?.trim()) p.push('Give the campaign a name');
  if (!['charge_point', 'site', 'fleet'].includes(c.targetType)) p.push('Choose the targets');
  if (c.targetType !== 'fleet' && (!Array.isArray(c.targetIds) || c.targetIds.length === 0)) p.push('Select at least one target');
  if ((c.windowStart && !HHMM.test(c.windowStart)) || (c.windowEnd && !HHMM.test(c.windowEnd))) p.push('Window times are HH:MM');
  if (Boolean(c.windowStart) !== Boolean(c.windowEnd)) p.push('Set both ends of the window, or neither');
  if (c.maxRetries != null && (!Number.isInteger(c.maxRetries) || c.maxRetries < 0 || c.maxRetries > 10)) p.push('Retries must be 0-10');
  if (c.retryIntervalS != null && (!Number.isInteger(c.retryIntervalS) || c.retryIntervalS < 60 || c.retryIntervalS > 86_400)) {
    p.push('Retry interval must be 1 minute to 24 hours');
  }
  return p;
}

export async function createCampaign(orgId: string, c: CampaignInput, createdBy: string) {
  const img = await one<{ id: string; compatible_models: string[] }>(
    `SELECT id, compatible_models FROM firmware_image WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
    [c.imageId, orgId],
  );
  if (!img) return { ok: false as const, error: 'firmware image not found' };

  const targets = await many<{ id: string; model: string | null; ocpp_identity: string }>(
    c.targetType === 'fleet'
      ? `SELECT cp.id, cp.model, cp.ocpp_identity FROM charge_point cp JOIN site s ON s.id = cp.site_id
          WHERE s.org_id = $1 AND cp.status NOT IN ('decommissioned','pending_adoption')`
      : c.targetType === 'site'
        ? `SELECT cp.id, cp.model, cp.ocpp_identity FROM charge_point cp JOIN site s ON s.id = cp.site_id
            WHERE s.org_id = $1 AND cp.site_id = ANY($2::uuid[]) AND cp.status NOT IN ('decommissioned','pending_adoption')`
        : `SELECT cp.id, cp.model, cp.ocpp_identity FROM charge_point cp JOIN site s ON s.id = cp.site_id
            WHERE s.org_id = $1 AND cp.id = ANY($2::uuid[])`,
    c.targetType === 'fleet' ? [orgId] : [orgId, c.targetIds],
  );
  if (targets.length === 0) return { ok: false as const, error: 'no charge points match those targets' };

  // Compatibility is a guard, not a suggestion: flashing the wrong image bricks units.
  const compat = (img.compatible_models ?? []).map((m) => m.toLowerCase());
  const incompatible = compat.length
    ? targets.filter((t) => !compat.some((m) => (t.model ?? '').toLowerCase().includes(m)))
    : [];
  if (incompatible.length) {
    return {
      ok: false as const,
      error:
        `${incompatible.length} target(s) are not a compatible model for this image: ` +
        incompatible.slice(0, 5).map((t) => `${t.ocpp_identity} (${t.model ?? 'unknown model'})`).join(', '),
    };
  }

  const row = await one<{ id: string }>(
    `INSERT INTO firmware_campaign (org_id, image_id, name, target_type, target_ids, window_start, window_end,
                                    max_retries, retry_interval_s, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'scheduled',$10) RETURNING id`,
    [
      orgId,
      c.imageId,
      c.name.trim(),
      c.targetType,
      c.targetType === 'fleet' ? [] : c.targetIds,
      c.windowStart || null,
      c.windowEnd || null,
      c.maxRetries ?? 3,
      c.retryIntervalS ?? 600,
      createdBy,
    ],
  );
  for (const t of targets) {
    await query(
      `INSERT INTO firmware_job (campaign_id, org_id, charge_point_id, state, next_attempt_at)
       VALUES ($1,$2,$3,'pending', now()) ON CONFLICT DO NOTHING`,
      [row!.id, orgId, t.id],
    );
  }
  return { ok: true as const, id: row!.id, targets: targets.length };
}

export async function listCampaigns(orgId: string) {
  return many(
    `SELECT c.id, c.name, c.status, c.target_type, c.window_start, c.window_end, c.max_retries, c.retry_interval_s,
            c.created_by, c.created_at, c.completed_at, i.name AS image_name, i.version AS image_version,
            count(j.id)::int AS jobs,
            count(j.id) FILTER (WHERE j.state = 'Verified')::int AS verified,
            count(j.id) FILTER (WHERE j.state = 'failed')::int AS failed,
            count(j.id) FILTER (WHERE j.state = 'pending')::int AS pending
       FROM firmware_campaign c
       JOIN firmware_image i ON i.id = c.image_id
       LEFT JOIN firmware_job j ON j.campaign_id = c.id
      WHERE c.org_id = $1
      GROUP BY c.id, i.name, i.version
      ORDER BY c.created_at DESC`,
    [orgId],
  );
}

export async function campaignJobs(campaignId: string) {
  const jobs = await many<any>(
    `SELECT j.id, j.state, j.attempts, j.last_error, j.next_attempt_at, j.dispatched_at, j.updated_at,
            j.firmware_before, cp.ocpp_identity, cp.firmware AS firmware_now, cp.model, s.name AS site_name
       FROM firmware_job j
       JOIN charge_point cp ON cp.id = j.charge_point_id
       JOIN site s ON s.id = cp.site_id
      WHERE j.campaign_id = $1
      ORDER BY cp.ocpp_identity`,
    [campaignId],
  );
  return jobs.map((j) => ({ ...j, online: registry.isOnline(j.ocpp_identity), stage: stageIndex(j.state) }));
}

export async function cancelCampaign(campaignId: string) {
  await query(`UPDATE firmware_campaign SET status = 'cancelled', completed_at = now() WHERE id = $1 AND status IN ('scheduled','running')`, [
    campaignId,
  ]);
  await query(`UPDATE firmware_job SET state = 'cancelled', updated_at = now() WHERE campaign_id = $1 AND state = 'pending'`, [
    campaignId,
  ]);
}

/** Minutes since local midnight in a site's timezone. */
function localMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

export function inWindow(now: Date, tz: string, start: string | null, end: string | null): boolean {
  if (!start || !end) return true;
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const x = localMinutes(now, tz);
  const a = toMin(start);
  const b = toMin(end);
  return a <= b ? x >= a && x < b : x >= a || x < b;
}

/**
 * One scheduler pass. Dispatches due jobs whose charger is online and inside the
 * campaign window, and times out jobs a charger has gone silent on.
 */
export async function tick(now = new Date(), origin?: string): Promise<{ dispatched: number; timedOut: number }> {
  // Silent chargers: dispatched with no notification for 2 h, or stuck mid-flight for 6 h.
  const stale = await many<{ id: string; attempts: number; max_retries: number; retry_interval_s: number }>(
    `SELECT j.id, j.attempts, c.max_retries, c.retry_interval_s
       FROM firmware_job j JOIN firmware_campaign c ON c.id = j.campaign_id
      WHERE c.status IN ('scheduled','running')
        AND ((j.state = 'dispatched' AND j.updated_at < $1::timestamptz - interval '2 hours')
          OR (j.state IN ('Downloading','Downloaded','Installing') AND j.updated_at < $1::timestamptz - interval '6 hours'))`,
    [now],
  );
  for (const j of stale) await failOrRetry(j.id, j.attempts, j.max_retries, j.retry_interval_s, 'no status notification from the charger');

  const due = await many<any>(
    `SELECT j.id, j.attempts, j.org_id, cp.id AS cp_id, cp.ocpp_identity, cp.firmware, s.timezone, s.country_code,
            c.id AS campaign_id, c.window_start, c.window_end, c.max_retries, c.retry_interval_s,
            i.source, i.url, i.download_token, i.file_name, i.version
       FROM firmware_job j
       JOIN firmware_campaign c ON c.id = j.campaign_id
       JOIN firmware_image i ON i.id = c.image_id
       JOIN charge_point cp ON cp.id = j.charge_point_id
       JOIN site s ON s.id = cp.site_id
      WHERE c.status IN ('scheduled','running') AND j.state = 'pending'
        AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= $1)
      ORDER BY j.next_attempt_at NULLS FIRST
      LIMIT 50`,
    [now],
  );

  let dispatched = 0;
  for (const j of due) {
    if (!registry.isOnline(j.ocpp_identity)) continue;
    if (!inWindow(now, j.timezone ?? defaultTimezone(j.country_code), j.window_start, j.window_end)) continue;
    // One firmware job in flight per charger, across campaigns.
    const busy = await one(
      `SELECT 1 FROM firmware_job WHERE charge_point_id = $1 AND id <> $2 AND state = ANY($3::text[])`,
      [j.cp_id, j.id, JOB_ACTIVE],
    );
    if (busy) continue;

    if (j.source === 'upload' && !config.console.publicBaseUrl && !origin) {
      // A relative URL is useless to a charger; say so instead of letting it fail silently.
      await query(`UPDATE firmware_job SET attempts = attempts + 1 WHERE id = $1`, [j.id]);
      await failOrRetry(j.id, j.attempts + 1, j.max_retries, j.retry_interval_s,
        'PUBLIC_BASE_URL is not configured, so there is no download URL a charger can reach for an uploaded image');
      continue;
    }
    const requestId = newRequestId();
    const location = imageLocation(j, origin);
    await query(`UPDATE firmware_campaign SET status = 'running' WHERE id = $1 AND status = 'scheduled'`, [j.campaign_id]);
    try {
      await commands.updateFirmware(
        j.ocpp_identity,
        location,
        now.toISOString(),
        { type: 'system', orgId: j.org_id },
        { retries: 2, retryInterval: 120, requestId },
      );
      await query(
        `UPDATE firmware_job SET state = 'dispatched', attempts = attempts + 1, request_id = $2, dispatched_at = now(),
                firmware_before = $3, last_error = NULL, updated_at = now() WHERE id = $1`,
        [j.id, requestId, j.firmware],
      );
      dispatched++;
      bus.emit('firmware.status', { orgId: j.org_id, ocppIdentity: j.ocpp_identity, status: 'Initiated', jobId: j.id });
    } catch (e) {
      await query(`UPDATE firmware_job SET attempts = attempts + 1 WHERE id = $1`, [j.id]);
      await failOrRetry(j.id, j.attempts + 1, j.max_retries, j.retry_interval_s, (e as Error).message);
    }
  }

  await completeFinishedCampaigns();
  return { dispatched, timedOut: stale.length };
}

async function failOrRetry(jobId: string, attempts: number, maxRetries: number, retryIntervalS: number, error: string) {
  if (attempts > maxRetries) {
    await query(`UPDATE firmware_job SET state = 'failed', last_error = $2, updated_at = now() WHERE id = $1`, [jobId, error]);
  } else {
    await query(
      `UPDATE firmware_job SET state = 'pending', last_error = $2, next_attempt_at = now() + ($3 || ' seconds')::interval,
              updated_at = now() WHERE id = $1`,
      [jobId, error, retryIntervalS],
    );
  }
}

async function completeFinishedCampaigns() {
  await query(
    `UPDATE firmware_campaign c SET status = 'completed', completed_at = now()
      WHERE c.status = 'running'
        AND NOT EXISTS (SELECT 1 FROM firmware_job j WHERE j.campaign_id = c.id AND j.state <> ALL($1::text[]))`,
    [JOB_TERMINAL],
  );
}

/** FirmwareStatusNotification from a charger (1.6 or 2.0.1). */
export async function onFirmwareStatus(chargePointId: string, ocppIdentity: string, orgId: string, status: string) {
  const job = await one<{ id: string; attempts: number; max_retries: number; retry_interval_s: number }>(
    `SELECT j.id, j.attempts, c.max_retries, c.retry_interval_s
       FROM firmware_job j JOIN firmware_campaign c ON c.id = j.campaign_id
      WHERE j.charge_point_id = $1 AND j.state = ANY($2::text[])
      ORDER BY j.dispatched_at DESC NULLS LAST LIMIT 1`,
    [chargePointId, JOB_ACTIVE],
  );
  bus.emit('firmware.status', { orgId, ocppIdentity, status, jobId: job?.id ?? null });
  if (!job) return;

  if (FAILURE_STATUSES.has(status)) {
    await failOrRetry(job.id, job.attempts, job.max_retries, job.retry_interval_s, `charger reported ${status}`);
    bus.emit('alert.raised', {
      orgId,
      kind: 'firmware.failed',
      severity: 'warning',
      message: `${ocppIdentity}: firmware update reported ${status}.`,
    });
    return;
  }
  if (status === 'Idle') return; // no change of state worth recording
  await query(`UPDATE firmware_job SET state = $2, updated_at = now() WHERE id = $1`, [job.id, status]);
  await completeFinishedCampaigns();
}

/**
 * After an install the charger reboots and sends BootNotification with its new
 * firmware version. That report — not the charger's own "Installed" — is what
 * marks the job Verified.
 */
export async function onBootFirmware(chargePointId: string, firmware: string | undefined) {
  if (!firmware) return;
  const job = await one<{ id: string; version: string }>(
    `SELECT j.id, i.version
       FROM firmware_job j JOIN firmware_campaign c ON c.id = j.campaign_id JOIN firmware_image i ON i.id = c.image_id
      WHERE j.charge_point_id = $1 AND j.state IN ('Installed','Installing','InstallRebooting','Downloaded','dispatched')
      ORDER BY j.dispatched_at DESC NULLS LAST LIMIT 1`,
    [chargePointId],
  );
  if (!job) return;
  if (firmware.trim() === job.version.trim()) {
    await query(`UPDATE firmware_job SET state = 'Verified', last_error = NULL, updated_at = now() WHERE id = $1`, [job.id]);
    await completeFinishedCampaigns();
  } else {
    await query(`UPDATE firmware_job SET last_error = $2, updated_at = now() WHERE id = $1`, [
      job.id,
      `booted with firmware ${firmware}, expected ${job.version}`,
    ]);
  }
}

export function logFirmwareHookError(e: unknown) {
  logger.warn({ err: (e as Error).message }, 'firmware status bookkeeping failed');
}
