import WebSocket from 'ws';
import { extractIdentity, negotiate } from '../../plugsure/src/ocpp/server.js';

const GW = 'ws://127.0.0.1:9321';

function tryConnect(url: string, sub?: any, headers?: Record<string, string>): Promise<string> {
  return new Promise((res) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, sub, { headers });
    } catch (e: any) {
      return res('THROW ' + e.message);
    }
    const done = (s: string) => { res(s); try { ws.terminate(); } catch {} };
    ws.on('open', () => done(`OPEN (negotiated subprotocol=${JSON.stringify(ws.protocol)})`));
    ws.on('unexpected-response', (_r, r) => done(`HTTP ${r.statusCode} ${r.statusMessage}`));
    ws.on('error', (e: any) => done('ERROR ' + e.message));
    setTimeout(() => done('TIMEOUT/no response'), 4000);
  });
}

async function main() {
  console.log('=== extractIdentity() unit behaviour ===');
  const urls = [
    '/ocpp/CP001', '/ocpp/CP001/', '/ocpp/CP001?foo=bar', '/ocpp/CP%2F001',
    '/ocpp/CP/001', '/ocpp/1.6/CP001', '/ocpp/CP001/1.6', '/ocpp/1.6', '/', '',
    '/ocpp/' + 'L'.repeat(300), '/ocpp/%zz', '/ocpp/2.0.1', '/ocpp//CP001',
    '/ocpp/CP001#frag', '/ocpp/CP 001',
  ];
  for (const u of urls) {
    let out: any;
    try { out = JSON.stringify(extractIdentity(u)); } catch (e: any) { out = 'THREW: ' + e.message; }
    console.log(`  ${JSON.stringify(u).padEnd(24)} -> ${out}`);
  }

  console.log('\n=== negotiate() unit behaviour ===');
  const heads: any[] = [undefined, 'ocpp1.6', ' ocpp1.6 ', 'ocpp1.6, ocpp2.0.1', 'ocpp2.0.1,ocpp1.6',
    'OCPP1.6', 'ocpp1.5', 'ocpp1.6;q=1', ['ocpp1.6', 'ocpp2.0.1'], 'ocpp2.1,ocpp1.6', ''];
  for (const h of heads) console.log(`  ${String(JSON.stringify(h)).padEnd(28)} -> ${negotiate(h)}`);

  console.log('\n=== live handshake ===');
  const cases: [string, string, any, Record<string, string>?][] = [
    ['normal', `${GW}/ocpp/AUDIT-HS-1`, ['ocpp1.6']],
    ['trailing slash', `${GW}/ocpp/AUDIT-HS-2/`, ['ocpp1.6']],
    ['query string', `${GW}/ocpp/AUDIT-HS-3?x=1`, ['ocpp1.6']],
    ['version-in-path /ocpp/1.6/{id}', `${GW}/ocpp/1.6/AUDIT-HS-4`, ['ocpp1.6']],
    ['version-only path /ocpp/1.6', `${GW}/ocpp/1.6`, ['ocpp1.6']],
    ['no subprotocol offered', `${GW}/ocpp/AUDIT-HS-5`, undefined],
    ['unsupported subprotocol ocpp1.5', `${GW}/ocpp/AUDIT-HS-6`, ['ocpp1.5']],
    ['offers 1.6 AND 2.0.1', `${GW}/ocpp/AUDIT-HS-7`, ['ocpp1.6', 'ocpp2.0.1']],
    ['offers 2.0.1 only', `${GW}/ocpp/AUDIT-HS-8`, ['ocpp2.0.1']],
    ['offers 2.1 only', `${GW}/ocpp/AUDIT-HS-9`, ['ocpp2.1']],
    ['no path at all (/)', `${GW}/`, ['ocpp1.6']],
    ['URL-encoded slash in id', `${GW}/ocpp/AUDIT%2FHS%2F10`, ['ocpp1.6']],
    ['300-char identity', `${GW}/ocpp/${'L'.repeat(300)}`, ['ocpp1.6']],
    ['duplicate subprotocol header', `${GW}/ocpp/AUDIT-HS-11`, undefined, { 'Sec-WebSocket-Protocol': 'ocpp1.6' }],
  ];
  for (const [name, url, sub, hdr] of cases) {
    console.log(`  ${name.padEnd(34)} -> ${await tryConnect(url, sub, hdr)}`);
  }

  console.log('\n=== auth: security_profile enforcement ===');
  console.log('  (see t3b)');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
