import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EN, toEnglish, localizeBody, localizeMessage, acceptLanguages, driverLang, hasTranslatable } from './i18n.js';

/**
 * The driver API in English (driver/i18n.ts): every Indonesian sentence a driver module can send has an English
 * version with no Indonesian left in it; Indonesian answers are untouched; the request's language is the app's choice,
 * then the device's, then the operator's default.
 */
const INDONESIAN = /\b(yang|dengan|sekarang|sudah|belum|tagihan|metode|lain|aplikasi|kartu|Kartu|Anda|Tidak|tidak|Bayar|Dibayar|ditagih|Konfirmasi|ulang|pengisian|Penahanan|Tautan|Saldo|atau|lagi|sesi|dan|bisa|dipakai|ditolak|Charger ini|Konektor|tersedia|ditemukan|Masuk|Coba|Hubungi|antrean|reservasi|Reservasi|Biaya|Sedang|sedang|Operator mitra|kode|Kode|nomor|Nomor|Pembayaran|pembayaran|Menunggu|Langganan|Paket|Lokasi|Stasiun|Jumlah|Terlalu|percobaan|perpanjangan)\b/;

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SOURCES = [
  './charge.ts', './roaming.ts', './roaming-pay.ts', './reservations.ts', './membership.ts', './queue.ts', './identity.ts',
  './wallets.ts', './favourites.ts', './stations.ts', './server.ts', './map.ts', './links.ts', './account-deletion.ts', './idempotency.ts',
  '../services/payments/registry.ts', '../services/payments/cards.ts', '../services/payments/provider.ts', '../services/loyalty.ts', '../services/benefits.ts',
];

/** Single-quoted sentences in code (not comments) that read as Indonesian: the driver modules' plain messages. */
function plainMessages(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const f of SOURCES) {
    for (const raw of readFileSync(here(f), 'utf8').split('\n')) {
      const line = raw.trim();
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
      for (const m of line.matchAll(/'((?:[^'\\]|\\.){6,})'/g)) {
        const text = m[1]!.replace(/\\'/g, "'");
        if (/\.$/.test(text) && INDONESIAN.test(text) && !/^(SELECT|UPDATE|INSERT|DELETE)\b/.test(text)) out.push({ file: f, text });
      }
    }
  }
  return out;
}

describe('driver messages in English', () => {
  test('the scan finds the driver modules\' messages (it is not vacuous)', () => {
    assert.ok(plainMessages().length > 100, `only ${plainMessages().length} messages found`);
  });

  test('every plain Indonesian message in the driver modules has English with no Indonesian left', () => {
    const missing = plainMessages().filter((m) => INDONESIAN.test(toEnglish(m.text))).map((m) => `${m.file}: ${m.text} → ${toEnglish(m.text)}`);
    assert.deepEqual(missing, []);
  });

  test('one voice: where the app translates the same message itself, the server says it the same way', () => {
    const html = readFileSync(here('../driver-web/index.html'), 'utf8');
    const { DICT } = new Function(`${html.slice(html.indexOf('var DICT'), html.indexOf('function tText'))}; return { DICT };`)() as { DICT: Record<string, string> };
    const differ = Object.entries(EN).filter(([id, en]) => DICT[id] !== undefined && DICT[id] !== en);
    assert.deepEqual(differ, []);
  });

  test('every dictionary entry is English', () => {
    const bad = Object.entries(EN).filter(([, en]) => INDONESIAN.test(en));
    assert.deepEqual(bad, []);
  });

  const TEMPLATED: Array<[string, string]> = [
    ['GoPay tidak tersedia di operator ini.', 'GoPay is not available at this operator.'],
    ['PayNow tidak tersedia di operator ini.', 'PayNow is not available at this operator.'],
    ['GoPay terhubung tidak tersedia di operator ini.', 'Linked GoPay is not available at this operator.'],
    ['OVO tidak bisa dihubungkan di operator ini.', 'OVO cannot be linked at this operator.'],
    ['DANA tidak bisa dihubungkan sekarang. Coba lagi nanti.', 'DANA cannot be linked right now. Try again later.'],
    ['Pembayaran GoPay ditolak (insufficient). Periksa saldo, atau pilih metode lain.', 'The GoPay payment was declined (insufficient). Check your balance, or choose another method.'],
    ['Pembayaran GrabPay ditolak. Periksa saldo, atau pilih metode lain.', 'The GrabPay payment was declined. Check your balance, or choose another method.'],
    ['Kartu ditolak (card_declined). Coba kartu lain atau metode lain.', 'Card declined (card_declined). Try another card or another method.'],
    ['Saldo GoPay Anda (Rp 40.000) kurang dari batas yang dipilih. Pilih jumlah lebih kecil atau isi saldo.', 'Your GoPay balance (Rp 40.000) is less than the chosen limit. Choose a smaller amount or top up.'],
    ['Tautan GoPay Anda sudah tidak aktif: diputus di aplikasi GoPay atau kedaluwarsa. Tidak ada yang ditagih. Hubungkan GoPay lagi, atau pilih metode lain.',
      'Your GoPay link is no longer active: it was disconnected in the GoPay app or has expired. Nothing was charged. Link GoPay again, or choose another method.'],
    ['Visa •••• 4242 yang tersimpan sudah kedaluwarsa. Tidak ada yang ditagih. Bayar dengan kartu lain (bisa disimpan lagi), atau pilih metode lain.',
      'Your saved Visa •••• 4242 has expired. Nothing was charged. Pay with another card (you can save it again), or choose another method.'],
    ['Batas biaya kartu armada Anda dalam IDR; charger ini menagih dalam SGD.', 'Your fleet card\'s spending limit is in IDR; this charger charges in SGD.'],
    ['Batas biaya kartu armada Anda dalam MYR; jaringan ini menagih dalam mata uang lain.', 'Your fleet card\'s spending limit is in MYR; this network charges in another currency.'],
    ['Batas per transaksi S$ 500.00.', 'The limit per transaction is S$ 500.00.'],
    ['Reservasi Anda sudah 3x tidak dipakai hari ini. Coba lagi besok, atau langsung isi di charger.', 'Your reservations went unused 3 times today. Try again tomorrow, or charge at the charger directly.'],
    ['Konektor sedang dipakai. Coba konektor lain.', 'The connector is in use. Try another connector.'],
    ['Charger ini sementara tidak dapat dipesan. Biaya reservasi dikembalikan.', 'This charger cannot be reserved at the moment. The reservation fee is refunded.'],
    ['Perpanjangan otomatis sedang menunggu konfirmasi Anda di GrabPay. Selesaikan di sana (lihat Akun), atau tunggu sampai kedaluwarsa.',
      'Automatic renewal is waiting for your confirmation in GrabPay. Finish it there (see Account), or wait until it expires.'],
    ['Charger ini dikelola operator lain, bukan VoltSG.', 'This charger is run by another operator, not VoltSG.'],
    ['Operator menolak permintaan (rejected). Coba tempelkan kartu Anda di charger.', 'The operator refused the request (rejected). Try tapping your card on the charger.'],
    ['Organisasi, nomor kartu, atau PIN salah. Setelah 5 kali salah, kartu dikunci 15 menit. Jika masih gagal, hubungi admin armada Anda.',
      'Wrong organisation, card number or PIN. After 5 wrong attempts the card is locked for 15 minutes. If it still fails, contact your fleet administrator.'],
  ];
  for (const [id, en] of TEMPLATED) test(`templated: ${id.slice(0, 60)}…`, () => assert.equal(toEnglish(id), en));

  test('labels: fees and the card method', () => {
    for (const l of ['Biaya layanan', 'Biaya admin', 'Biaya parkir', 'Biaya tetap', 'Biaya waktu', 'Biaya reservasi', 'Kartu kredit / debit']) {
      assert.ok(!INDONESIAN.test(toEnglish(l)), `${l} → ${toEnglish(l)}`);
    }
  });
});

