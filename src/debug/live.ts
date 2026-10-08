/**
 * Headless side of the "live sim" mode of the debug page: builds the OSM network, runs the real `Traffic`
 * with the same fixed step as src/main.ts and derives read-only statistics (reason counts, per-segment
 * occupancy, junction queues) from the public typed arrays. No DOM, no drawing.
 */
import type { NetworkJson } from '../data/q1Schema';
import type { Junction, Network } from '../sim/network';
import { SegKind } from '../sim/network';
import { buildOsmNetwork } from '../sim/osmMap';
import { SignalSystem, flashHours } from '../sim/signals';
import { CAPACITY, Traffic } from '../sim/traffic';
import type { TrafficKpi } from '../sim/traffic';

export const SIM_DT = 1 / 60;
/** Upper bounds of one animation frame: step count and wall time spent stepping. */
const MAX_STEPS_PER_FRAME = 24;
const STEP_BUDGET_MS = 45;
export const MAX_TARGET = CAPACITY;
export const DEFAULT_TARGET = 2000;
export const SPEEDS = [1, 4, 16] as const;
export type Speed = (typeof SPEEDS)[number];

/** `Reason` values in traffic.ts: free, follow, yield, signal, dwell. */
export const REASON_COUNT = 5;
/** Speed (m/s) below which a vehicle counts as standing. */
const STAND_V = 0.5;
const STUCK_S = 60;

export interface LiveScan {
  /** Vehicles per `Reason`. */
  reasons: number[];
  crashed: number;
  /** Standing for longer than `STUCK_S`. */
  stuck: number;
  /** Σ length·width of the vehicles on each segment (m²); divide by `LiveSim.area` for occupancy. */
  occ: Float32Array;
}

export interface ArmQueue {
  /** Vehicles on the inbound link. */
  vehicles: number;
  standing: number;
  /** Distance from the stop line to the rearmost standing vehicle (m). */
  queueM: number;
}

export interface JunctionLoad {
  arms: ArmQueue[];
  /** Vehicles on the junction's own connectors / ring arcs. */
  inside: number;
  insideStanding: number;
}

export class LiveSim {
  readonly net: Network;
  readonly signals: SignalSystem;
  traffic: Traffic;
  playing = true;
  speed: Speed = 4;
  hour = 8;
  autoTime = false;
  target = DEFAULT_TARGET;
  simTime = 0;
  stepCount = 0;
  /** Exponential average and decaying peak of one `Traffic.step` in ms. */
  stepMs = 0;
  stepMsPeak = 0;
  readonly kpi: TrafficKpi = { count: 0, avgKmh: 0, movingKmh: 0, congestion: 0, waiting: 0, mix: [], releases: 0, locksBroken: 0, teleports: 0 };
  readonly scan: LiveScan;
  /** Road surface area per segment (m²) for the occupancy heat; 0 for connectors. */
  readonly area: Float32Array;
  /** Per segment `[minX, minZ, maxX, maxZ]` of its reference line. */
  readonly segBox: Float32Array;
  private acc = 0;

  constructor(json: NetworkJson) {
    this.net = buildOsmNetwork(json);
    this.signals = new SignalSystem(this.net.signalJunctions);
    this.traffic = new Traffic(this.net, this.signals);
    const n = this.net.segments.length;
    this.area = new Float32Array(n);
    this.segBox = new Float32Array(n * 4);
    for (const sg of this.net.segments) {
      if (sg.kind !== SegKind.Conn) this.area[sg.id] = sg.length * sg.halfW * 2;
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (let i = 0; i < sg.n; i++) {
        x0 = Math.min(x0, sg.px[i]);
        x1 = Math.max(x1, sg.px[i]);
        z0 = Math.min(z0, sg.pz[i]);
        z1 = Math.max(z1, sg.pz[i]);
      }
      this.segBox.set([x0, z0, x1, z1], sg.id * 4);
    }
    this.scan = { reasons: new Array<number>(REASON_COUNT).fill(0), crashed: 0, stuck: 0, occ: new Float32Array(n) };
    this.reset();
  }

