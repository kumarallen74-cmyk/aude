import { deflateSync } from 'node:zlib';

/**
 * A small PDF writer for business documents (invoices, credit notes): A4 pages,
 * text in the standard Helvetica and Helvetica-Bold fonts (every PDF reader has
 * them, so nothing is embedded), lines and filled rectangles. No dependency.
 *
 * Coordinates are in points from the TOP-left corner (y grows downwards), which
 * is how a document is laid out; they are flipped when written. Text is encoded
 * as WinAnsi (Windows-1252): Indonesian and English text, "Rp", dashes, the
 * middle dot and × all print; anything else becomes "?".
 */

export type Rgb = [number, number, number];
export interface TextOpts { size?: number; bold?: boolean; color?: Rgb; align?: 'left' | 'right' | 'center' }

export const A4 = { width: 595.28, height: 841.89 };

// Advance widths (1/1000 em) of the standard fonts, characters 32–126 (Adobe AFM).
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
  556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELV_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889,
  611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
// WinAnsi bytes 0x80–0x9F that differ from Latin-1, and their widths.
const CP1252: Record<string, [number, number]> = {
  '€': [0x80, 556], '‚': [0x82, 222], '„': [0x84, 333], '…': [0x85, 1000], '‘': [0x91, 222], '’': [0x92, 222],
  '“': [0x93, 333], '”': [0x94, 333], '•': [0x95, 350], '–': [0x96, 556], '—': [0x97, 1000], '™': [0x99, 1000],
  // Not in WinAnsi, printed as the nearest glyph: the minus sign as an en dash, the arrow as ">".
  '−': [0x96, 556], '→': [0x3e, 584],
};
const LATIN1_WIDTH: Record<number, number> = { 0xa0: 278, 0xb7: 278, 0xd7: 584, 0xb0: 400, 0xa9: 737, 0xae: 737 };

/** The WinAnsi byte for a character and its width, or '?' when it cannot be printed. */
function glyph(ch: string, bold: boolean): [number, number] {
  const c = ch.codePointAt(0)!;
  if (c >= 32 && c <= 126) return [c, (bold ? HELV_BOLD : HELV)[c - 32]!];
  const w = CP1252[ch];
  if (w) return w;
  if (c >= 0xa0 && c <= 0xff) return [c, LATIN1_WIDTH[c] ?? 556];
  if (c === 0x2009 || c === 0x202f) return [32, 278]; // thin / narrow no-break space (Intl number formats)
  return [63, (bold ? HELV_BOLD : HELV)[63 - 32]!];
}

export function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of s) w += glyph(ch, bold)[1];
  return (w * size) / 1000;
}

