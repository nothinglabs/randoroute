#!/usr/bin/env node
// Tapping a road that is NOT on your route should still tell you how steep it
// is. The map tiles carry no elevation, so the card asks the routing graph --
// which is already in memory -- through an `edge-grade` message.
//
// This exercises the worker's answer against the graph it read from, so a
// change to snapping, to reportedGradePct, or to the message shape shows up
// here rather than as a silently missing row on a phone.
import assert from 'node:assert';
import { routerWorker } from './testlib/harness.mjs';

const worker = routerWorker({ state: 'washington' });
assert.ok(worker.ready, 'the washington graph must load');

// Pick real edges out of the graph and ask about their own midpoints. Using
// hand-typed coordinates instead cost an earlier session a wrong conclusion:
// a guessed point lands on a neighbouring block and answers about that.
const samples = worker.run(`(() => {
  const wanted = [/^fremont avenue north$/i, /^dayton avenue north$/i,
    /^stone way north$/i, /burke-?gilman/i];
  const out = [];
  for (const pattern of wanted) {
    let pick = -1, steepest = -1;
    for (let i = 0; i < E; i++) {
      if (!pattern.test(edgeName(i) || '')) continue;
      const lat = nodeLat[eA[i]];
      if (lat < 47.64 || lat > 47.69 || eLen[i] < 30) continue;
      const grade = 100 * Math.max(eAsc[i], eDes[i]) / Math.max(1, eLen[i]);
      if (grade > steepest) { steepest = grade; pick = i; }
    }
    if (pick < 0) continue;
    const mid = eOff[pick] + Math.floor(eCnt[pick] / 2);
    out.push({ name: edgeName(pick), lon: gLon[mid], lat: gLat[mid],
      expected: Math.round(10 * steepest) / 10 });
  }
  return out;
})()`);
assert.ok(samples.length >= 3,
  `expected several named Seattle streets in the graph, found ${samples.length}`);

for (const sample of samples) {
  const reply = worker.post({ type: 'edge-grade', id: 7,
    lon: sample.lon, lat: sample.lat, name: sample.name });
  assert.equal(reply.type, 'edge-grade', 'the worker must answer an edge-grade query');
  assert.equal(reply.id, 7, 'the answer must carry the request id back for race-matching');
  assert.ok(reply.gradePct !== null,
    `${sample.name}: asked at a point ON the edge and got no grade back`);
  assert.ok(Math.abs(reply.gradePct - sample.expected) < 0.15,
    `${sample.name}: graph holds ${sample.expected}%, query answered ${reply.gradePct}%`);
  // Unsigned: a tapped road has no direction of travel to be uphill in.
  assert.ok(reply.gradePct >= 0, `${sample.name}: a tapped road's grade must be unsigned`);
  console.log(`  ${String(sample.name).padEnd(26)} ${reply.gradePct}%  (${reply.metres} m from the tap)`);
}

// Open water: nothing to report, and the card must drop the row rather than
// show a grade borrowed from the nearest shoreline street.
const nowhere = worker.post({ type: 'edge-grade', id: 8,
  lon: -122.33800, lat: 47.68100, name: 'Nonexistent Street' });
assert.equal(nowhere.gradePct, null,
  'a tap with no matching road nearby must answer null, not a nearby street\'s grade');

// A named query must not answer about a different street. Ask for one street
// at another's location and expect either nothing or a genuinely close match.
const crossed = worker.post({ type: 'edge-grade', id: 9,
  lon: samples[0].lon, lat: samples[0].lat, name: samples[1].name });
assert.ok(crossed.gradePct === null || crossed.name === samples[1].name,
  `asked for ${samples[1].name} at ${samples[0].name}'s location and got `
  + `${crossed.name}; the name filter must not be ignored`);

console.log(`tapped-road grade answers for ${samples.length} streets, and declines open water`);
