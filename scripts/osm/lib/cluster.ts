/** Design §3.5: single-linkage clustering of junction nodes with a diagonal cap. */
import type { ArmDir, Diag, Graph, Topo } from './graph';
import { headingAlong, lanesAway, lanesToward, posOf, stuckArms, walkChain } from './graph';

export const D_EDGE = 20;
/** Chain between two terminals of which at least one is a `join` (lane/class change point): absorbed into the cluster. */
export const D_JOIN = 15;
export const D_LINKWAY = 45;
export const D_NEAR = 8;
export const D_MAX = 60;
export const D_HARD = 80;

export interface Cluster {
  /** Smallest member node id. */
  key: number;
  members: number[];
  cx: number;
  cz: number;
  radius: number;
  diag: number;
}

export interface ClusterResult {
  /** Junction/join node → cluster key. Other nodes are absent. */
  rep: Map<number, number>;
  clusters: Map<number, Cluster>;
}

/** Pair of cluster keys (smallest member node ids) to merge, with the diagonal cap that applies. */
export interface ForcedMerge {
  a: number;
  b: number;
  cap: number;
  /** Refuse the merge when it leaves more inbound arms without a legal exit than its parts had. */
  guard: boolean;
}

interface Candidate {
  key: number;
  ids: number[];
}

