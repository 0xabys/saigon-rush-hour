import { rand01, Rng, weightedIndex } from '../core/rng';
import { floodZonesFor, truckBanActive, type CityEvent, type FloodZone, type Incident } from './events';
import { CostRouter, D_MIN, TAU_ROUTE_S, type RouterSnapshot } from './routing';
import { RoadClass, SegKind, Turn, type Network, type Segment } from './network';
import { PED_CAP, PED_RADIUS, Pedestrians, type PedSnapshot } from './pedestrians';
import { flashHours, Light, SignalSystem } from './signals';
import {
  BIKE_COLORS,
  BIKE_MODELS,
  BUS_ROUTES,
  CAR_COLORS,
  CAR_MODELS,
  CYCLO_HOOD,
  GIVEN,
  HAIL_BRANDS,
  hailBrand,
  OSM_MIX_WEIGHTS,
  PONCHO_COLORS,
  SHIRT_COLORS,
  SPECS,
  SURNAMES,
  TRUCK_BOX,
  TRUCK_CAB,
  XANH_SM_MODELS,
  VTYPE_COUNT,
  VType,
} from './vehicleTypes';
import { Color } from 'three';

export const CAPACITY = 12000;
const CELL = 6;
const GRID_MARGIN = 30;
/** Lateral slots of the legacy grid (`saigonRules` off): step = usable width / (SLOTS − 1). */
const SLOTS = 9;
/** Longest vehicle half-length (bus, m): `clearAt` must reach this far past its radius. */
const MAX_HALF_LEN = SPECS[VType.Bus].length * 0.5;
/** Legacy hard cap on buses on the map; with `routeByDest` it is `max(BUS_CAP, target · BUS_CAP_SHARE)`. */
const BUS_CAP = 9;
const BUS_CAP_SHARE = 0.01;
/** Portal spawn attempts per 0.06 s tick; with `routeByDest` scaled by `target / SPAWN_REF_TARGET`. */
const SPAWN_TRIES = 8;
const SPAWN_REF_TARGET = 2600;
/** `routeByDest` only: share of trips that start in the middle of a block / end on a sink link instead of at a portal / an exit. */
const P_ORIGIN_INTERNAL = 0.35;
const P_DEST_INTERNAL = 0.35;
/** Internal trip ends lie `SINK_MARGIN_START` m after the start of a link and at least `SINK_MARGIN_END` m before its end. */
const SINK_MARGIN_START = 8;
const SINK_MARGIN_END = 12;
/** Mid-block origins: a vehicle `j` on the same link closer behind the spawn point than `REAR_GAP_BASE + REAR_GAP_TIME · v_j` m vetoes it. */
const REAR_GAP_BASE = 4;
const REAR_GAP_TIME = 1.5;
/** Fastest vehicle the rear-gap veto looks for (m/s); bounds the grid query. */
const REAR_GAP_VMAX = 16;
/** Arrival: within `ARRIVE_REACH` m of its trip end a vehicle slows to `ARRIVE_V0 + ARRIVE_V_PER_M · remaining` m/s and bikes lean towards the kerb. */
const ARRIVE_REACH = 20;
const ARRIVE_V0 = 1.5;
const ARRIVE_V_PER_M = 0.3;
/** Metres over which a vehicle fades in after a mid-block spawn / out before its trip end. */
const ARRIVE_FADE_M = 5;
/** Seconds a mid-block spawn fades in for. */
const SPAWN_FADE_S = 1;
/** `populate` on `routeByDest` maps: attempts per vehicle in each pass; later passes shrink the exclusion radius so the target is reachable at high N. */
const POPULATE_TRIES = 8;
const POPULATE_RADIUS_SCALE = [1, 0.8, 0.65, 0.5];

type VehicleArray = Float32Array | Int32Array | Int16Array | Int8Array | Uint16Array | Uint8Array;
/** Seconds before the wrong-way cap at which a rider must start heading back to its own side. */
const RETURN_LEAD = 2.6;
const MAX_STOPPED = 90;
/** Lowest allowed heading·tangent of a bike (≈ 81° off the direction of travel). */
const HEADING_MIN_DOT = 0.15;
/** Seconds (× 0.5 + caution) a car waits at a junction line for exit room before taking any gap that physically fits. */
const EXIT_PATIENCE = 14;
/** Metres before / after a crossing stretch of a priority connector that still count as a conflict. */
const CONFLICT_REACH = 9;
const CONFLICT_CLEAR = 4;

// ---- steady-state safety nets (see agent://SteadyStateDesign §2–§3). Each has an 'off' value for A/B runs.
/** Seconds a blocked car waits at the line (+ `T_DETOUR_CAUTION` × caution) before taking another turn whose exit has room. `Infinity` = no detour. */
const T_DETOUR = 6;
const T_DETOUR_CAUTION = 10;
/** Longest extra path (m) a detour may add: `DETOUR_MAX + DETOUR_MAX_AGGR × aggr`. */
const DETOUR_MAX = 300;
const DETOUR_MAX_AGGR = 300;
/** Wait-for cycle detector (once per simulated second); `false` = off. */
const DETECTOR_ON = true;
/** A vehicle stopped this long (s) can start a wait-for chain. */
const T_CYC = 20;
/** A chain member of the wait-for detector counts as waiting while it moves slower than this (m/s): a deadlocked cluster of bikes creeps and jitters, which keeps resetting `stopT`. `saigonRules` only. */
const CYC_CREEP_V = 1;
/** `saigonRules`: a vehicle that has crept below `CRAWL_V` (m/s) for `T_CRAWL` seconds inside a junction box / ring is removed like a `MAX_STOPPED` case (a bike crowd jammed in a box jitters, so `stopT` never reaches `MAX_STOPPED`). */
const CRAWL_V = 1;
const T_CRAWL = 45;
/** A head-of-segment vehicle stopped this long (s) behind a queue / for a gap is teleported out. `Infinity` = off. */
const T_TELE = 180;
/** Same for a vehicle stopped at a signal (≫ the 54 s cycle: a signal bug). `Infinity` = off. */
const T_TELE_SIG = 300;
/** Seconds two vehicles inside a junction box must have blocked each other before the deterministic order (`boxFirst`) overrides the yield. */
const T_BOX_GRACE = 1.5;

// ---- motorbike filtering at exit mouths and box tie-breaks (DensDesign M2/M4), gated by `Network.saigonRules`; the legacy map keeps the original rules.
/** A vehicle whose rear is closer than this (m) to the start of a link still blocks its entry band for a bike. */
const TAIL_ZONE = 2.35;
/** Lateral band width (m) of the exit-mouth admission mask: bike width 0.75 + 0.15 clearance. Bands per link: `min(MAX_BANDS, max(1, round(2·halfW / BAND_W)))`. */
const BAND_W = 0.9;
const MAX_BANDS = 8;
/** Lateral clearance (m) each side of a vehicle when it marks the bands it occupies. */
const BAND_PAD = 0.15;

// ---- forced entry at give-way lines (Saigon style), gated by `Network.saigonRules`: a minor-approach head that has stood still long enough stops waiting for a polite gap.
/** Base seconds of standing at the line (× (0.5 + caution), − `FORCE_AGGR` × aggr, floored at `FORCE_MIN`) before the driver starts forcing in. */
const FORCE_START = 5;
const FORCE_AGGR = 4;
const FORCE_MIN = 1.5;
/** Seconds from the first push to full forcing (the accepted gap shrinks linearly over this). */
const FORCE_RAMP = 10;
/** Fully forcing: a conflicting connector vehicle counts only inside its stretch or within `FORCE_REACH + FORCE_TGAP × v` metres of it (instead of `CONFLICT_REACH`). */
const FORCE_REACH = 2;
const FORCE_TGAP = 0.35;
/** The major flow holds at its own line while a forcing minor head waits for the same exit and the exit has less free room than this (m). */
const FORCE_ROOM = 20;
/** Metres before a give-way line within which standing counts as waiting at it. */
const FORCE_ZONE = 8;
/** Seconds standing at a give-way line (`waitT`) after which a minor-approach driver stops waiting for a clear crossing and enters wherever his own corridor is free (the major flow then yields to him once committed). `saigonRules` only. */
const T_ASSERT = 25;
/** Metres of exit room a two-wheeler inside a junction box claims, as a share of its length + 0.8 (motorcycle PCE ≈ 0.24–0.3: riders share the lane width). 1 = legacy. `saigonRules` only. */
const BIKE_CLAIM_PCE = 0.3;

// ---- gap acceptance in the box (GAX), gated by `saigonRules`: a bike treats a crossing (or diverging) neighbour as a wall only if it will still be in its corridor when the bike gets there.
/** m/s: slower lateral motion than this = wall. */
const GAX_LAT_V_MIN = 0.5;
/** Metres past the corridor edge before the crosser counts as gone. */
const GAX_CLEAR = 0.1;
/** m/s planning-speed floor for the arrival time (a stopped rider still plans to move off). */
const GAX_V_MIN = 2;
/** Seconds of base safety margin, plus `GAX_MARGIN_CAUTION × caution`. */
const GAX_MARGIN = 0.3;
const GAX_MARGIN_CAUTION = 0.6;

// ---- queue discharge (DensDesign F), gated by `Network.saigonRules`; the legacy map keeps the 9-slot grid, the 0.35 side constraint and the unscaled headway.
/** Fixed lateral pitch (m) of a bike's candidate slots: bike width 0.75 + 0.15 clearance (legacy: 9 slots spread over the road, 0.76–1.2 m apart). 0 = legacy grid. */
const SLOT_PITCH = 0.9;
/** Most slots weighed across one road (size of `slotFree`); a wider usable range gets the `SLOTS_MAX` grid centred on it. */
const SLOTS_MAX = 16;
/** 1 for the swarming two-wheeler types, indexed by `VType` (neighbour loops read it per candidate). */
const SWARM_OF = Uint8Array.from(SPECS, (sp) => (sp.swarm ? 1 : 0));
/** Side constraint (m) beyond the summed half-widths within which a bike never steers toward a neighbour: legacy value, and the value against another bike under `saigonRules`. */
const SIDE_CLEAR = 0.35;
const SIDE_CLEAR_BIKE = 0.15;
/** Scale on a bike's IDM time headway under `saigonRules` (riders follow closer than the legacy 0.65 s base). 1 = off. Bench: 0.75 → 2L straight 0.80, 0.6 → 0.90 veh/s/m. */
const BIKE_HEADWAY_K = 0.6;
/** Scale of the along-road social force from a bike diagonally ahead under `saigonRules` (legacy 0.6): at a 0.9 m pitch every rider has two such neighbours and the legacy value brakes a queue row by row. */
const SQUEEZE_EASE = 0;
/** Leader-corridor clearance (m) beyond the summed half-widths between two bikes under `saigonRules` (legacy 0.1): a rider in the next column (0.9 m away, 0.15 m of jitter) is alongside, not a leader whose negative gap would zero its speed. */
const LEADER_CLEAR_BIKE = 0;

/** Bit flags for the Saigon-style move a driver is making right now (HUD + stats). */
export const enum Act {
  /** Stopped at a red light with the front wheel past the stop line. */
  OverLine = 1,
  /** Went before the countdown hit zero. */
  JumpRed = 2,
  /** Approaching a flashing-amber junction. */
  Flash = 4,
  /** Pressed on through an amber that a calmer driver would have stopped for. */
  RunAmber = 8,
}

export const enum Reason {
  Free = 0,
  Follow = 1,
  Yield = 2,
  Signal = 3,
  Dwell = 4,
}

/** Desired-speed multiplier for motorbikes on the Saigon map (≈37 → ≈43 km/h mean wish; links still cap at their limit). */
const SAIGON_BIKE_SPEED_BOOST = 1.16;

export interface TrafficKpi {
  count: number;
  avgKmh: number;
  /** Mean speed of vehicles running unhindered on a street (not queued, not in a junction box): the speed between the lights. */
  movingKmh: number;
  congestion: number;
  waiting: number;
  mix: number[];
  /** Cumulative MAX_STOPPED unjams (a vehicle removed from inside a junction/ring): telemetry of a failure. */
  releases: number;
  /** Cumulative wait-for cycles broken by the lock detector (telemetry of a failure). */
  locksBroken: number;
  /** Cumulative head-of-segment vehicles removed after standing past T_TELE (telemetry of a failure). */
  teleports: number;
  /** Cumulative vehicles that reached an internal destination (0 until trips end inside the map). */
  arrivals?: number;
}

const tmpColor = new Color();

function linear(hex: number, out: Float32Array, i: number): void {
  tmpColor.setHex(hex);
  out[i * 3] = tmpColor.r;
  out[i * 3 + 1] = tmpColor.g;
  out[i * 3 + 2] = tmpColor.b;
}

/**
 * Struct-of-arrays traffic simulation. One fixed step advances every vehicle; render
 * code only reads these arrays, there is no per-vehicle object or UI state.
 */
export class Traffic {
  readonly net: Network;
  readonly signals: SignalSystem;
  readonly segs: Segment[];
  /** Flood spots on the real streets of this map. */
  readonly floods: FloodZone[];

  readonly active = new Uint8Array(CAPACITY);
  readonly type = new Uint8Array(CAPACITY);
  readonly uid = new Int32Array(CAPACITY);
  readonly seg = new Int32Array(CAPACITY);
  readonly nextSeg = new Int32Array(CAPACITY);
  readonly s = new Float32Array(CAPACITY);
  readonly l = new Float32Array(CAPACITY);
  readonly v = new Float32Array(CAPACITY);
  readonly vl = new Float32Array(CAPACITY);
  readonly x = new Float32Array(CAPACITY);
  readonly z = new Float32Array(CAPACITY);
  readonly hx = new Float32Array(CAPACITY);
  readonly hz = new Float32Array(CAPACITY);
  readonly prevX = new Float32Array(CAPACITY);
  readonly prevZ = new Float32Array(CAPACITY);
  readonly prevHx = new Float32Array(CAPACITY);
  readonly prevHz = new Float32Array(CAPACITY);
  readonly lean = new Float32Array(CAPACITY);
  readonly fade = new Float32Array(CAPACITY);
  readonly vDes = new Float32Array(CAPACITY);
  readonly len = new Float32Array(CAPACITY);
  readonly wid = new Float32Array(CAPACITY);
  readonly laneT = new Float32Array(CAPACITY);
  readonly creep = new Float32Array(CAPACITY);
  readonly stuck = new Float32Array(CAPACITY);
  readonly stopT = new Float32Array(CAPACITY);
  /** Seconds spent waiting (v < 2 m/s) within `FORCE_ZONE` of a give-way line (or in the box, not yet committed); drives `forceLevel`. */
  readonly waitT = new Float32Array(CAPACITY);
  /** Seconds a vehicle has spent inside a junction box / ring creeping slower than `CRAWL_V` (jitter at 0.3–1 m/s keeps resetting `stopT`); `saigonRules` only. */
  readonly crawlT = new Float32Array(CAPACITY);
  readonly age = new Float32Array(CAPACITY);
  readonly dist = new Float32Array(CAPACITY);
  readonly dwell = new Float32Array(CAPACITY);
  readonly committed = new Uint8Array(CAPACITY);
  readonly reason = new Uint8Array(CAPACITY);
  readonly ringTarget = new Int8Array(CAPACITY);
  readonly slotT = new Int8Array(CAPACITY);
  readonly busDone = new Int32Array(CAPACITY);
  readonly routeCtr = new Uint16Array(CAPACITY);
  /** Index into `Network.dests` of the exit this vehicle is heading for; −1 = none (random walk). */
  readonly dest = new Int16Array(CAPACITY);
  /** Metres from the start of the destination link at which a vehicle bound for an internal sink arrives; −1 = none (portal exit / random walk). */
  readonly destS = new Float32Array(CAPACITY).fill(-1);
  /** Linear RGB: c1 = clothing/body paint, c2 = secondary paint. */
  readonly c1 = new Float32Array(CAPACITY * 3);
  readonly c2 = new Float32Array(CAPACITY * 3);
  /** Seconds spent crawling in a jam (drives bikes onto the sidewalk / wrong side). */
  readonly frustration = new Float32Array(CAPACITY);
  /** Remaining horn-blip display time and cooldown. */
  readonly honk = new Float32Array(CAPACITY);
  readonly honkCD = new Float32Array(CAPACITY);
  /** 1 while riding across the centre line against traffic. */
  readonly wrong = new Uint8Array(CAPACITY);
  /** Height lift while riding on the sidewalk (render only). */
  readonly elev = new Float32Array(CAPACITY);
  /** 1 while part of a crash; frozen until the incident clears. */
  readonly crashed = new Uint8Array(CAPACITY);
  /** 0 dry, 1 slowed by flood water, 2 pushing a flooded bike. */
  readonly wading = new Uint8Array(CAPACITY);
  /**
   * Driver personality, fixed per uid: aggressiveness (risk taking: wrong side, sidewalk, jumping the
   * light, horn) and caution (following distance, braking, personal space). Both 0–1.
   */
  readonly aggr = new Float32Array(CAPACITY);
  readonly caution = new Float32Array(CAPACITY);
  /** Seconds ridden against traffic on the current street; caps wrong-way runs to short stretches. */
  readonly wrongT = new Float32Array(CAPACITY);
  /** `Act` flags. */
  readonly act = new Uint8Array(CAPACITY);
  incidents: Incident[] = [];
  /** 0–1 global flood level; rises while it pours and recedes after. */
  floodLevel = 0;
  private nextIncidentT = 45;
  private incidentSeq = 0;
  private readonly uidIndex = new Map<number, number>();
  /** Every per-vehicle array with its stride, captured by snapshots. */
  private readonly stateArrays: { arr: VehicleArray; stride: number }[];

