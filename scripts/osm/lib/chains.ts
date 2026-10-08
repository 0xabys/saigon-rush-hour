/** Design §3.6: chain merging into links, node kinds from arm counts, and the pruning/forced-merge rules. */
import type { RoadClassName } from '../../../src/data/q1Schema';
import type { ClusterResult } from './cluster';
import type { Diag, Graph, Topo } from './graph';
import { lanesAway, lanesToward, posOf, walkChain } from './graph';
import type { RingDraft } from './rings';
import type { P2 } from './types';

export const D_DEAD_STUB = 15;
export const D_PORTAL_STUB = 25;
export const MIN_TRIMMED = 6;
/** Half a lane (m) and clearance used to estimate sim trims. */
const LANE_HALF = 1.75;

export type NodeKind = 'junction' | 'join' | 'portal' | 'dead' | 'ring';

export interface LinkDraft {
  a: number;
  b: number;
  /** Graph node at each end of `pts` (an OSM node or a portal). */
  aNode: number;
  bNode: number;
  pts: P2[];
  /** Graph nodes along `pts`. */
  nodes: number[];
  edges: number[];
  lanesF: number;
  lanesB: number;
  cls: RoadClassName;
  isLink: boolean;
  name: string;
  nameEn: string;
  maxspeed: number | null;
  bridge: boolean;
  median: number;
  length: number;
  osm: number[];
}

export interface NodeDraft {
  key: number;
  kind: NodeKind;
  x: number;
  z: number;
  radius: number;
  osm: number[];
  /** Ring index for ring nodes. */
  ring?: number;
}

export interface ArmRef {
  link: number;
  end: 'a' | 'b';
}

export interface Solved {
  links: LinkDraft[];
  nodes: Map<number, NodeDraft>;
  arms: Map<number, ArmRef[]>;
  /** OSM nodes on chains that stayed inside one cluster → that cluster's key (signal lookup). */
  internal: Map<number, number>;
  orphanEdges: number;
}

export function roadHalf(l: LinkDraft): number {
  return (l.lanesF + l.lanesB) * LANE_HALF + l.median / 2;
}

/** Does the link carry traffic into (`in`) / out of (`out`) the node at the given end? */
export function flow(l: LinkDraft, end: 'a' | 'b'): { in: boolean; out: boolean } {
  return end === 'a' ? { in: l.lanesB > 0, out: l.lanesF > 0 } : { in: l.lanesF > 0, out: l.lanesB > 0 };
}

/** Weighted-majority pick: highest total weight, ties broken by the smaller key. */
function majority<T extends string | number>(weights: Map<T, number>): T | null {
  let best: T | null = null;
  let bw = -1;
  for (const [k, w] of weights) {
    if (w > bw + 1e-9 || (Math.abs(w - bw) <= 1e-9 && best !== null && k < best)) {
      best = k;
      bw = w;
    }
  }
  return best;
}

