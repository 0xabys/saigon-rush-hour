/** Canvas drawing and hit-testing of the live sim overlay: heat, signals, vehicles and selection. */
import type { View, Layers } from './draw';
import { draw, drawScaleBar } from './draw';
import type { LiveSim } from './live';
import type { Model } from './model';
import { SegKind } from '../sim/network';
import { Light } from '../sim/signals';
import { VType } from '../sim/vehicleTypes';

export interface LiveLayers {
  /** Static P1 layers drawn once into a cache behind the live overlay. */
  roads: boolean;
  arrows: boolean;
  names: boolean;
  ground: boolean;
  junctions: boolean;
  /** Live layers. */
  heat: boolean;
  signals: boolean;
  yields: boolean;
  vehicles: boolean;
}

export type LiveSelection = { kind: 'vehicle'; uid: number } | { kind: 'junction'; id: number };

export const LIVE_LAYER_LABELS: Record<keyof LiveLayers, string> = {
  roads: 'Mặt đường (màu theo cấp)',
  arrows: 'Mũi tên chiều đi',
  names: 'Tên đường (khi phóng to)',
  ground: 'Nền: toà nhà, nước, công viên',
  junctions: 'Cụm giao lộ / nút',
  heat: 'Mật độ theo đoạn đường (xanh → đỏ)',
  signals: 'Vạch dừng theo pha đèn + đếm ngược',
  yields: 'Vạch nhường (giao lộ không đèn)',
  vehicles: 'Xe',
};

export const DEFAULT_LIVE_LAYERS: LiveLayers = {
  roads: true,
  arrows: false,
  names: false,
  ground: false,
  junctions: false,
  heat: false,
  signals: true,
  yields: true,
  vehicles: true,
};

export const TYPE_COLOR: Record<VType, string> = {
  [VType.Moto]: '#e0533a',
  [VType.Grab]: '#36c070',
  [VType.Car]: '#f0b04a',
  [VType.TaxiVinasun]: '#f6f3d2',
  [VType.TaxiMaiLinh]: '#b6f08a',
  [VType.Bus]: '#3fb7b0',
  [VType.Truck]: '#a7794a',
  [VType.Cyclo]: '#d6a7ff',
  [VType.RideCar]: '#16b8c4',
};

/** Outline per `Reason` (free, follow, yield, signal, dwell) and for crashed vehicles. */
export const REASON_COLOR: Record<number, string> = {
  0: 'rgba(8,10,13,0.85)',
  1: '#4fc3f7',
  2: '#ff9f1c',
  3: '#ff4d4d',
  4: '#c77dff',
  5: '#ffffff',
};
export const REASON_LABEL: Record<number, string> = {
  0: 'Chạy tự do',
  1: 'Theo xe trước',
  2: 'Nhường đường',
  3: 'Chờ đèn',
  4: 'Dừng đón khách',
  5: 'Va chạm',
};
const CRASH_KEY = 5;

export const LIGHT_COLOR: Record<number, string> = {
  [Light.Green]: '#2ecc71',
  [Light.Amber]: '#ffc233',
  [Light.Red]: '#ff3b3b',
  [Light.Flash]: '#ffc233',
};
export const LIGHT_LABEL: Record<number, string> = {
  [Light.Green]: 'Xanh',
  [Light.Amber]: 'Vàng',
  [Light.Red]: 'Đỏ',
  [Light.Flash]: 'Vàng nhấp nháy',
};

const HEAT_BUCKETS = 12;
/** Area occupancy at which the heat is fully red. */
const HEAT_FULL = 0.55;
const HEAT_MIN = 0.03;
const HEAT_COLOR: string[] = Array.from({ length: HEAT_BUCKETS }, (_, b) => `hsl(${Math.round(125 * (1 - b / (HEAT_BUCKETS - 1)))} 90% 52%)`);

