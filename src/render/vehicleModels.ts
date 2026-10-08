import * as THREE from 'three';
import { GeoBuilder } from './geo';

// Local frame for every vehicle: +X forward, +Z right, +Y up, origin on the ground at the centre.

const TIRE = 0x1d1c1c;
const SKIN = 0xc99a6e;
const PANTS = 0x34405a;
const DARK = 0x2a2626;
const GLASS = 0x22313b;
const CHROME = 0xb9bec4;
const HEAD = { emis: 0xfff0c8, emisStrength: 5 };
const TAIL = { emis: 0xff2a14, emisStrength: 3.2 };

const wheel = (r: number, w: number) => new THREE.CylinderGeometry(r, r, w, 10);
const cone = (r: number, h: number) => new THREE.ConeGeometry(r, h, 10);
const ball = (r: number) => new THREE.IcosahedronGeometry(r, 1);
const dome = (r: number) => new THREE.SphereGeometry(r, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);

function scooterBody(b: GeoBuilder): void {
  b.place(wheel(0.28, 0.12), 0.62, 0.28, 0, TIRE, {}, [Math.PI / 2, 0, 0]);
  b.place(wheel(0.28, 0.12), -0.62, 0.28, 0, TIRE, {}, [Math.PI / 2, 0, 0]);
  b.box(1.1, 0.22, 0.3, -0.05, 0.42, 0, 0x3a3a3a);
  b.box(0.66, 0.34, 0.4, -0.38, 0.62, 0, 0xffffff, { paint: 2 });
  b.box(0.2, 0.62, 0.4, 0.44, 0.66, 0, 0xffffff, { paint: 2 }, 0, 0, -0.28);
  b.box(0.62, 0.08, 0.3, -0.3, 0.83, 0, DARK);
  b.box(0.08, 0.06, 0.62, 0.52, 1.04, 0, DARK);
  b.box(0.08, 0.11, 0.16, 0.6, 0.97, 0, 0xfff6e0, HEAD);
  b.box(0.05, 0.07, 0.2, -0.73, 0.72, 0, 0x8a1d16, TAIL);
}

function rider(b: GeoBuilder, x: number, paint: number, shirt = 0xffffff, helmetPaint = 2): void {
  b.box(0.5, 0.18, 0.36, x + 0.15, 0.86, 0, PANTS);
  b.box(0.15, 0.42, 0.32, x + 0.36, 0.62, 0, PANTS);
  b.box(0.32, 0.56, 0.44, x, 1.18, 0, shirt, { paint }, 0, 0, -0.18);
  b.box(0.5, 0.1, 0.1, x + 0.32, 1.16, 0.21, shirt, { paint }, 0, 0, -0.45);
  b.box(0.5, 0.1, 0.1, x + 0.32, 1.16, -0.21, shirt, { paint }, 0, 0, -0.45);
  b.place(ball(0.13), x + 0.06, 1.57, 0, SKIN);
  b.place(dome(0.165), x + 0.05, 1.59, 0, 0xffffff, { paint: helmetPaint });
}

export function motoGeometry(variant: number): THREE.BufferGeometry {
  const b = new GeoBuilder();
  scooterBody(b);
  rider(b, -0.2, 1);
  if (variant === 1) {
    // Passenger in a white áo dài with a nón lá.
    b.box(0.3, 0.52, 0.4, -0.62, 1.14, 0, 0xf3efe4, {}, 0, 0, -0.08);
    b.box(0.3, 0.16, 0.34, -0.52, 0.86, 0, 0xf3efe4);
    b.place(ball(0.12), -0.6, 1.5, 0, SKIN);
    b.place(cone(0.32, 0.2), -0.6, 1.66, 0, 0xe9d8a6);
  } else if (variant === 2) {
    // Overloaded with goods — a Saigon classic.
    b.box(0.62, 0.42, 0.86, -0.78, 1.05, 0, 0xc49a63);
    b.box(0.5, 0.36, 0.74, -0.8, 1.44, 0, 0xd9c49a);
    b.box(0.44, 0.3, 0.6, -0.76, 1.77, 0.02, 0x6b8c5a);
    b.box(0.64, 0.04, 0.9, -0.78, 1.27, 0, 0xc0392b);
  }
  return b.build();
}

