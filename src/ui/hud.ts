import type { CityEvent } from '../sim/events';
import type { RoadSeries } from '../sim/roadStats';
import { flashHours } from '../sim/signals';
import type { TrafficKpi, VehicleInfo } from '../sim/traffic';
import { MIX_GROUPS, VType } from '../sim/vehicleTypes';

export interface AppState {
  paused: boolean;
  speed: 1 | 2 | 4;
  hour: number;
  autoTime: boolean;
  /** 0.2–1 multiplier on the time-of-day demand curve. */
  density: number;
  rain: boolean;
  hudHidden: boolean;
}

export interface HudHandlers {
  setHour(h: number): void;
  setAutoTime(on: boolean): void;
  setDensity(d: number): void;
  setRain(on: boolean): void;
  setSpeed(s: 1 | 2 | 4): void;
  togglePause(): void;
  followRandom(): void;
  unfollow(): void;
  clearRoad(): void;
  toggleTimeMachine(): void;
  /** Offset in sim steps from the live moment (≤ 0). */
  seek(offset: number): void;
  resumeHere(): void;
  backToLive(): void;
}

export interface RoadView {
  name: string;
  span: string;
  liveKmh: number;
  liveDensity: number;
  liveCount: number;
  series: RoadSeries;
  hour: number;
}

export interface TimelineView {
  open: boolean;
  reviewing: boolean;
  /** Earliest reachable offset in steps (negative). */
  min: number;
  offset: number;
  clock: string;
}

