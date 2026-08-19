#!/usr/bin/env node
// A pasted coordinate pair is a place.
//
// Every routing report worth acting on is a pair of points, and until this the
// only way to reach an exact one was to tap the map and hope. That is fine for
// a town and useless for anything smaller: Point Defiance is unreachable from
// downtown Tacoma inside a dead zone tens of metres wide, and `places.json`
// carries no record for it at all, so no amount of typing its name arrives.
//
// The formats below are the ones people actually have in a clipboard. Order is
// resolved by which reading lands inside the loaded state, because a rider
// pasting from Google Maps has lat first and a rider pasting from this project
// has lon first, and neither should have to care.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(() => typeof openPlaceSearch === 'function', { timeout: 60000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

/** Type a query into the picker and report what it offers. */
const search = (query) => page.evaluate(async (text) => {
  openPlaceSearch();
  const input = document.getElementById('placeSearch');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  const hits = [...document.querySelectorAll(
    '#placeResults .place-hit:not(.place-internet-search)')];
  return {
    names: hits.map((button) => button.dataset.name),
    details: hits.map((button) => button.querySelector('small')?.textContent || ''),
    message: document.querySelector('#placeResults .place-results-message')?.textContent || '',
    offersInternet: Boolean(document.querySelector('#placeResults .place-internet-search')),
  };
}, query);

// Downtown Tacoma, the origin of the trip that exposed this.
const EXPECTED = '-122.44430, 47.25290';

for (const [label, query] of [
  ['bracketed lon-lat', '[-122.4443, 47.2529]'],
  ['bare lon-lat', '-122.4443, 47.2529'],
  ['no space after the comma', '-122.4443,47.2529'],
  ['space separated', '-122.4443 47.2529'],
  ['parenthesised', '(-122.4443, 47.2529)'],
  ['surrounding whitespace', '   -122.4443, 47.2529   '],
  ['lat-first, as Google Maps hands it out', '47.2529, -122.4443'],
  ['lat-first and bracketed', '[47.2529, -122.4443]'],
]) {
  const result = await search(query);
  check(`${label} resolves to the point`,
    result.names.length === 1 && result.names[0] === EXPECTED,
    JSON.stringify(result));
}

const labelled = await search('[-122.4443, 47.2529]');
check('a coordinate result is labelled as one',
  labelled.details.length === 1 && /coordinate/i.test(labelled.details[0]),
  JSON.stringify(labelled.details));
check('a coordinate does not offer an internet search',
  labelled.offersInternet === false, JSON.stringify(labelled));

// San Francisco is outside Washington's box in either reading, so with
// Washington loaded this must say so rather than falling through to a hopeless
// name search. (Portland is NOT a valid example here: at 45.52 it sits just
// inside Washington's southern bound of 45.5, which the box does not pretend to
// be a state border.)
const outside = await search('-122.4194, 37.7749');
check('a point outside the loaded state says so',
  outside.names.length === 0 && /outside/i.test(outside.message),
  JSON.stringify(outside));

// Things that merely look numeric must not hijack an ordinary search.
for (const [label, query, expectCoordinate] of [
  ['one number is not a coordinate', '-122.4443', false],
  ['three numbers are not a coordinate', '-122.4443, 47.2529, 12', false],
  ['a house number and street is not a coordinate', '100 Fremont Avenue', false],
  ['an impossible latitude is not a coordinate', '-122.4443, 947.25', false],
]) {
  const result = await search(query);
  const isCoordinate = result.details.some((detail) => /coordinate/i.test(detail));
  check(label, isCoordinate === expectCoordinate, JSON.stringify(result));
}

// A named place must still work exactly as before.
const named = await search('Tacoma');
check('an ordinary name search is unaffected',
  named.names.length > 0 && named.names.some((name) => /tacoma/i.test(name)),
  JSON.stringify(named.names));

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
await site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
