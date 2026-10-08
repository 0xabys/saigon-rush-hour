/** Design §3.7: `junction=roundabout|circular` components become rings (fail closed on bad topology/direction). */
import type { WayInfo } from './filter';
import type { Diag } from './graph';
import { wayLanes } from './lanes';
import { insideBounds } from './project';
import type { P2 } from './types';

export interface RingDraft {
  /** Smallest member node id; also the id of the ring's graph node. */
  key: number;
  /** Member nodes in driving order starting at `key`. */
  nodes: number[];
  pts: P2[];
  cx: number;
  cz: number;
  r: number;
  lanes: number;
  name: string;
  osm: number[];
}

/** Twice the signed area in (x, z); negative = counter-clockwise as drawn on a north-up map. */
export function shoelace(pts: P2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.z - b.x * a.z;
  }
  return s;
}

export function detectRings(ways: WayInfo[], nodePos: Map<number, P2>, diag: Diag): RingDraft[] {
  const next = new Map<number, number[]>();
  const prevCount = new Map<number, number>();
  const wayIdsAt = new Map<number, Set<number>>();
  const lenByName = new Map<string, number>();
  const wayOf = new Map<number, WayInfo>();
  for (const w of ways) {
    if (!w.ring) continue;
    for (let i = 0; i + 1 < w.nodes.length; i++) {
      const u = w.nodes[i];
      const v = w.nodes[i + 1];
      const out = next.get(u);
      if (out) out.push(v);
      else next.set(u, [v]);
      prevCount.set(v, (prevCount.get(v) ?? 0) + 1);
      for (const n of [u, v]) {
        const s = wayIdsAt.get(n);
        if (s) s.add(w.id);
        else wayIdsAt.set(n, new Set([w.id]));
        wayOf.set(w.id, w);
      }
    }
  }
  const members = [...wayIdsAt.keys()].sort((a, b) => a - b);
  const seen = new Set<number>();
  const rings: RingDraft[] = [];
  for (const start of members) {
    if (seen.has(start)) continue;
    // Connected component over ring edges (either direction).
    const comp = new Set<number>();
    const stack = [start];
    while (stack.length) {
      const n = stack.pop() as number;
      if (comp.has(n)) continue;
      comp.add(n);
      for (const m of next.get(n) ?? []) stack.push(m);
      for (const [u, outs] of next) if (outs.includes(n)) stack.push(u);
    }
    for (const n of comp) seen.add(n);
    const sorted = [...comp].sort((a, b) => a - b);
    const key = sorted[0];
    const at = nodePos.get(key) ?? { x: 0, z: 0 };
    const bad = sorted.find(n => (next.get(n)?.length ?? 0) !== 1 || (prevCount.get(n) ?? 0) !== 1);
    if (bad !== undefined) {
      diag.fatal.push(`ring at node ${key}: node ${bad} does not have exactly one in and one out ring edge`);
      continue;
    }
    const order = [key];
    for (let n = (next.get(key) as number[])[0]; n !== key; n = (next.get(n) as number[])[0]) {
      order.push(n);
      if (order.length > comp.size) break;
    }
    if (order.length !== comp.size) {
      diag.fatal.push(`ring at node ${key}: ring ways do not form one closed cycle`);
      continue;
    }
    const wayIds = new Set<number>();
    for (const n of order) for (const id of wayIdsAt.get(n) ?? []) wayIds.add(id);
    const pts: P2[] = [];
    let missing = false;
    for (const n of order) {
      const p = nodePos.get(n);
      if (p) pts.push(p);
      else missing = true;
    }
    if (missing || !pts.every(insideBounds)) {
      diag.count('ringsClipped');
      diag.add('ring-clipped', 'info', 'Ring touches the bbox edge and was removed; its arms become dead ends', [...wayIds], at);
      continue;
    }
    if (shoelace(pts) >= 0) {
      diag.fatal.push(`ring at node ${key}: drawn clockwise on the map (wrong driving direction for right-hand traffic)`);
      continue;
    }
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
    const r = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.z - cz), 0) / pts.length;
    let lanes = 1;
    lenByName.clear();
    for (const id of wayIds) {
      const w = wayOf.get(id) as WayInfo;
      lanes = Math.max(lanes, wayLanes(w).lF);
      if (w.name) lenByName.set(w.name, (lenByName.get(w.name) ?? 0) + w.nodes.length);
    }
    const name = [...lenByName.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? '';
    rings.push({ key, nodes: order, pts, cx, cz, r, lanes, name, osm: [...wayIds].sort((a, b) => a - b) });
  }
  return rings;
}
