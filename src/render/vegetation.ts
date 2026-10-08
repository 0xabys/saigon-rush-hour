import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { SceneJson } from '../data/q1Schema';
import { PAVED_NO_TREES, resolveGround } from '../data/sceneOverrides';
import { RoadClass, type Network } from '../sim/network';
import { GeoBuilder } from './geo';
import { makeMaterial } from './materials';
import { glowTexture } from './textures';
import { pointInPolygon, type Zoning } from './zones';

/** Hard caps promised to the perf budget (P3 design). */
export const MAX_TREES = 2500;
export const MAX_LAMPS = 1300;

/** Streets lined with coconut palms (the riverside boulevard and the walking street). */
const PALM_STREETS: Record<string, true> = { 'Tôn Đức Thắng': true, 'Lê Lợi': true, 'Nguyễn Huệ': true };
/** One park tree per this many square metres (stratified grid cell edge = √). */
const PARK_AREA_PER_TREE = 150;
/** Street trees keep this far from a bus stop. */
const BUS_CLEAR = 10;

const ico = (r: number) => new THREE.IcosahedronGeometry(r, 0);

function tamarind(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const BARK = 0x6b4a32;
  b.place(new THREE.CylinderGeometry(0.2, 0.32, 3.4, 7), 0, 1.7, 0, BARK);
  b.place(new THREE.CylinderGeometry(0.08, 0.14, 1.8, 5), 0.5, 3.6, 0.2, BARK, {}, [0.3, 0, -0.6]);
  b.place(new THREE.CylinderGeometry(0.08, 0.14, 1.8, 5), -0.5, 3.6, -0.2, BARK, {}, [-0.3, 0, 0.6]);
  const leaves: [number, number, number, number][] = [
    [0, 4.8, 0, 2.3],
    [1.4, 4.3, 0.6, 1.7],
    [-1.3, 4.4, -0.5, 1.8],
    [0.3, 5.6, -0.9, 1.5],
    [-0.5, 5.4, 1.0, 1.5],
    [0.9, 5.1, -1.2, 1.3],
  ];
  leaves.forEach(([x, y, z, r], i) => b.place(ico(r), x, y, z, i % 2 ? 0x6fa04e : 0x7fae58, { paint: 1 }));
  return b.build();
}

function palm(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const TRUNK = 0x9a8466;
  let x = 0;
  let y = 0;
  for (let i = 0; i < 5; i++) {
    const h = 1.8;
    const lean = 0.06 + i * 0.03;
    b.place(new THREE.CylinderGeometry(0.17 - i * 0.012, 0.22 - i * 0.012, h, 6), x + Math.sin(lean) * h * 0.5, y + h / 2, 0, i % 2 ? TRUNK : 0x8a7458, {}, [0, 0, -lean]);
    x += Math.sin(lean) * h;
    y += Math.cos(lean) * h * 0.98;
  }
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2;
    const frond = new THREE.BoxGeometry(3.4, 0.06, 0.7);
    frond.translate(1.7, 0, 0);
    b.place(frond, x, y, 0, k % 2 ? 0x5c9a45 : 0x6aa851, { paint: 1 }, [0, -a, -0.45 - (k % 3) * 0.12]);
  }
  for (let k = 0; k < 3; k++) b.place(new THREE.IcosahedronGeometry(0.2, 0), x + Math.cos(k * 2.1) * 0.3, y - 0.3, Math.sin(k * 2.1) * 0.3, 0x6b5a32);
  return b.build();
}

function lamp(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.place(new THREE.CylinderGeometry(0.08, 0.12, 7.2, 6), 0, 3.6, 0, 0x3e4a43);
  b.box(0.08, 0.08, 2.4, 0, 7.05, 1.1, 0x3e4a43);
  b.box(0.42, 0.16, 0.8, 0, 6.95, 2.25, 0xe8e4da, { emis: 0xffd9a0, emisStrength: 4 });
  return b.build();
}

type Tree = { x: number; z: number; s: number; yaw: number; tint: number };
type Lamp = { x: number; z: number; yaw: number };

export interface VegetationResult {
  group: THREE.Group;
  poolMat: THREE.MeshBasicMaterial;
  /** Instances actually placed (after the caps). */
  counts: { trees: number; palms: number; lamps: number };
}

/** Keeps `n` evenly spread items of `list` (deterministic, preserves spatial spread). */
function thin<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor((i * list.length) / n)]);
  return out;
}

