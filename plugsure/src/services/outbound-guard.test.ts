import test, { describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { config } from '../config.js';
import { isPrivateAddress, isInternalHost, guardedFetch } from './net-guard.js';
import { providerFetch } from './payments/provider.js';
import { sendSms, sendWhatsApp, sendEmail, checkChannelConfig } from './notify-transports.js';

/**
 * Tenant-configured outbound calls (payment / OTP / alert providers): the SSRF
 * guard, a hard total deadline, no redirects, and no provider answer echoed
 * back to the operator.
 */

const originalEnv = config.env;
const asProduction = () => { (config as { env: string }).env = 'production'; };
afterEach(() => { (config as { env: string }).env = originalEnv; });

const SECRET = 'INTERNAL-SECRET-7f3a9c';
const servers: (http.Server | net.Server)[] = [];
const sockets = new Set<net.Socket>();
after(() => { for (const s of sockets) s.destroy(); for (const s of servers) s.close(); });

async function listen<T extends http.Server | net.Server>(srv: T): Promise<{ srv: T; port: number }> {
  servers.push(srv);
  srv.on('connection', (s: net.Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, port: (srv.address() as AddressInfo).port };
}

/** Answers 200 at once, then one byte a second, forever. */
async function trickle() {
  return listen(http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    const t = setInterval(() => { if (!res.destroyed) res.write(' '); }, 1000);
    res.on('close', () => clearInterval(t));
  }));
}

/** Answers with a body the operator must never see. */
async function leaky(status = 500, type = 'text/html') {
  return listen(http.createServer((req, res) => {
    req.resume();
    res.writeHead(status, { 'content-type': type });
    res.end(`<html>${SECRET} redis_version:7.2.4 root:x:0:0</html>`);
  }));
}

describe('net-guard: embedded IPv4 and reserved ranges', () => {
  test('IPv4-compatible, NAT64, 6to4, site-local and IPv4 reserved ranges are private', () => {
    for (const ip of ['::7f00:1', '::127.0.0.1', '::a00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::169.254.169.254', '64:ff9b::10.0.0.1',
      '64:ff9b:1::1', '2002:a9fe:a9fe::1', '2002:7f00:1::', '2002:c0a8:101::1', 'fec0::1', 'feff::1', '192.0.0.8', '192.0.0.170',
      '100.64.0.1', '100.127.255.255', '198.18.0.1', '198.19.255.255', '224.0.0.251', '239.255.255.250', '240.0.0.1', '255.255.255.255',
      '0.1.2.3', '::ffff:0:a00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', 'fe80::1%eth0', '2001::1', '2001:db8::1', '100::1', 'ff02::1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
  });
  test('public addresses, including through NAT64 and 6to4, are not', () => {
    for (const ip of ['8.8.8.8', '192.0.1.1', '198.20.0.1', '100.128.0.1', '64:ff9b::808:808', '64:ff9b::8.8.8.8', '2002:808:808::1',
      '2606:4700::1111', '2a00:1450:4001::200e']) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });
  test('bracketed literals are recognised as internal hosts', () => {
    for (const h of ['[64:ff9b::a9fe:a9fe]', '[::ffff:10.0.0.1]', '[2002:a9fe:a9fe::]', '[fec0::1]', '[::127.0.0.1]']) assert.equal(isInternalHost(h), true, h);
  });
});

describe('guardedFetch', () => {
  test('refuses internal addresses in production without connecting', async () => {
    asProduction();
    for (const u of ['https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data/', 'https://[::ffff:10.0.0.1]/',
      'https://[64:ff9b::a9fe:a9fe]/', 'https://localhost/', 'https://localhost./', 'https://metadata.google.internal./']) {
      await assert.rejects(guardedFetch(u), /publicly reachable/, u);
    }
    await assert.rejects(guardedFetch('http://api.example.com/'), /https/);
  });

  test('a trickling server is cut off at the total deadline', async () => {
    const { port } = await trickle();
    const t0 = Date.now();
    await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/`, { timeoutMs: 1500 }), /no complete answer within 1\.5 s/);
    const ms = Date.now() - t0;
    assert.ok(ms >= 1400 && ms < 3000, `cut after ${ms} ms`);
  });

  test('redirects are not followed', async () => {
    let hits = 0;
    const inner = await listen(http.createServer((_q, r) => { hits++; r.end('inner'); }));
    const outer = await listen(http.createServer((_q, r) => { r.writeHead(302, { location: `http://127.0.0.1:${inner.port}/` }); r.end(); }));
    const r = await guardedFetch(`http://127.0.0.1:${outer.port}/`);
    assert.equal(r.status, 302);
    assert.equal(hits, 0);
  });

  test('the answer is capped', async () => {
    const { port } = await listen(http.createServer((_q, r) => { r.end(Buffer.alloc(64 * 1024, 120)); }));
    await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/`, { maxBytes: 1024 }), /larger than/);
  });
});

describe('providerFetch (payment, OTP, PKI providers)', () => {
  test('refuses an internal base URL in production', async () => {
    asProduction();
    await assert.rejects(providerFetch('https://169.254.169.254/v2/charge'), /publicly reachable/);
    await assert.rejects(providerFetch('https://[64:ff9b::a9fe:a9fe]/v2/charge'), /publicly reachable/);
  });
  test('does not follow redirects', async () => {
    let hits = 0;
    const inner = await listen(http.createServer((_q, r) => { hits++; r.end('{}'); }));
    const outer = await listen(http.createServer((_q, r) => { r.writeHead(307, { location: `http://127.0.0.1:${inner.port}/` }); r.end(); }));
    const r = await providerFetch(`http://127.0.0.1:${outer.port}/v2/charge`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 307);
    assert.equal(hits, 0);
  });
  test('the raw answer is not handed back for display', async () => {
    const { port } = await leaky();
    const r = await providerFetch(`http://127.0.0.1:${port}/balance`);
    assert.equal(r.status, 500);
    assert.equal(r.body, null);
    assert.ok(!r.text.includes(SECRET), r.text);
  });
  test('a JSON answer is still parsed; form bodies are sent', async () => {
    let got = '';
    const { port } = await listen(http.createServer((q, r) => {
      let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => { got = `${q.headers['content-type']}|${b}`; r.setHeader('content-type', 'application/json'); r.end('{"sid":"SM1"}'); });
    }));
    const r = await providerFetch(`http://127.0.0.1:${port}/Messages.json`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: '+62' }).toString() });
    assert.equal(r.body.sid, 'SM1');
    assert.equal(got, 'application/x-www-form-urlencoded|To=%2B62');
  });
  test('a trickling provider is cut off at the deadline', async () => {
    const { port } = await trickle();
    await assert.rejects(providerFetch(`http://127.0.0.1:${port}/`, { timeoutMs: 1200 }), /no complete answer/);
  });
});

