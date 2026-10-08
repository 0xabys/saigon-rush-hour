import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { Bounds, Network } from '../sim/network';
import { shared } from './materials';

interface Key {
  h: number;
  top: number;
  bottom: number;
  sun: number;
  sunI: number;
  hemiSky: number;
  hemiGround: number;
  hemiI: number;
  night: number;
}

// Warm, tropical palette; dusk stays in blues and ambers (no purple).
const KEYS: Key[] = [
  { h: 0, top: 0x0d1724, bottom: 0x23303d, sun: 0xa8bcdc, sunI: 0.55, hemiSky: 0x5a6c8c, hemiGround: 0x3a3228, hemiI: 0.85, night: 1 },
  { h: 4.8, top: 0x16243a, bottom: 0x3a4250, sun: 0xa8bcdc, sunI: 0.5, hemiSky: 0x60708c, hemiGround: 0x3a3228, hemiI: 0.85, night: 0.95 },
  { h: 5.8, top: 0x4f6a8a, bottom: 0xe0a676, sun: 0xffa868, sunI: 0.6, hemiSky: 0x8a9ab0, hemiGround: 0x6a5240, hemiI: 0.75, night: 0.55 },
  { h: 6.8, top: 0x8fb4cc, bottom: 0xf6cfa0, sun: 0xffc890, sunI: 1.6, hemiSky: 0xbcd4e0, hemiGround: 0x9a8060, hemiI: 1.0, night: 0.08 },
  { h: 9, top: 0x9ccbe0, bottom: 0xf6e6c8, sun: 0xfff0d8, sunI: 2.5, hemiSky: 0xd4e6ee, hemiGround: 0xc0a882, hemiI: 1.3, night: 0 },
  { h: 12.5, top: 0x8fc5e0, bottom: 0xf6ecd4, sun: 0xfff8ec, sunI: 2.8, hemiSky: 0xdceef4, hemiGround: 0xc8b08a, hemiI: 1.35, night: 0 },
  { h: 16, top: 0x9cc6d6, bottom: 0xf7dcb0, sun: 0xffe2b8, sunI: 2.5, hemiSky: 0xd8e4e4, hemiGround: 0xc49e74, hemiI: 1.3, night: 0 },
  { h: 17.6, top: 0xb8b8a8, bottom: 0xf6be80, sun: 0xffad6a, sunI: 1.9, hemiSky: 0xd8ccb4, hemiGround: 0xb08660, hemiI: 1.2, night: 0.08 },
  { h: 18.4, top: 0x4f6582, bottom: 0xe8925e, sun: 0xff8a50, sunI: 0.9, hemiSky: 0x8894a4, hemiGround: 0x6a4c38, hemiI: 0.8, night: 0.55 },
  { h: 19.3, top: 0x1c2a40, bottom: 0x5a4e46, sun: 0xa8bcdc, sunI: 0.55, hemiSky: 0x62708a, hemiGround: 0x3a3228, hemiI: 0.9, night: 0.92 },
  { h: 21, top: 0x0f1a28, bottom: 0x2a3440, sun: 0xa8bcdc, sunI: 0.55, hemiSky: 0x5a6c8c, hemiGround: 0x3a3228, hemiI: 0.85, night: 1 },
  { h: 24, top: 0x0d1724, bottom: 0x23303d, sun: 0xa8bcdc, sunI: 0.55, hemiSky: 0x5a6c8c, hemiGround: 0x3a3228, hemiI: 0.85, night: 1 },
];

const RAIN_SKY = new THREE.Color(0x7d8a92);
const RAIN_DROPS = 2600;
const PUDDLES = 90;

const ca = new THREE.Color();
const cb = new THREE.Color();

function lerpHex(a: number, b: number, t: number, out: THREE.Color): THREE.Color {
  ca.setHex(a);
  cb.setHex(b);
  return out.copy(ca).lerp(cb, t);
}

export class Environment {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fog: THREE.Fog;
  readonly background: THREE.CanvasTexture;
  night = 0;
  /** 0–1 smoothed rain intensity (set by the sim clock). */
  rain = 0;
  /** Road wetness, lags behind rain. */
  wet = 0;
  private readonly bgCanvas: HTMLCanvasElement;
  private readonly bgCtx: CanvasRenderingContext2D;
  private readonly skyTop = new THREE.Color();
  private readonly skyBottom = new THREE.Color();
  private readonly rainMat: THREE.ShaderMaterial;
  private readonly rainMesh: THREE.LineSegments;
  private readonly puddleMat: THREE.ShaderMaterial;
  private lastBg = '';
  readonly skyColor = new THREE.Color();

  /** Width of the map (east–west), the upper bound of the rain curtain. */
  private readonly worldWidth: number;

