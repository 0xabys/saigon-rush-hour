/**
 * Data side of the 2D debug page: loads the generated JSON, the raw Overpass cache and the build report,
 * and derives arms, major axes, raw-way geometry and the OSM-id search index. Dev only.
 */
import type { Anomaly } from '../../scripts/osm/lib/graph';
import type { OsmNode, OsmWay, RawFile } from '../../scripts/osm/lib/types';
import type { LinkJson, NetworkJson, RoadClassName, SceneJson } from '../data/q1Schema';
import { Q1_SCHEMA } from '../data/q1Schema';
import networkText from '../data/q1-network.json?raw';
import sceneText from '../data/q1-scene.json?raw';
import rawText from '../../data/osm/raw-q1.json?raw';
import reportText from '../../data/osm/report.json?raw';

export interface ReportJson {
  builder: string;
  counts: Record<string, number>;
  streets: { count: number; names: string[] };
  fatal: string[];
  anomalyCounts: Record<string, number>;
  anomalies: Anomaly[];
}

export interface Pt {
  x: number;
  z: number;
}

export interface Bbox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface ArmView {
  link: number;
  end: 'a' | 'b';
  /** Heading leaving the node along the link (atan2(dz, dx)). */
  angle: number;
  rank: number;
  inbound: boolean;
  outbound: boolean;
  major: boolean;
  /** Signal phase group (0 = along the major axis); meaningful for any node with ≥ 3 arms. */
  group: 0 | 1;
  /** Point `ARM_LEN` metres along the link from its end (for drawing the stub). */
  tip: Pt;
  start: Pt;
}

export interface RawWayView {
  id: number;
  name: string;
  highway: string;
  pts: number[];
  kept: boolean;
}

export interface RawView {
  nodes: Map<number, { x: number; z: number; tags: Record<string, string> }>;
  ways: RawWayView[];
  fetchedAt: string;
}

export interface SearchHit {
  label: string;
  x: number;
  z: number;
  target: Selection | null;
}

export type Selection =
  | { kind: 'node'; id: number }
  | { kind: 'link'; id: number }
  | { kind: 'rawWay'; id: number }
  | { kind: 'point'; x: number; z: number; label: string; pts?: number[] };

export interface Model {
  net: NetworkJson;
  scene: SceneJson;
  report: ReportJson;
  raw: RawView;
  arms: ArmView[][];
  linkBox: Bbox[];
  /** Links incident to each node (indices into `net.links`). */
  nodeLinks: number[][];
  search: Map<number, SearchHit[]>;
}

export const LANE_W = 3.5;
const ARM_LEN = 15;
const RANK: Record<RoadClassName, number> = { trunk: 0, primary: 1, secondary: 2, tertiary: 3, residential: 4, unclassified: 5 };

