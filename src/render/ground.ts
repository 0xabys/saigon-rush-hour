import * as THREE from 'three';
import { Rng } from '../core/rng';
import { LANE_W, SegKind, type Junction, type Network, type Ring, type Segment } from '../sim/network';
import { asphaltTexture, grassTexture, pavingTexture } from './textures';

/** Width of the pavement beside every road. */
export const SIDEWALK = 3.2;

const ROAD_COLOR = 0xffffff;
const WALK_COLOR = 0xe3d6b9;
const CURB_COLOR = 0xcfc3a8;
const ISLAND_COLOR = 0x86b062;
const MARK_WHITE = 0xf3eee2;
const MARK_YELLOW = 0xe8b640;
const WEAR_COLOR = 0x55504a;

const Y_WALK = 0.012;
const Y_ROAD = 0.03;
const Y_HULL = 0.035;
const Y_CURB = 0.16;
const Y_MARK = 0.06;
const Y_ZEBRA = 0.065;
const Y_ISLAND = 0.22;
const Y_ISLAND_CURB = 0.23;

/** A polyline is cut into quads at least every `MAX_SPAN` metres and whenever it has turned by `MAX_TURN`. */
const MAX_SPAN = 16;
const MAX_TURN = 0.1;

const stationCache = new WeakMap<Segment, Float32Array>();

/** Arc lengths at which strips along `seg` get a cross-section: sparse on straights, dense in bends. */
function stationsOf(seg: Segment): Float32Array {
  let st = stationCache.get(seg);
  if (st) return st;
  const out: number[] = [0];
  let last = 0;
  for (let i = 1; i < seg.n; i++) {
    const cross = seg.tx[last] * seg.tz[i] - seg.tz[last] * seg.tx[i];
    const dot = seg.tx[last] * seg.tx[i] + seg.tz[last] * seg.tz[i];
    if (i === seg.n - 1 || (i - last) * seg.step >= MAX_SPAN || Math.abs(Math.atan2(cross, dot)) > MAX_TURN) {
      out.push(i * seg.step);
      last = i;
    }
  }
  st = Float32Array.from(out);
  stationCache.set(seg, st);
  return st;
}

/** Cross-section positions in [a, b], including both ends. */
function stationsBetween(seg: Segment, a: number, b: number): number[] {
  const out = [a];
  const st = stationsOf(seg);
  for (let i = 0; i < st.length; i++) {
    const s = st[i];
    if (s >= b - 0.05) break;
    if (s > a + 0.05) out.push(s);
  }
  out.push(b);
  return out;
}

const tmp = [0, 0, 0, 0];

/** Flat, upward-facing triangles with per-vertex colour and world-space UVs. */
export class FlatBuilder {
  private pos: number[] = [];
  private col: number[] = [];
  private uv: number[] = [];
  private readonly c = new THREE.Color();
  constructor(private readonly uvScale = 1 / 8) {}

  tri(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, y: number, color: number): void {
    // Orient counter-clockwise when seen from above so the face points up.
    if ((bz - az) * (cx - ax) - (bx - ax) * (cz - az) < 0) {
      [bx, cx] = [cx, bx];
      [bz, cz] = [cz, bz];
    }
    this.c.setHex(color);
    for (const [x, z] of [
      [ax, az],
      [bx, bz],
      [cx, cz],
    ]) {
      this.pos.push(x, y, z);
      this.col.push(this.c.r, this.c.g, this.c.b);
      this.uv.push(x * this.uvScale, -z * this.uvScale);
    }
  }

  quad(x0: number, z0: number, x1: number, z1: number, x2: number, z2: number, x3: number, z3: number, y: number, color: number): void {
    this.tri(x0, z0, x1, z1, x2, z2, y, color);
    this.tri(x0, z0, x2, z2, x3, z3, y, color);
  }

  /** Rectangle along a→b, spanning lateral offsets [o0, o1] (right-hand positive). */
  band(ax: number, az: number, bx: number, bz: number, o0: number, o1: number, y: number, color: number): void {
    const dx = bx - ax;
    const dz = bz - az;
    const l = Math.hypot(dx, dz) || 1;
    const rx = -dz / l;
    const rz = dx / l;
    this.quad(ax + rx * o0, az + rz * o0, bx + rx * o0, bz + rz * o0, bx + rx * o1, bz + rz * o1, ax + rx * o1, az + rz * o1, y, color);
  }

