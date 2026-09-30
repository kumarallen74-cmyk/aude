import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

export const GW = 'ws://127.0.0.1:9321/ocpp';
export const API = 'http://127.0.0.1:9301';

export interface Client {
  ws: WebSocket;
  frames: any[];
  sendRaw(text: string): void;
  call(action: string, payload: any, id?: any): Promise<any>;
  sendFrame(frame: any[]): Promise<void>;
  waitFor(pred: (f: any) => boolean, ms?: number): Promise<any>;
  close(): void;
  onCall?: (action: string, payload: any, id: string) => any | Promise<any>;
}

export function connect(
  identity: string,
  opts: { subprotocol?: string | string[] | null; path?: string; headers?: Record<string, string>; raw?: boolean } = {},
): Promise<Client> {
  const url = opts.path ?? `${GW}/${encodeURIComponent(identity)}`;
  const sub = opts.subprotocol === null ? undefined : (opts.subprotocol ?? ['ocpp1.6']);
  const ws = new WebSocket(url, sub as any, { headers: opts.headers });
  const frames: any[] = [];
  const pending = new Map<string, { res: (v: any) => void; rej: (e: any) => void }>();
  const waiters: { pred: (f: any) => boolean; res: (v: any) => void; timer: NodeJS.Timeout }[] = [];

  const client: Client = {
    ws,
    frames,
    sendRaw(text) {
      ws.send(text);
    },
    async sendFrame(frame) {
      ws.send(JSON.stringify(frame));
    },
    call(action, payload, id) {
      const uid = id ?? randomUUID();
      return new Promise((res, rej) => {
        pending.set(String(uid), { res, rej });
        ws.send(JSON.stringify([2, uid, action, payload]));
        setTimeout(() => {
          if (pending.has(String(uid))) {
            pending.delete(String(uid));
            rej(new Error(`timeout waiting for reply to ${action}`));
          }
        }, 12000);
      });
    },
    waitFor(pred, ms = 8000) {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('waitFor timeout')), ms);
        waiters.push({ pred, res, timer });
      });
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
  };

  ws.on('message', async (d) => {
    let f: any;
    try {
      f = JSON.parse(d.toString());
    } catch {
      frames.push({ __unparseable: d.toString() });
      return;
    }
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(f)) {
        clearTimeout(waiters[i]!.timer);
        waiters[i]!.res(f);
        waiters.splice(i, 1);
      }
    }
    if (Array.isArray(f) && (f[0] === 3 || f[0] === 4)) {
      const p = pending.get(String(f[1]));
      if (p) {
        pending.delete(String(f[1]));
        if (f[0] === 3) p.res(f[2]);
        else p.rej(Object.assign(new Error(String(f[3])), { callError: f }));
      }
    }
    if (Array.isArray(f) && f[0] === 2 && client.onCall) {
      const r = await client.onCall(f[2], f[3], f[1]);
      if (r !== undefined) ws.send(JSON.stringify([3, f[1], r]));
    }
  });

  return new Promise((res, rej) => {
    ws.on('open', () => res(client));
    ws.on('error', (e) => rej(e));
    ws.on('unexpected-response', (_req, r) => rej(new Error(`HTTP ${r.statusCode}`)));
  });
}

export const boot = (c: Client, extra: any = {}) =>
  c.call('BootNotification', {
    chargePointVendor: 'Autel',
    chargePointModel: 'MaxiCharger AC Wallbox',
    chargePointSerialNumber: 'SIM',
    firmwareVersion: 'V1.4.12',
    ...extra,
  });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function j(v: any) {
  return JSON.stringify(v);
}
