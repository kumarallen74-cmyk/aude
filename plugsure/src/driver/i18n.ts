import type { FastifyRequest } from 'fastify';
import { one } from '../db/pool.js';
import { isLang, type Lang } from '../domain/locale.js';

/**
 * The driver API's messages in the driver's language (docs/MULTI-COUNTRY-DESIGN.md §D10).
 *
 * The driver modules (charge, reservations, queue, roaming, passes, payments) write their messages in Indonesian, the
 * exact text v1.6 sent: the Indonesian pilot's app, tests and the app's own translation patterns match it. A driver whose
 * language is English (Malaysia and Singapore by default) gets the same message in English: every JSON answer under /d/
 * passes through localizeBody() just before it is serialised. Indonesian answers are not touched at all.
 *
 * The language of a request (driverLang): the app's X-Driver-Lang header (the driver's choice → the device's language →
 * the operator's default, worked out by the app) → Accept-Language → the white-label operator's default language → the
 * country of the charger or site the request names (MY, SG → English) → Indonesian.
 *
 * Adding a driver-facing message: add its English here (EN, or EN_PATTERNS when it carries a value). The unit test
 * (i18n.test.ts) scans the driver modules and fails on an Indonesian message with no English.
 */

/** Exact messages. */
export const EN: Readonly<Record<string, string>> = Object.freeze({
  // charging, payments
  'Charger ini tidak lagi beroperasi.': 'This charger is no longer in service.',
  'Charger ini sementara tidak beroperasi.': 'This charger is temporarily out of service.',
  'Konektor ini sedang tidak dapat menjual energi.': 'This connector cannot sell energy at the moment.',
  'Kartu armada Anda diblokir. Hubungi admin armada Anda.': 'Your fleet card is blocked. Contact your fleet admin.',
  'Kartu armada Anda sudah kedaluwarsa. Hubungi admin armada Anda.': 'Your fleet card has expired. Contact your fleet admin.',
  'Batas energi kartu armada Anda sudah tercapai.': 'Your fleet card has reached its energy limit.',
  'Batas biaya kartu armada Anda sudah tercapai.': 'Your fleet card has reached its spend limit.',
  'Jumlah tidak valid.': 'Invalid amount.',
  'Konektor tidak ditemukan.': 'Connector not found.',
  'Jumlah ini belum menutup biaya tetap, jadi belum ada energi yang bisa dibeli.': 'This amount does not cover the fixed fees yet, so it would buy no energy.',
  'Pembayaran belum tersedia di charger ini.': 'Payments are not available at this charger yet.',
  'Pembayaran belum tersedia di operator ini.': 'Payments are not available at this operator yet.',
  'Masuk sebagai pengemudi armada terlebih dahulu.': 'Sign in as a fleet driver first.',
  'Charger ini bukan milik armada Anda.': 'This charger isn’t part of your fleet’s network.',
  'Konektor ini sedang dipesan pengemudi lain.': 'This connector is reserved by another driver.',
  'Transaksi tidak ditemukan.': 'Transaction not found.',
  'Menunggu konfirmasi pembayaran dari penyedia QRIS.': 'Waiting for the payment provider to confirm the payment.',
  'Menunggu konfirmasi pembayaran dari penyedia.': 'Waiting for the payment provider to confirm the payment.',
  'Tidak ada tagihan yang perlu dibayar untuk sesi ini.': 'There is nothing to pay for this session.',
  'Belum ada pembayaran untuk tagihan ini.': 'There is no payment for this bill yet.',
  'Sesi ini sudah dimulai.': 'This session has already started.',
  'Pembayaran belum diterima.': 'The payment has not been received yet.',
  'Token pembayaran ini sudah digunakan.': 'This payment has already been used.',
  'Charger ini tidak lagi beroperasi; sesi tidak dapat dimulai. Pembayaran yang tidak terpakai akan dikembalikan.':
    'This charger is no longer in service, so the session can’t start. Any unused payment will be refunded.',
  'Charger ini sementara tidak beroperasi; sesi tidak dapat dimulai. Pembayaran yang tidak terpakai akan dikembalikan.':
    'This charger is temporarily out of service, so the session can’t start. Any unused payment will be refunded.',
  'Pengisian belum dimulai.': 'Charging has not started yet.',
  'Tidak ada sesi aktif untuk dihentikan.': 'No active session to stop.',
  'Charger sedang luring. Cabut konektor untuk menghentikan.': 'The charger is offline. Unplug the connector to stop.',
  'Sesi belum siap dihentikan.': 'The session is not ready to be stopped yet.',
  'Gagal menghentikan. Coba lagi.': 'Could not stop. Try again.',
  'Bukan pembayaran setelah pengisian.': 'This is not a pay-after-charging payment.',
  'Bukan transaksi prabayar.': 'This is not a prepaid transaction.',
  'Belum ada tagihan untuk sesi ini.': 'There is no bill for this session yet.',
  'Pembayaran belum berhasil. Periksa saldo e-wallet Anda, lalu coba lagi.': 'The payment has not gone through. Check your e-wallet balance, then try again.',
  'Kode promo tidak berlaku untuk pengisian ini.': 'This promo code does not apply to this charge.',
  'Kode promo tidak dikenal.': 'Unknown promo code.',
  // saved cards, linked e-wallets
  'E-wallet terhubung tidak bisa dipakai di operator ini.': 'Linked e-wallets cannot be used at this operator.',
  'Kartu tersimpan tidak bisa dipakai di operator ini.': 'Saved cards cannot be used at this operator.',
  'Kartu tidak ditemukan.': 'Card not found.',
  'Kartu ini tersimpan di operator lain dan tidak bisa dipakai di sini.': 'This card is saved at another operator and cannot be used here.',
  'Kartu ini sudah kedaluwarsa. Bayar dengan kartu baru.': 'This card has expired. Pay with a new card.',
  'Kartu ini tidak bisa dipakai lagi. Simpan ulang kartu Anda.': 'This card can no longer be used. Save your card again.',
  'E-wallet tidak ditemukan.': 'E-wallet not found.',
  'Tautan e-wallet ini sudah tidak aktif. Hubungkan lagi, atau pilih metode lain.': 'This e-wallet link is no longer active. Link it again, or choose another method.',
  'E-wallet ini belum terhubung. Setujui dulu di aplikasinya.': 'This e-wallet is not linked yet. Approve it in its app first.',
  'E-wallet ini perlu dihubungkan ulang.': 'This e-wallet needs to be linked again.',
  'E-wallet ini terhubung di operator lain dan tidak bisa dipakai di sini.': 'This e-wallet is linked at another operator and cannot be used here.',
  'Masuk dengan nomor HP untuk menghubungkan e-wallet.': 'Sign in with your phone number to link an e-wallet.',
  'Charger atau paket tidak ditemukan.': 'Charger or plan not found.',
  'Kartu kredit / debit': 'Credit / debit card',
  // reservations
  'Reservasi tidak tersedia.': 'Reservations aren’t available.',
  'Masuk dengan nomor HP atau kartu armada untuk memesan.': 'Sign in with a phone number or fleet card to reserve.',
  'Konektor ini sedang tidak dapat dipakai.': 'This connector can’t be used right now.',
  'Charger sedang luring; tidak dapat dipesan.': 'The charger is offline; it can’t be reserved.',
  'Konektor ini sedang tidak tersedia untuk dipesan.': 'This connector can’t be reserved right now.',
  'Anda sudah punya reservasi aktif. Batalkan dulu untuk memesan yang lain.': 'You already have a reservation. Cancel it before reserving another.',
  'Konektor ini baru saja dipesan orang lain.': 'Someone else just reserved this connector.',
  'Konektor sedang dipakai.': 'The connector is in use.',
  'Konektor sedang tidak berfungsi.': 'The connector is not working.',
  'Charger menolak reservasi.': 'The charger refused the reservation.',
  'Reservasi tidak ditemukan.': 'Reservation not found.',
  'Charger ini sementara tidak dapat dipesan.': 'This charger cannot be reserved at the moment.',
  'Charger menolak reservasi. Biaya reservasi dikembalikan.': 'The charger refused the reservation. The reservation fee is refunded.',
  'Biaya reservasi': 'Reservation fee',
  // queues
  'Lokasi ini tidak memakai antrean.': 'This site doesn’t use a queue.',
  'Masuk dengan nomor HP atau kartu armada untuk ikut antrean.': 'Sign in with a phone number or fleet card to join the queue.',
  'Anda sudah dalam antrean di lokasi lain.': 'You’re already in the queue at another site.',
  'Anda sudah dalam antrean.': 'You’re already in the queue.',
  'Tidak ada konektor yang sedang beroperasi.': 'No connector is working right now.',
  'Lokasi tidak ditemukan.': 'Site not found.',
  'Anda sudah punya reservasi aktif. Pakai atau batalkan dulu.': 'You already have a reservation. Use or cancel it first.',
  'Tidak ada konektor yang cocok yang sedang beroperasi di lokasi ini.': 'No suitable connector is working at this site.',
  'Ada konektor kosong yang cocok. Langsung isi saja.': 'A suitable connector is free. Just start charging.',
  'Ada konektor kosong. Langsung isi saja.': 'A connector is free. Just start charging.',
  'Antrean sedang penuh. Coba lagi nanti.': 'The queue is full. Try again later.',
  'Antrean sedang penuh.': 'The queue is full.',
  'Antrean tidak ditemukan.': 'Queue place not found.',
  'Ada pengemudi yang sedang antre untuk konektor ini. Gabung antrean di halaman stasiun.': 'Drivers are queueing for this connector. Join the queue on the station page.',
  'Anda sedang dalam antrean. Keluar antrean dulu untuk memesan.': 'You’re in a queue. Leave it first to reserve.',
  // partner networks (roaming)
  'Masuk untuk mengisi di jaringan mitra.': 'Sign in to charge on partner networks.',
  'Jaringan mitra tersedia untuk pengemudi armada dengan kartu roaming.': 'The partner network is available to fleet drivers with a roaming card.',
  'Kartu Anda belum diaktifkan untuk jaringan mitra. Hubungi admin armada Anda.': 'Your card isn’t enabled for the partner network yet. Contact your fleet admin.',
  'Charger mitra tidak ditemukan.': 'Partner charger not found.',
  'Charger ini sedang tidak tersedia.': 'This charger isn’t available right now.',
  'Operator menolak permintaan. Dana yang ditahan sudah dilepas.': 'The operator refused the request. The hold has been released.',
  'Operator mitra sedang tidak dapat dihubungi. Coba tempelkan kartu Anda di charger.': 'The partner operator can’t be reached. Try tapping your card on the charger.',
  'Charger sedang dipakai.': 'The charger is in use.',
  'Charger sedang tidak berfungsi.': 'The charger isn’t working.',
  'Charger tidak merespons.': 'The charger isn’t responding.',
  'Charger tidak dapat dimulai.': 'The charger couldn’t be started.',
  'Pembayaran tidak selesai. Tidak ada yang ditagih.': 'The payment did not complete. Nothing was charged.',
  'Charger tidak dapat dimulai. Dana yang ditahan sudah dilepas.': 'The charger couldn’t be started. The hold has been released.',
  'Operator menolak permintaan berhenti. Hentikan dari charger atau cabut konektor.': 'The operator refused the stop request. Stop at the charger or unplug.',
  'Operator mitra sedang tidak dapat dihubungi. Hentikan dari charger.': 'The partner operator can’t be reached. Stop at the charger.',
  'Operator ini tidak menerima reservasi.': 'This operator doesn’t take reservations.',
  'Operator menolak reservasi.': 'The operator refused the reservation.',
  'Reservasi jaringan mitra tersedia untuk pengemudi armada.': 'Partner network reservations are available to fleet drivers.',
  'Charger ini sedang tidak tersedia untuk dipesan.': 'This charger can’t be reserved right now.',
  'Operator mitra sedang tidak dapat dihubungi. Coba lagi nanti.': 'The partner operator can’t be reached. Try again later.',
  'Belum tersedia dengan metode pembayaran Anda.': 'Not available with your payment method yet.',
  'Tagihan jaringan mitra Anda belum lunas. Bayar dulu dari Beranda, lalu coba lagi.': 'A partner network charge of yours is still unpaid. Pay it from Home first, then try again.',
  'Pengisian di jaringan mitra belum tersedia. Hubungi operator.': 'Charging on partner networks is not available yet. Contact the operator.',
  // passes and points
  'Masuk dengan nomor HP untuk berlangganan.': 'Sign in with your phone number to subscribe.',
  'Paket tidak ditemukan.': 'Plan not found.',
  'Langganan tidak ditemukan.': 'Subscription not found.',
  'Pilih kartu tersimpan atau e-wallet terhubung untuk perpanjangan otomatis.': 'Choose a saved card or a linked e-wallet for automatic renewal.',
  'Kartu atau e-wallet ini tidak bisa dipakai di operator ini. Simpan kartu atau hubungkan e-wallet saat membayar.':
    'This card or e-wallet cannot be used at this operator. Save a card or link an e-wallet when you pay.',
  'Masuk dengan nomor HP untuk melihat poin Anda.': 'Sign in with your phone number to see your points.',
  'Masuk dengan nomor HP untuk memakai poin.': 'Sign in with your phone number to use points.',
  'Paket ini tidak ditawarkan lagi.': 'This plan is no longer offered.',
  'Kartu atau e-wallet untuk perpanjangan sudah dihapus.': 'The card or e-wallet chosen for renewal was removed.',
  'Perpanjang di aplikasi agar harga member tetap berlaku.': 'Renew in the app to keep member prices.',
  'enabled harus true atau false.': 'enabled must be true or false.',
  'Operator tidak ditemukan.': 'Operator not found.',
  'Poin tidak aktif di operator ini.': 'Points are not active at this operator.',
  // sign-in
  'Batas pengiriman kode untuk nomor ini hari ini sudah tercapai. Coba lagi besok.': 'The limit of codes sent to this number today has been reached. Try again tomorrow.',
  'Terlalu banyak permintaan kode. Coba lagi nanti.': 'Too many code requests. Try again later.',
  'Terlalu banyak kode salah untuk nomor ini. Coba lagi besok.': 'Too many wrong codes for this number. Try again tomorrow.',
  'Nomor telepon tidak valid.': 'Invalid phone number.',
  'Masuk dengan nomor HP belum tersedia. Hubungi operator.': 'Signing in with a phone number is not available yet. Contact the operator.',
  'Kode tidak dapat dikirim. Coba lagi sebentar lagi.': 'The code could not be sent. Try again in a moment.',
  'Kode sudah tidak berlaku. Minta kode baru.': 'The code is no longer valid. Request a new code.',
  'Kode salah. Coba lagi.': 'Wrong code. Try again.',
  'Terlalu banyak percobaan. Minta kode baru.': 'Too many attempts. Request a new code.',
  'Terlalu banyak percobaan masuk. Coba lagi nanti.': 'Too many sign-in attempts. Try again later.',
  'Terlalu banyak percobaan untuk kartu ini hari ini. Coba lagi besok atau hubungi admin armada Anda.': 'Too many attempts for this card today. Try again tomorrow or contact your fleet administrator.',
  'Masuk dengan nomor HP terlebih dahulu.': 'Sign in with your phone number first.',
  'Tunggu sebentar sebelum meminta kode baru.': 'Wait a moment before requesting a new code.',
  'Jika masih gagal, hubungi admin armada Anda.': 'If it still fails, contact your fleet administrator.',
  // the app itself
  'Kode charger tidak dikenal.': 'Charger code not recognised.',
  'Notifikasi iOS hanya untuk aplikasi operator.': 'iOS notifications are for an operator\'s own app only.',
  'Live Activity hanya untuk aplikasi operator.': 'Live Activities are for an operator\'s own app only.',
  'Stasiun tidak ditemukan.': 'Station not found.',
  // station and connector states, fee labels
  'Sedang tidak dapat digunakan (verifikasi meter).': 'Temporarily unavailable (meter verification).',
  'Sementara tidak beroperasi.': 'Temporarily out of service.',
  'Tidak tersedia.': 'Not available.',
  'Sedang dalam perawatan.': 'Under maintenance.',
  'Konektor ini sedang dalam perawatan.': 'This connector is under maintenance.',
  'Charger sedang luring.': 'The charger is offline.',
  'Sedang dipakai.': 'In use.',
  'Sedang disiapkan.': 'Being prepared.',
  'Charger bermasalah.': 'The charger has a fault.',
  'Sedang dipesan pengemudi lain.': 'Reserved by another driver.',
  'Biaya layanan': 'Service fee',
  'Biaya admin': 'Admin fee',
  'Biaya idle (per menit setelah masa tenggang)': 'Idle fee (per minute after grace period)',
  'Biaya waktu (per menit)': 'Time fee (per minute)',
  'Biaya parkir': 'Parking fee',
  'Biaya tetap': 'Fixed fee',
  'Biaya waktu': 'Time fee',
  // the mobile app (v1.9): map, links, app config, push, live sessions, account deletion
  'bbox harus berupa barat,selatan,timur,utara.': 'bbox must be west,south,east,north.',
  'Area peta terlalu luas untuk zoom ini.': 'The map area is too large for this zoom level.',
  'Terlalu banyak permintaan. Coba lagi sebentar lagi.': 'Too many requests. Try again in a moment.',
  'cursor tidak valid.': 'The cursor is not valid.',
  'zoom harus antara 0 dan 22.': 'zoom must be between 0 and 22.',
  'platform harus ios atau android.': 'platform must be ios or android.',
  'Notifikasi Android hanya untuk aplikasi dengan merek.': 'Android notifications are for a branded app only.',
  'Token notifikasi Android tidak valid.': 'The Android notification token is not valid.',
  'Tidak ada konektor yang tersedia saat ini.': 'No connector is available right now.',
  'Akun belum dapat dihapus: selesaikan tagihan, pengisian, reservasi atau antrean yang masih berjalan terlebih dahulu.':
    'The account cannot be deleted yet: first settle what you owe and end any charge, reservation or queue place still open.',
  'Akun tidak ditemukan.': 'Account not found.',
});

