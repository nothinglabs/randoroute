# `maps/` — one folder per state

Everything that differs between states lives here. Nothing outside this folder
names a state.

```
maps/
  states.js            GENERATED index of the folders below (do not edit)
  <state>/
    region.json        the state's whole configuration
    STATUS.md          what works, what is missing, readiness out of 10
    BUILD.md           how every file in the folder was produced
    graph2.bin.gz      routing graph
    roads.pmtiles      street geometry, names, safety attributes
    basemap.pmtiles    land, water, green space, place labels
    overlays.pmtiles   traffic-stress and bike-infrastructure detail layers
    places.json        offline place-search index
    bikeroutes.geojson.gz, bike_restrictions.geojson.gz,
    route_closures.geojson.gz          small runtime overlays
    *.geojson, *.geojson.gz            build inputs kept for rebuilds
```

## How the app finds a state

`region.js` is the only code that reads a state's configuration. It picks one
entry out of `maps/states.js`, shapes it into the global `Region`, and every
data path in the app, the router worker and the service worker is then built
from `Region.dataUrl(...)`. Switching state is switching folders; there is no
other difference.

The rider chooses on **Settings → Maps**. One state at a time: the choice is
stored in `localStorage` under `jra-map-state-1` and the app reloads, because a
graph, three tile archives and a place index cannot be swapped under a running
map. The default for a rider who has never chosen is the first state with
`"status": "released"`.

Web and native differ in one way only:

* **Web** serves whichever folder the rider selected; the rest are on the
  server, unfetched.
* **iOS** bundles every state's files (`scripts/build_mobile_shell.mjs` walks
  `states.js`), so switching is instant and offline. On-demand delivery is the
  eventual answer to the size that grows into.

## Adding a state

**Start at `docs/PORTING-TO-ANOTHER-STATE.md`** — it is the entry point for the
whole job, and its "Start here" section gives the reading order, the build
sequence and the test that proves each stage. What follows here is only the
mechanical part: where the files go.

1. `mkdir maps/<state>` and write `region.json` (copy Washington's and change
   every value; the keys are validated, so a typo fails the build rather than
   silently doing nothing).
2. Build whatever data you have and put it in the folder. Declare exactly what
   you built in `"datasets"` — a state that ships only `places.json` is a valid
   state, and the app degrades to place search rather than 404ing its way
   through a startup.
3. `npm run maps:registry` to regenerate `maps/states.js`.
4. Write `STATUS.md` and `BUILD.md`. `STATUS.md` is what the next person reads
   to know whether to trust the data; `BUILD.md` is what they read to rebuild
   it.

No application file changes. If one has to, that is the bug — the state-specific
fact belongs in `region.json` and the code should read it from the region.

See `docs/PORTING-TO-ANOTHER-STATE.md` for what each configuration value means
and which agency data you need to find, and `docs/PORTING-LESSONS.md` for why the
thresholds are what they are and how an import fails in practice.

## `region.json`

| Key | What it does |
| --- | --- |
| `id` | Must equal the folder name. |
| `name` | Shown in loading copy and appended to a geocoded address. |
| `status` | `released` or `preview`. Only a `released` state can be the default. |
| `readiness` | 0–10, your own honest score. Shown nowhere; read by humans in `STATUS.md`. |
| `summary` | One line describing the state of the data. |
| `bounds` | Coverage box. A place-search hit outside it is dropped, because the graph stops at the state line. |
| `defaultCenter`, `defaultZoom` | Where the map opens with no saved view. |
| `stressAgency`, `restrictionAgency`, `speedAgency` | Who publishes each enrichment, as cited on a road card. They need not be the same agency. |
| `facilitySourceName`, `stressLayerName`, `restrictionLayerName` | The agency's own product names, as the layer list and cards spell them. |
| `interstateRoutePrefixes` | Route ids the agency uses for Interstates, when it records no separate flag. Empty if it does. |
| `facilityLevels` | The agency's facility vocabulary mapped onto the shared 0–5 level. |
| `routeDirectionSuffixes` | Trailing letters in a route id that mean a direction (`{"i": "increasing mileposts"}`). Empty if ids do not work that way. |
| `datasets` | Which files this folder actually has. The app, the service worker and the iOS bundler all read this. |
| `versions` | Content hashes, written by `build_graph.py` and `scripts/stamp_tiles_version.mjs`. Never hand-edit. |

## Stamps

`versions` is what makes a rider's service worker fetch a rebuilt file: caches
are keyed by URL, so an unchanged stamp means the new data is never downloaded
and nothing looks wrong. Both stampers derive the value from the artefact
itself and regenerate `states.js`:

```
python3 scripts/build_graph.py --out maps/<state>/graph2.bin.gz ...
node scripts/stamp_tiles_version.mjs <state>
```

`scripts/test_graph_version_stamp.mjs` fails the suite if a shipped graph does
not match its stamp, so a rebuild cannot ship quietly.
