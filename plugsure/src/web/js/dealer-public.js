/*
 * (v1.50.0) The car dealer's portal (dealer.html): /dealer/<token>, the secret link from Commercial → Dealers. The
 * dealer's staff register each car sold and hand the buyer the welcome code shown (once); they see this month so far,
 * their sales and their issued statements. Reads GET /v1/dealer-portal/<token>; registers with POST …/sales.
 */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var m = /^\/dealer\/(dlr_[A-Za-z0-9_-]{20,64})\/?$/.exec(location.pathname);
  var src = m ? '/v1/dealer-portal/' + m[1] : null;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var exp = 2;
  // Amounts are in the currency's minor units, 10^-exponent of the major unit (the portal says which).
  var money = function (n, cur) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, minimumFractionDigits: exp, maximumFractionDigits: exp }).format(n / Math.pow(10, exp)); } catch (e) { return n + ' ' + cur; } };
  var LABEL = { pending: 'code not used yet', redeemed: 'redeemed', expired: 'expired', void: 'void' };
  var last = null;

  function render(d, flash) {
    last = d;
    exp = typeof d.exponent === 'number' ? d.exponent : 2;
    document.title = d.dealer + ' · dealer portal';
    var t = d.thisMonth;
    var net = t.netMinor > 0 ? 'you pay ' + money(t.netMinor, d.currency) : t.netMinor < 0 ? 'you are paid ' + money(-t.netMinor, d.currency) : 'nothing due';
    app.innerHTML = '<header class="top"><div><h1>' + esc(d.dealer) + '</h1><div class="muted">' + esc(d.operator || '') + ' · charging for your buyers</div></div></header>'
      + '<div class="card pad muted">Each buyer gets <b>' + money(d.welcomeMinor, d.currency) + '</b> of charging credit in the app'
      + (d.funding === 'dealer' ? ', billed to you when they redeem it' : '') + '. You earn <b>' + (d.commissionBps / 100) + ' %</b> of their charging for '
      + d.commissionMonths + ' months. A code is valid for ' + d.codeDays + ' days.</div>'
      + (flash || '')
      + '<h2>Register a car sold</h2><div class="card"><form class="form" id="f">'
      + '<label>Buyer<input name="buyerName" required maxlength="120"></label>'
      + '<label>Buyer\'s mobile<input name="buyerPhone" maxlength="30" placeholder="08…"></label>'
      + '<label>Car<input name="vehicle" maxlength="80" placeholder="' + esc(d.make || '') + '"></label>'
      + '<label>VIN<input name="vin" maxlength="17"></label>'
      + '<label>Plate<input name="plate" maxlength="15"></label>'
      + '<label>&nbsp;<button type="submit">Register and get the code</button></label></form><p id="msg" class="pad err" style="margin:0;padding-top:0"></p></div>'
      + '<h2>This month</h2><div class="grid">'
      + kpi(t.sales, 'cars sold') + kpi(t.redeemed, 'codes redeemed') + kpi(money(t.revenueMinor, d.currency), 'your buyers\' charging') + kpi(money(t.commissionMinor, d.currency), 'your commission so far')
      + '</div><p class="muted">So far: ' + esc(net) + '.</p>'
      + '<h2>Your sales</h2><div class="card scroll"><table><thead><tr><th>Sale</th><th>Sold</th><th>Buyer</th><th>Car</th><th>Code</th></tr></thead><tbody>'
      + (d.sales.length ? d.sales.map(function (s) { return '<tr><td>' + esc(s.number) + '</td><td>' + esc(s.soldOn) + '</td><td>' + esc(s.buyerName) + '</td><td>' + esc(s.vehicle || '') + '<br><small class="muted">' + esc(s.vin || '') + '</small></td><td>…' + esc(s.codeLast4) + ' · ' + esc(LABEL[s.status] || s.status) + '</td></tr>'; }).join('') : '<tr><td colspan="5" class="muted">No sales yet.</td></tr>')
      + '</tbody></table></div>'
      + '<h2>Statements</h2><div class="card scroll"><table><thead><tr><th>Month</th><th class="n">Sold</th><th class="n">Credit billed</th><th class="n">Commission</th><th class="n">Net</th><th>Status</th></tr></thead><tbody>'
      + (d.statements.length ? d.statements.map(function (s) { return '<tr><td>' + esc(s.month) + '</td><td class="n">' + s.sales + '</td><td class="n">' + money(s.billedMinor, s.currency) + '</td><td class="n">' + money(s.commissionMinor, s.currency) + '</td><td class="n">' + (s.netMinor > 0 ? 'you pay ' : s.netMinor < 0 ? 'you are paid ' : '') + money(Math.abs(s.netMinor), s.currency) + '</td><td>' + esc(s.status) + (s.reference ? ' · ' + esc(s.reference) : '') + '</td></tr>'; }).join('') : '<tr><td colspan="6" class="muted">No statements yet.</td></tr>')
      + '</tbody></table></div><footer>Keep this link to your sales team. It works without an account; ask the operator for a new one if it gets out.</footer>';
    document.getElementById('f').addEventListener('submit', submit);
  }
  function kpi(v, label) { return '<div class="card kpi"><b>' + esc(v) + '</b><span>' + esc(label) + '</span></div>'; }

  function submit(e) {
    e.preventDefault();
    var f = e.target, body = {};
    ['buyerName', 'buyerPhone', 'vehicle', 'vin', 'plate'].forEach(function (k) { var v = f.elements[k].value.trim(); if (v) body[k] = v; });
    var msg = document.getElementById('msg'); msg.textContent = 'Sending…';
    fetch(src + '/sales', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) { msg.textContent = x.j.error || 'Something went wrong.'; return; }
        var s = x.j;
        load('<div class="card pad note" style="margin-top:14px"><b>' + esc(s.number) + ' · ' + esc(s.buyerName) + '</b><div class="code">' + esc(s.code) + '</div>'
          + '<div class="muted">Give this code to the buyer now: it is shown only once. They enter it in the charging app (Account → Credit) by ' + esc(s.codeExpiresOn)
          + (s.buyerPhone ? ', signed in with their own number' : '') + '.</div></div>');
      })
      .catch(function () { msg.textContent = 'Something went wrong. Try again.'; });
  }

  function load(flash) {
    if (!src) { app.innerHTML = '<p>This link is not valid.</p>'; return; }
    fetch(src).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) { if (!x.ok) { app.innerHTML = '<p>' + esc(x.j.error || 'This link is not valid.') + '</p>'; return; } render(x.j, flash); })
      .catch(function () { app.innerHTML = '<p>Could not load. Check the connection and reload.</p>'; });
  }
  load('');
})();
