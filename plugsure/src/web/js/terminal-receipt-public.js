/*
 * (v1.47.0) A card terminal payment's receipt (terminal-receipt.html): /terminal-receipt/<token>, the link the
 * terminal shows (as a QR code). Reads GET /v1/terminal-receipts/<token>; refreshes while the car is charging.
 */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var m = /^\/terminal-receipt\/(trr_[A-Za-z0-9_-]{20,64})\/?$/.exec(location.pathname);
  var src = m ? '/v1/terminal-receipts/' + m[1] : null;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ZERO = { IDR: 1, JPY: 1, KRW: 1, VND: 1 };
  var money = function (minor, cur) { var e = ZERO[cur] ? 0 : 2; return (cur ? cur + ' ' : '') + (Number(minor || 0) / Math.pow(10, e)).toLocaleString(undefined, { minimumFractionDigits: e, maximumFractionDigits: e }); };
  var when = function (iso) { return iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; };
  var row = function (k, v) { return '<div class="row"><span>' + esc(k) + '</span><b>' + v + '</b></div>'; };
  var HEAD = { paid: 'Paid', released: 'Nothing charged: the hold on your card is released', charging: 'Charging', pending: 'Being settled' };

  function render(d) {
    document.title = 'Receipt · ' + d.site;
    app.innerHTML = '<header class="top"><div><h1>' + esc(HEAD[d.status] || d.status) + '</h1><div class="muted">' + esc(d.operator) + ' · ' + esc(d.site) + '</div></div></header>'
      + '<div class="card">'
      + (d.status === 'paid' ? row('Amount', esc(money(d.amountMinor, d.currency))) : row('Held on the card', esc(money(d.preauthMinor, d.currency))))
      + row('Energy', d.kwh == null ? '—' : d.kwh.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' kWh')
      + row('Charger', esc(d.charger || '—')) + row('Started', esc(when(d.startedAt))) + row('Ended', esc(when(d.endedAt)))
      + row('Card', esc(d.card || '—')) + row('Reference', esc(d.reference))
      + '</div>'
      + (d.status === 'paid' ? '<p class="muted">The rest of the hold is released by your bank, usually within a few days.</p>' : '')
      + (d.address ? '<footer>' + esc(d.address) + '</footer>' : '');
    if (d.status === 'charging' || d.status === 'pending') setTimeout(load, 20000);
  }
  function load() {
    if (!src) { app.innerHTML = '<h1>No such receipt</h1>'; return; }
    fetch(src, { headers: { accept: 'application/json' } })
      .then(function (r) { if (r.status === 404) throw new Error('none'); return r.json(); })
      .then(render)
      .catch(function (e) { app.innerHTML = e.message === 'none' ? '<h1>No such receipt</h1>' : '<p class="muted">Could not load. Try again later.</p>'; });
  }
  load();
})();
