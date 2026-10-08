/** Design §3.13: buildings, water, parks and landmark footprints in local metres. */
import type { LandmarkKey, SceneJson } from '../../../src/data/q1Schema';
import type { Diag } from './graph';
import { BOUNDS, insideBounds, project } from './project';
import { shoelace } from './rings';
import type { LatLon, OsmElement, OsmRelation, OsmWay, P2, Tags } from './types';

/** OSM way ids of the hand-modelled landmarks (found via the landmark candidate query). */
export const LANDMARKS: Record<LandmarkKey, number> = {
  benThanh: 39514795, // Chợ Bến Thành
  ubnd: 341504305, // Trụ sở UBND Thành phố Hồ Chí Minh
  bitexco: 804073951, // Bitexco Financial Tower
  cafeApt: 187895174, // chung cư 42 Nguyễn Huệ
  notreDame: 801950766, // Nhà thờ Đức Bà Sài Gòn (building=church, 1 Công trường Công xã Paris)
  postOffice: 39514793, // Bưu điện Trung tâm Sài Gòn (2 Công trường Công xã Paris)
  opera: 801710792, // Nhà hát Thành phố (7 Công trường Lam Sơn)
  palace: 39598493, // Dinh Độc Lập (135 Nam Kỳ Khởi Nghĩa)
};

/** Landmarks that were already hand-modelled when q1-network.json was frozen (see `buildScene`). Do not add to it: its building count feeds the frozen network stats. */
const FROZEN_LANDMARKS: Partial<Record<LandmarkKey, true>> = { benThanh: true, ubnd: true, bitexco: true, cafeApt: true };

const PARK_LEISURE: Record<string, true> = { park: true, garden: true, playground: true, common: true, recreation_ground: true };
const PARK_LANDUSE: Record<string, true> = { grass: true, recreation_ground: true, village_green: true };

type Geom = (LatLon | null)[];

interface Poly {
  outer: P2[];
  holes: P2[][];
}

const same = (a: LatLon, b: LatLon) => a.lat === b.lat && a.lon === b.lon;

/** Join open way pieces end-to-end into closed rings; returns [closed rings, leftover open pieces]. */
function assemble(pieces: LatLon[][]): { closed: LatLon[][]; open: LatLon[][] } {
  const left = pieces.filter(p => p.length >= 2).map(p => [...p]);
  const closed: LatLon[][] = [];
  const open: LatLon[][] = [];
  while (left.length) {
    let cur = left.shift() as LatLon[];
    while (!same(cur[0], cur[cur.length - 1])) {
      const tail = cur[cur.length - 1];
      const i = left.findIndex(p => same(p[0], tail) || same(p[p.length - 1], tail));
      if (i < 0) break;
      const [p] = left.splice(i, 1);
      cur = cur.concat(same(p[0], tail) ? p.slice(1) : [...p].reverse().slice(1));
    }
    if (cur.length >= 4 && same(cur[0], cur[cur.length - 1])) closed.push(cur);
    else open.push(cur);
  }
  return { closed, open };
}

function toPoints(ring: LatLon[]): P2[] {
  const out: P2[] = [];
  for (const ll of ring) {
    const p = project(ll);
    const q = { x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 };
    const prev = out[out.length - 1];
    if (!prev || prev.x !== q.x || prev.z !== q.z) out.push(q);
  }
  if (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].z === out[out.length - 1].z) out.pop();
  return out;
}

