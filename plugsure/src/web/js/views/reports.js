import { $, esc, api, registerView, pageHead, table, tag, icon, fmt, field, callout, kpi, download, navigate, isRupiah, LEGACY_CURRENCY } from '../core.js';

/**
 * Availability & utilisation report.
 *
 * Uptime per charger (from the outage history the gateway records), outages,
 * longest outage, sessions, energy, revenue and utilisation over a chosen
 * window — what a site host, a PLN partner or an SLA review asks for first.
 */

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection (identities come from hardware)
  return `"${s.replace(/"/g, '""')}"`;
};

const uptimeTag = (p) =>
  p == null ? tag('t-mute', 'no data')
  : p >= 99 ? tag('t-ok', `${p}%`)
  : p >= 95 ? tag('t-warn', `${p}%`)
  : tag('t-crit', `${p}%`);

registerView('reports', {
  title: 'Availability',
  icon: 'chart',
  group: 'operate',
  order: 15,
  perm: 'charge_point:read',
  // Also shown in the Site Owner portal (read-only, the owner's own sites).
  portal: true,
  async render(root) {
    root.innerHTML = pageHead(
      'Availability & utilisation',
      'Uptime of every charger from its outage history, with sessions, energy, revenue and utilisation over the period. A charger offline for longer than the alert threshold also raises a critical alert that clears itself when it reconnects.',
      `<button class="btn" type="button" data-refresh>${icon('refresh')} Refresh</button><button class="btn" type="button" data-csv>${icon('download')} Export CSV</button>`,
    ) + `<div class="filters">${field('Period', `<select data-days><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select>`)}</div>
      <div class="grid k4 section" data-kpis></div><div class="card section" data-list></div>`;

    let data = { rows: [] };
    const load = async () => {
      try {
        data = await api(`/v1/reports/availability?days=${$('[data-days]', root).value}`);
      } catch (e) {
        $('[data-list]', root).innerHTML = callout('crit', esc(e.message));
        return;
      }
      const rows = data.rows;
      const withUptime = rows.filter((r) => r.uptimePct != null);
      const avg = withUptime.length ? Math.round((withUptime.reduce((a, r) => a + r.uptimePct, 0) / withUptime.length) * 10) / 10 : null;
      const util = rows.filter((r) => r.utilisationPct != null);
      const avgUtil = util.length ? Math.round((util.reduce((a, r) => a + r.utilisationPct, 0) / util.length) * 10) / 10 : null;
      const below = withUptime.filter((r) => r.uptimePct < 95).length;
      $('[data-kpis]', root).innerHTML = [
        kpi('Network uptime', avg == null ? '—' : `${avg}%`, `${fmt.num(rows.length)} chargers`, avg == null ? '' : avg >= 99 ? 'ok' : avg >= 95 ? 'warn' : 'crit'),
        kpi('Below 95% uptime', fmt.num(below), 'chargers needing attention', below ? 'crit' : 'ok'),
        kpi('Offline now', fmt.num(rows.filter((r) => !r.online).length), 'not connected at this moment', rows.some((r) => !r.online) ? 'warn' : ''),
        kpi('Average utilisation', avgUtil == null ? '—' : `${avgUtil}%`, 'connector time spent in sessions'),
        kpi('Energy delivered', fmt.num(rows.reduce((a, r) => a + r.energyKwh, 0), 1) + ' kWh', [...new Set(rows.map((r) => r.currency ?? null))].map((c) => fmt.money(rows.filter((r) => (r.currency ?? null) === c).reduce((a, r) => a + r.revenueMinor, 0), c)).join(' + ') + ' revenue'),
      ].join('');
      table($('[data-list]', root), {
        columns: [
          { label: 'Charger', render: (r) => `<div class="cell-title">${esc(r.displayName || r.ocppIdentity)}</div><div class="cell-sub mono">${esc(r.ocppIdentity)}</div>` },
          { label: 'Site', render: (r) => esc(r.siteName) },
          { label: 'Now', render: (r) => (r.online ? tag('t-ok', 'online') : tag('t-crit', 'offline')) },
          { label: 'Uptime', render: (r) => uptimeTag(r.uptimePct) },
          { label: 'Outages', num: true, render: (r) => `${fmt.num(r.outages)}<div class="cell-sub">${fmt.num(r.offlineMinutes)} min total</div>` },
          { label: 'Longest', num: true, render: (r) => (r.longestOutageMin ? `${fmt.num(r.longestOutageMin)} min` : '—') },
          { label: 'Sessions', num: true, render: (r) => fmt.num(r.sessions) },
          { label: 'Energy', num: true, render: (r) => `${fmt.num(r.energyKwh, 1)} kWh` },
          { label: 'Revenue', num: true, render: (r) => fmt.money(r.revenueMinor, r.currency) },
          { label: 'Utilisation', num: true, render: (r) => (r.utilisationPct == null ? '—' : `${r.utilisationPct}%`) },
        ],
        rows,
        empty: 'No commissioned chargers in this period.',
        onRow: (r) => navigate(`#/chargers/${encodeURIComponent(r.ocppIdentity)}`),
      });
    };

    $('[data-days]', root).addEventListener('change', load);
    $('[data-refresh]', root).addEventListener('click', load);
    $('[data-csv]', root).addEventListener('click', () => {
      if (!data.rows.length) return;
      // Revenue is in each charger's site currency. An Indonesia-only operator gets the v1.6 file unchanged; with
      // Malaysian or Singapore chargers the column was still headed "Revenue IDR" over sen and cents.
      const multi = data.rows.some((r) => !isRupiah(r.currency));
      const header = ['Charger', 'Identity', 'Site', 'Online now', 'Uptime %', 'Outages', 'Offline minutes', 'Longest outage (min)', 'Sessions', 'Energy kWh', ...(multi ? ['Revenue (minor units)', 'Currency'] : [`Revenue ${LEGACY_CURRENCY}`]), 'Utilisation %'];
      const lines = data.rows.map((r) => [r.displayName ?? '', r.ocppIdentity, r.siteName, r.online ? 'yes' : 'no', r.uptimePct ?? '', r.outages, r.offlineMinutes, r.longestOutageMin, r.sessions, r.energyKwh, r.revenueMinor, ...(multi ? [r.currency ?? LEGACY_CURRENCY] : []), r.utilisationPct ?? '']);
      download(`plugsure-availability-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
    });
    await load();
  },
});
