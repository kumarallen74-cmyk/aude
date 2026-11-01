import { $, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, download } from '../core.js';
import { CURRENCIES } from '../money.js';

/**
 * (v1.45.0) Commercial → Credit & referrals: gift cards (sold) and vouchers (given away) as codes drivers redeem in the
 * app, referral rewards, and the settings for paying with credit.
 */

const REF = { pending: ['t-info', 'waiting for a first session'], rewarded: ['t-ok', 'rewarded'], rejected: ['t-crit', 'refused'] };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };
const major = (minor, cur) => fmt.money(minor, cur);
/** Minor units per major unit of a currency (an amount typed in the form is in major units). */
const unitOf = (cur) => 10 ** (CURRENCIES[cur]?.exponent ?? 2);

registerView('driver-credit', {
  title: 'Credit & referrals',
  icon: 'gift',
  group: 'commercial',
  order: 24,
  perm: 'tariff:read',
  async render(root) {
    const canWrite = state.can('tariff:write');
    root.innerHTML = pageHead('Credit & referrals',
      'Gift cards you sell and vouchers you give away are codes drivers redeem in the app for credit; drivers who bring a friend earn credit too. Drivers pay for charging with it: the rest goes through the payment gateway, and what a session does not use comes back as credit.',
      canWrite ? `<button class="btn" type="button" data-set>${icon('gear')} Settings</button><button class="btn primary" type="button" data-batch>${icon('plus')} Create codes</button>` : '') + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    let d;
    const draw = async () => {
      try { d = await api('/v1/credit'); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const s = d.settings, o = d.outstanding, m = d.month, cur = s.currency;
      body.innerHTML = `${s.enabled ? '' : callout('info', 'Credit is off: codes cannot be redeemed and drivers cannot pay with credit. Switch it on in Settings.')}
        <div class="grid k4">${kpi('Gift card credit', major(o.fundedMinor, cur), 'paid for, owed to drivers')}${kpi('Promotional credit', major(o.promotionalMinor, cur), 'vouchers and referrals')}
          ${kpi('Held by charges', major(o.heldMinor, cur), 'in sessions now')}${kpi('Used this month', major(m.usedFundedMinor + m.usedPromotionalMinor, cur), `${major(m.usedPromotionalMinor, cur)} promotional`)}</div>
        <div class="card section"><header><h3>Codes</h3><span class="cell-sub">Each code is shown once, when it is created: download them then</span></header><div data-b></div></div>
        <div class="card section"><header><h3>Referrals</h3><span class="cell-sub">${s.referralEnabled ? `The referrer gets ${major(s.referrerRewardMinor, cur)}, the new driver ${major(s.refereeRewardMinor, cur)}, after a first paid session of ${fmt.num(s.referralMinKwh, 1)} kWh or more` : 'Off'}</span></header><div data-r></div></div>`;
      table($('[data-b]', body), { columns: [
        { label: 'Batch', render: (b) => `<div class="cell-title">${esc(b.name)}</div><div class="cell-sub">${b.kind === 'gift' ? `Gift cards${b.buyer ? ` for ${esc(b.buyer)}` : ''}` : 'Vouchers'} · ${esc(fmt.time(b.createdAt))}</div>` },
        { label: 'Value', num: true, render: (b) => `${major(b.valueMinor, b.currency)}${b.kind === 'gift' && b.priceMinor !== b.valueMinor ? `<div class="cell-sub">sold at ${major(b.priceMinor, b.currency)}</div>` : ''}` },
        { label: 'Redeemed', num: true, render: (b) => `${fmt.num(b.redeemed)} / ${fmt.num(b.quantity)}` },
        { label: 'Ends', render: (b) => (b.expiresOn ? esc(fmt.date(b.expiresOn)) : '<span class="muted">—</span>') },
        { label: '', render: (b) => (b.voided ? tag('t-mute', 'voided') : canWrite && b.redeemed < b.quantity ? `<button class="btn sm" type="button" data-void="${esc(b.id)}">Void unused</button>` : '') },
      ], rows: d.batches, empty: 'No codes yet.' });
      table($('[data-r]', body), { columns: [
        { label: 'Referrer', render: (r) => `<span class="mono">${esc(r.referrer ?? '—')}</span>` },
        { label: 'New driver', render: (r) => `<span class="mono">${esc(r.referee ?? '—')}</span>` },
        { label: 'Status', render: (r) => `${tag(...REF[r.status])}${r.reason ? `<div class="cell-sub">${esc(r.reason)}</div>` : ''}` },
        { label: 'When', render: (r) => esc(fmt.time(r.rewardedAt ?? r.createdAt)) },
      ], rows: d.referrals, empty: 'No referrals yet.' });
    };
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-void]');
      if (!b) return;
      if (!confirm('Void the codes of this batch that are not redeemed yet? Credit already redeemed stays the drivers\'.')) return;
      try { const r = await api(`/v1/credit/batches/${b.dataset.void}/void`, { method: 'POST' }); toast(`${r.voidedCards} codes voided.`, 'ok'); draw(); } catch (err) { toast(err.message, 'crit'); }
    });
    $('[data-batch]', root)?.addEventListener('click', () => modal({ title: 'Create codes', size: 'lg', body: `<div class="form grid2">
        ${field('Name', '<input name="n" placeholder="Corporate gifts, Q4">')}
        ${field('Kind', '<select name="k"><option value="gift">Gift cards (sold)</option><option value="voucher">Vouchers (given away)</option></select>')}
        ${field(`Value each (${fmt.sym(d?.settings.currency)})`, '<input name="v" type="number" min="1" step="1">')}
        ${field('How many', '<input name="q" type="number" min="1" max="10000" value="10">')}
        ${field(`Price paid each (${fmt.sym(d?.settings.currency)})`, '<input name="p" type="number" min="0" step="1">', { help: 'Gift cards: what the buyer paid per card (at most its value). Empty: its value.' })}
        ${field('Sold on', `<input name="so" type="date" value="${new Date().toISOString().slice(0, 10)}">`)}
        ${field('Buyer', '<input name="by" placeholder="PT Contoh">')}${field('Codes end on', '<input name="e" type="date">')}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Create', kind: 'primary', onClick: guard(async (mc) => {
        const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
        const unit = unitOf(d.settings.currency);
        const kind = v('k');
        const r = await api('/v1/credit/batches', { method: 'POST', body: { name: v('n'), kind, valueMinor: Math.round(Number(v('v')) * unit), quantity: Number(v('q')),
          ...(kind === 'gift' ? { priceMinor: v('p') ? Math.round(Number(v('p')) * unit) : undefined, soldOn: v('so'), buyer: v('by') || null } : {}), expiresOn: v('e') || null } });
        const csv = `code,value,currency,batch\n${r.codes.map((c) => `${c},${r.batch.valueMinor / unit},${r.batch.currency},"${r.batch.name.replace(/"/g, '""')}"`).join('\n')}\n`;
        download(`plugsure-codes-${r.batch.id}.csv`, csv, 'text/csv');
        modal({ title: `${r.codes.length} codes created`, body: `${callout('warn', 'The codes are shown only now. The CSV was downloaded; keep it safe — each code is worth its value.')}<pre style="max-height:240px;overflow:auto" class="mono">${esc(r.codes.slice(0, 50).join('\n'))}${r.codes.length > 50 ? `\n… ${r.codes.length - 50} more in the CSV` : ''}</pre>`, actions: [{ label: 'Done' }] });
        draw();
      }) }] }));
    $('[data-set]', root)?.addEventListener('click', () => {
      const s = d.settings, unit = unitOf(s.currency);
      modal({ title: 'Credit settings', size: 'lg', body: `<div class="form grid2">
          <label class="row" style="gap:6px;grid-column:1/-1"><input type="checkbox" name="en" ${s.enabled ? 'checked' : ''}> Credit is on: codes can be redeemed, and drivers can pay with credit</label>
          ${field('Credit expires after (months)', `<input name="x" type="number" min="1" max="60" value="${s.expiryMonths}">`)}
          ${field(`Paid through the gateway at least (${fmt.sym(s.currency)})`, `<input name="g" type="number" min="0" value="${s.minGatewayMinor / unit}">`, { help: 'On a charge paid partly with credit (your acquirer\'s minimum).' })}
          <label class="row" style="gap:6px;grid-column:1/-1"><input type="checkbox" name="re" ${s.referralEnabled ? 'checked' : ''}> Referrals: drivers who have charged get a code to share</label>
          ${field(`Referrer gets (${fmt.sym(s.currency)})`, `<input name="rr" type="number" min="0" value="${s.referrerRewardMinor / unit}">`)}
          ${field(`New driver gets (${fmt.sym(s.currency)})`, `<input name="rn" type="number" min="0" value="${s.refereeRewardMinor / unit}">`)}
          ${field('After a first paid session of (kWh)', `<input name="mk" type="number" min="0" step="0.5" value="${s.referralMinKwh}">`)}
          ${field('At most per referrer a month', `<input name="cap" type="number" min="0" max="1000" value="${s.referralMonthlyCap}">`)}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name="${n}"]`, mc.el);
          await api('/v1/credit/settings', { method: 'PUT', body: { enabled: v('en').checked, currency: s.currency, expiryMonths: Number(v('x').value), minGatewayMinor: Math.round(Number(v('g').value) * unit),
            referralEnabled: v('re').checked, referrerRewardMinor: Math.round(Number(v('rr').value) * unit), refereeRewardMinor: Math.round(Number(v('rn').value) * unit), referralMinKwh: Number(v('mk').value), referralMonthlyCap: Number(v('cap').value) } });
          toast('Saved.', 'ok'); draw();
        }) }] });
    });
    await draw();
  },
});
