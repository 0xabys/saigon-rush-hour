# Saigon Rush Hour

An isometric 3D traffic simulator of District 1, Ho Chi Minh City, running in the browser — Three.js + TypeScript + Vite.

**Live demo:** https://0xabys.github.io/saigon-rush-hour/

About 80.5 % of vehicles are two-wheelers (motorbikes plus Grab/Be/Xanh SM ride-hailing bikes, ~30 % of which are ride-hailing) and ~14.7 % are cars (including taxis and Xanh SM/Grab Car/Be Car ride-hailing cars, ~45 % of which are ride-hailing). The bikes flow like water around cars, buses, Vinasun/Mai Linh taxis and cyclos. The car share follows the latest 2025 HCMC figures (≈ 1.4 M cars / 11.3 M motorbikes registered as of 08/2025, plus 102,354 cars and 290,570 motorbikes newly registered in 2025 per the Traffic Police Department → ≈ 11.2 % cars at end of 2025) plus taxis. The ride-hailing split is an assumption based on street observation (no published counts exist for District 1). Congestion level and speeds are checked against the TomTom Traffic Index 2025.

## Running

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + bundle into dist/
npm run preview    # serve the build
```

Requires a browser with WebGL2 (recent Chrome, Edge, Firefox or Safari).

## Controls

| Input | Action |
|---|---|
| Left / right drag, scroll | Rotate / pan / zoom the camera |
| Click a vehicle | Follow it and show its info card |
| Click a road (**Tuyến đường** tab) | Show hourly density and average speed |
| `Space` · `1` `2` `4` | Pause · speed ×1 ×2 ×4 |
| `R` | Toggle rain (slippery roads, flooding) |
| `T` | Time machine — rewind the last 60 simulated seconds |
| `F` · `Esc` | Follow a random vehicle · stop following |
| `H` | Show/hide the control panel |

The in-app UI is in Vietnamese.

## What's simulated

- **Driving models**: cars, taxis, buses and trucks use the **IDM** (Intelligent Driver Model) — free-road acceleration, time-gap keeping, smooth braking behind the leader. **Motorbikes** use a **social force model**: attraction towards open gaps ahead plus anisotropic exponential repulsion (front-weighted) from nearby vehicles, pedestrians, kerbs and the centre line; IDM only acts as a safety brake against the vehicle directly ahead.
- **Driver personalities**: each vehicle has its own **aggressiveness**, **caution** and **desired speed**, seeded from its id (ride-hailing bikes and buses are pushier; cyclos are the gentlest). Personality changes the IDM parameters (acceleration, time gap, standstill gap, braking), the personal space in the social force model and the patience when entering roundabouts. The vehicle card shows the personality and desired speed.
- **Saigon style** (the more aggressive, the more often): **briefly riding against traffic** before cutting back (yielding to oncoming vehicles), **riding on the sidewalk** when stuck for long, **stopping past the stop line** at red lights (bikes spill over the line, some cars poke their nose out), **running the red when the countdown shows 1–2 s**, **pushing through amber**, **honking** ("•••" bubbles) — aggressive drivers also honk at slow vehicles ahead. Bikes **squeeze into junctions** as soon as there is space at the exit (no need for the whole exit to be clear); vehicles **waiting on side streets force their way in** — the longer they wait, the smaller the gap they accept, and cars on the main road leave room for them.
- **Trips & routing**: vehicles don't just cross between two map edges — some start **mid-block** and end **inside the network** (pull over and leave), especially on commercial streets such as Nguyễn Huệ, Lê Lợi, Đồng Khởi and Lê Thánh Tôn. At each turn, drivers pick a direction by **real-time cost** (remaining distance + congestion on each branch, softmax weighted by personality), so traffic spills onto quieter streets when an artery jams.
- **Traffic lights** with countdown timers; right turn on red is allowed except where signed otherwise. From **23:00 to 05:00** lights switch to **flashing amber** and the countdowns go dark: vehicles slow down, enter only when no cross traffic is moving through, and whoever has waited longest goes first (reckless bikers skip the yielding). The “Khuya” button jumps to 23:30.
- **Pedestrians crossing**: on zebra crossings when their direction has a red light, and “Saigon style” — conical hat on, walking slowly and steadily through traffic mid-block. Every vehicle must yield; bikes weave around, cars stop and wait (the vehicle card says it is yielding to a pedestrian).
- **Events**: minor crashes (vehicles block a lane with traffic cones, followers slow down to look and go around); **flooding** at real low spots on Tôn Đức Thắng, Hàm Nghi, Lê Lai, Pasteur and Calmette during heavy rain — muddy water rises over ~30 s and drains ~90 s after the rain stops (vehicles crawl, some stall and get pushed); **truck ban** in the inner city 6–9h and 16–20h (signs at every map entry).
- **Day/night & weather**: time slider, rush hours 07–09 / 17–19 with more traffic (evening is the worst), headlights and shopfronts light up at night.
- **Packed streets**: ~8,000 motorbikes parked on the sidewalks in front of shophouses (static decoration, no effect on the sim), denser along shop rows and around Bến Thành market.

## Architecture

```
src/
  core/rng.ts            seeded PRNG + hash — no Math.random()
  data/                  q1-network.json, q1-scene.json (preprocessed OpenStreetMap) + schema
  sim/network.ts         generic road network: links, junction connectors, roundabouts
  sim/osmMap.ts          builds the Network from OpenStreetMap
  sim/legacyMap.ts       old hand-made map — harness only
  sim/signals.ts         traffic lights: pure function of sim time
  sim/traffic.ts         vehicle simulation (struct-of-arrays), events, snapshot/restore
  sim/events.ts          crashes, flood zones (placed on real streets), truck-ban hours
  sim/roadStats.ts       per-road hourly statistics
  sim/timeMachine.ts     rewind via snapshots + deterministic replay
  render/*               Three.js scene (InstancedMesh for vehicles, buildings, trees…; parked.ts: sidewalk bikes)
  ui/hud.ts              plain-DOM HUD
  main.ts                boot, main loop, input wiring
```

**One simulation clock.** The sim runs at a fixed 1/60 s step; rendering interpolates between steps. Every random choice comes from `hash(vehicle id, salt)` or a seeded PRNG stored in the sim state. Lights, boats, pedestrians, swaying trees and rain are all functions of sim time.

**Time machine.** Every sim second a snapshot is stored (all vehicle arrays, PRNG, events, stats, clock, rain, density). User changes (time, rain, density, auto time) are recorded with their step number. Rewinding restores the nearest snapshot and replays step by step, applying the same inputs at the same steps → the old frame is reproduced exactly. “Tiếp tục từ đây” (continue from here) forks a new history; “Về hiện tại” (back to now) replays to the latest step. The window is the last **60 simulated seconds**. The “lùi N phút” (N minutes back) label, shown when **Giờ tự trôi** (auto time) is on, is in game time because 1 sim second = 1 game minute; with auto time off the clock is frozen, so the label reads in simulated seconds.

**Performance.** Vehicles use InstancedMesh (one draw call per vehicle model), a spatial grid for neighbour lookups, and the traffic-light buffer is only uploaded when it changes. If frames stay slow, quality degrades automatically (pixel ratio 1, then bloom off and smaller shadow maps).

## Map data

The map is **the real District 1**, from OpenStreetMap: road network (lanes, one-ways, medians, bridges, roundabouts, signals, bus stops), buildings, rivers/canals, parks, construction sites (`landuse=construction|brownfield`: bare ground, metal hoardings, unfinished concrete frames, tower cranes), squares / pedestrian areas, and 8 hand-modelled landmarks (Bến Thành Market, City Hall, Bitexco, Cafe Apartment, Notre-Dame Cathedral, Central Post Office, Opera House, Independence Palace).

- Preprocessed data ships in `src/data/q1-network.json` (road network) and `src/data/q1-scene.json` (3D scene); the schema is in `src/data/q1Schema.ts`. The app makes no network requests at runtime.
- Regenerating data: `npm run osm` (uses the caches `data/osm/raw-q1.json` + `data/osm/raw-q1-extra.json` + `data/osm/raw-q1-gob.json`), `npm run osm:refresh` (re-downloads the main and extra OSM caches from Overpass), `npm run osm:refresh-extra` (re-downloads only the scene-only part: construction sites, squares; does **not** change `q1-network.json`), `npm run osm:refresh-gob` (re-downloads the ~1.9 GB Google Open Buildings v3 tile and writes `raw-q1-gob.json`; set `GOB_TILE_PATH=/path/to/317_buildings.csv.gz` to use a tile you already have), `npm run osm:check` (invariant checks). Requires [bun](https://bun.sh).
- The old hand-made map (17 nodes, 1 roundabout) is kept only for the harness: `npm run harness:legacy`.
- **Lê Lợi, Nguyễn Huệ and Lê Thánh Tôn stay in the road network**: OSM tags them `motor_vehicle=no` with the condition `no @ (Sa-Su 18:30-23:00)` (weekend walking street), so it is a timed restriction rather than a permanent ban, and the sim models weekday rush hour.

**Data licence.** © OpenStreetMap contributors — data under the [Open Database License (ODbL)](https://www.openstreetmap.org/copyright). Additional building footprints come from [Google Open Buildings](https://sites.research.google/gr/open-buildings/) v3 (Google LLC; dual-licensed CC BY 4.0 / ODbL — this project uses it under **ODbL 1.0**, so all derived data shares one licence). Attribution for both sources is shown in the top-left corner of the HUD (linking to the OpenStreetMap copyright page and the Google Open Buildings page) and on the debug page, and must be kept when redistributing; the map, derived data and anything built from them must stay under ODbL.

## Known limitations

- At rush-hour density, roundabouts (Bến Thành, Quách Thị Trang…) can take minutes to get through — deliberately kept, like real congestion.
- A vehicle at the head of a queue for more than 180 s (or 300 s at a light) leaves the map (last-resort anti-gridlock, counted as `teleports`); vehicles behind it in the queue are not affected.
- Maximum 8,000 vehicles (`MAX_VEHICLES`) — the default (90 % density) is about 6,900 vehicles at 17:30. At ×4 speed slower machines may not keep up; the HUD then shows “×4 · thực ×…” (the speed actually achieved).
- **Junction throughput is only about 1/3 of reality**, so density on major roads is ≈ 9 vehicles/100 m/lane versus 30–80 in real life: the busiest core is still sparser than reality even with the vehicle count at its cap.
- **Local lock pockets** (a group of vehicles waiting on each other around a junction) still happen — about 300+ times per 30 simulated minutes at 8,000 vehicles; they are cleared by the release/leave-map mechanism above, not prevented at the root.
- Motorbikes **overlapping inside junction boxes** is intentional (no hard collisions between motorbikes there).
- OSM has only ~800 buildings for this area; ~2,000 real Google Open Buildings footprints are added first, and the rest of each block is filled with generated tube houses / low-rise buildings.
- Below 820 px wide, the control panel collapses into a “Điều khiển” (controls) button.