function pointInPoly(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Polygons (outer + holes) of a way or multipolygon relation; `unclosed` counts pieces that did not close. */
function polygonsOf(e: OsmWay | OsmRelation): { polys: Poly[]; unclosed: number } {
  const geomOf = (g: Geom | undefined): LatLon[] => (g ?? []).filter((p): p is LatLon => p !== null);
  if (e.type === 'way') {
    const g = geomOf(e.geometry);
    const { closed, open } = assemble([g]);
    return { polys: closed.map(c => ({ outer: toPoints(c), holes: [] })), unclosed: open.length };
  }
  const outer = assemble((e.members ?? []).filter(m => m.type === 'way' && m.role !== 'inner').map(m => geomOf(m.geometry)));
  const inner = assemble((e.members ?? []).filter(m => m.type === 'way' && m.role === 'inner').map(m => geomOf(m.geometry)));
  const outers = outer.closed.map(toPoints).filter(p => p.length >= 3);
  const polys: Poly[] = outers.map(o => ({ outer: o, holes: [] }));
  for (const h of inner.closed.map(toPoints).filter(p => p.length >= 3)) {
    const owner = polys.find(p => pointInPoly(h[0], p.outer));
    if (owner) owner.holes.push(h);
  }
  return { polys, unclosed: outer.open.length + inner.open.length };
}

/** Sutherland–Hodgman against the bbox rectangle. */
function clipToBounds(poly: P2[]): P2[] {
  const edges: { inside: (p: P2) => boolean; cut: (a: P2, b: P2) => P2 }[] = [
    { inside: p => p.x >= BOUNDS.minX, cut: (a, b) => ({ x: BOUNDS.minX, z: a.z + ((b.z - a.z) * (BOUNDS.minX - a.x)) / (b.x - a.x) }) },
    { inside: p => p.x <= BOUNDS.maxX, cut: (a, b) => ({ x: BOUNDS.maxX, z: a.z + ((b.z - a.z) * (BOUNDS.maxX - a.x)) / (b.x - a.x) }) },
    { inside: p => p.z >= BOUNDS.minZ, cut: (a, b) => ({ z: BOUNDS.minZ, x: a.x + ((b.x - a.x) * (BOUNDS.minZ - a.z)) / (b.z - a.z) }) },
    { inside: p => p.z <= BOUNDS.maxZ, cut: (a, b) => ({ z: BOUNDS.maxZ, x: a.x + ((b.x - a.x) * (BOUNDS.maxZ - a.z)) / (b.z - a.z) }) },
  ];
  let out = poly;
  for (const edge of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (edge.inside(cur)) {
        if (!edge.inside(prev)) out.push(edge.cut(prev, cur));
        out.push(cur);
      } else if (edge.inside(prev)) out.push(edge.cut(prev, cur));
    }
    if (out.length === 0) break;
  }
  const rounded = out.map(p => ({ x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 }));
  return rounded.filter((p, i) => i === 0 || p.x !== rounded[i - 1].x || p.z !== rounded[i - 1].z);
}

function centroid(pts: P2[]): P2 {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const f = p.x * q.z - q.x * p.z;
    a += f;
    cx += (p.x + q.x) * f;
    cz += (p.z + q.z) * f;
  }
  if (Math.abs(a) < 1e-9) return { x: pts[0].x, z: pts[0].z };
  return { x: cx / (3 * a), z: cz / (3 * a) };
}

