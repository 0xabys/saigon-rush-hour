// Pure checks over a built `Network` / a running `Traffic`. Nothing here touches the DOM, Bun or the
// file system, so the headless harness (scripts/harness.ts) and the debug page share them.
//
// The simulation is never modified or wrapped. Events that the sim does not expose (a vehicle being
// released, a vehicle changing segment, a spawn) are recovered by diffing public per-vehicle state
// (`active`, `uid`, `seg`, …) between two consecutive steps; see `SimMonitor`.

import { RoadClass, SegKind, Turn, type Junction, type Network, type Segment } from './network';
import { Light, SignalSystem } from './signals';
import { CAPACITY, type Traffic, type TrafficSnapshot } from './traffic';
import { SPECS, VTYPE_COUNT, VType } from './vehicleTypes';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  /** One line for the table. */
  summary: string;
  /** Extra lines (shown for anything but a clean pass). */
  details: string[];
}

const MAX_LISTED = 8;

function result(id: string, title: string, problems: string[], okSummary: string, failSummary?: string): CheckResult {
  if (problems.length === 0) return { id, title, status: 'pass', summary: okSummary, details: [] };
  return { id, title, status: 'fail', summary: failSummary ?? `${problems.length} lỗi`, details: problems.slice(0, MAX_LISTED).concat(problems.length > MAX_LISTED ? [`… +${problems.length - MAX_LISTED} lỗi nữa`] : []) };
}

/** Street names around a junction, for human-readable reports. */
export function junctionLabel(j: Junction | null): string {
  if (!j) return '—';
  const names: string[] = [];
  for (const a of j.arms) if (a.name && !names.includes(a.name)) names.push(a.name);
  const nm = j.name || names.slice(0, 3).join(' × ') || '(không tên)';
  return `${j.key} ${nm}${j.signal ? ' [đèn]' : ''}`;
}

const roadClassLabel: Record<RoadClass, string> = {
  [RoadClass.Trunk]: 'trunk',
  [RoadClass.Primary]: 'primary',
  [RoadClass.Secondary]: 'secondary',
  [RoadClass.Tertiary]: 'tertiary',
  [RoadClass.Residential]: 'residential',
  [RoadClass.Unclassified]: 'unclassified',
};

export function segmentLabel(sg: Segment): string {
  const kind = sg.kind === SegKind.Link ? 'link' : sg.kind === SegKind.Conn ? 'conn' : 'ring';
  return `${kind}#${sg.id}${sg.name ? ` ${sg.name}` : ''} (${roadClassLabel[sg.cls]})`;
}

// ------------------------------------------------------------------ H1: build invariants

/** Minimum distance between two junction centres (m). */
const MIN_JUNCTION_GAP = 8;
const MIN_ARC = 0.5;

/**
 * H1. `stats` is `NetworkJson.stats` for the OSM map (counts must agree with the pipeline); omit for the
 * hand-built map.
 */
export function checkBuild(net: Network, stats?: Record<string, number>): CheckResult {
  const problems: string[] = [];
  const b = net.bounds;

  for (const sg of net.segments) {
    if (!(sg.length >= 0.5)) problems.push(`${segmentLabel(sg)} dài ${sg.length.toFixed(3)} m < 0,5`);
    let finite = true;
    let out = false;
    const tol = sg.roadHalf + 1;
    for (let i = 0; i < sg.n; i++) {
      if (!Number.isFinite(sg.px[i] + sg.pz[i] + sg.tx[i] + sg.tz[i])) finite = false;
      if (sg.px[i] < b.minX - tol || sg.px[i] > b.maxX + tol || sg.pz[i] < b.minZ - tol || sg.pz[i] > b.maxZ + tol) out = true;
    }
    if (!finite) problems.push(`${segmentLabel(sg)} có NaN/∞ trong hình học`);
    if (out) problems.push(`${segmentLabel(sg)} nằm ngoài bounds (dung sai ${tol.toFixed(1)} m)`);
  }

  for (const l of net.links) {
    if (l.next.length === 0 && !l.portalOut) problems.push(`${segmentLabel(l)} không có lối ra`);
  }
  for (const sg of net.segments) {
    if (sg.kind !== SegKind.Link && sg.next.length === 0) problems.push(`${segmentLabel(sg)} (connector/ring) không có lối ra`);
  }

  net.signalJunctions.forEach((j, idx) => {
    const sp = j.signal;
    if (!sp) {
      problems.push(`${junctionLabel(j)} trong signalJunctions nhưng không có plan`);
      return;
    }
    if (sp.index !== idx) problems.push(`${junctionLabel(j)} plan.index ${sp.index} ≠ vị trí ${idx}`);
    if (!(sp.cycle > 0) || !(sp.green[0] > 0) || !(sp.green[1] > 0) || !Number.isFinite(sp.offset)) problems.push(`${junctionLabel(j)} plan không hợp lệ (cycle ${sp.cycle}, green ${sp.green.join('/')})`);
    const groups = [0, 0];
    for (const arm of j.arms) {
      const ref = arm.inLink?.signal;
      if (!ref) continue;
      if (ref.nodeIndex !== idx) problems.push(`${junctionLabel(j)} arm inLink#${arm.inLink?.id} trỏ nodeIndex ${ref.nodeIndex} ≠ ${idx}`);
      if (ref.group === 0 || ref.group === 1) groups[ref.group]++;
    }
    if (groups[0] === 0 || groups[1] === 0) problems.push(`${junctionLabel(j)} thiếu nhóm pha (${groups[0]}/${groups[1]})`);
  });

  net.rings.forEach((r, ri) => {
    const label = `ring ${ri} ${r.name}`;
    const entries = r.arms.filter((a) => a.entry !== null).length;
    const exits = r.arms.filter((a) => a.exit !== null).length;
    if (entries < 1) problems.push(`${label}: không có lối vào`);
    if (exits < 1 || r.exits.length < 1) problems.push(`${label}: không có lối ra`);
    if (r.arcs.length < 2) problems.push(`${label}: chỉ có ${r.arcs.length} cung`);
    r.arcs.forEach((arc, k) => {
      if (!(arc.length > MIN_ARC)) problems.push(`${label}: cung ${k} dài ${arc.length.toFixed(2)} m ≤ ${MIN_ARC}`);
      const nxt = r.arcs[(k + 1) % r.arcs.length];
      if (arc.next[0] !== nxt) problems.push(`${label}: cung ${k} không nối sang cung ${(k + 1) % r.arcs.length} (ring không khép kín)`);
    });
  });

  const nodes = net.junctions.filter((j) => j.kind === 'junction' || j.kind === 'ring');
  for (let a = 0; a < nodes.length; a++) {
    for (let c = a + 1; c < nodes.length; c++) {
      const d = Math.hypot(nodes[a].x - nodes[c].x, nodes[a].z - nodes[c].z);
      if (d < MIN_JUNCTION_GAP) problems.push(`${junctionLabel(nodes[a])} và ${junctionLabel(nodes[c])} cách nhau ${d.toFixed(1)} m < ${MIN_JUNCTION_GAP}`);
    }
  }

  if (stats) {
    const count = (k: Junction['kind']): number => net.junctions.filter((j) => j.kind === k).length;
    const want: [string, number, number][] = [
      ['junctions', count('junction'), stats.junctions],
      ['joins', count('join'), stats.joins],
      ['rings', net.rings.length, stats.rings],
      ['portals', count('portal'), stats.portals],
      ['deadEnds', count('dead'), stats.deadEnds],
      ['links (có hướng = 2·links − linksOneway)', net.links.length, 2 * stats.links - stats.linksOneway],
    ];
    for (const [label, actual, expected] of want) {
      if (actual !== expected) problems.push(`số ${label}: mạng ${actual} ≠ stats JSON ${expected}`);
    }
  }

  const note = `${net.segments.length} segment, ${net.links.length} link, ${net.junctions.length} nút, ${net.signalJunctions.length} đèn, ${net.rings.length} ring${net.warnings.length ? `, ${net.warnings.length} cảnh báo builder` : ''}`;
  const res = result('H1', 'Bất biến dựng mạng', problems, note);
  if (net.warnings.length && res.status === 'pass') res.details = net.warnings.map((w) => `cảnh báo builder: ${w}`);
  return res;
}

// ------------------------------------------------------------------ H5: signals

/** One full cycle of every plan: both groups see green, never at the same time. */
export function checkSignalPlans(net: Network, jsonSignalCount: number | null): CheckResult {
  const problems: string[] = [];
  if (jsonSignalCount !== null && net.signalJunctions.length < jsonSignalCount) {
    problems.push(`chỉ ${net.signalJunctions.length} nút đèn trong mạng < ${jsonSignalCount} cụm có signal trong JSON`);
  }
  const sys = new SignalSystem(net.signalJunctions);
  sys.flashing = false;
  sys.plans.forEach((plan, idx) => {
    let green0 = 0;
    let green1 = 0;
    let overlap = 0;
    const steps = Math.ceil(plan.cycle * 4);
    for (let k = 0; k < steps; k++) {
      const t = (k / 4) % plan.cycle;
      const a = sys.query(idx, 0, t).light;
      const b = sys.query(idx, 1, t).light;
      if (a === Light.Green) green0++;
      if (b === Light.Green) green1++;
      if ((a === Light.Green || a === Light.Amber) && (b === Light.Green || b === Light.Amber)) overlap++;
    }
    if (green0 === 0 || green1 === 0) problems.push(`${junctionLabel(plan.junction)}: nhóm ${green0 === 0 ? 0 : 1} không bao giờ xanh trong một chu kỳ`);
    if (overlap > 0) problems.push(`${junctionLabel(plan.junction)}: hai nhóm cùng xanh/vàng ${overlap / 4} s mỗi chu kỳ`);
  });
  return result('H5', 'Đèn tín hiệu', problems, `${sys.plans.length} nút đèn, mỗi nhóm xanh ≥ 1 lần/chu kỳ, không xung đột`);
}

/** `tr` has already been stepped at a flashing hour (≥ 23 or < 5): every query must return Flash. */
export function checkFlashNight(tr: Traffic): CheckResult {
  const problems: string[] = [];
  if (!tr.signals.flashing) problems.push(`signals.flashing = false ở giờ ${tr.hour}`);
  let bad = 0;
  tr.signals.plans.forEach((plan, idx) => {
    for (const g of [0, 1]) {
      for (const t of [0, 7.3, 31.9, 55]) {
        if (tr.signals.query(idx, g, t).light !== Light.Flash) {
          bad++;
          if (bad <= 3) problems.push(`${junctionLabel(plan.junction)} nhóm ${g} t=${t}: không nháy`);
        }
      }
    }
  });
  return result('H5', 'Đèn đêm', problems, `giờ ${tr.hour}: tất cả nút đèn ở chế độ nháy vàng`);
}

export function mergeResults(id: string, title: string, parts: CheckResult[]): CheckResult {
  const bad = parts.filter((p) => p.status === 'fail');
  const warn = parts.filter((p) => p.status === 'warn');
  const status: CheckStatus = bad.length ? 'fail' : warn.length ? 'warn' : 'pass';
  return {
    id,
    title,
    status,
    summary: parts.map((p) => p.summary).join('; '),
    details: parts.flatMap((p) => p.details),
  };
}

// ------------------------------------------------------------------ H3: determinism

const SNAPSHOT_SCALARS = [
  'hi',
  'count',
  'target',
  'time',
  'hour',
  'rain',
  'nextUid',
  'spawnAcc',
  'pendingType',
  'rainApplied',
  'rng',
  'floodLevel',
  'nextIncidentT',
  'incidentSeq',
  'releases',
  'locksBroken',
  'teleports',
  'arrivals',
] as const satisfies readonly (keyof TrafficSnapshot)[];

type TypedArray = Float32Array | Float64Array | Int8Array | Int16Array | Int32Array | Uint8Array | Uint16Array | Uint32Array;

