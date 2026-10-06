import { rand01, Rng, weightedIndex } from '../core/rng';
import { FLOOD_ZONES, truckBanActive, type CityEvent, type Incident } from './events';
import { LANES, SegKind, Turn, WORLD, type Network, type Segment } from './network';
import { PED_RADIUS, Pedestrians, type PedSnapshot } from './pedestrians';
import { flashHours, Light, SignalSystem } from './signals';
import {
  BIKE_COLORS,
  BIKE_MODELS,
  BUS_ROUTES,
  CAR_COLORS,
  CAR_MODELS,
  CYCLO_HOOD,
  GIVEN,
  PONCHO_COLORS,
  SHIRT_COLORS,
  SPECS,
  SURNAMES,
  TRUCK_BOX,
  TRUCK_CAB,
  VTYPE_COUNT,
  VType,
} from './vehicleTypes';
import { Color } from 'three';

export const CAPACITY = 2200;
const CELL = 6;
const GX0 = WORLD.minX - 30;
const GZ0 = WORLD.minZ - 30;
const GW = Math.ceil((WORLD.maxX - WORLD.minX + 60) / CELL);
const GH = Math.ceil((WORLD.maxZ - WORLD.minZ + 60) / CELL);
const SLOTS = 9;
const MAX_STOPPED = 90;

/** Bit flags for the Saigon-style move a driver is making right now (HUD + stats). */
export const enum Act {
  /** Stopped at a red light with the front wheel past the stop line. */
  OverLine = 1,
  /** Went before the countdown hit zero. */
  JumpRed = 2,
  /** Approaching a flashing-amber junction. */
  Flash = 4,
  /** Pressed on through an amber that a calmer driver would have stopped for. */
  RunAmber = 8,
}

export const enum Reason {
  Free = 0,
  Follow = 1,
  Yield = 2,
  Signal = 3,
  Dwell = 4,
}

export interface TrafficKpi {
  count: number;
  avgKmh: number;
  congestion: number;
  waiting: number;
  mix: number[];
}

const tmpColor = new Color();

function linear(hex: number, out: Float32Array, i: number): void {
  tmpColor.setHex(hex);
  out[i * 3] = tmpColor.r;
  out[i * 3 + 1] = tmpColor.g;
  out[i * 3 + 2] = tmpColor.b;
}

/**
 * Struct-of-arrays traffic simulation. One fixed step advances every vehicle; render
 * code only reads these arrays, there is no per-vehicle object or UI state.
 */
export class Traffic {
  readonly net: Network;
  readonly signals: SignalSystem;
  readonly segs: Segment[];

  readonly active = new Uint8Array(CAPACITY);
  readonly type = new Uint8Array(CAPACITY);
  readonly uid = new Int32Array(CAPACITY);
  readonly seg = new Int32Array(CAPACITY);
  readonly nextSeg = new Int32Array(CAPACITY);
  readonly s = new Float32Array(CAPACITY);
  readonly l = new Float32Array(CAPACITY);
  readonly v = new Float32Array(CAPACITY);
  readonly vl = new Float32Array(CAPACITY);
  readonly x = new Float32Array(CAPACITY);
  readonly z = new Float32Array(CAPACITY);
  readonly hx = new Float32Array(CAPACITY);
  readonly hz = new Float32Array(CAPACITY);
  readonly prevX = new Float32Array(CAPACITY);
  readonly prevZ = new Float32Array(CAPACITY);
  readonly prevHx = new Float32Array(CAPACITY);
  readonly prevHz = new Float32Array(CAPACITY);
  readonly lean = new Float32Array(CAPACITY);
  readonly fade = new Float32Array(CAPACITY);
  readonly vDes = new Float32Array(CAPACITY);
  readonly len = new Float32Array(CAPACITY);
  readonly wid = new Float32Array(CAPACITY);
  readonly laneT = new Float32Array(CAPACITY);
  readonly creep = new Float32Array(CAPACITY);
  readonly stuck = new Float32Array(CAPACITY);
  readonly stopT = new Float32Array(CAPACITY);
  readonly age = new Float32Array(CAPACITY);
  readonly dist = new Float32Array(CAPACITY);
  readonly dwell = new Float32Array(CAPACITY);
  readonly committed = new Uint8Array(CAPACITY);
  readonly reason = new Uint8Array(CAPACITY);
  readonly ringTarget = new Int8Array(CAPACITY);
  readonly slotT = new Int8Array(CAPACITY);
  readonly busDone = new Int32Array(CAPACITY);
  readonly routeCtr = new Uint16Array(CAPACITY);
  /** Linear RGB: c1 = clothing/body paint, c2 = secondary paint. */
  readonly c1 = new Float32Array(CAPACITY * 3);
  readonly c2 = new Float32Array(CAPACITY * 3);
  /** Seconds spent crawling in a jam (drives bikes onto the sidewalk / wrong side). */
  readonly frustration = new Float32Array(CAPACITY);
  /** Remaining horn-blip display time and cooldown. */
  readonly honk = new Float32Array(CAPACITY);
  readonly honkCD = new Float32Array(CAPACITY);
  /** 1 while riding across the centre line against traffic. */
  readonly wrong = new Uint8Array(CAPACITY);
  /** Height lift while riding on the sidewalk (render only). */
  readonly elev = new Float32Array(CAPACITY);
  /** 1 while part of a crash; frozen until the incident clears. */
  readonly crashed = new Uint8Array(CAPACITY);
  /** 0 dry, 1 slowed by flood water, 2 pushing a flooded bike. */
  readonly wading = new Uint8Array(CAPACITY);
  /**
   * Driver personality, fixed per uid: aggressiveness (risk taking: wrong side, sidewalk, jumping the
   * light, horn) and caution (following distance, braking, personal space). Both 0–1.
   */
  readonly aggr = new Float32Array(CAPACITY);
  readonly caution = new Float32Array(CAPACITY);
  /** Seconds ridden against traffic on the current street; caps wrong-way runs to short stretches. */
  readonly wrongT = new Float32Array(CAPACITY);
  /** `Act` flags. */
  readonly act = new Uint8Array(CAPACITY);
  incidents: Incident[] = [];
  /** 0–1 global flood level; rises while it pours and recedes after. */
  floodLevel = 0;
  private nextIncidentT = 45;
  private incidentSeq = 0;
  private readonly uidIndex = new Map<number, number>();
  /** Every per-vehicle array with its stride, captured by snapshots. */
  private readonly stateArrays: { arr: { [k: number]: number }; stride: number }[];

  count = 0;
  hi = 0;
  target = 260;
  time = 0;
  hour = 8;
  rain = 0;
  private nextUid = 1;
  private spawnAcc = 0;
  private pendingType = -1;
  private rainApplied = false;
  private readonly rng = new Rng(0x5a16);
  private readonly free: number[] = [];
  private readonly cellHead = new Int32Array(GW * GH);
  private readonly cellNext = new Int32Array(CAPACITY);
  private readonly slotFree = new Float32Array(SLOTS);
  private readonly tmp = new Float32Array(4);
  private readonly mixCount = new Int32Array(VTYPE_COUNT);
  private readonly segMinS: Float32Array;
  private readonly segMinV: Float32Array;
  private readonly portalWeights: number[];
  /** People crossing the street; vehicles give way to them. */
  readonly peds: Pedestrians;
  /** 1 while the vehicle is held up by someone crossing. */
  readonly pedYield = new Uint8Array(CAPACITY);

  constructor(net: Network, signals: SignalSystem) {
    this.net = net;
    this.signals = signals;
    this.segs = net.segments;
    this.segMinS = new Float32Array(net.segments.length);
    this.segMinV = new Float32Array(net.segments.length);
    this.portalWeights = net.portalsIn.map((l) => (l.to?.kind === 'ring' ? 0.4 : 1));
    this.peds = new Pedestrians(net, signals);
    const one = [
      this.active, this.type, this.uid, this.seg, this.nextSeg, this.s, this.l, this.v, this.vl, this.x, this.z,
      this.hx, this.hz, this.prevX, this.prevZ, this.prevHx, this.prevHz, this.lean, this.fade, this.vDes, this.len,
      this.wid, this.laneT, this.creep, this.stuck, this.stopT, this.age, this.dist, this.dwell, this.committed,
      this.reason, this.ringTarget, this.slotT, this.busDone, this.routeCtr, this.frustration, this.honk, this.honkCD,
      this.wrong, this.elev, this.crashed, this.wading, this.pedYield, this.aggr, this.caution, this.wrongT, this.act,
    ];
    this.stateArrays = [...one.map((arr) => ({ arr, stride: 1 })), { arr: this.c1, stride: 3 }, { arr: this.c2, stride: 3 }];
    for (let i = CAPACITY - 1; i >= 0; i--) this.free.push(i);
  }

