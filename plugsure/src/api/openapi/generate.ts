import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSpec, allOps } from './build.js';
import { permissionsByRoute } from './extract.js';

/**
 * The published document as text. `root` is the project root (it reads the
 * route sources for permissions and package.json for the version).
 */
export function specText(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  const spec = buildSpec({ version: pkg.version, permissions: permissionsByRoute(join(root, 'src'), allOps()) });
  return JSON.stringify(spec, null, 2) + '\n';
}

export const SPEC_FILE = 'src/web/openapi.json';