function isTypedArray(v: unknown): v is TypedArray {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

/**
 * Names of `Traffic.snapshot().arrays` entries, in order. Marks element 0 of every per-vehicle array of
 * `fresh` with a distinct value and reads it back from a snapshot, so the names cannot drift from the
 * sim. MUTATES `fresh`: pass a throwaway instance.
 */
export function vehicleArrayNames(fresh: Traffic): string[] {
  const candidates: { name: string; arr: TypedArray }[] = [];
  for (const [name, v] of Object.entries(fresh)) {
    if (isTypedArray(v) && (v.length === CAPACITY || v.length === CAPACITY * 3)) candidates.push({ name, arr: v });
  }
  if (candidates.length > 120) throw new Error('vehicleArrayNames: too many candidate arrays for an Int8 sentinel');
  candidates.forEach((c, k) => {
    c.arr[0] = k + 1;
  });
  fresh.hi = 1;
  const snap = fresh.snapshot();
  return snap.arrays.map((a, k) => candidates[a[0] - 1]?.name ?? `array#${k}`);
}

/** Differences between two snapshots (empty = identical). Reports the first mismatch per field/array. */
export function compareSnapshots(a: TrafficSnapshot, b: TrafficSnapshot, names: string[]): string[] {
  const diffs: string[] = [];
  for (const k of SNAPSHOT_SCALARS) {
    if (!Object.is(a[k], b[k])) diffs.push(`${k}: ${String(a[k])} ≠ ${String(b[k])}`);
  }
  if (a.free.length !== b.free.length || a.free.some((v, i) => v !== b.free[i])) {
    const i = a.free.findIndex((v, k) => v !== b.free[k]);
    diffs.push(`free-list: dài ${a.free.length}/${b.free.length}, lệch đầu tiên ở ${i}`);
  }
  if (JSON.stringify(a.incidents) !== JSON.stringify(b.incidents)) diffs.push('incidents khác nhau');
  if (a.arrays.length !== b.arrays.length) diffs.push(`số mảng xe ${a.arrays.length} ≠ ${b.arrays.length}`);
  const uidIdx = names.indexOf('uid');
  a.arrays.forEach((arr, k) => {
    const other = b.arrays[k];
    if (!other || arr.length !== other.length) {
      diffs.push(`${names[k] ?? k}: độ dài ${arr.length} ≠ ${other?.length}`);
      return;
    }
    for (let i = 0; i < arr.length; i++) {
      if (!Object.is(arr[i], other[i])) {
        const stride = arr.length / Math.max(1, a.hi);
        const veh = Math.floor(i / stride);
        const uid = uidIdx >= 0 ? a.arrays[uidIdx][veh] : NaN;
        diffs.push(`${names[k] ?? `array#${k}`}[${i}] (xe slot ${veh}, uid ${uid}): ${arr[i]} ≠ ${other[i]}`);
        return;
      }
    }
  });
  const pa = a.peds;
  const pb = b.peds;
  for (const k of ['hi', 'count', 'rng', 'seq'] as const) if (!Object.is(pa[k], pb[k])) diffs.push(`peds.${k}: ${pa[k]} ≠ ${pb[k]}`);
  pa.arrays.forEach((arr, k) => {
    const other = pb.arrays[k];
    for (let i = 0; i < arr.length; i++) {
      if (!other || !Object.is(arr[i], other[i])) {
        diffs.push(`peds.arrays[${k}][${i}]: ${arr[i]} ≠ ${other?.[i]}`);
        return;
      }
    }
  });
  const ra = a.router;
  const rb = b.router;
  if (!ra !== !rb) diffs.push(`router: ${ra ? 'có' : 'không'} ≠ ${rb ? 'có' : 'không'}`);
  else if (ra && rb) {
    if (!Object.is(ra.epochStep, rb.epochStep)) diffs.push(`router.epochStep: ${ra.epochStep} ≠ ${rb.epochStep}`);
    for (const k of ['vHat', 'tauActive', 'tauBuild'] as const) {
      const x = ra[k];
      const y = rb[k];
      if (x.length !== y.length) {
        diffs.push(`router.${k}: độ dài ${x.length} ≠ ${y.length}`);
        continue;
      }
      for (let i = 0; i < x.length; i++) {
        if (!Object.is(x[i], y[i])) {
          diffs.push(`router.${k}[${i}]: ${x[i]} ≠ ${y[i]}`);
          break;
        }
      }
    }
  }
  return diffs;
}

// ------------------------------------------------------------------ monitor (H2, H4, H6, H8)

export interface MonitorOptions {
  /** Sim step in seconds (for the swarm wrong-way allowance). */
  dt: number;
  /** Old H2(c): an inbound link with a waiting vehicle and no departure for this long (kept as info). */
  starveSeconds: number;
  /** H2(c): of that starvation window, this many seconds the head vehicle's exit had room. */
  starveRoomSeconds: number;
  /** H2(d)/H6: a vehicle on a ring arc stopped longer than this. */
  ringStopSeconds: number;
  /** H8/H2(f): a vehicle older than this (s) counts toward `oldShare`. */
  oldAgeSeconds: number;
  /** H4 is sampled every N-th observed step. */
  wrongEvery: number;
}

export const DEFAULT_MONITOR: MonitorOptions = { dt: 1 / 60, starveSeconds: 180, starveRoomSeconds: 60, ringStopSeconds: 45, oldAgeSeconds: 1200, wrongEvery: 10 };

export interface StopLineStat {
  link: number;
  street: string;
  to: string;
  signalised: boolean;
  yields: boolean;
  lanes: number;
  maxStopT: number;
  maxQueue: number;
  departures: number;
  maxStarveS: number;
}

export interface Example {
  t: number;
  uid: number;
  type: VType;
  where: string;
  detail: string;
}

/** Age-at-despawn histogram bin edges (sim minutes): bins are [0,e0), [e0,e1), …, [e_last,∞). */
export const AGE_EDGES_MIN: readonly number[] = [1, 2, 5, 10, 15, 20, 30];
/** A link-end despawn this far (m) short of the link end was not a normal exit (diff-monitor cross-check of `teleports`). */
const EARLY_REMOVAL_M = 3;
/** A vehicle bound for an internal sink that vanishes on its sink link within this distance (m) of `destS` arrived (the sim removes it at `s ≥ destS`; one step moves < 0.4 m). */
const ARRIVAL_SLACK_M = 1;
/** Spillback tree: a head vehicle stopped at least this long (s) is a candidate waiting edge. */
const SPILL_STOP_S = 10;
/** Top-N spillback roots kept in the report. */
const SPILL_TOP = 5;

/** H4b two-wheeler body overlap, sampled together with H4: hash-grid cell (m) and table size (power of two). */
const OVERLAP_CELL_M = 3;
const OVERLAP_TABLE = 1 << 16;
/** A pair overlaps when, in the frame of the first rider, |lateral| < half-width sum − 0.05 and |longitudinal| < half-length sum − 0.05; 'deep' with margins 0.3 / 0.5. */
const OVERLAP_LAT_M = 0.05;
const OVERLAP_LONG_M = 0.05;
const DEEP_LAT_M = 0.3;
const DEEP_LONG_M = 0.5;
/** H4b WARN thresholds, overlapping / deeply overlapping pairs per 1000 two-wheelers (CalibReview at 6000 vehicles: 41,2 / 6,56 after S9, 31,0 / 5,27 before). WARN only until the user ratifies them. */
export const OVERLAP_WARN_PER_1000 = 45;
export const DEEP_OVERLAP_WARN_PER_1000 = 8;
/** Box-jam census (H8): a committed vehicle on a connector under this speed (m/s) counts as standing in the box; number of junctions listed. */
const BOX_STAND_V = 0.5;
const BOX_TOP_N = 5;
/** H2 (a″): the car + taxi share of the vehicles on the map may drift up by at most this many points over the run (WARN). */
export const MIX_DRIFT_WARN_PTS = 2;

// ------------------------------------------------------------------ calibration (H9) and saturation flow

/** H9 calibration streets: the central signalised arterials of District 1 (`Segment.name`, compared in Unicode NFC). */
export const CALIB_STREETS: readonly string[] = [
  'Lê Lợi',
  'Hàm Nghi',
  'Nguyễn Thị Minh Khai',
  'Hai Bà Trưng',
  'Nam Kỳ Khởi Nghĩa',
  'Lê Duẩn',
  'Lý Tự Trọng',
  'Pasteur',
  'Trần Hưng Đạo',
  'Đồng Khởi',
  'Tôn Đức Thắng',
  'Lê Thánh Tôn',
  'Nguyễn Huệ',
];

/** Target band for the all-vehicle late-window mean speed of every calibration street, by clock hour `[fromHour, toHour)`. */
export interface CalibBand {
  label: string;
  fromHour: number;
  toHour: number;
  minKmh: number;
  maxKmh: number;
}

export const CALIB_BANDS: Record<'morning' | 'eveningPeak' | 'eveningLate' | 'night', CalibBand> = {
  morning: { label: 'sáng 07:30–09:00', fromHour: 7.5, toHour: 9, minKmh: 14, maxKmh: 20 },
  eveningPeak: { label: 'chiều 17:00–17:45', fromHour: 17, toHour: 17.75, minKmh: 10, maxKmh: 16 },
  eveningLate: { label: 'chiều 17:45–18:30', fromHour: 17.75, toHour: 18.5, minKmh: 8, maxKmh: 12 },
  night: { label: 'đêm 01:00–05:00', fromHour: 1, toHour: 5, minKmh: 25, maxKmh: 35 },
};

export function calibBandForHour(hour: number): CalibBand | null {
  for (const b of Object.values(CALIB_BANDS)) if (hour >= b.fromHour && hour < b.toHour) return b;
  return null;
}

/** A street is gridlocked when its per-minute mean speed stays under `CALIB_SUSTAIN_KMH` for `CALIB_SUSTAIN_MIN` consecutive minutes. */
const CALIB_SUSTAIN_KMH = 6;
const CALIB_SUSTAIN_MIN = 3;
/** A per-minute street speed is only used with at least this many vehicle-seconds (1 Hz samples) behind it. */
const CALIB_MIN_SAMPLES = 30;
/** Evening hours `[from, to)` where no calibration street may exceed `CALIB_PEAK_MAX_KMH` and the median two-wheeler density must reach `CALIB_PEAK_MIN_BIKE_DENS`. */
const CALIB_PEAK_FROM_HOUR = 17;
const CALIB_PEAK_TO_HOUR = 19;
const CALIB_PEAK_MAX_KMH = 20;
const CALIB_PEAK_MIN_BIKE_DENS = 30;

/** Saturation flow: a green counts when the queue at its start is at least this long (vehicles with v < 0.5 m/s on the link). */
const SAT_MIN_QUEUE = 6;
/** Start-up lost time (s): departures are counted from this many seconds after the green begins. */
const SAT_LOST_S = 3;
/** The queue still holds at least this many vehicles when the green ends ⇒ discharge lasted the whole green. */
const SAT_RESIDUAL_QUEUE = 2;
/** A green is a valid sample with at least this many counted departures over at least this many seconds. */
const SAT_MIN_VEH = 4;
const SAT_MIN_SPAN_S = 4;
/** An approach enters the median with at least this many valid greens. */
const SAT_MIN_CYCLES = 2;
/** A green counts for the 'clear' median only when the main exit link has at least this much tail room (m) when the green starts. */
const SAT_CLEAR_TAIL_M = 20;
/** WARN band for the median saturation flow in motorcycle units per second per metre of approach width. */
export const SAT_MCU_BAND: readonly [number, number] = [0.5, 1.4];

/** Motorcycle-unit equivalents for the saturation flow. */
const MCU: Record<VType, number> = {
  [VType.Moto]: 1,
  [VType.Grab]: 1,
  [VType.Cyclo]: 1.5,
  [VType.Car]: 4,
  [VType.TaxiVinasun]: 4,
  [VType.TaxiMaiLinh]: 4,
  [VType.RideCar]: 4,
  [VType.Truck]: 6,
  [VType.Bus]: 10,
};

/** One calibration street over the late window (all links with that name, both directions). */
export interface StreetStat {
  name: string;
  links: number;
  /** Σ length · lanes over its links (m); 0 = the street is not in this network. */
  laneM: number;
  /** Vehicle-seconds (1 Hz samples) behind `speedKmh`. */
  samples: number;
  /** Count-weighted mean speed (km/h) of all / car+taxi / motorbike+Grab; null = no samples. */
  speedKmh: number | null;
  carKmh: number | null;
  bikeKmh: number | null;
  /** Mean vehicles (all / two-wheelers) per 100 m of lane over the window. */
  vehPer100mLane: number | null;
  bikePer100mLane: number | null;
  /** Lowest per-minute mean speed over the whole run (≥ 30 vehicle-seconds in that minute) and its 0-based minute. */
  worstMinuteKmh: number | null;
  worstMinute: number | null;
  /** Three consecutive minutes with a mean speed under 6 km/h (anywhere in the run). */
  sustainedBelow6: boolean;
}

/** Box-jam census row: committed vehicles standing on the connectors of one junction, over the late window's 1 Hz samples. */
export interface BoxJamStat {
  junction: string;
  mean: number;
  max: number;
}

/** Discharge of one signalised approach while its green was saturated (queue ≥ 6 at the start). */
export interface SaturationStat {
  link: number;
  street: string;
  to: string;
  lanes: number;
  /** 2 · halfW: the approach width (m). */
  widthM: number;
  /** Valid greens behind the rates. */
  cycles: number;
  /** Vehicles / motorcycle units per second per metre of width. */
  vehPerSM: number;
  mcuPerSM: number;
  /** Valid greens that also met the 'clear exit' condition (main exit lanes ≥ approach lanes, tail room ≥ 20 m at the start of the green). */
  clearCycles: number;
  /** MCU/s/m over those greens only; null = none. */
  mcuPerSMClear: number | null;
}

/** Why a calibration street fails H9 at `hour` (empty = in band). */
export function calibStreetIssues(s: StreetStat, hour: number): string[] {
  if (s.laneM <= 0) return [`không có link tên "${s.name}" trong mạng`];
  if (s.speedKmh === null) return ['không có xe nào trong cửa sổ late'];
  const issues: string[] = [];
  const band = calibBandForHour(hour);
  if (band && (s.speedKmh < band.minKmh || s.speedKmh > band.maxKmh)) issues.push(`v̄ ${s.speedKmh.toFixed(1)} km/h ngoài band ${band.minKmh}–${band.maxKmh}`);
  if (s.sustainedBelow6) issues.push(`v̄ phút < ${CALIB_SUSTAIN_KMH} km/h suốt ≥ ${CALIB_SUSTAIN_MIN} phút liên tiếp (thấp nhất ${s.worstMinuteKmh === null ? '–' : s.worstMinuteKmh.toFixed(1)})`);
  if (hour >= CALIB_PEAK_FROM_HOUR && hour < CALIB_PEAK_TO_HOUR && s.speedKmh > CALIB_PEAK_MAX_KMH) issues.push(`v̄ ${s.speedKmh.toFixed(1)} km/h > ${CALIB_PEAK_MAX_KMH} giờ cao điểm`);
  return issues;
}

/** State of the active vehicles at the moment `report()` is called (the end of the run). */
export interface EndState {
  active: number;
  /** Active vehicles older than `oldAgeSeconds`. */
  older: number;
  oldShare: number;
  meanAgeMin: number;
  /** Longest current `stopT` (s) over non-crashed vehicles, and where. */
  maxStopT: number;
  maxStopWhere: string;
  stoppedOver60: number;
  /** Links with ≥ 20 vehicles stopped > 60 s ('pockets'): their number and the 5 largest. */
  pocketLinks: number;
  pockets: RecoveryPocket[];
}

/** A spillback-tree root: a link whose full tail blocks a waiting head upstream while it is not itself waiting on a full link. */
export interface SpillRoot {
  link: number;
  street: string;
  to: string;
  length: number;
  lanes: number;
  /** Vehicles on the root link and the longest `stopT` among them. */
  vehicles: number;
  maxStopT: number;
  /** min(length, smallest `s` on the link): the free room at its tail (m). */
  tailRoom: number;
  upLinks: number;
  /** Vehicles on the links upstream of the root (root excluded). */
  upVehicles: number;
}

export interface SpillState {
  /** Waiting edges A→B (head of A stopped ≥ 10 s, tail room of B < what the head needs). */
  edges: number;
  roots: SpillRoot[];
  /** Edge sources that reach no root (they feed a wait-for cycle). */
  unrooted: { links: number; vehicles: number };
}

export interface MonitorReport {
  steps: number;
  seconds: number;
  spawns: number;
  despawns: number;
  /** Vehicles removed while inside a junction/ring (the sim's last-resort unjam): the "release" count. */
  releases: number;
  spawnByType: number[];
  despawnByType: number[];
  /** Link-end despawns per simulated minute (index = minute, 0-based). */
  despawnPerMinute: number[];
  releaseByType: number[];
  spawnByPortal: { link: number; portal: string; count: number }[];
  despawnByPortal: { link: number; portal: string; count: number }[];
  releaseByJunction: { junction: string; count: number }[];
  /** Mean speed (km/h) of vehicles of each type per simulated minute, sampled once per second; null = no samples. */
  speedByTypePerMinute: (number | null)[][];
  /** Mean speed (km/h) of all vehicles per simulated minute. */
  speedAllPerMinute: number[];
  worstStopLines: StopLineStat[];
  starved: { link: number; street: string; to: string; atT: number }[];
  /** H2(c): starved ≥ starveSeconds while the head vehicle's exit had room ≥ starveRoomSeconds of that time. */
  starvedRoom: { link: number; street: string; to: string; atT: number }[];
  linksNeverVisited: { link: number; street: string; from: string; to: string }[];
  rings: { ring: number; name: string; entries: number; exits: number; maxStopT: number; stoppedOverLimit: number }[];
  /** Link-end despawns by vehicle age (min): `counts[k]` = vehicles aged in [edges[k-1], edges[k]). */
  ageAtDespawn: { edgesMin: number[]; counts: number[]; meanMin: number | null };
  /** Link removals ≥ 3 m short of the link end (teleport cross-check; 0 while the sim has no teleport). */
  earlyLinkRemovals: number;
  /** Link removals that were arrivals at an internal destination (a vehicle with `destS ≥ 0` vanishing at its destination link). Included in `despawns`, excluded from `earlyLinkRemovals` and `despawnByPortal`. */
  arrivals: number;
  end: EndState;
  spill: SpillState;
  wrong: {
    onewayLeft: number;
    twoWayLeftNonSwarm: number;
    swarmWrongTOver: number;
    headingBad: number;
    onewayHeadingBad: number;
    samples: number;
    /** Largest amount (s) a swarm rider stayed wrong-way beyond 3+5·aggr. */
    swarmMaxOverS: number;
    /** Distinct vehicles (uids) per category. */
    vehicles: { onewayLeft: number; twoWayLeftNonSwarm: number; swarmWrongTOver: number; headingBad: number; onewayHeadingBad: number };
    bySegment: { seg: string; count: number }[];
    examples: Example[];
  };
}

export class SimMonitor {
  readonly opts: MonitorOptions;
  private readonly tr: Traffic;
  private readonly net: Network;
  private steps = 0;

  // previous post-step state of every vehicle slot
  private prevHi: number;
  private readonly prevActive = new Uint8Array(CAPACITY);
  private readonly prevUid = new Int32Array(CAPACITY);
  private readonly prevSeg = new Int32Array(CAPACITY);
  private readonly prevType = new Uint8Array(CAPACITY);
  private readonly prevS = new Float32Array(CAPACITY);
  private readonly prevAge = new Float32Array(CAPACITY);
  private readonly prevDest = new Int16Array(CAPACITY);
  private readonly prevDestS = new Float32Array(CAPACITY);

  spawns = 0;
  despawns = 0;
  releases = 0;
  private readonly spawnByType = new Array<number>(VTYPE_COUNT).fill(0);
  private readonly despawnByType = new Array<number>(VTYPE_COUNT).fill(0);
  private readonly releaseByType = new Array<number>(VTYPE_COUNT).fill(0);
  private readonly spawnAt = new Map<number, number>();
  private readonly despawnAt = new Map<number, number>();
  private readonly releaseAt = new Map<number, number>();
  private readonly ageHist = new Array<number>(AGE_EDGES_MIN.length + 1).fill(0);
  private ageSum = 0;
  private earlyRemovals = 0;
  private arrivals = 0;

  // per segment
  private readonly visited: Uint8Array;
  private readonly departures: Int32Array;
  private readonly maxStop: Float32Array;
  private readonly maxQueue: Int32Array;
  private readonly queueNow: Int32Array;
  private readonly waiting: Uint8Array;
  private readonly lastProgress: Float64Array;
  private readonly maxStarve: Float32Array;
  private readonly starvedFlag: Uint8Array;
  private readonly inbound: Segment[];
  private readonly starved: { link: number; atT: number }[] = [];
  private readonly starvedRoom: { link: number; atT: number }[] = [];
  private readonly starvedRoomFlag: Uint8Array;
  /** Seconds of the current starvation window during which the head vehicle's exit had room. */
  private readonly roomS: Float64Array;
  /** Per segment, rebuilt every observe: smallest `s` of a vehicle on it, and the front-most waiting vehicle. */
  private readonly minS: Float32Array;
  private readonly headVeh: Int32Array;
  private readonly despawnMin: number[] = [];
  private readonly entryRing: Int16Array;
  private readonly exitRing: Int16Array;

  // rings
  private readonly ringEntries: number[];
  private readonly ringExits: number[];
  private readonly ringMaxStop: number[];
  private readonly ringOver: number[];

  // speed
  private readonly speedSum: number[][] = [];
  private readonly speedCnt: number[][] = [];
  private readonly allSum: number[] = [];
  private readonly allCnt: number[] = [];
  private readonly secSum: number[] = [];
  private readonly secCnt: number[] = [];
  /** Per sampled second, per `VType`: speed sum (km/h) and vehicle count. */
  private readonly secTypeSum: number[][] = [];
  private readonly secTypeCnt: number[][] = [];

  // H4
  private wrongSamples = 0;
  private onewayLeft = 0;
  private twoWayLeft = 0;
  private swarmOver = 0;
  private headingBad = 0;
  private onewayHeadingBad = 0;
  private readonly wrongBySeg = new Map<number, number>();
  /** uid → bitmask of violated H4 categories (1 oneway-left, 2 two-way car, 4 swarm wrongT, 8 heading, 16 oneway heading). */
  private readonly flaggedUids = new Map<number, number>();
  private swarmMaxOver = 0;
  private readonly examples: Example[] = [];
  private readonly tmp = new Float32Array(4);

  // H9: per calibration street
  private readonly streetOf: Int16Array;
  private readonly calLaneM: number[];
  private readonly calLinks: number[];
  private readonly calOn: boolean;
  /** 1 = car/taxi, 2 = motorbike/Grab, 0 = other: indexed by `VType`. */
  private readonly groupOf = new Uint8Array(VTYPE_COUNT);
  /** Per sampled second: for each street 6 numbers [all Σkm/h, all n, car Σ, car n, bike Σ, bike n]. */
  private readonly calSec: Float64Array[] = [];
  /** Per street, per minute: Σ km/h and vehicle-seconds of all vehicles. */
  private readonly calMinSum: number[][];
  private readonly calMinCnt: number[][];

  // saturation flow at signalised approaches
  private readonly sigLinks: Segment[];
  private readonly satActive: Uint8Array;
  private readonly satStart: Float64Array;
  private readonly satLast: Float64Array;
  private readonly satQ: Int32Array;
  private readonly satCount: Int32Array;
  private readonly satMcu: Float64Array;
  private readonly satCycles: Int32Array;
  private readonly satVeh: Float64Array;
  private readonly satMcuTot: Float64Array;
  private readonly satTime: Float64Array;
  /** Per signalised approach: the main exit link (straight connector's, else the widest; −1 = none) and whether the current green began with a clear exit. */
  private readonly satOut: Int32Array;
  private readonly satClear: Uint8Array;
  private readonly satCyclesClear: Int32Array;
  private readonly satMcuTotClear: Float64Array;
  private readonly satTimeClear: Float64Array;

  // H4b: two-wheeler overlap
  private readonly isBike = new Uint8Array(VTYPE_COUNT);
  private readonly ovHead = new Int32Array(OVERLAP_TABLE).fill(-1);
  private readonly ovNext = new Int32Array(CAPACITY);
  private readonly ovSeen = new Int32Array(9);
  private ovSamples = 0;
  private ovBikes = 0;
  private ovPairs = 0;
  private ovDeep = 0;
  /** H4b inside junction boxes: overlapping pairs with ≥ 1 rider on a connector. */
  private ovBoxPairs = 0;
  /** Junction id of every connector segment (−1 = not a connector / no junction). */
  private readonly connJunction: Int32Array;
  /** Box-jam census: per sampled second, the committed vehicles standing (v < 0.5) on the connectors of each junction. */
  private readonly boxSec: Uint16Array[] = [];

  constructor(tr: Traffic, opts: Partial<MonitorOptions> = {}) {
    this.tr = tr;
    this.net = tr.net;
    this.opts = { ...DEFAULT_MONITOR, ...opts };
    const n = this.net.segments.length;
    this.visited = new Uint8Array(n);
    this.departures = new Int32Array(n);
    this.maxStop = new Float32Array(n);
    this.maxQueue = new Int32Array(n);
    this.queueNow = new Int32Array(n);
    this.waiting = new Uint8Array(n);
    this.lastProgress = new Float64Array(n).fill(tr.time);
    this.maxStarve = new Float32Array(n);
    this.starvedFlag = new Uint8Array(n);
    this.starvedRoomFlag = new Uint8Array(n);
    this.roomS = new Float64Array(n);
    this.minS = new Float32Array(n);
    this.connJunction = new Int32Array(n).fill(-1);
    for (const sg of this.net.segments) if (sg.kind === SegKind.Conn && sg.junction !== null) this.connJunction[sg.id] = sg.junction.id;
    this.headVeh = new Int32Array(n);
    this.inbound = this.net.links.filter((l) => l.next.length > 0);
    this.entryRing = new Int16Array(n).fill(-1);
    this.exitRing = new Int16Array(n).fill(-1);
    this.net.rings.forEach((r, ri) => {
      for (const a of r.arms) {
        if (a.entry) this.entryRing[a.entry.id] = ri;
        if (a.exit) this.exitRing[a.exit.id] = ri;
      }
    });
    const calNames = CALIB_STREETS.map((s) => s.normalize('NFC'));
    this.streetOf = new Int16Array(n).fill(-1);
    this.calLaneM = calNames.map(() => 0);
    this.calLinks = calNames.map(() => 0);
    for (const l of this.net.links) {
      const k = calNames.indexOf(l.name.normalize('NFC'));
      if (k < 0) continue;
      this.streetOf[l.id] = k;
      this.calLaneM[k] += l.length * l.lanes;
      this.calLinks[k]++;
    }
    this.calOn = this.calLaneM.some((v) => v > 0);
    this.calMinSum = calNames.map(() => []);
    this.calMinCnt = calNames.map(() => []);
    for (const ty of CAR_TYPES) this.groupOf[ty] = 1;
    for (const ty of BIKE_TYPES) this.groupOf[ty] = 2;
    this.sigLinks = this.net.links.filter((l) => l.signal !== null);
    this.satActive = new Uint8Array(n);
    this.satStart = new Float64Array(n);
    this.satLast = new Float64Array(n);
    this.satQ = new Int32Array(n);
    this.satCount = new Int32Array(n);
    this.satMcu = new Float64Array(n);
    this.satCycles = new Int32Array(n);
    this.satVeh = new Float64Array(n);
    this.satMcuTot = new Float64Array(n);
    this.satTime = new Float64Array(n);
    this.satOut = new Int32Array(n).fill(-1);
    this.satClear = new Uint8Array(n);
    this.satCyclesClear = new Int32Array(n);
    this.satMcuTotClear = new Float64Array(n);
    this.satTimeClear = new Float64Array(n);
    for (const l of this.sigLinks) {
      let best: Segment | null = null;
      for (const c of l.next) {
        const o = c.next[0];
        if (c.kind !== SegKind.Conn || !o || o.kind !== SegKind.Link) continue;
        if (c.turn === Turn.Straight) {
          best = o;
          break;
        }
        if (best === null || o.lanes > best.lanes) best = o;
      }
      if (best !== null) this.satOut[l.id] = best.id;
    }
    for (const ty of BIKE_TYPES) this.isBike[ty] = 1;
    this.ringEntries = this.net.rings.map(() => 0);
    this.ringExits = this.net.rings.map(() => 0);
    this.ringMaxStop = this.net.rings.map(() => 0);
    this.ringOver = this.net.rings.map(() => 0);
    // Baseline: whatever `populate` already placed is neither a spawn nor a visit-by-movement.
    this.prevHi = tr.hi;
    for (let i = 0; i < tr.hi; i++) {
      this.prevActive[i] = tr.active[i];
      this.prevUid[i] = tr.uid[i];
      this.prevSeg[i] = tr.seg[i];
      this.prevType[i] = tr.type[i];
      this.prevS[i] = tr.s[i];
      this.prevAge[i] = tr.age[i];
      this.prevDest[i] = tr.dest[i];
      this.prevDestS[i] = tr.destS[i];
      if (tr.active[i]) this.visited[tr.seg[i]] = 1;
    }
  }

  private bump(m: Map<number, number>, k: number): void {
    m.set(k, (m.get(k) ?? 0) + 1);
  }

  /**
   * Call once after every `tr.step(dt, t)`.
   *
   * Release/spawn/despawn are recovered from public state only: a slot that was active last step and now
   * is inactive or holds another uid means the vehicle left. If it left while on a `Link` it reached the
   * end of a portal/dead-end link (the only way to run out of path); if it left from a connector or ring
   * arc it was the sim's MAX_STOPPED unjam (`release` is called from no other place). A slot that is
   * newly active, or holds a new uid, is a spawn at its portal link. A same uid on another segment is a
   * transition (used for departures from inbound links and for ring entries/exits).
   */
  observe(t: number): void {
    const tr = this.tr;
    const segs = this.net.segments;
    this.steps++;
    const hi = Math.max(tr.hi, this.prevHi);
    this.updateSaturation(t);

    for (let i = 0; i < hi; i++) {
      const was = this.prevActive[i] === 1;
      const now = tr.active[i] === 1;
      const same = was && now && tr.uid[i] === this.prevUid[i];
      if (was && !same) {
        const sg = segs[this.prevSeg[i]];
        const ty = this.prevType[i];
        if (sg.kind === SegKind.Link) {
          // An arrival: bound for an internal sink, standing within a step's travel of its arrival point on the sink link.
          const dd = this.prevDest[i];
          const arrived = this.prevDestS[i] >= 0 && dd >= 0 && this.net.destSeg[dd] === sg.id && this.prevS[i] >= this.prevDestS[i] - ARRIVAL_SLACK_M;
          this.despawns++;
          this.despawnByType[ty]++;
          if (arrived) this.arrivals++;
          else this.bump(this.despawnAt, sg.id);
          const dm = Math.floor((this.steps - 1) / 3600);
          this.despawnMin[dm] = (this.despawnMin[dm] ?? 0) + 1;
          const ageS = this.prevAge[i] + this.opts.dt;
          this.ageSum += ageS;
          let bin = 0;
          while (bin < AGE_EDGES_MIN.length && ageS >= AGE_EDGES_MIN[bin] * 60) bin++;
          this.ageHist[bin]++;
          if (!arrived && this.prevS[i] < sg.length - EARLY_REMOVAL_M) this.earlyRemovals++;
        } else {
          this.releases++;
          this.releaseByType[ty]++;
          this.bump(this.releaseAt, (sg.junction ?? sg.to)?.id ?? -1);
        }
      }
      if (now && !same) {
        this.spawns++;
        this.spawnByType[tr.type[i]]++;
        this.bump(this.spawnAt, tr.seg[i]);
      }
      if (same && tr.seg[i] !== this.prevSeg[i]) {
        const from = this.prevSeg[i];
        const to = tr.seg[i];
        const fs = segs[from];
        if (fs.kind === SegKind.Link && fs.next.length > 0) {
          this.departures[from]++;
          this.lastProgress[from] = t;
          this.roomS[from] = 0;
          if (this.satActive[from] === 1 && t >= this.satStart[from] + SAT_LOST_S) {
            this.satCount[from]++;
            this.satMcu[from] += MCU[this.prevType[i] as VType];
            this.satLast[from] = t;
          }
        }
        this.visited[to] = 1;
        const er = this.entryRing[to];
        if (er >= 0) this.ringEntries[er]++;
        const xr = this.exitRing[to];
        if (xr >= 0) this.ringExits[xr]++;
      }
      this.prevActive[i] = tr.active[i];
      this.prevUid[i] = tr.uid[i];
      this.prevSeg[i] = tr.seg[i];
      this.prevType[i] = tr.type[i];
      this.prevS[i] = tr.s[i];
      this.prevAge[i] = tr.age[i];
      this.prevDest[i] = tr.dest[i];
      this.prevDestS[i] = tr.destS[i];
    }
    this.prevHi = tr.hi;

    // ---- per-vehicle state of this step
    this.waiting.fill(0);
    this.queueNow.fill(0);
    this.minS.fill(Infinity);
    this.headVeh.fill(-1);
    const sample = this.steps % 60 === 0;
    const minute = Math.floor((this.steps - 1) / 3600);
    const sec = this.steps / 60 - 1;
    if (sample) {
      this.secSum[sec] = 0;
      this.secCnt[sec] = 0;
      this.secTypeSum[sec] = new Array<number>(VTYPE_COUNT).fill(0);
      this.secTypeCnt[sec] = new Array<number>(VTYPE_COUNT).fill(0);
    }
    if (sample && !this.speedSum[minute]) {
      this.speedSum[minute] = new Array<number>(VTYPE_COUNT).fill(0);
      this.speedCnt[minute] = new Array<number>(VTYPE_COUNT).fill(0);
      this.allSum[minute] = 0;
      this.allCnt[minute] = 0;
    }
    const cal = sample && this.calOn ? new Float64Array(CALIB_STREETS.length * 6) : null;
    if (cal !== null) {
      this.calSec[sec] = cal;
      for (let k = 0; k < CALIB_STREETS.length; k++) {
        this.calMinSum[k][minute] ??= 0;
        this.calMinCnt[k][minute] ??= 0;
      }
    }
    const boxRow = sample ? new Uint16Array(this.net.junctions.length) : null;
    if (boxRow !== null) this.boxSec[sec] = boxRow;
    for (let i = 0; i < tr.hi; i++) {
      if (!tr.active[i]) continue;
      const sid = tr.seg[i];
      const sg = segs[sid];
      this.visited[sid] = 1;
      if (tr.s[i] < this.minS[sid]) this.minS[sid] = tr.s[i];
      if (sample) {
        const kmh = tr.v[i] * 3.6;
        this.speedSum[minute][tr.type[i]] += kmh;
        this.speedCnt[minute][tr.type[i]]++;
        this.allSum[minute] += kmh;
        this.allCnt[minute]++;
        this.secSum[sec] += kmh;
        this.secCnt[sec]++;
        this.secTypeSum[sec][tr.type[i]] += kmh;
        this.secTypeCnt[sec][tr.type[i]]++;
        const bj = this.connJunction[sid];
        if (boxRow !== null && bj >= 0 && tr.committed[i] === 1 && tr.v[i] < BOX_STAND_V) boxRow[bj]++;
        const k = this.streetOf[sid];
        if (cal !== null && k >= 0) {
          const o = k * 6;
          const g = this.groupOf[tr.type[i]];
          cal[o] += kmh;
          cal[o + 1]++;
          if (g === 1) {
            cal[o + 2] += kmh;
            cal[o + 3]++;
          } else if (g === 2) {
            cal[o + 4] += kmh;
            cal[o + 5]++;
          }
          this.calMinSum[k][minute] += kmh;
          this.calMinCnt[k][minute]++;
        }
      }
      if (sg.kind === SegKind.Link) {
        if (tr.stopT[i] > this.maxStop[sid] && !tr.crashed[i]) this.maxStop[sid] = tr.stopT[i];
        if (tr.stopT[i] > 0 && !tr.crashed[i]) {
          this.waiting[sid] = 1;
          const h = this.headVeh[sid];
          if (h < 0 || tr.s[i] > tr.s[h]) this.headVeh[sid] = i;
        }
        if (tr.v[i] < 0.5) this.queueNow[sid]++;
      } else if (sg.kind === SegKind.Ring) {
        const r = sg.ring;
        if (r >= 0) {
          if (tr.stopT[i] > this.ringMaxStop[r]) this.ringMaxStop[r] = tr.stopT[i];
          if (tr.stopT[i] > this.opts.ringStopSeconds) this.ringOver[r]++;
        }
      }
    }

    // ---- H2(c): starvation of inbound links (old definition: info; new: only while the exit has room)
    for (const inc of tr.incidents) this.waiting[inc.linkId] = 0;
    for (const l of this.inbound) {
      const id = l.id;
      if (this.queueNow[id] > this.maxQueue[id]) this.maxQueue[id] = this.queueNow[id];
      if (!this.waiting[id]) {
        this.lastProgress[id] = t;
        this.roomS[id] = 0;
        continue;
      }
      const starve = t - this.lastProgress[id];
      if (starve > this.maxStarve[id]) this.maxStarve[id] = starve;
      if (starve >= this.opts.starveSeconds && !this.starvedFlag[id]) {
        this.starvedFlag[id] = 1;
        this.starved.push({ link: id, atT: t });
      }
      if (this.exitHasRoom(this.headVeh[id])) {
        this.roomS[id] += this.opts.dt;
        if (starve >= this.opts.starveSeconds && this.roomS[id] >= this.opts.starveRoomSeconds && !this.starvedRoomFlag[id]) {
          this.starvedRoomFlag[id] = 1;
          this.starvedRoom.push({ link: id, atT: t });
        }
      }
    }

    if (this.steps % this.opts.wrongEvery === 0) {
      this.sampleWrongWay(t);
      this.sampleOverlap();
    }
  }

  /**
   * Whether the waiting head vehicle `h` of an inbound link could enter: the connector it is bound for is
   * clear and the link/arc behind it has storage for the vehicle (len + 3 m, capped at 70 % of a short link).
   */
  private exitHasRoom(h: number): boolean {
    if (h < 0) return false;
    const tr = this.tr;
    const ns = tr.nextSeg[h];
    if (ns < 0) return false;
    const out = this.net.segments[ns].next[0];
    if (!out) return false;
    const len = SPECS[tr.type[h]].length;
    if (this.minS[ns] < len + 1) return false;
    return Math.min(out.length, this.minS[out.id]) >= Math.min(len + 3, 0.7 * out.length);
  }

  private addExample(t: number, i: number, where: string, detail: string): void {
    const uid = this.tr.uid[i];
    if (this.examples.length < 12 && !this.examples.some((e) => e.uid === uid)) this.examples.push({ t, uid, type: this.tr.type[i] as VType, where, detail });
  }

  private uniqueVehicles(): { onewayLeft: number; twoWayLeftNonSwarm: number; swarmWrongTOver: number; headingBad: number; onewayHeadingBad: number } {
    const out = { onewayLeft: 0, twoWayLeftNonSwarm: 0, swarmWrongTOver: 0, headingBad: 0, onewayHeadingBad: 0 };
    for (const bits of this.flaggedUids.values()) {
      if (bits & 1) out.onewayLeft++;
      if (bits & 2) out.twoWayLeftNonSwarm++;
      if (bits & 4) out.swarmWrongTOver++;
      if (bits & 8) out.headingBad++;
      if (bits & 16) out.onewayHeadingBad++;
    }
    return out;
  }

  /** H4: lateral position and heading of every vehicle. */
  private sampleWrongWay(t: number): void {
    const tr = this.tr;
    const segs = this.net.segments;
    this.wrongSamples++;
    const tmp = this.tmp;
    for (let i = 0; i < tr.hi; i++) {
      if (!tr.active[i]) continue;
      const sid = tr.seg[i];
      const sg = segs[sid];
      const left = tr.l[i] < -sg.halfW - 0.1;
      let bits = 0;
      if (sg.kind === SegKind.Link) {
        if (sg.oneway) {
          if (left) {
            this.onewayLeft++;
            bits |= 1;
            this.addExample(t, i, segmentLabel(sg), `l=${tr.l[i].toFixed(2)} < −halfW ${(-sg.halfW).toFixed(2)} (một chiều)`);
          }
        } else if (SPECS[tr.type[i]].swarm) {
          const cap = 3 + 5 * tr.aggr[i];
          if (tr.wrongT[i] > cap + this.opts.dt) {
            this.swarmOver++;
            bits |= 4;
            this.swarmMaxOver = Math.max(this.swarmMaxOver, tr.wrongT[i] - cap);
            this.addExample(t, i, segmentLabel(sg), `wrongT=${tr.wrongT[i].toFixed(1)} s > ${cap.toFixed(1)}`);
          }
        } else if (left) {
          this.twoWayLeft++;
          bits |= 2;
          this.addExample(t, i, segmentLabel(sg), `ô tô l=${tr.l[i].toFixed(2)} < −halfW ${(-sg.halfW).toFixed(2)}`);
        }
      }
      sg.sample(tr.s[i], tmp);
      const dot = tr.hx[i] * tmp[2] + tr.hz[i] * tmp[3];
      if (dot <= -0.2) {
        this.headingBad++;
        bits |= 8;
        this.addExample(t, i, segmentLabel(sg), `hướng·tiếp tuyến = ${dot.toFixed(2)} ≤ −0,2`);
      }
      if (sg.kind === SegKind.Link && sg.oneway && dot <= 0) {
        this.onewayHeadingBad++;
        bits |= 16;
        this.addExample(t, i, segmentLabel(sg), `đường một chiều, hướng·tiếp tuyến = ${dot.toFixed(2)} ≤ 0`);
      }
      if (bits) {
        this.bump(this.wrongBySeg, sid);
        this.flaggedUids.set(tr.uid[i], (this.flaggedUids.get(tr.uid[i]) ?? 0) | bits);
      }
    }
  }

  /**
   * H4b: pairs of two-wheelers (Moto, Grab) whose bodies overlap. Cell hash of 3 m (hash collisions only add candidates, the
   * geometric test decides; each of the 9 neighbouring buckets is visited once per rider); a pair is counted once (j > i).
   */
  private sampleOverlap(): void {
    const tr = this.tr;
    const head = this.ovHead;
    const next = this.ovNext;
    const seen = this.ovSeen;
    const mask = OVERLAP_TABLE - 1;
    head.fill(-1);
    let bikes = 0;
    for (let i = 0; i < tr.hi; i++) {
      if (!tr.active[i] || !this.isBike[tr.type[i]]) continue;
      const cx = Math.floor(tr.x[i] / OVERLAP_CELL_M);
      const cz = Math.floor(tr.z[i] / OVERLAP_CELL_M);
      const b = (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) & mask;
      next[i] = head[b];
      head[b] = i;
      bikes++;
    }
    let pairs = 0;
    let deep = 0;
    let boxPairs = 0;
    for (let i = 0; i < tr.hi; i++) {
      if (!tr.active[i] || !this.isBike[tr.type[i]]) continue;
      const cx = Math.floor(tr.x[i] / OVERLAP_CELL_M);
      const cz = Math.floor(tr.z[i] / OVERLAP_CELL_M);
      const hxi = tr.hx[i];
      const hzi = tr.hz[i];
      let ns = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const b = (Math.imul(cx + dx, 73856093) ^ Math.imul(cz + dz, 19349663)) & mask;
          let dup = false;
          for (let k = 0; k < ns; k++) {
            if (seen[k] === b) {
              dup = true;
              break;
            }
          }
          if (dup) continue;
          seen[ns++] = b;
          for (let j = head[b]; j >= 0; j = next[j]) {
            if (j <= i) continue;
            const ex = tr.x[j] - tr.x[i];
            const ez = tr.z[j] - tr.z[i];
            const f = Math.abs(ex * hxi + ez * hzi);
            const lat = Math.abs(ex * hzi - ez * hxi);
            const hw = (tr.wid[i] + tr.wid[j]) * 0.5;
            const hl = (tr.len[i] + tr.len[j]) * 0.5;
            if (lat < hw - OVERLAP_LAT_M && f < hl - OVERLAP_LONG_M) {
              pairs++;
              if (this.connJunction[tr.seg[i]] >= 0 || this.connJunction[tr.seg[j]] >= 0) boxPairs++;
              if (lat < hw - DEEP_LAT_M && f < hl - DEEP_LONG_M) deep++;
            }
          }
        }
      }
    }
    this.ovSamples++;
    this.ovBikes += bikes;
    this.ovPairs += pairs;
    this.ovDeep += deep;
    this.ovBoxPairs += boxPairs;
  }

  /** H4b over the whole run: overlapping / deeply overlapping two-wheeler pairs per 1000 two-wheelers (Σ pairs / Σ riders over the samples). */
  overlap(): { samples: number; per1000: number; deepPer1000: number; boxPer1000: number } {
    return {
      samples: this.ovSamples,
      per1000: this.ovBikes > 0 ? (this.ovPairs * 1000) / this.ovBikes : 0,
      deepPer1000: this.ovBikes > 0 ? (this.ovDeep * 1000) / this.ovBikes : 0,
      boxPer1000: this.ovBikes > 0 ? (this.ovBoxPairs * 1000) / this.ovBikes : 0,
    };
  }

  /**
   * Box-jam census over the 1 Hz samples of [fromMinute, toMinute): committed vehicles standing (v < 0.5 m/s) on a junction's connectors.
   * `standingMean` = network-wide mean per sample; `top` = the BOX_TOP_N junctions with the highest mean (label, mean, max). null / empty without samples.
   */
  boxJam(fromMinute: number, toMinute: number): { standingMean: number | null; top: BoxJamStat[] } {
    const nJ = this.net.junctions.length;
    const sum = new Float64Array(nJ);
    const max = new Uint16Array(nJ);
    let seconds = 0;
    let total = 0;
    for (let k = Math.round(fromMinute * 60); k < Math.round(toMinute * 60) && k < this.boxSec.length; k++) {
      const row = this.boxSec[k];
      if (!row) continue;
      seconds++;
      for (let j = 0; j < nJ; j++) {
        const c = row[j];
        if (c === 0) continue;
        sum[j] += c;
        total += c;
        if (c > max[j]) max[j] = c;
      }
    }
    if (seconds === 0) return { standingMean: null, top: [] };
    const ids: number[] = [];
    for (let j = 0; j < nJ; j++) if (max[j] > 0) ids.push(j);
    ids.sort((a, b) => sum[b] - sum[a] || a - b);
    const top = ids.slice(0, BOX_TOP_N).map((j) => ({ junction: junctionLabel(this.net.junctions[j]), mean: sum[j] / seconds, max: max[j] }));
    return { standingMean: total / seconds, top };
  }

  /**
   * Mean speed (km/h) over the simulated window [fromMinute, toMinute), 1 Hz samples, count-weighted; null without samples.
   * `types` restricts the mean to those vehicle types (default: every vehicle).
   */
  meanSpeedKmh(fromMinute: number, toMinute: number, types?: readonly VType[]): number | null {
    let sum = 0;
    let cnt = 0;
    for (let k = Math.round(fromMinute * 60); k < Math.round(toMinute * 60) && k < this.secSum.length; k++) {
      if (types) {
        for (const ty of types) {
          sum += this.secTypeSum[k][ty];
          cnt += this.secTypeCnt[k][ty];
        }
      } else {
        sum += this.secSum[k];
        cnt += this.secCnt[k];
      }
    }
    return cnt ? sum / cnt : null;
  }

  /** Active-vehicle summary at this instant (the end of the run when called after the last step). */
  private endState(): EndState {
    const tr = this.tr;
    let active = 0;
    let old = 0;
    let ageSum = 0;
    let maxStop = 0;
    let maxSid = -1;
    let over60 = 0;
    const segs = this.net.segments;
    const pocketCnt = new Int32Array(segs.length);
    for (let i = 0; i < tr.hi; i++) {
      if (!tr.active[i]) continue;
      active++;
      ageSum += tr.age[i];
      if (tr.age[i] > this.opts.oldAgeSeconds) old++;
      if (tr.crashed[i]) continue;
      const st = tr.stopT[i];
      if (st > 60) {
        over60++;
        if (segs[tr.seg[i]].kind === SegKind.Link) pocketCnt[tr.seg[i]]++;
      }
      if (st > maxStop) {
        maxStop = st;
        maxSid = tr.seg[i];
      }
    }
    const pockets = listPockets(pocketCnt, segs);
    return {
      active,
      older: old,
      oldShare: active ? old / active : 0,
      meanAgeMin: active ? ageSum / active / 60 : 0,
      maxStopT: Math.round(maxStop * 10) / 10,
      maxStopWhere: maxSid >= 0 ? segmentLabel(segs[maxSid]) : '—',
      stoppedOver60: over60,
      pocketLinks: pockets.length,
      pockets: pockets.slice(0, 5),
    };
  }

  /**
   * Spillback trees at this instant. Edge A→B: the front-most vehicle of link A has been stopped ≥ 10 s and
   * the link behind its connector (B) has less tail room than the vehicle needs (same room/need rule as
   * `exitHasRoom`). Each A has at most one edge, so the graph is a forest plus cycles. A root is a B with
   * incoming edges that is not itself an edge source; its tree is every link that reaches it.
   */
  private spillback(): SpillState {
    const tr = this.tr;
    const segs = this.net.segments;
    const n = segs.length;
    const count = new Int32Array(n);
    const minS = new Float32Array(n).fill(Infinity);
    const maxStop = new Float32Array(n);
    const head = new Int32Array(n).fill(-1);
    for (let i = 0; i < tr.hi; i++) {
      if (!tr.active[i]) continue;
      const sid = tr.seg[i];
      count[sid]++;
      if (tr.s[i] < minS[sid]) minS[sid] = tr.s[i];
      if (tr.crashed[i]) continue;
      if (tr.stopT[i] > maxStop[sid]) maxStop[sid] = tr.stopT[i];
      if (segs[sid].kind === SegKind.Link && (head[sid] < 0 || tr.s[i] > tr.s[head[sid]])) head[sid] = i;
    }
    const edgeTo = new Int32Array(n).fill(-1);
    const inHead = new Int32Array(n).fill(-1);
    const inNext = new Int32Array(n).fill(-1);
    let edges = 0;
    for (let a = 0; a < n; a++) {
      const h = head[a];
      if (h < 0 || tr.stopT[h] < SPILL_STOP_S) continue;
      const ns = tr.nextSeg[h];
      if (ns < 0) continue;
      const out = segs[ns].next[0];
      if (!out) continue;
      const need = Math.min(SPECS[tr.type[h]].length + 3, 0.7 * out.length);
      if (Math.min(out.length, minS[out.id]) >= need) continue;
      edgeTo[a] = out.id;
      inNext[a] = inHead[out.id];
      inHead[out.id] = a;
      edges++;
    }
    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    const roots: SpillRoot[] = [];
    for (let b = 0; b < n; b++) {
      if (inHead[b] < 0 || edgeTo[b] >= 0) continue;
      let sp = 0;
      let upLinks = 0;
      let upVehicles = 0;
      for (let a = inHead[b]; a >= 0; a = inNext[a]) stack[sp++] = a;
      while (sp > 0) {
        const a = stack[--sp];
        if (seen[a]) continue;
        seen[a] = 1;
        upLinks++;
        upVehicles += count[a];
        for (let c = inHead[a]; c >= 0; c = inNext[c]) stack[sp++] = c;
      }
      const sg = segs[b];
      roots.push({
        link: b,
        street: sg.name || '(không tên)',
        to: junctionLabel(sg.to),
        length: Math.round(sg.length * 10) / 10,
        lanes: sg.lanes,
        vehicles: count[b],
        maxStopT: Math.round(maxStop[b] * 10) / 10,
        tailRoom: Math.round(Math.min(sg.length, minS[b]) * 10) / 10,
        upLinks,
        upVehicles,
      });
    }
    roots.sort((x, y) => y.upVehicles - x.upVehicles || x.link - y.link);
    let unLinks = 0;
    let unVeh = 0;
    for (let a = 0; a < n; a++) {
      if (edgeTo[a] >= 0 && !seen[a]) {
        unLinks++;
        unVeh += count[a];
      }
    }
    return { edges, roots: roots.slice(0, SPILL_TOP), unrooted: { links: unLinks, vehicles: unVeh } };
  }

  /** Opens/closes the green window of every signalised approach (call before this step's departures are diffed). */
  private updateSaturation(t: number): void {
    const sys = this.tr.signals;
    for (const l of this.sigLinks) {
      const sr = l.signal;
      if (sr === null) continue;
      const id = l.id;
      const green = sys.query(sr.nodeIndex, sr.group, t).light === Light.Green;
      if (green) {
        if (this.satActive[id] === 0) {
          this.satActive[id] = 1;
          this.satStart[id] = t;
          this.satLast[id] = t;
          // queueNow still holds the previous step: the queue the green finds.
          this.satQ[id] = this.queueNow[id];
          this.satCount[id] = 0;
          this.satMcu[id] = 0;
          const out = this.satOut[id] >= 0 ? this.net.segments[this.satOut[id]] : null;
          // minS still holds the previous step: the tail room the green finds on the main exit link.
          this.satClear[id] = out !== null && out.lanes >= l.lanes && Math.min(out.length, this.minS[out.id]) >= SAT_CLEAR_TAIL_M ? 1 : 0;
        }
      } else if (this.satActive[id] === 1) {
        this.satActive[id] = 0;
        this.closeGreen(id, t);
      }
    }
  }

  /**
   * Books one finished green as a saturation sample when its queue was ≥ 6 at the start. Departures count from
   * the 4th second of green; the window ends with the green when the queue still stood ≥ 2 vehicles, otherwise at the
   * last departure (the queue emptied: the tail of the green is not discharge capacity).
   */
  private closeGreen(id: number, t: number): void {
    if (this.satQ[id] < SAT_MIN_QUEUE) return;
    const from = this.satStart[id] + SAT_LOST_S;
    const end = this.queueNow[id] >= SAT_RESIDUAL_QUEUE ? t : this.satLast[id];
    const span = end - from;
    if (this.satCount[id] < SAT_MIN_VEH || span < SAT_MIN_SPAN_S) return;
    this.satCycles[id]++;
    this.satVeh[id] += this.satCount[id];
    this.satMcuTot[id] += this.satMcu[id];
    this.satTime[id] += span;
    if (this.satClear[id] === 1) {
      this.satCyclesClear[id]++;
      this.satMcuTotClear[id] += this.satMcu[id];
      this.satTimeClear[id] += span;
    }
  }

  /** Saturation flow per signalised approach with at least one valid green, most-sampled first. */
  saturation(): SaturationStat[] {
    const out: SaturationStat[] = [];
    for (const l of this.sigLinks) {
      const id = l.id;
      if (this.satCycles[id] === 0) continue;
      const widthM = 2 * l.halfW;
      out.push({
        link: id,
        street: l.name || '(không tên)',
        to: junctionLabel(l.to),
        lanes: l.lanes,
        widthM,
        cycles: this.satCycles[id],
        vehPerSM: this.satVeh[id] / this.satTime[id] / widthM,
        mcuPerSM: this.satMcuTot[id] / this.satTime[id] / widthM,
        clearCycles: this.satCyclesClear[id],
        mcuPerSMClear: this.satCyclesClear[id] > 0 ? this.satMcuTotClear[id] / this.satTimeClear[id] / widthM : null,
      });
    }
    out.sort((a, b) => b.cycles - a.cycles || a.link - b.link);
    return out;
  }

  /**
   * H9 per calibration street over the simulated window [fromMinute, toMinute) (1 Hz samples, count-weighted);
   * the worst-minute and sustained-gridlock flags cover the whole run. Empty when the map has none of the streets.
   */
  calibration(fromMinute: number, toMinute: number): StreetStat[] {
    if (!this.calOn) return [];
    const n = CALIB_STREETS.length;
    const sums = new Float64Array(n * 6);
    let secs = 0;
    for (let s = Math.round(fromMinute * 60); s < Math.round(toMinute * 60) && s < this.calSec.length; s++) {
      const row = this.calSec[s];
      if (!row) continue;
      secs++;
      for (let j = 0; j < n * 6; j++) sums[j] += row[j];
    }
    return CALIB_STREETS.map((name, k) => {
      const o = k * 6;
      const laneM = this.calLaneM[k];
      const laneM100 = this.calLaneM[k] / 100;
      const avg = (sum: number, cnt: number): number | null => (cnt > 0 ? sum / cnt : null);
      let worst: number | null = null;
      let worstMinute: number | null = null;
      let streak = 0;
      let sustained = false;
      const ms = this.calMinSum[k];
      const mc = this.calMinCnt[k];
      for (let m = 0; m < ms.length; m++) {
        const c = mc[m] ?? 0;
        const v = c >= CALIB_MIN_SAMPLES ? ms[m] / c : null;
        if (v !== null && (worst === null || v < worst)) {
          worst = v;
          worstMinute = m;
        }
        if (v !== null && v < CALIB_SUSTAIN_KMH) {
          streak++;
          if (streak >= CALIB_SUSTAIN_MIN) sustained = true;
        } else streak = 0;
      }
      return {
        name,
        links: this.calLinks[k],
        laneM,
        samples: sums[o + 1],
        speedKmh: avg(sums[o], sums[o + 1]),
        carKmh: avg(sums[o + 2], sums[o + 3]),
        bikeKmh: avg(sums[o + 4], sums[o + 5]),
        vehPer100mLane: secs > 0 && laneM100 > 0 ? sums[o + 1] / secs / laneM100 : null,
        bikePer100mLane: secs > 0 && laneM100 > 0 ? sums[o + 5] / secs / laneM100 : null,
        worstMinuteKmh: worst,
        worstMinute,
        sustainedBelow6: sustained,
      };
    });
  }

  report(): MonitorReport {
    const segs = this.net.segments;
    const links = this.net.links;
    const rank = (m: Map<number, number>, end: 'from' | 'to'): { link: number; portal: string; count: number }[] =>
      [...m.entries()]
        .map(([link, count]) => {
          const sg = segs[link];
          const j = sg[end];
          return { link, portal: j ? `${j.key} ${j.name || sg.name}`.trim() : `seg#${link}`, count };
        })
        .sort((a, b) => b.count - a.count || a.link - b.link);

    const stops: StopLineStat[] = this.inbound.map((l) => ({
      link: l.id,
      street: l.name || '(không tên)',
      to: junctionLabel(l.to),
      signalised: l.signal !== null,
      yields: l.yieldAt !== null,
      lanes: l.lanes,
      maxStopT: Math.round(this.maxStop[l.id] * 10) / 10,
      maxQueue: this.maxQueue[l.id],
      departures: this.departures[l.id],
      maxStarveS: Math.round(this.maxStarve[l.id]),
    }));
    stops.sort((a, b) => b.maxStopT - a.maxStopT || b.maxQueue - a.maxQueue || a.link - b.link);

    const minutes = this.speedSum.length;
    const speedByType: (number | null)[][] = [];
    const speedAll: number[] = [];
    for (let m = 0; m < minutes; m++) {
      speedByType.push(this.speedSum[m] ? this.speedSum[m].map((s, k) => (this.speedCnt[m][k] ? Math.round((s / this.speedCnt[m][k]) * 10) / 10 : null)) : new Array<null>(VTYPE_COUNT).fill(null));
      speedAll.push(this.allCnt[m] ? Math.round((this.allSum[m] / this.allCnt[m]) * 10) / 10 : 0);
    }

    const bySegment = [...this.wrongBySeg.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, count]) => ({ seg: segmentLabel(segs[id]), count }));

    return {
      steps: this.steps,
      seconds: this.steps * this.opts.dt,
      spawns: this.spawns,
      despawns: this.despawns,
      releases: this.releases,
      spawnByType: this.spawnByType.slice(),
      despawnByType: this.despawnByType.slice(),
      despawnPerMinute: Array.from({ length: Math.ceil(this.steps / 3600) }, (_, m) => this.despawnMin[m] ?? 0),
      releaseByType: this.releaseByType.slice(),
      spawnByPortal: rank(this.spawnAt, 'from'),
      despawnByPortal: rank(this.despawnAt, 'to'),
      releaseByJunction: [...this.releaseAt.entries()]
        .map(([id, count]) => ({ junction: junctionLabel(this.net.junctions[id] ?? null), count }))
        .sort((a, b) => b.count - a.count),
      speedByTypePerMinute: speedByType,
      speedAllPerMinute: speedAll,
      worstStopLines: stops.slice(0, 10),
      starved: this.starved.map((s) => ({ link: s.link, street: segs[s.link].name, to: junctionLabel(segs[s.link].to), atT: Math.round(s.atT) })),
      starvedRoom: this.starvedRoom.map((s) => ({ link: s.link, street: segs[s.link].name, to: junctionLabel(segs[s.link].to), atT: Math.round(s.atT) })),
      linksNeverVisited: links
        .filter((l) => !this.visited[l.id])
        .map((l) => ({ link: l.id, street: l.name, from: junctionLabel(l.from), to: junctionLabel(l.to) })),
      rings: this.net.rings.map((r, ri) => ({ ring: ri, name: r.name, entries: this.ringEntries[ri], exits: this.ringExits[ri], maxStopT: Math.round(this.ringMaxStop[ri] * 10) / 10, stoppedOverLimit: this.ringOver[ri] })),
      ageAtDespawn: { edgesMin: AGE_EDGES_MIN.slice(), counts: this.ageHist.slice(), meanMin: this.despawns > 0 ? this.ageSum / this.despawns / 60 : null },
      earlyLinkRemovals: this.earlyRemovals,
      arrivals: this.arrivals,
      end: this.endState(),
      spill: this.spillback(),
      wrong: {
        onewayLeft: this.onewayLeft,
        twoWayLeftNonSwarm: this.twoWayLeft,
        swarmWrongTOver: this.swarmOver,
        headingBad: this.headingBad,
        onewayHeadingBad: this.onewayHeadingBad,
        samples: this.wrongSamples,
        swarmMaxOverS: Math.round(this.swarmMaxOver * 10) / 10,
        vehicles: this.uniqueVehicles(),
        bySegment,
        examples: this.examples.slice(),
      },
    };
  }
}

