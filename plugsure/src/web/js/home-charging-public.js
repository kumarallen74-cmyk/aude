/*
 * (v1.47.0) An employee's home charging page (home-charging.html): /home-charging/<token>, the secret link from
 * Finance → Home charging. Reads GET /v1/home-charging/<token>: the rate, this month's kWh so far, the readings and the
 * reimbursements; with a meter, the employee adds a reading (POST, the same link). No account, no cookies.
 */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var m = /^\/home-charging\/(hcr_[A-Za-z0-9_-]{20,64})\/?$/.exec(location.pathname);
  var src = m ? '/v1/home-charging/' + m[1] : null;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ZERO = { IDR: 1, JPY: 1, KRW: 1, VND: 1 };
  var money = function (minor, cur) { var e = ZERO[cur] ? 0 : 2; return (cur ? cur + ' ' : '') + (Number(minor || 0) / Math.pow(10, e)).toLocaleString(undefined, { minimumFractionDigits: e, maximumFractionDigits: e }); };
  var num = function (n, d) { return n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d || 0 }); };
  var STATUS = { draft: 'being prepared', approved: 'approved', paid: 'paid' };

  function render(d) {
    document.title = 'Home charging · ' + d.employeeName;
    var tm = d.thisMonth;
    app.innerHTML = '<header class="top"><div><h1>Home charging</h1><div class="muted">' + esc(d.employeeName) + (d.operator ? ' · ' + esc(d.operator) : '') + '</div></div></header>'
      + '<div class="grid">'
      + '<div class="card kpi"><b>' + (tm.kwh == null ? '—' : num(tm.kwh, 1) + ' kWh') + '</b><span>' + esc(tm.month) + (tm.sessions != null ? ', ' + tm.sessions + ' charges' : '') + '</span></div>'
      + '<div class="card kpi"><b>' + (tm.kwh == null ? '—' : esc(money(Math.round(tm.kwh * d.rateMinorPerKwh), d.currency))) + '</b><span>so far this month</span></div>'
      + '</div><p class="muted">Paid back at ' + esc(money(d.rateMinorPerKwh, d.currency)) + ' per kWh' + (d.monthlyCapMinor != null ? ', at most ' + esc(money(d.monthlyCapMinor, d.currency)) + ' a month' : '') + '.'
      + (tm.kwh == null ? ' ' + esc(tm.basis.charAt(0).toUpperCase() + tm.basis.slice(1)) + '.' : '') + '</p>'
      + (d.mode === 'readings' ? '<h2>Meter readings</h2><form id="rd"><input type="date" name="readOn" value="' + new Date().toISOString().slice(0, 10) + '" required>'
        + '<input type="text" name="kwhTotal" inputmode="decimal" placeholder="kWh on the meter" required><button type="submit">Add reading</button></form><p id="msg" class="muted"></p>'
        + '<div class="card">' + (d.readings.length ? d.readings.map(function (r) { return '<div class="row"><span>' + esc(r.readOn) + '</span><b>' + num(r.kwhTotal, 1) + ' kWh</b></div>'; }).join('') : '<div class="row"><span>No readings yet.</span></div>') + '</div>'
        + '<p class="muted">Read the counter on your charger\'s meter at the start of each month (and when you like). The month is the last reading in it minus the one before.</p>' : '')
      + '<h2>Reimbursements</h2><div class="card scroll"><table><thead><tr><th>Month</th><th class="n">kWh</th><th class="n">Amount</th><th>Status</th></tr></thead><tbody>'
      + (d.reimbursements.length ? d.reimbursements.map(function (r) {
        return '<tr><td>' + esc(r.month) + '</td><td class="n">' + num(r.kwh, 1) + '</td><td class="n">' + esc(money(r.amountMinor, r.currency)) + (r.capped ? ' <span class="muted">(cap)</span>' : '') + '</td><td><span class="tag ' + esc(r.status === 'approved' ? 'issued' : r.status) + '">' + esc(STATUS[r.status] || r.status) + '</span></td></tr>';
      }).join('') : '<tr><td colspan="4" class="muted">None yet.</td></tr>') + '</tbody></table></div>'
      + '<footer>This link is yours: keep it private.</footer>';
    var f = document.getElementById('rd');
    if (f) f.addEventListener('submit', function (e) {
      e.preventDefault();
      var msg = document.getElementById('msg'); msg.textContent = 'Saving…';
      fetch(src, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ readOn: f.readOn.value, kwhTotal: Number(String(f.kwhTotal.value).replace(',', '.')) }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) { if (!x.ok) { msg.textContent = x.j.error || 'Something went wrong.'; return; } render(x.j); document.getElementById('msg').textContent = 'Saved.'; })
        .catch(function () { msg.textContent = 'Something went wrong. Try again later.'; });
    });
  }

  if (!src) { app.innerHTML = '<h1>This link is not valid</h1><p class="muted">Ask your employer for a new link.</p>'; return; }
  fetch(src, { headers: { accept: 'application/json' } })
    .then(function (r) { if (r.status === 404) throw new Error('none'); return r.json(); })
    .then(render)
    .catch(function (e) { app.innerHTML = e.message === 'none' ? '<h1>This link is not valid any more</h1><p class="muted">Ask your employer for a new link.</p>' : '<p class="muted">Could not load. Try again later.</p>'; });
})();
