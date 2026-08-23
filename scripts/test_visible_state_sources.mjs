#!/usr/bin/env node
// Non-home detailed tiles follow the viewport, not installed-state count.
import vm from 'node:vm';
import { check, checkEqual, done, source } from './testlib/harness.mjs';

const context = {
  URL, setTimeout, clearTimeout,
  location: { href: 'https://example.test/app/' },
  Region: {
    id: 'home', datasets: { basemap: true, roads: true },
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
      ['basemap-context', {}], ['basemap-roads', {}], ['route', {}],
    ]);
    this.layers = [
      { id: 'basemap-ocean', type: 'background' },
      { id: 'basemap-land', type: 'fill', source: 'basemap-context',
        'source-layer': 'land' },
      { id: 'basemap-major', type: 'line', source: 'basemap-roads',
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
  datasets: { basemap: true, roads: true, overlays: true } });
const states = [state('home', 0, 1), state('visible', 1, 2), state('far', 8, 9)];
const map = new FakeMap();
const visible = context.BikeBasemap.syncVisibleStateSources(map, states, 'home');
checkEqual('only the non-home installed state intersecting the viewport is attached',
  visible.join(), 'visible');
check('the visible state receives ground and road sources at logical installed-map URLs',
  map.getSource('state-visible-basemap-context')?.url
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
check('installed maps outside the viewport do not attach tile archives',
  !map.getSource('state-far-basemap-context') && !map.getSource('state-far-basemap-roads'));

map.zoom = 4;
const national = context.BikeBasemap.syncVisibleStateSources(map, states, 'home');
check('national zoom removes non-home detailed sources and their layers',
  national.length === 0 && !map.getSource('state-visible-basemap-context')
    && !map.getSource('state-visible-basemap-overlays')
    && !map.layers.some((layer) => layer.id.startsWith('state-visible-')));

done();
