import * as THREE from 'three';
import type { GridFrame } from './scene';

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aAlpha;
attribute float aSpeed;
varying float vAlpha;
varying float vSpeed;
void main() {
  vAlpha = aAlpha;
  vSpeed = aSpeed;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;
const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uRefSpeed;
varying float vAlpha;
varying float vSpeed;
void main() {
  #include <logdepthbuf_fragment>
  float t = clamp(vSpeed / uRefSpeed, 0.0, 1.0);
  vec3 col = mix(vec3(0.75, 0.95, 1.0), vec3(1.0, 1.0, 1.0), t);
  gl_FragColor = vec4(col, vAlpha * (0.35 + 0.5 * t));
}
`;

/**
 * Flow tracers advected on the main thread through the latest velocity field (bilinear sampling),
 * drawn as short streaks oriented with the local velocity.
 */
export class ParticleLayer {
  readonly lines: THREE.LineSegments;
  private readonly material: THREE.ShaderMaterial;
  private max = 0;
  private count = 0;
  private px = new Float32Array(0);
  private py = new Float32Array(0);
  private age = new Float32Array(0);
  private life = new Float32Array(0);
  private pos = new Float32Array(0);
  private alpha = new Float32Array(0);
  private speedAttr = new Float32Array(0);
  private h: ArrayLike<number> | null = null;
  private u: ArrayLike<number> | null = null;
  private v: ArrayLike<number> | null = null;
  private z: ArrayLike<number> | null = null;
  private frame: GridFrame | null = null;
  private wet: Int32Array = new Int32Array(0);
  private wetCount = 0;
  speedFactor = 1;
  showDepth = 0.02;
  enabled = true;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: { uRefSpeed: { value: 2 } },
    });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;
    this.setCapacity(30000);
  }

  private setCapacity(max: number): void {
    this.max = max;
    this.px = new Float32Array(max);
    this.py = new Float32Array(max);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.pos = new Float32Array(max * 6);
    this.alpha = new Float32Array(max * 2);
    this.speedAttr = new Float32Array(max * 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSpeed', new THREE.BufferAttribute(this.speedAttr, 1).setUsage(THREE.DynamicDrawUsage));
    this.lines.geometry.dispose();
    this.lines.geometry = g;
    for (let k = 0; k < max; k++) this.age[k] = this.life[k] = 0;
  }

  setFrame(frame: GridFrame, z: ArrayLike<number>): void {
    this.frame = frame;
    this.z = z;
    this.wet = new Int32Array(frame.nx * frame.ny);
    this.wetCount = 0;
    this.material.uniforms.uRefSpeed.value = 2;
  }

  setCount(n: number): void {
    const c = Math.max(0, Math.min(n, 100000));
    if (c > this.max) this.setCapacity(c);
    for (let k = this.count; k < c; k++) this.life[k] = 0;
    this.count = c;
    this.lines.geometry.setDrawRange(0, c * 2);
  }

  /** New velocity field (cell arrays). */
  setField(h: ArrayLike<number>, u: ArrayLike<number>, v: ArrayLike<number>, refSpeed: number): void {
    this.h = h;
    this.u = u;
    this.v = v;
    let n = 0;
    const thr = this.showDepth;
    for (let k = 0; k < h.length; k++) if (h[k] >= thr && (u[k] !== 0 || v[k] !== 0)) this.wet[n++] = k;
    this.wetCount = n;
    this.material.uniforms.uRefSpeed.value = Math.max(0.2, refSpeed);
  }

  private sample(arr: ArrayLike<number>, fx: number, fy: number, nx: number, ny: number): number {
    if (fx < 0) fx = 0;
    if (fy < 0) fy = 0;
    if (fx > nx - 1) fx = nx - 1;
    if (fy > ny - 1) fy = ny - 1;
    const i0 = fx | 0;
    const j0 = fy | 0;
    const i1 = i0 + 1 < nx ? i0 + 1 : i0;
    const j1 = j0 + 1 < ny ? j0 + 1 : j0;
    const tx = fx - i0;
    const ty = fy - j0;
    const a = arr[j0 * nx + i0];
    const b = arr[j0 * nx + i1];
    const c = arr[j1 * nx + i0];
    const d = arr[j1 * nx + i1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }

  private respawn(k: number): void {
    const f = this.frame!;
    if (this.wetCount === 0) {
      this.life[k] = 0;
      return;
    }
    const c = this.wet[(Math.random() * this.wetCount) | 0];
    const i = c % f.nx;
    const j = (c - i) / f.nx;
    this.px[k] = (i + Math.random()) * f.dx;
    this.py[k] = (j + Math.random()) * f.dy;
    this.age[k] = 0;
    this.life[k] = 1.5 + Math.random() * 3;
  }

  /** Advance particles by a wall-clock interval (s). `exag` is the vertical exaggeration. */
  update(dt: number, exag: number): void {
    const f = this.frame;
    const h = this.h;
    const u = this.u;
    const v = this.v;
    const z = this.z;
    if (!this.enabled || !f || !h || !u || !v || !z || this.count === 0) {
      this.lines.visible = false;
      return;
    }
    this.lines.visible = true;
    const { nx, ny, dx, dy } = f;
    const vis = 0.012 * f.L * this.speedFactor; // metres travelled per second per (m/s)
    const tail = 0.25 * vis;
    const zRef = f.zRef;
    const thr = this.showDepth;
    const lift = 0.02 * Math.max(dx, dy) / Math.max(1, exag);
    // limit density to ~1 tracer per wet cell so narrow channels are not saturated
    const active = Math.min(this.count, Math.max(200, Math.round(this.wetCount * 0.9)));
    for (let k = active; k < this.count; k++) {
      if (this.alpha[2 * k] !== 0) this.alpha[2 * k] = 0;
      this.life[k] = 0;
    }
    for (let k = 0; k < active; k++) {
      this.age[k] += dt;
      if (this.age[k] >= this.life[k]) this.respawn(k);
      let x = this.px[k];
      let y = this.py[k];
      let fx = x / dx - 0.5;
      let fy = y / dy - 0.5;
      const hh = this.sample(h, fx, fy, nx, ny);
      let uu = this.sample(u, fx, fy, nx, ny);
      let vv = this.sample(v, fx, fy, nx, ny);
      const ci = Math.min(nx - 1, Math.max(0, Math.floor(x / dx)));
      const cj = Math.min(ny - 1, Math.max(0, Math.floor(y / dy)));
      if (hh < thr || h[cj * nx + ci] < thr) {
        this.respawn(k);
        this.alpha[2 * k] = this.alpha[2 * k + 1] = 0;
        continue;
      }
      x += uu * dt * vis;
      y += vv * dt * vis;
      if (x < 0 || y < 0 || x >= f.Lx || y >= f.Ly) {
        this.respawn(k);
        this.alpha[2 * k] = this.alpha[2 * k + 1] = 0;
        continue;
      }
      this.px[k] = x;
      this.py[k] = y;
      fx = x / dx - 0.5;
      fy = y / dy - 0.5;
      const zz = this.sample(z, fx, fy, nx, ny);
      const hw = this.sample(h, fx, fy, nx, ny);
      uu = this.sample(u, fx, fy, nx, ny);
      vv = this.sample(v, fx, fy, nx, ny);
      const spd = Math.hypot(uu, vv);
      const elev = (zz + hw - zRef) * exag + lift * exag;
      const o = 6 * k;
      this.pos[o] = f.sceneX(x);
      this.pos[o + 1] = elev;
      this.pos[o + 2] = f.sceneZ(y);
      this.pos[o + 3] = f.sceneX(x - uu * tail);
      this.pos[o + 4] = elev;
      this.pos[o + 5] = f.sceneZ(y - vv * tail);
      const a = this.age[k];
      const fade = Math.min(1, a / 0.4, (this.life[k] - a) / 0.6);
      this.alpha[2 * k] = Math.max(0, fade);
      this.alpha[2 * k + 1] = 0;
      this.speedAttr[2 * k] = spd;
      this.speedAttr[2 * k + 1] = spd;
    }
    const g = this.lines.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aSpeed') as THREE.BufferAttribute).needsUpdate = true;
  }
}
