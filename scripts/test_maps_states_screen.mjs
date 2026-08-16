#!/usr/bin/env node
// One state at a time, and choosing one is the whole mechanism: every data path
// in the app, the router worker and the service worker is built from
// Region.dataRoot, so the Maps screen writes a state id, and a reload does the
// rest.
//
// The screen shows only maps the app can currently load. Future placeholders
// made the picker look broken and forced riders through dozens of disabled
// choices. It has to be radios: a checkbox promises that two can be on at once,
// which is exactly what this cannot do.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

// Two states, invented here and served over the generated index. The screen's
// contract is "list every state that has a folder, and switch between them" --
// it is not "there are two states in this repository". Reading the real
// maps/states.js made this test fail the moment a state was added or removed,
// which is the same mistake as pinning a route's distance: it tested sameness
// rather than behaviour.
//
// Washington keeps its real id so the data the app fetches is really there; the
// second is a preview state with a place index and nothing else, which is the
// shape every import passes through on its way up (maps/README.md, level 2).
const STATES = [
  { id: 'washington', name: 'Washington', status: 'released', readiness: 8,
    summary: 'Full routing, tiles, safety enrichment and place search.',
    bounds: { minLon: -124.9, maxLon: -116.8, minLat: 45.5, maxLat: 49.1 },
    defaultCenter: [-122.3321, 47.6062], defaultZoom: 11,
    stressAgency: 'WSDOT', restrictionAgency: 'WSDOT', speedAgency: 'WSDOT',
    facilitySourceName: 'WSDOT Active Transportation Data',
    stressLayerName: 'WSDOT BLTS (state highways)',
    restrictionLayerName: 'Bikes prohibited (WSDOT)',
    interstateRoutePrefixes: ['005', '082', '090', '182', '205', '405', '705'],
    facilityLevels: { 'Shared-Use Path': 5, 'Bike Lane': 2 },
    routeDirectionSuffixes: { i: 'increasing mileposts', d: 'decreasing mileposts' },
    datasets: { graph: true, roads: true, basemap: true, overlays: true,
      places: true, bikeroutes: true, restrictions: true, closures: true },
    versions: {} },
  { id: 'newstate', name: 'Idaho', status: 'preview', readiness: 2,
    summary: 'Place search only. No routing graph, no map tiles.',
    bounds: { minLon: -117.3, maxLon: -111.0, minLat: 41.9, maxLat: 49.0 },
    defaultCenter: [-116.2023, 43.6150], defaultZoom: 11,
    stressAgency: 'ITD', restrictionAgency: 'ITD', speedAgency: 'ITD',
    facilitySourceName: 'ITD Bicycle Facility Inventory',
    stressLayerName: 'ITD stress (state highways)',
    restrictionLayerName: 'Bikes prohibited (ITD)',
    interstateRoutePrefixes: [], facilityLevels: {}, routeDirectionSuffixes: {},
    datasets: { graph: false, roads: false, basemap: false, overlays: false,
      places: false, bikeroutes: false, restrictions: false, closures: false },
    versions: {} },
];
const MAP_STATES = STATES;

const site = await serveRepo();
site.publish('/maps/states.js', `(function (root) {
  root.MAP_STATES = ${JSON.stringify(STATES)};
}(typeof self !== 'undefined' ? self : this));`);
const browser = await launchBrowser();
const page = await appPage(browser, site.port, { desktop: true });
await page.waitForFunction(() => typeof openMapsDialog === 'function', { timeout: 60000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const tab = await page.evaluate(() => {
  const button = document.getElementById('settings-tab-maps');
  return {
    exists: !!button,
    label: button?.textContent,
    role: button?.getAttribute('role'),
    haspopup: button?.getAttribute('aria-haspopup'),
    inTablist: !!button?.closest('[role="tablist"]'),
  };
});
check('Settings offers Maps as a real tab',
  tab.exists && tab.label === 'Maps' && tab.haspopup === null
    && tab.role === 'tab' && tab.inTablist === true, JSON.stringify(tab));

await page.evaluate(() => openMapsDialog());
const screen = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#mapsStateList .maps-state')];
  const named = (row) => row.querySelector('.maps-state-name > span').textContent;
  const input = (row) => row.querySelector('input');
  return {
    settingsOpen: settingsMenuIsOpen(),
    paneVisible: document.getElementById('settings-maps').hidden === false,
    tabsVisible: document.getElementById('settingsTabs').getBoundingClientRect().height > 0,
    lead: document.querySelector('#settings-maps .maps-lead')?.textContent,
    note: document.querySelector('#settings-maps .maps-note')?.textContent,
    count: rows.length,
    first: named(rows[0]),
    last: named(rows[rows.length - 1]),
    types: [...new Set(rows.map((row) => input(row).type))],
    group: [...new Set(rows.map((row) => input(row).name))],
    checked: rows.filter((row) => input(row).checked).map(named),
    enabled: rows.filter((row) => !input(row).disabled).map(named),
    loadedRegion: Region.name,
    fullScreen: document.body.classList.contains('settings-panel-active'),
  };
});
check('it opens a full-screen list of available maps, alphabetically',
  screen.settingsOpen && screen.paneVisible && screen.tabsVisible && screen.fullScreen
    && screen.count === STATES.length
    && screen.first === 'Idaho' && screen.last === 'Washington', JSON.stringify(screen));
