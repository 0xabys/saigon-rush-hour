/**
 * Dev-only 2D debug page for the OSM pipeline output (served at /debug.html by `npm run debug`).
 * Two modes: "Lớp tĩnh (P1)" — pan/zoom, layer toggles, hover/click info, OSM-id search and the build-report anomaly list;
 * "Mô phỏng sống (P2)" — the real `Traffic` running on the OSM network (see livePanel.ts). Deep link: `#mode=live&hour=8&target=2000&speed=4`.
 */
import './debug.css';
import { h } from './dom';
import { CLASS_COLOR, View, draw, pick } from './draw';
import type { Focus, Layers } from './draw';
import { LiveMode } from './livePanel';
import { loadModel } from './model';
import type { Model, Selection } from './model';

const model: Model = loadModel();
const { net, report } = model;

function setMode(next: 'static' | 'live', launch: URLSearchParams | null): void {
  mode = next;
  staticBox.hidden = next !== 'static';
  liveMode.el.hidden = next !== 'live';
  for (const [key, tab] of Object.entries(tabs)) {
    tab.classList.toggle('on', key === next);
    tab.setAttribute('aria-selected', String(key === next));
  }
  if (next === 'live') liveMode.activate(launch);
  dirty = true;
}

const LAYER_LABELS: Record<keyof Layers, string> = {
  links: 'Liên kết (màu theo cấp đường, nét theo số làn)',
  names: 'Tên đường (khi phóng to)',
  arrows: 'Mũi tên chiều đi',
  clusters: 'Cụm giao lộ / nút',
  members: 'Nút OSM thành viên cụm',
  arms: 'Nhánh giao lộ (chính tô đậm, màu theo pha đèn)',
  rings: 'Vòng xoay',
  busStops: 'Trạm buýt',
  anomalies: 'Bất thường trong báo cáo',
  raw: 'Way OSM thô (đỏ nét đứt = bị loại/cắt)',
  buildings: 'Toà nhà',
  gob: 'Toà nhà Google (id âm, conf khi rê chuột)',
  water: 'Mặt nước',
  parks: 'Công viên',
  landmarks: 'Địa danh',
  bounds: 'Khung bbox',
};

const layers: Layers = {
  links: true,
  names: true,
  arrows: true,
  clusters: true,
  members: true,
  arms: true,
  rings: true,
  busStops: true,
  anomalies: false,
  raw: true,
  buildings: false,
  gob: false,
  water: false,
  parks: false,
  landmarks: false,
  bounds: true,
};

const view = new View();
let hover: Selection | null = null;
let selected: Selection | null = null;
let focus: Focus | null = null;
let anomalyKind = '';
let dirty = true;

// ---- DOM ----------------------------------------------------------------
const canvas = h('canvas', { className: 'map' });
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const coords = h('div', { className: 'coords' });
const panel = h('aside', { className: 'panel' });
const root = document.getElementById('app') as HTMLElement;
const mapAttrib = h('div', { className: 'map-attrib' }, '');
mapAttrib.append(
  h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, net.source.attribution),
  ' · ',
  h('a', { href: 'https://sites.research.google/gr/open-buildings/', target: '_blank', rel: 'noopener' }, 'Google Open Buildings'),
  ' · ODbL',
);
root.append(canvas, coords, mapAttrib, panel);

const s = net.stats;
const staticBox = h('div', { className: 'mode-box' });
const liveMode = new LiveMode(model, view, () => {
  dirty = true;
});
liveMode.el.hidden = true;
let mode: 'static' | 'live' = 'static';
const tabs: Record<'static' | 'live', HTMLButtonElement> = {
  static: h('button', { type: 'button', className: 'tab on', role: 'tab' }, 'Lớp tĩnh (P1)'),
  live: h('button', { type: 'button', className: 'tab', role: 'tab' }, 'Mô phỏng sống (P2)'),
};
tabs.static.addEventListener('click', () => setMode('static', null));
tabs.live.addEventListener('click', () => setMode('live', null));
panel.append(
  h('h1', {}, 'Gỡ lỗi mạng đường OSM · Quận 1'),
  h('p', { className: 'sub' }, `${net.source.builder} · OSM ${net.source.osmBase.slice(0, 10)} · bbox ${net.source.bbox.join(', ')}`),
  h('div', { className: 'tabs', role: 'tablist' }, tabs.static, tabs.live),
  staticBox,
  liveMode.el,
);
staticBox.append(
  h(
    'p',
    { className: 'stats' },
    `${s.junctions} giao lộ (${s.signalNodes} có đèn) · ${s.joins} nút nối · ${s.portals} cổng biên · ${s.deadEnds} cụt · ${s.rings} vòng xoay · ${s.links} liên kết (${(s.linkMetres / 1000).toFixed(1)} km) · ${report.streets.count} tên phố · ${s.busStops} trạm buýt`,
  ),
);
if (report.fatal.length) panel.append(h('p', { className: 'fatal' }, `Lỗi nghiêm trọng: ${report.fatal.join('; ')}`));

