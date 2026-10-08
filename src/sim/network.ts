// Generalised road network. Every map (the hand-built one in legacyMap.ts, OpenStreetMap in
// osmMap.ts) is described as a `NetGraph` and turned into the same `Network` by `buildNetwork`.
// All geometry is in world units (≈ metres), x = east, z = south, y = up. Vietnam drives on the
// right: for a travel direction d, the right-hand side is (-d.z, d.x).

import { buildRouting } from './routing';

/** Width of one traffic lane. */
export const LANE_W = 3.5;
/** Signal clearance phases (seconds), shared by the builder, the plans and the osm timing. */
export const AMBER = 3;
export const ALL_RED = 2;

export const enum SegKind {
  Link = 0,
  Conn = 1,
  Ring = 2,
}

export const enum Turn {
  Left = -1,
  Straight = 0,
  Right = 1,
}

export const enum RoadClass {
  Trunk = 0,
  Primary = 1,
  Secondary = 2,
  Tertiary = 3,
  Residential = 4,
  Unclassified = 5,
}

export type NodeKind = 'junction' | 'join' | 'portal' | 'dead' | 'ring';

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Junction {
  id: number;
  key: string;
  name: string;
  kind: NodeKind;
  /** Cluster centre and member radius (used for the flashing-amber window). */
  x: number;
  z: number;
  radius: number;
  /** Sorted by angle. */
  arms: Arm[];
  /** Non-null ⇒ signalised; `index` is the position in `Network.signalJunctions`. */
  signal: SignalPlan | null;
  /** Arm indices of the priority road (unsignalised) — also the phase axis when signalised. */
  majorArms: number[];
  /** −1 or index into `Network.rings`. */
  ring: number;
}

export interface Arm {
  junction: Junction;
  /** Direction pointing away from the node along the road. */
  angle: number;
  ox: number;
  oz: number;
  inLink: Segment | null;
  outLink: Segment | null;
  /** Half the width of the whole road (both directions + median). */
  roadHalf: number;
  rank: number;
  /** Distance from the node to the stop line along the road. */
  trim: number;
  /** Stop line position on the road centreline. */
  stopX: number;
  stopZ: number;
  name: string;
}

export interface SignalPlan {
  index: number;
  green: [number, number];
  offset: number;
  cycle: number;
  /** Direction of the road axis that belongs to group 0 (radians). */
  axis: number;
}

export interface SignalRef {
  nodeIndex: number;
  group: number;
  approach: number;
}

export interface Road {
  id: number;
  name: string;
  cls: RoadClass;
  bridge: boolean;
  links: Segment[];
  /** Centreline length in metres. */
  length: number;
}

export interface RingArm {
  angle: number;
  inLink: Segment | null;
  outLink: Segment | null;
  entry: Segment | null;
  exit: Segment | null;
  road: Road | null;
  name: string;
}

export interface RingMerge {
  x: number;
  z: number;
  /** Ring segments upstream of the merge with the extra distance from their end to the merge point. */
  upstream: { seg: Segment; extra: number }[];
}

export interface Ring {
  id: number;
  name: string;
  cx: number;
  cz: number;
  r: number;
  halfW: number;
  arms: RingArm[];
  /** Arm indices that have an outbound link. */
  exits: number[];
  arcs: Segment[];
  merges: RingMerge[];
}

const SAMPLE_STEP = 0.5;

export class Segment {
  readonly id: number;
  readonly kind: SegKind;
  readonly px: Float32Array;
  readonly pz: Float32Array;
  readonly tx: Float32Array;
  readonly tz: Float32Array;
  readonly n: number;
  readonly length: number;
  readonly step: number;
  lanes = 1;
  halfW = LANE_W / 2;
  /** Lane centres relative to the reference line, innermost (left) first. */
  laneC: Float32Array = new Float32Array(1);
  oneway = false;
  /** Lateral offset of this link's reference line from the road centreline. */
  refOffset = 0;
  roadHalf = LANE_W / 2;
  median = 0;
  cls: RoadClass = RoadClass.Tertiary;
  bridge = false;
  next: Segment[] = [];
  name = '';
  speedLimit = 12.5;
  /** Link 0. Connector: 2 from a major arm of an unsignalised junction, 1 minor, 0 signalised/join. Ring arcs and exits 2, entries 1. */
  priority = 0;
  turn: Turn = Turn.Straight;
  road: Road | null = null;
  from: Junction | null = null;
  to: Junction | null = null;
  portalIn = false;
  portalOut = false;
  /** Link ends at a dead end (still a `portalOut`: vehicles vanish there). */
  deadEnd = false;
  /** Connector: the junction it runs through. */
  junction: Junction | null = null;
  /** Signal controlling the end of this link. */
  signal: SignalRef | null = null;
  /** Every connector of a junction: the link it came from. Ring entries have none. */
  fromLink: Segment | null = null;
  /** Inbound link of a minor arm at an unsignalised junction. */
  yieldAt: Junction | null = null;
  /** Minor connector: major connectors that cross or merge with it. */
  conflicts: Segment[] = [];
  /** `fromLink` of `conflicts`, deduplicated. */
  conflictLinks: Segment[] = [];
  /** Per `conflicts[k]`: arc range [from, to] of that major connector where this connector crosses or merges with it (2k, 2k+1). */
  conflictZone: number[] = [];
  /** Priority connector: triples (zone start, zone end, minor connector id) — the arc range where each minor connector crosses it. */
  crossedBy: number[] = [];
  noRightOnRed = false;
  busStopS = -1;
  merge: RingMerge | null = null;
  /** Index into `Network.rings`, or −1. */
  ring = -1;
  /** Ring arc ending at the exit point of this ring-arm index (−1 otherwise). */
  ringExitArm = -1;
  /** Ring entry connector: ring-arm index it enters from. */
  ringEntryArm = -1;
  exitConns: Segment[] = [];

