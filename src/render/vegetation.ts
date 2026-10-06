import * as THREE from 'three';
import { Rng } from '../core/rng';
import { RIVER, RING_CENTER, ROAD_HALF, WORLD, type MapNode, type Network, type Road } from '../sim/network';
import { GeoBuilder } from './geo';
import { makeMaterial } from './materials';
import { glowTexture } from './textures';
import { SITES, type Zoning } from './zones';

const ico = (r: number) => new THREE.IcosahedronGeometry(r, 1);

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

export interface VegetationResult {
  group: THREE.Group;
  poolMat: THREE.MeshBasicMaterial;
}

export function buildVegetation(net: Network, zoning: Zoning): VegetationResult {
  const group = new THREE.Group();
  group.name = 'vegetation';
  const rng = new Rng(9090);
  const tams: Tree[] = [];
  const palms: Tree[] = [];
  const lamps: { x: number; z: number; yaw: number }[] = [];
  const greens = [0xffffff, 0xe8f2d8, 0xd8ebc6, 0xf4f0d0, 0xcfe0b8];
  const add = (list: Tree[], x: number, z: number, s = 1) =>
    list.push({ x, z, s: s * rng.range(0.85, 1.2), yaw: rng.range(0, Math.PI * 2), tint: rng.pick(greens) });

  const trim = (n: MapNode, r: Road) => (n.kind === 'portal' ? 3 : n.kind === 'ring' ? 33 : Math.min(Math.abs(r.dx), Math.abs(r.dz)) > 0.2 ? 24 : 16);
  const stops = net.busStops.map((st) => {
    const t = [0, 0, 0, 0];
    st.link.sample(st.s, t);
    return t;
  });
  for (const r of net.roads) {
    if (r.bridge) continue;
    const t0 = trim(r.a, r);
    const t1 = r.length - trim(r.b, r);
    const palmsHere = r.name === 'Tôn Đức Thắng' || r.name === 'Lê Lợi';
    for (const side of [1, -1]) {
      const nx = -r.dz * side;
      const nz = r.dx * side;
      for (let t = t0 + rng.range(0, 5); t < t1; t += rng.range(10, 14)) {
        const off = ROAD_HALF + 1.15;
        const x = r.a.x + r.dx * t + nx * off;
        const z = r.a.z + r.dz * t + nz * off;
        if (x > RIVER.x0 - 30 && nx > 0.5) continue;
        if (stops.some((p) => Math.hypot(p[0] - x, p[1] - z) < 10)) continue;
        if (palmsHere) add(palms, x, z, 0.95);
        else add(tams, x, z);
      }
      for (let t = t0 + 6; t < t1; t += 26) {
        const off = ROAD_HALF + 0.55;
        lamps.push({ x: r.a.x + r.dx * t + nx * off, z: r.a.z + r.dz * t + nz * off, yaw: Math.atan2(-nx, -nz) });
      }
    }
  }
  // Bạch Đằng park: rows of coconut palms along the river.
  for (let z = WORLD.minZ + 6; z < WORLD.maxZ - 4; z += 9) {
    if (Math.abs(z + 70) < 13) continue;
    add(palms, 131 + rng.range(-1, 1), z + rng.range(-1.5, 1.5), 1.05);
    if (rng.next() < 0.6) add(tams, 137 + rng.range(-1, 1), z + 4.5, 0.8);
  }
  // Nguyễn Huệ: shade trees down both edges of the plaza.
  for (let z = -54; z <= 54; z += 8) {
    if (Math.abs(z - 46) < 7) continue;
    add(tams, -11, z, 0.65);
    add(tams, 11, z, 0.65);
  }
  // Roundabout island palms.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    add(palms, RING_CENTER.x + Math.cos(a) * 6, RING_CENTER.z + Math.sin(a) * 6, 0.9);
  }
  // Committee lawn palms.
  for (const x of [-20, -10, 10, 20]) add(palms, x, SITES.committee.z1 + 2, 0.9);
  // Thủ Thiêm park and leftover pockets of the city.
  for (let i = 0; i < 320; i++) {
    const east = i < 120;
    const x = east ? rng.range(RIVER.x1 + 10, WORLD.maxX - 3) : rng.range(WORLD.minX + 3, RIVER.x0 - 30);
    const z = rng.range(WORLD.minZ + 3, WORLD.maxZ - 3);
    if (east) {
      if (Math.abs(z + 70) < 13 || zoning.roadDist(x, z) < ROAD_HALF + 3) continue;
      if (x > SITES.landmark81.x0 - 4 && x < SITES.landmark81.x1 + 4 && z > SITES.landmark81.z0 - 4 && z < SITES.landmark81.z1 + 4) continue;
      if (!zoning.buildable(x, z)) continue;
      zoning.stamp(x, z, 1, 0, 1.5, 1.5, 0);
      add(rng.next() < 0.35 ? palms : tams, x, z, rng.range(0.8, 1.2));
    } else if (zoning.rectFree(x, z, 1, 0, 1.6, 1.6)) {
      zoning.stamp(x, z, 1, 0, 1.6, 1.6, 0);
      add(tams, x, z, rng.range(0.7, 1));
    }
  }

  const treeMat = makeMaterial({ sway: true }, { roughness: 0.9 });
  const col = new THREE.Color();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const m4 = new THREE.Matrix4();
  for (const [geo, list] of [
    [tamarind(), tams],
    [palm(), palms],
  ] as const) {
    const mesh = new THREE.InstancedMesh(geo, treeMat, list.length);
    list.forEach((t, k) => {
      q.setFromAxisAngle(up, t.yaw);
      mesh.setMatrixAt(k, m4.compose(new THREE.Vector3(t.x, 0, t.z), q, new THREE.Vector3(t.s, t.s, t.s)));
      mesh.setColorAt(k, col.setHex(t.tint));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  const lampMesh = new THREE.InstancedMesh(lamp(), makeMaterial(), lamps.length);
  lamps.forEach((l, k) => {
    q.setFromAxisAngle(up, l.yaw);
    lampMesh.setMatrixAt(k, m4.compose(new THREE.Vector3(l.x, 0, l.z), q, new THREE.Vector3(1, 1, 1)));
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
  const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), poolMat, lamps.length);
  lamps.forEach((l, k) => {
    const fx = Math.sin(l.yaw);
    const fz = Math.cos(l.yaw);
    pools.setMatrixAt(k, m4.compose(new THREE.Vector3(l.x + fx * 2.6, 0.08, l.z + fz * 2.6), q.identity(), new THREE.Vector3(13, 1, 13)));
  });
  pools.renderOrder = 1;
  group.add(pools);
  return { group, poolMat };
}
