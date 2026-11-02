import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options } from '../core.js';

/**
 * (v1.49.0) Maintain → Warranty & RMA: what each charger's manufacturer covers and until when, and the faulty
 * chargers and parts sent back to them (RMA cases) from the request to the replacement.
 */

const COVER = { covered: ['t-ok', 'covered'], expiring: ['t-warn', 'ending soon'], expired: ['t-crit', 'expired'], none: ['t-mute', 'no warranty'] };
const RMA = { open: ['t-warn', 'open'], requested: ['t-info', 'requested'], approved: ['t-info', 'approved'], shipped: ['t-info', 'shipped'], replaced: ['t-ok', 'replaced'], closed: ['t-mute', 'closed'], rejected: ['t-crit', 'rejected'] };
const FLOW = { open: ['requested', 'rejected'], requested: ['approved', 'rejected'], approved: ['shipped', 'rejected'], shipped: ['replaced', 'rejected'], replaced: ['closed'] };
const LABEL = { requested: 'Requested from the manufacturer', approved: 'Approved', shipped: 'Shipped', replaced: 'Replacement received', closed: 'Close', rejected: 'Rejected' };
const COVERS = [['parts', 'Parts'], ['labour', 'Labour'], ['shipping', 'Shipping'], ['on_site', 'On-site service']];
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };

