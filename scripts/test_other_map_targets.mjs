#!/usr/bin/env node
// "View Street…" hands this spot to Google Maps, Google Street View, Apple
// Maps or OpenStreetMap. Street View joined the sheet on 2026-08-30, when it
// stopped being its own button on the road card.
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
const commonSrc = source('route-common.js');
function lift(name, src = appSrc, where = 'app.js') {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${where} still defines ${name}`);
  // Walk the parameter list to its closing paren first. A destructured or
  // defaulted parameter carries its own braces, so the body does NOT start at
  // the first '{' after the name -- reading it that way ended the function
  // early and threw "Unexpected end of input".
  let i = src.indexOf('(', at), parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')' && --parens === 0) break;
  }
  const open = src.indexOf('{', i);
  let depth = 0, end = open;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}' && --depth === 0) break;
  }
  return src.slice(at, end + 1);
}
const box = { encodeURIComponent, Number, Math };
vm.createContext(box);
vm.runInContext(lift('googleMapsPointUrl'), box);
vm.runInContext(lift('googleStreetViewUrl', commonSrc, 'route-common.js'), box);
vm.runInContext(lift('otherMapTargets'), box);

const targets = box.otherMapTargets(47.6062, -122.3321);
checkEqual('four destinations are offered', targets.length, 4);
checkEqual('Street View sits directly under Google Maps',
  targets.map((t) => t.key).join(','), 'google,streetview,apple,osm');
checkEqual('labelled as the services name themselves',
  targets.map((t) => t.label).join(' / '),
  'Google Maps / Google Street View / Apple Maps / OpenStreetMap');

// A ferry crossing has no panorama worth opening, so that card drops the row
// rather than handing the rider a dead end.
const ferry = box.otherMapTargets(47.6062, -122.3321, { streetView: false });
checkEqual('a card without Street View still offers the other three',
  ferry.map((t) => t.key).join(','), 'google,apple,osm');

// The road bearing is why the panorama opens looking ALONG the road instead of
// at whatever Google picks; losing it silently would be invisible in review.
const aimed = box.otherMapTargets(47.6062, -122.3321, { heading: 137.4 });
check('Street View carries the road heading, rounded',
  aimed.find((t) => t.key === 'streetview').url.includes('&heading=137'),
  aimed.find((t) => t.key === 'streetview').url);
check('Street View omits heading when the road bearing is unknown',
  !targets.find((t) => t.key === 'streetview').url.includes('heading='),
  targets.find((t) => t.key === 'streetview').url);

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
