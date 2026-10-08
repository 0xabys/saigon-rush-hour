import * as THREE from 'three';
import { Rng, rand01 } from '../core/rng';
import type { SceneJson } from '../data/q1Schema';
import { BUILDING_OVERRIDES } from '../data/buildingOverrides';
import type { Network } from '../sim/network';
import { GeoBuilder, gableGeometry } from './geo';
import { makeMaterial, shared } from './materials';
import { signAtlas } from './textures';
import { parkedScooterGeometry } from './vehicleModels';
import { OCC_BUILT, OCC_FREE, pointInPolygon, type Zoning } from './zones';

const WALLS = [0xe3b448, 0xefe2c4, 0xd9a23e, 0xb8d4b0, 0xe8a07f, 0xa9c9d6, 0xf2eee4, 0xf2d68a, 0xdb8f6e, 0x9fcfc4, 0xe9c9a0, 0xf0d0a0];
const AWNINGS = [0xc8463a, 0x2f6b9a, 0x3f8f5a, 0xe0a33a, 0xd96c3a, 0xf0e6d0, 0x2f7d74];
const MIDRISE = [0xe9dcc0, 0xd8cbb0, 0xc9d3cf, 0xe6c88f, 0xf0ebe0, 0xbfc9c2, 0xe3d2b4];
const GLASS_TOWERS = [0x8fb3b8, 0x9fb8b0, 0xa7c0c6, 0xb9c4bd];
const TILES = [0xb5563a, 0xa8503a, 0xc0653f, 0x9c4a36];
const TANKS = [0xc9ccd0, 0xc9ccd0, 0x7fa3b8, 0xd9d4c8];
const STOOLS = [0xd93b2f, 0x2f6fb5, 0x3f9a5a, 0xe8b23a];
const ROOF_GREY = 0x8f8a80;
const SHOP_DARK = 0x3a2e24;
const SHOP_GLOW = 0xffc070;

const SIDEWALK = 3.2;
const FLOOR_H = 3.4;
const PARAPET = 0.7;
const SECONDARY = 2;
/** Floors a building may have: the tallest tower in the extract (Saigon Centre 2, 193.7 m) is 57; 80 floors = 272 m. */
const MAX_FLOORS = 80;
const MAX_UNITS = 1700;
const MAX_BIKES = 900;

const LOW_KINDS: Record<string, true> = { roof: true, cabin: true };
const SACRED_KINDS: Record<string, true> = { church: true, temple: true, mosque: true, palace: true, civic: true };
const SHOP_KINDS: Record<string, true> = {
  yes: true,
  residential: true,
  house: true,
  retail: true,
  commercial: true,
  terrace: true,
  apartments: true,
  hotel: true,
  restaurant: true,
  gob: true,
};
const KIND_WALL: Record<string, number> = {
  church: 0xefe2c4,
  temple: 0xe8b04a,
  mosque: 0xe9efe4,
  palace: 0xf2c75c,
  civic: 0xf2c75c,
  roof: 0xd8d0c0,
  cabin: 0xd8d0c0,
};
const TALL_BONUS: Record<string, true> = { office: true, hotel: true, commercial: true, hospital: true };

const cyl = (r: number, h: number, seg = 10) => new THREE.CylinderGeometry(r, r, h, seg);
const EULER = new THREE.Euler();

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

// --------------------------------------------------------------------- geometry soup

