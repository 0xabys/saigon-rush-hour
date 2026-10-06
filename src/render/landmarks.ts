import * as THREE from 'three';
import { RIVER, RING_CENTER, RING_INNER, ROAD_HALF, type Network } from '../sim/network';
import { GeoBuilder, gableGeometry } from './geo';
import { makeMaterial } from './materials';

const CREAM = 0xf2e2b5;
const TILE = 0xb5563a;
const WIN = 0x2f3a3e;
const WARM = { emis: 0xffcf8a, emisStrength: 1.1 };
const cyl = (rt: number, rb: number, h: number, seg = 12) => new THREE.CylinderGeometry(rt, rb, h, seg);

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

function benThanhMarket(b: GeoBuilder): void {
  const cx = -162;
  const cz = -68;
  b.box(30, 6, 52, cx, 3, cz, 0xf0d9a0);
  // Pitched hall roofs along the long axis, with lower side aisles.
  b.place(gableGeometry(50, 4.5, 20), cx, 6, cz, TILE, {}, [0, Math.PI / 2, 0]);
  b.box(6, 0.6, 50, cx - 12, 6.3, cz, 0x9a5a3a);
  b.box(6, 0.6, 50, cx + 12, 6.3, cz, 0x9a5a3a);
  // Clerestory windows glow at night.
  for (let z = cz - 22; z <= cz + 22; z += 4) {
    b.box(0.2, 1.6, 2.4, cx - 15.05, 3.4, z, WIN, WARM);
    b.box(0.2, 1.6, 2.4, cx + 15.05, 3.4, z, WIN, WARM);
  }
  // South gate facade facing the roundabout, with the clock tower.
  const fz = cz + 26;
  b.box(22, 9, 3, cx, 4.5, fz + 0.5, CREAM);
  b.box(23, 0.6, 3.6, cx, 9.2, fz + 0.5, 0xe5cf98);
  for (const x of [-7, 0, 7]) {
    b.box(4.2, 5.2, 0.4, cx + x, 2.6, fz + 2.05, 0x4a3a2a, { emis: 0xffc070, emisStrength: 1.4 });
    b.place(cyl(2.1, 2.1, 0.4, 12), cx + x, 5.2, fz + 2.05, 0x4a3a2a, { emis: 0xffc070, emisStrength: 1.4 }, [Math.PI / 2, 0, 0], [1, 1, 0.5]);
  }
  for (const x of [-10.5, -3.5, 3.5, 10.5]) b.box(1, 9, 0.6, cx + x, 4.5, fz + 2.15, 0xfbf0d0);
  b.box(6, 17, 6, cx, 8.5, fz, CREAM);
  b.box(6.6, 0.6, 6.6, cx, 17.2, fz, 0xe5cf98);
  b.place(new THREE.ConeGeometry(4.6, 5, 4), cx, 20, fz, TILE, {}, [0, Math.PI / 4, 0]);
  b.place(cyl(0.1, 0.1, 3), cx, 23.5, fz, 0x5a4a3a);
  b.box(1.4, 0.8, 0.05, cx + 0.7, 24.4, fz, 0xd9412b);
  // Clock face.
  b.place(cyl(1.9, 1.9, 0.25, 20), cx, 13.6, fz + 3.1, 0xfbf6ea, { emis: 0xfff2d0, emisStrength: 0.9 }, [Math.PI / 2, 0, 0]);
  b.box(0.15, 1.4, 0.1, cx, 14.2, fz + 3.28, 0x1d1a17);
  b.box(1.1, 0.15, 0.1, cx + 0.45, 13.6, fz + 3.28, 0x1d1a17);
}

