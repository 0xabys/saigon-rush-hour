# OSM pipeline — central District 1

Turns two Overpass responses plus the Google Open Buildings v3 tile into the generalized road network and the 3D scene the simulator
loads. Runs with bun; the app itself never touches the network.

```
npm run osm                  # raw caches → src/data/q1-network.json, q1-scene.json, data/osm/report.json
npm run osm:check            # rebuild in memory, fail unless all three files are byte-identical (also: npm run osm --check)
npm run osm:refresh          # calls Overpass (POST, User-Agent, 3 retries after 2/6/18 s) for BOTH caches and rewrites them
npm run osm:refresh-extra    # calls Overpass for the scene-only cache only; raw-q1.json and q1-network.json stay byte-identical
npm run osm:refresh-gob      # downloads Google Open Buildings v3 tile 317 (1.9 GB) and rewrites raw-q1-gob.json; q1-network.json stays byte-identical
GOB_TILE_PATH=/path/317_buildings.csv.gz npm run osm:refresh-gob   # same, from an already downloaded tile (no download, ~30 s)
npm run debug                # vite dev server opened at /debug.html (dev only; production build still outputs only index.html)
```

`npm run osm --check` works because the script also reads `npm_config_check`; `npm run osm -- --check` works too.

## Files

| Path | Role |
| --- | --- |
| `data/osm/raw-q1.json` | Overpass cache (`meta` + response, one element per line). Commit it. |
| `data/osm/raw-q1-extra.json` | Second cache with its own query hash: `landuse=construction\|brownfield`, `place=square`, `highway=pedestrian` + `area=yes`. Feeds only `q1-scene.json` (`sites`, `plazas`, `extraSource`), so refreshing it never alters `q1-network.json`. Commit it. |
| `data/osm/raw-q1-gob.json` | Third cache: every Google Open Buildings v3 footprint (all confidences) whose centroid lies inside the bbox, sorted by (lat, lon, plus code), 7-decimal rings, one row per line with `id` = 1-based rank. Written only by `npm run osm:refresh-gob`; `osm` and `--check` never fetch it and fail with a hint when it is missing. `meta.filterHash` is checked like the query hashes. v3 is frozen, so the cache is an immutable id space: scene ids are `-row.id`. Commit it. |
| `scripts/osm/fetch.ts` | Queries (roads, signals, bus stops, buildings, water, parks, landmark candidates; and the scene-only extras), retry, caches. |
| `scripts/osm/gob.ts` | Open Buildings tile fetch (24 parallel `Range` requests, streaming gunzip, centroid-in-bbox filter) and its `filterHash`. |
| `scripts/osm/build.ts` | Orchestrates the passes below; pure and deterministic (no clock, no randomness, ids sorted). |
| `scripts/osm/lib/*` | `project` `filter` `clip` `graph` `rings` `cluster` `chains` `lanes` `signals` `simplify` `scene` `footprints` `emit`. |
| `src/data/q1Schema.ts` | JSON contract shared with the app (`NetworkJson`, `SceneJson`, `GobSourceJson`). |
| `src/debug/*`, `debug.html` | 2D debug page. |

## Passes (design §3)

1. Equirectangular projection around φ0 = 10.7745, λ0 = 106.701 (x east, z south, metres).
2. Way filter: trunk/primary/secondary/tertiary/residential/unclassified (+`_link`); drop `tunnel`, `area=yes`, names starting
   "Hẻm", `EXCLUDE_NAMES` ("Hầm Sông Sài Gòn"), `access=no` / `motor_vehicle=no` unless `motorcycle=yes`. A `motor_vehicle=no` that comes
   with `motor_vehicle:conditional=no @ (…)` is a time restriction (weekend walking street on Nguyễn Huệ, Lê Lợi, Lê Thánh Tôn), not a
   ban, and the way stays.
3. Edge graph, Liang–Barsky clip at the bbox → portal nodes (`side` N/S/E/W). A real node within 5 cm of the edge whose
   continuation is outside becomes a portal itself.
4. Terminals: degree ≥ 3, one-way flips (in-in / out-out) are junction candidates; attribute changes (lanes, one-way, class, bridge)
   are `join`; degree 1 is `dead`.
