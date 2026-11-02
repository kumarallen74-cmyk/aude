/*
 * (v1.46.0) The building or office manager's page (building.html): /building/<token>, the secret link the operator
 * sends from Assets & energy → Private charging. Reads GET /v1/building/<token>: the chargers, the units with this
 * month's energy, the members (cards masked) and the statements; adds or removes a member's card, or adds a unit
 * (POST, the same link). No account, no cookies.
 */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var m = /^\/building\/(bld_[A-Za-z0-9_-]{20,64})\/?$/.exec(location.pathname);
  var src = m ? '/v1/building/' + m[1] : null;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var data = null;
  // Amounts are in minor units; the exponent is 2 except for the currencies that have none.
  var ZERO = { IDR: 1, JPY: 1, KRW: 1, VND: 1 };
  var money = function (minor, cur) {
    var exp = ZERO[cur] ? 0 : 2;
    return (cur ? cur + ' ' : '') + (Number(minor || 0) / Math.pow(10, exp)).toLocaleString(undefined, { minimumFractionDigits: exp, maximumFractionDigits: exp });
  };
  var num = function (n, d) { return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: d || 0 }); };
  var unitWord = function () { return data && data.kind === 'workplace' ? 'Team' : 'Unit'; };

  function send(body) {
    var msg = document.getElementById('msg');
    msg.textContent = 'Saving…';
    return fetch(src, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) { if (!x.ok) { msg.textContent = x.j.error || 'Something went wrong.'; return; } msg.textContent = 'Saved.'; load(); })
      .catch(function () { msg.textContent = 'Something went wrong. Try again later.'; });
  }

  function render(d) {
    data = d;
    document.title = d.name + ' · charging';
    var used = d.units.reduce(function (a, u) { return { s: a.s + u.thisMonth.sessions, k: a.k + u.thisMonth.kwh, e: a.e + u.thisMonth.energyMinor }; }, { s: 0, k: 0, e: 0 });
    var unitName = {};
    d.units.forEach(function (u) { unitName[u.id] = u.code + (u.name ? ' · ' + u.name : ''); });
    var unitOpts = d.units.map(function (u) { return '<option value="' + esc(u.id) + '">' + esc(unitName[u.id]) + '</option>'; }).join('');
    var billingNote = d.billing === 'none' ? 'Charging is free for members.'
      : (d.rateMinor != null ? money(d.rateMinor, d.currency) + ' per kWh' : 'The charger tariff') + (d.monthlyFeeMinor ? ' plus ' + money(d.monthlyFeeMinor, d.currency) + ' a month per ' + unitWord().toLowerCase() : '') + '.';
    app.innerHTML = '<header class="top"><div><h1>' + esc(d.name) + '</h1><div class="muted">' + esc(d.site || '') + (d.operator ? ' · run by ' + esc(d.operator) : '') + '</div></div></header>'
      + '<div class="grid">'
      + '<div class="card kpi"><b>' + d.chargers.length + '</b><span>private chargers</span></div>'
      + '<div class="card kpi"><b>' + d.members.length + '</b><span>members with a card</span></div>'
      + '<div class="card kpi"><b>' + num(used.k, 1) + ' kWh</b><span>this month, ' + used.s + ' charges</span></div>'
      + (d.billing === 'none' ? '' : '<div class="card kpi"><b>' + esc(money(used.e, d.currency)) + '</b><span>energy this month</span></div>')
      + '</div><p class="muted">' + esc(billingNote) + ' Only members’ cards start these chargers.</p>'
      + '<h2>' + unitWord() + 's</h2><div class="card scroll"><table><thead><tr><th>' + unitWord() + '</th><th class="n">Charges</th><th class="n">kWh</th>' + (d.billing === 'none' ? '' : '<th class="n">Energy</th>') + '</tr></thead><tbody>'
      + (d.units.length ? d.units.map(function (u) {
        return '<tr><td>' + esc(unitName[u.id]) + '</td><td class="n">' + u.thisMonth.sessions + '</td><td class="n">' + num(u.thisMonth.kwh, 1) + '</td>' + (d.billing === 'none' ? '' : '<td class="n">' + esc(money(u.thisMonth.energyMinor, d.currency)) + '</td>') + '</tr>';
      }).join('') : '<tr><td colspan="4" class="muted">None yet.</td></tr>')
      + '</tbody></table></div>'
      + '<form id="unit"><input type="text" name="code" maxlength="40" placeholder="' + (d.kind === 'workplace' ? 'Cost centre' : 'Unit, e.g. A-12') + '" required><input type="text" name="name" maxlength="120" placeholder="Name (optional)"><button type="submit">Add ' + unitWord().toLowerCase() + '</button></form>'
      + '<h2>Members</h2><div class="card scroll"><table><thead><tr><th>Name</th><th>' + unitWord() + '</th><th>Card</th><th>Plate</th><th></th></tr></thead><tbody>'
      + (d.members.length ? d.members.map(function (mb) {
        return '<tr><td>' + esc(mb.name) + '</td><td>' + esc(unitName[mb.unitId] || '') + '</td><td style="white-space:nowrap">' + esc(mb.card || '—') + '</td><td>' + esc(mb.plate || '') + '</td><td class="n"><button class="link" type="button" data-remove="' + esc(mb.id) + '">Remove</button></td></tr>';
      }).join('') : '<tr><td colspan="5" class="muted">None yet.</td></tr>')
      + '</tbody></table></div>'
      + (d.units.length ? '<form id="member"><select name="unitId">' + unitOpts + '</select><input type="text" name="name" maxlength="120" placeholder="Name" required><input type="text" name="cardUid" maxlength="20" placeholder="Card number" required><input type="text" name="plate" maxlength="15" placeholder="Plate (optional)"><button type="submit">Add member</button></form>' : '<p class="muted">Add a ' + unitWord().toLowerCase() + ' first.</p>')
      + '<p id="msg" class="muted"></p>'
      + (d.statements.length ? '<h2>Statements</h2><div class="card scroll"><table><thead><tr><th>Month</th><th>' + unitWord() + '</th><th class="n">kWh</th><th class="n">Amount</th><th>Status</th></tr></thead><tbody>'
        + d.statements.map(function (s) { return '<tr><td>' + esc(s.month) + '</td><td>' + esc(s.unit) + '</td><td class="n">' + num(s.kwh, 1) + '</td><td class="n">' + esc(money(s.amountMinor, s.currency)) + '</td><td><span class="tag ' + esc(s.status) + '">' + esc(s.status) + '</span></td></tr>'; }).join('')
        + '</tbody></table></div>' : '')
      + '<footer>Keep this link private: anyone with it can add or remove cards. Ask ' + esc(d.operator || 'the operator') + ' for a new link if it was shared.</footer>';
    var fu = document.getElementById('unit');
    fu.addEventListener('submit', function (e) { e.preventDefault(); send({ action: 'add_unit', code: fu.code.value, name: fu.name.value || null }); });
    var fm = document.getElementById('member');
    if (fm) fm.addEventListener('submit', function (e) { e.preventDefault(); send({ action: 'add_member', unitId: fm.unitId.value, name: fm.name.value, cardUid: fm.cardUid.value, plate: fm.plate.value || null }); });
    Array.prototype.forEach.call(app.querySelectorAll('[data-remove]'), function (b) {
      b.addEventListener('click', function () { if (confirm('Remove this member? Their card stops working at these chargers.')) send({ action: 'remove_member', memberId: b.getAttribute('data-remove') }); });
    });
  }

  function load() {
    if (!src) { app.innerHTML = '<h1>This link is not valid</h1><p class="muted">Check the address, or ask the operator for a new link.</p>'; return; }
    fetch(src, { headers: { accept: 'application/json' } })
      .then(function (r) { if (r.status === 404) throw new Error('none'); return r.json(); })
      .then(render)
      .catch(function (e) { app.innerHTML = e.message === 'none' ? '<h1>This link is not valid any more</h1><p class="muted">Ask the operator for a new link.</p>' : '<p class="muted">Could not load. Try again later.</p>'; });
  }
  load();
})();