  constructor(id: number, kind: SegKind, pts: number[]) {
    this.id = id;
    this.kind = kind;
    // Resample a polyline at uniform arc length so lookups are O(1).
    const m = pts.length / 2;
    const cum = new Float64Array(m);
    for (let i = 1; i < m; i++) {
      cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
    }
    const total = cum[m - 1];
    const n = Math.max(2, Math.ceil(total / SAMPLE_STEP) + 1);
    this.n = n;
    this.length = total;
    this.step = total / (n - 1);
    this.px = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const s = i * this.step;
      while (j < m - 2 && cum[j + 1] < s) j++;
      const segLen = cum[j + 1] - cum[j] || 1e-6;
      const u = Math.min(1, Math.max(0, (s - cum[j]) / segLen));
      this.px[i] = pts[j * 2] + (pts[j * 2 + 2] - pts[j * 2]) * u;
      this.pz[i] = pts[j * 2 + 1] + (pts[j * 2 + 3] - pts[j * 2 + 1]) * u;
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      let dx = this.px[b] - this.px[a];
      let dz = this.pz[b] - this.pz[a];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      this.tx[i] = dx;
      this.tz[i] = dz;
    }
  }

  /** Sets the lane layout: `laneC[k] = -halfW + LANE_W/2 + k·LANE_W`. */
  setLanes(lanes: number): void {
    this.lanes = lanes;
    this.halfW = (lanes * LANE_W) / 2;
    this.laneC = new Float32Array(lanes);
    for (let k = 0; k < lanes; k++) this.laneC[k] = -this.halfW + LANE_W / 2 + k * LANE_W;
  }

  /** Writes position + unit tangent at arc length s into out[0..3]. */
  sample(s: number, out: Float32Array | number[]): void {
    const f = Math.min(Math.max(s, 0), this.length) / this.step;
    const i = Math.min(this.n - 2, Math.floor(f));
    const u = f - i;
    out[0] = this.px[i] + (this.px[i + 1] - this.px[i]) * u;
    out[1] = this.pz[i] + (this.pz[i + 1] - this.pz[i]) * u;
    let tx = this.tx[i] + (this.tx[i + 1] - this.tx[i]) * u;
    let tz = this.tz[i] + (this.tz[i + 1] - this.tz[i]) * u;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    out[2] = tx;
    out[3] = tz;
  }
}

export interface Network {
  bounds: Bounds;
  roads: Road[];
  segments: Segment[];
  /** Link segments (`SegKind.Link`) only. */
  links: Segment[];
  junctions: Junction[];
  /** Signalised junctions; `SignalRef.nodeIndex` and `SignalSystem` plans index into this. */
  signalJunctions: Junction[];
  rings: Ring[];
  portalsIn: Segment[];
  /** Spawn weight per entry of `portalsIn`. */
  portalWeights: number[];
  /** Per-map switch: vehicles pick an exit and steer towards it (`dests`/`distTo`); `false` = destination-less random walk (`dests`/`distTo` empty). */
  routeByDest: boolean;
  /** Per-map switch for the anti-gridlock nets (detour at the line, wait-cycle detector, stuck-head teleport). */
  safetyNets: boolean;
  /** Per-map switch for the OSM-only Saigon traffic rules: motorbike band admission at the exit mouth, box-first for junction↔link pairs, and forced entry at give-way lines (minor-approach gap acceptance shrinks with wait time, the major flow concedes the exit room). */
  saigonRules: boolean;
  /**
   * `exits ++ sinks`: a vehicle's `dest` indexes this list. `[0, nExits)` are the real exit links (`portalOut && !deadEnd`); `[nExits, length)`
   * are internal sink links, one per `links` entry with `tripWeights > 0` in `links` order (trip ends in the middle of the network).
   * Code that means "leave the map" must only draw from `[0, nExits)`. Empty on maps without `routeByDest`.
   */
  dests: Segment[];
  /** Number of real exits at the head of `dests`. */
  nExits: number;
  /** `destSeg[d] = dests[d].id` (O(1) per-step lookup). */
  destSeg: Int32Array;
  /** `distTo[d][seg]`: metres from the start of `seg` to the end of `dests[d]` over `next ∪ exitConns` (`Infinity` = unreachable). */
  distTo: Float32Array[];
  /**
   * Relative trip-end weight per entry of `links` (internal origins and sink destinations): link length × road-class factor, 0 on bridges,
   * links shorter than `TRIP_MIN_LEN`, or when the link JSON says so; `GraphLink.tripWeight` overrides. All 0 on maps without `routeByDest`.
   */
  tripWeights: Float32Array;
  busStops: { link: Segment; s: number }[];
  attribution: string;
  /** Non-fatal builder findings (forced dead ends, unsignalisable junctions …). */
  warnings: string[];
}

// ------------------------------------------------------------------ builder input

export interface GraphNode {
  key: string;
  kind: NodeKind;
  x: number;
  z: number;
  radius: number;
  name: string;
  signal: { green: [number, number]; offset: number; axis?: number } | null;
  /** Ring nodes: index into `NetGraph.rings`. */
  ring?: number;
  /** Keys of neighbouring nodes: the approach coming from them has no right turn on red. */
  noRightOnRedFrom?: string[];
}

export interface GraphLink {
  key: string;
  a: number;
  b: number;
  /** Centreline a → b, `[x0, z0, x1, z1, …]`, including both end points. */
  pts: number[];
  /** Lanes a → b and b → a; `lanesB = 0` means one-way a → b. */
  lanesF: number;
  lanesB: number;
  cls: RoadClass;
  isLink: boolean;
  name: string;
  maxspeed: number | null;
  bridge: boolean;
  median: number;
  /** Override of the trim at each end (distance from the node centre to the stop line). */
  trimA?: number;
  trimB?: number;
  /** Bus stops: `s` is the arc length along the directed link's own pts (before trimming). */
  busStops?: { dir: 0 | 1; s: number }[];
  /** Spawn weight override for the portal-in direction. */
  portalWeight?: number;
  /** Trip-end weight override (`Network.tripWeights`) for both directed links of this graph link; default = length × road-class factor. Ignored without `routeByDest`. */
  tripWeight?: number;
  /** Links sharing a road key form one `Road`; default `name|cls` (empty name → no road). */
  roadKey?: string;
}

export interface GraphRing {
  /** Closed loop in driving order (first point not repeated). */
  pts: number[];
  halfW: number;
  speed: number;
  name: string;
  /** `at` = vertex index in `pts`; dir 0: the link leaves the ring (a = ring), 1: it enters (b = ring). */
  arms: { at: number; link: number; dir: 0 | 1 }[];
}

