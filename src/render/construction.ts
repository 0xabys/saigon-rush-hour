import * as THREE from 'three';
import { rand01 } from '../core/rng';
import type { SceneJson } from '../data/q1Schema';
import { FRAME_SHAPES, resolveGround } from '../data/sceneOverrides';
import { edgeDistance, inRing, openRing, orientedBox, patchCutaway, type Obb } from './buildings';
import { GeoBuilder } from './geo';
import { FlatBuilder } from './ground';
import { makeMaterial } from './materials';
import { triangulate } from './terrain';
import { asphaltTexture, corrugatedTexture } from './textures';

/**
 * Saigon building sites: dirt lots behind corrugated hoarding (landuse=construction|brownfield), bare concrete
 * frames for building=construction footprints, and tower cranes over the biggest one. Everything is derived
 * from the OSM scene and hashed from OSM ids, so it is identical on every load; geometry is merged into one
 * ground mesh, one fence mesh and one structure mesh.
 */

type Site = SceneJson['sites'][number];
type Building = SceneJson['buildings'][number];

const FLOOR_H = 3.4;
const SLAB = 0.4;
const FENCE_H = 2.4;
const PANEL = 2.4;
/** Fence panels this close to a carriageway are on the asphalt (the OSM polygon spills over the street) and are left out. */
const ASPHALT_CLEAR = 0.6;
/** Footprints bigger than this get a second stair core and a second crane. */
const BIG_FOOTPRINT = 2500;

const DIRT = [0xc4a77c, 0xb89c72, 0xcdb28a];
const BROWNFIELD = 0xb5ad86;
const PAD = 0xbdb9ad;
const MUD = 0x8f7656;
const HOARDING = [0x5b8fb9, 0x6fae8c, 0xd8d5cb, 0x4d7fa8, 0xc4c9cc, 0x7aa6c2];
const CONCRETE_SLAB = 0xc4c1b7;
const CONCRETE_COL = 0xa5a299;
const CONCRETE_CORE = 0x908d84;
const REBAR = 0x7a4a36;
const NET = 0x5f8f6a;
const FORMWORK = 0xd98a2b;
const CRANE = 0xf0b429;
const CRANE_DARK = 0x4a4a48;
const CRANE_GREY = 0x8c8c86;
const CONTAINERS = [0x2f6fb5, 0xc0392b, 0x3f8f5a, 0xe0a33a, 0x8a8f94];

interface Point {
  x: number;
  z: number;
}

/** Rod of square section `t` between two points. */
function rod(b: GeoBuilder, a: THREE.Vector3, c: THREE.Vector3, t: number, color: number, opts?: { emis?: number; emisStrength?: number }): void {
  const dir = new THREE.Vector3().subVectors(c, a);
  const len = dir.length();
  if (len < 1e-4) return;
  const g = new THREE.BoxGeometry(t, len, t);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.divideScalar(len));
  const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, c).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  b.add(g, m, color, opts);
  g.dispose();
}

/** Flat slab of the footprint: y ∈ [0, `thickness`]. */
function slabGeometry(outer: number[], holes: number[][], thickness: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  for (let i = 0; i < outer.length / 2; i++) {
    if (i === 0) shape.moveTo(outer[0], -outer[1]);
    else shape.lineTo(outer[i * 2], -outer[i * 2 + 1]);
  }
  for (const h of holes) {
    const path = new THREE.Path();
    for (let i = 0; i < h.length / 2; i++) {
      if (i === 0) path.moveTo(h[0], -h[1]);
      else path.lineTo(h[i * 2], -h[i * 2 + 1]);
    }
    shape.holes.push(path);
  }
  const ext = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  ext.rotateX(-Math.PI / 2);
  return ext;
}

