import fs from 'node:fs';
import path from 'node:path';
import en from '../locales/en.json';
import id from '../locales/id.json';
import ms from '../locales/ms.json';
import zh from '../locales/zh.json';

/** Flatten to dotted keys; plural suffixes (_one/_other/…) collapse to the base key (Indonesian has no singular form). */
function flatten(obj: Record<string, unknown>, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v as Record<string, unknown>, key).forEach((val, kk) => out.set(kk, val));
    else out.set(key.replace(/_(zero|one|two|few|many|other)$/, ''), String(v));
  }
  return out;
}
const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

const EN = flatten(en);
const ID = flatten(id);

describe('i18n completeness', () => {
  it('every English key exists in Indonesian', () => {
    expect([...EN.keys()].filter((k) => !ID.has(k))).toEqual([]);
  });
  it('Indonesian has no keys English lacks', () => {
    expect([...ID.keys()].filter((k) => !EN.has(k))).toEqual([]);
  });
  it('interpolation variables match between en and id', () => {
    const mismatched = [...EN.entries()].filter(([k, v]) => ID.has(k) && vars(v).join() !== vars(ID.get(k)!).join()).map(([k]) => k);
    expect(mismatched).toEqual([]);
  });
  it('no empty strings', () => {
    expect([...EN.entries(), ...ID.entries()].filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
  });
  it('ms / zh scaffolding only uses keys that exist in English', () => {
    for (const l of [flatten(ms), flatten(zh)]) expect([...l.keys()].filter((k) => !EN.has(k))).toEqual([]);
  });

  it('every literal t("…") key used in the source exists in English', () => {
    const root = path.join(__dirname, '..', '..');
    const files: string[] = [];
    const walk = (d: string) =>
      fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const p = path.join(d, e.name);
        if (e.isDirectory() && e.name !== '__tests__') walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
      });
    walk(root);
    const missing = new Set<string>();
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) if (!EN.has(m[1]!)) missing.add(`${m[1]} (${path.basename(f)})`);
    }
    expect([...missing]).toEqual([]);
  });

  it('dynamic key families are complete', () => {
    const fam = (prefix: string, keys: string[]) => keys.filter((k) => !EN.has(`${prefix}.${k}`) || !ID.has(`${prefix}.${k}`));
    expect(fam('status', ['Available', 'Charging', 'Occupied', 'Faulted', 'Offline', 'Blocked', 'Maintenance', 'Unavailable', 'Reserved', 'Queued'])).toEqual([]);
    expect(fam('pay.methods', ['QRIS', 'PAYNOW', 'CARD', 'FPX', 'GRABPAY', 'GOPAY', 'OVO', 'DANA', 'SHOPEEPAY', 'LINKAJA'])).toEqual([]);
    expect(fam('session.steps', ['paid', 'accepted', 'connected', 'charging'])).toEqual([]);
    expect(fam('price.tax', ['ppn.incl', 'ppn.excl', 'gst.incl', 'gst.excl', 'sst.incl', 'sst.excl'])).toEqual([]);
    expect(fam('report.cat', ['broken', 'blocked', 'payment', 'cable', 'other'])).toEqual([]);
    expect(fam('push.cat', ['charging', 'payments', 'reservations', 'account', 'promotions'])).toEqual([]);
    expect(fam('settings.theme', ['system', 'light', 'dark'])).toEqual([]);
    expect(fam('maps', ['google', 'apple', 'waze'])).toEqual([]);
    expect(fam('tabs', ['map', 'activity', 'account', 'scan'])).toEqual([]);
    expect(fam('delete.deleted', ['phone', 'name', 'cards', 'favourites', 'push'])).toEqual([]);
    expect(fam('rate.reason', ['start_failed', 'slow', 'stopped', 'price', 'location'])).toEqual([]);
    expect(fam('fees', ['session', 'admin', 'idle', 'time'])).toEqual([]);
  });
});
