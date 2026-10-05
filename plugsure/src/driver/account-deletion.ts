import { createHmac } from 'node:crypto';
import { many, one, tx, withAdvisoryLock } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { maskPhone } from '../integrations/otp.js';
import { checkOtp, normalisePhone, sendOtp } from './identity.js';
import { unpaidSessions } from './charge.js';
import { removeCard } from '../services/payments/cards.js';
import type { DriverPrincipal } from './identity.js';

/**
 * Account deletion (Apple 5.1.1(v), Google Play account deletion; docs/MOBILE-APP-SPEC.md §11.4, G4, §15).
 *
 * In the app (signed in) or on the web form (/account/delete, phone number and code): a code is sent to the
 * account's number, the driver confirms with it, and the account is deleted AT ONCE — no grace period (the code is
 * the safeguard, and a "deleted" account that still exists for 30 days is not what drivers or the stores expect).
 *
 * Refused (409, nothing changes) while money is owed or in flight: an unpaid session (expired card hold, post-pay,
 * partner-network shortfall), a charge in progress or a card hold not yet settled (here or on a partner network), a
 * live reservation or queue place. The driver settles or ends it first; the app shows the list.
 *
 * Deleted: name and e-mail; the phone number (replaced by a keyed hash, kept only to recognise the number's past
 * account for fraud and support — a new sign-in with the number starts a NEW, empty account); saved cards and linked
 * e-wallets (detached at the acquirer first, then their tokens erased); favourites; loyalty membership (points are
 * forfeited); auto-renewal of passes (a pass already paid runs to its end); every device signed in to the account is
 * signed out and its device token revoked; push subscriptions and Live Activity / live-session tokens; pending
 * sign-in codes and the number's sign-in counters.
 *
 * Kept (tax and consumer law: ID 10 years, MY 7, SG 5 — [LEGAL] per country): charges, payments, refunds, charge
 * records and receipts, invoices, loyalty ledger entries and partner-network charge records. They stay linked to the
 * pseudonymised account row (the phone number replaced by a hash keyed with SECRETS_KEY: re-identifiable by
 * whoever holds that key, so it is pseudonymised, not anonymised), which nobody can sign in to. The operators' own customer
 * records (the org-scoped `driver` table) are the operator's, not touched here.
 */

export type Blocker =
  | { code: 'unpaid'; unpaid: Array<{ chargeId: string; kind: string; owedMinor: number; currency: string; site: string }> }
  | { code: 'active_session'; chargeIds: string[] }
  | { code: 'open_hold'; chargeIds: string[] }
  | { code: 'active_reservation' }
  | { code: 'in_queue' };

export const DELETED: readonly string[] = Object.freeze([
  'name', 'email', 'phone (pseudonymised: replaced by a keyed hash)', 'saved_cards', 'linked_ewallets', 'favourites', 'loyalty_membership',
  'pass_auto_renewal', 'devices_signed_out', 'push_tokens', 'live_activity_tokens', 'sign_in_codes',
]);
export const RETAINED: readonly string[] = Object.freeze([
  'charges_and_receipts (tax law: ID 10 y, MY 7 y, SG 5 y)', 'payments_and_refunds', 'invoices', 'partner_network_charge_records', 'loyalty_ledger',
]);

/**
 * Serialises, per app driver, deleting the account and creating anything that would block the deletion (a charge,
 * a reservation, a queue place, a partner-network charge). Inside, `fn` must re-read state: after a deletion the
 * account is gone (`accountStillActive`).
 */
export function withDriverLock<T>(appDriverId: string, fn: () => Promise<T>): Promise<T> {
  return withAdvisoryLock(`app_driver:${appDriverId}`, fn);
}

/** Is this account still there (not deleted while the request waited for the lock)? */
export async function accountStillActive(appDriverId: string): Promise<boolean> {
  return !!(await one(`SELECT 1 FROM app_driver WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`, [appDriverId]));
}