export function grabGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  scooterBody(b);
  rider(b, -0.18, 1);
  // Delivery box in the app's colour (c2: Grab green / Be yellow / Xanh SM teal); the rider's jacket is c1.
  b.box(0.52, 0.48, 0.52, -0.7, 1.13, 0, 0xffffff, { paint: 2 });
  b.box(0.54, 0.08, 0.54, -0.7, 1.2, 0, 0xf2f2ea);
  b.box(0.54, 0.05, 0.54, -0.7, 1.39, 0, 0x2a2c30);
  return b.build();
}

export function parkedScooterGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  scooterBody(b);
  return b.build();
}

export function cycloGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.place(wheel(0.32, 0.08), 0.6, 0.32, 0.52, TIRE, {}, [Math.PI / 2, 0, 0]);
  b.place(wheel(0.32, 0.08), 0.6, 0.32, -0.52, TIRE, {}, [Math.PI / 2, 0, 0]);
  b.place(wheel(0.34, 0.08), -1.0, 0.34, 0, TIRE, {}, [Math.PI / 2, 0, 0]);
  b.box(0.8, 0.48, 0.92, 0.62, 0.78, 0, 0xffffff, { paint: 1 });
  b.box(0.6, 0.12, 0.8, 0.6, 0.98, 0, 0xe8dcc0);
  b.box(0.12, 0.7, 0.92, 0.28, 1.2, 0, 0xffffff, { paint: 1 });
  b.box(0.5, 0.06, 1.0, 0.5, 1.58, 0, 0xffffff, { paint: 1 }, 0, 0, 0.35);
  b.box(1.5, 0.08, 0.1, -0.35, 0.62, 0, 0xffffff, { paint: 2 });
  b.box(0.1, 0.7, 0.1, -0.9, 0.85, 0, 0xffffff, { paint: 2 });
  b.box(0.3, 0.06, 0.92, 1.0, 0.45, 0, 0xffffff, { paint: 2 });
  // Tourist passenger.
  b.box(0.36, 0.5, 0.46, 0.55, 1.28, 0, 0xf2efe6);
  b.place(ball(0.13), 0.58, 1.65, 0, 0xe7c6a4);
  b.place(cone(0.26, 0.12), 0.58, 1.78, 0, 0xf1e3c0);
  // Driver pedalling behind, in a nón lá.
  b.box(0.3, 0.52, 0.4, -0.85, 1.5, 0, 0xcfc3a5, {}, 0, 0, -0.2);
  b.box(0.3, 0.42, 0.3, -0.7, 1.06, 0, 0x4a4f45);
  b.place(ball(0.12), -0.8, 1.88, 0, SKIN);
  b.place(cone(0.3, 0.2), -0.8, 2.03, 0, 0xe9d8a6);
  b.box(0.05, 0.08, 0.14, 1.04, 0.7, 0, 0xfff6e0, HEAD);
  return b.build();
}

