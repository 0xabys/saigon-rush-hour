/**
 * Headless acceptance harness for the traffic simulation (checks H1–H10, see src/sim/checks.ts).
 *
 *   bun scripts/harness.ts --map osm|legacy --hour 8 --minutes 10 --density 1 [--target N] [--seed S]
 *       [--seeds K] [--sweep 1200,1600,2000,2400] [--nref N] [--jobs J] [--protocol quick|ss30]
 *       [--baseline path|none] [--strict-perf] [--switch-hour H --switch-at M --switch-target N] [--json out.json]
 *
 * One run (default; seed 0x5a16 unless --seed) prints the full report. `--seeds K` runs seeds 1..K and
 * `--sweep` repeats that for every listed target; every (target, seed) run is a child process (up to
 * `--jobs`, default cores − 2) and the result is aggregated as median/min/max per metric. H2 is judged
 * per the gridlock protocol (src/sim/checks.ts `PROTOCOL`): targets ≤ `--nref` (default 1600) are held
 * to all of the protocol's criteria, larger ones are stress runs where only (a)(c)(d) are required.
 *
 * `--protocol quick` (default, 10 min) is the screening run. `--protocol ss30` is the steady-state
 * acceptance: 30 sim minutes (unless --minutes is given), window [10,20) vs [20,30), locks30 =
 * release + gỡ khoá + teleport, maxStopT at the end, oldShare (vehicles > 20 min old), (b′) mean and
 * slope rules. `--map legacy` always uses the legacy regression rules (release ≤ 1,2 % per seed, late-half
 * v̄ median ≥ baseline median − 0,5 from `--baseline`, default data/harness/baseline-legacy.json).
 *
 * Exit code 1 when any hard check fails; the H7 perf budget only fails the run with --strict-perf.
 * `--map legacy` runs H1–H4 and H7 (regression baseline for the generalised sim); H5/H6 need the OSM
 * map. H8 is a report and is printed for both.
 * H9 'Hiệu chuẩn trục' (OSM map): per-street late-window speed/density of the 13 central arterials against the
 * hour's band (graded only under `--protocol ss30`; `quick` prints the table), plus the saturation flow measured
 * at signalised approaches (WARN when the median over the approaches with a clear exit is outside [0.5, 1.4] MCU/s/m).
 * H4b 'Chồng thân xe máy' (WARN only): overlapping two-wheeler pairs per 1000 two-wheelers (> 45 / deep > 8).
 * `--switch-hour H --switch-at M --switch-target N` (all three or none; M ≥ 2 minutes, run ≥ M + 3 minutes): at step M·3600
 * sets `tr.hour = H`, `tr.target = N` and adds H10 'Hồi phục' (hard): +3 minutes later the network must have recovered
 * (v̄ ≥ 18 km/h, ≤ 25 % of vehicles stopped > 5 s, no link with ≥ 20 vehicles stopped > 60 s); the 30 s table is printed.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NetworkJson } from '../src/data/q1Schema';
import {
  calibBandForHour,
  calibStreetIssues,
  checkBuild,
  checkFlashNight,
  checkSignalPlans,
  compareSnapshots,
  DEEP_OVERLAP_WARN_PER_1000,
  evalCalibration,
  evalGridlock,
  evalGridlockSeeds,
  evalOverlap,
  evalRecovery,
  evalRings,
  evalWrongWay,
  mergeResults,
  MIX_DRIFT_WARN_PTS,
  mixShares,
  OVERLAP_WARN_PER_1000,
  parseLegacyBaseline,
  percentile,
  PROTOCOL,
  RECOVERY,
  RecoveryProbe,
  runMetrics,
  SAT_MCU_BAND,
  SimMonitor,
  stat,
  vehicleArrayNames,
  type CheckResult,
  type CheckStatus,
  type GridlockProfile,
  type LegacyBaseline,
  type MonitorReport,
  type ProtocolId,
  type RecoveryStat,
  type RunExtras,
  type RunMetrics,
  type Stat,
} from '../src/sim/checks';
import { buildLegacyNetwork } from '../src/sim/legacyMap';
import type { Network } from '../src/sim/network';
import { buildOsmNetwork } from '../src/sim/osmMap';
import { SignalSystem } from '../src/sim/signals';
import { Traffic, type TrafficKpi } from '../src/sim/traffic';
import { SPECS, VTYPE_COUNT } from '../src/sim/vehicleTypes';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), '..');
const DT = 1 / 60;
/** Default vehicle target at density 1: the OSM design target / the legacy app's MAX_VEHICLES. */
const BASE_TARGET: Record<MapName, number> = { osm: 8000, legacy: 1900 };
const PERF_BUDGET_MS = 8;
/** Traffic's built-in seed; a plain run without --seed must stay bit-identical to the pre-seed sim. */
const DEFAULT_SEED = 0x5a16;

type MapName = 'osm' | 'legacy';

interface Args {
  map: MapName;
  hour: number;
  minutes: number;
  density: number;
  target: number | null;
  seed: number | null;
  seeds: number | null;
  sweep: number[] | null;
  nref: number;
  jobs: number | null;
  /** 'quick' (10 min screening) or 'ss30' (30 min steady-state acceptance, OSM profiles). */
  protocol: ProtocolId;
  /** Legacy gate baseline (a previous `--map legacy --seeds K --json` output), relative to the repo root; null = none. */
  baseline: string | null;
  /** Internal (set for all but the first seed of a configuration): skip H3 and the night check. */
  skipStatic: boolean;
  strictPerf: boolean;
  /** `--switch-*` (all three or all null): at minute `switchAt` set the clock to `switchHour` and the target to `switchTarget` (H10). */
  switchHour: number | null;
  switchAt: number | null;
  switchTarget: number | null;
  json: string | null;
}

const USAGE =
  'usage: bun scripts/harness.ts --map osm|legacy --hour 8 --minutes 10 --density 1 [--target N] [--seed S] [--seeds K] [--sweep 1200,1600,2000,2400] [--nref N] [--jobs J] [--protocol quick|ss30] [--baseline path|none] [--strict-perf] [--switch-hour H --switch-at M --switch-target N] [--json out.json]';