export interface NetGraph {
  bounds: Bounds;
  nodes: GraphNode[];
  links: GraphLink[];
  rings: GraphRing[];
  attribution: string;
  /** Destination routing for this map; defaults to `true` (the OSM map). The small legacy map turns it off. */
  routeByDest?: boolean;
  /** Anti-gridlock nets for this map; defaults to `true` (the OSM map). The legacy map keeps its original behaviour. */
  safetyNets?: boolean;
  /** Saigon traffic rules (motorbike band admission, box-first at the exit mouth, forced entry at give-way lines) for this map; defaults to `true` (the OSM map). The legacy map keeps its original behaviour. */
  saigonRules?: boolean;
}

// ------------------------------------------------------------------ geometry helpers

const TAU = Math.PI * 2;

function wrapPi(a: number): number {
  return a - TAU * Math.round(a / TAU);
}

function dedupe(p: number[]): number[] {
  const out = [p[0], p[1]];
  for (let i = 2; i < p.length; i += 2) {
    if (Math.hypot(p[i] - out[out.length - 2], p[i + 1] - out[out.length - 1]) > 1e-4) out.push(p[i], p[i + 1]);
  }
  return out;
}

function polyLen(p: number[]): number {
  let l = 0;
  for (let i = 2; i < p.length; i += 2) l += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return l;
}

function reversed(p: number[]): number[] {
  const out: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i], p[i + 1]);
  return out;
}

/** Point at arc length s along a polyline (clamped), written to out[0..1]. */
function pointAt(p: number[], s: number, out: number[]): void {
  let acc = 0;
  for (let i = 2; i < p.length; i += 2) {
    const l = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    if (acc + l >= s || i === p.length - 2) {
      const u = l > 0 ? Math.min(1, Math.max(0, (s - acc) / l)) : 0;
      out[0] = p[i - 2] + (p[i] - p[i - 2]) * u;
      out[1] = p[i - 1] + (p[i + 1] - p[i - 1]) * u;
      return;
    }
    acc += l;
  }
  out[0] = p[0];
  out[1] = p[1];
}

/** Sub-polyline between arc lengths s0 and s1. */
function slice(p: number[], s0: number, s1: number): number[] {
  const out: number[] = [];
  const tmp = [0, 0];
  pointAt(p, s0, tmp);
  out.push(tmp[0], tmp[1]);
  let acc = 0;
  for (let i = 2; i < p.length - 2; i += 2) {
    acc += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    if (acc > s0 + 1e-6 && acc < s1 - 1e-6) out.push(p[i], p[i + 1]);
  }
  pointAt(p, s1, tmp);
  out.push(tmp[0], tmp[1]);
  return out;
}

/** Offset a polyline to the right of travel by `off` (miter, clamped to 2×). */
function offsetRight(p: number[], off: number): number[] {
  if (off === 0) return p;
  const m = p.length / 2;
  const nx = new Float64Array(m - 1);
  const nz = new Float64Array(m - 1);
  for (let i = 0; i < m - 1; i++) {
    const dx = p[i * 2 + 2] - p[i * 2];
    const dz = p[i * 2 + 3] - p[i * 2 + 1];
    const l = Math.hypot(dx, dz) || 1;
    nx[i] = -dz / l;
    nz[i] = dx / l;
  }
  const out: number[] = [];
  for (let i = 0; i < m; i++) {
    let ax: number;
    let az: number;
    if (i === 0) {
      ax = nx[0];
      az = nz[0];
    } else if (i === m - 1) {
      ax = nx[m - 2];
      az = nz[m - 2];
    } else {
      ax = nx[i - 1] + nx[i];
      az = nz[i - 1] + nz[i];
      const l = Math.hypot(ax, az);
      if (l < 1e-6) {
        ax = nx[i];
        az = nz[i];
      } else {
        ax /= l;
        az /= l;
        const k = Math.max(0.5, ax * nx[i] + az * nz[i]);
        ax /= k;
        az /= k;
      }
    }
    out.push(p[i * 2] + ax * off, p[i * 2 + 1] + az * off);
  }
  return out;
}

function cubic(
  x0: number,
  z0: number,
  t0x: number,
  t0z: number,
  x3: number,
  z3: number,
  t3x: number,
  t3z: number,
  k: number,
): number[] {
  const x1 = x0 + t0x * k;
  const z1 = z0 + t0z * k;
  const x2 = x3 - t3x * k;
  const z2 = z3 - t3z * k;
  const pts: number[] = [];
  const N = 40;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = (1 - t) ** 3;
    const b = 3 * (1 - t) ** 2 * t;
    const c = 3 * (1 - t) * t * t;
    const d = t ** 3;
    pts.push(a * x0 + b * x1 + c * x2 + d * x3, a * z0 + b * z1 + c * z2 + d * z3);
  }
  return pts;
}

/** Whether two sampled segments come within `r` of each other (ends of the shorter included). */
function polylinesWithin(a: Segment, b: Segment, r: number): boolean {
  let aMinX = Infinity;
  let aMaxX = -Infinity;
  let aMinZ = Infinity;
  let aMaxZ = -Infinity;
  for (let i = 0; i < a.n; i++) {
    aMinX = Math.min(aMinX, a.px[i]);
    aMaxX = Math.max(aMaxX, a.px[i]);
    aMinZ = Math.min(aMinZ, a.pz[i]);
    aMaxZ = Math.max(aMaxZ, a.pz[i]);
  }
  let bMinX = Infinity;
  let bMaxX = -Infinity;
  let bMinZ = Infinity;
  let bMaxZ = -Infinity;
  for (let i = 0; i < b.n; i++) {
    bMinX = Math.min(bMinX, b.px[i]);
    bMaxX = Math.max(bMaxX, b.px[i]);
    bMinZ = Math.min(bMinZ, b.pz[i]);
    bMaxZ = Math.max(bMaxZ, b.pz[i]);
  }
  if (aMinX > bMaxX + r || bMinX > aMaxX + r || aMinZ > bMaxZ + r || bMinZ > aMaxZ + r) return false;
  const r2 = r * r;
  for (let i = 0; i < a.n; i += 2) {
    for (let j = 0; j < b.n; j += 2) {
      const dx = a.px[i] - b.px[j];
      const dz = a.pz[i] - b.pz[j];
      if (dx * dx + dz * dz <= r2) return true;
    }
  }
  return false;
}

