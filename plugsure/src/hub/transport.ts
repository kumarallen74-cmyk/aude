import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * In-process transport (docs/HUB-DESIGN.md D5, §6).
 *
 * A call whose URL is under one of OUR public origins — the hub's (HUB_PUBLIC_URL) or the tenants' OCPI
 * surface (OCPI_PUBLIC_URL) — is not sent over the network: it is injected into a Fastify instance in this
 * process (`app.inject`), so it runs through exactly the hooks, authentication and handlers an external call
 * would, with no load-balancer round trip and no TLS to ourselves. Any other URL goes over HTTPS through the
 * SSRF guard (ocpi/client.ts).
 *
 * Only while the hub is enabled: with HUB_ENABLED=false nothing changes (a peer partner that happens to be
 * on our own origin is still called over HTTP, as before).
 *
 * The choice is made by exact origin equality with configured URLs, never by resolving a host name.
 *
 * Which instance: the API process registers its own app (setInprocApp, from buildApi). A process without
 * one (the gateway, which runs the workers and the tenants' roaming outbox) lazily builds a minimal instance
 * that mounts only the two OCPI surfaces. Everything an outbox delivery reaches there is database-only
 * (design §6 [VERIFY in H1]: receive* handlers, ClientInfo, command results); commands to chargers are
 * synchronous routes of the API process.
 */

const originOf = (u: string): string | null => {
  try { return new URL(u).origin; } catch { return null; }
};

/** Our own origins, for the in-process transport. */
export function inprocOrigins(): string[] {
  if (!config.hub.enabled) return [];
  return [config.hub.publicUrl, config.ocpi.publicUrl].map((u) => (u ? originOf(u) : null)).filter((o): o is string => !!o);
}

export function isInprocUrl(url: string): boolean {
  const o = originOf(url);
  return !!o && inprocOrigins().includes(o);
}

/**
 * The only paths an in-process call may reach: the two OCPI surfaces. A URL on our own origin can come from a
 * member (a response_url, a CDR Location, a Link): it must never reach the operator API (/v1), payment
 * webhooks or anything else that the in-process header exempts from the per-IP limit.
 */
export function inprocPathAllowed(url: string): boolean {
  // The WHATWG parser resolves dot segments (also %2e%2e), and injectCall sends exactly this pathname.
  let p: string;
  try { p = new URL(url).pathname; } catch { return false; }
  return p.startsWith('/ocpi/') || p.startsWith('/hub/ocpi/');
}

/**
 * A per-process secret the in-process transport sends in a header, so the receiving side knows the call did
 * not come over the network (it is exempt from the per-IP API limit; the hub's own per-connection limits
 * still apply). Nobody outside this process knows it.
 */
const INPROC_SECRET = randomBytes(32).toString('base64url');
export const INPROC_HEADER = 'x-plugsure-inproc';
export function inprocHeaderValue(): string { return INPROC_SECRET; }
export function isInprocRequest(headers: Record<string, unknown>): boolean {
  const v = headers[INPROC_HEADER];
  if (typeof v !== 'string' || v.length !== INPROC_SECRET.length) return false;
  return timingSafeEqual(Buffer.from(v), Buffer.from(INPROC_SECRET));
}

let app: FastifyInstance | null = null;
let building: Promise<FastifyInstance> | null = null;

/** The API process registers its app (buildApi). */
export function setInprocApp(a: FastifyInstance | null): void { app = a; }

/** The instance in-process calls go to: this process's app, or a minimal one built on first use. */
export async function inprocApp(): Promise<FastifyInstance> {
  if (app) return app;
  building ??= (async () => {
    const { default: Fastify } = await import('fastify');
    const { registerOcpiApi } = await import('../ocpi/server.js');
    const { registerHubApi } = await import('./server.js');
    const a = Fastify({ logger: false, bodyLimit: 1 * 1024 * 1024 });
    await registerOcpiApi(a);
    await registerHubApi(a);
    await a.ready();
    logger.info('in-process OCPI/hub transport: minimal instance built for this process');
    return a;
  })();
  try {
    return await building;
  } catch (e) {
    building = null;
    throw e;
  }
}

export interface InjectResult {
  httpStatus: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

/** Inject a call into this process's OCPI/hub surfaces, with a hard deadline. */
export async function injectCall(o: {
  method: string; url: string; headers: Record<string, string>; payload?: string; timeoutMs: number;
}): Promise<InjectResult> {
  if (!inprocPathAllowed(o.url)) throw new Error('in-process call refused: only /ocpi/ and /hub/ocpi/ paths');
  const a = await inprocApp();
  const u = new URL(o.url);
  let timer: NodeJS.Timeout | undefined;
  try {
    const res = await Promise.race([
      a.inject({
        method: o.method as 'GET',
        url: u.pathname + u.search,
        headers: { ...o.headers, host: u.host, [INPROC_HEADER]: INPROC_SECRET },
        ...(o.payload !== undefined ? { payload: o.payload } : {}),
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new InprocTimeout(o.timeoutMs)), o.timeoutMs); }),
    ]);
    return { httpStatus: res.statusCode, headers: res.headers as InjectResult['headers'], text: res.body };
  } finally {
    clearTimeout(timer);
  }
}

export class InprocTimeout extends Error {
  constructor(ms: number) { super(`no complete answer within ${Math.round(ms / 100) / 10} s`); }
}