// ------------------------------------------------------------------ H2 protocol (several seeds per configuration)

/** 'ref' = N ≤ N_ref (all criteria hard); 'stress' = N above N_ref ((a)(c)(d) hard); 'legacy' = regression map. */
export type GridlockProfile = 'ref' | 'stress' | 'legacy';
export type CriterionId = 'a' | 'b' | 'c' | 'd' | 'e' | 'f';
/** 'quick' = 10-minute screening run; 'ss30' = 30-minute steady-state acceptance (windows [10,20) vs [20,30)). */
export type ProtocolId = 'quick' | 'ss30';

export interface ProtocolSpec {
  /** Default run length (sim minutes); also the first length at which every window below is measurable. */
  minutes: number;
  /** Reference and late windows [from, to) in sim minutes: (b) compares late against ref; (e) is the late mean speed. */
  refFrom: number;
  refTo: number;
  lateFrom: number;
  lateTo: number;
  /** (b) slope of the per-minute mean speed over [slopeFrom, slopeTo) must be ≥ slopeMin (km/h per minute). */
  slopeFrom: number;
  slopeTo: number;
  slopeMin: number;
  /** (b) |mean v̄ late / mean v̄ ref − 1| ≤ speedTol; null = not part of the rule. */
  speedTol: number | null;
  /** (b) |despawn/min late / ref − 1| ≤ tputTol. */
  tputTol: number;
  /** (a) locks30 = releases + locksBroken + teleports per run: median over seeds ≤ locksMedianMax (ref only), max ≤ locksRef / locksStress. */
  locksMedianMax: number;
  locksRef: number;
  locksStress: number;
  /** (a) stress profile: locks30 · 1000 / target per run, max over seeds ≤ this, instead of the absolute `locksStress`; null = use `locksStress`. */
  locksPer1000Max: number | null;
  /** (a) the longest current `stopT` (s) at the end of every run; null = not checked. */
  maxStopTS: number | null;
  /** (e) floor on the late-window mean speed at N_ref (km/h). */
  floorKmh: number;
  /** (f) active vehicles older than 20 min / active at the end of the run; null = not checked. */
  oldShareMax: number | null;
}

