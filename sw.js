/*
 * Service worker: makes the app installable and usable offline.
 *
 * Strategy:
 *  - App shell (html/js/css/vendor/manifest/icons): CACHE-FIRST. A running
 *    app stays on one complete release until the user accepts the precached
 *    update, so HTML, JS, and CSS cannot be mixed during deployment.
 *  - Routing and vector-map data: PRECACHED + CACHE-FIRST. The installed PWA
 *    downloads the loaded state's complete dataset, including PMTiles
 *    archives -- whichever files that state declares it has.
 *  - PMTiles Range requests are answered from the cached full archive, so the
 *    map remains usable without a network connection.
 */
importScripts('./maps/states.js');
importScripts('./region.js');
importScripts('./build-version.js');

// Every data path is the loaded state's folder. region.js decides which state
// that is; nothing here names one.
const DATA_ROOT = `./${Region.dataRoot}`;
const stateFile = (name) => `${DATA_ROOT}/${name}`;

// The shell cache is keyed on this, and sw.js is only reinstalled when its own
// bytes differ -- so a change to any SHELL file that does not touch this line is
// invisible to everyone who already has the app. v642 was maps/states.js
// gaining Oregon (that file is SHELL, not data: it is the index naming which
// states exist). v643 was app.js and styles.css; v644 app.js; v645 app.js and palette.js.
const VERSION = 'v651'; // bump when app shell changes
const SHELL_CACHE = `shell-${VERSION}`;
// Keep the large offline dataset across ordinary UI-only app releases.
//
// v9 because every data file moved from ./data/ into ./maps/<state>/. A cache
// is keyed by URL, so the v8 entries can never be hit again: leaving them would
// strand about 150 MB of unreachable archives on every installed PWA forever.
// Dropping the cache costs a re-download, which this release requires anyway --
// activation refetches the archives and the graph comes back on the first
// route.
const DATA_CACHE = 'data-offline-map-v9';

