import * as THREE from 'three';
import { hash32, Rng, weightedIndex } from '../core/rng';
import type { SceneJson } from '../data/q1Schema';
import type { Network, Segment } from '../sim/network';
import { GeoBuilder } from './geo';
import { makeMaterial } from './materials';
import { SIDEWALK, pointInPolygon, type Zoning } from './zones';

/**
 * Static Saigon street life: rows of parked motorbikes packed on the pavement in front of the shop houses.
 * Everything is derived from the road network, the zoning raster and the already-built props, with per-link
 * seeded randomness, so the layout is identical on every load. Cars are deliberately not parked: every
 * carriageway is exactly `lanes × LANE_W` wide, so a kerbside car would sit in a moving lane.
 */

const SEED = 0x5ba7;
/** Instances are bucketed into square tiles of this edge so off-screen streets are frustum-culled. */
const TILE = 320;
const BIKE_Y = 0.012;
/** Half the bike length (wheel tip to centre) and half its width, in metres. */
const HALF_LEN = 0.9;
const HALF_WID = 0.31;
/** Where the bike centre sits: its rear tip touches the facade side of the pavement. */
const BACK_INSET = HALF_LEN + 0.05;
/** Links shorter than this, and this far from either end of a link, get no bikes. */
const MIN_LINK = 14;
const END_MARGIN = 5;
const BUS_CLEAR = 11;
/** Props that stand on the pavement (trunks, lamp posts, stools, existing parked scooters) keep this clear of every bike sample. */
const PROP_CLEAR = 0.62;
const BIKE_SEPARATION = 0.5;
/** Shop density: fronts counted in the 3×3 cells (60 m) around the bike; this many = fully commercial. */
const SHOP_CELL = 20;
const SHOP_FULL = 12;
/** Facade search: first probe, farthest set-back past the pavement, and the least distance of a bike centre from the asphalt edge (keeps the first 1.3 m for walkers and zebra crossers). */
const FACADE_FROM = 2.2;
const MAX_SETBACK = 3.5;
const MIN_LAT = 2.2;
const MARKET_RADIUS = 160;

/** Back-of-pavement land use, which decides how likely a bike is. */
const enum Back {
  Built = 0,
  Open = 1,
  Park = 2,
  Water = 3,
  Road = 4,
}
/** Chance that a bike is kept for each back-of-pavement class (shop houses carry the full density). */
const BACK_KEEP: Record<Back, number> = { [Back.Built]: 1, [Back.Open]: 0.2, [Back.Park]: 0.07, [Back.Water]: 0, [Back.Road]: 0.04 };

/** Paints seen on Saigon pavements: plenty of white, black and red, a little of everything warm. */
const PAINTS: { hex: number; w: number }[] = [
  { hex: 0xf2efe6, w: 17 },
  { hex: 0x26282c, w: 17 },
  { hex: 0xc0392b, w: 14 },
  { hex: 0xb7bcc2, w: 9 },
  { hex: 0x2f5fa8, w: 8 },
  { hex: 0xe0b23a, w: 6 },
  { hex: 0x2f8c84, w: 5 },
  { hex: 0xd9703a, w: 5 },
  { hex: 0xe9dcc0, w: 6 },
  { hex: 0x8e2a22, w: 5 },
  { hex: 0x6b7a3a, w: 3 },
  { hex: 0x7d5a3c, w: 3 },
];
const PAINT_W = PAINTS.map((p) => p.w);

const TIRE = 0x1d1c1c;
const DARK = 0x2a2626;

/** The street scooter of vehicleModels.ts, trimmed for ten thousand copies: octagonal wheels, no (switched-off) lamps. */
function bikeGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const wheel = () => new THREE.CylinderGeometry(0.28, 0.28, 0.12, 8);
  b.place(wheel(), 0.62, 0.28, 0, TIRE, {}, [Math.PI / 2, 0, 0]);
  b.place(wheel(), -0.62, 0.28, 0, TIRE, {}, [Math.PI / 2, 0, 0]);
  b.box(1.1, 0.22, 0.3, -0.05, 0.42, 0, 0x3a3a3a);
  b.box(0.66, 0.34, 0.4, -0.38, 0.62, 0, 0xffffff, { paint: 1 });
  b.box(0.2, 0.62, 0.4, 0.44, 0.66, 0, 0xffffff, { paint: 1 }, 0, 0, -0.28);
  b.box(0.62, 0.08, 0.3, -0.3, 0.83, 0, DARK);
  b.box(0.08, 0.06, 0.62, 0.52, 1.04, 0, DARK);
  return b.build();
}

