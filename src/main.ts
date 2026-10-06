import '@fontsource/be-vietnam-pro/vietnamese-400.css';
import '@fontsource/be-vietnam-pro/vietnamese-500.css';
import '@fontsource/be-vietnam-pro/vietnamese-600.css';
import '@fontsource/be-vietnam-pro/vietnamese-700.css';
import '@fontsource/be-vietnam-pro/vietnamese-800.css';
import '@fontsource/be-vietnam-pro/latin-400.css';
import '@fontsource/be-vietnam-pro/latin-500.css';
import '@fontsource/be-vietnam-pro/latin-600.css';
import '@fontsource/be-vietnam-pro/latin-700.css';
import '@fontsource/be-vietnam-pro/latin-800.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import './styles.css';

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { rand01 } from './core/rng';
import { buildBuildings } from './render/buildings';
import { Environment } from './render/environment';
import { EventsView } from './render/eventsView';
import { buildGround } from './render/ground';
import { buildLandmarks } from './render/landmarks';
import { Life } from './render/life';
import { shared } from './render/materials';
import { SignalsView } from './render/signalsView';
import { buildVegetation } from './render/vegetation';
import { VehicleRenderer } from './render/vehicleRenderer';
import { Zoning } from './render/zones';
import { buildNetwork, ROAD_HALF, WORLD, type MapNode } from './sim/network';
import { RoadStats, type RoadStatsSnapshot } from './sim/roadStats';
import { flashHours, Light, SignalSystem } from './sim/signals';
import { TimeMachine } from './sim/timeMachine';
import { Traffic, type TrafficKpi, type TrafficSnapshot } from './sim/traffic';
import { SPECS } from './sim/vehicleTypes';
import { formatHour, Hud, type AppState, type HudHandlers, type RoadView } from './ui/hud';

const SIM_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 12;
const MAX_VEHICLES = 1900;
const VIEW_HEIGHT = 170;
const WARMUP_SECONDS = 9;

/** Share of peak demand by hour; rush hours 07–09 and 17–19 peak. */
const DEMAND: [number, number][] = [
  [0, 0.4],
  [4, 0.3],
  [5.5, 0.45],
  [6.5, 0.75],
  [7, 0.95],
  [7.25, 1],
  [8.9, 1],
  [9.5, 0.78],
  [11.5, 0.72],
  [13, 0.68],
  [16, 0.8],
  [17, 0.97],
  [17.25, 1],
  [19, 1],
  [20, 0.85],
  [22, 0.62],
  [24, 0.4],
];

function demandAt(h: number): number {
  for (let i = 0; i < DEMAND.length - 1; i++) {
    const [h0, v0] = DEMAND[i];
    const [h1, v1] = DEMAND[i + 1];
    if (h >= h0 && h <= h1) return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0);
  }
  return DEMAND[0][1];
}

const bootEl = document.getElementById('boot')!;
const bootStep = document.getElementById('boot-step')!;
const bootBar = document.getElementById('boot-progress')!;
const bootCount = document.getElementById('boot-count')!;

function bootProgress(text: string, pct: number, count: number): Promise<void> {
  bootStep.textContent = text;
  bootBar.style.width = `${pct}%`;
  bootCount.textContent = String(count).padStart(2, '0');
  // Let the browser paint the update before the next blocking step.
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  return promise;
}

