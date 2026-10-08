/**
 * Design §3.10: Google Open Buildings footprints that survive confidence/size filters, a constant shift onto OSM, and
 * three overlap tests (OSM buildings, open land, road corridors) become `SceneJson.gobBuildings`.
 * Pure: the only inputs are the gob cache, the already built OSM scene body and the road network. Counters go to the
 * returned `counts` (→ report.json), never through `Diag.count`, because those end up in q1-network.json.
 */
import type { NetworkJson, SceneJson } from '../../../src/data/q1Schema';
import { BOUNDS, project } from './project';
import { shoelace } from './rings';
import type { SceneBody } from './scene';
import type { GobFile, P2 } from './types';

export const MIN_CONF = 0.7;
/** Planar m² after projection. */
export const MIN_AREA = 20;
/** Open Buildings sits ≈ +2.4 m east / −0.3 m south of OSM (median of 123 matched pairs); move it onto the OSM roads. */
export const SHIFT_X = -2.4;
export const SHIFT_Z = 0.3;
/** Mirror of `LANE_W` in src/sim/network.ts (the app module is not importable from the build). */
const LANE_W = 3.5;
const ROAD_MARGIN = 1;
/** Drop a footprint when at least this share of its cells is covered by OSM buildings / open land / road corridor. */
const FRAC_OSM = 0.3;
const FRAC_LAND = 0.3;
const FRAC_ROAD = 0.25;

const OSM_BIT = 1;
const LAND_BIT = 2;
const ROAD_BIT = 4;

export interface FootprintCounts {
  rows: number;
  kept: number;
  areaHa: number;
  dropped: { lowConf: number; small: number; outside: number; dupOsm: number; onLand: number; onRoad: number };
}

interface Grid {
  w: number;
  h: number;
  cells: Uint8Array;
}

/** Even-odd scanline over the 1 m cell centres of the rings; `visit` gets the cell index. */
function scan(g: Grid, rings: number[][], visit: (cell: number) => void): void {
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const r of rings) {
    for (let i = 1; i < r.length; i += 2) {
      if (r[i] < z0) z0 = r[i];
      if (r[i] > z1) z1 = r[i];
    }
  }
  const xs: number[] = [];
  const j0 = Math.max(0, Math.floor(z0 - BOUNDS.minZ - 0.5));
  const j1 = Math.min(g.h - 1, Math.ceil(z1 - BOUNDS.minZ - 0.5));
  for (let j = j0; j <= j1; j++) {
    const zc = BOUNDS.minZ + j + 0.5;
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
      const i0 = Math.max(0, Math.ceil(xs[k] - BOUNDS.minX - 0.5));
      const i1 = Math.min(g.w - 1, Math.ceil(xs[k + 1] - BOUNDS.minX - 0.5) - 1);
      for (let i = i0; i <= i1; i++) visit(j * g.w + i);
    }
  }
}

/**
 * Marks `bit` on the cells whose centre lies inside the rings. No outline pass: footprints are tested with the same
 * centre-sampling, and an outline halo would count every cell on an OSM edge as covered (≈ 60 more footprints dropped as duplicates).
 */
function mark(g: Grid, rings: number[][], bit: number): void {
  scan(g, rings, c => {
    g.cells[c] |= bit;
  });
}

/** Marks the cells whose centre lies within `r` of the segment a–b. */
function markSegment(g: Grid, ax: number, az: number, bx: number, bz: number, r: number): void {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz || 1e-9;
  const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - BOUNDS.minX));
  const i1 = Math.min(g.w - 1, Math.ceil(Math.max(ax, bx) + r - BOUNDS.minX));
  const j0 = Math.max(0, Math.floor(Math.min(az, bz) - r - BOUNDS.minZ));
  const j1 = Math.min(g.h - 1, Math.ceil(Math.max(az, bz) + r - BOUNDS.minZ));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const px = BOUNDS.minX + i + 0.5;
      const pz = BOUNDS.minZ + j + 0.5;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
      if (Math.hypot(px - ax - dx * t, pz - az - dz * t) <= r) g.cells[j * g.w + i] |= ROAD_BIT;
    }
  }
}

/** Marks the cells whose centre is within `r` of (cx, cz) (`half` null) or within `half` of the circle of radius `r` (roundabout carriageway). */
function markDisc(g: Grid, cx: number, cz: number, r: number, half: number | null): void {
  const reach = r + (half ?? 0);
  const i0 = Math.max(0, Math.floor(cx - reach - BOUNDS.minX));
  const i1 = Math.min(g.w - 1, Math.ceil(cx + reach - BOUNDS.minX));
  const j0 = Math.max(0, Math.floor(cz - reach - BOUNDS.minZ));
  const j1 = Math.min(g.h - 1, Math.ceil(cz + reach - BOUNDS.minZ));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(BOUNDS.minX + i + 0.5 - cx, BOUNDS.minZ + j + 0.5 - cz);
      if (half === null ? d <= r : Math.abs(d - r) <= half) g.cells[j * g.w + i] |= ROAD_BIT;
    }
  }
}

