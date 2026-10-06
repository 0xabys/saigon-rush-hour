// Road network for a stylised District 1. All geometry is in world units (≈ metres),
// x = east, z = south, y = up. Vietnam drives on the right: for a travel direction d,
// the right-hand side is (-d.z, d.x).

export const MEDIAN = 0.8;
/** Width of one direction's carriageway. */
export const CARRIAGE = 7;
/** Centreline to curb. */
export const ROAD_HALF = MEDIAN / 2 + CARRIAGE;
export const SIDEWALK = 3.6;
/** Lateral offset of each direction's reference line from the road centreline. */
export const REF_OFFSET = MEDIAN / 2 + CARRIAGE / 2;
/** Car lane centres relative to the reference line: [inner/left, outer/right]. */
export const LANES = [-1.6, 1.6] as const;
/** Half size of a signalised junction box. */
export const BOX_HALF = ROAD_HALF + 1;
/** Distance from junction centre to the stop line. */
export const STOP_TRIM = BOX_HALF + 4;
export const RING_CENTER = { x: -120, z: 0 };
export const RING_REF_R = 18;
export const RING_INNER = 12;
export const RING_OUTER = 24;
export const RING_ARM_TRIM = 31;
const RING_DELTA = 0.3;

export const WORLD = { minX: -215, maxX: 290, minZ: -170, maxZ: 170 };
export const RIVER = { x0: 150, x1: 200 };

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

export type NodeKind = 'signal' | 'portal' | 'ring';

export interface MapNode {
  id: number;
  key: string;
  name: string;
  x: number;
  z: number;
  kind: NodeKind;
  arms: Arm[];
}

export interface Road {
  id: number;
  name: string;
  a: MapNode;
  b: MapNode;
  bridge: boolean;
  /** Unit direction a → b and length. */
  dx: number;
  dz: number;
  length: number;
  /** Distance trimmed off at each end for junction boxes. */
  trimA: number;
  trimB: number;
}

export interface Arm {
  node: MapNode;
  road: Road;
  /** Unit vector pointing away from the node along the road. */
  ox: number;
  oz: number;
  angle: number;
  /** Link travelling toward the node. */
  inLink: Segment;
  /** Link travelling away from the node. */
  outLink: Segment;
  trim: number;
}

