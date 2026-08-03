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
importScripts('./build-version.js');

const VERSION = 'v501'; // bump when app shell changes
const SHELL_CACHE = `shell-${VERSION}`;
// Keep the large offline dataset across ordinary UI-only app releases.
const DATA_CACHE = 'data-offline-map-v8';

const SHELL = [
  './',
  './index.html',
  './street-view-embed.html',
  './route-details.html',
  './app.js',
  './palette.js',
  './region.js',
  './build-version.js',
  './safety-model.js',
  './basemap-style.js',
  './route-details.js?v=458',
  './router-worker.js',
  './styles.css',
  './route-details.css?v=451',
  './manifest.json',
  './vendor/maplibre-gl.js',
  './vendor/maplibre-gl.css',
  './vendor/pmtiles.js',
  './vendor/fflate.js',
  './vendor/fflate-LICENSE.txt',
  './fonts/Klokantech Noto Sans Regular/0-255.pbf',
  './fonts/Klokantech Noto Sans Regular/256-511.pbf',
  './fonts/Klokantech Noto Sans Regular/512-767.pbf',
  './fonts/Klokantech Noto Sans Regular/768-1023.pbf',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// GRAPH_DATA_VERSION and GRAPH_URL come from build-version.js, which
// index.html loads too. Bump them there.

const DATA = [
  './data/bikeroutes.geojson.gz',
  './data/blts.geojson.gz',
  './data/bikeinfra.geojson.gz',
  './data/bike_restrictions.geojson.gz',
  './data/route_closures.geojson.gz',
  './data/roads.pmtiles',
  './data/basemap.pmtiles',
  `./${GRAPH_URL}`,
  './data/places.json',
];
// Small, release-generated overlays can change without changing the 100+ MB
// statewide archives. Refresh these explicitly while retaining the rest of
// DATA_CACHE across UI releases.
const ALWAYS_REFRESH_DATA = new Set([
  './data/bikeroutes.geojson.gz',
]);

// cache.addAll() is all-or-nothing: one dropped request on a phone fails the
// whole install, the new worker never reaches the waiting state, and the app
// reports an update it cannot install. Fetch each file with one retry instead.
async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  for (const path of SHELL) {
    const request = new Request(path, { cache: 'reload' });
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(request);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await cache.put(path, response);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    // The shell must be complete for the app to work offline, so a file that
    // fails twice still fails the install -- just not on a single blip.
    if (lastError) throw new Error(`${path}: ${lastError.message}`);
  }
}

self.addEventListener('install', (e) => {
  const updatingExistingApp = Boolean(self.registration.active);
  e.waitUntil(
    Promise.all([
      precacheShell(),
      // A first install must become fully offline-capable. An update already
      // has the complete data cache; touching every 30–44 MB archive here can
      // make mobile Safari discard the candidate worker before it reaches the
      // waiting state.
      updatingExistingApp ? Promise.resolve() : precacheData(),
    ])
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
  // The page asks for this when the graph version it wants is not the one it
  // last loaded. Activation already purges, but a page can outlive that: the
  // load that first runs a new app.js is still controlled by the PREVIOUS
  // worker, which served /data/ ignoring the query string and handed back a
  // stale graph. Answering here lets the page clear it and retry without the
  // rider having to reload a second time.
  if (e.data && e.data.type === 'PURGE_GRAPH') {
    e.waitUntil(purgeStaleGraph().then(() => {
      e.source?.postMessage({ type: 'GRAPH_PURGED' });
    }));
  }
});

self.addEventListener('activate', (e) => {
  const keep = [SHELL_CACHE, DATA_CACHE];
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => purgeStaleGraph())
      .then(() => refreshReleaseData())
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin === location.origin && url.pathname.endsWith('.pmtiles')) {
    e.respondWith(pmtilesOnlineFirst(e.request));
  } else if (url.origin === location.origin && url.pathname.endsWith('/data/graph2.bin.gz')) {
    // The one /data/ asset whose query string matters: it carries the graph's
    // build version, and ignoring it served a stale routing graph forever.
    e.respondWith(cacheFirst(DATA_CACHE, e.request, false));
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

async function pmtilesOnlineFirst(req) {
  try {
    const response = await fetch(req);
    // A PMTiles range read must remain a range response. GitHub Pages supports
    // this directly, avoiding a 35–44 MB cached-archive Blob for every tile.
    if (response.ok && (!req.headers.get('Range') || response.status === 206)) {
      return response;
    }
  } catch (e) {
    // Offline: fall through to the complete archive stored at installation.
  }
  return pmtilesRangeResponse(req);
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

// Delete graph copies from an earlier build. Keyed caching alone would leave
// the previous 30 MB archive sitting in storage for good.
async function purgeStaleGraph() {
  const cache = await caches.open(DATA_CACHE);
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    if (!url.pathname.endsWith('/data/graph2.bin.gz')) continue;
    if (url.searchParams.get('gv') !== GRAPH_DATA_VERSION) await cache.delete(request);
  }
}

async function refreshReleaseData() {
  const cache = await caches.open(DATA_CACHE);
  for (const path of ALWAYS_REFRESH_DATA) {
    const request = new Request(path, { cache: 'reload' });
    try {
      const response = await fetch(request);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await cache.put(request, response);
    } catch (error) {
      // Preserve the prior offline copy if a rider accepts an update without a
      // usable connection. A later release/update attempt can refresh it.
      console.warn(`Could not refresh ${path}:`, error);
    }
  }
}

const pmtilesBlobPromises = new Map();

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
  const archiveKey = new URL(req.url).pathname;
  let blobPromise = pmtilesBlobPromises.get(archiveKey);
  if (!blobPromise) {
    blobPromise = full.blob().catch((error) => {
      pmtilesBlobPromises.delete(archiveKey);
      throw error;
    });
    pmtilesBlobPromises.set(archiveKey, blobPromise);
  }
  const blob = await blobPromise;
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
