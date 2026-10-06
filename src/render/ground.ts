import * as THREE from 'three';
import { Rng } from '../core/rng';
import {
  BOX_HALF,
  MEDIAN,
  REF_OFFSET,
  RIVER,
  RING_CENTER,
  RING_INNER,
  RING_OUTER,
  RING_REF_R,
  ROAD_HALF,
  SIDEWALK,
  WORLD,
  type MapNode,
  type Network,
  type Road,
} from '../sim/network';
import { shared } from './materials';
import { asphaltTexture, grassTexture, pavingTexture } from './textures';

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
    this.quad(
      ax + rx * o0,
      az + rz * o0,
      bx + rx * o0,
      bz + rz * o0,
      bx + rx * o1,
      bz + rz * o1,
      ax + rx * o1,
      az + rz * o1,
      y,
      color,
    );
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

/** Where a road's sidewalk / markings end near a node. */
function edgeTrim(n: MapNode, r: Road, kind: 'sidewalk' | 'marking'): number {
  if (n.kind === 'portal') return 0;
  if (n.kind === 'ring') return kind === 'sidewalk' ? RING_OUTER + 3.2 : RING_OUTER + 4.5;
  const diag = Math.min(Math.abs(r.dx), Math.abs(r.dz)) > 0.2;
  if (kind === 'sidewalk') return diag ? ROAD_HALF + 9 : ROAD_HALF;
  return r.a === n ? r.trimA : r.trimB;
}

export interface GroundResult {
  group: THREE.Group;
  roadMat: THREE.MeshStandardMaterial;
  walkMat: THREE.MeshStandardMaterial;
  water: THREE.ShaderMaterial;
}

const MARK_WHITE = 0xf3eee2;
const MARK_YELLOW = 0xe8b640;

