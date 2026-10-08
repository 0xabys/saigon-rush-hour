import type { SceneJson } from '../data/q1Schema';
import { resolveGround } from '../data/sceneOverrides';
import { SegKind, type Network } from '../sim/network';

/** Sidewalk width beside every carriageway (metres). Shared by ground, vegetation and buildings. */
export const SIDEWALK = 3.2;

/** Occupancy codes stored in `Zoning.occ`. */
export const OCC_FREE = 0;
export const OCC_BUILT = 1;
export const OCC_WATER = 2;
/** Building site (landuse=construction|brownfield): nothing grows or parks here. */
export const OCC_SITE = 3;
/** Open plaza (place=square, pedestrian area): no houses, but street trees may stand on it. */
export const OCC_PLAZA = 4;

/** Even-odd point-in-polygon test for a flat `[x0, z0, x1, z1, …]` ring. */
export function pointInPolygon(pts: ArrayLike<number>, x: number, z: number): boolean {
  let inside = false;
  const n = pts.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const zi = pts[i + 1];
    const zj = pts[j + 1];
    if (zi > z !== zj > z && x < ((pts[j] - pts[i]) * (z - zi)) / (zj - zi) + pts[i]) inside = !inside;
  }
  return inside;
}

/** Grid cell (m) of the road-surface lookup. */
const CELL = 8;
/** Samples of the road-surface lookup are taken every `PIECE` metres of arc length. */
const PIECE = 2;
/** Clearance is only resolved up to this distance from the asphalt edge. */
const FAR = 8;

/**
 * Land-use queries shared by the renderers. Everything is derived from the simulated road network and
 * the OSM scene, so nothing that grows (trees, lamps, houses) lands on asphalt, footprints or water.
 */
export class Zoning {
  /** 1 m occupancy raster over `net.bounds`: `OCC_FREE`, `OCC_BUILT` (footprints incl. Open Buildings, landmarks, stamps), `OCC_WATER`, `OCC_SITE` or `OCC_PLAZA`. */
  readonly occ: Uint8Array;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly w: number;
  private readonly h: number;
  private readonly rings: { cx: number; cz: number; r: number }[];

  // Road-surface pieces (2 m chords of every segment) bucketed into an 8 m grid (CSR layout).
  private readonly pAx: Float32Array;
  private readonly pAz: Float32Array;
  private readonly pBx: Float32Array;
  private readonly pBz: Float32Array;
  /** Extent of the asphalt to the left / right of the chord. */
  private readonly pHl: Float32Array;
  private readonly pHr: Float32Array;
  private readonly gw: number;
  private readonly gh: number;
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;

