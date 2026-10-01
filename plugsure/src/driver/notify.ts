import { one, many, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { bus } from '../services/events.js';
import { sendPush, endpointProblem } from '../services/webpush.js';
import { sendToDevice, outcomeOf, type ApnsEnv } from '../services/apns.js';
import { apnsCredentialsFor, markApnsRefused, brandForOrg } from '../services/brand.js';
import { chargeCardPath } from '../services/charge-card.js';

/**
 * Push notifications to drivers' phones.
 *
 * Events are turned into messages where they are raised (bus listeners), queued
 * in push_message with a de-duplication key, and sent by the worker. A phone
 * gets each notification once, in the language it subscribed in; a subscription
 * the push service says is gone (404/410) is deleted.
 *
 * Two kinds of subscription: Web Push (browsers and the web app on a home screen)
 * and APNs (a white-label iOS app, which cannot use Web Push inside its shell).
 *
 * Who is told about a session: the phone that started it from the app, and for a
 * fleet card, every phone signed in with that card.
 */

type Lang = 'id' | 'en';
/**
 * `body` is the whole text (a browser shows title and body only). The iOS app
 * shows more: `site` as a subtitle over `detail`, the action buttons of
 * `category` (registered by the app) with where each leads in `actions`,
 * time-sensitive delivery through Focus when `urgent`, and a picture.
 */
type Msg = Record<Lang, { title: string; body: string; detail?: string }> & {
  url: string;
  tag: string;
  site?: string;
  category?: 'PS_SESSION' | 'PS_RECEIPT' | 'PS_UNPAID' | 'PS_QUEUE' | 'PS_RESERVATION';
  /** Action id → an /app/ address, or `queue-leave:<id>` / `reservation-cancel:<id>` the app carries out. */
  actions?: Record<string, string>;
  urgent?: boolean;
  image?: Record<Lang, string>;
};

const rp = (n: number) => `Rp ${Math.round(n).toLocaleString('id-ID')}`;
const kwhId = (wh: number) => (wh / 1000).toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const kwhEn = (wh: number) => (wh / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const hhmm = (d: Date) => d.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });

export async function subscribe(deviceId: string, s: any, lang: string): Promise<{ ok: boolean; error?: string }> {
  const endpoint = typeof s?.endpoint === 'string' ? s.endpoint : '';
  const p256dh = typeof s?.keys?.p256dh === 'string' ? s.keys.p256dh : '';
  const auth = typeof s?.keys?.auth === 'string' ? s.keys.auth : '';
  const problem = endpoint ? endpointProblem(endpoint) : 'endpoint is required';
  if (problem) return { ok: false, error: `Langganan notifikasi ditolak: ${problem}.` };
  if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) {
    return { ok: false, error: 'Langganan notifikasi tidak valid.' };
  }
  await query(
    `INSERT INTO push_subscription (device_id, endpoint, p256dh, auth, lang) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET device_id = EXCLUDED.device_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
       lang = EXCLUDED.lang, failures = 0`,
    [deviceId, endpoint.slice(0, 1000), p256dh, auth, lang === 'en' ? 'en' : 'id'],
  );
  // A phone keeps at most five subscriptions (a browser reinstall leaves stale ones behind).
  await query(
    `DELETE FROM push_subscription WHERE device_id = $1 AND id NOT IN
       (SELECT id FROM push_subscription WHERE device_id = $1 ORDER BY created_at DESC LIMIT 5)`,
    [deviceId],
  );
  return { ok: true };
}

/**
 * The iOS app's device token, for its brand's APNs key. The endpoint column
 * holds pns:<org>:<token> so the same token is one subscription.
 */
