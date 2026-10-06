import * as THREE from 'three';
import { Rng } from '../core/rng';
import { RIVER, ROAD_HALF, SIDEWALK, WORLD, type MapNode, type Network } from '../sim/network';
import { GeoBuilder, shedGeometry } from './geo';
import { makeMaterial, shared } from './materials';
import { signAtlas } from './textures';
import { parkedScooterGeometry } from './vehicleModels';
import { SITES, type Zoning } from './zones';

const WALLS = [0xe3b448, 0xefe2c4, 0xd9a23e, 0xb8d4b0, 0xe8a07f, 0xa9c9d6, 0xf2eee4, 0xf2d68a, 0xdb8f6e, 0x9fcfc4, 0xe9c9a0, 0xf0d0a0];
const AWNINGS = [0xc8463a, 0x2f6b9a, 0x3f8f5a, 0xe0a33a, 0xd96c3a, 0xf0e6d0, 0x2f7d74];
const MIDRISE = [0xe9dcc0, 0xd8cbb0, 0xc9d3cf, 0xe6c88f, 0xf0ebe0, 0xbfc9c2, 0xe3d2b4];
const GLASS_TOWERS = [0x8fb3b8, 0x9fb8b0, 0xa7c0c6, 0xb9c4bd];
const STOOLS = [0xd93b2f, 0x2f6fb5, 0x3f9a5a, 0xe8b23a];
const TILE = 0xb5563a;
const STEEL = 0xc9ccd0;

const HOUSE_W = 4;
const HOUSE_D = 15;
const GF = 3.8;
const FH = 3.1;

interface HouseVariant {
  floors: number;
  roof: 'tile' | 'flat' | 'garden';
  shutter: number;
}

const HOUSE_VARIANTS: HouseVariant[] = [
  { floors: 2, roof: 'tile', shutter: 0x4f8a64 },
  { floors: 3, roof: 'tile', shutter: 0x3f6f8f },
  { floors: 4, roof: 'flat', shutter: 0x7a5236 },
  { floors: 5, roof: 'tile', shutter: 0x4f8a64 },
  { floors: 3, roof: 'garden', shutter: 0x7a5236 },
  { floors: 4, roof: 'tile', shutter: 0x5d8fa0 },
];

const cyl = (r: number, h: number, seg = 10) => new THREE.CylinderGeometry(r, r, h, seg);

function waterTank(b: GeoBuilder, x: number, y: number, z: number): void {
  b.box(1.1, 0.5, 1.1, x, y + 0.25, z, 0x6f6a62);
  b.place(cyl(0.48, 1.3), x, y + 1.15, z, STEEL, {}, [0, 0, Math.PI / 2]);
}

