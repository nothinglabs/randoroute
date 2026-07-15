#!/usr/bin/env node
// Load the production graph and worker without a browser, then print compact
// route-option outcomes. Useful after every graph rebuild.
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const scenarios = process.argv[2] ? JSON.parse(process.argv[2]) : [
  { name: 'Seattle neighborhood', points: [[-122.391, 47.689], [-122.350, 47.673]] },
  { name: 'SR 104 / Olympic Peninsula', points: [[-122.76876, 48.11328], [-123.11194, 48.08264]] },
];
const graph = zlib.gunzipSync(fs.readFileSync(new URL('../data/graph2.bin.gz', import.meta.url)));
const messages = [];
const context = vm.createContext({
  console, Date, Math, Map, Set, TextDecoder,
  ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
  Int32Array, Uint8Array, Uint16Array, Uint32Array,
  postMessage(message) { messages.push(message); },
});
vm.runInContext(fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8'), context);
const buffer = graph.byteOffset === 0 && graph.byteLength === graph.buffer.byteLength
  ? graph.buffer : graph.buffer.slice(graph.byteOffset, graph.byteOffset + graph.byteLength);
context.onmessage({ data: { type: 'graph', buffer } });

const rules = {
  allowFreeways: true, minShoulder: 4, unknownShoulderZero: true,
  freeMaxSpeed: 35, upperMaxSpeed: 45, noUpperLimit: true, requireSafe: false,
};
const sweepProfiles = [
  ['quick', 'direct', false, false], ['quick-bike', 'direct', true, false],
  ['quick-residential', 'direct', false, true], ['quick-friendly', 'direct', true, true],
  ['efficient', 'balanced', false, false], ['bike', 'balanced', true, false],
  ['residential', 'balanced', false, true], ['bike-residential', 'balanced', true, true],
  ['gentle', 'low', false, false], ['gentle-bike', 'low', true, false],
  ['gentle-residential', 'low', false, true], ['friendly', 'low', true, true],
];
function distanceM(a, b) {
  const r = 6371000, p1 = a[1] * Math.PI / 180, p2 = b[1] * Math.PI / 180;
  const dp = p2 - p1, dl = (b[0] - a[0]) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}
for (let index = 0; index < scenarios.length; index++) {
  const scenario = scenarios[index];
  messages.length = 0;
  context.onmessage({ data: { type: 'route-options', id: index + 1,
    points: scenario.points, rules, forceDesignated: false,
    forceResidential: false, weights: scenario.weights, debug: !!scenario.debugStages } });
  const result = messages.at(-1);
  if (!result?.ok) {
    console.log(`${scenario.name}: FAIL — ${result?.reason || 'no response'}`);
    continue;
  }
  console.log(`${scenario.name}: ${result.options.length} option(s), ${result.ms} ms`);
  if (result.debug) console.log('  stages:', JSON.stringify(result.debug));
  for (const option of result.options) {
    const probeText = scenario.probe
      ? `; ${Math.round(Math.min(...option.coords.map((p) => distanceM(p, scenario.probe))))} m from probe`
      : '';
    console.log(`  ${option.optimization.label} [${option.optimization.profileId}; bike=${option.optimization.prefDesignated ? 'y' : 'n'}; residential=${option.optimization.prefResidential ? 'y' : 'n'}]: ${(option.distM / 1609.344).toFixed(1)} mi; `
      + `${Math.round(option.failM)} m fail; `
      + `${Math.round(option.hazardM || 0)} m curve caution; `
      + `${Math.round(option.freewayM)} m freeway; `
      + `${(option.desigM / 1609.344).toFixed(1)} mi designated; `
      + `${(option.facilityM / 1609.344).toFixed(1)} mi bike facility; `
      + `${(option.residentialM / 1609.344).toFixed(1)} mi residential; `
      + `${((option.longestFriendlyM || 0) / 1609.344).toFixed(1)} mi longest bike run${probeText}`);
  }
  if (scenario.profileSweep) {
    console.log('  all base profiles:');
    for (const [id, mode, prefDesignated, prefResidential] of sweepProfiles) {
      messages.length = 0;
      context.onmessage({ data: { type: 'route', id: 1000 + index,
        points: scenario.points, rules, mode, profileId: id,
        prefDesignated, prefResidential, weights: scenario.weights } });
      const option = messages.at(-1);
      if (!option?.ok) continue;
      console.log(`    ${id}: ${(option.distM / 1609.344).toFixed(1)} mi; `
        + `${option.failM.toFixed(2)} m fail; ${option.limitedAccessM.toFixed(2)} m limited; `
        + `${(option.desigM / 1609.344).toFixed(1)} mi designated; `
        + `${(option.facilityM / 1609.344).toFixed(1)} mi facility; `
        + `${(option.residentialM / 1609.344).toFixed(1)} mi residential`);
    }
  }
}
