import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

export const BASE = 'ws://127.0.0.1:9620/ocpp';

export class CP {
  ws!: WebSocket;
  pending = new Map<string, { res: (v: any) => void; rej: (e: any) => void }>();
  constructor(public id: string) {}

  async connect() {
    this.ws = new WebSocket(`${BASE}/${encodeURIComponent(this.id)}`, ['ocpp1.6']);
    this.ws.on('message', (d) => this.onMessage(d.toString()));
    this.ws.on('error', () => {});
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    return this;
  }

  onMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    const [type, id] = msg;
    if (type === 3) { this.pending.get(id)?.res(msg[2]); this.pending.delete(id); }
    else if (type === 4) { this.pending.get(id)?.rej(new Error(`${msg[2]}: ${msg[3]}`)); this.pending.delete(id); }
    else if (type === 2) { this.ws.send(JSON.stringify([3, id, {}])); }
  }

  call<T = any>(action: string, payload: any, timeoutMs = 240_000): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify([2, id, action, payload]));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`timeout ${action}`)); }, timeoutMs);
    });
  }

  async boot(vendor = 'Autel', model = 'MaxiCharger DC Compact') {
    return this.call('BootNotification', {
      chargePointVendor: vendor, chargePointModel: model,
      chargePointSerialNumber: this.id, firmwareVersion: 'V2.1.7',
    });
  }

  close() { try { this.ws.close(); } catch {} }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function mvRegister(ts: string, wh: number) {
  return [{ timestamp: ts, sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: String(wh), unit: 'Wh', context: 'Sample.Periodic' }] }];
}
