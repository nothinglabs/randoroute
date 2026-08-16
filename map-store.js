/* Map packs: install, list, and remove downloadable state map data.
 *
 * A MAP STORE is any HTTPS directory serving the `index.json` the registry
 * builder emits (storeFormat 1) beside the state folders it describes. The
 * app's own origin is the default store (`maps/`); a rider can add others.
 *
 * Installing a state is an ACQUISITION, not a new storage system: every file
 * is fetched from the store and stored in the same offline data cache the
 * service worker serves, under the LOGICAL same-origin path the app already
 * requests (`maps/<id>/<file>`). Serving, offline behavior, pmtiles range
 * reads, and stamp-based refresh all keep working unchanged, because nothing
 * downstream can tell an installed state from a bundled one. The installed
 * states themselves are recorded in localStorage; region.js merges them into
 * the bundled index at startup, so a reload lands on them like any other.
 *
 * Loaded as a classic script by index.html after maps/states.js and BEFORE
 * region.js (which asks it for installed states). Not loaded by sw.js -- the
 * worker only ever serves what this file put in the cache. In Node the IIFE's
 * `this` is module.exports, so tests can require() it.
 */
(function (root) {
  const INSTALLED_KEY = 'jra-installed-states-1';
  const STORES_KEY = 'jra-map-stores-1';
  // Everything the store index promises about a state, mirrored from the
  // registry builder's contract. Unknown keys are rejected the same way the
  // builder rejects them in region.json: silently ignoring one is how a
  // malformed store "works" until the first ride.
  const REQUIRED = ['id', 'name', 'status', 'bounds', 'defaultCenter', 'defaultZoom', 'datasets'];
  const KNOWN = new Set(['id', 'name', 'status', 'readiness', 'summary', 'bounds',
    'defaultCenter', 'defaultZoom', 'stressAgency', 'restrictionAgency', 'speedAgency',
    'facilitySourceName', 'stressLayerName', 'restrictionLayerName',
    'interstateRoutePrefixes', 'stateRoutePrefixes', 'facilityLevels', 'sourceCounts', 'routeDirectionSuffixes',
    'datasets', 'versions', 'attribution', 'files']);
  const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

  function readJson(key) {
    try {
      const raw = root.localStorage ? root.localStorage.getItem(key) : null;
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }
  function writeJson(key, value) {
    root.localStorage.setItem(key, JSON.stringify(value));
  }

  function validateStateEntry(state) {
    if (!state || typeof state !== 'object') throw new Error('a state entry is not an object');
    for (const key of REQUIRED) {
      if (state[key] === undefined) throw new Error(`state entry omits "${key}"`);
    }
    for (const key of Object.keys(state)) {
      if (!KNOWN.has(key)) throw new Error(`state "${state.id}" has unknown key "${key}"`);
    }
    if (!SAFE_ID.test(String(state.id))) throw new Error(`unsafe state id "${state.id}"`);
    if (!Array.isArray(state.files) || !state.files.length) {
      throw new Error(`state "${state.id}" lists no files`);
    }
    for (const file of state.files) {
      if (!file || !SAFE_FILE.test(String(file.path))) {
        throw new Error(`state "${state.id}" has an unsafe file path "${file && file.path}"`);
      }
      if (!Number.isFinite(file.bytes) || file.bytes < 0) {
        throw new Error(`state "${state.id}" file "${file.path}" has no byte size`);
      }
    }
    return state;
  }

  const MapStore = {
    /* ----------------------------------------------------- installed packs */
    installedStates: () => readJson(INSTALLED_KEY),
    installedRegionConfigs: () => readJson(INSTALLED_KEY).map((entry) => entry.state),
    installedEntry: (id) => readJson(INSTALLED_KEY).find((entry) => entry.state.id === id) || null,
    stateBytes: (state) => (state.files || []).reduce((sum, file) => sum + (file.bytes || 0), 0),

    // Whether a state's data can be used right now without a download.
    availability(id) {
      const bundled = root.MAP_STATES_BUNDLED !== false
        && (root.MAP_STATES || []).some((state) => state.id === id);
      if (bundled) return 'bundled';
      if (MapStore.installedEntry(id)) return 'installed';
      return 'remote';
    },

    /* ------------------------------------------------------------- stores */
    customStores: () => readJson(STORES_KEY),
    addCustomStore(url) {
      const normalized = MapStore.normalizeStoreUrl(url);
      const stores = readJson(STORES_KEY).filter((store) => store.url !== normalized);
      stores.push({ url: normalized });
      writeJson(STORES_KEY, stores);
      return normalized;
    },
    removeCustomStore(url) {
      writeJson(STORES_KEY, readJson(STORES_KEY).filter((store) => store.url !== url));
    },

    normalizeStoreUrl(url) {
      let text = String(url || '').trim();
      if (!text) throw new Error('Enter a map store address.');
      if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
      if (text.toLowerCase().endsWith('/index.json')) text = text.slice(0, -'index.json'.length);
      if (!text.endsWith('/')) text += '/';
      const parsed = new URL(text);
      const local = ['localhost', '127.0.0.1'].includes(parsed.hostname);
      if (parsed.protocol !== 'https:' && !local) {
        throw new Error('A map store must be served over HTTPS.');
      }
      return parsed.href;
    },

    // Fetch and strictly validate a store's index. A malformed index is an
    // error message, never a partial listing.
    async fetchIndex(storeUrl) {
      const base = storeUrl === 'maps/' ? storeUrl : MapStore.normalizeStoreUrl(storeUrl);
      const response = await fetch(`${base}index.json`, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`The store answered HTTP ${response.status}.`);
      let index;
      try {
        index = await response.json();
      } catch (e) { throw new Error('The store index is not valid JSON.'); }
      if (!index || index.storeFormat !== 1) {
        throw new Error('The store index is not a recognized format.');
      }
      if (!Array.isArray(index.states) || !index.states.length) {
        throw new Error('The store index lists no states.');
      }
      return { storeUrl: base, states: index.states.map(validateStateEntry) };
    },

    /* ------------------------------------------------------------ install */
    // Download every file of a state from its store into the offline data
    // cache, under the logical path the app requests. All-or-nothing: a
    // failure removes whatever partial data landed, so a state is either
    // fully installed or absent.
    async installState(storeUrl, state, onProgress = () => {}) {
      validateStateEntry(state);
      if (!root.caches) throw new Error('This browser cannot store offline maps.');
      const cache = await root.caches.open(root.DATA_CACHE_NAME);
      const total = MapStore.stateBytes(state);
      let done = 0;
      try {
        for (const file of state.files) {
          const sourceUrl = new URL(`${state.id}/${file.path}`, new URL(storeUrl, location.href)).href;
          const response = await fetch(sourceUrl, { cache: 'no-store' });
          if (response.type === 'opaque') {
            throw new Error('The store does not allow cross-origin reads (CORS).');
          }
          if (!response.ok) throw new Error(`${file.path}: HTTP ${response.status}`);
          await cache.put(logicalRequest(state, file), countedResponse(response, (bytes) => {
            done += bytes;
            onProgress({ file: file.path, done: Math.min(done, total), total });
          }));
          await writeArchiveStamp(cache, state, file);
        }
      } catch (error) {
        await MapStore.removeStateData(state.id);
        throw error;
      }
      const installed = readJson(INSTALLED_KEY).filter((entry) => entry.state.id !== state.id);
      installed.push({ state, storeUrl, installedAt: Date.now() });
      writeJson(INSTALLED_KEY, installed);
      onProgress({ file: null, done: total, total });
    },

    // Drop a state's offline data: archives, graph (any query string), stamp
    // markers, and the pmtiles chunk entries derived from the archives.
    async removeStateData(id) {
      if (!root.caches) return;
      const cache = await root.caches.open(root.DATA_CACHE_NAME);
      const prefix = new URL(`maps/${id}/`, location.href).pathname;
      for (const request of await cache.keys()) {
        const pathname = new URL(request.url).pathname;
        if (pathname === prefix || pathname.startsWith(prefix)
          || pathname.startsWith(`${prefix.slice(0, -1)}__chunk`)) {
          await cache.delete(request);
        }
      }
    },
    async removeState(id) {
      await MapStore.removeStateData(id);
      writeJson(INSTALLED_KEY, readJson(INSTALLED_KEY).filter((entry) => entry.state.id !== id));
    },
  };

  // The cache key each file is served back from. The graph is the one file
  // whose query string is part of its identity (build-version.js builds it;
  // the service worker matches it with ignoreSearch:false), so the installed
  // copy must be keyed exactly as the app will ask for it.
  function logicalRequest(state, file) {
    const logical = `maps/${state.id}/${file.path}`;
    if (file.dataset !== 'graph') return new Request(logical);
    const graphVersion = state.versions && state.versions.graph;
    if (!graphVersion) throw new Error(`state "${state.id}" ships a graph with no graph version stamp`);
    if (!root.GRAPH_FORMAT_VERSION) throw new Error('build-version.js has not been loaded');
    return new Request(`${logical}?format=${root.GRAPH_FORMAT_VERSION}&gv=${graphVersion}`);
  }

  // Mirror the service worker's archive stamp markers (maps/<id>/.stamp/<file>)
  // so its activation-time freshness pass reads an installed archive exactly
  // like one it precached itself.
  async function writeArchiveStamp(cache, state, file) {
    const version = state.versions && state.versions[file.dataset];
    if (!version || !['roads', 'basemap', 'overlays'].includes(file.dataset)) return;
    await cache.put(new Request(`maps/${state.id}/.stamp/${file.path}`), new Response(version));
  }

  // Stream a response into the cache while counting bytes for progress. The
  // body passes through chunk by chunk -- a 150 MB archive never sits in
  // memory whole.
  function countedResponse(response, onBytes) {
    if (!response.body || typeof ReadableStream === 'undefined') return response;
    const reader = response.body.getReader();
    const headers = new Headers();
    for (const name of ['content-type', 'content-length', 'etag', 'last-modified']) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        onBytes(value.byteLength);
        controller.enqueue(value);
      },
      cancel(reason) { return reader.cancel(reason); },
    }), { status: 200, headers });
  }

  root.MapStore = MapStore;
}(typeof self !== 'undefined' ? self : this));