  /**
   * Quad strip along a segment between arc lengths [a, b], spanning lateral offsets [o0, o1] from the
   * segment's reference line (right-hand positive, right = (−tz, tx)).
   */
  strip(seg: Segment, o0: number, o1: number, y: number, color: number, a = 0, b = seg.length): void {
    if (b - a < 0.05) return;
    const st = stationsBetween(seg, a, b);
    seg.sample(st[0], tmp);
    let l0x = tmp[0] - tmp[3] * o0;
    let l0z = tmp[1] + tmp[2] * o0;
    let r0x = tmp[0] - tmp[3] * o1;
    let r0z = tmp[1] + tmp[2] * o1;
    for (let i = 1; i < st.length; i++) {
      seg.sample(st[i], tmp);
      const l1x = tmp[0] - tmp[3] * o0;
      const l1z = tmp[1] + tmp[2] * o0;
      const r1x = tmp[0] - tmp[3] * o1;
      const r1z = tmp[1] + tmp[2] * o1;
      this.quad(l0x, l0z, l1x, l1z, r1x, r1z, r0x, r0z, y, color);
      l0x = l1x;
      l0z = l1z;
      r0x = r1x;
      r0z = r1z;
    }
  }

  poly(pts: [number, number][], y: number, color: number): void {
    for (let i = 1; i < pts.length - 1; i++) this.tri(pts[0][0], pts[0][1], pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], y, color);
  }

  annulus(cx: number, cz: number, r0: number, r1: number, a0: number, a1: number, y: number, color: number, seg = 48): void {
    const n = Math.max(3, Math.ceil((seg * (a1 - a0)) / (Math.PI * 2)));
    for (let i = 0; i < n; i++) {
      const t0 = a0 + ((a1 - a0) * i) / n;
      const t1 = a0 + ((a1 - a0) * (i + 1)) / n;
      this.quad(
        cx + Math.cos(t0) * r0,
        cz + Math.sin(t0) * r0,
        cx + Math.cos(t0) * r1,
        cz + Math.sin(t0) * r1,
        cx + Math.cos(t1) * r1,
        cz + Math.sin(t1) * r1,
        cx + Math.cos(t1) * r0,
        cz + Math.sin(t1) * r0,
        y,
        color,
      );
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    const n = new Float32Array(this.pos.length);
    for (let i = 1; i < n.length; i += 3) n[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    return g;
  }
}

function convexHull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Vertical kerb faces, two triangles per quad (rendered double-sided). */
class Skirts {
  readonly pos: number[] = [];

  /** Wall at lateral offset `o` along seg over [a, b]. */
  along(seg: Segment, o: number, a: number, b: number, y0: number, y1: number): void {
    if (b - a < 0.05) return;
    const st = stationsBetween(seg, a, b);
    seg.sample(st[0], tmp);
    let px = tmp[0] - tmp[3] * o;
    let pz = tmp[1] + tmp[2] * o;
    for (let i = 1; i < st.length; i++) {
      seg.sample(st[i], tmp);
      const qx = tmp[0] - tmp[3] * o;
      const qz = tmp[1] + tmp[2] * o;
      this.wall(px, pz, qx, qz, y0, y1);
      px = qx;
      pz = qz;
    }
  }

  wall(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number): void {
    this.pos.push(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y0, z0, x1, y1, z1, x0, y1, z0);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.computeVertexNormals();
    return g;
  }
}

/** Spatial hash of every link's reference line, to find where two carriageways nearly touch. */
class LinkGrid {
  private static readonly CELL = 8;
  private static readonly SHIFT = 1024;
  private readonly cells = new Map<number, number[]>();
  private readonly x: number[] = [];
  private readonly z: number[] = [];
  private readonly hw: number[] = [];
  private readonly id: number[] = [];

  constructor(links: Segment[]) {
    for (const l of links) {
      const last = l.n - 1;
      for (let i = 0; i <= last; i += 4) this.add(l, i);
      if (last % 4 !== 0) this.add(l, last);
    }
  }

  private key(cx: number, cz: number): number {
    return (cx + LinkGrid.SHIFT) * 4096 + (cz + LinkGrid.SHIFT);
  }

  private add(l: Segment, i: number): void {
    const idx = this.x.length;
    this.x.push(l.px[i]);
    this.z.push(l.pz[i]);
    this.hw.push(l.halfW);
    this.id.push(l.id);
    const k = this.key(Math.floor(l.px[i] / LinkGrid.CELL), Math.floor(l.pz[i] / LinkGrid.CELL));
    const cell = this.cells.get(k);
    if (cell) cell.push(idx);
    else this.cells.set(k, [idx]);
  }

  /** Is (x, z) on the carriageway of a link other than `self`? */
  onOther(x: number, z: number, self: number): boolean {
    const cx = Math.floor(x / LinkGrid.CELL);
    const cz = Math.floor(z / LinkGrid.CELL);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const cell = this.cells.get(this.key(cx + i, cz + j));
        if (!cell) continue;
        for (const idx of cell) {
          if (this.id[idx] === self) continue;
          const r = this.hw[idx] + 0.4;
          const dx = this.x[idx] - x;
          const dz = this.z[idx] - z;
          if (dx * dx + dz * dz < r * r) return true;
        }
      }
    }
    return false;
  }
}