  /** Fresh traffic on the same network, at t = 0. */
  reset(): void {
    this.traffic = new Traffic(this.net, this.signals);
    this.simTime = 0;
    this.stepCount = 0;
    this.acc = 0;
    this.applyControls();
    this.traffic.populate(this.target);
    this.scanVehicles();
    this.traffic.kpi(this.kpi);
  }

  setHour(hour: number): void {
    this.hour = ((hour % 24) + 24) % 24;
    this.applyControls();
    this.signals.flashing = flashHours(this.hour);
  }

  private applyControls(): void {
    this.traffic.hour = this.hour;
    this.traffic.target = this.target;
  }

  /** One fixed step of `SIM_DT`. */
  stepOnce(): void {
    const t0 = performance.now();
    this.simTime += SIM_DT;
    this.stepCount++;
    if (this.autoTime) this.hour = (this.hour + SIM_DT / 60) % 24; // one game minute per sim second, as in src/main.ts
    this.applyControls();
    this.traffic.step(SIM_DT, this.simTime);
    const ms = performance.now() - t0;
    this.stepMs += (ms - this.stepMs) * 0.03;
    this.stepMsPeak = Math.max(ms, this.stepMsPeak * 0.995);
  }

  /** Accumulates real time like src/main.ts and runs the due steps. Returns how many ran. */
  advance(realDt: number): number {
    if (!this.playing) return 0;
    this.acc += Math.min(realDt, 0.1) * this.speed;
    const t0 = performance.now();
    let steps = 0;
    while (this.acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME && performance.now() - t0 < STEP_BUDGET_MS) {
      this.stepOnce();
      this.acc -= SIM_DT;
      steps++;
    }
    // Cannot keep up: drop the backlog instead of spiralling.
    if (this.acc >= SIM_DT) this.acc = this.acc % SIM_DT;
    return steps;
  }

  /** Recomputes `scan` from the vehicle arrays. */
  scanVehicles(): void {
    const tr = this.traffic;
    const sc = this.scan;
    sc.reasons.fill(0);
    sc.occ.fill(0);
    sc.crashed = 0;
    sc.stuck = 0;
    for (let i = 0; i < tr.hi; i++) {
      if (!tr.active[i]) continue;
      if (tr.crashed[i]) sc.crashed++;
      else sc.reasons[tr.reason[i]]++;
      if (tr.stopT[i] > STUCK_S) sc.stuck++;
      sc.occ[tr.seg[i]] += tr.len[i] * tr.wid[i];
    }
  }

  /** Queue statistics on every approach of `j`. */
  junctionLoad(j: Junction): JunctionLoad {
    const tr = this.traffic;
    const arms: ArmQueue[] = j.arms.map(() => ({ vehicles: 0, standing: 0, queueM: 0 }));
    const armOfSeg = new Map<number, number>();
    j.arms.forEach((arm, k) => {
      if (arm.inLink) armOfSeg.set(arm.inLink.id, k);
    });
    const load: JunctionLoad = { arms, inside: 0, insideStanding: 0 };
    for (let i = 0; i < tr.hi; i++) {
      if (!tr.active[i]) continue;
      const sg = tr.segs[tr.seg[i]];
      const standing = tr.v[i] < STAND_V;
      const k = armOfSeg.get(sg.id);
      if (k !== undefined) {
        const q = arms[k];
        q.vehicles++;
        if (standing) {
          q.standing++;
          q.queueM = Math.max(q.queueM, sg.length - tr.s[i]);
        }
      } else if ((sg.kind === SegKind.Conn && sg.junction === j) || (sg.kind === SegKind.Ring && j.ring >= 0 && sg.ring === j.ring)) {
        load.inside++;
        if (standing) load.insideStanding++;
      }
    }
    return load;
  }
}
