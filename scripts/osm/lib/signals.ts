/** Design §3.10: attach OSM `traffic_signals` nodes to junction clusters; arm geometry used by signals and the report. */
import type { RoadClassName } from '../../../src/data/q1Schema';
import type { LinkDraft, Solved } from './chains';
import { flow } from './chains';
import type { Diag, Graph } from './graph';
import { headingAlong, posOf } from './graph';
import type { P2 } from './types';

export const D_SIG = 30;

export const CLASS_RANK: Record<RoadClassName, number> = {
  trunk: 0,
  primary: 1,
  secondary: 2,
  tertiary: 3,
  residential: 4,
  unclassified: 5,
};

export interface ArmGeom {
  link: number;
  end: 'a' | 'b';
  /** Heading leaving the node along the link, atan2(dz, dx). */
  angle: number;
  rank: number;
  inbound: boolean;
  outbound: boolean;
}

/** Heading from the link's end point outward, read ARM_PROBE metres along the polyline. */
export function armAngle(l: LinkDraft, end: 'a' | 'b'): number {
  return headingAlong(end === 'a' ? l.pts : [...l.pts].reverse());
}

export function armsOf(s: Solved, key: number): ArmGeom[] {
  const out = (s.arms.get(key) ?? []).map(r => {
    const l = s.links[r.link];
    const f = flow(l, r.end);
    return {
      link: r.link,
      end: r.end,
      angle: armAngle(l, r.end),
      rank: CLASS_RANK[l.cls] + (l.isLink ? 0.5 : 0),
      inbound: f.in,
      outbound: f.out,
    };
  });
  return out.sort((a, b) => a.angle - b.angle || a.link - b.link);
}

/** Longest link joining two signalised clusters that still counts as one signal-controlled junction. */
export const D_SIGPAIR = 30;

