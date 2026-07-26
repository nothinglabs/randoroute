import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const overlays = [
  'bikeroutes.geojson',
  'blts.geojson',
  'bikeinfra.geojson',
  'bike_restrictions.geojson',
  'route_closures.geojson',
];

let rawBytes = 0;
let compressedBytes = 0;
for (const name of overlays) {
  const rawUrl = new URL(`../data/${name}`, import.meta.url);
  const gzipUrl = new URL(`../data/${name}.gz`, import.meta.url);
  const [raw, compressed, rawInfo, gzipInfo] = await Promise.all([
    readFile(rawUrl),
    readFile(gzipUrl),
    stat(rawUrl),
    stat(gzipUrl),
  ]);
  assert.deepEqual(gunzipSync(compressed), raw, `${name}.gz differs from its source`);
  assert.doesNotThrow(() => JSON.parse(raw), `${name} is not valid JSON`);
  rawBytes += rawInfo.size;
  compressedBytes += gzipInfo.size;
}

assert.ok(compressedBytes < rawBytes * 0.25,
  `compressed overlays should be under 25% of raw size (${compressedBytes}/${rawBytes})`);
console.log(`Compressed overlays verified: ${rawBytes} -> ${compressedBytes} bytes`);