export const PROTOCOL = {
  quick: {
    minutes: 10,
    refFrom: 3,
    refTo: 5,
    lateFrom: 5,
    lateTo: 10,
    slopeFrom: 4,
    slopeTo: 10,
    slopeMin: -0.5,
    speedTol: null,
    tputTol: 0.15,
    locksMedianMax: 1,
    locksRef: 3,
    locksStress: 5,
    locksPer1000Max: null,
    maxStopTS: null,
    floorKmh: 10,
    oldShareMax: null,
  },
  ss30: {
    minutes: 30,
    refFrom: 10,
    refTo: 20,
    lateFrom: 20,
    lateTo: 30,
    slopeFrom: 10,
    slopeTo: 30,
    slopeMin: -0.15,
    speedTol: 0.15,
    tputTol: 0.15,
    locksMedianMax: 3,
    locksRef: 8,
    locksStress: 30,
    locksPer1000Max: 80,
    maxStopTS: 300,
    floorKmh: 10,
    oldShareMax: 0.05,
  },
  /** Legacy regression map (hour 17, 1100 vehicles, 10 min, 5 seeds): release share (% of spawns) per seed; late-half v̄ median vs the baseline median. */
  legacy: { minutes: 10, releasePct: 1.2, baselineDeltaKmh: 0.5 },
} as const satisfies { quick: ProtocolSpec; ss30: ProtocolSpec; legacy: object };