function parseArgs(argv: string[]): Args | string {
  const a: Args = { map: 'osm', hour: 8, minutes: 10, density: 1, target: null, seed: null, seeds: null, sweep: null, nref: 1600, jobs: null, protocol: 'quick', baseline: DEFAULT_BASELINE, skipStatic: false, strictPerf: false, switchHour: null, switchAt: null, switchTarget: null, json: null };
  let explicitMinutes = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const num = (): number => Number(argv[++i]);
    switch (flag) {
      case '--map': {
        const v = argv[++i];
        if (v !== 'osm' && v !== 'legacy') return `--map: "${v}" (osm|legacy)`;
        a.map = v;
        break;
      }
      case '--hour':
        a.hour = num();
        if (!(a.hour >= 0 && a.hour < 24)) return '--hour phải trong [0, 24)';
        break;
      case '--minutes':
        a.minutes = num();
        explicitMinutes = true;
        if (!(a.minutes >= 1)) return '--minutes phải ≥ 1';
        break;
      case '--density':
        a.density = num();
        if (!(a.density > 0)) return '--density phải > 0';
        break;
      case '--target':
        a.target = num();
        if (!(a.target >= 1)) return '--target phải ≥ 1';
        break;
      case '--seed':
        a.seed = num();
        if (!Number.isInteger(a.seed) || a.seed < 0) return '--seed phải là số nguyên ≥ 0';
        break;
      case '--seeds':
        a.seeds = num();
        if (!Number.isInteger(a.seeds) || a.seeds < 1) return '--seeds phải là số nguyên ≥ 1';
        break;
      case '--sweep': {
        const list = (argv[++i] ?? '').split(',').map(Number);
        if (list.length === 0 || list.some((n) => !(n >= 1))) return '--sweep cần danh sách target, ví dụ 1200,1600,2000';
        a.sweep = list;
        break;
      }
      case '--nref':
        a.nref = num();
        if (!(a.nref >= 1)) return '--nref phải ≥ 1';
        break;
      case '--jobs':
        a.jobs = num();
        if (!Number.isInteger(a.jobs) || a.jobs < 1) return '--jobs phải là số nguyên ≥ 1';
        break;
      case '--skip-static':
        a.skipStatic = true;
        break;
      case '--strict-perf':
        a.strictPerf = true;
        break;
      case '--switch-hour':
        a.switchHour = num();
        if (!(a.switchHour >= 0 && a.switchHour < 24)) return '--switch-hour phải trong [0, 24)';
        break;
      case '--switch-at':
        a.switchAt = num();
        if (!(a.switchAt >= 2)) return '--switch-at phải ≥ 2 (phút)';
        break;
      case '--switch-target':
        a.switchTarget = num();
        if (!(a.switchTarget >= 1)) return '--switch-target phải ≥ 1';
        break;
      case '--json':
        a.json = argv[++i] ?? null;
        if (!a.json) return '--json cần đường dẫn';
        break;
      case '--protocol': {
        const v = argv[++i];
        if (v !== 'quick' && v !== 'ss30') return `--protocol: "${v}" (quick|ss30)`;
        a.protocol = v;
        break;
      }
      case '--baseline': {
        const v = argv[++i];
        if (!v) return '--baseline cần đường dẫn hoặc "none"';
        a.baseline = v === 'none' ? null : v;
        break;
      }
      default:
        return `tham số lạ: ${flag}`;
    }
  }
  if (a.seed !== null && a.seeds !== null) return '--seed và --seeds loại trừ nhau';
  if (a.protocol === 'ss30' && !explicitMinutes && a.map === 'osm') a.minutes = PROTOCOL.ss30.minutes;
  const switchGiven = [a.switchHour, a.switchAt, a.switchTarget].filter((v) => v !== null).length;
  if (switchGiven !== 0 && switchGiven !== 3) return '--switch-hour, --switch-at và --switch-target phải đi cùng nhau';
  if (a.switchAt !== null && a.minutes < a.switchAt + RECOVERY.scoreS / 60) return `--minutes ${a.minutes} < --switch-at + ${RECOVERY.scoreS / 60} phút: H10 chấm ở +${RECOVERY.scoreS} s sau khi đổi`;
  return a;
}

// ------------------------------------------------------------------ world

interface World {
  net: Network;
  json: NetworkJson | null;
  /** sha256 of src/data/q1-network.json (OSM map only). */
  hash: string | null;
}

function loadOsmJson(): { json: NetworkJson; hash: string } {
  const raw = readFileSync(resolve(ROOT, 'src/data/q1-network.json'), 'utf8');
  return { json: JSON.parse(raw) as NetworkJson, hash: createHash('sha256').update(raw).digest('hex') };
}

function buildWorld(map: MapName, loaded: { json: NetworkJson; hash: string } | null): World {
  if (map === 'legacy') return { net: buildLegacyNetwork(), json: null, hash: null };
  const l = loaded ?? loadOsmJson();
  return { net: buildOsmNetwork(l.json), json: l.json, hash: l.hash };
}

const DEFAULT_BASELINE = 'data/harness/baseline-legacy.json';