/** Points bucketed into a coarse grid for "anything within r?" queries. */
class PointGrid {
  private readonly cells = new Map<number, number[]>();
  constructor(private readonly cell: number) {}

  private key(ix: number, iz: number): number {
    return (ix + 8192) * 16384 + (iz + 8192);
  }

  add(x: number, z: number): void {
    const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    const list = this.cells.get(k);
    if (list) list.push(x, z);
    else this.cells.set(k, [x, z]);
  }

  /** Any stored point strictly closer than `r` (r ≤ cell). */
  near(x: number, z: number, r: number): boolean {
    const ix = Math.floor(x / this.cell);
    const iz = Math.floor(z / this.cell);
    const r2 = r * r;
    for (let j = iz - 1; j <= iz + 1; j++) {
      for (let i = ix - 1; i <= ix + 1; i++) {
        const list = this.cells.get(this.key(i, j));
        if (!list) continue;
        for (let k = 0; k < list.length; k += 2) {
          const dx = list[k] - x;
          const dz = list[k + 1] - z;
          if (dx * dx + dz * dz < r2) return true;
        }
      }
    }
    return false;
  }

  /** Stored points in the 3×3 cells around (x, z). */
  count(x: number, z: number): number {
    const ix = Math.floor(x / this.cell);
    const iz = Math.floor(z / this.cell);
    let n = 0;
    for (let j = iz - 1; j <= iz + 1; j++) {
      for (let i = ix - 1; i <= ix + 1; i++) n += (this.cells.get(this.key(i, j))?.length ?? 0) / 2;
    }
    return n;
  }
}

interface Bike {
  x: number;
  z: number;
  yaw: number;
  lean: number;
  scale: number;
  paint: number;
}

interface JunctionZone {
  x: number;
  z: number;
  r2: number;
  arms: { sx: number; sz: number; ox: number; oz: number; reach: number }[];
}

export interface ParkedResult {
  group: THREE.Group;
  /** Instances placed, instanced meshes (draw calls) and triangles per bike / in total. */
  counts: { bikes: number; meshes: number; trisPerBike: number; triangles: number };
}

/** Positions of everything already standing on the pavement, read back from the instanced props of the other groups. */
function collectProps(groups: readonly THREE.Object3D[], grid: PointGrid): number {
  let n = 0;
  for (const g of groups) {
    g.traverse((o) => {
      // Shadow-casting instanced meshes are the physical props (trees, lamps, stools, scooters); signs and light pools are not.
      if (!(o instanceof THREE.InstancedMesh) || !o.castShadow) return;
      const e = o.instanceMatrix.array;
      for (let i = 0; i < o.count; i++) {
        grid.add(e[i * 16 + 12], e[i * 16 + 14]);
        n++;
      }
    });
  }
  return n;
}

function junctionZones(net: Network): JunctionZone[] {
  const out: JunctionZone[] = [];
  for (const j of net.junctions) {
    if (j.kind !== 'junction') continue;
    let trim = 0;
    for (const a of j.arms) trim = Math.max(trim, a.trim);
    const r = trim + 5;
    out.push({
      x: j.x,
      z: j.z,
      r2: r * r,
      // Stop line, zebra (2.1 m node-side of it) and the signal pole just past it; the slab spans the whole road plus both pavements.
      arms: j.arms.map((a) => ({ sx: a.stopX, sz: a.stopZ, ox: a.ox, oz: a.oz, reach: a.roadHalf + SIDEWALK + 3 })),
    });
  }
  return out;
}

