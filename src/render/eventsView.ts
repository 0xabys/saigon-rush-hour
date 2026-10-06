import * as THREE from 'three';
import { FLOOD_ZONES } from '../sim/events';
import { ROAD_HALF, type Network, type Road } from '../sim/network';
import type { Traffic } from '../sim/traffic';
import { GeoBuilder } from './geo';
import { makeMaterial, shared } from './materials';

const MAX_INCIDENTS = 4;
const CONES_PER = 4;

function truckBanTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 200;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f6f2e8';
  g.beginPath();
  g.arc(64, 64, 58, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 13;
  g.strokeStyle = '#d23a2a';
  g.beginPath();
  g.arc(64, 64, 52, 0, Math.PI * 2);
  g.stroke();
  // Truck pictogram (P.106a).
  g.fillStyle = '#1d1a17';
  g.fillRect(28, 46, 46, 30);
  g.fillRect(76, 56, 22, 20);
  g.beginPath();
  g.arc(42, 82, 8, 0, Math.PI * 2);
  g.arc(86, 82, 8, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#f6f2e8';
  g.fillRect(8, 132, 112, 62);
  g.strokeStyle = '#1d1a17';
  g.lineWidth = 3;
  g.strokeRect(9.5, 133.5, 109, 59);
  g.fillStyle = '#1d1a17';
  g.font = '700 22px "Be Vietnam Pro", sans-serif';
  g.textAlign = 'center';
  g.fillText('6h – 9h', 64, 157);
  g.fillText('16h – 20h', 64, 183);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function stripMesh(color: number, opacity: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, toneMapped: false }),
  );
  m.visible = false;
  m.renderOrder = 2;
  return m;
}

