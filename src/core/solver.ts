/**
 * 2D shallow water equations solver (finite volume, Godunov type) on a uniform Cartesian grid.
 *
 *  - HLL approximate Riemann solver (Toro wave speeds incl. dry-bed speeds), upwinded tangential momentum
 *  - Hydrostatic reconstruction of Chen & Noelle (2017) with sub-cell bed source term:
 *      well-balanced (lake at rest), positivity preserving, accurate for thin layers on steep slopes
 *  - Optional 2nd order: MUSCL (minmod) reconstruction of (eta, h, u, v) + Heun (SSP-RK2)
 *  - Fully implicit Manning friction (solved exactly for the momentum magnitude)
 *  - Boundary conditions via two layers of ghost cells: wall / open / water level series / tide
 *  - Mass sources: point inflows, rainfall, constant infiltration
 *  - Mass balance audit and result envelopes (max depth, max speed, max hazard, arrival time)
 *
 * Pure TypeScript, no DOM dependencies: used by the Web Worker and by the unit tests.
 */
import { integrateSeries, sampleSeries, type TimeSeries } from './timeseries';

export type Side = 'west' | 'east' | 'south' | 'north';
export const SIDES: Side[] = ['west', 'east', 'south', 'north'];

export type BoundarySpec =
  | { type: 'wall' }
  | { type: 'open' }
  | { type: 'level'; series: TimeSeries }
  | { type: 'tide'; mean: number; amplitude: number; period: number; phase: number };

export interface SourceSpec {
  /** Position in local metres (origin = south-west corner of the domain). */
  x: number;
  y: number;
  /** Radius (m) of the area the inflow is distributed over (at least one cell). */
  radius: number;
  /** Discharge hydrograph Q(t) in m^3/s. */
  series: TimeSeries;
}

export interface RainSpec {
  enabled: boolean;
  /** Rain intensity series in mm/h. */
  series: TimeSeries;
  /** If true, intensity is held constant between points (e.g. hourly data). */
  stepwise: boolean;
  /** Constant infiltration capacity in mm/h. */
  infiltration: number;
}

export interface SolverParams {
  gravity: number;
  cfl: number;
  order: 1 | 2;
  /** Depth below which a cell is considered dry (m). */
  hDry: number;
  /** Maximum time step (s). */
  maxDt: number;
  /** Global Manning coefficient (s/m^(1/3)). */
  manning: number;
  boundaries: Record<Side, BoundarySpec>;
  sources: SourceSpec[];
  rainfall: RainSpec | null;
  /** Safety cap on velocity magnitude (m/s), 0 = disabled. */
  velocityCap: number;
  /** Depth threshold (m) for flood arrival time / wet-area statistics. */
  arrivalDepth: number;
}

export interface GridSpec {
  nx: number;
  ny: number;
  dx: number;
  dy: number;
}

export function defaultSolverParams(): SolverParams {
  return {
    gravity: 9.81,
    cfl: 0.5,
    order: 1,
    hDry: 1e-6,
    maxDt: 10,
    manning: 0.03,
    boundaries: { west: { type: 'wall' }, east: { type: 'wall' }, south: { type: 'wall' }, north: { type: 'wall' } },
    sources: [],
    rainfall: null,
    velocityCap: 25,
    arrivalDepth: 0.05,
  };
}

export function boundaryLevel(spec: BoundarySpec, t: number): number {
  if (spec.type === 'level') return sampleSeries(spec.series, t);
  if (spec.type === 'tide') return spec.mean + spec.amplitude * Math.sin((2 * Math.PI * t) / spec.period + (spec.phase * Math.PI) / 180);
  return NaN;
}

/**
 * Interface fluxes for one sweep direction (hot loop, Riemann solver inlined to avoid boxed calls).
 * nRows x nCols interfaces; interface k has left cell p = start + r*NX + c and right cell q = p + qOff.
 * un/ut are the normal/tangential velocity arrays. With slope arrays (MUSCL), states are reconstructed.
 * Returns the maximum |wave speed|.
 */