/** Raster of what blocks a footprint: OSM buildings + landmarks, open land (water, parks, sites, plazas) and the road corridor. */
function blockers(body: SceneBody, net: NetworkJson): Grid {
  const w = Math.ceil(BOUNDS.maxX - BOUNDS.minX) + 1;
  const h = Math.ceil(BOUNDS.maxZ - BOUNDS.minZ) + 1;
  const g: Grid = { w, h, cells: new Uint8Array(w * h) };
  for (const b of body.buildings) mark(g, [b.pts], OSM_BIT);
  for (const l of body.landmarks) mark(g, [l.pts], OSM_BIT);
  for (const wt of body.water) mark(g, [wt.pts, ...wt.holes], LAND_BIT);
  for (const p of body.parks) mark(g, [p.pts], LAND_BIT);
  for (const s of body.sites) mark(g, [s.pts, ...s.holes], LAND_BIT);
  for (const p of body.plazas) mark(g, [p.pts, ...p.holes], LAND_BIT);

  const half = new Map<number, number>();
  for (const l of net.links) {
    const hw = ((l.lanesF + l.lanesB) * LANE_W) / 2 + l.median / 2;
    for (const end of [l.a, l.b]) half.set(end, Math.max(half.get(end) ?? 0, hw));
    for (let i = 0; i + 3 < l.pts.length; i += 2) markSegment(g, l.pts[i], l.pts[i + 1], l.pts[i + 2], l.pts[i + 3], hw + ROAD_MARGIN);
  }
  for (const r of net.rings) markDisc(g, r.cx, r.cz, r.r, (Math.max(1, r.lanes) * LANE_W) / 2 + ROAD_MARGIN);
  for (const n of net.nodes) {
    if (n.kind === 'junction' || n.kind === 'join') markDisc(g, n.x, n.z, n.radius + (half.get(n.id) ?? 0) + ROAD_MARGIN, null);
  }
  return g;
}

/** Applies the design §3.10 rules in cache order; the order of `list` is the order of the cache rows. */
export function buildFootprints(gob: GobFile, body: SceneBody, net: NetworkJson): { list: SceneJson['gobBuildings']; counts: FootprintCounts } {
  const grid = blockers(body, net);
  const dropped = { lowConf: 0, small: 0, outside: 0, dupOsm: 0, onLand: 0, onRoad: 0 };
  const list: SceneJson['gobBuildings'] = [];
  let area = 0;
  for (const row of gob.rows) {
    if (row.conf < MIN_CONF) {
      dropped.lowConf++;
      continue;
    }
    const ring: P2[] = [];
    for (let i = 0; i < row.ring.length; i += 2) {
      const p = project({ lat: row.ring[i + 1], lon: row.ring[i] });
      const q = { x: Math.round((p.x + SHIFT_X) * 100) / 100, z: Math.round((p.z + SHIFT_Z) * 100) / 100 };
      const prev = ring[ring.length - 1];
      if (!prev || prev.x !== q.x || prev.z !== q.z) ring.push(q);
    }
    if (ring.length > 1 && ring[0].x === ring[ring.length - 1].x && ring[0].z === ring[ring.length - 1].z) ring.pop();
    const twice = ring.length >= 3 ? shoelace(ring) : 0;
    if (Math.abs(twice) / 2 < MIN_AREA) {
      dropped.small++;
      continue;
    }
    const pts = (twice > 0 ? ring : [...ring].reverse()).flatMap(p => [p.x, p.z]);
    let n = 0;
    let osm = 0;
    let land = 0;
    let road = 0;
    scan(grid, [pts], c => {
      n++;
      const v = grid.cells[c];
      if (v & OSM_BIT) osm++;
      if (v & LAND_BIT) land++;
      if (v & ROAD_BIT) road++;
    });
    // A valid footprint whose cells all fall outside the raster (nothing to test it against): counted apart from `small`.
    if (n === 0) dropped.outside++;
    else if (osm / n >= FRAC_OSM) dropped.dupOsm++;
    else if (land / n >= FRAC_LAND) dropped.onLand++;
    else if (road / n >= FRAC_ROAD) dropped.onRoad++;
    else {
      list.push({ id: -row.id, conf: row.conf, pts });
      area += Math.abs(twice) / 2;
    }
  }
  return { list, counts: { rows: gob.rows.length, kept: list.length, areaHa: Math.round(area / 100) / 100, dropped } };
}
