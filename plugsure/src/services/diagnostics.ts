import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { one, many, query } from '../db/pool.js';
import { bus } from './events.js';
import * as commands from '../ocpp/commands.js';
import type { Actor } from '../ocpp/commands.js';
import { newRequestId } from '../ocpp/translate201.js';
import { newToken, publicUrl } from './storage.js';

/**
 * Remote diagnostic log retrieval (SPEC Module 9.2).
 *
 * GetDiagnostics tells a charger to upload its logs to a location. The operator
 * may give their own server (FTP/HTTPS), or leave it blank to use PlugSure's
 * built-in receiver: a one-time, unguessable URL on this deployment that accepts
 * one upload and stores it for the log viewer. The DiagnosticsStatusNotification
 * (1.6) / LogStatusNotification (2.0.1) the charger sends back drives the status.
 */

export async function requestDiagnostics(args: {
  orgId: string;
  chargePointId: string;
  identity: string;
  startTime?: string | null;
  stopTime?: string | null;
  location?: string | null;
  origin?: string;
  actor: Actor;
  requestedBy: string;
}) {
  const custom = args.location?.trim();
  if (custom && !/^(ftp|ftps|sftp|https?):\/\//i.test(custom)) {
    return { ok: false as const, error: 'Upload location must be an ftp://, ftps://, sftp:// or http(s):// URL' };
  }
  const token = custom ? null : newToken();
  const location = custom || publicUrl(`/diag/${token}`, args.origin);
  if (!/^[a-z]+:\/\//i.test(location)) {
    return {
      ok: false as const,
      error: 'Set PUBLIC_BASE_URL (the HTTPS address chargers can reach) to use the built-in log receiver, or give an upload location.',
    };
  }
  const requestId = newRequestId();
  const row = await one<{ id: string }>(
    `INSERT INTO diagnostics_request (org_id, charge_point_id, request_id, start_time, stop_time, location, upload_token, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [args.orgId, args.chargePointId, requestId, args.startTime || null, args.stopTime || null, location, token, args.requestedBy],
  );
  try {
    const r = await commands.getDiagnostics(args.identity, location, args.actor, {
      startTime: args.startTime ? new Date(args.startTime).toISOString() : undefined,
      stopTime: args.stopTime ? new Date(args.stopTime).toISOString() : undefined,
      retries: 2,
      retryInterval: 60,
      requestId,
    });
    const rejected = r?.status && r.status !== 'Accepted' && r.status !== 'AcceptedCanceled';
    await query(
      `UPDATE diagnostics_request SET file_name = $2, status = $3, updated_at = now() WHERE id = $1`,
      [row!.id, r?.fileName ?? null, rejected ? 'Rejected' : 'Requested'],
    );
    if (rejected) return { ok: false as const, id: row!.id, error: `the charger answered ${r?.status}` };
    return { ok: true as const, id: row!.id, fileName: r?.fileName ?? null, location };
  } catch (e) {
    await query(`UPDATE diagnostics_request SET status = 'Rejected', updated_at = now() WHERE id = $1`, [row!.id]);
    return { ok: false as const, id: row!.id, error: (e as Error).message };
  }
}

export async function listDiagnostics(orgId: string, chargePointId?: string) {
  return many(
    `SELECT d.id, d.status, d.start_time, d.stop_time, d.location, d.file_name, d.size_bytes, d.requested_by,
            d.requested_at, d.updated_at, (d.storage_path IS NOT NULL) AS has_file, (d.upload_token IS NOT NULL) AS builtin,
            cp.ocpp_identity
       FROM diagnostics_request d JOIN charge_point cp ON cp.id = d.charge_point_id
      WHERE d.org_id = $1 AND ($2::uuid IS NULL OR d.charge_point_id = $2)
      ORDER BY d.requested_at DESC LIMIT 100`,
    [orgId, chargePointId ?? null],
  );
}

/** Map both protocol versions' upload status vocabularies onto one. */
export function normaliseDiagStatus(s: string): string {
  switch (s) {
    case 'Uploaded':
      return 'Uploaded';
    case 'Uploading':
      return 'Uploading';
    case 'UploadFailed':
    case 'UploadFailure':
    case 'BadMessage':
    case 'PermissionDenied':
    case 'NotSupportedOperation':
      return 'UploadFailed';
    default:
      return 'Idle';
  }
}

export async function onDiagnosticsStatus(chargePointId: string, ocppIdentity: string, orgId: string, status: string) {
  const req = await one<{ id: string; status: string; storage_path: string | null }>(
    `SELECT id, status, storage_path FROM diagnostics_request
      WHERE charge_point_id = $1 AND status IN ('Requested','Uploading')
      ORDER BY requested_at DESC LIMIT 1`,
    [chargePointId],
  );
  const s = normaliseDiagStatus(status);
  bus.emit('diagnostics.status', { orgId, ocppIdentity, status: s, requestId: req?.id ?? null });
  if (!req || s === 'Idle') return;
  // The built-in receiver may already have stored the file; do not regress that.
  if (req.storage_path && s !== 'UploadFailed') return;
  await query(`UPDATE diagnostics_request SET status = $2, updated_at = now() WHERE id = $1`, [req.id, s]);
}

export async function diagnosticsByToken(token: string) {
  return one<{ id: string; org_id: string; storage_path: string | null; status: string }>(
    `SELECT id, org_id, storage_path, status FROM diagnostics_request WHERE upload_token = $1`,
    [token],
  );
}

export async function recordUpload(id: string, path: string, size: number, fileName: string) {
  await query(
    `UPDATE diagnostics_request SET storage_path = $2, size_bytes = $3, file_name = COALESCE(file_name, $4),
            status = 'Uploaded', updated_at = now() WHERE id = $1`,
    [id, path, size, fileName],
  );
}

/**
 * Pull the first file out of a multipart/form-data body. Chargers that upload
 * over HTTP mostly POST a form; a few PUT the raw file. Minimal on purpose: one
 * file part, no nested multiparts.
 */
export function extractMultipartFile(body: Buffer, contentType: string): { name: string; data: Buffer } | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary) return null;
  const delim = Buffer.from(`--${boundary}`);
  let pos = body.indexOf(delim);
  while (pos >= 0) {
    const headerStart = pos + delim.length + 2; // skip CRLF
    const headerEnd = body.indexOf('\r\n\r\n', headerStart);
    if (headerEnd < 0) return null;
    const headers = body.subarray(headerStart, headerEnd).toString('utf8');
    const next = body.indexOf(delim, headerEnd + 4);
    if (next < 0) return null;
    if (/filename=/i.test(headers)) {
      const name = /filename="?([^";\r\n]+)"?/i.exec(headers)?.[1] ?? 'diagnostics.log';
      return { name, data: body.subarray(headerEnd + 4, next - 2) }; // strip trailing CRLF
    }
    pos = next;
  }
  return null;
}

/**
 * Contents for the embedded log viewer. Gzip is unpacked; other archives are
 * reported as binary with a download link, since tar/zip need a library we do
 * not ship.
 */
export async function logContent(path: string, maxBytes = 2 * 1024 * 1024) {
  let buf: Buffer = await readFile(path);
  let note: string | null = null;
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = gunzipSync(buf, { maxOutputLength: 64 * 1024 * 1024 });
      note = 'decompressed from gzip';
    } catch {
      return { binary: true, text: null, note: 'gzip archive could not be decompressed' };
    }
  }
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    return { binary: true, text: null, note: 'ZIP archive — download it to inspect' };
  }
  // Heuristic: more than 5% control bytes in the first 8 KB = binary.
  const sample = buf.subarray(0, 8192);
  let ctl = 0;
  for (const b of sample) if (b < 9 || (b > 13 && b < 32)) ctl++;
  if (sample.length && ctl / sample.length > 0.05) {
    // A tar file is mostly text with NUL padding; show the text parts anyway.
    if (buf.length > 262 && buf.subarray(257, 262).toString() === 'ustar') {
      const text = buf.toString('latin1').replace(/\0+/g, '\n').slice(0, maxBytes);
      return { binary: false, text, truncated: buf.length > maxBytes, note: 'tar archive — members shown concatenated' };
    }
    return { binary: true, text: null, note: 'binary file — download it to inspect' };
  }
  return {
    binary: false,
    text: buf.subarray(0, maxBytes).toString('utf8'),
    truncated: buf.length > maxBytes,
    note,
  };
}
