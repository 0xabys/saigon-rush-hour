import { Rng } from '../core/rng';
import { REF_OFFSET, ROAD_HALF, SegKind, type Network, type Segment } from './network';
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
    net.signalNodes.forEach((n, nodeIndex) => {
      for (const arm of n.arms) {
        const d = arm.trim - 2.1;
        this.crosswalks.push({
          nodeIndex,
          group: arm.inLink.signal!.group,
          cx: n.x + arm.ox * d,
          cz: n.z + arm.oz * d,
          px: -arm.oz,
          pz: arm.ox,
          ox: arm.ox,
          oz: arm.oz,
        });
      }
    });
    // One direction per road is enough: the crossing spans both carriageways.
    const seen = new Set<number>();
    this.midBlocks = net.links.filter((l) => {
      if (l.kind !== SegKind.Link || !l.road || l.road.bridge || l.length < 50 || seen.has(l.road.id)) return false;
      seen.add(l.road.id);
      return true;
    });
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
    const half = ROAD_HALF + 1.1;
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
      this.spawn(ox + cw.px * half * side, oz + cw.pz * half * side, ox - cw.px * half * side, oz - cw.pz * half * side, rng.range(1.1, 1.6), 0);
    }
    if (rng.next() < 0.22 * crowd * dt) {
      const link = this.midBlocks[rng.int(this.midBlocks.length)];
      link.sample(rng.range(14, link.length - 14), this.tmp);
      // Link samples sit on the right-hand reference line; step back to the road centre.
      const rx = -this.tmp[3];
      const rz = this.tmp[2];
      const cx = this.tmp[0] - rx * REF_OFFSET;
      const cz = this.tmp[1] - rz * REF_OFFSET;
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
