import * as THREE from 'three';
import { rand01 } from '../core/rng';
import type { SceneJson } from '../data/q1Schema';
import { PLAZA_TINT, resolveGround } from '../data/sceneOverrides';
import type { Network } from '../sim/network';
import { FlatBuilder } from './ground';
import { shared } from './materials';
import { grassTexture, pavingTexture } from './textures';

export interface TerrainResult {
  group: THREE.Group;
  /** Water shader; `uTime`/`uNight`/`uWet` are shared uniforms, nothing to drive per frame. */
  water: THREE.ShaderMaterial;
}

const GREEN = 0x9cbf72;
const DEEP_GREEN = 0x86b062;
const BANK = 0x6f6a58;
/** Sandstone paving of squares and pedestrian areas, a shade darker than the street paving. */
const PLAZA_STONE = 0xe3d3b0;
/** Height (m) of the diorama slab under the paving. */
const SLAB_DEPTH = 9;
const SLAB_SIDE = 0xa8784c;
const SLAB_SOIL = 0x7a5236;
/** Inward width (m) of the dark bank drawn along water edges. */
const BANK_W = 1.5;

/** Ear-clipped triangles of a flat ring with holes: vertex list `[x, z, …]` plus triangle indices into it. */
export function triangulate(pts: number[], holes: number[][]): { verts: number[]; idx: number[] } {
  const toV = (flat: number[]) => {
    const v: THREE.Vector2[] = [];
    for (let i = 0; i < flat.length; i += 2) v.push(new THREE.Vector2(flat[i], flat[i + 1]));
    return v;
  };
  const contour = toV(pts);
  const holeV = holes.map(toV);
  // triangulateShape drops duplicated end points in place, so read the vertices back afterwards.
  const faces = THREE.ShapeUtils.triangulateShape(contour, holeV);
  const verts: number[] = [];
  for (const v of [...contour, ...holeV.flat()]) verts.push(v.x, v.y);
  return { verts, idx: faces.flat() };
}

/** Signed area (shoelace) of a flat ring; positive ⇒ interior lies on the right of travel in x-east/z-south coordinates. */
function signedArea(r: number[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1];
  return a / 2;
}

function waterMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
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
        vec2 p = vec2(vW.x * 0.06, vW.y * 0.06 - uTime * 0.12);
        float n = noise(p * 3.0) * 0.6 + noise(p * 7.0 + 3.1) * 0.4;
        float ripple = smoothstep(0.7, 0.8, noise(vec2(vW.x * 0.9, vW.y * 0.9 - uTime * 0.9)));
        vec3 shallow = vec3(0.30, 0.58, 0.56);
        vec3 deep = vec3(0.14, 0.38, 0.42);
        vec3 col = mix(shallow, deep, 0.5 * 0.85 + n * 0.15);
        col = mix(col, uSky * 0.8, 0.1 + 0.08 * n);
        col += ripple * 0.06 * (1.0 - uNight);
        // Night: dark water with faint warm reflections of the embankment lights.
        vec3 nightCol = vec3(0.04, 0.09, 0.12) + vec3(0.9, 0.62, 0.3) * ripple * 0.16 * 0.6;
        col = mix(col, nightCol, uNight * 0.85);
        // Rain dimples.
        float drops = smoothstep(0.92, 1.0, noise(vW * 1.7 + floor(uTime * 6.0) * 13.1));
        col += drops * uWet * 0.12;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/** Four vertical walls of the map-sized slab with a darker soil stratum, vertex-coloured. */
