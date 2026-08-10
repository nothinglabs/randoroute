#!/usr/bin/env node
// Why does forcing a waypoint produce a better route than asking for the same
// trip without one?
//
// Runs the two requests against the production graph on the Randonneur (default)
// rules and prints every option each returns, with the numbers that decide it:
// riding time, which IS the router's cost before multipliers, alongside the
// distance and facility mileage a rider actually sees.
//
// A* is optimal per profile and the heuristic is admissible, so a route the
// router does not return is one it priced higher, not one it missed. The
// question is only by how much.
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const graph = zlib.gunzipSync(fs.readFileSync(new URL('../maps/washington/graph2.bin.gz', import.meta.url)));
const messages = [];
const context = vm.createContext({
  console, Date, Math, Map, Set, TextDecoder,
  ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array,
  Int32Array, Uint8Array, Uint16Array, Uint32Array,
  postMessage: (m) => messages.push(m),
});
// The worker pulls in the shared verdict model with importScripts(); mirror
// that so this context is the same environment a browser gives it.
context.importScripts = (...names) => {
  for (const n of names) {
    vm.runInContext(fs.readFileSync(new URL(`../${n}`, import.meta.url), 'utf8'), context);
  }
};
context.self = context;
vm.runInContext(fs.readFileSync(new URL('../router-worker.js', import.meta.url), 'utf8'), context);
const buf = graph.buffer.slice(graph.byteOffset, graph.byteOffset + graph.byteLength);
context.onmessage({ data: { type: 'graph', buffer: buf } });

// The Randonneur preset is DEFAULT_RULES verbatim; lifted from app.js so this
// cannot drift from what the app actually ships.
const appSrc = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const at = appSrc.indexOf('const DEFAULT_RULES');
const box = { out: null };
vm.createContext(box);
vm.runInContext(appSrc.slice(at, appSrc.indexOf('\n});', at) + 4)
  .replace('const DEFAULT_RULES', 'out'), box);
const rules = box.out;
console.log('Randonneur rules:', JSON.stringify(rules));

const seattle = [-122.3321, 47.6062];      // downtown
const phinney = [-122.35403, 47.67213];
const mukilteo = [-122.29704, 47.95067];

// "Heavily prefer bike routes & trails" and "Prefer residential streets" are
// both on by default in the app, so the probe matches a stock install.
function run(label, points) {
  messages.length = 0;
  context.onmessage({ data: { type: 'route-options', id: 1, points, rules,
    forceDesignated: true, forceResidential: true } });
  const result = messages.at(-1);
  if (!result?.ok) { console.log(`\n${label}: FAILED — ${result?.reason || 'no reply'}`); return []; }
  console.log(`\n${label}  (${result.options.length} options)`);
  console.log('  ' + 'profile'.padEnd(22) + 'mi'.padStart(7) + 'time'.padStart(9)
    + 'fail m'.padStart(9) + 'facility mi'.padStart(13) + 'desig mi'.padStart(10));
  const rows = result.options.map((o) => {
    const timeS = o.segs.reduce((s, g) => s + (Number(g.timeS) || 0), 0);
    const row = {
      id: o.optimization.profileId || o.optimization.label,
      mi: o.distM / 1609.344, timeS,
      failM: o.failM, facMi: o.facilityM / 1609.344, desMi: o.desigM / 1609.344,
    };
    console.log('  ' + String(row.id).padEnd(22)
      + row.mi.toFixed(1).padStart(7)
      + `${Math.floor(timeS / 3600)}h${String(Math.round(timeS % 3600 / 60)).padStart(2, '0')}`.padStart(9)
      + Math.round(row.failM).toString().padStart(9)
      + row.facMi.toFixed(1).padStart(13)
      + row.desMi.toFixed(1).padStart(10));
    return row;
  });
  return rows;
}

const withVia = run('WITH a Phinney Ridge waypoint', [seattle, phinney, mukilteo]);
const direct = run('WITHOUT the waypoint', [seattle, mukilteo]);

if (withVia.length && direct.length) {
  const best = (rows, key) => rows.reduce((a, b) => (b[key] < a[key] ? b : a));
  const viaBest = best(withVia, 'timeS');
  const dirBest = best(direct, 'timeS');
  const viaFac = withVia.reduce((a, b) => (b.facMi > a.facMi ? b : a));
  const dirFac = direct.reduce((a, b) => (b.facMi > a.facMi ? b : a));
  console.log('\n--- what the router is choosing between -------------------------');
  console.log(`  fastest with the waypoint   ${viaBest.mi.toFixed(1)} mi, `
    + `${(viaBest.timeS / 3600).toFixed(2)} h, ${viaBest.facMi.toFixed(1)} mi facility`);
  console.log(`  fastest without it          ${dirBest.mi.toFixed(1)} mi, `
    + `${(dirBest.timeS / 3600).toFixed(2)} h, ${dirBest.facMi.toFixed(1)} mi facility`);
  console.log(`  most facility with          ${viaFac.mi.toFixed(1)} mi, `
    + `${(viaFac.timeS / 3600).toFixed(2)} h, ${viaFac.facMi.toFixed(1)} mi facility`);
  console.log(`  most facility without       ${dirFac.mi.toFixed(1)} mi, `
    + `${(dirFac.timeS / 3600).toFixed(2)} h, ${dirFac.facMi.toFixed(1)} mi facility`);
  const gap = 100 * (viaFac.timeS - dirBest.timeS) / dirBest.timeS;
  console.log(`\n  the waypoint route costs ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}% more riding time`
    + ` than the best the router will return on its own,`);
  console.log(`  and carries ${(viaFac.facMi - dirFac.facMi).toFixed(1)} mi more bike facility`
    + ` than the most it offers without the waypoint.`);
}
