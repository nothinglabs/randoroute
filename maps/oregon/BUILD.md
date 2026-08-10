# Building Oregon

What has actually been built, and the exact commands that produced it. Run from
the repo root.

## 0. The OSM extract

```bash
curl -o data/oregon-latest.osm.pbf \
  https://download.geofabrik.de/north-america/us/oregon-latest.osm.pbf
```

345 MB, EPSG:4326, git-ignored like every raw download.

## 1. Place index → `places.json`

```bash
python3 scripts/build_places.py \
  --src data/oregon-latest.osm.pbf \
  --out maps/oregon/places.json
```

1,461 settlements and ferry terminals, population-ranked, 68 KB. The builder is
state-agnostic; only the paths change.

## 2. Basemap → `basemap.pmtiles`

```bash
python3 scripts/build_basemap.py \
  --src data/oregon-latest.osm.pbf \
  --places maps/oregon/places.json \
  --natural-earth-land /path/to/ne_10m_land.shp \
  --out maps/oregon/basemap.pmtiles \
  --bounds " -124.9,41.7,-116.2,46.5"

node scripts/stamp_tiles_version.mjs oregon
```

`--bounds` is the state box padded by about a quarter degree, so the coastline
and the land backdrop run past the edge of coverage instead of stopping at it.
The leading space inside the quotes is a shell artefact — argparse otherwise
reads the leading `-124.9` as an option.

The detailed-coastline step traces OSM coastline ways (land on the left) and
produced 739 polygons: 738 closed island rings plus the mainland, closed off
against the eastern edge of the clip box. That construction assumes a
Pacific-facing coast running north–south, which is true for Oregon as it is for
Washington. A landlocked state should pass `--coastline natural-earth` and take
the generalized land polygon instead.

## Not built

`roads.pmtiles`, `overlays.pmtiles`, `graph2.bin.gz`, `bikeroutes.geojson.gz`,
`bike_restrictions.geojson.gz`, `route_closures.geojson.gz`. See `STATUS.md`
for what each would take.

`datasets` in `region.json` records exactly this, and the app reads it: no
routing worker is started, no missing tile source is added to the map style, no
layer appears in the layer list for data that is not there.

## Provenance

| File | Source | Built by |
| --- | --- | --- |
| `places.json` | OSM settlements + ferry terminals | `build_places.py` |
| `basemap.pmtiles` | OSM + Natural Earth 1:10m land + `places.json` | `build_basemap.py` |

Licences: OpenStreetMap contributors (ODbL); Natural Earth is public domain.
