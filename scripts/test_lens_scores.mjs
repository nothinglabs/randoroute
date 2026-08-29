#!/usr/bin/env node
// Three lens prices per route on the All routes screen (rider ask,
// 2026-08-29). A DIAGNOSTIC for understanding routing preference: nothing
// here selects, seats or recommends anything.
//
// The point is comparability. A candidate's own search cost cannot be
// compared with another's, because each was priced by the lens that built it
// -- direct charges 1.9x on failing road where balanced charges 9x and
// low-stress 30x, so direct-built routes look cheap whatever they ride. This
// re-prices every candidate under all three modes with ONE set of rules, so a
// column can be read down.
import { appDefaultRules, check, done, routerWorker } from './testlib/harness.mjs';

const worker = routerWorker();
check('worker loads the graph', worker.ready);

const rules = appDefaultRules();
const trip = worker.post({ type: 'route-options', id: 71,
  start: [-122.3321, 47.6062], end: [-122.3830, 47.6680], rules });
check('the trip routes', !!trip?.ok, trip?.reason);

const reply = worker.post({ type: 'score-lenses', id: 72,
  candidatesKey: trip.candidatesKey, rules });
const lenses = reply?.lenses || {};
const rows = Object.values(lenses);
check('every candidate is priced under all three lenses',
  !!reply?.ok && rows.length === (trip.allCandidates || []).length
    && rows.every((r) => r.direct && r.balanced && r.low),
  JSON.stringify({ ok: reply?.ok, priced: rows.length,
    candidates: (trip.allCandidates || []).length }));
check('each lens reports a cost and a ratio against travel time',
  rows.every((r) => ['direct', 'balanced', 'low'].every((m) =>
    Number.isFinite(r[m].costS) && Number.isFinite(r[m].ratio))),
  JSON.stringify(rows[0]));

// The whole reason this exists: under one lens the numbers order routes, and
// the three lenses do NOT agree -- which is the preference the rider wants to
// see. Low-stress prices every route above direct, because its walls are
// bigger; that ordering between columns is a property of the lens, not of any
// route, so the screen marks bests per column and never compares across.
check('a stricter lens prices every route higher than a looser one',
  rows.every((r) => r.low.ratio >= r.balanced.ratio
    && r.balanced.ratio >= r.direct.ratio),
  JSON.stringify(rows.find((r) => !(r.low.ratio >= r.balanced.ratio
    && r.balanced.ratio >= r.direct.ratio))));
const spread = (key) => {
  const values = rows.map((r) => r[key].ratio);
  return Math.max(...values) - Math.min(...values);
};
check('and the routes differ under a lens, so a column ranks something',
  spread('balanced') > 0.02 && spread('low') > 0.02,
  JSON.stringify({ direct: spread('direct').toFixed(3),
    balanced: spread('balanced').toFixed(3), low: spread('low').toFixed(3) }));

// A stale portfolio must not be answered with numbers for another trip.
const stale = worker.post({ type: 'score-lenses', id: 73,
  candidatesKey: 'not-the-current-portfolio', rules });
check('a stale portfolio key returns nothing rather than wrong numbers',
  stale?.ok === false && !Object.keys(stale.lenses || {}).length,
  JSON.stringify(stale).slice(0, 160));

done();