export async function subscribeApns(deviceId: string, brandOrgId: string, tokenRaw: unknown, lang: string): Promise<{ ok: boolean; error?: string }> {
  const token = String(tokenRaw ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64,200}$/.test(token)) return { ok: false, error: 'Token notifikasi iOS tidak valid.' };
  if (!(await apnsCredentialsFor(brandOrgId))) return { ok: false, error: 'Notifikasi belum tersedia di aplikasi ini.' };
  await query(
    `INSERT INTO push_subscription (device_id, endpoint, kind, brand_org_id, lang) VALUES ($1, $2, 'apns', $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET device_id = EXCLUDED.device_id, lang = EXCLUDED.lang, failures = 0`,
    [deviceId, `apns:${brandOrgId}:${token}`, brandOrgId, lang === 'en' ? 'en' : 'id'],
  );
  await query(
    `DELETE FROM push_subscription WHERE device_id = $1 AND id NOT IN
       (SELECT id FROM push_subscription WHERE device_id = $1 ORDER BY created_at DESC LIMIT 5)`,
    [deviceId],
  );
  return { ok: true };
}

export async function unsubscribeApns(deviceId: string, brandOrgId: string, tokenRaw: unknown): Promise<void> {
  await query(`DELETE FROM push_subscription WHERE device_id = $1 AND endpoint = $2`, [deviceId, `apns:${brandOrgId}:${String(tokenRaw ?? '').trim().toLowerCase()}`]);
}

export async function unsubscribe(deviceId: string, endpoint: string): Promise<void> {
  await query(`DELETE FROM push_subscription WHERE device_id = $1 AND endpoint = $2`, [deviceId, endpoint]);
}

export async function pushStatus(deviceId: string) {
  const r = await one<{ n: number }>(`SELECT count(*)::int AS n FROM push_subscription WHERE device_id = $1`, [deviceId]);
  return { subscribed: (r?.n ?? 0) > 0 };
}

/** Queue one message for every subscription of these phones. */
export async function notifyDevices(deviceIds: string[], kind: string, dedupeKey: string, m: Msg): Promise<number> {
  if (!deviceIds.length) return 0;
  const r = await query(
    `INSERT INTO push_message (subscription_id, kind, dedupe_key, payload)
     SELECT s.id, $2, $3,
            jsonb_strip_nulls(jsonb_build_object(
              'title', CASE WHEN s.lang = 'en' THEN $4::text ELSE $6::text END,
              'body',  CASE WHEN s.lang = 'en' THEN $5::text ELSE $7::text END,
              'url', $8::text, 'tag', $9::text,
              'site', $10::text,
              'detail', CASE WHEN s.lang = 'en' THEN $11::text ELSE $12::text END,
              'category', $13::text, 'actions', $14::jsonb, 'urgent', $15::boolean,
              'image', CASE WHEN s.lang = 'en' THEN $16::text ELSE $17::text END))
       FROM push_subscription s WHERE s.device_id = ANY($1::uuid[])
     ON CONFLICT (subscription_id, dedupe_key) DO NOTHING`,
    [deviceIds, kind, dedupeKey, m.en.title, m.en.body, m.id.title, m.id.body, m.url, m.tag,
      m.site ?? null, m.en.detail ?? null, m.id.detail ?? null, m.category ?? null, m.actions ? JSON.stringify(m.actions) : null, m.urgent ?? null,
      m.image?.en ?? null, m.image?.id ?? null],
  );
  return r.rowCount ?? 0;
}

/**
 * The iOS app's badge is the number of sessions waiting to be paid. Every notification to an
 * iPhone carries it; when one is paid, the phones get a badge-only update (nothing shown).
 */
export async function unpaidCount(deviceId: string, orgId: string): Promise<number> {
  const r = await one<{ n: number }>(
    `SELECT count(DISTINCT pi.id)::int AS n
       FROM payment_intent pi JOIN driver_charge dc ON dc.payment_intent_id = pi.id
      WHERE (dc.device_id = $1 OR dc.app_driver_id = (SELECT app_driver_id FROM driver_device WHERE id = $1))
        AND dc.org_id = $2 AND pi.hold_state = 'capture_failed'
        AND (pi.mode = 'postpay' OR (pi.mode = 'preauth' AND pi.hold_error LIKE 'hold expired:%'))`,
    [deviceId, orgId],
  );
  return r?.n ?? 0;
}

