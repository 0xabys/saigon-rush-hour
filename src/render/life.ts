import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { SceneJson } from '../data/q1Schema';
import type { Network, Segment } from '../sim/network';
import { PED_CAP, type Pedestrians } from '../sim/pedestrians';
import { GeoBuilder } from './geo';
import { makeMaterial } from './materials';

const SKIN = 0xc99a6e;
const CLOTHES = [0xf4f1e8, 0x9cc3e0, 0x2f3d5c, 0xc8463a, 0xd9a43b, 0xe8a3b5, 0x6f7d4a, 0x2b2b2b, 0x4d8c8a, 0xf2d68a];

function person(hat: boolean): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.box(0.16, 0.8, 0.14, 0, 0.4, 0.1, 0x34405a);
  b.box(0.16, 0.8, 0.14, 0, 0.4, -0.1, 0x34405a);
  b.box(0.26, 0.62, 0.42, 0, 1.12, 0, 0xffffff, { paint: 1 });
  b.place(new THREE.IcosahedronGeometry(0.14, 1), 0, 1.6, 0, SKIN);
  if (hat) b.place(new THREE.ConeGeometry(0.32, 0.2, 10), 0, 1.78, 0, 0xe9d8a6);
  else b.place(new THREE.SphereGeometry(0.15, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), 0, 1.64, 0, 0x2a2420);
  return b.build();
}

const WALKER_CAP = 1800;
/** Walkers stay this far from both ends of a link (junction crossings belong to the pedestrian sim). */
const WALK_MARGIN = 12;
/** Walkers keep to the kerb strip (metres from the asphalt edge); the pavement behind it is parked motorbikes (parked.ts). */
const WALK_NEAR = 0.45;
const WALK_FAR = 0.8;

interface Walker {
  seg: Segment;
  /** Lateral offset to the right of the link's reference line. */
  off: number;
  /** Start of the path and its length along the link; walker ping-pongs along it. */
  s0: number;
  len: number;
  speed: number;
  phase: number;
}

/** River centreline: polyline `pts` ([x, z, …]) with cumulative arc length per vertex and the total length. */
interface RiverRoute {
  pts: number[];
  cum: number[];
  length: number;
}

/**
 * Centreline of the 'Sông Sài Gòn' polygon: principal axis by PCA, then the middle of the widest
 * stretch of the polygon across that axis at regular steps.
 */
function riverRoute(scene: SceneJson): RiverRoute | null {
  const water = scene.water.find((w) => w.name === 'Sông Sài Gòn');
  if (!water) return null;
  const p = water.pts;
  const m = p.length / 2;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < m; i++) {
    cx += p[i * 2];
    cz += p[i * 2 + 1];
  }
  cx /= m;
  cz /= m;
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  for (let i = 0; i < m; i++) {
    const dx = p[i * 2] - cx;
    const dz = p[i * 2 + 1] - cz;
    sxx += dx * dx;
    sxz += dx * dz;
    szz += dz * dz;
  }
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ux = Math.cos(ang);
  const uz = Math.sin(ang);
  // Coordinates (a along the axis, b across it).
  const a = new Float64Array(m);
  const b = new Float64Array(m);
  let a0 = Infinity;
  let a1 = -Infinity;
  for (let i = 0; i < m; i++) {
    const dx = p[i * 2] - cx;
    const dz = p[i * 2 + 1] - cz;
    a[i] = dx * ux + dz * uz;
    b[i] = -dx * uz + dz * ux;
    a0 = Math.min(a0, a[i]);
    a1 = Math.max(a1, a[i]);
  }
  const steps = 40;
  const pts: number[] = [];
  for (let k = 0; k <= steps; k++) {
    const at = a0 + ((a1 - a0) * (k + 0.5)) / (steps + 1);
    const cuts: number[] = [];
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      if (a[i] <= at === a[j] <= at) continue;
      cuts.push(b[i] + ((b[j] - b[i]) * (at - a[i])) / (a[j] - a[i]));
    }
    cuts.sort((u, v) => u - v);
    let best = -1;
    let mid = 0;
    for (let i = 0; i + 1 < cuts.length; i += 2) {
      if (cuts[i + 1] - cuts[i] > best) {
        best = cuts[i + 1] - cuts[i];
        mid = (cuts[i] + cuts[i + 1]) / 2;
      }
    }
    if (best < 0) continue;
    pts.push(cx + at * ux - mid * uz, cz + at * uz + mid * ux);
  }
  if (pts.length < 4) return null;
  const cum = [0];
  for (let i = 1; i < pts.length / 2; i++) cum.push(cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]));
  return { pts, cum, length: cum[cum.length - 1] };
}