registerView('warranty', {
  title: 'Warranty & RMA',
  icon: 'shield',
  group: 'maintain',
  order: 29,
  perm: 'charge_point:read',
  async render(root) {
    const canWrite = state.can('charge_point:write');
    root.innerHTML = pageHead('Warranty & RMA', 'What each charger\'s manufacturer covers and until when, and the chargers and parts returned to them.',
      canWrite ? `<button class="btn primary" type="button" data-open>${icon('plus')} Open an RMA case</button>` : '')
      + '<div class="tabs" role="tablist"><button role="tab" type="button" data-tab="ch">Chargers</button><button role="tab" type="button" data-tab="rma">RMA cases</button></div><div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    let tab = 'ch', filter = '', chargers = [], suppliers = null;
    const sup = async () => suppliers ?? (suppliers = state.can('payment:read') ? await api('/v1/finance/suppliers').then((r) => r.suppliers ?? []).catch(() => []) : []);

    const warrantyModal = async (cp, w) => {
      const s = await sup();
      modal({ title: w ? 'Change the warranty' : `Add a warranty · ${cp.name}`, body: `<div class="form grid2">${field('Manufacturer or supplier', `<select name="sup">${options(s.map((x) => ({ value: x.id, label: x.name })), w?.supplierId ?? '', { blank: 'Not recorded' })}</select>`)}
          ${field('Reference', `<input name="ref" maxlength="80" value="${esc(w?.reference ?? '')}">`)}
          ${field('From', `<input name="from" type="date" value="${esc(w?.startsOn ?? '')}">`)}${field('To', `<input name="to" type="date" value="${esc(w?.endsOn ?? '')}">`)}
          ${field('Covers', COVERS.map(([v, l]) => `<label style="display:inline-flex;gap:4px;margin-right:10px"><input type="checkbox" name="cov" value="${v}"${(w?.covers ?? ['parts']).includes(v) ? ' checked' : ''}>${l}</label>`).join(''), { full: true })}
          ${field('An extension', `<select name="ext">${options([{ value: '0', label: 'No, the original warranty' }, { value: '1', label: 'Yes, an extended warranty' }], w?.extended ? '1' : '0')}</select>`)}
          ${field('Terms', `<textarea name="terms" rows="2" maxlength="1000">${esc(w?.terms ?? '')}</textarea>`, { full: true })}</div>`,
      actions: [...(w ? [{ label: 'Remove', kind: 'danger', onClick: guard(async () => { await api(`/v1/warranties/${w.id}`, { method: 'PUT', body: { remove: true } }); draw(); }) }] : []),
        { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
          await api(w ? `/v1/warranties/${w.id}` : '/v1/warranties', { method: w ? 'PUT' : 'POST', body: { chargePointId: cp.id, supplierId: v('sup') || null, reference: v('ref') || null, startsOn: v('from'), endsOn: v('to'),
            covers: $$('[name="cov"]:checked', mc.el).map((x) => x.value), extended: v('ext') === '1', terms: v('terms') || null } });
          toast('Saved.', 'ok'); draw();
        }) }] });
    };

    const chargerModal = async (cp) => {
      let x;
      try { x = await api(`/v1/warranty/chargers/${cp.id}`); } catch (e) { toast(e.message, 'crit'); return; }
      modal({ title: `${cp.name} · warranty`, size: 'lg', body: `<p class="cell-sub">${esc([cp.vendor, cp.model, cp.serial && `serial ${cp.serial}`, cp.site].filter(Boolean).join(' · '))}</p>
          <h4 style="margin:10px 0 6px">Warranties</h4><div data-w></div><h4 style="margin:14px 0 6px">RMA cases</h4><div data-r></div>`,
      actions: [...(canWrite ? [{ label: 'Open an RMA case', onClick: () => rmaOpenModal(cp) }, { label: 'Add a warranty', kind: 'primary', onClick: () => warrantyModal(cp, null) }] : []), { label: 'Close' }],
      onMount: (mc) => {
        table($('[data-w]', mc.el), { columns: [{ label: 'From → to', render: (w) => `${esc(w.startsOn)} → <b>${esc(w.endsOn)}</b>${w.extended ? ` ${tag('t-info', 'extended')}` : ''}` }, { label: 'State', render: (w) => tag(...COVER[w.state]) },
          { label: 'Supplier', render: (w) => `${esc(w.supplier ?? '—')}<div class="cell-sub">${esc(w.reference ?? '')}</div>` }, { label: 'Covers', render: (w) => esc(w.covers.map((c) => c.replace('_', '-')).join(', ')) }],
        rows: x.warranties, empty: 'No warranty recorded.', onRow: canWrite ? (w) => { mc.close(); warrantyModal(cp, w); } : undefined });
        table($('[data-r]', mc.el), { columns: [{ label: 'Case', render: (r) => `<b>${esc(r.number)}</b> ${esc(r.part)}` }, { label: 'Status', render: (r) => tag(...RMA[r.status]) }, { label: 'Opened', render: (r) => esc(fmt.date(r.createdAt)) }],
          rows: x.rma, empty: 'No RMA cases.', onRow: (r) => { mc.close(); rmaModal(r.id); } });
      } });
    };

    const rmaOpenModal = async (cp) => {
      const s = await sup();
      const list = cp ? [cp] : chargers;
      modal({ title: 'Open an RMA case', size: 'lg', body: `<div class="form grid2">${field('Charger', `<select name="cp">${options(list.map((c) => ({ value: c.id, label: `${c.name}${c.site ? ` · ${c.site}` : ''} (${COVER[c.state][1]})` })), cp?.id ?? '')}</select>`, { full: true })}
          ${field('What is returned', '<input name="part" maxlength="120" placeholder="The charger, a power module, a cable …">')}${field('Its serial number', '<input name="ps" maxlength="80">')}
          ${field('Manufacturer or supplier', `<select name="sup">${options(s.map((x) => ({ value: x.id, label: x.name })), '', { blank: 'The warranty\'s' })}</select>`)}
          ${field('Work order number (optional)', '<input name="wo" type="number" min="1" placeholder="Its id">', { help: 'Link the work order where the money recovered is claimed.' })}
          ${field('Fault', '<textarea name="fault" rows="3" maxlength="2000"></textarea>', { full: true })}</div>`,
      actions: [{ label: 'Cancel' }, { label: 'Open the case', kind: 'primary', onClick: guard(async (mc) => {
        const v = (n) => $(`[name="${n}"]`, mc.el).value.trim();
        const r = await api('/v1/rma', { method: 'POST', body: { chargePointId: v('cp'), part: v('part'), partSerial: v('ps') || null, supplierId: v('sup') || null, workOrderId: v('wo') || null, fault: v('fault') } });
        toast(`${r.number} opened: ${r.inWarranty ? 'in warranty' : 'out of warranty'}.`, 'ok'); tab = 'rma'; draw();
      }) }] });
    };

    const rmaModal = async (id) => {
      let r;
      try { r = await api(`/v1/rma/${id}`); } catch (e) { toast(e.message, 'crit'); return; }
      const next = FLOW[r.status] ?? [];
      const inp = (n, label, val) => field(label, `<input name="${n}" maxlength="80" value="${esc(val ?? '')}">`);
      modal({ title: `${r.number} · ${r.part}`, size: 'lg', body: `<p>${tag(...RMA[r.status])} ${r.inWarranty ? tag('t-ok', 'in warranty') : tag('t-warn', 'out of warranty')} · ${esc(r.charger ?? '')}${r.site ? ` · ${esc(r.site)}` : ''}${r.supplier ? ` · ${esc(r.supplier)}` : ''}${r.workOrder ? ` · work order ${esc(r.workOrder)}` : ''}</p>
          <p class="cell-sub">${esc(r.fault)}</p>
          <div class="form grid2">${inp('vr', 'Manufacturer\'s RMA number', r.vendorRef)}${inp('to', 'Tracking (sent)', r.trackingOut)}${inp('tb', 'Tracking (back)', r.trackingBack)}${inp('rs', 'Replacement serial', r.replacementSerial)}
            ${field(`Charged by the manufacturer (${esc(r.currency)}, minor units)`, `<input name="cost" type="number" min="0" value="${r.costMinor ?? ''}">`)}${field('Outcome', `<input name="out" maxlength="500" value="${esc(r.outcome ?? '')}">`)}
            ${canWrite && next.length ? field('Move to', `<select name="st">${options(next.map((x) => ({ value: x, label: LABEL[x] })), '', { blank: 'Stay where it is' })}</select>`) : ''}
            ${canWrite && r.status === 'shipped' && /charger/i.test(r.part) ? field('Charger serial', '<label style="display:inline-flex;gap:6px"><input type="checkbox" name="ucs"> Set the charger\'s serial to the replacement\'s</label>') : ''}
            ${canWrite ? field('Note', '<input name="note" maxlength="500">', { full: true }) : ''}</div>
          <h4 style="margin:12px 0 6px">History</h4>${r.history.slice().reverse().map((h) => `<div class="cell-sub">${esc(fmt.time(h.at))} · ${esc(h.status)}${h.note ? ` · ${esc(h.note)}` : ''}</div>`).join('')}`,
      actions: canWrite && !['closed', 'rejected'].includes(r.status) ? [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
        const v = (n) => $(`[name="${n}"]`, mc.el)?.value.trim();
        await api(`/v1/rma/${r.id}`, { method: 'PUT', body: { vendorRef: v('vr') || null, trackingOut: v('to') || null, trackingBack: v('tb') || null, replacementSerial: v('rs') || null,
          costMinor: v('cost') === '' ? null : Number(v('cost')), outcome: v('out') || null, note: v('note') || null, ...(v('st') ? { status: v('st') } : {}), updateChargerSerial: !!$('[name="ucs"]', mc.el)?.checked } });
        toast('Saved.', 'ok'); draw();
      }) }] : [{ label: 'Close' }] });
    };

    const draw = async () => {
      $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
      try {
        if (tab === 'ch') {
          const d = await api('/v1/warranty/chargers');
          chargers = d.chargers;
          const rows = filter ? chargers.filter((c) => c.state === filter) : chargers;
          body.innerHTML = `${d.counts.expiring ? callout('warn', `${d.counts.expiring} charger warrant${d.counts.expiring === 1 ? 'y ends' : 'ies end'} within 60 days.`) : ''}
            <div class="grid k4">${kpi('Covered', fmt.num(d.counts.covered))}${kpi('Ending soon', fmt.num(d.counts.expiring), 'within 60 days', d.counts.expiring ? 'warn' : '')}${kpi('Expired', fmt.num(d.counts.expired))}${kpi('No warranty recorded', fmt.num(d.counts.none))}</div>
            <div class="card section"><header><h3>Chargers</h3><select data-f class="right" style="width:auto">${options([{ value: '', label: 'Every charger' }, ...Object.entries(COVER).map(([value, [, label]]) => ({ value, label }))], filter)}</select></header><div data-t></div></div>`;
          table($('[data-t]', body), { columns: [{ label: 'Charger', render: (c) => `<b>${esc(c.name)}</b><div class="cell-sub">${esc([c.site, c.vendor, c.model].filter(Boolean).join(' · '))}</div>` },
            { label: 'Warranty', render: (c) => `${tag(...COVER[c.state])}${c.endsOn ? `<div class="cell-sub">until ${esc(c.endsOn)}${c.daysLeft != null && c.daysLeft >= 0 ? ` (${fmt.num(c.daysLeft)} days)` : ''}</div>` : ''}` },
            { label: 'Supplier', render: (c) => esc(c.supplier ?? '—') }, { label: 'Covers', render: (c) => esc(c.covers.map((x) => x.replace('_', '-')).join(', ')) },
            { label: 'RMA', num: true, render: (c) => (c.rmaOpen ? tag('t-warn', `${c.rmaOpen} open`) : '') }], rows, empty: 'No chargers.', onRow: chargerModal });
          $('[data-f]', body).addEventListener('change', (e) => { filter = e.target.value; draw(); });
        } else {
          const d = await api('/v1/rma');
          if (!chargers.length) chargers = (await api('/v1/warranty/chargers')).chargers;
          const k = d.kpis;
          body.innerHTML = `<div class="grid k4">${kpi('Open', fmt.num(k.open))}${kpi('Waiting on the manufacturer', fmt.num(k.waitingOnManufacturer), '', k.waitingOnManufacturer ? 'warn' : '')}
              ${kpi('Median turnaround', k.medianTurnaroundDays == null ? '—' : `${fmt.num(k.medianTurnaroundDays)} days`, '12 months')}${kpi('Rejected', fmt.num(k.rejected12m), '12 months')}</div>
            <div class="card section"><header><h3>RMA cases</h3><span class="cell-sub">Open, and closed in the last 60 days</span></header><div data-t></div></div>`;
          table($('[data-t]', body), { columns: [{ label: 'Case', render: (r) => `<b>${esc(r.number)}</b> ${esc(r.part)}<div class="cell-sub">${esc(r.charger ?? '')}${r.site ? ` · ${esc(r.site)}` : ''}</div>` },
            { label: 'Status', render: (r) => `${tag(...RMA[r.status])}<div class="cell-sub">${fmt.num(r.daysInStatus)} days</div>` }, { label: 'Warranty', render: (r) => (r.inWarranty ? tag('t-ok', 'in') : tag('t-warn', 'out')) },
            { label: 'Supplier', render: (r) => `${esc(r.supplier ?? '—')}<div class="cell-sub">${esc(r.vendorRef ?? '')}</div>` }, { label: 'Cost', num: true, render: (r) => (r.costMinor == null ? '—' : fmt.money(r.costMinor, r.currency)) }],
          rows: d.cases, empty: 'No RMA cases.', onRow: (r) => rmaModal(r.id) });
        }
      } catch (e) { body.innerHTML = callout('crit', esc(e.message)); }
    };

    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; draw(); }));
    $('[data-open]', root)?.addEventListener('click', async () => { if (!chargers.length) chargers = (await api('/v1/warranty/chargers')).chargers; rmaOpenModal(null); });
    await draw();
  },
});