/** A session was paid (in the app, or by the e-wallet on a retry): update its iPhones' badges. */
export async function refreshUnpaidBadge(paymentIntentId: string): Promise<number> {
  const rows = await many<{ device_id: string; app_driver_id: string | null }>(
    `SELECT device_id, app_driver_id FROM driver_charge WHERE payment_intent_id = $1`, [paymentIntentId]);
  if (!rows.length) return 0;
  const devices = new Set(rows.map((r) => r.device_id));
  for (const r of rows) {
    if (!r.app_driver_id) continue;
    for (const d of await many<{ id: string }>(`SELECT id FROM driver_device WHERE app_driver_id = $1`, [r.app_driver_id])) devices.add(d.id);
  }
  const r = await query(
    `INSERT INTO push_message (subscription_id, kind, dedupe_key, payload)
     SELECT s.id, 'badge', $2, '{"badgeOnly": true}'::jsonb FROM push_subscription s
      WHERE s.device_id = ANY($1::uuid[]) AND s.kind = 'apns'
     ON CONFLICT (subscription_id, dedupe_key) DO NOTHING`,
    [[...devices], `badge:${paymentIntentId}`],
  );
  return r.rowCount ?? 0;
}

/** Phones that should hear about a session at one of our chargers. */
async function devicesForSession(sessionId: string) {
  const s = await one<{ token_id: string | null; connector_uuid: string; started_at: Date; site_name: string; energy_wh: string }>(
    `SELECT cs.token_id, cs.connector_uuid, cs.started_at, si.name AS site_name, cs.energy_wh
       FROM charging_session cs JOIN site si ON si.id = cs.site_id WHERE cs.id = $1`,
    [sessionId],
  );
  if (!s?.token_id) return null;
  const rows = await many<{ device_id: string; charge_id: string | null }>(
    `SELECT dc.device_id, dc.id AS charge_id FROM driver_charge dc
      WHERE dc.token_id = $1 AND dc.connector_uuid = $2 AND dc.created_at >= $3::timestamptz - interval '30 minutes'
     UNION
     SELECT d.id AS device_id, NULL FROM driver_device d
      JOIN token t ON t.id = d.fleet_token_id AND t.kind = 'rfid'
      WHERE d.fleet_token_id = $1`,
    [s.token_id, s.connector_uuid, s.started_at],
  );
  const chargeId = rows.find((r) => r.charge_id)?.charge_id ?? null;
  return { devices: [...new Set(rows.map((r) => r.device_id))], chargeId, site: s.site_name, energyWh: Number(s.energy_wh) };
}

const sessionUrl = (chargeId: string | null) => (chargeId ? `/app/#s/${chargeId}` : '/app/#history');
const receiptUrl = (chargeId: string | null) => (chargeId ? `/app/#r/${chargeId}` : '/app/#history');

async function onSessionStarted(sessionId: string) {
  const d = await devicesForSession(sessionId);
  if (!d?.devices.length) return;
  await notifyDevices(d.devices, 'session.started', `session.started:${sessionId}`, {
    id: { title: 'Pengisian dimulai', body: `${d.site} · ketuk untuk melihat`, detail: 'Ketuk untuk melihat pengisian' },
    en: { title: 'Charging started', body: `${d.site} · tap to follow`, detail: 'Tap to follow the charge' },
    url: sessionUrl(d.chargeId), tag: `s-${sessionId}`, site: d.site,
    // Stopping needs the charge started from the app (a fleet card's session is stopped at the charger).
    ...(d.chargeId ? { category: 'PS_SESSION' as const, actions: { stop: sessionUrl(d.chargeId) } } : {}),
  });
}

