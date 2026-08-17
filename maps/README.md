# `maps/` — one folder per state

Everything that differs between states lives here. Nothing outside this folder
names a state.

```
maps/
  states.js            GENERATED index of the folders below (do not edit)
  ROUTE-SOURCES.md      human approvals for exceptional non-OSM route sources
  route-sources.json   machine-readable companion to that approval record
  supplemental-routes.geojson.gz  reviewed source snapshot shared by rebuilds
  <state>/
    region.json        the state's whole configuration
    STATUS.md          what works, what is missing, readiness against the rubric
    VERIFICATION.md    routes checked against known-good sources (level 5+)
    BUILD.md           how every file in the folder was produced
    corridors.json     the corridors test_corridor_severance.mjs asserts, with
                       the reason each was nominated (level 3+)
    graph2.bin.gz      routing graph
    roads.pmtiles      street geometry, names, safety attributes
    basemap.pmtiles    land, water, green space, place labels
    overlays.pmtiles   traffic-stress and bike-infrastructure detail layers
    places.json        offline place-search index
    bikeroutes.geojson.gz, bike_restrictions.geojson.gz,
    route_closures.geojson.gz          small runtime overlays
    *.geojson, *.geojson.gz            build inputs kept for rebuilds
```

The three shared route-source files are the one deliberate exception to the
per-state-folder rule. They preserve a human source decision when a state
folder is deleted for a clean re-import. OSM remains the normal source. Read
[`ROUTE-SOURCES.md`](./ROUTE-SOURCES.md) before touching them: supplemental
route import is optional and approval-gated, not a standard state-import step.

## How the app finds a state

`region.js` is the only code that reads a state's configuration. It picks one
entry out of `maps/states.js`, shapes it into the global `Region`, and every
data path in the app, the router worker and the service worker is then built
from `Region.dataUrl(...)`. Switching state is switching folders; there is no
other difference.

The rider chooses on **Settings → Maps**. One state at a time: the choice is
stored in `localStorage` under `jra-map-state-1` and the app reloads, because a
graph, three tile archives and a place index cannot be swapped under a running
map. The default for a rider who has never chosen is the released state with
the highest `readiness` (folder order breaks ties), so releasing a second
state never changes what a new rider opens the app to.

Web and native differ in one way only:

* **Web** serves whichever folder the rider selected; the rest are on the
  server, unfetched.
* **iOS** bundles every state's files (`scripts/build_mobile_shell.mjs` reads
  `maps/index.json`), so switching is instant and offline.
  `JRA_SLIM_SHELL=1 npm run ios:sync` builds the on-demand variant instead:
  the states are indexed but carry no data, `MAP_STATES_BUNDLED` flips to
  false, and the Maps screen offers downloads. Ship slim only once a store is
  live and the download flow is field-verified.

## Map stores

The registry builder also emits **`maps/index.json`** — the same registry as
pure data, plus a per-state `files` list with byte sizes. That file is the
**map store contract** (`storeFormat: 1`): a store is any HTTPS directory
serving an `index.json` beside the state folders it describes, with CORS
enabled (`Access-Control-Allow-Origin: *`). The app's own origin is the
default store; a rider can add others on **Settings → Maps**, and
`map-store.js` downloads a state's files into the same offline cache the
service worker serves, under the same `maps/<id>/<file>` paths — nothing
downstream can tell an installed state from a bundled one. Installed states
are recorded in `localStorage` (`jra-installed-states-1`) and merged into the
index by `region.js` at startup. The index is validated strictly on both
ends: the builder refuses to emit an entry whose files are missing, and the
client refuses an index with unknown keys, unsafe paths, or missing sizes.

Hosting note: GitHub Pages caps files at 100 MB, which the tile archives
exceed. GitHub Releases (2 GB per asset, CORS enabled) or any static host
with CORS works; the files are served as-is, no packaging step.

## Adding a state

**Start at `docs/PORTING-TO-ANOTHER-STATE.md`** — it is the entry point for the
whole job, and its "Start here" section gives the reading order, the build
sequence and the test that proves each stage. What follows here is only the
mechanical part: where the files go.

1. `mkdir maps/<state>` and write `region.json` (copy Washington's and change
   every value; the keys are validated, so a typo fails the build rather than
   silently doing nothing), and `corridors.json` -- four to six real corridors,
   written down **before** anything is built, because choosing them afterwards
   means choosing the ones that happened to work. A state that ships a graph
   and nominates nothing fails `test_corridor_severance.mjs`.
2. Build whatever data you have and put it in the folder. Declare exactly what
   you built in `"datasets"` — a state that ships only `places.json` is a valid
   state, and the app degrades to place search rather than 404ing its way
   through a startup. Your agency fetchers go in **`maps/<state>/tools/`**,
   beside the data they produce (`maps/washington/tools/` is the model);
   `scripts/` holds only the shared, state-agnostic machinery. The `tools/`
   folder is build tooling, not shipped data — it is never listed in
   `datasets` and never enters a map pack.
3. `npm run maps:registry` to regenerate `maps/states.js`.
4. Write `STATUS.md` and `BUILD.md`. `STATUS.md` is what the next person reads
   to know whether to trust the data; `BUILD.md` is what they read to rebuild
   it.

