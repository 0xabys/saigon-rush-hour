import { RIVER, RING_CENTER, RING_OUTER, ROAD_HALF, SIDEWALK, WORLD, type Network } from '../sim/network';

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Hand-placed sites that procedural buildings must leave alone. */
export const SITES = {
  plaza: { x0: -13, x1: 13, z0: -59, z1: 59 } as Rect,
  market: { x0: -180, x1: -144, z0: -98, z1: -38 } as Rect,
  committee: { x0: -27, x1: 27, z0: -114, z1: -84 } as Rect,
  bitexco: { x0: 66, x1: 98, z0: 92, z1: 128 } as Rect,
  cafeApartment: { x0: -29, x1: -14, z0: -30, z1: -8 } as Rect,
  riverPark: { x0: 123, x1: RIVER.x1 + 8, z0: WORLD.minZ, z1: WORLD.maxZ } as Rect,
  landmark81: { x0: 228, x1: 262, z0: -146, z1: -108 } as Rect,
};

export const inRect = (r: Rect, x: number, z: number, m = 0) => x > r.x0 - m && x < r.x1 + m && z > r.z0 - m && z < r.z1 + m;

export class Zoning {
  private readonly segs: number[] = [];
  readonly occ: Uint8Array;
  private readonly w: number;

  constructor(net: Network) {
    for (const r of net.roads) this.segs.push(r.a.x, r.a.z, r.b.x, r.b.z);
    this.w = WORLD.maxX - WORLD.minX;
    this.occ = new Uint8Array(this.w * (WORLD.maxZ - WORLD.minZ));
  }

  /** Distance from (x,z) to the nearest road centreline. */
  roadDist(x: number, z: number): number {
    let best = Infinity;
    const s = this.segs;
    for (let i = 0; i < s.length; i += 4) {
      const ax = s[i];
      const az = s[i + 1];
      const dx = s[i + 2] - ax;
      const dz = s[i + 3] - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
      if (d < best) best = d;
    }
    const ring = Math.hypot(x - RING_CENTER.x, z - RING_CENTER.z) - RING_OUTER + ROAD_HALF;
    return Math.min(best, ring);
  }

  /** True if a point may hold a building. */
  buildable(x: number, z: number, ignoreSite?: Rect): boolean {
    if (x < WORLD.minX + 1.5 || x > WORLD.maxX - 1.5 || z < WORLD.minZ + 1.5 || z > WORLD.maxZ - 1.5) return false;
    for (const site of Object.values(SITES)) if (site !== ignoreSite && inRect(site, x, z, 1)) return false;
    if (Math.hypot(x - RING_CENTER.x, z - RING_CENTER.z) < RING_OUTER + SIDEWALK + 3) return false;
    if (this.roadDist(x, z) < ROAD_HALF + SIDEWALK + 0.3) return false;
    const i = Math.floor(z - WORLD.minZ) * this.w + Math.floor(x - WORLD.minX);
    return this.occ[i] === 0;
  }

  /** Samples an oriented rectangle (centre, unit axis u for width, v for depth). */
  rectFree(cx: number, cz: number, ux: number, uz: number, hw: number, hd: number, ignoreSite?: Rect): boolean {
    const vx = -uz;
    const vz = ux;
    for (let a = -hw; a <= hw + 1e-6; a += Math.max(0.8, hw / 3)) {
      for (let b = -hd; b <= hd + 1e-6; b += Math.max(0.8, hd / 6)) {
        if (!this.buildable(cx + ux * a + vx * b, cz + uz * a + vz * b, ignoreSite)) return false;
      }
    }
    return true;
  }

  stamp(cx: number, cz: number, ux: number, uz: number, hw: number, hd: number, margin = 0.6): void {
    const vx = -uz;
    const vz = ux;
    const W = hw + margin;
    const D = hd + margin;
    for (let a = -W; a <= W; a += 0.5) {
      for (let b = -D; b <= D; b += 0.5) {
        const x = Math.floor(cx + ux * a + vx * b - WORLD.minX);
        const z = Math.floor(cz + uz * a + vz * b - WORLD.minZ);
        if (x >= 0 && z >= 0 && x < this.w && z < WORLD.maxZ - WORLD.minZ) this.occ[z * this.w + x] = 1;
      }
    }
  }
}
