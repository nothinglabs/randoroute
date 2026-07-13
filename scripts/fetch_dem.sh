#!/bin/bash
# Fetch the WA DEM (AWS Terrarium elevation tiles, z12 ~= 38 m) into data/dem/.
# One-time build input for scripts/build_graph.py. Re-runnable; skips existing.
set -e
mkdir -p data/dem
cd data/dem
python3 - <<'PYEOF' > tiles.txt
import math
def tx(lon,z): return int((lon+180)/360*(2**z))
def ty(lat,z):
    r=math.radians(lat); return int((1-math.asinh(math.tan(r))/math.pi)/2*(2**z))
Z=12
for x in range(tx(-124.9,Z), tx(-116.85,Z)+1):
    for y in range(ty(49.06,Z), ty(45.50,Z)+1):
        print(f"{Z}/{x}/{y}")
PYEOF
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
echo "DONE: $(ls *.png 2>/dev/null | wc -l) tiles, $(cat fails.txt 2>/dev/null | wc -l || echo 0) failures"