function requiredFor(profile: GridlockProfile, protocol: ProtocolId): CriterionId[] {
  if (profile === 'legacy') return ['a', 'd', 'e'];
  if (profile === 'stress') return ['a', 'c', 'd'];
  return protocol === 'ss30' ? ['a', 'b', 'c', 'd', 'e', 'f'] : ['a', 'b', 'c', 'd', 'e'];
}

/** What the legacy gate needs from `data/harness/baseline-legacy.json` (a previous `--map legacy --seeds K --json` output). */
export interface LegacyBaseline {
  /** Median over seeds of the late-half mean speed (km/h). */
  lateSpeedMedianKmh: number;
  /** Run length (sim minutes) the baseline was recorded at; only comparable with runs of the same length. */
  minutes: number;
}

const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function parseLegacyBaseline(json: unknown): LegacyBaseline | null {
  const root = asRecord(json);
  const cfgs = root?.configs;
  const cfg = Array.isArray(cfgs) ? asRecord(cfgs[0]) : null;
  const median = asRecord(asRecord(cfg?.stats)?.speedLate)?.median;
  const minutes = asRecord(root?.args)?.minutes;
  return typeof median === 'number' && typeof minutes === 'number' ? { lateSpeedMedianKmh: median, minutes } : null;
}

/** Calibration groups: TomTom measures cars (taxis included); bikes are reported only. */
export const CAR_TYPES: readonly VType[] = [VType.Car, VType.TaxiVinasun, VType.TaxiMaiLinh, VType.RideCar];
export const BIKE_TYPES: readonly VType[] = [VType.Moto, VType.Grab];