/** Arc range [lo, hi] on `b` of the samples within `r` of `a`; `[Infinity, -Infinity]` when none. */
function zoneOn(b: Segment, a: Segment, r: number, out: number[]): void {
  let lo = Infinity;
  let hi = -Infinity;
  const r2 = r * r;
  for (let j = 0; j < b.n; j++) {
    for (let i = 0; i < a.n; i++) {
      const dx = a.px[i] - b.px[j];
      const dz = a.pz[i] - b.pz[j];
      if (dx * dx + dz * dz <= r2) {
        const s = j * b.step;
        if (s < lo) lo = s;
        if (s > hi) hi = s;
        break;
      }
    }
  }
  out.push(lo, hi);
}

// ------------------------------------------------------------------ builder

const SPEED_BY_CLASS_FAST = 12.5;
const SPEED_BY_CLASS_SLOW = 10;
const BRIDGE_SPEED = 13.5;
/** Distance along a link used to measure the arm direction. */
const ARM_PROBE = 15;
const RING_EVENT_OFFSET = 1.5;
/** Smallest ring arc between two entry/exit points. */
const RING_MIN_ARC = 2;
const CONFLICT_DIST = 1.5;
const MIN_SEG = 0.5;

/** Portal spawn weight by road class (× lanes). */
const PORTAL_CLASS_WEIGHT: Record<number, number> = {
  [RoadClass.Trunk]: 1,
  [RoadClass.Primary]: 1,
  [RoadClass.Secondary]: 0.8,
  [RoadClass.Tertiary]: 0.6,
  [RoadClass.Residential]: 0.3,
  [RoadClass.Unclassified]: 0.3,
};

/** Trip-end (internal origin / sink destination) weight factor by road class, × link length. Arterials generate fewer stops per metre than side streets. */
const CLASS_TRIP: Record<number, number> = {
  [RoadClass.Trunk]: 0.5,
  [RoadClass.Primary]: 0.8,
  [RoadClass.Secondary]: 1,
  [RoadClass.Tertiary]: 1,
  [RoadClass.Residential]: 1,
  [RoadClass.Unclassified]: 0.7,
};
/** Links shorter than this (m) never carry a trip end: an arriving vehicle needs room to pull over. */
const TRIP_MIN_LEN = 25;

interface ArmRec {
  arm: Arm;
  link: number;
  /** 0 = the a end of the graph link, 1 = the b end. */
  end: 0 | 1;
  trim: number;
}