type Range = [number, number];

/** Maximal arc intervals of [0, len] where `ok(s)` holds, sampled every ~`step` metres. */
function okRanges(len: number, step: number, ok: (s: number) => boolean): Range[] {
  const out: Range[] = [];
  const n = Math.max(1, Math.ceil(len / step));
  let start = -1;
  let prev = 0;
  for (let i = 0; i <= n; i++) {
    const s = (len * i) / n;
    if (ok(s)) {
      if (start < 0) start = s;
    } else if (start >= 0) {
      out.push([start, prev]);
      start = -1;
    }
    prev = s;
  }
  if (start >= 0) out.push([start, len]);
  return out.filter(([a, b]) => b - a > 0.5);
}

interface Opening {
  x: number;
  z: number;
  r: number;
}

/** Points on the ring where an arm joins, with the half-width of the opening. */
function ringOpenings(ring: Ring): Opening[] {
  const out: Opening[] = [];
  for (const arm of ring.arms) {
    let x = 0;
    let z = 0;
    let k = 0;
    if (arm.entry) {
      x += arm.entry.px[arm.entry.n - 1];
      z += arm.entry.pz[arm.entry.n - 1];
      k++;
    }
    if (arm.exit) {
      x += arm.exit.px[0];
      z += arm.exit.pz[0];
      k++;
    }
    if (k === 0) continue;
    const road = arm.inLink ?? arm.outLink;
    out.push({ x: x / k, z: z / k, r: (road ? road.roadHalf : ring.halfW) + 0.8 });
  }
  return out;
}

function inOpening(x: number, z: number, open: Opening[], extra: number): boolean {
  for (const o of open) {
    const r = o.r + extra;
    if ((o.x - x) * (o.x - x) + (o.z - z) * (o.z - z) < r * r) return true;
  }
  return false;
}

export interface GroundResult {
  group: THREE.Group;
  roadMat: THREE.MeshStandardMaterial;
  walkMat: THREE.MeshStandardMaterial;
}

/**
 * Roads, junction surfaces, roundabouts, pavements, kerbs and every road marking, all read from the
 * generic `Network`. Terrain (slab, ground plane, water, parks) lives in terrain.ts.
 */
