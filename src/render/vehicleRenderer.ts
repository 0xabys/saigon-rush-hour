import * as THREE from 'three';
import { rand01 } from '../core/rng';
import { CAPACITY, type Traffic } from '../sim/traffic';
import { hailBrand, SPECS, VType } from '../sim/vehicleTypes';
import { makeMaterial, shared } from './materials';
import {
  busGeometry,
  carGeometry,
  cycloGeometry,
  grabGeometry,
  hailCarGeometry,
  headlightPoolTexture,
  motoGeometry,
  taxiGeometry,
  truckGeometry,
  xanhSmGeometry,
} from './vehicleModels';

const enum Model {
  Moto = 0,
  MotoPassenger = 1,
  MotoCargo = 2,
  Grab = 3,
  Car = 4,
  Taxi = 5,
  Bus = 6,
  Truck = 7,
  Cyclo = 8,
  XanhSm = 9,
  HailCar = 10,
}

function modelOf(type: VType, uid: number): Model {
  switch (type) {
    case VType.Moto: {
      const r = rand01(uid, 3);
      return r < 0.62 ? Model.Moto : r < 0.86 ? Model.MotoPassenger : Model.MotoCargo;
    }
    case VType.Grab:
      return Model.Grab;
    case VType.Car:
      return Model.Car;
    case VType.TaxiVinasun:
    case VType.TaxiMaiLinh:
      return Model.Taxi;
    case VType.Bus:
      return Model.Bus;
    case VType.Truck:
      return Model.Truck;
    case VType.Cyclo:
      return Model.Cyclo;
    case VType.RideCar:
      return hailBrand(uid, type) === 2 ? Model.XanhSm : Model.HailCar;
  }
}

export class VehicleRenderer {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[];
  private readonly color2: THREE.InstancedBufferAttribute[];
  private readonly counts: number[];
  private readonly pool: THREE.InstancedMesh;
  private readonly poolMat: THREE.MeshBasicMaterial;
  readonly marker: THREE.Mesh;
  /** Interpolated render positions, reused for picking and camera follow. */
  readonly rx = new Float32Array(CAPACITY);
  readonly rz = new Float32Array(CAPACITY);

