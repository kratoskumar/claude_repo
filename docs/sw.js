// Offline support. App files are cached per version, so the app opens instantly and offline.
// IMPORTANT: bump VERSION (and VERSION in app.js) on every change to the app files.
const VERSION = '1.1.0';
const CACHE = 'mc-' + VERSION;
const SDK_PREFIX = 'https://www.gstatic.com/firebasejs/12.19.0/';
const SDK_CACHE = 'fbsdk-12.19.0';
const FILES = ['./', 'index.html', 'app.css', 'app.js', 'calc.js', 'rates.js', 'image.js', 'cloud.js', 'admin.js', 'config.js',
  'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  // ?v= makes the CDN hand over fresh copies; cache:'reload' skips the browser cache.
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(async f => {
    const r = await fetch(new Request(`${f}?v=${VERSION}`, { cache: 'reload' }));
    if (!r.ok) throw new Error(`${f}: ${r.status}`);
    await c.put(f, r);
  }))));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(k => (k.startsWith('mc-') && k !== CACHE) || (k.startsWith('fbsdk-') && k !== SDK_CACHE))
    .map(k => caches.delete(k)))));
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.includes('/__/')) return; // Firebase sign-in pages: always live
  if (url.origin === location.origin) {
    e.respondWith(caches.open(CACHE).then(async c => (await c.match(req, { ignoreSearch: true })) || fetch(req)));
  } else if (url.href.startsWith(SDK_PREFIX)) {
    // Firebase SDK files never change for a given version: keep them once downloaded.
    e.respondWith(caches.open(SDK_CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) c.put(req, r.clone());
      return r;
    }));
  }
  // Everything else (gold/FX rates, Firebase API calls) goes straight to the network.
});
