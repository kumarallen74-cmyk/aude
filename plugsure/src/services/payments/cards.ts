import { createHash } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../../db/pool.js';
import { logger } from '../../logger.js';
import { seal, unseal } from '../secrets.js';
import type { SavedCardInfo } from './provider.js';

/**
 * Saved cards — a signed-in driver's card, kept by the ACQUIRER.
 *
 * PlugSure stores the acquirer's token (sealed with SECRETS_KEY) and what the
 * driver needs to recognise the card (brand, last four digits, expiry). The
 * card number never reaches PlugSure, so PCI DSS card-data scope is unchanged.
 *
 * A token only works at the acquirer account that issued it: a card saved while
 * paying operator A (its own Midtrans account) cannot pay operator B. Cards are
 * therefore offered only where the charger's acquirer account is the one that
 * holds them. Guests (no account) cannot save cards: a device alone is too weak
 * a key for one-tap payments.
 */

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

export interface DriverCard {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  provider: string;
  integrationId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** The card (or its acquirer token) has expired: it can no longer pay. */
  expired: boolean;
  /** Where it can pay: the operator whose acquirer account holds it (or all operators on the platform's account). */
  usableAt: string;
  /** card: a saved card; ewallet: a linked e-wallet. */
  kind: 'card' | 'ewallet';
  /** E-wallets: GOPAY | OVO | DANA, and the masked phone of the account. */
  channel: string | null;
  accountLabel: string | null;
  /** E-wallets: pending until the driver approves in the e-wallet app. */
  status: 'pending' | 'active' | 'failed';
}

interface Row {
  id: string; app_driver_id: string; integration_id: string | null; provider: string; token_sealed: string; brand: string | null; last4: string | null;
  exp_month: number | null; exp_year: number | null; token_expires_at: Date | null; created_at: Date; last_used_at: Date | null;
  operator?: string | null;
  kind: 'card' | 'ewallet'; channel: string | null; account_label: string | null; status: 'pending' | 'active' | 'failed'; link_ref: string | null;
}

function isExpired(r: Row, now = new Date()): boolean {
  if (r.token_expires_at && new Date(r.token_expires_at) < now) return true;
  if (r.exp_year && r.exp_month) return new Date(Date.UTC(r.exp_year, r.exp_month, 1)) <= now; // valid through the end of the month
  return false;
}

const view = (r: Row): DriverCard => ({
  id: r.id, brand: r.brand, last4: r.last4, expMonth: r.exp_month, expYear: r.exp_year, provider: r.provider, integrationId: r.integration_id,
  createdAt: new Date(r.created_at).toISOString(), lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null, expired: isExpired(r),
  usableAt: r.operator ?? 'PlugSure',
  kind: r.kind ?? 'card', channel: r.channel ?? null, accountLabel: r.account_label ?? null, status: r.status ?? 'active',
});

