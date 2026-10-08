/** Design §3.11–3.12 + output: stable ids, node names, bus stops, rings and the rounded JSON objects. */
import type { LinkJson, NetworkJson, NodeJson, RingJson } from '../../../src/data/q1Schema';
import type { NodeDraft, Solved } from './chains';
import type { Graph } from './graph';
import type { RingDraft } from './rings';
import { CLASS_RANK } from './signals';
import { simplify } from './simplify';
import type { OsmNode, P2 } from './types';

export const r2 = (v: number): number => Math.round(v * 100) / 100;

const flatPts = (pts: P2[]): number[] => pts.flatMap(p => [r2(p.x), r2(p.z)]);

function polylineLength(pts: number[]): number {
  let s = 0;
  for (let i = 2; i < pts.length; i += 2) s += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return s;
}

/** Street names on the node's arms, most important first (class rank, then total length). */
function streetNames(s: Solved, key: number): string[] {
  const byName = new Map<string, { rank: number; len: number }>();
  for (const r of s.arms.get(key) ?? []) {
    const l = s.links[r.link];
    if (!l.name) continue;
    const rank = CLASS_RANK[l.cls] + (l.isLink ? 0.5 : 0);
    const cur = byName.get(l.name);
    if (cur) {
      cur.rank = Math.min(cur.rank, rank);
      cur.len += l.length;
    } else byName.set(l.name, { rank, len: l.length });
  }
  return [...byName].sort((a, b) => a[1].rank - b[1].rank || b[1].len - a[1].len || (a[0] < b[0] ? -1 : 1)).map(([n]) => n);
}

export interface Emitted {
  network: NetworkJson;
}

export interface BusStopInput {
  node: OsmNode;
  at: P2;
}