/** Everything H2 needs from one finished run; JSON-serialisable. */
export interface RunMetrics {
  protocol: ProtocolId;
  minutes: number;
  /** The run covers every window of its protocol (minutes ≥ lateTo); false = (b)(e)(f) are n/a. */
  windowed: boolean;
  spawns: number;
  despawns: number;
  /** Traffic counters (authoritative). */
  releases: number;
  locksBroken: number;
  /** Vehicles the sim's last-resort teleport removed (0 while the sim has no teleport). */
  teleports: number;
  /** releases + locksBroken. */
  locks: number;
  /** releases + locksBroken + teleports: the failure telemetry criterion (a) bounds. */
  locks30: number;
  /** Diff-based monitor count of vehicles removed inside a junction/ring (cross-check of `releases`). */
  monitorReleases: number;
  /** Diff-based count of link removals ≥ 3 m short of the link end (cross-check of `teleports`). */
  monitorEarlyLinkRemovals: number;
  releasePct: number;
  speedPerMinute: number[];
  despawnPerMinute: number[];
  speedMeanKmh: number | null;
  lateFromMinute: number;
  /** Mean speed (km/h, 1 Hz samples) from `lateFromMinute` to the end of the late window. */
  lateSpeedKmh: number | null;
  /** Car + taxi (VType 2–4) mean speed (km/h, 1 Hz samples) over the same window as `lateSpeedKmh`: the TomTom calibration metric. */
  carSpeedLateKmh: number | null;
  /** Motorbike + ride-hail (VType 0–1) mean speed over the same window; reported only. */
  bikeSpeedLateKmh: number | null;
  /** Mean of the per-minute mean speeds over the ref / late windows; ratio = late / ref. */
  speedRefKmh: number | null;
  speedLateKmh: number | null;
  speedRatio: number | null;
  /** Slope (km/h per minute) of the per-minute mean speed over [slopeFrom, slopeTo); null for runs shorter than the window. */
  slope: number | null;
  tputRefMean: number | null;
  tputLateMean: number | null;
  /** Late despawn/min over the ref-window mean. */
  tputRatio: number | null;
  /** H2(c): inbound links starved ≥ 180 s while their exit had room. */
  starvedRoom: number;
  /** Old (c) definition, info only. */
  starvedOld: number;
  /** Ring-arc samples with stopT > ringStopSeconds, and the longest ring stop (s). */
  ringOver: number;
  ringMaxStopT: number;
  /** End of run: active vehicles, those older than 20 min, their share, and the longest current stopT (s). */
  endActive: number;
  endOld: number;
  oldShare: number;
  maxStopTEnd: number;
  /** Vehicles that reached an internal destination: the Traffic counter (authoritative) and the diff-monitor count (cross-check). */
  arrivals: number;
  monitorArrivals: number;
  /** locks30 · 1000 / target vehicles. */
  locksPer1000: number;
  /** H9: per calibration street over the late window (empty on maps without them). */
  streets: StreetStat[];
  /** Arterial aggregate of `streets`: count-weighted mean speed (km/h), vehicles and two-wheelers per 100 m of lane, and the slowest street's mean speed. */
  artSpeedKmh: number | null;
  artDensity: number | null;
  artBikeDensity: number | null;
  minStreetKmh: number | null;
  /** Saturation flow at signalised approaches (all with a valid green) and the median over those with ≥ 2 valid greens. */
  saturation: SaturationStat[];
  satMedianVehPerSM: number | null;
  satMedianMcuPerSM: number | null;
  /** Median over approaches with ≥ 2 valid greens that all met the 'clear exit' condition (main exit lanes ≥ approach lanes, tail room ≥ 20 m at the green start); the only saturation figure that WARNs. */
  satMedianMcuPerSMClear: number | null;
  /** H4b: overlapping / deeply overlapping two-wheeler pairs per 1000 two-wheelers (Σ pairs / Σ riders over the samples). */
  overlapPer1000: number;
  deepOverlapPer1000: number;
  /** The part of `overlapPer1000` where at least one rider of the pair is on a junction connector (same denominator: all two-wheelers). */
  overlapBoxPer1000: number;
  /** Box-jam census over the late window: committed vehicles standing (v < 0.5 m/s) on connectors, network-wide mean per second (null without samples), and the top-5 junctions. */
  boxStandingMean: number | null;
  boxTop: BoxJamStat[];
  /** Car + taxi share of the vehicles on the map right after `populate` and at the end, and the two-wheeler share at the end (fractions); null = not recorded (a run with `--switch-*` changes the hour, so the drift is meaningless). */
  carShareStart: number | null;
  carShareEnd: number | null;
  bikeShareEnd: number | null;
  /** (car+taxi share at the end − share after populate) · 100, percentage points. */
  mixDriftPts: number | null;
  /** H10 samples of a run with `--switch-*`; null otherwise. */
  recovery: RecoveryStat | null;
}

/** Inputs of `runMetrics` that the monitor cannot see. */
export interface RunExtras {
  mix?: { start: { car: number; bike: number }; end: { car: number; bike: number } };
  recovery?: RecoveryStat;
}

const mean = (v: number[]): number | null => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

function slopeOf(ys: number[]): number | null {
  const n = ys.length;
  if (n < 3) return null;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (ys[i] - my);
    den += (i - mx) * (i - mx);
  }
  return num / den;
}

/** `teleports` is 0 while the sim has no teleport counter. */
export function runMetrics(
  m: SimMonitor,
  rep: MonitorReport,
  counters: { releases: number; locksBroken: number; teleports: number; arrivals: number },
  minutes: number,
  protocol: ProtocolId = 'quick',
  target = 0,
  extras: RunExtras = {},
): RunMetrics {
  const sp: ProtocolSpec = PROTOCOL[protocol];
  const full = minutes >= sp.lateTo;
  const lateFrom = full ? sp.lateFrom : minutes / 2;
  const speed = rep.speedAllPerMinute;
  const dp = rep.despawnPerMinute;
  const refMean = full ? mean(dp.slice(sp.refFrom, sp.refTo)) : null;
  const lateMean = full ? mean(dp.slice(sp.lateFrom, sp.lateTo)) : null;
  const speedRef = full ? mean(speed.slice(sp.refFrom, sp.refTo)) : null;
  const speedLate = full ? mean(speed.slice(sp.lateFrom, sp.lateTo)) : null;
  const lateTo = full ? sp.lateTo : minutes;
  const streets = m.calibration(lateFrom, lateTo);
  const sampled = streets.filter((s) => s.speedKmh !== null && s.samples > 0);
  const sampleSum = sampled.reduce((a, s) => a + s.samples, 0);
  const laneSum = streets.reduce((a, s) => a + s.laneM, 0);
  const weighted = (get: (s: StreetStat) => number | null, wt: (s: StreetStat) => number): number | null => {
    let num = 0;
    let den = 0;
    for (const s of streets) {
      const v = get(s);
      if (v === null) continue;
      num += v * wt(s);
      den += wt(s);
    }
    return den > 0 ? num / den : null;
  };
  const saturation = m.saturation();
  const satEnough = saturation.filter((s) => s.cycles >= SAT_MIN_CYCLES);
  const satClearEnough = saturation.filter((s) => s.clearCycles >= SAT_MIN_CYCLES && s.mcuPerSMClear !== null);
  const overlap = m.overlap();
  const boxJam = m.boxJam(lateFrom, lateTo);
  const locks = counters.releases + counters.locksBroken;
  const locks30 = locks + counters.teleports;
  return {
    protocol,
    minutes,
    windowed: full,
    spawns: rep.spawns,
    despawns: rep.despawns,
    releases: counters.releases,
    locksBroken: counters.locksBroken,
    teleports: counters.teleports,
    locks,
    locks30: locks + counters.teleports,
    monitorReleases: rep.releases,
    monitorEarlyLinkRemovals: rep.earlyLinkRemovals,
    releasePct: rep.spawns > 0 ? (counters.releases / rep.spawns) * 100 : 0,
    speedPerMinute: speed.slice(),
    despawnPerMinute: dp.slice(),
    speedMeanKmh: m.meanSpeedKmh(0, minutes),
    lateFromMinute: lateFrom,
    lateSpeedKmh: m.meanSpeedKmh(lateFrom, full ? sp.lateTo : minutes),
    carSpeedLateKmh: m.meanSpeedKmh(lateFrom, full ? sp.lateTo : minutes, CAR_TYPES),
    bikeSpeedLateKmh: m.meanSpeedKmh(lateFrom, full ? sp.lateTo : minutes, BIKE_TYPES),
    speedRefKmh: speedRef,
    speedLateKmh: speedLate,
    speedRatio: speedRef !== null && speedLate !== null && speedRef > 0 ? speedLate / speedRef : null,
    slope: full ? slopeOf(speed.slice(sp.slopeFrom, sp.slopeTo)) : null,
    tputRefMean: refMean,
    tputLateMean: lateMean,
    tputRatio: refMean !== null && lateMean !== null && refMean > 0 ? lateMean / refMean : null,
    starvedRoom: rep.starvedRoom.length,
    starvedOld: rep.starved.length,
    ringOver: rep.rings.reduce((a, r) => a + r.stoppedOverLimit, 0),
    ringMaxStopT: rep.rings.reduce((a, r) => Math.max(a, r.maxStopT), 0),
    endActive: rep.end.active,
    endOld: rep.end.older,
    oldShare: rep.end.oldShare,
    maxStopTEnd: rep.end.maxStopT,
    arrivals: counters.arrivals,
    monitorArrivals: rep.arrivals,
    locksPer1000: target > 0 ? (locks30 * 1000) / target : 0,
    streets,
    artSpeedKmh: sampleSum > 0 ? weighted((s) => s.speedKmh, (s) => s.samples) : null,
    artDensity: laneSum > 0 ? weighted((s) => s.vehPer100mLane, (s) => s.laneM) : null,
    artBikeDensity: laneSum > 0 ? weighted((s) => s.bikePer100mLane, (s) => s.laneM) : null,
    minStreetKmh: sampled.length ? Math.min(...sampled.map((s) => s.speedKmh ?? Infinity)) : null,
    saturation,
    satMedianVehPerSM: stat(satEnough.map((s) => s.vehPerSM))?.median ?? null,
    satMedianMcuPerSM: stat(satEnough.map((s) => s.mcuPerSM))?.median ?? null,
    satMedianMcuPerSMClear: stat(satClearEnough.map((s) => s.mcuPerSMClear ?? 0))?.median ?? null,
    overlapPer1000: overlap.per1000,
    deepOverlapPer1000: overlap.deepPer1000,
    overlapBoxPer1000: overlap.boxPer1000,
    boxStandingMean: boxJam.standingMean,
    boxTop: boxJam.top,
    carShareStart: extras.mix?.start.car ?? null,
    carShareEnd: extras.mix?.end.car ?? null,
    bikeShareEnd: extras.mix?.end.bike ?? null,
    mixDriftPts: extras.mix ? (extras.mix.end.car - extras.mix.start.car) * 100 : null,
    recovery: extras.recovery ?? null,
  };
}

export interface Stat {
  median: number;
  min: number;
  max: number;
}