function peoplesCommittee(b: GeoBuilder): void {
  const cx = 0;
  const cz = -99;
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

function cafeApartment(b: GeoBuilder): void {
  // "Chung cư 42 Nguyễn Huệ": a tired 1960s block reborn as stacked cafés facing the walking street.
  const x0 = -28.5;
  const x1 = -14;
  const z0 = -30;
  const z1 = -8;
  const floors = 9;
  const H = floors * 3.2;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  b.box(x1 - x0, H, z1 - z0, cx, H / 2, cz, 0xe3dccb);
  // Window bands on the street-facing back and sides.
  for (let f = 0; f < floors; f++) {
    b.box(x1 - x0 - 0.3, 1.2, z1 - z0 + 0.12, cx - 0.15, f * 3.2 + 1.7, cz, WIN, { emis: 0xffd9a0, emisStrength: 0.6 });
  }
  const cafes = [0xd9412b, 0xe9a23b, 0x2f8c84, 0xf2d68a, 0x3f8f5a, 0xd96c3a, 0x2c5f9e, 0xc8463a];
  for (let f = 1; f < floors; f++) {
    const y = f * 3.2;
    b.box(1.4, 0.18, z1 - z0, x1 + 0.7, y, cz, 0xcfc6b2);
    b.box(0.08, 1, z1 - z0, x1 + 1.38, y + 0.55, cz, 0x2a2a2a);
    for (let k = 0; k < 4; k++) {
      const zc = z0 + 2.75 + k * 5.5;
      const c = cafes[(f * 3 + k) % cafes.length];
      b.box(0.15, 2.4, 4.6, x1 + 0.05, y + 1.4, zc, c, { emis: 0xffcf8a, emisStrength: 1.3 });
      b.box(0.6, 0.12, 4.8, x1 + 0.6, y + 2.75, zc, c);
    }
  }
  b.box(0.2, 2.8, z1 - z0 - 2, x1 + 0.1, 1.5, cz, 0x3a2e24, { emis: 0xffc070, emisStrength: 1.6 });
  b.box(x1 - x0, 1, z1 - z0, cx, H + 0.5, cz, 0xd5ccb6);
}

function plaza(b: GeoBuilder): void {
  // Nguyễn Huệ walking street: paving, long fountain beds and planters.
  b.box(24, 0.06, 116, 0, 0.03, 0, 0xf5ecd8);
  for (const x of [-4.5, 4.5]) {
    for (let z = -50; z <= 50; z += 20) {
      b.box(2.2, 0.35, 14, x, 0.18, z, 0xd8cfbd);
      b.box(1.8, 0.1, 13.6, x, 0.36, z, 0x6fbfb6, { emis: 0x7fe0ff, emisStrength: 0.3 });
    }
  }
  for (let z = -54; z <= 54; z += 9) {
    b.box(1.6, 0.45, 0.6, -9.5, 0.23, z, 0x8a6a4a);
    b.box(1.6, 0.45, 0.6, 9.5, 0.23, z, 0x8a6a4a);
  }
  // Central music fountain + monument at the north end of the street.
  b.place(cyl(5, 5.4, 0.6, 24), 0, 0.3, 46, 0xd8cfbd);
  b.place(cyl(4.6, 4.6, 0.1, 24), 0, 0.62, 46, 0x6fbfb6, { emis: 0x7fe0ff, emisStrength: 0.5 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.place(cyl(0.12, 0.25, 2.2, 6), Math.cos(a) * 2.8, 1.6, 46 + Math.sin(a) * 2.8, 0xdff4f2, { emis: 0xbff4ff, emisStrength: 0.8 });
  }
  b.place(cyl(0.3, 0.6, 4, 6), 0, 2.6, 46, 0xdff4f2, { emis: 0xbff4ff, emisStrength: 0.8 });
  b.box(5, 2.4, 3.4, 0, 1.2, -52, 0xcfc6b2);
  b.box(1.2, 4, 1, 0, 4.4, -52, 0x6a5236);
  b.place(new THREE.IcosahedronGeometry(0.45, 0), 0, 6.8, -52, 0x6a5236);
}

function roundaboutIsland(b: GeoBuilder): void {
  const { x, z } = RING_CENTER;
  b.place(cyl(RING_INNER - 0.2, RING_INNER, 0.3, 40), x, 0.15, z, 0xd8cfbd);
  b.place(cyl(RING_INNER - 0.8, RING_INNER - 0.8, 0.12, 40), x, 0.32, z, 0x86b062);
  // Flower ring.
  const flowers = [0xe0607a, 0xf2c230, 0xe86a3a, 0xf4f1e8];
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    b.place(new THREE.IcosahedronGeometry(0.55, 0), x + Math.cos(a) * 8.5, 0.6, z + Math.sin(a) * 8.5, flowers[i % 4]);
  }
  // Equestrian statue on a granite plinth.
  b.box(4, 3.6, 2.6, x, 2.1, z, 0x9a958c);
  b.box(4.4, 0.3, 3, x, 4.05, z, 0xb3ada2);
  const BRONZE = 0x5a4630;
  b.box(2.6, 1, 0.8, x, 5.2, z, BRONZE);
  for (const [dx, dz] of [
    [1, 0.3],
    [1, -0.3],
    [-1, 0.3],
    [-1, -0.3],
  ]) {
    b.box(0.25, 1.2, 0.25, x + dx, 4.6, z + dz, BRONZE);
  }
  b.box(0.8, 1.2, 0.5, x + 1.4, 6, z, BRONZE, {}, 0, 0, -0.5);
  b.box(0.6, 1.3, 0.6, x - 0.1, 6.2, z, BRONZE);
  b.place(new THREE.IcosahedronGeometry(0.3, 0), x - 0.1, 7.1, z, BRONZE);
  b.box(0.1, 1.8, 0.1, x + 0.4, 7, z + 0.3, BRONZE, {}, 0, 0, -0.4);
}

function bitexco(b: GeoBuilder): void {
  const cx = 82;
  const cz = 110;
  b.box(30, 7, 30, cx, 3.5, cz, 0xe0d6c4);
  b.box(30.4, 0.6, 30.4, cx, 7.2, cz, 0xcfc6b2);
  for (let i = 0; i < 6; i++) b.box(4, 2.6, 0.2, cx - 10 + i * 4, 2, cz + 15.05, WIN, { emis: 0xffd9a0, emisStrength: 1.2 });
  // Lotus-bud tower: tapering lens plan with a sloped crown.
  const H = 78;
  const levels = 12;
  for (let i = 0; i < levels; i++) {
    const t0 = i / levels;
    const t1 = (i + 1) / levels;
    const r0 = 8.2 - 3.4 * t0 * t0 + 0.9 * Math.sin(t0 * Math.PI);
    const r1 = 8.2 - 3.4 * t1 * t1 + 0.9 * Math.sin(t1 * Math.PI);
    const y = 7 + (t0 + t1) * 0.5 * H;
    b.place(cyl(r1, r0, H / levels, 16), cx, y, cz, 0xb9c4c2, { emis: 0xfff1d6, emisStrength: 0.35 }, [0, 0, 0], [1, 1, 0.68]);
  }
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
    beam(b, cx + Math.cos(ang) * 8.3, 7, cz + Math.sin(ang) * 8.3 * 0.68, cx + Math.cos(ang) * 4.9, 7 + H, cz + Math.sin(ang) * 4.9 * 0.68, 0.12, 0xe8ecea);
  }
  b.place(cyl(4.4, 4.4, 4, 16), cx, 7 + H + 1, cz, 0xc9d3d1, {}, [0.35, 0, 0], [1, 1, 0.68]);
  b.place(cyl(0.12, 0.12, 8, 5), cx, 7 + H + 6, cz, 0xe8ecea, { emis: 0xff4030, emisStrength: 2 });
  // The helipad cantilevered off the side.
  const hy = 7 + H * 0.68;
  b.place(cyl(7, 6.4, 1.2, 20), cx + 9.5, hy, cz, 0xd9d6cc);
  b.place(cyl(5.4, 5.4, 0.08, 20), cx + 9.5, hy + 0.64, cz, 0x5a6064);
  b.box(0.6, 0.06, 3.2, cx + 8.4, hy + 0.7, cz, 0xf2c230);
  b.box(0.6, 0.06, 3.2, cx + 10.6, hy + 0.7, cz, 0xf2c230);
  b.box(2.8, 0.06, 0.6, cx + 9.5, hy + 0.7, cz, 0xf2c230);
  b.place(new THREE.TorusGeometry(7, 0.15, 4, 28), cx + 9.5, hy + 0.7, cz, 0xf2c230, { emis: 0xffb84a, emisStrength: 1.4 }, [Math.PI / 2, 0, 0]);
}