export function buildNetwork(g: NetGraph): Network {
  const warnings: string[] = [];
  const segments: Segment[] = [];
  const newSeg = (kind: SegKind, pts: number[]): Segment => {
    const s = new Segment(segments.length, kind, pts);
    segments.push(s);
    return s;
  };

  // ---- junctions
  const junctions: Junction[] = g.nodes.map((n, id) => ({
    id,
    key: n.key,
    name: n.name,
    kind: n.kind,
    x: n.x,
    z: n.z,
    radius: n.radius,
    arms: [],
    signal: null,
    majorArms: [],
    ring: n.kind === 'ring' ? (n.ring ?? -1) : -1,
  }));

  // ---- centrelines and arms (one per link end)
  const centre: number[][] = g.links.map((l) => dedupe(l.pts));
  const centreLen = centre.map(polyLen);
  const armRecs: ArmRec[][] = junctions.map(() => []);
  const tmp2 = [0, 0];
  const tmp2b = [0, 0];
  g.links.forEach((l, li) => {
    for (const end of [0, 1] as const) {
      const nodeIdx = end === 0 ? l.a : l.b;
      const line = end === 0 ? centre[li] : reversed(centre[li]);
      pointAt(line, 0, tmp2);
      pointAt(line, Math.min(ARM_PROBE, centreLen[li]), tmp2b);
      const dx = tmp2b[0] - tmp2[0];
      const dz = tmp2b[1] - tmp2[1];
      const d = Math.hypot(dx, dz) || 1;
      const j = junctions[nodeIdx];
      const arm: Arm = {
        junction: j,
        angle: Math.atan2(dz, dx),
        ox: dx / d,
        oz: dz / d,
        inLink: null,
        outLink: null,
        roadHalf: ((l.lanesF + l.lanesB) * LANE_W) / 2 + l.median / 2,
        rank: l.cls + (l.isLink ? 0.5 : 0),
        trim: 0,
        stopX: 0,
        stopZ: 0,
        name: l.name,
      };
      armRecs[nodeIdx].push({ arm, link: li, end, trim: 0 });
    }
  });

  // ---- trims (distance from the node centre to the stop line)
  const ringHalfW = (j: Junction): number => (j.ring >= 0 ? g.rings[j.ring].halfW : 0);
  armRecs.forEach((recs, nodeIdx) => {
    const j = junctions[nodeIdx];
    for (const rec of recs) {
      const l = g.links[rec.link];
      const override = rec.end === 0 ? l.trimA : l.trimB;
      if (override !== undefined) rec.trim = override;
      else if (j.kind === 'portal' || j.kind === 'dead') rec.trim = 0;
      else if (j.kind === 'ring') rec.trim = ringHalfW(j) + 2;
      else {
        let m = 0;
        for (const o of recs) if (o !== rec) m = Math.max(m, o.arm.roadHalf);
        rec.trim = m + 2.5;
      }
    }
  });
  // A link must keep some length between its two stop lines.
  const trimOf = (li: number): [number, number] => {
    const l = g.links[li];
    let t0 = (armRecs[l.a].find((r) => r.link === li && r.end === 0) as ArmRec).trim;
    let t1 = (armRecs[l.b].find((r) => r.link === li && r.end === 1) as ArmRec).trim;
    const avail = Math.max(0, centreLen[li] - 1);
    if (t0 + t1 > avail) {
      const k = avail / (t0 + t1);
      t0 *= k;
      t1 *= k;
    }
    return [t0, t1];
  };
  const trims = g.links.map((_, li) => trimOf(li));
  for (const recs of armRecs) {
    for (const rec of recs) {
      const [t0, t1] = trims[rec.link];
      rec.arm.trim = rec.end === 0 ? t0 : t1;
      const line = rec.end === 0 ? centre[rec.link] : reversed(centre[rec.link]);
      pointAt(line, rec.arm.trim, tmp2);
      rec.arm.stopX = tmp2[0];
      rec.arm.stopZ = tmp2[1];
    }
  }

  // ---- directed links
  const links: Segment[] = [];
  const fwd: Segment[] = [];
  const back: (Segment | null)[] = [];
  /** Graph link index of each entry of `links`. */
  const linkGraph: number[] = [];
  const roadIndex = new Map<string, Road>();
  const roads: Road[] = [];
  g.links.forEach((l, li) => {
    const [t0, t1] = trims[li];
    const L = centreLen[li];
    const key = l.roadKey ?? (l.name ? `${l.name}|${l.cls}` : '');
    let road: Road | null = null;
    if (key) {
      road = roadIndex.get(key) ?? null;
      if (!road) {
        road = { id: roads.length, name: l.name, cls: l.cls, bridge: true, links: [], length: 0 };
        roadIndex.set(key, road);
        roads.push(road);
      }
      road.length += L;
      if (!l.bridge) road.bridge = false;
    }
    const twoWay = l.lanesB > 0;
    const speed = l.bridge
      ? BRIDGE_SPEED
      : Math.min(l.cls <= RoadClass.Tertiary ? SPEED_BY_CLASS_FAST : SPEED_BY_CLASS_SLOW, l.maxspeed !== null ? l.maxspeed / 3.6 : Infinity);
    const make = (forward: boolean): Segment => {
      const lanes = forward ? l.lanesF : l.lanesB;
      const refOffset = twoWay ? (lanes * LANE_W) / 2 + l.median / 2 : 0;
      const base = forward ? slice(centre[li], t0, L - t1) : slice(reversed(centre[li]), t1, L - t0);
      const seg = newSeg(SegKind.Link, offsetRight(base, refOffset));
      seg.setLanes(lanes);
      seg.oneway = !twoWay;
      seg.refOffset = refOffset;
      seg.roadHalf = ((l.lanesF + l.lanesB) * LANE_W) / 2 + l.median / 2;
      seg.median = l.median;
      seg.cls = l.cls;
      seg.bridge = l.bridge;
      seg.name = l.name;
      seg.speedLimit = speed;
      seg.road = road;
      seg.from = junctions[forward ? l.a : l.b];
      seg.to = junctions[forward ? l.b : l.a];
      const fk = seg.from.kind;
      const tk = seg.to.kind;
      seg.portalIn = fk === 'portal' || fk === 'dead';
      seg.portalOut = tk === 'portal' || tk === 'dead';
      seg.deadEnd = tk === 'dead';
      links.push(seg);
      linkGraph.push(li);
      road?.links.push(seg);
      return seg;
    };
    fwd.push(make(true));
    back.push(twoWay ? make(false) : null);
  });

  // Attach links to the arms.
  for (const recs of armRecs) {
    for (const rec of recs) {
      const f = fwd[rec.link];
      const b = back[rec.link];
      if (rec.end === 0) {
        rec.arm.outLink = f;
        rec.arm.inLink = b;
      } else {
        rec.arm.inLink = f;
        rec.arm.outLink = b;
      }
    }
  }
  // Arms sorted by angle (ties by link index) — and the matching record order.
  armRecs.forEach((recs, nodeIdx) => {
    recs.sort((p, q) => p.arm.angle - q.arm.angle || p.link - q.link || p.end - q.end);
    junctions[nodeIdx].arms = recs.map((r) => r.arm);
  });

  // ---- major arms, signal groups
  const majorOf = (j: Junction): number[] => {
    const arms = j.arms;
    if (arms.length === 0) return [];
    let best = 0;
    for (let i = 1; i < arms.length; i++) if (arms[i].rank < arms[best].rank) best = i;
    let pi = -1;
    let pj = -1;
    let score = Infinity;
    for (let i = 0; i < arms.length; i++) {
      for (let k = i + 1; k < arms.length; k++) {
        const dev = Math.PI - Math.abs(wrapPi(arms[i].angle - arms[k].angle));
        if (dev > (40 * Math.PI) / 180) continue;
        const sc = arms[i].rank + arms[k].rank;
        if (sc < score) {
          score = sc;
          pi = i;
          pj = k;
        }
      }
    }
    if (pi < 0 || arms[best].rank + 2 <= Math.min(arms[pi].rank, arms[pj].rank)) return [best];
    // Dual carriageways: the other direction of the same road sits at almost the same angle.
    const out = [pi, pj];
    const maxRank = Math.max(arms[pi].rank, arms[pj].rank);
    const lim = (30 * Math.PI) / 180;
    for (let k = 0; k < arms.length; k++) {
      if (k === pi || k === pj || arms[k].rank > maxRank) continue;
      if (Math.abs(wrapPi(arms[k].angle - arms[pi].angle)) <= lim || Math.abs(wrapPi(arms[k].angle - arms[pj].angle)) <= lim) out.push(k);
    }
    return out.sort((p, q) => p - q);
  };

  /** Mirrors `signalAxis` in scripts/osm/lib/signals.ts: the phase axis must leave both groups an inbound arm; otherwise the nearest turned axis that does and keeps `AXIS_MARGIN` to every inbound arm. */
  const signalAxis = (arms: Arm[], base: number): number => {
    const groupOf = (angle: number, axis: number): number => {
      const x = (((angle - axis + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI;
      return Math.abs(x - Math.PI / 2) < Math.PI / 4 ? 0 : 1;
    };
    const both = (axis: number): boolean => {
      let n0 = 0;
      let n1 = 0;
      for (const a of arms) if (a.inLink) (groupOf(a.angle, axis) === 0 ? n0++ : n1++);
      return n0 > 0 && n1 > 0;
    };
    const margin = (angle: number, axis: number): number => {
      const x = (((angle - axis + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI;
      return Math.abs(Math.abs(x - Math.PI / 2) - Math.PI / 4);
    };
    if (both(base)) return base;
    const AXIS_SHIFT_MAX = (45 * Math.PI) / 180;
    const AXIS_SHIFT_STEP = Math.PI / 180;
    const AXIS_MARGIN = (5 * Math.PI) / 180;
    for (let k = 1; k * AXIS_SHIFT_STEP <= AXIS_SHIFT_MAX + 1e-9; k++) {
      for (const sign of [1, -1]) {
        const a = base + sign * k * AXIS_SHIFT_STEP;
        const axis = Math.atan2(Math.sin(a), Math.cos(a));
        if (both(axis) && arms.every((arm) => !arm.inLink || margin(arm.angle, axis) >= AXIS_MARGIN)) return axis;
      }
    }
    return base;
  };

  const signalJunctions: Junction[] = [];
  junctions.forEach((j, idx) => {
    j.majorArms = j.kind === 'junction' || j.kind === 'join' ? majorOf(j) : [];
    const sp = g.nodes[idx].signal;
    if (!sp) return;
    if (j.kind !== 'junction' || j.arms.length < 3) {
      warnings.push(`signal at ${j.key} ignored: ${j.kind} with ${j.arms.length} arms`);
      return;
    }
    const major = j.majorArms;
    let axis: number;
    if (sp.axis !== undefined) axis = sp.axis;
    else if (major.length >= 2) {
      const a = j.arms[major[0]].angle;
      const b = j.arms[major[1]].angle + Math.PI;
      axis = Math.atan2(Math.sin(a) + Math.sin(b), Math.cos(a) + Math.cos(b));
    } else axis = j.arms[major[0]].angle;
    axis = signalAxis(j.arms, axis);
    const groups = j.arms.map((arm) => {
      const d = (((arm.angle - axis + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI;
      return Math.abs(d - Math.PI / 2) < Math.PI / 4 ? 0 : 1;
    });
    const has = [false, false];
    j.arms.forEach((arm, k) => {
      if (arm.inLink) has[groups[k]] = true;
    });
    if (!has[0] || !has[1]) {
      warnings.push(`signal at ${j.key} ignored: an approach group is empty`);
      return;
    }
    const plan: SignalPlan = {
      index: signalJunctions.length,
      green: [sp.green[0], sp.green[1]],
      offset: sp.offset,
      cycle: sp.green[0] + sp.green[1] + 2 * (AMBER + ALL_RED),
      axis,
    };
    j.signal = plan;
    signalJunctions.push(j);
    j.arms.forEach((arm, k) => {
      if (arm.inLink) arm.inLink.signal = { nodeIndex: plan.index, group: groups[k], approach: k };
    });
  });

  // No right turn on red.
  junctions.forEach((j, idx) => {
    const list = g.nodes[idx].noRightOnRedFrom;
    if (!list) return;
    for (const arm of j.arms) {
      if (!arm.inLink) continue;
      const other = arm.inLink.from;
      if (other && list.includes(other.key)) arm.inLink.noRightOnRed = true;
    }
  });

  // ---- connectors
  const DEG150 = (150 * Math.PI) / 180;
  const DEG30 = (30 * Math.PI) / 180;
  for (const j of junctions) {
    if (j.kind !== 'junction' && j.kind !== 'join') continue;
    const unsignalised = j.signal === null && j.kind === 'junction' && j.arms.length >= 3;
    const major = new Set(j.majorArms);
    // Priority only exists when major traffic actually arrives at the junction.
    const priorityOn = unsignalised && j.majorArms.some((k) => j.arms[k].inLink !== null);
    const conns: { conn: Segment; major: boolean }[] = [];
    j.arms.forEach((armA, ia) => {
      const inL = armA.inLink;
      if (!inL) return;
      const isMajor = major.has(ia);
      if (priorityOn && !isMajor) inL.yieldAt = j;
      const x0 = inL.px[inL.n - 1];
      const z0 = inL.pz[inL.n - 1];
      const inDx = inL.tx[inL.n - 1];
      const inDz = inL.tz[inL.n - 1];
      for (const armB of j.arms) {
        const outL = armB.outLink;
        if (armB === armA || !outL) continue;
        const outDx = outL.tx[0];
        const outDz = outL.tz[0];
        const theta = Math.atan2(inDx * outDz - inDz * outDx, inDx * outDx + inDz * outDz);
        if (Math.abs(theta) > DEG150) continue;
        const turn: Turn = Math.abs(theta) <= DEG30 ? Turn.Straight : theta > 0 ? Turn.Right : Turn.Left;
        const x3 = outL.px[0];
        const z3 = outL.pz[0];
        const d = Math.hypot(x3 - x0, z3 - z0);
        const conn = newSeg(SegKind.Conn, cubic(x0, z0, inDx, inDz, x3, z3, outDx, outDz, d * (turn === Turn.Straight ? 0.3 : 0.45)));
        conn.turn = turn;
        conn.name = j.name;
        conn.junction = j;
        conn.fromLink = inL;
        conn.cls = outL.cls;
        conn.setLanes(1);
        conn.halfW = Math.max(inL.halfW, outL.halfW);
        conn.speedLimit = Math.max(6, 12 * (1 - 0.5 * Math.min(1, Math.abs(theta) / (Math.PI / 2))));
        conn.priority = priorityOn ? (isMajor ? 2 : 1) : 0;
        conn.next = [outL];
        inL.next.push(conn);
        conns.push({ conn, major: isMajor });
      }
    });
    if (priorityOn) {
      const majors = conns.filter((c) => c.major).map((c) => c.conn);
      for (const c of conns) {
        if (c.major) continue;
        for (const m of majors) {
          if (!polylinesWithin(c.conn, m, CONFLICT_DIST)) continue;
          c.conn.conflicts.push(m);
          zoneOn(m, c.conn, CONFLICT_DIST + 1, c.conn.conflictZone);
          const zn = c.conn.conflictZone.length;
          m.crossedBy.push(c.conn.conflictZone[zn - 2], c.conn.conflictZone[zn - 1], c.conn.id);
        }
        const seen = new Set<number>();
        for (const m of c.conn.conflicts) {
          if (!m.fromLink || seen.has(m.fromLink.id)) continue;
          seen.add(m.fromLink.id);
          c.conn.conflictLinks.push(m.fromLink);
        }
      }
    }
  }

  // ---- rings
  const rings: Ring[] = [];
  g.rings.forEach((gr, ri) => {
    const node = junctions.find((j) => j.kind === 'ring' && j.ring === ri);
    if (!node) throw new Error(`ring ${ri}: no ring node`);
    const recs = armRecs[node.id];
    const P = gr.pts;
    const m = P.length / 2;
    const cum = new Float64Array(m + 1);
    for (let k = 1; k <= m; k++) {
      const a = k - 1;
      const b = k % m;
      cum[k] = cum[k - 1] + Math.hypot(P[b * 2] - P[a * 2], P[b * 2 + 1] - P[a * 2 + 1]);
    }
    const perim = cum[m];
    let cx = 0;
    let cz = 0;
    for (let k = 0; k < m; k++) {
      cx += P[k * 2];
      cz += P[k * 2 + 1];
    }
    cx /= m;
    cz /= m;
    let rr = 0;
    for (let k = 0; k < m; k++) rr += Math.hypot(P[k * 2] - cx, P[k * 2 + 1] - cz);
    rr /= m;

    // Ring arms: one per link end touching the ring, ordered by vertex.
    interface RA {
      rec: ArmRec;
      at: number;
    }
    const ras: RA[] = [];
    for (const rec of recs) {
      const spec = gr.arms.find((a) => a.link === rec.link && a.dir === (rec.end === 0 ? 0 : 1));
      if (!spec) {
        warnings.push(`ring ${ri}: link ${g.links[rec.link].key} touches the ring but has no arm`);
        continue;
      }
      ras.push({ rec, at: spec.at });
    }
    ras.sort((p, q) => p.at - q.at || p.rec.link - q.rec.link);
    const ringArms: RingArm[] = ras.map(({ rec }) => {
      const road = (rec.arm.inLink ?? rec.arm.outLink)?.road ?? null;
      return {
        angle: rec.arm.angle,
        inLink: rec.arm.inLink,
        outLink: rec.arm.outLink,
        entry: null,
        exit: null,
        road,
        name: road?.name ?? rec.arm.name,
      };
    });

    interface Ev {
      s: number;
      kind: 'exit' | 'entry';
      arm: number;
    }
    const evs: Ev[] = [];
    ras.forEach((ra, k) => {
      const s0 = cum[ra.at % m];
      if (ringArms[k].outLink) evs.push({ s: (((s0 - RING_EVENT_OFFSET) % perim) + perim) % perim, kind: 'exit', arm: k });
      if (ringArms[k].inLink) evs.push({ s: (s0 + RING_EVENT_OFFSET) % perim, kind: 'entry', arm: k });
    });
    evs.sort((p, q) => p.s - q.s || (p.kind === q.kind ? p.arm - q.arm : p.kind === 'exit' ? -1 : 1));
    // Arms that share a vertex would put events on top of each other: keep arcs a few metres long.
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < evs.length; i++) {
        const nxt = (i + 1) % evs.length;
        const gap = evs[nxt].s + (nxt === 0 ? perim : 0) - evs[i].s;
        if (gap < RING_MIN_ARC && evs.length * RING_MIN_ARC < perim) {
          evs[nxt].s = (evs[nxt].s + RING_MIN_ARC - gap) % perim;
        }
      }
      evs.sort((p, q) => p.s - q.s || (p.kind === q.kind ? p.arm - q.arm : p.kind === 'exit' ? -1 : 1));
    }
    if (evs.length < 2 || !evs.some((e) => e.kind === 'exit') || !evs.some((e) => e.kind === 'entry')) {
      throw new Error(`ring ${ri} (${gr.name}) needs at least one entry and one exit`);
    }

    // Unrolled loop for slicing arcs (two laps).
    const two: number[] = [];
    const cum2: number[] = [];
    for (let lap = 0; lap < 2; lap++) {
      for (let k = 0; k < m; k++) {
        two.push(P[k * 2], P[k * 2 + 1]);
        cum2.push(cum[k] + lap * perim);
      }
    }
    two.push(P[0], P[1]);
    cum2.push(2 * perim);
    const at = (s: number, out: number[]): void => {
      for (let k = 1; k < cum2.length; k++) {
        if (cum2[k] >= s || k === cum2.length - 1) {
          const l = cum2[k] - cum2[k - 1];
          const u = l > 0 ? Math.min(1, Math.max(0, (s - cum2[k - 1]) / l)) : 0;
          out[0] = two[k * 2 - 2] + (two[k * 2] - two[k * 2 - 2]) * u;
          out[1] = two[k * 2 - 1] + (two[k * 2 + 1] - two[k * 2 - 1]) * u;
          return;
        }
      }
    };
    const arcs: Segment[] = [];
    for (let i = 0; i < evs.length; i++) {
      const s0 = evs[i].s;
      let s1 = evs[(i + 1) % evs.length].s;
      if (s1 <= s0) s1 += perim;
      const pts: number[] = [];
      at(s0, tmp2);
      pts.push(tmp2[0], tmp2[1]);
      for (let k = 0; k < cum2.length; k++) {
        if (cum2[k] > s0 + 1e-6 && cum2[k] < s1 - 1e-6) pts.push(two[k * 2], two[k * 2 + 1]);
      }
      at(s1, tmp2);
      pts.push(tmp2[0], tmp2[1]);
      const arc = newSeg(SegKind.Ring, pts);
      arc.name = gr.name;
      arc.priority = 2;
      arc.setLanes(1);
      arc.halfW = gr.halfW;
      arc.speedLimit = gr.speed;
      arc.ring = ri;
      arc.from = node;
      arc.to = node;
      arcs.push(arc);
    }
    arcs.forEach((arc, i) => (arc.next = [arcs[(i + 1) % arcs.length]]));

    const merges: RingMerge[] = [];
    evs.forEach((ev, i) => {
      const endingArc = arcs[(i - 1 + arcs.length) % arcs.length];
      const startingArc = arcs[i];
      const arm = ringArms[ev.arm];
      if (ev.kind === 'exit') {
        const outL = arm.outLink as Segment;
        const x0 = endingArc.px[endingArc.n - 1];
        const z0 = endingArc.pz[endingArc.n - 1];
        const d = Math.hypot(outL.px[0] - x0, outL.pz[0] - z0);
        const exit = newSeg(
          SegKind.Conn,
          cubic(x0, z0, endingArc.tx[endingArc.n - 1], endingArc.tz[endingArc.n - 1], outL.px[0], outL.pz[0], outL.tx[0], outL.tz[0], d * 0.45),
        );
        exit.name = gr.name;
        exit.priority = 2;
        exit.setLanes(1);
        exit.halfW = Math.max(outL.halfW, gr.halfW - 1);
        exit.turn = Turn.Right;
        exit.speedLimit = gr.speed;
        exit.cls = outL.cls;
        exit.ring = ri;
        exit.junction = node;
        exit.next = [outL];
        endingArc.ringExitArm = ev.arm;
        endingArc.exitConns = [exit];
        arm.exit = exit;
      } else {
        const inL = arm.inLink as Segment;
        const x0 = inL.px[inL.n - 1];
        const z0 = inL.pz[inL.n - 1];
        const x3 = startingArc.px[0];
        const z3 = startingArc.pz[0];
        const d = Math.hypot(x3 - x0, z3 - z0);
        const entry = newSeg(
          SegKind.Conn,
          cubic(x0, z0, inL.tx[inL.n - 1], inL.tz[inL.n - 1], x3, z3, startingArc.tx[0], startingArc.tz[0], d * 0.45),
        );
        entry.name = gr.name;
        entry.priority = 1;
        entry.setLanes(1);
        entry.halfW = Math.max(inL.halfW, gr.halfW - 1);
        entry.turn = Turn.Right;
        entry.speedLimit = Math.min(7, gr.speed);
        entry.cls = inL.cls;
        entry.ring = ri;
        entry.junction = node;
        entry.ringEntryArm = ev.arm;
        entry.next = [startingArc];
        const prevArc = arcs[(i - 2 + arcs.length * 2) % arcs.length];
        const merge: RingMerge = {
          x: x3,
          z: z3,
          upstream: [
            { seg: endingArc, extra: 0 },
            { seg: prevArc, extra: endingArc.length },
          ],
        };
        entry.merge = merge;
        merges.push(merge);
        inL.next = [entry];
        arm.entry = entry;
      }
    });
    // Arcs that end at an exit point may continue or leave.
    for (const arc of arcs) if (arc.ringExitArm >= 0) arc.next = [arc.next[0], ...arc.exitConns];

    const exits: number[] = [];
    ringArms.forEach((a, k) => {
      if (a.outLink) exits.push(k);
    });
    rings.push({ id: ri, name: gr.name, cx, cz, r: rr, halfW: gr.halfW, arms: ringArms, exits, arcs, merges });
  });

  // ---- dead ends: a link that leads nowhere becomes a portal out
  for (const l of links) {
    if (l.next.length > 0 || l.portalOut) continue;
    l.portalOut = true;
    l.deadEnd = true;
    warnings.push(`link ${l.id} (${l.name || l.from?.key}) forced to a dead end at ${l.to?.key}`);
  }

  // ---- bus stops
  const busStops: { link: Segment; s: number }[] = [];
  g.links.forEach((l, li) => {
    for (const st of l.busStops ?? []) {
      const seg = st.dir === 0 ? fwd[li] : back[li];
      if (!seg) continue;
      const [t0, t1] = trims[li];
      const start = st.dir === 0 ? t0 : t1;
      const s = st.s - start;
      if (s < 2 || s > seg.length - 2) continue;
      seg.busStopS = s;
      busStops.push({ link: seg, s });
    }
  });

  // ---- portals
  const portalsIn: Segment[] = [];
  const portalWeights: number[] = [];
  links.forEach((l, k) => {
    if (!l.portalIn) return;
    const gl = g.links[linkGraph[k]];
    let w = gl.portalWeight ?? (PORTAL_CLASS_WEIGHT[gl.cls] ?? 0.3) * l.lanes;
    if (gl.portalWeight === undefined && l.from?.kind === 'dead') w *= 0.1;
    portalsIn.push(l);
    portalWeights.push(w);
  });

  // ---- invariants
  for (const sg of segments) {
    if (!(sg.length >= MIN_SEG)) throw new Error(`segment ${sg.id} (${sg.name}) is ${sg.length} m long`);
    for (let i = 0; i < sg.n; i++) {
      if (!Number.isFinite(sg.px[i] + sg.pz[i] + sg.tx[i] + sg.tz[i])) throw new Error(`segment ${sg.id} (${sg.name}) has NaN geometry`);
    }
  }
  for (const l of links) {
    if (l.next.length === 0 && !l.portalOut) throw new Error(`link ${l.id} (${l.name}) has no exit`);
  }
  for (const j of signalJunctions) {
    const groups = [false, false];
    for (const arm of j.arms) if (arm.inLink?.signal) groups[arm.inLink.signal.group] = true;
    if (!groups[0] || !groups[1]) throw new Error(`signal junction ${j.key} lacks an approach group`);
  }

  // ---- trip ends (internal origins / sinks)
  const routeByDest = g.routeByDest ?? true;
  const tripWeights = new Float32Array(links.length);
  if (routeByDest) {
    links.forEach((l, k) => {
      const gl = g.links[linkGraph[k]];
      if (gl.tripWeight !== undefined) tripWeights[k] = gl.tripWeight;
      else if (!l.bridge && l.length >= TRIP_MIN_LEN) tripWeights[k] = l.length * (CLASS_TRIP[l.cls] ?? 1);
    });
  }
  const sinks = links.filter((_, k) => tripWeights[k] > 0);

  const routing = routeByDest ? buildRouting(segments, portalsIn, sinks) : { dests: [], nExits: 0, destSeg: new Int32Array(0), distTo: [], warnings: [] };
  warnings.push(...routing.warnings);

  return {
    bounds: g.bounds,
    roads,
    segments,
    links,
    junctions,
    signalJunctions,
    rings,
    portalsIn,
    portalWeights,
    routeByDest,
    safetyNets: g.safetyNets ?? true,
    saigonRules: g.saigonRules ?? true,
    dests: routing.dests,
    nExits: routing.nExits,
    destSeg: routing.destSeg,
    distTo: routing.distTo,
    tripWeights,
    busStops,
    attribution: g.attribution,
    warnings,
  };
}