/** Hashed points inside the ring (and outside its holes) with their clearance to the nearest edge, deepest first. */
function interiorPoints(outer: number[], holes: number[][], box: Obb, seed: number, count: number): (Point & { d: number })[] {
  const cu = Math.cos(box.theta);
  const su = Math.sin(box.theta);
  const out: (Point & { d: number })[] = [];
  for (let i = 0; i < count; i++) {
    const a = (rand01(seed, 500 + i * 2) - 0.5) * box.len;
    const c = (rand01(seed, 501 + i * 2) - 0.5) * box.wid;
    const x = box.cx + a * cu - c * su;
    const z = box.cz + a * su + c * cu;
    if (!inRing(outer, x, z) || holes.some((h) => inRing(h, x, z))) continue;
    out.push({ x, z, d: Math.min(edgeDistance(outer, x, z), ...holes.map((h) => edgeDistance(h, x, z))) });
  }
  return out.sort((p, q) => q.d - p.d);
}

// --------------------------------------------------------------------- unfinished concrete frames

interface Frame {
  /** Metres from the ground to the top of the highest column or core. */
  top: number;
  cores: Point[];
}

/**
 * Podium under construction: bare floor slabs on a column grid, a lip of green safety netting with gaps, stair /
 * lift cores climbing ahead of the floors, and rebar stubs where the next storey will be poured. No windows.
 */
function concreteFrame(b: GeoBuilder, bd: Building): Frame {
  const outer = openRing(bd.pts);
  const holes = bd.holes.map(openRing).filter((h) => h.length >= 6);
  const n = outer.length / 2;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += outer[i * 2] * outer[j * 2 + 1] - outer[j * 2] * outer[i * 2 + 1];
  }
  const sgn = area >= 0 ? 1 : -1;
  area = Math.abs(area) / 2;
  const box = orientedBox(outer);
  const seed = bd.osm;

  const shape = FRAME_SHAPES[bd.osm];
  let storeys: number;
  if (shape) storeys = shape.storeys;
  else if (bd.height !== null) storeys = Math.round((bd.height / FLOOR_H) * 0.45);
  else if (bd.levels !== null) storeys = Math.round(bd.levels * 0.45);
  else if (area >= BIG_FOOTPRINT) storeys = 5 + Math.floor(rand01(seed, 1) * 2);
  else if (area >= 800) storeys = 4 + Math.floor(rand01(seed, 1) * 2);
  else storeys = 2 + Math.floor(rand01(seed, 1) * 2);
  storeys = Math.min(22, Math.max(2, storeys));
  const roof = storeys * FLOOR_H;

  // Floor slabs (the ground floor is the dirt itself). Slab k occupies [k·H − SLAB, k·H].
  const slab = slabGeometry(outer, holes, SLAB);
  const m = new THREE.Matrix4();
  for (let k = 1; k <= storeys; k++) b.add(slab, m.makeTranslation(0, k * FLOOR_H - SLAB, 0), CONCRETE_SLAB);
  slab.dispose();

  // Column grid in the footprint's own axes; the topmost lift stands bare with rebar sticking out.
  const u = { x: Math.cos(box.theta), z: Math.sin(box.theta) };
  const v = { x: -u.z, z: u.x };
  const nu = Math.max(2, Math.round(box.len / 7.5) + 1);
  const nv = Math.max(2, Math.round(box.wid / 7.5) + 1);
  const colRotY = -box.theta;
  let top = roof;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = -box.len / 2 + 0.7 + ((box.len - 1.4) * i) / (nu - 1);
      const c = -box.wid / 2 + 0.7 + ((box.wid - 1.4) * j) / (nv - 1);
      const x = box.cx + u.x * a + v.x * c;
      const z = box.cz + u.z * a + v.z * c;
      if (!inRing(outer, x, z) || holes.some((h) => inRing(h, x, z)) || edgeDistance(outer, x, z) < 0.45) continue;
      const lift = rand01(seed, 40 + i * 31 + j) < 0.72;
      const h = roof + (lift ? FLOOR_H - 0.4 : 0);
      b.box(0.55, h, 0.55, x, h / 2, z, CONCRETE_COL, undefined, colRotY);
      if (lift) {
        b.box(0.3, 1.5, 0.3, x, h + 0.75, z, REBAR, undefined, colRotY);
        top = Math.max(top, h + 1.5);
      }
    }
  }

  // Safety netting on the slab edges, with hashed gaps so the slabs and columns stay readable.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = outer[i * 2];
    const az = outer[i * 2 + 1];
    const dx = outer[j * 2] - ax;
    const dz = outer[j * 2 + 1] - az;
    const len = Math.hypot(dx, dz);
    if (len < 2) continue;
    const ox = (sgn * dz) / len;
    const oz = (-sgn * dx) / len;
    const yaw = Math.atan2(-dz, dx);
    for (let k = 1; k <= storeys; k++) {
      if (rand01(seed, 200 + i * 29 + k) < 0.38) continue;
      b.box(len, 1.15, 0.06, ax + dx / 2 + ox * 0.04, k * FLOOR_H + 0.575, az + dz / 2 + oz * 0.04, NET, undefined, yaw);
    }
  }

  // Stair / lift cores in the deepest spots, rising ahead of the floors, with a climbing-formwork deck on top.
  const deep = interiorPoints(outer, holes, box, seed, 400);
  const cores: Point[] = [];
  const want = shape ? shape.towers.length : area >= BIG_FOOTPRINT ? 2 : area >= 600 ? 1 : 0;
  const separation = shape ? 45 : 24;
  const coreW = shape ? 9 : 6;
  const coreD = shape ? 10 : 6.6;
  for (const p of deep) {
    if (cores.length >= want) break;
    if (p.d < 4 || cores.some((c) => Math.hypot(c.x - p.x, c.z - p.z) < separation)) continue;
    const k = cores.length;
    const levels = shape ? shape.towers[k] : 7 + Math.floor(rand01(seed, 70 + k) * 5);
    const h = roof + levels * FLOOR_H;
    const cy = Math.cos(colRotY);
    const sy = Math.sin(colRotY);
    const rot = (sx: number, sz: number): [number, number] => [p.x + sx * cy + sz * sy, p.z - sx * sy + sz * cy];
    b.box(coreW, h, coreD, p.x, h / 2, p.z, CONCRETE_CORE, undefined, colRotY);
    b.box(coreW + 0.6, 0.3, coreD + 0.6, p.x, h + 0.15, p.z, FORMWORK, undefined, colRotY);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const [x, z] = rot(sx * (coreW / 2 - 0.4), sz * (coreD / 2 - 0.4));
      b.box(0.3, 1.6, 0.3, x, h + 1.1, z, REBAR, undefined, colRotY);
    }
    // The tower proper: floor plates already poured around the core, three storeys behind it, on corner columns.
    const plates = levels - 3;
    const half = Math.min(shape ? shape.plate : 11, Math.max(4.5, p.d - 1.5));
    for (let f = 1; f <= plates; f++) b.box(half * 2, SLAB, half * 2, p.x, roof + f * FLOOR_H - SLAB / 2, p.z, CONCRETE_SLAB, undefined, colRotY);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const [x, z] = rot(sx * (half - 0.6), sz * (half - 0.6));
      const colH = plates * FLOOR_H + 1.2;
      b.box(0.7, colH, 0.7, x, roof + colH / 2, z, CONCRETE_COL, undefined, colRotY);
      b.box(0.3, 1.5, 0.3, x, roof + colH + 0.75, z, REBAR, undefined, colRotY);
    }
    top = Math.max(top, h + 1.9);
    cores.push({ x: p.x, z: p.z });
  }
  return { top, cores };
}

