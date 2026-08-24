#!/usr/bin/env node
// Non-home detailed tiles follow the viewport, not installed-state count.
import vm from 'node:vm';
import { check, checkEqual, done, source } from './testlib/harness.mjs';

const context = {
  URL, setTimeout, clearTimeout,
  location: { href: 'https://example.test/app/' },
  Region: {
    id: 'home', datasets: { regional: true, basemap: true, roads: true },
    versions: { regional: 'sha-home-regional' },
    dataUrl: (file) => `maps/home/${file}`,
  },
};
context.window = context;
vm.runInNewContext(source('basemap-style.js'), context);

class FakeMap {
  constructor() {
    this.zoom = 7;
    this.bounds = { minLon: 1.1, minLat: 0.2, maxLon: 1.8, maxLat: 0.8 };
    this.sources = new Map([
      ['basemap-regional', {}], ['basemap-regional-places', {}],
      ['basemap-context', {}], ['basemap-roads', {}], ['route', {}],
    ]);
    this.layers = [
      { id: 'basemap-ocean', type: 'background' },
      { id: 'basemap-regional-land-detail', type: 'fill', source: 'basemap-regional',
        'source-layer': 'land_detail', minzoom: 4, maxzoom: 9 },
      { id: 'basemap-regional-water', type: 'fill', source: 'basemap-regional',
        'source-layer': 'water', minzoom: 4, maxzoom: 9 },
      { id: 'basemap-land', type: 'fill', source: 'basemap-context',
        'source-layer': 'land' },
      { id: 'basemap-water', type: 'fill', source: 'basemap-context',
        'source-layer': 'water' },
      { id: 'basemap-major', type: 'line', source: 'basemap-roads',
        'source-layer': 'roads' },
      { id: 'roads', type: 'line', source: 'basemap-roads',
        'source-layer': 'roads' },
      { id: 'basemap-place-labels', type: 'symbol', source: 'basemap-context',
        'source-layer': 'places' },
      { id: 'route-line', type: 'line', source: 'route' },
    ];
  }
  getZoom() { return this.zoom; }
  getBounds() {
    return { getWest: () => this.bounds.minLon, getSouth: () => this.bounds.minLat,
      getEast: () => this.bounds.maxLon, getNorth: () => this.bounds.maxLat };
  }
  getStyle() { return { layers: this.layers }; }
  getSource(id) { return this.sources.get(id); }
  addSource(id, definition) { this.sources.set(id, definition); }
  removeSource(id) { this.sources.delete(id); }
  getLayer(id) { return this.layers.find((layer) => layer.id === id); }
  addLayer(layer, before) {
    const at = before ? this.layers.findIndex((candidate) => candidate.id === before) : -1;
    if (at < 0) this.layers.push(layer);
    else this.layers.splice(at, 0, layer);
  }
  removeLayer(id) { this.layers = this.layers.filter((layer) => layer.id !== id); }
}

const state = (id, minLon, maxLon) => ({ id,
  bounds: { minLon, minLat: 0, maxLon, maxLat: 1 },
  datasets: { regional: true, basemap: true, roads: true, overlays: true },
  versions: { regional: `sha-${id}-regional` } });
const states = [state('home', 0, 1), state('visible', 1, 2), state('far', 8, 9)];
const map = new FakeMap();
const visible = context.BikeBasemap.syncVisibleStateSources(map, states, 'home');
checkEqual('only the non-home installed state intersecting the viewport is attached',
  visible.join(), 'visible');
check('the visible state receives ground and road sources at logical installed-map URLs',
  map.getSource('state-visible-basemap-regional')?.url
    === 'pmtiles://maps/visible/regional.pmtiles?v=sha-visible-regional'
    && map.getSource('state-visible-basemap-context')?.url
    === 'pmtiles://maps/visible/basemap.pmtiles?v=5'
    && map.getSource('state-visible-basemap-roads')?.url
      === 'pmtiles://maps/visible/roads.pmtiles?v=24'
    && map.getSource('state-visible-basemap-overlays')?.url
      === 'pmtiles://maps/visible/overlays.pmtiles?v=2');