check('the controls are one radio group, because one state loads at a time',
  screen.types.join() === 'radio' && screen.group.length === 1, JSON.stringify(screen));
check('and the copy says so, and warns that switching restarts',
  /state to ride in/i.test(screen.lead || '')
    && /one map is loaded at a time/i.test(screen.note || '')
    && /restarts/i.test(screen.note || ''), `${screen.lead} | ${screen.note}`);
check('the loaded state is the checked one',
  screen.checked.join() === screen.loadedRegion, JSON.stringify(screen.checked));

// Selectable is exactly "has a folder under maps/" -- not a list maintained
// beside it, which is how the two drift.
const shipped = MAP_STATES.map((state) => state.name).sort();
check('every state with a maps/ folder is selectable, and only those',
  screen.enabled.slice().sort().join() === shipped.join(),
  `screen ${screen.enabled} vs folders ${shipped}`);
check('there is more than one, so this is a real choice',
  shipped.length >= 2, shipped.join());

// A row has to say what the state can DO. A bare state name invites a rider to
// select it and then wonder why no route comes back.
const detail = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#mapsStateList .maps-state')];
  const find = (name) => rows.find((row) =>
    row.querySelector('.maps-state-name > span').textContent === name);
  const wa = find('Washington');
  const preview = find('Idaho');
  return {
    washington: wa?.querySelector('.maps-state-detail')?.textContent,
    preview: preview?.querySelector('.maps-state-detail')?.textContent,
    names: rows.map((row) => row.querySelector('.maps-state-name > span').textContent),
    badges: rows.map((row) => row.querySelector('.maps-state-badge')?.textContent)
      .filter(Boolean),
    storesVisible: !!document.querySelector('.maps-stores')?.getClientRects().length,
  };
});
check('a finished state says it can route', /routing/i.test(detail.washington || ''),
  detail.washington);
check('a preview state says what it is missing',
  /nothing usable|no map or routing|map only/i.test(detail.preview || ''), detail.preview);
check('and carries a Preview badge beside the loaded one',
  detail.badges.includes('Preview') && detail.badges.includes('Loaded'),
  JSON.stringify(detail.badges));
check('unavailable placeholder states are omitted entirely',
  detail.names.length === STATES.length && !detail.names.includes('Alabama'),
  JSON.stringify(detail.names));
check('the unfinished map-store controls stay hidden', detail.storesVisible === false);

/* ---------------------------------------------- refusing at the wrong moment */
// Mid-ride is the one time this must refuse: the rider is being spoken turn
// instructions off a graph that would vanish under them.
const duringNavigation = await page.evaluate(() => {
  turnNav.active = true;
  const before = localStorage.getItem(Region.storageKey);
  const target = Region.states.find((state) => state.id !== Region.id);
  const accepted = switchMapState(target.id);
  turnNav.active = false;
  return {
    accepted,
    changed: localStorage.getItem(Region.storageKey) !== before,
    status: document.getElementById('mapsStatus').textContent,
  };
});
check('switching is refused while navigating, and says why',
  duringNavigation.accepted === false && duringNavigation.changed === false
    && /finish navigating/i.test(duringNavigation.status || ''),
  JSON.stringify(duringNavigation));

// A refused switch must not leave the list showing the state the app is NOT on.
const restored = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#mapsStateList .maps-state')];
  return rows.filter((row) => row.querySelector('input').checked)
    .map((row) => row.querySelector('.maps-state-name > span').textContent);
});
check('and the list still shows the state the app is actually on',
  restored.join() === screen.loadedRegion, JSON.stringify(restored));

const closed = await page.evaluate(() => {
  document.getElementById('settingsPanelClose').click();
  return settingsMenuIsOpen();
});
check('closing leaves the screen', closed === false);