/** Keep a card the acquirer saved at the driver's request. Idempotent per card and account. */
export async function saveCard(appDriverId: string, acquirer: { provider: string; integrationId: string | null }, card: SavedCardInfo): Promise<string | null> {
  if (!card.token) return null;
  return outsideRequestScope(async () => {
    const hash = hashOf(card.token);
    const existing = await one<{ id: string; status: string }>(
      `SELECT id, status FROM driver_card WHERE app_driver_id = $1 AND integration_id IS NOT DISTINCT FROM $2::uuid AND token_hash = $3 AND removed_at IS NULL`,
      [appDriverId, acquirer.integrationId, hash],
    );
    if (existing) {
      // Saved again with the same token after it was found ended: the acquirer took it again, so it works.
      if (existing.status === 'failed') await query(`UPDATE driver_card SET status = 'active' WHERE id = $1`, [existing.id]);
      return existing.id;
    }
    const row = await one<{ id: string }>(
      `INSERT INTO driver_card (app_driver_id, integration_id, provider, token_sealed, token_hash, brand, last4, exp_month, exp_year, token_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [appDriverId, acquirer.integrationId, acquirer.provider, seal(card.token), hash, card.brand, card.last4, card.expMonth ?? null, card.expYear ?? null, card.tokenExpiresAt ?? null],
    );
    logger.info({ appDriverId, provider: acquirer.provider, brand: card.brand }, 'card saved');
    return row?.id ?? null;
  });
}

/** The driver's cards; with an acquirer account given, only those that account can charge. */
export async function listCards(appDriverId: string, acquirer?: { provider: string; integrationId: string | null }): Promise<DriverCard[]> {
  const rows = await outsideRequestScope(() => many<Row>(
    `SELECT k.*, o.name AS operator FROM driver_card k
       LEFT JOIN integration i ON i.id = k.integration_id LEFT JOIN organisation o ON o.id = i.org_id
      WHERE k.app_driver_id = $1 AND k.removed_at IS NULL AND k.status <> 'failed'
        AND ($2::text IS NULL OR (k.provider = $2 AND k.integration_id IS NOT DISTINCT FROM $3::uuid))
      ORDER BY COALESCE(k.last_used_at, k.created_at) DESC`,
    [appDriverId, acquirer?.provider ?? null, acquirer?.integrationId ?? null],
  ));
  return rows.map(view);
}

/** A saved card as the driver knows it. */
export interface CardLabel { brand: string | null; last4: string | null }

/**
 * The token to charge a saved card with: only the owner's, at the account that issued it, not expired.
 * A card whose token has ended (expired, or found ended at the acquirer) says so in `ended`.
 */
export async function cardToken(appDriverId: string, cardId: string, acquirer: { provider: string; integrationId: string | null }): Promise<({ token: string } & CardLabel) | { error: string; ended?: CardLabel & { expired: boolean } }> {
  if (!/^[0-9a-f-]{36}$/i.test(cardId)) return { error: 'Kartu tidak ditemukan.' };
  const r = await outsideRequestScope(() => one<Row>(`SELECT * FROM driver_card WHERE id = $1 AND app_driver_id = $2 AND removed_at IS NULL AND kind = 'card'`, [cardId, appDriverId]));
  if (!r) return { error: 'Kartu tidak ditemukan.' };
  if (r.provider !== acquirer.provider || (r.integration_id ?? null) !== (acquirer.integrationId ?? null)) return { error: 'Kartu ini tersimpan di operator lain dan tidak bisa dipakai di sini.' };
  if (isExpired(r)) return { error: 'Kartu ini sudah kedaluwarsa. Bayar dengan kartu baru.', ended: { brand: r.brand, last4: r.last4, expired: true } };
  if (r.status === 'failed') return { error: 'Kartu ini tidak bisa dipakai lagi. Simpan ulang kartu Anda.', ended: { brand: r.brand, last4: r.last4, expired: false } };
  try { return { token: unseal(r.token_sealed), brand: r.brand, last4: r.last4 }; } catch { return { error: 'Kartu ini tidak bisa dipakai lagi. Simpan ulang kartu Anda.' }; }
}

/**
 * The acquirer no longer accepts the saved card's token (the card was deleted there, replaced, or
 * the token expired): it is no longer offered. Its row stays for the payments made with it.
 */
export async function endCard(id: string): Promise<void> {
  await outsideRequestScope(async () => {
    const r = await one<Row>(`UPDATE driver_card SET status = 'failed' WHERE id = $1 AND kind = 'card' AND status = 'active' RETURNING *`, [id]);
    if (r) logger.info({ appDriverId: r.app_driver_id, brand: r.brand }, 'saved card token ended at the acquirer');
  });
}

export async function markUsed(cardId: string) {
  await outsideRequestScope(() => query(`UPDATE driver_card SET last_used_at = now() WHERE id = $1`, [cardId]));
}

/** Forget a card (and tell the acquirer where it can be told). */
export async function removeCard(appDriverId: string, cardId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(cardId)) return false;
  const r = await outsideRequestScope(() => one<Row>(
    `UPDATE driver_card SET removed_at = now() WHERE id = $1 AND app_driver_id = $2 AND removed_at IS NULL RETURNING *`,
    [cardId, appDriverId],
  ));
  if (!r) return false;
  try {
    const { byId } = await import('../../integrations/store.js');
    const { providerFor } = await import('./registry.js');
    const acq = r.integration_id ? await byId(r.integration_id) : null;
    const p = acq ? providerFor(acq) : null;
    if (r.kind === 'ewallet') { if (p?.unlinkWallet && r.link_ref) await p.unlinkWallet(r.link_ref, r.channel as any); }
    else if (p?.deleteSavedCard) await p.deleteSavedCard(unseal(r.token_sealed), appDriverId);
  } catch (e) {
    logger.warn({ card: cardId, err: (e as Error).message }, 'saved card removed here; the acquirer could not be told');
  }
  return true;
}

// ---------------------------------------------------------------- linked e-wallets

/** Record a link the driver is approving in the e-wallet app (active at once when the acquirer says so). */
export async function startLink(appDriverId: string, acquirer: { provider: string; integrationId: string | null }, a: { channel: string; linkRef: string; accountLabel: string | null; token?: string }): Promise<string> {
  return outsideRequestScope(async () => {
    const active = !!a.token;
    // Active at once: it replaces the older link of the same e-wallet now (it may carry the same token).
    if (active) {
      await query(
        `UPDATE driver_card SET removed_at = now() WHERE app_driver_id = $1 AND kind = 'ewallet' AND channel = $2 AND provider = $3
            AND integration_id IS NOT DISTINCT FROM $4::uuid AND removed_at IS NULL`,
        [appDriverId, a.channel, acquirer.provider, acquirer.integrationId],
      );
    }
    const row = await one<{ id: string }>(
      `INSERT INTO driver_card (app_driver_id, integration_id, provider, token_sealed, token_hash, kind, channel, account_label, status, link_ref)
       VALUES ($1,$2,$3,$4,$5,'ewallet',$6,$7,$8,$9) RETURNING id`,
      [appDriverId, acquirer.integrationId, acquirer.provider, active ? seal(a.token!) : '', hashOf(active ? a.token! : `link:${a.linkRef}`), a.channel, a.accountLabel, active ? 'active' : 'pending', a.linkRef],
    );
    return row!.id;
  });
}

/** The driver's link (theirs only). */
export async function linkOf(appDriverId: string, id: string): Promise<(DriverCard & { linkRef: string | null }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await outsideRequestScope(() => one<Row>(
    `SELECT k.*, o.name AS operator FROM driver_card k LEFT JOIN integration i ON i.id = k.integration_id LEFT JOIN organisation o ON o.id = i.org_id
      WHERE k.id = $1 AND k.app_driver_id = $2 AND k.kind = 'ewallet' AND k.removed_at IS NULL`, [id, appDriverId]));
  return r ? { ...view(r), linkRef: r.link_ref } : null;
}

/** The acquirer approved (or refused) the link. An e-wallet linked again replaces the older link of the same kind. */
export async function settleLink(id: string, outcome: { status: 'active'; token: string } | { status: 'failed' }): Promise<void> {
  await outsideRequestScope(async () => {
    if (outcome.status === 'failed') { await query(`UPDATE driver_card SET status = 'failed' WHERE id = $1 AND status = 'pending'`, [id]); return; }
    const p = await one<Row>(`SELECT * FROM driver_card WHERE id = $1 AND status = 'pending'`, [id]);
    if (!p) return;
    // Retire the older link first: linked again (e.g. after it ended in the e-wallet app), the acquirer
    // may return the same token, which may exist only once among a driver's live cards.
    await query(
      `UPDATE driver_card SET removed_at = now() WHERE app_driver_id = $1 AND kind = 'ewallet' AND channel = $2 AND provider = $3
          AND integration_id IS NOT DISTINCT FROM $4::uuid AND id <> $5 AND removed_at IS NULL`,
      [p.app_driver_id, p.channel, p.provider, p.integration_id, p.id],
    );
    const r = await one<Row>(
      `UPDATE driver_card SET status = 'active', token_sealed = $2, token_hash = $3 WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, seal(outcome.token), hashOf(outcome.token)],
    );
    if (r) logger.info({ appDriverId: r.app_driver_id, channel: r.channel }, 'e-wallet linked');
  });
}

