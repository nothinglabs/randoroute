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
for (let index = 0; index < scenarios.length; index++) {
  const scenario = scenarios[index];
  messages.length = 0;
  context.onmessage({ data: { type: 'route-options', id: index + 1,
    points: scenario.points, rules, forceDesignated: false,
    forceResidential: false } });
  const result = messages.at(-1);
  if (!result?.ok) {
    console.log(`${scenario.name}: FAIL — ${result?.reason || 'no response'}`);
    continue;
  }
  console.log(`${scenario.name}: ${result.options.length} option(s), ${result.ms} ms`);
  for (const option of result.options) {
    console.log(`  ${option.optimization.label}: ${(option.distM / 1609.344).toFixed(1)} mi; `
      + `${Math.round(option.failM)} m fail; ${Math.round(option.walkM || 0)} m walk; `
      + `${Math.round(option.hazardM || 0)} m curve caution; `
      + `${Math.round(option.freewayM)} m freeway`);
  }
}