// --------------------------------------------------------------------- tower crane

/** Luffing-free tower crane: lattice mast, slewing deck, cat head, 46 m jib, counter-jib with ballast, trolley and hook block. */
function towerCrane(b: GeoBuilder, x: number, z: number, hm: number, yaw: number, seed: number): void {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  // Local (lx, ly, lz) with the jib along +lx → world.
  const P = (lx: number, ly: number, lz: number) => new THREE.Vector3(x + lx * cy + lz * sy, ly, z - lx * sy + lz * cy);
  const MW = 1.9;
  const BAY = 3.8;
  const T = 0.16;

  // Mast: four legs, a ring and one diagonal per face per bay (alternating direction).
  const corners: [number, number][] = [[-MW / 2, -MW / 2], [MW / 2, -MW / 2], [MW / 2, MW / 2], [-MW / 2, MW / 2]];
  for (const [cx, cz] of corners) rod(b, P(cx, 0, cz), P(cx, hm, cz), 0.28, CRANE);
  const bays = Math.floor(hm / BAY);
  for (let k = 0; k < bays; k++) {
    const y0 = k * BAY;
    const y1 = (k + 1) * BAY;
    for (let f = 0; f < 4; f++) {
      const [ax, az] = corners[f];
      const [bx, bz] = corners[(f + 1) % 4];
      rod(b, P(ax, y1, az), P(bx, y1, bz), T, CRANE);
      const flip = (k + f) % 2 === 0;
      rod(b, P(flip ? ax : bx, y0, flip ? az : bz), P(flip ? bx : ax, y1, flip ? bz : az), T * 0.8, CRANE);
    }
  }

  // Slewing deck, operator cab and cat head.
  b.box(2.6, 1.0, 2.6, x, hm + 0.5, z, CRANE_DARK, undefined, yaw);
  const cab = P(1.7, hm + 1.5, 1.7);
  b.box(1.5, 1.7, 1.5, cab.x, cab.y, cab.z, CRANE, undefined, yaw);
  const head = P(0, hm + 9, 0);
  b.place(new THREE.ConeGeometry(1.3, 8, 4), x, hm + 5, z, CRANE, undefined, [0, yaw + Math.PI / 4, 0]);
  b.box(0.5, 0.5, 0.5, head.x, head.y + 0.25, head.z, CRANE_DARK, { emis: 0xff2a2a, emisStrength: 2.4 });

  // Jib: two lower chords, one upper chord, zig-zag bracing.
  const JIB = 46;
  const COUNTER = 15;
  const lowY = hm + 1.3;
  const topY = hm + 3.4;
  rod(b, P(0, lowY, -0.9), P(JIB, lowY, -0.9), 0.2, CRANE);
  rod(b, P(0, lowY, 0.9), P(JIB, lowY, 0.9), 0.2, CRANE);
  rod(b, P(0, topY, 0), P(JIB, topY, 0), 0.2, CRANE);
  const JB = 3.2;
  const jibBays = Math.floor(JIB / JB);
  for (let i = 0; i < jibBays; i++) {
    const x0 = i * JB;
    const x1 = (i + 1) * JB;
    rod(b, P(x1, lowY, -0.9), P(x1, lowY, 0.9), T * 0.8, CRANE);
    for (const s of [-0.9, 0.9]) {
      if (i % 2 === 0) rod(b, P(x0, topY, 0), P(x1, lowY, s), T * 0.8, CRANE);
      else rod(b, P(x0, lowY, s), P(x1, topY, 0), T * 0.8, CRANE);
    }
  }
  // Counter-jib with concrete ballast.
  rod(b, P(-COUNTER, lowY, -0.9), P(0, lowY, -0.9), 0.2, CRANE);
  rod(b, P(-COUNTER, lowY, 0.9), P(0, lowY, 0.9), 0.2, CRANE);
  rod(b, P(-COUNTER, lowY, 0), P(0, topY, 0), 0.18, CRANE);
  for (let i = 1; i <= 4; i++) rod(b, P(-i * 3.4, lowY, -0.9), P(-i * 3.4, lowY, 0.9), T * 0.8, CRANE);
  for (const lx of [-12.6, -10.2, -7.8]) {
    const w = P(lx, lowY - 0.2, 0);
    b.box(2.1, 1.5, 2.5, w.x, w.y, w.z, CRANE_GREY, undefined, yaw);
  }
  // Pendant ropes from the cat head to the jib and the counter-jib.
  rod(b, head, P(JIB * 0.62, topY, 0), 0.07, CRANE_DARK);
  rod(b, head, P(JIB * 0.98, topY, 0), 0.07, CRANE_DARK);
  rod(b, head, P(-COUNTER, lowY, 0), 0.07, CRANE_DARK);
  // Trolley, hoist rope and a bucket of concrete.
  const trolleyX = JIB * (0.42 + 0.3 * rand01(seed, 3));
  const drop = 14 + 14 * rand01(seed, 4);
  const trolley = P(trolleyX, lowY - 0.5, 0);
  b.box(1.4, 0.5, 1.6, trolley.x, trolley.y, trolley.z, CRANE_DARK, undefined, yaw);
  rod(b, P(trolleyX, lowY - 0.7, 0), P(trolleyX, lowY - 0.7 - drop, 0), 0.05, CRANE_DARK);
  const hook = P(trolleyX, lowY - 0.7 - drop - 0.5, 0);
  b.box(0.7, 0.9, 0.7, hook.x, hook.y, hook.z, CRANE_DARK);
  if (rand01(seed, 5) < 0.7) {
    b.box(1.5, 1.2, 1.5, hook.x, hook.y - 1.4, hook.z, CRANE_GREY, undefined, yaw);
  }
}