// Box face table: quad corners (a, b, c, d) counter-clockwise seen from outside, unit half extents.
const FACE_BITS = [1, 2, 4, 8, 16, 32] as const;
const BOX_NORMALS: number[][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const BOX_QUADS: number[][][] = [
  [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]],
  [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]],
  [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]],
  [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]],
  [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
  [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
];
/** Box face bits: +x 1, −x 2, +y 4, −y 8, +z 16, −z 32. */
const PY = 4;
const NY = 8;
const NZ = 32;
const ALL = 63;

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const tmpN = new THREE.Vector3();

/** One flat-shaded, vertex-coloured triangle soup with the per-vertex attributes the wall material reads. */
class Soup {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly emi: number[] = [];
  private readonly bw: number[] = [];
  readonly c = new THREE.Color();
  er = 0;
  eg = 0;
  eb = 0;
  /** Window storey height (0 = no windows), night-light level, 1 = ribbon glazing, top of the window zone. */
  f = 0;
  lit = 0;
  style = 0;
  top = 0;
  tris = 0;

  color(hex: number): void {
    this.c.setHex(hex);
  }

  glow(hex: number, k: number): void {
    const e = new THREE.Color(hex).multiplyScalar(k);
    this.er = e.r;
    this.eg = e.g;
    this.eb = e.b;
  }

  noGlow(): void {
    this.er = this.eg = this.eb = 0;
  }

  private v(x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(this.c.r, this.c.g, this.c.b);
    this.emi.push(this.er, this.eg, this.eb);
    this.bw.push(this.f, this.lit, this.style, this.top);
  }

  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, nx: number, ny: number, nz: number): void {
    this.v(ax, ay, az, nx, ny, nz);
    this.v(bx, by, bz, nx, ny, nz);
    this.v(cx, cy, cz, nx, ny, nz);
    this.tris++;
  }

  /** Box of size w×h×d transformed by `m` (rotation + translation only); `mask` picks the faces to emit. */
  box(m: THREE.Matrix4, w: number, h: number, d: number, mask = ALL): void {
    const hw = w / 2;
    const hh = h / 2;
    const hd = d / 2;
    for (let f = 0; f < 6; f++) {
      if (!(mask & FACE_BITS[f])) continue;
      const q = BOX_QUADS[f];
      tmpA.set(q[0][0] * hw, q[0][1] * hh, q[0][2] * hd).applyMatrix4(m);
      tmpB.set(q[1][0] * hw, q[1][1] * hh, q[1][2] * hd).applyMatrix4(m);
      tmpC.set(q[2][0] * hw, q[2][1] * hh, q[2][2] * hd).applyMatrix4(m);
      tmpD.set(q[3][0] * hw, q[3][1] * hh, q[3][2] * hd).applyMatrix4(m);
      tmpN.set(BOX_NORMALS[f][0], BOX_NORMALS[f][1], BOX_NORMALS[f][2]).transformDirection(m);
      this.tri(tmpA.x, tmpA.y, tmpA.z, tmpB.x, tmpB.y, tmpB.z, tmpC.x, tmpC.y, tmpC.z, tmpN.x, tmpN.y, tmpN.z);
      this.tri(tmpA.x, tmpA.y, tmpA.z, tmpC.x, tmpC.y, tmpC.z, tmpD.x, tmpD.y, tmpD.z, tmpN.x, tmpN.y, tmpN.z);
    }
  }

  /**
   * Any (non-)indexed geometry with flat normals under `m`. `pick` returns the colour for a face of
   * (transformed) normal y, or null to drop it; it may also set glow / window state.
   */
  geo(g: THREE.BufferGeometry, m: THREE.Matrix4, pick: (ny: number) => number | null): void {
    const p = g.getAttribute('position');
    const nr = g.getAttribute('normal');
    const index = g.index;
    const count = index ? index.count : p.count;
    for (let i = 0; i < count; i += 3) {
      const i0 = index ? index.getX(i) : i;
      const i1 = index ? index.getX(i + 1) : i + 1;
      const i2 = index ? index.getX(i + 2) : i + 2;
      tmpN.fromBufferAttribute(nr, i0).transformDirection(m);
      const hex = pick(tmpN.y);
      if (hex === null) continue;
      this.c.setHex(hex);
      tmpA.fromBufferAttribute(p, i0).applyMatrix4(m);
      tmpB.fromBufferAttribute(p, i1).applyMatrix4(m);
      tmpC.fromBufferAttribute(p, i2).applyMatrix4(m);
      this.tri(tmpA.x, tmpA.y, tmpA.z, tmpB.x, tmpB.y, tmpB.z, tmpC.x, tmpC.y, tmpC.z, tmpN.x, tmpN.y, tmpN.z);
    }
  }

  private tri3(m: THREE.Matrix4, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void {
    tmpA.set(ax, ay, az).applyMatrix4(m);
    tmpB.set(bx, by, bz).applyMatrix4(m);
    tmpC.set(cx, cy, cz).applyMatrix4(m);
    tmpD.subVectors(tmpB, tmpA);
    tmpN.subVectors(tmpC, tmpA);
    tmpD.cross(tmpN).normalize();
    this.tri(tmpA.x, tmpA.y, tmpA.z, tmpB.x, tmpB.y, tmpB.z, tmpC.x, tmpC.y, tmpC.z, tmpD.x, tmpD.y, tmpD.z);
  }

  /**
   * Hipless gable roof over a w×d eave rectangle centred on `m`'s origin, ridge of height h along local x.
   * `ends` adds the two triangular gable ends (only needed where the side walls are exposed).
   */
  gable(m: THREE.Matrix4, w: number, h: number, d: number, ends: boolean): void {
    const hw = w / 2;
    const hd = d / 2;
    this.tri3(m, -hw, 0, hd, hw, 0, hd, hw, h, 0);
    this.tri3(m, -hw, 0, hd, hw, h, 0, -hw, h, 0);
    this.tri3(m, hw, 0, -hd, -hw, 0, -hd, -hw, h, 0);
    this.tri3(m, hw, 0, -hd, -hw, h, 0, hw, h, 0);
    if (ends) {
      this.tri3(m, hw, 0, hd, hw, 0, -hd, hw, h, 0);
      this.tri3(m, -hw, 0, -hd, -hw, 0, hd, -hw, h, 0);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('emis', new THREE.Float32BufferAttribute(this.emi, 3));
    g.setAttribute('bwin', new THREE.Float32BufferAttribute(this.bw, 4));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// --------------------------------------------------------------------- follow cutaway

/**
 * Dithered see-through tube along the view ray through the followed vehicle: building fragments
 * between the camera and `focus` (xyz, w = radius in metres, 0 = off) are discarded with a screen-
 * door pattern, so the vehicle never hides behind a tower. `dir` is the unit vector target → camera.
 * Shadow passes use other programs and keep the full silhouette.
 */
export const cutaway = {
  focus: { value: new THREE.Vector4(0, 0, 0, 0) },
  dir: { value: new THREE.Vector3(0, 1, 0) },
};

export function patchCutaway(shader: { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string }): void {
  shader.uniforms.uCutF = cutaway.focus;
  shader.uniforms.uCutD = cutaway.dir;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vCutW;')
    .replace(
      '#include <project_vertex>',
      `#include <project_vertex>
vec4 cutW = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
cutW = instanceMatrix * cutW;
#endif
vCutW = (modelMatrix * cutW).xyz;`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform vec4 uCutF;\nuniform vec3 uCutD;\nvarying vec3 vCutW;')
    .replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
if (uCutF.w > 0.0) {
  vec3 cutRel = vCutW - uCutF.xyz;
  float cutAlong = dot(cutRel, uCutD);
  if (cutAlong > 0.5) {
    float cutKeep = smoothstep(uCutF.w * 0.55, uCutF.w, length(cutRel - uCutD * cutAlong));
    float cutDither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (cutKeep < cutDither) discard;
  }
}`,
    );
}

// --------------------------------------------------------------------- wall material

/**
 * Low-poly material plus procedural window bands: dark panes at `fract((y − 0.9) / floorH)` in
 * [0.45, 0.8] above the ground floor, split by mullions along the wall, with a hashed share of
 * panes glowing at night. Driven by the `bwin` attribute (floorH, lit, ribbon, windowTop).
 */
function wallMaterial(): THREE.MeshStandardMaterial {
  const mat = makeMaterial({}, { roughness: 0.86 });
  const base = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    base.call(mat, shader, renderer);
    patchCutaway(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 bwin;\nvarying vec4 vBw;\nvarying vec2 vWin;')
      .replace('#include <project_vertex>', 'vBw = bwin;\nvWin = vec2(position.y, dot(position.xz, vec2(-normal.z, normal.x)));\n#include <project_vertex>');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vBw;\nvarying vec2 vWin;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float bWin = 0.0;
float bCell = 0.0;
float bRib = step(0.5, vBw.z);
if (vBw.x > 0.01 && vWin.x > 3.8 && vWin.x < vBw.w) {
  float fy = (vWin.x - 0.9) / vBw.x;
  float fr = fract(fy);
  float ax = vWin.y / 2.7;
  float fa = fract(ax);
  float wy = smoothstep(0.42, 0.47, fr) * (1.0 - smoothstep(0.78, 0.83, fr));
  float wx = mix(smoothstep(0.12, 0.17, fa) * (1.0 - smoothstep(0.80, 0.85, fa)), smoothstep(0.02, 0.06, fa), bRib);
  float aa = clamp(1.0 - fwidth(fy) * 2.2, 0.0, 1.0);
  bWin = wy * wx * aa;
  float h = fract(sin(dot(vec2(floor(fy), floor(ax)), vec2(12.9898, 78.233)) + vBw.y * 91.7) * 43758.5453);
  // Ribbon glazing lights whole bands, so fewer cells burn and each is dimmer than a punched window (else the tower blooms to solid white).
  bCell = step(h, mix(0.45 + 0.45 * vBw.y, min(0.4 + 0.3 * vBw.y, 0.68), bRib));
  diffuseColor.rgb *= 1.0 - 0.2 * (1.0 - aa);
}
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.13, 0.17, 0.2) * (1.0 + 0.25 * bRib), bWin * 0.88);`,
      )
      .replace(
        'totalEmissiveRadiance += vEmis * uNight;',
        `totalEmissiveRadiance += vEmis * uNight;
totalEmissiveRadiance += mix(vec3(1.0, 0.85, 0.63), vec3(0.8, 0.9, 1.0), bRib) * (bWin * bCell * vBw.y * uNight * mix(1.25, 0.62, bRib));`,
      );
  };
  mat.customProgramCacheKey = () => 'lowpoly:buildings';
  return mat;
}

// --------------------------------------------------------------------- polygon helpers

/** Outer ring without a repeated closing vertex. */
export function openRing(pts: number[]): number[] {
  const n = pts.length;
  if (n >= 6 && pts[0] === pts[n - 2] && pts[1] === pts[n - 1]) return pts.slice(0, n - 2);
  return pts;
}

/** Shoelace area; positive for the counter-clockwise (x right, z up) winding. */
function signedArea(p: ArrayLike<number>): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return a / 2;
}

export function inRing(p: ArrayLike<number>, x: number, z: number): boolean {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2];
    const zi = p[i * 2 + 1];
    const xj = p[j * 2];
    const zj = p[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function edgeDistance(p: ArrayLike<number>, x: number, z: number): number {
  let best = Infinity;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[i * 2];
    const az = p[i * 2 + 1];
    const dx = p[j * 2] - ax;
    const dz = p[j * 2 + 1] - az;
    const l2 = dx * dx + dz * dz || 1e-9;
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
  }
  return best;
}

export interface Obb {
  cx: number;
  cz: number;
  /** Heading of the long axis in the (x, z) plane. */
  theta: number;
  len: number;
  wid: number;
}

/** Minimum-area oriented bounding box (rotating over the polygon's edge directions). */
export function orientedBox(p: ArrayLike<number>): Obb {
  const n = p.length / 2;
  let best: Obb & { area: number; ang: number } = { cx: 0, cz: 0, theta: 0, len: 1, wid: 1, area: Infinity, ang: 0 };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ang = Math.atan2(p[j * 2 + 1] - p[i * 2 + 1], p[j * 2] - p[i * 2]);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const u = p[k * 2] * c + p[k * 2 + 1] * s;
      const v = -p[k * 2] * s + p[k * 2 + 1] * c;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best.area) {
      const cu = (u0 + u1) / 2;
      const cv = (v0 + v1) / 2;
      const wu = u1 - u0;
      const wv = v1 - v0;
      best = {
        cx: cu * c - cv * s,
        cz: cu * s + cv * c,
        theta: wu >= wv ? ang : ang + Math.PI / 2,
        len: Math.max(wu, wv),
        wid: Math.min(wu, wv),
        area,
        ang,
      };
    }
  }
  return best;
}

// --------------------------------------------------------------------- nearest-road index

/** Uniform grid over road reference-line samples (every 2 m, bridges excluded). */
class RoadIndex {
  private readonly cell = 24;
  private readonly x0: number;
  private readonly z0: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly cells: number[][];
  private readonly sx: number[] = [];
  private readonly sz: number[] = [];
  private readonly hw: number[] = [];
  private readonly cl: number[] = [];
  private readonly stx: number[] = [];
  private readonly stz: number[] = [];
  /** Results of the last `nearest` call. */
  dist = 0;
  halfW = 0;
  cls = 0;
  px = 0;
  pz = 0;
  tx = 1;
  tz = 0;

  constructor(net: Network) {
    const b = net.bounds;
    this.x0 = b.minX - 40;
    this.z0 = b.minZ - 40;
    this.nx = Math.ceil((b.maxX - b.minX + 80) / this.cell);
    this.nz = Math.ceil((b.maxZ - b.minZ + 80) / this.cell);
    this.cells = Array.from({ length: this.nx * this.nz }, () => []);
    for (const l of net.links) {
      if (l.bridge) continue;
      for (let i = 0; i < l.n; i += 4) {
        const x = l.px[i];
        const z = l.pz[i];
        const cx = Math.floor((x - this.x0) / this.cell);
        const cz = Math.floor((z - this.z0) / this.cell);
        if (cx < 0 || cz < 0 || cx >= this.nx || cz >= this.nz) continue;
        this.cells[cz * this.nx + cx].push(this.sx.length);
        this.sx.push(x);
        this.sz.push(z);
        this.hw.push(l.halfW);
        this.cl.push(l.cls);
        this.stx.push(l.tx[i]);
        this.stz.push(l.tz[i]);
      }
    }
  }

