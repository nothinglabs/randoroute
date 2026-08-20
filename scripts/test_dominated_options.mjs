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
  // Endpoints are the rider's real ones: Portage Bay Cafe at 4130 Roosevelt Way
  // NE, and the zoo's 601 N 59th St entrance. An earlier version of this used
  // the zoo's south gate instead, and that single difference hid the 11th
  // Avenue case completely -- no candidate on the south-gate trip touches it.
  { state: 'washington', id: 'udistrict-zoo', name: 'University District -> Woodland Park Zoo',
    from: [-122.31757, 47.65760], to: [-122.35460, 47.67070],
    // Two separate corridors, each lost to a different flaw in the same trim.
    // Stone Way N went when the trim ranked losers by how badly they lost.
    // 11th Ave NE went when distinctness was measured against the whole pool:
    // two routes carry it and they are near-identical to each other, so each
    // made the other look redundant and the corridor deleted itself.
    mustOffer: [
      { street: /^stone way north$/i, metres: 500 },
      { street: /^11th avenue northeast$/i, metres: 800 },
    ],
    // Both corridors' routes ARE beaten on all three axes, on purpose.
    skipDominance: true },
];

// Two routes are near-copies when they trace mostly the same ground. Measured
// on sampled coordinates rather than edge ids, because that is all an audited
// option carries -- coarse, but a twin and a genuinely different corridor are
// nowhere near each other on this scale.
const TWIN_OVERLAP = 0.9;
function shape(option) {
  return new Set((option.coords || []).filter((_, i) => i % 3 === 0)
    .map(([lon, lat]) => `${lon.toFixed(4)},${lat.toFixed(4)}`));
}
function mostAlike(option, others) {
  const mine = shape(option);
  let best = { overlap: 0, other: option };
  for (const other of others) {
    if (other === option) continue;
    const theirs = shape(other);
    let shared = 0;
    for (const point of mine) if (theirs.has(point)) shared++;
    const overlap = shared / Math.max(1, Math.min(mine.size, theirs.size));
    if (overlap > best.overlap) best = { overlap, other };
  }
  return best;
}

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

  for (const { street, metres } of (trip.mustOffer || [])) {
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
    // Losing on all three axes is NOT by itself a reason to deny a slot, and an
    // earlier version of this file asserted that it was. That rule deletes a
    // corridor the moment its route is a little longer than the direct one --
    // which is how Stone Way N and 11th Avenue NE both vanished from this very
    // trip while near-identical twins held letters.
    //
    // What a slot must never hold is a route that is beaten AND is a near-copy
    // of something already on the board. Beaten but genuinely different is the
    // variety the six letters exist for; beaten and duplicated is the waste.
    const twin = mostAlike(option, audit.options);
    if (twin.overlap < TWIN_OVERLAP) {
      console.log(`  beaten but distinct, slot earned: ${line(option)}`
        + `  (closest other offered route overlaps ${twin.overlap.toFixed(2)})`);
      continue;
    }
    console.error(`  DOMINATED TWIN: ${line(option)}  <= beaten by ${line(winner)}`
      + `, and overlaps ${twin.overlap.toFixed(2)} with ${twin.other.letter}`);
    failures++;
  }
  const star = audit.options.find((o) => o.recommended);
  console.log(`${trip.name}: ${audit.options.length} options, star `
    + `${(star.distM / 1000).toFixed(1)} km at `
    + `${(100 * star.failM / star.distM).toFixed(1)}% failing`);
}

assert.equal(failures, 0,
  `${failures} offered route(s) are beaten on distance, time and failing road at once`
  + ` AND are ${TWIN_OVERLAP}+ identical to another route on the same screen. Losing on`
  + ' every axis is survivable for a route that shows the rider a different way to go;'
  + ' being a worse copy of the route beside it is not.');
console.log('no offered route is both beaten and a near-copy of another');
