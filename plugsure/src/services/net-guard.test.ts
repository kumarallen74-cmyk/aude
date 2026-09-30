import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { isPrivateAddress, isInternalHost, refuseHttpsUrl, guardedLookup, guardedHttpsGet } from './net-guard.js';

const originalEnv = config.env;
const asProduction = () => { (config as { env: string }).env = 'production'; };
afterEach(() => { (config as { env: string }).env = originalEnv; });

describe('net-guard: address classification', () => {
  test('private, loopback, link-local, CGNAT and metadata addresses are private', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
      '100.64.0.1', '0.0.0.0', '198.18.0.1', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
  });
  test('public addresses are not', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '203.0.113.9', '2606:4700::1111']) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });
  test('internal host names are recognised before DNS', () => {
    for (const h of ['localhost', 'api.localhost', 'metadata.google.internal', '[::1]', '10.0.0.5']) assert.equal(isInternalHost(h), true, h);
    for (const h of ['firmware.autel.com', 'cdn.example.co.id', '8.8.8.8']) assert.equal(isInternalHost(h), false, h);
  });
});

describe('net-guard: URL policy', () => {
  test('http and credentials are always refused', () => {
    assert.match(refuseHttpsUrl(new URL('http://firmware.example.com/fw.bin'))!, /https/);
    assert.match(refuseHttpsUrl(new URL('https://u:p@firmware.example.com/fw.bin'))!, /credentials/);
  });
  test('internal hosts are refused in production and allowed in development', () => {
    assert.equal(refuseHttpsUrl(new URL('https://169.254.169.254/latest/meta-data/')), null);
    asProduction();
    assert.match(refuseHttpsUrl(new URL('https://169.254.169.254/latest/meta-data/'))!, /publicly reachable/);
    assert.match(refuseHttpsUrl(new URL('https://localhost:9200/v1/users'))!, /publicly reachable/);
    assert.equal(refuseHttpsUrl(new URL('https://firmware.example.com/fw.bin')), null);
  });
  test('a name that RESOLVES to a private address is refused at connect time (DNS rebinding)', async () => {
    asProduction();
    const err = await new Promise<any>((resolve) => guardedLookup('localhost', {}, (e: any) => resolve(e)));
    assert.equal(err?.code, 'EPRIVATE');
  });
  test('the firmware download refuses an internal URL in production without connecting', async () => {
    asProduction();
    await assert.rejects(guardedHttpsGet('https://127.0.0.1:1/fw.bin'), /publicly reachable/);
    await assert.rejects(guardedHttpsGet('http://firmware.example.com/fw.bin'), /https/);
  });
});