// --------------------------------------------------------------------- site props

/** Containers, spoil heaps, a site office and rebar stacks scattered over a lot, clear of its edge and of the frames. */
function siteProps(b: GeoBuilder, site: Site, frames: Building[]): void {
  const outer = openRing(site.pts);
  const holes = site.holes.map(openRing).filter((h) => h.length >= 6);
  let area = 0;
  for (let i = 0; i < outer.length / 2; i++) {
    const j = (i + 1) % (outer.length / 2);
    area += outer[i * 2] * outer[j * 2 + 1] - outer[j * 2] * outer[i * 2 + 1];
  }
  area = Math.abs(area) / 2;
  if (area < 300) return;
  const box = orientedBox(outer);
  const want = Math.min(16, Math.max(2, Math.floor(area / 380)));
  const placed: Point[] = [];
  const cu = Math.cos(box.theta);
  const su = Math.sin(box.theta);
  const clearOfFrames = (x: number, z: number): boolean =>
    frames.every((f) => {
      const ring = openRing(f.pts);
      return !inRing(ring, x, z) && edgeDistance(ring, x, z) > 4;
    });
  for (let attempt = 0; attempt < want * 14 && placed.length < want; attempt++) {
    const a = (rand01(site.osm, 900 + attempt * 2) - 0.5) * box.len;
    const c = (rand01(site.osm, 901 + attempt * 2) - 0.5) * box.wid;
    const x = box.cx + a * cu - c * su;
    const z = box.cz + a * su + c * cu;
    if (!inRing(outer, x, z) || holes.some((h) => inRing(h, x, z)) || edgeDistance(outer, x, z) < 4.5) continue;
    if (!clearOfFrames(x, z) || placed.some((p) => Math.hypot(p.x - x, p.z - z) < 9)) continue;
    const k = placed.length;
    placed.push({ x, z });
    const yaw = (rand01(site.osm, 1100 + k) - 0.5) * Math.PI;
    const pick = rand01(site.osm, 1200 + k);
    if (pick < 0.3) {
      const col = CONTAINERS[Math.floor(rand01(site.osm, 1300 + k) * CONTAINERS.length)];
      b.box(6.05, 2.6, 2.44, x, 1.3, z, col, undefined, yaw);
      if (rand01(site.osm, 1400 + k) < 0.4) b.box(6.05, 2.6, 2.44, x, 3.9, z, CONTAINERS[Math.floor(rand01(site.osm, 1500 + k) * CONTAINERS.length)], undefined, yaw);
    } else if (pick < 0.55) {
      const r = 1.8 + 1.4 * rand01(site.osm, 1600 + k);
      b.place(new THREE.ConeGeometry(r, r * 0.8, 7), x, r * 0.4, z, rand01(site.osm, 1700 + k) < 0.5 ? 0xcfb98a : 0x8e8a82, undefined, [0, yaw, 0]);
    } else if (pick < 0.75) {
      b.box(6, 2.6, 2.6, x, 1.3, z, 0xe8e4d8, undefined, yaw);
      b.box(6.5, 0.2, 3.0, x, 2.7, z, 0x4a6f8a, undefined, yaw);
      const wx = Math.sin(yaw) * 1.32;
      const wz = Math.cos(yaw) * 1.32;
      b.box(2.4, 1.0, 0.12, x + wx, 1.6, z + wz, 0x2f3a3e, { emis: 0xffcf8a, emisStrength: 0.9 }, yaw);
    } else {
      b.box(5.5, 0.5, 1.0, x, 0.55, z, REBAR, undefined, yaw);
      b.box(5.8, 0.18, 1.3, x, 0.2, z, 0xcdb88a, undefined, yaw);
      b.box(5.5, 0.5, 1.0, x + Math.cos(yaw) * 0.2, 1.05, z - Math.sin(yaw) * 0.2 + 1.2, REBAR, undefined, yaw);
    }
  }
}