function landmark81(b: GeoBuilder): void {
  const cx = 245;
  const cz = -127;
  b.box(34, 8, 34, cx, 4, cz, 0xe0d6c4);
  for (let i = 0; i < 8; i++) b.box(3.4, 3, 0.2, cx - 13 + i * 3.7, 2.4, cz + 17.05, WIN, { emis: 0xffd9a0, emisStrength: 1.2 });
  // Bundled bamboo stalks of different heights.
  const stalks: [number, number, number][] = [
    [0, 0, 128],
    [-6.2, 0, 112],
    [6.2, 0, 104],
    [0, -6.2, 118],
    [0, 6.2, 96],
    [-6.2, -6.2, 92],
    [6.2, 6.2, 82],
    [-6.2, 6.2, 86],
    [6.2, -6.2, 100],
  ];
  for (const [dx, dz, h] of stalks) {
    const s = dx === 0 && dz === 0 ? 7 : 6;
    b.box(s, h, s, cx + dx, 8 + h / 2, cz + dz, 0xa9bec4, { emis: 0xfff0d0, emisStrength: 0.22 });
    for (let y = 14; y < h; y += 14) b.box(s + 0.12, 0.5, s + 0.12, cx + dx, 8 + y, cz + dz, 0xe8ecea);
    b.box(s + 0.14, 1.2, s + 0.14, cx + dx, 8 + h - 0.6, cz + dz, 0xe8ecea, { emis: 0xcfe8ff, emisStrength: 2.2 });
  }
  b.box(3, 14, 3, cx, 8 + 128 + 7, cz, 0xe8ecea, { emis: 0xcfe8ff, emisStrength: 1.8 });
  b.place(cyl(0.2, 0.3, 10, 6), cx, 8 + 128 + 19, cz, 0xe8ecea, { emis: 0xff4030, emisStrength: 2 });
}