function loadBaseline(args: Args): LegacyBaseline | null {
  if (args.baseline === null) return null;
  const path = resolve(ROOT, args.baseline);
  try {
    const b = parseLegacyBaseline(JSON.parse(readFileSync(path, 'utf8')));
    if (!b) console.warn(`baseline ${args.baseline}: không đọc được configs[0].stats.speedLate.median / args.minutes`);
    return b;
  } catch (e) {
    console.warn(`baseline ${args.baseline}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** A numeric field the sim may or may not expose yet (`teleports` on `TrafficKpi`); 0 when absent. */
function optNum(o: object, key: string): number {
  const v = (o as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : 0;
}

function newTraffic(net: Network, hour: number, target: number, populate: boolean, seed: number): Traffic {
  const tr = new Traffic(net, new SignalSystem(net.signalJunctions), seed);
  tr.hour = hour;
  tr.target = target;
  if (populate) tr.populate(target);
  return tr;
}

function profileFor(map: MapName, target: number, nref: number): GridlockProfile {
  if (map === 'legacy') return 'legacy';
  return target <= nref ? 'ref' : 'stress';
}

// ------------------------------------------------------------------ H3

const DET_STEPS = 180 * 60;
const DET_SNAPSHOT_AT = 61 * 60;
const DET_RAIN_AT = 4000;

/** Run A (0→3660 steps = S1, →180 s, rain on at step 4000), restore S1 + replay the logged input, fresh run C. */
function checkDeterminism(args: Args, target: number, world: World, seed: number): CheckResult {
  const inputs = [{ step: DET_RAIN_AT, rain: 1 }];
  const advance = (tr: Traffic, from: number, to: number, t0: number): number => {
    let t = t0;
    for (let i = from; i < to; i++) {
      for (const inp of inputs) if (inp.step === i) tr.setRain(inp.rain);
      t += DT;
      tr.step(DT, t);
    }
    return t;
  };
  const names = vehicleArrayNames(newTraffic(world.net, args.hour, target, false, seed));

  const a = newTraffic(world.net, args.hour, target, true, seed);
  const tMid = advance(a, 0, DET_SNAPSHOT_AT, 0);
  const s1 = a.snapshot();
  advance(a, DET_SNAPSHOT_AT, DET_STEPS, tMid);
  const stateA = a.snapshot();

  a.restore(s1);
  advance(a, DET_SNAPSHOT_AT, DET_STEPS, s1.time);
  const stateB = a.snapshot();
  const replay = compareSnapshots(stateA, stateB, names);

  const c = newTraffic(buildWorld(args.map, world.json && world.hash ? { json: world.json, hash: world.hash } : null).net, args.hour, target, true, seed);
  advance(c, 0, DET_STEPS, 0);
  const fresh = compareSnapshots(stateA, c.snapshot(), names);

  const details = [...replay.slice(0, 5).map((d) => `replay (restore S1): ${d}`), ...fresh.slice(0, 5).map((d) => `instance mới: ${d}`)];
  return {
    id: 'H3',
    title: 'Tất định',
    status: details.length ? 'fail' : 'pass',
    summary: details.length
      ? `replay ${replay.length ? `lệch ${replay.length} trường` : 'khớp'}, instance mới ${fresh.length ? `lệch ${fresh.length} trường` : 'khớp'}`
      : `0→${DET_STEPS / 60} s, snapshot ở ${DET_SNAPSHOT_AT / 60} s (step ${DET_SNAPSHOT_AT}), mưa bật ở step ${DET_RAIN_AT}, restore+replay ≡ run A ≡ instance mới (${stateA.count} xe, uid kế ${stateA.nextUid}, release ${stateA.releases ?? 0}, gỡ khoá ${stateA.locksBroken ?? 0})`,
    details,
  };
}

// ------------------------------------------------------------------ H5 (night)

function checkNight(world: World): CheckResult {
  const tr = newTraffic(world.net, 23.5, 200, true, DEFAULT_SEED);
  let t = 0;
  for (let i = 0; i < 120; i++) {
    t += DT;
    tr.step(DT, t);
  }
  return checkFlashNight(tr);
}

// ------------------------------------------------------------------ main run

interface MainRun {
  monitor: SimMonitor;
  ms: Float64Array;
  minuteLog: string[];
  kpiEnd: TrafficKpi;
  populated: number;
  /** Car+taxi / two-wheeler shares after populate and at the end; undefined for a run with `--switch-*` (the hour changes, so a drift is meaningless). */
  mix: RunExtras['mix'];
  /** H10 samples; null without `--switch-*`. */
  recovery: RecoveryStat | null;
}

function mainRun(args: Args, target: number, world: World, seed: number): MainRun {
  const tr = newTraffic(world.net, args.hour, target, true, seed);
  const populated = tr.count;
  const monitor = new SimMonitor(tr, { dt: DT });
  const steps = Math.round(args.minutes * 3600);
  const ms = new Float64Array(steps);
  const kpi: TrafficKpi = { count: 0, avgKmh: 0, movingKmh: 0, congestion: 0, waiting: 0, mix: [], releases: 0, locksBroken: 0, teleports: 0 };
  tr.kpi(kpi);
  const mixStart = mixShares(kpi.mix);
  const sw = args.switchHour !== null && args.switchAt !== null && args.switchTarget !== null ? { step: Math.round(args.switchAt * 3600), hour: args.switchHour, target: args.switchTarget } : null;
  const probe = sw !== null ? new RecoveryProbe(tr, sw.hour, sw.target) : null;
  const minuteLog: string[] = [];
  let t = 0;
  for (let i = 0; i < steps; i++) {
    if (sw !== null && i === sw.step) {
      tr.hour = sw.hour;
      tr.target = sw.target;
    }
    t += DT;
    const t0 = performance.now();
    tr.step(DT, t);
    ms[i] = performance.now() - t0;
    monitor.observe(t);
    if (probe !== null && sw !== null && i >= sw.step && (i - sw.step + 1) % 60 === 0) probe.sample();
    if ((i + 1) % 3600 === 0) {
      tr.kpi(kpi);
      minuteLog.push(`phút ${(i + 1) / 3600}: ${kpi.count} xe, v̄ ${kpi.avgKmh.toFixed(1)} km/h, chờ ${kpi.waiting}, release ${kpi.releases} (monitor ${monitor.releases}), gỡ khoá ${kpi.locksBroken}, teleport ${optNum(kpi, 'teleports')}, spawn ${monitor.spawns}`);
    }
  }
  tr.kpi(kpi);
  return {
    monitor,
    ms,
    minuteLog,
    kpiEnd: { ...kpi, mix: kpi.mix.slice() },
    populated,
    mix: sw === null ? { start: mixStart, end: mixShares(kpi.mix) } : undefined,
    recovery: probe !== null ? probe.stat() : null,
  };
}

interface PerfStats {
  res: CheckResult;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

function checkPerf(ms: Float64Array, strict: boolean): PerfStats {
  const sorted = Float64Array.from(ms).sort();
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const max = sorted[sorted.length - 1] ?? 0;
  const mean = ms.reduce((s, v) => s + v, 0) / Math.max(1, ms.length);
  const over = p95 > PERF_BUDGET_MS;
  const status: CheckStatus = over ? (strict ? 'fail' : 'warn') : 'pass';
  return {
    res: {
      id: 'H7',
      title: 'Hiệu năng',
      status,
      summary: `p50 ${p50.toFixed(2)} · p95 ${p95.toFixed(2)} · max ${max.toFixed(2)} ms/step (TB ${mean.toFixed(2)}; ngân sách p95 ≤ ${PERF_BUDGET_MS})`,
      details: over ? [`p95 ${p95.toFixed(2)} ms > ${PERF_BUDGET_MS} ms${strict ? '' : ' (soft; dùng --strict-perf để chặn)'}`] : [],
    },
    p50,
    p95,
    max,
    mean,
  };
}

// ------------------------------------------------------------------ output

const STATUS_LABEL: Record<CheckStatus, string> = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP' };

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmt1 = (v: number | null): string => (v === null ? '–' : v.toFixed(1));

function printTable(rows: CheckResult[]): void {
  console.log('');
  console.log('ID   KẾT QUẢ  KIỂM TRA              CHI TIẾT');
  console.log('---  -------  --------------------  ----------------------------------------------------------');
  for (const r of rows) console.log(`${pad(r.id, 3)}  ${pad(STATUS_LABEL[r.status], 7)}  ${pad(cut(r.title, 20), 20)}  ${r.summary}`);
  const extra = rows.filter((r) => r.details.length > 0);
  for (const r of extra) {
    console.log('');
    console.log(`[${r.id}] ${r.title} — ${STATUS_LABEL[r.status]}`);
    for (const d of r.details) console.log(`  ${d}`);
  }
}

/** H9 table: per calibration street, late window. */
function printCalibration(m: RunMetrics, hour: number): void {
  if (m.streets.length === 0) return;
  const band = calibBandForHour(hour);
  const graded = m.protocol === 'ss30' && m.windowed;
  const to = m.windowed ? PROTOCOL[m.protocol].lateTo : m.minutes;
  console.log('');
  console.log(`[H9] Hiệu chuẩn trục — phút ${m.lateFromMinute}–${to}, mẫu 1 Hz, ${band ? `band ${band.label}: ${band.minKmh}–${band.maxKmh} km/h` : 'không có band cho giờ này'}${graded ? '' : ' (chỉ báo cáo, không chấm)'}`);
  console.log(`  ${pad('trục', 22)}${padL('v̄ tất cả', 9)}${padL('v̄ ô tô', 8)}${padL('v̄ máy', 8)}${padL('xe/100m/làn', 12)}${padL('máy/100m/làn', 13)}${padL('phút thấp nhất', 16)}${padL('<6 kéo dài', 11)}  band`);
  for (const s of m.streets) {
    const issues = calibStreetIssues(s, hour);
    const worst = s.worstMinuteKmh === null || s.worstMinute === null ? '–' : `${s.worstMinuteKmh.toFixed(1)} (p${s.worstMinute + 1})`;
    console.log(
      `  ${pad(cut(s.name, 21), 22)}${padL(fmt1(s.speedKmh), 9)}${padL(fmt1(s.carKmh), 8)}${padL(fmt1(s.bikeKmh), 8)}${padL(fmt1(s.vehPer100mLane), 12)}${padL(fmt1(s.bikePer100mLane), 13)}${padL(worst, 16)}${padL(s.sustainedBelow6 ? 'CÓ' : 'không', 11)}  ${issues.length === 0 ? '✓' : `✗ ${issues[0]}`}`,
    );
  }
  console.log(`  trục TB: v̄ ${fmt1(m.artSpeedKmh)} km/h (chậm nhất ${fmt1(m.minStreetKmh)}), ${fmt1(m.artDensity)} xe/100 m/làn, ${fmt1(m.artBikeDensity)} xe máy/100 m/làn`);
}

/** Saturation flow at signalised approaches: the 8 best-sampled approaches and the median (all / approaches with a clear exit; only the latter WARNs). */
function printSaturation(m: RunMetrics): void {
  const enough = m.saturation.filter((s) => s.cycles >= 2);
  const clear = m.saturation.filter((s) => s.clearCycles >= 2);
  const f2 = (v: number | null): string => (v === null ? '–' : v.toFixed(2));
  const outBand = (v: number | null): boolean => v !== null && (v < SAT_MCU_BAND[0] || v > SAT_MCU_BAND[1]);
  console.log('');
  console.log(`[Sat] Lưu lượng bão hoà tại vạch đèn (xanh có hàng chờ ≥ 6 xe lúc đầu xanh, đếm từ giây thứ 4): ${m.saturation.length} approach có ≥ 1 xanh hợp lệ, ${enough.length} có ≥ 2, ${clear.length} có ≥ 2 xanh với lối ra thông (≥ làn, đuôi ≥ 20 m)`);
  console.log(`  median tất cả ${f2(m.satMedianVehPerSM)} xe/s/m · ${f2(m.satMedianMcuPerSM)} MCU/s/m (chỉ báo)`);
  console.log(`  median lối ra thông ${f2(m.satMedianMcuPerSMClear)} MCU/s/m (mục tiêu ≈ 0,8–1,0; WARN ngoài [${SAT_MCU_BAND[0]}, ${SAT_MCU_BAND[1]}])${outBand(m.satMedianMcuPerSMClear) ? ' — WARN' : ''}`);
  if (m.saturation.length === 0) return;
  console.log(`  ${pad('link', 7)}${pad('đường → nút', 52)}${padL('làn', 4)}${padL('rộng m', 8)}${padL('xanh', 6)}${padL('xe/s/m', 8)}${padL('MCU/s/m', 9)}`);
  for (const s of m.saturation.slice(0, 8)) {
    console.log(`  #${pad(String(s.link), 6)}${pad(`${cut(s.street, 22)} → ${cut(s.to, 26)}`, 52)}${padL(String(s.lanes), 4)}${padL(s.widthM.toFixed(1), 8)}${padL(String(s.cycles), 6)}${padL(s.vehPerSM.toFixed(2), 8)}${padL(s.mcuPerSM.toFixed(2), 9)}`);
  }
}

function printReport(rep: MonitorReport, m: RunMetrics, hour: number, calibration: boolean): void {
  const labels = SPECS.map((s) => cut(s.label, 11));
  console.log('');
  console.log(`[H8] Báo cáo ${rep.seconds.toFixed(0)} s mô phỏng: spawn ${rep.spawns}, despawn ${rep.despawns}, release diff-monitor (unjam) ${rep.releases}`);
  console.log(`  ${pad('', 8)}${labels.map((l) => padL(l, 12)).join('')}`);
  for (const [name, arr] of [['spawn', rep.spawnByType], ['despawn', rep.despawnByType], ['release', rep.releaseByType]] as const) {
    console.log(`  ${pad(name, 8)}${arr.map((v) => padL(String(v), 12)).join('')}`);
  }
  const top = (label: string, list: MonitorReport['spawnByPortal']): void => {
    console.log(`  ${label} theo portal (${list.length} portal, top 8): ${list.slice(0, 8).map((p) => `${cut(p.portal, 28)}=${p.count}`).join(' | ')}`);
  };
  top('spawn', rep.spawnByPortal);
  top('despawn', rep.despawnByPortal);
  console.log(`  despawn/phút: ${rep.despawnPerMinute.join(' ')}`);
  if (rep.releaseByJunction.length) console.log(`  release theo nút: ${rep.releaseByJunction.slice(0, 6).map((r) => `${cut(r.junction, 34)}=${r.count}`).join(' | ')}`);

  console.log('  Tốc độ TB (km/h, mẫu 1 Hz) theo loại × phút:');
  const minutes = rep.speedAllPerMinute.length;
  console.log(`  ${pad('', 14)}${Array.from({ length: minutes }, (_, m) => padL(`p${m + 1}`, 6)).join('')}`);
  for (let k = 0; k < VTYPE_COUNT; k++) console.log(`  ${pad(cut(SPECS[k].label, 13), 14)}${rep.speedByTypePerMinute.map((row) => padL(fmt1(row[k]), 6)).join('')}`);
  console.log(`  ${pad('tất cả', 14)}${rep.speedAllPerMinute.map((v) => padL(fmt1(v), 6)).join('')}`);

  console.log('  10 vạch dừng xấu nhất (max stopT s | hàng chờ max | xe rời | đói max s):');
  for (const s of rep.worstStopLines) {
    console.log(`    link#${pad(String(s.link), 4)} ${padL(s.maxStopT.toFixed(0), 4)}s q${pad(String(s.maxQueue), 3)} out${pad(String(s.departures), 5)} starve${pad(String(s.maxStarveS), 4)} ${s.signalised ? 'đèn ' : s.yields ? 'nhường' : 'thường'} ${cut(s.street, 26)} → ${cut(s.to, 46)}`);
  }
  const nv = rep.linksNeverVisited;
  console.log(`  Link không xe nào ghé: ${nv.length}${nv.length ? ` — ${nv.slice(0, 10).map((l) => `#${l.link} ${cut(l.street || l.from, 22)}`).join(', ')}${nv.length > 10 ? ', …' : ''}` : ''}`);

  console.log(`  locks30 = release ${m.releases} + gỡ khoá ${m.locksBroken} + teleport ${m.teleports} = ${m.locks30} (diff-monitor: release ${m.monitorReleases}, rời link ≥ 3 m trước cuối ${m.monitorEarlyLinkRemovals})`);
  console.log(`  arrivals (đến đích nội bộ): ${m.arrivals} (diff-monitor ${m.monitorArrivals})${m.arrivals === m.monitorArrivals ? '' : ' — LỆCH'} · locks30/1000 xe ${m.locksPer1000.toFixed(1)}`);
  console.log(`  [H4b] xe máy chồng thân: ${m.overlapPer1000.toFixed(1)} cặp/1000 xe máy, trong hộp ${m.overlapBoxPer1000.toFixed(1)} / ngoài hộp ${(m.overlapPer1000 - m.overlapBoxPer1000).toFixed(1)} (sâu ${m.deepOverlapPer1000.toFixed(1)}; WARN > ${OVERLAP_WARN_PER_1000} / > ${DEEP_OVERLAP_WARN_PER_1000})`);
  const lateTo = m.windowed ? PROTOCOL[m.protocol].lateTo : m.minutes;
  console.log(`  box kẹt (xe đã vào hộp, v < 0,5 m/s; cửa sổ late phút ${m.lateFromMinute}–${lateTo}, mẫu 1 Hz): TB ${m.boxStandingMean === null ? '–' : m.boxStandingMean.toFixed(1)} xe toàn mạng${m.boxTop.length ? ` — top ${m.boxTop.length} nút (TB/max): ${m.boxTop.map((b) => `${cut(b.junction, 46)} ${b.mean.toFixed(1)}/${b.max}`).join(' | ')}` : ''}`);
  if (m.mixDriftPts !== null && m.carShareStart !== null && m.carShareEnd !== null) {
    console.log(`  mix: ô tô+taxi ${(m.carShareStart * 100).toFixed(1)} % → ${(m.carShareEnd * 100).toFixed(1)} % · mixDriftPts ${m.mixDriftPts >= 0 ? '+' : ''}${m.mixDriftPts.toFixed(2)} (WARN > ${MIX_DRIFT_WARN_PTS}) · hai bánh cuối ${m.bikeShareEnd === null ? '–' : `${(m.bikeShareEnd * 100).toFixed(1)} %`}`);
  } else {
    console.log(`  mix: chạy với --switch-* nên không đo mixDriftPts · hai bánh cuối ${m.bikeShareEnd === null ? '–' : `${(m.bikeShareEnd * 100).toFixed(1)} %`}`);
  }
  const e = rep.end;
  console.log(`  cuối run: ${e.active} xe active, tuổi > 20 phút ${e.older} = ${(e.oldShare * 100).toFixed(1)} %, tuổi TB ${e.meanAgeMin.toFixed(1)} phút, đứng > 60 s ${e.stoppedOver60}, maxStopT ${e.maxStopT.toFixed(0)} s tại ${cut(e.maxStopWhere, 48)}`);
  console.log(`  link kẹt cục bộ (≥ ${RECOVERY.pocketVehicles} xe đứng > ${RECOVERY.pocketStopS} s) cuối run: ${e.pocketLinks}${e.pockets.length ? ` — top ${e.pockets.length}: ${e.pockets.map((p) => `#${p.link} ${cut(p.street, 22)} → ${cut(p.to, 26)} (${p.vehicles})`).join(' | ')}` : ''}`);
  const ed = rep.ageAtDespawn.edgesMin;
  const binLabel = (k: number): string => (k === 0 ? `<${ed[0]}` : k === ed.length ? `≥${ed[k - 1]}` : `${ed[k - 1]}–${ed[k]}`);
  console.log(`  tuổi xe khi despawn (phút${rep.ageAtDespawn.meanMin === null ? '' : `, TB ${rep.ageAtDespawn.meanMin.toFixed(1)}`}): ${rep.ageAtDespawn.counts.map((c, k) => `${binLabel(k)}=${c}`).join(' ')}`);
  const sp = rep.spill;
  console.log(`  cây spillback (cạnh chờ A→B: đầu hàng A đứng ≥ 10 s, đuôi B thiếu chỗ): ${sp.edges} cạnh, ${sp.roots.length ? `top ${sp.roots.length} gốc` : 'không có gốc'}${sp.unrooted.links ? `; ${sp.unrooted.links} link (${sp.unrooted.vehicles} xe) nằm trong chu trình chờ không gốc` : ''}`);
  for (const r of sp.roots) {
    console.log(`    gốc link#${pad(String(r.link), 4)} ${padL(String(r.upVehicles), 4)} xe/${padL(String(r.upLinks), 3)} link thượng nguồn · n ${r.vehicles} stopT ${r.maxStopT.toFixed(0)}s đuôi ${r.tailRoom.toFixed(1)}/${r.length.toFixed(0)} m ${r.lanes} làn ${cut(r.street, 24)} → ${cut(r.to, 40)}`);
  }
  if (calibration) {
    printCalibration(m, hour);
    printSaturation(m);
  }
}

// ------------------------------------------------------------------ one run (one target × one seed)

interface RunResult {
  args: Args;
  target: number;
  seed: number;
  profile: GridlockProfile;
  networkHash: string | null;
  populated: number;
  kpiEnd: TrafficKpi;
  perf: { p50: number; p95: number; max: number; mean: number; budgetMs: number };
  metrics: RunMetrics;
  checks: CheckResult[];
  report: MonitorReport;
  warnings: string[];
}

/** Runs every check once. `print` = the human-readable single-run report; false when a child of a multi-run. */
function runOne(args: Args, target: number, seed: number, print: boolean): RunResult | null {
  const log = (s: string): void => {
    if (print) console.log(s);
  };
  const profile = profileFor(args.map, target, args.nref);
  log(`harness: map=${args.map} giờ=${args.hour} ${args.minutes} phút target=${target} (density ${args.density}) seed=${seed} profile=${profile}${profile === 'legacy' ? '' : ` protocol=${args.protocol}`}${args.switchAt === null ? '' : ` · đổi sang giờ ${args.switchHour} target ${args.switchTarget} ở phút ${args.switchAt}`}`);

  const rows: CheckResult[] = [];
  const t0 = performance.now();
  let world: World;
  try {
    world = buildWorld(args.map, null);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rows.push({ id: 'H1', title: 'Bất biến dựng mạng', status: 'fail', summary: 'builder ném lỗi', details: [msg] });
    printTable(rows);
    process.exitCode = 1;
    return null;
  }
  log(`mạng dựng trong ${(performance.now() - t0).toFixed(0)} ms${world.hash ? ` (q1-network.json sha256 ${world.hash.slice(0, 12)})` : ''}`);
  const jsonStats = world.json?.stats;
  rows.push(checkBuild(world.net, jsonStats));

  if (args.map === 'osm') {
    const jsonSignals = world.json ? world.json.nodes.filter((n) => n.signal).length : null;
    const plans = checkSignalPlans(world.net, jsonSignals);
    rows.push(args.skipStatic ? mergeResults('H5', 'Đèn tín hiệu', [plans]) : mergeResults('H5', 'Đèn tín hiệu', [plans, checkNight(world)]));
  } else {
    rows.push({ id: 'H5', title: 'Đèn tín hiệu', status: 'skip', summary: 'chỉ chạy với --map osm', details: [] });
  }

  log(`chạy ${args.minutes} phút mô phỏng…`);
  const run = mainRun(args, target, world, seed);
  for (const l of run.minuteLog) log(`  ${l}`);
  const rep = run.monitor.report();
  const protocol: ProtocolId = profile === 'legacy' ? 'quick' : args.protocol;
  const extras: RunExtras = {};
  if (run.mix !== undefined) extras.mix = run.mix;
  if (run.recovery !== null) extras.recovery = run.recovery;
  const metrics = runMetrics(run.monitor, rep, { releases: run.kpiEnd.releases, locksBroken: run.kpiEnd.locksBroken, teleports: optNum(run.kpiEnd, 'teleports'), arrivals: optNum(run.kpiEnd, 'arrivals') }, args.minutes, protocol, target, extras);
  rows.push(evalGridlock(metrics, profile, profile === 'legacy' ? loadBaseline(args) : null));

  if (args.skipStatic) rows.push({ id: 'H3', title: 'Tất định', status: 'skip', summary: 'chạy ở seed đầu của mỗi cấu hình', details: [] });
  else {
    log('chạy H3 (tất định, 3 × 180 s)…');
    rows.push(checkDeterminism(args, target, world, seed));
  }
  rows.push(evalWrongWay(run.monitor));
  rows.push(evalOverlap(metrics, args.map === 'osm'));
  if (args.map === 'osm') rows.push(evalRings(run.monitor));
  else rows.push({ id: 'H6', title: 'Vòng xoay', status: 'skip', summary: 'chỉ chạy với --map osm', details: [] });
  const perf = checkPerf(run.ms, args.strictPerf);
  rows.push(perf.res);
  rows.sort((a, b) => a.id.localeCompare(b.id));

  rows.push({
    id: 'H8',
    title: 'Báo cáo',
    status: 'pass',
    summary: `spawn ${rep.spawns} · despawn ${rep.despawns} · locks30 ${metrics.locks30} (release ${metrics.releases} + gỡ khoá ${metrics.locksBroken} + teleport ${metrics.teleports}) · oldShare ${(metrics.oldShare * 100).toFixed(1)} % (${metrics.endOld}/${metrics.endActive}) · maxStopT ${metrics.maxStopTEnd.toFixed(0)} s · link chưa ghé ${rep.linksNeverVisited.length} · mixDriftPts ${metrics.mixDriftPts === null ? '–' : metrics.mixDriftPts.toFixed(2)} · link kẹt cục bộ cuối ${rep.end.pocketLinks}`,
    details: [],
  });
  if (args.map === 'osm') rows.push(evalCalibration(metrics, args.hour));
  else rows.push({ id: 'H9', title: 'Hiệu chuẩn trục', status: 'skip', summary: 'chỉ chạy với --map osm', details: [] });
  if (args.switchAt !== null) rows.push(evalRecovery(metrics.recovery));

  if (print) {
    printTable(rows);
    printReport(rep, metrics, args.hour, args.map === 'osm');
    const hard = rows.filter((r) => r.status === 'fail');
    console.log('');
    console.log(hard.length ? `KẾT LUẬN: FAIL (${hard.map((r) => r.id).join(', ')})` : 'KẾT LUẬN: PASS');
  }
  if (rows.some((r) => r.status === 'fail')) process.exitCode = 1;

  return {
    args,
    target,
    seed,
    profile,
    networkHash: world.hash,
    populated: run.populated,
    kpiEnd: run.kpiEnd,
    perf: { p50: perf.p50, p95: perf.p95, max: perf.max, mean: perf.mean, budgetMs: PERF_BUDGET_MS },
    metrics,
    checks: rows,
    report: rep,
    warnings: world.net.warnings,
  };
}

// ------------------------------------------------------------------ multi-run (seeds × sweep)

interface MetricDef {
  label: string;
  digits: number;
  get: (r: RunResult) => number | null;
}

const METRIC_DEFS: Record<string, MetricDef> = {
  locks30: { label: 'locks30 (release+gỡ khoá+teleport)', digits: 0, get: (r) => r.metrics.locks30 },
  locks: { label: 'locks (release + gỡ khoá)', digits: 0, get: (r) => r.metrics.locks },
  releases: { label: 'release (counter Traffic)', digits: 0, get: (r) => r.metrics.releases },
  locksBroken: { label: 'gỡ khoá (locksBroken)', digits: 0, get: (r) => r.metrics.locksBroken },
  teleports: { label: 'teleport (counter Traffic)', digits: 0, get: (r) => r.metrics.teleports },
  monitorReleases: { label: 'release (diff-monitor)', digits: 0, get: (r) => r.metrics.monitorReleases },
  monitorEarly: { label: 'rời link sớm (diff-monitor)', digits: 0, get: (r) => r.metrics.monitorEarlyLinkRemovals },
  releasePct: { label: 'release % spawn', digits: 2, get: (r) => r.metrics.releasePct },
  spawns: { label: 'spawn', digits: 0, get: (r) => r.metrics.spawns },
  despawns: { label: 'despawn', digits: 0, get: (r) => r.metrics.despawns },
  speedMean: { label: 'v̄ cả run (km/h)', digits: 2, get: (r) => r.metrics.speedMeanKmh },
  speedLate: { label: 'v̄ nửa sau / cửa sổ late', digits: 2, get: (r) => r.metrics.lateSpeedKmh },
  carSpeedLate: { label: 'v̄ ô tô+taxi late (TomTom)', digits: 2, get: (r) => r.metrics.carSpeedLateKmh },
  bikeSpeedLate: { label: 'v̄ xe máy+Grab late', digits: 2, get: (r) => r.metrics.bikeSpeedLateKmh },
  speedRatio: { label: 'v̄ late / ref', digits: 2, get: (r) => r.metrics.speedRatio },
  slope: { label: 'slope v̄ (km/h/phút)', digits: 2, get: (r) => r.metrics.slope },
  tputRef: { label: 'despawn/phút cửa sổ ref', digits: 1, get: (r) => r.metrics.tputRefMean },
  tputLate: { label: 'despawn/phút cửa sổ late', digits: 1, get: (r) => r.metrics.tputLateMean },
  tputRatio: { label: 'tỉ lệ throughput late / ref', digits: 2, get: (r) => r.metrics.tputRatio },
  starvedRoom: { label: 'link đói (lối ra có chỗ)', digits: 0, get: (r) => r.metrics.starvedRoom },
  starvedOld: { label: 'link đói (định nghĩa cũ)', digits: 0, get: (r) => r.metrics.starvedOld },
  ringMaxStopT: { label: 'ring: stopT max (s)', digits: 0, get: (r) => r.metrics.ringMaxStopT },
  ringOver: { label: 'ring: mẫu > 45 s', digits: 0, get: (r) => r.metrics.ringOver },
  oldShare: { label: 'xe > 20 phút / active cuối (%)', digits: 1, get: (r) => r.metrics.oldShare * 100 },
  arrivals: { label: 'đến đích nội bộ (arrivals)', digits: 0, get: (r) => r.metrics.arrivals },
  locksPer1000: { label: 'locks30 / 1000 xe', digits: 1, get: (r) => r.metrics.locksPer1000 },
  artSpeed: { label: 'v̄ trục hiệu chuẩn (km/h)', digits: 1, get: (r) => r.metrics.artSpeedKmh },
  artDens: { label: 'xe/100 m/làn trục hiệu chuẩn', digits: 1, get: (r) => r.metrics.artDensity },
  artBikeDens: { label: 'xe máy/100 m/làn trục hiệu chuẩn', digits: 1, get: (r) => r.metrics.artBikeDensity },
  minStreet: { label: 'v̄ trục chậm nhất (km/h)', digits: 1, get: (r) => r.metrics.minStreetKmh },
  satMcu: { label: 'bão hoà median (MCU/s/m)', digits: 2, get: (r) => r.metrics.satMedianMcuPerSM },
  satMcuClear: { label: 'bão hoà median lối ra thông (MCU/s/m)', digits: 2, get: (r) => r.metrics.satMedianMcuPerSMClear },
  overlap: { label: 'H4b xe máy chồng thân /1000 xe máy', digits: 1, get: (r) => r.metrics.overlapPer1000 },
  deepOverlap: { label: 'H4b chồng sâu /1000 xe máy', digits: 1, get: (r) => r.metrics.deepOverlapPer1000 },
  overlapBox: { label: 'H4b chồng thân trong hộp /1000 xe máy', digits: 1, get: (r) => r.metrics.overlapBoxPer1000 },
  boxStanding: { label: 'box kẹt: xe đứng trong hộp TB (late)', digits: 0, get: (r) => r.metrics.boxStandingMean },
  mixDrift: { label: 'mixDriftPts (ô tô+taxi, điểm)', digits: 2, get: (r) => r.metrics.mixDriftPts },
  bikeShareEnd: { label: 'hai bánh cuối run (%)', digits: 1, get: (r) => (r.metrics.bikeShareEnd === null ? null : r.metrics.bikeShareEnd * 100) },
  pocketsEnd: { label: 'link kẹt cục bộ cuối run', digits: 0, get: (r) => r.report.end.pocketLinks },
  recKmh: { label: 'H10 v̄ tại +3 phút (km/h)', digits: 1, get: (r) => r.metrics.recovery?.score?.kmh ?? null },
  recStopped: { label: 'H10 xe đứng > 5 s tại +3 phút (%)', digits: 1, get: (r) => (r.metrics.recovery?.score ? r.metrics.recovery.score.stoppedShare * 100 : null) },
  recPockets: { label: 'H10 link kẹt cục bộ tại +3 phút', digits: 0, get: (r) => r.metrics.recovery?.score?.pocketLinks ?? null },
  maxStopTEnd: { label: 'maxStopT cuối run (s)', digits: 0, get: (r) => r.metrics.maxStopTEnd },
  countEnd: { label: 'xe cuối run', digits: 0, get: (r) => r.kpiEnd.count },
  waitingEnd: { label: 'xe đứng (v<0.5) cuối run', digits: 0, get: (r) => r.kpiEnd.waiting },
  p95: { label: 'p95 ms/step', digits: 2, get: (r) => r.perf.p95 },
};

interface ConfigResult {
  target: number;
  profile: GridlockProfile;
  seeds: number[];
  runs: RunResult[];
  stats: Record<string, Stat | null>;
  h2: CheckResult;
  /** H2 judged with the 'ref' rules whatever the profile (input to the N_ref choice). */
  passesRef: boolean;
  /** Per check id: how many seeds ended in each status. */
  checkCounts: Record<string, Record<CheckStatus, number>>;
}

const num = (v: number | null, d: number): string => (v === null ? '–' : v.toFixed(d));

function summariseConfig(target: number, profile: GridlockProfile, seeds: number[], runs: RunResult[], baseline: LegacyBaseline | null): ConfigResult {
  const stats: Record<string, Stat | null> = {};
  for (const [key, def] of Object.entries(METRIC_DEFS)) {
    stats[key] = stat(runs.flatMap((r) => {
      const v = def.get(r);
      return v === null ? [] : [v];
    }));
  }
  const verdict = evalGridlockSeeds(runs.map((r) => r.metrics), profile, baseline);
  const passesRef = profile === 'legacy' ? false : profile === 'ref' ? verdict.ok : evalGridlockSeeds(runs.map((r) => r.metrics), 'ref').ok;
  const checkCounts: Record<string, Record<CheckStatus, number>> = {};
  for (const r of runs) {
    for (const c of r.checks) {
      const row = (checkCounts[c.id] ??= { pass: 0, fail: 0, warn: 0, skip: 0 });
      row[c.status]++;
    }
  }
  return { target, profile, seeds, runs, stats, h2: verdict.result, passesRef, checkCounts };
}

function printConfig(c: ConfigResult): void {
  console.log('');
  console.log(`=== target ${c.target} · profile ${c.profile} · seed ${c.seeds.join(',')} ===`);
  console.log(`${pad('metric', 34)}${padL('median', 10)}${padL('min', 10)}${padL('max', 10)}   theo seed`);
  for (const [key, def] of Object.entries(METRIC_DEFS)) {
    const s = c.stats[key];
    const per = c.runs.map((r) => num(def.get(r), def.digits)).join(' ');
    console.log(`${pad(def.label, 34)}${padL(s ? s.median.toFixed(def.digits) : '–', 10)}${padL(s ? s.min.toFixed(def.digits) : '–', 10)}${padL(s ? s.max.toFixed(def.digits) : '–', 10)}   ${per}`);
  }
  const cells = Object.entries(c.checkCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, n]) => `${id} ${n.pass}✓${n.fail ? ` ${n.fail}✗` : ''}${n.warn ? ` ${n.warn}!` : ''}${n.skip ? ` ${n.skip}–` : ''}`);
  console.log(`checks (số seed): ${cells.join(' · ')}`);
  console.log(`H2 ${STATUS_LABEL[c.h2.status]}: ${c.h2.summary}`);
  for (const d of c.h2.details) console.log(`   ${d}`);
  const worstPerSeed = c.runs.map((r) => `seed ${r.seed}: ${r.checks.filter((k) => k.status === 'fail').map((k) => k.id).join(',') || 'ok'}`).join(' | ');
  console.log(`fail theo seed: ${worstPerSeed}`);
}