export function emitNetwork(args: {
  g: Graph;
  solved: Solved;

  rings: RingDraft[];
  signalKeys: Set<number>;
  busStops: BusStopInput[];
  base: Omit<NetworkJson, 'nodes' | 'links' | 'rings' | 'busStops' | 'stats'>;
}): Emitted & { busUnmatched: BusStopInput[] } {
  const { g, solved: s, rings, signalKeys } = args;

  // Stable node order: smallest member OSM id first, portals (no OSM id) last by position.
  const drafts = [...s.nodes.values()].sort((a, b) => {
    const ma = a.osm.length ? Math.min(...a.osm) : Infinity;
    const mb = b.osm.length ? Math.min(...b.osm) : Infinity;
    if (ma !== mb) return ma < mb ? -1 : 1;
    return a.x - b.x || a.z - b.z;
  });
  const nodeId = new Map<number, number>(drafts.map((n, i) => [n.key, i]));


  const nodes: NodeJson[] = drafts.map((n: NodeDraft, id) => {
    const names = streetNames(s, n.key);
    const main = names[0] ?? '';
    let name: string;
    if (n.kind === 'portal') name = main ? `Cửa ngõ ${main}` : `Cửa ngõ #${id}`;
    else if (n.kind === 'dead') name = main ? `Cuối đường ${main}` : `Cuối đường #${id}`;
    else if (n.kind === 'ring') {
      const rn = n.ring === undefined ? '' : rings[n.ring].name;
      name = rn ? `Vòng xoay ${rn}` : main ? `Vòng xoay ${main}` : `Vòng xoay #${id}`;
    } else name = names.length >= 2 ? `Giao lộ ${names[0]} – ${names[1]}` : main ? `Nút ${main}` : `Giao lộ #${id}`;
    const j: NodeJson = {
      id,
      kind: n.kind,
      x: r2(n.x),
      z: r2(n.z),
      radius: r2(n.radius),
      osm: n.osm,
      signal: n.kind === 'junction' && signalKeys.has(n.key),
      name,
    };
    if (n.kind === 'portal') j.side = g.portals.get(n.key);
    if (n.kind === 'ring' && n.ring !== undefined) j.ring = n.ring;
    return j;
  });

  // Links: simplify, round, sort by end ids.
  interface Prepared {
    src: number;
    a: number;
    b: number;
    pts: number[];
  }
  const prepared: Prepared[] = s.links.map((l, i) => ({
    src: i,
    a: nodeId.get(l.a) as number,
    b: nodeId.get(l.b) as number,
    pts: flatPts(simplify(l.pts)),
  }));
  prepared.sort((x, y) => {
    const lx = s.links[x.src];
    const ly = s.links[y.src];
    return x.a - y.a || x.b - y.b || lx.osm[0] - ly.osm[0] || lx.length - ly.length || x.pts[0] - y.pts[0] || x.pts[1] - y.pts[1];
  });
  const linkIdOfSrc = new Map<number, number>(prepared.map((p, id) => [p.src, id]));
  const links: LinkJson[] = prepared.map((p, id) => {
    const l = s.links[p.src];
    return {
      id,
      a: p.a,
      b: p.b,
      pts: p.pts,
      lanesF: l.lanesF,
      lanesB: l.lanesB,
      cls: l.cls,
      isLink: l.isLink,
      name: l.name,
      nameEn: l.nameEn,
      maxspeed: l.maxspeed,
      bridge: l.bridge,
      median: l.median,
      length: r2(polylineLength(p.pts)),
      osm: l.osm,
    };
  });

  // Rings with their arms.
  const ringJson: RingJson[] = rings.map((r, i) => {
    const arms: RingJson['arms'] = [];
    for (const ref of s.arms.get(r.key) ?? []) {
      const l = s.links[ref.link];
      const vertex = ref.end === 'a' ? l.aNode : l.bNode;
      arms.push({ at: r.nodes.indexOf(vertex), link: linkIdOfSrc.get(ref.link) as number, dir: ref.end === 'a' ? 0 : 1 });
    }
    arms.sort((x, y) => x.at - y.at || x.link - y.link);
    return {
      id: i,
      node: nodeId.get(r.key) as number,
      cx: r2(r.cx),
      cz: r2(r.cz),
      r: r2(r.r),
      pts: flatPts(r.pts),
      lanes: r.lanes,
      arms,
      name: r.name,
      osm: r.osm,
    };
  });

  // Bus stops: nearest link within 25 m, direction with the stop on the right.
  const busStops: NetworkJson['busStops'] = [];
  const busUnmatched: BusStopInput[] = [];
  for (const b of args.busStops) {
    let best: { link: number; d: number; s: number; side: number } | null = null;
    for (const l of links) {
      let acc = 0;
      for (let i = 2; i < l.pts.length; i += 2) {
        const ax = l.pts[i - 2];
        const az = l.pts[i - 1];
        const dx = l.pts[i] - ax;
        const dz = l.pts[i + 1] - az;
        const len = Math.hypot(dx, dz);
        const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((b.at.x - ax) * dx + (b.at.z - az) * dz) / len ** 2));
        const d = Math.hypot(b.at.x - (ax + t * dx), b.at.z - (az + t * dz));
        if (!best || d < best.d - 1e-9) best = { link: l.id, d, s: acc + t * len, side: dx * (b.at.z - az) - dz * (b.at.x - ax) };
        acc += len;
      }
    }
    if (!best || best.d > 25) {
      busUnmatched.push(b);
      continue;
    }
    const l = links[best.link];
    const dir: 0 | 1 = l.lanesB > 0 && best.side < 0 ? 1 : 0;
    busStops.push({ link: best.link, dir, s: r2(dir === 0 ? best.s : l.length - best.s), name: (b.node.tags?.name ?? '').normalize('NFC'), osm: b.node.id });
  }
  // Same stop drawn twice on one link/direction within 10 m → keep the first.
  busStops.sort((x, y) => x.link - y.link || x.dir - y.dir || x.s - y.s || x.osm - y.osm);
  const dedup = busStops.filter((st, i) => {
    const p = busStops[i - 1];
    return !(p && p.link === st.link && p.dir === st.dir && st.s - p.s < 10);
  });

  const network: NetworkJson = {
    ...args.base,
    nodes,
    links,
    rings: ringJson,
    busStops: dedup,
    stats: {},
  };
  return { network, busUnmatched };
}
