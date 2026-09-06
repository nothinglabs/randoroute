#!/usr/bin/env node
// The partition session's router is a separate worker that never receives the
// home worker's preferred-routes / suppressed-routes sync messages. A request
// therefore carries both sets inline, and the router must ingest them before
// it searches -- otherwise a Preferred route or a switched-off route source
// silently does nothing on any trip routed through partitions (sweep,
// 2026-09-06). Proven on a fresh worker that has never been synced.
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, done, routerWorker, appDefaultRules, ROOT } from './testlib/harness.mjs';

const overlay = JSON.parse(gunzipSync(readFileSync(
  join(ROOT, 'maps', 'washington', 'bikeroutes.geojson.gz'))));
const routes = new Map();
for (const feature of overlay.features) {
  const names = String(feature.properties?.n || '').split(' / ')
    .map((part) => part.trim()).filter(Boolean);
  const lines = feature.geometry?.type === 'LineString' ? [feature.geometry.coordinates]
    : feature.geometry?.type === 'MultiLineString' ? feature.geometry.coordinates : [];
  for (const name of names) {
    const entry = routes.get(name) || { name, lines: [], points: 0 };
    for (const line of lines) { entry.lines.push(line); entry.points += line.length; }
    routes.set(name, entry);
  }
}
const chosen = [...routes.values()]
  .filter((route) => route.points >= 50 && route.points <= 3000)
  .sort((a, b) => b.points - a.points)[0];
check('the overlay offers a route of testable size', !!chosen, chosen?.name);

const w = routerWorker({ fresh: true });
check('a fresh worker loads the graph', w.ready);
check('the fresh worker holds no preferred or suppressed set',
  w.run('preferredRoutesKey') === '' && w.run('suppressedRoutesKey') === '');

const rules = { ...appDefaultRules(), preferredRoutes: chosen.name };
const first = chosen.lines[0][0], last = chosen.lines.at(-1).at(-1);
const reply = w.post({ type: 'route-options', id: 'pr-1', points: [first, last], rules,
  forceDesignated: false, forceResidential: false, preferredProfileId: 'balanced',
  preferredRoutes: { key: chosen.name, lines: chosen.lines },
  suppressedRoutes: { key: '', lines: [], keepLines: [] } });
check('the request routes', reply?.ok === true, reply?.reason);
check('the router ingested the Preferred set carried by the request',
  w.run('preferredRoutesKey') === chosen.name && w.run('preferredEdges && preferredEdges.length') > 0
    && w.run('preferredRoutesActive')(rules) === true,
  JSON.stringify({ key: w.run('preferredRoutesKey') }));
check('no applied-ack was posted for an inline set',
  !w.messages.some((m) => m.type === 'preferred-routes-applied'));
const strong = (reply.allCandidates || []).some((c) => c.preferredRouteStrength === 'strong');
check('the portfolio searched with the Preferred lens', strong,
  JSON.stringify((reply.allCandidates || []).map((c) => c.preferredRouteStrength)));

// Clearing the selection travels the same way.
const cleared = w.post({ type: 'route-options', id: 'pr-2', points: [first, last],
  rules: { ...rules, preferredRoutes: '' },
  forceDesignated: false, forceResidential: false, preferredProfileId: 'balanced',
  preferredRoutes: { key: '', lines: [] } });
check('an empty inline set clears the router', cleared?.ok === true && w.run('preferredRoutesKey') === '');

// A switched-off source: the route's own lines suppressed, nothing kept.
const suppressed = w.post({ type: 'route-options', id: 'pr-3', points: [first, last],
  rules: { ...rules, preferredRoutes: '', suppressedRouteSources: 'county' },
  forceDesignated: false, forceResidential: false, preferredProfileId: 'balanced',
  suppressedRoutes: { key: 'county', lines: chosen.lines, keepLines: [] } });
check('the router ingested the suppressed set carried by the request',
  suppressed?.ok === true && w.run('suppressedRoutesKey') === 'county'
    && w.run('suppressedRouteEdges && suppressedRouteEdges.length') > 0,
  JSON.stringify({ key: w.run('suppressedRoutesKey') }));
check('an unchanged key is not re-matched',
  (() => {
    const before = w.run('suppressedRouteEdges');
    w.post({ type: 'route-options', id: 'pr-4', points: [first, last],
      rules: { ...rules, preferredRoutes: '', suppressedRouteSources: 'county' },
      forceDesignated: false, forceResidential: false, preferredProfileId: 'balanced',
      suppressedRoutes: { key: 'county', lines: chosen.lines, keepLines: [] } });
    return w.run('suppressedRouteEdges') === before;
  })());
done();