function fluxSweep(
  g: number, nRows: number, nCols: number, NX: number, start: number, qOff: number,
  h: Float64Array, z: Float64Array, un: Float64Array, ut: Float64Array,
  sW: Float64Array | null, sH: Float64Array | null, sN: Float64Array | null, sT: Float64Array | null,
  F0: Float64Array, F1: Float64Array, F2: Float64Array, HL: Float64Array, HR: Float64Array, ZS: Float64Array,
): number {
  let amax = 0;
  const second = sW !== null && sH !== null && sN !== null && sT !== null;
  const hg = 0.5 * g;
  let k = 0;
  for (let r = 0; r < nRows; r++) {
    let p = start + r * NX;
    for (let c = 0; c < nCols; c++, p++, k++) {
      const q = p + qOff;
      let hL: number;
      let zL: number;
      let unL: number;
      let utL: number;
      let hR: number;
      let zR: number;
      let unR: number;
      let utR: number;
      if (second) {
        hL = h[p] + sH![p];
        zL = h[p] + z[p] + sW![p] - hL;
        unL = un[p] + sN![p];
        utL = ut[p] + sT![p];
        hR = h[q] - sH![q];
        zR = h[q] + z[q] - sW![q] - hR;
        unR = un[q] - sN![q];
        utR = ut[q] - sT![q];
      } else {
        hL = h[p];
        zL = z[p];
        unL = un[p];
        utL = ut[p];
        hR = h[q];
        zR = z[q];
        unR = un[q];
        utR = ut[q];
      }
      // Chen–Noelle hydrostatic reconstruction
      const wL = hL + zL;
      const wR = hR + zR;
      let zs = zL > zR ? zL : zR;
      const wmin = wL < wR ? wL : wR;
      if (zs > wmin) zs = wmin;
      let hl = wL - zs;
      if (hl > hL) hl = hL;
      if (hl < 0) hl = 0;
      let hr = wR - zs;
      if (hr > hR) hr = hR;
      if (hr < 0) hr = 0;
      HL[k] = hl;
      HR[k] = hr;
      ZS[k] = zs;
      if (hl <= 0 && hr <= 0) {
        F0[k] = 0;
        F1[k] = 0;
        F2[k] = 0;
        continue;
      }
      // HLL with Toro's wave speed estimates (dry-bed speeds when one side is dry)
      const cL = Math.sqrt(g * hl);
      const cR = Math.sqrt(g * hr);
      let sL: number;
      let sR: number;
      if (hl <= 0) {
        sL = unR - 2 * cR;
        sR = unR + cR;
      } else if (hr <= 0) {
        sL = unL - cL;
        sR = unL + 2 * cL;
      } else {
        const us = 0.5 * (unL + unR) + cL - cR;
        const cs = 0.5 * (cL + cR) + 0.25 * (unL - unR);
        sL = unL - cL;
        const a = us - cs;
        if (a < sL) sL = a;
        sR = unR + cR;
        const b = us + cs;
        if (b > sR) sR = b;
      }
      const qL = hl * unL;
      const qR = hr * unR;
      let f0: number;
      let f1: number;
      if (sL >= 0) {
        f0 = qL;
        f1 = qL * unL + hg * hl * hl;
      } else if (sR <= 0) {
        f0 = qR;
        f1 = qR * unR + hg * hr * hr;
      } else {
        const inv = 1 / (sR - sL);
        const ss = sL * sR;
        f0 = (sR * qL - sL * qR + ss * (hr - hl)) * inv;
        f1 = (sR * (qL * unL + hg * hl * hl) - sL * (qR * unR + hg * hr * hr) + ss * (qR - qL)) * inv;
      }
      F0[k] = f0;
      F1[k] = f1;
      F2[k] = f0 >= 0 ? f0 * utL : f0 * utR;
      const sm = -sL > sR ? -sL : sR;
      if (sm > amax) amax = sm;
    }
  }
  return amax;
}

function minmodHalf(a: number, b: number): number {
  if (a > 0 && b > 0) return 0.5 * (a < b ? a : b);
  if (a < 0 && b < 0) return 0.5 * (a > b ? a : b);
  return 0;
}

const BC_WALL = 0;
const BC_OPEN = 1;
const BC_LEVEL = 2;

function bcCode(spec: BoundarySpec): number {
  if (spec.type === 'wall') return BC_WALL;
  if (spec.type === 'open') return BC_OPEN;
  return BC_LEVEL;
}

interface SourceCells {
  cells: Int32Array;
  area: number;
  series: TimeSeries;
}

export interface MassBalance {
  volume: number;
  volume0: number;
  rain: number;
  inflow: number;
  infiltration: number;
  boundaryIn: number;
  boundaryOut: number;
  clipped: number;
  /** volume - (volume0 + inputs - outputs), m^3 (includes negative-depth clipping effects). */
  error: number;
}

export class SWESolver {
  readonly nx: number;
  readonly ny: number;
  readonly dx: number;
  readonly dy: number;
  /** Padded dimensions (2 ghost layers on each side). */
  readonly NX: number;
  readonly NY: number;

  readonly z: Float64Array;
  readonly h: Float64Array;
  readonly hu: Float64Array;
  readonly hv: Float64Array;
  private readonly u: Float64Array;
  private readonly v: Float64Array;
  private readonly h0: Float64Array;
  private readonly hu0: Float64Array;
  private readonly hv0: Float64Array;
  private sxW: Float64Array | null = null;
  private sxH: Float64Array | null = null;
  private sxU: Float64Array | null = null;
  private sxV: Float64Array | null = null;
  private syW: Float64Array | null = null;
  private syH: Float64Array | null = null;
  private syU: Float64Array | null = null;
  private syV: Float64Array | null = null;

