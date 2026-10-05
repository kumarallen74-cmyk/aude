// Fake OCPI 2.2.1 platforms for the end-to-end suites.
//
//   FakeParty        a programmable external CPO, eMSP, or both (hub-e2e, hub-console-e2e). It records every
//                    request (method, path, headers, body), answers like a small but honest OCPI party (stores
//                    what it receives, pages what it sends), runs both credentials handshakes, and can be taken
//                    down and brought back (liveness tests).
//   MockPeer         the recording HTTP server under the peer suites' scripted partners, and those partners:
//   MockEmspPartner  the mock eMSP(s) of ocpi-e2e.mts (one registers with us, one we connect to),
//   MockCpoPartner   the mock CPO of ocpi-emsp-e2e.mts,
//   MockSpAndHub     the mock smart-charging eMSP and roaming hub of ocpi-profiles-e2e.mts.
// The Mock* partners were moved here from their suites unchanged (WP H3): same answers, same records.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export interface Got { method: string; path: string; url: URL; headers: http.IncomingHttpHeaders; body: any; at: number }
export interface Role { role: string; country_code: string; party_id: string; name: string }
export type Module = [identifier: string, role: 'SENDER' | 'RECEIVER'];

export const b64 = (s: string) => Buffer.from(s).toString('base64');
export const decodeToken = (h?: string | string[]) => (typeof h === 'string' && h.startsWith('Token ') ? Buffer.from(h.slice(6), 'base64').toString() : '');
export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const env = (data: unknown, status = 1000, message?: string) =>
  JSON.stringify({ ...(data === undefined ? {} : { data }), status_code: status, ...(message ? { status_message: message } : {}), timestamp: nowIso() });

export interface Reply { status: number; data?: unknown; ocpi?: number; headers?: Record<string, string>; message?: string }

export class FakeParty {
  readonly got: Got[] = [];
  /** Tokens the fake accepts (A it issued, then C). */
  readonly accept = new Set<string>();
  /** The token the fake presents to the hub (C from the hub, or B it chose). */
  tokenToHub = '';
  /** The token the hub presents to the fake. */
  hubToken = '';
  hubEndpoints: Array<{ identifier: string; role: string; url: string }> = [];
  hubVersionsUrl = '';
  readonly store = {
    locations: new Map<string, any>(), tariffs: new Map<string, any>(), sessions: new Map<string, any>(), cdrs: new Map<string, any>(),
    tokens: new Map<string, any>(), clientInfo: new Map<string, any>(), commands: [] as Array<{ type: string; body: any; at: number }>,
  };
  /** What this party publishes (CPO: locations, sessions, cdrs; eMSP: tokens), served on its SENDER endpoints. */
  readonly own = { locations: [] as any[], tariffs: [] as any[], sessions: [] as any[], cdrs: [] as any[], tokens: [] as any[] };
  /** Real-time authorisation answers by uid (default ALLOWED). */
  readonly authorize = new Map<string, { allowed: string; ref?: string }>();
  /** A handler that may answer first (return undefined to fall through). */
  custom: ((g: Got) => Reply | undefined) | null = null;
  delayMs = 0;
  private server: http.Server | null = null;

  constructor(readonly o: { name: string; port: number; prefix: string; roles: Role[]; modules: Module[] }) {}