/**
 * Messages that carry a value: anchored, applied to the whole text, first match wins. A payment method, card or
 * e-wallet name and an amount are kept as they are (amounts in a non-IDR currency are already in English format).
 */
export const EN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/^(.+) terhubung tidak tersedia di operator ini\.$/, 'Linked $1 is not available at this operator.'],
  [/^(.+) tidak tersedia di operator ini\.$/, '$1 is not available at this operator.'],
  [/^(.+) tidak bisa dihubungkan di operator ini\.$/, '$1 cannot be linked at this operator.'],
  [/^(.+) tidak bisa dihubungkan sekarang\. Coba lagi nanti\.$/, '$1 cannot be linked right now. Try again later.'],
  [/^Masukkan nomor HP akun (.+) Anda \((.+)\)\.$/, 'Enter the phone number of your $1 account ($2).'],
  [/^Masukkan nomor HP yang terdaftar di (\S+) \((.+)\)\.$/, 'Enter the phone number registered with $1 ($2).'],
  [/^Pembayaran (.+) ditolak( \(.*\))?\. Periksa saldo, atau pilih metode lain\.$/, 'The $1 payment was declined$2. Check your balance, or choose another method.'],
  [/^Kartu ditolak( \(.*\))?\. Coba kartu lain atau metode lain\.$/, 'Card declined$1. Try another card or another method.'],
  [/^Saldo (\S+) Anda \((.+?)\) kurang dari batas yang dipilih ditambah sesi bayar-setelah-selesai Anda yang masih berjalan \((.+?)\)\. Pilih jumlah lebih kecil atau isi saldo\.$/,
    'Your $1 balance ($2) is less than the chosen limit plus your pay-after-charging session still running ($3). Choose a smaller amount or top up.'],
  [/^Saldo (\S+) Anda \((.+?)\) kurang dari batas yang dipilih\. Pilih jumlah lebih kecil atau isi saldo\.$/, 'Your $1 balance ($2) is less than the chosen limit. Choose a smaller amount or top up.'],
  [/^Tautan (\S+) Anda sudah tidak aktif: diputus di aplikasi \S+ atau kedaluwarsa\. Tidak ada yang ditagih\. Hubungkan \S+ lagi, atau pilih metode lain\.$/,
    'Your $1 link is no longer active: it was disconnected in the $1 app or has expired. Nothing was charged. Link $1 again, or choose another method.'],
  [/^Tautan (\S+) Anda sudah tidak aktif: diputus di aplikasi \S+ atau kedaluwarsa, jadi tidak ada yang ditagih\. Hubungkan \S+ lagi saat memilih pembayaran di charger, lalu bayar dari struk ini\.$/,
    'Your $1 link is no longer active: it was disconnected in the $1 app or has expired, so nothing was charged. Link $1 again when you choose how to pay at the charger, then pay from this receipt.'],
  [/^(.+) yang tersimpan sudah kedaluwarsa\. Tidak ada yang ditagih\. Bayar dengan kartu lain \(bisa disimpan lagi\), atau pilih metode lain\.$/,
    'Your saved $1 has expired. Nothing was charged. Pay with another card (you can save it again), or choose another method.'],
  [/^(.+) yang tersimpan sudah tidak bisa dipakai: dihapus atau kedaluwarsa di penyedia pembayaran\. Tidak ada yang ditagih\. Bayar dengan kartu \(bisa disimpan lagi\), atau pilih metode lain\.$/,
    'Your saved $1 can no longer be used: it was removed or has expired at the payment provider. Nothing was charged. Pay by card (you can save it again), or choose another method.'],
  [/^Batas biaya kartu armada Anda dalam (\S+); charger ini menagih dalam (\S+)\.$/, 'Your fleet card\'s spending limit is in $1; this charger charges in $2.'],
  [/^Batas biaya kartu armada Anda dalam (\S+); jaringan ini menagih dalam mata uang lain\.$/, 'Your fleet card\'s spending limit is in $1; this network charges in another currency.'],
  [/^Batas biaya kartu armada Anda dalam (\S+); jaringan ini menagih dalam (\S+)\.$/, 'Your fleet card\'s spending limit is in $1; this network charges in $2.'],
  [/^Batas QRIS per transaksi (.+)\.$/, 'The QRIS limit per transaction is $1.'],
  [/^Batas per transaksi (.+)\.$/, 'The limit per transaction is $1.'],
  [/^Operator menolak permintaan \((.+)\)\. Coba tempelkan kartu Anda di charger\.$/, 'The operator refused the request ($1). Try tapping your card on the charger.'],
  [/^Reservasi Anda sudah (\d+)x tidak dipakai hari ini\. Coba lagi besok, atau langsung isi di charger\.$/, 'Your reservations went unused $1 times today. Try again tomorrow, or charge at the charger directly.'],
  [/^(.+\.) Coba konektor lain\.$/, '$1 Try another connector.'],
  [/^(.+\.) Biaya reservasi dikembalikan\.$/, '$1 The reservation fee is refunded.'],
  [/^Perpanjangan otomatis sedang menunggu konfirmasi Anda di (.+)\. Selesaikan di sana \(lihat Akun\), atau tunggu sampai kedaluwarsa\.$/,
    'Automatic renewal is waiting for your confirmation in $1. Finish it there (see Account), or wait until it expires.'],
  [/^Charger ini dikelola operator lain, bukan (.+)\.$/, 'This charger is run by another operator, not $1.'],
  [/^limit harus antara 1 dan (\d+)\.$/, 'limit must be between 1 and $1.'],
  [/^Organisasi, nomor kartu, atau PIN salah\. Setelah (\d+) kali salah, kartu dikunci (\d+) menit\. Jika masih gagal, hubungi admin armada Anda\.$/,
    'Wrong organisation, card number or PIN. After $1 wrong attempts the card is locked for $2 minutes. If it still fails, contact your fleet administrator.'],
]);