  count = 0;
  hi = 0;
  target = 260;
  time = 0;
  hour = 8;
  rain = 0;
  private nextUid = 1;
  private spawnAcc = 0;
  private pendingType = -1;
  private rainApplied = false;
  private readonly rng: Rng;
  /** Vehicles removed by the MAX_STOPPED unjam since construction (snapshot state). */
  private releases = 0;
  /** Wait-for cycles broken by the lock detector since construction (snapshot state). */
  private locksBroken = 0;
  /** Vehicles teleported out by the stuck-head rule since construction (snapshot state). */
  private teleports = 0;
  /** Vehicles that arrived at an internal destination since construction (snapshot state). */
  private arrivals = 0;
  private readonly free: number[] = [];
  private readonly cellHead: Int32Array;
  private readonly cellNext = new Int32Array(CAPACITY);
  /** Packed cell lists rebuilt with the chains: cell `c` holds `cellItems[cellStart[c] .. cellStart[c + 1])`, in chain order. Scratch for the perception loop. */
  private readonly cellStart: Int32Array;
  private readonly cellItems = new Int32Array(CAPACITY);
  /** Cell of each active slot at the last rebuild. */
  private readonly cellOf = new Int32Array(CAPACITY);
  /** Slot → its position in `cellItems` at the last rebuild. */
  private readonly posOf = new Int32Array(CAPACITY);
  /**
   * Neighbour table in `cellItems` order, 8 floats per vehicle (x, z, hx, hz, length, width, speed, swarm flag): the perception loop walks cell rows through it
   * sequentially instead of gathering from eight separate arrays. Refreshed by `rebuildGrid`, then kept current by `updateVehicle` (neighbours see live values).
   */
  private readonly nbr = new Float32Array(CAPACITY * 8);
  /** 1 while the slot sits in a `cellHead` chain (since the last rebuild). */
  private readonly inGrid = new Uint8Array(CAPACITY);
  /** Slots allocated since the last rebuild whose slot was already in a chain at an older position; `clearAt` checks them linearly. */
  private readonly fresh: number[] = [];
  /** Squared metres of the largest single-step move since the last rebuild (segment hand-overs can jump ≈ 2 m); bounds how stale a grid cell can be. Scratch: 0 after a rebuild. */
  private maxMoveSq = 0;
  private readonly slotFree = new Float32Array(SLOTS_MAX);
  private readonly tmp = new Float32Array(4);
  /**
   * Every segment's resampled polyline as interleaved (px, pz, tx, tz) records in one array, with per-segment first record / count / length / step:
   * `samplePose` returns what `Segment.sample` does, but reads one cache line instead of four separate arrays. The network is immutable.
   */
  private readonly smpData: Float32Array;
  private readonly smpBase: Int32Array;
  private readonly smpN: Int32Array;
  private readonly smpLen: Float64Array;
  private readonly smpStep: Float64Array;
  /** Segment tangent at each vehicle's last pose, keyed by (segment id + 1, s): `Segment.sample` is pure, so a matching key is always valid. Scratch (not in snapshots). */
  private readonly tanSeg = new Int32Array(CAPACITY);
  private readonly tanS = new Float32Array(CAPACITY);
  private readonly tanX = new Float32Array(CAPACITY);
  private readonly tanZ = new Float32Array(CAPACITY);
  private readonly mixCount = new Int32Array(VTYPE_COUNT);
  private readonly segMinS: Float32Array;
  private readonly segMinV: Float32Array;
  /** Per-segment aggregates rebuilt every step: vehicle count, the front-most vehicle's s and v, top speed. */
  private readonly segCount: Int32Array;
  /** Per-segment, rebuilt every step: summed speed (m/s) of the vehicles on the segment; with `segCount` it is the census `CostRouter` smooths. */
  private readonly segVSum: Float32Array;
  private readonly segLeadS: Float32Array;
  private readonly segLeadV: Float32Array;
  private readonly segMaxV: Float32Array;
  /** Time-cost route choice (`routeByDest` maps only; null on legacy maps). Stepped right after each `rebuildGrid`; part of the snapshot. */
  private readonly router: CostRouter | null;
  /** Per-segment, rebuilt every step: length of the vehicles inside a junction connector headed for this link. */
  private readonly segClaim: Float32Array;
  /** Scratch, rebuilt every step: the rear-most vehicle of each segment (−1 = empty). */
  private readonly segTailIdx: Int32Array;
  /** Lateral bands per segment (bit width of `segTailMask`), fixed by the segment width. */
  private readonly segBands: Uint8Array;
  /** Scratch, rebuilt every step: per link, the bands occupied by a vehicle whose rear is within `TAIL_ZONE` of the link start. */
  private readonly segTailMask: Uint8Array;
  /** Scratch, rebuilt every step: 1 for a link that a forcing minor-approach head (`forceLevel > 0`, at its give-way line) is waiting to enter. */
  private readonly segForce: Uint8Array;
  /** Scratch, per minor connector, rebuilt every step (`saigonRules`): 1 = a priority vehicle is inside its crossing stretch `[z0, z1 + CONFLICT_CLEAR]`; the fastest such vehicle's speed;
   *  the distance to that stretch of the nearest priority vehicle still before it (Infinity = none) and that vehicle's speed. */
  private readonly segXHit: Uint8Array;
  private readonly segXHitV: Float32Array;
  private readonly segXAhead: Float32Array;
  private readonly segXAheadV: Float32Array;
  /** Scratch, written by `updateVehicle`: the leading vehicle in the own corridor and the link whose room the vehicle waits for (−1 = none). */
  private readonly leader = new Int32Array(CAPACITY);
  private readonly waitLink = new Int32Array(CAPACITY);
  /** Scratch for the wait-for detector: walk id that last visited each vehicle, and the current chain. */
  private readonly walkMark = new Int32Array(CAPACITY);
  private readonly walkChain = new Int32Array(CAPACITY);
  private walkId = 0;
  private readonly portalWeights: number[];
  /** Trip-end weight of each internal sink (`dests[nExits + m]`), i.e. `net.tripWeights` of the links with weight > 0 in `links` order. */
  private readonly sinkWeight: Float32Array;
  /** Cumulative `net.tripWeights` over `net.links` (binary-searched by `tripLinkAt`); empty when no link has a weight (no internal origins / sinks). */
  private readonly tripCum: Float64Array;
  /** Scratch of `pickDest`: eligible weight of each sink. */
  private readonly sinkScratch: Float64Array;
  private readonly gx0: number;
  private readonly gz0: number;
  private readonly gw: number;
  private readonly gh: number;
  /** Packed cell lists of the people (layout of `cellStart`/`cellItems`); rebuilt with the vehicle grid. */
  private readonly pedCellStart: Int32Array;
  private readonly pedItems = new Int32Array(PED_CAP);
  private readonly pedCellOf = new Int32Array(PED_CAP);
  /** People crossing the street; vehicles give way to them. */
  readonly peds: Pedestrians;
  /** 1 while the vehicle is held up by someone crossing. */
  readonly pedYield = new Uint8Array(CAPACITY);

  constructor(net: Network, signals: SignalSystem, seed = 0x5a16) {
    this.rng = new Rng(seed);
    this.net = net;
    this.floods = floodZonesFor(net);
    this.signals = signals;
    this.segs = net.segments;
    const nSeg = net.segments.length;
    this.smpBase = new Int32Array(nSeg);
    this.smpN = new Int32Array(nSeg);
    this.smpLen = new Float64Array(nSeg);
    this.smpStep = new Float64Array(nSeg);
    let smpTotal = 0;
    for (const sg of net.segments) smpTotal += sg.n;
    this.smpData = new Float32Array(smpTotal * 4);
    let smpAt = 0;
    for (const sg of net.segments) {
      this.smpBase[sg.id] = smpAt;
      this.smpN[sg.id] = sg.n;
      this.smpLen[sg.id] = sg.length;
      this.smpStep[sg.id] = sg.step;
      for (let k = 0; k < sg.n; k++, smpAt++) {
        this.smpData[smpAt * 4] = sg.px[k];
        this.smpData[smpAt * 4 + 1] = sg.pz[k];
        this.smpData[smpAt * 4 + 2] = sg.tx[k];
        this.smpData[smpAt * 4 + 3] = sg.tz[k];
      }
    }
    this.segMinS = new Float32Array(nSeg);
    this.segMinV = new Float32Array(nSeg);
    this.segCount = new Int32Array(nSeg);
    this.segVSum = new Float32Array(nSeg);
    this.segLeadS = new Float32Array(nSeg);
    this.segLeadV = new Float32Array(nSeg);
    this.segMaxV = new Float32Array(nSeg);
    this.segClaim = new Float32Array(nSeg);
    this.segTailIdx = new Int32Array(nSeg);
    this.segBands = new Uint8Array(nSeg);
    this.segTailMask = new Uint8Array(nSeg);
    this.segForce = new Uint8Array(nSeg);
    this.segXHit = new Uint8Array(nSeg);
    this.segXHitV = new Float32Array(nSeg);
    this.segXAhead = new Float32Array(nSeg);
    this.segXAheadV = new Float32Array(nSeg);
    for (const sg of net.segments) this.segBands[sg.id] = Math.min(MAX_BANDS, Math.max(1, Math.round((2 * sg.halfW) / BAND_W)));
    this.portalWeights = net.portalWeights;
    const nSinks = net.dests.length - net.nExits;
    this.sinkWeight = new Float32Array(nSinks);
    this.sinkScratch = new Float64Array(nSinks);
    let m = 0;
    const cum = new Float64Array(net.links.length);
    let tripTotal = 0;
    net.links.forEach((l, k) => {
      const w = net.tripWeights[k];
      tripTotal += w;
      cum[k] = tripTotal;
      if (w <= 0) return;
      if (m >= nSinks || net.dests[net.nExits + m].id !== l.id) throw new Error(`traffic: sink ${m} does not match link ${l.id}`);
      this.sinkWeight[m++] = w;
    });
    if (m !== nSinks) throw new Error(`traffic: ${nSinks} sinks but ${m} links with a trip weight`);
    this.router = net.routeByDest ? new CostRouter(net, signals) : null;
    this.tripCum = tripTotal > 0 ? cum : new Float64Array(0);
    this.gx0 = net.bounds.minX - GRID_MARGIN;
    this.gz0 = net.bounds.minZ - GRID_MARGIN;
    this.gw = Math.ceil((net.bounds.maxX - net.bounds.minX + 2 * GRID_MARGIN) / CELL);
    this.gh = Math.ceil((net.bounds.maxZ - net.bounds.minZ + 2 * GRID_MARGIN) / CELL);
    this.cellHead = new Int32Array(this.gw * this.gh);
    this.cellHead.fill(-1);
    this.cellStart = new Int32Array(this.gw * this.gh + 1);
    this.pedCellStart = new Int32Array(this.gw * this.gh + 1);
    this.peds = new Pedestrians(net, signals);
    const one = [
      this.active, this.type, this.uid, this.seg, this.nextSeg, this.s, this.l, this.v, this.vl, this.x, this.z,
      this.hx, this.hz, this.prevX, this.prevZ, this.prevHx, this.prevHz, this.lean, this.fade, this.vDes, this.len,
      this.wid, this.laneT, this.creep, this.stuck, this.stopT, this.waitT, this.age, this.dist, this.dwell, this.committed,
      this.reason, this.ringTarget, this.slotT, this.busDone, this.routeCtr, this.dest, this.destS, this.frustration, this.honk, this.honkCD,
      this.wrong, this.elev, this.crashed, this.wading, this.pedYield, this.aggr, this.caution, this.wrongT, this.act, this.crawlT,
    ];
    this.stateArrays = [...one.map((arr) => ({ arr, stride: 1 })), { arr: this.c1, stride: 3 }, { arr: this.c2, stride: 3 }];
    for (let i = CAPACITY - 1; i >= 0; i--) this.free.push(i);
  }

  // ---------------------------------------------------------------- spawning

  private chooseType(u: number): VType {
    const h = this.hour;
    const night = h < 5.5 || h >= 22;
    const rush = (h >= 7 && h < 9) || (h >= 17 && h < 19);
    const busCap = this.net.routeByDest ? Math.max(BUS_CAP, Math.ceil(this.target * BUS_CAP_SHARE)) : BUS_CAP;
    const base = SPECS.map((sp, t) => {
      let k = this.net.routeByDest ? OSM_MIX_WEIGHTS[t] : sp.weight;
      if (t === VType.Bus) k *= night ? 0.15 : 1;
      if (t === VType.Truck) k *= truckBanActive(h) ? 0 : night ? 2.6 : 0.7;
      if (t === VType.Cyclo) k *= h >= 8 && h < 18 ? 1.2 : 0.35;
      if (t === VType.Grab) k *= rush ? 1.25 : night ? 0.7 : 1;
      if (t === VType.TaxiMaiLinh || t === VType.TaxiVinasun) k *= night ? 1.8 : 1;
      return k;
    });
    const total = base.reduce((a, b) => a + b, 0);
    // Slow vehicles linger on the map, so steer spawns toward the intended on-map mix.
    const w = base.map((k, t) => {
      const expected = (k / total) * this.count;
      const corr = Math.max(0.15, Math.min(4, (expected + 1) / (this.mixCount[t] + 1)));
      return t === VType.Bus && this.mixCount[t] >= busCap ? 0 : k * corr;
    });
    return weightedIndex(w, u) as VType;
  }

  /**
   * Lateral offset a vehicle starts with: kerb side when `kerb`, else a random one for bikes; `null` = the lane `pickLane` chose (cars).
   * `uid` is the vehicle's uid, so a caller can predict the position before `alloc`.
   */
  private startLateral(type: VType, uid: number, sg: Segment, kerb: boolean): number | null {
    if (type === VType.Cyclo) return sg.halfW - 0.7;
    if (SPECS[type].swarm) return kerb ? sg.halfW - 0.6 : (rand01(uid, 4) * 2 - 1) * (sg.halfW - 0.5);
    return kerb ? sg.laneC[sg.lanes - 1] : null;
  }