describe('alert channels (SMS, WhatsApp, SMTP)', () => {
  test('SMS and WhatsApp errors carry the status, not the answer', async () => {
    const { port } = await leaky(502);
    for (const c of [
      { provider: 'http' as const, url: `http://127.0.0.1:${port}/send` },
      { provider: 'twilio' as const, accountSid: 'AC' + 'ab'.repeat(16), from: '+15550100000', baseUrl: `http://127.0.0.1:${port}` },
      { provider: 'zenziva' as const, userkey: 'k', endpoint: `http://127.0.0.1:${port}/sendsms/` },
    ]) {
      const r = await sendSms(c, 'token', '6281234567890', 'hello');
      assert.equal(r.ok, false);
      assert.match(r.error!, /502/);
      assert.ok(!r.error!.includes(SECRET), r.error);
    }
    const w = await sendWhatsApp({ apiBase: `http://127.0.0.1:${port}/v21.0`, phoneNumberId: '1234567', templateName: 't', templateLang: 'id' }, 'tok', '6281234567890', ['x']);
    assert.equal(w.ok, false);
    assert.ok(!w.error!.includes(SECRET), w.error);
  });

  test('WhatsApp still reports Meta\'s structured error code', async () => {
    const { port } = await listen(http.createServer((q, r) => {
      q.resume();
      r.writeHead(400, { 'content-type': 'application/json' });
      r.end(JSON.stringify({ error: { message: 'Message undeliverable', code: 131026 } }));
    }));
    const w = await sendWhatsApp({ apiBase: `http://127.0.0.1:${port}/v21.0`, phoneNumberId: '1234567', templateName: 't', templateLang: 'id' }, 'tok', '6281234567890', ['x']);
    assert.match(w.error!, /131026/);
    assert.equal(w.permanent, true);
  });

  test('provider URLs and SMTP hosts inside the network are refused in production', async () => {
    asProduction();
    assert.match(checkChannelConfig('sms', { provider: 'http', url: 'https://10.0.0.5/send' })!, /publicly reachable/);
    assert.match(checkChannelConfig('sms', { provider: 'zenziva', userkey: 'k', endpoint: 'https://[64:ff9b::a9fe:a9fe]/' })!, /publicly reachable/);
    assert.match(checkChannelConfig('whatsapp', { apiBase: 'https://169.254.169.254/v21.0', phoneNumberId: '1234567', templateName: 't', templateLang: 'id' })!, /publicly reachable/);
    for (const host of ['127.0.0.1', 'localhost', '10.1.2.3', '169.254.169.254', 'redis.internal']) {
      assert.match(checkChannelConfig('email', { host, port: 587, security: 'starttls', fromAddress: 'a@b.co.id' })!, /publicly reachable/, host);
    }
    assert.equal(checkChannelConfig('email', { host: 'smtp.gmail.com', port: 587, security: 'starttls', fromAddress: 'a@b.co.id' }), null);
    const r = await sendSms({ provider: 'http', url: 'https://169.254.169.254/' }, 't', '628123', 'x');
    assert.match(r.error!, /publicly reachable/);
  });

  test('a relay on this server works in production once the platform operator lists it', () => {
    asProduction();
    const relay = { host: '127.0.0.1', port: 25, security: 'none', fromAddress: 'a@b.co.id' };
    assert.match(checkChannelConfig('email', relay)!, /SMTP_ALLOWED_INTERNAL_HOSTS/);
    const saved = config.alerts.smtpAllowedInternalHosts;
    try {
      (config.alerts as { smtpAllowedInternalHosts: string[] }).smtpAllowedInternalHosts = ['127.0.0.1'];
      assert.equal(checkChannelConfig('email', relay), null);
      assert.match(checkChannelConfig('email', { ...relay, host: '10.0.0.9', security: 'starttls' })!, /publicly reachable/, 'only the listed host');
    } finally {
      (config.alerts as { smtpAllowedInternalHosts: string[] }).smtpAllowedInternalHosts = saved;
    }
  });

  test('SMTP to an internal host is refused in production without connecting', async () => {
    let connected = 0;
    const { port } = await listen(net.createServer((s) => { connected++; s.end('220 x\r\n'); }));
    asProduction();
    const r = await sendEmail({ host: '127.0.0.1', port, security: 'none', fromAddress: 'a@b.co.id' }, null, 'x@y.co.id', { subject: 's', text: 't', html: 'h' });
    assert.equal(r.ok, false);
    assert.match(r.error!, /publicly reachable/);
    const r2 = await sendEmail({ host: 'localhost', port, security: 'none', fromAddress: 'a@b.co.id' }, null, 'x@y.co.id', { subject: 's', text: 't', html: 'h' });
    assert.match(r2.error!, /publicly reachable/);
    assert.equal(connected, 0);
  });

  test('the SMTP server\'s banner and replies are not echoed', async () => {
    const { port } = await listen(net.createServer((s) => { s.write(`554 ${SECRET} SSH-2.0-OpenSSH_9.6 go away\r\n`); s.on('data', () => s.write(`554 ${SECRET}\r\n`)); }));
    const r = await sendEmail({ host: '127.0.0.1', port, security: 'none', fromAddress: 'a@b.co.id' }, null, 'x@y.co.id', { subject: 's', text: 't', html: 'h' });
    assert.equal(r.ok, false);
    assert.ok(!r.error!.includes(SECRET), r.error);
    assert.match(r.error!, /SMTP server 127\.0\.0\.1:\d+/);
    // Not an SMTP server at all (another service announcing itself): a generic error.
    const { port: hp } = await listen(net.createServer((s) => { s.write(`HTTP/1.1 400 Bad Request\r\nServer: ${SECRET} redis\r\n\r\n`); }));
    const r2 = await sendEmail({ host: '127.0.0.1', port: hp, security: 'none', fromAddress: 'a@b.co.id' }, null, 'x@y.co.id', { subject: 's', text: 't', html: 'h' });
    assert.equal(r2.ok, false);
    assert.ok(!r2.error!.includes(SECRET) && !/redis|html/i.test(r2.error!), r2.error);
  });

  test('a local SMTP relay still works in development', async () => {
    const mails: string[] = [];
    const { port } = await listen(net.createServer((sock) => {
      sock.write('220 fake ready\r\n');
      let data = false; let buf = '';
      sock.on('data', (c) => {
        buf += c.toString();
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (data) { if (line === '.') { data = false; mails.push('m'); sock.write('250 ok\r\n'); } continue; }
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 fake\r\n');
          else if (cmd === 'DATA') { data = true; sock.write('354 go\r\n'); }
          else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); }
          else sock.write('250 ok\r\n');
        }
      });
    }));
    const r = await sendEmail({ host: '127.0.0.1', port, security: 'none', fromAddress: 'a@b.co.id' }, null, 'x@y.co.id', { subject: 's', text: 't', html: 'h' });
    assert.equal(r.ok, true, r.error);
    assert.equal(mails.length, 1);
  });
});
