/*
 * (v1.43.0) The public status page (status.html): /status/<slug> on the shared console, /status on an operator's own
 * approved console address. Reads GET /v1/status/<slug> (or /status.json by the host), refreshes every minute.
 * No cookies, no tracking.
 */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var m = /^\/status\/([a-z0-9-]{3,50})\/?$/.exec(location.pathname);
  var slug = m ? m[1] : null;
  var src = slug ? '/v1/status/' + encodeURIComponent(slug) : '/status.json';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var when = function (iso) { return iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; };
  var OVERALL = { operational: 'All sites are working', partial: 'Some sites are affected', major_outage: 'A major outage is under way' };
  var STATE = { operational: 'Working', degraded: 'Partly out of service', outage: 'Out of service', maintenance: 'Maintenance' };

  function incident(i) {
    var where = i.sites && i.sites.length ? i.sites.join(', ') : 'All sites';
    var window_ = i.kind === 'maintenance' ? ' · ' + when(i.scheduledFrom) + ' – ' + when(i.scheduledTo) : '';
    var ups = (i.updates || []).slice().reverse().map(function (u) {
      return '<div class="upd"><b>' + esc(u.status.replace('_', ' ')) + '</b> <span class="meta">' + esc(when(u.at)) + '</span><div>' + esc(u.message) + '</div></div>';
    }).join('');
    return '<div class="inc"><h3>' + esc(i.title) + '</h3><div class="meta">' + esc(where) + esc(window_) + ' · ' + esc(i.impact) + ' impact</div>' + ups + '</div>';
  }

  function render(d) {
    document.title = d.title;
    var logo = d.brand && d.brand.logo ? '<img src="' + esc(d.brand.logo) + '" alt="">' : '';
    var sites = d.sites.length ? d.sites.map(function (s) {
      var counts = s.connectors != null ? '<small>' + s.working + ' of ' + s.connectors + ' connectors working' + (s.state === 'operational' || s.state === 'degraded' ? ' · ' + s.available + ' free now' : '') + '</small>' : (s.address ? '<small>' + esc(s.address) + '</small>' : '');
      var queue = s.queue && s.queue.waiting > 0 ? '<small>' + s.queue.waiting + ' waiting in the queue' + (s.queue.estimatedWaitMinutes != null ? ' · about ' + s.queue.estimatedWaitMinutes + ' min wait' : '') + '</small>' : '';
      return '<div class="site"><span class="dot ' + s.state + '"></span><div class="name">' + esc(s.name) + counts + queue + '</div><span class="st ' + s.state + '">' + STATE[s.state] + '</span></div>';
    }).join('') : '<div class="pad muted">No sites listed.</div>';
    app.innerHTML =
      '<header class="top">' + logo + '<div><h1>' + esc(d.title) + '</h1>' + (d.intro ? '<div class="muted">' + esc(d.intro) + '</div>' : '') + '</div></header>' +
      '<div class="banner ' + d.overall + '" role="status">' + OVERALL[d.overall] + '</div>' +
      (d.incidents.length ? '<h2>Current incidents</h2><div class="card">' + d.incidents.map(incident).join('') + '</div>' : '') +
      (d.maintenance.length ? '<h2>Planned maintenance</h2><div class="card">' + d.maintenance.map(incident).join('') + '</div>' : '') +
      '<h2>Sites</h2><div class="card">' + sites + '</div>' +
      '<h2>Past 14 days</h2><div class="card">' + (d.history.length ? d.history.map(incident).join('') : '<div class="pad muted">No incidents.</div>') + '</div>' +
      (slug ? '<h2>Get updates by e-mail</h2><div class="card pad"><form id="sub"><input type="email" name="email" required placeholder="you@example.com" aria-label="E-mail address"><button type="submit">Subscribe</button></form><div id="subMsg" class="meta" role="status"></div></div>' : '') +
      '<footer>Updated ' + esc(when(d.updatedAt)) + '. This page refreshes every minute.</footer>';
    var f = document.getElementById('sub');
    if (f) f.addEventListener('submit', function (e) {
      e.preventDefault();
      var msg = document.getElementById('subMsg');
      fetch('/v1/status/' + encodeURIComponent(slug) + '/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: f.email.value }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) { msg.textContent = x.ok ? x.j.message : (x.j.error || 'Something went wrong.'); if (x.ok) f.reset(); })
        .catch(function () { msg.textContent = 'Something went wrong. Try again later.'; });
    });
  }

  function load() {
    fetch(src, { headers: { accept: 'application/json' } })
      .then(function (r) { if (r.status === 404) throw new Error('none'); return r.json(); })
      .then(render)
      .catch(function (e) { if (e.message === 'none') app.innerHTML = '<h1>No status page here</h1><p class="muted">Check the address.</p>'; });
  }
  load();
  // Refresh every minute, but never under someone typing their e-mail address.
  setInterval(function () {
    var input = document.querySelector('#sub input');
    if (!input || (document.activeElement !== input && !input.value)) load();
  }, 60000);
})();
