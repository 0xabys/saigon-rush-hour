import * as THREE from 'three';
import type { Network } from '../sim/network';
import { Light, type SignalSystem } from '../sim/signals';
import { GeoBuilder } from './geo';
import { makeMaterial } from './materials';
import { digitAtlas, noRightOnRedTexture } from './textures';

interface Approach {
  nodeIndex: number;
  group: number;
}

const LAMP_ON = [new THREE.Color(4, 0.4, 0.15), new THREE.Color(3.2, 1.45, 0.08), new THREE.Color(0.2, 3.6, 1.4)];
const LAMP_OFF = new THREE.Color(0.07, 0.06, 0.05);
/** Halo tint per light (red, amber, green); zero = lamp off. */
const GLOW_ON = [new THREE.Color(1, 0.1, 0.04), new THREE.Color(1, 0.52, 0.03), new THREE.Color(0.08, 1, 0.4)];
const POLE = 0x3a3f3c;
const HOUSING = 0x22201d;

export class SignalsView {
  readonly group = new THREE.Group();
  private readonly approaches: Approach[] = [];
  private readonly lamps: THREE.InstancedMesh;
  private readonly digits: THREE.InstancedMesh;
  private readonly digitAttr: THREE.InstancedBufferAttribute;
  private readonly boardMat: THREE.ShaderMaterial;
  private readonly glow: THREE.InstancedMesh;
  private readonly glowAttr: THREE.InstancedBufferAttribute;
  private readonly glowMat: THREE.ShaderMaterial;