/** The keyed one-way hash that replaces a deleted account's phone number. */
export function phoneHash(phone: string): string {
  return createHmac('sha256', config.security.secretsKey || 'plugsure-dev').update(`app_driver.phone:${phone}`).digest('hex');
}

async function devicesOf(appDriverId: string): Promise<string[]> {
  return (await many<{ id: string }>(`SELECT id FROM driver_device WHERE app_driver_id = $1`, [appDriverId])).map((r) => r.id);
}

/** What stops this account from being deleted now (empty: it can be). */
export async function deletionBlockers(appDriverId: string, deviceId: string | null): Promise<Blocker[]> {
  const devices = [...new Set([...(await devicesOf(appDriverId)), ...(deviceId ? [deviceId] : [])])];
  const out: Blocker[] = [];
  const unpaid = new Map<string, { chargeId: string; kind: string; owedMinor: number; currency: string; site: string }>();
  for (const d of devices.length ? devices : ['00000000-0000-0000-0000-000000000000']) {
    for (const u of await unpaidSessions({ deviceId: d, appDriverId } as DriverPrincipal)) {
      unpaid.set(u.chargeId, { chargeId: u.chargeId, kind: u.kind, owedMinor: u.owedMinor, currency: u.currency, site: u.site });
    }
  }
  if (unpaid.size) out.push({ code: 'unpaid', unpaid: [...unpaid.values()] });
  const active = await many<{ id: string }>(
    `SELECT dc.id FROM driver_charge dc
       LEFT JOIN charging_session cs ON cs.id = dc.session_id
       LEFT JOIN payment_intent pi ON pi.id = dc.payment_intent_id
      WHERE (dc.app_driver_id = $1 OR dc.device_id = ANY($2::uuid[]))
        AND (cs.state = 'active'
             OR (dc.session_id IS NULL AND dc.created_at > now() - interval '30 minutes' AND pi.state IN ('pending', 'authorised', 'captured')))
      LIMIT 10`,
    [appDriverId, devices]);
  if (active.length) out.push({ code: 'active_session', chargeIds: active.map((r) => r.id) });
  const holds = await many<{ id: string }>(
    `SELECT dc.id FROM driver_charge dc JOIN payment_intent pi ON pi.id = dc.payment_intent_id
      WHERE (dc.app_driver_id = $1 OR dc.device_id = ANY($2::uuid[])) AND pi.hold_state IN ('held', 'capturing', 'releasing')
     UNION
     SELECT rc.id FROM driver_roaming_charge rc
      WHERE rc.app_driver_id = $1 AND rc.payment_intent_id IS NOT NULL AND rc.settled_at IS NULL
     LIMIT 10`,
    [appDriverId, devices]);
  if (holds.length) out.push({ code: 'open_hold', chargeIds: holds.map((r) => r.id) });
  if (await one(`SELECT 1 FROM driver_reservation WHERE (app_driver_id = $1 OR device_id = ANY($2::uuid[])) AND state IN ('requested', 'active') LIMIT 1`, [appDriverId, devices])
    || await one(`SELECT 1 FROM driver_roaming_reservation WHERE device_id = ANY($1::uuid[]) AND state IN ('requested', 'active') LIMIT 1`, [devices])) {
    out.push({ code: 'active_reservation' });
  }
  if (await one(`SELECT 1 FROM driver_queue_entry WHERE (app_driver_id = $1 OR device_id = ANY($2::uuid[])) AND state IN ('waiting', 'offered') LIMIT 1`, [appDriverId, devices])) {
    out.push({ code: 'in_queue' });
  }
  return out;
}

const MSG_BLOCKED = 'Akun belum dapat dihapus: selesaikan tagihan, pengisian, reservasi atau antrean yang masih berjalan terlebih dahulu.';