const SHELL = [
  './',
  './index.html',
  './street-view-embed.html',
  './route-details.html',
  './app.js',
  './palette.js',
  './maps/states.js',
  './region.js',
  './build-version.js',
  './safety-model.js',
  './basemap-style.js',
  './route-details.js?v=465',
  './router-worker.js',
  './styles.css',
  './route-details.css?v=453',
  './marker-icons.js',
  './route-common.js',
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

// Only what the loaded state actually ships. A state under construction may
// carry a place index and nothing else, and precaching a graph that is not
// there fails the whole install -- the new worker never reaches waiting and
// the app reports an update it can never apply.
const ships = (dataset) => !!Region.datasets[dataset];
const DATA = [
  ...[
    ['bikeroutes', 'bikeroutes.geojson.gz'],
    ['restrictions', 'bike_restrictions.geojson.gz'],
    ['closures', 'route_closures.geojson.gz'],
    ['roads', 'roads.pmtiles'],
    ['basemap', 'basemap.pmtiles'],
    ['overlays', 'overlays.pmtiles'],
  ].filter(([dataset]) => ships(dataset)).map(([, file]) => stateFile(file)),
  ...(ships('graph') ? [`./${GRAPH_URL}`] : []),
  ...(ships('places') ? [stateFile('places.json')] : []),
];
// Small, release-generated overlays can change without changing the 100+ MB
// statewide archives. Refresh ALL of them on every activation while retaining
// the big archives across UI releases -- "check for updates" must really
// deliver everything new, and these together are a few MB.
const ALWAYS_REFRESH_DATA = new Set(DATA.filter((path) => [
  'bikeroutes.geojson.gz', 'bike_restrictions.geojson.gz',
  'route_closures.geojson.gz', 'places.json',
].some((file) => path.endsWith(`/${file}`))));

// The big archives refresh only when their content stamp (the state's
// region.json) changes. The stamp of the cached copy is stored as a marker
// entry beside the archive; no marker means an install that predates stamping,
// which counts as stale -- one refresh, then it is stamped like everything
// else.
const ARCHIVE_VERSIONS = Object.fromEntries([
  ['roads', stateFile('roads.pmtiles'), ROADS_TILES_VERSION],
  ['basemap', stateFile('basemap.pmtiles'), BASEMAP_TILES_VERSION],
  ['overlays', stateFile('overlays.pmtiles'), OVERLAY_TILES_VERSION],
].filter(([dataset]) => ships(dataset)).map(([, path, version]) => [path, version]));
// Data lives in a STATE's folder -- maps/<state>/<file> -- and the generated
// index that names those states does not: it sits at maps/states.js, and it is
// a shell script, precached with app.js and served from the shell cache.
// Matching "/maps/" alone sent it to the data cache instead, where it had never
// been stored, so an offline reload could not find it and the app never got as
// far as running app.js. The folder in the middle is what distinguishes them.
const inStateFolder = (pathname) => /\/maps\/[^/]+\/.+$/.test(pathname);

// Markers live under a distinct pathname, never a query string: the archive
// lookups use ignoreSearch, so a `?stamp` variant of the same path could be
// returned AS the archive. Nothing ever fetches this path; it exists only as
// a Cache API key.
const archiveMarker = (path) => new Request(path.replace(DATA_ROOT, `${DATA_ROOT}/.stamp`));

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
  // worker, which served the state folder ignoring the query string and handed
  // back a stale graph. Answering here lets the page clear it and retry without
  // the rider having to reload a second time.
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
      // AFTER claiming: a stale 40+ MB archive must never delay the update
      // taking control. waitUntil keeps the worker alive while it refreshes;
      // failure keeps the old archive, and the next activation retries.
      .then(() => refreshStaleArchives())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin === location.origin && url.pathname.endsWith('.pmtiles')) {
    e.respondWith(pmtilesCacheFirst(e.request));
  } else if (url.origin === location.origin && url.pathname.endsWith('/graph2.bin.gz')) {
    // The one data file whose query string matters: it carries the graph's
    // build version, and ignoring it served a stale routing graph forever.
    e.respondWith(cacheFirst(DATA_CACHE, e.request, false));
  } else if (url.origin === location.origin && inStateFolder(url.pathname)) {
    // Any state's folder, not just the loaded one: a rider who switches back
    // should find the previous state's archives still cached rather than
    // downloading them again.
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

async function pmtilesCacheFirst(req) {
  // CACHE-FIRST, reversed from the original online-first. Field Network-tab
  // evidence: every online range round-trip to Pages measured 700-1100 ms,
  // and one zoom level crossing asks for DOZENS of ranges -- that was the
  // "laggy zoom" report. The complete archive stored at installation serves
  // the same range locally in about a millisecond. Ranges are answered from
  // bounded chunk entries (see pmtilesRangeResponse) -- the first version of
  // this memoized whole-archive Blobs on the claim that a Blob is a
  // disk-backed handle, and WebKit disagreed in the field with constant
  // zoom-time page kills. Freshness rides the activation stamp refresh
  // (ARCHIVE_VERSIONS), exactly as the offline copies always have; the
  // network remains the path for an archive the install never finished
  // (pmtilesRangeResponse fetches and stores the whole file on a miss).
  try {
    return await pmtilesRangeResponse(req);
  } catch (e) {
    return rangeSafeNetworkFallback(req);
  }
}

// The fallback must never hand PMTiles a 200 for a ranged request: Safari's
// HTTP cache is known to answer a Range fetch with the whole cached 200,
// and PMTiles hard-fails on it ("server does not support byte serving" --
// the field toast said all roads could not load). Bypass the HTTP cache,
// and if a 200 still comes back, synthesize the 206 by slicing it.
async function rangeSafeNetworkFallback(req) {
  const res = await fetch(req, { cache: 'no-store' });
  const range = req.headers.get('Range');
  if (!range || res.status === 206 || !res.ok) return res;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(range);
  if (!match) return res;
  const buf = await res.arrayBuffer();
  const start = Number(match[1]);
  const end = Math.min(match[2] ? Number(match[2]) : buf.byteLength - 1, buf.byteLength - 1);
  if (start > end || start >= buf.byteLength) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${buf.byteLength}` },
    });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
    },
  });
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
    // Record which stamp this archive copy corresponds to, so a later
    // activation can tell fresh from stale without re-downloading.
    if (path in ARCHIVE_VERSIONS) {
      await cache.put(archiveMarker(path), new Response(ARCHIVE_VERSIONS[path]));
    }
  }
}

// Refresh a big archive only when its content stamp changed. Keeps the old
// copy if the download fails, so offline never gets worse than it was.
async function refreshStaleArchives() {
  const cache = await caches.open(DATA_CACHE);
  for (const [path, version] of Object.entries(ARCHIVE_VERSIONS)) {
    const marker = await cache.match(archiveMarker(path));
    const cachedVersion = marker ? await marker.text() : null;
    if (cachedVersion === version) continue;
    try {
      const response = await fetch(new Request(path, { cache: 'reload' }));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await cache.put(path, response);
      await cache.put(archiveMarker(path), new Response(version));
      // The chunk entries mirror a specific archive copy; a refreshed copy
      // invalidates them and the next range request rebuilds from it.
      await purgePmtilesChunks(cache, new URL(path, location.href).pathname);
    } catch (error) {
      console.warn(`Could not refresh ${path}:`, error);
    }
  }
}

// Delete graph copies from an earlier build. Keyed caching alone would leave
// the previous 30 MB archive sitting in storage for good.
//
// Scoped to the loaded state's folder. Another state's graph is not stale --
// it is simply not the one in use, and deleting it would make switching back
// a fresh 46 MB download every time.
async function purgeStaleGraph() {
  const cache = await caches.open(DATA_CACHE);
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    if (!url.pathname.endsWith(`/${Region.dataRoot}/graph2.bin.gz`)) continue;
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

/* Ranges are served from fixed-size CHUNK cache entries, never from a
 * whole-archive Blob. The previous design memoized full.blob() per archive
 * "because a Blob is a disk-backed handle" -- on WebKit that assumption
 * failed in the field: zooming (the moment range requests flow) brought
 * constant page kills on iPhone and Mac Safari alike, with ~140 MB of
 * archive blobs pinned in the worker for its lifetime. Chunking bounds the
 * worst case per request to two 8 MB entries, transient and collectable.
 *
 * Chunk entries live under `<archive>__chunk-N` pathnames (own pathname, so
 * the archive's own ignoreSearch matches can never collide with them, same
 * pattern as ./data/.stamp/ markers), plus an `__chunkindex` entry recording
 * {size, chunkBytes, chunks}. They are built once per archive copy, one archive
 * at a time, and rebuilt after refreshStaleArchives replaces a stale copy. */
const PMTILES_CHUNK_BYTES = 8 * 1024 * 1024;
const chunkRequest = (pathname, i) => new Request(`${pathname}__chunk-${i}`);
const chunkIndexRequest = (pathname) => new Request(`${pathname}__chunkindex`);

async function purgePmtilesChunks(cache, pathname) {
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(`${pathname}__chunk`)) await cache.delete(request);
  }
}

// One chunking per archive prevents duplicate work for that archive. The global
// queue is equally important: the first map view asks basemap, roads, and
// overlays for ranges together. Letting all three materialize their cached
// 44/44/14 MB Blobs concurrently is enough for Safari to kill the page,
// especially if the route graph is also live.
const chunkingInFlight = new Map();
let chunkBuildQueue = Promise.resolve();
function ensurePmtilesChunks(cache, pathname, fullRequest) {
  let inFlight = chunkingInFlight.get(pathname);
  if (!inFlight) {
    inFlight = chunkBuildQueue.then(() => buildPmtilesChunks(cache, pathname, fullRequest));
    // A rejected archive must not poison the queue for every archive behind it.
    chunkBuildQueue = inFlight.catch(() => {});
    inFlight = inFlight
      .finally(() => chunkingInFlight.delete(pathname));
    chunkingInFlight.set(pathname, inFlight);
  }
  return inFlight;
}

async function buildPmtilesChunks(cache, pathname, fullRequest) {
  const cachedIndex = await cache.match(chunkIndexRequest(pathname));
  if (cachedIndex) return cachedIndex.json();
  const full = await cache.match(fullRequest, { ignoreVary: true, ignoreSearch: true });
  if (!full) throw new Error(`no cached archive to chunk for ${pathname}`);
  // blob() + slice, not body streaming: reading a cached response as a Blob
  // is the one primitive the v.583 era PROVED works on Safari, while cached
  // response streams are the flakier corner of WebKit's Cache API. Each
  // slice materializes at most one 8 MB piece.
  const blob = await full.blob();
  const size = blob.size;
  let written = 0;
  for (let offset = 0; offset < size; offset += PMTILES_CHUNK_BYTES) {
    const piece = await blob.slice(offset, Math.min(size, offset + PMTILES_CHUNK_BYTES)).arrayBuffer();
    await cache.put(chunkRequest(pathname, written), new Response(piece));
    written++;
  }
  const meta = { size, chunkBytes: PMTILES_CHUNK_BYTES, chunks: written };
  await cache.put(chunkIndexRequest(pathname), new Response(JSON.stringify(meta)));
  return meta;
}

async function pmtilesRangeResponse(req) {
  const cache = await caches.open(DATA_CACHE);
  const fullRequest = new Request(req.url, { method: 'GET' });
  let full = await cache.match(fullRequest, { ignoreVary: true, ignoreSearch: true });
  if (!full) {
    const fetched = await fetch(fullRequest);
    if (!fetched.ok) return fetched;
    await cache.put(fullRequest, fetched.clone());
    full = fetched;
  }
  const range = req.headers.get('Range');
  if (!range) return full;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(range);
  if (!match) return new Response(null, { status: 416 });
  const pathname = new URL(req.url).pathname;
  const meta = await ensurePmtilesChunks(cache, pathname, fullRequest);
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : meta.size - 1;
  const end = Math.min(requestedEnd, meta.size - 1);
  if (start > end || start >= meta.size) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${meta.size}` },
    });
  }
  const firstChunk = Math.floor(start / meta.chunkBytes);
  const lastChunk = Math.floor(end / meta.chunkBytes);
  const parts = [];
  for (let i = firstChunk; i <= lastChunk; i++) {
    const entry = await cache.match(chunkRequest(pathname, i));
    if (!entry) {
      // A killed worker can leave a torn chunk set; purge so the NEXT
      // request rebuilds cleanly, and let this one fall back to network.
      await purgePmtilesChunks(cache, pathname);
      throw new Error(`missing chunk ${i} for ${pathname}`);
    }
    const blob = await entry.blob();
    const chunkStart = i * meta.chunkBytes;
    parts.push(blob.slice(Math.max(0, start - chunkStart),
      Math.min(blob.size, end + 1 - chunkStart)));
  }
  const body = parts.length === 1 ? parts[0] : new Blob(parts);
  return new Response(body, {
    status: 206,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${meta.size}`,
      'Content-Type': full.headers.get('Content-Type') || 'application/octet-stream',
    },
  });
}