No application file changes. If one has to, that is the bug — the state-specific
fact belongs in `region.json` and the code should read it from the region.

See `docs/PORTING-TO-ANOTHER-STATE.md` for what each configuration value means
and which agency data you need to find, and `docs/PORTING-LESSONS.md` for why the
thresholds are what they are and how an import fails in practice.

## Readiness: what the number means

`readiness` in `region.json` is a claim about how much of the state can be
trusted, and it is worthless unless it means the same thing everywhere. Each
level has a gate. **Do not award a level whose gate has not been met**, and do
not skip levels — the number is the lowest gate the state has cleared, not the
highest thing it has ever done.

| | Level | Gate |
|---|---|---|
| 0 | folder only | `region.json` exists and validates; nothing built |
| 1 | selectable | app opens on the state, `test_region_portable` and the Maps screen pass |
| 2 | **basic imports** | `places.json` + `basemap.pmtiles`. Search and a map; no routing |
| 3 | routable | `roads.pmtiles` + `graph2.bin.gz`. Routes return. OSM only — class-estimated speeds, no agency data |
| 4 | **routing is meaningful** | agency speed limits and bike facilities conflated; `test_corridor_severance` passes on the state's nominated corridors; `test_build_parity` and `test_fact_contract` green |
| 5 | **traffic, and verified by research** | traffic volume conflated (HPMS at minimum) **and** a written verification report — see below |
| 6 | enriched | stress rating, prohibitions and a shoulder inventory conflated where the state publishes them; `measure_coverage.py` run and its numbers recorded in `STATUS.md` |
| 7 | researched broadly | verification extended past one metro to the state's distinct regions — rural, mountain, coastal, whatever the state has |
| 8 | **field-validated** | a rider who knows the state has ridden routes it produced and reported back; corrections landed |
| 9 | sustained | field reports over time from more than one rider, and the corrections fed back into the data |
| 10 | — | reserved. No state is here, and it may not be reachable: no state publishes a stress rating for city streets, so some gaps close only when the source data does |

Washington is **8** and Oregon is **7**. Each `STATUS.md` says exactly why it is
not higher, in terms of coverage rather than effort, and a new state's should do
the same. Oregon's is the worked example of a state that reached an agent's
ceiling: it explains the number by naming the sources the state does not
publish, not the work that was not done.

### The verification report (level 5 and up)

Levels 5 and 7 are the ones an agent can reach without a bicycle, and they are
not a vibe check. The method is the one that found lesson C1: **take routes that
are already known to be good, and see whether the router agrees.**

Where those routes come from, roughly in order of value:

- **Published long-distance routes** — Adventure Cycling, US Bicycle Routes.
  These are already in the data as `route=bicycle` relations, so the router's
  answer can be compared against a corridor it can already see.
- **Randonneuring and club route libraries.** Brevets come with cue sheets:
  a turn-by-turn ground truth for a long route through real terrain.
- **State and regional agency bike maps**, and local advocacy organisations.
- **Forums and trip reports.** Low authority individually, high value in
  aggregate, and the source that caught the 45-mile detour.

What the report must contain, committed as `maps/<state>/VERIFICATION.md`:

1. Each route checked, with its **source and a link**, and the endpoints given
   to the router.
2. What the router returned, and whether it **resembles** the known-good route.
3. **Every disagreement, with a diagnosis.** A disagreement is a signal, not a
   failure — the router optimises for the rider's rules and a signed route can
   be a bad road (lesson D1), so it is *expected* to differ sometimes. What is
   not acceptable is an undiagnosed difference. Say which it is: a data gap, a
   severed link, a legitimate safety disagreement, or unknown.
4. What could **not** be verified, and why.

A state cannot claim 5 with a report that found nothing wrong and says so in one
line. A report that finds nothing has usually not looked hard enough at the
places the data is thinnest — which `measure_coverage.py` will name for you.

## `region.json`

| Key | What it does |
| --- | --- |
| `id` | Must equal the folder name. |
| `name` | Shown in loading copy and appended to a geocoded address. |
| `status` | `released` or `preview`. Only a `released` state can be the default. |
| `readiness` | 0–10 against the rubric above. Not a self-assessment — each level has a gate. |
| `summary` | One line describing the state of the data. |
| `bounds` | Coverage box. A place-search hit outside it is dropped, because the graph stops at the state line. |
| `defaultCenter`, `defaultZoom` | Where the map opens with no saved view. |
| `stressAgency`, `restrictionAgency`, `speedAgency` | Who publishes each enrichment, as cited on a road card. They need not be the same agency. |
| `facilitySourceName`, `stressLayerName`, `restrictionLayerName` | The agency's own product names, as the layer list and cards spell them. |
| `interstateRoutePrefixes` | Route ids the agency uses for Interstates, when it records no separate flag. Empty if it does. |
| `stateRoutePrefixes` | How the state spells a route ref (`SR 520`, `OR 224`). The graph and tile builds gate agency conflation on these (`--region`), and the app's name-based highway test derives from them. |
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