export function buildGround(net: Network): GroundResult {
  const group = new THREE.Group();
  group.name = 'ground';

  // ---- diorama slab: two land masses separated by the river
  const sideMat = new THREE.MeshStandardMaterial({ color: 0xa8784c, roughness: 0.95 });
  const sideDark = new THREE.MeshStandardMaterial({ color: 0x8c6040, roughness: 0.95 });
  const topMat = new THREE.MeshStandardMaterial({ color: 0xefe3c6, roughness: 0.95 });
  const depth = 9;
  const addSlab = (x0: number, x1: number) => {
    const box = new THREE.BoxGeometry(x1 - x0, depth, WORLD.maxZ - WORLD.minZ);
    const m = new THREE.Mesh(box, [sideMat, sideMat, topMat, sideDark, sideMat, sideMat]);
    m.position.set((x0 + x1) / 2, -depth / 2 - 0.02, (WORLD.minZ + WORLD.maxZ) / 2);
    m.receiveShadow = true;
    group.add(m);
    // Darker soil stratum along the sides.
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(x1 - x0 + 0.1, 1.2, WORLD.maxZ - WORLD.minZ + 0.1),
      new THREE.MeshStandardMaterial({ color: 0x7a5236, roughness: 1 }),
    );
    band.position.set((x0 + x1) / 2, -depth + 1.2, (WORLD.minZ + WORLD.maxZ) / 2);
    group.add(band);
  };
  addSlab(WORLD.minX, RIVER.x0);
  addSlab(RIVER.x1, WORLD.maxX);

  const paving = pavingTexture();
  paving.repeat.set(1, 1);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0xf1e6cb, map: paving, roughness: 0.92 });
  const addGroundPlane = (x0: number, x1: number) => {
    const g = new THREE.PlaneGeometry(x1 - x0, WORLD.maxZ - WORLD.minZ).rotateX(-Math.PI / 2);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * (x1 - x0)) / 12, (uv.getY(i) * (WORLD.maxZ - WORLD.minZ)) / 12);
    const m = new THREE.Mesh(g, groundMat);
    m.position.set((x0 + x1) / 2, 0, (WORLD.minZ + WORLD.maxZ) / 2);
    m.receiveShadow = true;
    group.add(m);
  };
  addGroundPlane(WORLD.minX, RIVER.x0);
  addGroundPlane(RIVER.x1, WORLD.maxX);

  // ---- river
  const water = new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime,
      uNight: shared.uNight,
      uWet: shared.uWet,
      uSky: { value: new THREE.Color(0x9cc6d9) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uNight; uniform float uWet; uniform vec3 uSky;
      varying vec2 vW;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        float across = (vW.x - ${RIVER.x0.toFixed(1)}) / ${(RIVER.x1 - RIVER.x0).toFixed(1)};
        float edge = smoothstep(0.0, 0.18, across) * smoothstep(1.0, 0.82, across);
        vec2 p = vec2(vW.x * 0.18, vW.y * 0.06 - uTime * 0.12);
        float n = noise(p * 3.0) * 0.6 + noise(p * 7.0 + 3.1) * 0.4;
        float ripple = smoothstep(0.7, 0.8, noise(vec2(vW.x * 1.6, vW.y * 0.7 - uTime * 0.9)));
        vec3 shallow = vec3(0.30, 0.58, 0.56);
        vec3 deep = vec3(0.14, 0.38, 0.42);
        vec3 col = mix(shallow, deep, edge * 0.85 + n * 0.15);
        col = mix(col, uSky * 0.8, 0.1 + 0.08 * n);
        col += ripple * 0.06 * (1.0 - uNight);
        // Night: dark water with faint warm reflections of the embankment lights near the banks.
        float nearBank = 1.0 - smoothstep(0.0, 0.25, min(across, 1.0 - across));
        vec3 nightCol = vec3(0.04, 0.09, 0.12) + vec3(0.9, 0.62, 0.3) * ripple * 0.16 * (0.35 + nearBank);
        col = mix(col, nightCol, uNight * 0.85);
        // Rain dimples.
        float drops = smoothstep(0.92, 1.0, noise(vW * 1.7 + floor(uTime * 6.0) * 13.1));
        col += drops * uWet * 0.12;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const waterTop = new THREE.Mesh(new THREE.PlaneGeometry(RIVER.x1 - RIVER.x0, WORLD.maxZ - WORLD.minZ, 1, 1).rotateX(-Math.PI / 2), water);
  waterTop.position.set((RIVER.x0 + RIVER.x1) / 2, -1.1, 0);
  group.add(waterTop);
  const waterBody = new THREE.Mesh(
    new THREE.BoxGeometry(RIVER.x1 - RIVER.x0, depth - 1.6, WORLD.maxZ - WORLD.minZ),
    new THREE.MeshStandardMaterial({ color: 0x3f8a86, roughness: 0.3, transparent: true, opacity: 0.92 }),
  );
  waterBody.position.set((RIVER.x0 + RIVER.x1) / 2, -1.1 - (depth - 1.6) / 2 - 0.01, 0);
  group.add(waterBody);
  // Stone embankments.
  const stone = new THREE.MeshStandardMaterial({ color: 0xc9bea6, roughness: 0.9 });
  for (const x of [RIVER.x0 + 0.6, RIVER.x1 - 0.6]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.6, WORLD.maxZ - WORLD.minZ), stone);
    wall.position.set(x, -0.6, 0);
    wall.receiveShadow = true;
    group.add(wall);
  }

  // ---- parks and paved plazas
  const grass = grassTexture();
  const parkMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: grass, roughness: 0.95 });
  const parks = new FlatBuilder(1 / 10);
  const GREEN = 0x9cbf72;
  const DEEP_GREEN = 0x86b062;
  // Bạch Đằng riverside park (split where the bridge road passes).
  parks.quad(126, WORLD.minZ, 140, WORLD.minZ, 140, -79, 126, -79, 0.04, GREEN);
  parks.quad(126, -61, 140, -61, 140, WORLD.maxZ, 126, WORLD.maxZ, 0.04, GREEN);
  // Thủ Thiêm bank.
  parks.quad(RIVER.x1 + 4, WORLD.minZ, WORLD.maxX, WORLD.minZ, WORLD.maxX, -82, RIVER.x1 + 4, -82, 0.04, DEEP_GREEN);
  parks.quad(RIVER.x1 + 4, -58, WORLD.maxX, -58, WORLD.maxX, WORLD.maxZ, RIVER.x1 + 4, WORLD.maxZ, 0.04, GREEN);
  // Roundabout island.
  parks.annulus(RING_CENTER.x, RING_CENTER.z, 0, RING_INNER - 0.4, 0, Math.PI * 2, 0.22, DEEP_GREEN, 40);
  // Tao Đàn-ish green pockets at the map's west corners.
  parks.quad(-212, -168, -176, -168, -176, -132, -212, -132, 0.04, GREEN);
  parks.quad(-212, 134, -168, 134, -168, 168, -212, 168, 0.04, GREEN);
  const parkMesh = new THREE.Mesh(parks.build(), parkMat);
  parkMesh.receiveShadow = true;
  group.add(parkMesh);

  // ---- roads
  const asphalt = asphaltTexture();
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x4d4843, map: asphalt, roughness: 0.92, metalness: 0 });
  const roads = new FlatBuilder(1 / 9);
  const ROAD = 0xffffff;
  for (const r of net.roads) {
    const ext = (n: MapNode) => (n.kind === 'ring' ? RING_OUTER - 2 : 0);
    const ax = r.a.x + r.dx * ext(r.a);
    const az = r.a.z + r.dz * ext(r.a);
    const bx = r.b.x - r.dx * ext(r.b);
    const bz = r.b.z - r.dz * ext(r.b);
    roads.band(ax, az, bx, bz, -ROAD_HALF, ROAD_HALF, 0.03, ROAD);
  }
  for (const n of net.signalNodes) {
    const pts: [number, number][] = [];
    for (const arm of n.arms) {
      const px = -arm.oz;
      const pz = arm.ox;
      const d = BOX_HALF + 1.5;
      pts.push([n.x + arm.ox * d + px * ROAD_HALF, n.z + arm.oz * d + pz * ROAD_HALF]);
      pts.push([n.x + arm.ox * d - px * ROAD_HALF, n.z + arm.oz * d - pz * ROAD_HALF]);
    }
    roads.poly(convexHull(pts), 0.035, ROAD);
  }
  roads.annulus(RING_CENTER.x, RING_CENTER.z, RING_INNER, RING_OUTER, 0, Math.PI * 2, 0.036, ROAD, 72);
  const roadMesh = new THREE.Mesh(roads.build(), roadMat);
  roadMesh.receiveShadow = true;
  group.add(roadMesh);

  // ---- sidewalks + curbs
  const walkMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: paving, roughness: 0.9 });
  const walks = new FlatBuilder(1 / 6);
  const curbs = new FlatBuilder(1 / 6);
  const WALK = 0xe3d6b9;
  const CURB = 0xcfc3a8;
  const curbBoxes: { ax: number; az: number; bx: number; bz: number; side: number }[] = [];
  for (const r of net.roads) {
    if (r.bridge) continue;
    const t0 = edgeTrim(r.a, r, 'sidewalk');
    const t1 = edgeTrim(r.b, r, 'sidewalk');
    if (r.length - t0 - t1 < 2) continue;
    const ax = r.a.x + r.dx * t0;
    const az = r.a.z + r.dz * t0;
    const bx = r.b.x - r.dx * t1;
    const bz = r.b.z - r.dz * t1;
    // Riverside road: the river side is the Bạch Đằng promenade.
    walks.band(ax, az, bx, bz, ROAD_HALF, ROAD_HALF + SIDEWALK, 0.012, WALK);
    walks.band(ax, az, bx, bz, -ROAD_HALF - SIDEWALK, -ROAD_HALF, 0.012, WALK);
    curbBoxes.push({ ax, az, bx, bz, side: 1 }, { ax, az, bx, bz, side: -1 });
  }
  // Sidewalk ring around the roundabout, broken where the arms come in.
  const armAngles = net.ring.arms.map((a) => a.angle).sort((a, b) => a - b);
  const gap = Math.asin(ROAD_HALF / (RING_OUTER + 1.6)) + 0.02;
  for (let i = 0; i < armAngles.length; i++) {
    const a0 = armAngles[i] + gap;
    let a1 = armAngles[(i + 1) % armAngles.length] - gap;
    if (a1 < a0) a1 += Math.PI * 2;
    walks.annulus(RING_CENTER.x, RING_CENTER.z, RING_OUTER, RING_OUTER + SIDEWALK, a0, a1, 0.012, WALK, 72);
    curbs.annulus(RING_CENTER.x, RING_CENTER.z, RING_OUTER, RING_OUTER + 0.35, a0, a1, 0.16, CURB, 72);
  }
  // Promenades along both banks, interrupted by the bridge approach.
  for (const [z0, z1] of [
    [WORLD.minZ, -79],
    [-61, WORLD.maxZ],
  ]) {
    walks.quad(140, z0, RIVER.x0, z0, RIVER.x0, z1, 140, z1, 0.05, 0xe9dcc0);
    walks.quad(RIVER.x1, z0, RIVER.x1 + 6, z0, RIVER.x1 + 6, z1, RIVER.x1, z1, 0.05, 0xe9dcc0);
  }
  for (const c of curbBoxes) curbs.band(c.ax, c.az, c.bx, c.bz, c.side * ROAD_HALF, c.side * (ROAD_HALF + 0.35), 0.16, CURB);
  const walkMesh = new THREE.Mesh(walks.build(), walkMat);
  walkMesh.receiveShadow = true;
  group.add(walkMesh);
  const curbGeo = curbs.build();
  const curbMesh = new THREE.Mesh(curbGeo, walkMat);
  curbMesh.receiveShadow = true;
  curbMesh.castShadow = true;
  group.add(curbMesh);
  // Curb faces: thin vertical skirts so raised edges read from the iso camera.
  const skirt = new THREE.MeshStandardMaterial({ color: 0xa79c86, roughness: 0.9, side: THREE.DoubleSide });
  const skirtGeo = new THREE.BufferGeometry();
  const sk: number[] = [];
  for (const c of curbBoxes) {
    const dx = c.bx - c.ax;
    const dz = c.bz - c.az;
    const l = Math.hypot(dx, dz);
    const rx = (-dz / l) * c.side * ROAD_HALF;
    const rz = (dx / l) * c.side * ROAD_HALF;
    const x0 = c.ax + rx;
    const z0 = c.az + rz;
    const x1 = c.bx + rx;
    const z1 = c.bz + rz;
    sk.push(x0, 0.03, z0, x1, 0.03, z1, x1, 0.16, z1, x0, 0.03, z0, x1, 0.16, z1, x0, 0.16, z0);
  }
  skirtGeo.setAttribute('position', new THREE.Float32BufferAttribute(sk, 3));
  skirtGeo.computeVertexNormals();
  group.add(new THREE.Mesh(skirtGeo, skirt));

  // ---- road markings
  const marks = new FlatBuilder();
  const rng = new Rng(77);
  for (const r of net.roads) {
    const t0 = edgeTrim(r.a, r, 'marking');
    const t1 = edgeTrim(r.b, r, 'marking');
    const len = r.length - t0 - t1;
    if (len < 2) continue;
    const ax = r.a.x + r.dx * t0;
    const az = r.a.z + r.dz * t0;
    const bx = r.b.x - r.dx * t1;
    const bz = r.b.z - r.dz * t1;
    // Double yellow centre line.
    marks.band(ax, az, bx, bz, -MEDIAN / 2 + 0.05, -MEDIAN / 2 + 0.22, 0.06, MARK_YELLOW);
    marks.band(ax, az, bx, bz, MEDIAN / 2 - 0.22, MEDIAN / 2 - 0.05, 0.06, MARK_YELLOW);
    // Dashed lane dividers, solid for the last stretch before a stop line.
    for (const side of [1, -1]) {
      const solidAtB = side === 1 && r.b.kind === 'signal' ? 14 : 0;
      const solidAtA = side === -1 && r.a.kind === 'signal' ? 14 : 0;
      let t = 2 + solidAtA;
      while (t < len - 2 - solidAtB) {
        const e = Math.min(t + 3, len - 2 - solidAtB);
        marks.band(ax + r.dx * t, az + r.dz * t, ax + r.dx * e, az + r.dz * e, side * REF_OFFSET - 0.1, side * REF_OFFSET + 0.1, 0.06, MARK_WHITE);
        t += 7;
      }
      if (solidAtB) marks.band(bx - r.dx * solidAtB, bz - r.dz * solidAtB, bx, bz, REF_OFFSET - 0.1, REF_OFFSET + 0.1, 0.06, MARK_WHITE);
      if (solidAtA) marks.band(ax, az, ax + r.dx * solidAtA, az + r.dz * solidAtA, -REF_OFFSET - 0.1, -REF_OFFSET + 0.1, 0.06, MARK_WHITE);
    }
    // Faded patches where countless tyres have worn the paint.
    if (rng.next() < 0.5) {
      const t = rng.range(5, Math.max(6, len - 5));
      marks.band(ax + r.dx * t, az + r.dz * t, ax + r.dx * (t + 2), az + r.dz * (t + 2), -ROAD_HALF + 1, ROAD_HALF - 1, 0.04, 0x55504a);
    }
  }
  for (const n of net.signalNodes) {
    for (const arm of n.arms) {
      const px = -arm.oz;
      const pz = arm.ox;
      // Stop line across the inbound half (right side of inbound = left of outward).
      const sx = n.x + arm.ox * arm.trim;
      const sz = n.z + arm.oz * arm.trim;
      marks.quad(
        sx - px * 0.4,
        sz - pz * 0.4,
        sx - px * ROAD_HALF,
        sz - pz * ROAD_HALF,
        sx - px * ROAD_HALF + arm.ox * 0.5,
        sz - pz * ROAD_HALF + arm.oz * 0.5,
        sx - px * 0.4 + arm.ox * 0.5,
        sz - pz * 0.4 + arm.oz * 0.5,
        0.065,
        MARK_WHITE,
      );
      // Zebra crossing between the box and the stop line.
      const z0 = arm.trim - 3.6;
      const z1 = arm.trim - 0.6;
      for (let o = -ROAD_HALF + 0.5; o < ROAD_HALF - 0.4; o += 1.15) {
        const cx0 = n.x + arm.ox * z0 + px * o;
        const cz0 = n.z + arm.oz * z0 + pz * o;
        const cx1 = n.x + arm.ox * z1 + px * o;
        const cz1 = n.z + arm.oz * z1 + pz * o;
        marks.band(cx0, cz0, cx1, cz1, -0.3, 0.3, 0.065, MARK_WHITE);
      }
    }
  }
  // Roundabout: dashed lane line and give-way teeth at each entry.
  for (let a = 0; a < Math.PI * 2; a += 0.12) {
    marks.annulus(RING_CENTER.x, RING_CENTER.z, RING_REF_R - 0.1, RING_REF_R + 0.1, a, a + 0.06, 0.065, MARK_WHITE, 4);
  }
  for (const arm of net.ring.arms) {
    const px = -arm.oz;
    const pz = arm.ox;
    const d = RING_OUTER + 0.8;
    for (let o = 0.6; o < ROAD_HALF - 0.4; o += 1.0) {
      const cx = RING_CENTER.x + arm.ox * d - px * o;
      const cz = RING_CENTER.z + arm.oz * d - pz * o;
      marks.tri(cx - px * 0.35, cz - pz * 0.35, cx + px * 0.35, cz + pz * 0.35, cx - arm.ox * 0.8, cz - arm.oz * 0.8, 0.065, MARK_WHITE);
    }
    const zc = RING_OUTER + 4.5;
    for (let o = -ROAD_HALF + 0.5; o < ROAD_HALF - 0.4; o += 1.15) {
      const cx = RING_CENTER.x + arm.ox * zc + px * o;
      const cz = RING_CENTER.z + arm.oz * zc + pz * o;
      marks.band(cx, cz, cx + arm.ox * 3, cz + arm.oz * 3, -0.3, 0.3, 0.065, MARK_WHITE);
    }
  }
  // Bus bays.
  for (const stop of net.busStops) {
    const tmp = [0, 0, 0, 0];
    stop.link.sample(stop.s, tmp);
    const rx = -tmp[3];
    const rz = tmp[2];
    const cx = tmp[0] + rx * 1.6;
    const cz = tmp[1] + rz * 1.6;
    const hl = 7;
    const ax = cx - tmp[2] * hl;
    const az = cz - tmp[3] * hl;
    const bx = cx + tmp[2] * hl;
    const bz = cz + tmp[3] * hl;
    marks.band(ax, az, bx, bz, -1.5, -1.3, 0.066, MARK_YELLOW);
    marks.band(ax, az, bx, bz, 1.3, 1.5, 0.066, MARK_YELLOW);
    marks.band(ax, az, ax + tmp[2] * 0.2, az + tmp[3] * 0.2, -1.5, 1.5, 0.066, MARK_YELLOW);
    marks.band(bx - tmp[2] * 0.2, bz - tmp[3] * 0.2, bx, bz, -1.5, 1.5, 0.066, MARK_YELLOW);
  }
  const markMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
  const markMesh = new THREE.Mesh(marks.build(), markMat);
  markMesh.receiveShadow = true;
  group.add(markMesh);

  return { group, roadMat, walkMat, water };
}
