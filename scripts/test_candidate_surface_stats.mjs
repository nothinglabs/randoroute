#!/usr/bin/env node
// Unpaved mileage must reach the rider. The candidate summary carried
// `unpavedM: candidate.unpavedM || 0` and nothing anywhere ever set
// candidate.unpavedM, so every route reported zero gravel and no description
// could mention any (field, 2026-08-28). The screen test could not catch it:
// its fixtures supply unpavedM directly. This runs the real graph over the
// Snoqualmie Valley Trail, which is crushed rock for most of its length.
import { appDefaultRules, check, done, routerWorker } from './testlib/harness.mjs';

const worker = routerWorker();
check('worker loads the graph', worker.ready);

const trip = worker.post({ type: 'route-options', id: 77,
  start: [-121.9857, 47.7423], end: [-121.9140, 47.6487],
  rules: appDefaultRules() });
check('the valley-trail trip routes', !!trip?.ok, trip?.reason);

const rows = (trip.allCandidates || []).map((c) => ({
  label: c.label, mi: c.distM / 1609.344, unpavedMi: (c.unpavedM || 0) / 1609.344,
}));
const gravelly = rows.filter((r) => r.unpavedMi >= 1);
check('a route down a crushed-rock trail reports its unpaved miles',
  gravelly.length >= 1, JSON.stringify(rows.slice(0, 6)));
check('and the figure is a real share of the route, not a rounding artefact',
  gravelly.every((r) => r.unpavedMi <= r.mi + 0.01)
    && Math.max(...gravelly.map((r) => r.unpavedMi)) >= 3,
  JSON.stringify(gravelly.slice(0, 3)));
// The paved alternative must still read as paved: a summary that called
// everything gravel would pass the check above on its own.
check('a route that avoids the trail reports none',
  rows.some((r) => r.unpavedMi < 0.1), JSON.stringify(rows.slice(0, 6)));

done();
