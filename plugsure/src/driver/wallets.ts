import { one } from '../db/pool.js';
import { logger } from '../logger.js';
import { byId } from '../integrations/store.js';
import { paymentsFor, PaymentsUnavailable, providerFor, walletOptions } from '../services/payments/registry.js';
import { linkOf, settleLink, startLink } from '../services/payments/cards.js';
import { CHANNEL_LABEL, maskAccount, type Channel } from '../services/payments/provider.js';
import type { DriverPrincipal } from './identity.js';

/**
 * Linked e-wallets (GoPay, OVO, DANA) — link once, pay in one tap.
 *
 * The driver starts linking at a charger (or a pass): the operator's acquirer
 * account is the one that will hold the link. The acquirer returns an approval
 * link that opens the e-wallet app; the driver approves and comes back to
 * /app/paid.html?for=link, and the app polls the link here until it is active.
 * Tokens are sealed and never leave the server.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which operator a link is for: the charger's, or the pass plan's. */
async function orgFor(where: { connectorId?: string | null; planId?: string | null }): Promise<string | null> {
  if (where.connectorId && UUID_RE.test(where.connectorId)) {
    const r = await one<{ org_id: string }>(`SELECT s.org_id FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id WHERE c.id = $1`, [where.connectorId]);
    return r?.org_id ?? null;
  }
  if (where.planId && UUID_RE.test(where.planId)) return (await one<{ org_id: string }>(`SELECT org_id FROM subscription_plan WHERE id = $1`, [where.planId]))?.org_id ?? null;
  return null;
}

export async function linkWallet(p: DriverPrincipal, b: { connectorId?: string | null; planId?: string | null; channel?: string; phone?: string | null }, returnUrl: string) {
  if (!p.appDriverId) return { ok: false as const, status: 401, error: 'Masuk dengan nomor HP untuk menghubungkan e-wallet.' };
  const orgId = await orgFor(b);
  if (!orgId) return { ok: false as const, status: 404, error: 'Charger atau paket tidak ditemukan.' };
  let acq: Awaited<ReturnType<typeof paymentsFor>>;
  try { acq = await paymentsFor(orgId); } catch (e) { if (e instanceof PaymentsUnavailable) return { ok: false as const, status: 422, error: 'Pembayaran belum tersedia di operator ini.' }; throw e; }
  const channel = String(b.channel ?? '').toUpperCase() as Channel;
  if (!walletOptions(acq.resolved, acq.provider).includes(channel) || !acq.provider.linkWallet) {
    return { ok: false as const, status: 422, error: `${CHANNEL_LABEL[channel] ?? channel} tidak bisa dihubungkan di operator ini.` };
  }
  // 0812…, 62812… or +62 812-… → +62812…; the e-wallet account's own number.
  const digits = String(b.phone || p.account?.phone || '').replace(/[^\d]/g, '').replace(/^0/, '62');
  if (!/^628\d{7,12}$/.test(digits)) return { ok: false as const, status: 422, error: `Masukkan nomor HP akun ${CHANNEL_LABEL[channel]} Anda (+62…).` };
  const phone = `+${digits}`;
  let link;
  try {
    link = await acq.provider.linkWallet({ channel, customerId: p.appDriverId, phone, returnUrl });
  } catch (e) {
    logger.warn({ channel, err: (e as Error).message }, 'e-wallet linking refused');
    return { ok: false as const, status: 422, error: `${CHANNEL_LABEL[channel]} tidak bisa dihubungkan sekarang. Coba lagi nanti.` };
  }
  if (link.status === 'failed') return { ok: false as const, status: 422, error: `${CHANNEL_LABEL[channel]} menolak permintaan ini.` };
  const id = await startLink(p.appDriverId, { provider: acq.resolved.provider, integrationId: acq.resolved.integrationId },
    { channel, linkRef: link.linkRef, accountLabel: maskAccount(phone), ...(link.token ? { token: link.token } : {}) });
  if (link.token) await settleLink(id, { status: 'active', token: link.token }).catch(() => undefined);
  return { ok: true as const, id, channel, status: link.token ? 'active' : 'pending', activationUrl: link.activationUrl, accountLabel: maskAccount(phone) };
}

/** Where a link stands; a pending one is checked with the acquirer. */
export async function walletLinkStatus(p: DriverPrincipal, id: string) {
  if (!p.appDriverId) return null;
  const w = await linkOf(p.appDriverId, id);
  if (!w) return null;
  if (w.status === 'pending' && w.linkRef) {
    try {
      const acq = w.integrationId ? await byId(w.integrationId) : null;
      const provider = acq ? providerFor(acq) : (await import('../services/payments/registry.js')).sandboxProvider();
      const s = provider.walletStatus ? await provider.walletStatus(w.linkRef, w.channel as Channel) : { status: 'pending' as const };
      if (s.status === 'active' && s.token) { await settleLink(w.id, { status: 'active', token: s.token }); return { id: w.id, channel: w.channel, accountLabel: w.accountLabel, status: 'active' }; }
      if (s.status === 'failed') { await settleLink(w.id, { status: 'failed' }); return { id: w.id, channel: w.channel, accountLabel: w.accountLabel, status: 'failed' }; }
    } catch (e) {
      logger.warn({ id, err: (e as Error).message }, 'could not check an e-wallet link');
    }
  }
  return { id: w.id, channel: w.channel, accountLabel: w.accountLabel, status: w.status };
}
