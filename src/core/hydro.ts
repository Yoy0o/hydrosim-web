/**
 * DEM hydrological conditioning.
 *
 * Priority-Flood depression filling (Barnes, Lehman & Mulla 2014) seeded from the domain boundary,
 * with an optional maximum fill depth: spurious pits/dams of coarse DEMs (bridges, vegetation in narrow
 * valleys) are removed while deep real depressions are only partly filled.
 */

class MinHeap {
  private z: Float64Array;
  private id: Int32Array;
  size = 0;
  constructor(capacity: number) {
    this.z = new Float64Array(capacity);
    this.id = new Int32Array(capacity);
  }
  push(z: number, id: number): void {
    if (this.size === this.z.length) {
      const nz = new Float64Array(this.size * 2);
      nz.set(this.z);
      const ni = new Int32Array(this.size * 2);
      ni.set(this.id);
      this.z = nz;
      this.id = ni;
    }
    let k = this.size++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (this.z[p] <= z) break;
      this.z[k] = this.z[p];
      this.id[k] = this.id[p];
      k = p;
    }
    this.z[k] = z;
    this.id[k] = id;
  }
  /** Pops the minimum; returns its id (its z is available in `lastZ`). */
  lastZ = 0;
  pop(): number {
    const topId = this.id[0];
    this.lastZ = this.z[0];
    const n = --this.size;
    const z = this.z[n];
    const id = this.id[n];
    let k = 0;
    for (;;) {
      let c = 2 * k + 1;
      if (c >= n) break;
      if (c + 1 < n && this.z[c + 1] < this.z[c]) c++;
      if (this.z[c] >= z) break;
      this.z[k] = this.z[c];
      this.id[k] = this.id[c];
      k = c;
    }
    this.z[k] = z;
    this.id[k] = id;
    return topId;
  }
}

export interface FillResult {
  z: Float32Array;
  filledCells: number;
  maxFill: number;
  volume: number;
}

/**
 * Fill depressions draining to the domain boundary.
 * @param maxDepth cap on how much any cell may be raised (m); Infinity = complete filling
 * @param eps small gradient imposed across filled flats (m per cell)
 * @param outlets domain edges through which water can leave (seeds of the flood); all edges if none given
 */
export function fillDepressions(
  z0: ArrayLike<number>,
  nx: number,
  ny: number,
  cellArea: number,
  maxDepth = Infinity,
  eps = 1e-4,
  outlets: { west: boolean; east: boolean; south: boolean; north: boolean } = { west: true, east: true, south: true, north: true },
): FillResult {
  if (!outlets.west && !outlets.east && !outlets.south && !outlets.north) outlets = { west: true, east: true, south: true, north: true };
  const n = nx * ny;
  const filled = new Float64Array(n);
  for (let k = 0; k < n; k++) filled[k] = z0[k];
  const closed = new Uint8Array(n);
  const heap = new MinHeap(Math.max(16, 2 * (nx + ny)));
  for (let i = 0; i < nx; i++) {
    for (const j of [...(outlets.south ? [0] : []), ...(outlets.north ? [ny - 1] : [])]) {
      const k = j * nx + i;
      if (!closed[k]) {
        closed[k] = 1;
        heap.push(filled[k], k);
      }
    }
  }
  for (let j = 0; j < ny; j++) {
    for (const i of [...(outlets.west ? [0] : []), ...(outlets.east ? [nx - 1] : [])]) {
      const k = j * nx + i;
      if (!closed[k]) {
        closed[k] = 1;
        heap.push(filled[k], k);
      }
    }
  }
  while (heap.size > 0) {
    const c = heap.pop();
    const zc = filled[c];
    const ci = c % nx;
    const cj = (c - ci) / nx;
    for (let dj = -1; dj <= 1; dj++) {
      const j = cj + dj;
      if (j < 0 || j >= ny) continue;
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const i = ci + di;
        if (i < 0 || i >= nx) continue;
        const k = j * nx + i;
        if (closed[k]) continue;
        closed[k] = 1;
        if (filled[k] <= zc) filled[k] = zc + eps;
        heap.push(filled[k], k);
      }
    }
  }
  const out = new Float32Array(n);
  let cells = 0;
  let maxFill = 0;
  let vol = 0;
  for (let k = 0; k < n; k++) {
    const d = Math.min(filled[k] - z0[k], maxDepth);
    const v = d > 1e-3 ? z0[k] + d : z0[k];
    out[k] = v;
    if (d > 1e-3) {
      cells++;
      vol += d * cellArea;
      if (d > maxFill) maxFill = d;
    }
  }
  return { z: out, filledCells: cells, maxFill, volume: vol };
}