/** Links of ≤ D_SIGPAIR m between two signalised clusters: the pair is merged into one junction. */
export function signalPairs(s: Solved, keys: Set<number>): { a: number; b: number }[] {
  return s.links.filter(l => l.a !== l.b && keys.has(l.a) && keys.has(l.b) && l.length <= D_SIGPAIR).map(l => ({ a: l.a, b: l.b }));
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Axis (radians) of the major road through the node, as in the sim's `majorArms`. */
export function majorAxis(arms: ArmGeom[]): number {
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
  if (!best || arms[single].rank + 2 <= Math.min(arms[best[0]].rank, arms[best[1]].rank)) return arms[single].angle;
  const a = arms[best[0]].angle;
  const b = arms[best[1]].angle + Math.PI;
  return Math.atan2(Math.sin(a) + Math.sin(b), Math.cos(a) + Math.cos(b));
}

/** 0 when the arm lies within 45° of the axis line, else 1. */
export function armGroup(angle: number, axis: number): 0 | 1 {
  const x = (((angle - axis + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI;
  return Math.abs(x - Math.PI / 2) < Math.PI / 4 ? 0 : 1;
}

/** How far (rad) the phase axis may be turned off the major road to give both groups an inbound arm. */
export const AXIS_SHIFT_MAX = (45 * Math.PI) / 180;
/** Step (rad) of the axis search. */
export const AXIS_SHIFT_STEP = Math.PI / 180;
/** A turned axis must keep every inbound arm at least this far (rad) from the 45° group boundary. */
export const AXIS_MARGIN = (5 * Math.PI) / 180;

/** Inbound arms per phase group for the given axis. */
function inboundPerGroup(arms: ArmGeom[], axis: number): [number, number] {
  const n: [number, number] = [0, 0];
  for (const a of arms) if (a.inbound) n[armGroup(a.angle, axis)]++;
  return n;
}

/** Distance (rad) of an arm from the 45° boundary between the two phase groups. */
function boundaryMargin(angle: number, axis: number): number {
  const x = (((angle - axis + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI;
  return Math.abs(Math.abs(x - Math.PI / 2) - Math.PI / 4);
}

/**
 * Phase axis the sim must use so both groups own an inbound arm: the major axis when it already does, else the
 * nearest axis (≤ AXIS_SHIFT_MAX, positive turn first) that does and keeps AXIS_MARGIN to every inbound arm; null when none.
 * Mirrors `signalAxis` in src/sim/network.ts.
 */
export function signalAxis(arms: ArmGeom[]): number | null {
  const base = majorAxis(arms);
  const both = (axis: number) => {
    const n = inboundPerGroup(arms, axis);
    return n[0] > 0 && n[1] > 0;
  };
  if (both(base)) return base;
  for (let k = 1; k * AXIS_SHIFT_STEP <= AXIS_SHIFT_MAX + 1e-9; k++) {
    for (const sign of [1, -1]) {
      const axis = wrap(base + sign * k * AXIS_SHIFT_STEP);
      if (both(axis) && arms.every(a => !a.inbound || boundaryMargin(a.angle, axis) >= AXIS_MARGIN)) return axis;
    }
  }
  return null;
}

export interface SignalResult {
  /** Junction node keys that get `signal = true`. */
  keys: Set<number>;
}

export function assignSignals(
  g: Graph,
  s: Solved,
  clusterRep: Map<number, number>,
  signalNodes: number[],
  diag: Diag,
): SignalResult {
  // Locate every graph node on a link (or on a chain swallowed by a cluster).
  const onLink = new Map<number, { link: number; idx: number }>();
  s.links.forEach((l, li) => {
    l.nodes.forEach((n, idx) => {
      if (idx > 0 && idx < l.nodes.length - 1) onLink.set(n, { link: li, idx });
    });
  });
  const claimed = new Map<number, number[]>();
  for (const n of [...signalNodes].sort((a, b) => a - b)) {
    if (!g.pos.has(n)) {
      diag.count('signalsNotOnRoad');
      continue;
    }
    const at: P2 = posOf(g, n);
    let key: number | null = null;
    const rep = clusterRep.get(n);
    if (rep !== undefined) key = rep;
    else if (s.internal.has(n)) key = s.internal.get(n) as number;
    else {
      const hit = onLink.get(n);
      if (hit) {
        const l = s.links[hit.link];
        let toA = 0;
        for (let i = 1; i <= hit.idx; i++) toA += Math.hypot(l.pts[i].x - l.pts[i - 1].x, l.pts[i].z - l.pts[i - 1].z);
        const toB = l.length - toA;
        const ends: [number, number][] = [
          [toA, l.a],
          [toB, l.b],
        ];
        ends.sort((x, y) => x[0] - y[0]);
        const near = ends.find(([d, k]) => d <= D_SIG && s.nodes.get(k)?.kind === 'junction');
        key = near ? near[1] : null;
      } else if (s.nodes.has(n)) {
        // The signal sits on a terminal that is not a junction (join, dead end, portal).
        diag.count('signalsIgnoredTerminal');
        diag.add('signal-ignored', 'info', 'traffic_signals on a join/dead/portal node', [n], at);
        continue;
      }
    }
    if (key === null || s.nodes.get(key)?.kind !== 'junction') {
      diag.count('signalsIgnoredFar');
      diag.add('signal-ignored', 'info', `traffic_signals more than ${D_SIG} m from any junction`, [n], at);
      continue;
    }
    const list = claimed.get(key);
    if (list) list.push(n);
    else claimed.set(key, [n]);
  }
  const keys = new Set<number>();
  for (const [key, nodes] of [...claimed].sort((a, b) => a[0] - b[0])) {
    const node = s.nodes.get(key);
    const arms = armsOf(s, key);
    const axis = majorAxis(arms);
    const inG = inboundPerGroup(arms, axis);
    if (node && arms.length >= 3 && signalAxis(arms) !== null) {
      keys.add(key);
      diag.count('signalsMatched', nodes.length);
    } else {
      diag.count('signalsIgnoredShape', nodes.length);
      diag.add(
        'signal-ignored',
        'warn',
        `Signal junction has ${arms.length} arms with inbound per group ${inG[0]}/${inG[1]}; no signal`,
        nodes,
        { x: node?.x ?? 0, z: node?.z ?? 0 },
      );
    }
  }
  return { keys };
}
