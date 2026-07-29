#!/usr/bin/env node
// The statewide road measurements are packed into the graph by Python
// (build_graph.py) and unpacked by JavaScript (router-worker.js). Two languages,
// one bit layout, no shared header -- so this test packs with the real Python
// code and unpacks with the real JavaScript code, and checks they agree.
//
// It also checks that a road tile and a route segment produce the same
// measurement rows, since the whole point of importing this is that the two
// cards describe one road identically.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import vm from 'node:vm';

const here = (p) => new URL(p, import.meta.url);
const workerSrc = fs.readFileSync(here('../router-worker.js'), 'utf8');
const appSrc = fs.readFileSync(here('../app.js'), 'utf8');

function lift(src, name, label) {
  const re = new RegExp(`\\nfunction ${name}\\s*\\([^)]*\\)\\s*\\{`);
  const at = src.search(re);
  assert.notEqual(at, -1, `${label} should define ${name}`);
  let depth = 0;
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at + 1, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function constsOf(src, names) {
  return names.map((n) => {
    const m = new RegExp(`const ${n} = ([^;]+);`).exec(src);
    assert.ok(m, `expected const ${n}`);
    return `var ${n} = ${m[1]};`;
  }).join('\n');
}

/* ---------------------------------------- the worker's unpacking, in isolation */
const ctx = {};
vm.createContext(ctx);
vm.runInContext(constsOf(workerSrc,
  ['MEASURE_UNKNOWN', 'EDGE_SPACE_CLAMPED', 'ADT_YEAR_EPOCH', 'ADT_SOURCE_STATE']), ctx);
vm.runInContext(lift(workerSrc, 'edgeMeasures', 'router-worker.js'), ctx);

// edgeMeasures reads the module-level typed arrays; give it one-element ones.
function unpack(row) {
  ctx.eEdgeSpace = Uint8Array.from([row.space]);
  ctx.eCountyShoulder = Uint8Array.from([row.countyShoulder]);
  ctx.eAdt = Uint16Array.from([row.adt]);
  ctx.eAdtMeta = Uint8Array.from([row.adtMeta]);
  ctx.eClassOwner = Uint8Array.from([row.classOwner]);
  return ctx.edgeMeasures(0);
}

/* --------------------------------------------- pack with the real Python code */
const CASES = [
  { edge: 5.0, clamp: 1, shP: null, adt: 2357, year: 2016, state: false, fc: 6, owner: 2 },
  { edge: 0.0, clamp: 0, shP: 0.0, adt: 140, year: 1999, state: false, fc: 7, owner: 2 },
  { edge: 12.0, clamp: 0, shP: 8.0, adt: 14000, year: 2025, state: true, fc: 3, owner: 1 },
  { edge: null, clamp: 0, shP: null, adt: 0, year: null, state: false, fc: 0, owner: 4 },
  // 127 with the clamp bit set would be 255, the "not known" sentinel, so the
  // packer saturates one lower. Pinned here because the collision is silent.
  { edge: 127.0, expectEdge: 126, clamp: 1, shP: 254.0, adt: 65535, year: 2035,
    state: true, fc: 7, owner: 4 },
  // Year below the epoch, and a count with no year at all: both must decode to
  // "no year" rather than to a fictional one.
  { edge: 3.0, clamp: 0, shP: null, adt: 900, year: 1939, state: false, fc: 5, owner: 2 },
  { edge: 3.0, clamp: 0, shP: null, adt: 900, year: null, state: false, fc: 5, owner: 2 },
];

const SCRIPTS = new URL('.', import.meta.url).pathname;
const py = [
  'import json, sys, os, importlib.util',
  `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
  `spec = importlib.util.spec_from_file_location('bg', os.path.join(${JSON.stringify(SCRIPTS)}, 'build_graph.py'))`,
  'bg = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(bg)',
  'out = []',
  'for c in json.loads(sys.stdin.read()):',
  '    out.append({',
  "        'space': bg.pack_edge_space(c['edge'], c['clamp']),",
  "        'countyShoulder': bg.pack_county_shoulder(c['shP']),",
  "        'adt': max(0, min(65535, int(c['adt'] or 0))),",
  "        'adtMeta': bg.pack_adt_meta(c['year'], c['state']),",
  "        'classOwner': bg.pack_class_owner(c['fc'], c['owner']),",
  '    })',
  'print(json.dumps(out))',
].join('\n');

const packed = JSON.parse(execFileSync('python3', ['-c', py], {
  input: JSON.stringify(CASES), encoding: 'utf8',
}));
assert.equal(packed.length, CASES.length);

let checks = 0;
CASES.forEach((c, i) => {
  const got = unpack(packed[i]) || {};
  const label = `case ${i}`;

  if (c.edge === null) {
    assert.equal(got.edge, undefined, `${label}: unknown edge space must stay unknown`);
  } else {
    assert.equal(got.edge, c.expectEdge ?? Math.round(c.edge), `${label}: edge space`);
    assert.equal(got.edgeClamp || 0, c.clamp, `${label}: clamp bit`);
  }

  if (c.shP === null) {
    assert.equal(got.countySh, undefined,
      `${label}: an uninventoried shoulder must not decode as 0 ft`);
  } else {
    assert.equal(got.countySh, Math.round(c.shP), `${label}: county shoulder`);
  }

  if (!c.adt) {
    assert.equal(got.adt, undefined, `${label}: no count`);
  } else {
    assert.equal(got.adt, c.adt, `${label}: adt`);
    assert.equal(got.adtState, c.state ? 1 : 0, `${label}: count source`);
    const expectYear = (c.year && c.year - 1940 > 0 && c.year - 1940 <= 127) ? c.year : undefined;
    assert.equal(got.adty, expectYear, `${label}: count year`);
  }

  assert.equal(got.fc, c.fc || undefined, `${label}: functional class`);
  assert.equal(got.owner, c.owner || undefined, `${label}: owner`);
  checks++;
});
console.log(`PASS  ${checks} rows survive the Python pack -> JavaScript unpack round trip`);

/* ------------------------- the tile shape and the segment shape must agree */
const app = {};
vm.createContext(app);
vm.runInContext(lift(appSrc, 'tileMeasures', 'app.js'), app);

// The same road, once as a roads-tile feature and once as an edge in the graph.
const tile = { adt: 2357, ay: 2016, as: 0, es: 5, ec: 1, cs: null, fc: 6, ow: 2 };
const fromTile = app.tileMeasures(tile);
const fromEdge = unpack(packed[0]);
assert.deepEqual(
  { adt: fromTile.adt, adty: fromTile.adty, adtState: fromTile.adtState,
    edge: fromTile.edge, edgeClamp: fromTile.edgeClamp, fc: fromTile.fc, owner: fromTile.owner },
  { adt: fromEdge.adt, adty: fromEdge.adty, adtState: fromEdge.adtState,
    edge: fromEdge.edge, edgeClamp: fromEdge.edgeClamp, fc: fromEdge.fc, owner: fromEdge.owner },
  'a roads tile and a graph edge should describe one road identically');
console.log('PASS  the tile shape and the graph-edge shape agree');

/* ------------------------------------------ every row states its provenance */
const rowsCtx = {};
vm.createContext(rowsCtx);
vm.runInContext(
  appSrc.match(/const FUNCTIONAL_CLASS_NAME = \{[\s\S]*?\n\};/)[0].replace('const ', 'var ') + '\n'
  + appSrc.match(/const ROAD_OWNER_NAME = \{[^}]*\};/)[0].replace('const ', 'var ') + '\n'
  + appSrc.match(/const OSM_CLASS_TO_FUNCTIONAL = \{[\s\S]*?\n\};/)[0].replace('const ', 'var '),
  rowsCtx);
vm.runInContext(lift(appSrc, 'measurementRows', 'app.js'), rowsCtx);
vm.runInContext(lift(appSrc, 'roadClassRow', 'app.js'), rowsCtx);

const rows = rowsCtx.measurementRows(fromEdge);
const byLabel = Object.fromEntries(rows);
assert.equal(byLabel.Traffic, '2,357/day (county 2016)',
  'a count is shown with the inventory it came from and the year it was taken');
assert.equal(byLabel['Edge space'], '~5 ft (derived, capped)',
  'derived space is tagged as derived, and a capped lane width says so');

// Every row must fit a phone line rather than wrapping the popup into a scroll.
for (const [label, value] of rows) {
  assert.ok(`${label} ${value}`.length <= 44,
    `row too long for a phone card: "${label}: ${value}"`);
}

const stateCount = rowsCtx.measurementRows({ adt: 14000, adty: 2025, adtState: 1 });
assert.equal(Object.fromEntries(stateCount).Traffic, '14,000/day (state 2025)',
  'a state count is shown the same way, tagged as state');
const oldCount = rowsCtx.measurementRows({ adt: 1200, adty: 1977, adtState: 0 });
assert.equal(Object.fromEntries(oldCount).Traffic, '1,200/day (county 1977)',
  'the year alone flags an old count; it needs no adjective');
const noYear = rowsCtx.measurementRows({ adt: 1200, adtState: 0 });
assert.equal(Object.fromEntries(noYear).Traffic, '1,200/day (county)',
  'a count with no year says nothing rather than implying one');

/* ------------------- OSM and FHWA class collapse onto one row and one scale */
// The card used to show "Road class: Secondary road" beside "Class: Minor
// arterial" and leave the rider to work out that those are the same statement.
const classRow = (measures, osmClass, fallback) =>
  Object.fromEntries(rowsCtx.roadClassRow(measures, osmClass, fallback)).Class;

assert.equal(classRow(fromEdge, 4), 'Minor collector (FHWA, county)',
  'an official class wins and names its owner');
assert.equal(classRow(null, 4), 'Major collector (OSM)',
  'OSM tertiary maps onto the same scale, tagged as inferred');
assert.equal(classRow({ adt: 5 }, 6), 'Minor arterial (OSM)',
  'measurements without a class still fall back to OSM');
assert.equal(classRow(null, 1), 'Local street (OSM)', 'residential is local');
assert.equal(classRow(null, 12), 'Freeway or expressway (OSM)',
  'nothing in OSM distinguishes an Interstate, so motorway must not claim class 1');
assert.equal(classRow(null, 0, 'busway'), 'busway',
  'a highway type outside the table still shows something');
assert.equal(rowsCtx.roadClassRow(null, 0, null).length, 0,
  'nothing known, no row');

// Both sources must land in the same vocabulary, or consolidating them is
// cosmetic. Every OSM class maps to a name the FHWA table also uses.
for (const osmClass of Object.keys(rowsCtx.OSM_CLASS_TO_FUNCTIONAL)) {
  const value = classRow(null, Number(osmClass));
  assert.ok(/\(OSM\)$/.test(value), `OSM class ${osmClass} should be tagged OSM`);
  const name = value.replace(' (OSM)', '');
  assert.ok(Object.values(rowsCtx.FUNCTIONAL_CLASS_NAME).includes(name),
    `OSM class ${osmClass} produced "${name}", which is not an FHWA class name`);
}
console.log('PASS  OSM and FHWA classes share one row, one scale, one vocabulary');

// deepEqual would compare across vm realms, where Array.prototype differs.
assert.equal(rowsCtx.measurementRows(null).length, 0, 'no measurements, no rows');
console.log('PASS  every row is tagged with its provenance and fits a phone line');

console.log(`\n${checks + 3} checks, 0 failed`);