function pointAlong(pts: number[], from: 'a' | 'b', dist: number): { start: Pt; tip: Pt; angle: number } {
  const n = pts.length / 2;
  const at = (i: number): Pt => ({ x: pts[2 * i], z: pts[2 * i + 1] });
  const idx = (k: number) => (from === 'a' ? k : n - 1 - k);
  const start = at(idx(0));
  let acc = 0;
  let tip = at(idx(n - 1));
  for (let k = 1; k < n; k++) {
    const p = at(idx(k - 1));
    const q = at(idx(k));
    const seg = Math.hypot(q.x - p.x, q.z - p.z);
    if (acc + seg >= dist && seg > 0) {
      const t = (dist - acc) / seg;
      tip = { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t };
      break;
    }
    acc += seg;
  }
  return { start, tip, angle: Math.atan2(tip.z - start.z, tip.x - start.x) };
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Same rule as scripts/osm/lib/signals.ts (`majorAxis`/`armGroup`) so the page shows what the pipeline assumed. */
function markMajor(arms: ArmView[]): void {
  if (arms.length === 0) return;
  let best: [number, number] | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      if (Math.abs(wrap(arms[i].angle - arms[j].angle - Math.PI)) > (40 * Math.PI) / 180) continue;
      const score = arms[i].rank + arms[j].rank;
      if (score < bestScore) {
        bestScore = score;
        best = [i, j];
      }
    }
  }
  let single = 0;
  for (let i = 1; i < arms.length; i++) if (arms[i].rank < arms[single].rank) single = i;
  let axis: number;
  if (!best || arms[single].rank + 2 <= Math.min(arms[best[0]].rank, arms[best[1]].rank)) {
    arms[single].major = true;
    axis = arms[single].angle;
  } else {
    arms[best[0]].major = true;
    arms[best[1]].major = true;
    const a = arms[best[0]].angle;
    const b = arms[best[1]].angle + Math.PI;
    axis = Math.atan2(Math.sin(a) + Math.sin(b), Math.cos(a) + Math.cos(b));
  }
  for (const arm of arms) {
    const x = (((arm.angle - axis + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI;
    arm.group = Math.abs(x - Math.PI / 2) < Math.PI / 4 ? 0 : 1;
  }
}

function polyBox(pts: number[]): Bbox {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < pts.length; i += 2) {
    b.minX = Math.min(b.minX, pts[i]);
    b.maxX = Math.max(b.maxX, pts[i]);
    b.minZ = Math.min(b.minZ, pts[i + 1]);
    b.maxZ = Math.max(b.maxZ, pts[i + 1]);
  }
  return b;
}

function parseRaw(text: string, net: NetworkJson, keptWays: Set<number>): RawView {
  const raw = JSON.parse(text) as RawFile;
  const { lat0, lon0, kx, kz } = net.projection;
  const nodes = new Map<number, { x: number; z: number; tags: Record<string, string> }>();
  const wayEls: OsmWay[] = [];
  for (const e of raw.osm.elements) {
    if (e.type === 'node') {
      const n: OsmNode = e;
      nodes.set(n.id, { x: (n.lon - lon0) * kx, z: -(n.lat - lat0) * kz, tags: n.tags ?? {} });
    } else if (e.type === 'way' && e.nodes && e.tags?.highway) wayEls.push(e);
  }
  const ways: RawWayView[] = [];
  for (const w of wayEls) {
    const pts: number[] = [];
    for (const id of w.nodes ?? []) {
      const p = nodes.get(id);
      if (p) pts.push(p.x, p.z);
    }
    if (pts.length >= 4) ways.push({ id: w.id, name: w.tags?.name ?? '', highway: w.tags?.highway ?? '', pts, kept: keptWays.has(w.id) });
  }
  return { nodes, ways, fetchedAt: raw.meta.fetchedAt };
}

function addHit(map: Map<number, SearchHit[]>, id: number, hit: SearchHit): void {
  const list = map.get(id);
  if (list) list.push(hit);
  else map.set(id, [hit]);
}

function centroidOf(pts: number[]): Pt {
  let x = 0;
  let z = 0;
  const n = pts.length / 2;
  for (let i = 0; i < pts.length; i += 2) {
    x += pts[i];
    z += pts[i + 1];
  }
  return { x: x / n, z: z / n };
}

/** Selection for a Google Open Buildings footprint (negative id, `conf` = model confidence); `pts` lets the renderer outline it. */
export function gobSelection(g: { id: number; conf: number; pts: number[] }): Selection {
  const c = centroidOf(g.pts);
  return { kind: 'point', x: c.x, z: c.z, label: `Google Open Buildings ${g.id} · conf ${g.conf.toFixed(2)}`, pts: g.pts };
}

export function loadModel(): Model {
  const net = JSON.parse(networkText) as NetworkJson;
  const scene = JSON.parse(sceneText) as SceneJson;
  const report = JSON.parse(reportText) as ReportJson;
  if (net.schema !== Q1_SCHEMA || scene.schema !== Q1_SCHEMA) throw new Error(`Unsupported schema ${net.schema}/${scene.schema}, expected ${Q1_SCHEMA}`);

  const nodeLinks: number[][] = net.nodes.map(() => []);
  for (const l of net.links) {
    nodeLinks[l.a].push(l.id);
    nodeLinks[l.b].push(l.id);
  }
  const arms: ArmView[][] = net.nodes.map((_, id) => {
    const list: ArmView[] = nodeLinks[id].flatMap((lid): ArmView[] => {
      const l: LinkJson = net.links[lid];
      const ends: ('a' | 'b')[] = [];
      if (l.a === id) ends.push('a');
      if (l.b === id) ends.push('b');
      return ends.map(end => {
        const g = pointAlong(l.pts, end, ARM_LEN);
        return {
          link: lid,
          end,
          angle: g.angle,
          rank: RANK[l.cls] + (l.isLink ? 0.5 : 0),
          inbound: end === 'a' ? l.lanesB > 0 : l.lanesF > 0,
          outbound: end === 'a' ? l.lanesF > 0 : l.lanesB > 0,
          major: false,
          group: 0,
          tip: g.tip,
          start: g.start,
        };
      });
    });
    list.sort((p, q) => p.angle - q.angle || p.link - q.link);
    if (list.length >= 3) markMajor(list);
    return list;
  });

  const kept = new Set<number>();
  for (const l of net.links) for (const w of l.osm) kept.add(w);
  for (const r of net.rings) for (const w of r.osm) kept.add(w);
  const raw = parseRaw(rawText, net, kept);
  const linkBox = net.links.map(l => polyBox(l.pts));

  const search = new Map<number, SearchHit[]>();
  for (const n of net.nodes) {
    for (const id of n.osm) addHit(search, id, { label: `nút ${n.id} · ${n.name}`, x: n.x, z: n.z, target: { kind: 'node', id: n.id } });
  }
  for (const l of net.links) {
    const mid = centroidOf(l.pts);
    for (const id of l.osm) addHit(search, id, { label: `liên kết ${l.id} · ${l.name || 'không tên'}`, x: mid.x, z: mid.z, target: { kind: 'link', id: l.id } });
  }
  for (const r of net.rings) {
    for (const id of r.osm) addHit(search, id, { label: `vòng xoay ${r.id}`, x: r.cx, z: r.cz, target: { kind: 'node', id: r.node } });
  }
  net.busStops.forEach(b => {
    const l = net.links[b.link];
    const mid = centroidOf(l.pts);
    addHit(search, b.osm, { label: `trạm buýt ${b.name || ''}`.trim(), x: mid.x, z: mid.z, target: { kind: 'link', id: b.link } });
  });
  const polyHit = (id: number, what: string, name: string, pts: number[]) => {
    const c = centroidOf(pts);
    addHit(search, id, { label: `${what}${name ? ` · ${name}` : ''}`, x: c.x, z: c.z, target: { kind: 'point', x: c.x, z: c.z, label: `${what} ${id}` } });
  };
  for (const b of scene.buildings) polyHit(b.osm, 'toà nhà', b.name, b.pts);
  for (const w of scene.water) polyHit(w.osm, 'mặt nước', w.name, w.pts);
  for (const p of scene.parks) polyHit(p.osm, 'công viên', p.name, p.pts);
  for (const g of scene.gobBuildings) {
    const c = centroidOf(g.pts);
    addHit(search, g.id, { label: `toà nhà Google Open Buildings · conf ${g.conf.toFixed(2)}`, x: c.x, z: c.z, target: gobSelection(g) });
  }
  for (const lm of scene.landmarks) polyHit(lm.osm, 'địa danh', lm.name, lm.pts);
  for (const w of raw.ways) {
    const c = centroidOf(w.pts);
    addHit(search, w.id, { label: `way OSM ${w.highway}${w.name ? ` · ${w.name}` : ''}${w.kept ? '' : ' (bị loại/cắt)'}`, x: c.x, z: c.z, target: { kind: 'rawWay', id: w.id } });
  }
  for (const [id, p] of raw.nodes) {
    if (Object.keys(p.tags).length) addHit(search, id, { label: `node OSM ${p.tags.highway ?? p.tags.name ?? ''}`.trim(), x: p.x, z: p.z, target: { kind: 'point', x: p.x, z: p.z, label: `node ${id}` } });
  }
  return { net, scene, report, raw, arms, linkBox, nodeLinks, search };
}
