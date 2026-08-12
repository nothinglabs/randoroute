#!/usr/bin/env node
// Online search should find nearby POIs/businesses that the compact offline
// town index does not contain, and zero offline matches should fall through
// automatically after a short debounce. The provider is mocked: this tests the
// request/response contract and UI behavior without spending public API quota.
import { appPage, launchBrowser, serveRepo } from './testlib/harness.mjs';

const site = await serveRepo();
const browser = await launchBrowser();
const page = await appPage(browser, site.port);
await page.waitForFunction(() => typeof searchOnlinePlaces === 'function'
  && typeof openPlaceSearch === 'function', { timeout: 60000 });

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); return; }
  failed++;
  console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
};
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const provider = await page.evaluate(async () => {
  const realFetch = window.fetch;
  const asked = [];
  onlinePlaceCache.clear();
  onlinePlaceLastRequestAt = 0;
  window.fetch = async (input) => {
    asked.push(String(input));
    return {
      ok: true,
      json: async () => ({ type: 'FeatureCollection', features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.340, 47.610] },
          properties: { osm_key: 'shop', osm_value: 'supermarket', name: 'Fred Meyer',
            housenumber: '100', street: 'Northwest 85th Street', city: 'Seattle',
            state: 'Washington' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.370, 47.650] },
          properties: { osm_key: 'shop', osm_value: 'supermarket', name: 'Fred Meyer',
            housenumber: '200', street: 'Northwest 100th Street', city: 'Seattle',
            state: 'Washington' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.331, 47.620] },
          properties: { osm_key: 'tourism', osm_value: 'museum', name: 'Local History Museum',
            district: 'South Lake Union', city: 'Seattle', state: 'Washington' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-125.2, 47.6] },
          properties: { osm_key: 'amenity', osm_value: 'cafe', name: 'Outside Coverage',
            city: 'Ocean', state: 'Washington' } },
      ] }),
    };
  };
  try {
    const results = await searchOnlinePlaces('Fred Meyer');
    const url = new URL(asked[0]);
    return {
      endpoint: url.origin + url.pathname,
      query: url.searchParams.get('q'),
      bias: [Number(url.searchParams.get('lon')), Number(url.searchParams.get('lat'))],
      limit: Number(url.searchParams.get('limit')),
      results,
    };
  } finally {
    window.fetch = realFetch;
  }
});

check('live lookup uses Photon with the typed query and current-map bias',
  provider.endpoint === 'https://photon.komoot.io/api/'
    && provider.query === 'Fred Meyer' && provider.limit >= 20
    && provider.bias.every(Number.isFinite), JSON.stringify(provider));
check('business and landmark results expose useful names and categories',
  provider.results.some((item) => /Fred Meyer, 100 Northwest 85th Street/.test(item.name)
      && item.type === 'supermarket')
    && provider.results.some((item) => /Local History Museum/.test(item.name)
      && item.type === 'museum'), JSON.stringify(provider.results));
check('separate branches remain distinct while out-of-region hits are removed',
  provider.results.filter((item) => item.name.startsWith('Fred Meyer')).length === 2
    && !provider.results.some((item) => /Outside Coverage/.test(item.name)),
  JSON.stringify(provider.results));

const automatic = await page.evaluate(async () => {
  placesIndex = [['Seattle', -122.3321, 47.6062, 'city']];
  placesPromise = Promise.resolve();
  window.__automaticOnlineCalls = [];
  searchOnlinePlaces = async (query) => {
    window.__automaticOnlineCalls.push(query);
    return [
      { name: 'Acme Bicycle Shop, 100 Fremont Avenue, Seattle, Washington',
        lon: -122.35, lat: 47.65, source: 'online', type: 'bicycle shop', distanceM: 1200 },
      { name: 'Acme Bicycle Shop, 200 Ballard Avenue, Seattle, Washington',
        lon: -122.38, lat: 47.67, source: 'online', type: 'bicycle shop', distanceM: 3800 },
    ];
  };
  openPlaceSearch();
  const input = document.getElementById('placeSearch');
  input.value = 'Acme Bicycle Shop';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, ONLINE_PLACE_AUTO_DELAY_MS + 250));
  return {
    calls: [...window.__automaticOnlineCalls],
    names: [...document.querySelectorAll('#placeResults .place-hit:not(.place-internet-search)')]
      .map((button) => button.dataset.name),
    sections: [...document.querySelectorAll('#placeResults .place-results-section')]
      .map((heading) => heading.textContent),
    hint: document.getElementById('placePickerHint').textContent,
  };
});
check('zero offline matches automatically fall through to live search',
  automatic.calls.join() === 'Acme Bicycle Shop'
    && automatic.names.length === 2
    && automatic.names.every((name) => name.startsWith('Acme Bicycle Shop,'))
    && automatic.sections.join() === 'Internet results', JSON.stringify(automatic));
check('the automatic transition is explained inside the picker',
  /no offline matches|searching nearby places online/i.test(automatic.hint), automatic.hint);

const localFirst = await page.evaluate(async () => {
  window.__automaticOnlineCalls.length = 0;
  const input = document.getElementById('placeSearch');
  input.value = 'Seattle';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, ONLINE_PLACE_AUTO_DELAY_MS + 250));
  return {
    calls: [...window.__automaticOnlineCalls],
    local: document.querySelector('.place-hit:not(.place-internet-search)')?.dataset.name,
    manualChoice: Boolean(document.querySelector('.place-internet-search')),
  };
});
check('offline matches stay instant and do not trigger an automatic request',
  localFirst.calls.length === 0 && localFirst.local === 'Seattle' && localFirst.manualChoice,
  JSON.stringify(localFirst));

const automaticFailure = await page.evaluate(async () => {
  searchOnlinePlaces = async () => { throw new Error('offline'); };
  const input = document.getElementById('placeSearch');
  input.value = 'Uncached Neighborhood Cafe';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, ONLINE_PLACE_AUTO_DELAY_MS + 250));
  return {
    enabled: !input.disabled,
    message: document.getElementById('placeResults').textContent,
    retry: Boolean(document.querySelector('#placeResults .place-internet-search')),
  };
});
check('an automatic live-search failure leaves the picker usable and retryable',
  automaticFailure.enabled && automaticFailure.retry
    && /internet search is unavailable/i.test(automaticFailure.message),
  JSON.stringify(automaticFailure));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
site.close();
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;