async function onSessionEnded(sessionId: string, energyWh: number) {
  const d = await devicesForSession(sessionId);
  if (!d?.devices.length) return;
  await notifyDevices(d.devices, 'session.ended', `session.ended:${sessionId}`, {
    id: { title: 'Pengisian selesai', body: `${kwhId(energyWh)} kWh di ${d.site}`, detail: `${kwhId(energyWh)} kWh terisi` },
    en: { title: 'Charging finished', body: `${kwhEn(energyWh)} kWh at ${d.site}`, detail: `${kwhEn(energyWh)} kWh charged` },
    url: sessionUrl(d.chargeId), tag: `s-${sessionId}`, site: d.site,
    category: 'PS_RECEIPT', actions: { receipt: receiptUrl(d.chargeId) },
    // The charge in a picture: energy, time, peak power and the power curve.
    image: { id: chargeCardPath(sessionId, 'id'), en: chargeCardPath(sessionId, 'en') },
  });
}

async function onCdr(sessionId: string, totalIdr: number) {
  const d = await devicesForSession(sessionId);
  if (!d?.devices.length) return;
  await notifyDevices(d.devices, 'cdr.created', `cdr:${sessionId}`, {
    id: { title: 'Struk siap', body: `${d.site} · ${rp(totalIdr)}`, detail: `Total ${rp(totalIdr)}` },
    en: { title: 'Receipt ready', body: `${d.site} · ${rp(totalIdr)}`, detail: `Total ${rp(totalIdr)}` },
    url: d.chargeId ? `/app/#s/${d.chargeId}` : '/app/#history', tag: `s-${sessionId}`, site: d.site,
    category: 'PS_RECEIPT', actions: { receipt: receiptUrl(d.chargeId) },
  });
}

async function onRefund(paymentIntentId: string, amountIdr: number) {
  const rows = await many<{ device_id: string; id: string }>(`SELECT device_id, id FROM driver_charge WHERE payment_intent_id = $1`, [paymentIntentId]);
  if (!rows.length) return;
  await notifyDevices(rows.map((r) => r.device_id), 'refund.completed', `refund:${paymentIntentId}`, {
    id: { title: 'Dana dikembalikan', body: `${rp(amountIdr)} kembali ke pembayaran Anda` },
    en: { title: 'Refund paid', body: `${rp(amountIdr)} returned to your payment` },
    url: `/app/#s/${rows[0]!.id}`, tag: `refund-${paymentIntentId}`,
    category: 'PS_RECEIPT', actions: { receipt: receiptUrl(rows[0]!.id) },
  });
}

/** A partner operator's charge record for a card: tell the phones signed in with it. */
export async function notifyRoamingCdr(tokenId: string, cdrId: string, site: string, totalIdr: number | null) {
  const rows = await many<{ id: string }>(`SELECT id FROM driver_device WHERE fleet_token_id = $1`, [tokenId]);
  if (!rows.length) return;
  const amount = totalIdr != null ? ` · ${rp(totalIdr)}` : '';
  await notifyDevices(rows.map((r) => r.id), 'roaming.cdr', `roaming.cdr:${cdrId}`, {
    id: { title: 'Tagihan jaringan mitra siap', body: `${site}${amount}`, ...(totalIdr != null ? { detail: `Total ${rp(totalIdr)}` } : {}) },
    en: { title: 'Partner network charge ready', body: `${site}${amount}`, ...(totalIdr != null ? { detail: `Total ${rp(totalIdr)}` } : {}) },
    url: `/app/#rr/${cdrId}`, tag: `rr-${cdrId}`, ...(totalIdr != null ? { site } : {}),
    category: 'PS_RECEIPT', actions: { receipt: `/app/#rr/${cdrId}` },
  });
}

