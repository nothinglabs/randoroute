import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, config, packageJson, index, builder, basemap, details, serviceWorker] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../capacitor.config.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('./build_mobile_shell.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../basemap-style.js', import.meta.url), 'utf8'),
  readFile(new URL('../route-details.js', import.meta.url), 'utf8'),
  readFile(new URL('../sw.js', import.meta.url), 'utf8'),
]);

assert.equal(config.webDir, 'mobile-shell');
assert.equal(config.server, undefined, 'native app must not depend on a remote HTML shell');
assert.match(packageJson.scripts['ios:sync'], /ios:prepare-shell.*cap sync ios/);
assert.match(packageJson.scripts['ios:build'], /ios:prepare-shell.*cap build ios/);

for (const asset of [
  'index.html',
  'styles.css',
  'app.js',
  'basemap-style.js',
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
  'data/basemap.pmtiles',
  'data/graph2.bin.gz',
  'data/places.json',
  'fonts/Klokantech Noto Sans Regular/0-255.pbf',
  'fonts/Klokantech Noto Sans Regular/256-511.pbf',
]) {
  assert.ok(builder.includes(`'${asset}'`), `native shell builder omits ${asset}`);
}

assert.doesNotMatch(app, /nothinglabs\.github\.io/);
assert.match(app, /fetch\('data\/places\.json'\)/);
assert.match(app, /fetch\(`data\/graph2\.bin\.gz\?format=/);
for (const runtime of [app, basemap, details, serviceWorker]) {
  assert.doesNotMatch(runtime, /basemaps\.cartocdn\.com|cartodb|© CARTO/i,
    'core map runtime must not depend on the old online CARTO basemap');
}
assert.match(index, /<script src="basemap-style\.js"><\/script>/);
assert.match(index, /if \(!isNativeShell && 'serviceWorker' in navigator\)/);
assert.match(basemap, /pmtiles:\/\/data\/basemap\.pmtiles/);
assert.match(basemap, /pmtiles:\/\/data\/roads\.pmtiles/);
assert.match(basemap, /fonts\/\{fontstack\}\/\{range\}\.pbf/,
  'vector labels should use the bundled local glyph ranges');
assert.match(app, /mapSourceId:\s*'basemap-roads'/,
  'the safety overlay should reuse the basemap road source');

console.log('Self-contained native shell and runtime datasets verified.');