5. Clustering (single linkage, diagonal cap `D_MAX` 60 m; `join` nodes cluster too): chains ≤ `D_EDGE` 20 m between junction candidates and
   ≤ `D_JOIN` 15 m when a `join` is involved, `_link` ways ≤ `D_LINKWAY` 45 m, nodes ≤ `D_NEAR` 8 m. Forced merges (≤ 8 rounds, hard cap 80 m = fatal):
   links with < 6 m between estimated stop lines, and links ≤ `D_SIGPAIR` 30 m between two signalised clusters (cap `D_MAX`).
   Merges that absorb a `join` or are forced are refused (`forced-merge-refused`, `link-trim-short`) when they would leave an inbound arm whose
   only exits turn by > 150° (the sim builds no such connector and forces the link to a dead end; typical of one-way U-turn pairs 8–10 m apart).
   `arm-hairpin` lists the arms that still have only such exits.
6. Chains of degree-2 nodes → links (name = longest share, one-way stored in flow direction). Pruning until stable:
   dead-end stubs < 15 m and portal stubs < 25 m from a cluster are removed.
7. Rings: closed `junction=roundabout|circular` components; must be counter-clockwise on the map (right-hand traffic) or the build fails.
8. Douglas–Peucker 0.35 m; lanes per direction with class defaults; `traffic_signals` within 30 m (graph distance) of a cluster with ≥ 3 arms
   and inbound traffic on both axes; bus stops snapped ≤ 25 m to the link on whose right they stand; scene polygons.
9. Landmarks are fixed OSM ways in `scripts/osm/lib/scene.ts` (`LANDMARKS`).
10. Footprints (`lib/footprints.ts`, runs after the network and the OSM scene exist): drop `confidence < MIN_CONF` (0.70) and planar area < `MIN_AREA` (20 m²);
    shift every ring by (`SHIFT_X` −2.4 m east, `SHIFT_Z` +0.3 m south) to sit on the OSM roads (Open Buildings is ≈ 2.4 m east of OSM); drop a footprint when ≥ 30 %
    of its 1 m cells are covered by an OSM building/landmark (OSM stays authoritative), ≥ 30 % by water/park/construction site/plaza, or ≥ 25 % by a road corridor
    (link half-width + 1 m, roundabout carriageways, junction discs; rasterised from `q1-network.json`). Survivors become `SceneJson.gobBuildings[{id < 0, conf, pts}]`
    (not clipped) with `gobSource` (provenance + the three constants). Counters go to `report.json` → `footprints` and the summary line, never to `net.stats`
    (that would rewrite `q1-network.json`). Tuning knobs are the constants at the top of `footprints.ts`; `MIN_CONF` 0.65 would keep ≈ 690 more footprints.
    Ids of OSM buildings are positive and Open Buildings ids negative, so `BUILDING_OVERRIDES[id]` works for both; switching to another Open Buildings release re-keys every negative id.

## Conventions the sim can rely on

- Link `pts[0]` / `pts[last]` are the real OSM member-node positions (up to `radius` from the node's centroid `x,z`); portals end exactly on the bbox edge; ring arms end on the ring vertex `pts[at]`.
- `lanesF`: lanes a→b, `lanesB`: b→a; `lanesB = 0` ⇒ one-way a→b.
- `portal` has exactly 1 arm; `join` exactly 2; every junction/join has at least one inbound and one outbound arm. A junction whose arms can only be entered or only be left is emitted as `dead` (terminal, any number of arms). A single inbound arm with no legal way out at an otherwise fine junction stays (report kind `arm-no-exit`); the sim ends that link as a dead end.
- Bus stop `s` is metres along the travel direction of `dir` (dir 0 from `a`, dir 1 from `b`); stop is on the right of that direction.
- Scene polygons: outer rings have positive shoelace area in (x, z), holes negative; first point is not repeated. `gobBuildings` rings follow the same rule.
- Numbers rounded to 2 decimals; key order fixed; `JSON.stringify` without indentation plus a trailing newline.

## Fatal conditions (exit code 1, nothing written)

Ring not closed / wrong shape / clockwise · cluster diagonal > 80 m · missing landmark · non-finite number in the output ·
a cache fetched with a different query (or filtered with a different `filterHash`) than the code builds (run `--refresh`, `--refresh-extra` or `osm:refresh-gob`) · gob cache row ids that are not 1…n · gob cache missing · portal with ≠ 1 arm · junction/join with no inbound or no outbound arm ·
pruning not converging.

`report.json` lists everything else as anomalies with OSM ids and x,z; the debug page lists them and jumps to the location.

Data © OpenStreetMap contributors, ODbL. Additional building footprints: Google Open Buildings v3 (Sirko et al. 2021, arXiv:2107.12283), used under ODbL 1.0 (Google licenses it under CC BY 4.0 or ODbL 1.0), <https://sites.research.google/open-buildings/>.