export function clusterJunctions(g: Graph, topo: Topo, forced: ForcedMerge[], diag: Diag): ClusterResult {
  // Junction candidates (`J`) and attribute-change points (`join`) cluster; both end up in `rep`.
  const jNodes = [...topo.kind].filter(([, k]) => k === 'J' || k === 'join').map(([n]) => n).sort((a, b) => a - b);
  const index = new Map(jNodes.map((n, i) => [n, i]));
  const cands: Candidate[] = [];

  // (a) chains between two such nodes: ≤ D_EDGE between junction candidates, ≤ D_JOIN when a join is involved.
  for (const n of jNodes) {
    for (const eid of topo.adj.get(n) as number[]) {
      const c = walkChain(topo, n, eid);
      const end = c.nodes[c.nodes.length - 1];
      if (end === n || !index.has(end)) continue;
      const lim = topo.kind.get(n) === 'J' && topo.kind.get(end) === 'J' ? D_EDGE : D_JOIN;
      if (c.len <= lim) cands.push({ key: c.len, ids: [n, end] });
    }
  }

  // (b) short `_link` ways whose two ends are junction nodes: merge every junction node on them.
  let run: number[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const first = g.edges[run[0]];
    const last = g.edges[run[run.length - 1]];
    if (first.way.isLink && index.has(first.u) && index.has(last.v)) {
      const len = run.reduce((s, id) => s + g.edges[id].len, 0);
      if (len <= D_LINKWAY) {
        const ids = [first.u, ...run.map(id => g.edges[id].v)].filter(n => index.has(n));
        cands.push({ key: len, ids });
      }
    }
    run = [];
  };
  for (const e of g.edges) {
    if (!e.alive) continue;
    const prev = run.length ? g.edges[run[run.length - 1]] : null;
    if (prev && !(prev.way.id === e.way.id && prev.v === e.u)) flush();
    run.push(e.id);
  }
  flush();

  // (c) any two junction nodes closer than D_NEAR.
  for (let i = 0; i < jNodes.length; i++) {
    const a = posOf(g, jNodes[i]);
    for (let j = i + 1; j < jNodes.length; j++) {
      const b = posOf(g, jNodes[j]);
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d <= D_NEAR) cands.push({ key: d, ids: [jNodes[i], jNodes[j]] });
    }
  }

  const ord = (c: Candidate) => [Math.round(c.key * 1000), Math.min(...c.ids), Math.max(...c.ids)];
  cands.sort((a, b) => {
    const x = ord(a);
    const y = ord(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });

  const parent = jNodes.map((_, i) => i);
  const minX = jNodes.map(n => posOf(g, n).x);
  const maxX = [...minX];
  const minZ = jNodes.map(n => posOf(g, n).z);
  const maxZ = [...minZ];
  const parts = jNodes.map(n => [n]);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  /** Inbound arms (`node:edge`) of the node set that cannot leave by any turn the sim accepts (≤ 150°). */
  const stuck = (set: number[]): Set<string> => {
    const inside = new Set(set);
    const arms: (ArmDir & { key: string })[] = [];
    for (const n of set) {
      for (const eid of topo.adj.get(n) as number[]) {
        const c = walkChain(topo, n, eid);
        if (inside.has(c.nodes[c.nodes.length - 1])) continue;
        const e0 = topo.edges[eid];
        arms.push({ key: `${n}:${eid}`, angle: headingAlong(c.nodes.map(m => posOf(g, m))), inbound: lanesToward(e0, n) > 0, outbound: lanesAway(e0, n) > 0 });
      }
    }
    return new Set(stuckArms(arms).map(a => a.key));
  };
  /**
   * Union the given node ids when the merged box diagonal stays within `cap` and, if `guard`, the merge strands no inbound
   * arm that had a legal exit before (merging both ends of a U-turn would turn it into a >150° hairpin).
   */
  const tryMerge = (ids: number[], cap: number, guard: boolean): 'ok' | 'cap' | 'stuck' => {
    const roots = [...new Set(ids.map(n => find(index.get(n) as number)))].sort((a, b) => a - b);
    if (roots.length < 2) return 'ok';
    const x0 = Math.min(...roots.map(r => minX[r]));
    const x1 = Math.max(...roots.map(r => maxX[r]));
    const z0 = Math.min(...roots.map(r => minZ[r]));
    const z1 = Math.max(...roots.map(r => maxZ[r]));
    if (Math.hypot(x1 - x0, z1 - z0) > cap) return 'cap';
    const union = roots.flatMap(r => parts[r]);
    if (guard) {
      const before = new Set(roots.flatMap(r => [...stuck(parts[r])]));
      for (const k of stuck(union)) if (!before.has(k)) return 'stuck';
    }
    const [root, ...rest] = roots;
    for (const r of rest) parent[r] = root;
    parts[root] = union;
    minX[root] = x0;
    maxX[root] = x1;
    minZ[root] = z0;
    maxZ[root] = z1;
    return 'ok';
  };
  // Merges that absorb a join (lane/class change point) must not leave inbound arms without a legal exit.
  for (const c of cands) tryMerge(c.ids, D_MAX, c.ids.some(n => topo.kind.get(n) === 'join'));
  for (const f of forced) {
    if (!index.has(f.a) || !index.has(f.b)) continue;
    const verdict = tryMerge([f.a, f.b], f.cap, f.guard);
    if (verdict === 'cap') {
      diag.add('forced-merge-refused', 'warn', `Short link between clusters would merge into more than ${f.cap} m`, [f.a, f.b], posOf(g, f.a));
    } else if (verdict === 'stuck') {
      diag.add('forced-merge-refused', 'warn', 'Merging these clusters would leave an inbound arm with only a >150° turn (U-turn through the pair); kept apart', [f.a, f.b], posOf(g, f.a));
    }
  }
  const groups = new Map<number, number[]>();
  for (const n of jNodes) {
    const r = find(index.get(n) as number);
    const list = groups.get(r);
    if (list) list.push(n);
    else groups.set(r, [n]);
  }
  const rep = new Map<number, number>();
  const clusters = new Map<number, Cluster>();
  for (const members of groups.values()) {
    const pts = members.map(n => posOf(g, n));
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
    const radius = Math.max(...pts.map(p => Math.hypot(p.x - cx, p.z - cz)));
    const key = members[0];
    const root = find(index.get(key) as number);
    const diagLen = Math.hypot(maxX[root] - minX[root], maxZ[root] - minZ[root]);
    clusters.set(key, { key, members, cx, cz, radius, diag: diagLen });
    for (const n of members) rep.set(n, key);
    if (diagLen > D_HARD) diag.fatal.push(`cluster ${key} spans ${diagLen.toFixed(1)} m (> ${D_HARD} m)`);
  }
  return { rep, clusters };
}