function baSonBridge(b: GeoBuilder): void {
  const z = -70;
  const half = ROAD_HALF + 1.2;
  const x0 = RIVER.x0 - 8;
  const x1 = RIVER.x1 + 8;
  const DECK = 0xe2dccd;
  b.box(x1 - x0, 1.3, half * 2, (x0 + x1) / 2, -0.66, z, DECK);
  b.box(x1 - x0, 0.9, 0.3, (x0 + x1) / 2, 0.45, z - half + 0.15, 0xf4f0e6);
  b.box(x1 - x0, 0.9, 0.3, (x0 + x1) / 2, 0.45, z + half - 0.15, 0xf4f0e6);
  for (const x of [RIVER.x0 + 9, RIVER.x1 - 9]) b.place(cyl(1.4, 1.6, 6, 10), x, -3.6, z, 0xcfc8b8);
  // Single leaning pylon on the Thủ Thiêm side with fanned stays.
  const px = RIVER.x1 - 4;
  const top = { x: px + 6, y: 46 };
  const PYLON = 0xf4f1ea;
  for (const side of [-1, 1]) {
    beam(b, px, 0, z + side * (half - 0.6), top.x, top.y, z + side * 0.6, 0.9, PYLON, { emis: 0xfff2d6, emisStrength: 0.4 });
  }
  b.box(2.2, 6, 2.2, top.x, top.y + 1.5, z, PYLON, { emis: 0xfff2d6, emisStrength: 0.8 });
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    // Higher anchors on the pylon reach further out along the deck.
    const ay = top.y - 2 - t * 20;
    const lx = px + (top.x - px) * (ay / top.y);
    const mainX = RIVER.x0 - 4 + t * (px - 10 - (RIVER.x0 - 4));
    const backX = x1 + 6 - t * (x1 + 6 - (px + 10));
    for (const side of [-1, 1]) {
      const lz = z + side * (half - 0.6 - (half - 1.2) * (ay / top.y));
      beam(b, lx, ay, lz, mainX, 0.6, z + side * (half - 0.5), 0.07, 0xe8e4da);
      beam(b, lx, ay, lz, backX, 0.6, z + side * (half - 0.5), 0.07, 0xe8e4da);
    }
  }
}

