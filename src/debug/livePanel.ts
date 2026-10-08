/**
 * "Mô phỏng sống" mode of the debug page: side panel (controls, KPI, layers, vehicle / junction cards) and the
 * per-frame loop glue between `LiveSim` and the canvas. Dev only.
 */
import { SegKind } from '../sim/network';
import type { VType } from '../sim/vehicleTypes';
import type { Junction, Segment } from '../sim/network';
import { Light } from '../sim/signals';
import { SPECS } from '../sim/vehicleTypes';
import { h } from './dom';
import type { View } from './draw';
import { DEFAULT_TARGET, LiveSim, MAX_TARGET, REASON_COUNT, SPEEDS } from './live';
import type { JunctionLoad } from './live';
import { BaseCache, DEFAULT_LIVE_LAYERS, LIGHT_COLOR, LIGHT_LABEL, LIVE_LAYER_LABELS, REASON_COLOR, REASON_LABEL, TYPE_COLOR, drawLive, pickLive } from './liveDraw';
import type { LiveLayers, LiveSelection } from './liveDraw';
import type { Model } from './model';

const PANEL_INTERVAL_MS = 250;
const SEG_KIND_LABEL: Record<number, string> = {
  [SegKind.Link]: 'đoạn đường',
  [SegKind.Conn]: 'đường nối trong giao lộ',
  [SegKind.Ring]: 'vòng xoay',
};
const COMPASS = ['Bắc', 'Đông Bắc', 'Đông', 'Đông Nam', 'Nam', 'Tây Nam', 'Tây', 'Tây Bắc'];