export function solve(
  g: Graph,
  topo: Topo,
  cl: ClusterResult,
  rings: RingDraft[],
  ringNodes: Map<number, number>,
  diag: Diag,
): Solved {
  const keyOf = (n: number): number => {
    const rep = cl.rep.get(n);
    if (rep !== undefined) return rep;
    if (topo.kind.get(n) === 'ring') return rings[ringNodes.get(n) as number].key;
    return n;
  };
  const terminals = [...topo.kind].filter(([, k]) => k !== 'pass').map(([n]) => n).sort((a, b) => a - b);
  const used = new Set<number>();
  const links: LinkDraft[] = [];
  const internal = new Map<number, number>();
  for (const t of terminals) {
    for (const eid of topo.adj.get(t) ?? []) {
      if (used.has(eid)) continue;
      let chain = walkChain(topo, t, eid);
      for (const id of chain.edges) used.add(id);
      const kStart = keyOf(chain.nodes[0]);
      const kEnd = keyOf(chain.nodes[chain.nodes.length - 1]);
      if (kStart === kEnd) {
        for (const n of chain.nodes) internal.set(n, kStart);
        if (chain.len > 60) {
          const e0 = g.edges[chain.edges[0]];
          diag.add('loop-link', 'warn', `Road loops back to the same junction (${chain.len.toFixed(0)} m); dropped`, [e0.way.id], posOf(g, t));
        }
        continue;
      }
      const e0 = g.edges[chain.edges[0]];
      // A one-way chain is stored in flow direction.
      if (e0.lB === 0 && e0.u !== chain.nodes[0]) {
        chain = { nodes: [...chain.nodes].reverse(), edges: [...chain.edges].reverse(), len: chain.len };
      }
      const first = g.edges[chain.edges[0]];
      const start = chain.nodes[0];
      const end = chain.nodes[chain.nodes.length - 1];
      const lanesF = lanesAway(first, start);
      const lanesB = lanesToward(first, start);
      const nameW = new Map<string, number>();
      const speedW = new Map<number, number>();
      const osm = new Set<number>();
      for (const id of chain.edges) {
        const e = g.edges[id];
        osm.add(e.way.id);
        if (e.way.name) nameW.set(e.way.name, (nameW.get(e.way.name) ?? 0) + e.len);
        if (e.way.maxspeed !== null) speedW.set(e.way.maxspeed, (speedW.get(e.way.maxspeed) ?? 0) + e.len);
      }
      const name = majority(nameW) ?? '';
      let nameEn = '';
      for (const id of chain.edges) {
        const e = g.edges[id];
        if (e.way.name === name && e.way.nameEn) {
          nameEn = e.way.nameEn;
          break;
        }
      }
      links.push({
        a: keyOf(start),
        b: keyOf(end),
        aNode: start,
        bNode: end,
        pts: chain.nodes.map(n => posOf(g, n)),
        nodes: chain.nodes,
        edges: chain.edges,
        lanesF,
        lanesB,
        cls: first.way.cls,
        isLink: first.way.isLink,
        name,
        nameEn,
        maxspeed: majority(speedW),
        bridge: first.way.bridge,
        median: lanesB > 0 ? 0.4 : 0,
        length: chain.len,
        osm: [...osm].sort((x, y) => x - y),
      });
    }
  }
  let orphanEdges = 0;
  for (const e of g.edges) if (e.alive && !used.has(e.id)) orphanEdges++;

  const arms = new Map<number, ArmRef[]>();
  const addArm = (key: number, ref: ArmRef) => {
    const list = arms.get(key);
    if (list) list.push(ref);
    else arms.set(key, [ref]);
  };
  links.forEach((l, i) => {
    addArm(l.a, { link: i, end: 'a' });
    addArm(l.b, { link: i, end: 'b' });
  });

  const nodes = new Map<number, NodeDraft>();
  for (const t of terminals) {
    const key = keyOf(t);
    if (nodes.has(key)) continue;
    const k = topo.kind.get(t);
    if (k === 'ring') {
      const ri = ringNodes.get(t) as number;
      const r = rings[ri];
      nodes.set(key, { key, kind: 'ring', x: r.cx, z: r.cz, radius: r.r, osm: [...r.nodes].sort((a, b) => a - b), ring: ri });
    } else if (cl.rep.has(t)) {
      const c = cl.clusters.get(key);
      if (!c) throw new Error(`cluster node ${t} has no cluster`);
      nodes.set(key, { key, kind: 'junction', x: c.cx, z: c.cz, radius: c.radius, osm: c.members });
    } else {
      const p = posOf(g, t);
      nodes.set(key, { key, kind: k === 'portal' ? 'portal' : k === 'dead' ? 'dead' : 'join', x: p.x, z: p.z, radius: 0, osm: t > 0 ? [t] : [] });
    }
  }
  // Kinds from arm structure.
  for (const [key, node] of nodes) {
    if (node.kind === 'ring' || node.kind === 'portal') continue;
    const list = arms.get(key) ?? [];
    if (list.length < 2) {
      node.kind = 'dead';
      continue;
    }
    node.kind = list.length === 2 ? 'join' : 'junction';
    const outs = list.filter(r => flow(links[r.link], r.end).out);
    // Pure sink (no arm can leave) or pure source (no arm can enter) → terminal. Partial cases stay junctions;
    // the sim ends such links itself and the report lists them as `arm-no-exit`.
    const inbound = list.filter(r => flow(links[r.link], r.end).in);
    const sink = inbound.every(r => !outs.some(o => o.link !== r.link || o.end !== r.end));
    if (sink) node.kind = 'dead';
  }
  return { links, nodes, arms, internal, orphanEdges };
}

/** Estimated sim trim (m) of `link` at its `end` (the sim trims by the widest other arm + 2.5 m). */
export function trimAt(s: Solved, linkIdx: number, end: 'a' | 'b'): number {
  const l = s.links[linkIdx];
  const key = end === 'a' ? l.a : l.b;
  const node = s.nodes.get(key);
  if (!node || node.kind === 'portal' || node.kind === 'dead') return 0;
  if (node.kind === 'ring') return 7.5;
  let w = 0;
  for (const r of s.arms.get(key) ?? []) if (r.link !== linkIdx || r.end !== end) w = Math.max(w, roadHalf(s.links[r.link]));
  return w + 2.5;
}

/** Links between two different junction/join clusters that the sim would trim away (< MIN_TRIMMED m left). */
export function shortLinks(s: Solved): { link: number; a: number; b: number; left: number }[] {
  const out: { link: number; a: number; b: number; left: number }[] = [];
  s.links.forEach((l, i) => {
    const na = s.nodes.get(l.a);
    const nb = s.nodes.get(l.b);
    if ((na?.kind !== 'junction' && na?.kind !== 'join') || (nb?.kind !== 'junction' && nb?.kind !== 'join')) return;
    const left = l.length - trimAt(s, i, 'a') - trimAt(s, i, 'b');
    if (left < MIN_TRIMMED) out.push({ link: i, a: l.a, b: l.b, left });
  });
  return out;
}

/** Edge ids to delete: short dead-end stubs and portal stubs that hug a junction. */
export function pruneEdges(s: Solved): { edges: number[]; deadStubs: number; portalStubs: number } {
  const kill = new Set<number>();
  let deadStubs = 0;
  let portalStubs = 0;
  s.links.forEach(l => {
    const na = s.nodes.get(l.a);
    const nb = s.nodes.get(l.b);
    if (!na || !nb) return;
    const dead = (n: NodeDraft, key: number) => n.kind === 'dead' && (s.arms.get(key) ?? []).length === 1;
    if ((dead(na, l.a) || dead(nb, l.b)) && l.length < D_DEAD_STUB) {
      for (const id of l.edges) kill.add(id);
      deadStubs++;
      return;
    }
    const portalEnd = na.kind === 'portal' ? na : nb.kind === 'portal' ? nb : null;
    const other = portalEnd === na ? nb : na;
    if (portalEnd && other.kind !== 'portal' && other.kind !== 'dead' && l.length - other.radius < D_PORTAL_STUB) {
      for (const id of l.edges) kill.add(id);
      portalStubs++;
    }
  });
  return { edges: [...kill].sort((a, b) => a - b), deadStubs, portalStubs };
}