  get base() { return `http://127.0.0.1:${this.o.port}${this.o.prefix}`; }
  get versionsUrl() { return `${this.base}/versions`; }
  ep(id: string, role: 'SENDER' | 'RECEIVER') { return `${this.base}/2.2.1/${role === 'SENDER' ? 's' : 'r'}/${id}`; }
  hubEp(id: string, role: 'SENDER' | 'RECEIVER') {
    const e = this.hubEndpoints.find((x) => x.identifier === id && x.role === role);
    if (!e) throw new Error(`${this.o.name}: the hub lists no ${id} ${role}`);
    return e.url;
  }
  credentials(token: string) {
    return { token, url: this.versionsUrl, roles: this.o.roles.map((r) => ({ role: r.role, country_code: r.country_code, party_id: r.party_id, business_details: { name: r.name } })) };
  }
  received(pred: (g: Got) => boolean, after = 0) { return this.got.filter((g) => g.at >= after && pred(g)); }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.o.port}`);
        let body: any = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString() || 'null'); } catch { body = null; }
        const g: Got = { method: req.method!, path: url.pathname, url, headers: req.headers, body, at: Date.now() };
        this.got.push(g);
        const answer = (r: Reply) => {
          const out = () => {
            res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
            res.end(env(r.data, r.ocpi ?? 1000, r.message));
          };
          if (this.delayMs) setTimeout(out, this.delayMs); else out();
        };
        try { answer(this.handle(g)); } catch (e) { answer({ status: 500, ocpi: 3000, message: (e as Error).message }); }
      });
    });
    await new Promise<void>((r) => this.server!.listen(this.o.port, '127.0.0.1', () => r()));
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }

  private handle(g: Got): Reply {
    const { prefix } = this.o;
    if (!g.path.startsWith(prefix)) return { status: 404, ocpi: 2000 };
    const auth = decodeToken(g.headers.authorization);
    if (!this.accept.has(auth)) return { status: 401, ocpi: 2000, message: 'unknown token' };
    const c = this.custom?.(g);
    if (c) return c;
    const p = g.path.slice(prefix.length);
    if (p === '/versions') return { status: 200, data: [{ version: '2.2.1', url: `${this.base}/2.2.1` }] };
    if (p === '/2.2.1') {
      return { status: 200, data: { version: '2.2.1', endpoints: [
        { identifier: 'credentials', role: 'SENDER', url: `${this.base}/2.2.1/credentials` },
        { identifier: 'credentials', role: 'RECEIVER', url: `${this.base}/2.2.1/credentials` },
        ...this.o.modules.map(([id, role]) => ({ identifier: id, role, url: this.ep(id, role) })),
      ] } };
    }
    if (p === '/2.2.1/credentials') {
      if (g.method === 'POST' || g.method === 'PUT') {
        // The hub registers with us (hub-initiated) or rotates: take its token, give ours.
        this.hubToken = String(g.body?.token ?? '');
        this.hubVersionsUrl = String(g.body?.url ?? '');
        const c = `${this.o.name}-C-${randomUUID()}`;
        this.accept.add(c);
        if (g.method === 'PUT') this.accept.delete(auth);
        this.tokenToHub = this.hubToken;
        return { status: 200, data: this.credentials(c) };
      }
      if (g.method === 'DELETE') return { status: 200 };
      return { status: 200, data: this.credentials(auth) };
    }
    const m = /^\/2\.2\.1\/(s|r)\/([a-z]+)(\/.*)?$/.exec(p);
    if (!m) return { status: 404, ocpi: 2000 };
    const role = m[1] === 's' ? 'SENDER' : 'RECEIVER';
    const mod = m[2]!;
    const rest = (m[3] ?? '').split('/').filter(Boolean).map(decodeURIComponent);
    const key = rest.join('/');
    if (role === 'RECEIVER') {
      switch (mod) {
        case 'hubclientinfo':
          if (g.method === 'PUT') { this.store.clientInfo.set(`${rest[0]}*${rest[1]}*${g.body?.role}`, g.body); return { status: 200 }; }
          break;
        case 'locations': {
          const locKey = rest.slice(0, 3).join('/');
          if (g.method === 'GET') { const l = this.store.locations.get(locKey); return l ? { status: 200, data: l } : { status: 404, ocpi: 2003 }; }
          if (g.method === 'PUT' && rest.length === 3) { this.store.locations.set(locKey, g.body); return { status: 200 }; }
          const l = this.store.locations.get(locKey);
          if (!l) return { status: 404, ocpi: 2003, message: 'unknown location' };
          if (rest.length >= 4) {
            const e = (l.evses ?? []).find((x: any) => x.uid === rest[3]);
            if (!e) return { status: 404, ocpi: 2003 };
            Object.assign(e, g.body);
          } else Object.assign(l, g.body);
          return { status: 200 };
        }
        case 'tariffs':
          if (g.method === 'DELETE') { this.store.tariffs.delete(key); return { status: 200 }; }
          if (g.method === 'PUT') { this.store.tariffs.set(key, g.body); return { status: 200 }; }
          break;
        case 'sessions':
          if (g.method === 'PUT') { this.store.sessions.set(key, g.body); return { status: 200 }; }
          if (g.method === 'PATCH') {
            const s = this.store.sessions.get(key);
            if (!s) return { status: 404, ocpi: 2000 };
            Object.assign(s, g.body);
            return { status: 200 };
          }
          if (g.method === 'GET') { const s = this.store.sessions.get(key); return s ? { status: 200, data: s } : { status: 404, ocpi: 2000 }; }
          break;
        case 'cdrs':
          if (g.method === 'POST') {
            this.store.cdrs.set(String(g.body?.id), g.body);
            return { status: 201, headers: { location: `${this.ep('cdrs', 'RECEIVER')}/${encodeURIComponent(String(g.body?.id))}` } };
          }
          if (g.method === 'GET' && rest.length === 1) { const c = this.store.cdrs.get(rest[0]!); return c ? { status: 200, data: c } : { status: 404, ocpi: 2000 }; }
          break;
        case 'tokens':
          if (g.method === 'PUT') { this.store.tokens.set(key + (g.url.search ?? ''), g.body); this.store.tokens.set(key, g.body); return { status: 200 }; }
          if (g.method === 'PATCH') { const t = this.store.tokens.get(key); if (!t) return { status: 404, ocpi: 2004 }; Object.assign(t, g.body); return { status: 200 }; }
          if (g.method === 'GET') { const t = this.store.tokens.get(key); return t ? { status: 200, data: t } : { status: 404, ocpi: 2004 }; }
          break;
        case 'commands':
          if (g.method === 'POST') { this.store.commands.push({ type: rest[0]!, body: g.body, at: Date.now() }); return { status: 200, data: { result: 'ACCEPTED', timeout: 30 } }; }
          break;
        case 'chargingprofiles':
          if (g.method === 'PUT' || g.method === 'GET' || g.method === 'DELETE') return { status: 200, data: { result: 'ACCEPTED', timeout: 30 } };
          break;
      }
      return { status: 405, ocpi: 2000 };
    }
    // SENDER: what this party publishes, and the results posted to the response_urls it gave
    if ((mod === 'commands' || mod === 'chargingprofiles') && g.method === 'POST') return { status: 200 };
    if (mod === 'tokens' && g.method === 'POST' && rest[1] === 'authorize') {
      const a = this.authorize.get(rest[0]!) ?? { allowed: 'ALLOWED', ref: `${this.o.name}-REF-${rest[0]}`.slice(0, 36) };
      return { status: 200, data: { allowed: a.allowed, token: { uid: rest[0], type: g.url.searchParams.get('type') ?? 'RFID' }, ...(a.ref ? { authorization_reference: a.ref } : {}) } };
    }
    const list = (this.own as Record<string, any[]>)[mod];
    if (g.method === 'GET' && list) {
      if (rest.length) {
        const o = list.find((x) => x.id === rest[0]);
        return o ? { status: 200, data: o } : { status: 404, ocpi: 2003 };
      }
      const offset = Number(g.url.searchParams.get('offset') ?? 0);
      const limit = Math.min(Number(g.url.searchParams.get('limit') ?? 100), 100);
      const page = list.slice(offset, offset + limit);
      const headers: Record<string, string> = { 'x-total-count': String(list.length), 'x-limit': String(limit) };
      if (offset + limit < list.length) {
        const u = new URL(g.url.toString());
        u.searchParams.set('offset', String(offset + limit));
        u.searchParams.set('limit', String(limit));
        headers.link = `<${u.toString()}>; rel="next"`;
      }
      return { status: 200, data: page, headers };
    }
    return { status: 405, ocpi: 2000 };
  }

  /** Call the hub (or anything) as this party. */
  async call(method: string, url: string, body?: unknown, o: { token?: string; from?: Role | { country_code: string; party_id: string } | null; to?: { country_code: string; party_id: string } | null; headers?: Record<string, string> } = {}) {
    const from = o.from === undefined ? this.o.roles[0]! : o.from;
    const reqId = randomUUID();
    const corr = randomUUID();
    const r = await fetch(url, {
      method,
      headers: {
        authorization: `Token ${b64(o.token ?? this.tokenToHub)}`,
        'x-request-id': reqId, 'x-correlation-id': corr,
        ...(from ? { 'ocpi-from-country-code': from.country_code, 'ocpi-from-party-id': from.party_id } : {}),
        ...(o.to ? { 'ocpi-to-country-code': o.to.country_code, 'ocpi-to-party-id': o.to.party_id } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(o.headers ?? {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await r.text();
    let d: any = t;
    try { d = JSON.parse(t); } catch { /* not JSON */ }
    return { status: r.status, body: d, headers: r.headers, requestId: o.headers?.['x-request-id'] ?? reqId, correlationId: o.headers?.['x-correlation-id'] ?? corr };
  }

  /** Member starts: read the hub's versions with token A, POST our credentials (token B), keep token C. */
  async registerWithHub(versionsUrl: string, tokenA: string) {
    const tokenB = `${this.o.name}-B-${randomUUID()}`;
    this.accept.add(tokenB);
    const v = await this.call('GET', versionsUrl, undefined, { token: tokenA, from: null });
    const d = await this.call('GET', v.body?.data?.[0]?.url, undefined, { token: tokenA, from: null });
    this.hubEndpoints = d.body?.data?.endpoints ?? [];
    const credUrl = this.hubEp('credentials', 'RECEIVER');
    const r = await this.call('POST', credUrl, this.credentials(tokenB), { token: tokenA, from: null });
    if (r.status === 200) {
      this.tokenToHub = r.body.data.token;
      this.hubToken = tokenB;
    }
    return { versions: v, details: d, credentials: r };
  }

  /** After a hub-initiated registration: read the hub's endpoints with the token it gave us. */
  async loadHubEndpoints() {
    const v = await this.call('GET', this.hubVersionsUrl, undefined, { from: null });
    const d = await this.call('GET', v.body?.data?.[0]?.url, undefined, { from: null });
    this.hubEndpoints = d.body?.data?.endpoints ?? [];
  }
}


// ═══════════════════════════════════════════ the peer suites' scripted partners

/** One request as the peer suites record it: `path` is the raw request target, query string included. */
export interface PeerGot { method: string; path: string; headers: http.IncomingHttpHeaders; body: any; at: number }
/** status, envelope data, OCPI status_code (default 1000), extra response headers. */
export type PeerSend = (status: number, data: unknown, ocpiStatus?: number, extra?: Record<string, string>) => void;
export interface PeerRequest { method: string; url: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: any; auth: string }

/** The OCPI response envelope the peer suites' partners answer with (timestamp with milliseconds). */
export const peerEnvelope = (data: unknown, status = 1000) =>
  JSON.stringify({ ...(data === undefined ? {} : { data }), status_code: status, timestamp: new Date().toISOString() });

/** A recording HTTP server around a suite's handler: every request is in `got` before the handler runs. */
export class MockPeer {
  readonly got: PeerGot[] = [];
  private server: http.Server | null = null;
  constructor(readonly port: number, private readonly handler: (req: PeerRequest, send: PeerSend) => void) {}
  get base() { return `http://127.0.0.1:${this.port}`; }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const u = new URL(req.url ?? '/', this.base);
        let body: any = null; try { body = JSON.parse(Buffer.concat(chunks).toString() || 'null'); } catch {}
        this.got.push({ method: req.method!, path: req.url!, headers: req.headers, body, at: Date.now() });
        const send: PeerSend = (status, data, ocpiStatus = 1000, extra = {}) => {
          res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(peerEnvelope(data, ocpiStatus));
        };
        this.handler({ method: req.method!, url: req.url ?? '', path: u.pathname, query: u.searchParams, headers: req.headers, body, auth: decodeToken(req.headers.authorization) }, send);
      });
    });
    await new Promise<void>((r) => this.server!.listen(this.port, '127.0.0.1', () => r()));
  }
  close() { this.server?.close(); }

  received(pred: (g: PeerGot) => boolean, after = 0) { return this.got.find((g) => g.at >= after && pred(g)); }
  async waitReceived(pred: (g: PeerGot) => boolean, after = 0, ms = 20_000): Promise<PeerGot | undefined> {
    const t0 = Date.now();
    let v = this.received(pred, after);
    while (!v && Date.now() - t0 < ms) { await new Promise((r) => setTimeout(r, 250)); v = this.received(pred, after); }
    return v;
  }
}

