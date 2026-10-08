/** Canvas 2D renderer for the OSM debug page: view transform, layers and hit-testing. */
import type { RoadClassName } from '../data/q1Schema';
import type { Model, Pt, Selection } from './model';
import { LANE_W, gobSelection } from './model';

export interface Layers {
  links: boolean;
  names: boolean;
  arrows: boolean;
  clusters: boolean;
  members: boolean;
  arms: boolean;
  rings: boolean;
  busStops: boolean;
  anomalies: boolean;
  raw: boolean;
  buildings: boolean;
  /** Google Open Buildings footprints (`scene.gobBuildings`, negative ids). */
  gob: boolean;
  water: boolean;
  parks: boolean;
  landmarks: boolean;
  bounds: boolean;
}

export const CLASS_COLOR: Record<RoadClassName, string> = {
  trunk: '#d64fd8',
  primary: '#ff7a1a',
  secondary: '#f2c230',
  tertiary: '#4fc3f7',
  residential: '#9fb0c3',
  unclassified: '#7d8794',
};

const GROUP_COLOR = ['#ff6b6b', '#5aa9ff'];
/** Muted teal so Google footprints read apart from the grey OSM building fill (#232830). */
const GOB_FILL = 'rgba(64,150,128,0.32)';
const GOB_STROKE = 'rgba(96,190,164,0.7)';

export interface Focus {
  x: number;
  z: number;
  /** performance.now() when the jump happened (drives the pulse). */
  t: number;
}

export class View {
  scale = 1;
  cx = 0;
  cz = 0;
  w = 1;
  h = 1;
  dpr = 1;

  toScreen(x: number, z: number): [number, number] {
    return [(x - this.cx) * this.scale + this.w / 2, (z - this.cz) * this.scale + this.h / 2];
  }

  toWorld(sx: number, sy: number): Pt {
    return { x: (sx - this.w / 2) / this.scale + this.cx, z: (sy - this.h / 2) / this.scale + this.cz };
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    this.scale = Math.max(0.12, Math.min(40, this.scale * factor));
    this.cx = before.x - (sx - this.w / 2) / this.scale;
    this.cz = before.z - (sy - this.h / 2) / this.scale;
  }

  fit(b: { minX: number; maxX: number; minZ: number; maxZ: number }): void {
    this.cx = (b.minX + b.maxX) / 2;
    this.cz = (b.minZ + b.maxZ) / 2;
    this.scale = Math.min(this.w / (b.maxX - b.minX), this.h / (b.maxZ - b.minZ)) * 0.96;
  }
}

function tracePoly(ctx: CanvasRenderingContext2D, v: View, pts: number[], close: boolean): void {
  for (let i = 0; i < pts.length; i += 2) {
    const [sx, sy] = v.toScreen(pts[i], pts[i + 1]);
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  }
  if (close) ctx.closePath();
}

function visible(v: View, b: { minX: number; maxX: number; minZ: number; maxZ: number }): boolean {
  const [x0, y0] = v.toScreen(b.minX, b.minZ);
  const [x1, y1] = v.toScreen(b.maxX, b.maxZ);
  return x1 >= -20 && x0 <= v.w + 20 && y1 >= -20 && y0 <= v.h + 20;
}

function polyBounds(pts: number[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < pts.length; i += 2) {
    b.minX = Math.min(b.minX, pts[i]);
    b.maxX = Math.max(b.maxX, pts[i]);
    b.minZ = Math.min(b.minZ, pts[i + 1]);
    b.maxZ = Math.max(b.maxZ, pts[i + 1]);
  }
  return b;
}

function fillPolys(ctx: CanvasRenderingContext2D, v: View, items: { pts: number[]; holes?: number[][] }[], fill: string, stroke: string): void {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  for (const it of items) {
    if (!visible(v, polyBounds(it.pts))) continue;
    ctx.beginPath();
    tracePoly(ctx, v, it.pts, true);
    for (const h of it.holes ?? []) tracePoly(ctx, v, h, true);
    ctx.fill('evenodd');
    ctx.stroke();
  }
}