// --------------------------------------------------------------------- hoarding

interface Panel {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  nx: number;
  nz: number;
  edge: number;
  clear: number;
}

/** Corrugated panels along every edge of the lot, leaving the asphalt free and one truck gate near a street. */
function fence(site: Site, clearAt: (x: number, z: number) => number, out: { pos: number[]; nor: number[]; col: number[]; uv: number[] }, props: GeoBuilder): void {
  const rings = [site.pts, ...site.holes].map(openRing).filter((r) => r.length >= 6);
  const panels: Panel[] = [];
  let edgeId = 0;
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = ring[i * 2];
      const az = ring[i * 2 + 1];
      const dx = ring[j * 2] - ax;
      const dz = ring[j * 2 + 1] - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      const count = Math.max(1, Math.round(len / PANEL));
      for (let k = 0; k < count; k++) {
        const t0 = k / count;
        const t1 = (k + 1) / count;
        const x0 = ax + dx * t0;
        const z0 = az + dz * t0;
        const x1 = ax + dx * t1;
        const z1 = az + dz * t1;
        panels.push({ x0, z0, x1, z1, nx: dz / len, nz: -dx / len, edge: edgeId, clear: clearAt((x0 + x1) / 2, (z0 + z1) / 2) });
      }
      edgeId++;
    }
  }
  // Gate: a hashed panel (and its neighbour on the same edge) among those that front a street (`roadDist` saturates at 8 m).
  const gateOk = panels.map((p, i) => (p.clear >= ASPHALT_CLEAR && p.clear < 8 && panels[i + 1]?.edge === p.edge && panels[i + 1].clear >= ASPHALT_CLEAR ? i : -1)).filter((i) => i >= 0);
  const gate = gateOk.length ? gateOk[Math.floor(rand01(site.osm, 77) * gateOk.length)] : -1;
  const tint = new THREE.Color(HOARDING[Math.floor(rand01(site.osm, 78) * HOARDING.length)]);
  const post = 0x4a4a48;
  panels.forEach((p, i) => {
    if (p.clear < ASPHALT_CLEAR) return;
    if (i === gate || i === gate + 1) {
      if (i === gate) {
        // Gate posts at both ends of the 4.8 m opening, plus a guard hut just inside.
        const q = panels[gate + 1];
        const yaw = Math.atan2(-(q.z1 - p.z0), q.x1 - p.x0);
        props.box(0.3, 3.0, 0.3, p.x0, 1.5, p.z0, post, undefined, yaw);
        props.box(0.3, 3.0, 0.3, q.x1, 1.5, q.z1, post, undefined, yaw);
        const mx = (p.x0 + q.x1) / 2 - p.nx * 3.2;
        const mz = (p.z0 + q.z1) / 2 - p.nz * 3.2;
        props.box(2.0, 2.4, 2.0, mx, 1.2, mz, 0xe8e4d8, undefined, yaw);
        props.box(2.4, 0.18, 2.4, mx, 2.5, mz, 0xb5563a, undefined, yaw);
      }
      return;
    }
    const nx = p.nx;
    const nz = p.nz;
    const verts = [
      [p.x0, 0, p.z0, 0, 0],
      [p.x1, 0, p.z1, 1, 0],
      [p.x1, FENCE_H, p.z1, 1, 1],
      [p.x0, FENCE_H, p.z0, 0, 1],
    ];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const [x, y, z, u, v] = verts[k];
      out.pos.push(x, y, z);
      out.nor.push(nx, 0, nz);
      out.col.push(tint.r, tint.g, tint.b);
      out.uv.push(u, v);
    }
    // Wooden brace behind every fourth panel.
    if (i % 4 === 0) {
      const mx = (p.x0 + p.x1) / 2 - nx * 0.5;
      const mz = (p.z0 + p.z1) / 2 - nz * 0.5;
      props.box(0.1, 2.5, 0.1, mx, 1.25, mz, 0x7a5a3a, undefined, Math.atan2(-(p.z1 - p.z0), p.x1 - p.x0));
    }
  });
}

