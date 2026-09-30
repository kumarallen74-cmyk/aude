import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { allOps, buildSpec, routeKey, toOpenApiPath } from './build.js';
import { findRoutes, permissionsByRoute } from './extract.js';
import { specText, SPEC_FILE } from './generate.js';
import { TAGS } from './types.js';

/**
 * The published API document must describe the API that exists:
 *   - every /v1 route has exactly one catalogue entry, and every entry a route;
 *   - the committed src/web/openapi.json is what the catalogue generates;
 *   - it is a structurally sound OpenAPI 3.1 document whose schemas compile.
 * (tools/e2e/api-sandbox-e2e.mts then checks live responses against it.)
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SRC = join(ROOT, 'src');

describe('OpenAPI document', () => {
  const ops = allOps();
  const found = findRoutes(SRC);

  test('every registered /v1 route is in the catalogue, and nothing else is', () => {
    const catalogue = new Set(ops.map((o) => routeKey(o.method, o.path)));
    const dupes = ops.map((o) => routeKey(o.method, o.path)).filter((k, i, a) => a.indexOf(k) !== i);
    assert.deepEqual(dupes, [], 'catalogue entries listed twice');
    const literal = found.filter((r) => !r.template).map((r) => routeKey(r.method, r.path));
    const missing = literal.filter((k) => !catalogue.has(k));
    assert.deepEqual(missing, [], 'routes without a catalogue entry');
    // Template routes (one handler for several paths) must be covered by at least one entry each.
    for (const t of found.filter((r) => r.template)) {
      const rx = new RegExp('^' + t.path.split(/\$\{[^}]+\}/).map((s) => s.replace(/[.*+?^()|[\]\\]/g, '\\$&')).join('[^/]+') + '$');
      assert.ok(ops.some((o) => o.method === t.method && rx.test(o.path)), `no catalogue entry for ${t.method} ${t.path}`);
    }
    const all = new Set(literal);
    const orphans = ops
      .filter((o) => !all.has(routeKey(o.method, o.path)))
      .filter((o) => !found.some((t) => t.template && t.method === o.method &&
        new RegExp('^' + t.path.split(/\$\{[^}]+\}/).map((s) => s.replace(/[.*+?^()|[\]\\]/g, '\\$&')).join('[^/]+') + '$').test(o.path)))
      .map((o) => routeKey(o.method, o.path));
    assert.deepEqual(orphans, [], 'catalogue entries with no route');
  });

  test('the running API registers exactly the documented /v1 routes', async (t) => {
    let registered: Array<{ method: string; url: string }>;
    try {
      const server = await import('../server.js');
      const app = await server.buildApi();
      await app.ready();
      registered = server.registeredRoutes;
      await app.close();
    } catch (e) {
      t.skip(`API could not be built here (${(e as Error).message})`);
      return;
    }
    const catalogue = new Set(ops.map((o) => routeKey(o.method, o.path)));
    const live = [...new Set(registered.filter((r) => r.url.startsWith('/v1') && r.method !== 'HEAD').map((r) => routeKey(r.method, r.url)))];
    assert.deepEqual(live.filter((k) => !catalogue.has(k)), [], 'registered but undocumented');
    assert.deepEqual([...catalogue].filter((k) => !live.includes(k)), [], 'documented but not registered');
  });

  test('the committed openapi.json is up to date (run npm run openapi)', () => {
    assert.equal(readFileSync(join(ROOT, SPEC_FILE), 'utf8'), specText(ROOT));
  });

  test('structure: unique operation ids, declared path parameters, known tags, resolvable refs', () => {
    const spec = buildSpec({ version: 'test', permissions: permissionsByRoute(SRC, ops), includeInternal: true });
    const ids = new Set<string>();
    for (const [p, item] of Object.entries(spec.paths as Record<string, Record<string, any>>)) {
      const inPath = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      for (const op of Object.values(item)) {
        assert.ok(!ids.has(op.operationId), `duplicate operationId ${op.operationId}`);
        ids.add(op.operationId);
        const declared = (op.parameters ?? []).filter((x: any) => x.in === 'path').map((x: any) => x.name);
        assert.deepEqual(declared.sort(), [...inPath].sort(), `path parameters of ${p}`);
        assert.ok((TAGS as readonly string[]).includes(op.tags[0]), `unknown tag ${op.tags[0]}`);
        assert.ok(op.summary && op.summary.length <= 80, `summary of ${p}`);
      }
    }
    const text = JSON.stringify(spec);
    for (const m of text.matchAll(/"\$ref":"#\/components\/(schemas|responses)\/([^"]+)"/g)) {
      assert.ok(spec.components[m[1]!][m[2]!], `unresolved $ref ${m[1]}/${m[2]}`);
    }
  });

  test('every schema compiles (JSON Schema 2020-12)', () => {
    const spec = JSON.parse(readFileSync(join(ROOT, SPEC_FILE), 'utf8'));
    const ajv = new (Ajv2020 as any)({ strict: false, allErrors: true });
    (addFormats as any)(ajv);
    ajv.addFormat('binary', true);
    ajv.addSchema({ $id: 'spec', components: spec.components });
    const each = (s: unknown, where: string) => {
      const withRefs = JSON.parse(JSON.stringify(s).replace(/"#\/components\//g, '"spec#/components/'));
      assert.doesNotThrow(() => ajv.compile(withRefs), where);
    };
    for (const [p, item] of Object.entries(spec.paths as Record<string, Record<string, any>>)) {
      for (const [m, op] of Object.entries(item)) {
        for (const [code, r] of Object.entries(op.responses as Record<string, any>)) {
          for (const c of Object.values((r.content ?? {}) as Record<string, any>)) each(c.schema, `${m} ${p} ${code}`);
        }
        for (const c of Object.values((op.requestBody?.content ?? {}) as Record<string, any>)) each(c.schema, `${m} ${p} body`);
        for (const q of op.parameters ?? []) each(q.schema, `${m} ${p} ${q.name}`);
      }
    }
  });

  test('internal routes stay out; public routes carry their permissions', () => {
    const spec = JSON.parse(readFileSync(join(ROOT, SPEC_FILE), 'utf8'));
    assert.equal(spec.openapi, '3.1.0');
    assert.ok(!spec.paths['/v1/auth/login'], 'console sign-in is not part of the public API');
    assert.ok(!Object.keys(spec.paths).some((p) => p.startsWith('/v1/platform/')), 'platform administration is internal');
    assert.deepEqual(spec.paths[toOpenApiPath('/v1/charge-points')].get['x-permissions'], ['charge_point:read']);
    assert.ok(spec.paths['/v1/sandbox/chargers/{identity}/simulate'].post, 'sandbox simulation is documented');
    assert.ok(spec.webhooks['session.started'], 'webhook events are documented');
  });
});
