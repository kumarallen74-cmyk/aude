import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The driver app's English: its DICT (exact texts) and PATTERNS (applied in order, as tText does)
 * run over the app's own Indonesian messages. A catch-all word pattern placed before a specific
 * sentence once turned "Bayar sekarang dengan GoPay" into "Pay sekarang dengan GoPay": every
 * message here must come out with no Indonesian left in it.
 */
const html = readFileSync(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf8');
const src = html.slice(html.indexOf('var DICT'), html.indexOf('function tText'));
const { DICT, PATTERNS } = new Function(`${src}; return { DICT, PATTERNS };`)() as { DICT: Record<string, string>; PATTERNS: Array<[RegExp, string]> };
const tr = (raw: string) => {
  const key = raw.trim();
  if (DICT[key] !== undefined) return DICT[key]!;
  let v = raw;
  for (const [re, rep] of PATTERNS) { re.lastIndex = 0; if (re.test(v)) { re.lastIndex = 0; v = v.replace(re, rep); } }
  return v;
};
const INDONESIAN = /\b(yang|dengan|sekarang|sudah|belum|tagihan|metode|lain|aplikasi|kartu|Anda|Tidak|tidak|Bayar|Dibayar|ditagih|Konfirmasi|ulang|pengisian|Terima kasih|Penahanan|Tautan|Saldo|atau|lagi|sesi|dan|bisa|dipakai|ditolak)\b/;

const MESSAGES = [
  // cost during the charge
  'biaya sejauh ini', 'Biaya sejauh ini Rp 23.415 dari Rp 50.000 dibayar', 'Termasuk pajak Rp 2.870', 'Hemat Rp 4.200',
  'Biaya parkir Rp 12.000: mobil tidak mengisi selama 12 menit. Cabut untuk menghentikannya.',
  // signed meter data on the receipt
  'Meter bertanda tangan', 'Terverifikasi', 'Cocok', 'Tidak cocok', 'Tidak sah', 'Tidak lengkap', 'Tidak ada',
  // bidirectional charging (V2G / V2B)
  'Kembalikan energi ke lokasi (V2G)', 'Mobil Anda bisa mengembalikan listrik saat beban puncak lokasi.',
  'Kredit Rp 2.000 per kWh. Baterai tidak turun di bawah 50%, dan tidak dalam satu jam sebelum Anda pergi.',
  'Batas baterai', 'Izinkan', 'Diizinkan', 'Diatur oleh armada Anda.', 'Kredit energi dikembalikan', 'Sedang mengembalikan 11 kW', 'Sedang mengembalikan 7,4 kW',
  'Dikembalikan 2,00 kWh · kredit Rp 4.000', 'Baterai sudah di batas 40%', 'Di luar jam pengembalian energi', 'Kurang dari satu jam sebelum Anda pergi',
  'Level baterai belum diketahui', 'Charger ini belum mendukung', 'Mobil tidak menawarkan pengembalian energi', 'Lokasi sedang tidak membutuhkan energi', 'Menunggu giliran',
  // unpaid sessions and paying them in the app
  'Bayar sekarang dengan GoPay', 'Bayar dengan metode lain · Rp 14.652', 'Bayar sekarang · Rp 14.652', 'Bayar Rp 14.652', 'Konfirmasi ulang di GoPay', 'Konfirmasi di GoPay',
  'Penahanan Rp 50.000 di kartu Anda berakhir di bank sebelum biaya pengisian Rp 14.652 ditagih, jadi tidak ada yang diambil dan dana yang ditahan sudah kembali. Bayar sesi ini sekarang di aplikasi.',
  'Tautan GoPay Anda sudah tidak aktif, jadi belum ada yang ditagih. Bayar sesi ini sekarang dengan metode lain.',
  'Saldo GoPay Anda tidak cukup untuk tagihan ini. Isi saldo lalu bayar sekarang, atau bayar dengan metode lain.',
  'Penagihan ke GoPay belum berhasil. Coba bayar sekarang, atau bayar dengan metode lain.',
  'Konfirmasi pembayaran di aplikasi GoPay, atau bayar dengan metode lain.',
  'Konfirmasi PIN GoPay sudah kedaluwarsa, jadi belum ada yang ditagih. Konfirmasi ulang sekarang, atau bayar dengan metode lain.',
  'Konfirmasi PIN GoPay ditolak, jadi belum ada yang ditagih. Coba konfirmasi lagi, atau bayar dengan metode lain.',
  'Konfirmasi PIN GoPay dibatalkan, jadi belum ada yang ditagih. Konfirmasi lagi, atau bayar dengan metode lain.',
  'Penahanan kartu Anda berakhir sebelum biaya ditagih; Anda sudah membayar sesi ini di aplikasi (QRIS). Terima kasih.',
  'Tautan e-wallet Anda sudah tidak aktif saat penagihan; Anda sudah membayar sesi ini di aplikasi (QRIS). Terima kasih.',
  'Penagihan ke e-wallet Anda tidak berhasil; Anda sudah membayar sesi ini di aplikasi (QRIS). Terima kasih.',
  'Anda memilih metode lain daripada konfirmasi PIN e-wallet; Anda sudah membayar sesi ini di aplikasi (QRIS). Terima kasih.',
  'Konfirmasi PIN e-wallet Anda kedaluwarsa; Anda sudah membayar sesi ini di aplikasi (QRIS). Terima kasih.',
  'Konfirmasi PIN e-wallet Anda ditolak; Anda sudah membayar sesi ini di aplikasi (QRIS). Terima kasih.',
  'Anda membatalkan konfirmasi PIN e-wallet; Anda sudah membayar sesi ini di aplikasi (QRIS). Terima kasih.',
  'Ditagih langsung dari e-wallet Anda yang terhubung sebesar tagihan sesi ini, tanpa membuka aplikasinya.', 'Dibayar dengan kartu tersimpan Anda sebesar tagihan sesi ini.',
  'Anda diarahkan ke halaman kartu yang aman (3-D Secure) untuk membayar tagihan sesi ini. Nomor kartu tidak disimpan PlugSure.',
  'Tidak ditagih dari kartu Anda', 'Dibayar di aplikasi: Rp 14.652', 'Bayar sesi pengisian', 'Belum terbayar', 'QRIS · sesi pengisian', 'Pembayaran berhasil. Terima kasih.',
  'Setelah membayar, kembali ke sini: struk sesi Anda diperbarui.', 'Sesi belum dibayar', '3 sesi belum dibayar', '1 sesi', '12 sesi', 'Terbaru: ', 'Bayar', 'Bayar sesi ini dari struk.', 'Bayar · lihat struk', 'Belum terbayar: Rp 21.340',
  // ended links and saved cards
  'Tautan GoPay Anda sudah tidak aktif: diputus di aplikasi GoPay atau kedaluwarsa. Tidak ada yang ditagih. Hubungkan GoPay lagi, atau pilih metode lain.',
  'Tautan GoPay Anda sudah tidak aktif: diputus di aplikasi GoPay atau kedaluwarsa, jadi tidak ada yang ditagih. Hubungkan GoPay lagi saat memilih pembayaran di charger, lalu bayar dari struk ini.',
  'Tautan e-wallet ini sudah tidak aktif. Hubungkan lagi, atau pilih metode lain.',
  'Mastercard •••• 1117 yang tersimpan sudah tidak bisa dipakai: dihapus atau kedaluwarsa di penyedia pembayaran. Tidak ada yang ditagih. Bayar dengan kartu (bisa disimpan lagi), atau pilih metode lain.',
  'Visa •••• 4242 yang tersimpan sudah kedaluwarsa. Tidak ada yang ditagih. Bayar dengan kartu lain (bisa disimpan lagi), atau pilih metode lain.',
  // older ones the catch-all word patterns used to cut in half
  'Kartu ditolak (202 deny). Coba kartu lain atau metode lain.', 'Kartu ini tersimpan di operator lain dan tidak bisa dipakai di sini.', 'Bayar langganan · Pass 30',
  // automatic renewal, switching plans, loyalty points
  'Diperpanjang otomatis dengan GoPay ••••7890', 'Matikan', 'Perpanjang otomatis', 'Perpanjangan otomatis aktif.', 'Perpanjangan otomatis dimatikan.',
  'Perpanjangan terakhir belum berhasil. Kami coba lagi, atau perpanjang sekarang.', 'Perpanjangan menunggu konfirmasi Anda di GoPay.', 'Konfirmasi di GoPay',
  'Simpan kartu atau hubungkan e-wallet saat membayar untuk perpanjangan otomatis.', 'Ganti ke paket ini', 'Pilih kartu atau e-wallet untuk perpanjangan:',
  'Perpanjang otomatis dengan kartu tersimpan atau e-wallet terhubung',
  'Sisa hari paket Anda: potongan Rp 66.666. Bayar Rp 147.000.', 'Sisa hari paket Anda menutup paket ini: gratis, berlaku 40 hari.', 'Paket diganti. Berlaku sampai 7 Nov 2026.',
  'Berlaku 30 hari. Perpanjang sendiri, atau otomatis dengan kartu tersimpan atau e-wallet terhubung. Ganti paket kapan saja: sisa hari paket lama menjadi potongan. Harga member otomatis berlaku saat mengisi di operator tersebut.',
  'Poin', 'Poin dipakai', 'Poin diperoleh', '+123 poin', '1.250 poin', '300 poin kedaluwarsa 12 Okt', 'Pakai poin otomatis saat mengisi', 'Riwayat poin',
  '1 poin per Rp 1.000. 1 poin = Rp 10, paling banyak 50% biaya energi dan layanan, sebelum pajak.', 'Diperoleh · 28 Sep', 'Dipakai · 29 Sep',
  // site queues
  'Antrean', 'Gabung antrean', 'Keluar antrean', 'Lihat antrean', 'Konektor apa saja', 'Anda dalam antrean', 'Anda masuk antrean.', 'Anda keluar dari antrean.',
  'Giliran Anda!', 'Lewati', 'Giliran dilewati.', 'Ke-3 dalam antrean', '12 menunggu', 'Waktu mulai: 5 menit', 'Antre paling lama sampai 14.30',
  'Saat konektor yang cocok kosong, charger menahannya untuk pengemudi pertama di antrean.',
  'Giliran Anda terlewat', 'Konektor diberikan ke pengemudi berikutnya karena tidak dipakai tepat waktu.', 'Antrean berakhir', 'Batas waktu menunggu habis.',
  'Dikeluarkan dari antrean', 'Operator mengeluarkan Anda dari antrean.', 'Antrean ditutup', 'Lokasi ini tidak memakai antrean lagi.',
  'Lokasi ini tidak memakai antrean.', 'Masuk dengan nomor HP atau kartu armada untuk ikut antrean.', 'Anda sudah dalam antrean di lokasi lain.', 'Antrean sedang penuh.',
  'Ada konektor kosong. Langsung isi saja.', 'Tidak ada konektor yang sedang beroperasi.', 'Lokasi tidak ditemukan.', 'Pilih AC atau DC.',
  'Anda sudah punya reservasi aktif. Pakai atau batalkan dulu.', 'Tidak ada konektor yang cocok yang sedang beroperasi di lokasi ini.',
  'Ada konektor kosong yang cocok. Langsung isi saja.', 'Antrean sedang penuh. Coba lagi nanti.', 'Anda sudah dalam antrean.', 'Antrean tidak ditemukan.',
  'Ada pengemudi yang sedang antre untuk konektor ini. Gabung antrean di halaman stasiun.',
  // map groups; reserving partner chargers
  'Beberapa stasiun berdekatan', '44 stasiun lain di sini · lihat Daftar', 'Charger mitra dipesan', 'Charger mitra dipesan.', 'Menunggu jawaban charger…', 'Pesan 15 menit',
  'Operator ini tidak menerima reservasi.', 'Charger menolak reservasi.', 'Operator menolak reservasi.', 'Operator mitra sedang tidak dapat dihubungi. Coba lagi nanti.',
  'Charger ini sedang tidak tersedia untuk dipesan.', 'Anda sedang dalam antrean. Keluar antrean dulu untuk memesan.',
  'Charger sedang dipakai.', 'Charger sedang tidak berfungsi.', 'Charger tidak merespons.',
  // reservation fees
  'Biaya reservasi Rp 5.550', '(termasuk PPN)', 'Ditagihkan ke perusahaan Anda.', 'Dibayar sekarang.', 'Tidak dikembalikan setelah konektor ditahan, kecuali dibatalkan dalam 2 menit.',
  'Bayar biaya reservasi', 'QRIS · biaya reservasi', 'GoPay · Biaya reservasi', 'Setelah membayar, kembali ke sini: charger langsung menahan konektor untuk Anda.',
  'Pembayaran tidak selesai. Konektor tidak dipesan.', 'Charger menolak reservasi. Biaya reservasi dikembalikan.', 'Konektor ini baru saja dipesan orang lain. Biaya reservasi dikembalikan.',
  'Konektor sedang dipakai. Biaya reservasi dikembalikan.', 'Biaya reservasi dibayar dengan kartu tersimpan Anda.',
  'Ditagih langsung dari e-wallet Anda yang terhubung sebesar biaya reservasi, tanpa membuka aplikasinya.',
];

test('driver app English: each message is fully translated through DICT and PATTERNS in order', () => {
  const mixed = MESSAGES.map((m) => ({ m, out: tr(m) })).filter(({ m, out }) => out === m || INDONESIAN.test(out));
  assert.deepEqual(mixed, []);
});

test('driver app English: counted sessions take the plural', () => {
  assert.deepEqual(['1 sesi', '12 sesi', '3 sesi belum dibayar'].map(tr), ['1 session', '12 sessions', '3 unpaid sessions']);
});

test('driver app English: the catch-all word patterns come after every specific pattern', () => {
  const last = PATTERNS.slice(-3).map(([re]) => re.source);
  assert.deepEqual(last, ['\\bsesi\\b', 'Kartu ', '\\bBayar ']);
});
