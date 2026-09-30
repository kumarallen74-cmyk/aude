import WebSocket from 'ws';

const cases: Array<{name:string; url:string; proto?: any; headers?: any}> = [
  { name: 'A root path + id (Autel default "/")', url: 'ws://127.0.0.1:9324/AC1234567890ABCDEFGH', proto: 'ocpp1.6' },
  { name: 'B /ocpp/ prefix + id',                 url: 'ws://127.0.0.1:9324/ocpp/AC1234567890ABCDEFGH', proto: 'ocpp1.6' },
  { name: 'C trailing slash after id',            url: 'ws://127.0.0.1:9324/ocpp/AC1234567890ABCDEFGH/', proto: 'ocpp1.6' },
  { name: 'D version-in-path /ocpp/1.6/{id}',     url: 'ws://127.0.0.1:9324/ocpp/1.6/AC1234567890ABCDEFGH', proto: 'ocpp1.6' },
  { name: 'E version-only path /ocpp/1.6',        url: 'ws://127.0.0.1:9324/ocpp/1.6', proto: 'ocpp1.6' },
  { name: 'F no subprotocol offered',             url: 'ws://127.0.0.1:9324/ocpp/NOPROTO-001' },
  { name: 'G wrong subprotocol (ocpp2.0)',        url: 'ws://127.0.0.1:9324/ocpp/WRONGPROTO-001', proto: 'ocpp2.0' },
  { name: 'H list of subprotocols',               url: 'ws://127.0.0.1:9324/ocpp/LISTPROTO-001', proto: ['ocpp1.6','ocpp2.0.1'] },
  { name: 'I id with spaces/special (raw)',       url: 'ws://127.0.0.1:9324/ocpp/AUTEL%20CP%2F01%3Atest', proto: 'ocpp1.6' },
  { name: 'J id with + and .',                    url: 'ws://127.0.0.1:9324/ocpp/AC-1234_567.890+X', proto: 'ocpp1.6' },
  { name: 'K empty path (bare /)',                url: 'ws://127.0.0.1:9324/', proto: 'ocpp1.6' },
  { name: 'L query string appended',              url: 'ws://127.0.0.1:9324/ocpp/QSTRING-001?token=abc', proto: 'ocpp1.6' },
  { name: 'M seeded cp, basic auth wrong pw',     url: 'ws://127.0.0.1:9324/ocpp/AUTEL-AC22-SMB-001', proto: 'ocpp1.6', headers: { Authorization: 'Basic ' + Buffer.from('AUTEL-AC22-SMB-001:wrongkey').toString('base64') } },
  { name: 'N deep path /csms/v1/ocpp16/{id}',     url: 'ws://127.0.0.1:9324/csms/v1/ocpp16/DEEPPATH-001', proto: 'ocpp1.6' },
];

async function run(c: typeof cases[number]) {
  return new Promise<void>((res) => {
    let done = false;
    const fin = (s: string) => { if (!done) { done = true; console.log(`${c.name.padEnd(42)} -> ${s}`); res(); } };
    const ws = new WebSocket(c.url, c.proto as any, { headers: c.headers, handshakeTimeout: 4000 });
    ws.on('upgrade', (r) => { (ws as any)._sub = r.headers['sec-websocket-protocol']; });
    ws.on('open', () => { fin(`OPEN (negotiated subprotocol=${JSON.stringify((ws as any)._sub ?? null)})`); ws.close(); });
    ws.on('unexpected-response', (_r, r2) => fin(`HTTP ${r2.statusCode} ${r2.statusMessage}`));
    ws.on('error', (e: any) => fin(`ERR ${e.message}`));
    setTimeout(() => fin('TIMEOUT/no response'), 5000);
  });
}
(async () => { for (const c of cases) await run(c); process.exit(0); })();
