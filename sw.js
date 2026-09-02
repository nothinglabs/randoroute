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
// Match the numeric release suffix in APP_VERSION. Release .781 changed the
// app shell but left this at v780: version.json announced the release while
// returning devices saw byte-identical worker code and had nothing to install.
// v932 is the same trap from the other side: a graph rebuild published new
// acquisition ids and regenerated maps/states.js and maps/index.json -- both
// SHELL -- without touching this line, so returning devices kept the old
// catalogue. The routing guard read the published data and refused to route,
// while the Maps screen compared installs against the stale shell catalogue
// and offered no update at all. A DATA release that regenerates either file
// is a shell change.
const VERSION = 'v975';
const SHELL_CACHE = `shell-${VERSION}`;
// Keep the large offline dataset across ordinary UI-only app releases.
//
// The name itself lives in build-version.js (DATA_CACHE_NAME), because
// map-store.js writes downloaded states into this same cache. It became v9
// when every data file moved from ./data/ into ./maps/<state>/: a cache is
// keyed by URL, so the v8 entries could never be hit again, and leaving them
// would strand about 150 MB of unreachable archives on every installed PWA
// forever.
const DATA_CACHE = DATA_CACHE_NAME;

const SHELL = [
  './',
  './index.html',
  './route-details.html',
  './app.js',
  './palette.js',
  './maps/states.js',
  './maps/index.json',
  './maps/national-states.geojson',
  './map-store.js',
  './region.js',
  './build-version.js',
  './multi-state-routing.js',
  './partition-runtime.js',
  './partition-loader-worker.js',
  './multi-state-route-coordinator.js',
  './safety-model.js',
  './basemap-style.js',
  './route-details.js?v=466',
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
  './onboarding/tour-welcome.jpg',
  './onboarding/tour-plan.jpg',
  './onboarding/tour-routes.jpg',
  './onboarding/tour-fast.jpg',
  './onboarding/tour-safer.jpg',
  './onboarding/tour-road.jpg',
  './onboarding/tour-navigate.jpg',
];

// GRAPH_DATA_VERSION and GRAPH_URL come from build-version.js, which
// index.html loads too. Bump them there.

// Only what the loaded state actually ships. A state under construction may
// carry a place index and nothing else, and precaching a graph that is not
// there fails the whole install -- the new worker never reaches waiting and
// the app reports an update it can never apply.
const ships = (dataset) => !!Region.datasets[dataset];
// A slim web preview publishes state files as a map store on this origin but
// declares none bundled. The worker does not have localStorage/MapStore, so it
// must use the generated bundle flags rather than Region.datasets; otherwise
// first registration would silently precache the fallback state's complete
// pack before the rider confirms a download.
const BUNDLED_STATE_IDS = Array.isArray(self.MAP_STATES_BUNDLED_IDS)
  ? self.MAP_STATES_BUNDLED_IDS : (self.MAP_STATES || []).map((state) => state.id);
const ACTIVE_STATE_DATA_BUNDLED = self.MAP_STATES_BUNDLED !== false
  && BUNDLED_STATE_IDS.includes(Region.id);
const DATA = ACTIVE_STATE_DATA_BUNDLED ? [
  ...[
    ['ferries', 'ferries.geojson.gz'],
    ['bikeroutes', 'bikeroutes.geojson.gz'],
    ['restrictions', 'bike_restrictions.geojson.gz'],
    ['closures', 'route_closures.geojson.gz'],
    ['roads', 'roads.pmtiles'],
    ['regional', 'regional.pmtiles'],
    ['basemap', 'basemap.pmtiles'],
    ['overlays', 'overlays.pmtiles'],
  ].filter(([dataset]) => ships(dataset)).map(([, file]) => stateFile(file)),
  ...(ships('graph') ? [`./${GRAPH_URL}`] : []),
  ...(ships('places') ? [stateFile('places.json')] : []),
] : [];
// Small, release-generated overlays can change without changing the 100+ MB
// statewide archives. Refresh ALL of them on every activation while retaining
// the big archives across UI releases -- "check for updates" must really
// deliver everything new, and these together are a few MB.
const ALWAYS_REFRESH_DATA = new Set(DATA.filter((path) => [
  'ferries.geojson.gz', 'bikeroutes.geojson.gz', 'bike_restrictions.geojson.gz',
  'route_closures.geojson.gz', 'places.json',
].some((file) => path.endsWith(`/${file}`))));