function carBase(b: GeoBuilder, roofPaint: number): void {
  for (const x of [1.35, -1.35]) {
    for (const z of [0.82, -0.82]) b.place(wheel(0.34, 0.24), x, 0.34, z, TIRE, {}, [Math.PI / 2, 0, 0]);
  }
  b.box(4.3, 0.6, 1.76, 0, 0.66, 0, 0xffffff, { paint: 1 });
  b.box(1.1, 0.12, 1.7, 1.55, 0.98, 0, 0xffffff, { paint: 1 }, 0, 0, -0.08);
  b.box(2.3, 0.56, 1.62, -0.3, 1.24, 0, GLASS);
  b.box(2.1, 0.08, 1.62, -0.35, 1.54, 0, 0xffffff, { paint: roofPaint });
  b.box(0.14, 0.26, 1.72, 2.16, 0.48, 0, 0x2d2d2d);
  b.box(0.14, 0.26, 1.72, -2.16, 0.48, 0, 0x2d2d2d);
  b.box(0.06, 0.13, 0.36, 2.17, 0.78, 0.6, 0xfff6e0, HEAD);
  b.box(0.06, 0.13, 0.36, 2.17, 0.78, -0.6, 0xfff6e0, HEAD);
  b.box(0.06, 0.12, 0.34, -2.17, 0.84, 0.6, 0x8a1d16, TAIL);
  b.box(0.06, 0.12, 0.34, -2.17, 0.84, -0.6, 0x8a1d16, TAIL);
  b.box(0.12, 0.1, 0.12, 0.7, 1.08, 0.9, 0x2d2d2d);
  b.box(0.12, 0.1, 0.12, 0.7, 1.08, -0.9, 0x2d2d2d);
}

export function carGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  carBase(b, 1);
  return b.build();
}

export function taxiGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  carBase(b, 1);
  b.box(4.32, 0.1, 1.78, 0, 0.82, 0, 0xffffff, { paint: 2 });
  b.box(0.62, 0.22, 0.32, -0.35, 1.68, 0, 0xffffff, { paint: 2, emis: 0xffe3a0, emisStrength: 1.6 });
  return b.build();
}

/**
 * VinFast-style compact EV (VF 5 / VF 3 proportions): short bonnet, tall boxy cabin, full-width LED strips front and rear.
 * Paint slots: `body` for the shell and roof, c2 (paint 2) for the roof lamp / sign.
 */
function evBase(b: GeoBuilder, body: number): void {
  for (const x of [1.28, -1.28]) {
    for (const z of [0.82, -0.82]) {
      b.place(wheel(0.34, 0.24), x, 0.34, z, TIRE, {}, [Math.PI / 2, 0, 0]);
      b.place(wheel(0.18, 0.26), x, 0.34, z, CHROME, {}, [Math.PI / 2, 0, 0]);
    }
  }
  b.box(4.2, 0.6, 1.78, 0, 0.68, 0, 0xffffff, { paint: body });
  b.box(0.9, 0.12, 1.7, 1.5, 1.0, 0, 0xffffff, { paint: body }, 0, 0, -0.07);
  b.box(2.2, 0.66, 1.64, -0.25, 1.3, 0, GLASS);
  b.box(2.05, 0.08, 1.68, -0.3, 1.66, 0, 0xffffff, { paint: body });
  // Black door-pillar band reads as a floating roof from above.
  b.box(2.1, 0.04, 1.2, -0.3, 1.71, 0, 0x1e2327);
  b.box(0.14, 0.26, 1.74, 2.1, 0.46, 0, 0x2d2d2d);
  b.box(0.14, 0.26, 1.74, -2.1, 0.46, 0, 0x2d2d2d);
  b.box(0.05, 0.07, 1.46, 2.12, 0.84, 0, 0xfff6e0, HEAD);
  b.box(0.06, 0.11, 0.3, 2.12, 0.72, 0.7, 0xfff6e0, HEAD);
  b.box(0.06, 0.11, 0.3, 2.12, 0.72, -0.7, 0xfff6e0, HEAD);
  b.box(0.05, 0.07, 1.4, -2.12, 0.86, 0, 0x8a1d16, TAIL);
  b.box(0.12, 0.1, 0.12, 0.65, 1.1, 0.92, 0x2d2d2d);
  b.box(0.12, 0.1, 0.12, 0.65, 1.1, -0.92, 0x2d2d2d);
}

/** Xanh SM: all-teal VinFast EV (c1) with a white roof lamp (c2). */
export function xanhSmGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  evBase(b, 1);
  b.box(0.5, 0.14, 0.3, -0.3, 1.82, 0, 0xffffff, { paint: 2, emis: 0xe8fff8, emisStrength: 1.1 });
  return b.build();
}