async function accountByPhone(phoneRaw: string): Promise<{ id: string; phone: string } | null> {
  const phone = normalisePhone(phoneRaw);
  if (!phone) return null;
  return one<{ id: string; phone: string }>(`SELECT id, phone FROM app_driver WHERE phone = $1 AND status = 'active' AND deleted_at IS NULL`, [phone]);
}

/**
 * Step 1: send the confirmation code. Signed in: to the account's number (body.phone ignored), with what still
 * blocks the deletion. The web form (not signed in): to the number given, only if it has an account; the answer and
 * the limits applied are the same either way, and it never shows what blocks the deletion (unpaid charges, a session
 * in progress, a reservation): those are a stranger's business only after the code proves the number is theirs, so
 * the web form learns them from confirm's 409 (v1.9.0; 1.9.0-dev returned them here, before any code).
 */
export async function startDeletion(p: DriverPrincipal, phoneRaw: string | null, from: { ip?: string; appName?: string }) {
  const phone = p.account?.phone ?? (phoneRaw ? normalisePhone(phoneRaw) : null);
  if (!phone) return { ok: false as const, status: 400, error: 'Nomor telepon tidak valid.' };
  if (p.account) {
    const blockers = await deletionBlockers(p.account.id, p.deviceId);
    const r = await sendOtp(phone, from.appName, { ip: from.ip, deviceId: p.deviceId });
    if (!r.ok) return { ok: false as const, status: r.limited ? 429 : 400, error: r.error };
    return { ok: true as const, phoneMasked: maskPhone(phone), ...(r.devCode ? { devCode: r.devCode } : {}), blockers, deleted: DELETED, retained: RETAINED };
  }
  // No account behind the number: every limit is still claimed, nothing is sent.
  const acc = await accountByPhone(phone);
  const r = await sendOtp(phone, from.appName, { ip: from.ip, deviceId: p.deviceId }, { send: !!acc });
  if (!r.ok) return { ok: false as const, status: r.limited ? 429 : 400, error: r.error };
  return { ok: true as const, phoneMasked: maskPhone(phone), ...(r.devCode ? { devCode: r.devCode } : {}), blockers: [] as Blocker[], deleted: DELETED, retained: RETAINED };
}

/** Step 2: confirm with the code, and delete. */
export async function confirmDeletion(p: DriverPrincipal, phoneRaw: string | null, code: string, via: 'app' | 'web') {
  const phone = p.account?.phone ?? (phoneRaw ? normalisePhone(phoneRaw) : null);
  if (!phone) return { ok: false as const, status: 400, body: { error: 'Nomor telepon tidak valid.' } };
  const checked = await checkOtp(p.deviceId, phone, code);
  if (!checked.ok) return { ok: false as const, status: checked.limited ? 429 : 400, body: { error: checked.error } };
  const acc = p.account ? { id: p.account.id, phone } : await accountByPhone(phone);
  if (!acc) return { ok: false as const, status: 404, body: { error: 'Akun tidak ditemukan.' } };
  // The blockers are checked and the account deleted under the driver's lock, which every charge, reservation and
  // queue join of a signed-in driver also takes (withDriverLock): nothing can start between the check and the delete.
  return withDriverLock(acc.id, async () => {
    const blockers = await deletionBlockers(acc.id, p.deviceId);
    if (blockers.length) {
      const unpaid = blockers.find((b) => b.code === 'unpaid');
      return { ok: false as const, status: 409, body: { error: MSG_BLOCKED, code: blockers[0]!.code, blockers, ...(unpaid ? { unpaid: unpaid.unpaid } : {}) } };
    }
    const summary = await anonymise(acc.id, acc.phone, via);
    logger.info({ appDriverId: acc.id, phone: maskPhone(acc.phone), via, summary }, 'driver account deleted');
    return { ok: true as const, deleted: DELETED, retained: RETAINED, summary };
  });
}