const hhmm = (hour: number): string => {
  const m = Math.floor(hour * 60 + 0.5) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** Compass name of a heading in world axes (x east, z south). */
function compass(angle: number): string {
  const bearing = (Math.atan2(Math.cos(angle), -Math.sin(angle)) * 180) / Math.PI;
  return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

function row(label: string, value: string | Node): HTMLElement {
  return h('div', {}, h('dt', {}, label), h('dd', {}, value));
}

export class LiveMode {
  readonly el = h('div', { className: 'live' });
  private sim: LiveSim | null = null;
  private readonly base = new BaseCache();
  private readonly layers: LiveLayers = { ...DEFAULT_LIVE_LAYERS };
  private sel: LiveSelection | null = null;
  private follow = false;
  private redraw = true;
  private lastNow = 0;
  private lastPanel = 0;
  private frameMs = 16;
  private drawMs = 0;
  private building = false;
  private pendingParams: URLSearchParams | null = null;

  private readonly kpiCells: Record<string, HTMLElement> = {};
  private info = h('div', { className: 'info' });
  private playBtn: HTMLButtonElement | null = null;
  private speedBtns: HTMLButtonElement[] = [];
  private hourInput: HTMLInputElement | null = null;
  private hourOut: HTMLElement | null = null;
  private targetInput: HTMLInputElement | null = null;
  private targetOut: HTMLElement | null = null;
  private autoInput: HTMLInputElement | null = null;
  private layerInputs = new Map<keyof LiveLayers, HTMLInputElement>();

  constructor(
    private readonly model: Model,
    private readonly view: View,
    private readonly markDirty: () => void,
  ) {
    this.el.append(h('p', { className: 'hint' }, 'Đang dựng mạng mô phỏng…'));
  }

  get ready(): boolean {
    return this.sim !== null;
  }

  /** Builds the sim on first use (deferred one tick so the "đang dựng" notice paints first). */
  activate(params: URLSearchParams | null): void {
    this.lastNow = 0;
    this.redraw = true;
    if (params) this.pendingParams = params;
    if (this.sim || this.building) return;
    this.building = true;
    setTimeout(() => {
      try {
        this.sim = new LiveSim(this.model.net);
        this.buildUi(this.sim);
        if (this.pendingParams) this.applyParams(this.pendingParams);
        this.pendingParams = null;
      } catch (err) {
        this.el.replaceChildren(h('p', { className: 'fatal' }, `Không dựng được mô phỏng: ${err instanceof Error ? err.message : String(err)}`));
        console.error(err);
      }
      this.building = false;
      this.markDirty();
    }, 30);
  }

  // ---- UI ------------------------------------------------------------------
  private btn(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = h('button', { type: 'button', className: 'btn', title }, label);
    b.addEventListener('click', onClick);
    return b;
  }

  private buildUi(sim: LiveSim): void {
    const net = sim.net;
    const ctl = h('fieldset', {}, h('legend', {}, 'Điều khiển'));
    this.playBtn = this.btn('⏸ Tạm dừng', 'Chạy / tạm dừng', () => {
      sim.playing = !sim.playing;
      this.syncControls();
    });
    const stepBtn = this.btn('⏭ 1 bước', 'Một bước 1/60 s', () => {
      sim.playing = false;
      sim.stepOnce();
      this.syncControls();
      this.refresh();
    });
    const resetBtn = this.btn('⟲ Khởi tạo lại', 'Dựng lại xe từ t = 0', () => {
      sim.reset();
      this.sel = null;
      this.syncControls();
      this.refresh();
    });
    this.speedBtns = SPEEDS.map(s =>
      this.btn(`×${s}`, `Tốc độ ×${s}`, () => {
        sim.speed = s;
        this.syncControls();
      }),
    );
    ctl.append(h('div', { className: 'btnrow' }, this.playBtn, stepBtn, resetBtn), h('div', { className: 'btnrow' }, ...this.speedBtns));

    this.hourInput = h('input', { type: 'range', min: '0', max: '24', step: '0.25', value: String(sim.hour) });
    this.hourOut = h('span', { className: 'val' });
    this.hourInput.addEventListener('input', () => {
      sim.setHour(Number(this.hourInput?.value));
      this.syncControls();
      this.refresh();
    });
    this.autoInput = h('input', { type: 'checkbox' });
    this.autoInput.addEventListener('change', () => {
      sim.autoTime = this.autoInput?.checked ?? false;
    });
    this.targetInput = h('input', { type: 'range', min: '0', max: String(MAX_TARGET), step: '50', value: String(sim.target) });
    this.targetOut = h('span', { className: 'val' });
    this.targetInput.addEventListener('input', () => {
      sim.target = Number(this.targetInput?.value);
      this.syncControls();
    });
    const follow = h('input', { type: 'checkbox' });
    follow.addEventListener('change', () => {
      this.follow = follow.checked;
      this.redraw = true;
    });
    ctl.append(
      h('label', { className: 'slider' }, 'Giờ ', this.hourOut, this.hourInput),
      h('label', {}, this.autoInput, ' Tự chạy giờ (1 phút game / giây sim)'),
      h('label', { className: 'slider' }, 'Số xe mục tiêu ', this.targetOut, this.targetInput),
      h('label', {}, follow, ' Camera bám theo xe đang chọn'),
      h('p', { className: 'hint' }, `Bước cố định ${(1000 / 60).toFixed(2)} ms như src/main.ts · đèn chuyển vàng nhấp nháy từ 23 h đến 5 h.`),
    );

    const kpi = h('fieldset', {}, h('legend', {}, 'Chỉ số'));
    const dl = h('dl', { className: 'kpi' });
    const kpiRows: [string, string][] = [
      ['time', 'Thời gian sim'],
      ['count', 'Số xe'],
      ['speed', 'Tốc độ TB'],
      ['waiting', 'Đang đứng (< 0,5 m/s)'],
      ['stuck', 'Đứng > 60 s'],
      ['cong', 'Tắc nghẽn'],
      ['reason', 'Lý do (tự do · theo · nhường · đèn · đón)'],
      ['step', 'Bước sim (TB · đỉnh)'],
      ['frame', 'Khung hình (TB)'],
    ];
    for (const [key, label] of kpiRows) {
      const dd = h('dd');
      this.kpiCells[key] = dd;
      dl.append(h('div', {}, h('dt', {}, label), dd));
    }
    kpi.append(dl);

    const layerBox = h('fieldset', {}, h('legend', {}, 'Lớp hiển thị'));
    for (const key of Object.keys(LIVE_LAYER_LABELS) as (keyof LiveLayers)[]) {
      const input = h('input', { type: 'checkbox', checked: this.layers[key] });
      input.addEventListener('change', () => {
        this.layers[key] = input.checked;
        this.redraw = true;
        this.markDirty();
      });
      this.layerInputs.set(key, input);
      layerBox.append(h('label', {}, input, ` ${LIVE_LAYER_LABELS[key]}`));
    }
    const swatch = (label: string, color: string, ring = false): HTMLSpanElement => {
      const s = h('span', { className: ring ? 'ring' : '' }, label);
      s.style.setProperty('--c', color);
      return s;
    };
    const legend = h('div', { className: 'legend' });
    for (const [t, spec] of SPECS.entries()) legend.append(swatch(spec.label, TYPE_COLOR[t as VType]));
    const legend2 = h('div', { className: 'legend' });
    for (let r = 0; r < REASON_COUNT + 1; r++) legend2.append(swatch(`viền: ${REASON_LABEL[r]}`, REASON_COLOR[r], true));
    const legend3 = h('div', { className: 'legend' });
    for (const light of [Light.Green, Light.Amber, Light.Red, Light.Flash]) legend3.append(swatch(`vạch: ${LIGHT_LABEL[light]}`, LIGHT_COLOR[light]));
    layerBox.append(legend, legend2, legend3);

    const selBox = h('fieldset', {}, h('legend', {}, 'Chọn (bấm xe hoặc giao lộ)'), this.info);

    const warn = net.warnings.length
      ? h('details', {}, h('summary', {}, `Cảnh báo dựng mạng (${net.warnings.length})`), h('ul', { className: 'anomalies' }, ...net.warnings.map(w => h('li', { className: 'hint' }, w))))
      : h('p', { className: 'hint' }, 'Dựng mạng không có cảnh báo.');

    this.el.replaceChildren(
      h('p', { className: 'stats' }, `${net.segments.length} đoạn · ${net.links.length} link có hướng · ${net.junctions.length} nút · ${net.signalJunctions.length} giao lộ đèn · ${net.rings.length} vòng xoay · ${net.portalsIn.length} cổng vào`),
      ctl,
      kpi,
      selBox,
      layerBox,
      warn,
    );
    this.syncControls();
    this.refresh();
  }

  private syncControls(): void {
    const sim = this.sim;
    if (!sim) return;
    if (this.playBtn) this.playBtn.textContent = sim.playing ? '⏸ Tạm dừng' : '▶ Chạy';
    this.speedBtns.forEach((b, i) => b.classList.toggle('on', SPEEDS[i] === sim.speed));
    if (this.hourOut) this.hourOut.textContent = hhmm(sim.hour);
    if (this.hourInput && !sim.autoTime) this.hourInput.value = String(sim.hour);
    if (this.targetOut) this.targetOut.textContent = `${sim.target} (mặc định ${DEFAULT_TARGET})`;
    this.redraw = true;
    this.markDirty();
  }

  /** `#mode=live&hour=8&target=2000&speed=4&play=0&live=heat&liveoff=vehicles`. */
  private applyParams(p: URLSearchParams): void {
    const sim = this.sim;
    if (!sim) return;
    const num = (k: string): number | null => (p.has(k) && Number.isFinite(Number(p.get(k))) ? Number(p.get(k)) : null);
    const hour = num('hour');
    if (hour !== null) sim.setHour(hour);
    const target = num('target');
    if (target !== null) {
      sim.target = Math.max(0, Math.min(MAX_TARGET, Math.round(target)));
      if (this.targetInput) this.targetInput.value = String(sim.target);
      sim.reset();
    }
    const speed = num('speed');
    const match = SPEEDS.find(s => s === speed);
    if (match) sim.speed = match;
    if (p.get('play') === '0') sim.playing = false;
    for (const [param, on] of [['live', true], ['liveoff', false]] as const) {
      for (const key of (p.get(param) ?? '').split(',').filter(Boolean)) {
        if (key in this.layers) {
          this.layers[key as keyof LiveLayers] = on;
          const box = this.layerInputs.get(key as keyof LiveLayers);
          if (box) box.checked = on;
        }
      }
    }
    this.syncControls();
    this.refresh();
  }

  // ---- per frame ---------------------------------------------------------------
  frame(now: number, ctx: CanvasRenderingContext2D, viewDirty: boolean): void {
    const sim = this.sim;
    if (!sim) return;
    const dt = this.lastNow ? (now - this.lastNow) / 1000 : 0;
    this.lastNow = now;
    if (dt > 0) this.frameMs += (dt * 1000 - this.frameMs) * 0.05;
    const steps = sim.advance(dt);
    const followed = this.follow && this.sel?.kind === 'vehicle' ? sim.traffic.indexOf(this.sel.uid) : -1;
    if (followed >= 0) {
      this.view.cx = sim.traffic.x[followed];
      this.view.cz = sim.traffic.z[followed];
    }
    if (steps > 0 || viewDirty || this.redraw || followed >= 0) {
      this.redraw = false;
      const t0 = performance.now();
      sim.scanVehicles();
      const base = this.base.render(this.model, this.view, this.layers);
      drawLive(ctx, this.view, base, sim, this.layers, this.sel);
      this.drawMs += (performance.now() - t0 - this.drawMs) * 0.05;
    }
    if (now - this.lastPanel >= PANEL_INTERVAL_MS) {
      this.lastPanel = now;
      this.refresh();
    }
  }

  click(sx: number, sy: number): void {
    const sim = this.sim;
    if (!sim) return;
    this.sel = pickLive(this.view, sim, sx, sy);
    this.refresh();
    this.redraw = true;
    this.markDirty();
  }

  clearSelection(): void {
    this.sel = null;
    this.refresh();
    this.redraw = true;
    this.markDirty();
  }

  /** Updates the KPI block and the selection card. */
  private refresh(): void {
    const sim = this.sim;
    if (!sim) return;
    const k = sim.traffic.kpi(sim.kpi);
    const sc = sim.scan;
    sim.scanVehicles();
    this.kpiCells.time.textContent = `${Math.floor(sim.simTime / 60)} phút ${Math.floor(sim.simTime % 60)} s · giờ ${hhmm(sim.hour)} · bước ${sim.stepCount}`;
    this.kpiCells.count.textContent = `${k.count} / mục tiêu ${sim.target}`;
    this.kpiCells.speed.textContent = `${k.avgKmh.toFixed(1)} km/h`;
    this.kpiCells.waiting.textContent = `${k.waiting} (${k.count ? Math.round((100 * k.waiting) / k.count) : 0}%)`;
    this.kpiCells.stuck.textContent = String(sc.stuck);
    this.kpiCells.cong.textContent = `${k.congestion.toFixed(0)}%`;
    this.kpiCells.reason.textContent = `${sc.reasons.join(' · ')}${sc.crashed ? ` · ${sc.crashed} va chạm` : ''}`;
    this.kpiCells.step.textContent = `${sim.stepMs.toFixed(2)} ms · ${sim.stepMsPeak.toFixed(1)} ms`;
    this.kpiCells.frame.textContent = `${this.frameMs.toFixed(1)} ms (${(1000 / this.frameMs).toFixed(0)} fps) · vẽ ${this.drawMs.toFixed(1)} ms`;
    this.renderInfo(sim);
  }

  private renderInfo(sim: LiveSim): void {
    this.info.replaceChildren();
    const sel = this.sel;
    if (!sel) {
      this.info.append(h('p', { className: 'hint' }, 'Bấm một xe để xem thẻ xe, hoặc bấm vào giao lộ / vòng xoay để xem nhánh, pha đèn, quyền ưu tiên và hàng chờ. Esc để bỏ chọn.'));
      return;
    }
    if (sel.kind === 'vehicle') {
      const i = sim.traffic.indexOf(sel.uid);
      const d = i >= 0 ? sim.traffic.describe(i) : null;
      if (!d) {
        this.info.append(h('p', { className: 'hint' }, `Xe #${sel.uid} đã rời mạng.`));
        return;
      }
      const tr = sim.traffic;
      const sg = tr.segs[tr.seg[i]];
      const dl = h('dl');
      dl.append(
        row('Xe', `#${d.uid} · ${d.label}`),
        row('Biển số', d.plate),
        row('Mẫu xe', d.model),
        row('Tài xế', `${d.driver} · ${d.temper}`),
        row('Tốc độ', `${d.kmh.toFixed(1)} km/h (mong muốn ${d.wantKmh.toFixed(0)})`),
        row('Trạng thái', d.status),
        row('Lý do hãm', tr.crashed[i] ? REASON_LABEL[5] : REASON_LABEL[tr.reason[i]]),
        row('Đứng yên', `${tr.stopT[i].toFixed(0)} s liên tục`),
        row('Đang ở', `${d.street || '—'} · ${SEG_KIND_LABEL[sg.kind]} #${sg.id} (${tr.s[i].toFixed(0)}/${sg.length.toFixed(0)} m, lệch ${tr.l[i].toFixed(1)} m)`),
        row('Kế tiếp', d.next || '—'),
        row('Tuổi / quãng đường', `${d.age.toFixed(0)} s · ${d.distKm.toFixed(2)} km`),
      );
      this.info.append(dl);
      return;
    }
    const j = sim.net.junctions[sel.id];
    this.info.append(this.describeJunction(sim, j, sim.junctionLoad(j)));
  }

  private describeJunction(sim: LiveSim, j: Junction, load: JunctionLoad): HTMLElement {
    const dl = h('dl');
    dl.append(row('Nút', `#${j.id} · ${j.kind === 'ring' ? 'vòng xoay' : 'giao lộ'} · ${j.name || '—'}`), row('Toạ độ', `x ${j.x.toFixed(0)}, z ${j.z.toFixed(0)} · bán kính ${j.radius.toFixed(0)} m · ${j.arms.length} nhánh`));
    const groupName = ['A', 'B'];
    if (j.signal) {
      const p = j.signal;
      const states = [0, 1].map(g => {
        const q = sim.signals.query(p.index, g, sim.simTime);
        return `${groupName[g]}: ${LIGHT_LABEL[q.light]}${q.light === Light.Flash ? '' : ` ${Math.ceil(q.remaining)} s`}`;
      });
      dl.append(row('Đèn', `chu kỳ ${p.cycle} s · xanh A ${p.green[0]} s / B ${p.green[1]} s · lệch ${p.offset} s`), row('Hiện tại', states.join(' · ')));
    } else {
      dl.append(row('Đèn', 'không đèn'));
      const major = j.majorArms.length ? j.majorArms.map(k => `#${k} ${j.arms[k].name || '—'}`).join(', ') : 'không có';
      dl.append(row('Trục ưu tiên', major));
    }
    if (j.ring >= 0) {
      const r = sim.net.rings[j.ring];
      dl.append(row('Vòng xoay', `${r.name || '—'} · bán kính ${r.r.toFixed(1)} m · ${r.arms.length} nhánh · ${r.exits.length} lối ra`));
    }
    dl.append(row('Trong nút', `${load.inside} xe (${load.insideStanding} đứng)`));
    const table = h('table', {}, h('tr', {}, ...['#', 'tên · hướng', 'vào/ra', 'pha', 'quyền / đèn', 'hàng chờ'].map(t => h('th', {}, t))));
    j.arms.forEach((arm, k) => {
      const inL = arm.inLink;
      const outL = arm.outLink;
      let rule = '—';
      let phase = '—';
      if (inL?.signal) {
        const q = sim.signals.query(inL.signal.nodeIndex, inL.signal.group, sim.simTime);
        rule = `${LIGHT_LABEL[q.light]}${q.light === Light.Flash ? '' : ` ${Math.ceil(q.remaining)} s`}`;
        phase = groupName[inL.signal.group];
      } else if (inL) {
        const prio = Math.max(0, ...inL.next.map((c: Segment) => c.priority));
        rule = j.ring >= 0 ? 'nhường vòng xoay' : prio >= 2 ? '★ ưu tiên' : prio === 1 ? 'nhường' : 'tự do';
      }
      const q = load.arms[k];
      const queue = inL ? `${q.standing}/${q.vehicles} xe · ${q.queueM.toFixed(0)} m` : '—';
      const lanes = `${inL ? inL.lanes : '–'}/${outL ? outL.lanes : '–'}`;
      table.append(h('tr', {}, h('td', {}, String(k)), h('td', {}, `${arm.name || '—'} · ${compass(arm.angle)}`), h('td', {}, lanes), h('td', {}, phase), h('td', {}, rule), h('td', {}, queue)));
    });
    dl.append(row('Nhánh (vào/ra = số làn)', table));
    return dl;
  }
}