  // ---------------------------------------------------------------- spawning

  private chooseType(u: number): VType {
    const h = this.hour;
    const night = h < 5.5 || h >= 22;
    const rush = (h >= 7 && h < 9) || (h >= 17 && h < 19);
    this.mixCount.fill(0);
    for (let i = 0; i < this.hi; i++) if (this.active[i]) this.mixCount[this.type[i]]++;
    const base = SPECS.map((sp, t) => {
      let k = sp.weight;
      if (t === VType.Bus) k *= night ? 0.15 : 1;
      if (t === VType.Truck) k *= truckBanActive(h) ? 0 : night ? 2.6 : 0.7;
      if (t === VType.Cyclo) k *= h >= 8 && h < 18 ? 1.2 : 0.35;
      if (t === VType.Grab) k *= rush ? 1.25 : night ? 0.7 : 1;
      if (t === VType.TaxiMaiLinh || t === VType.TaxiVinasun) k *= night ? 1.8 : 1;
      return k;
    });
    const total = base.reduce((a, b) => a + b, 0);
    // Slow vehicles linger on the map, so steer spawns toward the intended on-map mix.
    const w = base.map((k, t) => {
      const expected = (k / total) * this.count;
      const corr = Math.max(0.15, Math.min(4, (expected + 1) / (this.mixCount[t] + 1)));
      return t === VType.Bus && this.mixCount[t] >= 9 ? 0 : k * corr;
    });
    return weightedIndex(w, u) as VType;
  }

  private alloc(type: VType, segId: number, s: number): number {
    const i = this.free.pop();
    if (i === undefined) return -1;
    const uid = this.nextUid++;
    const sp = SPECS[type];
    this.active[i] = 1;
    this.type[i] = type;
    this.uid[i] = uid;
    this.seg[i] = segId;
    this.s[i] = s;
    this.v[i] = sp.speed * 0.6;
    this.vl[i] = 0;
    // Personality: a triangular spread around the type's temper, so most drivers are middling.
    const aggr = Math.min(1, Math.max(0, (rand01(uid, 7) + rand01(uid, 8)) * 0.5 + sp.temper));
    this.aggr[i] = aggr;
    this.caution[i] = Math.min(1, Math.max(0, 0.6 * (1 - aggr) + 0.4 * rand01(uid, 9)));
    this.vDes[i] = sp.speed * (0.82 + 0.22 * aggr + 0.14 * rand01(uid, 1));
    this.len[i] = sp.length;
    this.wid[i] = sp.width;
    // How far past the stop line the front wheel ends up at a red: bold riders roll onto the zebra,
    // most cars stay behind it, a pushy few nose over.
    this.creep[i] = sp.swarm ? 0.2 + 3.6 * aggr * (0.6 + 0.4 * rand01(uid, 2)) : -0.3 + 2.4 * Math.max(0, aggr - 0.6);
    this.stuck[i] = 0;
    this.stopT[i] = 0;
    this.age[i] = 0;
    this.dist[i] = 0;
    this.dwell[i] = 0;
    this.committed[i] = 1;
    this.reason[i] = Reason.Free;
    this.ringTarget[i] = -1;
    this.slotT[i] = -1;
    this.busDone[i] = 0;
    this.routeCtr[i] = 0;
    this.lean[i] = 0;
    this.frustration[i] = 0;
    this.honk[i] = 0;
    this.honkCD[i] = 2 + 4 * rand01(uid, 5);
    this.wrong[i] = 0;
    this.wrongT[i] = 0;
    this.act[i] = 0;
    this.elev[i] = 0;
    this.crashed[i] = 0;
    this.wading[i] = 0;
    this.uidIndex.set(uid, i);
    this.assignColors(i);
    this.count++;
    if (i + 1 > this.hi) this.hi = i + 1;
    this.planNext(i);
    this.pickLane(i);
    const sg = this.segs[segId];
    this.l[i] = sp.swarm ? (rand01(uid, 4) * 2 - 1) * (sg.halfW - 0.5) : this.laneT[i];
    if (type === VType.Cyclo) this.l[i] = sg.halfW - 0.7;
    this.updatePose(i, 0);
    this.prevX[i] = this.x[i];
    this.prevZ[i] = this.z[i];
    this.prevHx[i] = this.hx[i];
    this.prevHz[i] = this.hz[i];
    return i;
  }

  private assignColors(i: number): void {
    const uid = this.uid[i];
    const pick = (arr: readonly number[], salt: number) => arr[Math.floor(rand01(uid, salt) * arr.length)];
    switch (this.type[i] as VType) {
      case VType.Moto:
        linear(this.rain > 0.5 ? pick(PONCHO_COLORS, 11) : pick(SHIRT_COLORS, 10), this.c1, i);
        linear(pick(BIKE_COLORS, 12), this.c2, i);
        break;
      case VType.Grab:
        linear(this.rain > 0.5 ? 0x2fbf6a : 0x00a651, this.c1, i);
        linear(0x00a651, this.c2, i);
        break;
      case VType.Car:
        linear(pick(CAR_COLORS, 13), this.c1, i);
        linear(0x2a2c30, this.c2, i);
        break;
      case VType.TaxiVinasun:
        linear(0xf4f3ee, this.c1, i);
        linear(0x0f8f4e, this.c2, i);
        break;
      case VType.TaxiMaiLinh:
        linear(0x0d8a4b, this.c1, i);
        linear(0xf3efe0, this.c2, i);
        break;
      case VType.Bus:
        linear(0x2f9e5a, this.c1, i);
        linear(0xf1e7c9, this.c2, i);
        break;
      case VType.Truck:
        linear(pick(TRUCK_CAB, 14), this.c1, i);
        linear(pick(TRUCK_BOX, 15), this.c2, i);
        break;
      case VType.Cyclo:
        linear(pick(CYCLO_HOOD, 16), this.c1, i);
        linear(0x24382c, this.c2, i);
        break;
    }
  }

  private release(i: number): void {
    this.active[i] = 0;
    this.uidIndex.delete(this.uid[i]);
    this.count--;
    this.free.push(i);
    if (i + 1 === this.hi) {
      while (this.hi > 0 && !this.active[this.hi - 1]) this.hi--;
    }
  }

  /** Decide the segment after the current one (route chosen one step ahead). */
  private planNext(i: number): void {
    const sg = this.segs[this.seg[i]];
    const uid = this.uid[i];
    if (sg.next.length === 0) {
      this.nextSeg[i] = -1;
      return;
    }
    if (sg.kind === SegKind.Ring && sg.ringExitArm >= 0) {
      this.nextSeg[i] = (sg.ringExitArm === this.ringTarget[i] ? sg.exitConns[0] : sg.next[0]).id;
      return;
    }
    if (sg.next.length === 1) {
      this.nextSeg[i] = sg.next[0].id;
      return;
    }
    const t = this.type[i] as VType;
    const heavy = t === VType.Bus || t === VType.Truck;
    const weights = sg.next.map((c) =>
      c.turn === Turn.Straight ? 0.55 : c.turn === Turn.Right ? (heavy ? 0.18 : 0.26) : heavy ? 0.12 : 0.19,
    );
    const u = rand01(uid, 100 + this.routeCtr[i]++);
    this.nextSeg[i] = sg.next[weightedIndex(weights, u)].id;
  }

  private pickLane(i: number): void {
    const sg = this.segs[this.seg[i]];
    const t = this.type[i] as VType;
    if (SPECS[t].swarm) return;
    if (sg.kind === SegKind.Ring) {
      this.laneT[i] = 1.2;
      return;
    }
    if (sg.kind !== SegKind.Link) return;
    if (t === VType.Bus) {
      this.laneT[i] = LANES[1];
      return;
    }
    const nx = this.nextSeg[i];
    const turn = nx >= 0 ? this.segs[nx].turn : Turn.Straight;
    const toRing = nx >= 0 && this.segs[nx].ringEntryArm >= 0;
    if (toRing || turn === Turn.Right) this.laneT[i] = LANES[1];
    else if (turn === Turn.Left) this.laneT[i] = LANES[0];
    else this.laneT[i] = rand01(this.uid[i], 200 + this.routeCtr[i]) < (t === VType.Truck ? 0.8 : 0.45) ? LANES[1] : LANES[0];
  }

