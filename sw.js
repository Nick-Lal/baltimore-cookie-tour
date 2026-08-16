/*
 * Service worker.
 *
 * The point of this is a cookie tour on a phone, outdoors, on cellular that
 * keeps dropping. The stop list, the rubric, the travel matrix and the whole
 * interface should survive a dead spot; only the live routing line and the
 * shared database genuinely need the network.
 *
 * BUILD is rewritten by tools/stamp-version.mjs, so every deploy gets a fresh
 * cache and the old one is deleted on activate. Without that, a service worker
 * is an excellent way to serve last week's bug forever.
 */

const BUILD = '5f1ed2f5';
const SHELL = `cookietour-shell-${BUILD}`;
const TILES = `cookietour-tiles-${BUILD}`;
const TILE_LIMIT = 300;

/* Everything needed to open the app cold with no network. Deliberately not the
   config or the API: those must always be allowed to change. */
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/themes.css',
  './assets/css/app.css',
  './assets/css/views.css',
  './assets/js/app.js',
  './assets/js/themes.js',
  './assets/js/lib/dom.js',
  './assets/js/lib/geo.js',
  './assets/js/lib/state.js',
  './assets/js/lib/storage.js',
  './assets/js/lib/routing.js',
  './assets/js/views/stops.js',
  './assets/js/views/route.js',
  './assets/js/views/score.js',
  './assets/js/views/results.js',
  './assets/js/views/settings.js',
  './data/stops.json',
  './data/rubric.json',
  './data/matrix.json',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './assets/icons/icon-180.png',
  './assets/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll fails the whole install if any single request 404s, and the
    // versioned URLs make that easy to trip. Add them one at a time so a
    // missing file degrades instead of leaving the site with no worker.
    await Promise.all(PRECACHE.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
        console.warn('[sw] could not precache', url, err.message);
      })
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => {
      if (n.startsWith('cookietour-') && n !== SHELL && n !== TILES) return caches.delete(n);
      return null;
    }));
    await self.clients.claim();
  })());
});

/* A way out. If a worker ever ships broken, visiting ?sw=off unregisters it
   and clears everything, rather than leaving people stuck on a bad build. */
self.addEventListener('message', (event) => {
  if (event.data === 'unregister') {
    event.waitUntil((async () => {
      await self.registration.unregister();
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('cookietour-')).map((n) => caches.delete(n)));
      const clients = await self.clients.matchAll();
      clients.forEach((c) => c.navigate(c.url));
    })());
  }
});

async function trimCache(name, limit) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never touch the database or the routing service. Stale answers there would
  // be worse than no answer: a cached score list is a lie about what is saved.
  if (/supabase\.co$/.test(url.hostname) || /valhalla/.test(url.hostname)) return;

  // Map tiles: serve from cache, refresh in the background, cap the size.
  if (/basemaps\.cartocdn\.com$/.test(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(request);
      const fetching = fetch(request).then((res) => {
        if (res.ok) { cache.put(request, res.clone()); trimCache(TILES, TILE_LIMIT); }
        return res;
      }).catch(() => null);
      return hit || (await fetching) || new Response('', { status: 504 });
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  // The Supabase config must always be fresh, or turning the database on or off
  // would take a cache eviction to notice.
  if (url.pathname.endsWith('/config/supabase.json')) {
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        // Keep a copy. Without it, opening the app offline reports "this device
        // only" as though no database were configured, when the truth is that
        // one is configured and currently unreachable. Those are different
        // things and the interface should not confuse them.
        if (res.ok) (await caches.open(SHELL)).put(request, res.clone());
        return res;
      } catch {
        return (await caches.match(request)) || new Response('{}', {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
    })());
    return;
  }

  // Navigations: network first so a deploy lands promptly, cache as the
  // fallback so a dead spot still opens the app.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        const cache = await caches.open(SHELL);
        cache.put('./index.html', res.clone());
        return res;
      } catch {
        return (await caches.match('./index.html')) || (await caches.match('./')) ||
          new Response('Offline, and no cached copy of the page.', { status: 503 });
      }
    })());
    return;
  }

  // Everything else same-origin: cache first, since the URLs carry a build hash.
  event.respondWith((async () => {
    const hit = await caches.match(request, { ignoreSearch: false });
    if (hit) return hit;
    try {
      const res = await fetch(request);
      if (res.ok && res.type === 'basic') {
        const cache = await caches.open(SHELL);
        cache.put(request, res.clone());
      }
      return res;
    } catch {
      // A versioned asset that is not cached: try again ignoring the ?v= query,
      // which is usually the same file from the previous build.
      const loose = await caches.match(request, { ignoreSearch: true });
      if (loose) return loose;
      throw new Error('offline and uncached: ' + url.pathname);
    }
  })());
});
