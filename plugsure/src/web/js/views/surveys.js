import { $, $$, esc, api, state, registerView, pageHead, table, tag, icon, fmt, modal, toast, callout, field, kpi, options } from '../core.js';

/**
 * (v1.47.0) Operate → Surveys: after a charge the app asks drivers how likely they are to recommend the operator
 * (0–10). NPS overall, by week, by site and by charger; what drivers tagged; the comments, a detractor's opening a
 * support case.
 */

const BAND = (s) => (s >= 9 ? ['t-ok', 'promoter'] : s >= 7 ? ['t-mute', 'passive'] : ['t-crit', 'detractor']);
const npsTag = (n) => (n == null ? '—' : `<b style="color:${n >= 30 ? 'var(--ok, #0c7856)' : n < 0 ? 'var(--crit, #b42318)' : 'inherit'}">${n > 0 ? '+' : ''}${n}</b>`);
const TAG_LABEL = { speed: 'Charging speed', price: 'Price', availability: 'Availability', payment: 'Payment', app: 'The app', location: 'Location', cleanliness: 'Cleanliness', broken: 'Something broken' };
const guard = (fn) => async (mc) => { try { return await fn(mc); } catch (err) { toast(err.message, 'crit'); return false; } };

registerView('surveys', {
  title: 'Surveys',
  icon: 'chart',
  group: 'operate',
  order: 7,
  perm: 'session:read',
  async render(root) {
    const canWrite = state.can('org:write');
    root.innerHTML = pageHead('Surveys', 'How likely drivers are to recommend you, asked in the app after a charge. A low score with a comment opens a support case.',
      canWrite ? `<button class="btn" type="button" data-settings>${icon('gear')} Settings</button>` : '') + '<div data-body class="stack" style="gap:14px"></div>';
    const body = $('[data-body]', root);
    let days = 90, band = '';

    const settingsModal = async () => {
      const s = await api('/v1/surveys/settings');
      modal({ title: 'Survey settings', body: `<div class="form">${field('', `<label><input type="checkbox" name="on" ${s.enabled ? 'checked' : ''}> Ask drivers after a charge</label>`)}
          ${field('Question', `<input name="q" maxlength="200" value="${esc(s.question ?? '')}" placeholder="Seberapa besar kemungkinan Anda merekomendasikan kami kepada teman?">`, { help: 'Empty: the standard question (in the app\'s language).' })}
          ${field('Share of charges asked (%)', `<input name="pct" type="number" min="1" max="100" value="${s.samplePct}">`)}
          ${field('At most once every (days) per driver', `<input name="gap" type="number" min="0" max="365" value="${s.minGapDays}">`)}
          ${field('', `<label><input type="checkbox" name="case" ${s.caseOnLow ? 'checked' : ''}> A score of 6 or less with a comment opens a support case (when the support desk is on)</label>`)}</div>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: guard(async (mc) => {
          await api('/v1/surveys/settings', { method: 'PUT', body: { enabled: $('[name="on"]', mc.el).checked, question: $('[name="q"]', mc.el).value || null, samplePct: Number($('[name="pct"]', mc.el).value),
            minGapDays: Number($('[name="gap"]', mc.el).value), caseOnLow: $('[name="case"]', mc.el).checked } });
          toast('Saved.', 'ok'); draw();
        }) }] });
    };

    const draw = async () => {
      let o, rs, s;
      try { [o, { responses: rs }, s] = await Promise.all([api(`/v1/surveys/nps?days=${days}`), api(`/v1/surveys/responses${band ? `?band=${band}` : ''}`), api('/v1/surveys/settings')]); } catch (e) { body.innerHTML = callout('crit', esc(e.message)); return; }
      const maxW = Math.max(1, ...o.byWeek.map((w) => w.responses));
      const maxD = Math.max(1, ...o.distribution);
      body.innerHTML = `${s.enabled ? '' : callout('info', `Surveys are off: drivers are not asked.${canWrite ? ' Switch them on in Settings.' : ''}`)}
        <div class="grid k4">${kpi('NPS', npsTag(o.nps), `last ${o.days} days`)}${kpi('Responses', fmt.num(o.responses))}
          ${kpi('Promoters', fmt.num(o.promoters), o.responses ? `${Math.round((o.promoters / o.responses) * 100)}%` : '')}${kpi('Detractors', fmt.num(o.detractors), o.responses ? `${Math.round((o.detractors / o.responses) * 100)}%` : '', o.detractors ? 'warn' : '')}</div>
        <div class="grid k3" style="gap:14px">
          <div class="card section"><header><h3>By week</h3><select class="right" data-days style="width:auto">${options([30, 90, 180, 365].map((d) => ({ value: String(d), label: `${d} days` })), String(days))}</select></header>
            <div style="padding:0 16px 14px">${o.byWeek.length ? o.byWeek.map((w) => `<div style="display:flex;gap:10px;align-items:center;margin:4px 0"><span class="cell-sub" style="width:84px">${esc(w.name)}</span>
              <div style="flex:1;background:var(--line, #e2e8ef);height:8px;border-radius:4px"><div style="width:${Math.round((w.responses / maxW) * 100)}%;height:8px;border-radius:4px;background:var(--accent, #0c7856)"></div></div>
              <span style="width:44px;text-align:right">${npsTag(w.nps)}</span><span class="cell-sub" style="width:30px;text-align:right">${w.responses}</span></div>`).join('') : '<p class="cell-sub">No responses yet.</p>'}</div></div>
          <div class="card section"><header><h3>Scores</h3></header>
            <div style="display:flex;align-items:flex-end;gap:4px;height:120px;padding:8px 16px 0" role="img" aria-label="Scores 0 to 10">${o.distribution.map((n, i) => `<div title="${i}: ${n}" style="flex:1;height:${Math.max(2, Math.round((n / maxD) * 100))}%;border-radius:2px 2px 0 0;background:${i >= 9 ? 'var(--ok, #0c7856)' : i >= 7 ? 'var(--muted, #98a6b5)' : 'var(--crit, #b42318)'}"></div>`).join('')}</div>
            <div style="display:flex;gap:4px;padding:2px 16px 12px" class="cell-sub">${o.distribution.map((_, i) => `<span style="flex:1;text-align:center">${i}</span>`).join('')}</div>
            ${o.tags.length ? `<div style="padding:0 16px 14px">${o.tags.map((t) => `${tag(t.detractors > t.all / 2 ? 't-crit' : 't-mute', `${TAG_LABEL[t.tag] ?? t.tag} · ${t.all}`)}`).join(' ')}</div>` : ''}</div></div>
        <div class="card section"><header><h3>By site</h3><span class="cell-sub">Lowest first</span></header><div data-site></div></div>
        <div class="card section"><header><h3>By charger</h3><span class="cell-sub">Lowest first</span></header><div data-cp></div></div>
        <div class="card section"><header><h3>Responses</h3><select class="right" data-band style="width:auto">${options([{ value: 'detractor', label: 'Detractors (0–6)' }, { value: 'passive', label: 'Passives (7–8)' }, { value: 'promoter', label: 'Promoters (9–10)' }], band, { blank: 'Everyone' })}</select></header><div data-r></div></div>`;
      const cols = [{ label: 'Name', key: 'name' }, { label: 'NPS', num: true, render: (g) => npsTag(g.nps) }, { label: 'Responses', num: true, render: (g) => fmt.num(g.responses) },
        { label: 'Promoters', num: true, render: (g) => fmt.num(g.promoters) }, { label: 'Detractors', num: true, render: (g) => fmt.num(g.detractors) }];
      table($('[data-site]', body), { columns: cols, rows: o.bySite, empty: 'No responses yet.' });
      table($('[data-cp]', body), { columns: cols, rows: o.byCharger.slice(0, 50), empty: 'No responses yet.' });
      table($('[data-r]', body), { columns: [{ label: 'When', render: (r) => esc(fmt.time(r.createdAt)) }, { label: 'Score', render: (r) => `<b>${r.score}</b> ${tag(...BAND(r.score))}` },
        { label: 'Where', render: (r) => `${esc(r.site ?? '—')}<div class="cell-sub">${esc(r.charger ?? '')}</div>` },
        { label: 'Comment', render: (r) => `${r.comment ? esc(r.comment) : '<span class="cell-sub">—</span>'}${r.tags.length ? `<div class="cell-sub">${r.tags.map((t) => esc(TAG_LABEL[t] ?? t)).join(', ')}</div>` : ''}` },
        { label: 'Case', render: (r) => (r.caseRef ? `<a href="#/support">${esc(r.caseRef)}</a> ${tag('t-mute', r.caseStatus ?? '')}` : '—') }],
      rows: rs, empty: 'No responses.' });
      $('[data-days]', body).addEventListener('change', (e) => { days = Number(e.target.value); draw(); });
      $('[data-band]', body).addEventListener('change', (e) => { band = e.target.value; draw(); });
    };

    $('[data-settings]', root)?.addEventListener('click', () => settingsModal().catch((e) => toast(e.message, 'crit')));
    await draw();
  },
});