// The big archives refresh only when their content stamp (the state's
// region.json) changes. The stamp of the cached copy is stored as a marker
// entry beside the archive; no marker means an install that predates stamping,
// which counts as stale -- one refresh, then it is stamped like everything
// else.
const ARCHIVE_VERSIONS = ACTIVE_STATE_DATA_BUNDLED ? Object.fromEntries([
  ['roads', stateFile('roads.pmtiles'), ROADS_TILES_VERSION],
  ['regional', stateFile('regional.pmtiles'), REGIONAL_TILES_VERSION],
  ['basemap', stateFile('basemap.pmtiles'), BASEMAP_TILES_VERSION],
  ['overlays', stateFile('overlays.pmtiles'), OVERLAY_TILES_VERSION],
].filter(([dataset]) => ships(dataset)).map(([, path, version]) => [path, version])) : {};
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
      // A returning installation already has the large archives named by its
      // previous manifest, but a release can add a NEW required dataset. Do
      // not let that shell reach waiting/activation until every missing data
      // entry is resident: otherwise the new style can take control offline
      // while the archive it newly depends on does not exist. Existing files
      // are left untouched here; activation's stamp pass owns refreshes.
      updatingExistingApp ? precacheMissingData() : precacheData(),
    ])
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
  // The page verified an archive THROUGH the range-serving path and found it
  // disagreeing with the installed manifest: whatever stale copy or chunk set
  // is answering, drop every entry for that pathname so the next read
  // refetches one clean copy. Replies on the provided port so the page can
  // reload only after the purge landed.
  if (e.data && e.data.type === 'PURGE_PMTILES_ARCHIVE' && e.data.pathname) {
    const pathname = String(e.data.pathname);
    e.waitUntil((async () => {
      const cache = await caches.open(DATA_CACHE);
      await purgePmtilesChunks(cache, pathname);
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname === pathname) await cache.delete(request);
      }
      e.ports[0]?.postMessage({ ok: true });
    })());
  }
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
  // MapStore's install staging/backup caches carry a Date.now() nonce. A
  // fresh one belongs to a download that may be running right now — deleting
  // it mid-install destroys the backup that makes rollback safe. A stale one
  // is an orphan from a killed page and is reclaimed here.
  const liveInstallCache = (name) => {
    const match = /-(?:install|backup)-(\d+)-/.exec(name);
    return match && Date.now() - Number(match[1]) < 24 * 60 * 60 * 1000;
  };
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => !keep.includes(k) && !liveInstallCache(k))
        .map((k) => caches.delete(k))))
      .then(() => purgeStaleGraph())
      .then(() => self.clients.claim())
  );
  // Deliberately OUTSIDE waitUntil, all of it. The browser queues every page
  // fetch until activation's extensions settle, so any network work in the
  // chain above lets a flaky connection hold the whole installed app
  // hostage: the first PWA launch after an update showed nothing at all
  // while refreshReleaseData's fetches hung (field, 2026-08-25). Claiming
  // after local cache work only, the ordering the archive comment always
  // intended, is not enough — waitUntil itself is the gate pages wait on.
  // The refreshes run beside activation instead. The trade: the browser may
  // stop an idle worker mid-refresh; a failed put keeps the old copy, the
  // stamps make the pass idempotent, and the next activation retries.
  refreshReleaseData().then(() => refreshStaleArchives()).catch(() => { /* keep old copies */ });
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin === location.origin && url.searchParams.has('jra-store-install')) {
    // MapStore owns an atomic staging cache. Let its marked source fetch reach
    // the network directly: cacheFirst would otherwise write an unverified or
    // truncated response into the live data cache before MapStore checks it.
    e.respondWith(fetch(e.request, { cache: 'no-store' }));
  } else if (url.origin === location.origin && url.pathname.endsWith('.pmtiles')) {
    e.respondWith(pmtilesCacheFirst(e.request));
  } else if (url.origin === location.origin && url.pathname.endsWith('/graph2.bin.gz')) {
    // The one data file whose query string matters: it carries the graph's
    // build version, and ignoring it served a stale routing graph forever.
    e.respondWith(cacheFirst(DATA_CACHE, e.request, false));
  } else if (url.origin === location.origin
      && url.pathname.endsWith('/maps/partition-catalogue.json')) {
    // Installed routing acquisitions key the shared catalogue by its exact
    // content hash in the query string. It belongs with state data and must
    // remain available offline; ignoring search could pair old partitions
    // with a newer topology manifest.
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
    const response = await pmtilesRangeResponse(req);
    // A ranged PMTiles read is only usable as 206. In particular, do not pass
    // through a 416 derived from a truncated cached archive: FetchSource treats
    // that as an ETag mismatch and retries the same bad cache entry forever.
    if (req.headers.get('Range') && response.status !== 206) {
      return rangeSafeNetworkFallback(req);
    }
    return response;
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
      'Content-Length': String(end - start + 1),
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

// Updating workers used to skip DATA entirely on the assumption that the
// existing worker had already cached the complete set. That assumption stops
// being true when a release introduces another declared file. Populate only
// absent logical entries during install, and stamp only bytes fetched by this
// pass; stamping an existing archive without refreshing it would falsely mark
// an older copy current.
async function precacheMissingData() {
  const cache = await caches.open(DATA_CACHE);
  for (const path of DATA) {
    const request = new Request(path, { cache: 'reload' });
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) continue;
    await cache.add(request);
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
  // With no bundled state data the fallback Region's graph version describes
  // the deployment, not what the rider installed from a store: purging by it
  // would delete an installed pack's graph on every redeploy while MapStore
  // still reports the state installed.
  if (!ACTIVE_STATE_DATA_BUNDLED) return;
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
const validatedChunkIndexes = new Set();

async function purgePmtilesChunks(cache, pathname) {
  validatedChunkIndexes.delete(pathname);
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
function ensurePmtilesChunks(cache, pathname, fullRequest, archiveVersion) {
  let inFlight = chunkingInFlight.get(pathname);
  if (!inFlight) {
    inFlight = chunkBuildQueue.then(() =>
      buildPmtilesChunks(cache, pathname, fullRequest, archiveVersion));
    // A rejected archive must not poison the queue for every archive behind it.
    chunkBuildQueue = inFlight.catch(() => {});
    inFlight = inFlight
      .finally(() => chunkingInFlight.delete(pathname));
    chunkingInFlight.set(pathname, inFlight);
  }
  return inFlight;
}

// Missing archives are fetched once even when MapLibre asks several sources
// and tiles for ranges together. Without this guard a damaged cached archive
// could be deleted correctly and immediately replaced by half a dozen parallel
// 40+ MB downloads.
const fullArchiveFetchInFlight = new Map();
// A whole-archive network download is tens of megabytes and minutes on a
// phone — it must never be silent (field, 2026-08-27: an updated PWA sat on
// a blank map for two minutes with no explanation while archives restored).
// Every open page hears when one starts and when it settles.
async function notifyArchiveRefetch(pathname, phase, bytes, loaded) {
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({ type: 'map-archive-refetch', pathname, phase,
        bytes: Number.isFinite(bytes) ? bytes : null,
        loaded: Number.isFinite(loaded) ? loaded : null });
    }
  } catch (error) { /* nonfatal: the download still proceeds */ }
}

// Store the download through a counting stream so the page's chip can tick
// (field, 2026-08-27: a 24 MB restore showed a number that never moved).
// The re-wrapped Response drops the encoding/length headers — the body here
// is already decoded, and the chunker measures the archive from its actual
// bytes and the PMTiles header, never from these headers.
function countedCachePut(cache, fullRequest, fetched, pathname, total) {
  if (!fetched.body) return cache.put(fullRequest, fetched.clone());
  let loaded = 0, lastSent = 0;
  const reader = fetched.body.getReader();
  const headers = new Headers(fetched.headers);
  headers.delete('Content-Encoding');
  headers.delete('Content-Length');
  const counted = new Response(new ReadableStream({
    pull(controller) {
      return reader.read().then(({ done, value }) => {
        if (done) { controller.close(); return; }
        loaded += value.byteLength;
        if (loaded - lastSent >= 1500000) {
          lastSent = loaded;
          notifyArchiveRefetch(pathname, 'downloading', total, loaded);
        }
        controller.enqueue(value);
      });
    },
    cancel(reason) { return reader.cancel(reason); },
  }), { status: 200, statusText: fetched.statusText, headers });
  return cache.put(fullRequest, counted);
}

function fetchAndCacheFullArchive(cache, pathname, fullRequest) {
  let inFlight = fullArchiveFetchInFlight.get(pathname);
  if (!inFlight) {
    inFlight = (async () => {
      // WebKit's HTTP cache can conflate a prior Range response with this
      // range-free request. Bypass it, and never store a 206 under the key that
      // means "complete archive" in Cache API.
      notifyArchiveRefetch(pathname, 'start', null);
      let ok = false;
      try {
        const fetched = await fetch(fullRequest, { cache: 'no-store' });
        if (fetched.status !== 200 || fetched.headers.get('Content-Range')) {
          throw new Error(`full archive fetch returned HTTP ${fetched.status} for ${pathname}`);
        }
        const total = Number(fetched.headers.get('Content-Length'));
        notifyArchiveRefetch(pathname, 'downloading', total, 0);
        await countedCachePut(cache, fullRequest, fetched, pathname, total);
        const stored = await cache.match(fullRequest, {
          ignoreVary: true, ignoreSearch: true,
        });
        if (!stored) throw new Error(`could not store complete archive ${pathname}`);
        ok = true;
        return stored;
      } finally {
        notifyArchiveRefetch(pathname, ok ? 'done' : 'failed', null);
      }
    })().finally(() => fullArchiveFetchInFlight.delete(pathname));
    fullArchiveFetchInFlight.set(pathname, inFlight);
  }
  return inFlight;
}

function pmtilesHeaderUint64(view, offset) {
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 2 ** 32;
}

async function declaredPmtilesBytes(blob) {
  if (blob.size < 127) return null;
  const prefix = new Uint8Array(await blob.slice(0, 127).arrayBuffer());
  const magic = String.fromCharCode(...prefix.slice(0, 7));
  if (magic !== 'PMTiles') return null;
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  return pmtilesHeaderUint64(view, 56) + pmtilesHeaderUint64(view, 64);
}

async function buildPmtilesChunks(cache, pathname, fullRequest, archiveVersion) {
  const cachedIndex = await cache.match(chunkIndexRequest(pathname));
  let full = await cache.match(fullRequest, { ignoreVary: true, ignoreSearch: true });
  if (cachedIndex) {
    const meta = await cachedIndex.json();
    // A replaced archive arrives under a new content-version (?v= on every
    // range request). Chunks mirror one specific copy: an index whose
    // recorded version does not match the request's -- including an index
    // from before versions were recorded -- is the .810 field failure, where
    // a validated store update installed the corrected archive while every
    // render kept reading the previous copy out of these entries. Rebuild
    // from the cached full archive (the update already stored it); the
    // network is only needed if that entry is missing.
    if (archiveVersion != null && meta.v !== archiveVersion) {
      await purgePmtilesChunks(cache, pathname);
      if (!full) full = await fetchAndCacheFullArchive(cache, pathname, fullRequest);
    } else {
      return validatedChunkMeta(cache, pathname, fullRequest, meta, full, archiveVersion);
    }
  }
  return chunkArchive(cache, pathname, fullRequest, full, archiveVersion);
}

async function validatedChunkMeta(cache, pathname, fullRequest, meta, full, archiveVersion) {
  if (validatedChunkIndexes.has(pathname)) return meta;
  // A previous worker may have completed a chunk index around a truncated
  // HTTP 200. Validate that persisted metadata once per worker lifetime;
  // otherwise every range beyond the false end of file becomes a 416 while
  // the apparently complete chunk set prevents build-time validation. Read
  // only chunk zero (at most 8 MB), not the 40+ MB full response: it contains
  // the same PMTiles header without recreating the WebKit memory spike this
  // chunk cache exists to avoid.
  const firstChunk = await cache.match(chunkRequest(pathname, 0));
  const firstBlob = firstChunk ? await firstChunk.blob() : null;
  const declaredSize = firstBlob ? await declaredPmtilesBytes(firstBlob) : null;
  const fullLengthHeader = full ? full.headers.get('Content-Length') : null;
  const fullHeaderBytes = fullLengthHeader ? Number(fullLengthHeader) : null;
  if (declaredSize === meta.size
      && (!Number.isFinite(fullHeaderBytes) || fullHeaderBytes === meta.size)) {
    validatedChunkIndexes.add(pathname);
    return meta;
  }
  if (full) {
    await cache.delete(fullRequest, { ignoreVary: true, ignoreSearch: true });
  }
  await purgePmtilesChunks(cache, pathname);
  full = await fetchAndCacheFullArchive(cache, pathname, fullRequest);
  return chunkArchive(cache, pathname, fullRequest, full, archiveVersion);
}

async function chunkArchive(cache, pathname, fullRequest, full, archiveVersion) {
  if (!full) throw new Error(`no cached archive to chunk for ${pathname}`);
  // blob() + slice, not body streaming: reading a cached response as a Blob
  // is the one primitive the v.583 era PROVED works on Safari, while cached
  // response streams are the flakier corner of WebKit's Cache API. Each
  // slice materializes at most one 8 MB piece.
  let blob = await full.blob();
  let size = blob.size;
  // The PMTiles header declares where its final tile-data byte lands. A cached
  // HTTP 200 containing only an earlier byte range can therefore be detected
  // without hashing or materializing the whole archive. Remove that poisoned
  // "full" entry and replace it with one coherent copy.
  const declaredSize = await declaredPmtilesBytes(blob);
  if (declaredSize !== size) {
    await cache.delete(fullRequest, { ignoreVary: true, ignoreSearch: true });
    await purgePmtilesChunks(cache, pathname);
    full = await fetchAndCacheFullArchive(cache, pathname, fullRequest);
    blob = await full.blob();
    size = blob.size;
    const repairedSize = await declaredPmtilesBytes(blob);
    if (repairedSize !== size) {
      await cache.delete(fullRequest, { ignoreVary: true, ignoreSearch: true });
      throw new Error(`archive repair failed: ${pathname} has ${size} of ${repairedSize || 0} bytes`);
    }
  }
  let written = 0;
  for (let offset = 0; offset < size; offset += PMTILES_CHUNK_BYTES) {
    const piece = await blob.slice(offset, Math.min(size, offset + PMTILES_CHUNK_BYTES)).arrayBuffer();
    await cache.put(chunkRequest(pathname, written), new Response(piece));
    written++;
  }
  // The recorded version ties these chunks to the archive copy they slice; a
  // later request under a different ?v= rebuilds instead of serving them.
  const meta = { size, chunkBytes: PMTILES_CHUNK_BYTES, chunks: written,
    v: archiveVersion == null ? null : archiveVersion };
  await cache.put(chunkIndexRequest(pathname), new Response(JSON.stringify(meta)));
  validatedChunkIndexes.add(pathname);
  return meta;
}

async function pmtilesRangeResponse(req) {
  const cache = await caches.open(DATA_CACHE);
  const fullRequest = new Request(req.url, { method: 'GET' });
  const pathname = new URL(req.url).pathname;
  let full = await cache.match(fullRequest, { ignoreVary: true, ignoreSearch: true });
  if (full && (full.status !== 200 || full.headers.get('Content-Range'))) {
    await cache.delete(fullRequest, { ignoreVary: true, ignoreSearch: true });
    await purgePmtilesChunks(cache, pathname);
    full = null;
  }
  if (!full) {
    full = await fetchAndCacheFullArchive(cache, pathname, fullRequest);
  }
  const range = req.headers.get('Range');
  if (!range) return full;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(range);
  if (!match) return new Response(null, { status: 416 });
  // The archive's content-version rides the request as ?v=. Chunk entries
  // mirror ONE archive copy; the version ties them to it (see
  // buildPmtilesChunks).
  const archiveVersion = new URL(req.url).searchParams.get('v');
  const meta = await ensurePmtilesChunks(cache, pathname, fullRequest, archiveVersion);
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
    let blob = null;
    if (entry) {
      try { blob = await entry.blob(); } catch (error) { blob = null; }
    }
    if (!blob) {
      // A killed worker can tear a chunk set, and storage that lived through
      // a crash can hold an entry whose body no longer reads. The COMPLETE
      // archive is still cached either way: answer this range from a bounded
      // slice of it (at most the range itself, tile-sized), and purge the
      // chunk set so the next request rebuilds it. The old behaviour threw
      // here, which put the rider one flaky network fallback away from a
      // permanently missing map tile — MapLibre never re-asks for a tile it
      // was handed an error for.
      await purgePmtilesChunks(cache, pathname);
      const whole = await full.blob();
      if (whole.size !== meta.size) {
        throw new Error(`archive changed size under ${pathname}`);
      }
      return new Response(whole.slice(start, end + 1), {
        status: 206,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${meta.size}`,
          'Content-Length': String(end - start + 1),
          'Content-Type': full.headers.get('Content-Type') || 'application/octet-stream',
        },
      });
    }
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
      'Content-Length': String(end - start + 1),
      'Content-Type': full.headers.get('Content-Type') || 'application/octet-stream',
    },
  });
}
