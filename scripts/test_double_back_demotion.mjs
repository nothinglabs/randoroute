#!/usr/bin/env node
// Doubling back is priced in the suggestion score (field, 2026-08-27): on
// the University Bridge trip that motivated this, twelve candidates rode a
// kilometre south over the bridge and straight back — pure detour — because
// a bidirectional sidepath let the loop earn enough trail credit to win the
// star. This runs the real Washington graph on that exact field trip: the
// loop candidates must exist, measure their doubling, be surcharged for it,
// and lose the star to an honest route.
import { appDefaultRules, check, done, routerWorker } from './testlib/harness.mjs';

const worker = routerWorker();
check('worker loads the graph', worker.ready);

// The detector itself, on synthetic shapes: a pure there-and-back measures
// both passes; a straight line measures nothing; two parallel streets a
// block apart (60 m) are different roads, not a retrace.
const synthetic = JSON.parse(worker.run(`(() => {
  const kLat = 110540;
  const line = [];
  for (let i = 0; i <= 40; i++) line.push([-122.30, 47.60 + i * 15 / kLat]);
  const thereAndBack = [...line, ...line.slice(0, -1).reverse()];
  const kLon = 111320 * Math.cos(47.6 * Math.PI / 180);
  const parallelReturn = [...line,
    ...line.slice(0, -1).reverse().map((c) => [c[0] + 60 / kLon, c[1]])];
  return JSON.stringify({
    line: Math.round(routeDoubleBackM(line)),
    thereAndBack: Math.round(routeDoubleBackM(thereAndBack)),
    parallelReturn: Math.round(routeDoubleBackM(parallelReturn)),
  });
})()`));
check('a straight route measures no doubling', synthetic.line === 0,
  JSON.stringify(synthetic));
check('a there-and-back measures both passes',
  synthetic.thereAndBack > 900, JSON.stringify(synthetic));
check('a return one block over is not a retrace', synthetic.parallelReturn === 0,
  JSON.stringify(synthetic));

// The field trip: Campus Parkway (north of the University Bridge) to
// Phinney Ridge. The destination is northwest; riding SOUTH over the
// bridge and back is a pure detour that used to win the star as Route F.
const trip = worker.post({ type: 'route-options', id: 990,
  start: [-122.31810, 47.65650], end: [-122.35403, 47.67213],
  rules: appDefaultRules() });
check('the field trip routes', !!trip?.ok, trip?.reason);
const rows = (trip.allCandidates || []).map((c) => ({
  profileId: c.profileId, label: c.label, presented: c.presented,
  recommended: c.recommended,
  doubleBackM: c.suggestionScore?.doubleBackM,
  doubleBackS: Math.round(c.suggestionScore?.doubleBackS || 0),
  totalS: Math.round(c.suggestionScore?.totalS || 0),
}));
// Thresholds re-based 2026-08-29 with the tightened parallelism (17.5 m,
// dot -0.91): the loop family now measures ~616 m, the seat fence is 540.
const loops = rows.filter((r) => r.doubleBackM > 540);
const star = rows.find((r) => r.recommended);
check('the bridge loop is still built and measured',
  loops.length >= 3, JSON.stringify(rows.slice(0, 6)));
check('every loop candidate is surcharged for the doubling',
  loops.every((r) => r.doubleBackS > 150), JSON.stringify(loops.slice(0, 3)));
check('the star goes to a route that does not double back',
  !!star && star.doubleBackM < 300, JSON.stringify(star));
check('the surcharge reaches the reported score breakdown',
  rows.some((r) => r.doubleBackS > 0) && rows.every((r) =>
    Number.isFinite(r.doubleBackM)), JSON.stringify(rows[0]));
// Seats too, not only the star (field, 2026-08-27: the demoted loop still
// held two letters): with enough clean candidates, no offered letter may
// materially double back, and the excluded loops say why on More.
const seated = rows.filter((r) => r.presented);
check('no offered letter doubles back materially',
  seated.length >= 4 && seated.every((r) => r.doubleBackM <= 540),
  JSON.stringify(seated));
// The loop family dedupes to a representative first; only the survivor
// that reached seating carries the doubling why (its twins keep theirs).
const loopWhy = (trip.allCandidates || []).find((c) =>
  c.suggestionScore?.doubleBackM > 540 && c.stage === 'not-chosen')?.stageWhy || '';
check('the unseated loop representative explains itself',
  /[Dd]oubles back along itself/.test(loopWhy), loopWhy);

done();
