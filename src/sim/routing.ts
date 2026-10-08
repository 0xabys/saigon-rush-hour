// Destination routing tables (build-time). Vehicles pick an exit portal at spawn and steer towards it
// with a softmax over remaining shortest-path distance (see `Traffic.planNext`); without this the
// network is a closed random walk and the core never drains.
import type { Network, Segment } from './network';
import type { SignalSystem } from './signals';

/** A destination is only drawn from portals at least this many metres (path length) away; the condition is dropped when none qualifies. */
export const D_MIN = 250;

/** EMA time constant (s) of the per-segment mean speed behind `CostRouter`; `Infinity` freezes `vHat` at free flow (router ≡ static in time). */
export const COST_EMA_S = 20;
/** Sim steps per router epoch: segment times freeze, `dests` rebuild round-robin, tables swap in at the epoch end (600 steps = 10 s at SIM_DT 1/60). */
export const COST_EPOCH_STEPS = 600;
/** Segment speed floor (m/s) in `len / v`, so a stalled segment costs at most `2·len` seconds instead of `Infinity`. */
export const COST_V_FLOOR = 0.5;
/** Free-flow speed as a fraction of `Segment.speedLimit`. */
export const COST_VFREE_K = 0.9;
/** Route-choice softmax scale (s): a branch that is `TAU_ROUTE_S` seconds slower than the best one is `e` times less likely. Scaled per driver by `0.6 + 0.8·aggr`. */
export const TAU_ROUTE_S = 12;

export interface RoutingTables {
  /**
   * `dests = exits ++ sinks`. `[0, nExits)` are the real exit links (`portalOut && !deadEnd`); `[nExits, dests.length)` are
   * internal sink links (one per link with `tripWeights > 0`, in `Network.links` order) a vehicle can end its trip on.
   * Only the exit range is a valid pick for code that treats a destination as "leave the map".
   */
  dests: Segment[];
  /** Number of exits at the head of `dests`. */
  nExits: number;
  /** `destSeg[d] = dests[d].id`: O(1) per-step lookup of the destination link of a vehicle. */
  destSeg: Int32Array;
  /** `distTo[d][seg]`: metres from the start of `seg` to the end of `dests[d]`; `Infinity` when unreachable. */
  distTo: Float32Array[];
  warnings: string[];
}

/** Successor segments: connectors / arcs / ring exits reachable directly from `sg`. */
function forEachSucc(sg: Segment, f: (q: Segment) => void): void {
  for (const q of sg.next) f(q);
  for (const q of sg.exitConns) f(q);
}

/**
 * Reverse Dijkstra over `succ(p) = next ∪ exitConns` on a fixed graph: CSR predecessor lists and a binary heap are built once,
 * `run` is allocation-free. Relaxation order is fixed by the CSR layout and the heap uses lazy deletion with strict-improvement
 * pushes, so identical input always yields bit-identical output.
 */
export class ReverseDijkstra {
  private readonly n: number;
  private readonly predStart: Int32Array;
  private readonly preds: Int32Array;
  private readonly best: Float64Array;
  private readonly hKey: Float64Array;
  private readonly hNode: Int32Array;
  private hSize = 0;
  private popKey = 0;
  private popNode = 0;

  constructor(segments: readonly Segment[]) {
    const n = segments.length;
    this.n = n;
    const predStart = new Int32Array(n + 1);
    for (const p of segments) forEachSucc(p, (q) => predStart[q.id + 1]++);
    for (let k = 0; k < n; k++) predStart[k + 1] += predStart[k];
    const preds = new Int32Array(predStart[n]);
    const fill = new Int32Array(n);
    for (const p of segments) {
      forEachSucc(p, (q) => {
        preds[predStart[q.id] + fill[q.id]++] = p.id;
      });
    }
    this.predStart = predStart;
    this.preds = preds;
    this.best = new Float64Array(n);
    // Every edge relaxes at most once per run, plus the seed entry.
    const cap = preds.length + 2;
    this.hKey = new Float64Array(cap);
    this.hNode = new Int32Array(cap);
  }