/** A PDF literal string: WinAnsi bytes, with ( ) \ and non-ASCII escaped. */
function literal(s: string, bold: boolean): string {
  let out = '(';
  for (const ch of s) {
    const b = glyph(ch, bold)[0];
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out + ')';
}

/** A PDF text string for the document info (UTF-16BE with BOM). */
function infoString(s: string): string {
  const u = Buffer.from('﻿' + s, 'utf16le').swap16();
  return '<' + u.toString('hex') + '>';
}

const n = (x: number) => (Math.round(x * 100) / 100).toString();
const rgb = (c: Rgb) => c.map((v) => n(v)).join(' ');

/** Break text into lines no wider than `width` (at word boundaries; very long words are cut). */
export function wrapText(s: string, width: number, size: number, bold = false): string[] {
  const out: string[] = [];
  for (const para of String(s ?? '').split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= width) { line = next; continue; }
      if (line) out.push(line);
      line = word;
      while (textWidth(line, size, bold) > width) {
        let cut = line.length - 1;
        while (cut > 1 && textWidth(line.slice(0, cut), size, bold) > width) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

export class PdfDoc {
  readonly width = A4.width;
  readonly height = A4.height;
  private pages: string[][] = [];
  private ops!: string[];

  constructor(private meta: { title?: string; author?: string; subject?: string; created?: Date } = {}) {
    this.addPage();
  }

  addPage(): void {
    this.ops = [];
    this.pages.push(this.ops);
  }
  get pageCount(): number { return this.pages.length; }
  /** Draw on an earlier page (0-based), e.g. footers once the page count is known. */
  onPage(i: number): void { this.ops = this.pages[i]!; }

  text(x: number, y: number, s: string, o: TextOpts = {}): void {
    const size = o.size ?? 10;
    const bold = !!o.bold;
    const str = String(s ?? '');
    if (!str) return;
    const w = textWidth(str, size, bold);
    const left = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    this.ops.push(`BT ${rgb(o.color ?? [0.07, 0.07, 0.07])} rg /${bold ? 'F2' : 'F1'} ${n(size)} Tf ${n(left)} ${n(this.height - y)} Td ${literal(str, bold)} Tj ET`);
  }

  line(x1: number, y1: number, x2: number, y2: number, o: { width?: number; color?: Rgb } = {}): void {
    this.ops.push(`${rgb(o.color ?? [0.85, 0.87, 0.9])} RG ${n(o.width ?? 0.6)} w ${n(x1)} ${n(this.height - y1)} m ${n(x2)} ${n(this.height - y2)} l S`);
  }

  rect(x: number, y: number, w: number, h: number, o: { fill?: Rgb; stroke?: Rgb; width?: number } = {}): void {
    const r = `${n(x)} ${n(this.height - y - h)} ${n(w)} ${n(h)} re`;
    if (o.fill && o.stroke) this.ops.push(`${rgb(o.fill)} rg ${rgb(o.stroke)} RG ${n(o.width ?? 0.6)} w ${r} B`);
    else if (o.fill) this.ops.push(`${rgb(o.fill)} rg ${r} f`);
    else this.ops.push(`${rgb(o.stroke ?? [0.85, 0.87, 0.9])} RG ${n(o.width ?? 0.6)} w ${r} S`);
  }

  toBuffer(): Buffer {
    const objs: Array<string | Buffer> = [];
    const add = (o: string | Buffer) => { objs.push(o); return objs.length; };
    const catalog = add('');
    const pagesRef = add('');
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const d = this.meta.created ?? new Date();
    const stamp = `D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
    const info = add(`<< /Producer ${infoString('PlugSure CSMS')} /CreationDate (${stamp})${this.meta.title ? ` /Title ${infoString(this.meta.title)}` : ''}${this.meta.author ? ` /Author ${infoString(this.meta.author)}` : ''}${this.meta.subject ? ` /Subject ${infoString(this.meta.subject)}` : ''} >>`);
    const kids: number[] = [];
    for (const ops of this.pages) {
      const body = deflateSync(Buffer.from(ops.join('\n'), 'latin1'));
      const content = add(Buffer.concat([Buffer.from(`<< /Length ${body.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), body, Buffer.from('\nendstream', 'latin1')]));
      kids.push(add(`<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${n(this.width)} ${n(this.height)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesRef} 0 R >>`;
    objs[pagesRef - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

    const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0]!.length;
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(offset);
      const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), typeof o === 'string' ? Buffer.from(o, 'latin1') : o, Buffer.from('\nendobj\n', 'latin1')]);
      chunks.push(b);
      offset += b.length;
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(chunks);
  }
}

// ─────────────────────────────────────────── flowing layout (for documents)

export interface Column { label: string; width: number; align?: 'left' | 'right' }

/**
 * A top-to-bottom layout over PdfDoc with page breaks: a cursor `y`, margins,
 * paragraphs, key/value rows and tables whose header repeats on each new page.
 */
export class Flow {
  y: number;
  readonly left = 42;
  readonly right: number;
  readonly top = 48;
  readonly bottom: number;

  constructor(readonly doc: PdfDoc, private onNewPage?: (f: Flow) => void) {
    this.right = doc.width - 42;
    this.bottom = doc.height - 56;
    this.y = this.top;
  }
  get width(): number { return this.right - this.left; }

  /** Start a new page when fewer than `h` points are left. */
  need(h: number): void {
    if (this.y + h <= this.bottom) return;
    this.doc.addPage();
    this.y = this.top;
    this.onNewPage?.(this);
  }

  gap(h: number): void { this.y += h; }