  private enter(i: number, segId: number): void {
    const sg = this.segs[segId];
    this.seg[i] = segId;
    this.wrongT[i] = 0;
    if (sg.kind === SegKind.Conn) this.committed[i] = sg.fromLink ? 0 : 1;
    if (sg.ringEntryArm >= 0) {
      const n = this.net.ring.arms.length;
      const r = Math.floor(rand01(this.uid[i], 300 + this.routeCtr[i]++) * (n - 1));
      this.ringTarget[i] = (sg.ringEntryArm + 1 + r) % n;
    }
    this.slotT[i] = -1;
    this.planNext(i);
    this.pickLane(i);
  }

  private clearAt(x: number, z: number, r: number): boolean {
    for (let j = 0; j < this.hi; j++) {
      if (!this.active[j]) continue;
      const dx = this.x[j] - x;
      const dz = this.z[j] - z;
      const rr = r + this.len[j] * 0.5;
      if (dx * dx + dz * dz < rr * rr) return false;
    }
    return true;
  }

  /** Fill the map at boot so the first frame already looks like a living city. */
  populate(n: number): void {
    const links = this.net.links;
    const weights = links.map((l) => l.length);
    let attempts = n * 8;
    while (this.count < n && attempts-- > 0) {
      const link = links[weightedIndex(weights, this.rng.next())];
      const type = this.chooseType(this.rng.next());
      const s = 4 + this.rng.next() * Math.max(1, link.length - 10);
      const tmp = this.tmp;
      link.sample(s, tmp);
      if (!this.clearAt(tmp[0], tmp[1], SPECS[type].length * 0.5 + 1.2)) continue;
      this.alloc(type, link.id, s);
    }
  }

  private spawnTick(dt: number): void {
    this.spawnAcc += dt;
    if (this.spawnAcc < 0.06) return;
    this.spawnAcc = 0;
    if (this.count >= this.target) return;
    const portals = this.net.portalsIn;
    for (let k = 0; k < 8; k++) {
      // Arms feeding straight into the roundabout get less inflow so Bến Thành stays busy, not locked.
      const link = portals[weightedIndex(this.portalWeights, this.rng.next())];
      // A vehicle that found no room keeps its turn; otherwise small bikes always win the entry gap.
      const type = this.pendingType >= 0 ? (this.pendingType as VType) : this.chooseType(this.rng.next());
      const tmp = this.tmp;
      link.sample(0, tmp);
      const sp = SPECS[type];
      if (!this.clearAt(tmp[0] + tmp[2] * sp.length * 0.5, tmp[1] + tmp[3] * sp.length * 0.5, sp.length * 0.5 + 0.8)) {
        // Give it a second portal to try, then let someone else go.
        this.pendingType = this.pendingType === type ? -1 : type;
        continue;
      }
      this.pendingType = -1;
      this.alloc(type, link.id, 0.01);
      if (this.count >= this.target) break;
    }
  }

  setRain(rain: number): void {
    this.rain = rain;
    const raining = rain > 0.5;
    if (raining === this.rainApplied) return;
    this.rainApplied = raining;
    // Riders pull on their ponchos (áo mưa) when the rain starts.
    for (let i = 0; i < this.hi; i++) {
      if (this.active[i] && (this.type[i] === VType.Moto || this.type[i] === VType.Grab)) this.assignColors(i);
    }
  }

  // ---------------------------------------------------------------- stepping

  private rebuildGrid(): void {
    this.cellHead.fill(-1);
    this.segMinS.fill(Infinity);
    for (let i = 0; i < this.hi; i++) {
      if (!this.active[i]) continue;
      const cx = Math.min(GW - 1, Math.max(0, Math.floor((this.x[i] - GX0) / CELL)));
      const cz = Math.min(GH - 1, Math.max(0, Math.floor((this.z[i] - GZ0) / CELL)));
      const c = cz * GW + cx;
      this.cellNext[i] = this.cellHead[c];
      this.cellHead[c] = i;
      const sg = this.seg[i];
      if (this.s[i] < this.segMinS[sg]) {
        this.segMinS[sg] = this.s[i];
        this.segMinV[sg] = this.v[i];
      }
    }
  }

  step(dt: number, t: number): void {
    this.time = t;
    this.signals.flashing = flashHours(this.hour);
    // Low spots fill within ~30 s of a downpour and drain over ~90 s.
    this.floodLevel = Math.min(1, Math.max(0, this.floodLevel + dt * (this.rain > 0.6 ? 0.03 : -0.011)));
    this.peds.step(dt, t, this.hour, this.rain);
    this.updateIncidents(t);
    this.rebuildGrid();
    const rainF = 1 - 0.24 * this.rain;
    for (let i = 0; i < this.hi; i++) {
      if (!this.active[i]) continue;
      this.prevX[i] = this.x[i];
      this.prevZ[i] = this.z[i];
      this.prevHx[i] = this.hx[i];
      this.prevHz[i] = this.hz[i];
      if (this.crashed[i]) continue;
      this.updateVehicle(i, dt, t, rainF);
    }
    this.spawnTick(dt);
  }

  // ---------------------------------------------------------------- incidents

  private updateIncidents(t: number): void {
    for (let k = this.incidents.length - 1; k >= 0; k--) {
      const inc = this.incidents[k];
      if (t < inc.end) continue;
      // Cleared: the riders pick themselves up and carry on.
      for (const uid of inc.uids) {
        const i = this.uidIndex.get(uid);
        if (i === undefined) continue;
        this.crashed[i] = 0;
        this.lean[i] = 0;
        this.stopT[i] = 0;
      }
      this.incidents.splice(k, 1);
    }
    if (t < this.nextIncidentT) return;
    this.nextIncidentT = t + this.rng.range(70, 150);
    if (this.incidents.length >= 2 || this.rng.next() > 0.75) return;
    const links = this.net.links.filter((l) => l.length > 60 && !l.road?.bridge);
    const link = links[this.rng.int(links.length)];
    const s = this.rng.range(18, link.length - 24);
    const tmp = this.tmp;
    link.sample(s, tmp);
    if (!this.clearAt(tmp[0], tmp[1], 4)) return;
    const pair: VType[] = this.rng.next() < 0.55 ? [VType.Car, VType.Moto] : this.rng.next() < 0.5 ? [VType.Moto, VType.Moto] : [VType.TaxiVinasun, VType.Grab];
    const lane = LANES[this.rng.int(2)];
    const uids: number[] = [];
    pair.forEach((type, k) => {
      const i = this.alloc(type, link.id, s + k * 3.4);
      if (i < 0) return;
      this.crashed[i] = 1;
      this.v[i] = 0;
      this.l[i] = lane + (k === 0 ? 0 : 0.9);
      this.updatePose(i, 0);
      // Skewed car, bike down on its side.
      const yaw = k === 0 ? 0.32 : -0.9;
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      const hx = this.hx[i] * c - this.hz[i] * sn;
      const hz = this.hx[i] * sn + this.hz[i] * c;
      this.hx[i] = this.prevHx[i] = hx;
      this.hz[i] = this.prevHz[i] = hz;
      this.prevX[i] = this.x[i];
      this.prevZ[i] = this.z[i];
      this.lean[i] = SPECS[type].swarm ? 1.3 : 0;
      uids.push(this.uid[i]);
    });
    if (uids.length < 2) return;
    const what = pair[0] === VType.Moto ? 'Hai xe máy va quẹt' : `${SPECS[pair[0]].label} va chạm xe máy`;
    this.incidents.push({
      id: ++this.incidentSeq,
      linkId: link.id,
      x: tmp[0],
      z: tmp[1],
      start: t,
      end: t + this.rng.range(70, 120),
      uids,
      road: link.name,
      desc: what,
    });
  }