function slabWalls(minX: number, maxX: number, minZ: number, maxZ: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const nrm: number[] = [];
  const c = new THREE.Color();
  const bands: [number, number, number][] = [
    [-0.02, -SLAB_DEPTH + 1.8, SLAB_SIDE],
    [-SLAB_DEPTH + 1.8, -SLAB_DEPTH + 0.6, SLAB_SOIL],
    [-SLAB_DEPTH + 0.6, -SLAB_DEPTH, SLAB_SIDE],
  ];
  const wall = (ax: number, az: number, bx: number, bz: number, nx: number, nz: number) => {
    for (const [yTop, yBot, color] of bands) {
      c.setHex(color);
      // Vertices a-top, a-bottom, b-bottom, b-top; flip if the winding would face inwards.
      const quad = [ax, yTop, az, ax, yBot, az, bx, yBot, bz, bx, yTop, bz];
      const e1x = bx - ax;
      const e1z = bz - az;
      const facesOut = -e1z * nx + e1x * nz > 0 === (yTop > yBot);
      const order = facesOut ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
      for (const k of order) {
        pos.push(quad[k * 3], quad[k * 3 + 1], quad[k * 3 + 2]);
        col.push(c.r, c.g, c.b);
        nrm.push(nx, 0, nz);
      }
    }
  };
  wall(minX, maxZ, maxX, maxZ, 0, 1);
  wall(maxX, minZ, minX, minZ, 0, -1);
  wall(maxX, maxZ, maxX, minZ, 1, 0);
  wall(minX, minZ, minX, maxZ, -1, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

/** Slab, paving, water and parks of the OSM extract. */
export function buildTerrain(net: Network, scene: SceneJson): TerrainResult {
  const group = new THREE.Group();
  group.name = 'terrain';
  const { minX, maxX, minZ, maxZ } = net.bounds;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;

  // ---- diorama slab (sides only: the paving plane hides its top)
  const slab = new THREE.Mesh(slabWalls(minX, maxX, minZ, maxZ), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  slab.receiveShadow = true;
  group.add(slab);

  // ---- paving
  const paving = pavingTexture();
  paving.repeat.set(1, 1);
  const ground = new THREE.PlaneGeometry(maxX - minX, maxZ - minZ).rotateX(-Math.PI / 2);
  const uv = ground.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * (maxX - minX)) / 12, (uv.getY(i) * (maxZ - minZ)) / 12);
  const plane = new THREE.Mesh(ground, new THREE.MeshStandardMaterial({ color: 0xf1e6cb, map: paving, roughness: 0.92 }));
  plane.position.set(cx, 0, cz);
  plane.receiveShadow = true;
  group.add(plane);

  // ---- water: one flat mesh over the paving, no excavation (see P3 option W1)
  const water = waterMaterial();
  const sheet = new FlatBuilder();
  const bank = new FlatBuilder();
  const eps = 0.05;
  const onBounds = (ax: number, az: number, bx: number, bz: number) =>
    (Math.abs(ax - minX) < eps && Math.abs(bx - minX) < eps) ||
    (Math.abs(ax - maxX) < eps && Math.abs(bx - maxX) < eps) ||
    (Math.abs(az - minZ) < eps && Math.abs(bz - minZ) < eps) ||
    (Math.abs(az - maxZ) < eps && Math.abs(bz - maxZ) < eps);
  for (const w of scene.water) {
    const { verts, idx } = triangulate(w.pts, w.holes);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 2;
      const b = idx[i + 1] * 2;
      const c = idx[i + 2] * 2;
      sheet.tri(verts[a], verts[a + 1], verts[b], verts[b + 1], verts[c], verts[c + 1], 0.02, 0xffffff);
    }
    // Dark bank along the shore, inside the polygon; skip the map border and tiny ponds.
    const rings: [number[], number][] = [[w.pts, signedArea(w.pts) > 0 ? 1 : -1]];
    for (const h of w.holes) rings.push([h, signedArea(h) > 0 ? -1 : 1]);
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < w.pts.length; i += 2) {
      x0 = Math.min(x0, w.pts[i]);
      x1 = Math.max(x1, w.pts[i]);
      z0 = Math.min(z0, w.pts[i + 1]);
      z1 = Math.max(z1, w.pts[i + 1]);
    }
    if (Math.min(x1 - x0, z1 - z0) < 4 * BANK_W) continue;
    for (const [r, inward] of rings) {
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        if (onBounds(r[j], r[j + 1], r[i], r[i + 1])) continue;
        const o = inward > 0 ? [0, BANK_W] : [-BANK_W, 0];
        bank.band(r[j], r[j + 1], r[i], r[i + 1], o[0], o[1], 0.026, BANK);
      }
    }
  }
  const sheetMesh = new THREE.Mesh(sheet.build(), water);
  sheetMesh.name = 'water';
  group.add(sheetMesh);
  const bankMesh = new THREE.Mesh(bank.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  bankMesh.receiveShadow = true;
  group.add(bankMesh);

  // ---- parks: below sidewalks (0.012) and asphalt (0.03) so a polygon that spills over a road never covers it
  const parks = new FlatBuilder(1 / 10);
  for (const p of scene.parks) {
    const { verts, idx } = triangulate(p.pts, []);
    const color = rand01(p.osm, 3) < 0.5 ? GREEN : DEEP_GREEN;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 2;
      const b = idx[i + 1] * 2;
      const c = idx[i + 2] * 2;
      parks.tri(verts[a], verts[a + 1], verts[b], verts[b + 1], verts[c], verts[c + 1], 0.006, color);
    }
  }
  const parkMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: grassTexture(), roughness: 0.95 });
  // Lawns darken and cool at night like the paving and asphalt around them; otherwise the moon-lit green stays the most saturated surface.
  parkMat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = shared.uNight;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float lawnLum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lawnLum) * vec3(0.8, 0.95, 1.1), uNight * 0.45) * (1.0 - 0.38 * uNight);`,
      );
  };
  parkMat.customProgramCacheKey = () => 'lawn-night';
  const parkMesh = new THREE.Mesh(parks.build(), parkMat);
  parkMesh.receiveShadow = true;
  group.add(parkMesh);

  // ---- plazas (place=square, pedestrian areas, Nguyễn Huệ promenade, finished sites): paving just above the street paving, under every sidewalk and road
  const plazas = new FlatBuilder(1 / 12);
  for (const p of resolveGround(scene).plazas) {
    const tint = PLAZA_TINT[p.osm] ?? PLAZA_STONE;
    const { verts, idx } = triangulate(p.pts, p.holes);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 2;
      const b = idx[i + 1] * 2;
      const c = idx[i + 2] * 2;
      plazas.tri(verts[a], verts[a + 1], verts[b], verts[b + 1], verts[c], verts[c + 1], 0.004, tint);
    }
  }
  const plazaMesh = new THREE.Mesh(plazas.build(), new THREE.MeshStandardMaterial({ vertexColors: true, map: paving, roughness: 0.9 }));
  plazaMesh.name = 'plazas';
  plazaMesh.receiveShadow = true;
  group.add(plazaMesh);

  return { group, water };
}