export interface RingMerge {
  x: number;
  z: number;
  /** Ring segments upstream of the merge with the extra distance from their end to the merge point. */
  upstream: { seg: Segment; extra: number }[];
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
  halfW = CARRIAGE / 2;
  next: Segment[] = [];
  name = '';
  speedLimit = 12.5;
  /** 0 normal, 1 must yield (ring entry), 2 has priority (ring + ring exits). */
  priority = 0;
  turn: Turn = Turn.Straight;
  road: Road | null = null;
  from: MapNode | null = null;
  to: MapNode | null = null;
  portalIn = false;
  portalOut = false;
  /** Signal controlling the end of this link. */
  signal: SignalRef | null = null;
  /** For connectors leaving a signalised link: the link they came from. */
  fromLink: Segment | null = null;
  noRightOnRed = false;
  busStopS = -1;
  merge: RingMerge | null = null;
  /** Ring arc ending at the exit point of this arm index (−1 otherwise). */
  ringExitArm = -1;
  /** Ring entry connector: arm index it enters from. */
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

export interface SignalRef {
  nodeIndex: number;
  group: number;
  approach: number;
}

export interface Network {
  nodes: MapNode[];
  roads: Road[];
  segments: Segment[];
  links: Segment[];
  portalsIn: Segment[];
  signalNodes: MapNode[];
  ring: { center: { x: number; z: number }; arms: Arm[]; merges: RingMerge[] };
  busStops: { link: Segment; s: number }[];
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

export function buildNetwork(): Network {
  const nodes: MapNode[] = [];
  const roads: Road[] = [];
  const segments: Segment[] = [];

  const node = (key: string, name: string, x: number, z: number, kind: NodeKind): MapNode => {
    const n: MapNode = { id: nodes.length, key, name, x, z, kind, arms: [] };
    nodes.push(n);
    return n;
  };

  const RB = node('RB', 'Vòng xoay Bến Thành', RING_CENTER.x, RING_CENTER.z, 'ring');
  const BN = node('BN', 'Giao lộ Pasteur – Lý Tự Trọng', -40, -70, 'signal');
  const BM = node('BM', 'Giao lộ Lê Lợi – Pasteur', -40, 0, 'signal');
  const BS = node('BS', 'Giao lộ Pasteur – Hàm Nghi', -40, 70, 'signal');
  const CN = node('CN', 'Giao lộ Đồng Khởi – Lý Tự Trọng', 40, -70, 'signal');
  const CS = node('CS', 'Giao lộ Đồng Khởi – Hàm Nghi', 40, 70, 'signal');
  const DN = node('DN', 'Chân cầu Ba Son', 115, -70, 'signal');
  const pW = node('pW', '', WORLD.minX, 0, 'portal');
  const pRN = node('pRN', '', -120, WORLD.minZ, 'portal');
  const pRS = node('pRS', '', -120, WORLD.maxZ, 'portal');
  const pBN = node('pBN', '', -40, WORLD.minZ, 'portal');
  const pBS = node('pBS', '', -40, WORLD.maxZ, 'portal');
  const pCN = node('pCN', '', 40, WORLD.minZ, 'portal');
  const pCS = node('pCS', '', 40, WORLD.maxZ, 'portal');
  const pDN = node('pDN', '', 115, WORLD.minZ, 'portal');
  const pDS = node('pDS', '', 115, WORLD.maxZ, 'portal');
  const pE = node('pE', '', WORLD.maxX, -70, 'portal');

  const trimFor = (n: MapNode, other: MapNode): number => {
    if (n.kind === 'portal') return 0;
    if (n.kind === 'ring') return RING_ARM_TRIM;
    const dx = Math.abs(other.x - n.x);
    const dz = Math.abs(other.z - n.z);
    // Diagonal approaches need extra room so they don't overlap the orthogonal arms.
    return Math.min(dx, dz) > 1 ? STOP_TRIM + 4 : STOP_TRIM;
  };

  const road = (name: string, a: MapNode, b: MapNode, bridge = false): Road => {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    const r: Road = {
      id: roads.length,
      name,
      a,
      b,
      bridge,
      dx: dx / length,
      dz: dz / length,
      length,
      trimA: trimFor(a, b),
      trimB: trimFor(b, a),
    };
    roads.push(r);
    return r;
  };

  road('Lê Lai', RB, pW);
  road('Cách Mạng Tháng Tám', RB, pRN);
  road('Trần Hưng Đạo', RB, pRS);
  road('Lê Lợi', RB, BM);
  road('Lê Thánh Tôn', RB, BN);
  road('Hàm Nghi', RB, BS);
  road('Pasteur', pBN, BN);
  road('Pasteur', BN, BM);
  road('Pasteur', BM, BS);
  road('Pasteur', BS, pBS);
  road('Lý Tự Trọng', BN, CN);
  road('Lý Tự Trọng', CN, DN);
  road('Cầu Ba Son', DN, pE, true);
  road('Hàm Nghi', BS, CS);
  road('Đồng Khởi', pCN, CN);
  road('Đồng Khởi', CN, CS);
  road('Đồng Khởi', CS, pCS);
  road('Tôn Đức Thắng', pDN, DN);
  road('Tôn Đức Thắng', DN, pDS);

  const newSeg = (kind: SegKind, pts: number[]): Segment => {
    const s = new Segment(segments.length, kind, pts);
    segments.push(s);
    return s;
  };

  const links: Segment[] = [];
  const makeLink = (r: Road, forward: boolean): Segment => {
    const from = forward ? r.a : r.b;
    const to = forward ? r.b : r.a;
    const dx = forward ? r.dx : -r.dx;
    const dz = forward ? r.dz : -r.dz;
    const rx = -dz;
    const rz = dx;
    const t0 = forward ? r.trimA : r.trimB;
    const t1 = forward ? r.trimB : r.trimA;
    const sx = from.x + dx * t0 + rx * REF_OFFSET;
    const sz = from.z + dz * t0 + rz * REF_OFFSET;
    const ex = to.x - dx * t1 + rx * REF_OFFSET;
    const ez = to.z - dz * t1 + rz * REF_OFFSET;
    const seg = newSeg(SegKind.Link, [sx, sz, ex, ez]);
    seg.name = r.name;
    seg.road = r;
    seg.from = from;
    seg.to = to;
    seg.portalIn = from.kind === 'portal';
    seg.portalOut = to.kind === 'portal';
    seg.speedLimit = r.bridge ? 13.5 : 12.5;
    links.push(seg);
    return seg;
  };

  for (const r of roads) {
    const fwd = makeLink(r, true);
    const back = makeLink(r, false);
    // Arm at a: outward = road dir; inLink = back (toward a), outLink = fwd.
    r.a.arms.push({
      node: r.a,
      road: r,
      ox: r.dx,
      oz: r.dz,
      angle: Math.atan2(r.dz, r.dx),
      inLink: back,
      outLink: fwd,
      trim: r.trimA,
    });
    r.b.arms.push({
      node: r.b,
      road: r,
      ox: -r.dx,
      oz: -r.dz,
      angle: Math.atan2(-r.dz, -r.dx),
      inLink: fwd,
      outLink: back,
      trim: r.trimB,
    });
  }

  // Signalised junctions: connectors from each inbound link to every non-U-turn outbound link.
  const signalNodes = nodes.filter((n) => n.kind === 'signal');
  signalNodes.forEach((n, nodeIndex) => {
    n.arms.forEach((arm, approach) => {
      const inL = arm.inLink;
      const inDx = -arm.ox;
      const inDz = -arm.oz;
      // Group 0 = north–south axis, group 1 = east–west/diagonal.
      const group = Math.abs(arm.ox) > Math.abs(arm.oz) ? 1 : 0;
      inL.signal = { nodeIndex, group, approach };
      for (const other of n.arms) {
        if (other === arm) continue;
        const outL = other.outLink;
        const cross = inDx * other.oz - inDz * other.ox;
        const turn: Turn = cross > 0.35 ? Turn.Right : cross < -0.35 ? Turn.Left : Turn.Straight;
        const x0 = inL.px[inL.n - 1];
        const z0 = inL.pz[inL.n - 1];
        const x3 = outL.px[0];
        const z3 = outL.pz[0];
        const d = Math.hypot(x3 - x0, z3 - z0);
        const conn = newSeg(
          SegKind.Conn,
          cubic(x0, z0, inDx, inDz, x3, z3, other.ox, other.oz, d * (turn === Turn.Straight ? 0.3 : 0.45)),
        );
        conn.turn = turn;
        conn.name = n.name;
        conn.fromLink = inL;
        conn.speedLimit = turn === Turn.Right ? 6 : turn === Turn.Left ? 7.5 : 12;
        conn.next = [outL];
        inL.next.push(conn);
      }
    });
  });

  // Roundabout: circulation is counter-clockwise on the map (x right, z down → θ decreasing).
  const ringArms = [...RB.arms];
  type Ev = { phi: number; arm: number; kind: 'exit' | 'entry' };
  const evs: Ev[] = [];
  const norm = (a: number) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  ringArms.forEach((arm, k) => {
    evs.push({ phi: norm(-(arm.angle + RING_DELTA)), arm: k, kind: 'exit' });
    evs.push({ phi: norm(-(arm.angle - RING_DELTA)), arm: k, kind: 'entry' });
  });
  evs.sort((a, b) => a.phi - b.phi);
  const ringPos = (phi: number) => ({
    x: RB.x + Math.cos(phi) * RING_REF_R,
    z: RB.z - Math.sin(phi) * RING_REF_R,
    tx: -Math.sin(phi),
    tz: -Math.cos(phi),
  });
  const arcs: Segment[] = [];
  for (let i = 0; i < evs.length; i++) {
    const a = evs[i];
    const b = evs[(i + 1) % evs.length];
    let p1 = b.phi;
    if (p1 <= a.phi) p1 += Math.PI * 2;
    const pts: number[] = [];
    const N = Math.max(4, Math.ceil(((p1 - a.phi) * RING_REF_R) / 0.6));
    for (let j = 0; j <= N; j++) {
      const p = ringPos(a.phi + ((p1 - a.phi) * j) / N);
      pts.push(p.x, p.z);
    }
    const arc = newSeg(SegKind.Ring, pts);
    arc.name = RB.name;
    arc.priority = 2;
    arc.halfW = 5.5;
    arc.speedLimit = 8;
    arcs.push(arc);
  }
  for (let i = 0; i < arcs.length; i++) {
    arcs[i].next = [arcs[(i + 1) % arcs.length]];
  }
  const merges: RingMerge[] = [];
  evs.forEach((ev, i) => {
    // arcs[i] starts at ev; arcs[i-1] ends at ev.
    const endingArc = arcs[(i - 1 + arcs.length) % arcs.length];
    const startingArc = arcs[i];
    const arm = ringArms[ev.arm];
    const p = ringPos(ev.phi);
    if (ev.kind === 'exit') {
      const outL = arm.outLink;
      const x3 = outL.px[0];
      const z3 = outL.pz[0];
      const d = Math.hypot(x3 - p.x, z3 - p.z);
      const exit = newSeg(SegKind.Conn, cubic(p.x, p.z, p.tx, p.tz, x3, z3, arm.ox, arm.oz, d * 0.45));
      exit.name = RB.name;
      exit.priority = 2;
      exit.halfW = 4.5;
      exit.turn = Turn.Right;
      exit.speedLimit = 8;
      exit.next = [outL];
      endingArc.ringExitArm = ev.arm;
      endingArc.exitConns = [exit];
    } else {
      const inL = arm.inLink;
      const x0 = inL.px[inL.n - 1];
      const z0 = inL.pz[inL.n - 1];
      const d = Math.hypot(p.x - x0, p.z - z0);
      const entry = newSeg(SegKind.Conn, cubic(x0, z0, -arm.ox, -arm.oz, p.x, p.z, p.tx, p.tz, d * 0.45));
      entry.name = RB.name;
      entry.priority = 1;
      entry.halfW = 4.5;
      entry.turn = Turn.Right;
      entry.speedLimit = 7;
      entry.ringEntryArm = ev.arm;
      entry.next = [startingArc];
      const prevArc = arcs[(i - 2 + arcs.length) % arcs.length];
      const merge: RingMerge = {
        x: p.x,
        z: p.z,
        upstream: [
          { seg: endingArc, extra: 0 },
          { seg: prevArc, extra: endingArc.length },
        ],
      };
      entry.merge = merge;
      merges.push(merge);
      inL.next = [entry];
    }
  });

  // Arcs that end at an exit point may continue or leave.
  for (const arc of arcs) {
    if (arc.ringExitArm >= 0) arc.next = [arc.next[0], ...arc.exitConns];
  }

  // Signage: right turn on red is allowed except where a sign forbids it.
  const noRor = (n: MapNode, fromKey: string) => {
    const arm = n.arms.find((a) => (a.road.a === n ? a.road.b : a.road.a).key === fromKey);
    if (arm) arm.inLink.noRightOnRed = true;
  };
  noRor(BM, 'RB');
  noRor(CN, 'pCN');
  noRor(DN, 'pE');

  // Bus stops on the right side of a few links.
  const busStops: { link: Segment; s: number }[] = [];
  const addStop = (aKey: string, bKey: string, frac: number) => {
    const l = links.find((k) => k.from?.key === aKey && k.to?.key === bKey);
    if (!l) return;
    l.busStopS = l.length * frac;
    busStops.push({ link: l, s: l.busStopS });
  };
  addStop('RB', 'BM', 0.55);
  addStop('DN', 'pDS', 0.45);
  addStop('pRS', 'RB', 0.5);
  addStop('CS', 'CN', 0.5);
  addStop('BS', 'RB', 0.5);

  return {
    nodes,
    roads,
    segments,
    links,
    portalsIn: links.filter((l) => l.portalIn),
    signalNodes,
    ring: { center: RING_CENTER, arms: ringArms, merges },
    busStops,
  };
}
