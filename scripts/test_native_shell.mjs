import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, config, packageJson, index, builder] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../capacitor.config.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('./build_mobile_shell.mjs', import.meta.url), 'utf8'),
]);

assert.equal(config.webDir, 'mobile-shell');
assert.equal(config.server, undefined, 'native app must not depend on a remote HTML shell');
assert.match(packageJson.scripts['ios:sync'], /ios:prepare-shell.*cap sync ios/);
assert.match(packageJson.scripts['ios:build'], /ios:prepare-shell.*cap build ios/);

for (const asset of [
  'index.html',
  'styles.css',
  'app.js',
  'router-worker.js',
  'route-details.html',
  'route-details.css',
  'route-details.js',
  'vendor/maplibre-gl.js',
  'vendor/maplibre-gl.css',
  'vendor/pmtiles.js',
  'data/bikeroutes.geojson',
  'data/blts.geojson',
  'data/bikeinfra.geojson',
  'data/bike_restrictions.geojson',
  'data/route_closures.geojson',
  'data/roads.pmtiles',
  'data/graph2.bin.gz',
  'data/places.json',
]) {
  assert.ok(builder.includes(`'${asset}'`), `native shell builder omits ${asset}`);
}

assert.doesNotMatch(app, /nothinglabs\.github\.io/);
assert.match(app, /fetch\('data\/places\.json'\)/);
assert.match(app, /fetch\(`data\/graph2\.bin\.gz\?format=/);
assert.match(app, /vector: 'pmtiles:\/\/data\/roads\.pmtiles\?v=10'/);
assert.match(index, /if \(!isNativeShell && 'serviceWorker' in navigator\)/);

console.log('Self-contained native shell and runtime datasets verified.');
