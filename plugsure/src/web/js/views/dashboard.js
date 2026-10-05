import { $, esc, api, attempt, state, registerView, pageHead, table, tag, icon, fmt, kpi, navigate, onLive, debounce, callout, inPortal, greetingName, sites as loadSites, isRupiah } from '../core.js';

/**
 * NOC overview: fleet health, today's commercial numbers, a 14-day trend,
 * open alerts and the sites that need attention.
 */

const STATUS_ORDER = ['Charging', 'Available', 'Preparing', 'SuspendedEV', 'SuspendedEVSE', 'Finishing', 'Reserved', 'Faulted', 'Unavailable'];
const STATUS_COLOR = {
  Charging: 'var(--info)', Available: 'var(--accent)', Preparing: 'var(--warn)', SuspendedEV: 'var(--warn)', SuspendedEVSE: 'var(--warn)',
  Finishing: 'var(--warn)', Reserved: 'var(--info)', Faulted: 'var(--crit)', Unavailable: 'var(--muted)',
};

function bars(series, key, formatter) {
  const max = Math.max(1, ...series.map((d) => Number(d[key] ?? 0)));
  return `<div class="bars">${series
    .map((d) => `<div class="b" style="height:${Math.max(2, (Number(d[key] ?? 0) / max) * 100)}%" title="${esc(d.day)}: ${esc(formatter(d[key]))}"></div>`)
    .join('')}</div><div class="bars-x">${series.map((d, i) => `<span>${i % 2 === 0 ? esc(d.day.slice(8)) : ''}</span>`).join('')}</div>`;
}

