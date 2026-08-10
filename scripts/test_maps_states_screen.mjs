#!/usr/bin/env node
// One state at a time, and choosing one is the whole mechanism: every data path
// in the app, the router worker and the service worker is built from
// Region.dataRoot, so the Maps screen writes a state id, and a reload does the
// rest.
//
// The screen shows all fifty so the eventual scope is visible. The ones with a
// maps/<state>/ folder are selectable and say what they can actually do; the
// rest refuse the tap rather than accepting it and doing nothing. It has to be
// radios: a checkbox promises that two can be on at once, which is exactly what
// this cannot do.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT } from './testlib/harness.mjs';

const { MAP_STATES } = createRequire(import.meta.url)(join(ROOT, 'maps/states.js'));

const site = await serveRepo();
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
    // It opens a screen, so it must not claim to control a tab panel.
    role: button?.getAttribute('role'),
    haspopup: button?.getAttribute('aria-haspopup'),
    inTablist: !!button?.closest('[role="tablist"]'),
  };
});
check('Settings offers a Maps tab that announces itself as opening a dialog',
  tab.exists && tab.label === 'Maps' && tab.haspopup === 'dialog'
    && tab.role === null && tab.inTablist === false, JSON.stringify(tab));

await page.evaluate(() => openMapsDialog());
const screen = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#mapsStateList .maps-state')];
  const named = (row) => row.querySelector('.maps-state-name > span').textContent;
  const input = (row) => row.querySelector('input');
  return {
    open: document.getElementById('mapsDialog').open,
    lead: document.querySelector('.maps-lead')?.textContent,
    note: document.querySelector('.maps-note')?.textContent,
    count: rows.length,
    first: named(rows[0]),
    last: named(rows[rows.length - 1]),
    types: [...new Set(rows.map((row) => input(row).type))],
    group: [...new Set(rows.map((row) => input(row).name))],
    checked: rows.filter((row) => input(row).checked).map(named),
    enabled: rows.filter((row) => !input(row).disabled).map(named),
    loadedRegion: Region.name,
    // A full-screen surface, not a small dialog wedged over the map.
    fullScreen: document.getElementById('mapsDialog').classList.contains('full-help-dialog'),
  };
});
check('it opens a full-screen list of all fifty states, alphabetically',
  screen.open && screen.fullScreen && screen.count === 50
    && screen.first === 'Alabama' && screen.last === 'Wyoming', JSON.stringify(screen));
check('the controls are one radio group, because one state loads at a time',
  screen.types.join() === 'radio' && screen.group.length === 1, JSON.stringify(screen));
check('and the copy says so, and warns that switching restarts',
  /state to ride in/i.test(screen.lead || '')
    && /one state is loaded at a time/i.test(screen.note || '')
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

// A row has to say what the state can DO. "Oregon" alone invites a rider to
// select it and then wonder why no route comes back.
const detail = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#mapsStateList .maps-state')];
  const find = (name) => rows.find((row) =>
    row.querySelector('.maps-state-name > span').textContent === name);
  const wa = find('Washington');
  const or = find('Oregon');
  const al = find('Alabama');
  return {
    washington: wa?.querySelector('.maps-state-detail')?.textContent,
    oregon: or?.querySelector('.maps-state-detail')?.textContent,
    unavailableDetail: al?.querySelector('.maps-state-detail'),
    badges: rows.map((row) => row.querySelector('.maps-state-badge')?.textContent)
      .filter(Boolean),
  };
});
check('a finished state says it can route', /routing/i.test(detail.washington || ''),
  detail.washington);
check('a preview state says what it is missing',
  /no routing/i.test(detail.oregon || ''), detail.oregon);
check('and carries a Preview badge beside the loaded one',
  detail.badges.includes('Preview') && detail.badges.includes('Loaded'),
  JSON.stringify(detail.badges));
check('a state with no folder makes no claim at all',
  detail.unavailableDetail === null, String(detail.unavailableDetail));

// An unavailable state must refuse the tap rather than take it and do nothing.
const inert = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#mapsStateList .maps-state')];
  const alabama = rows.find((row) =>
    row.querySelector('.maps-state-name > span').textContent === 'Alabama');
  const input = alabama.querySelector('input');
  input.click();
  return { checked: input.checked, disabled: input.disabled };
});
check('tapping a state with no map changes nothing',
  inert.checked === false && inert.disabled === true, JSON.stringify(inert));

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
  document.querySelector('#mapsDialog [data-close]').click();
  return document.getElementById('mapsDialog').open;
});
check('closing leaves the screen', closed === false);

/* --------------------------------------------------- and then actually switch */
// The switch ends in a reload, so the only honest way to test it is to let it
// happen and look at what comes back. A route is set first: it belongs to the
// graph about to be unloaded, and it must not survive.
const preview = MAP_STATES.find((state) => state.status === 'preview');
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
// Oregon has a basemap and no street tiles. A MapLibre source whose archive
// 404s never finishes loading, so the style would hang and `load` never fire --
// the whole app stuck on its launch screen.
check('a source the state does not ship is not in the style at all',
  reloaded.styleSources.includes('basemap-context')
    && !reloaded.styleSources.includes('basemap-roads'),
  JSON.stringify(reloaded.styleSources));
// Oregon ships no scored linework at all, so the correct answer is an empty
// layer list -- not one entry per layer whose file 404s.
check('and neither are the layers that would draw from it',
  !reloaded.layers.includes('roads') && !reloaded.layers.includes('blts'),
  JSON.stringify(reloaded.layers));

// Place search is the one thing a preview state can do, and it must really
// search THAT state's index.
const searched = await page.evaluate(async () => {
  await ensurePlaces();
  return {
    count: Array.isArray(placesIndex) ? placesIndex.length : -1,
    hasPortland: (placesIndex || []).some((row) => row[0] === 'Portland'),
    hasSeattle: (placesIndex || []).some((row) => row[0] === 'Seattle'),
  };
});
check('place search runs on the new state\'s index, not the old one',
  searched.count > 100 && searched.hasPortland && !searched.hasSeattle,
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
