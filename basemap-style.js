/* Shared, fully local vector basemap for the web app and native shell. */
(function installBikeBasemap(global) {
  'use strict';

  const FONT_STACK = 'Klokantech Noto Sans Regular';
  const CONTEXT_URL = 'pmtiles://data/basemap.pmtiles?v=1';
  const ROADS_URL = 'pmtiles://data/roads.pmtiles?v=11';
  let protocol = null;

  function ensureProtocol() {
    if (protocol || !global.pmtiles || !global.maplibregl) return protocol;
    protocol = new global.pmtiles.Protocol();
    global.maplibregl.addProtocol('pmtiles', protocol.tile);
    return protocol;
  }

  function assetUrl(path) {
    return new URL(path, global.location.href).href;
  }

  function glyphUrl() {
    return `${new URL('.', global.location.href).href}fonts/{fontstack}/{range}.pbf`;
  }

  const roadMatch = (classes) => ['match', ['get', 'h'], classes, true, false];
  const named = ['all', ['has', 'n'], ['!=', ['get', 'n'], '']];
  const majorRoads = [
    'motorway', 'motorway_link', 'trunk', 'trunk_link',
    'primary', 'primary_link',
  ];
  const mediumRoads = [
    'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  ];
  const localRoads = ['unclassified', 'residential', 'living_street'];

  function lineLayer(id, minzoom, filter, casing) {
    return {
      id,
      type: 'line',
      source: 'basemap-roads',
      'source-layer': 'roads',
      minzoom,
      filter,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: casing ? {
        'line-color': '#c8cfd2',
        'line-width': ['interpolate', ['linear'], ['zoom'],
          5, 1.1, 8, 1.8, 11, 3.2, 14, 6.2, 17, 11],
        'line-opacity': 0.9,
      } : {
        'line-color': ['match', ['get', 'h'],
          ['motorway', 'motorway_link'], '#f3dec1',
          ['trunk', 'trunk_link', 'primary', 'primary_link'], '#fff5df',
          '#ffffff'],
        'line-width': ['interpolate', ['linear'], ['zoom'],
          5, 0.6, 8, 1.1, 11, 2.2, 14, 4.7, 17, 9],
        'line-opacity': 0.98,
      },
    };
  }

  function roadLabel(id, minzoom, classes, sizeStops) {
    return {
      id,
      type: 'symbol',
      source: 'basemap-roads',
      'source-layer': 'roads',
      minzoom,
      filter: ['all', named, roadMatch(classes)],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 320,
        'text-field': ['get', 'n'],
        'text-font': [FONT_STACK],
        'text-size': ['interpolate', ['linear'], ['zoom'], ...sizeStops],
        'text-max-angle': 35,
        'text-padding': 3,
        'text-keep-upright': true,
      },
      paint: {
        'text-color': '#69767d',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
        'text-halo-blur': 0.35,
      },
    };
  }

  function createStyle() {
    ensureProtocol();
    return {
      version: 8,
      glyphs: glyphUrl(),
      sources: {
        'basemap-context': {
          type: 'vector',
          url: CONTEXT_URL,
          attribution: '© OpenStreetMap contributors · Natural Earth',
        },
        'basemap-roads': {
          type: 'vector',
          url: ROADS_URL,
          attribution: '© OpenStreetMap contributors',
        },
      },
      layers: [
        { id: 'basemap-ocean', type: 'background', paint: { 'background-color': '#dcecf2' } },
        { id: 'basemap-land', type: 'fill', source: 'basemap-context', 'source-layer': 'land',
          paint: { 'fill-color': '#f4f3ee' } },
        { id: 'basemap-green', type: 'fill', source: 'basemap-context', 'source-layer': 'green',
          paint: {
            'fill-color': ['match', ['get', 'k'],
              'wetland', '#dfeadf',
              ['forest', 'national_park', 'protected'], '#e4eddf',
              'golf', '#e8efdc',
              '#edf1e5'],
            'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.72, 11, 0.88],
          } },
        { id: 'basemap-water', type: 'fill', source: 'basemap-context', 'source-layer': 'water',
          paint: { 'fill-color': '#dcecf2', 'fill-outline-color': '#c5dce6' } },
        { id: 'basemap-waterways', type: 'line', source: 'basemap-context',
          'source-layer': 'waterway', minzoom: 8,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#b9d8e4',
            'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 12, 1.2, 16, 2.4],
            'line-opacity': 0.9,
          } },
        lineLayer('basemap-major-casing', 5, roadMatch(majorRoads), true),
        lineLayer('basemap-major', 5, roadMatch(majorRoads), false),
        lineLayer('basemap-medium-casing', 8, roadMatch(mediumRoads), true),
        lineLayer('basemap-medium', 8, roadMatch(mediumRoads), false),
        lineLayer('basemap-local-casing', 11, roadMatch(localRoads), true),
        lineLayer('basemap-local', 11, roadMatch(localRoads), false),
        { id: 'basemap-water-labels', type: 'symbol', source: 'basemap-context',
          'source-layer': 'water', minzoom: 9, filter: named,
          layout: {
            'text-field': ['get', 'n'], 'text-font': [FONT_STACK],
            'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 14, 13],
            'text-padding': 6,
          },
          paint: {
            'text-color': '#6d94a4', 'text-halo-color': '#e8f3f7',
            'text-halo-width': 1.2,
          } },
        { id: 'basemap-green-labels', type: 'symbol', source: 'basemap-context',
          'source-layer': 'green', minzoom: 11, filter: named,
          layout: {
            'text-field': ['get', 'n'], 'text-font': [FONT_STACK],
            'text-size': 10.5, 'text-padding': 5,
          },
          paint: {
            'text-color': '#668063', 'text-halo-color': '#f2f5ed',
            'text-halo-width': 1.2,
          } },
        roadLabel('basemap-major-labels', 7, majorRoads, [7, 10, 13, 13]),
        roadLabel('basemap-medium-labels', 10, mediumRoads, [10, 10, 15, 12.5]),
        roadLabel('basemap-local-labels', 12.2, localRoads, [12, 9.5, 17, 12]),
        { id: 'basemap-place-labels', type: 'symbol', source: 'basemap-context',
          'source-layer': 'places',
          layout: {
            'text-field': ['get', 'n'],
            'text-font': [FONT_STACK],
            'text-size': ['interpolate', ['linear'], ['zoom'],
              5, ['case', ['>=', ['get', 'p'], 100000], 14, 11],
              9, ['case', ['>=', ['get', 'p'], 25000], 15, 11],
              13, ['case', ['match', ['get', 'k'], ['city', 'town'], true, false], 14, 11]],
            'text-padding': 8,
            'text-allow-overlap': false,
            'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'p'], 0]],
          },
          paint: {
            'text-color': '#4f5d64',
            'text-halo-color': '#f8f8f4',
            'text-halo-width': 1.7,
            'text-halo-blur': 0.4,
          } },
      ],
    };
  }

  global.BikeBasemap = {
    FONT_STACK,
    ensureProtocol,
    createStyle,
  };
})(window);
