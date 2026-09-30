import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { config } from '../config.js';

/**
 * Local file storage for uploaded firmware images and retrieved diagnostic logs.
 *
 * Deliberately simple: one directory tree under STORAGE_DIR, file names that are
 * generated (never taken from the uploader), and a hard size cap enforced while
 * streaming so an oversized upload never fills the disk. Mount STORAGE_DIR on a
 * persistent volume in production (see deploy/README.md).
 */

export type Bucket = 'firmware' | 'diagnostics';

export function bucketDir(bucket: Bucket): string {
  return resolve(config.storage.dir, bucket);
}

/** A file name safe for a URL path segment and a filesystem, derived from user input. */
export function safeFileName(name: string | undefined, fallback: string): string {
  const cleaned = String(name ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export class TooLargeError extends Error {
  statusCode = 413;
}

/**
 * Stream `source` into the bucket, hashing as it goes. Rejects (and deletes the
 * partial file) when the stream exceeds `maxBytes`.
 */
export async function saveStream(
  bucket: Bucket,
  fileName: string,
  source: Readable,
  maxBytes: number,
): Promise<{ path: string; size: number; sha256: string }> {
  const dir = bucketDir(bucket);
  await mkdir(dir, { recursive: true });
  // Sanitise here too: a caller passing a raw uploader-supplied name ("../../x")
  // must not be able to write outside the bucket.
  const path = join(dir, `${Date.now()}-${randomBytes(6).toString('hex')}-${safeFileName(fileName, 'upload.bin')}`);
  const hash = createHash('sha256');
  let size = 0;

  await new Promise<void>((resolvePromise, reject) => {
    const out = createWriteStream(path, { flags: 'wx' });
    const fail = (e: Error) => {
      source.unpipe?.(out);
      out.destroy();
      reject(e);
    };
    source.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(new TooLargeError(`file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`));
        source.destroy?.();
        return;
      }
      hash.update(chunk);
    });
    source.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => resolvePromise());
    source.pipe(out);
  }).catch(async (e) => {
    await rm(path, { force: true }).catch(() => {});
    throw e;
  });

  return { path, size, sha256: hash.digest('hex') };
}

export async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/** Build a public URL for a charger to use. */
export function publicUrl(pathname: string, requestOrigin?: string): string {
  const base = config.console.publicBaseUrl || requestOrigin || '';
  return `${base}${pathname}`;
}
