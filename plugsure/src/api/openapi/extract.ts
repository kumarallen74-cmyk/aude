import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeKey } from './build.js';

/**
 * Reads the /v1 route files (source, not the build) and returns, for every
 * route, the permission literals its handler checks. Used by the generator and
 * the spec test; never at runtime.
 *
 * A handler is the text from its `app.<method>(` to the next one. A route whose
 * path is a template (`/v1/charge-points/:identity/${path}` in a loop) is
 * returned as a pattern that the catalogue's concrete paths are matched against.
 */

export const ROUTE_FILES = ['api/server.ts', 'api/console-routes.ts', 'api/roaming-routes.ts', 'api/sandbox-routes.ts', 'api/fleet-routes.ts', 'api/fleet-portal-routes.ts', 'api/pricing-routes.ts', 'api/pnc-routes.ts', 'api/onboarding-routes.ts', 'api/integration-routes.ts', 'api/brand-routes.ts'];

export interface FoundRoute { method: string; path: string; template: boolean; permissions: string[]; file: string }

function permissionNames(srcRoot: string): Set<string> {
  const authz = readFileSync(join(srcRoot, 'services/authz.ts'), 'utf8');
  const union = /export type Permission =([\s\S]*?);/.exec(authz)?.[1] ?? '';
  return new Set([...union.matchAll(/'([a-z_]+:[a-z_]+)'/g)].map((m) => m[1]!));
}

/**
 * The source of one `app.get(…)` call: from its opening parenthesis to the
 * matching close, skipping strings, template literals and comments.
 */
function callText(text: string, open: number): string {
  let depth = 0;
  const stack: string[] = []; // string / template context
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      if (c === '\\') i++;
      else if (c === top) stack.pop();
      continue;
    }
    if (top === '`') {
      if (c === '\\') i++;
      else if (c === '`') stack.pop();
      else if (c === '$' && text[i + 1] === '{') { stack.push('${'); depth++; i++; }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2) + 1; if (i <= 0) break; continue; }
    if (c === "'" || c === '"' || c === '`') { stack.push(c); continue; }
    if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') {
      depth--;
      if (top === '${' && c === '}') stack.pop();
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

export function findRoutes(srcRoot: string): FoundRoute[] {
  const perms = permissionNames(srcRoot);
  const out: FoundRoute[] = [];
  for (const file of ROUTE_FILES) {
    const text = readFileSync(join(srcRoot, file), 'utf8');
    const re = /app\.(get|post|put|patch|delete)\(\s*(['`])([^'`]+)\2/g;
    const hits = [...text.matchAll(re)];
    hits.forEach((m) => {
      const path = m[3]!;
      if (!path.startsWith('/v1')) return;
      const body = callText(text, m.index! + m[0].indexOf('('));
      const found = [...new Set([...body.matchAll(/'([a-z_]+:[a-z_]+)'/g)].map((x) => x[1]!).filter((p) => perms.has(p)))];
      out.push({ method: m[1]!.toUpperCase(), path, template: path.includes('${'), permissions: found, file });
    });
  }
  return out;
}

/** Permissions per concrete catalogue route (templates matched as patterns). */
export function permissionsByRoute(srcRoot: string, catalogue: Array<{ method: string; path: string }>): Map<string, string[]> {
  const routes = findRoutes(srcRoot);
  const map = new Map<string, string[]>();
  for (const r of routes.filter((x) => !x.template)) map.set(routeKey(r.method, r.path), r.permissions);
  for (const t of routes.filter((x) => x.template)) {
    const rx = new RegExp('^' + t.path.split(/\$\{[^}]+\}/).map((s) => s.replace(/[.*+?^()|[\]\\]/g, '\\$&')).join('[^/]+') + '$');
    for (const op of catalogue) {
      const k = routeKey(op.method, op.path);
      if (op.method === t.method && rx.test(op.path) && !map.has(k)) map.set(k, t.permissions);
    }
  }
  return map;
}
