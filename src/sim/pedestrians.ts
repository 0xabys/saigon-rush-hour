import { Rng } from '../core/rng';
import { SegKind, type Network, type Segment } from './network';
import { Light, type SignalSystem } from './signals';

export const PED_CAP = 180;
/** Footprint vehicles keep clear of. */
export const PED_RADIUS = 0.35;

interface Crosswalk {
  nodeIndex: number;
  /** Signal group of the road this zebra crosses; people walk while it is red. */
  group: number;
  cx: number;
  cz: number;
  /** Half the width of the road it spans, plus the verge people start from. */
  half: number;
  /** Unit vector across the road and along it. */
  px: number;
  pz: number;
  ox: number;
  oz: number;
}

export interface PedSnapshot {
  arrays: Float32Array[];
  hi: number;
  count: number;
  rng: number;
  seq: number;
}

/**
 * People crossing the street: at zebras during their walk phase, and the classic Saigon
 * mid-block crossing — walk slowly and steadily, and the traffic flows around you.
 * Vehicles treat every crosser as an obstacle they must give way to.
 */
export class Pedestrians {
  readonly active = new Uint8Array(PED_CAP);
  readonly x = new Float32Array(PED_CAP);
  readonly z = new Float32Array(PED_CAP);
  readonly dx = new Float32Array(PED_CAP);
  readonly dz = new Float32Array(PED_CAP);
  readonly ax = new Float32Array(PED_CAP);
  readonly az = new Float32Array(PED_CAP);
  readonly len = new Float32Array(PED_CAP);
  readonly prog = new Float32Array(PED_CAP);
  readonly speed = new Float32Array(PED_CAP);
  /** 0 zebra, 1 mid-block. */
  readonly kind = new Uint8Array(PED_CAP);
  readonly seed = new Float32Array(PED_CAP);
  hi = 0;
  count = 0;
  private seq = 1;
  private readonly rng = new Rng(0x7ed5);
  private readonly crosswalks: Crosswalk[] = [];
  private readonly midBlocks: Segment[];
  private readonly tmp = [0, 0, 0, 0];
  private readonly all: Float32Array[];

  constructor(
    net: Network,
    private readonly signals: SignalSystem,
  ) {
    net.signalJunctions.forEach((j, nodeIndex) => {
      for (const arm of j.arms) {
        if (!arm.inLink?.signal) continue;
        // The zebra sits between the junction box and the stop line.
        this.crosswalks.push({
          nodeIndex,
          group: arm.inLink.signal.group,
          cx: arm.stopX - arm.ox * 2.1,
          cz: arm.stopZ - arm.oz * 2.1,
          half: arm.roadHalf + 1.1,
          px: -arm.oz,
          pz: arm.ox,
          ox: arm.ox,
          oz: arm.oz,
        });
      }
    });
    // One direction per street section is enough: the crossing spans the whole carriageway.
    this.midBlocks = net.links.filter(
      (l) => l.kind === SegKind.Link && !l.bridge && l.length >= 50 && (l.oneway || (l.from?.id ?? 0) < (l.to?.id ?? 0)),
    );
    this.all = [this.x, this.z, this.dx, this.dz, this.ax, this.az, this.len, this.prog, this.speed, this.seed];
  }

  private spawn(ax: number, az: number, bx: number, bz: number, speed: number, kind: number): void {
    let i = 0;
    while (i < PED_CAP && this.active[i]) i++;
    if (i === PED_CAP) return;
    const len = Math.hypot(bx - ax, bz - az);
    this.active[i] = 1;
    this.ax[i] = ax;
    this.az[i] = az;
    this.dx[i] = (bx - ax) / len;
    this.dz[i] = (bz - az) / len;
    this.len[i] = len;
    this.prog[i] = 0;
    this.speed[i] = speed;
    this.kind[i] = kind;
    this.seed[i] = this.seq++ % 997;
    this.x[i] = ax;
    this.z[i] = az;
    this.count++;
    if (i + 1 > this.hi) this.hi = i + 1;
  }

  step(dt: number, t: number, hour: number, rain: number): void {
    const crowd = (hour < 5 ? 0.12 : hour < 7 ? 0.45 : hour < 16 ? 0.75 : hour < 22 ? 1 : 0.35) * (1 - rain * 0.6);
    const rng = this.rng;
    for (const cw of this.crosswalks) {
      const st = this.signals.query(cw.nodeIndex, cw.group, t);
      // Only start crossing with enough red left to make it across; at night under flashing amber
      // people just step out now and then and traffic gives way.
      if (st.light === Light.Flash) {
        if (rng.next() > 0.06 * crowd * dt) continue;
      } else if (st.light !== Light.Red || st.remaining < 9 || rng.next() > 0.16 * crowd * dt) continue;
      const side = rng.next() < 0.5 ? 1 : -1;
      const along = rng.range(-1.1, 1.1);
      const ox = cw.cx + cw.ox * along;
      const oz = cw.cz + cw.oz * along;
      const half = cw.half;
      this.spawn(ox + cw.px * half * side, oz + cw.pz * half * side, ox - cw.px * half * side, oz - cw.pz * half * side, rng.range(1.1, 1.6), 0);
    }
    if (this.midBlocks.length > 0 && rng.next() < 0.22 * crowd * dt) {
      const link = this.midBlocks[rng.int(this.midBlocks.length)];
      link.sample(rng.range(14, link.length - 14), this.tmp);
      // Link samples sit on the right-hand reference line; step back to the road centre.
      const rx = -this.tmp[3];
      const rz = this.tmp[2];
      const cx = this.tmp[0] - rx * link.refOffset;
      const cz = this.tmp[1] - rz * link.refOffset;
      const half = link.roadHalf + 1.1;
      const side = rng.next() < 0.5 ? 1 : -1;
      this.spawn(cx + rx * half * side, cz + rz * half * side, cx - rx * half * side, cz - rz * half * side, rng.range(0.75, 1.05), 1);
    }

    for (let i = 0; i < this.hi; i++) {
      if (!this.active[i]) continue;
      this.prog[i] += this.speed[i] * dt;
      if (this.prog[i] >= this.len[i]) {
        this.active[i] = 0;
        this.count--;
        continue;
      }
      this.x[i] = this.ax[i] + this.dx[i] * this.prog[i];
      this.z[i] = this.az[i] + this.dz[i] * this.prog[i];
    }
    while (this.hi > 0 && !this.active[this.hi - 1]) this.hi--;
  }

  snapshot(): PedSnapshot {
    const n = this.hi;
    return {
      arrays: [this.active, this.kind, ...this.all].map((a) => Float32Array.from(a.subarray(0, n))),
      hi: n,
      count: this.count,
      rng: this.rng.state,
      seq: this.seq,
    };
  }

  restore(s: PedSnapshot): void {
    this.active.fill(0);
    [this.active, this.kind, ...this.all].forEach((a, k) => a.set(s.arrays[k]));
    this.hi = s.hi;
    this.count = s.count;
    this.rng.state = s.rng;
    this.seq = s.seq;
  }
}
