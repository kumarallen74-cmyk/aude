import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { SPEC_FILE } from './generate.js';
import { tsType } from './sdk-ts.js';

/**
 * Backward compatibility with the v1.5.0 operator API (docs/COMPATIBILITY-v1.5-to-v1.9.md).
 *
 * fixtures/contract-v1.5.0.json.gz is the v1.5.0 OpenAPI document (src/web/openapi.json at v1.5.0) without its prose.
 * An integration built on it — by hand or with the v1.5.0 SDK — must keep working against this version, so the
 * published document must still contain every v1.5.0 operation, parameter, request field and response field (a
 * renamed amount under its v1.6 name, as a deprecated alias), must not require anything a v1.5.0 client does not
 * send, must not narrow a type or drop an enum value, and every webhook event must keep its fields.
 */

type Doc = { paths: Record<string, any>; webhooks: Record<string, any>; components: { schemas: Record<string, any> } };
const OLD: Doc = JSON.parse(gunzipSync(readFileSync(join(import.meta.dirname, 'fixtures', 'contract-v1.5.0.json.gz'))).toString('utf8'));
const NEW: Doc = JSON.parse(readFileSync(SPEC_FILE, 'utf8'));

interface Node { types: Set<string>; enums: Set<string>; required: Set<string> }