function tubeHouse(v: HouseVariant): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const W = HOUSE_W;
  const D = HOUSE_D;
  const H = GF + (v.floors - 1) * FH;
  const front = D / 2;
  b.box(W, H, D, 0, H / 2, 0, 0xffffff, { paint: 1 });
  // Ground-floor shop: open front with warm interior light, half-raised shutter, awning.
  b.box(W * 0.84, 2.75, 0.25, 0, 1.4, front + 0.02, 0x3a2e24, { emis: 0xffc070, emisStrength: 1.8 });
  b.box(W * 0.84, 0.5, 0.12, 0, 2.55, front + 0.12, 0xb9b4a8);
  b.box(W * 0.98, 0.08, 1.45, 0, 2.86, front + 0.68, 0xffffff, { paint: 2 }, 0, 0.3);
  for (let f = 1; f < v.floors; f++) {
    const y0 = GF + (f - 1) * FH;
    b.box(W * 0.96, 0.14, 0.95, 0, y0 + 0.07, front + 0.47, 0xd9d2c3);
    b.box(W * 0.96, 0.78, 0.05, 0, y0 + 0.52, front + 0.92, 0x3e4a43);
    b.box(W * 0.66, 2.15, 0.1, 0, y0 + 1.25, front + 0.03, v.shutter, { emis: 0xffd28a, emisStrength: 0.75 });
    b.box(0.38, 0.38, 0.38, -W * 0.38, y0 + 0.33, front + 0.6, 0x4f8f3f);
    b.place(new THREE.IcosahedronGeometry(0.32, 0), -W * 0.38, y0 + 0.75, front + 0.6, 0x5e9e48);
    if (f % 2 === 1) b.box(0.62, 0.42, 0.32, W * 0.36, y0 + 2.45, front + 0.17, 0xe6e4dc);
  }
  if (v.roof === 'tile') {
    b.place(shedGeometry(W + 0.3, 2, 0.15, 6.5), 0, H, front - 3.25 + 0.35, TILE);
    b.box(W, 0.5, D - 6.5, 0, H + 0.25, -3.25, 0xffffff, { paint: 1 });
    waterTank(b, 0.8, H + 0.5, -front + 2.5);
  } else {
    b.box(W, 0.7, 0.15, 0, H + 0.35, front - 0.07, 0xffffff, { paint: 1 });
    b.box(0.15, 0.7, D, -W / 2 + 0.07, H + 0.35, 0, 0xffffff, { paint: 1 });
    b.box(0.15, 0.7, D, W / 2 - 0.07, H + 0.35, 0, 0xffffff, { paint: 1 });
    waterTank(b, -0.7, H, -front + 2.5);
    if (v.roof === 'garden') {
      b.box(W * 0.8, 0.4, 0.8, 0, H + 0.2, front - 1, 0x6b4a32);
      for (let i = 0; i < 3; i++) b.place(new THREE.IcosahedronGeometry(0.5, 0), -1.1 + i * 1.1, H + 0.75, front - 1, 0x5f9a45);
      b.place(new THREE.ConeGeometry(1.4, 0.5, 8), 0.6, H + 2.2, 0.5, 0xc8463a);
      b.place(cyl(0.05, 2), 0.6, H + 1, 0.5, 0x6f6a62);
    } else {
      b.box(1.6, 1.2, 1.6, 0.8, H + 0.6, 1, 0xffffff, { paint: 1 });
    }
  }
  return b.build();
}

function midrise(floors: number, roofDetail: number): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const S = 10;
  const H = floors * 3.2 + 0.6;
  b.box(S, H, S, 0, H / 2, 0, 0xffffff, { paint: 1 });
  for (let f = 0; f < floors; f++) {
    b.box(S + 0.12, 1.25, S + 0.12, 0, f * 3.2 + 1.9, 0, 0x2c3a40, { emis: 0xffd9a0, emisStrength: 0.32 });
  }
  b.box(S, 0.8, 0.25, 0, H + 0.4, S / 2 - 0.12, 0xffffff, { paint: 1 });
  b.box(S, 0.8, 0.25, 0, H + 0.4, -S / 2 + 0.12, 0xffffff, { paint: 1 });
  b.box(0.25, 0.8, S, S / 2 - 0.12, H + 0.4, 0, 0xffffff, { paint: 1 });
  b.box(0.25, 0.8, S, -S / 2 + 0.12, H + 0.4, 0, 0xffffff, { paint: 1 });
  waterTank(b, -2.5, H, -2.5);
  waterTank(b, -0.5, H, -2.5);
  b.box(2.2, 2, 2.2, 2.5, H + 1, 2, 0xd9d4c8);
  if (roofDetail === 1) {
    // Rooftop billboard frame.
    b.box(6, 2.4, 0.2, 0, H + 3.2, 3.5, 0xc8463a, { emis: 0xff9a5a, emisStrength: 0.6 });
    b.box(0.2, 2.2, 0.2, -2.5, H + 1.1, 3.5, 0x4a4a4a);
    b.box(0.2, 2.2, 0.2, 2.5, H + 1.1, 3.5, 0x4a4a4a);
  } else if (roofDetail === 2) {
    b.place(cyl(0.08, 5), 3.5, H + 2.5, -3.5, 0x6f6a62);
    b.box(1.6, 1.2, 1.6, -3, H + 0.6, 2.8, 0xe6e4dc);
  }
  return b.build();
}