  /** Nearest sample within `maxR`; fills `dist`/`halfW`/`cls`/`px`/`pz`. */
  nearest(x: number, z: number, maxR: number): boolean {
    const cx = Math.floor((x - this.x0) / this.cell);
    const cz = Math.floor((z - this.z0) / this.cell);
    const r = Math.ceil(maxR / this.cell);
    let best = maxR * maxR;
    let found = -1;
    for (let j = Math.max(0, cz - r); j <= Math.min(this.nz - 1, cz + r); j++) {
      for (let i = Math.max(0, cx - r); i <= Math.min(this.nx - 1, cx + r); i++) {
        for (const k of this.cells[j * this.nx + i]) {
          const dx = this.sx[k] - x;
          const dz = this.sz[k] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < best) {
            best = d2;
            found = k;
          }
        }
      }
    }
    if (found < 0) return false;
    this.dist = Math.sqrt(best);
    this.halfW = this.hw[found];
    this.cls = this.cl[found];
    this.px = this.sx[found];
    this.pz = this.sz[found];
    this.tx = this.stx[found];
    this.tz = this.stz[found];
    return true;
  }
}

// --------------------------------------------------------------------- procedural infill

/**
 * OSM only maps a few hundred footprints and Google Open Buildings adds ~2 000 real ones, so the rest of every
 * free street frontage is filled with procedural Saigon tube houses (nhà ống) and the block interiors with
 * mid-rises. All of it is planned from the `Zoning` raster (nothing on asphalt, sidewalk, water, parks, footprints
 * or roundabouts), hashed from stable integer keys, and merged into a handful of spatial tiles.
 */
const TRI_BUDGET = 320_000;
/** Triangles reserved for parked scooters and street-food corners. */
const PROP_BUDGET = 50_000;
const MAX_FILL_SIGNS = 3000;
const TILE = 480;
/** Distance (m) from the asphalt edge to the front wall of a tube house: the 3.2 m sidewalk plus a 0.7 m porch. */
const FRONT_SETBACK = SIDEWALK + 0.7;
const SHOP_GATE = 0;
const SHOP_OPEN = 1;
const SHOP_SHUTTER = 2;
const DOORS = [0x5b3a29, 0x2f6b9a, 0x3f7a4a, 0x7a2f2a, 0x4a4a48];
const RAILS = [0x2f7d74, 0xc8463a, 0x3a3a3a, 0xf0e6d0, 0x2f6b9a, 0x6b8f3a];
const TIN = [0x6f93a8, 0x7fa8a0, 0xb26a4e, 0x9aa7ad];
const SHUTTER = 0x8a8f94;

interface Lot {
  /** false = street-front tube house, true = interior mid-rise. */
  mid: boolean;
  x: number;
  z: number;
  /** Local +z faces the street (tube houses); local +x is the width axis. */
  yaw: number;
  w: number;
  d: number;
  floors: number;
  wall: number;
  roof: number;
  gable: boolean;
  ribbon: boolean;
  /** Neighbouring lots on the local +x / −x side (−1 = none), which share a party wall. */
  px: number;
  mx: number;
  shop: number;
  sign: number;
  glow: number;
  lit: number;
  awning: number;
  /** Storey whose slab carries a balcony (0 = none). */
  balcony: number;
  rail: number;
  tank: number;
  tankA: number;
  tankB: number;
  hut: boolean;
  door: number;
  seed: number;
  drop: boolean;
  /** Real-world footprint (Open Buildings): the body is never dropped for budget, only its details thin out. */
  real: boolean;
}

/** Oriented rectangles in a coarse hash grid; SAT overlap with a required clearance. */
class LotIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly x: number[] = [];
  private readonly z: number[] = [];
  private readonly ux: number[] = [];
  private readonly uz: number[] = [];
  private readonly hw: number[] = [];
  private readonly hd: number[] = [];

  private static key(i: number, j: number): number {
    return (i + 4096) * 8192 + (j + 4096);
  }

  add(x: number, z: number, ux: number, uz: number, hw: number, hd: number): void {
    const id = this.x.length;
    this.x.push(x);
    this.z.push(z);
    this.ux.push(ux);
    this.uz.push(uz);
    this.hw.push(hw);
    this.hd.push(hd);
    const k = LotIndex.key(Math.floor(x / 32), Math.floor(z / 32));
    const c = this.cells.get(k);
    if (c) c.push(id);
    else this.cells.set(k, [id]);
  }

  /** True if the rectangle comes closer than `gap` metres to any stored one (negative gap tolerates touching). */
  hits(x: number, z: number, ux: number, uz: number, hw: number, hd: number, gap: number): boolean {
    const ci = Math.floor(x / 32);
    const cj = Math.floor(z / 32);
    const vx = -uz;
    const vz = ux;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const list = this.cells.get(LotIndex.key(ci + di, cj + dj));
        if (!list) continue;
        for (const k of list) {
          const dx = this.x[k] - x;
          const dz = this.z[k] - z;
          const reach = hw + hd + this.hw[k] + this.hd[k] + gap;
          if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
          const ox = this.ux[k];
          const oz = this.uz[k];
          if (
            this.apart(dx, dz, ux, uz, ux, uz, vx, vz, hw, hd, ox, oz, k, gap) ||
            this.apart(dx, dz, vx, vz, ux, uz, vx, vz, hw, hd, ox, oz, k, gap) ||
            this.apart(dx, dz, ox, oz, ux, uz, vx, vz, hw, hd, ox, oz, k, gap) ||
            this.apart(dx, dz, -oz, ox, ux, uz, vx, vz, hw, hd, ox, oz, k, gap)
          ) {
            continue;
          }
          return true;
        }
      }
    }
    return false;
  }

  /** Separating-axis test on axis (ax, az). */
  private apart(
    dx: number,
    dz: number,
    ax: number,
    az: number,
    ux: number,
    uz: number,
    vx: number,
    vz: number,
    hw: number,
    hd: number,
    ox: number,
    oz: number,
    k: number,
    gap: number,
  ): boolean {
    const r1 = hw * Math.abs(ux * ax + uz * az) + hd * Math.abs(vx * ax + vz * az);
    const r2 = this.hw[k] * Math.abs(ox * ax + oz * az) + this.hd[k] * Math.abs(-oz * ax + ox * az);
    return Math.abs(dx * ax + dz * az) >= r1 + r2 + gap;
  }
}

const wallCol = new THREE.Color();
const greyCol = new THREE.Color(ROOF_GREY);
const roofOf = (wall: number, r: number): number => {
  if (r < 0.5) return wallCol.setHex(wall).lerp(greyCol, 0.55).getHex();
  if (r < 0.72) return TIN[Math.floor(((r - 0.5) / 0.22) * TIN.length)];
  return TILES[Math.floor(((r - 0.72) / 0.28) * TILES.length)];
};

/**
 * Rolls the look of a street-front tube house (everything except footprint and floors, which the caller owns).
 * `R(n)` is the lot's stable hash stream; `avoidWall` is a wall index to skip (−1 = none). Returns the wall index used.
 */
function dressTube(L: Lot, R: (n: number) => number, major: boolean, avoidWall: number): number {
  let wi = Math.floor(R(5) * WALLS.length);
  if (wi === avoidWall) wi = (wi + 1) % WALLS.length;
  L.wall = WALLS[wi];
  L.gable = L.floors <= 3 && R(19) < 0.3;
  L.roof = L.gable ? TILES[Math.floor(R(21) * TILES.length)] : roofOf(L.wall, R(20));
  L.shop = R(6) < (major ? 0.88 : 0.66) ? (R(7) < 0.14 ? SHOP_SHUTTER : SHOP_OPEN) : SHOP_GATE;
  if (L.shop === SHOP_OPEN) {
    L.sign = R(8) < 0.88 ? Math.floor(R(9) * 8) : -1;
    L.glow = R(10) < 0.12 ? 0.08 : 0.45 + 0.65 * R(12);
    if (R(13) < 0.7) L.awning = AWNINGS[Math.floor(R(14) * AWNINGS.length)];
  }
  L.door = DOORS[Math.floor(R(15) * DOORS.length)];
  if (L.floors >= 3 && R(16) < 0.55) L.balcony = L.floors >= 5 && R(17) < 0.4 ? 3 : 2;
  L.rail = RAILS[Math.floor(R(18) * RAILS.length)];
  if (!L.gable) {
    if (R(22) < 0.6) L.tank = TANKS[Math.floor(R(23) * TANKS.length)];
    L.tankA = (R(24) - 0.5) * L.w * 0.4;
    L.tankB = (R(25) - 0.5) * L.d * 0.5;
    L.hut = R(26) < 0.22;
  }
  return wi;
}

/** Rolls the look of an interior mid-rise (floors and footprint stay with the caller). */
function dressMid(L: Lot, seed: number): void {
  const pick = rand01(seed, 7);
  L.wall = L.floors >= 6 ? MIDRISE[Math.floor(pick * MIDRISE.length)] : WALLS[Math.floor(pick * WALLS.length)];
  L.roof = roofOf(L.wall, rand01(seed, 8));
  L.ribbon = L.floors >= 6 && rand01(seed, 9) < 0.3;
  if (rand01(seed, 12) < 0.5) L.tank = TANKS[Math.floor(rand01(seed, 13) * TANKS.length)];
  L.tankA = (rand01(seed, 14) - 0.5) * L.w * 0.4;
  L.tankB = (rand01(seed, 15) - 0.5) * L.d * 0.4;
  L.hut = rand01(seed, 16) < 0.55;
}

