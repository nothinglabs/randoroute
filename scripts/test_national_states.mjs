#!/usr/bin/env node
// The resident orientation layer is complete, small, and contains boundary
// identity only. Detailed streets and routing data belong to state packs.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { check, done, ROOT } from './testlib/harness.mjs';

const path = join(ROOT, 'maps/national-states.geojson');
const collection = JSON.parse(readFileSync(path, 'utf8'));
const ids = collection.features.map((feature) => feature.properties.id);
check('the national orientation layer contains 50 states plus DC exactly once',
  collection.type === 'FeatureCollection' && collection.features.length === 51
    && new Set(ids).size === 51 && ids.includes('district-of-columbia'));
check('the orientation layer records its authoritative Census source',
  /Census Bureau 2025/.test(collection.source?.name || '')
    && collection.source?.scale === '1:20,000,000'
    && /^https:\/\/www\.census\.gov\//.test(collection.source?.url || ''),
  JSON.stringify(collection.source));
check('the resident layer stays below 350 KB', statSync(path).size < 350000,
  `${statSync(path).size} bytes`);
check('features carry only boundary identity and polygon geometry',
  collection.features.every((feature) =>
    feature.geometry?.type === 'MultiPolygon'
      && Object.keys(feature.properties).sort().join('|')
        === 'abbreviation|fips|id|name'),
  JSON.stringify(collection.features.find((feature) =>
    feature.geometry?.type !== 'MultiPolygon' || Object.keys(feature.properties).length !== 4)));

done();