function cruiseBoat(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.box(16, 1.4, 4.6, 0, 0.2, 0, 0xf4f1ea);
  b.box(2, 1.4, 3, 8.6, 0.2, 0, 0xf4f1ea, {}, 0, 0, 0.25);
  b.box(16.1, 0.25, 4.7, 0, 0.75, 0, 0x2f6b9a);
  b.box(11, 1.8, 3.8, -1, 1.85, 0, 0x2a3540, { emis: 0xffcf8a, emisStrength: 1.6 });
  b.box(11.4, 0.2, 4.2, -1, 2.85, 0, 0xf4f1ea);
  for (let i = 0; i < 8; i++) {
    const c = [0xff5a3a, 0xffc24a, 0x5ad1ff, 0x7cff8a][i % 4];
    b.place(new THREE.IcosahedronGeometry(0.16, 0), -6 + i * 1.6, 3.15, 2, c, { emis: c, emisStrength: 3 });
    b.place(new THREE.IcosahedronGeometry(0.16, 0), -6 + i * 1.6, 3.15, -2, c, { emis: c, emisStrength: 3 });
  }
  b.box(0.12, 2.6, 0.12, 5, 4, 0, 0x3a3a3a);
  b.box(0.08, 0.6, 1, 5, 5, 0.55, 0xd9412b);
  return b.build();
}

function sandBarge(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.box(22, 1.2, 5.4, 0, 0, 0, 0x6a3a2a);
  b.box(22.1, 0.2, 5.5, 0, 0.55, 0, 0x2a2a2a);
  b.place(new THREE.ConeGeometry(2.6, 2.2, 4), -2, 1.6, 0, 0xd9b77a, {}, [0, Math.PI / 4, 0], [3, 1, 0.9]);
  b.box(3, 2, 3.6, 8.5, 1.5, 0, 0xe8e2d0, { emis: 0xffd9a0, emisStrength: 0.8 });
  b.box(3.4, 0.2, 4, 8.5, 2.6, 0, 0x3f7d74);
  return b.build();
}

function ferry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.box(9, 1, 3.4, 0, 0.1, 0, 0x2f7d74);
  b.box(9.1, 0.2, 3.5, 0, 0.6, 0, 0xf2e2b5);
  b.box(5, 1.6, 3, -0.6, 1.5, 0, 0xf4f1ea, { emis: 0xffe0a8, emisStrength: 1 });
  b.box(5.4, 0.18, 3.4, -0.6, 2.4, 0, 0xd9412b);
  return b.build();
}

export class Life {
  readonly group = new THREE.Group();
  private readonly walkers: Walker[] = [];
  private readonly people: THREE.InstancedMesh[];
  private readonly boats: { mesh: THREE.Mesh; speed: number; phase: number; lane: number }[] = [];
  private readonly route: RiverRoute | null;
  private readonly tmp = [0, 0, 0, 0];
  /** People on the carriageway: zebra crossers and nón-lá-wearing mid-block crossers. */
  private readonly crossers: THREE.InstancedMesh[];
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3(1, 1, 1);

  constructor(net: Network, scene: SceneJson) {
    const rng = new Rng(3131);
    // One pedestrian per ~22 m of link, on the right-hand pavement of each link.
    for (const l of net.links) {
      if (l.bridge || l.length < 60) continue;
      const n = Math.floor(l.length / 22);
      for (let k = 0; k < n; k++) {
        this.walkers.push({
          seg: l,
          off: l.halfW + rng.range(WALK_NEAR, WALK_FAR),
          s0: WALK_MARGIN,
          len: l.length - 2 * WALK_MARGIN,
          speed: rng.range(0.7, 1.3),
          phase: rng.next(),
        });
      }
    }
    // Shuffle so any crowd fraction is spread over the whole map, then cap.
    for (let i = this.walkers.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const w = this.walkers[i];
      this.walkers[i] = this.walkers[j];
      this.walkers[j] = w;
    }
    if (this.walkers.length > WALKER_CAP) this.walkers.length = WALKER_CAP;
    const mat = makeMaterial({}, { roughness: 0.8 });
    const col = new THREE.Color();
    this.people = [person(false), person(true)].map((g) => {
      const m = new THREE.InstancedMesh(g, mat, this.walkers.length);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = true;
      for (let i = 0; i < this.walkers.length; i++) m.setColorAt(i, col.setHex(rng.pick(CLOTHES)));
      this.group.add(m);
      return m;
    });

    const crossMat = makeMaterial({}, { roughness: 0.8 });
    this.crossers = [person(false), person(true)].map((g) => {
      const m = new THREE.InstancedMesh(g, crossMat, PED_CAP);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = true;
      m.count = 0;
      for (let i = 0; i < PED_CAP; i++) m.setColorAt(i, col.setHex(rng.pick(CLOTHES)));
      this.group.add(m);
      return m;
    });

    this.route = riverRoute(scene);
    const boatMat = makeMaterial({}, { roughness: 0.6 });
    // Geometry, speed (m/s), sideways lane (m) per boat.
    const defs: [THREE.BufferGeometry, number, number][] = [
      [cruiseBoat(), 4, -14],
      [sandBarge(), 2.8, 10],
      [ferry(), 5.5, -4],
      [cruiseBoat(), 3.2, 16],
      [sandBarge(), 2.3, 0],
    ];
    if (this.route) {
      defs.forEach(([geo, speed, lane], i) => {
        const mesh = new THREE.Mesh(geo, boatMat);
        mesh.castShadow = true;
        this.group.add(mesh);
        this.boats.push({ mesh, speed, phase: i * 0.21, lane });
      });
    }
  }