  private push(key: number, node: number): void {
    const { hKey, hNode } = this;
    let k = this.hSize++;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (hKey[parent] <= key) break;
      hKey[k] = hKey[parent];
      hNode[k] = hNode[parent];
      k = parent;
    }
    hKey[k] = key;
    hNode[k] = node;
  }

  private pop(): void {
    const { hKey, hNode } = this;
    this.popKey = hKey[0];
    this.popNode = hNode[0];
    const size = --this.hSize;
    const key = hKey[size];
    const node = hNode[size];
    let k = 0;
    for (;;) {
      let c = 2 * k + 1;
      if (c >= size) break;
      if (c + 1 < size && hKey[c + 1] < hKey[c]) c++;
      if (hKey[c] >= key) break;
      hKey[k] = hKey[c];
      hNode[k] = hNode[c];
      k = c;
    }
    hKey[k] = key;
    hNode[k] = node;
  }

  /**
   * `out[q] = cost[q] + min_{p ∈ succ(q)} out[p]`, `out[destId] = cost[destId]`; `Infinity` where `destId` is unreachable.
   * `cost` is `Float64Array` so that `cost = length` accumulates exactly as plain doubles (`out` is rounded to Float32 on store only).
   */
  run(cost: Float64Array, destId: number, out: Float32Array): void {
    const { n, best, predStart, preds } = this;
    if (cost.length !== n || out.length !== n) throw new Error(`ReverseDijkstra.run: cost/out length ${cost.length}/${out.length} ≠ ${n}`);
    out.fill(Infinity);
    best.fill(Infinity);
    best[destId] = cost[destId];
    this.hSize = 0;
    this.push(cost[destId], destId);
    while (this.hSize > 0) {
      this.pop();
      const q = this.popNode;
      const key = this.popKey;
      if (key > best[q]) continue;
      out[q] = key;
      for (let e = predStart[q]; e < predStart[q + 1]; e++) {
        const p = preds[e];
        const cand = key + cost[p];
        if (cand < best[p]) {
          best[p] = cand;
          this.push(cand, p);
        }
      }
    }
  }
}

/**
 * Reverse Dijkstra from every destination over `succ(p) = next ∪ exitConns` with cost = link length:
 * `dist[d] = len(d)`, `dist[p] = len(p) + min_q dist[q]`. Throws on NaN (corrupt geometry).
 * `sinks` are extra internal destination links appended after the exits (see `RoutingTables.dests`).
 */
export function buildRouting(segments: readonly Segment[], portalsIn: readonly Segment[], sinks: readonly Segment[]): RoutingTables {
  const n = segments.length;
  const warnings: string[] = [];
  const exits = segments.filter((sg) => sg.portalOut && !sg.deadEnd);
  const dests = exits.concat(sinks);
  const nExits = exits.length;
  const destSeg = new Int32Array(dests.length);
  dests.forEach((d, k) => {
    destSeg[k] = d.id;
  });
  const distTo: Float32Array[] = [];

  const rd = new ReverseDijkstra(segments);
  const len = new Float64Array(n);
  for (let k = 0; k < n; k++) len[k] = segments[k].length;
  for (let di = 0; di < dests.length; di++) {
    const d = dests[di];
    const dist = new Float32Array(n);
    rd.run(len, d.id, dist);
    for (let k = 0; k < n; k++) {
      if (Number.isNaN(dist[k])) throw new Error(`routing: NaN distance to link ${d.id} at segment ${k}`);
    }
    distTo.push(dist);
    if (di < nExits && portalsIn.length > 0 && !portalsIn.some((p) => Number.isFinite(dist[p.id]))) {
      warnings.push(`routing: destination link ${d.id} (${d.name || d.to?.key}) is unreachable from every inbound portal`);
    }
  }
  return { dests, nExits, destSeg, distTo, warnings };
}

/** Router state that evolves with the sim; everything else is a pure function of it (see `CostRouter.restore`). */
export interface RouterSnapshot {
  /** EMA of the mean vehicle speed per segment (m/s). */
  vHat: Float32Array;
  /** Segment travel times (s) behind the published `cost` tables. */
  tauActive: Float32Array;
  /** Segment travel times (s) behind the tables being built this epoch. */
  tauBuild: Float32Array;
  /** Steps elapsed in the current epoch, `[0, COST_EPOCH_STEPS)`. */
  epochStep: number;
}

/**
 * Time-cost router: `cost(d)[seg]` = expected seconds from the start of `seg` to the end of `dests[d]`, from live per-segment
 * speeds and signal delay. Tables are rebuilt in the background: every `COST_EPOCH_STEPS` steps the segment times `tau` freeze,
 * `dests` are rebuilt round-robin (`ceil(nDests / COST_EPOCH_STEPS)` per step) into a second buffer and swapped in at the epoch end,
 * so `cost` is stable within an epoch and the tables are a pure function of the snapshotted `tau`.
 */
export class CostRouter {
  private readonly nSeg: number;
  private readonly nDests: number;
  private readonly perStep: number;
  private readonly rd: ReverseDijkstra;
  private readonly destSeg: Int32Array;
  private readonly len: Float32Array;
  private readonly vFree: Float32Array;
  /** Static signal delay per segment (s); 0 where no signal ends the link. */
  private readonly sigDelay: Float32Array;
  private readonly vHat: Float32Array;
  private tauActive: Float32Array;
  private tauBuild: Float32Array;
  private costActive: Float32Array[];
  private costBuild: Float32Array[];
  private epochStep = 0;
  private readonly scratch: Float64Array;