  private readonly fx0: Float64Array;
  private readonly fx1: Float64Array;
  private readonly fx2: Float64Array;
  private readonly hxl: Float64Array;
  private readonly hxr: Float64Array;
  private readonly zx: Float64Array;
  private readonly fy0: Float64Array;
  private readonly fy1: Float64Array;
  private readonly fy2: Float64Array;
  private readonly hyl: Float64Array;
  private readonly hyr: Float64Array;
  private readonly zy: Float64Array;

  params: SolverParams;
  t = 0;
  stepCount = 0;
  lastDt = 0;
  private ax = 0;
  private ay = 0;

  // Mass balance accumulators (m^3)
  volume0 = 0;
  volume = 0;
  rainVol = 0;
  inflowVol = 0;
  infilVol = 0;
  bndIn = 0;
  bndOut = 0;
  clipVol = 0;

  // Per-step statistics
  wetCells = 0;
  curMaxH = 0;
  curMaxV = 0;

  // Envelopes (interior cells, row-major j*nx+i, j=0 is the south row)
  readonly maxH: Float32Array;
  readonly maxV: Float32Array;
  readonly maxHaz: Float32Array;
  readonly arrival: Float32Array;

  private srcCells: SourceCells[] = [];
  private extraSources: SourceCells[] = [];