// Layers
const layerBox = h('fieldset', {}, h('legend', {}, 'Lớp hiển thị'));
const layerInputs = new Map<keyof Layers, HTMLInputElement>();
for (const key of Object.keys(LAYER_LABELS) as (keyof Layers)[]) {
  const input = h('input', { type: 'checkbox', checked: layers[key] });
  layerInputs.set(key, input);
  input.addEventListener('change', () => {
    layers[key] = input.checked;
    dirty = true;
  });
  layerBox.append(h('label', {}, input, ` ${LAYER_LABELS[key]}`));
}
const legend = h('div', { className: 'legend' });
for (const [cls, color] of Object.entries(CLASS_COLOR)) {
  const swatch = h('span', {}, cls);
  swatch.style.setProperty('--c', color);
  legend.append(swatch);
}
layerBox.append(legend);
staticBox.append(layerBox);

// Search
const searchInput = h('input', { type: 'search', placeholder: 'OSM id (node / way / relation)…', inputMode: 'numeric' });
const searchOut = h('ul', { className: 'results' });
staticBox.append(h('fieldset', {}, h('legend', {}, 'Tìm theo OSM id'), searchInput, searchOut));

// Info
const info = h('div', { className: 'info' });
staticBox.append(h('fieldset', {}, h('legend', {}, 'Thông tin (rê chuột / bấm để ghim)'), info));

// Anomalies
const kindSelect = h('select', {}, h('option', { value: '' }, `Tất cả (${report.anomalies.length})`));
for (const [kind, n] of Object.entries(report.anomalyCounts)) kindSelect.append(h('option', { value: kind }, `${kind} (${n})`));
const anomalyList = h('ul', { className: 'anomalies' });
staticBox.append(h('fieldset', {}, h('legend', {}, 'Bất thường (bấm để nhảy tới)'), kindSelect, anomalyList));

panel.append(
  h(
    'p',
    { className: 'attrib' },
    '',
    h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, net.source.attribution),
    ' · ',
    h('a', { href: 'https://sites.research.google/gr/open-buildings/', target: '_blank', rel: 'noopener' }, 'Google Open Buildings'),
    ' · ODbL',
  ),
);

// ---- Interactions ----------------------------------------------------------
function jump(x: number, z: number, zoom = 3): void {
  view.cx = x;
  view.cz = z;
  view.scale = Math.max(view.scale, zoom);
  focus = { x, z, t: performance.now() };
  dirty = true;
}

function select(sel: Selection | null): void {
  selected = sel;
  renderInfo();
  dirty = true;
}

function osmLink(kind: 'way' | 'node', id: number): HTMLAnchorElement {
  return h('a', { href: `https://www.openstreetmap.org/${kind}/${id}`, target: '_blank', rel: 'noopener' }, String(id));
}

function row(label: string, value: string | Node | (string | Node)[]): HTMLElement {
  const dd = h('dd');
  for (const v of Array.isArray(value) ? value : [value]) dd.append(v);
  return h('div', {}, h('dt', {}, label), dd);
}

function osmList(kind: 'way' | 'node', ids: number[]): (string | Node)[] {
  return ids.flatMap((id, i) => (i ? [', ', osmLink(kind, id)] : [osmLink(kind, id)]));
}

function nodeButton(id: number): HTMLButtonElement {
  const n = net.nodes[id];
  const b = h('button', { className: 'chip', type: 'button' }, `#${id} ${n.name}`);
  b.addEventListener('click', () => {
    select({ kind: 'node', id });
    jump(n.x, n.z, view.scale);
  });
  return b;
}