  updateCrossers(peds: Pedestrians, t: number): void {
    const counts = [0, 0];
    for (let p = 0; p < peds.hi; p++) {
      if (!peds.active[p]) continue;
      const k = peds.kind[p];
      const bob = Math.abs(Math.sin(t * 6 * peds.speed[p] + peds.seed[p])) * 0.06;
      this.pos.set(peds.x[p], bob, peds.z[p]);
      this.q.setFromAxisAngle(this.up, Math.atan2(-peds.dz[p], peds.dx[p]));
      this.crossers[k].setMatrixAt(counts[k]++, this.m4.compose(this.pos, this.q, this.scl));
    }
    this.crossers.forEach((m, k) => {
      m.count = counts[k];
      m.instanceMatrix.needsUpdate = true;
    });
  }

  update(t: number, hour: number): void {
    // Streets fill up in the evening; few people in the small hours.
    const crowd = hour < 5 ? 0.15 : hour < 7 ? 0.4 : hour < 16 ? 0.6 : hour < 23 ? 1 : 0.35;
    const visible = Math.floor(this.walkers.length * crowd);
    const counts = [0, 0];
    const p = this.tmp;
    for (let i = 0; i < visible; i++) {
      const w = this.walkers[i];
      const u = (t * w.speed) / w.len + w.phase;
      const f = u - Math.floor(u);
      const forward = f < 0.5;
      const s = w.s0 + (forward ? f * 2 : 2 - f * 2) * w.len;
      const dir = forward ? 1 : -1;
      w.seg.sample(s, p);
      const bob = Math.abs(Math.sin(t * w.speed * 5 + i)) * 0.06;
      // Right-hand side of the travel direction of the link is (−tz, tx).
      this.pos.set(p[0] - p[3] * w.off, bob, p[1] + p[2] * w.off);
      this.q.setFromAxisAngle(this.up, Math.atan2(-p[3] * dir, p[2] * dir));
      const mesh = i % 5 === 0 ? 1 : 0;
      this.people[mesh].setMatrixAt(counts[mesh]++, this.m4.compose(this.pos, this.q, this.scl));
    }
    this.people.forEach((m, k) => {
      m.count = counts[k];
      m.instanceMatrix.needsUpdate = true;
    });

    const route = this.route;
    if (!route) return;
    for (const b of this.boats) {
      // Ping-pong along the river, running a little past both ends so the turn happens out of sight.
      const span = route.length + 40;
      const u = (t * b.speed) / span + b.phase;
      const f = u - Math.floor(u);
      const forward = f < 0.5;
      const s = (forward ? f * 2 : 2 - f * 2) * span - 20;
      this.routeAt(route, s, b.lane, this.tmp);
      const hx = forward ? this.tmp[2] : -this.tmp[2];
      const hz = forward ? this.tmp[3] : -this.tmp[3];
      const edge = Math.min(s, route.length - s);
      const sc = Math.max(0.001, Math.min(1, edge / 14));
      b.mesh.position.set(this.tmp[0], 0.1 + Math.sin(t * 1.3 + b.phase * 9) * 0.04, this.tmp[1]);
      b.mesh.rotation.set(0, Math.atan2(-hz, hx), Math.sin(t * 0.9 + b.phase * 5) * 0.015);
      b.mesh.scale.setScalar(sc);
    }
  }

  /** Position (out[0..1]) and unit tangent (out[2..3]) at arc length `s` along the river centreline, shifted sideways by `lane`. */
  private routeAt(route: RiverRoute, s: number, lane: number, out: number[]): void {
    const c = Math.min(route.length, Math.max(0, s));
    const n = route.cum.length;
    let i = 0;
    while (i < n - 2 && route.cum[i + 1] < c) i++;
    const seg = route.cum[i + 1] - route.cum[i] || 1e-6;
    const u = Math.min(1, Math.max(0, (c - route.cum[i]) / seg));
    const x0 = route.pts[i * 2];
    const z0 = route.pts[i * 2 + 1];
    const dx = (route.pts[i * 2 + 2] - x0) / seg;
    const dz = (route.pts[i * 2 + 3] - z0) / seg;
    out[0] = x0 + (route.pts[i * 2 + 2] - x0) * u - dz * lane;
    out[1] = z0 + (route.pts[i * 2 + 3] - z0) * u + dx * lane;
    out[2] = dx;
    out[3] = dz;
  }
}
