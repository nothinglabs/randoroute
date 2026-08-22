#!/usr/bin/env node
// Export the bicycle-routable ferry network from each state's graph as a tiny
// always-on map overlay. The graph is the source of truth: exporting from it
// means the background line and the route planner cannot disagree about which
// boats a bicycle can use.
//
// Usage:
//   node scripts/build_ferries.mjs             # every state with a graph
//   node scripts/build_ferries.mjs washington  # one state
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { mapStates, routerWorker, ROOT } from './testlib/harness.mjs';

const EARTH_M = 6_371_000;
function distanceM(a, b) {
  const rad = Math.PI / 180;
  const p1 = a[1] * rad, p2 = b[1] * rad;
  const dp = (b[1] - a[1]) * rad, dl = (b[0] - a[0]) * rad;
  const h = Math.sin(dp / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(h));
}

function lineLengthM(coordinates) {
  let metres = 0;
  for (let i = 1; i < coordinates.length; i++) {
    metres += distanceM(coordinates[i - 1], coordinates[i]);
  }
  return metres;
}

// OSM splits a ferry way anywhere another kept way shares a node. Those graph
// fragments are right for routing, but drawing each fragment independently
// restarts the dash pattern and label placement at every split. Join all
// degree-two runs with the same service name before handing them to the map.
function mergeNamedRuns(edges) {
  const groups = new Map();
  edges.forEach((edge, index) => {
    const key = edge.name || `__unnamed_${index}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
  });
  const lines = [];
  for (const group of groups.values()) {
    const incident = new Map();
    group.forEach((edge, index) => {
      for (const node of [edge.a, edge.b]) {
        if (!incident.has(node)) incident.set(node, []);
        incident.get(node).push(index);
      }
    });
    const used = new Set();
    const walk = (firstIndex, startNode) => {
      const first = group[firstIndex];
      let edgeIndex = firstIndex;
      let node = startNode;
      let coordinates = [];
      let edgeCount = 0;
      let endNode = startNode;
      while (!used.has(edgeIndex)) {
        used.add(edgeIndex);
        const edge = group[edgeIndex];
        const forward = edge.a === node;
        const part = forward ? edge.coordinates : [...edge.coordinates].reverse();
        if (coordinates.length) part.shift();
        coordinates.push(...part);
        edgeCount += edge.edgeCount;
        endNode = forward ? edge.b : edge.a;
        const next = (incident.get(endNode) || []).filter((index) => !used.has(index));
        if ((incident.get(endNode) || []).length !== 2 || next.length !== 1) break;
        node = endNode;
        [edgeIndex] = next;
      }
      lines.push({
        name: first.name,
        coordinates,
        edgeCount,
        startNode,
        endNode,
        lengthM: lineLengthM(coordinates),
      });
    };

    // Begin at terminals and branches; any remainder is a closed loop.
    for (const [node, indexes] of incident) {
      if (indexes.length === 2) continue;
      for (const index of indexes) if (!used.has(index)) walk(index, node);
    }
    group.forEach((edge, index) => {
      if (!used.has(index)) walk(index, edge.a);
    });
  }
  return lines;
}

function sameTerminals(a, b, toleranceM = 450) {
  const a0 = a.coordinates[0], a1 = a.coordinates.at(-1);
  const b0 = b.coordinates[0], b1 = b.coordinates.at(-1);
  return (distanceM(a0, b0) <= toleranceM && distanceM(a1, b1) <= toleranceM)
    || (distanceM(a0, b1) <= toleranceM && distanceM(a1, b0) <= toleranceM);
}

// The Washington extract contains parallel OSM ways for the car ferry, fast
// ferry and route-ref versions of the same water corridor. They are different
// routing edges, but painting all of them makes Puget Sound look like a bundle
// of cables. Keep the most complete centreline and account for the alternatives
// it represents. Short dock spurs with the same service name are absorbed too.
function physicalLines(edges) {
  const lines = mergeNamedRuns(edges);
  const parent = lines.map((_, index) => index);
  const root = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const join = (a, b) => {
    a = root(a); b = root(b);
    if (a !== b) parent[b] = a;
  };
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const longer = Math.max(lines[i].lengthM, lines[j].lengthM);
      const shorter = Math.min(lines[i].lengthM, lines[j].lengthM);
      if (shorter < 500 || shorter / longer < 0.72) continue;
      if (sameTerminals(lines[i], lines[j])) join(i, j);
    }
  }

  const byRoot = new Map();
  lines.forEach((line, index) => {
    const key = root(index);
    if (!byRoot.has(key)) byRoot.set(key, []);
    byRoot.get(key).push(line);
  });
  const kept = [...byRoot.values()].map((group) => {
    const chosen = group.slice().sort((a, b) => b.lengthM - a.lengthM
      || Number(/^\s*(?:[A-Z]{1,3}\s*)?\d+\s*$/.test(a.name || ''))
        - Number(/^\s*(?:[A-Z]{1,3}\s*)?\d+\s*$/.test(b.name || '')))[0];
    return { ...chosen, edgeCount: group.reduce((sum, line) => sum + line.edgeCount, 0) };
  });

  for (const line of kept.slice()) {
    if (line.lengthM >= 500 || !line.name) continue;
    const parentLine = kept.find((candidate) => candidate !== line
      && candidate.name === line.name && candidate.lengthM >= 500
      && line.coordinates.every((point) => Math.min(
        distanceM(point, candidate.coordinates[0]),
        distanceM(point, candidate.coordinates.at(-1)),
      ) <= 500));
    if (!parentLine) continue;
    parentLine.edgeCount += line.edgeCount;
    kept.splice(kept.indexOf(line), 1);
  }
  return kept;
}

const requested = process.argv[2] || null;
const states = mapStates().filter((state) => state.datasets?.graph
  && (!requested || state.id === requested));

if (requested && !states.length) {
  throw new Error(`no graph-backed state named "${requested}"`);
}

for (const state of states) {
  const worker = routerWorker({ state: state.id });
  if (!worker.ready) throw new Error(`${state.id}: routing graph did not load`);
  const edges = worker.run(`(() => {
    const edges = [];
    for (let edge = 0; edge < E; edge++) {
      if (!(eFlags[edge] & 32)) continue;
      const start = eOff[edge], count = eCnt[edge];
      const coordinates = [];
      for (let i = 0; i < count; i++) {
        coordinates.push([
          +gLon[start + i].toFixed(6),
          +gLat[start + i].toFixed(6),
        ]);
      }
      if (coordinates.length < 2) continue;
      const name = edgeName(edge);
      edges.push({ a: eA[edge], b: eB[edge], name, coordinates, edgeCount: 1 });
    }
    return edges;
  })()`);
  const lines = physicalLines(edges);
  const collection = {
    type: 'FeatureCollection',
    features: lines.map((line) => ({
      type: 'Feature',
      properties: { ...(line.name ? { n: line.name } : {}), e: line.edgeCount },
      geometry: { type: 'LineString', coordinates: line.coordinates },
    })),
  };
  const json = `${JSON.stringify(collection)}\n`;
  const output = join(ROOT, 'maps', state.id, 'ferries.geojson.gz');
  writeFileSync(output, gzipSync(Buffer.from(json), { level: 9, mtime: 0 }));
  const names = new Set(collection.features.map((feature) => feature.properties.n).filter(Boolean));
  console.log(`${state.id}: ${edges.length} graph edges -> ${collection.features.length} ferry lines, `
    + `${names.size} named routes -> ${output}`);
}
