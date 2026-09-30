import { deflateSync, inflateSync, crc32 } from 'node:zlib';

/**
 * Just enough PNG for app icons, with no image library: read an 8-bit,
 * non-interlaced PNG (greyscale, RGB, palette or with alpha), resize it, lay it
 * on a background, and write RGBA PNGs. An operator uploads one square icon; the
 * launcher, store and maskable sizes are made from it.
 */

export interface Rgba { width: number; height: number; data: Uint8Array /* RGBA, row-major */ }

export class PngError extends Error {}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf.subarray(0, 8).equals(SIG);
}

/** Width and height from the header only (cheap; for validation before decoding). */
export function pngSize(buf: Buffer): { width: number; height: number } {
  if (!isPng(buf) || buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') throw new PngError('not a PNG file');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function decodePng(buf: Buffer): Rgba {
  if (!isPng(buf)) throw new PngError('not a PNG file');
  let pos = 8;
  let width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (body.length !== len) throw new PngError('the PNG file is cut short');
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]!; ctype = body[9]!; interlace = body[12]!;
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || !height) throw new PngError('the PNG has no header');
  if (width * height > 4096 * 4096) throw new PngError('the image is too large');
  if (depth !== 8) throw new PngError(`only 8-bit PNGs are supported (this one is ${depth}-bit); export it again as 8-bit RGBA`);
  if (interlace) throw new PngError('interlaced PNGs are not supported; export it again without interlacing');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!channels) throw new PngError('unsupported PNG colour type');
  if (ctype === 3 && !palette) throw new PngError('the palette PNG has no palette');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new PngError('the PNG image data is incomplete');
  const px = new Uint8Array(height * stride);
  const bpp = channels;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= bpp ? px[out + x - bpp]! : 0;
      const b = y > 0 ? px[out - stride + x]! : 0;
      const c = x >= bpp && y > 0 ? px[out - stride + x - bpp]! : 0;
      let r: number;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new PngError('the PNG image data is corrupt');
      }
      px[out + x] = r & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    const s = i * channels;
    switch (ctype) {
      case 0: data[j] = data[j + 1] = data[j + 2] = px[s]!; data[j + 3] = 255; break;
      case 4: data[j] = data[j + 1] = data[j + 2] = px[s]!; data[j + 3] = px[s + 1]!; break;
      case 2: data[j] = px[s]!; data[j + 1] = px[s + 1]!; data[j + 2] = px[s + 2]!; data[j + 3] = 255; break;
      case 6: data[j] = px[s]!; data[j + 1] = px[s + 1]!; data[j + 2] = px[s + 2]!; data[j + 3] = px[s + 3]!; break;
      case 3: {
        const k = px[s]!;
        data[j] = palette![k * 3] ?? 0; data[j + 1] = palette![k * 3 + 1] ?? 0; data[j + 2] = palette![k * 3 + 2] ?? 0;
        data[j + 3] = trns && k < trns.length ? trns[k]! : 255;
        break;
      }
    }
  }
  return { width, height, data };
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const tb = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, body])) >>> 0);
  return Buffer.concat([len, tb, body, crc]);
}

/** RGBA → PNG (RGBA, or RGB when `opaque`: the App Store icon must have no alpha channel). */
export function encodePng(img: Rgba, opts: { opaque?: boolean } = {}): Buffer {
  const ch = opts.opaque ? 3 : 4;
  const stride = img.width * ch;
  const raw = Buffer.alloc(img.height * (stride + 1));
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4, d = y * (stride + 1) + 1 + x * ch;
      raw[d] = img.data[s]!; raw[d + 1] = img.data[s + 1]!; raw[d + 2] = img.data[s + 2]!;
      if (ch === 4) raw[d + 3] = img.data[s + 3]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0); ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; ihdr[9] = opts.opaque ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Resize to `w × h`: an area average when shrinking (sharp, no moiré), bilinear
 * when enlarging. Colour is averaged with alpha pre-multiplied, so transparent
 * edges do not turn dark.
 */
export function resize(img: Rgba, w: number, h: number): Rgba {
  const out = new Uint8Array(w * h * 4);
  const sx = img.width / w, sy = img.height / h;
  const at = (x: number, y: number, c: number) => img.data[(y * img.width + x) * 4 + c]!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      if (sx >= 1 && sy >= 1) {
        const x0 = x * sx, x1 = x0 + sx, y0 = y * sy, y1 = y0 + sy;
        for (let yy = Math.floor(y0); yy < Math.min(img.height, Math.ceil(y1)); yy++) {
          const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
          for (let xx = Math.floor(x0); xx < Math.min(img.width, Math.ceil(x1)); xx++) {
            const wgt = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0));
            const al = at(xx, yy, 3) / 255;
            r += at(xx, yy, 0) * al * wgt; g += at(xx, yy, 1) * al * wgt; b += at(xx, yy, 2) * al * wgt; a += al * wgt; wsum += wgt;
          }
        }
      } else {
        const fx = Math.max(0, Math.min(img.width - 1, (x + 0.5) * sx - 0.5));
        const fy = Math.max(0, Math.min(img.height - 1, (y + 0.5) * sy - 0.5));
        const xa = Math.floor(fx), ya = Math.floor(fy), xb = Math.min(img.width - 1, xa + 1), yb = Math.min(img.height - 1, ya + 1);
        for (const [xx, yy, wgt] of [[xa, ya, (1 - (fx - xa)) * (1 - (fy - ya))], [xb, ya, (fx - xa) * (1 - (fy - ya))], [xa, yb, (1 - (fx - xa)) * (fy - ya)], [xb, yb, (fx - xa) * (fy - ya)]] as Array<[number, number, number]>) {
          const al = at(xx, yy, 3) / 255;
          r += at(xx, yy, 0) * al * wgt; g += at(xx, yy, 1) * al * wgt; b += at(xx, yy, 2) * al * wgt; a += al * wgt; wsum += wgt;
        }
      }
      const o = (y * w + x) * 4;
      const alpha = wsum ? a / wsum : 0;
      out[o + 3] = Math.round(alpha * 255);
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * The icon on a square of `bg`, scaled to `scale` of the side and centred.
 * A maskable icon keeps its artwork inside the middle 80 % (the launcher's safe
 * zone); the App Store icon is the artwork on an opaque background.
 */
export function onBackground(img: Rgba, size: number, bg: [number, number, number], scale = 1): Rgba {
  const inner = Math.max(1, Math.round(size * scale));
  const art = resize(img, inner, inner);
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) { out[i * 4] = bg[0]; out[i * 4 + 1] = bg[1]; out[i * 4 + 2] = bg[2]; out[i * 4 + 3] = 255; }
  const off = Math.floor((size - inner) / 2);
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const s = (y * inner + x) * 4, d = ((y + off) * size + (x + off)) * 4;
      const a = art.data[s + 3]! / 255;
      for (let c = 0; c < 3; c++) out[d + c] = Math.round(art.data[s + c]! * a + out[d + c]! * (1 - a));
    }
  }
  return { width: size, height: size, data: out };
}

/** Share of fully transparent pixels in the corners: a launcher icon drawn as a circle or rounded square has many. */
export function transparentShare(img: Rgba): number {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! < 8) n++;
  return n / (img.width * img.height);
}