  constructor(net: Network) {
    const b = new GeoBuilder();
    const lampPos: THREE.Vector3[] = [];
    const boardPos: THREE.Vector3[] = [];
    const signTex = noRightOnRedTexture();
    const p = [0, 0, 0, 0];
    net.signalJunctions.forEach((j, nodeIndex) => {
      for (const arm of j.arms) {
        const inLink = arm.inLink;
        const sig = inLink?.signal;
        if (!inLink || !sig) continue;
        this.approaches.push({ nodeIndex, group: sig.group });
        // Stop line = end of the inbound link; d is the travel direction, o = −d points up the road.
        inLink.sample(inLink.length, p);
        const dx = p[2];
        const dz = p[3];
        const ox = -dx;
        const oz = -dz;
        const rx = -dz;
        const rz = dx;
        const px = p[0] + ox * 1.2 + rx * (inLink.halfW + 1.1);
        const pz = p[1] + oz * 1.2 + rz * (inLink.halfW + 1.1);
        const yaw = Math.atan2(ox, oz);
        b.place(new THREE.CylinderGeometry(0.13, 0.17, 6.4, 8), px, 3.2, pz, POLE);
        // Mast arm over the inbound lanes.
        const reach = Math.min(5.2, inLink.halfW * 0.8 + 1);
        const ex = px - rx * reach;
        const ez = pz - rz * reach;
        b.box(0.12, 0.12, reach, (px + ex) / 2, 6.25, (pz + ez) / 2, POLE, {}, Math.atan2(rx, rz));
        // Hanging head (over lanes) and a pole-mounted repeater head.
        for (const [hx, hz, hy] of [
          [ex, ez, 5.45],
          [px, pz, 3.1],
        ] as const) {
          b.box(0.5, 1.55, 0.36, hx, hy, hz, HOUSING, {}, yaw);
          b.box(0.62, 1.67, 0.06, hx - ox * 0.2, hy, hz - oz * 0.2, 0xd9d2c3, {}, yaw);
          for (let k = 0; k < 3; k++) {
            lampPos.push(new THREE.Vector3(hx + ox * 0.2, hy + 0.48 - k * 0.48, hz + oz * 0.2));
          }
        }
        boardPos.push(new THREE.Vector3(px, 7.7, pz));
        if (inLink.noRightOnRed) {
          const sign = new THREE.Mesh(
            new THREE.PlaneGeometry(1.1, 1.65),
            new THREE.MeshStandardMaterial({ map: signTex, side: THREE.DoubleSide, roughness: 0.6 }),
          );
          sign.position.set(px + ox * 0.15, 4.6, pz + oz * 0.15);
          sign.rotation.y = yaw;
          sign.castShadow = true;
          this.group.add(sign);
        }
      }
    });
    const housing = new THREE.Mesh(b.build(), makeMaterial({}, { roughness: 0.6 }));
    housing.castShadow = true;
    this.group.add(housing);

    this.lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.17, 10, 8), new THREE.MeshBasicMaterial({ toneMapped: false }), lampPos.length);
    const m = new THREE.Matrix4();
    lampPos.forEach((p, i) => {
      this.lamps.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z));
      this.lamps.setColorAt(i, LAMP_OFF);
    });
    this.group.add(this.lamps);

    // Countdown billboards: one instanced quad per approach, camera-facing.
    this.digitAttr = new THREE.InstancedBufferAttribute(new Float32Array(boardPos.length * 3), 3);
    this.digitAttr.setUsage(THREE.DynamicDrawUsage);
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute('aDigits', this.digitAttr);
    this.boardMat = new THREE.ShaderMaterial({
      uniforms: { uAtlas: { value: digitAtlas() }, uSize: { value: 2.4 } },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec3 aDigits;
        uniform float uSize;
        varying vec2 vUv;
        varying vec3 vDig;
        void main() {
          vUv = uv;
          vDig = aDigits;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          mv.xy += position.xy * vec2(1.7, 1.0) * uSize;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAtlas;
        varying vec2 vUv;
        varying vec3 vDig;
        float roundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
        float glyph(float d, vec2 uv) {
          if (d > 9.5 || uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
          return texture2D(uAtlas, vec2((d + uv.x) / 10.0, uv.y)).a;
        }
        void main() {
          vec2 p = (vUv - 0.5) * vec2(1.7, 1.0);
          float box = roundBox(p, vec2(0.8, 0.46), 0.14);
          if (box > 0.0) discard;
          vec3 col = vDig.z < 0.5 ? vec3(1.0, 0.16, 0.08) : vDig.z < 1.5 ? vec3(1.0, 0.68, 0.08) : vec3(0.18, 1.0, 0.45);
          vec3 bg = mix(vec3(0.07, 0.06, 0.05), vec3(0.3, 0.27, 0.23), smoothstep(-0.04, 0.0, box));
          float g = glyph(vDig.x, vec2((vUv.x - 0.12) / 0.38, (vUv.y - 0.08) / 0.84));
          g = max(g, glyph(vDig.y, vec2((vUv.x - 0.5) / 0.38, (vUv.y - 0.08) / 0.84)));
          vec3 c = mix(bg, col * 1.6, g);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.digits = new THREE.InstancedMesh(geo, this.boardMat, boardPos.length);
    boardPos.forEach((p, i) => this.digits.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
    this.digits.frustumCulled = false;
    this.digits.renderOrder = 5;
    this.group.add(this.digits);

    // Lit-lamp glow: a camera-facing, pixel-sized halo per lamp (lit ones only) so heads read at any zoom.
    this.glowAttr = new THREE.InstancedBufferAttribute(new Float32Array(lampPos.length * 3), 3);
    this.glowAttr.setUsage(THREE.DynamicDrawUsage);
    const glowGeo = new THREE.PlaneGeometry(1, 1);
    glowGeo.setAttribute('aGlow', this.glowAttr);
    this.glowMat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 2 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aGlow;
        uniform float uSize;
        varying vec2 vUv;
        varying vec3 vGlow;
        void main() {
          vUv = uv;
          vGlow = aGlow;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          mv.xy += position.xy * uSize * step(0.001, aGlow.r + aGlow.g + aGlow.b);
          mv.z += 0.9;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vGlow;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          if (r > 1.0) discard;
          float core = 1.0 - smoothstep(0.0, 0.34, r);
          float halo = pow(1.0 - r, 2.2);
          gl_FragColor = vec4(vGlow * (core * 1.6 + halo * 0.7), 1.0);
        }`,
    });
    this.glow = new THREE.InstancedMesh(glowGeo, this.glowMat, lampPos.length);
    lampPos.forEach((p, i) => this.glow.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 4;
    this.group.add(this.glow);
  }

  private readonly lastKey: number[] = [];
  private lastSize = 0;

  update(signals: SignalSystem, t: number, pxPerUnit: number): void {
    const arr = this.digitAttr.array as Float32Array;
    let dirty = false;
    // Late-night flashing amber: ~1 Hz blink, countdown boards go dark.
    const blink = Math.floor(t * 2) % 2 === 0;
    this.approaches.forEach((a, i) => {
      const st = signals.query(a.nodeIndex, a.group, t);
      const flash = st.light === Light.Flash;
      const n = Math.min(99, Math.ceil(st.remaining - 1e-3));
      const key = flash ? (blink ? -1 : -2) : st.light * 100 + n;
      if (this.lastKey[i] === key) return;
      this.lastKey[i] = key;
      dirty = true;
      for (let head = 0; head < 2; head++) {
        for (let k = 0; k < 3; k++) {
          // k runs red (top) → amber → green, matching the Light enum.
          const on = flash ? k === Light.Amber && blink : st.light === k;
          const lamp = i * 6 + head * 3 + k;
          this.lamps.setColorAt(lamp, on ? LAMP_ON[k] : LAMP_OFF);
          const g = on ? GLOW_ON[k] : null;
          this.glowAttr.setXYZ(lamp, g ? g.r : 0, g ? g.g : 0, g ? g.b : 0);
        }
      }
      // Digit 10 is blank in the atlas lookup.
      arr[i * 3] = flash || n < 10 ? 10 : Math.floor(n / 10);
      arr[i * 3 + 1] = flash ? 10 : n % 10;
      arr[i * 3 + 2] = flash ? Light.Amber : st.light;
    });
    if (dirty) {
      this.lamps.instanceColor!.needsUpdate = true;
      this.glowAttr.needsUpdate = true;
      this.digitAttr.needsUpdate = true;
    }
    const glowSize = Math.min(5, Math.max(1.3, 20 / pxPerUnit));
    if (glowSize !== this.glowMat.uniforms.uSize.value) this.glowMat.uniforms.uSize.value = glowSize;
    const size = Math.min(7, Math.max(1.5, 20 / pxPerUnit));
    if (size !== this.lastSize) {
      this.lastSize = size;
      this.boardMat.uniforms.uSize.value = size;
    }
  }
}