export function buildGround(net: Network): GroundResult {
  const group = new THREE.Group();
  group.name = 'ground';

  const paving = pavingTexture();
  paving.repeat.set(1, 1);
  const roads = new FlatBuilder(1 / 9);
  const walks = new FlatBuilder(1 / 6);
  const curbs = new FlatBuilder(1 / 6);
  const skirts = new Skirts();
  const marks = new FlatBuilder();
  const islands = new FlatBuilder(1 / 10);
  const tp = [0, 0, 0, 0];

  // ---- carriageway surface: every segment, then the junction areas
  for (const seg of net.segments) {
    if (seg.kind === SegKind.Link) {
      roads.strip(seg, seg.oneway ? -seg.halfW : -seg.refOffset, seg.halfW, Y_ROAD, ROAD_COLOR);
    } else if (seg.kind === SegKind.Conn) {
      const hw = (seg.fromLink ? seg.fromLink.halfW : seg.halfW) + 0.4;
      roads.strip(seg, -hw, hw, Y_ROAD, ROAD_COLOR);
    } else {
      roads.strip(seg, -seg.halfW, seg.halfW, Y_ROAD, ROAD_COLOR);
    }
  }
  for (const j of net.junctions) {
    if ((j.kind !== 'junction' && j.kind !== 'join') || j.arms.length < 2) continue;
    if (j.radius <= 12) {
      const pts: [number, number][] = [];
      for (const arm of j.arms) {
        const px = -arm.oz;
        const pz = arm.ox;
        pts.push([arm.stopX + px * arm.roadHalf, arm.stopZ + pz * arm.roadHalf]);
        pts.push([arm.stopX - px * arm.roadHalf, arm.stopZ - pz * arm.roadHalf]);
      }
      roads.poly(convexHull(pts), Y_HULL, ROAD_COLOR);
    } else {
      // Large cluster: fan from the centre over the mouths of the arms, in angular order, so the
      // surface follows the roads instead of the convex hull of a 60 m cluster.
      const mouths: [number, number][] = [];
      for (const arm of j.arms) {
        const px = -arm.oz;
        const pz = arm.ox;
        mouths.push([arm.stopX - px * arm.roadHalf, arm.stopZ - pz * arm.roadHalf]);
        mouths.push([arm.stopX + px * arm.roadHalf, arm.stopZ + pz * arm.roadHalf]);
      }
      for (let i = 0; i < mouths.length; i++) {
        const a = mouths[i];
        const b = mouths[(i + 1) % mouths.length];
        roads.tri(j.x, j.z, a[0], a[1], b[0], b[1], Y_HULL, ROAD_COLOR);
      }
    }
  }

  // ---- pavements, kerbs and kerb faces
  const grid = new LinkGrid(net.links);
  /** Is the point at lateral offset `o` from `seg`'s reference line clear of every other carriageway? */
  const clear = (seg: Segment, o: number) => (s: number) => {
    seg.sample(s, tp);
    return !grid.onOther(tp[0] - tp[3] * o, tp[1] + tp[2] * o, seg.id);
  };
  const walkSide = (seg: Segment, side: 1 | -1): void => {
    const e = seg.halfW;
    for (const [a, b] of okRanges(seg.length, 3, clear(seg, side * (e + 0.5)))) {
      if (side > 0) {
        walks.strip(seg, e, e + SIDEWALK, Y_WALK, WALK_COLOR, a, b);
        curbs.strip(seg, e, e + 0.35, Y_CURB, CURB_COLOR, a, b);
      } else {
        walks.strip(seg, -e - SIDEWALK, -e, Y_WALK, WALK_COLOR, a, b);
        curbs.strip(seg, -e - 0.35, -e, Y_CURB, CURB_COLOR, a, b);
      }
      skirts.along(seg, side * e, a, b, Y_ROAD, Y_CURB);
    }
  };
  for (const seg of net.links) {
    if (seg.bridge) continue;
    walkSide(seg, 1);
    if (seg.oneway) walkSide(seg, -1);
  }

  // ---- roundabouts: island, pavement ring, lane line, give-way teeth
  const rng = new Rng(77);
  for (const ring of net.rings) {
    if (ring.arcs.length === 0) continue;
    const open = ringOpenings(ring);
    const hw = ring.halfW;
    // Which side of the circulating lane faces away from the island.
    const a0 = ring.arcs[0];
    a0.sample(a0.length / 2, tp);
    const outward: 1 | -1 = (tp[0] - ring.cx) * -tp[3] + (tp[1] - ring.cz) * tp[2] > 0 ? 1 : -1;
    // Per arc, between the arms.
    for (const arc of ring.arcs) {
      for (const [a, b] of okRanges(arc.length, 1, (s) => {
        arc.sample(s, tp);
        return !inOpening(tp[0], tp[1], open, 0.4);
      })) {
        if (outward > 0) {
          walks.strip(arc, hw + 0.3, hw + 0.3 + SIDEWALK, Y_WALK, WALK_COLOR, a, b);
          curbs.strip(arc, hw, hw + 0.35, Y_CURB, CURB_COLOR, a, b);
        } else {
          walks.strip(arc, -hw - 0.3 - SIDEWALK, -hw - 0.3, Y_WALK, WALK_COLOR, a, b);
          curbs.strip(arc, -hw - 0.35, -hw, Y_CURB, CURB_COLOR, a, b);
        }
        skirts.along(arc, outward * hw, a, b, Y_ROAD, Y_CURB);
      }
      // Lane lines between circulating lanes.
      const lanes = Math.round((2 * hw) / LANE_W);
      for (let k = 1; k < lanes; k++) {
        const o = -hw + (k * 2 * hw) / lanes;
        for (const [a, b] of okRanges(arc.length, 1, (s) => {
          arc.sample(s, tp);
          return !inOpening(tp[0], tp[1], open, 1.5);
        })) {
          for (let s = a + 0.5; s + 3 <= b; s += 7) marks.strip(arc, o - 0.1, o + 0.1, Y_MARK, MARK_WHITE, s, s + 3);
        }
      }
    }
    // Island: bounded by the ring's inner edge, with a raised kerb.
    const inward: 1 | -1 = outward > 0 ? -1 : 1;
    const edge: [number, number][] = [];
    for (const arc of ring.arcs) {
      if (inward > 0) curbs.strip(arc, hw, hw + 0.5, Y_ISLAND_CURB, CURB_COLOR);
      else curbs.strip(arc, -hw - 0.5, -hw, Y_ISLAND_CURB, CURB_COLOR);
      skirts.along(arc, inward * hw, 0, arc.length, Y_ROAD, Y_ISLAND_CURB);
      const st = stationsBetween(arc, 0, arc.length);
      for (let i = 0; i < st.length - 1; i++) {
        arc.sample(st[i], tp);
        const o = inward * (hw + 0.5);
        edge.push([tp[0] - tp[3] * o, tp[1] + tp[2] * o]);
      }
    }
    if (edge.length >= 3) {
      let mx = 0;
      let mz = 0;
      for (const p of edge) {
        mx += p[0];
        mz += p[1];
      }
      mx /= edge.length;
      mz /= edge.length;
      for (let i = 0; i < edge.length; i++) {
        const p = edge[i];
        const q = edge[(i + 1) % edge.length];
        islands.tri(mx, mz, p[0], p[1], q[0], q[1], Y_ISLAND, ISLAND_COLOR);
      }
    }
    // Give-way teeth on each entry, pointing at the oncoming traffic.
    for (const arm of ring.arms) {
      const entry = arm.entry;
      if (!entry) continue;
      entry.sample(Math.max(0, entry.length - 1), tp);
      const dx = tp[2];
      const dz = tp[3];
      const rx = -dz;
      const rz = dx;
      for (let o = -entry.halfW + 0.6; o < entry.halfW - 0.4; o += 1.0) {
        const cx = tp[0] + rx * o;
        const cz = tp[1] + rz * o;
        marks.tri(cx - rx * 0.35, cz - rz * 0.35, cx + rx * 0.35, cz + rz * 0.35, cx - dx * 0.8, cz - dz * 0.8, Y_ZEBRA, MARK_WHITE);
      }
    }
  }

  // ---- link markings
  for (const seg of net.links) {
    const len = seg.length;
    const hw = seg.halfW;
    // Double yellow centre line, once per two-way road.
    if (!seg.oneway && seg.from && seg.to && seg.from.id < seg.to.id) {
      const c = -seg.refOffset;
      marks.strip(seg, c - 0.22, c - 0.06, Y_MARK, MARK_YELLOW);
      marks.strip(seg, c + 0.06, c + 0.22, Y_MARK, MARK_YELLOW);
    }
    // Edge lines, and not where another carriageway overlaps this one.
    for (const [a, b] of okRanges(len, 2, clear(seg, hw - 0.1))) marks.strip(seg, hw - 0.2, hw - 0.06, Y_MARK, MARK_WHITE, a, b);
    if (seg.oneway) for (const [a, b] of okRanges(len, 2, clear(seg, -hw + 0.1))) marks.strip(seg, -hw + 0.06, -hw + 0.2, Y_MARK, MARK_WHITE, a, b);
    // Lane dividers: dashed, solid for the last stretch before a signal.
    if (seg.lanes >= 2 && len > 10) {
      const solid = seg.signal ? Math.min(14, len - 4) : 0;
      const end = len - 2 - solid;
      for (let k = 0; k < seg.lanes - 1; k++) {
        const o = -hw + (k + 1) * LANE_W;
        const ok = clear(seg, o);
        for (let s = 2; s + 1.5 < end; s += 7) {
          const e = Math.min(s + 3, end);
          if (ok((s + e) / 2)) marks.strip(seg, o - 0.1, o + 0.1, Y_MARK, MARK_WHITE, s, e);
        }
        if (solid > 0) {
          for (const [a, b] of okRanges(solid, 2, (s) => ok(len - solid + s))) marks.strip(seg, o - 0.1, o + 0.1, Y_MARK, MARK_WHITE, len - solid + a, len - solid + b);
        }
      }
    }
    // Faded patches where countless tyres have worn the paint.
    if (len > 14 && rng.next() < 0.5) {
      const t = rng.range(5, Math.max(6, len - 7));
      marks.strip(seg, -hw + 1, hw - 1, 0.04, WEAR_COLOR, t, Math.min(len, t + 2));
    }
  }

  // ---- stop lines and zebra crossings
  for (const j of net.junctions) {
    if (j.kind !== 'junction') continue;
    for (const arm of j.arms) {
      const inl = arm.inLink;
      if (!inl || !(inl.signal || inl.yieldAt)) continue;
      inl.sample(inl.length, tp);
      marks.band(tp[0] - tp[2] * 0.5, tp[1] - tp[3] * 0.5, tp[0], tp[1], -inl.halfW, inl.halfW, Y_ZEBRA, MARK_WHITE);
    }
  }
  const zebra = (j: Junction): void => {
    for (const arm of j.arms) {
      if (!arm.inLink?.signal) continue;
      // Same footprint as the pedestrians' crosswalk: centre 2.1 m node-side of the stop line.
      const cx = arm.stopX - arm.ox * 2.1;
      const cz = arm.stopZ - arm.oz * 2.1;
      const half = arm.roadHalf + 1.1 - 0.5;
      const n = Math.floor((2 * half) / 1.15) + 1;
      const first = (-(n - 1) * 1.15) / 2;
      for (let k = 0; k < n; k++) {
        const o = first + k * 1.15;
        marks.band(cx - arm.ox * 1.5, cz - arm.oz * 1.5, cx + arm.ox * 1.5, cz + arm.oz * 1.5, o - 0.3, o + 0.3, Y_ZEBRA, MARK_WHITE);
      }
    }
  };
  for (const j of net.signalJunctions) zebra(j);

  // ---- bus bays at the kerb
  for (const stop of net.busStops) {
    stop.link.sample(stop.s, tp);
    const off = stop.link.halfW - 1.9;
    const cx = tp[0] - tp[3] * off;
    const cz = tp[1] + tp[2] * off;
    const hl = 7;
    const ax = cx - tp[2] * hl;
    const az = cz - tp[3] * hl;
    const bx = cx + tp[2] * hl;
    const bz = cz + tp[3] * hl;
    marks.band(ax, az, bx, bz, -1.5, -1.3, 0.066, MARK_YELLOW);
    marks.band(ax, az, bx, bz, 1.3, 1.5, 0.066, MARK_YELLOW);
    marks.band(ax, az, ax + tp[2] * 0.2, az + tp[3] * 0.2, -1.5, 1.5, 0.066, MARK_YELLOW);
    marks.band(bx - tp[2] * 0.2, bz - tp[3] * 0.2, bx, bz, -1.5, 1.5, 0.066, MARK_YELLOW);
  }

  // ---- meshes
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x4d4843, map: asphaltTexture(), roughness: 0.92, metalness: 0 });
  const roadMesh = new THREE.Mesh(roads.build(), roadMat);
  roadMesh.receiveShadow = true;
  group.add(roadMesh);

  const walkMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: paving, roughness: 0.9 });
  const walkMesh = new THREE.Mesh(walks.build(), walkMat);
  walkMesh.receiveShadow = true;
  group.add(walkMesh);
  const curbMesh = new THREE.Mesh(curbs.build(), walkMat);
  curbMesh.receiveShadow = true;
  curbMesh.castShadow = true;
  group.add(curbMesh);

  const skirtMat = new THREE.MeshStandardMaterial({ color: 0xa79c86, roughness: 0.9, side: THREE.DoubleSide });
  group.add(new THREE.Mesh(skirts.build(), skirtMat));

  const islandMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: grassTexture(), roughness: 0.95 });
  const islandMesh = new THREE.Mesh(islands.build(), islandMat);
  islandMesh.receiveShadow = true;
  group.add(islandMesh);

  const markMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
  const markMesh = new THREE.Mesh(marks.build(), markMat);
  markMesh.receiveShadow = true;
  group.add(markMesh);

  return { group, roadMat, walkMat };
}
