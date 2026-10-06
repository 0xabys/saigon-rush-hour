import * as THREE from 'three';
import { Rng } from '../core/rng';
import { RIVER, ROAD_HALF, SIDEWALK, WORLD, type Network } from '../sim/network';
import { PED_CAP, type Pedestrians } from '../sim/pedestrians';
import { GeoBuilder } from './geo';
import { makeMaterial } from './materials';
import { SITES } from './zones';

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

interface Walker {
  /** Path start, unit direction, length; walker ping-pongs along it. */
  x: number;
  z: number;
  dx: number;
  dz: number;
  len: number;
  speed: number;
  phase: number;
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
  private readonly boats: { mesh: THREE.Mesh; x: number; speed: number; phase: number; dir: number }[] = [];
  /** People on the carriageway: zebra crossers and nón-lá-wearing mid-block crossers. */
  private readonly crossers: THREE.InstancedMesh[];
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3(1, 1, 1);

  constructor(net: Network) {
    const rng = new Rng(3131);
    // Evening crowds on Nguyễn Huệ first, so they're the last to disappear as the count drops.
    for (let i = 0; i < 160; i++) {
      const x = rng.range(SITES.plaza.x0 + 1.5, SITES.plaza.x1 - 1.5);
      if (Math.abs(Math.abs(x) - 4.5) < 1.3) continue;
      this.walkers.push({ x, z: -55, dx: 0, dz: 1, len: 108, speed: rng.range(0.7, 1.4), phase: rng.next() });
    }
    for (let i = 0; i < 50; i++) {
      this.walkers.push({ x: rng.range(141, 149), z: WORLD.minZ + 4, dx: 0, dz: 1, len: 85, speed: rng.range(0.8, 1.4), phase: rng.next() });
      this.walkers.push({ x: rng.range(141, 149), z: -58, dx: 0, dz: 1, len: 224, speed: rng.range(0.8, 1.4), phase: rng.next() });
    }
    for (const r of net.roads) {
      if (r.bridge || r.length < 60) continue;
      for (const side of [1, -1]) {
        const n = Math.floor(r.length / 22);
        for (let k = 0; k < n; k++) {
          const off = ROAD_HALF + SIDEWALK * rng.range(0.55, 0.85);
          const t0 = 32;
          this.walkers.push({
            x: r.a.x + r.dx * t0 - r.dz * side * off,
            z: r.a.z + r.dz * t0 + r.dx * side * off,
            dx: r.dx,
            dz: r.dz,
            len: r.length - 64,
            speed: rng.range(0.7, 1.3),
            phase: rng.next(),
          });
        }
      }
    }
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

    const boatMat = makeMaterial({}, { roughness: 0.6 });
    const defs: [THREE.BufferGeometry, number, number][] = [
      [cruiseBoat(), 1.6, 1],
      [sandBarge(), 1.1, -1],
      [ferry(), 2.2, 1],
      [cruiseBoat(), 1.3, -1],
      [sandBarge(), 0.9, 1],
    ];
    defs.forEach(([geo, speed, dir], i) => {
      const mesh = new THREE.Mesh(geo, boatMat);
      mesh.castShadow = true;
      this.group.add(mesh);
      this.boats.push({ mesh, x: dir > 0 ? RIVER.x1 - 13 - (i % 2) * 4 : RIVER.x0 + 12 + (i % 2) * 4, speed, phase: i * 0.21, dir });
    });
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
    // Nguyễn Huệ fills up in the evening; few people in the small hours.
    const crowd = hour < 5 ? 0.15 : hour < 7 ? 0.4 : hour < 16 ? 0.6 : hour < 23 ? 1 : 0.35;
    const visible = Math.floor(this.walkers.length * crowd);
    const counts = [0, 0];
    for (let i = 0; i < visible; i++) {
      const w = this.walkers[i];
      const u = (t * w.speed) / w.len + w.phase;
      const f = u - Math.floor(u);
      const forward = f < 0.5;
      const s = (forward ? f * 2 : 2 - f * 2) * w.len;
      const dir = forward ? 1 : -1;
      const bob = Math.abs(Math.sin(t * w.speed * 5 + i)) * 0.06;
      this.pos.set(w.x + w.dx * s, bob, w.z + w.dz * s);
      this.q.setFromAxisAngle(this.up, Math.atan2(-w.dz * dir, w.dx * dir));
      const mesh = i % 5 === 0 ? 1 : 0;
      this.people[mesh].setMatrixAt(counts[mesh]++, this.m4.compose(this.pos, this.q, this.scl));
    }
    this.people.forEach((m, k) => {
      m.count = counts[k];
      m.instanceMatrix.needsUpdate = true;
    });

    const span = WORLD.maxZ - WORLD.minZ + 40;
    for (const b of this.boats) {
      const u = (t * b.speed) / span + b.phase;
      const f = u - Math.floor(u);
      const z = b.dir > 0 ? WORLD.minZ - 20 + f * span : WORLD.maxZ + 20 - f * span;
      // Fade in/out at the diorama edge.
      const edge = Math.min(z - WORLD.minZ, WORLD.maxZ - z);
      const s = Math.max(0.001, Math.min(1, edge / 14));
      b.mesh.position.set(b.x, -0.9 + Math.sin(t * 1.3 + b.phase * 9) * 0.06, z);
      b.mesh.rotation.set(0, b.dir > 0 ? -Math.PI / 2 : Math.PI / 2, Math.sin(t * 0.9 + b.phase * 5) * 0.015);
      b.mesh.scale.setScalar(s);
    }
  }
}