/** Minimum-area oriented bounding box via the convex hull: centre and heading (rad) of the long side. */
function orientedBox(pts: P2[]): { cx: number; cz: number; rot: number } {
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (o: P2, a: P2, b: P2) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const half = (list: P2[]) => {
    const h: P2[] = [];
    for (const p of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  const hull = half(sorted).concat(half([...sorted].reverse()));
  let best = { area: Infinity, cx: 0, cz: 0, rot: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const th = Math.atan2(b.z - a.z, b.x - a.x);
    const c = Math.cos(th);
    const s = Math.sin(th);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of hull) {
      const u = p.x * c + p.z * s;
      const v = -p.x * s + p.z * c;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best.area - 1e-9) {
      const um = (u0 + u1) / 2;
      const vm = (v0 + v1) / 2;
      let rot = (u1 - u0) >= (v1 - v0) ? th : th + Math.PI / 2;
      rot = Math.atan2(Math.sin(rot), Math.cos(rot));
      if (rot > Math.PI / 2) rot -= Math.PI;
      else if (rot <= -Math.PI / 2) rot += Math.PI;
      best = { area, cx: um * c - vm * s, cz: um * s + vm * c, rot };
    }
  }
  return { cx: best.cx, cz: best.cz, rot: best.rot };
}

const flat = (pts: P2[]) => pts.flatMap(p => [p.x, p.z]);

export type SceneBody = Omit<SceneJson, 'schema' | 'source' | 'extraSource' | 'gobSource' | 'gobBuildings'>;

const SITE_LANDUSE: Record<string, SceneBody['sites'][number]['kind']> = { construction: 'construction', brownfield: 'brownfield' };

/** Outer ring clipped to the bbox with positive shoelace area, holes clipped with negative; null when nothing usable is left. */
function clippedPoly(poly: Poly, minArea: number): { pts: number[]; holes: number[][] } | null {
  const outer = clipToBounds(poly.outer);
  if (outer.length < 3 || Math.abs(shoelace(outer)) / 2 < minArea) return null;
  const holes = poly.holes.map(clipToBounds).filter(h => h.length >= 3 && Math.abs(shoelace(h)) / 2 >= 0.25);
  return {
    pts: flat(shoelace(outer) > 0 ? outer : [...outer].reverse()),
    holes: holes.map(h => flat(shoelace(h) < 0 ? h : [...h].reverse())),
  };
}

/** `extra` carries the scene-only features (construction land, squares); its ways never reach the road network. */
export function buildScene(elements: OsmElement[], extra: OsmElement[], diag: Diag): SceneBody {
  const byId = new Map<string, OsmWay | OsmRelation>();
  for (const e of elements) if (e.type !== 'node') byId.set(`${e.type}/${e.id}`, e);
  const shapes = elements.filter((e): e is OsmWay | OsmRelation => e.type !== 'node').sort((a, b) => a.id - b.id || (a.type < b.type ? -1 : 1));
  const landmarkIds = new Set<number>(Object.values(LANDMARKS));

  const buildings: SceneBody['buildings'] = [];
  const water: SceneBody['water'] = [];
  const parks: SceneBody['parks'] = [];
  for (const e of shapes) {
    const tags: Tags = e.tags ?? {};
    if (tags.building && !landmarkIds.has(e.id)) {
      const { polys } = polygonsOf(e);
      for (const poly of polys) {
        const area = Math.abs(shoelace(poly.outer)) / 2;
        if (poly.outer.length < 3 || area < 1) {
          diag.count('buildingsTooSmall');
          continue;
        }
        if (!insideBounds(centroid(poly.outer))) {
          diag.count('buildingsOutside');
          continue;
        }
        const lv = Number.parseInt(tags['building:levels'] ?? '', 10);
        const h = Number.parseFloat((tags.height ?? '').replace(',', '.'));
        buildings.push({
          osm: e.id,
          pts: flat(shoelace(poly.outer) > 0 ? poly.outer : [...poly.outer].reverse()),
          holes: poly.holes.map(hole => flat(shoelace(hole) < 0 ? hole : [...hole].reverse())),
          levels: lv > 0 ? lv : null,
          height: Number.isFinite(h) && h > 0 ? Math.round(h * 10) / 10 : null,
          name: (tags.name ?? '').normalize('NFC'),
          kind: tags.building,
        });
      }
    }
    if (tags.natural === 'water' || tags.waterway === 'riverbank') {
      const { polys, unclosed } = polygonsOf(e);
      if (unclosed) {
        diag.count('waterUnclosed', unclosed);
        diag.add('water-unclosed', 'warn', `Water ${e.type} ${e.id} has ${unclosed} piece(s) that do not close; skipped`, [e.id], { x: 0, z: 0 });
      }
      for (const poly of polys) {
        const outer = clipToBounds(poly.outer);
        if (outer.length < 3 || Math.abs(shoelace(outer)) / 2 < 1) continue;
        const holes = poly.holes.map(clipToBounds).filter(h => h.length >= 3 && Math.abs(shoelace(h)) / 2 >= 0.25);
        water.push({
          osm: e.id,
          name: (tags.name ?? '').normalize('NFC'),
          pts: flat(shoelace(outer) > 0 ? outer : [...outer].reverse()),
          holes: holes.map(h => flat(shoelace(h) < 0 ? h : [...h].reverse())),
        });
      }
    }
    if (PARK_LEISURE[tags.leisure ?? ''] || PARK_LANDUSE[tags.landuse ?? '']) {
      for (const poly of polygonsOf(e).polys) {
        const outer = clipToBounds(poly.outer);
        if (outer.length < 3 || Math.abs(shoelace(outer)) / 2 < 25) continue;
        parks.push({ osm: e.id, name: (tags.name ?? '').normalize('NFC'), pts: flat(shoelace(outer) > 0 ? outer : [...outer].reverse()) });
      }
    }
  }

  const sites: SceneBody['sites'] = [];
  const plazas: SceneBody['plazas'] = [];
  const extraShapes = extra.filter((e): e is OsmWay | OsmRelation => e.type !== 'node').sort((a, b) => a.id - b.id || (a.type < b.type ? -1 : 1));
  for (const e of extraShapes) {
    const tags: Tags = e.tags ?? {};
    const kind = SITE_LANDUSE[tags.landuse ?? ''];
    const plaza = tags.place === 'square' || (tags.highway === 'pedestrian' && tags.area === 'yes');
    if (!kind && !plaza) continue;
    for (const poly of polygonsOf(e).polys) {
      const clipped = clippedPoly(poly, 25);
      if (!clipped) continue;
      const name = (tags.name ?? '').normalize('NFC');
      if (kind) sites.push({ osm: e.id, name, kind, ...clipped });
      else plazas.push({ osm: e.id, name, ...clipped });
    }
  }

  const landmarks: SceneBody['landmarks'] = [];
  for (const key of Object.keys(LANDMARKS).sort() as LandmarkKey[]) {
    const id = LANDMARKS[key];
    const e = byId.get(`way/${id}`) ?? byId.get(`relation/${id}`);
    const poly = e ? polygonsOf(e).polys[0] : undefined;
    if (!e || !poly || poly.outer.length < 3) {
      diag.fatal.push(`landmark ${key} (OSM ${id}) is missing from the raw cache`);
      continue;
    }
    const box = orientedBox(poly.outer);
    landmarks.push({
      key,
      osm: id,
      name: ((e.tags ?? {}).name ?? '').normalize('NFC'),
      cx: Math.round(box.cx * 100) / 100,
      cz: Math.round(box.cz * 100) / 100,
      rot: Math.round(box.rot * 1000) / 1000,
      pts: flat(shoelace(poly.outer) > 0 ? poly.outer : [...poly.outer].reverse()),
    });
  }
  // `net.stats` is part of q1-network.json, which the sim treats as frozen, and its `buildings` counter was taken when only the
  // FROZEN_LANDMARKS were hand-modelled: every landmark promoted since still counted as a generic building there. Count the
  // polygons those footprints yield under the very same filter as the building loop above (tag, area ≥ 1 m², centroid in the
  // bbox), so a promoted landmark with no `building` tag or a split multipolygon cannot silently shift the frozen number.
  // FROZEN_LANDMARKS must never grow: that would change q1-network.json (`osm:check` fails if it does).
  let promoted = 0;
  for (const key of Object.keys(LANDMARKS) as LandmarkKey[]) {
    if (FROZEN_LANDMARKS[key]) continue;
    const e = byId.get(`way/${LANDMARKS[key]}`) ?? byId.get(`relation/${LANDMARKS[key]}`);
    if (!e?.tags?.building) continue;
    for (const poly of polygonsOf(e).polys) {
      if (poly.outer.length >= 3 && Math.abs(shoelace(poly.outer)) / 2 >= 1 && insideBounds(centroid(poly.outer))) promoted++;
    }
  }
  diag.count('buildings', buildings.length + promoted);
  diag.count('water', water.length);
  diag.count('parks', parks.length);
  return { buildings, water, parks, sites, plazas, landmarks };
}