function printSweep(cfgs: ConfigResult[], suggested: number | null): void {
  console.log('');
  console.log('=== SWEEP (median [min–max] qua các seed) ===');
  console.log(`${padL('N', 6)} ${pad('profile', 7)} ${padL('locks30', 14)} ${padL('v̄ late', 18)} ${padL('v̄ ô tô late', 18)} ${padL('art v̄', 8)} ${padL('art dens', 9)} ${padL('minStreet', 10)} ${padL('slope', 18)} ${padL('tput late/ref', 18)} ${padL('xe già %', 14)} ${padL('đói/ring', 9)} ${padL('p95 ms', 7)}  H2 ref  H2`);
  const cell = (s: Stat | null, d: number): string => (s ? `${s.median.toFixed(d)} [${s.min.toFixed(d)}–${s.max.toFixed(d)}]` : '–');
  for (const c of cfgs) {
    const st = c.stats;
    const starved = `${st.starvedRoom?.max ?? 0}/${st.ringOver?.max ?? 0}`;
    console.log(
      `${padL(String(c.target), 6)} ${pad(c.profile, 7)} ${padL(cell(st.locks30, 0), 14)} ${padL(cell(st.speedLate, 1), 18)} ${padL(cell(st.carSpeedLate, 1), 18)} ${padL(st.artSpeed ? st.artSpeed.median.toFixed(1) : '–', 8)} ${padL(st.artDens ? st.artDens.median.toFixed(1) : '–', 9)} ${padL(st.minStreet ? st.minStreet.median.toFixed(1) : '–', 10)} ${padL(cell(st.slope, 2), 18)} ${padL(cell(st.tputRatio, 2), 18)} ${padL(cell(st.oldShare, 1), 14)} ${padL(starved, 9)} ${padL(st.p95 ? st.p95.median.toFixed(2) : '–', 7)}  ${pad(c.profile === 'legacy' ? 'n/a' : c.passesRef ? 'PASS' : 'FAIL', 6)}  ${STATUS_LABEL[c.h2.status]}`,
    );
  }
  if (cfgs[0]?.profile !== 'legacy') console.log(`N_ref đề xuất (N lớn nhất thoả mọi tiêu chí ref ở mọi seed): ${suggested === null ? 'không có N nào trong sweep' : suggested}`);
}