/**
 * The mock eMSP of ocpi-e2e.mts. Partner 1 (/emsp) registers with PlugSure and is called with token B; partner 2
 * (/emsp2) is the one PlugSure connects to with token A2, getting token C2. Real-time authorisation answers come
 * from `realtime` (default NOT_ALLOWED); command results (/cmd/*) are accepted.
 */
export class MockEmspPartner extends MockPeer {
  readonly realtime: Record<string, { allowed: string; ref?: string }> = {};
  /** Partner 2: the token PlugSure presented in its credentials POST. */
  ourTokenB2 = '';
  constructor(o: { port: number; tokenB: string; tokenA2: string; tokenC2: string }) {
    super(o.port, (req, send) => {
      const { path, auth, body } = req;
      const MOCK = this.base;
      // Partner 1 (it registers with us)
      if (path.startsWith('/emsp/')) {
        if (auth !== o.tokenB) return send(401, undefined, 2000);
        if (path === '/emsp/versions') return send(200, [{ version: '2.2.1', url: `${MOCK}/emsp/2.2.1` }]);
        if (path === '/emsp/2.2.1') return send(200, { version: '2.2.1', endpoints: [
          { identifier: 'credentials', role: 'RECEIVER', url: `${MOCK}/emsp/2.2.1/credentials` },
          { identifier: 'locations', role: 'RECEIVER', url: `${MOCK}/emsp/2.2.1/locations` },
          { identifier: 'tariffs', role: 'RECEIVER', url: `${MOCK}/emsp/2.2.1/tariffs` },
          { identifier: 'sessions', role: 'RECEIVER', url: `${MOCK}/emsp/2.2.1/sessions` },
          { identifier: 'cdrs', role: 'RECEIVER', url: `${MOCK}/emsp/2.2.1/cdrs` },
          { identifier: 'tokens', role: 'SENDER', url: `${MOCK}/emsp/2.2.1/tokens` },
          { identifier: 'commands', role: 'SENDER', url: `${MOCK}/emsp/2.2.1/commands` },
        ] });
        const rt = /^\/emsp\/2\.2\.1\/tokens\/([^/]+)\/authorize$/.exec(path);
        if (rt) {
          const r = this.realtime[decodeURIComponent(rt[1]!)] ?? { allowed: 'NOT_ALLOWED' };
          return send(200, { allowed: r.allowed, token: { uid: decodeURIComponent(rt[1]!) }, ...(r.ref ? { authorization_reference: r.ref } : {}) });
        }
        if (path === '/emsp/2.2.1/cdrs' && req.method === 'POST') return send(201, undefined, 1000, { location: `${MOCK}/emsp/2.2.1/cdrs/${body?.id}` });
        return send(200, undefined);
      }
      // Partner 2 (we connect to it)
      if (path.startsWith('/emsp2/')) {
        const known = path === '/emsp2/versions' || path === '/emsp2/2.2.1' || path === '/emsp2/2.2.1/credentials' ? [o.tokenA2, o.tokenC2] : [o.tokenC2];
        if (!known.includes(auth)) return send(401, undefined, 2000);
        if (path === '/emsp2/versions') return send(200, [{ version: '2.1.1', url: `${MOCK}/emsp2/2.1.1` }, { version: '2.2.1', url: `${MOCK}/emsp2/2.2.1` }]);
        if (path === '/emsp2/2.2.1') return send(200, { version: '2.2.1', endpoints: [
          { identifier: 'credentials', role: 'RECEIVER', url: `${MOCK}/emsp2/2.2.1/credentials` },
          { identifier: 'locations', role: 'RECEIVER', url: `${MOCK}/emsp2/2.2.1/locations` },
        ] });
        if (path === '/emsp2/2.2.1/credentials' && req.method === 'POST') {
          this.ourTokenB2 = String(body?.token ?? '');
          return send(200, { token: o.tokenC2, url: `${MOCK}/emsp2/versions`, roles: [{ role: 'EMSP', country_code: 'ID', party_id: 'EM2', business_details: { name: 'E2E eMSP Two' } }] });
        }
        return send(200, undefined);
      }
      // Command results (response_url)
      if (path.startsWith('/cmd/')) return send(200, undefined);
      send(404, undefined, 2000);
    });
  }
}