  /**
   * Flashing-amber junction: should vehicle `i` (approaching on `group`) hold at the line? Yes while
   * crossing-street traffic is inside the box, or (unless `bold`) when someone at the crossing
   * street's line has waited a good while longer than us — a moving platoon keeps going for a few
   * seconds, then the other street gets its turn. Pushier drivers take longer to concede.
   */
  private flashYield(i: number, nodeIndex: number, group: number, bold: boolean): boolean {
    const node = this.signals.plans[nodeIndex].node;
    const cx0 = Math.max(0, Math.floor((node.x - 24 - GX0) / CELL));
    const cx1 = Math.min(GW - 1, Math.floor((node.x + 24 - GX0) / CELL));
    const cz0 = Math.max(0, Math.floor((node.z - 24 - GZ0) / CELL));
    const cz1 = Math.min(GH - 1, Math.floor((node.z + 24 - GZ0) / CELL));
    const concedeAt = this.stopT[i] + 2 + 6 * this.aggr[i];
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let j = this.cellHead[cz * GW + cx]; j !== -1; j = this.cellNext[j]) {
          const sj = this.segs[this.seg[j]];
          const sig = sj.kind === SegKind.Conn ? sj.fromLink?.signal : sj.kind === SegKind.Link ? sj.signal : null;
          if (!sig || sig.nodeIndex !== nodeIndex || sig.group === group) continue;
          // Crossing traffic moving through the box blocks us (riders still creeping past their line
          // only once they actually go for it); a stopped committed one is just queued for its exit.
          if (sj.kind === SegKind.Conn) {
            if (this.v[j] > (this.committed[j] ? 0.8 : 2.5)) return true;
            if (this.committed[j]) continue;
          }
          // Only the ones actually holding at the line count (not the queue behind them). Bold riders
          // concede too, just much later.
          const atLine = sj.kind === SegKind.Conn || sj.length - this.s[j] - this.len[j] * 0.5 < 3;
          if (atLine && this.reason[j] === Reason.Yield && this.stopT[j] > concedeAt + (bold ? 10 : 0)) return true;
        }
      }
    }
    return false;
  }

  private updateVehicle(i: number, dt: number, t: number, rainF: number): void {
    const segs = this.segs;
    const type = this.type[i] as VType;
    const sp = SPECS[type];
    const swarm = sp.swarm;
    let sg = segs[this.seg[i]];
    const s = this.s[i];
    let v = this.v[i];
    const li = this.l[i];
    const xi = this.x[i];
    const zi = this.z[i];
    const hxi = this.hx[i];
    const hzi = this.hz[i];
    const rgx = -hzi;
    const rgz = hxi;
    const tmp = this.tmp;
    sg.sample(s, tmp);
    const rtx = -tmp[3];
    const rtz = tmp[2];
    const myPrio = sg.priority;
    const lenI = this.len[i];
    const widI = this.wid[i];
    const halfRange = sg.halfW - (swarm ? 0.45 : widI * 0.5 + 0.2);
    const uidI = this.uid[i];
    const aggr = this.aggr[i];
    const caution = this.caution[i];
    // Personal IDM parameters: bold drivers accelerate harder and sit closer; cautious ones keep a
    // longer time gap, a bigger stopping gap and brake earlier and softer.
    const aMax = sp.accel * (0.8 + 0.4 * aggr);
    const bComf = sp.brake * (1.15 - 0.3 * caution);
    const headway = sp.headway * (0.65 + 0.7 * caution);
    const s0 = sp.s0 * (0.75 + 0.5 * caution);
    // Jammed riders widen their options, bolder ones sooner: crossing the centre line for a short
    // stretch (capped by `wrongT`), the boldest mounting the sidewalk.
    let lo = -halfRange;
    let hi = halfRange;
    if (swarm && type !== VType.Cyclo && sg.kind === SegKind.Link && s > 10 && sg.length - s > 18) {
      const fr = this.frustration[i];
      if (aggr > 0.5 && fr > 2 - 1.2 * aggr && this.wrongT[i] < 3 + 5 * aggr) lo = -halfRange - 2.4;
      if (aggr > 0.62 && fr > 3.2 - 2 * aggr && !sg.road?.bridge) hi = sg.halfW + 1.05;
    }

    // ---- perception: leader in own corridor, free distance per lateral slot, and (bikes) the
    // social-force push from everyone close by
    const L = swarm ? 16 : Math.min(34, 12 + v * 2.2);
    let gap = Infinity;
    let leadV = 0;
    let reason: Reason = Reason.Free;
    // Social force on a rider, in its own frame (m/s²): forward and to the right.
    let fLong = 0;
    let fLat = 0;
    // Personal space: cautious riders keep a wider bubble, bold ones brush past.
    const sfB = 0.22 + 0.25 * caution;
    // Cars only change lanes when the neighbouring lane is clear of other cars alongside.
    let blockRight = false;
    let blockLeft = false;
    const slotFree = this.slotFree;
    slotFree.fill(L);
    const slot0 = lo;
    const slotStep = (hi - lo) / (SLOTS - 1);
    let leadIdx = -1;
    /** Wrong-way rider facing oncoming traffic must return to its own side. */
    let giveBack = false;
    let pedBlock = false;
    const qx = xi + hxi * L * 0.45;
    const qz = zi + hzi * L * 0.45;
    const qr = L * 0.55 + 3;
    const cx0 = Math.max(0, Math.floor((qx - qr - GX0) / CELL));
    const cx1 = Math.min(GW - 1, Math.floor((qx + qr - GX0) / CELL));
    const cz0 = Math.max(0, Math.floor((qz - qr - GZ0) / CELL));
    const cz1 = Math.min(GH - 1, Math.floor((qz + qr - GZ0) / CELL));
    const maxD2 = (L + 4) * (L + 4);
    const stuckI = this.stuck[i];
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let j = this.cellHead[cz * GW + cx]; j !== -1; j = this.cellNext[j]) {
          if (j === i) continue;
          const rx = this.x[j] - xi;
          const rz = this.z[j] - zi;
          if (rx * rx + rz * rz > maxD2) continue;
          const f = rx * hxi + rz * hzi;
          if (f < -4) continue;
          const dotH = hxi * this.hx[j] + hzi * this.hz[j];
          if (dotH < -0.55) {
            // Oncoming traffic normally stays on its own side, but wrong-way riders meet it head-on.
            if (f <= 0) continue;
            const latO = rx * rgx + rz * rgz;
            const hwO = (widI + this.wid[j]) * 0.5;
            const gfO = f - (lenI + this.len[j]) * 0.5;
            if (swarm) {
              // Closing speed halves the usable gap in that slot.
              const la = li + rx * rtx + rz * rtz;
              for (let k = 0; k < SLOTS; k++) {
                if (Math.abs(la - (slot0 + k * slotStep)) < hwO + 0.3 && gfO * 0.5 < slotFree[k]) slotFree[k] = gfO * 0.5;
              }
            }
            // The wrong-way rider gives way; legal oncoming traffic only stops at the last moment.
            const facing = Math.abs(latO) < hwO + 0.2;
            if (facing && this.wrong[i] && gfO < 9) giveBack = true;
            // A wrong-way rider feels oncoming traffic shove it back toward its own side.
            if (swarm && this.wrong[i] && Math.abs(latO) < hwO + 1.5 && gfO < 10) fLat += 2.5 * Math.exp(-Math.max(0, gfO) / 3);
            if (facing && ((this.wrong[i] && gfO < gap) || (this.wrong[j] && gfO < 2.5 && gfO < gap))) {
              gap = gfO;
              leadV = 0;
              leadIdx = j;
              reason = Reason.Yield;
            }
            continue;
          }
          // Circulating traffic ignores entrants still waiting at the give-way line.
          if (myPrio === 2 && this.v[j] < 1.5 && segs[this.seg[j]].priority === 1) continue;
          const lat = rx * rgx + rz * rgz;
          const hl = (lenI + this.len[j]) * 0.5;
          const hw = (widI + this.wid[j]) * 0.5;
          if (swarm) {
            // Hard side constraint: never steer into someone riding alongside.
            if (Math.abs(f) < hl && Math.abs(lat) < hw + 0.35) {
              if (lat > 0) blockRight = true;
              else blockLeft = true;
            }
            // Social force (Helbing-style, anisotropic): exponential push away from each neighbour,
            // measured on an ellipse so side clearance counts double; overlap pushes hardest.
            const dl = Math.abs(f) - hl;
            const dw = Math.abs(lat) - hw;
            if (dl < 5 && dw < 1.6) {
              const d = dl > 0 || dw > 0 ? Math.hypot(Math.max(0, dl) * 0.5, Math.max(0, dw)) : Math.max(dl, dw);
              const n = Math.hypot(f, lat) || 1;
              // Someone ahead matters; someone behind much less.
              const w = 0.3 + 0.35 * (1 + f / n);
              const mag = (SPECS[this.type[j]].swarm ? 1.6 : 2.6) * w * Math.exp(Math.min(2, -d / sfB));
              // Dead-ahead neighbours give no side cue; break the tie by uid.
              fLat -= mag * (Math.abs(lat) > 0.05 ? lat / n : uidI & 1 ? 0.25 : -0.25);
              // Squeezed from the diagonal ahead → ease off (the one dead ahead is the IDM leader's job).
              if (f > 0 && dw >= 0.1) fLong -= mag * (f / n) * 0.6;
            }
          }
          if (!swarm && !SPECS[this.type[j]].swarm && Math.abs(f) < hl + 2 && Math.abs(lat) > 0.6 && Math.abs(lat) < hw + 2.6) {
            if (lat > 0) blockRight = true;
            else blockLeft = true;
          }
          if (f <= 0) continue;
          const crossing = dotH < 0.5;
          if (crossing) {
            if (segs[this.seg[j]].priority < myPrio) continue;
            if (stuckI > 5) continue;
          }
          // Both see each other ahead: deterministic tie-break so they never deadlock.
          const fj = -(rx * this.hx[j] + rz * this.hz[j]);
          if (fj > 0) {
            const latj = -(rx * -this.hz[j] + rz * this.hx[j]);
            // Never apply the tie-break once footprints touch, so vehicles can't pass through each other.
            if (Math.abs(latj) < hw + 0.4 && this.uid[i] < this.uid[j] && f - hl > 0.4) continue;
          }
          const gf = f - hl;
          if (Math.abs(lat) < hw + (swarm ? 0.1 : 0.3) && gf < gap) {
            gap = gf;
            leadV = crossing ? 0 : this.v[j] * dotH;
            leadIdx = j;
            reason = crossing ? Reason.Yield : Reason.Follow;
          }
          if (swarm) {
            const la = li + rx * rtx + rz * rtz;
            const reach = hw + 0.1;
            for (let k = 0; k < SLOTS; k++) {
              if (Math.abs(la - (slot0 + k * slotStep)) < reach && gf < slotFree[k]) slotFree[k] = gf;
            }
          }
        }
      }
    }

    // ---- people on the road: everyone gives way; bikes also look for a way around
    const peds = this.peds;
    for (let p = 0; p < peds.hi; p++) {
      if (!peds.active[p]) continue;
      const rx = peds.x[p] - xi;
      const rz = peds.z[p] - zi;
      if (rx * rx + rz * rz > maxD2) continue;
      const f = rx * hxi + rz * hzi;
      if (f <= 0) continue;
      const lat = rx * rgx + rz * rgz;
      const hw = widI * 0.5 + PED_RADIUS;
      const gf = f - lenI * 0.5 - PED_RADIUS;
      if (Math.abs(lat) < hw + (swarm ? 0.2 : 0.6) && gf < gap) {
        gap = gf;
        leadV = 0;
        leadIdx = -1;
        reason = Reason.Yield;
        pedBlock = true;
      }
      if (swarm) {
        const la = li + rx * rtx + rz * rtz;
        for (let k = 0; k < SLOTS; k++) {
          if (Math.abs(la - (slot0 + k * slotStep)) < hw + 0.2 && gf < slotFree[k]) slotFree[k] = gf;
        }
        // People get a wide berth: a stronger push than another bike.
        const dw = Math.abs(lat) - hw;
        if (gf < 4 && dw < 1.2) {
          const d = Math.hypot(Math.max(0, gf) * 0.5, Math.max(0, dw));
          const n = Math.hypot(f, lat) || 1;
          fLat -= 2.2 * Math.exp(Math.min(2, -d / sfB)) * (Math.abs(lat) > 0.05 ? lat / n : uidI & 1 ? 0.25 : -0.25);
        }
      }
    }
    this.pedYield[i] = pedBlock ? 1 : 0;

    // ---- roundabout: skip a jammed exit and go round again rather than lock the ring
    if (sg.kind === SegKind.Ring && sg.ringExitArm >= 0 && sg.ringExitArm === this.ringTarget[i]) {
      const exit = sg.exitConns[0];
      const out = exit.next[0];
      const need = swarm ? 1.5 : lenI + 2;
      const blocked =
        (this.segMinS[exit.id] < need && this.segMinV[exit.id] < 1.5) ||
        (this.segMinS[out.id] < need + 2 && this.segMinV[out.id] < 1.5);
      this.nextSeg[i] = blocked ? sg.next[0].id : exit.id;
    }

    // ---- signals
    let stopD = Infinity;
    let stopReason: Reason = Reason.Signal;
    let vCap = Infinity;
    const nx = this.nextSeg[i];
    let sigLink: Segment | null = null;
    let distLine = 0;
    let turn: Turn = Turn.Straight;
    if (sg.kind === SegKind.Link && sg.signal) {
      sigLink = sg;
      distLine = sg.length - s;
      turn = nx >= 0 ? segs[nx].turn : Turn.Straight;
    } else if (sg.kind === SegKind.Conn && sg.fromLink && !this.committed[i]) {
      sigLink = sg.fromLink;
      distLine = -s;
      turn = sg.turn;
    }
    // Junction moves stay flagged while crossing the box so the HUD can show them.
    let act = sg.kind === SegKind.Conn ? this.act[i] & (Act.JumpRed | Act.RunAmber) : 0;
    if (sigLink && sigLink.signal) {
      const sr = sigLink.signal;
      const st = this.signals.query(sr.nodeIndex, sr.group, t);
      // Front-bumper distance to where this vehicle stops; `creep` (personality) is how far past the
      // stop line it rolls: bold riders end up on the zebra, most cars stay just behind it.
      const lineGap = distLine - lenI * 0.5 + this.creep[i];
      let mustStop = false;
      let jam = false;
      if (lineGap > -0.4) {
        if (st.light === Light.Flash) {
          // Late-night flashing amber: no one has right of way, so slow down and look (bold drivers
          // barely lift off), then go only when the box is clear of crossing traffic and nobody on
          // the crossing street has been waiting longer. Bold riders skip the courtesy part.
          if (distLine < 20) {
            vCap = 2.5 + 6.5 * aggr * (1 - 0.5 * caution);
            act |= Act.Flash;
          }
          if (lineGap < 4 && this.flashYield(i, sr.nodeIndex, sr.group, swarm && aggr > 0.75)) {
            mustStop = true;
            stopReason = Reason.Yield;
          }
        } else if (st.light !== Light.Green) {
          const rightOnRed = turn === Turn.Right && !sigLink.noRightOnRed;
          if (rightOnRed) {
            if (!swarm && distLine < 16) vCap = 4.5;
          } else if (st.light === Light.Amber) {
            // Calm drivers stop whenever they can do it at all; bold ones only if it's comfortable.
            const brakeDist = (v * v) / (2 * sp.brake);
            mustStop = lineGap > brakeDist / (1.5 - 0.7 * aggr) + 0.4;
            if (!mustStop && lineGap > brakeDist / 1.5 + 0.4 && distLine > 0) act |= Act.RunAmber;
          } else {
            // The countdown invites going on the last second or two of red (cross traffic is in
            // its all-red clearance by then). Mostly bikes; only the pushiest car drivers.
            const jump = aggr > 0.72 && (swarm || aggr > 0.85) && st.remaining < Math.min(1.8, 4 * (aggr - 0.6));
            mustStop = !jump;
            if (jump && distLine > -2) act |= Act.JumpRed;
            else if (v < 1 && distLine - lenI * 0.5 < -0.6) act |= Act.OverLine;
          }
        }
        // Cars don't enter the box when the exit is backed up (bikes squeeze through anyway).
        if (!mustStop && !swarm && sg.kind === SegKind.Link && nx >= 0) {
          const out = segs[nx].next[0];
          if (out && this.segMinS[out.id] < lenI + 4 && this.segMinV[out.id] < 1) {
            mustStop = true;
            jam = true;
          }
        }
      }
      if (mustStop) {
        stopD = lineGap + s0;
        if (jam) stopReason = Reason.Follow;
      } else if (sg.kind === SegKind.Conn && s > (swarm ? this.creep[i] : 0.3)) this.committed[i] = 1;
    }
    this.act[i] = act;

    // ---- roundabout entry: yield to circulating traffic
    if (sg.merge && sg.length - s < 18) {
      const m = sg.merge;
      const mcx0 = Math.max(0, Math.floor((m.x - 16 - GX0) / CELL));
      const mcx1 = Math.min(GW - 1, Math.floor((m.x + 16 - GX0) / CELL));
      const mcz0 = Math.max(0, Math.floor((m.z - 16 - GZ0) / CELL));
      const mcz1 = Math.min(GH - 1, Math.floor((m.z + 16 - GZ0) / CELL));
      const window = swarm ? 1.0 : 1.9;
      // After a few seconds of waiting, drivers nose in; only a vehicle actually moving
      // through the merge still stops them (a stopped one is waiting for us).
      const patient = this.stopT[i] < (swarm ? 1.5 : 4.5) * (0.5 + caution);
      let yieldNow = false;
      for (let cz = mcz0; cz <= mcz1 && !yieldNow; cz++) {
        for (let cx = mcx0; cx <= mcx1 && !yieldNow; cx++) {
          for (let j = this.cellHead[cz * GW + cx]; j !== -1; j = this.cellNext[j]) {
            const sj = this.seg[j];
            for (const up of m.upstream) {
              if (up.seg.id !== sj) continue;
              const d = up.seg.length - this.s[j] + up.extra;
              const vj = this.v[j];
              // Impatient drivers only stop for a moving vehicle about to hit them.
              const block = patient
                ? d < 3.5 + this.len[j] * 0.5 || (d < 15 && d / Math.max(vj, 1.5) < window)
                : vj > 2 && d < 6;
              if (block) yieldNow = true;
            }
            if (yieldNow) break;
          }
        }
      }
      // Give-way line sits at the ring's outer edge, not on the circulating lane.
      const mergeGap = sg.length - s - (swarm ? 5.5 : 7) - lenI * 0.5 + s0;
      if (yieldNow && mergeGap < stopD) {
        stopD = mergeGap;
        stopReason = Reason.Yield;
      }
    }

    // ---- bus stops
    if (type === VType.Bus && sg.busStopS >= 0 && this.busDone[i] !== sg.id + 1) {
      const d = sg.busStopS - s;
      if (this.dwell[i] > 0) {
        this.dwell[i] -= dt;
        if (this.dwell[i] <= 0) this.busDone[i] = sg.id + 1;
        else {
          stopD = 0;
          stopReason = Reason.Dwell;
        }
      } else if (d > -1) {
        if (d < 0.8 && v < 0.6) {
          this.dwell[i] = 7 + 4 * rand01(this.uid[i], 400 + sg.id);
        } else if (d + s0 < stopD) {
          stopD = d + s0;
          stopReason = Reason.Dwell;
        }
      }
    }

    // ---- longitudinal (IDM)
    let vd = Math.min(this.vDes[i], sg.speedLimit * (swarm ? 0.95 : 1)) * rainF;
    if (sg.kind === SegKind.Link && nx >= 0) {
      const vt = segs[nx].speedLimit * rainF;
      const dEnd = Math.max(0, sg.length - s - 1);
      vd = Math.min(vd, Math.sqrt(vt * vt + 2 * 2.2 * dEnd));
    }
    // ---- events: rubbernecking near crashes, wading through flood water
    for (const inc of this.incidents) {
      const dx = inc.x - xi;
      const dz = inc.z - zi;
      if (dx * dx + dz * dz < 900) vd *= 0.6;
    }
    let wading = 0;
    if (this.floodLevel > 0.05) {
      for (const fz of FLOOD_ZONES) {
        const dx = fz.x - xi;
        const dz = fz.z - zi;
        const d2 = dx * dx + dz * dz;
        if (d2 > fz.r * fz.r) continue;
        const depth = this.floodLevel * fz.depth * (1 - (Math.sqrt(d2) / fz.r) * 0.5);
        if (depth < 0.08) continue;
        wading = 1;
        vd = vd * (1 - depth) + Math.min(vd, swarm ? 2.6 : 3.6) * depth;
        // A few scooters drown their engines and get pushed through.
        if (swarm && depth > 0.55 && rand01(uidI, 70) < 0.12) {
          vd = Math.min(vd, 0.9);
          wading = 2;
        }
      }
    }
    this.wading[i] = wading;
    vd = Math.max(0.9, Math.min(vd, vCap));
    if (!swarm && leadIdx >= 0 && this.crashed[leadIdx] && gap < 40 && sg.kind === SegKind.Link) {
      // Steer around the wreck into the other lane.
      this.laneT[i] = Math.abs(this.l[leadIdx] - LANES[0]) < Math.abs(this.l[leadIdx] - LANES[1]) ? LANES[1] : LANES[0];
    }
    let g = gap;
    let vL = leadV;
    if (stopD < g) {
      g = stopD;
      vL = 0;
      reason = stopReason;
    }
    let acc: number;
    const ratio = v / vd;
    const free = 1 - ratio * ratio * ratio * ratio;
    if (g < Infinity) {
      const sStar = s0 + Math.max(0, v * headway + (v * (v - vL)) / (2 * Math.sqrt(aMax * bComf)));
      const q = sStar / Math.max(g, 0.08);
      acc = aMax * (free - q * q);
    } else {
      acc = aMax * free;
    }
    // Bikes: the along-road part of the social force (squeezed from the diagonal ahead → ease off).
    if (swarm) acc += Math.max(-4, fLong);
    if (acc < -9) acc = -9;
    v += acc * dt;
    if (v < 0 || g <= 0) v = 0;

    // ---- lateral
    let vlat = this.vl[i];
    if (swarm) {
      if (stopD < Infinity) for (let k = 0; k < SLOTS; k++) if (stopD < slotFree[k]) slotFree[k] = stopD;
      let turnPref = 0;
      if (type === VType.Cyclo) turnPref = 1;
      else if (sg.kind === SegKind.Link && nx >= 0) {
        const tn = segs[nx].turn;
        if (sg.length - s < 45) turnPref = segs[nx].ringEntryArm >= 0 ? 0.6 : tn;
      } else if (sg.kind === SegKind.Ring) {
        turnPref = sg.ringExitArm === this.ringTarget[i] && sg.length - s < 12 ? 1 : -0.4;
      }
      let best = 0;
      let bestScore = -Infinity;
      // A slowly drifting preferred line so riders weave instead of tracking rails.
      const r1 = rand01(uidI, 52);
      const wanderPos = halfRange * 0.7 * Math.sin(t * (0.05 + 0.09 * r1) + r1 * 40);
      for (let k = 0; k < SLOTS; k++) {
        const pos = slot0 + k * slotStep;
        let sc = Math.min(slotFree[k], L) - 1.35 * Math.abs(pos - li);
        sc -= (halfRange - pos) * 0.12;
        if (turnPref > 0) sc -= (halfRange - pos) * 1.1 * turnPref;
        else if (turnPref < 0) sc -= (pos + halfRange) * 1.1 * -turnPref;
        if (k === this.slotT[i]) sc += 1.1;
        sc -= 0.3 * Math.abs(pos - wanderPos);
        // Wrong side only into a genuinely clear stretch, and never while facing someone.
        if (pos < -halfRange && (giveBack || slotFree[k] < 8)) continue;
        if (pos < -halfRange) sc -= 1.0;
        if (pos > halfRange) sc -= 1.2; // sidewalk
        if (sc > bestScore) {
          bestScore = sc;
          best = k;
        }
      }
      this.slotT[i] = best;
      const target = slot0 + best * slotStep;
      const maxLat = type === VType.Cyclo ? 0.5 : 0.55 + 0.17 * v;
      // Social force across the road: a driving term relaxing toward the chosen gap (bold riders
      // react quicker), plus the summed push of neighbours, people and the edges of the usable road.
      fLat += 1.5 * Math.exp(Math.min(2, (lo - li) / 0.18)) - 1.5 * Math.exp(Math.min(2, (li - hi) / 0.18));
      const desired = Math.max(-maxLat, Math.min(maxLat, (target - li) * 1.7));
      const tau = 0.24 - 0.08 * aggr;
      vlat += ((desired - vlat) / tau + Math.max(-6, Math.min(6, fLat))) * dt;
      vlat = Math.max(-maxLat - 0.6, Math.min(maxLat + 0.6, vlat));
      if ((vlat > 0 && blockRight) || (vlat < 0 && blockLeft)) vlat = 0;
    } else {
      const target = sg.kind === SegKind.Conn ? li : this.laneT[i];
      let desired = Math.max(-1.1, Math.min(1.1, (target - li) * 0.9)) * Math.min(1, v / 4);
      if ((desired > 0 && blockRight) || (desired < 0 && blockLeft)) desired = 0;
      vlat += (desired - vlat) * Math.min(1, dt * 3);
    }
    let lNew = li + vlat * dt;
    // Riders already outside the normal range drift back in rather than snapping.
    const minL = swarm ? Math.min(lo, li) : -halfRange;
    const maxL = swarm ? Math.max(hi, li) : halfRange;
    if (lNew > maxL) {
      lNew = maxL;
      if (vlat > 0) vlat = 0;
    } else if (lNew < minL) {
      lNew = minL;
      if (vlat < 0) vlat = 0;
    }

    // ---- bookkeeping
    if (v < 0.3) this.stopT[i] += dt;
    else this.stopT[i] = 0;
    if (v < 0.3 && reason === Reason.Yield) this.stuck[i] += dt;
    else if (v > 1) this.stuck[i] = 0;
    this.reason[i] = reason;
    const jammed = reason === Reason.Follow || reason === Reason.Yield;
    if (swarm && jammed && v < 2.5) this.frustration[i] = Math.min(8, this.frustration[i] + dt);
    else this.frustration[i] = Math.max(0, this.frustration[i] - dt * 0.6);
    this.wrong[i] = sg.kind === SegKind.Link && lNew < -sg.halfW - 0.1 ? 1 : 0;
    if (this.wrong[i]) this.wrongT[i] += dt;
    // Horn: blocked drivers lean on it now and then (deterministic per half-second); bold ones far
    // more often, and they also honk at a slow leader without waiting to stop.
    this.honk[i] = Math.max(0, this.honk[i] - dt);
    this.honkCD[i] -= dt;
    const impatient = aggr > 0.7 && reason === Reason.Follow && v < vd * 0.5 && gap < 5;
    if (((jammed && v < 2 && gap < 7 && this.stopT[i] > 0.6) || impatient) && this.honkCD[i] <= 0) {
      if (rand01(uidI, 600 + Math.floor(t * 2)) < (swarm ? 0.03 : 0.07) * (0.25 + 1.5 * aggr)) {
        this.honk[i] = 0.9;
        this.honkCD[i] = (10 + 15 * rand01(uidI, 601 + Math.floor(t))) * (1.3 - 0.6 * aggr);
      }
    }
    // Last-resort unjam, only inside junctions/the ring and never for an ordinary queue on a street:
    // a driver boxed in mid-junction for 90 s gives up and leaves.
    if (this.stopT[i] > MAX_STOPPED && sg.kind !== SegKind.Link && (reason === Reason.Yield || reason === Reason.Follow)) {
      this.release(i);
      return;
    }

    // ---- advance along the path
    let sNew = s + v * dt;
    this.dist[i] += v * dt;
    this.age[i] += dt;
    while (sNew >= sg.length) {
      const n2 = this.nextSeg[i];
      if (n2 < 0) {
        this.release(i);
        return;
      }
      sNew -= sg.length;
      this.enter(i, n2);
      sg = segs[n2];
    }
    this.s[i] = sNew;
    this.v[i] = v;
    this.vl[i] = vlat;
    this.l[i] = lNew;
    this.updatePose(i, dt);
  }

  private updatePose(i: number, dt: number): void {
    const sg = this.segs[this.seg[i]];
    const tmp = this.tmp;
    const s = this.s[i];
    sg.sample(s, tmp);
    const tx = tmp[2];
    const tz = tmp[3];
    const rx = -tz;
    const rz = tx;
    const l = this.l[i];
    this.x[i] = tmp[0] + rx * l;
    this.z[i] = tmp[1] + rz * l;
    const v = this.v[i];
    const vl = this.vl[i];
    const swarm = SPECS[this.type[i]].swarm;
    const ohx = this.hx[i];
    const ohz = this.hz[i];
    let hx: number;
    let hz: number;
    if (dt === 0) {
      hx = tx;
      hz = tz;
    } else if (swarm) {
      // Bikes point where they actually move, so weaving is visible.
      const mvx = tx * v + rx * vl;
      const mvz = tz * v + rz * vl;
      const m = Math.hypot(mvx, mvz);
      if (m > 0.35) {
        const k = Math.min(1, dt * 9);
        hx = ohx + (mvx / m - ohx) * k;
        hz = ohz + (mvz / m - ohz) * k;
      } else {
        hx = ohx;
        hz = ohz;
      }
    } else {
      const k = Math.max(-0.35, Math.min(0.35, vl / Math.max(v, 2)));
      hx = tx + rx * k;
      hz = tz + rz * k;
    }
    const hm = Math.hypot(hx, hz) || 1;
    hx /= hm;
    hz /= hm;
    this.hx[i] = hx;
    this.hz[i] = hz;
    if (dt > 0 && swarm) {
      const omega = (ohx * hz - ohz * hx) / dt;
      const target = Math.max(-0.42, Math.min(0.42, omega * v * 0.08));
      this.lean[i] += (target - this.lean[i]) * Math.min(1, dt * 6);
    }
    let fade = 1;
    if (sg.portalIn && s < 5) fade = s / 5;
    if (sg.portalOut && sg.length - s < 5) fade = Math.max(0, (sg.length - s) / 5);
    this.fade[i] = Math.max(0.02, fade);
    this.elev[i] = sg.kind === SegKind.Link ? Math.min(1, Math.max(0, (l - sg.halfW) / 0.5)) * 0.15 : 0;
  }

  // ---------------------------------------------------------------- queries

  kpi(out: TrafficKpi): TrafficKpi {
    let sumV = 0;
    let sumD = 0;
    let n = 0;
    let waiting = 0;
    this.mixCount.fill(0);
    const rainF = 1 - 0.24 * this.rain;
    for (let i = 0; i < this.hi; i++) {
      if (!this.active[i]) continue;
      n++;
      sumV += this.v[i];
      sumD += Math.min(this.vDes[i], this.segs[this.seg[i]].speedLimit) * rainF;
      if (this.v[i] < 0.5) waiting++;
      this.mixCount[this.type[i]]++;
    }
    out.count = n;
    out.avgKmh = n ? (sumV / n) * 3.6 : 0;
    out.congestion = n ? Math.max(0, Math.min(100, (1 - sumV / sumD) * 100)) : 0;
    out.waiting = waiting;
    for (let k = 0; k < VTYPE_COUNT; k++) out.mix[k] = this.mixCount[k];
    return out;
  }

  describe(i: number): VehicleInfo | null {
    if (i < 0 || !this.active[i]) return null;
    const uid = this.uid[i];
    const type = this.type[i] as VType;
    const sg = this.segs[this.seg[i]];
    const r = (salt: number) => rand01(uid, salt);
    const d2 = (salt: number) => String(Math.floor(r(salt) * 100)).padStart(2, '0');
    const d3 = (salt: number) => String(Math.floor(r(salt) * 1000)).padStart(3, '0');
    let plate: string;
    let model: string;
    const bikeSeries = ['X1', 'T1', 'F1', 'P1', 'H1', 'D1', 'N1', 'B1'];
    if (type === VType.Moto || type === VType.Grab) {
      plate = `59-${bikeSeries[Math.floor(r(30) * bikeSeries.length)]} ${d3(31)}.${d2(32)}`;
      model = BIKE_MODELS[Math.floor(r(33) * BIKE_MODELS.length)];
    } else if (type === VType.Cyclo) {
      plate = `Xích lô du lịch · số ${Math.floor(r(31) * 90 + 10)}`;
      model = 'Xích lô Sài Gòn';
    } else if (type === VType.Bus) {
      plate = `51B-${d3(31)}.${d2(32)}`;
      model = BUS_ROUTES[Math.floor(r(33) * BUS_ROUTES.length)];
    } else if (type === VType.Truck) {
      plate = `51D-${d3(31)}.${d2(32)}`;
      model = 'Hyundai Porter 1,5 tấn';
    } else {
      const series = ['A', 'F', 'G', 'H', 'K'];
      plate = `51${series[Math.floor(r(30) * series.length)]}-${d3(31)}.${d2(32)}`;
      model = type === VType.Car ? CAR_MODELS[Math.floor(r(33) * CAR_MODELS.length)] : 'Toyota Vios';
    }
    const driver = `${SURNAMES[Math.floor(r(40) * SURNAMES.length)]} ${GIVEN[Math.floor(r(41) * GIVEN.length)]}`;
    const aggr = this.aggr[i];
    const temper = aggr > 0.78 ? 'Liều lĩnh' : aggr > 0.62 ? 'Hung hăng' : this.caution[i] > 0.62 ? 'Thận trọng' : 'Điềm tĩnh';
    const act = this.act[i];
    const v = this.v[i];
    const reason = this.reason[i] as Reason;
    let status: string;
    if (this.crashed[i]) status = 'Va chạm, chờ xử lý';
    else if (this.wading[i] === 2) status = 'Chết máy, dắt xe qua chỗ ngập';
    else if (this.wading[i] === 1) status = 'Lội qua đoạn ngập';
    else if (this.wrong[i]) status = 'Lấn làn ngược chiều';
    else if (this.elev[i] > 0.05) status = 'Leo lề, chạy trên vỉa hè';
    else if (this.honk[i] > 0) status = 'Bóp còi inh ỏi';
    else if (this.pedYield[i] && v < 2) status = 'Nhường người đi bộ qua đường';
    else if (act & Act.JumpRed) status = 'Vượt đèn đỏ khi còn vài giây';
    else if (act & Act.RunAmber) status = 'Cố vượt đèn vàng';
    else if (act & Act.Flash) status = v < 1.5 ? 'Đèn vàng nhấp nháy, chờ xe ngang qua' : 'Đèn vàng nhấp nháy, giảm tốc quan sát';
    else if (reason === Reason.Signal && v < 1.5) status = act & Act.OverLine ? 'Chờ đèn đỏ, đè qua vạch dừng' : 'Đang chờ đèn đỏ';
    else if (reason === Reason.Dwell) status = 'Dừng đón trả khách';
    else if (reason === Reason.Yield && v < 2) status = sg.merge ? 'Chờ nhập vòng xoay' : 'Nhường đường';
    else if (v < 1.2) status = 'Kẹt xe';
    else if (SPECS[type].swarm && Math.abs(this.vl[i]) > 0.45) status = 'Đang lách qua dòng xe';
    else if (sg.kind === SegKind.Ring) status = 'Đang đi vòng xoay';
    else if (sg.ringEntryArm >= 0) status = 'Đang vào vòng xoay';
    else if (sg.kind === SegKind.Conn) status = sg.turn === Turn.Left ? 'Đang rẽ trái' : sg.turn === Turn.Right ? 'Đang rẽ phải' : 'Đang qua giao lộ';
    else status = 'Đang chạy';
    const nx = this.nextSeg[i];
    let nextName = '';
    const onRing = sg.kind === SegKind.Ring || sg.ringEntryArm >= 0;
    if (onRing && this.ringTarget[i] >= 0) {
      nextName = this.net.ring.arms[this.ringTarget[i]].road.name;
    } else if (nx >= 0) {
      const ns = this.segs[nx];
      nextName = ns.kind === SegKind.Conn && ns.next[0] ? ns.next[0].name : ns.name;
    }
    return {
      uid,
      type,
      label: SPECS[type].label,
      plate,
      model,
      driver,
      temper,
      wantKmh: this.vDes[i] * 3.6,
      kmh: v * 3.6,
      street: sg.name,
      next: nextName,
      status,
      age: this.age[i],
      distKm: this.dist[i] / 1000,
    };
  }

  /** Index of an active vehicle by uid, or −1. */
  indexOf(uid: number): number {
    return this.uidIndex.get(uid) ?? -1;
  }

  /** Events currently affecting traffic, for the HUD feed. */
  events(hour: number): CityEvent[] {
    const out: CityEvent[] = this.incidents.map((inc) => ({
      key: `crash-${inc.id}`,
      kind: 'crash',
      title: `Va chạm trên ${inc.road}`,
      detail: `${inc.desc} · còn ~${Math.max(1, Math.ceil((inc.end - this.time) / 60))} phút`,
    }));
    if (this.floodLevel > 0.15) {
      const wet = FLOOD_ZONES.filter((fz) => this.floodLevel * fz.depth * 40 >= 6);
      if (wet.length) {
        const maxCm = Math.round(this.floodLevel * Math.max(...wet.map((fz) => fz.depth)) * 40);
        out.push({
          key: 'flood',
          kind: 'flood',
          title: `Ngập nước ${wet.length} tuyến đường`,
          detail: `${wet.map((fz) => fz.road).join(', ')} · sâu tới ${maxCm} cm, có xe chết máy`,
        });
      }
    }
    if (truckBanActive(hour)) {
      const until = hour < 9 ? '09:00' : '20:00';
      out.push({ key: 'ban', kind: 'ban', title: 'Cấm xe tải vào nội đô', detail: `Giờ cao điểm · đến ${until}` });
    }
    return out;
  }

  // ---------------------------------------------------------------- time machine

  snapshot(): TrafficSnapshot {
    const n = this.hi;
    const arrays = this.stateArrays.map(({ arr, stride }) => {
      const out = new Float32Array(n * stride);
      for (let k = 0; k < out.length; k++) out[k] = arr[k];
      return out;
    });
    return {
      arrays,
      hi: n,
      count: this.count,
      target: this.target,
      time: this.time,
      hour: this.hour,
      rain: this.rain,
      nextUid: this.nextUid,
      spawnAcc: this.spawnAcc,
      pendingType: this.pendingType,
      rainApplied: this.rainApplied,
      rng: this.rng.state,
      free: this.free.slice(),
      incidents: structuredClone(this.incidents),
      floodLevel: this.floodLevel,
      nextIncidentT: this.nextIncidentT,
      peds: this.peds.snapshot(),
      incidentSeq: this.incidentSeq,
    };
  }

  restore(snap: TrafficSnapshot): void {
    this.active.fill(0);
    this.stateArrays.forEach(({ arr }, a) => {
      const src = snap.arrays[a];
      for (let k = 0; k < src.length; k++) arr[k] = src[k];
    });
    this.hi = snap.hi;
    this.count = snap.count;
    this.target = snap.target;
    this.time = snap.time;
    this.hour = snap.hour;
    this.signals.flashing = flashHours(snap.hour);
    this.rain = snap.rain;
    this.nextUid = snap.nextUid;
    this.spawnAcc = snap.spawnAcc;
    this.pendingType = snap.pendingType;
    this.rainApplied = snap.rainApplied;
    this.rng.state = snap.rng;
    this.free.length = 0;
    this.free.push(...snap.free);
    this.incidents = structuredClone(snap.incidents);
    this.floodLevel = snap.floodLevel;
    this.nextIncidentT = snap.nextIncidentT;
    this.peds.restore(snap.peds);
    this.incidentSeq = snap.incidentSeq;
    this.uidIndex.clear();
    for (let i = 0; i < this.hi; i++) if (this.active[i]) this.uidIndex.set(this.uid[i], i);
  }
}

export interface TrafficSnapshot {
  arrays: Float32Array[];
  hi: number;
  count: number;
  target: number;
  time: number;
  hour: number;
  rain: number;
  nextUid: number;
  spawnAcc: number;
  pendingType: number;
  rainApplied: boolean;
  rng: number;
  free: number[];
  incidents: Incident[];
  floodLevel: number;
  nextIncidentT: number;
  peds: PedSnapshot;
  incidentSeq: number;
}

export interface VehicleInfo {
  uid: number;
  type: VType;
  label: string;
  plate: string;
  model: string;
  driver: string;
  /** Personality label (Vietnamese). */
  temper: string;
  /** Desired free-flow speed. */
  wantKmh: number;
  kmh: number;
  street: string;
  next: string;
  status: string;
  age: number;
  distKm: number;
}
