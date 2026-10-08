/** Edge graph (design §3.3–3.4): types, degree/terminal classification and chain walking. */
import type { WayInfo } from './filter';
import type { P2 } from './types';

export type Side = 'N' | 'S' | 'E' | 'W';

/** One straight piece of a kept way, oriented along the way's node order. */
export interface Edge {
  id: number;
  u: number;
  v: number;
  way: WayInfo;
  len: number;
  /** Lanes u→v and v→u (`lB = 0` for one-way). */
  lF: number;
  lB: number;
  alive: boolean;
}

export interface Graph {
  /** Projected positions of every node used by an edge. Portals have negative ids. */
  pos: Map<number, P2>;
  portals: Map<number, Side>;
  edges: Edge[];
}

export interface Anomaly {
  kind: string;
  severity: 'info' | 'warn';
  message: string;
  osm: number[];
  x: number;
  z: number;
}

/** Shared sink for counters, anomalies and fatal conditions. */
export class Diag {
  readonly stats: Record<string, number> = {};
  readonly anomalies: Anomaly[] = [];
  readonly fatal: string[] = [];

  count(key: string, n = 1): void {
    this.stats[key] = (this.stats[key] ?? 0) + n;
  }

  add(kind: string, severity: Anomaly['severity'], message: string, osm: number[], at: P2): void {
    this.anomalies.push({ kind, severity, message, osm: [...osm].sort((a, b) => a - b), x: at.x, z: at.z });
  }
}

/** Position of a node known to be in the graph. */
export function posOf(g: Graph, n: number): P2 {
  const p = g.pos.get(n);
  if (!p) throw new Error(`node ${n} has no position`);
  return p;
}

/** Distance along a link used to read an arm's heading. */
export const ARM_PROBE = 15;

/** Heading from `pts[0]` toward the point ARM_PROBE metres along the polyline, atan2(dz, dx). */
export function headingAlong(pts: P2[]): number {
  const p0 = pts[0];
  let acc = 0;
  let target = pts[pts.length - 1];
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (acc + seg >= ARM_PROBE) {
      const t = (ARM_PROBE - acc) / seg;
      target = { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t };
      break;
    }
    acc += seg;
  }
  return Math.atan2(target.z - p0.z, target.x - p0.x);
}

export interface ArmDir {
  /** Heading leaving the node along the arm. */
  angle: number;
  inbound: boolean;
  outbound: boolean;
}

const HAIRPIN = (150 * Math.PI) / 180;

/**
 * Inbound arms none of whose exits turns by ≤ 150° (the sim builds no connector beyond that, so it forces the link to a
 * dead end). Includes arms without any exit at all.
 */
export function stuckArms<T extends ArmDir>(arms: T[]): T[] {
  return arms.filter(a => a.inbound && arms.every(o => o === a || !o.outbound || Math.abs(Math.atan2(Math.sin(o.angle - a.angle - Math.PI), Math.cos(o.angle - a.angle - Math.PI))) > HAIRPIN));
}

export type TermKind = 'J' | 'join' | 'dead' | 'portal' | 'ring' | 'pass';

export function otherEnd(e: Edge, n: number): number {
  return e.u === n ? e.v : e.u;
}

/** Lanes flowing toward / away from node `n` along edge `e`. */
export function lanesToward(e: Edge, n: number): number {
  return e.v === n ? e.lF : e.lB;
}

export function lanesAway(e: Edge, n: number): number {
  return e.v === n ? e.lB : e.lF;
}

/** Two edges meeting at a degree-2 node continue the same road (same lanes, class, bridge, flow). */
export function continues(a: Edge, b: Edge, n: number): boolean {
  return (
    lanesToward(a, n) === lanesAway(b, n) &&
    lanesAway(a, n) === lanesToward(b, n) &&
    a.way.cls === b.way.cls &&
    a.way.isLink === b.way.isLink &&
    a.way.bridge === b.way.bridge
  );
}

/** Both one-way edges point into (or both out of) the node. */
export function flips(a: Edge, b: Edge, n: number): boolean {
  const ta = lanesToward(a, n);
  const tb = lanesToward(b, n);
  const aa = lanesAway(a, n);
  const ab = lanesAway(b, n);
  return (aa === 0 && ab === 0 && ta > 0 && tb > 0) || (ta === 0 && tb === 0 && aa > 0 && ab > 0);
}

export interface Topo {
  edges: Edge[];
  /** Node → incident alive edge ids, ascending. */
  adj: Map<number, number[]>;
  kind: Map<number, TermKind>;
  /** Degree-2 nodes where one-way flow reverses (cluster candidates). */
  flip: Set<number>;
}

/** `ringNodes`: OSM nodes belonging to a valid ring; they never cluster and terminate chains. */
export function buildTopo(g: Graph, ringNodes: Map<number, number>): Topo {
  const adj = new Map<number, number[]>();
  for (const e of g.edges) {
    if (!e.alive) continue;
    for (const n of [e.u, e.v]) {
      const list = adj.get(n);
      if (list) list.push(e.id);
      else adj.set(n, [e.id]);
    }
  }
  const kind = new Map<number, TermKind>();
  const flip = new Set<number>();
  for (const [n, list] of adj) {
    if (ringNodes.has(n)) kind.set(n, 'ring');
    else if (g.portals.has(n)) kind.set(n, 'portal');
    else if (list.length === 1) kind.set(n, 'dead');
    else if (list.length >= 3) kind.set(n, 'J');
    else {
      const a = g.edges[list[0]];
      const b = g.edges[list[1]];
      if (flips(a, b, n)) {
        kind.set(n, 'J');
        flip.add(n);
      } else kind.set(n, continues(a, b, n) ? 'pass' : 'join');
    }
  }
  // Ring nodes without any outside arm still need a kind.
  for (const n of ringNodes.keys()) if (!kind.has(n)) kind.set(n, 'ring');
  return { edges: g.edges, adj, kind, flip };
}

export interface Chain {
  /** Node ids from the start terminal to the end terminal. */
  nodes: number[];
  edges: number[];
  len: number;
}

/** Follow `first` from terminal `start` through degree-2 pass-through nodes to the next terminal. */
export function walkChain(topo: Topo, start: number, first: number): Chain {
  const nodes = [start];
  const edges = [first];
  let len = topo.edges[first].len;
  let cur = otherEnd(topo.edges[first], start);
  let prev = first;
  nodes.push(cur);
  while (topo.kind.get(cur) === 'pass') {
    const [a, b] = topo.adj.get(cur) as number[];
    prev = a === prev ? b : a;
    const e = topo.edges[prev];
    edges.push(prev);
    len += e.len;
    cur = otherEnd(e, cur);
    nodes.push(cur);
  }
  return { nodes, edges, len };
}