function glassTower(floors: number): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const S = 12;
  const FHT = 3.4;
  const H = floors * FHT;
  b.box(S, 4.5, S + 2, 0, 2.25, 0, 0xd9d2c3);
  b.box(S, H, S, 0, H / 2 + 4.5, 0, 0xffffff, { paint: 1 });
  for (let f = 0; f < floors; f++) {
    b.box(S + 0.1, 0.35, S + 0.1, 0, 4.5 + f * FHT + 0.2, 0, 0xe8ecea, { emis: 0xfff0d0, emisStrength: 0.25 });
    b.box(S + 0.06, 2.4, S + 0.06, 0, 4.5 + f * FHT + 1.7, 0, 0x45606a, { emis: 0xffe2b0, emisStrength: 0.3 });
  }
  for (let i = -2; i <= 2; i++) {
    b.box(0.25, H, 0.4, i * 2.6, H / 2 + 4.5, S / 2 + 0.15, 0xe8ecea);
    b.box(0.25, H, 0.4, i * 2.6, H / 2 + 4.5, -S / 2 - 0.15, 0xe8ecea);
  }
  b.box(S - 3, 3, S - 3, 0, H + 6, 0, 0xffffff, { paint: 1 });
  // Lit crown band wrapping the top storey (its top face sits inside the roof box).
  b.box(S - 2.9, 0.4, S - 2.9, 0, H + 7.0, 0, 0xe8ecea, { emis: 0xcfe8ff, emisStrength: 0.6 });
  return b.build();
}

function stoolGroupGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.box(0.8, 0.5, 0.8, 0, 0.25, 0, 0xd0d0cc);
  for (const [x, z] of [
    [0.75, 0],
    [-0.75, 0],
    [0, 0.75],
    [0, -0.75],
  ]) {
    b.box(0.34, 0.36, 0.34, x, 0.18, z, 0xffffff, { paint: 1 });
  }
  // Bánh mì cart with a glass case and a warm lamp.
  b.box(1.4, 0.8, 0.7, 1.8, 0.75, 0.2, 0x2f6b9a);
  b.box(1.3, 0.55, 0.6, 1.8, 1.42, 0.2, 0xcfe3e6, { emis: 0xffd590, emisStrength: 1.5 });
  b.box(1.5, 0.08, 0.8, 1.8, 1.75, 0.2, 0xc8463a);
  b.place(cyl(0.22, 0.08), 1.25, 0.25, 0.6, 0x222222, {}, [Math.PI / 2, 0, 0]);
  b.place(cyl(0.22, 0.08), 2.35, 0.25, 0.6, 0x222222, {}, [Math.PI / 2, 0, 0]);
  return b.build();
}

interface Frontage {
  ax: number;
  az: number;
  dx: number;
  dz: number;
  /** Unit normal pointing away from the street, toward the building. */
  nx: number;
  nz: number;
  t0: number;
  t1: number;
  setback: number;
}

export interface BuildingsResult {
  group: THREE.Group;
  /** Spots in front of shops on the sidewalk, used for vendors and pedestrians. */
  shopFronts: { x: number; z: number; fx: number; fz: number }[];
}

