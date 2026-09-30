import net from 'node:net';
import { connect, boot, sleep } from './lib.js';
import pg from 'pg';

const db = new pg.Pool({ connectionString: 'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_audit_a' });

function rawUpgrade(path: string, extraHeaders: string[]): Promise<string> {
  return new Promise((res) => {
    const s = net.connect(9321, '127.0.0.1');
    let buf = '';
    s.on('connect', () => {
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:9321\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
          extraHeaders.map((h) => h + '\r\n').join('') +
          `\r\n`,
      );
    });
    s.on('data', (d) => { buf += d.toString(); });
    s.on('close', () => res(buf.split('\r\n\r\n')[0] || '(closed, no bytes: TCP reset)'));
    s.on('error', (e) => res('SOCKERR ' + e.message));
    setTimeout(() => { s.destroy(); res(buf.split('\r\n\r\n')[0] || '(no response, socket destroyed by server?)'); }, 3000);
  });
}

async function main() {
  console.log('=== raw upgrade probes ===');
  const cases: [string, string, string[]][] = [
    ['uppercase OCPP1.6', '/ocpp/AUDIT-RAW-1', ['Sec-WebSocket-Protocol: OCPP1.6']],
    ['two Sec-WebSocket-Protocol headers', '/ocpp/AUDIT-RAW-2', ['Sec-WebSocket-Protocol: ocpp2.0.1', 'Sec-WebSocket-Protocol: ocpp1.6']],
    ['header w/ spaces "ocpp1.6 , ocpp2.0.1"', '/ocpp/AUDIT-RAW-3', ['Sec-WebSocket-Protocol: ocpp1.6 , ocpp2.0.1']],
    ['malformed percent-encoded identity %zz', '/ocpp/%zz', ['Sec-WebSocket-Protocol: ocpp1.6']],
    ['no subprotocol header at all', '/ocpp/AUDIT-RAW-4', []],
    ['empty subprotocol header', '/ocpp/AUDIT-RAW-5', ['Sec-WebSocket-Protocol: ']],
  ];
  for (const [name, path, hdrs] of cases) {
    const r = await rawUpgrade(path, hdrs);
    console.log(`  ${name.padEnd(42)} -> ${r.split('\r\n').filter((l) => /HTTP|Protocol/i.test(l)).join(' | ') || r.slice(0, 90)}`);
  }

  console.log('\n=== negotiated ocpp2.0.1, then speak OCPP 1.6 on it ===');
  const c = await connect('AUDIT-201-MISMATCH', { subprotocol: ['ocpp2.0.1', 'ocpp1.6'] });
  console.log('  negotiated subprotocol =', JSON.stringify(c.ws.protocol));
  const b = await boot(c);
  console.log('  1.6 BootNotification on a 2.0.1 socket ->', JSON.stringify(b));
  const row = await db.query(`SELECT ocpp_version, vendor FROM charge_point WHERE ocpp_identity='AUDIT-201-MISMATCH'`);
  console.log('  recorded ocpp_version in DB:', JSON.stringify(row.rows[0]));
  // and a 2.0.1 message on it
  try {
    const r = await c.call('TransactionEvent', { eventType: 'Started', timestamp: new Date().toISOString(), seqNo: 0, triggerReason: 'Authorized' });
    console.log('  2.0.1 TransactionEvent ->', JSON.stringify(r), '(should be CALLERROR NotImplemented in a 1.6-only CSMS)');
  } catch (e: any) { console.log('  2.0.1 TransactionEvent ->', e.callError ? JSON.stringify(e.callError) : e.message); }
  c.close();

  console.log('\n=== security_profile enforcement / auth_key_hash ===');
  await db.query(`UPDATE charge_point SET security_profile=1 WHERE ocpp_identity='AUTEL-AC22-SMB-001'`);
  const hash = await db.query(`SELECT auth_key_hash, security_profile FROM charge_point WHERE ocpp_identity='AUTEL-AC22-SMB-001'`);
  console.log('  auth_key_hash for seeded CP:', JSON.stringify(hash.rows[0]));
  for (const [name, hdrs] of [
    ['profile 1, no Authorization header', []],
    ['profile 1, correct-looking Basic creds', ['Authorization: Basic ' + Buffer.from('AUTEL-AC22-SMB-001:anykey').toString('base64')]],
  ] as [string, string[]][]) {
    const r = await rawUpgrade('/ocpp/AUTEL-AC22-SMB-001', ['Sec-WebSocket-Protocol: ocpp1.6', ...hdrs]);
    console.log(`  ${name.padEnd(42)} -> ${r.split('\r\n')[0]}`);
  }
  await db.query(`UPDATE charge_point SET security_profile=0 WHERE ocpp_identity='AUTEL-AC22-SMB-001'`);

  console.log('\n=== does the gateway speak TLS at all? ===');
  const tls = await new Promise<string>((res) => {
    const s = net.connect(9321, '127.0.0.1');
    s.on('connect', () => s.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x2f]))); // TLS ClientHello prefix
    let b = '';
    s.on('data', (d) => { b += d.toString('latin1'); });
    s.on('close', () => res(b.slice(0, 120) || '(no bytes)'));
    setTimeout(() => { s.destroy(); res(b.slice(0, 120) || '(no bytes)'); }, 1500);
  });
  console.log('  TLS ClientHello to :9321 ->', JSON.stringify(tls));

  await db.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
