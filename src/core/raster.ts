/**
 * Rasterisation of vector features onto the simulation grid (local metres, origin at the south-west
 * corner, cell (i, j) centred at ((i+0.5)dx, (j+0.5)dy), row-major index j*nx+i).
 */

export interface GridGeom {
  nx: number;
  ny: number;
  dx: number;
  dy: number;
}

/**
 * Cells along a polyline. The centre line is 4-connected (a diagonal step is bridged by an extra cell) so a
 * raised levee cannot leak through cell corners; lines wider than one cell add every cell whose centre lies
 * within width/2 of the polyline.
 */
export function rasterizeLine(g: GridGeom, pts: [number, number][], width = 0): number[] {
  const set = new Set<number>();
  if (pts.length === 0) return [];
  const { nx, ny, dx, dy } = g;
  const add = (i: number, j: number): void => {
    if (i >= 0 && j >= 0 && i < nx && j < ny) set.add(j * nx + i);
  };
  const step = 0.25 * Math.min(dx, dy);
  let pi = -1;
  let pj = -1;
  const visit = (x: number, y: number): void => {
    const i = Math.floor(x / dx);
    const j = Math.floor(y / dy);
    if (pi >= 0 && i !== pi && j !== pj) add(i, pj); // bridge diagonal steps
    add(i, j);
    pi = i;
    pj = j;
  };
  if (pts.length === 1) visit(pts[0][0], pts[0][1]);
  for (let s = 0; s + 1 < pts.length; s++) {
    const [x1, y1] = pts[s];
    const [x2, y2] = pts[s + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step));
    for (let k = s === 0 ? 0 : 1; k <= n; k++) visit(x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n);
  }
  const half = width / 2;
  if (half > 0.5 * Math.min(dx, dy)) {
    for (let s = 0; s + 1 < pts.length; s++) {
      const [x1, y1] = pts[s];
      const [x2, y2] = pts[s + 1];
      const i0 = Math.max(0, Math.floor((Math.min(x1, x2) - half) / dx));
      const i1 = Math.min(nx - 1, Math.floor((Math.max(x1, x2) + half) / dx));
      const j0 = Math.max(0, Math.floor((Math.min(y1, y2) - half) / dy));
      const j1 = Math.min(ny - 1, Math.floor((Math.max(y1, y2) + half) / dy));
      const ex = x2 - x1;
      const ey = y2 - y1;
      const len2 = ex * ex + ey * ey || 1e-12;
      for (let j = j0; j <= j1; j++) {
        const cy = (j + 0.5) * dy;
        for (let i = i0; i <= i1; i++) {
          const cx = (i + 0.5) * dx;
          const t = Math.max(0, Math.min(1, ((cx - x1) * ex + (cy - y1) * ey) / len2));
          const d = Math.hypot(cx - (x1 + t * ex), cy - (y1 + t * ey));
          if (d <= half) set.add(j * nx + i);
        }
      }
    }
  }
  return [...set];
}

/**
 * Scan-line rasterisation of a polygon given as rings (even-odd rule: holes and multipolygons work when all
 * rings of a feature are passed together). Every cell is sampled at sub x sub points; `cb(cell)` is called
 * once per covered sample point, so the number of calls per cell is its coverage count (0..sub^2).
 */
export function rasterizeRings(
  g: GridGeom,
  rings: [number, number][][],
  sub: number,
  cb: (cell: number) => void,
  clip?: { x0: number; x1: number; y0: number; y1: number },
): void {
  const { nx, ny, dx, dy } = g;
  const sdx = dx / sub;
  const sdy = dy / sub;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const r of rings) {
    for (const [, y] of r) {
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
  }
  if (!(ymax > ymin)) return;
  const rows = ny * sub;
  const cols = nx * sub;
  // optional clip window: only sample points with x in [x0, x1) and y in [y0, y1)
  const cx0 = clip ? Math.max(0, Math.ceil(clip.x0 / sdx - 0.5)) : 0;
  const cx1 = clip ? Math.min(cols - 1, Math.ceil(clip.x1 / sdx - 0.5) - 1) : cols - 1;
  let r0 = Math.max(0, Math.floor(ymin / sdy - 0.5));
  let r1 = Math.min(rows - 1, Math.ceil(ymax / sdy - 0.5));
  if (clip) {
    r0 = Math.max(r0, Math.ceil(clip.y0 / sdy - 0.5));
    r1 = Math.min(r1, Math.ceil(clip.y1 / sdy - 0.5) - 1);
  }
  const xs: number[] = [];
  for (let r = r0; r <= r1; r++) {
    const y = (r + 0.5) * sdy;
    xs.length = 0;
    for (const ring of rings) {
      const n = ring.length;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const ya = ring[a][1];
        const yb = ring[b][1];
        if (ya > y !== yb > y) {
          const xa = ring[a][0];
          const xb = ring[b][0];
          xs.push(xa + ((y - ya) * (xb - xa)) / (yb - ya));
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const rowCell = Math.floor(r / sub) * nx;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(cx0, Math.ceil(xs[k] / sdx - 0.5));
      const c1 = Math.min(cx1, Math.ceil(xs[k + 1] / sdx - 0.5) - 1);
      for (let cc = c0; cc <= c1; cc++) cb(rowCell + Math.floor(cc / sub));
    }
  }
}

/** Interior cells whose centre lies inside the polygon. */
export function polygonCells(g: GridGeom, poly: [number, number][]): number[] {
  const out: number[] = [];
  if (poly.length >= 3) rasterizeRings(g, [poly], 1, (c) => out.push(c));
  return out;
}

/** Nearest cell to a point (clamped into the grid). */
export function cellOf(g: GridGeom, x: number, y: number): number {
  const i = Math.min(g.nx - 1, Math.max(0, Math.floor(x / g.dx)));
  const j = Math.min(g.ny - 1, Math.max(0, Math.floor(y / g.dy)));
  return j * g.nx + i;
}