/** A fresh lot with neutral looks; `dressTube` / `dressMid` roll the rest. */
function blankLot(mid: boolean, x: number, z: number, yaw: number, w: number, d: number, seed: number): Lot {
  return {
    mid,
    x,
    z,
    yaw,
    w,
    d,
    floors: 3,
    wall: WALLS[0],
    roof: ROOF_GREY,
    gable: false,
    ribbon: false,
    px: -1,
    mx: -1,
    shop: -1,
    sign: -1,
    glow: 0,
    lit: 0.3 + 0.8 * rand01(seed, 11),
    awning: 0,
    balcony: 0,
    rail: 0,
    tank: 0,
    tankA: 0,
    tankB: 0,
    hut: false,
    door: DOORS[0],
    seed,
    drop: false,
    real: false,
  };
}

/** Open Buildings footprints that read as one house: near-rectangular (fill of the oriented box) and at most 10 × 30 m. */
const GOB_BOXY_FILL = 0.8;
const GOB_BOXY_WID = 10;
const GOB_BOXY_LEN = 30;
/** No source carries heights for satellite footprints, so the guess stays modest (real towers are already in OSM). */
const GOB_MAX_FLOORS = 10;

/** Storeys of an Open Buildings footprint: a pure function of its id, planar area and street context. */
function gobFloors(id: number, area: number, front: boolean, major: boolean): number {
  const R = (n: number): number => rand01(id, n);
  let floors: number;
  if (area < 150) {
    if (front) {
      const u = R(3);
      floors = u < 0.12 ? 2 : u < 0.4 ? 3 : u < 0.7 ? 4 : u < 0.9 ? 5 : 6;
      if (major && R(4) < 0.5) floors++;
    } else {
      floors = 2 + Math.floor(R(3) * 3);
    }
  } else if (area < 400) {
    floors = 3 + Math.floor(R(3) * 4) + (major ? 1 : 0);
  } else if (area < 1000) {
    floors = 4 + Math.floor(R(3) * 5) + (major ? 2 : 0);
  } else {
    floors = 5 + Math.floor(R(3) * 6);
  }
  return Math.min(GOB_MAX_FLOORS, floors);
}

/** A point inside the ring, preferring the oriented-box centre, then the area centroid, then midpoints towards it. */
function interiorPoint(outer: number[], box: Obb): { x: number; z: number } {
  const n = outer.length / 2;
  let a = 0;
  let gx = 0;
  let gz = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cross = outer[i * 2] * outer[j * 2 + 1] - outer[j * 2] * outer[i * 2 + 1];
    a += cross;
    gx += (outer[i * 2] + outer[j * 2]) * cross;
    gz += (outer[i * 2 + 1] + outer[j * 2 + 1]) * cross;
  }
  const centroid = Math.abs(a) > 1e-6 ? { x: gx / (3 * a), z: gz / (3 * a) } : { x: box.cx, z: box.cz };
  if (inRing(outer, box.cx, box.cz)) return { x: box.cx, z: box.cz };
  if (inRing(outer, centroid.x, centroid.z)) return centroid;
  for (let i = 0; i < n; i++) {
    const x = (outer[i * 2] + centroid.x) / 2;
    const z = (outer[i * 2 + 1] + centroid.z) / 2;
    if (inRing(outer, x, z)) return { x, z };
  }
  return { x: outer[0], z: outer[1] };
}

interface GobPlan {
  /** Box-like footprints, dressed as real tube houses / mid-rises. */
  lots: Lot[];
  /** Irregular or large footprints, extruded as exact polygons by the OSM loop. */
  extruded: SceneJson['buildings'];
  hiddenByOverride: number;
  hiddenByGround: number;
}

/**
 * Plans every Open Buildings footprint. Box-like ones (≈83 %) become `Lot.real` through the same tube / mid
 * dressing as the procedural infill, facing the nearest road; the rest are extruded as polygons with a
 * deterministic floor guess. A footprint whose centre is no longer `OCC_BUILT` (plazas, sites, water and
 * promenade win over it in `Zoning`) or that `BUILDING_OVERRIDES` hides is dropped.
 */
function planGobLots(scene: SceneJson, zoning: Zoning, roads: RoadIndex): GobPlan {
  const plan: GobPlan = { lots: [], extruded: [], hiddenByOverride: 0, hiddenByGround: 0 };
  for (const g of scene.gobBuildings) {
    const ov = BUILDING_OVERRIDES[g.id];
    if (ov?.hidden === true) {
      plan.hiddenByOverride++;
      continue;
    }
    const outer = openRing(g.pts);
    if (outer.length < 6) continue;
    const area = Math.abs(signedArea(outer));
    const box = orientedBox(outer);
    const c = interiorPoint(outer, box);
    if (zoning.occupancy(c.x, c.z) !== OCC_BUILT) {
      plan.hiddenByGround++;
      continue;
    }
    const hasRoad = roads.nearest(box.cx, box.cz, 40);
    const major = hasRoad && roads.cls <= SECONDARY;
    const roadDx = roads.px - box.cx;
    const roadDz = roads.pz - box.cz;
    const boxy = area / Math.max(1, box.len * box.wid) >= GOB_BOXY_FILL && box.wid <= GOB_BOXY_WID && box.len <= GOB_BOXY_LEN;
    if (!boxy) {
      const front = zoning.roadDist(box.cx, box.cz) - box.wid / 2 <= SIDEWALK + 2.5;
      plan.extruded.push({ osm: g.id, pts: g.pts, holes: [], levels: gobFloors(g.id, area, front, major), height: null, name: '', kind: 'gob' });
      continue;
    }

    // Face the nearest road with the box side whose outward normal points at it; w = that frontage, d = depth.
    const cu = Math.cos(box.theta);
    const su = Math.sin(box.theta);
    let w = box.len;
    let d = box.wid;
    let yaw = -box.theta;
    let front = false;
    if (hasRoad) {
      const alongDot = roadDx * cu + roadDz * su;
      const acrossDot = -roadDx * su + roadDz * cu;
      let nx: number;
      let nz: number;
      if (Math.abs(acrossDot) >= Math.abs(alongDot)) {
        const s = acrossDot >= 0 ? 1 : -1;
        nx = -su * s;
        nz = cu * s;
      } else {
        const s = alongDot >= 0 ? 1 : -1;
        nx = cu * s;
        nz = su * s;
        w = box.wid;
        d = box.len;
      }
      yaw = Math.atan2(nx, nz);
      front = zoning.roadDist(box.cx + nx * (d / 2), box.cz + nz * (d / 2)) <= SIDEWALK + 2.5;
    }

    const R = (n: number): number => rand01(g.id, n);
    const L = blankLot(false, box.cx, box.cz, yaw, w, d, g.id);
    L.real = true;
    const shed = w >= 12 && d <= 6;
    const ovFloors = ov?.levels ?? (ov?.height !== undefined ? Math.round(ov.height / FLOOR_H) : undefined);
    if (ovFloors !== undefined) L.floors = Math.max(1, Math.min(MAX_FLOORS, ovFloors));
    else if (shed) L.floors = 1 + Math.floor(R(3) * 2);
    else L.floors = gobFloors(g.id, area, front, major);
    if (!hasRoad || (!front && area >= 150)) {
      L.mid = true;
      dressMid(L, g.id);
    } else {
      dressTube(L, R, major, -1);
      if (!front) {
        L.shop = -1;
        L.sign = -1;
        L.glow = 0;
        L.awning = 0;
      }
    }
    if (shed) {
      L.gable = true;
      L.roof = TILES[Math.floor(R(21) * TILES.length)];
      L.tank = 0;
      L.hut = false;
      L.balcony = 0;
    }
    plan.lots.push(L);
  }
  return plan;
}