  constructor(net: Network, signals: SignalSystem) {
    const segs = net.segments;
    const n = segs.length;
    this.nSeg = n;
    this.nDests = net.destSeg.length;
    this.perStep = Math.max(1, Math.ceil(this.nDests / COST_EPOCH_STEPS));
    this.destSeg = net.destSeg;
    this.rd = new ReverseDijkstra(segs);
    this.len = new Float32Array(n);
    this.vFree = new Float32Array(n);
    this.sigDelay = new Float32Array(n);
    this.vHat = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const sg = segs[k];
      this.len[k] = sg.length;
      this.vFree[k] = COST_VFREE_K * sg.speedLimit;
      this.vHat[k] = this.vFree[k];
      if (sg.signal) {
        const plan = signals.plans[sg.signal.nodeIndex];
        const g = plan.green[sg.signal.group];
        this.sigDelay[k] = ((plan.cycle - g) * (plan.cycle - g)) / (2 * plan.cycle);
      }
    }
    this.scratch = new Float64Array(n);
    this.tauActive = new Float32Array(n);
    this.tauBuild = new Float32Array(n);
    this.computeTau(this.tauActive, false);
    this.tauBuild.set(this.tauActive);
    this.costActive = this.allocTables();
    this.costBuild = this.allocTables();
    this.buildRange(this.tauActive, this.costActive, 0, this.nDests);
  }

  private allocTables(): Float32Array[] {
    const t: Float32Array[] = [];
    for (let d = 0; d < this.nDests; d++) t.push(new Float32Array(this.nSeg));
    return t;
  }

  /** `tau[s] = len/max(vHat, V_FLOOR) + sigDelay·min(1, vHat/vFree)`; no signal delay when the signals flash. */
  private computeTau(tau: Float32Array, flashing: boolean): void {
    const { nSeg, len, vHat, vFree, sigDelay } = this;
    for (let s = 0; s < nSeg; s++) {
      const v = vHat[s];
      let t = len[s] / Math.max(v, COST_V_FLOOR);
      if (!flashing && sigDelay[s] > 0) t += sigDelay[s] * Math.min(1, v / vFree[s]);
      tau[s] = t;
    }
  }

  /** Rebuild `tables[d]` for `d ∈ [from, to)` from `tau`. */
  private buildRange(tau: Float32Array, tables: Float32Array[], from: number, to: number): void {
    if (from >= to) return;
    this.scratch.set(tau);
    for (let d = from; d < to; d++) this.rd.run(this.scratch, this.destSeg[d], tables[d]);
  }

  /**
   * Call once per sim step after the per-segment census: `segCount[s]` vehicles on segment `s` with summed speed `segVSum[s]` (m/s).
   * Advances the EMA of `vHat` and the epoch pipeline (tau freeze → incremental rebuild → swap).
   */
  step(segCount: Int32Array, segVSum: Float32Array, flashing: boolean, dt: number): void {
    const { nSeg, vHat, vFree } = this;
    const a = Math.min(1, dt / COST_EMA_S);
    for (let s = 0; s < nSeg; s++) {
      const c = segCount[s];
      const target = c > 0 ? segVSum[s] / c : vFree[s];
      vHat[s] += (target - vHat[s]) * a;
    }
    const e = this.epochStep;
    if (e === 0) this.computeTau(this.tauBuild, flashing);
    this.buildRange(this.tauBuild, this.costBuild, e * this.perStep, Math.min(this.nDests, (e + 1) * this.perStep));
    if (e === COST_EPOCH_STEPS - 1) {
      const t = this.tauActive;
      this.tauActive = this.tauBuild;
      this.tauBuild = t;
      const c = this.costActive;
      this.costActive = this.costBuild;
      this.costBuild = c;
      this.epochStep = 0;
    } else {
      this.epochStep = e + 1;
    }
  }

  /** Seconds from the start of each segment to the end of `dests[d]` (`Infinity` = unreachable). Stable within an epoch. */
  cost(d: number): Float32Array {
    return this.costActive[d];
  }

  snapshot(): RouterSnapshot {
    return { vHat: this.vHat.slice(), tauActive: this.tauActive.slice(), tauBuild: this.tauBuild.slice(), epochStep: this.epochStep };
  }

  /** Restores the state and rebuilds the tables from it: all of `costActive`, and the part of `costBuild` already done this epoch. */
  restore(s: RouterSnapshot): void {
    const n = this.nSeg;
    if (s.vHat.length !== n || s.tauActive.length !== n || s.tauBuild.length !== n) {
      throw new Error(`CostRouter.restore: snapshot sized ${s.vHat.length}/${s.tauActive.length}/${s.tauBuild.length}, expected ${n}`);
    }
    if (!Number.isInteger(s.epochStep) || s.epochStep < 0 || s.epochStep >= COST_EPOCH_STEPS) throw new Error(`CostRouter.restore: bad epochStep ${s.epochStep}`);
    this.vHat.set(s.vHat);
    this.tauActive.set(s.tauActive);
    this.tauBuild.set(s.tauBuild);
    this.epochStep = s.epochStep;
    this.buildRange(this.tauActive, this.costActive, 0, this.nDests);
    this.buildRange(this.tauBuild, this.costBuild, 0, Math.min(this.nDests, s.epochStep * this.perStep));
  }
}
