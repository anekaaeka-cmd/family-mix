/* «Семейный микс» — service worker: кэширует игру, чтобы она быстро открывалась и ставилась как приложение.
   Меняй VERSION при каждом обновлении файлов. Для самой игры нужен интернет (связь между телефонами). */
const VERSION = 'family-mix-v1.0.0';
const FILES = ['./', './index.html', './style.css', './manifest.webmanifest',
  './js/app.js', './js/data.js', './js/game.js', './js/net.js', './js/sfx.js', './js/map-geo.js', './vendor/nostr-sign.min.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('family-mix-') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // сначала сеть (чтобы получать обновления), без сети — копия из кэша
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === 'navigate' ? caches.match('./index.html') : undefined))));
});
