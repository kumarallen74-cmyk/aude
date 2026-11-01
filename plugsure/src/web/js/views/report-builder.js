import { $, $$, esc, api, registerView, pageHead, icon, fmt, modal, toast, callout, field, download } from '../core.js';

/**
 * (v1.42.0) Operate → Report builder: choose a dataset, its columns (or group and aggregate), filters, sort and a chart;
 * run it, download it in Excel, save it, and e-mail it daily, weekly or monthly.
 */

// A modal action: an error is shown and the dialog stays open.
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };

const AGG = { '': 'value', count: 'count', count_distinct: 'distinct', sum: 'sum', avg: 'average', min: 'min', max: 'max' };
const OP = { eq: 'is', ne: 'is not', gt: '>', gte: '≥', lt: '<', lte: '≤', contains: 'contains', in: 'one of (a, b, …)', between: 'between', last_days: 'in the last … days', empty: 'is empty', not_empty: 'is not empty', is_true: 'is yes', is_false: 'is no' };
const NO_VALUE = new Set(['empty', 'not_empty', 'is_true', 'is_false']);

registerView('report-builder', {
  title: 'Report builder',
  icon: 'chart',
  group: 'operate',
  order: 16,
  perm: ['session:read', 'charge_point:read', 'payment:read'],
  async render(root, [savedParam]) {
    const cat = await api('/v1/reports/builder');
    if (!cat.datasets.length) { root.innerHTML = pageHead('Report builder', '') + callout('info', 'Your role cannot read any dataset.'); return; }
    root.innerHTML = pageHead('Report builder', 'Build your own report on sessions, chargers, outages, work orders or the ledger: pick the columns, filter, group and chart it; save it, download it in Excel, or have it e-mailed.',
      `<button class="btn" type="button" data-new>${icon('plus')} New report</button>`)
      + `<div class="row" style="gap:16px;align-items:flex-start;flex-wrap:wrap">
          <div class="card" style="flex:1 1 220px;max-width:100%"><header><h3>Saved reports</h3></header><div data-saved class="body"></div></div>
          <div class="stack" style="gap:12px;flex:999 1 480px;min-width:0;max-width:100%"><div class="card pad" data-builder></div><div class="card section" data-result style="min-width:0"></div></div></div>`;
    let current = { id: null, name: '', dataset: cat.datasets[0].key, spec: { columns: [], filters: [], groupBy: [], sort: null, limit: 1000, chart: null }, frequency: null, weekday: 1, recipients: [] };
    const ds = () => cat.datasets.find((d) => d.key === current.dataset) ?? cat.datasets[0];
    const fieldOpts = (sel, filter = () => true) => ds().fields.filter(filter).map((f) => `<option value="${esc(f.key)}"${f.key === sel ? ' selected' : ''}>${esc(f.label)}</option>`).join('');
    const isDate = (k) => ['date', 'datetime'].includes(ds().fields.find((f) => f.key === k)?.type);

    const loadSaved = async () => {
      const r = await api('/v1/reports/saved');
      $('[data-saved]', root).innerHTML = r.reports.length ? r.reports.map((x) => `<button class="btn ghost" type="button" data-open="${esc(x.id)}" style="display:block;width:100%;text-align:left;margin-bottom:4px">
          <b>${esc(x.name)}</b><div class="cell-sub">${esc(cat.datasets.find((d) => d.key === x.dataset)?.label ?? x.dataset)}${x.frequency ? ` · e-mailed ${esc(x.frequency)}` : ''}</div></button>`).join('') : '<p class="cell-sub">None yet: build one and save it.</p>';
      return r.reports;
    };

    const colRow = (c, group) => `<div class="row" data-col="${group ? 'g' : 'c'}" style="gap:6px;align-items:flex-end;flex-wrap:wrap">
        ${field('', `<select name="field">${fieldOpts(c.field)}</select>`)}
        ${group ? '' : field('', `<select name="agg">${Object.entries(AGG).map(([k, l]) => `<option value="${k}"${(c.agg ?? '') === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`)}
        ${field('', `<select name="bucket"><option value="">exact</option>${cat.buckets.map((b) => `<option value="${b}"${c.bucket === b ? ' selected' : ''}>by ${b}</option>`).join('')}</select>`)}
        <button class="btn ghost icon" type="button" data-del title="Remove">${icon('x')}</button></div>`;
    const filterRow = (f) => `<div class="row" data-filter style="gap:6px;align-items:flex-end;flex-wrap:wrap">
        ${field('', `<select name="field">${fieldOpts(f.field)}</select>`)}
        ${field('', `<select name="op">${cat.operators.map((o) => `<option value="${o}"${f.op === o ? ' selected' : ''}>${esc(OP[o] ?? o)}</option>`).join('')}</select>`)}
        ${field('', `<input name="value" value="${esc(Array.isArray(f.value) ? f.value.join(', ') : f.value ?? '')}" placeholder="value">`)}
        ${field('', `<input name="value2" value="${esc(f.value2 ?? '')}" placeholder="and" ${f.op === 'between' ? '' : 'hidden'}>`)}
        <button class="btn ghost icon" type="button" data-del title="Remove">${icon('x')}</button></div>`;

    const drawBuilder = () => {
      const s = current.spec;
      $('[data-builder]', root).innerHTML = `<div class="row" style="gap:10px;align-items:flex-end;flex-wrap:wrap">
          ${field('Dataset', `<select data-ds>${cat.datasets.map((d) => `<option value="${d.key}"${d.key === current.dataset ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}</select>`)}
          <span class="cell-sub grow">${esc(ds().description)}</span></div>
        <div class="section"><b>Group by</b> <span class="cell-sub">(optional: then every column is a count, sum, average…)</span><div data-groups>${s.groupBy.map((c) => colRow(c, true)).join('')}</div>
          <button class="btn sm" type="button" data-addgroup>${icon('plus')} Group by</button></div>
        <div class="section"><b>Columns</b><div data-cols>${s.columns.map((c) => colRow(c, false)).join('')}</div>
          <button class="btn sm" type="button" data-addcol>${icon('plus')} Column</button></div>
        <div class="section"><b>Filters</b><div data-filters>${s.filters.map(filterRow).join('')}</div>
          <button class="btn sm" type="button" data-addfilter>${icon('plus')} Filter</button></div>
        <div class="row section" style="gap:10px;align-items:flex-end;flex-wrap:wrap">
          ${field('Sort by column', `<select data-sort><option value="">—</option></select>`)}
          ${field('', `<select data-dir><option value="desc"${s.sort?.dir !== 'asc' ? ' selected' : ''}>descending</option><option value="asc"${s.sort?.dir === 'asc' ? ' selected' : ''}>ascending</option></select>`)}
          ${field('Rows (max)', `<input type="number" data-limit min="1" max="${cat.maxRows}" value="${esc(s.limit)}" style="width:90px">`)}
          ${field('Chart', `<select data-chart><option value="">none</option><option value="bar"${s.chart?.type === 'bar' ? ' selected' : ''}>bar</option><option value="line"${s.chart?.type === 'line' ? ' selected' : ''}>line</option></select>`)}
          <span class="grow"></span>
          <button class="btn primary" type="button" data-run>${icon('play')} Run</button>
          <button class="btn" type="button" data-xlsx>${icon('download')} Excel</button>
          <button class="btn" type="button" data-save>${icon('check')} ${current.id ? 'Save' : 'Save as…'}</button>
          ${current.id ? `<button class="btn" type="button" data-saveas>Save as…</button>
            <button class="btn" type="button" data-schedule>${icon('bell')} E-mail…</button>
            <button class="btn ghost" type="button" data-archive>Archive</button>` : ''}
        </div>`;
      refreshSort();
    };
    const readSpec = () => {
      const b = $('[data-builder]', root);
      const col = (row) => ({ field: $('[name=field]', row).value, agg: $('[name=agg]', row)?.value || null, bucket: $('[name=bucket]', row).value || null });
      const groupBy = $$('[data-col="g"]', b).map(col).map((c) => ({ ...c, agg: null }));
      const columns = $$('[data-col="c"]', b).map(col);
      const filters = $$('[data-filter]', b).map((row) => {
        const op = $('[name=op]', row).value, raw = $('[name=value]', row).value.trim();
        return { field: $('[name=field]', row).value, op, value: op === 'in' ? raw.split(',').map((x) => x.trim()).filter(Boolean) : NO_VALUE.has(op) ? undefined : raw, value2: op === 'between' ? $('[name=value2]', row).value.trim() : undefined };
      });
      const sortIdx = $('[data-sort]', b).value;
      const chartType = $('[data-chart]', b).value;
      const width = groupBy.length + columns.length;
      return {
        columns, filters, groupBy, limit: Number($('[data-limit]', b).value) || 1000,
        sort: sortIdx === '' ? null : { index: Number(sortIdx), dir: $('[data-dir]', b).value },
        chart: chartType && width >= 2 ? { type: chartType, x: 0, y: width - 1 } : null,
      };
    };
    function refreshSort() {
      const b = $('[data-builder]', root);
      const sp = readSpec();
      const labels = [...sp.groupBy, ...sp.columns].map((c) => `${c.agg ? `${AGG[c.agg]} of ` : ''}${ds().fields.find((f) => f.key === c.field)?.label ?? c.field}${c.bucket ? ` (${c.bucket})` : ''}`);
      const was = current.spec.sort?.index;
      $('[data-sort]', b).innerHTML = `<option value="">—</option>${labels.map((l, i) => `<option value="${i}"${i === was ? ' selected' : ''}>${esc(l)}</option>`).join('')}`;
    }

    const builder = () => $('[data-builder]', root);
    root.addEventListener('change', (e) => {
      if (e.target.matches('[data-ds]')) { current.dataset = e.target.value; current.spec = { columns: [], filters: [], groupBy: [], sort: null, limit: 1000, chart: null }; drawBuilder(); return; }
      if (e.target.closest('[data-builder]')) {
        const row = e.target.closest('[data-filter]');
        if (row && e.target.name === 'op') { $('[name=value2]', row).hidden = e.target.value !== 'between'; $('[name=value]', row).hidden = NO_VALUE.has(e.target.value); }
        if (e.target.name === 'field' && e.target.closest('[data-col]')) { const bk = $('[name=bucket]', e.target.closest('[data-col]')); bk.disabled = !isDate(e.target.value); if (bk.disabled) bk.value = ''; }
        current.spec = { ...current.spec, ...readSpec() };
        refreshSort();
      }
    });
    root.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.matches('[data-del]')) { t.closest('[data-col],[data-filter]').remove(); current.spec = { ...current.spec, ...readSpec() }; refreshSort(); return; }
      if (t.matches('[data-addcol]')) { $('[data-cols]', builder()).insertAdjacentHTML('beforeend', colRow({ field: ds().fields[0].key, agg: $$('[data-col="g"]', builder()).length ? 'count' : null }, false)); refreshSort(); return; }
      if (t.matches('[data-addgroup]')) {
        $('[data-groups]', builder()).insertAdjacentHTML('beforeend', colRow({ field: ds().fields[0].key }, true));
        // With a group, plain columns become counts.
        $$('[data-col="c"] [name=agg]', builder()).forEach((s) => { if (!s.value) s.value = 'count'; });
        refreshSort(); return;
      }
      if (t.matches('[data-addfilter]')) { $('[data-filters]', builder()).insertAdjacentHTML('beforeend', filterRow({ field: ds().fields[0].key, op: 'eq' })); return; }
      if (t.matches('[data-run]')) return run();
      if (t.matches('[data-xlsx]')) {
        try { const res = await api('/v1/reports/builder/run?format=xlsx', { method: 'POST', body: { dataset: current.dataset, spec: readSpec(), name: current.name || ds().label }, raw: true }); download(`${(current.name || ds().label).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.xlsx`, await res.blob()); } catch (err) { toast(err.message, 'crit'); }
        return;
      }
      if (t.matches('[data-save]')) return save(false);
      if (t.matches('[data-saveas]')) return save(true);
      if (t.matches('[data-archive]')) {
        modal({ title: `Archive "${current.name}"?`, body: '<p>It disappears from the list and stops being e-mailed.</p>', actions: [{ label: 'Cancel' }, { label: 'Archive', kind: 'danger', onClick: guard(async () => {
          await api(`/v1/reports/saved/${current.id}`, { method: 'PUT', body: { archive: true } });
          toast('Archived.', 'ok'); root.querySelector('[data-new]').click(); await loadSaved();
        }) }] });
        return;
      }
      if (t.matches('[data-schedule]')) return schedule();
      if (t.matches('[data-new]')) { current = { id: null, name: '', dataset: cat.datasets[0].key, spec: { columns: [], filters: [], groupBy: [], sort: null, limit: 1000, chart: null }, frequency: null, weekday: 1, recipients: [] }; history.replaceState(null, '', '#/report-builder'); drawBuilder(); $('[data-result]', root).innerHTML = ''; return; }
      if (t.matches('[data-open]')) return open(t.dataset.open);
    });

    const numOf = (v) => (Number.isInteger(Number(v)) ? fmt.num(Number(v)) : fmt.num(Number(v), 2));
    const textOf = (v, h) => (v == null ? '—' : h.type === 'datetime' ? fmt.time(v) : h.type === 'date' ? fmt.date(v) : String(v));
    const chartSvg = (headers, rows, chart) => {
      if (!chart || !rows.length) return '';
      const ys = rows.map((r) => Number(r[chart.y]) || 0), max = Math.max(1, ...ys), n = rows.length, w = Math.max(300, n * 24);
      const label = (v) => esc(textOf(v, headers[chart.x]).slice(0, 14)), every = Math.max(1, Math.ceil(n / 12));
      const body = chart.type === 'line'
        ? `<polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${ys.map((y, i) => `${(i + 0.5) * (w / n)},${150 - (y / max) * 140}`).join(' ')}"/>`
        : ys.map((y, i) => `<rect x="${i * (w / n) + 2}" y="${150 - (y / max) * 140}" width="${Math.max(2, w / n - 4)}" height="${(y / max) * 140}" fill="var(--accent)"><title>${esc(textOf(rows[i][chart.x], headers[chart.x]))}: ${numOf(y)}</title></rect>`).join('');
      return `<div class="section" style="overflow-x:auto"><b>${esc(headers[chart.y].label)} by ${esc(headers[chart.x].label)}</b>
        <svg viewBox="0 0 ${w} 170" style="width:100%;min-width:${Math.min(w, 900)}px;height:200px" role="img" aria-label="Chart">${body}
        ${rows.map((r, i) => (i % every ? '' : `<text x="${(i + 0.5) * (w / n)}" y="166" font-size="9" text-anchor="middle" fill="var(--muted)">${label(r[chart.x])}</text>`)).join('')}</svg></div>`;
    };
    const showResult = (r) => {
      const box = $('[data-result]', root);
      const cellOf = (v, h) => (v == null ? '<span class="muted">—</span>' : h.type === 'money' || h.type === 'number' ? numOf(v) : h.type === 'bool' ? (v ? 'yes' : 'no') : esc(textOf(v, h)));
      box.innerHTML = `<header><h3>${esc(current.name || r.dataset.label)}</h3><span class="cell-sub">${fmt.num(r.rows.length)} row${r.rows.length === 1 ? '' : 's'}${r.truncated ? ' (cut off: raise the limit or filter)' : ''} · ${r.ms} ms</span></header>
        ${chartSvg(r.headers, r.rows, r.spec.chart)}
        <div class="table-wrap"><table class="t"><thead><tr>${r.headers.map((h) => `<th class="${h.type === 'number' || h.type === 'money' ? 'num' : ''}">${esc(h.label)}</th>`).join('')}</tr></thead>
        <tbody>${r.rows.length ? r.rows.slice(0, 500).map((row) => `<tr>${row.map((v, i) => `<td class="${r.headers[i].type === 'number' || r.headers[i].type === 'money' ? 'num' : ''}">${cellOf(v, r.headers[i])}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${r.headers.length}" class="muted">No rows.</td></tr>`}</tbody></table></div>
        ${r.rows.length > 500 ? '<p class="cell-sub">The first 500 rows are shown; the Excel file has them all.</p>' : ''}`;
    };
    const run = async () => {
      current.spec = readSpec();
      const box = $('[data-result]', root);
      box.innerHTML = '<div class="skeleton" style="height:120px"></div>';
      try { showResult(await api('/v1/reports/builder/run', { method: 'POST', body: { dataset: current.dataset, spec: current.spec } })); } catch (err) { box.innerHTML = callout('crit', esc(err.message)); }
    };
    const save = (asNew) => {
      current.spec = readSpec();
      const update = current.id && !asNew;
      modal({
        title: update ? 'Save report' : 'Save as a new report',
        body: field('Name', `<input name="name" value="${esc(asNew && current.name ? `${current.name} (copy)` : current.name)}" placeholder="Weekly fault watch">`),
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          const name = $('[name=name]', mc.el).value.trim();
          const r = await api(update ? `/v1/reports/saved/${current.id}` : '/v1/reports/saved', { method: update ? 'PUT' : 'POST', body: { name, dataset: current.dataset, spec: current.spec } });
          current = { ...current, id: r.id, name: r.name, frequency: r.frequency, weekday: r.weekday ?? 1, recipients: r.recipients };
          history.replaceState(null, '', `#/report-builder/${r.id}`);
          toast('Saved.', 'ok'); await loadSaved(); drawBuilder();
        }) }],
      });
    };
    const schedule = () => {
      modal({
        title: `E-mail "${current.name}"`,
        body: `<div class="form">${field('How often', `<select name="frequency"><option value="">Not scheduled</option>${['daily', 'weekly', 'monthly'].map((f) => `<option value="${f}"${current.frequency === f ? ' selected' : ''}>${f}</option>`).join('')}</select>`, { help: 'Sent from 07:00; monthly on the 1st.' })}
          ${field('Weekday (weekly)', `<select name="weekday">${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d, i) => `<option value="${i + 1}"${current.weekday === i + 1 ? ' selected' : ''}>${d}</option>`).join('')}</select>`)}
          ${field('Recipients', `<input name="recipients" value="${esc((current.recipients ?? []).join(', '))}" placeholder="ops@example.co.id, finance@example.co.id">`)}</div>`,
        actions: [
          { label: 'Send now', onClick: guard(async (mc) => {
            const rc = await api(`/v1/reports/saved/${current.id}`, { method: 'PUT', body: { recipients: $('[name=recipients]', mc.el).value } });
            current.recipients = rc.recipients;
            const r = await api(`/v1/reports/saved/${current.id}/send`, { method: 'POST' }); toast(`Sent to ${r.to.join(', ')}.`, 'ok');
            return false;
          }) },
          { label: 'Cancel' },
          { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
            const v = (n) => $(`[name=${n}]`, mc.el).value;
            const r = await api(`/v1/reports/saved/${current.id}`, { method: 'PUT', body: { frequency: v('frequency') || null, weekday: Number(v('weekday')), recipients: v('recipients') } });
            current = { ...current, frequency: r.frequency, weekday: r.weekday ?? 1, recipients: r.recipients };
            toast(r.frequency ? `E-mailed ${r.frequency}.` : 'Not scheduled.', 'ok'); loadSaved();
          }) },
        ],
      });
    };
    const open = async (id) => {
      try {
        const r = await api(`/v1/reports/saved/${id}`);
        current = { id: r.id, name: r.name, dataset: r.dataset, spec: r.spec, frequency: r.frequency, weekday: r.weekday ?? 1, recipients: r.recipients };
        history.replaceState(null, '', `#/report-builder/${r.id}`);
        drawBuilder(); await run();
      } catch (err) { toast(err.message, 'crit'); }
    };

    const saved = await loadSaved();
    drawBuilder();
    if (savedParam && saved.some((x) => x.id === savedParam)) await open(savedParam);
  },
});