export async function notifyReservation(deviceId: string, reservationId: string, kind: 'reminder' | 'expired' | 'released', site: string, expiresAt: Date) {
  // The operator suspended the charger (v1.4.4): the reservation is cancelled, any fee refunded.
  if (kind === 'released') {
    const m: Msg = {
      id: { title: 'Reservasi dibatalkan', body: `${site} · charger sementara tidak beroperasi; biaya dikembalikan`, detail: 'Charger sementara tidak beroperasi; biaya dikembalikan' },
      en: { title: 'Reservation cancelled', body: `${site} · the charger is temporarily out of service; any fee is refunded`, detail: 'The charger is temporarily out of service; any fee is refunded' },
      url: '/app/#home', tag: `res-${reservationId}`, site, urgent: true,
    };
    await notifyDevices([deviceId], 'reservation.released', `reservation.released:${reservationId}`, m);
    return;
  }
  const m: Msg = kind === 'reminder'
    ? { id: { title: 'Reservasi berakhir dalam 5 menit', body: `${site} · mulai isi sebelum ${hhmm(expiresAt)}`, detail: `Mulai isi sebelum ${hhmm(expiresAt)}` },
        en: { title: 'Reservation ends in 5 minutes', body: `${site} · start charging before ${hhmm(expiresAt)}`, detail: `Start charging before ${hhmm(expiresAt)}` },
        url: '/app/#home', tag: `res-${reservationId}`, site, urgent: true,
        category: 'PS_RESERVATION', actions: { cancel: `reservation-cancel:${reservationId}` } }
    : { id: { title: 'Reservasi berakhir', body: `${site} · konektor dilepas`, detail: 'Konektor dilepas' },
        en: { title: 'Reservation ended', body: `${site} · the connector was released`, detail: 'The connector was released' },
        url: '/app/#home', tag: `res-${reservationId}`, site };
  await notifyDevices([deviceId], `reservation.${kind}`, `reservation.${kind}:${reservationId}`, m);
}

/** The site queue: your turn (a connector is held for you), you missed it, your wait ended, or you were taken off. */
export async function notifyQueue(deviceId: string, entryId: string, kind: 'offer' | 'missed' | 'expired' | 'removed' | 'closed' | 'requeued', site: string, until: Date | null) {
  const q = (idTitle: string, idDetail: string, enTitle: string, enDetail: string, extra: Partial<Msg> = {}): Msg => ({
    id: { title: idTitle, body: `${site} · ${idDetail}`, detail: idDetail.charAt(0).toUpperCase() + idDetail.slice(1) },
    en: { title: enTitle, body: `${site} · ${enDetail}`, detail: enDetail.charAt(0).toUpperCase() + enDetail.slice(1) },
    url: '/app/#home', tag: `q-${entryId}`, site, ...extra,
  });
  const at = until ? hhmm(until) : '';
  const m: Record<typeof kind, Msg> = {
    offer: q('Giliran Anda!', `konektor ditahan untuk Anda sampai ${at}`, 'Your turn!', `a connector is held for you until ${at}`,
      { urgent: true, category: 'PS_QUEUE', actions: { leave: `queue-leave:${entryId}` } }),
    missed: q('Giliran Anda terlewat', 'konektor diberikan ke pengemudi berikutnya', 'You missed your turn', 'the connector went to the next driver'),
    expired: q('Antrean berakhir', 'batas waktu menunggu habis', 'Your place in the queue ended', 'the waiting time ran out'),
    removed: q('Anda keluar dari antrean', 'dikeluarkan oleh operator', 'You were taken off the queue', 'by the operator'),
    closed: q('Antrean ditutup', 'lokasi ini tidak memakai antrean lagi', 'The queue was closed', 'this site no longer uses a queue'),
    requeued: q('Giliran Anda ditunda', 'charger sementara tidak beroperasi; Anda tetap di antrean', 'Your turn is on hold', 'the charger is temporarily out of service; you keep your place'),
  };
  await notifyDevices([deviceId], `queue.${kind}`, `queue.${kind}:${entryId}`, m[kind]);
}
/**
 * Unpaid sessions the driver can pay in the app (an expired card hold, or post-pay whose e-wallet charge
 * failed): a reminder 15 minutes, 1 day and 3 days after the session ended, then no more (after 7 days).
 * Each stage is its own dedupe key, so a stage is sent at most once per phone; paying stops the rest.
 */
