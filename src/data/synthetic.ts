/** Synthetic terrains for benchmarks and offline demo scenarios. */
import type { Terrain } from '../types';

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed + 1, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Smooth value noise in [-1, 1]. */
export function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  const top = a + (b - a) * sx;
  const bot = c + (d - c) * sx;
  return 2 * (top + (bot - top) * sy) - 1;
}

/** Fractal Brownian motion of value noise, roughly in [-1, 1]. */
export function fbm(x: number, y: number, seed: number, octaves = 5): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * f, y * f, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Build a terrain by evaluating z(x, y) at cell centres (local metres, origin south-west). */
export function gridTerrain(name: string, nx: number, ny: number, dx: number, f: (x: number, y: number) => number): Terrain {
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = (j + 0.5) * dx;
    for (let i = 0; i < nx; i++) z[j * nx + i] = f((i + 0.5) * dx, y);
  }
  return { name, nx, ny, dx, dy: dx, z, georef: { kind: 'local' }, source: 'synthetic' };
}

/** Fennema & Chaudhry (1990) asymmetric partial dam break: 200 m x 200 m, breach 75 m. */
export function partialDamBreakTerrain(): Terrain {
  return gridTerrain('非对称局部溃坝（200 m × 200 m）', 200, 200, 1, (x, y) => {
    const inDam = x >= 95 && x <= 105;
    const breach = y >= 95 && y <= 170;
    return inDam && !breach ? 12 : 0;
  });
}

/** Dam break over three humps (Kawahara & Umetsu 1986; Brufau et al. 2002): 75 m x 30 m channel. */
export function threeHumpsTerrain(): Terrain {
  return gridTerrain('三驼峰溃坝（75 m × 30 m）', 300, 120, 0.25, (x, y) => {
    const m1 = 1 - Math.hypot(x - 30, y - 6) / 8;
    const m2 = 1 - Math.hypot(x - 30, y - 24) / 8;
    const m3 = 3 - (3 / 10) * Math.hypot(x - 47.5, y - 15);
    return Math.max(0, m1, m2, m3);
  });
}

/** Thacker paraboloid bowl z = -D0 (1 - r^2/a^2), centred in a square domain. */
export function thackerTerrain(D0: number, a: number, L: number, n: number): Terrain {
  const dx = L / n;
  return gridTerrain('Thacker 抛物面盆地', n, n, dx, (x, y) => {
    const xx = x - L / 2;
    const yy = y - L / 2;
    return -D0 * (1 - (xx * xx + yy * yy) / (a * a));
  });
}

/** River centre line of the synthetic valley. */
export function valleyCenter(x: number): number {
  return 2000 + 350 * Math.sin((2 * Math.PI * x) / 3000 + 0.4) + 120 * Math.sin((2 * Math.PI * x) / 1100 + 1.3);
}

export const VALLEY_TOWN = { x0: 3300, x1: 4300, y0: 0, y1: 0 };
(() => {
  let m = -Infinity;
  for (let x = VALLEY_TOWN.x0; x <= VALLEY_TOWN.x1; x += 10) m = Math.max(m, valleyCenter(x));
  VALLEY_TOWN.y0 = m + 90;
  VALLEY_TOWN.y1 = m + 520;
})();

/** Synthetic meandering river valley (6 km x 4 km) with a levee-protected town. */
export function riverValleyTerrain(dx = 20): Terrain {
  const nx = Math.round(6000 / dx);
  const ny = Math.round(4000 / dx);
  const T = VALLEY_TOWN;
  return gridTerrain('合成河谷与城镇（6 km × 4 km）', nx, ny, dx, (x, y) => {
    const yc = valleyCenter(x);
    const d = Math.abs(y - yc);
    let z = 62 - 0.004 * x;
    z += 0.004 * Math.max(0, d - 30);
    z += 70 * smoothstep(650, 1700, d) + 0.015 * Math.max(0, d - 650);
    z += 28 * fbm(x / 900, y / 900, 7) * smoothstep(450, 1200, d);
    z += 0.5 * fbm(x / 160, y / 160, 3);
    if (d < 28) z -= 4.5 * (1 - (d / 28) ** 2);
    // levee on the north bank in front of the town
    if (y > yc && d >= 34 && d <= 52 && x >= 3000 && x <= 4600) z += 2.6 * Math.sin((Math.PI * (d - 34)) / 18);
    // town blocks (40 m buildings on a 60 m grid)
    if (x >= T.x0 && x <= T.x1 && y >= T.y0 && y <= T.y1) {
      const bx = (x - T.x0) % 60;
      const by = (y - T.y0) % 60;
      if (bx < 40 && by < 40) z += 7;
    }
    return z;
  });
}

export function coastLine(x: number): number {
  return 1400 + 120 * Math.sin((2 * Math.PI * x) / 2500) + 60 * Math.sin((2 * Math.PI * x) / 900 + 1);
}

/** Synthetic coast (5 km x 4 km): bathymetry, dune ridge with an inlet, low hinterland, village, hills. */
export function coastalTerrain(dx = 20): Terrain {
  const nx = Math.round(5000 / dx);
  const ny = Math.round(4000 / dx);
  return gridTerrain('合成海岸与沙丘（5 km × 4 km）', nx, ny, dx, (x, y) => {
    const yc = coastLine(x);
    if (y < yc) {
      const s = (yc - y) / yc;
      return -16 * Math.pow(s, 0.8) + 0.6 * fbm(x / 300, y / 300, 11) * s;
    }
    const dl = y - yc;
    let z: number;
    // inlet: a gap through beach and dune ridge (smooth banks over 40 m)
    const gap = 1 - smoothstep(55, 95, Math.abs(x - 2425));
    if (dl < 60) z = 0.05 * dl;
    else if (dl < 160) z = 3 + 4 * Math.sin((Math.PI * (dl - 60)) / 100);
    else z = 1.0 + 0.0012 * (dl - 160) + 0.35 * fbm(x / 250, y / 250, 5);
    if (dl < 200 && gap > 0) z = z * (1 - gap) + (-0.6 + 0.008 * dl) * gap;
    z += 45 * smoothstep(1500, 2500, dl) * (0.7 + 0.3 * fbm(x / 700, y / 700, 9));
    // tidal creek winding inland from the inlet
    const cx = 2425 + 180 * Math.sin(dl / 260);
    if (dl > 40 && dl < 1300 && Math.abs(x - cx) < 18) z = Math.min(z, -0.8 + dl * 0.0015);
    // village
    if (x > 2800 && x < 3500 && dl > 320 && dl < 720) {
      const bx = (x - 2800) % 50;
      const by = (dl - 320) % 50;
      if (bx < 30 && by < 30) z += 6;
    }
    return z;
  });
}
