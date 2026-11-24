/** Geometry helpers on the simulation grid (local metres, origin at the south-west corner). */

export function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xi, yi] = poly[a];
    const [xj, yj] = poly[b];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface GridLike {
  nx: number;
  ny: number;
  dx: number;
  dy: number;
  z: ArrayLike<number>;
}

/** Initial depth from a base level and polygon regions (each region raises the level inside it). */
export function initialDepth(
  g: GridLike,
  baseLevel: number | null,
  regions: { polygon: [number, number][]; level: number }[],
  /** Optional offset of the base level with position (e.g. the geostrophic tilt of an initial current). */
  tilt?: (x: number, y: number) => number,
): Float32Array {
  const { nx, ny, dx, dy, z } = g;
  const h = new Float32Array(nx * ny);
  if (baseLevel !== null && Number.isFinite(baseLevel)) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const lv = tilt ? baseLevel + tilt((i + 0.5) * dx, (j + 0.5) * dy) : baseLevel;
        h[k] = Math.max(0, lv - z[k]);
      }
    }
  }
  for (const r of regions) {
    if (r.polygon.length < 3) continue;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const [x, y] of r.polygon) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    const i0 = Math.max(0, Math.floor(x0 / dx));
    const i1 = Math.min(nx - 1, Math.ceil(x1 / dx));
    const j0 = Math.max(0, Math.floor(y0 / dy));
    const j1 = Math.min(ny - 1, Math.ceil(y1 / dy));
    for (let j = j0; j <= j1; j++) {
      const y = (j + 0.5) * dy;
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * dx;
        if (!pointInPolygon(x, y, r.polygon)) continue;
        const k = j * nx + i;
        const d = r.level - z[k];
        if (d > h[k]) h[k] = d;
      }
    }
  }
  return h;
}

export interface SectionCells {
  cells: number[];
  weights: number[];
  /** Unit normal (left-to-right when walking from point 1 to point 2: rotated -90°). */
  nx: number;
  ny: number;
  length: number;
}

/** Cells crossed by a straight section line with the line length attributed to each cell. */
export function sectionCells(g: { nx: number; ny: number; dx: number; dy: number }, x1: number, y1: number, x2: number, y2: number): SectionCells {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const n = Math.max(2, Math.ceil(len / (0.25 * Math.min(g.dx, g.dy))));
  const ds = len / n;
  const map = new Map<number, number>();
  for (let k = 0; k < n; k++) {
    const t = (k + 0.5) / n;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    const i = Math.floor(x / g.dx);
    const j = Math.floor(y / g.dy);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
    const c = j * g.nx + i;
    map.set(c, (map.get(c) ?? 0) + ds);
  }
  const tx = len > 0 ? (x2 - x1) / len : 1;
  const ty = len > 0 ? (y2 - y1) / len : 0;
  return { cells: [...map.keys()], weights: [...map.values()], nx: ty, ny: -tx, length: len };
}

/** Sample a field bilinearly at local coordinates (cell-centred data). */
export function bilinear(field: ArrayLike<number>, nx: number, ny: number, dx: number, dy: number, x: number, y: number): number {
  let fx = x / dx - 0.5;
  let fy = y / dy - 0.5;
  if (fx < 0) fx = 0;
  if (fy < 0) fy = 0;
  if (fx > nx - 1) fx = nx - 1;
  if (fy > ny - 1) fy = ny - 1;
  const i0 = Math.floor(fx);
  const j0 = Math.floor(fy);
  const i1 = Math.min(nx - 1, i0 + 1);
  const j1 = Math.min(ny - 1, j0 + 1);
  const tx = fx - i0;
  const ty = fy - j0;
  const a = field[j0 * nx + i0];
  const b = field[j0 * nx + i1];
  const c = field[j1 * nx + i0];
  const d = field[j1 * nx + i1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

export function cellAt(g: { nx: number; ny: number; dx: number; dy: number }, x: number, y: number): [number, number] | null {
  const i = Math.floor(x / g.dx);
  const j = Math.floor(y / g.dy);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return null;
  return [i, j];
}
