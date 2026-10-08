import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { LandmarkKey, SceneJson } from '../data/q1Schema';
import type { Network } from '../sim/network';
import { GeoBuilder, gableGeometry, type PartOptions } from './geo';
import { makeMaterial } from './materials';

const CREAM = 0xf2e2b5;
const WIN = 0x2f3a3e;
const WARM = { emis: 0xffcf8a, emisStrength: 1.1 };
const cyl = (rt: number, rb: number, h: number, seg = 12) => new THREE.CylinderGeometry(rt, rb, h, seg);

/** Extra yaw (rad) per landmark, tuned by eye after the facing rule is applied. */
const FIX: Record<LandmarkKey, number> = { benThanh: 0, ubnd: 0, bitexco: 0, cafeApt: 0, notreDame: 0, postOffice: 0, opera: 0, palace: 0 };

/**
 * Landmarks whose façade faces a named place instead of "the end nearer a road": the centroid of every junction whose
 * name contains the text (within `FACE_REACH` m of the landmark). Chợ Bến Thành's clock-tower gate (Cửa Nam) opens on
 * Công trường Quách Thị Trang, not on Lê Thánh Tôn behind it.
 */
const FACE_JUNCTION: Partial<Record<LandmarkKey, string>> = { benThanh: 'Quách Thị Trang' };
const FACE_REACH = 300;

/**
 * Explicit façade targets in world metres, preferred over the nearest-road rule where it would pick the wrong end.
 * Cathedral: the Our Lady lawn (OSM park 801950764) ahead of its twin towers. Post office: the same square (its clock gable
 * faces the cathedral side). Opera: the OSM `entrance=main` node 7499846144 (https://www.openstreetmap.org/node/7499846144) at the
 * Lam Sơn Square / Lê Lợi end of the narrow footprint, 33 m SW of its centroid; vi.wikipedia "mặt tiền hướng ra Công trường Lam Sơn và
 * đường Đồng Khởi" (https://vi.wikipedia.org/wiki/Nh%C3%A0_h%C3%A1t_Th%C3%A0nh_ph%E1%BB%91). Palace: the Nam Kỳ Khởi Nghĩa /
 * Lê Duẩn corner beyond the front lawn.
 */
const FACE_POINT: Partial<Record<LandmarkKey, { x: number; z: number }>> = {
  notreDame: { x: -150, z: -525 },
  postOffice: { x: -150, z: -525 },
  opera: { x: 220, z: -220 },
  palace: { x: -500, z: -395 },
};

/** Horizontal fit clamp and the vertical stretch ceiling applied to a hand model placed on its OSM footprint. */
const FIT_MIN = 0.8;
const FIT_MAX = 3;
const PODIUM_H = 4;

/** Thin cylinder from p0 to p1 (cables, rails). */
function beam(b: GeoBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, color: number, opts = {}): void {
  const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  const g = new THREE.CylinderGeometry(r, r, len, 5);
  const dir = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const m = new THREE.Matrix4().compose(new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), q, new THREE.Vector3(1, 1, 1));
  b.add(g, m, color, opts);
  g.dispose();
}

