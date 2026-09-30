/**
 * The TypeScript SDK's generated half (sdk/typescript/src/generated.ts), written
 * from the published OpenAPI document: one interface per component schema, one
 * type per webhook event, and one method per operation, named by its operationId.
 *
 * Deterministic (same document, same text) so a test can hold the committed
 * file to the document, as spec.test.ts does for openapi.json itself.
 */

type Schema = Record<string, any>;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const prop = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
const refName = (ref: string) => typeName(ref.split('/').pop()!);
export const typeName = (n: string) => {
  const s = n.replace(/[^A-Za-z0-9_$]/g, '_');
  return /^[0-9]/.test(s) ? `_${s}` : s;
};

/** A JSDoc block, or nothing. `*\/` inside the text cannot end the comment early. */
function doc(text: string | undefined, indent: string, extra: string[] = []): string {
  const lines = [...(text ? text.trim().split('\n') : []), ...extra].map((l) => l.replace(/\*\//g, '*\\/').trimEnd());
  if (!lines.length) return '';
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((l) => `${indent} *${l ? ` ${l}` : ''}`).join('\n')}\n${indent} */\n`;
}

const paren = (t: string) => (/[|&]/.test(t) && !/^\(.*\)$/.test(t) && !/^\{[\s\S]*\}$/.test(t) ? `(${t})` : t);
const union = (ts: string[]) => {
  const u = [...new Set(ts)];
  return u.includes('unknown') ? 'unknown' : u.join(' | ');
};

/** A JSON Schema (2020-12, as the document uses it) as a TypeScript type. */
export function tsType(s: Schema | undefined | boolean, indent = ''): string {
  if (s === undefined || s === true || s === null) return 'unknown';
  if (s === false) return 'never';
  if (s.$ref) return refName(s.$ref);
  if ('const' in s) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return union(s.enum.map((v: unknown) => JSON.stringify(v)));
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) return union((s.anyOf ?? s.oneOf).map((x: Schema) => paren(tsType(x, indent))));
  if (Array.isArray(s.allOf)) {
    const parts = s.allOf.map((x: Schema) => paren(tsType(x, indent))).filter((t: string) => t !== 'unknown');
    return parts.length ? parts.join(' & ') : 'unknown';
  }
  if (Array.isArray(s.type)) return union(s.type.map((t: string) => paren(tsType({ ...s, type: t }, indent))));
  switch (s.type) {
    case 'string': return s.format === 'binary' ? 'Blob' : 'string';
    case 'integer':
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': return `${paren(tsType(s.items, indent))}[]`;
    case 'object': return objectType(s, indent);
    default:
      if (s.properties) return objectType(s, indent);
      return 'unknown';
  }
}

function objectType(s: Schema, indent: string): string {
  const props = Object.entries((s.properties ?? {}) as Record<string, Schema>);
  const addl = s.additionalProperties;
  if (!props.length) {
    if (addl && typeof addl === 'object') return `Record<string, ${tsType(addl, indent)}>`;
    return 'Record<string, unknown>';
  }
  const req = new Set<string>(s.required ?? []);
  const inner = `${indent}  `;
  const lines = props.map(([k, v]) => `${doc(v?.description, inner)}${inner}${prop(k)}${req.has(k) ? '' : '?'}: ${tsType(v, inner)};`);
  // Named properties plus a map of others: the others are not typed further (TypeScript
  // requires every named property to fit the index signature).
  if (addl && typeof addl === 'object') lines.push(`${inner}[key: string]: unknown;`);
  return `{\n${lines.join('\n')}\n${indent}}`;
}

// ─────────────────────────────────────────────── operations

const BINARY_TYPES = /^(application\/(pdf|octet-stream|zip|gzip)|image\/)/;
type Accept = 'json' | 'text' | 'binary' | 'stream' | 'none';

function responseOf(op: Schema): { type: string; accept: Accept } {
  const ok = Object.entries((op.responses ?? {}) as Record<string, Schema>).filter(([c]) => /^2/.test(c)).sort(([a], [b]) => a.localeCompare(b));
  for (const [, r] of ok) {
    const content = (r.content ?? {}) as Record<string, Schema>;
    const types = Object.keys(content);
    if (!types.length) continue;
    const json = types.find((t) => t === 'application/json' || /\+json$/.test(t));
    if (json) return { type: tsType(content[json]!.schema, ''), accept: 'json' };
    const ct = types[0]!;
    if (ct === 'text/event-stream') return { type: 'Response', accept: 'stream' };
    if (BINARY_TYPES.test(ct)) return { type: 'ArrayBuffer', accept: 'binary' };
    return { type: 'string', accept: 'text' };
  }
  return { type: 'void', accept: 'none' };
}

export interface SdkOperation { id: string; method: string; path: string }

export function buildTsSdk(spec: Schema): { text: string; operations: SdkOperation[] } {
  const out: string[] = [];
  const operations: SdkOperation[] = [];
  out.push(
    '// Generated from the PlugSure CSMS OpenAPI document by tools/sdk/generate.mts. Do not edit:',
    '// change the API catalogue (src/api/openapi/catalogue) and run `npm run sdk`.',
    '/* eslint-disable */',
    "import type { Transport, RequestOptions, BinaryBody } from './client.js';",
    '',
    `/** The API version this SDK was generated from. */`,
    `export const API_VERSION = ${JSON.stringify(spec.info?.version ?? '')};`,
    '',
    '// ─────────────────────────────────────────────── schemas',
    '',
  );
  const schemas = (spec.components?.schemas ?? {}) as Record<string, Schema>;
  for (const name of Object.keys(schemas).sort()) {
    const s = schemas[name]!;
    const t = tsType(s);
    out.push(`${doc(s.description, '')}${t.startsWith('{') ? `export interface ${typeName(name)} ${t}` : `export type ${typeName(name)} = ${t};`}`, '');
  }

  // Webhook events: the envelope each delivery carries, by event type.
  const hooks = Object.entries((spec.webhooks ?? {}) as Record<string, Schema>).sort(([a], [b]) => a.localeCompare(b));
  out.push('// ─────────────────────────────────────────────── webhook events', '');
  for (const [type, item] of hooks) {
    const body = item.post?.requestBody?.content?.['application/json']?.schema;
    out.push(`${doc(item.post?.summary, '')}export type ${typeName(`Event_${type}`)} = ${tsType(body)};`, '');
  }
  out.push(
    '/** Any webhook delivery, discriminated by `type`. */',
    `export type WebhookEvent = ${hooks.length ? hooks.map(([t]) => typeName(`Event_${t}`)).join(' | ') : 'never'};`,
    `export const WEBHOOK_EVENT_TYPES = ${JSON.stringify(hooks.map(([t]) => t))} as const;`,
    '',
    '// ─────────────────────────────────────────────── operations',
    '',
    '/** Every operation of the API, one method each. `PlugSure` (index.ts) adds the transport. */',
    'export class Operations {',
    '  constructor(protected readonly transport: Transport) {}',
  );

  // Object types spelled out inline become named aliases (CreateWebhookEndpointResponse, …Body):
  // readable signatures, and names integrators can import.
  const aliases: string[] = [];
  const pascal = (id: string) => id[0]!.toUpperCase() + id.slice(1);
  const named = (type: string, name: string) => {
    if (!type.includes('\n')) return type;
    aliases.push(`export type ${name} = ${type};`, '');
    return name;
  };
  const methods: string[] = [];

  const entries: Array<{ id: string; method: string; path: string; op: Schema }> = [];
  for (const [path, item] of Object.entries((spec.paths ?? {}) as Record<string, Schema>)) {
    for (const [method, op] of Object.entries(item)) entries.push({ id: op.operationId, method: method.toUpperCase(), path, op });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));

  for (const { id, method, path, op } of entries) {
    operations.push({ id, method, path });
    const params = (op.parameters ?? []) as Schema[];
    const pathP = params.filter((p) => p.in === 'path');
    const queryP = params.filter((p) => p.in === 'query');
    const bodyContent = (op.requestBody?.content ?? {}) as Record<string, Schema>;
    const bodyCt = Object.keys(bodyContent)[0];
    const bodyJson = bodyCt === 'application/json';
    const bodyType = bodyCt ? (bodyJson ? named(tsType(bodyContent[bodyCt]!.schema, ''), `${pascal(id)}Body`) : 'BinaryBody') : null;
    const bodyRequired = !!op.requestBody && op.requestBody.required !== false;
    const res0 = responseOf(op);
    const res = { ...res0, type: named(res0.type, `${pascal(id)}Response`) };

    const fields: string[] = [];
    for (const p of pathP) fields.push(`${doc(p.description, '    ')}    ${prop(p.name)}: string;`);
    if (queryP.length) {
      const q = queryP.map((p) => `${doc(p.description, '      ')}      ${prop(p.name)}${p.required ? '' : '?'}: ${tsType(p.schema, '      ')};`).join('\n');
      fields.push(`    query${queryP.some((p) => p.required) ? '' : '?'}: {\n${q}\n    };`);
    }
    if (bodyType) fields.push(`${doc(op.requestBody?.description, '    ')}    body${bodyRequired ? '' : '?'}: ${bodyType};`);
    const paramsRequired = pathP.length > 0 || queryP.some((p) => p.required) || (bodyType !== null && bodyRequired);
    const paramsDecl = fields.length ? `params${paramsRequired ? '' : '?'}: {\n${fields.join('\n')}\n  }, ` : '';

    const perms = (op['x-permissions'] ?? []) as string[];
    const extra = ['', `\`${method} ${path}\`${perms.length ? ` · needs ${perms.map((p) => `\`${p}\``).join(', ')}` : ''}`];
    const description = (op.description ?? '').replace(/\n\n\*\*Permissions checked:\*\*[^\n]*$/, '');
    methods.push('', doc(`${op.summary}${description ? `\n\n${description}` : ''}`, '  ', extra).trimEnd());
    const call = [
      `method: ${JSON.stringify(method)}`,
      `path: ${JSON.stringify(path)}`,
      ...(pathP.length ? [`pathParams: { ${pathP.map((p) => `${prop(p.name)}: params${paramsRequired ? '' : '?'}.${IDENT.test(p.name) ? p.name : `[${JSON.stringify(p.name)}]`}`).join(', ')} }`] : []),
      ...(queryP.length ? [`query: params${paramsRequired ? '' : '?'}.query`] : []),
      ...(bodyType ? [`body: params${paramsRequired ? '' : '?'}.body`, `bodyType: ${JSON.stringify(bodyJson ? 'json' : 'binary')}`] : []),
      ...(bodyCt && !bodyJson ? [`contentType: ${JSON.stringify(bodyCt)}`] : []),
      `accept: ${JSON.stringify(res.accept)}`,
    ];
    methods.push(
      `  ${id}(${paramsDecl}options?: RequestOptions): Promise<${res.type}> {`,
      `    return this.transport.request<${res.type}>({ ${call.join(', ')} }, options);`,
      '  }',
    );
  }
  // The aliases must come before the class that uses them.
  const cls = out.splice(out.indexOf('/** Every operation of the API, one method each. `PlugSure` (index.ts) adds the transport. */'));
  out.push('// ─────────────────────────────────────────────── request and response types', '', ...aliases, ...cls, ...methods, '}', '');
  return { text: out.join('\n'), operations };
}