/**
 * The mock CPO of ocpi-emsp-e2e.mts (/cpo, called with token B): its network in two pages of one location (to
 * prove Link is followed), one tariff, and commands it accepts, queuing their results in `pendingResults` for the
 * suite to post back.
 */
export class MockCpoPartner extends MockPeer {
  readonly pendingResults: Array<{ url: string; result: string }> = [];
  constructor(o: { port: number; tokenB: string; locations: () => any[]; tariff: any }) {
    super(o.port, (req, send) => {
      const { path, body } = req;
      const MOCK = this.base;
      if (req.auth !== o.tokenB) return send(401, undefined, 2000);
      if (path === '/cpo/versions') return send(200, [{ version: '2.2.1', url: `${MOCK}/cpo/2.2.1` }]);
      if (path === '/cpo/2.2.1') return send(200, { version: '2.2.1', endpoints: [
        { identifier: 'credentials', role: 'RECEIVER', url: `${MOCK}/cpo/2.2.1/credentials` },
        { identifier: 'locations', role: 'SENDER', url: `${MOCK}/cpo/2.2.1/locations` },
        { identifier: 'tariffs', role: 'SENDER', url: `${MOCK}/cpo/2.2.1/tariffs` },
        { identifier: 'tokens', role: 'RECEIVER', url: `${MOCK}/cpo/2.2.1/tokens` },
        { identifier: 'commands', role: 'RECEIVER', url: `${MOCK}/cpo/2.2.1/commands` },
      ] });
      if (path === '/cpo/2.2.1/locations') {
        // Two pages of one, to prove the Link header is followed.
        const offset = Number(req.query.get('offset') ?? 0);
        const all = o.locations();
        const extra: Record<string, string> = { 'x-total-count': '2', 'x-limit': '1' };
        if (offset === 0) extra.link = `<${MOCK}/cpo/2.2.1/locations?offset=1&limit=1>; rel="next"`;
        return send(200, all.slice(offset, offset + 1), 1000, extra);
      }
      if (path === '/cpo/2.2.1/tariffs') return send(200, [o.tariff]);
      const cmd = /^\/cpo\/2\.2\.1\/commands\/([A-Z_]+)$/.exec(path);
      if (cmd && req.method === 'POST') {
        this.pendingResults.push({ url: body.response_url, result: 'ACCEPTED' });
        return send(200, { result: 'ACCEPTED', timeout: 30 });
      }
      return send(200, undefined);
    });
  }
}