export function buildBuildings(net: Network, zoning: Zoning): BuildingsResult {
  const group = new THREE.Group();
  group.name = 'buildings';
  const rng = new Rng(4242);
  const mat = makeMaterial({ color2: true, instLight: true });
  const matrix = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();

  const frontages: Frontage[] = [];
  const trimAt = (n: MapNode) => (n.kind === 'portal' ? 1 : n.kind === 'ring' ? 30 : ROAD_HALF + SIDEWALK + 0.4);
  for (const r of net.roads) {
    if (r.bridge) continue;
    for (const side of [1, -1]) {
      frontages.push({
        ax: r.a.x,
        az: r.a.z,
        dx: r.dx,
        dz: r.dz,
        nx: -r.dz * side,
        nz: r.dx * side,
        t0: trimAt(r.a),
        t1: r.length - trimAt(r.b),
        setback: ROAD_HALF + SIDEWALK + 0.25,
      });
    }
  }
  // Nguyễn Huệ walking street: shophouses face the plaza from both sides.
  frontages.push({ ax: SITES.plaza.x0, az: -57, dx: 0, dz: 1, nx: -1, nz: 0, t0: 0, t1: 114, setback: 0.6 });
  frontages.push({ ax: SITES.plaza.x1, az: -57, dx: 0, dz: 1, nx: 1, nz: 0, t0: 0, t1: 114, setback: 0.6 });

  type House = { x: number; z: number; yaw: number; w: number; d: number; v: number; wall: number; awning: number; light: number; sign: number };
  const houses: House[] = [];
  const shopFronts: BuildingsResult['shopFronts'] = [];
  for (const f of frontages) {
    let t = f.t0;
    while (t < f.t1) {
      const w = rng.range(3.6, 5.4);
      if (t + w > f.t1) break;
      if (rng.next() < 0.07) {
        t += 1.8; // a hẻm (alley) between houses
        continue;
      }
      const d = rng.range(12.5, 15.5);
      const c = t + w / 2;
      const off = f.setback + d / 2;
      const x = f.ax + f.dx * c + f.nx * off;
      const z = f.az + f.dz * c + f.nz * off;
      if (zoning.rectFree(x, z, f.dx, f.dz, w / 2 - 0.15, d / 2 - 0.15, f.setback < 1 ? SITES.plaza : undefined)) {
        zoning.stamp(x, z, f.dx, f.dz, w / 2, d / 2, 0.05);
        const v = rng.int(HOUSE_VARIANTS.length);
        houses.push({
          x,
          z,
          yaw: Math.atan2(-f.nx, -f.nz),
          w,
          d,
          v,
          wall: rng.pick(WALLS),
          awning: rng.pick(AWNINGS),
          light: rng.next() < 0.12 ? 0.08 : rng.range(0.45, 1.1),
          sign: rng.next() < 0.85 ? rng.int(8) : -1,
        });
        shopFronts.push({ x: x - f.nx * (d / 2 + 1.9), z: z - f.nz * (d / 2 + 1.9), fx: -f.nx, fz: -f.nz });
      }
      t += w + 0.04;
    }
  }

  const makeInstanced = (geo: THREE.BufferGeometry, count: number, shadow = true) => {
    const c2 = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    const lit = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    geo.setAttribute('aColor2', c2);
    geo.setAttribute('instLight', lit);
    const m = new THREE.InstancedMesh(geo, mat, count);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    m.castShadow = shadow;
    m.receiveShadow = true;
    return { m, c2, lit };
  };

  // ---- tube houses
  HOUSE_VARIANTS.forEach((variant, vi) => {
    const list = houses.filter((h) => h.v === vi);
    if (!list.length) return;
    const { m, c2, lit } = makeInstanced(tubeHouse(variant), list.length);
    list.forEach((h, k) => {
      q.setFromAxisAngle(up, h.yaw);
      matrix.compose(new THREE.Vector3(h.x, 0, h.z), q, new THREE.Vector3(h.w / HOUSE_W, 1, h.d / HOUSE_D));
      m.setMatrixAt(k, matrix);
      m.setColorAt(k, col.setHex(h.wall));
      col.setHex(h.awning);
      c2.setXYZ(k, col.r, col.g, col.b);
      lit.setX(k, h.light);
    });
    group.add(m);
  });

  // ---- shop signs (one instanced mesh, rows of a text atlas)
  const signed = houses.filter((h) => h.sign >= 0);
  const signGeo = new THREE.PlaneGeometry(3.4, 0.64);
  const signRow = new THREE.InstancedBufferAttribute(new Float32Array(signed.length), 1);
  const signLit = new THREE.InstancedBufferAttribute(new Float32Array(signed.length), 1);
  signGeo.setAttribute('signRow', signRow);
  signGeo.setAttribute('instLight', signLit);
  const signMat = new THREE.MeshStandardMaterial({ map: signAtlas(), roughness: 0.6 });
  signMat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = shared.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float signRow;\nattribute float instLight;\nvarying float vLit;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv.y = (vMapUv.y + signRow) / 8.0;\nvLit = instLight;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying float vLit;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uNight * 0.9 * vLit;');
  };
  const signs = new THREE.InstancedMesh(signGeo, signMat, signed.length);
  const local = new THREE.Matrix4().makeTranslation(0, GF - 0.42, HOUSE_D / 2 + 0.07);
  signed.forEach((h, k) => {
    q.setFromAxisAngle(up, h.yaw);
    matrix.compose(new THREE.Vector3(h.x, 0, h.z), q, new THREE.Vector3(h.w / HOUSE_W, 1, h.d / HOUSE_D));
    matrix.multiply(local);
    signs.setMatrixAt(k, matrix);
    signRow.setX(k, 7 - h.sign);
    signLit.setX(k, Math.max(0.5, h.light));
  });
  group.add(signs);

  // ---- mid-rise blocks filling the interiors
  type Mid = { x: number; z: number; s: number; floors: number; kind: number; wall: number; light: number; rot: number };
  const mids: Mid[] = [];
  for (let gx = WORLD.minX + 8; gx < RIVER.x0 - 20; gx += 11) {
    for (let gz = WORLD.minZ + 8; gz < WORLD.maxZ - 6; gz += 11) {
      const x = gx + rng.range(-2.5, 2.5);
      const z = gz + rng.range(-2.5, 2.5);
      const s = rng.range(0.8, 1.2);
      const hs = 5 * s;
      // Leave courtyards and gaps so the tube-house rows stay the stars.
      if (rng.next() < 0.35 || !zoning.rectFree(x, z, 1, 0, hs, hs)) continue;
      zoning.stamp(x, z, 1, 0, hs, hs, 0.8);
      const eastness = (x - WORLD.minX) / (RIVER.x0 - WORLD.minX);
      const floors = Math.round(rng.range(2, 4.5) + eastness * rng.range(0, 4));
      mids.push({ x, z, s, floors, kind: rng.int(3), wall: rng.pick(MIDRISE), light: rng.range(0.3, 1), rot: rng.int(4) * (Math.PI / 2) });
    }
  }
  const floorBuckets = [3, 5, 7, 9];
  floorBuckets.forEach((floors, bi) => {
    for (let kind = 0; kind < 3; kind++) {
      const list = mids.filter((m) => {
        const b = m.floors <= 3 ? 0 : m.floors <= 5 ? 1 : m.floors <= 7 ? 2 : 3;
        return b === bi && m.kind === kind;
      });
      if (!list.length) continue;
      const { m, lit } = makeInstanced(midrise(floors, kind), list.length);
      list.forEach((h, k) => {
        q.setFromAxisAngle(up, h.rot);
        matrix.compose(new THREE.Vector3(h.x, 0, h.z), q, new THREE.Vector3(h.s, 1, h.s));
        m.setMatrixAt(k, matrix);
        m.setColorAt(k, col.setHex(h.wall));
        lit.setX(k, h.light);
      });
      group.add(m);
    }
  });

  // ---- glass towers: the Đồng Khởi / riverside skyline and Thủ Thiêm
  const towerSpots: [number, number, number][] = [
    [100, -150, 15],
    [70, -152, 12],
    [100, 150, 13],
    [60, 152, 10],
    [-70, -152, 11],
    [-90, 152, 9],
    [272, -152, 13],
    [214, -152, 11],
    [270, -100, 16],
    [222, 118, 12],
    [258, 148, 14],
    [270, 40, 10],
    [232, 4, 8],
    [266, -12, 12],
    [240, 72, 9],
    [272, 96, 11],
    [226, -104, 10],
  ];
  const towers: { x: number; z: number; floors: number; c: number }[] = [];
  for (const [x, z, floors] of towerSpots) {
    if (!zoning.rectFree(x, z, 1, 0, 6.5, 7.5)) continue;
    zoning.stamp(x, z, 1, 0, 6.5, 6.5, 1);
    towers.push({ x, z, floors, c: rng.pick(GLASS_TOWERS) });
  }
  for (const t of towers) {
    const { m, lit } = makeInstanced(glassTower(t.floors), 1);
    m.setMatrixAt(0, matrix.makeTranslation(t.x, 0, t.z));
    m.setColorAt(0, col.setHex(t.c));
    lit.setX(0, 0.9);
    group.add(m);
  }

  // ---- parked scooters on the sidewalks and street-food corners
  const bikes: THREE.Matrix4[] = [];
  const bikeColors: number[] = [];
  const stools: { x: number; z: number; yaw: number; c: number }[] = [];
  for (const s of shopFronts) {
    const along = { x: -s.fz, z: s.fx };
    const roll = rng.next();
    if (roll < 0.62) {
      const n = 1 + rng.int(3);
      for (let i = 0; i < n; i++) {
        const o = (i - (n - 1) / 2) * 0.95 + rng.range(-0.15, 0.15);
        const yaw = Math.atan2(-s.fz, s.fx) + Math.PI + rng.range(-0.35, 0.35);
        q.setFromAxisAngle(up, yaw);
        bikes.push(new THREE.Matrix4().compose(new THREE.Vector3(s.x + along.x * o, 0, s.z + along.z * o), q, new THREE.Vector3(1, 1, 1)));
        bikeColors.push(rng.pick([0xc0392b, 0xf2efe6, 0x26282c, 0x2f5fa8, 0xb7bcc2, 0xe0b23a, 0x2f8c84]));
      }
    } else if (roll < 0.74) {
      stools.push({ x: s.x, z: s.z, yaw: Math.atan2(-s.fz, s.fx) + Math.PI / 2, c: rng.pick(STOOLS) });
    }
  }
  const bikeGeo = parkedScooterGeometry();
  const bikeC2 = new THREE.InstancedBufferAttribute(new Float32Array(bikes.length * 3), 3);
  bikeGeo.setAttribute('aColor2', bikeC2);
  const bikeMesh = new THREE.InstancedMesh(bikeGeo, makeMaterial({ color2: true }, { roughness: 0.55 }), bikes.length);
  bikeMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(bikes.length * 3).fill(1), 3);
  bikes.forEach((mx, k) => {
    bikeMesh.setMatrixAt(k, mx);
    col.setHex(bikeColors[k]);
    bikeC2.setXYZ(k, col.r, col.g, col.b);
  });
  bikeMesh.castShadow = true;
  group.add(bikeMesh);

  const stoolMesh = new THREE.InstancedMesh(stoolGroupGeometry(), makeMaterial(), stools.length);
  stools.forEach((s, k) => {
    q.setFromAxisAngle(up, s.yaw);
    stoolMesh.setMatrixAt(k, matrix.compose(new THREE.Vector3(s.x, 0, s.z), q, new THREE.Vector3(1, 1, 1)));
    stoolMesh.setColorAt(k, col.setHex(s.c));
  });
  stoolMesh.castShadow = true;
  group.add(stoolMesh);

  return { group, shopFronts };
}