  constructor(net: Network, scene: SceneJson) {
    const b = net.bounds;
    this.minX = b.minX;
    this.minZ = b.minZ;
    this.w = Math.ceil(b.maxX - b.minX) + 1;
    this.h = Math.ceil(b.maxZ - b.minZ) + 1;
    this.occ = new Uint8Array(this.w * this.h);
    this.rings = net.rings.map((r) => ({ cx: r.cx, cz: r.cz, r: r.r + r.halfW }));

    const ground = resolveGround(scene);
    // Open Buildings first: plazas, sites and water below overwrite them, so open ground wins over a satellite footprint.
    for (const g of scene.gobBuildings) this.fillPolygon([g.pts], OCC_BUILT);
    for (const p of ground.plazas) this.fillPolygon([p.pts, ...p.holes], OCC_PLAZA);
    for (const s of ground.sites) this.fillPolygon([s.pts, ...s.holes], OCC_SITE);
    for (const w of scene.water) this.fillPolygon([w.pts, ...w.holes], OCC_WATER);
    for (const bd of scene.buildings) this.fillPolygon([bd.pts], OCC_BUILT);
    for (const lm of scene.landmarks) this.fillPolygon([lm.pts], OCC_BUILT);

    // ---- road surface pieces
    const ax: number[] = [];
    const az: number[] = [];
    const bx: number[] = [];
    const bz: number[] = [];
    const hl: number[] = [];
    const hr: number[] = [];
    const stride = Math.max(1, Math.round(PIECE / 0.5));
    for (const seg of net.segments) {
      const link = seg.kind === SegKind.Link;
      const pad = seg.kind === SegKind.Conn ? 0.4 : 0;
      const left = seg.halfW + pad + (link && !seg.oneway ? seg.median / 2 : 0);
      const right = seg.halfW + pad;
      let prev = 0;
      for (let i = stride; ; i += stride) {
        const cur = Math.min(i, seg.n - 1);
        if (cur > prev) {
          ax.push(seg.px[prev]);
          az.push(seg.pz[prev]);
          bx.push(seg.px[cur]);
          bz.push(seg.pz[cur]);
          hl.push(left);
          hr.push(right);
        }
        if (cur >= seg.n - 1) break;
        prev = cur;
      }
    }
    const n = ax.length;
    this.pAx = Float32Array.from(ax);
    this.pAz = Float32Array.from(az);
    this.pBx = Float32Array.from(bx);
    this.pBz = Float32Array.from(bz);
    this.pHl = Float32Array.from(hl);
    this.pHr = Float32Array.from(hr);
    this.gw = Math.ceil((b.maxX - b.minX) / CELL) + 1;
    this.gh = Math.ceil((b.maxZ - b.minZ) / CELL) + 1;
    const cellOf = new Int32Array(n);
    this.cellStart = new Int32Array(this.gw * this.gh + 1);
    for (let k = 0; k < n; k++) {
      const c = this.cellIndex((ax[k] + bx[k]) / 2, (az[k] + bz[k]) / 2);
      cellOf[k] = c;
      this.cellStart[c + 1]++;
    }
    for (let c = 0; c < this.gw * this.gh; c++) this.cellStart[c + 1] += this.cellStart[c];
    const fill = this.cellStart.slice(0, this.gw * this.gh);
    this.cellItems = new Int32Array(n);
    for (let k = 0; k < n; k++) this.cellItems[fill[cellOf[k]]++] = k;
  }

  private cellIndex(x: number, z: number): number {
    const cx = Math.min(this.gw - 1, Math.max(0, Math.floor((x - this.minX) / CELL)));
    const cz = Math.min(this.gh - 1, Math.max(0, Math.floor((z - this.minZ) / CELL)));
    return cz * this.gw + cx;
  }