/** Crash scenes, flood water, truck-ban signage and road selection highlights. */
export class EventsView {
  readonly group = new THREE.Group();
  private readonly cones: THREE.InstancedMesh;
  private readonly signs: THREE.InstancedMesh;
  private readonly rings: THREE.InstancedMesh;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly floodMat: THREE.ShaderMaterial;
  private readonly floods: THREE.InstancedMesh;
  private readonly selected = stripMesh(0xe9a23b, 0.38);
  private readonly hovered = stripMesh(0xfbf6ea, 0.22);
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly net: Network) {
    const mat = makeMaterial({}, { roughness: 0.6 });
    const cone = new GeoBuilder();
    cone.place(new THREE.ConeGeometry(0.28, 0.75, 8), 0, 0.38, 0, 0xf07a26, { emis: 0xff8a2a, emisStrength: 0.6 });
    cone.box(0.5, 0.05, 0.5, 0, 0.03, 0, 0x2a2a2a);
    cone.place(new THREE.CylinderGeometry(0.2, 0.22, 0.1, 8), 0, 0.42, 0, 0xf4f1ea);
    this.cones = new THREE.InstancedMesh(cone.build(), mat, MAX_INCIDENTS * CONES_PER);
    this.cones.count = 0;
    this.cones.castShadow = true;
    this.cones.frustumCulled = false;
    this.group.add(this.cones);

    const tri = new GeoBuilder();
    tri.box(0.06, 1.1, 0.06, 0, 0.55, 0, 0x3a3a3a);
    tri.place(new THREE.CylinderGeometry(0.62, 0.62, 0.05, 3), 0, 1.35, 0, 0xd9412b, { emis: 0xff4030, emisStrength: 1.2 }, [Math.PI / 2, 0, 0]);
    tri.place(new THREE.CylinderGeometry(0.42, 0.42, 0.06, 3), 0, 1.33, 0, 0xf6f2e8, {}, [Math.PI / 2, 0, 0]);
    this.signs = new THREE.InstancedMesh(tri.build(), mat, MAX_INCIDENTS);
    this.signs.count = 0;
    this.signs.frustumCulled = false;
    this.group.add(this.signs);

    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xff6a2a, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.rings = new THREE.InstancedMesh(new THREE.RingGeometry(0.85, 1, 40).rotateX(-Math.PI / 2), this.ringMat, MAX_INCIDENTS);
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 3;
    this.group.add(this.rings);

    // Flood water: murky, rippled blobs whose size and opacity follow the flood level.
    const depthAttr = new THREE.InstancedBufferAttribute(new Float32Array(FLOOD_ZONES.map((z) => z.depth)), 1);
    const fg = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    fg.setAttribute('aDepth', depthAttr);
    this.floodMat = new THREE.ShaderMaterial({
      uniforms: { uTime: shared.uTime, uNight: shared.uNight, uLevel: { value: 0 }, uSky: { value: new THREE.Color() } },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute float aDepth;
        varying vec2 vUv; varying float vDepth; varying vec2 vW;
        void main() {
          vUv = uv; vDepth = aDepth;
          vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vW = w.xz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uNight; uniform float uLevel; uniform vec3 uSky;
        varying vec2 vUv; varying float vDepth; varying vec2 vW;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
        void main() {
          float level = uLevel * vDepth;
          vec2 p = (vUv - 0.5) * 2.0;
          float r = length(p) + (noise(vW * 0.3) - 0.5) * 0.3 + (noise(vW * 1.1) - 0.5) * 0.08;
          float reach = 0.2 + 0.75 * sqrt(level);
          float mask = 1.0 - smoothstep(reach - 0.06, reach, r);
          if (mask < 0.01) discard;
          // Saigon floodwater: dark muddy olive with glossy glare, rain rings and a wet dark edge
          // (a light rim would read as paving).
          // Values are linear (the output pass converts to sRGB), so keep them dark.
          vec3 mud = vec3(0.10, 0.066, 0.028);
          vec3 deep = vec3(0.05, 0.035, 0.016);
          float depthMix = 1.0 - smoothstep(0.0, reach, r);
          vec3 c = mix(mud, deep, depthMix * 0.8);
          c = mix(c, uSky * 0.35, 0.1 + 0.08 * noise(vW * 0.2 + uTime * 0.05));
          float flow = smoothstep(0.62, 0.9, noise(vec2(vW.x * 0.6 + uTime * 0.5, vW.y * 2.2)));
          float glint = smoothstep(0.82, 0.98, noise(vW * 0.9 + vec2(uTime * 0.3, uTime * 0.2)));
          c += flow * 0.03 + glint * 0.18;
          vec2 cell = floor(vW * 0.7);
          vec2 f = fract(vW * 0.7) - 0.5;
          float ph = fract(uTime * 0.8 + hash(cell));
          float ring = (1.0 - smoothstep(0.0, 0.05, abs(length(f) - ph * 0.45))) * (1.0 - ph);
          c += ring * 0.14;
          float edge = smoothstep(reach - 0.05, reach - 0.01, r);
          c = mix(c, vec3(0.02, 0.018, 0.014), edge * 0.8);
          c = mix(c, vec3(0.05, 0.05, 0.05) + vec3(0.95, 0.65, 0.3) * (flow * 0.3 + ring * 0.4 + glint * 0.5), uNight * 0.7);
          gl_FragColor = vec4(c, mask * min(0.92, 0.5 + level * 0.8));
        }`,
    });
    this.floods = new THREE.InstancedMesh(fg, this.floodMat, FLOOD_ZONES.length);
    FLOOD_ZONES.forEach((z, i) => this.floods.setMatrixAt(i, this.m4.compose(new THREE.Vector3(z.x, 0.11, z.z), this.q.identity(), new THREE.Vector3(z.r * 2.6, 1, z.r * 2.6))));
    this.floods.renderOrder = 4;
    this.floods.visible = false;
    this.group.add(this.floods);

    // Truck-ban signs at every road entering the map.
    const tex = truckBanTexture();
    const pole = new GeoBuilder();
    pole.place(new THREE.CylinderGeometry(0.07, 0.09, 3.6, 6), 0, 1.8, 0, 0x5a5f5c);
    const poles = new THREE.InstancedMesh(pole.build(), mat, net.portalsIn.length);
    const plates = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.15, 1.8), new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.6 }), net.portalsIn.length);
    net.portalsIn.forEach((l, i) => {
      const tmp = [0, 0, 0, 0];
      l.sample(9, tmp);
      const rx = -tmp[3];
      const rz = tmp[2];
      const off = ROAD_HALF - 3.9 + 0.9;
      const x = tmp[0] + rx * off;
      const z = tmp[1] + rz * off;
      // Plate faces oncoming (entering) traffic.
      this.q.setFromAxisAngle(this.up, Math.atan2(-tmp[2], -tmp[3]));
      poles.setMatrixAt(i, this.m4.compose(new THREE.Vector3(x, 0, z), this.q, new THREE.Vector3(1, 1, 1)));
      plates.setMatrixAt(i, this.m4.compose(new THREE.Vector3(x, 3.1, z), this.q, new THREE.Vector3(1, 1, 1)));
    });
    poles.castShadow = true;
    this.group.add(poles, plates);

    this.group.add(this.selected, this.hovered);
  }

  private placeStrip(mesh: THREE.Mesh, road: Road | null): void {
    mesh.visible = road !== null;
    if (!road) return;
    mesh.position.set((road.a.x + road.b.x) / 2, 0.1, (road.a.z + road.b.z) / 2);
    mesh.rotation.set(0, -Math.atan2(road.dz, road.dx), 0);
    mesh.scale.set(road.length, 1, ROAD_HALF * 2 + 1);
  }

  setSelection(selectedRoad: number, hoveredRoad: number): void {
    this.placeStrip(this.selected, selectedRoad >= 0 ? this.net.roads[selectedRoad] : null);
    this.placeStrip(this.hovered, hoveredRoad >= 0 && hoveredRoad !== selectedRoad ? this.net.roads[hoveredRoad] : null);
  }

  update(tr: Traffic, wallTime: number, sky: THREE.Color): void {
    const pulse = 0.5 + 0.5 * Math.sin(wallTime * 4);
    (this.selected.material as THREE.MeshBasicMaterial).opacity = 0.26 + 0.14 * pulse;

    this.floodMat.uniforms.uLevel.value = tr.floodLevel;
    this.floodMat.uniforms.uSky.value.copy(sky);
    this.floods.visible = tr.floodLevel > 0.02;

    let n = 0;
    for (const inc of tr.incidents.slice(0, MAX_INCIDENTS)) {
      const link = this.net.segments[inc.linkId];
      const tx = link.tx[0];
      const tz = link.tz[0];
      const rx = -tz;
      const rz = tx;
      // Cones fanned out upstream of the wreck, a warning triangle further back.
      for (let k = 0; k < CONES_PER; k++) {
        const back = 5 + k * 1.4;
        const side = 2.4 - k * 0.5;
        this.cones.setMatrixAt(n * CONES_PER + k, this.m4.makeTranslation(inc.x - tx * back + rx * side, 0, inc.z - tz * back + rz * side));
      }
      this.q.setFromAxisAngle(this.up, Math.atan2(-tx, -tz));
      this.signs.setMatrixAt(n, this.m4.compose(new THREE.Vector3(inc.x - tx * 11, 0, inc.z - tz * 11), this.q, new THREE.Vector3(1, 1, 1)));
      const s = 5 + pulse * 1.5;
      this.rings.setMatrixAt(n, this.m4.compose(new THREE.Vector3(inc.x + tx * 1.5, 0.12, inc.z + tz * 1.5), this.q.identity(), new THREE.Vector3(s, 1, s)));
      n++;
    }
    this.cones.count = n * CONES_PER;
    this.signs.count = n;
    this.rings.count = n;
    this.cones.instanceMatrix.needsUpdate = true;
    this.signs.instanceMatrix.needsUpdate = true;
    this.rings.instanceMatrix.needsUpdate = true;
    this.ringMat.opacity = 0.3 + 0.4 * (1 - pulse);
  }
}
