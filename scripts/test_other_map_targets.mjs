#!/usr/bin/env node
// "Other Map" hands this spot to Google Maps, Apple Maps or OpenStreetMap.
//
// The property worth pinning is the one that makes it open the APP on an
// iPhone: every address is plain https. Apple and Google both claim their map
// hosts as iOS universal links, so a real link click hands off to the installed
// app; a comgooglemaps:// or maps:// scheme would need native code in
// BridgeViewController.swift plus an LSApplicationQueriesSchemes entry, and a
// WKWebView drops it silently otherwise. Someone "improving" this to custom
// schemes would break app launching on every device without the app installed,
// and break the web build outright -- so the shape is asserted, not assumed.
//
// Coordinates are pinned too: a map link that lands in the wrong place is worse
// than no link, and the three services disagree about how a point is spelled.
import assert from 'node:assert';
import vm from 'node:vm';
import { check, checkEqual, done, source } from './testlib/harness.mjs';

const appSrc = source('app.js');
function lift(name) {
  const at = appSrc.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `app.js still defines ${name}`);
  const open = appSrc.indexOf('{', at);
  let depth = 0, end = open;
  for (; end < appSrc.length; end++) {
    if (appSrc[end] === '{') depth++;
    else if (appSrc[end] === '}' && --depth === 0) break;
  }
  return appSrc.slice(at, end + 1);
}
const box = { encodeURIComponent };
vm.createContext(box);
vm.runInContext(lift('googleMapsPointUrl'), box);
vm.runInContext(lift('otherMapTargets'), box);

const targets = box.otherMapTargets(47.6062, -122.3321);
checkEqual('three destinations are offered', targets.length, 3);
checkEqual('in the order the rider asked for',
  targets.map((t) => t.key).join(','), 'google,apple,osm');
checkEqual('labelled as the services name themselves',
  targets.map((t) => t.label).join(' / '), 'Google Maps / Apple Maps / OpenStreetMap');

for (const target of targets) {
  check(`${target.key} is plain https, never a custom scheme`,
    /^https:\/\//.test(target.url), target.url);
  check(`${target.key} carries the latitude`, target.url.includes('47.606200'), target.url);
  check(`${target.key} carries the longitude`, target.url.includes('-122.332100'), target.url);
}

const byKey = Object.fromEntries(targets.map((t) => [t.key, t.url]));
check('Google uses the documented search endpoint',
  byKey.google.startsWith('https://www.google.com/maps/search/?api=1&query='), byKey.google);
check('Apple uses the universal-link host that opens Maps.app',
  byKey.apple.startsWith('https://maps.apple.com/?ll='), byKey.apple);
check('OpenStreetMap drops a marker rather than only centring',
  byKey.osm.includes('mlat=') && byKey.osm.includes('mlon='), byKey.osm);

// A southern/eastern point, to catch a sign dropped in formatting.
const anti = box.otherMapTargets(-33.8688, 151.2093);
check('negative latitude survives every destination',
  anti.every((t) => t.url.includes('-33.868800')), JSON.stringify(anti.map((t) => t.url)));

done();