  /** Spawn a vehicle on link/segment `segId` at `s` metres; `v0` = initial speed (default 0.6 × cruise), `kerb` = start at the kerb (mid-block origins). Returns the slot, −1 when full. */
  private alloc(type: VType, segId: number, s: number, v0 = SPECS[type].speed * 0.6, kerb = false): number {
    const i = this.free.pop();
    if (i === undefined) return -1;
    const uid = this.nextUid++;
    const sp = SPECS[type];
    this.active[i] = 1;
    this.type[i] = type;
    this.uid[i] = uid;
    this.seg[i] = segId;
    this.s[i] = s;
    this.v[i] = v0;
    this.vl[i] = 0;
    // Personality: a triangular spread around the type's temper, so most drivers are middling.
    const aggr = Math.min(1, Math.max(0, (rand01(uid, 7) + rand01(uid, 8)) * 0.5 + sp.temper));
    this.aggr[i] = aggr;
    this.caution[i] = Math.min(1, Math.max(0, 0.6 * (1 - aggr) + 0.4 * rand01(uid, 9)));
    // Saigon riders open up to 40–45 km/h between lights (HCMC DOT 2023: 35 km/h peak on central routes).
    const boost = this.net.saigonRules && sp.swarm && sp.speed >= 10 ? SAIGON_BIKE_SPEED_BOOST : 1;
    this.vDes[i] = sp.speed * boost * (0.82 + 0.22 * aggr + 0.14 * rand01(uid, 1));
    this.len[i] = sp.length;
    this.wid[i] = sp.width;
    // How far past the stop line the front wheel ends up at a red: bold riders roll onto the zebra,
    // most cars stay behind it, a pushy few nose over.
    this.creep[i] = sp.swarm ? 0.2 + 3.6 * aggr * (0.6 + 0.4 * rand01(uid, 2)) : -0.3 + 2.4 * Math.max(0, aggr - 0.6);
    this.stuck[i] = 0;
    this.stopT[i] = 0;
    this.waitT[i] = 0;
    this.crawlT[i] = 0;
    this.age[i] = 0;
    this.dist[i] = 0;
    this.dwell[i] = 0;
    this.committed[i] = 1;
    this.reason[i] = Reason.Free;
    this.ringTarget[i] = -1;
    this.slotT[i] = -1;
    this.busDone[i] = 0;
    this.routeCtr[i] = 0;
    this.lean[i] = 0;
    this.frustration[i] = 0;
    this.honk[i] = 0;
    this.honkCD[i] = 2 + 4 * rand01(uid, 5);
    this.wrong[i] = 0;
    this.wrongT[i] = 0;
    this.act[i] = 0;
    this.elev[i] = 0;
    this.crashed[i] = 0;
    this.wading[i] = 0;
    this.uidIndex.set(uid, i);
    this.assignColors(i);
    this.count++;
    this.mixCount[type]++;
    if (i + 1 > this.hi) this.hi = i + 1;
    this.destS[i] = -1;
    this.dest[i] = this.net.routeByDest ? this.pickDest(i, uid, segId) : -1;
    this.planNext(i);
    this.pickLane(i);
    const sg = this.segs[segId];
    this.l[i] = this.startLateral(type, uid, sg, kerb) ?? this.laneT[i];
    this.updatePose(i, 0);
    this.prevX[i] = this.x[i];
    this.prevZ[i] = this.z[i];
    this.prevHx[i] = this.hx[i];
    this.prevHz[i] = this.hz[i];
    this.gridInsert(i);
    return i;
  }

  private assignColors(i: number): void {
    const uid = this.uid[i];
    const pick = (arr: readonly number[], salt: number) => arr[Math.floor(rand01(uid, salt) * arr.length)];
    switch (this.type[i] as VType) {
      case VType.Moto:
        linear(this.rain > 0.5 ? pick(PONCHO_COLORS, 11) : pick(SHIRT_COLORS, 10), this.c1, i);
        linear(pick(BIKE_COLORS, 12), this.c2, i);
        break;
      case VType.Grab: {
        // Jacket + scooter panels in the rider's app colours (Grab green / Be yellow / Xanh SM teal).
        const brand = HAIL_BRANDS[hailBrand(uid, VType.Grab)];
        linear(this.rain > 0.5 ? brand.rain : brand.paint, this.c1, i);
        linear(brand.paint, this.c2, i);
        break;
      }
      case VType.RideCar: {
        const b = hailBrand(uid, VType.RideCar);
        if (b === 2) {
          // Xanh SM: teal VinFast EV with a white roof lamp.
          linear(HAIL_BRANDS[b].paint, this.c1, i);
          linear(0xf2f5f5, this.c2, i);
        } else {
          // Grab Car / Be Car: an ordinary car wearing the app's roof sign.
          linear(pick(CAR_COLORS, 13), this.c1, i);
          linear(HAIL_BRANDS[b].paint, this.c2, i);
        }
        break;
      }
      case VType.Car:
        linear(pick(CAR_COLORS, 13), this.c1, i);
        linear(0x2a2c30, this.c2, i);
        break;
      case VType.TaxiVinasun:
        linear(0xf4f3ee, this.c1, i);
        linear(0x0f8f4e, this.c2, i);
        break;
      case VType.TaxiMaiLinh:
        linear(0x0d8a4b, this.c1, i);
        linear(0xf3efe0, this.c2, i);
        break;
      case VType.Bus:
        linear(0x2f9e5a, this.c1, i);
        linear(0xf1e7c9, this.c2, i);
        break;
      case VType.Truck:
        linear(pick(TRUCK_CAB, 14), this.c1, i);
        linear(pick(TRUCK_BOX, 15), this.c2, i);
        break;
      case VType.Cyclo:
        linear(pick(CYCLO_HOOD, 16), this.c1, i);
        linear(0x24382c, this.c2, i);
        break;
    }
  }

  private release(i: number): void {
    this.active[i] = 0;
    this.uidIndex.delete(this.uid[i]);
    this.count--;
    this.mixCount[this.type[i]]--;
    this.free.push(i);
    if (i + 1 === this.hi) {
      while (this.hi > 0 && !this.active[this.hi - 1]) this.hi--;
    }
  }

  /** Metres from the start of a sink link at which a vehicle with draw `frac` ∈ [0, 1) ends its trip. */
  private static sinkS(len: number, frac: number): number {
    return Math.min(len - 1, SINK_MARGIN_START + frac * Math.max(1, len - SINK_MARGIN_START - SINK_MARGIN_END));
  }

  /**
   * Draw an internal sink for vehicle `i` (uid `uid`) starting on `segId`: weight = trip weight, not its own link, at least `D_MIN` metres of path away
   * from its arrival point (`distTo` is to the END of the sink link, so `len − destS` is taken off). Sets `destS[i]`; −1 when no sink qualifies.
   */
  private pickSink(i: number, uid: number, segId: number): number {
    const { dests, distTo, nExits } = this.net;
    const frac = rand01(uid, 501);
    const w = this.sinkWeight;
    const scratch = this.sinkScratch;
    let total = 0;
    for (let m = 0; m < w.length; m++) {
      scratch[m] = 0;
      const d = nExits + m;
      const sink = dests[d];
      if (sink.id === segId) continue;
      const dist = distTo[d][segId];
      if (dist < Infinity && dist - (sink.length - Traffic.sinkS(sink.length, frac)) >= D_MIN) {
        scratch[m] = w[m];
        total += w[m];
      }
    }
    if (total <= 0) return -1;
    let u = rand01(uid, 503) * total;
    let last = -1;
    for (let m = 0; m < w.length; m++) {
      if (scratch[m] <= 0) continue;
      last = m;
      u -= scratch[m];
      if (u < 0) break;
    }
    const d = nExits + last;
    this.destS[i] = Traffic.sinkS(dests[d].length, frac);
    return d;
  }

  /**
   * Draw a destination for vehicle `i` (uid `uid`) that starts on `segId`: with `P_DEST_INTERNAL` an internal sink (`pickSink`), otherwise (or when none qualifies)
   * an exit — weight = lanes, only exits ≥ `D_MIN` metres of path away (dropped when none qualifies), reachable ones only. −1 when nothing is reachable.
   */
  private pickDest(i: number, uid: number, segId: number): number {
    const { dests, distTo } = this.net;
    if (dests.length > this.net.nExits && rand01(uid, 502) < P_DEST_INTERNAL) {
      const d = this.pickSink(i, uid, segId);
      if (d >= 0) return d;
    }
    for (let pass = 0; pass < 2; pass++) {
      const dMin = pass === 0 ? D_MIN : 0;
      let total = 0;
      for (let d = 0; d < this.net.nExits; d++) {
        const dist = distTo[d][segId];
        if (dist >= dMin && dist < Infinity) total += dests[d].lanes;
      }
      if (total <= 0) continue;
      let u = rand01(uid, 500) * total;
      let last = -1;
      for (let d = 0; d < this.net.nExits; d++) {
        const dist = distTo[d][segId];
        if (!(dist >= dMin && dist < Infinity)) continue;
        last = d;
        u -= dests[d].lanes;
        if (u < 0) return d;
      }
      return last;
    }
    return -1;
  }

  /** Decide the segment after the current one (route chosen one step ahead). */
  private planNext(i: number): void {
    const sg = this.segs[this.seg[i]];
    const uid = this.uid[i];
    if (sg.next.length === 0) {
      this.nextSeg[i] = -1;
      return;
    }
    if (sg.kind === SegKind.Ring && sg.ring >= 0 && sg.ringExitArm >= 0) {
      this.nextSeg[i] = (sg.ringExitArm === this.ringTarget[i] ? sg.exitConns[0] : sg.next[0]).id;
      return;
    }
    if (sg.next.length === 1) {
      this.nextSeg[i] = sg.next[0].id;
      return;
    }
    const t = this.type[i] as VType;
    const heavy = t === VType.Bus || t === VType.Truck;
    // Destination bias: a branch whose remaining travel time is `Δ` seconds longer than the fastest one is `exp(−Δ/τ)` times as likely.
    const d = this.dest[i];
    let dt: Float32Array | null = null;
    let dMin = Infinity;
    const router = this.router;
    if (d >= 0 && router) {
      dt = router.cost(d);
      for (const c of sg.next) if (dt[c.id] < dMin) dMin = dt[c.id];
      if (dMin === Infinity) dt = null;
    }
    const tau = TAU_ROUTE_S * (0.6 + 0.8 * this.aggr[i]);
    const weights = sg.next.map((c) => {
      const base = c.turn === Turn.Straight ? 0.55 : c.turn === Turn.Right ? (heavy ? 0.18 : 0.26) : heavy ? 0.12 : 0.19;
      const out = c.next[0];
      let w = base * (out?.deadEnd ? 0.05 : 1) * (out && out.cls >= RoadClass.Residential ? 0.6 : 1);
      if (dt) w *= Math.exp(-(dt[c.id] - dMin) / tau);
      return w;
    });
    const u = rand01(uid, 100 + this.routeCtr[i]++);
    this.nextSeg[i] = sg.next[weightedIndex(weights, u)].id;
  }

  /** Is `out` (the link behind a junction connector) too full for vehicle `i` to enter now? One rule for the line and for detours. */
  private exitFull(out: Segment, lenI: number, swarm: boolean, patient: boolean): boolean {
    // Filtering bikes slip through any lateral band the vehicles at the exit start leave free: the link is only full once they cover every band.
    if (swarm && this.net.saigonRules) return this.segTailMask[out.id] === (1 << this.segBands[out.id]) - 1 && this.segMinV[out.id] < 1;
    // Bikes only look at the physical space at the exit start (other bikes inside the box slip aside).
    const free = this.segMinS[out.id] - (swarm ? 0 : this.segClaim[out.id]);
    return (patient ? free < lenI * 0.5 + 1.4 : free < lenI + 4) && (!patient || swarm ? this.segMinV[out.id] < 1 : true);
  }

  /** 0…1: how hard vehicle `i` forces its way in at a give-way line. Grows with the time waited there; bold drivers start sooner, cautious ones later. */
  private forceLevel(i: number): number {
    const w = this.waitT[i] - Math.max(FORCE_MIN, FORCE_START * (0.5 + this.caution[i]) - FORCE_AGGR * this.aggr[i]);
    return w <= 0 ? 0 : Math.min(1, w / FORCE_RAMP);
  }

  /**
   * Deterministic order for two vehicles that block each other: a vehicle already inside a junction box goes before one on a link
   * (filtering maps only); two box vehicles: left turns go last, then the lower uid.
   */
  private boxFirst(i: number, j: number): boolean {
    const segs = this.segs;
    const ci = segs[this.seg[i]].kind === SegKind.Conn;
    if (ci !== (segs[this.seg[j]].kind === SegKind.Conn)) return ci;
    const ri = segs[this.seg[i]].turn === Turn.Left ? 1 : 0;
    const rj = segs[this.seg[j]].turn === Turn.Left ? 1 : 0;
    return ri !== rj ? ri < rj : this.uid[i] < this.uid[j];
  }

  /**
   * Connector vehicle `i` could take instead of its planned one at the end of its link, or −1: not longer than the
   * planned route by more than `DETOUR_MAX`, exit has room now, signal allows it (green, or right turn on red), nearest
   * to the destination first (tie → lower id; without destination: lowest id).
   */
  private detourFor(i: number, t: number): number {
    const sg = this.segs[this.seg[i]];
    const gate = this.nextSeg[i];
    if (sg.kind !== SegKind.Link || gate < 0 || sg.next.length < 2 || this.segs[gate].kind !== SegKind.Conn) return -1;
    const swarm = SPECS[this.type[i] as VType].swarm;
    const lenI = this.len[i];
    const patient = swarm || this.stopT[i] > EXIT_PATIENCE * (0.5 + this.caution[i]);
    const d = this.dest[i];
    const dt = d >= 0 ? this.net.distTo[d] : null;
    const limit = dt ? dt[gate] + DETOUR_MAX + DETOUR_MAX_AGGR * this.aggr[i] : Infinity;
    let best = -1;
    let bestD = Infinity;
    for (const c of sg.next) {
      if (c.id === gate) continue;
      const out = c.next[0];
      if (!out || out.deadEnd) continue;
      const dc = dt ? dt[c.id] : 0;
      if (!(dc < Infinity && dc <= limit)) continue;
      if (best >= 0 && !(dc < bestD || (dc === bestD && c.id < best))) continue;
      if (sg.signal && !(c.turn === Turn.Right && !sg.noRightOnRed) && this.signals.query(sg.signal.nodeIndex, sg.signal.group, t).light !== Light.Green) continue;
      if (this.exitFull(out, lenI, swarm, patient)) continue;
      best = c.id;
      bestD = dc;
    }
    return best;
  }

  /**
   * Wait-for cycle detector. Every vehicle stopped > `T_CYC` starts a chain: a Follow/Yield vehicle waits for its
   * leader, a gate-blocked one for the rear-most vehicle of the full exit link. A chain that closes on itself is a
   * deadlock: it is broken by a detour of the longest-waiting gate-blocked member that has one, else by removing the
   * member stopped longest.
   */
  private detectLocks(): void {
    const mark = this.walkMark;
    const chain = this.walkChain;
    const base = this.walkId;
    const saigonRules = this.net.saigonRules;
    for (let i = 0; i < this.hi; i++) {
      if (!this.active[i] || this.crashed[i] || !(this.stopT[i] > T_CYC) || mark[i] > base) continue;
      const id = ++this.walkId;
      let n = 0;
      let cycleAt = -1;
      let j = i;
      while (j >= 0) {
        if (mark[j] > base) {
          if (mark[j] === id) {
            cycleAt = 0;
            while (chain[cycleAt] !== j) cycleAt++;
          }
          break;
        }
        if (!this.active[j] || this.crashed[j] || !(saigonRules ? this.v[j] < CYC_CREEP_V : this.stopT[j] > 0)) break;
        mark[j] = id;
        chain[n++] = j;
        const r = this.reason[j];
        if (r !== Reason.Follow && r !== Reason.Yield) break;
        j = this.leader[j] >= 0 ? this.leader[j] : this.waitLink[j] >= 0 ? this.segTailIdx[this.waitLink[j]] : -1;
      }
      if (cycleAt < 0) continue;
      let worst = chain[cycleAt];
      let detourM = -1;
      let detourC = -1;
      for (let k = cycleAt; k < n; k++) {
        const m = chain[k];
        if (this.stopT[m] > this.stopT[worst]) worst = m;
        if (this.leader[m] >= 0 || this.waitLink[m] < 0 || (detourM >= 0 && !(this.stopT[m] > this.stopT[detourM]))) continue;
        const c = this.detourFor(m, this.time);
        if (c >= 0) {
          detourM = m;
          detourC = c;
        }
      }
      this.locksBroken++;
      if (detourM >= 0) {
        this.nextSeg[detourM] = detourC;
        this.pickLane(detourM);
      } else {
        this.release(worst);
      }
    }
  }

  /** Is vehicle `i` on the link where its (internal) trip ends? */
  private onDestLink(i: number, sg: Segment): boolean {
    const d = this.dest[i];
    return this.destS[i] >= 0 && d >= 0 && sg.id === this.net.destSeg[d];
  }

