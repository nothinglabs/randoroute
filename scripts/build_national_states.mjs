#!/usr/bin/env node
// Build the small resident orientation layer from the Census Bureau's
// 1:20,000,000 cartographic-boundary shapefile. This parser intentionally
// supports only Polygon shapefiles: accepting another shape type would make a
// bad input look like an empty national map.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return resolve(process.argv[index + 1]);
}

const shpPath = option('--shp');
const dbfPath = option('--dbf');
const outputPath = option('--output');
const shp = readFileSync(shpPath);
const dbf = readFileSync(dbfPath);

function dbfRows(bytes) {
  const count = bytes.readUInt32LE(4);
  const headerBytes = bytes.readUInt16LE(8);
  const recordBytes = bytes.readUInt16LE(10);
  const fields = [];
  let offset = 32, recordOffset = 1;
  while (offset + 32 <= headerBytes && bytes[offset] !== 0x0d) {
    const nul = bytes.indexOf(0, offset);
    const nameEnd = nul >= offset && nul < offset + 11 ? nul : offset + 11;
    const name = bytes.toString('ascii', offset, nameEnd).trim();
    const length = bytes[offset + 16];
    fields.push({ name, offset: recordOffset, length });
    recordOffset += length;
    offset += 32;
  }
  const rows = [];
  for (let index = 0; index < count; index++) {
    const start = headerBytes + index * recordBytes;
    if (bytes[start] === 0x2a) continue;
    const row = {};
    for (const field of fields) {
      row[field.name] = bytes.toString('utf8', start + field.offset,
        start + field.offset + field.length).trim();
    }
    rows.push(row);
  }
  return rows;
}

function signedArea(ring) {
  let area = 0;
  for (let index = 0; index + 1 < ring.length; index++) {
    area += ring[index][0] * ring[index + 1][1]
      - ring[index + 1][0] * ring[index][1];
  }
  return area / 2;
}

function contains(ring, point) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (((a[1] > point[1]) !== (b[1] > point[1]))
        && point[0] < (b[0] - a[0]) * (point[1] - a[1])
          / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function polygonGeometry(rings) {
  const outer = rings.filter((ring) => signedArea(ring) < 0)
    .map((ring) => ({ rings: [ring], area: Math.abs(signedArea(ring)) }));
  const holes = rings.filter((ring) => signedArea(ring) >= 0);
  // Defensive fallback for a producer using the opposite winding convention.
  if (!outer.length) return { type: 'MultiPolygon', coordinates: rings.map((ring) => [ring]) };
  for (const hole of holes) {
    const owner = outer.filter((polygon) => contains(polygon.rings[0], hole[0]))
      .sort((a, b) => a.area - b.area)[0];
    if (owner) owner.rings.push(hole);
    else outer.push({ rings: [hole], area: Math.abs(signedArea(hole)) });
  }
  return { type: 'MultiPolygon', coordinates: outer.map((polygon) => polygon.rings) };
}

function shapeRecords(bytes) {
  if (bytes.readInt32BE(0) !== 9994 || bytes.readInt32LE(28) !== 1000) {
    throw new Error('Input is not an ESRI shapefile');
  }
  const records = [];
  let offset = 100;
  while (offset + 8 <= bytes.length) {
    const contentBytes = bytes.readInt32BE(offset + 4) * 2;
    const start = offset + 8;
    const type = bytes.readInt32LE(start);
    if (type !== 0 && type !== 5) throw new Error(`Unsupported shapefile record type ${type}`);
    if (type === 5) {
      const partCount = bytes.readInt32LE(start + 36);
      const pointCount = bytes.readInt32LE(start + 40);
      const parts = [];
      for (let index = 0; index < partCount; index++) {
        parts.push(bytes.readInt32LE(start + 44 + index * 4));
      }
      parts.push(pointCount);
      const pointsStart = start + 44 + partCount * 4;
      const rings = [];
      for (let part = 0; part < partCount; part++) {
        const ring = [];
        for (let index = parts[part]; index < parts[part + 1]; index++) {
          const pointOffset = pointsStart + index * 16;
          const point = [Number(bytes.readDoubleLE(pointOffset).toFixed(4)),
            Number(bytes.readDoubleLE(pointOffset + 8).toFixed(4))];
          const prior = ring[ring.length - 1];
          if (!prior || prior[0] !== point[0] || prior[1] !== point[1]) ring.push(point);
        }
        if (ring.length >= 4) {
          const first = ring[0], last = ring[ring.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
          rings.push(ring);
        }
      }
      records.push(polygonGeometry(rings));
    } else records.push(null);
    offset = start + contentBytes;
  }
  return records;
}

const rows = dbfRows(dbf);
const geometries = shapeRecords(shp);
if (rows.length !== geometries.length) {
  throw new Error(`DBF has ${rows.length} rows but shapefile has ${geometries.length} records`);
}
const excluded = new Set(['AS', 'GU', 'MP', 'PR', 'VI']);
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const features = rows.map((row, index) => ({ row, geometry: geometries[index] }))
  .filter(({ row, geometry }) => geometry && !excluded.has(row.STUSPS))
  .map(({ row, geometry }) => ({
    type: 'Feature',
    id: slug(row.NAME),
    properties: {
      id: slug(row.NAME), name: row.NAME, abbreviation: row.STUSPS,
      fips: row.STATEFP,
    },
    geometry,
  }))
  .sort((a, b) => a.properties.name.localeCompare(b.properties.name));
if (features.length !== 51) throw new Error(`Expected 50 states plus DC, found ${features.length}`);

const output = {
  type: 'FeatureCollection',
  source: {
    name: 'U.S. Census Bureau 2025 Cartographic Boundary Files',
    scale: '1:20,000,000',
    url: 'https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html',
  },
  features,
};
writeFileSync(outputPath, `${JSON.stringify(output)}\n`);
console.log(`wrote ${features.length} state boundaries -> ${outputPath}`);