interface Job {
  target: number;
  seed: number;
  first: boolean;
  file: string;
}

function runChild(args: Args, job: Job): Promise<RunResult> {
  const argv = [SCRIPT, '--map', args.map, '--hour', String(args.hour), '--minutes', String(args.minutes), '--density', String(args.density), '--target', String(job.target), '--seed', String(job.seed), '--nref', String(args.nref), '--protocol', args.protocol, '--baseline', 'none', '--json', job.file];
  if (!job.first) argv.push('--skip-static');
  if (args.strictPerf) argv.push('--strict-perf');
  if (args.switchHour !== null && args.switchAt !== null && args.switchTarget !== null) argv.push('--switch-hour', String(args.switchHour), '--switch-at', String(args.switchAt), '--switch-target', String(args.switchTarget));
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  const p = spawn(process.argv[0], argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => {
    out += d.toString();
  });
  p.stderr.on('data', (d) => {
    out += d.toString();
  });
  p.on('error', reject);
  p.on('close', (code) => {
    try {
      resolve(JSON.parse(readFileSync(job.file, 'utf8')) as RunResult);
    } catch {
      reject(new Error(`child target=${job.target} seed=${job.seed} thoát mã ${code}, không có JSON:\n${out.split('\n').slice(-25).join('\n')}`));
    }
  });
  return promise;
}