export function buildParked(
  net: Network,
  scene: SceneJson,
  zoning: Zoning,
  shopFronts: readonly { x: number; z: number }[],
  propGroups: readonly THREE.Object3D[],
): ParkedResult {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'parked';

  const props = new PointGrid(3);
  collectProps(propGroups, props);
  const placed = new PointGrid(3);
  const shops = new PointGrid(SHOP_CELL);
  for (const s of shopFronts) shops.add(s.x, s.z);
  const zones = junctionZones(net);
  const stops = net.busStops.map((st) => {
    const t = [0, 0, 0, 0];
    st.link.sample(st.s, t);
    return { x: t[0], z: t[1] };
  });
  const market = scene.landmarks.find((l) => l.key === 'benThanh');
  const parks = scene.parks.map((p) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < p.pts.length; i += 2) {
      x0 = Math.min(x0, p.pts[i]);
      x1 = Math.max(x1, p.pts[i]);
      z0 = Math.min(z0, p.pts[i + 1]);
      z1 = Math.max(z1, p.pts[i + 1]);
    }
    return { pts: p.pts, x0, x1, z0, z1 };
  });

  const inPark = (x: number, z: number): boolean => {
    for (const p of parks) if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1 && pointInPolygon(p.pts, x, z)) return true;
    return false;
  };
  const backAt = (x: number, z: number): Back => {
    if (zoning.isWater(x, z)) return Back.Water;
    if (inPark(x, z)) return Back.Park;
    if (zoning.treeFree(x, z, 0)) return Back.Open;
    // Occupied: asphalt of another carriageway (a median strip), else a building or landmark.
    return zoning.roadDist(x, z) < 0 ? Back.Road : Back.Built;
  };

  const blockedByJunction = (x: number, z: number, local: JunctionZone[]): boolean => {
    for (const j of local) {
      const dx = x - j.x;
      const dz = z - j.z;
      if (dx * dx + dz * dz < j.r2) return true;
      for (const a of j.arms) {
        const ex = x - a.sx;
        const ez = z - a.sz;
        const along = ex * a.ox + ez * a.oz;
        if (along < -7 || along > 5) continue;
        if (Math.abs(-ex * a.oz + ez * a.ox) < a.reach) return true;
      }
    }
    return false;
  };
  const blockedByRing = (x: number, z: number): boolean => {
    for (const r of net.rings) {
      const lim = r.r + r.halfW + SIDEWALK + 3;
      if ((x - r.cx) * (x - r.cx) + (z - r.cz) * (z - r.cz) < lim * lim) return true;
    }
    return false;
  };

  const bikes: Bike[] = [];
  const p = [0, 0, 0, 0];

  const placeSide = (seg: Segment, side: 1 | -1, local: JunctionZone[]): void => {
    const rng = new Rng(hash32(seg.id, SEED + (side > 0 ? 0 : 1)));
    const end = seg.length - END_MARGIN;
    let s = END_MARGIN + rng.range(0, 3);
    while (s < end) {
      const count = 3 + rng.int(13);
      // Angle between the bike axis and the kerb: 45° (nose-in diagonal) to 90° (end-on).
      const theta = rng.range(Math.PI / 4, Math.PI / 2);
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      const frontOut = rng.chance(0.55) ? 1 : -1;
      const along = rng.chance(0.5) ? 1 : -1;
      const pitch = Math.min(0.9, Math.max(0.7, 0.62 / sinT + rng.range(0, 0.1)));
      // Commercial streets fill most of their length; quiet ones keep a few clusters.
      seg.sample(Math.min(seg.length, s + (count * pitch) / 2), p);
      // Hug the facade, also where shop forecourts stand it back from the pavement; else use the pavement's far edge.
      let facade = -1;
      for (let d = FACADE_FROM; d <= SIDEWALK + MAX_SETBACK; d += 0.5) {
        const ob = side * (seg.halfW + d);
        if (backAt(p[0] - p[3] * ob, p[1] + p[2] * ob) === Back.Built) {
          facade = d;
          break;
        }
      }
      const lat = Math.max(MIN_LAT, (facade > 0 ? facade : SIDEWALK) - 0.5 - BACK_INSET - rng.range(0, 0.15));
      const o = side * (seg.halfW + lat);
      const mx = p[0] - p[3] * o;
      const mz = p[1] + p[2] * o;
      const shop = Math.min(1, shops.count(mx, mz) / SHOP_FULL);
      let dens = 0.14 + 0.46 * shop;
      if (market && Math.hypot(mx - market.cx, mz - market.cz) < MARKET_RADIUS) dens = Math.min(0.95, dens * 1.4 + 0.12);
      const active = rng.next() < dens;
      for (let i = 0; i < count && s < end; i++, s += pitch) {
        if (!active) continue;
        // Draw every random number up front so rejecting a bike never shifts the stream.
        const jitterYaw = rng.range(-0.1, 0.1);
        const jitterLat = rng.range(-0.05, 0.05);
        const keep = rng.next();
        const lean = rng.range(-0.07, 0.07);
        const scale = rng.range(0.96, 1.04);
        const paint = weightedIndex(PAINT_W, rng.next());

        seg.sample(s, p);
        const tx = p[2];
        const tz = p[3];
        const nx = -side * tz;
        const nz = side * tx;
        const off = side * (seg.halfW + lat + jitterLat);
        const x = p[0] - p[3] * off;
        const z = p[1] + p[2] * off;
        const hx = frontOut * -sinT * nx + along * cosT * tx;
        const hz = frontOut * -sinT * nz + along * cosT * tz;
        // Cheap rejections first.
        if (blockedByJunction(x, z, local) || blockedByRing(x, z)) continue;
        if (stops.some((q) => Math.hypot(q.x - x, q.z - z) < BUS_CLEAR)) continue;
        const ax = x + hx * (HALF_LEN + 0.05);
        const az = z + hz * (HALF_LEN + 0.05);
        const bx = x - hx * (HALF_LEN + 0.05);
        const bz = z - hz * (HALF_LEN + 0.05);
        // Sample the two wheel tips and the middle, plus the shoulders next to the saddle.
        const px = -hz * HALF_WID;
        const pz = hx * HALF_WID;
        if (props.near(x, z, PROP_CLEAR) || props.near(ax, az, PROP_CLEAR) || props.near(bx, bz, PROP_CLEAR)) continue;
        if (placed.near(x, z, BIKE_SEPARATION)) continue;
        // On the pavement, off every carriageway, building and the water.
        if (!zoning.treeFree(x, z, 0.5) || !zoning.treeFree(ax, az, 0.3) || !zoning.treeFree(bx, bz, 0.3)) continue;
        if (!zoning.treeFree(x + px, z + pz, 0.2) || !zoning.treeFree(x - px, z - pz, 0.2)) continue;
        // What stands behind the pavement decides whether a bike belongs here.
        const ob = side * (seg.halfW + (facade > 0 ? facade + 0.25 : SIDEWALK + 0.9));
        let back = backAt(p[0] - p[3] * ob, p[1] + p[2] * ob);
        if (facade < 0 && back === Back.Open) {
          const ob2 = side * (seg.halfW + SIDEWALK + 2.6);
          if (backAt(p[0] - p[3] * ob2, p[1] + p[2] * ob2) === Back.Built) back = Back.Built;
        }
        if (keep >= BACK_KEEP[back]) continue;
        placed.add(x, z);
        bikes.push({ x, z, yaw: Math.atan2(-hz, hx) + jitterYaw, lean, scale, paint });
      }
      s += rng.range(1, 4.5);
    }
  };

  for (const seg of net.links) {
    if (seg.bridge || seg.length < MIN_LINK) continue;
    seg.sample(seg.length / 2, p);
    const reach = seg.length / 2 + 60;
    const local = zones.filter((j) => (j.x - p[0]) * (j.x - p[0]) + (j.z - p[1]) * (j.z - p[1]) < reach * reach);
    placeSide(seg, 1, local);
    if (seg.oneway) placeSide(seg, -1, local);
  }

  // ---- meshes: one InstancedMesh per map tile, so streets outside the view are culled
  const tiles = new Map<number, Bike[]>();
  for (const b of bikes) {
    const k = (Math.floor(b.x / TILE) + 1024) * 4096 + Math.floor(b.z / TILE) + 1024;
    const list = tiles.get(k);
    if (list) list.push(b);
    else tiles.set(k, [b]);
  }
  const base = bikeGeometry();
  const trisPerBike = base.getAttribute('position').count / 3;
  const mat = makeMaterial({}, { roughness: 0.55 });
  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const qYaw = new THREE.Quaternion();
  const qLean = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const fwd = new THREE.Vector3(1, 0, 0);
  const col = new THREE.Color();
  let meshes = 0;
  for (const list of tiles.values()) {
    const mesh = new THREE.InstancedMesh(base, mat, list.length);
    mesh.name = 'parked-bikes';
    list.forEach((b, k) => {
      qYaw.setFromAxisAngle(up, b.yaw);
      qLean.setFromAxisAngle(fwd, b.lean);
      qYaw.multiply(qLean);
      mesh.setMatrixAt(k, m4.compose(pos.set(b.x, BIKE_Y, b.z), qYaw, scl.set(b.scale, b.scale, b.scale)));
      mesh.setColorAt(k, col.setHex(PAINTS[b.paint].hex));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Static: compute the culling sphere once over the real instances.
    mesh.computeBoundingSphere();
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    meshes++;
  }

  const counts = { bikes: bikes.length, meshes, trisPerBike, triangles: bikes.length * trisPerBike };
  group.userData = counts;
  if (import.meta.env.DEV) {
    console.info(
      `[parked] ${counts.bikes} bikes in ${meshes} instanced meshes, ${trisPerBike} tris each = ${counts.triangles} tris, ${Math.round(performance.now() - t0)} ms`,
    );
  }
  return { group, counts };
}