/** Plans every infill lot around the real `seedLots` (which are kept first, in order). Deterministic: only hashes of stable integer keys are used. */
function planFill(net: Network, scene: SceneJson, zoning: Zoning, roads: RoadIndex, seedLots: Lot[]): Lot[] {
  const b = net.bounds;
  const gw = Math.ceil(b.maxX - b.minX) + 1;
  const gh = Math.ceil(b.maxZ - b.minZ) + 1;
  const park = new Uint8Array(gw * gh);
  for (const p of scene.parks) {
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
    for (let j = Math.max(0, Math.floor(z0 - b.minZ)); j <= Math.min(gh - 1, Math.ceil(z1 - b.minZ)); j++) {
      for (let i = Math.max(0, Math.floor(x0 - b.minX)); i <= Math.min(gw - 1, Math.ceil(x1 - b.minX)); i++) {
        if (pointInPolygon(p.pts, b.minX + i + 0.5, b.minZ + j + 0.5)) park[j * gw + i] = 1;
      }
    }
  }
  const occ = zoning.occ;
  const free = (x: number, z: number): boolean => {
    const i = Math.floor(x - b.minX);
    const j = Math.floor(z - b.minZ);
    if (i < 0 || j < 0 || i >= gw || j >= gh) return false;
    const k = j * gw + i;
    return occ[k] === OCC_FREE && park[k] === 0;
  };

  /** Rectangle (centre, width axis u, half extents) free of footprints/water/parks, and clear of road and sidewalk. */
  const rectOk = (cx: number, cz: number, ux: number, uz: number, hw: number, hd: number): boolean => {
    const vx = -uz;
    const vz = ux;
    const na = Math.max(1, Math.ceil((2 * hw) / 1.3));
    const nb = Math.max(1, Math.ceil((2 * hd) / 1.3));
    for (let i = 0; i <= na; i++) {
      const a = -hw + (2 * hw * i) / na;
      for (let j = 0; j <= nb; j++) {
        const c = -hd + (2 * hd * j) / nb;
        if (!free(cx + ux * a + vx * c, cz + uz * a + vz * c)) return false;
      }
    }
    const nr = Math.max(1, Math.ceil((2 * hd - 0.6) / 4));
    for (const a of [-hw + 0.2, hw - 0.2]) {
      for (let j = 0; j <= nr; j++) {
        const c = -hd + 0.3 + ((2 * hd - 0.6) * j) / nr;
        if (!zoning.buildable(cx + ux * a + vx * c, cz + uz * a + vz * c)) return false;
      }
    }
    return zoning.buildable(cx, cz);
  };

  const lots: Lot[] = [...seedLots];
  const index = new LotIndex();
  for (const L of seedLots) index.add(L.x, L.z, Math.cos(L.yaw), -Math.sin(L.yaw), L.w / 2, L.d / 2);

  // ---- tube houses along both sides of every link
  const sample = new Float32Array(4);
  let lastWall = -1;
  for (const link of net.links) {
    if (link.bridge || link.length < 8) continue;
    const major = link.cls <= SECONDARY;
    for (const side of [1, -1]) {
      const extent = side > 0 ? link.halfW : link.halfW + (link.oneway ? 0 : link.median / 2);
      const rowKey = link.id * 4099 + (side > 0 ? 1 : 2) * 131;
      let s = 2 + 3 * rand01(rowKey, 1);
      let prev = -1;
      let rowD = 14;
      let rowLeft = 0;
      let k = 0;
      while (s < link.length - 2) {
        const seed = rowKey + k * 17;
        k++;
        const R = (n: number): number => rand01(seed, n);
        if (rowLeft-- <= 0) {
          rowD = 12 + 8 * R(30);
          rowLeft = 3 + Math.floor(R(31) * 4);
        }
        const w = R(0) < 0.08 ? 7.5 + 2 * R(1) : 3.9 + 1.3 * R(2);
        link.sample(Math.min(link.length, s + w / 2), sample);
        const tx = sample[2];
        const tz = sample[3];
        const nx = side > 0 ? -tz : tz;
        const nz = side > 0 ? tx : -tx;
        let found = -1;
        const tMax = extent + SIDEWALK + 5;
        for (let t = Math.max(0, extent - 1.5); t <= tMax; t += 0.35) {
          if (zoning.roadDist(sample[0] + nx * t, sample[1] + nz * t) >= FRONT_SETBACK) {
            found = t;
            break;
          }
        }
        if (found < 0) {
          prev = -1;
          s += 2.5;
          continue;
        }
        const fx = sample[0] + nx * found;
        const fz = sample[1] + nz * found;
        const ux = -nz;
        const uz = nx;
        let placed = false;
        for (let d = rowD; d >= 9; d -= 2.5) {
          const cx = fx + nx * (d / 2);
          const cz = fz + nz * (d / 2);
          if (index.hits(cx, cz, ux, uz, w / 2, d / 2, -0.3)) continue;
          if (!rectOk(cx, cz, ux, uz, w / 2, d / 2)) continue;
          const L = blankLot(false, cx, cz, Math.atan2(-nx, -nz), w, d, seed);
          const u = R(3);
          L.floors = u < 0.12 ? 2 : u < 0.4 ? 3 : u < 0.7 ? 4 : u < 0.9 ? 5 : 6;
          if (major && R(4) < 0.5) L.floors++;
          lastWall = dressTube(L, R, major, lastWall);
          if (prev >= 0) {
            if (side > 0) {
              L.px = prev;
              lots[prev].mx = lots.length;
            } else {
              L.mx = prev;
              lots[prev].px = lots.length;
            }
          }
          prev = lots.length;
          lots.push(L);
          index.add(cx, cz, ux, uz, w / 2, d / 2);
          placed = true;
          break;
        }
        if (placed) {
          s += w;
          if (R(27) < 0.07) {
            s += 1.5 + 1.2 * R(28);
            prev = -1;
          }
        } else {
          prev = -1;
          s += 2;
        }
      }
    }
  }
  const tubes = lots.length - seedLots.length;

  // ---- interior mid-rises: greedy packing on two jittered lattices, aligned with the nearest street
  const passes = [
    { step: 12, wMin: 10, wMax: 18, dMin: 9, dMax: 16 },
    { step: 7.5, wMin: 6.5, wMax: 10.5, dMin: 6.5, dMax: 10 },
  ];
  for (let pass = 0; pass < passes.length; pass++) {
    const P = passes[pass];
    const ix0 = Math.floor(b.minX / P.step);
    const iz0 = Math.floor(b.minZ / P.step);
    const ix1 = Math.ceil(b.maxX / P.step);
    const iz1 = Math.ceil(b.maxZ / P.step);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const seed = (ix * 7919 + iz * 104729 + pass * 31) | 0;
        const x = (ix + 0.5 + (rand01(seed, 1) - 0.5) * 0.7) * P.step;
        const z = (iz + 0.5 + (rand01(seed, 2) - 0.5) * 0.7) * P.step;
        if (!free(x, z) || !roads.nearest(x, z, 90)) continue;
        const tx = roads.tx;
        const tz = roads.tz;
        const cls = roads.cls;
        const bigW = P.wMin + (P.wMax - P.wMin) * rand01(seed, 3);
        const bigD = P.dMin + (P.dMax - P.dMin) * rand01(seed, 4);
        for (const k of [1, 0.78, 0.6]) {
          const w = bigW * k;
          const d = bigD * k;
          if (w < 6 || d < 6) break;
          if (index.hits(x, z, tx, tz, w / 2, d / 2, 1.8)) continue;
          if (!rectOk(x, z, tx, tz, w / 2, d / 2)) continue;
          const L = blankLot(true, x, z, Math.atan2(-tz, tx), w, d, seed);
          const u = rand01(seed, 5);
          L.floors = 3 + Math.floor(u * 6);
          if (cls <= SECONDARY && rand01(seed, 6) < 0.5) L.floors++;
          dressMid(L, seed);
          lots.push(L);
          index.add(x, z, tx, tz, w / 2, d / 2);
          break;
        }
      }
    }
  }
  if (import.meta.env.DEV) console.info(`[buildings] infill lots: ${tubes} tube houses + ${lots.length - seedLots.length - tubes} mid-rises`);
  return lots;
}

interface FillSign {
  x: number;
  z: number;
  yaw: number;
  w: number;
  light: number;
  sign: number;
}

interface FillResult {
  soups: Soup[];
  signs: FillSign[];
  fronts: { x: number; z: number; fx: number; fz: number }[];
  tris: number;
  tube: number;
  mid: number;
}