export const UNPAID_REMINDER_STAGES_MIN = [15, 24 * 60, 3 * 24 * 60];
export async function remindUnpaidSessions(): Promise<number> {
  const rows = await many<{ intent_id: string; charge_id: string; device_id: string; app_driver_id: string | null; owed: number; site: string; age_min: number }>(
    `SELECT pi.id AS intent_id, dc.id AS charge_id, dc.device_id, dc.app_driver_id, pi.hold_capture_idr AS owed, si.name AS site,
            floor(extract(epoch FROM now() - cs.ended_at) / 60)::int AS age_min
       FROM payment_intent pi
       JOIN driver_charge dc ON dc.payment_intent_id = pi.id
       JOIN charging_session cs ON cs.id = pi.session_id
       JOIN site si ON si.id = cs.site_id
      WHERE pi.hold_state = 'capture_failed' AND (pi.mode = 'postpay' OR (pi.mode = 'preauth' AND pi.hold_error LIKE 'hold expired:%'))
        AND cs.ended_at < now() - make_interval(mins => $1::int) AND cs.ended_at > now() - interval '7 days'`,
    [UNPAID_REMINDER_STAGES_MIN[0]],
  );
  let n = 0;
  for (const r of rows) {
    const stage = UNPAID_REMINDER_STAGES_MIN.filter((m) => r.age_min >= m).length; // 1..3
    // The phone that paid, and every phone signed in to the same account.
    const devices = r.app_driver_id
      ? [...new Set([r.device_id, ...(await many<{ id: string }>(`SELECT id FROM driver_device WHERE app_driver_id = $1`, [r.app_driver_id])).map((d) => d.id)])]
      : [r.device_id];
    n += await notifyDevices(devices, 'session.unpaid', `unpaid:${r.intent_id}:${stage}`, {
      id: { title: 'Sesi pengisian belum dibayar', body: `${r.site} · ${rp(Number(r.owed))} · ketuk untuk membayar`, detail: `${rp(Number(r.owed))} · ketuk untuk membayar` },
      en: { title: 'Charging session unpaid', body: `${r.site} · ${rp(Number(r.owed))} · tap to pay`, detail: `${rp(Number(r.owed))} · tap to pay` },
      url: `/app/#r/${r.charge_id}`, tag: `unpaid-${r.intent_id}`, site: r.site,
      category: 'PS_UNPAID', actions: { pay: `/app/#r/${r.charge_id}` },
    });
  }
  return n;
}

export function registerDriverPushListeners(): void {
  const guard = (what: string, fn: () => Promise<unknown>) => void fn().catch((e) => logger.warn({ what, err: (e as Error).message }, 'push notification enqueue failed'));
  bus.on('session.started', (e) => guard('session.started', () => onSessionStarted(e.sessionId)));
  bus.on('session.ended', (e) => guard('session.ended', () => onSessionEnded(e.sessionId, e.energyWh)));
  bus.on('cdr.created', (e) => guard('cdr.created', () => onCdr(e.sessionId, e.totalIdr)));
  bus.on('refund.completed', (e) => guard('refund.completed', () => onRefund(e.paymentIntentId, e.amountIdr)));
  // A session paid: iPhones' badges go down (paid in the app, or by the e-wallet on a retry).
  bus.on('payment.unpaid_settled', (e) => guard('badge', () => refreshUnpaidBadge(e.paymentIntentId)));
  bus.on('payment.hold_captured', (e) => guard('badge', () => refreshUnpaidBadge(e.paymentIntentId)));
}