  /** Even-odd scanline fill of the rings (outer + holes) into the raster, including the outline cells. */
  private fillPolygon(rings: number[][], value: number): void {
    const { minX, minZ, w, h, occ } = this;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const r of rings) {
      for (let i = 1; i < r.length; i += 2) {
        if (r[i] < z0) z0 = r[i];
        if (r[i] > z1) z1 = r[i];
      }
    }
    const xs: number[] = [];
    const j0 = Math.max(0, Math.floor(z0 - minZ - 0.5));
    const j1 = Math.min(h - 1, Math.ceil(z1 - minZ - 0.5));
    for (let j = j0; j <= j1; j++) {
      const zc = minZ + j + 0.5;
      xs.length = 0;
      for (const r of rings) {
        const n = r.length;
        for (let i = 0, k = n - 2; i < n; k = i, i += 2) {
          const za = r[k + 1];
          const zb = r[i + 1];
          if (za > zc === zb > zc) continue;
          xs.push(r[k] + ((zc - za) * (r[i] - r[k])) / (zb - za));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(xs[k] - minX - 0.5));
        const i1 = Math.min(w - 1, Math.ceil(xs[k + 1] - minX - 0.5) - 1);
        for (let i = i0; i <= i1; i++) occ[j * w + i] = value;
      }
    }
    // Outline: narrow slivers fall between cell centres, so walk the edges too.
    for (const r of rings) {
      const n = r.length;
      for (let i = 0, k = n - 2; i < n; k = i, i += 2) {
        const dx = r[i] - r[k];
        const dz = r[i + 1] - r[k + 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.5));
        for (let s = 0; s <= steps; s++) {
          const ci = Math.floor(r[k] + (dx * s) / steps - minX);
          const cj = Math.floor(r[k + 1] + (dz * s) / steps - minZ);
          if (ci >= 0 && cj >= 0 && ci < w && cj < h) occ[cj * w + ci] = value;
        }
      }
    }
  }

  private occAt(x: number, z: number): number {
    const i = Math.floor(x - this.minX);
    const j = Math.floor(z - this.minZ);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return OCC_BUILT;
    return this.occ[j * this.w + i];
  }

  /** Occupancy code (`OCC_*`) of the cell holding (x, z); `OCC_BUILT` outside the raster. */
  occupancy(x: number, z: number): number {
    return this.occAt(x, z);
  }

  isWater(x: number, z: number): boolean {
    return this.occAt(x, z) === OCC_WATER;
  }

  /**
   * Clearance (metres) from (x, z) to the nearest asphalt edge; negative on the road. Links count their own
   * carriageway plus half the median; connectors and ring arcs their full width. Saturates at 8 m.
   */
  roadDist(x: number, z: number): number {
    const cx = Math.floor((x - this.minX) / CELL);
    const cz = Math.floor((z - this.minZ) / CELL);
    let best = FAR;
    for (let j = Math.max(0, cz - 2); j <= Math.min(this.gh - 1, cz + 2); j++) {
      for (let i = Math.max(0, cx - 2); i <= Math.min(this.gw - 1, cx + 2); i++) {
        const c = j * this.gw + i;
        for (let q = this.cellStart[c]; q < this.cellStart[c + 1]; q++) {
          const k = this.cellItems[q];
          const ax = this.pAx[k];
          const az = this.pAz[k];
          const dx = this.pBx[k] - ax;
          const dz = this.pBz[k] - az;
          const len2 = dx * dx + dz * dz || 1e-9;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
          const ox = x - ax - dx * t;
          const oz = z - az - dz * t;
          // Right of travel is (−dz, dx).
          const side = -ox * dz + oz * dx;
          const d = Math.hypot(ox, oz) - (side >= 0 ? this.pHr[k] : this.pHl[k]);
          if (d < best) best = d;
        }
      }
    }
    return best;
  }

  private inRing(x: number, z: number, margin: number): boolean {
    for (const r of this.rings) if (Math.hypot(x - r.cx, z - r.cz) < r.r + margin) return true;
    return false;
  }

  private inBounds(x: number, z: number, m: number): boolean {
    return x >= this.minX + m && x <= this.minX + this.w - 1 - m && z >= this.minZ + m && z <= this.minZ + this.h - 1 - m;
  }

  /** True if a point may hold a building: off asphalt and sidewalk, outside footprints, water and roundabouts. */
  buildable(x: number, z: number): boolean {
    if (!this.inBounds(x, z, 1.5) || this.occAt(x, z) !== OCC_FREE) return false;
    if (this.inRing(x, z, SIDEWALK + 3)) return false;
    return this.roadDist(x, z) >= SIDEWALK + 0.3;
  }

  /** True if a street tree or lamp may stand here: sidewalk and plaza are fine, asphalt (within `margin` m), footprints, sites, water and roundabouts are not. */
  treeFree(x: number, z: number, margin = 0.6): boolean {
    const o = this.occAt(x, z);
    if (!this.inBounds(x, z, 1) || (o !== OCC_FREE && o !== OCC_PLAZA)) return false;
    if (this.inRing(x, z, margin)) return false;
    return this.roadDist(x, z) >= margin;
  }

  /** Samples an oriented rectangle (centre, unit axis u for width, v for depth). */
  rectFree(cx: number, cz: number, ux: number, uz: number, hw: number, hd: number): boolean {
    const vx = -uz;
    const vz = ux;
    for (let a = -hw; a <= hw + 1e-6; a += Math.max(0.8, hw / 3)) {
      for (let b = -hd; b <= hd + 1e-6; b += Math.max(0.8, hd / 6)) {
        if (!this.buildable(cx + ux * a + vx * b, cz + uz * a + vz * b)) return false;
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
        const x = Math.floor(cx + ux * a + vx * b - this.minX);
        const z = Math.floor(cz + uz * a + vz * b - this.minZ);
        if (x >= 0 && z >= 0 && x < this.w && z < this.h && this.occ[z * this.w + x] === OCC_FREE) this.occ[z * this.w + x] = OCC_BUILT;
      }
    }
  }
}
