import * as THREE from 'three';
import type { Terrain } from '../types';
import { terrainLutTexture } from './colormaps';
import type { GridFrame, SharedUniforms } from './scene';

/** Shared triangulated grid (vertex per cell centre) used by the terrain and water meshes. */
export function gridIndex(nx: number, ny: number): THREE.BufferAttribute {
  const n = (nx - 1) * (ny - 1) * 6;
  const idx = nx * ny > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  let k = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx[k++] = a;
      idx[k++] = b;
      idx[k++] = d;
      idx[k++] = a;
      idx[k++] = d;
      idx[k++] = c;
    }
  }
  return new THREE.BufferAttribute(idx, 1);
}

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vNormalV;
varying float vElev;
varying vec2 vUv;
varying vec2 vXZ;
void main() {
  vUv = uv;
  vElev = position.y;
  vXZ = position.xz;
  vNormalV = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uTex;
uniform sampler2D uLut;
uniform sampler2D uOverlay;
uniform float uOverlayMix;
uniform float uUseTex;
uniform float uZMin;
uniform float uZMax;
uniform float uContour;
uniform float uContourInterval;
uniform float uLab;
uniform float uGridStep;
uniform vec3 uSunDirView;
varying vec3 vNormalV;
varying float vElev;
varying vec2 vUv;
varying vec2 vXZ;
float lineMask(float v) {
  float w = fwidth(v);
  float f = abs(fract(v - 0.5) - 0.5);
  return 1.0 - smoothstep(0.0, w * 1.3, f);
}
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vNormalV);
  float diff = max(dot(n, uSunDirView), 0.0);
  vec3 base;
  if (uUseTex > 0.5) {
    base = texture2D(uTex, vUv).rgb;
  } else if (uLab > 0.5) {
    base = vec3(0.70, 0.72, 0.75);
    float g = max(lineMask(vXZ.x / uGridStep), lineMask(vXZ.y / uGridStep));
    base = mix(base, vec3(0.45, 0.48, 0.53), g * 0.6);
  } else {
    float t = clamp((vElev - uZMin) / max(1e-3, uZMax - uZMin), 0.0, 1.0);
    base = texture2D(uLut, vec2(t, 0.5)).rgb;
    if (vElev < 0.0) base = mix(vec3(0.36, 0.45, 0.50), vec3(0.16, 0.25, 0.33), clamp(-vElev / 30.0, 0.0, 1.0));
  }
  if (uOverlayMix > 0.0) {
    vec4 o = texture2D(uOverlay, vUv);
    base = mix(base, o.rgb, o.a * uOverlayMix);
  }
  float shade = uUseTex > 0.5 ? (0.55 + 0.6 * diff) : (0.32 + 0.8 * diff);
  vec3 col = base * shade;
  if (uContour > 0.5) {
    float l = lineMask(vElev / uContourInterval);
    float major = lineMask(vElev / (uContourInterval * 5.0));
    col = mix(col, col * 0.35, max(l * 0.55, major * 0.85));
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export class TerrainLayer {
  mesh: THREE.Mesh | null = null;
  readonly material: THREE.ShaderMaterial;
  private texture: THREE.Texture | null = null;

  constructor(shared: SharedUniforms) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTex: { value: null },
        uLut: { value: terrainLutTexture() },
        uOverlay: { value: null },
        uOverlayMix: { value: 0 },
        uUseTex: { value: 0 },
        uZMin: { value: 0 },
        uZMax: { value: 1 },
        uContour: { value: 0 },
        uContourInterval: { value: 10 },
        uLab: { value: 0 },
        uGridStep: { value: 10 },
        uSunDirView: shared.uSunDirView,
      },
    });
  }

  build(terrain: Terrain, frame: GridFrame, index: THREE.BufferAttribute, parent: THREE.Object3D): void {
    this.dispose(parent);
    const { nx, ny, dx, dy, z } = terrain;
    const pos = new Float32Array(nx * ny * 3);
    const uv = new Float32Array(nx * ny * 2);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        pos[3 * k] = frame.sceneX((i + 0.5) * dx);
        pos[3 * k + 1] = z[k];
        pos[3 * k + 2] = frame.sceneZ((j + 0.5) * dy);
        uv[2 * k] = (i + 0.5) / nx;
        uv[2 * k + 1] = (j + 0.5) / ny;
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geom.setIndex(index);
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
    parent.add(this.mesh);
    const u = this.material.uniforms;
    u.uZMin.value = frame.zMin;
    u.uZMax.value = frame.zMax;
    const step = niceStep(frame.L / 16);
    u.uGridStep.value = step;
  }

  setLab(on: boolean): void {
    this.material.uniforms.uLab.value = on ? 1 : 0;
  }

  setTexture(tex: THREE.Texture | null): void {
    if (this.texture && this.texture !== tex) this.texture.dispose();
    this.texture = tex;
    this.material.uniforms.uTex.value = tex;
    this.material.uniforms.uUseTex.value = tex ? 1 : 0;
  }

  /** Per-cell RGBA overlay (row 0 = south), blended by its alpha; null removes it. */
  setOverlay(o: { data: Uint8Array; nx: number; ny: number } | null, mix: number): void {
    const u = this.material.uniforms;
    (u.uOverlay.value as THREE.Texture | null)?.dispose();
    if (!o) {
      u.uOverlay.value = null;
      u.uOverlayMix.value = 0;
      return;
    }
    const tex = new THREE.DataTexture(o.data, o.nx, o.ny, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    u.uOverlay.value = tex;
    u.uOverlayMix.value = mix;
  }

  /** Move vertices to new bed elevations (gates / breaches). */
  setHeights(z: ArrayLike<number>): void {
    if (!this.mesh) return;
    const attr = this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const p = attr.array as Float32Array;
    for (let k = 0; k < z.length; k++) p[3 * k + 1] = z[k];
    attr.needsUpdate = true;
  }

  setContours(on: boolean, interval: number): void {
    this.material.uniforms.uContour.value = on ? 1 : 0;
    this.material.uniforms.uContourInterval.value = Math.max(0.01, interval);
  }

  dispose(parent: THREE.Object3D): void {
    if (this.mesh) {
      parent.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
  }
}

export function niceStep(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, x))));
  const m = x / p;
  const n = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
  return n * p;
}