const BACKOFF_S = [30, 300, 1800];

/** Worker pass: send what is due. */
export async function deliverPush(limit = 50): Promise<number> {
  const due = await many<{ id: string; subscription_id: string; payload: any; attempts: number; endpoint: string; p256dh: string; auth: string; kind: string;
    sub_kind: 'webpush' | 'apns'; brand_org_id: string | null; apns_env: ApnsEnv | null; device_id: string }>(
    `WITH picked AS (
       SELECT m.id FROM push_message m WHERE m.state = 'pending' AND m.next_attempt_at <= now()
        ORDER BY m.id LIMIT $1 FOR UPDATE SKIP LOCKED)
     UPDATE push_message m SET attempts = m.attempts + 1, next_attempt_at = now() + interval '2 minutes'
       FROM picked, push_subscription s
      WHERE m.id = picked.id AND s.id = m.subscription_id
     RETURNING m.id, m.subscription_id, m.payload, m.attempts, m.kind, s.endpoint, s.p256dh, s.auth, s.kind AS sub_kind, s.brand_org_id, s.apns_env, s.device_id`,
    [limit],
  );
  await Promise.all(due.map(async (m) => {
    // Reminders are useless late; a finished charge is still worth knowing for a day.
    // Reservation and queue messages are only useful for minutes; the rest keep for a day.
    const timely = m.kind.startsWith('reservation.') || m.kind.startsWith('queue.');
    const ttlS = timely ? 600 : 86_400;
    if (m.sub_kind === 'apns') return deliverApns(m, ttlS, timely);
    const r = await sendPush(m, m.payload, { ttlS, urgency: timely ? 'high' : 'normal', topic: m.payload?.tag });
    if (r.status != null && r.status >= 200 && r.status < 300) {
      await query(`UPDATE push_message SET state = 'sent', sent_at = now(), last_status = $2, last_error = NULL WHERE id = $1`, [m.id, r.status]);
      await query(`UPDATE push_subscription SET last_success_at = now(), failures = 0 WHERE id = $1`, [m.subscription_id]);
    } else if (r.status === 404 || r.status === 410) {
      // The phone unsubscribed or the browser dropped the subscription.
      await query(`UPDATE push_message SET state = 'gone', last_status = $2 WHERE id = $1`, [m.id, r.status]);
      await query(`DELETE FROM push_subscription WHERE id = $1`, [m.subscription_id]);
    } else {
      const dead = m.attempts >= BACKOFF_S.length || (r.status != null && r.status >= 400 && r.status < 500 && r.status !== 429);
      await query(
        `UPDATE push_message SET state = $2, last_status = $3, last_error = $4, next_attempt_at = now() + make_interval(secs => $5::int) WHERE id = $1`,
        [m.id, dead ? 'failed' : 'pending', r.status, r.error, BACKOFF_S[Math.min(m.attempts - 1, BACKOFF_S.length - 1)]!],
      );
      await query(`UPDATE push_subscription SET failures = failures + 1 WHERE id = $1`, [m.subscription_id]);
    }
  }));
  return due.length;
}

/** An address the iPhone can fetch (the Notification Service Extension downloads the picture): the brand's own web address when live. */
async function absoluteUrl(orgId: string, path: string): Promise<string> {
  const b = await brandForOrg(orgId).catch(() => null);
  const base = b?.status === 'live' && b.hostname ? `https://${b.hostname}` : (process.env.DRIVER_PUBLIC_URL || process.env.PUBLIC_BASE_URL || process.env.CONSOLE_PUBLIC_URL || '');
  return base.replace(/\/+$/, '') + path;
}