/**
 * The mock partners of ocpi-profiles-e2e.mts: a smart-charging eMSP (/sp, token tokenSp) and a roaming hub (/hub,
 * token tokenHub) whose HubClientInfo list (`hubClients`, replaceable) is served one party per page. Charging
 * profile results (/cp/*) are accepted. Every answer carries status_code 1000, as that suite's partners did.
 */
export class MockSpAndHub extends MockPeer {
  hubClients: Array<{ country_code: string; party_id: string; role: string; status: string; last_updated: string }>;
  constructor(o: { port: number; tokenSp: string; tokenHub: string; hubClients: MockSpAndHub['hubClients'] }) {
    super(o.port, (req, send) => {
      const { path, auth } = req;
      const MOCK = this.base;
      if (path.startsWith('/sp/')) {
        if (auth !== o.tokenSp) return send(401, undefined);
        if (path === '/sp/versions') return send(200, [{ version: '2.2.1', url: `${MOCK}/sp/2.2.1` }]);
        if (path === '/sp/2.2.1') return send(200, { version: '2.2.1', endpoints: [
          { identifier: 'credentials', role: 'RECEIVER', url: `${MOCK}/sp/2.2.1/credentials` },
          { identifier: 'sessions', role: 'RECEIVER', url: `${MOCK}/sp/2.2.1/sessions` },
          { identifier: 'chargingprofiles', role: 'SENDER', url: `${MOCK}/sp/2.2.1/chargingprofiles` },
        ] });
        return send(200, undefined);
      }
      if (path.startsWith('/hub/')) {
        if (auth !== o.tokenHub) return send(401, undefined);
        if (path === '/hub/versions') return send(200, [{ version: '2.2.1', url: `${MOCK}/hub/2.2.1` }]);
        if (path === '/hub/2.2.1') return send(200, { version: '2.2.1', endpoints: [
          { identifier: 'credentials', role: 'RECEIVER', url: `${MOCK}/hub/2.2.1/credentials` },
          { identifier: 'hubclientinfo', role: 'SENDER', url: `${MOCK}/hub/2.2.1/clientinfo` },
        ] });
        if (path === '/hub/2.2.1/clientinfo') {
          // One party per page, so PlugSure has to follow the Link header.
          const offset = Number(req.query.get('offset') ?? 0);
          const list = this.hubClients;
          const next = offset + 1 < list.length ? { link: `<${MOCK}/hub/2.2.1/clientinfo?offset=${offset + 1}&limit=1>; rel="next"` } : {};
          return send(200, list.slice(offset, offset + 1), 1000, { 'x-total-count': String(list.length), 'x-limit': '1', ...next });
        }
        return send(200, undefined);
      }
      if (path.startsWith('/cp/')) return send(200, undefined); // charging profile results (response_url)
      send(404, undefined);
    });
    this.hubClients = o.hubClients;
  }
}