async function runMulti(args: Args): Promise<void> {
  const base = args.target ?? BASE_TARGET[args.map];
  const targets = (args.sweep ?? [base]).map((n) => Math.round(n * args.density));
  const seeds = args.seeds !== null ? Array.from({ length: args.seeds }, (_, i) => i + 1) : [args.seed ?? 1];
  const dir = mkdtempSync(join(tmpdir(), 'harness-'));
  const jobs: Job[] = [];
  for (const target of targets) seeds.forEach((seed, k) => jobs.push({ target, seed, first: k === 0, file: join(dir, `t${target}-s${seed}.json`) }));
  const par = Math.min(jobs.length, args.jobs ?? Math.max(1, cpus().length - 2));
  console.log(`harness: map=${args.map} giờ=${args.hour} ${args.minutes} phút protocol=${args.map === 'legacy' ? 'legacy' : args.protocol} target ${targets.join(',')} × seed ${seeds.join(',')} = ${jobs.length} run, song song ${par}`);
  const t0 = performance.now();
  const done = new Map<string, RunResult>();
  let next = 0;
  let failure: Error | null = null;
  const worker = async (): Promise<void> => {
    while (failure === null && next < jobs.length) {
      const job = jobs[next++];
      try {
        const r = await runChild(args, job);
        done.set(job.file, r);
        const art = args.map === 'osm' ? `, trục v̄ ${num(r.metrics.artSpeedKmh, 1)} (${num(r.metrics.artDensity, 1)} xe/100m/làn, chậm nhất ${num(r.metrics.minStreetKmh, 1)})` : '';
        console.log(`  xong target ${job.target} seed ${job.seed} (${((performance.now() - t0) / 1000).toFixed(0)} s): locks30 ${r.metrics.locks30}, v̄ ${num(r.metrics.lateSpeedKmh, 1)} (ô tô ${num(r.metrics.carSpeedLateKmh, 1)}), oldShare ${(r.metrics.oldShare * 100).toFixed(1)} %${art}`);
      } catch (e) {
        failure = e instanceof Error ? e : new Error(String(e));
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: par }, worker));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failure !== null) throw failure;

  const hash = args.map === 'osm' ? loadOsmJson().hash : null;
  const hashes = new Set([...done.values()].map((r) => r.networkHash));
  const hashMismatch = args.map === 'osm' && (hashes.size !== 1 || !hashes.has(hash));
  if (hashMismatch) console.log(`CẢNH BÁO: q1-network.json đổi giữa chừng (hash các run: ${[...hashes].map((h) => (h ?? 'null').slice(0, 12)).join(', ')}; hiện tại ${(hash ?? '').slice(0, 12)})`);

  const baseline = args.map === 'legacy' ? loadBaseline(args) : null;
  const cfgs = targets.map((target) => {
    const runs = jobs.filter((j) => j.target === target).map((j) => done.get(j.file) as RunResult);
    return summariseConfig(target, profileFor(args.map, target, args.nref), seeds, runs, baseline);
  });
  for (const c of cfgs) printConfig(c);
  const passing = cfgs.filter((c) => c.profile !== 'legacy' && c.passesRef).map((c) => c.target);
  const suggested = passing.length ? Math.max(...passing) : null;
  if (cfgs.length > 1 || args.map === 'osm') printSweep(cfgs, suggested);

  const hardFail = cfgs.some((c) => c.h2.status === 'fail' || Object.entries(c.checkCounts).some(([id, n]) => id !== 'H2' && n.fail > 0));
  console.log('');
  console.log(hardFail ? 'KẾT LUẬN: FAIL' : 'KẾT LUẬN: PASS');
  if (hardFail) process.exitCode = 1;

  if (args.json) {
    const out = {
      args,
      networkHash: hash,
      networkHashMismatch: hashMismatch,
      protocol: PROTOCOL,
      baseline,
      seeds,
      suggestedNref: suggested,
      configs: cfgs.map((c) => ({ target: c.target, profile: c.profile, stats: c.stats, h2: c.h2, passesRef: c.passesRef, checkCounts: c.checkCounts, runs: c.runs })),
    };
    writeFileSync(resolve(args.json), `${JSON.stringify(out, null, 1)}\n`);
    console.log(`đã ghi ${args.json}`);
  }
}

// ------------------------------------------------------------------ entry

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === 'string') {
    console.error(`${parsed}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const args = parsed;
  if (args.seeds !== null || args.sweep !== null) {
    await runMulti(args);
    return;
  }
  const target = Math.round((args.target ?? BASE_TARGET[args.map]) * args.density);
  const res = runOne(args, target, args.seed ?? DEFAULT_SEED, true);
  if (res && args.json) {
    writeFileSync(resolve(args.json), `${JSON.stringify(res, null, 1)}\n`);
    console.log(`đã ghi ${args.json}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 2;
});