export function buildVegetation(net: Network, scene: SceneJson, zoning: Zoning): VegetationResult {
  const group = new THREE.Group();
  group.name = 'vegetation';
  const rng = new Rng(9090);
  const greens = [0xffffff, 0xe8f2d8, 0xd8ebc6, 0xf4f0d0, 0xcfe0b8];
  const make = (x: number, z: number, s = 1): Tree => ({
    x,
    z,
    s: s * rng.range(0.85, 1.2),
    yaw: rng.range(0, Math.PI * 2),
    tint: rng.pick(greens),
  });

  // Priority tiers; the caps cut residential streets first, then parks.
  const palmsA: Tree[] = [];
  const tamsA: Tree[] = [];
  const tamsResidential: Tree[] = [];
  const palmsPark: Tree[] = [];
  const tamsPark: Tree[] = [];
  const lamps: Lamp[] = [];

  const stops = net.busStops.map((st) => {
    const t = [0, 0, 0, 0];
    st.link.sample(st.s, t);
    return t;
  });
  const p = [0, 0, 0, 0];

  // ---- street trees and lamps along every frontage
  for (const seg of net.links) {
    if (seg.bridge || seg.length < 20) continue;
    const arterial = seg.cls <= RoadClass.Tertiary;
    const palms = PALM_STREETS[seg.name] === true;
    // Right of travel is (−d.z, d.x). Two-way links keep the median free; the opposite link plants its own kerb.
    const sides = seg.oneway && arterial ? [1, -1] : [1];
    for (const side of sides) {
      const treeT: number[] = [];
      for (let t = 7 + rng.range(0, 5); t < seg.length - 5; t += rng.range(16, 22)) {
        seg.sample(t, p);
        const off = side * (seg.halfW + 1.15);
        const x = p[0] - p[3] * off;
        const z = p[1] + p[2] * off;
        if (!zoning.treeFree(x, z)) continue;
        if (stops.some((q) => Math.hypot(q[0] - x, q[1] - z) < BUS_CLEAR)) continue;
        treeT.push(t);
        if (palms) palmsA.push(make(x, z, 0.95));
        else (arterial ? tamsA : tamsResidential).push(make(x, z));
      }
      if (side !== 1) continue;
      // Lamps: right kerb only, every ~30 m, nudged clear of a trunk.
      for (let t = 9 + rng.range(0, 6); t < seg.length - 6; t += 30) {
        let tl = t;
        if (treeT.some((tt) => Math.abs(tt - tl) < 1.8)) tl += 2.4;
        seg.sample(tl, p);
        const nx = -p[3];
        const nz = p[2];
        const off = seg.halfW + 0.55;
        const x = p[0] + nx * off;
        const z = p[1] + nz * off;
        if (!zoning.treeFree(x, z, 0.3)) continue;
        lamps.push({ x, z, yaw: Math.atan2(-nx, -nz) });
      }
    }
  }

  // ---- roundabout islands: a ring of palms
  for (const ring of net.rings) {
    const island = ring.r - ring.halfW - 0.5;
    if (island < 2.5) continue;
    if (island < 5) {
      palmsA.push(make(ring.cx, ring.cz, 0.9));
      continue;
    }
    const n = island < 8 ? 4 : 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.3;
      palmsA.push(make(ring.cx + Math.cos(a) * island * 0.55, ring.cz + Math.sin(a) * island * 0.55, 0.9));
    }
  }

  // ---- parks: a jittered grid of trees inside each polygon (coconut palms along the Bạch Đằng riverfront park)
  const cell = Math.sqrt(PARK_AREA_PER_TREE);
  for (const park of scene.parks) {
    const pts = park.pts;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]);
      x1 = Math.max(x1, pts[i]);
      z0 = Math.min(z0, pts[i + 1]);
      z1 = Math.max(z1, pts[i + 1]);
    }
    const riverfront = park.name.includes('Bạch Đằng');
    const palmShare = riverfront ? 0.55 : 0.12;
    // Lawns of at least 400 m² keep their trees off the paved edge: all four corners of a 1.4 m box must lie on the grass too.
    const lawn = (x1 - x0) * (z1 - z0) > 400;
    const place = (x: number, z: number) => {
      if (!pointInPolygon(pts, x, z) || !zoning.treeFree(x, z, 0.8)) return false;
      if (lawn && !(pointInPolygon(pts, x - 1.4, z - 1.4) && pointInPolygon(pts, x + 1.4, z - 1.4) && pointInPolygon(pts, x - 1.4, z + 1.4) && pointInPolygon(pts, x + 1.4, z + 1.4))) return false;
      if (rng.next() < palmShare) palmsPark.push(make(x, z, riverfront ? 1.05 : 0.95));
      else tamsPark.push(make(x, z, rng.range(0.75, 1.1)));
      return true;
    };
    let placed = 0;
    for (let gz = z0 + cell / 2; gz < z1 + cell / 2; gz += cell) {
      for (let gx = x0 + cell / 2; gx < x1 + cell / 2; gx += cell) {
        if (place(gx + rng.range(-0.35, 0.35) * cell, gz + rng.range(-0.35, 0.35) * cell)) placed++;
      }
    }
    // Pocket parks too small for a grid cell still get one tree near the middle of their bounds.
    if (placed === 0 && (x1 - x0) * (z1 - z0) > 60) place((x0 + x1) / 2, (z0 + z1) / 2);
  }

  // ---- squares and pedestrian areas: a sparse jittered grid of shade trees (never on asphalt; zoning keeps them off footprints and sites)
  const plazaCell = cell * 1.7;
  for (const plaza of resolveGround(scene).plazas) {
    if (PAVED_NO_TREES[plaza.osm]) continue;
    const pts = plaza.pts;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]);
      x1 = Math.max(x1, pts[i]);
      z0 = Math.min(z0, pts[i + 1]);
      z1 = Math.max(z1, pts[i + 1]);
    }
    for (let gz = z0 + plazaCell / 2; gz < z1 + plazaCell / 2; gz += plazaCell) {
      for (let gx = x0 + plazaCell / 2; gx < x1 + plazaCell / 2; gx += plazaCell) {
        const x = gx + rng.range(-0.3, 0.3) * plazaCell;
        const z = gz + rng.range(-0.3, 0.3) * plazaCell;
        if (pointInPolygon(pts, x, z) && zoning.treeFree(x, z, 1.5)) tamsPark.push(make(x, z, rng.range(0.8, 1.1)));
      }
    }
  }

  // ---- caps: palms + arterial trees first, parks next, residential streets last
  const priority = [...palmsA, ...tamsA].length;
  const keepA = Math.min(priority, Math.floor(MAX_TREES * 0.65));
  const room = MAX_TREES - keepA;
  const parkAll = palmsPark.length + tamsPark.length;
  const resQuota = Math.min(tamsResidential.length, Math.floor(room * 0.4));
  const parkQuota = Math.min(parkAll, room - resQuota);
  const resKeep = Math.min(tamsResidential.length, room - parkQuota);
  const palmShareA = palmsA.length / Math.max(1, priority);
  const palmKeepA = Math.min(palmsA.length, Math.round(keepA * palmShareA));
  const parkPalmKeep = Math.min(palmsPark.length, Math.round(parkQuota * (palmsPark.length / Math.max(1, parkAll))));
  const palms = [...thin(palmsA, palmKeepA), ...thin(palmsPark, parkPalmKeep)];
  const tams = [...thin(tamsA, keepA - palmKeepA), ...thin(tamsPark, parkQuota - parkPalmKeep), ...thin(tamsResidential, resKeep)];
  const lampsKept = thin(lamps, MAX_LAMPS);

  // ---- meshes
  const treeMat = makeMaterial({ sway: true }, { roughness: 0.9 });
  const col = new THREE.Color();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (const [geo, list] of [
    [tamarind(), tams],
    [palm(), palms],
  ] as const) {
    const mesh = new THREE.InstancedMesh(geo, treeMat, list.length);
    list.forEach((t, k) => {
      q.setFromAxisAngle(up, t.yaw);
      mesh.setMatrixAt(k, m4.compose(pos.set(t.x, 0, t.z), q, scl.set(t.s, t.s, t.s)));
      mesh.setColorAt(k, col.setHex(t.tint));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  const lampMesh = new THREE.InstancedMesh(lamp(), makeMaterial(), lampsKept.length);
  scl.set(1, 1, 1);
  lampsKept.forEach((l, k) => {
    q.setFromAxisAngle(up, l.yaw);
    lampMesh.setMatrixAt(k, m4.compose(pos.set(l.x, 0, l.z), q, scl));
  });
  lampMesh.castShadow = true;
  group.add(lampMesh);

  const poolMat = new THREE.MeshBasicMaterial({
    map: glowTexture(),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0,
  });
  const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), poolMat, lampsKept.length);
  scl.set(13, 1, 13);
  q.identity();
  lampsKept.forEach((l, k) => {
    pools.setMatrixAt(k, m4.compose(pos.set(l.x + Math.sin(l.yaw) * 2.6, 0.08, l.z + Math.cos(l.yaw) * 2.6), q, scl));
  });
  pools.renderOrder = 1;
  group.add(pools);
  return { group, poolMat, counts: { trees: tams.length + palms.length, palms: palms.length, lamps: lampsKept.length } };
}
