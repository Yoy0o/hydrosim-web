import * as THREE from 'three';
import type { Terrain } from '../types';
import type { GridFrame, SharedUniforms } from './scene';

/**
 * Water surface: shares the terrain vertex layout. State (h, u, v, wse) is uploaded each frame as an
 * RGBA32F texture and fetched in the vertex shader. Dry vertices adjacent to wet ones extend the
 * neighbouring water plane (clipped by the terrain through the depth test) for a sub-cell shoreline.
 */
const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform sampler2D uState;
uniform sampler2D uAux;
uniform vec2 uGrid;
uniform vec2 uCell;
uniform float uShowDepth;
attribute vec2 aCell;
varying float vDepth;
varying vec2 vVel;
varying float vWse;
varying float vAux;
varying float vHide;
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec2 vXZ;

vec4 S(ivec2 c) {
  c = clamp(c, ivec2(0), ivec2(uGrid) - 1);
  return texelFetch(uState, c, 0);
}

void main() {
  ivec2 c = ivec2(aCell + 0.5);
  vec4 s = S(c);
  float zb = position.y;
  float y;
  float depth;
  float hide = 0.0;
  bool wet = s.r >= uShowDepth;
  if (wet) {
    y = s.a;
    depth = s.r;
  } else {
    float sum = 0.0;
    float cnt = 0.0;
    for (int dj = -1; dj <= 1; dj++) {
      for (int di = -1; di <= 1; di++) {
        if (di == 0 && dj == 0) continue;
        vec4 n = S(c + ivec2(di, dj));
        if (n.r >= uShowDepth) { sum += n.a; cnt += 1.0; }
      }
    }
    if (cnt > 0.0) {
      y = min(sum / cnt, zb - 0.002);
    } else {
      y = zb - 1.0;
      hide = 1.0;
    }
    depth = 0.0;
  }
  // normal from neighbouring water surface (dry neighbours use this vertex height)
  vec4 sl = S(c + ivec2(-1, 0));
  vec4 sr = S(c + ivec2(1, 0));
  vec4 sd = S(c + ivec2(0, -1));
  vec4 su = S(c + ivec2(0, 1));
  float wl = sl.r >= uShowDepth ? sl.a : y;
  float wr = sr.r >= uShowDepth ? sr.a : y;
  float wd = sd.r >= uShowDepth ? sd.a : y;
  float wu = su.r >= uShowDepth ? su.a : y;
  float gx = (wr - wl) / (2.0 * uCell.x);
  float gy = (wu - wd) / (2.0 * uCell.y);
  vec3 nObj = normalize(vec3(-gx, 1.0, gy));
  vNormalV = normalize(normalMatrix * nObj);
  vDepth = depth;
  vVel = s.gb;
  vWse = y;
  vAux = texelFetch(uAux, c, 0).r;
  vHide = hide;
  vXZ = position.xz;
  vec4 mv = modelViewMatrix * vec4(position.x, y, position.z, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform int uMode;
uniform sampler2D uCmap;
uniform float uMin;
uniform float uMax;
uniform float uOpacity;
uniform float uTime;
uniform float uRipple;
uniform vec3 uSunDirView;
uniform vec3 uSky;
varying float vDepth;
varying vec2 vVel;
varying float vWse;
varying float vAux;
varying float vHide;
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec2 vXZ;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec2 rippleGrad(vec2 p) {
  float e = 0.15;
  float a = vnoise(p);
  return vec2(vnoise(p + vec2(e, 0.0)) - a, vnoise(p + vec2(0.0, e)) - a) / e;
}

void main() {
  #include <logdepthbuf_fragment>
  if (vHide > 0.5) discard;
  vec3 n = normalize(vNormalV);
  vec3 V = normalize(-vViewPos);
  vec3 L = uSunDirView;
  float d = max(vDepth, 0.0);
  float spd = length(vVel);
  if (uMode == 0 && uRipple > 0.0) {
    // flow-advected ripples (two phases blended to hide the reset)
    vec2 flow = vec2(vVel.x, -vVel.y);
    float ph0 = fract(uTime * 0.25);
    float ph1 = fract(uTime * 0.25 + 0.5);
    float w = abs(ph0 - 0.5) * 2.0;
    vec2 p = vXZ / uRipple;
    // over one 4 s phase the pattern travels with the local flow
    vec2 g0 = rippleGrad(p - flow * ph0 * 4.0 / uRipple);
    vec2 g1 = rippleGrad(p - flow * ph1 * 4.0 / uRipple + 17.0);
    vec2 g = mix(g0, g1, w) * (0.10 + 0.25 * clamp(spd / 2.0, 0.0, 1.0));
    n = normalize(n + vec3(g.x, 0.0, g.y) * 0.6);
  }
  float diff = max(dot(n, L), 0.0);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(n, H), 0.0), 140.0);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  if (uMode == 0) {
    vec3 shallow = vec3(0.33, 0.62, 0.66);
    vec3 deep = vec3(0.03, 0.16, 0.30);
    vec3 col = mix(shallow, deep, 1.0 - exp(-d / 2.5));
    col *= 0.55 + 0.55 * diff;
    col = mix(col, uSky, fres * 0.55);
    col += vec3(1.0, 0.97, 0.9) * spec * 0.9;
    float fr = spd / sqrt(9.81 * max(d, 0.02));
    float foam = smoothstep(1.2, 2.6, fr) * smoothstep(0.15, 0.8, d) * smoothstep(1.5, 4.0, spd);
    foam *= 0.6 + 0.4 * vnoise(vXZ * 0.15 + uTime);
    col = mix(col, vec3(0.93, 0.95, 0.96), foam * 0.7);
    float a = mix(0.28, uOpacity, 1.0 - exp(-d / 1.2));
    a = max(a, foam * 0.85);
    gl_FragColor = vec4(col, a);
    return;
  }
  float s;
  if (uMode == 1) s = d;
  else if (uMode == 2) s = spd;
  else if (uMode == 3) s = vWse;
  else if (uMode == 4) s = spd / sqrt(9.81 * max(d, 1e-3));
  else if (uMode == 5) s = d * (spd + 0.5);
  else s = vAux;
  float t = clamp((s - uMin) / max(1e-9, uMax - uMin), 0.0, 1.0);
  vec3 col = texture2D(uCmap, vec2(t, 0.5)).rgb;
  col *= 0.72 + 0.35 * diff;
  col += spec * 0.18;
  gl_FragColor = vec4(col, max(0.55, uOpacity));
}
`;

export class WaterLayer {
  mesh: THREE.Mesh | null = null;
  readonly material: THREE.ShaderMaterial;
  private stateTex: THREE.DataTexture | null = null;
  private auxTex: THREE.DataTexture | null = null;
  private nx = 0;
  private ny = 0;

  constructor(shared: SharedUniforms) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      uniforms: {
        uState: { value: null },
        uAux: { value: null },
        uGrid: { value: new THREE.Vector2(1, 1) },
        uCell: { value: new THREE.Vector2(1, 1) },
        uShowDepth: { value: 0.02 },
        uMode: { value: 0 },
        uCmap: { value: null },
        uMin: { value: 0 },
        uMax: { value: 1 },
        uOpacity: { value: 0.85 },
        uRipple: { value: 10 },
        uTime: shared.uTime,
        uSunDirView: shared.uSunDirView,
        uSky: shared.uSky,
      },
    });
  }

  build(terrain: Terrain, frame: GridFrame, index: THREE.BufferAttribute, parent: THREE.Object3D): void {
    this.dispose(parent);
    const { nx, ny, dx, dy, z } = terrain;
    this.nx = nx;
    this.ny = ny;
    const pos = new Float32Array(nx * ny * 3);
    const cell = new Float32Array(nx * ny * 2);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        pos[3 * k] = frame.sceneX((i + 0.5) * dx);
        pos[3 * k + 1] = z[k];
        pos[3 * k + 2] = frame.sceneZ((j + 0.5) * dy);
        cell[2 * k] = i;
        cell[2 * k + 1] = j;
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('aCell', new THREE.BufferAttribute(cell, 2));
    geom.setIndex(index);
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    parent.add(this.mesh);

    this.stateTex = new THREE.DataTexture(new Float32Array(nx * ny * 4), nx, ny, THREE.RGBAFormat, THREE.FloatType);
    this.stateTex.minFilter = THREE.NearestFilter;
    this.stateTex.magFilter = THREE.NearestFilter;
    this.stateTex.needsUpdate = true;
    this.auxTex = new THREE.DataTexture(new Float32Array(nx * ny), nx, ny, THREE.RedFormat, THREE.FloatType);
    this.auxTex.minFilter = THREE.NearestFilter;
    this.auxTex.magFilter = THREE.NearestFilter;
    this.auxTex.needsUpdate = true;
    const u = this.material.uniforms;
    u.uState.value = this.stateTex;
    u.uAux.value = this.auxTex;
    u.uGrid.value.set(nx, ny);
    u.uCell.value.set(dx, dy);
    u.uRipple.value = Math.max(1, Math.min(dx, dy) * 0.6);
  }

  /** Upload a state: depth h, velocities u, v (cell arrays) and bed z. */
  update(h: ArrayLike<number>, u: ArrayLike<number> | null, v: ArrayLike<number> | null, z: ArrayLike<number>): void {
    if (!this.stateTex) return;
    const d = this.stateTex.image.data as Float32Array;
    const n = this.nx * this.ny;
    for (let k = 0; k < n; k++) {
      const hh = h[k];
      d[4 * k] = hh;
      d[4 * k + 1] = u ? u[k] : 0;
      d[4 * k + 2] = v ? v[k] : 0;
      d[4 * k + 3] = z[k] + hh;
    }
    this.stateTex.needsUpdate = true;
  }

  setAux(values: ArrayLike<number> | null, scale = 1): void {
    if (!this.auxTex) return;
    const d = this.auxTex.image.data as Float32Array;
    if (!values) d.fill(0);
    else for (let k = 0; k < d.length; k++) d[k] = values[k] * scale;
    this.auxTex.needsUpdate = true;
  }

  setStyle(opts: { mode: number; cmap: THREE.Texture; min: number; max: number; showDepth: number; opacity: number }): void {
    const u = this.material.uniforms;
    u.uMode.value = opts.mode;
    u.uCmap.value = opts.cmap;
    u.uMin.value = opts.min;
    u.uMax.value = opts.max;
    u.uShowDepth.value = Math.max(1e-4, opts.showDepth);
    u.uOpacity.value = opts.opacity;
  }

  dispose(parent: THREE.Object3D): void {
    if (this.mesh) {
      parent.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.stateTex?.dispose();
    this.auxTex?.dispose();
    this.stateTex = null;
    this.auxTex = null;
  }
}