function describeNode(id: number): HTMLElement {
  const n = net.nodes[id];
  const dl = h('dl');
  dl.append(
    row('Nút', `#${n.id} · ${n.kind}${n.side ? ` (${n.side})` : ''}`),
    row('Tên', n.name),
    row('Toạ độ', `x ${n.x}, z ${n.z} · bán kính ${n.radius} m`),
    row('Đèn', n.signal ? 'có (theo OSM traffic_signals)' : 'không'),
    row('Nút OSM', n.osm.length ? osmList('node', n.osm) : '—'),
  );
  if (n.ring !== undefined) {
    const r = net.rings[n.ring];
    dl.append(row('Vòng xoay', `#${r.id} · r ${r.r} m · ${r.lanes} làn · way ${r.osm.join(', ')}`));
  }
  const table = h('table', {}, h('tr', {}, ...['link', 'tên', 'chiều', 'làn', 'cấp', 'chính', 'pha'].map(t => h('th', {}, t))));
  for (const a of model.arms[id]) {
    const l = net.links[a.link];
    const flow = a.inbound && a.outbound ? '↔' : a.inbound ? 'vào' : 'ra';
    const lanes = a.end === 'a' ? `${l.lanesF}/${l.lanesB}` : `${l.lanesB}/${l.lanesF}`;
    const tr = h('tr', {}, h('td', {}, `#${l.id}`), h('td', {}, l.name || '—'), h('td', {}, flow), h('td', {}, lanes), h('td', {}, `${l.cls}${l.isLink ? '_link' : ''}`), h('td', {}, a.major ? '★' : ''), h('td', {}, a.group === 0 ? 'A' : 'B'));
    tr.addEventListener('click', () => select({ kind: 'link', id: l.id }));
    table.append(tr);
  }
  dl.append(row(`Nhánh (${model.arms[id].length})`, table));
  const near = report.anomalies.filter(a => Math.hypot(a.x - n.x, a.z - n.z) <= n.radius + 25);
  if (near.length) dl.append(row('Bất thường gần', near.map(a => `${a.kind}: ${a.message}`).join(' · ')));
  return dl;
}

function describeLink(id: number): HTMLElement {
  const l = net.links[id];
  const dl = h('dl');
  const bus = net.busStops.filter(b => b.link === id);
  dl.append(
    row('Liên kết', `#${l.id} · ${l.cls}${l.isLink ? '_link' : ''}${l.bridge ? ' · cầu' : ''}`),
    row('Tên', l.name ? `${l.name}${l.nameEn ? ` (${l.nameEn})` : ''}` : '— không tên'),
    row('Chiều', l.lanesB === 0 ? `một chiều ${l.a} → ${l.b}` : `hai chiều (dải phân cách ${l.median} m)`),
    row('Làn', `a→b ${l.lanesF}, b→a ${l.lanesB}`),
    row('Tốc độ tối đa', l.maxspeed === null ? 'không có tag' : `${l.maxspeed} km/h`),
    row('Dài', `${l.length} m · ${l.pts.length / 2} điểm`),
    row('Nút đầu a', nodeButton(l.a)),
    row('Nút cuối b', nodeButton(l.b)),
    row('Way OSM', osmList('way', l.osm)),
  );
  if (bus.length) dl.append(row('Trạm buýt', bus.map(b => `${b.name || 'không tên'} (hướng ${b.dir === 0 ? 'a→b' : 'b→a'}, s=${b.s} m)`).join('; ')));
  return dl;
}

function describe(sel: Selection): HTMLElement {
  if (sel.kind === 'node') return describeNode(sel.id);
  if (sel.kind === 'link') return describeLink(sel.id);
  if (sel.kind === 'rawWay') {
    const w = model.raw.ways.find(r => r.id === sel.id);
    const dl = h('dl');
    if (w) dl.append(row('Way OSM', osmLink('way', w.id)), row('Tên', w.name || '—'), row('highway', w.highway), row('Trong mạng', w.kept ? 'có' : 'không (bị lọc / cắt / tỉa)'));
    return dl;
  }
  return h('dl', {}, row('Điểm', sel.label));
}

function renderInfo(): void {
  info.replaceChildren();
  const sel = selected ?? hover;
  if (sel) info.append(describe(sel));
  else info.append(h('p', { className: 'hint' }, 'Rê chuột lên một nút hoặc liên kết. Kéo để di chuyển, lăn chuột để phóng to.'));
}

function runSearch(): void {
  searchOut.replaceChildren();
  const q = searchInput.value.trim().replace(/^(node|way|relation)[/\s]*/i, '');
  if (!/^-?\d+$/.test(q)) {
    if (q) searchOut.append(h('li', { className: 'hint' }, 'Nhập một số OSM id.'));
    return;
  }
  const hits = model.search.get(Number(q)) ?? [];
  if (!hits.length) searchOut.append(h('li', { className: 'hint' }, `Không thấy ${q} trong mạng, scene hay cache thô.`));
  for (const hit of hits) {
    const b = h('button', { type: 'button', className: 'chip' }, hit.label);
    b.addEventListener('click', () => {
      if (hit.target) select(hit.target);
      jump(hit.x, hit.z);
    });
    searchOut.append(h('li', {}, b));
  }
  if (hits.length === 1) {
    if (hits[0].target) select(hits[0].target);
    jump(hits[0].x, hits[0].z);
  }
}
searchInput.addEventListener('input', runSearch);

