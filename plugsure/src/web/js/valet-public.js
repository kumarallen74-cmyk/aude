/*
 * (v1.48.0) The hotel's valet page (valet.html): /valet/<token>, the secret link from Commercial → Hotels. Staff see
 * the hotel's connectors and who is charging, plug a guest's car in, choose the room and start; or stop a car.
 * Reads GET /v1/valet/<token> every 15 seconds; starts and stops with POST (the same link). No account, no cookies.
 */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var m = /^\/valet\/(vlt_[A-Za-z0-9_-]{20,64})\/?$/.exec(location.pathname);
  var src = m ? '/v1/valet/' + m[1] : null;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var since = function (iso) { if (!iso) return ''; var min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); return min < 60 ? min + ' min' : Math.floor(min / 60) + ' h ' + (min % 60) + ' min'; };
  var busy = false, timer = null, msgText = '';

  function send(body) {
    busy = true;
    var msg = document.getElementById('msg'); if (msg) msg.textContent = 'Sending…';
    return fetch(src, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        msgText = x.ok ? (x.j.started ? 'Charging started for room ' + x.j.room + '.' : x.j.stopped ? 'Charging stopped for room ' + x.j.room + '.' : 'Sent.') : (x.j.error || 'Something went wrong.');
        busy = false; load();
      })
      .catch(function () { busy = false; msgText = 'Something went wrong. Try again.'; load(); });
  }

  function render(d) {
    document.title = d.hotel + ' · valet';
    var rooms = d.rooms.map(function (r) { return '<option value="' + esc(r.stayId) + '">' + esc(r.room) + ' · ' + esc(r.guest) + (r.plate ? ' · ' + esc(r.plate) : '') + '</option>'; }).join('');
    app.innerHTML = '<header class="top"><div><h1>' + esc(d.hotel) + '</h1><div class="muted">Valet charging · ' + d.rooms.length + ' rooms in house</div></div></header>'
      + '<p id="msg" class="muted">' + esc(msgText) + '</p>'
      + '<div class="card">' + (d.connectors.length ? d.connectors.map(function (c) {
        var ch = c.charging;
        var right = ch && ch.sessionId
          ? '<button class="stop" type="button" data-stop="' + esc(ch.sessionId) + '">Stop</button>'
          : ch ? '<span class="muted">In use</span>'
          : (c.status === 'Available' || c.status === 'Preparing') && d.rooms.length
            ? '<select data-room="' + esc(c.id) + '"><option value="">Room…</option>' + rooms + '</select><button type="button" data-start="' + esc(c.id) + '">Start</button>' : '';
        return '<div class="conn"><div class="what"><b>' + esc(c.charger) + ' · ' + esc(c.connector) + '</b><small>' + (c.kw ? c.kw + ' kW' : '')
          + (ch && ch.room ? ' · room ' + esc(ch.room) + ', ' + since(ch.since) + (ch.kwh != null ? ', ' + ch.kwh.toFixed(1) + ' kWh' : '') : '') + '</small></div>'
          + '<span class="st ' + esc(c.status || '') + '">' + esc(c.status || 'unknown') + '</span>' + right + '</div>';
      }).join('') : '<div class="conn">No chargers at this hotel.</div>') + '</div>'
      + '<p class="muted">Plug the car in first, then choose its room and Start. The charging is billed to the room.</p>'
      + '<footer>Keep this link for the hotel’s staff only.</footer>';
    Array.prototype.forEach.call(app.querySelectorAll('[data-start]'), function (b) {
      b.addEventListener('click', function () {
        var sel = app.querySelector('[data-room="' + b.getAttribute('data-start') + '"]');
        if (!sel || !sel.value) { msgText = 'Choose the room first.'; document.getElementById('msg').textContent = msgText; return; }
        send({ action: 'start', connectorId: b.getAttribute('data-start'), stayId: sel.value });
      });
    });
    Array.prototype.forEach.call(app.querySelectorAll('[data-stop]'), function (b) {
      b.addEventListener('click', function () { if (confirm('Stop this car charging?')) send({ action: 'stop', sessionId: b.getAttribute('data-stop') }); });
    });
  }

  function load() {
    clearTimeout(timer);
    if (!src) { app.innerHTML = '<h1>This link is not valid</h1>'; return; }
    fetch(src, { headers: { accept: 'application/json' } })
      .then(function (r) { if (r.status === 404) throw new Error('none'); return r.json(); })
      .then(function (d) { if (!busy && !(document.activeElement && document.activeElement.tagName === 'SELECT')) render(d); timer = setTimeout(load, 15000); })
      .catch(function (e) { app.innerHTML = e.message === 'none' ? '<h1>This link is not valid any more</h1><p class="muted">Ask the operator for a new link.</p>' : '<p class="muted">Could not load. Retrying…</p>'; if (e.message !== 'none') timer = setTimeout(load, 15000); });
  }
  load();
})();