/** Chevrons along a screen polyline every `spacing` px, pointing along its direction. */
function chevrons(ctx: CanvasRenderingContext2D, pts: [number, number][], spacing: number, size: number, offset: number): void {
  let carry = spacing / 2;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len === 0) continue;
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    let d = carry;
    for (; d <= len; d += spacing) {
      const px = x0 + ux * d - uy * offset;
      const py = y0 + uy * d + ux * offset;
      ctx.moveTo(px - ux * size - uy * size * 0.7, py - uy * size + ux * size * 0.7);
      ctx.lineTo(px + ux * size * 0.4, py + uy * size * 0.4);
      ctx.lineTo(px - ux * size + uy * size * 0.7, py - uy * size - ux * size * 0.7);
    }
    carry = d - len;
  }
}

/** Point and unit direction at arclength `s` along a flat polyline. */
export function pointAt(pts: number[], s: number): { x: number; z: number; dx: number; dz: number } {
  let acc = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const dx = pts[i] - pts[i - 2];
    const dz = pts[i + 1] - pts[i - 1];
    const len = Math.hypot(dx, dz);
    if (acc + len >= s || i === pts.length - 2) {
      const t = len === 0 ? 0 : Math.max(0, Math.min(1, (s - acc) / len));
      return { x: pts[i - 2] + dx * t, z: pts[i - 1] + dz * t, dx: len ? dx / len : 1, dz: len ? dz / len : 0 };
    }
    acc += len;
  }
  return { x: pts[0], z: pts[1], dx: 1, dz: 0 };
}

