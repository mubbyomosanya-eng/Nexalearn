// NexaLearn service worker
// Strategy:
//   /api/*            → never cached (live AI calls)
//   HTML navigation   → network-first, cache fallback (fast updates + offline)
//   PWA assets, CDNs  → cache-first (fast loads)
//   everything else   → cache-first with background refresh

const SHELL_CACHE   = 'nexalearn-shell-v1';
const RUNTIME_CACHE = 'nexalearn-runtime-v1';
const CDN_CACHE     = 'nexalearn-cdn-v1';

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-maskable.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(APP_SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE && k !== CDN_CACHE)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1) Never cache API
  if (url.pathname.startsWith('/api/')) return;

  // 2) HTML navigation → network-first
  if (req.mode === 'navigate' ||
      (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then(r => r || caches.match('/index.html'))
        )
    );
    return;
  }

  // 3) PWA shell assets → cache-first
  if (url.origin === self.location.origin &&
      (url.pathname === '/manifest.webmanifest' ||
       url.pathname === '/icon.svg' ||
       url.pathname === '/icon-maskable.svg')) {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }))
    );
    return;
  }

  // 4) External CDN (fonts + lucide) → cache-first
  if (url.hostname === 'fonts.googleapis.com' ||
      url.hostname === 'fonts.gstatic.com' ||
      url.hostname === 'unpkg.com') {
    event.respondWith(
      caches.open(CDN_CACHE).then(cache =>
        cache.match(req).then(cached => {
          if (cached) return cached;
          return fetch(req).then(res => {
            if (res.ok) cache.put(req, res.clone()).catch(() => {});
            return res;
          });
        })
      )
    );
    return;
  }

  // 5) Everything else → cache-first + background refresh
  event.respondWith(
    caches.open(RUNTIME_CACHE).then(cache =>
      cache.match(req).then(cached => {
        const network = fetch(req)
          .then(res => {
            if (res.ok) cache.put(req, res.clone()).catch(() => {});
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});

self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});