function busShelters(b: GeoBuilder, net: Network): void {
  const tmp = [0, 0, 0, 0];
  for (const stop of net.busStops) {
    stop.link.sample(stop.s, tmp);
    const rx = -tmp[3];
    const rz = tmp[2];
    const off = ROAD_HALF - 3.9 + 1.9;
    const x = tmp[0] + rx * off;
    const z = tmp[1] + rz * off;
    const yaw = Math.atan2(-tmp[3], tmp[2]);
    const g = new GeoBuilder();
    g.box(5, 0.15, 2, 0, 2.6, 0.1, 0x2f7d74);
    g.box(5, 2.3, 0.1, 0, 1.3, 0.95, 0xcfe3e6, { emis: 0xfff1d6, emisStrength: 0.8 });
    g.box(0.12, 2.6, 0.12, -2.4, 1.3, 0.9, 0x3a3a3a);
    g.box(0.12, 2.6, 0.12, 2.4, 1.3, 0.9, 0x3a3a3a);
    g.box(3.4, 0.12, 0.5, 0, 0.5, 0.6, 0x8a6a4a);
    g.box(0.1, 3, 0.1, 2.9, 1.5, -0.4, 0x3a3a3a);
    g.box(0.7, 0.7, 0.06, 2.9, 2.8, -0.4, 0x2e7dd1, { emis: 0x7fb8ff, emisStrength: 0.8 });
    const geo = g.build();
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
    b.add(geo, m, 0xffffff);
    geo.dispose();
  }
}

function riverside(b: GeoBuilder): void {
  // Railings along both banks and the Bạch Đằng wharf.
  for (const [z0, z1] of [
    [-170, -79],
    [-61, 170],
  ]) {
    b.box(0.15, 0.9, z1 - z0, RIVER.x0 - 0.3, 0.45, (z0 + z1) / 2, 0x3e4a43);
    b.box(0.15, 0.9, z1 - z0, RIVER.x1 + 0.3, 0.45, (z0 + z1) / 2, 0x3e4a43);
  }
  b.box(8, 0.5, 16, RIVER.x0 + 4, -0.6, 40, 0xb08a5e);
  b.box(3, 2.6, 4, RIVER.x0 - 3, 1.3, 40, 0xf2e2b5);
  b.place(new THREE.ConeGeometry(3.2, 1.6, 4), RIVER.x0 - 3, 3.4, 40, TILE, {}, [0, Math.PI / 4, 0]);
}

export function buildLandmarks(net: Network): THREE.Group {
  const group = new THREE.Group();
  group.name = 'landmarks';
  const b = new GeoBuilder();
  benThanhMarket(b);
  peoplesCommittee(b);
  cafeApartment(b);
  plaza(b);
  roundaboutIsland(b);
  bitexco(b);
  landmark81(b);
  baSonBridge(b);
  busShelters(b, net);
  riverside(b);
  const mesh = new THREE.Mesh(b.build(), makeMaterial({}, { roughness: 0.75 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  const market = textPlane('CHỢ BẾN THÀNH', 13, 1.6, '#f3ead2', '#b5302a');
  market.position.set(-162, 8.1, -68 + 26 + 2.05);
  group.add(market);
  const nh = textPlane('PHỐ ĐI BỘ NGUYỄN HUỆ', 10, 1.2, '#2f6b6a', '#fbf6ea');
  nh.position.set(0, 0.62, 52.5);
  nh.rotation.x = -Math.PI / 2;
  group.add(nh);
  return group;
}