/** One message to an iOS app through APNs. */
async function deliverApns(
  m: { id: string; kind: string; subscription_id: string; payload: any; attempts: number; endpoint: string; brand_org_id: string | null; apns_env: ApnsEnv | null; device_id: string },
  ttlS: number, timely: boolean,
): Promise<void> {
  const token = m.endpoint.split(':').pop()!;
  const creds = m.brand_org_id ? await apnsCredentialsFor(m.brand_org_id) : null;
  if (!creds) {
    // The operator removed its key: nothing can reach this phone any more.
    await query(`UPDATE push_message SET state = 'failed', last_error = 'no APNs key' WHERE id = $1`, [m.id]);
    return;
  }
  const p = m.payload ?? {};
  // The badge: sessions waiting to be paid, in this operator's app, counted when the message leaves.
  const badge = await unpaidCount(m.device_id, m.brand_org_id!);
  const r = await sendToDevice(token, m.apns_env, creds, p.badgeOnly
    ? { title: '', body: '', badgeOnly: true, badge, priority: 5, ttlS }
    : {
      title: String(p.title ?? ''),
      // With a subtitle (the site), the body is the detail only: the site is not said twice.
      ...(p.site && p.detail ? { subtitle: String(p.site), body: String(p.detail) } : { body: String(p.body ?? '') }),
      url: p.url, collapseId: p.tag, ttlS, priority: timely ? 10 : 5, badge,
      ...(p.category ? { category: String(p.category) } : {}),
      interruptionLevel: p.urgent ? 'time-sensitive' : m.kind === 'cdr.created' ? 'passive' : 'active',
      relevance: p.urgent ? 1 : m.kind === 'session.unpaid' ? 0.8 : 0.5,
      ...(p.image ? { imageUrl: await absoluteUrl(m.brand_org_id!, String(p.image)) } : {}),
      ...(p.actions ? { data: { actions: p.actions } } : {}),
    });
  const outcome = outcomeOf(r);
  const err = r.reason ? `APNs ${r.status ?? ''} ${r.reason}`.trim() : null;
  if (outcome === 'sent') {
    await query(`UPDATE push_message SET state = 'sent', sent_at = now(), last_status = $2, last_error = NULL WHERE id = $1`, [m.id, r.status]);
    await query(`UPDATE push_subscription SET last_success_at = now(), failures = 0, apns_env = $2 WHERE id = $1`, [m.subscription_id, r.env]);
  } else if (outcome === 'gone') {
    // The app was deleted, notifications were turned off, or the token was never valid.
    await query(`UPDATE push_message SET state = 'gone', last_status = $2, last_error = $3 WHERE id = $1`, [m.id, r.status, err]);
    await query(`DELETE FROM push_subscription WHERE id = $1`, [m.subscription_id]);
  } else {
    if (outcome === 'credentials') await markApnsRefused(m.brand_org_id!, `Apple refused the key while sending (${r.reason}). Check the Key ID, Team ID and bundle identifier, or upload a new key.`, creds);
    // Refused credentials are the operator's to fix: keep the message for the retries, not the phone's fault.
    const dead = m.attempts >= BACKOFF_S.length || outcome === 'failed';
    await query(
      `UPDATE push_message SET state = $2, last_status = $3, last_error = $4, next_attempt_at = now() + make_interval(secs => $5::int) WHERE id = $1`,
      [m.id, dead ? 'failed' : 'pending', r.status, err, BACKOFF_S[Math.min(m.attempts - 1, BACKOFF_S.length - 1)]!],
    );
    if (outcome !== 'credentials') await query(`UPDATE push_subscription SET failures = failures + 1 WHERE id = $1`, [m.subscription_id]);
  }
}

export async function prunePush(): Promise<void> {
  await query(`DELETE FROM push_message WHERE created_at < now() - interval '14 days'`);
  // A subscription that has failed 20 times in a row and not worked for 30 days is dead.
  await query(`DELETE FROM push_subscription WHERE failures >= 20 AND COALESCE(last_success_at, created_at) < now() - interval '30 days'`);
}
