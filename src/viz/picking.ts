import * as THREE from 'three';
import type { Viewer } from './scene';

export interface HeightField {
  nx: number;
  ny: number;
  dx: number;
  dy: number;
  z: ArrayLike<number>;
}

function bil(f: ArrayLike<number>, nx: number, ny: number, fx: number, fy: number): number {
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
  return (f[j0 * nx + i0] * (1 - tx) + f[j0 * nx + i1] * tx) * (1 - ty) + (f[j1 * nx + i0] * (1 - tx) + f[j1 * nx + i1] * tx) * ty;
}

export function surfaceElevation(hf: HeightField, x: number, y: number, h?: ArrayLike<number> | null, showDepth = 0.02): number {
  const fx = x / hf.dx - 0.5;
  const fy = y / hf.dy - 0.5;
  const zb = bil(hf.z, hf.nx, hf.ny, fx, fy);
  if (h) {
    const hh = bil(h, hf.nx, hf.ny, fx, fy);
    if (hh >= showDepth) return zb + hh;
  }
  return zb;
}

const raycaster = new THREE.Raycaster();

/**
 * Ray-march the (exaggerated) height field under the pointer. Returns local coordinates (m) and the
 * surface elevation, or null when the ray misses the domain.
 */
export function pickSurface(
  viewer: Viewer,
  hf: HeightField,
  ndc: THREE.Vector2,
  h?: ArrayLike<number> | null,
  showDepth = 0.02,
): { x: number; y: number; elev: number } | null {
  const f = viewer.frame;
  if (!f) return null;
  raycaster.setFromCamera(ndc, viewer.camera);
  const o = raycaster.ray.origin;
  const d = raycaster.ray.direction;
  const ex = viewer.exaggeration;
  const yMin = (f.zMin - f.zRef) * ex - 1;
  const yMax = (f.zMax - f.zRef + 50) * ex + 1;
  // slab intersection with the domain box
  let t0 = 0;
  let t1 = Infinity;
  const slab = (oo: number, dd: number, lo: number, hi: number): boolean => {
    if (Math.abs(dd) < 1e-12) return oo >= lo && oo <= hi;
    let a = (lo - oo) / dd;
    let b = (hi - oo) / dd;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    return t0 <= t1;
  };
  if (!slab(o.x, d.x, -f.Lx / 2, f.Lx / 2)) return null;
  if (!slab(o.y, d.y, yMin, yMax)) return null;
  if (!slab(o.z, d.z, -f.Ly / 2, f.Ly / 2)) return null;
  let ds = 0.5 * Math.min(f.dx, f.dy);
  const n = (t1 - t0) / ds;
  if (n > 6000) ds = (t1 - t0) / 6000;
  const fn = (t: number): { g: number; x: number; y: number; e: number } => {
    const X = o.x + d.x * t;
    const Y = o.y + d.y * t;
    const Z = o.z + d.z * t;
    const x = f.localX(X);
    const y = f.localY(Z);
    const e = surfaceElevation(hf, x, y, h, showDepth);
    return { g: Y / ex + f.zRef - e, x, y, e };
  };
  let prevT = t0;
  let prev = fn(t0);
  if (prev.g <= 0) return { x: prev.x, y: prev.y, elev: prev.e };
  for (let t = t0 + ds; t <= t1 + ds; t += ds) {
    const tt = Math.min(t, t1);
    const cur = fn(tt);
    if (cur.g <= 0) {
      let a = prevT;
      let b = tt;
      for (let k = 0; k < 24; k++) {
        const m = 0.5 * (a + b);
        if (fn(m).g > 0) a = m;
        else b = m;
      }
      const r = fn(b);
      return { x: r.x, y: r.y, elev: r.e };
    }
    prevT = tt;
    prev = cur;
    if (tt >= t1) break;
  }
  return null;
}