  private pickLane(i: number): void {
    const sg = this.segs[this.seg[i]];
    const t = this.type[i] as VType;
    if (SPECS[t].swarm) return;
    if (sg.kind === SegKind.Ring) {
      this.laneT[i] = Math.min(1.2, sg.halfW * 0.5);
      return;
    }
    if (sg.kind !== SegKind.Link) return;
    const lc = sg.laneC;
    const outer = sg.lanes - 1;
    if (t === VType.Bus || this.onDestLink(i, sg)) {
      this.laneT[i] = lc[outer];
      return;
    }
    const nx = this.nextSeg[i];
    const turn = nx >= 0 ? this.segs[nx].turn : Turn.Straight;
    const toRing = nx >= 0 && this.segs[nx].ringEntryArm >= 0;
    if (toRing || turn === Turn.Right) this.laneT[i] = lc[outer];
    else if (turn === Turn.Left) this.laneT[i] = lc[0];
    else {
      // Mostly the outer lane for trucks, the rest spread over the inner lanes.
      const p = t === VType.Truck ? 0.8 : 0.45;
      const u = rand01(this.uid[i], 200 + this.routeCtr[i]);
      this.laneT[i] = lc[u < p ? outer : Math.floor(((u - p) / (1 - p)) * outer)];
    }
  }

  private enter(i: number, segId: number): void {
    const sg = this.segs[segId];
    this.seg[i] = segId;
    this.wrongT[i] = 0;
    if (sg.kind === SegKind.Conn) this.committed[i] = sg.fromLink ? 0 : 1;
    if (sg.ringEntryArm >= 0) {
      // Pick one of the ring's other exits (a lone exit is the only choice).
      const ex = this.net.rings[sg.ring].exits;
      const r = rand01(this.uid[i], 300 + this.routeCtr[i]++);
      const p = ex.indexOf(sg.ringEntryArm);
      let tgt = ex.length === 1 ? ex[0] : p >= 0 ? ex[(p + 1 + Math.floor(r * (ex.length - 1))) % ex.length] : ex[Math.floor(r * ex.length)];
      const d = this.dest[i];
      const router = this.router;
      if (d >= 0 && router) {
        // Leave by the exit whose outbound link is fastest (live travel time) to the destination.
        const dt = router.cost(d);
        const arms = this.net.rings[sg.ring].arms;
        let bestD = Infinity;
        for (const e of ex) {
          const out = arms[e].outLink;
          if (out && dt[out.id] < bestD) {
            bestD = dt[out.id];
            tgt = e;
          }
        }
      }
      this.ringTarget[i] = tgt;
    }
    this.slotT[i] = -1;
    this.planNext(i);
    this.pickLane(i);
  }

  /** Grid cell holding world point (x, z); out-of-bounds points clamp to the edge cells. */
  private cellAt(x: number, z: number): number {
    const cx = Math.min(this.gw - 1, Math.max(0, Math.floor((x - this.gx0) / CELL)));
    const cz = Math.min(this.gh - 1, Math.max(0, Math.floor((z - this.gz0) / CELL)));
    return cz * this.gw + cx;
  }

  /** Link vehicle `i` into its cell; a slot still chained from before the last rebuild (released and reused since) goes to `fresh` instead, so no chain is ever entered twice. */
  private gridInsert(i: number): void {
    if (this.inGrid[i]) {
      this.fresh.push(i);
      return;
    }
    const c = this.cellAt(this.x[i], this.z[i]);
    this.cellNext[i] = this.cellHead[c];
    this.cellHead[c] = i;
    this.inGrid[i] = 1;
  }