async function main(): Promise<void> {
  await bootProgress('Đang tải phông chữ…', 8, 4);
  await Promise.all([
    document.fonts.load('400 16px "Be Vietnam Pro"', 'Tốc độ trung bình'),
    document.fonts.load('600 16px "Be Vietnam Pro"', 'Tốc độ trung bình'),
    document.fonts.load('800 16px "Be Vietnam Pro"', 'Sài Gòn'),
    document.fonts.load('700 16px "JetBrains Mono"', '0123456789'),
    document.fonts.load('500 16px "JetBrains Mono"', '0123456789'),
  ]);
  await document.fonts.ready;

  await bootProgress('Dựng phố phường…', 24, 3);
  const app = document.getElementById('app')!;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  } catch {
    bootStep.textContent = 'Trình duyệt này không hỗ trợ WebGL — hãy thử Chrome, Edge, Firefox hoặc Safari bản mới.';
    return;
  }
  const dpr = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const aspect = window.innerWidth / window.innerHeight;
  const camera = new THREE.OrthographicCamera((-VIEW_HEIGHT * aspect) / 2, (VIEW_HEIGHT * aspect) / 2, VIEW_HEIGHT / 2, -VIEW_HEIGHT / 2, 1, 4000);
  const target0 = new THREE.Vector3(-62, 0, 4);
  const offset = new THREE.Vector3().setFromSphericalCoords(900, 0.98, -0.72);
  camera.position.copy(target0).add(offset);
  camera.zoom = 0.72;
  camera.updateProjectionMatrix();
  camera.lookAt(target0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false;
  controls.minZoom = 0.45;
  controls.maxZoom = 7;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = 1.22;
  controls.zoomToCursor = true;
  controls.update();

  const net = buildNetwork();
  const signals = new SignalSystem(net.signalNodes);
  const traffic = new Traffic(net, signals);
  const env = new Environment(net);
  scene.add(env.group);
  scene.fog = env.fog;
  scene.background = env.background;

  const ground = buildGround(net);
  scene.add(ground.group);
  const zoning = new Zoning(net);
  const buildings = buildBuildings(net, zoning);
  scene.add(buildings.group);
  scene.add(buildLandmarks(net));
  const veg = buildVegetation(net, zoning);
  scene.add(veg.group);
  const signalsView = new SignalsView(net);
  scene.add(signalsView.group);
  const vehicles = new VehicleRenderer();
  scene.add(vehicles.group);
  const life = new Life(net);
  scene.add(life.group);
  const eventsView = new EventsView(net);
  scene.add(eventsView.group);
  const stats = new RoadStats(net);

  const state: AppState = {
    paused: false,
    speed: 1,
    hour: 16.75,
    autoTime: true,
    density: 0.9,
    rain: false,
    hudHidden: false,
  };
  let simTime = 0;
  let stepCount = 0;
  let rainLevel = 0;
  let wet = 0;
  let followUid = -1;
  let followZoomTo = 0;
  let selectedRoad = -1;
  let hoveredRoad = -1;
  let tmOpen = false;

  const targetCount = () => Math.round(MAX_VEHICLES * state.density * demandAt(state.hour));

  /** One fixed sim step. Everything that evolves lives here so the time machine can replay it. */
  function stepSim(): void {
    stepCount++;
    simTime += SIM_DT;
    if (state.autoTime) state.hour = (state.hour + SIM_DT / 60) % 24; // one game-minute per sim-second
    rainLevel += ((state.rain ? 1 : 0) - rainLevel) * SIM_DT * 0.35;
    wet = state.rain ? wet + (rainLevel - wet) * SIM_DT * 0.3 : Math.max(0, wet - SIM_DT * 0.018);
    traffic.hour = state.hour;
    traffic.target = targetCount();
    traffic.setRain(rainLevel);
    traffic.step(SIM_DT, simTime);
    stats.step(traffic, state.hour, SIM_DT);
  }

  interface WorldSnapshot {
    stepCount: number;
    simTime: number;
    rainLevel: number;
    wet: number;
    hour: number;
    rain: boolean;
    density: number;
    autoTime: boolean;
    traffic: TrafficSnapshot;
    stats: RoadStatsSnapshot;
  }
  // Keeps one in-game hour (60 sim-seconds at the default clock rate), snapshotting every sim-second.
  const tm = new TimeMachine<WorldSnapshot>(
    {
      capture: () => ({
        stepCount,
        simTime,
        rainLevel,
        wet,
        hour: state.hour,
        rain: state.rain,
        density: state.density,
        autoTime: state.autoTime,
        traffic: traffic.snapshot(),
        stats: stats.snapshot(),
      }),
      restore: (s) => {
        stepCount = s.stepCount;
        simTime = s.simTime;
        rainLevel = s.rainLevel;
        wet = s.wet;
        state.hour = s.hour;
        state.rain = s.rain;
        state.density = s.density;
        state.autoTime = s.autoTime;
        traffic.restore(s.traffic);
        stats.restore(s.stats);
      },
      step: stepSim,
    },
    60,
    3600,
  );

  /** Applies a sim-affecting control change and logs it so rewinds replay it at the same step. */
  function input(apply: () => void): void {
    if (tm.reviewing) {
      tm.branch();
      state.paused = false;
    }
    apply();
    tm.logInput(stepCount + 1, apply);
    hud.sync();
  }

  await bootProgress('Thả xe ra đường…', 52, 2);
  traffic.hour = state.hour;
  traffic.target = targetCount();
  traffic.populate(traffic.target);
  for (let i = 0; i < WARMUP_SECONDS / SIM_DT; i++) stepSim();
  tm.afterLiveStep(stepCount);

  // ---- post-processing
  const composerTarget = new THREE.WebGLRenderTarget(window.innerWidth * dpr, window.innerHeight * dpr, {
    type: THREE.HalfFloatType,
    samples: 4,
  });
  const composer = new EffectComposer(renderer, composerTarget);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 0.4, 0.55, 0.82);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ---- HUD
  const handlers: HudHandlers = {
    setHour(h) {
      // Also refresh the derived light mode so a paused clock shows it at once (the next step
      // recomputes the same values, so replays are unaffected).
      input(() => {
        state.hour = h;
        traffic.hour = h;
        signals.flashing = flashHours(h);
      });
    },
    setAutoTime(on) {
      input(() => (state.autoTime = on));
    },
    setDensity(d) {
      input(() => (state.density = d));
    },
    setRain(on) {
      input(() => (state.rain = on));
    },
    setSpeed(s) {
      state.speed = s;
      state.paused = false;
      hud.sync();
    },
    togglePause() {
      state.paused = !state.paused;
      hud.sync();
    },
    followRandom() {
      const ids: number[] = [];
      for (let i = 0; i < traffic.hi; i++) {
        if (traffic.active[i] && traffic.fade[i] >= 1 && traffic.uid[i] !== followUid) ids.push(i);
      }
      if (!ids.length) return;
      const pick = ids[Math.floor(rand01(Math.floor(simTime * 60), 777) * ids.length)];
      startFollow(pick);
    },
    unfollow() {
      followUid = -1;
      hud.setFollow(null);
    },
    clearRoad() {
      selectedRoad = -1;
      hud.setRoad(null);
    },
    toggleTimeMachine() {
      tmOpen = !tmOpen;
      if (!tmOpen && tm.reviewing) handlers.backToLive();
      refreshTimeline();
    },
    seek(offset) {
      tm.seek(tm.liveStep + offset);
      acc = 0;
      hud.sync();
      refreshTimeline();
    },
    resumeHere() {
      tm.branch();
      state.paused = false;
      hud.sync();
      refreshTimeline();
    },
    backToLive() {
      tm.seek(tm.liveStep);
      acc = 0;
      hud.sync();
      refreshTimeline();
    },
  };
  function refreshTimeline(): void {
    hud.setTimeline({
      open: tmOpen,
      reviewing: tm.reviewing,
      min: tm.earliest - tm.liveStep,
      offset: tm.viewStep - tm.liveStep,
      clock: formatHour(state.hour),
    });
  }
  const hud = new Hud(document.body, state, handlers);

  const endName = (n: MapNode) => (n.kind === 'portal' ? 'rìa bản đồ' : n.kind === 'ring' ? 'vòng xoay Bến Thành' : n.name.replace('Giao lộ ', 'giao lộ '));
  function roadView(id: number): RoadView {
    const r = net.roads[id];
    const len = stats.lengths[id];
    return {
      name: r.bridge ? r.name : `Đường ${r.name}`,
      span: `Từ ${endName(r.a)} đến ${endName(r.b)} · ${Math.round(len)} m`,
      liveKmh: stats.liveSpeed[id] * 3.6,
      liveCount: stats.liveCount[id],
      liveDensity: stats.liveCount[id] / Math.max(0.01, len / 100),
      series: stats.series(id),
      hour: state.hour,
    };
  }
  const camGlide = { t: 1, fromX: 0, fromZ: 0, toX: 0, toZ: 0 };
  function selectRoad(id: number): void {
    selectedRoad = id;
    followUid = -1;
    hud.setFollow(null);
    hud.setTab('road');
    hud.setRoad(roadView(id));
    const r = net.roads[id];
    Object.assign(camGlide, { t: 0, fromX: controls.target.x, fromZ: controls.target.z, toX: (r.a.x + r.b.x) / 2, toZ: (r.a.z + r.b.z) / 2 });
  }

  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  const ndc = new THREE.Vector2();
  function roadAt(px: number, py: number): number {
    ndc.set((px / window.innerWidth) * 2 - 1, -(py / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(groundPlane, hit)) return -1;
    return stats.nearest(hit.x, hit.z, ROAD_HALF + 1.5);
  }

  function startFollow(i: number): void {
    followUid = traffic.uid[i];
    followZoomTo = Math.max(camera.zoom, SPECS[traffic.type[i]].swarm ? 3 : 2.4);
    hud.setFollow(traffic.describe(i));
  }

  // ---- picking
  const canvas = renderer.domElement;
  let downX = 0;
  let downY = 0;
  let downT = 0;
  let hoverX = -1;
  let hoverY = -1;
  canvas.addEventListener('pointerdown', (e) => {
    downX = e.clientX;
    downY = e.clientY;
    downT = performance.now();
    canvas.classList.add('dragging');
  });
  window.addEventListener('pointerup', (e) => {
    canvas.classList.remove('dragging');
    if (e.target !== canvas || e.button !== 0) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6 || performance.now() - downT > 450) return;
    const i = vehicles.pick(traffic, camera, e.clientX, e.clientY, window.innerWidth, window.innerHeight);
    if (i >= 0) {
      startFollow(i);
      return;
    }
    const r = roadAt(e.clientX, e.clientY);
    if (r >= 0) selectRoad(r);
  });
  canvas.addEventListener('pointermove', (e) => {
    hoverX = e.clientX;
    hoverY = e.clientY;
  });
  canvas.addEventListener('pointerleave', () => {
    hoverX = -1;
    hud.setTip(null);
  });
  controls.addEventListener('start', () => {
    // Manual camera input cancels the follow zoom-in so the user stays in control of zoom.
    followZoomTo = 0;
  });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        state.paused = !state.paused;
        break;
      case '1':
      case '2':
      case '4':
        state.speed = Number(e.key) as 1 | 2 | 4;
        state.paused = false;
        break;
      case 'r':
      case 'R':
        handlers.setRain(!state.rain);
        break;
      case 't':
      case 'T':
        handlers.toggleTimeMachine();
        break;
      case 'h':
      case 'H':
        state.hudHidden = !state.hudHidden;
        break;
      case 'f':
      case 'F':
        handlers.followRandom();
        break;
      case 'Escape':
        followUid = -1;
        hud.setFollow(null);
        break;
      default:
        return;
    }
    hud.sync();
  });

  function resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const a = w / h;
    camera.left = (-VIEW_HEIGHT * a) / 2;
    camera.right = (VIEW_HEIGHT * a) / 2;
    camera.top = VIEW_HEIGHT / 2;
    camera.bottom = -VIEW_HEIGHT / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    bloom.resolution.set(w / 2, h / 2);
  }
  window.addEventListener('resize', resize);

  // ---- frame
  const kpi: TrafficKpi = { count: 0, avgKmh: 0, congestion: 0, waiting: 0, mix: new Array(8).fill(0) };
  let acc = 0;
  let last = performance.now();
  let hudTimer = 0;
  let sparkTimer = 0;
  let frameNo = 0;
  const followDelta = new THREE.Vector3();
  const roadBase = new THREE.Color(0x4d4843);
  const walkBase = new THREE.Color(0xffffff);
  const intro = { t: 0, from: camera.zoom, to: 1.5, dur: 2.8 };

  // Adaptive quality: if frames stay slow, step down once per tier (never back up, to avoid flicker).
  // Tier 2 = full; 1 = native pixel ratio 1; 0 = also no bloom and a smaller shadow map.
  let quality = 2;
  let frameMs = 16.7;
  let slowFor = 0;
  function adaptQuality(realDt: number): void {
    if (realDt <= 0 || quality === 0) return;
    frameMs += (realDt * 1000 - frameMs) * 0.05;
    slowFor = frameMs > 24 ? slowFor + realDt : 0;
    if (slowFor < 3) return;
    slowFor = 0;
    quality--;
    if (quality === 1) {
      renderer.setPixelRatio(1);
      composer.setPixelRatio(1);
    } else {
      env.sun.shadow.mapSize.set(1024, 1024);
      env.sun.shadow.map?.dispose();
      env.sun.shadow.map = null;
    }
  }

  function render(now: number, realDt: number): void {
    frameNo++;
    if (intro.t >= intro.dur) adaptQuality(realDt);
    // While reviewing the past the clock is frozen at the viewed moment.
    if (!state.paused && !tm.reviewing) acc += realDt * state.speed;
    let steps = 0;
    while (acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      stepSim();
      tm.afterLiveStep(stepCount);
      acc -= SIM_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) acc = Math.min(acc, SIM_DT);
    const alpha = acc / SIM_DT;

    if (intro.t < intro.dur) {
      intro.t += realDt;
      const k = Math.min(1, intro.t / intro.dur);
      const e = 1 - Math.pow(1 - k, 3);
      camera.zoom = intro.from + (intro.to - intro.from) * e;
      camera.updateProjectionMatrix();
    }

    const followIdx = followUid >= 0 ? traffic.indexOf(followUid) : -1;
    if (followUid >= 0 && followIdx < 0) {
      followUid = -1;
      hud.setFollow(null);
    }
    vehicles.update(traffic, alpha, followIdx, now / 1000, (camera.zoom * window.innerHeight) / (camera.top - camera.bottom));
    if (camGlide.t < 1) {
      camGlide.t = Math.min(1, camGlide.t + realDt / 0.7);
      const e = 1 - Math.pow(1 - camGlide.t, 3);
      const nx = camGlide.fromX + (camGlide.toX - camGlide.fromX) * e;
      const nz = camGlide.fromZ + (camGlide.toZ - camGlide.fromZ) * e;
      camera.position.x += nx - controls.target.x;
      camera.position.z += nz - controls.target.z;
      controls.target.x = nx;
      controls.target.z = nz;
    }
    if (followIdx >= 0) {
      const k = 1 - Math.exp(-realDt * 5);
      followDelta.set(vehicles.rx[followIdx] - controls.target.x, 0, vehicles.rz[followIdx] - controls.target.z).multiplyScalar(k);
      controls.target.add(followDelta);
      camera.position.add(followDelta);
      if (followZoomTo > 0) {
        camera.zoom += (followZoomTo - camera.zoom) * k;
        camera.updateProjectionMatrix();
        if (Math.abs(camera.zoom - followZoomTo) < 0.01) followZoomTo = 0;
      }
    }
    // Keep the camera over the diorama.
    const tx = Math.min(WORLD.maxX, Math.max(WORLD.minX, controls.target.x));
    const tz = Math.min(WORLD.maxZ, Math.max(WORLD.minZ, controls.target.z));
    if (tx !== controls.target.x || tz !== controls.target.z) {
      camera.position.x += tx - controls.target.x;
      camera.position.z += tz - controls.target.z;
      controls.target.x = tx;
      controls.target.z = tz;
    }
    controls.update();

    const pxPerUnit = (camera.zoom * window.innerHeight) / (camera.top - camera.bottom);
    const viewHalf = (camera.right - camera.left) / 2 / camera.zoom;
    const camDist = camera.position.distanceTo(controls.target);
    shared.uTime.value = simTime;
    env.rain = rainLevel;
    env.wet = wet;
    env.update(state.hour, controls.target, viewHalf, camDist, true);
    ground.roadMat.roughness = 0.92 - 0.62 * wet;
    ground.roadMat.color.copy(roadBase).multiplyScalar(1 - 0.38 * wet);
    ground.walkMat.color.copy(walkBase).multiplyScalar(1 - 0.18 * wet);
    ground.walkMat.roughness = 0.9 - 0.4 * wet;
    ground.water.uniforms.uSky.value.copy(env.skyColor);
    veg.poolMat.opacity = shared.uNight.value * 0.62;
    signalsView.update(signals, simTime, pxPerUnit);
    life.update(simTime, state.hour);
    life.updateCrossers(traffic.peds, simTime);
    eventsView.update(traffic, now / 1000, env.skyColor);
    eventsView.setSelection(selectedRoad, hud.tab === 'road' ? hoveredRoad : -1);
    app.classList.toggle('reviewing', tm.reviewing);

    const night = shared.uNight.value;
    bloom.enabled = quality > 0 && (night > 0.03 || wet > 0.3);
    bloom.strength = 0.18 + night * 0.62;
    renderer.toneMappingExposure = 1.05 - rainLevel * 0.08;

    if (hoverX >= 0 && frameNo % 4 === 0 && !canvas.classList.contains('dragging')) {
      const vi = vehicles.pick(traffic, camera, hoverX, hoverY, window.innerWidth, window.innerHeight);
      hoveredRoad = vi < 0 && hud.tab === 'road' ? roadAt(hoverX, hoverY) : -1;
      canvas.classList.toggle('hovering', vi >= 0 || hoveredRoad >= 0);
      if (vi >= 0) hud.setTip(`${SPECS[traffic.type[vi]].label} · nhấp để theo dõi`, hoverX, hoverY);
      else if (hoveredRoad >= 0) hud.setTip(`${net.roads[hoveredRoad].name} · nhấp để xem`, hoverX, hoverY);
      else hud.setTip(null);
    }

    hudTimer += realDt;
    sparkTimer += realDt;
    if (hudTimer > 0.25) {
      hudTimer = 0;
      traffic.kpi(kpi);
      const sample = sparkTimer > 1 && !state.paused && !tm.reviewing;
      if (sample) sparkTimer = 0;
      hud.setKpi(kpi, sample);
      const bn = signals.query(0, 0, simTime);
      hud.setClock(state.hour, state.rain, bn.light === Light.Flash ? (Math.floor(simTime * 2) % 2 === 0 ? Light.Amber : -1) : bn.light);
      if (followIdx >= 0) hud.setFollow(traffic.describe(followIdx));
      hud.setEvents(traffic.events(state.hour));
      if (selectedRoad >= 0 && hud.tab === 'road') hud.setRoad(roadView(selectedRoad));
      refreshTimeline();
    }

    composer.render();
  }

  await bootProgress('Thắp đèn giao thông…', 78, 1);
  await renderer.compileAsync(scene, camera);
  // Render a few real frames behind the boot screen so the reveal is never blank.
  for (let i = 0; i < 4; i++) {
    const t = performance.now();
    render(t, 0);
    const { promise, resolve } = Promise.withResolvers<number>();
    requestAnimationFrame(resolve);
    await promise;
  }
  await bootProgress('Lên đèn xanh!', 100, 0);
  bootEl.classList.add('done');
  last = performance.now();
  intro.t = 0;

  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    render(now, dt);
  });
}

main().catch((err) => {
  console.error(err);
  bootStep.textContent = `Không khởi động được: ${err instanceof Error ? err.message : String(err)}`;
});