describe('answers', () => {
  const body = {
    ok: false, error: 'Pembayaran belum tersedia di charger ini.', code: 'x',
    stations: [{ name: 'Sedang dipakai.', reason: 'Sementara tidak beroperasi.', fees: [{ label: 'Biaya layanan', rate: 1 }] }],
  };

  test('Indonesian: the answer is the very same object, byte for byte', () => {
    assert.equal(localizeBody(body, 'id'), body);
    assert.equal(localizeMessage('Kode salah. Coba lagi.', 'id'), 'Kode salah. Coba lagi.');
  });

  test('English: every message in a nested answer, other values kept', () => {
    const en = localizeBody(body, 'en');
    assert.equal(en.error, 'Payments are not available at this charger yet.');
    assert.equal(en.code, 'x');
    assert.equal(en.stations[0]!.reason, 'Temporarily out of service.');
    assert.equal(en.stations[0]!.fees[0]!.label, 'Service fee');
    assert.equal(en.stations[0]!.fees[0]!.rate, 1);
    assert.equal(body.error, 'Pembayaran belum tersedia di charger ini.', 'the original is not changed');
  });

  test('data and English text pass through; only answers with a message are looked at', () => {
    assert.equal(toEnglish('Plaza Senayan Level B2'), 'Plaza Senayan Level B2');
    assert.equal(toEnglish('This charger is temporarily out of service.'), 'This charger is temporarily out of service.');
    assert.equal(hasTranslatable({ stations: [{ name: 'Marina Bay', priceFrom: { minor: 59, currency: 'SGD' } }] }), false);
    assert.equal(hasTranslatable({ error: 'Kode salah. Coba lagi.' }), true);
    const d = new Date();
    assert.equal(localizeBody({ at: d }, 'en').at, d);
  });
});

describe('the language of a request', () => {
  const req = (h: Record<string, string>, extra: Record<string, unknown> = {}) => ({ headers: h, url: '/d/v1/me', body: null, params: {}, brand: null, ...extra }) as any;

  test('the app\'s choice wins over the device', async () => {
    assert.equal(await driverLang(req({ 'x-driver-lang': 'id', 'accept-language': 'en-GB,en;q=0.9' })), 'id');
    assert.equal(await driverLang(req({ 'x-driver-lang': 'en', 'accept-language': 'id-ID' })), 'en');
  });

  test('the native app\'s Malay and Chinese get English until the server has them (G16 hook)', async () => {
    assert.equal(await driverLang(req({ 'x-driver-lang': 'ms', 'accept-language': 'id-ID' })), 'en');
    assert.equal(await driverLang(req({ 'x-driver-lang': 'zh-Hans', 'accept-language': 'id-ID' })), 'en');
    assert.equal(await driverLang(req({ 'x-driver-lang': 'xx', 'accept-language': 'id-ID' })), 'id');
  });

  test('then the device (Malay reads as English); nothing at all: Indonesian', async () => {
    assert.deepEqual(acceptLanguages('ms-MY,zh;q=0.8,id;q=0.5'), ['en', 'id']);
    assert.deepEqual(acceptLanguages('*'), []);
    assert.equal(await driverLang(req({ 'accept-language': 'en-SG,en;q=0.9' })), 'en');
    assert.equal(await driverLang(req({ 'accept-language': '*' })), 'id');
    assert.equal(await driverLang(req({})), 'id');
  });
});