  constructor(net: Network) {
    const b: Bounds = net.bounds;
    this.worldWidth = b.maxX - b.minX;
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1);
    this.group.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 2.5;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 900;
    this.group.add(this.sun);
    this.group.add(this.sun.target);
    this.fog = new THREE.Fog(0xf6e6c8, 600, 1400);

    this.bgCanvas = document.createElement('canvas');
    this.bgCanvas.width = 4;
    this.bgCanvas.height = 256;
    this.bgCtx = this.bgCanvas.getContext('2d')!;
    this.background = new THREE.CanvasTexture(this.bgCanvas);
    this.background.colorSpace = THREE.SRGBColorSpace;

    // Rain: streaks whose positions are a pure function of sim time and a per-drop seed.
    const pos = new Float32Array(RAIN_DROPS * 2 * 3);
    const seed = new Float32Array(RAIN_DROPS * 2 * 3);
    const rng = new Rng(555);
    for (let i = 0; i < RAIN_DROPS; i++) {
      const s = [rng.next(), rng.next(), rng.next()];
      for (let e = 0; e < 2; e++) {
        const k = (i * 2 + e) * 3;
        pos[k + 1] = e;
        seed[k] = s[0];
        seed[k + 1] = s[1];
        seed[k + 2] = s[2];
      }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: { uTime: shared.uTime, uRain: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uArea: { value: 200 }, uNight: shared.uNight },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec3 aSeed;
        uniform float uTime; uniform vec3 uCenter; uniform float uArea;
        varying float vA;
        void main() {
          float fallH = 70.0;
          float y = fallH - mod(uTime * (38.0 + aSeed.z * 10.0) + aSeed.z * fallH, fallH);
          // Drops stay fixed in the world while their wrap window follows the camera.
          vec2 xz = (fract(aSeed.xy - uCenter.xz / uArea) - 0.5) * uArea;
          vec3 p = vec3(uCenter.x + xz.x, y, uCenter.z + xz.y);
          p.y -= position.y * 1.6;
          p.x += position.y * 0.25;
          vA = position.y;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uRain; uniform float uNight;
        varying float vA;
        void main() {
          vec3 c = mix(vec3(0.82, 0.88, 0.92), vec3(0.55, 0.6, 0.7), uNight);
          gl_FragColor = vec4(c, (0.15 + 0.35 * vA) * uRain);
        }`,
    });
    this.rainMesh = new THREE.LineSegments(rg, this.rainMat);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.renderOrder = 10;
    this.rainMesh.visible = false;
    this.group.add(this.rainMesh);

    // Puddles on the roads: reflective blobs with expanding ripples while it rains.
    const pg = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const pSeed = new THREE.InstancedBufferAttribute(new Float32Array(PUDDLES), 1);
    pg.setAttribute('aSeed', pSeed);
    this.puddleMat = new THREE.ShaderMaterial({
      uniforms: { uTime: shared.uTime, uWet: shared.uWet, uRain: { value: 0 }, uSky: { value: new THREE.Color() }, uNight: shared.uNight },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute float aSeed;
        varying vec2 vUv; varying float vSeed;
        void main() { vUv = uv; vSeed = aSeed; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uWet; uniform float uRain; uniform vec3 uSky; uniform float uNight;
        varying vec2 vUv; varying float vSeed;
        void main() {
          vec2 p = (vUv - 0.5) * 2.0;
          float a = atan(p.y, p.x);
          float r = length(p) * (1.0 + 0.18 * sin(a * 3.0 + vSeed * 20.0) + 0.1 * sin(a * 5.0 + vSeed * 7.0));
          float mask = smoothstep(1.0, 0.8, r) * uWet;
          if (mask < 0.01) discard;
          // Dark water film reflecting the sky, brighter toward the rim like a meniscus.
          vec3 c = mix(vec3(0.05, 0.06, 0.07), uSky * 0.75, 0.32 + 0.25 * smoothstep(0.5, 0.95, r));
          c += vec3(1.0, 0.75, 0.45) * uNight * 0.25 * smoothstep(0.6, 0.0, r);
          float ripple = 0.0;
          for (int i = 0; i < 3; i++) {
            vec2 o = vec2(fract(sin(vSeed * 91.0 + float(i) * 13.7) * 43758.5) - 0.5, fract(sin(vSeed * 47.0 + float(i) * 7.3) * 12345.6) - 0.5) * 0.9;
            float ph = fract(uTime * 0.9 + float(i) * 0.33 + vSeed);
            float d = length(p - o);
            ripple += smoothstep(0.05, 0.0, abs(d - ph * 0.6)) * (1.0 - ph);
          }
          c += ripple * uRain * 0.35;
          gl_FragColor = vec4(c, mask * 0.78);
        }`,
    });
    const puddles = new THREE.InstancedMesh(pg, this.puddleMat, PUDDLES);
    const m4 = new THREE.Matrix4();
    const tmp = [0, 0, 0, 0];
    const links = net.links.filter((l) => l.length > 30);
    for (let i = 0; i < PUDDLES; i++) {
      const l = links[rng.int(links.length)];
      l.sample(rng.range(6, l.length - 6), tmp);
      const off = rng.range(-0.9, 0.95) * l.halfW;
      const sx = rng.range(2.5, 6);
      m4.compose(
        new THREE.Vector3(tmp[0] - tmp[3] * off, 0.075, tmp[1] + tmp[2] * off),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI)),
        new THREE.Vector3(sx, 1, sx * rng.range(0.5, 0.9)),
      );
      puddles.setMatrixAt(i, m4);
      pSeed.setX(i, rng.next());
    }
    puddles.renderOrder = 1;
    puddles.frustumCulled = false;
    this.group.add(puddles);
  }

  /** Lighting and sky for an hour of day; rain/wet are already smoothed by the caller. */
  update(hour: number, target: THREE.Vector3, viewHalf: number, camDist: number, rainVisible: boolean): void {
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].h <= hour) i++;
    const a = KEYS[i];
    const b = KEYS[i + 1];
    const t = Math.min(1, Math.max(0, (hour - a.h) / (b.h - a.h)));
    const rain = this.rain;

    lerpHex(a.top, b.top, t, this.skyTop).lerp(RAIN_SKY, rain * 0.55);
    lerpHex(a.bottom, b.bottom, t, this.skyBottom).lerp(RAIN_SKY, rain * 0.6);
    this.night = a.night + (b.night - a.night) * t;
    const night = Math.min(1, this.night + rain * 0.18);
    shared.uNight.value = night;
    shared.uWet.value = this.wet;

    lerpHex(a.sun, b.sun, t, this.sun.color).lerp(RAIN_SKY, rain * 0.4);
    this.sun.intensity = (a.sunI + (b.sunI - a.sunI) * t) * (1 - rain * 0.62);
    lerpHex(a.hemiSky, b.hemiSky, t, this.hemi.color).lerp(RAIN_SKY, rain * 0.4);
    lerpHex(a.hemiGround, b.hemiGround, t, this.hemi.groundColor);
    this.hemi.intensity = (a.hemiI + (b.hemiI - a.hemiI) * t) * (1 - rain * 0.15);

    // Sun arcs east → west, slightly south (Saigon sits ~10.8°N); a pale moon at night.
    const dir = new THREE.Vector3();
    if (this.night < 0.7) {
      const ang = ((hour - 6) / 12) * Math.PI;
      dir.set(Math.cos(ang), Math.max(0.22, Math.sin(ang)) * 0.95, 0.42).normalize();
    } else {
      dir.set(-0.35, 0.85, -0.4).normalize();
    }
    const span = Math.min(320, Math.max(70, viewHalf * 1.25));
    const texel = (span * 2) / this.sun.shadow.mapSize.x;
    const sx = Math.round(target.x / texel) * texel;
    const sz = Math.round(target.z / texel) * texel;
    this.sun.target.position.set(sx, 0, sz);
    this.sun.position.set(sx + dir.x * 400, dir.y * 400, sz + dir.z * 400);
    const cam = this.sun.shadow.camera;
    if (cam.right !== span) {
      cam.left = -span;
      cam.right = span;
      cam.top = span;
      cam.bottom = -span;
      cam.updateProjectionMatrix();
    }

    this.skyColor.copy(this.skyBottom).lerp(this.skyTop, 0.35);
    this.fog.color.copy(this.skyBottom);
    // The camera is orthographic, so fog depth is distance along the view axis: ground at the top edge of the
    // screen sits ≈ 0.83·viewHalf further than the target. Start the haze past most of that and stretch its
    // range with the view, so zooming out over the 1.5 km map keeps the far side readable but still hazy.
    this.fog.near = camDist + 40 + viewHalf * 0.55 - rain * 120;
    this.fog.far = camDist + 900 + viewHalf * 1.5 - rain * 520;
    this.puddleMat.uniforms.uSky.value.copy(this.skyColor);
    this.puddleMat.uniforms.uRain.value = rain;

    const key = `${this.skyTop.getHexString()}${this.skyBottom.getHexString()}`;
    if (key !== this.lastBg) {
      this.lastBg = key;
      const g = this.bgCtx.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, `#${this.skyTop.getHexString()}`);
      g.addColorStop(1, `#${this.skyBottom.getHexString()}`);
      this.bgCtx.fillStyle = g;
      this.bgCtx.fillRect(0, 0, 4, 256);
      this.background.needsUpdate = true;
    }

    this.rainMat.uniforms.uRain.value = rain;
    this.rainMat.uniforms.uCenter.value.copy(target);
    this.rainMat.uniforms.uArea.value = Math.min(this.worldWidth, viewHalf * 2.6);
    this.rainMesh.visible = rainVisible && rain > 0.02;
  }
}
