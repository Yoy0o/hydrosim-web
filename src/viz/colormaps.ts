import * as THREE from 'three';
import type { ColorMode, ColormapName } from '../types';

type RGB = [number, number, number];

function hex(h: string): RGB {
  const v = parseInt(h.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function ramp(stops: [number, string][]): (t: number) => RGB {
  const s = stops.map(([t, c]) => [t, hex(c)] as [number, RGB]);
  return (t: number) => {
    t = Math.min(1, Math.max(0, t));
    for (let k = 0; k < s.length - 1; k++) {
      const [t0, c0] = s[k];
      const [t1, c1] = s[k + 1];
      if (t <= t1) {
        const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
        return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
      }
    }
    return s[s.length - 1][1];
  };
}

/** Turbo (Google, Apache-2.0) polynomial approximation. */
function turbo(t: number): RGB {
  t = Math.min(1, Math.max(0, t));
  const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  return [Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, g)), Math.min(1, Math.max(0, b))];
}

const viridis = ramp([
  [0, '#440154'], [0.125, '#472d7b'], [0.25, '#3b528b'], [0.375, '#2c728e'], [0.5, '#21918c'],
  [0.625, '#28ae80'], [0.75, '#5ec962'], [0.875, '#addc30'], [1, '#fde725'],
]);
const magma = ramp([
  [0, '#000004'], [0.125, '#1c1044'], [0.25, '#4f127b'], [0.375, '#812581'], [0.5, '#b5367a'],
  [0.625, '#e55064'], [0.75, '#fb8761'], [0.875, '#fec287'], [1, '#fcfdbf'],
]);
const blues = ramp([
  [0, '#d6f5ff'], [0.15, '#9fdcf2'], [0.35, '#55b2e0'], [0.6, '#2475b8'], [0.8, '#11468a'], [1, '#081d4f'],
]);
/** DEFRA (FD2321) flood hazard rating classes over [0, 2.5]: low / moderate / significant / extreme. */
function hazard(t: number): RGB {
  const v = t * 2.5;
  if (v < 0.75) return hex('#4caf50');
  if (v < 1.25) return hex('#ffd54f');
  if (v < 2.0) return hex('#ff8f00');
  return hex('#d32f2f');
}

export const COLORMAPS: Record<ColormapName, { label: string; fn: (t: number) => RGB }> = {
  blues: { label: '蓝色 (水深)', fn: blues },
  turbo: { label: 'Turbo', fn: turbo },
  viridis: { label: 'Viridis', fn: viridis },
  magma: { label: 'Magma', fn: magma },
  hazard: { label: '危险度分级', fn: hazard },
};

const texCache = new Map<ColormapName, THREE.DataTexture>();

export function colormapTexture(name: ColormapName): THREE.DataTexture {
  const cached = texCache.get(name);
  if (cached) return cached;
  const n = 256;
  const data = new Uint8Array(n * 4);
  const fn = COLORMAPS[name].fn;
  for (let k = 0; k < n; k++) {
    const [r, g, b] = fn(k / (n - 1));
    data[4 * k] = Math.round(r * 255);
    data[4 * k + 1] = Math.round(g * 255);
    data[4 * k + 2] = Math.round(b * 255);
    data[4 * k + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  tex.magFilter = name === 'hazard' ? THREE.NearestFilter : THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  texCache.set(name, tex);
  return tex;
}

export function colormapCss(name: ColormapName, steps = 16): string {
  const fn = COLORMAPS[name].fn;
  const parts: string[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const [r, g, b] = fn(t);
    parts.push(`rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}) ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

export interface ModeInfo {
  label: string;
  unit: string;
  defaultMap: ColormapName;
  /** fixed range (if any) */
  fixed?: [number, number];
  envelope?: boolean;
  /** shader mode index */
  shader: number;
}

export const COLOR_MODES: Record<ColorMode, ModeInfo> = {
  realistic: { label: '真实感水面', unit: '', defaultMap: 'blues', shader: 0 },
  depth: { label: '水深 h', unit: 'm', defaultMap: 'blues', shader: 1 },
  speed: { label: '流速 |V|', unit: 'm/s', defaultMap: 'turbo', shader: 2 },
  wse: { label: '水位 η', unit: 'm', defaultMap: 'viridis', shader: 3 },
  froude: { label: '弗劳德数 Fr', unit: '', defaultMap: 'turbo', fixed: [0, 2], shader: 4 },
  hazard: { label: '危险度 h(V+0.5)', unit: 'm²/s', defaultMap: 'hazard', fixed: [0, 2.5], shader: 5 },
  maxDepth: { label: '最大水深（包络）', unit: 'm', defaultMap: 'blues', envelope: true, shader: 6 },
  maxSpeed: { label: '最大流速（包络）', unit: 'm/s', defaultMap: 'turbo', envelope: true, shader: 6 },
  maxHazard: { label: '最大危险度（包络）', unit: 'm²/s', defaultMap: 'hazard', fixed: [0, 2.5], envelope: true, shader: 6 },
  arrival: { label: '淹没到达时间', unit: 'min', defaultMap: 'magma', envelope: true, shader: 6 },
};

/** Robust range (2nd..98th percentile) of values where mask is true. */
export function robustRange(values: ArrayLike<number>, mask: (k: number) => boolean, lowP = 0.0, highP = 0.98): [number, number] {
  const sample: number[] = [];
  const n = values.length;
  const stride = Math.max(1, Math.floor(n / 20000));
  for (let k = 0; k < n; k += stride) if (mask(k)) sample.push(values[k]);
  if (sample.length === 0) return [0, 1];
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor(lowP * (sample.length - 1))];
  let hi = sample[Math.floor(highP * (sample.length - 1))];
  if (!(hi > lo)) hi = lo + 1e-3;
  return [lo, hi];
}

/** Hypsometric tint for terrain (normalised elevation). */
export const terrainRamp = ramp([
  [0, '#3f6b3a'], [0.12, '#56824a'], [0.3, '#8fa35f'], [0.48, '#c2b27e'], [0.66, '#a88461'], [0.82, '#8c7a6b'], [0.93, '#c9c3bb'], [1, '#f4f2ee'],
]);

export function terrainLutTexture(): THREE.DataTexture {
  const n = 256;
  const data = new Uint8Array(n * 4);
  for (let k = 0; k < n; k++) {
    const [r, g, b] = terrainRamp(k / (n - 1));
    data[4 * k] = Math.round(r * 255);
    data[4 * k + 1] = Math.round(g * 255);
    data[4 * k + 2] = Math.round(b * 255);
    data[4 * k + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