/**
 * The acquirer says the link has ended (unlinked in the e-wallet app, or expired): it is
 * no longer offered, and the e-wallet can be linked again. Its row stays for the payments made with it.
 */
export async function endLink(id: string): Promise<void> {
  await outsideRequestScope(async () => {
    const r = await one<Row>(`UPDATE driver_card SET status = 'failed' WHERE id = $1 AND kind = 'ewallet' AND status = 'active' RETURNING *`, [id]);
    if (r) logger.info({ appDriverId: r.app_driver_id, channel: r.channel }, 'e-wallet link ended at the acquirer');
  });
}

/** The driver's active link of this e-wallet at this acquirer account, if any (after linking again). */
export async function currentLink(appDriverId: string, channel: string, acquirer: { provider: string; integrationId: string | null }): Promise<{ id: string; token: string } | null> {
  const r = await outsideRequestScope(() => one<Row>(
    `SELECT * FROM driver_card WHERE app_driver_id = $1 AND kind = 'ewallet' AND channel = $2 AND provider = $3
        AND integration_id IS NOT DISTINCT FROM $4::uuid AND status = 'active' AND removed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [appDriverId, channel, acquirer.provider, acquirer.integrationId]));
  if (!r) return null;
  try { return { id: r.id, token: unseal(r.token_sealed) }; } catch { return null; }
}

/** The token to charge a linked e-wallet with: the owner's, active, at the account that linked it. */
export async function walletToken(appDriverId: string, id: string, acquirer: { provider: string; integrationId: string | null }): Promise<{ token: string; channel: string } | { error: string; ended?: { channel: string } }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { error: 'E-wallet tidak ditemukan.' };
  const r = await outsideRequestScope(() => one<Row>(`SELECT * FROM driver_card WHERE id = $1 AND app_driver_id = $2 AND removed_at IS NULL AND kind = 'ewallet'`, [id, appDriverId]));
  if (!r) return { error: 'E-wallet tidak ditemukan.' };
  if (r.status === 'failed' && r.token_sealed) return { error: 'Tautan e-wallet ini sudah tidak aktif. Hubungkan lagi, atau pilih metode lain.', ended: { channel: String(r.channel) } };
  if (r.status !== 'active') return { error: 'E-wallet ini belum terhubung. Setujui dulu di aplikasinya.' };
  if (r.provider !== acquirer.provider || (r.integration_id ?? null) !== (acquirer.integrationId ?? null)) return { error: 'E-wallet ini terhubung di operator lain dan tidak bisa dipakai di sini.' };
  try { return { token: unseal(r.token_sealed), channel: String(r.channel) }; } catch { return { error: 'E-wallet ini perlu dihubungkan ulang.' }; }
}