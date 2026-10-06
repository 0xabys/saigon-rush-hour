import type { Network, Road } from './network';
import type { Traffic } from './traffic';

const SAMPLE_EVERY = 1; // sim seconds

export interface RoadSeries {
  /** Average speed (km/h) per clock hour, null where no data has been seen yet. */
  speedKmh: (number | null)[];
  /** Vehicles per 100 m per clock hour. */
  density: (number | null)[];
}

export interface RoadStatsSnapshot {
  vehSum: Float64Array;
  speedSum: Float64Array;
  samples: Float64Array;
  liveCount: Float32Array;
  liveSpeed: Float32Array;
  acc: number;
}

/**
 * Per-road counters sampled once per sim second and bucketed by clock hour, so the
 * "Tuyến đường" tab can chart density and speed through the day.
 */
export class RoadStats {
  readonly roads: Road[];
  /** Road length in metres between junction boxes. */
  readonly lengths: Float32Array;
  readonly liveCount: Float32Array;
  readonly liveSpeed: Float32Array;
  private readonly roadOfSeg: Int16Array;
  private vehSum: Float64Array;
  private speedSum: Float64Array;
  private samples: Float64Array;
  private acc = 0;
  private readonly n: Float32Array;
  private readonly v: Float32Array;

  constructor(net: Network) {
    this.roads = net.roads;
    const R = net.roads.length;
    this.roadOfSeg = new Int16Array(net.segments.length).fill(-1);
    this.lengths = new Float32Array(R);
    for (const l of net.links) {
      if (!l.road) continue;
      this.roadOfSeg[l.id] = l.road.id;
      this.lengths[l.road.id] += l.length / 2;
    }
    this.liveCount = new Float32Array(R);
    this.liveSpeed = new Float32Array(R);
    this.vehSum = new Float64Array(R * 24);
    this.speedSum = new Float64Array(R * 24);
    this.samples = new Float64Array(R * 24);
    this.n = new Float32Array(R);
    this.v = new Float32Array(R);
  }

  step(tr: Traffic, hour: number, dt: number): void {
    this.acc += dt;
    if (this.acc < SAMPLE_EVERY) return;
    this.acc -= SAMPLE_EVERY;
    this.n.fill(0);
    this.v.fill(0);
    for (let i = 0; i < tr.hi; i++) {
      if (!tr.active[i]) continue;
      const r = this.roadOfSeg[tr.seg[i]];
      if (r < 0) continue;
      this.n[r]++;
      this.v[r] += tr.v[i];
    }
    const b = Math.floor(((hour % 24) + 24) % 24);
    for (let r = 0; r < this.roads.length; r++) {
      this.liveCount[r] = this.n[r];
      this.liveSpeed[r] = this.n[r] ? this.v[r] / this.n[r] : 0;
      const k = r * 24 + b;
      this.vehSum[k] += this.n[r];
      this.speedSum[k] += this.v[r];
      this.samples[k]++;
    }
  }

  series(roadId: number): RoadSeries {
    const speedKmh: (number | null)[] = [];
    const density: (number | null)[] = [];
    const per100 = 100 / Math.max(1, this.lengths[roadId]);
    for (let h = 0; h < 24; h++) {
      const k = roadId * 24 + h;
      const s = this.samples[k];
      if (!s) {
        speedKmh.push(null);
        density.push(null);
        continue;
      }
      speedKmh.push(this.vehSum[k] ? (this.speedSum[k] / this.vehSum[k]) * 3.6 : 0);
      density.push((this.vehSum[k] / s) * per100);
    }
    return { speedKmh, density };
  }

  /** Nearest road to a ground point within `maxDist` of its centreline, or −1. */
  nearest(x: number, z: number, maxDist: number): number {
    let best = -1;
    let bestD = maxDist;
    for (const r of this.roads) {
      const dx = r.b.x - r.a.x;
      const dz = r.b.z - r.a.z;
      const t = Math.max(0, Math.min(1, ((x - r.a.x) * dx + (z - r.a.z) * dz) / (dx * dx + dz * dz)));
      const d = Math.hypot(x - r.a.x - dx * t, z - r.a.z - dz * t);
      if (d < bestD) {
        bestD = d;
        best = r.id;
      }
    }
    return best;
  }

  snapshot(): RoadStatsSnapshot {
    return {
      vehSum: this.vehSum.slice(),
      speedSum: this.speedSum.slice(),
      samples: this.samples.slice(),
      liveCount: this.liveCount.slice(),
      liveSpeed: this.liveSpeed.slice(),
      acc: this.acc,
    };
  }

  restore(s: RoadStatsSnapshot): void {
    this.vehSum = s.vehSum.slice();
    this.speedSum = s.speedSum.slice();
    this.samples = s.samples.slice();
    this.liveCount.set(s.liveCount);
    this.liveSpeed.set(s.liveSpeed);
    this.acc = s.acc;
  }
}