function renderAnomalies(): void {
  anomalyList.replaceChildren();
  report.anomalies.forEach(a => {
    if (anomalyKind && a.kind !== anomalyKind) return;
    const b = h('button', { type: 'button', className: `chip ${a.severity}` }, `${a.kind} · ${a.message} (${a.x}, ${a.z})${a.osm.length ? ` · osm ${a.osm.slice(0, 3).join(',')}` : ''}`);
    b.addEventListener('click', () => {
      layers.anomalies = true;
      const box = layerInputs.get('anomalies');
      if (box) box.checked = true;
      select({ kind: 'point', x: a.x, z: a.z, label: `${a.kind}: ${a.message}` });
      jump(a.x, a.z, 4);
    });
    anomalyList.append(h('li', {}, b));
  });
}
kindSelect.addEventListener('change', () => {
  anomalyKind = kindSelect.value;
  renderAnomalies();
  dirty = true;
});

// Canvas pan / zoom / pick
let drag: { x: number; y: number; cx: number; cz: number; moved: boolean } | null = null;
canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.offsetX, y: e.offsetY, cx: view.cx, cz: view.cz, moved: false };
});
canvas.addEventListener('pointermove', e => {
  const w = view.toWorld(e.offsetX, e.offsetY);
  const lat = net.projection.lat0 - w.z / net.projection.kz;
  const lon = net.projection.lon0 + w.x / net.projection.kx;
  coords.textContent = `x ${w.x.toFixed(1)}  z ${w.z.toFixed(1)}  ·  ${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  if (drag) {
    const dx = e.offsetX - drag.x;
    const dy = e.offsetY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) {
      view.cx = drag.cx - dx / view.scale;
      view.cz = drag.cz - dy / view.scale;
      dirty = true;
    }
    return;
  }
  if (mode === 'live') return;
  const next = pick(view, model, layers, e.offsetX, e.offsetY);
  if (JSON.stringify(next) !== JSON.stringify(hover)) {
    hover = next;
    if (!selected) renderInfo();
    dirty = true;
  }
});
canvas.addEventListener('pointerup', e => {
  if (drag && !drag.moved) {
    if (mode === 'live') liveMode.click(e.offsetX, e.offsetY);
    else select(pick(view, model, layers, e.offsetX, e.offsetY));
  }
  drag = null;
});
canvas.addEventListener(
  'wheel',
  e => {
    e.preventDefault();
    view.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015));
    dirty = true;
  },
  { passive: false },
);
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (mode === 'live') liveMode.clearSelection();
  else select(null);
});

function resize(): void {
  const r = canvas.getBoundingClientRect();
  view.dpr = window.devicePixelRatio || 1;
  view.w = r.width;
  view.h = r.height;
  canvas.width = Math.round(r.width * view.dpr);
  canvas.height = Math.round(r.height * view.dpr);
  dirty = true;
}
new ResizeObserver(resize).observe(canvas);
resize();

// Start view: whole bbox, or `#x=…&z=…&s=…&osm=…` for a deep link.
view.fit(net.bounds);
const params = new URLSearchParams(location.hash.slice(1));
if (params.has('x') && params.has('z')) {
  view.cx = Number(params.get('x'));
  view.cz = Number(params.get('z'));
  view.scale = Number(params.get('s') ?? 3);
}
for (const key of (params.get('layers') ?? '').split(',').filter(Boolean)) {
  if (key in layers) layers[key as keyof Layers] = true;
}
for (const key of (params.get('off') ?? '').split(',').filter(Boolean)) {
  if (key in layers) layers[key as keyof Layers] = false;
}
for (const [key, input] of layerInputs) input.checked = layers[key];
if (params.has('osm')) {
  searchInput.value = params.get('osm') ?? '';
  runSearch();
}

renderInfo();
renderAnomalies();
if (params.get('mode') === 'live') setMode('live', params);

function frame(now: number): void {
  if (mode === 'live') {
    liveMode.frame(now, ctx, dirty);
    dirty = false;
  } else if (dirty || (focus && now - focus.t < 3000)) {
    dirty = false;
    draw(ctx, view, model, layers, hover, selected, focus, anomalyKind, now);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
document.body.dataset.ready = '1';
