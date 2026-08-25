#!/usr/bin/env node
// A short failing run bounded by passing road is a CROSSING -- riding over a
// hostile street, not along it -- and the whole chain must treat it that way:
// the router reclassifies the run, the route props preserve the flag, the
// selected route paints it blue, and the details step names the metres. All
// four claims are held by RUNNING the code; the source-text matches that used
// to sit here pinned spellings, not behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { appDefaultRules, routerWorker } from './testlib/harness.mjs';

/* ------------------------------------ the router, on the shipped graph */
// The router prefers to route AROUND failing road, so a hand-picked trip
// rarely exercises the crossing rule -- and any pick would be hostage to the
// next graph rebuild. Discover the fixture instead: a short failing edge
// whose endpoints both carry passing edges, with the trip's endpoints pushed
// one passing edge beyond each side, is a crossing by construction.
const w = routerWorker({ state: 'washington' });
assert.ok(w.ready, 'the Washington graph should load');
const RULES = appDefaultRules();
const found = w.run(`(() => {
  const rules = ${JSON.stringify(appDefaultRules())};
  const passing = (node, notEdge) => {
    for (let a = outStart[node]; a < outStart[node + 1]; a++) {
      const other = outEdge[a];
      if (other === notEdge) continue;
      if (edgeLevelFor(other, rules, eA[other] === node) !== 4
          && eLen[other] >= 25 && eLen[other] <= 400) return outTarget[a];
    }
    return -1;
  };
  const out = [];
  for (let ei = 0; ei < E && out.length < 12; ei++) {
    if (!(eLen[ei] >= 6 && eLen[ei] <= 35)) continue;
    if (!inGiant[eA[ei]]) continue;
    if (edgeLevelFor(ei, rules, true) !== 4) continue;
    const beyondA = passing(eA[ei], ei);
    const beyondB = passing(eB[ei], ei);
    if (beyondA < 0 || beyondB < 0 || beyondA === beyondB) continue;
    out.push({ from: [nodeLon[beyondA], nodeLat[beyondA]],
      to: [nodeLon[beyondB], nodeLat[beyondB]] });
  }
  return out;
})()`);
assert.ok(found.length > 0, 'the graph should hold short bounded failing edges');
let crossingSegs = null, tried = 0;
for (const trip of found) {
  tried++;
  const reply = w.post({ type: 'route', id: `crossing-${tried}`,
    points: [trip.from, trip.to], rules: RULES, mode: 'balanced' });
  if (!reply?.ok || !Array.isArray(reply.segs)) continue;
  const flagged = reply.segs.filter((s) => s.crossing);
  if (flagged.length) { crossingSegs = { segs: reply.segs, flagged }; break; }
}
assert.ok(crossingSegs,
  `none of ${tried} discovered crossing trips produced a crossing-flagged segment`);
for (const seg of crossingSegs.flagged) {
  assert.ok(seg.level === 2,
    `a crossing rides as level 2, not ${seg.level}: ${JSON.stringify(seg)}`);
}
// Each contiguous flagged run is SHORT -- that is what makes it a crossing
// rather than riding along the failing road.
let runM = 0;
for (const seg of crossingSegs.segs) {
  if (seg.crossing) runM += seg.lenM;
  else { assert.ok(runM <= 48, `crossing run of ${runM} m is not a crossing`); runM = 0; }
}

/* ----------------------------- the route props preserve the flag (app) */
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const propsStart = app.indexOf('function routeSegProps');
const propsEnd = app.indexOf('\nfunction ', propsStart + 10);
assert.ok(propsStart >= 0 && propsEnd > propsStart, 'routeSegProps was not found');
const propsContext = { isDismountSegment: () => false, measureProps: () => ({}),
  Number, Region: { id: 'washington' } };
vm.createContext(propsContext);
vm.runInContext(`${app.slice(propsStart, propsEnd)}\nthis.routeSegProps = routeSegProps;`,
  propsContext);
assert.equal(propsContext.routeSegProps({ crossing: 1, flags: 0 }).crossing, 1,
  'route props should preserve the crossing classification');
assert.equal(propsContext.routeSegProps({ flags: 0 }).crossing, 0,
  'and not invent one');

/* --------------------------- the selected route paints a crossing blue */
const styleStart = app.indexOf('function scoreRouteSeg');
const styleEnd = app.indexOf('function sameRouteCoordinate', styleStart);
assert.ok(styleStart >= 0 && styleEnd > styleStart, 'route-style helpers were not found');
const styleContext = {
  effectiveLevel: () => 4,
  OFFICIAL_SIDEWALK: 16,
  OFFICIAL_SIDEWALK_NO: 32,
  OFFICIAL_URBAN: 64,
  tileMeasures: () => null,
};
vm.createContext(styleContext);
vm.runInContext(`${app.slice(styleStart, styleEnd)}\nthis.routeVisualStyle = routeVisualStyle;`,
  styleContext);
assert.equal(styleContext.routeVisualStyle({ crossing: 1, ferry: 0, facility: 0, infra: 0 }),
  'pass', 'a verified short crossing should stay blue on the selected route');
assert.equal(styleContext.routeVisualStyle({ crossing: 0, ferry: 0, facility: 0, infra: 0 }),
  'fail', 'an otherwise failing road should remain red');

/* -------------------------- the details step names the crossed metres */
const details = fs.readFileSync(new URL('../route-details.js', import.meta.url), 'utf8');
const metaStart = details.indexOf('function stepMeta');
const metaEnd = details.indexOf('\nfunction ', metaStart + 10);
assert.ok(metaStart >= 0 && metaEnd > metaStart, 'stepMeta was not found');
const metaContext = {
  fmtDist: (m) => `${Math.round(m)} m`,
  isMountainBikeTrail: () => false,
  segmentState: () => null,
  stateHighwayName: () => null,
  FLAG_FREEWAY: 4, FLAG_LIMITED_ACCESS: 128, FLAG_INFRA: 8,
  FLAG_DESIGNATED: 64, FLAG_FACILITY: 2,
  FACILITY_NAME: {},
};
vm.createContext(metaContext);
vm.runInContext(`${details.slice(metaStart, metaEnd)}\nthis.stepMeta = stepMeta;`,
  metaContext);
const line = metaContext.stepMeta({ crossingM: 12, flags: 0 });
assert.match(line, /12 m intersection crossing/,
  `the details step should name the crossed metres, got "${line}"`);
assert.ok(!/intersection crossing/.test(metaContext.stepMeta({ flags: 0 })),
  'and say nothing when there is no crossing');

console.log('Route crossing tests passed.');
