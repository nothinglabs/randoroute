#!/bin/bash
# Fetch a state's DEM (AWS Terrarium elevation tiles, z12 ~= 38 m) into the
# state's own dem/ folder. One-time build input for scripts/build_graph.py.
# Re-runnable; skips tiles already on disk.
#
# Usage:
#   scripts/fetch_dem.sh <state>
#   scripts/fetch_dem.sh <state> <minLon> <minLat> <maxLon> <maxLat>
#
# With one argument the box is read from maps/<state>/region.json, which is
# where a state's coverage is already declared -- so the bounding box cannot
# drift away from the one the app filters place searches against. Washington's
# box was hardcoded here for as long as there was only one state, which made
# this the last hard blocker between a fresh state and a routing graph.
#
# The box is padded by a quarter degree. A DEM sample is taken along an edge,
# and an edge that leaves the coverage box by a few hundred metres would
# otherwise read as a cliff at the state line.
set -e

STATE="${1:?usage: scripts/fetch_dem.sh <state> [minLon minLat maxLon maxLat]}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/maps/$STATE/region.json"
OUT="$ROOT/maps/$STATE/dem"

if [ "$#" -eq 5 ]; then
  MINLON="$2"; MINLAT="$3"; MAXLON="$4"; MAXLAT="$5"
elif [ "$#" -eq 1 ]; then
  [ -f "$CONFIG" ] || { echo "no such state: $CONFIG" >&2; exit 1; }
  read -r MINLON MINLAT MAXLON MAXLAT < <(python3 -c "
import json,sys
b=json.load(open(sys.argv[1]))['bounds']
print(b['minLon'], b['minLat'], b['maxLon'], b['maxLat'])
" "$CONFIG")
else
  echo "usage: scripts/fetch_dem.sh <state> [minLon minLat maxLon maxLat]" >&2
  exit 1
fi

echo "DEM for $STATE: $MINLON,$MINLAT .. $MAXLON,$MAXLAT -> maps/$STATE/dem/"
mkdir -p "$OUT"
cd "$OUT"

python3 - "$MINLON" "$MINLAT" "$MAXLON" "$MAXLAT" <<'PYEOF' > tiles.txt
import math, sys
minlon, minlat, maxlon, maxlat = (float(v) for v in sys.argv[1:5])
PAD = 0.25
minlon -= PAD; minlat -= PAD; maxlon += PAD; maxlat += PAD
def tx(lon, z): return int((lon + 180) / 360 * (2 ** z))
def ty(lat, z):
    r = math.radians(lat)
    return int((1 - math.asinh(math.tan(r)) / math.pi) / 2 * (2 ** z))
Z = 12
# y grows southward, so the north edge gives the low y.
for x in range(tx(minlon, Z), tx(maxlon, Z) + 1):
    for y in range(ty(maxlat, Z), ty(minlat, Z) + 1):
        print(f"{Z}/{x}/{y}")
PYEOF

echo "$(wc -l < tiles.txt) tiles to consider"
rm -f fails.txt

fetch_one() {
  t="$1"; out="${t//\//_}.png"
  [ -s "$out" ] && return 0
  for i in 1 2 3; do
    curl -sS -m 30 -o "$out" "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/$t.png" && [ -s "$out" ] && return 0
    sleep 2
  done
  echo "FAIL $t" >> fails.txt
}
export -f fetch_one
xargs -P 16 -I{} bash -c 'fetch_one "$@"' _ {} < tiles.txt
FAILED=0; [ -f fails.txt ] && FAILED="$(wc -l < fails.txt)"
echo "DONE: $(ls *.png 2>/dev/null | wc -l) tiles, $FAILED failures"