  para(s: string, o: TextOpts & { width?: number; x?: number; lineGap?: number } = {}): void {
    const size = o.size ?? 9.5;
    const lh = size * (o.lineGap ?? 1.35);
    const x = o.x ?? this.left;
    for (const ln of wrapText(s, o.width ?? this.right - x, size, o.bold)) {
      this.need(lh);
      this.y += lh;
      this.doc.text(o.align === 'right' ? this.right : x, this.y - size * 0.3, ln, o);
    }
  }

  heading(s: string): void {
    this.need(34);
    this.y += 20;
    this.doc.text(this.left, this.y, s.toUpperCase(), { size: 8.5, bold: true, color: [0.22, 0.25, 0.32] });
    this.y += 6;
  }

  rule(o: { width?: number; color?: Rgb } = {}): void {
    this.doc.line(this.left, this.y, this.right, this.y, o);
  }

  /** Label on the left, amount on the right. */
  row(label: string, value: string, o: { bold?: boolean; size?: number; muted?: boolean; rule?: boolean } = {}): void {
    const size = o.size ?? 9.5;
    const lines = wrapText(label, this.width - textWidth(value, size, o.bold) - 24, size, o.bold);
    const h = lines.length * size * 1.35 + 6;
    this.need(h);
    const color: Rgb = o.muted ? [0.36, 0.39, 0.44] : [0.07, 0.07, 0.07];
    let yy = this.y;
    lines.forEach((ln, i) => {
      yy += size * 1.35;
      this.doc.text(this.left, yy, ln, { size, bold: o.bold, color });
      if (i === 0) this.doc.text(this.right, yy, value, { size, bold: o.bold, color, align: 'right' });
    });
    this.y += h;
    if (o.rule !== false) this.doc.line(this.left, this.y - 2, this.right, this.y - 2, { color: [0.92, 0.93, 0.95] });
  }

  /** A table; `widths` are fractions of the text width. Cells wrap; the header repeats after a page break. */
  table(cols: Column[], rows: Array<{ cells: string[]; bold?: boolean; sub?: string[] }>, o: { size?: number } = {}): void {
    const size = o.size ?? 8.5;
    const total = cols.reduce((a, c) => a + c.width, 0);
    const xs: number[] = [];
    let acc = this.left;
    const ws = cols.map((c) => (c.width / total) * this.width);
    for (const w of ws) { xs.push(acc); acc += w; }
    const header = () => {
      this.need(size * 2.4);
      this.y += size * 1.6;
      cols.forEach((c, i) => {
        const x = c.align === 'right' ? xs[i]! + ws[i]! - 3 : xs[i]! + 3;
        this.doc.text(x, this.y, c.label.toUpperCase(), { size: size - 1.5, bold: true, color: [0.36, 0.39, 0.44], align: c.align === 'right' ? 'right' : 'left' });
      });
      this.y += 5;
      this.rule({ color: [0.8, 0.82, 0.86] });
    };
    header();
    for (const r of rows) {
      const cellLines = r.cells.map((c, i) => wrapText(c ?? '', ws[i]! - 6, size, r.bold));
      const subLines = (r.sub ?? []).map((c, i) => (c ? wrapText(c, ws[i]! - 6, size - 1.5) : []));
      const lh = size * 1.3;
      const h = Math.max(...cellLines.map((l, i) => l.length * lh + (subLines[i]?.length ?? 0) * (lh - 1.5))) + 6;
      if (this.y + h > this.bottom) { this.doc.addPage(); this.y = this.top; this.onNewPage?.(this); header(); }
      cols.forEach((c, i) => {
        let yy = this.y + 2;
        for (const ln of cellLines[i]!) {
          yy += lh;
          const x = c.align === 'right' ? xs[i]! + ws[i]! - 3 : xs[i]! + 3;
          this.doc.text(x, yy, ln, { size, bold: r.bold, align: c.align === 'right' ? 'right' : 'left' });
        }
        for (const ln of subLines[i] ?? []) {
          yy += lh - 1.5;
          this.doc.text(xs[i]! + 3, yy, ln, { size: size - 1.5, color: [0.36, 0.39, 0.44] });
        }
      });
      this.y += h;
      this.doc.line(this.left, this.y, this.right, this.y, { color: [0.92, 0.93, 0.95] });
    }
  }
}