function textPlane(text: string, w: number, h: number, bg: string, fg: string, font = 800): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = Math.round((512 * h) / w);
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${font} ${Math.round(c.height * 0.62)}px "Be Vietnam Pro", sans-serif`;
  g.fillText(text, c.width / 2, c.height * 0.54, c.width * 0.94);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: t, roughness: 0.7, emissiveMap: t, emissive: 0x000000 }));
}

const ARCH_DARK = 0x4a3a2a;
const ARCH_GLOW = { emis: 0xffc070, emisStrength: 1.4 };
/** Door/window opening: a box topped by a half-round cap; `face` is the axis of the wall normal it is cut into. */
function arch(b: GeoBuilder, x: number, y0: number, z: number, w: number, h: number, t: number, face: 'x' | 'z', color: number, opts: PartOptions): void {
  if (face === 'z') {
    b.box(w, h, t, x, y0 + h / 2, z, color, opts);
    b.place(cyl(w / 2, w / 2, t, 10), x, y0 + h, z, color, opts, [Math.PI / 2, 0, 0]);
  } else {
    b.box(t, h, w, x, y0 + h / 2, z, color, opts);
    b.place(cyl(w / 2, w / 2, t, 10), x, y0 + h, z, color, opts, [0, 0, Math.PI / 2]);
  }
}

// ------------------------------------------------------------------ models
// Every model lives in a local frame: origin at the footprint centre, façade towards +z, x to its right.

/**
 * Chợ Bến Thành. Bounding box 30 (x) × 54 (z). The clock-tower gate (Cửa Nam) faces +z, with the "CHỢ BẾN THÀNH" sign on the
 * tower's front face above the main arch; the other three gates (north, east, west) are low portals.
 *
 * Roofs are corrugated metal sheet (mái tôn), brown-grey: the 2023 renovation plan is to "thay tôn bằng ngói đỏ", i.e. the red tile is
 * only proposed (https://dantri.com.vn/thoi-su/phuc-dung-nguyen-ban-tuong-tran-nguyen-han-dat-lai-truoc-cho-ben-thanh-20221220173643754.htm).
 *
 * The clock tower is drawn in real metres — 9 m square, 28 m to the mast tip (the commonly quoted height; no authoritative source found,
 * one old blog claims 50 m) — divided by the footprint fit scale (sx, sz, sy), because the model is stretched onto the 137 × 99 m OSM
 * footprint and a 6 m tower used to come out 18 m wide and ~39 m tall.
 */
const BEN_THANH = { w: 30, d: 54, long: 'z' as const, sign: { y: 7.5, z: 26.9, w: 5.6, h: 1.1 } };
/** Corrugated roof sheet of the market halls and the tower cap. */
const METAL = 0x908c86;
const METAL_DK = 0x77736d;
function benThanhMarket(b: GeoBuilder, sx: number, sz: number, sy: number): void {
  const cx = 0;
  const cz = -1.2;
  b.box(30, 6, 52, cx, 3, cz, 0xf0d9a0);
  // Pitched hall roofs along the long axis, with lower side aisles.
  b.place(gableGeometry(50, 4.5, 20), cx, 6, cz, METAL, {}, [0, Math.PI / 2, 0]);
  b.box(6, 0.6, 50, cx - 12, 6.3, cz, METAL_DK);
  b.box(6, 0.6, 50, cx + 12, 6.3, cz, METAL_DK);
  // Clerestory windows glow at night.
  for (let z = cz - 22; z <= cz + 22; z += 4) {
    b.box(0.2, 1.6, 2.4, cx - 15.05, 3.4, z, WIN, WARM);
    b.box(0.2, 1.6, 2.4, cx + 15.05, 3.4, z, WIN, WARM);
  }
  // Cửa Nam: cream facade, cornice, pilasters and three round-headed openings, the tallest under the clock tower. The gate block is
  // ~60 % of the old width so that, stretched onto the footprint, it spans ~40 m with the 9 m tower over the main arch.
  const GLOW = { emis: 0xffc070, emisStrength: 1.4 };
  const DOOR = 0x4a3a2a;
  const SURROUND = 0xfbf0d0;
  const fz = cz + 26;
  const g = 0.6;
  b.box(22 * g, 9, 3, cx, 4.5, fz + 0.5, CREAM);
  b.box(23 * g, 0.6, 3.6, cx, 9.2, fz + 0.5, 0xe5cf98);
  for (const [x, w, h] of [[-8, 3.8, 5], [0, 5, 6], [8, 3.8, 5]]) {
    const gx = x * g;
    const gw = w * g;
    b.box(gw + 0.5, h, 0.3, cx + gx, h / 2, fz + 2.25, SURROUND);
    b.place(cyl(gw / 2 + 0.25, gw / 2 + 0.25, 0.3, 14), cx + gx, h, fz + 2.25, SURROUND, {}, [Math.PI / 2, 0, 0]);
    b.box(gw, h, 0.4, cx + gx, h / 2, fz + 2.4, DOOR, GLOW);
    b.place(cyl(gw / 2, gw / 2, 0.4, 14), cx + gx, h, fz + 2.4, DOOR, GLOW, [Math.PI / 2, 0, 0]);
  }
  for (const x of [-10.5, -4.3, 4.3, 10.5]) b.box(0.7, 9, 0.6, cx + x * g, 4.5, fz + 2.15, SURROUND);
  // Clock tower, its front face flush with the facade so the main gate opens at its foot. Real metres ÷ fit scale.
  const kx = 1 / sx;
  const ky = 1 / sy;
  const kz = 1 / sz;
  const tw = 9;
  const tz = fz + 2.0 - (tw / 2) * kz;
  b.box(tw * kx, 21 * ky, tw * kz, cx, 10.5 * ky, tz, CREAM);
  b.box((tw + 0.8) * kx, 0.8 * ky, (tw + 0.8) * kz, cx, 21.4 * ky, tz, 0xe5cf98);
  const cap = new THREE.ConeGeometry((tw / 2) * Math.SQRT2, 4.8, 4);
  cap.rotateY(Math.PI / 4);
  cap.scale(kx, ky, kz);
  b.place(cap, cx, 24.2 * ky, tz, METAL);
  const mast = cyl(0.12, 0.12, 1.5, 6);
  mast.scale(kx, ky, kz);
  b.place(mast, cx, 27.3 * ky, tz, 0x5a4a3a);
  b.box(1.2 * kx, 0.7 * ky, 0.05 * kz, cx + 0.6 * kx, 27.6 * ky, tz, 0xd9412b);
  // Round clock face on the square side (kept circular in world space).
  const face = cyl(1.8, 1.8, 0.3, 24);
  face.rotateX(Math.PI / 2);
  face.scale(kx, ky, kz);
  const fy = 16.5 * ky;
  const fzFront = tz + (tw / 2) * kz;
  b.place(face, cx, fy, fzFront, 0xfbf6ea, { emis: 0xfff2d0, emisStrength: 0.9 });
  b.box(0.15 * kx, 1.3 * ky, 0.1 * kz, cx, fy + 0.6 * ky, fzFront + 0.2 * kz, 0x1d1a17);
  b.box(1.0 * kx, 0.15 * ky, 0.1 * kz, cx + 0.4 * kx, fy, fzFront + 0.2 * kz, 0x1d1a17);
  // The other gates: north end (Lê Thánh Tôn) and the two long sides (Phan Chu Trinh, Phan Bội Châu).
  const nz = cz - 26;
  b.box(14, 8, 2.4, cx, 4, nz - 0.2, CREAM);
  b.box(14.8, 0.5, 3, cx, 8.2, nz - 0.2, 0xe5cf98);
  b.box(4.2, 5.2, 0.4, cx, 2.6, nz - 1.6, DOOR, GLOW);
  b.place(cyl(2.1, 2.1, 0.4, 14), cx, 5.2, nz - 1.6, DOOR, GLOW, [Math.PI / 2, 0, 0]);
  for (const s of [-1, 1]) {
    const sx = cx + s * 15.4;
    b.box(2.4, 6.6, 11, sx, 3.3, cz, CREAM);
    b.box(3, 0.5, 11.8, sx, 6.8, cz, 0xe5cf98);
    b.box(0.4, 4.4, 3.4, sx + s * 1.3, 2.2, cz, DOOR, GLOW);
    b.place(cyl(1.7, 1.7, 0.4, 14), sx + s * 1.3, 4.4, cz, DOOR, GLOW, [0, 0, Math.PI / 2]);
  }
}

/** Trụ sở UBND Thành phố. Bounding box 51 (x) × 24 (z); the colonnade and garden face +z. */
const PEOPLES_COMMITTEE = { w: 51, d: 24, long: 'x' as const };
function peoplesCommittee(b: GeoBuilder): void {
  const cx = 0;
  const cz = -3;
  const Y = 0xf2c75c;
  const WHITE = 0xfbf6ea;
  const ROOF = 0x5d6b70;
  b.box(48, 10, 18, cx, 5, cz, Y);
  b.box(49, 0.8, 19, cx, 10.4, cz, WHITE);
  b.box(46, 3, 16, cx, 12.2, cz, ROOF);
  for (const x of [-21, 21]) {
    b.box(9, 13, 19, cx + x, 6.5, cz + 0.5, Y);
    b.place(new THREE.ConeGeometry(6.6, 5, 4), cx + x, 15.5, cz + 0.5, ROOF, {}, [0, Math.PI / 4, 0], [1, 1, 1.4]);
  }
  // Central clock tower.
  b.box(8, 18, 8, cx, 9, cz + 2, Y);
  b.box(8.6, 0.7, 8.6, cx, 18.2, cz + 2, WHITE);
  b.box(6, 4, 6, cx, 20.5, cz + 2, Y);
  b.place(new THREE.SphereGeometry(3.4, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), cx, 22.5, cz + 2, ROOF);
  b.place(cyl(0.12, 0.12, 4), cx, 27.5, cz + 2, 0x3a3a3a);
  b.box(2, 1.2, 0.05, cx + 1, 28.6, cz + 2, 0xd9412b);
  b.place(cyl(1.5, 1.5, 0.2, 18), cx, 14.5, cz + 6.1, 0xfbf6ea, { emis: 0xfff2d0, emisStrength: 0.9 }, [Math.PI / 2, 0, 0]);
  // Colonnade and tall windows along the front.
  for (let x = -22; x <= 22; x += 2.75) {
    b.box(0.8, 8.5, 0.8, cx + x, 4.6, cz + 9.4, WHITE);
    if (Math.abs(x) > 1) b.box(1.5, 3.4, 0.2, cx + x + 1.37, 5.2, cz + 9.05, WIN, WARM);
  }
  // Formal front garden.
  b.box(40, 0.3, 4, cx, 0.15, cz + 13, 0x86b062);
  for (let x = -16; x <= 16; x += 8) b.place(new THREE.IcosahedronGeometry(1.2, 0), cx + x, 1.2, cz + 13, 0x3f7d3a);
}

/** "Chung cư 42 Nguyễn Huệ": a tired 1960s block reborn as stacked cafés. Bounding box 22 (x) × 16 (z); balconies face +z. */
const CAFE_APT = { w: 22, d: 16, long: 'x' as const };
function cafeApartment(b: GeoBuilder): void {
  const W = 22;
  const D = 14.5;
  const floors = 9;
  const H = floors * 3.2;
  b.box(W, H, D, 0, H / 2, 0, 0xe3dccb);
  // Window bands on the long sides.
  for (let f = 0; f < floors; f++) {
    b.box(W + 0.12, 1.2, D - 0.3, 0, f * 3.2 + 1.7, -0.15, WIN, { emis: 0xffd9a0, emisStrength: 0.6 });
  }
  const cafes = [0xd9412b, 0xe9a23b, 0x2f8c84, 0xf2d68a, 0x3f8f5a, 0xd96c3a, 0x2c5f9e, 0xc8463a];
  const front = D / 2;
  for (let f = 1; f < floors; f++) {
    const y = f * 3.2;
    b.box(W, 0.18, 1.4, 0, y, front + 0.7, 0xcfc6b2);
    b.box(W, 1, 0.08, 0, y + 0.55, front + 1.38, 0x2a2a2a);
    for (let k = 0; k < 4; k++) {
      const xc = 8.25 - 5.5 * k;
      const c = cafes[(f * 3 + k) % cafes.length];
      b.box(4.6, 2.4, 0.15, xc, y + 1.4, front + 0.05, c, { emis: 0xffcf8a, emisStrength: 1.3 });
      b.box(4.8, 0.12, 0.6, xc, y + 2.75, front + 0.6, c);
    }
  }
  b.box(W - 2, 2.8, 0.2, 0, 1.5, front + 0.1, 0x3a2e24, { emis: 0xffc070, emisStrength: 1.6 });
  b.box(W, 1, D, 0, H + 0.5, 0, 0xd5ccb6);
}

/**
 * Bitexco Financial Tower (OSM 804073951). Wikipedia: 262.5 m to the spire tip, 68 floors, the helipad cantilevered off the
 * 52nd floor (~191 m). `absoluteHeight`: every y below is a real metre (no vertical stretch), the plan is scaled to the
 * footprint. Podium 14 m, lotus-bud tower from 14 m to the 250 m crown, mast to 262.5 m.
 */
const BITEXCO = { w: 30, d: 30, long: 'x' as const, uniform: true, absoluteHeight: true };
function bitexco(b: GeoBuilder): void {
  const BASE = 14;
  const H = 232;
  b.box(30, BASE, 30, 0, BASE / 2, 0, 0xe0d6c4);
  b.box(30.4, 0.8, 30.4, 0, BASE + 0.2, 0, 0xcfc6b2);
  for (let i = 0; i < 6; i++) b.box(4, 5.5, 0.2, -10 + i * 4, 4.2, 15.05, WIN, { emis: 0xffd9a0, emisStrength: 1.2 });
  // Lotus-bud tower: tapering lens plan (radius `rad(t)`, squashed to 0.68 in z) with a sloped crown.
  const rad = (t: number) => 8.2 - 3.4 * t * t + 0.9 * Math.sin(t * Math.PI);
  const SQUASH: [number, number, number] = [1, 1, 0.68];
  const levels = 24;
  for (let i = 0; i < levels; i++) {
    const t0 = i / levels;
    const t1 = (i + 1) / levels;
    b.place(cyl(rad(t1), rad(t0), H / levels, 16), 0, BASE + (t0 + t1) * 0.5 * H, 0, 0xb9c4c2, {}, [0, 0, 0], SQUASH);
  }
  // Glazing arcs every 4 m, each covering a hashed 45-85 % of the circumference; about half of them lit at night (dimmer than
  // the punched windows of the OSM towers, which are small cells: full-ring bands would bloom into one solid column of light).
  const bands = Math.round(H / 4);
  const hash = (i: number, salt: number) => ((Math.imul(i + 1, 2654435761) ^ Math.imul(salt, 40503)) >>> 0) % 1000 / 1000;
  for (let i = 0; i < bands; i++) {
    const t0 = (i * 4 + 0.9) / H;
    const t1 = (i * 4 + 3.1) / H;
    const lit = hash(i, 3) < 0.55;
    const arc = (0.45 + 0.4 * hash(i, 2)) * Math.PI * 2;
    const glass = new THREE.CylinderGeometry(rad(t1) + 0.07, rad(t0) + 0.07, 2.2, 16, 1, true, hash(i, 1) * Math.PI * 2, arc);
    b.place(glass, 0, BASE + (i * 4 + 2), 0, 0x56707a, lit ? { emis: 0xffc880, emisStrength: 0.75 } : {}, [0, 0, 0], SQUASH);
    glass.dispose();
  }
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
    beam(b, Math.cos(ang) * 8.3, BASE, Math.sin(ang) * 8.3 * 0.68, Math.cos(ang) * 4.9, BASE + H, Math.sin(ang) * 4.9 * 0.68, 0.12, 0xe8ecea);
  }
  b.place(cyl(4.4, 4.4, 4, 16), 0, BASE + H + 2, 0, 0xc9d3d1, {}, [0.35, 0, 0], SQUASH);
  b.place(cyl(0.18, 0.18, 12.5, 5), 0, BASE + H + 10.25, 0, 0xe8ecea, { emis: 0xff4030, emisStrength: 2 });
  // The helipad cantilevered off the 52nd floor (slab top at 191 m), carried on a truss strut.
  const hy = 190.3;
  b.place(cyl(5.2, 4.6, 2.4, 20), 8.8, hy - 0.2, 0, 0xd9d6cc);
  b.place(cyl(4.1, 4.1, 0.1, 20), 8.8, hy + 1.05, 0, 0x5a6064);
  b.box(0.5, 0.06, 2.8, 7.9, hy + 1.13, 0, 0xf2c230);
  b.box(0.5, 0.06, 2.8, 9.7, hy + 1.13, 0, 0xf2c230);
  b.box(2.4, 0.06, 0.5, 8.8, hy + 1.13, 0, 0xf2c230);
  b.place(new THREE.TorusGeometry(5.2, 0.14, 4, 28), 8.8, hy + 1.1, 0, 0xf2c230, { emis: 0xffb84a, emisStrength: 1.4 }, [Math.PI / 2, 0, 0]);
  beam(b, 3.4, hy - 16, 0, 7.4, hy - 1.4, 0, 0.45, 0xcfc9bb);
}

/**
 * Nhà thờ Đức Bà (OSM 801950766). Footprint 35 (x) × 89.4 (z): brick nave ~21 m to the ridge, transept, apse, and the twin towers
 * with grey-blue iron spires (~58 m) on the +z façade. The Our Lady statue stands on the lawn 91 m ahead (OSM park 801950764).
 */
const NOTRE_DAME = { w: 35, d: 89.4, long: 'z' as const };
function notreDame(b: GeoBuilder): void {
  const BRICK = 0xb4532f;
  const BRICK_D = 0x9a4326;
  const STONE = 0xe6d8bb;
  const ROOF = 0x8a3f2c;
  const IRON = 0x6f8392;
  const GLASS = { emis: 0xffa860, emisStrength: 0.9 };
  // Nave, transept and apse.
  b.box(28, 14.5, 76, 0, 7.25, 5.5, BRICK);
  b.place(gableGeometry(76.4, 7, 29.6), 0, 14.5, 5.5, ROOF, {}, [0, Math.PI / 2, 0]);
  b.box(28.8, 0.6, 76.6, 0, 14.4, 5.5, STONE);
  b.box(34.2, 14.5, 13.5, 0, 7.25, -4.5, BRICK);
  b.place(gableGeometry(34.6, 7, 14.2), 0, 14.5, -4.5, ROOF);
  b.place(cyl(12, 12, 14.5, 12), 0, 7.25, -32.5, BRICK);
  b.place(new THREE.ConeGeometry(12.6, 6.5, 12), 0, 17.75, -32.5, ROOF);
  // Pointed windows down both flanks, with buttress piers between them.
  for (let z = -27; z <= 33; z += 5.2) {
    for (const s of [-1, 1]) {
      arch(b, s * 14.05, 3.2, z, 1.8, 6.4, 0.3, 'x', WIN, WARM);
      b.box(0.9, 14.5, 0.9, s * 14.25, 7.25, z + 2.6, BRICK_D);
    }
  }
  // Transept rose windows.
  for (const s of [-1, 1]) {
    b.place(cyl(2.2, 2.2, 0.3, 14), s * 17.2, 10.5, -4.5, 0x4d79a8, GLASS, [0, 0, Math.PI / 2]);
    b.place(cyl(2.6, 2.6, 0.2, 14), s * 17.12, 10.5, -4.5, STONE, {}, [0, 0, Math.PI / 2]);
  }
  // Façade: twin towers with belfry louvres, iron spires and crosses.
  for (const s of [-1, 1]) {
    const x = s * 8.4;
    b.box(11, 40, 11, x, 20, 38.9, BRICK);
    for (const y of [13, 27]) b.box(11.6, 0.6, 11.6, x, y, 38.9, STONE);
    b.box(11.8, 1.2, 11.8, x, 40.6, 38.9, STONE);
    for (const dx of [-2.4, 2.4]) arch(b, x + dx, 4, 44.45, 2.2, 5, 0.3, 'z', ARCH_DARK, {});
    for (const dx of [-2.4, 2.4]) arch(b, x + dx, 30, 44.5, 2.2, 5.4, 0.3, 'z', ARCH_DARK, {});
    arch(b, x + s * 5.5, 30, 38.9, 2.4, 5.4, 0.3, 'x', ARCH_DARK, {});
    arch(b, x, 15.5, 44.5, 2, 4.5, 0.3, 'z', WIN, WARM);
    b.place(cyl(4.6, 5, 3, 8), x, 42.7, 38.9, IRON);
    b.place(new THREE.ConeGeometry(4.4, 12.5, 8), x, 50.45, 38.9, IRON);
    b.box(0.25, 1.8, 0.25, x, 57.6, 38.9, IRON);
    b.box(0.9, 0.25, 0.25, x, 57.8, 38.9, IRON);
  }
  // Central gable with the main portal and the rose window.
  b.box(5.8, 17, 10, 0, 8.5, 39.4, BRICK);
  b.place(gableGeometry(10, 4.8, 6.4), 0, 17, 39.4, ROOF, {}, [0, Math.PI / 2, 0]);
  arch(b, 0, 0, 44.5, 3.6, 6.5, 0.3, 'z', ARCH_DARK, ARCH_GLOW);
  b.place(cyl(2.7, 2.7, 0.2, 14), 0, 12.2, 44.42, STONE, {}, [Math.PI / 2, 0, 0]);
  b.place(cyl(2.3, 2.3, 0.3, 14), 0, 12.2, 44.5, 0x4d79a8, GLASS, [Math.PI / 2, 0, 0]);
  b.box(16, 0.6, 4, 0, 0.3, 46.4, STONE);
  // Our Lady of Peace on her lawn.
  const sx = 3;
  const sz = 91;
  b.place(cyl(5.2, 5.4, 0.3, 20), sx, 0.15, sz, 0xd8cfbd);
  b.place(cyl(4.6, 4.6, 0.2, 20), sx, 0.35, sz, 0x86b062);
  b.box(3.6, 1.2, 3.6, sx, 0.9, sz, 0xcfc7b6);
  b.box(2.4, 4.2, 2.4, sx, 3.6, sz, 0xe0d8c6);
  b.place(new THREE.ConeGeometry(0.95, 3.2, 8), sx, 7.3, sz, 0xf6f2ea);
  b.place(new THREE.SphereGeometry(0.5, 8, 6), sx, 9.2, sz, 0xf6f2ea);
  b.box(2.2, 0.22, 0.28, sx, 8.1, sz, 0xf6f2ea);
}

/**
 * Bưu điện Trung tâm Sài Gòn (OSM 39514793). Footprint 69.6 (x) × 58.4 (z): a 69 m two-storey front wing (façade on +z, cream
 * with arched green-shuttered windows and a central clock gable), the barrel-vaulted iron hall behind it and a rear block.
 */
const POST_OFFICE = { w: 69.6, d: 58.4, long: 'x' as const };
function postOffice(b: GeoBuilder): void {
  const C = 0xe6cf8c;
  const TRIM = 0xf6ecc8;
  const GREEN = 0x3d7a58;
  const VAULT = 0x7f9a8f;
  // Front wing.
  const fz = 20.4;
  b.box(70, 1.2, 16.4, 0, 0.6, fz, 0xd9c27e);
  b.box(69.4, 11.5, 15.8, 0, 5.75, fz, C);
  b.box(70, 0.7, 16.4, 0, 11.85, fz, TRIM);
  b.box(69.6, 1.3, 16, 0, 13, fz, C);
  for (const s of [-1, 1]) {
    for (let k = 0; k < 5; k++) {
      const x = s * (12.5 + 5 * k);
      arch(b, x, 1.2, 28.4, 3, 6.6, 0.3, 'z', TRIM, {});
      arch(b, x, 1.2, 28.52, 2.5, 6.2, 0.3, 'z', GREEN, WARM);
      b.box(1.6, 2.6, 0.2, x, 9.1, 28.4, GREEN, WARM);
    }
    for (let k = 0; k < 5; k++) b.box(0.8, 11.5, 0.5, s * (10 + 5 * k), 5.75, 28.5, TRIM);
  }
  // Central porch: round-headed entrance and the big clock under a pediment.
  b.box(17, 14.2, 1, 0, 7.1, 28.8, C);
  b.box(1.2, 14.2, 1.3, -8.1, 7.1, 28.8, TRIM);
  b.box(1.2, 14.2, 1.3, 8.1, 7.1, 28.8, TRIM);
  arch(b, 0, 0, 29.3, 6.4, 7.4, 0.3, 'z', TRIM, {});
  arch(b, 0, 0, 29.42, 5, 7, 0.3, 'z', ARCH_DARK, ARCH_GLOW);
  b.place(cyl(1.95, 1.95, 0.25, 20), 0, 12, 29.35, 0xfbf6ea, { emis: 0xfff2d0, emisStrength: 0.9 }, [Math.PI / 2, 0, 0]);
  b.box(0.15, 1.3, 0.1, 0, 12.5, 29.52, 0x1d1a17);
  b.box(1, 0.15, 0.1, 0.4, 12, 29.52, 0x1d1a17);
  b.place(gableGeometry(1.4, 3.6, 17.6), 0, 14.2, 28.8, TRIM, {}, [0, Math.PI / 2, 0]);
  // Great hall: cream walls and a flattened barrel vault with a glazed ridge.
  const hz = -2.65;
  b.box(37, 11, 30.3, 0, 5.5, hz, C);
  b.place(cyl(18.5, 18.5, 30.3, 20), 0, 11, hz, VAULT, {}, [Math.PI / 2, 0, 0], [1, 1, 0.3]);
  b.box(1.8, 0.35, 24, 0, 16.55, hz, 0xcfe6e0, { emis: 0xfff1d6, emisStrength: 0.8 });
  for (const s of [-1, 1]) for (let z = -14; z <= 10; z += 4.5) arch(b, s * 18.55, 2.5, z, 2.2, 5.5, 0.3, 'x', GREEN, WARM);
  // Rear block.
  b.box(43.6, 11.5, 11.4, 1.2, 5.75, -23.5, C);
  b.box(44.2, 0.6, 12, 1.2, 11.8, -23.5, TRIM);
  for (let x = -17; x <= 20; x += 5.3) b.box(1.4, 2.6, 0.2, x, 6, -29.3, GREEN, WARM);
}

/**
 * Nhà hát Thành phố (OSM 801710792). Footprint 32.4 (x) × 65 (z): the narrow end is the façade (+z, toward the Lê Lợi / Đồng Khởi
 * junction) with a projecting central arch block under a pediment and two statues, lower arcaded wings, then the 24 m auditorium
 * and stage house under a patina-green roof.
 */
const OPERA = { w: 32.4, d: 65, long: 'z' as const };
function opera(b: GeoBuilder): void {
  const C = 0xf0e0b8;
  const TRIM = 0xfbf3d8;
  const OCHRE = 0xe3cd96;
  const PATINA = 0x6b9a86;
  const SHUT = 0x4f7d62;
  const STATUE = 0xf6f2ea;
  // Auditorium, stage house and rear bump.
  b.box(29, 18, 40, 0, 9, -9.5, C);
  b.place(gableGeometry(40.6, 6.5, 30), 0, 18, -9.5, PATINA, {}, [0, Math.PI / 2, 0]);
  b.box(5, 2.2, 14, 0, 25.6, -9.5, 0xcfe6e0, { emis: 0xfff1d6, emisStrength: 0.7 });
  b.box(13, 14, 3.2, 0, 7, -31, C);
  for (const s of [-1, 1]) for (let z = -26; z <= 6; z += 4) arch(b, s * 14.55, 4, z, 2, 8, 0.3, 'x', WIN, WARM);
  // Front wings and their cornice.
  b.box(32.4, 14.5, 19, 0, 7.25, 20, C);
  b.box(33, 0.8, 19.6, 0, 14.9, 20, TRIM);
  b.box(32.4, 1.2, 19, 0, 15.9, 20, OCHRE);
  for (const s of [-1, 1]) {
    const x = s * 12.9;
    arch(b, x, 1.5, 29.6, 3, 5.4, 0.3, 'z', TRIM, {});
    arch(b, x, 1.5, 29.72, 2.4, 5, 0.3, 'z', SHUT, WARM);
    arch(b, x, 8.2, 29.6, 2.8, 4.2, 0.3, 'z', TRIM, {});
    arch(b, x, 8.2, 29.72, 2.2, 3.8, 0.3, 'z', SHUT, WARM);
  }
  // Central arch block: three round-headed openings, pilasters, pediment and two statues.
  b.box(19, 18.5, 22.5, 0, 9.25, 21.25, C);
  b.box(20, 0.8, 23.2, 0, 18.9, 21.25, TRIM);
  b.place(gableGeometry(2, 4.2, 20), 0, 19.3, 31.5, TRIM, {}, [0, Math.PI / 2, 0]);
  arch(b, 0, 1.2, 32.6, 5.6, 9, 0.3, 'z', TRIM, {});
  arch(b, 0, 1.2, 32.72, 4.8, 8.6, 0.3, 'z', ARCH_DARK, ARCH_GLOW);
  for (const s of [-1, 1]) {
    const x = s * 6.4;
    arch(b, x, 1.2, 32.6, 3.4, 6, 0.3, 'z', TRIM, {});
    arch(b, x, 1.2, 32.72, 2.8, 5.6, 0.3, 'z', ARCH_DARK, ARCH_GLOW);
    b.box(0.9, 16, 0.9, s * 3.4, 8.2, 32.7, TRIM);
    b.box(0.9, 16, 0.9, s * 9.1, 8.2, 32.7, TRIM);
    arch(b, x, 10.8, 32.6, 2.4, 3.8, 0.3, 'z', SHUT, WARM);
    b.box(1.6, 2, 1.6, s * 8.2, 20.3, 32.2, OCHRE);
    b.place(new THREE.ConeGeometry(0.7, 2.6, 7), s * 8.2, 22.6, 32.2, STATUE);
    b.place(new THREE.SphereGeometry(0.38, 7, 5), s * 8.2, 24.1, 32.2, STATUE);
  }
  b.box(22, 0.6, 4, 0, 0.3, 34.6, 0xe5dcc5);
  b.box(20, 0.4, 2.4, 0, 0.8, 34.2, 0xe5dcc5);
}

/**
 * Dinh Độc Lập (OSM 39598493). Footprint 86 (x) × 76.4 (z): the 85 m front (+z, toward Nam Kỳ Khởi Nghĩa and the lawn) is a
 * 26 m cream concrete block, 20 m wings, ground-floor pilotis, upper floors behind the perforated "trúc mành" screens, a wide
 * stair podium, a rear hall with a helipad and a flagpole on the roof.
 */
const PALACE = { w: 86, d: 76.4, long: 'x' as const };
function independencePalace(b: GeoBuilder): void {
  const CONC = 0xe9e0c8;
  const SLAB = 0xf4eedb;
  const GLASS = 0x34454b;
  const SCREEN = 0xd6caa8;
  const FRONT = 38.1;
  // Masses: two wings, the central block, and the rear hall.
  for (const s of [-1, 1]) b.box(31, 19.5, 28.2, s * 27.5, 9.75, 24, CONC);
  b.box(24, 26, 48.1, 0, 13, 14, CONC);
  b.box(31.7, 16, 28.2, 0, 8, -24, CONC);
  // Floor slabs and roof overhangs.
  for (const y of [6.5, 13]) {
    for (const s of [-1, 1]) b.box(32, 0.7, 29, s * 27.5, y, 24, SLAB);
    b.box(25, 0.7, 49, 0, y, 14, SLAB);
  }
  for (const s of [-1, 1]) b.box(32.6, 0.8, 29.6, s * 27.5, 19.8, 24, SLAB);
  b.box(25, 0.7, 49, 0, 19.5, 14, SLAB);
  b.box(25.8, 0.9, 49.8, 0, 26.4, 14, SLAB);
  // Glazed bands, pilotis on the ground floor, and screens in front of the upper floors.
  const bands: [number, number, number][] = [];
  for (const s of [-1, 1]) bands.push([s * 27.5, 28, 3]);
  bands.push([0, 22, 4]);
  for (const [cx, w, floors] of bands) {
    for (let i = 0; i < floors; i++) {
      const yc = 3.6 + 6.5 * i;
      b.box(w, 4.6, 0.3, cx, yc, FRONT + 0.1, GLASS, WARM);
      if (i === 0) continue;
      for (let x = -w / 2 + 0.6; x <= w / 2 - 0.5; x += 1.1) b.box(0.4, 5.6, 0.5, cx + x, yc, FRONT + 0.55, SCREEN);
    }
  }
  for (let x = -40; x <= 40.1; x += 5.5) b.box(1.3, 6.2, 1.3, x, 3.1, FRONT + 1.3, SLAB);
  // Wide stair podium.
  for (let k = 0; k < 3; k++) b.box(54 - k * 4, 0.45 * (k + 1), 3, 0, 0.225 * (k + 1), FRONT + 6.4 - 1.5 * k, 0xe4dcc7);
  // Rear hall helipad and rooftop pavilion.
  b.place(cyl(5.5, 5.5, 0.3, 16), 0, 16.15, -24, 0x8a918c);
  b.box(3.4, 0.08, 0.5, 0, 16.34, -24, 0xf5d13a);
  b.box(0.5, 0.08, 3.4, -1.6, 16.34, -24, 0xf5d13a);
  b.box(0.5, 0.08, 3.4, 1.6, 16.34, -24, 0xf5d13a);
  b.box(10, 3, 10, 0, 28.3, 14, CONC);
  b.box(10.8, 0.5, 10.8, 0, 30, 14, SLAB);
  // Flagpole with the national flag.
  b.place(cyl(0.18, 0.18, 9, 6), 0, 34.5, 28, 0xd0d0d0);
  b.box(5, 3.3, 0.08, 2.6, 37.6, 28, 0xd9412b);
  b.place(new THREE.CylinderGeometry(0.75, 0.75, 0.1, 5), 2.6, 37.6, 28.06, 0xf5d13a, {}, [Math.PI / 2, 0, 0]);
}

interface ModelSpec {
  build: (b: GeoBuilder, sx: number, sz: number, sy: number) => void;
  /** Model bounding box (x width, z depth) and which axis is its long side. */
  w: number;
  d: number;
  long: 'x' | 'z';
  /** Scale both horizontal axes by the same factor (towers must not be squashed). */
  uniform?: boolean;
  /** Model y values are real metres: no vertical stretch (supertall towers whose height is a known fact). Otherwise the stretch follows the plan fit, 1 to 1.5. */
  absoluteHeight?: boolean;
}

const MODELS: Record<LandmarkKey, ModelSpec> = {
  benThanh: { build: benThanhMarket, ...BEN_THANH },
  ubnd: { build: peoplesCommittee, ...PEOPLES_COMMITTEE },
  bitexco: { build: bitexco, ...BITEXCO },
  cafeApt: { build: cafeApartment, ...CAFE_APT },
  notreDame: { build: notreDame, ...NOTRE_DAME },
  postOffice: { build: postOffice, ...POST_OFFICE },
  opera: { build: opera, ...OPERA },
  palace: { build: independencePalace, ...PALACE },
};

// ------------------------------------------------------------------ placement

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Minimum distance from (x, z) to any link reference-line sample (bridges excluded, every 4 m). */
function roadDistance(samples: number[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < samples.length; i += 2) {
    const d = (samples[i] - x) ** 2 + (samples[i + 1] - z) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Centroid of the junctions named after `FACE_JUNCTION[key]` near (cx, cz); null when the landmark has no such rule or the map has none. */
function faceTarget(net: Network, key: LandmarkKey, cx: number, cz: number): { x: number; z: number } | null {
  const text = FACE_JUNCTION[key];
  if (!text) return null;
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (const j of net.junctions) {
    if (!j.name.includes(text) || Math.hypot(j.x - cx, j.z - cz) > FACE_REACH) continue;
    sx += j.x;
    sz += j.z;
    n++;
  }
  return n ? { x: sx / n, z: sz / n } : null;
}

function polygonArea(p: number[]): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return Math.abs(a) / 2;
}

/** Extrudes the OSM outline into a low CREAM plinth under a model that is smaller than its footprint. */
function podium(pts: number[]): THREE.BufferGeometry {
  const n = pts.length / 2;
  const shape = new THREE.Shape();
  for (let i = 0; i < n; i++) {
    if (i === 0) shape.moveTo(pts[0], -pts[1]);
    else shape.lineTo(pts[i * 2], -pts[i * 2 + 1]);
  }
  const ext = new THREE.ExtrudeGeometry(shape, { depth: PODIUM_H, bevelEnabled: false });
  ext.rotateX(-Math.PI / 2);
  const b = new GeoBuilder();
  b.add(ext, new THREE.Matrix4(), CREAM);
  ext.dispose();
  return b.build();
}

function ringIsland(b: GeoBuilder, cx: number, cz: number, ri: number): void {
  const seg = Math.max(16, Math.round(ri * 5));
  b.place(cyl(ri - 0.2, ri, 0.3, seg), cx, 0.15, cz, 0xd8cfbd);
  b.place(cyl(ri - 0.8, ri - 0.8, 0.12, seg), cx, 0.32, cz, 0x86b062);
  // Flower ring.
  const flowers = [0xe0607a, 0xf2c230, 0xe86a3a, 0xf4f1e8];
  const fr = Math.max(1, ri * 0.68);
  const count = Math.max(6, Math.round((Math.PI * 2 * fr) / 1.6));
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    b.place(new THREE.IcosahedronGeometry(0.5, 0), cx + Math.cos(a) * fr, 0.55, cz + Math.sin(a) * fr, flowers[i % 4]);
  }
  b.place(new THREE.IcosahedronGeometry(Math.min(1.3, ri * 0.3), 0), cx, 0.7, cz, 0x3f7d3a);
}

function shelterGeometry(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.box(5, 0.15, 2, 0, 2.6, 0.1, 0x2f7d74);
  g.box(5, 2.3, 0.1, 0, 1.3, 0.95, 0xcfe3e6, { emis: 0xfff1d6, emisStrength: 0.8 });
  g.box(0.12, 2.6, 0.12, -2.4, 1.3, 0.9, 0x3a3a3a);
  g.box(0.12, 2.6, 0.12, 2.4, 1.3, 0.9, 0x3a3a3a);
  g.box(3.4, 0.12, 0.5, 0, 0.5, 0.6, 0x8a6a4a);
  g.box(0.1, 3, 0.1, 2.9, 1.5, -0.4, 0x3a3a3a);
  g.box(0.7, 0.7, 0.06, 2.9, 2.8, -0.4, 0x2e7dd1, { emis: 0x7fb8ff, emisStrength: 0.8 });
  return g.build();
}

/** Cone from p0 (base centre) to p1 (apex): lotus petals. */
function petal(b: GeoBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, color: number, opts: PartOptions): void {
  const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  const g = new THREE.ConeGeometry(r, len, 4);
  const dir = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  b.add(g, new THREE.Matrix4().compose(new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), q, new THREE.Vector3(1, 1, 1)), color, opts);
  g.dispose();
}

/** Tượng Trần Hưng Đạo: bronze figure on a tall granite plinth at the centre of Công trường Mê Linh, arm towards the river. */
function tranHungDao(b: GeoBuilder, x: number, z: number): void {
  const GRANITE = 0xbdb5a5;
  const BRONZE = 0x8a6a3a;
  b.box(5, 1.2, 5, x, 0.6, z, GRANITE);
  b.box(3.4, 7, 3.4, x, 4.7, z, 0xcfc7b8);
  b.box(4, 0.5, 4, x, 8.45, z, GRANITE);
  b.place(new THREE.ConeGeometry(0.95, 2.8, 8), x, 10.1, z, BRONZE);
  b.place(new THREE.SphereGeometry(0.46, 8, 6), x, 11.8, z, BRONZE);
  b.box(1.9, 0.24, 0.3, x + 0.95, 11.0, z, BRONZE, {}, 0, 0, 0.35);
}

/** Ga Bến Thành: glass drum under an eight-petal lotus skylight, replacing the unnamed OSM pavilion cylinder. */
function lotusSkylight(b: GeoBuilder, x: number, z: number): void {
  const GLASS = 0xcfe8ee;
  const glow = { emis: 0xfff1d6, emisStrength: 0.55 };
  b.place(cyl(8, 8.4, 4.2, 20), x, 2.1, z, 0xa9c9d1, glow);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    petal(b, x + Math.cos(a) * 3.6, 4.2, z + Math.sin(a) * 3.6, x + Math.cos(a) * 7.6, 10, z + Math.sin(a) * 7.6, 1.9, GLASS, glow);
    const c = a + Math.PI / 8;
    petal(b, x + Math.cos(c) * 2, 4.2, z + Math.sin(c) * 2, x + Math.cos(c) * 3.4, 12, z + Math.sin(c) * 3.4, 1.4, 0xe9f6f4, glow);
  }
}

/**
 * Ga Nhà hát Thành phố (metro Line 1, stop area OSM relation 18429059) entrance pavilion: a glass stair enclosure under a flat steel canopy
 * with the blue metro sign. Local frame: the opening faces +z, the long side runs along x.
 */
function metroEntrance(b: GeoBuilder): void {
  const GLASS = 0xbfe0e6;
  const glow = { emis: 0xfff1d6, emisStrength: 0.6 };
  b.box(6.4, 0.2, 3.6, 0, 0.1, 0, 0xb9b6ae);
  b.box(5.8, 2.9, 0.1, 0, 1.65, -1.55, GLASS, glow);
  b.box(0.1, 2.9, 3.0, -2.85, 1.65, 0, GLASS, glow);
  b.box(0.1, 2.9, 3.0, 2.85, 1.65, 0, GLASS, glow);
  b.box(4.6, 2.5, 0.08, 0, 1.45, 1.5, 0x2a2f33, glow);
  for (const x of [-2.9, 2.9]) b.box(0.18, 3.1, 0.18, x, 1.65, 1.6, 0x4a4f55);
  b.box(6.6, 0.28, 3.8, 0, 3.3, 0, 0x3e4750);
  b.box(6.6, 0.1, 3.8, 0, 3.49, 0, 0xe8ecee);
  b.box(0.12, 1.3, 0.12, -2.4, 3.95, 1.55, 0x4a4f55);
  b.box(1.0, 1.0, 0.1, -2.4, 4.9, 1.55, 0x1f6fc9, { emis: 0x7fb8ff, emisStrength: 0.9 });
  b.box(0.5, 0.5, 0.12, -2.4, 4.9, 1.55, 0xf4f7fb, { emis: 0xffffff, emisStrength: 0.6 });
}

/** Façade yaw so that local +z points along (fx, fz); local x is then the road tangent. */
const faceYaw = (fx: number, fz: number) => Math.atan2(fx, fz);

/**
 * Scene-only props that OSM does not carry, in world metres: the Mê Linh park island centre, the Bến Thành metro station pavilion and
 * the Nhà hát Thành phố station entrances. Each `build` draws in a local frame around (0, 0) and is placed at
 * (x, z) turned by `yaw`.
 *
 * Nhà hát Thành phố entrances: OSM `railway=subway_entrance` nodes that are members of stop_area relation 18429059
 * (https://www.openstreetmap.org/relation/18429059): ref 1 node 10237519587, ref 2 node 10237519585, ref 3 node 10237519586, ref 4 node 12472881216
 * (the Union Square basement link), ref 5 node 7498869576 (Công viên Lam Sơn, in front of the Opera House). Nodes 3 and 5 are nudged
 * 4 m / 1.8 m off the carriageway edge, where the OSM position falls on asphalt. All face the nearest Lê Lợi carriageway.
 *
 * Tượng Trần Nguyên Hãn is deliberately absent: it was removed in 2014 for the Bến Thành station works (now in Công viên Phú Lâm) and,
 * as of 2026-10, no source says it has been re-erected (https://vi.wikipedia.org/wiki/C%C3%B4ng_tr%C6%B0%E1%BB%9Dng_Qu%C3%A1ch_Th%E1%BB%8B_Trang).
 */
const PROPS: { x: number; z: number; yaw?: number; build: (b: GeoBuilder, x: number, z: number) => void }[] = [
  { x: 585, z: -90, build: tranHungDao },
  { x: -383, z: 405, build: lotusSkylight },
  { x: 68.5, z: -87.7, yaw: faceYaw(0.73, 0.68), build: metroEntrance },
  { x: 30.1, z: -48.5, yaw: faceYaw(0.74, 0.68), build: metroEntrance },
  { x: 65.2, z: -13.2, yaw: faceYaw(-0.74, -0.67), build: metroEntrance },
  { x: 155.2, z: -190.1, yaw: faceYaw(0.73, 0.68), build: metroEntrance },
  { x: 180, z: -138.6, yaw: faceYaw(-0.72, -0.69), build: metroEntrance },
];

export function buildLandmarks(net: Network, scene: SceneJson): THREE.Group {
  const group = new THREE.Group();
  group.name = 'landmarks';
  const parts: THREE.BufferGeometry[] = [];

  const samples: number[] = [];
  for (const l of net.links) {
    if (l.bridge) continue;
    for (let i = 0; i < l.n; i += 8) samples.push(l.px[i], l.pz[i]);
  }

  // ---- hand-modelled landmarks fitted to their OSM footprints
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (const lm of scene.landmarks) {
    const spec = MODELS[lm.key];
    if (!spec) {
      if (import.meta.env.DEV) console.info(`[landmarks] no model for ${lm.key}`);
      continue;
    }
    const ux = Math.cos(lm.rot);
    const uz = Math.sin(lm.rot);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (let i = 0; i < lm.pts.length; i += 2) {
      const u = lm.pts[i] * ux + lm.pts[i + 1] * uz;
      const v = -lm.pts[i] * uz + lm.pts[i + 1] * ux;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const longLen = Math.max(u1 - u0, v1 - v0);
    const shortLen = Math.min(u1 - u0, v1 - v0);
    const [modelLong, modelShort] = spec.long === 'x' ? [spec.w, spec.d] : [spec.d, spec.w];
    const sLong = clamp(longLen / modelLong, FIT_MIN, FIT_MAX);
    const sShort = clamp(shortLen / modelShort, FIT_MIN, FIT_MAX);
    let sx = spec.long === 'x' ? sLong : sShort;
    let sz = spec.long === 'x' ? sShort : sLong;
    if (spec.uniform) sx = sz = Math.min(sx, sz);
    const sy = spec.absoluteHeight ? 1 : clamp(Math.min(sx, sz), 1, 1.5);

    // Model +z (façade) → world direction (sin θ, cos θ); the long axis follows the footprint heading.
    let theta = spec.long === 'x' ? -lm.rot : Math.PI / 2 - lm.rot;
    const target = FACE_POINT[lm.key] ?? faceTarget(net, lm.key, lm.cx, lm.cz);
    if (target) {
      // Face the named place: keep whichever of the two ends points at it.
      if (Math.sin(theta) * (target.x - lm.cx) + Math.cos(theta) * (target.z - lm.cz) < 0) theta += Math.PI;
    } else {
      const reach = (spec.d * sz) / 2 + 14;
      const dx = Math.sin(theta) * reach;
      const dz = Math.cos(theta) * reach;
      if (roadDistance(samples, lm.cx - dx, lm.cz - dz) < roadDistance(samples, lm.cx + dx, lm.cz + dz)) theta += Math.PI;
    }
    theta += FIX[lm.key];

    const b = new GeoBuilder();
    spec.build(b, sx, sz, sy);
    const geo = b.build();
    m.compose(new THREE.Vector3(lm.cx, 0, lm.cz), q.setFromAxisAngle(up, theta), new THREE.Vector3(sx, sy, sz));
    geo.applyMatrix4(m);
    parts.push(geo);

    // A footprint much larger than the (clamped) model: fill it with a low plinth.
    if (polygonArea(lm.pts) > 1.8 * spec.w * sx * spec.d * sz) parts.push(podium(lm.pts));

    if (lm.key === 'benThanh') {
      const sign = textPlane('CHỢ BẾN THÀNH', BEN_THANH.sign.w, BEN_THANH.sign.h, '#f3ead2', '#b5302a');
      // Fixed world size: 5.6 × 1.1 model units → 8.1 × 1.6 m on the 9 m tower.
      const s = 1.45;
      const local = new THREE.Vector3(0, BEN_THANH.sign.y * sy, BEN_THANH.sign.z * sz);
      local.applyAxisAngle(up, theta);
      sign.position.set(lm.cx + local.x, local.y, lm.cz + local.z);
      sign.rotation.y = theta;
      sign.scale.setScalar(s);
      group.add(sign);
    }
  }

  // ---- generic roundabout islands
  const islands = new GeoBuilder();
  let hasIsland = false;
  for (const ring of net.rings) {
    const ri = ring.r - ring.halfW - 0.5;
    if (ri < 2) continue;
    ringIsland(islands, ring.cx, ring.cz, ri);
    hasIsland = true;
  }
  for (const p of PROPS) {
    const pb = new GeoBuilder();
    p.build(pb, 0, 0);
    const pg = pb.build();
    pg.applyMatrix4(m.compose(new THREE.Vector3(p.x, 0, p.z), q.setFromAxisAngle(up, p.yaw ?? 0), new THREE.Vector3(1, 1, 1)));
    parts.push(pg);
  }
  if (hasIsland) parts.push(islands.build());

  // ---- bus shelters on the sidewalk beside each stop
  const shelter = shelterGeometry();
  const tmp = [0, 0, 0, 0];
  for (const stop of net.busStops) {
    if (stop.link.bridge) continue;
    stop.link.sample(stop.s, tmp);
    const off = stop.link.halfW + 1.9;
    const x = tmp[0] - tmp[3] * off;
    const z = tmp[1] + tmp[2] * off;
    const g = shelter.clone();
    m.compose(new THREE.Vector3(x, 0, z), q.setFromAxisAngle(up, Math.atan2(-tmp[3], tmp[2])), new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    parts.push(g);
  }
  shelter.dispose();

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (merged) {
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, makeMaterial({}, { roughness: 0.75 }));
    mesh.name = 'landmarks-mesh';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