/** P1 `Layers` equivalent of the static part of the live layers. */
function baseLayers(l: LiveLayers): Layers {
  return {
    links: l.roads,
    names: l.names,
    arrows: l.arrows,
    clusters: l.junctions,
    members: false,
    arms: false,
    rings: l.roads,
    busStops: false,
    anomalies: false,
    raw: false,
    buildings: l.ground,
    gob: l.ground,
    water: l.ground,
    parks: l.ground,
    landmarks: false,
    bounds: true,
  };
}

/** Offscreen copy of the P1 drawing; only repainted when the view or the static layers change. */
export class BaseCache {
  private readonly canvas = document.createElement('canvas');
  private key = '';

  render(model: Model, v: View, layers: LiveLayers): HTMLCanvasElement {
    const key = [v.cx, v.cz, v.scale, v.w, v.h, v.dpr, layers.roads, layers.arrows, layers.names, layers.ground, layers.junctions].join('|');
    if (key !== this.key) {
      this.key = key;
      const w = Math.round(v.w * v.dpr);
      const hgt = Math.round(v.h * v.dpr);
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== hgt) this.canvas.height = hgt;
      const c = this.canvas.getContext('2d') as CanvasRenderingContext2D;
      draw(c, v, model, baseLayers(layers), null, null, null, '', 0);
      // Dim the map so the live layer stands out; the scale bar is drawn again on top afterwards.
      c.fillStyle = 'rgba(16,19,23,0.58)';
      c.fillRect(0, 0, v.w, v.h);
      drawScaleBar(c, v);
    }
    return this.canvas;
  }
}

function boxVisible(v: View, b: Float32Array, id: number, slack: number): boolean {
  const [x0, y0] = v.toScreen(b[id * 4], b[id * 4 + 1]);
  const [x1, y1] = v.toScreen(b[id * 4 + 2], b[id * 4 + 3]);
  return x1 >= -slack && x0 <= v.w + slack && y1 >= -slack && y0 <= v.h + slack;
}