check('visible-state basemap layers stay beneath the route overlay',
  map.layers.findIndex((layer) => layer.id === 'state-visible-basemap-major')
    < map.layers.findIndex((layer) => layer.id === 'route-line')
    && map.layers.findIndex((layer) => layer.id === 'state-visible-basemap-land')
      > map.layers.findIndex((layer) => layer.id === 'basemap-ocean')
    && map.layers.findIndex((layer) => layer.id === 'state-visible-basemap-place-labels')
      < map.layers.findIndex((layer) => layer.id === 'basemap-place-labels'));
check('visible-state land cannot cover water and neutral roads cannot cover safety paint',
  map.layers.findIndex((layer) => layer.id === 'state-visible-basemap-regional-land-detail')
      < map.layers.findIndex((layer) => layer.id === 'basemap-regional-water')
    && map.layers.findIndex((layer) => layer.id === 'state-visible-basemap-land')
      < map.layers.findIndex((layer) => layer.id === 'basemap-water')
    && map.layers.findIndex((layer) => layer.id === 'state-visible-basemap-major')
      < map.layers.findIndex((layer) => layer.id === 'roads'));
check('installed maps outside the viewport do not attach tile archives',
  !map.getSource('state-far-basemap-regional')
    && !map.getSource('state-far-basemap-context') && !map.getSource('state-far-basemap-roads'));

const regionalMap = new FakeMap();
regionalMap.zoom = 4;
const regionalVisible = context.BikeBasemap.syncVisibleStateSources(
  regionalMap, states, 'home');
check('a z4 viewport attaches only the neighbor compact regional archive',
  regionalVisible.join() === 'visible'
    && !!regionalMap.getSource('state-visible-basemap-regional')
    && !!regionalMap.getLayer('state-visible-basemap-regional-land-detail')
    && !!regionalMap.getLayer('state-visible-basemap-regional-water')
    && !regionalMap.getSource('state-visible-basemap-context')
    && !regionalMap.getSource('state-visible-basemap-roads'),
  JSON.stringify([...regionalMap.sources.keys()]));
regionalMap.bounds = { minLon: 4, minLat: 0.2, maxLon: 5, maxLat: 0.8 };
const regionalGone = context.BikeBasemap.syncVisibleStateSources(
  regionalMap, states, 'home');
check('a z4 neighbor detaches after it leaves the regional viewport hysteresis band',
  regionalGone.length === 0
    && !regionalMap.getSource('state-visible-basemap-regional')
    && !regionalMap.layers.some((layer) => layer.id.startsWith('state-visible-')),
  JSON.stringify([...regionalMap.sources.keys()]));

map.zoom = 4;
const national = context.BikeBasemap.syncVisibleStateSources(map, states, 'home');
check('zooming out retains the attached neighbor instead of churning it',
  national.join() === 'visible'
    && !!map.getSource('state-visible-basemap-regional')
    && !!map.getSource('state-visible-basemap-context'));

map.zoom = 7;
map.bounds = { minLon: 2.5, minLat: 0.2, maxLon: 3.2, maxLat: 0.8 };
const nearby = context.BikeBasemap.syncVisibleStateSources(map, states, 'home');
check('a neighbor just out of view is retained by hysteresis, not detached',
  nearby.join() === 'visible' && !!map.getSource('state-visible-basemap-roads')
    && map.layers.some((layer) => layer.id.startsWith('state-visible-')));

map.bounds = { minLon: 6, minLat: 0.2, maxLon: 7.5, maxLat: 0.8 };
const moved = context.BikeBasemap.syncVisibleStateSources(map, states, 'home');
check('panning a full viewport away detaches the old neighbor and attaches the new',
  moved.join() === 'far' && !map.getSource('state-visible-basemap-context')
    && !map.getSource('state-visible-basemap-regional')
    && !map.getSource('state-visible-basemap-overlays')
    && !map.layers.some((layer) => layer.id.startsWith('state-visible-'))
    && !!map.getSource('state-far-basemap-context'));

done();
