// Writes the published OpenAPI document (src/web/openapi.json, served at
// /openapi.json and rendered at /api-docs.html) from the API catalogue in
// src/api/openapi/.
//
//     npm run openapi            regenerate
//     npm run openapi -- --check fail if the committed file is out of date
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { specText, SPEC_FILE } from '../../src/api/openapi/generate.js';

const root = join(import.meta.dirname, '..', '..');
const out = join(root, SPEC_FILE);
const text = specText(root);
if (process.argv.includes('--check')) {
  const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
  if (current !== text) {
    console.error(`${SPEC_FILE} is out of date: run npm run openapi`);
    process.exit(1);
  }
  console.log(`${SPEC_FILE} is up to date`);
} else {
  writeFileSync(out, text);
  const spec = JSON.parse(text);
  const ops = Object.values(spec.paths as Record<string, object>).reduce((n: number, p) => n + Object.keys(p).length, 0);
  console.log(`wrote ${SPEC_FILE}: ${ops} operations, ${Object.keys(spec.components.schemas).length} schemas, ${Object.keys(spec.webhooks).length} webhook events`);
}