export function stat(values: number[]): Stat | null {
  if (values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return { median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2, min: s[0], max: s[s.length - 1] };
}

/** Per-run criteria; null = not measurable (run shorter than the protocol window, or not part of the profile). */
function runCriteria(r: RunMetrics, profile: GridlockProfile): Record<CriterionId, boolean | null> {
  if (profile === 'legacy') {
    // (e) compares a median over seeds with the baseline median: judged in `evalGridlockSeeds`, not per run.
    return { a: r.releasePct <= PROTOCOL.legacy.releasePct, b: null, c: r.starvedRoom === 0, d: r.ringOver === 0, e: null, f: null };
  }
  const sp: ProtocolSpec = PROTOCOL[r.protocol];
  const lockOk = profile === 'ref' ? r.locks30 <= sp.locksRef : sp.locksPer1000Max !== null ? r.locksPer1000 <= sp.locksPer1000Max : r.locks30 <= sp.locksStress;
  const a = lockOk && (sp.maxStopTS === null || r.maxStopTEnd <= sp.maxStopTS);
  let b: boolean | null = null;
  if (r.slope !== null && r.tputRatio !== null && (sp.speedTol === null || r.speedRatio !== null)) {
    b = r.slope >= sp.slopeMin && Math.abs(r.tputRatio - 1) <= sp.tputTol && (sp.speedTol === null || Math.abs((r.speedRatio ?? 1) - 1) <= sp.speedTol);
  }
  return {
    a,
    b,
    c: r.starvedRoom === 0,
    d: r.ringOver === 0,
    e: r.lateSpeedKmh === null || !r.windowed ? null : r.lateSpeedKmh >= sp.floorKmh,
    f: sp.oldShareMax === null || !r.windowed ? null : r.oldShare <= sp.oldShareMax,
  };
}

const f1 = (v: number | null, d = 1): string => (v === null ? '–' : v.toFixed(d));
const pct = (v: number, d = 1): string => `${(v * 100).toFixed(d)} %`;

function describe(r: RunMetrics, profile: GridlockProfile, crit: Record<CriterionId, boolean | null>, baseline: LegacyBaseline | null): { parts: string[]; problems: string[]; warnings: string[]; info: string[] } {
  const sp: ProtocolSpec = PROTOCOL[r.protocol];
  const req = requiredFor(profile, r.protocol);
  const mark = (id: CriterionId): string => (crit[id] === null ? '?' : crit[id] ? '✓' : req.includes(id) ? '✗' : '·');
  const problems: string[] = [];
  const need = (id: CriterionId, text: string): void => {
    if (req.includes(id) && crit[id] === false) problems.push(`(${id}) ${text}`);
  };
  const perMille = profile === 'stress' && sp.locksPer1000Max !== null;
  const lockMax = profile === 'ref' ? sp.locksRef : sp.locksStress;
  const lockTxt = perMille ? `≤ ${sp.locksPer1000Max}/1000 xe, nay ${r.locksPer1000.toFixed(1)}` : `≤ ${lockMax}`;
  const parts: string[] = [];
  const warnings: string[] = [];
  if (profile === 'legacy') {
    parts.push(`(a) ${mark('a')} release ${r.releases}/${r.spawns} = ${r.releasePct.toFixed(2)} % (≤ ${PROTOCOL.legacy.releasePct} %)`);
    need('a', `release ${r.releases}/${r.spawns} spawn = ${r.releasePct.toFixed(2)} % > ${PROTOCOL.legacy.releasePct} %`);
  } else {
    const stopTxt = sp.maxStopTS === null ? '' : ` · maxStopT cuối ${r.maxStopTEnd.toFixed(0)} s (≤ ${sp.maxStopTS})`;
    parts.push(`(a) ${mark('a')} locks30 ${r.locks30} (release ${r.releases} + gỡ khoá ${r.locksBroken} + teleport ${r.teleports}; ${lockTxt})${stopTxt}`);
    if (req.includes('a')) {
      const over = perMille ? r.locksPer1000 > (sp.locksPer1000Max ?? 0) : r.locks30 > lockMax;
      if (over) problems.push(`(a) locks30 ${r.locks30} (${r.locksPer1000.toFixed(1)}/1000 xe) > ${perMille ? `${sp.locksPer1000Max}/1000 xe` : lockMax} (release ${r.releases}, locksBroken ${r.locksBroken}, teleports ${r.teleports})`);
      if (sp.maxStopTS !== null && r.maxStopTEnd > sp.maxStopTS) problems.push(`(a) maxStopT cuối run ${r.maxStopTEnd.toFixed(0)} s > ${sp.maxStopTS} s`);
    }
  }
  if (profile !== 'legacy' && r.mixDriftPts !== null && r.carShareStart !== null && r.carShareEnd !== null) {
    const bad = r.mixDriftPts > MIX_DRIFT_WARN_PTS;
    const txt = `ô tô+taxi ${pct(r.carShareStart)} → ${pct(r.carShareEnd)} (drift ${r.mixDriftPts >= 0 ? '+' : ''}${r.mixDriftPts.toFixed(1)} điểm; WARN > ${MIX_DRIFT_WARN_PTS})`;
    parts.push(`(a″) ${bad ? '!' : '✓'} ${txt}`);
    if (bad) warnings.push(`(a″) ${txt}`);
  }
  if (profile !== 'legacy') {
    const speedTxt = sp.speedTol === null ? '' : `v̄ phút ${sp.lateFrom}–${sp.lateTo}/${sp.refFrom}–${sp.refTo} = ${f1(r.speedLateKmh)}/${f1(r.speedRefKmh)} = ${f1(r.speedRatio, 2)} (±${sp.speedTol * 100} %) · `;
    parts.push(`(b) ${mark('b')} ${speedTxt}slope ${f1(r.slope, 2)} km/h/phút (≥ ${sp.slopeMin}) · despawn/phút ${f1(r.tputLateMean)}/${f1(r.tputRefMean)} = ${f1(r.tputRatio, 2)} (±${sp.tputTol * 100} %)`);
    if (crit.b === false) {
      const why: string[] = [];
      if (sp.speedTol !== null && r.speedRatio !== null && Math.abs(r.speedRatio - 1) > sp.speedTol) why.push(`v̄ phút ${sp.lateFrom}–${sp.lateTo} = ${(r.speedRatio * 100).toFixed(0)} % của phút ${sp.refFrom}–${sp.refTo} (±${sp.speedTol * 100} %)`);
      if (r.slope !== null && r.slope < sp.slopeMin) why.push(`slope ${r.slope.toFixed(2)} < ${sp.slopeMin} km/h/phút`);
      if (r.tputRatio !== null && Math.abs(r.tputRatio - 1) > sp.tputTol) why.push(`throughput phút ${sp.lateFrom}–${sp.lateTo} = ${(r.tputRatio * 100).toFixed(0)} % của phút ${sp.refFrom}–${sp.refTo}`);
      need('b', why.join('; '));
    }
  }
  parts.push(`(c) ${mark('c')} đói có chỗ ra ${r.starvedRoom}`);
  need('c', `${r.starvedRoom} link inbound có xe chờ ≥ 180 s trong khi lối ra có chỗ ≥ 60 s`);
  parts.push(`(d) ${mark('d')} ring stopT>45s ${r.ringOver} mẫu (max ${r.ringMaxStopT.toFixed(0)} s)`);
  need('d', `xe trên cung ring đứng > 45 s (${r.ringOver} mẫu-bước, max ${r.ringMaxStopT.toFixed(0)} s)`);
  if (profile === 'legacy') {
    const floor = baseline ? baseline.lateSpeedMedianKmh - PROTOCOL.legacy.baselineDeltaKmh : null;
    parts.push(`(e) ${mark('e')} v̄ nửa sau = ${f1(r.lateSpeedKmh, 2)} km/h${floor === null ? '' : ` (median qua seed ≥ ${floor.toFixed(2)})`}`);
  } else {
    parts.push(`(e) ${mark('e')} v̄ phút ${r.lateFromMinute}–${r.windowed ? sp.lateTo : r.minutes} = ${f1(r.lateSpeedKmh, 2)} km/h (≥ ${sp.floorKmh})`);
    need('e', `v̄ phút ${r.lateFromMinute}–${r.windowed ? sp.lateTo : r.minutes} = ${f1(r.lateSpeedKmh, 2)} km/h < ${sp.floorKmh}`);
    if (sp.oldShareMax !== null) {
      parts.push(`(f) ${mark('f')} xe > 20 phút ${r.endOld}/${r.endActive} = ${pct(r.oldShare)} (≤ ${pct(sp.oldShareMax, 0)})`);
      need('f', `${r.endOld}/${r.endActive} xe active tuổi > 20 phút = ${pct(r.oldShare)} > ${pct(sp.oldShareMax, 0)}`);
    }
  }
  const info: string[] = [];
  if (profile !== 'legacy' && crit.b === null) info.push(`(b) bỏ qua: cần chạy ≥ ${sp.lateTo} phút`);
  if (profile !== 'legacy' && sp.oldShareMax !== null && crit.f === null) info.push(`(f) bỏ qua: cần chạy ≥ ${sp.lateTo} phút`);
  if (profile === 'stress') info.push('(b)(e)(f) ở stress chỉ báo cáo, không chặn');
  if (profile === 'legacy') {
    info.push('legacy: không áp slope/throughput; (e) so median qua seed với baseline (--seeds)');
    if (baseline && baseline.minutes !== r.minutes) info.push(`baseline ghi ở ${baseline.minutes} phút ≠ run ${r.minutes} phút: không so sánh được`);
  }
  if (sp.oldShareMax === null) info.push(`info (f): xe active tuổi > 20 phút ${r.endOld}/${r.endActive} = ${pct(r.oldShare)}`);
  info.push(`info (tiêu chí cũ): release ${r.releases}/${r.spawns} = ${r.releasePct.toFixed(2)} % (cũ ≤ 2 %) · v̄ ${f1(r.lateSpeedKmh, 2)} (cũ ≥ 6) · đói theo định nghĩa cũ ${r.starvedOld}`);
  info.push(`info (đối chiếu): release theo diff-monitor ${r.monitorReleases} vs counter ${r.releases}${r.monitorReleases === r.releases ? '' : ' — LỆCH'}`);
  info.push(`info (đối chiếu): xe rời link ≥ 3 m trước cuối link (diff-monitor) ${r.monitorEarlyLinkRemovals} vs teleport ${r.teleports}${r.monitorEarlyLinkRemovals === r.teleports ? '' : ' — LỆCH'}`);
  return { parts, problems, warnings, info };
}

/** H2 for a single run (one seed). Median-over-seeds rules need `evalGridlockSeeds`. */
export function evalGridlock(r: RunMetrics, profile: GridlockProfile, baseline: LegacyBaseline | null = null): CheckResult {
  const crit = runCriteria(r, profile);
  const d = describe(r, profile, crit, baseline);
  return {
    id: 'H2',
    title: 'Gridlock',
    status: d.problems.length ? 'fail' : d.warnings.length ? 'warn' : 'pass',
    summary: `[${profile}${profile === 'legacy' ? '' : `, ${r.protocol}`}] ${d.parts.join(' · ')}`,
    details: [...d.problems, ...d.warnings, ...d.info],
  };
}

export interface SeedsVerdict {
  ok: boolean;
  result: CheckResult;
}

/**
 * H2 for one configuration over several seeds: (a) median and max over seeds, (b)–(f) every seed. Legacy:
 * release share per seed and the late-half median against `baseline` (a baseline recorded at another run
 * length cannot be compared: reported as a warning, not a pass).
 */
export function evalGridlockSeeds(runs: RunMetrics[], profile: GridlockProfile, baseline: LegacyBaseline | null = null): SeedsVerdict {
  const protocol: ProtocolId = runs[0]?.protocol ?? 'quick';
  const sp: ProtocolSpec = PROTOCOL[protocol];
  const req = requiredFor(profile, protocol);
  const crits = runs.map((r) => runCriteria(r, profile));
  const problems: string[] = [];
  const warnings: string[] = [];
  const parts: string[] = [];
  const n = runs.length;
  const relStat = stat(runs.map((r) => r.releasePct));
  if (profile === 'legacy') {
    const bad = crits.filter((c) => c.a === false).length;
    parts.push(`(a) release % median ${f1(relStat?.median ?? null, 2)} max ${f1(relStat?.max ?? null, 2)} (≤ ${PROTOCOL.legacy.releasePct})`);
    if (bad) problems.push(`(a) ${bad}/${n} seed có release > ${PROTOCOL.legacy.releasePct} % spawn`);
    const late = stat(runs.flatMap((r) => (r.lateSpeedKmh === null ? [] : [r.lateSpeedKmh])));
    if (baseline && late && baseline.minutes === runs[0].minutes) {
      const floor = baseline.lateSpeedMedianKmh - PROTOCOL.legacy.baselineDeltaKmh;
      parts.push(`(e) v̄ nửa sau median ${f1(late.median, 2)} min ${f1(late.min, 2)} (median ≥ baseline ${f1(baseline.lateSpeedMedianKmh, 2)} − ${PROTOCOL.legacy.baselineDeltaKmh} = ${floor.toFixed(2)})`);
      if (late.median < floor) problems.push(`(e) median v̄ nửa sau ${late.median.toFixed(2)} < baseline median ${baseline.lateSpeedMedianKmh.toFixed(2)} − ${PROTOCOL.legacy.baselineDeltaKmh} km/h`);
    } else {
      parts.push(`(e) v̄ nửa sau median ${f1(late?.median ?? null, 2)} min ${f1(late?.min ?? null, 2)} (chưa so baseline)`);
      if (!baseline) warnings.push('(e) không có baseline-legacy.json: chưa so v̄ nửa sau (ghi baseline: npm run harness:legacy:baseline trên bản sim gốc)');
      else warnings.push(`(e) baseline ghi ở ${baseline.minutes} phút ≠ run ${runs[0]?.minutes} phút: không so sánh được; ghi lại baseline cùng độ dài trên bản sim gốc (npm run harness:legacy:baseline)`);
    }
  } else if (n > 0) {
    const lockStat = stat(runs.map((r) => r.locks30));
    const stopStat = stat(runs.map((r) => r.maxStopTEnd));
    const perMille = profile === 'stress' && sp.locksPer1000Max !== null;
    const max = profile === 'ref' ? sp.locksRef : sp.locksStress;
    const permStat = stat(runs.map((r) => r.locksPer1000));
    if (lockStat) {
      const limitTxt = perMille && permStat ? `max ≤ ${sp.locksPer1000Max}/1000 xe, nay ${permStat.max.toFixed(1)}` : `${profile === 'ref' ? `median ≤ ${sp.locksMedianMax}, ` : ''}max ≤ ${max}`;
      parts.push(`(a) locks30 median ${lockStat.median} min ${lockStat.min} max ${lockStat.max} (${limitTxt})`);
      if (profile === 'ref' && lockStat.median > sp.locksMedianMax) problems.push(`(a) locks30 median ${lockStat.median} > ${sp.locksMedianMax}`);
      if (perMille && permStat) {
        if (permStat.max > (sp.locksPer1000Max ?? 0)) problems.push(`(a) locks30/1000 xe max ${permStat.max.toFixed(1)} > ${sp.locksPer1000Max}`);
      } else if (lockStat.max > max) problems.push(`(a) locks30 max ${lockStat.max} > ${max}`);
    }
    if (sp.maxStopTS !== null && stopStat) {
      parts.push(`maxStopT cuối max ${stopStat.max.toFixed(0)} s (≤ ${sp.maxStopTS})`);
      if (stopStat.max > sp.maxStopTS) problems.push(`(a) maxStopT cuối run max ${stopStat.max.toFixed(0)} s > ${sp.maxStopTS} s`);
    }
  }
  const countFail = (id: CriterionId): number => crits.filter((c) => c[id] === false).length;
  const countNull = (id: CriterionId): number => crits.filter((c) => c[id] === null).length;
  const label: Record<CriterionId, string> = { a: 'locks', b: 'ổn định', c: 'đói có chỗ ra', d: 'ring 45 s', e: 'v̄ floor', f: 'xe già > 20 phút' };
  const ids: CriterionId[] = profile === 'legacy' ? ['d'] : sp.oldShareMax === null ? ['b', 'c', 'd', 'e'] : ['b', 'c', 'd', 'e', 'f'];
  for (const id of ids) {
    const fail = countFail(id);
    parts.push(`(${id}) ${label[id]} ${n - fail - countNull(id)}/${n}${countNull(id) ? ` (${countNull(id)} n/a)` : ''}${req.includes(id) ? '' : ' [báo cáo]'}`);
    if (req.includes(id) && fail) problems.push(`(${id}) ${label[id]}: ${fail}/${n} seed vi phạm`);
  }
  if (profile !== 'legacy' && n > 0) {
    const old = stat(runs.map((r) => r.oldShare));
    if (old) parts.push(`oldShare median ${pct(old.median)} max ${pct(old.max)}`);
  }
  if (profile !== 'legacy') {
    const drift = stat(runs.flatMap((r) => (r.mixDriftPts === null ? [] : [r.mixDriftPts])));
    if (drift) {
      parts.push(`(a″) drift ô tô+taxi median ${drift.median.toFixed(1)} max ${drift.max.toFixed(1)} điểm (WARN > ${MIX_DRIFT_WARN_PTS})`);
      if (drift.max > MIX_DRIFT_WARN_PTS) warnings.push(`(a″) drift ô tô+taxi max ${drift.max.toFixed(1)} điểm > ${MIX_DRIFT_WARN_PTS}`);
    }
  }
  const status: CheckStatus = problems.length ? 'fail' : warnings.length ? 'warn' : 'pass';
  return {
    ok: problems.length === 0,
    result: { id: 'H2', title: 'Gridlock', status, summary: `[${profile}${profile === 'legacy' ? '' : `, ${protocol}`}, ${n} seed] ${parts.join(' · ')}`, details: [...problems, ...warnings] },
  };
}

/** H4. */
export function evalWrongWay(m: SimMonitor): CheckResult {
  const rep = m.report();
  const w = rep.wrong;
  const problems: string[] = [];
  const total = w.onewayLeft + w.twoWayLeftNonSwarm + w.swarmWrongTOver + w.headingBad + w.onewayHeadingBad;
  const v = w.vehicles;
  if (w.onewayLeft) problems.push(`${w.onewayLeft} mẫu / ${v.onewayLeft} xe lệch trái ngoài làn trên link một chiều (l < −halfW−0,1)`);
  if (w.twoWayLeftNonSwarm) problems.push(`${w.twoWayLeftNonSwarm} mẫu / ${v.twoWayLeftNonSwarm} xe ô tô/xe tải vượt vạch giữa trên link hai chiều`);
  if (w.swarmWrongTOver) problems.push(`${w.swarmWrongTOver} mẫu / ${v.swarmWrongTOver} xe máy đi ngược chiều quá 3+5·aggr s (vượt tối đa ${w.swarmMaxOverS.toFixed(1)} s)`);
  if (w.headingBad) problems.push(`${w.headingBad} mẫu / ${v.headingBad} xe có hướng·tiếp tuyến ≤ −0,2`);
  if (w.onewayHeadingBad) problems.push(`${w.onewayHeadingBad} mẫu / ${v.onewayHeadingBad} xe có hướng·tiếp tuyến ≤ 0 trên link một chiều`);
  if (total) {
    for (const s of w.bySegment.slice(0, 5)) problems.push(`    · ${s.count} mẫu ở ${s.seg}`);
    for (const e of w.examples.slice(0, 3)) problems.push(`    · t=${e.t.toFixed(0)}s uid ${e.uid}: ${e.where}: ${e.detail}`);
  }
  return {
    id: 'H4',
    title: 'Ngược chiều / hướng xe',
    status: total ? 'fail' : 'pass',
    summary: total ? `${total} vi phạm / ${w.samples} lượt lấy mẫu` : `0 vi phạm / ${w.samples} lượt lấy mẫu`,
    details: problems,
  };
}

/** H6: no ring vehicle stopped longer than `ringStopSeconds` (45 s) and every ring has entries and exits. */
export function evalRings(m: SimMonitor): CheckResult {
  const rep = m.report();
  const problems: string[] = [];
  if (rep.rings.length === 0) return { id: 'H6', title: 'Vòng xoay', status: 'skip', summary: 'không có ring', details: [] };
  for (const r of rep.rings) {
    if (r.entries === 0) problems.push(`ring ${r.ring} "${r.name}": không có xe nào vào`);
    if (r.exits === 0) problems.push(`ring ${r.ring} "${r.name}": không có xe nào ra`);
    if (r.stoppedOverLimit > 0) problems.push(`ring ${r.ring} "${r.name}": xe đứng > ${m.opts.ringStopSeconds} s (max ${r.maxStopT} s)`);
  }
  return result('H6', 'Vòng xoay', problems, rep.rings.map((r) => `${r.name || `ring ${r.ring}`}: ${r.entries} vào / ${r.exits} ra, stopT max ${r.maxStopT}s`).join('; '));
}

/**
 * H9 'Hiệu chuẩn trục': per-street late-window speed/density against the hour's band, plus the saturation-flow
 * WARN (median MCU/s/m outside [0.5, 1.4]). Only a complete `ss30` run is graded; `quick` prints the table and
 * can only warn (status `skip` when there is nothing to warn about).
 */
export function evalCalibration(m: RunMetrics, hour: number): CheckResult {
  const id = 'H9';
  const title = 'Hiệu chuẩn trục';
  if (m.streets.length === 0) return { id, title, status: 'skip', summary: 'mạng không có trục hiệu chuẩn nào', details: [] };
  const graded = m.protocol === 'ss30' && m.windowed;
  const band = calibBandForHour(hour);
  const problems: string[] = [];
  const warnings: string[] = [];
  const peak = hour >= CALIB_PEAK_FROM_HOUR && hour < CALIB_PEAK_TO_HOUR;
  const bikeMedian = stat(m.streets.flatMap((s) => (s.bikePer100mLane === null ? [] : [s.bikePer100mLane])))?.median ?? null;
  const inBand = m.streets.filter((s) => calibStreetIssues(s, hour).length === 0).length;
  if (graded) {
    for (const s of m.streets) for (const issue of calibStreetIssues(s, hour)) problems.push(`${s.name}: ${issue}`);
    if (peak && (bikeMedian === null || bikeMedian < CALIB_PEAK_MIN_BIKE_DENS)) {
      problems.push(`median xe máy/100 m/làn ${bikeMedian === null ? '–' : bikeMedian.toFixed(1)} < ${CALIB_PEAK_MIN_BIKE_DENS} giờ cao điểm`);
    }
  }
  const sat = m.satMedianMcuPerSM;
  const satClear = m.satMedianMcuPerSMClear;
  if (satClear !== null && (satClear < SAT_MCU_BAND[0] || satClear > SAT_MCU_BAND[1])) {
    warnings.push(`lưu lượng bão hoà median (lối ra thông) ${satClear.toFixed(2)} MCU/s/m ngoài [${SAT_MCU_BAND[0]}, ${SAT_MCU_BAND[1]}]`);
  }
  const f = (v: number | null, d = 1): string => (v === null ? '–' : v.toFixed(d));
  const summary =
    `[${graded ? m.protocol : 'chỉ báo cáo'}] ${band ? `band ${band.label} ${band.minKmh}–${band.maxKmh} km/h` : 'giờ này không có band'} · ${inBand}/${m.streets.length} trục đạt` +
    ` · v̄ trục ${f(m.artSpeedKmh)} km/h (thấp nhất ${f(m.minStreetKmh)}) · ${f(m.artDensity)} xe, ${f(m.artBikeDensity)} xe máy/100 m/làn` +
    ` · bão hoà median ${f(sat, 2)} MCU/s/m (${f(m.satMedianVehPerSM, 2)} xe/s/m), lối ra thông ${f(satClear, 2)}`;
  const status: CheckStatus = problems.length ? 'fail' : warnings.length ? 'warn' : graded ? 'pass' : 'skip';
  return { id, title, status, summary, details: [...problems, ...warnings] };
}

/** H4b 'Chồng thân xe máy': WARN only (thresholds not yet ratified by the user). `graded` false (legacy map: the thresholds come from OSM probes) = report only. */
export function evalOverlap(m: RunMetrics, graded = true): CheckResult {
  const warnings: string[] = [];
  if (!graded) {
    return { id: 'H4b', title: 'Chồng thân xe máy', status: 'skip', summary: `${m.overlapPer1000.toFixed(1)} cặp chồng thân (trong hộp ${m.overlapBoxPer1000.toFixed(1)}), ${m.deepOverlapPer1000.toFixed(1)} chồng sâu /1000 xe máy (chỉ báo cáo ở map legacy)`, details: [] };
  }
  if (m.overlapPer1000 > OVERLAP_WARN_PER_1000) warnings.push(`${m.overlapPer1000.toFixed(1)} cặp chồng thân/1000 xe máy > ${OVERLAP_WARN_PER_1000}`);
  if (m.deepOverlapPer1000 > DEEP_OVERLAP_WARN_PER_1000) warnings.push(`${m.deepOverlapPer1000.toFixed(1)} cặp chồng sâu/1000 xe máy > ${DEEP_OVERLAP_WARN_PER_1000}`);
  return {
    id: 'H4b',
    title: 'Chồng thân xe máy',
    status: warnings.length ? 'warn' : 'pass',
    summary: `${m.overlapPer1000.toFixed(1)} cặp chồng thân (trong hộp ${m.overlapBoxPer1000.toFixed(1)}), ${m.deepOverlapPer1000.toFixed(1)} chồng sâu /1000 xe máy (WARN > ${OVERLAP_WARN_PER_1000} / ${DEEP_OVERLAP_WARN_PER_1000}; chỉ cảnh báo tới khi user ratify)`,
    details: warnings,
  };
}

/** Car + taxi and two-wheeler shares of a `TrafficKpi.mix` (vehicles per `VType`), as fractions of all vehicles. */
export function mixShares(mix: readonly number[]): { car: number; bike: number } {
  let total = 0;
  for (const c of mix) total += c;
  if (total <= 0) return { car: 0, bike: 0 };
  let car = 0;
  let bike = 0;
  for (const ty of CAR_TYPES) car += mix[ty] ?? 0;
  for (const ty of BIKE_TYPES) bike += mix[ty] ?? 0;
  return { car: car / total, bike: bike / total };
}

// ------------------------------------------------------------------ H10 (recovery after a demand/hour switch)

/** H10 at `scoreS` seconds after the switch: network mean speed ≥ `minKmh`, share of vehicles with `stopT` > `stoppedS` ≤ `maxStoppedShare`, links with ≥ `pocketVehicles` vehicles of `stopT` > `pocketStopS` ≤ `maxPocketLinks`. */
export const RECOVERY = { scoreS: 180, minKmh: 18, maxStoppedShare: 0.25, maxPocketLinks: 0, stoppedS: 5, pocketStopS: 60, pocketVehicles: 20, tableEveryS: 30 } as const;

export interface RecoverySample {
  /** Seconds since the switch. */
  sinceS: number;
  /** Mean speed (km/h) of all vehicles. */
  kmh: number;
  /** Share of vehicles stopped (`stopT` > 5 s). */
  stoppedShare: number;
  count: number;
  /** Links with ≥ 20 vehicles of `stopT` > 60 s. */
  pocketLinks: number;
}

export interface RecoveryPocket {
  link: number;
  street: string;
  to: string;
  vehicles: number;
}

/** Links whose per-link count of vehicles stopped > 60 s reaches `RECOVERY.pocketVehicles`, largest first. */
function listPockets(counts: Int32Array, segs: readonly Segment[]): RecoveryPocket[] {
  const list: RecoveryPocket[] = [];
  for (let k = 0; k < counts.length; k++) {
    if (counts[k] >= RECOVERY.pocketVehicles) list.push({ link: k, street: segs[k].name || '(không tên)', to: junctionLabel(segs[k].to), vehicles: counts[k] });
  }
  return list.sort((a, b) => b.vehicles - a.vehicles || a.link - b.link);
}

export interface RecoveryStat {
  switchHour: number;
  switchTarget: number;
  /** Seconds sampled after the switch. */
  seconds: number;
  /** The sample every 30 s. */
  table: RecoverySample[];
  /** The sample at `RECOVERY.scoreS`; null when the run ended earlier. */
  score: RecoverySample | null;
  /** Pocket links at the score sample (largest first, ≤ 5). */
  pockets: RecoveryPocket[];
}

/** Samples the whole network once per simulated second from the switch on (`sample()`), for H10. */
export class RecoveryProbe {
  private readonly tr: Traffic;
  private readonly net: Network;
  private readonly stopped60: Int32Array;
  private readonly samples: RecoverySample[] = [];
  private pockets: RecoveryPocket[] = [];
  readonly switchHour: number;
  readonly switchTarget: number;

  constructor(tr: Traffic, switchHour: number, switchTarget: number) {
    this.tr = tr;
    this.net = tr.net;
    this.stopped60 = new Int32Array(tr.net.segments.length);
    this.switchHour = switchHour;
    this.switchTarget = switchTarget;
  }

  /** Call once after every simulated second that follows the switch. */
  sample(): void {
    const tr = this.tr;
    const segs = this.net.segments;
    const cnt = this.stopped60;
    cnt.fill(0);
    let n = 0;
    let speedSum = 0;
    let stopped = 0;
    for (let i = 0; i < tr.hi; i++) {
      if (!tr.active[i]) continue;
      n++;
      speedSum += tr.v[i];
      if (tr.crashed[i]) continue;
      if (tr.stopT[i] > RECOVERY.stoppedS) stopped++;
      if (tr.stopT[i] > RECOVERY.pocketStopS && segs[tr.seg[i]].kind === SegKind.Link) cnt[tr.seg[i]]++;
    }
    let pocketLinks = 0;
    for (let k = 0; k < cnt.length; k++) if (cnt[k] >= RECOVERY.pocketVehicles) pocketLinks++;
    const sinceS = this.samples.length + 1;
    this.samples.push({ sinceS, kmh: n > 0 ? (speedSum / n) * 3.6 : 0, stoppedShare: n > 0 ? stopped / n : 0, count: n, pocketLinks });
    if (sinceS === RECOVERY.scoreS) {
      this.pockets = listPockets(cnt, segs).slice(0, 5);
    }
  }

  stat(): RecoveryStat {
    return {
      switchHour: this.switchHour,
      switchTarget: this.switchTarget,
      seconds: this.samples.length,
      table: this.samples.filter((s) => s.sinceS % RECOVERY.tableEveryS === 0),
      score: this.samples.find((s) => s.sinceS === RECOVERY.scoreS) ?? null,
      pockets: this.pockets.slice(),
    };
  }
}

/** H10 'Hồi phục': the network must have cleared 3 minutes after the switch (v̄ ≥ 18 km/h, stopped ≤ 25 %, 0 pocket links). Hard check. */
export function evalRecovery(r: RecoveryStat | null): CheckResult {
  const id = 'H10';
  const title = 'Hồi phục';
  if (r === null) return { id, title, status: 'skip', summary: 'chỉ chạy khi có --switch-hour/--switch-at/--switch-target', details: [] };
  const row = (s: RecoverySample): string => `+${String(s.sinceS).padStart(3)} s: v̄ ${s.kmh.toFixed(1)} km/h · đứng > ${RECOVERY.stoppedS} s ${(s.stoppedShare * 100).toFixed(1)} % · ${s.count} xe · link kẹt cục bộ ${s.pocketLinks}`;
  const table = r.table.map(row);
  const sc = r.score;
  if (sc === null) {
    return { id, title, status: 'fail', summary: `run chỉ có ${r.seconds} s sau khi đổi (cần ≥ ${RECOVERY.scoreS} s)`, details: table };
  }
  const problems: string[] = [];
  if (sc.kmh < RECOVERY.minKmh) problems.push(`v̄ ${sc.kmh.toFixed(1)} km/h < ${RECOVERY.minKmh}`);
  if (sc.stoppedShare > RECOVERY.maxStoppedShare) problems.push(`${(sc.stoppedShare * 100).toFixed(1)} % xe đứng > ${RECOVERY.stoppedS} s > ${RECOVERY.maxStoppedShare * 100} %`);
  if (sc.pocketLinks > RECOVERY.maxPocketLinks) problems.push(`${sc.pocketLinks} link có ≥ ${RECOVERY.pocketVehicles} xe đứng > ${RECOVERY.pocketStopS} s (cho phép ${RECOVERY.maxPocketLinks})`);
  const pockets = r.pockets.map((p) => `pocket link#${p.link} ${p.street} → ${p.to}: ${p.vehicles} xe`);
  return {
    id,
    title,
    status: problems.length ? 'fail' : 'pass',
    summary: `${r.switchHour.toFixed(2)} h / target ${r.switchTarget}, +${RECOVERY.scoreS} s: v̄ ${sc.kmh.toFixed(1)} km/h (≥ ${RECOVERY.minKmh}) · đứng ${(sc.stoppedShare * 100).toFixed(1)} % (≤ ${RECOVERY.maxStoppedShare * 100}) · ${sc.count} xe · pocket ${sc.pocketLinks} (= ${RECOVERY.maxPocketLinks})`,
    details: [...problems, ...pockets, ...table],
  };
}

export function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