  constructor() {
    const geos = [
      motoGeometry(0),
      motoGeometry(1),
      motoGeometry(2),
      grabGeometry(),
      carGeometry(),
      taxiGeometry(),
      busGeometry(),
      truckGeometry(),
      cycloGeometry(),
      xanhSmGeometry(),
      hailCarGeometry(),
    ];
    const mat = makeMaterial({ color2: true }, { roughness: 0.55 });
    this.color2 = [];
    this.meshes = geos.map((g) => {
      const c2 = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
      c2.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aColor2', c2);
      this.color2.push(c2);
      const m = new THREE.InstancedMesh(g, mat, CAPACITY);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    });
    this.counts = new Array(this.meshes.length).fill(0);

    this.poolMat = new THREE.MeshBasicMaterial({
      map: headlightPoolTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.pool = new THREE.InstancedMesh(poolGeo, this.poolMat, CAPACITY);
    this.pool.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pool.frustumCulled = false;
    this.pool.renderOrder = 2;
    this.group.add(this.pool);

    const ring = new THREE.RingGeometry(1.6, 2.1, 40).rotateX(-Math.PI / 2);
    this.marker = new THREE.Mesh(
      ring,
      new THREE.MeshBasicMaterial({ color: 0xe9a23b, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }),
    );
    this.marker.visible = false;
    this.marker.renderOrder = 3;
    this.group.add(this.marker);

    // Horn blips: "•••" bubbles above blocked vehicles, camera-facing.
    this.honkAttr = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
    this.honkAttr.setUsage(THREE.DynamicDrawUsage);
    const hg = new THREE.PlaneGeometry(1, 1);
    hg.setAttribute('aAge', this.honkAttr);
    this.honkMat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 1 } },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute float aAge;
        uniform float uSize;
        varying vec2 vUv; varying float vAge;
        void main() {
          vUv = uv; vAge = aAge;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float pop = 0.7 + 0.3 * smoothstep(0.0, 0.15, aAge);
          mv.xy += position.xy * vec2(2.0, 1.0) * uSize * pop;
          mv.y += aAge * uSize * 0.5;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying float vAge;
        void main() {
          vec2 p = (vUv - 0.5) * vec2(4.0, 2.0);
          float a = 0.0;
          float edge = 0.0;
          for (int k = 0; k < 3; k++) {
            float on = step(float(k) * 0.12, vAge);
            float d = length(p - vec2(-1.1 + float(k) * 1.1, 0.0));
            a = max(a, on * smoothstep(0.42, 0.3, d));
            edge = max(edge, on * smoothstep(0.62, 0.5, d));
          }
          float fade = 1.0 - smoothstep(0.7, 1.0, vAge);
          vec3 c = mix(vec3(0.16, 0.12, 0.08), vec3(1.0, 0.86, 0.32) * 1.6, a);
          float alpha = max(a, edge * 0.85) * fade;
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(c, alpha);
        }`,
    });
    this.honks = new THREE.InstancedMesh(hg, this.honkMat, CAPACITY);
    this.honks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.honks.frustumCulled = false;
    this.honks.renderOrder = 6;
    this.honks.count = 0;
    this.group.add(this.honks);
  }

  private readonly honkAttr: THREE.InstancedBufferAttribute;
  private readonly honkMat: THREE.ShaderMaterial;
  private readonly honks: THREE.InstancedMesh;

  update(tr: Traffic, alpha: number, followIdx: number, wallTime: number, pxPerUnit: number): void {
    this.counts.fill(0);
    const night = shared.uNight.value;
    const showPools = night > 0.04;
    let poolN = 0;
    let honkN = 0;
    const poolArr = this.pool.instanceMatrix.array as Float32Array;
    const honkArr = this.honks.instanceMatrix.array as Float32Array;
    const ages = this.honkAttr.array as Float32Array;
    for (let i = 0; i < tr.hi; i++) {
      if (!tr.active[i]) continue;
      const type = tr.type[i] as VType;
      const model = modelOf(type, tr.uid[i]);
      const mesh = this.meshes[model];
      const k = this.counts[model]++;
      const x = tr.prevX[i] + (tr.x[i] - tr.prevX[i]) * alpha;
      const z = tr.prevZ[i] + (tr.z[i] - tr.prevZ[i]) * alpha;
      let hx = tr.prevHx[i] + (tr.hx[i] - tr.prevHx[i]) * alpha;
      let hz = tr.prevHz[i] + (tr.hz[i] - tr.prevHz[i]) * alpha;
      const hm = Math.hypot(hx, hz) || 1;
      hx /= hm;
      hz /= hm;
      this.rx[i] = x;
      this.rz[i] = z;
      // Drawn slightly larger than their sim footprint so they read at diorama zoom levels.
      const sc = tr.fade[i] * (SPECS[type].swarm ? 1.18 : 1.06);
      const lean = tr.lean[i];
      const cl = Math.cos(lean);
      const sl = Math.sin(lean);
      const a = mesh.instanceMatrix.array as Float32Array;
      const o = k * 16;
      a[o] = hx * sc;
      a[o + 1] = 0;
      a[o + 2] = hz * sc;
      a[o + 3] = 0;
      a[o + 4] = -hz * sl * sc;
      a[o + 5] = cl * sc;
      a[o + 6] = hx * sl * sc;
      a[o + 7] = 0;
      a[o + 8] = -hz * cl * sc;
      a[o + 9] = -sl * sc;
      a[o + 10] = hx * cl * sc;
      a[o + 11] = 0;
      a[o + 12] = x;
      a[o + 13] = tr.elev[i];
      a[o + 14] = z;
      a[o + 15] = 1;
      const c1 = mesh.instanceColor!.array as Float32Array;
      const c2 = this.color2[model].array as Float32Array;
      c1[k * 3] = tr.c1[i * 3];
      c1[k * 3 + 1] = tr.c1[i * 3 + 1];
      c1[k * 3 + 2] = tr.c1[i * 3 + 2];
      c2[k * 3] = tr.c2[i * 3];
      c2[k * 3 + 1] = tr.c2[i * 3 + 1];
      c2[k * 3 + 2] = tr.c2[i * 3 + 2];

      if (showPools) {
        const sp = SPECS[type];
        const big = !sp.swarm;
        const pl = (big ? 11 : 5.5) * sc;
        const pw = (big ? 4.2 : 2.2) * sc;
        const off = sp.length * 0.5 + pl * 0.42;
        const p = poolN * 16;
        poolArr[p] = hx * pl;
        poolArr[p + 1] = 0;
        poolArr[p + 2] = hz * pl;
        poolArr[p + 3] = 0;
        poolArr[p + 4] = 0;
        poolArr[p + 5] = 1;
        poolArr[p + 6] = 0;
        poolArr[p + 7] = 0;
        poolArr[p + 8] = -hz * pw;
        poolArr[p + 9] = 0;
        poolArr[p + 10] = hx * pw;
        poolArr[p + 11] = 0;
        poolArr[p + 12] = x + hx * off;
        poolArr[p + 13] = 0.07;
        poolArr[p + 14] = z + hz * off;
        poolArr[p + 15] = 1;
        poolN++;
      }
    }
    for (let m = 0; m < this.meshes.length; m++) {
      const mesh = this.meshes[m];
      mesh.count = this.counts[m];
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, this.counts[m] * 16);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.clearUpdateRanges();
      mesh.instanceColor!.addUpdateRange(0, this.counts[m] * 3);
      mesh.instanceColor!.needsUpdate = true;
      this.color2[m].clearUpdateRanges();
      this.color2[m].addUpdateRange(0, this.counts[m] * 3);
      this.color2[m].needsUpdate = true;
    }
    for (let i = 0; i < tr.hi; i++) {
      if (!tr.active[i] || tr.honk[i] <= 0) continue;
      const sp = SPECS[tr.type[i]];
      const hgt = tr.type[i] === VType.Bus ? 4 : tr.type[i] === VType.Truck ? 3.4 : sp.swarm ? 2.5 : 2.2;
      const p = honkN * 16;
      honkArr.fill(0, p, p + 16);
      honkArr[p] = honkArr[p + 5] = honkArr[p + 10] = honkArr[p + 15] = 1;
      honkArr[p + 12] = this.rx[i];
      honkArr[p + 13] = hgt + tr.elev[i];
      honkArr[p + 14] = this.rz[i];
      ages[honkN] = 1 - tr.honk[i] / 0.9;
      honkN++;
    }
    this.honks.count = honkN;
    this.honks.instanceMatrix.needsUpdate = true;
    this.honkAttr.needsUpdate = true;
    this.honkMat.uniforms.uSize.value = Math.min(1.8, Math.max(0.6, 12 / pxPerUnit));
    this.pool.count = poolN;
    this.pool.visible = showPools;
    this.pool.instanceMatrix.needsUpdate = true;
    this.poolMat.opacity = Math.min(1, night * 1.1) * 0.42;

    if (followIdx >= 0 && tr.active[followIdx]) {
      const sp = SPECS[tr.type[followIdx]];
      const pulse = 1 + 0.08 * Math.sin(wallTime * 5);
      const s = Math.max(1, sp.length * 0.55) * pulse;
      this.marker.visible = true;
      this.marker.position.set(this.rx[followIdx], 0.09, this.rz[followIdx]);
      this.marker.scale.set(s, 1, s);
    } else {
      this.marker.visible = false;
    }
  }

  /** Nearest vehicle to a screen point (pixels), or −1. */
  pick(tr: Traffic, camera: THREE.Camera, px: number, py: number, w: number, h: number, maxPx = 26): number {
    const v = new THREE.Vector3();
    let best = -1;
    let bestD = maxPx * maxPx;
    for (let i = 0; i < tr.hi; i++) {
      if (!tr.active[i]) continue;
      v.set(this.rx[i], 0.9, this.rz[i]).project(camera);
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }
}