function drawHeat(ctx: CanvasRenderingContext2D, v: View, sim: LiveSim): void {
  const paths = HEAT_COLOR.map(() => new Path2D());
  const widths = new Float32Array(HEAT_BUCKETS);
  const used = new Uint8Array(HEAT_BUCKETS);
  // Segments are bucketed by colour; each bucket is stroked once with its mean carriageway width.
  const widthSum = new Float32Array(HEAT_BUCKETS);
  const widthN = new Uint32Array(HEAT_BUCKETS);
  for (const sg of sim.net.segments) {
    if (sg.kind === SegKind.Conn) continue;
    const area = sim.area[sg.id];
    if (area <= 0) continue;
    const occ = sim.scan.occ[sg.id] / area;
    if (occ < HEAT_MIN) continue;
    if (!boxVisible(v, sim.segBox, sg.id, 30)) continue;
    const b = Math.min(HEAT_BUCKETS - 1, Math.floor((occ / HEAT_FULL) * HEAT_BUCKETS));
    const stride = Math.max(1, Math.round(2.5 / v.scale / sg.step));
    const p = paths[b];
    let first = true;
    for (let i = 0; i < sg.n; i += stride) {
      const [sx, sy] = v.toScreen(sg.px[i], sg.pz[i]);
      if (first) p.moveTo(sx, sy);
      else p.lineTo(sx, sy);
      first = false;
    }
    const [ex, ey] = v.toScreen(sg.px[sg.n - 1], sg.pz[sg.n - 1]);
    p.lineTo(ex, ey);
    used[b] = 1;
    widthSum[b] += sg.halfW * 2;
    widthN[b]++;
  }
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = 0.78;
  for (let b = 0; b < HEAT_BUCKETS; b++) {
    if (!used[b]) continue;
    widths[b] = widthSum[b] / widthN[b];
    ctx.strokeStyle = HEAT_COLOR[b];
    ctx.lineWidth = Math.max(2.5, widths[b] * v.scale);
    ctx.stroke(paths[b]);
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = 'round';
}

function drawSignals(ctx: CanvasRenderingContext2D, v: View, sim: LiveSim): void {
  ctx.font = '700 11px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineCap = 'butt';
  const blinkOn = Math.floor(sim.simTime * 2) % 2 === 0;
  for (const j of sim.net.signalJunctions) {
    const [cx, cy] = v.toScreen(j.x, j.z);
    if (cx < -80 || cy < -80 || cx > v.w + 80 || cy > v.h + 80) continue;
    for (const arm of j.arms) {
      const sg = arm.inLink;
      if (!sg?.signal) continue;
      const q = sim.signals.query(sg.signal.nodeIndex, sg.signal.group, sim.simTime);
      const light = q.light;
      const remaining = q.remaining;
      const k = sg.n - 1;
      const tx = sg.tx[k];
      const tz = sg.tz[k];
      const half = sg.halfW;
      const [x0, y0] = v.toScreen(sg.px[k] - tz * half, sg.pz[k] + tx * half);
      const [x1, y1] = v.toScreen(sg.px[k] + tz * half, sg.pz[k] - tx * half);
      ctx.strokeStyle = light === Light.Flash && !blinkOn ? '#5b4a1a' : LIGHT_COLOR[light];
      ctx.lineWidth = Math.max(3, Math.min(6, v.scale * 1.2));
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      if (v.scale > 3 && light !== Light.Flash) {
        const [px, py] = v.toScreen(sg.px[k] - tx * 7, sg.pz[k] - tz * 7);
        ctx.fillStyle = LIGHT_COLOR[light];
        ctx.fillText(String(Math.ceil(remaining)), px, py);
      }
    }
  }
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
  ctx.lineCap = 'round';
}

function drawYields(ctx: CanvasRenderingContext2D, v: View, sim: LiveSim): void {
  ctx.strokeStyle = '#ff9f1c';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.lineCap = 'butt';
  ctx.beginPath();
  for (const sg of sim.net.links) {
    if (!sg.yieldAt) continue;
    if (!boxVisible(v, sim.segBox, sg.id, 20)) continue;
    const k = sg.n - 1;
    const tx = sg.tx[k];
    const tz = sg.tz[k];
    const [x0, y0] = v.toScreen(sg.px[k] - tz * sg.halfW, sg.pz[k] + tx * sg.halfW);
    const [x1, y1] = v.toScreen(sg.px[k] + tz * sg.halfW, sg.pz[k] - tx * sg.halfW);
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineCap = 'round';
}

const TYPE_COUNT = 8;

/** Rectangle centred on (cx, cy) with half-length vector (ax, ay) and half-width vector (bx, by). */
function addQuad(p: Path2D, cx: number, cy: number, ax: number, ay: number, bx: number, by: number): void {
  p.moveTo(cx - ax - bx, cy - ay - by);
  p.lineTo(cx + ax - bx, cy + ay - by);
  p.lineTo(cx + ax + bx, cy + ay + by);
  p.lineTo(cx - ax + bx, cy - ay + by);
  p.closePath();
}

function drawVehicles(ctx: CanvasRenderingContext2D, v: View, sim: LiveSim): void {
  const tr = sim.traffic;
  const fills = Array.from({ length: TYPE_COUNT }, () => new Path2D());
  const outlines = Array.from({ length: CRASH_KEY + 1 }, () => new Path2D());
  const w = v.w + 20;
  const hgt = v.h + 20;
  for (let i = 0; i < tr.hi; i++) {
    if (!tr.active[i]) continue;
    const [sx, sy] = v.toScreen(tr.x[i], tr.z[i]);
    if (sx < -20 || sy < -20 || sx > w || sy > hgt) continue;
    const hx = tr.hx[i];
    const hz = tr.hz[i];
    const hl = Math.max(tr.len[i] * v.scale, 5) / 2;
    const hw = Math.max(tr.wid[i] * v.scale, 2.6) / 2;
    const ax = hx * hl;
    const ay = hz * hl;
    const bx = -hz * hw;
    const by = hx * hw;
    const fill = fills[tr.type[i]];
    const out = outlines[tr.crashed[i] ? CRASH_KEY : tr.reason[i]];
    addQuad(fill, sx, sy, ax, ay, bx, by);
    addQuad(out, sx, sy, ax, ay, bx, by);
  }
  // Outline first, fill on top: zoomed out the type colour stays readable with a thin reason ring around it.
  ctx.lineJoin = 'miter';
  for (let r = 0; r <= CRASH_KEY; r++) {
    ctx.strokeStyle = REASON_COLOR[r];
    ctx.lineWidth = r === 0 ? 1 : 2.2;
    ctx.stroke(outlines[r]);
  }
  ctx.lineJoin = 'round';
  for (let t = 0; t < TYPE_COUNT; t++) {
    ctx.fillStyle = TYPE_COLOR[t as VType];
    ctx.fill(fills[t]);
  }
}

function drawSelection(ctx: CanvasRenderingContext2D, v: View, sim: LiveSim, sel: LiveSelection): void {
  ctx.strokeStyle = '#00f5d4';
  ctx.fillStyle = '#00f5d4';
  ctx.lineWidth = 2;
  if (sel.kind === 'vehicle') {
    const i = sim.traffic.indexOf(sel.uid);
    if (i < 0) return;
    const [sx, sy] = v.toScreen(sim.traffic.x[i], sim.traffic.z[i]);
    ctx.beginPath();
    ctx.arc(sx, sy, 13, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + sim.traffic.hx[i] * 26, sy + sim.traffic.hz[i] * 26);
    ctx.stroke();
    return;
  }
  const j = sim.net.junctions[sel.id];
  const [cx, cy] = v.toScreen(j.x, j.z);
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(14, j.radius * v.scale), 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = '700 11px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  j.arms.forEach((arm, k) => {
    const [sx, sy] = v.toScreen(arm.stopX + Math.cos(arm.angle) * 3, arm.stopZ + Math.sin(arm.angle) * 3);
    ctx.fillStyle = 'rgba(16,19,23,0.85)';
    ctx.beginPath();
    ctx.arc(sx, sy, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#00f5d4';
    ctx.stroke();
    ctx.fillText(String(k), sx, sy + 0.5);
  });
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

/** Whole live frame: cached P1 base, then heat, signals, yields, vehicles, selection. */
export function drawLive(ctx: CanvasRenderingContext2D, v: View, base: HTMLCanvasElement, sim: LiveSim, layers: LiveLayers, sel: LiveSelection | null): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(base, 0, 0);
  ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (layers.heat) drawHeat(ctx, v, sim);
  if (layers.yields) drawYields(ctx, v, sim);
  if (layers.signals) drawSignals(ctx, v, sim);
  if (layers.vehicles) drawVehicles(ctx, v, sim);
  if (sel) drawSelection(ctx, v, sim, sel);
}

/** Nearest vehicle (≤ ~10 px) or junction under a screen point; vehicles win. */
export function pickLive(v: View, sim: LiveSim, sx: number, sy: number): LiveSelection | null {
  const tr = sim.traffic;
  let best: LiveSelection | null = null;
  let bestD = Infinity;
  for (let i = 0; i < tr.hi; i++) {
    if (!tr.active[i]) continue;
    const [px, py] = v.toScreen(tr.x[i], tr.z[i]);
    const reach = Math.max(9, (tr.len[i] * v.scale) / 2 + 3);
    const d = Math.hypot(px - sx, py - sy);
    if (d <= reach && d < bestD) {
      bestD = d;
      best = { kind: 'vehicle', uid: tr.uid[i] };
    }
  }
  if (best) return best;
  for (const j of sim.net.junctions) {
    if (j.kind !== 'junction' && j.kind !== 'ring') continue;
    const [px, py] = v.toScreen(j.x, j.z);
    const reach = Math.max(14, j.radius * v.scale);
    const d = Math.hypot(px - sx, py - sy) / reach;
    if (d <= 1 && d < bestD) {
      bestD = d;
      best = { kind: 'junction', id: j.id };
    }
  }
  return best;
}