/** Merges the planned lots into per-tile soups, spending at most `budget` triangles (details thin out fairly before bodies do). */
function emitFill(lots: Lot[], net: Network, budget: number): FillResult {
  const bounds = net.bounds;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const col = new THREE.Color();
  const tankGeo = cyl(0.6, 1.5, 8).toNonIndexed();
  const yawM = (x: number, y: number, z: number, yaw: number, pitch = 0): THREE.Matrix4 => {
    q.setFromEuler(EULER.set(pitch, yaw, 0, 'YXZ'));
    return m.compose(pos.set(x, y, z), q, one);
  };

  const tiles = new Map<number, Soup>();
  const soupAt = (x: number, z: number): Soup => {
    const key = Math.floor((x - bounds.minX) / TILE) * 1024 + Math.floor((z - bounds.minZ) / TILE);
    let s = tiles.get(key);
    if (!s) {
      s = new Soup();
      tiles.set(key, s);
    }
    return s;
  };
  const total = (): number => {
    let t = 0;
    for (const s of tiles.values()) t += s.tris;
    return t;
  };
  const exposed = (L: Lot, n: number): boolean => n < 0 || lots[n].drop || L.floors > lots[n].floors;

  let tubeTris = 0;
  let midTris = 0;
  let realTris = 0;
  const body = (L: Lot): void => {
    const s = soupAt(L.x, L.z);
    const before = s.tris;
    const H = L.floors * FLOOR_H;
    const mat = yawM(L.x, H / 2, L.z, L.yaw);
    s.lit = L.lit;
    s.top = H - 0.4;
    s.style = L.ribbon ? 1 : 0;
    s.f = FLOOR_H;
    s.color(L.wall);
    s.box(mat, L.w, H, L.d, 16 | NZ);
    s.f = 0;
    s.top = 0;
    s.lit = 0;
    s.style = 0;
    col.setHex(L.wall).multiplyScalar(0.92);
    s.c.copy(col);
    const sides = (exposed(L, L.px) ? 1 : 0) | (exposed(L, L.mx) ? 2 : 0);
    if (sides) s.box(mat, L.w, H, L.d, sides);
    s.color(L.roof);
    if (L.gable) {
      const ridge = Math.min(2.2, L.d * 0.14);
      s.color(L.roof);
      s.gable(yawM(L.x, H, L.z, L.yaw), L.w, ridge, L.d, sides !== 0);
    } else {
      s.box(mat, L.w, H, L.d, PY);
    }
    if (L.real) realTris += s.tris - before;
    else if (L.mid) midTris += s.tris - before;
    else tubeTris += s.tris - before;
  };

  let keepTube = 1;
  let keepMid = 1;
  const runBodies = (): void => {
    tiles.clear();
    tubeTris = 0;
    midTris = 0;
    realTris = 0;
    for (const L of lots) {
      L.drop = !L.real && rand01(L.seed, 3) >= (L.mid ? keepMid : keepTube);
      if (!L.drop) body(L);
    }
  };
  runBodies();
  const bodyCap = budget * 0.72;
  if (total() > bodyCap) {
    const tube = tubeTris;
    const mid = midTris;
    const procCap = Math.max(0, bodyCap - realTris);
    if (tube >= procCap) {
      keepTube = tube > 0 ? procCap / tube : 0;
      keepMid = 0;
    } else {
      keepMid = Math.max(0, (procCap - tube) / Math.max(1, mid));
    }
    runBodies();
  }

  // ---- details, thinned by one fair keep-probability per tier
  const live = lots.filter((L) => !L.drop);
  const tiers = [
    { cap: 0.8, est: live.filter((L) => L.shop >= 0).length * 8 },
    { cap: 0.88, est: live.filter((L) => L.awning !== 0).length * 10 },
    { cap: 0.95, est: live.filter((L) => L.balcony > 0).length * 18 },
    { cap: 1, est: live.filter((L) => L.tank !== 0).length * 24 + live.filter((L) => L.hut).length * 10 },
  ];
  const keepFor = (t: number): number => Math.max(0, Math.min(1, (budget * tiers[t].cap - total()) / Math.max(1, tiers[t].est)));

  const signs: FillSign[] = [];
  const fronts: FillResult['fronts'] = [];
  const shopKeep = keepFor(0);
  for (const L of live) {
    if (L.shop < 0 || rand01(L.seed, 91) >= shopKeep) continue;
    const s = soupAt(L.x, L.z);
    const ox = Math.sin(L.yaw);
    const oz = Math.cos(L.yaw);
    const ux = oz;
    const uz = -ox;
    const fx = L.x + ox * (L.d / 2);
    const fz = L.z + oz * (L.d / 2);
    if (L.shop === SHOP_GATE) {
      const off = (rand01(L.seed, 92) < 0.5 ? -1 : 1) * L.w * 0.22;
      s.color(L.door);
      s.box(yawM(fx + ux * off + ox * 0.02, 1.2, fz + uz * off + oz * 0.02, L.yaw), Math.min(1.7, L.w * 0.4), 2.4, 0.2, ALL & ~NZ & ~NY);
      continue;
    }
    const sw = Math.max(2, Math.min(L.w * 0.88, 4.6));
    if (L.shop === SHOP_OPEN) {
      s.color(SHOP_DARK);
      s.glow(SHOP_GLOW, 1.8 * L.glow);
      s.box(yawM(fx + ox * 0.02, 1.4, fz + oz * 0.02, L.yaw), sw, 2.75, 0.25, ALL & ~NZ & ~NY);
      s.noGlow();
      if (L.sign >= 0 && signs.length < MAX_FILL_SIGNS) signs.push({ x: fx, z: fz, yaw: L.yaw, w: sw, light: L.glow, sign: L.sign });
      fronts.push({ x: fx + ox * 1.9, z: fz + oz * 1.9, fx: ox, fz: oz });
    } else {
      s.color(SHUTTER);
      s.box(yawM(fx + ox * 0.02, 1.4, fz + oz * 0.02, L.yaw), sw, 2.75, 0.25, ALL & ~NZ & ~NY);
    }
  }

  const awnKeep = keepFor(1);
  for (const L of live) {
    if (L.awning === 0 || L.shop !== SHOP_OPEN || rand01(L.seed, 93) >= awnKeep) continue;
    const s = soupAt(L.x, L.z);
    const ox = Math.sin(L.yaw);
    const oz = Math.cos(L.yaw);
    const proj = 1.2;
    const sw = Math.max(2, Math.min(L.w * 0.88, 4.6));
    s.color(L.awning);
    s.box(
      yawM(L.x + ox * (L.d / 2 + proj / 2), 2.86, L.z + oz * (L.d / 2 + proj / 2), L.yaw, 0.3),
      Math.min(L.w * 0.98, sw + 0.4),
      0.08,
      proj / Math.cos(0.3),
      ALL & ~NZ,
    );
  }

  const balKeep = keepFor(2);
  for (const L of live) {
    if (L.balcony === 0 || rand01(L.seed, 94) >= balKeep) continue;
    const s = soupAt(L.x, L.z);
    const ox = Math.sin(L.yaw);
    const oz = Math.cos(L.yaw);
    const y0 = L.balcony * FLOOR_H;
    const fx = L.x + ox * (L.d / 2);
    const fz = L.z + oz * (L.d / 2);
    const bw = L.w * 0.84;
    col.setHex(L.wall).lerp(new THREE.Color(0xffffff), 0.45);
    s.c.copy(col);
    s.box(yawM(fx + ox * 0.5, y0 + 0.07, fz + oz * 0.5, L.yaw), bw, 0.14, 1.0, ALL & ~NY);
    s.color(L.rail);
    s.box(yawM(fx + ox * 0.96, y0 + 0.56, fz + oz * 0.96, L.yaw), bw, 0.84, 0.06, ALL & ~NY & ~NZ);
  }

  const roofKeep = keepFor(3);
  for (const L of live) {
    if ((L.tank === 0 && !L.hut) || rand01(L.seed, 95) >= roofKeep) continue;
    const s = soupAt(L.x, L.z);
    const ox = Math.sin(L.yaw);
    const oz = Math.cos(L.yaw);
    const ux = oz;
    const uz = -ox;
    const H = L.floors * FLOOR_H;
    if (L.tank !== 0) {
      const tank = L.tank;
      m.makeTranslation(L.x + ux * L.tankA + ox * L.tankB, H + 0.75, L.z + uz * L.tankA + oz * L.tankB);
      s.geo(tankGeo, m, (ny) => (ny < -0.5 ? null : tank));
    }
    if (L.hut) {
      const back = -L.d * 0.32;
      col.setHex(L.wall).lerp(new THREE.Color(0xffffff), 0.3);
      s.c.copy(col);
      s.box(yawM(L.x + ox * back - ux * L.tankA * 0.5, H + 1.1, L.z + oz * back - uz * L.tankA * 0.5, L.yaw), 1.8, 2.2, 2.4, ALL & ~NY);
    }
  }
  tankGeo.dispose();
  return { soups: [...tiles.values()], signs, fronts, tris: total(), tube: lots.filter((L) => !L.mid && !L.drop).length, mid: lots.filter((L) => L.mid && !L.drop).length };
}

function triCount(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}

// --------------------------------------------------------------------- builder

export interface BuildingsResult {
  group: THREE.Group;
  /** Spots in front of shops on the sidewalk, used for vendors and pedestrians. */
  shopFronts: { x: number; z: number; fx: number; fz: number }[];
}

