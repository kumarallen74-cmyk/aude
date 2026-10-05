import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * The console and the driver app are plain browser JavaScript with no build step, so nothing
 * type-checks them. v1.7.0 shipped a Tariffs page that threw on every load: a helper wrapped the
 * module's `idrD` as `const idrD0 = idrD; const idrD = …` inside a function, and the inner const
 * shadowed the outer one for the whole function, so `idrD0 = idrD` read it before initialisation
 * ("Cannot access 'idrD' before initialization"). TypeScript finds exactly that class of bug in
 * JavaScript; this test runs it over every console module and the inline scripts of the driver
 * pages, and fails on use-before-declaration only (the code is not otherwise typed).
 */

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const TDZ = new Set([
  2448, // Block-scoped variable used before its declaration
  2449, // Class used before its declaration
  2450, // Enum used before its declaration
  2474, // const enum member used before declaration
  2729, // Property used before its initialization
]);

function files(): string[] {
  const web = here('../web/js/');
  const views = here('../web/js/views/');
  const out = [
    ...readdirSync(web).filter((f) => f.endsWith('.js')).map((f) => join(web, f)),
    ...readdirSync(views).filter((f) => f.endsWith('.js')).map((f) => join(views, f)),
  ];
  // Inline <script> blocks of the server-served pages, each as its own script.
  const dir = mkdtempSync(join(tmpdir(), 'web-scripts-'));
  for (const page of ['../driver-web/index.html', '../driver-web/paid.html', '../web/api-docs.html']) {
    const html = readFileSync(here(page), 'utf8');
    let i = 0;
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      if (!m[1]!.trim()) continue;
      const f = join(dir, `${page.replace(/[^a-z]+/gi, '_')}_${i++}.js`);
      writeFileSync(f, m[1]!);
      out.push(f);
    }
  }
  return out;
}

test('no browser script reads a let/const before its declaration (temporal dead zone)', () => {
  const list = files();
  assert.ok(list.length > 30, `found ${list.length} scripts`);
  const program = ts.createProgram(list, {
    allowJs: true, checkJs: true, noEmit: true, noResolve: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, noLib: true, // globals are irrelevant to declaration order
  });
  const found = ts.getPreEmitDiagnostics(program)
    .filter((d) => TDZ.has(d.code))
    .map((d) => {
      const pos = d.file && d.start != null ? d.file.getLineAndCharacterOfPosition(d.start) : null;
      return `${d.file?.fileName}:${pos ? pos.line + 1 : '?'} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    });
  assert.deepEqual(found, []);
});

test('the detector itself catches the v1.7.0 Tariffs bug', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-scripts-'));
  const f = join(dir, 'bad.js');
  writeFileSync(f, 'const idrD = (n, cur) => `${n} ${cur}`;\nexport function energySummary(t) {\n  const idrD0 = idrD;\n  const idrD = (n) => idrD0(n, t.currency);\n  return idrD(1);\n}\n');
  const program = ts.createProgram([f], { allowJs: true, checkJs: true, noEmit: true, noResolve: true, noLib: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext });
  assert.ok(ts.getPreEmitDiagnostics(program).some((d) => d.code === 2448));
});

/**
 * field(label, …) escapes its label, so markup in a label is shown to the operator as text (1.9.0-dev
 * showed "Budget (<span data-sym>Rp</span>)" on Promotions and Plans). A label with markup must say so
 * with { labelHtml: true }.
 */
function markupLabelsWithoutFlag(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const bad: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'field' && n.arguments.length) {
      const label = n.arguments[0]!;
      const text = ts.isStringLiteral(label) || ts.isNoSubstitutionTemplateLiteral(label) ? label.text
        : ts.isTemplateExpression(label) ? [label.head.text, ...label.templateSpans.map((s) => s.literal.text)].join('') : '';
      if (/<[a-z]/i.test(text)) {
        const opts = n.arguments[2];
        const flagged = !!opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) => ts.isPropertyAssignment(p)
          && ts.isIdentifier(p.name) && p.name.text === 'labelHtml' && p.initializer.kind === ts.SyntaxKind.TrueKeyword);
        if (!flagged) bad.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return bad;
}

test('a console form label with markup is passed as markup (labelHtml), not escaped onto the screen', () => {
  const views = here('../web/js/views/');
  const found = readdirSync(views).filter((f) => f.endsWith('.js'))
    .flatMap((f) => markupLabelsWithoutFlag(f, readFileSync(join(views, f), 'utf8')));
  assert.deepEqual(found, []);
  // the detector itself
  assert.deepEqual(markupLabelsWithoutFlag('x.js', "field(`Budget (<span data-sym>${s}</span>)`, '<input>', { opt: true });"), ['x.js:1']);
  assert.deepEqual(markupLabelsWithoutFlag('x.js', "field(`Budget (<span data-sym>${s}</span>)`, '<input>', { labelHtml: true });"), []);
  assert.deepEqual(markupLabelsWithoutFlag('x.js', "field('Budget (Rp)', '<input>');"), []);
});
