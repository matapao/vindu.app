// The shell's service worker, on a paired device: the shell's own files kept for when the network is slow or gone, and
// the core's notifications shown; a tap brings the shell forward, or opens it.
const KEEP = ['./', 'shell-page.bundle.js', 'app-icon', 'manifest.webmanifest'];
const CACHE = 'vindu-shell';
const kept = () => KEEP.map(f => new URL(f, self.registration.scope).href);
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(KEEP)).catch(() => undefined)); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || !kept().includes(e.request.url)) return; // the apps' pages, and everything live, as they are
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); void caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request, { cacheName: CACHE })));
});
self.addEventListener('push', e => {
  let m = {}; try { m = e.data ? e.data.json() : {}; } catch { /* not ours */ }
  e.waitUntil(self.registration.showNotification(m.title || 'vindu', { body: m.body || '', tag: m.tag, data: { url: m.url || self.registration.scope } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    const w = ws.find(x => x.url.startsWith(self.registration.scope));
    return w ? w.focus() : self.clients.openWindow((e.notification.data && e.notification.data.url) || self.registration.scope);
  }));
});
