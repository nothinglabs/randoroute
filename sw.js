/*
 * Service worker: makes the app installable and usable offline.
 *
 * Strategy:
 *  - App shell (html/js/css/vendor/manifest/icons): CACHE-FIRST. A running
 *    app stays on one complete release until the user accepts the precached
 *    update, so HTML, JS, and CSS cannot be mixed during deployment.
 *  - Routing and vector-map data: PRECACHED + CACHE-FIRST. The installed PWA
 *    downloads the complete Washington dataset, including PMTiles archives.
 *  - PMTiles Range requests are answered from the cached full archive, so the
 *    map remains usable without a network connection.
 */
const VERSION = 'v345'; // bump when app shell changes
const SHELL_CACHE = `shell-${VERSION}`;
// Keep the large offline dataset across ordinary UI-only app releases.
const DATA_CACHE = 'data-offline-map-v1';

const SHELL = [
  './',
  './index.html',
  './route-details.html',
  './app.js',
  './basemap-style.js',
  './route-details.js?v=345',
  './router-worker.js',
  './styles.css',
  './route-details.css?v=345',
  './manifest.json',
  './vendor/maplibre-gl.js',
  './vendor/maplibre-gl.css',
  './vendor/pmtiles.js',
  './fonts/Klokantech Noto Sans Regular/0-255.pbf',
  './fonts/Klokantech Noto Sans Regular/256-511.pbf',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

const DATA = [
  './data/bikeroutes.geojson',
  './data/blts.geojson',
  './data/bikeinfra.geojson',
  './data/bike_restrictions.geojson',
  './data/route_closures.geojson',
  './data/roads.pmtiles',
  './data/basemap.pmtiles',
  './data/graph2.bin.gz',
  './data/places.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)),
      precacheData(),
    ])
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  const keep = [SHELL_CACHE, DATA_CACHE];
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin === location.origin && url.pathname.endsWith('.pmtiles')) {
    e.respondWith(pmtilesRangeResponse(e.request));
  } else if (url.origin === location.origin && url.pathname.includes('/data/')) {
    e.respondWith(cacheFirst(DATA_CACHE, e.request, true));
  } else if (url.origin === location.origin) {
    e.respondWith(cacheFirst(SHELL_CACHE, e.request));
  }
  // Everything else (cross-origin non-tile) goes straight to the network.
});

async function cacheFirst(name, req, ignoreSearch = false) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, {
    ignoreVary: true,
    ignoreSearch,
  });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function precacheData() {
  const cache = await caches.open(DATA_CACHE);
  // These archives are intentionally large. Fetching all of them concurrently
  // can spike Safari's memory during PWA installation, so populate the
  // persistent cache one file at a time.
  for (const path of DATA) {
    const request = new Request(path, { cache: 'reload' });
    const hit = await cache.match(request, { ignoreSearch: true });
    if (!hit) await cache.add(request);
  }
}

async function pmtilesRangeResponse(req) {
  const cache = await caches.open(DATA_CACHE);
  const fullRequest = new Request(req.url, { method: 'GET' });
  let full = await cache.match(fullRequest, { ignoreVary: true, ignoreSearch: true });
  if (!full) {
    full = await fetch(fullRequest);
    if (!full.ok) return full;
    await cache.put(fullRequest, full.clone());
  }
  const range = req.headers.get('Range');
  if (!range) return full;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(range);
  if (!match) return new Response(null, { status: 416 });
  const blob = await full.blob();
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : blob.size - 1;
  const end = Math.min(requestedEnd, blob.size - 1);
  if (start > end || start >= blob.size) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${blob.size}` },
    });
  }
  const slice = blob.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${blob.size}`,
      'Content-Length': String(slice.size),
      'Content-Type': full.headers.get('Content-Type') || 'application/octet-stream',
    },
  });
}
