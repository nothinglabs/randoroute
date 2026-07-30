#!/usr/bin/env node
// The app's OSM classifier must not be stricter than the graph builder's.
//
// `scoreOSM()` in app.js and `classify_way()` in build_graph.py answer the same
// question — is this way bike infrastructure, and how good — for the card and
// for the router respectively. They are separate implementations in separate
// languages, so they drift, and when they drift the rider is told one thing and
// routed by another.
//
// Two live bugs came from exactly this, both found by tapping around downtown
// Seattle:
//
//   * `highway=footway` + `bicycle=yes`: the router rides it, the app demanded
//     `designated`, so scoreOSM returned baseScore null while still reporting
//     `infra: true`. The model's infra rung turns that into level 0 and the card
//     said "Insufficient data" about a footway the route was using.
//   * `cycleway=shared_lane` + `bicycle=designated` on an arterial: sharrowOnly()
//     exempted it as a signed route, but scoreOSM had no branch that scored one,
//     so it fell through to the same null. Tapping 1st Avenue — a secondary
//     arterial whose speed, lanes and traffic count we hold — answered
//     "Insufficient data".
//
// The invariant that catches both, and anything like them:
//
//   **`infra: true` with `baseScore: null` must be impossible.**
//
// That pair is what produces level 0 from the infra rung, and level 0 means "we
// know nothing" — a claim the app has no business making about a way it has
// already decided is bike infrastructure.
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const appSrc = fs.readFileSync(ROOT + 'app.js', 'utf8');

// Lift just the classifier and its helpers.
function lift(startMarker, endMarker) {
  const i = appSrc.indexOf(startMarker);
  assert.notStrictEqual(i, -1, `app.js no longer contains ${startMarker}`);
  const end = appSrc.indexOf(endMarker, i);
  return appSrc.slice(i, end);
}
const box = vm.createContext({});
vm.runInContext([
  lift('const OSM_PROTECTED', '\nfunction scoreOSM'),
  lift('function scoreOSM', '\n// Full OSM road network'),
  'globalThis.OUT = { scoreOSM, sharrowOnly, osmCycleway };',
].join('\n'), box);
const { scoreOSM, sharrowOnly } = box.OUT;

const HIGHWAYS = ['cycleway', 'path', 'footway', 'bridleway', 'track', 'service',
  'residential', 'tertiary', 'secondary', 'primary', 'unclassified'];
const BIKE = [undefined, 'yes', 'designated', 'no', 'dismount', 'permissive'];
const CYCLEWAY = [undefined, 'lane', 'shared_lane', 'track', 'separated',
  'buffered_lane', 'opposite_lane'];
const EXTRA = [{}, { motor_vehicle: 'no' }, { access: 'private' }];

const combos = [];
for (const highway of HIGHWAYS) {
  for (const bicycle of BIKE) {
    for (const cycleway of CYCLEWAY) {
      for (const extra of EXTRA) {
        const tags = { highway, ...extra };
        if (bicycle) tags.bicycle = bicycle;
        if (cycleway) tags.cycleway = cycleway;
        combos.push(tags);
      }
    }
  }
}

/* ---- gates: what the tiles contain, and what the router rides ---------- */
// Only combinations build_osm.py actually EXPORTS can reach the osm layer, and
// only those build_graph.py calls infra can be routed over. Asserting against
// every imaginable tag set would flag pairs that never occur in the data.
const py0 = `
import importlib.util, json, sys
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); sys.modules[name] = m
    spec.loader.exec_module(m); return m
bo = load('bo', 'build_osm.py')
bg = load('bg', 'build_graph.py')
out = []
for tags in json.load(sys.stdin):
    base, prohibited = bo.classify(tags)
    r = bg.classify_way(tags)
    out.append({'exported': base is not None,
                'routerInfra': bool(r.get('infra')) if r else False})
print(json.dumps(out))
`;
// cwd must be scripts/: build_graph.py imports its sibling `roadmeasure`, and
// from the repo root that import fails -- silently enough that an earlier
// version of this test compared against garbage.
const gate = spawnSync('python3', ['-c', py0], { input: JSON.stringify(combos),
  encoding: 'utf8', cwd: ROOT + 'scripts' });
assert.strictEqual(gate.status, 0, 'the builders could not be run: ' + gate.stderr);
const gates = JSON.parse(gate.stdout.trim());
assert.strictEqual(gates.length, combos.length, 'gate list came back short');

/* ---- 1. the impossible pair -------------------------------------------- */
// scoreOSM always reports infra: true (it is the bike-infrastructure source),
// so a null baseScore is exactly the level-0 trap.
const trap = [];
for (let i = 0; i < combos.length; i++) {
  const tags = combos[i];
  if (!gates[i].exported) continue;          // never reaches the osm layer
  if (sharrowOnly(tags)) continue;           // deliberately excluded from it
  const n = scoreOSM(tags);
  if (n.infra && n.baseScore == null) trap.push(tags);
}
assert.deepStrictEqual(trap.slice(0, 8), [],
  'these tag combinations are exported into the bike-infrastructure layer but '
  + 'carry no score, which the model turns into level 0 "Insufficient data"');

/* ---- 2. a sharrow is a sharrow, signed or not -------------------------- */
for (const bicycle of [undefined, 'yes', 'designated']) {
  const tags = { highway: 'secondary', cycleway: 'shared_lane' };
  if (bicycle) tags.bicycle = bicycle;
  assert.strictEqual(sharrowOnly(tags), true,
    `a shared_lane on an ordinary road is a sharrow even with bicycle=${bicycle}; `
    + 'designation is an agency recommendation, not a facility');
}
// But a shared_lane marking ON a path or cycleway is not "a sharrow on a road".
for (const highway of ['cycleway', 'path', 'footway', 'bridleway', 'track', 'service']) {
  assert.strictEqual(sharrowOnly({ highway, cycleway: 'shared_lane' }), false,
    `${highway} with a shared_lane marking is still dedicated infrastructure`);
}

/* ---- 3. parity with the graph builder ---------------------------------- */
// build_graph.py is the router's answer. The app may be more generous (it shows
// things the router will not use), but never stricter: a way the router rides
// must be a way the card can describe.
const stricter = [];
for (let i = 0; i < combos.length; i++) {
  const tags = combos[i];
  if (!gates[i].routerInfra) continue;       // router does not call it infra
  if (!gates[i].exported) continue;          // not in the layer to be tapped
  if (sharrowOnly(tags)) continue;           // deliberately excluded from it
  const n = scoreOSM(tags);
  if (n.baseScore == null) stricter.push(tags);
}
assert.deepStrictEqual(stricter.slice(0, 8), [],
  'the router treats these as dedicated bike infrastructure but the app cannot '
  + 'score them, so the card will say "Insufficient data" about a way you are '
  + 'being routed along');

console.log(`ok - ${combos.length} tag combinations; app and graph agree on what is infrastructure`);