/* --------------------------------------------------- and then actually switch */
// The switch ends in a reload, so the only honest way to test it is to let it
// happen and look at what comes back. A route is set first: it belongs to the
// graph about to be unloaded, and it must not survive.
const preview = STATES[1];
const before = await page.evaluate((targetId) => {
  routing.worker = { postMessage: () => {}, terminate: () => {} };
  routing.ready = true;
  setRoutePoint('start', { lng: -122.335, lat: 47.61 }, 'Gas Works Park');
  setRoutePoint('end', { lng: -122.31, lat: 47.65 }, 'Green Lake');
  openMapsDialog();
  const accepted = switchMapState(targetId);
  return { accepted, routeStart: routing.start, routeEnd: routing.end };
}, preview.id);
check('the route is cleared before the switch, not left pointing into a gone graph',
  before.accepted === true && before.routeStart === null && before.routeEnd === null,
  JSON.stringify(before));

await page.waitForFunction((id) => window.Region && Region.id === id,
  preview.id, { timeout: 90000 });
await page.waitForFunction(() => window.map && map.loaded && map.loaded(), { timeout: 90000 });

const reloaded = await page.evaluate(() => ({
  region: Region.name,
  dataRoot: Region.dataRoot,
  centre: map.getCenter(),
  // Only what the folder holds. A layer whose file is not there is a toggle
  // that turns on a 404.
  layers: SOURCES.map((source) => source.id),
  styleSources: Object.keys(map.getStyle().sources).filter((id) => id.startsWith('basemap-')),
  graphUrl: GRAPH_URL,
}));
check('the app comes back up on the state that was chosen',
  reloaded.region === preview.name && reloaded.dataRoot === `maps/${preview.id}`,
  JSON.stringify(reloaded));
check('and opens where that state opens',
  Math.abs(reloaded.centre.lng - preview.defaultCenter[0]) < 0.2
    && Math.abs(reloaded.centre.lat - preview.defaultCenter[1]) < 0.2,
  `${reloaded.centre.lng.toFixed(3)}, ${reloaded.centre.lat.toFixed(3)}`);
check('every data path follows the folder',
  reloaded.graphUrl.startsWith(`maps/${preview.id}/`), reloaded.graphUrl);
// A MapLibre source whose archive 404s never finishes loading, so the style
// hangs and `load` never fires -- the whole app stuck on its launch screen. A
// state that declares no tiles must therefore contribute no tile sources.
check('a source the state does not ship is not in the style at all',
  reloaded.styleSources.length === 0, JSON.stringify(reloaded.styleSources));
// A state shipping no scored linework gets an empty layer list -- not one entry
// per layer whose file 404s.
check('and neither are the layers that would draw from it',
  !reloaded.layers.includes('roads') && !reloaded.layers.includes('blts'),
  JSON.stringify(reloaded.layers));

// A state that declares no place index must not go looking for one. The fetch
// would 404 on every search, and the retry-next-time path makes that one per
// keystroke -- so the declaration has to be honoured, not discovered.
const searched = await page.evaluate(async () => {
  const asked = [];
  const realFetch = window.fetch;
  window.fetch = (input, init) => { asked.push(String(input)); return realFetch(input, init); };
  await ensurePlaces();
  window.fetch = realFetch;
  return {
    count: Array.isArray(placesIndex) ? placesIndex.length : -1,
    wentLooking: asked.some((url) => url.includes('places.json')),
    // Whatever it holds, it must not still be the previous state's index.
    hasSeattle: (placesIndex || []).some((row) => row[0] === 'Seattle'),
  };
});
check('a state with no place index does not go fetching one',
  searched.wentLooking === false && searched.count === 0 && !searched.hasSeattle,
  JSON.stringify(searched));

// Routing must fail flat, once, with the reason -- not retry a URL that 404s
// and report it as a connection problem.
const routeAttempt = await page.evaluate(async () => {
  routing.ready = false; routing.loading = false; routing.worker = null;
  await ensureRouter();
  return {
    ready: routing.ready,
    loading: routing.loading,
    status: document.getElementById('route-status')?.textContent || '',
  };
});
check('asking a state with no graph to route says so instead of retrying a 404',
  routeAttempt.ready === false && routeAttempt.loading === false
    && /no routing map yet/i.test(routeAttempt.status), JSON.stringify(routeAttempt));

// Leave the browser profile as it was found.
await page.evaluate(() => localStorage.removeItem(Region.storageKey));

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
