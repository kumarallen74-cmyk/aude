import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

import { PdfDoc, Flow, textWidth, wrapText } from './pdf.js';

/** Every object's offset in the xref table points at "<n> 0 obj"; returns the decoded page streams. */
function inspectPdf(buf: Buffer): { pages: number; streams: string[]; info: string } {
  const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4\n'), 'header');
  assert.ok(s.trimEnd().endsWith('%%EOF'), 'trailer');
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(s)![1]);
  assert.equal(s.slice(startxref, startxref + 4), 'xref', 'startxref points at the xref table');
  const m = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(s)!;
  const entries = m[2]!.trim().split('\n').slice(1);
  assert.equal(entries.length, Number(m[1]) - 1);
  entries.forEach((e, i) => {
    const off = Number(e.slice(0, 10));
    assert.equal(s.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `object ${i + 1} at its xref offset`);
  });
  const streams: string[] = [];
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(s))) {
    const start = r.index + r[0].length;
    streams.push(inflateSync(buf.subarray(start, start + Number(r[1]))).toString('latin1'));
  }
  const pages = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s)![1]);
  return { pages, streams, info: /\/Producer [^\n]*/.exec(s)?.[0] ?? '' };
}

/** The text shown on a page, in drawing order (literal strings, octal escapes decoded to WinAnsi). */
function pageText(stream: string): string {
  const out: string[] = [];
  for (const m of stream.matchAll(/\(((?:[^()\\]|\\.)*)\) Tj/g)) {
    out.push(m[1]!.replace(/\\([0-7]{3}|.)/g, (_x, e: string) => (e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : e)));
  }
  return out.join('\n');
}

describe('PDF writer', () => {
  test('a valid file: header, objects at their xref offsets, trailer, info', () => {
    const d = new PdfDoc({ title: 'Invoice FLT/2026/08/0001', created: new Date('2026-09-28T01:00:00Z') });
    d.text(40, 60, 'Hello (world) \\ Rp 1.234.567 — PT Maju · 2×', { size: 12, bold: true });
    d.line(40, 70, 200, 70);
    d.rect(40, 80, 100, 20, { fill: [0.9, 0.9, 0.9] });
    const buf = d.toBuffer();
    const p = inspectPdf(buf);
    assert.equal(p.pages, 1);
    const txt = pageText(p.streams[0]!);
    assert.equal(txt, 'Hello (world) \\ Rp 1.234.567 \x97 PT Maju \xb7 2\xd7');
    assert.match(buf.toString('latin1'), /\/CreationDate \(D:20260928010000Z\)/);
    assert.match(buf.toString('latin1'), /\/Title <feff/);
  });

  test('characters outside WinAnsi print as ?', () => {
    const d = new PdfDoc();
    d.text(10, 10, 'OK 中 ✓');
    assert.equal(pageText(inspectPdf(d.toBuffer()).streams[0]!), 'OK ? ?');
  });

  test('widths: digits are 556/1000 em, bold wider, right alignment ends at x', () => {
    assert.equal(textWidth('1234567890', 10), 55.6);
    assert.ok(textWidth('Invoice', 10, true) > textWidth('Invoice', 10));
    const d = new PdfDoc();
    d.text(500, 100, '1.000', { align: 'right', size: 10 });
    const m = /([\d.]+) ([\d.]+) Td/.exec(inspectPdf(d.toBuffer()).streams[0]!)!;
    assert.equal(Math.round((Number(m[1]) + textWidth('1.000', 10)) * 100) / 100, 500);
  });

  test('wrapping keeps each line within the width; long words are cut', () => {
    const lines = wrapText('Pengisian listrik kendaraan listrik (SPKLU) Grand Indonesia — Agustus 2026 — 12 sesi', 150, 9);
    assert.ok(lines.length > 1);
    for (const l of lines) assert.ok(textWidth(l, 9) <= 150, l);
    const cut = wrapText('X'.repeat(80), 60, 10);
    assert.ok(cut.length > 1 && cut.every((l) => textWidth(l, 10) <= 60));
    assert.deepEqual(wrapText('a\nb', 100, 10), ['a', 'b']);
  });

  test('a long table breaks onto new pages and repeats its header', () => {
    const d = new PdfDoc();
    let pagesStarted = 0;
    const f = new Flow(d, () => { pagesStarted++; });
    f.table([{ label: 'Card', width: 2 }, { label: 'Amount', width: 1, align: 'right' }],
      Array.from({ length: 120 }, (_, i) => ({ cells: [`CARD-${i}`, `Rp ${i * 1000}`] })));
    const p = inspectPdf(d.toBuffer());
    assert.ok(p.pages >= 3 && pagesStarted === p.pages - 1, `pages ${p.pages}`);
    for (const s of p.streams) assert.match(pageText(s), /^CARD\nAMOUNT/);
    assert.match(pageText(p.streams.at(-1)!), /CARD-119/);
  });
});
