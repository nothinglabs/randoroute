/*
 * Service worker: makes the app installable and usable offline.
 *
 * Strategy:
 *  - App shell (html/js/css/vendor/manifest/icons): NETWORK-FIRST, falling
 *    back to cache — deploys update instantly when online, still work offline.
 *  - Data files (data/*.geojson): CACHE-FIRST — large and rarely changing;
 *    downloaded once, then served locally forever (until the version bumps).
 *  - Basemap tiles (CARTO): CACHE-FIRST — areas you've viewed keep working
 *    offline. Statewide coverage is never fully cached, only what you browse.
 */
const VERSION = 'v74'; // bump when app shell or data files change so installed clients refetch
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = `data-${VERSION}`;
const TILE_CACHE = `tiles-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './route-details.html',
  './app.js',
  './route-details.js',
  './router-worker.js',
  './styles.css',
  './route-details.css',
  './manifest.json',
  './vendor/maplibre-gl.js',
  './vendor/maplibre-gl.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL))
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  const keep = [SHELL_CACHE, DATA_CACHE, TILE_CACHE];
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // PMTiles uses HTTP Range requests; the Cache API can't serve partial
  // content — let those hit the network untouched.
  if (url.pathname.endsWith('.pmtiles')) return;
  if (url.origin === location.origin && url.pathname.includes('/data/')) {
    e.respondWith(cacheFirst(DATA_CACHE, e.request));
  } else if (url.hostname.endsWith('basemaps.cartocdn.com')) {
    e.respondWith(cacheFirst(TILE_CACHE, e.request));
  } else if (url.origin === location.origin) {
    e.respondWith(networkFirst(SHELL_CACHE, e.request));
  }
  // Everything else (cross-origin non-tile) goes straight to the network.
});

async function cacheFirst(name, req) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(name, req) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}