/** Delete the account's personal data in place (see the header). */
export async function anonymise(appDriverId: string, phone: string, via: 'app' | 'web'): Promise<Record<string, number>> {
  // Saved cards and e-wallet links: tell the acquirer first (outside the transaction: it is a network call).
  const cards = await many<{ id: string }>(`SELECT id FROM driver_card WHERE app_driver_id = $1 AND removed_at IS NULL`, [appDriverId]);
  for (const c of cards) await removeCard(appDriverId, c.id).catch((e) => logger.warn({ card: c.id, err: (e as Error).message }, 'saved card not detached at deletion'));
  return tx(async (c) => {
    const n = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rowCount ?? 0;
    const devices = (await c.query<{ id: string }>(`SELECT id FROM driver_device WHERE app_driver_id = $1`, [appDriverId])).rows.map((r) => r.id);
    const summary: Record<string, number> = {
      cardsAndWallets: cards.length,
      cardTokensErased: await n(
        `UPDATE driver_card SET token_sealed = 'erased', token_hash = 'erased:' || id::text, link_ref = NULL, account_label = NULL, removed_at = COALESCE(removed_at, now())
          WHERE app_driver_id = $1`, [appDriverId]),
      favourites: await n(`DELETE FROM driver_favourite WHERE app_driver_id = $1 OR device_id = ANY($2::uuid[])`, [appDriverId, devices]),
      pushSubscriptions: await n(`DELETE FROM push_subscription WHERE device_id = ANY($1::uuid[])`, [devices]),
      liveActivities: await n(`DELETE FROM live_activity WHERE device_id = ANY($1::uuid[])`, [devices]),
      liveActivityStartTokens: await n(`DELETE FROM live_activity_start_token WHERE device_id = ANY($1::uuid[])`, [devices]),
      loyaltyMemberships: await n(`DELETE FROM loyalty_member WHERE app_driver_id = $1`, [appDriverId]),
      passesAutoRenewOff: await n(`UPDATE subscription SET auto_renew = false WHERE app_driver_id = $1 AND auto_renew`, [appDriverId]),
      signInCodes: await n(`DELETE FROM driver_otp WHERE phone = $1 OR device_id = ANY($2::uuid[])`, [phone, devices]),
      // Exactly this number's counters (a substring match also reset longer numbers that start with these digits).
      signInCounters: await n(`DELETE FROM driver_auth_limit WHERE key = 'otp-phone:' || $1 OR key LIKE 'otp-verify:' || $1 || ':%'`, [phone]),
      // Every device signed in to the account: signed out, and its device token revoked (no one holds the new hash's secret).
      devicesSignedOut: await n(
        `UPDATE driver_device SET app_driver_id = NULL, fleet_token_id = NULL, device_hash = 'revoked:' || encode(gen_random_bytes(24), 'hex'), user_agent = NULL
          WHERE id = ANY($1::uuid[])`, [devices]),
      // The app driver's virtual roaming tokens: no new charge can be started with them.
      roamingTokensBlocked: await n(
        `UPDATE token SET status = 'Blocked', updated_at = now() WHERE kind = 'app' AND id IN (SELECT DISTINCT token_id FROM driver_roaming_charge WHERE app_driver_id = $1)`,
        [appDriverId]),
    };
    await c.query(
      `UPDATE app_driver SET phone = 'deleted:' || $2, name = NULL, email = NULL, status = 'deleted', deleted_at = now() WHERE id = $1`,
      [appDriverId, phoneHash(phone)]);
    await c.query(`INSERT INTO app_driver_deletion (app_driver_id, via, summary) VALUES ($1, $2, $3)`, [appDriverId, via, JSON.stringify(summary)]);
    return summary;
  });
}

/** Has this number's account been deleted (support: "my account is gone")? */
export async function wasDeleted(phoneRaw: string): Promise<boolean> {
  const phone = normalisePhone(phoneRaw);
  return !!phone && !!(await one(`SELECT 1 FROM app_driver WHERE phone = $1`, [`deleted:${phoneHash(phone)}`]));
}