/** Every property path of a schema (arrays as `[]`), with its types, enum values and the keys it requires outright. */
function flatten(doc: Doc, schema: unknown, path = '', out = new Map<string, Node>(), depth = 0, alternative = false): Map<string, Node> {
  let s = schema as any;
  const seen = new Set<string>();
  while (s && typeof s.$ref === 'string' && !seen.has(s.$ref)) { seen.add(s.$ref); s = doc.components.schemas[s.$ref.split('/').pop()!]; }
  if (!s || typeof s !== 'object' || depth > 10) return out;
  const key = path || '.';
  const n = out.get(key) ?? { types: new Set<string>(), enums: new Set<string>(), required: new Set<string>() };
  out.set(key, n);
  for (const t of [s.type ?? []].flat()) n.types.add(String(t));
  for (const v of s.enum ?? []) n.enums.add(String(v));
  if ('const' in s) n.enums.add(String(s.const));
  if (!alternative) for (const r of s.required ?? []) n.required.add(r);
  for (const c of ['allOf', 'anyOf', 'oneOf'] as const) for (const x of s[c] ?? []) flatten(doc, x, path, out, depth + 1, alternative || c !== 'allOf');
  for (const [k, v] of Object.entries(s.properties ?? {})) flatten(doc, v, `${path}.${k}`, out, depth + 1, alternative);
  if (s.items) flatten(doc, s.items, `${path}[]`, out, depth + 1, alternative);
  return out;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const jsonSchema = (content: any) => content?.['application/json']?.schema;
const params = (item: any, op: any) => new Map<string, any>([...(item.parameters ?? []), ...(op.parameters ?? [])].map((p: any) => [`${p.in}:${p.name}`, p]));

describe('v1.5.0 operator API contract', () => {
  test('every v1.5.0 operation and parameter is still published, none newly required, no enum value dropped', () => {
    const problems: string[] = [];
    for (const [path, item] of Object.entries(OLD.paths)) {
      for (const m of METHODS) {
        const op = item[m];
        if (!op) continue;
        const now = NEW.paths[path]?.[m];
        if (!now) { problems.push(`${m.toUpperCase()} ${path} removed`); continue; }
        const before = params(item, op), after = params(NEW.paths[path], now);
        for (const [k, p] of before) {
          const q = after.get(k);
          if (!q) { problems.push(`${m.toUpperCase()} ${path}: parameter ${k} removed`); continue; }
          const lost = [...(flatten(OLD, p.schema).get('.')?.enums ?? [])].filter((v) => { const e = flatten(NEW, q.schema).get('.')?.enums; return e?.size && !e.has(v); });
          if (lost.length) problems.push(`${m.toUpperCase()} ${path}: parameter ${k} lost values ${lost}`);
        }
        for (const [k, q] of after) if (q.required && !before.get(k)?.required) problems.push(`${m.toUpperCase()} ${path}: parameter ${k} newly required`);
      }
    }
    assert.deepEqual(problems, []);
  });

  test('request bodies: every v1.5.0 field is accepted and nothing new is required (a renamed amount may be sent under its v1.6 name)', () => {
    const problems: string[] = [];
    for (const [path, item] of Object.entries(OLD.paths)) {
      for (const m of METHODS) {
        const old = jsonSchema(item[m]?.requestBody?.content);
        const now = jsonSchema(NEW.paths[path]?.[m]?.requestBody?.content);
        if (!old || !now) continue;
        const a = flatten(OLD, old), b = flatten(NEW, now);
        for (const [p, n] of a) {
          const c = b.get(p);
          if (!c) { problems.push(`${m.toUpperCase()} ${path}: request field ${p} no longer accepted`); continue; }
          const lost = [...n.enums].filter((v) => c.enums.size && !c.enums.has(v));
          if (lost.length) problems.push(`${m.toUpperCase()} ${path}: request ${p} lost values ${lost}`);
          const added = [...c.required].filter((r) => !n.required.has(r));
          if (added.length) problems.push(`${m.toUpperCase()} ${path}: request ${p} newly requires ${added}`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  test('responses: every v1.5.0 field of a 2xx answer is still there, no type narrowed, no enum value dropped', () => {
    const problems: string[] = [];
    for (const [path, item] of Object.entries(OLD.paths)) {
      for (const m of METHODS) {
        for (const [code, r] of Object.entries<any>(item[m]?.responses ?? {})) {
          if (!code.startsWith('2')) continue;
          const old = jsonSchema(r.content);
          const now = jsonSchema(NEW.paths[path]?.[m]?.responses?.[code]?.content);
          if (!old) continue;
          if (!now) { problems.push(`${m.toUpperCase()} ${path} ${code}: no JSON answer any more`); continue; }
          const a = flatten(OLD, old), b = flatten(NEW, now);
          for (const [p, n] of a) {
            const c = b.get(p);
            if (!c) { problems.push(`${m.toUpperCase()} ${path} ${code}: response field ${p} removed`); continue; }
            const narrowed = [...n.types].filter((t) => t !== 'null' && c.types.size && !c.types.has(t) && !(t === 'integer' && c.types.has('number')));
            if (narrowed.length) problems.push(`${m.toUpperCase()} ${path} ${code}: ${p} no longer ${narrowed}`);
            const lost = [...n.enums].filter((v) => c.enums.size && !c.enums.has(v));
            if (lost.length) problems.push(`${m.toUpperCase()} ${path} ${code}: ${p} lost values ${lost}`);
          }
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  test('webhooks: every v1.5.0 event is still sent with every field it had', () => {
    const problems: string[] = [];
    for (const [type, w] of Object.entries<any>(OLD.webhooks)) {
      const now = NEW.webhooks[type];
      if (!now) { problems.push(`${type} removed`); continue; }
      const a = flatten(OLD, jsonSchema(w.post.requestBody.content)), b = flatten(NEW, jsonSchema(now.post.requestBody.content));
      for (const p of a.keys()) if (!b.has(p)) problems.push(`${type}: ${p} removed`);
      for (const h of w.post.parameters ?? []) if (!(now.post.parameters ?? []).some((x: any) => x.in === h.in && x.name === h.name)) problems.push(`${type}: header ${h.name} removed`);
    }
    assert.deepEqual(problems, []);
  });

  test('a v1.5.0 request with the rupiah names fits the published body (QRIS checkout, loyalty, credit-note lines)', () => {
    const qris = jsonSchema(NEW.paths['/v1/checkout/qris'].post.requestBody.content);
    assert.ok(!qris.required.includes('amountMinor') && qris.properties.amountIdr && qris.properties.amountMinor);
    assert.deepEqual(qris.anyOf, [{ required: ['amountMinor'] }, { required: ['amountIdr'] }]);
    const loyalty = jsonSchema(NEW.paths['/v1/loyalty'].put.requestBody.content);
    assert.equal(loyalty.$ref, undefined, 'inlined, so the response component keeps its required list');
    assert.ok(!(loyalty.required ?? []).includes('pointValueMinor'));
    assert.ok(NEW.components.schemas.LoyaltyProgram.required.includes('pointValueMinor'), 'responses still promise the new name');
    // The SDK types such a body as the object it is (both names optional), not as unknown.
    const t = tsType(qris);
    assert.match(t, /amountMinor\?: number/);
    assert.match(t, /amountIdr\?: number/);
    assert.match(t, /ocppIdentity: string/);
  });

  test('hub operations say they answer 404 while PlugSure Hub is off (the default)', () => {
    const hub = NEW.paths['/v1/roaming/hub'].get;
    assert.ok(hub.responses['404']);
    assert.match(hub.description, /HUB_ENABLED=true/);
  });
});
