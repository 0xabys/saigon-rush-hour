import * as THREE from 'three';

/** Uniforms shared by every patched material; updated once per frame. */
export const shared = {
  uNight: { value: 0 },
  uTime: { value: 0 },
  uWet: { value: 0 },
};

export interface PatchOptions {
  /** Second per-instance paint colour (attribute `aColor2`). */
  color2?: boolean;
  /** Per-instance multiplier for night emissive (attribute `instLight`). */
  instLight?: boolean;
  /** Wind sway for instanced foliage. */
  sway?: boolean;
}

/**
 * Low-poly material with three extensions driven by vertex attributes:
 *  - `paint` (0 fixed vertex colour, 1 instanceColor, 2 aColor2) for per-instance liveries,
 *  - `emis` vertex colour that glows at night (head/tail lights, shopfronts, windows),
 *  - optional foliage sway.
 */
export function makeMaterial(opts: PatchOptions = {}, params: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, ...params });
  const defines: Record<string, string> = {};
  if (opts.color2) defines.USE_COLOR2 = '';
  if (opts.instLight) defines.USE_INST_LIGHT = '';
  if (opts.sway) defines.USE_SWAY = '';
  mat.defines = defines;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = shared.uNight;
    shader.uniforms.uTime = shared.uTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float paint;
attribute vec3 emis;
varying vec3 vEmis;
uniform float uTime;
#ifdef USE_COLOR2
attribute vec3 aColor2;
#endif
#ifdef USE_INST_LIGHT
attribute float instLight;
#endif`,
      )
      .replace(
        '#include <color_vertex>',
        `vColor = vec4(1.0);
#ifdef USE_COLOR
vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
vec3 pc = vec3(1.0);
if (paint > 0.5 && paint < 1.5) pc = instanceColor.rgb;
#ifdef USE_COLOR2
else if (paint > 1.5) pc = aColor2;
#endif
vColor.rgb *= pc;
#endif
vEmis = emis;
#ifdef USE_INST_LIGHT
vEmis *= instLight;
#endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3(position);
#if defined(USE_SWAY) && defined(USE_INSTANCING)
{
  vec3 ip = vec3(instanceMatrix[3]);
  float ph = ip.x * 0.13 + ip.z * 0.17;
  float h = max(0.0, position.y - 1.2);
  transformed.x += sin(uTime * 1.3 + ph) * 0.035 * h;
  transformed.z += cos(uTime * 1.05 + ph * 1.3) * 0.028 * h;
}
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vEmis;\nuniform float uNight;`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEmis * uNight;`,
      );
  };
  mat.customProgramCacheKey = () => `lowpoly:${Object.keys(defines).join(',')}`;
  return mat;
}