// --------------------------------------------------------------------- builder

export interface ConstructionResult {
  group: THREE.Group;
  counts: { sites: number; frames: number; cranes: number; panels: number; triangles: number };
}

export function buildConstruction(scene: SceneJson, roadClearance: (x: number, z: number) => number): ConstructionResult {
  const group = new THREE.Group();
  group.name = 'construction';

  const frames = scene.buildings.filter((bd) => bd.kind === 'construction');

  // ---- dirt lots: sandy ground, concrete pour pads and mud patches
  const ground = new FlatBuilder(1 / 8);
  const Y_DIRT = 0.008;
  const { sites } = resolveGround(scene);
  for (const site of sites) {
    const { verts, idx } = triangulate(site.pts, site.holes);
    const base = site.kind === 'brownfield' ? BROWNFIELD : DIRT[Math.floor(rand01(site.osm, 2) * DIRT.length)];
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 2;
      const bb = idx[i + 1] * 2;
      const c = idx[i + 2] * 2;
      ground.tri(verts[a], verts[a + 1], verts[bb], verts[bb + 1], verts[c], verts[c + 1], Y_DIRT, base);
    }
    const outer = openRing(site.pts);
    const holes = site.holes.map(openRing).filter((h) => h.length >= 6);
    const box = orientedBox(outer);
    const cu = Math.cos(box.theta);
    const su = Math.sin(box.theta);
    let area = 0;
    for (let i = 0; i < outer.length / 2; i++) {
      const j = (i + 1) % (outer.length / 2);
      area += outer[i * 2] * outer[j * 2 + 1] - outer[j * 2] * outer[i * 2 + 1];
    }
    area = Math.abs(area) / 2;
    const pads = Math.min(10, Math.floor(area / 500));
    let placed = 0;
    for (let attempt = 0; attempt < pads * 12 && placed < pads; attempt++) {
      const a = (rand01(site.osm, 300 + attempt * 3) - 0.5) * box.len;
      const c = (rand01(site.osm, 301 + attempt * 3) - 0.5) * box.wid;
      const hw = 3 + 6 * rand01(site.osm, 302 + attempt * 3);
      const hd = 3 + 5 * rand01(site.osm, 303 + attempt * 3);
      const mud = rand01(site.osm, 304 + attempt) < 0.35;
      const corner = (sa: number, sb: number): [number, number] => {
        const pa = a + sa * hw;
        const pb = c + sb * hd;
        return [box.cx + pa * cu - pb * su, box.cz + pa * su + pb * cu];
      };
      const q = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      if (!q.every(([x, z]) => inRing(outer, x, z) && !holes.some((h) => inRing(h, x, z)) && edgeDistance(outer, x, z) > 1.5)) continue;
      ground.quad(q[0][0], q[0][1], q[1][0], q[1][1], q[2][0], q[2][1], q[3][0], q[3][1], mud ? 0.009 : 0.010, mud ? MUD : PAD);
      placed++;
    }
  }
  const groundMesh = new THREE.Mesh(ground.build(), new THREE.MeshStandardMaterial({ vertexColors: true, map: asphaltTexture(), roughness: 1 }));
  groundMesh.name = 'site-ground';
  groundMesh.receiveShadow = true;
  group.add(groundMesh);

  // ---- structures: frames, cranes, props
  const solid = new GeoBuilder();
  let craneCount = 0;
  const frameInfo = new Map<number, Frame>();
  for (const bd of frames) frameInfo.set(bd.osm, concreteFrame(solid, bd));

  // Cranes stand on the biggest frame: one, or two (far apart, clear of the cores) on a large footprint.
  let largest: Building | null = null;
  let largestArea = 0;
  for (const bd of frames) {
    const ring = openRing(bd.pts);
    let a = 0;
    for (let i = 0; i < ring.length / 2; i++) {
      const j = (i + 1) % (ring.length / 2);
      a += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
    }
    a = Math.abs(a) / 2;
    if (a > largestArea) {
      largestArea = a;
      largest = bd;
    }
  }
  if (largest && largestArea >= 400) {
    const ring = openRing(largest.pts);
    const holes = largest.holes.map(openRing).filter((h) => h.length >= 6);
    const info = frameInfo.get(largest.osm)!;
    const spots = interiorPoints(ring, holes, orientedBox(ring), largest.osm, 600).filter((p) => p.d >= 3.5 && info.cores.every((c) => Math.hypot(c.x - p.x, c.z - p.z) >= 9));
    const picked: Point[] = [];
    const wantCranes = largestArea >= BIG_FOOTPRINT ? 2 : 1;
    // First crane: the spot farthest from the cores; the next one far from the previous crane.
    const far = (from: Point[]) =>
      spots
        .filter((p) => picked.every((q) => Math.hypot(q.x - p.x, q.z - p.z) >= 28))
        .sort((p, q) => Math.min(...from.map((c) => Math.hypot(q.x - c.x, q.z - c.z))) - Math.min(...from.map((c) => Math.hypot(p.x - c.x, p.z - c.z))))[0];
    while (picked.length < wantCranes) {
      const p = far(picked.length ? picked : info.cores.length ? info.cores : [{ x: spots[0]?.x ?? 0, z: spots[0]?.z ?? 0 }]);
      if (!p) break;
      picked.push(p);
    }
    picked.forEach((p, k) => {
      const mast = Math.max(50, info.top + 22) + k * 6;
      towerCrane(solid, p.x, p.z, mast, rand01(largest.osm, 600 + k) * Math.PI * 2, largest.osm + k);
      craneCount++;
    });
  }

  // ---- hoarding and props per lot
  const fenceBuf = { pos: [] as number[], nor: [] as number[], col: [] as number[], uv: [] as number[] };
  for (const site of sites) {
    const inside = frames.filter((f) => {
      const ring = openRing(f.pts);
      return inRing(openRing(site.pts), ring[0], ring[1]);
    });
    siteProps(solid, site, inside);
    fence(site, roadClearance, fenceBuf, solid);
  }

  const solidGeo = solid.build();
  const mat = makeMaterial({}, { roughness: 0.9 });
  const base = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    base.call(mat, shader, renderer);
    patchCutaway(shader);
  };
  mat.customProgramCacheKey = () => 'lowpoly:construction';
  const solidMesh = new THREE.Mesh(solidGeo, mat);
  solidMesh.name = 'site-structures';
  solidMesh.castShadow = true;
  solidMesh.receiveShadow = true;
  group.add(solidMesh);

  const fenceGeo = new THREE.BufferGeometry();
  fenceGeo.setAttribute('position', new THREE.Float32BufferAttribute(fenceBuf.pos, 3));
  fenceGeo.setAttribute('normal', new THREE.Float32BufferAttribute(fenceBuf.nor, 3));
  fenceGeo.setAttribute('color', new THREE.Float32BufferAttribute(fenceBuf.col, 3));
  fenceGeo.setAttribute('uv', new THREE.Float32BufferAttribute(fenceBuf.uv, 2));
  fenceGeo.computeBoundingSphere();
  const fenceMesh = new THREE.Mesh(fenceGeo, new THREE.MeshStandardMaterial({ vertexColors: true, map: corrugatedTexture(), roughness: 0.7, metalness: 0.15, side: THREE.DoubleSide }));
  fenceMesh.name = 'site-hoarding';
  fenceMesh.castShadow = true;
  fenceMesh.receiveShadow = true;
  group.add(fenceMesh);

  const triangles = solidGeo.getAttribute('position').count / 3 + fenceBuf.pos.length / 9;
  group.userData = { sites: sites.length, frames: frames.length, cranes: craneCount, triangles };
  if (import.meta.env.DEV) {
    console.info(`[construction] ${sites.length} lots, ${frames.length} concrete frames, ${craneCount} cranes, ${Math.round(triangles)} tris`);
  }
  return { group, counts: { sites: sites.length, frames: frames.length, cranes: craneCount, panels: fenceBuf.pos.length / 18, triangles } };
}