registerView('dashboard', {
  title: 'Dashboard',
  icon: 'dashboard',
  group: 'operate',
  order: 1,
  perm: 'charge_point:read',
  // Also shown in the Site Owner portal (read-only, the owner's own sites).
  portal: true,
  async render(root) {
    const portal = inPortal();
    const owner = state.me.owners?.[0];
    root.innerHTML = pageHead(
      `Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, ${greetingName(state.me.user.name)}`,
      portal
        ? `${esc(owner.legal_name || owner.name)} — your chargers right now, operated by ${esc(state.me.org?.name ?? '')}.`
        : `${esc(state.me.org?.name ?? '')} — network status right now.`,
      `${state.can('charge_point:write') ? `<a class="btn primary" href="#/onboard">${icon('plus')} Add charge point</a>` : ''}
       ${state.can('site:write') ? `<a class="btn" href="#/sites">${icon('site')} Sites</a>` : ''}`,
    ) + `
      <div data-setup></div>
      <div class="grid k4" data-kpis></div>
      <div class="grid two section">
        <div class="card"><header><h3>Connector status</h3><span class="right small muted" data-conn-total></span></header><div class="body" data-status></div></div>
        <div class="card"><header><h3>Last 14 days</h3><div class="seg right" data-metric>
          <button aria-pressed="true" data-k="revenue_minor">Revenue</button><button aria-pressed="false" data-k="energy_wh">Energy</button><button aria-pressed="false" data-k="sessions">Sessions</button></div></header>
          <div class="body" data-trend></div></div>
      </div>
      <div class="grid two section">
        <div class="card"><header><h3>Open alerts</h3>${portal ? '' : '<a class="right small" href="#/logs">OCPP log →</a>'}</header><div data-alerts></div></div>
        <div class="card"><header><h3>${portal ? 'Your sites needing attention' : 'Sites needing attention'}</h3>${portal ? '' : '<a class="right small" href="#/sites">All sites →</a>'}</header><div data-sites></div></div>
      </div>`;

    let metric = 'revenue_minor';
    let series = [];
    // The chart's money is in the home country's currency (one currency per chart; never added across currencies).
    let homeCurrency = null;
    const drawTrend = () => {
      const f = metric === 'revenue_minor' ? (v) => fmt.money(v, homeCurrency) : metric === 'energy_wh' ? (v) => fmt.kwh(v, 0) : (v) => fmt.num(v);
      const total = series.reduce((a, d) => a + Number(d[metric] ?? 0), 0);
      $('[data-trend]', root).innerHTML = series.length
        ? `<div class="kpi" style="padding:0 0 6px"><div class="value">${esc(f(total))}</div><div class="foot">14-day total</div></div>${bars(series, metric, f)}`
        : callout('info', 'Revenue figures need the <b>session:read</b> permission.');
    };
    root.querySelectorAll('[data-metric] button').forEach((b) =>
      b.addEventListener('click', () => {
        metric = b.dataset.k;
        root.querySelectorAll('[data-metric] button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        drawTrend();
      }),
    );

    const draw = async () => {
      const [d, alerts, siteList] = await Promise.all([
        api('/v1/dashboard'),
        state.can('site:read') ? api('/v1/alerts').catch(() => []) : [],
        state.can('site:read') ? loadSites(true) : [],
      ]);

      // First-run guidance: a brand-new tenant has nothing to look at yet.
      if (!siteList.length && state.can('site:write')) {
        $('[data-setup]', root).innerHTML = `<div class="card pad" style="margin-bottom:14px"><div class="row" style="align-items:flex-start;gap:14px">
          ${icon('bolt', 'lead')}<div class="grow"><b>Set up your network in three steps</b><ol class="small" style="margin:6px 0 0;padding-left:18px">
          <li>Create an electrical site with its PLN subscription (Sites → Create site).</li>
          <li>Onboard a charger with the commissioning wizard (identity, security keys, connectors).</li>
          <li>Create a tariff and assign it to the site.</li></ol></div>
          <a class="btn primary" href="#/sites">Create first site</a></div></div>`;
      } else {
        $('[data-setup]', root).innerHTML = '';
      }

      const c = d.chargers;
      const conn = d.connectors ?? {};
      const totalConn = Object.values(conn).reduce((a, n) => a + n, 0);
      const t = d.today;
      $('[data-kpis]', root).innerHTML = [
        kpi('Chargers online', `${fmt.num(c.online)} <span class="muted" style="font-size:15px">/ ${fmt.num(c.total)}</span>`,
          `${c.pending ? `${fmt.num(c.pending)} awaiting activation · ` : ''}${c.faulted ? `${fmt.num(c.faulted)} faulted` : 'no station faults'}`,
          c.total && c.online < c.total ? 'warn' : 'ok'),
        kpi('Charging now', fmt.num(conn.Charging ?? 0), `${fmt.num(totalConn)} connectors installed`),
        t ? kpi('Energy today', fmt.kwh(t.energy_wh, 1), `${fmt.num(t.sessions)} sessions · ${fmt.num(t.active)} in progress`) : kpi('Faulted connectors', fmt.num(conn.Faulted ?? 0), '', conn.Faulted ? 'crit' : ''),
        t ? ((t.revenue_by_currency ?? []).some((x) => x.currency !== t.currency)
          ? kpi('Revenue today', (t.revenue_by_currency ?? []).map((x) => fmt.money(x.revenue_minor, x.currency)).join('<br>'), 'gross, incl. tax, per currency')
          : kpi('Revenue today', fmt.money(t.revenue_minor, t.currency), isRupiah(t.currency) ? 'gross, incl. PBJT & PPN' : 'gross, incl. tax'))
          : kpi('Open alerts', fmt.num(d.alerts?.critical ?? 0), 'critical, last 7 days'),
        kpi('Critical alerts', fmt.num(d.alerts?.critical ?? 0), `${fmt.num(d.alerts?.warning ?? 0)} warnings (7 days)`, d.alerts?.critical ? 'crit' : 'ok'),
      ].join('');

      $('[data-conn-total]', root).textContent = `${totalConn} connectors`;
      const keys = STATUS_ORDER.filter((k) => conn[k]).concat(Object.keys(conn).filter((k) => !STATUS_ORDER.includes(k)));
      $('[data-status]', root).innerHTML = totalConn
        ? `<div class="stackbar">${keys.map((k) => `<i style="width:${(conn[k] / totalConn) * 100}%;background:${STATUS_COLOR[k] ?? 'var(--muted)'}" title="${esc(k)}: ${esc(conn[k])}"></i>`).join('')}</div>
           <div class="legend">${keys.map((k) => `<span style="--c:${STATUS_COLOR[k] ?? 'var(--muted)'}">${esc(k)} <b>${esc(conn[k])}</b></span>`).join('')}</div>
           <div class="row" style="margin-top:14px"><a class="btn sm" href="#/chargers">Open fleet</a>${conn.Faulted ? `<a class="btn sm" href="#/chargers/~faulted">${icon('warn')} ${esc(conn.Faulted)} faulted</a>` : ''}</div>`
        : '<div class="empty-state small">No connectors yet.</div>';

      series = d.series ?? [];
      homeCurrency = d.today?.currency ?? null;
      drawTrend();

      const open = (alerts ?? []).filter((a) => !a.resolved_at).slice(0, 8);
      const alertBox = $('[data-alerts]', root);
      table(alertBox, {
        columns: [
          { label: 'Raised', render: (a) => `<span class="nowrap small">${esc(fmt.ago(a.raised_at))}</span>` },
          { label: 'Severity', render: (a) => tag(a.severity === 'critical' ? 't-crit' : a.severity === 'warning' ? 't-warn' : 't-mute', a.severity) },
          { label: 'Message', render: (a) => `<div class="wrap">${esc(a.message)}</div><div class="cell-sub"><span class="mono">${esc(a.kind)}</span>${a.occurrences > 1 ? ` · raised ${esc(a.occurrences)}×, last ${esc(fmt.ago(a.last_raised_at))}` : ''}${a.acknowledged_at ? ` · acknowledged ${esc(fmt.ago(a.acknowledged_at))}` : ''}</div>` },
          {
            label: '',
            // Acknowledge = "someone is on it": stops escalation to the next contact.
            render: (a) => `<div class="row nowrap" style="gap:4px">${!a.acknowledged_at && state.can('charge_point:command') ? `<button class="btn sm ghost" data-ack="${esc(a.id)}" title="Stops escalation to the next contact">Acknowledge</button>` : ''}${state.can('charge_point:write') ? `<button class="btn sm ghost" data-resolve="${esc(a.id)}">Resolve</button>` : ''}</div>`,
          },
        ],
        rows: open,
        empty: 'No open alerts. ',
      });
      alertBox.querySelectorAll('[data-resolve]').forEach((b) =>
        b.addEventListener('click', async () => {
          if (await attempt(() => api(`/v1/alerts/${encodeURIComponent(b.dataset.resolve)}/resolve`, { method: 'POST' }), { success: 'Alert resolved' })) draw();
        }),
      );
      alertBox.querySelectorAll('[data-ack]').forEach((b) =>
        b.addEventListener('click', async () => {
          if (await attempt(() => api(`/v1/alerts/${encodeURIComponent(b.dataset.ack)}/acknowledge`, { method: 'POST' }), { success: 'Acknowledged — escalation stopped' })) draw();
        }),
      );

      const attention = siteList
        .filter((s) => !s.archived_at && (s.live_status === 'offline' || s.live_status === 'partial' || s.faulted_count || s.curtailed || s.spklu_valid === false))
        .slice(0, 8);
      table($('[data-sites]', root), {
        columns: [
          { label: 'Site', render: (s) => `<div class="cell-title">${esc(s.name)}</div><div class="cell-sub">${esc(s.online_count)}/${esc(s.charger_count)} online</div>` },
          {
            label: 'Why',
            render: (s) => [
              s.live_status === 'offline' ? tag('t-crit', 'all chargers offline') : s.live_status === 'partial' ? tag('t-warn', 'some offline') : '',
              s.faulted_count ? tag('t-crit', `${s.faulted_count} faulted`) : '',
              s.curtailed ? tag('t-crit', 'curtailed') : '',
              s.spklu_valid === false ? tag('t-warn', 'SPKLU ID malformed') : '',
            ].join(' '),
          },
        ],
        rows: attention,
        empty: 'Every site is healthy.',
        // Portal users cannot open the Sites page; their chargers list shows the same problem.
        onRow: (s) => navigate(portal ? '#/chargers' : `#/sites/${encodeURIComponent(s.id)}`),
      });
    };

    await draw();
    const redraw = debounce(() => draw().catch(() => {}), 1500);
    const off = onLive((e) => {
      if (/^(connector|charge_point|session|alert|cdr)\./.test(e.kind)) redraw();
    });
    const timer = setInterval(() => draw().catch(() => {}), 30_000);
    return () => { off(); clearInterval(timer); };
  },
});