/** One message in English; a text with no English (data, an English message) comes back unchanged. */
export function toEnglish(text: string): string {
  const exact = EN[text];
  if (exact !== undefined) return exact;
  for (const [re, rep] of EN_PATTERNS) {
    if (re.test(text)) {
      const out = text.replace(re, rep);
      // A sentence captured by "… Coba konektor lain." / "… Biaya reservasi dikembalikan." is itself a message.
      return out.replace(/^(.+?\.)( Try another connector\.| The reservation fee is refunded\.)$/, (_m, head: string, tail: string) => toEnglish(head) + tail);
    }
  }
  return text;
}

export function localizeMessage(text: string, lang: Lang): string {
  return lang === 'en' ? toEnglish(text) : text;
}

const MAX_DEPTH = 8;

/** Whether an answer holds any text with an English version (cheap: decides whether the language must be looked up). */
export function hasTranslatable(v: unknown, depth = 0): boolean {
  if (typeof v === 'string') return v.length > 3 && toEnglish(v) !== v;
  if (!v || typeof v !== 'object' || depth > MAX_DEPTH) return false;
  if (Array.isArray(v)) return v.some((x) => hasTranslatable(x, depth + 1));
  if (Object.getPrototypeOf(v) !== Object.prototype) return false;
  for (const k in v as Record<string, unknown>) if (hasTranslatable((v as Record<string, unknown>)[k], depth + 1)) return true;
  return false;
}