  constructor(grid: GridSpec, bed: ArrayLike<number>, params: SolverParams) {
    const { nx, ny, dx, dy } = grid;
    if (nx < 2 || ny < 1) throw new Error('grid too small');
    if (bed.length !== nx * ny) throw new Error(`bed length ${bed.length} != nx*ny ${nx * ny}`);
    this.nx = nx;
    this.ny = ny;
    this.dx = dx;
    this.dy = dy;
    this.NX = nx + 4;
    this.NY = ny + 4;
    const N = this.NX * this.NY;
    this.z = new Float64Array(N);
    this.h = new Float64Array(N);
    this.hu = new Float64Array(N);
    this.hv = new Float64Array(N);
    this.u = new Float64Array(N);
    this.v = new Float64Array(N);
    this.h0 = new Float64Array(N);
    this.hu0 = new Float64Array(N);
    this.hv0 = new Float64Array(N);
    const nX = (nx + 1) * ny;
    const nY = nx * (ny + 1);
    this.fx0 = new Float64Array(nX);
    this.fx1 = new Float64Array(nX);
    this.fx2 = new Float64Array(nX);
    this.hxl = new Float64Array(nX);
    this.hxr = new Float64Array(nX);
    this.zx = new Float64Array(nX);
    this.fy0 = new Float64Array(nY);
    this.fy1 = new Float64Array(nY);
    this.fy2 = new Float64Array(nY);
    this.hyl = new Float64Array(nY);
    this.hyr = new Float64Array(nY);
    this.zy = new Float64Array(nY);
    this.maxH = new Float32Array(nx * ny);
    this.maxV = new Float32Array(nx * ny);
    this.maxHaz = new Float32Array(nx * ny);
    this.arrival = new Float32Array(nx * ny).fill(-1);
    this.params = params;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) this.z[this.idx(i, j)] = bed[j * nx + i];
    }
    this.fillBedGhosts();
    this.buildSources();
    if (params.order === 2) this.ensureSlopeArrays();
  }

  /** Padded index of interior cell (i, j). */
  idx(i: number, j: number): number {
    return (j + 2) * this.NX + (i + 2);
  }

  get cellArea(): number {
    return this.dx * this.dy;
  }

  /** Set the initial state (interior arrays of length nx*ny) and reset clocks/accumulators. */
  setState(h: ArrayLike<number>, hu?: ArrayLike<number> | null, hv?: ArrayLike<number> | null): void {
    const { nx, ny } = this;
    this.h.fill(0);
    this.hu.fill(0);
    this.hv.fill(0);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        const p = this.idx(i, j);
        const hh = Math.max(0, h[c]);
        this.h[p] = hh;
        if (hh > this.params.hDry) {
          this.hu[p] = hu ? hu[c] : 0;
          this.hv[p] = hv ? hv[c] : 0;
        }
      }
    }
    this.t = 0;
    this.stepCount = 0;
    this.lastDt = 0;
    this.rainVol = 0;
    this.inflowVol = 0;
    this.infilVol = 0;
    this.bndIn = 0;
    this.bndOut = 0;
    this.clipVol = 0;
    this.maxH.fill(0);
    this.maxV.fill(0);
    this.maxHaz.fill(0);
    this.arrival.fill(-1);
    this.computeStats();
    this.volume0 = this.volume;
    // Initialise envelopes with the initial state
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        const hh = this.h[this.idx(i, j)];
        this.maxH[c] = hh;
        if (hh >= this.params.arrivalDepth) this.arrival[c] = 0;
      }
    }
  }

  /** Update parameters (hot). Rebuilds source cell lists and bed ghosts when needed. */
  setParams(p: Partial<SolverParams>): void {
    this.params = { ...this.params, ...p };
    if (p.boundaries) this.fillBedGhosts();
    if (p.sources) this.buildSources();
    if (this.params.order === 2) this.ensureSlopeArrays();
  }

  /** Extra transient point sources (e.g. interactive "pour water" tool). */
  setExtraSources(sources: SourceSpec[]): void {
    this.extraSources = sources.map((s) => this.sourceCells(s));
  }

  private ensureSlopeArrays(): void {
    if (this.sxW) return;
    const N = this.NX * this.NY;
    this.sxW = new Float64Array(N);
    this.sxH = new Float64Array(N);
    this.sxU = new Float64Array(N);
    this.sxV = new Float64Array(N);
    this.syW = new Float64Array(N);
    this.syH = new Float64Array(N);
    this.syU = new Float64Array(N);
    this.syV = new Float64Array(N);
  }

  private sourceCells(s: SourceSpec): SourceCells {
    const { nx, ny, dx, dy } = this;
    const list: number[] = [];
    const r = Math.max(s.radius, 0);
    const i0 = Math.max(0, Math.floor((s.x - r) / dx));
    const i1 = Math.min(nx - 1, Math.floor((s.x + r) / dx));
    const j0 = Math.max(0, Math.floor((s.y - r) / dy));
    const j1 = Math.min(ny - 1, Math.floor((s.y + r) / dy));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cx = (i + 0.5) * dx - s.x;
        const cy = (j + 0.5) * dy - s.y;
        if (cx * cx + cy * cy <= r * r) list.push(this.idx(i, j));
      }
    }
    if (list.length === 0) {
      const i = Math.min(nx - 1, Math.max(0, Math.floor(s.x / dx)));
      const j = Math.min(ny - 1, Math.max(0, Math.floor(s.y / dy)));
      list.push(this.idx(i, j));
    }
    return { cells: Int32Array.from(list), area: list.length * dx * dy, series: s.series };
  }

  private buildSources(): void {
    this.srcCells = this.params.sources.map((s) => this.sourceCells(s));
  }

  /**
   * Bed elevation in ghost cells: walls are mirrored; open (zero-gradient) and level boundaries copy the
   * boundary cell (flat continuation keeps a lake at rest balanced at the boundary).
   */
  private fillBedGhosts(): void {
    const { nx, ny, NX, z } = this;
    const B = this.params.boundaries;
    const fill = (type: BoundarySpec['type'], p0: number, p1: number, g1: number, g2: number, n: number): void => {
      if (type === 'wall') {
        z[g1] = z[p0];
        z[g2] = n > 1 ? z[p1] : z[p0];
      } else {
        z[g1] = z[p0];
        z[g2] = z[p0];
      }
    };
    for (let j = 0; j < ny; j++) {
      const p0 = this.idx(0, j);
      fill(B.west.type, p0, p0 + 1, p0 - 1, p0 - 2, nx);
      const pe = this.idx(nx - 1, j);
      fill(B.east.type, pe, pe - 1, pe + 1, pe + 2, nx);
    }
    for (let i = -2; i < nx + 2; i++) {
      const ps = this.idx(i, 0);
      fill(B.south.type, ps, ps + NX, ps - NX, ps - 2 * NX, ny);
      const pn = this.idx(i, ny - 1);
      fill(B.north.type, pn, pn - NX, pn + NX, pn + 2 * NX, ny);
    }
  }

  /** Fill ghost cell states for time t. */
  private applyBoundaries(t: number): void {
    const { nx, ny, NX } = this;
    const B = this.params.boundaries;
    const cw = bcCode(B.west);
    const ce = bcCode(B.east);
    const cs = bcCode(B.south);
    const cn = bcCode(B.north);
    const lw = boundaryLevel(B.west, t);
    const le = boundaryLevel(B.east, t);
    const ls = boundaryLevel(B.south, t);
    const ln = boundaryLevel(B.north, t);
    for (let j = 0; j < ny; j++) {
      const p0 = this.idx(0, j);
      this.ghost(cw, lw, p0, p0 + 1, p0 - 1, p0 - 2, 0, -1);
      const pe = this.idx(nx - 1, j);
      this.ghost(ce, le, pe, pe - 1, pe + 1, pe + 2, 0, 1);
    }
    for (let i = 0; i < nx; i++) {
      const ps = this.idx(i, 0);
      this.ghost(cs, ls, ps, ps + NX, ps - NX, ps - 2 * NX, 1, -1);
      const pn = this.idx(i, ny - 1);
      this.ghost(cn, ln, pn, ny > 1 ? pn - NX : pn, pn + NX, pn + 2 * NX, 1, 1);
    }
  }

  /**
   * p0/p1: first/second interior cell from the boundary; g1/g2: first/second ghost cell.
   * axis 0: normal is x (hu), axis 1: normal is y (hv); sgn: +1 if the outward normal points to +axis.
   */
  private ghost(code: number, level: number, p0: number, p1: number, g1: number, g2: number, axis: number, sgn: number): void {
    const h = this.h;
    const hu = this.hu;
    const hv = this.hv;
    // free outflow: zero-gradient while the boundary cell flows outwards, reflective otherwise
    // (a transmissive ghost would otherwise feed water into the domain wherever the flow points inwards)
    if (code === BC_OPEN && sgn * (axis === 0 ? hu[p0] : hv[p0]) < 0) code = BC_WALL;
    if (code === BC_WALL) {
      h[g1] = h[p0];
      h[g2] = h[p1];
      if (axis === 0) {
        hu[g1] = -hu[p0];
        hu[g2] = -hu[p1];
        hv[g1] = hv[p0];
        hv[g2] = hv[p1];
      } else {
        hv[g1] = -hv[p0];
        hv[g2] = -hv[p1];
        hu[g1] = hu[p0];
        hu[g2] = hu[p1];
      }
      return;
    }
    if (code === BC_OPEN) {
      h[g1] = h[g2] = h[p0];
      hu[g1] = hu[g2] = hu[p0];
      hv[g1] = hv[g2] = hv[p0];
      return;
    }
    // Water level boundary: imposed depth in the ghost (far-field reservoir), velocity extrapolated
    // from the interior when it is wet (zero-gradient), at rest otherwise.
    const zb = this.z[g1];
    let hb = level - zb;
    if (!(hb > 0)) hb = 0;
    const hi = h[p0];
    if (hb <= this.params.hDry) {
      h[g1] = h[g2] = 0;
      hu[g1] = hu[g2] = 0;
      hv[g1] = hv[g2] = 0;
      return;
    }
    h[g1] = h[g2] = hb;
    if (hi > this.params.hDry) {
      const r = hb / hi;
      hu[g1] = hu[g2] = hu[p0] * r;
      hv[g1] = hv[g2] = hv[p0] * r;
    } else {
      hu[g1] = hu[g2] = 0;
      hv[g1] = hv[g2] = 0;
    }
  }

  private computeVelocities(): void {
    const h = this.h;
    const hu = this.hu;
    const hv = this.hv;
    const u = this.u;
    const v = this.v;
    const hd = this.params.hDry;
    for (let p = 0, n = h.length; p < n; p++) {
      const hh = h[p];
      if (hh > hd) {
        const r = 1 / hh;
        u[p] = hu[p] * r;
        v[p] = hv[p] * r;
      } else {
        u[p] = 0;
        v[p] = 0;
      }
    }
  }

  /** Limited half-slopes for MUSCL reconstruction. Dry cells or cells next to dry cells get zero slope. */
  private computeSlopes(): void {
    const { nx, ny, NX } = this;
    const h = this.h;
    const z = this.z;
    const u = this.u;
    const v = this.v;
    const hd = this.params.hDry;
    const sxW = this.sxW!;
    const sxH = this.sxH!;
    const sxU = this.sxU!;
    const sxV = this.sxV!;
    const syW = this.syW!;
    const syH = this.syH!;
    const syU = this.syU!;
    const syV = this.syV!;
    for (let j = 0; j < ny; j++) {
      let p = (j + 2) * NX + 1;
      for (let i = -1; i <= nx; i++, p++) {
        const hm = h[p - 1];
        const hc = h[p];
        const hp = h[p + 1];
        if (hc <= hd || hm <= hd || hp <= hd) {
          sxW[p] = 0;
          sxH[p] = 0;
          sxU[p] = 0;
          sxV[p] = 0;
          continue;
        }
        sxH[p] = minmodHalf(hc - hm, hp - hc);
        sxW[p] = minmodHalf(hc + z[p] - hm - z[p - 1], hp + z[p + 1] - hc - z[p]);
        sxU[p] = minmodHalf(u[p] - u[p - 1], u[p + 1] - u[p]);
        sxV[p] = minmodHalf(v[p] - v[p - 1], v[p + 1] - v[p]);
      }
    }
    for (let j = -1; j <= ny; j++) {
      let p = (j + 2) * NX + 2;
      for (let i = 0; i < nx; i++, p++) {
        const hm = h[p - NX];
        const hc = h[p];
        const hp = h[p + NX];
        if (hc <= hd || hm <= hd || hp <= hd) {
          syW[p] = 0;
          syH[p] = 0;
          syU[p] = 0;
          syV[p] = 0;
          continue;
        }
        syH[p] = minmodHalf(hc - hm, hp - hc);
        syW[p] = minmodHalf(hc + z[p] - hm - z[p - NX], hp + z[p + NX] - hc - z[p]);
        syU[p] = minmodHalf(u[p] - u[p - NX], u[p + NX] - u[p]);
        syV[p] = minmodHalf(v[p] - v[p - NX], v[p + NX] - v[p]);
      }
    }
  }

  private computeFluxes(second: boolean): void {
    const { nx, ny, NX } = this;
    const g = this.params.gravity;
    // x-interfaces: ny rows of (nx+1) interfaces, left cell (i-1, j) starts at padded (j+2)*NX + 1
    this.ax = fluxSweep(
      g, ny, nx + 1, NX, 2 * NX + 1, 1,
      this.h, this.z, this.u, this.v,
      second ? this.sxW : null, second ? this.sxH : null, second ? this.sxU : null, second ? this.sxV : null,
      this.fx0, this.fx1, this.fx2, this.hxl, this.hxr, this.zx,
    );
    // y-interfaces: (ny+1) rows of nx interfaces, lower cell (i, j-1) starts at padded (j+1)*NX + 2
    this.ay = fluxSweep(
      g, ny + 1, nx, NX, NX + 2, NX,
      this.h, this.z, this.v, this.u,
      second ? this.syW : null, second ? this.syH : null, second ? this.syV : null, second ? this.syU : null,
      this.fy0, this.fy1, this.fy2, this.hyl, this.hyr, this.zy,
    );
  }

  /** Accumulate mass exchanged through the domain boundary over dt (uses current interface fluxes). */
  private accumulateBoundaryFlux(dt: number): void {
    const { nx, ny, dx, dy } = this;
    const fx0 = this.fx0;
    const fy0 = this.fy0;
    let fin = 0;
    let fout = 0;
    for (let j = 0; j < ny; j++) {
      const fw = fx0[j * (nx + 1)] * dy;
      if (fw > 0) fin += fw;
      else fout -= fw;
      const fe = fx0[j * (nx + 1) + nx] * dy;
      if (fe > 0) fout += fe;
      else fin -= fe;
    }
    const kn = ny * nx;
    for (let i = 0; i < nx; i++) {
      const fs = fy0[i] * dx;
      if (fs > 0) fin += fs;
      else fout -= fs;
      const fn = fy0[kn + i] * dx;
      if (fn > 0) fout += fn;
      else fin -= fn;
    }
    this.bndIn += fin * dt;
    this.bndOut += fout * dt;
  }

  /**
   * Conservative update. stage 0/1: U <- U + dt L(U); stage 2: U <- (U0 + U + dt L(U)) / 2.
   */
  private updateCells(dt: number, stage: number): void {
    const { nx, ny, NX } = this;
    const g = this.params.gravity;
    const rdx = 1 / this.dx;
    const rdy = 1 / this.dy;
    const h = this.h;
    const hu = this.hu;
    const hv = this.hv;
    const h0 = this.h0;
    const hu0 = this.hu0;
    const hv0 = this.hv0;
    const fx0 = this.fx0;
    const fx1 = this.fx1;
    const fx2 = this.fx2;
    const hxl = this.hxl;
    const hxr = this.hxr;
    const zx = this.zx;
    const fy0 = this.fy0;
    const fy1 = this.fy1;
    const fy2 = this.fy2;
    const hyl = this.hyl;
    const hyr = this.hyr;
    const zy = this.zy;
    const hg = 0.5 * g;
    let clip = 0;
    for (let j = 0; j < ny; j++) {
      let p = (j + 2) * NX + 2;
      let kx = j * (nx + 1);
      let ky = j * nx;
      for (let i = 0; i < nx; i++, p++, kx++, ky++) {
        const kxr = kx + 1;
        const kyt = ky + nx;
        const dh = -(fx0[kxr] - fx0[kx]) * rdx - (fy0[kyt] - fy0[ky]) * rdy;
        const sbx = -hg * (hxl[kxr] + hxr[kx]) * (zx[kxr] - zx[kx]) * rdx;
        const sby = -hg * (hyl[kyt] + hyr[ky]) * (zy[kyt] - zy[ky]) * rdy;
        const dqx = -(fx1[kxr] - fx1[kx]) * rdx - (fy2[kyt] - fy2[ky]) * rdy + sbx;
        const dqy = -(fx2[kxr] - fx2[kx]) * rdx - (fy1[kyt] - fy1[ky]) * rdy + sby;
        let hn: number;
        let qx: number;
        let qy: number;
        if (stage === 2) {
          hn = 0.5 * (h0[p] + h[p] + dt * dh);
          qx = 0.5 * (hu0[p] + hu[p] + dt * dqx);
          qy = 0.5 * (hv0[p] + hv[p] + dt * dqy);
        } else {
          hn = h[p] + dt * dh;
          qx = hu[p] + dt * dqx;
          qy = hv[p] + dt * dqy;
        }
        if (hn < 0) {
          clip -= hn;
          hn = 0;
          qx = 0;
          qy = 0;
        }
        h[p] = hn;
        hu[p] = qx;
        hv[p] = qy;
      }
    }
    this.clipVol += clip * this.dx * this.dy;
  }

  /** Mass sources, implicit friction, cleanup, statistics and envelopes. */
  private postStep(dt: number): void {
    const { nx, ny, NX, dx, dy } = this;
    const P = this.params;
    const h = this.h;
    const hu = this.hu;
    const hv = this.hv;
    const t0 = this.t;
    const t1 = this.t + dt;
    const area = dx * dy;
    // Point sources: exact volume of the (piecewise linear) hydrograph over [t, t+dt]
    const applySources = (list: SourceCells[]): void => {
      for (const s of list) {
        const vol = integrateSeries(s.series, t0, t1);
        if (vol === 0) continue;
        const dh = vol / s.area;
        if (dh > 0) {
          for (let k = 0; k < s.cells.length; k++) h[s.cells[k]] += dh;
          this.inflowVol += vol;
        } else {
          let removed = 0;
          for (let k = 0; k < s.cells.length; k++) {
            const p = s.cells[k];
            const take = Math.min(h[p], -dh);
            if (take > 0) {
              const r = (h[p] - take) / h[p];
              hu[p] *= r;
              hv[p] *= r;
              h[p] -= take;
              removed += take;
            }
          }
          this.inflowVol -= removed * area;
        }
      }
    };
    applySources(this.srcCells);
    applySources(this.extraSources);

    // Rainfall / infiltration (mm/h -> m/s)
    let rainDepth = 0;
    let infDepth = 0;
    const rf = P.rainfall;
    if (rf && rf.enabled) {
      rainDepth = Math.max(0, integrateSeries(rf.series, t0, t1, rf.stepwise)) / 3.6e6;
      infDepth = (Math.max(0, rf.infiltration) / 3.6e6) * dt;
    }
    const g = P.gravity;
    const n2g = g * P.manning * P.manning;
    const hd = P.hDry;
    const vcap = P.velocityCap;
    const tNew = t1;
    const arrDepth = P.arrivalDepth;
    const maxH = this.maxH;
    const maxV = this.maxV;
    const maxHaz = this.maxHaz;
    const arrival = this.arrival;
    let vol = 0;
    let wet = 0;
    let mh = 0;
    let mv = 0;
    let infSum = 0;
    for (let j = 0; j < ny; j++) {
      let p = (j + 2) * NX + 2;
      let c = j * nx;
      for (let i = 0; i < nx; i++, p++, c++) {
        let hn = h[p] + rainDepth;
        let qx = hu[p];
        let qy = hv[p];
        if (infDepth > 0 && hn > 0) {
          const loss = hn < infDepth ? hn : infDepth;
          const r = (hn - loss) / hn;
          qx *= r;
          qy *= r;
          hn -= loss;
          infSum += loss;
        }
        if (hn <= hd) {
          qx = 0;
          qy = 0;
          if (hn < 0) {
            this.clipVol -= hn * area;
            hn = 0;
          }
        } else {
          let q = Math.sqrt(qx * qx + qy * qy);
          if (q > 0) {
            if (n2g > 0) {
              const a = (dt * n2g) / (hn * hn * Math.cbrt(hn));
              const qn = (2 * q) / (1 + Math.sqrt(1 + 4 * a * q));
              const r = qn / q;
              qx *= r;
              qy *= r;
              q = qn;
            }
            if (vcap > 0 && q > vcap * hn) {
              const r = (vcap * hn) / q;
              qx *= r;
              qy *= r;
              q = vcap * hn;
            }
          }
          // Statistics and envelopes
          if (hn > mh) mh = hn;
          if (hn > maxH[c]) maxH[c] = hn;
          if (hn >= arrDepth) {
            wet++;
            const spd = q / hn;
            if (spd > mv) mv = spd;
            if (spd > maxV[c]) maxV[c] = spd;
            const haz = hn * (spd + 0.5);
            if (haz > maxHaz[c]) maxHaz[c] = haz;
            if (arrival[c] < 0) arrival[c] = tNew;
          }
        }
        vol += hn;
        h[p] = hn;
        hu[p] = qx;
        hv[p] = qy;
      }
    }
    this.rainVol += rainDepth * nx * ny * area;
    this.infilVol += infSum * area;
    this.volume = vol * area;
    this.wetCells = wet;
    this.curMaxH = mh;
    this.curMaxV = mv;
  }

  /** Recompute volume and simple statistics (no envelopes). */
  computeStats(): void {
    const { nx, ny, NX } = this;
    const h = this.h;
    const hu = this.hu;
    const hv = this.hv;
    let vol = 0;
    let wet = 0;
    let mh = 0;
    let mv = 0;
    const ad = this.params.arrivalDepth;
    for (let j = 0; j < ny; j++) {
      let p = (j + 2) * NX + 2;
      for (let i = 0; i < nx; i++, p++) {
        const hh = h[p];
        vol += hh;
        if (hh > mh) mh = hh;
        if (hh >= ad) {
          wet++;
          const s = Math.sqrt(hu[p] * hu[p] + hv[p] * hv[p]) / hh;
          if (s > mv) mv = s;
        }
      }
    }
    this.volume = vol * this.dx * this.dy;
    this.wetCells = wet;
    this.curMaxH = mh;
    this.curMaxV = mv;
  }

  /** CFL time step estimate from the current state without advancing (cell based). */
  estimateDt(): number {
    const g = this.params.gravity;
    let s = 0;
    const { nx, ny, NX } = this;
    for (let j = 0; j < ny; j++) {
      let p = (j + 2) * NX + 2;
      for (let i = 0; i < nx; i++, p++) {
        const hh = this.h[p];
        if (hh <= this.params.hDry) continue;
        const c = Math.sqrt(g * hh);
        const a = Math.abs(this.hu[p] / hh) + c;
        const b = Math.abs(this.hv[p] / hh) + c;
        const r = Math.max(a / this.dx, b / this.dy);
        if (r > s) s = r;
      }
    }
    return s > 0 ? this.params.cfl / s : this.params.maxDt;
  }

  /**
   * Advance one adaptive time step. `dtLimit` caps the step (e.g. to hit output times exactly).
   * Returns the time step used.
   */
  step(dtLimit = Infinity): number {
    const P = this.params;
    const second = P.order === 2;
    if (second) this.ensureSlopeArrays();
    const t = this.t;
    this.applyBoundaries(t);
    this.computeVelocities();
    if (second) this.computeSlopes();
    this.computeFluxes(second);
    let dt = P.cfl * Math.min(this.ax > 0 ? this.dx / this.ax : Infinity, this.ay > 0 ? this.dy / this.ay : Infinity);
    if (!(dt <= P.maxDt)) dt = P.maxDt;
    if (dt > dtLimit) dt = dtLimit;
    if (!(dt > 0)) dt = Math.max(1e-9, Math.min(P.maxDt, dtLimit));
    if (second) {
      this.h0.set(this.h);
      this.hu0.set(this.hu);
      this.hv0.set(this.hv);
      this.accumulateBoundaryFlux(0.5 * dt);
      this.updateCells(dt, 1);
      this.applyBoundaries(t + dt);
      this.computeVelocities();
      this.computeSlopes();
      this.computeFluxes(true);
      this.accumulateBoundaryFlux(0.5 * dt);
      this.updateCells(dt, 2);
    } else {
      this.accumulateBoundaryFlux(dt);
      this.updateCells(dt, 0);
    }
    this.postStep(dt);
    this.t = t + dt;
    this.stepCount++;
    this.lastDt = dt;
    return dt;
  }

  massBalance(): MassBalance {
    const inputs = this.rainVol + this.inflowVol + this.bndIn;
    const outputs = this.infilVol + this.bndOut;
    return {
      volume: this.volume,
      volume0: this.volume0,
      rain: this.rainVol,
      inflow: this.inflowVol,
      infiltration: this.infilVol,
      boundaryIn: this.bndIn,
      boundaryOut: this.bndOut,
      clipped: this.clipVol,
      error: this.volume - (this.volume0 + inputs - outputs),
    };
  }

  /** Interior depth as a Float32Array (row-major, j=0 south). */
  depthF32(out?: Float32Array): Float32Array {
    const { nx, ny, NX } = this;
    const o = out ?? new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const p0 = (j + 2) * NX + 2;
      const c0 = j * nx;
      for (let i = 0; i < nx; i++) o[c0 + i] = this.h[p0 + i];
    }
    return o;
  }

  /** Interior velocities as Float32Arrays. */
  velocityF32(outU?: Float32Array, outV?: Float32Array): [Float32Array, Float32Array] {
    const { nx, ny, NX } = this;
    const ou = outU ?? new Float32Array(nx * ny);
    const ov = outV ?? new Float32Array(nx * ny);
    const hd = Math.max(this.params.hDry, 1e-5);
    for (let j = 0; j < ny; j++) {
      const p0 = (j + 2) * NX + 2;
      const c0 = j * nx;
      for (let i = 0; i < nx; i++) {
        const p = p0 + i;
        const hh = this.h[p];
        if (hh > hd) {
          ou[c0 + i] = this.hu[p] / hh;
          ov[c0 + i] = this.hv[p] / hh;
        } else {
          ou[c0 + i] = 0;
          ov[c0 + i] = 0;
        }
      }
    }
    return [ou, ov];
  }

  /** Values at an interior cell. */
  cellState(i: number, j: number): { h: number; u: number; v: number; z: number } {
    const p = this.idx(i, j);
    const hh = this.h[p];
    const wet = hh > Math.max(this.params.hDry, 1e-5);
    return { h: hh, u: wet ? this.hu[p] / hh : 0, v: wet ? this.hv[p] / hh : 0, z: this.z[p] };
  }

  /** Add a volume of water (m^3) uniformly over the cells within radius of (x, y). */
  addWater(x: number, y: number, radius: number, volume: number): void {
    const s = this.sourceCells({ x, y, radius, series: [] });
    const dh = volume / s.area;
    for (let k = 0; k < s.cells.length; k++) this.h[s.cells[k]] += dh;
    this.inflowVol += volume;
  }
}