export function buildBuildings(net: Network, scene: SceneJson, zoning: Zoning): BuildingsResult {
  const group = new THREE.Group();
  group.name = 'buildings';
  const rng = new Rng(4242);
  const roads = new RoadIndex(net);
  const soup = new Soup();
  const matrix = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  const wallCol = new THREE.Color();
  const roofCol = new THREE.Color();
  const grey = new THREE.Color(ROOF_GREY);
  const white = new THREE.Color(0xffffff);

  const tankGeo = cyl(0.6, 1.5, 8).toNonIndexed();
  const shopFronts: BuildingsResult['shopFronts'] = [];
  type Unit = { x: number; z: number; yaw: number; w: number; light: number; sign: number };
  const units: Unit[] = [];
  let count = 0;

  const yawMatrix = (x: number, y: number, z: number, yaw: number, pitch = 0): THREE.Matrix4 => {
    q.setFromEuler(EULER.set(pitch, yaw, 0, 'YXZ'));
    return matrix.compose(tmpA.set(x, y, z), q, tmpB.set(1, 1, 1));
  };

  const gob = planGobLots(scene, zoning, roads);
  let gobExtCount = 0;
  let gobExtTris = 0;
  for (const b of [...scene.buildings, ...gob.extruded]) {
    // Building sites are drawn by construction.ts: bare concrete frames instead of walls with windows.
    if (b.kind === 'construction') continue;
    if (BUILDING_OVERRIDES[b.osm]?.hidden === true) continue;
    const outer = openRing(b.pts);
    const n = outer.length / 2;
    const trisBefore = soup.tris;
    if (n < 3) continue;
    const holes = b.holes.map(openRing).filter((h) => h.length >= 6);
    const sgn = signedArea(outer) >= 0 ? 1 : -1;
    let area = Math.abs(signedArea(outer));
    for (const h of holes) area -= Math.abs(signedArea(h));
    area = Math.max(area, 1);
    const box = orientedBox(outer);

    // ---- height and character
    const ov = BUILDING_OVERRIDES[b.osm];
    const kind = ov?.kind ?? b.kind;
    const tagHeight = ov?.height ?? b.height;
    const tagLevels = ov?.levels ?? b.levels;
    const low = LOW_KINDS[kind] === true;
    const bare = low || ov?.windows === false;
    const sacred = SACRED_KINDS[kind] === true;
    const r11 = rand01(b.osm, 11);
    let H: number;
    if (tagHeight !== null && tagHeight > 0) {
      H = Math.max(3, tagHeight);
    } else if (tagLevels !== null && tagLevels > 0) {
      H = Math.min(tagLevels, MAX_FLOORS) * FLOOR_H;
    } else {
      let floors: number;
      if (low) {
        floors = 0;
      } else if (sacred) {
        floors = 2 + Math.floor(r11 * 2);
      } else {
        let cls = 4;
        if (roads.nearest(box.cx, box.cz, 80)) cls = roads.cls;
        if (area < 150) floors = 3 + Math.floor(r11 * 3);
        else if (area < 600) floors = 4 + Math.floor(r11 * 5);
        else floors = cls <= SECONDARY ? 6 + Math.floor(r11 * 9) : 4 + Math.floor(r11 * 5);
        if (TALL_BONUS[kind]) floors += 2;
      }
      H = low ? (kind === 'cabin' ? 3 : 4) : floors * FLOOR_H;
    }
    H = Math.min(H, MAX_FLOORS * FLOOR_H);
    const storeys = H / FLOOR_H;

    const r5 = rand01(b.osm, 5);
    let wallHex: number;
    let glassy = false;
    if (ov?.wall !== undefined) {
      wallHex = ov.wall;
      glassy = ov.glass === true;
    } else if (KIND_WALL[kind] !== undefined) {
      wallHex = KIND_WALL[kind];
    } else if (storeys <= 5) {
      wallHex = WALLS[Math.floor(r5 * WALLS.length)];
    } else if (storeys <= 12) {
      wallHex = MIDRISE[Math.floor(r5 * MIDRISE.length)];
    } else {
      wallHex = GLASS_TOWERS[Math.floor(r5 * GLASS_TOWERS.length)];
      glassy = true;
    }
    wallCol.setHex(wallHex);
    roofCol.copy(wallCol).lerp(grey, 0.55);

    const pitched =
      !bare &&
      ov?.roof !== 'flat' &&
      outer.length >= 8 &&
      box.wid >= 4 &&
      (ov?.roof === 'pitched' ||
        (outer.length <= 12 && area / (box.len * box.wid) >= 0.85 && (sacred || (storeys <= 3.01 && area < 400 && rand01(b.osm, 13) < 0.45))));
    const parapet = bare || pitched ? 0 : PARAPET;

    // ---- walls and roof cap
    const shape = new THREE.Shape();
    for (let i = 0; i < n; i++) {
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
    const ext = new THREE.ExtrudeGeometry(shape, { depth: H + parapet, bevelEnabled: false });
    const ep = ext.getAttribute('position');
    const en = ext.getAttribute('normal');
    soup.lit = 0.3 + 0.8 * rand01(b.osm, 7);
    soup.style = glassy ? 1 : 0;
    soup.top = H - 0.4;
    for (let i = 0; i < ep.count; i += 3) {
      // Extrude space (x, y, depth) → world (x, depth, −y).
      const ny = en.getZ(i);
      if (ny < -0.5) continue;
      const isTop = ny > 0.5;
      if (isTop && pitched) continue;
      soup.f = isTop || bare ? 0 : FLOOR_H;
      soup.c.copy(isTop ? roofCol : wallCol);
      const y = (k: number) => (isTop ? H : ep.getZ(k));
      soup.tri(
        ep.getX(i), y(i), -ep.getY(i),
        ep.getX(i + 1), y(i + 1), -ep.getY(i + 1),
        ep.getX(i + 2), y(i + 2), -ep.getY(i + 2),
        en.getX(i), ny, -en.getY(i),
      );
    }
    ext.dispose();
    soup.f = 0;
    soup.top = 0;
    soup.style = 0;
    soup.lit = 0;

    // ---- roof: parapet rim, pitched tiles, or rooftop tanks
    if (pitched) {
      const ridge = Math.min(4, Math.max(1.4, box.wid * 0.3));
      const roof = gableGeometry(box.len + 0.8, ridge, box.wid + 0.8);
      const tile = ov?.tile ?? TILES[Math.floor(rand01(b.osm, 17) * TILES.length)];
      matrix.compose(tmpA.set(box.cx, H, box.cz), q.setFromAxisAngle(up, -box.theta), tmpB.set(1, 1, 1));
      soup.geo(roof, matrix, (ny) => (ny < -0.5 ? null : ny > 0.1 ? tile : wallHex));
      roof.dispose();
    } else if (parapet > 0) {
      col.copy(wallCol).lerp(white, 0.3);
      soup.c.copy(col);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = outer[i * 2];
        const az = outer[i * 2 + 1];
        const dx = outer[j * 2] - ax;
        const dz = outer[j * 2 + 1] - az;
        const len = Math.hypot(dx, dz);
        if (len < 0.8) continue;
        const ox = (sgn * dz) / len;
        const oz = (-sgn * dx) / len;
        const m = yawMatrix(ax + dx / 2 - ox * 0.125, H + parapet / 2, az + dz / 2 - oz * 0.125, Math.atan2(ox, oz));
        soup.box(m, len, parapet, 0.25, PY | NZ);
      }
    }
    if (!bare && !pitched && storeys <= 12) {
      const tanks = Math.max(1, Math.min(3, Math.round(area / 250)));
      const placed: number[] = [];
      const cu = Math.cos(box.theta);
      const su = Math.sin(box.theta);
      for (let k = 0; k < tanks; k++) {
        for (let attempt = 0; attempt < 10; attempt++) {
          const a = (rand01(b.osm, 30 + k * 16 + attempt) - 0.5) * box.len * 0.7;
          const c = (rand01(b.osm, 31 + k * 16 + attempt) - 0.5) * box.wid * 0.7;
          const x = box.cx + a * cu - c * su;
          const z = box.cz + a * su + c * cu;
          if (!inRing(outer, x, z) || holes.some((h) => inRing(h, x, z))) continue;
          if (edgeDistance(outer, x, z) < 1.4) continue;
          let clash = false;
          for (let t = 0; t < placed.length; t += 2) if (Math.hypot(placed[t] - x, placed[t + 1] - z) < 2.4) clash = true;
          if (clash) continue;
          placed.push(x, z);
          const tank = TANKS[Math.floor(rand01(b.osm, 60 + k) * TANKS.length)];
          matrix.makeTranslation(x, H + 0.75, z);
          soup.geo(tankGeo, matrix, (ny) => (ny < -0.5 ? null : tank));
          break;
        }
      }
    }

    // ---- shop fronts on street-facing edges
    if (SHOP_KINDS[kind] && H < 25) {
      for (let i = 0; i < n && units.length < MAX_UNITS; i++) {
        const j = (i + 1) % n;
        const ax = outer[i * 2];
        const az = outer[i * 2 + 1];
        const dx = outer[j * 2] - ax;
        const dz = outer[j * 2 + 1] - az;
        const len = Math.hypot(dx, dz);
        if (len < 3) continue;
        const ox = (sgn * dz) / len;
        const oz = (-sgn * dx) / len;
        const slots = Math.min(6, Math.max(1, Math.round(len / 4.6)));
        const w = len / slots;
        for (let k = 0; k < slots && units.length < MAX_UNITS; k++) {
          const t = ((k + 0.5) * w) / len;
          const x = ax + dx * t;
          const z = az + dz * t;
          if (!roads.nearest(x, z, 15)) continue;
          const gap = roads.dist - roads.halfW;
          if (gap < 0.6 || gap > SIDEWALK + 2.5) continue;
          const tx = (roads.px - x) / roads.dist;
          const tz = (roads.pz - z) / roads.dist;
          if (ox * tx + oz * tz <= 0.7) continue;
          if (rand01(b.osm, 90 + i * 8 + k) < 0.08) continue; // a hẻm (alley) between shops
          const yaw = Math.atan2(ox, oz);
          const sw = Math.max(2, Math.min(w * 0.84, 4.6));
          const light = rand01(b.osm, 120 + i * 8 + k) < 0.12 ? 0.08 : 0.45 + 0.65 * rand01(b.osm, 150 + i * 8 + k);
          // Open shop with warm interior light.
          soup.color(SHOP_DARK);
          soup.glow(SHOP_GLOW, 1.8 * light);
          soup.box(yawMatrix(x + ox * 0.02, 1.4, z + oz * 0.02, yaw), sw, 2.75, 0.25, ALL & ~NZ & ~NY);
          soup.noGlow();
          // Sloped awning, trimmed so it never hangs over the carriageway.
          const proj = Math.min(1.25, gap - 0.4);
          if (proj > 0.5) {
            soup.color(AWNINGS[Math.floor(rand01(b.osm, 180 + i * 8 + k) * AWNINGS.length)]);
            const sc = Math.cos(0.3);
            soup.box(yawMatrix(x + ox * (proj / 2), 2.86, z + oz * (proj / 2), yaw, 0.3), Math.min(w * 0.98, sw + 0.4), 0.08, proj / sc, ALL & ~NZ);
          }
          units.push({ x, z, yaw, w: sw, light, sign: rand01(b.osm, 210 + i * 8 + k) < 0.85 ? Math.floor(rand01(b.osm, 240 + i * 8 + k) * 8) : -1 });
          if (gap >= 1.8) {
            const off = Math.min(1.9, gap - 0.3);
            shopFronts.push({ x: x + ox * off, z: z + oz * off, fx: ox, fz: oz });
          }
        }
      }
    }
    if (b.kind === 'gob') {
      gobExtCount++;
      gobExtTris += soup.tris - trisBefore;
    }
    count++;
  }
  tankGeo.dispose();

  // ---- OSM walls + roofs + shop boxes: one merged mesh
  const wallMat = wallMaterial();
  const osmTris = soup.tris;
  const walls = new THREE.Mesh(soup.build(), wallMat);
  walls.name = 'walls';
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);

  // ---- props and infill share the 320k triangle budget (TRI_BUDGET)
  const bikeGeo = parkedScooterGeometry();
  const stoolGeo = stoolGroupGeometry();
  const maxBikes = Math.min(MAX_BIKES, Math.floor((PROP_BUDGET * 0.6) / triCount(bikeGeo)));
  const maxStools = Math.floor((PROP_BUDGET * 0.4) / triCount(stoolGeo));
  const fillBudget = Math.max(0, TRI_BUDGET - osmTris - PROP_BUDGET - 2 * (units.length + MAX_FILL_SIGNS));
  const t0 = performance.now();
  const lots = planFill(net, scene, zoning, roads, gob.lots);
  const fill = emitFill(lots, net, fillBudget);
  fill.soups.forEach((s, i) => {
    const mesh = new THREE.Mesh(s.build(), wallMat);
    mesh.name = `infill-${i}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  });
  units.push(...fill.signs);
  shopFronts.push(...fill.fronts);
  // Keep street trees and lamps off the new houses (stamped only after planning, so lot spacing is unaffected).
  for (const L of lots) {
    if (!L.drop) zoning.stamp(L.x, L.z, Math.cos(L.yaw), -Math.sin(L.yaw), L.w / 2, L.d / 2, 0);
  }
  group.userData = {
    buildings: count - gobExtCount,
    gobLots: gob.lots.length,
    gobExtruded: gobExtCount,
    shopUnits: units.length,
    triangles: osmTris + fill.tris,
    osmTriangles: osmTris,
    infillTriangles: fill.tris,
    infillTubeHouses: fill.tube,
    infillMidRises: fill.mid,
    infillMeshes: fill.soups.length,
  };
  if (import.meta.env.DEV) {
    console.info(
      `[buildings] osm ${count - gobExtCount} bldgs / ${osmTris - gobExtTris} tris; infill ${fill.tube} tube + ${fill.mid} mid-rise / ${fill.tris} tris in ${fill.soups.length} meshes (budget ${fillBudget}), ${Math.round(performance.now() - t0)} ms`,
    );
    console.info(
      `[buildings] gob ${gob.lots.length + gob.extruded.length} footprints (boxy lots ${gob.lots.length} in infill tiles, extruded ${gobExtCount} / ${gobExtTris} tris, hidden by override ${gob.hiddenByOverride}, hidden by ground ${gob.hiddenByGround})`,
    );
  }

  // ---- shop signs (one instanced mesh, rows of a text atlas)
  const signed = units.filter((u) => u.sign >= 0);
  const signGeo = new THREE.PlaneGeometry(3.4, 0.64);
  const signRow = new THREE.InstancedBufferAttribute(new Float32Array(signed.length), 1);
  const signLit = new THREE.InstancedBufferAttribute(new Float32Array(signed.length), 1);
  signGeo.setAttribute('signRow', signRow);
  signGeo.setAttribute('instLight', signLit);
  const signMat = new THREE.MeshStandardMaterial({ map: signAtlas(), roughness: 0.6 });
  signMat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = shared.uNight;
    patchCutaway(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float signRow;\nattribute float instLight;\nvarying float vLit;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv.y = (vMapUv.y + signRow) / 8.0;\nvLit = instLight;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying float vLit;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uNight * 0.9 * vLit;');
  };
  const signs = new THREE.InstancedMesh(signGeo, signMat, signed.length);
  signs.name = 'signs';
  signed.forEach((u, k) => {
    q.setFromAxisAngle(up, u.yaw);
    const ox = Math.sin(u.yaw);
    const oz = Math.cos(u.yaw);
    matrix.compose(tmpA.set(u.x + ox * 0.1, 3.3, u.z + oz * 0.1), q, tmpB.set(Math.min(1.1, (u.w * 0.95) / 3.4), 1, 1));
    signs.setMatrixAt(k, matrix);
    signRow.setX(k, 7 - u.sign);
    signLit.setX(k, Math.max(0.5, u.light));
  });
  group.add(signs);

  // ---- parked scooters on the sidewalks and street-food corners
  const bikes: THREE.Matrix4[] = [];
  const bikeColors: number[] = [];
  const stools: { x: number; z: number; yaw: number; c: number }[] = [];
  // Thin props with one keep-probability so the budget never starves the late (infill) fronts.
  const bikeKeep = Math.min(1, maxBikes / Math.max(1, shopFronts.length * 0.75));
  const stoolKeep = Math.min(1, maxStools / Math.max(1, shopFronts.length * 0.12));
  for (const s of shopFronts) {
    const along = { x: -s.fz, z: s.fx };
    const roll = rng.next();
    const keep = rng.next();
    if (roll < 0.5) {
      if (keep >= bikeKeep) continue;
      const nb = 1 + rng.int(2);
      for (let i = 0; i < nb && bikes.length < maxBikes; i++) {
        const o = (i - (nb - 1) / 2) * 0.95 + rng.range(-0.15, 0.15);
        const yaw = Math.atan2(-s.fz, s.fx) + Math.PI + rng.range(-0.35, 0.35);
        q.setFromAxisAngle(up, yaw);
        bikes.push(new THREE.Matrix4().compose(new THREE.Vector3(s.x + along.x * o, 0, s.z + along.z * o), q, new THREE.Vector3(1, 1, 1)));
        bikeColors.push(rng.pick([0xc0392b, 0xf2efe6, 0x26282c, 0x2f5fa8, 0xb7bcc2, 0xe0b23a, 0x2f8c84]));
      }
    } else if (roll < 0.62 && keep < stoolKeep && stools.length < maxStools) {
      stools.push({ x: s.x, z: s.z, yaw: Math.atan2(-s.fz, s.fx) + Math.PI / 2, c: rng.pick(STOOLS) });
    }
  }
  const propTris = bikes.length * triCount(bikeGeo) + stools.length * triCount(stoolGeo);
  const signTris = 2 * units.filter((u) => u.sign >= 0).length;
  group.userData.bikes = bikes.length;
  group.userData.stools = stools.length;
  group.userData.triangles = osmTris + fill.tris + signTris + propTris;
  if (import.meta.env.DEV) {
    console.info(`[buildings] total ${osmTris + fill.tris + signTris + propTris} tris (osm ${osmTris}, infill ${fill.tris}, signs ${signTris}, ${bikes.length} bikes + ${stools.length} stools ${propTris})`);
  }
  const bikeC2 = new THREE.InstancedBufferAttribute(new Float32Array(bikes.length * 3), 3);
  bikeGeo.setAttribute('aColor2', bikeC2);
  const bikeMesh = new THREE.InstancedMesh(bikeGeo, makeMaterial({ color2: true }, { roughness: 0.55 }), bikes.length);
  bikeMesh.name = 'bikes';
  bikeMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(bikes.length * 3).fill(1), 3);
  bikes.forEach((mx, k) => {
    bikeMesh.setMatrixAt(k, mx);
    col.setHex(bikeColors[k]);
    bikeC2.setXYZ(k, col.r, col.g, col.b);
  });
  bikeMesh.castShadow = true;
  group.add(bikeMesh);

  const stoolMesh = new THREE.InstancedMesh(stoolGeo, makeMaterial(), stools.length);
  stoolMesh.name = 'stools';
  stools.forEach((s, k) => {
    q.setFromAxisAngle(up, s.yaw);
    stoolMesh.setMatrixAt(k, matrix.compose(tmpA.set(s.x, 0, s.z), q, tmpB.set(1, 1, 1)));
    stoolMesh.setColorAt(k, col.setHex(s.c));
  });
  stoolMesh.castShadow = true;
  group.add(stoolMesh);

  return { group, shopFronts };
}