export function draw(
  ctx: CanvasRenderingContext2D,
  v: View,
  m: Model,
  layers: Layers,
  hover: Selection | null,
  selected: Selection | null,
  focus: Focus | null,
  anomalyKind: string,
  now: number,
): void {
  ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  ctx.fillStyle = '#101317';
  ctx.fillRect(0, 0, v.w, v.h);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (layers.water) fillPolys(ctx, v, m.scene.water, '#17364f', '#24527a');
  if (layers.parks) fillPolys(ctx, v, m.scene.parks, 'rgba(40,110,64,0.45)', 'rgba(80,170,110,0.5)');
  if (layers.buildings) fillPolys(ctx, v, m.scene.buildings, '#232830', '#3a424d');
  if (layers.gob) fillPolys(ctx, v, m.scene.gobBuildings, GOB_FILL, GOB_STROKE);
  if (layers.landmarks) {
    ctx.fillStyle = 'rgba(255,159,28,0.25)';
    ctx.strokeStyle = '#ff9f1c';
    ctx.lineWidth = 2;
    ctx.font = '600 12px "Be Vietnam Pro", system-ui, sans-serif';
    for (const lm of m.scene.landmarks) {
      ctx.beginPath();
      tracePoly(ctx, v, lm.pts, true);
      ctx.fill();
      ctx.stroke();
      const [sx, sy] = v.toScreen(lm.cx, lm.cz);
      ctx.fillStyle = '#ffd08a';
      ctx.fillText(lm.name || lm.key, sx + 6, sy);
      ctx.fillStyle = 'rgba(255,159,28,0.25)';
    }
  }

  if (layers.raw) {
    for (const kept of [false, true]) {
      ctx.beginPath();
      ctx.setLineDash(kept ? [] : [4, 4]);
      ctx.strokeStyle = kept ? 'rgba(210,220,235,0.35)' : 'rgba(255,90,90,0.65)';
      ctx.lineWidth = 1;
      for (const w of m.raw.ways) if (w.kept === kept) tracePoly(ctx, v, w.pts, false);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  if (layers.bounds) {
    const b = m.net.bounds;
    const [x0, y0] = v.toScreen(b.minX, b.minZ);
    const [x1, y1] = v.toScreen(b.maxX, b.maxZ);
    ctx.strokeStyle = '#8892a0';
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([]);
  }

  if (layers.links) drawLinks(ctx, v, m, layers);
  if (layers.rings) drawRings(ctx, v, m);
  if (layers.arms || layers.clusters || layers.members) drawNodes(ctx, v, m, layers);
  if (layers.busStops) drawBusStops(ctx, v, m);
  if (layers.names) drawNames(ctx, v, m);
  if (layers.anomalies) {
    ctx.lineWidth = 2;
    for (const a of m.report.anomalies) {
      if (anomalyKind && a.kind !== anomalyKind) continue;
      const [sx, sy] = v.toScreen(a.x, a.z);
      if (sx < -20 || sy < -20 || sx > v.w + 20 || sy > v.h + 20) continue;
      ctx.strokeStyle = a.severity === 'warn' ? '#ff9f1c' : '#8d99ae';
      ctx.beginPath();
      ctx.arc(sx, sy, 10, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  for (const [sel, color] of [[hover, 'rgba(255,255,255,0.9)'], [selected, '#00f5d4']] as const) if (sel) drawSelection(ctx, v, m, sel, color);
  if (focus) {
    const age = (now - focus.t) / 1000;
    if (age < 3) {
      const [sx, sy] = v.toScreen(focus.x, focus.z);
      ctx.strokeStyle = `rgba(0,245,212,${1 - age / 3})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(sx, sy, 14 + ((age * 40) % 30), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  drawScaleBar(ctx, v);
}

function drawLinks(ctx: CanvasRenderingContext2D, v: View, m: Model, layers: Layers): void {
  for (const l of m.net.links) {
    if (!visible(v, m.linkBox[l.id])) continue;
    const width = Math.max(1.4, (l.lanesF + l.lanesB) * LANE_W * v.scale * 0.85);
    const sp: [number, number][] = [];
    for (let i = 0; i < l.pts.length; i += 2) sp.push(v.toScreen(l.pts[i], l.pts[i + 1]));
    ctx.beginPath();
    sp.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.strokeStyle = CLASS_COLOR[l.cls];
    ctx.globalAlpha = l.isLink ? 0.65 : 0.9;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (width > 4) {
      ctx.strokeStyle = 'rgba(16,19,23,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (layers.arrows && v.scale > 0.35) {
      ctx.beginPath();
      const size = Math.max(3, Math.min(7, width * 0.35));
      const spacing = Math.max(36, width * 3);
      if (l.lanesB === 0) chevrons(ctx, sp, spacing, size, 0);
      else {
        const off = Math.max(3, width / 4);
        chevrons(ctx, sp, spacing, size, off);
        chevrons(ctx, [...sp].reverse(), spacing, size, off);
      }
      ctx.strokeStyle = l.lanesB === 0 ? '#101317' : 'rgba(16,19,23,0.8)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }
}

function drawRings(ctx: CanvasRenderingContext2D, v: View, m: Model): void {
  for (const r of m.net.rings) {
    const sp: [number, number][] = [];
    for (let i = 0; i < r.pts.length; i += 2) sp.push(v.toScreen(r.pts[i], r.pts[i + 1]));
    ctx.beginPath();
    sp.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,212,170,0.12)';
    ctx.fill();
    ctx.strokeStyle = '#00d4aa';
    ctx.lineWidth = Math.max(2, r.lanes * LANE_W * v.scale);
    ctx.stroke();
    ctx.beginPath();
    chevrons(ctx, [...sp, sp[0]], Math.max(14, 22), 4, 0);
    ctx.strokeStyle = '#08332b';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = '#7ff5df';
    for (const a of r.arms) {
      const [sx, sy] = v.toScreen(r.pts[2 * a.at], r.pts[2 * a.at + 1]);
      ctx.beginPath();
      ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawNodes(ctx: CanvasRenderingContext2D, v: View, m: Model, layers: Layers): void {
  ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
  for (const n of m.net.nodes) {
    const [sx, sy] = v.toScreen(n.x, n.z);
    if (sx < -60 || sy < -60 || sx > v.w + 60 || sy > v.h + 60) continue;
    const rr = n.radius * v.scale;
    if (n.kind === 'junction' || n.kind === 'join') {
      const arms = m.arms[n.id];
      if (layers.arms && arms.length >= 3) {
        for (const a of arms) {
          const [x0, y0] = v.toScreen(a.start.x, a.start.z);
          const [x1, y1] = v.toScreen(a.tip.x, a.tip.z);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.strokeStyle = n.signal ? GROUP_COLOR[a.group] : a.major ? '#ffd166' : 'rgba(255,255,255,0.55)';
          ctx.lineWidth = a.major ? 4 : 2;
          ctx.globalAlpha = a.major || n.signal ? 0.95 : 0.7;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      if (layers.clusters) {
        if (n.kind === 'junction') {
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(5, rr), 0, Math.PI * 2);
          ctx.fillStyle = n.signal ? 'rgba(255,59,48,0.10)' : 'rgba(255,209,102,0.07)';
          ctx.fill();
          ctx.strokeStyle = n.signal ? '#ff3b30' : '#ffd166';
          ctx.lineWidth = n.signal ? 3 : 1.5;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = n.signal ? '#ff3b30' : '#ffd166';
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(sx, sy - 5);
          ctx.lineTo(sx + 5, sy);
          ctx.lineTo(sx, sy + 5);
          ctx.lineTo(sx - 5, sy);
          ctx.closePath();
          ctx.fillStyle = '#00e5ff';
          ctx.fill();
        }
        if (v.scale > 1.6) {
          ctx.fillStyle = '#e6ebf2';
          ctx.fillText(`#${n.id}`, sx + 7, sy - 7);
        }
      }
    } else if (layers.clusters) {
      if (n.kind === 'dead') {
        ctx.strokeStyle = '#ff4d4d';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(sx - 5, sy - 5);
        ctx.lineTo(sx + 5, sy + 5);
        ctx.moveTo(sx + 5, sy - 5);
        ctx.lineTo(sx - 5, sy + 5);
        ctx.stroke();
      } else if (n.kind === 'portal') {
        const arm = m.arms[n.id][0];
        const enters = arm?.outbound && !arm.inbound;
        const exits = arm?.inbound && !arm.outbound;
        ctx.fillStyle = enters ? '#2ecc71' : exits ? '#ff6b81' : '#ffd166';
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#101317';
        ctx.fillText(n.side ?? '', sx - 3.5, sy + 4);
        if (v.scale > 1.6) {
          ctx.fillStyle = '#e6ebf2';
          ctx.fillText(`#${n.id}${enters ? ' vào' : exits ? ' ra' : ' 2 chiều'}`, sx + 9, sy - 7);
        }
      }
    }
    if (layers.members && n.kind === 'junction') {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#101317';
      ctx.lineWidth = 1;
      for (const id of n.osm) {
        const p = m.raw.nodes.get(id);
        if (!p) continue;
        const [px, py] = v.toScreen(p.x, p.z);
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }
}

function drawBusStops(ctx: CanvasRenderingContext2D, v: View, m: Model): void {
  ctx.font = '600 11px "Be Vietnam Pro", system-ui, sans-serif';
  for (const b of m.net.busStops) {
    const l = m.net.links[b.link];
    const s = b.dir === 0 ? b.s : l.length - b.s;
    const p = pointAt(l.pts, s);
    // Right of travel in (x east, z south): (-dz, dx) for dir 0, mirrored for dir 1.
    const side = b.dir === 0 ? 1 : -1;
    const off = ((l.lanesF + l.lanesB) * LANE_W) / 2 + 3;
    const [sx, sy] = v.toScreen(p.x + -p.dz * off * side, p.z + p.dx * off * side);
    ctx.fillStyle = '#3b82f6';
    ctx.strokeStyle = '#dbeafe';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(sx - 5, sy - 5, 10, 10, 2);
    ctx.fill();
    ctx.stroke();
    if (v.scale > 2 && b.name) {
      ctx.fillStyle = '#bcd7ff';
      ctx.fillText(b.name, sx + 8, sy + 4);
    }
  }
}

function drawNames(ctx: CanvasRenderingContext2D, v: View, m: Model): void {
  if (v.scale < 0.9) return;
  ctx.font = '600 11px "Be Vietnam Pro", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(16,19,23,0.9)';
  ctx.fillStyle = '#eef2f8';
  for (const l of m.net.links) {
    if (!l.name || !visible(v, m.linkBox[l.id])) continue;
    const w = ctx.measureText(l.name).width;
    if (l.length * v.scale < w + 16) continue;
    const p = pointAt(l.pts, l.length / 2);
    const [sx, sy] = v.toScreen(p.x, p.z);
    let ang = Math.atan2(p.dz, p.dx);
    if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(ang);
    ctx.strokeText(l.name, 0, 0);
    ctx.fillText(l.name, 0, 0);
    ctx.restore();
  }
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
}

function drawSelection(ctx: CanvasRenderingContext2D, v: View, m: Model, sel: Selection, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.95;
  if (sel.kind === 'link') {
    const l = m.net.links[sel.id];
    ctx.beginPath();
    tracePoly(ctx, v, l.pts, false);
    ctx.lineWidth = Math.max(3, (l.lanesF + l.lanesB) * LANE_W * v.scale + 4);
    ctx.globalAlpha = 0.45;
    ctx.stroke();
    for (const nid of [l.a, l.b]) {
      const n = m.net.nodes[nid];
      const [sx, sy] = v.toScreen(n.x, n.z);
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(8, n.radius * v.scale + 3), 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (sel.kind === 'node') {
    const n = m.net.nodes[sel.id];
    const [sx, sy] = v.toScreen(n.x, n.z);
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(10, n.radius * v.scale + 4), 0, Math.PI * 2);
    ctx.stroke();
    for (const lid of m.nodeLinks[n.id]) {
      ctx.beginPath();
      tracePoly(ctx, v, m.net.links[lid].pts, false);
      ctx.lineWidth = 6;
      ctx.globalAlpha = 0.25;
      ctx.stroke();
    }
  } else if (sel.kind === 'rawWay') {
    const w = m.raw.ways.find(r => r.id === sel.id);
    if (w) {
      ctx.beginPath();
      tracePoly(ctx, v, w.pts, false);
      ctx.lineWidth = 5;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
    }
  } else if (sel.pts) {
    ctx.beginPath();
    tracePoly(ctx, v, sel.pts, true);
    ctx.lineWidth = 2.5;
    ctx.stroke();
  } else {
    const [sx, sy] = v.toScreen(sel.x, sel.z);
    ctx.beginPath();
    ctx.arc(sx, sy, 12, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

export function drawScaleBar(ctx: CanvasRenderingContext2D, v: View): void {
  const target = 120 / v.scale;
  const step = [10, 20, 50, 100, 200, 500, 1000].find(s => s >= target) ?? 1000;
  const px = step * v.scale;
  const x = 16;
  const y = v.h - 18;
  ctx.strokeStyle = '#e6ebf2';
  ctx.fillStyle = '#e6ebf2';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.lineTo(x + px, y - 4);
  ctx.stroke();
  ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText(`${step} m`, x + px + 8, y);
}

/** Footprint (smallest area wins on overlap) containing a world point; bbox-rejects before the ray cast. */
function pickGob(m: Model, w: Pt): Selection | null {
  let best: Selection | null = null;
  let bestArea = Infinity;
  for (const g of m.scene.gobBuildings) {
    const p = g.pts;
    const b = polyBounds(p);
    if (w.x < b.minX || w.x > b.maxX || w.z < b.minZ || w.z > b.maxZ) continue;
    let inside = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      if (p[i + 1] > w.z !== p[j + 1] > w.z && w.x < ((p[j] - p[i]) * (w.z - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) inside = !inside;
    }
    const area = (b.maxX - b.minX) * (b.maxZ - b.minZ);
    if (inside && area < bestArea) {
      bestArea = area;
      best = gobSelection(g);
    }
  }
  return best;
}

/** Nearest node or link under a screen point (nodes win over links); otherwise a visible Google footprint. */
export function pick(v: View, m: Model, layers: Layers, sx: number, sy: number): Selection | null {
  const w = v.toWorld(sx, sy);
  const px = 1 / v.scale;
  let best: Selection | null = null;
  let bestD = Infinity;
  for (const n of m.net.nodes) {
    const d = Math.hypot(n.x - w.x, n.z - w.z);
    const reach = n.kind === 'junction' || n.kind === 'ring' ? Math.max(n.radius, 8 * px) : 9 * px;
    if (d <= reach && d / reach < bestD) {
      bestD = d / reach;
      best = { kind: 'node', id: n.id };
    }
  }
  if (best) return best;
  bestD = Infinity;
  for (const l of m.net.links) {
    const b = m.linkBox[l.id];
    const slack = Math.max(8 * px, ((l.lanesF + l.lanesB) * LANE_W) / 2);
    if (w.x < b.minX - slack || w.x > b.maxX + slack || w.z < b.minZ - slack || w.z > b.maxZ + slack) continue;
    for (let i = 2; i < l.pts.length; i += 2) {
      const ax = l.pts[i - 2];
      const az = l.pts[i - 1];
      const dx = l.pts[i] - ax;
      const dz = l.pts[i + 1] - az;
      const len2 = dx * dx + dz * dz;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((w.x - ax) * dx + (w.z - az) * dz) / len2));
      const d = Math.hypot(w.x - (ax + t * dx), w.z - (az + t * dz));
      if (d <= slack && d < bestD) {
        bestD = d;
        best = { kind: 'link', id: l.id };
      }
    }
  }
  return best ?? (layers.gob ? pickGob(m, w) : null);
}
