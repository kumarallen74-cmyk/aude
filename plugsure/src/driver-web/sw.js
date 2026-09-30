/*
 * PlugSure driver app service worker. Push notifications only: it shows what
 * the server sends and opens the app at the right screen when tapped. It does
 * NOT cache the app (no fetch handler), so a deploy is picked up on the next
 * load exactly as before.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (err) { m = { title: 'PlugSure', body: e.data ? e.data.text() : '' }; }
  const url = typeof m.url === 'string' && m.url.startsWith('/app/') ? m.url : '/app/';
  e.waitUntil(self.registration.showNotification(m.title || 'PlugSure', {
    body: m.body || '',
    tag: m.tag || undefined,
    renotify: !!m.tag,
    data: { url },
    // The charge in a picture (Chrome on Android and desktop show it; others ignore it).
    ...(typeof m.image === 'string' && m.image.startsWith('/d/n/') ? { image: m.image } : {}),
    icon: 'data:image/svg+xml,' + encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'><rect width='512' height='512' rx='120' fill='#1b4d8c'/>" +
      "<rect x='170' y='94' width='42' height='120' rx='21' fill='#2fd6a7'/><rect x='298' y='94' width='42' height='120' rx='21' fill='#2fd6a7'/>" +
      "<path d='M136 290 238 392 392 196' stroke='#2fd6a7' stroke-width='51' stroke-linecap='round' stroke-linejoin='round' fill='none'/></svg>"),
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/app/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).pathname.startsWith('/app')) {
        await w.focus();
        // The open app routes on hashchange.
        try { await w.navigate(url); } catch (err) { w.postMessage({ type: 'open', url }); }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