const fmt1 = new Intl.NumberFormat('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmt2 = new Intl.NumberFormat('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = new Intl.NumberFormat('vi-VN');

export function formatHour(h: number): string {
  const total = Math.floor((((h % 24) + 24) % 24) * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function phaseOf(h: number): { label: string; rush: boolean } {
  if (h >= 7 && h < 9) return { label: 'Giờ cao điểm sáng', rush: true };
  if (h >= 17 && h < 19) return { label: 'Giờ cao điểm chiều', rush: true };
  if (flashHours(h)) return { label: 'Đèn vàng nhấp\u00a0nháy', rush: false };
  if (h < 5 || h >= 22) return { label: 'Đêm khuya', rush: false };
  if (h < 7) return { label: 'Bình minh', rush: false };
  if (h < 11) return { label: 'Buổi sáng', rush: false };
  if (h < 13) return { label: 'Buổi trưa', rush: false };
  if (h < 17) return { label: 'Buổi chiều', rush: false };
  return { label: 'Buổi tối', rush: false };
}

const ICON = {
  pause: '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="1.5" width="3" height="9" rx="1" fill="currentColor"/><rect x="7" y="1.5" width="3" height="9" rx="1" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.6v8.8L10.4 6z" fill="currentColor"/></svg>',
  target:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="8" cy="8" r="5.2"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/><path d="M8 0.8v2.4M8 12.8v2.4M0.8 8h2.4M12.8 8h2.4"/></svg>',
  close: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  rewind: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7.5 3.5v9L1.5 8zM14.5 3.5v9L8.5 8z" fill="currentColor"/></svg>',
  noRight:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#fbf6ea" stroke="#d9412b" stroke-width="2"/><path d="M6 12V7h4" stroke="#2a2118" stroke-width="1.6" fill="none"/><path d="M9.5 5l2.2 2-2.2 2z" fill="#2a2118"/><path d="M3.4 3.4l9.2 9.2" stroke="#d9412b" stroke-width="1.8"/></svg>',
};

const VEHICLE_ICON = {
  bike: '<svg viewBox="0 0 24 24" fill="none" stroke="#2a2118" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="16.5" r="3"/><circle cx="18.5" cy="16.5" r="3"/><path d="M8.5 16.5h6l2-6h-3M14.5 16.5l-3.5-6H8M16.5 10.5l1-3h2.5"/><circle cx="11" cy="5" r="1.6" fill="#d9412b" stroke="none"/></svg>',
  car: '<svg viewBox="0 0 24 24" fill="none" stroke="#2a2118" stroke-width="1.6" stroke-linejoin="round"><path d="M3 15v-3l2.5-4.5h11L19.5 12H21v3z"/><path d="M6.5 12h11"/><circle cx="7" cy="16" r="2" fill="#e9a23b"/><circle cx="17" cy="16" r="2" fill="#e9a23b"/></svg>',
  bus: '<svg viewBox="0 0 24 24" fill="none" stroke="#2a2118" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12.5" rx="2" fill="#2e9e5b33"/><path d="M3 10h18M8 4v6M13 4v6"/><circle cx="7" cy="18" r="1.8" fill="#2a2118"/><circle cx="17" cy="18" r="1.8" fill="#2a2118"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="#2a2118" stroke-width="1.6" stroke-linejoin="round"><rect x="2.5" y="5" width="12" height="10" rx="1" fill="#e98a2e33"/><path d="M14.5 8h4l3 4v3h-7z"/><circle cx="6.5" cy="17" r="1.8" fill="#2a2118"/><circle cx="17.5" cy="17" r="1.8" fill="#2a2118"/></svg>',
  cyclo: '<svg viewBox="0 0 24 24" fill="none" stroke="#2a2118" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="17" r="3"/><circle cx="6" cy="17" r="3"/><path d="M3.5 9.5h6v4.5H3.5z" fill="#c8463a44"/><path d="M9.5 14l4.5 3h4M14 17l1.5-7h2"/></svg>',
};

function iconFor(t: VType): string {
  if (t === VType.Moto || t === VType.Grab) return VEHICLE_ICON.bike;
  if (t === VType.Bus) return VEHICLE_ICON.bus;
  if (t === VType.Truck) return VEHICLE_ICON.truck;
  if (t === VType.Cyclo) return VEHICLE_ICON.cyclo;
  return VEHICLE_ICON.car;
}

const PRESETS: [number, string][] = [
  [6, 'Bình minh'],
  [7.5, 'Cao điểm sáng'],
  [12, 'Trưa'],
  [17.5, 'Cao điểm chiều'],
  [21, 'Đêm'],
  [23.5, 'Khuya'],
];

export class Hud {
  readonly root: HTMLElement;
  private readonly $: Record<string, HTMLElement>;
  private readonly speedHistory: number[] = [];
  private followUid = -1;
  private clockKey = '';

  constructor(
    parent: HTMLElement,
    private readonly state: AppState,
    h: HudHandlers,
  ) {
    const root = document.createElement('div');
    root.className = 'hud';
    root.innerHTML = `
      <div class="col-left">
        <header class="panel brand">
          <div class="brand-mark" aria-hidden="true"><i class="r"></i><i class="a"></i><i class="g"></i></div>
          <div>
            <h1>Sài Gòn</h1>
            <p>Giao thông Quận 1</p>
          </div>
          <div class="clock">
            <div class="time" data-ref="clock">17:00</div>
            <div class="phase" data-ref="phase">Buổi chiều</div>
          </div>
          <button class="controls-toggle" data-ref="controlsToggle" aria-expanded="false">Điều khiển ▾</button>
        </header>
        <section class="panel controls" aria-label="Điều khiển mô phỏng">
          <div class="section">
            <div class="label-row">
              <label class="label" for="tod">Thời gian trong ngày</label>
              <span class="value" data-ref="todValue">17:00</span>
            </div>
            <input id="tod" class="time-range" type="range" min="0" max="23.95" step="0.05" data-ref="tod" />
            <div class="rush-marks" aria-hidden="true">
              <span style="left:${(7 / 24) * 100}%;width:${(2 / 24) * 100}%"></span>
              <span style="left:${(17 / 24) * 100}%;width:${(2 / 24) * 100}%"></span>
              <em style="left:${(8 / 24) * 100}%">07–09</em>
              <em style="left:${(18 / 24) * 100}%">17–19</em>
            </div>
            <div class="chips" data-ref="presets">
              ${PRESETS.map(([hh, l]) => `<button class="chip" data-hour="${hh}">${l}</button>`).join('')}
              <button class="chip" data-ref="auto" aria-pressed="true">⟳ Giờ tự trôi</button>
            </div>
          </div>
          <div class="section">
            <div class="label-row">
              <label class="label" for="density">Mật độ giao thông</label>
              <span class="value" data-ref="densityValue">70%</span>
            </div>
            <input id="density" class="density-range" type="range" min="0.2" max="1" step="0.01" data-ref="density" />
          </div>
          <div class="section">
            <div class="switch-row">
              <div>
                <div class="label">Mưa rào</div>
                <div class="desc" data-ref="rainDesc">Trời khô ráo</div>
              </div>
              <button class="switch" role="switch" aria-checked="false" aria-label="Bật mưa" data-ref="rain"></button>
            </div>
          </div>
          <div class="section">
            <div class="label-row"><span class="label">Tốc độ mô phỏng</span><span class="value" data-ref="speedValue">×1</span></div>
            <div class="seg" role="group" aria-label="Tốc độ mô phỏng" data-ref="seg">
              <button class="pause" data-speed="0" aria-label="Tạm dừng">${ICON.pause}</button>
              <button data-speed="1">×1</button>
              <button data-speed="2">×2</button>
              <button data-speed="4">×4</button>
            </div>
          </div>
        </section>
      </div>
      <div class="col-right">
        <section class="panel kpi" aria-label="Chỉ số giao thông">
          <div class="kpi-head">
            <div class="tabs" role="tablist" data-ref="tabs">
              <button role="tab" data-tab="overview" aria-selected="true">Tổng quan</button>
              <button role="tab" data-tab="road" aria-selected="false">Tuyến đường</button>
            </div>
            <span class="live" data-ref="live"><i></i><span data-ref="liveText">Đang chạy</span></span>
          </div>
          <div class="tab-pane" data-ref="paneOverview" role="tabpanel">
          <div class="big-stat">
            <div>
              <span class="label">Tốc độ trung bình</span>
              <div class="n" data-ref="avg">0<small>km/h</small></div>
            </div>
            <svg class="spark" viewBox="0 0 120 44" preserveAspectRatio="none" aria-hidden="true">
              <defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9a23b" stop-opacity=".35"/><stop offset="1" stop-color="#e9a23b" stop-opacity="0"/></linearGradient></defs>
              <path data-ref="sparkArea" fill="url(#sparkFill)" d=""/>
              <path data-ref="sparkLine" fill="none" stroke="#d9412b" stroke-width="1.6" stroke-linejoin="round" d=""/>
            </svg>
          </div>
          <div class="stat-grid">
            <div class="stat"><span class="label">Xe trên bản đồ</span><div class="n" data-ref="count">0</div></div>
            <div class="stat"><span class="label">Đang dừng chờ</span><div class="n" data-ref="waiting">0</div></div>
            <div class="stat meter">
              <div class="label-row" style="margin:0"><span class="label">Mức ùn tắc</span><span class="value" data-ref="congValue">0%</span></div>
              <div class="meter-bar"><i data-ref="cong"></i></div>
              <div class="meter-scale"><span>Thông thoáng</span><span>Đông đúc</span><span>Kẹt cứng</span></div>
            </div>
          </div>
          <div class="mix">
            <span class="label">Cơ cấu phương tiện</span>
            <div class="mix-bar" data-ref="mixBar">${MIX_GROUPS.map((g) => `<span style="background:${g.color};width:0"></span>`).join('')}</div>
            <ul class="legend" data-ref="legend">
              ${MIX_GROUPS.map((g) => `<li><span class="dot" style="background:${g.color}"></span><span>${g.label}</span><span class="cnt">0</span><span class="pct">0%</span></li>`).join('')}
            </ul>
          </div>
          </div>
          <div class="tab-pane" data-ref="paneRoad" role="tabpanel" hidden>
            <div class="road-empty" data-ref="roadEmpty">
              <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M14 44L22 4h4l8 40" fill="none" stroke="#8a7a66" stroke-width="2.4" stroke-linejoin="round"/><path d="M24 10v5M24 21v5M24 32v5" stroke="#e9a23b" stroke-width="2.4" stroke-linecap="round"/><circle cx="36" cy="12" r="6" fill="#d9412b"/><circle cx="36" cy="12" r="2.2" fill="#fbf6ea"/></svg>
              <p>Nhấp vào một đoạn đường trên bản đồ để xem <b>mật độ</b> và <b>tốc độ trung bình theo giờ</b>.</p>
            </div>
            <div class="road-view" data-ref="roadView" hidden>
              <div class="road-head">
                <div><h3 data-ref="rName"></h3><p data-ref="rSpan"></p></div>
                <button class="close" data-ref="rClose" aria-label="Bỏ chọn đường">${ICON.close}</button>
              </div>
              <div class="stat-grid road-live">
                <div class="stat"><span class="label">Tốc độ hiện tại</span><div class="n" data-ref="rSpeed">0</div></div>
                <div class="stat"><span class="label">Mật độ hiện tại</span><div class="n" data-ref="rDensity">0</div></div>
              </div>
              <div class="chart-block">
                <div class="label-row"><span class="label">Tốc độ TB theo giờ</span><span class="value" data-ref="rSpeedNote"></span></div>
                <div class="bars" data-ref="rSpeedBars">${'<i></i>'.repeat(24)}</div>
              </div>
              <div class="chart-block">
                <div class="label-row"><span class="label">Mật độ theo giờ</span><span class="value"><small>xe/100 m</small></span></div>
                <div class="bars dens" data-ref="rDensBars">${'<i></i>'.repeat(24)}</div>
              </div>
              <div class="axis"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>24h</span></div>
              <p class="road-note">Dữ liệu được ghi lại khi đồng hồ chạy qua từng giờ; ô sọc là giờ chưa có số liệu.</p>
            </div>
          </div>
        </section>
        <section class="panel follow" data-ref="follow" hidden aria-live="polite">
          <div class="follow-head">
            <div class="follow-icon" data-ref="fIcon"></div>
            <div><h2 data-ref="fTitle">Xe máy</h2><p data-ref="fModel"></p></div>
            <button class="close" data-ref="fClose" aria-label="Bỏ theo dõi">${ICON.close}</button>
          </div>
          <span class="plate" data-ref="fPlate"></span>
          <div class="follow-speed"><span class="n" data-ref="fSpeed">0</span><small>km/h</small><span class="status" data-ref="fStatus"></span></div>
          <dl class="facts">
            <dt>Đang đi trên</dt><dd data-ref="fStreet"></dd>
            <dt>Sắp rẽ vào</dt><dd data-ref="fNext"></dd>
            <dt>Người lái</dt><dd data-ref="fDriver"></dd>
            <dt>Tính cách</dt><dd data-ref="fTemper"></dd>
            <dt>Tốc độ mong muốn</dt><dd class="num" data-ref="fWant"></dd>
            <dt>Thời gian trên phố</dt><dd class="num" data-ref="fAge"></dd>
            <dt>Quãng đường</dt><dd class="num" data-ref="fDist"></dd>
          </dl>
        </section>
      </div>
      <div class="events" data-ref="events" aria-live="polite"></div>
      <div class="bottom">
        <section class="panel timebar" data-ref="timebar" hidden aria-label="Cỗ máy thời gian">
          <div class="tb-head">
            <span class="tb-title">${ICON.rewind}Cỗ máy thời gian</span>
            <span class="tb-badge" data-ref="tbBadge">Trực tiếp</span>
            <button class="close" data-ref="tbClose" aria-label="Đóng cỗ máy thời gian">${ICON.close}</button>
          </div>
          <input class="tb-range" type="range" min="-3600" max="0" step="30" value="0" data-ref="tbRange" aria-label="Tua lại thời gian" />
          <div class="tb-row">
            <span class="tb-time num" data-ref="tbTime">17:00</span>
            <span class="tb-off" data-ref="tbOff">hiện tại</span>
            <span class="tb-actions">
              <button class="chip" data-ref="tbResume">▶ Tiếp tục từ đây</button>
              <button class="chip on" data-ref="tbLive">Về hiện tại</button>
            </span>
          </div>
        </section>
        <nav class="hints" aria-label="Hướng dẫn">
          <button class="btn" data-ref="followRandom">${ICON.target}Theo dõi một xe</button>
          <button class="btn ghost" data-ref="tmToggle">${ICON.rewind}Tua lại</button>
          <span class="hint mouse">Kéo chuột trái để xoay</span>
          <span class="hint mouse">Chuột phải để di chuyển</span>
          <span class="hint">Nhấp xe hoặc đường để xem</span>
          <span class="hint optional"><kbd>Space</kbd> dừng · <kbd>1</kbd><kbd>2</kbd><kbd>4</kbd> tốc độ · <kbd>R</kbd> mưa · <kbd>T</kbd> tua · <kbd>H</kbd> ẩn</span>
          <span class="hint optional sign-legend">${ICON.noRight}Cấm rẽ phải khi đèn đỏ</span>
        </nav>
      </div>
      <div class="tip" data-ref="tip" hidden></div>`;
    parent.appendChild(root);
    this.root = root;
    this.$ = {};
    root.querySelectorAll<HTMLElement>('[data-ref]').forEach((el) => (this.$[el.dataset.ref!] = el));

    const tod = this.$.tod as HTMLInputElement;
    tod.addEventListener('input', () => h.setHour(Number(tod.value)));
    this.$.presets.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!btn) return;
      if (btn.dataset.ref === 'auto') h.setAutoTime(!this.state.autoTime);
      else if (btn.dataset.hour) h.setHour(Number(btn.dataset.hour));
    });
    const density = this.$.density as HTMLInputElement;
    density.addEventListener('input', () => h.setDensity(Number(density.value)));
    this.$.rain.addEventListener('click', () => h.setRain(!this.state.rain));
    this.$.seg.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!btn) return;
      const s = Number(btn.dataset.speed);
      if (s === 0) h.togglePause();
      else h.setSpeed(s as 1 | 2 | 4);
    });
    this.$.followRandom.addEventListener('click', () => h.followRandom());
    this.$.tabs.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (btn?.dataset.tab) this.setTab(btn.dataset.tab as 'overview' | 'road');
    });
    this.$.rClose.addEventListener('click', () => h.clearRoad());
    this.$.tmToggle.addEventListener('click', () => h.toggleTimeMachine());
    this.$.tbClose.addEventListener('click', () => h.toggleTimeMachine());
    const tb = this.$.tbRange as HTMLInputElement;
    tb.addEventListener('input', () => h.seek(Number(tb.value)));
    this.$.tbResume.addEventListener('click', () => h.resumeHere());
    this.$.tbLive.addEventListener('click', () => h.backToLive());
    this.$.controlsToggle.addEventListener('click', () => {
      const open = root.classList.toggle('show-controls');
      this.$.controlsToggle.setAttribute('aria-expanded', String(open));
      this.$.controlsToggle.textContent = open ? 'Thu gọn ▴' : 'Điều khiển ▾';
    });
    this.$.fClose.addEventListener('click', () => h.unfollow());
    this.sync();
  }

  /** Reflect AppState into the controls. */
  sync(): void {
    const s = this.state;
    const tod = this.$.tod as HTMLInputElement;
    if (document.activeElement !== tod) tod.value = String(s.hour);
    this.$.todValue.textContent = formatHour(s.hour);
    (this.$.density as HTMLInputElement).value = String(s.density);
    this.$.densityValue.textContent = `${Math.round(s.density * 100)}%`;
    this.$.rain.setAttribute('aria-checked', String(s.rain));
    this.$.rainDesc.textContent = s.rain ? 'Đường trơn, xe chạy chậm lại' : 'Trời khô ráo';
    this.$.auto.classList.toggle('on', s.autoTime);
    this.$.auto.setAttribute('aria-pressed', String(s.autoTime));
    this.$.seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      const sp = Number(b.dataset.speed);
      const on = sp === 0 ? s.paused : !s.paused && sp === s.speed;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      if (sp === 0) b.innerHTML = s.paused ? ICON.play : ICON.pause;
      if (sp === 0) b.setAttribute('aria-label', s.paused ? 'Tiếp tục' : 'Tạm dừng');
    });
    this.$.speedValue.textContent = s.paused ? 'Tạm dừng' : `×${s.speed}`;
    this.$.live.classList.toggle('paused', s.paused);
    this.$.liveText.textContent = s.paused ? 'Tạm dừng' : 'Đang chạy';
    this.root.classList.toggle('hidden', s.hudHidden);
  }

  setClock(hour: number, rain: boolean, light: number): void {
    const time = formatHour(hour);
    const key = `${time}|${rain}`;
    if (key !== this.clockKey) {
      this.clockKey = key;
      this.$.clock.textContent = time;
      this.$.todValue.textContent = time;
      const tod = this.$.tod as HTMLInputElement;
      if (document.activeElement !== tod) tod.value = String(hour);
      const p = phaseOf(hour);
      this.$.phase.textContent = rain ? `${p.label} · mưa` : p.label;
      this.$.phase.classList.toggle('rush', p.rush);
    }
    // DOM order red/amber/green matches the Light enum.
    this.root.querySelectorAll('.brand-mark i').forEach((el, k) => el.classList.toggle('on', k === light));
  }

  setKpi(k: TrafficKpi, sampleHistory: boolean): void {
    this.$.avg.innerHTML = `${fmt1.format(k.avgKmh)}<small>km/h</small>`;
    this.$.count.textContent = fmt0.format(k.count);
    this.$.waiting.textContent = fmt0.format(k.waiting);
    this.$.congValue.textContent = `${Math.round(k.congestion)}%`;
    this.$.cong.style.width = `${k.congestion}%`;
    this.$.cong.style.backgroundPosition = '0 0';
    const groups = MIX_GROUPS.map((g) => g.types.reduce((a, t) => a + k.mix[t], 0));
    const total = Math.max(1, groups.reduce((a, b) => a + b, 0));
    const bars = this.$.mixBar.children;
    const rows = this.$.legend.children;
    groups.forEach((n, i) => {
      const pct = (n / total) * 100;
      (bars[i] as HTMLElement).style.width = `${pct}%`;
      const row = rows[i];
      row.children[2].textContent = fmt0.format(n);
      row.children[3].textContent = `${fmt1.format(pct)}%`;
    });
    if (sampleHistory) {
      this.speedHistory.push(k.avgKmh);
      if (this.speedHistory.length > 90) this.speedHistory.shift();
    }
    const hist = this.speedHistory;
    if (hist.length > 1) {
      const max = Math.max(30, ...hist);
      const pts = hist.map((v, i) => `${((i / (hist.length - 1)) * 120).toFixed(1)},${(42 - (v / max) * 38).toFixed(1)}`);
      const line = `M${pts.join('L')}`;
      this.$.sparkLine.setAttribute('d', line);
      this.$.sparkArea.setAttribute('d', `${line}L120,44L0,44Z`);
    }
  }

  setFollow(info: VehicleInfo | null): void {
    const card = this.$.follow;
    if (!info) {
      if (!card.hidden) card.hidden = true;
      this.followUid = -1;
      return;
    }
    if (card.hidden || this.followUid !== info.uid) {
      card.hidden = false;
      this.followUid = info.uid;
      this.$.fIcon.innerHTML = iconFor(info.type);
      this.$.fTitle.textContent = info.label;
      this.$.fModel.textContent = info.model;
      this.$.fPlate.textContent = info.plate;
      this.$.fPlate.classList.toggle('bus', info.type === VType.Bus);
      this.$.fDriver.textContent = info.driver;
      this.$.fTemper.textContent = info.temper;
      this.$.fWant.textContent = `${fmt0.format(Math.round(info.wantKmh))} km/h`;
      // Restart the entrance animation for a new vehicle.
      card.style.animation = 'none';
      void card.offsetWidth;
      card.style.animation = '';
    }
    this.$.fSpeed.textContent = fmt0.format(Math.round(info.kmh));
    const st = this.$.fStatus;
    st.textContent = info.status;
    st.className = `status${/Chờ đèn đỏ|Đang chờ đèn|Kẹt/.test(info.status) ? ' wait' : /Nhường|[Cc]hờ|Dừng/.test(info.status) ? ' slow' : ''}`;
    this.$.fStreet.textContent = info.street;
    this.$.fNext.textContent = info.next || 'Rời khỏi khu vực';
    const m = Math.floor(info.age / 60);
    const s = Math.floor(info.age % 60);
    this.$.fAge.textContent = `${m}:${String(s).padStart(2, '0')}`;
    this.$.fDist.textContent = `${fmt2.format(info.distKm)} km`;
  }

  tab: 'overview' | 'road' = 'overview';
  private eventEls = new Map<string, HTMLElement>();
  private tlKey = '';

  setTab(tab: 'overview' | 'road'): void {
    this.tab = tab;
    this.$.paneOverview.hidden = tab !== 'overview';
    this.$.paneRoad.hidden = tab !== 'road';
    this.$.tabs.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  }

  setRoad(view: RoadView | null): void {
    this.$.roadEmpty.hidden = view !== null;
    this.$.roadView.hidden = view === null;
    if (!view) return;
    this.$.rName.textContent = view.name;
    this.$.rSpan.textContent = view.span;
    this.$.rSpeed.innerHTML = `${fmt1.format(view.liveKmh)}<small>km/h</small>`;
    this.$.rDensity.innerHTML = `${fmt1.format(view.liveDensity)}<small>xe/100 m</small>`;
    const { speedKmh, density } = view.series;
    const maxV = Math.max(30, ...speedKmh.map((v) => v ?? 0));
    const maxD = Math.max(2, ...density.map((v) => v ?? 0));
    const now = Math.floor(view.hour) % 24;
    const paint = (bars: HTMLCollection, vals: (number | null)[], max: number, unit: string, speed: boolean) => {
      for (let h = 0; h < 24; h++) {
        const el = bars[h] as HTMLElement;
        const v = vals[h];
        el.classList.toggle('empty', v === null);
        el.classList.toggle('now', h === now);
        el.style.height = v === null ? '100%' : `${Math.max(4, (v / max) * 100)}%`;
        if (speed && v !== null) el.dataset.level = v < 8 ? 'slow' : v < 15 ? 'mid' : 'fast';
        el.title = `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00 · ${v === null ? 'chưa có số liệu' : `${fmt1.format(v)} ${unit}`}`;
      }
    };
    paint(this.$.rSpeedBars.children, speedKmh, maxV, 'km/h', true);
    paint(this.$.rDensBars.children, density, maxD, 'xe/100 m', false);
    const known = speedKmh.map((v, h) => [v, h] as const).filter(([v]) => v !== null) as [number, number][];
    if (known.length > 1) {
      const worst = known.reduce((a, b) => (b[0] < a[0] ? b : a));
      this.$.rSpeedNote.innerHTML = `<small>chậm nhất ${String(worst[1]).padStart(2, '0')}h</small>`;
    } else this.$.rSpeedNote.innerHTML = `<small>${view.liveCount} xe đang chạy</small>`;
  }

  /** Toasts for active city events; new ones slide in, cleared ones slide out. */
  setEvents(events: CityEvent[]): void {
    const box = this.$.events;
    const keep = new Set(events.map((e) => e.key));
    for (const [key, el] of this.eventEls) {
      if (keep.has(key)) continue;
      this.eventEls.delete(key);
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 320);
    }
    for (const e of events) {
      let el = this.eventEls.get(e.key);
      if (!el) {
        el = document.createElement('div');
        el.className = `event ${e.kind}`;
        el.innerHTML = `<span class="ev-icon" aria-hidden="true">${e.kind === 'crash' ? '⚠' : e.kind === 'flood' ? '≈' : '⛔'}</span><div><b class="ev-title"></b><span class="ev-detail"></span></div>`;
        box.appendChild(el);
        this.eventEls.set(e.key, el);
      }
      el.querySelector('.ev-title')!.textContent = e.title;
      el.querySelector('.ev-detail')!.textContent = e.detail;
    }
  }

  setTimeline(t: TimelineView): void {
    const key = `${t.open}|${t.reviewing}|${t.min}|${t.offset}|${t.clock}`;
    if (key === this.tlKey) return;
    this.tlKey = key;
    this.$.timebar.hidden = !t.open;
    this.$.tmToggle.classList.toggle('on', t.open);
    this.root.classList.toggle('reviewing', t.reviewing);
    const range = this.$.tbRange as HTMLInputElement;
    range.min = String(Math.min(-60, t.min));
    if (document.activeElement !== range) range.value = String(t.offset);
    // Share of the hour that has been recorded so far, shown as the track fill.
    range.style.setProperty('--avail', `${Math.round((-t.min / 3600) * 100)}%`);
    this.$.tbTime.textContent = t.clock;
    const mins = Math.round(-t.offset / 60);
    this.$.tbOff.textContent = t.reviewing ? `lùi ${mins} phút` : 'hiện tại';
    this.$.tbBadge.textContent = t.reviewing ? 'Đang xem lại' : 'Trực tiếp';
    this.$.tbBadge.classList.toggle('past', t.reviewing);
    (this.$.tbResume as HTMLButtonElement).disabled = !t.reviewing;
    (this.$.tbLive as HTMLButtonElement).disabled = !t.reviewing;
    this.$.liveText.textContent = t.reviewing ? 'Xem lại' : this.state.paused ? 'Tạm dừng' : 'Đang chạy';
  }

  setTip(text: string | null, x = 0, y = 0): void {
    const tip = this.$.tip;
    if (!text) {
      tip.hidden = true;
      return;
    }
    if (tip.textContent !== text) tip.textContent = text;
    tip.hidden = false;
    tip.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 16)}px)`;
  }
}