/** Grab Car / Be Car: the same compact EV in a private-car colour (c1) with the app's roof sign in brand colour (c2). */
export function hailCarGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  evBase(b, 1);
  b.box(0.62, 0.2, 0.34, -0.3, 1.86, 0, 0xffffff, { paint: 2, emis: 0xf4fff4, emisStrength: 0.9 });
  return b.build();
}

export function busGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  for (const x of [3.5, -3.3]) {
    for (const z of [1.12, -1.12]) b.place(wheel(0.5, 0.32), x, 0.5, z, TIRE, {}, [Math.PI / 2, 0, 0]);
  }
  b.box(10.4, 1.3, 2.5, 0, 1.05, 0, 0xffffff, { paint: 1 });
  b.box(10.42, 0.16, 2.52, 0, 1.45, 0, 0xffffff, { paint: 2 });
  b.box(10.1, 0.95, 2.52, -0.1, 2.16, 0, GLASS, { emis: 0x9a7f4a, emisStrength: 0.9 });
  b.box(10.4, 0.42, 2.5, 0, 2.84, 0, 0xffffff, { paint: 2 });
  b.box(2.4, 0.3, 1.4, -1.5, 3.18, 0, 0xd9d6cc);
  b.box(0.1, 1.15, 2.3, 5.2, 2.08, 0, GLASS);
  b.box(0.08, 0.3, 1.6, 5.23, 2.82, 0, 0x332a16, { emis: 0xffa53a, emisStrength: 2.5 });
  b.box(0.08, 0.16, 0.4, 5.21, 0.72, 0.85, 0xfff6e0, HEAD);
  b.box(0.08, 0.16, 0.4, 5.21, 0.72, -0.85, 0xfff6e0, HEAD);
  b.box(0.08, 0.2, 0.3, -5.21, 0.9, 0.9, 0x8a1d16, TAIL);
  b.box(0.08, 0.2, 0.3, -5.21, 0.9, -0.9, 0x8a1d16, TAIL);
  return b.build();
}

export function truckGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  for (const x of [2.2, -1.5, -2.35]) {
    for (const z of [0.9, -0.9]) b.place(wheel(0.42, 0.28), x, 0.42, z, TIRE, {}, [Math.PI / 2, 0, 0]);
  }
  b.box(6.0, 0.3, 1.8, -0.1, 0.55, 0, 0x2c2c2c);
  b.box(1.7, 1.55, 2.0, 2.15, 1.3, 0, 0xffffff, { paint: 1 });
  b.box(0.06, 0.7, 1.8, 3.01, 1.62, 0, GLASS);
  b.box(4.3, 2.0, 2.1, -0.85, 1.72, 0, 0xffffff, { paint: 2 });
  b.box(4.32, 0.12, 2.12, -0.85, 2.66, 0, 0xd8d2c4);
  b.box(0.06, 0.14, 0.34, 3.02, 0.82, 0.68, 0xfff6e0, HEAD);
  b.box(0.06, 0.14, 0.34, 3.02, 0.82, -0.68, 0xfff6e0, HEAD);
  b.box(0.06, 0.14, 0.3, -3.02, 0.8, 0.8, 0x8a1d16, TAIL);
  b.box(0.06, 0.14, 0.3, -3.02, 0.8, -0.8, 0x8a1d16, TAIL);
  b.box(0.04, 0.06, 0.06, 3.03, 1.2, 0, CHROME);
  return b.build();
}

/** Soft elongated pool of light on the road ahead of a vehicle (local +X), for night. */
export function headlightPoolTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d')!;
  // Elliptical beam that reaches zero alpha well inside the quad, so no edges show.
  g.translate(26, 32);
  g.scale(3.2, 1);
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, 29);
  grd.addColorStop(0, 'rgba(255,240,205,0.9)');
  grd.addColorStop(0.3, 'rgba(255,228,180,0.42)');
  grd.addColorStop(0.7, 'rgba(255,215,160,0.1)');
  grd.addColorStop(1, 'rgba(255,210,150,0)');
  g.fillStyle = grd;
  g.fillRect(-26, -32, 128, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
