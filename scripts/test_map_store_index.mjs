#!/usr/bin/env node
// The store index (maps/index.json) is the map-pack contract: what the
// registry builder promises, the installer trusts. So the promise must be
// TRUE -- every listed file exists at its listed size -- and the client must
// refuse a broken promise loudly rather than half-install one.
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, check, done } from './testlib/harness.mjs';

const { MAP_STATES, MAP_STATES_BUNDLED } = await import('node:module')
  .then(({ createRequire }) => createRequire(import.meta.url)(join(ROOT, 'maps/states.js')));
const { MapStore } = await import('node:module')
  .then(({ createRequire }) => createRequire(import.meta.url)(join(ROOT, 'map-store.js')));
const index = JSON.parse(readFileSync(join(ROOT, 'maps/index.json'), 'utf8'));

/* ------------------------------------------- the two registries agree */
check('the bundled registry declares its data present', MAP_STATES_BUNDLED === true);
check('index.json is storeFormat 1', index.storeFormat === 1);
check('index.json and states.js list the same states in the same order',
  index.states.map((state) => state.id).join('|') === MAP_STATES.map((state) => state.id).join('|'),
  index.states.map((state) => state.id).join('|'));

/* --------------------------------------------- every promise is true */
for (const state of index.states) {
  const declared = Object.entries(state.datasets).filter(([, has]) => has).map(([key]) => key).sort();
  const listed = state.files.map((file) => file.dataset).sort();
  check(`${state.id}: one file per declared dataset`,
    declared.join('|') === listed.join('|'),
    `datasets ${declared.join(',')} vs files ${listed.join(',')}`);
  let sized = true;
  for (const file of state.files) {
    let stat = null;
    try { stat = statSync(join(ROOT, 'maps', state.id, file.path)); } catch (e) { /* missing */ }
    if (!stat || stat.size !== file.bytes) { sized = false; break; }
  }
  check(`${state.id}: every listed file exists at its listed size`, sized);
  check(`${state.id}: a nonzero total download size`, MapStore.stateBytes(state) > 0);
}

/* -------------------------------- the client refuses a broken promise */
const serveIndex = (body) => new Promise((resolve) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  server.listen(0, () => resolve({ server, url: `http://localhost:${server.address().port}/` }));
});
const goodState = {
  id: 'teststate', name: 'Test State', status: 'preview',
  bounds: { minLon: -1, minLat: -1, maxLon: 1, maxLat: 1 },
  defaultCenter: [0, 0], defaultZoom: 8,
  datasets: { places: true },
  files: [{ dataset: 'places', path: 'places.json', bytes: 10 }],
};
const rejects = async (body, why) => {
  const { server, url } = await serveIndex(body);
  let message = null;
  try { await MapStore.fetchIndex(url); } catch (error) { message = error.message; }
  server.close();
  check(`a store index with ${why} is refused`, !!message, message || 'accepted!');
};

{
  const { server, url } = await serveIndex({ storeFormat: 1, states: [goodState] });
  const fetched = await MapStore.fetchIndex(url);
  server.close();
  check('a well-formed store index is accepted',
    fetched.states.length === 1 && fetched.states[0].id === 'teststate');
}
await rejects('this is not json {', 'invalid JSON');
await rejects({ storeFormat: 99, states: [goodState] }, 'an unknown format version');
await rejects({ storeFormat: 1, states: [] }, 'no states');
await rejects({ storeFormat: 1, states: [{ ...goodState, surprise: true }] }, 'an unknown key');
await rejects({ storeFormat: 1, states: [{ ...goodState, id: '../evil' }] }, 'a traversal state id');
await rejects({ storeFormat: 1, states: [{ ...goodState, files: [{ dataset: 'places', path: '../evil.json', bytes: 5 }] }] },
  'a traversal file path');
await rejects({ storeFormat: 1, states: [{ ...goodState, files: [{ dataset: 'places', path: 'places.json' }] }] },
  'a file with no size');
await rejects({ storeFormat: 1, states: [{ ...goodState, files: [] }] }, 'a state with no files');

check('a plain-HTTP store address is refused', (() => {
  try { MapStore.normalizeStoreUrl('http://example.com/maps/'); return false; } catch (e) { return true; }
})());
check('a localhost HTTP store address is allowed for development', (() => {
  try { return MapStore.normalizeStoreUrl('http://localhost:8000/maps') === 'http://localhost:8000/maps/'; }
  catch (e) { return false; }
})());

done();
