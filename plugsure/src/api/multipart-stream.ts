import { Transform, type TransformCallback, type Readable } from 'node:stream';

/**
 * Streaming extraction of the first file part of a multipart/form-data body.
 *
 * Charger diagnostics uploads (POST /diag/:token) used to be parsed with
 * `parseAs: 'buffer'` and a 200 MB body limit: every upload sat in memory in
 * full, twice over while the part was sliced out, and a handful of chargers
 * uploading at once could take the API container (1 GB limit) down. This
 * transform passes only the file's bytes through as they arrive, so the route
 * streams them to disk with saveStream(), which enforces the size cap while
 * streaming. Memory use is bounded by the part headers (64 KB) and one chunk.
 *
 * Minimal on purpose, like extractMultipartFile(): the first part with a
 * filename, no nested multiparts. Everything after that part is discarded.
 */

const MAX_HEADER_BYTES = 64 * 1024;

export class MultipartError extends Error {
  statusCode = 400;
}

export function boundaryOf(contentType: string): string | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return (m?.[1] ?? m?.[2])?.trim() || null;
}

export class MultipartFileStream extends Transform {
  /** The uploaded file's name, known once its part headers have been read. */
  fileName: string | null = null;
  private readonly delim: Buffer;
  /** `\r\n--boundary`: what ends the file part's data. */
  private readonly closing: Buffer;
  private state: 'preamble' | 'headers' | 'data' | 'done' = 'preamble';
  private buf: Buffer = Buffer.alloc(0);
  private total = 0;

  /**
   * @param maxTotalBytes  hard cap on the whole request body (file + framing),
   *                       so a body that never closes its part cannot stream forever.
   * @param onFileStart    called once, when the file part begins (its name is known).
   */
  constructor(boundary: string, private readonly maxTotalBytes: number, private readonly onFileStart?: (name: string) => void) {
    super();
    this.delim = Buffer.from(`--${boundary}`);
    this.closing = Buffer.from(`\r\n--${boundary}`);
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.total += chunk.length;
    if (this.total > this.maxTotalBytes) return cb(new MultipartError(`upload exceeds the ${Math.round(this.maxTotalBytes / 1024 / 1024)} MB limit`));
    if (this.state === 'done') return cb();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      this.drain();
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }

  private drain() {
    for (;;) {
      if (this.state === 'preamble') {
        // Find the next delimiter; a non-file part's body is skipped the same way.
        const at = this.buf.indexOf(this.delim);
        if (at < 0) {
          // Keep only what could be the start of a delimiter split across chunks.
          this.buf = this.buf.subarray(Math.max(0, this.buf.length - this.delim.length));
          return;
        }
        this.buf = this.buf.subarray(at + this.delim.length);
        this.state = 'headers';
      }
      if (this.state === 'headers') {
        const end = this.buf.indexOf('\r\n\r\n');
        if (end < 0) {
          if (this.buf.length > MAX_HEADER_BYTES) throw new MultipartError('multipart part headers are too large');
          return;
        }
        // The delimiter is followed by CRLF (or `--` for the closing one).
        const head = this.buf.subarray(0, end).toString('utf8');
        if (head.startsWith('--')) throw new MultipartError('no file in the multipart body');
        this.buf = this.buf.subarray(end + 4);
        if (/filename=/i.test(head)) {
          this.fileName = /filename="?([^";\r\n]+)"?/i.exec(head)?.[1] ?? 'diagnostics.log';
          this.state = 'data';
          this.onFileStart?.(this.fileName);
        } else {
          this.state = 'preamble';
          // The part body (a form field) runs to the next delimiter.
          continue;
        }
      }
      if (this.state === 'data') {
        const at = this.buf.indexOf(this.closing);
        if (at >= 0) {
          if (at > 0) this.push(this.buf.subarray(0, at));
          this.buf = Buffer.alloc(0);
          this.state = 'done';
          return;
        }
        // Everything except a possible partial `\r\n--boundary` at the tail is file data.
        const keep = this.closing.length - 1;
        if (this.buf.length > keep) {
          this.push(this.buf.subarray(0, this.buf.length - keep));
          this.buf = this.buf.subarray(this.buf.length - keep);
        }
        return;
      }
      return;
    }
  }

  override _flush(cb: TransformCallback) {
    if (this.state === 'done') return cb();
    cb(new MultipartError(this.state === 'data' ? 'the multipart body ended before the file part was closed' : 'no file in the multipart body'));
  }
}

/**
 * Pipe a request body through MultipartFileStream and resolve once the file part
 * has started (so the caller knows the file name), or reject when the body holds
 * no file. The returned stream yields the file's bytes only.
 */
export function streamMultipartFile(source: Readable, contentType: string, maxTotalBytes: number): Promise<MultipartFileStream> {
  return new Promise((resolve, reject) => {
    const boundary = boundaryOf(contentType);
    if (!boundary) return reject(new MultipartError('multipart body without a boundary'));
    let settled = false;
    const out = new MultipartFileStream(boundary, maxTotalBytes, () => {
      settled = true;
      resolve(out);
    });
    out.once('error', (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    source.once('error', (e) => out.destroy(e));
    /**
     * When the consumer gives up early (the size cap in saveStream, a body with no
     * file part), the request is left paused with unread bytes: its socket is
     * neither finished nor idle, so the client's close is never noticed and
     * `app.close()` waits for it forever. Read the rest and discard it — the 413 /
     * 400 still reaches the client on a healthy connection — but never more than
     * the cap again: past that the connection is cut.
     */
    out.once('close', () => {
      if (source.readableEnded || source.destroyed) return;
      source.unpipe(out);
      let discarded = 0;
      source.on('data', (c: Buffer) => {
        discarded += c.length;
        if (discarded > maxTotalBytes) source.destroy();
      });
      source.resume();
    });
    source.pipe(out);
  });
}
