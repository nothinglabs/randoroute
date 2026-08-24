/* Map packs: install, list, and remove downloadable state map data.
 *
 * A MAP STORE is any HTTPS directory serving the `index.json` the registry
 * builder emits (storeFormat 2, with version 1 accepted for compatibility)
 * beside the state folders it describes. The
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
  const ACQUISITION_FORMAT = 1;
  // Everything the store index promises about a state, mirrored from the
  // registry builder's contract. Unknown keys are rejected the same way the
  // builder rejects them in region.json: silently ignoring one is how a
  // malformed store "works" until the first ride.
  const REQUIRED = ['id', 'name', 'status', 'bounds', 'defaultCenter', 'defaultZoom', 'datasets'];
  const KNOWN = new Set(['id', 'name', 'status', 'readiness', 'summary', 'bounds',
    'defaultCenter', 'defaultZoom', 'stressAgency', 'restrictionAgency', 'speedAgency',
    'facilitySourceName', 'stressLayerName', 'restrictionLayerName',
    'interstateRoutePrefixes', 'stateRoutePrefixes', 'facilityLevels', 'sourceCounts', 'routeDirectionSuffixes',
    // graphRawBytes: the state's full-graph raw size, the fact the app uses
    // to decide monolithic-versus-partition routing for an oversized home
    // state (California-class). Its absence in this allowlist made .805's
    // store reject every real state entry at install time.
    'datasets', 'versions', 'attribution', 'files', 'acquisitions', 'placeSearch',
    'graphRawBytes']);
  const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
  const SAFE_ACQUISITION_ID = /^[a-z0-9][a-z0-9._-]{0,191}$/;
  const SAFE_PARTITION_ID = /^[a-z0-9][a-z0-9._/-]{0,191}$/;
  const SHA256 = /^[a-f0-9]{64}$/;
  const PLACE_SEARCH_ID = /^[a-z0-9][a-z0-9-]{0,63}:[a-f0-9]{20}$/;
  const MAP_FILE_KEYS = new Set(['dataset', 'path', 'bytes']);
  const ROUTING_FILE_KEYS = new Set(['dataset', 'path', 'bytes', 'rawBytes', 'sha256',
    'partitionId', 'stateId', 'sourceGraphVersion']);

  function assertKnownKeys(value, known, label) {
    for (const key of Object.keys(value || {})) {
      if (!known.has(key)) throw new Error(`${label} has unknown key "${key}"`);
    }
  }

  function validateMapFile(file, stateId) {
    if (!file || typeof file !== 'object') throw new Error(`state "${stateId}" has an invalid file`);
    assertKnownKeys(file, MAP_FILE_KEYS, `state "${stateId}" file`);
    if (!SAFE_FILE.test(String(file.path))) {
      throw new Error(`state "${stateId}" has an unsafe file path "${file.path}"`);
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`state "${stateId}" file "${file.path}" has no byte size`);
    }
    return file;
  }

  function validateAcquisition(unit, stateId) {
    if (!unit || typeof unit !== 'object') throw new Error(`state "${stateId}" has an invalid acquisition`);
    const common = new Set(['acquisitionFormat', 'id', 'kind', 'stateIds', 'totalBytes', 'files']);
    const routing = new Set([...common, 'compatibility', 'sourceStateDependencies', 'catalogue']);
    assertKnownKeys(unit, unit.kind === 'routing-partitions' ? routing : common,
      `acquisition "${unit.id || ''}"`);
    if (unit.acquisitionFormat !== ACQUISITION_FORMAT) {
      throw new Error(`acquisition "${unit.id || ''}" has an unsupported format`);
    }
    if (!SAFE_ACQUISITION_ID.test(String(unit.id || ''))) {
      throw new Error(`state "${stateId}" has an unsafe acquisition id`);
    }
    if (!['state-map', 'routing-partitions'].includes(unit.kind)) {
      throw new Error(`acquisition "${unit.id}" has an unknown kind`);
    }
    if (!Array.isArray(unit.stateIds) || unit.stateIds.length !== 1
        || unit.stateIds[0] !== stateId) {
      throw new Error(`acquisition "${unit.id}" does not belong exactly to state "${stateId}"`);
    }
    if (!Number.isSafeInteger(unit.totalBytes) || unit.totalBytes < 0 || !Array.isArray(unit.files)) {
      throw new Error(`acquisition "${unit.id}" has invalid size or files`);
    }
    if (unit.kind === 'state-map') {
      unit.files.forEach((file) => validateMapFile(file, stateId));
      const bytes = unit.files.reduce((sum, file) => sum + file.bytes, 0);
      if (bytes !== unit.totalBytes) throw new Error(`acquisition "${unit.id}" total size is wrong`);
      return unit;
    }
    const compatibility = unit.compatibility;
    const catalogue = unit.catalogue;
    assertKnownKeys(compatibility, new Set(['partitionCatalogueFormat', 'graphFormat',
      'catalogueSha256']), `acquisition "${unit.id}" compatibility`);
    assertKnownKeys(catalogue, new Set(['path', 'bytes', 'sha256',
      'partitionCatalogueFormat', 'graphFormat']), `acquisition "${unit.id}" catalogue`);
    if (!compatibility || !Number.isSafeInteger(compatibility.partitionCatalogueFormat)
        || typeof compatibility.graphFormat !== 'string'
        || !SHA256.test(String(compatibility.catalogueSha256 || ''))) {
      throw new Error(`acquisition "${unit.id}" has invalid compatibility metadata`);
    }
    if (!catalogue || !SAFE_FILE.test(String(catalogue.path || ''))
        || !Number.isSafeInteger(catalogue.bytes) || catalogue.bytes <= 0
        || catalogue.sha256 !== compatibility.catalogueSha256
        || catalogue.partitionCatalogueFormat !== compatibility.partitionCatalogueFormat
        || catalogue.graphFormat !== compatibility.graphFormat) {
      throw new Error(`acquisition "${unit.id}" has invalid catalogue metadata`);
    }
    if (!Array.isArray(unit.sourceStateDependencies) || !unit.sourceStateDependencies.length) {
      throw new Error(`acquisition "${unit.id}" lists no source-state dependencies`);
    }
    const dependencyIds = new Set();
    for (const dependency of unit.sourceStateDependencies) {
      assertKnownKeys(dependency, new Set(['stateId', 'graphVersion', 'sha256']),
        `acquisition "${unit.id}" source dependency`);
      if (!SAFE_ID.test(String(dependency?.stateId || ''))
          || typeof dependency.graphVersion !== 'string'
          || !SHA256.test(String(dependency.sha256 || ''))
          || dependencyIds.has(dependency.stateId)) {
        throw new Error(`acquisition "${unit.id}" has an invalid source-state dependency`);
      }
      dependencyIds.add(dependency.stateId);
    }
    const sortedDependencies = [...dependencyIds].sort((a, b) => a.localeCompare(b));
    if ([...dependencyIds].some((id, index) => id !== sortedDependencies[index])) {
      throw new Error(`acquisition "${unit.id}" source-state dependencies are not sorted`);
    }
    const partitionIds = new Set();
    for (const file of unit.files) {
      if (!file || typeof file !== 'object') throw new Error(`acquisition "${unit.id}" has an invalid file`);
      assertKnownKeys(file, ROUTING_FILE_KEYS, `acquisition "${unit.id}" file`);
      if (file.dataset !== 'graph-partition' || !SAFE_PATH.test(String(file.path || ''))
          || String(file.path).includes('..') || file.stateId !== stateId
          // A state's routing files stay inside that state's folder: a store
          // entry must not be able to overwrite another installed state's
          // cached partitions with its own bytes.
          || !String(file.path).startsWith(`${stateId}/`)
          || !SAFE_PARTITION_ID.test(String(file.partitionId || ''))
          || partitionIds.has(file.partitionId)
          || !Number.isSafeInteger(file.bytes) || file.bytes <= 0
          || !Number.isSafeInteger(file.rawBytes) || file.rawBytes <= 0
          || !SHA256.test(String(file.sha256 || ''))
          || typeof file.sourceGraphVersion !== 'string') {
        throw new Error(`acquisition "${unit.id}" has an invalid partition file`);
      }
      partitionIds.add(file.partitionId);
    }
    const sortedPartitions = [...partitionIds].sort((a, b) => a.localeCompare(b));
    if ([...partitionIds].some((id, index) => id !== sortedPartitions[index])) {
      throw new Error(`acquisition "${unit.id}" partition files are not sorted`);
    }
    const bytes = catalogue.bytes + unit.files.reduce((sum, file) => sum + file.bytes, 0);
    if (bytes !== unit.totalBytes) throw new Error(`acquisition "${unit.id}" total size is wrong`);
    return unit;
  }

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
    state.files.forEach((file) => validateMapFile(file, state.id));
    if (state.placeSearch !== undefined) {
      const search = state.placeSearch;
      assertKnownKeys(search, new Set(['format', 'sourcePath', 'sourceBytes',
        'completeResultCount', 'resultCount', 'entries']), `state "${state.id}" place search`);
      if (!search || search.format !== 1 || search.sourcePath !== 'places.json'
          || !Number.isSafeInteger(search.sourceBytes) || search.sourceBytes < 0
          || !Number.isSafeInteger(search.completeResultCount) || search.completeResultCount < 0
          || !Number.isSafeInteger(search.resultCount) || search.resultCount < 0
          || !Array.isArray(search.entries) || search.entries.length !== search.resultCount
          || search.resultCount > 120 || search.resultCount > search.completeResultCount) {
        throw new Error(`state "${state.id}" has invalid lightweight place search metadata`);
      }
      const identities = new Set();
      for (const entry of search.entries) {
        assertKnownKeys(entry, new Set(['id', 'name', 'lon', 'lat', 'type', 'population']),
          `state "${state.id}" place search entry`);
        if (!PLACE_SEARCH_ID.test(String(entry?.id || ''))
            || !entry.id.startsWith(`${state.id}:`) || identities.has(entry.id)
            || typeof entry.name !== 'string' || !entry.name.trim()
            || !Number.isFinite(entry.lon) || Math.abs(entry.lon) > 180
            || !Number.isFinite(entry.lat) || Math.abs(entry.lat) > 90
            || typeof entry.type !== 'string' || !Number.isFinite(entry.population)) {
          throw new Error(`state "${state.id}" has an invalid lightweight place result`);
        }
        identities.add(entry.id);
      }
    }
    if (state.acquisitions !== undefined) {
      if (!Array.isArray(state.acquisitions) || !state.acquisitions.length) {
        throw new Error(`state "${state.id}" lists no acquisition units`);
      }
      const ids = new Set(), kinds = new Set();
      for (const unit of state.acquisitions) {
        validateAcquisition(unit, state.id);
        if (ids.has(unit.id) || kinds.has(unit.kind)) {
          throw new Error(`state "${state.id}" repeats an acquisition id or kind`);
        }
        ids.add(unit.id); kinds.add(unit.kind);
      }
      const mapUnit = state.acquisitions.find((unit) => unit.kind === 'state-map');
      if (!mapUnit || JSON.stringify(mapUnit.files) !== JSON.stringify(state.files)) {
        throw new Error(`state "${state.id}" map acquisition disagrees with its file list`);
      }
    }
    return state;
  }

  function acquisitionUnits(state) {
    if (Array.isArray(state?.acquisitions)) return state.acquisitions;
    return state?.files ? [{ acquisitionFormat: 0, id: `legacy-${state.id}`,
      kind: 'state-map', stateIds: [state.id],
      totalBytes: state.files.reduce((sum, file) => sum + (file.bytes || 0), 0),
      files: state.files }] : [];
  }

  function routingUnit(state) {
    return acquisitionUnits(state).find((unit) => unit.kind === 'routing-partitions') || null;
  }

  function bundledStateIds() {
    if (root.MAP_STATES_BUNDLED === false) return [];
    if (Array.isArray(root.MAP_STATES_BUNDLED_IDS)) {
      return root.MAP_STATES_BUNDLED_IDS.map(String);
    }
    return (root.MAP_STATES || []).map((state) => state.id);
  }

  function bundledState(id) {
    if (!bundledStateIds().includes(id)) return null;
    const state = (root.MAP_STATES || []).find((candidate) => candidate.id === id);
    if (!state) return null;
    const acquisitions = root.MAP_STATE_ACQUISITIONS?.[id];
    return acquisitions ? { ...state, acquisitions } : state;
  }

  function localState(id) {
    return MapStore.installedEntry(id)?.state || bundledState(id);
  }

  const MapStore = {
    /* ----------------------------------------------------- installed packs */
    installedStates: () => readJson(INSTALLED_KEY),
    installedRegionConfigs: () => readJson(INSTALLED_KEY).map((entry) => entry.state),
    installedEntry: (id) => readJson(INSTALLED_KEY).find((entry) => entry.state.id === id) || null,
    stateBytes: (state) => acquisitionUnits(state)
      .reduce((sum, unit) => sum + (unit.totalBytes || 0), 0),
    async storageEstimate() {
      const installed = readJson(INSTALLED_KEY);
      const unique = new Map();
      for (const entry of installed) {
        for (const item of acquisitionStorageItems(entry.state)) {
          if (!unique.has(item.key)) unique.set(item.key, item.bytes);
        }
      }
      let estimate = {};
      try { estimate = await root.navigator?.storage?.estimate?.() || {}; }
      catch (error) { /* optional browser signal */ }
      return { installedBytes: [...unique.values()].reduce((sum, bytes) => sum + bytes, 0),
        usageBytes: Number.isFinite(estimate.usage) ? estimate.usage : null,
        quotaBytes: Number.isFinite(estimate.quota) ? estimate.quota : null };
    },
    installedStateIds: () => [...new Set([
      ...bundledStateIds(),
      ...readJson(INSTALLED_KEY).map((entry) => entry.state.id),
    ])].sort((a, b) => a.localeCompare(b)),

    // Whether a state's data can be used right now without a download.
    availability(id) {
      const bundled = bundledStateIds().includes(id);
      if (bundled) return 'bundled';
      if (MapStore.installedEntry(id)) return 'installed';
      return 'remote';
    },

    updateAvailable(state) {
      const installed = MapStore.installedEntry(state?.id);
      if (!installed || !Array.isArray(state?.acquisitions)) return false;
      const current = new Set(acquisitionUnits(installed.state).map((unit) => unit.id));
      return state.acquisitions.some((unit) => !current.has(unit.id));
    },

    routingAcquisitionForStates(stateIds) {
      const ids = [...new Set(stateIds || [])];
      const states = ids.map((id) => localState(id));
      const missingStateIds = ids.filter((id, index) => !states[index]);
      if (missingStateIds.length) return { available: false, missingStateIds,
        reason: 'required states are not installed' };
      const units = states.map(routingUnit);
      const missingRoutingStateIds = ids.filter((id, index) => !units[index]);
      if (missingRoutingStateIds.length) return { available: false, missingStateIds: [],
        missingRoutingStateIds, reason: 'required routing data is not installed' };
      const catalogueSha256 = units[0].compatibility.catalogueSha256;
      const compatible = units.every((unit) =>
        unit.compatibility.catalogueSha256 === catalogueSha256
          && unit.compatibility.partitionCatalogueFormat
            === units[0].compatibility.partitionCatalogueFormat
          && unit.compatibility.graphFormat === units[0].compatibility.graphFormat);
      if (!compatible) return { available: false, missingStateIds: [],
        incompatibleStateIds: ids, reason: 'installed routing maps need a compatible update' };
      for (const [index, unit] of units.entries()) {
        const stateId = ids[index];
        const dependency = unit.sourceStateDependencies.find((item) => item.stateId === stateId);
        if (!dependency || dependency.graphVersion !== states[index].versions?.graph) {
          return { available: false, missingStateIds: [], outdatedStateIds: [stateId],
            reason: 'installed routing data is older than its state map' };
        }
      }
      return { available: true, stateIds: ids, units,
        compatibility: units[0].compatibility, catalogue: units[0].catalogue };
    },

    async routingContext(stateIds) {
      const acquisition = MapStore.routingAcquisitionForStates(stateIds);
      if (!acquisition.available) {
        const error = new Error(acquisition.reason || 'Required routing maps are unavailable.');
        error.code = 'routing-acquisition-unavailable';
        error.detail = acquisition;
        throw error;
      }
      const request = catalogueRequest(acquisition.catalogue);
      let response = null;
      if (root.caches) {
        // WKWebView may reject Cache Storage operations on a capacitor://
        // origin; a failed lookup falls through to fetch rather than failing
        // the whole multi-state plan.
        try {
          response = await (await root.caches.open(root.DATA_CACHE_NAME)).match(request, {
            ignoreVary: false, ignoreSearch: false,
          });
        } catch (error) { response = null; }
      }
      if (!response) response = await fetch(request);
      if (!response?.ok) throw new Error(`Partition catalogue: HTTP ${response?.status || 0}`);
      await verifyStoredSha(response.clone(), acquisition.catalogue.sha256,
        acquisition.catalogue.path);
      const catalogue = await response.json();
      root.MultiStateRouting?.validatePartitionCatalogue(catalogue);
      return {
        catalogue,
        catalogueIdentity: { path: acquisition.catalogue.path,
          sha256: acquisition.catalogue.sha256 },
        baseUrl: new URL('maps/', location.href).href,
        installedStateIds: MapStore.installedStateIds(),
      };
    },

    routeDependencyStatus(dependencies) {
      if (!dependencies?.states?.length) return { available: true, missingStateIds: [],
        outdatedStateIds: [], missingPartitionIds: [], message: '' };
      const missingStateIds = [], outdatedStateIds = [], missingPartitionIds = [];
      for (const dependency of dependencies.states) {
        const state = localState(dependency.stateId);
        if (!state) { missingStateIds.push(dependency.stateId); continue; }
        if (dependency.graphVersion && state.versions?.graph !== dependency.graphVersion) {
          outdatedStateIds.push(dependency.stateId);
        }
        if (dependency.sourceSha256 && dependencies.partitions?.length) {
          const source = routingUnit(state)?.sourceStateDependencies
            ?.find((item) => item.stateId === dependency.stateId);
          if (!source || source.sha256 !== dependency.sourceSha256) {
            outdatedStateIds.push(dependency.stateId);
          }
        }
      }
      const routeStateIds = dependencies.states.map((dependency) => dependency.stateId);
      const routing = dependencies.partitions?.length
        ? MapStore.routingAcquisitionForStates(routeStateIds) : null;
      if (routing && !routing.available) {
        for (const id of routing.missingStateIds || routing.missingRoutingStateIds || []) {
          if (!missingStateIds.includes(id)) missingStateIds.push(id);
        }
        for (const id of routing.outdatedStateIds || routing.incompatibleStateIds || []) {
          if (!outdatedStateIds.includes(id)) outdatedStateIds.push(id);
        }
      }
      if (routing?.available && dependencies.catalogueSha256
          && routing.compatibility.catalogueSha256 !== dependencies.catalogueSha256) {
        outdatedStateIds.push(...routeStateIds.filter((id) => !outdatedStateIds.includes(id)));
      }
      if (routing?.available) {
        const files = new Map(routing.units.flatMap((unit) => unit.files)
          .map((file) => [file.partitionId, file]));
        for (const dependency of dependencies.partitions || []) {
          const file = files.get(dependency.partitionId);
          if (!file || file.sha256 !== dependency.sha256
              || file.sourceGraphVersion !== dependency.sourceGraphVersion) {
            missingPartitionIds.push(dependency.partitionId);
          }
        }
      } else {
        missingPartitionIds.push(...(dependencies.partitions || []).map((item) => item.partitionId));
      }
      const available = !(missingStateIds.length || outdatedStateIds.length || missingPartitionIds.length);
      const stateName = (id) => localState(id)?.name
        || (root.MAP_STATES || []).find((state) => state.id === id)?.name || id;
      const message = missingStateIds.length
        ? `Missing ${missingStateIds.map(stateName).join(', ')} — reinstall to use this route offline.`
        : outdatedStateIds.length
          ? `Update ${outdatedStateIds.map(stateName).join(', ')} to restore this saved route.`
          : missingPartitionIds.length ? 'This saved route needs routing data that is no longer installed.' : '';
      return { available, missingStateIds: [...new Set(missingStateIds)],
        outdatedStateIds: [...new Set(outdatedStateIds)],
        missingPartitionIds: [...new Set(missingPartitionIds)], message };
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
      // The same-origin store's index sits in the service worker's shell
      // precache, so a plain fetch returns the copy frozen at shell install
      // and a data-only redeploy is invisible until the next app update. The
      // install marker bypasses every worker cache branch; offline, fall back
      // to whatever cached copy the worker can still serve.
      let response = null;
      if (root.location?.href) {
        const fresh = new URL(`${base}index.json`, root.location.href);
        fresh.searchParams.set('jra-store-install', `index-${Date.now()}`);
        try {
          response = await fetch(fresh.href, { cache: 'no-store' });
        } catch (error) { response = null; }
      }
      if (!response) response = await fetch(`${base}index.json`, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`The store answered HTTP ${response.status}.`);
      let index;
      try {
        index = await response.json();
      } catch (e) { throw new Error('The store index is not valid JSON.'); }
      if (!index || ![1, 2].includes(index.storeFormat)) {
        throw new Error('The store index is not a recognized format.');
      }
      if (!Array.isArray(index.states) || !index.states.length) {
        throw new Error('The store index lists no states.');
      }
      const states = index.states.map(validateStateEntry);
      if (index.storeFormat === 2
          && states.some((state) => !Array.isArray(state.acquisitions))) {
        throw new Error('The version 2 store index omits acquisition units.');
      }
      return { storeFormat: index.storeFormat, storeUrl: base, states };
    },

    /* ------------------------------------------------------------ install */
    // Download every declared acquisition into a staging cache first. A new
    // install becomes visible only after every byte and declared hash passes;
    // a failed update leaves the prior working acquisition untouched.
    async installState(storeUrl, state, onProgress = () => {}, options = {}) {
      validateStateEntry(state);
      if (!root.caches) throw new Error('This browser cannot store offline maps.');
      const signal = options.signal || null;
      const descriptors = installDescriptors(state);
      const total = MapStore.stateBytes(state);
      const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const stageName = `${root.DATA_CACHE_NAME}-install-${nonce}`;
      const backupName = `${root.DATA_CACHE_NAME}-backup-${nonce}`;
      let stage = null, backup = null, cache = null;
      let done = 0;
      let commitStarted = false, committed = false;
      let stagedRequests = [];
      const previous = MapStore.installedEntry(state.id);
      try {
        stage = await root.caches.open(stageName);
        backup = await root.caches.open(backupName);
        cache = await root.caches.open(root.DATA_CACHE_NAME);
        const estimate = await MapStore.storageEstimate();
        // During commit the download exists in staging while the live cache
        // fills, and an update also holds a backup of every overwritten
        // previous entry — the preflight must cover that peak, not just the
        // download, or quota failures land inside the commit itself.
        const backupBytes = previous ? MapStore.stateBytes(previous.state) : 0;
        if (estimate.quotaBytes != null && estimate.usageBytes != null
            && estimate.quotaBytes - estimate.usageBytes < total + backupBytes) {
          throw new Error(`This device needs ${(total + backupBytes).toLocaleString()} free bytes for the map download.`);
        }
        for (const descriptor of descriptors) {
          if (signal?.aborted) throw new DOMException('Download cancelled.', 'AbortError');
          const sourceUrl = new URL(descriptor.sourcePath,
            new URL(storeUrl, location.href));
          let response = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            const attemptUrl = new URL(sourceUrl);
            // The marker serves two purposes: it bypasses a same-origin
            // service worker's ordinary data-cache path, preserving the
            // staging transaction, and gives a retry a fresh CDN cache key.
            attemptUrl.searchParams.set('jra-store-install', `${nonce}-${attempt}`);
            response = await fetch(attemptUrl.href, { cache: 'no-store', signal });
            if (response.type === 'opaque') {
              throw new Error('The store does not allow cross-origin reads (CORS).');
            }
            if (!response.ok) throw new Error(`${descriptor.file.path}: HTTP ${response.status}`);
            const contentLengthHeader = response.headers.get('content-length');
            const contentLength = contentLengthHeader == null ? null : Number(contentLengthHeader);
            if (!Number.isFinite(contentLength) || contentLength === descriptor.file.bytes) break;
            if (contentLength > 0 && contentLength < descriptor.file.bytes) {
              const resumed = await resumeShortResponse({ response, sourceUrl,
                receivedBytes: contentLength, expectedBytes: descriptor.file.bytes,
                nonce: `${nonce}-${attempt}`, signal });
              if (resumed) {
                response = resumed;
                onProgress({ file: descriptor.file.path,
                  acquisitionId: descriptor.acquisitionId, done, total,
                  resuming: true, receivedBytes: contentLength,
                  remainingBytes: descriptor.file.bytes - contentLength });
                break;
              }
            }
            if (attempt === 1) {
              await response.body?.cancel?.().catch?.(() => {});
              throw new Error(`${descriptor.file.path}: expected ${descriptor.file.bytes} bytes, received ${contentLength}`);
            }
            await response.body?.cancel?.().catch?.(() => {});
            onProgress({ file: descriptor.file.path, acquisitionId: descriptor.acquisitionId,
              done, total, retrying: true });
          }
          let streamed = 0;
          await stage.put(descriptor.request, countedResponse(response, (bytes) => {
            streamed += bytes; done += bytes;
            onProgress({ file: descriptor.file.path, acquisitionId: descriptor.acquisitionId,
              done: Math.min(done, total), total });
          }));
          const stored = await stage.match(descriptor.request);
          const storedBytes = stored ? (await stored.clone().blob()).size : -1;
          if (storedBytes !== descriptor.file.bytes) {
            throw new Error(`${descriptor.file.path}: expected ${descriptor.file.bytes} bytes, stored ${storedBytes}`);
          }
          if (!streamed) {
            done += storedBytes;
            onProgress({ file: descriptor.file.path, acquisitionId: descriptor.acquisitionId,
              done: Math.min(done, total), total });
          }
          if (descriptor.sha256) await verifyStoredSha(stored, descriptor.sha256, descriptor.file.path);
          if (descriptor.file.dataset !== 'partition-catalogue') {
            await writeArchiveStamp(stage, state, descriptor.file);
          }
        }
        if (signal?.aborted) throw new DOMException('Download cancelled.', 'AbortError');
        stagedRequests = await stage.keys();
        // Back up before commitStarted flips: a failure inside the backup loop
        // (quota, at its tightest exactly here) must not trigger a rollback
        // that deletes live entries it never copied. Until the first cache.put
        // below, nothing in the live cache has changed.
        for (const request of stagedRequests) {
          const old = await cache.match(request, { ignoreVary: false, ignoreSearch: false });
          if (old) await backup.put(request, old);
        }
        commitStarted = true;
        for (const request of stagedRequests) {
          const response = await stage.match(request);
          if (!response) throw new Error(`staged file disappeared: ${new URL(request.url).pathname}`);
          await cache.put(request, response);
          // The staged copy has served its purpose; dropping it now keeps the
          // storage peak near one copy of the download instead of two.
          await stage.delete(request);
        }
        const installed = readJson(INSTALLED_KEY).filter((entry) => entry.state.id !== state.id);
        const cachedRequests = stagedRequests.map((request) => request.url).sort();
        installed.push({ state, storeUrl, installedAt: Date.now(), cachedRequests });
        installed.sort((a, b) => a.state.id.localeCompare(b.state.id));
        writeJson(INSTALLED_KEY, installed);
        committed = true;
        try {
          await removeUnreferencedRequests(cache, previous?.cachedRequests || [], installed);
        } catch (cleanupError) {
          root.console?.warn?.('Installed the map, but could not remove every obsolete cache entry.',
            cleanupError);
        }
      } catch (error) {
        if (commitStarted && !committed) {
          // stagedRequests, not stage.keys(): committed entries were already
          // deleted from staging, and fresh files with no previous version
          // must still be removed from the live cache.
          for (const request of stagedRequests) await cache.delete(request);
          for (const request of await backup.keys()) {
            const response = await backup.match(request);
            if (response) await cache.put(request, response);
          }
        }
        throw error;
      } finally {
        await root.caches.delete(stageName);
        await root.caches.delete(backupName);
      }
      onProgress({ file: null, done: total, total });
    },

    // Drop only the requests recorded by the acquisition manifest. Shared
    // catalogue keys remain while another installed state references them.
    async removeStateData(id) {
      if (!root.caches) return;
      const cache = await root.caches.open(root.DATA_CACHE_NAME);
      const entry = MapStore.installedEntry(id);
      if (entry?.cachedRequests?.length) {
        const remaining = readJson(INSTALLED_KEY).filter((candidate) => candidate.state.id !== id);
        await removeUnreferencedRequests(cache, entry.cachedRequests, remaining);
        return;
      }
      // Legacy v1 entries predate request manifests. Keep the broad fallback
      // only for them so existing installs remain removable after an update.
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

  function catalogueRequest(catalogue) {
    return new Request(`maps/${catalogue.path}?sha256=${catalogue.sha256}`);
  }

  function acquisitionStorageItems(state) {
    const items = [];
    for (const unit of acquisitionUnits(state)) {
      if (unit.kind === 'state-map') {
        for (const file of unit.files) items.push({ key: `maps/${state.id}/${file.path}`,
          bytes: file.bytes });
      } else if (unit.kind === 'routing-partitions') {
        items.push({ key: `catalogue:${unit.catalogue.sha256}`, bytes: unit.catalogue.bytes });
        for (const file of unit.files) items.push({ key: `partition:${file.path}`, bytes: file.bytes });
      }
    }
    return items;
  }

  function installDescriptors(state) {
    const descriptors = [];
    for (const unit of acquisitionUnits(state)) {
      if (unit.kind === 'state-map') {
        for (const file of unit.files) descriptors.push({
          acquisitionId: unit.id, file,
          sourcePath: `${state.id}/${file.path}`,
          request: logicalRequest(state, file), sha256: file.sha256 || null,
        });
      } else if (unit.kind === 'routing-partitions') {
        const catalogueFile = { ...unit.catalogue, dataset: 'partition-catalogue' };
        descriptors.push({ acquisitionId: unit.id, file: catalogueFile,
          sourcePath: unit.catalogue.path, request: catalogueRequest(unit.catalogue),
          sha256: unit.catalogue.sha256 });
        for (const file of unit.files) descriptors.push({
          acquisitionId: unit.id, file, sourcePath: file.path,
          request: new Request(`maps/${file.path}`), sha256: file.sha256,
        });
      }
    }
    const keys = new Set();
    for (const descriptor of descriptors) {
      if (keys.has(descriptor.request.url)) {
        throw new Error(`state "${state.id}" acquisition repeats "${descriptor.file.path}"`);
      }
      keys.add(descriptor.request.url);
    }
    return descriptors;
  }

  async function verifyStoredSha(response, expected, path) {
    if (!response) throw new Error(`${path}: downloaded file was not stored`);
    if (!root.crypto?.subtle) throw new Error('This browser cannot verify routing-map downloads.');
    const digest = await root.crypto.subtle.digest('SHA-256', await response.arrayBuffer());
    const actual = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== expected) throw new Error(`${path}: downloaded file failed its SHA-256 check`);
  }

  async function removeUnreferencedRequests(cache, requestUrls, remainingEntries) {
    const referenced = new Set((remainingEntries || [])
      .flatMap((entry) => entry.cachedRequests || []));
    const targets = [...new Set(requestUrls || [])].filter((url) => !referenced.has(url));
    for (const url of targets) {
      await cache.delete(new Request(url), { ignoreVary: false, ignoreSearch: false });
      const pathname = new URL(url).pathname;
      if (!pathname.endsWith('.pmtiles')) continue;
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname.startsWith(`${pathname}__chunk`)) {
          await cache.delete(request);
        }
      }
    }
  }

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
    if (!version || !['roads', 'regional', 'basemap', 'overlays'].includes(file.dataset)) return;
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

  // Mobile Safari can persistently stop a large same-origin response at the
  // same byte even when a fresh query and no-store fetch are used. Resume only
  // when the server proves the exact missing byte interval with Content-Range;
  // otherwise the ordinary full retry remains the safe fallback. The two
  // bodies are streamed into Cache Storage sequentially, so the complete
  // archive never has to sit in JavaScript memory.
  async function resumeShortResponse({ response, sourceUrl, receivedBytes,
    expectedBytes, nonce, signal }) {
    const rangeUrl = new URL(sourceUrl);
    rangeUrl.searchParams.set('jra-store-install', `${nonce}-resume-${receivedBytes}`);
    let tail = null;
    try {
      tail = await fetch(rangeUrl.href, {
        cache: 'no-store', signal,
        headers: { Range: `bytes=${receivedBytes}-${expectedBytes - 1}` },
      });
      if (tail.type === 'opaque') return null;
      const tailLength = Number(tail.headers.get('content-length'));
      // Some servers ignore Range and send a new complete response. It is a
      // valid fresh retry by itself; discard the short first response.
      if (tail.status === 200 && tailLength === expectedBytes) {
        await response.body?.cancel?.().catch?.(() => {});
        return tail;
      }
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
        tail.headers.get('content-range') || '');
      const validRange = tail.status === 206 && tail.ok && match
        && response.body && tail.body && typeof ReadableStream !== 'undefined'
        && Number(match[1]) === receivedBytes
        && Number(match[2]) === expectedBytes - 1
        && Number(match[3]) === expectedBytes
        && tailLength === expectedBytes - receivedBytes;
      if (!validRange) {
        await tail.body?.cancel?.().catch?.(() => {});
        return null;
      }
      return concatenateResponses(response, tail, receivedBytes, expectedBytes);
    } catch (error) {
      await tail?.body?.cancel?.().catch?.(() => {});
      if (error?.name === 'AbortError') throw error;
      return null;
    }
  }

  function concatenateResponses(first, second, firstBytes, bytes) {
    const readers = [first, second].map((response) => response.body.getReader());
    const remaining = [firstBytes, bytes - firstBytes];
    let index = 0;
    const headers = new Headers();
    const contentType = first.headers.get('content-type');
    if (contentType) headers.set('content-type', contentType);
    headers.set('content-length', String(bytes));
    return new Response(new ReadableStream({
      async pull(controller) {
        while (index < readers.length) {
          const chunk = await readers[index].read();
          if (chunk.done) {
            if (remaining[index] > 0) {
              controller.error(new Error('A resumed map response ended before its validated byte range.'));
              return;
            }
            index++;
            continue;
          }
          const take = Math.min(remaining[index], chunk.value.byteLength);
          if (take > 0) controller.enqueue(chunk.value.subarray(0, take));
          remaining[index] -= take;
          if (remaining[index] === 0) {
            await readers[index].cancel().catch(() => {});
            index++;
          }
          if (take > 0) return;
        }
        controller.close();
      },
      cancel(reason) {
        return Promise.all(readers.slice(index).map((reader) =>
          reader.cancel(reason).catch(() => {})));
      },
    }), { status: 200, headers });
  }

  // A page killed mid-download orphans its staging/backup caches, and the
  // service worker's activation sweep only runs when a new shell installs —
  // weeks apart — while the orphaned bytes count against quota and fail the
  // install preflight. Each cache name carries its Date.now() nonce; anything
  // old enough that no install could still own it is reclaimed at load.
  if (root.caches?.keys) {
    root.caches.keys().then((keys) => Promise.all(keys
      .filter((name) => {
        const match = /-(?:install|backup)-(\d+)-/.exec(name);
        return match && Date.now() - Number(match[1]) > 24 * 60 * 60 * 1000;
      })
      .map((name) => root.caches.delete(name)))).catch(() => {});
  }

  root.MapStore = MapStore;
}(typeof self !== 'undefined' ? self : this));