  /**
   * Is there no active vehicle whose centre is within `r + len/2` of (x, z)? Same predicate as a scan over every slot, answered from the grid:
   * vehicles sit in the cell of their position at the last rebuild, so the query reaches the longest half-length plus the largest move since then beyond `r`.
   */
  private clearAt(x: number, z: number, r: number): boolean {
    const reach = r + MAX_HALF_LEN + Math.sqrt(this.maxMoveSq) + 0.01;
    const cx0 = Math.min(this.gw - 1, Math.max(0, Math.floor((x - reach - this.gx0) / CELL)));
    const cx1 = Math.min(this.gw - 1, Math.max(0, Math.floor((x + reach - this.gx0) / CELL)));
    const cz0 = Math.min(this.gh - 1, Math.max(0, Math.floor((z - reach - this.gz0) / CELL)));
    const cz1 = Math.min(this.gh - 1, Math.max(0, Math.floor((z + reach - this.gz0) / CELL)));
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let j = this.cellHead[cz * this.gw + cx]; j !== -1; j = this.cellNext[j]) {
          if (!this.active[j]) continue;
          const dx = this.x[j] - x;
          const dz = this.z[j] - z;
          const rr = r + this.len[j] * 0.5;
          if (dx * dx + dz * dz < rr * rr) return false;
        }
      }
    }
    for (const j of this.fresh) {
      if (!this.active[j]) continue;
      const dx = this.x[j] - x;
      const dz = this.z[j] - z;
      const rr = r + this.len[j] * 0.5;
      if (dx * dx + dz * dz < rr * rr) return false;
    }
    return true;
  }

  /**
   * Is no vehicle on `segId` within `REAR_GAP_BASE + REAR_GAP_TIME · v` metres behind `s`? Answered from the grid around (x, z), the world point of `s`
   * (path distance ≥ straight distance, so the query radius bounds every candidate; speeds above `REAR_GAP_VMAX` are not looked for).
   */
  private rearClear(segId: number, s: number, x: number, z: number): boolean {
    const reach = REAR_GAP_BASE + REAR_GAP_TIME * REAR_GAP_VMAX + Math.sqrt(this.maxMoveSq) + 0.01;
    const cx0 = Math.min(this.gw - 1, Math.max(0, Math.floor((x - reach - this.gx0) / CELL)));
    const cx1 = Math.min(this.gw - 1, Math.max(0, Math.floor((x + reach - this.gx0) / CELL)));
    const cz0 = Math.min(this.gh - 1, Math.max(0, Math.floor((z - reach - this.gz0) / CELL)));
    const cz1 = Math.min(this.gh - 1, Math.max(0, Math.floor((z + reach - this.gz0) / CELL)));
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let j = this.cellHead[cz * this.gw + cx]; j !== -1; j = this.cellNext[j]) {
          if (this.active[j] && this.seg[j] === segId) {
            const gap = s - this.s[j];
            if (gap > 0 && gap < REAR_GAP_BASE + REAR_GAP_TIME * this.v[j]) return false;
          }
        }
      }
    }
    for (const j of this.fresh) {
      if (this.active[j] && this.seg[j] === segId) {
        const gap = s - this.s[j];
        if (gap > 0 && gap < REAR_GAP_BASE + REAR_GAP_TIME * this.v[j]) return false;
      }
    }
    return true;
  }

  /** Link (an entry of `net.links`) drawn with probability ∝ its trip weight; `u` ∈ [0, 1). */
  private tripLinkAt(u: number): Segment {
    const cum = this.tripCum;
    const target = u * cum[cum.length - 1];
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] > target) hi = mid;
      else lo = mid + 1;
    }
    return this.net.links[lo];
  }

  /** Fill the map at boot so the first frame already looks like a living city. */
  populate(n: number): void {
    if (this.net.routeByDest) {
      this.populateByTrips(n);
      return;
    }
    const links = this.net.links;
    const weights = links.map((l) => l.length);
    let attempts = n * 8;
    while (this.count < n && attempts-- > 0) {
      const link = links[weightedIndex(weights, this.rng.next())];
      const type = this.chooseType(this.rng.next());
      const s = 4 + this.rng.next() * Math.max(1, link.length - 10);
      const tmp = this.tmp;
      link.sample(s, tmp);
      if (!this.clearAt(tmp[0], tmp[1], SPECS[type].length * 0.5 + 1.2)) continue;
      this.alloc(type, link.id, s);
    }
  }

  /**
   * `populate` for `routeByDest` maps: links drawn by trip weight, the vehicle's own lateral position tested (bikes use the whole width), and a vehicle that
   * found no room keeps its type for the next attempt (small bikes would otherwise always win). Each pass makes `POPULATE_TRIES` attempts per vehicle; when it
   * ends short of `n`, the next one shrinks the exclusion radius, so `n` is reachable at densities where a full-size radius saturates.
   */
  private populateByTrips(n: number): void {
    if (this.tripCum.length === 0) return;
    const tmp = this.tmp;
    let pending: VType | null = null;
    for (const scale of POPULATE_RADIUS_SCALE) {
      let attempts = n * POPULATE_TRIES;
      while (this.count < n && attempts-- > 0) {
        const type: VType = pending ?? this.chooseType(this.rng.next());
        const link = this.tripLinkAt(this.rng.next());
        const s = 4 + this.rng.next() * Math.max(1, link.length - 10);
        link.sample(s, tmp);
        const l = this.startLateral(type, this.nextUid, link, false) ?? 0;
        const x = tmp[0] - tmp[3] * l;
        const z = tmp[1] + tmp[2] * l;
        if (!this.clearAt(x, z, (SPECS[type].length * 0.5 + 1.2) * scale)) {
          pending = type;
          continue;
        }
        pending = null;
        if (this.alloc(type, link.id, s) < 0) return;
      }
    }
  }

  /**
   * A trip that starts in the middle of a block: link by trip weight, a point `SINK_MARGIN_START`+ m from either end, at the kerb (cars in the outer lane,
   * bikes against the edge), standing still. Refused when another vehicle sits on the spot or one on the same link closer behind than `REAR_GAP_BASE + REAR_GAP_TIME · v`.
   */
  private spawnInternal(type: VType): boolean {
    const link = this.tripLinkAt(this.rng.next());
    const s = Traffic.sinkS(link.length, this.rng.next());
    const tmp = this.tmp;
    link.sample(s, tmp);
    const l = this.startLateral(type, this.nextUid, link, true) ?? 0;
    const x = tmp[0] - tmp[3] * l;
    const z = tmp[1] + tmp[2] * l;
    if (!this.clearAt(x, z, SPECS[type].length * 0.5 + 2.5) || !this.rearClear(link.id, s, x, z)) return false;
    const i = this.alloc(type, link.id, s, 0, true);
    if (i < 0) return false;
    this.fade[i] = 0.02; // fades in over `SPAWN_FADE_S` (see `updatePose`)
    return true;
  }

  private spawnTick(dt: number): void {
    this.spawnAcc += dt;
    if (this.spawnAcc < 0.06) return;
    this.spawnAcc = 0;
    if (this.count >= this.target) return;
    const portals = this.net.portalsIn;
    const byDest = this.net.routeByDest;
    const tries = byDest ? Math.max(SPAWN_TRIES, Math.ceil((SPAWN_TRIES * this.target) / SPAWN_REF_TARGET)) : SPAWN_TRIES;
    for (let k = 0; k < tries; k++) {
      const internal = byDest && this.tripCum.length > 0 && this.rng.next() < P_ORIGIN_INTERNAL;
      // A vehicle that found no room keeps its turn; otherwise small bikes always win the entry gap.
      const link = internal ? null : portals[weightedIndex(this.portalWeights, this.rng.next())];
      const type = this.pendingType >= 0 ? (this.pendingType as VType) : this.chooseType(this.rng.next());
      const tmp = this.tmp;
      const sp = SPECS[type];
      let placed: boolean;
      if (link === null) {
        placed = this.spawnInternal(type);
      } else {
        // Arms feeding straight into the roundabout get less inflow so Bến Thành stays busy, not locked.
        link.sample(0, tmp);
        placed = this.clearAt(tmp[0] + tmp[2] * sp.length * 0.5, tmp[1] + tmp[3] * sp.length * 0.5, sp.length * 0.5 + 0.8);
        if (placed) this.alloc(type, link.id, 0.01);
      }
      if (!placed) {
        // Give it a second portal to try, then let someone else go.
        this.pendingType = this.pendingType === type ? -1 : type;
        continue;
      }
      this.pendingType = -1;
      if (this.count >= this.target) break;
    }
  }

  setRain(rain: number): void {
    this.rain = rain;
    const raining = rain > 0.5;
    if (raining === this.rainApplied) return;
    this.rainApplied = raining;
    // Riders pull on their ponchos (áo mưa) when the rain starts.
    for (let i = 0; i < this.hi; i++) {
      if (this.active[i] && (this.type[i] === VType.Moto || this.type[i] === VType.Grab)) this.assignColors(i);
    }
  }

  // ---------------------------------------------------------------- stepping

  private rebuildGrid(): void {
    this.cellHead.fill(-1);
    this.cellStart.fill(0);
    this.inGrid.fill(0);
    this.fresh.length = 0;
    this.maxMoveSq = 0;
    this.segMinS.fill(Infinity);
    this.segCount.fill(0);
    this.segVSum.fill(0);
    this.segLeadS.fill(-1);
    this.segMaxV.fill(0);
    this.segClaim.fill(0);
    this.segTailIdx.fill(-1);
    this.segTailMask.fill(0);
    this.segForce.fill(0);
    this.segXHit.fill(0);
    this.segXHitV.fill(0);
    this.segXAhead.fill(Infinity);
    this.segXAheadV.fill(0);
    const saigonRules = this.net.saigonRules;
    for (let i = 0; i < this.hi; i++) {
      if (!this.active[i]) continue;
      const c = this.cellAt(this.x[i], this.z[i]);
      this.cellNext[i] = this.cellHead[c];
      this.cellHead[c] = i;
      this.cellOf[i] = c;
      this.cellStart[c]++;
      this.inGrid[i] = 1;
      const sg = this.seg[i];
      const si = this.s[i];
      const vi = this.v[i];
      if (si < this.segMinS[sg]) {
        this.segMinS[sg] = si;
        this.segTailIdx[sg] = i;
        this.segMinV[sg] = vi;
      }
      this.segCount[sg]++;
      this.segVSum[sg] += vi;
      if (si > this.segLeadS[sg]) {
        this.segLeadS[sg] = si;
        this.segLeadV[sg] = vi;
      }
      if (vi > this.segMaxV[sg]) this.segMaxV[sg] = vi;
      const sgo = this.segs[sg];
      if (sgo.kind === SegKind.Conn) {
        if (sgo.next[0]) this.segClaim[sgo.next[0].id] += (this.len[i] + 0.8) * (saigonRules && SWARM_OF[this.type[i]] ? BIKE_CLAIM_PCE : 1);
        if (saigonRules) {
          const xb = sgo.crossedBy;
          for (let k = 0; k < xb.length; k += 3) {
            if (si > xb[k + 1] + CONFLICT_CLEAR) continue;
            const m = xb[k + 2];
            if (si >= xb[k]) {
              this.segXHit[m] = 1;
              if (vi > this.segXHitV[m]) this.segXHitV[m] = vi;
            } else {
              const d = xb[k] - si;
              if (d < this.segXAhead[m]) {
                this.segXAhead[m] = d;
                this.segXAheadV[m] = vi;
              }
            }
          }
        }
      }
      if (saigonRules && vi < 2 && this.waitT[i] > FORCE_MIN) {
        // A minor-approach head standing at its line (or just inside the box, not yet committed) that has waited long enough claims its exit.
        const wants = sgo.kind === SegKind.Link ? sgo.yieldAt !== null && sgo.length - si - this.len[i] * 0.5 < 3 && this.nextSeg[i] >= 0 && this.segs[this.nextSeg[i]].kind === SegKind.Conn : sgo.kind === SegKind.Conn && sgo.fromLink?.yieldAt != null && !this.committed[i];
        if (wants && this.forceLevel(i) > 0) {
          const out = sgo.kind === SegKind.Link ? this.segs[this.nextSeg[i]].next[0] : sgo.next[0];
          if (out) this.segForce[out.id] = 1;
        }
      }
      if (saigonRules && sgo.kind === SegKind.Link && si - this.len[i] * 0.5 < TAIL_ZONE) {
        // Bands (counted from the −halfW edge) the vehicle's body plus clearance covers; OR makes the mask independent of vehicle order.
        const k = this.segBands[sg];
        const bw = (2 * sgo.halfW) / k;
        const half = this.wid[i] * 0.5 + BAND_PAD;
        const b0 = Math.min(k - 1, Math.max(0, Math.floor((this.l[i] - half + sgo.halfW) / bw)));
        const b1 = Math.min(k - 1, Math.max(0, Math.floor((this.l[i] + half + sgo.halfW) / bw)));
        this.segTailMask[sg] |= (1 << (b1 + 1)) - (1 << b0);
      }
    }
    // Packed copy of the chains (perception reads it): count per cell, prefix sums, then fill each cell from its end in ascending slot order,
    // so reading it forward visits the same vehicles in the same order as the chain (highest slot first).
    const cellStart = this.cellStart;
    const nCells = this.gw * this.gh;
    for (let c = 1; c < nCells; c++) cellStart[c] += cellStart[c - 1];
    cellStart[nCells] = cellStart[nCells - 1];
    const nb = this.nbr;
    for (let i = 0; i < this.hi; i++) {
      if (!this.active[i]) continue;
      const p = --cellStart[this.cellOf[i]];
      this.cellItems[p] = i;
      this.posOf[i] = p;
      const o = p << 3;
      nb[o] = this.x[i];
      nb[o + 1] = this.z[i];
      nb[o + 2] = this.hx[i];
      nb[o + 3] = this.hz[i];
      nb[o + 4] = this.len[i];
      nb[o + 5] = this.wid[i];
      nb[o + 6] = this.v[i];
      nb[o + 7] = SWARM_OF[this.type[i]];
    }
    // Same packed layout for the people (descending id within a cell, as the old chain visited them).
    const peds = this.peds;
    const pedStart = this.pedCellStart;
    pedStart.fill(0);
    for (let p = 0; p < peds.hi; p++) {
      if (!peds.active[p]) continue;
      const cx = Math.min(this.gw - 1, Math.max(0, Math.floor((peds.x[p] - this.gx0) / CELL)));
      const cz = Math.min(this.gh - 1, Math.max(0, Math.floor((peds.z[p] - this.gz0) / CELL)));
      const c = cz * this.gw + cx;
      this.pedCellOf[p] = c;
      pedStart[c]++;
    }
    for (let c = 1; c < nCells; c++) pedStart[c] += pedStart[c - 1];
    pedStart[nCells] = pedStart[nCells - 1];
    for (let p = 0; p < peds.hi; p++) {
      if (peds.active[p]) this.pedItems[--pedStart[this.pedCellOf[p]]] = p;
    }
  }

  step(dt: number, t: number): void {
    this.time = t;
    this.signals.flashing = flashHours(this.hour);
    // Low spots fill within ~30 s of a downpour and drain over ~90 s.
    this.floodLevel = Math.min(1, Math.max(0, this.floodLevel + dt * (this.rain > 0.6 ? 0.03 : -0.011)));
    this.peds.step(dt, t, this.hour, this.rain);
    this.updateIncidents(t);
    this.rebuildGrid();
    this.router?.step(this.segCount, this.segVSum, this.signals.flashing, dt);
    const rainF = 1 - 0.24 * this.rain;
    for (let i = 0; i < this.hi; i++) {
      if (!this.active[i]) continue;
      this.prevX[i] = this.x[i];
      this.prevZ[i] = this.z[i];
      this.prevHx[i] = this.hx[i];
      this.prevHz[i] = this.hz[i];
      if (this.crashed[i]) continue;
      this.updateVehicle(i, dt, t, rainF);
      if (this.active[i]) {
        const mx = this.x[i] - this.prevX[i];
        const mz = this.z[i] - this.prevZ[i];
        const m2 = mx * mx + mz * mz;
        if (m2 > this.maxMoveSq) this.maxMoveSq = m2;
      }
    }
    if (DETECTOR_ON && this.net.safetyNets && Math.floor(t) !== Math.floor(t - dt)) this.detectLocks();
    this.spawnTick(dt);
  }

  // ---------------------------------------------------------------- incidents

  private updateIncidents(t: number): void {
    for (let k = this.incidents.length - 1; k >= 0; k--) {
      const inc = this.incidents[k];
      if (t < inc.end) continue;
      // Cleared: the riders pick themselves up and carry on.
      for (const uid of inc.uids) {
        const i = this.uidIndex.get(uid);
        if (i === undefined) continue;
        this.crashed[i] = 0;
        this.lean[i] = 0;
        this.stopT[i] = 0;
      }
      this.incidents.splice(k, 1);
    }
    if (t < this.nextIncidentT) return;
    this.nextIncidentT = t + this.rng.range(70, 150);
    if (this.incidents.length >= 2 || this.rng.next() > 0.75) return;
    const links = this.net.links.filter((l) => l.length > 60 && !l.bridge);
    const link = links[this.rng.int(links.length)];
    const s = this.rng.range(18, link.length - 24);
    const tmp = this.tmp;
    link.sample(s, tmp);
    if (!this.clearAt(tmp[0], tmp[1], 4)) return;
    const pair: VType[] = this.rng.next() < 0.55 ? [VType.Car, VType.Moto] : this.rng.next() < 0.5 ? [VType.Moto, VType.Moto] : [VType.TaxiVinasun, VType.Grab];
    const lane = link.laneC[this.rng.int(link.lanes)];
    const uids: number[] = [];
    pair.forEach((type, k) => {
      const i = this.alloc(type, link.id, s + k * 3.4);
      if (i < 0) return;
      this.crashed[i] = 1;
      this.v[i] = 0;
      this.l[i] = lane + (k === 0 ? 0 : 0.9);
      this.updatePose(i, 0);
      // Skewed car, bike down on its side.
      const yaw = k === 0 ? 0.32 : -0.9;
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      const hx = this.hx[i] * c - this.hz[i] * sn;
      const hz = this.hx[i] * sn + this.hz[i] * c;
      this.hx[i] = this.prevHx[i] = hx;
      this.hz[i] = this.prevHz[i] = hz;
      this.prevX[i] = this.x[i];
      this.prevZ[i] = this.z[i];
      this.lean[i] = SPECS[type].swarm ? 1.3 : 0;
      uids.push(this.uid[i]);
    });
    if (uids.length < 2) return;
    const what = pair[0] === VType.Moto ? 'Hai xe máy va quẹt' : `${SPECS[pair[0]].label} va chạm xe máy`;
    this.incidents.push({
      id: ++this.incidentSeq,
      linkId: link.id,
      x: tmp[0],
      z: tmp[1],
      start: t,
      end: t + this.rng.range(70, 120),
      uids,
      road: link.name,
      desc: what,
    });
  }

  /**
   * Flashing-amber junction: should vehicle `i` (approaching on `group`) hold at the line? Yes while
   * crossing-street traffic is inside the box, or (unless `bold`) when someone at the crossing
   * street's line has waited a good while longer than us — a moving platoon keeps going for a few
   * seconds, then the other street gets its turn. Pushier drivers take longer to concede.
   */
  private flashYield(i: number, nodeIndex: number, group: number, bold: boolean): boolean {
    const node = this.signals.plans[nodeIndex].junction;
    const win = 24 + node.radius;
    const cx0 = Math.max(0, Math.floor((node.x - win - this.gx0) / CELL));
    const cx1 = Math.min(this.gw - 1, Math.floor((node.x + win - this.gx0) / CELL));
    const cz0 = Math.max(0, Math.floor((node.z - win - this.gz0) / CELL));
    const cz1 = Math.min(this.gh - 1, Math.floor((node.z + win - this.gz0) / CELL));
    const concedeAt = this.stopT[i] + 2 + 6 * this.aggr[i];
    const saigonRules = this.net.saigonRules;
    const forcing = saigonRules && this.forceLevel(i) > 0;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let j = this.cellHead[cz * this.gw + cx]; j !== -1; j = this.cellNext[j]) {
          const sj = this.segs[this.seg[j]];
          const sig = sj.kind === SegKind.Conn ? sj.fromLink?.signal : sj.kind === SegKind.Link ? sj.signal : null;
          if (!sig || sig.nodeIndex !== nodeIndex || sig.group === group) continue;
          // Crossing traffic moving through the box blocks us (riders still creeping past their line
          // only once they actually go for it); a stopped committed one is just queued for its exit.
          if (sj.kind === SegKind.Conn) {
            if (this.v[j] > (this.committed[j] ? 0.8 : 2.5)) {
              if (!saigonRules) return true;
              // A crosser past the middle of the box has cleared our path; a forcing driver also ignores one still far from it.
              const toMid = 0.5 * sj.length - this.s[j];
              if (toMid > 0 && (!forcing || toMid <= FORCE_REACH + FORCE_TGAP * this.v[j])) return true;
            }
            if (this.committed[j]) continue;
          }
          // Only the ones actually holding at the line count (not the queue behind them). Bold riders
          // concede too, just much later.
          const atLine = sj.kind === SegKind.Conn || sj.length - this.s[j] - this.len[j] * 0.5 < 3;
          if (atLine && this.reason[j] === Reason.Yield && this.stopT[j] > concedeAt + (bold ? 10 : 0)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Caps `slotFree[k]` at `gf` for every slot k (of `n`, at `slot0 + k · step`) within `reach` of lateral position `la`.
   * `windowed` (fixed pitch): only the slots the reach can cover are visited; otherwise (legacy grid) all `n` are.
   */
  private markSlots(la: number, reach: number, gf: number, slot0: number, step: number, n: number, windowed: boolean): void {
    const sf = this.slotFree;
    let k0 = 0;
    let k1 = n - 1;
    if (windowed) {
      k0 = Math.max(0, Math.ceil((la - reach - slot0) / step) - 1);
      k1 = Math.min(n - 1, Math.floor((la + reach - slot0) / step) + 1);
    }
    for (let k = k0; k <= k1; k++) {
      if (Math.abs(la - (slot0 + k * step)) < reach && gf < sf[k]) sf[k] = gf;
    }
  }

  private updateVehicle(i: number, dt: number, t: number, rainF: number): void {
    const segs = this.segs;
    const type = this.type[i] as VType;
    const sp = SPECS[type];
    const swarm = sp.swarm;
    let sg = segs[this.seg[i]];
    const s = this.s[i];
    let v = this.v[i];
    const li = this.l[i];
    const xi = this.x[i];
    const zi = this.z[i];
    const hxi = this.hx[i];
    const hzi = this.hz[i];
    const rgx = -hzi;
    const rgz = hxi;
    const tmp = this.tmp;
    // The pose update at the end of the previous step sampled this very (segment, s): reuse its tangent.
    const tanHit = this.tanSeg[i] === sg.id + 1 && this.tanS[i] === s;
    if (!tanHit) this.samplePose(sg.id, s, tmp);
    const rtx = tanHit ? -this.tanZ[i] : -tmp[3];
    const rtz = tanHit ? this.tanX[i] : tmp[2];
    const myPrio = sg.priority;
    const lenI = this.len[i];
    const widI = this.wid[i];
    // Inside a junction the usable width narrows toward the link ahead, so riders arrive within its range.
    const aheadI = sg.kind === SegKind.Conn ? this.nextSeg[i] : -1;
    const rangeHW = swarm && aheadI >= 0 && segs[aheadI].kind === SegKind.Link ? Math.min(sg.halfW, segs[aheadI].halfW) : sg.halfW;
    const saigonRules = this.net.saigonRules;
    const halfRange = rangeHW - (swarm ? 0.45 : widI * 0.5 + 0.2);
    // Internal trip end: metres still to go on the destination link (Infinity anywhere else).
    const onDest = this.onDestLink(i, sg);
    const rem = onDest ? this.destS[i] - s : Infinity;
    const arriving = rem < ARRIVE_REACH;
    const uidI = this.uid[i];
    const aggr = this.aggr[i];
    const caution = this.caution[i];
    this.leader[i] = -1;
    this.waitLink[i] = -1;
    const wrongLimit = 3 + 5 * aggr;
    // Personal IDM parameters: bold drivers accelerate harder and sit closer; cautious ones keep a
    // longer time gap, a bigger stopping gap and brake earlier and softer.
    const aMax = sp.accel * (0.8 + 0.4 * aggr);
    const bComf = sp.brake * (1.15 - 0.3 * caution);
    const headway = sp.headway * (0.65 + 0.7 * caution) * (saigonRules && swarm ? BIKE_HEADWAY_K : 1);
    const s0 = sp.s0 * (0.75 + 0.5 * caution);
    // Jammed riders widen their options, bolder ones sooner: crossing the centre line for a short
    // stretch (capped by `wrongT`), the boldest mounting the sidewalk.
    let lo = -halfRange;
    let hi = halfRange;
    if (swarm && type !== VType.Cyclo && sg.kind === SegKind.Link && s > 10 && sg.length - s > 18) {
      const fr = this.frustration[i];
      // The wrong-side licence ends RETURN_LEAD seconds before the cap so the rider is back in time.
      if (aggr > 0.5 && !sg.oneway && fr > 2 - 1.2 * aggr && this.wrongT[i] < wrongLimit - RETURN_LEAD) lo = -halfRange - 2.4;
      if (aggr > 0.62 && fr > 3.2 - 2 * aggr && !sg.bridge) hi = sg.halfW + 1.05;
    }

    // ---- perception: leader in own corridor, free distance per lateral slot, and (bikes) the
    // social-force push from everyone close by
    const L = swarm ? 16 : Math.min(34, 12 + v * 2.2);
    let gap = Infinity;
    let vCap = Infinity;
    let leadV = 0;
    let reason: Reason = Reason.Free;
    // Social force on a rider, in its own frame (m/s²): forward and to the right.
    let fLong = 0;
    let fLat = 0;
    // Personal space: cautious riders keep a wider bubble, bold ones brush past.
    const sfB = 0.22 + 0.25 * caution;
    // Cars only change lanes when the neighbouring lane is clear of other cars alongside.
    let blockRight = false;
    let blockLeft = false;
    const slotFree = this.slotFree;
    // Lateral candidate slots: legacy = 9 spread evenly over [lo, hi]; saigonRules = fixed pitch, centred on [lo, hi], searched through an index window.
    const windowed = saigonRules && SLOT_PITCH > 0;
    const nSlots = windowed ? Math.min(SLOTS_MAX, Math.floor((hi - lo) / SLOT_PITCH + 1e-9) + 1) : SLOTS;
    const slotStep = windowed ? SLOT_PITCH : (hi - lo) / (SLOTS - 1);
    const slot0 = windowed ? lo + (hi - lo - (nSlots - 1) * SLOT_PITCH) * 0.5 : lo;
    for (let k = 0; k < nSlots; k++) slotFree[k] = L;
    let leadIdx = -1;
    /** Wrong-way rider facing oncoming traffic must return to its own side. */
    let giveBack = false;
    let pedBlock = false;
    const qx = xi + hxi * L * 0.45;
    const qz = zi + hzi * L * 0.45;
    const qr = L * 0.55 + 3;
    const cx0 = Math.max(0, Math.floor((qx - qr - this.gx0) / CELL));
    const cx1 = Math.min(this.gw - 1, Math.floor((qx + qr - this.gx0) / CELL));
    const cz0 = Math.max(0, Math.floor((qz - qr - this.gz0) / CELL));
    const cz1 = Math.min(this.gh - 1, Math.floor((qz + qr - this.gz0) / CELL));
    const maxD2 = (L + 4) * (L + 4);
    const stuckI = this.stuck[i];
    const wrongI = this.wrong[i];
    // Hot-loop locals: typed arrays and per-vehicle-class constants are read many times per neighbour.
    const NB = this.nbr;
    const SEGA = this.seg;
    const UIDA = this.uid;
    const WRONGA = this.wrong;
    const COMMITA = this.committed;
    const cellStart = this.cellStart;
    const cellItems = this.cellItems;
    const gw = this.gw;
    const sideClearBike = saigonRules ? SIDE_CLEAR_BIKE : SIDE_CLEAR;
    const squeezeK = saigonRules ? SQUEEZE_EASE : 0.6;
    const leadClearBike = swarm ? (saigonRules ? LEADER_CLEAR_BIKE : 0.1) : 0.3;
    const leadClearOther = swarm ? 0.1 : 0.3;
    // Slot-window search: the `1/step` multiply may land a slot off at an exact boundary, so the window is padded and the per-slot test stays exact.
    const invStep = windowed ? 1 / slotStep : 0;
    for (let cz = cz0; cz <= cz1; cz++) {
      const rowBase = cz * gw;
      for (let pi = cellStart[rowBase + cx0], pEnd = cellStart[rowBase + cx1 + 1]; pi < pEnd; pi++) {
        const j = cellItems[pi];
        if (j === i) continue;
        const o = pi << 3;
        const rx = NB[o] - xi;
        const rz = NB[o + 1] - zi;
        if (rx * rx + rz * rz > maxD2) continue;
        const f = rx * hxi + rz * hzi;
        if (f < -4) continue;
        const hxj = NB[o + 2];
        const hzj = NB[o + 3];
        const dotH = hxi * hxj + hzi * hzj;
        if (dotH < -0.55) {
          // Oncoming traffic normally stays on its own side, but wrong-way riders meet it head-on.
          if (f <= 0) continue;
          const latO = rx * rgx + rz * rgz;
          const hwO = (widI + NB[o + 5]) * 0.5;
          const gfO = f - (lenI + NB[o + 4]) * 0.5;
          if (swarm) {
            // Closing speed halves the usable gap in that slot.
            const la = li + rx * rtx + rz * rtz;
            this.markSlots(la, hwO + 0.3, gfO * 0.5, slot0, slotStep, nSlots, windowed);
          }
          // The wrong-way rider gives way; legal oncoming traffic only stops at the last moment.
          const facing = Math.abs(latO) < hwO + 0.2;
          if (facing && wrongI && gfO < 9) giveBack = true;
          // A wrong-way rider feels oncoming traffic shove it back toward its own side.
          if (swarm && wrongI && Math.abs(latO) < hwO + 1.5 && gfO < 10) fLat += 2.5 * Math.exp(-Math.max(0, gfO) / 3);
          if (facing && ((wrongI && gfO < gap) || (WRONGA[j] && gfO < 2.5 && gfO < gap))) {
            gap = gfO;
            leadV = 0;
            leadIdx = j;
            reason = Reason.Yield;
          }
          continue;
        }
        // Circulating traffic ignores entrants still waiting at the give-way line.
        if (myPrio === 2 && NB[o + 6] < 1.5 && segs[SEGA[j]].priority === 1) continue;
        const lat = rx * rgx + rz * rgz;
        const lenJ = NB[o + 4];
        const widJ = NB[o + 5];
        const hl = (lenI + lenJ) * 0.5;
        const hw = (widI + widJ) * 0.5;
        const swarmJ = NB[o + 7] === 1;
        if (swarm) {
          // Hard side constraint: never steer into someone riding alongside.
          if (Math.abs(f) < hl && Math.abs(lat) < hw + (swarmJ ? sideClearBike : SIDE_CLEAR)) {
            if (lat > 0) blockRight = true;
            else blockLeft = true;
          }
          // Social force (Helbing-style, anisotropic): exponential push away from each neighbour,
          // measured on an ellipse so side clearance counts double; overlap pushes hardest.
          const dl = Math.abs(f) - hl;
          const dw = Math.abs(lat) - hw;
          if (dl < 5 && dw < 1.6) {
            // hypot(0, y) = y exactly: only a neighbour off to the front/back AND to the side needs the real hypot.
            const d = dl > 0 ? (dw > 0 ? Math.hypot(dl * 0.5, dw) : dl * 0.5) : dw > 0 ? dw : Math.max(dl, dw);
            const n = Math.hypot(f, lat) || 1;
            // Someone ahead matters; someone behind much less.
            const w = 0.3 + 0.35 * (1 + f / n);
            const mag = (swarmJ ? 1.6 : 2.6) * w * Math.exp(Math.min(2, -d / sfB));
            // Dead-ahead neighbours give no side cue; break the tie by uid.
            fLat -= mag * (Math.abs(lat) > 0.05 ? lat / n : uidI & 1 ? 0.25 : -0.25);
            // Squeezed from the diagonal ahead → ease off (the one dead ahead is the IDM leader's job).
            if (f > 0 && dw >= 0.1) fLong -= mag * (f / n) * squeezeK;
          }
        } else if (!swarmJ && Math.abs(f) < hl + 2 && Math.abs(lat) > 0.6 && Math.abs(lat) < hw + 2.6) {
          if (lat > 0) blockRight = true;
          else blockLeft = true;
        }
        if (f <= 0) continue;
        let crossing = dotH < 0.5;
        let passesBehind = false;
        if (crossing) {
          const sj = segs[SEGA[j]];
          if (saigonRules && sg.kind === SegKind.Conn && sj.kind === SegKind.Conn && sg.fromLink !== null && sj.fromLink === sg.fromLink) {
            // Same approach inside the box (a straight and a turning mover of one queue): they follow, not cross.
            crossing = false;
          } else {
            // Lower-priority traffic is ignored — unless it already entered the junction box.
            if (sj.priority < myPrio && !(sj.fromLink && COMMITA[j])) continue;
            if (stuckI > 5) continue;
          }
          if (saigonRules && swarm && sg.kind === SegKind.Conn) {
            // Will j's body have left my corridor before I reach it? Then it is no wall.
            const latV = NB[o + 6] * (hxj * rgx + hzj * rgz);
            const aLatV = Math.abs(latV);
            if (aLatV > GAX_LAT_V_MIN) {
              const hwC = (widI + NB[o + 5]) * 0.5;
              const dOut = (latV > 0 ? hwC - lat : hwC + lat) + GAX_CLEAR;
              const tArr = (f - (lenI + NB[o + 4]) * 0.5) / Math.max(v, GAX_V_MIN);
              passesBehind = dOut / aLatV + GAX_MARGIN + GAX_MARGIN_CAUTION * caution < tArr;
            }
          }
        }
        // Both see each other ahead: deterministic tie-break so they never deadlock.
        const fj = -(rx * hxj + rz * hzj);
        if (fj > 0) {
          const latj = -(rx * -hzj + rz * hxj);
          if (Math.abs(latj) < hw + 0.4) {
            // Never apply the tie-break once footprints touch, so vehicles can't pass through each other.
            if (uidI < UIDA[j] && f - hl > 0.4) continue;
            // Two vehicles inside the box that have blocked each other for a moment: the straight/right one (then
            // the lower uid) goes first, the left turner waits, so the pair never closes a wait-for cycle.
            if (crossing && stuckI > T_BOX_GRACE && this.net.safetyNets && sg.kind === SegKind.Conn && (segs[SEGA[j]].kind === SegKind.Conn || (saigonRules && segs[SEGA[j]].kind === SegKind.Link)) && (!saigonRules || f - hl > 0) && this.boxFirst(i, j)) continue;
          }
        }
        const gf = f - hl;
        if (!passesBehind && Math.abs(lat) < hw + (swarmJ ? leadClearBike : leadClearOther) && gf < gap) {
          gap = gf;
          leadV = crossing ? 0 : Math.max(0, NB[o + 6] * dotH);
          leadIdx = j;
          reason = crossing ? Reason.Yield : Reason.Follow;
        }
        // Every slot starts at L, so a neighbour at or beyond L caps nothing.
        if (swarm && gf < L) {
          const la = li + rx * rtx + rz * rtz;
          if (windowed) {
            const reach = hw + 0.1;
            const k1 = Math.min(nSlots - 1, Math.floor((la + reach - slot0) * invStep) + 1);
            for (let k = Math.max(0, Math.ceil((la - reach - slot0) * invStep) - 1); k <= k1; k++) {
              if (Math.abs(la - (slot0 + k * slotStep)) < reach && gf < slotFree[k]) slotFree[k] = gf;
            }
          } else this.markSlots(la, hw + 0.1, gf, slot0, slotStep, nSlots, windowed);
        }
      }
    }

    // ---- people on the road: everyone gives way; bikes also look for a way around
    const peds = this.peds;
    const pedStart = this.pedCellStart;
    const pedItems = this.pedItems;
    for (let cz = cz0; cz <= cz1; cz++) {
      const rowBase = cz * gw;
      for (let pq = pedStart[rowBase + cx0], pqEnd = pedStart[rowBase + cx1 + 1]; pq < pqEnd; pq++) {
        const p = pedItems[pq];
        const rx = peds.x[p] - xi;
        const rz = peds.z[p] - zi;
        if (rx * rx + rz * rz > maxD2) continue;
        const f = rx * hxi + rz * hzi;
        if (f <= 0) continue;
        const lat = rx * rgx + rz * rgz;
        const hw = widI * 0.5 + PED_RADIUS;
        const gf = f - lenI * 0.5 - PED_RADIUS;
        if (Math.abs(lat) < hw + (swarm ? 0.2 : 0.6) && gf < gap) {
          gap = gf;
          leadV = 0;
          leadIdx = -1;
          reason = Reason.Yield;
          pedBlock = true;
        }
        if (swarm) {
          const la = li + rx * rtx + rz * rtz;
          this.markSlots(la, hw + 0.2, gf, slot0, slotStep, nSlots, windowed);
          // People get a wide berth: a stronger push than another bike.
          const dw = Math.abs(lat) - hw;
          if (gf < 4 && dw < 1.2) {
            const d = Math.hypot(Math.max(0, gf) * 0.5, Math.max(0, dw));
            const n = Math.hypot(f, lat) || 1;
            fLat -= 2.2 * Math.exp(Math.min(2, -d / sfB)) * (Math.abs(lat) > 0.05 ? lat / n : uidI & 1 ? 0.25 : -0.25);
          }
        }
      }
    }
    this.pedYield[i] = pedBlock ? 1 : 0;

    // ---- roundabout: skip a jammed exit and go round again rather than lock the ring
    if (sg.kind === SegKind.Ring && sg.ringExitArm >= 0 && sg.ringExitArm === this.ringTarget[i]) {
      const exit = sg.exitConns[0];
      const out = exit.next[0];
      const need = swarm ? 1.5 : lenI + 2;
      const blocked =
        (this.segMinS[exit.id] < need && this.segMinV[exit.id] < 1.5) ||
        (this.segMinS[out.id] < need + 2 && this.segMinV[out.id] < 1.5);
      this.nextSeg[i] = blocked ? sg.next[0].id : exit.id;
    }

    // ---- signals
    let stopD = Infinity;
    let stopReason: Reason = Reason.Signal;
    let nx = this.nextSeg[i];
    let sigLink: Segment | null = null;
    let distLine = 0;
    let turn: Turn = Turn.Straight;
    if (sg.kind === SegKind.Link && sg.signal) {
      sigLink = sg;
      distLine = sg.length - s;
      turn = nx >= 0 ? segs[nx].turn : Turn.Straight;
    } else if (sg.kind === SegKind.Conn && sg.fromLink && !this.committed[i]) {
      sigLink = sg.fromLink;
      distLine = -s;
      turn = sg.turn;
    }
    // Junction moves stay flagged while crossing the box so the HUD can show them.
    let act = sg.kind === SegKind.Conn ? this.act[i] & (Act.JumpRed | Act.RunAmber) : 0;
    if (sigLink && sigLink.signal) {
      const sr = sigLink.signal;
      const st = this.signals.query(sr.nodeIndex, sr.group, t);
      // Front-bumper distance to where this vehicle stops; `creep` (personality) is how far past the
      // stop line it rolls: bold riders end up on the zebra, most cars stay just behind it.
      const lineGap = distLine - lenI * 0.5 + this.creep[i];
      let mustStop = false;
      if (lineGap > -0.4) {
        if (st.light === Light.Flash) {
          // Late-night flashing amber: no one has right of way, so slow down and look (bold drivers
          // barely lift off), then go only when the box is clear of crossing traffic and nobody on
          // the crossing street has been waiting longer. Bold riders skip the courtesy part.
          if (distLine < 20) {
            vCap = Math.min(vCap, 2.5 + 6.5 * aggr * (1 - 0.5 * caution));
            act |= Act.Flash;
          }
          if (lineGap < 4 && this.flashYield(i, sr.nodeIndex, sr.group, swarm && aggr > 0.75)) {
            mustStop = true;
            stopReason = Reason.Yield;
          }
        } else if (st.light !== Light.Green) {
          const rightOnRed = turn === Turn.Right && !sigLink.noRightOnRed;
          if (rightOnRed) {
            if (!swarm && distLine < 16) vCap = Math.min(vCap, 4.5);
          } else if (st.light === Light.Amber) {
            // Calm drivers stop whenever they can do it at all; bold ones only if it's comfortable.
            const brakeDist = (v * v) / (2 * sp.brake);
            mustStop = lineGap > brakeDist / (1.5 - 0.7 * aggr) + 0.4;
            if (!mustStop && lineGap > brakeDist / 1.5 + 0.4 && distLine > 0) act |= Act.RunAmber;
          } else {
            // The countdown invites going on the last second or two of red (cross traffic is in
            // its all-red clearance by then). Mostly bikes; only the pushiest car drivers.
            const jump = aggr > 0.72 && (swarm || aggr > 0.85) && st.remaining < Math.min(1.8, 4 * (aggr - 0.6));
            mustStop = !jump;
            if (jump && distLine > -2) act |= Act.JumpRed;
            else if (v < 1 && distLine - lenI * 0.5 < -0.6) act |= Act.OverLine;
          }
        }
      }
      if (mustStop) stopD = lineGap + s0;
    }
    this.act[i] = act;

    // ---- nobody enters a junction whose exit has no room for them (the box would lock). Cars want a
    // comfortable gap behind a standing queue; bikes squeeze in whenever a bike physically fits; and a
    // driver who has waited long enough takes any gap that physically fits, so a minor arm never starves.
    if (sg.kind === SegKind.Link && nx >= 0 && segs[nx].kind === SegKind.Conn && stopD === Infinity) {
      const lineGap = sg.length - s - lenI * 0.5 + this.creep[i];
      if (lineGap > -0.4) {
        const out = segs[nx].next[0];
        if (out) {
          const patient = swarm || this.stopT[i] > EXIT_PATIENCE * (0.5 + caution);
          if (this.exitFull(out, lenI, swarm, patient)) {
            this.waitLink[i] = out.id;
            // A blocked driver who has waited a while takes another turn whose exit has room.
            const alt = this.net.safetyNets && this.stopT[i] >= T_DETOUR + T_DETOUR_CAUTION * caution ? this.detourFor(i, t) : -1;
            if (alt >= 0) {
              this.nextSeg[i] = alt;
              nx = alt;
              this.pickLane(i);
            } else {
              stopD = lineGap + s0;
              stopReason = Reason.Follow;
            }
          } else if (saigonRules && !swarm && sg.yieldAt === null && this.segForce[out.id] !== 0 && this.segMinS[out.id] - this.segClaim[out.id] < FORCE_ROOM) {
            // Priority-road cars leave the tight exit room to a minor-approach head (car or bike) that has waited long enough to force in;
            // the wait is on `out`'s room, so it is recorded as a wait edge for the lock detector.
            this.waitLink[i] = out.id;
            stopD = lineGap + s0;
            stopReason = Reason.Follow;
          }
        }
      }
    }

    // ---- unsignalised junction: minor arms give way to the priority road
    const yields = (sg.kind === SegKind.Link && sg.yieldAt !== null && nx >= 0) || (sg.kind === SegKind.Conn && sg.fromLink?.yieldAt != null && !this.committed[i]);
    if (yields) {
      const conn = sg.kind === SegKind.Conn ? sg : segs[nx];
      const lineGap = (sg.kind === SegKind.Link ? sg.length - s : -s) - lenI * 0.5 + this.creep[i];
      if (lineGap > -0.4 && lineGap < 20) {
        // Patient drivers wait for a proper gap; after a while they nose in and only stop for a
        // vehicle actually about to hit them.
        const tGap = (swarm ? 1.4 : 2.6) * (0.6 + 0.8 * caution);
        const patient = this.stopT[i] < (swarm ? 2.5 : 6) * (0.5 + caution);
        const force = saigonRules ? this.forceLevel(i) : 0;
        let block = false;
        if (saigonRules) {
          // Priority traffic blocks only while it is inside a crossing stretch at speed, or is still before one and about to arrive:
          // vehicles spread over a long connector no longer wall off an empty crossing. A forcing driver shrinks the arrival reach to `FORCE_REACH`.
          const vMin = patient ? 0.8 : 1.0;
          const reach = CONFLICT_REACH - force * (CONFLICT_REACH - FORCE_REACH);
          block = (this.segXHit[conn.id] !== 0 && this.segXHitV[conn.id] > vMin) || (this.segXAheadV[conn.id] > vMin && this.segXAhead[conn.id] < reach);
        } else {
          const cf = conn.conflicts;
          const zn = conn.conflictZone;
          for (let k = 0; k < cf.length; k++) {
            const c = cf[k].id;
            if (!this.segCount[c] || this.segMaxV[c] <= (patient ? 0.8 : 1.0)) continue;
            // Only a vehicle in, or about to reach, the crossing/merging stretch counts: a long
            // connector carrying a steady stream is not a wall across the whole minor approach.
            const z0 = zn[2 * k];
            const z1 = zn[2 * k + 1];
            // A forcing driver only counts a vehicle inside the stretch or within stopping margin of it: the reach shrinks with the force.
            const reach = force > 0 ? CONFLICT_REACH + force * (Math.min(CONFLICT_REACH, FORCE_REACH + FORCE_TGAP * this.segLeadV[c]) - CONFLICT_REACH) : CONFLICT_REACH;
            if (z0 > z1 || (this.segMinS[c] <= z1 + CONFLICT_CLEAR && this.segLeadS[c] >= z0 - reach)) {
              block = true;
              break;
            }
          }
        }
        if (!block) {
          for (const m of conn.conflictLinks) {
            if (!this.segCount[m.id]) continue;
            const d = m.length - this.segLeadS[m.id];
            const vj = this.segLeadV[m.id];
            // A major-road queue head that is itself standing still (waiting for its own exit) is no
            // reason to hold the minor arm: only vehicles actually rolling toward the box count.
            if (patient ? vj > 0.5 && (d < 4 + 2.5 || d / Math.max(vj, 1.5) < tGap) : vj > 2 && d < 6 - 3 * force) {
              block = true;
              break;
            }
          }
        }
        // A driver who has stood at the line for `T_ASSERT` and is already forcing never starves behind a steady major flow: the crossing/arrival courtesy is dropped; his own leader/corridor check (the neighbour loop) still stops him for a body in his way.
        if (block && saigonRules && this.waitT[i] > T_ASSERT && force >= 1) block = false;
        if (block && lineGap + s0 < stopD) {
          stopD = lineGap + s0;
          stopReason = Reason.Yield;
        }
      }
    }
    // A connector is committed once the vehicle is inside the box and nothing holds it at the line.
    if (sg.kind === SegKind.Conn && !this.committed[i] && stopD === Infinity && s > (swarm ? this.creep[i] : 0.3)) this.committed[i] = 1;

    // ---- roundabout entry: yield to circulating traffic
    if (sg.merge && sg.length - s < 18) {
      const m = sg.merge;
      const mcx0 = Math.max(0, Math.floor((m.x - 16 - this.gx0) / CELL));
      const mcx1 = Math.min(this.gw - 1, Math.floor((m.x + 16 - this.gx0) / CELL));
      const mcz0 = Math.max(0, Math.floor((m.z - 16 - this.gz0) / CELL));
      const mcz1 = Math.min(this.gh - 1, Math.floor((m.z + 16 - this.gz0) / CELL));
      const window = swarm ? 1.0 : 1.9;
      // After a few seconds of waiting, drivers nose in; only a vehicle actually moving
      // through the merge still stops them (a stopped one is waiting for us).
      const patient = this.stopT[i] < (swarm ? 1.5 : 4.5) * (0.5 + caution);
      let yieldNow = false;
      for (let cz = mcz0; cz <= mcz1 && !yieldNow; cz++) {
        for (let cx = mcx0; cx <= mcx1 && !yieldNow; cx++) {
          for (let j = this.cellHead[cz * this.gw + cx]; j !== -1; j = this.cellNext[j]) {
            const sj = this.seg[j];
            for (const up of m.upstream) {
              if (up.seg.id !== sj) continue;
              const d = up.seg.length - this.s[j] + up.extra;
              const vj = this.v[j];
              // Impatient drivers only stop for a moving vehicle about to hit them.
              const block = patient
                ? d < 3.5 + this.len[j] * 0.5 || (d < 15 && d / Math.max(vj, 1.5) < window)
                : vj > 2 && d < 6;
              if (block) yieldNow = true;
            }
            if (yieldNow) break;
          }
        }
      }
      // Give-way line sits at the ring's outer edge, not on the circulating lane.
      const mergeGap = sg.length - s - (swarm ? 5.5 : 7) - lenI * 0.5 + s0;
      if (yieldNow && mergeGap < stopD) {
        stopD = mergeGap;
        stopReason = Reason.Yield;
      }
    }

    // ---- bus stops
    if (type === VType.Bus && sg.busStopS >= 0 && this.busDone[i] !== sg.id + 1) {
      const d = sg.busStopS - s;
      if (this.dwell[i] > 0) {
        this.dwell[i] -= dt;
        if (this.dwell[i] <= 0) this.busDone[i] = sg.id + 1;
        else {
          stopD = 0;
          stopReason = Reason.Dwell;
        }
      } else if (d > -1) {
        if (d < 0.8 && v < 0.6) {
          this.dwell[i] = 7 + 4 * rand01(this.uid[i], 400 + sg.id);
        } else if (d + s0 < stopD) {
          stopD = d + s0;
          stopReason = Reason.Dwell;
        }
      }
    }

    // ---- longitudinal (IDM)
    let vd = Math.min(this.vDes[i], sg.speedLimit * (swarm ? 0.95 : 1)) * rainF;
    if (sg.kind === SegKind.Link && nx >= 0) {
      const vt = segs[nx].speedLimit * rainF;
      const dEnd = Math.max(0, sg.length - s - 1);
      vd = Math.min(vd, Math.sqrt(vt * vt + 2 * 2.2 * dEnd));
    }
    // ---- arriving: crawl to the kerb spot
    if (arriving) vd = Math.min(vd, ARRIVE_V0 + ARRIVE_V_PER_M * Math.max(0, rem));
    // ---- events: rubbernecking near crashes, wading through flood water
    for (let k = 0; k < this.incidents.length; k++) {
      const inc = this.incidents[k];
      const dx = inc.x - xi;
      const dz = inc.z - zi;
      if (dx * dx + dz * dz < 900) vd *= 0.6;
    }
    let wading = 0;
    if (this.floodLevel > 0.05) {
      for (const fz of this.floods) {
        const dx = fz.x - xi;
        const dz = fz.z - zi;
        const d2 = dx * dx + dz * dz;
        if (d2 > fz.r * fz.r) continue;
        const depth = this.floodLevel * fz.depth * (1 - (Math.sqrt(d2) / fz.r) * 0.5);
        if (depth < 0.08) continue;
        wading = 1;
        vd = vd * (1 - depth) + Math.min(vd, swarm ? 2.6 : 3.6) * depth;
        // A few scooters drown their engines and get pushed through.
        if (swarm && depth > 0.55 && rand01(uidI, 70) < 0.12) {
          vd = Math.min(vd, 0.9);
          wading = 2;
        }
      }
    }
    this.wading[i] = wading;
    vd = Math.max(0.9, Math.min(vd, vCap));
    if (!swarm && leadIdx >= 0 && this.crashed[leadIdx] && gap < 40 && sg.kind === SegKind.Link) {
      // Steer around the wreck into the other lane.
      const lc = sg.laneC;
      let k = 0;
      for (let m = 1; m < sg.lanes; m++) if (Math.abs(this.l[leadIdx] - lc[m]) < Math.abs(this.l[leadIdx] - lc[k])) k = m;
      this.laneT[i] = lc[k < sg.lanes - 1 ? k + 1 : Math.max(0, k - 1)];
    }
    let g = gap;
    let vL = leadV;
    if (stopD < g) {
      g = stopD;
      vL = 0;
      reason = stopReason;
    }
    let acc: number;
    const ratio = v / vd;
    const free = 1 - ratio * ratio * ratio * ratio;
    if (g < Infinity) {
      const sStar = s0 + Math.max(0, v * headway + (v * (v - vL)) / (2 * Math.sqrt(aMax * bComf)));
      const q = sStar / Math.max(g, 0.08);
      acc = aMax * (free - q * q);
    } else {
      acc = aMax * free;
    }
    // Bikes: the along-road part of the social force (squeezed from the diagonal ahead → ease off).
    if (swarm) acc += Math.max(-4, fLong);
    if (acc < -9) acc = -9;
    v += acc * dt;
    if (v < 0 || g <= 0) v = 0;

    // ---- lateral
    let vlat = this.vl[i];
    if (swarm) {
      if (stopD < Infinity) for (let k = 0; k < nSlots; k++) if (stopD < slotFree[k]) slotFree[k] = stopD;
      let turnPref = 0;
      if (type === VType.Cyclo) turnPref = 1;
      else if (sg.kind === SegKind.Link && nx >= 0) {
        const tn = segs[nx].turn;
        if (sg.length - s < 45) turnPref = segs[nx].ringEntryArm >= 0 ? 0.6 : tn;
      } else if (sg.kind === SegKind.Ring) {
        turnPref = sg.ringExitArm === this.ringTarget[i] && sg.length - s < 12 ? 1 : -0.4;
      }
      let best = 0;
      let bestScore = -Infinity;
      // A slowly drifting preferred line so riders weave instead of tracking rails.
      const r1 = rand01(uidI, 52);
      const wanderPos = halfRange * 0.7 * Math.sin(t * (0.05 + 0.09 * r1) + r1 * 40);
      for (let k = 0; k < nSlots; k++) {
        const pos = slot0 + k * slotStep;
        let sc = Math.min(slotFree[k], L) - 1.35 * Math.abs(pos - li);
        sc -= (halfRange - pos) * 0.12;
        if (arriving) sc -= (halfRange - pos) * 0.5;
        if (turnPref > 0) sc -= (halfRange - pos) * 1.1 * turnPref;
        else if (turnPref < 0) sc -= (pos + halfRange) * 1.1 * -turnPref;
        if (k === this.slotT[i]) sc += 1.1;
        sc -= 0.3 * Math.abs(pos - wanderPos);
        // Wrong side only into a genuinely clear stretch, and never while facing someone.
        if (pos < -halfRange && (giveBack || slotFree[k] < 8)) continue;
        if (pos < -halfRange) sc -= 1.0;
        if (pos > halfRange) sc -= 1.2; // sidewalk
        if (sc > bestScore) {
          bestScore = sc;
          best = k;
        }
      }
      this.slotT[i] = best;
      const target = slot0 + best * slotStep;
      const maxLat = type === VType.Cyclo ? 0.5 : 0.55 + 0.17 * v;
      // Social force across the road: a driving term relaxing toward the chosen gap (bold riders
      // react quicker), plus the summed push of neighbours, people and the edges of the usable road.
      fLat += 1.5 * Math.exp(Math.min(2, (lo - li) / 0.18)) - 1.5 * Math.exp(Math.min(2, (li - hi) / 0.18));
      const desired = Math.max(-maxLat, Math.min(maxLat, (target - li) * 1.7));
      const tau = 0.24 - 0.08 * aggr;
      vlat += ((desired - vlat) / tau + Math.max(-6, Math.min(6, fLat))) * dt;
      vlat = Math.max(-maxLat - 0.6, Math.min(maxLat + 0.6, vlat));
      if ((vlat > 0 && blockRight) || (vlat < 0 && blockLeft)) vlat = 0;
      // Past the wrong-way allowance (or outside the range now permitted): head back to the own side
      // even if someone is alongside; the jam squeezes up rather than leaving the rider there for minutes.
      if (this.wrong[i] && (this.wrongT[i] >= wrongLimit - RETURN_LEAD || li < lo - 0.05)) vlat = Math.max(vlat, 1.5);
    } else {
      // Inside a junction keep the lateral position, but drift into the range of the link ahead.
      let target = this.laneT[i];
      if (sg.kind === SegKind.Conn) {
        target = li;
        const ahead = nx >= 0 ? segs[nx] : null;
        if (ahead && ahead.kind === SegKind.Link) target = Math.max(ahead.laneC[0], Math.min(ahead.laneC[ahead.lanes - 1], li));
      }
      let desired = Math.max(-1.1, Math.min(1.1, (target - li) * 0.9)) * Math.min(1, v / 4);
      if ((desired > 0 && blockRight) || (desired < 0 && blockLeft)) desired = 0;
      vlat += (desired - vlat) * Math.min(1, dt * 3);
    }
    let lNew = li + vlat * dt;
    // Riders already outside the normal range drift back in rather than snapping.
    const minL = swarm ? Math.min(lo, li) : -halfRange;
    const maxL = swarm ? Math.max(hi, li) : halfRange;
    if (lNew > maxL) {
      lNew = maxL;
      if (vlat > 0) vlat = 0;
    } else if (lNew < minL) {
      lNew = minL;
      if (vlat < 0) vlat = 0;
    }

    // ---- bookkeeping
    if (v < 0.3) this.stopT[i] += dt;
    else this.stopT[i] = 0;
    if (saigonRules) {
      // Time spent waiting at a give-way line (creeping up the queue does not reset it); zero anywhere else.
      const atGiveWay =
        sg.kind === SegKind.Link
          ? (sg.yieldAt !== null || (sg.signal !== null && this.signals.flashing)) && sg.length - s - lenI * 0.5 < FORCE_ZONE
          : sg.kind === SegKind.Conn &&
            (sg.fromLink?.yieldAt != null || (sg.fromLink?.signal != null && this.signals.flashing)) && !this.committed[i];
      if (!atGiveWay) this.waitT[i] = 0;
      else if (v < 2) this.waitT[i] += dt;
      if (sg.kind !== SegKind.Link && v < CRAWL_V) this.crawlT[i] += dt;
      else this.crawlT[i] = 0;
    }
    if (v < 0.3 && reason === Reason.Yield) this.stuck[i] += dt;
    else if (v > 1) this.stuck[i] = 0;
    this.reason[i] = reason;
    this.leader[i] = leadIdx;
    const jammed = reason === Reason.Follow || reason === Reason.Yield;
    if (swarm && jammed && v < 2.5) this.frustration[i] = Math.min(8, this.frustration[i] + dt);
    else this.frustration[i] = Math.max(0, this.frustration[i] - dt * 0.6);
    this.wrong[i] = sg.kind === SegKind.Link && lNew < -sg.halfW - 0.1 ? 1 : 0;
    if (this.wrong[i]) this.wrongT[i] += dt;
    // Horn: blocked drivers lean on it now and then (deterministic per half-second); bold ones far
    // more often, and they also honk at a slow leader without waiting to stop.
    this.honk[i] = Math.max(0, this.honk[i] - dt);
    this.honkCD[i] -= dt;
    const impatient = aggr > 0.7 && reason === Reason.Follow && v < vd * 0.5 && gap < 5;
    if (((jammed && v < 2 && gap < 7 && this.stopT[i] > 0.6) || impatient) && this.honkCD[i] <= 0) {
      if (rand01(uidI, 600 + Math.floor(t * 2)) < (swarm ? 0.03 : 0.07) * (0.25 + 1.5 * aggr)) {
        this.honk[i] = 0.9;
        this.honkCD[i] = (10 + 15 * rand01(uidI, 601 + Math.floor(t))) * (1.3 - 0.6 * aggr);
      }
    }
    // Last-resort unjam, only inside junctions/the ring and never for an ordinary queue on a street:
    // a driver boxed in mid-junction for 90 s gives up and leaves.
    if ((this.stopT[i] > MAX_STOPPED || this.crawlT[i] > T_CRAWL) && sg.kind !== SegKind.Link && (reason === Reason.Yield || reason === Reason.Follow)) {
      this.releases++;
      this.release(i);
      return;
    }
    // Stuck-head teleport (SUMO-style): the front vehicle of its segment, held by a queue/gap for T_TELE, or at a
    // signal for T_TELE_SIG, leaves the map. Counted as a failure.
    if (
      this.net.safetyNets &&
      ((this.stopT[i] > T_TELE && (reason === Reason.Follow || reason === Reason.Yield)) || (this.stopT[i] > T_TELE_SIG && reason === Reason.Signal)) &&
      this.segLeadS[sg.id] === s
    ) {
      this.teleports++;
      this.release(i);
      return;
    }

    // ---- reached the internal trip end: the vehicle has parked and leaves the map
    if (onDest && s + v * dt >= this.destS[i]) {
      this.arrivals++;
      this.release(i);
      return;
    }

    // ---- advance along the path
    let sNew = s + v * dt;
    this.dist[i] += v * dt;
    this.age[i] += dt;
    while (sNew >= sg.length) {
      const n2 = this.nextSeg[i];
      if (n2 < 0) {
        this.release(i);
        return;
      }
      sNew -= sg.length;
      this.enter(i, n2);
      sg = segs[n2];
      if (sg.kind !== SegKind.Conn) {
        // The lateral offset is relative to the new segment's reference line; a link with fewer lanes
        // than the junction the vehicle just crossed must not inherit a position outside its width.
        const lim = sg.halfW - (swarm ? 0.45 : widI * 0.5 + 0.2);
        if (lNew > lim) {
          lNew = lim;
          if (vlat > 0) vlat = 0;
        } else if (lNew < -lim) {
          lNew = -lim;
          if (vlat < 0) vlat = 0;
        }
      }
    }
    this.s[i] = sNew;
    this.v[i] = v;
    this.vl[i] = vlat;
    this.l[i] = lNew;
    this.updatePose(i, dt);
    // Later vehicles read this one's new pose and speed through the neighbour table.
    const q = this.posOf[i] << 3;
    const nb = this.nbr;
    nb[q] = this.x[i];
    nb[q + 1] = this.z[i];
    nb[q + 2] = this.hx[i];
    nb[q + 3] = this.hz[i];
    nb[q + 6] = v;
  }

  /** `Segment.sample(s, out)` for segment `id`, from the packed table (same values, same arithmetic). */
  private samplePose(id: number, s: number, out: Float32Array): void {
    const f = Math.min(Math.max(s, 0), this.smpLen[id]) / this.smpStep[id];
    const k = Math.min(this.smpN[id] - 2, Math.floor(f));
    const u = f - k;
    const d = this.smpData;
    const o = (this.smpBase[id] + k) * 4;
    out[0] = d[o] + (d[o + 4] - d[o]) * u;
    out[1] = d[o + 1] + (d[o + 5] - d[o + 1]) * u;
    let tx = d[o + 2] + (d[o + 6] - d[o + 2]) * u;
    let tz = d[o + 3] + (d[o + 7] - d[o + 3]) * u;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    out[2] = tx;
    out[3] = tz;
  }

  private updatePose(i: number, dt: number): void {
    const sg = this.segs[this.seg[i]];
    const tmp = this.tmp;
    const s = this.s[i];
    this.samplePose(sg.id, s, tmp);
    this.tanSeg[i] = sg.id + 1;
    this.tanS[i] = s;
    this.tanX[i] = tmp[2];
    this.tanZ[i] = tmp[3];
    const tx = tmp[2];
    const tz = tmp[3];
    const rx = -tz;
    const rz = tx;
    const l = this.l[i];
    this.x[i] = tmp[0] + rx * l;
    this.z[i] = tmp[1] + rz * l;
    const v = this.v[i];
    const vl = this.vl[i];
    const swarm = SPECS[this.type[i]].swarm;
    const ohx = this.hx[i];
    const ohz = this.hz[i];
    let hx: number;
    let hz: number;
    if (dt === 0) {
      hx = tx;
      hz = tz;
    } else if (swarm) {
      // Bikes point where they actually move, so weaving is visible.
      const mvx = tx * v + rx * vl;
      const mvz = tz * v + rz * vl;
      const m = Math.hypot(mvx, mvz);
      if (m > 0.35) {
        const k = Math.min(1, dt * 9);
        hx = ohx + (mvx / m - ohx) * k;
        hz = ohz + (mvz / m - ohz) * k;
      } else {
        hx = ohx;
        hz = ohz;
      }
    } else {
      const k = Math.max(-0.35, Math.min(0.35, vl / Math.max(v, 2)));
      hx = tx + rx * k;
      hz = tz + rz * k;
    }
    let hm = Math.hypot(hx, hz) || 1;
    hx /= hm;
    hz /= hm;
    if (swarm && dt > 0) {
      // A rider never points back against the direction of travel (e.g. while nudging sideways in a
      // queue or right after a turn): lift the heading back into the forward half-plane.
      const dot = hx * tx + hz * tz;
      if (dot < HEADING_MIN_DOT) {
        hx += (HEADING_MIN_DOT - dot) * tx;
        hz += (HEADING_MIN_DOT - dot) * tz;
        hm = Math.hypot(hx, hz) || 1;
        hx /= hm;
        hz /= hm;
      }
    }
    this.hx[i] = hx;
    this.hz[i] = hz;
    if (dt > 0 && swarm) {
      const omega = (ohx * hz - ohz * hx) / dt;
      const target = Math.max(-0.42, Math.min(0.42, omega * v * 0.08));
      this.lean[i] += (target - this.lean[i]) * Math.min(1, dt * 6);
    }
    let fade = 1;
    if (sg.portalIn && s < 5) fade = s / 5;
    if (sg.portalOut && sg.length - s < 5) fade = Math.max(0, (sg.length - s) / 5);
    if (this.net.routeByDest) {
      if (this.onDestLink(i, sg)) fade = Math.min(fade, (this.destS[i] - s) / ARRIVE_FADE_M);
      // A vehicle that pulled out mid-block starts invisible (`spawnInternal`) and ramps up; every other one is at 1 already.
      if (dt > 0 && !(sg.portalIn && s < 5)) fade = Math.min(fade, this.fade[i] + dt / SPAWN_FADE_S);
    }
    this.fade[i] = Math.max(0.02, fade);
    this.elev[i] = sg.kind === SegKind.Link ? Math.min(1, Math.max(0, (l - sg.halfW) / 0.5)) * 0.15 : 0;
  }

  // ---------------------------------------------------------------- queries

  kpi(out: TrafficKpi): TrafficKpi {
    let sumV = 0;
    let sumD = 0;
    let n = 0;
    let waiting = 0;
    let movV = 0;
    let movN = 0;
    const rainF = 1 - 0.24 * this.rain;
    for (let i = 0; i < this.hi; i++) {
      if (!this.active[i]) continue;
      n++;
      sumV += this.v[i];
      sumD += Math.min(this.vDes[i], this.segs[this.seg[i]].speedLimit) * rainF;
      if (this.v[i] < 0.5) waiting++;
      else if (this.v[i] > 1 && this.reason[i] === Reason.Free && this.segs[this.seg[i]].kind === SegKind.Link) {
        movV += this.v[i];
        movN++;
      }
    }
    out.count = n;
    out.avgKmh = n ? (sumV / n) * 3.6 : 0;
    out.movingKmh = movN ? (movV / movN) * 3.6 : 0;
    out.congestion = n ? Math.max(0, Math.min(100, (1 - sumV / sumD) * 100)) : 0;
    out.waiting = waiting;
    for (let k = 0; k < VTYPE_COUNT; k++) out.mix[k] = this.mixCount[k];
    out.releases = this.releases;
    out.locksBroken = this.locksBroken;
    out.teleports = this.teleports;
    out.arrivals = this.arrivals;
    return out;
  }

  describe(i: number): VehicleInfo | null {
    if (i < 0 || !this.active[i]) return null;
    const uid = this.uid[i];
    const type = this.type[i] as VType;
    const sg = this.segs[this.seg[i]];
    const r = (salt: number) => rand01(uid, salt);
    const d2 = (salt: number) => String(Math.floor(r(salt) * 100)).padStart(2, '0');
    const d3 = (salt: number) => String(Math.floor(r(salt) * 1000)).padStart(3, '0');
    let plate: string;
    let model: string;
    const bikeSeries = ['X1', 'T1', 'F1', 'P1', 'H1', 'D1', 'N1', 'B1'];
    if (type === VType.Moto || type === VType.Grab) {
      plate = `59-${bikeSeries[Math.floor(r(30) * bikeSeries.length)]} ${d3(31)}.${d2(32)}`;
      const bike = BIKE_MODELS[Math.floor(r(33) * BIKE_MODELS.length)];
      model = type === VType.Grab ? `${HAIL_BRANDS[hailBrand(uid, type)].bike} · ${bike}` : bike;
    } else if (type === VType.Cyclo) {
      plate = `Xích lô du lịch · số ${Math.floor(r(31) * 90 + 10)}`;
      model = 'Xích lô Sài Gòn';
    } else if (type === VType.Bus) {
      plate = `51B-${d3(31)}.${d2(32)}`;
      model = BUS_ROUTES[Math.floor(r(33) * BUS_ROUTES.length)];
    } else if (type === VType.Truck) {
      plate = `51D-${d3(31)}.${d2(32)}`;
      model = 'Hyundai Porter 1,5 tấn';
    } else {
      const series = ['A', 'F', 'G', 'H', 'K'];
      plate = `51${series[Math.floor(r(30) * series.length)]}-${d3(31)}.${d2(32)}`;
      if (type === VType.RideCar) {
        const b = hailBrand(uid, type);
        const fleet = b === 2 ? XANH_SM_MODELS : CAR_MODELS;
        model = `${HAIL_BRANDS[b].car} · ${fleet[Math.floor(r(33) * fleet.length)]}`;
      } else {
        model = type === VType.Car ? CAR_MODELS[Math.floor(r(33) * CAR_MODELS.length)] : 'Toyota Vios';
      }
    }
    const driver = `${SURNAMES[Math.floor(r(40) * SURNAMES.length)]} ${GIVEN[Math.floor(r(41) * GIVEN.length)]}`;
    const aggr = this.aggr[i];
    const temper = aggr > 0.78 ? 'Liều lĩnh' : aggr > 0.62 ? 'Hung hăng' : this.caution[i] > 0.62 ? 'Thận trọng' : 'Điềm tĩnh';
    const act = this.act[i];
    const v = this.v[i];
    const reason = this.reason[i] as Reason;
    let status: string;
    if (this.crashed[i]) status = 'Va chạm, chờ xử lý';
    else if (this.wading[i] === 2) status = 'Chết máy, dắt xe qua chỗ ngập';
    else if (this.wading[i] === 1) status = 'Lội qua đoạn ngập';
    else if (this.wrong[i]) status = 'Lấn làn ngược chiều';
    else if (this.elev[i] > 0.05) status = 'Leo lề, chạy trên vỉa hè';
    else if (this.honk[i] > 0) status = 'Bóp còi inh ỏi';
    else if (this.pedYield[i] && v < 2) status = 'Nhường người đi bộ qua đường';
    else if (act & Act.JumpRed) status = 'Vượt đèn đỏ khi còn vài giây';
    else if (act & Act.RunAmber) status = 'Cố vượt đèn vàng';
    else if (act & Act.Flash) status = v < 1.5 ? 'Đèn vàng nhấp nháy, chờ xe ngang qua' : 'Đèn vàng nhấp nháy, giảm tốc quan sát';
    else if (reason === Reason.Signal && v < 1.5) status = act & Act.OverLine ? 'Chờ đèn đỏ, đè qua vạch dừng' : 'Đang chờ đèn đỏ';
    else if (reason === Reason.Dwell) status = 'Dừng đón trả khách';
    else if (reason === Reason.Yield && v < 2) status = sg.merge ? 'Chờ nhập vòng xoay' : 'Nhường đường';
    else if (v < 1.2) status = 'Kẹt xe';
    else if (SPECS[type].swarm && Math.abs(this.vl[i]) > 0.45) status = 'Đang lách qua dòng xe';
    else if (sg.kind === SegKind.Ring) status = 'Đang đi vòng xoay';
    else if (sg.ringEntryArm >= 0) status = 'Đang vào vòng xoay';
    else if (sg.kind === SegKind.Conn) status = sg.turn === Turn.Left ? 'Đang rẽ trái' : sg.turn === Turn.Right ? 'Đang rẽ phải' : 'Đang qua giao lộ';
    else status = 'Đang chạy';
    const nx = this.nextSeg[i];
    let nextName = '';
    const onRing = sg.kind === SegKind.Ring || sg.ringEntryArm >= 0;
    if (onRing && this.ringTarget[i] >= 0) {
      nextName = this.net.rings[sg.ring].arms[this.ringTarget[i]].name;
    } else if (nx >= 0) {
      const ns = this.segs[nx];
      nextName = ns.kind === SegKind.Conn && ns.next[0] ? ns.next[0].name : ns.name;
    }
    return {
      uid,
      type,
      label: SPECS[type].label,
      plate,
      model,
      driver,
      temper,
      wantKmh: this.vDes[i] * 3.6,
      kmh: v * 3.6,
      street: sg.name,
      next: nextName,
      status,
      age: this.age[i],
      distKm: this.dist[i] / 1000,
    };
  }

  /** Index of an active vehicle by uid, or −1. */
  indexOf(uid: number): number {
    return this.uidIndex.get(uid) ?? -1;
  }

  /** Events currently affecting traffic, for the HUD feed. */
  events(hour: number): CityEvent[] {
    const out: CityEvent[] = this.incidents.map((inc) => ({
      key: `crash-${inc.id}`,
      kind: 'crash',
      title: `Va chạm trên ${inc.road}`,
      detail: `${inc.desc} · còn ~${Math.max(1, Math.ceil((inc.end - this.time) / 60))} phút`,
    }));
    if (this.floodLevel > 0.15) {
      const wet = this.floods.filter((fz) => this.floodLevel * fz.depth * 40 >= 6);
      if (wet.length) {
        const maxCm = Math.round(this.floodLevel * Math.max(...wet.map((fz) => fz.depth)) * 40);
        out.push({
          key: 'flood',
          kind: 'flood',
          title: `Ngập nước ${wet.length} tuyến đường`,
          detail: `${wet.map((fz) => fz.road).join(', ')} · sâu tới ${maxCm} cm, có xe chết máy`,
        });
      }
    }
    if (truckBanActive(hour)) {
      const until = hour < 9 ? '09:00' : '20:00';
      out.push({ key: 'ban', kind: 'ban', title: 'Cấm xe tải vào nội đô', detail: `Giờ cao điểm · đến ${until}` });
    }
    return out;
  }

  // ---------------------------------------------------------------- time machine

  snapshot(): TrafficSnapshot {
    const n = this.hi;
    const arrays = this.stateArrays.map(({ arr, stride }) => {
      const out = new Float32Array(n * stride);
      out.set(arr.subarray(0, n * stride));
      return out;
    });
    return {
      arrays,
      hi: n,
      count: this.count,
      target: this.target,
      time: this.time,
      hour: this.hour,
      rain: this.rain,
      nextUid: this.nextUid,
      spawnAcc: this.spawnAcc,
      pendingType: this.pendingType,
      rainApplied: this.rainApplied,
      rng: this.rng.state,
      free: this.free.slice(),
      incidents: structuredClone(this.incidents),
      floodLevel: this.floodLevel,
      nextIncidentT: this.nextIncidentT,
      peds: this.peds.snapshot(),
      incidentSeq: this.incidentSeq,
      releases: this.releases,
      locksBroken: this.locksBroken,
      teleports: this.teleports,
      arrivals: this.arrivals,
      router: this.router?.snapshot(),
    };
  }

  restore(snap: TrafficSnapshot): void {
    this.active.fill(0);
    this.stateArrays.forEach(({ arr }, a) => {
      arr.set(snap.arrays[a]);
    });
    this.hi = snap.hi;
    this.count = snap.count;
    this.target = snap.target;
    this.time = snap.time;
    this.hour = snap.hour;
    this.signals.flashing = flashHours(snap.hour);
    this.rain = snap.rain;
    this.nextUid = snap.nextUid;
    this.spawnAcc = snap.spawnAcc;
    this.pendingType = snap.pendingType;
    this.rainApplied = snap.rainApplied;
    this.rng.state = snap.rng;
    this.free.length = 0;
    this.free.push(...snap.free);
    this.incidents = structuredClone(snap.incidents);
    this.floodLevel = snap.floodLevel;
    this.nextIncidentT = snap.nextIncidentT;
    this.peds.restore(snap.peds);
    if (this.router) {
      if (!snap.router) throw new Error('Traffic.restore: snapshot has no router state but this map routes by time cost');
      this.router.restore(snap.router);
    }
    this.incidentSeq = snap.incidentSeq;
    this.releases = snap.releases ?? 0;
    this.locksBroken = snap.locksBroken ?? 0;
    this.teleports = snap.teleports ?? 0;
    this.arrivals = snap.arrivals ?? 0;
    this.uidIndex.clear();
    this.mixCount.fill(0);
    for (let i = 0; i < this.hi; i++) {
      if (!this.active[i]) continue;
      this.uidIndex.set(this.uid[i], i);
      this.mixCount[this.type[i]]++;
    }
    // The grid and per-segment aggregates are scratch rebuilt at the start of `step`, but `updateIncidents` (before that rebuild) and `clearAt` read the grid.
    this.rebuildGrid();
  }
}

export interface TrafficSnapshot {
  arrays: Float32Array[];
  hi: number;
  count: number;
  target: number;
  time: number;
  hour: number;
  rain: number;
  nextUid: number;
  spawnAcc: number;
  pendingType: number;
  rainApplied: boolean;
  rng: number;
  free: number[];
  incidents: Incident[];
  floodLevel: number;
  nextIncidentT: number;
  peds: PedSnapshot;
  incidentSeq: number;
  releases?: number;
  locksBroken?: number;
  teleports?: number;
  arrivals?: number;
  /** Time-cost router state (`routeByDest` maps); absent on legacy snapshots. */
  router?: RouterSnapshot;
}

export interface VehicleInfo {
  uid: number;
  type: VType;
  label: string;
  plate: string;
  model: string;
  driver: string;
  /** Personality label (Vietnamese). */
  temper: string;
  /** Desired free-flow speed. */
  wantKmh: number;
  kmh: number;
  street: string;
  next: string;
  status: string;
  age: number;
  distKm: number;
}