/** Every string in a JSON answer, in English (a copy; plain objects and arrays only, anything else kept as is). */
export function localizeBody<T>(v: T, lang: Lang, depth = 0): T {
  if (lang !== 'en') return v;
  if (typeof v === 'string') return toEnglish(v) as unknown as T;
  if (!v || typeof v !== 'object' || depth > MAX_DEPTH) return v;
  if (Array.isArray(v)) return v.map((x) => localizeBody(x, lang, depth + 1)) as unknown as T;
  if (Object.getPrototypeOf(v) !== Object.prototype) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = localizeBody(x, lang, depth + 1);
  return out as T;
}

/** Device languages from Accept-Language, best first ("en-GB,en;q=0.9,id;q=0.8" → en, en, id). Malay reads as English. */
export function acceptLanguages(h: unknown): Lang[] {
  const out: Lang[] = [];
  for (const part of String(h ?? '').split(',')) {
    const tag = part.split(';')[0]!.trim().toLowerCase();
    if (!tag || tag === '*') continue;
    const base = tag.split(/[-_]/)[0]!;
    const l = base === 'ms' ? 'en' : base;
    if (isLang(l)) out.push(l);
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENGLISH_COUNTRIES = new Set(['MY', 'SG']);

/** The country of the charger or site a request names (body.connectorId, :id of /connectors/, siteId), if any. */
async function requestCountry(req: FastifyRequest): Promise<string | null> {
  const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const p = (req.params ?? {}) as Record<string, unknown>;
  const connectorId = typeof b.connectorId === 'string' ? b.connectorId : /\/connectors\//.test(req.url) && typeof p.id === 'string' ? p.id : null;
  if (connectorId && UUID.test(connectorId)) {
    const r = await one<{ c: string }>(
      `SELECT s.country_code AS c FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id WHERE c.id = $1`,
      [connectorId]).catch(() => null);
    if (r) return r.c;
  }
  const siteId = typeof b.siteId === 'string' ? b.siteId : typeof p.siteId === 'string' ? p.siteId : null;
  if (siteId && UUID.test(siteId)) return (await one<{ c: string }>(`SELECT country_code AS c FROM site WHERE id = $1`, [siteId]).catch(() => null))?.c ?? null;
  return null;
}

/** The language of a driver API request (see the header). */
/**
 * Languages the native app offers before the server has their messages (docs/MOBILE-APP-SPEC.md §8, G16): the app
 * sends X-Driver-Lang: ms or zh(-Hans), and gets the server's English until dictionaries for them exist here (the
 * hook: add MS / ZH tables next to EN and widen domain/locale.ts Lang). Only the app's explicit choice maps;
 * Accept-Language is unchanged.
 */
export const APP_ONLY_LANGS: Readonly<Record<string, Lang>> = Object.freeze({ ms: 'en', zh: 'en' });

export async function driverLang(req: FastifyRequest): Promise<Lang> {
  const chosen = String(req.headers['x-driver-lang'] ?? '').trim().toLowerCase();
  if (isLang(chosen)) return chosen;
  const appOnly = APP_ONLY_LANGS[chosen.split(/[-_]/)[0]!];
  if (appOnly) return appOnly;
  const device = acceptLanguages(req.headers['accept-language']);
  if (device.length) return device[0]!;
  if (req.brand) {
    const d = await one<{ l: string | null }>(`SELECT default_locale AS l FROM organisation WHERE id = $1`, [req.brand.orgId]).catch(() => null);
    if (isLang(d?.l)) return d!.l as Lang;
  }
  const country = await requestCountry(req);
  return country && ENGLISH_COUNTRIES.has(country) ? 'en' : 'id';
}
