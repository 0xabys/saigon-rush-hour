import * as THREE from 'three';

export interface PartOptions {
  /** 0 = fixed colour, 1 = instanceColor, 2 = aColor2. */
  paint?: number;
  /** Night glow colour (linear multiplier applied by uNight). */
  emis?: number;
  emisStrength?: number;
}

const tmpColor = new THREE.Color();
const tmpVec = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();
const one = new THREE.Vector3(1, 1, 1);

/** Accumulates transformed primitives into one flat-shaded, vertex-coloured geometry. */
export class GeoBuilder {
  private pos: number[] = [];
  private col: number[] = [];
  private paint: number[] = [];
  private emis: number[] = [];

  add(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, color: number, opts: PartOptions = {}): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.getAttribute('position');
    tmpColor.setHex(color);
    const er = opts.emis === undefined ? 0 : 1;
    const ec = new THREE.Color(opts.emis ?? 0).multiplyScalar(opts.emisStrength ?? 1);
    const flip = matrix.determinant() < 0;
    for (let i = 0; i < p.count; i++) {
      // Keep triangle winding consistent if the matrix mirrors.
      const k = flip ? i - (i % 3) + (2 - (i % 3)) : i;
      tmpVec.fromBufferAttribute(p, k).applyMatrix4(matrix);
      this.pos.push(tmpVec.x, tmpVec.y, tmpVec.z);
      this.col.push(tmpColor.r, tmpColor.g, tmpColor.b);
      this.paint.push(opts.paint ?? 0);
      this.emis.push(ec.r * er, ec.g * er, ec.b * er);
    }
    if (g !== geo) g.dispose();
    return this;
  }

  /** Axis-aligned box given its centre, optionally yawed. */
  box(w: number, h: number, d: number, x: number, y: number, z: number, color: number, opts?: PartOptions, rotY = 0, rotX = 0, rotZ = 0): this {
    const g = new THREE.BoxGeometry(w, h, d);
    tmpEuler.set(rotX, rotY, rotZ);
    tmpQuat.setFromEuler(tmpEuler);
    tmpMat.compose(tmpVec.set(x, y, z), tmpQuat, one);
    this.add(g, tmpMat, color, opts);
    g.dispose();
    return this;
  }

  /** Any geometry placed with position / euler rotation / scale. */
  place(
    geo: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    color: number,
    opts?: PartOptions,
    rot: [number, number, number] = [0, 0, 0],
    scale: [number, number, number] = [1, 1, 1],
  ): this {
    tmpEuler.set(rot[0], rot[1], rot[2]);
    tmpQuat.setFromEuler(tmpEuler);
    tmpMat.compose(new THREE.Vector3(x, y, z), tmpQuat, new THREE.Vector3(scale[0], scale[1], scale[2]));
    this.add(geo, tmpMat, color, opts);
    return this;
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('paint', new THREE.Float32BufferAttribute(this.paint, 1));
    g.setAttribute('emis', new THREE.Float32BufferAttribute(this.emis, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Triangular prism (gable roof) spanning x∈[-w/2,w/2], z∈[-d/2,d/2], ridge along x at height h. */
export function gableGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-d / 2, 0);
  shape.lineTo(d / 2, 0);
  shape.lineTo(0, h);
  shape.lineTo(-d / 2, 0);
  const g = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
  g.translate(0, 0, -w / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

/** Mono-pitch roof slab: high at the back (−z), low at the front (+z). */
export function shedGeometry(w: number, hBack: number, hFront: number, d: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-d / 2, 0);
  shape.lineTo(d / 2, 0);
  shape.lineTo(d / 2, hFront);
  shape.lineTo(-d / 2, hBack);
  shape.lineTo(-d / 2, 0);
  const g = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
  g.translate(0, 0, -w / 2);
  g.rotateY(-Math.PI / 2);
  return g;
}
