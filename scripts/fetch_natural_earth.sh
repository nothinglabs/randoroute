#!/bin/bash
# Fetch the Natural Earth 1:10m land polygon into data/natural-earth/.
# Build input for scripts/build_basemap.py, shared by every state -- it is world
# coverage, clipped to each state's box at build time. Re-runnable; skips a
# shapefile already on disk.
#
# Usage: scripts/fetch_natural_earth.sh
#
# This exists because every document that needed it said
# `--natural-earth-land /path/to/ne_10m_land.shp` and left the reader to work
# out what that path was. A placeholder is not a build step: the file happened
# to be lying around in the container where Washington was built, so nothing
# noticed until a fresh state was attempted somewhere else.
#
# Public domain. Version is recorded in ne_10m_land.VERSION.txt beside the
# shapefile; 5.1.1 is what Washington's basemap was built against.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/data/natural-earth"
URL="https://naciscdn.org/naturalearth/10m/physical/ne_10m_land.zip"

if [ -s "$OUT/ne_10m_land.shp" ]; then
  echo "already present: $OUT/ne_10m_land.shp"
  [ -f "$OUT/ne_10m_land.VERSION.txt" ] && echo "version $(cat "$OUT/ne_10m_land.VERSION.txt")"
  exit 0
fi

mkdir -p "$OUT"
echo "fetching $URL"
curl -sSL -m 300 -o "$OUT/ne_10m_land.zip" "$URL"
unzip -oq "$OUT/ne_10m_land.zip" -d "$OUT"
rm -f "$OUT/ne_10m_land.zip"

[ -s "$OUT/ne_10m_land.shp" ] || { echo "no shapefile after unzip" >&2; exit 1; }
echo "ready: $OUT/ne_10m_land.shp"
[ -f "$OUT/ne_10m_land.VERSION.txt" ] && echo "version $(cat "$OUT/ne_10m_land.VERSION.txt")"
