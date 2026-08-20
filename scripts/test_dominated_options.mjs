#!/usr/bin/env node
// Every lettered route has to be better than the others at SOMETHING.
//
// The portfolio prunes a beaten candidate only when its shape nearly matches
// the winner's (edgeOverlap >= 0.96). That test looks at geometry and nothing
// else, so a route on its own corridor used to keep a slot however much worse
// it was. A 30-trip audit found 16 such options across 14 trips; the worst,
// Walla Walla -> Dayton, offered a route 7 km longer, 32 minutes slower and
// carrying 5.6x the failing road of one sitting beside it on the same screen.
//
// Two things have to stay true, and they pull against each other:
//
//   1. A candidate beaten on distance AND time AND safety does not get a slot.
//   2. Enforcing that must never shrink the chooser. Applied without a floor
//      it collapsed short trips to a single letter -- a worse answer than a
//      redundant one -- which is why the trim stops once the slots are merely
//      full rather than contested.
//
// The trips below are real, reproduce by name in the app, and are audited
// against the app's own defaults through the same entry point the audit tool
// uses, so this cannot drift away from what a rider sees.
import assert from 'node:assert';
import { routerWorker } from './testlib/harness.mjs';
import { auditRoute, defaultRules, havM } from './audit_route.mjs';

// `quick-friendly` -- "Direct + both preferences" -- is reserved by name in the
// portfolio, so it is exempt from every dominance test by design. That is a
// separate decision from the corridor exemption this file guards, and the
// audit's eight remaining dominated options are all this one profile.
const RESERVED = 'quick-friendly';

const TRIPS = [
  { state: 'washington', id: 'wallawalla-dayton', name: 'Walla Walla -> Dayton',
    from: [-118.33934, 46.06673], to: [-117.97254, 46.32356] },
  { state: 'washington', id: 'anacortes-mountvernon', name: 'Anacortes -> Mount Vernon',
    from: [-122.61267, 48.51264], to: [-122.33429, 48.42128] },
  { state: 'washington', id: 'pullman-colfax', name: 'Pullman -> Colfax',
    from: [-117.17966, 46.73138], to: [-117.36439, 46.88041] },
  // The other half of the rule, and the reason the trim ranks by redundancy
  // rather than by how badly a route loses. Stone Way N is the gentle climb out
  // of Fremont; every parallel is steeper. The only candidates that ride it are
  // slightly longer and slightly slower than the routes up Fremont Avenue, so a
  // dominance trim that ignores geometry deletes them -- and it did, leaving the
  // rider two routes 0.93 identical to each other and the real alternative
  // buried in All Routes. A dominated route that is also the most DISTINCT thing
  // in the set has earned its slot; this trip is where that is observable.
  { state: 'washington', id: 'udistrict-zoo', name: 'University District -> Woodland Park Zoo',
    from: [-122.31760, 47.65750], to: [-122.35200, 47.66260],
    mustOffer: { street: /^stone way north$/i, metres: 500 },
    // Its Stone Way options ARE beaten on all three axes, on purpose.
    skipDominance: true },
];

// A route is beaten outright when another offered route is no longer, no
// slower, and carries meaningfully less failing road. The one-point margin on
// failing share keeps rounding noise from reading as dominance.
function beatenOutright(option, others) {
  const share = (o) => 100 * o.failM / Math.max(o.distM, 1);
  return others.find((other) => other !== option
    && other.distM <= option.distM
    && other.timeS <= option.timeS
    && share(other) < share(option) - 1);
}

let failures = 0;
for (const trip of TRIPS) {
  const worker = routerWorker({ state: trip.state });
  assert.ok(worker.ready, `the ${trip.state} graph must load`);
  const audit = auditRoute(worker, trip, defaultRules());
  assert.ok(audit.ok, `${trip.name} must remain routable`);

  // The floor: a trip that offered a full board before must still offer one.
  // This is the half that the Interurban regression caught when the trim ran
  // without a limit.
  assert.ok(audit.options.length >= 5,
    `${trip.name} collapsed to ${audit.options.length} options; the dominance trim`
    + ' must never take the chooser below the slots it can fill');

  if (trip.mustOffer) {
    const { street, metres } = trip.mustOffer;
    const best = audit.options.reduce((most, option) => {
      const coords = option.coords || [];
      let m = 0;
      for (const seg of (option.segs || [])) {
        if (!street.test(seg.name || '')) continue;
        for (let k = seg.c0; k < seg.c1 && k + 1 < coords.length; k++) {
          m += havM(coords[k], coords[k + 1]);
        }
      }
      return Math.max(most, m);
    }, 0);
    console.log(`${trip.name}: best offered run of ${street.source} = ${Math.round(best)} m`);
    assert.ok(best >= metres,
      `${trip.name} offers at most ${Math.round(best)} m of ${street.source}, wanted `
      + `${metres} m. The corridor is still being built -- check whether the dominance `
      + 'trim deleted it for losing on distance and time while being the most distinct '
      + 'route in the set.');
  }
  if (trip.skipDominance) continue;

  for (const option of audit.options) {
    const winner = beatenOutright(option, audit.options);
    if (!winner) continue;
    const line = (o) => `${o.letter} ${(o.distM / 1000).toFixed(1)}km`
      + ` ${Math.round(o.timeS / 60)}min ${(100 * o.failM / o.distM).toFixed(1)}% ${o.profileId}`;
    if (option.profileId === RESERVED) {
      console.log(`  reserved seat kept: ${line(option)} <= ${line(winner)}`);
      continue;
    }
    console.error(`  DOMINATED: ${line(option)}  <= beaten by ${line(winner)}`);
    failures++;
  }
  const star = audit.options.find((o) => o.recommended);
  console.log(`${trip.name}: ${audit.options.length} options, star `
    + `${(star.distM / 1000).toFixed(1)} km at `
    + `${(100 * star.failM / star.distM).toFixed(1)}% failing`);
}

assert.equal(failures, 0,
  `${failures} offered route(s) are beaten on distance, time and failing road at once.`
  + ' A route that is worse on every axis the app measures is not variety, it is a'
  + ' wasted slot -- see the corridor exemption in routeOptions.');
console.log('no offered route is beaten on distance, time and safety at once');
