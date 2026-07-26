import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, config, packageJson, index, nativeIndex, styles, builder, basemap, details, serviceWorker] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../capacitor.config.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../ios/App/App/public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
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
  'fonts/Klokantech Noto Sans Regular/512-767.pbf',
  'fonts/Klokantech Noto Sans Regular/768-1023.pbf',
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
assert.match(nativeIndex, /id="techDetailsBtn"[^>]*>Tech Details<\/button>[\s\S]*?id="techDetailsDialog"[\s\S]*?Natural Earth 1:10m land[\s\S]*?WSDOT Active Transportation Data/,
  'the native bundle should include the complete technical map and data help');
assert.match(index, /id="iosAppVersionLabel"[^>]*hidden[^>]*>iOS App Version<\/span>/,
  'the shared shell should provide a native-only plain app-version label');
assert.match(app, /nativeAppVersionOnly[\s\S]*?checkUpdatesBtn'\)\.hidden = true[\s\S]*?iosAppVersionLabel'\)\.hidden = false/,
  'the native runtime should hide the unsupported update button');
assert.match(basemap, /pmtiles:\/\/data\/basemap\.pmtiles/);
assert.match(basemap, /pmtiles:\/\/data\/roads\.pmtiles/);
assert.match(basemap, /fonts\/\{fontstack\}\/\{range\}\.pbf/,
  'vector labels should use the bundled local glyph ranges');
assert.match(basemap, /const ROAD_MIN_ZOOM = \{\s*major:\s*5,\s*medium:\s*8,\s*local:\s*11\s*\}[\s\S]*?ROAD_CLASSES,[\s\S]*?ROAD_MIN_ZOOM,/,
  'the local basemap should expose one shared set of road-class zoom thresholds');
assert.match(app, /mapSourceId:\s*'basemap-roads'/,
  'the safety overlay should reuse the basemap road source');
assert.match(app, /if \(src\.id === 'blts'\)[\s\S]*?map\.setFilter\(id, \['boolean', false\]\)/,
  'overlapping directional WSDOT inventory lines should remain queryable but not be double-painted');
assert.match(app, /limited_access:\s*p\.m === 1 \|\| p\.l === 1/,
  'WSDOT limited-access context conflated onto road tiles should affect the visible verdict');
assert.match(basemap, /'source-layer': 'land', maxzoom: 8[\s\S]*?'source-layer': 'land_detail', minzoom: 8/,
  'precise OSM coastline land should replace generalized regional land at close zooms');
assert.doesNotMatch(builder, /data\/(?:bikeroutes|blts|bikeinfra|bike_restrictions|route_closures)\.geojson\.gz'/,
  'the native shell should use the full uncompressed overlay copies');
assert.match(app, /const SAFETY_ROAD_INTERIOR_WIDTH = \['interpolate'[\s\S]*?5,\s*0\.6,\s*8,\s*1\.1,\s*11,\s*2\.2,\s*14,\s*4\.7,\s*17,\s*9\]/,
  'safety colors should fill the same road interior width used by the local basemap');
assert.match(app, /\[BIKE_NETWORK_COLOR,\s*'Road with bike facility'\]/,
  'the solid-lime legend should describe on-road bike facilities');
assert.match(styles, /#topToolbar\s*\{[\s\S]*?top:\s*0;[\s\S]*?padding-top:\s*calc\(env\(safe-area-inset-top\) \+ 4px\);/,
  'the endpoint toolbar should sit high in the safe area and catch taps above From/To');
assert.match(app, /firstBasemapLabel[\s\S]*?l\.type === 'symbol'[\s\S]*?return firstBasemapLabel\.id/,
  'basemap street labels should remain above the colored safety road interiors');
assert.match(app, /return \['step', \['zoom'\],[\s\S]*?BikeBasemap\.ROAD_MIN_ZOOM\.major,[\s\S]*?ROAD_CLASS_MAJOR_EXPR[\s\S]*?BikeBasemap\.ROAD_MIN_ZOOM\.medium,[\s\S]*?ROAD_CLASS_MEDIUM_EXPR[\s\S]*?BikeBasemap\.ROAD_MIN_ZOOM\.local,[\s\S]*?ROAD_CLASS_LOCAL_EXPR/,
  'safety colors should appear at the same zoom threshold as each basemap road class');
assert.match(app, /id: trailId\(src\),[\s\S]*?minzoom: BikeBasemap\.ROAD_MIN_ZOOM\.local,[\s\S]*?id: trailDotsId\(src\),[\s\S]*?minzoom: BikeBasemap\.ROAD_MIN_ZOOM\.local,[\s\S]*?id: trailHitId\(src\),[\s\S]*?minzoom: BikeBasemap\.ROAD_MIN_ZOOM\.local,/,
  'trail safety styling and hit targets should wait for local-detail zoom');
assert.doesNotMatch(app, /RES_MIN_ZOOM/,
  'the old blanket residential safety zoom cutoff should be removed');
assert.match(app, /setPaintProperty\('route-fail', 'line-opacity', 0\.92 \+ 0\.08 \* p\)[\s\S]*?setPaintProperty\('route-fail', 'line-width', routeWidthExpression\(3 \* p\)\)/,
  'rule-failure animation should pulse the zoom-scaled width while remaining visibly red');
assert.match(app, /id: 'route-detail-highlight'[\s\S]*?'line-color': '#ffd45c'[\s\S]*?}, 'route-pass'\)/,
  'detail selections should use a warm halo beneath the route safety color');
assert.match(app, /src\.id === 'osm' \? \{ filter: \['boolean', false\] \}/,
  'the OSM on-road facility copy should not double-paint roads already colored by roads.pmtiles');
assert.match(details, /setPaintProperty\('route-preview-fail', 'line-opacity', 0\.92 \+ 0\.08 \* pulse\)[\s\S]*?setPaintProperty\('route-preview-fail', 'line-width', 4\.8 \+ 1\.4 \* pulse\)/,
  'route-preview failures should retain their red identity while pulsing');

console.log('Self-contained native shell and runtime datasets verified.');
